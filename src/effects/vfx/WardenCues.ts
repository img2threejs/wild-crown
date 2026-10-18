import { Matrix4, Quaternion, Vector3 } from 'three';
import type { StoryCue } from '../story-cues.js';
import { CRESCENT_CHORD } from './CrescentFx.js';
import type { KitSlot } from './ElementKits.js';
import { Footprint } from './footprint.js';
import { LIGHT_STEPS, type LightStep } from './HeroKits.js';
import { jaggedPath } from './LightningGen.js';
import { PALETTE, type VfxElement } from './palette.js';
import { VFX_FRAME } from './VfxAtlas.js';
import { ARC_LEVELS, ARC_SECONDS, BOLT_BRANCH_LEVELS, BOLT_BRANCHES, BOLT_RADIALS, BOLT_TRUNK_LEVELS, THUNDER_SECONDS, type ArcState, type BoltState, type WardenFx } from './WardenFx.js';

const UP = new Vector3(0, 1, 0);
const THUNDER_HEIGHT = 9;
const MARK_SPAN = 1.9;
const CLEANSE_SECONDS = 0.7;
const CLEANSE_RISE = 1.7;
const CLEANSE_MOTE_RATE = 46;

/** Cue-driven Warden effects: slashes, rune sigils, projectile launch/impact, Thunder Cleave, Judgement and the hit impact. */
export class WardenCues {
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly c = new Vector3();
  private readonly d = new Vector3();
  private readonly e = new Vector3();
  private readonly normal = new Vector3();
  private readonly quat = new Quaternion();
  private readonly basis = new Matrix4();
  private readonly footprint = new Footprint();
  private readonly tangent = { x: 0, y: 0, z: 0 };
  private readonly random = (): number => this.w.vfx.random();

  constructor(private readonly w: WardenFx) {}

  begin(slot: KitSlot): void {
    switch (slot.kit) {
      case 'sigil': this.beginSigil(slot); return;
      case 'slash': this.beginSlash(slot); return;
      case 'projectile': this.beginProjectile(slot); return;
      case 'projectile-impact': this.beginProjectileImpact(slot); return;
      case 'lightning': this.beginLightning(slot); return;
      case 'judgement': this.beginJudgement(slot); return;
      case 'judgement-mark': this.beginMark(slot); return;
      case 'cleanse': this.beginCleanse(slot); return;
      case 'root-lash': this.beginRootLash(slot); return;
      case 'player-hit': this.playerHit(slot); return;
      default: return;
    }
  }

  update(slot: KitSlot): void {
    if (slot.kit === 'cleanse') { this.updateCleanse(slot); return; }
    if (slot.kit !== 'sigil') return;
    const w = this.w, vfx = w.vfx, player = w.player;
    if (slot.sigil && slot.tracked && player.valid) {
      this.a.set(player.position.x + player.facing.x * 0.9, player.position.y + 1.25, player.position.z + player.facing.z * 0.9);
      this.sigilNormal(player.facing.x, player.facing.z, this.a, this.normal);
      if (slot.sigil.owner === slot.owner) w.sigils.orient(slot.sigil, this.a, this.normal);
      if (slot.sigilGround && slot.sigilGround.owner === slot.owner) w.sigils.orient(slot.sigilGround, this.b.set(player.position.x, player.position.y + 0.05, player.position.z), UP);
    } else if (slot.sigil) this.a.copy(slot.sigil.center);
    else return;
    const rate = (slot.cue.phase === 'sustain' ? 34 : 22) * (vfx.reducedEffects ? 0.35 : 1), carry = slot.acc[0]! + rate * Math.max(0, vfx.time - slot.lastTime);
    slot.acc[0] = carry % 1;
    slot.lastTime = vfx.time;
    if (carry >= 1) vfx.gather(this.a.x, this.a.y, this.a.z, Math.floor(carry), 1, 'arcane', slot.owner);
  }

  end(slot: KitSlot, natural: boolean): void {
    if (slot.kit !== 'sigil' && slot.kit !== 'judgement' && slot.kit !== 'cleanse') return;
    const w = this.w;
    if (slot.sigil && slot.sigil.owner === slot.owner) w.sigils.finish(slot.sigil, w.vfx.time, natural ? 0.32 : 0.12);
    if (slot.sigilGround && slot.sigilGround.owner === slot.owner) w.sigils.finish(slot.sigilGround, w.vfx.time, 0.4);
    slot.sigil = undefined; slot.sigilGround = undefined;
  }

  // ---- sigil ----

  /** Horizontal normal of a vertical rune circle: faces the aim but never edge-on to the locked camera. */
  private sigilNormal(dx: number, dz: number, centre: Vector3, out: Vector3): Vector3 {
    const length = Math.hypot(dx, dz) || 1, cam = this.w.vfx.cameraPosition;
    let x = dx / length, z = dz / length;
    const cx = cam.x - centre.x, cz = cam.z - centre.z, cl = Math.hypot(cx, cz) || 1, ux = cx / cl, uz = cz / cl;
    const facing = x * ux + z * uz, lift = Math.max(0, 0.5 - Math.abs(facing)), sign = facing >= 0 ? 1 : -1;
    x += ux * sign * lift * 1.1; z += uz * sign * lift * 1.1;
    return out.set(x, 0, z).normalize();
  }

  private beginSigil(slot: KitSlot): void {
    const w = this.w, vfx = w.vfx, cue = slot.cue, point = cue.position ?? cue.from ?? w.player.position;
    this.a.set(point.x, point.y, point.z);
    const sustain = cue.phase === 'sustain', fan = !sustain && (cue.intensity ?? 1) > 1.2;
    const aim = cue.to;
    const dx = aim ? aim.x - point.x : w.player.facing.x, dz = aim ? aim.z - point.z : w.player.facing.z;
    this.sigilNormal(dx, dz, this.a, this.normal);
    const ramp = sustain ? Infinity : Math.max(1 / 60, (cue.durationTicks ?? 16) / 60);
    // Barrage launches stack three fan sigils on one spot within ~0.3 s; keep each small and dim so the additive
    // overlap stays a readable glyph burst instead of blooming into a white ball over Aren's chest.
    slot.sigil = w.sigils.spawn(slot.owner, 'vertical', vfx.time, this.a, this.normal, sustain ? 1.15 : fan ? 0.5 : 0.85, ramp, sustain ? 0.95 : fan ? 0.55 : 1.05);
    slot.tracked = cue.actorId === 'aren' && !fan;
    if (sustain) {
      const root = w.player.valid ? w.player.position : this.b.set(point.x, point.y - 1.25, point.z);
      slot.sigilGround = w.sigils.spawn(slot.owner, 'ground', vfx.time, this.c.set(root.x, root.y + 0.05, root.z), UP, 2.1, Infinity, 0.75);
    }
    vfx.flash(this.a.x, this.a.y, this.a.z, 1, 'arcane', slot.owner, 0.14);
    vfx.lights.pulse(this.a.x, this.a.y, this.a.z, PALETTE.arcane.hot, 2.4, 5, 0.3, vfx.time, slot.owner);
    slot.lastTime = vfx.time;
  }

  // ---- blade ----

  private beginSlash(slot: KitSlot): void {
    const w = this.w, cue = slot.cue, action = cue.actionId ?? '', heavy = action.includes('heavy'), ticks = cue.durationTicks ?? 4, intensity = cue.intensity ?? 1;
    const step = LIGHT_STEPS[action];
    w.trailFrom = (cue.worldTick - 2) / 60;
    w.trailUntil = (cue.worldTick + ticks + 2) / 60;
    w.trailElement = heavy ? 'gold' : step?.trail ?? 'arcane';
    if (action === 'aren-charged-heavy') w.trail.setStyle('gold', 1.15, 0.14, 0.65);
    else if (heavy) w.trail.setStyle('gold', 1.1 + 0.15 * intensity, 0.22);
    else if (step) w.trail.setStyle(step.trail, step.intensity + 0.15 * (intensity - 1), step.life, step.width);
    else w.trail.setStyle('arcane', 0.95 + 0.25 * intensity, 0.16);
    w.edgePeak = Math.min(4, 2.2 + 0.9 * intensity); w.edgeBoost = 1;
    const spin = (cue.footprint?.sectorRadians ?? 0) > Math.PI * 1.9, position = cue.position ?? w.player.position, reach = Math.max(1, cue.footprint?.length ?? 2.4);
    if (spin) {
      this.footprint.set('disk', position.x, position.y, position.z, 0, reach, reach);
      w.vfx.ground.spawn('shock', this.footprint, heavy ? 'gold' : 'arcane', slot.owner, w.vfx.time, 0.32, 0.8);
    }
    if (step) this.stepFx(slot, step);
  }

  /**
   * The combo step's own flourish: wind-blade crescents on its swing path and rune motes along the arc. Light 1 = a low wide horizontal
   * sweep, 2 = a narrow rising diagonal, 3 = two opposed blades with orbiting runes, 4 = a heavy downward cleave with falling runes.
   */
  private stepFx(slot: KitSlot, step: LightStep): void {
    const w = this.w, vfx = w.vfx, cue = slot.cue, owner = slot.owner, at = cue.position ?? w.player.position;
    const yaw = cue.footprint?.angleRadians ?? Math.atan2(w.player.facing.x, w.player.facing.z), blade = step.blade;
    if (blade) for (let i = 0; i < blade.count; i++) {
      const heading = yaw + i * blade.spread, dx = Math.sin(heading), dz = Math.cos(heading);
      this.a.set(at.x + dx * 0.5, at.y + blade.y0, at.z + dz * 0.5);
      this.b.set(at.x + dx * (0.5 + blade.reach), at.y + blade.y1, at.z + dz * (0.5 + blade.reach));
      vfx.blades.spawn(this.a, this.b, blade.chord, heading, vfx.time, 0.26, owner, step.trail);
    }
    const arc = Math.min(Math.PI, cue.footprint?.sectorRadians ?? 2.4), palette = PALETTE[step.trail];
    for (let i = vfx.count(step.motes), n = 0; n < i; n++) {
      const u = (n + vfx.random() * 0.8) / i, p = vfx.spec();
      let angle: number, radius: number, height: number, rise: number, swirl: number;
      if (step.motePath === 'orbit') { angle = yaw + u * Math.PI * 2; radius = 1.3; height = 0.9 + vfx.random() * 0.3; rise = 0.3; swirl = 4.5; }
      else if (step.motePath === 'rise') { angle = yaw + (u - 0.5) * 0.6; radius = 1.1 + u * 1.5; height = 0.5 + u * 1.5; rise = 1.3; swirl = 0.6; }
      else if (step.motePath === 'fall') { angle = yaw + (vfx.random() - 0.5) * 0.5; radius = 1 + vfx.random() * 0.8; height = 2.2 - u * 1.9; rise = -2.6; swirl = 0.4; }
      else { angle = yaw + (u - 0.5) * arc; radius = 1.3 + vfx.random() * 0.9; height = 0.8 + vfx.random() * 0.4; rise = 0.5; swirl = 2.2; }
      const dx = Math.sin(angle), dz = Math.cos(angle);
      p.x = at.x + dx * radius; p.y = at.y + height; p.z = at.z + dz * radius;
      p.vx = dz * swirl; p.vy = rise; p.vz = -dx * swirl; p.drag = 1.1; p.life = vfx.range(0.5, 0.85);
      p.size0 = vfx.range(0.07, 0.12); p.size1 = 0.03; p.frame = n % 3 === 0 ? VFX_FRAME.star : VFX_FRAME.mote; p.spin = vfx.random() * 6.28; p.spinRate = vfx.range(-4, 4);
      p.r0 = palette.hot.r; p.g0 = palette.hot.g; p.b0 = palette.hot.b; p.r1 = palette.b.r; p.g1 = palette.b.g; p.b1 = palette.b.b; p.a0 = 0.9; p.fadeIn = 0.08; p.fadeOut = 0.6;
      vfx.emit(vfx.particles.additive, owner);
    }
  }

  // ---- cleanse and root tether (Aren) ----

  /** Cleanse: a rune circle drawn on the ground under the target that rises, shedding upward light motes (see `updateCleanse`). */
  private beginCleanse(slot: KitSlot): void {
    const w = this.w, vfx = w.vfx, cue = slot.cue, owner = slot.owner, at = cue.position ?? w.player.position;
    slot.origin.set(at.x, at.y + 0.05, at.z);
    slot.sigil = w.sigils.spawn(owner, 'ground', vfx.time, slot.origin, UP, 1.5, CLEANSE_SECONDS, 1.05, 'arcane');
    slot.tracked = false;
    slot.lastTime = vfx.time;
    vfx.flash(at.x, at.y + 0.6, at.z, 1.2, 'arcane', owner, 0.2);
    vfx.lights.pulse(at.x, at.y + 1, at.z, PALETTE.arcane.hot, 2.6, 5, 0.5, vfx.time, owner);
    if (cue.targetId) w.impact?.flashActor(cue.targetId, PALETTE.arcane.b, 0.8, 0.5, 'charge');
  }

  private updateCleanse(slot: KitSlot): void {
    const w = this.w, vfx = w.vfx, ring = slot.sigil;
    if (!ring || ring.owner !== slot.owner) return;
    const age = Math.max(0, vfx.time - slot.cue.worldTimeSeconds), t = Math.min(1, age / CLEANSE_SECONDS), lift = CLEANSE_RISE * (1 - (1 - t) * (1 - t));
    w.sigils.orient(ring, this.a.set(slot.origin.x, slot.origin.y + lift, slot.origin.z), UP);
    const carry = slot.acc[0]! + CLEANSE_MOTE_RATE * (vfx.reducedEffects ? 0.35 : 1) * Math.max(0, vfx.time - slot.lastTime);
    slot.lastTime = vfx.time;
    slot.acc[0] = carry % 1;
    const hot = PALETTE.arcane.hot, body = PALETTE.arcane.b;
    for (let n = Math.floor(carry); n > 0; n--) {
      const angle = vfx.random() * Math.PI * 2, radius = 1.35 * (1 - 0.35 * t) * Math.sqrt(vfx.random()), p = vfx.spec();
      p.x = slot.origin.x + Math.cos(angle) * radius; p.y = slot.origin.y + lift; p.z = slot.origin.z + Math.sin(angle) * radius;
      p.vy = vfx.range(1.4, 2.3); p.vx = -Math.sin(angle) * 0.5; p.vz = Math.cos(angle) * 0.5; p.drag = 0.4; p.life = vfx.range(0.5, 0.85);
      p.size0 = vfx.range(0.06, 0.1); p.size1 = 0.02; p.frame = VFX_FRAME.mote;
      p.r0 = hot.r; p.g0 = hot.g; p.b0 = hot.b; p.r1 = body.r; p.g1 = body.g; p.b1 = body.b; p.a0 = 0.9; p.fadeIn = 0.1; p.fadeOut = 0.6;
      vfx.emit(vfx.particles.additive, slot.owner);
    }
  }

  /** Root Tether snap at the target: a cyan wind ring wraps the contact while root leaves and spirit sparks fly (the lash itself is `ActorVfx`'s live beam). */
  private beginRootLash(slot: KitSlot): void {
    const w = this.w, vfx = w.vfx, cue = slot.cue, owner = slot.owner, to = cue.to ?? cue.position;
    if (!to) return;
    this.footprint.set('disk', to.x, to.y + 0.05, to.z, 0, 1.3, 1.3);
    vfx.ground.spawn('shock', this.footprint, 'wind', owner, vfx.time, 0.4, 0.8);
    vfx.gather(to.x, to.y + 1, to.z, 14, 1.1, 'arcane', owner);
    vfx.leaves(to.x, to.y + 0.5, to.z, 8, 0.5, 0, 0, owner);
    vfx.sparks(to.x, to.y + 1, to.z, 12, 3.5, 'spirit', owner, 0.3);
    if (cue.targetId) w.impact?.flashActor(cue.targetId, PALETTE.spirit.b, 1, 0.25, 'hit');
    w.impact?.shake(0.03, 0.14, 24);
  }

  // ---- hit impact ----

  /** Unit swing tangent at the contact point: the real blade travel direction when known, else the action's swing plane. */
  private swingTangent(action: string, hx: number, hz: number, out: Vector3): Vector3 {
    const sampler = this.w.trail.sampler;
    if (sampler.tipDirection(this.tangent)) return out.set(this.tangent.x, this.tangent.y, this.tangent.z);
    const length = Math.hypot(hx, hz) || 1, px = -hz / length, pz = hx / length;
    if (action.endsWith('light-2')) return out.set(px, 0.6, pz).normalize();
    if (action.endsWith('light-4') || action.includes('heavy') || action.includes('charged')) return out.set(0, 1, 0);
    return out.set(px, 0, pz);
  }

  private playerHit(slot: KitSlot): void {
    const w = this.w, vfx = w.vfx, cue = slot.cue, owner = slot.owner;
    const lightning = cue.element === 'lightning', action = cue.actionId ?? '', heavy = action.includes('heavy') || action.includes('charged');
    const cleave = action === 'aren-charged-heavy';
    const element: VfxElement = lightning ? 'lightning' : heavy ? 'gold' : 'arcane';
    const pos = cue.position, intensity = Math.min(3, Math.max(0.3, cue.intensity ?? 1));
    if (!pos) return;
    this.a.set(pos.x, pos.y, pos.z);
    if (cue.to) this.b.set(cue.to.x - pos.x, cue.to.y - pos.y, cue.to.z - pos.z);
    else this.b.set(w.player.facing.x, 0, w.player.facing.z);
    if (this.b.lengthSq() < 1e-8) this.b.set(w.player.facing.x, 0, w.player.facing.z);
    this.b.normalize();
    const palette = PALETTE[element], hot = palette.hot, body = palette.b;
    const hx = this.b.x, hz = this.b.z, scale = cleave ? 0.78 + 0.1 * intensity : 0.7 + 0.5 * intensity;
    // Oriented spark fan: a forward cone around the hit direction plus a short backspray.
    for (let i = vfx.count(cleave ? 12 + 4 * intensity : 12 + 9 * intensity); i > 0; i--) {
      this.e.set(vfx.range(-1, 1), vfx.range(-0.6, 1), vfx.range(-1, 1)).normalize().multiplyScalar(0.62).add(this.b).normalize();
      this.spark(owner, this.a, this.e, vfx.range(4.5, 11), element, vfx.range(0.22, 0.5), vfx.range(0.04, 0.075));
    }
    for (let i = vfx.count(5); i > 0; i--) {
      this.e.set(vfx.range(-1, 1), vfx.range(-0.2, 1), vfx.range(-1, 1)).normalize().multiplyScalar(0.8).sub(this.b).normalize();
      this.spark(owner, this.a, this.e, vfx.range(2.5, 5.5), element, vfx.range(0.15, 0.32), 0.04);
    }
    // Star flash, soft flare and the razor cut line across the contact point (aligned to the swing plane).
    const p = vfx.spec();
    p.x = this.a.x; p.y = this.a.y; p.z = this.a.z; p.frame = VFX_FRAME.star; p.life = cleave ? 0.1 : 0.14; p.size0 = 0.55 * scale; p.size1 = 1.2 * scale; p.spin = vfx.random() * 6.28;
    p.r0 = p.r1 = hot.r; p.g0 = p.g1 = hot.g; p.b0 = p.b1 = hot.b; p.a0 = 0.95; p.fadeIn = 0.05; p.fadeOut = 0.45;
    vfx.emit(vfx.particles.additive, owner);
    p.frame = VFX_FRAME.glow; p.life = cleave ? 0.12 : 0.2; p.size0 = 0.8 * scale; p.size1 = 1.5 * scale; p.a0 = cleave ? 0.25 : 0.45; p.r0 = p.r1 = body.r; p.g0 = p.g1 = body.g; p.b0 = p.b1 = body.b;
    vfx.emit(vfx.particles.additive, owner);
    this.swingTangent(action, hx, hz, this.c);
    const cut = vfx.spec();
    cut.x = this.a.x; cut.y = this.a.y; cut.z = this.a.z; cut.vx = this.c.x * 0.05; cut.vy = this.c.y * 0.05; cut.vz = this.c.z * 0.05; cut.stretch = 0.01;
    cut.frame = VFX_FRAME.cut; cut.life = cleave ? 0.12 : 0.17; cut.size0 = (cleave ? 0.75 : 1.5) * scale; cut.size1 = (cleave ? 1.2 : 2.1) * scale;
    cut.r0 = cut.r1 = hot.r; cut.g0 = cut.g1 = hot.g; cut.b0 = cut.b1 = hot.b; cut.a0 = 1; cut.fadeIn = 0.04; cut.fadeOut = 0.5;
    vfx.emit(vfx.particles.additive, owner);
    // Cyan energy droplets and a little debris; the monster's blood and material spray is the shared HitImpactFx layer.
    for (let i = vfx.count(4); i > 0; i--) {
      const q = vfx.spec();
      q.x = this.a.x; q.y = this.a.y; q.z = this.a.z; q.vx = hx * vfx.range(1.5, 3.5) + vfx.range(-1, 1); q.vy = vfx.range(1, 2.6); q.vz = hz * vfx.range(1.5, 3.5) + vfx.range(-1, 1);
      q.gravity = 7; q.drag = 0.6; q.life = vfx.range(0.3, 0.55); q.size0 = 0.05; q.size1 = 0.025; q.frame = VFX_FRAME.drop;
      q.r0 = q.r1 = body.r; q.g0 = q.g1 = body.g; q.b0 = q.b1 = body.b; q.a0 = 0.9; q.fadeIn = 0.02; q.fadeOut = 0.6;
      vfx.emit(vfx.particles.additive, owner);
    }
    vfx.chunks(this.a.x, this.a.y - 0.45, this.a.z, 2, 2.4, 0.09, owner);
    if (lightning) vfx.sparks(this.a.x, this.a.y, this.a.z, cleave ? 6 : 14, 8, 'lightning', owner, 0.2);
    if (intensity >= 1.15) vfx.lights.pulse(this.a.x, this.a.y, this.a.z, hot, cleave ? 2.8 : 2.2 + 1.2 * intensity, cleave ? 3 : 5, cleave ? 0.1 : 0.18, vfx.time, owner);
    const impact = w.impact;
    if (cue.targetId) {
      impact?.flashActor(cue.targetId, hot, cleave ? 0.9 : Math.min(2, 1.2 + 0.5 * intensity), cleave ? 0.1 : 0.2, 'hit');
      w.combat.startArcs(cue.targetId, owner, cleave ? lightning ? 2 : 1 : lightning ? 4 : 3, lightning, cleave ? 0.18 : ARC_SECONDS);
    }
    impact?.shake(cleave ? 0.11 : Math.min(0.18, 0.025 + 0.055 * intensity), cleave ? 0.16 : 0.12 + 0.05 * intensity, 30);
    if (intensity >= 1.15) impact?.impulse?.(cleave ? 0.2 : Math.min(0.55, 0.12 + 0.5 * (intensity - 1)), cleave ? 0.1 : 0.16);
    w.edgeBoost = Math.max(w.edgeBoost, 1);
  }

  /** One velocity-stretched additive spark with the hot→body colour ramp (thin, so it may run hot). */
  private spark(owner: number, at: Vector3, dir: Vector3, speed: number, element: VfxElement, life: number, size: number): void {
    const vfx = this.w.vfx, p = vfx.spec(), hot = PALETTE[element].hot, body = PALETTE[element].b;
    p.x = at.x; p.y = at.y; p.z = at.z; p.vx = dir.x * speed; p.vy = dir.y * speed; p.vz = dir.z * speed;
    p.gravity = 6; p.drag = 1.4; p.life = life; p.size0 = size; p.size1 = 0.02; p.frame = VFX_FRAME.spark; p.stretch = 0.09;
    p.r0 = hot.r; p.g0 = hot.g; p.b0 = hot.b; p.r1 = body.r; p.g1 = body.g; p.b1 = body.b; p.fadeIn = 0.02; p.fadeOut = 0.5;
    vfx.emit(vfx.particles.additive, owner);
  }

  // ---- projectiles ----

  private beginProjectile(slot: KitSlot): void {
    const w = this.w, vfx = w.vfx, cue = slot.cue, owner = slot.owner, from = cue.from ?? cue.position;
    if (!from) return;
    const wave = cue.actionId === 'crescent-wave';
    this.a.set(from.x, from.y, from.z);
    if (cue.to) this.b.set(cue.to.x - from.x, cue.to.y - from.y, cue.to.z - from.z); else this.b.set(w.player.facing.x, 0, w.player.facing.z);
    this.b.normalize();
    if (wave) {
      vfx.flash(this.a.x, this.a.y + 0.2, this.a.z, 1.8, 'arcane', owner, 0.18);
      vfx.dustRing(this.a.x, this.a.y - 0.5, this.a.z, 1.1, 12, owner);
      w.impact?.shake(0.07, 0.2, 22);
      w.impact?.impulse?.(0.2, 0.14);
    } else {
      vfx.flash(this.a.x, this.a.y, this.a.z, 1.5, 'arcane', owner, 0.16);
      w.impact?.shake(0.025, 0.12, 26);
    }
    for (let i = vfx.count(wave ? 16 : 10); i > 0; i--) {
      this.e.set(vfx.range(-1, 1), vfx.range(-0.5, 0.8), vfx.range(-1, 1)).normalize().multiplyScalar(0.5).add(this.b).normalize();
      this.spark(owner, this.a, this.e, vfx.range(4, 10), 'arcane', vfx.range(0.25, 0.5), vfx.range(0.04, 0.07));
    }
    vfx.lights.pulse(this.a.x, this.a.y, this.a.z, PALETTE.arcane.hot, wave ? 4 : 3.2, 6, 0.24, vfx.time, owner);
  }

  private beginProjectileImpact(slot: KitSlot): void {
    const w = this.w, vfx = w.vfx, cue = slot.cue, owner = slot.owner, at = cue.position;
    if (!at) return;
    const wave = cue.actionId === 'crescent-wave', intensity = Math.min(1.5, Math.max(0.3, cue.intensity ?? 1));
    const projectile = cue.scopeId ? w.combat.findProjectile(cue.scopeId) : undefined;
    if (projectile) w.combat.endProjectile(projectile);
    this.a.set(at.x, at.y, at.z);
    const groundY = this.groundY(cue.targetId, at.y);
    // Rune-shatter ring facing the camera, glyph fragments, flash, sparks, shockwave and a small scorch decal.
    this.sigilNormal(w.vfx.cameraPosition.x - at.x, w.vfx.cameraPosition.z - at.z, this.a, this.normal);
    const ring = w.sigils.spawn(owner, 'shatter', vfx.time, this.a, this.normal, (wave ? 1.5 : 0.9) * intensity, 0.3, 1.1);
    w.sigils.finish(ring, vfx.time, 0.28);
    vfx.flash(at.x, at.y, at.z, (wave ? 3 : 2.2) * intensity, 'arcane', owner, 0.2);
    vfx.sparks(at.x, at.y, at.z, Math.round((wave ? 36 : 24) * intensity), 8, 'arcane', owner, 0.3);
    for (let i = vfx.count(14 * intensity); i > 0; i--) {
      const p = vfx.spec(), angle = vfx.random() * Math.PI * 2, speed = vfx.range(2, 5), hot = PALETTE.arcane.hot, body = PALETTE.arcane.b;
      p.x = at.x; p.y = at.y; p.z = at.z; p.vx = Math.cos(angle) * speed; p.vy = vfx.range(0.5, 3); p.vz = Math.sin(angle) * speed;
      p.gravity = 5; p.drag = 1.1; p.life = vfx.range(0.4, 0.8); p.size0 = vfx.range(0.07, 0.13); p.size1 = 0.03; p.frame = VFX_FRAME.shard; p.spin = vfx.random() * 6; p.spinRate = vfx.range(-9, 9);
      p.r0 = hot.r; p.g0 = hot.g; p.b0 = hot.b; p.r1 = body.r; p.g1 = body.g; p.b1 = body.b; p.fadeIn = 0.03; p.fadeOut = 0.55;
      vfx.emit(vfx.particles.additive, owner);
    }
    const radius = (wave ? 1.8 : 1.1) * intensity;
    this.footprint.set('disk', at.x, groundY, at.z, 0, radius, radius);
    vfx.ground.spawn('shock', this.footprint, 'arcane', owner, vfx.time, 0.4, 0.9);
    this.footprint.set('disk', at.x, groundY, at.z, 0, radius * 0.45, radius * 0.45);
    vfx.ground.spawn('decal', this.footprint, 'fire', owner, vfx.time, 3, 0.8, 'arcane');
    vfx.lights.pulse(at.x, at.y, at.z, PALETTE.arcane.hot, 3 + 2 * intensity, 6, 0.22, vfx.time, owner);
    w.impact?.shake(0.03 + 0.05 * intensity, 0.16, 28);
    if (!wave && intensity >= 0.9) w.impact?.impulse?.(0.2, 0.14); else if (wave) w.impact?.impulse?.(0.45, 0.2);
    if (cue.targetId) {
      w.impact?.flashActor(cue.targetId, PALETTE.arcane.hot, 1.3, 0.2, 'hit');
      w.combat.startArcs(cue.targetId, owner, wave ? 4 : 3, false, ARC_SECONDS);
    }
  }

  /** Ground height under a point: the target's root when rendered, else the contact point lowered by a body height. */
  private groundY(targetId: string | undefined, fallbackY: number): number {
    const root = targetId ? this.w.resolveSocket?.(targetId, 'root') : undefined;
    if (root) { root.updateWorldMatrix(true, false); return root.getWorldPosition(this.d).y + 0.04; }
    return Math.max(0, fallbackY - 0.9) + 0.04;
  }

  // ---- Thunder Cleave ----

  private beginLightning(slot: KitSlot): void {
    const w = this.w, vfx = w.vfx, cue = slot.cue, owner = slot.owner, at = cue.position;
    if (!at) return;
    let bolt: BoltState | undefined = w.bolts.find(candidate => !candidate.active);
    if (!bolt) { bolt = w.bolts[0]!; for (const candidate of w.bolts) if (candidate.start < bolt.start) bolt = candidate; }
    bolt.active = true; bolt.owner = owner; bolt.start = vfx.time; bolt.end = vfx.time + THUNDER_SECONDS; bolt.nextRegen = vfx.time + 2 / 60; bolt.flicker = 0.85;
    bolt.radiusX = (cue.footprint?.width ?? 6) / 2; bolt.radiusZ = (cue.footprint?.length ?? 6) / 2;
    bolt.strike.set(at.x, at.y, at.z);
    this.regenerateBolt(bolt);
    const y = at.y;
    vfx.flash(at.x, y + 0.5, at.z, 2.1, 'lightning', owner, 0.12);
    vfx.sparks(at.x, y + 0.2, at.z, 24, 9, 'lightning', owner, 0.22);
    vfx.shards(at.x, y + 0.3, at.z, 8, 6, owner);
    this.footprint.set('disk', at.x, y, at.z, 0, bolt.radiusX, bolt.radiusZ);
    vfx.ground.spawn('shock', this.footprint, 'lightning', owner, vfx.time, 0.5, 1);
    this.footprint.set('disk', at.x, y, at.z, 0, Math.min(1.6, bolt.radiusX), Math.min(1.6, bolt.radiusZ));
    // Earth + lightning: a glowing-cracked earth scar, a heavy dust ring and a spray of clods under the bolt.
    vfx.ground.spawn('decal', this.footprint, 'earth', owner, vfx.time, 2.2, 0.65, 'lightning');
    vfx.dustRing(at.x, y, at.z, Math.min(bolt.radiusX, bolt.radiusZ) * 0.7, 16, owner);
    this.footprint.set('disk', at.x, y, at.z, 0, bolt.radiusX, bolt.radiusZ);
    vfx.chunks(at.x, y + 0.05, at.z, 6, 4.6, 0.16, owner, false, this.footprint);
    const star = vfx.spec(), hot = PALETTE.lightning.hot;
    star.x = at.x; star.y = y + 0.6; star.z = at.z; star.frame = VFX_FRAME.star; star.life = 0.1; star.size0 = 1; star.size1 = 1.8; star.r0 = star.r1 = hot.r; star.g0 = star.g1 = hot.g; star.b0 = star.b1 = hot.b; star.a0 = 0.75; star.fadeIn = 0.05; star.fadeOut = 0.5;
    vfx.emit(vfx.particles.additive, owner);
    vfx.lights.pulse(at.x, y + 2, at.z, PALETTE.lightning.hot, 4.5, 8, 0.18, vfx.time, owner);
    w.impact?.shake(0.12, 0.18, 22);
    w.impact?.impulse?.(0.35, 0.12);
  }

  /** Re-rolls the trunk, branches and radial ground arcs (called every 2–3 world ticks for flicker). */
  regenerateBolt(bolt: BoltState): void {
    const vfx = this.w.vfx, s = bolt.strike;
    const topX = s.x + vfx.range(-0.7, 0.7), topZ = s.z + vfx.range(-0.7, 0.7);
    jaggedPath(bolt.trunk, topX, s.y + THUNDER_HEIGHT, topZ, s.x, s.y, s.z, BOLT_TRUNK_LEVELS, 0.2, this.random);
    const trunkPoints = (1 << BOLT_TRUNK_LEVELS) + 1;
    for (let i = 0; i < BOLT_BRANCHES; i++) {
      const at = Math.floor(vfx.range(5, trunkPoints - 6)) * 3, angle = vfx.random() * Math.PI * 2, length = vfx.range(1.4, 3);
      jaggedPath(bolt.branches[i]!, bolt.trunk[at]!, bolt.trunk[at + 1]!, bolt.trunk[at + 2]!, bolt.trunk[at]! + Math.cos(angle) * length, bolt.trunk[at + 1]! - length * vfx.range(0.2, 0.8), bolt.trunk[at + 2]! + Math.sin(angle) * length, BOLT_BRANCH_LEVELS, 0.3, this.random);
    }
    for (let i = 0; i < BOLT_RADIALS; i++) {
      const angle = ((i + vfx.random() * 0.8) / BOLT_RADIALS) * Math.PI * 2, reach = vfx.range(0.72, 0.98), path = bolt.radial[i]!;
      jaggedPath(path, s.x, s.y + 0.12, s.z, s.x + Math.cos(angle) * bolt.radiusX * reach, s.y + 0.12, s.z + Math.sin(angle) * bolt.radiusZ * reach, BOLT_BRANCH_LEVELS, 0.22, this.random);
      for (let p = 1; p < path.length / 3; p++) {
        const at = p * 3, dx = (path[at]! - s.x) / bolt.radiusX, dz = (path[at + 2]! - s.z) / bolt.radiusZ, distanceSq = dx * dx + dz * dz;
        if (distanceSq > 1) { const scale = 1 / Math.sqrt(distanceSq); path[at] = s.x + dx * scale * bolt.radiusX; path[at + 2] = s.z + dz * scale * bolt.radiusZ; }
        path[at + 1] = s.y + 0.1 + Math.abs(path[at + 1]! - (s.y + 0.12)) * 0.6 + vfx.random() * 0.06;
      }
    }
  }

  /** Re-rolls an actor arc: two anchors in the target's capsule joined by a jagged path (regenerated by the caller). */
  regenerateArc(arc: ArcState, root: Vector3): void {
    const vfx = this.w.vfx, a = arc.a, b = arc.b, path = arc.path;
    jaggedPath(path, root.x + a.x, root.y + a.y, root.z + a.z, root.x + b.x, root.y + b.y, root.z + b.z, ARC_LEVELS, 0.24, () => vfx.random());
  }

  // ---- Judgement ----

  private beginJudgement(slot: KitSlot): void {
    const w = this.w, vfx = w.vfx, cue = slot.cue, owner = slot.owner, root = w.player.valid ? w.player.position : cue.position;
    if (!root) return;
    if (cue.phase === 'anticipation') {
      this.a.set(root.x, root.y + 0.05, root.z);
      slot.sigil = w.sigils.spawn(owner, 'ground', vfx.time, this.a, UP, 1.8, 0.17, 0.9, 'judgement');
      vfx.gather(root.x, root.y + 1, root.z, 26, 1.1, 'judgement', owner);
      w.edgePeak = 3.6; w.edgeBoost = 1;
    } else if (cue.phase === 'commit') {
      const from = cue.from ?? root;
      w.dashUntil = (cue.worldTick + 14) / 60;
      w.trailFrom = (cue.worldTick - 1) / 60; w.trailUntil = w.dashUntil;
      w.trail.setStyle('judgement', 1.3, 0.24);
      vfx.flash(from.x, from.y + 1, from.z, 2.4, 'judgement', owner, 0.2);
      vfx.dustRing(from.x, from.y, from.z, 1, 14, owner);
      vfx.lights.pulse(from.x, from.y + 1, from.z, PALETTE.judgement.hot, 4, 7, 0.3, vfx.time, owner);
      w.impact?.shake(0.1, 0.22, 24);
      w.impact?.impulse?.(0.35, 0.2);
    } else if (cue.phase === 'resolve') {
      w.trailUntil = Math.min(w.trailUntil, (cue.worldTick + 2) / 60);
      this.footprint.set('disk', root.x, root.y + 0.05, root.z, 0, 2.6, 2.6);
      vfx.ground.spawn('shock', this.footprint, 'judgement', owner, vfx.time, 0.5, 1);
      vfx.flash(root.x, root.y + 1.1, root.z, 3.6, 'judgement', owner, 0.3);
      vfx.sparks(root.x, root.y + 1, root.z, 28, 7, 'judgement', owner, 0.2);
      vfx.lights.pulse(root.x, root.y + 1.2, root.z, PALETTE.judgement.hot, 5, 8, 0.4, vfx.time, owner);
      w.impact?.shake(0.12, 0.3, 20);
      w.impact?.impulse?.(0.5, 0.26);
    }
  }

  private beginMark(slot: KitSlot): void {
    const cue = slot.cue, at = cue.position;
    if (!at || !cue.scopeId) return;
    if (cue.phase === 'hit') this.detonateMark(cue, slot.owner, at);
    else this.placeMark(cue.scopeId, slot.owner, at.x, at.y, at.z, cue.footprint?.angleRadians ?? 0, 4);
  }

  /** Places (idempotently) the hanging X and its ground rune; `lifeSeconds` is the safety expiry. */
  placeMark(id: string, owner: number, x: number, y: number, z: number, angle: number, lifeSeconds: number): void {
    const w = this.w, vfx = w.vfx;
    if (w.marks.some(mark => mark.id === id)) return;
    const centre = this.a.set(x, y + 1.15, z), cam = vfx.cameraPosition, scale = MARK_SPAN / CRESCENT_CHORD;
    const nx = cam.x - x, nz = cam.z - z, nl = Math.hypot(nx, nz) || 1;
    const normal = this.normal.set(nx / nl, 0.35, nz / nl).normalize();
    const right = this.b.crossVectors(UP, normal).normalize(), top = this.c.crossVectors(normal, right);
    const spawnCrescent = (roll: number): number => {
      // Chord along (cos roll, sin roll) in the view-facing plane; the crescent's centre sits 0.25 radii behind its apex.
      const cr = Math.cos(roll), sr = Math.sin(roll);
      const rx = right.x * cr + top.x * sr, ry = right.y * cr + top.y * sr, rz = right.z * cr + top.z * sr;
      const tx = -right.x * sr + top.x * cr, ty = -right.y * sr + top.y * cr, tz = -right.z * sr + top.z * cr;
      this.basis.makeBasis(this.d.set(rx, ry, rz), this.e.set(tx, ty, tz), normal);
      this.quat.setFromRotationMatrix(this.basis);
      return w.crescents.spawn(owner, vfx.time, lifeSeconds, centre.x + tx * 0.25 * scale, centre.y + ty * 0.25 * scale, centre.z + tz * 0.25 * scale, this.quat, scale, 0.55, 1.15, 0.15, 'judgement');
    };
    const crescentA = spawnCrescent(Math.PI / 4 + angle), crescentB = spawnCrescent(-Math.PI / 4 + angle + Math.PI);
    vfx.flash(centre.x, centre.y, centre.z, 1.1, 'judgement', owner, 0.14);
    this.a.set(x, y + 0.05, z);
    const ground = w.sigils.spawn(owner, 'ground', vfx.time, this.a, UP, 1.1, Infinity, 0.55, 'judgement');
    w.marks.push({ id, owner, crescentA, crescentB, ground, createdAt: vfx.time, expiresAt: vfx.time + lifeSeconds, position: new Vector3(x, y, z) });
  }

  /** Detonation: releases the X and bursts flash, shards, a ground ring and an impulse. */
  detonateMark(cue: StoryCue, owner: number, at: { x: number; y: number; z: number }): void {
    const w = this.w, vfx = w.vfx, id = cue.scopeId;
    const index = w.marks.findIndex(mark => mark.id === id);
    if (index >= 0) w.releaseMark(index);
    const intensity = Math.min(1.6, Math.max(0.5, cue.intensity ?? 1.2));
    vfx.flash(at.x, at.y + 1, at.z, 2.6 * intensity, 'judgement', owner, 0.22);
    vfx.sparks(at.x, at.y + 0.8, at.z, 24, 8, 'judgement', owner, 0.3);
    vfx.shards(at.x, at.y + 0.8, at.z, 10, 6, owner);
    this.footprint.set('disk', at.x, at.y + 0.05, at.z, 0, 2.2, 2.2);
    vfx.ground.spawn('shock', this.footprint, 'judgement', owner, vfx.time, 0.42, 1);
    this.footprint.set('disk', at.x, at.y + 0.05, at.z, 0, 1, 1);
    vfx.ground.spawn('decal', this.footprint, 'fire', owner, vfx.time, 3.5, 0.9, 'judgement');
    vfx.lights.pulse(at.x, at.y + 1, at.z, PALETTE.judgement.hot, 4.5, 7, 0.3, vfx.time, owner);
    w.impact?.shake(0.08, 0.2, 26);
    w.impact?.impulse?.(0.3, 0.18);
    if (cue.targetId) w.impact?.flashActor(cue.targetId, PALETTE.judgement.hot, 1.4, 0.2, 'hit');
  }
}


