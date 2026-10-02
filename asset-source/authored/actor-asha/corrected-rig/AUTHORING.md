# Corrected Asha native Idle + Pounce — processing source v1 BLOCKED

## Authorized processing source (not render acceptance)

Parent authorizes `asset-source/rig-derivatives/actor-asha/model.glb`, revision `asha-negativeX-foreleg-v1`, 99,519,388 bytes, SHA-256 `c93dcd4f8ef93de40093e2c5b89a5296e7afaa5b47f0ecab495c380f08578712`. Preserve its repaired weights, all 24 inverse bind matrices, joint order, node rest transforms, geometry, UV/material/texture buffers. The original 21-joint source and original blocked diagnostic directory stay untouched. No old deformation, contact or bounds captures are reused.

## Actual anatomy inspected before keyframes

`inspect.mjs` parses the frozen repaired GLB with genuine GLTFLoader and skins all 989,606 vertices. `anatomy.json` contains every actual original/new local transform, world position and inverse bind matrix. Native coordinates remain +Y up, head-side +Z, tail-side -Z. Native units are not asserted meters; geometric X sides do not prove animal left/right.

The original spatial anatomy map is independently rechecked against this source's actual loaded hierarchy: pelvis/mid/front torso nodes 19/12/11/10; tail nodes 2/1/0; head-region nodes 5/4/3; positive-X foreleg nodes 9/8/7/6; negative-X rear leg nodes 16/15/14/13; positive-X rear leg nodes 18/17. New negative-X foreleg nodes 23/24/25 (skin indices 21/22/23) are an actual shoulder/elbow/wrist chain under node 10, at native world [-.145,.285,.34], [-.15,.16,.36], [-.13,.06,.39]. This source is a numerical authoring input, not anatomically/visually approved final art.

Rest all-vertex bounds: X [-.230697045, .230696915], Y [.000000050, .542801989], Z [-.490724152, .490724296].

## Complete contact definition and authoring policy

`contacts.json` is newly measured from this repaired source. Sole patches are every native skinned surface vertex Y<.015 in four explicit spatial paw regions. Complete near-floor coverage is enforced: 49,814 classified vertices, zero unclassified; negative-X front 13,960, positive-X front 14,241, negative-X rear 10,826, positive-X rear 10,787. Each actual vertex's rest point and repaired JOINTS_0/WEIGHTS_0 are recorded. Front partition is Z>.18 split at X=.015; rear negative-X uses X<-.10,Z<0; rear positive-X uses -.025<X<.11,Z<-.12. All source near-floor vertices must match exactly once or inspection fails.

**Processing-source blocker:** complete coverage discovers 1,099 front-toe vertices X[-.0699915,-.0543305], Z[.4021015,.4562506] outside the initial narrow region; 337 are new-wrist-only, 762 retain mixed legacy torso/head/opposite-leg weights. The complete negative-X front sole includes joints 7/8/9/12/17/23, not just 23. Rig owner confirms this is a real residual skin-coverage defect. Do not freeze front torso joint7 to make planting pass. The author script now rejects any corrected forepaw with legacy (<21) influence before emitting a derivative. A new bounded repaired source freeze requires Main authorization; the c93dcd input remains unchanged.

After a genuinely independent full-sole repaired freeze, planted ancestor translations are countered in local translation channels while original three paws retain their measured native mixed-weight constraints. This is offline native-key authoring, not skin edits or runtime IK. All 49,814 sole vertices must be measured; no hidden toe slip or narrowed marker coverage is acceptable.

Idle: 3.2-second closed breathing/chest/head/tail loop, four paw patches stationary. Pounce: 1.8-second one-shot with anticipation/body compression [0,.4], takeoff/release [.4,.55], flight [.55,1.08], landing [1.08,1.16], planted compression/recovery [1.16,1.8]. Native root stays at bind during planted phases (because original rear sole has real root influence); body gathers by torso/hip movement. Root has visual +Y lift only during airborne/release phases, no X/Z curve. External actor pose, collisions and hit windows are authoritative engine state. CPU measurements use identity external pose. In-place policy must preserve native visual root Y; resetting the native root to bind strips flight and is tested as a negative control. Continuous gameplay/collider/contact integration is outside this artifact and remains R04.

No arbitrary contact tolerance is selected to make the motion pass. Calibration and actual residuals must be measured independently from source/native-float32 stationary controls and transform serialization. Acceptance status remains numerical evidence only; parent render/integration and Astra review are required. No browser, provider task/spend, dependencies, shared manifests, commits or pushes.

## Additional actual native motion instruments

`measure-body-phases.mjs` measures a torso surface of 85,809 actual source-skinned dominant torso vertices and a terminal head-region surface of 128,860 vertices. Initial numerical run measured Idle torso centroid +.002776089 / -.002776089 Y at quarter/three-quarter cycle, with restored endpoint; Pounce torso centroid drops .031987666 during anticipation and .025550996 during planted landing compression. These are actual deformed surface regions, not root-only motion or clip labels. Head-region surface also moves; visual naturalness remains parent-owned.

`measure-chain-controls.mjs` independently loads the emitted native GLB at Pounce time .8 and compares normalized local joint rotations to the repaired source. Maximum local rotations for the four physical chains are .249999995, .219999998, .229999975 and .130000055 radians. Removing all four chains' rotation channels in a throwaway in-memory GLB makes each maximum exactly 0; all four inert controls reject motion. Native root/torso translations cannot satisfy this independent articulation instrument. No altered control GLB is shipped.

## Failing-first findings (not current acceptance evidence)

The first complete CPU run rejected its own instrument because comparing raw POSITION*meshWorld against native skin inflated the calibration by a real .271555 transform offset; injected .025 slide and .004 authored Idle motion were consequently not detected. No pass was reported. Calibration now uses the established GLTFLoader bindMatrix→bindMatrixInverse→meshWorld stack, matching native attached skin space.

The first 120-Hz key grid omitted the exact 1.16-second landing boundary: interpolation left native visual root .00002568 above bind and measured negative-X front sole vertical residual .000004311643 at that exact phase boundary. Authoring now persists explicit Float32 phase-time keys and measurement includes every exact phase, key and non-key 240-Hz time. The old narrow-contact derivative is diagnostic only and is invalidated by the expanded full sole footprint. Current processing source remains blocked by legacy foretoe skin weights; no canary completion or qualification is claimed.

`processing-blocker.json` records every one of the 762 mixed sole vertex IDs/positions/weights, the complete 13,960-vertex fore sole and total 49,814-vertex footprint, and explicitly invalidates the narrow-contact diagnostic GLB. Both `author.mjs` and `measure.mjs` reject this frozen source's complete foretoe legacy influence. Real invocation of authoring returns exit 1 before writing a derivative; this is the expected source-defect rejection, not a successful canary.
