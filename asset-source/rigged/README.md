# Provider-native rig input packet

These are immutable Tripo rig/walk inputs and measured diagnostics for R09, not production-qualified characters or completed canaries. R09 requires Aren Idle + lateral Dodge and Asha Idle + Pounce; a skeleton or generic walk does not meet that acceptance.

## Reproducing the CPU probes

The root `npm ci` supplies Three.js 0.169.0 but **does not supply `sharp`**. Aren's `verify-native.mjs` and authored CPU-loader helpers additionally require external **sharp 0.34.5** to decode the actual embedded PNG/JPEG images. An observed local sharp version is not a repository dependency declaration. Without this prerequisite, the probe fails with `ERR_MODULE_NOT_FOUND` before loading the GLB; do not interpret that as an asset result or skip textures to claim full-loader proof.

If the operator approves installing this optional local asset-tool dependency, run from the repository root:

```sh
npm ci
npm install --no-save --package-lock=false sharp@0.34.5
node asset-source/rigged/actor-aren/verify-native.mjs asset-source/rigged/actor-aren/rig/tripo-out/rig-3-1fc43928/model.glb
node asset-source/rigged/actor-asha/inspect-skin.mjs asset-source/rigged/actor-asha/rig/model.glb
node asset-source/rigged/actor-asha/smoke-walk.mjs asset-source/rigged/actor-asha/walk/tripo-out/retarget-5-f9fb3a0f/model.glb
```

The install command is an explicit optional operator step, not executed by this handoff. Running it at the repository root puts sharp in the ancestor `node_modules` resolved by these ESM scripts; no machine-specific absolute path or `NODE_PATH` assumption is required. The normal game runtime does not depend on sharp. Python asset crop/texture tooling separately requires Python 3 and Pillow; it is not supplied by npm.

CPU GLTFLoader/AnimationMixer/skin scans do not prove GPU texture upload, likeness, contact quality, usable anatomy, frame rate or production acceptance. Binary integrity can also be checked with the existing `node scripts/assets/inspect-glb.mjs <file.glb>`; that structural inspector does not measure rig quality.

## Known native inputs and limits

- Aren rig: task `1fc43928-8af8-4cf2-a97d-2c2a5b4ee658`, 96,501,240 bytes, SHA-256 `7e759a4607f530137dfe58d0dcffecefd697030bcce6fbc2134625051b068151`, one skin/18 joints/no provider clips. Documented idle/walk retarget requests failed with provider error 1004. Requested rig model is recorded; the provider-resolved rig version is unavailable, not inferred.
- Asha rig: task `15fc35a2-5113-4d6c-8207-13eaf0d18ef1`, 99,518,156 bytes, SHA-256 `081579ba678e764a53a6f7ad5ab707d8fd31463bf4527eb316c787a623ab8ba0`, one skin/21 joints. The original rig has only three independently segmented leg chains; the negative-X forepaw shares torso/neck influence. It is not a qualified quadruped rig.
- Asha walk: task `f9fb3a0f-5223-4728-961c-7bf399d4f8da`, 99,541,840 bytes, SHA-256 `d6d1c1b23ec1daed291b6d3c36425baa00fb4f5b04157b910271c7efadfcafe9`, one native 16-channel `preset:quadruped:walk` clip. It is neither Idle nor Pounce.
- Aren's original lower staff has an unintended toe influence and a measured rest-surface gap from the hand/body. A weight-only derivative cannot by itself prove literal grip contact. Custom rig/clip derivatives and their independent measurements are tracked outside these immutable provider directories.
- Known successful processing credits are 25 + 25 + 10; failed-request costs/refund amounts and account-wide attribution are not guessed. Consult each actor's sanitized provenance and request records.

Preserve source hashes, native node/joint order and actual inverse binds. A corrected skin or authored clip revision invalidates the corresponding old deformation/contact captures. Do not promote the runtime manifest or release gates based on this packet.
