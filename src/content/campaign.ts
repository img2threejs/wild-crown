import {
  REGION_IDS,
  REGIONAL_OBLIGATION_IDS,
  type CampaignState,
  type RegionId as CanonRegionId,
  type RestorationState,
} from "../../packages/campaign/src/index.js";
import playerCopy from "../../docs/production/content/PLAYER-COPY.en.json" with { type: "json" };
import type { CompanionId } from "../game/contracts.js";
import { REGIONS } from "./world.js";

/**
 * Authored regions cover the full scene graph; canonical `REGION_IDS` is the
 * narrower five-region subset that defines ending eligibility. Every authored
 * region initializes its own restoration facts so noncanonical regions
 * (greenwake, the-grove, refuge, heartroot-hollow) participate in state
 * monotonicity, route gating, and renderer tinting.
 */
export const RESTORATION_STATE_FACT_ID = (region: string): string =>
  `restoration:${region}:state`;

export const RESTORATION_PARTIAL_FACT_ID = (region: string): string =>
  `restoration:${region}:partial`;

export const RESTORATION_RESTORED_FACT_ID = (region: string): string =>
  `restoration:${region}:restored`;

/** Rank for monotonic state ordering; matches the canonical restoration flow. */
export const RESTORATION_RANK: Readonly<Record<RestorationState, number>> = {
  unvisited: 0,
  corrupted: 1,
  partial: 2,
  restored: 3,
};

export function restorationStateFromFacts(
  facts: Readonly<Record<string, boolean | number | string>>,
  region: string,
  fallback: RestorationState = "unvisited",
): RestorationState {
  if (facts[RESTORATION_STATE_FACT_ID(region)] === "restored") return "restored";
  if (facts[RESTORATION_STATE_FACT_ID(region)] === "partial") return "partial";
  if (facts[RESTORATION_STATE_FACT_ID(region)] === "corrupted") return "corrupted";
  if (facts[RESTORATION_STATE_FACT_ID(region)] === "unvisited") return "unvisited";
  // Legacy envelopes authored before local-state persistence only carry booleans.
  if (facts[RESTORATION_RESTORED_FACT_ID(region)] === true) return "restored";
  if (facts[RESTORATION_PARTIAL_FACT_ID(region)] === true) return "partial";
  return fallback;
}

/**
 * Authoritative mapping from canonical regions to the historical exposed alias
 * fact IDs. The Director's normalizer and `emptyWorldFacts` both consume this
 * single mapping so the initial state and adoption paths stay in lockstep.
 */
export const CANONICAL_RESTORATION_FACT_IDS: Readonly<Record<CanonRegionId, string>> = {
  "whispering-canopy": "canopy_restored",
  "blood-bamboo-valley": "bamboo_restored",
  "moonpine-ridge": "moonpine_restored",
  "mistveil-basin": "mistveil_restored",
  "sunmane-expanse": "sunmane_restored",
};

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
  // Every authored region initializes its own restoration facts: canonical
  // regions derive state/partial/restored/alias from campaign.world.regions;
  // noncanonical authored regions (greenwake, the-grove, refuge,
  // heartroot-hollow) start unvisited without ever touching the canonical
  // world. CANONICAL_RESTORATION_FACT_IDS is the single authoritative
  // alias map shared with the Director normalizer.
  const restoration: Record<string, boolean | number | string> = {};
  for (const region of REGIONS) {
    const isCanonical = REGION_IDS.includes(region.id as typeof REGION_IDS[number]);
    const canonical = isCanonical ? state.world.regions[region.id as typeof REGION_IDS[number]] : "unvisited";
    restoration[RESTORATION_STATE_FACT_ID(region.id)] = canonical;
    restoration[RESTORATION_PARTIAL_FACT_ID(region.id)] = canonical === "partial";
    restoration[RESTORATION_RESTORED_FACT_ID(region.id)] = canonical === "restored";
    if (isCanonical) {
      restoration[CANONICAL_RESTORATION_FACT_IDS[region.id as typeof REGION_IDS[number]]] = canonical === "restored";
    }
  }
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
    ...restoration,
  };
}
