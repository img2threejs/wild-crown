---
date: 2026-10-06
slug: greenwake-hidden-base-actor
repo: wild-crown
bug_class: other
severity: sev2
area_tag: rendering/native-glb
recall_hit: no-novel
evidence_quality: partial
degraded_reason: Runtime console MCP unavailable; verified via browser and source tests
fix_commit: uncommitted
time_spent_minutes: 90
---

# Postmortem: Greenwake hid the canonical player GLB

## Bug Summary
Greenwake showed no Aren and too little forest because the canonical actor asset was mistaken for an unpreloaded variant while candidate props were sub-meter and sparse.

## Reproduction Command
```text
Open http://127.0.0.1:5173/?assetPlaytest=greenwake; choose New Game; choose Skip Cinematic.
```

## Root Cause
`CombatEngine.snapshot()` sets `renderVariantId` from `ACTORS[archetypeId].assetId` (`src/game/combat/CombatEngine.ts:419-423`), so Aren’s value is `actor-aren`, the same ID as its loaded base manifest. `GameRenderer.syncActors()` treated any non-empty ID as a separate variant, hid the base root, and looked only in `actorVariants` (`src/rendering/GameRenderer.ts:427-432`). Separately, candidate trees and props were normalized around one meter, and the entry had no nearby grove; the player root also depended on a later simulation tick despite intro/transition screens.

## Fix
- `src/rendering/GameRenderer.ts:427`: treat a snapshot ID equal to the base manifest ID as the base actor.
- `src/app/GameApplication.ts:315-316,378-379`: render snapshots immediately after region load and prologue encounter startup.
- `src/game/contracts.ts:717`, `src/rendering/NativeAssetLoader.ts:37-44`, `asset-source/playtests/greenwake.json`: add candidate scale and origin-offset calibration.
- `src/content/levels/act-i.ts:28-32`: place five nearby instances of the real Erya tree GLB.

## Evidence Sources Used
- Browser route screenshot after fix showed Aren, Vara, five trees, and the hut; all nine generated GLBs returned HTTP 200.
- `tests/rendering/browser-smoke.ts` passed the regression asserting `renderVariantId: 'actor-aren'` leaves the base model visible, plus the GLB ground-offset test.
- `npm run build` passed; `node --test tests/release/validate.test.mjs` passed 233 tests; normal New Game still blocks the unverified Greenwake recipe.

## Phase 0 Recall Result
No relevant prior repo session hits in the archive; the distiller recall endpoint was unavailable.

## Oracle Consult
—

## Open Risks
Candidate evidence remains blocked, and the rigged candidate characters have no animation clips; this is not release acceptance.

## Prevention Notes
- Keep a renderer regression for snapshots whose `renderVariantId` equals the canonical base asset ID.
- Verify world-scale and ground-origin calibration on the actual opening camera view, not only asset-load success.
