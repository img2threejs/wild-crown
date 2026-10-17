# P6 multi-line dialogue progression

## Goal
Present every authored dialogue line in order before advancing to the next beat, without changing campaign gates or authored dialogue.

## Context
- Branch: `task/62-dialogue-lines-20261005-a` from main `7f64a9e151f4910a79a7a0783028b33b55746b2a`.
- P6 parent issue: #11; relevant child: #62 tutorial, narrative, audio, subtitles, settings, and UI polish.
- `DialogueBeat.lines` is ordered authored content (`src/game/contracts.ts` and `src/content/dialogue.ts`). `GameUI` previously rendered only `lines[0]`; `GameApplication` advanced to the next beat on every Continue action.
- New Game remains fail-closed on native asset evidence. Do not weaken gates, fabricate assets, or claim P6 readiness.
- Coordinator owns integration, review, verification, commits, and any issue/PR actions. Worker owns only the listed source/test/doc files; no push, merge, browser, provider or consent actions.

## Tasks

### T1 — Advance every line within a dialogue beat `[~]`
Owned files: `src/app/GameApplication.ts`, `src/game/contracts.ts`, `src/ui/GameUI.ts`, `tests/app/GameApplication.test.ts`, `tests/ui/GameUI.test.ts`, `tests/ui/game-ui.smoke.html`, `docs/features/reference-ui.md`.
Acceptance:
- Continue displays each line of the active `DialogueBeat` in source order; it advances to `next` (or exits to the existing choice/game path) only after the final line.
- `GameViewModel.dialogue` keeps the authored beat; a zero-based `dialogueLineIndex` selects the active line. `GameUI` includes the index in `gameUiSignature` and reads only that line, avoiding cloned beat/line-array allocations during render.
- A newly entered beat, new prologue, title/recovery, and cinematic skip cannot inherit a stale line index.
- Regression coverage exercises a multi-line production dialogue beat through application dispatch/model state, covers terminal and next-beat transitions, and confirms the mounted UI changes visible line when only the index changes; it does not merely test copied UI markup or source text.
- Existing single-line/choice/skip behavior remains unchanged; authored data, campaign state persistence, asset readiness, and dialogue content remain unchanged.
- Document the per-line Continue behavior in the existing UI contract.
- Worker may add and run only the focused failing-before reproduction, then must skip further tests/build/lint/formatting until the coordinator integration gate. No browser use.

## Verification and status
- [x] Focused reproducer failed against the unfixed code: `/tmp/wild-crown-bun/node_modules/.bin/bun test tests/app/GameApplication.test.ts -t "walks every authored line"` received `yara-intro, "", ""` instead of `yara-intro, vara-fragment, aren-reply`.
- [ ] Coordinator reviewed actual changes and verified acceptance after implementation.
- [ ] Coordinator ran integrated tests and changed-path smoke.
- P6 / #25 remains not test-ready until genuine asset, consent, and real-application acceptance gates pass.

## Boundaries
- Do not modify `public/assets/manifest.json`, asset gates, combat/renderer authority, generated assets, or user-owned plans.
- No Tripo/provider dispatch, uploads, consent changes, fake/greybox assets, issue closure, push, or merge by the worker.
