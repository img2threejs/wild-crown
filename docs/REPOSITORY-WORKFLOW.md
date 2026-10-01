# Private repository and execution workflow

## Repository decision

The user requested a new private repository under the img2threejs organization. The canonical implementation repository is now `https://github.com/img2threejs/wild-crown` (verified PRIVATE), rather than a new game entry inside the existing showcase checkout.

This supersedes only the repository-placement/integration assumption in the imported production plan. The existing `img2threejs-showcase` checkout is read-only reference material. Its gallery may link to the game in a later separate feature; no existing showcase files are changed by this wave.

The remote was initialized by GitHub with a README so feature PRs have a base branch. The current user instruction is issue → task branch → verified PR → merge into main → close the task issue → pick the next actionable issue. The coordinator may merge after Astra acceptance without waiting for another confirmation. Publish/synchronize main immediately after each merge; never force-push. This supersedes the historical direct-to-main/no-new-PR instruction and the first-wave user-only merge restriction.

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

Current user-approved routing:

- Execution: `implementer` → `openai-codex/gpt-6.1-sol`; verify other execution roles before use.
- Review: `reviewer` → `openai-codex/gpt-6-astra`, spec compliance before code quality.
- Main retains planning, final decision and publication authority; worker reports alone never approve a merge.

Earlier first-wave jobs resolved to `openai-codex/gpt-6-luna:high`. Later actual process metadata exposed a Sol execution route; writers checkpointed, and the user explicitly selected “Sol + Astra để chạy ngay” to continue without changing global configuration. Preserve actual historical model attribution rather than relabeling those jobs Luna. This current approval supersedes the earlier Luna preference and generic MiniMax orchestration guidance.

## First wave (historical)

Two independent feature worktrees start from the same initial main commit:

1. `feat/campaign-state`: a standalone TypeScript campaign-state and English-content package. Its scenario command exercises the ending predicate, fragment uniqueness, historical Dominion and checkpoint/import boundaries. It is not IndexedDB persistence or a completed game.
2. `feat/first-pact-locomotion`: a runnable guided 3D movement/camera laboratory, explicitly marked Development Greybox. It verifies movement, collision, depth, camera, pause/resume and reset. It is not final Tripo art, combat, companions or the completed First Pact slice.

`docs/production-baseline` imports the approved design/content/concept evidence and execution record. It does not imply the gameplay PRs depend on local Desktop paths after merging.

Astra reviews spec compliance first, then code quality/state lifetime and actual exercised behavior. Required fixes return to the approved execution model (currently Sol). Commits and PRs are issue-scoped; the current coordinator merges only after both review stages and task-specific smoke verification pass.

## Parallel execution and portable resume

The [phase issues](https://github.com/img2threejs/wild-crown/issues?q=is%3Aissue%20label%3Aepic) retain P0–P13 plus character production. Their linked child issues retain scope, acceptance, blockers, PRs and measured evidence. An issue closing proves only its named acceptance, not game readiness.

On another machine, clone `img2threejs/wild-crown`, fetch current main, and read `AGENTS.md` and the chosen issue before editing. Use `gh issue list --repo img2threejs/wild-crown --state open` and `gh pr list --repo img2threejs/wild-crown --state open` to recover the queue and unfinished PRs. Continue the existing PR branch when work is already published; otherwise create a new task branch from current main. Install the locked npm dependencies with `npm ci`, then use `npm run typecheck`, `bun test`, `npm run build`, and the issue-specific smoke command. Tests/builds do not replace gameplay/native-asset acceptance.

Independent Sol issue agents run concurrently in separate code worktrees with explicit file ownership. Astra review and final decisions remain coordinator-owned. Concurrent Tripo jobs use explicit task IDs and unique per-asset output directories; never rely on account-wide `@last`, account-wide credit deltas, or success status as rig/animation quality. Read actual riggability/output records before each dependent provider step. Do not self-grant consent or weaken toolchain/evidence gates.

The coordinator alone exercises browser scenarios, always headless in one shared Brave profile/session. Workers provide the exact route/action/assertions without launching browsers. Before handing off, push verified code/assets/provenance and record outstanding requirements on the issue. Authentication grants, credentials and signed download URLs are machine-local/external prerequisites, never files to commit or infer on the next machine.

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
