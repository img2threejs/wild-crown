import { v } from '../../content/levels/schema.js';
import type { GroundSurfaceDefinition, RegionColliderDefinition, RegionDefinition, RegionEntityDefinition, RegionRouteDefinition, Vec3, WorldAssetPlacement } from '../contracts.js';
import { buildGroveBoundaryPlacements } from '../../world/GroveBoundary.js';
import { GROVE_COMBAT_TRIALS, GROVE_TRIAL_SET } from './GroveContent.js';

/** Walk-surface id prefix of the Grove playtest variant; `biomeProfileFor` selects the Grove biome by it. */
export const GROVE_SURFACE_PREFIX = 'grove-trial-';

/**
 * Grove playtest layout (docs/features/grove-playtest.md): a sunlit meadow sanctuary. The player arrives at the south trailhead,
 * crosses the central glade (the young Heartroot on its mound and the pond to the north, Yara's camp to the west, the monkey
 * lookouts and Koro to the east) and leaves by the north trail (the Ridge Trail). The optional evasion-practice ring lies north-west
 * beyond the camp; its gate seals only the short spur to the Memory Pool overlook, never the way to the exit. The canonical region
 * in act-i.ts is not modified; this variant replaces its ground, navigation, cameras, routes and entities and keeps its identity.
 */
const EARTH = 'grove-trail-earth';
const OVERLOOK_STONE = 'grove-overlook-stone';
const FLOOR_THICKNESS = 0.45;
/** Conservative plan-view footprints (metres, at placement scale 1) of authored set dressing, handed to the boundary builder. */
const HEARTROOT_FOOTPRINT_RADIUS = 3;
const TENT_FOOTPRINT_RADIUS = 2.6;
const LOOKOUT_FOOTPRINT_RADIUS = 3;
const BASIN_FOOTPRINT_RADIUS = 2.6;
const POST_FOOTPRINT_RADIUS = 0.8;

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

const rect = (minX: number, minZ: number, maxX: number, maxZ: number): Vec3[] => [v(minX, 0, minZ), v(maxX, 0, minZ), v(maxX, 0, maxZ), v(minX, 0, maxZ)];
/** A regular polygon (centimetre-rounded), first vertex due east of the centre. */
const ngon = (cx: number, cz: number, radius: number, sides: number): Vec3[] =>
  Array.from({ length: sides }, (_, index) => v(Math.round((cx + Math.cos(index / sides * Math.PI * 2) * radius) * 100) / 100, 0, Math.round((cz + Math.sin(index / sides * Math.PI * 2) * radius) * 100) / 100));

/** The practice ring: centre of its walkable clearing; the arena (radius 8) lies inside it and the training posts frame its rim. */
const RING_CENTRE = { x: -24, z: -22 } as const;

const WALK_SURFACES: readonly WalkSurface[] = [
  // South trailhead: where the player arrives from the Whispering Canopy.
  flat('grove-trial-trailhead', 'terrace', EARTH, FLOOR_THICKNESS, rect(5, 26, 15, 48)),
  // Central glade. The young Heartroot's mound and the pond lie beyond its straight north edge (z -5), not inside it.
  flat('grove-trial-glade', 'terrace', EARTH, FLOOR_THICKNESS, [v(-12, 0, 2), v(-8, 0, -5), v(17, 0, -5), v(24, 0, 0), v(24, 0, 20), v(16, 0, 29), v(0, 0, 29), v(-10, 0, 22), v(-13, 0, 12)]),
  // Yara's camp (west of the glade) and the lookout pad (east of it).
  flat('grove-trial-camp', 'terrace', EARTH, FLOOR_THICKNESS, rect(-34, -4, -12, 16)),
  flat('grove-trial-lookout-pad', 'terrace', EARTH, FLOOR_THICKNESS, rect(18, -6, 34, 18)),
  // The north trail to the stage exit.
  flat('grove-trial-north-trail', 'terrace', EARTH, FLOOR_THICKNESS, rect(19, -48, 27, -4)),
  // The way from the camp to the practice ring, the ring itself and the gated spur to the Memory Pool overlook.
  flat('grove-trial-ring-path', 'terrace', EARTH, FLOOR_THICKNESS, rect(-28, -13, -20, -3)),
  flat('grove-trial-practice-ring', 'terrace', EARTH, FLOOR_THICKNESS, ngon(RING_CENTRE.x, RING_CENTRE.z, 10.5, 16)),
  flat('grove-trial-pool-spur', 'terrace', EARTH, FLOOR_THICKNESS, rect(-27, -49, -21, -31)),
  flat('grove-trial-pool-overlook', 'terrace', OVERLOOK_STONE, FLOOR_THICKNESS, rect(-31, -54, -17, -46)),
];

const NAVIGATION_NODES: RegionDefinition['navigation']['nodes'] = [
  { id: 'grove-trial-start', position: v(10, 0, 44), links: ['grove-trial-trailhead'] },
  { id: 'grove-trial-trailhead', position: v(10, 0, 31), links: ['grove-trial-start', 'grove-trial-glade-south'] },
  { id: 'grove-trial-glade-south', position: v(8, 0, 21), links: ['grove-trial-trailhead', 'grove-trial-glade'] },
  { id: 'grove-trial-glade', position: v(7, 0, 8), links: ['grove-trial-glade-south', 'grove-trial-glade-east', 'grove-trial-glade-west'] },
  { id: 'grove-trial-glade-east', position: v(17, 0, 0), links: ['grove-trial-glade', 'grove-trial-lookouts', 'grove-trial-trail-foot'] },
  { id: 'grove-trial-lookouts', position: v(26, 0, 5), links: ['grove-trial-glade-east', 'grove-trial-trail-foot'] },
  { id: 'grove-trial-trail-foot', position: v(23, 0, -8), links: ['grove-trial-glade-east', 'grove-trial-lookouts', 'grove-trial-trail-mid'] },
  { id: 'grove-trial-trail-mid', position: v(23, 0, -27), links: ['grove-trial-trail-foot', 'grove-trial-exit-landing'] },
  { id: 'grove-trial-exit-landing', position: v(23, 0, -44), links: ['grove-trial-trail-mid'] },
  { id: 'grove-trial-glade-west', position: v(-8, 0, 3), links: ['grove-trial-glade', 'grove-trial-camp'] },
  { id: 'grove-trial-camp', position: v(-22, 0, 3), links: ['grove-trial-glade-west', 'grove-trial-ring-path'] },
  { id: 'grove-trial-ring-path', position: v(-24, 0, -8), links: ['grove-trial-camp', 'grove-trial-practice-ring'] },
  { id: 'grove-trial-practice-ring', position: v(-24, 0, -19), links: ['grove-trial-ring-path', 'grove-trial-pool-gate'] },
  { id: 'grove-trial-pool-gate', position: v(-24, 0, -34), links: ['grove-trial-practice-ring', 'grove-trial-pool-overlook'] },
  { id: 'grove-trial-pool-overlook', position: v(-24, 0, -47), links: ['grove-trial-pool-gate'] },
];

const NAVIGATION_RIBBONS: RegionDefinition['navigation']['ribbons'] = [
  // Spawn to the stage exit: the whole of the required route.
  { id: 'grove-trial-main-route', points: [v(10, 0, 44), v(10, 0, 31), v(8, 0, 21), v(8, 0, 8), v(17, 0, 0), v(23, 0, -8), v(23, 0, -27), v(23, 0, -44)], width: 3.2, depthBand: 'ground' },
  // The optional branch: glade, camp, practice ring and the gated spur to the Memory Pool.
  { id: 'grove-trial-camp-route', points: [v(8, 0, 8), v(-8, 0, 3), v(-22, 0, 3), v(-24, 0, -8), v(-24, 0, -19)], width: 2.8, depthBand: 'ground' },
  { id: 'grove-trial-pool-route', points: [v(-24, 0, -19), v(-24, 0, -34), v(-24, 0, -47)], width: 2.6, depthBand: 'ground' },
];

/** Cameras keep the locked three-quarter offset (+10, +12, +14) from the point they frame. */
const camera = (id: string, look: Vec3, mode: RegionDefinition['cameraAnchors'][number]['mode']): RegionDefinition['cameraAnchors'][number] =>
  ({ id, position: v(look.x + 10, look.y + 12, look.z + 14), lookAt: look, mode });
const CAMERA_ANCHORS: RegionDefinition['cameraAnchors'] = [
  camera('grove-trial-arrival-rail', v(10, 0, 38), 'exploration'),
  camera('grove-trial-glade-rail', v(6, 0, 8), 'story'),
  camera('grove-trial-camp-rail', v(-22, 0, 3), 'story'),
  camera('grove-trial-lookout-rail', v(27, 0, 5), 'story'),
  camera('grove-trial-practice-rail', v(-24, 0, -22), 'encounter'),
  camera('grove-trial-overlook-rail', v(-24, 0, -48), 'story'),
  camera('grove-trial-exit-rail', v(23, 0, -44), 'exploration'),
];

const prop = (id: string, assetId: string, position: Vec3, placement: WorldAssetPlacement['placement'], rotationY: number, scale: Vec3): WorldAssetPlacement =>
  ({ id, assetId, position, placement, rotationY, scale });

/** Posts frame the practice ring's rim: two flank the spur opening to the north, two stand on its west and east sides. */
const POST_POSITIONS: readonly Vec3[] = [v(-31, 0, -28.5), v(-17, 0, -28.5), v(-32.5, 0, -18), v(-15.5, 0, -18)];

const AUTHORED_PROPS: readonly WorldAssetPlacement[] = [
  // The young Heartroot (9 m) rises on a low mound beside the pond; the mound itself is terrain relief (GroveTerrain).
  prop('grove-trial-heartroot', 'prop-heartroot-trunk', v(-2, 0, -13), 'ground', 0, v(1, 1, 1)),
  prop('grove-trial-tent', 'prop-refuge-shelter', v(-29, 0, 7), 'ground', Math.PI / 2, v(1, 1, 1)),
  // Two monkey lookouts on stilts (not walkable: no surface stands at deck height) with Koro idling between them.
  prop('grove-trial-lookout-a', 'prop-grove-platform', v(31, 0, -3), 'ground', Math.PI, v(1, 1, 1)),
  prop('grove-trial-lookout-b', 'prop-grove-platform', v(31, 0, 13), 'ground', Math.PI, v(1, 1, 1)),
  ...POST_POSITIONS.map((position, index) => prop('grove-trial-post-' + index, 'prop-training-post', position, 'ground', index * 1.7, v(1, 1, 1))),
  prop('grove-trial-memory-basin', 'prop-water-basin', v(-24, 0, -51.5), 'ground', 0, v(1, 1, 1)),
];

const FOOTPRINT_RADIUS: Readonly<Record<string, number>> = {
  'prop-heartroot-trunk': HEARTROOT_FOOTPRINT_RADIUS, 'prop-refuge-shelter': TENT_FOOTPRINT_RADIUS, 'prop-grove-platform': LOOKOUT_FOOTPRINT_RADIUS,
  'prop-training-post': POST_FOOTPRINT_RADIUS, 'prop-water-basin': BASIN_FOOTPRINT_RADIUS,
};
/** Plan-view circles of the authored set dressing that stays in place. */
const AUTHORED_FOOTPRINTS = AUTHORED_PROPS.map(placement => ({ x: placement.position.x, z: placement.position.z, radius: FOOTPRINT_RADIUS[placement.assetId]! }));

/** The playtest variant of the authored Grove: walk-mesh, route, cameras, exit, entities and props of the sanctuary and its practice ring. */
export function createGroveTrialRegion(authored: RegionDefinition): RegionDefinition {
  const entities: readonly RegionEntityDefinition[] = [
    { id: 'grove-vara', actorId: 'vara', kind: 'actor', position: v(8, 0, 41), assetId: 'actor-vara', placement: 'canopy' },
    { id: 'grove-koro', actorId: 'grove-koro', kind: 'actor', position: v(28.5, 0, 5), assetId: 'actor-koro', placement: 'ground' },
    ...GROVE_COMBAT_TRIALS.map((trial): RegionEntityDefinition => ({
      id: trial.monsterId, actorId: trial.monsterId, kind: 'actor', position: trial.monsterPosition, assetId: trial.monsterAssetId, placement: trial.monsterPosition.y > 0 ? 'elevated' : 'ground',
    })),
  ];
  const template = authored.exits.find(route => route.id === 'grove-ridge-out');
  if (!template) throw new Error('The Grove playtest needs the authored grove-ridge-out route as its exit template.');
  const { unlockFact: _locked, ...openRoute } = template;
  const exitFrom = v(23, 0, -44);
  const trialExit: RegionRouteDefinition = { ...openRoute, id: 'grove-trial-exit', from: exitFrom, anchors: [exitFrom, template.to], colliderIds: [] };
  const base: RegionDefinition = {
    ...authored,
    // The walk-mesh (x -34.5..34, z -54..48) exceeds the authored bounds.
    bounds: { min: v(-50, 0, -66), max: v(46, 18, 58) },
    props: AUTHORED_PROPS,
    movableObjects: [],
    ground: {
      y: 0, profile: 'canopy', navGraphId: 'grove-trial-nav',
      surfaces: WALK_SURFACES.map(entry => entry.surface), colliders: WALK_SURFACES.map(entry => entry.collider),
    },
    navigation: { nodes: NAVIGATION_NODES, ribbons: NAVIGATION_RIBBONS },
    cameraAnchors: CAMERA_ANCHORS,
    entrances: [],
    exits: [trialExit],
    traversalArcs: [],
    entities,
    encounterIds: [GROVE_TRIAL_SET.encounterId],
    encounterParticipants: { [GROVE_TRIAL_SET.encounterId]: GROVE_COMBAT_TRIALS.map(trial => trial.monsterId) },
  };
  const boundary = buildGroveBoundaryPlacements(base, {
    gates: GROVE_COMBAT_TRIALS.map(trial => trial.gate), arenas: GROVE_COMBAT_TRIALS.map(trial => trial.arena), obstacles: AUTHORED_FOOTPRINTS,
  });
  const props = [...AUTHORED_PROPS, ...boundary];
  const assetIds = [...new Set([...entities.flatMap(entity => entity.assetId ? [entity.assetId] : []), ...props.map(placement => placement.assetId)])];
  return { ...base, props, assetIds };
}
