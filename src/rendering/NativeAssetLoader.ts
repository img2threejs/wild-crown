import { AnimationClip, BufferAttribute, BufferGeometry, Euler, Group, InstancedBufferAttribute, InstancedMesh, InterleavedBuffer, InterleavedBufferAttribute, LoadingManager, Matrix4, Object3D, PropertyBinding, Quaternion, SkinnedMesh, Texture, Vector3, type Camera, type Material } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { AssetManifestEntry, EnvironmentPropSnapshot, WorldAssetPlacement } from '../game/contracts';
import { DEFAULT_FOLIAGE_LIMITS, InstanceVisibility, type FoliageLimits } from './InstanceVisibility';
import { AnimationController } from './AnimationController';
import { simplifyCandidateGeometry } from './CandidateGeometrySimplifier';
import { createPlaytestAnimationSet } from './PlaytestAnimationFactory';
import { computePropVariation, propVariationFor, type PropVariationProfile } from './PropInstanceVariation';

export interface AssetLoadProgress { assetId: string; url: string; loaded: number; total: number; ratio: number | null }
export interface NativeAssetInstance { readonly assetId: string; readonly root: Object3D; readonly animation: AnimationController; readonly sockets: Readonly<Record<string, Object3D>>; dispose(): void }
export interface NativeStaticBatch {
  readonly assetId: string; readonly root: Group; readonly instanceCount: number; readonly lodIds: readonly string[];
  setPlacementVisible(placementId: string, visible: boolean): void; updateOcclusion(camera: Camera, target: Vector3, dt?: number): void; dispose(): void;
  /** Projects an authoritative local response onto one instance; undefined restores its authored pose/material. */
  setPlacementResponse(placementId: string, response: EnvironmentPropSnapshot | undefined, reducedMotion: boolean): void;
  /** Instances drawn right now (neither hidden by a world fact nor culled by the foliage view-distance limit). */
  readonly drawnInstanceCount: number;
  /** Pushes the current occlusion fade forward one frame; returns whether any alpha was re-uploaded. Allocation free. */
  advanceFade(): boolean;
  /** Whether this batch has any wind sway applied to its vertices (foliage wind reads this and the loader's wind clock). */
  readonly hasWind: boolean;
}
export class NativeAssetError extends Error {
  constructor(readonly assetId: string, message: string) { super(`Asset ${assetId}: ${message}`); this.name = 'NativeAssetError'; }
}
interface Template { key: string; root: Object3D; clips: AnimationClip[]; manifest: AssetManifestEntry; playtestActionToClipMapping?: Record<string, string>; playtestRootMotion?: Record<string, NonNullable<AssetManifestEntry['rootMotion']>[string]>; leases: number; lastUsed: number; evictWhenFree: boolean }

/** Loads only manifest-backed native GLBs. Templates share resources; skeleton clones and static instance batches are isolated. */
export class NativeAssetLoader {
  private readonly manager = new LoadingManager();
  private readonly loader: GLTFLoader;
  private readonly cache = new Map<string, Template>();
  private readonly inFlight = new Map<string, Promise<Template>>();
  private clock = 0;
  private disposed = false;


  constructor(private readonly options: { maxCachedAssets?: number; onProgress?: (progress: AssetLoadProgress) => void; allowMissingActionClips?: boolean; simplifyBlockedCandidates?: boolean } = {}) { this.loader = new GLTFLoader(this.manager); }

  async load(manifest: AssetManifestEntry): Promise<NativeAssetInstance> {
    const template = await this.acquireTemplate(manifest);
    const model = cloneSkinned(template.root);
    // Characters: the manifest correction (scale, corrective heading, origin offset) lives on this inner node so the instance root
    // carries only the simulation transform; the renderer writes root position/yaw every frame without erasing the correction.
    // `forward` is the manifest's encoded corrective heading: rotation.y = atan2(forward.x, forward.z) maps the native head onto +Z.
    const root: Object3D = manifest.kind === 'character' && manifest.coordinateTransform ? new Group() : model;
    if (root !== model) { root.name = 'wc:actor-root:' + manifest.id; root.add(model); }
    model.traverse((node) => {
      if (node instanceof SkinnedMesh) node.skeleton.boneInverses = node.skeleton.boneInverses.map((matrix) => matrix.clone());
    });
    if (manifest.coordinateTransform) {
      model.scale.setScalar(manifest.coordinateTransform.scale);
      model.rotation.y = Math.atan2(manifest.coordinateTransform.forward.x, manifest.coordinateTransform.forward.z);
      if (manifest.coordinateTransform.originOffset) {
        const offset = manifest.coordinateTransform.originOffset;
        model.position.set(offset.x, offset.y, offset.z);
      }
    }
    const animationManifest = template.playtestActionToClipMapping
      ? { ...manifest, actionToClipMapping: { ...manifest.actionToClipMapping, ...template.playtestActionToClipMapping }, rootMotion: { ...manifest.rootMotion, ...template.playtestRootMotion } }
      : manifest;
    const animation = new AnimationController(model, template.clips, animationManifest, this.options.allowMissingActionClips === true);
    const sockets: Record<string, Object3D> = {};
    for (const name of manifest.sockets) {
      const socket = model.getObjectByName(name);
      if (socket) sockets[name] = socket;
    }
    const castBone = manifest.kind !== 'character' ? undefined
      : manifest.castSocketBone ?? (manifest.evidenceStatus === 'blocked' ? manifest.playtestAnimation?.headBoneName : undefined);
    if (!sockets.cast && castBone) {
      // GLTFLoader sanitizes native node names for animation track binding.
      const head = model.getObjectByName(castBone) ?? model.getObjectByName(PropertyBinding.sanitizeNodeName(castBone));
      if (head && 'isBone' in head && head.isBone === true) sockets.cast = head;
    }
    return this.createInstance(manifest.id, root, animation, sockets, template);
  }

  /**
   * Instances a prop placement list into one draw call per mesh. `limits` are the foliage presentation limits of the asset (see
   * `FoliagePresentation`): the default thins an occluding instance by alpha blend; `dither` keeps the material opaque and depth-writing
   * (a screen-door discard fades it), and a finite `maxViewDistance` stops drawing instances far from the camera.
   *
   * Decorative vegetation and rocks (see `PropInstanceVariation`) get per-instance hue / value / scale / lean / wind-phase attributes that
   * the shader reads: no extra batches, no extra draws, the static budget is unchanged. Trees, bushes and fern batches also receive a
   * height-weighted vertex sway driven by the shared world clock (and dimmed to x0.25 when the user enables reduced motion).
   */
  async loadStaticBatch(manifest: AssetManifestEntry, placements: readonly WorldAssetPlacement[], limits: FoliageLimits = DEFAULT_FOLIAGE_LIMITS, worldWind: { value: number } = SHARED_WIND, reducedMotion: { value: boolean } = SHARED_REDUCED_MOTION): Promise<NativeStaticBatch> {
    if (manifest.kind !== 'prop' || manifest.sourceType !== 'native-glb') throw new NativeAssetError(manifest.id, 'static batches require a native-glb prop manifest entry');
    if (!placements.length) throw new NativeAssetError(manifest.id, 'static batch has no placements');
    const source = await this.load(manifest);
    const profile = propVariationFor(manifest.id);
    /** Per-instance variation packed once: hue shift, value scale, scale jitter (width, height, width again), lean axis (sin, cos), phase. */
    const variationArrays = profile ? buildInstanceVariationArrays(manifest.id, placements) : null;
    const staticMeshes: InstancedMesh[] = [];
    const attributes: InstancedBufferAttribute[] = [];
    const matricesByMesh: Matrix4[][] = [];
    const baseMatricesByMesh: Matrix4[][] = [];
    const damage = new Float32Array(placements.length);
    const damageAttributes: InstancedBufferAttribute[] = [];
    const responseValues = new Float64Array(placements.length * 7);
    const responseMatrix = new Matrix4(), responseBack = new Matrix4();
    const responseRotation = new Quaternion(), responseEuler = new Euler();
    const responsePosition = new Vector3(), responseScale = new Vector3();
    let responseBoundsExpanded = false;
    const placementIndices = new Map(placements.map((placement, index) => [placement.id, index]));
    const positions = placements.map((placement) => new Vector3(placement.position.x, placement.position.y, placement.position.z));
    const visibility = new InstanceVisibility(positions);
    try {
      source.root.updateMatrixWorld(true);
      source.root.traverse((node) => {
        if ('isSkinnedMesh' in node && node.isSkinnedMesh) throw new NativeAssetError(manifest.id, 'a skinned prop cannot be converted to an instanced static batch');
        if (!('isMesh' in node && node.isMesh)) return;
        const mesh = node as InstancedMesh;
        // Shallow-clone the geometry: the source's typed arrays (vertex/index data) are already
        // compacted for blocked static candidates and immutable to us, so reuse them directly.
        // Only the per-batch instanceOpacity attribute is owned by the batch (it reads the batch's one alpha array),
        // ensuring independent occlusion-fade bookkeeping per static-batch load.
        const geometry = shallowCloneGeometry(mesh.geometry);
        const attribute = new InstancedBufferAttribute(visibility.alpha, 1);
        geometry.setAttribute('instanceOpacity', attribute);
        const damageAttribute = new InstancedBufferAttribute(damage, 1);
        geometry.setAttribute('instanceDamage', damageAttribute);
        damageAttributes.push(damageAttribute);
        if (variationArrays) {
          // Three-component tint (rgb), three-component scale jitter (x, y, z), two-component lean (x, z) and a phase float. The
          // vertex shader reads them when `instanceTint` is bound; setting the attribute unconditionally is safe even when the
          // shader branch is skipped, but the GPU still pays for the vertex fetch.
          geometry.setAttribute('instanceTint', new InstancedBufferAttribute(variationArrays.tint, 3));
          geometry.setAttribute('instanceScaleJitter', new InstancedBufferAttribute(variationArrays.scale, 3));
          geometry.setAttribute('instanceLean', new InstancedBufferAttribute(variationArrays.lean, 2));
          geometry.setAttribute('instancePhase', new InstancedBufferAttribute(variationArrays.phase, 1));
        }
        // Local mesh height (y extent) is the divisor the wind shader uses to weight the sway by height; computed once per batch from
        // the source mesh's local bounding box, so the trunk (y = 0) stays planted and the crown (y = meshHeight) reaches the peak.
        let meshHeight = FOLIAGE_MESH_HEIGHT_FALLBACK;
        const sourceBox = mesh.geometry.boundingBox;
        if (sourceBox !== null && Number.isFinite(sourceBox.min.y) && Number.isFinite(sourceBox.max.y)) {
          meshHeight = Math.max(0, sourceBox.max.y - sourceBox.min.y);
        } else if (mesh.geometry.attributes.position !== undefined) {
          // GLTFLoader does not auto-compute the local bounding box; do it once per source mesh and reuse via shallow-clone.
          mesh.geometry.computeBoundingBox();
          const computed = mesh.geometry.boundingBox;
          if (computed !== null && Number.isFinite(computed.min.y) && Number.isFinite(computed.max.y)) {
            meshHeight = Math.max(0, computed.max.y - computed.min.y);
          }
        }
        const material = cloneFadingMaterial(mesh.material, limits.fade, profile, worldWind, reducedMotion, meshHeight);
        const batch = new InstancedMesh(geometry, material, placements.length);
        batch.name = `${manifest.id}:instances`;
        const localMatrix = mesh.matrixWorld.clone();
        const matrices: Matrix4[] = [];
        for (let index = 0; index < placements.length; index++) {
          const placement = placements[index]!;
          const rotation = new Quaternion().setFromAxisAngle(UNIT_UP, placement.rotationY);
          // Apply per-instance scale jitter on top of the authored scale (symmetric on X/Z, asymmetric on Y) before composing the
          // world matrix. Collision is unchanged: the simulation reads `placement.scale`, not the rendered scale.
          const variation = variationArrays ? readScaleJitter(variationArrays.scale, index) : null;
          const sx = placement.scale.x * (variation ? variation[0]! : 1);
          const sy = placement.scale.y * (variation ? variation[1]! : 1);
          const sz = placement.scale.z * (variation ? variation[2]! : 1);
          const scale = new Vector3(sx, sy, sz);
          const matrix = new Matrix4().compose(positions[index]!, rotation, scale).multiply(localMatrix);
          matrices.push(matrix);
          batch.setMatrixAt(index, matrix);
        }
        batch.instanceMatrix.needsUpdate = true;
        batch.computeBoundingSphere();
        staticMeshes.push(batch);
        attributes.push(attribute);
        matricesByMesh.push(matrices);
        baseMatricesByMesh.push([]);
      });
      if (!staticMeshes.length) throw new NativeAssetError(manifest.id, 'GLB has no static mesh for instancing');
    } catch (error) {
      for (const batch of staticMeshes) { batch.geometry.dispose(); disposeMaterials(batch.material); batch.dispose(); }
      source.dispose();
      throw error;
    }
    const root = new Group();
    root.name = `static-batch:${manifest.id}`;
    for (const mesh of staticMeshes) root.add(mesh);
    let released = false;
    /** Rewrites one instance's matrix from its drawn state (a hidden instance is a zero-scale matrix). */
    const writeInstance = (index: number): void => {
      for (let meshIndex = 0; meshIndex < staticMeshes.length; meshIndex++) {
        const mesh = staticMeshes[meshIndex]!;
        mesh.setMatrixAt(index, visibility.isDrawn(index) ? matricesByMesh[meshIndex]![index]! : HIDDEN_MATRIX);
        mesh.instanceMatrix.needsUpdate = true;
      }
    };
    return {
      assetId: manifest.id, root, instanceCount: placements.length, lodIds: manifest.lodIds,
      hasWind: profile?.sways === true,
      get drawnInstanceCount() { return visibility.drawnCount; },
      setPlacementVisible: (placementId, visible) => {
        const index = placementIndices.get(placementId);
        if (released || index === undefined) return;
        if (visibility.setFactVisible(index, visible)) writeInstance(index);
      },
      setPlacementResponse: (placementId, response, reducedMotion) => {
        const index = placementIndices.get(placementId);
        if (released || index === undefined) return;
        const placement = placements[index]!, base = placement.position;
        const offset = response?.offset;
        const dx = offset?.x ?? 0, dy = offset?.y ?? 0, dz = offset?.z ?? 0;
        const motionScale = reducedMotion && response?.material !== 'loose-stone' ? .2 : 1;
        const tiltX = (response?.tiltX ?? 0) * motionScale, tiltZ = (response?.tiltZ ?? 0) * motionScale;
        const amount = response?.damage ?? 0;
        const crush = response?.broken ? response.material === 'foliage' ? .22 : response.material === 'loose-stone' ? .82 : 1 : 1;
        const o = index * 7;
        // Zero means the authored scale; this cache also skips repeated paused/culled-frame uploads.
        if (responseValues[o] === dx && responseValues[o + 1] === dy && responseValues[o + 2] === dz
          && responseValues[o + 3] === tiltX && responseValues[o + 4] === tiltZ && responseValues[o + 5] === amount && responseValues[o + 6] === crush - 1) return;
        const damageChanged = responseValues[o + 5] !== amount;
        responseValues[o] = dx; responseValues[o + 1] = dy; responseValues[o + 2] = dz;
        responseValues[o + 3] = tiltX; responseValues[o + 4] = tiltZ; responseValues[o + 5] = amount; responseValues[o + 6] = crush - 1;
        responseRotation.setFromEuler(responseEuler.set(tiltX, 0, tiltZ));
        responsePosition.set(base.x + dx, base.y + dy, base.z + dz);
        const coreScale = response?.broken && response.material === 'loose-stone' ? .82 : 1;
        responseScale.set(coreScale, crush, coreScale);
        responseMatrix.compose(responsePosition, responseRotation, responseScale);
        responseBack.makeTranslation(-base.x, -base.y, -base.z);
        responseMatrix.multiply(responseBack);
        positions[index]!.set(base.x + dx, base.y + dy, base.z + dz);
        for (let meshIndex = 0; meshIndex < staticMeshes.length; meshIndex++) {
          const matrix = matricesByMesh[meshIndex]![index]!;
          const originals = baseMatricesByMesh[meshIndex]!;
          const original = originals[index] ?? (originals[index] = matrix.clone());
          matrix.copy(original).premultiply(responseMatrix);
          if (!responseBoundsExpanded) {
            const sphere = staticMeshes[meshIndex]!.boundingSphere;
            if (sphere) sphere.radius += 6; // Simulation bounds loose travel to 4 m; rooted deflection stays below this margin.
          }
        }
        responseBoundsExpanded = true;
        if (damageChanged) {
          damage[index] = amount;
          for (const attribute of damageAttributes) attribute.needsUpdate = true;
        }
        writeInstance(index);
      },
      updateOcclusion: (camera, target, dt) => {
        if (released) return;
        visibility.updateDistance(camera.position, limits.maxViewDistance, writeInstance);
        if (visibility.updateOcclusion(camera.position, target, dt)) for (const attribute of attributes) attribute.needsUpdate = true;
      },
      advanceFade: () => {
        if (released) return false;
        if (!visibility.advanceFade()) return false;
        for (const attribute of attributes) attribute.needsUpdate = true;
        return true;
      },
      dispose: () => {
        if (released) return;
        released = true;
        for (const batch of staticMeshes) { batch.geometry.dispose(); disposeMaterials(batch.material); batch.dispose(); }
        root.clear();
        source.dispose();
      },
    };
  }

  get cachedAssetIds(): readonly string[] { return [...new Set([...this.cache.values()].map((template) => template.manifest.id))]; }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [key, template] of this.cache) {
      if (template.leases === 0) this.evict(key, template);
      else template.evictWhenFree = true;
    }
  }

  private async acquireTemplate(manifest: AssetManifestEntry): Promise<Template> {
    if (this.disposed) throw new NativeAssetError(manifest.id, 'loader has been disposed');
    if (manifest.sourceType !== 'native-glb') throw new NativeAssetError(manifest.id, 'source type ' + manifest.sourceType + ' is not a native GLB');
    if (!manifest.runtimeUrl) throw new NativeAssetError(manifest.id, 'manifest has no runtimeUrl; final asset is not available');
    if (!manifest.outputHash || !/^[a-f0-9]{64}$/i.test(manifest.outputHash)) throw new NativeAssetError(manifest.id, 'manifest outputHash is missing or is not a SHA-256 digest');
    const key = assetRevisionKey(manifest);
    for (const [cachedKey, cached] of this.cache) {
      if (cached.manifest.id === manifest.id && cachedKey !== key) {
        cached.evictWhenFree = true;
        if (cached.leases === 0) this.evict(cachedKey, cached);
      }
    }
    let template = this.cache.get(key);
    if (!template) {
      let pending = this.inFlight.get(key);
      if (!pending) {
        pending = this.fetchTemplate(manifest).then((loaded) => {
          if (this.disposed) { disposeTemplate(loaded); throw new NativeAssetError(manifest.id, 'loader was disposed during loading'); }
          loaded.key = key;
          this.cache.set(key, loaded);
          return loaded;
        }).finally(() => { this.inFlight.delete(key); });
        this.inFlight.set(key, pending);
      }
      template = await pending;
      if (this.disposed) throw new NativeAssetError(manifest.id, 'loader was disposed during loading');
    }
    template.leases++;
    template.lastUsed = ++this.clock;
    this.evictOverflow();
    return template;
  }

  private createInstance(assetId: string, root: Object3D, animation: AnimationController, sockets: Readonly<Record<string, Object3D>>, template: Template): NativeAssetInstance {
    let released = false;
    return {
      assetId, root, animation, sockets,
      dispose: () => {
        if (released) return;
        released = true;
        animation.dispose();
        root.removeFromParent();
        template.leases--;
        template.lastUsed = ++this.clock;
        if (template.evictWhenFree && template.leases === 0) this.evict(template.key, template);
        this.evictOverflow();
      },
    };
  }

  private async fetchTemplate(manifest: AssetManifestEntry): Promise<Template> {
    const url = manifest.runtimeUrl!;
    const response = await fetch(url);
    if (!response.ok) throw new NativeAssetError(manifest.id, 'GLB request failed with HTTP ' + response.status);
    const bytes = await response.arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const actualHash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
    if (actualHash.toLowerCase() !== manifest.outputHash!.toLowerCase()) throw new NativeAssetError(manifest.id, 'runtime GLB SHA-256 mismatch: expected ' + manifest.outputHash + ', received ' + actualHash);
    assertSelfContainedGlb(manifest.id, bytes);
    this.options.onProgress?.({ assetId: manifest.id, url, loaded: bytes.byteLength, total: bytes.byteLength, ratio: 1 });
    const basePath = document.baseURI;
    return new Promise((resolve, reject) => {
      this.loader.parse(bytes, basePath, (gltf) => {
        const root = gltf.scene;
        if (!root || root.children.length === 0) {
          if (root) disposeObject(root);
          reject(new NativeAssetError(manifest.id, 'GLB contains no scene objects'));
          return;
        }
        let hasSkinnedMesh = false;
        root.traverse((node) => { if ('isSkinnedMesh' in node && node.isSkinnedMesh) hasSkinnedMesh = true; });
        let playtestAnimation: ReturnType<typeof createPlaytestAnimationSet>;
        if (this.options.allowMissingActionClips === true && hasSkinnedMesh && gltf.animations.length === 0 && manifest.sourceType === 'native-glb' && manifest.kind === 'character' && manifest.evidenceStatus === 'blocked' && manifest.playtestAnimation) {
          try { playtestAnimation = createPlaytestAnimationSet(root, manifest, gltf.animations); }
          catch (error) {
            disposeObject(root);
            reject(new NativeAssetError(manifest.id, error instanceof Error ? error.message : String(error)));
            return;
          }
        }
        if (manifest.kind === 'character') {
          if (!hasSkinnedMesh) {
            disposeObject(root);
            reject(new NativeAssetError(manifest.id, 'character GLB has no skinned mesh; refusing primitive or unrigged substitute'));
            return;
          }
          for (const actionId of manifest.requiredActionIds) {
            const clipName = manifest.actionToClipMapping[String(actionId)];
            if (!clipName || !gltf.animations.some((clip) => clip.name === clipName)) {
              disposeObject(root);
              reject(new NativeAssetError(manifest.id, 'required action ' + actionId + ' has no exact mapped native GLB clip'));
              return;
            }
          }
        }
        const clips = playtestAnimation ? [...gltf.animations, ...playtestAnimation.clips] : gltf.animations;
        const finish = () => resolve({
          key: '', root, clips, manifest,
          playtestActionToClipMapping: playtestAnimation?.actionToClipMapping,
          playtestRootMotion: playtestAnimation?.rootMotion,
          leases: 0, lastUsed: ++this.clock, evictWhenFree: false,
        });
        if (this.options.simplifyBlockedCandidates && manifest.evidenceStatus === 'blocked') {
          void simplifyCandidateGeometry(root).then(finish, (error: unknown) => {
            disposeObject(root);
            reject(new NativeAssetError(manifest.id, 'candidate geometry simplification failed: ' + (error instanceof Error ? error.message : String(error))));
          });
        } else finish();
      }, (error) => reject(new NativeAssetError(manifest.id, error instanceof Error ? error.message : 'GLB parse failed')));
    });
  }

  private evictOverflow(): void {
    const capacity = Math.max(1, this.options.maxCachedAssets ?? 8);
    while (this.cache.size > capacity) {
      let oldestKey: string | undefined;
      let oldest: Template | undefined;
      for (const [key, candidate] of this.cache) if (candidate.leases === 0 && (!oldest || candidate.lastUsed < oldest.lastUsed)) { oldestKey = key; oldest = candidate; }
      if (!oldestKey || !oldest) break;
      this.evict(oldestKey, oldest);
    }
  }

  private evict(key: string, template: Template): void {
    if (this.cache.get(key) !== template || template.leases > 0) return;
    this.cache.delete(key);
    disposeTemplate(template);
  }
}

function assetRevisionKey(manifest: AssetManifestEntry): string {
  return manifest.id + '\0' + manifest.outputHash!.toLowerCase() + '\0' + JSON.stringify(manifest.playtestAnimation ?? null);
}
function assertSelfContainedGlb(assetId: string, bytes: ArrayBuffer): void {
  const view = new DataView(bytes);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) throw new NativeAssetError(assetId, 'runtime asset is not a GLB 2.0 binary');
  if (view.getUint32(8, true) !== bytes.byteLength) throw new NativeAssetError(assetId, 'GLB declared length does not match fetched bytes');
  let offset = 12;
  let json: Record<string, unknown> | undefined;
  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    offset += 8;
    if (offset + length > bytes.byteLength) throw new NativeAssetError(assetId, 'GLB chunk exceeds fetched byte length');
    if (type === 0x4e4f534a) {
      try { json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, offset, length)).replace(/[\u0000\s]+$/g, '')) as Record<string, unknown>; }
      catch { throw new NativeAssetError(assetId, 'GLB JSON chunk is malformed'); }
      break;
    }
    offset += length;
  }
  if (!json) throw new NativeAssetError(assetId, 'GLB has no JSON chunk');
  for (const collection of [json.buffers, json.images]) {
    if (!Array.isArray(collection)) continue;
    for (const resource of collection) if (resource && typeof resource === 'object' && 'uri' in resource) {
      const uri = (resource as { uri?: unknown }).uri;
      if (typeof uri !== 'string' || !uri.startsWith('data:')) throw new NativeAssetError(assetId, 'GLB has an external dependency; runtime assets must be self-contained');
    }
  }
}
const UNIT_UP = new Vector3(0, 1, 0);
const HIDDEN_MATRIX = new Matrix4().makeScale(0, 0, 0);
/** Shared wind clock (`GroundUnderstory.update` writes to `.value` once per frame). Foliage instanced meshes read it via the same uniform. */
const SHARED_WIND: { value: number } = { value: 0 };
/** Shared reduced-motion flag so the foliage wind shader can dim its amplitude to x0.25. */
const SHARED_REDUCED_MOTION: { value: boolean } = { value: false };
/** Sets the shared wind clock every render frame; the understory writes its own copy, so a setter keeps the two in lock-step. */
export function setFoliageWorldWind(value: number): void { SHARED_WIND.value = value; }
/** Mirrors the game-renderer reduced-motion flag so the foliage wind shader can scale its amplitude. */
export function setFoliageReducedMotion(reduced: boolean): void { SHARED_REDUCED_MOTION.value = reduced; }
/** Peak vertex sway in metres for a 1 m high foliage instance (crown reaches the peak). Tuned with `GroundClutter` so adjacent modules look the same. */
const FOLIAGE_WIND_PEAK = 0.08;
/** Fallback mesh height (m) when the source geometry has no usable local bounding box (e.g. an authored zero-height impostor): the shader still
 *  produces a valid 0..1 sway weight and the trunk stays planted. */
const FOLIAGE_MESH_HEIGHT_FALLBACK = 1.0;
/** Wind direction (x, z) shared with grass and ground-clutter so the world feels like one breeze. */
const WIND_DIR_X = 0.86;
const WIND_DIR_Z = 0.5;
/** Gust amplitude and frequency (rad/s): low-frequency modulation on top of the steady sway. */
const GUST_AMPLITUDE = 0.4;
const GUST_FREQUENCY = 0.5;
/** Per-instance sway speed (rad/s) and base frequency: decorrelates adjacent crowns in space and time. */
const SWAY_SPEED = 1.5;
const SWAY_BASE_FREQ = 0.4;
/** Reduced-motion multiplier (per task spec). */
const REDUCED_MOTION_SCALE = 0.25;
/** 4x4 Bayer threshold in (0, 1) from the window position: the screen-door pattern of the dither fade. */
const DITHER_GLSL = `float wcBayer(vec2 p) {
  int x = int(mod(p.x, 4.0)), y = int(mod(p.y, 4.0));
  float m[16] = float[16](0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  return (m[x + y * 4] + 0.5) / 16.0;
}`;
/**
 * Per-instance fade material. `blend`: transparent, no depth write, alpha by instance opacity. `dither`: stays opaque and writes depth (no
 * blended overdraw, no sorting); an occluding instance is thinned by a Bayer screen-door discard instead. When the asset has a variation
 * profile (`profile !== undefined`) the shader reads `instanceTint` (multiplied into `diffuseColor.rgb`), `instanceScaleJitter` (applied to
 * the local scale) and `instanceLean` (small rotation through the base). Trees, bushes and fern profiles also read `uWorldWind` and
 * `uReducedMotion` for a height-weighted crown sway.
 */
function cloneFadingMaterial(
  material: Material | Material[],
  mode: FoliageLimits['fade'],
  profile: PropVariationProfile | undefined,
  worldWind: { value: number },
  reducedMotion: { value: boolean },
  meshHeight: number,
): Material | Material[] {
  const fade = (source: Material): Material => {
    const cloned = source.clone();
    const shaderMaterial = cloned as Material & { transparent: boolean; depthWrite: boolean; onBeforeCompile: (shader: { vertexShader: string; fragmentShader: string; uniforms: Record<string, { value: unknown }> }) => void; customProgramCacheKey: () => string };
    const dither = mode === 'dither';
    shaderMaterial.transparent = !dither;
    shaderMaterial.depthWrite = dither;
    const hasVariation = profile !== undefined;
    const hasWind = profile?.sways === true;
    shaderMaterial.onBeforeCompile = (shader) => {
      const variationHeader = hasVariation
        ? '\nattribute vec3 instanceTint;\nattribute vec3 instanceScaleJitter;\nattribute vec2 instanceLean;\nattribute float instancePhase;\nvarying vec3 vInstanceTint;\nvarying vec3 vInstanceScaleJitter;\nvarying vec2 vInstanceLean;\nvarying float vInstancePhase;'
        : '';
      const windHeader = hasWind
        ? `\nuniform float uWorldWind;\nuniform float uReducedMotion;\nuniform float uFoliageMeshHeight;\nvarying float vSwayHeight;`
        : '';
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float instanceOpacity;\nattribute float instanceDamage;\nvarying float vInstanceOpacity;\nvarying float vInstanceDamage;\nvarying vec3 vDamagePosition;' + variationHeader + windHeader)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvInstanceOpacity = instanceOpacity;vInstanceDamage = instanceDamage;vDamagePosition = position;' + (hasVariation
          ? `
vInstanceTint = instanceTint;
vInstanceScaleJitter = instanceScaleJitter;
vInstanceLean = instanceLean;
vInstancePhase = instancePhase;`
          : '') + (hasWind
          ? `
// Foliage wind: trunk (y = 0) stays planted, crown (y = meshHeight) reaches the peak amplitude.
// uFoliageMeshHeight is the local bounding box height set once per batch (see loadStaticBatch); the divisor is constant-folded.
float swayBase = clamp(position.y / uFoliageMeshHeight, 0.0, 1.0);
float swayHeight = swayBase * swayBase;
vSwayHeight = swayHeight;
float motion = uReducedMotion > 0.5 ? ${REDUCED_MOTION_SCALE.toFixed(3)} : 1.0;
float gust = 1.0 + ${GUST_AMPLITUDE.toFixed(3)} * sin(uWorldWind * ${GUST_FREQUENCY.toFixed(3)} + instancePhase);
// The instance world placement is the translation column of three's per-instance instanceMatrix.
float swayAmt = (${(0.6).toFixed(3)} + 0.4 * sin(uWorldWind * ${SWAY_SPEED.toFixed(3)} + instanceMatrix[3].x * ${SWAY_BASE_FREQ.toFixed(3)} + instanceMatrix[3].z * ${SWAY_BASE_FREQ.toFixed(3)} + instancePhase * 4.0)) * gust * motion;
// Apply per-instance scale jitter (height-weighted so the trunk keeps the authored radius) and a sub-degree lean about the base.
transformed.xz *= mix(vec2(1.0), vInstanceScaleJitter.xz, swayHeight);
transformed.y *= mix(1.0, vInstanceScaleJitter.y, swayHeight);
transformed.xz += vec2(${WIND_DIR_X.toFixed(3)}, ${WIND_DIR_Z.toFixed(3)}) * (${FOLIAGE_WIND_PEAK.toFixed(3)} * swayAmt * swayHeight);
// Lean: rotate the local vertex around the base (y = 0) by instanceLean.x about Z, then by instanceLean.z about X.
float leanX = vInstanceLean.x * smoothstep(0.0, 1.0, swayBase);
float leanZ = vInstanceLean.y * smoothstep(0.0, 1.0, swayBase);
float cz = cos(leanZ), sz = sin(leanZ), cx = cos(leanX), sx = sin(leanX);
vec3 leaned = vec3(cz * transformed.x - sz * transformed.y, sz * transformed.x + cz * transformed.y, transformed.z);
transformed = vec3(leaned.x, cx * leaned.y - sx * leaned.z, sx * leaned.y + cx * leaned.z);`
          : ''));
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vInstanceOpacity;\nvarying float vInstanceDamage;\nvarying vec3 vDamagePosition;' + (hasVariation ? '\nvarying vec3 vInstanceTint;varying vec3 vInstanceScaleJitter;varying vec2 vInstanceLean;varying float vInstancePhase;' : '') + (hasWind ? '\nvarying float vSwayHeight;' : '') + (dither ? '\n' + DITHER_GLSL : ''))
        .replace('#include <color_fragment>', (hasVariation ? 'diffuseColor.rgb *= vInstanceTint;' : '') + '\n#include <color_fragment>\nfloat impactScar = smoothstep(0.89, 0.99, abs(sin(vDamagePosition.x * 21.0 + vDamagePosition.z * 9.0 + sin(vDamagePosition.y * 17.0) * 2.0)));\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.17, 0.12, 0.085), vInstanceDamage * (0.28 + 0.65 * impactScar));')
        .replace('#include <opaque_fragment>', (dither ? 'if (vInstanceOpacity < 0.999 && vInstanceOpacity <= wcBayer(gl_FragCoord.xy)) discard;' : 'diffuseColor.a *= vInstanceOpacity;') + '\n#include <opaque_fragment>');
      if (hasWind) {
        shader.uniforms.uWorldWind = worldWind;
        shader.uniforms.uReducedMotion = reducedMotion;
        // Per-batch local mesh height (clamped to the fallback so the shader never divides by zero or a negative value).
        shader.uniforms.uFoliageMeshHeight = { value: Math.max(FOLIAGE_MESH_HEIGHT_FALLBACK, meshHeight) };
      }
    };
    const programKey = 'wild-crown-instance-damage-v1-' + (hasVariation ? 'var-' : 'flat-') + (hasWind ? 'wind-' : '') + (dither ? 'dither-fade-v1' : 'occlusion-fade-v3');
    shaderMaterial.customProgramCacheKey = () => programKey;
    return cloned;
  };
  return Array.isArray(material) ? material.map(fade) : fade(material);
}
function disposeMaterials(material: Material | Material[]): void { if (Array.isArray(material)) for (const item of material) item.dispose(); else material.dispose(); }

/** Computes the deterministic per-instance attributes (tint rgb, scale jitter xyz, lean xz, phase) for one static batch. */
function buildInstanceVariationArrays(assetId: string, placements: readonly WorldAssetPlacement[]): { tint: Float32Array; scale: Float32Array; lean: Float32Array; phase: Float32Array } {
  const count = placements.length;
  const tint = new Float32Array(count * 3);
  const scale = new Float32Array(count * 3);
  const lean = new Float32Array(count * 2);
  const phase = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    const placement = placements[index]!;
    const variation = computePropVariation(assetId, placement.position.x, placement.position.y, placement.position.z);
    // Tint: value-only jitter is encoded as a multiplier on white. Hue offset is encoded as a small RGB rotation on the luminance axis;
    // ±4% of the hue circle lands inside ±5% of the RGB channels, so we approximate with a 1 + 0.05 * cos(hueShift * 2π) / 1 * (1 - 0.05).
    const luminance = 1 + variation.valueScale - 1;
    const tintR = luminance + variation.hueShift * 1.2;
    const tintG = luminance - variation.hueShift * 0.8;
    const tintB = luminance - variation.hueShift * 0.4;
    tint[index * 3 + 0] = tintR;
    tint[index * 3 + 1] = tintG;
    tint[index * 3 + 2] = tintB;
    scale[index * 3 + 0] = variation.widthScale;
    scale[index * 3 + 1] = variation.heightScale;
    scale[index * 3 + 2] = variation.widthScale;
    lean[index * 2 + 0] = variation.leanX;
    lean[index * 2 + 1] = variation.leanZ;
    phase[index] = variation.swayPhase;
  }
  return { tint, scale, lean, phase };
}

/** Reads the scale jitter triple for an instance; reused by the static batch setup to compose the world matrix. */
function readScaleJitter(scale: Float32Array, index: number): [number, number, number] {
  return [scale[index * 3 + 0]!, scale[index * 3 + 1]!, scale[index * 3 + 2]!];
}
function disposeTemplate(template: Template): void { disposeObject(template.root); }
function disposeObject(root: Object3D): void {
  const geometries = new Set<{ dispose(): void }>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse((node) => {
    const mesh = node as Object3D & { geometry?: { dispose(): void }; material?: Material | Material[] };
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (mesh.material) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}

/** Separate GPU attribute identities and per-batch opacity; immutable CPU arrays stay shared. */
function shallowCloneGeometry(source: BufferGeometry): BufferGeometry {
  const target = new BufferGeometry();
  target.name = source.name;
  target.userData = { ...source.userData };
  if (source.index) {
    target.setIndex(new BufferAttribute(source.index.array as BufferAttribute['array'], 1));
  }
  const groupedInterleaved = new Map<InterleavedBuffer, InterleavedBuffer>();
  for (const attributeName of Object.keys(source.attributes)) {
    const attribute = source.getAttribute(attributeName);
    if (attribute instanceof InterleavedBufferAttribute) {
      const interleaved = attribute.data;
      let shared = groupedInterleaved.get(interleaved);
      if (!shared) {
        shared = new InterleavedBuffer(interleaved.array, interleaved.stride);
        shared.setUsage(interleaved.usage);
        groupedInterleaved.set(interleaved, shared);
      }
      const next = new InterleavedBufferAttribute(shared, attribute.itemSize, attribute.offset, attribute.normalized);
      next.name = attribute.name;
      target.setAttribute(attributeName, next);
    } else {
      const next = new BufferAttribute(attribute.array, attribute.itemSize, attribute.normalized);
      next.name = attribute.name;
      next.gpuType = attribute.gpuType;
      next.setUsage(attribute.usage);
      target.setAttribute(attributeName, next);
    }
  }
  for (const group of source.groups) target.addGroup(group.start, group.count, group.materialIndex);
  target.setDrawRange(source.drawRange.start, source.drawRange.count);
  if (source.boundingBox !== null) target.boundingBox = source.boundingBox.clone();
  if (source.boundingSphere !== null) target.boundingSphere = source.boundingSphere.clone();
  return target;
}
