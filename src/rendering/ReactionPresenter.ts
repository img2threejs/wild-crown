import type { ActorSnapshot, CombatReactionKind, CombatReactionSnapshot } from '../game/contracts';
import { REACTION_TICKS } from '../game/combat/reactions';

/**
 * Presentation of the simulation's combat `reaction` (flinch, stagger, knockback, knockdown, launch, stun, get-up). Everything here is
 * a pure function of the snapshot plus a smoothing state per displayed actor: the simulation stays authoritative, nothing is written
 * back, and a frame allocates nothing (one preallocated pose per actor).
 *
 * Contract used (src/game/contracts.ts CombatReactionSnapshot): `direction` is the unit world-XZ push (attacker toward victim) and
 * drives every tilt, `side` weights the native recoil clip (a hit from behind arches the body forward instead of replaying a backward
 * recoil), `strength` the amplitude, `progress` x `durationTicks` the timing, `serial` restarts the presentation on a re-hit.
 */
export type ReactionBody = 'hero' | 'monster';
export type ReactionSide = CombatReactionSnapshot['side'];

/** World ticks (the reaction `durationTicks` unit) per second. */
export const REACTION_TICKS_PER_SECOND = 60;

/** Native clip slots the presentation may use, by body kind. */
export const REACTION_CLIPS = {
  hero: { hit: 'aren-hit', knockdown: 'aren-knockdown', knockdownForward: 'aren-knockdown-forward', getup: 'aren-getup', getupForward: 'aren-getup-forward' },
  monster: { hit: 'monster-hurt', knockdown: 'monster-knockdown', knockdownForward: 'monster-knockdown', getup: 'monster-getup', getupForward: 'monster-getup' },
} as const;

/**
 * Authored timing of the knockdown / get-up clips (asset contract, normalized clip time): the fall reaches the ground at `contact`,
 * settles, and holds the lying pose exactly from `hold` to the end; the get-up starts on that lying pose and ends on the idle.
 */
export const KNOCKDOWN_CLIP_TIMING = {
  hero: { fallSeconds: 1.5, contact: 30 / 90, hold: 48 / 90, getupSeconds: 66 / 60 },
  monster: { fallSeconds: 1.2, contact: 0.45, hold: 0.62, getupSeconds: 1.6 },
} as const;
/** Longest part (s) of the lying hold the get-up clip may start early, so the body is up when the simulation releases it. */
export const GETUP_LEAD_SECONDS = 0.6;

/** Window of the monster hurt clip the reactions sweep (flinch peak ~0.2, dazed hold 0.44–0.62, recovery to 1; MonsterAnimationProfiles). */
export const MONSTER_HURT_WINDOW = { recoilFrom: 0.1, recoilPeak: 0.28, dazed: 0.52, recoveryEnd: 0.8 } as const;
/** Share of the final pose the native recoil owns at its peak when it is an overlay on a playing clip. */
export const HIT_OVERLAY_PEAK = { hero: 0.6, monster: 0.85 } as const;
/** Body angle (rad) of a body with no knockdown clip lying on its back (procedural fallback). */
export const HERO_LYING_ANGLE = 1.42;

export interface ReactionContext {
  readonly body: ReactionBody;
  /** Authoritative world-clock seconds (stun sway phase); freezes with the world. */
  readonly clockSeconds: number;
  /** Drawn body height (m): mass proxy (heavier bodies tilt less) and pivot of a fall. */
  readonly bodyHeight: number;
  readonly hasHit: boolean;
  /** The actor's GLB carries the knockdown (fall onto the back / onto the stomach) and matching get-up clips of `REACTION_CLIPS`. */
  readonly hasKnockdown: boolean;
  readonly hasKnockdownForward: boolean;
  /** The knockdown follows a launch: the body is already on the ground, so the clip starts on its lying hold. */
  readonly afterLaunch: boolean;
  /** Seconds of the lying hold the get-up clip started early in the preceding knockdown (0 when it did not). */
  readonly getupLead: number;
  /** True while the actor is performing an attack pose that must keep reading (the flinch is then only an overlay with a reduced share). */
  readonly attacking: boolean;
  /** Stable 0..1 per actor so a pack never sways in unison. */
  readonly phase: number;
  /** Progress 0..1 through the reaction; the renderer interpolates it between two ticks of the same serial. */
  readonly progress: number;
  /** 1 normally; under reduced motion 0.5: tilt, bends and lift shrink and the dazed sway is off (the clip pose and the VFX stay). */
  readonly motionScale: number;
}

/** What one frame of a reaction asks of the renderer. Angles in radians, lengths in metres. */
export interface ReactionPose {
  kind: CombatReactionKind | undefined;
  /** Native clip that replaces the actor's own clip while set (`baseTime` is normalized clip time). */
  baseAction: string | undefined;
  baseTime: number;
  /** Native clip blended over whatever plays (`overlayShare` 0..0.9). */
  overlayAction: string | undefined;
  overlayTime: number;
  overlayShare: number;
  /** Whole-body tilt toward `dirX/dirZ` (world planar, unit): the top of the body moves along the push. */
  tilt: number;
  dirX: number;
  dirZ: number;
  /** Extra bend (rad) of spine and head toward the push; `sway` is the dazed lateral roll (+ = body right). */
  spine: number;
  head: number;
  sway: number;
  /** Drawn lift (m) over the ground and the planar shift (m) along -direction that keeps a lying body over its footprint. */
  lift: number;
  shift: number;
  /** 0..1 feet-drag dust intensity (knockback slide). */
  dust: number;
  /** 0..1 daze (stun) amount, for stars and the dazed head loop. */
  daze: number;
  /** Progress 0..1 of the active reaction and its length in seconds. */
  progress: number;
  seconds: number;
}

export function createReactionPose(): ReactionPose {
  return {
    kind: undefined, baseAction: undefined, baseTime: 0, overlayAction: undefined, overlayTime: 0, overlayShare: 0,
    tilt: 0, dirX: 0, dirZ: 1, spine: 0, head: 0, sway: 0, lift: 0, shift: 0, dust: 0, daze: 0, progress: 0, seconds: 0,
  };
}

const clamp01 = (value: number): number => value < 0 ? 0 : value > 1 ? 1 : value;
const smooth = (value: number): number => { const t = clamp01(value); return t * t * (3 - 2 * t); };
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Rise to 1 within `attack` of the progress, hold, then ease out over the remainder after `hold`. */
export function impulseEnvelope(progress: number, attack: number, hold: number): number {
  return smooth(progress / attack) * (1 - smooth((progress - hold) / (1 - hold)));
}

/** A hit's direction in the actor's frame: `forward` along its facing, `right` toward its right hand (yaw about +Y, facing = (sin, cos)). */
export function localReactionDirection(dirX: number, dirZ: number, yaw: number, out: { forward: number; right: number }): void {
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  out.forward = dirX * sin + dirZ * cos;
  out.right = -dirX * cos + dirZ * sin;
}

/** The side a push came from: an attacker stands opposite the push, so a push along the facing is a hit from behind. */
export function hitSideOf(dirX: number, dirZ: number, yaw: number): ReactionSide {
  const local = { forward: 0, right: 0 };
  localReactionDirection(dirX, dirZ, yaw, local);
  if (local.forward <= -Math.SQRT1_2) return 'front';
  if (local.forward >= Math.SQRT1_2) return 'back';
  return local.right < 0 ? 'right' : 'left';
}

/** Share of the native recoil kept for a side: a hit from behind has no backward recoil to replay, so the procedural arch carries it. */
export function sideRecoilWeight(side: ReactionSide): number {
  return side === 'front' ? 1 : side === 'back' ? 0.55 : 0.8;
}

/** Heavier (taller) bodies tilt less; 1 at a hero's height. */
function massScale(bodyHeight: number): number { return Math.max(0.45, Math.min(1.25, 1.7 / Math.max(0.5, bodyHeight))); }

/** Seconds a knocked-down body takes to hit the ground: longer for harder hits, never more than half of the knockdown. */
export function fallSeconds(strength: number, seconds: number): number { return Math.min(seconds * 0.5, 0.34 + 0.22 * clamp01(strength)); }

interface KnockdownPair { readonly fall: string; readonly getup: string }
const PAIRS: Readonly<Record<ReactionBody, { readonly back: KnockdownPair; readonly forward: KnockdownPair }>> = {
  hero: { back: { fall: REACTION_CLIPS.hero.knockdown, getup: REACTION_CLIPS.hero.getup }, forward: { fall: REACTION_CLIPS.hero.knockdownForward, getup: REACTION_CLIPS.hero.getupForward } },
  monster: { back: { fall: REACTION_CLIPS.monster.knockdown, getup: REACTION_CLIPS.monster.getup }, forward: { fall: REACTION_CLIPS.monster.knockdownForward, getup: REACTION_CLIPS.monster.getupForward } },
};
/** The fall / get-up clip pair for a hit from `side` (a hit from behind pitches the body onto its stomach), or undefined without clips. */
export function knockdownPair(context: ReactionContext, side: ReactionSide): KnockdownPair | undefined {
  if (side === 'back' && context.hasKnockdownForward) return PAIRS[context.body].forward;
  return context.hasKnockdown ? PAIRS[context.body].back : undefined;
}
/** Seconds of a knockdown's lying hold the get-up clip starts early (after the fall and settle), at most `GETUP_LEAD_SECONDS`. */
export function getupLeadSeconds(body: ReactionBody, strength: number, seconds: number, afterLaunch: boolean): number {
  const timing = KNOCKDOWN_CLIP_TIMING[body];
  const grounded = afterLaunch ? 0 : fallSeconds(strength, seconds) + (timing.hold - timing.contact) * timing.fallSeconds;
  return Math.max(0, Math.min(GETUP_LEAD_SECONDS, seconds - grounded));
}
const GETUP_REACTION_SECONDS = REACTION_TICKS.getup / REACTION_TICKS_PER_SECOND;
/**
 * Normalized knockdown-clip time `t` seconds into the knockdown: the authored fall is fitted to the simulation's fall time, the settle
 * plays at its authored speed, then the lying pose holds. After a launch the body is already down, so the clip starts on its hold.
 */
function knockdownClipTime(body: ReactionBody, t: number, fall: number, afterLaunch: boolean): number {
  const timing = KNOCKDOWN_CLIP_TIMING[body];
  if (afterLaunch) return timing.hold;
  if (t < fall) return timing.contact * (t / fall);
  return Math.min(timing.hold, timing.contact + (t - fall) / timing.fallSeconds);
}

/** Writes the pose a reaction asks for at its current progress. `reaction` undefined writes the rest pose. */
export function resolveReactionPose(out: ReactionPose, reaction: CombatReactionSnapshot | undefined, context: ReactionContext): ReactionPose {
  out.kind = undefined; out.baseAction = undefined; out.baseTime = 0; out.overlayAction = undefined; out.overlayTime = 0; out.overlayShare = 0;
  out.tilt = out.spine = out.head = out.sway = out.lift = out.shift = out.dust = out.daze = out.progress = out.seconds = 0;
  if (!reaction) return out;
  const hero = context.body === 'hero', clips = REACTION_CLIPS[context.body];
  const s = clamp01(reaction.strength), p = clamp01(context.progress), seconds = Math.max(1, reaction.durationTicks) / REACTION_TICKS_PER_SECOND;
  const mass = massScale(context.bodyHeight), side = sideRecoilWeight(reaction.side);
  out.kind = reaction.kind; out.progress = p; out.seconds = seconds;
  out.dirX = reaction.direction.x; out.dirZ = reaction.direction.z;
  const hit = context.hasHit ? clips.hit : undefined;
  const pitchPeak = hero ? HIT_OVERLAY_PEAK.hero : HIT_OVERLAY_PEAK.monster;

  switch (reaction.kind) {
    case 'flinch': {
      const e = impulseEnvelope(p, 0.12, 0.3);
      out.spine = (0.12 + 0.16 * s) * e; out.head = (0.18 + 0.2 * s) * e; out.tilt = 0.03 * s * e * mass;
      // A monster's flinch is the native hurt overlay of MonsterAnimationProfiles.resolveMonsterHitOverlay (its share depends on the attack pose it keeps).
      if (hit && hero) {
        out.overlayAction = hit;
        out.overlayShare = pitchPeak * (context.attacking ? 0.4 : 1) * side * e;
        out.overlayTime = p;
      }
      break;
    }
    case 'stagger': {
      const e = impulseEnvelope(p, 0.14, 0.4);
      out.spine = (0.26 + 0.22 * s) * e; out.head = (0.28 + 0.2 * s) * e; out.tilt = (0.07 + 0.1 * s) * e * mass;
      if (hit) { out.baseAction = hit; out.baseTime = hero ? p : lerp(MONSTER_HURT_WINDOW.recoilFrom, MONSTER_HURT_WINDOW.recoveryEnd, p); }
      out.dust = 0.35 * e * s;
      break;
    }
    case 'knockback': {
      const e = smooth(p / 0.18) * (1 - smooth((p - 0.62) / 0.38));
      out.tilt = (0.2 + 0.34 * s) * e * mass; out.spine = (0.22 + 0.2 * s) * e; out.head = (0.3 + 0.25 * s) * e;
      if (hit) {
        out.baseAction = hit;
        out.baseTime = hero ? 0.55 * smooth(p / 0.3) + 0.45 * smooth((p - 0.7) / 0.3)
          : p < 0.7 ? lerp(MONSTER_HURT_WINDOW.recoilFrom, MONSTER_HURT_WINDOW.recoilPeak, smooth(p / 0.25)) : lerp(MONSTER_HURT_WINDOW.recoilPeak, MONSTER_HURT_WINDOW.recoveryEnd, smooth((p - 0.7) / 0.3));
      }
      out.dust = smooth((p - 0.03) / 0.1) * (1 - smooth((p - 0.8) / 0.2)) * (0.45 + 0.55 * s);
      break;
    }
    case 'launch': {
      const arc = 4 * p * (1 - p);
      out.lift = reaction.lift ?? (0.45 + 0.9 * s) * arc;
      const pair = knockdownPair(context, reaction.side);
      if (pair) {
        // Thrown through the air: the fall plays across the flight and touches down as the launch ends (the knockdown then lies).
        out.baseAction = pair.fall; out.baseTime = KNOCKDOWN_CLIP_TIMING[context.body].contact * smooth(p);
        break;
      }
      out.tilt = (0.45 + 0.6 * s) * smooth(p / 0.8) * mass; out.spine = 0.3 * smooth(p / 0.3); out.head = 0.35 * smooth(p / 0.3);
      if (hit) { out.baseAction = hit; out.baseTime = hero ? 0.3 + 0.3 * p : MONSTER_HURT_WINDOW.recoilPeak; }
      break;
    }
    case 'knockdown': {
      const fall = fallSeconds(s, seconds), t = p * seconds, q = clamp01(t / fall), landed = Math.max(0, t - fall);
      const pair = knockdownPair(context, reaction.side);
      if (pair) {
        const lead = getupLeadSeconds(context.body, s, seconds, context.afterLaunch), getupFrom = seconds - lead;
        if (lead > 0 && t >= getupFrom) {
          out.baseAction = pair.getup; out.baseTime = clamp01((t - getupFrom) / (lead + GETUP_REACTION_SECONDS));
        } else {
          out.baseAction = pair.fall; out.baseTime = knockdownClipTime(context.body, t, fall, context.afterLaunch);
        }
        break;
      }
      // No authored knockdown on this GLB: the rigid procedural fall (tilt onto the back, short bounce, rest).
      out.tilt = (hero ? HERO_LYING_ANGLE * q * q : 0.18 * (1 - smooth(q)) * mass);
      out.spine = hero ? 0.25 * (1 - q) : 0; out.head = hero ? 0.3 * (1 - q) + 0.1 * q : 0;
      out.lift = (hero ? 0.1 : 0.05) * Math.exp(-9 * landed) * Math.abs(Math.sin(15 * landed)) * (q >= 1 ? 1 : 0);
      if (hit) { out.baseAction = hit; out.baseTime = hero ? 0.6 : MONSTER_HURT_WINDOW.dazed; }
      break;
    }
    case 'getup': {
      const pair = knockdownPair(context, reaction.side);
      if (pair) {
        // Continues the get-up clip the knockdown started early; it ends on the idle as the simulation releases the body.
        const lead = context.getupLead;
        out.baseAction = pair.getup; out.baseTime = clamp01((lead + p * seconds) / (lead + seconds));
        break;
      }
      const rise = smooth(p / 0.85);
      if (hero) {
        out.tilt = HERO_LYING_ANGLE * (1 - rise);
        out.spine = 0.35 * Math.sin(Math.PI * clamp01(p / 0.9)); out.head = 0.2 * (1 - rise);
        out.lift = 0.08 * Math.sin(Math.PI * clamp01((p - 0.4) / 0.6));
        out.baseAction = hit; out.baseTime = 0.6 * (1 - smooth(p));
      } else if (hit) { out.baseAction = hit; out.baseTime = lerp(MONSTER_HURT_WINDOW.dazed, MONSTER_HURT_WINDOW.recoveryEnd, smooth(p)); }
      break;
    }
    case 'stun': {
      const e = smooth(p / 0.12) * (1 - smooth((p - 0.9) / 0.1));
      const omega = Math.PI * 2 * 0.85;
      const wave = Math.sin(omega * context.clockSeconds + context.phase * Math.PI * 2);
      out.daze = e; out.sway = wave * (0.09 + 0.05 * s) * e; out.spine = (0.16 + 0.06 * s) * e; out.head = (0.22 + 0.1 * Math.cos(omega * 0.5 * context.clockSeconds + context.phase * 5)) * e;
      out.tilt = 0.05 * e * mass;
      if (hit) {
        out.baseAction = hit;
        out.baseTime = hero ? 0.5 : MONSTER_HURT_WINDOW.dazed + 0.05 * wave;
      }
      break;
    }
  }
  const scale = context.motionScale;
  if (scale !== 1) { out.tilt *= scale; out.spine *= scale; out.head *= scale; out.lift *= scale; out.sway = scale < 1 ? 0 : out.sway * scale; }
  return out;
}

/** Fields smoothed toward their target (rate 1/s): quick enough to keep the authored impulses, slow enough to remove pops between reactions. */
const RATE = { tilt: 22, spine: 26, head: 26, sway: 14, lift: 34, shift: 22, dust: 40, daze: 8 } as const;
/** Seconds a new reaction takes to take over from the pose its predecessor left (ease from the entry values to its own). */
const ENTER_SECONDS = 0.12;

/** Per displayed actor: resolves the reaction each frame and smooths the continuous fields so chained reactions (launch → knockdown → get-up) never pop. */
export class ReactionPresenter {
  /** The smoothed pose the renderer applies this frame. */
  readonly pose: ReactionPose = createReactionPose();
  private readonly target = createReactionPose();
  /** Last pose seen with a reaction, to decay from; true while any smoothed value is still visible. */
  private visible = false;
  private serial = -1;
  /** The smoothed tilt, spine, head and lift the pose had when the current reaction started: the new reaction blends away from them (a launch landing into a knockdown continues from its tilt). */
  private readonly entry = { tilt: 0, spine: 0, head: 0, lift: 0 };
  /** Kind of the current and the preceding reaction (by serial), and the get-up lead the current knockdown uses. */
  private kind: CombatReactionKind | undefined;
  private previousKind: CombatReactionKind | undefined;
  private knockdownLead = 0;
  /** The caller's context plus the chain fields this presenter derives (copied each frame; no allocation). */
  private readonly context: { -readonly [K in keyof ReactionContext]: ReactionContext[K] } = {
    body: 'hero', clockSeconds: 0, bodyHeight: 1.7, hasHit: false, hasKnockdown: false, hasKnockdownForward: false, afterLaunch: false, getupLead: 0,
    attacking: false, phase: 0, progress: 0, motionScale: 1,
  };

  /** True while the pose still moves the body (a reaction runs or its smoothed values have not settled). */
  get active(): boolean { return this.visible; }

  /** `dt` is real seconds; 0 (a frame of zero length) holds the pose. `context.afterLaunch`/`getupLead` are derived here. */
  update(reaction: CombatReactionSnapshot | undefined, context: ReactionContext, dt: number): ReactionPose {
    const pose = this.pose, chain = this.context;
    if (reaction && reaction.serial !== this.serial) {
      this.serial = reaction.serial;
      this.previousKind = this.kind; this.kind = reaction.kind;
      this.entry.tilt = pose.tilt; this.entry.spine = pose.spine; this.entry.head = pose.head; this.entry.lift = pose.lift;
    }
    Object.assign(chain, context);
    chain.afterLaunch = reaction?.kind === 'knockdown' && this.previousKind === 'launch';
    if (reaction?.kind === 'knockdown') {
      this.knockdownLead = getupLeadSeconds(context.body, clamp01(reaction.strength), Math.max(1, reaction.durationTicks) / REACTION_TICKS_PER_SECOND, chain.afterLaunch);
    }
    chain.getupLead = reaction?.kind === 'getup' && this.previousKind === 'knockdown' ? this.knockdownLead : 0;
    const target = resolveReactionPose(this.target, reaction, chain);
    if (reaction) {
      const enter = smooth(target.progress * target.seconds / ENTER_SECONDS), from = this.entry;
      target.tilt = from.tilt + (target.tilt - from.tilt) * enter; target.spine = from.spine + (target.spine - from.spine) * enter;
      target.head = from.head + (target.head - from.head) * enter; target.lift = from.lift + (target.lift - from.lift) * enter;
    }
    // Clip requests are never smoothed: the animation controller owns the crossfade.
    pose.kind = target.kind; pose.baseAction = target.baseAction; pose.baseTime = target.baseTime;
    pose.overlayAction = target.overlayAction; pose.overlayTime = target.overlayTime; pose.overlayShare = target.overlayShare;
    pose.progress = target.progress; pose.seconds = target.seconds;
    if (reaction) { pose.dirX = target.dirX; pose.dirZ = target.dirZ; }
    if (!this.visible && !reaction) return pose;
    const follow = (rate: number): number => dt > 0 ? 1 - Math.exp(-rate * dt) : 0;
    pose.tilt += (target.tilt - pose.tilt) * follow(RATE.tilt);
    pose.spine += (target.spine - pose.spine) * follow(RATE.spine);
    pose.head += (target.head - pose.head) * follow(RATE.head);
    pose.sway += (target.sway - pose.sway) * follow(RATE.sway);
    pose.lift += (target.lift - pose.lift) * follow(RATE.lift);
    pose.dust += (target.dust - pose.dust) * follow(RATE.dust);
    pose.daze += (target.daze - pose.daze) * follow(RATE.daze);
    const lyingShift = context.body === 'hero' ? context.bodyHeight * 0.5 * Math.sin(Math.min(pose.tilt, HERO_LYING_ANGLE)) * 0.5 : 0;
    pose.shift += (lyingShift - pose.shift) * follow(RATE.shift);
    const settled = Math.abs(pose.tilt) < 1e-3 && Math.abs(pose.spine) < 1e-3 && Math.abs(pose.head) < 1e-3 && Math.abs(pose.sway) < 1e-3
      && Math.abs(pose.lift) < 1e-3 && Math.abs(pose.shift) < 1e-3 && pose.dust < 1e-3 && pose.daze < 1e-3;
    if (!reaction && settled) { pose.tilt = pose.spine = pose.head = pose.sway = pose.lift = pose.shift = pose.dust = pose.daze = 0; this.visible = false; }
    else this.visible = true;
    return pose;
  }

  /** Forgets the smoothed pose (teleport, respawn, a released rig). */
  reset(): void {
    const pose = this.pose;
    Object.assign(pose, createReactionPose());
    this.visible = false; this.serial = -1; this.kind = this.previousKind = undefined; this.knockdownLead = 0;
    this.entry.tilt = this.entry.spine = this.entry.head = this.entry.lift = 0;
  }
}

/** Data the UI needs to draw a hostile's poise bar and stun timer (the snapshot already carries `poise`; this adds the stun drain). */
export interface PoiseBarModel {
  /** 0..1 build-up; `undefined` for actors without poise (no bar). */
  readonly poise: number | undefined;
  readonly stunned: boolean;
  /** 1 at the start of a stun draining to 0 at its end; 0 when not stunned. */
  readonly stunRemaining: number;
}
const NO_BAR: PoiseBarModel = { poise: undefined, stunned: false, stunRemaining: 0 };

export function poiseBarModel(actor: Pick<ActorSnapshot, 'poise' | 'reaction'>): PoiseBarModel {
  if (actor.poise === undefined) return NO_BAR;
  const stun = actor.reaction?.kind === 'stun' ? actor.reaction : undefined;
  return { poise: clamp01(actor.poise), stunned: stun !== undefined, stunRemaining: stun ? 1 - clamp01(stun.progress) : 0 };
}
