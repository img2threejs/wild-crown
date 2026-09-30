import {
  REGIONAL_OBLIGATION_IDS,
  REGION_IDS,
  type CampaignState,
} from "../../packages/campaign/src/index.js";
import playerCopy from "../../docs/production/content/PLAYER-COPY.en.json" with { type: "json" };
import type { CompanionId } from "../game/contracts.js";
import { REGIONS } from "./world.js";

export const COMPANION_COPY = {
  vara: playerCopy.companions.vara,
  koro: playerCopy.companions.koro,
  asha: playerCopy.companions.asha,
  sable: playerCopy.companions.sable,
  nyra: playerCopy.companions.nyra,
  solkar: playerCopy.companions.solkar,
} as const satisfies Record<CompanionId, object>;


export {
  ACTORS,
  ENVIRONMENT_RECIPES,
  REGION_PROP_PLACEMENTS,
  REGION_AUTHORING_STATUS,
  INTERACTIONS,
  REGIONS,
  SETTINGS_COPY,
} from "./world.js";
export { CAMPAIGN_CHOICES, CANONICAL_CAMPAIGN_IDS, QUESTS } from "./quests.js";
export { DIALOGUE } from "./dialogue.js";

export function emptyWorldFacts(
  state: CampaignState,
): Record<string, boolean | number | string> {
  return {
    marekPresent: state.world.marekPresent,
    taliSafe: false,
    taliNeedsRescue: true,
    taliInBamboo: true,
    taliInGrove: false,
    taliCageOpen: false,
    solkarPresent: true,
    crownCouncilAvailable: false,
    mistveil_nyra_hidden_route: false,
    wardenCall: false,
    askSignal: false,
    refugeOpen: false,
    chapter: 0,
    ...Object.fromEntries(
      REGIONS.flatMap((region) =>
        region.movableObjects.map((object) => [object.movedFactId, false] as const),
      ),
    ),
    ...Object.fromEntries(
      REGIONAL_OBLIGATION_IDS.map((id) => [
        id,
        state.world.regionalObligations[id],
      ]),
    ),
    ...Object.fromEntries(
      REGION_IDS.map((id) => ["restoration:" + id + ":restored", false]),
    ),
    ...Object.fromEntries(
      REGION_IDS.map((id) => ["restoration:" + id + ":partial", false]),
    ),
  };
}
