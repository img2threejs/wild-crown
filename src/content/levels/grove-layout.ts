import type { RegionDefinition, Vec3, WorldAssetPlacement } from "../../game/contracts.js";
import { ARENA_CENTRE, ARENA_WALK_RADIUS, HOLLOW_CENTRE } from "../../world/GroveBlight.js";
import { camera, flat, ngon, placement, rect, uniform, type NavNode, type NavRibbon, type WalkSurface } from "./layout-kit.js";
import { v } from "./schema.js";

/**
 * The Grove physical layout shared by the Grove combat trials (`GroveTrialRegion`) and the peaceful Act I hub (`act-i.ts`).
 * The southern meadow (trailhead, glade, Yara's camp, the lookout pad and the practice ring) is the shared base; the blighted
 * hollow, the Memory Pool arena and the Ridge Trail behind it are Trial-only, and the Asha den west of the camp is
 * chapter-only. Surface ids keep the `grove-trial-` prefix because the Grove biome recognises a Grove walk-mesh by it.
 */
export const GROVE_SURFACE_PREFIX = "grove-trial-";
const EARTH = "grove-trail-earth";
const POOL_STONE = "grove-pool-stone";
const FLOOR_THICKNESS = 0.45;
export const GROVE_HEARTROOT_FOOTPRINT_RADIUS = 3;
export const GROVE_TENT_FOOTPRINT_RADIUS = 2.6;
export const GROVE_LOOKOUT_FOOTPRINT_RADIUS = 3;
export const GROVE_BASIN_FOOTPRINT_RADIUS = 2.6;
export const GROVE_POST_FOOTPRINT_RADIUS = 0.8;
export const GROVE_SHRINE_FOOTPRINT_RADIUS = 6.5;
export const GROVE_CAVERN_FOOTPRINT_RADIUS = 4.6;
export const GROVE_CLIFF_ROCK_FOOTPRINT_RADIUS = 2.2;
export const GROVE_BANK_ROCK_FOOTPRINT_RADIUS = 1.8;

/** Centres of the three round clearings (walkable r 10.5, 10.5, 13.5) the arenas (radius 8, 8, 11) lie inside; the last two are the blight's (GroveBlight). */
const RING_CENTRE = { x: -24, z: -22 } as const;

interface LayoutSurface extends WalkSurface { readonly trialOnly: boolean }
const surface = (entry: WalkSurface, trialOnly = false): LayoutSurface => ({ ...entry, trialOnly });
const ground = (id: string, material: string, points: readonly Vec3[]): WalkSurface => flat(id, "terrace", material, FLOOR_THICKNESS, points);

const ALL_SURFACES: readonly LayoutSurface[] = [
  // South trailhead: where the player arrives from the Whispering Canopy / Blood Bamboo Valley.
  surface(ground("grove-trial-trailhead", EARTH, rect(5, 26, 15, 48))),
  // Central glade. The young Heartroot's mound and the pond lie beyond its straight north edge (z -5), not inside it.
  surface(ground("grove-trial-glade", EARTH, [v(-12, 0, 2), v(-8, 0, -5), v(17, 0, -5), v(24, 0, 0), v(24, 0, 20), v(16, 0, 29), v(0, 0, 29), v(-10, 0, 22), v(-13, 0, 12)])),
  // Yara's camp (west of the glade) and the lookout pad (east of it).
  surface(ground("grove-trial-camp", EARTH, rect(-34, -4, -12, 16))),
  surface(ground("grove-trial-lookout-pad", EARTH, rect(18, -6, 34, 18))),
  // The way from the camp to the practice ring (stage 1), the ring itself and the gated spur north to the blighted hollow.
  surface(ground("grove-trial-ring-path", EARTH, rect(-28, -13, -20, -3))),
  surface(ground("grove-trial-practice-ring", EARTH, ngon(RING_CENTRE.x, RING_CENTRE.z, 10.5, 16))),
  surface(ground("grove-trial-pool-spur", EARTH, rect(-27, -47, -21, -31)), true),
  // The blighted hollow (stage 2), the second gated spur and the Memory Pool arena (stage 3) on the pool's pale stone.
  surface(ground("grove-trial-blight-hollow", EARTH, ngon(HOLLOW_CENTRE.x, HOLLOW_CENTRE.z, 10.5, 16)), true),
  surface(ground("grove-trial-pool-approach", EARTH, rect(-27, -88, -21, -65)), true),
  surface(ground("grove-trial-memory-pool", POOL_STONE, ngon(ARENA_CENTRE.x, ARENA_CENTRE.z, ARENA_WALK_RADIUS, 20)), true),
  // The Ridge Trail leaves the arena east, behind the last gate, and ends in the exit landing.
  surface(ground("grove-trial-ridge-trail", EARTH, rect(-12, -99, 24, -93)), true),
  surface(ground("grove-trial-ridge-landing", EARTH, rect(18, -103, 32, -89)), true),
];

/** The Trial walk-mesh: the whole meadow plus the gated blight route, in the shipped order. */
export const GROVE_TRIAL_SURFACES: readonly WalkSurface[] = ALL_SURFACES;
/** The peaceful hub walk-mesh: the shared southern meadow plus the chapter-only Asha den. */
export const GROVE_STORY_SURFACES: readonly WalkSurface[] = [
  ...ALL_SURFACES.filter((entry) => !entry.trialOnly),
  ground("grove-trial-den", EARTH, rect(-46, 2, -33, 14)),
];

const ALL_NODES: readonly (NavNode & { readonly trialOnly?: true })[] = [
  { id: "grove-trial-start", position: v(10, 0, 44), links: ["grove-trial-trailhead"] },
  { id: "grove-trial-trailhead", position: v(10, 0, 31), links: ["grove-trial-start", "grove-trial-glade-south"] },
  { id: "grove-trial-glade-south", position: v(8, 0, 21), links: ["grove-trial-trailhead", "grove-trial-glade"] },
  { id: "grove-trial-glade", position: v(7, 0, 8), links: ["grove-trial-glade-south", "grove-trial-glade-east", "grove-trial-glade-west"] },
  { id: "grove-trial-glade-east", position: v(17, 0, 0), links: ["grove-trial-glade", "grove-trial-lookouts"] },
  { id: "grove-trial-lookouts", position: v(26, 0, 5), links: ["grove-trial-glade-east"] },
  { id: "grove-trial-glade-west", position: v(-8, 0, 3), links: ["grove-trial-glade", "grove-trial-camp"] },
  { id: "grove-trial-camp", position: v(-22, 0, 3), links: ["grove-trial-glade-west", "grove-trial-ring-path"] },
  { id: "grove-trial-ring-path", position: v(-24, 0, -8), links: ["grove-trial-camp", "grove-trial-practice-ring"] },
  { id: "grove-trial-practice-ring", position: v(-24, 0, -19), links: ["grove-trial-ring-path", "grove-trial-pool-gate"] },
  { id: "grove-trial-pool-gate", position: v(-24, 0, -34), links: ["grove-trial-practice-ring", "grove-trial-blight-hollow"], trialOnly: true },
  { id: "grove-trial-blight-hollow", position: v(-24, 0, -56), links: ["grove-trial-pool-gate", "grove-trial-approach-gate"], trialOnly: true },
  { id: "grove-trial-approach-gate", position: v(-24, 0, -76), links: ["grove-trial-blight-hollow", "grove-trial-memory-pool"], trialOnly: true },
  { id: "grove-trial-memory-pool", position: v(-24, 0, -96), links: ["grove-trial-approach-gate", "grove-trial-ridge-gate"], trialOnly: true },
  { id: "grove-trial-ridge-gate", position: v(-4, 0, -96), links: ["grove-trial-memory-pool", "grove-trial-ridge-mid"], trialOnly: true },
  { id: "grove-trial-ridge-mid", position: v(12, 0, -96), links: ["grove-trial-ridge-gate", "grove-trial-exit-landing"], trialOnly: true },
  { id: "grove-trial-exit-landing", position: v(26, 0, -96), links: ["grove-trial-ridge-mid"], trialOnly: true },
];
const trialNode = ({ trialOnly: _trialOnly, ...node }: NavNode & { readonly trialOnly?: true }): NavNode => node;
export const GROVE_TRIAL_NODES: readonly NavNode[] = ALL_NODES.map(trialNode);
const storyBase = ALL_NODES.filter((node) => !node.trialOnly);
const storyIds = new Set(storyBase.map((node) => node.id));
/** Hub navigation: the shared meadow nodes with their links into the gated blight route removed, plus the chapter-only extras. */
export const GROVE_STORY_BASE_NODES: readonly NavNode[] = storyBase.map((node) => ({ id: node.id, position: node.position, links: node.links.filter((link) => storyIds.has(link)) }));

export const GROVE_TRIAL_RIBBONS: readonly NavRibbon[] = [
  // Spawn, glade and camp to the practice ring: the road every run takes.
  { id: "grove-trial-main-route", points: [v(10, 0, 44), v(10, 0, 31), v(8, 0, 21), v(8, 0, 8), v(-8, 0, 3), v(-22, 0, 3), v(-24, 0, -8), v(-24, 0, -19)], width: 3.2, depthBand: "ground" },
  // Practice ring, blighted hollow and the Memory Pool arena, through the two gated spurs.
  { id: "grove-trial-pool-route", points: [v(-24, 0, -19), v(-24, 0, -34), v(-24, 0, -56), v(-24, 0, -76), v(-24, 0, -96)], width: 2.8, depthBand: "ground" },
  // Behind the last gate: the Ridge Trail from the arena to the exit.
  { id: "grove-trial-ridge-route", points: [v(-24, 0, -96), v(-4, 0, -96), v(12, 0, -96), v(26, 0, -96)], width: 3, depthBand: "ground" },
  // The detour to the monkey lookouts and Koro.
  { id: "grove-trial-lookout-route", points: [v(8, 0, 8), v(17, 0, 0), v(26, 0, 5)], width: 2.6, depthBand: "ground" },
];
export const GROVE_STORY_RIBBONS: readonly NavRibbon[] = [GROVE_TRIAL_RIBBONS[0]!, GROVE_TRIAL_RIBBONS[3]!];

export const GROVE_TRIAL_CAMERAS: readonly RegionDefinition["cameraAnchors"][number][] = [
  camera("grove-trial-arrival-rail", v(10, 0, 38), "exploration"),
  camera("grove-trial-glade-rail", v(6, 0, 8), "story"),
  camera("grove-trial-camp-rail", v(-22, 0, 3), "story"),
  camera("grove-trial-lookout-rail", v(27, 0, 5), "story"),
  camera("grove-trial-practice-rail", v(-24, 0, -22), "encounter"),
  camera("grove-trial-hollow-rail", v(-24, 0, -56), "encounter"),
  camera("grove-trial-pool-rail", v(-24, 0, -100), "encounter"),
  camera("grove-trial-ridge-rail", v(10, 0, -96), "exploration"),
  camera("grove-trial-exit-rail", v(26, 0, -96), "exploration"),
];
export const GROVE_STORY_CAMERAS: readonly RegionDefinition["cameraAnchors"][number][] = [
  ...GROVE_TRIAL_CAMERAS.slice(0, 5),
  camera("grove-story-court-rail", v(7, 0, 0), "story"),
  camera("grove-story-den-rail", v(-40, 0, 8), "story"),
];

/** Posts frame the practice ring's rim: two flank the spur opening to the north, two stand on its west and east sides. */
const POST_POSITIONS: readonly Vec3[] = [v(-31, 0, -28.5), v(-17, 0, -28.5), v(-32.5, 0, -18), v(-15.5, 0, -18)];
/** Warding posts round the blighted hollow and the Memory Pool arena: the Wardens' amber runes, half drowned in Black Sap. */
const WARD_POSITIONS: readonly Vec3[] = [v(-36.2, 0, -50), v(-11.8, 0, -50), v(-36.2, 0, -63), v(-41.2, 0, -88), v(-41.9, 0, -102.5), v(-6.1, 0, -102.5)];
/** Tall mossy rock pairs frame each gate across its spur; the root gate model closes the gap between them. */
const GATE_ROCKS: readonly Vec3[] = [
  v(-31.5, 0, -38), v(-16.5, 0, -38), v(-31.5, 0, -72), v(-16.5, 0, -72), v(-1, 0, -104.5), v(-1, 0, -87.5),
];

/** Meadow dressing shared by the Trial and the hub. */
export const GROVE_BASE_PROPS: readonly WorldAssetPlacement[] = [
  // The young Heartroot (9 m) rises on a low mound beside the pond; the mound itself is terrain relief (GroveTerrain).
  placement("grove-trial-heartroot", "prop-heartroot-trunk", v(-2, 0, -13), "ground", 0, uniform(1)),
  placement("grove-trial-tent", "prop-refuge-shelter", v(-29, 0, 7), "ground", Math.PI / 2, uniform(1)),
  // Two monkey lookouts on stilts (not walkable: no surface stands at deck height) with Koro idling between them.
  placement("grove-trial-lookout-a", "prop-grove-platform", v(31, 0, -3), "ground", Math.PI, uniform(1)),
  placement("grove-trial-lookout-b", "prop-grove-platform", v(31, 0, 13), "ground", Math.PI, uniform(1)),
  ...POST_POSITIONS.map((position, index) => placement("grove-trial-post-" + index, "prop-training-post", position, "ground", index * 1.7, uniform(1))),
  placement("grove-trial-practice-basin", "prop-water-basin", v(-30, 0, -23), "ground", 0, uniform(1)),
];
/** Blight-route dressing: wards, gate rocks, sap-soaked slabs and the Memory Pool's ruin, Heartroots and cavern. */
export const GROVE_TRIAL_ONLY_PROPS: readonly WorldAssetPlacement[] = [
  ...WARD_POSITIONS.map((position, index) => placement("grove-trial-ward-" + index, "prop-training-post", position, "ground", index * 2.1 + 0.4, uniform(1))),
  ...GATE_ROCKS.map((position, index) => placement("grove-trial-gate-rock-" + index, "prop-canopy-cliff-rock", position, "ground", index * 1.3, uniform(0.7))),
  // Sap-soaked slabs of the hollow.
  placement("grove-trial-hollow-rock-a", "prop-mire-bank-rock", v(-14, 0, -63), "ground", 2.2, uniform(0.9)),
  placement("grove-trial-hollow-rock-b", "prop-mire-bank-rock", v(-36, 0, -57), "ground", 0.5, uniform(0.8)),
  // The Memory Pool: an old Warden ruin west of the arena, two young Heartroots on the pool's far banks and the root cavern mouth the
  // pool's spring runs out of (opening south, towards the arena). The pool itself is terrain (GrovePond), not a prop.
  placement("grove-trial-pool-ruin", "prop-ancient-canopy-shrine", v(-52, 0, -96), "ground", Math.PI / 2, uniform(0.85)),
  placement("grove-trial-pool-heartroot-a", "prop-heartroot-trunk", v(-40, 0, -121), "ground", 0.6, uniform(0.9)),
  placement("grove-trial-pool-heartroot-b", "prop-heartroot-trunk", v(-8, 0, -121), "ground", 2.4, uniform(0.9)),
  placement("grove-trial-pool-cavern", "prop-root-cavern-mouth", v(-24, 0, -129), "ground", 0, uniform(1)),
];
/** Chapter-only growth; Trials retain their complete, fixed dressing. */
export const GROVE_STORY_PROPS: readonly WorldAssetPlacement[] = [
  ...GROVE_BASE_PROPS.map(prop => prop.assetId === "prop-grove-platform" ? { ...prop, visibleWhen: "choice:koro-pact" } : prop),
  { ...placement("grove-story-den-cavern", "prop-root-cavern-mouth", v(-52, 0, 8), "ground", Math.PI / 2, uniform(1)), visibleWhen: "choice:asha-pact" },
  { ...placement("grove-bird-roost-stone", "prop-greenwake-boulder-cluster", v(-5, 0, 16), "ground", 0, uniform(0.25)), visibleWhen: "hub:bird-roost" },
  { ...placement("grove-bird-nest", "prop-bird-nest", v(-5, 0.7, 16), "ground", 0.6, uniform(1)), visibleWhen: "hub:bird-roost" },
  ...[v(-16, 0, 12), v(-18, 0, 12), v(-16, 0, 14)].map((position, index) => ({
    ...placement("grove-seed-nursery-" + index, "prop-canopy-fern-cluster", position, "ground", index, uniform(0.7)),
    visibleWhen: "hub:seed-nursery",
  })),
];
export const GROVE_TRIAL_PROPS: readonly WorldAssetPlacement[] = [...GROVE_BASE_PROPS, ...GROVE_TRIAL_ONLY_PROPS];

const FOOTPRINT_RADIUS: Readonly<Record<string, number>> = {
  "prop-heartroot-trunk": GROVE_HEARTROOT_FOOTPRINT_RADIUS, "prop-refuge-shelter": GROVE_TENT_FOOTPRINT_RADIUS, "prop-grove-platform": GROVE_LOOKOUT_FOOTPRINT_RADIUS,
  "prop-training-post": GROVE_POST_FOOTPRINT_RADIUS, "prop-water-basin": GROVE_BASIN_FOOTPRINT_RADIUS, "prop-ancient-canopy-shrine": GROVE_SHRINE_FOOTPRINT_RADIUS,
  "prop-root-cavern-mouth": GROVE_CAVERN_FOOTPRINT_RADIUS, "prop-canopy-cliff-rock": GROVE_CLIFF_ROCK_FOOTPRINT_RADIUS, "prop-mire-bank-rock": GROVE_BANK_ROCK_FOOTPRINT_RADIUS,
  "prop-bird-nest": 0.6, "prop-greenwake-boulder-cluster": 2.2, "prop-canopy-fern-cluster": 0.8,
};
/** Plan-view circles of the authored set dressing that stays in place (footprint radius at scale 1 times the placement scale). */
export const groveFootprints = (props: readonly WorldAssetPlacement[]): readonly { x: number; z: number; radius: number }[] =>
  props.map((prop) => ({ x: prop.position.x, z: prop.position.z, radius: FOOTPRINT_RADIUS[prop.assetId]! * Math.max(prop.scale.x, prop.scale.z) }));
