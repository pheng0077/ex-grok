import { detectGrokPageSnapshot } from '@/features/grok/detectPageSnapshot';
import { runGrokAutomation } from '@/features/grok/runAutomation';
import type { AppMessage, AutomationExecuteMessage } from '@/lib/contracts';

// Module-level abort flag. Set to true by 'automation/abort'; cleared at the
// start of each new automation run so re-run/retry work cleanly.
let automationAbortRequested = false;

export function isAutomationAbortRequested(): boolean {
  return automationAbortRequested;
}

export function clearAutomationAbort(): void {
  automationAbortRequested = false;
}

export default defineContentScript({
  matches: ['https://grok.com/*', 'https://*.grok.com/*'],
  runAt: 'document_idle',
  main(ctx) {
    let queued = false;

    const scheduleSnapshot = () => {
      if (queued || ctx.isInvalid) {
        return;
      }

      queued = true;
      ctx.setTimeout(() => {
        queued = false;
        void browser.runtime
          .sendMessage({
            type: 'page/update',
            payload: {
              snapshot: detectGrokPageSnapshot(document, window.location.href),
            },
          } satisfies AppMessage)
          .catch(() => {
            // Ignore transient service worker restarts during development.
          });
      }, 350);
    };

    scheduleSnapshot();
    ctx.addEventListener(window, 'wxt:locationchange', scheduleSnapshot);

    browser.runtime.onMessage.addListener(
      (
        message: unknown,
        _sender: unknown,
        sendResponse: (response: unknown) => void,
      ): boolean => {
        const msg = message as AppMessage;

        if ((msg as { type: string }).type === 'automation/abort') {
          automationAbortRequested = true;
          sendResponse({ ok: true });
          return false;
        }

        if ((msg as { type: string }).type !== 'automation/execute') {
          return false;
        }

        // Reset abort flag so a fresh run isn't immediately aborted.
        automationAbortRequested = false;

        void runGrokAutomation(message as AutomationExecuteMessage, () => automationAbortRequested).then(
          sendResponse,
        );
        return true; // keep the channel open for the async automation reply
      },
    );

    const observer = new MutationObserver(scheduleSnapshot);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
    });

    ctx.addEventListener(window, 'beforeunload', () => observer.disconnect());
  },
});
