# Solkar skyward head — causal evidence and rebuild receipts

Task: fix Solkar's (`actor-solkar`) skyward walk / run neck and head, so the muzzle keeps the idle's
carriage during locomotion instead of being craned at the sky. Preserve the approved geometry, the
speed / collision contract, and the roar / attack / reaction / skill / contact timing.

Authoring measurements use the real runtime GLBs through three's `GLTFLoader` and keyframe
interpolants. Section 8 records the independent native-browser preview; it is not an in-world
terrain, reference-hardware or release-approval qualification.

**Repository state**: changes exist in the working tree only. No staging, commit, push, merge,
deployment or asset promotion is authorized by this receipt. References to committed `HEAD`
describe the pre-fix baseline, not this work.

The sampler was cross-validated against the game's own recorded idle pose
(`asset-source/playtests/evidence/player-feedback/before-solkar-pose.json`, sample 0):

| quantity | sampler (runtime GLB, manifest transform applied) | game's recorded idle |
| --- | --- | --- |
| neck elevation (`Head_0` → `Head_3`) | 30.02° | 29.06° |
| neck length (`Head_0` → `Head_3`) | 0.8099 units | 0.8107 units |

## 1. Root cause

`GroundGuard` (in `scripts/assets/author-quadruped-clips.mjs`) keeps the head and tail out of the
ground by measuring each region's lowest skinned vertex against **its rest (bind-pose) height**.

The authored `ikGait` dips the whole body — `walk` dips 0.04 body heights, `run` dips 0.05 — and the
neck base and tail root travel down with it. The guard therefore read the gait's *own* dip as a floor
violation and answered it by pitching the neck **up**.

Measured on the unguarded walk solve:

| frame | head lowest (units) | violation vs rest floor | body's own drop (hips) | neck-base drop |
| --- | --- | --- | --- | --- |
| 0.000 | 0.12785 | 0.02782 | 0.03152 | 0.02940 |
| 0.167 | 0.12381 | 0.03186 | 0.03091 | 0.03137 |
| 0.333 | 0.12443 | 0.03124 | 0.02640 | 0.02807 |

The violation tracks the body's own drop to within **0.0056 units** (max over 24 frames): the drop
*is* the violation. For `run` the same holds (worst |violation − bodyDrop| = 0.0056).

Instrumented guard trace (temporary, removed after the diagnosis) — the lift the guard applied to the
head region:

| clip | max head lift | max tail lift |
| --- | --- | --- |
| `monster-idle` | 9.02° | 2.39° |
| `monster-walk` | **53.78°** | 9.57° |
| `monster-run` | **70.00°** (the guard's cap) | 10.99° |

`monster-run` saturated the guard's 70° cap, so the neck was craned as hard as the guard allows.

Solkar is unusually exposed because his mane hangs low over the ground, so his head region's rest floor
is close to the ground and his gait's dip crosses it on **every** frame. Siblings hit the same guard
at their own thresholds (`actor-luma` walk 70°, `actor-nyra` walk 70°, `actor-sable` walk 70°), so the
defect is systemic in the guard; the fix is applied to Solkar only, per the ownership brief.

## 2. The fix

`GroundGuard` gained an opt-in **body-relative floor**: the region's floor is measured against the
body's own vertical travel (the solved `Root`'s height against its rest height) instead of against the
absolute rest height. It is enabled only for `actor-solkar` through the new `bodyRelativeFloor`
personality flag.

A body-relative floor keeps the guard's real job: a pose that genuinely pushes the head or tail into
the ground is still caught.

| scripted nose dive (neck + head pitch) | old floor | new floor |
| --- | --- | --- |
| 0° | ok | ok |
| −20° | VIOLATION | VIOLATION |
| −40° | VIOLATION | VIOLATION |
| −60° | VIOLATION | VIOLATION |
| −80° | VIOLATION | VIOLATION |
| −100° | VIOLATION | VIOLATION |

and the gait dip it was meant to exempt stops being flagged:

| gait | frames flagged by the old floor | frames flagged by the new floor |
| --- | --- | --- |
| `walk` | 24 / 24 | **0 / 24** |
| `run` | 24 / 24 | **0 / 24** |

## 3. Result: the muzzle keeps the idle's carriage

Muzzle elevation (`Head_2` → `Head_3`), mean over the clip, in the playable
`actor-solkar-companion.glb`:

| clip | before | after |
| --- | --- | --- |
| `monster-idle` | 39.01° | 39.01° (unchanged) |
| `monster-walk` | **74.02°** | **38.40°** |
| `monster-run` | **87.84°** | **38.40°** |
| `monster-turn` | 38.36° | 38.36° (unchanged) |

An offline composition with the existing runtime creature look-at reads 36.21° for walk and 36.17°
for run against idle's 37.00°. That layer contributes only 2–3° in this measurement; the large
skyward rotation already exists in the baked clips. No runtime rendering change was required.

`src/rendering/{ActorProcedural,LookAtIK,QuadrupedGrounding,LaterMonsterProfiles}.ts` are unchanged.

## 4. Final scope: locomotion-only option C

The working-tree build applies the body-relative floor only to `monster-walk`, `monster-run` and
`monster-turn`. The clip name reaches `guard.solve(ctl, clipName)` through `solveFrame` and
`solveFrameCore`; every other clip retains the absolute rest-height floor.

The initial global-flag build B was rejected: it also changed 35 `monster-jump` tracks, including
14° of hip rotation. The guard's neck lift feeds the same control set as leg IK, so changing the
guard can move knees even when the paw target stays planted. Option C removes that out-of-scope
jump change without changing the walk/run correction.

Independent final accessor-byte comparison against the pre-fix GLB:

| clip | changed tracks |
| --- | --- |
| `monster-walk` | 24 |
| `monster-run` | 35 |
| `monster-turn`, `monster-idle`, `monster-jump`, `monster-roar` | 0 |
| slash, shoot, hurt, dive, death, spawn, knockdown, getup, tail, original preset walk | 0 |

The comparison checks track identity, interpolation, accessor type/count, time bytes and value
bytes, not just sampled poses. Receipt:
`asset-source/playtests/evidence/player-feedback/solkar-final-track-comparison.json`.

| clip | pre-fix muzzle mean / max | final muzzle mean / max |
| --- | --- | --- |
| `monster-idle` | 39.01° / 42.59° | 39.01° / 42.59° |
| `monster-walk` | 74.02° / 78.41° | **38.40° / 41.16°** |
| `monster-run` | 87.84° / 89.53° | **38.40° / 41.17°** |
| `monster-turn` | 38.36° / 39.35° | 38.36° / 39.35° |
| `monster-jump` | 57.46° / 81.65° | 57.46° / 81.65° |
| `monster-roar` | 74.95° / 89.39° | 74.95° / 89.39° |

Jump retains its pre-fix behavior, including its raised-head pose. This locomotion fix does not
claim to correct jump or finite skill poses.

## 5. Preserved contracts

- **Geometry**: unchanged. `actor-solkar.glb` (the Tripo source) is untouched
  (`6c0642903731d796c23a42a9046c732ab3b037475651bbe1c6e725eac536582f`); the jaw repair preserves
  positions, normals, UVs, indices, textures, materials, existing joints and clips, with a maximum
  bind position error of 2.98e-07.
- **Speed / collision**: the walk planting speed is **unchanged** at 0.4425 units/s
  (max slide 0.8%, mean slide 0.4%), so `walkRef = 0.4425 × 3.207 = 1.4191` still matches
  `LATER_LOCOMOTION['actor-solkar'].walkRef = 1.419`. The run planting report remains 1.3454 units/s
  with max/mean slide 0.6%/0.3%; the run stride changes 0.3251 → 0.3476 units and the classified
  stance fraction 0.426 → 0.456. These are not byte-identical leg poses. `runRef` stays 4.315;
  no locomotion-profile or collision code changes.
- **No actor rotation / no skeleton freeze**: the actor's root yaw is untouched by the authoring
  pipeline; the walk and the run still move the head and the tail (measured travel > 0.05 units per
  clip, asserted by the regression).
- **Roar / attack / reaction / skill / contact timing**: `monster-roar`, `monster-slash`,
  `monster-shoot`, `monster-hurt`, `monster-dive`, `monster-death`, `monster-spawn`,
  `monster-knockdown` and `monster-getup` are **byte-identical** to the pre-fix build. The Blender
  skill clips `solkar-rally`, `solkar-search` and `solkar-distract` keep their authored values and
  their release / contact markers.
- **Other companions**: all 14 other quadrupeds are **byte-identical** (sha256 of the authored output
  before and after the change), and the other five companions' final GLBs, their `.blend` and `.json`
  Blender sources and their manifest bindings are unchanged.

## 6. Rebuild receipts (deterministic)

Every step reproduces byte-identically. `bpy` 4.5.14 LTS was used for the Blender step (installed as
the official PyPI wheel into a throwaway virtualenv at `/tmp/wc-bpy-venv`, outside the repository).

| artifact | sha256 |
| --- | --- |
| `asset-source/generated/actor-solkar-runtime-01/actor-solkar.glb` (untouched Tripo source) | `6c0642903731d796c23a42a9046c732ab3b037475651bbe1c6e725eac536582f` |
| `asset-source/generated/actor-solkar-runtime-01/actor-solkar-animated.glb` | `d0fd54830fa02330c7ab7782dc4467a3f5a0475a5c7158a1f8653453583bb262` |
| `asset-source/generated/actor-solkar-runtime-01/actor-solkar-combat.glb` | `75e1253e00dd376af56fd3db8d242cacfa65f4d8dd779a1da4243209ca316ef3` |
| `asset-source/generated/actor-solkar-runtime-01/actor-solkar-companion-rig.glb` | `5721228d98c5458ebfa1f393fad5a461a9f621c861b36ddd9b53c31c43593141` |
| `asset-source/generated/actor-solkar-runtime-01/actor-solkar-companion.glb` (playable) | `eec7b5cd8f37323dd3f37abcb85ff385b19848649b9505f77d3d4c4eb57d65fb` |
| `asset-source/generated/actor-solkar-runtime-01/actor-solkar-companion-rig.glb` (pre-fix baseline, for comparison) | `0dda0a2aed1b58c1212c96229aaeaa1fc5a5709fb5557b3364ce81788d0e37c2` |
| `asset-source/animation/enemy-attack-sources.json` → `actor-solkar.sha256` (source pin) | `d0fd54830fa02330c7ab7782dc4467a3f5a0475a5c7158a1f8653453583bb262` |
| `asset-source/playtests/later.json` → `actor-solkar.outputHash` (runtime binding) | `eec7b5cd8f37323dd3f37abcb85ff385b19848649b9505f77d3d4c4eb57d65fb` |

### Rebuild order

The Blender bake and final companion merge below are scoped to Solkar. Jaw preparation still
iterates Sable/Solkar and deterministically re-emits Sable's unchanged intermediate rig.
The other five playable companions are not re-bound by the scoped merge; without `--ids=`
the merge retains its original all-companion behavior.

```sh
node scripts/assets/author-quadruped-clips.mjs actor-solkar
bun  scripts/assets/author-enemy-attacks.mjs actor-solkar
node scripts/assets/prepare-companion-jaws.mjs
"$BLENDER" --background --factory-startup --python scripts/assets/blender_companion_quadrupeds.py -- solkar
node scripts/assets/build-companion-blender-assets.mjs --ids=actor-solkar
node scripts/assets/build-companion-blender-assets.mjs --check    # -> 'Companion Blender outputs and bindings match.'
```

`--ids=` accepts the bare id (`solkar`) or the asset id (`actor-solkar`); an unknown id is refused
with the list of valid ones.

### The pre-fix baseline

The baseline was rebuilt by disabling only the new flag and re-authoring in memory; it reproduces the
committed HEAD artifact exactly, which is what makes the per-clip diff conclusive:

```
pre-fix sha256 = b2f236c0dbe09df219baa6b05d958f985c8a02c24ca30a704f39112bdae0d71a
equals the committed HEAD baseline b2f236c0...: true
```

The shipped option-C build reproduces its own predicted hash exactly, so the production
implementation and the measured prototype are the same bytes:

```
node scripts/assets/author-quadruped-clips.mjs actor-solkar
  output sha256 = d0fd54830fa02330c7ab7782dc4467a3f5a0475a5c7158a1f8653453583bb262
  (matches the option-C hash measured before the change was applied)
```

## 7. Regression test

`tests/rendering/solkar-pose.test.mjs` samples the playable GLB and covers four visible invariants:

1. Walk muzzle maximum below 50°, mean within 6° of idle.
2. Run muzzle maximum below 50°, mean within 6° of idle.
3. Turn muzzle mean within 6° of idle.
4. Walk/run still move the head and tail rather than freezing the skeleton.

The worker observed causal pre-fix failures at 78.41° (walk) and 89.53° (run). After the final
option-C handoff, the coordinator ran Node 24.22.0
`--test tests/rendering/solkar-pose.test.mjs`: **4 passed, 0 failed**. These results use the final
playable hash, not the worker's earlier tests against rejected build B. The integrated gate remains
separate from this focused pose gate.

## 8. Native preview and contact observations

The coordinator loaded final playable hash
`eec7b5cd8f37323dd3f37abcb85ff385b19848649b9505f77d3d4c4eb57d65fb`
through the actual `NativeAssetLoader`, `mountCompanionPreview` and animation driver in local
Brave at an observed 1440×900, DPR 1. Three real WebGL canvases rendered idle, walk and run.

| action | mean over 90 rendered frames | observed maximum |
| --- | --- | --- |
| idle | 39.83° | 42.58° |
| walk | 38.44° | 41.13° |
| run | 38.45° | 41.16° |

These are rendered-frame observations, not full-cycle averages or reference performance scores.
The same driver exercised run→turn→idle and walk→idle, then `crown-rally`, `solkar-search` and
`solkar-distract` over 3.21 seconds. Finite skills retain their intentionally raised-head gestures;
the locomotion angle bound does not apply to them. All preview handles/loaders were disposed.

- [Native pose PNG](../player-feedback/after-solkar-native-preview.png)
- [Native locomotion video](../player-feedback/after-solkar-native-preview.webm)
- [Native skill video](../player-feedback/after-solkar-native-skills.webm)
- [Bone samples and transitions](../player-feedback/after-solkar-native-preview.json)

An additional all-vertex check sampled 30,077 skinned vertices at 30 Hz against the raw rest-skin
floor. Compared with the pre-fix GLB, the worst skin-depth increase is 3.56 mm for walk and 6.28 mm
for run at the actual manifest scale 3.207; idle/turn are identical. This measures raw skinned
foot vertices, not the in-world grounding layer or terrain collision, and does not claim exact
contact-pose equality. Data:
[full-cycle samples](../player-feedback/solkar-locomotion-contact-smoke.json) and
[before/after comparison](../player-feedback/solkar-contact-before-after.json).

Candidate evidence remains blocked. No release qualification or verified-asset promotion follows
from this local preview.

## 9. Integrated in-world source smoke

The coordinator exercised the real native actor through the existing explicitly marked DEV showcase,
with `replay: true` and NoSave. This is not an earned-campaign companion grant. The actor used its
natural spawn; no pose, animation slot, position or collision was forced.

- [Actual idle/walk/run recording](../player-feedback/after-solkar-in-world.webm), 1440×900, 7.15 seconds.
  The native controller selected `monster-idle`, `monster-walk` and `monster-run`; rendered muzzle
  means were 36.98° at idle, 38.94° during the slow-walk input and 38.14° during sprint input.
  Solkar stopped at real terrain during the first player-turn phase; that phase is **not** claimed
  as moving-turn proof.
- [Actual moving-turn/stop recording](../player-feedback/after-solkar-in-world-turn.webm), 1440×900,
  4.23 seconds. On the clear return route the companion travelled 1.231 m during the turn, with
  facing changing from `(-0.817, 0, 0.577)` to `(-0.007, 0, -1.000)`. The native controller selected
  walk/run, then run→walk→idle after release. Moving-turn muzzle maximum was 41.58°; the overall
  second-recording maximum was 43.87°. The inspected recordings retain live gait and neck motion
  rather than a frozen skeleton or skyward head.
- [First raw sample stream](../player-feedback/after-solkar-in-world.json) and
  [turn sample stream](../player-feedback/after-solkar-in-world-turn.json). `nativeAction` records
  the actual selected slot. The raw `clips` arrays enumerate weighted mixer allocations, including
  inactive allocations; they are **not** evidence that every listed skill played.

These local Apple M1 recordings are functional pose/transition observations, not physical-controller,
reference-hardware performance, rights/consent or release qualification.


## Reproduce

| script | purpose |
| --- | --- |
| `/tmp/wc-solkar-proof/build-prefix.mjs` | rebuilds the pre-fix baseline into `/tmp` without touching the repository |
| `/tmp/wc-solkar-proof/perclip-diff.mjs` | per-clip, per-channel comparison of the two builds |
| `/tmp/wc-solkar-proof/jump-detail.mjs` | per-channel and per-frame deltas for the jump / walk / run |
| `/tmp/wc-solkar-proof/joint-delta.mjs` | per-joint world position and rotation deltas |
| `/tmp/wc-solkar-proof/world-delta.mjs` | world-motion deltas of the paws, muzzle and tail |
| `/tmp/wc-solkar-proof/jump-knee.mjs` | the jump's muzzle elevation and the knee world deltas |
| `/tmp/wc-solkar-proof/leg-mechanism.mjs` | isolates the neck-lift → knee-shift mechanism |
| `/tmp/wc-solkar-proof/jump-semantics.mjs` | the jump's authored neck/head pitch and Root travel |
| `/tmp/wc-solkar-proof/three-way.mjs` | the three-way value-level comparison (A / B / C) |
| `/tmp/wc-solkar-proof/verify-C.mjs` | option C's muzzle elevations and the jump's restoration |
| `/tmp/wc-solkar-proof/locomotion-only.mjs` | builds option C in memory and compares its track sets |
| `tests/rendering/solkar-pose.test.mjs` | permanent working-tree regression |

Every script in `/tmp/wc-solkar-proof` writes only under `/tmp` and restores the repository source
file afterwards; `build-prefix.mjs` and `three-way.mjs` assert that restoration explicitly.

The `/tmp/wc-solkar-proof` tree is kept intact as raw evidence.
