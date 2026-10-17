import { describe, expect, it } from 'bun:test';
import type { Bounds3, GroundSurfaceDefinition, RegionColliderDefinition, RegionRouteDefinition } from '../../src/game/contracts.js';
import {
  arenaFromRegion, clampVerticalToSupport, findEdgeDrop, groundHeightAt, isAerialCirclePathClear, isSupportedCapsulePose, landingHeightAt, moveAerialCircle, moveCircle,
  restingHeightAt, stepFall, traversalRouteAt, type CombatArena, type FallStep, type SupportField,
} from '../../src/game/combat/geometry.js';

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

  it('climbs an overlapping ramp and steps onto its raised landing without catching the platform lip', () => {
    const ramp: GroundSurfaceDefinition = {
      id: 'ramp', profile: 'ramp',
      points: [{ x: 6, y: 0, z: 4 }, { x: 13, y: 0, z: 4 }, { x: 13, y: 2, z: 14 }, { x: 6, y: 2, z: 14 }],
      elevation: 0, walkable: true, material: 'earth', colliderId: 'ramp-collider',
    };
    const stacked: GroundSurfaceDefinition = {
      ...flat, points: [{ x: -10, y: 0, z: -10 }, { x: 10, y: 0, z: -10 }, { x: 10, y: 0, z: 7 }, { x: -10, y: 0, z: 7 }],
    };
    const landing: GroundSurfaceDefinition = {
      ...flat, id: 'landing', colliderId: 'landing-collider',
      points: [{ x: 6, y: 2, z: 14 }, { x: 13, y: 2, z: 14 }, { x: 13, y: 2, z: 18 }, { x: 6, y: 2, z: 18 }],
    };
    const collider: RegionColliderDefinition = {
      id: 'landing-collider', kind: 'box', from: { x: 9.5, y: 1.85, z: 16 },
      halfExtents: { x: 3.5, y: 0.15, z: 2 }, walkSurfaceId: 'landing', blocksMovement: true, blocksCamera: false,
    };
    const terrain = { ...arena([collider], [stacked, ramp, landing]), bounds: { ...bounds, max: { ...bounds.max, z: 18 } } };
    let position = { x: 9, y: 0, z: 3 };
    for (let i = 0; i < 220; i++) position = moveCircle(terrain, position, { x: 0, y: 0, z: 0.06 }, 0.42);
    expect(position.z).toBeCloseTo(16.2, 4);
    expect(position.y).toBeCloseTo(2, 4);
    // A body resting on the ramp beside the landing lip is supported, capsule fit included: the lip is a step, not a wall.
    expect(restingHeightAt(terrain, 9, 13.8, 1.96, 1.94, 0.42, 1.6)).toBeCloseTo(1.96, 2);
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

/** A uniform solid column grid over [x0, x1] x [z0, z1] (0.25 m cells): a crate, a deck slab, a lip. */
function column(id: string, kind: SupportField['kind'], x0: number, z0: number, x1: number, z1: number, top: number, bottom: number, stand = 1): SupportField {
  const cell = 0.25, cols = Math.round((x1 - x0) / cell), rows = Math.round((z1 - z0) / cell), count = cols * rows;
  return { id, ownerId: id, kind, minX: x0, minZ: z0, cell, cols, rows, minY: bottom, maxY: top, top: Array<number>(count).fill(top), bottom: Array<number>(count).fill(bottom), stand: Array<number>(count).fill(stand) };
}
const withSupports = (supports: readonly SupportField[], surfaces: readonly GroundSurfaceDefinition[] = [flat]): CombatArena => ({ ...arena([], surfaces), supports });
const RADIUS = 0.42, HEIGHT = 1.6;
const jump = (from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }, apex: number, ticks = 42) =>
  (tick: number) => ({ x: from.x + (to.x - from.x) * tick / ticks, y: from.y + (to.y - from.y) * tick / ticks + 4 * apex * (tick / ticks) * (1 - tick / ticks), z: from.z + (to.z - from.z) * tick / ticks });
function arcClear(world: CombatArena, path: (tick: number) => { x: number; y: number; z: number }, ticks = 42): boolean {
  for (let tick = 1; tick <= ticks; tick++) if (!isAerialCirclePathClear(world, path(tick - 1), path(tick), RADIUS, HEIGHT)) return false;
  return true;
}

describe('measured support fields', () => {
  const crate = column('crate', 'top', 2, -1, 4, 1, 1, 0);

  it('blocks walking into the side of a prop but steps onto a low one', () => {
    expect(moveCircle(withSupports([crate]), { x: 0, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, 0.32).x).toBeLessThan(1.7);
    const stone = column('stone', 'top', 2, -1, 4, 1, 0.4, 0);
    const across = moveCircle(withSupports([stone]), { x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }, 0.32);
    expect(across.x).toBeCloseTo(5, 1);
    expect(moveCircle(withSupports([stone]), { x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 0 }, 0.32).y).toBeCloseTo(0.4);
  });

  it('lands a jump on a reachable prop top, never on a roof beyond the rise, and stands on it stably', () => {
    const world = withSupports([crate]);
    expect(landingHeightAt(world, 3, 0, { fromY: 0, maxRise: 0.95, maxDrop: 3, radius: RADIUS, height: HEIGHT })).toBeNull();
    expect(landingHeightAt(world, 1, 0, { fromY: 0, maxRise: 0.95, maxDrop: 3, radius: RADIUS, height: HEIGHT })).toBeCloseTo(0, 6);
    expect(landingHeightAt(world, 3, 0, { fromY: 0, maxRise: 1.2, maxDrop: 3, radius: RADIUS, height: HEIGHT })).toBeCloseTo(1, 6);
    expect(arcClear(world, jump({ x: 0.5, y: 0, z: 0 }, { x: 3, y: 1, z: 0 }, 1.25))).toBe(true);
    expect(arcClear(world, jump({ x: 0.5, y: 0, z: 0 }, { x: 3, y: 1, z: 0 }, 0))).toBe(false);
    expect(isSupportedCapsulePose(world, { x: 3, y: 1, z: 0 }, RADIUS, HEIGHT)).toBe(true);
    expect(isSupportedCapsulePose(world, { x: 2.1, y: 1, z: 0 }, RADIUS, HEIGHT)).toBe(false);
    let position = { x: 3.2, y: 1, z: 0 };
    for (let tick = 0; tick < 30; tick++) position = moveCircle(world, position, { x: -0.03, y: 0, z: 0.02 }, RADIUS, HEIGHT);
    expect(position.y).toBeCloseTo(1, 6);
    expect(groundHeightAt(world, position.x, position.z, position.y)).toBeCloseTo(1, 6);
  });

  it('keeps the descent on the support it meets instead of passing through it', () => {
    const world = withSupports([crate]);
    expect(moveAerialCircle(world, { x: 3, y: 2.5, z: 0 }, { x: 0, y: -3, z: 0 }, RADIUS, HEIGHT).y).toBeCloseTo(1, 6);
    expect(clampVerticalToSupport(world, 3, 0, 2.5, -0.5, HEIGHT)).toBeCloseTo(1, 6);
    expect(clampVerticalToSupport(world, 0.5, 0, 2.5, -0.5, HEIGHT)).toBeCloseTo(-0.5, 6);
  });

  it('leaves a prop top as a fall onto the nearest lower support, not as a clamp on the ledge', () => {
    const world = withSupports([crate]);
    const drop = findEdgeDrop(world, { x: 3.4, y: 1, z: 0 }, { x: 1.2, y: 0, z: 0 }, RADIUS, HEIGHT, 3);
    expect(drop).not.toBeNull();
    expect(drop!.edge.y).toBeCloseTo(1, 6);
    expect(drop!.edge.x).toBeLessThanOrEqual(4.01);
    expect(drop!.landing.x).toBeLessThan(4.1);
    expect(drop!.landing.y).toBeCloseTo(0, 6);
    expect(findEdgeDrop(world, { x: 3, y: 1, z: 0 }, { x: -0.5, y: 0, z: 0 }, RADIUS, HEIGHT, 3)).toBeNull();
    // Walking off: the body starts the fall at the first step past the edge (rim still over the prop) and slides clear, without a jump.
    const out: FallStep = { x: 0, y: 0, z: 0, landed: false };
    let pose = { x: drop!.landing.x, y: drop!.edge.y, z: drop!.landing.z };
    let widest = 0;
    for (let tick = 0; tick < 120 && !out.landed; tick++) {
      stepFall(world, pose, -0.02 - tick * 0.002, RADIUS, HEIGHT, out);
      widest = Math.max(widest, Math.hypot(out.x - pose.x, out.z - pose.z));
      pose = { x: out.x, y: out.y, z: out.z };
    }
    expect(out.landed).toBe(true);
    expect(pose.y).toBeCloseTo(0, 6);
    expect(pose.x).toBeGreaterThanOrEqual(4.0);
    expect(widest).toBeLessThanOrEqual(0.03 + 1e-9);
  });

  it('slides a falling body off a lip it cannot stand on instead of hanging in the air', () => {
    const lip = column('lip', 'top', 2, -1, 2.25, 1, 0.6, 0, 0);
    const world = withSupports([lip]);
    const out: FallStep = { x: 0, y: 0, z: 0, landed: false };
    let pose = { x: 1.95, y: 1, z: 0 };
    for (let tick = 0; tick < 60 && !out.landed; tick++) { stepFall(world, pose, -0.05, RADIUS, HEIGHT, out); pose = { x: out.x, y: out.y, z: out.z }; }
    expect(out.landed).toBe(true);
    expect(pose.y).toBeCloseTo(0, 6);
    expect(pose.x).toBeLessThan(1.95);
    expect(pose.x).toBeGreaterThan(1.4);
  });

  it('never lets a native ledge slide push the capsule through an authored wall', () => {
    const world = withSupports([column('rock', 'top', 0, -1, 1, 1, 2, 0)]);
    world.colliders = [{ id: 'wall', kind: 'box', from: { x: 1.65, y: 2.5, z: 0 }, halfExtents: { x: .1, y: 2.5, z: 2 }, blocksMovement: true, blocksCamera: true }];
    const out: FallStep = { x: 0, y: 0, z: 0, landed: false };
    let pose = { x: 1.1, y: 2, z: 0 };
    for (let tick = 0; tick < 12; tick++) {
      stepFall(world, pose, -.05, RADIUS, HEIGHT, out);
      expect(out.x + RADIUS).toBeLessThanOrEqual(1.55 + 1e-9);
      pose = { x: out.x, y: out.y, z: out.z };
    }
  });

  it('never rests under a low slab and never teleports through an overhead deck', () => {
    const slab = column('slab', 'deck', -2, -1, 2, 1, 0.9, 0.8);
    expect(restingHeightAt(withSupports([slab]), 0, 0, 0.1, -0.1)).toBeCloseTo(0, 6);
    expect(restingHeightAt(withSupports([slab]), 0, 0, 0.1, -0.1, RADIUS, HEIGHT)).toBeNull();
    const deck = column('deck', 'deck', -2, -1, 2, 1, 3, 2.85);
    const world = withSupports([deck]);
    const under = moveAerialCircle(world, { x: -1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, RADIUS, HEIGHT);
    expect(under.x).toBeCloseTo(1, 6);
    expect(under.y).toBe(0);
    expect(moveAerialCircle(world, { x: 0, y: 0, z: 0 }, { x: 0, y: 4, z: 0 }, RADIUS, HEIGHT).y).toBeCloseTo(2.85 - HEIGHT, 6);
    expect(landingHeightAt(world, 0, 0, { fromY: 0, maxRise: 0.95, maxDrop: 3, radius: RADIUS, height: HEIGHT })).toBeCloseTo(0, 6);
  });

  it('lets a measured deck replace its authored bridge floor entirely, but not an underpass at another height', () => {
    const authoredDeck: GroundSurfaceDefinition = { id: 'deck', profile: 'canopy', points: [{ x: -2, y: 3.1, z: -1.6 }, { x: 2, y: 3.1, z: -1.6 }, { x: 2, y: 3.1, z: 1.6 }, { x: -2, y: 3.1, z: 1.6 }], elevation: 3.1, walkable: true, material: 'canopy-bridge-deck', colliderId: 'deck-collider' };
    const deck = column('measured', 'deck', -2, -1, 2, 1, 3, 2.85);
    const world = withSupports([deck], [authoredDeck]);
    expect(groundHeightAt(world, 0, 0, 3.05)).toBeCloseTo(3, 6);
    expect(groundHeightAt(world, 0, 1.4, 3.05)).toBeNull();
    expect(moveCircle(world, { x: 0, y: 3, z: 0 }, { x: 0, y: 0, z: 2 }, 0.32).z).toBeLessThan(1.05);
    const underpass: GroundSurfaceDefinition = { ...authoredDeck, id: 'underpass', points: authoredDeck.points.map(point => ({ ...point, y: 0.2 })), elevation: 0.2, colliderId: 'underpass-collider' };
    expect(groundHeightAt(withSupports([deck], [underpass]), 0, 0, 0.2)).toBeCloseTo(0.2, 6);
  });
});
