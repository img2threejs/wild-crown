import { describe, expect, it } from 'bun:test';
import { CombatEngine, type CombatInput } from '../../src/game/combat/CombatEngine.js';
import { vec } from '../../src/game/combat/geometry.js';

const idle: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
const player = (engine: CombatEngine) => engine.snapshotState().actors.find(actor => actor.id === 'aren')!;
const speedOf = (engine: CombatEngine): number => Math.hypot(player(engine).velocity.x, player(engine).velocity.z);
const yawOf = (engine: CombatEngine): number => Math.atan2(player(engine).facing.x, player(engine).facing.z);
const wrap = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));
const TICK = 1 / 60;
const WALK = 4.1, RUN = 6;

function advance(engine: CombatEngine, ticks: number, input = idle): void {
  for (let tick = 0; tick < ticks; tick++) engine.fixedStep(input);
}
/** Default camera basis: stick up = -Z, stick right = +X. */
const stick = (x: number, z: number, sprintHeld = false): CombatInput => ({ ...idle, move: vec(x, 0, z), sprintHeld });

describe('player gait follows measured planar speed', () => {
  it('plays walk at walking pace and run only once the speed is clearly above it, even with sprint held', () => {
    const halfTilt = new CombatEngine();
    advance(halfTilt, 20, stick(0, 0.5, true));
    expect(speedOf(halfTilt)).toBeCloseTo(3, 6);
    expect(player(halfTilt).actionId).toBe('aren-walk');
    const walking = new CombatEngine();
    advance(walking, 20, stick(0, 1));
    expect(speedOf(walking)).toBeCloseTo(WALK, 6);
    expect(player(walking).actionId).toBe('aren-walk');
    const sprinting = new CombatEngine();
    advance(sprinting, 20, stick(0, 1, true));
    expect(speedOf(sprinting)).toBeCloseTo(RUN, 6);
    expect(player(sprinting).actionId).toBe('aren-run');
  });

  it('keeps run until the speed falls below the lower exit threshold and walk until it passes the higher entry threshold', () => {
    const enter = WALK * 1.16, exit = WALK * 1.05;
    // Analog sprint magnitude between the two thresholds: a runner keeps running, a walker keeps walking.
    const between = (enter + exit) / 2 / RUN;
    const runner = new CombatEngine();
    advance(runner, 20, stick(0, 1, true));
    advance(runner, 20, stick(0, between, true));
    expect(speedOf(runner)).toBeGreaterThan(exit);
    expect(speedOf(runner)).toBeLessThan(enter);
    expect(player(runner).actionId).toBe('aren-run');
    const walker = new CombatEngine();
    advance(walker, 20, stick(0, 1));
    advance(walker, 20, stick(0, between, true));
    expect(speedOf(walker)).toBeCloseTo(speedOf(runner), 6);
    expect(player(walker).actionId).toBe('aren-walk');
    // Dropping clearly below the exit threshold releases the run clip.
    advance(runner, 20, stick(0, (exit - 0.3) / RUN, true));
    expect(player(runner).actionId).toBe('aren-walk');
  });

  it('measures the speeds at which a sprint ramp and a release switch the clip', () => {
    const engine = new CombatEngine();
    let enteredAt = -1;
    for (let tick = 0; tick < 20 && enteredAt < 0; tick++) {
      engine.fixedStep(stick(0, 1, true));
      if (player(engine).actionId === 'aren-run') enteredAt = speedOf(engine);
    }
    expect(enteredAt).toBeGreaterThan(WALK * 1.16);
    expect(enteredAt).toBeLessThanOrEqual(RUN);
    let leftAt = -1;
    for (let tick = 0; tick < 20 && leftAt < 0; tick++) {
      engine.fixedStep(stick(0, 0.5, false));
      if (player(engine).actionId === 'aren-walk') leftAt = speedOf(engine);
    }
    expect(leftAt).toBeLessThanOrEqual(WALK * 1.05);
    expect(leftAt).toBeGreaterThan(0);
    expect(enteredAt).toBeGreaterThan(leftAt);
  });
});

describe('player heading turns at a bounded rate', () => {
  it('never turns faster than 16 rad/s and completes a 180° reversal in about 0.2 s', () => {
    const engine = new CombatEngine();
    advance(engine, 20, stick(0, 1));
    const start = yawOf(engine);
    let previous = start, ticks = 0, peak = 0;
    for (; ticks < 40; ticks++) {
      engine.fixedStep(stick(0, -1));
      const yaw = yawOf(engine), delta = Math.abs(wrap(yaw - previous));
      peak = Math.max(peak, delta / TICK);
      previous = yaw;
      if (Math.abs(wrap(yaw - start)) > Math.PI - 1e-6 || Math.abs(player(engine).facing.z - 1) < 1e-9) { ticks++; break; }
    }
    expect(peak).toBeLessThanOrEqual(16 + 1e-6);
    expect(peak).toBeGreaterThan(15.9);
    expect(ticks).toBeGreaterThanOrEqual(Math.ceil(Math.PI / (16 * TICK)));
    expect(ticks).toBeLessThanOrEqual(Math.ceil(Math.PI / (16 * TICK)) + 1);
    expect(player(engine).facing.z).toBeCloseTo(1, 6);
  });

  it('turns through the short way and never overshoots the held heading', () => {
    const engine = new CombatEngine();
    advance(engine, 4, stick(1, 0));
    const wanted = Math.atan2(1, 0);
    let error = Math.abs(wrap(wanted - yawOf(engine)));
    for (let tick = 0; tick < 12; tick++) {
      engine.fixedStep(stick(1, 0));
      const next = Math.abs(wrap(wanted - yawOf(engine)));
      expect(next).toBeLessThanOrEqual(error + 1e-9);
      error = next;
    }
    expect(error).toBeLessThan(1e-6);
  });

  it('slows a moving player through a reversal instead of launching straight into the new heading', () => {
    const engine = new CombatEngine();
    advance(engine, 20, stick(0, 1));
    // Heading is -Z. Reverse: while the heading is still more than 1 rad away the speed along +Z stays below 55% of walking pace.
    let peakWhileTurning = 0;
    for (let tick = 0; tick < 20; tick++) {
      engine.fixedStep(stick(0, -1));
      const remaining = Math.abs(wrap(0 - yawOf(engine)));
      if (remaining > 1) peakWhileTurning = Math.max(peakWhileTurning, Math.max(0, player(engine).velocity.z));
    }
    expect(peakWhileTurning).toBeLessThan(0.55 * WALK);
    advance(engine, 20, stick(0, -1));
    expect(speedOf(engine)).toBeCloseTo(WALK, 6);
  });

  it('keeps starts from standstill and aligned movement at full acceleration', () => {
    const engine = new CombatEngine();
    advance(engine, 7, stick(0, 0.5));
    expect(speedOf(engine)).toBeCloseTo(2.05, 6);
  });
});

describe('attacks and aim stay responsive while the heading is turning', () => {
  it('points a light attack at the stick immediately, not at the half-turned heading', () => {
    const engine = new CombatEngine();
    advance(engine, 20, stick(0, 1));
    // Heading -Z; stick flips to +Z and attack is pressed on the same tick.
    engine.fixedStep({ ...stick(0, -1), lightPressed: true });
    expect(player(engine).facing.z).toBeCloseTo(1, 6);
    expect(player(engine).actionId).not.toBe('aren-walk');
  });
});
