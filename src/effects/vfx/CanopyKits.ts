import { Color, Vector3, type Object3D } from 'three';
import type { Footprint } from './footprint.js';
import type { ImpactSink, KitSlot, SocketResolver } from './ElementKits.js';
import { LobbedRocksFx } from './LobbedRocksFx.js';
import { PALETTE, type VfxElement } from './palette.js';
import { VFX_FRAME } from './VfxAtlas.js';
import { VFX_COLORS, type VfxSystem } from './VfxSystem.js';

/** Whispering Canopy monster kits (attack id = kit id). Three phases like Greenwake: anticipation → commit → active, then decay. */
export const CANOPY_KIT_IDS = [
  'howler-rock-hurl', 'howler-leap-slam', 'howler-branch-sweep',
  'hornbill-dive-bomb', 'hornbill-feather-volley', 'hornbill-gale-flap',
  'viper-venom-spit', 'viper-tail-lash', 'viper-strike-lunge',
] as const;
export type CanopyKitId = typeof CANOPY_KIT_IDS[number];
const CANOPY_KITS: Readonly<Record<string, true>> = {
  'howler-rock-hurl': true, 'howler-leap-slam': true, 'howler-branch-sweep': true,
  'hornbill-dive-bomb': true, 'hornbill-feather-volley': true, 'hornbill-gale-flap': true,
  'viper-venom-spit': true, 'viper-tail-lash': true, 'viper-strike-lunge': true,
};
export const isCanopyKit = (kit: string): kit is CanopyKitId => CANOPY_KITS[kit] === true;

/** Player-focus view the kits need for proximity-scaled shake (the owning `CueKits`). */
export interface FocusSource { readonly focus: Vector3; readonly hasFocus: boolean }

const SHAKE_RADIUS = 6;
const SHAKE_WEIGHT: Readonly<Record<CanopyKitId, number>> = {
  'howler-rock-hurl': 0.2, 'howler-leap-slam': 0.28, 'howler-branch-sweep': 0.1,
  'hornbill-dive-bomb': 0.14, 'hornbill-feather-volley': 0.06, 'hornbill-gale-flap': 0.1,
  'viper-venom-spit': 0.06, 'viper-tail-lash': 0.1, 'viper-strike-lunge': 0.12,
};
/** Dart counts and the glowing storm-feather fan: darts keep a 32 m/s flight regardless of range. */
const DART_COUNT = 9;
const DART_SPEED = 32;
const ROCK_SIZE = 0.58;

// Alpha-blended tints (never HDR): storm-slate feathers, moss dust, black-sap venom slick.
const FEATHER_DARK = new Color().setRGB(0.1, 0.17, 0.3);
const FEATHER_LIGHT = new Color().setRGB(0.32, 0.5, 0.78);
const ROCK_DUST = new Color().setRGB(0.3, 0.25, 0.18);
export const VENOM = new Color().setRGB(0.22, 0.42, 0.08);
const SLICK = new Color().setRGB(0.1, 0.2, 0.05);
const BARK = new Color().setRGB(0.22, 0.15, 0.08);

const smooth = (t: number): number => { const x = t < 0 ? 0 : t > 1 ? 1 : t; return x * x * (3 - 2 * x); };
const clamp01 = (t: number): number => t < 0 ? 0 : t > 1 ? 1 : t;

/**
 * Presentation kits for the nine Canopy attacks. Every kit is a pure function of its cue (authored footprint, phase window,
 * socket bones) and the world clock, so pause, slow motion, hit-stop and cancellation behave like the Greenwake kits. All
 * emission goes through the shared particle pools / ground quads / debris; the only extra draw call is the instanced rock
 * of the Thornback Howler (`LobbedRocksFx`). Ground quads are only ever spawned from the cue footprint (or a shape inscribed
 * in it), so no hard-edged zone leaves the authored hazard.
 */
export class CanopyKits {
  readonly rocks = new LobbedRocksFx();
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly c = new Vector3();
  private readonly d = new Vector3();

  constructor(private readonly vfx: VfxSystem, private readonly resolveSocket: SocketResolver | undefined, private impact: ImpactSink | undefined, private readonly focus: FocusSource) {
    vfx.addModule(this.rocks);
  }

  setImpactSink(impact: ImpactSink | undefined): void { this.impact = impact; }

  begin(slot: KitSlot, seconds: number): void {
    const vfx = this.vfx, cue = slot.cue, phase = cue.phase;
    slot.rock = undefined;
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

  /** Releases manual resources (ground fill, beam, rock); a natural end of the active phase also emits the decay. */
  end(slot: KitSlot, natural: boolean): void {
    if (slot.ground) { this.vfx.ground.release(slot.ground); slot.ground = undefined; }
    if (slot.beam) { this.vfx.beams.release(slot.beam); slot.beam = undefined; }
    if (slot.rock) { this.rocks.release(slot.rock); slot.rock = undefined; }
    slot.socket = undefined;
    if (natural && slot.cue.phase === 'active') this.decay(slot);
  }

  // ---- begin ----

  private beginAnticipation(slot: KitSlot): void {
    const owner = slot.owner;
    switch (slot.kit as CanopyKitId) {
      case 'howler-rock-hurl':
        slot.rock = this.rocks.acquire(owner, this.vfx.random(), 0.2, 6);
        break;
      case 'howler-leap-slam': case 'viper-strike-lunge': case 'viper-tail-lash': {
        const feet = this.feet(slot, this.a);
        this.vfx.dustRing(feet.x, this.groundY(slot), feet.z, 0.7, 8, owner);
        break;
      }
      default: break;
    }
  }

  private beginCommit(slot: KitSlot): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint;
    switch (slot.kit as CanopyKitId) {
      case 'howler-rock-hurl':
        // The rock leaves the hand where it was held; the lob lands exactly when the active phase (the hazard) opens.
        slot.origin.y += 0.3;
        slot.rock = this.rocks.acquire(owner, vfx.random(), ROCK_SIZE, 7);
        if (slot.rock) this.rocks.place(slot.rock, slot.origin.x, slot.origin.y, slot.origin.z, ROCK_SIZE);
        vfx.sparks(slot.origin.x, slot.origin.y, slot.origin.z, 10, 3.5, 'sap', owner, 0.4);
        break;
      case 'howler-leap-slam': {
        // Take-off: dust ring, kicked clods and a flurry of leaves from the canopy floor.
        const feet = this.feet(slot, this.a), y = this.groundY(slot);
        vfx.dustRing(feet.x, y, feet.z, 1.1, 20, owner);
        vfx.chunks(feet.x, y + 0.05, feet.z, 5, 3.2, 0.18, owner);
        vfx.leaves(feet.x, y + 0.3, feet.z, 8, 0.9, 0, 0, owner);
        break;
      }
      case 'hornbill-dive-bomb': {
        // Downdraft at the lane start as the wings snap shut.
        fp.toWorld(0, -fp.halfLength, this.a);
        vfx.dustRing(this.a.x, fp.cy, this.a.z, 0.9, 14, owner);
        for (let i = vfx.count(6); i > 0; i--) this.feather(slot, this.body(slot, this.b), vfx.range(-1.5, 1.5), vfx.range(0.5, 1.6), vfx.range(-1.5, 1.5));
        break;
      }
      case 'hornbill-gale-flap': {
        // First downstroke: a ring of dust under the drawn body.
        const feet = this.feet(slot, this.a);
        vfx.dustRing(feet.x, fp.cy, feet.z, 1.4, 20, owner, ROCK_DUST);
        vfx.leaves(feet.x, fp.cy + 0.3, feet.z, 8, 1.2, 0, 0, owner);
        break;
      }
      case 'viper-venom-spit': {
        slot.origin.y += 0.05;
        vfx.bubbles(slot.origin.x, slot.origin.y, slot.origin.z, 8, 0.15, owner, 'poison');
        vfx.sparks(slot.origin.x, slot.origin.y, slot.origin.z, 6, 2.4, 'poison', owner, 0.5);
        break;
      }
      default: break;
    }
  }

  // ---- anticipation ----

  private updateAnticipation(slot: KitSlot, t: number, dt: number): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint;
    switch (slot.kit as CanopyKitId) {
      case 'howler-rock-hurl': {
        // The rock forms in the raised hand: sap pulls it together, tendrils of bubbles weep from it.
        const hold = this.socketPosition(slot, this.a);
        hold.y += 0.3;
        if (slot.rock) this.rocks.place(slot.rock, hold.x, hold.y, hold.z, 0.2 + (ROCK_SIZE - 0.2) * smooth(t * 1.2));
        vfx.gather(hold.x, hold.y, hold.z, this.due(slot, 30, dt), 0.75, 'sap', owner);
        for (let n = this.due(slot, 9, dt, 2); n > 0; n--) vfx.bubbles(hold.x, hold.y - 0.1, hold.z, 1, 0.22, owner, 'sap');
        for (let n = this.due(slot, 5, dt, 3); n > 0; n--) vfx.glow(hold.x, hold.y, hold.z, 0.7 + 0.4 * t, 0.3, 'sap', 0.3, owner);
        this.groundDust(slot, t, dt, 4, 8);
        return;
      }
      case 'howler-leap-slam': {
        // Crouch: dust sucks out from under the feet, the landing mark fills with settling grit.
        const feet = this.feet(slot, this.a), y = this.groundY(slot);
        for (let n = this.due(slot, 16 + 18 * t, dt); n > 0; n--) vfx.smoke(feet.x, y, feet.z, 1, 0.8, 0.12, 0.8, 0.9, VFX_COLORS.dust, 0.34, owner, 0.7);
        vfx.gather(feet.x, y + 0.5, feet.z, this.due(slot, 14, dt, 2), 1.1, 'earth', owner);
        for (let n = this.due(slot, 4, dt, 3); n > 0; n--) vfx.leaves(feet.x, y + 0.2, feet.z, 1, 0.7, 0, 0, owner);
        this.groundDust(slot, t, dt, 4, 8);
        return;
      }
      case 'howler-branch-sweep': {
        // A sap-bound branch is hauled back: leaves and bark chips gather, the band fills with stirred leaf litter.
        const hand = this.socketPosition(slot, this.a);
        for (let n = this.due(slot, 14, dt); n > 0; n--) vfx.leaves(hand.x, hand.y - 0.2, hand.z, 1, 0.5, 0, 0, owner);
        vfx.gather(hand.x, hand.y, hand.z, this.due(slot, 20, dt, 2), 0.8, 'spirit', owner);
        for (let n = this.due(slot, 14, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.05, 0.8); vfx.leaves(this.b.x, this.b.y, this.b.z, 1, 0.1, 0, 0, owner); }
        this.groundDust(slot, t, dt, 4, 6);
        return;
      }
      case 'hornbill-dive-bomb': {
        // Wings fold: wind is drawn in toward the body, loose storm feathers shake free, the lane starts to hiss.
        const body = this.body(slot, this.a);
        vfx.gather(body.x, body.y, body.z, this.due(slot, 36, dt), 1.3, 'wind', owner);
        for (let n = this.due(slot, 10, dt, 2); n > 0; n--) this.feather(slot, body, vfx.range(-1, 1), vfx.range(-0.2, 0.6), vfx.range(-1, 1));
        for (let n = this.due(slot, 5, dt, 3); n > 0; n--) vfx.glow(body.x, body.y, body.z, 0.8 + 0.5 * t, 0.3, 'lightning', 0.28, owner);
        this.laneStreaks(slot, this.due(slot, 8 + 12 * t, dt, 4), 0.35, 5);
        return;
      }
      case 'hornbill-feather-volley': {
        // The flight feathers lift and flare: a loose fan of feathers and blue glints around the socket.
        const hand = this.socketPosition(slot, this.a);
        for (let n = this.due(slot, 14, dt); n > 0; n--) this.feather(slot, hand, vfx.range(-1.4, 1.4) + fp.forwardX * 0.6, vfx.range(0.2, 1), vfx.range(-1.4, 1.4) + fp.forwardZ * 0.6);
        vfx.gather(hand.x, hand.y, hand.z, this.due(slot, 24, dt, 2), 1, 'lightning', owner);
        for (let n = this.due(slot, 6, dt, 3); n > 0; n--) vfx.glow(hand.x, hand.y, hand.z, 0.5 + 0.5 * t, 0.3, 'lightning', 0.3, owner);
        for (let n = this.due(slot, 10, dt, 4); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.1, 0.8); vfx.glow(this.b.x, this.b.y, this.b.z, 0.12, 0.5, 'lightning', 0.45, owner); }
        return;
      }
      case 'hornbill-gale-flap': {
        // Wings are raised: the air under the body churns, wind streaks start to rake the band.
        const feet = this.feet(slot, this.a), body = this.body(slot, this.b);
        vfx.gather(body.x, body.y, body.z, this.due(slot, 28, dt), 1.2, 'wind', owner);
        for (let n = this.due(slot, 14 + 16 * t, dt, 2); n > 0; n--) vfx.smoke(feet.x, fp.cy, feet.z, 1, 1.3, 0.1, 0.8, 0.9, VFX_COLORS.dust, 0.3, owner, 1.1);
        this.sideStreaks(slot, this.due(slot, 10 + 10 * t, dt, 3), 0.6);
        return;
      }
      case 'viper-venom-spit': {
        // Venom gathers behind the fangs: dense inward mist, droplets welling and dripping from the mouth.
        const mouth = this.socketPosition(slot, this.a);
        vfx.gather(mouth.x, mouth.y, mouth.z, this.due(slot, 44, dt), 0.6, 'poison', owner);
        for (let n = this.due(slot, 9, dt, 2); n > 0; n--) this.drip(slot, mouth.x, mouth.y - 0.05, mouth.z, 'poison', 0.07);
        for (let n = this.due(slot, 8, dt, 3); n > 0; n--) vfx.bubbles(mouth.x, mouth.y, mouth.z, 1, 0.14, owner, 'poison');
        for (let n = this.due(slot, 12, dt, 4); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.05, 0.8); vfx.smoke(this.b.x, this.b.y, this.b.z, 1, 0.2, 0.08, vfx.range(1.2, 1.8), 1.5, VENOM, 0.26, owner, 0.3); }
        return;
      }
      case 'viper-tail-lash': {
        // The long body coils low: dust circles the base, slick glints crawl along the band the tail will whip.
        const feet = this.feet(slot, this.a), y = this.groundY(slot);
        for (let n = this.due(slot, 12 + 14 * t, dt); n > 0; n--) vfx.smoke(feet.x, y, feet.z, 1, 1.2, 0.06, 0.8, 1, VFX_COLORS.dust, 0.3, owner, 0.9);
        for (let n = this.due(slot, 10, dt, 2); n > 0; n--) this.drip(slot, feet.x + vfx.range(-0.8, 0.8), y + 0.7, feet.z + vfx.range(-0.8, 0.8), 'poison', 0.06);
        for (let n = this.due(slot, 16, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.05, 0.85); vfx.glow(this.b.x, this.b.y, this.b.z, 0.14, 0.6, 'poison', 0.4, owner); }
        this.sideStreaks(slot, this.due(slot, 6, dt, 4), 0.4);
        return;
      }
      case 'viper-strike-lunge': {
        // Rears back: venom beads at the fangs, a thin hiss of mist and a pale fang glint that tightens before the strike.
        const mouth = this.socketPosition(slot, this.a);
        for (let n = this.due(slot, 10, dt); n > 0; n--) this.drip(slot, mouth.x, mouth.y - 0.05, mouth.z, 'poison', 0.06);
        vfx.gather(mouth.x, mouth.y, mouth.z, this.due(slot, 22, dt, 2), 0.5, 'poison', owner);
        for (let n = this.due(slot, 5, dt, 3); n > 0; n--) this.starGlint(slot, mouth, 0.2 + 0.25 * t, 0.2, 'poison');
        this.laneStreaks(slot, this.due(slot, 6 + 10 * t, dt, 4), 0.3, 6);
        return;
      }
    }
  }

  // ---- commit ----

  private updateCommit(slot: KitSlot, t: number, dt: number): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint;
    switch (slot.kit as CanopyKitId) {
      case 'howler-rock-hurl': {
        const head = this.lob(slot.origin, this.landing(slot, this.d), t, this.a, 1);
        if (slot.rock) this.rocks.place(slot.rock, head.x, head.y, head.z, ROCK_SIZE);
        for (let n = this.due(slot, 110, dt); n > 0; n--) vfx.glow(head.x + vfx.range(-0.12, 0.12), head.y + vfx.range(-0.12, 0.12), head.z + vfx.range(-0.12, 0.12), 0.55, 0.12, 'sap', 0.45, owner);
        for (let n = this.due(slot, 40, dt, 2); n > 0; n--) vfx.sparks(head.x, head.y, head.z, 1, 1.8, 'sap', owner, 0.2);
        for (let n = this.due(slot, 22, dt, 3); n > 0; n--) vfx.smoke(head.x, head.y, head.z, 1, 0.12, 0.05, 0.4, 0.5, ROCK_DUST, 0.35, owner, 0.1);
        for (let n = this.due(slot, 14, dt, 4); n > 0; n--) vfx.bubbles(head.x, head.y, head.z, 1, 0.2, owner, 'sap');
        return;
      }
      case 'howler-leap-slam': {
        // Leap streak: thin earth/sap streaks trail the airborne body, torn leaves and dust fall away behind it.
        const body = this.body(slot, this.a), speed = vfx.range(2.5, 4.5);
        const dx = slot.target.x - body.x, dz = slot.target.z - body.z, len = Math.max(1e-3, Math.hypot(dx, dz));
        for (let n = this.due(slot, 90, dt); n > 0; n--) this.streak(owner, body.x + vfx.range(-0.5, 0.5), body.y + vfx.range(-0.2, 0.9), body.z + vfx.range(-0.5, 0.5), -dx / len * speed, vfx.range(-0.2, 0.4), -dz / len * speed, vfx.range(0.18, 0.32), 0.09, 0.09, PALETTE.earth.hot, 0.55);
        for (let n = this.due(slot, 28, dt, 2); n > 0; n--) vfx.smoke(body.x, body.y - 0.2, body.z, 1, 0.4, 0.1, 0.8, 0.8, VFX_COLORS.dust, 0.3, owner, 0.4);
        for (let n = this.due(slot, 14, dt, 3); n > 0; n--) vfx.leaves(body.x, body.y, body.z, 1, 0.4, -dx / len * 2, -dz / len * 2, owner);
        vfx.glow(body.x, body.y + 0.3, body.z, 0.9, 0.1, 'sap', 0.18, owner);
        return;
      }
      case 'howler-branch-sweep': {
        // Preview of the sweep: leaves and bark lift along the band and stream sideways.
        for (let n = this.due(slot, 30, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.b, 0.1, 0.85); this.sideStreak(slot, this.b, 4 + 5 * t, 0.2, PALETTE.spirit.b, 0.4); }
        for (let n = this.due(slot, 16, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.b, 0.2, 0.85); vfx.leaves(this.b.x, this.b.y, this.b.z, 1, 0.1, Math.cos(fp.angle) * 2, -Math.sin(fp.angle) * 2, owner); }
        return;
      }
      case 'hornbill-dive-bomb': {
        // The bird tips into the dive: streaks pour down the lane ahead of it, feathers rip loose, dust skates ahead of the lane.
        const body = this.body(slot, this.a);
        this.laneStreaks(slot, this.due(slot, 44, dt), 0.9, 9);
        for (let n = this.due(slot, 20, dt, 2); n > 0; n--) this.feather(slot, body, -fp.forwardX * vfx.range(2, 4), vfx.range(-0.3, 0.5), -fp.forwardZ * vfx.range(2, 4));
        for (let n = this.due(slot, 20, dt, 3); n > 0; n--) { fp.toWorld((vfx.random() - 0.5) * fp.halfWidth * 1.4, -fp.halfLength + (vfx.random() * 0.5) * fp.halfLength * 2 * t, this.b, 0.05); vfx.smoke(this.b.x, this.b.y, this.b.z, 1, 0.2, 0.2, 0.8, 0.8, VFX_COLORS.dust, 0.34, owner, 0.6); }
        vfx.glow(body.x, body.y, body.z, 1 + t, 0.1, 'wind', 0.2, owner);
        return;
      }
      case 'hornbill-feather-volley': {
        // Darts nock: a fan of glowing heads brightens in front of the bird.
        const hand = this.socketPosition(slot, this.a), shown = Math.max(3, Math.round(DART_COUNT * (0.4 + 0.6 * t)));
        for (let n = this.due(slot, 60, dt); n > 0; n--) {
          const slotIndex = Math.floor(vfx.random() * shown), spread = (slotIndex + 0.5) / shown - 0.5, ang = fp.angle + spread * fp.aperture * 0.86;
          vfx.glow(hand.x + Math.sin(ang) * 0.9, hand.y - 0.05, hand.z + Math.cos(ang) * 0.9, 0.3 + 0.2 * t, 0.12, 'lightning', 0.5, owner);
        }
        for (let n = this.due(slot, 12, dt, 2); n > 0; n--) this.feather(slot, hand, fp.forwardX * 2 + vfx.range(-1, 1), vfx.range(0, 0.6), fp.forwardZ * 2 + vfx.range(-1, 1));
        return;
      }
      case 'hornbill-gale-flap': {
        // Downstroke: wind rakes sideways across the band, the downdraft throws leaves and dust.
        const feet = this.feet(slot, this.a);
        this.sideStreaks(slot, this.due(slot, 40, dt), 1.2);
        for (let n = this.due(slot, 22, dt, 2); n > 0; n--) vfx.smoke(feet.x, fp.cy, feet.z, 1, 1.5, 0.15, 0.9, 0.9, VFX_COLORS.dust, 0.34, owner, 1.4);
        for (let n = this.due(slot, 10, dt, 3); n > 0; n--) vfx.leaves(feet.x, fp.cy + 0.3, feet.z, 1, 1.2, fp.forwardX * 2.5, fp.forwardZ * 2.5, owner);
        return;
      }
      case 'viper-venom-spit': {
        // The venom glob and two trailing sub-globs fly in an arc from the mouth to the committed point.
        const aim = this.landing(slot, this.d);
        for (let k = 0; k < 3; k++) {
          const lag = clamp01(t - k * 0.09), head = this.lob(slot.origin, aim, lag, this.a, 0.8 - k * 0.1), size = k === 0 ? 0.5 : 0.34 - k * 0.04;
          for (let n = this.due(slot, k === 0 ? 100 : 60, dt, (k + 1) as 1 | 2 | 3); n > 0; n--) {
            vfx.glow(head.x, head.y, head.z, size, 0.1, 'poison', 0.55, owner);
            this.globCore(slot, head, size * 0.45);
          }
        }
        this.lob(slot.origin, aim, t, this.a, 0.8);
        for (let n = this.due(slot, 40, dt, 4); n > 0; n--) this.drip(slot, this.a.x + vfx.range(-0.1, 0.1), this.a.y - 0.05, this.a.z + vfx.range(-0.1, 0.1), 'poison', 0.05);
        return;
      }
      case 'viper-tail-lash': {
        // The tail whips up: slick droplets are flicked along the band and the base spins up dust.
        const feet = this.feet(slot, this.a), y = this.groundY(slot);
        for (let n = this.due(slot, 24 + 20 * t, dt); n > 0; n--) {
          fp.sample(vfx.random(), vfx.random(), this.b, 0.1, 0.85);
          const speed = 3 + 3 * t;
          this.dropSpec(owner, this.b.x, this.b.y, this.b.z, Math.cos(fp.angle) * speed, vfx.range(0.8, 2), -Math.sin(fp.angle) * speed, 'poison', 0.05, 0.5);
        }
        for (let n = this.due(slot, 24, dt, 2); n > 0; n--) vfx.smoke(feet.x, y, feet.z, 1, 1, 0.15, 0.8, 0.8, VFX_COLORS.dust, 0.34, owner, 1);
        this.sideStreaks(slot, this.due(slot, 16, dt, 3), 0.7);
        return;
      }
      case 'viper-strike-lunge': {
        // Strike line draws itself: fast streaks along the lane, venom beading at the fangs.
        const mouth = this.socketPosition(slot, this.a);
        this.laneStreaks(slot, this.due(slot, 70, dt), 1, 22);
        vfx.gather(mouth.x, mouth.y, mouth.z, this.due(slot, 30, dt, 2), 0.5, 'poison', owner);
        for (let n = this.due(slot, 8, dt, 3); n > 0; n--) this.starGlint(slot, mouth, 0.3 + 0.3 * t, 0.15, 'poison');
        return;
      }
    }
  }

  // ---- active ----

  private detonate(slot: KitSlot, seconds: number): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint, time = vfx.time, kit = slot.kit as CanopyKitId;
    const center = this.center(fp, this.c);
    switch (kit) {
      case 'howler-rock-hurl': {
        // Rock shatters on the committed mark: shock, scorched/cracked decal, clods, sap splatter, dust.
        const r = Math.min(fp.halfWidth, fp.halfLength);
        vfx.flash(center.x, center.y + 0.5, center.z, r * 2.2, 'earth', owner, 0.2);
        vfx.ground.spawn('shock', fp, 'earth', owner, time, 0.42);
        vfx.ground.spawn('decal', fp, 'earth', owner, time, 5.5, 1, slot.glow);
        vfx.chunks(center.x, center.y + 0.1, center.z, 14, 4.6, 0.24, owner, false, fp);
        vfx.dustRing(center.x, center.y, center.z, r * 0.9, 24, owner, ROCK_DUST);
        vfx.sparks(center.x, center.y + 0.2, center.z, 28, 5.2, 'sap', owner, 0.7);
        vfx.bubbles(center.x, center.y, center.z, 14, r * 0.8, owner, 'sap');
        vfx.smoke(center.x, center.y + 0.2, center.z, 8, r * 0.6, 0.4, 1.1, 1.2, ROCK_DUST, 0.45, owner, 0.9);
        vfx.lights.pulse(center.x, center.y + 1.1, center.z, PALETTE.sap.hot, 5, 7, 0.5, time, owner);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'howler-leap-slam': {
        // Landing slam: wide shock, deep decal crack, heavy clods and a thick dust ring.
        const r = Math.min(fp.halfWidth, fp.halfLength);
        vfx.flash(center.x, center.y + 0.6, center.z, r * 2.2, 'earth', owner, 0.22);
        vfx.ground.spawn('shock', fp, 'earth', owner, time, 0.46);
        vfx.ground.spawn('decal', fp, 'earth', owner, time, 6, 1, slot.glow);
        vfx.chunks(center.x, center.y + 0.1, center.z, 18, 5, 0.26, owner, false, fp);
        vfx.dustRing(center.x, center.y, center.z, r, 30, owner, ROCK_DUST);
        vfx.sparks(center.x, center.y + 0.2, center.z, 26, 4.8, 'sap', owner, 0.7);
        vfx.smoke(center.x, center.y + 0.2, center.z, 10, r * 0.7, 0.5, 1.3, 1.4, ROCK_DUST, 0.5, owner, 1.2);
        vfx.leaves(center.x, center.y + 0.3, center.z, 12, r * 0.8, 0, 0, owner);
        vfx.lights.pulse(center.x, center.y + 1.2, center.z, PALETTE.earth.hot, 6, 8, 0.5, time, owner);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'howler-branch-sweep': {
        // The branch lashes across the band: scuffed decal, a burst of leaves and bark, then a sweeping head (see updateActive).
        vfx.ground.spawn('shock', fp, 'wind', owner, time, 0.38);
        vfx.ground.spawn('decal', fp, 'earth', owner, time, 4, 1, slot.glow);
        for (let i = 0; i < 6; i++) { fp.toWorld((i / 5 - 0.5) * 2 * fp.halfWidth * 0.85, 0, this.a, 0.15); vfx.leaves(this.a.x, this.a.y, this.a.z, 3, 0.25, Math.cos(fp.angle) * 5, -Math.sin(fp.angle) * 5, owner); }
        vfx.chunks(center.x, center.y + 0.05, center.z, 6, 3.2, 0.14, owner, false, fp);
        this.sideStreaks(slot, vfx.count(26), 1.4);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'hornbill-dive-bomb': {
        // The bird tears down the lane: two wind crescents flank it, the whole lane streaks (see updateActive for the body trail).
        const life = Math.max(0.2, Math.min(0.5, seconds));
        for (let i = 0; i < 2; i++) {
          fp.toWorld(0, -fp.halfLength, this.a, 0.55 + i * 0.35); fp.toWorld(0, fp.halfLength + 0.4, this.b, 0.55 + i * 0.35);
          vfx.blades.spawn(this.a, this.b, fp.halfWidth * 2 * (1.15 - i * 0.2), fp.angle, time + i * life * 0.12, life, owner, 'wind');
        }
        vfx.ground.spawn('shock', fp, 'wind', owner, time, 0.36);
        this.laneStreaks(slot, vfx.count(34), 1, 26);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'hornbill-feather-volley': this.fireDarts(slot); break;
      case 'hornbill-gale-flap': {
        // Wingbeat gale: three wind crescents roll across the band, leaves and dust ride them.
        const life = Math.max(0.32, Math.min(0.6, seconds));
        for (let i = 0; i < 3; i++) {
          fp.toWorld(0, -fp.halfLength - 0.4, this.a, 0.3 + i * 0.12); fp.toWorld(0, fp.halfLength + 0.4, this.b, 0.3 + i * 0.12);
          vfx.blades.spawn(this.a, this.b, fp.halfWidth * 2 * (0.95 - i * 0.12), fp.angle, time + i * 0.07, life, owner, 'wind');
        }
        vfx.ground.spawn('shock', fp, 'wind', owner, time, 0.36);
        vfx.ground.spawn('decal', fp, 'wind', owner, time, 4);
        for (let i = 0; i < 10; i++) { fp.sample(vfx.random(), vfx.random(), this.a, 0.05); vfx.smoke(this.a.x, this.a.y, this.a.z, 2, 0.2, 0.5, 0.8, 0.9, VFX_COLORS.dust, 0.4, owner, 0.4); }
        fp.toWorld(0, 0, this.a, 0.2);
        vfx.leaves(this.a.x, this.a.y, this.a.z, 20, fp.halfWidth * 0.8, fp.forwardX * 3.4, fp.forwardZ * 3.4, owner);
        this.sideStreaks(slot, vfx.count(24), 1.6);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'viper-venom-spit': {
        // Splash: droplets radiate and fall back into a bubbling pool that lingers for the whole active window.
        const r = Math.min(fp.halfWidth, fp.halfLength);
        vfx.flash(center.x, center.y + 0.3, center.z, r * 1.3, 'poison', owner, 0.18);
        vfx.ground.spawn('shock', fp, 'poison', owner, time, 0.42);
        vfx.ground.spawn('decal', fp, 'poison', owner, time, seconds + 4, 1, slot.glow);
        slot.ground = vfx.ground.spawn('burn', fp, 'poison', owner, time, 0, 0.3);
        for (let i = vfx.count(26); i > 0; i--) {
          const ang = vfx.random() * Math.PI * 2, speed = r * vfx.range(1.2, 2.6), up = vfx.range(2.5, 5.5);
          this.dropSpec(owner, center.x, center.y + 0.1, center.z, Math.cos(ang) * speed, up, Math.sin(ang) * speed, 'poison', vfx.range(0.06, 0.12), vfx.range(0.5, 0.8));
        }
        vfx.smoke(center.x, center.y, center.z, 16, r * 0.7, 0.25, 1.8, 1.9, VENOM, 0.45, owner, 1.2);
        vfx.bubbles(center.x, center.y, center.z, 18, r * 0.75, owner, 'poison');
        vfx.lights.pulse(center.x, center.y + 0.8, center.z, PALETTE.poison.hot, 4, 6, 0.45, time, owner);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'viper-tail-lash': {
        // The tail whips across the band leaving a venom slick; blades of slick sweep through it (and see updateActive).
        const life = Math.max(0.2, Math.min(0.45, seconds));
        fp.toWorld(0, -fp.halfLength - 0.3, this.a, 0.12); fp.toWorld(0, fp.halfLength + 0.3, this.b, 0.12);
        vfx.blades.spawn(this.a, this.b, fp.halfWidth * 2 * 0.9, fp.angle, time, life, owner, 'poison');
        vfx.ground.spawn('shock', fp, 'poison', owner, time, 0.38);
        vfx.ground.spawn('decal', fp, 'poison', owner, time, 5, 1, slot.glow);
        slot.ground = vfx.ground.spawn('burn', fp, 'poison', owner, time, 0, 0.25);
        for (let i = 0; i < 6; i++) { fp.toWorld((i / 5 - 0.5) * 2 * fp.halfWidth * 0.85, 0, this.a, 0.1); vfx.bubbles(this.a.x, this.a.y, this.a.z, 2, 0.2, owner, 'poison'); }
        this.sideStreaks(slot, vfx.count(18), 1.2);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'viper-strike-lunge': {
        // Strike: a bright streak along the whole lane, fang flash at its tip, venom flicked off the fangs.
        const life = Math.max(0.12, Math.min(0.3, seconds));
        slot.beam = vfx.beams.acquire(owner, time, 0, 0.42, 0.02, 'poison');
        if (slot.beam) {
          fp.toWorld(0, -fp.halfLength, slot.beam.a, 0.55); fp.toWorld(0, fp.halfLength, slot.beam.b, 0.55);
          slot.beam.alpha = 0.9;
        }
        this.laneStreaks(slot, vfx.count(30), 1, 30);
        fp.toWorld(0, fp.halfLength - 0.5, this.a, 0.5);
        vfx.flash(this.a.x, this.a.y, this.a.z, 1.4, 'poison', owner, life);
        this.starGlint(slot, this.a, 0.9, life * 1.4, 'poison');
        vfx.sparks(this.a.x, this.a.y, this.a.z, 14, 5, 'poison', owner, 0.3);
        for (let i = vfx.count(8); i > 0; i--) this.dropSpec(owner, this.a.x, this.a.y, this.a.z, fp.forwardX * vfx.range(2, 5) + vfx.range(-1, 1), vfx.range(0.5, 2.5), fp.forwardZ * vfx.range(2, 5) + vfx.range(-1, 1), 'poison', 0.07, 0.5);
        fp.toWorld(0, fp.halfLength - 0.6, this.b);
        vfx.dustRing(this.b.x, fp.cy, this.b.z, Math.min(fp.halfWidth, 0.6), 12, owner);
        this.shake(this.b, SHAKE_WEIGHT[kit]);
        break;
      }
    }
  }

  private updateActive(slot: KitSlot, t: number, dt: number): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint, envelope = Math.min(1, t * 8) * Math.min(1, (1 - t) * 4);
    switch (slot.kit as CanopyKitId) {
      case 'howler-rock-hurl': case 'howler-leap-slam':
        for (let n = this.due(slot, 8, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0, 0.8); vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.2, 0.4, 0.8, 1, ROCK_DUST, 0.33, owner, 0.3); }
        for (let n = this.due(slot, 8, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.05, 0.75); vfx.glow(this.a.x, this.a.y, this.a.z, 0.1, 0.8, 'sap', 0.4, owner, 0.35); }
        return;
      case 'howler-branch-sweep': {
        // The sweep head travels across the band: leaves, bark and wind streaks shed from it.
        const head = this.sweepHead(slot, t, this.a);
        for (let n = this.due(slot, 110, dt); n > 0; n--) vfx.leaves(head.x, head.y, head.z, 1, 0.35, Math.cos(fp.angle) * 6, -Math.sin(fp.angle) * 6, owner);
        for (let n = this.due(slot, 50, dt, 2); n > 0; n--) vfx.smoke(head.x, head.y, head.z, 1, 0.3, 0.2, 0.7, 0.7, VFX_COLORS.dust, 0.36, owner, 0.5);
        for (let n = this.due(slot, 24, dt, 3); n > 0; n--) this.dropSpec(owner, head.x, head.y, head.z, vfx.range(-1, 1) + Math.cos(fp.angle) * 3, vfx.range(1, 2.4), vfx.range(-1, 1) - Math.sin(fp.angle) * 3, 'sap', 0.05, 0.6, BARK);
        vfx.glow(head.x, head.y + 0.1, head.z, 1, 0.1, 'spirit', 0.22, owner);
        return;
      }
      case 'hornbill-dive-bomb': {
        // The bird's own trail: streaks and feathers behind the drawn body, dust skating along the lane below it.
        const body = this.body(slot, this.a), feet = this.feet(slot, this.b);
        for (let n = this.due(slot, 90, dt); n > 0; n--) this.streak(owner, body.x + vfx.range(-0.5, 0.5), body.y + vfx.range(-0.3, 0.4), body.z + vfx.range(-0.5, 0.5), -fp.forwardX * vfx.range(5, 9), vfx.range(-0.2, 0.3), -fp.forwardZ * vfx.range(5, 9), vfx.range(0.2, 0.36), 0.08, 0.13, PALETTE.wind.hot, 0.55);
        for (let n = this.due(slot, 30, dt, 2); n > 0; n--) this.feather(slot, body, -fp.forwardX * vfx.range(1, 3.5) + vfx.range(-1, 1), vfx.range(-0.3, 0.6), -fp.forwardZ * vfx.range(1, 3.5) + vfx.range(-1, 1));
        for (let n = this.due(slot, 60, dt, 3); n > 0; n--) vfx.smoke(feet.x, fp.cy, feet.z, 1, 0.5, 0.2, 0.9, 0.9, VFX_COLORS.dust, 0.4, owner, 0.9);
        for (let n = this.due(slot, 8, dt, 4); n > 0; n--) vfx.glow(body.x, body.y, body.z, 0.7, 0.12, 'lightning', 0.3, owner);
        return;
      }
      case 'hornbill-feather-volley':
        for (let n = this.due(slot, 14, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.5 + vfx.random(), 0.75); this.feather(slot, this.a, vfx.range(-0.4, 0.4), vfx.range(-0.2, 0.2), vfx.range(-0.4, 0.4)); }
        return;
      case 'hornbill-gale-flap':
        for (let n = this.due(slot, 24, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.1); vfx.leaves(this.a.x, this.a.y, this.a.z, 1, 0.2, fp.forwardX * 3, fp.forwardZ * 3, owner); }
        this.sideStreaks(slot, this.due(slot, 40, dt, 2), 1.4);
        return;
      case 'viper-venom-spit':
        // Bubbling pool: soft rising venom smoke, popping bubbles and the odd droplet fountaining out of the surface.
        if (slot.ground) vfx.ground.drive(slot.ground, 1, 0.3, Math.min(1, t * 20) * Math.min(1, (1 - t) * 10));
        for (let n = this.due(slot, 14, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.05, 0.75); vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.3, 0.12, vfx.range(1.6, 2.6), 2.2, VENOM, 0.36, owner, 0.25); }
        for (let n = this.due(slot, 24, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0, 0.8); vfx.bubbles(this.a.x, this.a.y, this.a.z, 1, 0.05, owner, 'poison'); }
        for (let n = this.due(slot, 6, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.05, 0.7); this.dropSpec(owner, this.a.x, this.a.y, this.a.z, vfx.range(-0.4, 0.4), vfx.range(1.4, 2.4), vfx.range(-0.4, 0.4), 'poison', 0.06, 0.6); }
        for (let n = this.due(slot, 5, dt, 4); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.1, 0.7); vfx.glow(this.a.x, this.a.y, this.a.z, 0.3, 0.7, 'poison', 0.25, owner, 0.2); }
        return;
      case 'viper-tail-lash': {
        // The slick sweep: a head crossing the band throwing droplets and venom haze, the sheen fading behind it.
        if (slot.ground) vfx.ground.drive(slot.ground, 1, 0.25, envelope);
        const head = this.sweepHead(slot, t, this.a);
        for (let n = this.due(slot, 90, dt); n > 0; n--) this.dropSpec(owner, head.x + vfx.range(-0.2, 0.2), head.y, head.z + vfx.range(-0.2, 0.2), Math.cos(fp.angle) * vfx.range(3, 6) + vfx.range(-0.5, 0.5), vfx.range(0.8, 2.6), -Math.sin(fp.angle) * vfx.range(3, 6) + vfx.range(-0.5, 0.5), 'poison', 0.05, 0.5);
        for (let n = this.due(slot, 40, dt, 2); n > 0; n--) vfx.smoke(head.x, head.y, head.z, 1, 0.3, 0.1, 0.8, 1, SLICK, 0.4, owner, 0.5);
        for (let n = this.due(slot, 24, dt, 3); n > 0; n--) this.sideStreak(slot, head, 5, 0.25, PALETTE.poison.b, 0.45);
        vfx.glow(head.x, head.y + 0.1, head.z, 0.9, 0.1, 'poison', 0.22, owner);
        return;
      }
      case 'viper-strike-lunge':
        if (slot.beam) slot.beam.alpha = Math.sin(Math.PI * Math.min(1, t * 1.02)) * 0.9 + 0.1;
        for (let n = this.due(slot, 40, dt); n > 0; n--) this.laneStreaks(slot, 1, 1, 30);
        return;
    }
  }

  // ---- decay ----

  private decay(slot: KitSlot): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint, center = this.center(fp, this.c), r = Math.min(fp.halfWidth, fp.halfLength);
    switch (slot.kit as CanopyKitId) {
      case 'howler-rock-hurl': case 'howler-leap-slam':
        vfx.smoke(center.x, center.y, center.z, 6, r * 0.8, 0.4, 1, 1.4, ROCK_DUST, 0.3, owner, 0.3);
        vfx.bubbles(center.x, center.y, center.z, 4, r * 0.7, owner, 'sap');
        break;
      case 'howler-branch-sweep':
        fp.toWorld(0, fp.halfLength, this.a, 0.3);
        vfx.leaves(this.a.x, this.a.y, this.a.z, 8, fp.halfWidth * 0.8, fp.forwardX * 1.5, fp.forwardZ * 1.5, owner);
        break;
      case 'hornbill-dive-bomb': {
        // Impact gust at the far end of the lane, kept inside the lane footprint.
        const radius = Math.min(fp.halfWidth, 1.1);
        fp.toWorld(0, Math.max(0, fp.halfLength - radius), this.a);
        slot.aux.set('disk', this.a.x, fp.cy, this.a.z, fp.angle, radius, radius);
        vfx.ground.spawn('shock', slot.aux, 'wind', owner, vfx.time, 0.4);
        vfx.ground.spawn('decal', slot.aux, 'wind', owner, vfx.time, 3.5);
        vfx.dustRing(this.a.x, fp.cy, this.a.z, radius, 20, owner, ROCK_DUST);
        vfx.leaves(this.a.x, fp.cy + 0.3, this.a.z, 10, radius, fp.forwardX * 3, fp.forwardZ * 3, owner);
        for (let i = vfx.count(8); i > 0; i--) this.feather(slot, this.a, vfx.range(-2, 2) + fp.forwardX * 2, vfx.range(1, 3), vfx.range(-2, 2) + fp.forwardZ * 2);
        this.shake(this.a, 0.16);
        break;
      }
      case 'hornbill-feather-volley':
        for (let i = vfx.count(10); i > 0; i--) { fp.sample(vfx.random(), vfx.random(), this.a, 1 + vfx.random() * 1.2, 0.75); this.feather(slot, this.a, vfx.range(-0.3, 0.3), vfx.range(-0.2, 0.1), vfx.range(-0.3, 0.3)); }
        vfx.smoke(center.x, center.y, center.z, 4, r * 0.6, 0.3, 1, 1.3, VFX_COLORS.dust, 0.22, owner, 0.4);
        break;
      case 'hornbill-gale-flap':
        fp.toWorld(0, fp.halfLength, this.a, 0.2);
        vfx.leaves(this.a.x, this.a.y, this.a.z, 6, r, fp.forwardX * 1.5, fp.forwardZ * 1.5, owner);
        break;
      case 'viper-venom-spit':
        vfx.smoke(center.x, center.y, center.z, 8, r * 0.8, 0.35, 2, 1.6, VENOM, 0.25, owner, 0.6);
        break;
      case 'viper-tail-lash':
        vfx.smoke(center.x, center.y, center.z, 6, r, 0.2, 1.4, 1.4, SLICK, 0.26, owner, 0.5);
        break;
      case 'viper-strike-lunge':
        for (let i = vfx.count(6); i > 0; i--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.5, 0.7); this.drip(slot, this.a.x, this.a.y, this.a.z, 'poison', 0.05); }
        break;
    }
  }

  // ---- fan of storm-feather darts ----

  /**
   * One burst of glowing darts spread across the cone. Every dart is a velocity-stretched streak with a bright head and a short
   * trail, each aimed at a landing point inside the sector; its impact (glint, ring, sparks, dust) is pre-scheduled with a
   * particle `delay` equal to the flight time, so nothing is emitted after the fact and pausing the world freezes darts mid-air.
   */
  private fireDarts(slot: KitSlot): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint, apex = this.socketPosition(slot, this.a);
    const count = vfx.count(DART_COUNT), hot = PALETTE.lightning.hot, body = PALETTE.lightning.b, wind = PALETTE.wind.b;
    const sx = apex.x, sy = apex.y, sz = apex.z;
    for (let i = 0; i < count; i++) {
      const frac = count === 1 ? 0.5 : i / (count - 1), ang = fp.angle + (frac - 0.5) * fp.aperture * 0.86;
      const range = fp.halfLength * (0.7 + 0.26 * ((i * 0.618) % 1));
      const lx = fp.cx + Math.sin(ang) * range, lz = fp.cz + Math.cos(ang) * range, ly = fp.cy + 0.12;
      const dx = lx - sx, dy = ly - sy, dz = lz - sz, dist = Math.hypot(dx, dy, dz), life = Math.max(0.1, dist / DART_SPEED);
      const vx = dx / life, vy = dy / life, vz = dz / life;
      const p = vfx.spec();
      // Dart body: a thin bright streak with a faint wide halo of wind.
      p.x = sx; p.y = sy; p.z = sz; p.vx = vx; p.vy = vy; p.vz = vz; p.life = life; p.size0 = p.size1 = 0.5; p.frame = VFX_FRAME.cut; p.stretch = 0.03;
      p.r0 = p.r1 = hot.r; p.g0 = p.g1 = hot.g; p.b0 = p.b1 = hot.b; p.a0 = 0.95; p.fadeIn = 0.05; p.fadeOut = 0.85;
      vfx.emit(vfx.particles.additive, owner);
      p.size0 = p.size1 = 0.36; p.frame = VFX_FRAME.glow; p.stretch = 0;
      p.r0 = p.r1 = body.r; p.g0 = p.g1 = body.g; p.b0 = p.b1 = body.b; p.a0 = 0.55;
      vfx.emit(vfx.particles.additive, owner);
      // Delayed copies fan a short trail behind the dart (all deterministic, no per-frame emission).
      for (let k = 1; k <= 3; k++) {
        p.delay = k * 0.022; p.size0 = p.size1 = 0.26 - k * 0.05; p.a0 = 0.4 - k * 0.08; p.r0 = p.r1 = wind.r; p.g0 = p.g1 = wind.g; p.b0 = p.b1 = wind.b;
        vfx.emit(vfx.particles.additive, owner);
      }
      p.delay = 0;
      // Impact, scheduled for the moment the dart arrives.
      this.dartImpact(slot, lx, ly, lz, life, i);
    }
    if (count > 0) {
      // Two shocks at the nearest/farthest darts keep the cone readable without exhausting the ground pool; both stay inside the sector.
      slot.aux.set('disk', fp.cx + fp.forwardX * fp.halfLength * 0.6, fp.cy, fp.cz + fp.forwardZ * fp.halfLength * 0.6, fp.angle, Math.min(fp.halfLength * 0.3, fp.halfWidth * 0.6), Math.min(fp.halfLength * 0.3, fp.halfWidth * 0.6));
      vfx.ground.spawn('shock', slot.aux, 'wind', owner, vfx.time + 0.1, 0.4);
      vfx.ground.spawn('decal', slot.aux, 'wind', owner, vfx.time + 0.1, 3.5);
    }
    vfx.flash(apex.x, apex.y, apex.z, 1.3, 'lightning', owner, 0.16);
    this.shake(this.center(fp, this.c), SHAKE_WEIGHT['hornbill-feather-volley']);
  }

  private dartImpact(slot: KitSlot, x: number, y: number, z: number, delay: number, index: number): void {
    const vfx = this.vfx, owner = slot.owner, hot = PALETTE.lightning.hot, body = PALETTE.lightning.b, p = vfx.spec();
    p.x = x; p.y = y + 0.1; p.z = z; p.delay = delay; p.life = 0.2; p.size0 = 0.3; p.size1 = 0.6; p.frame = VFX_FRAME.glow;
    p.r0 = p.r1 = body.r; p.g0 = p.g1 = body.g; p.b0 = p.b1 = body.b; p.a0 = 0.6; p.fadeIn = 0.1; p.fadeOut = 0.6;
    vfx.emit(vfx.particles.additive, owner);
    p.y = y + 0.05; p.life = 0.3; p.size0 = 0.15; p.size1 = 0.95; p.frame = VFX_FRAME.ring;
    p.r0 = p.r1 = hot.r; p.g0 = p.g1 = hot.g; p.b0 = p.b1 = hot.b; p.a0 = 0.5; p.fadeIn = 0.05; p.fadeOut = 0.7;
    vfx.emit(vfx.particles.additive, owner);
    const sparks = vfx.count(4);
    for (let k = 0; k < sparks; k++) {
      const ang = (index * 2.4 + k * 1.7) % (Math.PI * 2), speed = vfx.range(2.5, 4.5), up = vfx.range(1.5, 3.5);
      const s = vfx.spec();
      s.x = x; s.y = y + 0.1; s.z = z; s.delay = delay; s.vx = Math.cos(ang) * speed; s.vy = up; s.vz = Math.sin(ang) * speed; s.gravity = 8; s.drag = 1.4;
      s.life = vfx.range(0.3, 0.5); s.size0 = 0.06; s.size1 = 0.02; s.frame = VFX_FRAME.spark; s.stretch = 0.09;
      s.r0 = s.r1 = hot.r; s.g0 = s.g1 = hot.g; s.b0 = s.b1 = hot.b; s.a0 = 0.9; s.fadeIn = 0.02; s.fadeOut = 0.5;
      vfx.emit(vfx.particles.additive, owner);
    }
    const d = vfx.spec();
    d.x = x; d.y = y + 0.1; d.z = z; d.delay = delay; d.vy = 0.3; d.life = vfx.range(0.5, 0.8); d.size0 = 0.2; d.size1 = 0.7; d.frame = VFX_FRAME.smoke; d.spin = vfx.random() * 6;
    d.r0 = d.r1 = VFX_COLORS.dust.r; d.g0 = d.g1 = VFX_COLORS.dust.g; d.b0 = d.b1 = VFX_COLORS.dust.b; d.a0 = 0.3; d.fadeIn = 0.1; d.fadeOut = 0.5;
    vfx.emit(vfx.particles.alpha, owner);
    if (index % 3 === 0) this.feather(slot, this.b.set(x, y + 0.2, z), vfx.range(-0.5, 0.5), vfx.range(0.4, 1.2), vfx.range(-0.5, 0.5), delay);
  }

  // ---- particle helpers ----

  /** Thin velocity-stretched additive streak (wind lines, leap trails, strike lines). */
  private streak(owner: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, width: number, stretch: number, color: Color, alpha: number): void {
    const vfx = this.vfx, p = vfx.spec();
    p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz; p.drag = 2; p.life = life; p.size0 = width; p.size1 = width * 0.4; p.frame = VFX_FRAME.spark; p.stretch = stretch;
    p.r0 = p.r1 = color.r; p.g0 = p.g1 = color.g; p.b0 = p.b1 = color.b; p.a0 = alpha; p.fadeIn = 0.15; p.fadeOut = 0.5;
    vfx.emit(vfx.particles.additive, owner);
  }

  /** Streaks racing along the lane (+Z in the footprint frame) at random lane positions, `lift` metres above the floor band. */
  private laneStreaks(slot: KitSlot, count: number, reach: number, speed: number): void {
    const vfx = this.vfx, fp = slot.footprint, hot = slot.element === 'poison' ? PALETTE.poison.hot : PALETTE.wind.hot;
    for (let i = count; i > 0; i--) {
      fp.toWorld((vfx.random() - 0.5) * 2 * fp.halfWidth * 0.8, -fp.halfLength + vfx.random() * fp.halfLength * 2 * reach, this.b, vfx.range(0.15, 0.85));
      this.streak(slot.owner, this.b.x, this.b.y, this.b.z, fp.forwardX * speed, 0, fp.forwardZ * speed, vfx.range(0.18, 0.34), 0.07, 0.14, hot, 0.55);
    }
  }

  /** Streaks racing along the band (local +X) of a wave footprint. */
  private sideStreaks(slot: KitSlot, count: number, reach: number): void {
    const vfx = this.vfx, fp = slot.footprint, color = slot.element === 'poison' ? PALETTE.poison.b : PALETTE.wind.hot;
    for (let i = count; i > 0; i--) {
      fp.toWorld(-fp.halfWidth * 0.9 + vfx.random() * fp.halfWidth * 1.8 * Math.min(1, reach), (vfx.random() - 0.5) * 2 * fp.halfLength * 0.8, this.b, vfx.range(0.1, 0.5));
      this.sideStreak(slot, this.b, vfx.range(5, 8), 0.2, color, 0.55);
    }
  }

  private sideStreak(slot: KitSlot, at: Vector3, speed: number, life: number, color: Color, alpha: number): void {
    const a = slot.footprint.angle;
    this.streak(slot.owner, at.x, at.y, at.z, Math.cos(a) * speed, 0, -Math.sin(a) * speed, life + this.vfx.random() * 0.12, 0.07, 0.14, color, alpha);
  }

  private feather(slot: KitSlot, at: Vector3, vx: number, vy: number, vz: number, delay = 0): void {
    emitStormFeather(this.vfx, slot.owner, at.x, at.y, at.z, vx, vy, vz, delay);
  }

  /** Falling additive droplet in the element's hot colour. */
  private drip(slot: KitSlot, x: number, y: number, z: number, element: VfxElement, size: number): void {
    this.dropSpec(slot.owner, x, y, z, this.vfx.range(-0.15, 0.15), 0, this.vfx.range(-0.15, 0.15), element, size, 0.55);
  }

  private dropSpec(owner: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, element: VfxElement, size: number, life: number, tint?: Color): void {
    const vfx = this.vfx, color = tint ?? PALETTE[element].hot, p = vfx.spec();
    p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz; p.gravity = 8; p.drag = 0.35; p.life = life; p.size0 = size; p.size1 = size * 0.7; p.frame = VFX_FRAME.drop;
    p.r0 = p.r1 = color.r; p.g0 = p.g1 = color.g; p.b0 = p.b1 = color.b; p.a0 = 0.9; p.fadeIn = 0.05; p.fadeOut = 0.7;
    vfx.emit(tint ? vfx.particles.alpha : vfx.particles.additive, owner);
  }

  /** Hard round glob core of a venom glob (additive droplet frame in the hot venom colour). */
  private globCore(slot: KitSlot, at: Vector3, size: number): void {
    const vfx = this.vfx, hot = PALETTE.poison.hot, p = vfx.spec();
    p.x = at.x; p.y = at.y; p.z = at.z; p.life = 0.1; p.size0 = p.size1 = size; p.frame = VFX_FRAME.drop;
    p.r0 = p.r1 = hot.r; p.g0 = p.g1 = hot.g; p.b0 = p.b1 = hot.b; p.a0 = 0.9; p.fadeIn = 0.05; p.fadeOut = 0.4;
    vfx.emit(vfx.particles.additive, slot.owner);
  }

  /** Four-point glint flare (fangs, feather glints). */
  private starGlint(slot: KitSlot, at: Vector3, size: number, life: number, element: VfxElement): void {
    const vfx = this.vfx, hot = PALETTE[element].hot, p = vfx.spec();
    p.x = at.x; p.y = at.y; p.z = at.z; p.life = life; p.size0 = size * 0.6; p.size1 = size; p.frame = VFX_FRAME.star; p.spin = vfx.random() * 6.28;
    p.r0 = p.r1 = hot.r; p.g0 = p.g1 = hot.g; p.b0 = p.b1 = hot.b; p.a0 = 0.8; p.fadeIn = 0.1; p.fadeOut = 0.6;
    vfx.emit(vfx.particles.additive, slot.owner);
  }

  /** Dust glints inside the telegraphed footprint during anticipation. */
  private groundDust(slot: KitSlot, t: number, dt: number, stream: 1 | 2 | 3 | 4, rate: number): void {
    const vfx = this.vfx, fp = slot.footprint, reach = 0.35 + 0.55 * t;
    for (let n = this.due(slot, rate, dt, stream); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * reach, this.b, 0.05, 0.8); vfx.smoke(this.b.x, this.b.y, this.b.z, 1, 0.15, 0.3, 0.6, 0.7, VFX_COLORS.dust, 0.3, slot.owner, 0.2); }
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

  /** Mouth/hand: the manifest `cast` socket, else the authored source point lifted to chest height. */
  private socketPosition(slot: KitSlot, out: Vector3): Vector3 {
    if (slot.socket) { slot.socket.updateWorldMatrix(true, false); return slot.socket.getWorldPosition(out); }
    const from = slot.cue.from ?? slot.cue.position;
    return out.set(from?.x ?? 0, (from?.y ?? 0) + 1.1, from?.z ?? 0);
  }

  /** Drawn body centre: the rendered root (it carries the hornbill's hover offset), else the authored source point. */
  private body(slot: KitSlot, out: Vector3): Vector3 {
    const root = this.root(slot);
    if (root) { root.updateWorldMatrix(true, false); return root.getWorldPosition(out); }
    const from = slot.cue.from ?? slot.cue.position;
    return out.set(from?.x ?? 0, (from?.y ?? 0) + (slot.kit.startsWith('hornbill') ? 2.4 : 1), from?.z ?? 0);
  }

  /** Horizontal position of the body with y at the simulation floor (dust, rings and ground effects stay on the ground). */
  private feet(slot: KitSlot, out: Vector3): Vector3 {
    const root = this.root(slot);
    if (root) { root.updateWorldMatrix(true, false); root.getWorldPosition(out); } else { const from = slot.cue.from ?? slot.cue.position; out.set(from?.x ?? 0, from?.y ?? 0, from?.z ?? 0); }
    out.y = this.groundY(slot);
    return out;
  }

  private groundY(slot: KitSlot): number { return slot.cue.from?.y ?? slot.footprint.cy; }
  private root(slot: KitSlot): Object3D | undefined { return slot.cue.actorId ? this.resolveSocket?.(slot.cue.actorId, 'root') : undefined; }

  /** Committed aim point lifted slightly above the floor so lobbed bodies land on the mark. */
  private landing(slot: KitSlot, out: Vector3): Vector3 { return out.set(slot.target.x, slot.target.y + 0.2, slot.target.z); }

  /** Parabolic lob: endpoints are exact at t = 0 and 1. */
  private lob(from: Vector3, to: Vector3, t: number, out: Vector3, apexScale: number): Vector3 {
    out.lerpVectors(from, to, t);
    out.y += 4 * t * (1 - t) * Math.min(2.4, 0.6 + Math.hypot(to.x - from.x, to.z - from.z) * 0.2) * apexScale;
    return out;
  }

  /** Travelling head of a sweep across a wave band (local X from -0.9 to +0.9 of the half width). */
  private sweepHead(slot: KitSlot, t: number, out: Vector3): Vector3 {
    const fp = slot.footprint;
    return fp.toWorld((-0.9 + 1.8 * clamp01(t)) * fp.halfWidth, 0, out, 0.2);
  }

  private center(fp: Footprint, out: Vector3): Vector3 {
    return fp.shape === 'sector' ? fp.toWorld(0, fp.halfLength * 0.5, out) : out.set(fp.cx, fp.cy, fp.cz);
  }

}

/** Alpha-blended storm feather drifting down (leaf frame, slate blue). `delay` schedules it for a later impact. Shared by the hornbill kits and aura. */
export function emitStormFeather(vfx: VfxSystem, owner: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, delay = 0): void {
  const p = vfx.spec(), color = vfx.random() > 0.45 ? FEATHER_LIGHT : FEATHER_DARK;
  p.x = x + vfx.range(-0.15, 0.15); p.y = y + vfx.range(-0.1, 0.1); p.z = z + vfx.range(-0.15, 0.15); p.vx = vx; p.vy = vy; p.vz = vz; p.delay = delay;
  p.gravity = 0.9; p.drag = 1.3; p.life = vfx.range(1.1, 1.9); p.size0 = p.size1 = vfx.range(0.14, 0.24);
  p.spin = vfx.random() * 6.28; p.spinRate = vfx.range(-6, 6); p.frame = VFX_FRAME.leaf;
  p.r0 = p.r1 = color.r; p.g0 = p.g1 = color.g; p.b0 = p.b1 = color.b; p.a0 = 0.9; p.fadeIn = 0.05; p.fadeOut = 0.7;
  vfx.emit(vfx.particles.alpha, owner);
}
