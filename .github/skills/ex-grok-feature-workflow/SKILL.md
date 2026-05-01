---
name: ex-grok-feature-workflow
description: 'Implement or modify features in the ex-grok WXT React TypeScript extension. Use for queue changes, sidepanel flows, settings updates, prompt parsing work, runtime messaging, and state changes that must stay clean-room, serializable, and sequential.'
argument-hint: 'Describe the feature or change to make'
---

# Ex Grok Feature Workflow

## When to Use

- Add or modify extension behavior in this repository.
- Decide which layer should own a new requirement.
- Change queueing, settings, prompt parsing, or UI while preserving project rules.

## Ownership Map

- `entrypoints/background.ts` owns runtime state, queue mutations, and logs.
- `entrypoints/content.ts` is the only bridge to grok.com page activity.
- `entrypoints/sidepanel/*` is the main operator UX.
- `entrypoints/popup/*` should stay a launcher.
- `entrypoints/options/*` edits defaults and settings.
- `features/grok/*` holds selectors and DOM assumptions.
- `features/prompts/*` holds prompt parsing rules.
- `lib/*` holds serializable shared contracts, defaults, and runtime helpers.

## Procedure

1. Classify the request by owning surface.
   - State, queue, logs, or persisted settings: start in background and shared contracts/state.
   - Grok page detection or site behavior: start in `features/grok/*`, then verify content-script wiring.
   - Prompt grouping behavior: start in `features/prompts/*` and its tests.
   - Operator workflow or dashboard changes: start in `entrypoints/sidepanel/*`.
2. Read the owner plus one adjacent call site or test, then form the smallest local hypothesis.
3. Make the smallest change that preserves project rules.
   - Keep runtime state serializable.
   - Keep queue execution sequential unless the requirement explicitly changes it.
   - Treat blank lines as prompt separators.
   - Keep Grok-specific DOM logic out of shared runtime modules.
4. Update contracts only when the change crosses entrypoint boundaries.
5. Add or adjust focused tests when behavior is pure or parser-related.
6. Validate with the cheapest relevant checks first.
   - Prompt parsing change: run `npm test`.
   - Type or contract shape change: run `npm run typecheck`.
   - Runtime or entrypoint change: run `npm run build`.
7. If the change affects packaging or release readiness, finish with `npm run zip`.

## Completion Checks

- The change lives in the correct layer.
- Shared state contains only serializable data.
- Prompt grouping still splits on blank lines.
- Background remains the owner of queue and runtime state.
- The relevant validation commands pass.

## Avoid

- Moving Grok DOM selectors into entrypoints or `lib/*`.
- Treating the popup as the main workflow surface.
- Adding concurrent queue behavior by accident.
- Passing browser objects or DOM nodes through shared contracts.