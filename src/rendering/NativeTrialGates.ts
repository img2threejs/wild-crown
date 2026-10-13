import { Box3, DoubleSide, Group, Mesh, PlaneGeometry, Ray, ShaderMaterial, Vector2, Vector3, type Camera, type Material, type Scene } from 'three';
import type { AssetManifestEntry, TrialGateSnapshot, Vec3 } from '../game/contracts.js';
import type { CombatTrialDefinition } from '../game/combat/CombatTrials.js';
import { distanceToBoxFootprint } from '../world/GreenwakeBoundary.js';
import type { NativeAssetInstance, NativeAssetLoader } from './NativeAssetLoader.js';

/** Seconds the seal flash, dissolve and sink take after a gate's snapshot flips to open. */
export const GATE_OPEN_SECONDS = 1.2;
/** Aren this close (m, horizontal, to the gate box) makes the sap seal ripple. */
export const GATE_CONTACT_PULSE_RADIUS = 2.5;
/** How far the opened gate sinks into the ground. */
const SINK_METERS = 3;
/** Seal alpha/emissive scale while the gate stands between the fixed camera and Aren, and the time the fade takes to settle. */
const OCCLUDED_ALPHA = 0.2;
const OCCLUSION_FADE_SECONDS = 0.15;
const MAX_STRETCH = 1.35;
/** A closed gate's root-wall visual is at most this much thicker (in depth) than its collider before it is squashed. */
const MIN_DEPTH_SCALE = 0.6;

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** Black-green sap with scrolling emissive veins; emissive terms exceed 1.0 so the HDR bloom picks them up. */
const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uOpen;
uniform float uFlash;
uniform float uPulse;
uniform float uFade;
uniform float uAspect;
uniform vec2 uHit;
varying vec2 vUv;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float value = 0.0, amplitude = 0.5;
  for (int i = 0; i < 4; i++) { value += amplitude * noise(p); p = p * 2.03 + vec2(17.1, 9.7); amplitude *= 0.5; }
  return value;
}
void main() {
  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  float broad = fbm(p * 2.4 + vec2(0.0, -uTime * 0.22));
  float fine = fbm(p * 4.7 + vec2(uTime * 0.11, -uTime * 0.37) + broad * 1.7);
  float veins = clamp((1.0 - smoothstep(0.0, 0.07, abs(fine - 0.5))) + 0.6 * (1.0 - smoothstep(0.0, 0.05, abs(broad - 0.5))), 0.0, 1.0);
  vec2 edge = min(vUv, 1.0 - vUv);
  float edgeFade = smoothstep(0.0, 0.08, edge.x) * smoothstep(0.0, 0.1, edge.y);
  float r = length((vUv - uHit) * vec2(uAspect, 1.0));
  float ripple = uPulse * (sin((r - uTime * 2.4) * 14.0) * 0.5 + 0.5) * exp(-r * 1.4);
  vec3 glow = vec3(0.22, 1.0, 0.38);
  // uFade is the smoothed camera-occlusion factor (1 = clear, 0.2 = the seal stands between camera and Aren).
  // It dims both the alpha and the HDR emissive so bloom cannot keep the plane bright; ripple and flash stay readable.
  float see = clamp((uFade - 0.2) / 0.8, 0.0, 1.0);
  float emissive = mix(0.1, 1.0, see);
  float rippleGain = mix(0.6, 1.0, see);
  vec3 color = vec3(0.012, 0.04, 0.02) + glow * (veins * (1.6 + uPulse * 2.2) * emissive + ripple * 2.5 * rippleGain) + vec3(0.7, 1.0, 0.75) * uFlash * 3.0;
  float alpha = clamp(edgeFade * ((0.5 + 0.4 * veins) * uFade + ripple * 0.4 * rippleGain), 0.0, 1.0);
  float dissolve = fbm(p * 3.1 + 3.7);
  float cut = uOpen * 1.25 - 0.12;
  if (uOpen > 0.0) {
    if (dissolve < cut) discard;
    color += glow * (1.0 - smoothstep(cut, cut + 0.08, dissolve)) * 4.0 * emissive;
    alpha = max(alpha, 0.9 * uFade);
  }
  gl_FragColor = vec4(color, clamp(alpha + uFlash * 0.5, 0.0, 1.0));
}`;

type GateState = 'closed' | 'opening' | 'open';
interface GateVisual {
  readonly root: Group;
  readonly seal: Mesh;
  readonly material: ShaderMaterial;
  readonly baseY: number;
  readonly centre: Vector3;
  /** World direction along the gate's long side. */
  readonly along: Vector3;
  readonly width: number;
  state: GateState;
  openedAt: number;
  contact: number;
  /** Smoothed seal visibility (1 = clear, OCCLUDED_ALPHA = occluding the camera->Aren ray) and its target. */
  fade: number;
  fadeTarget: number;
}
/** Emitted once when a gate's snapshot flips from closed to open; drain with `openingEvents()`. */
export interface GateOpeningEvent { readonly gateId: string; readonly position: Vec3 }

/**
 * Solid native root gates. The model is fitted to each simulation-owned closed box (uniform height fit, mild stretch or
 * tiling along the wide side) and every gate carries a procedural sap seal that ripples on contact and dissolves on opening.
 */
export class NativeTrialGates {
  readonly group = new Group();
  /**
   * Distance (m) from the player to the nearest closed gate box as of the last `animate`; Infinity without a player or
   * closed gate. The HUD gate-contact notice shows at <= 1.5 m.
   */
  closestClosedGateDistance = Infinity;
  private readonly instances: NativeAssetInstance[] = [];
  private readonly visuals: GateVisual[] = [];
  private readonly ownedMaterials: Material[] = [];
  private readonly gateMaterials: Material[][] = [];
  private readonly bounds: Box3[] = [];
  private readonly sealGeometry = new PlaneGeometry(1, 1);
  private readonly ray = new Ray();
  private readonly hit = new Vector3();
  private readonly scratchHit = new Vector2();
  private pending: GateOpeningEvent[] = [];
  private drained: GateOpeningEvent[] = [];
  private initialised = false;
  private lastFrame = 0;
  private disposed = false;
  private constructor(scene: Scene, private readonly trials: readonly CombatTrialDefinition[]) { this.group.name = 'native-trial-gates'; scene.add(this.group); }

  /** Fits one root-wall gate per trial of the active region's trial set (same order as the simulation's gates). */
  static async load(scene: Scene, loader: NativeAssetLoader, manifest: AssetManifestEntry, trials: readonly CombatTrialDefinition[]): Promise<NativeTrialGates> {
    const gates = new NativeTrialGates(scene, trials);
    try {
      const first = await loader.load(manifest); gates.instances.push(first);
      const source = new Box3().setFromObject(first.root), size = source.getSize(new Vector3()), middle = source.getCenter(new Vector3());
      if (!Number.isFinite(size.x + size.y + size.z) || size.x <= 0 || size.y <= 0 || size.z <= 0) throw new Error('Native gate must have finite volume.');
      // The wide horizontal axis of the model (the root wall between its two stones) is laid along the box's long side.
      const wide = size.x >= size.z ? 'x' : 'z', thick = wide === 'x' ? 'z' : 'x';
      let used = false;
      for (const stage of trials) {
        const half = stage.gate.halfExtents!, position = stage.gate.from;
        const long = half.x >= half.z ? 'x' : 'z';
        const span = half[long] * 2, depth = half[long === 'x' ? 'z' : 'x'] * 2;
        const bottom = position.y - half.y + 0.5, height = half.y * 2 - 0.5;
        const uniform = height / size.y;
        const tiles = Math.max(1, Math.ceil(span / (size[wide] * uniform * MAX_STRETCH) - 1e-9));
        const stretch = span / (tiles * size[wide] * uniform);
        const depthScale = Math.min(1, Math.max(MIN_DEPTH_SCALE, depth / (size[thick] * uniform)));
        const root = new Group(); root.name = stage.gate.id;
        root.position.set(position.x, bottom, position.z);
        const fit = new Group();
        fit.rotation.y = wide === long ? 0 : Math.PI / 2;
        root.add(fit);
        const materials = new Map<Material, Material>();
        const own = (original: Material): Material => {
          let material = materials.get(original);
          if (!material) {
            material = original.clone(); material.transparent = true; material.depthWrite = false;
            materials.set(original, material); gates.ownedMaterials.push(material);
          }
          return material;
        };
        for (let tile = 0; tile < tiles; tile++) {
          const instance = used ? await loader.load(manifest) : first;
          if (used) gates.instances.push(instance);
          used = true;
          const holder = new Group();
          const scale = { x: 0, y: uniform, z: 0 };
          scale[wide] = uniform * stretch; scale[thick] = uniform * depthScale;
          holder.scale.set(scale.x, scale.y, scale.z);
          const offset = (tile - (tiles - 1) / 2) * size[wide] * uniform * stretch;
          holder.position.set(
            -middle.x * scale.x + (wide === 'x' ? offset : 0),
            -source.min.y * uniform,
            -middle.z * scale.z + (wide === 'z' ? offset : 0),
          );
          holder.add(instance.root);
          fit.add(holder);
        }
        fit.traverse(node => {
          if (!(node instanceof Mesh)) return;
          node.castShadow = true; node.receiveShadow = true;
          node.material = Array.isArray(node.material) ? node.material.map(own) : own(node.material);
        });
        // Sap seal across the root wall's opening, centred on the knot (the model's horizontal centre, mid height).
        const sealWidth = span * 0.72, sealHeight = height * 0.86;
        const material = new ShaderMaterial({
          vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: false, side: DoubleSide,
          uniforms: { uTime: { value: 0 }, uOpen: { value: 0 }, uFlash: { value: 0 }, uPulse: { value: 0 }, uFade: { value: 1 }, uAspect: { value: sealWidth / sealHeight }, uHit: { value: new Vector2(0.5, 0.35) } },
        });
        gates.ownedMaterials.push(material);
        const seal = new Mesh(gates.sealGeometry, material);
        seal.name = stage.gate.id + ':sap-seal';
        seal.scale.set(sealWidth, sealHeight, 1);
        seal.rotation.y = long === 'x' ? 0 : Math.PI / 2;
        seal.position.set(0, height * ((middle.y - source.min.y) / size.y), 0);
        seal.renderOrder = 5;
        root.add(seal);
        gates.gateMaterials.push([...materials.values()]);
        gates.bounds.push(new Box3(new Vector3(position.x - half.x, position.y - half.y, position.z - half.z), new Vector3(position.x + half.x, position.y + half.y, position.z + half.z)));
        gates.visuals.push({
          root, seal, material, baseY: bottom, centre: new Vector3(position.x, position.y, position.z),
          along: long === 'x' ? new Vector3(1, 0, 0) : new Vector3(0, 0, 1), width: sealWidth, state: 'closed', openedAt: 0, contact: 0, fade: 1, fadeTarget: 1,
        });
        gates.group.add(root);
      }
      return gates;
    } catch (error) { gates.dispose(); throw error; }
  }

  /** Mirrors the simulation: a gate flipping to open starts its opening sequence; a gate that is closed again (reset) snaps back. */
  update(snapshots: readonly TrialGateSnapshot[]): void {
    for (let index = 0; index < this.visuals.length; index++) {
      const id = this.trials[index]!.id, visual = this.visuals[index]!;
      let open = false;
      for (let candidate = 0; candidate < snapshots.length; candidate++) if (snapshots[candidate]!.id === id) { open = snapshots[candidate]!.open; break; }
      if (open && visual.state === 'closed') {
        if (this.initialised) {
          visual.state = 'opening'; visual.openedAt = NaN;
          this.pending.push({ gateId: this.trials[index]!.gate.id, position: { x: visual.centre.x, y: visual.centre.y, z: visual.centre.z } });
        } else { visual.state = 'open'; visual.root.visible = false; }
      } else if (!open && visual.state !== 'closed') {
        visual.state = 'closed'; visual.root.visible = true; visual.root.position.y = visual.baseY;
        const uniforms = visual.material.uniforms;
        uniforms.uOpen!.value = 0; uniforms.uFlash!.value = 0;
      }
    }
    this.initialised = true;
  }

  /**
   * Drains the gates that started opening since the previous call (camera shake / VFX trigger). The returned array is
   * reused by the next call; copy anything that must outlive the frame.
   */
  openingEvents(): readonly GateOpeningEvent[] {
    const events = this.pending;
    this.pending = this.drained; this.pending.length = 0;
    this.drained = events;
    return events;
  }

  /** Per-frame visuals: seal shader time, contact ripple within 2.5 m, and the 1.2 s open transition. */
  animate(worldTimeSeconds: number, playerPosition: Readonly<Vec3> | undefined): void {
    let closest = Infinity;
    // Occlusion fades run on real time (presentation only), so they also settle while world time is paused or slowed.
    const now = performance.now(), dt = this.lastFrame === 0 ? 1 / 60 : Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const blend = 1 - Math.exp(-dt / (OCCLUSION_FADE_SECONDS / 3));
    for (let index = 0; index < this.visuals.length; index++) {
      const visual = this.visuals[index]!, uniforms = visual.material.uniforms;
      uniforms.uTime!.value = worldTimeSeconds;
      visual.fade += (visual.fadeTarget - visual.fade) * blend;
      if (Math.abs(visual.fadeTarget - visual.fade) < 0.003) visual.fade = visual.fadeTarget;
      uniforms.uFade!.value = visual.fade;
      if (visual.state === 'closed') {
        let contact = 0;
        if (playerPosition) {
          const distance = distanceToBoxFootprint(this.trials[index]!.gate, playerPosition.x, playerPosition.z);
          closest = Math.min(closest, distance);
          contact = Math.max(0, 1 - distance / GATE_CONTACT_PULSE_RADIUS);
          if (contact > 0) {
            const along = (playerPosition.x - visual.centre.x) * visual.along.x + (playerPosition.z - visual.centre.z) * visual.along.z;
            this.scratchHit.set(Math.min(1, Math.max(0, 0.5 + along / visual.width)), 0.35);
            (uniforms.uHit!.value as Vector2).copy(this.scratchHit);
          }
        }
        // Ease towards the target so the ripple swells and fades instead of popping.
        visual.contact += (contact - visual.contact) * 0.18;
        uniforms.uPulse!.value = visual.contact * (0.75 + 0.25 * Math.sin(worldTimeSeconds * 9));
      } else if (visual.state === 'opening') {
        if (Number.isNaN(visual.openedAt)) visual.openedAt = worldTimeSeconds;
        const t = (worldTimeSeconds - visual.openedAt) / GATE_OPEN_SECONDS;
        if (t >= 1) { visual.state = 'open'; visual.root.visible = false; continue; }
        // Seal flash (0-0.2), noise dissolve (0.15-0.85), then the gate sinks 3 m with a small jitter (0.25-1).
        uniforms.uFlash!.value = t < 0.2 ? t / 0.2 : Math.max(0, 1 - (t - 0.2) / 0.3);
        uniforms.uOpen!.value = Math.min(1, Math.max(0, (t - 0.15) / 0.7));
        uniforms.uPulse!.value = 0;
        const sink = Math.max(0, (t - 0.25) / 0.75);
        visual.root.position.set(
          visual.centre.x + (sink > 0 ? Math.sin(worldTimeSeconds * 83) * 0.05 * (1 - sink) : 0),
          visual.baseY - SINK_METERS * sink * sink,
          visual.centre.z + (sink > 0 ? Math.cos(worldTimeSeconds * 71) * 0.05 * (1 - sink) : 0),
        );
      }
    }
    this.closestClosedGateDistance = closest;
  }

  updateOcclusion(camera: Camera, target: Vector3): void {
    this.ray.origin.copy(camera.position); this.ray.direction.subVectors(target, camera.position);
    const distanceSquared = this.ray.direction.lengthSq();
    if (distanceSquared === 0) return;
    this.ray.direction.multiplyScalar(1 / Math.sqrt(distanceSquared));
    for (let index = 0; index < this.visuals.length; index++) {
      if (!this.visuals[index]!.root.visible) continue;
      const hit = this.ray.intersectBox(this.bounds[index]!, this.hit);
      const occluded = hit !== null && hit.distanceToSquared(camera.position) < distanceSquared;
      for (const material of this.gateMaterials[index]!) material.opacity = occluded ? 0.3 : 1;
      this.visuals[index]!.fadeTarget = occluded ? OCCLUDED_ALPHA : 1;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.group.removeFromParent();
    for (const material of this.ownedMaterials) material.dispose();
    this.sealGeometry.dispose();
    for (const instance of this.instances) instance.dispose();
    this.group.clear();
    this.instances.length = 0; this.visuals.length = 0; this.ownedMaterials.length = 0; this.gateMaterials.length = 0; this.bounds.length = 0;
    this.pending.length = 0; this.drained.length = 0;
  }
}
