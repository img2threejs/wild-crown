import { Vector3, type Object3D } from 'three';
import type { ActorSnapshot, CombatReactionKind } from '../../game/contracts.js';
import type { StoryCue } from '../story-cues.js';
import { ActorBodies } from './ActorBounds.js';
import type { ImpactSink } from './ElementKits.js';
import { PALETTE } from './palette.js';
import { VFX_FRAME } from './VfxAtlas.js';
import { VFX_COLORS, type VfxSystem } from './VfxSystem.js';
import { REACTION_TICKS_PER_SECOND, fallSeconds } from '../../rendering/ReactionPresenter.js';

/** Owner id of reaction effects driven from snapshots (cue-driven ones carry the cue's own scope owner). */
export const REACTION_VFX_OWNER = 0x7fff0100;
/** Slide dust puffs per second at full slide intensity. */
const SLIDE_DUST_HZ = 34;
/** Stars of a stun swirl, their orbit period (s) and spawn period (world seconds); the stars are stateless particles, so a short life redrawn each step draws a continuous orbit. */
const STAR_COUNT = 3;
const STAR_ORBIT_SECONDS = 1.15;
const STAR_STEP = 1 / 30;
const STAR_STEP_REDUCED = 0.25;
const STAR_LIFE = 0.16;

const clamp01 = (value: number): number => value < 0 ? 0 : value > 1 ? 1 : value;
const smooth = (value: number): number => { const t = clamp01(value); return t * t * (3 - 2 * t); };

/** Per actor: what was seen last frame, to detect transitions (fall end, launch landing) and pace emitters on the world clock. */
interface Seen {
  kind: CombatReactionKind | undefined;
  serial: number;
  progress: number;
  /** World seconds of the last slide-dust / star emission, and whether this entry was seen this frame. */
  dustAt: number;
  starAt: number;
  alive: boolean;
}

/**
 * Presentation of combat reactions in the VFX layer: feet-drag dust while a body slides, the dust and debris of a landing or a wall hit,
 * the star swirl over a stunned actor (a static ring of stars under reduced effects), the burst when poise breaks, and the camera shake /
 * screen punch scaled by the reaction's strength. It only reads snapshots and cues; the simulation is untouched and every emitter uses the
 * shared bounded particle pools, so reduced effects scale it down and `killOwner` cancels it.
 */
export class ReactionFx {
  private readonly seen = new Map<string, Seen>();
  private readonly bodies = new ActorBodies();
  private readonly at = new Vector3();
  private readonly push = new Vector3();

  constructor(
    private readonly vfx: VfxSystem,
    private readonly resolveRoot: ((actorId: string) => Object3D | undefined) | undefined,
    private impact?: ImpactSink,
  ) {}

  setImpactSink(impact: ImpactSink | undefined): void { this.impact = impact; }

  /** Feeds one reaction cue ('reaction-start' | 'wall-impact' | 'poise-break' | 'getup'). Returns false for any other kind. */
  play(cue: StoryCue, owner: number): boolean {
    const kind = cue.kind;
    if (kind !== 'reaction-start' && kind !== 'wall-impact' && kind !== 'poise-break' && kind !== 'getup') return false;
    const actorId = cue.actorId ?? cue.targetId;
    if (!actorId || !this.locate(actorId, cue)) return true;
    const strength = clamp01(cue.intensity ?? 0.5);
    const player = actorId === 'aren';
    switch (kind) {
      case 'reaction-start': this.start(cue.reactionKind, strength, player, owner); break;
      case 'wall-impact': this.wall(strength, owner); break;
      case 'poise-break': this.poiseBreak(actorId, owner); break;
      case 'getup': this.vfx.smoke(this.at.x, this.at.y + 0.05, this.at.z, 4, 0.35, 0.3, 0.7, 0.6, VFX_COLORS.dust, 0.3, owner, 0.6); break;
    }
    return true;
  }

  /** Snapshot pass, once per rendered frame: slide dust, landing dust and the stun swirl. */
  update(actors: readonly ActorSnapshot[]): void {
    const time = this.vfx.time;
    for (const entry of this.seen.values()) entry.alive = false;
    for (const actor of actors) {
      const reaction = actor.reaction;
      let entry = this.seen.get(actor.id);
      if (!reaction && !entry) continue;
      if (!entry) { entry = { kind: undefined, serial: -1, progress: 0, dustAt: -1, starAt: -1, alive: true }; this.seen.set(actor.id, entry); }
      entry.alive = true;
      const located = actor.visible && (reaction !== undefined || entry.kind === 'launch') && this.locate(actor.id, undefined);
      // A launch arc ends the frame the next reaction (the knockdown) takes over.
      if (located && entry.kind === 'launch' && reaction?.kind !== 'launch') this.land(actor.id, 0.12);
      if (reaction && located) {
        const strength = clamp01(reaction.strength), progress = clamp01(reaction.progress), same = entry.serial === reaction.serial;
        switch (reaction.kind) {
          case 'knockback': case 'stagger': {
            const slide = smooth((progress - 0.03) / 0.1) * (1 - smooth((progress - 0.8) / 0.2)) * (reaction.kind === 'stagger' ? 0.35 : 1) * (0.45 + 0.55 * strength);
            if (slide > 0.05 && time - entry.dustAt >= 1 / (SLIDE_DUST_HZ * slide)) { entry.dustAt = time; this.drag(reaction.direction.x, reaction.direction.z, slide); }
            break;
          }
          case 'knockdown': {
            // The fall ends where ReactionPresenter lands the body: dust and a thud at that moment.
            const seconds = Math.max(1, reaction.durationTicks) / REACTION_TICKS_PER_SECOND, fallEnd = fallSeconds(strength, seconds) / seconds;
            if (same && entry.progress < fallEnd && progress >= fallEnd) this.land(actor.id, 0.09);
            break;
          }
          case 'stun':
            if (time - entry.starAt >= (this.vfx.reducedEffects ? STAR_STEP_REDUCED : STAR_STEP)) { entry.starAt = time; this.stars(actor.id, time); }
            break;
          default: break;
        }
        entry.progress = progress;
      }
      entry.kind = reaction?.kind; entry.serial = reaction?.serial ?? -1;
      if (!reaction) this.seen.delete(actor.id);
    }
    for (const [id, entry] of this.seen) if (!entry.alive) this.seen.delete(id);
  }

  clear(): void { this.seen.clear(); }

  /** Resolves the actor's drawn position into `this.at` (feet) and the unit push of a cue into `this.push`. */
  private locate(actorId: string, cue: StoryCue | undefined): boolean {
    const root = this.resolveRoot?.(actorId);
    if (root) { root.updateWorldMatrix(true, false); root.getWorldPosition(this.at); }
    else if (cue?.position) this.at.set(cue.position.x, cue.position.y, cue.position.z);
    else return false;
    this.push.set(0, 0, 0);
    if (cue?.to && cue.position) this.push.set(cue.to.x - cue.position.x, 0, cue.to.z - cue.position.z);
    const length = this.push.length();
    if (length > 1e-4) this.push.multiplyScalar(1 / length);
    return true;
  }

  private bodyOf(actorId: string): { height: number; radius: number } {
    const root = this.resolveRoot?.(actorId);
    return root ? this.bodies.get(root) : { height: 1.7, radius: 0.5 };
  }

  /** Camera punch and dust of the first frame of a reaction, scaled by strength (flinches are too light to shake the camera). */
  private start(kind: CombatReactionKind | undefined, strength: number, player: boolean, owner: number): void {
    if (kind === 'flinch' || kind === undefined) return;
    const heavy = kind === 'knockdown' || kind === 'launch' || kind === 'stun';
    const amplitude = (player ? 0.07 : 0.035) + (player ? 0.2 : 0.11) * strength + (heavy ? 0.04 : 0);
    this.impact?.shake(amplitude, 0.22 + 0.22 * strength, 18);
    if (strength >= 0.55 || heavy) this.impact?.impulse?.(0.12 + 0.2 * strength, 0.18);
    if (kind === 'stagger') this.vfx.dustRing(this.at.x, this.at.y, this.at.z, 0.3 + 0.25 * strength, 5, owner);
  }

  /** Debris and dust where a thrown body meets a wall, plus a heavier camera hit. */
  private wall(strength: number, owner: number): void {
    const vfx = this.vfx, p = this.at, d = this.push;
    const x = p.x + d.x * 0.6, y = p.y + 0.7, z = p.z + d.z * 0.6;
    vfx.smoke(x, y, z, 5, 0.3, 0.35, 0.85 + 0.4 * strength, 0.7, VFX_COLORS.dust, 0.42, owner, 0.9);
    vfx.chunks(x, y, z, 4 + Math.round(6 * strength), 2.2 + 2.4 * strength, 0.07 + 0.05 * strength, owner);
    vfx.dustRing(p.x, p.y, p.z, 0.45 + 0.35 * strength, 6, owner);
    this.impact?.shake(0.1 + 0.26 * strength, 0.3 + 0.2 * strength, 22);
    this.impact?.impulse?.(0.2 + 0.25 * strength, 0.2);
  }

  /** Stars burst out and fall when poise breaks, with a flash above the head. */
  private poiseBreak(actorId: string, owner: number): void {
    const vfx = this.vfx, body = this.bodyOf(actorId), hot = PALETTE.gold.hot, base = PALETTE.gold.b;
    const x = this.at.x, y = this.at.y + body.height * 1.05, z = this.at.z;
    for (let i = vfx.count(8); i > 0; i -= 1) {
      const p = vfx.spec(), angle = vfx.random() * Math.PI * 2, speed = vfx.range(1.6, 3.2);
      p.x = x; p.y = y; p.z = z; p.vx = Math.cos(angle) * speed; p.vz = Math.sin(angle) * speed; p.vy = vfx.range(1.4, 2.8);
      p.gravity = 7; p.drag = 1.1; p.life = vfx.range(0.5, 0.8); p.size0 = 0.2; p.size1 = 0.1; p.frame = VFX_FRAME.star; p.spin = vfx.random() * 6.28; p.spinRate = vfx.range(-5, 5);
      p.r0 = hot.r; p.g0 = hot.g; p.b0 = hot.b; p.r1 = base.r; p.g1 = base.g; p.b1 = base.b; p.a0 = 0.95; p.fadeIn = 0.03; p.fadeOut = 0.6;
      vfx.emit(vfx.particles.additive, owner);
    }
    vfx.glow(x, y, z, body.radius * 1.4 + 0.6, 0.28, 'gold', 0.5, owner);
    this.impact?.shake(0.05, 0.18, 24);
    this.impact?.flashActor(actorId, PALETTE.gold.b, 1.2, 0.22, 'hit');
  }

  /** Dust kicked up behind a sliding body: a few low puffs drifting along the push. */
  private drag(dx: number, dz: number, amount: number): void {
    const vfx = this.vfx, p = this.at;
    vfx.smoke(p.x - dx * 0.25, p.y + 0.02, p.z - dz * 0.25, 1, 0.22, 0.18, 0.5 + 0.35 * amount, 0.5, VFX_COLORS.dust, 0.26 + 0.12 * amount, REACTION_VFX_OWNER, 0.35);
    if (vfx.random() < 0.3 * amount) vfx.chunks(p.x, p.y + 0.05, p.z, 1, 1.6, 0.05, REACTION_VFX_OWNER);
  }

  /** Landing dust and thud: the end of a knockdown's fall and the end of a launch arc. */
  private land(actorId: string, shake: number): void {
    const body = this.bodyOf(actorId), p = this.at, vfx = this.vfx;
    vfx.dustRing(p.x, p.y, p.z, 0.55 + 0.25 * body.radius, 9, REACTION_VFX_OWNER);
    vfx.smoke(p.x, p.y, p.z, 4, 0.35, 0.3, 0.8, 0.7, VFX_COLORS.dust, 0.38, REACTION_VFX_OWNER, 0.8);
    this.impact?.shake(shake, 0.25, 20);
  }

  /** The stun swirl: stars orbiting above the head; under reduced effects they hover in a static ring (no orbit, no bob). */
  private stars(actorId: string, time: number): void {
    const vfx = this.vfx, body = this.bodyOf(actorId), hot = PALETTE.gold.hot, base = PALETTE.gold.b, reduced = vfx.reducedEffects;
    const radius = Math.max(0.28, Math.min(0.9, body.radius * 0.55)), y = this.at.y + body.height * 1.05;
    const phase = reduced ? 0 : Math.PI * 2 * time / STAR_ORBIT_SECONDS;
    for (let k = 0; k < STAR_COUNT; k += 1) {
      const angle = phase + k * Math.PI * 2 / STAR_COUNT, p = vfx.spec();
      p.x = this.at.x + Math.cos(angle) * radius; p.y = y + (reduced ? 0 : 0.05 * Math.sin(time * 5 + k * 2)); p.z = this.at.z + Math.sin(angle) * radius * 0.8;
      p.life = reduced ? 0.32 : STAR_LIFE; p.size0 = 0.34; p.size1 = 0.26; p.frame = VFX_FRAME.star; p.spin = angle; p.spinRate = reduced ? 0 : 3;
      p.r0 = base.r; p.g0 = base.g; p.b0 = base.b; p.r1 = hot.r * 0.7; p.g1 = hot.g * 0.7; p.b1 = hot.b * 0.5; p.a0 = 1; p.fadeIn = 0.15; p.fadeOut = 0.5;
      vfx.emit(vfx.particles.additive, REACTION_VFX_OWNER);
    }
  }
}
