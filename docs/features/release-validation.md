# Release validation and build artifacts

Normal development and CI builds remain usable while unfinished content is authored. `npm run build` proves TypeScript/Vite can emit a production bundle; it is not release acceptance and does not assert that character/prop GLBs, rig gates, references or benchmarks exist. The CI build artifact is a diagnostic build artifact, not a release-ready game.

## Commands

```sh
npm ci
npm run build
node --test tests/release/*.test.mjs
node scripts/release/validate.mjs --dist dist
node scripts/release/artifact.mjs --dist dist
```

The strict validator compares canonical asset-source/manifest.json with the normalized manifest emitted at dist/assets/manifest.json, including canonical kind/source type, hashes, content-addressed paths, applicable gates and ActionId mappings. For every native GLB it parses the real GLB v2 header/JSON/BIN structure, rejects external buffer/image URIs, requires sourceHash and outputHash to match emitted bytes, and binds the separate sourceInputHash to the approved reference hash. The preview must serve exact content-addressed bytes with GLB MIME and immutable caching. Composed Environment recipes have no GLB path/hash; their separately verified scene evidence binds current output hashes of every native component.

Verified native asset evidence must bind the asset ID, approved source-input hash, exact native GLB source/output hashes, per-check plugin producer rows, gates, and asset-specific negative controls. Character acceptance additionally requires measured G1/G3/G6/G10 producer output, exact G11 derivative-freeze parity, G12 native-skin joint correspondence where skinned, every required ActionId mapped directly to a named emitted GLTF animation, species-specific applicability evidence, and reviewed visual files bound to the current GLB output hash.
Static props may mark G1/G3 not applicable only when the GLB has no skin or animation and the evidence explains why; they must not invent bones. Static G6 requires asset.extras.wildCrownStaticVisibilityPolicy version 1 partitioning each renderable node into a required row with authored pixel/view thresholds or an explicit exclusion reason, plus rerendered hide-node negative controls for every required node. Static G10 measures each mesh node's materials, vertex/index counts, local/world bounds, float32 cache/accessor parity and finite positions; it must detect both a non-finite-position fault and a deliberately wrong-culling-bounds fault on in-memory copies. G11 freeze parity and G12 no-skin applicability remain required. Unprofiled thresholds do not pass. Test-only fixtures are disposable schema probes, never production assets or asset-quality claims.

Raw measurements marked measurement-complete-review-required do not qualify by themselves. Release requires independently reviewed gate values of passed, manifest evidenceStatus verified, and current-output visualEvidence status passed; tooling never promotes measurement status automatically.
The validator inventories emitted files and starts Vite's actual production preview. It checks root and deep-link HTML bytes/MIME/no-cache policy, resolves each entry module to a confined emitted file, fetches it and compares served bytes/MIME/cache, and verifies native GLB HTTP status, MIME, SHA-256 bytes and immutable content-addressed caching. It rejects symlink escapes, secret-bearing metadata, signed provider URLs and remote unchecked GLB dependencies. These are HTTP probes; no browser automation or deployment is started.


Release validation requires evidence/release/benchmarks.json to identify the exact current emitted-build inventory and measurement time, match reference-profile.json hardware/browser/viewport, include every route authored in BENCHMARK-ROUTES.md exactly once, and provide all required unit-tagged metrics. FPS, p95 and p99 checks use fixed limits from the reference profile; evidence cannot override them with self-selected profiles, limits or unrelated metrics. Missing routes, stale build identity, invalid units, missing evidence or missed limits fail. The artifact binds benchmark evidence bytes by path, size and SHA-256; tooling never invents benchmark results or thresholds.

The production build must emit dist/release-compatibility.json from actual authoritative exports, including integer buildSchema, integer saveSchema, and an authority identifier. The artifact generator inventories and hashes emitted dist files into dist/release-manifest.json and requires benchmark build identity to match; it does not independently grant release acceptance or copy template claims. Rollback metadata can be attached with --previous /path/to/prior/release-manifest.json; it records identity/compatibility only and always uses exercised: false.

The strict workflow is manually dispatched and does not deploy, create provider accounts, request Tripo tasks, or print credentials. It uploads the validated dist and bound release evidence. Ordinary CI builds/tests the validator and uploads a diagnostic artifact; passing it does not imply strict release acceptance. No production readiness is implied by build success or artifact-manifest generation.
