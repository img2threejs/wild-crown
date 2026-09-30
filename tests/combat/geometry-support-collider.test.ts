import { describe, expect, it } from 'bun:test';
import type { Bounds3, GroundSurfaceDefinition, RegionColliderDefinition } from '../../src/game/contracts.js';
import { moveAerialCircle, moveCircle, type CombatArena } from '../../src/game/combat/geometry.js';

const bounds: Bounds3 = { min: { x: -5, y: -2, z: -5 }, max: { x: 5, y: 8, z: 5 } };
const floor: GroundSurfaceDefinition = {
  id: 'floor', profile: 'plane', points: [{ x: -5, y: 0, z: -5 }, { x: 5, y: 0, z: -5 }, { x: 5, y: 0, z: 5 }, { x: -5, y: 0, z: 5 }],
  elevation: 0, walkable: true, material: 'stone', colliderId: 'floor-collider',
};
const top: GroundSurfaceDefinition = {
  id: 'platform-top', profile: 'terrace', points: [{ x: -2, y: 1.4, z: -2 }, { x: 2, y: 1.4, z: -2 }, { x: 2, y: 1.4, z: 2 }, { x: -2, y: 1.4, z: 2 }],
  elevation: 1.4, walkable: true, material: 'stone', colliderId: 'platform-box',
};
const platform: RegionColliderDefinition = {
  id: 'platform-box', kind: 'box', from: { x: 0, y: 1.3, z: 0 }, halfExtents: { x: 2, y: 0.1, z: 2 },
  blocksMovement: true, blocksCamera: false, walkSurfaceId: 'platform-top',
};
const arena: CombatArena = { bounds, groundY: 0, surfaces: [floor, top], colliders: [platform], routes: [], obstacles: [] };

describe('walkable platform collider contact', () => {
  it('blocks a standing capsule that passes beneath the authored walk surface', () => {
    const result = moveCircle(arena, { x: 0, y: 0, z: -3 }, { x: 0, y: 0, z: 6 }, 0.32);
    expect(result.z).toBeLessThan(-2.25);
  });

  it('allows a low slide under the platform and flight above it', () => {
    const sliding = moveCircle(arena, { x: 0, y: 0, z: -3 }, { x: 0, y: 0, z: 6 }, 0.32, 0.75);
    expect(sliding.z).toBeGreaterThan(2.9);
    const flying = moveAerialCircle(arena, { x: 0, y: 2, z: -3 }, { x: 0, y: 0, z: 6 }, 0.32, 0.8);
    expect(flying.z).toBeGreaterThan(2.9);
    expect(flying.y).toBe(2);
  });

  it('allows exact top-surface contact but blocks an excessive unsupported step', () => {
    const onTop = moveCircle(arena, { x: -1, y: 1.4, z: 0 }, { x: 2, y: 0, z: 0 }, 0.32);
    expect(onTop.x).toBeGreaterThan(0.9);
    const stepUp = moveCircle(arena, { x: -3, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, 0.32);
    expect(stepUp.x).toBeLessThan(-2.25);
  });
});
