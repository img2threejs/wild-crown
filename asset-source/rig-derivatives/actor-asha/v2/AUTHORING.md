# Asha V2: complete negative-X forepaw independence

This is the parent-authorized `asha-negativeX-foreleg-v2` cutover. Output `model.glb` SHA-256 is `94bd738c8348e1713309d2023a4307eabdfb826bea4d23e203e571c3bddd41d6`, 99,519,480 bytes, with 5,338,120 bytes below GitHub's 100 MiB artifact threshold. V2 contains the genuine native 24-joint rig, original Tripo geometry, and no animation clips.

## Why V1 is preserved but invalid for full-paw canaries

Immutable original geometry/rig source remains `asset-source/rigged/actor-asha/rig/model.glb`, SHA `081579ba678e764a53a6f7ad5ab707d8fd31463bf4527eb316c787a623ab8ba0`. Immutable V1 rig derivative remains the parent directory's `model.glb`, SHA `c93dcd4f8ef93de40093e2c5b89a5296e7afaa5b47f0ecab495c380f08578712`. V1 source files, diagnostic packets and asset are not overwritten or deleted.

A complete native near-floor scan by the separate canary author found 49,814 surface vertices below native-world Y=0.015, including 13,960 negative-X fore sole vertices. The earlier narrow forepaw selector omitted 1,099 toes, of which 762 retained mixed legacy torso/head/other-leg influences. The original eight sampled markers were not proof of the complete paw. The exact prior blocker hash/counts are recorded in `v1-coverage-blocker.json`; the detailed read-only input is `asset-source/authored/actor-asha/corrected-rig/processing-blocker.json`.

Every V1 canary/deformation/contact receipt is invalid for V2. Freezing old torso joint 7 during planted animation would conceal the residual defect rather than provide independent paw control and was not used.

## Bounded repair and matrix ownership

V2 authoring reads immutable original native world vertices for topology/region measurement, inherits the genuine V1-authored 24-joint rest hierarchy and actual IBMs unchanged, and extends only the lowfoot skin selection:

- X minimum -0.24; X maximum `-0.05 - 0.015 * clamp((Y - 0.08) / 0.06, 0, 1)`.
- Original Y [0,0.30), Z minimum 0.29 and anterior cutoff `0.49 - 0.13 * clamp((Y - 0.16) / 0.14, 0, 1)` remain unchanged.
- The lateral boundary is exactly the old -0.065 boundary by Y=0.14. Original shoulder boundary fades above that height are unchanged.
- Actual sole vertex 791041 seeds the component. Native triangle-edge connectivity and POSITION-seam welding at 1e-7 native units produce exactly 98,507 connected candidate vertices, 3,024 more than V1.
- All 13,960 complete sole IDs belong to the component. The ordinary distal weight function naturally assigns each sole vertex only wrist skin joint 23 with weight 1; no point-specific patch or legacy torso plant workaround is used.

The existing controls remain glTF nodes 23/24/25 = skin joints 21/22/23, shoulder/elbow/wrist, parented to native node 10 / skin joint 7. All 24 V1 rest node transforms and inverse binds are byte-/definition-identical; in particular the original 21 joint order, rest transforms, and IBM bytes are unchanged. Authored anatomical pivots and proper quaternion frames remain as described in V1 source documentation, not provider-measured joint claims. Parent visual qualification remains required.

Only JOINTS_0 and WEIGHTS_0 live buffer views are replaced; all other buffer bytes, including the extended V1 IBM view, are preserved. POSITION, NORMAL, UV, indices, embedded images, and material/image/texture definitions match immutable original input. The single GLB retains ten live views, aligned/offset correctly, without dead duplicated old skin buffers. The 891,099 vertices outside the hashed edited list preserve their original joint/weight bytes.

## Reproduction and evidence

From the worktree root, with existing dependencies only:

```sh
node asset-source/rig-derivatives/actor-asha/v2/author-rig.mjs
node asset-source/rig-derivatives/actor-asha/v2/measure-rig.mjs
```

The author requires the pinned V1 asset and complete read-only contacts/blocker packets. It writes only this V2 directory. It recreates region/index/footprint/blocker/provenance packets and the native derivative. The measurement script freezes provenance only after every positive and negative assertion passes.

The instrument is genuine Three.js GLTFLoader hierarchy, bind data, and `SkinnedMesh.applyBoneTransform` CPU deformation. Image decoding is deliberately skipped; no render or texture-quality claim is made.

`measurement-packet.json` records:

- All 989,606 native neutral vertices compared to immutable input; maximum residual 3.1342201682047795e-7 native units at vertex 573576. The independently calibrated tolerance is 1.0786823299284757e-6, unchanged from immutable-source calibration: 2 × actual input neutral bind residual + 8 × actual input float32 world-coordinate rounding residual. Reference positions use POSITION × bindMatrix × bindMatrixInverse × meshWorld, not the previously incorrect raw POSITION × meshWorld comparison.
- All weights finite/nonnegative, joint indices valid, and maximum sum error 5.21540641784668e-8. All 24 actual IBMs finite/invertible with world × IBM identity residual below 1e-6.
- A fresh V2 native-world Y<0.015 scan partitions **every** near-floor vertex exactly once. Complete counts and exact ID sets match the pinned reference: front-negative-X 13,960; front-positive-X 14,241; rear-negative-X 10,826; rear-positive-X 10,787; total 49,814.
- Every new shoulder/elbow/wrist control separately articulated -0.35 rad local +X. Each run measures all 989,606 vertices. Protected head 116,840, neck 249,461, chest 137,860 and all 891,099 outside-region vertices have exactly zero movement. Complete opposite fore/hind sole sets, not marker samples, also have exactly zero movement. Head/neck spatial sets can overlap; their indices are hash-derived.
- Across **all** 13,960 negative-X sole vertices, shoulder displacement range is 0.09444496949088517–0.10749714914389957; elbow 0.04988664811135528–0.06899958374617793; wrist 0.014366085710912043–0.03737214480665364 native units.
- Positive planted-rest contact constraints pass for all 13,960 sole vertices. A +0.025 native-unit wrist IBM translation perturbation is rejected for **all 13,960** vertices. Reassigning the complete sole to old torso joint 7 is rejected for **all 13,960** independent wrist-motion constraints. Real loaded runtime weights/IBMs are changed and restored in memory; no corrupted GLB is saved.

`contact-footprint.json` stores the exact 49,814 vertex IDs in paw/row order. `full-sole-rest-and-wrist-flex.float64le` contains nine little-endian Float64 values per vertex in that order: immutable original rest XYZ, V2 neutral XYZ, and V2 wrist-flex XYZ (72 bytes/row). This is actual native CPU position evidence for the complete footprint, not a zero-filled score packet. The measurement packet describes and hashes its layout. Provenance pins original source, V1 source, V2 model, offline authoring, region design, edited indices, complete footprint, prior coverage blocker, measurement source, measurement packet, and full-position evidence.

## New canary and acceptance boundary

Frozen V2 path/hash/mapping/full-proof were sent to Main and the canary author. The conditional consumer output is exclusively `asset-source/authored/actor-asha/corrected-rig/v2/` after Main recipient confirmation. V1 diagnostics are preserved; no original/V1 clip captures, calibration, slip or landing receipts are reused as V2 evidence. Native Idle/Pounce must be freshly authored and measured against this V2 hash.

These rig/contact-control proofs do not certify animation contact quality or visual deformation. Unknown canary and visual quality are null; releaseVerified remains false. Parent/Astra review retains visual/deformation/production-gate authority. No providers, browser, installations, shared manifests, commits, pushes, geometry/LOD/texture alterations, or project-wide validation were used. Execution attribution is OpenAI Sol (gpt-6.1-sol); review attribution is separate.
