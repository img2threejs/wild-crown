import { Color, Vector3, type Object3D } from 'three';
import type { AuraTheme } from './ActorVfx.js';
import type { CanopyKitId, FocusSource } from './CanopyKits.js';
import type { ImpactSink, KitSlot, MapKitFamily, SocketResolver } from './ElementKits.js';
import type { Footprint } from './footprint.js';
import { PALETTE, type VfxElement } from './palette.js';
import { VFX_FRAME } from './VfxAtlas.js';
import type { VfxSystem } from './VfxSystem.js';

/**
 * Blood Bamboo Valley boss kits. The kit id of a hazard is chosen by its attack id (`BAMBOO_ATTACK_KITS`); Koro's rock throw, leap and log
 * sweep reuse the Howler's Canopy kits (same Howler-family body and clips), so only what Koro and Asha add is drawn here:
 *   Asha  pounce (Tiger Pounce), corrupt slam (Corrupted Pounce), charge (Bamboo Charge, Side Charge), claw (Claw Combo),
 *         Black Sap trail (lane + lingering pool), Ground Corruption Wave (band);
 *   Koro  falling branch (the environment hazard: no clip, so the branch itself is drawn), platform charge.
 * Every kit is a pure function of its cue (the engine's hazard footprint, phase window and cast socket) and the world clock: nothing here
 * decides where a hazard is or when it hurts, every ground quad is spawned from the cue footprint, and a cancelled scope (phase change,
 * interruption, retry, region unload) releases its quads and beams through `end`. All emission goes through the shared particle pools
 * and ground quads; the family adds no draw call.
 */
export const BAMBOO_KIT_IDS = [
  'asha-pounce', 'asha-corrupt-slam', 'asha-charge', 'asha-claw', 'asha-sap-trail', 'asha-ground-wave',
  'koro-falling-branch', 'koro-platform-charge',
] as const;
export type BambooKitId = typeof BAMBOO_KIT_IDS[number];
const BAMBOO_KITS: Readonly<Record<string, true>> = Object.fromEntries(BAMBOO_KIT_IDS.map(id => [id, true]));
export const isBambooKit = (kit: string): kit is BambooKitId => BAMBOO_KITS[kit] === true;

/** Attack id → [kit id, presentation element]. Koro's rock throw, vine vault (the foreground leap) and branch swing (the log sweep) play the Howler kits. */
export const BAMBOO_ATTACK_KITS: Readonly<Record<string, readonly [BambooKitId | CanopyKitId, VfxElement]>> = {
  'asha-guarding-pounce': ['asha-pounce', 'earth'],
  'asha-corrupted-pounce': ['asha-corrupt-slam', 'sap'],
  'asha-bamboo-charge': ['asha-charge', 'earth'],
  'asha-side-charge': ['asha-charge', 'sap'],
  'asha-claw-combination': ['asha-claw', 'earth'],
  'asha-black-sap-trail': ['asha-sap-trail', 'sap'],
  'asha-ground-wave': ['asha-ground-wave', 'sap'],
  'koro-falling-branch': ['koro-falling-branch', 'earth'],
  'koro-platform-charge': ['koro-platform-charge', 'earth'],
  'koro-rock-throw': ['howler-rock-hurl', 'earth'],
  'koro-vine-vault': ['howler-leap-slam', 'earth'],
  'koro-branch-swing': ['howler-branch-sweep', 'earth'],
};

/** Idle body aura by actor instance id: the sap-bound Branchbreaker and the corrupted Asha. Drawn only while the body is hostile (see ActorVfx). */
export const BAMBOO_AURAS: Readonly<Record<string, AuraTheme>> = { koro: 'howler', asha: 'toxic' };

const SHAKE_RADIUS = 6;
const SHAKE_WEIGHT: Readonly<Record<BambooKitId, number>> = {
  'asha-pounce': 0.2, 'asha-corrupt-slam': 0.26, 'asha-charge': 0.16, 'asha-claw': 0.08, 'asha-sap-trail': 0.1, 'asha-ground-wave': 0.2,
  'koro-falling-branch': 0.24, 'koro-platform-charge': 0.18,
};

// Alpha-blended tints (never HDR): sap-black smoke, red-gold bamboo dust, bark and split-bamboo green.
const BLACK_SAP = new Color().setRGB(0.05, 0.045, 0.06);
const BAMBOO_DUST = new Color().setRGB(0.42, 0.32, 0.16);
const SAP_DUST = new Color().setRGB(0.12, 0.1, 0.09);
const BARK = new Color().setRGB(0.3, 0.2, 0.1);

const clamp01 = (t: number): number => t < 0 ? 0 : t > 1 ? 1 : t;
/** Corrupted kits (sap element) draw dark, so their ground tell needs the contrast-aware fill and a stronger gain than the dry bamboo floor. */
const DARK_TELL = 0.8;
const corrupted = (slot: KitSlot): boolean => slot.element === 'sap';
const telegraphGain = (slot: KitSlot): number => corrupted(slot) ? 2.2 : 1.6;

class BambooKits implements MapKitFamily {
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly c = new Vector3();

  constructor(private readonly vfx: VfxSystem, private readonly resolveSocket: SocketResolver | undefined, private impact: ImpactSink | undefined, private readonly focus: FocusSource) {}

  owns(kit: string): boolean { return isBambooKit(kit); }

  setImpactSink(impact: ImpactSink | undefined): void { this.impact = impact; }

  begin(slot: KitSlot, seconds: number): void {
    const vfx = this.vfx, cue = slot.cue, phase = cue.phase;
    if (phase === 'anticipation' || phase === 'commit') {
      if (slot.hasFootprint) slot.ground = vfx.ground.spawn('fill', slot.footprint, slot.element, slot.owner, vfx.time, 0);
      if (phase === 'anticipation') { if (cue.actorId) this.impact?.flashActor(cue.actorId, PALETTE[slot.glow].b, 0.8, seconds, 'charge'); }
      else this.beginCommit(slot);
      return;
    }
    if (phase === 'active') this.detonate(slot, seconds);
  }

  update(slot: KitSlot, worldTick: number, dt: number, t: number): void {
    const cue = slot.cue;
    if (cue.phase === 'anticipation' || cue.phase === 'commit') {
      const progress = cue.phase === 'anticipation' ? t * 0.8 : 0.8 + 0.2 * t;
      if (slot.ground) this.vfx.ground.drive(slot.ground, progress, (0.8 + 0.25 * progress) * telegraphGain(slot), Math.min(1, (worldTick - cue.worldTick) / 6 + 0.25), corrupted(slot) ? DARK_TELL : 0);
      if (cue.phase === 'anticipation') this.updateAnticipation(slot, t, dt); else this.updateCommit(slot, t, dt);
      return;
    }
    if (cue.phase === 'active') this.updateActive(slot, t, dt);
  }

  /** Releases manual resources (ground fill / pool, lane or branch beam); a natural end of the active phase also emits the decay. */
  end(slot: KitSlot, natural: boolean): void {
    if (slot.ground) { this.vfx.ground.release(slot.ground); slot.ground = undefined; }
    if (slot.beam) { this.vfx.beams.release(slot.beam); slot.beam = undefined; }
    slot.socket = undefined;
    if (natural && slot.cue.phase === 'active') this.decay(slot);
  }

  // ---- commit start ----

  private beginCommit(slot: KitSlot): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint, dark = corrupted(slot);
    switch (slot.kit as BambooKitId) {
      case 'asha-pounce': case 'asha-corrupt-slam': {
        // She pushes off: bamboo dust (or sap smoke) thrown back from her feet.
        const feet = this.feet(slot, this.a);
        vfx.dustRing(feet.x, this.groundY(slot), feet.z, slot.kit === 'asha-pounce' ? 1.1 : 1.6, 16, owner, dark ? SAP_DUST : BAMBOO_DUST);
        vfx.leaves(feet.x, this.groundY(slot) + 0.2, feet.z, 6, 0.9, 0, 0, owner);
        break;
      }
      case 'asha-charge': case 'koro-platform-charge': {
        // The lane begins at her feet: a spray of dust and split bamboo kicks backward.
        const feet = this.feet(slot, this.a);
        vfx.dustRing(feet.x, this.groundY(slot), feet.z, 0.9, 14, owner, dark ? SAP_DUST : BAMBOO_DUST);
        vfx.sparks(feet.x, this.groundY(slot) + 0.2, feet.z, 8, 2.6, slot.element, owner, 0.4);
        break;
      }
      case 'asha-claw': {
        const hand = this.socketPosition(slot, this.a);
        vfx.sparks(hand.x, hand.y, hand.z, 8, 3, slot.element, owner, 0.3);
        break;
      }
      case 'asha-sap-trail': {
        // The tail whips back and sap sprays along the lane before it is laid.
        const feet = this.feet(slot, this.a);
        vfx.smoke(feet.x, this.groundY(slot) + 0.2, feet.z, 4, 0.5, 0.4, 0.8, 0.9, BLACK_SAP, 0.5, owner, 0.4);
        vfx.bubbles(feet.x, this.groundY(slot), feet.z, 8, 0.6, owner, 'sap');
        break;
      }
      case 'asha-ground-wave': {
        // The forepaws are up: cracks of sap-light run to the edge of the band.
        for (let n = vfx.count(10); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.b, 0.05, 0.9); vfx.glow(this.b.x, this.b.y, this.b.z, 0.2, 0.5, 'sap', 0.5, owner, 0.2); }
        break;
      }
      case 'koro-falling-branch':
        // The branch comes loose: a beam of dark bark drops from above the marked ground along the committed time.
        slot.beam = vfx.beams.acquire(owner, vfx.time, 0, 0.42, 0.02, 'earth');
        this.placeBranch(slot, 0);
        break;
    }
  }

  // ---- anticipation ----

  private updateAnticipation(slot: KitSlot, t: number, dt: number): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint, element = slot.element, dark = corrupted(slot);
    switch (slot.kit as BambooKitId) {
      case 'asha-pounce': case 'asha-corrupt-slam': {
        // She sinks low (or rears): earth gathers at her feet and dust lifts inside the landing mark.
        const feet = this.feet(slot, this.a), y = this.groundY(slot);
        vfx.gather(feet.x, y + 0.4, feet.z, this.due(slot, 20, dt), 1.2, element, owner);
        for (let n = this.due(slot, 12, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.1, 0.8); vfx.smoke(this.b.x, this.b.y, this.b.z, 1, 0.12, 0.3, 0.6, 0.9, dark ? SAP_DUST : BAMBOO_DUST, 0.26, owner, 0.1); }
        for (let n = this.due(slot, 10, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.05, 0.8); vfx.glow(this.b.x, this.b.y, this.b.z, 0.14, 0.7, element, 0.4, owner, 0.5); }
        if (dark) for (let n = this.due(slot, 8, dt, 4); n > 0; n--) vfx.smoke(feet.x, y + 0.3, feet.z, 1, 0.5, 0.35, 0.7, 0.9, BLACK_SAP, 0.4, owner, 0.2);
        return;
      }
      case 'asha-charge': case 'koro-platform-charge': {
        // A paw scrapes the ground: dust kicks back from the feet and the lane glimmers ahead.
        const feet = this.feet(slot, this.a), y = this.groundY(slot);
        vfx.gather(feet.x, y + 0.3, feet.z, this.due(slot, 14, dt), 1, element, owner);
        for (let n = this.due(slot, 14, dt, 2); n > 0; n--) vfx.smoke(feet.x, y + 0.1, feet.z, 1, 0.45, 0.3, 0.6, 0.8, dark ? SAP_DUST : BAMBOO_DUST, 0.3, owner, 0.5);
        this.laneStreaks(slot, this.due(slot, 18 + 18 * t, dt, 3), 0.35 + 0.5 * t, 5 + 5 * t);
        return;
      }
      case 'asha-claw': {
        // The raised paw glints; the fan in front of her brightens.
        const hand = this.socketPosition(slot, this.a);
        vfx.gather(hand.x, hand.y, hand.z, this.due(slot, 18, dt), 0.7, element, owner);
        for (let n = this.due(slot, 8, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.15, 0.85); vfx.glow(this.b.x, this.b.y, this.b.z, 0.12, 0.6, element, 0.4, owner); }
        return;
      }
      case 'asha-sap-trail': {
        // Black Sap wells at the tail and pools into bubbles along the lane she is about to lay.
        const feet = this.feet(slot, this.a);
        for (let n = this.due(slot, 10, dt); n > 0; n--) vfx.smoke(feet.x, this.groundY(slot) + 0.3, feet.z, 1, 0.35, 0.3, 0.6, 0.9, BLACK_SAP, 0.45, owner, 0.2);
        for (let n = this.due(slot, 14, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.3 + 0.6 * t), this.b, 0.05, 0.85); vfx.bubbles(this.b.x, this.b.y, this.b.z, 1, 0.1, owner, 'sap'); }
        return;
      }
      case 'asha-ground-wave': {
        // The ground darkens and trembles over the band: sap-light glints and dust lift along it.
        const feet = this.feet(slot, this.a), y = this.groundY(slot);
        vfx.gather(feet.x, y + 0.5, feet.z, this.due(slot, 18, dt), 1.4, 'sap', owner);
        for (let n = this.due(slot, 16, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.08, 0.85); vfx.smoke(this.b.x, this.b.y, this.b.z, 1, 0.12, 0.3, 0.6, 0.9, SAP_DUST, 0.28, owner, 0.1); }
        for (let n = this.due(slot, 10, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.b, 0.05, 0.85); vfx.glow(this.b.x, this.b.y, this.b.z, 0.14, 0.7, 'sap', 0.4, owner, 0.4); }
        return;
      }
      case 'koro-falling-branch': {
        // Koro beats his chest; bark dust and torn leaves loosen above the marked ground and drift down.
        const chest = this.socketPosition(slot, this.a);
        vfx.gather(chest.x, chest.y, chest.z, this.due(slot, 14, dt), 0.9, 'earth', owner);
        for (let n = this.due(slot, 12, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.b, 5 + 3 * vfx.random(), 0.8); vfx.leaves(this.b.x, this.b.y, this.b.z, 1, 0.2, 0, 0, owner); }
        for (let n = this.due(slot, 8, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.b, 0.1, 0.8); vfx.smoke(this.b.x, this.b.y, this.b.z, 1, 0.1, 0.25, 0.5, 0.8, BARK, 0.25, owner, 0.1); }
        return;
      }
    }
  }

  // ---- commit ----

  private updateCommit(slot: KitSlot, t: number, dt: number): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint, element = slot.element, dark = corrupted(slot);
    switch (slot.kit as BambooKitId) {
      case 'asha-pounce': case 'asha-corrupt-slam': {
        // Airborne (or the slam coming down): dust streams off the body and the mark's glints thicken as the landing nears.
        const feet = this.feet(slot, this.a);
        for (let n = this.due(slot, 24, dt); n > 0; n--) vfx.smoke(feet.x, feet.y + 0.4, feet.z, 1, 0.45, 0.2, 0.7, 0.7, dark ? SAP_DUST : BAMBOO_DUST, 0.25, owner, 0.3);
        for (let n = this.due(slot, 22, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.b, 0.1, 0.85); vfx.glow(this.b.x, this.b.y, this.b.z, 0.16 + 0.12 * t, 0.5, element, 0.45, owner, 0.4); }
        return;
      }
      case 'asha-charge': case 'koro-platform-charge': {
        // The lane draws itself in streaks while a plume kicks off the feet.
        const feet = this.feet(slot, this.a);
        this.laneStreaks(slot, this.due(slot, 44, dt), 0.9, 9 + 4 * t);
        for (let n = this.due(slot, 24, dt, 2); n > 0; n--) vfx.smoke(feet.x, this.groundY(slot) + 0.1, feet.z, 1, 0.4, 0.25, 0.6, 0.7, dark ? SAP_DUST : BAMBOO_DUST, 0.3, owner, 0.5);
        return;
      }
      case 'asha-claw': {
        this.laneStreaks(slot, this.due(slot, 30, dt), 0.9, 8);
        return;
      }
      case 'asha-sap-trail': {
        // Sap runs ahead of the tail along the lane.
        this.laneStreaks(slot, this.due(slot, 30, dt), 0.9, 7, PALETTE.sap.hot);
        for (let n = this.due(slot, 10, dt, 2); n > 0; n--) { fp.toWorld((vfx.random() - 0.5) * 2 * fp.halfWidth * 0.7, -fp.halfLength + vfx.random() * fp.halfLength * 2 * t, this.b, 0.15); vfx.smoke(this.b.x, this.b.y, this.b.z, 1, 0.15, 0.2, 0.5, 0.7, BLACK_SAP, 0.4, owner, 0.1); }
        return;
      }
      case 'asha-ground-wave': {
        // Cracks race toward the edges of the band ahead of the wave.
        for (let n = this.due(slot, 30, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.b, 0.1, 0.9); this.sideStreak(slot, this.b, 3 + 3 * t, 0.2, PALETTE.sap.hot, 0.5); }
        return;
      }
      case 'koro-falling-branch':
        // The branch falls: its beam drops from height to the marked ground exactly as the commit ends, trailing bark dust.
        this.placeBranch(slot, t);
        for (let n = this.due(slot, 30, dt); n > 0; n--) { this.branchPoint(slot, t, this.a); vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.15, 0.1, 0.5, 0.5, BARK, 0.3, owner, 0.1); }
        return;
    }
  }

  // ---- active ----

  private detonate(slot: KitSlot, seconds: number): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint, time = vfx.time, kit = slot.kit as BambooKitId, element = slot.element, dark = corrupted(slot);
    const center = this.center(fp, this.c), r = Math.min(fp.halfWidth, fp.halfLength);
    switch (kit) {
      case 'asha-pounce': case 'asha-corrupt-slam': {
        // The landing: a flash, a hard shock ring, a decal, dust and split bamboo thrown outward; the slam adds a second ring and sap bubbles.
        vfx.flash(center.x, center.y + 0.3, center.z, r * 1.6, element, owner, 0.22);
        vfx.ground.spawn('shock', fp, element, owner, time, kit === 'asha-corrupt-slam' ? 0.5 : 0.42);
        vfx.ground.spawn('decal', fp, element, owner, time, 5, 1, slot.glow);
        vfx.sparks(center.x, center.y + 0.2, center.z, 26, 4.4, element, owner, 0.7);
        vfx.dustRing(center.x, center.y, center.z, r, 26, owner, dark ? SAP_DUST : BAMBOO_DUST);
        vfx.leaves(center.x, center.y + 0.3, center.z, 10, r * 0.8, 0, 0, owner);
        if (kit === 'asha-corrupt-slam') {
          vfx.smoke(center.x, center.y + 0.2, center.z, 6, r * 0.8, 0.5, 1.1, 1.3, BLACK_SAP, 0.45, owner, 0.6);
          vfx.bubbles(center.x, center.y, center.z, 12, r * 0.8, owner, 'sap');
        }
        vfx.lights.pulse(center.x, center.y + 1, center.z, PALETTE[element].hot, 5, 7, 0.5, time, owner);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'asha-charge': case 'koro-platform-charge': {
        // The body sweeps the lane under a beam while the engine moves it; the beam and the shed debris stay inside the lane footprint.
        slot.beam = vfx.beams.acquire(owner, time, 0, 0.5, 0.02, element);
        if (slot.beam) { fp.toWorld(0, -fp.halfLength, slot.beam.a, 0.5); fp.toWorld(0, fp.halfLength, slot.beam.b, 0.5); slot.beam.alpha = 0.7; }
        vfx.ground.spawn('shock', fp, element, owner, time, 0.4);
        vfx.ground.spawn('decal', fp, element, owner, time, 4, 1, slot.glow);
        this.laneStreaks(slot, vfx.count(30), 1, 16);
        fp.toWorld(0, fp.halfLength - 0.5, this.b, 0.5);
        vfx.flash(this.b.x, this.b.y, this.b.z, 1.2, element, owner, Math.max(0.12, Math.min(0.3, seconds)));
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'asha-claw': {
        // Three crossing slashes along the fan.
        vfx.ground.spawn('shock', fp, element, owner, time, 0.3);
        for (let i = 0; i < 3; i++) {
          fp.sample(0.2 + 0.3 * i, 0.55, this.a, 0.9, 0.6);
          vfx.sparks(this.a.x, this.a.y, this.a.z, 8, 3.4, element, owner, 0.2);
          vfx.flash(this.a.x, this.a.y, this.a.z, 0.8, element, owner, 0.12);
        }
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'asha-sap-trail': {
        // The lane is laid: a flash along it, a dark burn surface that lasts as long as the engine's hazard (driven in updateActive) and bubbling sap.
        vfx.flash(center.x, center.y + 0.3, center.z, Math.max(fp.halfWidth, 1), 'sap', owner, 0.2);
        vfx.ground.spawn('shock', fp, 'sap', owner, time, 0.4);
        slot.ground = vfx.ground.spawn('burn', fp, 'sap', owner, time, 0, 1, slot.glow);
        for (let n = vfx.count(10); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.1, 0.85); vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.15, 0.3, 0.7, 1, BLACK_SAP, 0.4, owner, 0.2); }
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'asha-ground-wave': {
        // The wave runs across the band: a shock band over the whole footprint, a decal and a travelling head (updateActive).
        vfx.ground.spawn('shock', fp, 'sap', owner, time, Math.max(0.2, Math.min(1.1, seconds)));
        vfx.ground.spawn('decal', fp, 'sap', owner, time, 4.5, 1, slot.glow);
        vfx.flash(center.x, center.y + 0.3, center.z, Math.max(1, r), 'sap', owner, 0.2);
        vfx.dustRing(center.x, center.y, center.z, Math.min(r, 3), 18, owner, SAP_DUST);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'koro-falling-branch': {
        // The branch lands on the mark: a flash, a shock ring, a decal, bark splinters, torn leaves and dust.
        this.placeBranch(slot, 1);
        vfx.flash(center.x, center.y + 0.4, center.z, r * 1.5, 'earth', owner, 0.22);
        vfx.ground.spawn('shock', fp, 'earth', owner, time, 0.42);
        vfx.ground.spawn('decal', fp, 'earth', owner, time, 5, 1, slot.glow);
        vfx.chunks(center.x, center.y + 0.3, center.z, 8, 4, 0.18, owner, false, fp);
        vfx.sparks(center.x, center.y + 0.2, center.z, 18, 3.6, 'earth', owner, 0.7);
        vfx.dustRing(center.x, center.y, center.z, r, 22, owner, BARK);
        vfx.leaves(center.x, center.y + 0.3, center.z, 12, r * 0.8, 0, 0, owner);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
    }
  }

  private updateActive(slot: KitSlot, t: number, dt: number): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint, dark = corrupted(slot);
    switch (slot.kit as BambooKitId) {
      case 'asha-pounce': case 'asha-corrupt-slam':
        // Dust and split bamboo settle over the crater.
        for (let n = this.due(slot, 20, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.1, 0.8); vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.2, 0.3, 0.7, 0.9, dark ? SAP_DUST : BAMBOO_DUST, 0.25, owner, 0.3); }
        return;
      case 'asha-charge': case 'koro-platform-charge': {
        // The head of the charge runs the lane with the active window: dust and shards shed behind it.
        if (slot.beam) slot.beam.alpha = Math.sin(Math.PI * Math.min(1, t * 1.02)) * 0.7 + 0.1;
        fp.toWorld(0, -fp.halfLength + 2 * fp.halfLength * clamp01(t), this.a, 0.3);
        for (let n = this.due(slot, 60, dt); n > 0; n--) vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.35, 0.2, 0.6, 0.6, dark ? SAP_DUST : BAMBOO_DUST, 0.3, owner, 0.4);
        for (let n = this.due(slot, 30, dt, 2); n > 0; n--) vfx.sparks(this.a.x, this.a.y, this.a.z, 1, 2.2, slot.element, owner, 0.4);
        for (let n = this.due(slot, 24, dt, 3); n > 0; n--) this.laneStreaks(slot, 1, 1, 16);
        return;
      }
      case 'asha-claw':
        for (let n = this.due(slot, 20, dt); n > 0; n--) this.laneStreaks(slot, 1, 1, 10);
        return;
      case 'asha-sap-trail': {
        // The pool stays for the whole engine hazard: it fades in, bubbles and seeps, and fades out over the last quarter.
        if (slot.ground) vfx.ground.drive(slot.ground, 1, 0.9, Math.min(1, t * 6) * Math.min(1, (1 - t) * 4));
        for (let n = this.due(slot, 8, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.05, 0.85); vfx.bubbles(this.a.x, this.a.y, this.a.z, 1, 0.1, owner, 'sap'); }
        for (let n = this.due(slot, 5, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.1, 0.8); vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.15, 0.35, 0.6, 1, BLACK_SAP, 0.3, owner, 0.15); }
        return;
      }
      case 'asha-ground-wave': {
        // The wave head travels across the band; the surface behind it keeps cracking.
        const head = fp.toWorld((-0.9 + 1.8 * clamp01(t)) * fp.halfWidth, 0, this.a, 0.2);
        for (let n = this.due(slot, 70, dt); n > 0; n--) vfx.smoke(head.x, head.y, head.z, 1, 0.3, 0.2, 0.6, 0.6, SAP_DUST, 0.3, owner, 0.4);
        for (let n = this.due(slot, 30, dt, 2); n > 0; n--) vfx.sparks(head.x, head.y + 0.1, head.z, 1, 1.8, 'sap', owner, 0.4);
        vfx.glow(head.x, head.y + 0.1, head.z, 0.9, 0.1, 'sap', 0.2, owner);
        return;
      }
      case 'koro-falling-branch':
        // Splinters and dust settle around the fallen branch.
        for (let n = this.due(slot, 16, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.1, 0.8); vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.2, 0.3, 0.7, 0.9, BARK, 0.25, owner, 0.3); }
        return;
    }
  }

  // ---- decay ----

  private decay(slot: KitSlot): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint, center = this.center(fp, this.c), r = Math.min(fp.halfWidth, fp.halfLength), dark = corrupted(slot);
    switch (slot.kit as BambooKitId) {
      case 'asha-pounce': case 'asha-corrupt-slam':
        vfx.smoke(center.x, center.y, center.z, 6, r * 0.9, 0.4, 1.2, 1.6, dark ? SAP_DUST : BAMBOO_DUST, 0.22, owner, 0.3);
        break;
      case 'asha-charge': case 'koro-platform-charge':
        for (let i = vfx.count(8); i > 0; i--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.3, 0.85); vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.2, 0.3, 0.8, 1.2, dark ? SAP_DUST : BAMBOO_DUST, 0.2, owner, 0.2); }
        break;
      case 'asha-sap-trail':
        // The pool dries into a lasting stain.
        vfx.ground.spawn('decal', fp, 'sap', owner, vfx.time, 6, 1, slot.glow);
        break;
      case 'asha-ground-wave':
        vfx.smoke(center.x, center.y, center.z, 6, r * 0.6, 0.4, 1, 1.4, SAP_DUST, 0.22, owner, 0.3);
        break;
      case 'koro-falling-branch':
        vfx.smoke(center.x, center.y, center.z, 5, r * 0.8, 0.4, 1, 1.4, BARK, 0.22, owner, 0.3);
        break;
      default:
        break;
    }
  }

  // ---- helpers ----

  /** The falling branch: a beam of dark bark from above the committed mark down to it; `t` 0 at the start of the drop, 1 on the ground. */
  private placeBranch(slot: KitSlot, t: number): void {
    const beam = slot.beam;
    if (!beam) return;
    const fp = slot.footprint, drop = 9 * (1 - clamp01(t) * clamp01(t));
    fp.toWorld(-1.4, 0, beam.a, 0.4 + drop); fp.toWorld(1.4, 0, beam.b, 0.4 + drop * 0.8);
    beam.alpha = 0.8;
  }

  /** Point on the falling branch's axis, written to `out`. */
  private branchPoint(slot: KitSlot, t: number, out: Vector3): Vector3 {
    const drop = 9 * (1 - clamp01(t) * clamp01(t));
    return slot.footprint.toWorld(this.vfx.range(-1.4, 1.4), 0, out, 0.4 + drop * 0.9);
  }

  /** Thin velocity-stretched additive streak. */
  private streak(owner: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, width: number, stretch: number, color: Color, alpha: number): void {
    const vfx = this.vfx, p = vfx.spec();
    p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz; p.drag = 2; p.life = life; p.size0 = width; p.size1 = width * 0.4; p.frame = VFX_FRAME.spark; p.stretch = stretch;
    p.r0 = p.r1 = color.r; p.g0 = p.g1 = color.g; p.b0 = p.b1 = color.b; p.a0 = alpha; p.fadeIn = 0.15; p.fadeOut = 0.5;
    vfx.emit(vfx.particles.additive, owner);
  }

  /** Streaks racing along the lane (+Z in the footprint frame) at random lane positions, in the cue's element unless a colour is given. */
  private laneStreaks(slot: KitSlot, count: number, reach: number, speed: number, color: Color = PALETTE[slot.element].b): void {
    const vfx = this.vfx, fp: Footprint = slot.footprint;
    for (let i = count; i > 0; i--) {
      fp.toWorld((vfx.random() - 0.5) * 2 * fp.halfWidth * 0.8, -fp.halfLength + vfx.random() * fp.halfLength * 2 * reach, this.b, vfx.range(0.15, 0.85));
      this.streak(slot.owner, this.b.x, this.b.y, this.b.z, fp.forwardX * speed, 0, fp.forwardZ * speed, vfx.range(0.18, 0.34), 0.06, 0.12, color, 0.5);
    }
  }

  private sideStreak(slot: KitSlot, at: Vector3, speed: number, life: number, color: Color, alpha: number): void {
    const a = slot.footprint.angle;
    this.streak(slot.owner, at.x, at.y, at.z, Math.cos(a) * speed, 0, -Math.sin(a) * speed, life + this.vfx.random() * 0.12, 0.06, 0.12, color, alpha);
  }

  /** Integer emissions due this frame for a continuous rate (per second of world time); reduced effects keeps 35 %. */
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

  /** Hand or head: the manifest `cast` socket, else the authored source point lifted to chest height. */
  private socketPosition(slot: KitSlot, out: Vector3): Vector3 {
    if (slot.socket) { slot.socket.updateWorldMatrix(true, false); return slot.socket.getWorldPosition(out); }
    const from = slot.cue.from ?? slot.cue.position;
    return out.set(from?.x ?? 0, (from?.y ?? 0) + 1.1, from?.z ?? 0);
  }

  /** Horizontal position of the body with y at the simulation floor (dust and ground effects stay on the ground). */
  private feet(slot: KitSlot, out: Vector3): Vector3 {
    const root = slot.cue.actorId ? this.resolveSocket?.(slot.cue.actorId, 'root') as Object3D | undefined : undefined;
    if (root) { root.updateWorldMatrix(true, false); root.getWorldPosition(out); } else { const from = slot.cue.from ?? slot.cue.position; out.set(from?.x ?? 0, from?.y ?? 0, from?.z ?? 0); }
    out.y = this.groundY(slot);
    return out;
  }

  private groundY(slot: KitSlot): number { return slot.cue.from?.y ?? slot.footprint.cy; }

  private center(fp: Footprint, out: Vector3): Vector3 {
    return fp.shape === 'sector' ? fp.toWorld(0, fp.halfLength * 0.5, out) : out.set(fp.cx, fp.cy, fp.cz);
  }
}

export function createBambooKits(vfx: VfxSystem, resolveSocket: SocketResolver | undefined, impact: ImpactSink | undefined, focus: FocusSource): MapKitFamily {
  return new BambooKits(vfx, resolveSocket, impact, focus);
}
