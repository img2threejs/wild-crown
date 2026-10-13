import { Color, Vector3, type Object3D } from 'three';
import type { AuraTheme } from './ActorVfx.js';
import type { FocusSource } from './CanopyKits.js';
import type { ImpactSink, KitSlot, MapKitFamily, SocketResolver } from './ElementKits.js';
import type { Footprint } from './footprint.js';
import { PALETTE, type VfxElement } from './palette.js';
import { VFX_FRAME } from './VfxAtlas.js';
import type { VfxSystem } from './VfxSystem.js';

/**
 * Grove monster kits: the attack id is the kit id (like CanopyKits). The practice partner spars in amber and green: golden-green
 * sap-light for the seed toss, amber earth for the ripple, soft green and rose petals for the sweep. Every kit is deliberately
 * gentle (small flashes, tiny shake, no debris), reads as a lesson rather than a threat, and stays inside the authored footprint.
 */
export const GROVE_KIT_IDS = ['sprig-seed-toss', 'sprig-ground-ripple', 'sprig-petal-sweep'] as const;
export type GroveKitId = typeof GROVE_KIT_IDS[number];
const GROVE_KITS: Readonly<Record<string, true>> = { 'sprig-seed-toss': true, 'sprig-ground-ripple': true, 'sprig-petal-sweep': true };
export const isGroveKit = (kit: string): kit is GroveKitId => GROVE_KITS[kit] === true;

/** Attack id → [kit id, presentation element]: gold-green sap light, amber earth, spirit green. */
export const GROVE_ATTACK_KITS: Readonly<Record<string, readonly [GroveKitId, VfxElement]>> = {
  'sprig-seed-toss': ['sprig-seed-toss', 'sap'],
  'sprig-ground-ripple': ['sprig-ground-ripple', 'earth'],
  'sprig-petal-sweep': ['sprig-petal-sweep', 'spirit'],
};
/** Monster id → idle body aura theme drawn by ActorVfx: the gentlest existing theme (soft earth motes). */
export const GROVE_AURAS: Readonly<Record<string, AuraTheme>> = { 'grove-sprig': 'earth' };

const SHAKE_RADIUS = 6;
const SHAKE_WEIGHT: Readonly<Record<GroveKitId, number>> = { 'sprig-seed-toss': 0.05, 'sprig-ground-ripple': 0.04, 'sprig-petal-sweep': 0.03 };

// Alpha-blended tints (never HDR): rose and cream petals, dry meadow dust.
const PETAL_ROSE = new Color().setRGB(0.88, 0.46, 0.56);
const PETAL_CREAM = new Color().setRGB(0.92, 0.82, 0.58);
const MEADOW_DUST = new Color().setRGB(0.46, 0.4, 0.17);

const clamp01 = (t: number): number => t < 0 ? 0 : t > 1 ? 1 : t;

/** One rose or cream petal drifting down (leaf frame, alpha blended). `delay` schedules it for a later moment. */
export function emitPetal(vfx: VfxSystem, owner: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, delay = 0): void {
  const p = vfx.spec(), color = vfx.random() > 0.5 ? PETAL_ROSE : PETAL_CREAM;
  p.x = x + vfx.range(-0.12, 0.12); p.y = y + vfx.range(-0.08, 0.08); p.z = z + vfx.range(-0.12, 0.12); p.vx = vx; p.vy = vy; p.vz = vz; p.delay = delay;
  p.gravity = 0.7; p.drag = 1.2; p.life = vfx.range(1.2, 2); p.size0 = p.size1 = vfx.range(0.12, 0.2);
  p.spin = vfx.random() * 6.28; p.spinRate = vfx.range(-5, 5); p.frame = VFX_FRAME.leaf;
  p.r0 = p.r1 = color.r; p.g0 = p.g1 = color.g; p.b0 = p.b1 = color.b; p.a0 = 0.9; p.fadeIn = 0.05; p.fadeOut = 0.7;
  vfx.emit(vfx.particles.alpha, owner);
}

/**
 * Presentation kits for the three Grove practice attacks. Every kit is a pure function of its cue (authored footprint, phase window,
 * socket bones) and the world clock, so pause, slow motion, hit-stop and cancellation behave like the other map kits. All emission
 * goes through the shared particle pools and ground quads; the family adds no draw call. Ground quads are only ever spawned from the
 * cue footprint, so no hard-edged zone leaves the authored hazard.
 */
class GroveKits implements MapKitFamily {
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly c = new Vector3();
  private readonly d = new Vector3();

  constructor(private readonly vfx: VfxSystem, private readonly resolveSocket: SocketResolver | undefined, private impact: ImpactSink | undefined, private readonly focus: FocusSource) {}

  owns(kit: string): boolean { return isGroveKit(kit); }

  setImpactSink(impact: ImpactSink | undefined): void { this.impact = impact; }

  begin(slot: KitSlot, seconds: number): void {
    const vfx = this.vfx, cue = slot.cue, phase = cue.phase;
    if (phase === 'anticipation' || phase === 'commit') {
      if (slot.hasFootprint) slot.ground = vfx.ground.spawn('fill', slot.footprint, slot.element, slot.owner, vfx.time, 0);
      if (phase === 'anticipation') {
        if (cue.actorId) this.impact?.flashActor(cue.actorId, PALETTE[slot.glow].b, 0.8, seconds, 'charge');
      } else this.beginCommit(slot);
      return;
    }
    if (phase === 'active') this.detonate(slot, seconds);
  }

  update(slot: KitSlot, worldTick: number, dt: number, t: number): void {
    const cue = slot.cue;
    if (cue.phase === 'anticipation' || cue.phase === 'commit') {
      const vfx = this.vfx, progress = cue.phase === 'anticipation' ? t * 0.8 : 0.8 + 0.2 * t;
      if (slot.ground) vfx.ground.drive(slot.ground, progress, 0.8 + 0.25 * progress, Math.min(1, (worldTick - cue.worldTick) / 6 + 0.25));
      if (cue.phase === 'anticipation') this.updateAnticipation(slot, t, dt); else this.updateCommit(slot, t, dt);
      return;
    }
    if (cue.phase === 'active') this.updateActive(slot, t, dt);
  }

  /** Releases manual resources (ground fill, lane beam); a natural end of the active phase also emits the decay. */
  end(slot: KitSlot, natural: boolean): void {
    if (slot.ground) { this.vfx.ground.release(slot.ground); slot.ground = undefined; }
    if (slot.beam) { this.vfx.beams.release(slot.beam); slot.beam = undefined; }
    slot.socket = undefined;
    if (natural && slot.cue.phase === 'active') this.decay(slot);
  }

  // ---- begin ----

  private beginCommit(slot: KitSlot): void {
    const vfx = this.vfx, owner = slot.owner;
    switch (slot.kit as GroveKitId) {
      case 'sprig-seed-toss':
        // The seed leaves the hand where it was held; the lob lands exactly when the active phase (the hazard) opens.
        slot.origin.y += 0.3;
        vfx.sparks(slot.origin.x, slot.origin.y, slot.origin.z, 8, 2.4, 'sap', owner, 0.5);
        vfx.glow(slot.origin.x, slot.origin.y, slot.origin.z, 0.7, 0.25, 'sap', 0.4, owner);
        break;
      case 'sprig-ground-ripple': {
        const feet = this.feet(slot, this.a);
        vfx.dustRing(feet.x, this.groundY(slot), feet.z, 0.8, 12, owner, MEADOW_DUST);
        vfx.leaves(feet.x, this.groundY(slot) + 0.2, feet.z, 5, 0.7, 0, 0, owner);
        break;
      }
      case 'sprig-petal-sweep': {
        const hand = this.socketPosition(slot, this.a);
        for (let i = vfx.count(8); i > 0; i--) emitPetal(vfx, owner, hand.x, hand.y, hand.z, vfx.range(-1, 1) + slot.footprint.forwardX * 1.5, vfx.range(0.3, 1.2), vfx.range(-1, 1) + slot.footprint.forwardZ * 1.5);
        break;
      }
    }
  }

  // ---- anticipation ----

  private updateAnticipation(slot: KitSlot, t: number, dt: number): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint;
    switch (slot.kit as GroveKitId) {
      case 'sprig-seed-toss': {
        // A golden seed ripens in the raised hand: sap-light pulls together, warm glints rise inside the landing mark.
        const hold = this.socketPosition(slot, this.a);
        hold.y += 0.3;
        vfx.gather(hold.x, hold.y, hold.z, this.due(slot, 26, dt), 0.7, 'sap', owner);
        for (let n = this.due(slot, 6, dt, 2); n > 0; n--) vfx.glow(hold.x, hold.y, hold.z, 0.35 + 0.35 * t, 0.3, 'sap', 0.3, owner);
        for (let n = this.due(slot, 10, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.05, 0.8); vfx.glow(this.b.x, this.b.y, this.b.z, 0.12, 0.7, 'sap', 0.4, owner, 0.5); }
        return;
      }
      case 'sprig-ground-ripple': {
        // The grass trembles along the band the ripple will run: loose blades and amber dust lift, the base draws the earth in.
        const feet = this.feet(slot, this.a), y = this.groundY(slot);
        vfx.gather(feet.x, y + 0.4, feet.z, this.due(slot, 14, dt), 1, 'earth', owner);
        for (let n = this.due(slot, 14, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.1, 0.8); vfx.leaves(this.b.x, this.b.y, this.b.z, 1, 0.1, 0, 0, owner); }
        for (let n = this.due(slot, 12, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.05, 0.8); vfx.smoke(this.b.x, this.b.y, this.b.z, 1, 0.1, 0.25, 0.6, 0.8, MEADOW_DUST, 0.26, owner, 0.1); }
        return;
      }
      case 'sprig-petal-sweep': {
        // Petals gather round the open hands and the lane starts to glimmer.
        const hand = this.socketPosition(slot, this.a);
        vfx.gather(hand.x, hand.y, hand.z, this.due(slot, 22, dt), 0.8, 'spirit', owner);
        for (let n = this.due(slot, 9, dt, 2); n > 0; n--) emitPetal(vfx, owner, hand.x, hand.y, hand.z, vfx.range(-0.8, 0.8), vfx.range(0.1, 0.8), vfx.range(-0.8, 0.8));
        for (let n = this.due(slot, 10, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.15, 0.85); vfx.glow(this.b.x, this.b.y, this.b.z, 0.12, 0.6, 'spirit', 0.4, owner); }
        return;
      }
    }
  }

  // ---- commit ----

  private updateCommit(slot: KitSlot, t: number, dt: number): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint;
    switch (slot.kit as GroveKitId) {
      case 'sprig-seed-toss': {
        // The seed flies in an arc from the hand to the committed point: a glowing head, a short sparkling trail.
        const head = this.lob(slot.origin, this.landing(slot, this.d), t, this.a, 1);
        for (let n = this.due(slot, 90, dt); n > 0; n--) vfx.glow(head.x + vfx.range(-0.08, 0.08), head.y + vfx.range(-0.08, 0.08), head.z + vfx.range(-0.08, 0.08), 0.42, 0.12, 'sap', 0.5, owner);
        for (let n = this.due(slot, 40, dt, 2); n > 0; n--) vfx.sparks(head.x, head.y, head.z, 1, 1.2, 'sap', owner, 0.2);
        for (let n = this.due(slot, 8, dt, 3); n > 0; n--) emitPetal(vfx, owner, head.x, head.y, head.z, vfx.range(-0.3, 0.3), vfx.range(-0.2, 0.3), vfx.range(-0.3, 0.3));
        return;
      }
      case 'sprig-ground-ripple': {
        // Preview of the ripple: blades and amber streaks run along the band toward Aren.
        for (let n = this.due(slot, 26, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.b, 0.1, 0.85); this.sideStreak(slot, this.b, 3 + 3 * t, 0.2, PALETTE.earth.hot, 0.45); }
        for (let n = this.due(slot, 14, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.b, 0.15, 0.85); vfx.leaves(this.b.x, this.b.y, this.b.z, 1, 0.1, Math.cos(fp.angle) * 1.6, -Math.sin(fp.angle) * 1.6, owner); }
        return;
      }
      case 'sprig-petal-sweep': {
        // The lane draws itself: soft green streaks and a drift of petals race down it ahead of the sweep.
        this.laneStreaks(slot, this.due(slot, 40, dt), 0.9, 7);
        for (let n = this.due(slot, 14, dt, 2); n > 0; n--) { fp.toWorld((vfx.random() - 0.5) * 2 * fp.halfWidth * 0.7, -fp.halfLength + vfx.random() * fp.halfLength * 2 * t, this.b, vfx.range(0.3, 0.9)); emitPetal(vfx, owner, this.b.x, this.b.y, this.b.z, fp.forwardX * 1.4, vfx.range(0, 0.5), fp.forwardZ * 1.4); }
        return;
      }
    }
  }

  // ---- active ----

  private detonate(slot: KitSlot, seconds: number): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint, time = vfx.time, kit = slot.kit as GroveKitId;
    const center = this.center(fp, this.c);
    switch (kit) {
      case 'sprig-seed-toss': {
        // The seed bursts on the mark in a soft bloom: a gentle shock, a faint decal, drifting pollen and petals.
        const r = Math.min(fp.halfWidth, fp.halfLength);
        vfx.flash(center.x, center.y + 0.4, center.z, r * 1.6, 'sap', owner, 0.2);
        vfx.ground.spawn('shock', fp, 'sap', owner, time, 0.4);
        vfx.ground.spawn('decal', fp, 'earth', owner, time, 4, 1, slot.glow);
        vfx.sparks(center.x, center.y + 0.2, center.z, 20, 3.6, 'sap', owner, 0.7);
        vfx.dustRing(center.x, center.y, center.z, r * 0.8, 16, owner, MEADOW_DUST);
        vfx.leaves(center.x, center.y + 0.3, center.z, 8, r * 0.7, 0, 0, owner);
        for (let i = vfx.count(8); i > 0; i--) emitPetal(vfx, owner, center.x, center.y + 0.2, center.z, vfx.range(-1.4, 1.4), vfx.range(0.8, 2), vfx.range(-1.4, 1.4));
        vfx.lights.pulse(center.x, center.y + 1, center.z, PALETTE.sap.hot, 4, 6, 0.45, time, owner);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'sprig-ground-ripple': {
        // The ripple runs across the band: a scuff decal, a burst of blades and a travelling head (see updateActive).
        vfx.ground.spawn('shock', fp, 'earth', owner, time, 0.36);
        vfx.ground.spawn('decal', fp, 'earth', owner, time, 3.5, 1, slot.glow);
        for (let i = 0; i < 5; i++) { fp.toWorld((i / 4 - 0.5) * 2 * fp.halfWidth * 0.85, 0, this.a, 0.15); vfx.leaves(this.a.x, this.a.y, this.a.z, 2, 0.25, Math.cos(fp.angle) * 3.5, -Math.sin(fp.angle) * 3.5, owner); }
        for (let n = vfx.count(18); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.b, 0.1, 0.85); this.sideStreak(slot, this.b, vfx.range(3.5, 6), 0.2, PALETTE.earth.hot, 0.5); }
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'sprig-petal-sweep': {
        // A fan of petals sweeps down the lane under a soft green beam; the lane is bright for the whole active window.
        const life = Math.max(0.12, Math.min(0.3, seconds));
        slot.beam = vfx.beams.acquire(owner, time, 0, 0.4, 0.02, 'spirit');
        if (slot.beam) {
          fp.toWorld(0, -fp.halfLength, slot.beam.a, 0.5); fp.toWorld(0, fp.halfLength, slot.beam.b, 0.5);
          slot.beam.alpha = 0.7;
        }
        vfx.ground.spawn('shock', fp, 'spirit', owner, time, 0.36);
        vfx.ground.spawn('decal', fp, 'spirit', owner, time, 3.5, 1, slot.glow);
        this.laneStreaks(slot, vfx.count(26), 1, 14);
        for (let i = vfx.count(18); i > 0; i--) {
          fp.toWorld((vfx.random() - 0.5) * 2 * fp.halfWidth * 0.8, -fp.halfLength + vfx.random() * fp.halfLength * 2, this.a, vfx.range(0.3, 0.9));
          emitPetal(vfx, owner, this.a.x, this.a.y, this.a.z, fp.forwardX * vfx.range(2, 4) + vfx.range(-0.5, 0.5), vfx.range(0.3, 1.2), fp.forwardZ * vfx.range(2, 4) + vfx.range(-0.5, 0.5));
        }
        fp.toWorld(0, fp.halfLength - 0.5, this.b, 0.5);
        vfx.flash(this.b.x, this.b.y, this.b.z, 1, 'spirit', owner, life);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
    }
  }

  private updateActive(slot: KitSlot, t: number, dt: number): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint;
    switch (slot.kit as GroveKitId) {
      case 'sprig-seed-toss':
        // Pollen lifts off the bloom and drifts upward.
        for (let n = this.due(slot, 10, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.05, 0.8); vfx.glow(this.a.x, this.a.y, this.a.z, 0.1, 0.9, 'sap', 0.4, owner, 0.5); }
        for (let n = this.due(slot, 5, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.1, 0.75); emitPetal(vfx, owner, this.a.x, this.a.y, this.a.z, vfx.range(-0.2, 0.2), vfx.range(0.4, 0.9), vfx.range(-0.2, 0.2)); }
        return;
      case 'sprig-ground-ripple': {
        // The ripple head travels across the band: blades, amber dust and sparks shed from it.
        const head = this.sweepHead(slot, t, this.a);
        for (let n = this.due(slot, 80, dt); n > 0; n--) vfx.leaves(head.x, head.y, head.z, 1, 0.3, Math.cos(fp.angle) * 3.5, -Math.sin(fp.angle) * 3.5, owner);
        for (let n = this.due(slot, 40, dt, 2); n > 0; n--) vfx.smoke(head.x, head.y, head.z, 1, 0.3, 0.2, 0.6, 0.7, MEADOW_DUST, 0.3, owner, 0.4);
        for (let n = this.due(slot, 24, dt, 3); n > 0; n--) vfx.sparks(head.x, head.y + 0.1, head.z, 1, 1.8, 'earth', owner, 0.4);
        vfx.glow(head.x, head.y + 0.1, head.z, 0.9, 0.1, 'earth', 0.2, owner);
        return;
      }
      case 'sprig-petal-sweep': {
        if (slot.beam) slot.beam.alpha = Math.sin(Math.PI * Math.min(1, t * 1.02)) * 0.7 + 0.1;
        for (let n = this.due(slot, 30, dt); n > 0; n--) this.laneStreaks(slot, 1, 1, 14);
        for (let n = this.due(slot, 16, dt, 2); n > 0; n--) { fp.toWorld((vfx.random() - 0.5) * 2 * fp.halfWidth * 0.8, -fp.halfLength + vfx.random() * fp.halfLength * 2, this.a, vfx.range(0.3, 0.9)); emitPetal(vfx, owner, this.a.x, this.a.y, this.a.z, fp.forwardX * 2.2, vfx.range(0.2, 0.8), fp.forwardZ * 2.2); }
        return;
      }
    }
  }

  // ---- decay ----

  private decay(slot: KitSlot): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint, center = this.center(fp, this.c), r = Math.min(fp.halfWidth, fp.halfLength);
    switch (slot.kit as GroveKitId) {
      case 'sprig-seed-toss':
        vfx.smoke(center.x, center.y, center.z, 5, r * 0.8, 0.4, 1, 1.4, MEADOW_DUST, 0.22, owner, 0.3);
        break;
      case 'sprig-ground-ripple':
        fp.toWorld(0, fp.halfLength, this.a, 0.3);
        vfx.leaves(this.a.x, this.a.y, this.a.z, 6, fp.halfWidth * 0.7, fp.forwardX * 1.2, fp.forwardZ * 1.2, owner);
        break;
      case 'sprig-petal-sweep':
        for (let i = vfx.count(8); i > 0; i--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.4, 0.8); emitPetal(vfx, owner, this.a.x, this.a.y, this.a.z, vfx.range(-0.2, 0.2), vfx.range(0, 0.3), vfx.range(-0.2, 0.2)); }
        break;
    }
  }

  // ---- particle helpers ----

  /** Thin velocity-stretched additive streak (ripple lines, lane glimmer). */
  private streak(owner: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, width: number, stretch: number, color: Color, alpha: number): void {
    const vfx = this.vfx, p = vfx.spec();
    p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz; p.drag = 2; p.life = life; p.size0 = width; p.size1 = width * 0.4; p.frame = VFX_FRAME.spark; p.stretch = stretch;
    p.r0 = p.r1 = color.r; p.g0 = p.g1 = color.g; p.b0 = p.b1 = color.b; p.a0 = alpha; p.fadeIn = 0.15; p.fadeOut = 0.5;
    vfx.emit(vfx.particles.additive, owner);
  }

  /** Streaks racing along the lane (+Z in the footprint frame) at random lane positions. */
  private laneStreaks(slot: KitSlot, count: number, reach: number, speed: number): void {
    const vfx = this.vfx, fp: Footprint = slot.footprint, hot = PALETTE.spirit.b;
    for (let i = count; i > 0; i--) {
      fp.toWorld((vfx.random() - 0.5) * 2 * fp.halfWidth * 0.8, -fp.halfLength + vfx.random() * fp.halfLength * 2 * reach, this.b, vfx.range(0.15, 0.85));
      this.streak(slot.owner, this.b.x, this.b.y, this.b.z, fp.forwardX * speed, 0, fp.forwardZ * speed, vfx.range(0.18, 0.34), 0.06, 0.12, hot, 0.5);
    }
  }

  private sideStreak(slot: KitSlot, at: Vector3, speed: number, life: number, color: Color, alpha: number): void {
    const a = slot.footprint.angle;
    this.streak(slot.owner, at.x, at.y, at.z, Math.cos(a) * speed, 0, -Math.sin(a) * speed, life + this.vfx.random() * 0.12, 0.06, 0.12, color, alpha);
  }

  // ---- geometry helpers ----

  /** Integer emissions due this frame for a continuous rate (per second of world time); reduced effects keep 35 %. */
  private due(slot: KitSlot, rate: number, dt: number, stream: 1 | 2 | 3 | 4 = 1): number {
    const value = slot.acc[stream - 1]! + rate * dt * (this.vfx.reducedEffects ? 0.35 : 1), whole = Math.floor(value);
    slot.acc[stream - 1] = value - whole;
    return whole;
  }

  private shake(at: { readonly x: number; readonly z: number }, weight: number): void {
    if (!this.focus.hasFocus) return;
    const distance = Math.hypot(this.focus.focus.x - at.x, this.focus.focus.z - at.z);
    if (distance < SHAKE_RADIUS) this.impact?.shake(weight * (1 - distance / SHAKE_RADIUS), 0.28, 22);
  }

  /** Hand: the manifest `cast` socket, else the authored source point lifted to chest height. */
  private socketPosition(slot: KitSlot, out: Vector3): Vector3 {
    if (slot.socket) { slot.socket.updateWorldMatrix(true, false); return slot.socket.getWorldPosition(out); }
    const from = slot.cue.from ?? slot.cue.position;
    return out.set(from?.x ?? 0, (from?.y ?? 0) + 1.1, from?.z ?? 0);
  }

  /** Horizontal position of the body with y at the simulation floor (dust and ground effects stay on the ground). */
  private feet(slot: KitSlot, out: Vector3): Vector3 {
    const root = this.root(slot);
    if (root) { root.updateWorldMatrix(true, false); root.getWorldPosition(out); } else { const from = slot.cue.from ?? slot.cue.position; out.set(from?.x ?? 0, from?.y ?? 0, from?.z ?? 0); }
    out.y = this.groundY(slot);
    return out;
  }

  private groundY(slot: KitSlot): number { return slot.cue.from?.y ?? slot.footprint.cy; }
  private root(slot: KitSlot): Object3D | undefined { return slot.cue.actorId ? this.resolveSocket?.(slot.cue.actorId, 'root') : undefined; }

  /** Committed aim point lifted slightly above the floor so the lobbed seed lands on the mark. */
  private landing(slot: KitSlot, out: Vector3): Vector3 { return out.set(slot.target.x, slot.target.y + 0.2, slot.target.z); }

  /** Parabolic lob: endpoints are exact at t = 0 and 1. */
  private lob(from: Vector3, to: Vector3, t: number, out: Vector3, apexScale: number): Vector3 {
    out.lerpVectors(from, to, t);
    out.y += 4 * t * (1 - t) * Math.min(2.2, 0.6 + Math.hypot(to.x - from.x, to.z - from.z) * 0.18) * apexScale;
    return out;
  }

  /** Travelling head of a ripple across a wave band (local X from -0.9 to +0.9 of the half width). */
  private sweepHead(slot: KitSlot, t: number, out: Vector3): Vector3 {
    const fp = slot.footprint;
    return fp.toWorld((-0.9 + 1.8 * clamp01(t)) * fp.halfWidth, 0, out, 0.2);
  }

  private center(fp: Footprint, out: Vector3): Vector3 {
    return fp.shape === 'sector' ? fp.toWorld(0, fp.halfLength * 0.5, out) : out.set(fp.cx, fp.cy, fp.cz);
  }
}

export function createGroveKits(vfx: VfxSystem, resolveSocket: SocketResolver | undefined, impact: ImpactSink | undefined, focus: FocusSource): MapKitFamily {
  return new GroveKits(vfx, resolveSocket, impact, focus);
}
