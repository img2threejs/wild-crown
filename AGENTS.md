# Wild Crown execution contract

## Product authority

Wild Crown: The Broken Pact is the approved desktop-web, single-player cinematic action adventure. Preserve the approved Map/UI/Character concepts. Player-facing content is English only. Final authored meshes come from Tripo GLBs; a clearly labeled movement greybox is a development artifact, not a final model or completed game.

The approved production plan has P0-P13, six major bosses, five macro-regions plus Heartroot Hollow, the Grove and Greenwake, and three endings. No milestone or PR may claim the full game is finished before its acceptance criteria are met.

## Models and review

- Execution: configured `coder` or `implementer` agent resolving to `openai-codex/gpt-6-luna`.
- Verification execution: configured `tester` resolving to Luna.
- Review and acceptance: Astra. Review actual code and evidence in two stages: spec compliance, then code quality/state lifetime/regression risk.
- Do not use generic `task` for coding: it is configured to a different model. Do not silently fall back if the requested execution model cannot run.
- Do not change global model settings or credentials.

## Git workflow

Repository: `img2threejs/wild-crown`, private.

Work in one feature branch/worktree per independently reviewable feature. Scope commits explicitly; do not stage unrelated files. No force push, no direct gameplay-code push to main, no self-merge. The coordinator publishes reviewed feature branches and PRs. Workers do not commit/push unless their brief explicitly authorizes it.

## Boundaries

Use TypeScript and Three.js with simulation separate from presentation. Fixed-step simulation owns movement, collisions, hit windows and world state. CameraDirector is the only gameplay-camera writer. Rendering and VFX never award rewards or mutate quest history.

Leader Dominion history is monotonic within a run, including through ordinary load/import. New Game creates a new run. Chapter replay/showcase progress never changes campaign history. Exiled Solkar and absent companions must not be summoned implicitly. Animal combat is nonlethal; no gore. Chapter 7's coalition does not itself award Living Pact.

Respect file ownership in dispatch briefs. Do not modify sibling worktrees or the existing img2threejs-showcase repository. Local content and filename searches must use baoer_signal_grep. Use LSP for code intelligence when available.

## Evidence and measurement

Run the changed behavior, not merely a build. Browser features need actual interaction, visible results and console-error inspection. Keep meaningful deterministic tests for uncertain boundaries/invariants; do not test source wording or mock forwarding.

Record observed start/end timestamps, job IDs, resolved models, verification commands, result artifacts and usage fields supplied by the harness. Unknown usage is null/unavailable, never zero. Distinguish elapsed wall time from the sum of concurrent job durations, and uncached input from cache reads and output tokens. Never attribute account-wide usage deltas to this project.

Do not commit credentials, signed provider URLs, local authentication files, generated dependencies, build output or raw unrelated session transcripts. All production GLBs require provenance, rights, actual animation/rig evidence and applicable environment gates. A successful AI generation or build does not prove visual/rig quality.
