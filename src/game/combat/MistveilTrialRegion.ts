import { v } from '../../content/levels/schema.js';
import type { GroundSurfaceDefinition, RegionColliderDefinition, RegionDefinition, RegionEntityDefinition, RegionRouteDefinition, Vec3, WorldAssetPlacement } from '../contracts.js';
import { buildMistveilBoundaryPlacements } from '../../world/MistveilBoundary.js';
import { clusterBoundaryDressing } from '../../world/clusteredBoundaryDressing.js';
import { MISTVEIL_COMBAT_TRIALS, MISTVEIL_TRIAL_SET } from './MistveilContent.js';

/** Walk-surface id prefix of the Mistveil playtest variant; `biomeProfileFor` selects the Mistveil biome by it. */
export const MISTVEIL_SURFACE_PREFIX = 'mistveil-trial-';

/**
 * Mistveil Basin playtest layout (docs/features/mistveil-playtest.md): a one-way walk-mesh from the arrival mud bank (Reed
 * Shallows) over a ford and a raised root causeway to the foggy glade (Eyes in the Mist), on to Marek's extraction site beside
 * the Black Sap river and the polluted source (The Black River), and out to the root cavern. Everything off the walk-mesh is
 * wetland: pools and the river never lie under a walkable. The canonical region in later-acts.ts is not modified; this variant
 * replaces its ground, navigation, cameras, routes and entities and keeps its identity.
 */
const MUD = 'mistveil-mud-bank';
const ROOT = 'mistveil-root-causeway';
const FLOOR_THICKNESS = 0.45;
const CAUSEWAY_THICKNESS = 0.3;
/** Height of the raised root causeway over the wetland floor. */
const CAUSEWAY_Y = 1.2;
/** Conservative plan-view footprints (metres, at placement scale 1) of authored set dressing, handed to the boundary builder. */
const TREE_FOOTPRINT_RADIUS = 4;
const RIG_FOOTPRINT_RADIUS = 3.5;
const DRUM_FOOTPRINT_RADIUS = 1.3;
const MOUTH_FOOTPRINT_RADIUS = 4.5;
const REED_FOOTPRINT_RADIUS = 1.2;
const ROCK_FOOTPRINT_RADIUS = 2;

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
/** A ramp along +x; its support collider is a non-blocking centre-line segment as wide as the ramp. */
function ramp(id: string, points: readonly Vec3[]): WalkSurface {
  const box = bounds2(points), centreZ = (box.minZ + box.maxZ) / 2;
  const low = points.reduce((best, point) => point.y < best.y ? point : best), high = points.reduce((best, point) => point.y > best.y ? point : best);
  return {
    surface: { id, profile: 'ramp', points, elevation: (low.y + high.y) / 2, thickness: FLOOR_THICKNESS, walkable: true, material: ROOT, colliderId: id + '-collider' },
    collider: { id: id + '-collider', kind: 'segment', from: v(low.x, low.y, centreZ), to: v(high.x, high.y, centreZ), radius: (box.maxZ - box.minZ) / 2, blocksMovement: false, blocksCamera: false, walkSurfaceId: id },
  };
}
/** A chamfered rectangle (4 m corner cuts) spanning x0..x1, z0..z1 on the wetland floor: an arena-sized clearing. */
function clearing(id: string, x0: number, x1: number, z0: number, z1: number): WalkSurface {
  const c = 4;
  return flat(id, 'plane', MUD, FLOOR_THICKNESS, [v(x0 + c, 0, z0), v(x1 - c, 0, z0), v(x1, 0, z0 + c), v(x1, 0, z1 - c), v(x1 - c, 0, z1), v(x0 + c, 0, z1), v(x0, 0, z1 - c), v(x0, 0, z0 + c)]);
}
/** A 6 m wide straight path along +x at floor height (z -19..-13). */
const path = (id: string, x0: number, x1: number): WalkSurface => flat(id, 'plane', MUD, FLOOR_THICKNESS, [v(x0, 0, -19), v(x1, 0, -19), v(x1, 0, -13), v(x0, 0, -13)]);

const WALK_SURFACES: readonly WalkSurface[] = [
  // Arrival mud bank and Arena 1 (Reed Shallows): pools and reeds lie beyond every edge and are not walkable.
  clearing('mistveil-trial-bank', -72, -30, -26, -6),
  // The ford: Gate 1 seals it.
  path('mistveil-trial-ford', -30, -24),
  // The raised root causeway between the great root trees: a short ramp up, a level span, a short ramp down.
  ramp('mistveil-trial-causeway-rise', [v(-24, 0, -19), v(-20, CAUSEWAY_Y, -19), v(-20, CAUSEWAY_Y, -13), v(-24, 0, -13)]),
  flat('mistveil-trial-causeway', 'terrace', ROOT, CAUSEWAY_THICKNESS, [v(-20, CAUSEWAY_Y, -19), v(-8, CAUSEWAY_Y, -19), v(-8, CAUSEWAY_Y, -13), v(-20, CAUSEWAY_Y, -13)]),
  ramp('mistveil-trial-causeway-fall', [v(-8, CAUSEWAY_Y, -19), v(-4, 0, -19), v(-4, 0, -13), v(-8, CAUSEWAY_Y, -13)]),
  // The foggy glade and Arena 2 (Eyes in the Mist).
  clearing('mistveil-trial-glade', -4, 24, -28, -4),
  // The reed way: Gate 2 seals it.
  path('mistveil-trial-reedway', 24, 30),
  // Marek's extraction site: the pad beside the Black Sap river.
  clearing('mistveil-trial-pad', 30, 52, -26, -6),
  path('mistveil-trial-neck', 52, 58),
  // The polluted source and Arena 3 (The Black River).
  clearing('mistveil-trial-source', 58, 86, -28, -4),
  // The cavern path: Gate 3 seals it, then it opens onto the landing before the root cavern.
  path('mistveil-trial-pass', 86, 92),
  flat('mistveil-trial-landing', 'plane', MUD, FLOOR_THICKNESS, [v(92, 0, -21), v(102, 0, -21), v(102, 0, -11), v(92, 0, -11)]),
];

const NAVIGATION_NODES: RegionDefinition['navigation']['nodes'] = [
  { id: 'mistveil-trial-start', position: v(-70, 0, -16), links: ['mistveil-trial-bank'] },
  { id: 'mistveil-trial-bank', position: v(-44, 0, -16), links: ['mistveil-trial-start', 'mistveil-trial-ford'] },
  { id: 'mistveil-trial-ford', position: v(-27, 0, -16), links: ['mistveil-trial-bank', 'mistveil-trial-causeway'] },
  { id: 'mistveil-trial-causeway', position: v(-14, CAUSEWAY_Y, -16), links: ['mistveil-trial-ford', 'mistveil-trial-glade'] },
  { id: 'mistveil-trial-glade', position: v(10, 0, -16), links: ['mistveil-trial-causeway', 'mistveil-trial-reedway'] },
  { id: 'mistveil-trial-reedway', position: v(27, 0, -16), links: ['mistveil-trial-glade', 'mistveil-trial-pad'] },
  { id: 'mistveil-trial-pad', position: v(41, 0, -16), links: ['mistveil-trial-reedway', 'mistveil-trial-source'] },
  { id: 'mistveil-trial-source', position: v(72, 0, -16), links: ['mistveil-trial-pad', 'mistveil-trial-pass'] },
  { id: 'mistveil-trial-pass', position: v(89, 0, -16), links: ['mistveil-trial-source', 'mistveil-trial-landing'] },
  { id: 'mistveil-trial-landing', position: v(99, 0, -16), links: ['mistveil-trial-pass'] },
];

const NAVIGATION_RIBBONS: RegionDefinition['navigation']['ribbons'] = [
  { id: 'mistveil-trial-bank-route', points: [v(-70, 0, -16), v(-44, 0, -16), v(-27, 0, -16), v(-24, 0, -16)], width: 3.2, depthBand: 'ground' },
  { id: 'mistveil-trial-causeway-route', points: [v(-24, 0, -16), v(-20, CAUSEWAY_Y, -16), v(-8, CAUSEWAY_Y, -16), v(-4, 0, -16)], width: 2.8, depthBand: 'root-to-canopy' },
  { id: 'mistveil-trial-basin-route', points: [v(-4, 0, -16), v(10, 0, -16), v(27, 0, -16), v(41, 0, -16), v(58, 0, -16), v(72, 0, -16), v(89, 0, -16), v(99, 0, -16)], width: 3.2, depthBand: 'ground' },
];

/** Cameras keep the locked three-quarter offset (+10, +12, +14) from the point they frame. */
const camera = (id: string, look: Vec3, mode: RegionDefinition['cameraAnchors'][number]['mode']): RegionDefinition['cameraAnchors'][number] =>
  ({ id, position: v(look.x + 10, look.y + 12, look.z + 14), lookAt: look, mode });
const CAMERA_ANCHORS: RegionDefinition['cameraAnchors'] = [
  camera('mistveil-trial-arrival-rail', v(-66, 0, -16), 'exploration'),
  camera('mistveil-trial-bank-rail', v(-44, 0, -16), 'encounter'),
  camera('mistveil-trial-causeway-rail', v(-14, CAUSEWAY_Y, -16), 'exploration'),
  camera('mistveil-trial-glade-rail', v(10, 0, -16), 'encounter'),
  camera('mistveil-trial-pad-rail', v(41, 0, -16), 'story'),
  camera('mistveil-trial-source-rail', v(72, 0, -16), 'encounter'),
  camera('mistveil-trial-exit-rail', v(99, 0, -16), 'exploration'),
];

const prop = (id: string, assetId: string, position: Vec3, rotationY: number, scale: Vec3 = v(1, 1, 1)): WorldAssetPlacement =>
  ({ id, assetId, position, placement: 'ground', rotationY, scale });

/**
 * Authored set dressing: great root trees stand either side of the causeway, reeds frame the arrival bank, and low rocks
 * offer jumpable crowns at the combat clearings. Marek's rig and filter drum stand between the pad and the Black Sap river,
 * with the root cavern's mouth beyond the landing.
 */
const AUTHORED_PROPS: readonly WorldAssetPlacement[] = [
  prop('mistveil-trial-tree-0', 'prop-mistveil-root-tree', v(-17, 0, -26), 0.4),
  prop('mistveil-trial-tree-1', 'prop-mistveil-root-tree', v(-9, 0, -30), 2.1),
  prop('mistveil-trial-tree-2', 'prop-mistveil-root-tree', v(-14, 0, -7.5), 4.3),
  prop('mistveil-trial-tree-3', 'prop-mistveil-root-tree', v(-9, 0, -5.5), 1.2),
  prop('mistveil-trial-tree-4', 'prop-mistveil-root-tree', v(8, 0, -35), 3.4),
  prop('mistveil-trial-reeds-0', 'prop-mistveil-reed-cluster', v(-50, 0, -30), 0.3),
  prop('mistveil-trial-reeds-1', 'prop-mistveil-reed-cluster', v(-38, 0, -30), 1.9),
  prop('mistveil-trial-reeds-2', 'prop-mistveil-reed-cluster', v(-58, 0, -28), 4.0),
  prop('mistveil-trial-reeds-3', 'prop-mistveil-reed-cluster', v(-54, 0, -2), 2.6),
  prop('mistveil-trial-rock-0', 'prop-mire-bank-rock', v(12, 0, -23.5), 0.8, v(.7, .7, .7)),
  prop('mistveil-trial-rock-1', 'prop-mire-bank-rock', v(-45, 0, -23.5), 2.4, v(.7, .7, .7)),
  prop('mistveil-trial-rig', 'prop-hunter-extraction-rig', v(41, 0, -32), 0.6),
  prop('mistveil-trial-drum', 'prop-black-sap-filter-drum', v(49, 0, -31), 1.4),
  prop('mistveil-trial-cavern-mouth', 'prop-root-cavern-mouth', v(107, 0, -16), -Math.PI / 2),
];

const FOOTPRINT_RADIUS: Readonly<Record<string, number>> = {
  'prop-mistveil-root-tree': TREE_FOOTPRINT_RADIUS,
  'prop-hunter-extraction-rig': RIG_FOOTPRINT_RADIUS,
  'prop-black-sap-filter-drum': DRUM_FOOTPRINT_RADIUS,
  'prop-root-cavern-mouth': MOUTH_FOOTPRINT_RADIUS,
  'prop-mistveil-reed-cluster': REED_FOOTPRINT_RADIUS,
  'prop-mire-bank-rock': ROCK_FOOTPRINT_RADIUS,
};
/** Plan-view circles of the authored set dressing, handed to the boundary builder as keep-clear obstacles. */
const AUTHORED_FOOTPRINTS = AUTHORED_PROPS.map(placement => ({ x: placement.position.x, z: placement.position.z, radius: placement.assetId === 'prop-mire-bank-rock' ? 1.5 : FOOTPRINT_RADIUS[placement.assetId]! }));

/** Bounds of the playtest variant: the walk-mesh, the river and the pools, with the camera-far wetland behind them. */
const BOUNDS: RegionDefinition['bounds'] = { min: v(-88, -8, -66), max: v(122, 14, 22) };

/** Authored Mistveil Basin playtest geometry, route, exit, entities and props for the combat trials. */
export function createMistveilTrialRegion(authored: RegionDefinition): RegionDefinition {
  const entities: readonly RegionEntityDefinition[] = MISTVEIL_COMBAT_TRIALS.map((trial): RegionEntityDefinition => ({
    id: trial.monsterId, actorId: trial.monsterId, kind: 'actor', position: trial.monsterPosition, assetId: trial.monsterAssetId, placement: 'ground',
  }));
  const template = authored.exits.find(route => route.id === 'mistveil-hidden-route-out');
  if (!template) throw new Error('The Mistveil playtest needs the authored mistveil-hidden-route-out route as its exit template.');
  const { unlockFact: _locked, ...openRoute } = template;
  const exitFrom = v(99, 0, -16);
  const trialExit: RegionRouteDefinition = { ...openRoute, id: 'mistveil-trial-exit', from: exitFrom, anchors: [exitFrom, template.to], colliderIds: [] };
  const base: RegionDefinition = {
    ...authored,
    bounds: BOUNDS,
    props: AUTHORED_PROPS,
    movableObjects: [],
    fieldTraps: [],
    ground: {
      y: 0, profile: 'basin', navGraphId: 'mistveil-trial-nav',
      surfaces: WALK_SURFACES.map(entry => entry.surface), colliders: WALK_SURFACES.map(entry => entry.collider),
    },
    navigation: { nodes: NAVIGATION_NODES, ribbons: NAVIGATION_RIBBONS },
    cameraAnchors: CAMERA_ANCHORS,
    entrances: [],
    exits: [trialExit],
    traversalArcs: [],
    entities,
    encounterIds: [MISTVEIL_TRIAL_SET.encounterId],
    encounterParticipants: { [MISTVEIL_TRIAL_SET.encounterId]: MISTVEIL_COMBAT_TRIALS.map(trial => trial.monsterId) },
  };
  const boundary = buildMistveilBoundaryPlacements(base, {
    gates: MISTVEIL_COMBAT_TRIALS.map(trial => trial.gate), arenas: MISTVEIL_COMBAT_TRIALS.map(trial => trial.arena), obstacles: AUTHORED_FOOTPRINTS,
  });
  const props = [...AUTHORED_PROPS, ...clusterBoundaryDressing(boundary)];
  const assetIds = [...new Set([...entities.flatMap(entity => entity.assetId ? [entity.assetId] : []), ...props.map(placement => placement.assetId)])];
  return { ...base, props, assetIds };
}
