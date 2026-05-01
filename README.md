# Ex Grok

Clean-room Chrome extension scaffold for batching Grok video workflows on grok.com.

## Current Phase

The project now includes a working Manifest V3 baseline built with WXT, React, and TypeScript:

- Popup quick launcher for Grok, settings, and dashboard access
- Side panel dashboard for prompt batching, drag-and-drop image selection, queue review, and logs
- Options page for persistent defaults such as retries, delay range, folder naming, and mode selection
- Background service worker for runtime state, queue draft storage, and debug logging
- grok.com content script for page readiness detection
- Prompt parser that splits batches on blank lines
- Unit test coverage for prompt parsing

## Commands

- `npm install`
- `npm run dev`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run zip`

VS Code task:

- `build extension`

## Project Layout

- `entrypoints/background.ts`: queue state and runtime message handling
- `entrypoints/content.ts`: grok.com detection and page snapshot updates
- `entrypoints/popup/*`: compact launcher UI
- `entrypoints/sidepanel/*`: main operator dashboard
- `entrypoints/options/*`: defaults and settings UI
- `features/grok/*`: site-specific DOM detection helpers
- `features/prompts/*`: prompt parsing helpers
- `lib/*`: shared contracts, defaults, storage, and runtime request helpers
- `tests/*`: unit tests

## Notes

- Prompt groups are separated by blank lines. Single line breaks stay within the same prompt.
- Queue execution is intentionally sequential.
- This project is a clean-room rebuild and should not copy code from third-party Chrome Web Store extensions.

## Load Unpacked Extension

1. Run `npm run build`.
2. Load the unpacked extension from `.output/chrome-mv3` in Chrome.
