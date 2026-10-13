import { describe, expect, it } from 'bun:test';
import { REGIONS } from '../../src/content/campaign.js';
import { solidPropKind } from '../../src/content/solid-props.js';
import { CombatEngine, type CombatInput } from '../../src/game/combat/CombatEngine.js';
import { MISTVEIL_BOUNDARY_ID_PREFIX, MISTVEIL_COMBAT_TRIALS, MISTVEIL_TRIAL_SET } from '../../src/game/combat/MistveilContent.js';
import { createMistveilTrialRegion, MISTVEIL_SURFACE_PREFIX } from '../../src/game/combat/MistveilTrialRegion.js';
import { createCombatTrialRegion } from '../../src/game/combat/TrialRegions.js';
import { arenaFromRegion, groundHeightAt, vec } from '../../src/game/combat/geometry.js';
import type { RegionDefinition, Vec3 } from '../../src/game/contracts.js';
import { describeSealedRoute } from './sealed-route-harness.js';

const authored = REGIONS.find(region => region.id === 'mistveil-basin')!;
const region: RegionDefinition = createCombatTrialRegion(authored);
const arena = arenaFromRegion(region);
const exit = region.exits.find(route => route.id === 'mistveil-trial-exit')!.from;

describeSealedRoute({
  name: 'Mistveil Basin', regionId: 'mistveil-basin', encounterId: 'mistveil-trials', region, trials: MISTVEIL_COMBAT_TRIALS,
  start: region.navigation.nodes[0]!.position, exit, forward: [vec(1, 0, 0), vec(1, 0, 0), vec(1, 0, 0)], minWalkableCells: 5000,
});

describe('Mistveil Basin trial region', () => {
  it('is built by the shared dispatcher and leaves the canonical region untouched', () => {
    const before = JSON.stringify(authored);
    expect(JSON.stringify(createMistveilTrialRegion(authored))).toBe(JSON.stringify(region));
    expect(JSON.stringify(authored)).toBe(before);
    expect(region.id).toBe('mistveil-basin');
    expect(region.environmentRecipeId).toBe('mistveil-basin-environment');
    expect(createCombatTrialRegion(REGIONS.find(candidate => candidate.id === 'blood-bamboo-valley')!)).toBe(REGIONS.find(candidate => candidate.id === 'blood-bamboo-valley')!);
    expect(MISTVEIL_TRIAL_SET).toMatchObject({ regionId: 'mistveil-basin', encounterId: 'mistveil-trials', clearedTitle: 'Basin trials cleared' });
  });

  it('lays out the twelve walk surfaces with their ids, floors and materials, all prefixed for the biome selector', () => {
    const expected: Record<string, { y: [number, number]; material: string }> = {
      'mistveil-trial-bank': { y: [0, 0], material: 'mistveil-mud-bank' },
      'mistveil-trial-ford': { y: [0, 0], material: 'mistveil-mud-bank' },
      'mistveil-trial-causeway-rise': { y: [0, 1.2], material: 'mistveil-root-causeway' },
      'mistveil-trial-causeway': { y: [1.2, 1.2], material: 'mistveil-root-causeway' },
      'mistveil-trial-causeway-fall': { y: [0, 1.2], material: 'mistveil-root-causeway' },
      'mistveil-trial-glade': { y: [0, 0], material: 'mistveil-mud-bank' },
      'mistveil-trial-reedway': { y: [0, 0], material: 'mistveil-mud-bank' },
      'mistveil-trial-pad': { y: [0, 0], material: 'mistveil-mud-bank' },
      'mistveil-trial-neck': { y: [0, 0], material: 'mistveil-mud-bank' },
      'mistveil-trial-source': { y: [0, 0], material: 'mistveil-mud-bank' },
      'mistveil-trial-pass': { y: [0, 0], material: 'mistveil-mud-bank' },
      'mistveil-trial-landing': { y: [0, 0], material: 'mistveil-mud-bank' },
    };
    expect(region.ground.surfaces.map(surface => surface.id).sort()).toEqual(Object.keys(expected).sort());
    for (const surface of region.ground.surfaces) {
      const want = expected[surface.id]!;
      expect(surface.id.startsWith(MISTVEIL_SURFACE_PREFIX)).toBe(true);
      expect(surface.walkable).toBe(true);
      expect(surface.material).toBe(want.material);
      expect([Math.min(...surface.points.map(point => point.y)), Math.max(...surface.points.map(point => point.y))]).toEqual(want.y);
      const collider = region.ground.colliders.find(candidate => candidate.id === surface.colliderId)!;
      expect(collider.walkSurfaceId).toBe(surface.id);
      // Boxes support flat tops flush with the floor; ramps carry a non-blocking centre-line segment.
      if (surface.profile === 'ramp') { expect(collider.kind).toBe('segment'); expect(collider.blocksMovement).toBe(false); }
      else { expect(collider.kind).toBe('box'); expect(collider.blocksMovement).toBe(true); expect(collider.from.y + collider.halfExtents!.y).toBeCloseTo(surface.elevation, 9); }
    }
    for (const id of ['mistveil-trial-bank', 'mistveil-trial-glade', 'mistveil-trial-pad', 'mistveil-trial-source']) expect(region.ground.surfaces.find(surface => surface.id === id)!.points).toHaveLength(8);
  });

  it('places Aren on the arrival bank, the navigation route, the exit and the cameras on walkable floor', () => {
    const nodes = region.navigation.nodes;
    expect(nodes[0]!.position).toEqual({ x: -70, y: 0, z: -16 });
    const ids = new Set(nodes.map(node => node.id));
    for (const node of nodes) {
      expect(groundHeightAt(arena, node.position.x, node.position.z, node.position.y)).toBeCloseTo(node.position.y, 6);
      for (const link of node.links) expect(ids.has(link)).toBe(true);
    }
    for (const ribbon of region.navigation.ribbons) for (const point of ribbon.points) expect(groundHeightAt(arena, point.x, point.z, point.y)).toBeCloseTo(point.y, 6);
    expect(exit).toEqual({ x: 99, y: 0, z: -16 });
    // The 2.2 m goal ring lies completely on the landing before the root cavern.
    for (let step = 0; step < 36; step++) {
      const angle = step / 36 * Math.PI * 2;
      expect(groundHeightAt(arena, exit.x + Math.cos(angle) * 2.2, exit.z + Math.sin(angle) * 2.2, 0)).toBe(0);
    }
    expect(region.entrances).toEqual([]);
    expect(region.traversalArcs).toEqual([]);
    expect(region.cameraAnchors.length).toBeGreaterThanOrEqual(4);
    for (const anchor of region.cameraAnchors) {
      expect(anchor.position.x - anchor.lookAt.x).toBe(10);
      expect(anchor.position.y - anchor.lookAt.y).toBe(12);
      expect(anchor.position.z - anchor.lookAt.z).toBe(14);
    }
    // The region's bounds hold every walkable, pool-free route point and the exit.
    for (const surface of region.ground.surfaces) for (const point of surface.points) {
      expect(point.x).toBeGreaterThanOrEqual(region.bounds.min.x); expect(point.x).toBeLessThanOrEqual(region.bounds.max.x);
      expect(point.z).toBeGreaterThanOrEqual(region.bounds.min.z); expect(point.z).toBeLessThanOrEqual(region.bounds.max.z);
    }
  });

  it('copies the authored mistveil-hidden-route-out route as the open Root Cavern exit', () => {
    const template = authored.exits.find(route => route.id === 'mistveil-hidden-route-out')!;
    expect(region.exits.map(route => route.id)).toEqual(['mistveil-trial-exit']);
    const trialExit = region.exits[0]!;
    expect(trialExit.destination).toBe(template.destination);
    expect(trialExit.to).toEqual(template.to);
    expect(trialExit.event).toBe(template.event);
    expect(trialExit.unlockFact).toBeUndefined();
    expect(template.unlockFact).toBeDefined();
    expect(trialExit.colliderIds).toEqual([]);
  });

  it('places the three wildlife monsters with their asset ids, and no panther or other unrelated canonical entities', () => {
    expect(region.entities.map(entity => [entity.id, entity.actorId, entity.assetId])).toEqual([
      ['mistveil-lurker', 'mistveil-lurker', 'actor-bog-lurker'],
      ['mistveil-heron', 'mistveil-heron', 'actor-lantern-heron'],
      ['mistveil-ghor', 'mistveil-ghor', 'actor-ghor-mire-maw'],
    ]);
    expect(region.entities.every(entity => entity.kind === 'actor' && entity.placement === 'ground')).toBe(true);
    for (const trial of MISTVEIL_COMBAT_TRIALS) expect(region.entities.find(entity => entity.id === trial.monsterId)!.position).toEqual(trial.monsterPosition);
    expect(region.encounterIds).toEqual(['mistveil-trials']);
    expect(region.encounterParticipants['mistveil-trials']).toEqual(['mistveil-lurker', 'mistveil-heron', 'mistveil-ghor']);
    expect(region.assetIds).toEqual(expect.arrayContaining([
      'actor-bog-lurker', 'actor-lantern-heron', 'actor-ghor-mire-maw', 'prop-mistveil-root-tree', 'prop-mistveil-reed-cluster', 'prop-mire-bank-rock',
      'prop-hunter-extraction-rig', 'prop-black-sap-filter-drum', 'prop-root-cavern-mouth',
    ]));
    expect(new Set(region.assetIds).size).toBe(region.assetIds.length);
    expect(region.assetIds.some(id => id.includes('panther') || id.includes('nyra'))).toBe(false);
  });

  it('places the root trees, extraction rig, filter drum, cavern mouth, reeds and bank rocks as authored, with unique ids and solid kinds', () => {
    expect(new Set(region.props.map(prop => prop.id)).size).toBe(region.props.length);
    const walkablePoints = region.ground.surfaces.flatMap(surface => surface.points);
    const authoredProps = region.props.filter(prop => !prop.id.startsWith(MISTVEIL_BOUNDARY_ID_PREFIX));
    expect(authoredProps.every(prop => prop.id.startsWith('mistveil-trial-'))).toBe(true);
    const trees = authoredProps.filter(prop => prop.assetId === 'prop-mistveil-root-tree');
    expect(trees).toHaveLength(5);
    // Root trees stand either side of the raised causeway (x -20..-8, z -19..-13), clear of the walk-mesh.
    expect(trees.filter(tree => tree.position.x > -20 && tree.position.x < -4 && tree.position.z < -19).length).toBeGreaterThanOrEqual(2);
    expect(trees.filter(tree => tree.position.x > -20 && tree.position.x < -4 && tree.position.z > -13).length).toBeGreaterThanOrEqual(2);
    for (const tree of trees) {
      expect(solidPropKind(tree)).toBe('trunk');
      const nearest = walkablePoints.reduce((best, point) => Math.hypot(point.x - tree.position.x, point.z - tree.position.z) < Math.hypot(best.x - tree.position.x, best.z - tree.position.z) ? point : best);
      expect(Math.hypot(nearest.x - tree.position.x, nearest.z - tree.position.z)).toBeGreaterThan(4);
      expect(groundHeightAt(arena, tree.position.x, tree.position.z, 0)).toBeNull();
    }
    const rig = authoredProps.find(prop => prop.assetId === 'prop-hunter-extraction-rig')!, drum = authoredProps.find(prop => prop.assetId === 'prop-black-sap-filter-drum')!;
    const mouth = authoredProps.find(prop => prop.assetId === 'prop-root-cavern-mouth')!;
    for (const prop of [rig, drum, mouth]) expect(groundHeightAt(arena, prop.position.x, prop.position.z, 0)).toBeNull();
    // Marek's site stands on dry ground north of the pad (beside the river), and the cavern mouth faces the landing at the exit.
    expect(rig.position.z).toBeLessThan(-26);
    expect(solidPropKind(rig)).toBe('solid');
    expect(solidPropKind(drum)).toBe('solid');
    expect(solidPropKind(mouth)).toBe('arch');
    expect(Math.hypot(mouth.position.x - exit.x, mouth.position.z - exit.z)).toBeGreaterThan(6);
    for (const reed of authoredProps.filter(prop => prop.assetId === 'prop-mistveil-reed-cluster')) expect(solidPropKind(reed)).toBe('decoration');
    for (const rock of authoredProps.filter(prop => prop.assetId === 'prop-mire-bank-rock')) expect(solidPropKind(rock)).toBe('solid');
    // Boundary dressing (ids `mistveil-boundary-*`) is decoration only.
    const boundary = region.props.filter(prop => prop.id.startsWith(MISTVEIL_BOUNDARY_ID_PREFIX));
    expect(boundary.length).toBeGreaterThan(150);
    for (const prop of boundary) expect(solidPropKind(prop)).toBe('decoration');
    // No arena holds a prop: dodge arenas stay open ground.
    for (const trial of MISTVEIL_COMBAT_TRIALS) for (const prop of region.props) expect(Math.hypot(prop.position.x - trial.arena.center.x, prop.position.z - trial.arena.center.z)).toBeGreaterThan(trial.arena.radius);
  });

  it('starts Aren well outside every trial: at least 18 m from each monster and its arena edge, so the player walks into Trial 1', () => {
    const spawn = region.navigation.nodes[0]!.position;
    for (const trial of MISTVEIL_COMBAT_TRIALS) {
      expect(Math.hypot(spawn.x - trial.monsterPosition.x, spawn.z - trial.monsterPosition.z)).toBeGreaterThanOrEqual(18);
      expect(Math.hypot(spawn.x - trial.arena.center.x, spawn.z - trial.arena.center.z) - trial.arena.radius).toBeGreaterThanOrEqual(18);
    }
  });

  it('loads into the engine and starts the Mistveil encounter with its three monsters on their trial spawns', () => {
    const engine = new CombatEngine();
    const present = region.entities.map(entity => entity.id);
    engine.loadRegion({ regionId: 'mistveil-basin', regionDefinition: region, runId: 'mistveil-load', presentActorIds: present });
    engine.startEncounter({ encounterId: 'mistveil-trials', regionId: 'mistveil-basin', runId: 'mistveil-load' });
    engine.enableCombatTrials();
    const snapshot = engine.snapshot();
    const player = snapshot.actors.find(actor => actor.id === 'aren')!;
    expect(player.position).toEqual({ x: -70, y: 0, z: -16 });
    for (const trial of MISTVEIL_COMBAT_TRIALS) {
      const monster = snapshot.actors.find(actor => actor.id === trial.monsterId)!;
      expect(monster.position).toEqual(trial.monsterPosition);
      expect(monster.allegiance).toBe('hostile');
      expect(monster.renderVariantId).toBe(trial.monsterAssetId);
    }
    expect(snapshot.trialGates!.map(gate => [gate.id, gate.open])).toEqual([['reed-shallows', false], ['eyes-in-the-mist', false], ['black-river', false]]);
    expect(snapshot.encounterStatus!.title).toBe('Reed Shallows');
    expect(snapshot.encounterStatus!.monsters.map(monster => monster.name)).toEqual(['Bog Lurker', 'Lantern Heron', 'Ghor, the Mire Maw']);
    expect(snapshot.encounterStatus!.monsters[0]!.skills).toEqual(['tongue lash', 'bubble pool', 'mud hop']);
    expect(snapshot.encounterStatus!.monsters[1]!.skills).toEqual(['spear dive', 'mist gust', 'flare burst']);
    expect(snapshot.encounterStatus!.monsters[2]!.skills).toEqual(['tail sweep', 'bite lunge', 'black river wave']);
  });
});

const IDLE: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };

/** Walks Aren along the navigation nodes with the real engine (monsters hidden), returning the furthest node reached and the final position. */
function walkRoute(openGates: number): { reached: number; position: Vec3 } {
  const engine = new CombatEngine();
  engine.loadRegion({ regionId: 'mistveil-basin', regionDefinition: region, runId: 'mistveil-walk', presentActorIds: region.entities.filter(entity => entity.actorId).map(entity => entity.id), playerPosition: region.navigation.nodes[0]!.position });
  engine.startEncounter({ encounterId: 'mistveil-trials', regionId: 'mistveil-basin', runId: 'mistveil-walk' });
  engine.enableCombatTrials();
  const seed = engine.snapshotState();
  for (const actor of seed.actors) if (actor.id !== seed.playerId) actor.visible = false;
  seed.arena.cameraBasis = { forward: vec(0, 0, 1), right: vec(1, 0, 0) };
  seed.combatTrial!.index = openGates;
  const walker = new CombatEngine(seed);
  const points = [...region.navigation.nodes.map(node => node.position), exit];
  let reached = 0, position = points[0]!;
  for (let target = 1; target < points.length; target++) {
    const goal = points[target]!;
    for (let tick = 0; tick < 900; tick++) {
      position = walker.snapshot().actors.find(actor => actor.id === 'aren')!.position;
      const dx = goal.x - position.x, dz = goal.z - position.z, length = Math.hypot(dx, dz);
      if (length < 0.7) { reached = target; break; }
      walker.fixedStep({ ...IDLE, move: vec(dx / length, 0, dz / length), sprintHeld: true });
      walker.consumeEvents(); walker.drainPresentationCues();
    }
    if (reached !== target) break;
  }
  return { reached, position: walker.snapshot().actors.find(actor => actor.id === 'aren')!.position };
}

describe('Mistveil Basin route with the real engine', () => {
  it('walks from the spawn up over the raised causeway to the stage exit only when all three gates are open', () => {
    const goals = region.navigation.nodes.length;
    const open = walkRoute(3);
    expect(open.reached).toBe(goals);
    expect(Math.hypot(open.position.x - exit.x, open.position.z - exit.z)).toBeLessThan(0.8);
  }, 60000);

  it('stops at the first closed gate, then the second, then the third: the exit is reachable only after trial 3', () => {
    // Gate x positions: reed-shallows -27, eyes-in-the-mist 27, black-river 89.
    const closed1 = walkRoute(0);
    expect(closed1.position.x).toBeLessThan(-27);
    const closed2 = walkRoute(1);
    expect(closed2.position.x).toBeGreaterThan(-27);
    expect(closed2.position.x).toBeLessThan(27);
    const closed3 = walkRoute(2);
    expect(closed3.position.x).toBeGreaterThan(27);
    expect(closed3.position.x).toBeLessThan(89);
    expect(Math.hypot(closed3.position.x - exit.x, closed3.position.z - exit.z)).toBeGreaterThan(8);
  }, 120000);
});
