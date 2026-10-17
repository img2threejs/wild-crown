import type {
  ActorDefinition,
  EnvironmentRecipeDefinition,
  InteractionActivation,
  InteractionDefinition,
  InteractionInputHint,
  RegionAuthoringStatus,
  RegionDefinition,
  RegionId,
} from "../game/contracts.js";
import {
  ACT_I_REGION_AUTHORING_STATUS,
  ACT_I_REGIONS,
} from "./levels/act-i.js";
import { ACT_I_INTERACTIONS } from "./act-i-interactions.js";
import { LATER_ACT_INTERACTIONS } from "./later-act-interactions.js";
import {
  LATER_ACT_REGION_AUTHORING_STATUS,
  LATER_ACT_REGIONS,
} from "./levels/later-acts.js";
import { GROVE_ACTORS } from "../game/combat/GroveContent.js";
import { MISTVEIL_ACTORS } from "../game/combat/MistveilContent.js";
import { MOONPINE_ACTORS } from "../game/combat/MoonpineContent.js";
import { SIDE_QUEST_ACTORS, SIDE_QUEST_DELIVERIES, SIDE_QUEST_DELIVERY_INTERACTIONS, SIDE_QUEST_ENTITIES, SIDE_QUEST_FIELD_TRAPS, SIDE_QUEST_INTERACTIONS, SIDE_QUEST_ROUTES } from "./side-quests.js";
import { placement, uniform } from "./levels/layout-kit.js";
import { v } from "./levels/schema.js";

export const ACTORS: Readonly<Record<string, ActorDefinition>> = {
  aren: {
    id: "aren",
    species: "human",
    role: "player",
    allegiance: "player",
    combatRole: "player",
    assetId: "actor-aren",
  },
  yara: {
    id: "yara",
    species: "human",
    role: "mentor",
    allegiance: "ally",
    combatRole: "noncombat",
    assetId: "actor-yara",
  },
  vara: {
    id: "vara",
    species: "harpy-eagle",
    role: "scout",
    allegiance: "ally",
    combatRole: "companion",
    assetId: "actor-vara",
  },
  koro: {
    id: "koro",
    species: "macaque",
    role: "leader",
    allegiance: "ally",
    combatRole: "companion",
    assetId: "actor-koro",
    assetVariants: { branchbreaker: "actor-koro-branchbreaker" },
    absentSafeAlternative: "manual-contextual-interaction",
  },
  asha: {
    id: "asha",
    species: "tiger",
    role: "leader",
    allegiance: "ally",
    combatRole: "companion",
    assetId: "actor-asha",
    absentSafeAlternative: "player-only-counter",
  },
  tali: {
    id: "tali",
    species: "tiger-cub",
    role: "cub",
    allegiance: "ally",
    combatRole: "noncombat",
    assetId: "actor-tali",
  },
  ...SIDE_QUEST_ACTORS,
  ruun: {
    id: "ruun",
    species: "wolf",
    role: "leader",
    allegiance: "neutral",
    combatRole: "political-only",
    assetId: "actor-ruun",
    absentSafeAlternative: "pack-council-echo",
  },
  luma: {
    id: "luma",
    species: "wolf",
    role: "leader",
    allegiance: "neutral",
    combatRole: "political-only",
    assetId: "actor-luma",
    absentSafeAlternative: "pack-steward-council",
  },
  sable: {
    id: "sable",
    species: "wolf",
    role: "envoy",
    allegiance: "ally",
    combatRole: "companion",
    assetId: "actor-sable",
  },
  nyra: {
    id: "nyra",
    species: "panther",
    role: "leader",
    allegiance: "ally",
    combatRole: "companion",
    assetId: "actor-nyra",
    absentSafeAlternative: "echo-trail-evidence",
  },
  solkar: {
    id: "solkar",
    species: "lion",
    role: "leader",
    allegiance: "neutral",
    combatRole: "companion",
    assetId: "actor-solkar",
    assetVariants: {},
    absentSafeAlternative: "crown-council",
  },
  ghor: {
    id: "ghor",
    species: "crocodile",
    role: "boss",
    allegiance: "hostile",
    combatRole: "hostile",
    assetId: "actor-ghor",
  },
  marek: {
    id: "marek",
    species: "human",
    role: "enemy",
    allegiance: "neutral",
    combatRole: "noncombat",
    assetId: "actor-marek",
    absentSafeAlternative: "field-ledger-and-hand-release",
  },
  orun: {
    id: "orun",
    species: "human",
    role: "boss",
    allegiance: "hostile",
    combatRole: "hostile",
    assetId: "actor-orun",
    assetVariants: { "crowned-beast": "actor-orun-crowned-beast" },
  },
  "poacher-scout": {
    id: "poacher-scout",
    species: "human",
    role: "enemy",
    allegiance: "hostile",
    combatRole: "hostile",
    assetId: "actor-poacher-scout",
    assetVariants: { "camp-ranged": "actor-camp-hunter-ranged" },
  },
  "poacher-hunter": {
    id: "poacher-hunter",
    species: "human",
    role: "enemy",
    allegiance: "hostile",
    combatRole: "hostile",
    assetId: "actor-poacher-hunter",
    assetVariants: { "camp-melee": "actor-camp-hunter-melee" },
  },
  "corrupted-boar": {
    id: "corrupted-boar",
    species: "boar",
    role: "wild",
    allegiance: "wild",
    combatRole: "hostile",
    assetId: "actor-corrupted-boar",
    assetVariants: { ember: "actor-ember-boar", "frost-sap-stalker": "actor-frost-sap-stalker", "root-rammer": "actor-root-rammer" },
  },
  // Whispering Canopy playtest monsters (hostile wildlife corrupted by Black Sap); placed only by the canopy trial region variant.
  "canopy-howler": {
    id: "canopy-howler",
    species: "howler-monkey",
    role: "wild",
    allegiance: "wild",
    combatRole: "hostile",
    assetId: "actor-thornback-howler",
  },
  "canopy-hornbill": {
    id: "canopy-hornbill",
    species: "storm-hornbill",
    role: "wild",
    allegiance: "wild",
    combatRole: "hostile",
    assetId: "actor-storm-hornbill",
  },
  "canopy-mire-viper": {
    id: "canopy-mire-viper",
    species: "viper",
    role: "wild",
    allegiance: "wild",
    combatRole: "hostile",
    assetId: "actor-mire-viper",
  },
  "council-envoy": {
    id: "council-envoy",
    species: "antelope",
    role: "envoy",
    allegiance: "neutral",
    combatRole: "political-only",
    assetId: "actor-council-envoy",
  },
  ...GROVE_ACTORS,
  ...MOONPINE_ACTORS,
  ...MISTVEIL_ACTORS,
};

const sourceRegions: readonly RegionDefinition[] = [
  ...ACT_I_REGIONS,
  ...LATER_ACT_REGIONS,
].map((region): RegionDefinition => {
  const traps = SIDE_QUEST_FIELD_TRAPS[region.id] ?? [];
  const deliveries = SIDE_QUEST_DELIVERIES[region.id] ?? [];
  return {
    ...region,
    entities: [
      ...region.entities, ...(SIDE_QUEST_ENTITIES[region.id] ?? []),
      ...deliveries.flatMap(delivery => [
        { id: delivery.pickupInteractionId, kind: "interaction" as const, position: delivery.from, placement: "elevated" as const, interactionId: delivery.pickupInteractionId },
        { id: delivery.deliveryInteractionId, kind: "interaction" as const, position: delivery.to, placement: "elevated" as const, interactionId: delivery.deliveryInteractionId },
      ]),
      ...(region.id === "refuge" ? [{
        id: "refuge-council-envoy", actorId: "council-envoy", assetId: "actor-council-envoy",
        kind: "actor" as const, position: v(16, 3, 3), placement: "elevated" as const, visibleWhen: "side:crown-refusal",
      }] : []),
    ],
    traversalArcs: [...region.traversalArcs, ...(SIDE_QUEST_ROUTES[region.id] ?? [])],
    fieldTraps: [...(region.fieldTraps ?? []), ...traps],
    deliveries: [...(region.deliveries ?? []), ...deliveries],
    props: [
      ...region.props,
      ...deliveries.map(delivery => ({
        ...placement(delivery.id, delivery.assetId, delivery.from, "ground", 0, uniform(1)),
        visibleWhen: `quest:${delivery.questId}:accepted`,
      })),
      ...(region.id === "moonpine-ridge" ? [{
        ...placement("moonpine-winter-shelter", "prop-refuge-shelter", v(-23, 8, 10), "ground", 0, uniform(0.65)),
        visibleWhen: "quest:winter-stores:accepted",
      }] : []),
      ...(region.id === "blood-bamboo-valley" ? [
        placement("nursery-safe-hollow", "prop-root-cavern-mouth", v(-44, 0, -21), "ground", 0, uniform(0.35)),
      ] : []),
      ...(region.id === "mistveil-basin" ? [
        placement("tributary-filter", "prop-black-sap-filter-drum", v(21.5, 0, -4), "ground", 0, uniform(0.65)),
      ] : []),
      ...traps.map(trap => placement(trap.id, "prop-black-sap-jaw-trap", trap.position, "ground", 0, uniform(1))),
      ...(region.id === "refuge" ? [
        { ...placement("refuge-shared-garden-water", "prop-water-basin", v(-18, 1.5, -5), "ground", 0, uniform(0.6)), visibleWhen: "hub:refuge-garden" },
        ...[v(-18, 1.5, -11), v(-20, 1.5, -9), v(-17, 1.5, -8)].map((position, index) => ({
          ...placement("refuge-shared-garden-" + index, "prop-canopy-fern-cluster", position, "ground", index, uniform(0.7)),
          visibleWhen: "hub:refuge-garden",
        })),
      ] : []),
    ],
  };
});
const regionIds = new Set<RegionId>();

function requireUniqueIds(values: readonly string[], label: string): void {
  const ids = new Set<string>();
  for (const id of values) {
    if (ids.has(id)) throw new Error(label + " contains duplicate id: " + id);
    ids.add(id);
  }
}

for (const region of sourceRegions) {
  if (regionIds.has(region.id)) {
    throw new Error("Region source contains duplicate region: " + region.id);
  }
  regionIds.add(region.id);
  const expectedStatus = ACT_I_REGIONS.some(source => source.id === region.id)
    ? ACT_I_REGION_AUTHORING_STATUS
    : LATER_ACT_REGION_AUTHORING_STATUS;
  if (region.authoringStatus !== expectedStatus) {
    throw new Error("Region authoring status does not match its act module: " + region.id);
  }
  requireUniqueIds(region.entities.map((entity) => entity.id), region.id + " entities");
  requireUniqueIds(region.props.map((prop) => prop.id), region.id + " props");
  requireUniqueIds(region.ground.surfaces.map((surface) => surface.id), region.id + " surfaces");
  requireUniqueIds(region.ground.colliders.map((collider) => collider.id), region.id + " colliders");
  requireUniqueIds(region.navigation.nodes.map((node) => node.id), region.id + " nav nodes");
  requireUniqueIds(region.exits.map((route) => route.id), region.id + " exits");
  requireUniqueIds(region.traversalArcs.map((route) => route.id), region.id + " traversal arcs");
  requireUniqueIds(region.encounterIds, region.id + " encounters");
  if (region.encounterIds.length !== Object.keys(region.encounterParticipants).length) {
    throw new Error("Encounter ids and participant records differ: " + region.id);
  }
  for (const encounterId of region.encounterIds) {
    const participants = region.encounterParticipants[encounterId];
    if (!participants || participants.length === 0) {
      throw new Error("Encounter has no participant instances: " + encounterId);
    }
    requireUniqueIds(participants, region.id + " participants for " + encounterId);
    for (const participantId of participants) {
      if (!region.entities.some((entity) => entity.id === participantId && entity.kind === "actor")) {
        throw new Error("Encounter participant is not an actor instance in " + region.id + ": " + participantId);
      }
    }
  }
  for (const entity of region.entities) {
    if (entity.kind !== "actor") continue;
    if (!entity.actorId || !entity.assetId) {
      throw new Error("Actor placement lacks canonical actor or asset id: " + region.id + "/" + entity.id);
    }
    const actor = ACTORS[entity.actorId];
    if (!actor) throw new Error("Actor placement has unknown archetype: " + entity.actorId);
    const actorAssets = [actor.assetId, ...Object.values(actor.assetVariants ?? {})];
    if (!actorAssets.includes(entity.assetId)) {
      throw new Error("Actor placement uses an unregistered asset: " + region.id + "/" + entity.id);
    }
  }
  for (const surface of region.ground.surfaces) {
    if (!region.ground.colliders.some((collider) => collider.id === surface.colliderId)) {
      throw new Error("Ground surface has no collider record: " + region.id + "/" + surface.id);
    }
  }
  const surfaceIds = new Set(region.ground.surfaces.map((surface) => surface.id));
  for (const collider of region.ground.colliders) {
    if (collider.walkSurfaceId && !surfaceIds.has(collider.walkSurfaceId)) {
      throw new Error("Collider references a missing walk surface: " + region.id + "/" + collider.id);
    }
  }
  const navNodeIds = new Set(region.navigation.nodes.map((node) => node.id));
  for (const node of region.navigation.nodes) {
    if (node.links.some((link) => !navNodeIds.has(link))) {
      throw new Error("Navigation node references a missing local node: " + region.id + "/" + node.id);
    }
  }
  for (const route of region.exits) {
    if (!route.id.endsWith("-out")) {
      throw new Error("Authored exit must end in -out for reciprocal derivation: " + route.id);
    }
    if (route.colliderIds.some((id) => !region.ground.colliders.some((collider) => collider.id === id))) {
      throw new Error("Route references a missing source collider: " + region.id + "/" + route.id);
    }
  }
  for (const arc of region.traversalArcs) {
    if (arc.colliderIds.some((id) => !region.ground.colliders.some((collider) => collider.id === id))) {
      throw new Error("Traversal arc references a missing source collider: " + region.id + "/" + arc.id);
    }
  }
}
for (const region of sourceRegions) {
  for (const route of region.exits) {
    if (!regionIds.has(route.destinationRegionId)) {
      throw new Error("Route targets a missing region: " + region.id + "/" + route.id);
    }
  }
}
for (const region of sourceRegions) {
  for (const arc of region.traversalArcs) {
    if (!regionIds.has(arc.destinationRegionId)) {
      throw new Error("Traversal arc targets a missing region: " + region.id + "/" + arc.id);
    }
  }
}

const reciprocalEntrances = new Map<RegionId, RegionDefinition["entrances"][number][]>();
for (const source of sourceRegions) {
  for (const route of source.exits) {
    if (!regionIds.has(route.destinationRegionId)) {
      throw new Error("Route destination is missing from region modules: " + route.id);
    }
    const entrance = {
      ...route,
      id: route.id.slice(0, -4) + "-in",
      from: route.to,
      to: route.from,
      anchors: [...route.anchors].reverse(),
      destinationRegionId: route.destinationRegionId,
    };
    const list = reciprocalEntrances.get(route.destinationRegionId) ?? [];
    list.push(entrance);
    reciprocalEntrances.set(route.destinationRegionId, list);
  }
}
for (const [regionId, entrances] of reciprocalEntrances) {
  requireUniqueIds(entrances.map((entrance) => entrance.id), regionId + " entrances");
}

function deriveAssetIds(region: RegionDefinition): string[] {
  return [...new Set([
    ...region.entities.flatMap((entity) => entity.assetId ? [entity.assetId] : []),
    ...region.props.map((prop) => prop.assetId),
  ])];
}

export const REGIONS: readonly RegionDefinition[] = sourceRegions.map((region) => ({
  ...region,
  entrances: reciprocalEntrances.get(region.id) ?? [],
  assetIds: deriveAssetIds(region),
}));
requireUniqueIds(REGIONS.map((region) => region.environmentRecipeId), "environment recipes");

function authoringStatusFor(regionId: RegionId): RegionAuthoringStatus {
  const region = REGIONS.find((candidate) => candidate.id === regionId);
  if (!region) throw new Error("Missing region while deriving authoring status: " + regionId);
  return region.authoringStatus;
}

export const REGION_AUTHORING_STATUS: Readonly<
  Record<RegionId, RegionAuthoringStatus>
> = Object.freeze({
  greenwake: authoringStatusFor("greenwake"),
  "the-grove": authoringStatusFor("the-grove"),
  "whispering-canopy": authoringStatusFor("whispering-canopy"),
  "blood-bamboo-valley": authoringStatusFor("blood-bamboo-valley"),
  "moonpine-ridge": authoringStatusFor("moonpine-ridge"),
  "mistveil-basin": authoringStatusFor("mistveil-basin"),
  "sunmane-expanse": authoringStatusFor("sunmane-expanse"),
  refuge: authoringStatusFor("refuge"),
  "heartroot-hollow": authoringStatusFor("heartroot-hollow"),
});

function propPlacementsFor(regionId: RegionId): readonly RegionDefinition["props"][number][] {
  const region = REGIONS.find((candidate) => candidate.id === regionId);
  if (!region) throw new Error("Missing region while deriving prop placements: " + regionId);
  return region.props;
}

export const REGION_PROP_PLACEMENTS: Readonly<
  Record<RegionId, readonly RegionDefinition["props"][number][]>
> = Object.freeze({
  greenwake: propPlacementsFor("greenwake"),
  "the-grove": propPlacementsFor("the-grove"),
  "whispering-canopy": propPlacementsFor("whispering-canopy"),
  "blood-bamboo-valley": propPlacementsFor("blood-bamboo-valley"),
  "moonpine-ridge": propPlacementsFor("moonpine-ridge"),
  "mistveil-basin": propPlacementsFor("mistveil-basin"),
  "sunmane-expanse": propPlacementsFor("sunmane-expanse"),
  refuge: propPlacementsFor("refuge"),
  "heartroot-hollow": propPlacementsFor("heartroot-hollow"),
});

const recipeLayers = (region: RegionDefinition): EnvironmentRecipeDefinition["proceduralLayers"] => {
  const layers: EnvironmentRecipeDefinition["proceduralLayers"][number][] = ["terrain"];
  if (region.ground.surfaces.some((surface) => surface.profile === "water") || region.props.some((prop) => prop.placement === "water-edge")) {
    layers.push("water");
  }
  if (region.props.length > 0) layers.push("vegetation");
  layers.push("fog", "lighting");
  if (region.ground.colliders.length > 0) layers.push("collision");
  return layers;
};

export const ENVIRONMENT_RECIPES: readonly EnvironmentRecipeDefinition[] = REGIONS.map((region) => ({
  id: region.environmentRecipeId,
  regionId: region.id,
  restorationFacts: {
    partial: "restoration:" + region.id + ":partial",
    restored: "restoration:" + region.id + ":restored",
  },
  proceduralLayers: recipeLayers(region),
  assetPlacementIds: region.props.map((prop) => prop.id),
  groundSurfaceIds: region.ground.surfaces.map((surface) => surface.id),
}));
const success = (type: string, data: Record<string, unknown> = {}) =>
  ({ type, ...data }) as never;
function interaction(
  id: string,
  regionId: RegionId,
  targetId: string,
  kind: InteractionDefinition["kind"],
  promptLabel: string,
  result: InteractionDefinition["success"],
  requiresFacts: readonly string[] = [],
  actionId = "contextual-interact",
  requiresActors: InteractionDefinition["requiresActors"] = [],
  inputHint: InteractionInputHint = "interact",
  activation: InteractionActivation = "press",
): InteractionDefinition {
  return {
    id,
    regionId,
    targetId,
    kind,
    promptLabel,
    radiusMeters: 2,
    actionId: actionId as never,
    requiresFacts,
    requiresActors,
    inputHint,
    activation,
    success: result,
    repeatable: false,
  };
}
export const INTERACTIONS: readonly InteractionDefinition[] = [
  ...ACT_I_INTERACTIONS,
  ...LATER_ACT_INTERACTIONS,
  ...SIDE_QUEST_INTERACTIONS,
  ...SIDE_QUEST_DELIVERY_INTERACTIONS,
  {
    id: "grove-pillar",
    regionId: "the-grove",
    targetId: "grove-pillar",
    kind: "coordinate",
    promptLabel: "Brace the damaged root pillar",
    radiusMeters: 2,
    requiresFacts: [],
    requiresActors: [],
    inputHint: "interact",
    activation: "press",
    success: success("semantic-interaction", {
      kind: "coordinate",
      targetId: "grove-pillar",
    }),
    repeatable: false,
  },
  {
    id: "grove-services",
    regionId: "the-grove",
    targetId: "grove-services",
    kind: "coordinate",
    promptLabel: "Move Grove services to the Refuge",
    radiusMeters: 2,
    requiresFacts: ["refugeOpen"],
    requiresActors: [],
    inputHint: "interact",
    activation: "press",
    success: success("semantic-interaction", {
      kind: "coordinate",
      targetId: "refuge-services",
    }),
    repeatable: false,
  },
  interaction(
    "grove-council",
    "the-grove",
    "grove-council",
    "choose",
    "Speak with the council",
    success("semantic-interaction", {
      kind: "choose",
      targetId: "grove-council",
    }),
  ),
  interaction(
    "warden-call",
    "the-grove",
    "warden-call",
    "signal",
    "Call to the Root Crown",
    success("semantic-interaction", {
      kind: "signal",
      targetId: "warden-call",
    }),
    ["groveFallPending"],
    "contextual-interact",
    ["aren"],
  ),
  {
    id: "refuge-lift",
    regionId: "the-grove",
    targetId: "refuge-lift",
    kind: "traverse",
    promptLabel: "Use the Refuge lift",
    radiusMeters: 2,
    requiresFacts: ["refugeOpen"],
    requiresActors: [],
    inputHint: "interact",
    activation: "press",
    success: success("traversal", {
      routeId: "grove-refuge",
      fromRegion: "the-grove",
      toRegion: "refuge",
      landmarkId: "grove-refuge-in",
    }),
    repeatable: false,
  },
  interaction(
    "three-beat-howl",
    "moonpine-ridge",
    "three-beat-howl",
    "track",
    "Follow the three-beat howl",
    success("semantic-interaction", {
      kind: "track",
      targetId: "three-beat-howl",
    }),
  ),
  interaction(
    "pack-pup-shelter",
    "moonpine-ridge",
    "pack-pups",
    "shelter",
    "Shelter the pack pups",
    success("rescue", {
      targetId: "pack-pups",
      locationId: "pack-pup-shelter",
    }),
  ),
  interaction(
    "temple-restraints",
    "moonpine-ridge",
    "temple-restraints",
    "break",
    "Break the restraint anchors",
    success("semantic-interaction", {
      kind: "break",
      targetId: "temple-restraints",
    }),
    [],
    "staff-heavy",
    [],
    "heavy",
    "press-release",
  ),
  interaction(
    "pack-settlement",
    "moonpine-ridge",
    "pack-settlement",
    "choose",
    "Resolve pack leadership",
    success("choice", {
      choiceId: "pack-leadership",
      targetId: "pack-settlement",
      optionIds: ["ruun", "luma", "dominion-ruun", "dominion-luma"],
    }),
    ["encounter-ruun-cleansed"],
  ),
  interaction(
    "pack-fragment",
    "moonpine-ridge",
    "heartroot-pack",
    "collect",
    "Receive the Pack fragment",
    success("fragment", { fragmentId: "heartroot-pack", sourceId: "sable" }),
    ["choice:pack-leadership"],
  ),
  interaction(
    "mist-tracks",
    "mistveil-basin",
    "mist-tracks",
    "inspect",
    "Examine the tracks in the mist",
    success("semantic-interaction", {
      kind: "inspect",
      targetId: "mist-tracks",
    }),
  ),
  interaction(
    "nyra-reveal-hidden-route",
    "mistveil-basin",
    "nyra",
    "signal",
    "Ask Nyra to reveal the hidden rootway",
    success("semantic-interaction", {
      kind: "signal",
      targetId: "mistveil-hidden-route",
    }),
    [],
    "contextual-interact",
    ["nyra"],
  ),
  interaction(
    "marek-choice",
    "mistveil-basin",
    "marek",
    "choose",
    "Choose Marek’s fate",
    success("choice", {
      choiceId: "marek-fate",
      targetId: "marek",
      optionIds: ["cleanse", "leave"],
    }),
  ),
  interaction(
    "river-source",
    "mistveil-basin",
    "river-source",
    "restore",
    "Neutralize the river source",
    success("semantic-interaction", { kind: "restore", targetId: "river-source" }),
    ["encounter-ghor-cleansed"],
    "cleanse-pulse",
    [],
    "ability",
    "press-release",
  ),
  interaction(
    "ghor-cleanse",
    "mistveil-basin",
    "ghor",
    "cleanse",
    "Cleanse Ghor",
    success("semantic-interaction", { kind: "cleanse", targetId: "ghor" }),
    [],
    "cleanse-pulse",
    [],
    "ability",
    "press-release",
  ),
  interaction(
    "shadow-fragment",
    "mistveil-basin",
    "heartroot-shadow",
    "collect",
    "Receive the Shadow fragment",
    success("fragment", { fragmentId: "heartroot-shadow", sourceId: "nyra" }),
    ["restoration:mistveil-basin:restored"],
  ),
  interaction(
    "silent-crossing",
    "sunmane-expanse",
    "silent-crossing",
    "inspect",
    "Inspect the silent crossing",
    success("semantic-interaction", {
      kind: "inspect",
      targetId: "silent-crossing",
    }),
  ),
  interaction(
    "tribute-record",
    "sunmane-expanse",
    "tribute-record",
    "inspect",
    "Read the tribute record",
    success("semantic-interaction", {
      kind: "inspect",
      targetId: "tribute-record",
    }),
  ),
  interaction(
    "solkar-offer",
    "sunmane-expanse",
    "solkar",
    "choose",
    "Answer Solkar’s offer",
    success("choice", {
      choiceId: "sunmane-resolution",
      targetId: "solkar",
      optionIds: ["bond", "exile", "dominion"],
    }),
    ["encounter-solkar-cleansed"],
  ),
  interaction(
    "crown-council",
    "sunmane-expanse",
    "crown-council",
    "choose",
    "Hear the Crown council",
    success("choice", {
      choiceId: "crown-council",
      targetId: "crown-council",
      optionIds: ["willing", "decline"],
    }),
    ["solkar-exiled"],
  ),
  interaction(
    "crown-fragment",
    "sunmane-expanse",
    "heartroot-crown",
    "collect",
    "Receive the Crown fragment",
    success("fragment", { fragmentId: "heartroot-crown", sourceId: "solkar" }),
    ["choice:sunmane-resolution"],
  ),
  {
    id: "refuge-services",
    regionId: "refuge",
    targetId: "refuge-services",
    kind: "coordinate",
    promptLabel: "Open Refuge services",
    radiusMeters: 2,
    requiresFacts: [],
    requiresActors: [],
    inputHint: "interact",
    activation: "press",
    success: success("semantic-interaction", {
      kind: "coordinate",
      targetId: "refuge-services",
    }),
    repeatable: false,
  },
  interaction(
    "refuge-training",
    "refuge",
    "refuge-training",
    "inspect",
    "Use the training space",
    success("semantic-interaction", {
      kind: "inspect",
      targetId: "refuge-training",
    }),
  ),
  interaction(
    "refuge-council",
    "refuge",
    "refuge-council",
    "choose",
    "Ask each faction about the march",
    success("choice", {
      choiceId: "chapter-seven-commitment",
      targetId: "refuge-council",
      optionIds: [
        "sky",
        "decline-sky",
        "canopy",
        "decline-canopy",
        "fang",
        "decline-fang",
        "pack",
        "decline-pack",
        "shadow",
        "decline-shadow",
        "crown",
        "decline-crown",
      ],
    }),
  ),
  interaction(
    "refuge-save",
    "refuge",
    "refuge-save",
    "inspect",
    "Open the Refuge save point",
    success("checkpoint", { checkpointId: "refuge-save" }),
  ),
  ...(["sky", "canopy", "fang", "pack", "shadow", "crown"] as const).map(
    (aspect) =>
      interaction(
        "hollow-memory-" + aspect,
        "heartroot-hollow",
        "hollow-memory-" + aspect,
        "inspect",
        "Read the " + aspect + " memory",
        success("semantic-interaction", {
          kind: "inspect",
          targetId: "hollow-memory-" + aspect,
        }),
      ),
  ),
  interaction(
    "hollow-crown-choice",
    "heartroot-hollow",
    "hollow-crown-choice",
    "choose",
    "Choose the Crown’s ending",
    success("choice", {
      choiceId: "final-ending",
      targetId: "hollow-crown-choice",
      optionIds: ["dominion", "severance", "living_pact"],
    }),
    ["orun-cleansed"],
  ),
  {
    id: "migration-gate",
    regionId: "sunmane-expanse",
    targetId: "migration-gate",
    kind: "traverse",
    promptLabel: "Open the migration gate for the herd",
    radiusMeters: 2,
    requiresFacts: [],
    requiresActors: [],
    inputHint: "interact",
    activation: "press",
    success: success("semantic-interaction", {
      kind: "traverse",
      targetId: "migration-gate",
    }),
    repeatable: false,
  },
];
function validateInteractionPlacements(): void {
  const definitions = new Map<string, InteractionDefinition>();
  for (const definition of INTERACTIONS) {
    if (definitions.has(definition.id)) {
      throw new Error("Interaction definition has duplicate id: " + definition.id);
    }
    if (!regionIds.has(definition.regionId)) {
      throw new Error("Interaction targets an unknown region: " + definition.id);
    }
    definitions.set(definition.id, definition);
  }

  const placementCounts = new Map<string, number>();
  for (const region of REGIONS) {
    for (const entity of region.entities) {
      if (entity.kind === "interaction" && !entity.interactionId) {
        throw new Error("Interaction entity lacks its canonical interaction id: " + region.id + "/" + entity.id);
      }
      if (!entity.interactionId) continue;
      const definition = definitions.get(entity.interactionId);
      if (!definition || definition.regionId !== region.id) {
        throw new Error("Region interaction has no same-region definition: " + region.id + "/" + entity.interactionId);
      }
      placementCounts.set(entity.interactionId, (placementCounts.get(entity.interactionId) ?? 0) + 1);
    }
  }
  for (const definition of INTERACTIONS) {
    if (placementCounts.get(definition.id) !== 1) {
      throw new Error("Interaction definition must have one authored placement: " + definition.id);
    }
  }
  for (const region of REGIONS) {
    requireUniqueIds(region.movableObjects.map((object) => object.id), region.id + " movable objects");
    for (const movable of region.movableObjects) {
      const props = region.props.filter((prop) => prop.id === movable.id);
      const surface = region.ground.surfaces.find((item) => item.id === movable.supportSurfaceId);
      const pointSupported = (position: typeof movable.from): boolean => {
        if (!surface?.walkable || Math.abs(position.y - surface.elevation) > 0.35) return false;
        const points = surface.points;
        let inside = false;
        for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
          const a = points[previous]!;
          const b = points[index]!;
          const cross = (position.x - a.x) * (b.z - a.z) - (position.z - a.z) * (b.x - a.x);
          if (
            Math.abs(cross) < 1e-5 &&
            position.x >= Math.min(a.x, b.x) - 1e-5 && position.x <= Math.max(a.x, b.x) + 1e-5 &&
            position.z >= Math.min(a.z, b.z) - 1e-5 && position.z <= Math.max(a.z, b.z) + 1e-5
          ) return true;
          if ((a.z > position.z) !== (b.z > position.z) &&
            position.x < ((b.x - a.x) * (position.z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
        }
        return inside;
      };
      const finitePoint = (position: typeof movable.from) =>
        [position.x, position.y, position.z].every(Number.isFinite);
      const targetActor = region.entities.find((entity) => entity.id === movable.effect.targetActorInstanceId);
      const targetDefinition = targetActor?.actorId ? ACTORS[targetActor.actorId] : undefined;
      if (
        props.length !== 1 || props[0]!.assetId !== movable.assetId ||
        props[0]!.position.x !== movable.from.x || props[0]!.position.y !== movable.from.y || props[0]!.position.z !== movable.from.z ||
        !finitePoint(movable.from) || !finitePoint(movable.to) ||
        !pointSupported(movable.from) || !pointSupported(movable.to) ||
        !Number.isFinite(movable.radiusMeters) || movable.radiusMeters <= 0 ||
        !Number.isInteger(movable.animationTicks) || movable.animationTicks <= 0 ||
        movable.requiredCompanionId !== "koro" ||
        !movable.movedFactId ||
        new Set(movable.requiredFacts).size !== movable.requiredFacts.length ||
        movable.effect.kind !== "distraction" ||
        // The target is a hostile instance or a boss participant (Asha starts hostile although her archetype is an ally).
        targetActor?.kind !== "actor" ||
        !(targetDefinition?.combatRole === "hostile" || Object.values(region.encounterParticipants).some((participants) => participants.includes(targetActor.id as never))) ||
        !Number.isFinite(movable.effect.radiusMeters) || movable.effect.radiusMeters <= 0 ||
        !Number.isInteger(movable.effect.interruptRangedWindupTicks) || movable.effect.interruptRangedWindupTicks <= 0
      ) {
        throw new Error("Movable object does not match registered prop, surface, effect, or source geometry: " + region.id + "/" + movable.id);
      }
      const koro = definitions.get(movable.koroInteractionId);
      const player = definitions.get(movable.playerInteractionId);
      const command = koro?.requiresCompanionCommand;
      const isMoveForObject = (definition: InteractionDefinition | undefined) =>
        definition?.regionId === region.id && definition.targetId === movable.id &&
        definition.kind === "move-object" && !definition.repeatable &&
        definition.success.type === "object-move" && definition.success.objectId === movable.id &&
        movable.requiredFacts.every((fact) => definition.requiresFacts.includes(fact));
      if (
        !koro || !player || !isMoveForObject(koro) || !isMoveForObject(player) ||
        command?.companionId !== movable.requiredCompanionId ||
        command.command !== "special" ||
        !koro.requiresActors.includes(movable.requiredCompanionId) ||
        koro.playerActionId !== undefined || koro.inputHint !== "ability" || koro.actionId !== undefined ||
        player.playerActionId !== "staff-heavy" || player.inputHint !== "heavy" ||
        player.activation !== "press-release" || player.requiresCompanionCommand !== undefined ||
        player.actionId !== undefined
      ) {
        throw new Error("Movable object lacks its exact companion-special and staff-heavy interactions: " + region.id + "/" + movable.id);
      }
    }
  }
 }

validateInteractionPlacements();
export const SETTINGS_COPY = {
  gamepadDeadzone: {
    label: "Stick Deadzone",
    description: "Adjust how far the stick must move before movement begins.",
  },
} as const;
