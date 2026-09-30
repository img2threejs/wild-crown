import * as THREE from 'three';
import type { CueCancellationReason, CueShape, StoryCue } from './story-cues.js';

export interface StoryEffectsOptions {
  readonly scene: THREE.Scene;
  readonly resolveSocket?: (actorId: string, socketName: string) => THREE.Object3D | undefined;
  readonly reducedEffects?: boolean;
  readonly capacity?: number;
}

interface EffectSlot {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshBasicMaterial;
  readonly sectorGeometry: THREE.BufferGeometry;
  readonly sectorPositions: Float32Array;
  active: boolean;
  essential: boolean;
  priority: number;
  startTick: number;
  durationTicks: number;
  scopeId: string | undefined;
  instanceId: string;
  kind: StoryCue['kind'];
  phase: StoryCue['phase'];
  shape: CueShape;
  start: THREE.Vector3;
  end: THREE.Vector3;
  width: number;
  length: number;
  angle: number;
  sectorRadians: number;
}

const COLORS: Readonly<Record<StoryCue['kind'], number>> = {
  anticipation: 0xbfa06e, commit: 0xc9a568, hit: 0x9c6949, landing: 0x816f55,
  heartroot: 0xc1a66d, 'perfect-dodge': 0xd1c29b, tether: 0x9dbc99, cleanse: 0xb7c69e, bond: 0xa5c3a4,
  dominion: 0x78573c, restoration: 0x9cb890, 'restoration-water': 0x83a9a1, 'restoration-roots': 0x997c5b,
  'restoration-seeds': 0xb3bf84, 'restoration-animals': 0xa1c39b, possession: 0x784e3e, phase: 0xa98353,
  ending: 0xc5b786, 'ending-living-pact': 0xa1c39b, 'ending-dominion': 0x8b6441, 'ending-severance': 0xb6a978,
  'sap-vein': 0x51332a, footprint: 0x9a815f, pounce: 0x997c5b, 'roar-cone': 0xb39769, 'low-wave': 0x847859,
  grovebreak: 0x876547, march: 0x74634a, reunion: 0xa7bd9c, heartbeat: 0x6e9577,
};
const ESSENTIAL: Readonly<Partial<Record<StoryCue['kind'], true>>> = { anticipation: true, commit: true, phase: true };
const COSMETIC: Readonly<Partial<Record<StoryCue['kind'], true>>> = { 'sap-vein': true, footprint: true, heartbeat: true, march: true };
const CAPACITY_MIN = 8;
const CAPACITY_MAX = 96;
const SECTOR_SEGMENTS = 40;
const SECTOR_INNER_RADIUS = 0.94;

/** Pooled Three.js story presentation. It never writes simulation or campaign state. */
export class StoryEffects {
  readonly group = new THREE.Group();
  private readonly slots: EffectSlot[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private reduced: boolean;
  private destroyed = false;
  private tick = 0;
  private readonly socket?: StoryEffectsOptions['resolveSocket'];

  constructor(options: StoryEffectsOptions) {
    this.reduced = options.reducedEffects ?? false;
    this.socket = options.resolveSocket;
    this.group.name = 'story-effects';
    const capacity = Math.max(CAPACITY_MIN, Math.min(CAPACITY_MAX, options.capacity ?? 48));
    this.geometries = [
      new THREE.TorusGeometry(0.95, 0.05, 6, 36),
      new THREE.RingGeometry(0.42, 0.52, 32, 1, Math.PI / 3, Math.PI * 4 / 3),
      new THREE.CylinderGeometry(0.035, 0.035, 1, 8, 1, true),
      new THREE.SphereGeometry(0.4, 12, 8),
      new THREE.CircleGeometry(0.5, 16),
    ];
    for (let i = 0; i < capacity; i++) {
      const material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.72, depthWrite: false, side: THREE.DoubleSide });
      const sectorPositions = new Float32Array(SECTOR_SEGMENTS * 6 * 3);
      const sectorGeometry = new THREE.BufferGeometry();
      sectorGeometry.setAttribute('position', new THREE.BufferAttribute(sectorPositions, 3));
      sectorGeometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(SECTOR_SEGMENTS * 6 * 3), 3));
      const mesh = new THREE.Mesh(this.geometries[i % this.geometries.length]!, material);
      mesh.visible = false;
      this.group.add(mesh);
      this.slots.push({ mesh, material, sectorGeometry, sectorPositions, active: false, essential: false, priority: 0, startTick: 0, durationTicks: 1, scopeId: undefined, instanceId: '', kind: 'hit', phase: 'hit', shape: 'ring', start: new THREE.Vector3(), end: new THREE.Vector3(), width: 1, length: 1, angle: 0, sectorRadians: 0 });
    }
    options.scene.add(this.group);
  }

  setReducedEffects(reduced: boolean): void { this.reduced = reduced; }

  emit(cue: StoryCue): boolean {
    if (this.destroyed || this.seen.has(cue.instanceId)) return false;
    const shape = cue.shape ?? this.defaultShape(cue.kind);
    const sectorRadians = cue.footprint?.sectorRadians;
    if (shape === 'sector' && (!Number.isFinite(sectorRadians) || sectorRadians! <= 0 || sectorRadians! > Math.PI * 2)) {
      throw new RangeError('Sector cues require authored footprint.sectorRadians in (0, 2π].');
    }
    this.seen.add(cue.instanceId);
    this.seenOrder.push(cue.instanceId);
    if (this.seenOrder.length > 512) this.seen.delete(this.seenOrder.shift()!);
    const priority = cue.priority === 'essential' || ESSENTIAL[cue.kind] ? 3 : cue.priority === 'story' ? 2 : COSMETIC[cue.kind] ? 0 : 1;
    const slot = this.acquire(priority);
    if (!slot) return false;
    slot.active = true;
    slot.essential = priority === 3;
    slot.priority = priority;
    slot.startTick = cue.tick;
    slot.durationTicks = Math.max(1, Math.round(cue.durationTicks ?? (priority === 3 ? 42 : 36)));
    slot.scopeId = cue.scopeId;
    slot.instanceId = cue.instanceId;
    slot.kind = cue.kind;
    slot.phase = cue.phase;
    slot.shape = shape;
    slot.width = Math.max(0.08, cue.footprint?.width ?? (priority === 3 ? 1.6 : 1.1));
    slot.length = Math.max(0.08, cue.footprint?.length ?? slot.width);
    slot.angle = cue.footprint?.angleRadians ?? 0;
    slot.sectorRadians = sectorRadians ?? 0;
    const fallback = cue.actorId ? this.socket?.(cue.actorId, 'root')?.getWorldPosition(slot.start) : undefined;
    const position = cue.position ?? cue.from ?? fallback ?? { x: 0, y: 0, z: 0 };
    slot.start.set(position.x, position.y, position.z);
    const end = cue.to ?? cue.position ?? position;
    slot.end.set(end.x, end.y, end.z);
    slot.material.color.setHex(COLORS[cue.kind]);
    slot.material.opacity = this.reduced ? 0.42 : priority === 3 ? 0.88 : 0.68;
    this.configureShape(slot);
    return true;
  }

  emitAll(cues: readonly StoryCue[]): number {
    let accepted = 0;
    for (const cue of cues) if (this.emit(cue)) accepted++;
    return accepted;
  }

  /** VFX lifetimes advance only with the authoritative fixed-step simulation clock. */
  update(simulationTick: number): void {
    if (this.destroyed) return;
    this.tick = simulationTick;
    for (const slot of this.slots) {
      if (!slot.active) continue;
      const elapsedTicks = Math.max(0, simulationTick - slot.startTick);
      const t = Math.min(1, elapsedTicks / slot.durationTicks);
      this.animate(slot, t);
      if (t >= 1) this.release(slot);
    }
  }

  cancelScope(scopeId: string, _reason: CueCancellationReason): void {
    for (const slot of this.slots) if (slot.active && slot.scopeId === scopeId) this.release(slot);
  }

  cancelAll(reason: CueCancellationReason): void {
    for (const slot of this.slots) if (slot.active) this.release(slot);
    if (reason === 'death' || reason === 'unload' || reason === 'load') {
      this.seen.clear();
      this.seenOrder.length = 0;
    }
  }

  dispose(): void {
    if (this.destroyed) return;
    this.cancelAll('unload');
    this.destroyed = true;
    this.group.removeFromParent();
    for (const geometry of this.geometries) geometry.dispose();
    for (const slot of this.slots) { slot.material.dispose(); slot.sectorGeometry.dispose(); }
    this.geometries.length = 0;
    this.slots.length = 0;
    this.seen.clear();
    this.seenOrder.length = 0;
  }

  get activeCount(): number {
    let count = 0;
    for (const slot of this.slots) if (slot.active) count++;
    return count;
  }

  get currentTick(): number { return this.tick; }

  private acquire(priority: number): EffectSlot | undefined {
    let active = 0;
    for (const slot of this.slots) if (slot.active) active++;
    const reserve = Math.max(1, Math.floor(this.slots.length / 4));
    if (priority < 3 && active >= this.slots.length - reserve) {
      let cosmetic: EffectSlot | undefined;
      if (priority > 0) for (const slot of this.slots) if (slot.active && !slot.essential && slot.priority === 0) cosmetic = slot;
      if (cosmetic) this.release(cosmetic);
      return cosmetic;
    }
    for (const slot of this.slots) if (!slot.active) return slot;
    if (priority === 0) return undefined;
    let victim: EffectSlot | undefined;
    for (const slot of this.slots) {
      const candidateAge = (this.tick - slot.startTick) / slot.durationTicks;
      const victimAge = victim ? (this.tick - victim.startTick) / victim.durationTicks : 0;
      if (!slot.essential && slot.priority < priority && (!victim || slot.priority < victim.priority || candidateAge > victimAge)) victim = slot;
    }
    if (victim) this.release(victim);
    return victim;
  }

  private defaultShape(kind: StoryCue['kind']): CueShape {
    switch (kind) {
      case 'heartroot':
      case 'tether':
      case 'bond': return 'beam';
      case 'perfect-dodge':
      case 'grovebreak':
      case 'possession': return 'trail';
      case 'cleanse':
      case 'reunion':
      case 'phase':
      case 'ending-living-pact':
      case 'restoration-animals': return 'arc';
      case 'roar-cone': return 'sector';
      case 'restoration-water':
      case 'low-wave':
      case 'march': return 'wave';
      case 'restoration-roots':
      case 'sap-vein':
      case 'restoration': return 'vein';
      case 'restoration-seeds':
      case 'dominion':
      case 'ending-severance': return 'burst';
      case 'footprint':
      case 'pounce': return 'footprint';
      default: return 'ring';
    }
  }

  private configureShape(slot: EffectSlot): void {
    const mesh = slot.mesh;
    mesh.rotation.set(0, 0, 0);
    mesh.position.copy(slot.start);
    mesh.scale.set(1, 1, 1);
    if (slot.shape === 'sector') {
      this.writeSectorGeometry(slot);
      mesh.geometry = slot.sectorGeometry;
      mesh.rotation.set(0, slot.angle, 0);
      mesh.scale.set(slot.length / 2, 1, slot.length / 2);
    } else if (slot.shape === 'arc') {
      mesh.geometry = this.geometries[1]!;
      mesh.rotation.set(-Math.PI / 2, 0, slot.angle);
      mesh.scale.set(slot.width / 1.04, slot.length / 1.04, 1);
    } else if (slot.shape === 'beam' || slot.shape === 'trail') {
      mesh.geometry = this.geometries[2]!;
      const direction = new THREE.Vector3().subVectors(slot.end, slot.start);
      const distance = direction.length();
      mesh.position.copy(slot.start).add(slot.end).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), distance > 1e-4 ? direction.normalize() : new THREE.Vector3(0, 1, 0));
      mesh.scale.set(1, Math.max(0.1, distance), 1);
    } else if (slot.shape === 'pulse' || slot.shape === 'burst') {
      mesh.geometry = this.geometries[3]!;
      mesh.scale.set(slot.width / 0.8, slot.length / 0.8, slot.width / 0.8);
    } else if (slot.shape === 'footprint' || slot.shape === 'vein') {
      mesh.geometry = this.geometries[4]!;
      mesh.rotation.set(-Math.PI / 2, 0, slot.angle);
      mesh.scale.set(slot.width, slot.length, 1);
    } else if (slot.shape === 'wave') {
      mesh.geometry = this.geometries[0]!;
      mesh.rotation.set(-Math.PI / 2, 0, slot.angle);
      mesh.scale.set(slot.width / 2, slot.length / 2, 1);
    } else {
      mesh.geometry = this.geometries[0]!;
      mesh.rotation.set(-Math.PI / 2, 0, slot.angle);
      mesh.scale.set(slot.width / 2, slot.length / 2, 1);
    }
  }

  private writeSectorGeometry(slot: EffectSlot): void {
    const positions = slot.sectorPositions;
    const half = slot.sectorRadians / 2;
    for (let segment = 0; segment < SECTOR_SEGMENTS; segment++) {
      const a0 = -half + slot.sectorRadians * segment / SECTOR_SEGMENTS;
      const a1 = -half + slot.sectorRadians * (segment + 1) / SECTOR_SEGMENTS;
      const x0 = Math.sin(a0); const y0 = Math.cos(a0);
      const x1 = Math.sin(a1); const y1 = Math.cos(a1);
      const offset = segment * 18;
      positions[offset] = x0; positions[offset + 1] = 0; positions[offset + 2] = y0;
      positions[offset + 3] = x0 * SECTOR_INNER_RADIUS; positions[offset + 4] = 0; positions[offset + 5] = y0 * SECTOR_INNER_RADIUS;
      positions[offset + 6] = x1; positions[offset + 7] = 0; positions[offset + 8] = y1;
      positions[offset + 9] = x1; positions[offset + 10] = 0; positions[offset + 11] = y1;
      positions[offset + 12] = x0 * SECTOR_INNER_RADIUS; positions[offset + 13] = 0; positions[offset + 14] = y0 * SECTOR_INNER_RADIUS;
      positions[offset + 15] = x1 * SECTOR_INNER_RADIUS; positions[offset + 16] = 0; positions[offset + 17] = y1 * SECTOR_INNER_RADIUS;
    }
    (slot.sectorGeometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    slot.sectorGeometry.computeVertexNormals();
    slot.sectorGeometry.computeBoundingBox();
    slot.sectorGeometry.computeBoundingSphere();
  }

  private animate(slot: EffectSlot, t: number): void {
    if (slot.kind === 'heartroot' || slot.kind === 'tether' || slot.kind === 'bond') {
      slot.mesh.position.set((slot.start.x + slot.end.x) * 0.5, (slot.start.y + slot.end.y) * 0.5, (slot.start.z + slot.end.z) * 0.5);
      slot.material.opacity = (this.reduced ? 0.38 : 0.68) * Math.sin(Math.PI * t);
    } else {
      const fadeOpacity = (1 - t) * (this.reduced ? 0.42 : slot.essential ? 0.84 : 0.66);
      slot.material.opacity = slot.essential ? Math.max(this.reduced ? 0.3 : 0.42, fadeOpacity) : fadeOpacity;
    }
    slot.mesh.visible = true;
  }

  private release(slot: EffectSlot): void {
    slot.active = false;
    slot.essential = false;
    slot.mesh.visible = false;
    slot.scopeId = undefined;
    slot.instanceId = '';
  }
}
