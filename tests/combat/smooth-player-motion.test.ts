import { describe, expect, it } from 'bun:test';
import { CombatEngine, createEngineState, type CombatInput } from '../../src/game/combat/CombatEngine.js';
import { distance2, isSupportedCapsulePose, vec, type SupportField } from '../../src/game/combat/geometry.js';
import type { RegionColliderDefinition } from '../../src/game/contracts.js';
import { EVASION_PROFILES } from '../../src/game/combat/evasion.js';

const idle: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
const player = (engine: CombatEngine) => engine.snapshotState().actors.find(actor => actor.id === 'aren')!;
function advance(engine: CombatEngine, ticks: number, input = idle): void {
  for (let tick = 0; tick < ticks; tick++) engine.fixedStep(input);
}
function obstacleEngine(colliders: RegionColliderDefinition[], floorEdge = -6): CombatEngine {
  const seed = createEngineState();
  seed.arena.colliders = colliders;
  seed.arena.surfaces = [{ id: 'floor', profile: 'plane', points: [vec(-6, 0, floorEdge), vec(6, 0, floorEdge), vec(6, 0, 6), vec(-6, 0, 6)], elevation: 0, walkable: true, material: 'earth', colliderId: 'floor' }];
  return new CombatEngine(seed);
}
const box = (id: string, height: number): RegionColliderDefinition => ({ id, kind: 'box', from: vec(0, height / 2, -0.9), halfExtents: vec(0.6, height / 2, 0.15), blocksMovement: true, blocksCamera: false });

function raisedProp(height = 1): SupportField {
  return { id: 'native:prop', ownerId: 'prop', kind: 'top', minX: 1, minZ: -1, cell: .25, cols: 8, rows: 8, minY: 0, maxY: height, top: Array<number>(64).fill(height), bottom: Array<number>(64).fill(0), stand: Array<number>(64).fill(1) };
}

function propEngine(height = 1): CombatEngine {
  const engine = obstacleEngine([]);
  engine.setSceneColliders([], [raisedProp(height)]);
  return engine;
}

const right = { ...idle, move: vec(1, 0, 0) };

function jumpOntoProp(engine: CombatEngine): void {
  engine.fixedStep({ ...right, jumpPressed: true });
  for (let tick = 0; tick < 100 && engine.snapshotState().playerJump; tick++) {
    const phase = engine.snapshot().actors.find(actor => actor.id === 'aren')!.jumpPhase;
    engine.fixedStep(phase === 'landing' ? idle : right);
  }
  expect(engine.snapshotState().playerJump).toBeUndefined();
  expect(player(engine).position.y).toBeCloseTo(1, 6);
}

describe('measured native prop support', () => {
  it('blocks grounded entry, accepts a reachable jump and holds a resting player on the real top', () => {
    const walking = propEngine();
    advance(walking, 60, right);
    expect(player(walking).position.x).toBeLessThanOrEqual(1 - player(walking).radius + 1e-4);
    expect(player(walking).position.y).toBe(0);
    const jumping = propEngine();
    jumpOntoProp(jumping);
    const landed = player(jumping).position;
    advance(jumping, 60);
    expect(player(jumping).position).toEqual(landed);
    expect(isSupportedCapsulePose(jumping.snapshotState().arena, landed, player(jumping).radius, player(jumping).collisionHeight)).toBe(true);
  });

  it('walks off a prop into a continuous fall, then returns to controllable ground movement', () => {
    const engine = propEngine();
    jumpOntoProp(engine);
    let previous = player(engine).position, fell = false;
    for (let tick = 0; tick < 80; tick++) {
      engine.fixedStep(right);
      const current = player(engine).position;
      fell ||= engine.snapshotState().playerJump?.fallVelocityY !== undefined;
      expect(distance2(previous, current)).toBeLessThan(.25);
      expect(Math.abs(current.y - previous.y)).toBeLessThan(.2);
      previous = current;
    }
    expect(fell).toBe(true);
    expect(previous.y).toBeCloseTo(0, 6);
    expect(previous.x).toBeGreaterThan(4);
    expect(engine.snapshotState().playerJump).toBeUndefined();
  });

  it('falls rather than hovering after a native support is removed, without charging jump mana', () => {
    const engine = propEngine();
    jumpOntoProp(engine);
    const mana = engine.snapshot().player.mana;
    engine.setSceneColliders([], []);
    advance(engine, 80);
    expect(player(engine).position.y).toBeCloseTo(0, 6);
    expect(engine.snapshotState().playerJump).toBeUndefined();
    expect(engine.snapshot().player.mana).toBe(mana);
  });

  it('rejects tops beyond jump reach and tops without standing headroom', () => {
    const tooHigh = propEngine(3);
    tooHigh.fixedStep({ ...right, jumpPressed: true });
    advance(tooHigh, 80, right);
    expect(player(tooHigh).position.y).toBeCloseTo(0, 6);
    expect(player(tooHigh).position.x).toBeLessThan(1);
    const ceiling = propEngine();
    ceiling.setSceneColliders([{ id: 'ceiling', kind: 'box', from: vec(2, 2.5, 0), halfExtents: vec(1, .1, 1), blocksMovement: true, blocksCamera: false }], [raisedProp()]);
    ceiling.fixedStep({ ...right, jumpPressed: true });
    advance(ceiling, 80, right);
    expect(player(ceiling).position.y).toBeCloseTo(0, 6);
    expect(player(ceiling).position.x).toBeLessThan(1);
  });
});

it('faces screen-relative movement rather than a selected target, and retains the last heading on release', () => {
  const seed = createEngineState();
  seed.actors.push({ ...seed.actors[0]!, id: 'corrupted-boar', archetypeId: 'corrupted-boar', allegiance: 'hostile', position: vec(8, 0, 8) });
  seed.targetId = 'corrupted-boar';
  const engine = new CombatEngine(seed);
  engine.setCameraBasis({ forward: vec(-0.6, 0, -0.8), right: vec(0.8, 0, -0.6) });
  advance(engine, 10, { ...idle, move: vec(1, 0, 0) });
  expect(player(engine).facing.x).toBeCloseTo(0.8, 6);
  expect(player(engine).facing.z).toBeCloseTo(-0.6, 6);
  expect(player(engine).actionId).toBe('aren-walk');
  advance(engine, 8);
  const heading = player(engine).facing;
  engine.fixedStep({ ...idle, dodgePressed: true });
  expect(player(engine).facing).toEqual(heading);
});

it('retains analog speed, caps diagonals, accelerates promptly and stops within six ticks without drift', () => {
  for (const [move, expectedSpeed] of [[vec(0, 0, 0.5), 2.05], [vec(1, 0, 1), 4.1]] as const) {
    const engine = new CombatEngine();
    advance(engine, 7, { ...idle, move });
    expect(Math.hypot(player(engine).velocity.x, player(engine).velocity.z)).toBeCloseTo(expectedSpeed, 6);
  }
  const engine = new CombatEngine();
  advance(engine, 7, { ...idle, move: vec(0, 0, 1), sprintHeld: true });
  expect(Math.hypot(player(engine).velocity.x, player(engine).velocity.z)).toBeCloseTo(6, 6);
  advance(engine, 6);
  expect(Math.hypot(player(engine).velocity.x, player(engine).velocity.z)).toBeLessThan(1e-8);
  const stopped = player(engine).position;
  advance(engine, 20);
  expect(player(engine).position).toEqual(stopped);
});

it('dives along each exact screen-relative vector without teleporting or freezing on repeated presses', () => {
  const basis = { forward: vec(-0.6, 0, -0.8), right: vec(0.8, 0, -0.6) };
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1], [0.3, 0.8]]) {
    const engine = new CombatEngine();
    engine.setCameraBasis(basis);
    const input = { ...idle, move: vec(x!, 0, z!), dodgePressed: true };
    engine.fixedStep(input);
    const launched = player(engine);
    const length = Math.hypot(x!, z!);
    const direction = vec((x! * basis.right.x + z! * basis.forward.x) / length, 0, (x! * basis.right.z + z! * basis.forward.z) / length);
    expect(launched.facing.x).toBeCloseTo(direction.x, 6);
    expect(launched.facing.z).toBeCloseTo(direction.z, 6);
    expect(distance2(vec(0, 0, 0), launched.position)).toBeLessThan(0.1);
    let previous = launched.position;
    for (let tick = 1; tick < EVASION_PROFILES.forward_left_dive_roll.durationTicks; tick++) {
      engine.fixedStep(input);
      const current = player(engine).position;
      expect(distance2(previous, current)).toBeGreaterThan(0);
      expect(distance2(previous, current)).toBeLessThan(0.25);
      previous = current;
    }
    expect(previous.x).toBeCloseTo(direction.x * EVASION_PROFILES.forward_left_dive_roll.distance, 6);
    expect(previous.z).toBeCloseTo(direction.z * EVASION_PROFILES.forward_left_dive_roll.distance, 6);
  }
});

it('stops a Dive at a wall without inventing a sideways escape direction', () => {
  const engine = obstacleEngine([box('wall', 3)]);
  engine.fixedStep({ ...idle, move: vec(0, 0, 1), dodgePressed: true });
  advance(engine, 60);
  expect(player(engine).position.z).toBeGreaterThanOrEqual(-0.33);
  expect(player(engine).position.x).toBe(0);
});

it('a stationary jump rises without forced horizontal travel and lands without a discontinuity', () => {
  const engine = new CombatEngine();
  engine.fixedStep({ ...idle, jumpPressed: true });
  let apex = 0, previous = player(engine).position;
  for (let tick = 0; tick < 120 && engine.snapshotState().playerJump; tick++) {
    engine.fixedStep(idle);
    const current = player(engine).position;
    apex = Math.max(apex, current.y);
    expect(distance2(current, vec(0, 0, 0))).toBeLessThan(1e-8);
    expect(Math.hypot(current.x - previous.x, current.y - previous.y, current.z - previous.z)).toBeLessThan(.3);
    previous = current;
  }
  expect(apex).toBeGreaterThan(1);
  expect(previous.y).toBeCloseTo(0, 6);
  expect(engine.snapshotState().playerJump).toBeUndefined();
});

it('clears a low root with the full capsule and lands beyond it on supported ground', () => {
  const engine = obstacleEngine([box('root', 0.5)]);
  const input = { ...idle, move: vec(0, 0, 1), sprintHeld: true };
  engine.fixedStep({ ...input, jumpPressed: true });
  for (let tick = 0; tick < 120 && engine.snapshotState().playerJump; tick++) engine.fixedStep(input);
  const landed = player(engine);
  expect(landed.position.z).toBeLessThan(-1.5);
  expect(isSupportedCapsulePose(engine.snapshotState().arena, landed.position, landed.radius, landed.collisionHeight)).toBe(true);
});

it('shortens a jump before a tall wall or unsupported landing and rejects a low ceiling', () => {
  for (const engine of [obstacleEngine([box('wall', 3)]), obstacleEngine([], -1.5)]) {
    const input = { ...idle, move: vec(0, 0, 1), sprintHeld: true };
    engine.fixedStep({ ...input, jumpPressed: true });
    for (let tick = 0; tick < 120 && engine.snapshotState().playerJump && engine.snapshot().actors.find(actor => actor.id === 'aren')!.jumpPhase !== 'landing'; tick++) engine.fixedStep(input);
    const landed = player(engine);
    expect(landed.position.y).toBeCloseTo(0, 6);
    expect(isSupportedCapsulePose(engine.snapshotState().arena, landed.position, landed.radius, landed.collisionHeight)).toBe(true);
  }
  const ceiling = obstacleEngine([{ id: 'ceiling', kind: 'box', from: vec(0, 1.9, 0), halfExtents: vec(3, 0.1, 3), blocksMovement: true, blocksCamera: false }]);
  ceiling.fixedStep({ ...idle, jumpPressed: true });
  advance(ceiling, 48);
  expect(player(ceiling).position).toEqual(vec(0, 0, 0));
  expect(player(ceiling).actionId).toBe('aren-idle');
});

for (const action of ['jump', 'dive'] as const) {
  it(`${action} preserves its trajectory through pause and serialization`, () => {
    const engine = new CombatEngine();
    engine.fixedStep({ ...idle, jumpPressed: action === 'jump', dodgePressed: action === 'dive' });
    advance(engine, 15);
    const restored = new CombatEngine();
    restored.restore(engine.serialize());
    const paused = player(restored);
    restored.setTimePolicy('paused');
    advance(restored, 20);
    expect(player(restored)).toEqual(paused);
    restored.setTimePolicy('normal');
    for (let tick = 0; tick < 60; tick++) {
      engine.fixedStep(idle);
      restored.fixedStep(idle);
      expect(player(restored)).toEqual(player(engine));
    }
  });
}

describe('air steering, higher second jumps and continuous locomotion', () => {
  const run: CombatInput = { ...idle, move: vec(0, 0, 1), sprintHeld: true };
  function flight(boost: boolean) {
    const engine = new CombatEngine();
    engine.fixedStep({ ...run, jumpPressed: true });
    let apex = 0, flightDistance = 0;
    for (let tick = 0; tick < 160 && engine.snapshotState().playerJump; tick++) {
      engine.fixedStep({ ...run, jumpPressed: boost && tick === 20 });
      const actor = engine.snapshot().actors.find(actor => actor.id === 'aren')!;
      apex = Math.max(apex, actor.position.y);
      if (actor.jumpPhase === 'rising' || actor.jumpPhase === 'falling') flightDistance = distance2(vec(0, 0, 0), actor.position);
    }
    expect(engine.snapshotState().playerJump).toBeUndefined();
    expect(player(engine).position.y).toBeCloseTo(0, 6);
    return { engine, apex, flightDistance };
  }
  it('the second press raises the apex and extends controllable flight instead of granting a third jump', () => {
    const single = flight(false), double = flight(true);
    expect(double.apex).toBeGreaterThan(single.apex + 1);
    expect(double.flightDistance).toBeGreaterThan(single.flightDistance + 1);
    expect(single.flightDistance).toBeLessThanOrEqual(4.2 + 1e-6);
    expect(double.flightDistance).toBeLessThanOrEqual(6.5 + 1e-6);
    const engine = new CombatEngine();
    engine.fixedStep({ ...run, jumpPressed: true });
    advance(engine, 15, run);
    const before = engine.snapshot().player.mana;
    engine.fixedStep({ ...run, jumpPressed: true });
    const boosted = engine.snapshotState().playerJump!;
    expect(boosted.boosted).toBe(true);
    expect(engine.snapshot().player.mana).toBeLessThan(before);
    const after = engine.snapshot().player.mana, deadline = boosted.flightStartedAtTick + boosted.flightTicks;
    engine.fixedStep({ ...run, jumpPressed: true });
    expect(engine.snapshot().player.mana).toBe(after);
    expect(engine.snapshotState().playerJump!.flightStartedAtTick + engine.snapshotState().playerJump!.flightTicks).toBe(deadline);
  });
  it('changes direction in mid-air without extending the flight or snapping to a new trajectory', () => {
    const engine = new CombatEngine();
    engine.fixedStep({ ...run, jumpPressed: true });
    advance(engine, 18, run);
    const original = engine.snapshotState().playerJump!, deadline = original.flightStartedAtTick + original.flightTicks;
    const before = player(engine).position, turn = { ...run, move: vec(1, 0, 0) };
    engine.fixedStep(turn);
    expect(distance2(before, player(engine).position)).toBeLessThan(.11);
    advance(engine, 12, turn);
    expect(player(engine).position.x).toBeGreaterThan(before.x + .8);
    expect(player(engine).position.y).toBeGreaterThan(0);
    const steered = engine.snapshotState().playerJump!;
    expect(steered.flightStartedAtTick + steered.flightTicks).toBe(deadline);
  });
  it('queues an early second press once and rejects an unaffordable boost without altering the first flight', () => {
    const early = new CombatEngine();
    early.fixedStep({ ...idle, jumpPressed: true });
    early.fixedStep({ ...idle, jumpPressed: true });
    advance(early, 10);
    expect(early.snapshotState().playerJump!.boosted).toBe(true);
    const seed = createEngineState();
    seed.player.mana = 8;
    const poor = new CombatEngine(seed);
    poor.fixedStep({ ...idle, jumpPressed: true });
    advance(poor, 15);
    const before = poor.snapshotState().playerJump!, mana = poor.snapshot().player.mana;
    poor.fixedStep({ ...idle, jumpPressed: true });
    expect(poor.snapshotState().playerJump).toEqual(before);
    expect(poor.snapshot().player.mana).toBe(mana);
  });
  it('freezes a boosted arc through hit-stop and paused restore, then resumes the identical trajectory', () => {
    const engine = new CombatEngine();
    engine.fixedStep({ ...run, jumpPressed: true });
    advance(engine, 15, run);
    engine.fixedStep({ ...run, jumpPressed: true });
    const seed = engine.snapshotState(); seed.hitStop = { remainingTicks: 3, strength: .5 };
    const stopped = new CombatEngine(seed), held = player(stopped).position;
    advance(stopped, 3, run);
    expect(player(stopped).position).toEqual(held);
    const restored = new CombatEngine(); restored.restore(stopped.serialize());
    restored.setTimePolicy('paused');
    advance(restored, 20, run);
    expect(player(restored).position).toEqual(held);
    restored.setTimePolicy('normal');
    for (let tick = 0; tick < 120; tick++) {
      stopped.fixedStep(run); restored.fixedStep(run);
      expect(player(restored)).toEqual(player(stopped));
    }
  });
  for (const action of ['jump', 'dive'] as const) {
    it(`${action} carries running through landing and recovery without a frozen or backwards frame`, () => {
      const engine = new CombatEngine();
      advance(engine, 10, run);
      let previous = player(engine).position;
      engine.fixedStep({ ...run, jumpPressed: action === 'jump', dodgePressed: action === 'dive' });
      for (let tick = 0; tick < 90; tick++) {
        engine.fixedStep(run);
        const current = player(engine).position;
        expect(current.z).toBeLessThan(previous.z);
        expect(Math.hypot(current.x - previous.x, current.y - previous.y, current.z - previous.z)).toBeLessThan(.3);
        previous = current;
      }
      expect(player(engine).actionId).toBe('aren-run');
      expect(player(engine).position.y).toBeCloseTo(0, 6);
    });
  }
  it('does not carry grounded anticipation through a wall or use a boost to clear a sealed wall', () => {
    const seed = createEngineState();
    seed.actors[0]!.velocity = vec(0, 0, -6);
    seed.arena.colliders = [box('launch-wall', 8)];
    const engine = new CombatEngine(seed);
    engine.fixedStep({ ...run, jumpPressed: true });
    for (let tick = 0; tick < 100; tick++) engine.fixedStep({ ...run, jumpPressed: tick === 15 });
    expect(player(engine).position.z).toBeGreaterThanOrEqual(-.33);
    expect(player(engine).position.y).toBeCloseTo(0, 8);
  });
});
