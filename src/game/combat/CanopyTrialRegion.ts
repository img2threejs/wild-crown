import { v } from '../../content/levels/schema.js';
import type { GroundSurfaceDefinition, RegionColliderDefinition, RegionDefinition, RegionEntityDefinition, RegionRouteDefinition, Vec3, WorldAssetPlacement } from '../contracts.js';
import { buildCanopyBoundaryPlacements } from '../../world/CanopyBoundary.js';
import { CANOPY_COMBAT_TRIALS, CANOPY_TRIAL_SET } from './CombatTrials.js';

/**
 * Whispering Canopy playtest layout (docs/features/combat.md, "Whispering Canopy playtest"): a one-way walk-mesh from the
 * waterfall basin over two vine bridges to the temple courtyard and its exit path. The canonical region in act-i.ts is
 * not modified; this variant replaces its ground, navigation, cameras, routes and entities and keeps its identity.
 */
const EARTH = 'canopy-trail-earth';
const BRIDGE_DECK = 'canopy-bridge-deck';
const FLOOR_THICKNESS = 0.45;
const DECK_THICKNESS = 0.3;
/** The vine-bridge model is about 12 m long along local +z; the placement scale stretches it to the authored span. */
const BRIDGE_MODEL_LENGTH = 12;
/** Conservative plan-view footprints (metres, at placement scale 1) of authored set dressing, handed to the boundary builder. */
const TREE_FOOTPRINT_RADIUS = 4;
const SHRINE_FOOTPRINT_RADIUS = 7.5;

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
    surface: { id, profile: 'ramp', points, elevation: (low.y + high.y) / 2, thickness: FLOOR_THICKNESS, walkable: true, material: EARTH, colliderId: id + '-collider' },
    collider: { id: id + '-collider', kind: 'segment', from: v(low.x, low.y, centreZ), to: v(high.x, high.y, centreZ), radius: (box.maxZ - box.minZ) / 2, blocksMovement: false, blocksCamera: false, walkSurfaceId: id },
  };
}

const WALK_SURFACES: readonly WalkSurface[] = [
  // Start basin and Arena 1 (the waterfall pool lies beyond its south-west edge and is not walkable).
  flat('canopy-trial-basin', 'terrace', EARTH, FLOOR_THICKNESS, [v(-54, 0, -40), v(-40, 0, -40), v(-36, 0, -34), v(-36, 0, -22), v(-42, 0, -16), v(-58, 0, -16), v(-64, 0, -22), v(-64, 0, -31), v(-56, 0, -33)]),
  ramp('canopy-trial-root-stair', [v(-36, 0, -31), v(-24, 4, -31), v(-24, 4, -25), v(-36, 0, -25)]),
  flat('canopy-trial-fig-ledge', 'terrace', EARTH, DECK_THICKNESS, [v(-24, 4, -34), v(-14, 4, -34), v(-14, 4, -22), v(-24, 4, -22)]),
  flat('canopy-trial-gorge-bridge', 'canopy', BRIDGE_DECK, DECK_THICKNESS, [v(-14, 4, -30), v(-4, 4, -30), v(-4, 4, -27), v(-14, 4, -27)]),
  // Roost cliff top and Arena 2.
  flat('canopy-trial-roost', 'terrace', EARTH, DECK_THICKNESS, [v(-4, 4, -38), v(12, 4, -38), v(14, 4, -24), v(12, 4, -14), v(-4, 4, -14)]),
  flat('canopy-trial-chasm-bridge', 'canopy', BRIDGE_DECK, DECK_THICKNESS, [v(13, 4, -25), v(24, 4, -25), v(24, 4, -22), v(13, 4, -22)]),
  ramp('canopy-trial-temple-descent', [v(24, 4, -27), v(38, 0, -27), v(38, 0, -18), v(24, 4, -18)]),
  // Temple courtyard (Arena 3, a flat octagon) and the exit path.
  flat('canopy-trial-courtyard', 'terrace', EARTH, FLOOR_THICKNESS, [v(43.27, 0, -31), v(50.73, 0, -31), v(56, 0, -25.73), v(56, 0, -18.27), v(50.73, 0, -13), v(43.27, 0, -13), v(38, 0, -18.27), v(38, 0, -25.73)]),
  flat('canopy-trial-exit-path', 'terrace', EARTH, FLOOR_THICKNESS, [v(43.5, 0, -14), v(50.5, 0, -14), v(50.5, 0, 10), v(43.5, 0, 10)]),
];

const NAVIGATION_NODES: RegionDefinition['navigation']['nodes'] = [
  { id: 'canopy-trial-start', position: v(-58, 0, -20), links: ['canopy-trial-basin'] },
  { id: 'canopy-trial-basin', position: v(-49, 0, -28), links: ['canopy-trial-start', 'canopy-trial-stair-foot'] },
  { id: 'canopy-trial-stair-foot', position: v(-39, 0, -28), links: ['canopy-trial-basin', 'canopy-trial-stair-top'] },
  { id: 'canopy-trial-stair-top', position: v(-24, 4, -28), links: ['canopy-trial-stair-foot', 'canopy-trial-fig-ledge'] },
  { id: 'canopy-trial-fig-ledge', position: v(-19, 4, -28.5), links: ['canopy-trial-stair-top', 'canopy-trial-gorge-bridge'] },
  { id: 'canopy-trial-gorge-bridge', position: v(-9, 4, -28.5), links: ['canopy-trial-fig-ledge', 'canopy-trial-roost'] },
  { id: 'canopy-trial-roost', position: v(5, 4, -26), links: ['canopy-trial-gorge-bridge', 'canopy-trial-chasm-bridge'] },
  { id: 'canopy-trial-chasm-bridge', position: v(18.5, 4, -23.5), links: ['canopy-trial-roost', 'canopy-trial-temple-descent'] },
  { id: 'canopy-trial-temple-descent', position: v(31, 2, -22.5), links: ['canopy-trial-chasm-bridge', 'canopy-trial-courtyard'] },
  { id: 'canopy-trial-courtyard', position: v(47, 0, -22), links: ['canopy-trial-temple-descent', 'canopy-trial-exit-approach'] },
  { id: 'canopy-trial-exit-approach', position: v(47, 0, -12), links: ['canopy-trial-courtyard', 'canopy-trial-exit-landing'] },
  { id: 'canopy-trial-exit-landing', position: v(47, 0, 7), links: ['canopy-trial-exit-approach'] },
];

const NAVIGATION_RIBBONS: RegionDefinition['navigation']['ribbons'] = [
  { id: 'canopy-trial-basin-route', points: [v(-58, 0, -20), v(-49, 0, -28), v(-39, 0, -28), v(-30, 2, -28), v(-24, 4, -28)], width: 3.2, depthBand: 'ground' },
  { id: 'canopy-trial-high-route', points: [v(-24, 4, -28), v(-19, 4, -28.5), v(-9, 4, -28.5), v(-4, 4, -28.5), v(5, 4, -26), v(13, 4, -23.5), v(18.5, 4, -23.5), v(24, 4, -23.5)], width: 2.8, depthBand: 'root-to-canopy' },
  { id: 'canopy-trial-temple-route', points: [v(24, 4, -23.5), v(31, 2, -22.5), v(38, 0, -22), v(47, 0, -22), v(47, 0, -12), v(47, 0, 7)], width: 3.2, depthBand: 'ground' },
];

/** Cameras keep the locked three-quarter offset (+10, +12, +14) from the point they frame. */
const camera = (id: string, look: Vec3, mode: RegionDefinition['cameraAnchors'][number]['mode']): RegionDefinition['cameraAnchors'][number] =>
  ({ id, position: v(look.x + 10, look.y + 12, look.z + 14), lookAt: look, mode });
const CAMERA_ANCHORS: RegionDefinition['cameraAnchors'] = [
  camera('canopy-trial-basin-rail', v(-49, 0, -26), 'encounter'),
  camera('canopy-trial-gorge-rail', v(-9, 4, -28.5), 'exploration'),
  camera('canopy-trial-roost-rail', v(5, 4, -26), 'encounter'),
  camera('canopy-trial-courtyard-rail', v(47, 0, -22), 'encounter'),
  camera('canopy-trial-exit-rail', v(47, 0, 7), 'exploration'),
];


const prop = (id: string, assetId: string, position: Vec3, placement: WorldAssetPlacement['placement'], rotationY: number, scale: Vec3): WorldAssetPlacement =>
  ({ id, assetId, position, placement, rotationY, scale });

/** Vine bridges run along world +x: local +z of the model maps to +x with `rotationY = π/2`, stretched to the authored span. */
const bridge = (id: string, fromX: number, toX: number, z: number): WorldAssetPlacement =>
  prop(id, 'prop-vine-bridge', v((fromX + toX) / 2, 4, z), 'elevated', Math.PI / 2, v(1, 1, (toX - fromX) / BRIDGE_MODEL_LENGTH));

/**
 * Giant trees outside the walk-mesh; the y 4 trees stand on the cliff tops (elevated placement), the rest on the valley floor.
 * All stand on the far side of the route from the camera (offset +x, +z), so their trunks never fill the foreground.
 */
const GIANT_TREES: readonly Vec3[] = [v(-20, 4, -38), v(-38, 0, -48), v(2, 4, -42), v(28, 0, -34), v(60, 0, -38), v(40, 0, 4)];

const AUTHORED_PROPS: readonly WorldAssetPlacement[] = [
  bridge('canopy-trial-bridge-a', -14.6, -3.4, -28.5),
  bridge('canopy-trial-bridge-b', 12.7, 24.3, -23.5),
  prop('canopy-trial-shrine', 'prop-ancient-canopy-shrine', v(47, 0, -38), 'ground', 0, v(1, 1, 1)),
  ...GIANT_TREES.map((position, index) => prop('canopy-trial-tree-' + index, 'prop-rainforest-canopy-tree', position, position.y === 0 ? 'ground' : 'elevated', index * 2.399, v(1, 1, 1))),
];

/** Plan-view circles of the authored set dressing that stays in place (bridges are covered by the walk-mesh itself). */
const AUTHORED_FOOTPRINTS = AUTHORED_PROPS.flatMap(placement => {
  if (placement.assetId === 'prop-rainforest-canopy-tree') return [{ x: placement.position.x, z: placement.position.z, radius: TREE_FOOTPRINT_RADIUS }];
  if (placement.assetId === 'prop-ancient-canopy-shrine') return [{ x: placement.position.x, z: placement.position.z, radius: SHRINE_FOOTPRINT_RADIUS }];
  return [];
});

/** What boundary dressing must keep clear: sealed gate boxes, dodge arenas and the footprints of authored set dressing. */
export interface CanopyKeepClear {
  readonly gates: readonly RegionColliderDefinition[];
  readonly arenas: readonly { readonly center: Readonly<Vec3>; readonly radius: number }[];
  readonly obstacles: readonly { readonly x: number; readonly z: number; readonly radius: number }[];
}

/**
 * COMPOSITION POINT for the canopy boundary dressing (cliff rocks, ferns and further giant trees; decoration only):
 * `src/world/CanopyBoundary.ts` builds it from the walk-mesh and what must stay clear.
 */
function canopyBoundaryPlacements(region: RegionDefinition, keepClear: CanopyKeepClear): readonly WorldAssetPlacement[] {
  return buildCanopyBoundaryPlacements(region, keepClear);
}

/** Authored Whispering Canopy playtest geometry, route, exit, entities and props for the combat trials. */
export function createCanopyTrialRegion(authored: RegionDefinition): RegionDefinition {
  const entities: readonly RegionEntityDefinition[] = [
    { id: 'canopy-vara', actorId: 'vara', kind: 'actor', position: v(-60, 0, -19), assetId: 'actor-vara', placement: 'canopy' },
    ...CANOPY_COMBAT_TRIALS.map((trial): RegionEntityDefinition => ({
      id: trial.monsterId, actorId: trial.monsterId, kind: 'actor', position: trial.monsterPosition, assetId: trial.monsterAssetId, placement: trial.monsterPosition.y > 0 ? 'elevated' : 'ground',
    })),
  ];
  const template = authored.exits.find(route => route.id === 'canopy-bamboo-out');
  if (!template) throw new Error('The Whispering Canopy playtest needs the authored canopy-bamboo-out route as its exit template.');
  const { unlockFact: _locked, ...openRoute } = template;
  const exitFrom = v(47, 0, 7);
  const trialExit: RegionRouteDefinition = { ...openRoute, id: 'canopy-trial-exit', from: exitFrom, anchors: [exitFrom, template.to], colliderIds: [] };
  const base: RegionDefinition = {
    ...authored,
    props: AUTHORED_PROPS,
    movableObjects: [],
    ground: {
      y: 0, profile: 'canopy', navGraphId: 'canopy-trial-nav',
      surfaces: WALK_SURFACES.map(entry => entry.surface), colliders: WALK_SURFACES.map(entry => entry.collider),
    },
    navigation: { nodes: NAVIGATION_NODES, ribbons: NAVIGATION_RIBBONS },
    cameraAnchors: CAMERA_ANCHORS,
    entrances: [],
    exits: [trialExit],
    traversalArcs: [],
    entities,
    encounterIds: [CANOPY_TRIAL_SET.encounterId],
    encounterParticipants: { [CANOPY_TRIAL_SET.encounterId]: CANOPY_COMBAT_TRIALS.map(trial => trial.monsterId) },
  };
  const boundary = canopyBoundaryPlacements(base, {
    gates: CANOPY_COMBAT_TRIALS.map(trial => trial.gate), arenas: CANOPY_COMBAT_TRIALS.map(trial => trial.arena), obstacles: AUTHORED_FOOTPRINTS,
  });
  const props = [...AUTHORED_PROPS, ...boundary];
  const assetIds = [...new Set([...entities.flatMap(entity => entity.assetId ? [entity.assetId] : []), ...props.map(placement => placement.assetId)])];
  return { ...base, props, assetIds };
}
