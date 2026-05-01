import type {
  AppMessage,
  AppState,
  AutomationSettings,
  QueueDraft,
  RuntimeReply,
} from '@/lib/contracts';
import { APP_STATE_STORAGE_KEY } from '@/lib/defaults';

const GROK_COMPOSER_URL = 'https://grok.com/imagine';
const GROK_TAB_PATTERNS = ['https://grok.com/*', 'https://*.grok.com/*'];

export async function getRuntimeState(): Promise<AppState> {
  return sendMessage({ type: 'app/get-state' });
}

export async function enqueueDrafts(drafts: QueueDraft[]): Promise<AppState> {
  return sendMessage({
    type: 'queue/enqueue',
    payload: { drafts },
  });
}

export async function clearQueue(): Promise<AppState> {
  return sendMessage({ type: 'queue/clear' });
}

export async function updateSettings(
  patch: Partial<AutomationSettings>,
): Promise<AppState> {
  return sendMessage({
    type: 'settings/update',
    payload: { patch },
  });
}

export async function clearLogs(): Promise<AppState> {
  return sendMessage({ type: 'logs/clear' });
}

export async function forceStopQueue(): Promise<AppState> {
  return sendMessage({ type: 'queue/force-stop' });
}

export async function startQueue(): Promise<AppState> {
  return sendMessage({ type: 'queue/start' });
}

export async function retryJob(jobId: string): Promise<AppState> {
  return sendMessage({ type: 'job/retry', payload: { jobId } });
}

export async function rerunJob(jobId: string): Promise<AppState> {
  return sendMessage({ type: 'job/rerun', payload: { jobId } });
}

export async function removeQueueJob(jobId: string): Promise<AppState> {
  return sendMessage({ type: 'job/remove', payload: { jobId } });
}

export function subscribeToRuntimeState(
  listener: (state: AppState) => void,
): () => void {
  const handleStorageChange = (
    changes: Record<string, unknown>,
    areaName: string,
  ) => {
    if (areaName !== 'local' || !(APP_STATE_STORAGE_KEY in changes)) {
      return;
    }

    void getRuntimeState()
      .then(listener)
      .catch(() => {
        // Ignore transient restarts while the service worker reloads.
      });
  };

  browser.storage.onChanged.addListener(handleStorageChange);

  return () => {
    browser.storage.onChanged.removeListener(handleStorageChange);
  };
}

export async function openDashboardPage(): Promise<void> {
  await browser.tabs.create({
    url: browser.runtime.getURL('/sidepanel.html'),
  });
}

export async function openGrokComposerPage(): Promise<void> {
  const [activeTab] = await browser.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });

  if (activeTab?.id && isGrokUrl(activeTab.url)) {
    await browser.tabs.update(activeTab.id, {
      active: true,
      url: GROK_COMPOSER_URL,
    });
    return;
  }

  const existingTabs = await browser.tabs.query({ url: GROK_TAB_PATTERNS });
  const targetTab = existingTabs[0];

  if (targetTab?.id) {
    if (typeof targetTab.windowId === 'number') {
      await browser.windows.update(targetTab.windowId, { focused: true });
    }

    await browser.tabs.update(targetTab.id, {
      active: true,
      url: GROK_COMPOSER_URL,
    });
    return;
  }

  await browser.tabs.create({ url: GROK_COMPOSER_URL });
}

function isGrokUrl(url?: string): boolean {
  return /^https:\/\/(?:[^/]+\.)?grok\.com(?:\/|$)/i.test(url ?? '');
}

async function sendMessage(message: AppMessage): Promise<AppState> {
  const response = (await browser.runtime.sendMessage(
    message,
  )) as RuntimeReply | undefined;

  if (!response || typeof response !== 'object' || !('ok' in response)) {
    throw new Error(
      `No runtime response was received for ${message.type}. Reload the extension and check Debug Logs.`,
    );
  }

  if (!response.ok) {
    throw new Error(response.error);
  }

  return response.state;
}