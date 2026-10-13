import { ACESFilmicToneMapping, Box3, CircleGeometry, Color, DirectionalLight, Group, HemisphereLight, Mesh, PerspectiveCamera, SRGBColorSpace, Scene, ShaderMaterial, Vector3, WebGLRenderer } from 'three';
import type { AssetManifestEntry } from '../game/contracts';
import { heroById, type HeroDefinition, type HeroId } from '../game/heroes';
import { NativeAssetLoader, type NativeAssetInstance } from './NativeAssetLoader';
import { WARDEN_EDGE_IDLE_INTENSITY, WardenWeapon, weaponKindForGrip } from './WardenWeapon';
import { fitUnarmedFists, releaseHandGeometry, type HandGeometryEdit } from './NativeHandGrip';

export interface HeroPreviewOptions { readonly reducedMotion: boolean }
export interface HeroPreviewHandle {
  /** Brings the hero forward (loading it on first use) and plays its reveal flourish unless motion is reduced. */
  show(heroId: HeroId): void;
  /** Plays native actions once, in order, then settles back into the idle loop. */
  showcase(actionIds: readonly string[]): void;
  update(dt: number): void;
  dispose(): void;
}

interface StagedHero { readonly hero: HeroDefinition; readonly actor: NativeAssetInstance; /** Absent for an unarmed hero (no `weaponAssetId`). */ readonly weapon: WardenWeapon | null; readonly fists: HandGeometryEdit | null; readonly bounds: Box3 }

/** Seconds a finished showcase clip holds its last pose before the next one starts. */
const SHOWCASE_HOLD_SECONDS = 0.18;
const VIEW_DIRECTION = new Vector3(0.3, 0.14, 1).normalize();
/** Ground sigil radius (m); the framing keeps the whole ring inside the stage. */
const GROUND_RADIUS = 0.95;
const GROUND_VERTEX = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
/** Contact pool under the feet plus a slowly turning dashed sigil ring in the hero's element colour. */
const GROUND_FRAGMENT = /* glsl */`
uniform vec3 uColor;
uniform float uTime;
uniform float uPulse;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float pool = smoothstep(0.7, 0.0, r) * 0.6;
  float angle = atan(p.y, p.x) / 6.28318 + 0.5;
  float dash = step(0.42, fract(angle * 40.0 + uTime * 0.04));
  float outer = smoothstep(0.022, 0.0, abs(r - 0.9)) * dash;
  float inner = smoothstep(0.012, 0.0, abs(r - 0.7)) * 0.6;
  float glow = (outer + inner) * (0.55 + 0.6 * uPulse);
  float fade = smoothstep(1.0, 0.93, r);
  gl_FragColor = vec4(uColor * glow * 1.7, clamp(pool + glow, 0.0, 1.0) * fade);
}`;

/**
 * Character-select stage: the exact native hero GLB with its native weapon, the same manifest-bound clips the game plays,
 * a drag-to-turn turntable and an element-coloured ground sigil. Presentation only; it never touches the simulation.
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
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  host.append(canvas);

  const scene = new Scene();
  const keyLight = new DirectionalLight(0xfff0d8, 2.6);
  keyLight.position.set(2.2, 3.6, 3);
  const rimLight = new DirectionalLight(0xffffff, 2.4);
  rimLight.position.set(-2.4, 2.6, -2.8);
  const fillLight = new DirectionalLight(0x9fb8c8, 0.45);
  fillLight.position.set(-3, 1.4, 2);
  scene.add(new HemisphereLight(0xf6efe0, 0x26382b, 1.15), keyLight, rimLight, fillLight);
  const turntable = new Group();
  turntable.rotation.y = -0.32;
  scene.add(turntable);
  const groundUniforms = { uColor: { value: new Color() }, uTime: { value: 0 }, uPulse: { value: 0 } };
  const ground = new Mesh(new CircleGeometry(GROUND_RADIUS, 72), new ShaderMaterial({
    vertexShader: GROUND_VERTEX, fragmentShader: GROUND_FRAGMENT, transparent: true, depthWrite: false, uniforms: groundUniforms,
  }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0.003;
  ground.renderOrder = -1;
  turntable.add(ground);
  const camera = new PerspectiveCamera(28, 1, 0.05, 50);
  const loader = new NativeAssetLoader({ allowMissingActionClips: true });
  const staged = new Map<HeroId, Promise<StagedHero>>();
  const ready = new Map<HeroId, StagedHero>();
  const target = new Vector3();
  let current: StagedHero | null = null;
  let wanted: HeroId | null = null;
  let sequence: readonly string[] = [];
  let step = 0;
  let stepElapsed = 0;
  let stepDuration = 0;
  let idleClock = 0;
  let pulse = 0;
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
      const [actorResult, staffResult] = await Promise.allSettled([
        loader.load(actorManifest),
        weaponManifest ? loader.load(weaponManifest) : Promise.resolve(null),
      ]);
      if (actorResult.status === 'rejected' || staffResult.status === 'rejected') {
        if (actorResult.status === 'fulfilled') actorResult.value.dispose();
        if (staffResult.status === 'fulfilled') staffResult.value?.dispose();
        throw actorResult.status === 'rejected' ? actorResult.reason : (staffResult as PromiseRejectedResult).reason;
      }
      const actor = actorResult.value, staff = staffResult.value;
      let weapon: WardenWeapon | null = null;
      let fists: HandGeometryEdit | null = null;
      try {
        if (disposed) throw new Error('Hero preview closed while loading.');
        // In play the actor root is driven to the simulation pose; facing +Z is yaw 0.
        actor.root.position.set(0, 0, 0);
        actor.root.rotation.set(0, 0, 0);
        if (staff) weapon = new WardenWeapon(staff, actor, weaponKindForGrip(hero.weaponGrip));
        else fists = fitUnarmedFists(actor.root);
        actor.animation.play(hero.idleActionId, 'idle', undefined, 0);
        actor.root.updateMatrixWorld(true);
        const bounds = new Box3().setFromObject(actor.root);
        actor.root.visible = false;
        turntable.add(actor.root);
        const entry = { hero, actor, weapon, fists, bounds };
        ready.set(heroId, entry);
        return entry;
      } catch (error) {
        weapon?.dispose();
        if (!weapon) staff?.dispose();
        if (fists) releaseHandGeometry(fists);
        actor.dispose();
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
    const box = current.bounds, top = Math.max(1.2, box.max.y);
    target.set(0, top * 0.46, 0);
    const vertical = Math.tan(camera.fov * Math.PI / 360);
    const horizontal = vertical * camera.aspect;
    const halfWidth = Math.max(GROUND_RADIUS, Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z));
    const distance = Math.max(top * 0.64 / vertical, halfWidth * 1.15 / horizontal);
    camera.position.copy(target).addScaledVector(VIEW_DIRECTION, distance);
    camera.near = distance / 50;
    camera.far = distance * 4;
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    sized = true;
  };
  const bringForward = (entry: StagedHero) => {
    if (current === entry) return;
    if (current) current.actor.root.visible = false;
    current = entry;
    entry.actor.root.visible = true;
    const accent = new Color(entry.hero.accent);
    rimLight.color.copy(accent);
    groundUniforms.uColor.value.copy(accent);
    sequence = options.reducedMotion ? [] : entry.hero.revealActionIds;
    step = 0; stepElapsed = 0; stepDuration = 0; idleClock = 0; pulse = 1;
    frame();
    setStatus('ready');
  };
  const drive = (dt: number) => {
    if (!current) return;
    const { actor, weapon, hero } = current;
    const animation = actor.animation;
    while (step < sequence.length && !animation.hasAction(sequence[step]!)) step++;
    if (step < sequence.length) {
      const actionId = sequence[step]!;
      if (stepElapsed === 0) { animation.play(actionId, 'active', 0); stepDuration = Math.max(0.1, animation.activeDuration ?? 0.1); }
      stepElapsed += dt;
      animation.play(actionId, 'active', Math.min(1, stepElapsed / stepDuration));
      weapon?.setEdgeIntensity(1.8);
      if (stepElapsed >= stepDuration + SHOWCASE_HOLD_SECONDS) { step++; stepElapsed = 0; }
    } else {
      idleClock += dt;
      animation.play(hero.idleActionId, 'idle', undefined, idleClock);
      weapon?.setEdgeIntensity(WARDEN_EDGE_IDLE_INTENSITY);
    }
    animation.update(dt);
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
    for (const entry of ready.values()) { entry.weapon?.dispose(); if (entry.fists) releaseHandGeometry(entry.fists); entry.actor.dispose(); }
    ready.clear();
    staged.clear();
    current = null;
    ground.geometry.dispose();
    ground.material.dispose();
    scene.clear();
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
      sequence = actionIds;
      step = 0; stepElapsed = 0; stepDuration = 0; pulse = 1;
    },
    update(dt) {
      if (disposed) return;
      if (!host.isConnected) { dispose(); return; }
      if (!current) return;
      const delta = Math.max(0, Math.min(dt, 0.1));
      if (!options.reducedMotion) time += delta;
      pulse *= Math.exp(-delta * 2.4);
      groundUniforms.uTime.value = time;
      groundUniforms.uPulse.value = pulse;
      drive(delta);
      if (!sized) frame();
      renderer.render(scene, camera);
    },
    dispose,
  };
}
