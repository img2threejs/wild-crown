import type { RegionDefinition } from "../../game/contracts.js";
import { buildGroveBoundaryPlacements } from "../../world/GroveBoundary.js";
import { clusterBoundaryDressing } from "../../world/clusteredBoundaryDressing.js";
import {
  GROVE_STORY_BASE_NODES, GROVE_STORY_CAMERAS, GROVE_STORY_PROPS, GROVE_STORY_RIBBONS, GROVE_STORY_SURFACES, groveFootprints,
} from "./grove-layout.js";
import { v } from "./schema.js";
import { actor, route, target } from "./story-kit.js";

/**
 * The Grove, Act I hub (the region keeps chapter 2 during the visit): the peaceful southern meadow of the shared layout
 * (`grove-layout.ts`) with no blight stages, plus the Asha den west of Yara's camp. Heartroot court and rest point in the
 * glade, Yara's tent at the camp, the practice ring as the non-rewarding training pocket, the monkey lookouts with Koro, Tali's
 * play space on the glade's east side and Asha at her den. Asha, Tali and Koro appear once the matching story fact is true,
 * under either pact option. The exits to later acts are placed on supported ground and stay locked.
 */
const NODES = GROVE_STORY_BASE_NODES.map((node) =>
  node.id === "grove-trial-camp" ? { ...node, links: [...node.links, "grove-story-den"] }
  : node.id === "grove-trial-lookouts" ? { ...node, links: [...node.links, "grove-tali-shelter"] }
  : node);
/** Chapter 6 (the Fall): Tali's cover between the monkey lookouts, on the lookout pad beside the Refuge lift. */
const TALI_SHELTER = { id: "grove-tali-shelter", position: v(25, 0, 11), links: ["grove-trial-lookouts"] };

export function createGroveChapterRegion(): RegionDefinition {
  const exits = [
    route("grove-bamboo-out", v(10, 0, 46.5), v(58, 0, -32), "blood-bamboo-valley", "path", "contextual-traverse", ["grove-trial-trailhead-collider"], "grove-bamboo-return"),
    route("grove-ridge-out", v(25, 0, 17), v(-74, 0, -49), "moonpine-ridge", "path", "contextual-traverse", ["grove-trial-lookout-pad-collider"], "grove-ridge", "choice:asha-pact"),
    route("grove-refuge-out", v(26, 0, -3), v(-27, 0, -20), "refuge", "path", "contextual-traverse", ["grove-trial-lookout-pad-collider"], "grove-refuge", "refugeOpen"),
  ];
  const base: RegionDefinition = {
    id: "the-grove", authoringStatus: "unaccepted", name: "The Grove", biome: "Heartroot sanctuary, companion reunion and restored settlement",
    bounds: { min: v(-64, 0, -60), max: v(46, 18, 58) }, environmentRecipeId: "the-grove-environment",
    props: GROVE_STORY_PROPS,
    movableObjects: [],
    ground: {
      y: 0, profile: "canopy", navGraphId: "the-grove-nav",
      surfaces: GROVE_STORY_SURFACES.map((entry) => entry.surface), colliders: GROVE_STORY_SURFACES.map((entry) => entry.collider),
    },
    navigation: {
      nodes: [...NODES, { id: "grove-story-den", position: v(-40, 0, 8), links: ["grove-trial-camp"] }, TALI_SHELTER],
      ribbons: [...GROVE_STORY_RIBBONS, { id: "grove-story-den-route", points: [v(-22, 0, 3), v(-40, 0, 8)], width: 2.6, depthBand: "ground" }],
    },
    cameraAnchors: GROVE_STORY_CAMERAS,
    entrances: [],
    exits,
    traversalArcs: [route("grove-refuge", v(26, 0, -3), v(-27, 0, -20), "refuge", "path", "contextual-traverse", ["grove-trial-lookout-pad-collider"], "grove-refuge", "refugeOpen")],
    entities: [
      actor("grove-vara", "vara", "actor-vara", v(12, 0, 24), "canopy"),
      actor("yara", "yara", "actor-yara", v(-26, 0, 9), "ground"),
      actor("koro", "koro", "actor-koro", v(28.5, 0, 5), "ground", "choice:koro-pact"),
      actor("asha", "asha", "actor-asha", v(-42, 0, 8), "ground", "choice:asha-pact"),
      actor("tali", "tali", "actor-tali", v(12, 0, 10), "ground", "taliInGrove"),
      // Chapter 6: Orun breaks through the glade beside the young Heartroot once Aren answers the Root Crown's call.
      actor("orun", "orun", "actor-orun", v(4, 0, 1), "ground", "interaction:warden-call"),
      target("grove-heartroot", v(3, 0, -4)),
      target("grove-heartroot-rest", v(6.5, 0, -3)),
      target("grove-council", v(10, 0, -3)),
      target("grove-pillar", v(14, 0, -3)),
      target("grove-services", v(-20, 0, 0)),
      target("warden-call", v(-16, 0, 0)),
      target("grove-yara-tent", v(-26, 0, 7)),
      target("grove-training", v(-24, 0, -22)),
      target("refuge-lift", v(24, 0, -2)),
      target("grove-tali-rescue", v(11, 0, 8)),
      target("chapter-six-response", v(-20, 0, 2)),
    ],
    encounterIds: ["encounter-fall"],
    encounterParticipants: { "encounter-fall": ["orun"] },
    restorationStates: ["unvisited", "corrupted", "partial", "restored"],
    assetIds: [],
  };
  const boundary = buildGroveBoundaryPlacements(base, { gates: [], arenas: [], obstacles: groveFootprints(GROVE_STORY_PROPS) });
  return { ...base, props: [...GROVE_STORY_PROPS, ...clusterBoundaryDressing(boundary)] };
}
