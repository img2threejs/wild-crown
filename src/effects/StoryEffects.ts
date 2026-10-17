import type * as THREE from 'three';
import type { Vec3, WorldClockSnapshot } from '../game/contracts.js';
import { dangerFamily, type CueCancellationReason, type StoryCue } from './story-cues.js';
import { VfxSystem } from './vfx/VfxSystem.js';
import { CueKits, KitSlot, resolveKit, type ImpactSink, type SocketResolver } from './vfx/ElementKits.js';
import { Footprint } from './vfx/footprint.js';
import { PALETTE, type VfxElement } from './vfx/palette.js';
import { ResidueFx } from './vfx/ResidueFx.js';
import { WardenFx } from './vfx/WardenFx.js';
import { HitImpactFx } from './vfx/HitImpactFx.js';
import { ReactionFx } from './vfx/ReactionFx.js';
import { CompanionFx } from './vfx/CompanionFx.js';

export interface StoryEffectsOptions {
  readonly scene: THREE.Scene;
  readonly resolveSocket?: SocketResolver;
  /** Rendered actor root (skeleton owner): body bounds for arcs and the cleansed-finish shell. */
  readonly resolveActorRoot?: (actorId: string) => THREE.Object3D | undefined;
  readonly reducedEffects?: boolean;
  readonly capacity?: number;
  readonly impact?: ImpactSink;
}

interface EffectSlot {
  active: boolean;
  essential: boolean;
  priority: number;
  startWorldTick: number;
  durationTicks: number;
  scopeId: string | undefined;
  instanceId: string;
  readonly kit: KitSlot;
}

const ESSENTIAL: Readonly<Partial<Record<StoryCue['kind'], true>>> = {
  anticipation: true, commit: true, active: true, phase: true,
  sigil: true, projectile: true, 'projectile-impact': true, slash: true, lightning: true, judgement: true, 'judgement-mark': true,
};
const COSMETIC: Readonly<Partial<Record<StoryCue['kind'], true>>> = { 'sap-vein': true, footprint: true, heartbeat: true, march: true };
const CAPACITY_MIN = 8;
const CAPACITY_MAX = 96;
const SCOPE_MEMORY = 512;

/**
 * Presentation consumer of the StoryCue stream. Each accepted cue occupies one slot for exactly
 * its authoritative lifetime (aged in engine world ticks) and drives a pooled VFX kit; persistent
 * after-effects (decals, smoke) are fire-and-forget but still tagged with the cue scope so a
 * cancellation removes everything the scope produced.
 */
export class StoryEffects {
  readonly group: THREE.Group;
  readonly vfx: VfxSystem;
  /** Warden Arsenal: blade trail, sigils, projectiles, Thunder Cleave, Judgement, cleansed finish. */
  readonly warden: WardenFx;
  /** Bounded persistent residue (scorch/runes on surfaces, body-tinted accent on actors). */
  readonly residue: ResidueFx;
  /** Combat-reaction presentation: slide / landing dust, wall debris, stun swirl, poise-break burst and reaction camera punch. */
  readonly reactions: ReactionFx;
  /** Companion field-verb feedback: Vara's mark and landing hint, Asha's guard, command rings, Tali's shelter. */
  readonly companions: CompanionFx;
  private readonly kits: CueKits;
  private impact: ImpactSink | undefined;
  private readonly slots: EffectSlot[] = [];
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly scopeOwners = new Map<string, number>();
  private readonly burst = new Footprint();
  private nextOwner = 1;
  private destroyed = false;
  private tick = 0;
  private worldTick = 0;

  constructor(options: StoryEffectsOptions) {
    this.vfx = new VfxSystem();
    this.vfx.setReducedEffects(options.reducedEffects ?? false);
    this.group = this.vfx.group;
    this.group.name = 'story-effects';
    this.impact = options.impact;
    this.warden = new WardenFx(this.vfx, { resolveSocket: options.resolveSocket, resolveActorRoot: options.resolveActorRoot, impact: options.impact });
    this.vfx.addModule(this.warden);
    this.residue = new ResidueFx(this.vfx, options.resolveActorRoot);
    this.residue.setReducedEffects(options.reducedEffects ?? false);
    this.vfx.addModule(this.residue);
    this.reactions = new ReactionFx(this.vfx, options.resolveActorRoot, options.impact);
    this.companions = new CompanionFx(this.vfx, options.resolveActorRoot, options.impact);
    this.kits = new CueKits(this.vfx, options.resolveSocket, options.impact, this.warden);
    const capacity = Math.max(CAPACITY_MIN, Math.min(CAPACITY_MAX, options.capacity ?? 48));
    for (let i = 0; i < capacity; i++) this.slots.push({ active: false, essential: false, priority: 0, startWorldTick: 0, durationTicks: 1, scopeId: undefined, instanceId: '', kit: new KitSlot() });
    options.scene.add(this.group);
  }

  setReducedEffects(reduced: boolean): void { this.vfx.setReducedEffects(reduced); this.residue.setReducedEffects(reduced); }
  /** Routes the `telegraphIntensity` setting to the VfxSystem (and therefore `GroundFx`) so live and newly spawned anticipation tells reflect the player's choice. */
  setTelegraphIntensity(intensity: 'standard' | 'high'): void { this.vfx.setTelegraphIntensity(intensity); }
  setImpactSink(impact: ImpactSink | undefined): void { this.impact = impact; this.kits.setImpactSink(impact); this.warden.setImpact(impact); this.reactions.setImpactSink(impact); this.companions.setImpactSink(impact); }

  /** Player focus for proximity-scaled detonation shake; presentation only. */
  setFocus(position: Readonly<Vec3> | undefined): void {
    this.kits.hasFocus = Boolean(position);
    if (position) this.kits.focus.set(position.x, position.y, position.z);
  }

  emit(cue: StoryCue): boolean {
    if (this.destroyed || cue.kind === 'cancel' || this.seen.has(cue.instanceId)) return false;
    const sectorRadians = cue.footprint?.sectorRadians;
    const family = dangerFamily(cue);
    if (family && (!cue.position || !cue.footprint || !Number.isFinite(cue.footprint.width) || !Number.isFinite(cue.footprint.length) || cue.footprint.width <= 0 || cue.footprint.length <= 0 || !Number.isFinite(cue.durationTicks) || cue.durationTicks! <= 0)) {
      throw new RangeError('Danger cues require engine-authored position, positive footprint dimensions and phase duration.');
    }
    if (cue.shape === 'sector' && (!Number.isFinite(sectorRadians) || sectorRadians! <= 0 || sectorRadians! > Math.PI * 2)) {
      throw new RangeError('Sector cues require authored footprint.sectorRadians in (0, 2π].');
    }
    this.seen.add(cue.instanceId);
    this.seenOrder.push(cue.instanceId);
    if (this.seenOrder.length > SCOPE_MEMORY) this.seen.delete(this.seenOrder.shift()!);
    // Reaction cues (start, wall impact, poise break, get-up) are drawn by ReactionFx on their own pooled emitters and never occupy a kit slot.
    if (cue.kind === 'reaction-start' || cue.kind === 'wall-impact' || cue.kind === 'poise-break' || cue.kind === 'getup') return this.reactions.play(cue, this.ownerFor(cue.scopeId));
    // Companion cues (Vara's mark, Asha's guard, a field command, Tali's shelter) are one-shot rings and bursts on their own pooled emitters, never a kit slot.
    if (cue.kind === 'mark' || cue.kind === 'guard' || cue.kind === 'command' || cue.kind === 'shelter' || cue.kind === 'storm-talon') return this.companions.play(cue, this.ownerFor(cue.scopeId));
    // A strike that dealt no damage (evaded, blocked, absorbed) gets no impact, from any hero kit.
    if (cue.kind === 'hit' && HitImpactFx.suppressed(cue)) return false;
    const priority = cue.priority === 'essential' || ESSENTIAL[cue.kind] ? 3 : cue.priority === 'story' ? 2 : COSMETIC[cue.kind] ? 0 : 1;
    const slot = this.acquire(priority);
    if (!slot) return false;
    slot.active = true;
    slot.essential = priority === 3;
    slot.priority = priority;
    slot.startWorldTick = cue.worldTick;
    slot.durationTicks = family ? cue.durationTicks! : Math.max(1, Math.round(cue.durationTicks ?? (priority === 3 ? 42 : 36)));
    slot.scopeId = cue.scopeId;
    slot.instanceId = cue.instanceId;
    const kit = slot.kit, resolved = resolveKit(cue);
    kit.cue = cue; kit.kit = resolved.kit; kit.element = resolved.element; kit.attack = resolved.attack;
    kit.owner = this.ownerFor(cue.scopeId);
    kit.end = cue.worldTick + slot.durationTicks;
    this.vfx.time = cue.worldTick / 60;
    this.kits.begin(kit, cue.worldTick);
    // Persistent residue: only attach when the cue carries explicit contact metadata from the engine
    // (actor hit with `confirmedDamage > 0`, or environment `projectile-impact` with contact proof).
    // Cancellation through the same owner removes the residue with the rest of the scope.
    if (cue.contact) this.residue.emit(cue, kit.owner);
    return true;
  }

  emitAll(cues: readonly StoryCue[]): number {
    let accepted = 0;
    for (const cue of cues) if (this.emit(cue)) accepted++;
    return accepted;
  }

  /** Age VFX in authoritative world ticks, avoiding seconds-roundtrip errors at phase boundaries. */
  update(worldClock: WorldClockSnapshot, cameraPosition?: Readonly<Vec3>): void {
    if (this.destroyed) return;
    this.tick = worldClock.simulationTick;
    this.worldTick = worldClock.worldTick;
    this.vfx.time = worldClock.worldTick / 60;
    if (cameraPosition) this.vfx.cameraPosition.set(cameraPosition.x, cameraPosition.y, cameraPosition.z);
    for (const slot of this.slots) {
      if (!slot.active) continue;
      if (this.worldTick >= slot.startWorldTick + slot.durationTicks) { this.release(slot, true); continue; }
      this.kits.update(slot.kit, this.worldTick);
    }
    this.companions.tick(worldClock.worldTick);
    this.vfx.update(this.vfx.time);
  }

  cancelScope(scopeId: string, _reason: CueCancellationReason): void {
    for (const slot of this.slots) if (slot.active && slot.scopeId === scopeId) this.release(slot, false);
    const owner = this.scopeOwners.get(scopeId);
    this.companions.cancelScope(scopeId);
    if (owner !== undefined) { this.vfx.killOwner(owner); this.scopeOwners.delete(scopeId); }
  }

  cancelAll(reason: CueCancellationReason): void {
    for (const slot of this.slots) if (slot.active) this.release(slot, false);
    this.vfx.clear();
    this.reactions.clear();
    this.companions.clear();
    this.scopeOwners.clear();
    if (reason === 'death' || reason === 'unload' || reason === 'load') {
      this.seen.clear();
      this.seenOrder.length = 0;
    }
  }

  /** True while the actor has a live anticipation/commit attack cue (aura intensifies). */
  isCharging(actorId: string): boolean {
    for (const slot of this.slots) {
      const kit = slot.kit;
      if (slot.active && kit.attack && kit.cue.actorId === actorId && (kit.cue.phase === 'anticipation' || kit.cue.phase === 'commit')) return true;
    }
    return false;
  }

  /**
   * Presentation-only impact (e.g. a trial gate opening): flash, dust ring, sparks, a ground
   * shockwave of `radius` and a proportional camera shake through the impact sink.
   */
  impactBurst(position: Readonly<Vec3>, element: VfxElement = 'earth', radius = 1.6): void {
    if (this.destroyed) return;
    const vfx = this.vfx, owner = this.nextOwner++;
    this.burst.set('disk', position.x, position.y, position.z, 0, radius, radius);
    vfx.ground.spawn('shock', this.burst, element, owner, vfx.time, 0.5);
    vfx.flash(position.x, position.y + 1, position.z, radius * 1.6, element, owner, 0.22);
    vfx.dustRing(position.x, position.y, position.z, radius * 0.7, 22, owner);
    vfx.sparks(position.x, position.y + 0.6, position.z, 30, 6, element, owner, 0.5);
    vfx.lights.pulse(position.x, position.y + 1.4, position.z, PALETTE[element].hot, 30, radius * 5, 0.5, vfx.time, owner);
    this.impact?.shake(0.22, 0.45, 16);
  }

  dispose(): void {
    if (this.destroyed) return;
    this.cancelAll('unload');
    this.destroyed = true;
    this.companions.dispose();
    this.vfx.dispose();
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

  private ownerFor(scopeId: string | undefined): number {
    if (!scopeId) return this.nextOwner++;
    let owner = this.scopeOwners.get(scopeId);
    if (owner === undefined) {
      owner = this.nextOwner++;
      this.scopeOwners.set(scopeId, owner);
      if (this.scopeOwners.size > SCOPE_MEMORY) this.scopeOwners.delete(this.scopeOwners.keys().next().value!);
    }
    return owner;
  }

  private acquire(priority: number): EffectSlot | undefined {
    let active = 0;
    for (const slot of this.slots) if (slot.active) active++;
    const reserve = Math.max(1, Math.floor(this.slots.length / 4));
    if (priority < 3 && active >= this.slots.length - reserve) {
      let cosmetic: EffectSlot | undefined;
      if (priority > 0) for (const slot of this.slots) if (slot.active && !slot.essential && slot.priority === 0) cosmetic = slot;
      if (cosmetic) this.release(cosmetic, false);
      return cosmetic;
    }
    for (const slot of this.slots) if (!slot.active) return slot;
    if (priority === 0) return undefined;
    let victim: EffectSlot | undefined;
    for (const slot of this.slots) {
      const candidateAge = Math.max(0, this.worldTick - slot.startWorldTick) / slot.durationTicks;
      const victimAge = victim ? Math.max(0, this.worldTick - victim.startWorldTick) / victim.durationTicks : 0;
      if (!slot.essential && slot.priority < priority && (!victim || slot.priority < victim.priority || candidateAge > victimAge)) victim = slot;
    }
    if (victim) this.release(victim, false);
    return victim;
  }

  private release(slot: EffectSlot, natural: boolean): void {
    slot.active = false;
    slot.essential = false;
    this.kits.end(slot.kit, natural);
    slot.scopeId = undefined;
    slot.instanceId = '';
  }
}
