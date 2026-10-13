import { describe, expect, it } from 'bun:test';
import { REGIONS } from '../../src/content/campaign.js';
import { solidPropKind } from '../../src/content/solid-props.js';
import { CANOPY_COMBAT_TRIALS } from '../../src/game/combat/CombatTrials.js';
import { createCanopyTrialRegion } from '../../src/game/combat/CanopyTrialRegion.js';
import { createCombatTrialRegion } from '../../src/game/combat/TrialRegions.js';
import { CombatEngine } from '../../src/game/combat/CombatEngine.js';
import { arenaFromRegion, groundHeightAt, vec } from '../../src/game/combat/geometry.js';
import type { RegionDefinition } from '../../src/game/contracts.js';
import { describeSealedRoute } from './sealed-route-harness.js';

const authored = REGIONS.find(region => region.id === 'whispering-canopy')!;
const region: RegionDefinition = createCombatTrialRegion(authored);
const arena = arenaFromRegion(region);
const exit = region.exits.find(route => route.id === 'canopy-trial-exit')!.from;

describeSealedRoute({
  name: 'Whispering Canopy', regionId: 'whispering-canopy', encounterId: 'canopy-trials', region, trials: CANOPY_COMBAT_TRIALS,
  start: region.navigation.nodes[0]!.position, exit, forward: [vec(1, 0, 0), vec(1, 0, 0), vec(0, 0, 1)], minWalkableCells: 5000,
});

describe('Whispering Canopy trial region', () => {
  it('is built by the shared dispatcher and leaves the canonical region untouched', () => {
    const before = JSON.stringify(authored);
    expect(JSON.stringify(createCanopyTrialRegion(authored))).toBe(JSON.stringify(region));
    expect(JSON.stringify(authored)).toBe(before);
    expect(region.id).toBe('whispering-canopy');
    expect(region.environmentRecipeId).toBe('whispering-canopy-environment');
    expect(createCombatTrialRegion(REGIONS.find(candidate => candidate.id === 'blood-bamboo-valley')!)).toBe(REGIONS.find(candidate => candidate.id === 'blood-bamboo-valley')!);
  });

  it('lays out the nine walk surfaces with their contract ids, floors and materials', () => {
    const expected: Record<string, { y: [number, number]; material: string }> = {
      'canopy-trial-basin': { y: [0, 0], material: 'canopy-trail-earth' },
      'canopy-trial-root-stair': { y: [0, 4], material: 'canopy-trail-earth' },
      'canopy-trial-fig-ledge': { y: [4, 4], material: 'canopy-trail-earth' },
      'canopy-trial-gorge-bridge': { y: [4, 4], material: 'canopy-bridge-deck' },
      'canopy-trial-roost': { y: [4, 4], material: 'canopy-trail-earth' },
      'canopy-trial-chasm-bridge': { y: [4, 4], material: 'canopy-bridge-deck' },
      'canopy-trial-temple-descent': { y: [0, 4], material: 'canopy-trail-earth' },
      'canopy-trial-courtyard': { y: [0, 0], material: 'canopy-trail-earth' },
      'canopy-trial-exit-path': { y: [0, 0], material: 'canopy-trail-earth' },
    };
    expect(region.ground.surfaces.map(surface => surface.id).sort()).toEqual(Object.keys(expected).sort());
    for (const surface of region.ground.surfaces) {
      const want = expected[surface.id]!;
      expect(surface.walkable).toBe(true);
      expect(surface.material).toBe(want.material);
      expect([Math.min(...surface.points.map(point => point.y)), Math.max(...surface.points.map(point => point.y))]).toEqual(want.y);
      const collider = region.ground.colliders.find(candidate => candidate.id === surface.colliderId)!;
      expect(collider.walkSurfaceId).toBe(surface.id);
      // Boxes support flat tops flush with the floor; ramps carry a non-blocking centre-line segment.
      if (surface.profile === 'ramp') { expect(collider.kind).toBe('segment'); expect(collider.blocksMovement).toBe(false); }
      else { expect(collider.kind).toBe('box'); expect(collider.blocksMovement).toBe(true); expect(collider.from.y + collider.halfExtents!.y).toBeCloseTo(surface.elevation, 9); }
    }
    expect(region.ground.surfaces.find(surface => surface.id === 'canopy-trial-courtyard')!.points).toHaveLength(8);
  });

  it('places Aren, the navigation route, the exit and the cameras on walkable floor', () => {
    const nodes = region.navigation.nodes;
    expect(nodes[0]!.position).toEqual({ x: -58, y: 0, z: -20 });
    const ids = new Set(nodes.map(node => node.id));
    for (const node of nodes) {
      expect(groundHeightAt(arena, node.position.x, node.position.z, node.position.y)).toBeCloseTo(node.position.y, 6);
      for (const link of node.links) expect(ids.has(link)).toBe(true);
    }
    for (const ribbon of region.navigation.ribbons) for (const point of ribbon.points) {
      expect(groundHeightAt(arena, point.x, point.z, point.y)).toBeCloseTo(point.y, 6);
    }
    expect(exit).toEqual({ x: 47, y: 0, z: 7 });
    // The 2.2 m goal ring lies completely on the exit path.
    for (let step = 0; step < 36; step++) {
      const angle = step / 36 * Math.PI * 2;
      expect(groundHeightAt(arena, exit.x + Math.cos(angle) * 2.2, exit.z + Math.sin(angle) * 2.2, 0)).toBe(0);
    }
    expect(region.entrances).toEqual([]);
    expect(region.traversalArcs).toEqual([]);
    expect(region.cameraAnchors.length).toBeGreaterThanOrEqual(4);
    for (const anchor of region.cameraAnchors) expect(anchor.position.x - anchor.lookAt.x).toBe(10);
  });

  it('places Vara and the three monsters with their asset ids and no unrelated canonical entities', () => {
    expect(region.entities.map(entity => [entity.id, entity.actorId, entity.assetId])).toEqual([
      ['canopy-vara', 'vara', 'actor-vara'],
      ['canopy-howler', 'canopy-howler', 'actor-thornback-howler'],
      ['canopy-hornbill', 'canopy-hornbill', 'actor-storm-hornbill'],
      ['canopy-mire-viper', 'canopy-mire-viper', 'actor-mire-viper'],
    ]);
    expect(region.entities.every(entity => entity.kind === 'actor')).toBe(true);
    for (const trial of CANOPY_COMBAT_TRIALS) {
      expect(region.entities.find(entity => entity.id === trial.monsterId)!.position).toEqual(trial.monsterPosition);
    }
    expect(region.encounterIds).toEqual(['canopy-trials']);
    expect(region.encounterParticipants['canopy-trials']).toEqual(['canopy-howler', 'canopy-hornbill', 'canopy-mire-viper']);
  });

  it('places the two vine bridges, the shrine and the giant trees as authored, with unique ids and solid kinds', () => {
    expect(new Set(region.props.map(prop => prop.id)).size).toBe(region.props.length);
    const bridgeA = region.props.find(prop => prop.id === 'canopy-trial-bridge-a')!, bridgeB = region.props.find(prop => prop.id === 'canopy-trial-bridge-b')!;
    expect(bridgeA.position).toEqual({ x: -9, y: 4, z: -28.5 });
    expect(bridgeB.position).toEqual({ x: 18.5, y: 4, z: -23.5 });
    for (const bridge of [bridgeA, bridgeB]) {
      expect(bridge.assetId).toBe('prop-vine-bridge');
      expect(bridge.rotationY).toBeCloseTo(Math.PI / 2, 12);
      expect(solidPropKind(bridge)).toBe('platform');
    }
    // Span x -14.6..-3.4 and 12.7..24.3 from a ~12 m long model.
    expect(bridgeA.scale.z * 12).toBeCloseTo(11.2, 9);
    expect(bridgeB.scale.z * 12).toBeCloseTo(11.6, 9);
    expect(region.props.find(prop => prop.id === 'canopy-trial-shrine')).toMatchObject({ assetId: 'prop-ancient-canopy-shrine', position: { x: 47, y: 0, z: -38 } });
    // The authored giant trees; boundary dressing (ids `canopy-boundary-*`, world team) adds decoration-only trees on top.
    const trees = region.props.filter(prop => prop.assetId === 'prop-rainforest-canopy-tree' && prop.id.startsWith('canopy-trial-tree-'));
    expect(trees).toHaveLength(6);
    for (const tree of trees) {
      expect(solidPropKind(tree)).toBe('trunk');
      // Giant trees stand outside the walk-mesh, on the side away from the locked camera offset (+10, +12, +14),
      // so a trunk never fills the foreground between the camera and the route.
      const points = region.ground.surfaces.flatMap(surface => surface.points);
      const nearest = points.reduce((best, point) => Math.hypot(point.x - tree.position.x, point.z - tree.position.z) < Math.hypot(best.x - tree.position.x, best.z - tree.position.z) ? point : best);
      const dx = tree.position.x - nearest.x, dz = tree.position.z - nearest.z, distance = Math.hypot(dx, dz);
      expect(distance).toBeGreaterThan(4);
      expect((dx * 10 + dz * 14) / (distance * Math.hypot(10, 14))).toBeLessThan(0.2);
    }
  });

  it('loads into the engine and starts the canopy encounter with its three monsters on their trial spawns', () => {
    const engine = new CombatEngine();
    const present = region.entities.map(entity => entity.id);
    engine.loadRegion({ regionId: 'whispering-canopy', regionDefinition: region, runId: 'canopy-load', presentActorIds: present });
    engine.startEncounter({ encounterId: 'canopy-trials', regionId: 'whispering-canopy', runId: 'canopy-load' });
    engine.enableCombatTrials();
    const snapshot = engine.snapshot();
    const player = snapshot.actors.find(actor => actor.id === 'aren')!;
    expect(player.position).toEqual({ x: -58, y: 0, z: -20 });
    for (const trial of CANOPY_COMBAT_TRIALS) {
      const monster = snapshot.actors.find(actor => actor.id === trial.monsterId)!;
      expect(monster.position).toEqual(trial.monsterPosition);
      expect(monster.allegiance).toBe('hostile');
      expect(monster.renderVariantId).toBe(trial.monsterAssetId);
    }
    expect(snapshot.trialGates!.map(gate => [gate.id, gate.open])).toEqual([['howler-pool', false], ['hornbill-roost', false], ['viper-temple', false]]);
    expect(snapshot.encounterStatus!.title).toBe("Howler's Pool");
    expect(snapshot.encounterStatus!.monsters.map(monster => monster.name)).toEqual(['Thornback Howler', 'Storm Hornbill', 'Mire Viper']);
    expect(snapshot.encounterStatus!.monsters[0]!.skills).toEqual(['rock hurl', 'leap slam', 'branch sweep']);
  });
});
