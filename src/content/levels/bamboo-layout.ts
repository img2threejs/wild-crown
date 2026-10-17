import type { GroundSurfaceDefinition, RegionColliderDefinition, RegionDefinition, RegionMovableObjectDefinition, Vec3, WorldAssetPlacement } from "../../game/contracts.js";
import { flat, placement, ramp, rect, type NavNode, type NavRibbon, type WalkSurface } from "./layout-kit.js";
import { v } from "./schema.js";

/**
 * Blood Bamboo Valley physical plan (docs/features/full-campaign.md, "Blood Bamboo Valley"). Everything is on `y = 0` except the
 * ramp and the den arena (`y = 2`).
 *
 * 1. West evidence loop: the arrival path forks. The short *trap lane* (the west connector) runs straight at the camp past three
 *    armed jaw traps; the long *clear path* (two quads to the north) is trap-free and leads Tali's fur. Both arrive on the camp
 *    terrace's west edge, where they converge on the overlook.
 * 2. Hunter camp: the terrace with the camp structure, Tali's cage, the extraction rig and filter drum, Marek's ledger post and the
 *    loose snare Koro can drop. A ground control (staff heavy) gives the longer player-only alternative.
 * 3. Tiger trail: from the camp ramp the tracking floor forks into a short diagonal trap lane (three more armed traps) and a
 *    clear southern arc, both reaching the den ramp; Tali's shelter is the north-west corner of the den arena.
 * 4. Shrine/den arena: a 22 x 16 m terrace at y 2 with the shrine and the cavern mouth behind the west wall (far side from the
 *    camera), the charge lane (z 36.5-41.5, x 24-44, 20 m) running into that wall, the shelter outside it, the bamboo bundle and
 *    the black-sap source on the east side.
 * 5. Return loop: the east valley path leads to the Grove gateway; the Moonpine gateway stays story-gated.
 */
export const BAMBOO_EARTH = "hunter-camp-packed-earth";
const SURFACE_THICKNESS = 0.4;

const terrace = (id: string, material: string, points: readonly Vec3[], thickness = SURFACE_THICKNESS): WalkSurface =>
  flat(id, "terrace", material, thickness, points);

export const BAMBOO_WALK_SURFACES: readonly WalkSurface[] = [
  terrace("bamboo-west-approach", "blood-bamboo-approach", rect(-68, -12, -39, 13)),
  terrace("bamboo-west-connector", "bamboo-west-gate-trail", rect(-43, -5, -35, 4)),
  terrace("bamboo-long-path-a", "bamboo-clear-path", rect(-48, -26, -40, -10)),
  terrace("bamboo-long-path-b", "bamboo-clear-path", rect(-42, -28, -34, -20)),
  terrace("bamboo-camp-terrace", BAMBOO_EARTH, rect(-36, -31, 12, -3), 0.5),
  terrace("bamboo-camp-ramp", "bamboo-cut-terrace", rect(6, -4, 16, 7), 0.45),
  flat("bamboo-tracking-floor", "ridge", "tiger-tracking-leaf-litter", SURFACE_THICKNESS, rect(13, -1, 39, 20)),
  ramp("bamboo-tracking-ramp", "tiger-den-bamboo-root", SURFACE_THICKNESS, [v(27, 0, 18), v(38, 0, 18), v(38, 2, 29), v(27, 2, 29)]),
  terrace("bamboo-asha-arena", "asha-den-stone", rect(23, 29, 45, 45, 2), 0.45),
  terrace("bamboo-grove-gateway", "grove-route-earth", rect(48, -40, 68, -25)),
  terrace("bamboo-moonpine-gateway", "moonpine-route-stone", rect(29, -43, 47, -31)),
];

/** Diagonal paths keep their authored quads with a segment support collider along the centre line. */
const diagonal = (id: string, profile: GroundSurfaceDefinition["profile"], material: string, points: readonly Vec3[], from: Vec3, to: Vec3, radius: number): WalkSurface => ({
  surface: { id, profile, points, elevation: 0, thickness: SURFACE_THICKNESS, walkable: true, material, colliderId: id + "-collider" },
  collider: { id: id + "-collider", kind: "segment", from, to, radius, blocksMovement: false, blocksCamera: false, walkSurfaceId: id },
});
const CONNECTORS: readonly WalkSurface[] = [
  diagonal("bamboo-east-valley-path", "ridge", "bamboo-east-valley-trail", [v(28, 0, 1), v(36, 0, 8), v(66, 0, -25), v(58, 0, -33)], v(32, 0, 4.5), v(62, 0, -29), 5.5),
  diagonal("bamboo-moonpine-connector", "terrace", "moonpine-approach-earth", [v(37, 0, -43), v(47, 0, -43), v(58, 0, -30), v(48, 0, -30)], v(42, 0, -43), v(53, 0, -30), 6),
];
export const BAMBOO_ALL_SURFACES: readonly WalkSurface[] = [...BAMBOO_WALK_SURFACES, ...CONNECTORS];

/** Blocking walls that keep the charge inside the den: west (behind the shrine, the far side from the camera), east and south. */
export const BAMBOO_WALL_COLLIDERS: readonly RegionColliderDefinition[] = [
  { id: "bamboo-camp-palisade-collider", kind: "box", from: v(-2, 2, -31), halfExtents: v(16, 2, 0.6), blocksMovement: true, blocksCamera: true },
  { id: "bamboo-arena-wall-west", kind: "box", from: v(22.5, 4, 37), halfExtents: v(0.5, 2, 8), blocksMovement: true, blocksCamera: false },
  { id: "bamboo-arena-wall-east", kind: "box", from: v(45.5, 4, 37), halfExtents: v(0.5, 2, 8), blocksMovement: true, blocksCamera: false },
  { id: "bamboo-arena-wall-south", kind: "box", from: v(34, 4, 45.5), halfExtents: v(11.5, 2, 0.5), blocksMovement: true, blocksCamera: false },
];

export const BAMBOO_NAVIGATION_NODES: readonly NavNode[] = [
  { id: "bamboo-canopy-gateway", position: v(-62, 0, 0), links: ["bamboo-west-approach"] },
  { id: "bamboo-west-approach", position: v(-49, 0, 0), links: ["bamboo-canopy-gateway", "bamboo-west-evidence", "bamboo-west-connector", "bamboo-long-path"] },
  { id: "bamboo-west-evidence", position: v(-50, 0, 5), links: ["bamboo-west-approach"] },
  { id: "bamboo-west-connector", position: v(-39, 0, 0), links: ["bamboo-west-approach", "bamboo-camp-west-flank"] },
  { id: "bamboo-long-path", position: v(-44, 0, -18), links: ["bamboo-west-approach", "bamboo-long-path-turn"] },
  { id: "bamboo-long-path-turn", position: v(-37, 0, -24), links: ["bamboo-long-path", "bamboo-camp-overlook"] },
  { id: "bamboo-camp-west-flank", position: v(-34, 0, -8), links: ["bamboo-west-connector", "bamboo-camp-overlook", "bamboo-hunter-camp", "bamboo-camp-east-flank"] },
  { id: "bamboo-camp-overlook", position: v(-35, 0, -14), links: ["bamboo-camp-west-flank", "bamboo-long-path-turn", "bamboo-hunter-camp"] },
  { id: "bamboo-hunter-camp", position: v(-15, 0, -19), links: ["bamboo-camp-overlook", "bamboo-camp-west-flank", "bamboo-camp-east-flank"] },
  { id: "bamboo-camp-east-flank", position: v(5, 0, -12), links: ["bamboo-hunter-camp", "bamboo-camp-west-flank", "bamboo-camp-ramp"], requirement: "bamboo_tali_safe" },
  { id: "bamboo-camp-ramp", position: v(11, 0, 1), links: ["bamboo-camp-east-flank", "bamboo-trail-fork", "bamboo-tiger-tracks"] },
  { id: "bamboo-trail-fork", position: v(15, 0, 10), links: ["bamboo-camp-ramp", "bamboo-trail-trap-lane", "bamboo-trail-safe-arc"] },
  { id: "bamboo-trail-trap-lane", position: v(23, 0, 9.5), links: ["bamboo-trail-fork", "bamboo-den-ramp-entry"] },
  { id: "bamboo-trail-safe-arc", position: v(18, 0, 16), links: ["bamboo-trail-fork", "bamboo-trail-safe-arc-east"] },
  { id: "bamboo-trail-safe-arc-east", position: v(27, 0, 17), links: ["bamboo-trail-safe-arc", "bamboo-den-ramp-entry"] },
  { id: "bamboo-tiger-tracks", position: v(26, 0, 8), links: ["bamboo-camp-ramp", "bamboo-tiger-scent", "bamboo-grove-approach"] },
  { id: "bamboo-tiger-scent", position: v(33, 0, 15), links: ["bamboo-tiger-tracks", "bamboo-den-ramp-entry"] },
  { id: "bamboo-den-ramp-entry", position: v(32.5, 0, 18), links: ["bamboo-tiger-scent", "bamboo-den-ramp", "bamboo-trail-trap-lane", "bamboo-trail-safe-arc-east"] },
  { id: "bamboo-den-ramp", position: v(32.5, 1, 23), links: ["bamboo-den-ramp-entry", "bamboo-den-terrace"] },
  { id: "bamboo-den-terrace", position: v(32.5, 2, 29), links: ["bamboo-den-ramp", "bamboo-asha-arena", "bamboo-tali-shelter"] },
  { id: "bamboo-asha-arena", position: v(34, 2, 37), links: ["bamboo-den-terrace", "bamboo-tali-shelter", "bamboo-shrine-bundle"] },
  { id: "bamboo-tali-shelter", position: v(26, 2, 31.5), links: ["bamboo-den-terrace", "bamboo-asha-arena"] },
  { id: "bamboo-shrine-bundle", position: v(41, 2, 32), links: ["bamboo-asha-arena"] },
  { id: "bamboo-grove-approach", position: v(48.5, 0, -11.5), links: ["bamboo-tiger-tracks", "bamboo-grove-route"] },
  { id: "bamboo-grove-route", position: v(58, 0, -32), links: ["bamboo-grove-approach", "bamboo-moonpine-approach"], requirement: "restoration:blood-bamboo-valley:restored" },
  { id: "bamboo-moonpine-approach", position: v(47.5, 0, -34), links: ["bamboo-grove-route", "bamboo-moonpine-route"] },
  { id: "bamboo-moonpine-route", position: v(38, 0, -37), links: ["bamboo-moonpine-approach"] },
];

export const BAMBOO_NAVIGATION_RIBBONS: readonly NavRibbon[] = [
  { id: "bamboo-camp-approach-ribbon", points: [v(-62, 0, 0), v(-49, 0, 0), v(-39, 0, 0), v(-34, 0, -8), v(-15, 0, -19), v(5, 0, -12)], width: 3, depthBand: "camp-ground" },
  { id: "bamboo-clear-path-ribbon", points: [v(-49, 0, 0), v(-44, 0, -18), v(-37, 0, -24), v(-35, 0, -14)], width: 2.6, depthBand: "camp-ground" },
  { id: "bamboo-tracks-ribbon", points: [v(5, 0, -12), v(11, 0, 1), v(15, 0, 10), v(18, 0, 16), v(27, 0, 17), v(32.5, 0, 18), v(32.5, 1, 23), v(32.5, 2, 29), v(34, 2, 37)], width: 2.8, depthBand: "bamboo-floor-to-den" },
  { id: "bamboo-trap-lane-ribbon", points: [v(15, 0, 10), v(23, 0, 9.5), v(32.5, 0, 18)], width: 2.4, depthBand: "bamboo-floor-to-den" },
  { id: "bamboo-hub-return-ribbon", points: [v(26, 0, 8), v(48.5, 0, -11.5), v(58, 0, -32), v(47.5, 0, -34), v(38, 0, -37)], width: 2.5, depthBand: "east-valley-routes" },
];

const cam = (id: string, position: Vec3, lookAt: Vec3, mode: RegionDefinition["cameraAnchors"][number]["mode"]): RegionDefinition["cameraAnchors"][number] => ({ id, position, lookAt, mode });
export const BAMBOO_CAMERA_ANCHORS: readonly RegionDefinition["cameraAnchors"][number][] = [
  cam("bamboo-valley-entry-rail", v(-67, 9, 22), v(-51, 0, 1), "exploration"),
  cam("bamboo-hunter-camp-establishing", v(-15, 9, 1), v(-16, 0, -18), "story"),
  cam("bamboo-camp-encounter-rail", v(-19, 10, 10), v(-15, 0, -18), "encounter"),
  cam("bamboo-tiger-tracking-rail", v(17, 8, 18), v(31, 0, 12), "exploration"),
  cam("bamboo-asha-arena-rail", v(34, 11, 52), v(33, 2, 36), "encounter"),
  cam("bamboo-shelter-rail", v(36, 14, 46), v(28, 2, 33), "story"),
  cam("bamboo-exit-rail", v(68, 12, -18), v(58, 0, -32), "exploration"),
];

/** The loose snare Koro can drop (and the player can knock with a heavy hit) to interrupt the ranged hunter's net. */
export const CAMP_LOOSE_SNARE_MOVE: RegionMovableObjectDefinition = {
  id: "camp-loose-snare",
  assetId: "prop-black-sap-jaw-trap",
  from: v(-26, 0, -22),
  to: v(-15, 0, -27),
  supportSurfaceId: "bamboo-camp-terrace",
  radiusMeters: 2.5,
  animationTicks: 24,
  requiredCompanionId: "koro",
  koroInteractionId: "koro-drop-object",
  playerInteractionId: "player-drop-object",
  movedFactId: "objectMoved:camp-loose-snare",
  requiredFacts: [],
  effect: { kind: "distraction", targetActorInstanceId: "hunter-ranged", radiusMeters: 2.5, interruptRangedWindupTicks: 24 },
};
/**
 * The bamboo bundle that drops across Asha's charge lane. Encounter-resettable: the engine rests it at every encounter start and
 * never treats `movedFactId` as permanent. Koro's special or a player heavy hit releases it; either way works without Koro.
 */
export const ASHA_SHRINE_BUNDLE_MOVE: RegionMovableObjectDefinition = {
  id: "asha-shrine-bundle",
  assetId: "prop-bamboo-grove-cluster",
  from: v(41, 2, 33),
  to: v(36, 2, 38.5),
  supportSurfaceId: "bamboo-asha-arena",
  radiusMeters: 2.5,
  animationTicks: 30,
  requiredCompanionId: "koro",
  koroInteractionId: "koro-bundle-drop",
  playerInteractionId: "player-bundle-release",
  movedFactId: "objectMoved:asha-shrine-bundle",
  requiredFacts: [],
  effect: { kind: "distraction", targetActorInstanceId: "asha", radiusMeters: 2.5, interruptRangedWindupTicks: 24 },
};

/** Jaw traps: armed by default (visible jaw), disarmed by the `interaction:camp-disable` fact. Three on the west lane, three on the tracking floor. */
export const BAMBOO_TRAP_POSITIONS = [
  v(-41, 0, -1.5), v(-38.5, 0, 1.5), v(-40, 0, -3.5),
  v(20.5, 0, 6.5), v(23.5, 0, 9.5), v(26, 0, 12),
] as const;

const CLUSTER = "prop-bamboo-grove-cluster";
export const BAMBOO_AUTHORED_PROPS: readonly WorldAssetPlacement[] = [
  // West evidence: snapped stems, the crushed jaw trap and the first fur.
  placement("bamboo-west-grove", CLUSTER, v(-58, 0, -22), "ground", 0.18, v(1.2, 1.2, 1.2)),
  placement("bamboo-evidence-snapped-stems", CLUSTER, v(-47.5, 0, 3.5), "ground", 1.1, v(0.22, 0.22, 0.22)),
  placement("bamboo-evidence-crushed-trap", "prop-black-sap-jaw-trap", v(-52, 0, 5.5), "ground", 2.2, v(1, 1, 1)),
  placement("bamboo-camp-grove", CLUSTER, v(-44, 0, -38), "ground", 0.7, v(1, 1, 1)),
  ...BAMBOO_TRAP_POSITIONS.map((position, index) => placement("bamboo-trap-" + (index + 1), "prop-black-sap-jaw-trap", position, "ground", index * 1.9, v(1, 1, 1))),
  // Hunter camp.
  placement("bamboo-hunter-camp", "prop-hunter-camp", v(4, 0, -21), "ground", -Math.PI / 2, v(1, 1, 1)),
  placement("bamboo-tali-cage", "prop-hunter-cage", v(-5, 0, -9), "ground", 0, v(1, 1, 1)),
  placement("bamboo-extraction-rig", "prop-hunter-extraction-rig", v(-3.5, 0, -27), "ground", 0, v(1, 1, 1)),
  placement("bamboo-filter-drum", "prop-black-sap-filter-drum", v(2, 0, -27.5), "ground", 0.6, v(1, 1, 1)),
  placement("camp-loose-snare", "prop-black-sap-jaw-trap", v(-26, 0, -22), "ground", 0.4, v(1.4, 1.4, 1.4)),
  // Shrine and den behind the west wall, the bundle and the sap source on the east side of the arena.
  placement("bamboo-ancient-shrine", "prop-ancient-bamboo-shrine", v(18.5, 2, 37), "ground", Math.PI / 2, v(1, 1, 1)),
  placement("bamboo-den-cavern", "prop-root-cavern-mouth", v(14, 2, 30), "ground", Math.PI / 2, v(1, 1, 1)),
  placement("asha-shrine-bundle", CLUSTER, v(41, 2, 33), "ground", 0.9, v(0.4, 0.4, 0.4)),
  placement("bamboo-sap-source", "prop-black-sap-filter-drum", v(43.5, 2, 30.5), "ground", 2.4, v(1.3, 1.3, 1.3)),
  // Return loop.
  placement("bamboo-grove-gate-arch", "prop-root-arch", v(58, 0, -36), "ground", 0, v(1, 1, 1)),
];

/** Conservative plan-view radius (m, at placement scale 1) of authored dressing the boundary builder keeps clear. */
const AUTHORED_RADIUS: Readonly<Record<string, number>> = {
  "prop-bamboo-grove-cluster": 4, "prop-hunter-camp": 5, "prop-hunter-cage": 1.6, "prop-hunter-extraction-rig": 2, "prop-black-sap-filter-drum": 1.2,
  "prop-black-sap-jaw-trap": 0.8, "prop-ancient-bamboo-shrine": 4.5, "prop-root-cavern-mouth": 4.6, "prop-root-arch": 2.1,
};
export const BAMBOO_AUTHORED_FOOTPRINTS = BAMBOO_AUTHORED_PROPS.map((prop) => ({ x: prop.position.x, z: prop.position.z, radius: AUTHORED_RADIUS[prop.assetId]! * Math.max(prop.scale.x, prop.scale.z) }));
/** The den arena, kept clear of boundary dressing. */
export const BAMBOO_DEN_ARENA = { center: v(34, 2, 37), radius: 13 } as const;
/** Charge lane of the Bamboo Charge: east to west across the den floor into the shrine wall. */
export const BAMBOO_CHARGE_LANE = { from: v(44, 2, 39), to: v(24, 2, 39), halfWidth: 2.5 } as const;
