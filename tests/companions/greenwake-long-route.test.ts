import assert from 'node:assert/strict';
import test from 'node:test';
import { ACT_I_REGIONS } from '../../src/content/levels/act-i.js';
import { createCombatTrialRegion } from '../../src/game/combat/TrialRegions.js';
import { arenaFromRegion, distance2, groundHeightAt, moveCircle } from '../../src/game/combat/geometry.js';
import type { Vec3 } from '../../src/game/contracts.js';
import { distanceToWalkMesh, greenwakeFootprint } from '../../src/world/GreenwakeBoundary.js';

const region = ACT_I_REGIONS.find((entry) => entry.id === 'greenwake')!;
const arena = arenaFromRegion(region);
const radius = 0.42;

function walkTo(from: Vec3, target: Vec3): Vec3 {
  let position = from;
  const maxTicks = Math.ceil(distance2(from, target) / 0.06) + 30;
  for (let tick = 0; tick < maxTicks && distance2(position, target) > 0.02; tick++) {
    const remaining = distance2(position, target);
    const step = Math.min(0.06, remaining);
    position = moveCircle(arena, position, {
      x: (target.x - position.x) / remaining * step,
      y: 0,
      z: (target.z - position.z) / remaining * step,
    }, radius);
    const floor = groundHeightAt(arena, position.x, position.z, position.y);
    assert.notEqual(floor, null, 'every movement step remains supported');
    assert.ok(Math.abs(position.y - floor!) < 1e-6, 'feet remain on the selected surface');
  }
  assert.ok(distance2(position, target) < 0.03, `route blocks before ${JSON.stringify(target)} at ${JSON.stringify(position)}`);
  return position;
}

test('the authored entrance-to-exit route stays walkable through the ramp, gateway and obstacle bypass', () => {
  const ribbon = (id: string) => region.navigation.ribbons.find((entry) => entry.id === id)!.points;
  const extension = ribbon('greenwake-forest-corridor-route');
  const bypass = region.navigation.nodes.find((entry) => entry.id === 'greenwake-forest-corridor-3-bypass')!.position;
  const points = [
    ...ribbon('greenwake-ground-route'),
    ...ribbon('greenwake-raised-route'),
    ...extension.slice(0, 2), bypass, ...extension.slice(2),
  ];
  let position = points[0]!;
  let length = 0;
  for (let index = 1; index < points.length; index++) {
    length += distance2(points[index - 1]!, points[index]!);
    position = walkTo(position, points[index]!);
  }
  assert.ok(length > 100, 'the supported authored journey spans more than 100 metres');
  assert.ok(distance2(position, region.exits.find((exit) => exit.id === 'greenwake-grove-out')!.from) < 0.03);
});

test('route obstacles stop a walking capsule while their side passages remain traversable', () => {
  for (const id of ['greenwake-corridor-low-root', 'greenwake-corridor-cage', 'greenwake-corridor-root-cluster']) {
    const collider = region.ground.colliders.find((entry) => entry.id === id)!;
    const half = collider.halfExtents!;
    const start = { x: collider.from.x, y: 0, z: collider.from.z - half.z - 1.2 };
    const blocked = moveCircle(arena, start, { x: 0, y: 0, z: 3 }, radius);
    assert.ok(blocked.z <= collider.from.z - half.z - radius + 0.01, `${id} prevents walking through its visible footprint`);
    assert.ok(blocked.z > start.z + 0.5, 'the approach itself is walkable');
    const bypassStart = { ...start, x: collider.from.x - half.x - radius - 0.25 };
    walkTo(bypassStart, { ...bypassStart, z: bypassStart.z + 3 });
  }
});

test('the route is sealed: only the authored surfaces are walkable, with no region-wide floor', () => {
  assert.equal(region.ground.surfaces.some((surface) => surface.id === 'greenwake-canopy-floor'), false);
  assert.equal(region.ground.colliders.some((collider) => collider.id === 'greenwake-canopy-floor-collider'), false);
  const area = (points: readonly Vec3[]) => Math.abs(points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length]!;
    return sum + point.x * next.z - next.x * point.z;
  }, 0)) / 2;
  const walkable = region.ground.surfaces.reduce((sum, surface) => sum + area(surface.points), 0);
  const bounds = (region.bounds.max.x - region.bounds.min.x) * (region.bounds.max.z - region.bounds.min.z);
  assert.ok(walkable < bounds * 0.15, `walkable area ${walkable.toFixed(0)} m2 stays a narrow route inside ${bounds.toFixed(0)} m2`);
  // Points that used to be walkable canopy floor beside the route now have no support at all.
  for (const point of [{ x: 18, z: 28 }, { x: 33, z: 40 }, { x: 46, z: 10 }, { x: 60, z: 58 }, { x: 80, z: 20 }, { x: -15, z: 10 }, { x: 30, z: -30 }, { x: 70, z: 50 }]) {
    assert.equal(groundHeightAt(arena, point.x, point.z, 0), null, `(${point.x}, ${point.z}) is off the route`);
    const blocked = moveCircle(arena, { x: point.x, y: 0, z: point.z }, { x: 2, y: 0, z: 0 }, radius);
    assert.deepEqual([blocked.x, blocked.z], [point.x, point.z], 'a capsule cannot walk anywhere from unsupported ground');
  }
});

test('off-route trees and props are visual: none stands on or overhangs the walk-mesh and obstacles keep a 1.2 m side passage', () => {
  // Authored dense dressing stands off the mesh; route furniture (houses, cages, arches, obstacle visuals) is authored on it.
  const dressing = region.props.filter((prop) => prop.id.startsWith('greenwake-edge-tree-') || prop.id.startsWith('greenwake-corridor-edge-tree-'));
  assert.ok(dressing.length >= 60, 'dense native tree dressing remains in the authored region');
  for (const prop of dressing) assert.ok(distanceToWalkMesh(region, prop.position.x, prop.position.z) >= 0.5, `${prop.id} must not stand on the walk-mesh`);
  // The playtest layout also guarantees no canopy, bramble or boulder overhangs the path.
  const playtest = createCombatTrialRegion(region);
  let checked = 0;
  for (const prop of playtest.props) {
    if (prop.assetId === 'prop-erya-edge-tree' && prop.id === 'greenwake-corridor-tree-cluster-visual') continue;
    if (!['prop-erya-edge-tree', 'prop-greenwake-bramble-wall', 'prop-greenwake-boulder-cluster'].includes(prop.assetId)) continue;
    for (const circle of greenwakeFootprint(prop.assetId, prop.position, prop.rotationY, prop.scale)) {
      assert.ok(distanceToWalkMesh(playtest, circle.x, circle.z) >= circle.radius + 0.5, `${prop.id} keeps 0.5 m clear of the walk-mesh`);
    }
    checked++;
  }
  assert.ok(checked > 100, 'the playtest layout keeps dense dressing around the sealed route');
  // Every trail obstacle leaves at least 1.2 m of walkable passage beside it, measured on both axes.
  for (const id of ['greenwake-corridor-low-root', 'greenwake-corridor-cage', 'greenwake-corridor-root-cluster']) {
    const collider = region.ground.colliders.find((entry) => entry.id === id)!;
    const half = collider.halfExtents!;
    for (const axis of ['x', 'z'] as const) {
      let low = Infinity, high = -Infinity;
      for (let offset = -12; offset <= 12; offset += 0.05) {
        const point = axis === 'x' ? { x: collider.from.x + offset, z: collider.from.z } : { x: collider.from.x, z: collider.from.z + offset };
        if (groundHeightAt(arena, point.x, point.z, 0) === null) continue;
        low = Math.min(low, offset); high = Math.max(high, offset);
      }
      const passage = Math.max(-half[axis] - low, high - half[axis]);
      assert.ok(passage >= 1.2, `${id} leaves ${passage.toFixed(2)} m beside it along ${axis}`);
    }
  }
});
