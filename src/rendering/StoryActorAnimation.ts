import type { ActorSnapshot } from '../game/contracts';
import { ASHA_STALK_REF_SPEED, BAMBOO_CLIP_SECONDS, BAMBOO_LOCOMOTION, type BambooClipAction } from './BambooMonsterProfiles';
import { MONSTER_HURT_HOLD_TIME, MONSTER_SPAWN_SECONDS, type MonsterAnimationSample } from './MonsterAnimationProfiles';
import type { PlanClipAction } from './MonsterAnimationPlan';

/**
 * Story presentation of the Blood Bamboo cast: Asha's stalk / corrupted / bonded stances and cleanse, Tali's play bow, tremble and reunion
 * nuzzle, Marek's talking idles and Koro's rise after the cleanse. A pure function of the actor snapshot, the world clock and a few renderer
 * facts (`StoryAnimationInput`): no simulation state is read or written, a paused world holds the pose, and a restored snapshot reproduces
 * it. One-shot clips (cleanse, nuzzle, point) start at the world-clock second their status or line began; a status already in force when
 * the actor is first seen (a load) holds the settled stance instead of replaying the ceremony.
 */

export type NpcTalk = 'relaxed' | 'explain' | 'point' | 'guarded';
export const NPC_TALK_ACTIONS: Readonly<Record<NpcTalk, BambooClipAction>> = {
  relaxed: 'npc-talk-relaxed', explain: 'npc-talk-explain', point: 'npc-talk-point', guarded: 'npc-talk-guarded',
};

/** Renderer facts one story actor needs besides its snapshot; rewritten in place each frame (never allocated per frame). */
export interface StoryAnimationInput {
  /** `CombatSnapshot.boss.phaseIndex` while this actor is the encounter's boss; -1 otherwise. */
  bossPhaseIndex: number;
  /** True while no living, awake hostile is visible: the cub plays instead of idling. */
  calm: boolean;
  /** Line gesture of an NPC while it speaks (null otherwise) and a counter that changes whenever a new line starts. */
  talk: NpcTalk | null;
  talkSerial: number;
  /** World-clock second the displayed instance replaced another variant of the same actor (Koro's cleanse swap); undefined otherwise. */
  entranceStartedAt: number | undefined;
}
export const createStoryAnimationInput = (): StoryAnimationInput => ({ bossPhaseIndex: -1, calm: false, talk: null, talkSerial: 0, entranceStartedAt: undefined });

/** Per-instance memory of when a status or line began (undefined start = already in force when first seen). */
export interface StoryAnimationState {
  seen: boolean;
  /** 'resolved' (cleansed or reunion), 'in-danger' or none. */
  statusKey: string | undefined;
  statusStartedAt: number | undefined;
  talkSerial: number;
  talkStartedAt: number | undefined;
}
export const createStoryAnimationState = (): StoryAnimationState => ({ seen: false, statusKey: undefined, statusStartedAt: undefined, talkSerial: 0, talkStartedAt: undefined });

export type MutableAnimationSample = { -readonly [K in keyof MonsterAnimationSample]: MonsterAnimationSample[K] };
export const createMutableSample = (): MutableAnimationSample => ({ actionId: 'monster-idle', phase: 'idle', normalizedTime: 0, loopRate: 1 });

/** Seconds of the cleanse clip, nuzzle and point gesture: the authored clip lengths. */
export const ASHA_CLEANSE_SECONDS = BAMBOO_CLIP_SECONDS['asha-cleanse'];
export const TALI_NUZZLE_SECONDS = BAMBOO_CLIP_SECONDS['tali-nuzzle'];
export const NPC_POINT_SECONDS = BAMBOO_CLIP_SECONDS['npc-talk-point'];
export const HUNTER_SUBDUE_SECONDS = BAMBOO_CLIP_SECONDS['hunter-subdue'];
/** Tali's endangered tremble: the hurt clip's dazed hold shuddering by this much (normalized clip time) at this rate (Hz). */
export const TALI_TREMBLE = { amplitude: 0.045, hertz: 5 } as const;

const MOVING_SPEED = 0.15;
const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const loopRate = (speed: number, reference: number): number => Math.max(0.5, Math.min(2, speed / reference));

function loopSample(out: MutableAnimationSample, actionId: PlanClipAction, rate = 1): MutableAnimationSample {
  out.actionId = actionId; out.phase = 'idle'; out.normalizedTime = 0; out.loopRate = rate;
  return out;
}
function finiteSample(out: MutableAnimationSample, actionId: PlanClipAction, time: number): MutableAnimationSample {
  out.actionId = actionId; out.phase = 'active'; out.normalizedTime = clamp01(time); out.loopRate = 1;
  return out;
}

/** Statuses are grouped by what they play: the cleanse / reunion ceremony shares one start time. */
const statusKeyOf = (status: ActorSnapshot['chapterStatus']): string | undefined =>
  status === 'cleansed' || status === 'reunion' ? 'resolved' : status === 'in-danger' ? 'in-danger' : status === 'subdued' ? 'subdued' : undefined;

/** Updates the per-instance status and line timestamps from this frame's snapshot; call once per driven frame, before `resolveStoryAnimation`. */
export function trackStoryAnimation(actor: ActorSnapshot, input: StoryAnimationInput, state: StoryAnimationState, clock: number | undefined): void {
  const key = statusKeyOf(actor.chapterStatus);
  if (key !== state.statusKey) {
    state.statusKey = key;
    // Only a change seen across frames starts a ceremony; a status in force at the first sighting (load, checkpoint restore) is held.
    state.statusStartedAt = key !== undefined && state.seen && clock !== undefined ? clock : undefined;
  }
  if (input.talkSerial !== state.talkSerial) {
    state.talkSerial = input.talkSerial;
    state.talkStartedAt = input.talk !== null && state.seen && clock !== undefined ? clock : undefined;
  }
  state.seen = true;
}

const elapsedSince = (startedAt: number | undefined, clock: number | undefined): number => startedAt === undefined || clock === undefined ? Infinity : Math.max(0, clock - startedAt);

/**
 * The story clip for this actor right now, written into `out`; undefined when the generic monster resolver should decide (attacks, reactions,
 * ordinary locomotion). `assetId` selects the cast member, so every other actor is untouched.
 */
export function resolveStoryAnimation(actor: ActorSnapshot, assetId: string, input: StoryAnimationInput, state: StoryAnimationState, clock: number | undefined, out: MutableAnimationSample): MonsterAnimationSample | undefined {
  const speed = Math.hypot(actor.velocity.x, actor.velocity.z);
  const still = speed < MOVING_SPEED;
  // An attack, a roar, a stagger or a weak-point hold belongs to the generic resolver (its plans); the story layer never overrides combat poses.
  const combatPose = actor.attackPhase !== undefined || actor.roarProgress !== undefined || actor.actionId.endsWith('-stagger') || actor.weakPointExposed === true;
  switch (assetId) {
    case 'actor-asha': {
      if (statusKeyOf(actor.chapterStatus) === 'resolved') {
        // Nonlethal: the corruption peels away over the authored cleanse clip, then the bonded stance holds.
        const elapsed = elapsedSince(state.statusStartedAt, clock);
        return elapsed < ASHA_CLEANSE_SECONDS ? finiteSample(out, 'asha-cleanse', elapsed / ASHA_CLEANSE_SECONDS) : loopSample(out, 'asha-bond-idle');
      }
      if (combatPose || actor.downed) return undefined;
      if (actor.allegiance === 'ally') return still ? loopSample(out, 'asha-bond-idle') : undefined;
      if (actor.allegiance !== 'hostile') return undefined;
      // Phase 1 (Stalking) prowls low; from the Corruption Rage on she stands in the corrupted idle. Moving faster than a prowl is the generic gait.
      if (input.bossPhaseIndex === 0 && !still && speed < BAMBOO_LOCOMOTION['actor-asha']!.walkRef * 1.25) return loopSample(out, 'asha-stalk', loopRate(speed, ASHA_STALK_REF_SPEED));
      if (input.bossPhaseIndex >= 1 && still) return loopSample(out, 'asha-corrupted-idle');
      return undefined;
    }
    case 'actor-tali': {
      const key = statusKeyOf(actor.chapterStatus);
      if (key === 'resolved') {
        const elapsed = elapsedSince(state.statusStartedAt, clock);
        if (elapsed < TALI_NUZZLE_SECONDS) return finiteSample(out, 'tali-nuzzle', elapsed / TALI_NUZZLE_SECONDS);
        return input.calm && still ? loopSample(out, 'tali-play') : undefined;
      }
      if (key === 'in-danger' && still && clock !== undefined) {
        // Crouched and shuddering: the hurt clip's dazed hold, oscillating about its pose on the world clock.
        return finiteSample(out, 'monster-hurt', MONSTER_HURT_HOLD_TIME + TALI_TREMBLE.amplitude * Math.sin(2 * Math.PI * TALI_TREMBLE.hertz * clock));
      }
      if (combatPose || actor.downed || actor.allegiance === 'hostile') return undefined;
      return input.calm && still ? loopSample(out, 'tali-play') : undefined;
    }
    case 'actor-marek': {
      if (combatPose || actor.downed || !still) return undefined;
      if (actor.actionId === 'npc-talk-point' && actor.phase === 'active') return finiteSample(out, 'npc-talk-point', actor.normalizedTime);
      if (input.talk === null) return undefined;
      if (input.talk === 'point') {
        // The pointing gesture is a one-shot; once it lands the relaxed idle takes over until the next line.
        const elapsed = elapsedSince(state.talkStartedAt, clock);
        return elapsed < NPC_POINT_SECONDS ? finiteSample(out, 'npc-talk-point', elapsed / NPC_POINT_SECONDS) : loopSample(out, 'npc-talk-relaxed');
      }
      return loopSample(out, NPC_TALK_ACTIONS[input.talk]);
    }
    case 'actor-camp-hunter-melee': case 'actor-camp-hunter-ranged': {
      // Nonlethal subdue: the hunter goes down on a knee over the authored clip (1.6 s) and stays bowed; a restored subdued hunter holds the kneel.
      if (actor.chapterStatus !== 'subdued' && actor.chapterStatus !== 'kneeling') return undefined;
      const elapsed = actor.chapterStatus === 'subdued' ? elapsedSince(state.statusStartedAt, clock) : Infinity;
      return elapsed < HUNTER_SUBDUE_SECONDS ? finiteSample(out, 'hunter-subdue', elapsed / HUNTER_SUBDUE_SECONDS) : loopSample(out, 'hunter-kneel-idle');
    }
    case 'actor-koro': {
      // The ally's rise: after the cleanse swap the freed Koro plays the spawn clip (risen, alert, shake the thorn off) once, then stands calm.
      const entrance = elapsedSince(input.entranceStartedAt, clock);
      if (input.entranceStartedAt !== undefined && entrance < MONSTER_SPAWN_SECONDS) return finiteSample(out, 'monster-spawn', entrance / MONSTER_SPAWN_SECONDS);
      return actor.chapterStatus !== undefined && statusKeyOf(actor.chapterStatus) === 'resolved' && !combatPose && still ? loopSample(out, 'monster-idle') : undefined;
    }
    case 'actor-koro-branchbreaker': {
      // A cleansed hostile body (the frames before the ally swap) stands calm rather than holding the downed hurt pose.
      return statusKeyOf(actor.chapterStatus) === 'resolved' && !combatPose && still ? loopSample(out, 'monster-idle') : undefined;
    }
    default:
      return undefined;
  }
}
