import { describe, expect, it } from 'bun:test';
import { CombatEngine, type CombatInput } from '../../src/game/combat/CombatEngine.js';
import type { CombatTrialDefinition } from '../../src/game/combat/CombatTrials.js';
import { arenaFromRegion, groundHeightAt, moveCircle, vec, type CombatArena } from '../../src/game/combat/geometry.js';
import type { RegionColliderDefinition, RegionDefinition, RegionId, Vec3 } from '../../src/game/contracts.js';

/**
 * Brute-force proof that a playtest region's combat-trial gates seal its walk-mesh, on the exact playtest data path:
 * variant region -> loadRegion(regionDefinition) -> startEncounter -> enableCombatTrials. Native scene colliders (trees,
 * cages) only add blockers, so they are not needed to prove sealing. Every assertion is geometric or tick-based; nothing
 * depends on wall-clock time.
 */
export interface SealedRouteConfig {
  readonly name: string;
  readonly regionId: RegionId;
  readonly encounterId: string;
  /** The playtest variant exactly as the application builds it. */
  readonly region: RegionDefinition;
  readonly trials: readonly CombatTrialDefinition[];
  /** Where Aren starts (the first navigation node). */
  readonly start: Vec3;
  /** The stage goal ring centre. */
  readonly exit: Vec3;
  /** Route direction through each gate (before -> after). */
  readonly forward: readonly Vec3[];
  /** The flood-filled walk-mesh must have at least this many 0.5 m cells. */
  readonly minWalkableCells: number;
}

const CELL = 0.5;
const NEIGHBOURS: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const IDLE: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
const DIRECTIONS = Array.from({ length: 16 }, (_, step) => vec(Math.cos(step / 16 * Math.PI * 2), 0, Math.sin(step / 16 * Math.PI * 2)));

interface Reach { readonly cells: Uint8Array; readonly y: Float32Array; count: number }
type Script = (tick: number, direction: Vec3, diveReady: boolean) => CombatInput;
interface Start { readonly x: number; readonly y: number; readonly z: number }

export function describeSealedRoute(config: SealedRouteConfig): void {
  const { region, trials, start, exit, forward } = config;
  const gates = trials.map(trial => trial.gate);
  const baseArena = arenaFromRegion(region);
  const GX0 = Math.floor(region.bounds.min.x / CELL), GZ0 = Math.floor(region.bounds.min.z / CELL);
  const NX = Math.ceil((region.bounds.max.x - region.bounds.min.x) / CELL) + 2, NZ = Math.ceil((region.bounds.max.z - region.bounds.min.z) / CELL) + 2;
  const cellIndex = (x: number, z: number) => (Math.round(z / CELL) - GZ0) * NX + (Math.round(x / CELL) - GX0);
  const cellX = (index: number) => ((index % NX) + GX0) * CELL;
  const cellZ = (index: number) => (Math.floor(index / NX) + GZ0) * CELL;

  const probe = new CombatEngine();
  probe.loadRegion({ regionId: config.regionId, regionDefinition: region, runId: 'sealed-probe', presentActorIds: [], playerPosition: start });
  const playerBody = probe.snapshotState().actors.find(actor => actor.id === 'aren')!;
  const RADIUS = playerBody.radius, HEIGHT = playerBody.collisionHeight;

  const arenaWith = (closed: readonly RegionColliderDefinition[]): CombatArena => ({ ...baseArena, colliders: [...baseArena.colliders, ...closed] });
  /** Flood fill over a 0.5 m grid; each edge is one real moveCircle call with the engine's player capsule. */
  function flood(arena: CombatArena, seed: Vec3): Reach {
    const reach: Reach = { cells: new Uint8Array(NX * NZ), y: new Float32Array(NX * NZ), count: 0 };
    const first = cellIndex(seed.x, seed.z);
    reach.cells[first] = 1; reach.y[first] = seed.y; reach.count = 1;
    const stack = [first];
    while (stack.length) {
      const index = stack.pop()!;
      const x = cellX(index), z = cellZ(index), y = reach.y[index]!;
      for (const [dx, dz] of NEIGHBOURS) {
        const next = cellIndex(x + dx * CELL, z + dz * CELL);
        if (reach.cells[next]) continue;
        const moved = moveCircle(arena, { x, y, z }, { x: dx * CELL, y: 0, z: dz * CELL }, RADIUS, HEIGHT);
        if (Math.hypot(moved.x - (x + dx * CELL), moved.z - (z + dz * CELL)) > 0.02) continue;
        reach.cells[next] = 1; reach.y[next] = moved.y; reach.count++; stack.push(next);
      }
    }
    return reach;
  }
  const cellsOf = (reach: Reach): number[] => { const list: number[] = []; reach.cells.forEach((flag, index) => { if (flag) list.push(index); }); return list; };
  const contains = (reach: Reach, x: number, z: number) => reach.cells[cellIndex(x, z)] === 1;

  const boxDistance = (box: RegionColliderDefinition, x: number, z: number) => {
    const half = box.halfExtents!;
    return Math.hypot(Math.max(Math.abs(x - box.from.x) - half.x, 0), Math.max(Math.abs(z - box.from.z) - half.z, 0));
  };
  /** Does the xz segment touch the box grown by the capsule radius? (slab test) */
  function segmentHitsGrownBox(box: RegionColliderDefinition, a: { x: number; z: number }, b: { x: number; z: number }): boolean {
    const half = box.halfExtents!;
    let t0 = 0, t1 = 1;
    for (const [from, delta, centre, extent] of [[a.x, b.x - a.x, box.from.x, half.x + RADIUS], [a.z, b.z - a.z, box.from.z, half.z + RADIUS]] as const) {
      if (Math.abs(delta) < 1e-9) { if (Math.abs(from - centre) > extent) return false; continue; }
      const near = (centre - extent - from) / delta, far = (centre + extent - from) / delta;
      t0 = Math.max(t0, Math.min(near, far)); t1 = Math.min(t1, Math.max(near, far));
      if (t0 > t1) return false;
    }
    return true;
  }
  const side = (gate: number, x: number, z: number) => (x - gates[gate]!.from.x) * forward[gate]!.x + (z - gates[gate]!.from.z) * forward[gate]!.z;
  /** A floor height near the foot of gate box `gate`, for choosing the right floor layer under a point. */
  const gateFloor = (gate: number) => gates[gate]!.from.y - gates[gate]!.halfExtents!.y + 0.5;
  const afterSeed = (gate: number): Vec3 => {
    const box = gates[gate]!, half = box.halfExtents!, direction = forward[gate]!;
    const reach = (direction.x ? half.x : half.z) + RADIUS + 1;
    const x = box.from.x + direction.x * reach, z = box.from.z + direction.z * reach;
    return vec(x, groundHeightAt(baseArena, x, z, gateFloor(gate))!, z);
  };

  const all = flood(baseArena, start);
  const before = gates.map((_, index) => flood(arenaWith([gates[index]!]), start));
  const after = gates.map((_, index) => flood(arenaWith([gates[index]!]), afterSeed(index)));
  const progressive = Array.from({ length: gates.length + 1 }, (_, index) => flood(arenaWith(gates.slice(index)), start));

  describe(`${config.name} trial gates seal the walk-mesh`, () => {
    it('shapes each gate as a tall, thick box over the full chokepoint cross-section', () => {
      for (const [index, trial] of trials.entries()) {
        const gate = trial.gate, half = gate.halfExtents!;
        expect(gate.id).toBe('trial-gate:' + trial.id);
        expect(gate.blocksMovement).toBe(true);
        expect(Math.min(half.x, half.z) * 2).toBeGreaterThanOrEqual(1.1);
        let floorMin = Infinity, floorMax = -Infinity;
        for (let x = gate.from.x - half.x; x <= gate.from.x + half.x; x += 0.25) for (let z = gate.from.z - half.z; z <= gate.from.z + half.z; z += 0.25) {
          const floor = groundHeightAt(baseArena, x, z, gate.from.y - half.y + 0.5);
          if (floor === null) continue;
          floorMin = Math.min(floorMin, floor); floorMax = Math.max(floorMax, floor);
        }
        expect(Number.isFinite(floorMin)).toBe(true);
        expect(gate.from.y + half.y).toBeGreaterThanOrEqual(floorMax + 4);
        expect(gate.from.y - half.y).toBeLessThanOrEqual(floorMin);
        // Every walkable cell of the chokepoint plane (within the box thickness) sits inside the box with >= 1 m of void to each end.
        const along = forward[index]!.x ? 'z' : 'x', across = forward[index]!.x ? 'x' : 'z';
        let low = Infinity, high = -Infinity;
        for (const cell of cellsOf(all)) {
          const x = cellX(cell), z = cellZ(cell);
          if (Math.abs(side(index, x, z)) > half[across] + 0.3) continue;
          const value = along === 'x' ? x : z;
          if (Math.abs(value - gate.from[along]) > half[along] + 3.4) continue;
          low = Math.min(low, value); high = Math.max(high, value);
        }
        expect(gate.from[along] - half[along]).toBeLessThanOrEqual(low - 1 + 1e-9);
        expect(gate.from[along] + half[along]).toBeGreaterThanOrEqual(high + 1 - 1e-9);
      }
    });

    it('gives each trial a flat walkable arena that never crosses its gate plane, with the monster inside it', () => {
      for (const [index, trial] of trials.entries()) {
        const { center, radius } = trial.arena, gate = trial.gate, half = gate.halfExtents!;
        expect(radius).toBeGreaterThanOrEqual(7);
        for (let step = 0; step < 72; step++) {
          const angle = step / 72 * Math.PI * 2;
          for (const ring of [radius, radius * 0.5]) {
            const x = center.x + Math.cos(angle) * ring, z = center.z + Math.sin(angle) * ring;
            expect(groundHeightAt(baseArena, x, z, center.y)).toBe(center.y);
            expect(side(index, x, z)).toBeLessThan(-(forward[index]!.x ? half.x : half.z));
          }
        }
        expect(Math.hypot(trial.monsterPosition.x - center.x, trial.monsterPosition.z - center.z)).toBeLessThanOrEqual(radius);
        expect(groundHeightAt(baseArena, trial.monsterPosition.x, trial.monsterPosition.z, center.y)).toBe(center.y);
        expect(contains(before[index]!, center.x, center.z)).toBe(true);
        expect(contains(before[index]!, trial.monsterPosition.x, trial.monsterPosition.z)).toBe(true);
        expect(boxDistance(gate, trial.monsterPosition.x, trial.monsterPosition.z)).toBeGreaterThanOrEqual(4);
      }
    });

    it('splits the flood-filled walk-mesh into exactly a before and an after component for every closed gate', () => {
      expect(contains(all, exit.x, exit.z)).toBe(true);
      expect(all.count).toBeGreaterThan(config.minWalkableCells);
      for (const [index] of gates.entries()) {
        expect(contains(before[index]!, start.x, start.z)).toBe(true);
        expect(contains(before[index]!, exit.x, exit.z)).toBe(false);
        expect(contains(after[index]!, exit.x, exit.z)).toBe(true);
        expect(before[index]!.count).toBeGreaterThan(100);
        expect(after[index]!.count).toBeGreaterThan(100);
        let overlap = 0, stranded = 0;
        for (const cell of cellsOf(all)) {
          const inBefore = before[index]!.cells[cell] === 1, inAfter = after[index]!.cells[cell] === 1;
          if (inBefore && inAfter) overlap++;
          // Only cells the closed box itself covers (within one capsule of it) are in neither component.
          if (!inBefore && !inAfter && boxDistance(gates[index]!, cellX(cell), cellZ(cell)) >= RADIUS + CELL) stranded++;
        }
        expect(overlap).toBe(0);
        expect(stranded).toBe(0);
      }
    });

    it('keeps every segment locked until its gate opens and then exposes exactly the next segment', () => {
      expect(contains(progressive[gates.length]!, exit.x, exit.z)).toBe(true);
      for (let index = 0; index < gates.length; index++) {
        const reachable = progressive[index]!, next = progressive[index + 1]!;
        expect(contains(reachable, exit.x, exit.z)).toBe(false);
        expect(contains(reachable, start.x, start.z)).toBe(true);
        for (const cell of cellsOf(reachable)) {
          // Nothing beyond closed gate `index` is reachable ...
          expect(after[index]!.cells[cell]).toBe(0);
          // ... and opening it only ever adds cells.
          expect(next.cells[cell]).toBe(1);
        }
        expect(next.count).toBeGreaterThan(reachable.count);
        // The arena of the trial guarded by this gate is reachable before it opens.
        const { center } = trials[index]!.arena;
        expect(contains(reachable, center.x, center.z)).toBe(true);
        // The next trial's arena only becomes reachable once this gate is open.
        if (index < gates.length - 1) {
          const upcoming = trials[index + 1]!.arena;
          expect(contains(reachable, upcoming.center.x, upcoming.center.z)).toBe(false);
          expect(contains(next, upcoming.center.x, upcoming.center.z)).toBe(true);
        }
      }
    });

    it('cannot be hopped around: no jump-reach pair joins the two sides outside the closed box', () => {
      // Jump flights are at most 2.8 m (apex 0.8 m) and must land on supported floor within 0.45 m of the take-off height.
      const reach = 2.8 + 0.5;
      for (const [index, gate] of gates.entries()) {
        const near = (reachSet: Reach) => cellsOf(reachSet).filter(cell => boxDistance(gate, cellX(cell), cellZ(cell)) <= reach + 0.5);
        const nearBefore = near(before[index]!), nearAfter = near(after[index]!);
        expect(nearBefore.length).toBeGreaterThan(20);
        expect(nearAfter.length).toBeGreaterThan(20);
        for (const a of nearBefore) for (const b of nearAfter) {
          const ax = cellX(a), az = cellZ(a), bx = cellX(b), bz = cellZ(b);
          if (Math.hypot(ax - bx, az - bz) > reach || Math.abs(before[index]!.y[a]! - after[index]!.y[b]!) > 0.45) continue;
          expect(segmentHitsGrownBox(gate, { x: ax, z: az }, { x: bx, z: bz })).toBe(true);
        }
      }
    });
  });

  /** Loads the region exactly as the asset playtest does, then hides the monsters so only movement is under test. */
  function playtestSeed() {
    const engine = new CombatEngine();
    const present = region.entities.filter(entity => entity.actorId && !entity.visibleWhen).map(entity => entity.id);
    engine.loadRegion({ regionId: config.regionId, regionDefinition: region, runId: 'sealed-route', presentActorIds: present, playerPosition: start });
    engine.startEncounter({ encounterId: config.encounterId, regionId: config.regionId, runId: 'sealed-route' });
    engine.enableCombatTrials();
    const seed = engine.snapshotState();
    for (const actor of seed.actors) if (actor.id !== seed.playerId) actor.visible = false;
    seed.player.mana = seed.player.maxMana = 1e9;
    // Identity basis: input.move is a world-space heading, so 16 headings cover every camera orientation.
    seed.arena.cameraBasis = { forward: vec(0, 0, 1), right: vec(1, 0, 0) };
    return seed;
  }
  const seedTemplate = playtestSeed();
  const spawnAt = (gate: number, at: Start): CombatEngine => {
    const seed = structuredClone(seedTemplate);
    const player = seed.actors.find(actor => actor.id === seed.playerId)!;
    player.position = vec(at.x, groundHeightAt(baseArena, at.x, at.z, at.y) ?? at.y, at.z);
    seed.combatTrial!.index = gate;
    return new CombatEngine(seed);
  };

  const base = (direction: Vec3): CombatInput => ({ ...IDLE, move: direction, sprintHeld: true });
  const SCRIPTS: Readonly<Record<string, { ticks: number; input: Script }>> = {
    run: { ticks: 70, input: (_, direction) => base(direction) },
    'dive-chain': { ticks: 140, input: (_, direction, diveReady) => ({ ...base(direction), dodgePressed: diveReady }) },
    'jump-chain': { ticks: 140, input: (_, direction) => ({ ...base(direction), jumpPressed: true }) },
    'dive-jump-mix': { ticks: 140, input: (tick, direction) => ({ ...base(direction), dodgePressed: tick % 36 === 0, jumpPressed: tick % 36 === 20 }) },
  };

  /** Start positions hugging the closed gate: the box faces, both box ends and the walkable region edges around it. */
  function sampleStarts(gate: number): Start[] {
    const chosen: Start[] = [];
    const candidates = cellsOf(before[gate]!).map(cell => ({ x: cellX(cell), z: cellZ(cell), y: before[gate]!.y[cell]! }))
      .filter(entry => boxDistance(gates[gate]!, entry.x, entry.z) >= RADIUS + 0.1 && boxDistance(gates[gate]!, entry.x, entry.z) <= 4.5);
    const isEdge = (entry: { x: number; z: number }) => NEIGHBOURS.some(([dx, dz]) => !contains(all, entry.x + dx * CELL, entry.z + dz * CELL));
    const across = forward[gate]!.x ? (entry: { x: number; z: number }) => entry.x - gates[gate]!.from.x : (entry: { x: number; z: number }) => entry.z - gates[gate]!.from.z;
    const faceRow = candidates.filter(entry => boxDistance(gates[gate]!, entry.x, entry.z) <= RADIUS + 0.6).sort((a, b) => across(a) - across(b));
    for (let step = 0; step < 6; step++) { const entry = faceRow[Math.floor(step * (faceRow.length - 1) / 5)]; if (entry) chosen.push(entry); }
    for (const entry of faceRow.filter(isEdge).slice(0, 2)) chosen.push(entry);
    const edges = candidates.filter(isEdge).sort((a, b) => across(a) - across(b));
    for (let step = 0; step < 6; step++) { const entry = edges[Math.floor(step * (edges.length - 1) / 5)]; if (entry) chosen.push(entry); }
    const interior = candidates.filter(entry => boxDistance(gates[gate]!, entry.x, entry.z) >= 2.5);
    for (let step = 0; step < 3; step++) { const entry = interior[Math.floor(step * (interior.length - 1) / 2)]; if (entry) chosen.push(entry); }
    return chosen;
  }

  /** Runs one script; reports the deepest point reached past the gate's centre plane and whether the player ever touched the far component. */
  function furthest(gate: number, startPoint: Start, script: { ticks: number; input: Script }, direction: Vec3): { depth: number; beyond: boolean } {
    const engine = spawnAt(gate, startPoint);
    let depth = -Infinity, beyond = false, diveReady = true;
    for (let tick = 0; tick < script.ticks; tick++) {
      engine.fixedStep(script.input(tick, direction, diveReady));
      engine.consumeEvents(); engine.drainPresentationCues();
      const snapshot = engine.snapshot();
      diveReady = snapshot.skills.find(skill => skill.id === 'dive')!.available;
      const player = snapshot.actors.find(actor => actor.id === 'aren')!.position;
      depth = Math.max(depth, side(gate, player.x, player.z));
      const index = cellIndex(player.x, player.z);
      for (const [dx, dz] of [[0, 0], ...NEIGHBOURS]) if (after[gate]!.cells[index + dz! * NX + dx!] === 1) beyond = true;
    }
    return { depth, beyond };
  }

  describe(`${config.name} closed gates hold against the real CombatEngine`, () => {
    it('opened gates are passable by the same inputs (the harness can detect a breach)', () => {
      for (const gate of gates.keys()) {
        const box = gates[gate]!, direction = forward[gate]!, half = box.halfExtents!;
        const reach = (direction.x ? half.x : half.z) + RADIUS + 0.4;
        const startPoint = { x: box.from.x - direction.x * reach, y: gateFloor(gate), z: box.from.z - direction.z * reach };
        const engine = spawnAt(gate + 1, startPoint);
        for (let tick = 0; tick < 70; tick++) { engine.fixedStep({ ...IDLE, move: direction, sprintHeld: true }); engine.consumeEvents(); engine.drainPresentationCues(); }
        const player = engine.snapshot().actors.find(actor => actor.id === 'aren')!.position;
        expect(side(gate, player.x, player.z)).toBeGreaterThan(2);
      }
    });

    it('never lets Run, Dive chains or Jump chains reach the far side, from the box faces, ends and region edges, in 16 directions', () => {
      let runs = 0;
      for (const gate of gates.keys()) {
        const starts = sampleStarts(gate);
        expect(starts.length).toBeGreaterThanOrEqual(12);
        for (const startPoint of starts) for (const direction of DIRECTIONS) for (const script of Object.values(SCRIPTS)) {
          const result = furthest(gate, startPoint, script, direction);
          runs++;
          if (result.depth >= 0 || result.beyond) throw new Error(`gate ${gate} breached from (${startPoint.x}, ${startPoint.z}) heading (${direction.x.toFixed(2)}, ${direction.z.toFixed(2)}): depth ${result.depth}`);
        }
      }
      expect(runs).toBeGreaterThan(1000);
    }, 120000);
  });
}
