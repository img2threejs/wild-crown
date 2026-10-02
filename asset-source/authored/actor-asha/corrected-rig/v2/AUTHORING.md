# Asha v2 native Idle + Pounce processing canary

## Parent-confirmed immutable processing input

Input `asset-source/rig-derivatives/actor-asha/v2/model.glb`, revision `asha-negativeX-foreleg-v2`, SHA-256 `94bd738c8348e1713309d2023a4307eabdfb826bea4d23e203e571c3bddd41d6`, 99,519,480 bytes. This is a numerical processing-source freeze, not final anatomical or visual acceptance. Preserve its geometry, UV/material/texture buffers, repaired weights, all 24 inverse bind matrices, joint order and node rest transforms. Original Tripo input and all v1 source/canary evidence remain untouched and blocked; no previous capture or calibration is used.

## Actual loaded anatomy before keyframes

Fresh `inspect.mjs` uses real Three.js 0.169 GLTFLoader and CPU native skinning across all 989,606 vertices. `anatomy.json` contains every actual node, local translation/quaternion/scale, world rest position, skin joint order and IBM. +Y is native world up; head-side +Z, tail-side -Z. Units are native, not verified meters. X-side names are spatial, not an assertion of animal left/right.

- Pelvis/mid/front torso: nodes 19/12/11/10. Numbered `0_Right_Limb_0/1` are front torso/neck by hierarchy and influence, not a complete leg.
- Tail: nodes 2/1/0, despite numbered `1_Left_Limb` provider names; rearward surface Z reaches -.491 above the ground.
- Head region: nodes 5/4/3 (`Head_0`, `bone_9`, `bone_10`). Jaw/ear-specific identity is not proven; terminal node 3 has actual upper-front weighted surface influence.
- Positive-X foreleg: nodes 9/8/7/6, descending to actual front sole.
- Negative-X rear leg: nodes 16/15/14/13.
- Positive-X rear leg: nodes 18/17, a native short two-joint chain.
- Corrected negative-X foreleg: nodes 23/24/25, skin indices 21/22/23, true shoulder→elbow→wrist under native front-torso node 10. Actual world rest pivots [-.145,.285,.34], [-.15,.16,.36], [-.13,.06,.39]. All 13,960 complete corrected fore sole vertices have ONLY positive-weight wrist23 ownership in this freshly loaded source.

All-vertex rest bounds: X [-.230697045,.230696915], Y [.000000050,.542801989], Z [-.490724152,.490724296].

## Contact definition and motion/root policy

Fresh `contacts.json` contains every near-floor native skinned vertex with Y<.015, classified exactly once: 13,960 negative-X front, 14,241 positive-X front, 10,826 negative-X rear, 10,787 positive-X rear; total 49,814. Unclassified and overlapping counts are zero, enforced by actual inspection. This includes the full previously omitted front toes; no narrowed marker set or centroid proxy. Spatial partition: front Z>.18 split at X=.015; rear negative X<-.10,Z<0; rear positive -.025<X<.11,Z<-.12. Rest coordinates and actual repaired JOINTS_0/WEIGHTS_0 are recorded for every sole vertex.

Only actual sole-owner world transforms are kept stationary during planted phases. The new fore sole owns only wrist23; native broad torso joint7 is NOT pinned to hide a toe defect. The three original paws retain real mixed influence sets (fore positive:8/9/12/13/14; rear negative:0/17/18/20; rear positive:20); these original sole influences require native local compensation. Original weights and bind matrices are never changed by clip authoring. No runtime IK is substituted for real native animation channels.

Idle: 3.2-second closed breathing/chest/head/tail loop. Pounce: 1.8-second one-shot, body anticipation/compression [0,.4], takeoff [.4,.55], flight [.55,1.08], landing [1.08,1.16], planted compression/recovery [1.16,1.8]. Key streams include exact native Float32 phase boundaries, especially 1.16, as well as 120-Hz keys. Body motion is actual torso/upper-leg translations plus head/tail and four-chain flight rotations. Planting is measured at both keys and non-key/phase times, never merely asserted from bone names.

**In-place horizontal policy:** native root X/Z do not carry gameplay travel. Visual native root +Y lift occurs only during release/flight/landing, and stays at bind during planted windows because an original rear sole has root influence. External actor pose, collisions and hit windows remain authoritative simulation state; CPU probes use identity external actor pose. Retain native visual root Y. Resetting the entire native root translation to bind strips flight and is a negative control. Local root bind Y (~-.241893) and native world root Y (~.029662) differ under the preserved Armature transform; local root Y is not terrain height. Continuous engine/collider/contact integration remains parent/R04 owned.

## Measurement contract and reproduction

All 989,606 vertices, all 49,814 sole vertices, finite skin matrices and deformed bounds are measured at every exact key, phase boundary and non-key 240-Hz sample. Fresh native bind calibration compares POSITION→bindMatrix→bindMatrixInverse→meshWorld with CPU skinned positions in the same attached-skin world space. Independent stationary Float32 TRS serialization and native-world Float32 coordinate rounding controls establish the numerical allowance BEFORE authored motion is measured. The allowance is never selected from motion residuals or widened to force a pass.

Controls include injected actor-X slide, serialized native no-op clips, in-memory sole-compensation-inert clips, stripped-native-Y flight, and all four physical leg-chain rotations made inert. Actual advancing LoopRepeat and LoopOnce playback must close/recover across all vertices. Torso/head surface phase measurements must show breathing, anticipation and landing compression. Controls are throwaway in-memory native GLBs; no altered control asset ships.

Run from the R09 worktree root, using only its existing pinned dependencies:

```sh
node asset-source/authored/actor-asha/corrected-rig/v2/inspect.mjs
node asset-source/authored/actor-asha/corrected-rig/v2/author.mjs
node asset-source/authored/actor-asha/corrected-rig/v2/measure-chain-controls.mjs
node asset-source/authored/actor-asha/corrected-rig/v2/measure-body-phases.mjs
node asset-source/authored/actor-asha/corrected-rig/v2/measure.mjs
node asset-source/authored/actor-asha/corrected-rig/v2/measure-idle-inertness.mjs
```

Parent owns actual textured/render review and integration, Astra owns review. Numerical evidence does not mean visual/final-rig/release qualification. No browser, provider spend/task, install, shared manifest, commit or push. Unknown usage, lower-LOD readiness, production memory/frame-time and integration metrics remain null.

## Observed numerical result (not visual or release approval)

Complete run returned exit 0 and `FOUR_PAW_NUMERIC_CANARY_EVIDENCE`. Measurement timestamps: 2026-10-01T09:17:32.465Z through 2026-10-01T09:22:32.596Z. Native derivative SHA-256 `769b67ef5c82b34f631a12799b12c48d8bffc9eb50e0809be53e6143a6ec7254`, 99,679,580 bytes (5,178,020 bytes below 100 MiB). Source binary prefix and all repaired geometry/skin/IBM/node/material/accessor/view contracts are preserved; only native animation metadata/accessors/data are appended.

Idle is 3.200000047683716 s, 9 genuinely changing channels, 385 keys/channel. Pounce is 1.7999999523162842 s, 33 changing channels, 221 keys/channel including exact phase-time keys. Every key/time and native sampled skin matrix is finite; times strictly increase and rotation keys are normalized. No bind/no-op fallback, renamed walk or omitted fourth toe patch.

All 989,606 vertices and their deformed bounds were measured at every one of 1,145 Idle and 656 Pounce exact-key/phase/non-key samples: 1,782,280,406 finite vertex samples. All 49,814 actual sole vertices were measured at each sample. Fresh calibration: native bind residual 4.0514206454e-7, stationary Float32 animation residual 3.0675952686e-8, world-coordinate Float32 rounding residual 3.3549775106e-8; independently computed allowance 1.1400342353e-6 native units, not selected from motion.

| Sole region | Idle max horizontal / vertical error | Pounce planted max horizontal / vertical error |
| --- | --- | --- |
| Negative-X front (13,960) | 4.5032e-9 / 1.7834e-8 | 4.1327e-8 / 4.8480e-8 |
| Positive-X front (14,241) | 5.0129e-9 / 1.7818e-8 | 2.6126e-8 / 4.8483e-8 |
| Negative-X rear (10,826) | 5.2713e-9 / 1.8089e-8 | 1.9516e-8 / 2.3314e-8 |
| Positive-X rear (10,787) | 1.5739e-9 / 2.0195e-8 | 9.6212e-9 / 1.8997e-8 |

Pounce planted windows are [0,.4] and [1.16,1.7999999523]. Exact 1.16 landing sample restores native world root Y .0296619833; full-mesh minimum Y is 2.2849e-8 and worst sole vertical error is 4.8483e-8. The original off-grid landing residual was repaired by a real boundary key, not a relaxed tolerance.

Actual 85,809-vertex torso centroid changes: Idle +.002776089 / -.002776089 at quarter/three-quarter cycle; Pounce anticipation -.031993877 and landing compression -.025594995, followed by restored end torso/head centroids. Idle head-region surface moves subtly. Full-surface maximum deformations are .003950380 and .193685442; Pounce non-rigid movement excluding root lift reaches .043439663. All four actual chains articulate locally in flight; their rotation-inert controls are exactly zero. Native broad torso node10 (skin7) is not a sole-compensation target.

Idle advancing LoopRepeat recurrence and same-clip endpoint closure are zero all-vertex displacement. Pounce LoopOnce clamps at the real duration; end-to-start closure is zero and recovery against corrected-source rest differs only by 3.0463e-8 native serialization residual. Horizontal native-root excursion is zero/5.4210e-20. At flight .8 s, native root lift is .1799999992 and the complete mesh has minimum Y .1697866380. Stripping native root Y removes that lift and produces minimum Y -.0102133622: the negative control rejects flight.

Independent stationary contacts are detected. Injected .025 actor-X slide rejects every complete paw; serialized native no-op peak is only 3.0463e-8 and rejects motion; removing sole-compensation translations rejects all four paws. Detailed per-vertex extrema, actual phase samples, controls and hashes are in `canary-packet.json`, both sample files, `body-phase-measurements.json`, `chain-articulation-controls.json`, `provenance.json` and `evidence-index.json`.

Source LOD limit remains 989,606 vertices / 1,934,187 triangles, one native skinned mesh/LOD. No lower LOD, texture decode, GPU memory/frame time, actual browser render, gameplay movement/collider/contact integration or final visual/anatomical acceptance measured. These remain null/pending. Parent and Astra must review the actual render and integration; `releaseVerified` remains false.

Explicit Idle inertness proof is also persisted in `idle-inertness-control.json`: genuine serialized/native-loader Idle movement at0/.8 over all989606vertices is .003950371825; replacing every Idle output sample with its first key in a throwaway GLB gives exactly0 all-vertex motion and is rejected. Both authored clip motion detectors therefore have actual native no-op negatives, not a claim inferred from clip names. The final foreground native smoke freshly loaded the frozen V2/derivative, measured all49814sole vertices, observed airborne all-vertex bounds, exact1.16 planted landing and clamped Pounce; exit0.
