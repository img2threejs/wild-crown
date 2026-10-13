import { v } from '../../content/levels/schema.js';
import type { GroundSurfaceDefinition, RegionColliderDefinition, RegionDefinition, RegionEntityDefinition, RegionRouteDefinition, Vec3, WorldAssetPlacement } from '../contracts.js';
import { buildMoonpineBoundaryPlacements } from '../../world/MoonpineBoundary.js';
import { MOONPINE_LAKE_MATERIAL, MOONPINE_SHELF } from '../../world/MoonpineTerrain.js';
import { MOONPINE_CHAIN_ANCHORS, MOONPINE_COMBAT_TRIALS, MOONPINE_TRIAL_SET } from './MoonpineContent.js';

/** Walk-surface id prefix of the Moonpine playtest variant; `biomeProfileFor` selects the Moonpine biome by it. */
export const MOONPINE_SURFACE_PREFIX = 'moonpine-trial-';

/**
 * Moonpine Ridge playtest layout (docs/features/moonpine-playtest.md): a one-way walk-mesh from the snowy pine trail over the
 * frozen-lake shelf and a log bridge across the gorge to the pine hollow, up the stair to the temple terrace and down the other
 * side to the exit towards Mistveil. The canonical region in later-acts.ts is not modified; this variant replaces its ground,
 * navigation, cameras, routes and entities and keeps its identity.
 */
const SNOW_TRAIL = 'moonpine-trail-snow';
const LAKE_ICE = MOONPINE_LAKE_MATERIAL;
const BRIDGE_DECK = 'moonpine-bridge-deck';
const TEMPLE_FLAGS = 'moonpine-temple-flags';
const FLOOR_THICKNESS = 0.45;
const DECK_THICKNESS = 0.3;
/** The log-bridge model is about 12 m long along local +z; the placement scale stretches it to the authored span. */
const BRIDGE_MODEL_LENGTH = 12;
/** Conservative plan-view footprints (metres, at placement scale 1) of authored set dressing, handed to the boundary builder. */
const PINE_FOOTPRINT_RADIUS = 3;
const TEMPLE_FOOTPRINT_RADIUS = 9;
const ROCK_FOOTPRINT_RADIUS = 2.5;
const ANCHOR_FOOTPRINT_RADIUS = 0.8;

type SurfaceProfile = GroundSurfaceDefinition['profile'];
interface WalkSurface { readonly surface: GroundSurfaceDefinition; readonly collider: RegionColliderDefinition }

const bounds2 = (points: readonly Vec3[]) => ({
  minX: Math.min(...points.map(point => point.x)), maxX: Math.max(...points.map(point => point.x)),
  minZ: Math.min(...points.map(point => point.z)), maxZ: Math.max(...points.map(point => point.z)),
});

/** A flat walk surface with a thin support slab under it (top flush with the floor) covering the polygon's bounding box. */
function flat(id: string, profile: SurfaceProfile, material: string, thickness: number, points: readonly Vec3[]): WalkSurface {
  const elevation = points[0]!.y, box = bounds2(points);
  return {
    surface: { id, profile, points, elevation, thickness, walkable: true, material, colliderId: id + '-collider' },
    collider: {
      id: id + '-collider', kind: 'box', from: v((box.minX + box.maxX) / 2, elevation - thickness / 2, (box.minZ + box.maxZ) / 2),
      halfExtents: v((box.maxX - box.minX) / 2, thickness / 2, (box.maxZ - box.minZ) / 2), blocksMovement: true, blocksCamera: false, walkSurfaceId: id,
    },
  };
}
/** A ramp; its support collider is a non-blocking centre-line segment as wide as the ramp (`along` is the rising axis). */
function ramp(id: string, along: 'x' | 'z', points: readonly Vec3[]): WalkSurface {
  const box = bounds2(points);
  const low = points.reduce((best, point) => point.y < best.y ? point : best), high = points.reduce((best, point) => point.y > best.y ? point : best);
  const centre = along === 'x' ? (box.minZ + box.maxZ) / 2 : (box.minX + box.maxX) / 2, width = along === 'x' ? box.maxZ - box.minZ : box.maxX - box.minX;
  const end = (point: Vec3): Vec3 => along === 'x' ? v(point.x, point.y, centre) : v(centre, point.y, point.z);
  return {
    surface: { id, profile: 'ramp', points, elevation: (low.y + high.y) / 2, thickness: FLOOR_THICKNESS, walkable: true, material: SNOW_TRAIL, colliderId: id + '-collider' },
    collider: { id: id + '-collider', kind: 'segment', from: end(low), to: end(high), radius: width / 2, blocksMovement: false, blocksCamera: false, walkSurfaceId: id },
  };
}

// Corridors are 6.5 m wide (edges on the terrain's 0.25 m grid, so ramp edges stay exact) so a 9 m gate box leaves 1.25 m of void on each side. Octagons (arenas) have an apothem of 10 m
// (hollow, shelf) and 11 m (terrace) around the 8 m dodge arenas.
const WALK_SURFACES: readonly WalkSurface[] = [
  // Arrival from the Grove: a snowy pine trail, joined to the lake shelf along x = -56.
  flat('moonpine-trial-trail', 'terrace', SNOW_TRAIL, FLOOR_THICKNESS, [v(-72, 0, -24), v(-68, 0, -27), v(-56, 0, -27), v(-56, 0, -17), v(-68, 0, -17), v(-72, 0, -20)]),
  // Arena 1: the walkable frozen-lake shelf (the lake itself lies north of it and is not walkable).
  flat('moonpine-trial-lake-shelf', 'plane', LAKE_ICE, FLOOR_THICKNESS, MOONPINE_SHELF.map(point => v(point.x, 0, point.z))),
  // Shore path to the gorge rim; gate 1 crosses it.
  flat('moonpine-trial-shore-path', 'terrace', SNOW_TRAIL, FLOOR_THICKNESS, [v(-36, 0, -25.25), v(-14, 0, -25.25), v(-14, 0, -18.75), v(-36, 0, -18.75)]),
  // The log bridge over the gorge (not terrain-backed: the model is the deck, the gorge is carved beneath it).
  flat('moonpine-trial-log-bridge', 'ridge', BRIDGE_DECK, DECK_THICKNESS, [v(-14, 0, -23.6), v(-4, 0, -23.6), v(-4, 0, -20.4), v(-14, 0, -20.4)]),
  // Arena 2: the pine hollow, then the path to the temple stair; gate 2 crosses the path.
  flat('moonpine-trial-hollow', 'terrace', SNOW_TRAIL, FLOOR_THICKNESS, [v(-4, 0, -26.1), v(1.9, 0, -32), v(10.1, 0, -32), v(16, 0, -26.1), v(16, 0, -17.9), v(10.1, 0, -12), v(1.9, 0, -12), v(-4, 0, -17.9)]),
  flat('moonpine-trial-hollow-path', 'terrace', SNOW_TRAIL, FLOOR_THICKNESS, [v(16, 0, -25.25), v(24, 0, -25.25), v(24, 0, -18.75), v(16, 0, -18.75)]),
  ramp('moonpine-trial-temple-stair', 'x', [v(24, 0, -25.25), v(36, 4, -25.25), v(36, 4, -18.75), v(24, 0, -18.75)]),
  // Arena 3: the temple terrace in front of the buried temple, and the path south from it; gate 3 crosses the path.
  flat('moonpine-trial-temple-terrace', 'terrace', TEMPLE_FLAGS, DECK_THICKNESS, [v(36, 4, -26.6), v(42.4, 4, -33), v(51.6, 4, -33), v(58, 4, -26.6), v(58, 4, -17.4), v(51.6, 4, -11), v(42.4, 4, -11), v(36, 4, -17.4)]),
  flat('moonpine-trial-temple-path', 'terrace', TEMPLE_FLAGS, DECK_THICKNESS, [v(43.75, 4, -11), v(50.25, 4, -11), v(50.25, 4, -1), v(43.75, 4, -1)]),
  // The Temple Descent: a ramp down the far side of the ridge to the exit landing.
  ramp('moonpine-trial-temple-descent', 'z', [v(43.75, 4, -1), v(50.25, 4, -1), v(50.25, 0, 11), v(43.75, 0, 11)]),
  flat('moonpine-trial-exit-landing', 'terrace', SNOW_TRAIL, FLOOR_THICKNESS, [v(43.75, 0, 11), v(50.25, 0, 11), v(50.25, 0, 19), v(43.75, 0, 19)]),
];

const NAVIGATION_NODES: RegionDefinition['navigation']['nodes'] = [
  { id: 'moonpine-trial-start', position: v(-66, 0, -22), links: ['moonpine-trial-shore'] },
  { id: 'moonpine-trial-shore', position: v(-46, 0, -22), links: ['moonpine-trial-start', 'moonpine-trial-shore-path'] },
  { id: 'moonpine-trial-shore-path', position: v(-29, 0, -22), links: ['moonpine-trial-shore', 'moonpine-trial-gorge-rim'] },
  { id: 'moonpine-trial-gorge-rim', position: v(-18, 0, -22), links: ['moonpine-trial-shore-path', 'moonpine-trial-log-bridge'] },
  { id: 'moonpine-trial-log-bridge', position: v(-9, 0, -22), links: ['moonpine-trial-gorge-rim', 'moonpine-trial-hollow'] },
  { id: 'moonpine-trial-hollow', position: v(6, 0, -22), links: ['moonpine-trial-log-bridge', 'moonpine-trial-hollow-path'] },
  { id: 'moonpine-trial-hollow-path', position: v(20, 0, -22), links: ['moonpine-trial-hollow', 'moonpine-trial-stair'] },
  { id: 'moonpine-trial-stair', position: v(30, 2, -22), links: ['moonpine-trial-hollow-path', 'moonpine-trial-terrace'] },
  { id: 'moonpine-trial-terrace', position: v(47, 4, -22), links: ['moonpine-trial-stair', 'moonpine-trial-temple-path'] },
  { id: 'moonpine-trial-temple-path', position: v(47, 4, -6), links: ['moonpine-trial-terrace', 'moonpine-trial-descent'] },
  { id: 'moonpine-trial-descent', position: v(47, 2, 5), links: ['moonpine-trial-temple-path', 'moonpine-trial-exit-landing'] },
  { id: 'moonpine-trial-exit-landing', position: v(47, 0, 15), links: ['moonpine-trial-descent'] },
];

const NAVIGATION_RIBBONS: RegionDefinition['navigation']['ribbons'] = [
  { id: 'moonpine-trial-snow-trail', points: [v(-66, 0, -22), v(-58, 0, -22)], width: 3.2, depthBand: 'ground' },
  // No ribbon crosses the lake shelf: the trail is not worn into ice, and no trail dressing lies on it.
  { id: 'moonpine-trial-shore-route', points: [v(-34, 0, -22), v(-29, 0, -22), v(-14, 0, -22)], width: 3.2, depthBand: 'ground' },
  { id: 'moonpine-trial-log-route', points: [v(-14, 0, -22), v(-4, 0, -22)], width: 2.6, depthBand: 'ground' },
  { id: 'moonpine-trial-ridge-route', points: [v(-4, 0, -22), v(6, 0, -22), v(24, 0, -22), v(36, 4, -22), v(47, 4, -22)], width: 3.2, depthBand: 'ground' },
  { id: 'moonpine-trial-temple-route', points: [v(47, 4, -22), v(47, 4, -1), v(47, 0, 11), v(47, 0, 15)], width: 3.2, depthBand: 'ground' },
];

/** Cameras keep the locked three-quarter offset (+10, +12, +14) from the point they frame. */
const camera = (id: string, look: Vec3, mode: RegionDefinition['cameraAnchors'][number]['mode']): RegionDefinition['cameraAnchors'][number] =>
  ({ id, position: v(look.x + 10, look.y + 12, look.z + 14), lookAt: look, mode });
const CAMERA_ANCHORS: RegionDefinition['cameraAnchors'] = [
  camera('moonpine-trial-trail-rail', v(-62, 0, -22), 'exploration'),
  camera('moonpine-trial-shore-rail', v(-46, 0, -22), 'encounter'),
  camera('moonpine-trial-gorge-rail', v(-9, 0, -22), 'exploration'),
  camera('moonpine-trial-hollow-rail', v(6, 0, -22), 'encounter'),
  camera('moonpine-trial-terrace-rail', v(47, 4, -22), 'encounter'),
  camera('moonpine-trial-exit-rail', v(47, 0, 15), 'exploration'),
];

const prop = (id: string, assetId: string, position: Vec3, placement: WorldAssetPlacement['placement'], rotationY: number, scale: Vec3): WorldAssetPlacement =>
  ({ id, assetId, position, placement, rotationY, scale });

/** The log bridge runs along world +x: local +z of the model maps to +x with `rotationY = pi/2`, stretched to the authored span. */
const bridge = (id: string, fromX: number, toX: number, z: number): WorldAssetPlacement =>
  prop(id, 'prop-moonpine-log-bridge', v((fromX + toX) / 2, 0, z), 'elevated', Math.PI / 2, v(1, 1, (toX - fromX) / BRIDGE_MODEL_LENGTH));

/**
 * Pines outside the walk-mesh, all on the far side of the route from the camera (north and west), so a trunk never fills the
 * foreground. The y 4 pines stand on the temple plateau (elevated placement), the rest on the valley floor.
 */
const PINES: readonly Vec3[] = [v(-78, 0, -30), v(-70, 0, -36), v(-24, 0, -38), v(12, 0, -42), v(24, 0, -42), v(39, 4, -50), v(56, 4, -50)];
/** Snow ridge rocks of Scout's Hollow, around the hollow's far (north) rim. */
const HOLLOW_ROCKS: readonly Vec3[] = [v(-2, 0, -33.5), v(12, 0, -37.5), v(18, 0, -34.5)];

const AUTHORED_PROPS: readonly WorldAssetPlacement[] = [
  bridge('moonpine-trial-bridge', -14.6, -3.4, -22),
  prop('moonpine-trial-temple', 'prop-buried-wolf-temple', v(47, 4, -45), 'elevated', 0, v(1, 1, 1)),
  ...MOONPINE_CHAIN_ANCHORS.map((position, index) => prop('moonpine-trial-chain-anchor-' + index, 'prop-temple-chain-anchor', v(position.x, position.y, position.z), 'elevated', index * 1.7, v(1, 1, 1))),
  ...HOLLOW_ROCKS.map((position, index) => prop('moonpine-trial-rock-' + index, 'prop-snow-ridge-rock', position, 'ground', index * 2.1, v(1, 1, 1))),
  ...PINES.map((position, index) => prop('moonpine-trial-pine-' + index, 'prop-moonpine-tree', position, position.y === 0 ? 'ground' : 'elevated', index * 2.399, v(1, 1, 1))),
];

/** Plan-view circles of the authored set dressing that stays in place (the bridge is covered by the walk-mesh itself). */
const FOOTPRINT_RADIUS: Readonly<Record<string, number>> = {
  'prop-moonpine-tree': PINE_FOOTPRINT_RADIUS, 'prop-buried-wolf-temple': TEMPLE_FOOTPRINT_RADIUS,
  'prop-snow-ridge-rock': ROCK_FOOTPRINT_RADIUS, 'prop-temple-chain-anchor': ANCHOR_FOOTPRINT_RADIUS,
};
const AUTHORED_FOOTPRINTS = AUTHORED_PROPS.flatMap(placement => {
  const radius = FOOTPRINT_RADIUS[placement.assetId];
  return radius === undefined ? [] : [{ x: placement.position.x, z: placement.position.z, radius }];
});

/** Authored Moonpine Ridge playtest geometry, route, exit, entities and props for the combat trials. */
export function createMoonpineTrialRegion(authored: RegionDefinition): RegionDefinition {
  const entities: readonly RegionEntityDefinition[] = [
    { id: 'moonpine-vara', actorId: 'vara', kind: 'actor', position: v(-69, 0, -21), assetId: 'actor-vara', placement: 'ground' },
    ...MOONPINE_COMBAT_TRIALS.map((trial): RegionEntityDefinition => ({
      id: trial.monsterId, actorId: trial.monsterId, kind: 'actor', position: trial.monsterPosition, assetId: trial.monsterAssetId, placement: trial.monsterPosition.y > 0 ? 'elevated' : 'ground',
    })),
  ];
  const template = authored.exits.find(route => route.id === 'ridge-mist-out');
  if (!template) throw new Error('The Moonpine Ridge playtest needs the authored ridge-mist-out route as its exit template.');
  const { unlockFact: _locked, ...openRoute } = template;
  const exitFrom = v(47, 0, 15);
  const trialExit: RegionRouteDefinition = { ...openRoute, id: 'moonpine-trial-exit', from: exitFrom, anchors: [exitFrom, template.to], colliderIds: [] };
  const base: RegionDefinition = {
    ...authored,
    props: AUTHORED_PROPS,
    movableObjects: [],
    ground: {
      y: 0, profile: 'ridge', navGraphId: 'moonpine-trial-nav',
      surfaces: WALK_SURFACES.map(entry => entry.surface), colliders: WALK_SURFACES.map(entry => entry.collider),
    },
    navigation: { nodes: NAVIGATION_NODES, ribbons: NAVIGATION_RIBBONS },
    cameraAnchors: CAMERA_ANCHORS,
    entrances: [],
    exits: [trialExit],
    traversalArcs: [],
    entities,
    encounterIds: [MOONPINE_TRIAL_SET.encounterId],
    encounterParticipants: { [MOONPINE_TRIAL_SET.encounterId]: MOONPINE_COMBAT_TRIALS.map(trial => trial.monsterId) },
  };
  const boundary = buildMoonpineBoundaryPlacements(base, {
    gates: MOONPINE_COMBAT_TRIALS.map(trial => trial.gate), arenas: MOONPINE_COMBAT_TRIALS.map(trial => trial.arena), obstacles: AUTHORED_FOOTPRINTS,
  });
  const props = [...AUTHORED_PROPS, ...boundary];
  const assetIds = [...new Set([...entities.flatMap(entity => entity.assetId ? [entity.assetId] : []), ...props.map(placement => placement.assetId)])];
  return { ...base, props, assetIds };
}
