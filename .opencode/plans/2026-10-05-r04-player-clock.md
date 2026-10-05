# R04 player/world animation clock split

## Goal
Keep Aren's finite actions and native looping animation on simulation time while hostile/world animation remains on the scaled world clock, without breaking serialized checkpoint state.

## Context
- Branch: `task/R04-responsive-player-clock-20261005-a` from current main `0ef65af`.
- Parent issue: #25 remains open until genuine native rig/root-motion/contact and real-application acceptance pass.
- Contract: `docs/features/combat.md`; implementation: `src/game/combat/CombatEngine.ts`, `src/rendering/AnimationController.ts`, `src/rendering/GameRenderer.ts`.
- Existing implementation edits are in the assigned source/test files and need independent completion/review. Never convert fixture evidence into production acceptance.
- Workers must skip build/tests/formatters mid-flight and must not use a browser. The coordinator runs integrated verification once after both implementation slices and reviews.

## Tasks

### T1 — Simulation-clock combat actions and schema migration `[x]`
Files: `src/game/combat/CombatEngine.ts`, `tests/combat/time-dilation.test.ts`.
Acceptance:
- Aren finite action start/end/sample progression is based on `state.tick` and advances once per fixed simulation step through Perfect Dodge slow motion; non-player actions continue to use `worldTick` and `worldScale`.
- Checkpoint reset does not rebase Aren's simulation-clock action timestamps; it still rebases non-player/world-clock timestamps.
- Engine schema v3 migrates v2 player live/checkpoint action progress while preserving `normalizedTime`; v1 simulation-clock saves remain compatible.
- Deterministic tests cover player/enemy rates, a player action started during slow motion, action completion, v1 compatibility, and v2 live/checkpoint migration.
- Keep traversal's authored world-clock behavior unchanged. Do not claim native asset or game acceptance.

### T2 — Renderer loop sampling clock routing `[x]`
Files: `src/rendering/AnimationController.ts`, `src/rendering/GameRenderer.ts`, `tests/rendering/browser-smoke.ts`.
Acceptance:
- One-shot clips still use authoritative `normalizedTime` snapshots.
- Loop clips sample actual native clip duration from an authoritative clock: Aren from `simulationTick / 60`, all other actors from `worldTimeSeconds`.
- Existing callers/previews remain compatible.
- Browser renderer smoke covers a player and hostile loop under 0.25 world-time scale and detects the two distinct samples.
- Fix any existing renderer smoke failure caused by this slice; do not suppress unrelated errors or loosen assertions.

### T3 — Independent spec-compliance review `[x]`
T1 and T2 independently received Astra `SPEC_OK` and then fresh `QUALITY_OK` reviews. T1 caveats were traced through update/recovery/renderer consumers; no patch-introduced defect found. Static review only; runtime evidence is recorded under T5. Spec jobs: `R04CombatSpec` and `R04RendererSpec`; quality jobs: `R04CombatQuality` and `R04RendererQuality`; all review jobs used `openai-codex/gpt-6-astra`.

### T4 — Independent code-quality review `[x]`
Fresh Astra reviewers returned `QUALITY_OK` for both slices after spec review. Combat state lifetime, JSON persistence/checkpoints, migration caveats, renderer clock ownership, preview/runtime transitions, and production-path smoke coverage were checked; no actionable introduced defects. Implementer jobs were `R04CombatClock` and `R04RendererClock` (`openai-codex/gpt-6.1-sol`). Quality-review durations were 95s and 55.8s; absolute agent start/end times and usage were not exposed.

### T5 — Integrated verification `[x]`
Coordinator observed `./node_modules/.bin/tsc --noEmit`; `/tmp/wild-crown-bun/node_modules/.bin/bun test tests/combat/time-dilation.test.ts` (21 pass / 225 assertions); `/tmp/wild-crown-bun/node_modules/.bin/bun test` (565 pass / 1,507 assertions); and `PATH=/Users/hoainho/.nvm/versions/node/v20.18.1/bin:$PATH npm run build` (pass; Vite warned that 504.94 kB and 568.75 kB chunks exceed 500 kB). Chromium `/tests/rendering/browser-smoke.html` passed with zero page errors; two Three.js `skinning` warnings remain. `/tests/app/browser-smoke.html` passed all seven lifecycle checks with `failure: null` and cleanup true. The real development route and built preview both reject New Game with `greenwake-environment` blocked; this is the genuine fail-closed gate, not playable acceptance. Bun runs on ARM64 required installing the lockfile-matched optional Rollup/esbuild ARM64 binaries locally with `--no-save --package-lock=false`; initial full-suite failures were only missing platform binaries, and the complete suite passed after repair. Absolute verification timestamps and usage were not exposed.

### T6 — User-test readiness decision `[x]`
`NOT READY FOR USER TEST`. Production preview confirms New Game is blocked because `greenwake-environment` is `evidenceStatus: blocked`, `runtimeUrl: null`, `nativeGlb: null`. Required P6 actors also lack native GLBs/clip mappings; only approved Aren/Asha concept crops exist and both are `providerDispatch: false`, `modelReady: false`. Do not bypass: exact per-asset rights/Tripo grants or supplied native GLBs with provenance, workspace host-image consent, an official Jev harness `>=0.2.5` (upstream official `0.2.3` is incompatible), plus native rig/root-motion/contact evidence and full P6 application acceptance remain prerequisites. Keep #25 open.

## Boundaries
- No new Tripo jobs, reference uploads, consent changes, fake/greybox product assets, or weakened readiness gates.
- No changes outside each task's owned files except this harness; workers may commit only their owned source/test files when explicitly authorized by the coordinator. No push, merge, issue close, or browser use by workers.
- One reviewed increment is not full-game or playtest readiness.
