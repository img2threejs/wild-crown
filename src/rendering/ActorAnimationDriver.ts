import type { ActionId, ActorSnapshot, AssetManifestEntry } from '../game/contracts';
import { BAMBOO_STORY_ASSETS } from './BambooMonsterProfiles';
import { createMutableSample, createStoryAnimationState, resolveStoryAnimation, trackStoryAnimation, type MutableAnimationSample, type StoryAnimationInput, type StoryAnimationState } from './StoryActorAnimation';
import type { ReactionPose } from './ReactionPresenter';
import {
  BOSS_ROAR_VITALITY_RATIO, MONSTER_DEATH_SECONDS, MONSTER_HOVER, MONSTER_SPAWN_SECONDS, deathFallShare, isMonsterDefeated, monsterHoverHeight, resolveBossRoarOverlay, resolveMonsterAnimation, resolveMonsterHitOverlay,
  type MonsterAnimationSample, type MonsterClipAction,
} from './MonsterAnimationProfiles';
import type { NativeAssetInstance } from './NativeAssetLoader';
import { vesperClipProgress } from './VesperAnimation';
import { arenClipProgress } from './ArenAnimation';
import { companionSkillByAction } from '../game/companions/CompanionSkills';

const LOCOMOTION_RECOVERY_ACTIONS: Readonly<Record<string, true>> = {
  'aren-jump': true, 'aren-forward-left-dive-roll': true, 'aren-forward-right-dive-roll': true,
  'aren-perfect-dodge-left': true, 'aren-perfect-dodge-right': true,
  // Dash and blink skills end upright and moving: their tails flow into run or idle with no pose gap.
  'vesper-iai-4': true, 'vesper-shadow-step': true, 'vesper-shade-swap': true, 'vesper-severing-shadow': true, 'vesper-mist-blink': true,
  'sakda-resonating-strike': true, 'sakda-flying-knee': true, 'sakda-hundred-elbows': true, 'sakda-iron-clinch': true, 'sakda-guard-dash': true,
};
/** Held poses the simulation reports as an action but the clip plays as a seamless loop on the actor clock (the controller loops the 'idle' phase). */
const LOOPING_ACTIONS: Readonly<Record<string, true>> = {
  'aren-sigil-charge': true, 'aren-charged-heavy-charge': true, 'yara-seed-charge': true, 'yara-root-charge': true,
  'vesper-cuts-charge': true, 'vesper-shade-charge': true, 'sakda-knee-charge': true, 'sakda-elbow-charge': true,
  'vara:idle': true, 'vara:walk': true, 'vara:fly': true, 'vara:hover': true,
};
/** Default ground speed (m/s) above which a recovering actor blends into the run loop instead of walk (Aren's walk speed); heroes override per context. */
const RUN_SPEED = 4.1;
/** Normalized finite-action progress where the locomotion loop starts to take over (smoothstep to 1 at the end). */
const RECOVERY_START = 0.7;
/** Ground speed range (m/s) over which a moving actor weighs the locomotion loop in; a standing actor settles into idle instead. */
const RECOVERY_SPEED_MIN = 0.5, RECOVERY_SPEED_FULL = 2.5;

/** Presentation-only hit reaction on Aren: lasts at most this long and never gates locomotion or actions. */
export const HIT_OVERLAY_SECONDS = 0.35;
const HIT_OVERLAY_ACTION = 'aren-hit';
const HIT_OVERLAY_PEAK_SHARE = 0.6;
const HIT_OVERLAY_ATTACK_SECONDS = 0.05;

/** Ground speed (m/s) above which a monster abandons its entrance clip (it is walking off, not rising). */
const SPAWN_CANCEL_SPEED = 1;

interface DriverState {
  lastVitality: number | undefined;
  hitStartedAt: number | undefined;
  overlayActive: boolean;
  /** Locomotion loop chosen when the current finite action's recovery began (no walk/run flicker mid-blend). */
  recoveryActionId: ActionId | undefined;
  /** Monster walk / run played on the previous frame: the memory of the gait hysteresis band. */
  gait: 'monster-walk' | 'monster-run' | undefined;
  /** True after the first monster frame (a monster first seen already defeated or already fighting never replays its entrance). */
  monsterSeen: boolean;
  /** World-clock second the entrance clip started (undefined until it starts) and whether it can never play again. */
  spawnStartedAt: number | undefined;
  spawnDone: boolean;
  /** True while the monster is defeated; `deathStartedAt` is the world-clock second its vitality reached 0 (undefined = defeated when first seen: held). */
  defeated: boolean;
  deathStartedAt: number | undefined;
  /** Vitality ratio of the previous frame, whether the boss phase roar was spent, and the world-clock second it started. */
  lastVitalityRatio: number | undefined;
  bossRoarDone: boolean;
  bossRoarStartedAt: number | undefined;
  /** Vertical presentation offset (m: hover height + hop) drawn on the last frame the monster was alive, and the part of it a defeated monster is still falling from. */
  airborne: number;
  deathLift: number | undefined;
  /** Reused sample of a monster's reaction clip (stagger, knockback, knockdown, get-up, stun): the frame allocates nothing. */
  readonly reactionSample: { -readonly [K in keyof MonsterAnimationSample]: MonsterAnimationSample[K] };
  readonly monsterSample: { -readonly [K in keyof MonsterAnimationSample]: MonsterAnimationSample[K] };
  /** Story-clip memory (status and line start times) and the reused sample the story resolver writes into. */
  readonly story: StoryAnimationState;
  readonly storySample: MutableAnimationSample;
}
const states = new WeakMap<NativeAssetInstance, DriverState>();

function createDriverState(): DriverState {
  return {
    lastVitality: undefined, hitStartedAt: undefined, overlayActive: false, recoveryActionId: undefined, gait: undefined,
    monsterSeen: false, spawnStartedAt: undefined, spawnDone: false, defeated: false, deathStartedAt: undefined,
    lastVitalityRatio: undefined, bossRoarDone: false, bossRoarStartedAt: undefined, airborne: 0, deathLift: undefined,
    reactionSample: { actionId: 'monster-hurt', phase: 'active', normalizedTime: 0, loopRate: 1 },
    monsterSample: { actionId: 'monster-idle', phase: 'idle', normalizedTime: 0, loopRate: 1 },
    story: createStoryAnimationState(), storySample: createMutableSample(),
  };
}

export interface ActorAnimationContext {
  /** True when the rendered pose interpolates between two snapshots of the same visible actor. */
  readonly interpolate: boolean;
  readonly alpha: number;
  /** Authoritative actor clock in seconds used for looping cadence. */
  readonly loopTimeSeconds: number | undefined;
  readonly manifest: AssetManifestEntry | undefined;
  /**
   * Authoritative vitality of the driven actor. Aren's damage lives in `CombatSnapshot.player.vitality`
   * (her ActorSnapshot does not change), so the renderer supplies it here; other actors fall back to `ActorSnapshot.vitality`.
   */
  readonly vitality?: number;
  /** Walk speed (m/s) of the driven hero; faster ground speed blends the tail of a dash into run, otherwise walk. */
  readonly walkSpeed?: number;
  /** Run speed (m/s) of the driven hero: the reference its in-place run clip is scaled against (default: 1.5x the walk speed). */
  readonly runSpeed?: number;
  /**
   * Combat-trial role of a driven monster, from the encounter status (`encounterStatus.monsters[]`: `active`, `boss`): its entrance plays
   * the first time it is active, and a boss roars once when its vitality first falls below half. Absent outside combat trials.
   */
  readonly trialMonster?: { readonly active: boolean; readonly boss: boolean };
  /**
   * The smoothed combat-reaction pose of this actor (ReactionPresenter). While it names a base clip (stagger, knockback, knockdown, get-up,
   * stun...) that clip replaces the actor's own; its overlay (a hero's flinch) is blended on top. Absent or resting: the actor plays as usual.
   */
  readonly reaction?: ReactionPose;
  /** Renderer facts of a story actor (boss phase, calm, line gesture, swap entrance); ignored for every other actor. */
  readonly story?: StoryAnimationInput;
}

const smoothstep = (t: number): number => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };

/** Crossfade for monster attack hand-offs and same-slot clip restarts (brief: 0.1–0.15 s). */
export const MONSTER_BLEND_SECONDS = 0.12;
const AIR_STEP_ACTION = 'aren-air-step';
/** Normalized `aren-air-step` time at the start of each jump phase: rising 0→0.50, falling 0.50→0.82, landing 0.82→1. */
const AIR_STEP_PHASE_START = { rising: 0, falling: 0.5, landing: 0.82 } as const;
const AIR_STEP_PHASE_SPAN = { rising: 0.5, falling: 0.32, landing: 0.18 } as const;

/** Samples the native pose. Returns only the root offset for a defeated flyer's fall; living attack arcs are already authored in the skeleton. */
export function driveActorAnimation(instance: NativeAssetInstance, actor: ActorSnapshot, previous: ActorSnapshot | undefined, context: ActorAnimationContext): number {
  const { interpolate, alpha, loopTimeSeconds, manifest } = context;
  let state = states.get(instance);
  if (!state) states.set(instance, state = createDriverState());
  const skill = companionSkillByAction(actor.actionId);
  const companionAction = actor.allegiance === 'ally' && !actor.downed && !actor.possessed
    && (skill?.companionId === actor.archetypeId || actor.archetypeId === 'vara' && actor.actionId.startsWith('vara:'));
  // Ally skills must win over generic monster idle/gait and story idles. Native reactions still win over a skill.
  if (companionAction && context.reaction?.baseAction === undefined) {
    const overlay = context.reaction;
    if (overlay?.overlayAction && instance.animation.hasAction(overlay.overlayAction)) {
      instance.animation.setOverlay(overlay.overlayAction, overlay.overlayTime, overlay.overlayShare);
      state.overlayActive = true;
    } else if (state.overlayActive) { instance.animation.setOverlay(undefined); state.overlayActive = false; }
    const progress = interpolate && previous?.actionId === actor.actionId && previous.normalizedTime <= actor.normalizedTime
      ? previous.normalizedTime + (actor.normalizedTime - previous.normalizedTime) * alpha : actor.normalizedTime;
    const nativeAction = skill?.nativeAction ?? actor.actionId;
    instance.animation.setBlendSeconds(MONSTER_BLEND_SECONDS);
    instance.animation.play(nativeAction, LOOPING_ACTIONS[actor.actionId] ? 'idle' : 'active', progress, loopTimeSeconds, 1);
    state.gait = undefined;
    return 0;
  }
  if (actor.allegiance !== 'player') {
    const generic = resolveMonsterAnimation(actor, instance.assetId, state.gait, state.monsterSample);
    if (generic) {
      // Story cast (Asha, Tali, Marek, Koro): a nonlethal chapter status, a stance or a line gesture replaces the generic locomotion / idle clip.
      let resolved: MonsterAnimationSample = generic;
      if (context.story && BAMBOO_STORY_ASSETS[instance.assetId]) {
        trackStoryAnimation(actor, context.story, state.story, loopTimeSeconds);
        resolved = resolveStoryAnimation(actor, instance.assetId, context.story, state.story, loopTimeSeconds, state.storySample) ?? generic;
      }
      // Lifecycle clips (entrance, defeat) replace the resolved clip while they play; the walk / run memory restarts after them.
      const lifecycle = driveMonsterLifecycle(instance, actor, state, context);
      // A combat reaction that names a native clip (stagger, knockback, knockdown, get-up, stun) replaces the resolved clip but never a lifecycle clip.
      const pose = context.reaction;
      let sample = lifecycle ?? resolved;
      if (!lifecycle && pose?.baseAction !== undefined && instance.animation.hasAction(pose.baseAction)) {
        const reacting = state.reactionSample;
        reacting.actionId = pose.baseAction as MonsterClipAction; reacting.normalizedTime = pose.baseTime;
        sample = reacting;
      }
      state.gait = sample === resolved && (sample.actionId === 'monster-walk' || sample.actionId === 'monster-run') ? sample.actionId : undefined;
      // The flinch is a native hurt-clip overlay on whatever the monster is doing (walk, idle or an attack pose that keeps playing); a boss's
      // one-time phase roar is the same kind of overlay and wins while it plays. Both are set before play(), which re-evaluates the mixer, so
      // the pose lands on the same frame; a hit-stop frame holds it untouched.
      const phaseRoar = state.bossRoarStartedAt !== undefined && loopTimeSeconds !== undefined && !lifecycle && !actor.downed
        ? resolveBossRoarOverlay(loopTimeSeconds - state.bossRoarStartedAt) : undefined;
      const hurt = phaseRoar || sample !== resolved && sample !== lifecycle ? undefined : resolveMonsterHitOverlay(actor, instance.assetId);
      const overlay = phaseRoar ?? hurt;
      if (overlay) { instance.animation.setOverlay(overlay.actionId, overlay.normalizedTime, overlay.share); state.overlayActive = true; }
      else if (state.overlayActive) { instance.animation.setOverlay(undefined); state.overlayActive = false; }
      instance.animation.setBlendSeconds(MONSTER_BLEND_SECONDS);
      instance.animation.play(sample.actionId, sample.phase, sample.normalizedTime, loopTimeSeconds, sample.loopRate);
      return monsterPresentationLift(instance.assetId, actor, state, sample, loopTimeSeconds);
    }
  }
  const reaction = context.reaction;
  if (actor.id === 'aren') {
    if (actor.reaction === undefined) driveHitOverlay(instance, actor, state, loopTimeSeconds, context.vitality ?? actor.vitality);
    else { state.lastVitality = context.vitality ?? actor.vitality; state.hitStartedAt = undefined; }
  }
  if (reaction?.overlayAction !== undefined && instance.animation.hasAction(reaction.overlayAction)) {
    instance.animation.setOverlay(reaction.overlayAction, reaction.overlayTime, reaction.overlayShare);
    state.overlayActive = true;
  } else if (actor.reaction !== undefined && state.overlayActive) { instance.animation.setOverlay(undefined); state.overlayActive = false; }
  if (reaction?.baseAction !== undefined && instance.animation.hasAction(reaction.baseAction)) {
    instance.animation.play(reaction.baseAction, 'active', reaction.baseTime, loopTimeSeconds, 1);
    state.recoveryActionId = undefined;
    return 0;
  }
  let normalizedTime = interpolate && previous && previous.actionId === actor.actionId && previous.normalizedTime <= actor.normalizedTime
    ? previous.normalizedTime + (actor.normalizedTime - previous.normalizedTime) * alpha : actor.normalizedTime;
  // Second (boosted) jump: the dedicated in-place air-step clip, by jump phase; otherwise the standard jump mapping.
  const airStep = actor.actionId === 'aren-jump' && actor.jumpBoosted === true && instance.animation.hasAction(AIR_STEP_ACTION);
  let clipActionId: ActionId | string = actor.actionId;
  if (actor.actionId === 'aren-jump' && actor.jumpPhase) {
    let progress = actor.jumpPhaseProgress ?? 0;
    if (interpolate && previous?.jumpPhase === actor.jumpPhase && previous.jumpBoosted === actor.jumpBoosted && (previous.jumpPhaseProgress ?? 0) <= progress) progress = (previous.jumpPhaseProgress ?? 0) + (progress - (previous.jumpPhaseProgress ?? 0)) * alpha;
    if (airStep) {
      clipActionId = AIR_STEP_ACTION;
      normalizedTime = actor.jumpPhase === 'takeoff' ? 0
        : AIR_STEP_PHASE_START[actor.jumpPhase] + AIR_STEP_PHASE_SPAN[actor.jumpPhase] * Math.max(0, Math.min(1, progress));
    } else {
      // Keep native knees/arms airborne until simulation landing, including a second upward kick.
      normalizedTime = actor.jumpPhase === 'takeoff' ? progress * .24
        : actor.jumpPhase === 'rising' ? .24 + progress * .2
        : actor.jumpPhase === 'falling' ? .44 + progress * .24
        : .68 + progress * .32;
    }
  } else if (airStep) clipActionId = AIR_STEP_ACTION;
  const speed = Math.hypot(actor.velocity.x, actor.velocity.z);
  // Native airborne poses follow jump phases; the upright recovery tail blends into
  // the locomotion loop so run→jump/Dive→run has no pose gap.
  let recoveryWeight = 0;
  if (actor.phase === 'recovery' && LOCOMOTION_RECOVERY_ACTIONS[String(actor.actionId)]) {
    recoveryWeight = smoothstep((normalizedTime - RECOVERY_START) / (1 - RECOVERY_START)) * smoothstep((speed - RECOVERY_SPEED_MIN) / (RECOVERY_SPEED_FULL - RECOVERY_SPEED_MIN));
    if (recoveryWeight > 0 && state.recoveryActionId === undefined) state.recoveryActionId = (speed > (context.walkSpeed === undefined ? RUN_SPEED : context.walkSpeed + 0.05) ? 'aren-run' : 'aren-walk') as ActionId;
  } else state.recoveryActionId = undefined;
  const recoveryActionId = recoveryWeight > 0 ? state.recoveryActionId : undefined;
  const loopPlaybackRate = nativeLocomotionPlaybackRate(instance, manifest, recoveryActionId ?? actor.actionId, actor.velocity, context);
  const clipTime = instance.assetId === 'actor-vesper-hero' ? vesperClipProgress(clipActionId, normalizedTime)
    : instance.assetId === 'actor-aren' ? arenClipProgress(clipActionId, normalizedTime) : normalizedTime;
  instance.animation.play(clipActionId, LOOPING_ACTIONS[String(actor.actionId)] ? 'idle' : actor.phase, clipTime, loopTimeSeconds, loopPlaybackRate, recoveryActionId, recoveryWeight);
  return 0;
}

/** Held last frame of `monster-death` (a collapsed monster keeps this pose; shared, never mutated). */
const DEATH_HELD: MonsterAnimationSample = { actionId: 'monster-death', phase: 'active', normalizedTime: 1, loopRate: 1 };

/**
 * Presentation-only monster lifecycle, driven by renderer-side world-clock timestamps kept in the instance's driver state (the simulation
 * is never touched): the one-shot `monster-death` from the frame the vitality reaches 0 (the last frame is held, the clip never loops and a
 * monster restored already defeated starts on it), the one-shot `monster-spawn` the first time the monster becomes the active trial monster
 * (or, outside trials, the first time a hostile appears), and the start of a boss's one-time phase roar when its vitality ratio first falls
 * below BOSS_ROAR_VITALITY_RATIO. Returns the sample that replaces the resolved clip while death / spawn play, otherwise undefined.
 */
function driveMonsterLifecycle(instance: NativeAssetInstance, actor: ActorSnapshot, state: DriverState, context: ActorAnimationContext): MonsterAnimationSample | undefined {
  const clock = context.loopTimeSeconds, animation = instance.animation, first = !state.monsterSeen;
  state.monsterSeen = true;
  const defeated = isMonsterDefeated(actor);
  const ratio = actor.vitality !== undefined && actor.maxVitality ? actor.vitality / actor.maxVitality : undefined;

  if (context.trialMonster?.boss && ratio !== undefined && !state.bossRoarDone && ratio < BOSS_ROAR_VITALITY_RATIO) {
    state.bossRoarDone = true;
    // Only a drop seen across frames roars (a boss loaded below the threshold, or killed outright, does not).
    if (!first && !defeated && clock !== undefined && state.lastVitalityRatio !== undefined && state.lastVitalityRatio >= BOSS_ROAR_VITALITY_RATIO) state.bossRoarStartedAt = clock;
  }
  state.lastVitalityRatio = ratio;

  if (defeated && animation.hasAction('monster-death')) {
    if (!state.defeated) { state.defeated = true; state.deathStartedAt = first || clock === undefined ? undefined : clock; }
    const elapsed = state.deathStartedAt === undefined || clock === undefined ? Infinity : clock - state.deathStartedAt;
    return elapsed >= MONSTER_DEATH_SECONDS ? DEATH_HELD : { actionId: 'monster-death', phase: 'active', normalizedTime: Math.max(0, elapsed) / MONSTER_DEATH_SECONDS, loopRate: 1 };
  }
  if (!defeated) state.defeated = false;

  if (state.spawnDone || !animation.hasAction('monster-spawn')) return undefined;
  const speed = Math.hypot(actor.velocity.x, actor.velocity.z);
  const busy = actor.downed || defeated || actor.attackPhase !== undefined || actor.roarProgress !== undefined || actor.actionId.endsWith('-stagger');
  let startedAt = state.spawnStartedAt;
  if (startedAt === undefined) {
    const arrives = context.trialMonster ? context.trialMonster.active : actor.allegiance === 'hostile';
    if (!arrives) return undefined;
    if (busy || clock === undefined) { state.spawnDone = true; return undefined; }
    startedAt = state.spawnStartedAt = clock;
  }
  const elapsed = clock === undefined ? Infinity : clock - startedAt;
  // The entrance ends with the clip, or when the monster is already fighting or walking off (it never stands in its entrance pose while moving).
  if (elapsed >= MONSTER_SPAWN_SECONDS || busy || speed > SPAWN_CANCEL_SPEED) { state.spawnDone = true; return undefined; }
  return { actionId: 'monster-spawn', phase: 'active', normalizedTime: Math.max(0, elapsed) / MONSTER_SPAWN_SECONDS, loopRate: 1 };
}

/**
 * Vertical presentation offset (m) of a defeated flyer: retain its last living hover height (`airborne`), then fall with
 * constant acceleration to the ground over the native death clip. A monster restored already defeated has no height to fall from.
 */
function monsterPresentationLift(assetId: string, actor: ActorSnapshot, state: DriverState, sample: MonsterAnimationSample, clock: number | undefined): number {
  if (sample.actionId === 'monster-death') {
    state.deathLift ??= state.airborne;
    return state.deathLift * (1 - deathFallShare(sample.normalizedTime));
  }
  state.deathLift = undefined;
  state.airborne = MONSTER_HOVER[assetId] && clock !== undefined ? monsterHoverHeight(actor, assetId, clock) : 0;
  return 0;
}

/**
 * Starts a short upper-body flinch whenever Aren's vitality drops between two sampled snapshots. The overlay is a share of
 * the 'aren-hit' clip blended over whatever is playing; it is purely cosmetic and decays to nothing within HIT_OVERLAY_SECONDS.
 */
function driveHitOverlay(instance: NativeAssetInstance, actor: ActorSnapshot, state: DriverState, clock: number | undefined, vitality: number | undefined): void {
  const lastVitality = state.lastVitality;
  state.lastVitality = vitality;
  if (clock === undefined || !instance.animation.hasAction(HIT_OVERLAY_ACTION)) return;
  if (lastVitality !== undefined && vitality !== undefined && vitality < lastVitality - 1e-3 && !actor.downed) state.hitStartedAt = clock;
  const elapsed = state.hitStartedAt === undefined ? -1 : clock - state.hitStartedAt;
  if (elapsed >= 0 && elapsed < HIT_OVERLAY_SECONDS) {
    const progress = elapsed / HIT_OVERLAY_SECONDS;
    const decay = 1 - smoothstep((elapsed - HIT_OVERLAY_ATTACK_SECONDS) / (HIT_OVERLAY_SECONDS - HIT_OVERLAY_ATTACK_SECONDS));
    instance.animation.setOverlay(HIT_OVERLAY_ACTION, progress, HIT_OVERLAY_PEAK_SHARE * smoothstep(elapsed / HIT_OVERLAY_ATTACK_SECONDS) * decay);
    state.overlayActive = true;
  } else {
    state.hitStartedAt = undefined;
    if (state.overlayActive) { instance.animation.setOverlay(undefined); state.overlayActive = false; }
  }
}

/** Playback-rate clamp of a locomotion loop scaled by ground speed (the same range the monster loops use). */
const LOCOMOTION_RATE_MIN = 0.5, LOCOMOTION_RATE_MAX = 2;
/** Hero run speed over walk speed (HERO_COMBAT: yara 6 / 4.1, vesper 7.5 / 4.9, sakda 6.6 / 4.4), used when the renderer supplies no run speed. */
const HERO_RUN_TO_WALK = 1.5;

/**
 * Loop rate of a walk / run / strafe clip so the feet keep pace with the ground. A verified native root-motion curve gives the exact authored
 * ground speed; heroes whose clips are in place (Sakda, Vesper: `authoredPlanarSpeed` ~ 0) scale against the hero's declared reference speed
 * instead (walk and strafe at `walkSpeed`, run at `runSpeed`), clamped like the monster loops.
 */
export function nativeLocomotionPlaybackRate(
  instance: NativeAssetInstance,
  manifest: AssetManifestEntry | undefined,
  actionId: ActionId,
  velocity: ActorSnapshot['velocity'],
  context: ActorAnimationContext,
): number {
  if (!/walk|run|strafe/.test(String(actionId))) return 1;
  const actorSpeed = Math.hypot(velocity.x, velocity.z);
  const motion = manifest?.rootMotion?.[String(actionId)];
  const samples = motion?.curveSamples;
  if (motion?.mode === 'native-root-motion' && motion.evidenceStatus === 'verified' && samples && samples.length >= 2) {
    const authoredSpeed = instance.animation.authoredPlanarSpeed(actionId);
    if (Number.isFinite(authoredSpeed) && authoredSpeed > 0.05 && Number.isFinite(actorSpeed)) return actorSpeed / authoredSpeed;
  }
  const walkSpeed = context.walkSpeed;
  if (walkSpeed === undefined || !(walkSpeed > 0) || !Number.isFinite(actorSpeed)) return 1;
  const reference = /run/.test(String(actionId)) ? context.runSpeed ?? walkSpeed * HERO_RUN_TO_WALK : walkSpeed;
  return Math.max(LOCOMOTION_RATE_MIN, Math.min(LOCOMOTION_RATE_MAX, actorSpeed / reference));
}
