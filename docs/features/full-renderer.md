# Full renderer

The renderer owns Three.js presentation of the shared `RegionDefinition`, `ActorSnapshot`, `CombatSnapshot`, `AssetManifestEntry`, and `EnvironmentRecipeDefinition`. Simulation remains the authority for movement, collision decisions, contact timing, camera-independent world state, and campaign progression.

## Public API

```ts
const renderer = new GameRenderer({ canvas, onProgress, lodPolicy? });
await renderer.loadRegion(region, assetManifestEntries, environmentRecipeDefinition);
await renderer.preloadActorVariant('orun', 'actor-orun-crowned-beast', manifest);
renderer.sync(combat.actors, combat, deltaSeconds); // after authoritative simulation update
renderer.syncWorldFacts(campaignFacts);
renderer.getInputBasis();
renderer.resolveSocket(actorId, socketName);
renderer.capture();
renderer.dispose();
```

loadRegion checks the composed recipe ID, procedural layers, exact placement and ground-surface IDs, and recipe prop membership before scene commit. The region-specific environment is a code-authored composed recipe, not a guessed GLB URL. Static placements use their exact prop manifest IDs and authored transforms. Actor RegionEntity.id joins its unique runtime ActorSnapshot.id; the explicit entity.assetId resolves the native character manifest, while entity.actorId and snapshot.archetypeId identify the canonical actor definition. Multiple instance IDs may share one actor manifest and receive independent SkeletonUtils clones. A load stages assets before replacing the active scene. A newer load supersedes an older staged load; stale asset completions release their leases and cannot commit over the newer scene. Failed or superseded staging preserves the last committed region.

`preloadActorVariant` requires exact character `actorId`/`variantOf` correspondence. `ActorSnapshot.renderVariantId` is an exact asset ID; missing selected variants hide the base rig and are reported in capture data instead of falling back to the wrong form. Variant completion after a region change is released as stale.

mountCompanionPreview(host, companionId, assets, { idleActionId, loader? }) loads the exact actor manifest for that companion and returns a CompanionPreviewHandle with update(dt), actionTime, and idempotent dispose(). The caller passes the canonical actor-specific ActionId (for companion IDs, the existing catalog maps id:idle) and advances update from the existing application RAF only while the preview is active; the renderer owns no second loop. Camera framing is fitted from the loaded native bounds with a directional key and fill light. A detached/replaced host during load releases the instance and rejects as stale; a missing idle mapping fails rather than falling back.

## Native asset bytes and ownership

Every native GLB load requires a 64-character manifest `outputHash`. The loader fetches the exact runtime bytes, computes SHA-256, compares the digest before parse, checks GLB 2.0 framing, and rejects buffer/image URIs that point outside the self-contained GLB (embedded `data:` resources are allowed). Missing hashes, hash mismatches, external dependencies, malformed payloads, unskinned character models, and missing required mapped clips fail visibly; the loader does not synthesize a substitute.

Cache identity is the asset ID plus lowercased immutable output digest; runtimeUrl is a fetch location, not revision identity. Same-digest aliases and same-revision overlapping loads share one in-flight fetch/template. Instances hold leases on shared template geometry/material/texture resources; cache capacity evicts only unleased templates, and retired digests are disposed after their last lease. Template cleanup disposes unique geometries, materials, and referenced textures. Static prop batches own cloned instancing geometry/materials while retaining the source template lease until batch disposal.

The manifest's canonical action mapping is `actionToClipMapping` (`ActionId` to exact provider clip name); `requiredActionIds` must map to clips present in the native GLB. Clip sampling follows `ActorSnapshot.normalizedTime`; actions are paused between samples so render-frame delta does not advance simulation contact timing. Missing action clips throw `AnimationBindingError` rather than selecting an arbitrary clip.

Per-action root motion must have verified metadata. For `native-root-motion` and `authored-curve`, the controller requires `rootNodeName` and finite curve samples, then restores that node's bind translation after each authoritative animation sample. Thus native visual root travel is consumed at the rig root while simulation actor position remains the only world displacement authority. Missing or unverified root-motion policy fails closed when that action is played. `in-place` clips also require verified per-action declaration. Authored contact records are exposed only for the currently active action; no contact timing or gameplay event is inferred from render delta.

## Scene and camera behavior

Ground and water vertices use absolute world coordinates from authored `GroundSurfaceDefinition.points`; `elevation` is not added again. Rendering uses the same first-point polygon fan triangles as physics `groundHeightAt`, with winding corrected for visible upward faces. No decorative height is introduced apart from authored geometry. Restored/partial facts are applied through recipe restoration keys and authored `visibleWhen` changes; the renderer does not infer progression. Every authored `REGIONS` entry now publishes partial/restored boolean facts; `RegionEnvironment.syncWorldFacts` retints authored surface materials from those booleans (restored → 10% `PARTIAL_RESTORATION_TINT`, partial → 20%, neither → base color). The browser fixture verifies the partial/restored/neutral tint transition against the existing real-renderer code path.

Camera-blocking boxes use authored half-extents. Capsule `from` and `to` are endpoint centers in world space and radius extends around both endpoints; rendering builds an oriented cylinder between those endpoints with a sphere at each end. The collider is registered as raycast occlusion geometry, and `CameraDirector` retracts the camera when its target-to-camera ray intersects it. Horizontal, vertical, diagonal bounds and a live camera collision are exercised by the native browser fixture.

Collider geometry is the static, authored `ground.colliders` array on every region: collider shape, `walkSurfaceId`, `blocksMovement`, `blocksCamera`, and bounds are immutable from authored data and never mutate at runtime. Restoration-driven collider transitions (colliders that toggle, despawn, or reshape when a region enters a `partial` or `restored` state) are not specified and are not authored; the renderer and combat simulation reach only the static authored collider array. Any future restoration-conditioned collider authoring would require an explicit authored source-of-truth change in `src/content/levels/*.ts`.

Repeated native static props use `InstancedMesh`. Occlusion opacity is stored per batch instance and injected into Three r169's fragment shader by multiplying `diffuseColor.a` before `#include <opaque_fragment>`; the material remains transparent and does not write depth while faded. This is validated through WebGL render-target pixels, not only by inspecting instance attributes. LOD derivatives load only when their native prop manifests are marked verified. Defaults of 160/64/24 projected pixels with 12% hysteresis remain unprofiled proposals; capture labels projected LOD measurements as unprofiled pending locked-hardware profiling.
Movable `RegionDefinition.movableObjects` entries must join one exact existing `props[]` placement and native prop manifest. The renderer omits that placement from static batches, stages one native instance at the authored `from` position (or `to` when its committed `movedFactId` is true), and updates that same root from `CombatSnapshot.movableObjects` in the application RAF. `in-flight` and `settled` positions are consumed directly; no renderer timer or tween is created. A settled local pose stays hidden until `movedFactId` commits; `syncWorldFacts` then applies the persisted destination and reveals the same instance. Movement does not alter surfaces, colliders, or routes.

`capture()` reports committed region, asset errors, missing actor/variant IDs, prop/surface/collider counts, camera state, and LOD level/measurement state without writing game state.

## Asset parity and evidence

The browser fixture creates explicit synthetic **test-only** native GLBs. It verifies concurrent request coalescing, independent skeletons and inverse binds, required-clip validation, snapshot-timed animation, root-motion consumption and contact metadata, output-hash rejection, external-dependency rejection, immutable revision replacement while leased, LRU capacity, geometry/texture disposal, surface heights/winding, horizontal/vertical/diagonal capsule bounds, actual camera collision, superseded region/preview cleanup, exactly one movable native prop outside static batches, authoritative in-flight/settled poses, hiding a settled landing until durable movedFactId commit, durable movement restoration, transaction preservation, and rendered occlusion alpha. It is technology and lifetime evidence only, not character or environment approval.

No user-consented, reviewed production Tripo GLB set was available for this renderer pass. Production asset quality, rig/contact measurements, the Orun variant's required phase coverage, and full-game visual parity remain blocked on the real approved asset/evidence packet. No test fixture is used as a production model. LOD thresholds are unprofiled and are not performance claims.

`tests/rendering/browser-smoke.html` runs the actual browser fixture. Its captured page evidence is `evidence/rendering/native-renderer-smoke.png`; review that along with the PASS output and browser console/error capture.
