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
const trial = GROVE_COMBAT_TRIALS[0]!;
const gate = trial.gate;

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

const open = flood(baseArena, start);
const closed = flood(arenaWith([gate]), start);

describe('The Grove trial region', () => {
  it('is built by the shared dispatcher and leaves the canonical region untouched', () => {
    const before = JSON.stringify(authored);
    expect(JSON.stringify(createGroveTrialRegion(authored))).toBe(JSON.stringify(region));
    expect(JSON.stringify(authored)).toBe(before);
    expect(region.id).toBe('the-grove');
    expect(region.environmentRecipeId).toBe('the-grove-environment');
    expect(createCombatTrialRegion(REGIONS.find(candidate => candidate.id === 'blood-bamboo-valley')!)).toBe(REGIONS.find(candidate => candidate.id === 'blood-bamboo-valley')!);
  });

  it('lays out nine flat walk surfaces with grove-trial- ids, floors, materials and flush support slabs', () => {
    const expected: Record<string, string> = {
      'grove-trial-trailhead': 'grove-trail-earth', 'grove-trial-glade': 'grove-trail-earth', 'grove-trial-camp': 'grove-trail-earth',
      'grove-trial-lookout-pad': 'grove-trail-earth', 'grove-trial-north-trail': 'grove-trail-earth', 'grove-trial-ring-path': 'grove-trail-earth',
      'grove-trial-practice-ring': 'grove-trail-earth', 'grove-trial-pool-spur': 'grove-trail-earth', 'grove-trial-pool-overlook': 'grove-overlook-stone',
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
    expect(region.ground.surfaces.find(surface => surface.id === 'grove-trial-practice-ring')!.points).toHaveLength(16);
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
    expect(exit).toEqual({ x: 23, y: 0, z: -44 });
    // The 2.2 m goal ring lies completely on the north trail.
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
    expect(region.cameraAnchors.length).toBeGreaterThanOrEqual(4);
    for (const anchor of region.cameraAnchors) {
      expect(anchor.position.x - anchor.lookAt.x).toBe(10); expect(anchor.position.y - anchor.lookAt.y).toBe(12); expect(anchor.position.z - anchor.lookAt.z).toBe(14);
      expect(groundHeightAt(baseArena, anchor.lookAt.x, anchor.lookAt.z, 0)).toBe(0);
    }
  });

  it('places Vara like the canopy, Koro as an idle noncombat ally, and the one practice monster; no unrelated canonical entities', () => {
    expect(region.entities.map(entity => [entity.id, entity.actorId, entity.assetId, entity.placement])).toEqual([
      ['grove-vara', 'vara', 'actor-vara', 'canopy'],
      ['grove-koro', 'grove-koro', 'actor-koro', 'ground'],
      ['grove-sprig', 'grove-sprig', 'actor-grove-rootling', 'ground'],
    ]);
    expect(region.entities.every(entity => entity.kind === 'actor')).toBe(true);
    expect(region.entities.find(entity => entity.id === 'grove-sprig')!.position).toEqual(trial.monsterPosition);
    expect(Math.hypot(region.entities[0]!.position.x - start.x, region.entities[0]!.position.z - start.z)).toBeLessThan(4);
    // Koro idles below the monkey lookouts, beside the east pad's trail.
    const koro = region.entities[1]!.position;
    for (const lookout of region.props.filter(prop => prop.assetId === 'prop-grove-platform')) expect(Math.hypot(lookout.position.x - koro.x, lookout.position.z - koro.z)).toBeLessThan(10);
    expect(region.encounterIds).toEqual(['grove-practice']);
    expect(region.encounterParticipants['grove-practice']).toEqual(['grove-sprig']);
    expect(new Set(region.assetIds)).toEqual(new Set(['actor-vara', 'actor-koro', 'actor-grove-rootling', 'prop-heartroot-trunk', 'prop-refuge-shelter', 'prop-grove-platform', 'prop-training-post', 'prop-water-basin', 'prop-erya-edge-tree', 'prop-greenwake-boulder-cluster', 'prop-canopy-fern-cluster']));
  });

  it('stands the Heartroot, tent, lookouts, posts and the Memory Pool basin as authored, with solid kinds and nothing walkable at deck height', () => {
    expect(new Set(region.props.map(prop => prop.id)).size).toBe(region.props.length);
    const byId = (id: string) => region.props.find(prop => prop.id === id)!;
    expect(byId('grove-trial-heartroot')).toMatchObject({ assetId: 'prop-heartroot-trunk', position: { x: -2, y: 0, z: -13 }, placement: 'ground' });
    expect(byId('grove-trial-tent')).toMatchObject({ assetId: 'prop-refuge-shelter', position: { x: -29, y: 0, z: 7 } });
    expect(byId('grove-trial-memory-basin')).toMatchObject({ assetId: 'prop-water-basin', position: { x: -24, y: 0, z: -51.5 } });
    expect(solidPropKind(byId('grove-trial-heartroot'))).toBe('trunk');
    expect(solidPropKind(byId('grove-trial-tent'))).toBe('solid');
    expect(solidPropKind(byId('grove-trial-memory-basin'))).toBe('solid');
    const posts = region.props.filter(prop => prop.assetId === 'prop-training-post');
    expect(posts).toHaveLength(4);
    for (const post of posts) {
      expect(solidPropKind(post)).toBe('trunk');
      // The practice posts frame the ring's rim: outside the arena, inside the walkable clearing, never closer than 1 m to the spur's mouth.
      const distance = Math.hypot(post.position.x - trial.arena.center.x, post.position.z - trial.arena.center.z);
      expect(distance).toBeGreaterThan(trial.arena.radius + 1);
      expect(groundHeightAt(baseArena, post.position.x, post.position.z, 0)).toBe(0);
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

  it('places the practice ring north-west with the gate on the spur; the trailhead and the exit lie away from it', () => {
    const { arena, monsterPosition } = trial;
    expect(arena.center.x).toBeLessThan(start.x - 25);
    expect(arena.center.z).toBeLessThan(exit.z + 30);
    expect(gate.id).toBe('trial-gate:evasion-practice');
    expect(gate.from).toMatchObject({ x: -24, z: -38 });
    expect(gate.halfExtents!.x).toBe(4.5);
    // The gate is beyond the arena, on the spur, and the monster stands 4 m or more from it.
    expect(boxDistance(gate, monsterPosition.x, monsterPosition.z)).toBeGreaterThanOrEqual(4);
    for (let step = 0; step < 72; step++) {
      const angle = step / 72 * Math.PI * 2;
      for (const ring of [arena.radius, arena.radius / 2]) {
        const x = arena.center.x + Math.cos(angle) * ring, z = arena.center.z + Math.sin(angle) * ring;
        expect(groundHeightAt(baseArena, x, z, 0)).toBe(0);
        expect(z).toBeGreaterThan(gate.from.z + gate.halfExtents!.z);
      }
    }
    // Spawn and exit are farther than the monster's 16 m disengage range from its arena: the practice never fires on the required route.
    for (const point of [start, exit]) expect(Math.hypot(point.x - monsterPosition.x, point.z - monsterPosition.z)).toBeGreaterThan(30);
  });
});

describe('The Grove practice gate seals only the optional spur', () => {
  it('shapes the gate as a tall, thick box over the spur cross-section with at least 1 m of void to each end', () => {
    const half = gate.halfExtents!;
    expect(gate.blocksMovement).toBe(true);
    expect(gate.from.y + half.y).toBeGreaterThanOrEqual(4);
    expect(gate.from.y - half.y).toBeLessThanOrEqual(0);
    let low = Infinity, high = -Infinity;
    for (const cell of cellsOf(open)) {
      const x = cellX(cell), z = cellZ(cell);
      if (Math.abs(z - gate.from.z) > half.z + 0.3 || Math.abs(x - gate.from.x) > half.x + 3.4) continue;
      low = Math.min(low, x); high = Math.max(high, x);
    }
    expect(gate.from.x - half.x).toBeLessThanOrEqual(low - 1 + 1e-9);
    expect(gate.from.x + half.x).toBeGreaterThanOrEqual(high + 1 - 1e-9);
    expect(high - low).toBeLessThan(8);
  });

  it('flood fill: spawn, the exit, the ring and its arena are on the near side; only the spur beyond the gate and the overlook are cut off', () => {
    expect(contains(open, start.x, start.z)).toBe(true);
    expect(contains(open, exit.x, exit.z)).toBe(true);
    expect(open.count).toBeGreaterThan(5000);
    expect(contains(closed, start.x, start.z)).toBe(true);
    expect(contains(closed, exit.x, exit.z)).toBe(true);
    expect(contains(closed, trial.arena.center.x, trial.arena.center.z)).toBe(true);
    expect(contains(closed, trial.monsterPosition.x, trial.monsterPosition.z)).toBe(true);
    const overlook = region.navigation.nodes.find(node => node.id === 'grove-trial-pool-overlook')!.position;
    expect(contains(open, overlook.x, overlook.z)).toBe(true);
    expect(contains(closed, overlook.x, overlook.z)).toBe(false);
    // The far side is exactly the spur beyond the gate plus the overlook pad; opening the gate only ever adds cells.
    let cut = 0;
    for (const cell of cellsOf(open)) {
      if (closed.cells[cell] === 1) continue;
      cut++;
      // The cut set also holds the cells within one capsule of the near face of the closed box.
      expect(cellZ(cell)).toBeLessThan(gate.from.z + gate.halfExtents!.z + RADIUS + CELL);
      expect(cellX(cell)).toBeGreaterThan(-32); expect(cellX(cell)).toBeLessThan(-16);
    }
    expect(cut).toBeGreaterThan(300);
    expect(closed.count + cut - open.count).toBeLessThanOrEqual(0);
    for (const cell of cellsOf(closed)) expect(open.cells[cell]).toBe(1);
    // No stranded cells: everything not cut off is still connected to the spawn, except cells covered by the closed box itself.
    let stranded = 0;
    for (const cell of cellsOf(open)) if (!closed.cells[cell] && cellZ(cell) > gate.from.z + gate.halfExtents!.z + RADIUS + CELL) stranded++;
    expect(stranded).toBe(0);
  });

  it('the shortest spawn-to-exit walk never goes near the practice gate or the practice ring, with the gate open or closed', () => {
    for (const reach of [open, closed]) {
      const path: number[] = [];
      for (let cell = cellIndex(exit.x, exit.z); cell >= 0; cell = reach.parent[cell]!) path.push(cell);
      expect(path.length).toBeGreaterThan(80);
      const length = path.length * CELL;
      expect(length).toBeLessThan(160);
      for (const cell of path) {
        expect(boxDistance(gate, cellX(cell), cellZ(cell))).toBeGreaterThan(30);
        expect(Math.hypot(cellX(cell) - trial.arena.center.x, cellZ(cell) - trial.arena.center.z)).toBeGreaterThan(trial.arena.radius + 16);
        expect(Math.hypot(cellX(cell) - trial.monsterPosition.x, cellZ(cell) - trial.monsterPosition.z)).toBeGreaterThan(16);
      }
    }
  });

  it('cannot be hopped around: no jump-reach pair joins the two sides outside the closed box', () => {
    // Jump flights are at most 2.8 m (apex 0.8 m) and must land on supported floor within 0.45 m of the take-off height.
    const reach = 2.8 + 0.5, after = flood(arenaWith([gate]), vec(gate.from.x, 0, gate.from.z - gate.halfExtents!.z - RADIUS - 1));
    expect(contains(after, -24, -47)).toBe(true);
    expect(contains(after, start.x, start.z)).toBe(false);
    const near = (set: Reach) => cellsOf(set).filter(cell => boxDistance(gate, cellX(cell), cellZ(cell)) <= reach + 0.5);
    const nearBefore = near(closed), nearAfter = near(after);
    expect(nearBefore.length).toBeGreaterThan(20);
    expect(nearAfter.length).toBeGreaterThan(20);
    const half = gate.halfExtents!;
    for (const a of nearBefore) for (const b of nearAfter) {
      const ax = cellX(a), az = cellZ(a), bx = cellX(b), bz = cellZ(b);
      if (Math.hypot(ax - bx, az - bz) > reach) continue;
      // Any such pair must be separated by the grown box: the segment crosses the z-slab of the gate.
      const low = gate.from.z - half.z - RADIUS, high = gate.from.z + half.z + RADIUS;
      expect(Math.min(az, bz) <= high && Math.max(az, bz) >= low).toBe(true);
      expect(Math.abs(ax - gate.from.x) <= half.x + RADIUS && Math.abs(bx - gate.from.x) <= half.x + RADIUS).toBe(true);
    }
  });
});

/** Loads the region exactly as the asset playtest does, then hides every monster so only movement is under test. */
function playtestSeed() {
  const engine = new CombatEngine();
  engine.loadRegion({ regionId: 'the-grove', regionDefinition: region, runId: 'grove-sealed', presentActorIds: region.entities.map(entity => entity.id), playerPosition: start });
  engine.startEncounter({ encounterId: 'grove-practice', regionId: 'the-grove', runId: 'grove-sealed' });
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

describe('The Grove closed practice gate holds against the real CombatEngine', () => {
  it('never lets Run, Dive chains or Jump chains reach the spur beyond the gate, from the box faces and ends, in 16 directions', () => {
    // Start positions hugging the closed gate on the near side: along its face and both ends.
    const half = gate.halfExtents!, starts: Vec3[] = [];
    for (const dx of [-2.5, -1.5, -0.5, 0, 0.5, 1.5, 2.5]) starts.push(vec(gate.from.x + dx, 0, gate.from.z + half.z + RADIUS + 0.6));
    for (const dz of [1, 3]) starts.push(vec(gate.from.x - 2.5, 0, gate.from.z + half.z + dz), vec(gate.from.x + 2.5, 0, gate.from.z + half.z + dz));
    let runs = 0;
    for (const point of starts) {
      expect(contains(closed, point.x, point.z)).toBe(true);
      for (const direction of DIRECTIONS) for (const script of SCRIPTS) {
        const seed = structuredClone(seedTemplate), player = seed.actors.find(actor => actor.id === seed.playerId)!;
        player.position = vec(point.x, 0, point.z);
        const engine = new CombatEngine(seed);
        let diveReady = true;
        for (let tick = 0; tick < script.ticks; tick++) {
          engine.fixedStep(script.input(tick, direction, diveReady));
          engine.consumeEvents(); engine.drainPresentationCues();
          const snapshot = engine.snapshot();
          diveReady = snapshot.skills.find(skill => skill.id === 'dive')!.available;
          const position = snapshot.actors.find(actor => actor.id === 'aren')!.position;
          if (position.z < gate.from.z) throw new Error(`gate breached from (${point.x}, ${point.z}) heading (${direction.x.toFixed(2)}, ${direction.z.toFixed(2)}) at (${position.x.toFixed(2)}, ${position.z.toFixed(2)})`);
        }
        runs++;
      }
    }
    expect(runs).toBeGreaterThan(500);
  }, 120000);

  it('opened gates are passable by the same inputs (the test can detect a breach)', () => {
    const seed = structuredClone(seedTemplate), player = seed.actors.find(actor => actor.id === seed.playerId)!;
    player.position = vec(gate.from.x, 0, gate.from.z + gate.halfExtents!.z + RADIUS + 0.4);
    seed.combatTrial!.index = 1;
    const engine = new CombatEngine(seed);
    for (let tick = 0; tick < 70; tick++) { engine.fixedStep({ ...IDLE, move: vec(0, 0, -1), sprintHeld: true }); engine.consumeEvents(); engine.drainPresentationCues(); }
    expect(engine.snapshot().actors.find(actor => actor.id === 'aren')!.position.z).toBeLessThan(gate.from.z - 2);
  });
});

describe('The Grove in the engine', () => {
  it('loads the variant, starts grove-practice with Heartroot Sprig on its spawn and leaves Koro and Vara out of the encounter', () => {
    const engine = new CombatEngine();
    engine.loadRegion({ regionId: 'the-grove', regionDefinition: region, runId: 'grove-load', presentActorIds: region.entities.map(entity => entity.id) });
    engine.startEncounter({ encounterId: 'grove-practice', regionId: 'the-grove', runId: 'grove-load' });
    engine.enableCombatTrials();
    const snapshot = engine.snapshot();
    expect(snapshot.actors.find(actor => actor.id === 'aren')!.position).toEqual({ x: 10, y: 0, z: 44 });
    const sprig = snapshot.actors.find(actor => actor.id === 'grove-sprig')!;
    expect(sprig.position).toEqual(trial.monsterPosition);
    expect(sprig.allegiance).toBe('hostile');
    expect(sprig.renderVariantId).toBe('actor-grove-rootling');
    expect(snapshot.actors.find(actor => actor.id === 'grove-koro')).toMatchObject({ allegiance: 'ally', archetypeId: 'grove-koro', position: { x: 28.5, y: 0, z: 5 } });
    expect(snapshot.actors.find(actor => actor.id === 'grove-vara')!.allegiance).toBe('ally');
    expect(snapshot.trialGates!.map(entry => [entry.id, entry.open])).toEqual([['evasion-practice', false]]);
  });

  it('Koro is never a party companion: no region instance carries the koro archetype, so a Koro slot cannot resolve to him', () => {
    expect(region.entities.some(entity => entity.actorId === 'koro')).toBe(false);
    const engine = new CombatEngine();
    expect(() => engine.loadRegion({ regionId: 'the-grove', regionDefinition: region, runId: 'grove-koro-slot', presentActorIds: region.entities.map(entity => entity.id), companionSlots: { utility: 'koro' } })).toThrow('must resolve to one explicitly present region instance');
    const scout = new CombatEngine();
    scout.loadRegion({ regionId: 'the-grove', regionDefinition: region, runId: 'grove-vara-slot', presentActorIds: region.entities.map(entity => entity.id), companionSlots: { scout: 'vara' } });
    expect(scout.snapshot().actors.find(actor => actor.id === 'grove-vara')).toBeDefined();
  });

  it('Koro stays idle, in place and untouched for the whole practice: never attacked, never hostile, never targeted', () => {
    const engine = new CombatEngine();
    engine.loadRegion({ regionId: 'the-grove', regionDefinition: region, runId: 'grove-koro-idle', presentActorIds: region.entities.map(entity => entity.id), companionSlots: { scout: 'vara' } });
    engine.startEncounter({ encounterId: 'grove-practice', regionId: 'the-grove', runId: 'grove-koro-idle', companionSlots: { scout: 'vara' } });
    engine.enableCombatTrials();
    const seed = engine.snapshotState();
    seed.player.vitality = seed.player.maxVitality = 1e6;
    seed.arena.cameraBasis = { forward: vec(0, 0, 1), right: vec(1, 0, 0) };
    seed.actors.find(actor => actor.id === 'aren')!.position = vec(-24, 0, -19);
    const running = new CombatEngine(seed);
    const koroBefore = running.snapshot().actors.find(actor => actor.id === 'grove-koro')!.position;
    let sprigCasts = 0, koroEvents = 0;
    for (let tick = 0; tick < 1500; tick++) {
      running.fixedStep(IDLE);
      for (const event of running.consumeEvents()) {
        if (event.actorId === 'grove-sprig' && event.kind === 'cue' && event.attackId) sprigCasts++;
        if (event.actorId === 'grove-koro' || event.targetId === 'grove-koro' || event.damage?.targetId === 'grove-koro') koroEvents++;
      }
      running.drainPresentationCues();
    }
    const koro = running.snapshot().actors.find(actor => actor.id === 'grove-koro')!;
    expect(sprigCasts).toBeGreaterThanOrEqual(3);
    expect(koroEvents).toBe(0);
    expect(koro).toMatchObject({ allegiance: 'ally', downed: false, position: koroBefore });
    expect(running.snapshotState().targetId).toBe('grove-sprig');
    expect(running.snapshotState().hazards.every(hazard => hazard.targetActorId !== 'grove-koro')).toBe(true);
  });
});
