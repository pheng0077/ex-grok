import type { AppState, AutomationSettings } from '@/lib/contracts';

export const APP_STATE_STORAGE_KEY = 'exGrok.appState';
export const MAX_LOG_ENTRIES = 150;

export const DEFAULT_SETTINGS: AutomationSettings = {
  defaultMode: 'text-to-video',
  aspectRatio: '16:9',
  videoDuration: '6s',
  imageQuality: '720p',
  imageProcessingMode: 'start-frame-only',
  outputsPerPrompt: 1,
  outputFolder: 'grok-folder-1',
  autoRename: true,
  delayRange: {
    minSeconds: 20,
    maxSeconds: 30,
  },
  maxRetries: 5,
  language: 'English',
};

export function createDefaultState(): AppState {
  return {
    settings: DEFAULT_SETTINGS,
    queue: [],
    logs: [],
    runState: 'idle',
    activeJobId: null,
    nextRunAt: null,
    grokPage: null,
    updatedAt: new Date().toISOString(),
  };
}