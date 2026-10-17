---
date: 2026-10-06
slug: greenwake-controls-and-frame-drops
repo: wild-crown
bug_class: other
severity: sev2
area_tag: gameplay/input-performance
evidence_quality: strong
fix_commit: uncommitted
---

# Postmortem: Greenwake controls were disconnected and candidate assets dropped frames

## Bug Summary
A new run could inherit a defeated run's zero vitality and simulation clock. Separately, keyboard movement and dodge were discarded because the mounted game's input target was detached from the DOM. The blocked Greenwake candidate GLBs also rendered about 17.04 million triangles per frame, producing severe frame drops.

## Reproduction Command
```text
Open http://127.0.0.1:5173/?assetPlaytest=greenwake; choose New Game; choose Skip Cinematic; press W and Space.
```

## Root Cause
- `GameApplication` created a focusable `.wc-input-host` but never attached it. The browser trace showed `RuntimeInput.enabled === true`, `target.isConnected === false`, and Space in its key set; `RuntimeInput.sample()` returned empty movement and dodge actions because of its disconnected-target guard.
- `CombatEngine.loadRegion()` rebuilt Aren but retained old run resources and clocks. A fresh New Game reproduced at simulation tick 862 with zero vitality; the first active tick downed the new actor.
- The local candidate route loaded high-poly blocked GLBs unchanged. The Erya tree alone had 1,874,604 triangles per instance and six placements; total scene geometry measured 17,037,201 triangles per frame.

## Fix
- Attach the input host to the overlay before constructing `RuntimeInput`, keeping its connected-target guard and global keyboard listeners intact.
- Add `CombatEngine.startNewRun(runId)` to reset the full run state, and call it from the New Game action. Keep `loadRegion()` state-preserving so same-run travel and deliberately seeded engine state retain resources.
- In the explicit development-only Greenwake route, simplify blocked indexed candidate material groups over 50,000 triangles in memory, targeting 5% with a 1% relative-error ceiling. Apply it after GLB hash validation; leave source assets and `blocked` evidence status unchanged.

## Evidence Sources Used
- Browser reproduction before the fix: disconnected input host produced zero sampled controls despite receiving key events; the stale new-run state had tick 862 and zero vitality.
- Browser smoke `tests/app/input-host.smoke.html`: `PASS Mounted game input delivers movement and dodge` (`moveZ: 1`, `dodgePressed: true`). In the actual Greenwake game, W+Space changed the HUD from `Dodge 2 / 2` to `1 / 2`; no page errors were observed.
- Three-second live gameplay sample at a 756×419 canvas: 180 frames, 60.0 FPS, p50/p95 frame interval 16.7 ms, maximum 16.8 ms; WebGL draw-call instrumentation measured 2,219,855 triangles and 16 calls per frame on average.
- Before optimization the same candidate route measured 12.1 FPS; simplifying the tree alone measured 31.38 FPS. The all-candidate measurement above used WebGL draw-call instrumentation for triangle counts.
- `npm run build` passed. Focused tests passed: `GameApplication.test.ts` (32), `GameApplication.recovery.test.ts` (5), `RuntimeInput.test.ts` (7), `core.test.ts` (8), `run-reset.test.ts` (2), and `candidate-geometry.test.ts` (1).

## Open Risks
Candidate assets remain blocked from production acceptance, and candidate characters still lack animation clips. Simplification runs synchronously during local asset loading and can pause the development client; the measured local route is not production performance qualification. The production manifest and normal New Game gate remain unchanged.

## Prevention Notes
- Keep a real mounted-app keyboard smoke that exercises movement and dodge, not only isolated combat/input unit tests.
- Reset run state at the explicit new-run boundary; test that same-run region travel preserves resources.
- Measure actual rendered candidate geometry and live frame cadence after assets load; candidate reductions do not change release evidence status.
