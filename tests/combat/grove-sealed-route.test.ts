import { describe, expect, it } from 'bun:test';
import { REGIONS } from '../../src/content/campaign.js';
import { solidPropKind } from '../../src/content/solid-props.js';
import { CombatEngine, type CombatInput } from '../../src/game/combat/CombatEngine.js';
import { GROVE_COMBAT_TRIALS } from '../../src/game/combat/GroveContent.js';
import { createGroveTrialRegion, GROVE_SURFACE_PREFIX } from '../../src/game/combat/GroveTrialRegion.js';
import { createCombatTrialRegion } from '../../src/game/combat/TrialRegions.js';
import { arenaFromRegion, groundHeightAt, moveCircle, vec, type CombatArena } from '../../src/game/combat/geometry.js';
import type { RegionColliderDefinition, RegionDefinition, Vec3 } from '../../src/game/contracts.js';

const authored = REGIONS.find(region => region.id === 'the-grove')!;
const region: RegionDefinition = createCombatTrialRegion(authored);
const baseArena = arenaFromRegion(region);
const exit = region.exits.find(route => route.id === 'grove-trial-exit')!.from;
const start = region.navigation.nodes[0]!.position;
const [practice, hollow, pool] = GROVE_COMBAT_TRIALS;
const gates = GROVE_COMBAT_TRIALS.map(trial => trial.gate);
const [gate1, gate2, gate3] = gates as [RegionColliderDefinition, RegionColliderDefinition, RegionColliderDefinition];

/** Gates one and two span the 6 m spurs (the route runs along z); the third spans the Ridge Trail (the route runs along x). */
const acrossX = (gate: RegionColliderDefinition): boolean => gate.halfExtents!.x > gate.halfExtents!.z;
/** Signed distance of a ground point past the gate along its route: positive on the side of the next stage. */
const beyond = (gate: RegionColliderDefinition, x: number, z: number): number => (acrossX(gate) ? gate.from.z - z : x - gate.from.x);
const slabHalf = (gate: RegionColliderDefinition): number => (acrossX(gate) ? gate.halfExtents!.z : gate.halfExtents!.x);
const laneHalf = (gate: RegionColliderDefinition): number => (acrossX(gate) ? gate.halfExtents!.x : gate.halfExtents!.z);
const lane = (gate: RegionColliderDefinition, x: number, z: number): number => (acrossX(gate) ? x - gate.from.x : z - gate.from.z);
/** The point `along` metres past the gate (negative: before it) and `across` metres to the side of its centre line. */
const pointAt = (gate: RegionColliderDefinition, along: number, across: number): Vec3 => (acrossX(gate) ? vec(gate.from.x + across, 0, gate.from.z - along) : vec(gate.from.x + along, 0, gate.from.z + across));
const heading = (gate: RegionColliderDefinition): Vec3 => (acrossX(gate) ? vec(0, 0, -1) : vec(1, 0, 0));

const CELL = 0.5;
const NEIGHBOURS: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const IDLE: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
const GX0 = Math.floor(region.bounds.min.x / CELL), GZ0 = Math.floor(region.bounds.min.z / CELL);
const NX = Math.ceil((region.bounds.max.x - region.bounds.min.x) / CELL) + 2, NZ = Math.ceil((region.bounds.max.z - region.bounds.min.z) / CELL) + 2;
const cellIndex = (x: number, z: number) => (Math.round(z / CELL) - GZ0) * NX + (Math.round(x / CELL) - GX0);
const cellX = (index: number) => ((index % NX) + GX0) * CELL;
const cellZ = (index: number) => (Math.floor(index / NX) + GZ0) * CELL;

const probe = new CombatEngine();
probe.loadRegion({ regionId: 'the-grove', regionDefinition: region, runId: 'grove-probe', presentActorIds: [], playerPosition: start });
const body = probe.snapshotState().actors.find(actor => actor.id === 'aren')!;
const RADIUS = body.radius, HEIGHT = body.collisionHeight;

interface Reach { readonly cells: Uint8Array; readonly parent: Int32Array; readonly y: Float32Array; count: number }

/** Flood fill over a 0.5 m grid; each edge is one real moveCircle call with the engine's player capsule. */
function flood(arena: CombatArena, seed: Vec3): Reach {
  const reach: Reach = { cells: new Uint8Array(NX * NZ), parent: new Int32Array(NX * NZ).fill(-1), y: new Float32Array(NX * NZ), count: 0 };
  const first = cellIndex(seed.x, seed.z);
  reach.cells[first] = 1; reach.y[first] = seed.y; reach.count = 1;
  const queue = [first];
  for (let head = 0; head < queue.length; head++) {
    const index = queue[head]!, x = cellX(index), z = cellZ(index), y = reach.y[index]!;
    for (const [dx, dz] of NEIGHBOURS) {
      const next = cellIndex(x + dx * CELL, z + dz * CELL);
      if (reach.cells[next]) continue;
      const moved = moveCircle(arena, { x, y, z }, { x: dx * CELL, y: 0, z: dz * CELL }, RADIUS, HEIGHT);
      if (Math.hypot(moved.x - (x + dx * CELL), moved.z - (z + dz * CELL)) > 0.02) continue;
      reach.cells[next] = 1; reach.y[next] = moved.y; reach.parent[next] = index; reach.count++; queue.push(next);
    }
  }
  return reach;
}
const arenaWith = (closed: readonly RegionColliderDefinition[]): CombatArena => ({ ...baseArena, colliders: [...baseArena.colliders, ...closed] });
const contains = (reach: Reach, x: number, z: number) => reach.cells[cellIndex(x, z)] === 1;
const cellsOf = (reach: Reach): number[] => { const list: number[] = []; reach.cells.forEach((flag, index) => { if (flag) list.push(index); }); return list; };
const boxDistance = (box: RegionColliderDefinition, x: number, z: number) => {
  const half = box.halfExtents!;
  return Math.hypot(Math.max(Math.abs(x - box.from.x) - half.x, 0), Math.max(Math.abs(z - box.from.z) - half.z, 0));
};

/** Reachable ground with every gate closed, with only the first opened, with the first two opened, and with all open. */
const sealed = flood(arenaWith(gates), start);
const afterOne = flood(arenaWith([gate2, gate3]), start);
const afterTwo = flood(arenaWith([gate3]), start);
const open = flood(baseArena, start);
const stages = [sealed, afterOne, afterTwo, open] as const;

describe('The Grove trial region', () => {
  it('is built by the shared dispatcher and leaves the canonical region untouched', () => {
    const before = JSON.stringify(authored);
    expect(JSON.stringify(createGroveTrialRegion(authored))).toBe(JSON.stringify(region));
    expect(JSON.stringify(authored)).toBe(before);
    expect(region.id).toBe('the-grove');
    expect(region.environmentRecipeId).toBe('the-grove-environment');
  });

  it('lays out twelve flat walk surfaces with grove-trial- ids, floors, materials and flush support slabs', () => {
    const earth = 'grove-trail-earth';
    const expected: Record<string, string> = {
      'grove-trial-trailhead': earth, 'grove-trial-glade': earth, 'grove-trial-camp': earth, 'grove-trial-lookout-pad': earth,
      'grove-trial-ring-path': earth, 'grove-trial-practice-ring': earth, 'grove-trial-pool-spur': earth,
      'grove-trial-blight-hollow': earth, 'grove-trial-pool-approach': earth, 'grove-trial-memory-pool': 'grove-pool-stone',
      'grove-trial-ridge-trail': earth, 'grove-trial-ridge-landing': earth,
    };
    expect(region.ground.surfaces.map(surface => surface.id).sort()).toEqual(Object.keys(expected).sort());
    for (const surface of region.ground.surfaces) {
      expect(surface.id.startsWith(GROVE_SURFACE_PREFIX)).toBe(true);
      expect(surface.walkable).toBe(true);
      expect(surface.material).toBe(expected[surface.id]!);
      expect(surface.points.every(point => point.y === 0)).toBe(true);
      const collider = region.ground.colliders.find(candidate => candidate.id === surface.colliderId)!;
      expect(collider.walkSurfaceId).toBe(surface.id);
      expect(collider.kind).toBe('box');
      expect(collider.blocksMovement).toBe(true);
      expect(collider.from.y + collider.halfExtents!.y).toBeCloseTo(surface.elevation, 9);
    }
    const sides = (id: string) => region.ground.surfaces.find(surface => surface.id === id)!.points.length;
    expect([sides('grove-trial-practice-ring'), sides('grove-trial-blight-hollow'), sides('grove-trial-memory-pool')]).toEqual([16, 16, 20]);
    // The walk-mesh exceeds the authored bounds, so the variant overrides them and contains every walkable point.
    for (const surface of region.ground.surfaces) for (const point of surface.points) {
      expect(point.x).toBeGreaterThan(region.bounds.min.x + 1); expect(point.x).toBeLessThan(region.bounds.max.x - 1);
      expect(point.z).toBeGreaterThan(region.bounds.min.z + 1); expect(point.z).toBeLessThan(region.bounds.max.z - 1);
    }
  });

  it('puts the spawn at the south trailhead and the navigation, exit and cameras on walkable floor', () => {
    expect(start).toEqual({ x: 10, y: 0, z: 44 });
    expect(start.z).toBeGreaterThan(Math.max(...region.ground.surfaces.flatMap(surface => surface.points.map(point => point.z))) - 6);
    const nodes = region.navigation.nodes, ids = new Set(nodes.map(node => node.id));
    expect(ids.size).toBe(nodes.length);
    for (const node of nodes) {
      expect(groundHeightAt(baseArena, node.position.x, node.position.z, node.position.y)).toBeCloseTo(node.position.y, 6);
      for (const link of node.links) expect(ids.has(link)).toBe(true);
    }
    for (const ribbon of region.navigation.ribbons) for (let index = 0; index < ribbon.points.length; index++) {
      const point = ribbon.points[index]!;
      expect(groundHeightAt(baseArena, point.x, point.z, point.y)).toBeCloseTo(point.y, 6);
      if (index === 0) continue;
      const previous = ribbon.points[index - 1]!;
      for (let step = 0; step <= 20; step++) expect(groundHeightAt(baseArena, previous.x + (point.x - previous.x) * step / 20, previous.z + (point.z - previous.z) * step / 20, 0)).toBe(0);
    }
    expect(exit).toEqual({ x: 26, y: 0, z: -96 });
    // The 2.2 m goal ring lies completely on the exit landing, behind the last gate.
    for (let step = 0; step < 36; step++) {
      const angle = step / 36 * Math.PI * 2;
      expect(groundHeightAt(baseArena, exit.x + Math.cos(angle) * 2.2, exit.z + Math.sin(angle) * 2.2, 0)).toBe(0);
    }
    const route = region.exits[0]!;
    expect(region.exits).toHaveLength(1);
    expect(route).toMatchObject({ id: 'grove-trial-exit', destinationRegionId: 'moonpine-ridge', colliderIds: [] });
    expect(route.unlockFact).toBeUndefined();
    expect(route.anchors[0]).toEqual(exit);
    expect(region.entrances).toEqual([]);
    expect(region.traversalArcs).toEqual([]);
    expect(region.cameraAnchors.length).toBeGreaterThanOrEqual(8);
    for (const anchor of region.cameraAnchors) {
      expect(anchor.position.x - anchor.lookAt.x).toBe(10); expect(anchor.position.y - anchor.lookAt.y).toBe(12); expect(anchor.position.z - anchor.lookAt.z).toBe(14);
      expect(groundHeightAt(baseArena, anchor.lookAt.x, anchor.lookAt.z, 0)).toBe(0);
    }
    // One encounter rail per stage, framing its arena.
    for (const id of ['grove-trial-practice-rail', 'grove-trial-hollow-rail', 'grove-trial-pool-rail']) expect(region.cameraAnchors.find(anchor => anchor.id === id)!.mode).toBe('encounter');
  });

  it('places Vara like the canopy, Koro as an idle noncombat ally, and the three defenders; no unrelated canonical entities', () => {
    expect(region.entities.map(entity => [entity.id, entity.actorId, entity.assetId, entity.placement])).toEqual([
      ['grove-vara', 'vara', 'actor-vara', 'canopy'],
      ['grove-koro', 'grove-koro', 'actor-koro', 'ground'],
      ['grove-sprig', 'grove-sprig', 'actor-grove-rootling', 'ground'],
      ['grove-blighted', 'grove-blighted', 'actor-grove-blighted-rootling', 'ground'],
      ['grove-hollowheart', 'grove-hollowheart', 'actor-grove-hollowheart', 'ground'],
    ]);
    expect(region.entities.every(entity => entity.kind === 'actor')).toBe(true);
    for (const trial of GROVE_COMBAT_TRIALS) expect(region.entities.find(entity => entity.id === trial.monsterId)!.position).toEqual(trial.monsterPosition);
    expect(Math.hypot(region.entities[0]!.position.x - start.x, region.entities[0]!.position.z - start.z)).toBeLessThan(4);
    // Koro idles below the monkey lookouts, beside the east pad's trail.
    const koro = region.entities[1]!.position;
    for (const lookout of region.props.filter(prop => prop.assetId === 'prop-grove-platform')) expect(Math.hypot(lookout.position.x - koro.x, lookout.position.z - koro.z)).toBeLessThan(10);
    expect(region.encounterIds).toEqual(['grove-defence']);
    expect(region.encounterParticipants['grove-defence']).toEqual(['grove-sprig', 'grove-blighted', 'grove-hollowheart']);
    expect(new Set(region.assetIds)).toEqual(new Set([
      'actor-vara', 'actor-koro', 'actor-grove-rootling', 'actor-grove-blighted-rootling', 'actor-grove-hollowheart',
      'prop-heartroot-trunk', 'prop-refuge-shelter', 'prop-grove-platform', 'prop-training-post', 'prop-water-basin',
      'prop-ancient-canopy-shrine', 'prop-canopy-cliff-rock', 'prop-mire-bank-rock', 'prop-root-cavern-mouth',
      'prop-erya-edge-tree', 'prop-greenwake-boulder-cluster', 'prop-canopy-fern-cluster',
    ]));
  });

  it('stands the Heartroot, tent, lookouts, posts, the spring basin and the Memory Pool\'s ruin as authored, with solid kinds and nothing walkable at deck height', () => {
    expect(new Set(region.props.map(prop => prop.id)).size).toBe(region.props.length);
    const byId = (id: string) => region.props.find(prop => prop.id === id)!;
    expect(byId('grove-trial-heartroot')).toMatchObject({ assetId: 'prop-heartroot-trunk', position: { x: -2, y: 0, z: -13 }, placement: 'ground' });
    expect(byId('grove-trial-tent')).toMatchObject({ assetId: 'prop-refuge-shelter', position: { x: -29, y: 0, z: 7 } });
    expect(byId('grove-trial-practice-basin')).toMatchObject({ assetId: 'prop-water-basin', position: { x: -30, y: 0, z: -23 } });
    expect(byId('grove-trial-pool-ruin')).toMatchObject({ assetId: 'prop-ancient-canopy-shrine', position: { x: -52, y: 0, z: -96 } });
    expect(byId('grove-trial-pool-cavern')).toMatchObject({ assetId: 'prop-root-cavern-mouth', position: { x: -24, y: 0, z: -129 } });
    expect(solidPropKind(byId('grove-trial-heartroot'))).toBe('trunk');
    expect(solidPropKind(byId('grove-trial-tent'))).toBe('solid');
    expect(solidPropKind(byId('grove-trial-practice-basin'))).toBe('solid');
    const posts = region.props.filter(prop => prop.id.startsWith('grove-trial-post-'));
    expect(posts).toHaveLength(4);
    for (const post of posts) {
      expect(solidPropKind(post)).toBe('trunk');
      // The practice posts frame the ring's rim: outside the arena, inside the walkable clearing.
      expect(Math.hypot(post.position.x - practice!.arena.center.x, post.position.z - practice!.arena.center.z)).toBeGreaterThan(practice!.arena.radius + 1);
      expect(groundHeightAt(baseArena, post.position.x, post.position.z, 0)).toBe(0);
    }
    // Six warding posts round the hollow and the Memory Pool arena stay outside both fights.
    const wards = region.props.filter(prop => prop.id.startsWith('grove-trial-ward-'));
    expect(wards).toHaveLength(6);
    for (const ward of wards) {
      expect(solidPropKind(ward)).toBe('trunk');
      for (const trial of [hollow!, pool!]) expect(Math.hypot(ward.position.x - trial.arena.center.x, ward.position.z - trial.arena.center.z)).toBeGreaterThan(trial.arena.radius + 1);
    }
    const lookouts = region.props.filter(prop => prop.assetId === 'prop-grove-platform');
    expect(lookouts).toHaveLength(2);
    for (const lookout of lookouts) {
      expect(solidPropKind(lookout)).toBe('platform');
      // Not walkable: every surface is the y = 0 ground, so nothing is supported at the deck's height.
      expect(region.ground.surfaces.every(surface => surface.elevation === 0 && surface.points.every(point => point.y === 0))).toBe(true);
    }
    expect(lookouts[0]!.position.x).toBeGreaterThan(posts[1]!.position.x + 40);
  });

  it('chains the three stages north-west: each arena lies inside its clearing on the near side of its gate, the exit behind the last gate', () => {
    expect(gates.map(gate => gate.id)).toEqual(['trial-gate:evasion-practice', 'trial-gate:sap-incursion', 'trial-gate:memory-pool']);
    expect(gate1.from).toMatchObject({ x: -24, z: -38 });
    expect(gate2.from).toMatchObject({ x: -24, z: -72 });
    expect(gate3.from).toMatchObject({ x: -1, z: -96 });
    expect(gates.map(acrossX)).toEqual([true, true, false]);
    expect(gates.every(gate => gate.halfExtents![acrossX(gate) ? 'x' : 'z'] === 4.5)).toBe(true);
    for (const [index, trial] of GROVE_COMBAT_TRIALS.entries()) {
      const gate = gates[index]!;
      // The monster stands 4 m or more from its own gate and every point of its arena lies on the near side.
      expect(boxDistance(gate, trial.monsterPosition.x, trial.monsterPosition.z)).toBeGreaterThanOrEqual(4);
      for (let step = 0; step < 72; step++) {
        const angle = step / 72 * Math.PI * 2;
        for (const ring of [trial.arena.radius, trial.arena.radius / 2]) {
          const x = trial.arena.center.x + Math.cos(angle) * ring, z = trial.arena.center.z + Math.sin(angle) * ring;
          expect(groundHeightAt(baseArena, x, z, 0), `${trial.id} arena point ${step}`).toBe(0);
          expect(beyond(gate, x, z), `${trial.id} arena point ${step}`).toBeLessThan(-slabHalf(gate));
        }
      }
    }
    // The arenas run north in order; the exit lies past the last gate; spawn and exit are beyond every monster's 16 m disengage range.
    expect(practice!.arena.center.z).toBeGreaterThan(hollow!.arena.center.z);
    expect(hollow!.arena.center.z).toBeGreaterThan(pool!.arena.center.z);
    expect(beyond(gate3, exit.x, exit.z)).toBeGreaterThan(slabHalf(gate3) + 10);
    for (const trial of GROVE_COMBAT_TRIALS) for (const point of [start, exit]) expect(Math.hypot(point.x - trial.monsterPosition.x, point.z - trial.monsterPosition.z)).toBeGreaterThan(30);
  });
});

describe('The Grove gates seal the route one stage at a time', () => {
  it('shapes every gate as a tall, thick box over its route cross-section with at least 1 m of void to each end', () => {
    for (const gate of gates) {
      const half = gate.halfExtents!;
      expect(gate.blocksMovement).toBe(true);
      expect(gate.from.y + half.y).toBeGreaterThanOrEqual(4);
      expect(gate.from.y - half.y).toBeLessThanOrEqual(0);
      let low = Infinity, high = -Infinity;
      for (const cell of cellsOf(open)) {
        const x = cellX(cell), z = cellZ(cell);
        if (Math.abs(beyond(gate, x, z)) > slabHalf(gate) + 0.3 || Math.abs(lane(gate, x, z)) > laneHalf(gate) + 3.4) continue;
        low = Math.min(low, lane(gate, x, z)); high = Math.max(high, lane(gate, x, z));
      }
      expect(-laneHalf(gate)).toBeLessThanOrEqual(low - 1 + 1e-9);
      expect(laneHalf(gate)).toBeGreaterThanOrEqual(high + 1 - 1e-9);
      expect(high - low).toBeLessThan(8);
    }
  });

  it('flood fill: each opened gate adds exactly the next stage and nothing else; the exit is reachable only when all three are open', () => {
    const at = (reach: Reach, point: Vec3) => contains(reach, point.x, point.z);
    const spots = [practice!.arena.center, hollow!.arena.center, pool!.arena.center, exit] as const;
    // Rows: stages sealed, after gate 1, after gate 2, open. Columns: practice arena, hollow, Memory Pool arena, exit.
    expect(stages.map(reach => spots.map(spot => at(reach, spot)))).toEqual([
      [true, false, false, false], [true, true, false, false], [true, true, true, false], [true, true, true, true],
    ]);
    for (const reach of stages) expect(at(reach, start)).toBe(true);
    expect(at(sealed, practice!.monsterPosition)).toBe(true);
    expect(at(afterOne, hollow!.monsterPosition)).toBe(true);
    expect(at(afterTwo, pool!.monsterPosition)).toBe(true);
    expect(open.count).toBeGreaterThan(8000);
    // Opening a gate only ever adds cells, and every cell added lies beyond that gate (within one capsule of its near face).
    for (let index = 0; index < gates.length; index++) {
      const gate = gates[index]!, before = stages[index]!, after = stages[index + 1]!;
      let added = 0;
      for (const cell of cellsOf(after)) {
        if (before.cells[cell] === 1) continue;
        added++;
        expect(beyond(gate, cellX(cell), cellZ(cell))).toBeGreaterThan(-(slabHalf(gate) + RADIUS + CELL));
      }
      expect(added, `gate ${index + 1} opens a stage`).toBeGreaterThan(300);
      for (const cell of cellsOf(before)) expect(after.cells[cell]).toBe(1);
      // No stranded cells: everything on the near side of the gate stays connected to the spawn.
      let stranded = 0;
      for (const cell of cellsOf(after)) if (!before.cells[cell] && beyond(gate, cellX(cell), cellZ(cell)) <= -(slabHalf(gate) + RADIUS + CELL)) stranded++;
      expect(stranded).toBe(0);
    }
  });

  it('the one way from spawn to exit runs through the ring, the gate-1 spur, the hollow, the gate-2 spur, the Memory Pool arena and the Ridge Trail, in that order', () => {
    const path: number[] = [];
    for (let cell = cellIndex(exit.x, exit.z); cell >= 0; cell = open.parent[cell]!) path.push(cell);
    path.reverse();
    expect(path.length).toBeGreaterThan(300);
    const firstWithin = (x: number, z: number, radius: number) => path.findIndex(cell => Math.hypot(cellX(cell) - x, cellZ(cell) - z) <= radius);
    // The walk crosses each arena (it passes inside its radius) and each gate (inside the 6 m spur or trail).
    const marks = [
      firstWithin(practice!.arena.center.x, practice!.arena.center.z, practice!.arena.radius), firstWithin(gate1.from.x, gate1.from.z, 3.5), firstWithin(hollow!.arena.center.x, hollow!.arena.center.z, hollow!.arena.radius),
      firstWithin(gate2.from.x, gate2.from.z, 3.5), firstWithin(pool!.arena.center.x, pool!.arena.center.z, pool!.arena.radius + 2.5), firstWithin(gate3.from.x, gate3.from.z, 3.5),
    ];
    expect(marks.every(mark => mark >= 0), `path marks ${marks.join(', ')}`).toBe(true);
    expect([...marks].sort((a, b) => a - b)).toEqual(marks);
    expect(new Set(marks).size).toBe(marks.length);
    // Before the first stage the walk stays outside the practice arena.
    for (const cell of path.slice(0, marks[0]!)) expect(Math.hypot(cellX(cell) - practice!.arena.center.x, cellZ(cell) - practice!.arena.center.z)).toBeGreaterThan(practice!.arena.radius);
  });

  it('cannot be hopped around: no jump-reach pair joins the two sides of any gate outside its closed box', () => {
    // Jump flights are at most 2.8 m (apex 0.8 m) and must land on supported floor within 0.45 m of the take-off height.
    const reach = 2.8 + 0.5;
    for (const [index, gate] of gates.entries()) {
      const closedGate = flood(arenaWith(gates.slice(index)), start);
      const farSeed = pointAt(gate, slabHalf(gate) + RADIUS + 1, 0);
      const farSide = flood(arenaWith([gate]), farSeed);
      expect(contains(farSide, farSeed.x, farSeed.z)).toBe(true);
      expect(contains(farSide, start.x, start.z)).toBe(false);
      const near = (set: Reach) => cellsOf(set).filter(cell => boxDistance(gate, cellX(cell), cellZ(cell)) <= reach + 0.5);
      const nearBefore = near(closedGate), nearAfter = near(farSide);
      expect(nearBefore.length).toBeGreaterThan(20);
      expect(nearAfter.length).toBeGreaterThan(20);
      for (const a of nearBefore) for (const b of nearAfter) {
        const ax = cellX(a), az = cellZ(a), bx = cellX(b), bz = cellZ(b);
        if (Math.hypot(ax - bx, az - bz) > reach) continue;
        // Any such pair must be separated by the grown box: the segment crosses the slab of the gate between its grown ends.
        const low = -slabHalf(gate) - RADIUS, high = slabHalf(gate) + RADIUS;
        expect(Math.min(beyond(gate, ax, az), beyond(gate, bx, bz)) <= high && Math.max(beyond(gate, ax, az), beyond(gate, bx, bz)) >= low).toBe(true);
        expect(Math.abs(lane(gate, ax, az)) <= laneHalf(gate) + RADIUS && Math.abs(lane(gate, bx, bz)) <= laneHalf(gate) + RADIUS).toBe(true);
      }
    }
  }, 120000);
});

/** Loads the region exactly as the asset playtest does, then hides every monster so only movement is under test. */
function playtestSeed() {
  const engine = new CombatEngine();
  engine.loadRegion({ regionId: 'the-grove', regionDefinition: region, runId: 'grove-sealed', presentActorIds: region.entities.map(entity => entity.id), playerPosition: start });
  engine.startEncounter({ encounterId: 'grove-defence', regionId: 'the-grove', runId: 'grove-sealed' });
  engine.enableCombatTrials();
  const seed = engine.snapshotState();
  for (const actor of seed.actors) if (actor.id !== seed.playerId) actor.visible = false;
  seed.player.mana = seed.player.maxMana = 1e9;
  // Identity basis: input.move is a world-space heading, so 16 headings cover every camera orientation.
  seed.arena.cameraBasis = { forward: vec(0, 0, 1), right: vec(1, 0, 0) };
  return seed;
}
const seedTemplate = playtestSeed();
const DIRECTIONS = Array.from({ length: 16 }, (_, step) => vec(Math.cos(step / 16 * Math.PI * 2), 0, Math.sin(step / 16 * Math.PI * 2)));
const base = (direction: Vec3): CombatInput => ({ ...IDLE, move: direction, sprintHeld: true });
const SCRIPTS: readonly { readonly ticks: number; readonly input: (tick: number, direction: Vec3, diveReady: boolean) => CombatInput }[] = [
  { ticks: 70, input: (_, direction) => base(direction) },
  { ticks: 140, input: (_, direction, diveReady) => ({ ...base(direction), dodgePressed: diveReady }) },
  { ticks: 140, input: (_, direction) => ({ ...base(direction), jumpPressed: true }) },
  { ticks: 140, input: (tick, direction) => ({ ...base(direction), dodgePressed: tick % 36 === 0, jumpPressed: tick % 36 === 20 }) },
];

describe('The Grove closed gates hold against the real CombatEngine', () => {
  for (const [index, gate] of gates.entries()) {
    it(`never lets Run, Dive chains or Jump chains past gate ${index + 1}, from the box faces and ends, in 16 directions`, () => {
      // Start positions hugging the closed gate on the near side: along its face (the first gate takes all seven) and both ends.
      const half = slabHalf(gate), starts: Vec3[] = [];
      for (const across of index === 0 ? [-2.5, -1.5, -0.5, 0, 0.5, 1.5, 2.5] : [-2.5, 0, 2.5]) starts.push(pointAt(gate, -(half + RADIUS + 0.6), across));
      for (const along of [1, 3]) starts.push(pointAt(gate, -(half + along), -2.5), pointAt(gate, -(half + along), 2.5));
      const closedReach = flood(arenaWith(gates.slice(index)), start);
      let runs = 0;
      for (const point of starts) {
        expect(contains(closedReach, point.x, point.z)).toBe(true);
        for (const direction of DIRECTIONS) for (const script of SCRIPTS) {
          const seed = structuredClone(seedTemplate), player = seed.actors.find(actor => actor.id === seed.playerId)!;
          player.position = vec(point.x, 0, point.z);
          // The stages before this one are cleared: only this gate and the ones behind it stand.
          seed.combatTrial!.index = index;
          const engine = new CombatEngine(seed);
          let diveReady = true;
          for (let tick = 0; tick < script.ticks; tick++) {
            engine.fixedStep(script.input(tick, direction, diveReady));
            engine.consumeEvents(); engine.drainPresentationCues();
            const snapshot = engine.snapshot();
            diveReady = snapshot.skills.find(skill => skill.id === 'dive')!.available;
            const position = snapshot.actors.find(actor => actor.id === 'aren')!.position;
            if (beyond(gate, position.x, position.z) > 0) throw new Error(`gate ${index + 1} breached from (${point.x}, ${point.z}) heading (${direction.x.toFixed(2)}, ${direction.z.toFixed(2)}) at (${position.x.toFixed(2)}, ${position.z.toFixed(2)})`);
          }
          runs++;
        }
      }
      expect(runs).toBeGreaterThan(index === 0 ? 500 : 300);
    }, 300000);

    it(`opened gate ${index + 1} is passable by the same inputs (the test can detect a breach)`, () => {
      const seed = structuredClone(seedTemplate), player = seed.actors.find(actor => actor.id === seed.playerId)!, near = pointAt(gate, -(slabHalf(gate) + RADIUS + 0.4), 0);
      player.position = vec(near.x, 0, near.z);
      seed.combatTrial!.index = index + 1;
      const engine = new CombatEngine(seed);
      for (let tick = 0; tick < 70; tick++) { engine.fixedStep({ ...IDLE, move: heading(gate), sprintHeld: true }); engine.consumeEvents(); engine.drainPresentationCues(); }
      const position = engine.snapshot().actors.find(actor => actor.id === 'aren')!.position;
      expect(beyond(gate, position.x, position.z)).toBeGreaterThan(2);
    });
  }
});

describe('The Grove in the engine', () => {
  it('loads the variant, starts grove-defence with the three defenders on their spawns and leaves Koro and Vara out of the encounter', () => {
    const engine = new CombatEngine();
    engine.loadRegion({ regionId: 'the-grove', regionDefinition: region, runId: 'grove-load', presentActorIds: region.entities.map(entity => entity.id) });
    engine.startEncounter({ encounterId: 'grove-defence', regionId: 'the-grove', runId: 'grove-load' });
    engine.enableCombatTrials();
    const snapshot = engine.snapshot();
    expect(snapshot.actors.find(actor => actor.id === 'aren')!.position).toEqual({ x: 10, y: 0, z: 44 });
    for (const trial of GROVE_COMBAT_TRIALS) {
      const monster = snapshot.actors.find(actor => actor.id === trial.monsterId)!;
      expect(monster.position).toEqual(trial.monsterPosition);
      expect(monster.allegiance).toBe('hostile');
      expect(monster.renderVariantId).toBe(trial.monsterAssetId);
    }
    expect(snapshot.actors.find(actor => actor.id === 'grove-koro')).toMatchObject({ allegiance: 'ally', archetypeId: 'grove-koro', position: { x: 28.5, y: 0, z: 5 } });
    expect(snapshot.actors.find(actor => actor.id === 'grove-vara')!.allegiance).toBe('ally');
    expect(snapshot.trialGates!.map(entry => [entry.id, entry.open])).toEqual([['evasion-practice', false], ['sap-incursion', false], ['memory-pool', false]]);
  });

  it('Koro is never a party companion: no region instance carries the koro archetype, so a Koro slot cannot resolve to him', () => {
    expect(region.entities.some(entity => entity.actorId === 'koro')).toBe(false);
    const engine = new CombatEngine();
    expect(() => engine.loadRegion({regionId: 'the-grove', regionDefinition: region, runId: 'grove-koro-slot', presentActorIds: region.entities.map(entity => entity.id), companionId: 'koro'})).toThrow('must resolve to one explicitly present region instance');
    const scout = new CombatEngine();
    scout.loadRegion({regionId: 'the-grove', regionDefinition: region, runId: 'grove-vara-slot', presentActorIds: region.entities.map(entity => entity.id), companionId: 'vara'});
    expect(scout.snapshot().actors.find(actor => actor.id === 'grove-vara')).toBeDefined();
  });

  it('Koro stays idle, in place and untouched for the whole practice: never attacked, never hostile, never targeted', () => {
    const engine = new CombatEngine();
    engine.loadRegion({regionId: 'the-grove', regionDefinition: region, runId: 'grove-koro-idle', presentActorIds: region.entities.map(entity => entity.id), companionId: 'vara'});
    engine.startEncounter({encounterId: 'grove-defence', regionId: 'the-grove', runId: 'grove-koro-idle', companionId: 'vara'});
    engine.enableCombatTrials();
    const seed = engine.snapshotState();
    seed.player.vitality = seed.player.maxVitality = 1e6;
    seed.arena.cameraBasis = { forward: vec(0, 0, 1), right: vec(1, 0, 0) };
    seed.actors.find(actor => actor.id === 'aren')!.position = vec(-24, 0, -19);
    const running = new CombatEngine(seed);
    const koroBefore = running.snapshot().actors.find(actor => actor.id === 'grove-koro')!.position;
    let sprigCasts = 0, koroEvents = 0, otherCasts = 0;
    for (let tick = 0; tick < 1500; tick++) {
      running.fixedStep(IDLE);
      for (const event of running.consumeEvents()) {
        if (event.actorId === 'grove-sprig' && event.kind === 'cue' && event.attackId) sprigCasts++;
        if ((event.actorId === 'grove-blighted' || event.actorId === 'grove-hollowheart') && event.kind === 'cue' && event.attackId) otherCasts++;
        if (event.actorId === 'grove-koro' || event.targetId === 'grove-koro' || event.damage?.targetId === 'grove-koro') koroEvents++;
      }
      running.drainPresentationCues();
    }
    const koro = running.snapshot().actors.find(actor => actor.id === 'grove-koro')!;
    expect(sprigCasts).toBeGreaterThanOrEqual(3);
    expect(otherCasts, 'only the current stage fights').toBe(0);
    expect(koroEvents).toBe(0);
    expect(koro).toMatchObject({ allegiance: 'ally', downed: false, position: koroBefore });
    expect(running.snapshotState().hazards.every(hazard => hazard.targetActorId !== 'grove-koro')).toBe(true);
  });
});
