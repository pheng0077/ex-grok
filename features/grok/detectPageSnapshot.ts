import type { GrokPageSnapshot } from '@/lib/contracts';

// grok.com/imagine uses a contenteditable <p> (no textarea)
const PROMPT_SELECTORS = [
  'p[contenteditable="true"]',
  '[contenteditable="true"]',
  'textarea',
];

const FILE_SELECTORS = [
  'input[type="file"][accept*="image"]',
  'input[type="file"]',
];

// Submit button text on grok.com/imagine
const GENERATE_BUTTON_PATTERN = /(submit|generate|create|run|imagine|send)/i;

const AUTH_REQUIRED_PATTERN = /(sign in|log in|create account|sign up)/i;

export function detectGrokPageSnapshot(
  doc: Document,
  url: string,
): GrokPageSnapshot {
  const promptInput = PROMPT_SELECTORS.some((selector) =>
    Boolean(doc.querySelector(selector)),
  );

  const imageUpload = FILE_SELECTORS.some((selector) =>
    Boolean(doc.querySelector(selector)),
  );

  const generateAction = detectGenerateAction(doc);

  // If there is a visible prompt composer, the user is likely authenticated.
  // Fall back to checking whether prominent sign-in language fills the page.
  const bodyText = doc.body?.textContent?.slice(0, 4000) ?? '';
  const signinLinksOnly = detectSignInLinksOnly(doc);
  const authenticated = promptInput || !signinLinksOnly;

  // Also detect the Submit button and radio-based mode selector.
  const hasSubmitButton = Boolean(
    doc.querySelector('button:not([disabled]):not([aria-disabled="true"])') &&
    Array.from(doc.querySelectorAll('button')).some(b =>
      /^\s*submit\s*$/i.test((b.textContent ?? '').trim()) ||
      /^\s*submit\s*$/i.test(b.getAttribute('aria-label') ?? '')
    )
  );

  // grok.com uses radio inputs inside a "Generation mode" radiogroup
  const hasVideoMode = Boolean(
    doc.querySelector('[role="radiogroup"]') ||
    doc.querySelector('input[type="radio"]'),
  );

  return {
    url,
    title: doc.title,
    detectedPromptInput: promptInput,
    detectedImageUpload: imageUpload,
    detectedGenerateAction: generateAction || hasSubmitButton,
    authenticated,
    readyForAutomation:
      authenticated && promptInput && (generateAction || hasSubmitButton),
    updatedAt: new Date().toISOString(),
  };
}

function detectGenerateAction(doc: Document): boolean {
  const buttons = Array.from(
    doc.querySelectorAll('button, [role="button"]'),
  );

  return buttons.some((element) => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const text = (element.textContent ?? '').trim();
    const ariaLabel = element.getAttribute('aria-label') ?? '';
    const title = element.getAttribute('title') ?? '';

    return (
      GENERATE_BUTTON_PATTERN.test(text) ||
      GENERATE_BUTTON_PATTERN.test(ariaLabel) ||
      GENERATE_BUTTON_PATTERN.test(title)
    );
  });
}

function detectSignInLinksOnly(doc: Document): boolean {
  // If the page has a prompt composer, auth is assumed to be fine regardless
  // of nav links. Only flag as unauthenticated if the main content is just
  // auth call-to-action anchors with no composer present.
  const anchors = Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href]'));
  const authAnchors = anchors.filter((anchor) =>
    AUTH_REQUIRED_PATTERN.test(anchor.textContent ?? ''),
  );

  return authAnchors.length > 0 && !doc.querySelector(PROMPT_SELECTORS[0]);
}