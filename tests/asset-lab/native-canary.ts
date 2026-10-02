import { AnimationMixer, Box3, Box3Helper, Color, DirectionalLight, GridHelper, HemisphereLight, LoadingManager, LoopOnce, LoopRepeat, Mesh, PerspectiveCamera, Scene, SkeletonHelper, SkinnedMesh, SRGBColorSpace, Texture, Vector3, WebGLRenderer, type AnimationAction, type AnimationClip, type BufferGeometry, type Material, type Object3D, type Skeleton } from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const OBSERVATION_LIMIT = 128;
const VERTEX_SAMPLES_PER_MESH = 8;

interface NativeDocument {
  skins?: { joints: number[] }[];
  animations?: { name?: string; channels: { target: { node?: number; path: string }; sampler: number }[] }[];
  buffers?: { uri?: string }[];
  images?: { uri?: string }[];
}

/** Reads metadata from the exact uploaded bytes; this does not create evidence or a manifest. */
export function readNativeDocument(bytes: ArrayBuffer): NativeDocument {
  const view = new DataView(bytes);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) throw new Error('Upload must be a GLB 2.0 binary.');
  if (view.getUint32(8, true) !== bytes.byteLength) throw new Error('GLB declared length differs from uploaded byte length.');
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || 20 + length > bytes.byteLength) throw new Error('GLB first JSON chunk is missing or truncated.');
  const native = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, length)).replace(/[\u0000\s]+$/g, '')) as NativeDocument;
  for (const resource of [...(native.buffers ?? []), ...(native.images ?? [])]) {
    if (resource.uri !== undefined && !resource.uri.startsWith('data:')) throw new Error('Inspection requires a self-contained GLB; external buffers/images are not fetched.');
  }
  return native;
}

/** Local inspection clock only: no game/simulation imports, action mappings or progression. */
export class NativeCanaryPose {
  readonly mixer: AnimationMixer;
  private readonly rest: { node: Object3D; position: Vector3; quaternion: Object3D['quaternion']; scale: Vector3; morph: number[] | undefined }[] = [];
  private action: AnimationAction | undefined;
  selected = -1;
  playing = false;
  loop = false;

  constructor(readonly root: Object3D, readonly clips: readonly AnimationClip[]) {
    this.mixer = new AnimationMixer(root);
    root.traverse((node) => this.rest.push({ node, position: node.position.clone(), quaternion: node.quaternion.clone(), scale: node.scale.clone(), morph: (node as Mesh).morphTargetInfluences?.slice() }));
  }

  get time(): number { return this.action?.time ?? 0; }
  get duration(): number { return this.clips[this.selected]?.duration ?? 0; }

  select(index: number): void {
    this.restore();
    const clip = this.clips[index];
    if (!clip) { this.selected = -1; this.action = undefined; return; }
    this.selected = index;
    this.action = this.mixer.clipAction(clip);
    this.seek(0);
  }

  seek(time: number): void {
    if (!this.action) return;
    this.playing = false;
    this.action.reset().setLoop(LoopOnce, 1).play();
    this.action.clampWhenFinished = true;
    this.mixer.setTime(Math.max(0, Math.min(this.duration, time)));
    this.action.paused = true;
    this.root.updateMatrixWorld(true);
  }

  play(): void {
    if (!this.action || this.duration <= 0) return;
    if (this.time >= this.duration || !this.action.isScheduled()) this.seek(0);
    this.action.setLoop(this.loop ? LoopRepeat : LoopOnce, this.loop ? Infinity : 1);
    this.action.clampWhenFinished = true;
    this.action.paused = false;
    this.playing = true;
  }

  pause(): void { this.playing = false; if (this.action) this.action.paused = true; }

  advance(seconds: number): void {
    if (!this.playing || !this.action) return;
    this.mixer.update(this.loop ? seconds : Math.min(seconds, Math.max(0, this.duration - this.time)));
    if (!this.loop && this.time >= this.duration) this.pause();
    this.root.updateMatrixWorld(true);
  }

  restore(): void {
    this.playing = false;
    this.mixer.stopAllAction();
    for (const value of this.rest) {
      value.node.position.copy(value.position);
      value.node.quaternion.copy(value.quaternion);
      value.node.scale.copy(value.scale);
      if (value.morph) (value.node as Mesh).morphTargetInfluences?.splice(0, value.morph.length, ...value.morph);
    }
    this.root.updateMatrixWorld(true);
  }

  dispose(): void { this.restore(); this.mixer.uncacheRoot(this.root); }
}

function nativeMeshes(root: Object3D): Mesh[] {
  const meshes: Mesh[] = [];
  root.traverse((node) => {
    if (!(node as Mesh).isMesh) return;
    if ((node as Mesh & { isInstancedMesh?: boolean }).isInstancedMesh) throw new Error('Native instanced-mesh inspection is unsupported; instance transforms will not be ignored or replaced.');
    meshes.push(node as Mesh);
  });
  return meshes;
}

function updateSkin(root: Object3D, meshes: readonly Mesh[]): void {
  root.updateMatrixWorld(true);
  for (const mesh of meshes) if ((mesh as SkinnedMesh).isSkinnedMesh) (mesh as SkinnedMesh).skeleton.update();
}

/** Exact deformed vertices, including native morphs/skin. Expensive; run on explicit frame/pose actions, not each frame. */
export function deformedBounds(root: Object3D): Box3 {
  const meshes = nativeMeshes(root);
  updateSkin(root, meshes);
  const bounds = new Box3();
  const point = new Vector3();
  for (const mesh of meshes) {
    const positions = mesh.geometry.getAttribute('position');
    if (!positions) continue;
    for (let index = 0; index < positions.count; index++) {
      mesh.getVertexPosition(index, point).applyMatrix4(mesh.matrixWorld);
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) throw new Error('Native deformed geometry contains a non-finite vertex.');
      bounds.expandByPoint(point);
    }
  }
  if (bounds.isEmpty()) throw new Error('GLB scene has no frameable native mesh positions.');
  return bounds;
}

/** GLTFLoader r169 can swallow dependency errors and return null without a manager error. */
export async function assertNativeTextures(gltf: GLTF): Promise<void> {
  const textures: unknown[] = await gltf.parser.getDependencies('texture');
  if (textures.some((texture) => !(texture instanceof Texture) || !texture.image)) throw new Error('A native texture dependency failed or has no decoded image; an untextured fallback is not permitted.');
}

function disposeGltf(gltf: GLTF): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  const skeletons = new Set<Skeleton>();
  for (const root of gltf.scenes) root.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(material);
      for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
    }
    if ((mesh as SkinnedMesh).isSkinnedMesh) skeletons.add((mesh as SkinnedMesh).skeleton);
  });
  for (const resource of gltf.parser.associations.keys()) if (resource instanceof Texture) textures.add(resource);
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  const images = new Set<unknown>();
  for (const texture of textures) { images.add(texture.source.data); texture.dispose(); }
  for (const image of images) if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close();
  for (const skeleton of skeletons) skeleton.dispose();
}

interface Observation {
  authority: 'visual-canary-only';
  state: 'empty' | 'loading' | 'ready' | 'error' | 'disposed';
  error: string | null;
  file: { name: string; sha256: string; bytes: number } | null;
  native: { skins: number; jointsPerSkin: number[]; uniqueJoints: number; clips: { index: number; name: string; duration: number; tracks: number; channels: number }[]; clipCount: number; channelCount: number; channels: { clip: number; node: number | null; path: string }[] } | null;
  textures: { width: number | null; height: number | null }[];
  textureCount: number;
  materials: { name: string; type: string; textureSlots: string[] }[];
  materialCount: number;
  current: { clip: number; time: number; duration: number; playing: boolean; userLoop: boolean; finiteBones: boolean; boneCount: number; changedBonesFromImportedRest: number; samplePoseChanges: { mesh: string; vertex: number; distanceFromImportedRest: number }[] } | null;
  webgl: { version: string; contextLost: boolean; maxTextureSize: number; drawCalls: number; triangles: number } | null;
  framedBounds: { min: number[]; max: number[]; clip: number; time: number } | null;
  limits: { maxRows: number; maxVertexSamplesPerMesh: number; truncated: boolean };
}

declare global { interface Window { __nativeCanary?: Observation } }

interface InspectionSession {
  pose: NativeCanaryPose;
  frame(): void;
  measurePose(): void;
  dispose(): void;
  resetClock(): void;
  overlay(): void;
}

function mount(): void {
  function element<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error(`Missing native inspection element: ${id}`);
    return node as T;
  }
  const fileInput = element<HTMLInputElement>('file');
  const clipInput = element<HTMLSelectElement>('clip');
  const timeInput = element<HTMLInputElement>('time');
  const loopInput = element<HTMLInputElement>('loop');
  const skeletonInput = element<HTMLInputElement>('skeleton');
  const contactInput = element<HTMLInputElement>('contact');
  const status = element<HTMLElement>('status');
  const inspection = element<HTMLFieldSetElement>('inspection');
  const host = element<HTMLElement>('render-host');
  let canvas = element<HTMLCanvasElement>('scene');
  const output = element<HTMLElement>('observations');
  const timeLabel = element<HTMLOutputElement>('time-label');
  const listeners = new AbortController();
  let generation = 0;
  let unloaded = false;
  let session: InspectionSession | undefined;
  const observation: Observation = { authority: 'visual-canary-only', state: 'empty', error: null, file: null, native: null, textures: [], textureCount: 0, materials: [], materialCount: 0, current: null, webgl: null, framedBounds: null, limits: { maxRows: OBSERVATION_LIMIT, maxVertexSamplesPerMesh: VERTEX_SAMPLES_PER_MESH, truncated: false } };
  window.__nativeCanary = observation;

  function publish(): void { output.textContent = JSON.stringify(observation, null, 2); }
  function fail(error: unknown): void {
    observation.state = 'error';
    observation.error = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    status.textContent = `Inspection failed: ${observation.error}. No substitute material/model was loaded.`;
    inspection.disabled = true;
    publish();
  }

  function createSession(gltf: GLTF): InspectionSession {
    const cleanup: (() => void)[] = [];
    let alive = true;
    function dispose(disposeNative = true): void {
      if (!alive) return;
      alive = false;
      for (let index = cleanup.length - 1; index >= 0; index--) cleanup[index]!();
      if (disposeNative) disposeGltf(gltf);
    }
    try {
      const root = gltf.scene;
      const scene = new Scene();
      cleanup.push(() => scene.clear());
      scene.background = new Color(0x18211c);
      const camera = new PerspectiveCamera(40, 1, 0.001, 1000);
      const renderer = new WebGLRenderer({ canvas, antialias: true });
      cleanup.push(() => { renderer.setAnimationLoop(null); renderer.dispose(); renderer.forceContextLoss(); });
      renderer.outputColorSpace = SRGBColorSpace;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.debug.onShaderError = () => { throw new Error('Native material shader failed to compile/link on this GPU; no substitute shader is used.'); };
      const controls = new OrbitControls(camera, canvas);
      cleanup.push(() => controls.dispose());
      const pose = new NativeCanaryPose(root, gltf.animations);
      cleanup.push(() => pose.dispose());
      const meshes = nativeMeshes(root);
      // Inspection must show the full native body even during an unqualified clip's bounds excursion.
      // No source material, visibility, topology, transform, texture or skin is replaced.
      for (const mesh of meshes) mesh.frustumCulled = false;
      scene.add(root, new HemisphereLight(0xffffff, 0x53654d, 2));
      const light = new DirectionalLight(0xffffff, 3);
      light.position.set(3, 5, 4);
      scene.add(light);
      const skeleton = new SkeletonHelper(root);
      cleanup.push(() => skeleton.dispose());
      skeleton.visible = skeletonInput.checked;
      scene.add(skeleton);
      const box = new Box3();
      const boxHelper = new Box3Helper(box, 0xf4d37a);
      cleanup.push(() => boxHelper.dispose());
      boxHelper.visible = contactInput.checked;
      scene.add(boxHelper);
      let grid: GridHelper | undefined;
      const bones: Object3D[] = [];
      root.traverse((node) => { if ((node as Object3D & { isBone?: boolean }).isBone) bones.push(node); });
      updateSkin(root, meshes);
      const restBones = bones.map((bone) => bone.matrixWorld.clone());
      const point = new Vector3();
      const samples: { mesh: Mesh; index: number; rest: Vector3 }[] = [];
      for (const mesh of meshes.slice(0, OBSERVATION_LIMIT / VERTEX_SAMPLES_PER_MESH)) {
        const positions = mesh.geometry.getAttribute('position');
        if (!positions) continue;
        const count = Math.min(VERTEX_SAMPLES_PER_MESH, positions.count);
        for (let sample = 0; sample < count; sample++) {
          const index = Math.floor(sample * (positions.count - 1) / Math.max(1, count - 1));
          samples.push({ mesh, index, rest: mesh.getVertexPosition(index, new Vector3()).applyMatrix4(mesh.matrixWorld) });
        }
      }
      const textures = new Set<Texture>();
      const materials = new Set<Material>();
      for (const mesh of meshes) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        materials.add(material);
        for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
      }
      observation.materialCount = materials.size;
      observation.materials = [...materials].slice(0, OBSERVATION_LIMIT).map((material) => ({ name: material.name.slice(0, 200), type: material.type.slice(0, 200), textureSlots: Object.entries(material).filter(([, value]) => value instanceof Texture).slice(0, OBSERVATION_LIMIT).map(([key]) => key.slice(0, 100)) }));
      observation.textureCount = textures.size;
      observation.textures = [...textures].slice(0, OBSERVATION_LIMIT).map((texture) => {
        const image = texture.image as { width?: number; height?: number } | undefined;
        return { width: image?.width ?? null, height: image?.height ?? null };
      });
      if (textures.size > OBSERVATION_LIMIT || materials.size > OBSERVATION_LIMIT || meshes.length * VERTEX_SAMPLES_PER_MESH > OBSERVATION_LIMIT) observation.limits.truncated = true;
      const gl = renderer.getContext();
      observation.webgl = { version: String(gl.getParameter(gl.VERSION)), contextLost: gl.isContextLost(), maxTextureSize: renderer.capabilities.maxTextureSize, drawCalls: 0, triangles: 0 };
      let previous = performance.now();
      let lastPublish = 0;

      function measurePose(): void {
        updateSkin(root, meshes);
        let changed = 0;
        let finite = true;
        bones.forEach((bone, index) => {
          if (!bone.matrixWorld.elements.every(Number.isFinite)) finite = false;
          const rest = restBones[index]!;
          if (bone.matrixWorld.elements.some((value, component) => Math.abs(value - rest.elements[component]!) > 1e-7)) changed++;
        });
        observation.current = { clip: pose.selected, time: pose.time, duration: pose.duration, playing: pose.playing, userLoop: pose.loop, finiteBones: finite, boneCount: bones.length, changedBonesFromImportedRest: changed, samplePoseChanges: samples.map((sample) => {
          sample.mesh.getVertexPosition(sample.index, point).applyMatrix4(sample.mesh.matrixWorld);
          return { mesh: sample.mesh.name.slice(0, 160), vertex: sample.index, distanceFromImportedRest: point.distanceTo(sample.rest) };
        }) };
        timeInput.value = String(pose.time);
        timeLabel.value = `${pose.time.toFixed(3)} / ${pose.duration.toFixed(3)} s${pose.playing ? ' — playing' : ' — paused/rest'}`;
      }

      function frame(): void {
        box.copy(deformedBounds(root));
        const center = box.getCenter(new Vector3());
        const radius = box.getSize(new Vector3()).length() / 2;
        const verticalFov = camera.fov * Math.PI / 180;
        const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
        const distance = Math.max(radius, 1e-4) / Math.sin(Math.min(verticalFov, horizontalFov) / 2) * 1.15;
        camera.position.copy(center).add(new Vector3(1, 0.5, 1).normalize().multiplyScalar(distance));
        camera.near = Math.max(radius / 1000, 1e-6);
        camera.far = Math.max(distance + radius * 20, camera.near * 1000);
        camera.updateProjectionMatrix();
        controls.target.copy(center);
        controls.update();
        observation.framedBounds = { min: box.min.toArray(), max: box.max.toArray(), clip: pose.selected, time: pose.time };
        measurePose();
        publish();
      }

      function resize(): void {
        const width = Math.max(1, host.clientWidth);
        const height = Math.max(1, host.clientHeight);
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      }
      const observer = new ResizeObserver(resize);
      cleanup.push(() => observer.disconnect());
      observer.observe(host);
      resize();

      function contextLost(event: Event): void {
        event.preventDefault();
        pose.pause();
        if (observation.webgl) observation.webgl.contextLost = true;
        renderer.setAnimationLoop(null);
        fail(new Error('WebGL context lost; re-upload to create a fresh inspection renderer.'));
      }
      canvas.addEventListener('webglcontextlost', contextLost);
      cleanup.push(() => canvas.removeEventListener('webglcontextlost', contextLost));

      if ([...textures].some((texture) => { const image = texture.image as { width?: number; height?: number } | undefined; return (image?.width ?? 0) > renderer.capabilities.maxTextureSize || (image?.height ?? 0) > renderer.capabilities.maxTextureSize; })) throw new Error('Original texture dimensions exceed this GPU maxTextureSize; no downscaled derivative is substituted.');
      frame();
      const size = box.getSize(new Vector3()).length();
      grid = new GridHelper(Math.max(size * 2, 0.001), 20, 0xf4d37a, 0x82916f);
      const contactGrid = grid;
      cleanup.push(() => { contactGrid.geometry.dispose(); for (const material of Array.isArray(contactGrid.material) ? contactGrid.material : [contactGrid.material]) material.dispose(); });
      grid.position.set(box.getCenter(point).x, box.min.y, box.getCenter(point).z);
      grid.visible = contactInput.checked;
      scene.add(grid);
      renderer.setAnimationLoop((now: number) => {
        if (!alive) return;
        try {
          pose.advance(Math.max(0, (now - previous) / 1000));
          previous = now;
          controls.update();
          updateSkin(root, meshes);
          renderer.render(scene, camera);
          if (observation.webgl) {
            observation.webgl.contextLost = gl.isContextLost();
            observation.webgl.drawCalls = renderer.info.render.calls;
            observation.webgl.triangles = renderer.info.render.triangles;
          }
          if (now - lastPublish >= 150) { measurePose(); publish(); lastPublish = now; }
        } catch (error) { renderer.setAnimationLoop(null); pose.pause(); fail(error); }
      });
      return { pose, frame, measurePose, dispose, resetClock: () => { previous = performance.now(); }, overlay: () => { skeleton.visible = skeletonInput.checked; boxHelper.visible = contactInput.checked; if (grid) grid.visible = contactInput.checked; } };
    } catch (error) { dispose(false); throw error; }
  }

  async function upload(file: File): Promise<void> {
    const token = ++generation;
    session?.dispose(); session = undefined;
    // A lost context must not be reused by the next renderer. Each upload owns a fresh canvas.
    const replacement = document.createElement('canvas');
    replacement.id = 'scene'; replacement.setAttribute('aria-label', 'Original native GLB GPU inspection view');
    canvas.replaceWith(replacement); canvas = replacement;
    inspection.disabled = true;
    clipInput.replaceChildren();
    loopInput.checked = false;
    timeInput.value = '0'; timeInput.max = '0'; timeLabel.value = '0.000 s';
    Object.assign(observation, { state: 'loading', error: null, file: null, native: null, textures: [], textureCount: 0, materials: [], materialCount: 0, current: null, webgl: null, framedBounds: null });
    observation.limits.truncated = false;
    status.textContent = 'Reading original GLB bytes, textures and native clips…';
    publish();
    let gltf: GLTF | undefined;
    try {
      const bytes = await file.arrayBuffer();
      const native = readNativeDocument(bytes);
      const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((value) => value.toString(16).padStart(2, '0')).join('');
      if (token !== generation || unloaded) return;
      observation.file = { name: file.name.slice(0, 200), sha256, bytes: bytes.byteLength };
      const manager = new LoadingManager();
      let resourceFailed = false;
      manager.onError = () => { resourceFailed = true; };
      gltf = await new GLTFLoader(manager).parseAsync(bytes, '');
      if (resourceFailed) throw new Error('A native image/buffer failed to load; an untextured fallback is not permitted.');
      await assertNativeTextures(gltf);
      if (token !== generation || unloaded) { disposeGltf(gltf); return; }
      const channels = (native.animations ?? []).flatMap((clip, index) => clip.channels.map((channel) => ({ clip: index, node: channel.target.node ?? null, path: channel.target.path.slice(0, 200) })));
      const jointIds = new Set((native.skins ?? []).flatMap((skin) => skin.joints));
      observation.native = { skins: native.skins?.length ?? 0, jointsPerSkin: (native.skins ?? []).slice(0, OBSERVATION_LIMIT).map((skin) => skin.joints.length), uniqueJoints: jointIds.size, clipCount: gltf.animations.length, clips: gltf.animations.slice(0, OBSERVATION_LIMIT).map((clip, index) => ({ index, name: clip.name.slice(0, 200), duration: clip.duration, tracks: clip.tracks.length, channels: native.animations?.[index]?.channels.length ?? 0 })), channelCount: channels.length, channels: channels.slice(0, OBSERVATION_LIMIT) };
      observation.limits.truncated = channels.length > OBSERVATION_LIMIT || gltf.animations.length > OBSERVATION_LIMIT || (native.skins?.length ?? 0) > OBSERVATION_LIMIT;
      for (const [index, clip] of gltf.animations.entries()) {
        const option = document.createElement('option');
        option.value = String(index); option.textContent = `${index}: ${clip.name} (${clip.duration.toFixed(3)} s, ${clip.tracks.length} tracks)`;
        clipInput.append(option);
      }
      session = createSession(gltf);
      gltf = undefined; // Session now owns all native resources.
      if (session.pose.clips.length) { session.pose.select(0); timeInput.max = String(session.pose.duration); }
      const hasClips = session.pose.clips.length > 0;
      for (const id of ['clip', 'play', 'pause', 'stop', 'restore', 'time', 'loop']) (element<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>(id)).disabled = !hasClips;
      session.measurePose();
      observation.state = 'ready';
      inspection.disabled = false;
      status.textContent = `Loaded ${file.name}: original materials/skin, ${observation.native.skins} skins, ${jointIds.size} distinct native joints, ${session.pose.clips.length} imported clips. Inspection only; no acceptance asserted.`;
      publish();
    } catch (error) {
      if (gltf) disposeGltf(gltf);
      if (token === generation && !unloaded) { session?.dispose(); session = undefined; fail(error); }
    }
  }

  function on(id: string, event: string, action: () => void): void {
    element<HTMLElement>(id).addEventListener(event, () => {
      if (!session || observation.state !== 'ready') return;
      try { action(); session.resetClock(); session.measurePose(); publish(); }
      catch (error) { session.pose.pause(); fail(error); }
    }, { signal: listeners.signal });
  }
  fileInput.addEventListener('change', () => { const file = fileInput.files?.[0]; if (file) void upload(file); fileInput.value = ''; }, { signal: listeners.signal });
  on('clip', 'change', () => { session!.pose.select(Number(clipInput.value)); timeInput.max = String(session!.pose.duration); });
  on('time', 'input', () => session!.pose.seek(Number(timeInput.value)));
  on('play', 'click', () => session!.pose.play());
  on('pause', 'click', () => session!.pose.pause());
  on('stop', 'click', () => session!.pose.restore());
  on('restore', 'click', () => session!.pose.restore());
  on('loop', 'change', () => { const pose = session!.pose; pose.loop = loopInput.checked; if (pose.playing) pose.play(); });
  on('frame', 'click', () => session!.frame());
  on('skeleton', 'change', () => session!.overlay());
  on('contact', 'change', () => session!.overlay());
  document.addEventListener('visibilitychange', () => { if (document.hidden) { session?.pose.pause(); session?.measurePose(); publish(); } session?.resetClock(); }, { signal: listeners.signal });
  window.addEventListener('pagehide', () => {
    unloaded = true; generation++;
    session?.dispose(); session = undefined;
    listeners.abort();
    observation.state = 'disposed'; observation.current = null; observation.webgl = null;
    publish();
  }, { signal: listeners.signal });
  publish();
}

if (typeof document !== 'undefined') mount();
