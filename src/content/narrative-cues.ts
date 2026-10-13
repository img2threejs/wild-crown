import type { ObjectiveId, QuestId } from "../game/contracts.js";
import { STORY_DIALOGUE } from "./story.js";

/**
 * First-Pact runtime narrative cues.
 *
 * The runtime quest/dialogue scheduler is data-driven: it consults this
 * mapping to decide which authored `STORY_DIALOGUE` beat (if any) must be
 * presented in response to a quest lifecycle transition.
 *
 * Cues are intentionally authored per quest, not derived from
 * `QuestDefinition.dialogueIds`: the existing scripted array is a content
 * audit list that the runtime cannot otherwise time. This file keeps the
 * runtime keying narrow and explicit, and is the only source the cue
 * scheduler reads.
 */
export interface ObjectiveCue {
  /** The completed objective that triggers the cue. */
  objectiveId: ObjectiveId;
  /** Authored dialogue beat to present. */
  beatId: string;
}

export interface QuestCueDefinition {
  /** Quest this cue definition belongs to. */
  questId: QuestId;
  /** Beat shown when the quest enters the active set. */
  onActivate?: string;
  /** Beat shown when the quest moves to the completed set. */
  onComplete?: string;
  /** Beats shown when one of these objectives commits while the quest is active. */
  onObjective?: readonly ObjectiveCue[];
}

/**
 * Ordered, per-quest cue definitions for the First Pact (chapters 0-2).
 *
 * Later P13 story scope remains untouched.
 */
export const NARRATIVE_CUES: Readonly<Record<string, QuestCueDefinition>> =
  Object.freeze({
    prologue: {
      questId: "prologue" as QuestId,
      // The run-start flow presents prologue dialogue directly; do not repeat it as a transition cue.
    },
    "fallen-scout": {
      questId: "fallen-scout" as QuestId,
      onActivate: "fallen-scout-open",
      onComplete: "fallen-scout-close",
    },
    "thief-in-the-branches": {
      questId: "thief-in-the-branches" as QuestId,
      onActivate: "branches-open",
      onComplete: "branches-close",
    },
    "empty-orchard": {
      questId: "empty-orchard" as QuestId,
      onActivate: "orchard-open",
      onComplete: "orchard-close",
    },
    "tracks-without-blood": {
      questId: "tracks-without-blood" as QuestId,
      onActivate: "tracks-open",
    },
    "the-ash-hunters": {
      questId: "the-ash-hunters" as QuestId,
      onActivate: "hunters-open",
      onObjective: [
        { objectiveId: "the-ash-hunters:rescue-tali" as ObjectiveId, beatId: "tali-rescue" },
      ],
    },
    "a-mothers-roar": {
      questId: "a-mothers-roar" as QuestId,
      onActivate: "asha-echo",
      onObjective: [
        { objectiveId: "a-mothers-roar:cleanse-asha" as ObjectiveId, beatId: "asha-close" },
      ],
    },
    "the-empty-nest": {
      questId: "the-empty-nest" as QuestId,
      onActivate: "the-empty-nest-opening",
      onComplete: "the-empty-nest-resolution",
    },
    "the-last-cub": {
      questId: "the-last-cub" as QuestId,
      onActivate: "the-last-cub-opening",
      onComplete: "the-last-cub-resolution",
    },
    "seeds-between-branches": {
      questId: "seeds-between-branches" as QuestId,
      onActivate: "seeds-between-branches-opening",
      onComplete: "seeds-between-branches-resolution",
    },
    "the-broken-snare-trail": {
      questId: "the-broken-snare-trail" as QuestId,
      onActivate: "the-broken-snare-trail-opening",
      onComplete: "the-broken-snare-trail-resolution",
    },
  });

/**
 * Confirms a beat id exists in the authored story dialogue.
 *
 * The scheduler uses this as a fail-closed guard so a stale or evicted cue
 * does not silently present a missing beat.
 */
export function isCueBeatAuthored(beatId: string): boolean {
  return Boolean(STORY_DIALOGUE[beatId]);
}

/**
 * Resolves the beat scheduled for an objective completion.
 *
 * Looks up cues keyed by the quest that owns the objective, then matches the
 * objective id exactly. Activation/completion cues are resolved inline by
 * the scheduler because they are single-expression lookups against
 * `NARRATIVE_CUES`.
 */
export function cueForObjective(
  questId: string,
  objectiveId: string,
): string | null {
  const onObjective = NARRATIVE_CUES[questId]?.onObjective;
  if (!onObjective) return null;
  const match = onObjective.find((cue) => cue.objectiveId === objectiveId);
  return match?.beatId ?? null;
}