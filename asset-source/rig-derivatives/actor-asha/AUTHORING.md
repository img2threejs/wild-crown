# Asha negative-X foreleg skin derivative

Revision: `asha-negativeX-foreleg-v1`. This directory owns the offline custom skin/rig derivative, not Tripo geometry and not the separately authored Idle/Pounce clips.

## Immutable source and scope

Input is `asset-source/rigged/actor-asha/rig/model.glb`, SHA-256 `081579ba678e764a53a6f7ad5ab707d8fd31463bf4527eb316c787a623ab8ba0`, 99,518,156 bytes. The existing native skin has 21 joints, with its negative-X forepaw sharing torso/neck influences instead of an independent limb chain.

Output `model.glb` is SHA-256 `c93dcd4f8ef93de40093e2c5b89a5296e7afaa5b47f0ecab495c380f08578712`, 99,519,388 bytes. It retains 5,338,212 bytes below GitHub's 100 MiB artifact threshold. No geometry reduction, texture modification, provider generation, or hidden artifact deletion was used. The original source is untouched.

`author-rig.mjs` replaces the existing JOINTS_0 and WEIGHTS_0 buffer views and extends the existing inverse-bind view by three matrices. The BIN chunk contains the same ten live views, repacked with four-byte alignment and corrected offsets. It does not retain dead duplicate old skin buffers. POSITION, NORMAL, UV, indices, and embedded image bytes are compared byte-for-byte against input; materials and texture/image definitions are also checked. Original 21 joint indices, node rest transforms, and inverse-bind bytes are preserved.

## Anatomical authoring and bounded topology

Read-only anatomy inputs are the original native GLB and `asset-source/authored/actor-asha/{anatomy-inspection.json,contact-markers.json,custom-rig-handoff.json}`. Native coordinates are +Y up, head toward +Z; negative-X is a geometric side, not a verified anatomical left/right label. Native units are not certified meters.

The exact connected region is seeded by actual sole POSITION vertex 791041. Candidate bounds are X [-0.24,-0.065], Y [0,0.30), Z >=0.29 and Z <= `0.49 - 0.13 * clamp((Y - 0.16) / 0.14, 0, 1)`. Connectivity uses native triangle edges restricted to the candidate, plus POSITION seam welding quantized at 1e-7 native units. All 95,483 bounded candidates form the seed component. All eight original negative-X sole markers belong to it. The actual measured bounds and 0.02-unit surface slices are in `region-design.json`.

The exact edited POSITION-index list is `reweighted-vertices.uint32le`, unsigned little-endian 32-bit vertex indices, not triangle indices. Its hash is pinned in `provenance.json`. All 894,123 vertices outside it preserve their JOINTS_0/WEIGHTS_0 bytes.

| New glTF node | Skin joint | Authored control | Authored world pivot |
| --- | --- | --- | --- |
| 23 | 21 | negative-X fore shoulder | (-0.145, 0.285, 0.34) |
| 24 | 22 | negative-X fore elbow | (-0.15, 0.16, 0.36) |
| 25 | 23 | negative-X fore wrist/paw | (-0.13, 0.06, 0.39) |

These pivots are **authored anatomical choices informed by measured surface slices**, not measurements of provider joints or a claim of visual anatomical acceptance. Shoulder parent is original node 10 / skin joint 7; elbow and wrist are genuine descendants. Each proper right-handed world quaternion points its local +Y toward the next pivot, with wrist toward the authored distal sole direction (-0.125,0.02,0.43). The local TRS is decomposed from inverse(actual parentWorld) × desiredWorld. Each appended IBM is inverse(actual composed childWorld), serialized float32. Existing bones are never rebound to identity.

Weights transition wrist to elbow over Y [0.045,0.10], elbow to shoulder over [0.10,0.22]. Shoulder-to-original-torso blend fades over Y [0.18,0.30]. Above Y 0.14, additional lateral/posterior/anterior smoothstep boundary fades avoid an abrupt shoulder selection edge. Each edited vertex has at most four normalized influences. Parent visual review must still qualify the anatomical boundary and deformation appearance.

## Reproduce and measure

From the worktree root, using already-installed dependencies:

```sh
node asset-source/rig-derivatives/actor-asha/inspect-region.mjs
node asset-source/rig-derivatives/actor-asha/author-rig.mjs
node asset-source/rig-derivatives/actor-asha/author-rig.mjs --export
node asset-source/rig-derivatives/actor-asha/measure-rig.mjs
```

The authoring command without `--export` only publishes measured region design. Export regenerates the derivative and initial provenance. Measurement regenerates the packet, verifies source/artifact/authoring hashes, and links the successful proof into provenance. No other asset directory is written. `inspect-region.mjs` retains the wider read-only anatomical slice probe for reproduction.

The instrument is actual Three.js GLTFLoader hierarchy/skin creation and SkinnedMesh.applyBoneTransform CPU deformation. Image decoding is deliberately skipped, so texture appearance and rendering are not measured. All 989,606 native deformed-rest vertices are compared. The measured maximum difference is 3.0922188431157833e-7 native units, at vertex 585625. The calibrated threshold is 1.0786823299284757e-6, derived **only from immutable input** as twice the original all-vertex neutral bind residual (4.0514206454064235e-7) plus eight times actual float32 native-world coordinate rounding residual (3.354977510589886e-8).

The initial measurement implementation incorrectly compared POSITION × meshWorld with native skinned world positions, ignoring this GLTFLoader skin's identity bindMatrix and attached bindMatrixInverse cancellation. That over-large tolerance incorrectly accepted an actual 0.025-unit IBM corruption. The corrected ideal reference is POSITION × bindMatrix × bindMatrixInverse × meshWorld in matching matrix space; the unchanged corruption now fails. The old failed result is not qualification evidence.

All 24 actual IBMs are finite/invertible and world × IBM residual is below 1e-6; original IBM bytes remain identical. Maximum observed weight-sum error is 5.21540641784668e-8. Finite vertex results and in-range joint indices are asserted.

Every new control separately receives -0.35 rad local-X articulation, with all vertices measured. Head (116,840 vertices), neck (249,461), chest (137,860), and all outside-region vertices have exactly zero displacement in each run. Spatial protected-set definitions are recorded in the measurement packet; head/neck sets can overlap. Opposite forepaw and both hindpaw actual sole markers remain unchanged. The wrist run moves the eight negative-X sole markers by 0.02099651293480378–0.028929463890376504 native units, without moving protected regions.

Actual-sole planted-rest constraints pass. Perturbing the new wrist IBM translation by +0.025 native units fails the contact constraint. Reassigning actual sole weights to old torso joint 7 fails the independent wrist-motion constraint. Both corruptions are performed on real loaded skin data, rejected, and restored in memory; they do not modify the saved GLB. These controls prove a usable independent limb, **not** Idle/Pounce contact-slip quality.

## Freeze and canary handoff

The above model hash is frozen for the separate author's corrected-rig canary input. A new skin revision invalidates every old original-rig animation/deformation/contact measurement. Preserved vertex IDs may seed new contact-marker sampling, but their deformed values, bounds, slip, and clip captures must be remeasured against the frozen derivative hash.

The separate owner writes corrected-rig native Idle/Pounce under `asset-source/authored/actor-asha/corrected-rig/` only after Main dispatches that continuation. This derivative contains no clips. Provenance links source, authoring source, region design, edited-index list, derivative GLB, measurement source, and measurement packet by SHA-256.

CPU proof is complete for this rig repair. Parent visual/deformation review and rebuilt native canary gates remain authoritative. Unknown visual and texture quality are null, and releaseVerified remains false. Execution attribution: OpenAI Sol (gpt-6.1-sol); parent review attribution is separate. No project-wide validation was run by this slice.
