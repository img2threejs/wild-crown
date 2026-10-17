import type { ActorId, RegionDefinition, RegionId } from "../game/contracts.js";
import { ACTORS } from "./world.js";

/**
 * Candidate asset bindings of the chapter regions: which candidate catalog entry (generated native GLB, evidence still
 * blocked) stands behind each asset id a region requires. This is data for the strict candidate-chapter manifest projection
 * (`src/app/ChapterAssets.ts`); it never marks anything verified and never edits a catalog.
 *
 * - `assetId` is the catalog entry id and equals the `assetId` of the region entity or prop (or the actor variant) it serves.
 * - `actorId` rebinds the catalog entry to the canonical `ACTORS` key the renderer matches (catalogs name Koro `grove-koro` /
 *   `bamboo-koro-branchbreaker`, Asha `bamboo-asha`, Tali `bamboo-tali`, Marek `bamboo-marek`).
 * - `variantOf` marks a boss/stage variant of a canonical asset (Koro Branchbreaker is a variant of canonical Koro, never a
 *   second recruited companion).
 * Regions are explicit: an unsupported region has no entry and fails, it never falls back to another map's table.
 */
export interface CandidateAssetBinding {
  assetId: string;
  /** Candidate catalog (served under `/asset-source/playtests/`) the entry is read from. */
  catalogUrl: string;
  actorId?: ActorId;
  variantOf?: string;
}

const GREENWAKE = "/asset-source/playtests/greenwake.json";
const CANOPY = "/asset-source/playtests/canopy.json";
const BAMBOO = "/asset-source/playtests/bamboo.json";
const GROVE = "/asset-source/playtests/grove.json";
const MOONPINE = "/asset-source/playtests/moonpine.json";
const MISTVEIL = "/asset-source/playtests/mistveil.json";
const LATER = "/asset-source/playtests/later.json";

const props = (catalogUrl: string, ...assetIds: readonly string[]): CandidateAssetBinding[] => assetIds.map((assetId) => ({ assetId, catalogUrl }));
const actor = (assetId: string, catalogUrl: string, actorId: ActorId): CandidateAssetBinding => ({ assetId, catalogUrl, actorId });

/** The shared companion bindings, each read from the catalog that carries its native entry. */
const KORO = actor("actor-koro", BAMBOO, "koro");
const KORO_BRANCHBREAKER: CandidateAssetBinding = { assetId: "actor-koro-branchbreaker", catalogUrl: BAMBOO, actorId: "koro", variantOf: "actor-koro" };
const ASHA = actor("actor-asha", BAMBOO, "asha");
const TALI = actor("actor-tali", BAMBOO, "tali");
/** Travel parties are projected into the current region; only its actual dependencies enter the native manifest. */
const COMPANIONS: readonly CandidateAssetBinding[] = [
  actor("actor-vara", GREENWAKE, "vara"), KORO, ASHA,
  actor("actor-sable", LATER, "sable"), actor("actor-nyra", LATER, "nyra"), actor("actor-solkar", LATER, "solkar"),
];

export const CHAPTER_ASSET_BINDINGS: Readonly<Partial<Record<RegionId, readonly CandidateAssetBinding[]>>> = {
  greenwake: [
    actor("actor-yara", GREENWAKE, "yara"),
    ...COMPANIONS,
    actor("actor-ember-boar", GREENWAKE, "corrupted-boar"),
    actor("actor-frost-sap-stalker", GREENWAKE, "corrupted-boar"),
    actor("actor-root-rammer", GREENWAKE, "corrupted-boar"),
    ...props(GREENWAKE, "prop-greenwake-houses", "prop-erya-edge-tree", "prop-greenwake-rope-bridge", "prop-root-arch", "prop-hunter-cage"),
  ],
  "whispering-canopy": [
    ...COMPANIONS,
    actor("actor-thornback-howler", CANOPY, "canopy-howler"),
    actor("actor-storm-hornbill", CANOPY, "canopy-hornbill"),
    actor("actor-mire-viper", CANOPY, "canopy-mire-viper"),
    KORO_BRANCHBREAKER,
    ...props(CANOPY, "prop-vine-bridge", "prop-ancient-canopy-shrine", "prop-rainforest-canopy-tree", "prop-canopy-cliff-rock", "prop-canopy-fern-cluster", "prop-mire-bank-rock"),
    ...props(LATER, "prop-seed-supply-basket"),
    actor("actor-roost-hornbill", LATER, "roost-hornbill"),
  ],
  "blood-bamboo-valley": [
    ...COMPANIONS,
    TALI,
    actor("actor-nursery-cub", BAMBOO, "nursery-cub"),
    actor("actor-marek", BAMBOO, "marek"),
    // The candidate camp hunters (two melee, one ranged placement) stand behind the canonical hunter archetypes.
    actor("actor-camp-hunter-melee", BAMBOO, "poacher-hunter"),
    actor("actor-camp-hunter-ranged", BAMBOO, "poacher-scout"),
    ...props(
      BAMBOO, "prop-bamboo-grove-cluster", "prop-hunter-camp", "prop-ancient-bamboo-shrine", "prop-black-sap-jaw-trap", "prop-hunter-cage", "prop-hunter-extraction-rig",
      "prop-black-sap-filter-drum", "prop-root-cavern-mouth", "prop-root-arch", "prop-canopy-cliff-rock", "prop-canopy-fern-cluster",
    ),
  ],
  "the-grove": [
    ...COMPANIONS,
    actor("actor-yara", GREENWAKE, "yara"),
    actor("actor-orun", LATER, "orun"),
    TALI,
    ...props(
      GROVE, "prop-heartroot-trunk", "prop-refuge-shelter", "prop-grove-platform", "prop-training-post", "prop-water-basin", "prop-root-cavern-mouth",
      "prop-greenwake-boulder-cluster", "prop-canopy-fern-cluster", "prop-erya-edge-tree", "prop-canopy-cliff-rock", "prop-mire-bank-rock", "prop-ancient-canopy-shrine",
    ),
    ...props(LATER, "prop-bird-nest"),
    actor("actor-roost-hornbill", LATER, "roost-hornbill"),
  ],
  "moonpine-ridge": [
    ...COMPANIONS,
    actor("actor-ruun-chained-howl", MOONPINE, "ruun"),
    actor("actor-luma", LATER, "luma"),
    actor("actor-ridge-elder-scout", LATER, "ridge-elder-scout"),
    actor("actor-ridge-young-scout", LATER, "ridge-young-scout"),
    ...props(MOONPINE, "prop-moonpine-tree", "prop-buried-wolf-temple", "prop-temple-chain-anchor", "prop-snow-ridge-rock", "prop-moonpine-log-bridge"),
    ...props(GROVE, "prop-refuge-shelter"),
    ...props(LATER, "prop-seed-supply-basket"),
  ],
  "mistveil-basin": [
    ...COMPANIONS,
    actor("actor-ghor-mire-maw", MISTVEIL, "ghor"),
    actor("actor-marek", BAMBOO, "marek"),
    ...props(MISTVEIL, "prop-mistveil-reed-cluster", "prop-hunter-extraction-rig", "prop-mire-bank-rock", "prop-root-cavern-mouth", "prop-black-sap-filter-drum"),
    ...props(BAMBOO, "prop-black-sap-jaw-trap"),
  ],
  "sunmane-expanse": [
    ...COMPANIONS,
    actor("actor-council-envoy", LATER, "council-envoy"),
    ...props(LATER, "prop-sunmane-stone-terrace", "prop-migration-gate", "prop-water-allotment-gate", "prop-plains-stone-arch", "prop-savanna-acacia"),
  ],
  refuge: [
    ...COMPANIONS,
    actor("actor-yara", GREENWAKE, "yara"), TALI,
    actor("actor-council-envoy", LATER, "council-envoy"),
    ...props(GROVE, "prop-refuge-shelter", "prop-training-post", "prop-canopy-fern-cluster", "prop-water-basin"),
    ...props(LATER, "prop-map-table", "prop-heartroot-fragment-stone"),
  ],
  "heartroot-hollow": [
    ...COMPANIONS,
    actor("actor-orun", LATER, "orun"),
    { assetId: "actor-orun-crowned-beast", catalogUrl: LATER, actorId: "orun", variantOf: "actor-orun" },
    // The Sky aspect's Heartroot shadow echoes reuse the native Canopy storm hornbill (never a Vara clone).
    actor("actor-storm-hornbill", CANOPY, "canopy-hornbill"),
    ...props(LATER, "prop-heartroot-root-column", "prop-six-fragment-shrine", "prop-root-crown-altar", "prop-hollow-cavern-rock", "prop-root-tether-anchor"),
  ],
};

/**
 * Every asset id a chapter region needs to render: the ids its entities and props place, plus the variant assets of the actors that
 * take part in its encounters (a boss variant such as Koro Branchbreaker is preloaded before the fight, not discovered during it).
 */
export function chapterRequiredAssetIds(region: RegionDefinition): readonly string[] {
  const required = new Set(region.assetIds);
  const participants = new Set(Object.values(region.encounterParticipants).flat());
  for (const entity of region.entities) {
    if (entity.kind !== "actor" || !entity.actorId || !participants.has(entity.id)) continue;
    for (const variant of Object.values(ACTORS[entity.actorId]?.assetVariants ?? {})) required.add(variant);
  }
  return [...required].sort();
}
