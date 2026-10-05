# Asha original-rig Idle + Pounce diagnostic derivative — BLOCKED

**Blocking defect: missing independent negative-X foreleg.** Per parent instruction, this is an original-rig anatomy/derivative/evidence handoff, not a completed canary, four-paw constraint pass, R09 completion, or release approval. Genuine custom quadruped rig/skin correction is required. No torso correction is used to masquerade as an independent fourth leg.

## Pre-keyframe anatomical inspection

Input: immutable `../../rigged/actor-asha/rig/model.glb`, SHA-256 `081579ba678e764a53a6f7ad5ab707d8fd31463bf4527eb316c787a623ab8ba0`, 99,518,156 bytes. `inspect-anatomy.mjs` uses the real Three.js GLTFLoader and CPU skinning for all 989,606 vertices; full original node hierarchy, local rest transforms, skin joint order, weighted surface centroids and dominant-weight bounds are in `anatomy-inspection.json`.

Coordinates: native +Y up; the head-side weighted surface is +Z, tail-side -Z. The following assignments are spatial/influence-based anatomical inferences, not proofs from provider names. X-side labels are geometric (positive/negative), not asserted animal left/right. Rest deformed bounds: X [-0.230697, 0.230697], Y [0.00000005, 0.542802], Z [-0.490724, 0.490724]. Units are native units; meters are unverified.

| Skin joints / glTF nodes | Observed spatial assignment |
| --- | --- |
| 0 / 20 | Root, world [0, .029662, 0], influences dorsal middle surface |
| 1 / 19 | Rear torso/pelvis; centroid [-.0628, .3698, -.2017] |
| 2–4 / 2,1,0 (`1_Left_Limb_*`) | Tail, not paw: rearward chain ending at Z -.397, dominant surface to Z -.491, all above Y .075 |
| 5 / 12 | Mid torso; tiny dominant patch but distributed mixed influence |
| 6–7 / 11,10 (`0_Right_Limb_0/1`) | Front torso/neck chain, NOT an entire right limb; joint 7 also dominates negative-X front-paw surface down to Y .00373 |
| 8–10 / 5,4,3 (`Head_0`, `bone_9`, `bone_10`) | Head-region chain; all are Y .404–.431, Z .313–.348. No jaw/ear-specific identity proven. Joint 10 has broad positive-X upper-front surface influence |
| 11–14 / 9,8,7,6 (`0_Right_Limb_2..5`) | Positive-X front leg: descending chain to paw Y .0335, Z .2787; terminal dominant surface reaches ground |
| 15–18 / 16,15,14,13 (`1_Right_Limb_*`) | Negative-X rear leg: descending chain to paw Y .0297, Z -.1035 |
| 19–20 / 18,17 (`0_Left_Limb_*`) | Positive-X rear leg; short two-joint chain; terminal surface reaches Y .00023, Z -.283 |

Native skin limitation: only three independently segmented leg chains. Negative-X forepaw shares joint 7 with broad front torso; no independent fourth foreleg chain. Preserve this original skin rather than claiming a repaired custom quadruped. Surface contact constraints must measure all four spatial paw regions, including that poorly isolated forepaw. Head joints 8/9 have no >=.5 dominant vertices, but do have nonzero mixed influence; this is not absent skinning.

## Contact and root policy (before keyframes)

Contact markers are actual lowest skinned vertices in four spatial paw regions, selected from the complete native rest surface, not bone names. Measure every selected vertex individually, not just a centroid; save IDs and influence coefficients. Native floor is Y=0; preserve each rest sole point's offset, since sole bottoms differ slightly. Slip is distance from each marker's own world-space planted reference, horizontal and vertical reported separately, in native units.

The intended Idle is a closed in-place breathing/head loop with planted paws; the original-rig diagnostic fails fourth-paw planting as measured below. Pounce is an in-place-horizontal visual one-shot with anticipation/compression, extension/takeoff, airborne gathering, landing compression and recovery; fourth-paw planting also fails. Native root has vertical visual lift only (no X/Z displacement). Simulation/engine actor pose remains authoritative for horizontal relocation, collisions and hit windows. CPU measurements use an identity external actor pose, not a fabricated gameplay trajectory. Parent integration must use explicit in-place policy (which does not strip native visual root Y) and sample from authoritative phase time; compensated native-root stripping removes flight. No manifest edits are owned here. Continuous engine/collider/contact integration remains R04.

Articulation uses original joint rotations/translations. Offline translation constraints are applied only to the three segmented leg surfaces, never to front torso to hide the missing fourth chain. This does not modify bind matrices or skin weights. All four paw sets are measured, so the missing-chain failure remains visible. No fourth-leg anatomical independence, final render quality, production acceptance or LOD readiness is claimed.

## Ownership and reproduction

Only this output directory is owned. Provider rig/walk evidence and source GLB are untouched. No paid tasks, browser, dependency installs or shared manifests. Parent owns actual textured/render review, authoritative gameplay integration and acceptance. Author/run commands and final measured results are appended after CPU canary execution.

## Scoped reproduction and observed results

Run from the worktree root (existing Three.js dependency only):

```sh
node asset-source/authored/actor-asha/inspect-anatomy.mjs
node asset-source/authored/actor-asha/author-clips.mjs
node asset-source/authored/actor-asha/measure-canary.mjs
node asset-source/authored/actor-asha/export-foreleg-regions.mjs
```

Derivative: 99,595,212 bytes, SHA-256 `7cec55eec3a90827f98b93915223023e4fa5d7fbd6957ea82ca895c48f08e93c`. Real native animations are Idle (3.200000048 s, 14 channels, 193 keys/channel) and Pounce (1.799999952 s, 21 channels, 109 keys/channel). Original binary prefix, joint order, inverse bind matrices, hierarchy, meshes, weights, UVs, materials, textures and existing accessors/views are preserved; only animation accessors/views/data and animations are appended. The source is SHA-pinned at every reproduction run.

Real GLTFLoader/AnimationMixer playback measures 2,080 surface vertices at approximately 120 Hz: 386 Idle samples and 217 Pounce samples. All sampled vertices/bone matrices and all authored key values/times are finite. Idle endpoint closure and Pounce recovery closure are zero sampled displacement. Peak sampled deformations are .012237640 and .204811280 native units, respectively. All-989,606-vertex deformed bounds are measured at five Idle and nine Pounce phase times (not continuous all-vertex bounds).

| Paw region | Idle max horizontal / vertical error | Pounce planted-window max horizontal / vertical error |
| --- | --- | --- |
| Missing negative-X front | .006133404 / .009237190 | .002749605 / .018552260 |
| Positive-X front | .000009228 / .000792135 | .000014126 / .000989989 |
| Negative-X rear | .000002498 / .000062559 | .000028778 / .000546534 |
| Positive-X rear | .000004329 / .000082492 | .000044568 / .000720409 |

Pounce planted measurement windows are [0, .38] and [1.16, 1.8] seconds; no planted status is claimed during release/flight/landing transition. Missing front sole penetrates to Y -.018307169 during compression; this is a failed requirement, not tolerated/approved contact. Even other paws have small residuals, reported rather than labeled constraint-pass. Flight at .8 s has whole-surface minimum Y .178081141. Native root horizontal excursion is numerical noise (~5.4e-20); visual vertical lift is .19. Negative control strips root to bind Y and loses .19000000025 visual lift, proving native-root stripping invalidates this pose policy.

Instrument controls: planted rest displacement 0; injected .05 actor-X slide measured .05000000224 and rejected; no-op deformation 0 rejected; both authored deformations detected. These controls establish instrument sensitivity, not anatomy/animation acceptance. Original source is 989,606 vertices / 1,934,187 triangles, one source mesh/LOD; no lower LOD, texture decode, browser rendering, production frame-time/memory or gameplay integration measured. Unknown metrics are null.

## Custom rig owner handoff

`custom-rig-handoff.json` names exact native vertex-index files and source joint/node identities. Lower missing-foreleg candidate: 86,688 vertices, X [-.24,-.07], Y [0,.20], Z [.18,.49]; average joint-7/node-10 weight .806643232. Upper candidate: 48,463 vertices, X [-.24,-.07], Y [.20,.34], Z [.16,.49]; average joint-7/node-10 weight .968905494. Binary `.uint32le` files contain every selected original vertex index. These are spatial candidates with neck/chest overlap, not reviewed anatomical partitions or replacement weights. Eight exact negative-X front sole indices are 791041, 729372, 776466, 695594, 604253, 626071, 777106, 601145; original position/influence coefficients are in `contact-markers.json`. Custom rig owner must inspect geometry/topology and create a genuine independent limb chain + corrected skin while preserving immutable Tripo source. Parent owns render review and acceptance.

Actual advancing-mixer mode checks are in `temporal-playback.json`: Idle LoopRepeat returns to phase .1 after one additional cycle with 3.7037e-16 surface recurrence error; Pounce LoopOnce clamps at 1.799999952 s with zero sampled recovery error. These temporal checks do not change the blocking fourth-paw planting result.
