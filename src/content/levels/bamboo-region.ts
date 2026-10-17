import type { RegionDefinition } from "../../game/contracts.js";
import { buildBambooBoundaryPlacements } from "../../world/BambooBoundary.js";
import { clusterBoundaryDressing } from "../../world/clusteredBoundaryDressing.js";
import { TRAP, TRAP_DISARM_FACT } from "../../game/combat/ActOneBossContent.js";
import {
  ASHA_SHRINE_BUNDLE_MOVE, BAMBOO_ALL_SURFACES, BAMBOO_AUTHORED_FOOTPRINTS, BAMBOO_AUTHORED_PROPS, BAMBOO_CAMERA_ANCHORS, BAMBOO_DEN_ARENA, BAMBOO_NAVIGATION_NODES,
  BAMBOO_NAVIGATION_RIBBONS, BAMBOO_TRAP_POSITIONS, BAMBOO_WALL_COLLIDERS, CAMP_LOOSE_SNARE_MOVE,
} from "./bamboo-layout.js";
import { v } from "./schema.js";
import { actor, propEntity, route, target } from "./story-kit.js";

/**
 * Blood Bamboo Valley chapter region (chapter 2): west evidence loop, hunter camp, tiger trail, shrine/den arena and the return
 * to the Grove (physical plan in `bamboo-layout.ts`). Hunters are three separately addressed instances (two melee, one
 * ranged) with the candidate camp-hunter assets; Marek is a noncombat speaker; Koro and Asha are canonical actors that start
 * hostile only inside their encounters (Koro here is an ally that appears once recruited).
 */
export function createBambooChapterRegion(): RegionDefinition {
  const exits = [
    route("bamboo-canopy-out", v(-62, 0, 0), v(47, 0, 5), "whispering-canopy", "path", "contextual-traverse", ["bamboo-west-approach-collider"], "canopy-bamboo-return"),
    route("bamboo-grove-out", v(58, 0, -32), v(10, 0, 40), "the-grove", "path", "contextual-traverse", ["bamboo-grove-gateway-collider"], "bamboo-grove", "restoration:blood-bamboo-valley:restored"),
    route("bamboo-ridge-out", v(38, 0, -37), v(-74, 0, -49), "moonpine-ridge", "path", "contextual-traverse", ["bamboo-moonpine-gateway-collider"], "bamboo-ridge", "restoration:blood-bamboo-valley:restored"),
  ];
  const base: RegionDefinition = {
    id: "blood-bamboo-valley", authoringStatus: "unaccepted", name: "Blood Bamboo Valley", biome: "Bamboo terraces, poacher camp, tiger tracks and Asha's den",
    bounds: { min: v(-80, -2, -65), max: v(80, 22, 65) }, environmentRecipeId: "blood-bamboo-valley-environment",
    props: BAMBOO_AUTHORED_PROPS,
    movableObjects: [CAMP_LOOSE_SNARE_MOVE, ASHA_SHRINE_BUNDLE_MOVE],
    fieldTraps: BAMBOO_TRAP_POSITIONS.map((position, index) => ({
      id: "bamboo-trap-" + (index + 1), position, radiusMeters: TRAP.radius, disarmFact: TRAP_DISARM_FACT,
    })),
    ground: {
      y: 0, profile: "terraced", navGraphId: "blood-bamboo-valley-nav",
      surfaces: BAMBOO_ALL_SURFACES.map((entry) => entry.surface), colliders: [...BAMBOO_ALL_SURFACES.map((entry) => entry.collider), ...BAMBOO_WALL_COLLIDERS],
    },
    navigation: { nodes: BAMBOO_NAVIGATION_NODES, ribbons: BAMBOO_NAVIGATION_RIBBONS },
    cameraAnchors: BAMBOO_CAMERA_ANCHORS,
    entrances: [],
    exits,
    traversalArcs: [],
    entities: [
      actor("bamboo-vara", "vara", "actor-vara", v(-18, 0, -4), "ground"),
      actor("bamboo-koro", "koro", "actor-koro", v(-28, 0, -22), "ground", "encounter-koro-cleansed"),
      actor("hunter-melee-west", "poacher-hunter", "actor-camp-hunter-melee", v(-25, 0, -16), "ground"),
      actor("hunter-melee-east", "poacher-hunter", "actor-camp-hunter-melee", v(-3, 0, -12), "ground"),
      actor("hunter-ranged", "poacher-scout", "actor-camp-hunter-ranged", v(-14, 0, -28), "ground"),
      actor("marek", "marek", "actor-marek", v(-6, 0, -4), "ground"),
      actor("tali", "tali", "actor-tali", v(-5, 0, -9), "ground"),
      actor("asha", "asha", "actor-asha", v(38, 2, 38), "elevated"),
      ...BAMBOO_TRAP_POSITIONS.map((position, index) => propEntity("bamboo-trap-" + (index + 1), "prop-black-sap-jaw-trap", position)),
      target("bamboo-tracks", v(-50, 0, 3.5)),
      target("tali-trail", v(-44, 0, -18)),
      target("hunter-camp", v(-35, 0, -14)),
      target("camp-approach", v(-34, 0, -8)),
      target("camp-disable", v(-2, 0, -28)),
      target("koro-drop-object", v(-26, 0, -22)),
      target("player-drop-object", v(-26, 0, -22)),
      target("tali-cage", v(-5, 0, -9)),
      target("tali-refuge", v(33, 0, 15)),
      target("koro-bundle-drop", v(41, 2, 33), "elevated"),
      target("player-bundle-release", v(41, 2, 33), "elevated"),
      target("asha-cleanse", v(38, 2, 38), "elevated"),
      target("fang-fragment", v(36, 2, 34.5), "elevated"),
      target("asha-pact", v(36, 2, 36), "elevated"),
      target("snare-source", v(43.5, 2, 30.5), "elevated"),
      target("a-path-for-the-young", v(15, 0, 10)),
      target("nursery-return", v(18, 0, 16)),
    ],
    encounterIds: ["camp-hunters", "encounter-asha"],
    encounterParticipants: { "camp-hunters": ["hunter-melee-west", "hunter-melee-east", "hunter-ranged"], "encounter-asha": ["asha"] },
    restorationStates: ["unvisited", "corrupted", "partial", "restored"],
    assetIds: [],
  };
  const boundary = buildBambooBoundaryPlacements(base, { gates: [], arenas: [BAMBOO_DEN_ARENA], obstacles: BAMBOO_AUTHORED_FOOTPRINTS });
  return { ...base, props: [...BAMBOO_AUTHORED_PROPS, ...clusterBoundaryDressing(boundary)] };
}
