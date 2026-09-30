import { AnimationClip, Group, InstancedBufferAttribute, InstancedMesh, LoadingManager, Matrix4, Object3D, Quaternion, SkinnedMesh, Texture, Vector3, type Camera, type Material } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { AssetManifestEntry, WorldAssetPlacement } from '../game/contracts';
import { AnimationController } from './AnimationController';

export interface AssetLoadProgress { assetId: string; url: string; loaded: number; total: number; ratio: number | null }
export interface NativeAssetInstance { readonly assetId: string; readonly root: Object3D; readonly animation: AnimationController; readonly sockets: Readonly<Record<string, Object3D>>; dispose(): void }
export interface NativeStaticBatch {
  readonly assetId: string; readonly root: Group; readonly instanceCount: number; readonly lodIds: readonly string[];
  setPlacementVisible(placementId: string, visible: boolean): void; updateOcclusion(camera: Camera, target: Vector3): void; dispose(): void;
}
export class NativeAssetError extends Error {
  constructor(readonly assetId: string, message: string) { super(`Asset ${assetId}: ${message}`); this.name = 'NativeAssetError'; }
}
interface Template { key: string; root: Object3D; clips: AnimationClip[]; manifest: AssetManifestEntry; leases: number; lastUsed: number; evictWhenFree: boolean }
interface FadingInstances { values: Float32Array; attribute: InstancedBufferAttribute; position: Vector3[]; matrices: Matrix4[] }

/** Loads only manifest-backed native GLBs. Templates share resources; skeleton clones and static instance batches are isolated. */
export class NativeAssetLoader {
  private readonly manager = new LoadingManager();
  private readonly loader: GLTFLoader;
  private readonly cache = new Map<string, Template>();
  private readonly inFlight = new Map<string, Promise<Template>>();
  private clock = 0;
  private disposed = false;


  constructor(private readonly options: { maxCachedAssets?: number; onProgress?: (progress: AssetLoadProgress) => void } = {}) { this.loader = new GLTFLoader(this.manager); }

  async load(manifest: AssetManifestEntry): Promise<NativeAssetInstance> {
    const template = await this.acquireTemplate(manifest);
    const root = cloneSkinned(template.root);
    root.traverse((node) => {
      if (node instanceof SkinnedMesh) node.skeleton.boneInverses = node.skeleton.boneInverses.map((matrix) => matrix.clone());
    });
    if (manifest.coordinateTransform) {
      root.scale.setScalar(manifest.coordinateTransform.scale);
      root.rotation.y = Math.atan2(manifest.coordinateTransform.forward.x, manifest.coordinateTransform.forward.z);
    }
    const animation = new AnimationController(root, template.clips, manifest);
    const sockets: Record<string, Object3D> = {};
    for (const name of manifest.sockets) {
      const socket = root.getObjectByName(name);
      if (socket) sockets[name] = socket;
    }
    return this.createInstance(manifest.id, root, animation, sockets, template);
  }

  async loadStaticBatch(manifest: AssetManifestEntry, placements: readonly WorldAssetPlacement[]): Promise<NativeStaticBatch> {
    if (manifest.kind !== 'prop' || manifest.sourceType !== 'native-glb') throw new NativeAssetError(manifest.id, 'static batches require a native-glb prop manifest entry');
    if (!placements.length) throw new NativeAssetError(manifest.id, 'static batch has no placements');
    const source = await this.load(manifest);
    const staticMeshes: InstancedMesh[] = [];
    const fadeData: FadingInstances[] = [];
    const placementIndices = new Map(placements.map((placement, index) => [placement.id, index]));
    try {
      source.root.updateMatrixWorld(true);
      source.root.traverse((node) => {
        if ('isSkinnedMesh' in node && node.isSkinnedMesh) throw new NativeAssetError(manifest.id, 'a skinned prop cannot be converted to an instanced static batch');
        if (!('isMesh' in node && node.isMesh)) return;
        const mesh = node as InstancedMesh;
        const geometry = mesh.geometry.clone();
        const alphas = new Float32Array(placements.length).fill(1);
        const attribute = new InstancedBufferAttribute(alphas, 1);
        geometry.setAttribute('instanceOpacity', attribute);
        const material = cloneFadingMaterial(mesh.material);
        const batch = new InstancedMesh(geometry, material, placements.length);
        batch.name = `${manifest.id}:instances`;
        const localMatrix = mesh.matrixWorld.clone();
        const positions: Vector3[] = [];
        const matrices: Matrix4[] = [];
        for (let index = 0; index < placements.length; index++) {
          const placement = placements[index]!;
          const position = new Vector3(placement.position.x, placement.position.y, placement.position.z);
          const rotation = new Quaternion().setFromAxisAngle(UNIT_UP, placement.rotationY);
          const scale = new Vector3(placement.scale.x, placement.scale.y, placement.scale.z);
          const matrix = new Matrix4().compose(position, rotation, scale).multiply(localMatrix);
          matrices.push(matrix.clone());
          batch.setMatrixAt(index, matrix);
          positions.push(position);
        }
        batch.instanceMatrix.needsUpdate = true;
        batch.computeBoundingSphere();
        staticMeshes.push(batch);
        fadeData.push({ values: alphas, attribute, position: positions, matrices });
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
    return {
      assetId: manifest.id, root, instanceCount: placements.length, lodIds: manifest.lodIds,
      setPlacementVisible: (placementId, visible) => {
        const index = placementIndices.get(placementId);
        if (released || index === undefined) return;
        for (let meshIndex = 0; meshIndex < staticMeshes.length; meshIndex++) {
          const mesh = staticMeshes[meshIndex]!;
          mesh.setMatrixAt(index, visible ? fadeData[meshIndex]!.matrices[index]! : HIDDEN_MATRIX);
          mesh.instanceMatrix.needsUpdate = true;
        }
      },
      updateOcclusion: (camera, target) => {
        if (released) return;
        const cameraPosition = camera.position;
        const ray = SCRATCH_RAY.subVectors(cameraPosition, target);
        const rayLengthSq = ray.lengthSq();
        for (const data of fadeData) {
          let changed = false;
          for (let index = 0; index < data.values.length; index++) {
            const position = data.position[index]!;
            const along = Math.max(0, Math.min(1, SCRATCH_DELTA.subVectors(position, target).dot(ray) / rayLengthSq));
            SCRATCH_CLOSEST.copy(target).addScaledVector(ray, along);
            const distanceSq = position.distanceToSquared(SCRATCH_CLOSEST);
            const alpha = along > 0.08 && along < 0.98 && distanceSq < 4.0 ? 0.3 : 1;
            if (data.values[index] !== alpha) { data.values[index] = alpha; changed = true; }
          }
          if (changed) data.attribute.needsUpdate = true;
        }
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
        resolve({ key: '', root, clips: gltf.animations, manifest, leases: 0, lastUsed: ++this.clock, evictWhenFree: false });
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
  return manifest.id + '\0' + manifest.outputHash!.toLowerCase();
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
const SCRATCH_RAY = new Vector3();
const SCRATCH_DELTA = new Vector3();
const SCRATCH_CLOSEST = new Vector3();
function cloneFadingMaterial(material: Material | Material[]): Material | Material[] {
  const fade = (source: Material): Material => {
    const cloned = source.clone();
    const shaderMaterial = cloned as Material & { transparent: boolean; depthWrite: boolean; onBeforeCompile: (shader: { vertexShader: string; fragmentShader: string }) => void; customProgramCacheKey: () => string };
    shaderMaterial.transparent = true;
    shaderMaterial.depthWrite = false;
    shaderMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nattribute float instanceOpacity;\nvarying float vInstanceOpacity;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvInstanceOpacity = instanceOpacity;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vInstanceOpacity;').replace('#include <opaque_fragment>', 'diffuseColor.a *= vInstanceOpacity;\n#include <opaque_fragment>');
    };
    shaderMaterial.customProgramCacheKey = () => 'wild-crown-instance-occlusion-fade-v3';
    return cloned;
  };
  return Array.isArray(material) ? material.map(fade) : fade(material);
}
function disposeMaterials(material: Material | Material[]): void { if (Array.isArray(material)) for (const item of material) item.dispose(); else material.dispose(); }
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
