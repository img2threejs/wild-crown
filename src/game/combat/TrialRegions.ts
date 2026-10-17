import type { RegionDefinition, WorldAssetPlacement } from '../contracts.js';
import { buildGreenwakeBoundaryPlacements, distanceToWalkMesh, greenwakeFootprint } from '../../world/GreenwakeBoundary.js';
import { createCanopyTrialRegion } from './CanopyTrialRegion.js';
import { createGroveTrialRegion } from './GroveTrialRegion.js';
import { createMistveilTrialRegion } from './MistveilTrialRegion.js';
import { createMoonpineTrialRegion } from './MoonpineTrialRegion.js';
import { GREENWAKE_COMBAT_TRIALS } from './CombatTrials.js';
import { heroById, type HeroId } from '../heroes.js';

/** Collider-paired tree visual (greenwake-corridor-root-cluster) must never be culled or the blocker would turn invisible. */
const ROUTE_OBSTACLE_TREE = 'greenwake-corridor-tree-cluster-visual';

/**
 * Local playtest layout: the sealed route is framed by deterministic boundary props. Authored trees whose footprint
 * touches the walk-mesh or a boundary prop are dropped so nothing overhangs the path.
 */
function createGreenwakeTrialRegion(region: RegionDefinition): RegionDefinition {
  const jumpRock: WorldAssetPlacement = { id: 'greenwake-trial-jump-rock', assetId: 'prop-mire-bank-rock', position: { x: 10, y: 0, z: -6 }, rotationY: 2.4, scale: { x: .7, y: .7, z: .7 }, placement: 'ground' };
  // Everything that stays in place (all non-tree props with a ground footprint, and the collider-paired tree) is kept clear.
  const obstacles = region.props.filter(prop => prop.placement === 'ground' && (prop.assetId !== 'prop-erya-edge-tree' || prop.id === ROUTE_OBSTACLE_TREE))
    .flatMap(prop => greenwakeFootprint(prop.assetId, prop.position, prop.rotationY, prop.scale));
  obstacles.push({ x: jumpRock.position.x, z: jumpRock.position.z, radius: 1.5 });
  const boundary = buildGreenwakeBoundaryPlacements(region, { gates: GREENWAKE_COMBAT_TRIALS.map(stage => stage.gate), arenas: GREENWAKE_COMBAT_TRIALS.map(stage => stage.arena), obstacles });
  const dressed = boundary.flatMap(placement => greenwakeFootprint(placement.assetId, placement.position, placement.rotationY, placement.scale));
  const props = region.props.filter(prop => {
    if (prop.assetId !== 'prop-erya-edge-tree' || prop.id === ROUTE_OBSTACLE_TREE) return true;
    const [tree] = greenwakeFootprint(prop.assetId, prop.position, prop.rotationY, prop.scale);
    return distanceToWalkMesh(region, tree!.x, tree!.z) >= tree!.radius + 0.5
      && dressed.every(circle => Math.hypot(circle.x - tree!.x, circle.z - tree!.z) >= 0.6 * (circle.radius + tree!.radius));
  });
  const entities = region.entities.map(entity => {
    const stage = GREENWAKE_COMBAT_TRIALS.find(trial => trial.monsterId === entity.id);
    return stage ? { ...entity, assetId: stage.monsterAssetId } : entity;
  });
  return { ...region, props: [...props, jumpRock, ...boundary], assetIds: [...region.assetIds, jumpRock.assetId], entities };
}

/** Projects supported sealed layouts and removes chapter field traps and the selected hero's NPC counterpart. */
export function createCombatTrialRegion(region: RegionDefinition, heroId: HeroId = 'aren'): RegionDefinition {
  const trial = region.id === 'greenwake' ? createGreenwakeTrialRegion(region)
    : region.id === 'whispering-canopy' ? createCanopyTrialRegion(region)
    : region.id === 'the-grove' ? createGroveTrialRegion(region)
    : region.id === 'moonpine-ridge' ? createMoonpineTrialRegion(region)
    : region.id === 'mistveil-basin' ? createMistveilTrialRegion(region) : region;
  const npcActorId = heroById(heroId).npcActorId;
  return npcActorId || trial.fieldTraps?.length
    ? { ...trial, fieldTraps: [], entities: npcActorId ? trial.entities.filter(entity => entity.actorId !== npcActorId) : trial.entities }
    : trial;
}
