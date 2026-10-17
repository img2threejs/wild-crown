import type { RegionDefinition, Vec3, WorldAssetPlacement } from "../../game/contracts.js";
import { camera, flat, placement, ramp, type NavNode, type NavRibbon, type WalkSurface } from "./layout-kit.js";
import { v } from "./schema.js";

/**
 * Whispering Canopy physical layout shared by the combat trials (`CanopyTrialRegion`) and the Act I chapter region
 * (`act-i.ts`): a walk-mesh from the waterfall basin over two vine bridges to the temple courtyard and its exit path.
 * Trial gates, trial monsters and the trial exit are trial overlays; story interactions, entities and routes are chapter
 * overlays. `CANOPY_STORY_*` adds the two short side branches only the chapter uses; the base geometry is unchanged, so
 * every Trial coordinate stays exactly as shipped. Surface ids keep the `canopy-trial-` prefix because the Canopy biome
 * recognises a Canopy walk-mesh by it.
 */
export const CANOPY_EARTH = "canopy-trail-earth";
export const CANOPY_BRIDGE_DECK = "canopy-bridge-deck";
const FLOOR_THICKNESS = 0.45;
const DECK_THICKNESS = 0.3;
/** The vine-bridge model is about 12 m long along local +z; the placement scale stretches it to the authored span. */
const BRIDGE_MODEL_LENGTH = 12;
/** Conservative plan-view footprints (metres, at placement scale 1) of authored set dressing, handed to the boundary builder. */
export const CANOPY_TREE_FOOTPRINT_RADIUS = 4;
export const CANOPY_SHRINE_FOOTPRINT_RADIUS = 7.5;

const earthRamp = (id: string, points: readonly Vec3[]): WalkSurface => ramp(id, CANOPY_EARTH, FLOOR_THICKNESS, points);

export const CANOPY_WALK_SURFACES: readonly WalkSurface[] = [
  // Start basin and Arena 1 (the waterfall pool lies beyond its south-west edge and is not walkable).
  flat("canopy-trial-basin", "terrace", CANOPY_EARTH, FLOOR_THICKNESS, [v(-54, 0, -40), v(-40, 0, -40), v(-36, 0, -34), v(-36, 0, -22), v(-42, 0, -16), v(-58, 0, -16), v(-64, 0, -22), v(-64, 0, -31), v(-56, 0, -33)]),
  earthRamp("canopy-trial-root-stair", [v(-36, 0, -31), v(-24, 4, -31), v(-24, 4, -25), v(-36, 0, -25)]),
  flat("canopy-trial-fig-ledge", "terrace", CANOPY_EARTH, DECK_THICKNESS, [v(-24, 4, -34), v(-14, 4, -34), v(-14, 4, -22), v(-24, 4, -22)]),
  flat("canopy-trial-gorge-bridge", "canopy", CANOPY_BRIDGE_DECK, DECK_THICKNESS, [v(-14, 4, -30), v(-4, 4, -30), v(-4, 4, -27), v(-14, 4, -27)]),
  // Roost cliff top and Arena 2.
  flat("canopy-trial-roost", "terrace", CANOPY_EARTH, DECK_THICKNESS, [v(-4, 4, -38), v(12, 4, -38), v(14, 4, -24), v(12, 4, -14), v(-4, 4, -14)]),
  flat("canopy-trial-chasm-bridge", "canopy", CANOPY_BRIDGE_DECK, DECK_THICKNESS, [v(13, 4, -25), v(24, 4, -25), v(24, 4, -22), v(13, 4, -22)]),
  earthRamp("canopy-trial-temple-descent", [v(24, 4, -27), v(38, 0, -27), v(38, 0, -18), v(24, 4, -18)]),
  // Temple courtyard (Arena 3, a flat octagon) and the exit path.
  flat("canopy-trial-courtyard", "terrace", CANOPY_EARTH, FLOOR_THICKNESS, [v(43.27, 0, -31), v(50.73, 0, -31), v(56, 0, -25.73), v(56, 0, -18.27), v(50.73, 0, -13), v(43.27, 0, -13), v(38, 0, -18.27), v(38, 0, -25.73)]),
  flat("canopy-trial-exit-path", "terrace", CANOPY_EARTH, FLOOR_THICKNESS, [v(43.5, 0, -14), v(50.5, 0, -14), v(50.5, 0, 10), v(43.5, 0, 10)]),
];

export const CANOPY_NAVIGATION_NODES: readonly NavNode[] = [
  { id: "canopy-trial-start", position: v(-58, 0, -20), links: ["canopy-trial-basin"] },
  { id: "canopy-trial-basin", position: v(-49, 0, -28), links: ["canopy-trial-start", "canopy-trial-stair-foot"] },
  { id: "canopy-trial-stair-foot", position: v(-39, 0, -28), links: ["canopy-trial-basin", "canopy-trial-stair-top"] },
  { id: "canopy-trial-stair-top", position: v(-24, 4, -28), links: ["canopy-trial-stair-foot", "canopy-trial-fig-ledge"] },
  { id: "canopy-trial-fig-ledge", position: v(-19, 4, -28.5), links: ["canopy-trial-stair-top", "canopy-trial-gorge-bridge"] },
  { id: "canopy-trial-gorge-bridge", position: v(-9, 4, -28.5), links: ["canopy-trial-fig-ledge", "canopy-trial-roost"] },
  { id: "canopy-trial-roost", position: v(5, 4, -26), links: ["canopy-trial-gorge-bridge", "canopy-trial-chasm-bridge"] },
  { id: "canopy-trial-chasm-bridge", position: v(18.5, 4, -23.5), links: ["canopy-trial-roost", "canopy-trial-temple-descent"] },
  { id: "canopy-trial-temple-descent", position: v(31, 2, -22.5), links: ["canopy-trial-chasm-bridge", "canopy-trial-courtyard"] },
  { id: "canopy-trial-courtyard", position: v(47, 0, -22), links: ["canopy-trial-temple-descent", "canopy-trial-exit-approach"] },
  { id: "canopy-trial-exit-approach", position: v(47, 0, -12), links: ["canopy-trial-courtyard", "canopy-trial-exit-landing"] },
  { id: "canopy-trial-exit-landing", position: v(47, 0, 7), links: ["canopy-trial-exit-approach"] },
];

export const CANOPY_NAVIGATION_RIBBONS: readonly NavRibbon[] = [
  { id: "canopy-trial-basin-route", points: [v(-58, 0, -20), v(-49, 0, -28), v(-39, 0, -28), v(-30, 2, -28), v(-24, 4, -28)], width: 3.2, depthBand: "ground" },
  { id: "canopy-trial-high-route", points: [v(-24, 4, -28), v(-19, 4, -28.5), v(-9, 4, -28.5), v(-4, 4, -28.5), v(5, 4, -26), v(13, 4, -23.5), v(18.5, 4, -23.5), v(24, 4, -23.5)], width: 2.8, depthBand: "root-to-canopy" },
  { id: "canopy-trial-temple-route", points: [v(24, 4, -23.5), v(31, 2, -22.5), v(38, 0, -22), v(47, 0, -22), v(47, 0, -12), v(47, 0, 7)], width: 3.2, depthBand: "ground" },
];

export const CANOPY_CAMERA_ANCHORS: readonly RegionDefinition["cameraAnchors"][number][] = [
  camera("canopy-trial-basin-rail", v(-49, 0, -26), "encounter"),
  camera("canopy-trial-gorge-rail", v(-9, 4, -28.5), "exploration"),
  camera("canopy-trial-roost-rail", v(5, 4, -26), "encounter"),
  camera("canopy-trial-courtyard-rail", v(47, 0, -22), "encounter"),
  camera("canopy-trial-exit-rail", v(47, 0, 7), "exploration"),
];

/** Vine bridges run along world +x: local +z of the model maps to +x with `rotationY = π/2`, stretched to the authored span. */
const bridge = (id: string, fromX: number, toX: number, z: number): WorldAssetPlacement =>
  placement(id, "prop-vine-bridge", v((fromX + toX) / 2, 4, z), "elevated", Math.PI / 2, v(1, 1, (toX - fromX) / BRIDGE_MODEL_LENGTH));

/**
 * Giant trees outside the walk-mesh; the y 4 trees stand on the cliff tops (elevated placement), the rest on the valley floor.
 * All stand on the far side of the route from the camera (offset +x, +z), so their trunks never fill the foreground.
 * Keep the large measured root boxes clear of the exit approach, not just the visible trunk centre.
 */
export const CANOPY_GIANT_TREES: readonly Vec3[] = [v(-20, 4, -38), v(-38, 0, -48), v(2, 4, -42), v(28, 0, -34), v(60, 0, -38), v(20, 0, -52)];

export const CANOPY_AUTHORED_PROPS: readonly WorldAssetPlacement[] = [
  bridge("canopy-trial-bridge-a", -14.6, -3.4, -28.5),
  bridge("canopy-trial-bridge-b", 13.2, 24.8, -23.5),
  placement("canopy-trial-shrine", "prop-ancient-canopy-shrine", v(47, 0, -38), "ground", 0, v(1, 1, 1)),
  placement("canopy-trial-jump-rock", "prop-mire-bank-rock", v(-51, 0, -34), "ground", 2.4, v(0.7, 0.7, 0.7)),
  ...CANOPY_GIANT_TREES.map((position, index) => placement("canopy-trial-tree-" + index, "prop-rainforest-canopy-tree", position, position.y === 0 ? "ground" : "elevated", index * 2.399, v(1, 1, 1))),
];

/** Plan-view circles of authored set dressing that stays in place (bridges are covered by the walk-mesh itself). */
export const canopyPropFootprints = (props: readonly WorldAssetPlacement[]) => props.flatMap((prop) => {
  if (prop.assetId === "prop-rainforest-canopy-tree") return [{ x: prop.position.x, z: prop.position.z, radius: CANOPY_TREE_FOOTPRINT_RADIUS }];
  if (prop.assetId === "prop-ancient-canopy-shrine") return [{ x: prop.position.x, z: prop.position.z, radius: CANOPY_SHRINE_FOOTPRINT_RADIUS }];
  if (prop.assetId === "prop-mire-bank-rock") return [{ x: prop.position.x, z: prop.position.z, radius: 1.5 }];
  return [];
});
export const CANOPY_AUTHORED_FOOTPRINTS = canopyPropFootprints(CANOPY_AUTHORED_PROPS);

/**
 * Chapter-only side branches. The orchard terrace opens west off the exit path (valley floor, dry: clear of the courtyard pools
 * and the chasm); the seed alcove is a cliff-top spur north of the roost, inside the roost massif summit. Neither exists in
 * the Trial layout, and nothing in the base layout links to them.
 */
export const CANOPY_STORY_SURFACES: readonly WalkSurface[] = [
  flat("canopy-trial-orchard", "terrace", CANOPY_EARTH, FLOOR_THICKNESS, [v(30, 0, -1), v(44.5, 0, -1), v(44.5, 0, 8), v(30, 0, 8)]),
  flat("canopy-trial-seed-alcove", "terrace", CANOPY_EARTH, DECK_THICKNESS, [v(0, 4, -44), v(20, 4, -44), v(20, 4, -37), v(0, 4, -37)]),
];

export const CANOPY_STORY_NODES: readonly NavNode[] = [
  { id: "canopy-story-orchard", position: v(37, 0, 3.5), links: ["canopy-trial-exit-approach", "canopy-trial-exit-landing"] },
  { id: "canopy-story-seed-approach", position: v(11, 4, -32), links: ["canopy-trial-roost", "canopy-story-seed-entry"] },
  { id: "canopy-story-seed-entry", position: v(10.8, 4, -38), links: ["canopy-story-seed-approach", "canopy-story-seed-alcove"] },
  { id: "canopy-story-seed-alcove", position: v(15, 4, -41), links: ["canopy-story-seed-entry"] },
  { id: "canopy-story-courtyard-west", position: v(40, 0, -22.5), links: ["canopy-trial-temple-descent", "canopy-trial-courtyard"] },
];
/** Extra links added to base nodes in the chapter region only. */
export const CANOPY_STORY_LINKS: Readonly<Record<string, readonly string[]>> = {
  "canopy-trial-exit-approach": ["canopy-story-orchard"],
  "canopy-trial-exit-landing": ["canopy-story-orchard"],
  "canopy-trial-roost": ["canopy-story-seed-approach"],
  "canopy-trial-temple-descent": ["canopy-story-courtyard-west"],
};
export const CANOPY_STORY_RIBBONS: readonly NavRibbon[] = [
  { id: "canopy-story-orchard-route", points: [v(47, 0, 3.5), v(37, 0, 3.5)], width: 2.6, depthBand: "ground" },
  { id: "canopy-story-seed-route", points: [v(5, 4, -26), v(11, 4, -32), v(10.8, 4, -38), v(15, 4, -41)], width: 2.4, depthBand: "root-to-canopy" },
];
export const CANOPY_STORY_CAMERAS: readonly RegionDefinition["cameraAnchors"][number][] = [
  camera("canopy-story-orchard-rail", v(37, 0, 3.5), "exploration"),
  camera("canopy-story-alcove-rail", v(15, 4, -40), "exploration"),
];
