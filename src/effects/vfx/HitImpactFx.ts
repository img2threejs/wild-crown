import { Color, Vector3, type Object3D } from 'three';
import type { StoryCue } from '../story-cues.js';
import type { ActorBodies } from './ActorBounds.js';
import { Footprint } from './footprint.js';
import { PALETTE, type VfxElement } from './palette.js';
import { VFX_FRAME } from './VfxAtlas.js';
import { VFX_COLORS, type VfxSystem } from './VfxSystem.js';

/**
 * Age (s) given to every particle of a confirmed contact. Particles ease alpha in from age 0 and the world clock stands
 * still during hit-stop, so without this the burst would be invisible until the freeze ends (see `VfxSystem.beginContact`).
 */
export const CONTACT_PRE_AGE = 0.02;
/** One damage point is 1/12 of a basic light hit's weight (`intensity = damage / 12` in the engine). */
const DAMAGE_PER_WEIGHT = 12;
const BLOOD = new Color().setRGB(0.5, 0.016, 0.012);
const BLOOD_DARK = new Color().setRGB(0.24, 0.009, 0.008);
const MIST = new Color().setRGB(0.3, 0.022, 0.018);
const SAP = new Color().setRGB(0.42, 0.62, 0.12);
const FLYER = /hornbill|heron|wisp|bat\b/;
const PLANT = /root|sprig|rammer|koro|grove|vine|thorn|treant|bark|stalker|lurker/;
const ICE = /frost|rime|ice|glacier/;

type ContactMaterial = 'flesh' | 'plant' | 'ice';

function contactMaterial(targetId: string | undefined): ContactMaterial {
  const key = (targetId ?? '').toLowerCase();
  if (ICE.test(key)) return 'ice';
  return PLANT.test(key) ? 'plant' : 'flesh';
}

const HEAVY_ACTION = /heavy|charged|cleave/;

/**
 * The substance of one confirmed contact: directional blood droplets and mist from a monster body, material debris,
 * a short dust puff and, for heavy blows only, a restrained grounded shockwave. Hero kits keep their own colour accent
 * (flash, sparks, cut line); this layer is the same for every hero so impact size always follows the damage dealt.
 * Everything uses the shared bounded particle/ground pools and `vfx.count`, so reduced-effects scales it down and
 * `killOwner` cancels it with its scope. Blood is capped and short-lived (no decals, no persistence, no gore).
 */
export class HitImpactFx {
  private readonly point = new Vector3();
  private readonly root = new Vector3();
  private readonly ring = new Footprint();
  private dx = 0;
  private dz = 1;
  private groundY = 0;
  /** Presentation weight of the contact being drawn (scales with the vitality actually lost) and its tier: 0 basic, 1 solid, 2 heavy. */
  private weight = 1;
  private tier = 0;

  constructor(
    private readonly vfx: VfxSystem,
    private readonly resolveRoot: (actorId: string) => Object3D | undefined,
    private readonly bodies: ActorBodies | undefined,
  ) {}

  /** A hit that dealt no damage (blocked, evaded, absorbed) never draws, whichever kit would have handled it. */
  static suppressed(cue: StoryCue): boolean { return cue.confirmedDamage !== undefined && !(cue.confirmedDamage > 0); }

  /**
   * Draws the substance layer for a player strike on a monster. Only a cue that carries proof of lost vitality
   * (`confirmedDamage > 0`) qualifies: legacy cues without it keep their kit accent but get no blood. Returns false otherwise.
   */
  play(cue: StoryCue, element: VfxElement, owner: number): boolean {
    if (!(cue.confirmedDamage! > 0) || cue.actorId !== 'aren' || !cue.targetId || cue.targetId === 'aren' || !this.locate(cue)) return false;
    const vfx = this.vfx, material = contactMaterial(cue.targetId);
    this.weight = Math.min(2.2, Math.max(0.4, cue.confirmedDamage! / DAMAGE_PER_WEIGHT));
    this.tier = HEAVY_ACTION.test(cue.actionId ?? '') || this.weight >= 1.5 ? 2 : this.weight >= 0.95 ? 1 : 0;
    const { weight, tier } = this;
    vfx.beginContact(CONTACT_PRE_AGE);
    try {
      this.blood(owner, weight, tier);
      if (material === 'plant') this.sap(owner, weight);
      else if (material === 'ice') vfx.shards(this.point.x, this.point.y, this.point.z, 4 + Math.round(2 * weight), 2.6 + weight, owner);
      if (!FLYER.test(cue.targetId)) this.grounded(owner, element, weight, tier);
    } finally { vfx.endContact(); }
    return true;
  }

  /** Contact point from the engine cue, kept inside the drawn body so hovering or scaled monsters get it on their body. */
  private locate(cue: StoryCue): boolean {
    const at = cue.position ?? cue.to ?? cue.from;
    if (!at) return false;
    this.point.set(at.x, at.y, at.z);
    const root = cue.targetId ? this.resolveRoot(cue.targetId) : undefined;
    this.groundY = at.y - 0.9;
    if (root) {
      root.updateWorldMatrix(true, false);
      root.getWorldPosition(this.root);
      const height = this.bodies?.get(root).height ?? 1.2;
      this.groundY = this.root.y;
      this.point.y = Math.min(this.root.y + height * 0.95, Math.max(this.root.y + height * 0.25, at.y));
    }
    const to = cue.to;
    let dx = to ? to.x - at.x : 0, dz = to ? to.z - at.z : 0;
    if (dx * dx + dz * dz < 1e-6) {
      const attacker = cue.actorId ? this.resolveRoot(cue.actorId) : undefined;
      if (attacker) { attacker.updateWorldMatrix(true, false); attacker.getWorldPosition(this.root); dx = at.x - this.root.x; dz = at.z - this.root.z; }
    }
    const length = Math.hypot(dx, dz);
    if (length < 1e-4) { dx = 0; dz = 1; } else { dx /= length; dz /= length; }
    this.dx = dx; this.dz = dz;
    return true;
  }

  /** Directional red spray along the blow: droplets, a few fast stretched streaks, a small entry back-spatter and a short mist.
 *  Tier 0 keeps the original counts; tier 1 (solid light/heavy) scales the burst ~2×, tier 2 (heavy/charged/cleave) ~3×. */
  private blood(owner: number, weight: number, tier: number): void {
    const vfx = this.vfx, { dx, dz } = this, p = this.point;
    const burst = tier >= 2 ? 3 : tier >= 1 ? 2 : 1;
    for (let i = vfx.count(burst * (9 + 9 * weight)); i > 0; i--) {
      const s = vfx.range(2.4, 5.6 + 1.6 * weight), side = vfx.range(-0.5, 0.5), q = vfx.spec();
      q.x = p.x; q.y = p.y; q.z = p.z;
      q.vx = (dx - dz * side) * s; q.vz = (dz + dx * side) * s; q.vy = vfx.range(0.05, 0.65) * s * 0.7 + 0.8;
      q.gravity = 9.5; q.drag = 0.5; q.life = vfx.range(0.45, 0.85); q.size0 = vfx.range(0.045, 0.085); q.size1 = 0.03; q.frame = VFX_FRAME.drop;
      const c = vfx.random() < 0.35 ? BLOOD_DARK : BLOOD;
      q.r0 = c.r; q.g0 = c.g; q.b0 = c.b; q.r1 = BLOOD_DARK.r; q.g1 = BLOOD_DARK.g; q.b1 = BLOOD_DARK.b; q.a0 = 0.95; q.fadeIn = 0.02; q.fadeOut = 0.6;
      vfx.emit(vfx.particles.alpha, owner);
    }
    for (let i = vfx.count(burst * (3 + 3 * weight)); i > 0; i--) {
      const s = vfx.range(7, 11), side = vfx.range(-0.35, 0.35), q = vfx.spec();
      q.x = p.x; q.y = p.y; q.z = p.z;
      q.vx = (dx - dz * side) * s; q.vz = (dz + dx * side) * s; q.vy = vfx.range(0.2, 1.8);
      q.gravity = 7; q.drag = 1.2; q.life = vfx.range(0.22, 0.4); q.size0 = 0.04; q.size1 = 0.02; q.frame = VFX_FRAME.drop; q.stretch = 0.045;
      q.r0 = BLOOD.r; q.g0 = BLOOD.g; q.b0 = BLOOD.b; q.r1 = BLOOD_DARK.r; q.g1 = BLOOD_DARK.g; q.b1 = BLOOD_DARK.b; q.a0 = 0.85; q.fadeIn = 0.02; q.fadeOut = 0.5;
      vfx.emit(vfx.particles.alpha, owner);
    }
    for (let i = vfx.count(burst * (3 + 2 * weight)); i > 0; i--) {
      const s = vfx.range(1.2, 3), side = vfx.range(-0.9, 0.9), q = vfx.spec();
      q.x = p.x; q.y = p.y; q.z = p.z;
      q.vx = (-dx - dz * side) * s; q.vz = (-dz + dx * side) * s; q.vy = vfx.range(0.3, 1.4);
      q.gravity = 9.5; q.drag = 0.8; q.life = vfx.range(0.3, 0.55); q.size0 = vfx.range(0.04, 0.07); q.size1 = 0.025; q.frame = VFX_FRAME.drop;
      q.r0 = BLOOD.r; q.g0 = BLOOD.g; q.b0 = BLOOD.b; q.r1 = BLOOD_DARK.r; q.g1 = BLOOD_DARK.g; q.b1 = BLOOD_DARK.b; q.a0 = 0.9; q.fadeIn = 0.02; q.fadeOut = 0.6;
      vfx.emit(vfx.particles.alpha, owner);
    }
    for (let i = vfx.count(burst * (2 + tier)); i > 0; i--) {
      const q = vfx.spec();
      q.x = p.x; q.y = p.y; q.z = p.z; q.vx = dx * 1.3 + vfx.range(-0.2, 0.2); q.vz = dz * 1.3 + vfx.range(-0.2, 0.2); q.vy = vfx.range(0.2, 0.5);
      q.drag = 3; q.life = vfx.range(0.3, 0.45); q.size0 = 0.22; q.size1 = vfx.range(0.5, 0.7) + 0.08 * weight; q.frame = VFX_FRAME.smoke; q.spin = vfx.random() * 6.28; q.spinRate = vfx.range(-1, 1);
      q.r0 = q.r1 = MIST.r; q.g0 = q.g1 = MIST.g; q.b0 = q.b1 = MIST.b; q.a0 = 0.3; q.fadeIn = 0.1; q.fadeOut = 0.6;
      vfx.emit(vfx.particles.alpha, owner);
    }
  }

  /** Plant-bodied monsters also shed sap droplets and a few leaves alongside the blood. */
  private sap(owner: number, weight: number): void {
    const vfx = this.vfx, { dx, dz } = this, p = this.point;
    for (let i = vfx.count(3 + 2 * weight); i > 0; i--) {
      const s = vfx.range(1.5, 3.8), q = vfx.spec();
      q.x = p.x; q.y = p.y; q.z = p.z; q.vx = dx * s + vfx.range(-1, 1); q.vz = dz * s + vfx.range(-1, 1); q.vy = vfx.range(0.8, 2.4);
      q.gravity = 8; q.drag = 0.5; q.life = vfx.range(0.4, 0.7); q.size0 = vfx.range(0.04, 0.07); q.size1 = 0.03; q.frame = VFX_FRAME.drop;
      q.r0 = q.r1 = SAP.r; q.g0 = q.g1 = SAP.g; q.b0 = q.b1 = SAP.b; q.a0 = 0.9; q.fadeIn = 0.02; q.fadeOut = 0.6;
      vfx.emit(vfx.particles.alpha, owner);
    }
    vfx.leaves(p.x, p.y, p.z, 2, 0.25, this.dx * 1.2, this.dz * 1.2, owner);
  }

  /** Short residual dust at the feet; heavy blows add a restrained expanding ground ring and a few chunks (never in reduced effects).
 *  Heavy contacts also emit a bright star-flash (additive, hero element capped to FLASH_SIZE_MAX via vfx.flash) and a
 *  larger expanding shock ring (the `shock` ground foot is scaled with weight, up to ~3 m radius). The pools and frozen-frame
 *  visibility stay bounded: the star particles are emitted inside the active contact window. */
  private grounded(owner: number, element: VfxElement, weight: number, tier: number): void {
    const vfx = this.vfx, p = this.point;
    vfx.smoke(p.x - this.dx * 0.2, this.groundY + 0.1, p.z - this.dz * 0.2, 1 + tier * 2, 0.3, 0.45, 0.6 + 0.12 * weight, 0.6, VFX_COLORS.dust, 0.22 + 0.06 * tier, owner, 0.7);
    if (tier < 2 || vfx.reducedEffects) return;
    // Bright star-flash: additive particles using VFX_FRAME.star, hot core colour, short life, capped via limitContact.
    const palette = PALETTE[element] ?? PALETTE.arcane;
    for (let i = vfx.count(2 + tier); i > 0; i--) {
      const q = vfx.spec();
      q.x = p.x + vfx.range(-0.05, 0.05); q.y = p.y + vfx.range(-0.05, 0.05); q.z = p.z + vfx.range(-0.05, 0.05);
      q.vx = 0; q.vy = 0; q.vz = 0; q.life = vfx.range(0.12, 0.18); q.size0 = vfx.range(0.55, 0.85); q.size1 = 0.05; q.frame = VFX_FRAME.star;
      q.r0 = q.r1 = palette.hot.r; q.g0 = q.g1 = palette.hot.g; q.b0 = q.b1 = palette.hot.b; q.a0 = 0.95; q.fadeIn = 0.01; q.fadeOut = 0.7;
      vfx.emit(vfx.particles.additive, owner);
    }
    const radius = 0.8 + 0.35 * weight;
    vfx.dustRing(p.x, this.groundY, p.z, radius * 0.8, 8, owner);
    vfx.chunks(p.x, this.groundY + 0.1, p.z, 3, 2.6, 0.1, owner);
    this.ring.set('disk', p.x, this.groundY, p.z, 0, radius, radius);
    vfx.ground.spawn('shock', this.ring, element, owner, vfx.birthTime, 0.36);
  }
}
