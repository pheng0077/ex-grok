import { type DragEvent as ReactDragEvent, useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
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
  openOptionsPage,
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
  // dragInsertAt tracks where the insertion line should appear during reorder
  const [dragInsertAt, setDragInsertAt] = useState<{ idx: number; side: 'before' | 'after' } | null>(null);
  const [dragOverEmpty, setDragOverEmpty] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragSrcIdx = useRef<number | null>(null);

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
    }
  }

  async function runBatch() {
    const prompts = parsePromptGroups(promptText);

    if (!prompts.length) {
      setNotice('Add at least one prompt group separated by a blank line.');
      return;
    }

    if (mode === 'frame-to-video' && !attachments.some((a) => a !== null)) {
      setNotice('Frame-to-video mode requires at least one image.');
      return;
    }

    // In pair-each-image mode, block if any prompt slot has no image.
    const imageMode = settingsDraft?.imageProcessingMode ?? 'start-frame-only';
    if (mode === 'frame-to-video' && imageMode === 'pair-each-image') {
      const missingSlots = prompts
        .map((_, i) => (attachments[i] == null ? i + 1 : null))
        .filter((n): n is number => n !== null);
      if (missingSlots.length > 0) {
        setNotice(
          `⚠ ${missingSlots.length} prompt${missingSlots.length === 1 ? '' : 's'} ${missingSlots.length === 1 ? 'has' : 'have'} no image assigned (slot${missingSlots.length === 1 ? '' : 's'} ${missingSlots.join(', ')}). Fill the empty slot${missingSlots.length === 1 ? '' : 's'} or switch to “Use start frame only”.`,
        );
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
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'Failed to queue the current prompts.',
      );
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
    } finally {
      setIsBusy(false);
    }
  }

  async function wipeQueue() {
    const nextState = await clearQueue();
    setState(nextState);
    setNotice('Queue cleared.');
  }

  async function stopQueue() {
    try {
      const nextState = await forceStopQueue();
      setState(nextState);
      setNotice('Queue stopped.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Stop failed.');
    }
  }

  async function handleStartQueue() {
    try {
      const nextState = await startQueue();
      setState(nextState);
      setNotice('Queue started.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Start failed.');
    }
  }

  async function handleRetry(jobId: string) {
    try {
      const nextState = await retryJob(jobId);
      setState(nextState);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Retry failed.');
    }
  }

  async function handleRerun(jobId: string) {
    try {
      const nextState = await rerunJob(jobId);
      setState(nextState);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Re-run failed.');
    }
  }

  async function wipeLogs() {
    const nextState = await clearLogs();
    setState(nextState);
    setNotice('Logs cleared.');
  }

  const parsedPrompts = parsePromptGroups(promptText);
  const imageMode = settingsDraft?.imageProcessingMode ?? 'start-frame-only';
  const queue = state?.queue ?? [];
  const queuedJobs = queue.filter((job) => job.status === 'queued').length;
  const completedJobs = queue.filter(
    (job) => job.status === 'downloaded',
  ).length;

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
        <span className="masthead-title">Ex Grok</span>
        <div className="masthead-actions">
          <Button size="sm" variant="ghost" onClick={() => void refresh()}>Refresh</Button>
          <Button size="sm" variant="secondary" onClick={() => void openOptionsPage()}>Settings</Button>
        </div>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as PanelTab)} className="tab-root">
        <TabsList className="tab-list">
          <TabsTrigger value="control">Control</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="logs">Debug Logs</TabsTrigger>
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
                  variant={mode === 'text-to-video' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setMode('text-to-video')}
                >
                  Text to video
                </Button>
                <Button
                  variant={mode === 'frame-to-video' ? 'default' : 'outline'}
                  size="sm"
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
                      <Button variant="ghost" size="sm" onClick={() => setAttachments([])}>Clear all</Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => void browseForAttachments()}>Browse</Button>
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
                  <Input
                    className="folder-inline"
                    placeholder="folder name"
                    value={folderName}
                    onChange={(e) => setFolderName(e.target.value)}
                  />
                  {promptText && (
                    <Button variant="ghost" size="sm" onClick={() => setPromptText('')}>Clear</Button>
                  )}
                  <span className="muted small-copy">Blank line = new prompt</span>
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
                <Button disabled={isBusy} onClick={() => void runBatch()}>
                  {isBusy ? 'Queueing...' : 'Add to Queue'}
                </Button>
              </div>
            </section>
          </div>

          <aside className="control-sidebar">
            <section className="surface section-stack">
              <div className="section-heading">
                <h2>Queue</h2>
                <Badge variant={state?.runState === 'running' ? 'default' : state?.runState === 'completed' ? 'secondary' : 'outline'} className={`state-badge state-${state?.runState ?? 'idle'}`}>{state?.runState ?? 'idle'}</Badge>
              </div>

              <div className="stats-row">
                <span><strong>{queuedJobs}</strong> queued</span>
                <span><strong>{completedJobs}</strong> done</span>
              </div>

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
                                {job.status === 'failed' ? (
                                  <Button variant="ghost" size="sm" className="tiny" onClick={() => void handleRetry(job.id)}>Retry</Button>
                                ) : null}
                                <Button variant="ghost" size="sm" className="tiny" onClick={() => void handleRerun(job.id)}>Re-run</Button>
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
                  <Button size="sm" onClick={() => void handleStartQueue()}>Start Queue</Button>
                ) : null}
                {state?.runState === 'running' ? (
                  <Button size="sm" variant="secondary" onClick={() => void stopQueue()}>Stop All</Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => void wipeQueue()}>Clear</Button>
              </div>
            </section>
          </aside>
        </section>
      ) : null}

      {tab === 'settings' && settingsDraft ? (
        <section className="surface settings-grid">
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
                <SelectItem value="10s">10 seconds</SelectItem>
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
                <SelectItem value="720p">720p</SelectItem>
              </SelectContent>
            </Select>
          </label>

          <label className="field-stack">
            <span className="field-label">Image processing mode</span>
            <Select
              value={settingsDraft.imageProcessingMode}
              onValueChange={(v) => setSettingsDraft({ ...settingsDraft, imageProcessingMode: v as AutomationSettings['imageProcessingMode'] })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="start-frame-only">Use start frame only</SelectItem>
                <SelectItem value="pair-each-image">Pair each image with every prompt</SelectItem>
              </SelectContent>
            </Select>
          </label>

          <label className="field-stack">
            <span className="field-label">Retry count</span>
            <Input
              min={1}
              type="number"
              value={settingsDraft.maxRetries}
              onChange={(event) => setSettingsDraft({ ...settingsDraft, maxRetries: Number(event.target.value) })}
            />
          </label>

          <label className="field-stack">
            <span className="field-label">Delay min (seconds)</span>
            <Input
              min={0}
              type="number"
              value={settingsDraft.delayRange.minSeconds}
              onChange={(event) => setSettingsDraft({ ...settingsDraft, delayRange: { ...settingsDraft.delayRange, minSeconds: Number(event.target.value) } })}
            />
          </label>

          <label className="field-stack">
            <span className="field-label">Delay max (seconds)</span>
            <Input
              min={settingsDraft.delayRange.minSeconds}
              type="number"
              value={settingsDraft.delayRange.maxSeconds}
              onChange={(event) => setSettingsDraft({ ...settingsDraft, delayRange: { ...settingsDraft.delayRange, maxSeconds: Number(event.target.value) } })}
            />
          </label>

          <label className="field-stack settings-span">
            <span className="field-label">Default folder name</span>
            <Input
              value={settingsDraft.outputFolder}
              onChange={(event) => setSettingsDraft({ ...settingsDraft, outputFolder: event.target.value })}
            />
          </label>

          <label className="toggle-row settings-span">
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

          <div className="button-row settings-span">
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
            <Button variant="ghost" size="sm" onClick={() => void wipeLogs()}>Clear logs</Button>
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