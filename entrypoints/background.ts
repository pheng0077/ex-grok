import type {
  AutomationExecuteMessage,
  AutomationReply,
  AppMessage,
  AppState,
  QueueDraft,
  QueueJob,
  RuntimeReply,
} from '@/lib/contracts';
import {
  collectAttachmentAssetIds,
  deleteAttachmentPayloads,
  hydrateAttachmentPayloads,
} from '@/lib/assetVault';
import { getAppState, appendLog, setAppState, updateAppState } from '@/lib/state';

const GROK_TAB_PATTERNS = ['https://grok.com/*', 'https://*.grok.com/*'];
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — video files can be large

let queueRunnerPromise: Promise<void> | null = null;
let forceStopRequested = false;
// When true the queue runner will not restart automatically (user pressed Stop All).
// Must be cleared explicitly via queue/start.
let isQueuePaused = false;
let rerunJobId: string | null = null;
let pendingDownload:
  | {
      jobId: string;
      tabId: number;
      createdAt: number;
      downloadId: number | null;
      timer: ReturnType<typeof setTimeout>;
      resolve: () => void;
      reject: (error: Error) => void;
    }
  | null = null;

export default defineBackground(() => {
  void bootstrapBackground();

  // Heartbeat alarm keeps the service worker alive while automation is running.
  // Chrome MV3 SWs sleep after ~30s of inactivity, pausing setTimeout timers.
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== 'ex-grok-keepalive') return;
    if (!isQueuePaused) void ensureQueueRunner();
  });

  // Use the explicit sendResponse + return true pattern.
  // Returning a Promise from onMessage is unreliable in Chrome MV3 service
  // workers — if the worker was sleeping the response channel may close before
  // the Promise resolves.
  browser.runtime.onMessage.addListener(
    (
      message: unknown,
      _sender: unknown,
      sendResponse: (response: RuntimeReply) => void,
    ): true => {
      void handleAppMessage(message as AppMessage).then(sendResponse);
      return true; // keep the message channel open for the async reply
    },
  );

  // When the side-panel port disconnects (panel closed / reloaded) we force-stop
  // and clear the queue so the user always starts fresh from a clean state.
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'sidepanel') return;
    port.onDisconnect.addListener(() => {
      void handlePanelClosed();
    });
  });

  // Override download filename and folder so files land in the configured
  // output folder with the correct "N_slug.ext" naming scheme.
  // onDeterminingFilename is a Chrome-only API not yet typed by WXT; cast accordingly.
  const downloadsApi = browser.downloads as unknown as {
    onDeterminingFilename: {
      addListener: (
        callback: (
          item: { filename: string; id: number; tabId?: number },
          suggest: (suggestion: { filename: string; conflictAction: string }) => void,
        ) => boolean,
      ) => void;
    };
  };
  downloadsApi.onDeterminingFilename.addListener((downloadItem, suggest) => {
    if (!pendingDownload) return false;

    // Only handle downloads originating from the expected tab in the expected window.
    const downloadTabId = Reflect.get(downloadItem, 'tabId') as number | undefined;
    if (typeof downloadTabId === 'number' && downloadTabId !== pendingDownload.tabId) {
      return false;
    }

    if (Date.now() - pendingDownload.createdAt > DOWNLOAD_TIMEOUT_MS) {
      return false;
    }

    // Async: read current active job and rename.
    void getAppState().then((state) => {
      const job = state.queue.find((j) => j.id === pendingDownload?.jobId);
      if (!job) return;
      const filename = buildDownloadFilename(job, downloadItem.filename ?? 'video.mp4');
      suggest({ filename, conflictAction: 'uniquify' });
    });

    return true; // tell Chrome we will call suggest() asynchronously
  });

  browser.downloads.onCreated.addListener((downloadItem) => {
    if (!pendingDownload || pendingDownload.downloadId !== null) {
      return;
    }

    const downloadTabId = Reflect.get(downloadItem, 'tabId');
    if (
      typeof downloadTabId === 'number' &&
      downloadTabId !== pendingDownload.tabId
    ) {
      return;
    }

    if (Date.now() - pendingDownload.createdAt > DOWNLOAD_TIMEOUT_MS) {
      return;
    }

    pendingDownload.downloadId = downloadItem.id;
  });

  browser.downloads.onChanged.addListener((delta) => {
    if (!pendingDownload || pendingDownload.downloadId !== delta.id) {
      return;
    }

    if (delta.error?.current) {
      pendingDownload.reject(
        new Error(`Download failed: ${delta.error.current}`),
      );
      return;
    }

    if (delta.state?.current === 'interrupted') {
      pendingDownload.reject(new Error('Download was interrupted.'));
      return;
    }

    if (delta.state?.current === 'complete') {
      pendingDownload.resolve();
    }
  });
});

async function bootstrapBackground(): Promise<void> {
  // Keep the service worker alive during queue execution so setTimeout-based
  // delays and download waiters don't get paused when the user minimizes Chrome.
  await browser.alarms.create('ex-grok-keepalive', { periodInMinutes: 0.4 });

  let state = await getAppState();
  if (!state.logs.length) {
    state = appendLog(state, 'info', 'Extension scaffold ready.');
  }

  const sidePanelApi = (
    browser as unknown as {
      sidePanel?: {
        setPanelBehavior?: (options: {
          openPanelOnActionClick: boolean;
        }) => Promise<void> | void;
      };
    }
  ).sidePanel;

  if (sidePanelApi?.setPanelBehavior) {
    await sidePanelApi.setPanelBehavior({ openPanelOnActionClick: true });
  }

  await setAppState(
    appendLog(state, 'info', 'Background worker initialized for grok.com.'),
  );

  void ensureQueueRunner();
}

async function handleAppMessage(message: AppMessage): Promise<RuntimeReply> {
  try {
    return await handleMessage(message);
  } catch (error) {
    const state = await getAppState();
    const messageText =
      error instanceof Error
        ? error.message
        : 'Unknown background runtime error.';

    const nextState = await setAppState(
      appendLog(state, 'error', `Runtime message failed: ${messageText}`),
    );

    return fail(nextState, messageText);
  }
}

async function handleMessage(message: AppMessage): Promise<RuntimeReply> {
  switch (message.type) {
    case 'app/get-state':
      return ok(await getAppState());

    case 'queue/enqueue': {
      const nextState = await updateAppState((state) => {
        const jobs = createJobs(message.payload.drafts);
        const queuedState: AppState = {
          ...state,
          queue: [...state.queue, ...jobs],
          runState: jobs.length ? (isQueuePaused ? 'paused' : 'queued') : state.runState,
        };

        return appendLog(
          queuedState,
          'info',
          `Queued ${jobs.length} job${jobs.length === 1 ? '' : 's'} from ${message.payload.drafts.length} prompt group${message.payload.drafts.length === 1 ? '' : 's'}.`,
        );
      });

      return ok(nextState);
    }

    case 'queue/clear': {
      const currentState = await getAppState();
      const assetIds = collectQueueAssetIds(currentState.queue);
      const nextState = await setAppState(
        appendLog(
          {
            ...currentState,
            queue: [],
            activeJobId: null,
            runState: 'idle',
          },
          'info',
          'Queue cleared from the control surface.',
        ),
      );

      await deleteAttachmentPayloads(assetIds);

      return ok(nextState);
    }

    case 'queue/force-stop': {
      forceStopRequested = true;
      isQueuePaused = true;
      if (pendingDownload) {
        const err = new Error('Queue stopped by user.');
        (err as Error & { retryable: boolean }).retryable = false;
        pendingDownload.reject(err);
      }
      // Signal the content script to bail out of in-flight automation.
      void sendAbortToGrokTab();
      const nextState = await updateAppState((state) =>
        appendLog(
          { ...state, runState: 'paused' },
          'warn',
          'Queue paused by user.',
        ),
      );
      return ok(nextState);
    }

    case 'queue/start': {
      isQueuePaused = false;
      const startState = await updateAppState((state) => {
        const hasQueued = state.queue.some((j) => j.status === 'queued');
        return appendLog(
          { ...state, runState: hasQueued ? 'queued' : state.runState },
          'info',
          'Queue started by user.',
        );
      });
      void ensureQueueRunner();
      return ok(startState);
    }

    case 'job/retry': {
      const { jobId } = message.payload;
      const nextState = await updateAppState((state) => {
        const job = state.queue.find((j) => j.id === jobId);
        if (!job) return state;
        return appendLog(
          {
            ...state,
            queue: state.queue.map((j) =>
              j.id === jobId
                ? { ...j, status: 'queued' as const, attemptCount: 0, lastError: undefined, progress: undefined }
                : j,
            ),
            runState: 'queued',
          },
          'info',
          `Retrying prompt ${job.promptIndex + 1}, output ${job.outputIndex}.`,
        );
      });
      if (!isQueuePaused) void ensureQueueRunner();
      return ok(nextState);
    }

    case 'job/rerun': {
      const { jobId } = message.payload;
      rerunJobId = jobId;
      if (pendingDownload && pendingDownload.jobId === jobId) {
        const err = new Error('Re-run requested by user.');
        (err as Error & { retryable: boolean }).retryable = false;
        pendingDownload.reject(err);
      }
      // Signal the content script to bail out of the current in-flight automation.
      void sendAbortToGrokTab();
      const nextState = await updateAppState((state) => {
        const job = state.queue.find((j) => j.id === jobId);
        if (!job) return state;
        return appendLog(
          {
            ...state,
            queue: state.queue.map((j) =>
              j.id === jobId
                ? { ...j, status: 'queued' as const, attemptCount: 0, lastError: undefined, progress: undefined }
                : j,
            ),
            runState: 'queued',
          },
          'info',
          `Re-run queued for prompt ${job.promptIndex + 1}, output ${job.outputIndex}.`,
        );
      });
      if (!isQueuePaused) void ensureQueueRunner();
      return ok(nextState);
    }

    case 'settings/update': {
      const nextState = await updateAppState((state) =>
        appendLog(
          {
            ...state,
            settings: {
              ...state.settings,
              ...message.payload.patch,
            },
          },
          'info',
          'Settings updated.',
        ),
      );

      return ok(nextState);
    }

    case 'logs/clear': {
      const current = await getAppState();
      const cleared = appendLog(
        {
          ...current,
          logs: [],
        },
        'info',
        'Debug logs cleared.',
      );
      const nextState = await setAppState(cleared);
      return ok(nextState);
    }

    case 'job/progress': {
      const { jobId, progress } = message.payload;
      const nextState = await updateAppState((state) => ({
        ...state,
        queue: state.queue.map((job) =>
          job.id === jobId ? { ...job, progress } : job,
        ),
      }));
      return ok(nextState);
    }

    case 'page/update': {
      const nextState = await updateAppState((state) => {
        const nextPage = message.payload.snapshot;
        const pageChanged =
          state.grokPage?.url !== nextPage.url ||
          state.grokPage?.readyForAutomation !== nextPage.readyForAutomation ||
          state.grokPage?.authenticated !== nextPage.authenticated;

        const updated: AppState = {
          ...state,
          grokPage: nextPage,
        };

        if (!pageChanged) {
          return updated;
        }

        return appendLog(
          updated,
          nextPage.readyForAutomation ? 'info' : 'warn',
          nextPage.readyForAutomation
            ? 'Detected a Grok composer page ready for automation.'
            : 'Detected Grok page activity, but the composer is not ready yet.',
        );
      });

      if (nextState.grokPage?.readyForAutomation && !isQueuePaused) {
        void ensureQueueRunner();
      }

      return ok(nextState);
    }

    default:
      return fail(await getAppState(), 'Unknown runtime message.');
  }
}

function createJobs(drafts: QueueDraft[]): QueueJob[] {
  const createdAt = new Date().toISOString();
  const batchId = crypto.randomUUID();

  return drafts.flatMap((draft, promptIndex) => {
    return Array.from({ length: draft.outputsPerPrompt }, (_, outputIndex) => ({
      ...draft,
      id: crypto.randomUUID(),
      batchId,
      promptIndex,
      promptOrder: draft.promptOrder,
      outputIndex: outputIndex + 1,
      createdAt,
      attemptCount: 0,
      status: 'queued' as const,
    }));
  });
}

async function ensureQueueRunner(): Promise<void> {
  if (isQueuePaused) return;
  if (queueRunnerPromise) {
    return queueRunnerPromise;
  }

  queueRunnerPromise = runQueueLoop()
    .catch(async (error) => {
      const state = await getAppState();
      await setAppState(
        appendLog(
          {
            ...state,
            activeJobId: null,
            runState: state.queue.some((job) => job.status === 'queued')
              ? 'queued'
              : 'idle',
          },
          'error',
          error instanceof Error ? error.message : 'Queue runner crashed.',
        ),
      );
    })
    .finally(async () => {
      queueRunnerPromise = null;
      if (isQueuePaused) return;
      const state = await getAppState();
      if (
        state.grokPage?.readyForAutomation &&
        state.queue.some((job) => job.status === 'queued')
      ) {
        void ensureQueueRunner();
      }
    });

  return queueRunnerPromise;
}

async function runQueueLoop(): Promise<void> {
  while (true) {
    const state = await getAppState();
    const nextJob = state.queue.find((job) => job.status === 'queued');

    if (!nextJob) {
      const finalState = state.queue.length > 0 ? 'completed' : 'idle';
      if (finalState === 'completed') {
        isQueuePaused = true;
      }
      if (state.activeJobId !== null || state.runState !== finalState) {
        await setAppState({
          ...state,
          activeJobId: null,
          runState: finalState,
        });
      }
      return;
    }

    if (!state.grokPage?.readyForAutomation) {
      await parkQueue('Open grok.com and wait for the composer before running the queue.');
      return;
    }

    const grokTab = await findGrokTab();
    if (!grokTab?.id) {
      await parkQueue('No active grok.com tab was found.');
      return;
    }

    await updateAppState((current) => markJobRunning(current, nextJob.id));

    try {
      await executeJob(grokTab.id, nextJob, state.settings);
      await updateAppState((current) => markJobDownloaded(current, nextJob.id));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown queue execution error.';

      // Re-run: job was already re-queued by the job/rerun handler; just clear the flag.
      if (rerunJobId === nextJob.id) {
        rerunJobId = null;
        await cleanupCompletedAssetPayloads();
        continue;
      }

      // Force stop: mark failed non-retryable and break out of the loop.
      if (forceStopRequested) {
        forceStopRequested = false;
        await updateAppState((current) =>
          markJobFailure(current, nextJob.id, message, false),
        );
        await cleanupCompletedAssetPayloads();
        return;
      }

      const retryable =
        typeof error === 'object' &&
        error !== null &&
        'retryable' in error &&
        typeof Reflect.get(error, 'retryable') === 'boolean'
          ? Boolean(Reflect.get(error, 'retryable'))
          : true;

      await updateAppState((current) =>
        markJobFailure(current, nextJob.id, message, retryable),
      );
    }

    await cleanupCompletedAssetPayloads();

    // Navigate back to /imagine after each job so the next one starts from a
    // clean page with no leftover prompt text or post-page URL.
    if (grokTab?.id) {
      try {
        const loaded = waitForTabLoaded(grokTab.id, 12000);
        await browser.tabs.update(grokTab.id, { url: 'https://grok.com/imagine' });
        await loaded;
        await delay(1200); // let content script initialize and send page/update
      } catch {
        // Non-fatal — next iteration checks readyForAutomation and parks if needed.
      }
    }

    const nextState = await getAppState();
    if (!nextState.queue.some((job) => job.status === 'queued')) {
      continue;
    }

    await delay(getRandomDelayMs(nextState.settings.delayRange));
  }
}

/**
 * Waits for a tab to finish loading (status === 'complete').
 * Resolves on completion or after timeoutMs, whichever comes first.
 */
function waitForTabLoaded(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      browser.tabs.onUpdated.removeListener(listener);
      resolve();
    };

    const timer = setTimeout(finish, timeoutMs);

    const listener = (
      changedId: number,
      info: { status?: string },
    ) => {
      if (changedId === tabId && info.status === 'complete') {
        clearTimeout(timer);
        finish();
      }
    };

    browser.tabs.onUpdated.addListener(listener);
  });
}

async function executeJob(
  tabId: number,
  job: QueueJob,
  settings: AppState['settings'],
): Promise<void> {
  const downloadWaiter = createDownloadWaiter(job.id, tabId);

  try {
    const hydratedJob: QueueJob = {
      ...job,
      attachments: await hydrateAttachmentPayloads(job.attachments),
    };

    const response = (await browser.tabs.sendMessage(tabId, {
      type: 'automation/execute',
      payload: {
        job: hydratedJob,
        settings,
      },
    } satisfies AutomationExecuteMessage)) as AutomationReply;

    if (!response.ok) {
      downloadWaiter.cancel();
      throw withRetryableFlag(new Error(response.error), response.retryable ?? true);
    }

    await downloadWaiter.promise;
  } catch (error) {
    downloadWaiter.cancel();
    throw error;
  }
}

function createDownloadWaiter(jobId: string, tabId: number): {
  promise: Promise<void>;
  cancel: () => void;
} {
  if (pendingDownload) {
    pendingDownload.reject(new Error('Superseded by a newer queue job.'));
  }

  let settled = false;

  const promise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      settled = true;
      pendingDownload = null;
      reject(new Error('Timed out waiting for the browser download to finish.'));
    }, DOWNLOAD_TIMEOUT_MS);

    pendingDownload = {
      jobId,
      tabId,
      createdAt: Date.now(),
      downloadId: null,
      timer,
      resolve: () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        pendingDownload = null;
        resolve();
      },
      reject: (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        pendingDownload = null;
        reject(error);
      },
    };
  });

  return {
    promise,
    cancel: () => {
      if (!pendingDownload || pendingDownload.jobId !== jobId || settled) {
        return;
      }

      settled = true;
      clearTimeout(pendingDownload.timer);
      pendingDownload = null;
    },
  };
}

async function findGrokTab() {
  const tabs = await browser.tabs.query({
    url: GROK_TAB_PATTERNS,
  });

  return tabs.find((tab) => tab.active) ?? tabs[0];
}

async function parkQueue(message: string): Promise<void> {
  await updateAppState((state) => {
    const parked: AppState = {
      ...state,
      activeJobId: null,
      runState: 'queued',
    };

    const latestLog = state.logs[0];
    if (latestLog?.message === message) {
      return parked;
    }

    return appendLog(parked, 'warn', message);
  });
}

function markJobRunning(state: AppState, jobId: string): AppState {
  const job = state.queue.find((entry) => entry.id === jobId);
  if (!job) {
    return state;
  }

  const nextState: AppState = {
    ...state,
    queue: state.queue.map((entry) =>
      entry.id === jobId
        ? {
            ...entry,
            status: 'running',
            progress: 0,
            lastError: undefined,
          }
        : entry,
    ),
    activeJobId: jobId,
    runState: 'running',
  };

  return appendLog(
    nextState,
    'info',
    `Running prompt ${job.promptIndex + 1}, output ${job.outputIndex}, attempt ${job.attemptCount + 1}.`,
  );
}

function markJobDownloaded(state: AppState, jobId: string): AppState {
  const job = state.queue.find((entry) => entry.id === jobId);
  if (!job) {
    return state;
  }

  const queue = state.queue.map((entry) =>
    entry.id === jobId
      ? {
          ...entry,
          status: 'downloaded' as const,
          progress: 100,
          lastError: undefined,
        }
      : entry,
  );
  const hasQueuedJobs = queue.some((entry) => entry.status === 'queued');

  return appendLog(
    {
      ...state,
      queue,
      activeJobId: null,
      runState: hasQueuedJobs ? 'queued' : 'completed',
    },
    'info',
    `Download completed for prompt ${job.promptIndex + 1}, output ${job.outputIndex}.`,
  );
}

function markJobFailure(
  state: AppState,
  jobId: string,
  error: string,
  retryable: boolean,
): AppState {
  const job = state.queue.find((entry) => entry.id === jobId);
  if (!job) {
    return state;
  }

  const shouldRetry = retryable && job.attemptCount < state.settings.maxRetries;
  const nextAttemptCount = job.attemptCount + 1;
  const queue = state.queue.map((entry) =>
    entry.id === jobId
      ? {
          ...entry,
          attemptCount: nextAttemptCount,
          lastError: error,
          status: shouldRetry ? ('queued' as const) : ('failed' as const),
        }
      : entry,
  );
  const hasQueuedJobs = queue.some((entry) => entry.status === 'queued');
  const nextState: AppState = {
    ...state,
    queue,
    activeJobId: null,
    runState: hasQueuedJobs ? 'queued' : 'completed',
  };

  if (shouldRetry) {
    return appendLog(
      nextState,
      'warn',
      `Attempt ${nextAttemptCount} failed for prompt ${job.promptIndex + 1}, output ${job.outputIndex}. Re-queued: ${error}`,
    );
  }

  return appendLog(
    nextState,
    'error',
    `Prompt ${job.promptIndex + 1}, output ${job.outputIndex} failed: ${error}`,
  );
}

function getRandomDelayMs(delayRange: AppState['settings']['delayRange']): number {
  const min = Math.max(0, delayRange.minSeconds * 1000);
  const max = Math.max(min, delayRange.maxSeconds * 1000);
  return Math.round(min + Math.random() * (max - min));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withRetryableFlag(error: Error, retryable: boolean): Error & { retryable: boolean } {
  return Object.assign(error, { retryable });
}

async function cleanupCompletedAssetPayloads(): Promise<void> {
  const state = await getAppState();
  const removableIds = collectQueueAssetIds(
    state.queue.filter((job) => job.status === 'downloaded' || job.status === 'failed'),
  );
  const retainedIds = new Set(
    collectQueueAssetIds(
      state.queue.filter((job) => job.status === 'queued' || job.status === 'running'),
    ),
  );

  await deleteAttachmentPayloads(
    removableIds.filter((assetId) => !retainedIds.has(assetId)),
  );
}

function collectQueueAssetIds(queue: QueueJob[]): string[] {
  return queue.flatMap((job) => collectAttachmentAssetIds(job.attachments));
}

function ok(state: AppState): RuntimeReply {
  return {
    ok: true,
    state,
  };
}

function fail(state: AppState, error: string): RuntimeReply {
  return {
    ok: false,
    error,
    state,
  };
}

// ---------------------------------------------------------------------------
// Download filename builder
// ---------------------------------------------------------------------------

/**
 * Builds a safe cross-platform filename for a downloaded video.
 * Format: `<sanitizedFolder>/<order>_<slug><ext>`
 * The total base name (order_slug) is capped at 50 characters.
 */
function buildDownloadFilename(job: QueueJob, originalFilename: string): string {
  const order = job.promptOrder ?? job.promptIndex + 1;
  const ext = extractExtension(originalFilename);
  const prefix = `${order}_`;
  const maxSlugLen = Math.max(1, 50 - prefix.length);
  const slug = sanitizeSegment(job.prompt, maxSlugLen);
  const folder = sanitizeSegment(job.folder, 40);
  return `${folder}/${prefix}${slug}${ext}`;
}

/**
 * Sanitizes a string for use as a file/folder name segment.
 * - Lowercased
 * - Non-alphanumeric chars replaced with `_`
 * - Consecutive underscores collapsed
 * - Leading/trailing underscores stripped
 * - Truncated to `maxLen`
 */
function sanitizeSegment(input: string, maxLen: number): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen)
    .replace(/_+$/, '') || 'untitled';
}

/** Returns the extension (including dot) from `filename`, default `.mp4`. */
function extractExtension(filename: string): string {
  const dotIdx = filename.lastIndexOf('.');
  if (dotIdx <= 0 || dotIdx === filename.length - 1) return '.mp4';
  const ext = filename.slice(dotIdx).toLowerCase();
  return /^\.[a-z0-9]{1,6}$/.test(ext) ? ext : '.mp4';
}

// ---------------------------------------------------------------------------
// Abort helper — notifies the content script to stop in-flight automation
// ---------------------------------------------------------------------------

async function sendAbortToGrokTab(): Promise<void> {
  try {
    const tab = await findGrokTab();
    if (!tab?.id) return;
    await browser.tabs.sendMessage(tab.id, { type: 'automation/abort' } satisfies AppMessage);
  } catch {
    // Non-fatal: the tab may not be listening yet or may have been closed.
  }
}

// ---------------------------------------------------------------------------
// Panel-close handler — triggered when the side-panel port disconnects
// ---------------------------------------------------------------------------

async function handlePanelClosed(): Promise<void> {
  // Force stop any in-flight automation.
  forceStopRequested = true;
  isQueuePaused = true;
  if (pendingDownload) {
    const err = new Error('Side panel closed — queue terminated.');
    (err as Error & { retryable: boolean }).retryable = false;
    pendingDownload.reject(err);
  }
  void sendAbortToGrokTab();

  // Clear the entire queue and release attached assets.
  const currentState = await getAppState();
  const assetIds = collectQueueAssetIds(currentState.queue);
  await setAppState(
    appendLog(
      {
        ...currentState,
        queue: [],
        activeJobId: null,
        runState: 'idle',
      },
      'info',
      'Side panel closed — queue cleared and automation stopped.',
    ),
  );
  await deleteAttachmentPayloads(assetIds);
}
