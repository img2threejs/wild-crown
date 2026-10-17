import type { RegionColliderDefinition, RegionDefinition, RegionRouteDefinition, Vec3, WorldAssetPlacement } from "../../game/contracts.js";
import { buildCanopyBoundaryPlacements } from "../../world/CanopyBoundary.js";
import { clusterBoundaryDressing } from "../../world/clusteredBoundaryDressing.js";
import {
  CANOPY_AUTHORED_FOOTPRINTS, CANOPY_AUTHORED_PROPS, CANOPY_CAMERA_ANCHORS, CANOPY_NAVIGATION_NODES, CANOPY_NAVIGATION_RIBBONS, CANOPY_STORY_CAMERAS,
  CANOPY_STORY_LINKS, CANOPY_STORY_NODES, CANOPY_STORY_RIBBONS, CANOPY_STORY_SURFACES, CANOPY_WALK_SURFACES, canopyPropFootprints,
} from "./canopy-layout.js";
import { flat, rect } from "./layout-kit.js";
import { v } from "./schema.js";
import { actor, prop, route, target } from "./story-kit.js";

/**
 * Whispering Canopy chapter region (chapter 1). The geometry is the shared layout (`canopy-layout.ts`, also the Trial map); this
 * file adds the story overlay: Vara at the basin, the vine route and the vaulted boulder, the roost's seed alcove with the trapped
 * monkeys, the waterwheel in the orchard, Koro in the temple courtyard and the exit to Blood Bamboo Valley. No trial gates exist
 * here; the three canopy monsters stand at their trial arenas as bounded local threats (Koro is the only encounter).
 *
 * Route: basin (Vara: tend, mark, warning) → root stair → fig ledge (vaulted boulder) → gorge vine bridge (vine route) → roost
 * (seed alcove: monkeys and seeds; Koro's trail) → chasm bridge → temple descent → courtyard → exit path (orchard terrace: the
 * waterwheel) → back to the courtyard for Koro → the pact → the orchard wakes → the exit to Blood Bamboo Valley.
 *
 * Contextual traversal (beside the free jump, never a gate): in the basin a low ledge onto the jump rock and a slide under the
 * rock shelter's capstone, on the fig ledge a vault over the boulder, and a vine swing across the gorge beside bridge A. Every
 * arc crosses a visible obstacle between two grounded poses.
 */
/**
 * The chapter's traversal rocks are `prop-mire-bank-rock` at the Trial jump rock's verified 0.7 scale. Their extents below are the
 * renderer's measured support fields at these placements (top 1.16 m, mesh 1.34 m, lowest standable top 0.64 m). An authored rock
 * proxy stops at {@link ROCK_CORE_TOP}, under every standable measured top, so a jump still lands on the measured rock in the
 * browser while headless movement is blocked by the rock.
 */
const ROCK_SCALE = v(0.7, 0.7, 0.7);
const ROCK_CORE_TOP = 0.6;
const rock = (id: string, position: Vec3, rotationY: number): WorldAssetPlacement =>
  prop(id, "prop-mire-bank-rock", position, position.y > 0 ? "elevated" : "ground", rotationY, ROCK_SCALE);
const box = (id: string, minX: number, minZ: number, maxX: number, maxZ: number, bottom: number, top: number): RegionColliderDefinition => ({
  id, kind: "box", from: v((minX + maxX) / 2, (bottom + top) / 2, (minZ + maxZ) / 2), halfExtents: v((maxX - minX) / 2, (top - bottom) / 2, (maxZ - minZ) / 2),
  blocksMovement: true, blocksCamera: false,
});
const contextual = (definition: RegionRouteDefinition, kind: NonNullable<RegionRouteDefinition["traversal"]>["kind"], durationTicks: number, anchors: readonly Vec3[],
  ledge?: NonNullable<RegionRouteDefinition["traversal"]>["ledge"]): RegionRouteDefinition =>
  ({ ...definition, anchors, traversal: { kind, durationTicks, startRadius: 1.25, ...(ledge ? { ledge } : {}) } });

/** The boulder on the fig ledge, north of the path: a jumpable step and the vault, never a gate (the ledge is walkable around it). */
const VAULT_ROCK = rock("canopy-vault-rock", v(-19, 4, -24.5), 0);
const VAULT_ROCK_COLLIDER = box("canopy-vault-rock", -19.875, -25.875, -18.125, -23.125, 4, 4 + ROCK_CORE_TOP);
/**
 * Rock shelter in the basin's far corner: two slabs 1.5 m apart carry a capstone whose measured underside is 1 m above the floor,
 * so a standing capsule cannot pass under it and the 0.65 m slide capsule can.
 */
const SHELTER_ROCKS = [
  rock("canopy-shelter-rock-south", v(-44, 0, -37.125), Math.PI / 2),
  rock("canopy-shelter-rock-north", v(-44, 0, -33.875), Math.PI / 2),
  rock("canopy-shelter-capstone", v(-44, 1, -35.5), 0),
];
const SHELTER_COLLIDERS = [
  box("canopy-shelter-rock-south", -45.375, -38, -42.625, -36.25, 0, ROCK_CORE_TOP),
  box("canopy-shelter-rock-north", -45.375, -34.75, -42.625, -33, 0, ROCK_CORE_TOP),
  box("canopy-shelter-capstone", -44.875, -36.875, -43.125, -34.125, 1, 1 + ROCK_CORE_TOP),
];
/**
 * The flattest part of the basin jump rock's measured top (cell tops 0.90–1.165 m), as a chapter walk surface at 1.17 m: its
 * support box is the ledge face, and the rest of the rock stays the measured support it is in the Trial.
 */
const JUMP_ROCK_TOP_Y = 1.17;
const JUMP_ROCK_TOP = flat("canopy-trial-jump-rock-top", "terrace", "canopy-boulder-top", JUMP_ROCK_TOP_Y, rect(-51.15, -34.45, -50.25, -33.55, JUMP_ROCK_TOP_Y));

const TRAVERSAL_ARCS: readonly RegionRouteDefinition[] = [
  contextual(route("canopy-boulder-vault-arc", v(-20.75, 4, -24.5), v(-17.25, 4, -24.5), "whispering-canopy", "path", "aren-staff-vault",
    ["canopy-vault-rock", "canopy-trial-fig-ledge-collider"], "canopy-boulder-vault"), "vault", 60,
  [v(-20.35, 5.25, -24.5), v(-19.5, 5.6, -24.5), v(-18.5, 5.6, -24.5), v(-17.65, 5.25, -24.5)]),
  contextual(route("canopy-gorge-swing-arc", v(-14.75, 4, -24.5), v(-3.25, 4, -24.5), "whispering-canopy", "canopy", "aren-swing",
    ["canopy-trial-fig-ledge-collider", "canopy-trial-roost-collider"], "canopy-gorge-swing"), "swing", 90,
  [v(-12.75, 5.3, -24.5), v(-9, 6.1, -24.5), v(-5.25, 5.3, -24.5)]),
  contextual(route("canopy-basin-rock-ledge-arc", v(-49.8, 0, -33.1), v(-50.7, JUMP_ROCK_TOP_Y, -34), "whispering-canopy", "path", "aren-low-ledge",
    ["canopy-trial-basin-collider", JUMP_ROCK_TOP.collider.id], "canopy-basin-rock-climb"), "low-ledge", 72,
  [v(-49.8, JUMP_ROCK_TOP_Y + 0.1, -33.1), v(-50.7, JUMP_ROCK_TOP_Y + 0.1, -34)],
  { riseMeters: JUMP_ROCK_TOP_Y, maxCrossingMeters: 1.5, faceColliderId: JUMP_ROCK_TOP.collider.id }),
  contextual(route("canopy-rock-shelter-slide-arc", v(-46.2, 0, -35.5), v(-41.8, 0, -35.5), "whispering-canopy", "path", "aren-low-slide",
    ["canopy-shelter-capstone", "canopy-shelter-rock-south", "canopy-shelter-rock-north", "canopy-trial-basin-collider"], "canopy-rock-shelter-slide"), "slide", 60,
  [v(-45.6, 0, -35.5), v(-42.4, 0, -35.5)]),
];
const COURTYARD_ARENA = { center: v(47, 0, -22), radius: 9 } as const;

export function createCanopyChapterRegion(): RegionDefinition {
  const surfaces = [...CANOPY_WALK_SURFACES, ...CANOPY_STORY_SURFACES, JUMP_ROCK_TOP];
  const nodes = [
    ...CANOPY_NAVIGATION_NODES.map((node) => (CANOPY_STORY_LINKS[node.id] ? { ...node, links: [...node.links, ...CANOPY_STORY_LINKS[node.id]!] } : node)),
    ...CANOPY_STORY_NODES,
  ];
  const exit = route(
    "canopy-bamboo-out", v(47, 0, 7), v(-62, 0, 0), "blood-bamboo-valley", "path", "contextual-traverse",
    ["canopy-trial-exit-path-collider"], "canopy-bamboo", "restoration:whispering-canopy:restored",
  );
  const traversalProps = [VAULT_ROCK, ...SHELTER_ROCKS];
  const authoredProps: readonly WorldAssetPlacement[] = [...CANOPY_AUTHORED_PROPS, ...traversalProps];
  const base: RegionDefinition = {
    id: "whispering-canopy", authoringStatus: "unaccepted", name: "Whispering Canopy", biome: "Layered rainforest, vine bridges, waterfall and monkey canopy",
    bounds: { min: v(-80, -3, -70), max: v(80, 38, 70) }, environmentRecipeId: "whispering-canopy-environment",
    props: authoredProps,
    movableObjects: [],
    ground: {
      y: 0, profile: "canopy", navGraphId: "whispering-canopy-nav",
      surfaces: surfaces.map((entry) => entry.surface), colliders: [...surfaces.map((entry) => entry.collider), VAULT_ROCK_COLLIDER, ...SHELTER_COLLIDERS],
    },
    navigation: { nodes, ribbons: [...CANOPY_NAVIGATION_RIBBONS, ...CANOPY_STORY_RIBBONS] },
    cameraAnchors: [...CANOPY_CAMERA_ANCHORS, ...CANOPY_STORY_CAMERAS],
    entrances: [],
    exits: [exit],
    traversalArcs: TRAVERSAL_ARCS,
    entities: [
      actor("canopy-vara", "vara", "actor-vara", v(-58, 0, -22), "ground"),
      actor("koro", "koro", "actor-koro", v(47, 0, -24), "ground"),
      actor("canopy-howler", "canopy-howler", "actor-thornback-howler", v(-46, 0, -26), "ground"),
      actor("canopy-hornbill", "canopy-hornbill", "actor-storm-hornbill", v(7, 4, -24), "elevated"),
      actor("canopy-mire-viper", "canopy-mire-viper", "actor-mire-viper", v(49, 0, -4), "ground"),
      target("canopy-tend-vara", v(-56.5, 0, -21.5)),
      target("canopy-vault", v(-17.25, 4, -24.5), "elevated"),
      target("canopy-vine-route", v(-5.5, 4, -28.5), "elevated"),
      target("monkey-rescue", v(2, 4, -39.5), "elevated"),
      target("orchard-seeds", v(5.5, 4, -41.5), "elevated"),
      target("koro-trail", v(11, 4, -22), "elevated"),
      target("canopy-waterwheel", v(36, 0, 4.5)),
      target("canopy-restoration", v(41, 0, 2)),
      target("koro-thorn", v(46, 0, -24.5)),
      target("canopy-fragment", v(46.5, 0, -29)),
      target("koro-pact", v(44, 0, -19.5)),
      target("seeds-on-the-wind", v(5, 4, -40)),
      target("seed-route", v(18, 4, -23)),
    ],
    encounterIds: ["encounter-koro"], encounterParticipants: { "encounter-koro": ["koro"] },
    restorationStates: ["unvisited", "corrupted", "partial", "restored"],
    assetIds: [],
  };
  const boundary = buildCanopyBoundaryPlacements(base, {
    gates: [], arenas: [COURTYARD_ARENA], obstacles: [...CANOPY_AUTHORED_FOOTPRINTS, ...canopyPropFootprints(traversalProps)],
  });
  return { ...base, props: [...authoredProps, ...clusterBoundaryDressing(boundary)] };
}
