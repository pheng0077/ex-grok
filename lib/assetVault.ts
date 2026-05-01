import type { ImageAttachmentMeta } from '@/lib/contracts';

type FilePermissionState = 'granted' | 'prompt' | 'denied';

export interface ReadableFileHandle {
  kind: 'file';
  name: string;
  getFile: () => Promise<File>;
  queryPermission?: (descriptor?: {
    mode?: 'read' | 'readwrite';
  }) => Promise<FilePermissionState>;
}

export interface AttachmentAssetInput extends ImageAttachmentMeta {
  dataUrl?: string;
  fileBlob?: Blob;
  fileHandle?: ReadableFileHandle;
}

interface StoredAttachmentAsset extends ImageAttachmentMeta {
  assetId: string;
  dataUrl?: string;
  fileBlob?: Blob;
  fileHandle?: ReadableFileHandle;
  createdAt: string;
}

const DATABASE_NAME = 'ex-grok-asset-vault';
const DATABASE_VERSION = 1;
const STORE_NAME = 'attachment-assets';

export async function storeAttachmentPayloads(
  attachments: AttachmentAssetInput[],
): Promise<ImageAttachmentMeta[]> {
  if (!attachments.length) {
    return [];
  }

  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const sanitized: ImageAttachmentMeta[] = [];

    for (const attachment of attachments) {
      if (!attachment.assetId) {
        throw new Error(`Attachment ${attachment.name} is missing an asset id.`);
      }

      const payload = selectPayload(attachment);
      if (!payload) {
        sanitized.push(stripAttachmentPayload(attachment));
        continue;
      }

      store.put({
        assetId: attachment.assetId,
        name: attachment.name,
        size: attachment.size,
        type: attachment.type,
        ...payload,
        createdAt: new Date().toISOString(),
      } satisfies StoredAttachmentAsset);

      sanitized.push(stripAttachmentPayload(attachment));
    }

    await waitForTransaction(transaction);
    return sanitized;
  } finally {
    database.close();
  }
}

export async function hydrateAttachmentPayloads(
  attachments: ImageAttachmentMeta[],
): Promise<ImageAttachmentMeta[]> {
  if (!attachments.length) {
    return [];
  }

  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);

    const hydrated = await Promise.all(
      attachments.map(async (attachment) => {
        if (!attachment.assetId) {
          return attachment;
        }

        const stored = await requestToPromise<StoredAttachmentAsset | undefined>(
          store.get(attachment.assetId),
        );

        if (!stored) {
          return attachment;
        }

        const dataUrl = await resolveStoredAttachmentDataUrl(stored);

        return {
          assetId: stored.assetId,
          name: stored.name,
          size: stored.size,
          type: stored.type,
          dataUrl,
        } satisfies ImageAttachmentMeta;
      }),
    );

    await waitForTransaction(transaction);
    return hydrated;
  } finally {
    database.close();
  }
}

export async function deleteAttachmentPayloads(assetIds: string[]): Promise<void> {
  const uniqueIds = Array.from(new Set(assetIds.filter(Boolean)));
  if (!uniqueIds.length) {
    return;
  }

  const database = await openDatabase();

  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    for (const assetId of uniqueIds) {
      store.delete(assetId);
    }

    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}

export function collectAttachmentAssetIds(
  attachments: ImageAttachmentMeta[],
): string[] {
  return attachments.flatMap((attachment) =>
    attachment.assetId ? [attachment.assetId] : [],
  );
}

function stripAttachmentPayload(
  attachment: AttachmentAssetInput | ImageAttachmentMeta,
): ImageAttachmentMeta {
  return {
    assetId: attachment.assetId,
    name: attachment.name,
    size: attachment.size,
    type: attachment.type,
  };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, {
          keyPath: 'assetId',
        });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      reject(request.error ?? new Error('Failed to open the attachment vault.'));
    };
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    };
    transaction.onabort = () => {
      reject(transaction.error ?? new Error('IndexedDB transaction was aborted.'));
    };
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed.'));
    };
  });
}

function selectPayload(
  attachment: AttachmentAssetInput,
): Pick<StoredAttachmentAsset, 'dataUrl' | 'fileBlob' | 'fileHandle'> | null {
  if (attachment.fileHandle) {
    return {
      fileHandle: attachment.fileHandle,
    };
  }

  if (attachment.fileBlob) {
    return {
      fileBlob: attachment.fileBlob,
    };
  }

  if (attachment.dataUrl) {
    return {
      dataUrl: attachment.dataUrl,
    };
  }

  return null;
}

async function resolveStoredAttachmentDataUrl(
  stored: StoredAttachmentAsset,
): Promise<string> {
  if (stored.dataUrl) {
    return stored.dataUrl;
  }

  if (stored.fileHandle) {
    return fileHandleToDataUrl(stored.fileHandle, stored.name);
  }

  if (stored.fileBlob) {
    return blobToDataUrl(stored.fileBlob);
  }

  throw new Error(
    `Attachment ${stored.name} is missing a readable payload. Reattach it and queue again.`,
  );
}

async function fileHandleToDataUrl(
  fileHandle: ReadableFileHandle,
  fileName: string,
): Promise<string> {
  const permission = await fileHandle.queryPermission?.({ mode: 'read' });

  if (permission && permission !== 'granted') {
    throw new Error(
      `Attachment ${fileName} is no longer readable from disk. Reattach it and queue again.`,
    );
  }

  let file: File;

  try {
    file = await fileHandle.getFile();
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Attachment ${fileName} could not be read from disk: ${error.message}`
        : `Attachment ${fileName} could not be read from disk. Reattach it and queue again.`,
    );
  }

  return blobToDataUrl(file);
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onerror = () => {
        reject(reader.error ?? new Error('Failed to read attachment data.'));
      };

      reader.onload = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result);
          return;
        }

        reject(new Error('Unexpected attachment reader result.'));
      };

      reader.readAsDataURL(blob);
    });
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunks: string[] = [];

  for (let index = 0; index < bytes.length; index += 0x8000) {
    const slice = bytes.subarray(index, index + 0x8000);
    chunks.push(String.fromCharCode(...slice));
  }

  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(chunks.join(''))}`;
}