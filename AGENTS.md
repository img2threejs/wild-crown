# Wild Crown execution contract

## Product authority

Wild Crown: The Broken Pact is the approved desktop-web, single-player cinematic action adventure. Preserve the approved Map/UI/Character concepts. Player-facing content is English only. Final authored meshes come from Tripo GLBs; a clearly labeled movement greybox is a development artifact, not a final model or completed game.

The approved production plan has P0-P13, six major bosses, five macro-regions plus Heartroot Hollow, the Grove and Greenwake, and three endings. No milestone or PR may claim the full game is finished before its acceptance criteria are met.

## Models and review

- Execution: configured `implementer` resolving to `openai-codex/gpt-6.1-sol`, explicitly approved by the user after the Luna routing mismatch. Use `coder` only after confirming it resolves to the same approved model.
- Verification execution: main or a configured `tester` whose resolved model is verified before work; never silently substitute a different model.
- Review and acceptance: configured Astra reviewer (`openai-codex/gpt-6-astra`). Review actual code and evidence in two stages: spec compliance, then code quality/state lifetime/regression risk. Main retains planning and publication decisions.
- The current Sol/Astra approval supersedes the earlier Luna/Astra preference only; do not alter global model settings or credentials. Inspect actual resolved-model metadata for every dispatched role and pause unexpected substitutions.
- Do not change global model settings or credentials.

## Git workflow

Repository: `img2threejs/wild-crown`, private.

Use the GitHub P0–P13 phase issues and their child issues as the durable backlog. Pick an actionable issue, create an isolated task branch from current main, implement and exercise its acceptance, then open a PR targeting main with `Closes #<task-issue>`. Astra reviews spec compliance before code quality; the coordinator may merge verified PRs without another confirmation, then immediately synchronize/publish main and pick the next actionable issue. Keep blocked issues open with exact prerequisites; close a phase only when all child issues and its exit criteria pass. This supersedes the historical direct-main/no-new-PR workflow. No force push. Workers do not commit, push, merge, or close issues unless their brief explicitly authorizes it. A merged increment is not a full-game readiness claim.

Independent issue agents may run in parallel, with exclusive file/output ownership and separate code worktrees. Provider jobs use explicit task IDs and per-asset output directories, never shared `@last`. Tripo generation/rigging remains bounded by the assigned approved reference or upstream asset and actual user authorization; do not upload unrelated references, top up, bypass a consent gate, or fabricate provider evidence.

All browser operations are headless, in exactly one coordinator-owned Brave profile/session. Workers must not open browsers; supply runnable scenarios for the coordinator to exercise sequentially in that shared tab. Record evidence, provider task IDs, asset hashes, limitations, branch/PR links, and the next actionable task in repository artifacts and issue comments before a handoff. Machine-local sessions, build output, and signed provider URLs are not portable sources of truth.

## Boundaries

Use TypeScript and Three.js with simulation separate from presentation. Fixed-step simulation owns movement, collisions, hit windows and world state. CameraDirector is the only gameplay-camera writer. Rendering and VFX never award rewards or mutate quest history.

Leader Dominion history is monotonic within a run, including through ordinary load/import. New Game creates a new run. Chapter replay/showcase progress never changes campaign history. Exiled Solkar and absent companions must not be summoned implicitly. Animal combat is nonlethal; no gore. Chapter 7's coalition does not itself award Living Pact.

Respect file ownership in dispatch briefs. Do not modify sibling worktrees or the existing img2threejs-showcase repository. Local content and filename searches must use baoer_signal_grep. Use LSP for code intelligence when available.

## Evidence and measurement

Run the changed behavior, not merely a build. Browser features need actual interaction, visible results and console-error inspection. Keep meaningful deterministic tests for uncertain boundaries/invariants; do not test source wording or mock forwarding.

Record observed start/end timestamps, job IDs, resolved models, verification commands, result artifacts and usage fields supplied by the harness. Unknown usage is null/unavailable, never zero. Distinguish elapsed wall time from the sum of concurrent job durations, and uncached input from cache reads and output tokens. Never attribute account-wide usage deltas to this project.

Do not commit credentials, signed provider URLs, local authentication files, generated dependencies, build output or raw unrelated session transcripts. All production GLBs require provenance, rights, actual animation/rig evidence and applicable environment gates. A successful AI generation or build does not prove visual/rig quality.
