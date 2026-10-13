import { describe, expect, it } from 'bun:test';
import { REGIONS } from '../../src/content/campaign.js';
import { solidPropKind } from '../../src/content/solid-props.js';
import { CombatEngine, type CombatInput } from '../../src/game/combat/CombatEngine.js';
import { MOONPINE_COMBAT_TRIALS, MOONPINE_TRIAL_SET } from '../../src/game/combat/MoonpineContent.js';
import { createMoonpineTrialRegion, MOONPINE_SURFACE_PREFIX } from '../../src/game/combat/MoonpineTrialRegion.js';
import { createCombatTrialRegion } from '../../src/game/combat/TrialRegions.js';
import { arenaFromRegion, groundHeightAt, vec } from '../../src/game/combat/geometry.js';
import type { RegionDefinition, Vec3 } from '../../src/game/contracts.js';
import { describeSealedRoute } from './sealed-route-harness.js';

const authored = REGIONS.find(region => region.id === 'moonpine-ridge')!;
const region: RegionDefinition = createCombatTrialRegion(authored);
const arena = arenaFromRegion(region);
const exit = region.exits.find(route => route.id === 'moonpine-trial-exit')!.from;

describeSealedRoute({
  name: 'Moonpine Ridge', regionId: 'moonpine-ridge', encounterId: 'moonpine-trials', region, trials: MOONPINE_COMBAT_TRIALS,
  start: region.navigation.nodes[0]!.position, exit, forward: [vec(1, 0, 0), vec(1, 0, 0), vec(0, 0, 1)], minWalkableCells: 5000,
});

describe('Moonpine Ridge trial region', () => {
  it('is built by the shared dispatcher and leaves the canonical region untouched', () => {
    const before = JSON.stringify(authored);
    expect(JSON.stringify(createMoonpineTrialRegion(authored))).toBe(JSON.stringify(region));
    expect(JSON.stringify(authored)).toBe(before);
    expect(region.id).toBe('moonpine-ridge');
    expect(region.environmentRecipeId).toBe('moonpine-ridge-environment');
    expect(createCombatTrialRegion(REGIONS.find(candidate => candidate.id === 'blood-bamboo-valley')!)).toBe(REGIONS.find(candidate => candidate.id === 'blood-bamboo-valley')!);
    expect(MOONPINE_TRIAL_SET).toMatchObject({ regionId: 'moonpine-ridge', encounterId: 'moonpine-trials' });
  });

  it('lays out the eleven walk surfaces with their contract ids, floors and materials', () => {
    const expected: Record<string, { y: [number, number]; material: string }> = {
      'moonpine-trial-trail': { y: [0, 0], material: 'moonpine-trail-snow' },
      'moonpine-trial-lake-shelf': { y: [0, 0], material: 'moonpine-frozen-lake' },
      'moonpine-trial-shore-path': { y: [0, 0], material: 'moonpine-trail-snow' },
      'moonpine-trial-log-bridge': { y: [0, 0], material: 'moonpine-bridge-deck' },
      'moonpine-trial-hollow': { y: [0, 0], material: 'moonpine-trail-snow' },
      'moonpine-trial-hollow-path': { y: [0, 0], material: 'moonpine-trail-snow' },
      'moonpine-trial-temple-stair': { y: [0, 4], material: 'moonpine-trail-snow' },
      'moonpine-trial-temple-terrace': { y: [4, 4], material: 'moonpine-temple-flags' },
      'moonpine-trial-temple-path': { y: [4, 4], material: 'moonpine-temple-flags' },
      'moonpine-trial-temple-descent': { y: [0, 4], material: 'moonpine-trail-snow' },
      'moonpine-trial-exit-landing': { y: [0, 0], material: 'moonpine-trail-snow' },
    };
    expect(region.ground.surfaces.map(surface => surface.id).sort()).toEqual(Object.keys(expected).sort());
    for (const surface of region.ground.surfaces) {
      const want = expected[surface.id]!;
      expect(surface.id.startsWith(MOONPINE_SURFACE_PREFIX)).toBe(true);
      expect(surface.walkable).toBe(true);
      expect(surface.material).toBe(want.material);
      expect([Math.min(...surface.points.map(point => point.y)), Math.max(...surface.points.map(point => point.y))]).toEqual(want.y);
      const collider = region.ground.colliders.find(candidate => candidate.id === surface.colliderId)!;
      expect(collider.walkSurfaceId).toBe(surface.id);
      // Boxes support flat tops flush with the floor; ramps carry a non-blocking centre-line segment.
      if (surface.profile === 'ramp') { expect(collider.kind).toBe('segment'); expect(collider.blocksMovement).toBe(false); }
      else { expect(collider.kind).toBe('box'); expect(collider.blocksMovement).toBe(true); expect(collider.from.y + collider.halfExtents!.y).toBeCloseTo(surface.elevation, 9); }
    }
    expect(region.ground.surfaces.find(surface => surface.id === 'moonpine-trial-temple-terrace')!.points).toHaveLength(8);
    expect(region.ground.surfaces.find(surface => surface.id === 'moonpine-trial-hollow')!.points).toHaveLength(8);
  });

  it('places Aren, the navigation route, the exit and the cameras on walkable floor', () => {
    const nodes = region.navigation.nodes;
    expect(nodes[0]!.position).toEqual({ x: -66, y: 0, z: -22 });
    const ids = new Set(nodes.map(node => node.id));
    for (const node of nodes) {
      expect(groundHeightAt(arena, node.position.x, node.position.z, node.position.y)).toBeCloseTo(node.position.y, 6);
      for (const link of node.links) expect(ids.has(link)).toBe(true);
    }
    for (const ribbon of region.navigation.ribbons) for (const point of ribbon.points) expect(groundHeightAt(arena, point.x, point.z, point.y)).toBeCloseTo(point.y, 6);
    expect(exit).toEqual({ x: 47, y: 0, z: 15 });
    // The 2.2 m goal ring lies completely on the exit landing.
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
  });

  it('copies the authored ridge-mist-out route as the open Temple Descent exit', () => {
    const template = authored.exits.find(route => route.id === 'ridge-mist-out')!;
    expect(region.exits.map(route => route.id)).toEqual(['moonpine-trial-exit']);
    const trialExit = region.exits[0]!;
    expect(trialExit.destination).toBe(template.destination);
    expect(trialExit.to).toEqual(template.to);
    expect(trialExit.event).toBe(template.event);
    expect(trialExit.unlockFact).toBeUndefined();
    expect(trialExit.colliderIds).toEqual([]);
  });

  it('places Vara and the three wolves with their asset ids and no unrelated canonical entities', () => {
    expect(region.entities.map(entity => [entity.id, entity.actorId, entity.assetId])).toEqual([
      ['moonpine-vara', 'vara', 'actor-vara'],
      ['moonpine-frostfang', 'moonpine-frostfang', 'actor-frostfang-tracker'],
      ['moonpine-scout', 'moonpine-scout', 'actor-howl-scout'],
      ['moonpine-ruun', 'moonpine-ruun', 'actor-ruun-chained-howl'],
    ]);
    expect(region.entities.every(entity => entity.kind === 'actor')).toBe(true);
    for (const trial of MOONPINE_COMBAT_TRIALS) expect(region.entities.find(entity => entity.id === trial.monsterId)!.position).toEqual(trial.monsterPosition);
    expect(region.encounterIds).toEqual(['moonpine-trials']);
    expect(region.encounterParticipants['moonpine-trials']).toEqual(['moonpine-frostfang', 'moonpine-scout', 'moonpine-ruun']);
    expect(region.assetIds).toEqual(expect.arrayContaining(['actor-frostfang-tracker', 'actor-howl-scout', 'actor-ruun-chained-howl', 'actor-vara', 'prop-moonpine-tree', 'prop-snow-ridge-rock', 'prop-buried-wolf-temple', 'prop-temple-chain-anchor', 'prop-moonpine-log-bridge']));
    expect(new Set(region.assetIds).size).toBe(region.assetIds.length);
  });

  it('places the log bridge, the temple, four chain anchors, hollow rocks and pines as authored, with unique ids and solid kinds', () => {
    expect(new Set(region.props.map(prop => prop.id)).size).toBe(region.props.length);
    const bridge = region.props.find(prop => prop.id === 'moonpine-trial-bridge')!;
    expect(bridge).toMatchObject({ assetId: 'prop-moonpine-log-bridge', position: { x: -9, y: 0, z: -22 }, placement: 'elevated' });
    expect(bridge.rotationY).toBeCloseTo(Math.PI / 2, 12);
    expect(solidPropKind(bridge)).toBe('platform');
    // Span x -14.6..-3.4 from a ~12 m long model.
    expect(bridge.scale.z * 12).toBeCloseTo(11.2, 9);
    expect(region.props.find(prop => prop.id === 'moonpine-trial-temple')).toMatchObject({ assetId: 'prop-buried-wolf-temple', position: { x: 47, y: 4, z: -45 } });
    expect(solidPropKind(region.props.find(prop => prop.id === 'moonpine-trial-temple')!)).toBe('solid');
    const anchors = region.props.filter(prop => prop.assetId === 'prop-temple-chain-anchor');
    expect(anchors).toHaveLength(4);
    const walkablePoints = region.ground.surfaces.flatMap(surface => surface.points);
    for (const anchor of anchors) {
      expect(solidPropKind(anchor)).toBe('solid');
      expect(anchor.position.y).toBe(4);
      // The posts stand behind the terrace rim, never on the arena of The Alpha Below.
      const arenaOfRuun = MOONPINE_COMBAT_TRIALS[2]!.arena;
      expect(Math.hypot(anchor.position.x - arenaOfRuun.center.x, anchor.position.z - arenaOfRuun.center.z)).toBeGreaterThan(arenaOfRuun.radius + 4);
      expect(groundHeightAt(arena, anchor.position.x, anchor.position.z, 4)).toBeNull();
    }
    const rocks = region.props.filter(prop => prop.id.startsWith('moonpine-trial-rock-'));
    expect(rocks).toHaveLength(3);
    for (const rock of rocks) expect(Math.hypot(rock.position.x - MOONPINE_COMBAT_TRIALS[1]!.arena.center.x, rock.position.z - MOONPINE_COMBAT_TRIALS[1]!.arena.center.z)).toBeGreaterThan(MOONPINE_COMBAT_TRIALS[1]!.arena.radius + 2);
    const pines = region.props.filter(prop => prop.id.startsWith('moonpine-trial-pine-'));
    expect(pines).toHaveLength(7);
    for (const pine of pines) {
      expect(solidPropKind(pine)).toBe('trunk');
      // Pines stand outside the walk-mesh, on the side away from the locked camera offset (+10, +12, +14).
      const nearest = walkablePoints.reduce((best, point) => Math.hypot(point.x - pine.position.x, point.z - pine.position.z) < Math.hypot(best.x - pine.position.x, best.z - pine.position.z) ? point : best);
      const dx = pine.position.x - nearest.x, dz = pine.position.z - nearest.z, distance = Math.hypot(dx, dz);
      expect(distance).toBeGreaterThan(4);
      expect((dx * 10 + dz * 14) / (distance * Math.hypot(10, 14))).toBeLessThan(0.2);
    }
  });

  it('loads into the engine and starts the Moonpine encounter with its three wolves on their trial spawns', () => {
    const engine = new CombatEngine();
    const present = region.entities.map(entity => entity.id);
    engine.loadRegion({ regionId: 'moonpine-ridge', regionDefinition: region, runId: 'moonpine-load', presentActorIds: present });
    engine.startEncounter({ encounterId: 'moonpine-trials', regionId: 'moonpine-ridge', runId: 'moonpine-load' });
    engine.enableCombatTrials();
    const snapshot = engine.snapshot();
    const player = snapshot.actors.find(actor => actor.id === 'aren')!;
    expect(player.position).toEqual({ x: -66, y: 0, z: -22 });
    for (const trial of MOONPINE_COMBAT_TRIALS) {
      const monster = snapshot.actors.find(actor => actor.id === trial.monsterId)!;
      expect(monster.position).toEqual(trial.monsterPosition);
      expect(monster.allegiance).toBe('hostile');
      expect(monster.renderVariantId).toBe(trial.monsterAssetId);
    }
    expect(snapshot.trialGates!.map(gate => [gate.id, gate.open])).toEqual([['frozen-shore', false], ['scouts-hollow', false], ['alpha-below', false]]);
    expect(snapshot.encounterStatus!.title).toBe('Frozen Shore');
    expect(snapshot.encounterStatus!.monsters.map(monster => monster.name)).toEqual(['Frostfang Tracker', 'Howl Scout', 'Ruun, the Chained Howl']);
    expect(snapshot.encounterStatus!.monsters[0]!.skills).toEqual(['pack rush', 'ice bite', 'frost breath']);
    expect(snapshot.encounterStatus!.monsters[1]!.skills).toEqual(['flank pounce', 'claw rake', 'low howl']);
    expect(snapshot.encounterStatus!.monsters[2]!.skills).toEqual(['chain pounce', 'howl shockwave', 'breaking ice']);
  });
});

const IDLE: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };

/** Walks Aren along the navigation nodes with the real engine (monsters hidden), returning the furthest node reached and the final position. */
function walkRoute(openGates: number): { reached: number; position: Vec3 } {
  const engine = new CombatEngine();
  engine.loadRegion({ regionId: 'moonpine-ridge', regionDefinition: region, runId: 'moonpine-walk', presentActorIds: region.entities.filter(entity => entity.actorId).map(entity => entity.id), playerPosition: region.navigation.nodes[0]!.position });
  engine.startEncounter({ encounterId: 'moonpine-trials', regionId: 'moonpine-ridge', runId: 'moonpine-walk' });
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

describe('Moonpine Ridge route with the real engine', () => {
  it('walks from the spawn to the stage exit only when all three gates are open', () => {
    const goals = region.navigation.nodes.length;
    const open = walkRoute(3);
    expect(open.reached).toBe(goals);
    expect(Math.hypot(open.position.x - exit.x, open.position.z - exit.z)).toBeLessThan(0.8);
  }, 60000);

  it('stops at the first closed gate, then the second, then the third', () => {
    // Gate x / z positions: frozen-shore x -29, scouts-hollow x 20, alpha-below z -5.
    const closed1 = walkRoute(0);
    expect(closed1.position.x).toBeLessThan(-29);
    const closed2 = walkRoute(1);
    expect(closed2.position.x).toBeGreaterThan(-29);
    expect(closed2.position.x).toBeLessThan(20);
    const closed3 = walkRoute(2);
    expect(closed3.position.x).toBeGreaterThan(20);
    expect(closed3.position.z).toBeLessThan(-5);
    expect(closed3.position.y).toBeGreaterThan(3.9);
  }, 120000);
});
