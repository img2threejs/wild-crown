import type { LeaderId } from "../../../packages/campaign/src/index.js";
import type { CompanionId, RegionId, WorldEvent } from "../contracts.js";
import { eventMatches } from "./events.js";

/**
 * Pact ceremonies. The Director, not an event producer's optional `leaderId`/`dominion` tags, owns which leader a
 * Dominion option records history against and which companion a Bond option strengthens.
 */
export interface PactAuthority {
  choiceId: string;
  companionId: CompanionId;
  leaderId: LeaderId;
  /** Encounter whose committed cleanse makes the ceremony required. */
  encounterId: string;
  regionId: RegionId;
  chapter: number;
}
export const PACT_OPTION_IDS = ["bond", "dominion"] as const;
export const PACT_AUTHORITY: readonly PactAuthority[] = [
  { choiceId: "koro-pact", companionId: "koro", leaderId: "koro", encounterId: "encounter-koro", regionId: "whispering-canopy", chapter: 1 },
  { choiceId: "asha-pact", companionId: "asha", leaderId: "asha", encounterId: "encounter-asha", regionId: "blood-bamboo-valley", chapter: 2 },
];
export function pactForChoice(choiceId: string): PactAuthority | undefined {
  return PACT_AUTHORITY.find((pact) => pact.choiceId === choiceId);
}
/** The first pact ceremony whose boss was cleansed but whose choice is not yet committed; the ceremony cannot be skipped. */
export function pendingPactChoice(eventLog: readonly WorldEvent[], choices: Readonly<Record<string, string>>): string | null {
  for (const pact of PACT_AUTHORITY) {
    if (choices[pact.choiceId] !== undefined) continue;
    if (eventLog.some((event) => event.type === "encounter-resolved" && eventMatches("encounter:" + pact.encounterId, event))) {
      return pact.choiceId;
    }
  }
  return null;
}

/** Act I recruitment is an explicit committed outcome; later-act companions keep their fragment-based rule until their chapters are authored. */
export interface RecruitmentRule {
  companionId: CompanionId;
  requiredEvent: string;
}
export const RECRUITMENT_RULES: readonly RecruitmentRule[] = [
  { companionId: "vara", requiredEvent: "rescue:vara|tend:vara|fragment:heartroot-sky" },
  { companionId: "koro", requiredEvent: "encounter:encounter-koro" },
  { companionId: "asha", requiredEvent: "encounter:encounter-asha" },
  { companionId: "sable", requiredEvent: "fragment:heartroot-pack" },
  { companionId: "nyra", requiredEvent: "fragment:heartroot-shadow" },
  { companionId: "solkar", requiredEvent: "choice:sunmane-resolution:bond" },
];
