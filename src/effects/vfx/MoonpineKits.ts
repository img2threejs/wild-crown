import { Color, Vector3, type Object3D } from 'three';
import { MOONPINE_CHAIN_ANCHORS } from '../../game/combat/MoonpineContent.js';
import type { AuraTheme } from './ActorVfx.js';
import type { FocusSource } from './CanopyKits.js';
import type { ImpactSink, KitSlot, MapKitFamily, SocketResolver } from './ElementKits.js';
import type { Footprint } from './footprint.js';
import { PALETTE, type VfxElement } from './palette.js';
import type { BeamSlot } from './RibbonFx.js';
import { VFX_FRAME } from './VfxAtlas.js';
import type { VfxSystem } from './VfxSystem.js';

/** Moonpine monster kits: the attack id is the kit id (like CanopyKits). Three phases: anticipation, commit, active, then decay. */
export const MOONPINE_KIT_IDS = [
  'frostfang-pack-rush', 'frostfang-ice-bite', 'frostfang-frost-breath',
  'howl-scout-flank-pounce', 'howl-scout-claw-rake', 'howl-scout-low-howl',
  'chained-ruun-chain-pounce', 'chained-ruun-howl-shockwave', 'chained-ruun-breaking-ice',
] as const;
export type MoonpineKitId = typeof MOONPINE_KIT_IDS[number];
const MOONPINE_KITS: Readonly<Record<string, true>> = {
  'frostfang-pack-rush': true, 'frostfang-ice-bite': true, 'frostfang-frost-breath': true,
  'howl-scout-flank-pounce': true, 'howl-scout-claw-rake': true, 'howl-scout-low-howl': true,
  'chained-ruun-chain-pounce': true, 'chained-ruun-howl-shockwave': true, 'chained-ruun-breaking-ice': true,
};
export const isMoonpineKit = (kit: string): kit is MoonpineKitId => MOONPINE_KITS[kit] === true;

/** Attack id -> [kit id, presentation element]: frost-blue tracker, wind-white scout, earth chains and black-sap howl for Ruun, ice for the lake. */
export const MOONPINE_ATTACK_KITS: Readonly<Record<string, readonly [MoonpineKitId, VfxElement]>> = {
  'frostfang-pack-rush': ['frostfang-pack-rush', 'ice'],
  'frostfang-ice-bite': ['frostfang-ice-bite', 'ice'],
  'frostfang-frost-breath': ['frostfang-frost-breath', 'ice'],
  'howl-scout-flank-pounce': ['howl-scout-flank-pounce', 'wind'],
  'howl-scout-claw-rake': ['howl-scout-claw-rake', 'wind'],
  'howl-scout-low-howl': ['howl-scout-low-howl', 'wind'],
  'chained-ruun-chain-pounce': ['chained-ruun-chain-pounce', 'earth'],
  'chained-ruun-howl-shockwave': ['chained-ruun-howl-shockwave', 'sap'],
  'chained-ruun-breaking-ice': ['chained-ruun-breaking-ice', 'ice'],
};
/** Monster id -> idle body aura theme drawn by ActorVfx: cold mist for the tracker, snow dust for the scout, grit and black sap for Ruun. */
export const MOONPINE_AURAS: Readonly<Record<string, AuraTheme>> = {
  'moonpine-frostfang': 'frost', 'moonpine-scout': 'earth', 'moonpine-ruun': 'howler',
};

const SHAKE_RADIUS = 6;
const SHAKE_WEIGHT: Readonly<Record<MoonpineKitId, number>> = {
  'frostfang-pack-rush': 0.14, 'frostfang-ice-bite': 0.12, 'frostfang-frost-breath': 0.1,
  'howl-scout-flank-pounce': 0.22, 'howl-scout-claw-rake': 0.1, 'howl-scout-low-howl': 0.12,
  'chained-ruun-chain-pounce': 0.3, 'chained-ruun-howl-shockwave': 0.3, 'chained-ruun-breaking-ice': 0.22,
};
/** Height (m) of the chain anchor posts: the chains are drawn to their tops. */
const ANCHOR_HEIGHT = 2.2;

// Alpha-blended tints (never HDR): powder snow, cold fog and the dull iron of the chains.
const SNOW = new Color().setRGB(0.62, 0.7, 0.82);
const FROST_FOG = new Color().setRGB(0.4, 0.58, 0.75);
const SAP_DUST = new Color().setRGB(0.2, 0.2, 0.12);

const smooth = (t: number): number => { const x = t < 0 ? 0 : t > 1 ? 1 : t; return x * x * (3 - 2 * x); };

/**
 * Presentation kits for the nine Moonpine attacks. Every kit is a pure function of its cue (authored footprint, phase window,
 * socket bones) and the world clock, so pause, slow motion, hit-stop and cancellation behave like the Greenwake and Canopy kits.
 * All emission goes through the shared particle pools, ground quads, crystal spikes, wind blades and beams; the manual resources
 * (ground fill, beams, Ruun's chains) are released with their cue. Ground quads, spikes and cloud emitters are only ever placed
 * inside the cue footprint (or a shape inscribed in it), so no hard-edged zone leaves the authored hazard.
 */
class MoonpineKits implements MapKitFamily {
  /** Ruun's chain beams of one phase cue (the pounce and the howl); each phase cue owns its own slot, so the chains follow its lifetime. */
  private readonly chains = new WeakMap<KitSlot, BeamSlot[]>();
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly c = new Vector3();
  private readonly d = new Vector3();

  constructor(private readonly vfx: VfxSystem, private readonly resolveSocket: SocketResolver | undefined, private impact: ImpactSink | undefined, private readonly focus: FocusSource) {}

  setImpactSink(impact: ImpactSink | undefined): void { this.impact = impact; }

  owns(kit: string): boolean { return isMoonpineKit(kit); }

  begin(slot: KitSlot, seconds: number): void {
    const vfx = this.vfx, cue = slot.cue, phase = cue.phase;
    this.releaseChains(slot);
    if (phase === 'anticipation' || phase === 'commit') {
      if (slot.hasFootprint) slot.ground = vfx.ground.spawn('fill', slot.footprint, slot.element, slot.owner, vfx.time, 0);
      if (phase === 'anticipation') {
        if (cue.actorId) this.impact?.flashActor(cue.actorId, PALETTE[slot.glow].b, 1.1, seconds, 'charge');
        this.beginAnticipation(slot);
      } else this.beginCommit(slot);
      return;
    }
    if (phase === 'active') this.detonate(slot, seconds);
  }

  update(slot: KitSlot, worldTick: number, dt: number, t: number): void {
    const cue = slot.cue;
    if (cue.phase === 'anticipation' || cue.phase === 'commit') {
      const vfx = this.vfx, progress = cue.phase === 'anticipation' ? t * 0.8 : 0.8 + 0.2 * t;
      const flicker = cue.phase === 'commit' && !vfx.reducedEffects ? 1 + 0.3 * Math.sin(vfx.time * 34) * t : 1;
      if (slot.ground) vfx.ground.drive(slot.ground, progress, (0.8 + 0.3 * progress) * flicker, Math.min(1, (worldTick - cue.worldTick) / 6 + 0.25));
      if (cue.phase === 'anticipation') this.updateAnticipation(slot, t, dt); else this.updateCommit(slot, t, dt);
      return;
    }
    if (cue.phase === 'active') this.updateActive(slot, t, dt);
  }

  /** Releases manual resources (ground fill, beams, chains); a natural end of the active phase also emits the decay. */
  end(slot: KitSlot, natural: boolean): void {
    if (slot.ground) { this.vfx.ground.release(slot.ground); slot.ground = undefined; }
    if (slot.beam) { this.vfx.beams.release(slot.beam); slot.beam = undefined; }
    this.releaseChains(slot);
    slot.socket = undefined;
    if (natural && slot.cue.phase === 'active') this.decay(slot);
  }

  // ---- begin ----

  private beginAnticipation(slot: KitSlot): void {
    const owner = slot.owner;
    switch (slot.kit as MoonpineKitId) {
      case 'frostfang-pack-rush': case 'howl-scout-flank-pounce': {
        const feet = this.feet(slot, this.a);
        this.vfx.dustRing(feet.x, this.groundY(slot), feet.z, 0.7, 8, owner, SNOW);
        break;
      }
      case 'chained-ruun-chain-pounce': case 'chained-ruun-howl-shockwave':
        this.drawChains(slot, 'earth', 0.07);
        break;
      default: break;
    }
  }

  private beginCommit(slot: KitSlot): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint;
    switch (slot.kit as MoonpineKitId) {
      case 'frostfang-pack-rush': {
        // Burst off the mark: snow thrown up behind the paws.
        const feet = this.feet(slot, this.a), y = this.groundY(slot);
        vfx.dustRing(feet.x, y, feet.z, 1, 16, owner, SNOW);
        vfx.chunks(feet.x, y + 0.05, feet.z, 4, 2.8, 0.14, owner, true);
        break;
      }
      case 'howl-scout-flank-pounce': {
        // Take-off: a ring of powder snow and kicked crust.
        const feet = this.feet(slot, this.a), y = this.groundY(slot);
        vfx.dustRing(feet.x, y, feet.z, 1, 18, owner, SNOW);
        vfx.chunks(feet.x, y + 0.05, feet.z, 5, 3, 0.14, owner, true);
        break;
      }
      case 'howl-scout-low-howl': case 'chained-ruun-howl-shockwave': {
        const mouth = this.socketPosition(slot, this.a), ruun = slot.kit === 'chained-ruun-howl-shockwave';
        if (ruun) this.drawChains(slot, 'earth', 0.09);
        this.ring(owner, mouth.x, mouth.y, mouth.z, 0.4, ruun ? 2.6 : 1.8, 0.45, slot.element, 0.55);
        break;
      }
      case 'chained-ruun-chain-pounce': {
        // The chains snap taut as Ruun heaves: a spray of metal sparks at the chest and a puff of grit at the paws.
        this.drawChains(slot, 'earth', 0.09);
        const chest = this.body(slot, this.a), feet = this.feet(slot, this.b);
        vfx.sparks(chest.x, chest.y + 0.5, chest.z, 14, 4.2, 'earth', owner, 0.4);
        vfx.dustRing(feet.x, this.groundY(slot), feet.z, 1.3, 18, owner, SNOW);
        break;
      }
      case 'chained-ruun-breaking-ice': {
        // The paw rises: frost glints gather under it. The stamp itself (shards, dust, shake) belongs to the active/contact frame.
        const feet = this.feet(slot, this.a), y = this.groundY(slot);
        vfx.gather(feet.x, y + 0.2, feet.z, 10, 0.9, 'ice', owner);
        break;
      }
      case 'frostfang-frost-breath': {
        const mouth = this.socketPosition(slot, this.a);
        vfx.sparks(mouth.x, mouth.y, mouth.z, 8, 3, 'ice', owner, 0.3);
        break;
      }
      case 'frostfang-ice-bite': {
        fp.toWorld(0, -fp.halfLength, this.a, 0.1);
        vfx.dustRing(this.a.x, fp.cy, this.a.z, 0.8, 10, owner, SNOW);
        break;
      }
      default: break;
    }
  }

  // ---- anticipation ----

  private updateAnticipation(slot: KitSlot, t: number, dt: number): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint;
    switch (slot.kit as MoonpineKitId) {
      case 'frostfang-pack-rush': {
        // The tracker lowers its shoulders: cold air and powder snow gather round the paws, glints crawl along the lane it will rush down.
        const feet = this.feet(slot, this.a), y = this.groundY(slot);
        vfx.gather(feet.x, y + 0.4, feet.z, this.due(slot, 24, dt), 1, 'ice', owner);
        for (let n = this.due(slot, 14 + 16 * t, dt, 2); n > 0; n--) vfx.smoke(feet.x, y, feet.z, 1, 0.8, 0.1, 0.8, 0.9, SNOW, 0.3, owner, 0.7);
        for (let n = this.due(slot, 12, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.1, 0.8); vfx.glow(this.b.x, this.b.y, this.b.z, 0.13, 0.6, 'ice', 0.4, owner, 0.2); }
        this.laneStreaks(slot, this.due(slot, 8 + 12 * t, dt, 4), 0.35, 5);
        return;
      }
      case 'frostfang-ice-bite': {
        // Frost-rimed jaws: a mist gathers at the mouth, glints flare on the fangs and tighten before the lunge.
        const mouth = this.socketPosition(slot, this.a);
        vfx.gather(mouth.x, mouth.y, mouth.z, this.due(slot, 34, dt), 0.6, 'ice', owner);
        for (let n = this.due(slot, 10, dt, 2); n > 0; n--) vfx.smoke(mouth.x, mouth.y - 0.05, mouth.z, 1, 0.12, 0.2, 0.5, 0.9, FROST_FOG, 0.3, owner, 0.2);
        for (let n = this.due(slot, 5, dt, 3); n > 0; n--) this.starGlint(slot, mouth, 0.2 + 0.25 * t, 0.2, 'ice');
        this.laneStreaks(slot, this.due(slot, 6 + 10 * t, dt, 4), 0.3, 6);
        return;
      }
      case 'frostfang-frost-breath': {
        // A cold inhale: frost is drawn in at the mouth while fog thickens inside the cone it will fill.
        const mouth = this.socketPosition(slot, this.a);
        vfx.gather(mouth.x, mouth.y, mouth.z, this.due(slot, 42, dt), 0.8, 'ice', owner);
        for (let n = this.due(slot, 14, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.3 + 0.5 * t), this.b, 0.05, 0.8); vfx.smoke(this.b.x, this.b.y, this.b.z, 1, 0.15, 0.1, 1, 1.1, FROST_FOG, 0.22, owner, 0.2); }
        for (let n = this.due(slot, 10, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.3 + 0.55 * t), this.b, 0.1, 0.75); vfx.glow(this.b.x, this.b.y, this.b.z, 0.12, 0.6, 'ice', 0.4, owner, 0.15); }
        for (let n = this.due(slot, 5, dt, 4); n > 0; n--) this.starGlint(slot, mouth, 0.2 + 0.2 * t, 0.2, 'ice');
        return;
      }
      case 'howl-scout-flank-pounce': {
        // Crouch: snow is sucked in under the paws and quick wind streaks circle the scout; the landing mark fills with settling powder.
        const feet = this.feet(slot, this.a), y = this.groundY(slot);
        for (let n = this.due(slot, 16 + 16 * t, dt); n > 0; n--) vfx.smoke(feet.x, y, feet.z, 1, 0.8, 0.12, 0.8, 0.9, SNOW, 0.3, owner, 0.7);
        vfx.gather(feet.x, y + 0.4, feet.z, this.due(slot, 16, dt, 2), 1, 'wind', owner);
        this.groundDust(slot, t, dt, 3, 8);
        return;
      }
      case 'howl-scout-claw-rake': {
        // Claws comb the snow: powder lifts at the paws and glints crawl along the lane.
        const feet = this.feet(slot, this.a), y = this.groundY(slot);
        for (let n = this.due(slot, 16, dt); n > 0; n--) vfx.smoke(feet.x + vfx.range(-0.3, 0.3), y, feet.z + vfx.range(-0.3, 0.3), 1, 0.4, 0.2, 0.5, 0.7, SNOW, 0.32, owner, 0.5);
        for (let n = this.due(slot, 10, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.1, 0.8); vfx.glow(this.b.x, this.b.y, this.b.z, 0.12, 0.6, 'wind', 0.4, owner, 0.2); }
        this.laneStreaks(slot, this.due(slot, 8 + 10 * t, dt, 3), 0.35, 6);
        return;
      }
      case 'howl-scout-low-howl': {
        // The howl climbs: rings pulse out of the muzzle, wind is drawn in and powder lifts along the band the shockwave will cross.
        const mouth = this.socketPosition(slot, this.a);
        vfx.gather(mouth.x, mouth.y, mouth.z, this.due(slot, 24, dt), 0.8, 'wind', owner);
        for (let n = this.due(slot, 3 + 4 * t, dt, 2); n > 0; n--) this.ring(owner, mouth.x, mouth.y, mouth.z, 0.2, 0.9 + 0.5 * t, 0.5, 'wind', 0.4);
        for (let n = this.due(slot, 14, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.05, 0.8); vfx.smoke(this.b.x, this.b.y, this.b.z, 1, 0.15, 0.2, 0.6, 0.8, SNOW, 0.28, owner, 0.3); }
        this.sideStreaks(slot, this.due(slot, 8 + 8 * t, dt, 4), 0.5);
        return;
      }
      case 'chained-ruun-chain-pounce': {
        // Ruun heaves against the chains: they draw tight and glint, grit sucks in under his paws, the landing mark fills with dust.
        this.driveChains(slot, 0.35 + 0.65 * t);
        this.chainSparks(slot, this.due(slot, 8 + 14 * t, dt), 'earth');
        const feet = this.feet(slot, this.a), y = this.groundY(slot);
        vfx.gather(feet.x, y + 0.5, feet.z, this.due(slot, 14, dt, 2), 1.2, 'earth', owner);
        for (let n = this.due(slot, 14 + 14 * t, dt, 3); n > 0; n--) vfx.smoke(feet.x, y, feet.z, 1, 1, 0.12, 0.9, 1, SAP_DUST, 0.3, owner, 0.8);
        this.groundDust(slot, t, dt, 4, 8);
        return;
      }
      case 'chained-ruun-howl-shockwave': {
        // The three-beat howl: three rings leave the muzzle on the beats (a third each), chains draw taut and black-sap motes gather in the mark.
        const mouth = this.socketPosition(slot, this.a), beat = Math.min(2, Math.floor(t * 3.2));
        this.driveChains(slot, 0.3 + 0.7 * t);
        if (slot.pulses <= beat && t > beat * 0.3) { slot.pulses = beat + 1; this.ring(owner, mouth.x, mouth.y, mouth.z, 0.3, 1.2 + 0.7 * beat, 0.5, 'sap', 0.55); vfx.sparks(mouth.x, mouth.y, mouth.z, 6, 2.4, 'sap', owner, 0.4); }
        vfx.gather(mouth.x, mouth.y, mouth.z, this.due(slot, 30, dt), 0.9, 'sap', owner);
        for (let n = this.due(slot, 12, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.05, 0.8); vfx.glow(this.b.x, this.b.y, this.b.z, 0.14, 0.7, 'sap', 0.4, owner, 0.25); }
        this.chainSparks(slot, this.due(slot, 8, dt, 3), 'earth');
        return;
      }
      case 'chained-ruun-breaking-ice': {
        // The frozen ground groans: glints and hairline cracks of light grow along the band, frost breathes off the paws.
        const feet = this.feet(slot, this.a), y = this.groundY(slot);
        vfx.gather(feet.x, y + 0.3, feet.z, this.due(slot, 18, dt), 1.1, 'ice', owner);
        for (let n = this.due(slot, 12 + 14 * t, dt, 2); n > 0; n--) vfx.smoke(feet.x, y, feet.z, 1, 0.9, 0.1, 0.9, 1, FROST_FOG, 0.26, owner, 0.7);
        for (let n = this.due(slot, 18, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.3 + 0.6 * t), this.b, 0.05, 0.85); vfx.glow(this.b.x, this.b.y, this.b.z, 0.14, 0.6, 'ice', 0.45, owner, 0.15); }
        this.sideStreaks(slot, this.due(slot, 6 + 8 * t, dt, 4), 0.4);
        return;
      }
    }
  }

  // ---- commit ----

  private updateCommit(slot: KitSlot, t: number, dt: number): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint;
    switch (slot.kit as MoonpineKitId) {
      case 'frostfang-pack-rush': {
        // The lane draws itself: frost streaks pour down it, snow churns under the paws, glints race along.
        const feet = this.feet(slot, this.a), y = this.groundY(slot);
        this.laneStreaks(slot, this.due(slot, 40, dt), 0.9, 9);
        for (let n = this.due(slot, 26, dt, 2); n > 0; n--) vfx.smoke(feet.x, y, feet.z, 1, 0.7, 0.15, 0.9, 0.9, SNOW, 0.34, owner, 1);
        for (let n = this.due(slot, 12, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.b, 0.1, 0.8); vfx.glow(this.b.x, this.b.y, this.b.z, 0.14, 0.5, 'ice', 0.45, owner, 0.2); }
        return;
      }
      case 'frostfang-ice-bite': {
        // The strike line draws itself: fast frost streaks along the lane, glints at the fangs.
        const mouth = this.socketPosition(slot, this.a);
        this.laneStreaks(slot, this.due(slot, 56, dt), 1, 16);
        vfx.gather(mouth.x, mouth.y, mouth.z, this.due(slot, 28, dt, 2), 0.5, 'ice', owner);
        for (let n = this.due(slot, 8, dt, 3); n > 0; n--) this.starGlint(slot, mouth, 0.3 + 0.3 * t, 0.15, 'ice');
        return;
      }
      case 'frostfang-frost-breath': {
        // Frost streaks fan out across the cone ahead of the breath, glints bloom inside it.
        const mouth = this.socketPosition(slot, this.a);
        for (let n = this.due(slot, 50, dt); n > 0; n--) {
          const angle = fp.angle + (vfx.random() - 0.5) * fp.aperture * 0.8, speed = vfx.range(6, 9);
          this.streak(owner, mouth.x, mouth.y - 0.1, mouth.z, Math.sin(angle) * speed, vfx.range(-0.4, 0.2), Math.cos(angle) * speed, vfx.range(0.18, 0.3), 0.07, 0.14, PALETTE.ice.hot, 0.55);
        }
        for (let n = this.due(slot, 14, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.b, 0.1, 0.75); vfx.glow(this.b.x, this.b.y, this.b.z, 0.16, 0.5, 'ice', 0.45, owner, 0.15); }
        vfx.gather(mouth.x, mouth.y, mouth.z, this.due(slot, 24, dt, 3), 0.7, 'ice', owner);
        return;
      }
      case 'howl-scout-flank-pounce': {
        // Leap streak: thin wind streaks trail the airborne body, powder snow falls away behind it.
        const body = this.body(slot, this.a), speed = vfx.range(2.5, 4.5);
        const dx = slot.target.x - body.x, dz = slot.target.z - body.z, len = Math.max(1e-3, Math.hypot(dx, dz));
        for (let n = this.due(slot, 90, dt); n > 0; n--) this.streak(owner, body.x + vfx.range(-0.4, 0.4), body.y + vfx.range(-0.2, 0.7), body.z + vfx.range(-0.4, 0.4), -dx / len * speed, vfx.range(-0.2, 0.4), -dz / len * speed, vfx.range(0.18, 0.32), 0.08, 0.09, PALETTE.wind.hot, 0.5);
        for (let n = this.due(slot, 28, dt, 2); n > 0; n--) vfx.smoke(body.x, body.y - 0.2, body.z, 1, 0.4, 0.1, 0.7, 0.8, SNOW, 0.3, owner, 0.4);
        vfx.glow(body.x, body.y + 0.3, body.z, 0.8, 0.1, 'wind', 0.18, owner);
        return;
      }
      case 'howl-scout-claw-rake': {
        // Preview of the rake: three claw lines of powder lift along the lane.
        for (let n = this.due(slot, 40, dt); n > 0; n--) { fp.toWorld((Math.floor(vfx.random() * 3) - 1) * fp.halfWidth * 0.55, -fp.halfLength + vfx.random() * fp.halfLength * 2 * (0.3 + 0.7 * t), this.b, 0.1); vfx.smoke(this.b.x, this.b.y, this.b.z, 1, 0.1, 0.2, 0.5, 0.6, SNOW, 0.34, owner, 0.2); }
        this.laneStreaks(slot, this.due(slot, 26, dt, 2), 0.9, 8);
        return;
      }
      case 'howl-scout-low-howl': {
        // The note at its peak: larger rings, wind rakes sideways across the band.
        const mouth = this.socketPosition(slot, this.a);
        for (let n = this.due(slot, 7, dt); n > 0; n--) this.ring(owner, mouth.x, mouth.y, mouth.z, 0.3, 1.5 + 0.8 * t, 0.45, 'wind', 0.45);
        this.sideStreaks(slot, this.due(slot, 40, dt, 2), 1.2);
        for (let n = this.due(slot, 20, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.b, 0.1, 0.85); vfx.smoke(this.b.x, this.b.y, this.b.z, 1, 0.15, 0.3, 0.6, 0.7, SNOW, 0.32, owner, 0.4); }
        return;
      }
      case 'chained-ruun-chain-pounce': {
        // Taut chains, sparks racing along them, a thick grit cloud at the paws as he gathers himself.
        this.driveChains(slot, 1);
        this.chainSparks(slot, this.due(slot, 40, dt), 'earth');
        const feet = this.feet(slot, this.a), y = this.groundY(slot);
        for (let n = this.due(slot, 30, dt, 2); n > 0; n--) vfx.smoke(feet.x, y, feet.z, 1, 1.2, 0.15, 1, 1, SAP_DUST, 0.34, owner, 1.2);
        vfx.glow(feet.x, y + 0.6, feet.z, 1.2, 0.1, 'earth', 0.16, owner);
        return;
      }
      case 'chained-ruun-howl-shockwave': {
        // The full note: a ring every beat of the held howl, chains singing, black-sap motes pouring into the ground mark.
        const mouth = this.socketPosition(slot, this.a);
        this.driveChains(slot, 1);
        for (let n = this.due(slot, 6, dt); n > 0; n--) this.ring(owner, mouth.x, mouth.y, mouth.z, 0.4, 2.2 + 0.8 * t, 0.5, 'sap', 0.5);
        this.chainSparks(slot, this.due(slot, 30, dt, 2), 'earth');
        for (let n = this.due(slot, 40, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.b, 0.1, 0.85); vfx.glow(this.b.x, this.b.y, this.b.z, 0.16, 0.45, 'sap', 0.5, owner, 0.3); }
        return;
      }
      case 'chained-ruun-breaking-ice': {
        // The crack runs out: light-lines and frost race along the band, steam breathes up out of the ground.
        this.sideStreaks(slot, this.due(slot, 44, dt), 1);
        for (let n = this.due(slot, 20, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.b, 0.05, 0.85); vfx.smoke(this.b.x, this.b.y, this.b.z, 1, 0.15, 0.3, 0.7, 0.8, FROST_FOG, 0.28, owner, 0.3); }
        for (let n = this.due(slot, 14, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.b, 0.05, 0.85); vfx.glow(this.b.x, this.b.y, this.b.z, 0.14, 0.45, 'ice', 0.5, owner, 0.15); }
        return;
      }
    }
  }

  // ---- active ----

  private detonate(slot: KitSlot, seconds: number): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint, time = vfx.time, kit = slot.kit as MoonpineKitId;
    const center = this.center(fp, this.c), r = Math.min(fp.halfWidth, fp.halfLength);
    switch (kit) {
      case 'frostfang-pack-rush': {
        // The rush: two frost crescents flank the lane, the whole lane streaks (see updateActive for the body trail).
        const life = Math.max(0.2, Math.min(0.5, seconds));
        for (let i = 0; i < 2; i++) {
          fp.toWorld(0, -fp.halfLength, this.a, 0.55 + i * 0.3); fp.toWorld(0, fp.halfLength + 0.4, this.b, 0.55 + i * 0.3);
          vfx.blades.spawn(this.a, this.b, fp.halfWidth * 2 * (1.15 - i * 0.2), fp.angle, time + i * life * 0.12, life, owner, 'ice');
        }
        vfx.ground.spawn('shock', fp, 'ice', owner, time, 0.36);
        vfx.ground.spawn('decal', fp, 'ice', owner, time, 4, 1, slot.glow);
        this.laneStreaks(slot, vfx.count(34), 1, 24);
        fp.toWorld(0, -fp.halfLength + 0.5, this.a, 0.1);
        vfx.dustRing(this.a.x, fp.cy, this.a.z, Math.min(fp.halfWidth, 0.9), 14, owner, SNOW);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'frostfang-ice-bite': {
        // Bite: a bright frost streak along the whole lane, the fang flash at its tip, shards flicked off the jaws.
        const life = Math.max(0.12, Math.min(0.3, seconds));
        slot.beam = vfx.beams.acquire(owner, time, 0, 0.42, 0.02, 'ice');
        if (slot.beam) {
          fp.toWorld(0, -fp.halfLength, slot.beam.a, 0.55); fp.toWorld(0, fp.halfLength, slot.beam.b, 0.55);
          slot.beam.alpha = 0.9;
        }
        vfx.ground.spawn('shock', fp, 'ice', owner, time, 0.3);
        vfx.ground.spawn('decal', fp, 'ice', owner, time, 3.5, 1, slot.glow);
        this.laneStreaks(slot, vfx.count(30), 1, 28);
        fp.toWorld(0, fp.halfLength - 0.5, this.a, 0.5);
        vfx.flash(this.a.x, this.a.y, this.a.z, 1.4, 'ice', owner, life);
        this.starGlint(slot, this.a, 0.9, life * 1.4, 'ice');
        vfx.shards(this.a.x, this.a.y, this.a.z, 10, 4, owner);
        vfx.sparks(this.a.x, this.a.y, this.a.z, 12, 5, 'ice', owner, 0.3);
        fp.toWorld(0, fp.halfLength - 0.6, this.b);
        vfx.dustRing(this.b.x, fp.cy, this.b.z, Math.min(fp.halfWidth, 0.6), 12, owner, SNOW);
        this.shake(this.b, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'frostfang-frost-breath': {
        // The breath: ice crystals shoot up across the cone, frost clouds roll out of the muzzle, shards and a cold shock fill the sector.
        const spikes = vfx.reducedEffects ? 5 : 12, life = Math.max(1.3, seconds + 0.8);
        for (let i = 0; i < spikes; i++) {
          fp.sample(vfx.random(), vfx.random(), this.a, 0, 0.82);
          vfx.spikes.spawn(this.a.x, fp.cy - 0.05, this.a.z, vfx.range(0.6, 1.3), vfx.range(0.1, 0.2), vfx.range(-0.28, 0.28), vfx.range(-0.28, 0.28), time + i * 0.014, life, owner);
        }
        vfx.flash(center.x, center.y + 0.7, center.z, r * 2, 'ice', owner, 0.22);
        vfx.ground.spawn('shock', fp, 'ice', owner, time, 0.42);
        vfx.ground.spawn('decal', fp, 'ice', owner, time, 5, 1, slot.glow);
        for (let i = vfx.count(14); i > 0; i--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.1, 0.8); vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.2, 0.3, 1.5, 1.6, FROST_FOG, 0.4, owner, 0.8); }
        vfx.shards(center.x, center.y + 0.4, center.z, 28, 4.5, owner);
        vfx.chunks(center.x, center.y + 0.1, center.z, 5, 3.2, 0.14, owner, true, fp);
        vfx.lights.pulse(center.x, center.y + 1.2, center.z, PALETTE.ice.hot, 5, 7, 0.5, time, owner);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'howl-scout-flank-pounce': {
        // Landing: a wide ring of powder snow, kicked crust, a shock decal and a wind flash.
        vfx.flash(center.x, center.y + 0.5, center.z, r * 2.2, 'wind', owner, 0.2);
        vfx.ground.spawn('shock', fp, 'wind', owner, time, 0.4);
        vfx.ground.spawn('decal', fp, 'wind', owner, time, 4.5, 1, slot.glow);
        vfx.chunks(center.x, center.y + 0.1, center.z, 10, 4.2, 0.18, owner, true, fp);
        vfx.dustRing(center.x, center.y, center.z, r, 26, owner, SNOW);
        vfx.smoke(center.x, center.y + 0.2, center.z, 10, r * 0.7, 0.5, 1.3, 1.3, SNOW, 0.45, owner, 1.1);
        vfx.sparks(center.x, center.y + 0.2, center.z, 14, 4.4, 'wind', owner, 0.6);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'howl-scout-claw-rake': {
        // Three claw crescents rake the lane one after another; powder is thrown along their lines.
        const life = Math.max(0.2, Math.min(0.4, seconds));
        for (let i = 0; i < 3; i++) {
          const lateral = (i - 1) * fp.halfWidth * 0.55;
          fp.toWorld(lateral, -fp.halfLength, this.a, 0.55); fp.toWorld(lateral, fp.halfLength + 0.3, this.b, 0.55);
          vfx.blades.spawn(this.a, this.b, fp.halfWidth * 0.8, fp.angle, time + i * 0.05, life, owner, 'wind');
        }
        vfx.ground.spawn('shock', fp, 'wind', owner, time, 0.34);
        vfx.ground.spawn('decal', fp, 'wind', owner, time, 4, 1, slot.glow);
        for (let i = 0; i < 6; i++) { fp.toWorld(((i % 3) - 1) * fp.halfWidth * 0.55, -fp.halfLength + (i / 5) * 2 * fp.halfLength * 0.9, this.a, 0.15); vfx.smoke(this.a.x, this.a.y, this.a.z, 2, 0.2, 0.4, 0.7, 0.8, SNOW, 0.4, owner, 0.6); }
        vfx.chunks(center.x, center.y + 0.05, center.z, 5, 3, 0.12, owner, true, fp);
        this.laneStreaks(slot, vfx.count(24), 1, 18);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'howl-scout-low-howl': {
        // The shockwave: three wind crescents roll across the band, rings spread from the muzzle, powder rides them.
        const life = Math.max(0.32, Math.min(0.6, seconds)), mouth = this.socketPosition(slot, this.d);
        for (let i = 0; i < 3; i++) {
          fp.toWorld(0, -fp.halfLength - 0.4, this.a, 0.3 + i * 0.12); fp.toWorld(0, fp.halfLength + 0.4, this.b, 0.3 + i * 0.12);
          vfx.blades.spawn(this.a, this.b, fp.halfWidth * 2 * (0.95 - i * 0.12), fp.angle, time + i * 0.07, life, owner, 'wind');
        }
        for (let i = 0; i < 3; i++) this.ring(owner, mouth.x, mouth.y, mouth.z, 0.5, 2.4 + i * 0.7, 0.45 + i * 0.1, 'wind', 0.45, i * 0.08);
        vfx.ground.spawn('shock', fp, 'wind', owner, time, 0.36);
        vfx.ground.spawn('decal', fp, 'wind', owner, time, 4);
        for (let i = 0; i < 10; i++) { fp.sample(vfx.random(), vfx.random(), this.a, 0.05); vfx.smoke(this.a.x, this.a.y, this.a.z, 2, 0.2, 0.5, 0.9, 0.9, SNOW, 0.4, owner, 0.5); }
        this.sideStreaks(slot, vfx.count(24), 1.6);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'chained-ruun-chain-pounce': {
        // Landing: wide shock, deep crack decal, heavy frozen clods, a thick dust ring and the chains snapping slack with a spray of sparks.
        vfx.flash(center.x, center.y + 0.6, center.z, r * 2.2, 'earth', owner, 0.24);
        vfx.ground.spawn('shock', fp, 'earth', owner, time, 0.48);
        vfx.ground.spawn('decal', fp, 'earth', owner, time, 6, 1, slot.glow);
        vfx.chunks(center.x, center.y + 0.1, center.z, 16, 5, 0.26, owner, false, fp);
        vfx.chunks(center.x, center.y + 0.1, center.z, 8, 4, 0.18, owner, true, fp);
        vfx.dustRing(center.x, center.y, center.z, r, 30, owner, SNOW);
        vfx.smoke(center.x, center.y + 0.2, center.z, 10, r * 0.7, 0.5, 1.4, 1.4, SAP_DUST, 0.5, owner, 1.2);
        vfx.sparks(center.x, center.y + 0.3, center.z, 22, 5, 'earth', owner, 0.7);
        vfx.lights.pulse(center.x, center.y + 1.2, center.z, PALETTE.earth.hot, 6, 8, 0.5, time, owner);
        this.drawChains(slot, 'earth', 0.05);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'chained-ruun-howl-shockwave': {
        // The burst: shock rings race out over the marked ground, a black-sap flash, powder and grit blown out, sparks off the chains.
        const mouth = this.socketPosition(slot, this.d);
        vfx.flash(center.x, center.y + 0.7, center.z, r * 1.2, 'sap', owner, 0.24);
        vfx.ground.spawn('shock', fp, 'sap', owner, time, 0.5);
        vfx.ground.spawn('shock', fp, 'sap', owner, time + 0.12, 0.45);
        vfx.ground.spawn('decal', fp, 'sap', owner, time, 5, 1, slot.glow);
        for (let i = 0; i < 3; i++) this.ring(owner, center.x, center.y + 0.15, center.z, r * 0.3, r * (1.2 + 0.25 * i), 0.5 + 0.1 * i, 'sap', 0.5, i * 0.1);
        for (let i = 0; i < 2; i++) this.ring(owner, mouth.x, mouth.y, mouth.z, 0.5, 3 + i, 0.5, 'sap', 0.45, i * 0.12);
        vfx.dustRing(center.x, center.y, center.z, r * 0.9, 26, owner, SNOW);
        vfx.smoke(center.x, center.y + 0.3, center.z, 10, r * 0.6, 0.5, 1.4, 1.4, SAP_DUST, 0.42, owner, 1.2);
        vfx.sparks(center.x, center.y + 0.3, center.z, 24, 5, 'sap', owner, 0.6);
        vfx.chunks(center.x, center.y + 0.1, center.z, 8, 3.8, 0.16, owner, true, fp);
        vfx.lights.pulse(center.x, center.y + 1.2, center.z, PALETTE.sap.hot, 6, 8, 0.5, time, owner);
        this.drawChains(slot, 'earth', 0.06);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'chained-ruun-breaking-ice': {
        // The ice splits: frost crescents sweep the band, ice crystals burst up along it, shards and steam fly (see updateActive for the head).
        const life = Math.max(0.32, Math.min(0.6, seconds)), spikes = vfx.reducedEffects ? 5 : 10;
        for (let i = 0; i < 3; i++) {
          fp.toWorld(0, -fp.halfLength - 0.4, this.a, 0.3 + i * 0.12); fp.toWorld(0, fp.halfLength + 0.4, this.b, 0.3 + i * 0.12);
          vfx.blades.spawn(this.a, this.b, fp.halfWidth * 2 * (0.95 - i * 0.12), fp.angle, time + i * 0.07, life, owner, 'ice');
        }
        for (let i = 0; i < spikes; i++) {
          fp.toWorld((i / (spikes - 1) - 0.5) * 2 * fp.halfWidth * 0.85, (vfx.random() - 0.5) * fp.halfLength * 1.2, this.a, 0);
          vfx.spikes.spawn(this.a.x, fp.cy - 0.05, this.a.z, vfx.range(0.7, 1.5), vfx.range(0.11, 0.22), vfx.range(-0.3, 0.3), vfx.range(-0.3, 0.3), time + i * 0.02, Math.max(1.3, seconds + 0.8), owner);
        }
        vfx.ground.spawn('shock', fp, 'ice', owner, time, 0.4);
        vfx.ground.spawn('decal', fp, 'ice', owner, time, 6, 1, slot.glow);
        for (let i = 0; i < 4; i++) { fp.toWorld((i / 3 - 0.5) * 2 * fp.halfWidth * 0.8, 0, this.a, 0.2); vfx.shards(this.a.x, this.a.y, this.a.z, 7, 4.2, owner); }
        vfx.chunks(center.x, center.y + 0.05, center.z, 8, 3.4, 0.16, owner, true, fp);
        for (let i = vfx.count(10); i > 0; i--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.1, 0.85); vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.2, 0.5, 1.1, 1.2, FROST_FOG, 0.38, owner, 0.6); }
        vfx.lights.pulse(center.x, center.y + 1.1, center.z, PALETTE.ice.hot, 5, 7, 0.5, time, owner);
        this.sideStreaks(slot, vfx.count(22), 1.4);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
    }
  }

  private updateActive(slot: KitSlot, t: number, dt: number): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint;
    switch (slot.kit as MoonpineKitId) {
      case 'frostfang-pack-rush': {
        // The tracker's own trail: frost streaks and powder snow behind the body, ice glints skating down the lane.
        const body = this.body(slot, this.a), feet = this.feet(slot, this.b);
        for (let n = this.due(slot, 80, dt); n > 0; n--) this.streak(owner, body.x + vfx.range(-0.4, 0.4), body.y + vfx.range(-0.3, 0.3), body.z + vfx.range(-0.4, 0.4), -fp.forwardX * vfx.range(5, 9), vfx.range(-0.2, 0.3), -fp.forwardZ * vfx.range(5, 9), vfx.range(0.2, 0.34), 0.08, 0.13, PALETTE.ice.hot, 0.5);
        for (let n = this.due(slot, 60, dt, 2); n > 0; n--) vfx.smoke(feet.x, fp.cy, feet.z, 1, 0.5, 0.2, 1, 0.9, SNOW, 0.4, owner, 1);
        for (let n = this.due(slot, 24, dt, 3); n > 0; n--) vfx.glow(feet.x + vfx.range(-0.3, 0.3), fp.cy + vfx.range(0.2, 0.8), feet.z + vfx.range(-0.3, 0.3), 0.12, 0.4, 'ice', 0.4, owner, 0.1);
        return;
      }
      case 'frostfang-ice-bite':
        if (slot.beam) slot.beam.alpha = Math.sin(Math.PI * Math.min(1, t * 1.02)) * 0.9 + 0.1;
        for (let n = this.due(slot, 40, dt); n > 0; n--) this.laneStreaks(slot, 1, 1, 26);
        return;
      case 'frostfang-frost-breath': {
        // Clouds of frost roll across the cone, glints and flung shards in them.
        for (let n = this.due(slot, 40, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.05, 0.85); vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.2, 0.3, 1.3, 1.3, FROST_FOG, 0.34, owner, 0.5); }
        for (let n = this.due(slot, 16, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.1, 0.8); vfx.glow(this.a.x, this.a.y, this.a.z, 0.14, 0.5, 'ice', 0.4, owner, 0.15); }
        for (let n = this.due(slot, 6, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.1, 0.7); vfx.sparks(this.a.x, this.a.y, this.a.z, 1, 2, 'ice', owner, 0.4); }
        return;
      }
      case 'howl-scout-flank-pounce':
        for (let n = this.due(slot, 8, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0, 0.8); vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.2, 0.4, 0.8, 1, SNOW, 0.33, owner, 0.3); }
        for (let n = this.due(slot, 8, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.05, 0.75); vfx.glow(this.a.x, this.a.y, this.a.z, 0.1, 0.7, 'wind', 0.4, owner, 0.3); }
        return;
      case 'howl-scout-claw-rake':
        for (let n = this.due(slot, 24, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.1, 0.85); vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.1, 0.4, 0.6, 0.7, SNOW, 0.34, owner, 0.4); }
        this.laneStreaks(slot, this.due(slot, 24, dt, 2), 1, 14);
        return;
      case 'howl-scout-low-howl': {
        // Powder streams across the band and the wave's head sheds snow.
        const head = this.sweepHead(slot, t, this.a);
        for (let n = this.due(slot, 60, dt); n > 0; n--) vfx.smoke(head.x, head.y, head.z, 1, 0.3, 0.3, 0.7, 0.7, SNOW, 0.36, owner, 0.6);
        this.sideStreaks(slot, this.due(slot, 40, dt, 2), 1.4);
        vfx.glow(head.x, head.y + 0.1, head.z, 0.9, 0.1, 'wind', 0.2, owner);
        return;
      }
      case 'chained-ruun-chain-pounce':
        this.driveChains(slot, 0.3 * (1 - t));
        for (let n = this.due(slot, 10, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0, 0.8); vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.2, 0.4, 0.9, 1.1, SAP_DUST, 0.34, owner, 0.3); }
        for (let n = this.due(slot, 8, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.05, 0.75); vfx.glow(this.a.x, this.a.y, this.a.z, 0.1, 0.8, 'earth', 0.4, owner, 0.35); }
        return;
      case 'chained-ruun-howl-shockwave':
        this.driveChains(slot, 0.4 * (1 - t));
        // Black-sap motes rise from the burst ground, dust drifts, glints of frozen ground.
        for (let n = this.due(slot, 16, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.05, 0.85); vfx.glow(this.a.x, this.a.y, this.a.z, 0.12, 0.8, 'sap', 0.4, owner, 0.5); }
        for (let n = this.due(slot, 10, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0, 0.8); vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.2, 0.4, 0.9, 1.1, SAP_DUST, 0.3, owner, 0.3); }
        return;
      case 'chained-ruun-breaking-ice': {
        // The sweep head travels across the band shedding shards and steam.
        const head = this.sweepHead(slot, t, this.a);
        for (let n = this.due(slot, 50, dt); n > 0; n--) vfx.smoke(head.x, head.y, head.z, 1, 0.3, 0.3, 0.8, 0.8, FROST_FOG, 0.36, owner, 0.5);
        for (let n = this.due(slot, 8, dt, 2); n > 0; n--) vfx.shards(head.x, head.y + 0.1, head.z, 1, 3, owner);
        for (let n = this.due(slot, 24, dt, 3); n > 0; n--) this.sideStreak(slot, head, 5, 0.25, PALETTE.ice.b, 0.45);
        vfx.glow(head.x, head.y + 0.1, head.z, 0.9, 0.1, 'ice', 0.22, owner);
        return;
      }
    }
  }

  // ---- decay ----

  private decay(slot: KitSlot): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint, center = this.center(fp, this.c), r = Math.min(fp.halfWidth, fp.halfLength);
    switch (slot.kit as MoonpineKitId) {
      case 'frostfang-pack-rush': {
        // Snow thrown up where the rush ends, kept inside the lane footprint.
        const radius = Math.min(fp.halfWidth, 1.1);
        fp.toWorld(0, Math.max(0, fp.halfLength - radius), this.a);
        slot.aux.set('disk', this.a.x, fp.cy, this.a.z, fp.angle, radius, radius);
        vfx.ground.spawn('shock', slot.aux, 'ice', owner, vfx.time, 0.4);
        vfx.ground.spawn('decal', slot.aux, 'ice', owner, vfx.time, 3.5);
        vfx.dustRing(this.a.x, fp.cy, this.a.z, radius, 20, owner, SNOW);
        vfx.shards(this.a.x, fp.cy + 0.2, this.a.z, 8, 3.4, owner);
        this.shake(this.a, 0.12);
        break;
      }
      case 'frostfang-ice-bite':
        for (let i = vfx.count(6); i > 0; i--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.5, 0.7); vfx.shards(this.a.x, this.a.y, this.a.z, 1, 1.4, owner); }
        break;
      case 'frostfang-frost-breath':
        vfx.smoke(center.x, center.y, center.z, 8, r * 0.7, 0.3, 1.5, 1.6, FROST_FOG, 0.24, owner, 0.6);
        break;
      case 'howl-scout-flank-pounce': case 'chained-ruun-chain-pounce':
        vfx.smoke(center.x, center.y, center.z, 6, r * 0.8, 0.4, 1, 1.4, slot.kit === 'chained-ruun-chain-pounce' ? SAP_DUST : SNOW, 0.3, owner, 0.3);
        break;
      case 'howl-scout-claw-rake':
        fp.toWorld(0, fp.halfLength, this.a, 0.3);
        vfx.smoke(this.a.x, this.a.y, this.a.z, 6, fp.halfWidth * 0.8, 0.3, 0.9, 1, SNOW, 0.3, owner, 0.5);
        break;
      case 'howl-scout-low-howl':
        fp.toWorld(0, fp.halfLength, this.a, 0.2);
        vfx.smoke(this.a.x, this.a.y, this.a.z, 6, r, 0.3, 1, 1.2, SNOW, 0.28, owner, 0.5);
        break;
      case 'chained-ruun-howl-shockwave':
        vfx.smoke(center.x, center.y, center.z, 8, r * 0.8, 0.35, 1.4, 1.6, SAP_DUST, 0.26, owner, 0.6);
        break;
      case 'chained-ruun-breaking-ice':
        vfx.smoke(center.x, center.y, center.z, 8, r, 0.35, 1.4, 1.6, FROST_FOG, 0.26, owner, 0.5);
        break;
    }
  }

  // ---- Ruun's chains ----

  /** Chain beams from Ruun's body to the four anchor posts, held until the cue ends. */
  private drawChains(slot: KitSlot, element: VfxElement, width: number): void {
    const beams: BeamSlot[] = [];
    for (const anchor of MOONPINE_CHAIN_ANCHORS) {
      const beam = this.vfx.beams.acquire(slot.owner, this.vfx.time, 0, width, 0.015, element);
      if (!beam) continue;
      beam.b.set(anchor.x, anchor.y + ANCHOR_HEIGHT, anchor.z);
      beams.push(beam);
    }
    this.chains.set(slot, beams);
    this.driveChains(slot, 0.5);
  }

  /** Keeps the chain starts on the drawn body and sets how taut (bright) they are. */
  private driveChains(slot: KitSlot, tension: number): void {
    const beams = this.chains.get(slot);
    if (!beams) return;
    const body = this.body(slot, this.d);
    for (const beam of beams) { beam.a.set(body.x, body.y + 0.6, body.z); beam.alpha = 0.25 + 0.55 * tension; }
  }

  private releaseChains(slot: KitSlot): void {
    const beams = this.chains.get(slot);
    if (!beams) return;
    for (const beam of beams) this.vfx.beams.release(beam);
    this.chains.delete(slot);
  }

  /** Metal sparks and glints sliding along the chain beams. */
  private chainSparks(slot: KitSlot, count: number, element: VfxElement): void {
    const beams = this.chains.get(slot), vfx = this.vfx;
    if (!beams || beams.length === 0) return;
    for (let i = count; i > 0; i--) {
      const beam = beams[Math.floor(vfx.random() * beams.length)]!;
      this.b.lerpVectors(beam.a, beam.b, vfx.random());
      vfx.glow(this.b.x, this.b.y, this.b.z, 0.14, 0.3, element, 0.5, slot.owner);
      if (vfx.random() < 0.3) vfx.sparks(this.b.x, this.b.y, this.b.z, 1, 2, element, slot.owner, 0.3);
    }
  }

  // ---- particle helpers ----

  /** Thin velocity-stretched additive streak (frost lines, leap trails, strike lines). */
  private streak(owner: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, width: number, stretch: number, color: Color, alpha: number): void {
    const vfx = this.vfx, p = vfx.spec();
    p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz; p.drag = 2; p.life = life; p.size0 = width; p.size1 = width * 0.4; p.frame = VFX_FRAME.spark; p.stretch = stretch;
    p.r0 = p.r1 = color.r; p.g0 = p.g1 = color.g; p.b0 = p.b1 = color.b; p.a0 = alpha; p.fadeIn = 0.15; p.fadeOut = 0.5;
    vfx.emit(vfx.particles.additive, owner);
  }

  /** Streaks racing along the lane (+Z in the footprint frame) at random lane positions, in the slot element's hot colour. */
  private laneStreaks(slot: KitSlot, count: number, reach: number, speed: number): void {
    const vfx = this.vfx, fp = slot.footprint, hot = PALETTE[slot.element].hot;
    for (let i = count; i > 0; i--) {
      fp.toWorld((vfx.random() - 0.5) * 2 * fp.halfWidth * 0.8, -fp.halfLength + vfx.random() * fp.halfLength * 2 * reach, this.b, vfx.range(0.15, 0.85));
      this.streak(slot.owner, this.b.x, this.b.y, this.b.z, fp.forwardX * speed, 0, fp.forwardZ * speed, vfx.range(0.18, 0.34), 0.07, 0.14, hot, 0.55);
    }
  }

  /** Streaks racing along the band (local +X) of a wave footprint. */
  private sideStreaks(slot: KitSlot, count: number, reach: number): void {
    const vfx = this.vfx, fp = slot.footprint, color = PALETTE[slot.element].hot;
    for (let i = count; i > 0; i--) {
      fp.toWorld(-fp.halfWidth * 0.9 + vfx.random() * fp.halfWidth * 1.8 * Math.min(1, reach), (vfx.random() - 0.5) * 2 * fp.halfLength * 0.8, this.b, vfx.range(0.1, 0.5));
      this.sideStreak(slot, this.b, vfx.range(5, 8), 0.2, color, 0.55);
    }
  }

  private sideStreak(slot: KitSlot, at: Vector3, speed: number, life: number, color: Color, alpha: number): void {
    const a = slot.footprint.angle;
    this.streak(slot.owner, at.x, at.y, at.z, Math.cos(a) * speed, 0, -Math.sin(a) * speed, life + this.vfx.random() * 0.12, 0.07, 0.14, color, alpha);
  }

  /** Four-point glint flare (fangs, frost glints). */
  private starGlint(slot: KitSlot, at: Vector3, size: number, life: number, element: VfxElement): void {
    const vfx = this.vfx, hot = PALETTE[element].hot, p = vfx.spec();
    p.x = at.x; p.y = at.y; p.z = at.z; p.life = life; p.size0 = size * 0.6; p.size1 = size; p.frame = VFX_FRAME.star; p.spin = vfx.random() * 6.28;
    p.r0 = p.r1 = hot.r; p.g0 = p.g1 = hot.g; p.b0 = p.b1 = hot.b; p.a0 = 0.8; p.fadeIn = 0.1; p.fadeOut = 0.6;
    vfx.emit(vfx.particles.additive, slot.owner);
  }

  /** An expanding ring sprite (howl pulses, shockwaves); `delay` schedules it for later. */
  private ring(owner: number, x: number, y: number, z: number, from: number, to: number, life: number, element: VfxElement, alpha: number, delay = 0): void {
    const vfx = this.vfx, hot = PALETTE[element].hot, p = vfx.spec();
    p.x = x; p.y = y; p.z = z; p.delay = delay; p.life = life; p.size0 = from; p.size1 = to; p.frame = VFX_FRAME.ring;
    p.r0 = p.r1 = hot.r; p.g0 = p.g1 = hot.g; p.b0 = p.b1 = hot.b; p.a0 = alpha; p.fadeIn = 0.05; p.fadeOut = 0.7;
    vfx.emit(vfx.particles.additive, owner);
  }

  /** Powder glints inside the telegraphed footprint during anticipation. */
  private groundDust(slot: KitSlot, t: number, dt: number, stream: 1 | 2 | 3 | 4, rate: number): void {
    const vfx = this.vfx, fp = slot.footprint, reach = 0.35 + 0.55 * t;
    for (let n = this.due(slot, rate, dt, stream); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * reach, this.b, 0.05, 0.8); vfx.smoke(this.b.x, this.b.y, this.b.z, 1, 0.15, 0.3, 0.6, 0.7, SNOW, 0.3, slot.owner, 0.2); }
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
    if (distance < SHAKE_RADIUS) this.impact?.shake(weight * (1 - distance / SHAKE_RADIUS), 0.32, 22);
  }

  /** Muzzle / head: the manifest `cast` socket, else the authored source point lifted to head height. */
  private socketPosition(slot: KitSlot, out: Vector3): Vector3 {
    if (slot.socket) { slot.socket.updateWorldMatrix(true, false); return slot.socket.getWorldPosition(out); }
    const from = slot.cue.from ?? slot.cue.position;
    return out.set(from?.x ?? 0, (from?.y ?? 0) + 0.9, from?.z ?? 0);
  }

  /** Drawn body: the rendered root, else the authored source point at chest height. */
  private body(slot: KitSlot, out: Vector3): Vector3 {
    const root = this.root(slot);
    if (root) { root.updateWorldMatrix(true, false); return root.getWorldPosition(out); }
    const from = slot.cue.from ?? slot.cue.position;
    return out.set(from?.x ?? 0, (from?.y ?? 0) + 0.8, from?.z ?? 0);
  }

  /** Horizontal position of the body with y at the simulation floor (snow, rings and ground effects stay on the ground). */
  private feet(slot: KitSlot, out: Vector3): Vector3 {
    const root = this.root(slot);
    if (root) { root.updateWorldMatrix(true, false); root.getWorldPosition(out); } else { const from = slot.cue.from ?? slot.cue.position; out.set(from?.x ?? 0, from?.y ?? 0, from?.z ?? 0); }
    out.y = this.groundY(slot);
    return out;
  }

  private groundY(slot: KitSlot): number { return slot.cue.from?.y ?? slot.footprint.cy; }
  private root(slot: KitSlot): Object3D | undefined { return slot.cue.actorId ? this.resolveSocket?.(slot.cue.actorId, 'root') : undefined; }

  /** Travelling head of a sweep across a wave band (local X from -0.9 to +0.9 of the half width). */
  private sweepHead(slot: KitSlot, t: number, out: Vector3): Vector3 {
    const fp = slot.footprint;
    return fp.toWorld((-0.9 + 1.8 * smooth(t)) * fp.halfWidth, 0, out, 0.2);
  }

  private center(fp: Footprint, out: Vector3): Vector3 {
    return fp.shape === 'sector' ? fp.toWorld(0, fp.halfLength * 0.5, out) : out.set(fp.cx, fp.cy, fp.cz);
  }
}

export function createMoonpineKits(vfx: VfxSystem, resolveSocket: SocketResolver | undefined, impact: ImpactSink | undefined, focus: FocusSource): MapKitFamily {
  return new MoonpineKits(vfx, resolveSocket, impact, focus);
}
