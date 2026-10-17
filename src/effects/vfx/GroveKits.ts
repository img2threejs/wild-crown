import { Color, Vector3, type Object3D } from 'three';
import type { AuraTheme } from './ActorVfx.js';
import type { FocusSource } from './CanopyKits.js';
import type { ImpactSink, KitSlot, MapKitFamily, SocketResolver } from './ElementKits.js';
import type { Footprint } from './footprint.js';
import { PALETTE, type VfxElement } from './palette.js';
import { VFX_FRAME } from './VfxAtlas.js';
import type { VfxSystem } from './VfxSystem.js';

/**
 * Grove monster kits: the kit id is the attack id of the Heartroot Sprig (like CanopyKits) or of Hollowheart; the blighted rootling plays the
 * sprig's three kits in the sickly `poison` element with dark petals and dust. The practice partner spars in amber and green: golden-green
 * sap-light for the seed toss, amber earth for the ripple, soft green and rose petals for the sweep. Every sprig kit is deliberately
 * gentle (small flashes, tiny shake, no debris), reads as a lesson rather than a threat, and stays inside the authored footprint. The
 * guardian's four kits are heavier: a leap and smash in earth, a wood-splintering sweep, a hurled clot of Black Sap and the cracked
 * heart-light bursting in gold; still footprint-bound, with a modest shake and no extra draw call.
 */
export const GROVE_KIT_IDS = [
  'sprig-seed-toss', 'sprig-ground-ripple', 'sprig-petal-sweep',
  'hollowheart-leap-smash', 'hollowheart-antler-sweep', 'hollowheart-ichor-hurl', 'hollowheart-heartlight-burst',
] as const;
export type GroveKitId = typeof GROVE_KIT_IDS[number];
const GROVE_KITS: Readonly<Record<string, true>> = Object.fromEntries(GROVE_KIT_IDS.map(id => [id, true]));
export const isGroveKit = (kit: string): kit is GroveKitId => GROVE_KITS[kit] === true;

/** Attack id → [kit id, presentation element]: gold-green sap light, amber earth, spirit green; sickly poison for the blight; earth, sap, poison and gold for the guardian. */
export const GROVE_ATTACK_KITS: Readonly<Record<string, readonly [GroveKitId, VfxElement]>> = {
  'sprig-seed-toss': ['sprig-seed-toss', 'sap'],
  'sprig-ground-ripple': ['sprig-ground-ripple', 'earth'],
  'sprig-petal-sweep': ['sprig-petal-sweep', 'spirit'],
  'blighted-seed-lob': ['sprig-seed-toss', 'poison'],
  'blighted-ground-pulse': ['sprig-ground-ripple', 'poison'],
  'blighted-lash-sweep': ['sprig-petal-sweep', 'poison'],
  'hollowheart-leap-smash': ['hollowheart-leap-smash', 'earth'],
  'hollowheart-antler-sweep': ['hollowheart-antler-sweep', 'sap'],
  'hollowheart-ichor-hurl': ['hollowheart-ichor-hurl', 'poison'],
  'hollowheart-heartlight-burst': ['hollowheart-heartlight-burst', 'gold'],
};
/** Monster id → idle body aura theme drawn by ActorVfx: soft earth motes for the practice partner, toxic motes for the blight, the Howler's sap-bound motes plus the glowing cracked heart for the guardian. */
export const GROVE_AURAS: Readonly<Record<string, AuraTheme>> = { 'grove-sprig': 'earth', 'grove-blighted': 'toxic', 'grove-hollowheart': 'heartlight' };

const SHAKE_RADIUS = 6;
const SHAKE_WEIGHT: Readonly<Record<GroveKitId, number>> = {
  'sprig-seed-toss': 0.05, 'sprig-ground-ripple': 0.04, 'sprig-petal-sweep': 0.03,
  'hollowheart-leap-smash': 0.2, 'hollowheart-antler-sweep': 0.1, 'hollowheart-ichor-hurl': 0.08, 'hollowheart-heartlight-burst': 0.16,
};

// Alpha-blended tints (never HDR): rose and cream petals, dry meadow dust; sap-black petals and dust of the blight, Black Sap smoke.
const PETAL_ROSE = new Color().setRGB(0.88, 0.46, 0.56);
const PETAL_CREAM = new Color().setRGB(0.92, 0.82, 0.58);
const PETAL_BLIGHT = new Color().setRGB(0.16, 0.2, 0.08);
const PETAL_BLIGHT_PALE = new Color().setRGB(0.34, 0.38, 0.12);
const MEADOW_DUST = new Color().setRGB(0.46, 0.4, 0.17);
const BLIGHT_DUST = new Color().setRGB(0.12, 0.13, 0.07);
const BLACK_SAP = new Color().setRGB(0.05, 0.045, 0.06);
const BARK_DUST = new Color().setRGB(0.3, 0.2, 0.1);

const clamp01 = (t: number): number => t < 0 ? 0 : t > 1 ? 1 : t;
/** The blighted rootling plays the sprig kits in `poison`: dark petals and dust instead of rose, cream and meadow gold. */
const blighted = (slot: KitSlot): boolean => slot.element === 'poison';
/**
 * The ground fill is additive and its alpha is soft, so over the dark blighted and sap-mud ground a 1x tell all but vanishes. The sparring
 * sprig keeps a gentle 1.5x (a lesson, not a threat); the blighted rootling and the guardian's marks glow 2.2x (the gold heart-light burst 1x so it
 * stays amber) and also switch on the
 * fill's contrast-aware tell (an even, denser body and a broken rim just inside the edge, `DARK_TELL`) so the safe ground reads from ~35% of
 * every windup without the late windup washing out to white.
 */
const DARK_TELL = 0.8;
const darkGround = (slot: KitSlot): boolean => slot.kit.startsWith('hollowheart') || blighted(slot);
const telegraphGain = (slot: KitSlot): number => (darkGround(slot) ? (slot.element === 'gold' ? 1 : 2.2) : 1.5);

/** One rose or cream petal drifting down (leaf frame, alpha blended); `blight` makes it a sap-black one. `delay` schedules it for a later moment. */
export function emitPetal(vfx: VfxSystem, owner: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, delay = 0, blight = false): void {
  const p = vfx.spec(), color = blight ? (vfx.random() > 0.5 ? PETAL_BLIGHT : PETAL_BLIGHT_PALE) : (vfx.random() > 0.5 ? PETAL_ROSE : PETAL_CREAM);
  p.x = x + vfx.range(-0.12, 0.12); p.y = y + vfx.range(-0.08, 0.08); p.z = z + vfx.range(-0.12, 0.12); p.vx = vx; p.vy = vy; p.vz = vz; p.delay = delay;
  p.gravity = 0.7; p.drag = 1.2; p.life = vfx.range(1.2, 2); p.size0 = p.size1 = vfx.range(0.12, 0.2);
  p.spin = vfx.random() * 6.28; p.spinRate = vfx.range(-5, 5); p.frame = VFX_FRAME.leaf;
  p.r0 = p.r1 = color.r; p.g0 = p.g1 = color.g; p.b0 = p.b1 = color.b; p.a0 = 0.9; p.fadeIn = 0.05; p.fadeOut = 0.7;
  vfx.emit(vfx.particles.alpha, owner);
}

/**
 * Presentation kits for the Grove attacks. Every kit is a pure function of its cue (authored footprint, phase window,
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
      if (slot.ground) vfx.ground.drive(slot.ground, progress, (0.8 + 0.25 * progress) * telegraphGain(slot), Math.min(1, (worldTick - cue.worldTick) / 6 + 0.25), darkGround(slot) ? DARK_TELL : 0);
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
    const vfx = this.vfx, owner = slot.owner, element = slot.element, dark = blighted(slot);
    switch (slot.kit as GroveKitId) {
      case 'sprig-seed-toss':
        // The seed leaves the hand where it was held; the lob lands exactly when the active phase (the hazard) opens.
        slot.origin.y += 0.3;
        vfx.sparks(slot.origin.x, slot.origin.y, slot.origin.z, 8, 2.4, element, owner, 0.5);
        vfx.glow(slot.origin.x, slot.origin.y, slot.origin.z, 0.7, 0.25, element, 0.4, owner);
        break;
      case 'sprig-ground-ripple': {
        const feet = this.feet(slot, this.a);
        vfx.dustRing(feet.x, this.groundY(slot), feet.z, 0.8, 12, owner, dark ? BLIGHT_DUST : MEADOW_DUST);
        vfx.leaves(feet.x, this.groundY(slot) + 0.2, feet.z, 5, 0.7, 0, 0, owner);
        break;
      }
      case 'sprig-petal-sweep': {
        const hand = this.socketPosition(slot, this.a);
        for (let i = vfx.count(8); i > 0; i--) emitPetal(vfx, owner, hand.x, hand.y, hand.z, vfx.range(-1, 1) + slot.footprint.forwardX * 1.5, vfx.range(0.3, 1.2), vfx.range(-1, 1) + slot.footprint.forwardZ * 1.5, 0, dark);
        break;
      }
      case 'hollowheart-leap-smash': {
        // The guardian pushes off: a ring of bark dust and torn leaves at its feet as the leap begins.
        const feet = this.feet(slot, this.a);
        vfx.dustRing(feet.x, this.groundY(slot), feet.z, 1.6, 20, owner, BARK_DUST);
        vfx.leaves(feet.x, this.groundY(slot) + 0.2, feet.z, 8, 1.2, 0, 0, owner);
        vfx.sparks(feet.x, this.groundY(slot) + 0.2, feet.z, 8, 2.6, 'earth', owner, 0.4);
        break;
      }
      case 'hollowheart-antler-sweep': {
        // Splinters and sap flick off the swollen arm as it comes round.
        const hand = this.socketPosition(slot, this.a);
        vfx.sparks(hand.x, hand.y, hand.z, 10, 3, 'sap', owner, 0.3);
        vfx.leaves(hand.x, hand.y, hand.z, 6, 0.8, slot.footprint.forwardX * 2, slot.footprint.forwardZ * 2, owner);
        break;
      }
      case 'hollowheart-ichor-hurl':
        // The clot leaves the fist: a smear of Black Sap and a short dark flash at the hand.
        slot.origin.y += 0.3;
        vfx.smoke(slot.origin.x, slot.origin.y, slot.origin.z, 4, 0.3, 0.3, 0.9, 0.8, BLACK_SAP, 0.45, owner, 0.4);
        vfx.sparks(slot.origin.x, slot.origin.y, slot.origin.z, 6, 2.2, 'poison', owner, 0.5);
        break;
      case 'hollowheart-heartlight-burst': {
        // The heart-light lurches up the chest: a gold flare at the chest and cracks of light along the marked ground's edge.
        const chest = this.chest(slot, this.a);
        vfx.flash(chest.x, chest.y, chest.z, 1.4, 'gold', owner, 0.2);
        vfx.sparks(chest.x, chest.y, chest.z, 12, 2.8, 'gold', owner, 0.5);
        break;
      }
    }
  }

  // ---- anticipation ----

  private updateAnticipation(slot: KitSlot, t: number, dt: number): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint, element = slot.element, dark = blighted(slot);
    switch (slot.kit as GroveKitId) {
      case 'sprig-seed-toss': {
        // A golden seed ripens in the raised hand: sap-light pulls together, warm glints rise inside the landing mark.
        const hold = this.socketPosition(slot, this.a);
        hold.y += 0.3;
        vfx.gather(hold.x, hold.y, hold.z, this.due(slot, 26, dt), 0.7, element, owner);
        for (let n = this.due(slot, 6, dt, 2); n > 0; n--) vfx.glow(hold.x, hold.y, hold.z, 0.35 + 0.35 * t, 0.3, element, 0.3, owner);
        for (let n = this.due(slot, 10, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.05, 0.8); vfx.glow(this.b.x, this.b.y, this.b.z, 0.12, 0.7, element, 0.4, owner, 0.5); }
        return;
      }
      case 'sprig-ground-ripple': {
        // The grass trembles along the band the ripple will run: loose blades and amber dust lift, the base draws the earth in.
        const feet = this.feet(slot, this.a), y = this.groundY(slot);
        vfx.gather(feet.x, y + 0.4, feet.z, this.due(slot, 14, dt), 1, element, owner);
        for (let n = this.due(slot, 14, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.1, 0.8); vfx.leaves(this.b.x, this.b.y, this.b.z, 1, 0.1, 0, 0, owner); }
        for (let n = this.due(slot, 12, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.05, 0.8); vfx.smoke(this.b.x, this.b.y, this.b.z, 1, 0.1, 0.25, 0.6, 0.8, dark ? BLIGHT_DUST : MEADOW_DUST, 0.26, owner, 0.1); }
        return;
      }
      case 'sprig-petal-sweep': {
        // Petals gather round the open hands and the lane starts to glimmer.
        const hand = this.socketPosition(slot, this.a);
        vfx.gather(hand.x, hand.y, hand.z, this.due(slot, 22, dt), 0.8, element, owner);
        for (let n = this.due(slot, 9, dt, 2); n > 0; n--) emitPetal(vfx, owner, hand.x, hand.y, hand.z, vfx.range(-0.8, 0.8), vfx.range(0.1, 0.8), vfx.range(-0.8, 0.8), 0, dark);
        for (let n = this.due(slot, 10, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.15, 0.85); vfx.glow(this.b.x, this.b.y, this.b.z, 0.12, 0.6, element, 0.4, owner); }
        return;
      }
      case 'hollowheart-leap-smash': {
        // The guardian crouches and the ground it will land on darkens and trembles: earth gathers at its feet, dust and glints lift inside the mark.
        const feet = this.feet(slot, this.a), y = this.groundY(slot);
        vfx.gather(feet.x, y + 0.5, feet.z, this.due(slot, 22, dt), 1.4, 'earth', owner);
        for (let n = this.due(slot, 14, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.1, 0.8); vfx.smoke(this.b.x, this.b.y, this.b.z, 1, 0.12, 0.3, 0.7, 0.9, BARK_DUST, 0.28, owner, 0.1); }
        for (let n = this.due(slot, 10, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.05, 0.8); vfx.glow(this.b.x, this.b.y, this.b.z, 0.14, 0.7, 'earth', 0.4, owner, 0.5); }
        return;
      }
      case 'hollowheart-antler-sweep': {
        // The swollen arm drags back trailing Black Sap and splinters; the lane glimmers amber.
        const hand = this.socketPosition(slot, this.a);
        vfx.gather(hand.x, hand.y, hand.z, this.due(slot, 18, dt), 1, 'sap', owner);
        for (let n = this.due(slot, 8, dt, 2); n > 0; n--) vfx.smoke(hand.x, hand.y, hand.z, 1, 0.2, 0.2, 0.7, 0.9, BLACK_SAP, 0.4, owner, 0.2);
        for (let n = this.due(slot, 10, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.15, 0.85); vfx.glow(this.b.x, this.b.y, this.b.z, 0.14, 0.6, 'sap', 0.4, owner); }
        return;
      }
      case 'hollowheart-ichor-hurl': {
        // A clot of Black Sap swells in the raised fist: dark smoke pulls in, sickly glints rise inside the landing mark.
        const hold = this.socketPosition(slot, this.a);
        hold.y += 0.3;
        vfx.gather(hold.x, hold.y, hold.z, this.due(slot, 24, dt), 0.9, 'poison', owner);
        for (let n = this.due(slot, 8, dt, 2); n > 0; n--) vfx.smoke(hold.x, hold.y, hold.z, 1, 0.25, 0.3, 0.6 + 0.4 * t, 0.8, BLACK_SAP, 0.5, owner, 0.15);
        for (let n = this.due(slot, 10, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.05, 0.8); vfx.glow(this.b.x, this.b.y, this.b.z, 0.12, 0.7, 'poison', 0.4, owner, 0.5); }
        return;
      }
      case 'hollowheart-heartlight-burst': {
        // The cracked heart-light brightens through the chest, pulling gold in; glints rise inside the marked square.
        const chest = this.chest(slot, this.a);
        vfx.gather(chest.x, chest.y, chest.z, this.due(slot, 30, dt), 1.2, 'gold', owner);
        for (let n = this.due(slot, 6, dt, 2); n > 0; n--) vfx.glow(chest.x, chest.y, chest.z, 0.6 + 0.9 * t, 0.3, 'gold', 0.35, owner);
        for (let n = this.due(slot, 14, dt, 3); n > 0; n--) { fp.sample(vfx.random(), vfx.random() * (0.35 + 0.55 * t), this.b, 0.05, 0.85); vfx.glow(this.b.x, this.b.y, this.b.z, 0.14, 0.8, 'gold', 0.45, owner, 0.6); }
        return;
      }
    }
  }

  // ---- commit ----

  private updateCommit(slot: KitSlot, t: number, dt: number): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint, element = slot.element, dark = blighted(slot);
    switch (slot.kit as GroveKitId) {
      case 'sprig-seed-toss': {
        // The seed flies in an arc from the hand to the committed point: a glowing head, a short sparkling trail.
        const head = this.lob(slot.origin, this.landing(slot, this.d), t, this.a, 1);
        for (let n = this.due(slot, 90, dt); n > 0; n--) vfx.glow(head.x + vfx.range(-0.08, 0.08), head.y + vfx.range(-0.08, 0.08), head.z + vfx.range(-0.08, 0.08), 0.42, 0.12, element, 0.5, owner);
        for (let n = this.due(slot, 40, dt, 2); n > 0; n--) vfx.sparks(head.x, head.y, head.z, 1, 1.2, element, owner, 0.2);
        for (let n = this.due(slot, 8, dt, 3); n > 0; n--) emitPetal(vfx, owner, head.x, head.y, head.z, vfx.range(-0.3, 0.3), vfx.range(-0.2, 0.3), vfx.range(-0.3, 0.3), 0, dark);
        return;
      }
      case 'sprig-ground-ripple': {
        // Preview of the ripple: blades and amber streaks run along the band toward Aren.
        for (let n = this.due(slot, 26, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.b, 0.1, 0.85); this.sideStreak(slot, this.b, 3 + 3 * t, 0.2, PALETTE[element].hot, 0.45); }
        for (let n = this.due(slot, 14, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.b, 0.15, 0.85); vfx.leaves(this.b.x, this.b.y, this.b.z, 1, 0.1, Math.cos(fp.angle) * 1.6, -Math.sin(fp.angle) * 1.6, owner); }
        return;
      }
      case 'sprig-petal-sweep': {
        // The lane draws itself: soft green streaks and a drift of petals race down it ahead of the sweep.
        this.laneStreaks(slot, this.due(slot, 40, dt), 0.9, 7);
        for (let n = this.due(slot, 14, dt, 2); n > 0; n--) { fp.toWorld((vfx.random() - 0.5) * 2 * fp.halfWidth * 0.7, -fp.halfLength + vfx.random() * fp.halfLength * 2 * t, this.b, vfx.range(0.3, 0.9)); emitPetal(vfx, owner, this.b.x, this.b.y, this.b.z, fp.forwardX * 1.4, vfx.range(0, 0.5), fp.forwardZ * 1.4, 0, dark); }
        return;
      }
      case 'hollowheart-leap-smash': {
        // The leap: dust streams off the airborne body and the mark's glints thicken as the landing nears.
        const feet = this.feet(slot, this.a);
        for (let n = this.due(slot, 30, dt); n > 0; n--) vfx.smoke(feet.x, feet.y + 0.4, feet.z, 1, 0.5, 0.2, 0.8, 0.7, BARK_DUST, 0.25, owner, 0.3);
        for (let n = this.due(slot, 24, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.b, 0.1, 0.85); vfx.glow(this.b.x, this.b.y, this.b.z, 0.16 + 0.12 * t, 0.5, 'earth', 0.45, owner, 0.4); }
        return;
      }
      case 'hollowheart-antler-sweep': {
        // The lane draws itself in amber streaks while splinters fly ahead of the swing.
        this.laneStreaks(slot, this.due(slot, 44, dt), 0.9, 8, PALETTE.sap.hot);
        for (let n = this.due(slot, 12, dt, 2); n > 0; n--) { fp.toWorld((vfx.random() - 0.5) * 2 * fp.halfWidth * 0.7, -fp.halfLength + vfx.random() * fp.halfLength * 2 * t, this.b, vfx.range(0.3, 0.9)); vfx.leaves(this.b.x, this.b.y, this.b.z, 1, 0.1, fp.forwardX * 1.6, fp.forwardZ * 1.6, owner); }
        return;
      }
      case 'hollowheart-ichor-hurl': {
        // The clot flies in an arc from the fist to the committed point, trailing Black Sap smoke.
        const head = this.lob(slot.origin, this.landing(slot, this.d), t, this.a, 1.1);
        for (let n = this.due(slot, 70, dt); n > 0; n--) vfx.smoke(head.x + vfx.range(-0.1, 0.1), head.y + vfx.range(-0.1, 0.1), head.z + vfx.range(-0.1, 0.1), 1, 0.12, 0.1, 0.55, 0.6, BLACK_SAP, 0.55, owner, 0.1);
        for (let n = this.due(slot, 40, dt, 2); n > 0; n--) vfx.glow(head.x, head.y, head.z, 0.4, 0.12, 'poison', 0.5, owner);
        for (let n = this.due(slot, 20, dt, 3); n > 0; n--) vfx.sparks(head.x, head.y, head.z, 1, 1.4, 'poison', owner, 0.2);
        return;
      }
      case 'hollowheart-heartlight-burst': {
        // Rays of gold climb the edge of the marked square ahead of the burst.
        for (let n = this.due(slot, 36, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.b, 0.1, 0.9); this.riseStreak(slot, this.b, 2 + 3 * t, PALETTE.gold.hot); }
        for (let n = this.due(slot, 8, dt, 2); n > 0; n--) { const chest = this.chest(slot, this.a); vfx.glow(chest.x, chest.y, chest.z, 1 + 0.8 * t, 0.25, 'gold', 0.4, owner); }
        return;
      }
    }
  }

  // ---- active ----

  private detonate(slot: KitSlot, seconds: number): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint, time = vfx.time, kit = slot.kit as GroveKitId, element = slot.element, dark = blighted(slot);
    const center = this.center(fp, this.c);
    switch (kit) {
      case 'sprig-seed-toss': {
        // The seed bursts on the mark in a soft bloom: a gentle shock, a faint decal, drifting pollen and petals.
        const r = Math.min(fp.halfWidth, fp.halfLength);
        vfx.flash(center.x, center.y + 0.4, center.z, r * 1.6, element, owner, 0.2);
        vfx.ground.spawn('shock', fp, element, owner, time, 0.4);
        vfx.ground.spawn('decal', fp, dark ? 'poison' : 'earth', owner, time, 4, 1, slot.glow);
        vfx.sparks(center.x, center.y + 0.2, center.z, 20, 3.6, element, owner, 0.7);
        vfx.dustRing(center.x, center.y, center.z, r * 0.8, 16, owner, dark ? BLIGHT_DUST : MEADOW_DUST);
        vfx.leaves(center.x, center.y + 0.3, center.z, 8, r * 0.7, 0, 0, owner);
        for (let i = vfx.count(8); i > 0; i--) emitPetal(vfx, owner, center.x, center.y + 0.2, center.z, vfx.range(-1.4, 1.4), vfx.range(0.8, 2), vfx.range(-1.4, 1.4), 0, dark);
        vfx.lights.pulse(center.x, center.y + 1, center.z, PALETTE[element].hot, 4, 6, 0.45, time, owner);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'sprig-ground-ripple': {
        // The ripple runs across the band: a scuff decal, a burst of blades and a travelling head (see updateActive).
        vfx.ground.spawn('shock', fp, element, owner, time, 0.36);
        vfx.ground.spawn('decal', fp, element, owner, time, 3.5, 1, slot.glow);
        for (let i = 0; i < 5; i++) { fp.toWorld((i / 4 - 0.5) * 2 * fp.halfWidth * 0.85, 0, this.a, 0.15); vfx.leaves(this.a.x, this.a.y, this.a.z, 2, 0.25, Math.cos(fp.angle) * 3.5, -Math.sin(fp.angle) * 3.5, owner); }
        for (let n = vfx.count(18); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.b, 0.1, 0.85); this.sideStreak(slot, this.b, vfx.range(3.5, 6), 0.2, PALETTE[element].hot, 0.5); }
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'sprig-petal-sweep': {
        // A fan of petals sweeps down the lane under a soft green beam; the lane is bright for the whole active window.
        const life = Math.max(0.12, Math.min(0.3, seconds));
        slot.beam = vfx.beams.acquire(owner, time, 0, 0.4, 0.02, element);
        if (slot.beam) {
          fp.toWorld(0, -fp.halfLength, slot.beam.a, 0.5); fp.toWorld(0, fp.halfLength, slot.beam.b, 0.5);
          slot.beam.alpha = 0.7;
        }
        vfx.ground.spawn('shock', fp, element, owner, time, 0.36);
        vfx.ground.spawn('decal', fp, element, owner, time, 3.5, 1, slot.glow);
        this.laneStreaks(slot, vfx.count(26), 1, 14);
        for (let i = vfx.count(18); i > 0; i--) {
          fp.toWorld((vfx.random() - 0.5) * 2 * fp.halfWidth * 0.8, -fp.halfLength + vfx.random() * fp.halfLength * 2, this.a, vfx.range(0.3, 0.9));
          emitPetal(vfx, owner, this.a.x, this.a.y, this.a.z, fp.forwardX * vfx.range(2, 4) + vfx.range(-0.5, 0.5), vfx.range(0.3, 1.2), fp.forwardZ * vfx.range(2, 4) + vfx.range(-0.5, 0.5), 0, dark);
        }
        fp.toWorld(0, fp.halfLength - 0.5, this.b, 0.5);
        vfx.flash(this.b.x, this.b.y, this.b.z, 1, element, owner, life);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'hollowheart-leap-smash': {
        // The landing: a flash, a hard shock ring, a scorched decal, bark dust and torn leaves thrown outward.
        const r = Math.min(fp.halfWidth, fp.halfLength);
        vfx.flash(center.x, center.y + 0.3, center.z, r * 1.6, 'earth', owner, 0.22);
        vfx.ground.spawn('shock', fp, 'earth', owner, time, 0.45);
        vfx.ground.spawn('decal', fp, 'earth', owner, time, 5, 1, slot.glow);
        vfx.sparks(center.x, center.y + 0.2, center.z, 26, 4.4, 'earth', owner, 0.7);
        vfx.dustRing(center.x, center.y, center.z, r, 26, owner, BARK_DUST);
        vfx.leaves(center.x, center.y + 0.3, center.z, 12, r * 0.8, 0, 0, owner);
        vfx.smoke(center.x, center.y + 0.2, center.z, 6, r * 0.8, 0.5, 1.2, 1.2, BARK_DUST, 0.3, owner, 0.6);
        vfx.lights.pulse(center.x, center.y + 1, center.z, PALETTE.earth.hot, 5, 7, 0.5, time, owner);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'hollowheart-antler-sweep': {
        // The sweep cuts down the lane under an amber beam, throwing wood chips, sap and leaves ahead of it.
        const life = Math.max(0.12, Math.min(0.3, seconds));
        slot.beam = vfx.beams.acquire(owner, time, 0, 0.5, 0.02, 'sap');
        if (slot.beam) {
          fp.toWorld(0, -fp.halfLength, slot.beam.a, 0.6); fp.toWorld(0, fp.halfLength, slot.beam.b, 0.6);
          slot.beam.alpha = 0.75;
        }
        vfx.ground.spawn('shock', fp, 'sap', owner, time, 0.4);
        vfx.ground.spawn('decal', fp, 'earth', owner, time, 4, 1, slot.glow);
        this.laneStreaks(slot, vfx.count(30), 1, 16, PALETTE.sap.hot);
        for (let i = vfx.count(16); i > 0; i--) {
          fp.toWorld((vfx.random() - 0.5) * 2 * fp.halfWidth * 0.8, -fp.halfLength + vfx.random() * fp.halfLength * 2, this.a, vfx.range(0.3, 1));
          vfx.leaves(this.a.x, this.a.y, this.a.z, 1, 0.2, fp.forwardX * vfx.range(3, 5), fp.forwardZ * vfx.range(3, 5), owner);
          vfx.sparks(this.a.x, this.a.y, this.a.z, 1, 2.4, 'sap', owner, 0.4);
        }
        fp.toWorld(0, fp.halfLength - 0.5, this.b, 0.6);
        vfx.flash(this.b.x, this.b.y, this.b.z, 1.2, 'sap', owner, life);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'hollowheart-ichor-hurl': {
        // The clot bursts on the mark: a dark splash, sickly sparks, a lingering stain decal and a heavy smoke ring.
        const r = Math.min(fp.halfWidth, fp.halfLength);
        vfx.flash(center.x, center.y + 0.4, center.z, r * 1.4, 'poison', owner, 0.2);
        vfx.ground.spawn('shock', fp, 'poison', owner, time, 0.4);
        vfx.ground.spawn('decal', fp, 'poison', owner, time, 6, 1, slot.glow);
        vfx.sparks(center.x, center.y + 0.2, center.z, 24, 3.8, 'poison', owner, 0.7);
        vfx.dustRing(center.x, center.y, center.z, r, 18, owner, BLIGHT_DUST);
        vfx.smoke(center.x, center.y + 0.3, center.z, 8, r * 0.8, 0.5, 1, 1.4, BLACK_SAP, 0.5, owner, 0.6);
        vfx.lights.pulse(center.x, center.y + 1, center.z, PALETTE.poison.hot, 4, 6, 0.4, time, owner);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
      case 'hollowheart-heartlight-burst': {
        // The heart-light bursts out of the marked square: a gold flash, a shock ring, a bright decal, a fountain of sparks and a rising column of glints.
        const r = Math.min(fp.halfWidth, fp.halfLength);
        vfx.flash(center.x, center.y + 0.6, center.z, r * 1.8, 'gold', owner, 0.28);
        vfx.ground.spawn('shock', fp, 'gold', owner, time, 0.5);
        vfx.ground.spawn('decal', fp, 'gold', owner, time, 5, 1, slot.glow);
        vfx.sparks(center.x, center.y + 0.2, center.z, 34, 5, 'gold', owner, 1.1);
        for (let n = vfx.count(14); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.b, 0.1, 0.9); vfx.glow(this.b.x, this.b.y, this.b.z, 0.5, 0.7, 'gold', 0.6, owner, 1.2); }
        vfx.lights.pulse(center.x, center.y + 1.2, center.z, PALETTE.gold.hot, 6, 8, 0.55, time, owner);
        this.shake(center, SHAKE_WEIGHT[kit]);
        break;
      }
    }
  }

  private updateActive(slot: KitSlot, t: number, dt: number): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint, element = slot.element, dark = blighted(slot);
    switch (slot.kit as GroveKitId) {
      case 'sprig-seed-toss':
        // Pollen lifts off the bloom and drifts upward.
        for (let n = this.due(slot, 10, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.05, 0.8); vfx.glow(this.a.x, this.a.y, this.a.z, 0.1, 0.9, element, 0.4, owner, 0.5); }
        for (let n = this.due(slot, 5, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.1, 0.75); emitPetal(vfx, owner, this.a.x, this.a.y, this.a.z, vfx.range(-0.2, 0.2), vfx.range(0.4, 0.9), vfx.range(-0.2, 0.2), 0, dark); }
        return;
      case 'sprig-ground-ripple': {
        // The ripple head travels across the band: blades, amber dust and sparks shed from it.
        const head = this.sweepHead(slot, t, this.a);
        for (let n = this.due(slot, 80, dt); n > 0; n--) vfx.leaves(head.x, head.y, head.z, 1, 0.3, Math.cos(fp.angle) * 3.5, -Math.sin(fp.angle) * 3.5, owner);
        for (let n = this.due(slot, 40, dt, 2); n > 0; n--) vfx.smoke(head.x, head.y, head.z, 1, 0.3, 0.2, 0.6, 0.7, dark ? BLIGHT_DUST : MEADOW_DUST, 0.3, owner, 0.4);
        for (let n = this.due(slot, 24, dt, 3); n > 0; n--) vfx.sparks(head.x, head.y + 0.1, head.z, 1, 1.8, element, owner, 0.4);
        vfx.glow(head.x, head.y + 0.1, head.z, 0.9, 0.1, element, 0.2, owner);
        return;
      }
      case 'sprig-petal-sweep': {
        if (slot.beam) slot.beam.alpha = Math.sin(Math.PI * Math.min(1, t * 1.02)) * 0.7 + 0.1;
        for (let n = this.due(slot, 30, dt); n > 0; n--) this.laneStreaks(slot, 1, 1, 14);
        for (let n = this.due(slot, 16, dt, 2); n > 0; n--) { fp.toWorld((vfx.random() - 0.5) * 2 * fp.halfWidth * 0.8, -fp.halfLength + vfx.random() * fp.halfLength * 2, this.a, vfx.range(0.3, 0.9)); emitPetal(vfx, owner, this.a.x, this.a.y, this.a.z, fp.forwardX * 2.2, vfx.range(0.2, 0.8), fp.forwardZ * 2.2, 0, dark); }
        return;
      }
      case 'hollowheart-leap-smash':
        // Dust and bark settle over the crater.
        for (let n = this.due(slot, 20, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.1, 0.8); vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.2, 0.3, 0.7, 0.9, BARK_DUST, 0.25, owner, 0.3); }
        for (let n = this.due(slot, 8, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.1, 0.8); vfx.leaves(this.a.x, this.a.y, this.a.z, 1, 0.2, 0, 0, owner); }
        return;
      case 'hollowheart-antler-sweep': {
        if (slot.beam) slot.beam.alpha = Math.sin(Math.PI * Math.min(1, t * 1.02)) * 0.75 + 0.1;
        for (let n = this.due(slot, 34, dt); n > 0; n--) this.laneStreaks(slot, 1, 1, 16, PALETTE.sap.hot);
        for (let n = this.due(slot, 14, dt, 2); n > 0; n--) { fp.toWorld((vfx.random() - 0.5) * 2 * fp.halfWidth * 0.8, -fp.halfLength + vfx.random() * fp.halfLength * 2, this.a, vfx.range(0.3, 0.9)); vfx.leaves(this.a.x, this.a.y, this.a.z, 1, 0.2, fp.forwardX * 2.6, fp.forwardZ * 2.6, owner); }
        return;
      }
      case 'hollowheart-ichor-hurl':
        // Sap smoke seeps off the stain.
        for (let n = this.due(slot, 14, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.1, 0.8); vfx.smoke(this.a.x, this.a.y, this.a.z, 1, 0.15, 0.35, 0.6, 1, BLACK_SAP, 0.35, owner, 0.15); }
        for (let n = this.due(slot, 8, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.05, 0.75); vfx.glow(this.a.x, this.a.y, this.a.z, 0.1, 0.8, 'poison', 0.4, owner, 0.5); }
        return;
      case 'hollowheart-heartlight-burst':
        // The light column rises: glints lift off the whole square and drift upward.
        for (let n = this.due(slot, 40, dt); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.05, 0.9); vfx.glow(this.a.x, this.a.y, this.a.z, 0.16, 0.9, 'gold', 0.5, owner, 1.2); }
        for (let n = this.due(slot, 16, dt, 2); n > 0; n--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.1, 0.9); this.riseStreak(slot, this.a, 4, PALETTE.gold.hot); }
        return;
    }
  }

  // ---- decay ----

  private decay(slot: KitSlot): void {
    const vfx = this.vfx, owner = slot.owner, fp = slot.footprint, center = this.center(fp, this.c), r = Math.min(fp.halfWidth, fp.halfLength), dark = blighted(slot);
    switch (slot.kit as GroveKitId) {
      case 'sprig-seed-toss':
        vfx.smoke(center.x, center.y, center.z, 5, r * 0.8, 0.4, 1, 1.4, dark ? BLIGHT_DUST : MEADOW_DUST, 0.22, owner, 0.3);
        break;
      case 'sprig-ground-ripple':
        fp.toWorld(0, fp.halfLength, this.a, 0.3);
        vfx.leaves(this.a.x, this.a.y, this.a.z, 6, fp.halfWidth * 0.7, fp.forwardX * 1.2, fp.forwardZ * 1.2, owner);
        break;
      case 'sprig-petal-sweep':
        for (let i = vfx.count(8); i > 0; i--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.4, 0.8); emitPetal(vfx, owner, this.a.x, this.a.y, this.a.z, vfx.range(-0.2, 0.2), vfx.range(0, 0.3), vfx.range(-0.2, 0.2), 0, dark); }
        break;
      case 'hollowheart-leap-smash':
        vfx.smoke(center.x, center.y, center.z, 6, r * 0.9, 0.4, 1.2, 1.6, BARK_DUST, 0.22, owner, 0.3);
        break;
      case 'hollowheart-antler-sweep':
        for (let i = vfx.count(8); i > 0; i--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.4, 0.8); vfx.leaves(this.a.x, this.a.y, this.a.z, 1, 0.2, fp.forwardX * 1.2, fp.forwardZ * 1.2, owner); }
        break;
      case 'hollowheart-ichor-hurl':
        vfx.smoke(center.x, center.y, center.z, 6, r * 0.8, 0.4, 1, 1.6, BLACK_SAP, 0.25, owner, 0.3);
        break;
      case 'hollowheart-heartlight-burst':
        for (let i = vfx.count(10); i > 0; i--) { fp.sample(vfx.random(), vfx.random(), this.a, 0.3, 0.9); vfx.glow(this.a.x, this.a.y, this.a.z, 0.14, 1.2, 'gold', 0.4, owner, 1); }
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

  /** Streak rising straight up from a point on the ground (light column, heart-light rays). */
  private riseStreak(slot: KitSlot, at: Vector3, speed: number, color: Color): void {
    this.streak(slot.owner, at.x, at.y, at.z, 0, speed * (0.7 + 0.6 * this.vfx.random()), 0, 0.32 + this.vfx.random() * 0.2, 0.07, 0.16, color, 0.55);
  }

  // ---- geometry helpers ----

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

  /** Hand: the manifest `cast` socket, else the authored source point lifted to chest height. */
  private socketPosition(slot: KitSlot, out: Vector3): Vector3 {
    if (slot.socket) { slot.socket.updateWorldMatrix(true, false); return slot.socket.getWorldPosition(out); }
    const from = slot.cue.from ?? slot.cue.position;
    return out.set(from?.x ?? 0, (from?.y ?? 0) + 1.1, from?.z ?? 0);
  }

  /** The guardian's chest: the cast socket (the head) lowered by 0.7 m, else the source point lifted to 1.8 m. */
  private chest(slot: KitSlot, out: Vector3): Vector3 {
    if (slot.socket) { slot.socket.updateWorldMatrix(true, false); slot.socket.getWorldPosition(out); out.y -= 0.7; return out; }
    const from = slot.cue.from ?? slot.cue.position;
    return out.set(from?.x ?? 0, (from?.y ?? 0) + 1.8, from?.z ?? 0);
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
