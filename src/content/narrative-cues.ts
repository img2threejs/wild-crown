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
 * Ordered, per-quest cue definitions for every authored chapter (chapters 0–8).
 */
export const NARRATIVE_CUES: Readonly<Record<string, QuestCueDefinition>> =
  Object.freeze({
    prologue: {
      questId: "prologue" as QuestId,
      onActivate: "prologue-opening",
      onObjective: [
        { objectiveId: "prologue:receive-sky" as ObjectiveId, beatId: "prologue-vision" },
        { objectiveId: "prologue:cleanse-boar" as ObjectiveId, beatId: "greenwake-cleanse" },
      ],
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
      onObjective: [
        { objectiveId: "empty-orchard:koro-thorn" as ObjectiveId, beatId: "koro-thorn-reveal" },
        { objectiveId: "empty-orchard:cleanse-koro" as ObjectiveId, beatId: "koro-cleanse" },
        { objectiveId: "empty-orchard:koro-pact" as ObjectiveId, beatId: "koro-pact-close" },
      ],
    },
    "tracks-without-blood": {
      questId: "tracks-without-blood" as QuestId,
      onActivate: "tracks-open",
    },
    "the-ash-hunters": {
      questId: "the-ash-hunters" as QuestId,
      onActivate: "hunters-open",
      onObjective: [
        { objectiveId: "the-ash-hunters:subdue-hunters" as ObjectiveId, beatId: "marek-escape" },
        { objectiveId: "the-ash-hunters:rescue-tali" as ObjectiveId, beatId: "tali-rescue" },
      ],
    },
    "a-mothers-roar": {
      questId: "a-mothers-roar" as QuestId,
      onActivate: "asha-echo",
      onObjective: [
        { objectiveId: "a-mothers-roar:follow-tali" as ObjectiveId, beatId: "tali-shelter-warning" },
        { objectiveId: "a-mothers-roar:asha-phase" as ObjectiveId, beatId: "asha-phase-three" },
        { objectiveId: "a-mothers-roar:cleanse-asha" as ObjectiveId, beatId: "asha-close" },
        { objectiveId: "a-mothers-roar:asha-pact" as ObjectiveId, beatId: "asha-pact-close" },
        { objectiveId: "a-mothers-roar:snare-source" as ObjectiveId, beatId: "bamboo-source-cleansed" },
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
    "the-third-howl": {
      questId: "the-third-howl" as QuestId,
      onActivate: "howl-open",
    },
    "two-packs": {
      questId: "two-packs" as QuestId,
      onActivate: "two-packs-open",
    },
    "the-alpha-below": {
      questId: "the-alpha-below" as QuestId,
      onActivate: "ruun-open",
      onComplete: "ruun-close",
    },
    "eyes-in-the-mist": {
      questId: "eyes-in-the-mist" as QuestId,
      onActivate: "mist-eyes-open",
    },
    "the-black-river": {
      questId: "the-black-river" as QuestId,
      onActivate: "river-open",
      onComplete: "marek-variant",
    },
    "the-mire-maw": {
      questId: "the-mire-maw" as QuestId,
      onActivate: "ghor-open",
      onComplete: "ghor-close",
    },
    "the-silent-plains": {
      questId: "the-silent-plains" as QuestId,
      onActivate: "plains-open",
    },
    "tribute-of-teeth": {
      questId: "tribute-of-teeth" as QuestId,
      onActivate: "tribute-open",
    },
    "the-lions-offer": {
      questId: "the-lions-offer" as QuestId,
      onActivate: "solkar-echo",
      onComplete: "solkar-choice",
    },
    "fall-of-the-grove": {
      questId: "fall-of-the-grove" as QuestId,
      onActivate: "fall-of-the-grove-opening",
      onComplete: "fall-of-the-grove-resolution",
    },
    "wild-march": {
      questId: "wild-march" as QuestId,
      onActivate: "wild-march-opening",
      onComplete: "wild-march-resolution",
    },
    "heartroot-hollow": {
      questId: "heartroot-hollow" as QuestId,
      onActivate: "heartroot-hollow-opening",
      onComplete: "heartroot-hollow-resolution",
    },
    "orun-the-hollow-king": {
      questId: "orun-the-hollow-king" as QuestId,
      onActivate: "orun-the-hollow-king-opening",
      onComplete: "orun-the-hollow-king-resolution",
    },
    "a-pack-divided": {
      questId: "a-pack-divided" as QuestId,
      onActivate: "a-pack-divided-opening",
      onComplete: "a-pack-divided-resolution",
    },
    "winter-stores": {
      questId: "winter-stores" as QuestId,
      onActivate: "winter-stores-opening",
      onComplete: "winter-stores-resolution",
    },
    "the-silent-hunter": {
      questId: "the-silent-hunter" as QuestId,
      onActivate: "the-silent-hunter-opening",
      onComplete: "the-silent-hunter-resolution",
    },
    "the-hunters-remorse": {
      questId: "the-hunters-remorse" as QuestId,
      onActivate: "the-hunters-remorse-opening",
      onComplete: "the-hunters-remorse-resolution",
    },
    "river-of-black-sap": {
      questId: "river-of-black-sap" as QuestId,
      onActivate: "river-of-black-sap-opening",
      onComplete: "river-of-black-sap-resolution",
    },
    "a-king-without-subjects": {
      questId: "a-king-without-subjects" as QuestId,
      onActivate: "a-king-without-subjects-opening",
      onComplete: "a-king-without-subjects-resolution",
    },
    "the-last-crossing": {
      questId: "the-last-crossing" as QuestId,
      onActivate: "the-last-crossing-opening",
      onComplete: "the-last-crossing-resolution",
    },
    "roots-we-share": {
      questId: "roots-we-share" as QuestId,
      onActivate: "roots-we-share-opening",
      onComplete: "roots-we-share-resolution",
    },
    "seeds-on-the-wind": {
      questId: "seeds-on-the-wind" as QuestId,
      onActivate: "seeds-on-the-wind-opening",
      onComplete: "seeds-on-the-wind-resolution",
    },
    "a-path-for-the-young": {
      questId: "a-path-for-the-young" as QuestId,
      onActivate: "a-path-for-the-young-opening",
      onComplete: "a-path-for-the-young-resolution",
    },
    "one-howl-two-generations": {
      questId: "one-howl-two-generations" as QuestId,
      onActivate: "one-howl-two-generations-opening",
      onComplete: "one-howl-two-generations-resolution",
    },
    "witness-in-the-reeds": {
      questId: "witness-in-the-reeds" as QuestId,
      onActivate: "witness-in-the-reeds-opening",
      onComplete: "witness-in-the-reeds-resolution",
    },
    "the-open-crossing": {
      questId: "the-open-crossing" as QuestId,
      onActivate: "the-open-crossing-opening",
      onComplete: "the-open-crossing-resolution",
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