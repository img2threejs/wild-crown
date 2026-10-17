import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Fog,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { AssetManifestEntry } from '../game/contracts';
import { NativeAssetLoader, type NativeAssetInstance } from './NativeAssetLoader';

/** A 3D diorama that lives on the title screen. Mounts the same way `HeroPreview` does: the application owns the lifecycle. */
export interface TitleStageOptions {
  readonly assets: readonly AssetManifestEntry[];
  readonly reducedMotion: boolean;
}

/** Set `data-title-stage` on the host; mount with `mountTitleStage(host, options)`. */
export interface TitleStageHandle {
  /** Begins rendering once any assets needed for the diorama have finished loading. */
  readonly stage: { update(dt: number): void; dispose(): void };
  /** The diorama reports `ready` once WebGL initialised and at least the procedural diorama is in place. */
  ready: Promise<void>;
  dispose(): void;
}

interface PropRequest { readonly manifestId: string; readonly position: Vector3; readonly yaw: number; readonly scale: number }

/** Sky/fog colours; tuned for the golden-hour Greenwake opening. Mirrors the existing title card palette tokens. */
const SKY_TOP_COLOR = new Color('#f3a861');
const SKY_MID_COLOR = new Color('#e8c294');
const SKY_BOTTOM_COLOR = new Color('#b8a18a');
const FOG_COLOR = new Color('#dec5a4');
const CLIFF_COLOR = new Color('#5b6a3a');
const MOSS_COLOR = new Color('#7a8b4d');
const DIRT_COLOR = new Color('#6b5836');
const ROCK_COLOR = new Color('#827661');
const POLLEN_COLOR = new Color('#fff0b8');
const SILHOUETTE_COLOR = new Color('#3c4a3e');
const RIM_WARM = new Color('#ffd9a0');
const RIM_COOL = new Color('#6f8aa8');

/**
 * Camera framing for the key-art composition. The card sits in the left third; the diorama fills the right two-thirds.
 * The camera is moved off-axis so Aren reads in three-quarter view from the right, with the rim light from the upper left.
 * Reduced motion freezes the camera at the centre of its drift.
 */
const CAMERA_HEIGHT = 1.55;
const CAMERA_RADIUS = 5.2;
const CAMERA_LOOK_HEIGHT = 1.25;
const CAMERA_BASE_ANGLE = 0.55;
const CAMERA_DRIFT_AMPLITUDE = 0.18;
const CAMERA_DRIFT_SECONDS = 28;

const POLLEN_COUNT = 60;
const STAGE_SEED = 0x92e7c11;

/** The native assets the diorama tries to dress itself with. Missing or blocked candidates fall back to procedural geometry. */
const PREFERRED_PROPS: readonly PropRequest[] = [
  { manifestId: 'prop-erya-edge-tree', position: new Vector3(-2.8, 0, -2.6), yaw: 0.4, scale: 0.85 },
  { manifestId: 'prop-canopy-fern-cluster', position: new Vector3(1.6, 0, -1.0), yaw: -0.2, scale: 0.7 },
  { manifestId: 'prop-canopy-cliff-rock', position: new Vector3(-1.6, 0.05, 0.4), yaw: 1.2, scale: 0.55 },
  { manifestId: 'prop-greenwake-boulder-cluster', position: new Vector3(2.4, 0, -1.7), yaw: 0.8, scale: 0.65 },
  { manifestId: 'prop-erya-edge-tree', position: new Vector3(2.6, 0, 1.8), yaw: -0.9, scale: 0.7 },
];

/** Where the hero stands on the ledge; small rightward shift so the three-quarter camera frames the figure cleanly. */
const ARENA_BASE_POSITION = new Vector3(0.25, 0, 0.1);
const ARENA_BASE_YAW = -0.4;

const AREN_MANIFEST_ID = 'actor-aren';
const VARA_MANIFEST_ID = 'actor-vara';
/** Vara circles above the hero; the radius is wide enough to keep the wing arc on-screen. */
const VARA_RADIUS = 2.1;
const VARA_HEIGHT = 2.6;
const VARA_PERIOD_SECONDS = 11;
/** Vara plays `vara:hover` when the harpy is airborne; falls back to `vara:idle` so the action id is always present. */
const VARA_AIRBORNE_ACTION_ID = 'vara:hover';
const VARA_GROUNDED_ACTION_ID = 'vara:idle';

interface Mulberry32 { next(): number }
/** Deterministic RNG so motion seeds and pixel positions are stable across renders and tests. */
function mulberry32(seed: number): Mulberry32 {
  let s = seed >>> 0;
  return { next() { s = (s + 0x6D2B79F5) | 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; } };
}

/** Vertical-gradient sky dome; cheaper than a real background environment and matches the title-card palette. Three stops sell
 *  the warm golden-hour haze (zenith → mid → horizon) without depending on an environment cubemap. */
function buildSky(): Mesh {
  const geometry = new SphereGeometry(120, 32, 16);
  const material = new ShaderMaterial({
    uniforms: { uTop: { value: SKY_TOP_COLOR }, uMid: { value: SKY_MID_COLOR }, uBottom: { value: SKY_BOTTOM_COLOR } },
    vertexShader: `varying float vY; void main() { vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying float vY; uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uBottom; void main() { float t = clamp((vY + 30.0) / 110.0, 0.0, 1.0); float lower = smoothstep(0.0, 0.55, t); float upper = smoothstep(0.45, 1.0, t); vec3 lowerMix = mix(uBottom, uMid, lower); vec3 col = mix(lowerMix, uTop, upper); gl_FragColor = vec4(col, 1.0); }`,
    side: DoubleSide,
    depthWrite: false,
  });
  const sky = new Mesh(geometry, material);
  sky.name = 'wc-title-sky';
  sky.renderOrder = -10;
  return sky;
}

/** Three layered rings with descending brightness sell the distant forest/ridge silhouette without geometry overhead. */
function buildSilhouettes(rng: Mulberry32): Group {
  const group = new Group();
  group.name = 'wc-title-silhouettes';
  for (let layer = 0; layer < 3; layer++) {
    const distance = 22 + layer * 14;
    const segments = 64 + layer * 12;
    const positions: number[] = [];
    const indices: number[] = [];
    const baseHeight = 1.2 + layer * 0.6;
    for (let index = 0; index <= segments; index++) {
      const angle = (index / segments) * Math.PI * 2;
      const radius = distance + Math.sin(angle * 3 + layer) * 0.4;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      const jitter = 0.5 + rng.next() * 1.1;
      const y = baseHeight + jitter * (1.1 - layer * 0.18);
      positions.push(x, 0, z, x, y, z);
      if (index > 0) {
        const base = (index - 1) * 2;
        indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geometry.setIndex(indices);
    const tone = 1 - layer * 0.22;
    const tint = SILHOUETTE_COLOR.clone().multiplyScalar(tone);
    const material = new MeshBasicMaterial({ color: tint, side: DoubleSide, depthWrite: false, fog: true });
    const mesh = new Mesh(geometry, material);
    mesh.name = `wc-title-silhouette-layer-${layer}`;
    group.add(mesh);
  }
  return group;
}

/** The mossy cliff ledge the player stands on. A simple cylinder dressed with moss patches and a couple of fallen rocks. */
function buildCliff(rng: Mulberry32): Group {
  const group = new Group();
  group.name = 'wc-title-cliff';
  const base = new Mesh(
    new CylinderGeometry(3.4, 4.2, 0.9, 18),
    new MeshStandardMaterial({ color: DIRT_COLOR, roughness: 0.95, metalness: 0 }),
  );
  base.name = 'wc-title-cliff-base';
  base.position.set(0, -0.45, 0);
  base.castShadow = false;
  base.receiveShadow = true;
  group.add(base);
  const moss = new Mesh(
    new CylinderGeometry(3.45, 3.55, 0.04, 24),
    new MeshStandardMaterial({ color: MOSS_COLOR, roughness: 0.85, metalness: 0 }),
  );
  moss.name = 'wc-title-cliff-moss';
  moss.position.set(0, 0.02, 0);
  moss.receiveShadow = true;
  group.add(moss);
  const pebbles = 9;
  for (let index = 0; index < pebbles; index++) {
    const angle = rng.next() * Math.PI * 2;
    const radius = 1.6 + rng.next() * 1.6;
    const pebble = new Mesh(
      new IcosahedronGeometry(0.12 + rng.next() * 0.12, 0),
      new MeshStandardMaterial({ color: ROCK_COLOR, roughness: 0.9, metalness: 0, flatShading: true }),
    );
    pebble.position.set(Math.cos(angle) * radius, 0.08, Math.sin(angle) * radius);
    pebble.rotation.y = rng.next() * Math.PI * 2;
    pebble.scale.y = 0.6 + rng.next() * 0.4;
    group.add(pebble);
  }
  const slope = new Mesh(
    new ConeGeometry(3.6, 1.2, 18, 1, true, Math.PI * 0.85, Math.PI),
    new MeshStandardMaterial({ color: CLIFF_COLOR, roughness: 0.95, metalness: 0, side: DoubleSide }),
  );
  slope.name = 'wc-title-cliff-slope';
  slope.position.set(0.3, -0.4, 0);
  slope.rotation.x = -0.18;
  group.add(slope);
  return group;
}

/** Drifting pollen points; deterministic seeds so the screen never rebuilds itself frame-to-frame. */
function buildParticles(rng: Mulberry32): Points {
  const positions = new Float32Array(POLLEN_COUNT * 3);
  const seeds = new Float32Array(POLLEN_COUNT);
  for (let index = 0; index < POLLEN_COUNT; index++) {
    const radius = 2 + rng.next() * 5;
    const angle = rng.next() * Math.PI * 2;
    positions[index * 3 + 0] = Math.cos(angle) * radius;
    positions[index * 3 + 1] = 0.5 + rng.next() * 2.5;
    positions[index * 3 + 2] = Math.sin(angle) * radius;
    seeds[index] = rng.next() * Math.PI * 2;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aSeed', new BufferAttribute(seeds, 1));
  const material = new ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: POLLEN_COLOR }, uSize: { value: 9.0 } },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    vertexShader: `attribute float aSeed; varying float vSeed; uniform float uTime; uniform float uSize; void main() { vSeed = aSeed; vec3 p = position; p.y += sin(uTime * 0.6 + aSeed) * 0.4 + uTime * 0.04; p.x += sin(uTime * 0.3 + aSeed * 1.7) * 0.5; p.z += cos(uTime * 0.25 + aSeed * 0.9) * 0.5; vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_PointSize = uSize * (1.0 / max(-mv.z, 0.5)); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying float vSeed; uniform vec3 uColor; void main() { vec2 p = gl_PointCoord * 2.0 - 1.0; float r = length(p); if (r > 1.0) discard; float a = smoothstep(1.0, 0.0, r) * (0.7 + 0.3 * sin(vSeed * 4.0)); gl_FragColor = vec4(uColor, a); }`,
  });
  const points = new Points(geometry, material);
  points.name = 'wc-title-pollen';
  return points;
}

/** Picks prop asset ids that the loaded manifest actually carries; missing ids are skipped silently. */
function pickPropManifests(assets: readonly AssetManifestEntry[], ids: readonly string[]): AssetManifestEntry[] {
  const idSet: Record<string, true> = {};
  for (const id of ids) idSet[id] = true;
  return assets.filter(asset => idSet[asset.id] && asset.kind === 'prop' && asset.sourceType === 'native-glb' && !!asset.runtimeUrl);
}

/** Loads a native character manifest from the loaded manifest list; null when the entry is unavailable. */
function pickCharacterManifest(assets: readonly AssetManifestEntry[], id: string): AssetManifestEntry | null {
  for (const asset of assets) if (asset.id === id && asset.kind === 'character' && asset.sourceType === 'native-glb' && !!asset.runtimeUrl) return asset;
  return null;
}

/** How many of the assets this stage wants to compose actually have a runtime URL? Zero means the production manifest
 *  was passed in, every preferred prop/character is blocked, and the procedural scene is all that's left. Showing just
 *  primitives behind the title card looks worse than the painted fallback, so we keep the canvas hidden in that case. */
function countUsableAssets(assets: readonly AssetManifestEntry[]): number {
  let count = 0;
  for (const asset of assets) {
    if (asset.sourceType === 'native-glb' && asset.runtimeUrl && (asset.kind === 'prop' || asset.kind === 'character')) count++;
  }
  return count;
}

/**
 * Mounts the title-screen diorama: a Three.js renderer attached to `host`, layered behind the title card. Everything is
 * procedural geometry plus the loader's templated native GLBs so it presents the same assets the world uses (no foreign
 * models). The handle returns `ready` once the renderer booted and the procedural cliff/sky/particles are in place; the
 * coordinator must call `update(dt)` once per frame and `dispose()` when the title leaves.
 *
 * If the manifest passed in carries no usable runtime URL (the production manifest: every entry is `runtimeUrl: null`),
 * the diorama stays hidden and the painted fallback title image remains visible — primitive geometry alone looks worse
 * than the painted cartouche behind the card.
 */
export function mountTitleStage(host: HTMLElement, options: TitleStageOptions): TitleStageHandle {
  const placeholder = host.querySelector<HTMLElement>('[data-title-stage-placeholder]');
  const setStatus = (state: 'loading' | 'ready' | 'error', message?: string) => {
    host.dataset.titleStageState = state;
    if (!placeholder) return;
    placeholder.hidden = state === 'ready';
    if (message) placeholder.textContent = message;
  };

  let resolveReady: () => void = () => undefined;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });

  const usableAssetCount = countUsableAssets(options.assets);
  if (usableAssetCount === 0) {
    // Production manifest: every entry is blocked. The procedural cliff would render alone, so we stay in the
    // 'error' state which keeps the host at opacity 0; the painted fallback image behind the card stays visible.
    setStatus('error');
    resolveReady();
    return { ready, stage: { update() {}, dispose() {} }, dispose() {} };
  }

  const canvas = document.createElement('canvas');
  canvas.className = 'wc-title-stage__canvas';
  host.append(canvas);

  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch {
    setStatus('error', 'The 3D diorama is unavailable on this device. The title screen remains usable below.');
    return {
      ready: Promise.resolve(),
      stage: { update() {}, dispose() {} },
      dispose() {},
    };
  }
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  // Slightly under-exposed to leave headroom for the warm sky stops; the diorama sits behind dark card.
  renderer.toneMappingExposure = 0.95;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));

  const scene = new Scene();
  scene.background = SKY_BOTTOM_COLOR.clone();
  scene.fog = new Fog(FOG_COLOR, 9, 32);

  const rng = mulberry32(STAGE_SEED);

  const sky = buildSky();
  scene.add(sky);
  scene.add(buildSilhouettes(rng));
  const cliff = buildCliff(rng);
  scene.add(cliff);

  // Three-point lighting for the golden-hour key art: warm key from the upper left, cool rim from behind the hero,
  // a low ambient that lifts the moss out of black. Hemisphere colour reads as ground-bounce on the cliff face.
  scene.add(new HemisphereLight(SKY_BOTTOM_COLOR, CLIFF_COLOR, 0.45));
  const sun = new DirectionalLight(RIM_WARM, 1.85);
  sun.position.set(-5.5, 7.5, 4.5);
  scene.add(sun);
  const rim = new DirectionalLight(RIM_COOL, 0.55);
  rim.position.set(4.2, 3.6, -3.2);
  scene.add(rim);
  const fill = new DirectionalLight('#fff2d8', 0.35);
  fill.position.set(0.5, 1.6, 3.5);
  scene.add(fill);
  scene.add(new AmbientLight('#fff2d8', 0.18));

  const pollen = buildParticles(rng);
  scene.add(pollen);

  const camera = new PerspectiveCamera(30, 1, 0.1, 200);
  /** The camera target sits on the hero so three-quarter framing tracks Aren even when the camera drifts. */
  const cameraTarget = new Vector3(ARENA_BASE_POSITION.x * 0.6, CAMERA_LOOK_HEIGHT, ARENA_BASE_POSITION.z * 0.6);
  const cameraPosition = new Vector3();
  /** Initial pose: the centre of the drift arc; reduced motion freezes the camera here. */
  const initialAngle = CAMERA_BASE_ANGLE;
  camera.position.set(
    cameraTarget.x + Math.cos(initialAngle) * CAMERA_RADIUS,
    cameraTarget.y + CAMERA_HEIGHT,
    cameraTarget.z + Math.sin(initialAngle) * CAMERA_RADIUS,
  );
  camera.lookAt(cameraTarget);

  const loader = new NativeAssetLoader({ allowMissingActionClips: true });
  const propManifests = pickPropManifests(options.assets, PREFERRED_PROPS.map(prop => prop.manifestId));
  /** Static prop-id -> manifest lookup; built once from the loaded manifest list. */
  const manifestById: Record<string, AssetManifestEntry> = {};
  for (const manifest of propManifests) manifestById[manifest.id] = manifest;
  const arenaCharacter = pickCharacterManifest(options.assets, AREN_MANIFEST_ID);
  const varaCharacter = pickCharacterManifest(options.assets, VARA_MANIFEST_ID);

  /** Native instances, one entry per placement (index-aligned with `propRequests`) so duplicate ids coexist. */
  const propInstances: NativeAssetInstance[] = [];
  const propRequests: PropRequest[] = [];
  for (const request of PREFERRED_PROPS) {
    if (!manifestById[request.manifestId]) continue;
    propRequests.push({ ...request, position: request.position.clone() });
  }
  let arenaInstance: NativeAssetInstance | null = null;
  let varaInstance: NativeAssetInstance | null = null;
  /** Resolved idle/hover action ids for the loaded characters; null when the action is missing. */
  let arenaActionId: string | null = null;
  let varaActionId: string | null = null;
  let arenaLoaded = false;
  let varaLoaded = false;

  async function loadPlacement(request: PropRequest, slot: number): Promise<void> {
    const manifest = manifestById[request.manifestId];
    if (!manifest) return;
    try {
      const instance = await loader.load(manifest);
      propInstances[slot] = instance;
      instance.root.position.copy(request.position);
      instance.root.rotation.y = request.yaw;
      instance.root.scale.setScalar(request.scale);
      scene.add(instance.root);
    } catch {
      // A blocked candidate silently drops out; the procedural cliff already supplies rocks and moss.
    }
  }

  /**
   * Resolves the first available action id from a preference list. Production-ready animation ids take priority; the
   * loader has already wired any native root-motion, so we never need to re-target.
   */
  function pickAvailableAction(instance: NativeAssetInstance, candidates: readonly string[]): string | null {
    for (const candidate of candidates) {
      try { if (instance.animation.hasAction(candidate)) return candidate; }
      catch { /* the loader reported a blocked clip; try the next candidate */ }
    }
    return null;
  }

  async function loadCharacter(
    manifest: AssetManifestEntry | null,
    setInstance: (instance: NativeAssetInstance | null) => void,
    baseScale: number,
    basePosition: Vector3,
    baseYaw: number,
    actionCandidates: readonly string[],
    onActionResolved: (actionId: string | null) => void,
    onLoaded: () => void,
  ): Promise<void> {
    if (!manifest) { onLoaded(); return; }
    try {
      const instance = await loader.load(manifest);
      const root = instance.root;
      root.scale.setScalar(baseScale);
      root.position.copy(basePosition);
      root.rotation.y = baseYaw;
      scene.add(root);
      const resolved = pickAvailableAction(instance, actionCandidates);
      onActionResolved(resolved);
      if (resolved) {
        try { instance.animation.play(resolved, 'idle', undefined, 0); }
        catch { /* the asset is missing or has no clips; the actor just stands still */ }
      }
      setInstance(instance);
    } catch {
      setInstance(null);
    } finally {
      onLoaded();
    }
  }

  void loadCharacter(
    arenaCharacter,
    instance => { arenaInstance = instance; },
    1,
    ARENA_BASE_POSITION,
    ARENA_BASE_YAW,
    ['aren-idle', 'aren-idle-clip'],
    id => { arenaActionId = id; },
    () => { arenaLoaded = true; },
  );
  void loadCharacter(
    varaCharacter,
    instance => { varaInstance = instance; },
    0.7,
    ARENA_BASE_POSITION,
    0,
    [VARA_AIRBORNE_ACTION_ID, VARA_GROUNDED_ACTION_ID],
    id => { varaActionId = id; },
    () => { varaLoaded = true; },
  );
  propRequests.forEach((request, index) => { void loadPlacement(request, index); });

  let time = 0;
  let cameraAngle = initialAngle;
  let sized = false;
  let paused = false;
  let disposed = false;

  const frame = () => {
    if (disposed) return;
    const rect = host.getBoundingClientRect();
    const width = Math.max(1, host.clientWidth || rect.width || 1);
    const height = Math.max(1, host.clientHeight || rect.height || 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    sized = true;
  };

  const onVisibility = () => { paused = document.hidden; };
  const onResize = () => { sized = false; };

  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibility);

  // The procedural diorama is in place the moment the renderer boots; real assets stream in afterwards and join the
  // scene without blocking the host's opacity transition. State goes to 'ready' once both characters have settled (or
  // immediately if neither character was available — the diorama is still richer than the painted fallback).
  let readyTimer: number | null = null;
  const tryMarkReady = () => {
    if (disposed) return;
    setStatus('ready');
    resolveReady();
  };
  const armReady = () => {
    if (readyTimer) return;
    readyTimer = setTimeout(tryMarkReady, 240);
  };
  // After the very first paint, arm the ready timer; if characters never load (only props) the diorama still reads.
  queueMicrotask(() => { if (disposed) return; armReady(); });

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibility);
    for (const instance of propInstances) instance?.dispose();
    propInstances.length = 0;
    arenaInstance?.dispose();
    varaInstance?.dispose();
    loader.dispose();
    sky.geometry.dispose();
    (sky.material as ShaderMaterial).dispose();
    cliff.traverse(node => {
      if (node instanceof Mesh) {
        node.geometry.dispose();
        if (Array.isArray(node.material)) node.material.forEach(material => material.dispose());
        else node.material.dispose();
      }
    });
    pollen.geometry.dispose();
    (pollen.material as ShaderMaterial).dispose();
    renderer.dispose();
    canvas.remove();
  };

  const stage = {
    update(delta: number) {
      if (disposed) return;
      if (!host.isConnected) { dispose(); return; }
      if (paused) return;
      const dt = Math.max(0, Math.min(delta, 0.1));
      if (!options.reducedMotion) time += dt;
      (pollen.material as ShaderMaterial).uniforms.uTime!.value = time;
      // Native asset maintenance: drive any active clip; never throw on missing action ids.
      if (arenaInstance) {
        if (arenaActionId) {
          try { arenaInstance.animation.play(arenaActionId, 'idle', undefined, time); arenaInstance.animation.update(dt); }
          catch { /* a blocked candidate may not have idle */ }
        }
      }
      if (varaInstance) {
        if (varaActionId) {
          try { varaInstance.animation.play(varaActionId, 'idle', undefined, time); varaInstance.animation.update(dt); }
          catch { /* the harpy upgrade will register the new clip here */ }
        }
        if (!options.reducedMotion) {
          // Vara circles Aren; the radius is wide enough to keep her wings clear of the cliff.
          const angle = time * (Math.PI * 2) / VARA_PERIOD_SECONDS + 1.1;
          const centerX = ARENA_BASE_POSITION.x * 0.8;
          const centerZ = ARENA_BASE_POSITION.z * 0.8;
          varaInstance.root.position.set(
            centerX + Math.cos(angle) * VARA_RADIUS,
            VARA_HEIGHT + Math.sin(time * 0.5) * 0.18,
            centerZ + Math.sin(angle) * VARA_RADIUS,
          );
          // Look at the hero so her head/eyes face Aren as she passes overhead.
          varaInstance.root.lookAt(ARENA_BASE_POSITION);
        }
      }
      // Slow drift around the hero: the camera lags a published offset, never overshoots, and freezes when motion is
      // reduced. The base angle is already a three-quarter view; the drift only widens the parallax.
      if (!options.reducedMotion) {
        cameraAngle = CAMERA_BASE_ANGLE + Math.sin(time * Math.PI * 2 / CAMERA_DRIFT_SECONDS) * CAMERA_DRIFT_AMPLITUDE;
      }
      cameraPosition.set(
        cameraTarget.x + Math.cos(cameraAngle) * CAMERA_RADIUS,
        cameraTarget.y + CAMERA_HEIGHT + Math.sin(time * 0.18) * 0.04,
        cameraTarget.z + Math.sin(cameraAngle) * CAMERA_RADIUS,
      );
      camera.position.copy(cameraPosition);
      camera.lookAt(cameraTarget);
      if (!sized) frame();
      renderer.render(scene, camera);
      // Once both characters that the manifest offered have either loaded or refused, settle the ready state.
      if (!readyTimer && arenaLoaded && varaLoaded) armReady();
    },
    dispose,
  };

  setStatus('loading');
  return { ready, stage, dispose };
}
