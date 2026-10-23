import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { AssetManifestEntry } from '../game/contracts';
import { heroById, type HeroDefinition, type HeroId } from '../game/heroes';
import { HERO_COMBAT } from '../game/combat/HeroProfiles';
import { NativeAssetLoader, type NativeAssetInstance } from './NativeAssetLoader';
import { WARDEN_EDGE_IDLE_INTENSITY, WardenWeapon, weaponKindForGrip } from './WardenWeapon';
import { SAP_LANCE_RELEASE } from './ThrownStaff';
import { fitUnarmedFists, releaseHandGeometry, type HandGeometryEdit } from './NativeHandGrip';
import { VesperShowcaseFx } from './VesperShowcaseFx';
import { vesperActionSeconds, vesperClipProgress } from './VesperAnimation';

export interface HeroPreviewOptions { readonly reducedMotion: boolean; readonly motionBlur: boolean }
export interface HeroPreviewHandle {
  /** Brings the hero forward (loading it on first use) and plays its reveal flourish unless motion is reduced. */
  show(heroId: HeroId): void;
  /** Plays native actions once, in order, then settles back into the idle loop. */
  showcase(actionIds: readonly string[]): void;
  update(dt: number): void;
  dispose(): void;
}

interface StagedHero {
  readonly hero: HeroDefinition;
  readonly actor: NativeAssetInstance;
  readonly pedestal: NativeAssetInstance;
  readonly weapon: WardenWeapon | null;
  readonly fists: HandGeometryEdit | null;
  readonly bounds: Box3;
  readonly pedestalBounds: Box3;
  readonly pedestalMeshes: readonly Mesh[];
  readonly showcaseFx: VesperShowcaseFx | null;
}

/** Seconds a finished showcase clip holds its last pose before the next one starts. */
const SHOWCASE_HOLD_SECONDS = 0.18;
/** Elevated enough to read the native floor materials without losing the hero's silhouette. */
const VIEW_DIRECTION = new Vector3(0.32, 0.24, 1).normalize();
const VIEW_RIGHT = new Vector3().crossVectors(new Vector3(0, 1, 0), VIEW_DIRECTION).normalize();
const VIEW_UP = new Vector3().crossVectors(VIEW_DIRECTION, VIEW_RIGHT);
/** Deterministic ambient particles; the floor itself has no procedural dressing or glowing ring. */
const MOTES = 16;
const MOTES_SEED = 0x77a3eb1;

function framingDistance(point: Vector3, vertical: number, horizontal: number): number {
  return point.dot(VIEW_DIRECTION) + 1.06 * Math.max(Math.abs(point.dot(VIEW_RIGHT)) / horizontal, Math.abs(point.dot(VIEW_UP)) / vertical);
}

/** Tiny seeded RNG so the floating motes start in the same place each mount (no Math.random in sim paths). */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Character-select stage: native hero, weapon and hero-specific Tripo pedestal, manifest-bound clips and drag-to-turn.
 * Presentation only; it never touches the simulation. Pedestal contact planes are measured offline at y=0.
 */
export function mountHeroPreview(host: HTMLElement, assets: readonly AssetManifestEntry[], options: HeroPreviewOptions): HeroPreviewHandle {
  const placeholder = host.querySelector<HTMLElement>('[data-preview-placeholder]');
  const setStatus = (state: 'loading' | 'ready' | 'error', message?: string) => {
    host.dataset.previewState = state;
    if (!placeholder) return;
    placeholder.hidden = state === 'ready';
    if (message) placeholder.textContent = message;
  };
  const canvas = document.createElement('canvas');
  canvas.className = 'wc-hero-stage__canvas';
  let renderer: WebGLRenderer;
  try { renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true }); }
  catch {
    setStatus('error', 'The 3D preview is unavailable on this device. Hero details remain below.');
    return { show() {}, showcase() {}, update() {}, dispose() {} };
  }
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  // Cap stays at 2 so a focused hero reads clearly on a Retina display; the title diorama caps lower because the cliff fills less of the frame.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  host.append(canvas);

  const scene = new Scene();
  const keyLight = new DirectionalLight(0xfff0d8, 2.6);
  keyLight.position.set(2.2, 3.6, 3);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.camera.left = keyLight.shadow.camera.bottom = -2.5;
  keyLight.shadow.camera.right = keyLight.shadow.camera.top = 2.5;
  keyLight.shadow.camera.near = 0.1;
  keyLight.shadow.camera.far = 12;
  keyLight.shadow.bias = -0.0002;
  keyLight.shadow.normalBias = 0.015;
  const rimLight = new DirectionalLight(0xffffff, 2.4);
  rimLight.position.set(-2.4, 2.6, -2.8);
  const fillLight = new DirectionalLight(0x9fb8c8, 0.45);
  fillLight.position.set(-3, 1.4, 2);
  scene.add(new HemisphereLight(0xf6efe0, 0x26382b, 1.15), keyLight, rimLight, fillLight);

  const turntable = new Group();
  turntable.rotation.y = -0.32;
  scene.add(turntable);

  // The authored pedestal stays still while the hero turns.
  const platformGroup = new Group();
  platformGroup.name = 'wc-hero-stage-platform';
  scene.add(platformGroup);

  // Mist/mote particles hovering over the platform. Reduced motion skips the time uniform so motes stay static.
  const motesRng = mulberry32(MOTES_SEED);
  const motePositions = new Float32Array(MOTES * 3);
  const moteSeeds = new Float32Array(MOTES);
  for (let index = 0; index < MOTES; index++) {
    const radius = 0.9 + motesRng() * 0.45;
    const angle = motesRng() * Math.PI * 2;
    motePositions[index * 3 + 0] = Math.cos(angle) * radius;
    motePositions[index * 3 + 1] = 0.4 + motesRng() * 1.2;
    motePositions[index * 3 + 2] = Math.sin(angle) * radius;
    moteSeeds[index] = motesRng() * Math.PI * 2;
  }
  const motesGeometry = new BufferGeometry();
  motesGeometry.setAttribute('position', new BufferAttribute(motePositions, 3));
  motesGeometry.setAttribute('aSeed', new BufferAttribute(moteSeeds, 1));
  const motesMaterial = new ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new Color(0xffffff) }, uSize: { value: 3.0 } },
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    vertexShader: `attribute float aSeed; varying float vSeed; uniform float uTime; uniform float uSize; void main() { vSeed = aSeed; vec3 p = position; p.y += sin(uTime * 0.6 + aSeed) * 0.18; p.x += sin(uTime * 0.4 + aSeed * 1.7) * 0.12; p.z += cos(uTime * 0.3 + aSeed * 0.9) * 0.12; vec4 mv = modelViewMatrix * vec4(p, 1.0); gl_PointSize = uSize * (1.0 / max(-mv.z, 0.5)); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying float vSeed; uniform vec3 uColor; void main() { vec2 p = gl_PointCoord * 2.0 - 1.0; float r = length(p); if (r > 1.0) discard; float a = smoothstep(1.0, 0.0, r) * (0.55 + 0.45 * sin(vSeed * 4.0)); gl_FragColor = vec4(uColor, a); }`,
  });
  const motes = new Points(motesGeometry, motesMaterial);
  motes.name = 'wc-hero-stage-motes';
  platformGroup.add(motes);

  const camera = new PerspectiveCamera(28, 1, 0.05, 50);
  const loader = new NativeAssetLoader({ allowMissingActionClips: true });
  const staged = new Map<HeroId, Promise<StagedHero>>();
  const ready = new Map<HeroId, StagedHero>();
  const target = new Vector3();
  const throwPoint = new Vector3();
  const throwForward = new Vector3();
  const corner = new Vector3();
  let current: StagedHero | null = null;
  let wanted: HeroId | null = null;
  let sequence: readonly string[] = [];
  let step = 0;
  let stepElapsed = 0;
  let stepDuration = 0;
  let idleClock = 0;
  let thrownStep = -1;
  let time = 0;
  let disposed = false;
  let sized = false;
  let drag: { x: number; yaw: number } | null = null;

  const manifest = (id: string, kind: AssetManifestEntry['kind']): AssetManifestEntry => {
    const entry = assets.find(candidate => candidate.id === id);
    if (!entry || entry.kind !== kind || entry.sourceType !== 'native-glb' || !entry.runtimeUrl) throw new Error(`The native asset ${id} is not available for the hero preview.`);
    return entry;
  };
  const stage = (heroId: HeroId): Promise<StagedHero> => {
    const existing = staged.get(heroId);
    if (existing) return existing;
    const hero = heroById(heroId);
    const pending = (async () => {
      const actorManifest = manifest(hero.variantAssetId ?? 'actor-aren', 'character');
      const weaponManifest = hero.weaponAssetId ? manifest(hero.weaponAssetId, 'prop') : null;
      const pedestalManifest = manifest(`hero-pedestal-${heroId}`, 'prop');
      const [actorResult, staffResult, pedestalResult] = await Promise.allSettled([
        loader.load(actorManifest),
        weaponManifest ? loader.load(weaponManifest) : Promise.resolve(null),
        loader.load(pedestalManifest),
      ]);
      if (actorResult.status === 'rejected' || staffResult.status === 'rejected' || pedestalResult.status === 'rejected') {
        if (actorResult.status === 'fulfilled') actorResult.value.dispose();
        if (staffResult.status === 'fulfilled') staffResult.value?.dispose();
        if (pedestalResult.status === 'fulfilled') pedestalResult.value.dispose();
        throw actorResult.status === 'rejected' ? actorResult.reason
          : staffResult.status === 'rejected' ? staffResult.reason : (pedestalResult as PromiseRejectedResult).reason;
      }
      const actor = actorResult.value, staff = staffResult.value, pedestal = pedestalResult.value;
      let weapon: WardenWeapon | null = null;
      let fists: HandGeometryEdit | null = null;
      let showcaseFx: VesperShowcaseFx | null = null;
      try {
        if (disposed) throw new Error('Hero preview closed while loading.');
        // In play the actor root is driven to the simulation pose; facing +Z is yaw 0.
        actor.root.position.set(0, 0, 0);
        actor.root.rotation.set(0, 0, 0);
        if (staff) weapon = new WardenWeapon(staff, actor, weaponKindForGrip(hero.weaponGrip));
        else fists = fitUnarmedFists(actor.root);
        actor.root.traverse(node => { if (node instanceof Mesh) node.castShadow = true; });
        const pedestalMeshes: Mesh[] = [];
        pedestal.root.traverse(node => {
          if (node instanceof Mesh) {
            node.castShadow = true;
            node.receiveShadow = true;
            pedestalMeshes.push(node);
          }
        });
        actor.animation.play(hero.idleActionId, 'idle', undefined, 0);
        actor.root.updateMatrixWorld(true);
        pedestal.root.updateMatrixWorld(true);
        const bounds = new Box3().setFromObject(actor.root);
        const pedestalBounds = new Box3().setFromObject(pedestal.root);
        actor.root.visible = pedestal.root.visible = false;
        turntable.add(actor.root);
        platformGroup.add(pedestal.root);
        if (heroId === 'vesper') showcaseFx = new VesperShowcaseFx(scene, actor, weapon, options.reducedMotion, options.motionBlur);
        const entry = { hero, actor, pedestal, weapon, fists, bounds, pedestalBounds, pedestalMeshes, showcaseFx };
        ready.set(heroId, entry);
        return entry;
      } catch (error) {
        showcaseFx?.dispose();
        weapon?.dispose();
        if (!weapon) staff?.dispose();
        if (fists) releaseHandGeometry(fists);
        actor.dispose();
        pedestal.dispose();
        throw error;
      }
    })();
    staged.set(heroId, pending);
    void pending.catch(() => { if (staged.get(heroId) === pending) staged.delete(heroId); });
    return pending;
  };
  const frame = () => {
    if (!current) return;
    const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    const box = current.bounds;
    target.set(0, (Math.max(box.max.y, current.pedestalBounds.max.y) + Math.min(0, current.pedestalBounds.min.y)) * 0.5, 0);
    const vertical = Math.tan(camera.fov * Math.PI / 360);
    const horizontal = vertical * camera.aspect;
    // Fit the hero's idle bounds and the actual floor silhouette, not an oversized box stretching up to the head.
    let distance = 0;
    for (let index = 0; index < 8; index++) {
      corner.set(index & 1 ? box.max.x : box.min.x, index & 2 ? box.max.y : box.min.y, index & 4 ? box.max.z : box.min.z).sub(target);
      distance = Math.max(distance, framingDistance(corner, vertical, horizontal));
    }
    for (const mesh of current.pedestalMeshes) {
      const positions = mesh.geometry.attributes.position!;
      for (let index = 0; index < positions.count; index++) {
        corner.fromBufferAttribute(positions, index).applyMatrix4(mesh.matrixWorld).sub(target);
        distance = Math.max(distance, framingDistance(corner, vertical, horizontal));
      }
    }
    camera.position.copy(target).addScaledVector(VIEW_DIRECTION, distance);
    camera.near = distance / 50;
    camera.far = distance * 4;
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    sized = true;
  };
  const bringForward = (entry: StagedHero) => {
    host.dataset.previewHero = entry.hero.id;
    host.dataset.previewPedestal = entry.pedestal.assetId;
    if (current === entry) { setStatus('ready'); return; }
    if (current) {
      current.actor.root.visible = current.pedestal.root.visible = false;
      current.showcaseFx?.reset();
      current.weapon?.cancelThrow();
    }
    current = entry;
    entry.actor.root.visible = entry.pedestal.root.visible = true;
    const accent = new Color(entry.hero.accent);
    rimLight.color.copy(accent);
    motesMaterial.uniforms.uColor!.value.copy(accent);
    sequence = options.reducedMotion ? [] : entry.hero.revealActionIds;
    step = 0; stepElapsed = 0; stepDuration = 0; idleClock = 0; thrownStep = -1;
    frame();
    setStatus('ready');
  };
  const drive = (dt: number) => {
    if (!current) return;
    const { actor, weapon, hero } = current;
    const animation = actor.animation;
    let playedAction = hero.idleActionId, progress = 0;
    while (step < sequence.length && !animation.hasAction(sequence[step]!)) step++;
    if (step < sequence.length) {
      const actionId = sequence[step]!;
      playedAction = actionId;
      if (stepElapsed === 0) {
        animation.play(actionId, 'active', 0);
        const unscaled = actionId.endsWith('-charge') || actionId === 'cleanse' || actionId.endsWith('-cleanse')
          || actionId === 'vesper-mist-blink' || actionId === 'sakda-guard-dash';
        const rate = unscaled ? 1 : HERO_COMBAT[hero.id].attackPlaybackRate / HERO_COMBAT[hero.id].clipSlowdown;
        stepDuration = Math.max(0.1, (hero.id === 'vesper' ? vesperActionSeconds(actionId) : undefined) ?? (animation.activeDuration ?? 0.1) / rate);
      }
      stepElapsed += dt;
      progress = Math.min(1, stepElapsed / stepDuration);
      animation.play(actionId, 'active', hero.id === 'vesper' ? vesperClipProgress(actionId, progress) : progress);
      weapon?.setEdgeIntensity(1.8);
      if (stepElapsed >= stepDuration + SHOWCASE_HOLD_SECONDS) { step++; stepElapsed = 0; }
    } else {
      idleClock += dt;
      animation.play(hero.idleActionId, 'idle', undefined, idleClock);
      weapon?.setEdgeIntensity(WARDEN_EDGE_IDLE_INTENSITY);
    }
    weapon?.setClip(playedAction, dt);
    // The preview has no simulation cues: the Sap Lance throw leaves the fist at the clip's authored release tick, like the cue does in play.
    if (weapon && playedAction === SAP_LANCE_RELEASE.clipId && step < sequence.length && thrownStep !== step && progress >= SAP_LANCE_RELEASE.activeTick / SAP_LANCE_RELEASE.totalTicks) {
      thrownStep = step;
      weapon.sockets.weapon.getWorldPosition(throwPoint);
      actor.root.getWorldDirection(throwForward);
      throwPoint.addScaledVector(throwForward.setY(0).normalize(), SAP_LANCE_RELEASE.previewReach);
      weapon.throwStaff(throwPoint);
    }
    animation.update(dt);
    current.showcaseFx?.update(playedAction, progress, stepDuration, dt, camera.position);
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    drag = { x: event.clientX, yaw: turntable.rotation.y };
    canvas.setPointerCapture(event.pointerId);
    host.dataset.dragging = 'true';
  };
  const onPointerMove = (event: PointerEvent) => {
    if (!drag) return;
    turntable.rotation.y = drag.yaw + (event.clientX - drag.x) / Math.max(1, host.clientWidth) * Math.PI * 1.8;
  };
  const onPointerEnd = () => { drag = null; delete host.dataset.dragging; };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerEnd);
  canvas.addEventListener('pointercancel', onPointerEnd);
  const observer = new ResizeObserver(() => { sized = false; });
  observer.observe(host);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer.disconnect();
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerEnd);
    canvas.removeEventListener('pointercancel', onPointerEnd);
    for (const entry of ready.values()) {
      entry.showcaseFx?.dispose();
      entry.weapon?.dispose();
      if (entry.fists) releaseHandGeometry(entry.fists);
      entry.actor.dispose();
      entry.pedestal.dispose();
    }
    ready.clear();
    staged.clear();
    current = null;
    motesGeometry.dispose();
    motesMaterial.dispose();
    scene.clear();
    keyLight.shadow.dispose();
    delete host.dataset.previewHero;
    delete host.dataset.previewPedestal;
    delete host.dataset.dragging;
    renderer.dispose();
    loader.dispose();
    canvas.remove();
  };

  setStatus('loading');
  return {
    show(heroId) {
      if (disposed) return;
      wanted = heroId;
      const loaded = ready.get(heroId);
      if (loaded) { bringForward(loaded); return; }
      setStatus('loading', `Bringing ${heroById(heroId).name} forward…`);
      stage(heroId).then(entry => { if (!disposed && wanted === heroId) bringForward(entry); }, (error: unknown) => {
        if (disposed || wanted !== heroId) return;
        setStatus('error', error instanceof Error ? error.message : String(error));
      });
    },
    showcase(actionIds) {
      if (disposed || !current) return;
      current.showcaseFx?.reset();
      sequence = actionIds;
      step = 0; stepElapsed = 0; stepDuration = 0; thrownStep = -1;
      current.weapon?.cancelThrow();
    },
    update(dt) {
      if (disposed) return;
      if (!host.isConnected) { dispose(); return; }
      if (!current) return;
      const delta = Math.max(0, Math.min(dt, 0.1));
      if (!options.reducedMotion) time += delta;
      motesMaterial.uniforms.uTime!.value = time;
      drive(delta);
      if (!sized) frame();
      renderer.render(scene, camera);
    },
    dispose,
  };
}
