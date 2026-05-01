import type { AppState, DebugLogEntry, LogLevel, QueueJob } from '@/lib/contracts';
import {
  APP_STATE_STORAGE_KEY,
  createDefaultState,
  DEFAULT_SETTINGS,
  MAX_LOG_ENTRIES,
} from '@/lib/defaults';

// Queue is persisted to storage so MV3 service worker restarts don't lose jobs.
let _memQueue: QueueJob[] = [];
let _memLogs: DebugLogEntry[] = [];

export async function getAppState(): Promise<AppState> {
  const stored = await browser.storage.local.get(APP_STATE_STORAGE_KEY);
  const storedState = stored[APP_STATE_STORAGE_KEY] as Partial<AppState> | undefined;

  // On SW restart _memQueue is empty. Restore from storage and reset any
  // 'running' jobs back to 'queued' so they are retried automatically.
  if (_memQueue.length === 0 && Array.isArray(storedState?.queue) && storedState!.queue.length > 0) {
    _memQueue = (storedState!.queue as QueueJob[]).map((job) =>
      job.status === 'running' ? { ...job, status: 'queued' as const } : job,
    );
  }

  return normalizeState(storedState, _memQueue, _memLogs);
}

export async function setAppState(state: AppState): Promise<AppState> {
  _memQueue = state.queue;
  _memLogs = state.logs;
  const normalized = normalizeState(state, _memQueue, _memLogs);
  // Persist queue-backed runtime state so MV3 restarts don't lose jobs.
  await browser.storage.local.set({
    [APP_STATE_STORAGE_KEY]: {
      ...normalized,
      logs: [],
    },
  });
  return normalized;
}

export async function updateAppState(
  updater: (state: AppState) => AppState | Promise<AppState>,
): Promise<AppState> {
  const current = await getAppState();
  const next = await updater(current);
  return setAppState(next);
}

export function appendLog(
  state: AppState,
  level: LogLevel,
  message: string,
): AppState {
  const entry: DebugLogEntry = {
    id: crypto.randomUUID(),
    level,
    message,
    createdAt: new Date().toISOString(),
  };

  return normalizeState({
    ...state,
    logs: [entry, ...state.logs].slice(0, MAX_LOG_ENTRIES),
  });
}

function normalizeState(
  state?: Partial<AppState>,
  queueOverride?: QueueJob[],
  logOverride?: DebugLogEntry[],
): AppState {
  const base = createDefaultState();
  const queue = queueOverride ?? state?.queue ?? base.queue;
  const logs = logOverride ?? state?.logs ?? base.logs;

  // When injecting a fresh in-memory queue (startup / background restart),
  // derive runState + activeJobId from actual queue contents so stale
  // 'running' values stored from a previous session don't persist.
  const derivedRunState: AppState['runState'] = queue.some((j) => j.status === 'running')
    ? 'running'
    : queue.some((j) => j.status === 'queued')
      ? 'queued'
      : 'idle';

  const runState =
    queueOverride !== undefined
      ? derivedRunState
      : (state?.runState ?? derivedRunState);

  const activeJobId =
    queueOverride !== undefined
      ? (queue.find((j) => j.status === 'running')?.id ?? null)
      : (state?.activeJobId ?? base.activeJobId);

  return {
    ...base,
    ...state,
    settings: {
      ...DEFAULT_SETTINGS,
      ...(state?.settings ?? {}),
      delayRange: {
        ...DEFAULT_SETTINGS.delayRange,
        ...(state?.settings?.delayRange ?? {}),
      },
    },
    queue,
    logs,
    runState,
    activeJobId,
    nextRunAt:
      runState === 'queued' && queue.some((j) => j.status === 'queued')
        ? (state?.nextRunAt ?? base.nextRunAt)
        : null,
    grokPage: state?.grokPage ?? base.grokPage,
    updatedAt: new Date().toISOString(),
  };
}