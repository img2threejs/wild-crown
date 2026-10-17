import { v } from '../../content/levels/schema.js';
import type { RegionColliderDefinition, RegionDefinition, RegionEntityDefinition, RegionRouteDefinition, Vec3, WorldAssetPlacement } from '../contracts.js';
import { buildCanopyBoundaryPlacements } from '../../world/CanopyBoundary.js';
import {
  CANOPY_AUTHORED_FOOTPRINTS, CANOPY_AUTHORED_PROPS, CANOPY_CAMERA_ANCHORS, CANOPY_NAVIGATION_NODES, CANOPY_NAVIGATION_RIBBONS, CANOPY_WALK_SURFACES,
} from '../../content/levels/canopy-layout.js';
import { CANOPY_COMBAT_TRIALS, CANOPY_TRIAL_SET } from './CombatTrials.js';

/**
 * Whispering Canopy playtest layout (docs/features/combat.md, "Whispering Canopy playtest"): a one-way walk-mesh from the
 * waterfall basin over two vine bridges to the temple courtyard and its exit path. The walk-mesh, navigation, cameras and set
 * dressing are the shared layout in `content/levels/canopy-layout.ts` (the Act I chapter region uses the same geometry); this
 * variant adds the trial gates, trial monsters and the trial exit, replacing the authored region's story overlay.
 */

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
    props: CANOPY_AUTHORED_PROPS,
    movableObjects: [],
    deliveries: [],
    ground: {
      y: 0, profile: 'canopy', navGraphId: 'canopy-trial-nav',
      surfaces: CANOPY_WALK_SURFACES.map(entry => entry.surface), colliders: CANOPY_WALK_SURFACES.map(entry => entry.collider),
    },
    navigation: { nodes: CANOPY_NAVIGATION_NODES, ribbons: CANOPY_NAVIGATION_RIBBONS },
    cameraAnchors: CANOPY_CAMERA_ANCHORS,
    entrances: [],
    exits: [trialExit],
    traversalArcs: [],
    entities,
    encounterIds: [CANOPY_TRIAL_SET.encounterId],
    encounterParticipants: { [CANOPY_TRIAL_SET.encounterId]: CANOPY_COMBAT_TRIALS.map(trial => trial.monsterId) },
  };
  const boundary = canopyBoundaryPlacements(base, {
    gates: CANOPY_COMBAT_TRIALS.map(trial => trial.gate), arenas: CANOPY_COMBAT_TRIALS.map(trial => trial.arena), obstacles: CANOPY_AUTHORED_FOOTPRINTS,
  });
  const props = [...CANOPY_AUTHORED_PROPS, ...boundary];
  const assetIds = [...new Set([...entities.flatMap(entity => entity.assetId ? [entity.assetId] : []), ...props.map(placement => placement.assetId)])];
  return { ...base, props, assetIds };
}
