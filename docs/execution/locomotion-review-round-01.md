# Guided locomotion — Astra review round 01

Reviewer: active Astra coordinator. Author: configured Luna implementer.
Verdict at this revision: **not accepted; repair returned to Luna**.

## Actual checks

- `npm run build` and `npm run typecheck` completed successfully.
- Production build emitted a roughly 513 kB minified JavaScript bundle and a Vite size warning. This is a warning, not a measured full-game performance result.
- Owned Chromium opened `http://localhost:5173/lab` at 1440x900. Start and a 450 ms held W input moved the live player to approximately `[-0.8869, 0, 10.4356]`; Pause set `running:false`; Resume worked.
- Clicking the game-entry link then using browser Back reproduced a broken restored lab: canvas count was **0**, while a stale debug object remained. Console error collection was empty, proving absence of an error was not evidence of a working lifecycle.
- `npm audit --json` reported vulnerable Vite 6.0.1 and esbuild dependencies; a same-major fixed Vite 6.4.3 was available. The dev script also bound all interfaces via `--host 0.0.0.0`.

## Corrections requested

1. Handle browser back-forward cache correctly: do not destroy a persisted cached lab without a pageshow restoration path. Keep final teardown/disposal correct.
2. Correct the arena camera target: at blend weight 1 it must use a fixed arena target, not `state.z - 25`. Expose actual read-only camera position/target for verification, and initialize the starting camera directly to a valid pose.
3. Reuse vector scratch values in camera/foliage frame loops instead of allocating vectors repeatedly.
4. Upgrade/pin patched Vite and lockfile, bind the dev server to loopback by default, then restart and rerun build/typecheck/audit.
5. Preserve actual smoke captures under feature-owned repository paths, not only temporary workstation links.

## Boundaries

This is R01 development geometry. No final Tripo models, animation gates, combat, companion AI, campaign persistence, accessibility certification or 60 FPS release benchmark is claimed. Physical gamepad hardware was unavailable in the author report; axis/focus simulation is not hardware validation.

The initial implementation duration/usage is preserved as the `initial-implementation` round in `locomotion-usage.json`, separate from subsequent repair rounds. The complete per-round record supersedes the provisional snapshot.
