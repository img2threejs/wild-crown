import { describe, expect, it } from 'bun:test';
import { CombatEngine, FIXED_STEP_SECONDS, createEngineState, type CombatInput } from '../../src/game/combat/CombatEngine.js';
import { GREENWAKE_COMBAT_TRIALS } from '../../src/game/combat/CombatTrials.js';
import { MONSTER_ACCEL, MONSTER_DECEL, MONSTER_PROFILES, ROAR_TICKS, TRIAL_ENGAGE_RANGE } from '../../src/game/combat/WildlifePressure.js';
import { getWildlifePressure } from '../../src/game/combat/WildlifePressure.js';
import { groundHeightAt, vec } from '../../src/game/combat/geometry.js';
import { MONSTER_HURT_HOLD_TIME, ROAR_CLIP_SECONDS, ROAR_CLIP_WINDOW, resolveMonsterAnimation } from '../../src/rendering/MonsterAnimationProfiles.js';
import type { StoryCue } from '../../src/effects/story-cues.js';
import type { ActorSnapshot, GroundSurfaceDefinition, RegionColliderDefinition, Vec3 } from '../../src/game/contracts.js';

const idle: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function octagon(cx: number, cz: number, radius: number): Vec3[] {
  return Array.from({ length: 8 }, (_, index) => vec(cx + Math.cos(index * Math.PI / 4) * radius, 0, cz + Math.sin(index * Math.PI / 4) * radius));
}
function surface(id: string, points: Vec3[]): GroundSurfaceDefinition {
  return { id, profile: 'plane', points, elevation: 0, thickness: 0.4, walkable: true, material: 'test', colliderId: id + '-collider' };
}

interface Options {
  /** Authored-like room: only an octagon inside the arena plus a pad under the monster is walkable. */
  readonly room?: boolean;
  readonly colliders?: readonly RegionColliderDefinition[];
  readonly player?: Vec3;
  readonly pressureTicks?: number;
  readonly mutate?: (seed: ReturnType<CombatEngine['snapshotState']>) => void;
}

/** A real Greenwake trial engine with the dodge room swapped for a deterministic test arena and an effectively unkillable player. */
function trialEngine(index: number, options: Options = {}): CombatEngine {
  const engine = new CombatEngine();
  engine.startEncounter({ encounterId: 'greenwake-boar', regionId: 'greenwake', runId: 'monster-behaviour' });
  engine.enableCombatTrials();
  const seed = engine.snapshotState();
  const trial = GREENWAKE_COMBAT_TRIALS[index]!;
  seed.arena = createEngineState().arena;
  seed.arena.bounds = { min: vec(-200, -1, -200), max: vec(200, 12, 200) };
  if (options.room) {
    const pad = trial.monsterPosition;
    seed.arena.surfaces = [
      surface('room', octagon(trial.arena.center.x, trial.arena.center.z, trial.arena.radius * 0.9)),
      surface('pad', [vec(pad.x - 2.5, 0, pad.z - 2.5), vec(pad.x + 2.5, 0, pad.z - 2.5), vec(pad.x + 2.5, 0, pad.z + 2.5), vec(pad.x - 2.5, 0, pad.z + 2.5)]),
    ];
  }
  seed.arena.colliders = [...(options.colliders ?? [])];
  seed.combatTrial!.index = index;
  seed.player.vitality = seed.player.maxVitality = 1e6;
  const player = seed.actors.find(actor => actor.id === 'aren')!;
  const toCenter = { x: trial.arena.center.x - trial.monsterPosition.x, z: trial.arena.center.z - trial.monsterPosition.z };
  const length = Math.hypot(toCenter.x, toCenter.z);
  // Default: inside the monster's attack band, towards the arena centre.
  player.position = options.player ?? vec(trial.monsterPosition.x + toCenter.x / length * 5.5, 0, trial.monsterPosition.z + toCenter.z / length * 5.5);
  if (options.pressureTicks !== undefined) seed.wildlifeCombat = { engagedTicks: options.pressureTicks, sourceCursor: 0, attackCursors: {} };
  options.mutate?.(seed);
  return new CombatEngine(seed);
}

function monsterOf(engine: CombatEngine, index: number) {
  return engine.snapshot().actors.find(actor => actor.id === GREENWAKE_COMBAT_TRIALS[index]!.monsterId)!;
}

describe('trial monster locomotion', () => {
  for (let index = 0; index < GREENWAKE_COMBAT_TRIALS.length; index++) {
    const trial = GREENWAKE_COMBAT_TRIALS[index]!;
    it(`${trial.title}: stays inside its arena circle, on walkable ground and out of colliders while the player moves randomly`, () => {
      const pillar: RegionColliderDefinition = { id: 'test-pillar', kind: 'box', from: vec(trial.monsterPosition.x + 3, 1, trial.monsterPosition.z + 3), halfExtents: vec(0.8, 1, 0.8), blocksMovement: true, blocksCamera: false };
      const engine = trialEngine(index, { room: true, colliders: [pillar] });
      const arena = engine.snapshotState().arena;
      const profile = MONSTER_PROFILES[trial.monsterId]!;
      const random = mulberry32(0xc0ffee + index);
      let move = vec(0, 0, 0), sprint = false, holdUntil = 0, travelled = 0, moving = 0;
      let previous = monsterOf(engine, index).position;
      for (let tick = 0; tick < 3600; tick++) {
        if (tick >= holdUntil) {
          const angle = random() * Math.PI * 2;
          move = random() < 0.2 ? vec(0, 0, 0) : vec(Math.cos(angle), 0, Math.sin(angle));
          sprint = random() < 0.5;
          holdUntil = tick + 20 + Math.floor(random() * 80);
        }
        engine.fixedStep({ ...idle, move, sprintHeld: sprint });
        engine.consumeEvents(); engine.drainPresentationCues();
        const monster = monsterOf(engine, index);
        const { x, y, z } = monster.position;
        expect(Math.hypot(x - trial.arena.center.x, z - trial.arena.center.z)).toBeLessThanOrEqual(trial.arena.radius);
        expect(groundHeightAt(arena, x, z, y)).not.toBeNull();
        const nearestX = Math.max(pillar.from.x - 0.8, Math.min(pillar.from.x + 0.8, x));
        const nearestZ = Math.max(pillar.from.z - 0.8, Math.min(pillar.from.z + 0.8, z));
        expect(Math.hypot(x - nearestX, z - nearestZ)).toBeGreaterThanOrEqual(profile.radius - 0.05);
        expect(Math.hypot(monster.facing.x, monster.facing.z)).toBeCloseTo(1, 5);
        const step = Math.hypot(x - previous.x, z - previous.z);
        travelled += step;
        if (step > 1e-4) moving++;
        previous = monster.position;
      }
      expect(travelled).toBeGreaterThan(8);
      expect(moving).toBeGreaterThan(150);
    });
  }

  it('reports velocity and facing that match the movement, within the profile speeds', () => {
    const engine = trialEngine(0);
    const profile = MONSTER_PROFILES['corrupted-boar']!;
    let before = monsterOf(engine, 0);
    let sawMotion = false, sawTurn = false;
    for (let tick = 0; tick < 600; tick++) {
      engine.fixedStep(idle);
      const after = monsterOf(engine, 0);
      const displacement = Math.hypot(after.position.x - before.position.x, after.position.z - before.position.z) * 60;
      const speed = Math.hypot(after.velocity.x, after.velocity.z);
      expect(speed).toBeCloseTo(displacement, 4);
      if (after.attackPhase === undefined) expect(speed).toBeLessThanOrEqual(profile.advanceSpeed + 1e-6);
      sawMotion ||= speed > 0.5;
      sawTurn ||= Math.abs(after.yawRate ?? 0) > 0.5;
      before = after;
    }
    expect(sawMotion).toBe(true);
    expect(sawTurn).toBe(true);
  });

  it('ramps its ground speed up from a standstill and brakes instead of stepping 0 to cruise speed', () => {
    const trial = GREENWAKE_COMBAT_TRIALS[0]!, profile = MONSTER_PROFILES[trial.monsterId]!;
    const engine = trialEngine(0, { room: true, player: vec(trial.arena.center.x, 0, trial.arena.center.z) });
    const speeds: number[] = [], attacking: boolean[] = [], atRim: boolean[] = [];
    for (let tick = 0; tick < 900; tick++) {
      engine.fixedStep(idle);
      engine.consumeEvents(); engine.drainPresentationCues();
      const monster = monsterOf(engine, 0);
      speeds.push(Math.hypot(monster.velocity.x, monster.velocity.z));
      attacking.push(monster.attackPhase !== undefined);
      // The arena circle clamps a step outright; that wall is not part of the locomotion ramp.
      atRim.push(Math.hypot(monster.position.x - trial.arena.center.x, monster.position.z - trial.arena.center.z) > trial.arena.radius - 1.2);
    }
    const step = MONSTER_ACCEL / 60;
    const first = speeds.findIndex(speed => speed > 1e-6);
    expect(first).toBeGreaterThan(0);
    // The first strides after the roar pause are bounded by the acceleration, then the monster reaches its advance speed.
    for (let offset = 0; offset < 8; offset++) expect(speeds[first + offset]!).toBeLessThanOrEqual(step * (offset + 1) + 1e-6);
    const cruise = speeds.findIndex(speed => speed >= profile.advanceSpeed - 1e-6);
    expect(cruise).toBeGreaterThan(first);
    expect(cruise - first).toBeGreaterThanOrEqual(Math.floor(profile.advanceSpeed / step) - 1);
    // Away from a cast (which plants the body) no tick sheds more than the braking rate: a strafe flip or pivot slows the monster down instead of stopping it.
    let braked = 0, worstDrop = 0;
    for (let tick = 1; tick < speeds.length - 3; tick++) {
      if (attacking.slice(tick - 1, tick + 4).includes(true) || atRim.slice(tick - 1, tick + 4).includes(true)) continue;
      const drop = speeds[tick - 1]! - speeds[tick]!;
      if (speeds[tick - 1]! > 1) braked++;
      worstDrop = Math.max(worstDrop, drop);
    }
    // Sample floor for the drop check below: the monsters now square up TURN_LEAD_TICKS before a cast is due, so they spend slightly fewer ticks striding.
    expect(braked).toBeGreaterThan(90);
    expect(worstDrop).toBeLessThanOrEqual(MONSTER_DECEL / 60 + 1e-6);
  });

  it('keeps cleared and upcoming monsters idle in place, facing back along the route', () => {
    const engine = trialEngine(0);
    const initial = GREENWAKE_COMBAT_TRIALS.map((_, index) => monsterOf(engine, index));
    for (let tick = 0; tick < 600; tick++) engine.fixedStep(idle);
    for (const index of [1, 2]) {
      const monster = monsterOf(engine, index), start = initial[index]!, trial = GREENWAKE_COMBAT_TRIALS[index]!;
      expect(monster.position).toEqual(start.position);
      expect(monster.velocity.x).toBe(0);
      expect(monster.velocity.z).toBe(0);
      const away = { x: trial.monsterPosition.x - trial.gate.from.x, z: trial.monsterPosition.z - trial.gate.from.z };
      const length = Math.hypot(away.x, away.z);
      expect(monster.facing.x).toBeCloseTo(away.x / length, 5);
      expect(monster.facing.z).toBeCloseTo(away.z / length, 5);
    }
  });

  it('never moves during windup or commit, and holds still through recovery', () => {
    const engine = trialEngine(1);
    const samples: { phase: string | undefined; x: number; z: number }[] = [];
    for (let tick = 0; tick < 900; tick++) {
      engine.fixedStep(idle);
      const monster = monsterOf(engine, 1);
      samples.push({ phase: monster.attackPhase, x: monster.position.x, z: monster.position.z });
    }
    for (let index = 1; index < samples.length; index++) {
      const current = samples[index]!, previous = samples[index - 1]!;
      if (current.phase === 'windup' || current.phase === 'commit') {
        if (previous.phase === 'windup' || previous.phase === 'commit') expect(Math.hypot(current.x - previous.x, current.z - previous.z)).toBe(0);
      }
    }
    expect(samples.some(sample => sample.phase === 'windup')).toBe(true);
  });
});

describe('attack movement', () => {
  function laneSetup(colliders: readonly RegionColliderDefinition[] = []) {
    const engine = trialEngine(0, { colliders });
    const cues: StoryCue[] = [];
    let hazard: ReturnType<CombatEngine['snapshotState']>['hazards'][number] | undefined;
    const positions = new Map<number, Vec3>();
    for (let tick = 0; tick < 600 && !(hazard && engine.snapshotState().worldTick > hazard.recoveryUntil! + 1); tick++) {
      engine.fixedStep(idle);
      engine.consumeEvents();
      cues.push(...engine.drainPresentationCues());
      hazard ??= engine.snapshotState().hazards.find(candidate => candidate.attackId === 'boar-charge');
      positions.set(engine.snapshotState().worldTick, monsterOf(engine, 0).position);
    }
    return { engine, cues, hazard: hazard!, positions };
  }

  it('boar-charge anchors its lane at the boar and runs the boar down it during the active window, then lands', () => {
    const { cues, hazard, positions } = laneSetup();
    expect(hazard).toBeDefined();
    const at = (tick: number) => positions.get(Math.round(tick))!;
    const start = hazard.origin, dir = hazard.direction;
    expect(at(hazard.startTick + 1).x).toBeCloseTo(start.x, 6);
    // Windup and commit: the body does not travel.
    expect(Math.hypot(at(hazard.activeFrom).x - start.x, at(hazard.activeFrom).z - start.z)).toBeLessThan(1e-6);
    // The lane begins at the boar and reaches past the aimed position.
    const lane = hazard.depth;
    expect(hazard.target.x).toBeCloseTo(start.x + dir.x * lane / 2, 6);
    expect(hazard.target.z).toBeCloseTo(start.z + dir.z * lane / 2, 6);
    const end = at(hazard.castUntil! + 1);
    const along = (end.x - start.x) * dir.x + (end.z - start.z) * dir.z;
    const across = (end.x - start.x) * -dir.z + (end.z - start.z) * dir.x;
    expect(along).toBeGreaterThan(lane - 1.6);
    expect(along).toBeLessThanOrEqual(lane);
    expect(Math.abs(across)).toBeLessThan(0.05);
    // Mid-window the boar is part-way down the lane.
    const middle = at(Math.round((hazard.activeFrom + hazard.castUntil!) / 2));
    const middleAlong = (middle.x - start.x) * dir.x + (middle.z - start.z) * dir.z;
    expect(middleAlong).toBeGreaterThan(along * 0.3);
    expect(middleAlong).toBeLessThan(along * 0.7);
    const landings = cues.filter(cue => cue.kind === 'landing' && cue.actorId === 'corrupted-boar');
    expect(landings).toHaveLength(1);
    expect(landings[0]!.phase).toBe('landing');
    expect(landings[0]!.worldTick).toBeGreaterThanOrEqual(hazard.castUntil! - 1);
  });

  it('boar-charge is stopped by a collider on its lane and lands at the obstruction', () => {
    const free = laneSetup();
    const dir = free.hazard.direction, origin = free.hazard.origin;
    const half = 1.5, centre = vec(origin.x + dir.x * 4.2, 1, origin.z + dir.z * 4.2);
    const rock: RegionColliderDefinition = { id: 'test-rock', kind: 'box', from: centre, halfExtents: vec(half, 1, half), blocksMovement: true, blocksCamera: false };
    const blocked = laneSetup([rock]);
    expect(blocked.hazard.attackId).toBe('boar-charge');
    const radius = MONSTER_PROFILES['corrupted-boar']!.radius;
    let farthest = 0;
    for (const position of blocked.positions.values()) {
      const nearestX = Math.max(centre.x - half, Math.min(centre.x + half, position.x));
      const nearestZ = Math.max(centre.z - half, Math.min(centre.z + half, position.z));
      expect(Math.hypot(position.x - nearestX, position.z - nearestZ)).toBeGreaterThanOrEqual(radius - 0.06);
      farthest = Math.max(farthest, (position.x - origin.x) * dir.x + (position.z - origin.z) * dir.z);
    }
    const unobstructed = (free.positions.get(Math.round(free.hazard.castUntil! + 1))!.x - origin.x) * dir.x + (free.positions.get(Math.round(free.hazard.castUntil! + 1))!.z - origin.z) * dir.z;
    expect(farthest).toBeGreaterThan(0.5);
    expect(farthest).toBeLessThan(unobstructed - 1.5);
    const landings = blocked.cues.filter(cue => cue.kind === 'landing' && cue.actorId === 'corrupted-boar');
    expect(landings).toHaveLength(1);
    expect(landings[0]!.worldTick).toBeLessThan(blocked.hazard.castUntil! + 1);
  });

  it('root-rammer low wave takes a committed lunge of at most 1.5 m during its commit window', () => {
    const engine = trialEngine(2);
    let hazard: ReturnType<CombatEngine['snapshotState']>['hazards'][number] | undefined;
    const positions = new Map<number, Vec3>();
    for (let tick = 0; tick < 900 && !(hazard && engine.snapshotState().worldTick > hazard.castUntil! + 2); tick++) {
      engine.fixedStep(idle);
      hazard ??= engine.snapshotState().hazards.find(candidate => candidate.attackId === 'root-rammer-low-wave');
      positions.set(engine.snapshotState().worldTick, monsterOf(engine, 2).position);
    }
    expect(hazard).toBeDefined();
    const at = (tick: number) => positions.get(Math.round(tick))!;
    const start = hazard!.origin;
    expect(Math.hypot(at(hazard!.windupUntil! - 1).x - start.x, at(hazard!.windupUntil! - 1).z - start.z)).toBeLessThan(1e-6);
    const lunged = Math.hypot(at(hazard!.activeFrom + 1).x - start.x, at(hazard!.activeFrom + 1).z - start.z);
    expect(lunged).toBeGreaterThan(0.2);
    expect(lunged).toBeLessThanOrEqual(1.5 + 1e-6);
    // The hazard geometry was fixed at cast time at the monster's actual position.
    expect(hazard!.origin.x).toBeCloseTo(start.x, 6);
  });
});

describe('roars and pressure', () => {
  it('roars when the player first comes within engage range from outside the attack band, pausing the monster without damage', () => {
    const trial = GREENWAKE_COMBAT_TRIALS[0]!;
    const far = vec(trial.monsterPosition.x + 25, 0, trial.monsterPosition.z);
    let engine = trialEngine(0, { player: far });
    for (let tick = 0; tick < 30; tick++) { engine.fixedStep(idle); expect(engine.drainPresentationCues().some(cue => cue.kind === 'roar-cone')).toBe(false); }
    const seed = engine.snapshotState();
    seed.actors.find(actor => actor.id === 'aren')!.position = vec(trial.monsterPosition.x + TRIAL_ENGAGE_RANGE - 1, 0, trial.monsterPosition.z);
    engine = new CombatEngine(seed);
    const roars: StoryCue[] = [];
    let moved = 0, damage = 0, pausedTicks = 0, hazards = 0;
    const origin = monsterOf(engine, 0).position;
    for (let tick = 0; tick < ROAR_TICKS + 20; tick++) {
      engine.fixedStep(idle);
      roars.push(...engine.drainPresentationCues().filter(cue => cue.kind === 'roar-cone'));
      damage += engine.consumeEvents().filter(event => event.kind === 'damage').length;
      const monster = monsterOf(engine, 0);
      if (monster.roarProgress !== undefined) {
        pausedTicks++;
        moved = Math.max(moved, Math.hypot(monster.position.x - origin.x, monster.position.z - origin.z));
        hazards += engine.snapshotState().hazards.length;
      }
    }
    expect(roars).toHaveLength(1);
    expect(roars[0]).toMatchObject({ kind: 'roar-cone', phase: 'anticipation', actorId: 'corrupted-boar', durationTicks: ROAR_TICKS, scopeId: 'corrupted-boar:roar' });
    expect(roars[0]!.position).toEqual(origin);
    expect(pausedTicks).toBeGreaterThanOrEqual(ROAR_TICKS - 1);
    expect(moved).toBe(0);
    expect(hazards).toBe(0);
    expect(damage).toBe(0);
  });

  it('releases the scoped roar presentation and ends the pause when the monster is staggered mid-roar', () => {
    const trial = GREENWAKE_COMBAT_TRIALS[0]!;
    let engine = trialEngine(0, { player: vec(trial.monsterPosition.x + 25, 0, trial.monsterPosition.z) });
    const seed = engine.snapshotState();
    seed.actors.find(actor => actor.id === 'aren')!.position = vec(trial.monsterPosition.x + TRIAL_ENGAGE_RANGE - 1, 0, trial.monsterPosition.z);
    engine = new CombatEngine(seed);
    for (let tick = 0; tick < 10; tick++) engine.fixedStep(idle);
    expect(monsterOf(engine, 0).roarProgress).toBeDefined();
    const staggered = engine.snapshotState();
    staggered.actors.find(actor => actor.id === 'corrupted-boar')!.staggerUntil = staggered.worldTick + 30;
    engine = new CombatEngine(staggered);
    engine.drainPresentationCues();
    engine.fixedStep(idle);
    const cancels = engine.drainPresentationCues().filter(cue => cue.kind === 'cancel' && cue.scopeId === 'corrupted-boar:roar');
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.cancellationReason).toBe('interrupt');
    expect(monsterOf(engine, 0).roarProgress).toBeUndefined();
  });

  it('does not announce a roar when the player arrives already inside the attack band', () => {
    const engine = trialEngine(0);
    for (let tick = 0; tick < 60; tick++) {
      engine.fixedStep(idle);
      expect(engine.drainPresentationCues().some(cue => cue.kind === 'roar-cone')).toBe(false);
    }
  });

  it('roars once more when pressure escalates a tier, between attacks', () => {
    const engine = trialEngine(1, { pressureTicks: 898, mutate: seed => { seed.actors.find(actor => actor.id === 'greenwake-sap-stalker')!.recoveringUntil = 1e6; } });
    const roars: StoryCue[] = [];
    for (let tick = 0; tick < 200; tick++) {
      engine.fixedStep(idle);
      roars.push(...engine.drainPresentationCues().filter(cue => cue.kind === 'roar-cone'));
    }
    expect(roars).toHaveLength(1);
    expect(roars[0]!.actorId).toBe('greenwake-sap-stalker');
    expect(engine.snapshotState().wildlifeCombat!.engagedTicks).toBeGreaterThanOrEqual(900);
  });

  const thresholds = [0, 900, 1800, 3000];
  for (const [tier, threshold] of thresholds.entries()) {
    it(`tier ${tier}: keeps windup/commit floors, range limits and concurrency caps; chains only from tier 1`, () => {
      const engine = trialEngine(0, { pressureTicks: threshold, mutate: seed => { seed.actors.find(actor => actor.id === 'corrupted-boar')!.radius = 1.05; } });
      const seen = new Map<string, { startTick: number; castUntil: number; recoveryUntil: number; windupUntil: number; activeFrom: number }>();
      const order: string[] = [];
      const ticks = tier === 0 ? 850 : 2600;
      for (let tick = 0; tick < ticks; tick++) {
        engine.fixedStep(idle);
        engine.consumeEvents(); engine.drainPresentationCues();
        const state = engine.snapshotState();
        const monster = state.actors.find(actor => actor.id === 'corrupted-boar')!, player = state.actors.find(actor => actor.id === 'aren')!;
        for (const hazard of state.hazards) {
          if (seen.has(hazard.id)) continue;
          seen.set(hazard.id, { startTick: hazard.startTick, castUntil: hazard.castUntil!, recoveryUntil: hazard.recoveryUntil!, windupUntil: hazard.windupUntil!, activeFrom: hazard.activeFrom });
          order.push(hazard.id);
          expect(hazard.windupUntil! - hazard.startTick).toBeGreaterThanOrEqual(24);
          expect(hazard.activeFrom - hazard.windupUntil!).toBeGreaterThanOrEqual(8);
          expect(Math.hypot(monster.position.x - player.position.x, monster.position.z - player.position.z)).toBeLessThanOrEqual(14);
        }
        const pressure = getWildlifePressure(state.wildlifeCombat?.engagedTicks ?? 0);
        const casting = state.hazards.filter(hazard => state.worldTick < hazard.castUntil!).length;
        expect(casting).toBeLessThanOrEqual(pressure.maxConcurrent);
      }
      expect(order.length).toBeGreaterThan(2);
      let chains = 0, run = 1;
      for (let index = 1; index < order.length; index++) {
        const first = seen.get(order[index - 1]!)!, second = seen.get(order[index]!)!;
        // Never overlapping active windows; a chained second cast starts inside the first one's would-be recovery.
        expect(second.startTick).toBeGreaterThanOrEqual(first.castUntil);
        const chained = second.startTick < first.recoveryUntil;
        run = chained ? run + 1 : 1;
        if (chained) chains++;
        expect(run).toBeLessThanOrEqual(2);
      }
      if (tier === 0) expect(chains).toBe(0); else expect(chains).toBeGreaterThan(0);
    });
  }
});

describe('monster animation profile', () => {
  const assets = ['actor-ember-boar', 'actor-frost-sap-stalker', 'actor-root-rammer'];
  function actor(patch: Partial<ActorSnapshot> = {}): ActorSnapshot {
    return {
      id: 'corrupted-boar', archetypeId: 'corrupted-boar', species: 'boar', allegiance: 'hostile', position: vec(0, 0, 0), velocity: vec(0, 0, 0), facing: vec(0, 0, 1),
      actionId: 'wild-crown:actor-idle' as ActorSnapshot['actionId'], phase: 'idle', normalizedTime: 0, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false, ...patch,
    };
  }

  it('only animates the three Greenwake monster assets', () => {
    expect(resolveMonsterAnimation(actor(), 'actor-corrupted-boar')).toBeUndefined();
    expect(resolveMonsterAnimation(actor(), 'actor-aren')).toBeUndefined();
    for (const asset of assets) expect(resolveMonsterAnimation(actor(), asset)).toBeDefined();
  });

  it('selects locomotion loops by horizontal speed, with loop rate proportional to speed', () => {
    const idleSample = resolveMonsterAnimation(actor(), 'actor-ember-boar')!;
    expect(idleSample).toMatchObject({ actionId: 'monster-idle', phase: 'idle' });
    const slow = resolveMonsterAnimation(actor({ velocity: vec(1.2, 0, 0) }), 'actor-ember-boar')!;
    const quick = resolveMonsterAnimation(actor({ velocity: vec(2.4, 0, 0) }), 'actor-ember-boar')!;
    expect(slow.actionId).toBe('monster-walk');
    expect(quick.actionId).toBe('monster-walk');
    expect(quick.loopRate / slow.loopRate).toBeCloseTo(2, 5);
    const run = resolveMonsterAnimation(actor({ velocity: vec(0, 0, 4.4) }), 'actor-ember-boar')!;
    expect(run.actionId).toBe('monster-run');
    expect(run.loopRate).toBeGreaterThan(0.9);
    expect(resolveMonsterAnimation(actor({ yawRate: 2.2 }), 'actor-ember-boar')!.actionId).toBe('monster-turn');
    expect(resolveMonsterAnimation(actor({ yawRate: -2.2 }), 'actor-ember-boar')!.loopRate).toBeGreaterThan(0);
    // Walking while turning stays a walk.
    expect(resolveMonsterAnimation(actor({ velocity: vec(1.5, 0, 0), yawRate: 2 }), 'actor-ember-boar')!.actionId).toBe('monster-walk');
  });

  it('plays the finite hurt pose while staggered', () => {
    const stagger = resolveMonsterAnimation(actor({ actionId: 'corrupted-boar-stagger' as ActorSnapshot['actionId'], normalizedTime: 0.4 }), 'actor-ember-boar')!;
    expect(stagger).toMatchObject({ actionId: 'monster-hurt', phase: 'active', normalizedTime: 0.4 });
  });

  it('holds the dazed pose of the finite hurt clip for downed and exposed monsters instead of looping the flinch', () => {
    // The clip settles into the dazed pose 0.44-0.62; sampling one normalized time there freezes it (a loop would replay the flinch).
    expect(MONSTER_HURT_HOLD_TIME).toBeGreaterThan(0.44);
    expect(MONSTER_HURT_HOLD_TIME).toBeLessThan(0.62);
    for (const asset of assets) for (const patch of [{ downed: true }, { weakPointExposed: true }]) {
      expect(resolveMonsterAnimation(actor(patch), asset)).toEqual({ actionId: 'monster-hurt', phase: 'active', normalizedTime: MONSTER_HURT_HOLD_TIME, loopRate: 1 });
    }
  });

  it('plays the 2.0 s roar clip at about 1x across the 42-tick roar pause, on the stamp-to-shake window', () => {
    const speed = (ROAR_CLIP_WINDOW.to - ROAR_CLIP_WINDOW.from) * ROAR_CLIP_SECONDS / (ROAR_TICKS * FIXED_STEP_SECONDS);
    expect(speed).toBeGreaterThan(0.95);
    expect(speed).toBeLessThan(1.05);
    const roar = (roarProgress: number) => resolveMonsterAnimation(actor({ roarProgress }), 'actor-ember-boar')!;
    expect(roar(0)).toMatchObject({ actionId: 'monster-roar', phase: 'active', normalizedTime: ROAR_CLIP_WINDOW.from });
    expect(roar(1).normalizedTime).toBeCloseTo(ROAR_CLIP_WINDOW.to, 9);
    for (let tick = 1; tick <= ROAR_TICKS; tick++) expect(roar(tick / ROAR_TICKS).normalizedTime).toBeGreaterThan(roar((tick - 1) / ROAR_TICKS).normalizedTime);
    // The window holds the paw-stamp contact (~0.2) and the opening of the sustained shake (0.25).
    expect(ROAR_CLIP_WINDOW.from).toBeLessThan(0.2);
    expect(ROAR_CLIP_WINDOW.to).toBeGreaterThan(0.25);
  });
});
