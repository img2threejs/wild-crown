# Private repository and execution workflow

## Repository decision

The user requested a new private repository under the img2threejs organization. The canonical implementation repository is now `https://github.com/img2threejs/wild-crown` (verified PRIVATE), rather than a new game entry inside the existing showcase checkout.

This supersedes only the repository-placement/integration assumption in the imported production plan. The existing `img2threejs-showcase` checkout is read-only reference material. Its gallery may link to the game in a later separate feature; no existing showcase files are changed by this wave.

The remote was initialized by GitHub with a README so feature PRs have a base branch. Gameplay implementation is published through feature branches and PRs. No automatic merge or force-push is authorized.

## Sources and approval

- [Approved master plan](production/01-MASTER-PLAN.md)
- [Phased implementation packages](production/02-IMPLEMENTATION-AND-AGENTS.md)
- [Art, rigging and VFX requirements](production/03-ART-RIG-VFX-PIPELINE.md)
- [English content cutover](production/05-ENGLISH-CONTENT.md)
- [English UI catalog](production/content/PLAYER-COPY.en.json)
- [English narrative](production/content/GAME-NARRATIVE.en.md)
- [Approved concept images](production/visual-review/REVIEW.md)

The imported folder is a historical design/provenance snapshot. Original generated images/prompts may contain pre-cutover Vietnamese; only current curated plates and English content are authoritative for player-facing content. Machine-local paths in historic evidence are provenance, not portable build commands. No provider credentials are included.

## Model routing

Verified effective configuration:

- `coder`, `implementer`, `tester`: `openai-codex/gpt-6-luna`.
- `reviewer`: `openai-codex/gpt-6-astra`.
- The active coordinating/review session is Astra.

Both first-wave implementation jobs resolved to `openai-codex/gpt-6-luna:high`, confirmed by task process metadata. Generic `task` is configured differently and is not used for implementation. Existing generic MiniMax orchestration guidance is superseded by the user's explicit Luna/Astra choice for this project; no global configuration was changed.

## First wave

Two independent feature worktrees start from the same initial main commit:

1. `feat/campaign-state`: a standalone TypeScript campaign-state and English-content package. Its scenario command exercises the ending predicate, fragment uniqueness, historical Dominion and checkpoint/import boundaries. It is not IndexedDB persistence or a completed game.
2. `feat/first-pact-locomotion`: a runnable guided 3D movement/camera laboratory, explicitly marked Development Greybox. It verifies movement, collision, depth, camera, pause/resume and reset. It is not final Tripo art, combat, companions or the completed First Pact slice.

`docs/production-baseline` imports the approved design/content/concept evidence and execution record. It does not imply the gameplay PRs depend on local Desktop paths after merging.

Astra reviews spec compliance first, then code quality/state lifetime and actual exercised behavior. Required fixes return to Luna. Commits and PRs are feature-scoped. The user decides when to merge.

## Measurement contract

`docs/execution/wave-01.json` is the first-wave record. Its start timestamp is taken immediately before dispatching the implementation batch. Repository/configuration preparation before that timestamp is excluded and must not be confused with implementation elapsed time.

Record these separately:

- Whole-wave elapsed wall time: difference between run start and its recorded end/as-of time.
- Each task's harness duration: concurrent task durations must not be summed and called wall time.
- Per-task usage: aggregate provider-reported assistant usage records from the exact persisted task session, matched by job/session identity and resolved model.
- Astra coordination/review usage: only the parent-session records within the stated wave interval; label coordination plus review, not review-only when no narrower attribution exists.
- Repair rounds: preserve their individual job/session records instead of overwriting the initial implementation figures.

Usage fields remain separate: input, output, cacheRead, cacheWrite, totalTokens and reasoningTokens when provided. `totalTokens` is the provider/harness field, not an independently guessed billing total. Do not add reasoningTokens again to output when the provider already includes it. Missing counters are null, not zero. Pricing metadata, if captured, is not asserted to equal the user's bill.

The account-wide `omp stats` totals are not attributable to this wave and are not used as project consumption. Raw session transcripts and auth databases are not committed. Publish only non-secret usage aggregates, timestamps, model identities, verification results and feature/PR references. A measurement captured before the final response is an as-of snapshot, not a claim to include the final response's future tokens.
