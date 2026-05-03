import type {
  AutomationExecuteMessage,
  AutomationReply,
  AutomationSettings,
  ImageAttachmentMeta,
  QueueJob,
} from '@/lib/contracts';

// grok.com/imagine uses a <div contenteditable="true"> (TipTap/ProseMirror).
const PROMPT_INPUT_SELECTORS = [
  // grok.com/imagine: TipTap editor div (confirmed by DOM inspection)
  'div.ProseMirror[contenteditable="true"]',
  'div[contenteditable="true"]',
  '[contenteditable="true"]',
  // Fallbacks for other grok pages
  'textarea',
];
const FILE_INPUT_SELECTORS = [
  'input[type="file"][accept*="image"]',
  'input[type="file"]',
];
// grok.com/imagine uses button text "Upload" for the attachment trigger
const UPLOAD_TRIGGER_PATTERN = /^(\+|upload|attach|add)$/i;
// grok.com/imagine submit button has aria-label or text "Submit"
const SUBMIT_BUTTON_PATTERN = /^\s*submit\s*$/i;
const GENERATE_LABEL = /(submit|generate|create|run|imagine|send)/i;
const GENERATE_ARIA = /(submit|generate|create|run|imagine|send)/i;
const DOWNLOAD_LABEL = /(download|save)/i;
const DOWNLOAD_ARIA = /(download|save)/i;
// grok.com uses a radiogroup "Generation mode" with radio "Image" / "Video"
const VIDEO_MODE_LABEL = /^\s*video\s*$/i;
const IMAGE_MODE_LABEL = /^\s*image\s*$/i;
// Toolbar toggle buttons — grok.com uses aria-checked="true"/"false"
const RESOLUTION_480P_TEXT = /^\s*480p\s*$/i;
const RESOLUTION_720P_TEXT = /^\s*720p\s*$/i;
const DURATION_6S_TEXT = /^\s*6s\s*$/i;
const DURATION_10S_TEXT = /^\s*10s\s*$/i;
// Aspect ratio dropdown — aria-label="Aspect Ratio", Radix menu with role="menuitem"
const ASPECT_RATIO_TRIGGER_LABEL = /aspect.?ratio/i;
const WAIT_FOR_DOWNLOAD_CONTROL_MS = 6 * 60 * 1000;
// Minimum ms to wait after clicking generate before polling for download control
const MIN_GENERATION_WAIT_MS = 3000;
// How long to poll for the Submit button to become enabled after filling the prompt.
// 20 s covers very slow (2G/3G) TipTap React state propagation.
const SUBMIT_ENABLE_WAIT_MS = 20000;
// Initial settle after dispatching file change events so Grok starts processing
const POST_UPLOAD_SETTLE_MS = 1200;
// Max time to wait for Submit to go *disabled* after upload (confirms processing started)
const UPLOAD_DISABLE_WAIT_MS = 10000;
// Upload processing can keep Submit disabled for up to 1 minute for large images.
const SUBMIT_AFTER_UPLOAD_WAIT_MS = 60000;
// How long to wait for the submit interaction to register (slow networks need more time).
const SUBMIT_START_WAIT_MS = 5000;
const RESULT_READY_PROGRESS = 95;
const CLICK_PRE_DELAY_MS = 180;
const CLICK_POST_DELAY_MS = 320;
// How long to wait for the page prompt input to appear.
// 60 s covers a full 2G page load from cold cache.
const PAGE_READY_MS = 60000;
// How long to wait for toolbar buttons (480p/720p/6s/10s) to appear after mode change.
const TOOLBAR_APPEAR_MS = 10000;
// How long to wait for a dropdown menu to open after clicking its trigger.
const DROPDOWN_OPEN_MS = 6000;
// How long to wait for the file input to mount after clicking the upload trigger.
const FILE_INPUT_APPEAR_MS = 6000;
// How long to wait for network to come back after going offline.
// 2 minutes gives the user a chance to reconnect Wi-Fi / switch cells without losing the job.
const NETWORK_RECONNECT_WAIT_MS = 120000;

type PromptTarget = HTMLTextAreaElement | HTMLInputElement | HTMLElement;

export async function runGrokAutomation(
  message: AutomationExecuteMessage,
  isAborted: () => boolean = () => false,
): Promise<AutomationReply> {
  const { job, settings } = message.payload;

  if (!window.location.href.includes('grok.com')) {
    return fail(
      'This tab is not on grok.com. Open https://grok.com/imagine and try again.',
      false,
    );
  }

  // Preflight: wait for network connectivity before touching the DOM.
  // On 2G/3G or after a connection change the browser may be momentarily
  // offline. Give it up to NETWORK_RECONNECT_WAIT_MS to come back.
  if (!navigator.onLine) {
    const reconnected = await waitForNetwork(NETWORK_RECONNECT_WAIT_MS);
    if (!reconnected) {
      return fail(
        'No network connection. Please check your internet and try again.',
        true,
      );
    }
  }

  // Wait for the prompt input to be ready — the page may still be loading
  // (especially on a slow network) when the user triggers automation.
  const promptTarget = await waitForCondition(
    () => findPromptTarget(document),
    PAGE_READY_MS,
  );
  if (!promptTarget) {
    return fail(
      'No prompt input was found. Navigate to https://grok.com/imagine and make sure you are signed in.',
    );
  }

  try {
    // Select video or image mode before filling the prompt.
    const modeResult = await selectGenerationMode(document, job.mode, promptTarget);
    if (!modeResult.ok) {
      return modeResult;
    }

    // Scope the composer root for toolbar selectors.
    // Note: on grok.com/imagine the toolbar buttons (Image/Video/480p/etc.) live in a
    // wider query-bar container that is an ancestor of the text input, not a descendant.
    // We always search from document.body for toolbar toggles so the selector works
    // regardless of how tightly findComposerRoot scoped the text input wrapper.
    const toolbarRoot: Element = document.body ?? document.documentElement;
    const wantsVideoMode = job.mode === 'text-to-video' || job.mode === 'frame-to-video';

    if (wantsVideoMode) {
      // Resolution
      const quality = job.imageQuality ?? settings.imageQuality;
      const resResult = await selectToolbarToggle(toolbarRoot, quality === '480p' ? RESOLUTION_480P_TEXT : RESOLUTION_720P_TEXT, quality);
      if (!resResult.ok) {
        void reportWarn(resResult.error);
      }

      // Duration
      const duration = job.videoDuration ?? settings.videoDuration;
      const durResult = await selectToolbarToggle(toolbarRoot, duration === '6s' ? DURATION_6S_TEXT : DURATION_10S_TEXT, duration);
      if (!durResult.ok) {
        void reportWarn(durResult.error);
      }

      // Aspect ratio
      const arResult = await selectAspectRatio(toolbarRoot, settings.aspectRatio);
      if (!arResult.ok) {
        void reportWarn(arResult.error);
      }
    }

    await fillPromptTarget(promptTarget, job.prompt);
    // Poll until the Submit button becomes enabled (TipTap updates asynchronously
    // after the beforeinput event is processed).
    let generateControl = await waitForSubmitEnabled(document, SUBMIT_ENABLE_WAIT_MS);
    if (!generateControl) {
      return fail(
        'Submit button did not become enabled after filling the prompt. The page UI may have changed.',
      );
    }

    if (job.mode === 'frame-to-video') {
      const uploadResult = await uploadAttachments(document, job);
      if (!uploadResult.ok) {
        return uploadResult;
      }
      // Wait for Grok to register the upload and disable Submit during processing.
      // Without this, the re-enable poll below finds Submit still enabled from the
      // prompt-fill step and fires submit before the image is processed.
      await waitForSubmitDisabled(document, UPLOAD_DISABLE_WAIT_MS);
      // Wait up to 1 minute for Submit to re-enable — image processing can be slow.
      // If it never re-enables, bail out rather than submitting before upload completes.
      const uploadedControl = await waitForSubmitEnabled(document, SUBMIT_AFTER_UPLOAD_WAIT_MS);
      if (!uploadedControl) {
        return fail(
          'Submit button did not re-enable after image upload. The image may still be processing or the upload failed. Please try again.',
          false,
        );
      }
      generateControl = uploadedControl;
    }

    const baselineResults = capturePromptResultSnapshot(document, job.prompt);
    const submitted = await submitGeneration(promptTarget, job.prompt, generateControl);
    if (!submitted) {
      return fail(
        'Submit button was found, but generation did not start. Grok may still be processing the upload or the submit interaction changed.',
        false,
      );
    }

    // Check abort after submit (user may have clicked Force Stop or Re-run).
    if (isAborted()) {
      return fail('Automation aborted by user.', false);
    }

    await reportProgress(job.id, 0);

    // Poll for progress while generation is in-flight.
    const abortProgress = { aborted: false };
    void pollProgressDuringGeneration(job.id, abortProgress);

    // Brief wait before polling so the page has time to react.
    await delay(MIN_GENERATION_WAIT_MS);

    // Check abort again after the initial wait.
    if (isAborted()) {
      abortProgress.aborted = true;
      return fail('Automation aborted by user.', false);
    }

    let downloadControl: HTMLElement;
    try {
      downloadControl = await waitForDownloadControl(
        job.prompt,
        baselineResults,
        WAIT_FOR_DOWNLOAD_CONTROL_MS - MIN_GENERATION_WAIT_MS,
        isAborted,
      );
      await reportProgress(job.id, RESULT_READY_PROGRESS);
    } finally {
      abortProgress.aborted = true;
    }

    if (isAborted()) {
      return fail('Automation aborted by user.', false);
    }

    await clickControl(downloadControl);
    void reportProgress(job.id, 100);

    return {
      ok: true,
      detail: 'Submitted the prompt and clicked the download control.',
    };
  } catch (error) {
    return fail(
      error instanceof Error ? error.message : 'Unknown Grok automation error.',
    );
  }
}

/**
 * Select a toolbar toggle button (resolution 480p/720p, duration 6s/10s) by
 * matching text against a pattern. Active state is detected via aria-checked.
 * Polls for the button to appear so slow-network React re-renders are tolerated.
 * Non-fatal — returns ok:false with an error message so the caller can warn.
 */
async function selectToolbarToggle(
  root: Element,
  labelPattern: RegExp,
  friendlyName: string,
): Promise<AutomationReply> {
  // Poll until the button appears — it may not have rendered yet if mode
  // selection is still propagating through React on a slow network.
  const target = await waitForCondition(
    () => {
      const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button'));
      return buttons.find((b) => {
        if (!isVisible(b)) return false;
        const text = (b.textContent ?? '').replace(/\s+/g, ' ').trim();
        return labelPattern.test(text);
      }) ?? null;
    },
    TOOLBAR_APPEAR_MS,
    100,
  );

  if (!target) {
    return fail(`Toolbar button "${friendlyName}" was not found in the composer.`, false);
  }

  const alreadyActive = target.getAttribute('aria-checked') === 'true';
  if (alreadyActive) {
    return { ok: true, detail: `${friendlyName} already active.` };
  }

  await clickControl(target);
  // Brief settle so the aria-checked state updates before the next toolbar step.
  await delay(400);
  return { ok: true, detail: `${friendlyName} selected.` };
}

/**
 * Select the aspect ratio via the Radix dropdown trigger (aria-label="Aspect Ratio").
 * Clicks the trigger, waits for the menu to open, then clicks the matching menuitem.
 * The target ratio string (e.g. "16:9") is matched as a prefix inside the item text
 * (e.g. "16:9 Widescreen").
 */
async function selectAspectRatio(
  root: Element,
  targetRatio: string,
): Promise<AutomationReply> {
  // Find the aspect ratio trigger button
  const allButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('button'));
  const trigger = allButtons.find((b) => {
    if (!isVisible(b)) return false;
    const ariaLabel = b.getAttribute('aria-label') ?? '';
    const text = (b.textContent ?? '').replace(/\s+/g, ' ').trim();
    return (
      ASPECT_RATIO_TRIGGER_LABEL.test(ariaLabel) ||
      ASPECT_RATIO_TRIGGER_LABEL.test(text)
    );
  });

  if (!trigger) {
    return fail(`Aspect ratio button was not found in the composer.`, false);
  }

  // Check if already showing the desired ratio (button text starts with the ratio)
  const currentText = (trigger.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (currentText.startsWith(targetRatio)) {
    return { ok: true, detail: `Aspect ratio ${targetRatio} already selected.` };
  }

  // Click to open the dropdown
  await clickControl(trigger);

  // Poll for the menu to open — on slow networks the Radix animation/state
  // update may take longer than a flat delay would cover.
  const menu = await waitForCondition(
    () => document.querySelector('[role="menu"][data-state="open"], [role="listbox"][data-state="open"]'),
    DROPDOWN_OPEN_MS,
    100,
  );

  if (!menu) {
    // Fallback: try pressing Escape and try direct toggle approach
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return fail(`Aspect ratio dropdown did not open. The "${targetRatio}" ratio may not be available.`, false);
  }

  const items = Array.from(menu.querySelectorAll('[role="menuitem"], [role="option"]'));
  const targetItem = items.find((item) => {
    const text = (item.textContent ?? '').replace(/\s+/g, ' ').trim();
    return text.startsWith(targetRatio);
  }) as HTMLElement | undefined;

  if (!targetItem) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return fail(`Aspect ratio option "${targetRatio}" was not found in the dropdown.`, false);
  }

  await clickControl(targetItem);
  await delay(250);
  return { ok: true, detail: `Aspect ratio ${targetRatio} selected.` };
}

async function reportWarn(message: string): Promise<void> {
  // Non-fatal selector warning — logged locally so the job can continue.
  console.warn('[ex-grok]', message);
}

async function selectGenerationMode(
  doc: Document,
  mode: QueueJob['mode'],
  promptTarget: PromptTarget,
): Promise<AutomationReply> {
  // Scope the mode button search to the composer root so template cards
  // elsewhere on the page (e.g. "Video Game") are never matched.
  const composerRoot = findComposerRoot(promptTarget);
  const searchRoot: Element = composerRoot ?? doc.body ?? doc.documentElement;
  const wantsVideoMode = mode === 'text-to-video' || mode === 'frame-to-video';
  const targetLabel = wantsVideoMode ? VIDEO_MODE_LABEL : IMAGE_MODE_LABEL;
  const targetModeName = wantsVideoMode ? 'Video' : 'Image';

  // grok.com uses a radiogroup "Generation mode" with radio inputs.
  // First try radio buttons (the real grok.com/imagine pattern).
  // Try scoped search first, then fall back to doc.body because on grok.com/imagine
  // the Image/Video buttons live in a wider query-bar container that is an ancestor
  // of the text input, so the scoped composerRoot search misses them.
  const modeRadio =
    findRadioInput(searchRoot, targetLabel) ??
    findRadioInput(doc.body ?? doc.documentElement, targetLabel);

  if (modeRadio) {
    const alreadyChecked =
      modeRadio instanceof HTMLInputElement
        ? modeRadio.checked
        : modeRadio.getAttribute('aria-checked') === 'true';

    if (!alreadyChecked) {
      await clickControl(modeRadio);
      // Wait for React to re-render the toolbar after mode change.
      await delay(500);
    }
    return { ok: true, detail: `${targetModeName} mode selected via radio input.` };
  }

  // Fallback: look for a toggle button inside the composer root, then the full document.
  const modeButton =
    findModeButtonIn(searchRoot, targetLabel) ??
    findModeButtonIn(doc.body ?? doc.documentElement, targetLabel);

  if (!modeButton) {
    return fail(`${targetModeName} mode selector was not found in the composer.`, false);
  }

  const alreadyActive =
    modeButton.getAttribute('aria-checked') === 'true' ||
    modeButton.getAttribute('aria-pressed') === 'true' ||
    modeButton.getAttribute('aria-selected') === 'true' ||
    modeButton.classList.contains('active') ||
    modeButton.classList.contains('selected');

  if (!alreadyActive) {
    await clickControl(modeButton);
    // Wait for React to re-render the toolbar after mode change.
    await delay(500);
  }

  return { ok: true, detail: `${targetModeName} mode selected.` };
}

/**
 * Find a radio input for mode selection (grok.com/imagine uses a radiogroup).
 */
function findRadioInput(
  root: Element | Document,
  labelPattern: RegExp,
): HTMLElement | null {
  // Real radio inputs inside the radiogroup
  const radios = Array.from(
    root.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
  );
  for (const radio of radios) {
    if (!isVisible(radio)) continue;
    // Check the label associated with the radio
    const label = radio.closest('label') ??
      (radio.id ? root.querySelector(`label[for="${radio.id}"]`) : null);
    const text = (label?.textContent ?? radio.getAttribute('aria-label') ?? radio.value ?? '').trim();
    if (labelPattern.test(text)) return radio;
  }

  // [role="radio"] elements (custom radio UI)
  const roleRadios = Array.from(
    root.querySelectorAll<HTMLElement>('[role="radio"]'),
  );
  for (const radio of roleRadios) {
    if (!isVisible(radio)) continue;
    const text = (radio.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (labelPattern.test(text)) return radio;
  }

  return null;
}

/**
 * Find a mode toggle button (Image / Video) within the given root element.
 * Used as fallback when radio inputs are not present.
 */
function findModeButtonIn(
  root: Element,
  labelPattern: RegExp,
): HTMLElement | null {
  const controls = Array.from(
    root.querySelectorAll('button, [role="button"], [role="tab"]'),
  );

  for (const control of controls) {
    if (!(control instanceof HTMLElement) || !isVisible(control)) {
      continue;
    }

    // Trim and normalise whitespace so multi-line React text nodes collapse.
    const text = (control.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (labelPattern.test(text)) {
      return control;
    }
  }

  return null;
}

function findPromptTarget(doc: Document): PromptTarget | null {
  for (const selector of PROMPT_INPUT_SELECTORS) {
    const candidates = Array.from(doc.querySelectorAll(selector));
    const visible = candidates.find((element) => isVisible(element));
    if (!visible) {
      continue;
    }

    if (
      visible instanceof HTMLTextAreaElement ||
      visible instanceof HTMLInputElement
    ) {
      return visible;
    }

    if (visible instanceof HTMLElement) {
      return visible;
    }
  }

  return null;
}

function findGenerateControl(
  doc: Document,
  promptTarget: PromptTarget,
): HTMLElement | null {
  // grok.com/imagine: the submit button has text/aria-label "Submit" and is
  // disabled when the textarea is empty. Look for it by name first — scoped
  // to anywhere in the document since it's a known unique button.
  const allButtons = Array.from(doc.querySelectorAll<HTMLButtonElement>('button'));

  // First: enabled Submit button (becomes enabled once text is entered)
  for (const button of allButtons) {
    if (!isVisible(button)) continue;
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') continue;
    const text = (button.textContent ?? '').replace(/\s+/g, ' ').trim();
    const ariaLabel = button.getAttribute('aria-label') ?? '';
    if (SUBMIT_BUTTON_PATTERN.test(text) || SUBMIT_BUTTON_PATTERN.test(ariaLabel)) {
      return button;
    }
  }

  // Second: any button[type="submit"] in the composer
  const composerRoot = findComposerRoot(promptTarget);
  const searchRoot: Element = composerRoot ?? doc.body ?? doc.documentElement;
  const submitButtons = Array.from(
    searchRoot.querySelectorAll<HTMLButtonElement>('button[type="submit"]'),
  );
  for (const button of submitButtons) {
    if (isVisible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true') {
      return button;
    }
  }

  // Third: broader text/aria match scoped to composer
  const byLabel = findMatchingControlIn(searchRoot, GENERATE_LABEL, GENERATE_ARIA);
  if (byLabel) return byLabel;

  // Last resort: full document
  return findMatchingControl(doc, GENERATE_LABEL, GENERATE_ARIA);
}

/**
 * Walk up from the prompt input to find a "composer" ancestor — a container
 * that groups the input with mode buttons and the submit control.  We stop at
 * the first ancestor that also contains a visible button (i.e. the send arrow).
 */
function findComposerRoot(promptTarget: PromptTarget): Element | null {
  let node: Element | null =
    promptTarget instanceof HTMLElement ? promptTarget : null;

  while (node && node !== document.body) {
    const parent = node.parentElement;
    if (!parent) {
      break;
    }

    // If this ancestor contains a visible button sibling to the prompt,
    // it is the composer wrapper we want.
    const buttons = Array.from(
      parent.querySelectorAll<HTMLButtonElement>('button'),
    ).filter((b) => isVisible(b));

    if (buttons.length > 0) {
      return parent;
    }

    node = parent;
  }

  return null;
}

function findDownloadControl(doc: Document): HTMLElement | null {
  return findDownloadControls(doc)[0] ?? null;
}

function findDownloadControls(root: Document | Element): HTMLElement[] {
  const controls: HTMLElement[] = [];

  // First pass: text/aria-label match.
  const byLabel = Array.from(
    root.querySelectorAll<HTMLElement>('button, a, [role="button"]'),
  ).filter((control) => {
    if (!isVisible(control)) {
      return false;
    }

    if (
      control instanceof HTMLButtonElement &&
      (control.disabled || control.getAttribute('aria-disabled') === 'true')
    ) {
      return false;
    }

    const text = (control.textContent ?? '').trim();
    const ariaLabel = control.getAttribute('aria-label') ?? '';
    const title = control.getAttribute('title') ?? '';
    return (
      DOWNLOAD_LABEL.test(text) ||
      DOWNLOAD_ARIA.test(ariaLabel) ||
      DOWNLOAD_ARIA.test(title)
    );
  });

  controls.push(...byLabel);

  const seen = new Set(controls.map((control) => controlSignature(control)));

  // Second pass: anchor with a download attribute or video file href.
  const anchors = Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'));

  for (const anchor of anchors) {
    if (!isVisible(anchor)) {
      continue;
    }

    if (
      anchor.hasAttribute('download') ||
      /\.mp4(\?|$)/i.test(anchor.href) ||
      /\.webm(\?|$)/i.test(anchor.href)
    ) {
      const signature = controlSignature(anchor);
      if (!seen.has(signature)) {
        controls.push(anchor);
        seen.add(signature);
      }
    }
  }

  return controls;
}

function findMatchingControlIn(
  root: Element,
  textPattern: RegExp,
  ariaPattern: RegExp,
): HTMLElement | null {
  const controls = Array.from(root.querySelectorAll('button, a, [role="button"]'));

  for (const control of controls) {
    if (!(control instanceof HTMLElement) || !isVisible(control)) {
      continue;
    }

    if (
      control instanceof HTMLButtonElement &&
      (control.disabled || control.getAttribute('aria-disabled') === 'true')
    ) {
      continue;
    }

    const text = (control.textContent ?? '').trim();
    const ariaLabel = control.getAttribute('aria-label') ?? '';
    const title = control.getAttribute('title') ?? '';

    if (
      textPattern.test(text) ||
      ariaPattern.test(ariaLabel) ||
      ariaPattern.test(title)
    ) {
      return control;
    }
  }

  return null;
}

function findMatchingControl(
  doc: Document,
  textPattern: RegExp,
  ariaPattern: RegExp,
): HTMLElement | null {
  return findMatchingControlIn(doc.body ?? doc.documentElement, textPattern, ariaPattern);
}

async function fillPromptTarget(target: PromptTarget, prompt: string): Promise<void> {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    target.focus();
    setNativeInputValue(target, prompt);
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  // TipTap/ProseMirror contenteditable (grok.com/imagine).
  // document.execCommand does not fire the events ProseMirror intercepts in
  // an MV3 isolated-world content script. Instead we dispatch the DOM events
  // that ProseMirror's event handlers are actually registered on.
  //
  // focus() must settle before we dispatch beforeinput/paste — without the
  // microtask delay the browser's active-element may still point elsewhere and
  // TipTap's key-event guards will ignore the synthetic events.
  target.focus();
  await delay(80);

  // Select all existing content so 'insertText' replaces rather than appends.
  const sel = window.getSelection();
  if (sel) {
    const range = document.createRange();
    range.selectNodeContents(target);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // Primary: beforeinput with inputType='insertText'.
  // ProseMirror intercepts this event, calls preventDefault(), runs its
  // transaction, and updates its internal state (which enables the Submit
  // button). The event object is shared across isolated worlds so
  // defaultPrevented reflects whether ProseMirror actually handled it.
  const ev = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: prompt,
  });
  target.dispatchEvent(ev);

  // Fallback: ClipboardEvent paste — TipTap also handles 'paste' and reads
  // text/plain from event.clipboardData. Used when beforeinput wasn't handled
  // (e.g. a custom build without beforeinput support).
  if (!ev.defaultPrevented || !(target.textContent ?? '').includes(prompt.slice(0, 20))) {
    const dt = new DataTransfer();
    dt.setData('text/plain', prompt);
    target.dispatchEvent(
      new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      }),
    );
  }
}

/**
 * Poll until the Submit button is enabled (TipTap enables it once the editor
 * has content). Returns null on timeout.
 */
async function waitForSubmitEnabled(
  doc: Document,
  timeoutMs: number,
): Promise<HTMLElement | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const btn = findEnabledSubmit(doc);
    if (btn) return btn;
    await delay(150);
  }
  return null;
}

/**
 * Poll until the Submit button is disabled (or absent). Used after dispatching
 * file-upload events to confirm Grok has started processing the attachment and
 * has not yet re-enabled Submit. Resolves immediately if already disabled.
 */
async function waitForSubmitDisabled(
  doc: Document,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!findEnabledSubmit(doc)) return;
    await delay(150);
  }
}

function findEnabledSubmit(doc: Document): HTMLElement | null {
  for (const button of doc.querySelectorAll<HTMLButtonElement>('button')) {
    if (!isVisible(button)) continue;
    if (button.disabled || button.getAttribute('aria-disabled') === 'true') continue;
    const text = (button.textContent ?? '').replace(/\s+/g, ' ').trim();
    const aria = button.getAttribute('aria-label') ?? '';
    if (SUBMIT_BUTTON_PATTERN.test(text) || SUBMIT_BUTTON_PATTERN.test(aria)) {
      return button;
    }
  }
  return null;
}

async function submitGeneration(
  promptTarget: PromptTarget,
  prompt: string,
  initialControl: HTMLElement,
): Promise<boolean> {
  const initialTitle = document.title;

  await clickControl(initialControl);
  if (await waitForSubmissionStart(promptTarget, prompt, initialTitle)) {
    return true;
  }

  const refreshedControl = findEnabledSubmit(document);
  if (refreshedControl) {
    await clickControl(refreshedControl);
    if (await waitForSubmissionStart(promptTarget, prompt, initialTitle)) {
      return true;
    }
  }

  focusPromptTarget(promptTarget);
  dispatchEnter(promptTarget);
  return waitForSubmissionStart(promptTarget, prompt, initialTitle);
}

async function waitForSubmissionStart(
  promptTarget: PromptTarget,
  prompt: string,
  initialTitle: string,
): Promise<boolean> {
  const deadline = Date.now() + SUBMIT_START_WAIT_MS;
  while (Date.now() < deadline) {
    if (didSubmissionStart(promptTarget, prompt, initialTitle)) {
      return true;
    }
    await delay(100);
  }
  return didSubmissionStart(promptTarget, prompt, initialTitle);
}

function didSubmissionStart(
  promptTarget: PromptTarget,
  prompt: string,
  initialTitle: string,
): boolean {
  if (document.title !== initialTitle) {
    return true;
  }

  if (!findEnabledSubmit(document)) {
    return true;
  }

  return !promptTextMatches(promptTarget, prompt);
}

function promptTextMatches(target: PromptTarget, prompt: string): boolean {
  const currentText = getPromptText(target);
  return normalizeText(currentText) === normalizeText(prompt);
}

function getPromptText(target: PromptTarget): string {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    return target.value;
  }

  return target.textContent ?? '';
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function focusPromptTarget(target: PromptTarget): void {
  target.focus();

  if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
    const end = target.value.length;
    target.setSelectionRange(end, end);
    return;
  }

  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const range = document.createRange();
  range.selectNodeContents(target);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function dispatchEnter(target: PromptTarget): void {
  const eventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    which: 13,
  };

  target.dispatchEvent(new KeyboardEvent('keydown', eventInit));
  target.dispatchEvent(new KeyboardEvent('keypress', eventInit));
  target.dispatchEvent(new KeyboardEvent('keyup', eventInit));
}

/**
 * Poll for generation progress while waiting for the download control.
 * Sends progress messages to the background service worker as a side-channel.
 */
async function pollProgressDuringGeneration(
  jobId: string,
  abort: { aborted: boolean },
): Promise<void> {
  let lastProgress = -1;
  while (!abort.aborted) {
    await delay(2000);
    if (abort.aborted) break;
    const progress = detectGenerationProgress(document);
    if (progress !== null && progress !== lastProgress) {
      lastProgress = progress;
      void reportProgress(jobId, progress);
    }
  }
}

/**
 * Detect a percentage progress value from the page DOM.
 * 1. Span with "NN%" text (grok.com/imagine post page — span.tabular-nums.animate-pulse)
 * 2. ARIA progressbar aria-valuenow
 * 3. SVG circle stroke-dashoffset/stroke-dasharray
 * 4. Text scan inside class*="progress" / class*="generating" containers
 */
function detectGenerationProgress(doc: Document): number | null {
  // 1. Visible <span> (or any inline element) whose entire text is "NN%".
  //    grok.com renders: <span class="...tabular-nums animate-pulse">54%</span>
  const allSpans = Array.from(doc.querySelectorAll<HTMLElement>('span, b, strong, p'));
  for (const el of allSpans) {
    if (!isVisible(el)) continue;
    const text = (el.textContent ?? '').trim();
    const match = /^(\d{1,3})%$/.exec(text);
    if (match) {
      const n = Number(match[1]);
      if (!Number.isNaN(n) && n >= 0 && n <= 100) return n;
    }
  }

  // 2. ARIA progressbar (most reliable when present)
  const progressBar = doc.querySelector('[role="progressbar"]');
  if (progressBar) {
    const val = progressBar.getAttribute('aria-valuenow');
    if (val !== null && val !== '') {
      const n = Number(val);
      if (!Number.isNaN(n)) return n;
    }
  }

  // 3. SVG circular progress — compute from stroke-dashoffset / stroke-dasharray.
  //    formula: progress = (1 - dashoffset / dasharray) * 100
  const circle = doc.querySelector<SVGCircleElement>('circle[stroke-dasharray]');
  if (circle) {
    const dashoffset = parseFloat(circle.getAttribute('stroke-dashoffset') ?? '');
    const dasharray = parseFloat((circle.getAttribute('stroke-dasharray') ?? '').split(/[\s,]+/)[0]);
    if (!Number.isNaN(dashoffset) && !Number.isNaN(dasharray) && dasharray > 0) {
      const n = Math.round((1 - dashoffset / dasharray) * 100);
      if (n >= 0 && n <= 100) return n;
    }
  }

  // 4. Text scan inside progress/generating containers
  const candidates = Array.from(
    doc.querySelectorAll<HTMLElement>('[class*="progress" i], [class*="generating" i]'),
  );
  for (const el of candidates) {
    const match = /\b(\d{1,3})\s*%/.exec(el.textContent ?? '');
    if (match) {
      const n = Number(match[1]);
      if (!Number.isNaN(n) && n >= 0 && n <= 100) return n;
    }
  }

  return null;
}

async function reportProgress(jobId: string, progress: number): Promise<void> {
  try {
    // Fire-and-forget to background; errors are non-fatal.
    await browser.runtime.sendMessage({
      type: 'job/progress',
      payload: { jobId, progress },
    });
  } catch {
    // Background may not be listening yet — silently ignore.
  }
}

function setNativeInputValue(
  target: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const prototype = Object.getPrototypeOf(target) as HTMLInputElement | HTMLTextAreaElement;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');

  if (descriptor?.set) {
    descriptor.set.call(target, value);
    return;
  }

  target.value = value;
}

async function uploadAttachments(
  doc: Document,
  job: QueueJob,
): Promise<AutomationReply> {
  // grok.com hides the real <input type="file"> behind a "+" button.
  // Try to find it directly first; if absent, click the trigger so the
  // React component mounts / reveals the hidden input, then look again.
  let fileInput = findFileInput(doc);

  if (!fileInput) {
    const trigger = findUploadTrigger(doc);
    if (trigger) {
      await clickControl(trigger);
      // Poll for the file input to mount — React may take a moment to render
      // the hidden <input type="file"> after the trigger click on slow networks.
      fileInput = await waitForCondition(() => findFileInput(doc), FILE_INPUT_APPEAR_MS, 100);
    }
  }

  if (!fileInput) {
    return fail(
      'No file input found on this page. Make sure you are on https://grok.com/imagine.',
    );
  }

  const attachments = job.attachments;
  if (!attachments.length) {
    return fail('No attachment payloads are available for upload.', false);
  }

  if (attachments.some((attachment) => !attachment.dataUrl)) {
    return fail('At least one attachment is missing upload data.', false);
  }

  const files = attachments.map(toFileFromDataUrl);
  const transfer = new DataTransfer();
  for (const file of files) {
    transfer.items.add(file);
  }

  fileInput.files = transfer.files;
  fileInput.dispatchEvent(new Event('input', { bubbles: true }));
  fileInput.dispatchEvent(new Event('change', { bubbles: true }));
  // Give Grok's React component time to process the change event and start
  // rendering the preview before the caller checks the Submit button state.
  await delay(POST_UPLOAD_SETTLE_MS);

  return {
    ok: true,
    detail: 'Attached image inputs for frame-to-video mode.',
  };
}

/**
 * Find any file input in the DOM — visible or hidden.
 * grok.com renders a hidden <input type="file"> that is activated by the
 * "+" button; we can still programmatically set its .files.
 */
function findFileInput(doc: Document): HTMLInputElement | null {
  for (const selector of FILE_INPUT_SELECTORS) {
    const matches = Array.from(doc.querySelectorAll<HTMLInputElement>(selector));
    // Prefer visible, but accept hidden inputs as a fallback.
    const visible = matches.find((el) => isVisible(el));
    if (visible) {
      return visible;
    }

    const hidden = matches.find((el) => el instanceof HTMLInputElement);
    if (hidden) {
      return hidden;
    }
  }

  return null;
}

/**
 * Find the "+" / attach trigger button near the prompt composer.
 */
function findUploadTrigger(doc: Document): HTMLElement | null {
  const candidates = Array.from(
    doc.querySelectorAll<HTMLElement>('button, [role="button"]'),
  );

  for (const el of candidates) {
    if (!isVisible(el)) {
      continue;
    }

    const text = getControlText(el).trim();
    const ariaLabel = el.getAttribute('aria-label') ?? '';

    if (
      UPLOAD_TRIGGER_PATTERN.test(text) ||
      UPLOAD_TRIGGER_PATTERN.test(ariaLabel)
    ) {
      return el;
    }
  }

  return null;
}

function toFileFromDataUrl(attachment: ImageAttachmentMeta): File {
  const dataUrl = attachment.dataUrl;
  if (!dataUrl) {
    throw new Error('Missing attachment data.');
  }

  const [header, encoded] = dataUrl.split(',', 2);
  const mime = /^data:(.*?);base64$/i.exec(header)?.[1] ?? attachment.type;
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new File([bytes], attachment.name, { type: mime });
}

type PromptResultSnapshot = {
  totalDownloadControls: number;
};

function capturePromptResultSnapshot(
  doc: Document,
  prompt: string,
): PromptResultSnapshot {
  return {
    totalDownloadControls: findPromptDownloadControls(doc, prompt).length,
  };
}

/**
 * Find an enabled Download button anywhere on the page.
 * Used on grok.com/imagine/post/<id> where the button aria-label="Download"
 * starts disabled and becomes enabled when generation finishes.
 */
function findEnabledDownloadButton(doc: Document): HTMLElement | null {
  for (const btn of doc.querySelectorAll<HTMLButtonElement>('button')) {
    if (!isVisible(btn)) continue;
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
    if (/^\s*download\s*$/i.test(btn.getAttribute('aria-label') ?? '')) return btn;
  }
  return null;
}

async function waitForDownloadControl(
  prompt: string,
  baseline: PromptResultSnapshot,
  timeoutMs: number,
  isAborted: () => boolean = () => false,
): Promise<HTMLElement> {
  // First: prompt-text-scoped check (works on the /imagine feed page)
  const freshControl = findPromptDownloadControl(document, prompt, baseline);
  if (freshControl) return freshControl;

  // Second: direct aria-label="Download" button (works on /imagine/post/<id>)
  const directBtn = findEnabledDownloadButton(document);
  if (directBtn) return directBtn;

  return new Promise<HTMLElement>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      observer.disconnect();
      reject(new Error('Timed out waiting for a download control to appear.'));
    }, timeoutMs);

    // Poll abort flag periodically so force stop during generation is responsive.
    const abortPoller = window.setInterval(() => {
      if (!isAborted()) return;
      window.clearInterval(abortPoller);
      window.clearTimeout(timer);
      observer.disconnect();
      reject(new Error('Automation aborted by user.'));
    }, 500);

    const observer = new MutationObserver(() => {
      const candidate =
        findPromptDownloadControl(document, prompt, baseline) ??
        findEnabledDownloadButton(document);
      if (!candidate) return;
      window.clearTimeout(timer);
      window.clearInterval(abortPoller);
      observer.disconnect();
      resolve(candidate);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
    });
  });
}

function findPromptDownloadControl(
  doc: Document,
  prompt: string,
  baseline: PromptResultSnapshot,
): HTMLElement | null {
  const controls = findPromptDownloadControls(doc, prompt);
  if (controls.length <= baseline.totalDownloadControls) {
    return null;
  }

  const latestSectionWithControls = [...findPromptResultSections(doc, prompt)]
    .reverse()
    .find((section) => findDownloadControls(section).length > 0);

  if (!latestSectionWithControls) {
    return controls[controls.length - 1] ?? null;
  }

  return findDownloadControls(latestSectionWithControls)[0] ?? null;
}

function findPromptDownloadControls(
  doc: Document,
  prompt: string,
): HTMLElement[] {
  return findPromptResultSections(doc, prompt).flatMap((section) =>
    findDownloadControls(section),
  );
}

function findPromptResultSections(
  doc: Document,
  prompt: string,
): HTMLElement[] {
  const targetText = normalizeText(prompt);
  const matches = Array.from(
    doc.querySelectorAll<HTMLElement>('div, p, span, h1, h2, h3, h4, h5, h6, strong'),
  );
  const sections: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();

  for (const match of matches) {
    if (!isVisible(match) || match.isContentEditable) {
      continue;
    }

    if (normalizeText(match.textContent ?? '') !== targetText) {
      continue;
    }

    let node: HTMLElement | null = match;
    while (node && node !== doc.body) {
      if (node.querySelector('ul, ol, [role="list"]')) {
        if (!seen.has(node)) {
          seen.add(node);
          sections.push(node);
        }
        break;
      }
      node = node.parentElement;
    }
  }

  return sections;
}

function controlSignature(control: HTMLElement): string {
  const href = control instanceof HTMLAnchorElement ? control.href : '';
  return `${control.tagName}:${getControlText(control)}:${href}`;
}

function getControlText(control: HTMLElement): string {
  return [
    control.textContent,
    control.getAttribute('aria-label'),
    control.getAttribute('title'),
    control.getAttribute('data-testid'),
  ]
    .filter(Boolean)
    .join(' ')
    .trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Wait until the browser reports it is online, or until `timeoutMs` elapses.
 * Returns true if the connection came back, false if the timeout expired first.
 * Uses the `online` / `offline` DOM events — reliable for Wi-Fi drops, cell
 * handoffs, and airplane-mode toggles.
 */
function waitForNetwork(timeoutMs: number): Promise<boolean> {
  if (navigator.onLine) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener('online', onOnline);
      resolve(false);
    }, timeoutMs);
    const onOnline = () => {
      window.clearTimeout(timer);
      resolve(true);
    };
    window.addEventListener('online', onOnline, { once: true });
  });
}

/**
 * Poll `check` every `intervalMs` until it returns a non-null/undefined value
 * or `timeoutMs` elapses. One final check is performed at timeout.
 *
 * The countdown is **paused while the browser is offline** so that a network
 * outage (2G drop, cell handoff, Wi-Fi change) does not consume the wait
 * budget. If the network does not come back within NETWORK_RECONNECT_WAIT_MS
 * the function returns null immediately.
 */
async function waitForCondition<T>(
  check: () => T | null | undefined,
  timeoutMs: number,
  intervalMs = 150,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Pause the clock while offline and wait for reconnection.
    if (!navigator.onLine) {
      const remaining = deadline - Date.now();
      const reconnected = await waitForNetwork(
        Math.min(remaining, NETWORK_RECONNECT_WAIT_MS),
      );
      if (!reconnected) return null;
      // Reset the deadline by the time we were offline to avoid penalising the
      // operation for a transient disconnection.
      // (We simply continue; Date.now() < deadline is re-checked at loop top.)
    }
    const result = check();
    if (result != null) return result;
    await delay(intervalMs);
  }
  return check() ?? null;
}

async function clickControl(control: HTMLElement): Promise<void> {
  const rect = control.getBoundingClientRect();
  const eventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
    button: 0,
  };

  await delay(CLICK_PRE_DELAY_MS);
  control.focus();

  if (typeof PointerEvent !== 'undefined') {
    control.dispatchEvent(
      new PointerEvent('pointerdown', {
        ...eventInit,
        buttons: 1,
        isPrimary: true,
        pointerId: 1,
        pointerType: 'mouse',
      }),
    );
  }

  control.dispatchEvent(new MouseEvent('mousedown', { ...eventInit, buttons: 1 }));

  if (typeof PointerEvent !== 'undefined') {
    control.dispatchEvent(
      new PointerEvent('pointerup', {
        ...eventInit,
        buttons: 0,
        isPrimary: true,
        pointerId: 1,
        pointerType: 'mouse',
      }),
    );
  }

  control.dispatchEvent(new MouseEvent('mouseup', { ...eventInit, buttons: 0 }));
  control.click();
  await delay(CLICK_POST_DELAY_MS);
}

function isVisible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden') {
    return false;
  }

  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function fail(error: string, retryable = true): AutomationReply {
  return {
    ok: false,
    error,
    retryable,
  };
}