---
name: grok-dom-adaptation
description: 'Adapt ex-grok to grok.com DOM changes. Use for broken composer detection, missing upload controls, changed generate buttons, authentication heuristics, or content-script snapshot issues after Grok UI updates.'
argument-hint: 'Describe what changed on grok.com or what detection is failing'
---

# Grok DOM Adaptation

## When to Use

- Grok page readiness detection stops working.
- Upload, prompt, or generate controls are no longer detected.
- The extension sees Grok activity but never reports `readyForAutomation`.
- A Grok UI change appears to have broken selector assumptions.

## Procedure

1. Identify the failed signal.
   - Prompt input not found.
   - File upload not found.
   - Generate action not found.
   - Authentication heuristic is wrong.
   - Snapshot timing or wiring is stale.
2. Start in `features/grok/detectPageSnapshot.ts`.
   - Update selectors, text matching, or heuristics there first.
   - Keep detection logic pure and localized.
3. Touch `entrypoints/content.ts` only if scheduling, observation, or message delivery is the real fault.
4. Preserve the contract shape used by `GrokPageSnapshot` unless the product requirement actually changed.
5. If the detection logic becomes branchy, extract small helper functions instead of spreading DOM assumptions across files.
6. Re-run the narrowest validation that can fail the change.
   - Snapshot logic only: `npm run typecheck` and `npm run build`.
   - Shared contract impact: include `npm test` if parsing or pure helpers changed.
7. Report any remaining fragile assumptions so future selector drift stays easy to localize.

## Completion Checks

- DOM selectors remain isolated to `features/grok/*`.
- `entrypoints/content.ts` still acts as a thin observer and messenger.
- Background continues to receive the same snapshot shape.
- Build and typecheck pass after the selector update.

## Avoid

- Embedding raw selector logic in sidepanel, popup, or background code.
- Expanding shared state with live DOM data.
- Fixing a timing problem by scattering duplicate detection logic across files.