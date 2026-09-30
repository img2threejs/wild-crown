import { describe, expect, it } from 'bun:test';
import type { Bounds3, GroundSurfaceDefinition, RegionRouteDefinition } from '../../src/game/contracts.js';
import { arenaFromRegion, traversalRouteAt } from '../../src/game/combat/geometry.js';

const bounds: Bounds3 = { min: { x: -5, y: -2, z: -5 }, max: { x: 5, y: 8, z: 5 } };
const floor: GroundSurfaceDefinition = {
  id: 'floor', profile: 'plane', points: [{ x: -5, y: 0, z: -5 }, { x: 5, y: 0, z: -5 }, { x: 5, y: 0, z: 5 }, { x: -5, y: 0, z: 5 }],
  elevation: 0, walkable: true, material: 'stone', colliderId: 'floor',
};
const route = {
  id: 'canopy-swing', from: { x: -1, y: 0, z: 0 }, to: { x: 2, y: 3, z: 0 }, anchors: [{ x: 0.5, y: 2, z: 0 }],
  destinationRegionId: 'greenwake', kind: 'canopy', traversalActionId: 'swing', colliderIds: ['canopy-rope'], traversalEvent: 'swung',
} as unknown as RegionRouteDefinition;
const region = {
  id: 'greenwake', bounds, ground: { y: 0, surfaces: [floor], colliders: [] }, traversalArcs: [route],
} as unknown as Parameters<typeof arenaFromRegion>[0];

describe('authored traversal anchor heights', () => {
  it('matches a real 3D route anchor but not an XZ-overlapping point on another floor', () => {
    const arena = arenaFromRegion(region);
    expect(traversalRouteAt(arena, { x: 0.5, y: 2, z: 0 })).toBe(route);
    expect(traversalRouteAt(arena, { x: 0.5, y: 6, z: 0 })).toBeNull();
  });
});
