# Ex Grok Agent Guide

## Purpose

Build a clean-room Chrome extension for grok.com automation. Phase 1 is focused on text-to-video and frame-to-video batching, sequential queueing, settings persistence, and download-ready architecture.

## Commands

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run zip`

## Architecture

- `entrypoints/background.ts` owns runtime state, queue drafts, and debug logs.
- `entrypoints/content.ts` is the only place that should talk directly to grok.com page state.
- `entrypoints/sidepanel/*` is the main operator surface.
- `entrypoints/popup/*` is a launcher, not the main workflow surface.
- `entrypoints/options/*` stores defaults that seed the side panel.
- `features/grok/*` must contain site-specific selector and DOM detection logic.
- `features/prompts/*` owns prompt parsing rules.
- `lib/*` should stay serializable and shared across entrypoints.

## Project Rules

- Keep the implementation clean-room. Do not copy or decompile third-party extension code.
- Split prompt groups on blank lines, not single line breaks.
- Keep queue execution sequential unless the user explicitly changes the product requirement.
- Do not pass non-serializable browser objects into shared runtime state.
- When adding Grok automation logic, isolate selectors and DOM assumptions behind small helper functions so site changes stay localized.