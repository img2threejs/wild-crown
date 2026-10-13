import { Color, Vector3, type Object3D } from 'three';
import type { AuraTheme } from './ActorVfx.js';
import type { CueKits, ImpactSink, KitSlot, MapKitFamily, SocketResolver } from './ElementKits.js';
import type { Footprint } from './footprint.js';
import { PALETTE, type VfxElement } from './palette.js';
import { VFX_FRAME } from './VfxAtlas.js';
import type { VfxSystem } from './VfxSystem.js';

/**
 * Mistveil Basin monster kits (docs/features/mistveil-playtest.md): the attack id is the kit id, like CanopyKits. Three phases:
 * anticipation -> commit -> active, then decay. The Bog Lurker's tongue, bubbles and hop are mud and murk, the Lantern Heron's
 * dive, gust and flare are cold mist and warm lantern light, and Ghor's sweep, bite and wave throw black water. Every kit is a
 * pure function of its cue (authored footprint, phase window, socket bones) and the world clock, so pause, slow motion, hit-stop
 * and cancellation behave like the other kits. All emission goes through the shared particle pools / ground quads; ground quads
 * are only ever spawned from the cue footprint (or a shape inscribed in it), so no hard-edged zone leaves the authored hazard.
 */
export const MISTVEIL_KIT_IDS = [
  'bog-lurker-tongue-lash', 'bog-lurker-bubble-pool', 'bog-lurker-mud-hop',
  'lantern-heron-spear-dive', 'lantern-heron-mist-gust', 'lantern-heron-flare-burst',
  'mire-maw-tail-sweep', 'mire-maw-bite-lunge', 'mire-maw-black-river-wave',
] as const;
export type MistveilKitId = typeof MISTVEIL_KIT_IDS[number];
const MISTVEIL_KITS: Readonly<Record<string, true>> = {
  'bog-lurker-tongue-lash': true, 'bog-lurker-bubble-pool': true, 'bog-lurker-mud-hop': true,
  'lantern-heron-spear-dive': true, 'lantern-heron-mist-gust': true, 'lantern-heron-flare-burst': true,
  'mire-maw-tail-sweep': true, 'mire-maw-bite-lunge': true, 'mire-maw-black-river-wave': true,
};
export const isMistveilKit = (kit: string): kit is MistveilKitId => MISTVEIL_KITS[kit] === true;

/** Attack id -> [kit id, presentation element]. Lantern light is warm `gold`; the Black Sap is `poison` tinted purple-black by the kits. */
export const MISTVEIL_ATTACK_KITS: Readonly<Record<string, readonly [MistveilKitId, VfxElement]>> = {
  'bog-lurker-tongue-lash': ['bog-lurker-tongue-lash', 'earth'],
  'bog-lurker-bubble-pool': ['bog-lurker-bubble-pool', 'poison'],
  'bog-lurker-mud-hop': ['bog-lurker-mud-hop', 'earth'],
  'lantern-heron-spear-dive': ['lantern-heron-spear-dive', 'wind'],
  'lantern-heron-mist-gust': ['lantern-heron-mist-gust', 'wind'],
  'lantern-heron-flare-burst': ['lantern-heron-flare-burst', 'gold'],
  'mire-maw-tail-sweep': ['mire-maw-tail-sweep', 'earth'],
  'mire-maw-bite-lunge': ['mire-maw-bite-lunge', 'earth'],
  'mire-maw-black-river-wave': ['mire-maw-black-river-wave', 'poison'],
};
/** Monster id -> idle body aura theme drawn by ActorVfx: mud for the lurker, cold wind for the heron, toxic seep for Ghor. */
export const MISTVEIL_AURAS: Readonly<Record<string, AuraTheme>> = {
  'mistveil-lurker': 'earth', 'mistveil-heron': 'storm', 'mistveil-ghor': 'toxic',
};

const SHAKE_RADIUS = 6;
const SHAKE_WEIGHT: Readonly<Record<MistveilKitId, number>> = {
  'bog-lurker-tongue-lash': 0.08, 'bog-lurker-bubble-pool': 0.05, 'bog-lurker-mud-hop': 0.26,
  'lantern-heron-spear-dive': 0.14, 'lantern-heron-mist-gust': 0.06, 'lantern-heron-flare-burst': 0.12,
  'mire-maw-tail-sweep': 0.16, 'mire-maw-bite-lunge': 0.2, 'mire-maw-black-river-wave': 0.24,
};

// Alpha-blended tints (never HDR): wet mud, pond-water spray, cold mist and the purple-black Black Sap.
const MUD = new Color().setRGB(0.2, 0.15, 0.1);
const SPRAY = new Color().setRGB(0.42, 0.52, 0.52);
const MIST = new Color().setRGB(0.7, 0.82, 0.8);
const BLACK_SAP = new Color().setRGB(0.12, 0.06, 0.18);
const SAP_SHEEN = new Color().setRGB(0.3, 0.16, 0.42);

const clamp01 = (t: number): number => t < 0 ? 0 : t > 1 ? 1 : t;
const smooth = (t: number): number => { const x = clamp01(t); return x * x * (3 - 2 * x); };

export function createMistveilKits(vfx: VfxSystem, resolveSocket: SocketResolver | undefined, impact: ImpactSink | undefined, focus: CueKits): MapKitFamily {
  return new MistveilKits(vfx, resolveSocket, impact, focus);
}

class MistveilKits implements MapKitFamily {
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly c = new Vector3();
  private readonly d = new Vector3();

  constructor(private readonly vfx: VfxSystem, private readonly resolveSocket: SocketResolver | undefined, private impact: ImpactSink | undefined, private readonly focus: CueKits) {}

  owns(kit: string): boolean { return isMistveilKit(kit); }

  setImpactSink(impact: ImpactSink | undefined): void { this.impact = impact; }

  begin(slot: KitSlot, seconds: number): void {
    const vfx = this.vfx, cue = slot.cue, phase = cue.phase;
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

  /** Releases manual resources (ground fill, beam); a natural end of the active phase also emits the decay. */
  end(slot: KitSlot, natural: boolean): void {
    if (slot.ground) { this.vfx.ground.release(slot.ground); slot.ground = undefined; }
    if (slot.beam) { this.vfx.beams.release(slot.beam); slot.beam = undefined; }
    slot.socket = undefined;
    if (natural && slot.cue.phase === 'active') this.decay(slot);
  }

  // ---- begin ----

  private beginAnticipation(slot: KitSlot): void {
    const vfx = this.vfx, owner = slot.owner;
    switch (slot.kit as MistveilKitId) {
      case 'bog-lurker-mud-hop': case 'mire-maw-bite-lunge': case 'mire-maw-tail-sweep': {
        const feet = this.feet(slot, this.a);
        vfx.dustRing(feet.x, feet.y, feet.z, slot.kit === 'mire-maw-tail-sweep' ? 1.6 : 0.8, 10, owner, MUD);
        break;
      }
      case 'lantern-heron-flare-burst': {
        const lantern = this.socketPosition(slot, this.a);
        vfx.flash(lantern.x, lantern.y, lantern.z, 0.9, 'gold', owner, 0.14);
        break;
      }
      default: break;
    }
  }

  private beginCommit(slot: KitSlot): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint;
    switch (slot.kit as MistveilKitId) {
      case 'bog-lurker-bubble-pool': {
        slot.origin.y += 0.05;
        vfx.bubbles(slot.origin.x, slot.origin.y, slot.origin.z, 8, 0.15, owner, 'poison');
        vfx.sparks(slot.origin.x, slot.origin.y, slot.origin.z, 6, 2.4, 'poison', owner, 0.5);
        break;
      }
      case 'bog-lurker-mud-hop': {
        // Take-off: a ring of mud, kicked clods and a spatter of pond water.
        const feet = this.feet(slot, this.a);
        vfx.dustRing(feet.x, feet.y, feet.z, 1.1, 20, owner, MUD);
        vfx.chunks(feet.x, feet.y + 0.05, feet.z, 5, 3.2, 0.18, owner);
        for (let i = vfx.count(8); i > 0; i--) this.drop(owner, feet.x, feet.y + 0.2, feet.z, vfx.range(-1.5, 1.5), vfx.range(2, 4), vfx.range(-1.5, 1.5), SPRAY, 0.07, 0.6);
        break;
      }
      case 'lantern-heron-spear-dive': {
        // The heron lunges: water kicks up at the lane start.
        fp.toWorld(0, -fp.halfLength, this.a, 0.05);
        vfx.dustRing(this.a.x, fp.cy, this.a.z, 0.9, 14, owner, SPRAY);
        for (let i = vfx.count(6); i > 0; i--) this.drop(owner, this.a.x, this.a.y + 0.2, this.a.z, vfx.range(-1.2, 1.2), vfx.range(1.5, 3), vfx.range(-1.2, 1.2), SPRAY, 0.06, 0.55);
        break;
      }
      case 'mire-maw-bite-lunge': {
        const feet = this.feet(slot, this.a);
        vfx.dustRing(feet.x, feet.y, feet.z, 1.4, 18, owner, MUD);
        for (let i = vfx.count(8); i > 0; i--) this.drop(owner, feet.x, feet.y + 0.2, feet.z, vfx.range(-2, 2), vfx.range(1.5, 3.5), vfx.range(-2, 2), BLACK_SAP, 0.08, 0.6);
        break;
      }
      default: break;
    }
  }

  // ---- anticipation ----

  private updateAnticipation(slot: KitSlot, t: number, dt: number): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint;
    switch (slot.kit as MistveilKitId) {
      case 'bog-lurker-tongue-lash': {
        // The throat swells: mud and murk gather at the mouth, drool beads, the lane begins to hiss.
        const mouth = this.socketPosition(slot, this.a);
        vfx.gather(mouth.x, mouth.y, mouth.z, this.due(slot, 30, dt), 0.6, 'earth', owner);
        for (let n = this.due(slot, 9, dt, 2); n > 0; n--) this.drop(owner, mouth.x, mouth.y - 0.05, mouth.z, vfx.range(-0.15, 0.15), 0, vfx.range(-0.15, 0.15), SPRAY, 0.06, 0.5);
        this.laneStreaks(slot, this.due(slot, 6 + 10 * t, dt, 3), 0.3, 5);
        return;
      }
      case 'bog-lurker-bubble-pool': {
        // Murk gathers behind the lips: dense inward mist, bubbles welling at the mouth, sheen on the marked ground.
        const mouth = this.socketPosition(slot, this.a);
        vfx.gather(mouth.x, mouth.y, mouth.z, this.due(slot, 40, dt), 0.6, 'poison', owner);
        for (let n = this.due(slot, 8, dt, 2); n > 0; n--) vfx.bubbles(mouth.x, mouth.y, mouth.z, 1, 0.14, owner, 'poison');
        for (let n = this.due(slot, 12, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.05, 0.8); vfx.smoke(this.b.x, this.b.y, this.b.z, 1, 0.2, 0.08, vfx.range(1.2, 1.8), 1.5, BLACK_SAP, 0.26, owner, 0.3); }
        return;
      }
      case 'bog-lurker-mud-hop': {
        // Crouch: mud sucks out from under the body, the landing mark fills with settling grit and murky bubbles.
        const feet = this.feet(slot, this.a);
        for (let n = this.due(slot, 14 + 16 * t, dt); n > 0; n--) vfx.smoke(feet.x, feet.y, feet.z, 1, 0.8, 0.12, 0.8, 0.9, MUD, 0.34, owner, 0.7);
        vfx.gather(feet.x, feet.y + 0.4, feet.z, this.due(slot, 12, dt, 2), 1, 'earth', owner);
        this.groundDust(slot, t, dt, 3, 8, MUD);
        return;
      }
      case 'lantern-heron-spear-dive': {
        // The neck coils: cold mist is drawn into the body, loose drops shake free, the lane begins to hiss.
        const body = this.body(slot, this.a);
        vfx.gather(body.x, body.y, body.z, this.due(slot, 34, dt), 1.2, 'wind', owner);
        for (let n = this.due(slot, 8, dt, 2); n > 0; n--) this.drop(owner, body.x + vfx.range(-0.5, 0.5), body.y - 0.2, body.z + vfx.range(-0.5, 0.5), vfx.range(-0.3, 0.3), 0, vfx.range(-0.3, 0.3), SPRAY, 0.05, 0.6);
        for (let n = this.due(slot, 5, dt, 3); n > 0; n--) vfx.glow(body.x, body.y, body.z, 0.8 + 0.5 * t, 0.3, 'wind', 0.28, owner);
        this.laneStreaks(slot, this.due(slot, 8 + 12 * t, dt, 4), 0.35, 5);
        return;
      }
      case 'lantern-heron-mist-gust': {
        // The wings lift and cup the air: cold mist gathers at the wing joint and swirls in the sector the gust will fill.
        const wing = this.socketPosition(slot, this.a);
        vfx.gather(wing.x, wing.y, wing.z, this.due(slot, 28, dt), 1, 'wind', owner);
        for (let n = this.due(slot, 14 + 14 * t, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.15, 0.8); vfx.smoke(this.b.x, this.b.y, this.b.z, 1, 0.2, 0.1, vfx.range(1.4, 2), 1.3, MIST, 0.22, owner, 0.4); }
        this.coneStreaks(slot, this.due(slot, 8, dt, 3), 0.4, 4);
        return;
      }
      case 'lantern-heron-flare-burst': {
        // The lantern swells: warm light gathers into a growing orb above the bill, motes spiral into it.
        const lantern = this.socketPosition(slot, this.a);
        vfx.gather(lantern.x, lantern.y, lantern.z, this.due(slot, 40, dt), 1, 'gold', owner);
        for (let n = this.due(slot, 8, dt, 2); n > 0; n--) vfx.glow(lantern.x, lantern.y, lantern.z, 0.5 + 0.9 * smooth(t), 0.25, 'gold', 0.45, owner);
        for (let n = this.due(slot, 10, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.2, 0.8); vfx.glow(this.b.x, this.b.y, this.b.z, 0.14, 0.6, 'gold', 0.4, owner, 0.2); }
        return;
      }
      case 'mire-maw-tail-sweep': {
        // The long body coils low: mud circles the base, black droplets crawl along the band the tail will whip.
        const feet = this.feet(slot, this.a);
        for (let n = this.due(slot, 12 + 14 * t, dt); n > 0; n--) vfx.smoke(feet.x, feet.y, feet.z, 1, 1.4, 0.06, 0.9, 1, MUD, 0.3, owner, 1);
        for (let n = this.due(slot, 14, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.05, 0.85); vfx.glow(this.b.x, this.b.y, this.b.z, 0.14, 0.6, 'poison', 0.3, owner); }
        this.sideStreaks(slot, this.due(slot, 6, dt, 3), 0.4);
        return;
      }
      case 'mire-maw-bite-lunge': {
        // Rears back: black water streams from the jaws, a pale tooth glint tightens before the strike, the lane hisses.
        const jaws = this.socketPosition(slot, this.a);
        for (let n = this.due(slot, 10, dt); n > 0; n--) this.drop(owner, jaws.x + vfx.range(-0.2, 0.2), jaws.y - 0.1, jaws.z + vfx.range(-0.2, 0.2), vfx.range(-0.2, 0.2), 0, vfx.range(-0.2, 0.2), BLACK_SAP, 0.07, 0.6);
        vfx.gather(jaws.x, jaws.y, jaws.z, this.due(slot, 20, dt, 2), 0.6, 'poison', owner);
        for (let n = this.due(slot, 5, dt, 3); n > 0; n--) this.starGlint(slot, jaws, 0.2 + 0.25 * t, 0.2, 'wind');
        this.laneStreaks(slot, this.due(slot, 6 + 10 * t, dt, 4), 0.3, 6);
        return;
      }
      case 'mire-maw-black-river-wave': {
        // Rears up: black water wells under the forelegs, the whole band shimmers with Black Sap sheen.
        const feet = this.feet(slot, this.a);
        for (let n = this.due(slot, 16 + 16 * t, dt); n > 0; n--) vfx.smoke(feet.x, feet.y, feet.z, 1, 1.6, 0.1, 1, 1.1, BLACK_SAP, 0.34, owner, 1.1);
        vfx.gather(feet.x, feet.y + 0.5, feet.z, this.due(slot, 18, dt, 2), 1.4, 'poison', owner);
        for (let n = this.due(slot, 16, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.05, 0.85); vfx.glow(this.b.x, this.b.y, this.b.z, 0.16, 0.6, 'poison', 0.38, owner); }
        this.sideStreaks(slot, this.due(slot, 8, dt, 4), 0.5);
        return;
      }
    }
  }

  // ---- commit ----

  private updateCommit(slot: KitSlot, t: number, dt: number): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint;
    switch (slot.kit as MistveilKitId) {
      case 'bog-lurker-tongue-lash': {
        // The strike line draws itself: fast streaks along the lane, the tongue's tip glints at the mouth.
        const mouth = this.socketPosition(slot, this.a);
        this.laneStreaks(slot, this.due(slot, 60, dt), 1, 20);
        vfx.gather(mouth.x, mouth.y, mouth.z, this.due(slot, 24, dt, 2), 0.5, 'earth', owner);
        return;
      }
      case 'bog-lurker-bubble-pool': {
        // The murk glob and two trailing sub-globs fly in an arc from the mouth to the committed point.
        const aim = this.landing(slot, this.d);
        for (let k = 0; k < 3; k++) {
          const lag = clamp01(t - k * 0.09), head = this.lob(slot.origin, aim, lag, this.a, 0.8 - k * 0.1), size = k === 0 ? 0.5 : 0.34 - k * 0.04;
          for (let n = this.due(slot, k === 0 ? 100 : 60, dt, (k + 1) as 1 | 2 | 3); n > 0; n--) {
            vfx.glow(head.x, head.y, head.z, size, 0.1, 'poison', 0.55, owner);
            this.globCore(slot, head, size * 0.45);
          }
        }
        this.lob(slot.origin, aim, t, this.a, 0.8);
        for (let n = this.due(slot, 40, dt, 4); n > 0; n--) this.drop(owner, this.a.x + vfx.range(-0.1, 0.1), this.a.y - 0.05, this.a.z + vfx.range(-0.1, 0.1), vfx.range(-0.15, 0.15), 0, vfx.range(-0.15, 0.15), BLACK_SAP, 0.05, 0.55);
        return;
      }
      case 'bog-lurker-mud-hop': {
        // Hop streak: thin mud streaks trail the airborne body, clods and droplets fall away behind it.
        const body = this.body(slot, this.a), speed = vfx.range(2.5, 4.5);
        const dx = slot.target.x - body.x, dz = slot.target.z - body.z, len = Math.max(1e-3, Math.hypot(dx, dz));
        for (let n = this.due(slot, 80, dt); n > 0; n--) this.streak(owner, body.x + vfx.range(-0.4, 0.4), body.y + vfx.range(-0.2, 0.7), body.z + vfx.range(-0.4, 0.4), -dx / len * speed, vfx.range(-0.2, 0.4), -dz / len * speed, vfx.range(0.18, 0.3), 0.08, 0.09, PALETTE.earth.hot, 0.5);
        for (let n = this.due(slot, 24, dt, 2); n > 0; n--) this.drop(owner, body.x, body.y - 0.2, body.z, -dx / len * 1.5 + vfx.range(-0.5, 0.5), vfx.range(0, 1), -dz / len * 1.5 + vfx.range(-0.5, 0.5), MUD, 0.08, 0.5);
        return;
      }
      case 'lantern-heron-spear-dive': {
        // The heron tips into the dive: streaks pour down the lane ahead of it, spray skates along the lane start.
        const body = this.body(slot, this.a);
        this.laneStreaks(slot, this.due(slot, 44, dt), 0.9, 9);
        for (let n = this.due(slot, 20, dt, 2); n > 0; n--) { fp.toWorld((vfx.random() - 0.5) * fp.halfWidth * 1.4, -fp.halfLength + vfx.random() * fp.halfLength * 2 * t * 0.5, this.b, 0.05); vfx.smoke(this.b.x, this.b.y, this.b.z, 1, 0.2, 0.2, 0.8, 0.8, SPRAY, 0.3, owner, 0.6); }
        vfx.glow(body.x, body.y, body.z, 1 + t, 0.1, 'wind', 0.2, owner);
        return;
      }
      case 'lantern-heron-mist-gust': {
        // The wingbeat starts: streaks fan out of the joint through the sector and mist puffs begin to roll.
        this.coneStreaks(slot, this.due(slot, 40, dt), 0.7 + 0.3 * t, 7 + 4 * t);
        for (let n = this.due(slot, 20, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * 0.6, this.b, 0.2, 0.8); vfx.smoke(this.b.x, this.b.y, this.b.z, 1, 0.3, 0.1, 1.2, 1, MIST, 0.3, owner, 0.8); }
        return;
      }
      case 'lantern-heron-flare-burst': {
        // The orb rises and drifts to the committed point, trailing warm motes; it lands as the hazard opens.
        const aim = this.landing(slot, this.d), head = this.lob(slot.origin, aim, t, this.a, 1.2);
        for (let n = this.due(slot, 90, dt); n > 0; n--) vfx.glow(head.x + vfx.range(-0.1, 0.1), head.y + vfx.range(-0.1, 0.1), head.z + vfx.range(-0.1, 0.1), 0.55 + 0.25 * t, 0.12, 'gold', 0.5, owner);
        for (let n = this.due(slot, 30, dt, 2); n > 0; n--) vfx.sparks(head.x, head.y, head.z, 1, 1.6, 'gold', owner, 0.2);
        for (let n = this.due(slot, 8, dt, 3); n > 0; n--) this.starGlint(slot, head, 0.3 + 0.3 * t, 0.15, 'gold');
        return;
      }
      case 'mire-maw-tail-sweep': {
        // The tail starts to whip: black droplets are flicked along the band and the base spins up mud.
        const feet = this.feet(slot, this.a);
        for (let n = this.due(slot, 24 + 20 * t, dt); n > 0; n--) {
          fp.sample(vfx.random(), vfx.random(), this.b, 0.1, 0.85);
          const speed = 3 + 3 * t;
          this.drop(owner, this.b.x, this.b.y, this.b.z, Math.cos(fp.angle) * speed, vfx.range(0.8, 2), -Math.sin(fp.angle) * speed, BLACK_SAP, 0.07, 0.5);
        }
        for (let n = this.due(slot, 24, dt, 2); n > 0; n--) vfx.smoke(feet.x, feet.y, feet.z, 1, 1.2, 0.15, 0.9, 0.9, MUD, 0.34, owner, 1);
        this.sideStreaks(slot, this.due(slot, 16, dt, 3), 0.7);
        return;
      }
      case 'mire-maw-bite-lunge': {
        // The strike line draws itself: fast streaks along the lane, black water beading at the jaws.
        const jaws = this.socketPosition(slot, this.a);
        this.laneStreaks(slot, this.due(slot, 70, dt), 1, 22);
        vfx.gather(jaws.x, jaws.y, jaws.z, this.due(slot, 30, dt, 2), 0.6, 'poison', owner);
        for (let n = this.due(slot, 8, dt, 3); n > 0; n--) this.starGlint(slot, jaws, 0.3 + 0.3 * t, 0.15, 'wind');
        return;
      }
      case 'mire-maw-black-river-wave': {
        // The slam is coming: a swell of black water lifts along the band, streaks race along it.
        for (let n = this.due(slot, 30, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.b, 0.1, 0.85); vfx.smoke(this.b.x, this.b.y, this.b.z, 1, 0.3, 0.2, 1.2, 1, BLACK_SAP, 0.34, owner, 0.5); }
        this.sideStreaks(slot, this.due(slot, 40, dt, 2), 1.2);
        for (let n = this.due(slot, 16, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.b, 0.2, 0.85); this.drop(owner, this.b.x, this.b.y, this.b.z, Math.cos(fp.angle) * 3, vfx.range(1, 2.4), -Math.sin(fp.angle) * 3, BLACK_SAP, 0.07, 0.5); }
        return;
      }
    }
  }

  // ---- active ----

  private detonate(slot: KitSlot, seconds: number): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint, time = vfx.time, kit = slot.kit as MistveilKitId;
    const center = this.center(fp, this.c);
    switch (kit) {
      case 'bog-lurker-tongue-lash': {
        // Strike: a bright streak along the whole lane (the tongue), a splat at its tip, mud flicked off it.
        const life = Math.max(0.12, Math.min(0.3, seconds));
        slot.beam = vfx.beams.acquire(owner, time, 0, 0.42, 0.02, 'earth');
        if (slot.beam) {
          fp.toWorld(0, -fp.halfLength, slot.beam.a, 0.55); fp.toWorld(0, fp.halfLength, slot.beam.b, 0.55);
          slot.beam.alpha = 0.9;
        }
        this.laneStreaks(slot, vfx.count(26), 1, 28);
        fp.toWorld(0, fp.halfLength - 0.4, this.a, 0.3);
        vfx.flash(this.a.x, this.a.y, this.a.z, 1.2, 'earth', owner, life);
        for (let i = vfx.count(10); i > 0; i--) this.drop(owner, this.a.x, this.a.y, this.a.z, fp.forwardX * vfx.range(1.5, 4) + vfx.range(-1, 1), vfx.range(0.8, 2.6), fp.forwardZ * vfx.range(1.5, 4) + vfx.range(-1, 1), MUD, 0.08, 0.5);
        fp.toWorld(0, fp.halfLength - 0.6, this.b);
        vfx.dustRing(this.b.x, fp.cy, this.b.z, Math.min(fp.halfWidth, 0.6), 12, owner, MUD);
        this.shake(this.b, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'bog-lurker-bubble-pool': {
        // Splash: droplets radiate and fall back into a bubbling pool of murk that lingers for the whole active window.
        const r = Math.min(fp.halfWidth, fp.halfLength);
        vfx.flash(center.x, center.y + 0.3, center.z, r * 1.3, 'poison', owner, 0.18);
        vfx.ground.spawn('shock', fp, 'poison', owner, time, 0.42);
        vfx.ground.spawn('decal', fp, 'poison', owner, time, seconds + 4, 1, slot.glow);
        slot.ground = vfx.ground.spawn('burn', fp, 'poison', owner, time, 0, 0.3);
        for (let i = vfx.count(24); i > 0; i--) {
          const ang = vfx.random() * Math.PI * 2, speed = r * vfx.range(1.2, 2.6), up = vfx.range(2.5, 5.5);
          this.drop(owner, center.x, center.y + 0.1, center.z, Math.cos(ang) * speed, up, Math.sin(ang) * speed, BLACK_SAP, vfx.range(0.07, 0.12), vfx.range(0.5, 0.8));
        }
        vfx.smoke(center.x, center.y, center.z, 14, r * 0.7, 0.25, 1.8, 1.9, BLACK_SAP, 0.42, owner, 1.2);
        vfx.bubbles(center.x, center.y, center.z, 18, r * 0.75, owner, 'poison');
        vfx.lights.pulse(center.x, center.y + 0.8, center.z, PALETTE.poison.hot, 3, 6, 0.4, time, owner);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'bog-lurker-mud-hop': {
        // Landing splat: wide shock, mud decal, heavy clods, a ring of mud and a fan of pond water.
        const r = Math.min(fp.halfWidth, fp.halfLength);
        vfx.flash(center.x, center.y + 0.5, center.z, r * 2, 'earth', owner, 0.2);
        vfx.ground.spawn('shock', fp, 'earth', owner, time, 0.44);
        vfx.ground.spawn('decal', fp, 'earth', owner, time, 6, 1, slot.glow);
        vfx.chunks(center.x, center.y + 0.1, center.z, 16, 4.6, 0.24, owner, false, fp);
        vfx.dustRing(center.x, center.y, center.z, r, 28, owner, MUD);
        for (let i = vfx.count(20); i > 0; i--) {
          const ang = vfx.random() * Math.PI * 2, speed = r * vfx.range(1, 2.4), up = vfx.range(2, 4.5);
          this.drop(owner, center.x, center.y + 0.1, center.z, Math.cos(ang) * speed, up, Math.sin(ang) * speed, SPRAY, vfx.range(0.06, 0.1), vfx.range(0.5, 0.8));
        }
        vfx.smoke(center.x, center.y + 0.2, center.z, 8, r * 0.6, 0.4, 1.2, 1.3, MUD, 0.45, owner, 1);
        vfx.lights.pulse(center.x, center.y + 1.1, center.z, PALETTE.earth.hot, 5, 7, 0.45, time, owner);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'lantern-heron-spear-dive': {
        // The heron tears down the lane: two wind crescents flank it, the whole lane streaks, spray lifts along it.
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
      case 'lantern-heron-mist-gust': {
        // Gust: three cold wind crescents roll out through the sector, a bank of mist rides them, reed fluff and droplets scatter.
        const life = Math.max(0.32, Math.min(0.6, seconds));
        for (let i = 0; i < 3; i++) {
          fp.toWorld(0, fp.halfLength * (0.25 + 0.2 * i), this.a, 0.3); fp.toWorld(0, fp.halfLength * (0.5 + 0.22 * i), this.b, 0.3);
          vfx.blades.spawn(this.a, this.b, fp.halfWidth * 2 * (0.5 + 0.12 * i), fp.angle, time + i * 0.07, life, owner, 'wind');
        }
        vfx.ground.spawn('shock', fp, 'wind', owner, time, 0.36);
        vfx.ground.spawn('decal', fp, 'wind', owner, time, 4);
        for (let i = 0; i < 10; i++) { fp.sample(vfx.random(), vfx.random(), this.a, 0.15, 0.8); vfx.smoke(this.a.x, this.a.y, this.a.z, 2, 0.3, 0.3, 1.4, 1.2, MIST, 0.36, owner, 0.9); }
        for (let i = vfx.count(12); i > 0; i--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.3, 0.8); this.drop(owner, this.a.x, this.a.y, this.a.z, fp.forwardX * vfx.range(1, 3), vfx.range(0.3, 1.2), fp.forwardZ * vfx.range(1, 3), SPRAY, 0.05, 0.6); }
        this.coneStreaks(slot, vfx.count(26), 1, 10);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'lantern-heron-flare-burst': {
        // Flare: a warm flash, a shock ring and a decal inside the footprint, a shower of lantern motes and a light pulse.
        const r = Math.min(fp.halfWidth, fp.halfLength);
        vfx.flash(center.x, center.y + 0.9, center.z, r * 2.6, 'gold', owner, 0.24);
        vfx.ground.spawn('shock', fp, 'gold', owner, time, 0.46);
        vfx.ground.spawn('decal', fp, 'gold', owner, time, 4, 1, slot.glow);
        for (let i = 0; i < 3; i++) vfx.glow(center.x + vfx.range(-0.4, 0.4) * r, center.y + vfx.range(0.5, 1.6), center.z + vfx.range(-0.4, 0.4) * r, r * 1.2, 0.5, 'gold', 0.3, owner, 0.8);
        vfx.sparks(center.x, center.y + 0.6, center.z, 36, 5.5, 'gold', owner, 0.7);
        for (let i = vfx.count(18); i > 0; i--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.3 + vfx.random() * 1.2, 0.8); vfx.glow(this.a.x, this.a.y, this.a.z, 0.16, 1, 'gold', 0.5, owner, -0.4); }
        vfx.dustRing(center.x, center.y, center.z, r * 0.9, 20, owner, SPRAY);
        vfx.lights.pulse(center.x, center.y + 1.4, center.z, PALETTE.gold.hot, 7, 9, 0.6, time, owner);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'mire-maw-tail-sweep': {
        // The tail lashes across the band: a blade of black water sweeps through it, mud and droplets fly, a slick remains.
        const life = Math.max(0.2, Math.min(0.45, seconds));
        fp.toWorld(0, -fp.halfLength - 0.3, this.a, 0.12); fp.toWorld(0, fp.halfLength + 0.3, this.b, 0.12);
        vfx.blades.spawn(this.a, this.b, fp.halfWidth * 2 * 0.9, fp.angle, time, life, owner, 'earth');
        vfx.ground.spawn('shock', fp, 'earth', owner, time, 0.4);
        vfx.ground.spawn('decal', fp, 'earth', owner, time, 5, 1, slot.glow);
        for (let i = 0; i < 6; i++) { fp.toWorld((i / 5 - 0.5) * 2 * fp.halfWidth * 0.85, 0, this.a, 0.1); vfx.bubbles(this.a.x, this.a.y, this.a.z, 2, 0.2, owner, 'poison'); }
        vfx.chunks(center.x, center.y + 0.05, center.z, 8, 3.4, 0.16, owner, false, fp);
        this.sideStreaks(slot, vfx.count(20), 1.3);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'mire-maw-bite-lunge': {
        // Bite: a bright streak along the whole lane, a flash and tooth glint at its tip, black water flung from the jaws.
        const life = Math.max(0.12, Math.min(0.3, seconds));
        slot.beam = vfx.beams.acquire(owner, time, 0, 0.5, 0.025, 'poison');
        if (slot.beam) {
          fp.toWorld(0, -fp.halfLength, slot.beam.a, 0.55); fp.toWorld(0, fp.halfLength, slot.beam.b, 0.55);
          slot.beam.alpha = 0.9;
        }
        this.laneStreaks(slot, vfx.count(30), 1, 30);
        fp.toWorld(0, fp.halfLength - 0.5, this.a, 0.5);
        vfx.flash(this.a.x, this.a.y, this.a.z, 1.6, 'earth', owner, life);
        this.starGlint(slot, this.a, 1, life * 1.4, 'wind');
        vfx.sparks(this.a.x, this.a.y, this.a.z, 12, 5, 'poison', owner, 0.3);
        for (let i = vfx.count(12); i > 0; i--) this.drop(owner, this.a.x, this.a.y, this.a.z, fp.forwardX * vfx.range(2, 5) + vfx.range(-1.2, 1.2), vfx.range(0.5, 2.8), fp.forwardZ * vfx.range(2, 5) + vfx.range(-1.2, 1.2), BLACK_SAP, 0.08, 0.55);
        fp.toWorld(0, fp.halfLength - 0.6, this.b);
        vfx.dustRing(this.b.x, fp.cy, this.b.z, Math.min(fp.halfWidth, 0.9), 16, owner, MUD);
        this.shake(this.b, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'mire-maw-black-river-wave': {
        // The Black River wave: three crescents of Black Sap roll along the band, black foam and droplets ride them.
        const life = Math.max(0.32, Math.min(0.62, seconds));
        for (let i = 0; i < 3; i++) {
          fp.toWorld(0, -fp.halfLength - 0.4, this.a, 0.3 + i * 0.12); fp.toWorld(0, fp.halfLength + 0.4, this.b, 0.3 + i * 0.12);
          vfx.blades.spawn(this.a, this.b, fp.halfWidth * 2 * (0.95 - i * 0.12), fp.angle, time + i * 0.07, life, owner, 'poison');
        }
        vfx.ground.spawn('shock', fp, 'poison', owner, time, 0.4);
        vfx.ground.spawn('decal', fp, 'poison', owner, time, 5, 1, slot.glow);
        slot.ground = vfx.ground.spawn('burn', fp, 'poison', owner, time, 0, 0.22);
        for (let i = 0; i < 10; i++) { fp.sample(vfx.random(), vfx.random(), this.a, 0.1, 0.85); vfx.smoke(this.a.x, this.a.y, this.a.z, 2, 0.3, 0.4, 1.3, 1.3, BLACK_SAP, 0.42, owner, 0.6); }
        for (let i = vfx.count(24); i > 0; i--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.1, 0.85); this.drop(owner, this.a.x, this.a.y, this.a.z, Math.cos(fp.angle) * vfx.range(2, 5), vfx.range(1.5, 4), -Math.sin(fp.angle) * vfx.range(2, 5), SAP_SHEEN, 0.08, 0.7); }
        this.sideStreaks(slot, vfx.count(28), 1.6);
        vfx.lights.pulse(center.x, center.y + 1, center.z, PALETTE.poison.hot, 3, 8, 0.45, time, owner);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
    }
  }

  private updateActive(slot: KitSlot, t: number, dt: number): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint, envelope = Math.min(1, t * 8) * Math.min(1, (1 - t) * 4);
    switch (slot.kit as MistveilKitId) {
      case 'bog-lurker-tongue-lash':
        if (slot.beam) slot.beam.alpha = Math.sin(Math.PI * Math.min(1, t * 1.02)) * 0.9 + 0.1;
        for (let n = this.due(slot, 30, dt); n > 0; n--) this.laneStreaks(slot, 1, 1, 26);
        return;
      case 'bog-lurker-bubble-pool':
        // Bubbling pool: soft rising murk, popping bubbles and the odd droplet fountaining out of the surface.
        if (slot.ground) vfx.ground.drive(slot.ground, 1, 0.3, Math.min(1, t * 20) * Math.min(1, (1 - t) * 10));
        for (let n = this.due(slot, 14, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.05, 0.75); vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.3, 0.12, vfx.range(1.6, 2.6), 2.2, BLACK_SAP, 0.34, owner, 0.25); }
        for (let n = this.due(slot, 24, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0, 0.8); vfx.bubbles(this.a.x, this.a.y, this.a.z, 1, 0.05, owner, 'poison'); }
        for (let n = this.due(slot, 6, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.05, 0.7); this.drop(owner, this.a.x, this.a.y, this.a.z, vfx.range(-0.4, 0.4), vfx.range(1.4, 2.4), vfx.range(-0.4, 0.4), BLACK_SAP, 0.06, 0.6); }
        for (let n = this.due(slot, 5, dt, 4); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.1, 0.7); vfx.glow(this.a.x, this.a.y, this.a.z, 0.3, 0.7, 'poison', 0.25, owner, 0.2); }
        return;
      case 'bog-lurker-mud-hop':
        for (let n = this.due(slot, 8, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0, 0.8); vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.2, 0.4, 0.8, 1, MUD, 0.33, owner, 0.3); }
        for (let n = this.due(slot, 8, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.05, 0.75); vfx.bubbles(this.a.x, this.a.y, this.a.z, 1, 0.05, owner, 'wind'); }
        return;
      case 'lantern-heron-spear-dive': {
        // The heron's own trail: streaks and spray behind the body, mist skating along the lane below it.
        const body = this.body(slot, this.a), feet = this.feet(slot, this.b);
        for (let n = this.due(slot, 90, dt); n > 0; n--) this.streak(owner, body.x + vfx.range(-0.5, 0.5), body.y + vfx.range(-0.5, 0.5), body.z + vfx.range(-0.5, 0.5), -fp.forwardX * vfx.range(5, 9), vfx.range(-0.2, 0.3), -fp.forwardZ * vfx.range(5, 9), vfx.range(0.2, 0.36), 0.08, 0.13, PALETTE.wind.hot, 0.55);
        for (let n = this.due(slot, 40, dt, 2); n > 0; n--) this.drop(owner, feet.x + vfx.range(-0.5, 0.5), feet.y + 0.1, feet.z + vfx.range(-0.5, 0.5), -fp.forwardX * vfx.range(1, 3) + vfx.range(-1, 1), vfx.range(1, 3), -fp.forwardZ * vfx.range(1, 3) + vfx.range(-1, 1), SPRAY, 0.06, 0.5);
        for (let n = this.due(slot, 50, dt, 3); n > 0; n--) vfx.smoke(feet.x, fp.cy, feet.z, 1, 0.5, 0.2, 1, 0.9, MIST, 0.34, owner, 0.9);
        for (let n = this.due(slot, 8, dt, 4); n > 0; n--) vfx.glow(body.x, body.y, body.z, 0.7, 0.12, 'wind', 0.3, owner);
        return;
      }
      case 'lantern-heron-mist-gust':
        for (let n = this.due(slot, 26, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.2, 0.8); vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.25, 0.2, vfx.range(1.2, 1.8), 1, MIST, 0.3, owner, 0.9); }
        this.coneStreaks(slot, this.due(slot, 40, dt, 2), 1, 9);
        return;
      case 'lantern-heron-flare-burst':
        // Lantern motes drift down and fade across the footprint; the glow holds as long as the hazard does.
        for (let n = this.due(slot, 24, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.6 + vfx.random() * 1.2, 0.8); vfx.glow(this.a.x, this.a.y, this.a.z, 0.14, 0.9, 'gold', 0.45 * envelope, owner, -0.5); }
        for (let n = this.due(slot, 8, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.1, 0.75); vfx.glow(this.a.x, this.a.y, this.a.z, 0.5, 0.5, 'gold', 0.22, owner, 0.2); }
        return;
      case 'mire-maw-tail-sweep': {
        // The sweep head travels across the band: mud, black droplets and wind streaks shed from it.
        const head = this.sweepHead(slot, t, this.a);
        for (let n = this.due(slot, 90, dt); n > 0; n--) this.drop(owner, head.x + vfx.range(-0.2, 0.2), head.y, head.z + vfx.range(-0.2, 0.2), Math.cos(fp.angle) * vfx.range(3, 6) + vfx.range(-0.5, 0.5), vfx.range(0.8, 2.6), -Math.sin(fp.angle) * vfx.range(3, 6) + vfx.range(-0.5, 0.5), BLACK_SAP, 0.07, 0.5);
        for (let n = this.due(slot, 40, dt, 2); n > 0; n--) vfx.smoke(head.x, head.y, head.z, 1, 0.3, 0.2, 0.9, 0.8, MUD, 0.4, owner, 0.5);
        for (let n = this.due(slot, 24, dt, 3); n > 0; n--) this.sideStreak(slot, head, 5, 0.25, PALETTE.earth.b, 0.45);
        vfx.glow(head.x, head.y + 0.1, head.z, 0.9, 0.1, 'earth', 0.2, owner);
        return;
      }
      case 'mire-maw-bite-lunge':
        if (slot.beam) slot.beam.alpha = Math.sin(Math.PI * Math.min(1, t * 1.02)) * 0.9 + 0.1;
        for (let n = this.due(slot, 40, dt); n > 0; n--) this.laneStreaks(slot, 1, 1, 30);
        return;
      case 'mire-maw-black-river-wave': {
        // The wave front crosses the band: Black Sap spray and foam thrown off it, the sheen fading behind it.
        if (slot.ground) vfx.ground.drive(slot.ground, 1, 0.22, envelope);
        const head = this.sweepHead(slot, t, this.a);
        for (let n = this.due(slot, 100, dt); n > 0; n--) this.drop(owner, head.x + vfx.range(-0.3, 0.3), head.y, head.z + vfx.range(-0.3, 0.3), Math.cos(fp.angle) * vfx.range(3, 6) + vfx.range(-0.5, 0.5), vfx.range(1, 3), -Math.sin(fp.angle) * vfx.range(3, 6) + vfx.range(-0.5, 0.5), SAP_SHEEN, 0.07, 0.55);
        for (let n = this.due(slot, 40, dt, 2); n > 0; n--) vfx.smoke(head.x, head.y, head.z, 1, 0.4, 0.2, 1.2, 1, BLACK_SAP, 0.42, owner, 0.5);
        for (let n = this.due(slot, 24, dt, 3); n > 0; n--) this.sideStreak(slot, head, 5, 0.25, PALETTE.poison.b, 0.45);
        vfx.glow(head.x, head.y + 0.1, head.z, 1, 0.1, 'poison', 0.24, owner);
        return;
      }
    }
  }

  // ---- decay ----

  private decay(slot: KitSlot): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint, center = this.center(fp, this.c), r = Math.min(fp.halfWidth, fp.halfLength);
    switch (slot.kit as MistveilKitId) {
      case 'bog-lurker-tongue-lash':
        for (let i = vfx.count(6); i > 0; i--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.5, 0.7); this.drop(owner, this.a.x, this.a.y, this.a.z, 0, 0, 0, SPRAY, 0.05, 0.5); }
        break;
      case 'bog-lurker-bubble-pool':
        vfx.smoke(center.x, center.y, center.z, 8, r * 0.8, 0.35, 2, 1.6, BLACK_SAP, 0.25, owner, 0.6);
        break;
      case 'bog-lurker-mud-hop':
        vfx.smoke(center.x, center.y, center.z, 6, r * 0.8, 0.4, 1, 1.4, MUD, 0.3, owner, 0.3);
        vfx.bubbles(center.x, center.y, center.z, 4, r * 0.7, owner, 'wind');
        break;
      case 'lantern-heron-spear-dive': {
        // Impact gust at the far end of the lane, kept inside the lane footprint.
        const radius = Math.min(fp.halfWidth, 1.1);
        fp.toWorld(0, Math.max(0, fp.halfLength - radius), this.a);
        slot.aux.set('disk', this.a.x, fp.cy, this.a.z, fp.angle, radius, radius);
        vfx.ground.spawn('shock', slot.aux, 'wind', owner, vfx.time, 0.4);
        vfx.ground.spawn('decal', slot.aux, 'wind', owner, vfx.time, 3.5);
        vfx.dustRing(this.a.x, fp.cy, this.a.z, radius, 20, owner, SPRAY);
        for (let i = vfx.count(8); i > 0; i--) this.drop(owner, this.a.x, fp.cy + 0.2, this.a.z, vfx.range(-2, 2) + fp.forwardX * 2, vfx.range(1.5, 3.5), vfx.range(-2, 2) + fp.forwardZ * 2, SPRAY, 0.06, 0.6);
        this.shake(this.a, 0.16);
        break;
      }
      case 'lantern-heron-mist-gust':
        vfx.smoke(center.x, center.y, center.z, 5, r * 0.6, 0.3, 1.4, 1.4, MIST, 0.22, owner, 0.5);
        break;
      case 'lantern-heron-flare-burst':
        vfx.glow(center.x, center.y + 0.8, center.z, r * 1.2, 0.8, 'gold', 0.18, owner, 0.6);
        vfx.smoke(center.x, center.y + 0.3, center.z, 4, r * 0.5, 0.4, 1.2, 1.4, MIST, 0.2, owner, 0.4);
        break;
      case 'mire-maw-tail-sweep':
        vfx.smoke(center.x, center.y, center.z, 6, r, 0.2, 1.4, 1.4, MUD, 0.28, owner, 0.5);
        break;
      case 'mire-maw-bite-lunge':
        for (let i = vfx.count(6); i > 0; i--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.5, 0.7); this.drop(owner, this.a.x, this.a.y, this.a.z, 0, 0, 0, BLACK_SAP, 0.06, 0.55); }
        break;
      case 'mire-maw-black-river-wave':
        vfx.smoke(center.x, center.y, center.z, 8, r * 0.8, 0.3, 1.8, 1.6, BLACK_SAP, 0.3, owner, 0.6);
        break;
    }
  }

  // ---- particle helpers ----

  /** Thin velocity-stretched additive streak (wind lines, hop trails, strike lines). */
  private streak(owner: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, width: number, stretch: number, color: Color, alpha: number): void {
    const vfx = this.vfx, p = vfx.spec();
    p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz; p.drag = 2; p.life = life; p.size0 = width; p.size1 = width * 0.4; p.frame = VFX_FRAME.spark; p.stretch = stretch;
    p.r0 = p.r1 = color.r; p.g0 = p.g1 = color.g; p.b0 = p.b1 = color.b; p.a0 = alpha; p.fadeIn = 0.15; p.fadeOut = 0.5;
    vfx.emit(vfx.particles.additive, owner);
  }

  private streakColor(slot: KitSlot): Color {
    return slot.element === 'wind' ? PALETTE.wind.hot : slot.element === 'poison' ? PALETTE.poison.b : PALETTE.earth.hot;
  }

  /** Streaks racing along the lane (+Z in the footprint frame) at random lane positions. */
  private laneStreaks(slot: KitSlot, count: number, reach: number, speed: number): void {
    const vfx = this.vfx, fp = slot.footprint, color = this.streakColor(slot);
    for (let i = count; i > 0; i--) {
      fp.toWorld((vfx.random() - 0.5) * 2 * fp.halfWidth * 0.8, -fp.halfLength + vfx.random() * fp.halfLength * 2 * reach, this.b, vfx.range(0.15, 0.85));
      this.streak(slot.owner, this.b.x, this.b.y, this.b.z, fp.forwardX * speed, 0, fp.forwardZ * speed, vfx.range(0.18, 0.34), 0.07, 0.14, color, 0.55);
    }
  }

  /** Streaks racing along the band (local +X) of a wave footprint. */
  private sideStreaks(slot: KitSlot, count: number, reach: number): void {
    const vfx = this.vfx, fp = slot.footprint, color = this.streakColor(slot);
    for (let i = count; i > 0; i--) {
      fp.toWorld(-fp.halfWidth * 0.9 + vfx.random() * fp.halfWidth * 1.8 * Math.min(1, reach), (vfx.random() - 0.5) * 2 * fp.halfLength * 0.8, this.b, vfx.range(0.1, 0.5));
      this.sideStreak(slot, this.b, vfx.range(5, 8), 0.2, color, 0.55);
    }
  }

  private sideStreak(slot: KitSlot, at: Vector3, speed: number, life: number, color: Color, alpha: number): void {
    const a = slot.footprint.angle;
    this.streak(slot.owner, at.x, at.y, at.z, Math.cos(a) * speed, 0, -Math.sin(a) * speed, life + this.vfx.random() * 0.12, 0.07, 0.14, color, alpha);
  }

  /** Streaks fanning out of a cone's apex through the sector (inside its aperture), up to `reach` of its length. */
  private coneStreaks(slot: KitSlot, count: number, reach: number, speed: number): void {
    const vfx = this.vfx, fp = slot.footprint, color = this.streakColor(slot);
    for (let i = count; i > 0; i--) {
      const ang = fp.angle + (vfx.random() - 0.5) * fp.aperture * 0.8, range = fp.halfLength * vfx.range(0.15, 0.85) * clamp01(reach);
      this.streak(slot.owner, fp.cx + Math.sin(ang) * range, fp.cy + vfx.range(0.3, 1.1), fp.cz + Math.cos(ang) * range, Math.sin(ang) * speed, 0, Math.cos(ang) * speed, vfx.range(0.18, 0.34), 0.07, 0.14, color, 0.5);
    }
  }

  /** Falling droplet (mud, pond water or Black Sap) tinted by `color`, alpha-blended so it never washes out to white. */
  private drop(owner: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, color: Color, size: number, life: number): void {
    const vfx = this.vfx, p = vfx.spec();
    p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz; p.gravity = 8; p.drag = 0.35; p.life = life; p.size0 = size; p.size1 = size * 0.7; p.frame = VFX_FRAME.drop;
    p.r0 = p.r1 = color.r; p.g0 = p.g1 = color.g; p.b0 = p.b1 = color.b; p.a0 = 0.9; p.fadeIn = 0.05; p.fadeOut = 0.7;
    vfx.emit(vfx.particles.alpha, owner);
  }

  /** Hard round glob core of a murk glob (additive droplet frame in the hot poison colour). */
  private globCore(slot: KitSlot, at: Vector3, size: number): void {
    const vfx = this.vfx, hot = PALETTE.poison.hot, p = vfx.spec();
    p.x = at.x; p.y = at.y; p.z = at.z; p.life = 0.1; p.size0 = p.size1 = size; p.frame = VFX_FRAME.drop;
    p.r0 = p.r1 = hot.r; p.g0 = p.g1 = hot.g; p.b0 = p.b1 = hot.b; p.a0 = 0.9; p.fadeIn = 0.05; p.fadeOut = 0.4;
    vfx.emit(vfx.particles.additive, slot.owner);
  }

  /** Four-point glint flare (tooth glints, lantern glints). */
  private starGlint(slot: KitSlot, at: Vector3, size: number, life: number, element: VfxElement): void {
    const vfx = this.vfx, hot = PALETTE[element].hot, p = vfx.spec();
    p.x = at.x; p.y = at.y; p.z = at.z; p.life = life; p.size0 = size * 0.6; p.size1 = size; p.frame = VFX_FRAME.star; p.spin = vfx.random() * 6.28;
    p.r0 = p.r1 = hot.r; p.g0 = p.g1 = hot.g; p.b0 = p.b1 = hot.b; p.a0 = 0.8; p.fadeIn = 0.1; p.fadeOut = 0.6;
    vfx.emit(vfx.particles.additive, slot.owner);
  }

  /** Settling grit inside the telegraphed footprint during anticipation. */
  private groundDust(slot: KitSlot, t: number, dt: number, stream: 1 | 2 | 3 | 4, rate: number, color: Color): void {
    const vfx = this.vfx, fp = slot.footprint, reach = 0.35 + 0.55 * t;
    for (let n = this.due(slot, rate, dt, stream); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * reach, this.b, 0.05, 0.8); vfx.smoke(this.b.x, this.b.y, this.b.z, 1, 0.15, 0.3, 0.6, 0.7, color, 0.3, slot.owner, 0.2); }
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

  /** Mouth / jaws / lantern: the manifest `cast` socket, else the authored source point lifted to chest height. */
  private socketPosition(slot: KitSlot, out: Vector3): Vector3 {
    if (slot.socket) { slot.socket.updateWorldMatrix(true, false); return slot.socket.getWorldPosition(out); }
    const from = slot.cue.from ?? slot.cue.position;
    return out.set(from?.x ?? 0, (from?.y ?? 0) + 1.1, from?.z ?? 0);
  }

  /** Drawn body centre: the rendered root, else the authored source point lifted to body height. */
  private body(slot: KitSlot, out: Vector3): Vector3 {
    const root = this.root(slot);
    if (root) { root.updateWorldMatrix(true, false); return root.getWorldPosition(out); }
    const from = slot.cue.from ?? slot.cue.position;
    return out.set(from?.x ?? 0, (from?.y ?? 0) + 1, from?.z ?? 0);
  }

  /** Horizontal position of the body with y at the simulation floor (mud rings and ground effects stay on the ground). */
  private feet(slot: KitSlot, out: Vector3): Vector3 {
    const root = this.root(slot);
    if (root) { root.updateWorldMatrix(true, false); root.getWorldPosition(out); } else { const from = slot.cue.from ?? slot.cue.position; out.set(from?.x ?? 0, from?.y ?? 0, from?.z ?? 0); }
    out.y = slot.cue.from?.y ?? slot.footprint.cy;
    return out;
  }

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
