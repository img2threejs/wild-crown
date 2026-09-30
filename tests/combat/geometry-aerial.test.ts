import { describe, expect, it } from 'bun:test';
import type { Bounds3, GroundSurfaceDefinition, RegionColliderDefinition } from '../../src/game/contracts.js';
import { moveAerialCircle, type CombatArena } from '../../src/game/combat/geometry.js';

const bounds: Bounds3 = { min: { x: -4, y: 0, z: -4 }, max: { x: 4, y: 8, z: 4 } };
const ground: GroundSurfaceDefinition = {
  id: 'ground', profile: 'plane', points: [{ x: -4, y: 0, z: -4 }, { x: 4, y: 0, z: -4 }, { x: 4, y: 0, z: 4 }, { x: -4, y: 0, z: 4 }],
  elevation: 0, walkable: true, material: 'earth', colliderId: 'ground',
};
function arena(colliders: readonly RegionColliderDefinition[] = []): CombatArena {
  return { bounds, groundY: 0, surfaces: [ground], colliders, routes: [], obstacles: [] };
}

describe('aerial capsule movement', () => {
  it('keeps Vara above ground and passes over low proxies without teleporting', () => {
    const low: RegionColliderDefinition = { id: 'root', kind: 'segment', from: { x: 0, y: 0, z: -2 }, to: { x: 0, y: 0, z: 2 }, radius: 0.2, blocksMovement: true, blocksCamera: false };
    let position = { x: -1, y: 2, z: 0 };
    for (let tick = 0; tick < 20; tick++) position = moveAerialCircle(arena([low]), position, { x: 0.05, y: 0, z: 0 }, 0.25);
    expect(position.x).toBeCloseTo(0, 1);
    expect(position.y).toBe(2);
  });

  it('stops at tall colliders and honors authored vertical bounds', () => {
    const canopy: RegionColliderDefinition = { id: 'canopy', kind: 'box', from: { x: 0, y: 3, z: 0 }, halfExtents: { x: 0.2, y: 2, z: 1 }, blocksMovement: true, blocksCamera: false };
    const stopped = moveAerialCircle(arena([canopy]), { x: -1, y: 2.5, z: 0 }, { x: 2, y: 0, z: 0 }, 0.25);
    expect(stopped.x).toBeLessThan(-0.44);
    expect(stopped.y).toBe(2.5);
    const ceiling = moveAerialCircle(arena(), { x: 0, y: 7.5, z: 0 }, { x: 0, y: 2, z: 0 }, 0.25);
    expect(ceiling.y).toBeLessThanOrEqual(bounds.max.y - 1.7);
  });
});
