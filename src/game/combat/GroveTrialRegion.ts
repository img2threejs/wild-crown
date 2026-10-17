import { v } from '../../content/levels/schema.js';
import type { RegionDefinition, RegionEntityDefinition, RegionRouteDefinition } from '../contracts.js';
import { buildGroveBoundaryPlacements } from '../../world/GroveBoundary.js';
import { stoneFootprints } from '../../world/GroveBlight.js';
import {
  GROVE_SURFACE_PREFIX, GROVE_TRIAL_CAMERAS, GROVE_TRIAL_NODES, GROVE_TRIAL_PROPS, GROVE_TRIAL_RIBBONS, GROVE_TRIAL_SURFACES, groveFootprints,
} from '../../content/levels/grove-layout.js';
import { GROVE_COMBAT_TRIALS, GROVE_TRIAL_SET } from './GroveContent.js';

export { GROVE_SURFACE_PREFIX };

/**
 * Grove playtest layout (docs/features/grove-playtest.md): a sunlit meadow sanctuary with a three-stage defence, 12 flat `y = 0` walk surfaces
 * (ids `grove-trial-*`). The player arrives at the south trailhead and crosses the central glade (the young Heartroot on its mound and the pond
 * to the north, Yara's camp to the west, the monkey lookouts and Koro to the east). The road north-west runs past the camp through
 * Stage 1, the 16-gon practice ring (r 10.5 around (-24, -22), Heartroot Sprig, gate 1 across the 6 m spur at z -38); Stage 2, the blighted hollow
 * (r 10.5 around (-24, -56), Blighted Rootling, gate 2 across the approach at z -72, where the Black Sap field begins); and Stage 3, the Memory
 * Pool arena (20-gon of walkable radius 13.5 around (-24, -96) on the pool's pale stone, fight arena r 11, Hollowheart), whose gate at (-1, -96)
 * seals the 6 m Ridge Trail east to the exit landing at (26, -96). The Memory Pool itself (terrain carve + corrupted surface) lies north of the
 * arena at (-24, -116), under a root cavern mouth and an old Warden ruin. The walk-mesh, navigation, cameras and set dressing are the shared
 * layout in `content/levels/grove-layout.ts` (the peaceful Act I hub uses its southern meadow); this variant replaces the authored region's
 * story overlay with the trial gates, monsters and exit, keeping its identity (id, name, environment recipe).
 */

/** The playtest variant of the authored Grove: walk-mesh, route, cameras, exit, entities and props of the sanctuary, its three stages and the Ridge Trail. */
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
  const exitFrom = v(26, 0, -96);
  const trialExit: RegionRouteDefinition = { ...openRoute, id: 'grove-trial-exit', from: exitFrom, anchors: [exitFrom, template.to], colliderIds: [] };
  const base: RegionDefinition = {
    ...authored,
    // The walk-mesh (x -40..34, z -121..48) and its set dressing (the pool, its cavern and the ruin) exceed the authored bounds.
    bounds: { min: v(-64, 0, -150), max: v(46, 18, 58) },
    props: GROVE_TRIAL_PROPS,
    movableObjects: [],
    ground: {
      y: 0, profile: 'canopy', navGraphId: 'grove-trial-nav',
      surfaces: GROVE_TRIAL_SURFACES.map(entry => entry.surface), colliders: GROVE_TRIAL_SURFACES.map(entry => entry.collider),
    },
    navigation: { nodes: GROVE_TRIAL_NODES, ribbons: GROVE_TRIAL_RIBBONS },
    cameraAnchors: GROVE_TRIAL_CAMERAS,
    entrances: [],
    exits: [trialExit],
    traversalArcs: [],
    entities,
    encounterIds: [GROVE_TRIAL_SET.encounterId],
    encounterParticipants: { [GROVE_TRIAL_SET.encounterId]: GROVE_COMBAT_TRIALS.map(trial => trial.monsterId) },
  };
  const boundary = buildGroveBoundaryPlacements(base, {
    gates: GROVE_COMBAT_TRIALS.map(trial => trial.gate), arenas: GROVE_COMBAT_TRIALS.map(trial => trial.arena), obstacles: [...groveFootprints(GROVE_TRIAL_PROPS), ...stoneFootprints()],
  });
  const props = [...GROVE_TRIAL_PROPS, ...boundary];
  const assetIds = [...new Set([...entities.flatMap(entity => entity.assetId ? [entity.assetId] : []), ...props.map(placement => placement.assetId)])];
  return { ...base, props, assetIds };
}
