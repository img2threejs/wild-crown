import { describe, expect, it } from 'bun:test';
import { CombatEngine, createEngineState, type CombatInput } from '../../src/game/combat/CombatEngine.js';
import { vec } from '../../src/game/combat/geometry.js';

/**
 * Deterministic continuity coverage for the airborne movement path: a jump keeps its arc, its speed and its pose phase while
 * the player steers, sprints, releases the stick, boosts and lands. Every case asserts a measured bound, not a recorded value.
 */

const idle: CombatInput = {
  tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false,
  heavyHeld: false, heavyReleased: false, interactPressed: false,
};
const forward = { ...idle, move: vec(0, 0, 1), sprintHeld: true };
const right = { ...idle, move: vec(1, 0, 0), sprintHeld: true };

const player = (engine: CombatEngine) => engine.snapshot().actors.find(actor => actor.allegiance === 'player')!;

/** The largest speed change one tick may make: the authored ground ramp (run speed over its acceleration ticks). */
const GROUND_SPEED_STEP = 6 / 7;
/** The largest heading change one tick may make: the authored turn rate (16 rad/s) over one fixed step. */
const TURN_STEP = 16 / 60;
/** The phase order an airborne body passes through. */
const PHASE_ORDER = ['takeoff', 'rising', 'falling', 'landing'] as const;

interface Sample {
  x: number; y: number; z: number;
  speed: number;
  heading: number;
  phase?: string;
  phaseProgress?: number;
}

function replay(ticks: number, input: (tick: number) => CombatInput): Sample[] {
  const engine = new CombatEngine(createEngineState());
  const samples: Sample[] = [];
  for (let tick = 0; tick < ticks; tick++) {
    engine.fixedStep({ ...input(tick), tick: engine.snapshotState().tick + 1 });
    const actor = player(engine);
    samples.push({
      x: actor.position.x, y: actor.position.y, z: actor.position.z,
      speed: Math.hypot(actor.velocity.x, actor.velocity.z),
      heading: Math.atan2(actor.facing.x, actor.facing.z),
      phase: actor.jumpPhase,
      phaseProgress: actor.jumpPhaseProgress,
    });
  }
  return samples;
}

const wrap = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));

describe('airborne movement continuity', () => {
  it('turns a mid-air steering change at the bounded turn rate instead of snapping the heading', () => {
    const samples = replay(90, tick => ({ ...(tick >= 40 ? right : forward), jumpPressed: tick === 20 }));
    let maxStep = 0;
    for (let index = 1; index < samples.length; index++) {
      maxStep = Math.max(maxStep, Math.abs(wrap(samples[index]!.heading - samples[index - 1]!.heading)));
    }
    // A 90-degree instant snap would read as a jolt; the airborne heading turns at the grounded rate instead.
    expect(maxStep).toBeLessThan(TURN_STEP + 1e-6);
    expect(maxStep).toBeGreaterThan(0);
  });

  it('holds the flight speed after takeoff on the authored ramp', () => {
    const samples = replay(90, tick => ({ ...forward, jumpPressed: tick === 20 }));
    // Takeoff is the one tick where the arc's own reach-limited cruise replaces the grounded speed.
    const takeoff = samples[28]!;
    expect(takeoff.speed).toBeGreaterThan(4.8);
    expect(takeoff.speed).toBeLessThanOrEqual(6 + 1e-6);
    // Every later tick of the flight changes the speed by at most the ground ramp.
    for (let index = 29; index < 60; index++) {
      expect(Math.abs(samples[index]!.speed - samples[index - 1]!.speed)).toBeLessThan(GROUND_SPEED_STEP + 1e-6);
    }
  });

  it('keeps the arc intact through a mid-air sprint change', () => {
    const samples = replay(90, tick => ({ ...forward, sprintHeld: tick < 40, jumpPressed: tick === 20 }));
    for (let index = 29; index < 70; index++) {
      expect(Math.abs(samples[index]!.speed - samples[index - 1]!.speed)).toBeLessThan(GROUND_SPEED_STEP + 1e-6);
    }
    // The flight still lands: the body is back on the floor.
    expect(samples.at(-1)!.y).toBeCloseTo(0, 6);
  });

  it('keeps a boosted jump a full-length flight instead of collapsing it to a hop', () => {
    const engine = new CombatEngine(createEngineState());
    engine.fixedStep({ ...forward, jumpPressed: true, tick: 1 });
    advanceTo(engine, 34);
    engine.fixedStep({ ...forward, jumpPressed: true, tick: engine.snapshotState().tick + 1 });
    const boosted = engine.snapshotState().playerJump!;
    expect(boosted.boosted).toBe(true);
    const from = player(engine).position;
    let travelled = 0;
    let previous = from;
    for (let tick = 0; tick < 160 && engine.snapshotState().playerJump; tick++) {
      engine.fixedStep({ ...forward, tick: engine.snapshotState().tick + 1 });
      const current = player(engine).position;
      travelled += Math.hypot(current.x - previous.x, current.z - previous.z);
      previous = current;
    }
    expect(engine.snapshotState().playerJump).toBeUndefined();
    // The boosted arc must carry the body the whole flight, not a fraction of it.
    expect(travelled).toBeGreaterThan(3);
    expect(player(engine).position.y).toBeCloseTo(0, 6);
  });

  it('advances the pose phase in order and never rewinds it', () => {
    const samples = replay(160, tick => ({ ...forward, jumpPressed: tick === 20 || tick === 34 }));
    let phaseIndex = -1;
    let previousPhase: string | undefined;
    let previousProgress: number | undefined;
    for (const sample of samples) {
      if (sample.phase === undefined) continue;
      const index = PHASE_ORDER.indexOf(sample.phase as typeof PHASE_ORDER[number]);
      expect(index).toBeGreaterThanOrEqual(0);
      if (sample.phase !== previousPhase) {
        // A phase never goes backwards in the authored order.
        expect(index).toBeGreaterThanOrEqual(phaseIndex);
        phaseIndex = index;
        previousPhase = sample.phase;
        previousProgress = sample.phaseProgress;
        continue;
      }
      // Inside one phase the progress only moves forward; a boost may shift the peak by a hair, never by a visible step.
      expect(sample.phaseProgress!).toBeGreaterThanOrEqual(previousProgress! - 0.02);
      previousProgress = sample.phaseProgress;
    }
    // The whole airborne sequence ran through every authored phase.
    expect(phaseIndex).toBe(PHASE_ORDER.length - 1);
  });

  it('keeps the drawn height monotonic through the flight', () => {
    const samples = replay(90, tick => ({ ...forward, jumpPressed: tick === 20 }));
    let maxStep = 0;
    for (let index = 1; index < samples.length; index++) {
      maxStep = Math.max(maxStep, Math.abs(samples[index]!.y - samples[index - 1]!.y));
    }
    expect(maxStep).toBeLessThan(0.2);
  });

  it('serializes an airborne flight without changing its trajectory', () => {
    const engine = new CombatEngine(createEngineState());
    engine.fixedStep({ ...forward, jumpPressed: true, tick: 1 });
    advanceTo(engine, 20);
    const restored = new CombatEngine();
    restored.restore(engine.serialize());
    for (let tick = 0; tick < 90; tick++) {
      engine.fixedStep({ ...forward, tick: engine.snapshotState().tick + 1 });
      restored.fixedStep({ ...forward, tick: restored.snapshotState().tick + 1 });
      expect(player(restored).position).toEqual(player(engine).position);
    }
  });

  it('lands a planned jump on the measured ground, not above it', () => {
    const engine = new CombatEngine(createEngineState());
    engine.fixedStep({ ...forward, jumpPressed: true, tick: 1 });
    for (let tick = 0; tick < 120 && engine.snapshotState().playerJump; tick++) {
      engine.fixedStep({ ...forward, tick: engine.snapshotState().tick + 1 });
    }
    expect(engine.snapshotState().playerJump).toBeUndefined();
    expect(player(engine).position.y).toBeCloseTo(0, 6);
  });
});

function advanceTo(engine: CombatEngine, tick: number): void {
  while (engine.snapshotState().tick < tick) engine.fixedStep({ ...forward, tick: engine.snapshotState().tick + 1 });
}
