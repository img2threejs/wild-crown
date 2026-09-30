import { describe, expect, it } from 'bun:test';
import type { Bounds3, GroundSurfaceDefinition, RegionColliderDefinition, RegionRouteDefinition } from '../../src/game/contracts.js';
import { arenaFromRegion, groundHeightAt, moveCircle, traversalRouteAt, type CombatArena } from '../../src/game/combat/geometry.js';

const bounds: Bounds3 = { min: { x: -10, y: -2, z: -10 }, max: { x: 10, y: 8, z: 10 } };
const flat: GroundSurfaceDefinition = {
  id: 'floor', profile: 'plane', points: [{ x: -10, y: 0, z: -10 }, { x: 10, y: 0, z: -10 }, { x: 10, y: 0, z: 10 }, { x: -10, y: 0, z: 10 }],
  elevation: 0, walkable: true, material: 'stone', colliderId: 'floor-collider',
};
function arena(colliders: readonly RegionColliderDefinition[] = [], surfaces: readonly GroundSurfaceDefinition[] = [flat]): CombatArena {
  return { bounds, groundY: 0, surfaces, colliders, routes: [], obstacles: [] };
}

describe('shared terrain and collision geometry', () => {
  it('follows authored ramp elevation and rejects unsupported terrain', () => {
    const ramp: GroundSurfaceDefinition = {
      id: 'ramp', profile: 'ramp', points: [{ x: 0, y: 0, z: -2 }, { x: 4, y: 2, z: -2 }, { x: 4, y: 2, z: 2 }, { x: 0, y: 0, z: 2 }],
      elevation: 0, walkable: true, material: 'earth', colliderId: 'ramp-collider',
    };
    const terrain = arena([], [ramp]);
    expect(groundHeightAt(terrain, 3, 0, 1.5)).toBeCloseTo(1.5);
    expect(groundHeightAt(terrain, -1, 0, 0)).toBeNull();
    const moved = moveCircle(terrain, { x: 0.5, y: 0.25, z: 0 }, { x: 1.5, y: 0, z: 0 }, 0.2);
    expect(moved.x).toBeGreaterThan(1.8);
    expect(moved.y).toBeCloseTo(moved.x * 0.5);
  });

  it('does not tunnel through thin segments or clip around a box corner', () => {
    const segment: RegionColliderDefinition = { id: 'thin', kind: 'segment', from: { x: 1, y: 0, z: -4 }, to: { x: 1, y: 0, z: 4 }, radius: 0.025, blocksMovement: true, blocksCamera: false };
    const segmentResult = moveCircle(arena([segment]), { x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, 0.3);
    expect(segmentResult.x).toBeLessThan(0.68);
    const box: RegionColliderDefinition = { id: 'corner', kind: 'box', from: { x: 1, y: 1, z: 1 }, halfExtents: { x: 0.5, y: 1, z: 0.5 }, blocksMovement: true, blocksCamera: false };
    const cornerResult = moveCircle(arena([box]), { x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 2 }, 0.35);
    expect(cornerResult.x).toBeLessThan(0.66);
    expect(cornerResult.z).toBeLessThan(0.66);
  });

  it('uses capsule radius and vertical overlap, and exposes authored traversal anchors', () => {
    const raised: RegionColliderDefinition = { id: 'raised-capsule', kind: 'capsule', from: { x: 2, y: 4, z: -2 }, to: { x: 2, y: 4, z: 2 }, radius: 0.5, blocksMovement: true, blocksCamera: false };
    const high = moveCircle(arena([raised]), { x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, 0.3);
    expect(high.x).toBeGreaterThan(3.5);
    const low: RegionColliderDefinition = { ...raised, from: { x: 2, y: 1, z: -2 }, to: { x: 2, y: 1, z: 2 } };
    expect(moveCircle(arena([low]), { x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, 0.3).x).toBeLessThan(1.3);

    const route = { id: 'vault', from: { x: 0, y: 0, z: 0 }, to: { x: 3, y: 1, z: 0 }, anchors: [{ x: 1, y: 1.8, z: 0 }], destinationRegionId: 'greenwake', kind: 'path', traversalActionId: 'staff-vault', colliderIds: ['wall'], traversalEvent: 'vaulted' } as unknown as RegionRouteDefinition;
    const region = { bounds, ground: { y: 0, surfaces: [flat], colliders: [] }, traversalArcs: [route] } as unknown as Parameters<typeof arenaFromRegion>[0];
    const authored = arenaFromRegion(region);
    expect(traversalRouteAt(authored, { x: 1, y: 1.8, z: 0 })).toBe(route);
    expect(authored.traversalAffordances?.[0]?.kind).toBe('staff-vault');
  });
});
