import type { ActorSnapshot } from '../game/contracts';
import { clip, loop, plan, type Ease, type LocomotionProfile, type MonsterAttackPlan, type PhaseStep, type PlanClipAction } from './MonsterAnimationPlan';
import { BAMBOO_ATTACK_PLANS, BAMBOO_HOVER, BAMBOO_LOCOMOTION } from './BambooMonsterProfiles';
import { GROVE_ATTACK_PLANS, GROVE_HOVER, GROVE_LOCOMOTION } from './GroveMonsterProfiles';
import { MISTVEIL_ATTACK_PLANS, MISTVEIL_HOVER, MISTVEIL_LOCOMOTION } from './MistveilMonsterProfiles';
import { MOONPINE_ATTACK_PLANS, MOONPINE_HOVER, MOONPINE_LOCOMOTION } from './MoonpineMonsterProfiles';
import { LATER_ATTACK_PLANS, LATER_LOCOMOTION } from './LaterMonsterProfiles';

/**
 * Generic clip slots bound by each Tripo monster manifest's `actionToClipMapping`. Every monster manifest maps the ten base keys to a
 * native clip name; `monster-tail` is the optional eleventh slot, authored only for rigs with a real tail chain (mire-viper, ghor,
 * root-rammer, ... see each clips report) and referenced only by tail attacks of those rigs. `monster-death` and `monster-spawn` are the
 * one-shot lifecycle slots every monster GLB carries (the renderer plays them from a defeat / first-appearance timestamp).
 *
 * Authoring contract (in-place clips, normalized time 0..1):
 * slash = head/tusk side-swipe, strike pose ~0.45; shoot = rear back then thrust/expel ~0.5;
 * jump = crouch 0–0.3, airborne 0.3–0.7, land 0.7–0.85, settle; dive = low lunge, strike ~0.4;
 * hurt = flinch ~0.2, then a dazed pose held 0.44–0.62, then recovery; turn = loopable pivot; roar = head raised, sustained 0.25–0.8;
 * tail = tail whip / sweep, windup to ~0.36, strike ~0.5, ring-down to ~0.8; idle / walk / run loop;
 * death = recoil, collapse onto the ground, held collapsed pose from ~0.82 (rests on the floor, never loops);
 * spawn = rise / alert / shake-off, ending on the first frame of the idle clip.
 */
export const MONSTER_CLIP_ACTIONS = ['monster-idle', 'monster-walk', 'monster-run', 'monster-slash', 'monster-shoot', 'monster-jump', 'monster-hurt', 'monster-turn', 'monster-dive', 'monster-roar', 'monster-tail', 'monster-death', 'monster-spawn', 'monster-knockdown', 'monster-getup'] as const;
export type MonsterClipAction = typeof MONSTER_CLIP_ACTIONS[number];

/** Authored one-shot durations (seconds, 30 fps; scripts/assets/creature-rig-kit.mjs SLOT_SECONDS): the renderer maps elapsed world time onto them. */
export const MONSTER_DEATH_SECONDS = 1.6;
export const MONSTER_SPAWN_SECONDS = 1.4;
/** Knockdown / get-up: the non-lethal hit reaction. Knockdown is the matched shove to the ground (alert held lie, not a death);
 * get-up starts on the knockdown's last frame and ends blended into the idle pose (the sampler holds the last quarter to it). */
export const MONSTER_KNOCKDOWN_SECONDS = 1.2;
export const MONSTER_GETUP_SECONDS = 1.6;
/** Boss phase roar: the 2.0 s `monster-roar` clip is overlaid over its stamp + shake (clip time 0..0.8) at 1x. */
export const BOSS_ROAR_CLIP_SECONDS = 2.0;
export const BOSS_ROAR_WINDOW = { from: 0, to: 0.8 } as const;
/** A boss starts its phase roar the first time its vitality ratio falls below this. */
export const BOSS_ROAR_VITALITY_RATIO = 0.5;
/** Walk -> run is entered at `runThreshold * (1 + band)` and left below `runThreshold * (1 - band)`, so a speed hovering at the threshold never flickers. */
export const GAIT_HYSTERESIS_BAND = 0.12;

/**
 * Normalized time of the dazed pose inside the hurt clip (held 0.44–0.62). Downed and weak-point-exposed monsters sample this one pose
 * instead of looping the finite flinch.
 */
export const MONSTER_HURT_HOLD_TIME = 0.52;

/**
 * Window of the 2.0 s `monster-roar` clip played across the roar pause (`roarProgress` 0..1 over ROAR_TICKS = 42 world ticks = 0.7 s at 60 Hz):
 * 0.35 of the clip is 0.7 s, so the clip plays at 1x. 0.10–0.45 covers the paw stamp (contact ~0.2) and the head-raised shake that begins at 0.25.
 */
export const ROAR_CLIP_SECONDS = 2.0;
export const ROAR_CLIP_WINDOW = { from: 0.1, to: 0.45 } as const;

export interface MonsterAnimationSample {
  readonly actionId: PlanClipAction;
  /** 'idle' loops on the actor clock; any other phase samples `normalizedTime` of the finite clip. */
  readonly phase: 'idle' | 'active';
  readonly normalizedTime: number;
  readonly loopRate: number;
}

/** Every Greenwake attack id the trials (and the legacy encounter) can cast. */
export const MONSTER_ATTACK_PLANS: Readonly<Record<string, MonsterAttackPlan>> = {
  // Paws and revs on the spot (run cycle ramping up), then the dive clip's lunge carries the charge.
  'boar-charge': { windup: loop('monster-run', 0.35, 0.9), commit: loop('monster-run', 1.6, 2.4), active: clip('monster-dive', 0.3, 0.62), recovery: clip('monster-dive', 0.62, 1, 'out') },
  'boar-ember-lance': plan('monster-shoot', [0, 0.38], [0.38, 0.5], [0.5, 0.75], [0.75, 1]),
  'boar-gale-scythe': plan('monster-slash', [0, 0.3], [0.3, 0.45], [0.45, 0.72], [0.72, 1]),
  'boar-pounce': plan('monster-jump', [0, 0.3], [0.3, 0.5], [0.5, 0.78], [0.78, 1]),
  'boar-sap-thrash': plan('monster-dive', [0, 0.2], [0.2, 0.36], [0.36, 0.5], [0.5, 0.95]),
  'sap-stalker-frost-bloom': plan('monster-jump', [0, 0.3], [0.3, 0.42], [0.42, 0.8], [0.8, 1]),
  // Slowed exhale: starts partway into the rear-back and lingers through a long recovery.
  'sap-stalker-venom-mist': plan('monster-shoot', [0.05, 0.34], [0.34, 0.45], [0.45, 0.58], [0.58, 1]),
  // Fast snap: begins mid-wind-up so the short warning still shows a moving strike.
  'sap-vein-snap': plan('monster-slash', [0.14, 0.34], [0.34, 0.45], [0.45, 0.62], [0.62, 0.92]),
  'sap-vein-thrash': plan('monster-slash', [0.08, 0.36], [0.36, 0.45], [0.45, 0.6], [0.6, 1]),
  // Heavy slam: the commit window is the airborne arc, the active window the landing.
  'root-rammer-low-wave': plan('monster-jump', [0, 0.3], [0.3, 0.68], [0.68, 0.85], [0.85, 1]),
  'root-rammer-cinder-burst': plan('monster-dive', [0, 0.25], [0.25, 0.38], [0.38, 0.55], [0.55, 1]),
  // Spin up on the pivot clip, then release into a tail whip.
  'root-rammer-gale-sweep': { windup: loop('monster-turn', 0.8, 2.2), commit: loop('monster-turn', 2.6), active: clip('monster-tail', 0.46, 0.8), recovery: clip('monster-tail', 0.8, 1, 'out') },
  'root-rammer-slam': plan('monster-dive', [0, 0.3], [0.3, 0.4], [0.4, 0.6], [0.6, 1]),

  // ---- Whispering Canopy playtest (docs/features/story-effects.md, "Canopy monsters") ----
  // Thornback Howler. The shoot clip expels at ~0.5: rear back through the windup, the throw is the commit (the rock flies), the active window is the impact + follow-through.
  'howler-rock-hurl': plan('monster-shoot', [0, 0.5], [0.5, 0.68], [0.68, 0.85], [0.85, 1]),
  // The jump clip crouches 0-0.3 (windup), is airborne 0.3-0.7 (commit = the leap) and lands 0.7-0.85 (active = the slam).
  'howler-leap-slam': plan('monster-jump', [0, 0.3], [0.3, 0.7], [0.7, 0.85], [0.85, 1]),
  // Side-swipe: the strike pose ~0.45 opens the active window.
  'howler-branch-sweep': plan('monster-slash', [0, 0.3], [0.3, 0.45], [0.45, 0.74], [0.74, 1]),
  // Storm Hornbill. The dive clip's low lunge strikes ~0.4; the wing-fold windup is the first fifth, the commit drops into the lane.
  'hornbill-dive-bomb': plan('monster-dive', [0, 0.2], [0.2, 0.36], [0.36, 0.62], [0.62, 1]),
  // Darts leave on the expel (commit); the active window is their impact.
  'hornbill-feather-volley': plan('monster-shoot', [0.04, 0.5], [0.5, 0.66], [0.66, 0.8], [0.8, 1]),
  // Wingbeat: the slash clip as a downward flap, its strike pose ~0.45 launches the gale.
  'hornbill-gale-flap': plan('monster-slash', [0.04, 0.32], [0.32, 0.45], [0.45, 0.72], [0.72, 1]),
  // Mire Viper. Spit: slowed exhale, the glob leaves on the expel (commit) and the long active window holds the follow-through. Lash: the tail clip's windup coils the body, the commit accelerates the lash and the active window opens on its crack (~0.5). Lunge: rear back, then the dive clip's strike.
  'viper-venom-spit': plan('monster-shoot', [0.05, 0.5], [0.5, 0.62], [0.62, 0.72], [0.72, 1]),
  'viper-tail-lash': plan('monster-tail', [0, 0.36], [0.36, 0.5], [0.5, 0.8], [0.8, 1]),
  'viper-strike-lunge': plan('monster-dive', [0, 0.18], [0.18, 0.38], [0.38, 0.6], [0.6, 1]),
  ...GROVE_ATTACK_PLANS, ...MOONPINE_ATTACK_PLANS, ...MISTVEIL_ATTACK_PLANS, ...BAMBOO_ATTACK_PLANS, ...LATER_ATTACK_PLANS,
};

export const MONSTER_LOCOMOTION: Readonly<Record<string, LocomotionProfile>> = {
  // Authored ikGait walks (scripts/assets/author-quadruped-clips.mjs): walkRef is the ground speed at which the clip's planted feet do not
  // slide, i.e. the clips report's walk.planting.plantedSpeedUnitsPerSecond times the manifest scale (boar 0.7474 x 2.35, stalker 0.8117 x 2.45,
  // rammer 0.5194 x 3, rounded to 0.05 m/s); the loop rate speed / walkRef then keeps them planted across the walk range.
  'actor-ember-boar': { runThreshold: 3.5, walkRef: 1.75, runRef: 4.6 },
  'actor-frost-sap-stalker': { runThreshold: 4, walkRef: 2, runRef: 5 },
  'actor-root-rammer': { runThreshold: 2.2, walkRef: 1.55, runRef: 2.6 },
  // Canopy playtest: references follow the AI profiles' advance/circle speeds (howler 4.8/4.0, hornbill 5.2/4.4, viper 2.6/1.9 m/s).
  'actor-thornback-howler': { runThreshold: 3.4, walkRef: 2.4, runRef: 4.8 },
  'actor-storm-hornbill': { runThreshold: 3.8, walkRef: 2.6, runRef: 5.2 },
  'actor-mire-viper': { runThreshold: 2.2, walkRef: 1.3, runRef: 2.6 },
  ...GROVE_LOCOMOTION, ...MOONPINE_LOCOMOTION, ...MISTVEIL_LOCOMOTION, ...BAMBOO_LOCOMOTION, ...LATER_LOCOMOTION,
  'actor-ridge-elder-scout': LATER_LOCOMOTION['actor-sable']!,
  'actor-ridge-young-scout': LATER_LOCOMOTION['actor-luma']!,
  'actor-nursery-cub': BAMBOO_LOCOMOTION['actor-tali']!,
};

const MOVING_SPEED = 0.15;
const TURNING_RATE = 0.5;
const ATTACK_PREFIX = 'wild-crown:';

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
function ease(kind: Ease, t: number): number {
  switch (kind) {
    case 'in': return t * t;
    case 'out': return 1 - (1 - t) * (1 - t);
    case 'inOut': return t * t * (3 - 2 * t);
    case 'linear': return t;
  }
}

function stepSample(step: PhaseStep, progress: number): MonsterAnimationSample {
  const t = clamp01(progress);
  if ('loopRate' in step) return { actionId: step.action, phase: 'idle', normalizedTime: 0, loopRate: step.loopRate + ((step.toLoopRate ?? step.loopRate) - step.loopRate) * t };
  return { actionId: step.action, phase: 'active', normalizedTime: clamp01(step.from + (step.to - step.from) * ease(step.ease, t)), loopRate: 1 };
}

/**
 * Chapter statuses of a story actor that are never a defeat, whatever its vitality: a cleansed or reunited boss, a subdued hunter and a
 * sheltered or endangered cub. Their lifecycle is presentation of the status (StoryActorAnimation), never `monster-death`.
 */
export const NONLETHAL_CHAPTER_STATUSES: Readonly<Partial<Record<NonNullable<ActorSnapshot['chapterStatus']>, true>>> = {
  cleansed: true, reunion: true, subdued: true, kneeling: true, 'in-danger': true, sheltered: true,
};

/** True once a monster's authoritative vitality is spent (a defeated trial monster is also `downed`, neutral and standing still). A story actor's nonlethal chapter status is never a defeat. */
export function isMonsterDefeated(actor: ActorSnapshot): boolean {
  if (actor.chapterStatus !== undefined && NONLETHAL_CHAPTER_STATUSES[actor.chapterStatus]) return false;
  return actor.allegiance !== 'player' && actor.vitality !== undefined && actor.vitality <= 0;
}

/**
 * Presentation-only mapping from an authoritative monster snapshot to a native clip sample. `previousGait` is the gait the monster was
 * playing on the previous frame: a walk becomes a run only above `runThreshold * (1 + GAIT_HYSTERESIS_BAND)` and a run falls back to
 * the walk only below `runThreshold * (1 - GAIT_HYSTERESIS_BAND)`; without a previous gait the plain threshold decides.
 */
export function resolveMonsterAnimation(actor: ActorSnapshot, assetId: string, previousGait?: 'monster-walk' | 'monster-run'): MonsterAnimationSample | undefined {
  const locomotion = MONSTER_LOCOMOTION[assetId];
  if (!locomotion) return undefined;
  if (actor.downed) return { actionId: 'monster-hurt', phase: 'active', normalizedTime: MONSTER_HURT_HOLD_TIME, loopRate: 1 };
  if (actor.actionId.endsWith('-stagger')) return { actionId: 'monster-hurt', phase: 'active', normalizedTime: clamp01(actor.normalizedTime), loopRate: 1 };
  const attack = actor.actionId.startsWith(ATTACK_PREFIX) ? MONSTER_ATTACK_PLANS[actor.actionId.slice(ATTACK_PREFIX.length)] : undefined;
  if (attack && actor.attackPhase) return stepSample(attack[actor.attackPhase], actor.attackPhaseProgress ?? 0);
  // A player hit never replaces the base clip: locomotion and super-armoured attack poses continue and the flinch is a native overlay (resolveMonsterHitOverlay).
  if (actor.roarProgress !== undefined) return { actionId: 'monster-roar', phase: 'active', normalizedTime: ROAR_CLIP_WINDOW.from + (ROAR_CLIP_WINDOW.to - ROAR_CLIP_WINDOW.from) * clamp01(actor.roarProgress), loopRate: 1 };
  if (actor.weakPointExposed) return { actionId: 'monster-hurt', phase: 'active', normalizedTime: MONSTER_HURT_HOLD_TIME, loopRate: 1 };
  const speed = Math.hypot(actor.velocity.x, actor.velocity.z);
  if (speed >= MOVING_SPEED) {
    const run = speed >= locomotion.runThreshold * (previousGait === 'monster-run' ? 1 - GAIT_HYSTERESIS_BAND : previousGait === 'monster-walk' ? 1 + GAIT_HYSTERESIS_BAND : 1);
    return { actionId: run ? 'monster-run' : 'monster-walk', phase: 'idle', normalizedTime: 0, loopRate: Math.max(0.5, Math.min(2, speed / (run ? locomotion.runRef : locomotion.walkRef))) };
  }
  const yaw = Math.abs(actor.yawRate ?? 0);
  if (yaw >= TURNING_RATE) return { actionId: 'monster-turn', phase: 'idle', normalizedTime: 0, loopRate: Math.max(0.6, Math.min(2.2, yaw / 2.5)) };
  return { actionId: 'monster-idle', phase: 'idle', normalizedTime: 0, loopRate: 1 };
}

/** Native hurt-clip window the flinch sweeps: from the first strong recoil frame up to where the dazed hold (MONSTER_HURT_HOLD_TIME) begins. */
export const HURT_FLINCH_WINDOW = { from: 0.12, to: 0.44 } as const;
/** Share of the final pose the hurt overlay owns at its peak, by what the monster is doing. An attack pose keeps most of the pose; its active (damaging) window the most. */
export const HURT_OVERLAY_SHARE = { free: 0.85, roar: 0.5, attacking: 0.35, active: 0.22 } as const;
/** Fraction of the hit reaction held at peak before the overlay eases out. */
const HURT_OVERLAY_HOLD = 0.3;

export interface MonsterHitOverlay {
  readonly actionId: 'monster-hurt';
  readonly normalizedTime: number;
  /** 0..1 share of the pose; always > 0 while a reaction is playing, and already at peak on the first frame (the hit-stop frame). */
  readonly share: number;
}

/**
 * Presentation-only flinch on top of whatever the monster is doing. Driven entirely by the engine's `reaction` of kind 'flinch' (progress 0
 * at the confirmed hit, 1 at its end, <= 12 world ticks), so it restarts on every confirmed hit (new serial), shows its peak on the hit-stop
 * frame and freezes with the world clock. Heavier reactions (stagger, knockback, knockdown, stun...) replace the clip instead
 * (ReactionPresenter). Returns undefined when no flinch is playing or the base clip already is the hurt clip.
 */
export function resolveMonsterHitOverlay(actor: ActorSnapshot, assetId: string): MonsterHitOverlay | undefined {
  if (!MONSTER_LOCOMOTION[assetId] || actor.reaction?.kind !== 'flinch' || actor.downed || actor.actionId.endsWith('-stagger')) return undefined;
  if (actor.weakPointExposed && !actor.attackPhase) return undefined;
  const progress = clamp01(actor.reaction.progress);
  const peak = actor.attackPhase === 'active' ? HURT_OVERLAY_SHARE.active : actor.attackPhase ? HURT_OVERLAY_SHARE.attacking : actor.roarProgress !== undefined ? HURT_OVERLAY_SHARE.roar : HURT_OVERLAY_SHARE.free;
  const falloff = smoothstep((progress - HURT_OVERLAY_HOLD) / (1 - HURT_OVERLAY_HOLD));
  return { actionId: 'monster-hurt', normalizedTime: HURT_FLINCH_WINDOW.from + (HURT_FLINCH_WINDOW.to - HURT_FLINCH_WINDOW.from) * progress, share: peak * (1 - falloff) };
}

/** Share of the pose the boss phase roar owns at its peak, and how fast it fades in and out (seconds). */
const BOSS_ROAR_SHARE = 0.9, BOSS_ROAR_ATTACK_SECONDS = 0.15, BOSS_ROAR_RELEASE_SECONDS = 0.35;

/**
 * Native `monster-roar` overlay a boss plays once when its vitality first falls below BOSS_ROAR_VITALITY_RATIO: the clip's stamp + shake
 * (clip time 0..0.8, 1x) blended over whatever the boss is doing, fading in quickly and out gently. `elapsedSeconds` is world time since the
 * phase change; undefined before it started and once the roar is over.
 */
export function resolveBossRoarOverlay(elapsedSeconds: number): { readonly actionId: 'monster-roar'; readonly normalizedTime: number; readonly share: number } | undefined {
  const duration = (BOSS_ROAR_WINDOW.to - BOSS_ROAR_WINDOW.from) * BOSS_ROAR_CLIP_SECONDS;
  if (!(elapsedSeconds >= 0) || elapsedSeconds >= duration) return undefined;
  const share = BOSS_ROAR_SHARE * smoothstep(elapsedSeconds / BOSS_ROAR_ATTACK_SECONDS) * (1 - smoothstep((elapsedSeconds - (duration - BOSS_ROAR_RELEASE_SECONDS)) / BOSS_ROAR_RELEASE_SECONDS));
  return { actionId: 'monster-roar', normalizedTime: BOSS_ROAR_WINDOW.from + (BOSS_ROAR_WINDOW.to - BOSS_ROAR_WINDOW.from) * elapsedSeconds / duration, share };
}

/**
 * Presentation-only flight height for a monster that is drawn above its simulation position. The simulation keeps the actor on
 * its floor (hit tests, hazards, walkability); the renderer lifts the drawn root by `monsterHoverHeight`, so the `cast` socket,
 * the `root` socket (auras, impact origins) and any label anchored to the drawn body follow automatically.
 */
export interface MonsterHoverProfile {
  /** Metres the drawn body floats above the simulation position while idle or moving. */
  readonly height: number;
  /** Slow vertical drift (metres, period in world seconds); phase is derived from the actor id so a flock never bobs in unison. */
  readonly bobAmplitude: number;
  readonly bobPeriodSeconds: number;
  /** Height of a downed (cleansed / neutral) actor: it settles to the ground. */
  readonly groundedHeight: number;
  /** Attack whose commit/active phases swoop to `lowHeight` along the simulated lane and climb back in recovery; the windup rears up by `windupRise` first. */
  readonly dive?: { readonly attackId: string; readonly lowHeight: number; readonly windupRise: number };
}

export const MONSTER_HOVER: Readonly<Record<string, MonsterHoverProfile>> = {
  'actor-storm-hornbill': { height: 2.4, bobAmplitude: 0.14, bobPeriodSeconds: 3.4, groundedHeight: 0.05, dive: { attackId: 'hornbill-dive-bomb', lowHeight: 0.6, windupRise: 0.2 } },
  ...GROVE_HOVER, ...MOONPINE_HOVER, ...MISTVEIL_HOVER, ...BAMBOO_HOVER,
};

const smoothstep = (t: number): number => { const x = clamp01(t); return x * x * (3 - 2 * x); };

/** Stable 0..1 phase from an actor id (FNV-1a), independent of load order or serialization. */
function idPhase(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return (hash >>> 0) / 4294967296;
}

/** Normalized `monster-death` time at which a body falling from its hover (or hop) height touches the ground; it rests there to the end of the clip. */
export const DEATH_GROUND_CONTACT = 0.7;

/** Share of its height a defeated body has fallen after `progress` of the death clip: constant acceleration (ease-in) to ground contact, then 1. */
export function deathFallShare(progress: number): number {
  const x = clamp01(progress / DEATH_GROUND_CONTACT);
  return x * x;
}

/**
 * Flight height above the simulation position, in metres, of a hovering monster that is alive (0 for assets without a hover profile): idle bob,
 * dive swoop. A pure function of the actor snapshot and the authoritative world clock: it carries no state, so a paused world (clock frozen)
 * holds the pose, a restored snapshot reproduces it exactly, and slow motion scales the bob with the world clock.
 */
export function monsterFlightHeight(actor: ActorSnapshot, assetId: string, worldTimeSeconds: number): number {
  const profile = MONSTER_HOVER[assetId];
  if (!profile) return 0;
  const phase = idPhase(actor.id) * Math.PI * 2, omega = (Math.PI * 2) / profile.bobPeriodSeconds;
  const bob = profile.bobAmplitude * (Math.sin(omega * worldTimeSeconds + phase) + 0.35 * Math.sin(omega * 1.64 * worldTimeSeconds + phase * 1.7)) / 1.35;
  const dive = profile.dive;
  const attackId = actor.actionId.startsWith(ATTACK_PREFIX) ? actor.actionId.slice(ATTACK_PREFIX.length) : undefined;
  if (!dive || attackId !== dive.attackId || !actor.attackPhase) return profile.height + bob;
  const progress = clamp01(actor.attackPhaseProgress ?? 0), high = profile.height + dive.windupRise;
  // The bob fades out into the swoop and back in while climbing, so every phase boundary is continuous.
  switch (actor.attackPhase) {
    case 'windup': return profile.height + dive.windupRise * smoothstep(progress) + bob;
    case 'commit': return high + (dive.lowHeight - high) * progress * progress + bob * (1 - smoothstep(progress));
    case 'active': return dive.lowHeight;
    case 'recovery': return dive.lowHeight + (profile.height - dive.lowHeight) * smoothstep(progress) + bob * smoothstep(progress);
  }
}

/**
 * Drawn height above the simulation position that the renderer applies for a monster, in metres (0 for assets without a hover profile): its flight
 * height, the grounded height of a downed (cleansed) one, and 0 for a defeated one: the fall of a defeated flyer is part of the death presentation
 * (ActorAnimationDriver eases the height it had when it was struck to the ground over the death clip), so this renderer-side offset is already 0.
 */
export function monsterHoverHeight(actor: ActorSnapshot, assetId: string, worldTimeSeconds: number): number {
  const profile = MONSTER_HOVER[assetId];
  if (!profile || isMonsterDefeated(actor)) return 0;
  const grounded = actor.reaction?.kind;
  if (actor.downed || grounded === 'knockdown' || grounded === 'getup' || grounded === 'stun') return profile.groundedHeight;
  return monsterFlightHeight(actor, assetId, worldTimeSeconds);
}

/** Exponential rate (1/s) at which a non-attacking drawn height follows its target after a discontinuity (downed, get-up, teleport). */
const HOVER_SETTLE_RATE = 5;

/**
 * Optional renderer-side easing for the rare height discontinuities (downed settle, get-up, snap after a load). Attacks follow
 * the authored curve exactly; `dtWorldSeconds` is world time, so a paused world does not move it.
 */
export function settleMonsterHover(previous: number | undefined, target: number, actor: ActorSnapshot, dtWorldSeconds: number): number {
  if (previous === undefined || actor.attackPhase || isMonsterDefeated(actor)) return target;
  return previous + (target - previous) * (1 - Math.exp(-HOVER_SETTLE_RATE * Math.max(0, dtWorldSeconds)));
}
