import type {
  ActorDefinition,
  InteractionActivation,
  InteractionDefinition,
  InteractionInputHint,
  InteractionSuccess,
  RegionEntityDefinition,
  RegionFieldTrapDefinition,
  RegionDeliveryDefinition,
  RegionId,
  RegionRouteDefinition,
  Vec3,
} from "../game/contracts.js";

/**
 * Optional-quest content authoring: 12 pairs of evidence + action interactions.
 * Action event alignment:
 *   1. the-empty-nest         ecology:nest-branch          hub:bird-roost
 *   2. the-last-cub           rescue:nursery-cub (safe arrival) side:nursery-safe
 *   3. a-pack-divided         ecology:shared-hunt          side:shared-hunt
 *   4. the-silent-hunter      ecology:protected-corridor   side:protected-corridor
 *   5. a-king-without-subjects choice:solkar-listens        side:crown-refusal
 *   6. river-of-black-sap     ecology:tributary-filter     side:river-cleared (prerequisite choice:river-route)
 *   7. the-hunters-remorse    ecology:trap-line-neutralized side:trap-line-cleared
 *   8. seeds-between-branches ecology:seed-exchange         hub:seed-nursery
 *   9. the-broken-snare-trail ecology:snare-supply          side:snare-supply-cleared
 *  10. winter-stores          ecology:winter-cache          side:winter-cache
 *  11. the-last-crossing      traversal:herd-crossing       side:herd-passage
 *  12. roots-we-share         ecology:shared-refuge-stations hub:refuge-garden
 *
 * Authority notes:
 *  - The last-cub initiating interaction lives at NURSERY_ESCORT.from, requires the nursery-cub actor, and only
 *    flags the escort start; Main emits the actual rescue event on safe arrival at the shelter.
 *  - The river quest keeps the irreversible main `choice:river-route` as its own prerequisite, with a distinct
 *    `ecology:tributary-filter` final objective whose action actually cleanses the tributary filter drum.
 *  - The last-crossing action only flags corridor readiness (semantic coordinate, target `herd-crossing-ready`).
 *    HERD_CROSSING_ROUTE unlocks on `interaction:the-last-crossing-action`; only HERD_RETURN_ROUTE uses
 *    `side:herd-passage`. The actual `traversal:herd-crossing` event comes from the engine traversal gate.
 */

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

/** Typed factory that the compiler can audit; no `as never`. */
const semantic = (kind: InteractionDefinition["kind"], targetId: string): InteractionSuccess => ({
  type: "semantic-interaction",
  kind,
  targetId,
});

const HEAVY: { actionId: string; inputHint: InteractionInputHint; activation: InteractionActivation } = {
  actionId: "staff-heavy",
  inputHint: "heavy",
  activation: "press-release",
};

const CLEANSE: { actionId: string; inputHint: InteractionInputHint; activation: InteractionActivation } = {
  actionId: "cleanse-pulse",
  inputHint: "ability",
  activation: "press-release",
};

const acceptedFact = (questId: string): string => `quest:${questId}:accepted`;
const evidenceFact = (questId: string): string => `interaction:${questId}-evidence`;


export const SIDE_QUEST_DELIVERIES: Partial<Record<RegionId, readonly RegionDeliveryDefinition[]>> = {
  "whispering-canopy": [
    {
      id: "canopy-bird-seed-basket", assetId: "prop-seed-supply-basket", questId: "seeds-between-branches",
      from: v(11, 4, -42), to: v(18, 4, -39), supportSurfaceId: "canopy-trial-seed-alcove",
      pickupInteractionId: "canopy-bird-seeds-pickup", deliveryInteractionId: "canopy-bird-seeds-deliver",
      movedFactId: "interaction:canopy-bird-seeds-deliver",
      requiredFacts: [acceptedFact("seeds-between-branches"), evidenceFact("seeds-between-branches")],
    },
    {
      id: "canopy-monkey-seed-basket", assetId: "prop-seed-supply-basket", questId: "seeds-between-branches",
      from: v(18, 4, -42), to: v(11, 4, -39), supportSurfaceId: "canopy-trial-seed-alcove",
      pickupInteractionId: "canopy-monkey-seeds-pickup", deliveryInteractionId: "canopy-monkey-seeds-deliver",
      movedFactId: "interaction:canopy-monkey-seeds-deliver",
      requiredFacts: [acceptedFact("seeds-between-branches"), evidenceFact("seeds-between-branches"), "interaction:canopy-bird-seeds-deliver"],
    },
  ],
  "moonpine-ridge": [{
    id: "moonpine-winter-supplies", assetId: "prop-seed-supply-basket", questId: "winter-stores",
    from: v(-20, 8, 4), to: v(-20, 8, 11.5), supportSurfaceId: "moonpine-ridge-chain-ledge",
    pickupInteractionId: "moonpine-winter-supplies-pickup", deliveryInteractionId: "moonpine-winter-supplies-deliver",
    movedFactId: "interaction:moonpine-winter-supplies-deliver",
    requiredFacts: [acceptedFact("winter-stores"), evidenceFact("winter-stores")],
  }],
};

export const SIDE_QUEST_DELIVERY_INTERACTIONS: readonly InteractionDefinition[] = Object.entries(SIDE_QUEST_DELIVERIES).flatMap(([regionId, deliveries]) =>
  deliveries.flatMap(delivery => (["pick-up", "deliver"] as const).map(phase => ({
    id: phase === "pick-up" ? delivery.pickupInteractionId : delivery.deliveryInteractionId,
    regionId: regionId as RegionId, questId: delivery.questId, targetId: delivery.id, kind: "move-object" as const,
    promptLabel: `${phase === "pick-up" ? "Pick up" : "Deliver"} ${delivery.id === "canopy-bird-seed-basket" ? "the bird seed basket" : delivery.id === "canopy-monkey-seed-basket" ? "the monkey seed basket" : "the winter supplies"}`,
    radiusMeters: 2, requiresFacts: delivery.requiredFacts, requiresActors: [], inputHint: "interact" as const,
    activation: "press" as const, repeatable: false,
    success: { type: "carry-object" as const, objectId: delivery.id, phase },
  }))),
);
interface AuthoredSite {
  readonly interaction: InteractionDefinition;
  readonly placement: RegionEntityDefinition;
}

function evidence(
  questId: string,
  regionId: RegionId,
  position: Vec3,
  placement: RegionEntityDefinition["placement"],
  promptLabel: string,
): AuthoredSite {
  const placementId = `${questId}-evidence`;
  return {
    interaction: {
      id: placementId,
      regionId,
      questId,
      targetId: questId,
      kind: "inspect",
      promptLabel,
      radiusMeters: 2,
      requiresFacts: [acceptedFact(questId)],
      requiresActors: [],
      inputHint: "interact",
      activation: "press",
      success: semantic("inspect", questId),
      repeatable: false,
    },
    placement: { id: placementId, kind: "interaction", position, placement, interactionId: placementId },
  };
}

interface ActionOptions {
  readonly actionId?: string;
  readonly inputHint?: InteractionInputHint;
  readonly activation?: InteractionActivation;
  readonly extraRequires?: readonly string[];
  readonly requiresActors?: readonly string[];
}

function action(
  questId: string,
  regionId: RegionId,
  position: Vec3,
  placement: RegionEntityDefinition["placement"],
  semanticTarget: string,
  interactionTarget: string,
  promptLabel: string,
  successKind: "coordinate" | "break" | "repair" | "rescue" | "traverse" | "restore" | "choose",
  successExtra: {
    readonly routeId?: string;
    readonly choiceId?: string;
    readonly optionIds?: readonly string[];
    readonly locationId?: string;
  } = {},
  options: ActionOptions = {},
): AuthoredSite {
  const placementId = `${questId}-action`;
  const requiresFacts: readonly string[] = [
    acceptedFact(questId),
    evidenceFact(questId),
    ...(options.extraRequires ?? []),
  ];
  let successObject: InteractionSuccess;
  let interactionKind: InteractionDefinition["kind"];
  switch (successKind) {
    case "rescue":
      interactionKind = "rescue";
      successObject = {
        type: "rescue",
        targetId: semanticTarget,
        locationId: successExtra.locationId ?? "nursery-shelter",
      };
      break;
    case "traverse":
      interactionKind = "traverse";
      successObject = {
        type: "traversal",
        routeId: successExtra.routeId ?? semanticTarget,
        fromRegion: regionId,
        toRegion: regionId,
        landmarkId: successExtra.routeId ?? semanticTarget,
      };
      break;
    case "choose":
      interactionKind = "choose";
      successObject = {
        type: "choice",
        choiceId: successExtra.choiceId ?? semanticTarget,
        targetId: semanticTarget,
        optionIds: successExtra.optionIds ?? [],
      };
      break;
    case "restore":
      interactionKind = "restore";
      successObject = semantic("restore", semanticTarget);
      break;
    case "repair":
    case "break":
    case "coordinate":
      interactionKind = successKind;
      successObject = semantic(successKind, semanticTarget);
      break;
  }
  return {
    interaction: {
      id: placementId,
      regionId,
      questId,
      targetId: interactionTarget,
      kind: interactionKind,
      promptLabel,
      radiusMeters: 2,
      ...(options.actionId !== undefined ? { actionId: options.actionId } : {}),
      requiresFacts,
      ...(options.requiresActors !== undefined ? { requiresActors: options.requiresActors } : { requiresActors: [] }),
      ...(options.inputHint !== undefined ? { inputHint: options.inputHint } : {}),
      ...(options.activation !== undefined ? { activation: options.activation } : {}),
      success: successObject,
      repeatable: false,
    },
    placement: { id: placementId, kind: "interaction", position, placement, interactionId: placementId },
  };
}

// 1. the-empty-nest (whispering-canopy) — Heavy repair of the Heartroot branch.
// evidence: target=the-empty-nest (the quest), inspect.
// action: target=nest-branch (the actual nest), repair kind, semantic targetId=nest-branch, HEAVY.
const emptyNestEvidence = evidence(
  "the-empty-nest",
  "whispering-canopy",
  v(-19, 4, -28),
  "elevated",
  "Read the broken Heartroot branch and the feather caught on it",
);
const emptyNestAction = action(
  "the-empty-nest",
  "whispering-canopy",
  v(-15, 4, -28),
  "elevated",
  "nest-branch",
  "nest-branch",
  "Brace the broken Heartroot branch with a heavy strike",
  "repair",
  {},
  { actionId: HEAVY.actionId, inputHint: HEAVY.inputHint, activation: HEAVY.activation },
);
const EMPTY_NEST_ENTITIES: readonly RegionEntityDefinition[] = [
  emptyNestEvidence.placement,
  emptyNestAction.placement,
];

// 2. the-last-cub (blood-bamboo-valley) — escort initiator at NURSERY_ESCORT.from requires the nursery-cub.
// Main emits the rescue event on safe arrival at the shelter.
export const NURSERY_ESCORT = {
  interactionId: "the-last-cub-action",
  actorId: "nursery-cub",
  regionId: "blood-bamboo-valley" as const,
  from: v(-60, 0, 5),
  to: v(-44, 0, -18),
  arrivalRadiusMeters: 1.5,
} as const;

const lastCubEvidence = evidence(
  "the-last-cub",
  "blood-bamboo-valley",
  v(-58, 0, 6.5),
  "ground",
  "Read the tracks that lead away from the nursery cage",
);
// The engine intercepts this rescue intent and emits success only after the cub reaches safe cover.
const lastCubInitiator = action(
  "the-last-cub",
  "blood-bamboo-valley",
  v(-60, 0, 5),
  "ground",
  "nursery-cub",
  "nursery-cub",
  "Call the nursery cub over to follow you along the safe corridor",
  "rescue",
  { locationId: "nursery-shelter" },
  { requiresActors: ["nursery-cub"] },
);
const LAST_CUB_ENTITIES: readonly RegionEntityDefinition[] = [
  lastCubEvidence.placement,
  lastCubInitiator.placement,
  {
    id: "nursery-cub",
    actorId: "nursery-cub",
    kind: "actor",
    position: v(-60, 0, 5),
    assetId: "actor-nursery-cub",
    placement: "ground",
  },
];

// 3. a-pack-divided (moonpine-ridge) — coordinate shared patrol through existing Moonpine nav anchors.
const packDividedEvidence = evidence(
  "a-pack-divided",
  "moonpine-ridge",
  v(-46, 3, -28),
  "ground",
  "Listen at the divide between the two patrols",
);
const packDividedAction = action(
  "a-pack-divided",
  "moonpine-ridge",
  v(-39, 3, -24),
  "ground",
  "shared-hunt",
  "shared-hunt",
  "Mark the shared patrol route through both packs’ ground",
  "coordinate",
);
const PACK_DIVIDED_ENTITIES: readonly RegionEntityDefinition[] = [
  packDividedEvidence.placement,
  packDividedAction.placement,
];

export const PACK_PATROL_ACTOR_IDS = ["ridge-elder-scout", "ridge-young-scout"] as const;
export const SHARED_HUNT_ROUTE: RegionRouteDefinition = {
  id: "moonpine-shared-hunt-route",
  from: v(-74, 0, -49),
  to: v(-39, 3, -24),
  anchors: [v(-74, 0, -49), v(-63, 0, -52), v(-51, 0, -42), v(-39, 3, -24)],
  destinationRegionId: "moonpine-ridge",
  kind: "path",
  traversalActionId: "contextual-traverse",
  traversal: { kind: "walk", durationTicks: 960, startRadius: 2 },
  colliderIds: ["moonpine-ridge-ground-collider", "moonpine-ridge-lower-shelf-collider"],
  unlockFact: "side:shared-hunt",
  traversalEvent: "moonpine-shared-hunt",
};

// 4. the-silent-hunter (mistveil-basin) — coordinate protected corridor through the reed channel.
const silentHunterEvidence = evidence(
  "the-silent-hunter",
  "mistveil-basin",
  v(-50, 0, -18),
  "ground",
  "Read the panther marks at the reed channel",
);
const silentHunterAction = action(
  "the-silent-hunter",
  "mistveil-basin",
  v(-50, 0, -14),
  "ground",
  "protected-corridor",
  "protected-corridor",
  "Mark the protected corridor for passage, not ownership",
  "coordinate",
);
const SILENT_HUNTER_ENTITIES: readonly RegionEntityDefinition[] = [
  silentHunterEvidence.placement,
  silentHunterAction.placement,
];

// 5. a-king-without-subjects (sunmane-expanse) — choice at the council terrace; new council-mediation option.
const kingWithoutSubjectsEvidence = evidence(
  "a-king-without-subjects",
  "sunmane-expanse",
  v(33, 9, -3),
  "elevated",
  "Stand at the council terrace and let Solkar or his envoy hear the refusal",
);
const kingWithoutSubjectsAction = action(
  "a-king-without-subjects",
  "sunmane-expanse",
  v(35, 9, -1),
  "elevated",
  "solkar-listens",
  "solkar-listens",
  "Choose to listen, or mediate through the council when Solkar is absent",
  "choose",
  { choiceId: "solkar-listens", optionIds: ["listen", "council-mediation"] },
  { extraRequires: ["choice:sunmane-resolution"] },
);
const KING_WITHOUT_SUBJECTS_ENTITIES: readonly RegionEntityDefinition[] = [
  kingWithoutSubjectsEvidence.placement,
  kingWithoutSubjectsAction.placement,
];

// 6. river-of-black-sap (mistveil-basin) — Cleanse the tributary filter after the main river-route choice.
const riverOfBlackSapEvidence = evidence(
  "river-of-black-sap",
  "mistveil-basin",
  v(22, 0, -2),
  "ground",
  "Inspect the tributary filter drum upstream of the chosen route",
);
// Target is the tributary filter drum (native prop in the existing region); semantic targetId drives the event.
const riverOfBlackSapAction = action(
  "river-of-black-sap",
  "mistveil-basin",
  v(20, 0, -4),
  "ground",
  "tributary-filter",
  "tributary-filter",
  "Cleanse the tributary filter drum after the river route is settled",
  "restore",
  {},
  {
    actionId: CLEANSE.actionId,
    inputHint: CLEANSE.inputHint,
    activation: CLEANSE.activation,
    extraRequires: ["choice:river-route"],
  },
);
const RIVER_OF_BLACK_SAP_ENTITIES: readonly RegionEntityDefinition[] = [
  riverOfBlackSapEvidence.placement,
  riverOfBlackSapAction.placement,
];

// 7. the-hunters-remorse (mistveil-basin) — Heavy breaks trap line from field ledger; Marek never required.
const huntersRemorseEvidence = evidence(
  "the-hunters-remorse",
  "mistveil-basin",
  v(8, 0, 0),
  "ground",
  "Read the field ledger that marks every trap line",
);
const huntersRemorseAction = action(
  "the-hunters-remorse",
  "mistveil-basin",
  v(18, 0, -10),
  "ground",
  "trap-line-neutralized",
  "trap-line-neutralized",
  "Disable the trap-line supply with a heavy strike",
  "break",
  {},
  { actionId: HEAVY.actionId, inputHint: HEAVY.inputHint, activation: HEAVY.activation },
);
export const MAREK_ASSISTANCE = {
  interactionId: "the-hunters-remorse-assist",
  path: [v(8, 0, -3), v(18, 0, -3), v(18, 0, -10)],
} as const;
const HUNTERS_REMORSE_ENTITIES: readonly RegionEntityDefinition[] = [
  huntersRemorseEvidence.placement,
  huntersRemorseAction.placement,
  { id: MAREK_ASSISTANCE.interactionId, kind: "interaction", position: MAREK_ASSISTANCE.path[0], placement: "ground", interactionId: MAREK_ASSISTANCE.interactionId },
];

const huntersRemorseAssistance: InteractionDefinition = {
  id: MAREK_ASSISTANCE.interactionId, regionId: "mistveil-basin", questId: "the-hunters-remorse",
  targetId: "marek", kind: "break", promptLabel: "Ask Marek to dismantle the trap-line supply",
  radiusMeters: 2, requiresFacts: [acceptedFact("the-hunters-remorse"), evidenceFact("the-hunters-remorse"), "choice:marek-fate", "marekPresent"],
  requiresActors: ["marek"], inputHint: "interact", activation: "press", repeatable: false,
  success: semantic("break", "trap-line-neutralized"),
};

const HUNTERS_REMORSE_FIELD_TRAPS: readonly RegionFieldTrapDefinition[] = [
  { id: "mistveil-hunters-remorse-trap-1", position: v(-2, 0, -8), radiusMeters: 1.2, disarmFact: "side:trap-line-cleared" },
  { id: "mistveil-hunters-remorse-trap-2", position: v(8, 0, -6), radiusMeters: 1.2, disarmFact: "side:trap-line-cleared" },
  { id: "mistveil-hunters-remorse-trap-3", position: v(18, 0, -1), radiusMeters: 1.2, disarmFact: "side:trap-line-cleared" },
];

// 8. seeds-between-branches (whispering-canopy) — coordinate seed exchange on the seed alcove.
const seedsBetweenBranchesEvidence = evidence(
  "seeds-between-branches",
  "whispering-canopy",
  v(11, 4, -39),
  "elevated",
  "Check the seed basket counts at the alcove",
);
const seedsBetweenBranchesAction = action(
  "seeds-between-branches",
  "whispering-canopy",
  v(15, 4, -41),
  "elevated",
  "seed-exchange",
  "seed-exchange",
  "Confirm the balanced seed exchange",
  "coordinate",
  {},
  { extraRequires: ["interaction:canopy-bird-seeds-deliver", "interaction:canopy-monkey-seeds-deliver"] },
);
const SEEDS_BETWEEN_BRANCHES_ENTITIES: readonly RegionEntityDefinition[] = [
  seedsBetweenBranchesEvidence.placement,
  seedsBetweenBranchesAction.placement,
];

// 9. the-broken-snare-trail (blood-bamboo-valley) — Heavy breaks the snare-supply.
const brokenSnareTrailEvidence = evidence(
  "the-broken-snare-trail",
  "blood-bamboo-valley",
  v(-32, 0, -28),
  "ground",
  "Read the snare-supply map on the long path",
);
const brokenSnareTrailAction = action(
  "the-broken-snare-trail",
  "blood-bamboo-valley",
  v(-26, 0, -24),
  "ground",
  "snare-supply",
  "snare-supply",
  "Break the snare-supply chain with a heavy strike",
  "break",
  {},
  { actionId: HEAVY.actionId, inputHint: HEAVY.inputHint, activation: HEAVY.activation },
);
const BROKEN_SNARE_TRAIL_ENTITIES: readonly RegionEntityDefinition[] = [
  brokenSnareTrailEvidence.placement,
  brokenSnareTrailAction.placement,
];

const BROKEN_SNARE_TRAIL_FIELD_TRAPS: readonly RegionFieldTrapDefinition[] = [
  { id: "bamboo-broken-snare-trail-trap-1", position: v(34, 0, -2), radiusMeters: 1.2, disarmFact: "side:snare-supply-cleared" },
  { id: "bamboo-broken-snare-trail-trap-2", position: v(40, 0, -10), radiusMeters: 1.2, disarmFact: "side:snare-supply-cleared" },
  { id: "bamboo-broken-snare-trail-trap-3", position: v(48, 0, -18), radiusMeters: 1.2, disarmFact: "side:snare-supply-cleared" },
];

// 10. winter-stores (moonpine-ridge) — coordinate the wind-sheltered winter cache.
const winterStoresEvidence = evidence(
  "winter-stores",
  "moonpine-ridge",
  v(-26, 8, 6),
  "elevated",
  "Survey the exposed cache on the temple shelf",
);
const winterStoresAction = action(
  "winter-stores",
  "moonpine-ridge",
  v(-24, 8, 8),
  "elevated",
  "winter-cache",
  "winter-cache",
  "Coordinate the wind-sheltered winter cache",
  "coordinate",
  {},
  { extraRequires: ["interaction:moonpine-winter-supplies-deliver", "side:shared-hunt"] },
);
const WINTER_STORES_ENTITIES: readonly RegionEntityDefinition[] = [
  winterStoresEvidence.placement,
  winterStoresAction.placement,
];

// 11. the-last-crossing (sunmane-expanse) — action only flags corridor readiness; engine emits traversal event.
const lastCrossingEvidence = evidence(
  "the-last-crossing",
  "sunmane-expanse",
  v(-58, 2, -17),
  "elevated",
  "Read the migration marks at the gate",
);
const lastCrossingAction = action(
  "the-last-crossing",
  "sunmane-expanse",
  v(-56, 2, -17),
  "elevated",
  "herd-crossing-ready",
  "herd-crossing-ready",
  "Mark the migration corridor ready for the herd",
  "coordinate",
  {},
  { extraRequires: ["interaction:migration-gate"] },
);
const HERD_CROSSING_ROUTE: RegionRouteDefinition = {
  id: "herd-crossing",
  from: v(-58, 2, -17),
  to: v(-29, 2, -18),
  anchors: [v(-58, 2, -17), v(-52, 2, -28), v(-40, 2, -32), v(-29, 2, -18)],
  destinationRegionId: "sunmane-expanse",
  kind: "gate",
  traversalActionId: "contextual-traverse",
  traversal: { kind: "walk", durationTicks: 860, startRadius: 2 },
  colliderIds: ["sunmane-expanse-migration-terrace-collider"],
  unlockFact: "interaction:the-last-crossing-action",
  traversalEvent: "herd-crossing",
};
const HERD_RETURN_ROUTE: RegionRouteDefinition = {
  id: "sunmane-herd-return",
  from: v(-29, 2, -18),
  to: v(-56, 2, -17),
  anchors: [v(-29, 2, -18), v(-40, 2, -32), v(-52, 2, -28), v(-56, 2, -17)],
  destinationRegionId: "sunmane-expanse",
  kind: "gate",
  traversalActionId: "contextual-traverse",
  traversal: { kind: "walk", durationTicks: 850, startRadius: 2 },
  colliderIds: ["sunmane-expanse-migration-terrace-collider"],
  unlockFact: "side:herd-passage",
  traversalEvent: "sunmane-herd-return",
};
const LAST_CROSSING_ENTITIES: readonly RegionEntityDefinition[] = [
  lastCrossingEvidence.placement,
  lastCrossingAction.placement,
];

// Post-Fall rebuilding lives at the reachable Refuge, never in the destroyed Grove.
const rootsWeShareEvidence = evidence(
  "roots-we-share",
  "refuge",
  v(-17, 1.5, -7),
  "elevated",
  "Survey the relocated water and training stations",
);
const rootsWeShareAction = action(
  "roots-we-share",
  "refuge",
  v(-14, 1.5, 0),
  "elevated",
  "shared-refuge-stations",
  "shared-refuge-stations",
  "Coordinate the shared refuge stations for the Wild March",
  "coordinate",
  {},
  { extraRequires: ["refugeOpen"] },
);
const ROOTS_WE_SHARE_ENTITIES: readonly RegionEntityDefinition[] = [
  rootsWeShareEvidence.placement,
  rootsWeShareAction.placement,
];

export const SIDE_QUEST_INTERACTIONS: readonly InteractionDefinition[] = [
  emptyNestEvidence.interaction,
  emptyNestAction.interaction,
  lastCubEvidence.interaction,
  lastCubInitiator.interaction,
  packDividedEvidence.interaction,
  packDividedAction.interaction,
  silentHunterEvidence.interaction,
  silentHunterAction.interaction,
  kingWithoutSubjectsEvidence.interaction,
  kingWithoutSubjectsAction.interaction,
  riverOfBlackSapEvidence.interaction,
  riverOfBlackSapAction.interaction,
  huntersRemorseEvidence.interaction,
  huntersRemorseAction.interaction,
  huntersRemorseAssistance,
  seedsBetweenBranchesEvidence.interaction,
  seedsBetweenBranchesAction.interaction,
  brokenSnareTrailEvidence.interaction,
  brokenSnareTrailAction.interaction,
  winterStoresEvidence.interaction,
  winterStoresAction.interaction,
  lastCrossingEvidence.interaction,
  lastCrossingAction.interaction,
  rootsWeShareEvidence.interaction,
  rootsWeShareAction.interaction,
];

export const SIDE_QUEST_ENTITIES: Partial<Record<RegionId, readonly RegionEntityDefinition[]>> = {
  "whispering-canopy": [
    ...EMPTY_NEST_ENTITIES, ...SEEDS_BETWEEN_BRANCHES_ENTITIES,
    ...[v(35, 0, 5), v(39, 0, 5)].map((position, index) => ({
      id: `orchard-roost-bird-${index}`, actorId: "roost-hornbill", assetId: "actor-roost-hornbill",
      kind: "actor" as const, position, placement: "ground" as const, visibleWhen: "hub:bird-roost",
    })),
  ],
  "blood-bamboo-valley": [...LAST_CUB_ENTITIES, ...BROKEN_SNARE_TRAIL_ENTITIES],
  "moonpine-ridge": [
    ...PACK_DIVIDED_ENTITIES, ...WINTER_STORES_ENTITIES,
    ...PACK_PATROL_ACTOR_IDS.map((id, index) => ({
      id, actorId: id, assetId: `actor-${id}`, kind: "actor" as const,
      position: v(-74 - index * 1.5, 0, -49), placement: "ground" as const, visibleWhen: "side:shared-hunt",
    })),
  ],
  "mistveil-basin": [...SILENT_HUNTER_ENTITIES, ...RIVER_OF_BLACK_SAP_ENTITIES, ...HUNTERS_REMORSE_ENTITIES],
  "sunmane-expanse": [...KING_WITHOUT_SUBJECTS_ENTITIES, ...LAST_CROSSING_ENTITIES],
  refuge: ROOTS_WE_SHARE_ENTITIES,
  "the-grove": [v(-3, 0, 16), v(-5, 0, 18)].map((position, index) => ({
    id: `grove-roost-bird-${index}`, actorId: "roost-hornbill", assetId: "actor-roost-hornbill",
    kind: "actor" as const, position, placement: "ground" as const, visibleWhen: "hub:bird-roost",
  })),
};

export const SIDE_QUEST_ROUTES: Partial<Record<RegionId, readonly RegionRouteDefinition[]>> = {
  "moonpine-ridge": [SHARED_HUNT_ROUTE],
  "sunmane-expanse": [HERD_CROSSING_ROUTE, HERD_RETURN_ROUTE],
  "mistveil-basin": [
    {
      id: "mistveil-flood-detour", from: v(-52, 0, -20), to: v(-25, 1, -10),
      anchors: [v(-52, 0, -20), v(-25, 1, -10)],
      destinationRegionId: "mistveil-basin", kind: "path", traversalActionId: "contextual-traverse",
      traversal: { kind: "walk", durationTicks: 576, startRadius: 2 },
      colliderIds: ["mistveil-basin-reed-bank-collider", "mistveil-basin-river-isle-collider"],
      unlockFact: "side:river-flood-detour", traversalEvent: "mistveil-flood-detour",
    },
    {
      id: "mistveil-repaired-bank", from: v(-25, 1, -10), to: v(25, 0, 7),
      anchors: [v(-25, 1, -10), v(8, 0, -3), v(25, 0, 7)],
      destinationRegionId: "mistveil-basin", kind: "path", traversalActionId: "contextual-traverse",
      traversal: { kind: "walk", durationTicks: 1068, startRadius: 2 },
      colliderIds: ["mistveil-basin-river-isle-collider", "mistveil-basin-extraction-bank-collider"],
      unlockFact: "side:river-bank-open", traversalEvent: "mistveil-repaired-bank",
    },
  ],
};

export const SIDE_QUEST_FIELD_TRAPS: Partial<Record<RegionId, readonly RegionFieldTrapDefinition[]>> = {
  "mistveil-basin": HUNTERS_REMORSE_FIELD_TRAPS,
  "blood-bamboo-valley": BROKEN_SNARE_TRAIL_FIELD_TRAPS,
};

export const SIDE_QUEST_ACTORS: Readonly<Record<string, ActorDefinition>> = {
  "nursery-cub": {
    id: "nursery-cub", species: "tiger-cub", role: "cub", allegiance: "ally",
    combatRole: "noncombat", assetId: "actor-nursery-cub",
  },
  "roost-hornbill": {
    id: "roost-hornbill", species: "hornbill", role: "wild", allegiance: "neutral",
    combatRole: "noncombat", assetId: "actor-roost-hornbill",
  },
  "ridge-elder-scout": {
    id: "ridge-elder-scout", species: "wolf", role: "wild", allegiance: "ally",
    combatRole: "noncombat", assetId: "actor-ridge-elder-scout",
  },
  "ridge-young-scout": {
    id: "ridge-young-scout", species: "wolf", role: "wild", allegiance: "ally",
    combatRole: "noncombat", assetId: "actor-ridge-young-scout",
  },
};
