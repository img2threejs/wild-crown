import { Quaternion, Vector3 } from 'three';
import type { ActorSnapshot, CombatSnapshot, PlayerProjectileSnapshot } from '../../game/contracts.js';
import type { HeroId } from '../../game/heroes.js';
import { CRESCENT_CHORD } from './CrescentFx.js';
import { SAKDA_LIMBS, SAKDA_LIMB_MASKS, VESPER_BLADE_CLIPS } from './HeroKits.js';
import { crescentOrientation, headingOf, silhouette, tintSparks, type Tint } from './hero-fx.js';
import { EMBER_GOLD, EMBER_RIM, PALETTE, UMBRAL_RIM, UMBRAL_SMOKE } from './palette.js';
import { VFX_FRAME } from './VfxAtlas.js';
import { WARDEN_OWNER, type ProjectileVisual, type WardenFx } from './WardenFx.js';

type HeroMark = NonNullable<ActorSnapshot['heroMarks']>[number];

/** Trail history length (points) per limb, newest first. */
const LIMB_POINTS = 10;
/** A limb only records a new trail point after it has moved this far (metres): a still limb never produces a degenerate strip. */
const LIMB_STEP = 0.03;
/** Seconds the trail keeps recording after the last activity signal. */
const LIMB_HOLD = 0.06;
const SHIELD_RADIUS = 0.8;
/** Death Mark stacks needed to flip into the full mark. */
const DEATH_STACKS = 3;
/** Remaining ticks above which a vanished Death Mark counts as consumed (a Shadow Execution) rather than expired. */
const CONSUMED_MARGIN_TICKS = 4;
const ECHO_RING_COUNT = 3;
const DEFAULT_HEIGHT = 1.7;
const UMBRAL_TINT: Tint = UMBRAL_RIM;
const EMBER_GOLD_TINT: Tint = EMBER_GOLD;

interface MarkRecord { remaining: number; frame: number }

/**
 * Snapshot-driven presentation of the Vesper and Sakda kits, drawn every rendered frame between `WardenCombat`'s sprite/line batch begin and end:
 * the Death Mark pips and Shadow Execution burst, echo/requiem/cripple marks on hostiles, the flame shield bubble, the flurry fist glow,
 * untargetable wisps, Sakda's limb trails through the `fist-*` and `foot-*` sockets, the katana trail window of Vesper's strikes, and the projectiles
 * `kunai`, `echo-wave` and `shade-clone`. It reads snapshots and rendered sockets only and never writes simulation state.
 */
export class HeroStateFx {
  private readonly limbUntil = new Float64Array(4).fill(-Infinity);
  private readonly limbPath: Float32Array[] = SAKDA_LIMBS.map(() => new Float32Array(LIMB_POINTS * 3));
  private readonly limbCount = new Int32Array(4);
  private readonly limbEmit = new Float64Array(4);
  private readonly marks = new Map<string, MarkRecord>();
  private frame = 0;
  private shieldUp = false;
  private shieldAcc = 0;
  private flurryAcc = 0;
  private ghostAcc = 0;
  private bladeAction = '';
  private readonly a = new Vector3();
  private readonly right = new Vector3();
  private readonly dir = new Vector3();
  private readonly quat = new Quaternion();
  private readonly trail = new Float32Array(8 * 3);

  constructor(private readonly w: WardenFx) {}

  reset(): void {
    this.limbUntil.fill(-Infinity); this.limbCount.fill(0); this.limbEmit.fill(0);
    this.marks.clear();
    this.shieldUp = false; this.shieldAcc = this.flurryAcc = this.ghostAcc = 0; this.bladeAction = '';
  }

  /** Cue kits ask for the limbs in `mask` (bit 0 left fist, 1 right fist, 2 left foot, 3 right foot) to trail until world time `until`. */
  openLimbs(mask: number, until: number): void {
    for (let i = 0; i < 4; i++) if ((mask >> i) & 1) this.limbUntil[i] = Math.max(this.limbUntil[i]!, until);
  }

  /** True while Vesper's katana edge should leave a trail (snapshot-driven, for strikes the engine sends no slash cue for). */
  bladeLive(): boolean {
    const player = this.w.player;
    if (!player.valid || player.hero !== 'vesper' || !VESPER_BLADE_CLIPS[player.actionId] || player.phase === 'idle') return false;
    if (player.actionId !== this.bladeAction) {
      // First frame of a new strike: dress the shared trail strip in the umbral palette.
      this.bladeAction = player.actionId;
      const w = this.w;
      w.trailElement = 'umbral';
      w.trail.setStyle('umbral', 1.25, 0.14, 0.65);
      w.edgePeak = 3; w.edgeBoost = 1;
    }
    return true;
  }

  /** One rendered frame; call between the sprite/line `begin()` and `end()` of `WardenCombat.update`. */
  update(snapshot: CombatSnapshot, time: number, dt: number): void {
    const w = this.w, player = w.player;
    this.frame++;
    this.cameraRight();
    if (!snapshot.player || !player.valid) { this.limbUntil.fill(-Infinity); this.limbCount.fill(0); this.shieldUp = false; this.markActors(snapshot.actors, time); return; }
    this.limbTrails(player.hero, time, dt);
    this.shield(snapshot.player.shield ?? 0, player.hero, time, dt);
    this.flurry(snapshot.player.flurryCharges ?? 0, dt);
    this.untargetable(snapshot.player.untargetable === true, player.hero, dt);
    this.markActors(snapshot.actors, time);
  }

  // ---- Sakda limb trails ----

  private limbTrails(hero: HeroId, time: number, dt: number): void {
    const w = this.w, vfx = w.vfx, player = w.player;
    if (hero === 'sakda' && player.phase !== 'idle') {
      const mask = SAKDA_LIMB_MASKS[player.actionId] ?? 0;
      for (let i = 0; i < 4; i++) if ((mask >> i) & 1) this.limbUntil[i] = Math.max(this.limbUntil[i]!, time + LIMB_HOLD);
    }
    for (let limb = 0; limb < 4; limb++) {
      const path = this.limbPath[limb]!, active = time < this.limbUntil[limb]!;
      let count = this.limbCount[limb]!;
      const socket = active ? w.resolveSocket?.('aren', SAKDA_LIMBS[limb]!) : undefined;
      if (socket) {
        socket.updateWorldMatrix(true, false);
        socket.getWorldPosition(this.a);
        if (count === 0 || Math.hypot(this.a.x - path[0]!, this.a.y - path[1]!, this.a.z - path[2]!) >= LIMB_STEP) {
          path.copyWithin(3, 0, (LIMB_POINTS - 1) * 3);
          path[0] = this.a.x; path[1] = this.a.y; path[2] = this.a.z;
          count = Math.min(LIMB_POINTS, count + 1);
          // Embers shed off the moving limb.
          this.limbEmit[limb] = this.limbEmit[limb]! + dt * 55 * (vfx.reducedEffects ? 0.35 : 1);
          for (; this.limbEmit[limb]! >= 1; this.limbEmit[limb] = this.limbEmit[limb]! - 1) {
            const p = vfx.spec();
            p.x = this.a.x + vfx.range(-0.04, 0.04); p.y = this.a.y + vfx.range(-0.04, 0.04); p.z = this.a.z + vfx.range(-0.04, 0.04);
            p.vx = vfx.range(-0.8, 0.8); p.vy = vfx.range(0.1, 1.2); p.vz = vfx.range(-0.8, 0.8); p.gravity = -0.6; p.drag = 1.4; p.life = vfx.range(0.2, 0.4);
            p.size0 = 0.045; p.size1 = 0.015; p.frame = VFX_FRAME.ember;
            p.r0 = EMBER_GOLD.hot.r; p.g0 = EMBER_GOLD.hot.g; p.b0 = EMBER_GOLD.hot.b; p.r1 = PALETTE.ember.b.r; p.g1 = PALETTE.ember.b.g; p.b1 = PALETTE.ember.b.b; p.a0 = 0.85; p.fadeOut = 0.5;
            vfx.emit(vfx.particles.additive, WARDEN_OWNER);
          }
        }
      } else if (count > 0) count = Math.max(0, count - 2);
      this.limbCount[limb] = count;
      if (count < 2) continue;
      const style = w.lines.style.reset(), fist = limb < 2;
      style.width = fist ? 0.1 : 0.16; style.taper = 0.85;
      style.cr = EMBER_GOLD.hot.r; style.cg = EMBER_GOLD.hot.g; style.cb = EMBER_GOLD.hot.b;
      style.gr = PALETTE.ember.b.r; style.gg = PALETTE.ember.b.g; style.gb = PALETTE.ember.b.b;
      style.alpha0 = 0.9; style.alpha1 = 0;
      w.lines.add(path, count);
    }
  }

  // ---- shield, flurry, untargetable ----

  /** The flame shield bubble: a glow, two flickering rim rings and tongues of fire on the surface while any shield remains. */
  private shield(amount: number, hero: HeroId, time: number, dt: number): void {
    const w = this.w, vfx = w.vfx, player = w.player, up = amount > 0;
    const cx = player.position.x, cy = player.position.y + 0.95, cz = player.position.z;
    if (up) {
      const level = Math.min(1, amount / 25), flicker = 0.75 + 0.25 * Math.sin(time * 26) * Math.sin(time * 11.3), rim = hero === 'vesper' ? UMBRAL_RIM : EMBER_RIM, glow = hero === 'vesper' ? PALETTE.umbral.b : PALETTE.ember.b;
      w.sprites.add(cx, cy, cz, 0, 0, 0, SHIELD_RADIUS * 1.5, SHIELD_RADIUS * 1.5, VFX_FRAME.glow, glow.r, glow.g, glow.b, 0.2 * level * flicker);
      w.sprites.add(cx, cy, cz, 0, 0, 0, SHIELD_RADIUS * 1.15, SHIELD_RADIUS * 1.15, VFX_FRAME.ring, rim.hot.r, rim.hot.g, rim.hot.b, (0.28 + 0.3 * level) * flicker);
      w.sprites.add(cx, cy, cz, 0, 0, 0, SHIELD_RADIUS * 0.95, SHIELD_RADIUS * 0.95, VFX_FRAME.ring, rim.body.r, rim.body.g, rim.body.b, 0.22 * level * flicker);
      this.shieldAcc += dt * (14 + 12 * level) * (vfx.reducedEffects ? 0.35 : 1);
      for (; this.shieldAcc >= 1; this.shieldAcc--) {
        const theta = vfx.random() * Math.PI * 2, phi = Math.acos(vfx.range(-0.7, 1)), x = cx + Math.sin(phi) * Math.cos(theta) * SHIELD_RADIUS, y = cy + Math.cos(phi) * SHIELD_RADIUS * 0.9, z = cz + Math.sin(phi) * Math.sin(theta) * SHIELD_RADIUS;
        if (hero === 'vesper') vfx.smoke(x, y, z, 1, 0.05, 0.4, 0.55, 0.5, UMBRAL_SMOKE, 0.4, WARDEN_OWNER, 0.1);
        else vfx.flames(x, y, z, 1, 0.03, 0.55, WARDEN_OWNER, 'ember');
      }
    } else if (this.shieldUp) {
      // The shield is gone (spent or expired): a ring of sparks flies off the bubble.
      const tint = hero === 'vesper' ? UMBRAL_TINT : EMBER_GOLD_TINT;
      tintSparks(vfx, WARDEN_OWNER, cx, cy, cz, 18, 5, tint, 0.1);
      vfx.flash(cx, cy, cz, 1.4, hero === 'vesper' ? 'umbral' : 'ember', WARDEN_OWNER, 0.16);
    }
    this.shieldUp = up;
  }

  /** Flurry charges: both fists glow with a gold-orange core and shed embers (brighter with two charges). */
  private flurry(charges: number, dt: number): void {
    if (charges <= 0) { this.flurryAcc = 0; return; }
    const w = this.w, vfx = w.vfx, hot = EMBER_GOLD.hot, body = PALETTE.ember.b;
    this.flurryAcc += dt * 12 * charges * (vfx.reducedEffects ? 0.35 : 1);
    let embersDue = Math.floor(this.flurryAcc);
    for (let fist = 0; fist < 2; fist++) {
      const socket = w.resolveSocket?.('aren', SAKDA_LIMBS[fist]!);
      if (!socket) continue;
      socket.updateWorldMatrix(true, false);
      socket.getWorldPosition(this.a);
      const pulse = 0.8 + 0.2 * Math.sin(w.vfx.time * 22 + fist * 1.7);
      w.sprites.add(this.a.x, this.a.y, this.a.z, 0, 0, 0, 0.2 + 0.07 * charges, 0.2 + 0.07 * charges, VFX_FRAME.glow, body.r, body.g, body.b, 0.45 * pulse);
      w.sprites.add(this.a.x, this.a.y, this.a.z, 0, 0, 0, 0.1, 0.1, VFX_FRAME.star, hot.r, hot.g, hot.b, 0.5 * pulse);
      if (embersDue > 0) { vfx.embers(this.a.x, this.a.y, this.a.z, 1, 0.08, 0.9, -0.4, WARDEN_OWNER, 'ember'); embersDue--; }
    }
    this.flurryAcc %= 1;
  }

  /** Untargetable (Thousand Cuts, Requiem, Mist Blink, Tiger's Wrath): ink wisps and crimson flickers off the body, or ember flickers for Sakda. */
  private untargetable(active: boolean, hero: HeroId, dt: number): void {
    if (!active || (hero !== 'vesper' && hero !== 'sakda')) { this.ghostAcc = 0; return; }
    const w = this.w, vfx = w.vfx, p = w.player.position;
    this.ghostAcc += dt * 26 * (vfx.reducedEffects ? 0.35 : 1);
    for (; this.ghostAcc >= 1; this.ghostAcc--) {
      const x = p.x + vfx.range(-0.35, 0.35), y = p.y + vfx.range(0.2, 1.7), z = p.z + vfx.range(-0.35, 0.35);
      if (hero === 'vesper') {
        vfx.smoke(x, y, z, 1, 0.05, 0.5, 0.8, 0.7, UMBRAL_SMOKE, 0.45, WARDEN_OWNER, 0.3);
        if (vfx.random() < 0.3) tintSparks(vfx, WARDEN_OWNER, x, y, z, 1, 2, UMBRAL_TINT, 0.3);
      } else {
        vfx.embers(x, y, z, 1, 0.1, 0.8, -0.5, WARDEN_OWNER, 'ember');
        if (vfx.random() < 0.3) vfx.flames(x, p.y + 0.3, z, 1, 0.1, 0.6, WARDEN_OWNER, 'ember');
      }
    }
  }

  // ---- marks on hostiles ----

  private cameraRight(): void {
    const cam = this.w.vfx.cameraPosition, p = this.w.player.position;
    this.right.set(cam.z - p.z, 0, -(cam.x - p.x));
    if (this.right.lengthSq() < 1e-6) this.right.set(1, 0, 0);
    this.right.normalize();
  }

  private markActors(actors: readonly ActorSnapshot[], time: number): void {
    const w = this.w;
    for (const actor of actors) {
      const marks = actor.heroMarks;
      if (!marks || marks.length === 0 || actor.allegiance !== 'hostile' || !actor.visible || actor.downed) continue;
      const root = w.resolveActorRoot?.(actor.id), height = root ? w.bodies.get(root).height : DEFAULT_HEIGHT;
      for (const mark of marks) this.drawMark(actor, mark, height, time);
    }
    if (this.marks.size === 0) return;
    // A Death Mark that disappears with plenty of time left was consumed by the next hit: the Shadow Execution.
    for (const [id, record] of this.marks) {
      if (record.frame === this.frame) continue;
      const position = this.actorAt(actors, id);
      if (position && record.remaining > CONSUMED_MARGIN_TICKS) this.execution(id, position);
      this.marks.delete(id);
    }
  }

  private actorAt(actors: readonly ActorSnapshot[], id: string): ActorSnapshot | undefined {
    for (const actor of actors) if (actor.id === id) return actor;
    return undefined;
  }

  private drawMark(actor: ActorSnapshot, mark: HeroMark, height: number, time: number): void {
    const w = this.w, p = actor.position, sprites = w.sprites, r = this.right, urgency = mark.remainingTicks < 60 ? 0.55 + 0.45 * Math.sin(time * 30) : 1;
    switch (mark.kind) {
      case 'death-stack': {
        // A small ring over the head that fills with crimson pips (one per stack) and a core that grows.
        const stacks = Math.max(1, Math.min(DEATH_STACKS, mark.stacks ?? 1)), y = p.y + height + 0.45, hot = UMBRAL_RIM.hot, body = UMBRAL_RIM.body, violet = PALETTE.umbral.b;
        sprites.add(p.x, y, p.z, 0, 0, 0, 0.3, 0.3, VFX_FRAME.ring, violet.r, violet.g, violet.b, 0.25 + 0.15 * stacks);
        sprites.add(p.x, y, p.z, 0, 0, 0, 0.08 + 0.07 * stacks, 0.08 + 0.07 * stacks, VFX_FRAME.glow, body.r, body.g, body.b, 0.4);
        for (let i = 0; i < stacks; i++) {
          const angle = Math.PI / 2 + (i / DEATH_STACKS) * Math.PI * 2;
          sprites.add(p.x + r.x * Math.cos(angle) * 0.26, y + Math.sin(angle) * 0.26, p.z + r.z * Math.cos(angle) * 0.26, 0, 0, 0, 0.08, 0.08, VFX_FRAME.star, hot.r, hot.g, hot.b, 0.9);
        }
        return;
      }
      case 'death-mark': {
        // The full mark: a pulsing crimson ring with all three pips lit and a razor slit through it.
        const y = p.y + height + 0.5, hot = UMBRAL_RIM.hot, body = UMBRAL_RIM.body, pulse = (0.8 + 0.2 * Math.sin(time * 9)) * urgency;
        sprites.add(p.x, y, p.z, 0, 0, 0, 0.42 * pulse, 0.42 * pulse, VFX_FRAME.ring, hot.r, hot.g, hot.b, 0.7 * urgency);
        sprites.add(p.x, y, p.z, 0, 0, 0, 0.5, 0.5, VFX_FRAME.glow, body.r, body.g, body.b, 0.3 * urgency);
        sprites.add(p.x, y, p.z, r.x * 0.5, 0.7, r.z * 0.5, 0.55, 0.05, VFX_FRAME.cut, hot.r, hot.g, hot.b, 0.85 * urgency);
        for (let i = 0; i < DEATH_STACKS; i++) {
          const angle = Math.PI / 2 + (i / DEATH_STACKS) * Math.PI * 2;
          sprites.add(p.x + r.x * Math.cos(angle) * 0.36, y + Math.sin(angle) * 0.36, p.z + r.z * Math.cos(angle) * 0.36, 0, 0, 0, 0.1, 0.1, VFX_FRAME.star, hot.r, hot.g, hot.b, urgency);
        }
        this.note(actor.id, mark.remainingTicks);
        return;
      }
      case 'echo-mark': {
        // Echo: two gold rings pulsing outward round the chest.
        const y = p.y + height * 0.55, gold = EMBER_GOLD.hot, orange = PALETTE.ember.b, phase = (time * 1.8) % 1;
        sprites.add(p.x, y, p.z, 0, 0, 0, 0.35 + 0.5 * phase, 0.35 + 0.5 * phase, VFX_FRAME.ring, gold.r, gold.g, gold.b, 0.8 * (1 - phase) * urgency);
        sprites.add(p.x, y, p.z, 0, 0, 0, 0.55, 0.55, VFX_FRAME.ring, orange.r, orange.g, orange.b, 0.45 * urgency);
        sprites.add(p.x, y, p.z, 0, 0, 0, 0.12, 0.12, VFX_FRAME.star, gold.r, gold.g, gold.b, 0.7 * urgency);
        return;
      }
      case 'requiem-mark': {
        // Requiem: a crimson X over the chest in a thin ring.
        const y = p.y + height * 0.6, hot = UMBRAL_RIM.hot, body = UMBRAL_RIM.body, pulse = 0.85 + 0.15 * Math.sin(time * 14);
        sprites.add(p.x, y, p.z, r.x, 1, r.z, 0.5 * pulse, 0.05, VFX_FRAME.cut, hot.r, hot.g, hot.b, 0.9);
        sprites.add(p.x, y, p.z, r.x, -1, r.z, 0.5 * pulse, 0.05, VFX_FRAME.cut, hot.r, hot.g, hot.b, 0.9);
        sprites.add(p.x, y, p.z, 0, 0, 0, 0.5 * pulse, 0.5 * pulse, VFX_FRAME.ring, body.r, body.g, body.b, 0.55);
        sprites.add(p.x, y, p.z, 0, 0, 0, 0.45, 0.45, VFX_FRAME.glow, body.r, body.g, body.b, 0.25 * pulse);
        return;
      }
      case 'cripple': {
        // Cripple: chain links circle the feet and a dull orange glow weighs the target down.
        const rim = EMBER_RIM.hot, orange = PALETTE.ember.a, spin = time * 1.4, fade = Math.min(1, mark.remainingTicks / 20);
        sprites.add(p.x, p.y + 0.1, p.z, 0, 0, 0, 0.6, 0.6, VFX_FRAME.glow, orange.r, orange.g, orange.b, 0.35 * fade);
        for (let i = 0; i < 6; i++) {
          const angle = spin + (i / 6) * Math.PI * 2;
          sprites.add(p.x + Math.cos(angle) * 0.62, p.y + 0.16, p.z + Math.sin(angle) * 0.62, 0, 0, 0, 0.08, 0.08, VFX_FRAME.ring, rim.r, rim.g, rim.b, 0.8 * fade);
        }
        return;
      }
      default: return;
    }
  }

  private note(id: string, remaining: number): void {
    let record = this.marks.get(id);
    if (!record) { record = { remaining, frame: this.frame }; this.marks.set(id, record); }
    record.remaining = remaining; record.frame = this.frame;
  }

  /** Shadow Execution: the consumed Death Mark bursts in crimson at the target's chest with a crossed pair of cuts. */
  private execution(id: string, actor: ActorSnapshot): void {
    const w = this.w, vfx = w.vfx, root = w.resolveActorRoot?.(id), height = root ? w.bodies.get(root).height : DEFAULT_HEIGHT, p = actor.position, y = p.y + height * 0.6;
    const hot = UMBRAL_RIM.hot;
    vfx.flash(p.x, y, p.z, 2.6, 'umbral', WARDEN_OWNER, 0.24);
    tintSparks(vfx, WARDEN_OWNER, p.x, y, p.z, 30, 8, UMBRAL_TINT, 0.2);
    for (let i = 0; i < 2; i++) {
      const sign = i ? -1 : 1, q = vfx.spec();
      q.x = p.x; q.y = y; q.z = p.z; q.vx = this.right.x * sign * 0.05; q.vy = sign * 0.05; q.vz = this.right.z * sign * 0.05; q.stretch = 0.01;
      q.frame = VFX_FRAME.cut; q.life = 0.2; q.size0 = 1.8; q.size1 = 2.6; q.r0 = q.r1 = hot.r; q.g0 = q.g1 = hot.g; q.b0 = q.b1 = hot.b; q.a0 = 1; q.fadeIn = 0.04; q.fadeOut = 0.5;
      vfx.emit(vfx.particles.additive, WARDEN_OWNER);
    }
    vfx.smoke(p.x, y - 0.3, p.z, 6, 0.5, 0.7, 1, 0.8, UMBRAL_SMOKE, 0.5, WARDEN_OWNER, 1.2);
    vfx.lights.pulse(p.x, y, p.z, hot, 5, 7, 0.3, vfx.time, WARDEN_OWNER);
    w.impact?.flashActor(id, hot, 1.5, 0.25, 'hit');
    w.impact?.shake(0.1, 0.2, 28);
  }

  // ---- projectiles ----

  /** Echo Wave: a gold fire crescent travelling with the snapshot (released with the projectile). */
  beginProjectile(visual: ProjectileVisual, snapshot: PlayerProjectileSnapshot, time: number): void {
    if (visual.kind !== 'echo-wave') return;
    const w = this.w, yaw = headingOf(visual.direction.x, visual.direction.z), scale = Math.max(1.6, snapshot.radius * 3) / CRESCENT_CHORD;
    visual.crescent = w.crescents.spawn(visual.owner, time, 4, snapshot.position.x, snapshot.position.y, snapshot.position.z, crescentOrientation(this.quat, yaw, 0.5, 0), scale, 1, 1.5, 0.12, 'ember', 'ember');
  }

  /** Draws one hero projectile for this frame; returns true when it used the tracked light. */
  drawProjectile(visual: ProjectileVisual, time: number, dt: number, light: boolean): boolean {
    switch (visual.kind) {
      case 'kunai': return this.drawKunai(visual, time, dt, light);
      case 'echo-wave': return this.drawEcho(visual, time, dt, light);
      case 'shade-clone': this.drawShade(visual, dt); return false;
      default: return false;
    }
  }

  /** Releases a hero projectile's visuals; expiry without an impact cue dissipates with a small puff of the hero's colours. */
  endProjectile(visual: ProjectileVisual, expired: boolean): void {
    const w = this.w, vfx = w.vfx, at = visual.display;
    if (visual.kind === 'echo-wave') {
      if (visual.crescent >= 0) w.crescents.release(visual.crescent);
      if (expired) {
        tintSparks(vfx, visual.owner, at.x, at.y, at.z, 14, 5, EMBER_GOLD_TINT, 0.4);
        for (let i = 0; i < ECHO_RING_COUNT; i++) this.ringSprite(visual.owner, at, 0.3 + i * 0.2, 1.1 + i * 0.4, 0.3);
      }
    } else if (expired && visual.kind === 'kunai') tintSparks(vfx, visual.owner, at.x, at.y, at.z, 8, 4, UMBRAL_TINT, 0.3);
    else if (expired && visual.kind === 'shade-clone') {
      vfx.smoke(at.x, at.y - 0.4, at.z, 8, 0.5, 0.8, 1, 0.8, UMBRAL_SMOKE, 0.5, visual.owner, 1.2);
      tintSparks(vfx, visual.owner, at.x, at.y, at.z, 14, 5, UMBRAL_TINT, 0.3);
    }
  }

  private ringSprite(owner: number, at: Vector3, size0: number, size1: number, life: number): void {
    const vfx = this.w.vfx, p = vfx.spec(), gold = EMBER_GOLD.hot;
    p.x = at.x; p.y = at.y; p.z = at.z; p.frame = VFX_FRAME.ring; p.life = life; p.size0 = size0; p.size1 = size1;
    p.r0 = p.r1 = gold.r; p.g0 = p.g1 = gold.g; p.b0 = p.b1 = gold.b; p.a0 = 0.8; p.fadeIn = 0.05; p.fadeOut = 0.6;
    vfx.emit(vfx.particles.additive, owner);
  }

  /** Kunai: a thin violet blade with a crimson glint, a violet streak ribbon behind it and a trail of sparks. */
  private drawKunai(visual: ProjectileVisual, time: number, dt: number, light: boolean): boolean {
    const w = this.w, vfx = w.vfx, at = visual.display, dir = visual.direction, hot = PALETTE.umbral.hot, body = PALETTE.umbral.b, rim = UMBRAL_RIM.hot;
    w.sprites.add(at.x, at.y, at.z, dir.x, dir.y, dir.z, 0.34, 0.07, VFX_FRAME.shard, hot.r, hot.g, hot.b, 0.95);
    w.sprites.add(at.x, at.y, at.z, dir.x, dir.y, dir.z, 0.6, 0.14, VFX_FRAME.glow, body.r, body.g, body.b, 0.4);
    w.sprites.add(at.x, at.y, at.z, 0, 0, 0, 0.1, 0.1, VFX_FRAME.star, rim.r, rim.g, rim.b, 0.8 + 0.2 * Math.sin(time * 40));
    // The streak: a short ribbon behind the head that fades to nothing.
    for (let i = 0; i < 8; i++) {
      const s = (i / 7) * 1.3, sway = Math.sin(s * 9 - time * 30) * 0.015 * (s + 0.2);
      this.trail[i * 3] = at.x - dir.x * s + this.right.x * sway; this.trail[i * 3 + 1] = at.y - dir.y * s; this.trail[i * 3 + 2] = at.z - dir.z * s + this.right.z * sway;
    }
    const style = w.lines.style.reset();
    style.width = 0.05; style.taper = 0.8; style.cr = hot.r; style.cg = hot.g; style.cb = hot.b; style.gr = body.r * 0.6; style.gg = body.g * 0.6; style.gb = body.b * 0.6; style.alpha0 = 0.9; style.alpha1 = 0;
    w.lines.add(this.trail, 8);
    visual.emitAcc += dt * (vfx.reducedEffects ? 14 : 45);
    for (; visual.emitAcc >= 1; visual.emitAcc--) {
      const p = vfx.spec();
      p.x = at.x + vfx.range(-0.03, 0.03); p.y = at.y + vfx.range(-0.03, 0.03); p.z = at.z + vfx.range(-0.03, 0.03);
      p.vx = -dir.x * 1.2 + vfx.range(-0.5, 0.5); p.vy = -dir.y * 1.2 + vfx.range(-0.2, 0.5); p.vz = -dir.z * 1.2 + vfx.range(-0.5, 0.5); p.drag = 2; p.life = vfx.range(0.2, 0.4);
      p.size0 = 0.035; p.size1 = 0.012; p.frame = VFX_FRAME.spark; p.stretch = 0.07; p.a0 = 0.85;
      if (vfx.random() < 0.3) { p.r0 = rim.r; p.g0 = rim.g; p.b0 = rim.b; p.r1 = UMBRAL_RIM.body.r; p.g1 = UMBRAL_RIM.body.g; p.b1 = UMBRAL_RIM.body.b; }
      else { p.r0 = hot.r; p.g0 = hot.g; p.b0 = hot.b; p.r1 = body.r; p.g1 = body.g; p.b1 = body.b; }
      vfx.emit(vfx.particles.additive, visual.owner);
    }
    if (light) vfx.lights.track(at.x, at.y, at.z, PALETTE.umbral.hot, 1.2, 4);
    return light;
  }

  /** Echo Wave: the gold crescent follows the snapshot; sonic rings stack behind it with flames, gold sparks and rising embers. */
  private drawEcho(visual: ProjectileVisual, time: number, dt: number, light: boolean): boolean {
    const w = this.w, vfx = w.vfx, at = visual.display, dir = visual.direction, gold = EMBER_GOLD.hot, orange = PALETTE.ember.b;
    w.crescents.place(visual.crescent, at.x, at.y, at.z);
    for (let i = 0; i < ECHO_RING_COUNT; i++) {
      const back = 0.55 + i * 0.6, size = 0.5 + i * 0.22, pulse = 0.85 + 0.15 * Math.sin(time * 18 - i * 1.3);
      w.sprites.add(at.x - dir.x * back, at.y - dir.y * back, at.z - dir.z * back, 0, 0, 0, size * pulse, size * pulse, VFX_FRAME.ring, gold.r, gold.g, gold.b, (0.8 - i * 0.22) * pulse);
    }
    w.sprites.add(at.x, at.y, at.z, dir.x, dir.y, dir.z, 0.7, 0.3, VFX_FRAME.glow, orange.r, orange.g, orange.b, 0.5);
    visual.emitAcc += dt * (vfx.reducedEffects ? 18 : 70);
    for (; visual.emitAcc >= 1; visual.emitAcc--) {
      const side = vfx.range(-1, 1) * Math.max(0.5, visual.radius * 1.2);
      this.dir.set(-dir.z, 0, dir.x);
      const x = at.x + this.dir.x * side - dir.x * Math.abs(side) * 0.4, y = at.y + vfx.range(-0.2, 0.3), z = at.z + this.dir.z * side - dir.z * Math.abs(side) * 0.4;
      if (vfx.random() < 0.45) vfx.flames(x, y - 0.1, z, 1, 0.05, 0.6, visual.owner, 'ember');
      else if (vfx.random() < 0.5) vfx.embers(x, y, z, 1, 0.05, 0.8, -0.4, visual.owner, 'ember');
      else vfx.sparks(x, y, z, 1, 3, 'ember', visual.owner, 0.4);
    }
    if (light) vfx.lights.track(at.x, at.y, at.z, PALETTE.ember.hot, 2, 6);
    return light;
  }

  /** The Shade Swap clone: a dark violet silhouette that sheds ink, a crimson rim glow on head and chest and a thin crimson lane back to where it was thrown. */
  private drawShade(visual: ProjectileVisual, dt: number): void {
    const w = this.w, vfx = w.vfx, at = visual.display, rim = UMBRAL_RIM.body, hot = UMBRAL_RIM.hot, ground = at.y - 0.95;
    w.sprites.add(at.x, ground + 1.55, at.z, 0, 0, 0, 0.2, 0.2, VFX_FRAME.glow, rim.r, rim.g, rim.b, 0.5);
    w.sprites.add(at.x, ground + 1, at.z, 0, 0, 0, 0.3, 0.3, VFX_FRAME.glow, rim.r, rim.g, rim.b, 0.28);
    w.sprites.add(at.x, ground + 1.55, at.z, 0, 0, 0, 0.07, 0.07, VFX_FRAME.star, hot.r, hot.g, hot.b, 0.8);
    this.trail[0] = at.x; this.trail[1] = at.y; this.trail[2] = at.z;
    this.trail[3] = visual.scarFrom.x; this.trail[4] = visual.scarFrom.y; this.trail[5] = visual.scarFrom.z;
    const style = w.lines.style.reset();
    style.width = 0.09; style.taper = 0.5; style.cr = hot.r; style.cg = hot.g; style.cb = hot.b; style.gr = rim.r * 0.6; style.gg = rim.g * 0.6; style.gb = rim.b * 0.6; style.alpha0 = 0.7; style.alpha1 = 0.1;
    w.lines.add(this.trail, 2);
    visual.emitAcc += dt * (vfx.reducedEffects ? 4 : 14);
    for (; visual.emitAcc >= 1; visual.emitAcc--) silhouette(vfx, visual.owner, at.x, ground, at.z, 1.8, 0.28, UMBRAL_SMOKE, 0.5, UMBRAL_TINT);
    if (vfx.random() < 0.4) tintSparks(vfx, visual.owner, at.x, at.y, at.z, 1, 2, UMBRAL_TINT, 0.3);
  }
}
