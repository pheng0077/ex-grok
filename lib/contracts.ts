export type GenerationMode = 'text-to-video' | 'frame-to-video';
export type QueueJobStatus = 'queued' | 'running' | 'downloaded' | 'failed';
export type RunState = 'idle' | 'queued' | 'running' | 'paused' | 'completed';
export type LogLevel = 'info' | 'warn' | 'error';

export interface DelayRange {
  minSeconds: number;
  maxSeconds: number;
}

export interface AutomationSettings {
  defaultMode: GenerationMode;
  aspectRatio: '16:9' | '9:16' | '2:3' | '3:2' | '1:1';
  videoDuration: '6s' | '10s';
  imageQuality: '480p' | '720p';
  imageProcessingMode: 'start-frame-only' | 'pair-each-image';
  outputsPerPrompt: number;
  outputFolder: string;
  autoRename: boolean;
  delayRange: DelayRange;
  maxRetries: number;
  language: string;
}

export interface ImageAttachmentMeta {
  assetId?: string;
  name: string;
  size: number;
  type: string;
  dataUrl?: string;
}

export interface QueueDraft {
  prompt: string;
  promptOrder?: number; // user-supplied order number (from "N\n" prompt header)
  mode: GenerationMode;
  outputsPerPrompt: number;
  folder: string;
  attachments: ImageAttachmentMeta[];
  videoDuration?: AutomationSettings['videoDuration'];
  imageQuality?: AutomationSettings['imageQuality'];
}

export interface QueueJob extends QueueDraft {
  id: string;
  batchId: string;
  promptIndex: number;
  promptOrder?: number; // user-supplied order number parsed from leading "N\n" header
  outputIndex: number;
  createdAt: string;
  attemptCount: number;
  status: QueueJobStatus;
  lastError?: string;
  progress?: number; // 0-100, set during generation polling
}

export interface DebugLogEntry {
  id: string;
  level: LogLevel;
  message: string;
  createdAt: string;
}

export interface GrokPageSnapshot {
  url: string;
  title: string;
  detectedPromptInput: boolean;
  detectedImageUpload: boolean;
  detectedGenerateAction: boolean;
  authenticated: boolean;
  readyForAutomation: boolean;
  updatedAt: string;
}

export interface AppState {
  settings: AutomationSettings;
  queue: QueueJob[];
  logs: DebugLogEntry[];
  runState: RunState;
  activeJobId: string | null;
  nextRunAt: string | null;
  grokPage: GrokPageSnapshot | null;
  updatedAt: string;
}

export type AppMessage =
  | { type: 'app/get-state' }
  | { type: 'queue/enqueue'; payload: { drafts: QueueDraft[] } }
  | { type: 'queue/clear' }
  | { type: 'queue/force-stop' }
  | { type: 'queue/start' }
  | { type: 'queue/stop' }
  | { type: 'queue/resume' }
  | { type: 'settings/update'; payload: { patch: Partial<AutomationSettings> } }
  | { type: 'logs/clear' }
  | { type: 'page/update'; payload: { snapshot: GrokPageSnapshot } }
  | { type: 'job/progress'; payload: { jobId: string; progress: number } }
  | { type: 'job/retry'; payload: { jobId: string } }
  | { type: 'job/rerun'; payload: { jobId: string } }
  | { type: 'job/remove'; payload: { jobId: string } }
  | { type: 'automation/abort' };

export interface AutomationExecuteMessage {
  type: 'automation/execute';
  payload: {
    job: QueueJob;
    settings: AutomationSettings;
  };
}

export type AutomationReply =
  | {
      ok: true;
      detail: string;
    }
  | {
      ok: false;
      error: string;
      retryable?: boolean;
    };

export type RuntimeReply =
  | {
      ok: true;
      state: AppState;
    }
  | {
      ok: false;
      error: string;
      state: AppState;
    };