---
name: ex-grok-readiness-check
description: 'Validate ex-grok changes before handoff or release. Use for pre-merge checks, regression sweeps, typecheck/test/build verification, packaging, and confirming the unpacked extension output is ready.'
argument-hint: 'Describe the change set or release check to run'
---

# Ex Grok Readiness Check

## When to Use

- Before handing off a code change.
- Before packaging or loading the extension.
- When a change touched shared contracts, runtime flow, parser behavior, or extension entrypoints.

## Validation Scope

- Documentation or customization only: confirm file placement, naming, and frontmatter.
- Prompt parsing or pure helper behavior: run `npm test`.
- Contract, runtime, UI, or entrypoint behavior: run `npm run typecheck` and `npm run build`.
- Packaging or release readiness: add `npm run zip`.

## Procedure

1. Map the touched areas to the smallest validation set that can catch regressions.
2. Run checks in order of cheapest signal.
   - `npm run typecheck`
   - `npm test`
   - `npm run build`
   - `npm run zip` when packaging matters
3. Fix only the regressions introduced by the current change.
4. Confirm the build output is suitable for Chrome unpacked loading from `.output/chrome-mv3` when relevant.
5. Use the VS Code `build extension` task instead of a manual build command when task-based verification is preferred.
6. Do not launch `npm run dev` unless the user explicitly asks for the browser session.
7. Summarize pass or fail status plus any residual risks or manual checks that still remain.

## Completion Checks

- The chosen checks match the modified surface area.
- Type, test, and build results are captured clearly.
- Packaging is verified when requested.
- Any skipped validation is justified explicitly.

## Avoid

- Reporting readiness without running the commands that match the touched code.
- Expanding the fix scope into unrelated failures.
- Launching the dev browser session without confirmation.