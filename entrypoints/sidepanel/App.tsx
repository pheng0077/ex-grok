import { type DragEvent as ReactDragEvent, useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { FolderOpen, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { parsePromptGroups } from '@/features/prompts/parsePromptGroups';
import {
  storeAttachmentPayloads,
  type AttachmentAssetInput,
  type ReadableFileHandle,
} from '@/lib/assetVault';
import type {
  AppState,
  AutomationSettings,
  GenerationMode,
  ImageAttachmentMeta,
  QueueDraft,
} from '@/lib/contracts';
import {
  clearLogs,
  clearQueue,
  enqueueDrafts,
  forceStopQueue,
  getRuntimeState,
  removeQueueJob,
  retryJob,
  rerunJob,
  startQueue,
  subscribeToRuntimeState,
  updateSettings,
} from '@/lib/runtime';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import './App.css';

type PanelTab = 'control' | 'settings' | 'logs';

const TAB_META: Record<PanelTab, { title: string; detail: string }> = {
  control: {
    title: 'Control',
    detail: 'Build batches, watch queue state, and run jobs.',
  },
  settings: {
    title: 'Settings',
    detail: 'Tune defaults, timing, and output behavior.',
  },
  logs: {
    title: 'Debug Logs',
    detail: 'Review runtime activity, warnings, and failures.',
  },
};

type SelectedAttachment = {
  file: File;
  fileHandle?: ReadableFileHandle;
};

type FilePickerOptions = {
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  id?: string;
  startIn?: 'desktop' | 'documents' | 'downloads' | 'pictures';
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
};

type FilePickerWindow = Window &
  typeof globalThis & {
    showOpenFilePicker?: (
      options?: FilePickerOptions,
    ) => Promise<ReadableFileHandle[]>;
    showDirectoryPicker?: (
      options?: DirectoryPickerOptions,
    ) => Promise<ReadableDirectoryHandle>;
  };

type ReadableDirectoryHandle = {
  kind: 'directory';
  name: string;
};

type DirectoryPickerOptions = {
  id?: string;
  mode?: 'read' | 'readwrite';
  startIn?: FilePickerOptions['startIn'];
};

type DataTransferItemWithFileHandle = DataTransferItem & {
  getAsFileSystemHandle?: () => Promise<ReadableFileHandle | null>;
};

function App() {
  const [tab, setTab] = useState<PanelTab>('control');
  const [state, setState] = useState<AppState | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<AutomationSettings | null>(null);
  const [promptText, setPromptText] = useState('');
  const [mode, setMode] = useState<GenerationMode>('text-to-video');
  const [folderName, setFolderName] = useState('grok-folder-1');
  const [attachments, setAttachments] = useState<(SelectedAttachment | null)[]>([]);
  const [thumbUrls, setThumbUrls] = useState<(string | null)[]>([]);
  const [perPromptDurations, setPerPromptDurations] = useState<Record<number, '6s' | '10s'>>({});
  const [isBusy, setIsBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeType, setNoticeType] = useState<'info' | 'success' | 'warn' | 'error'>('info');
  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  // dragInsertAt tracks where the insertion line should appear during reorder
  const [dragInsertAt, setDragInsertAt] = useState<{ idx: number; side: 'before' | 'after' } | null>(null);
  const [dragOverEmpty, setDragOverEmpty] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragSrcIdx = useRef<number | null>(null);
  const folderPersistSeq = useRef(0);

  // Create object URLs for attachment thumbnails; revoke when attachments change.
  useEffect(() => {
    const urls = attachments.map((a) => (a ? URL.createObjectURL(a.file) : null));
    setThumbUrls(urls);
    return () => urls.forEach((u) => { if (u) URL.revokeObjectURL(u); });
  }, [attachments]);

  // Reset per-prompt durations when prompts or attachments change.
  useEffect(() => {
    setPerPromptDurations({});
  }, [promptText, attachments]);

  useEffect(() => {
    void refresh();
    const unsub = subscribeToRuntimeState((nextState) => {
      setState(nextState);
    });
    // Keep a long-lived port so background knows when the panel closes.
    const port = browser.runtime.connect({ name: 'sidepanel' });
    return () => {
      unsub();
      port.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!state?.nextRunAt) {
      return;
    }

    setCountdownNow(Date.now());
    const intervalId = window.setInterval(() => {
      setCountdownNow(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [state?.nextRunAt]);

  useEffect(() => {
    if (!state) {
      return;
    }

    if (folderName === state.settings.outputFolder) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void persistOutputFolder(folderName);
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [folderName, state]);

  async function refresh() {
    const nextState = await getRuntimeState();
    setState(nextState);
    setSettingsDraft(nextState.settings);
    setMode(nextState.settings.defaultMode);
    setFolderName(nextState.settings.outputFolder);
  }

  // When adding new images, fill any null (removed) slots first, then append.
  function setSelectedAttachments(nextAttachments: SelectedAttachment[]) {
    setAttachments((prev) => {
      const result: (SelectedAttachment | null)[] = [...prev];
      let ni = 0;
      for (let i = 0; i < result.length && ni < nextAttachments.length; i++) {
        if (result[i] === null) result[i] = nextAttachments[ni++];
      }
      while (ni < nextAttachments.length) result.push(nextAttachments[ni++]);
      return result;
    });
    setNotice(null);
  }

  // Removing an attachment sets its slot to null (preserving all other positions).
  // Trailing null slots are trimmed so the array doesn't accumulate dead entries.
  function removeAttachment(idx: number) {
    setAttachments((prev) => {
      const next: (SelectedAttachment | null)[] = [...prev];
      next[idx] = null;
      while (next.length > 0 && next[next.length - 1] === null) next.pop();
      return next;
    });
    setNotice(null);
  }

  const handleThumbDragStart = useCallback((_e: ReactDragEvent<HTMLDivElement>, idx: number) => {
    dragSrcIdx.current = idx;
  }, []);

  const handleThumbDragOver = useCallback((e: ReactDragEvent<HTMLDivElement>, idx: number) => {
    e.preventDefault();
    // Determine insertion side from cursor position within the element
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const side: 'before' | 'after' = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
    setDragInsertAt({ idx, side });
  }, []);

  const handleThumbDrop = useCallback((e: ReactDragEvent<HTMLDivElement>, idx: number) => {
    e.preventDefault();
    const src = dragSrcIdx.current;
    dragSrcIdx.current = null;
    setDragInsertAt(null);
    if (src === null) return;

    // Compute insertion side at drop time
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const side: 'before' | 'after' = e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
    const rawInsert = side === 'before' ? idx : idx + 1;
    if (rawInsert === src || rawInsert === src + 1) return; // already in place

    setAttachments((prev) => {
      const next: (SelectedAttachment | null)[] = [...prev];
      const [moved] = next.splice(src, 1);
      const insertAt = src < rawInsert ? rawInsert - 1 : rawInsert;
      next.splice(insertAt, 0, moved);
      while (next.length > 0 && next[next.length - 1] === null) next.pop();
      return next;
    });
  }, []);

  const handleThumbDragEnd = useCallback(() => {
    dragSrcIdx.current = null;
    setDragInsertAt(null);
  }, []);

  async function browseForAttachments() {
    if (supportsFileHandlePicker()) {
      try {
        const nextAttachments = await pickAttachmentsFromFileSystem();
        if (nextAttachments.length) {
          setSelectedAttachments(nextAttachments);
        }
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }

        setNotice(
          error instanceof Error
            ? error.message
            : 'Failed to pick image files from disk.',
        );
      }

      return;
    }

    fileInputRef.current?.click();
  }

  async function browseForOutputFolder() {
    if (!supportsDirectoryPicker()) {
      setNotice('Directory browsing is unavailable here. Enter a folder name manually.');
      setNoticeType('warn');
      return;
    }

    const picker = (window as FilePickerWindow).showDirectoryPicker;
    if (!picker) {
      return;
    }

    try {
      const handle = await picker({
        id: 'selectOutputFolder',
        startIn: 'downloads',
        mode: 'read',
      });
      applyOutputFolder(handle.name);
      setNotice(`Using Downloads/${handle.name} for this batch.`);
      setNoticeType('info');
    } catch (error) {
      if (isAbortError(error)) {
        return;
      }

      setNotice(error instanceof Error ? error.message : 'Failed to choose a folder.');
      setNoticeType('error');
    }
  }

  function applyOutputFolder(nextFolder: string) {
    setFolderName(nextFolder);
    setSettingsDraft((current) =>
      current
        ? {
            ...current,
            outputFolder: nextFolder,
          }
        : current,
    );
  }

  async function persistOutputFolder(nextFolder: string) {
    const persistSeq = ++folderPersistSeq.current;

    try {
      const nextState = await updateSettings({ outputFolder: nextFolder });
      if (persistSeq !== folderPersistSeq.current) {
        return;
      }

      setState(nextState);
      setSettingsDraft((current) =>
        current
          ? {
              ...current,
              outputFolder: nextState.settings.outputFolder,
            }
          : nextState.settings,
      );
    } catch (error) {
      if (persistSeq !== folderPersistSeq.current) {
        return;
      }

      setNotice(
        error instanceof Error
          ? error.message
          : 'Failed to persist the output folder.',
      );
      setNoticeType('error');
    }
  }

  async function handleAttachmentDrop(event: ReactDragEvent<HTMLElement>) {
    event.preventDefault();

    try {
      const nextAttachments = await getDroppedAttachments(event.dataTransfer);
      setSelectedAttachments(nextAttachments);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'Failed to read dropped image files.',
      );
      setNoticeType('error');
    }
  }

  async function runBatch() {
    const prompts = parsePromptGroups(promptText);

    if (!prompts.length) {
      setNotice('Add at least one prompt group separated by a blank line.');
      setNoticeType('warn');
      return;
    }

    if (mode === 'frame-to-video' && !attachments.some((a) => a !== null)) {
      setNotice('Frame-to-video mode requires at least one image.');
      setNoticeType('warn');
      return;
    }

    // In pair-each-image mode, block if any prompt slot has no image.
    const imageMode = settingsDraft?.imageProcessingMode ?? 'pair-each-image';
    if (mode === 'frame-to-video' && imageMode === 'pair-each-image') {
      const missingSlots = prompts
        .map((_, i) => (attachments[i] == null ? i + 1 : null))
        .filter((n): n is number => n !== null);
      if (missingSlots.length > 0) {
        setNotice(
          `⚠ ${missingSlots.length} prompt${missingSlots.length === 1 ? '' : 's'} ${missingSlots.length === 1 ? 'has' : 'have'} no image assigned (slot${missingSlots.length === 1 ? '' : 's'} ${missingSlots.join(', ')}). Fill the empty slot${missingSlots.length === 1 ? '' : 's'} or switch to “Use start frame only”.`,
        );
        setNoticeType('warn');
        return;
      }
    }

    setIsBusy(true);

    try {
      // Serialize all unique attachment files once (null slots produce null in the result).
      const allSerialized =
        mode === 'frame-to-video' && attachments.some((a) => a !== null)
          ? await serializeAllAttachmentsForQueue(attachments)
          : [];

      const drafts: QueueDraft[] = prompts.map((prompt, i) => {
        // start-frame-only: first non-null serialized image.
        // pair-each-image: exact slot i (validated above to be non-null).
        let jobAttachments: ImageAttachmentMeta[] = [];
        if (allSerialized.length > 0) {
          const serialized =
            imageMode === 'pair-each-image'
              ? (allSerialized[i] ?? null)
              : allSerialized.find((s) => s !== null) ?? null;
          if (serialized) jobAttachments = [serialized];
        }
        return {
          prompt: prompt.prompt,
          promptOrder: prompt.order,
          mode,
          outputsPerPrompt: settingsDraft?.outputsPerPrompt ?? 1,
          folder: folderName,
          attachments: jobAttachments,
          videoDuration: perPromptDurations[i] ?? settingsDraft?.videoDuration,
        };
      });

      const nextState = await enqueueDrafts(drafts);
      setState(nextState);
      setNotice(
        `Added ${drafts.length} prompt group${drafts.length === 1 ? '' : 's'} to the queue.`,
      );
      setNoticeType('success');
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'Failed to queue the current prompts.',
      );
      setNoticeType('error');
    } finally {
      setIsBusy(false);
    }
  }

  async function saveSettings() {
    if (!settingsDraft) {
      return;
    }

    setIsBusy(true);

    try {
      const nextState = await updateSettings({
        ...settingsDraft,
        outputsPerPrompt: Math.max(1, settingsDraft.outputsPerPrompt),
        maxRetries: Math.max(1, settingsDraft.maxRetries),
        delayRange: {
          minSeconds: Math.max(0, settingsDraft.delayRange.minSeconds),
          maxSeconds: Math.max(
            settingsDraft.delayRange.minSeconds,
            settingsDraft.delayRange.maxSeconds,
          ),
        },
      });
      setState(nextState);
      setSettingsDraft(nextState.settings);
      setFolderName(nextState.settings.outputFolder);
      setNotice('Settings saved to extension storage.');
      setNoticeType('success');
    } finally {
      setIsBusy(false);
    }
  }

  async function wipeQueue() {
    const nextState = await clearQueue();
    setState(nextState);
    setNotice('Queue cleared.');
    setNoticeType('info');
  }

  async function stopQueue() {
    try {
      const nextState = await forceStopQueue();
      setState(nextState);
      setNotice('Queue stopped.');
      setNoticeType('warn');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Stop failed.');
      setNoticeType('error');
    }
  }

  async function handleStartQueue() {
    try {
      const nextState = await startQueue();
      setState(nextState);
      setNotice('Queue started.');
      setNoticeType('info');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Start failed.');
      setNoticeType('error');
    }
  }

  async function handleRetry(jobId: string) {
    try {
      const nextState = await retryJob(jobId);
      setState(nextState);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Retry failed.');
      setNoticeType('error');
    }
  }

  async function handleRerun(jobId: string) {
    try {
      const nextState = await rerunJob(jobId);
      setState(nextState);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Re-run failed.');
      setNoticeType('error');
    }
  }

  async function handleRemoveJob(jobId: string) {
    try {
      const nextState = await removeQueueJob(jobId);
      setState(nextState);
      setNotice('Queue item removed.');
      setNoticeType('info');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Remove failed.');
      setNoticeType('error');
    }
  }

  async function wipeLogs() {
    const nextState = await clearLogs();
    setState(nextState);
    setNotice('Logs cleared.');
    setNoticeType('info');
  }

  const parsedPrompts = parsePromptGroups(promptText);
  const imageMode = settingsDraft?.imageProcessingMode ?? 'pair-each-image';
  const queue = state?.queue ?? [];
  const queuedJobs = queue.filter((job) => job.status === 'queued').length;
  const completedJobs = queue.filter(
    (job) => job.status === 'downloaded',
  ).length;
  const nextRunAtMs = state?.nextRunAt ? Date.parse(state.nextRunAt) : NaN;
  const nextRunCountdown = Number.isFinite(nextRunAtMs)
    ? Math.max(0, Math.ceil((nextRunAtMs - countdownNow) / 1000))
    : null;
  const activeTabMeta = TAB_META[tab];

  // Group queue jobs by batchId, preserving insertion order.
  const queueBatches: Array<{ batchId: string; jobs: typeof queue }> = [];
  for (const job of queue) {
    const last = queueBatches[queueBatches.length - 1];
    if (last && last.batchId === job.batchId) {
      last.jobs.push(job);
    } else {
      queueBatches.push({ batchId: job.batchId, jobs: [job] });
    }
  }

  // Returns the attachment paired with prompt at index i.
  // In pair-each-image mode: exact 1:1 pairing — returns null if no image at that index.
  // In start-frame-only mode: always index 0.
  function getFrameForPrompt(promptIdx: number): SelectedAttachment | null {
    if (!attachments.length) return null;
    if (settingsDraft?.imageProcessingMode === 'pair-each-image') {
      return attachments[promptIdx] ?? null; // exact index — no looping
    }
    return attachments[0] ?? null;
  }

  return (
    <main className="sidepanel-app">
      <header className="masthead">
        <div className="masthead-brand">
          <img src="/icon/source.svg" alt="Ex Grok logo" className="brand-mark brand-mark-sidepanel" />
          <div className="masthead-copy">
            <span className="masthead-title">Ex Grok</span>
            <strong className="masthead-page">{activeTabMeta.title}</strong>
            <p className="masthead-detail">{activeTabMeta.detail}</p>
          </div>
        </div>
        <div className="masthead-actions">
          <Button
            size="icon"
            variant="outline"
            className="refresh-button"
            title="Refresh panel"
            aria-label="Refresh panel"
            onClick={() => void refresh()}
          >
            <RefreshCw />
          </Button>
        </div>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as PanelTab)} className="tab-root">
        <TabsList className="tab-list">
          <TabsTrigger value="control" className="tab-trigger">Control</TabsTrigger>
          <TabsTrigger value="settings" className="tab-trigger">Settings</TabsTrigger>
          <TabsTrigger value="logs" className="tab-trigger">Debug Logs</TabsTrigger>
        </TabsList>

      <div className="tab-content">
      {tab === 'control' ? (
        <section className="control-layout">
          <div className="control-main">
            <section className="surface section-stack">
              <div className="section-heading">
                <h2>Mode</h2>
              </div>
              <div className="mode-grid">
                <Button
                  variant="outline"
                  size="sm"
                  className={`mode-toggle${mode === 'text-to-video' ? ' is-active' : ''}`}
                  onClick={() => setMode('text-to-video')}
                >
                  Text to video
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className={`mode-toggle${mode === 'frame-to-video' ? ' is-active' : ''}`}
                  onClick={() => setMode('frame-to-video')}
                >
                  Frame to video
                </Button>
              </div>
            </section>

            {mode === 'frame-to-video' ? (
              <section className="surface section-stack">
              <div className="section-heading">
                  <h2>Images</h2>
                  <div className="heading-actions">
                    {attachments.some((a) => a !== null) && (
                      <Button variant="outline" size="sm" onClick={() => setAttachments([])}>Clear all</Button>
                    )}
                    <Button variant="outline" size="sm" onClick={() => void browseForAttachments()}>Browse</Button>
                  </div>
                </div>

                {/* Hidden file input for fallback browsers */}
                <input
                  ref={fileInputRef}
                  hidden
                  accept="image/*"
                  multiple
                  type="file"
                  onChange={(event) => {
                    setSelectedAttachments(
                      Array.from(event.target.files ?? []).map((file) => ({ file })),
                    );
                    event.target.value = '';
                  }}
                />

                {!attachments.some((a) => a !== null) ? (
                  /* Empty dropzone — large, full-width, easy to drop into */
                  <div
                    className={`dropzone dropzone-empty${dragOverEmpty ? ' drag-active' : ''}`}
                    role="button"
                    tabIndex={0}
                    onDragEnter={() => setDragOverEmpty(true)}
                    onDragLeave={() => setDragOverEmpty(false)}
                    onDragOver={(event) => { event.preventDefault(); setDragOverEmpty(true); }}
                    onDrop={(event) => { setDragOverEmpty(false); void handleAttachmentDrop(event); }}
                    onClick={() => void browseForAttachments()}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') void browseForAttachments(); }}
                  >
                    <span className="dropzone-icon">🖼</span>
                    <span className="dropzone-label">Drop images here or click to browse</span>
                    <span className="dropzone-hint muted small-copy">PNG, JPG, WEBP, GIF</span>
                  </div>
                ) : (
                  /* Filled state — thumbnail grid with remove + drag-reorder */
                  <div
                    className="thumb-grid"
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(event) => { void handleAttachmentDrop(event); }}
                  >
                    {attachments.map((att, idx) =>
                      att === null ? (
                        /* Empty slot — position held after removal */
                        <div
                          key={`slot-empty-${idx}`}
                          className={`thumb-item thumb-slot-empty${dragInsertAt?.idx === idx && dragInsertAt.side === 'before' ? ' drag-insert-before' : dragInsertAt?.idx === idx && dragInsertAt.side === 'after' ? ' drag-insert-after' : ''}`}
                          onDragOver={(e) => handleThumbDragOver(e, idx)}
                          onDrop={(e) => handleThumbDrop(e, idx)}
                          onDragEnd={handleThumbDragEnd}
                          title={`Slot ${idx + 1} — no image`}
                        >
                          <span className="thumb-slot-num">{idx + 1}</span>
                        </div>
                      ) : (
                        /* Normal thumbnail */
                        <div
                          key={`${att.file.name}-${idx}`}
                          className={`thumb-item${dragInsertAt?.idx === idx && dragInsertAt.side === 'before' ? ' drag-insert-before' : dragInsertAt?.idx === idx && dragInsertAt.side === 'after' ? ' drag-insert-after' : ''}`}
                          draggable
                          onDragStart={(e) => handleThumbDragStart(e, idx)}
                          onDragOver={(e) => handleThumbDragOver(e, idx)}
                          onDrop={(e) => handleThumbDrop(e, idx)}
                          onDragEnd={handleThumbDragEnd}
                          title={att.file.name}
                        >
                          <img
                            className="thumb-img"
                            src={thumbUrls[idx] ?? undefined}
                            alt={att.file.name}
                          />
                          <button
                            className="thumb-remove"
                            aria-label={`Remove ${att.file.name}`}
                            onClick={() => removeAttachment(idx)}
                          >
                            ×
                          </button>
                          <span className="thumb-handle" aria-hidden="true">⠿</span>
                          <span className="thumb-name">{att.file.name}</span>
                        </div>
                      )
                    )}
                    {/* Drop more images here tile */}
                    <div
                      className="thumb-item thumb-add"
                      role="button"
                      tabIndex={0}
                      title="Add more images"
                      onClick={() => void browseForAttachments()}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') void browseForAttachments(); }}
                    >
                      <span className="thumb-add-icon">+</span>
                    </div>
                  </div>
                )}
              </section>
            ) : null}

            <section className="surface section-stack">
              <div className="section-heading">
                <h2>Prompts</h2>
                <div className="heading-actions">
                  {promptText && (
                    <Button variant="outline" size="sm" onClick={() => setPromptText('')}>Clear</Button>
                  )}
                  <div className="tooltip-wrap">
                    <button
                      type="button"
                      className="hint-badge"
                      aria-label="Prompt formatting help"
                      aria-describedby="prompt-format-tooltip"
                      onClick={(event) => {
                        event.preventDefault();
                        setNotice('Blank line = new queue item. Put a bare number on the first line to set a custom prompt order.');
                        setNoticeType('info');
                      }}
                    >
                      !
                    </button>
                    <div id="prompt-format-tooltip" role="tooltip" className="prompt-tooltip">
                      <p className="prompt-tooltip-title">Prompt format</p>
                      <ul className="prompt-tooltip-list muted">
                        <li>Blank line = new queue item.</li>
                        <li>Single line breaks stay inside the same prompt.</li>
                        <li>Optional custom order: put a bare number on the first line, then the prompt text.</li>
                      </ul>
                      <pre className="prompt-tooltip-example">1{`\n`}A cinematic shot of a neon train emerging from fog.</pre>
                    </div>
                  </div>
                </div>
              </div>

              <label className="field-stack">
                <Textarea
                  placeholder={[
                    'A cinematic shot of a neon train emerging from fog.',
                    '',
                    'A macro product animation with rain drops and high contrast light.',
                  ].join('\n')}
                  value={promptText}
                  onChange={(event) => setPromptText(event.target.value)}
                />
              </label>

              {mode === 'frame-to-video' && parsedPrompts.length > 0 && attachments.some((a) => a !== null) ? (
                <div className="prompt-map">
                  {parsedPrompts.map((p, i) => {
                    const frame = getFrameForPrompt(i);
                    const thumbUrl = frame ? thumbUrls[i] : undefined;
                    const dur = perPromptDurations[i] ?? settingsDraft?.videoDuration ?? '6s';
                    const missingImage = imageMode === 'pair-each-image' && !frame;
                    return (
                      <div key={i} className={`pm-row${missingImage ? ' pm-row-warn' : ''}`}>
                        <span className="pm-idx">{p.order ?? i + 1}</span>
                        {thumbUrl ? (
                          <img className="pm-thumb" src={thumbUrl} alt={frame?.file.name} title={frame?.file.name} />
                        ) : (
                          <span className={`pm-thumb pm-thumb-empty${missingImage ? ' pm-thumb-missing' : ''}`} title={missingImage ? 'No image assigned' : undefined}>
                            {missingImage ? '!' : ''}
                          </span>
                        )}
                        <span className="pm-prompt" title={p.prompt}>{p.prompt}</span>
                        <Select
                          value={dur}
                          onValueChange={(v) =>
                            setPerPromptDurations((prev) => ({
                              ...prev,
                              [i]: v as '6s' | '10s',
                            }))
                          }
                        >
                          <SelectTrigger className="pm-dur"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="6s">6s</SelectItem>
                            <SelectItem value="10s">10s</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    );
                  })}
                  {imageMode === 'pair-each-image' && attachments.filter(a => a !== null).length > parsedPrompts.length ? (
                    <p className="pm-mismatch-warn">
                      ⚠ {attachments.filter(a => a !== null).length - parsedPrompts.length} image{attachments.filter(a => a !== null).length - parsedPrompts.length === 1 ? '' : 's'} beyond the last prompt will not be used.
                    </p>
                  ) : null}
                  {imageMode === 'pair-each-image' && parsedPrompts.length > attachments.length ? (
                    <p className="pm-mismatch-warn">
                      ⚠ {parsedPrompts.length - attachments.length} prompt{parsedPrompts.length - attachments.length === 1 ? '' : 's'} have no image (slot{parsedPrompts.length - attachments.length === 1 ? '' : 's'} {attachments.length + 1}–{parsedPrompts.length}).
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div className="button-row">
                <Button variant="outline" disabled={isBusy} onClick={() => void runBatch()}>
                  {isBusy ? 'Queueing...' : 'Add to Queue'}
                </Button>
              </div>
            </section>

            {/* Folder card — between Prompts and Queue sidebar */}
            <section className="surface folder-card">
              <span className="field-label">Save to folder</span>
              <div className="folder-input-row">
                <Input
                  placeholder="folder name"
                  value={folderName}
                  onChange={(e) => applyOutputFolder(e.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="folder-browse-button"
                  title="Pick a folder to reuse its name"
                  aria-label="Pick a folder to reuse its name"
                  onClick={() => void browseForOutputFolder()}
                >
                  <FolderOpen />
                </Button>
              </div>
              <p className="field-hint">Chrome saves into Downloads/{folderName || 'folder-name'}.</p>
            </section>
          </div>

          <aside className="control-sidebar">
            <section className="surface section-stack">
              <div className="section-heading">
                <h2>Queue</h2>
                <Badge variant="outline" className={`state-badge state-${state?.runState ?? 'idle'}`}>{state?.runState ?? 'idle'}</Badge>
              </div>

              <div className="stats-row">
                <span><strong>{queuedJobs}</strong> queued</span>
                <span><strong>{completedJobs}</strong> done</span>
              </div>

              {state?.runState === 'queued' && nextRunCountdown !== null ? (
                <p className="queue-timer">
                  {nextRunCountdown > 0
                    ? `Next job starts in ${nextRunCountdown}s`
                    : 'Starting next job...'}
                </p>
              ) : null}

              {queue.length ? (
                <div className="batch-list">
                  <AnimatePresence initial={false}>
                  {queueBatches.map((batch, batchIdx) => (
                    <motion.div
                      key={batch.batchId}
                      className="batch-group"
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      transition={{ duration: 0.15 }}
                    >
                      <div className="batch-header">
                        <span className="batch-label">Batch {batchIdx + 1}</span>
                        <span className="batch-count muted small-copy">{batch.jobs.length} job{batch.jobs.length === 1 ? '' : 's'}</span>
                      </div>
                      <table className="queue-table">
                        <tbody>
                          {batch.jobs.map((job) => (
                            <tr key={job.id} className={`qr ${job.status}`}>
                              <td className="qr-idx">#{job.promptOrder ?? job.promptIndex + 1}</td>
                              <td className="qr-prompt" title={job.lastError ?? job.prompt}>{job.prompt}</td>
                              <td className="qr-status">
                                {job.status === 'running' && job.progress != null
                                  ? `${job.progress}%`
                                  : job.status}
                              </td>
                              <td className="qr-actions">
                                <div className="qr-actions-group">
                                  {job.status === 'failed' ? (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="tiny icon-tiny"
                                      title="Retry failed job"
                                      aria-label="Retry failed job"
                                      onClick={() => void handleRetry(job.id)}
                                    >
                                      <RotateCcw />
                                    </Button>
                                  ) : null}
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="tiny icon-tiny"
                                    title="Queue this job again"
                                    aria-label="Queue this job again"
                                    onClick={() => void handleRerun(job.id)}
                                  >
                                    <RefreshCw />
                                  </Button>
                                  {job.status !== 'running' ? (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="tiny icon-tiny danger-tiny"
                                      title="Remove job from queue"
                                      aria-label="Remove job from queue"
                                      onClick={() => void handleRemoveJob(job.id)}
                                    >
                                      <Trash2 />
                                    </Button>
                                  ) : null}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </motion.div>
                  ))}
                  </AnimatePresence>
                </div>
              ) : (
                <p className="muted empty-copy">
                  No queue entries yet. Add prompts on the left, then run the queue.
                </p>
              )}

              <div className="queue-controls">
                {(state?.runState === 'queued' || state?.runState === 'paused' || state?.runState === 'completed') ? (
                  <Button size="sm" variant="default" onClick={() => void handleStartQueue()}>Start Queue</Button>
                ) : null}
                {state?.runState === 'running' ? (
                  <Button size="sm" variant="destructive" onClick={() => void stopQueue()}>Stop All</Button>
                ) : null}
                <Button size="sm" variant="outline" disabled={state?.runState === 'running'} onClick={() => void wipeQueue()}>Clear</Button>
              </div>
            </section>
          </aside>
        </section>
      ) : null}

      {tab === 'settings' && settingsDraft ? (
        <section className="surface section-stack">
          <div className="settings-group">
            <p className="settings-group-title">Video</p>
            <div className="settings-group-grid">
              <label className="field-stack">
                <span className="field-label">Default mode</span>
                <Select
                  value={settingsDraft.defaultMode}
                  onValueChange={(v) => setSettingsDraft({ ...settingsDraft, defaultMode: v as GenerationMode })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="text-to-video">Text to video</SelectItem>
                    <SelectItem value="frame-to-video">Frame to video</SelectItem>
                  </SelectContent>
                </Select>
              </label>

              <label className="field-stack">
                <span className="field-label">Default duration</span>
                <Select
                  value={settingsDraft.videoDuration}
                  onValueChange={(v) => setSettingsDraft({ ...settingsDraft, videoDuration: v as AutomationSettings['videoDuration'] })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="6s">6 seconds</SelectItem>
                    <SelectItem value="10s">10 seconds (SuperGrok)</SelectItem>
                  </SelectContent>
                </Select>
              </label>

              <label className="field-stack">
                <span className="field-label">Aspect ratio</span>
                <Select
                  value={settingsDraft.aspectRatio}
                  onValueChange={(v) => setSettingsDraft({ ...settingsDraft, aspectRatio: v as AutomationSettings['aspectRatio'] })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="16:9">16:9 Widescreen</SelectItem>
                    <SelectItem value="9:16">9:16 Vertical</SelectItem>
                    <SelectItem value="1:1">1:1 Square</SelectItem>
                    <SelectItem value="3:2">3:2 Wide</SelectItem>
                    <SelectItem value="2:3">2:3 Tall</SelectItem>
                  </SelectContent>
                </Select>
              </label>

              <label className="field-stack">
                <span className="field-label">Video quality</span>
                <Select
                  value={settingsDraft.imageQuality}
                  onValueChange={(v) => setSettingsDraft({ ...settingsDraft, imageQuality: v as AutomationSettings['imageQuality'] })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="480p">480p</SelectItem>
                    <SelectItem value="720p">720p (SuperGrok)</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            </div>
          </div>

          <div className="settings-group">
            <p className="settings-group-title">Processing</p>
            <label className="field-stack">
              <span className="field-label">How images map to prompts</span>
              <Select
                value={settingsDraft.imageProcessingMode}
                onValueChange={(v) => setSettingsDraft({ ...settingsDraft, imageProcessingMode: v as AutomationSettings['imageProcessingMode'] })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="pair-each-image">Match image 1 to prompt 1, image 2 to prompt 2</SelectItem>
                  <SelectItem value="start-frame-only">Reuse the first image for every prompt</SelectItem>
                </SelectContent>
              </Select>
              <p className="field-hint">Use the first option to keep one opening frame across the batch. Use the second for one-to-one prompt and image pairing.</p>
            </label>
          </div>

          <div className="settings-group">
            <p className="settings-group-title">Timing</p>
            <div className="settings-group-grid cols-3">
              <label className="field-stack">
                <span className="field-label">Delay min (s)</span>
                <Input
                  min={0}
                  type="number"
                  value={settingsDraft.delayRange.minSeconds}
                  onChange={(event) => setSettingsDraft({ ...settingsDraft, delayRange: { ...settingsDraft.delayRange, minSeconds: Number(event.target.value) } })}
                />
              </label>
              <label className="field-stack">
                <span className="field-label">Delay max (s)</span>
                <Input
                  min={settingsDraft.delayRange.minSeconds}
                  type="number"
                  value={settingsDraft.delayRange.maxSeconds}
                  onChange={(event) => setSettingsDraft({ ...settingsDraft, delayRange: { ...settingsDraft.delayRange, maxSeconds: Number(event.target.value) } })}
                />
              </label>
              <label className="field-stack">
                <span className="field-label">Max retries</span>
                <Input
                  min={1}
                  type="number"
                  value={settingsDraft.maxRetries}
                  onChange={(event) => setSettingsDraft({ ...settingsDraft, maxRetries: Number(event.target.value) })}
                />
              </label>
            </div>
          </div>

          <div className="settings-group">
            <p className="settings-group-title">Output</p>
            <label className="field-stack">
              <span className="field-label">Default folder name</span>
              <Input
                value={settingsDraft.outputFolder}
                onChange={(event) => applyOutputFolder(event.target.value)}
              />
            </label>
            <label className="toggle-row">
              <input
                checked={settingsDraft.autoRename}
                type="checkbox"
                onChange={(event) =>
                  setSettingsDraft({
                    ...settingsDraft,
                    autoRename: event.target.checked,
                  })
                }
              />
              <div>
                <strong>Auto rename downloaded files</strong>
                <p className="muted">Keeps the eventual downloads pipeline deterministic.</p>
              </div>
            </label>
          </div>

          <div className="button-row">
            <Button disabled={isBusy} onClick={() => void saveSettings()}>
              {isBusy ? 'Saving...' : 'Save settings'}
            </Button>
          </div>
        </section>
      ) : null}

      {tab === 'logs' ? (
        <section className="surface section-stack">
          <div className="section-heading">
            <h2>Debug logs</h2>
            <Button variant="outline" size="sm" onClick={() => void wipeLogs()}>Clear logs</Button>
          </div>

          {state?.logs.length ? (
            <ul className="log-list">
              {state.logs.map((entry) => (
                <li key={entry.id} className={`log-entry ${entry.level}`}>
                  <div className="log-meta">
                    <strong>{entry.level}</strong>
                    <span>{new Date(entry.createdAt).toLocaleTimeString()}</span>
                  </div>
                  <p>{entry.message}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted empty-copy">No logs yet.</p>
          )}
        </section>
      ) : null}
      </div>{/* tab-content */}

      <footer className="status-bar">
        <AnimatePresence>
          {notice ? (
            <motion.span
              key="notice"
              className={`notice-${noticeType}`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            >
              {notice}
            </motion.span>
          ) : null}
        </AnimatePresence>
      </footer>
    </Tabs>
    </main>
  );
}

async function serializeAllAttachmentsForQueue(
  attachments: (SelectedAttachment | null)[],
): Promise<(ImageAttachmentMeta | null)[]> {
  // Serialize only non-null slots; reconstruct the full nullable array after.
  const entries = attachments
    .map((a, i) => (a ? { i, input: toVaultAttachmentInput(a) } : null))
    .filter((e): e is { i: number; input: AttachmentAssetInput } => e !== null);

  if (!entries.length) return attachments.map(() => null);

  const serialized = await storeAttachmentPayloads(entries.map((e) => e.input));

  const result: (ImageAttachmentMeta | null)[] = attachments.map(() => null);
  entries.forEach(({ i }, si) => {
    result[i] = serialized[si] ?? null;
  });
  return result;
}

function toVaultAttachmentInput(
  attachment: SelectedAttachment,
): AttachmentAssetInput {
  const asset: AttachmentAssetInput = {
    assetId: crypto.randomUUID(),
    name: attachment.file.name,
    size: attachment.file.size,
    type: attachment.file.type,
    fileBlob: attachment.file,
  };

  if (attachment.fileHandle) {
    asset.fileHandle = attachment.fileHandle;
    delete asset.fileBlob;
  }

  return asset;
}

function supportsFileHandlePicker(): boolean {
  return typeof (window as FilePickerWindow).showOpenFilePicker === 'function';
}

function supportsDirectoryPicker(): boolean {
  return typeof (window as FilePickerWindow).showDirectoryPicker === 'function';
}

async function pickAttachmentsFromFileSystem(): Promise<SelectedAttachment[]> {
  const picker = (window as FilePickerWindow).showOpenFilePicker;

  if (!picker) {
    return [];
  }

  const handles = await picker({
    multiple: true,
    id: 'importImage',
    startIn: 'pictures',
    types: [
      {
        description: 'Images',
        accept: {
          'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp'],
        },
      },
    ],
  });

  const selected = await Promise.all(
    handles.map(async (fileHandle) => ({
      file: await fileHandle.getFile(),
      fileHandle,
    })),
  );

  return filterImageAttachments(selected);
}

async function getDroppedAttachments(
  dataTransfer: DataTransfer,
): Promise<SelectedAttachment[]> {
  const selected = await Promise.all(
    Array.from(dataTransfer.items)
      .filter((item) => item.kind === 'file')
      .map(readDroppedAttachment),
  );

  const dropped = selected.filter(
    (attachment): attachment is SelectedAttachment => attachment !== null,
  );

  if (dropped.length) {
    return filterImageAttachments(dropped);
  }

  return filterImageAttachments(
    Array.from(dataTransfer.files).map((file) => ({ file })),
  );
}

async function readDroppedAttachment(
  item: DataTransferItem,
): Promise<SelectedAttachment | null> {
  const fileHandle = await getDroppedFileHandle(item);
  if (fileHandle) {
    return {
      file: await fileHandle.getFile(),
      fileHandle,
    };
  }

  const file = item.getAsFile();
  return file ? { file } : null;
}

async function getDroppedFileHandle(
  item: DataTransferItem,
): Promise<ReadableFileHandle | undefined> {
  const getAsFileSystemHandle =
    (item as DataTransferItemWithFileHandle).getAsFileSystemHandle;

  if (typeof getAsFileSystemHandle !== 'function') {
    return undefined;
  }

  try {
    const handle = await getAsFileSystemHandle.call(item);
    return handle?.kind === 'file' ? handle : undefined;
  } catch {
    return undefined;
  }
}

function filterImageAttachments(
  attachments: SelectedAttachment[],
): SelectedAttachment[] {
  return attachments.filter((attachment) =>
    attachment.file.type.startsWith('image/'),
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export default App;