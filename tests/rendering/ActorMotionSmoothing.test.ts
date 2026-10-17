import { describe, expect, it } from 'bun:test';
import { MAX_DRAWN_ABOVE, MAX_DRAWN_BELOW, MAX_PITCH, MAX_ROLL, createActorMotionState, settleDrawnHeight, updateLean } from '../../src/rendering/ActorMotionSmoothing.js';

const FRAME = 1 / 60;

describe('drawn height low-pass', () => {
  it('absorbs a 0.45 m step pop into a monotonic ramp that is within a centimetre of the ground inside 0.5 s', () => {
    const state = createActorMotionState();
    settleDrawnHeight(state, 0, FRAME, true, true);
    const drawn: number[] = [];
    for (let i = 0; i < 40; i++) drawn.push(settleDrawnHeight(state, 0.45, FRAME, true, true));
    expect(drawn[0]!).toBeLessThan(0.1);
    expect(drawn[0]!).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < drawn.length; i++) expect(drawn[i]!).toBeGreaterThanOrEqual(drawn[i - 1]! - 1e-12);
    expect(state.yOffset).toBeGreaterThanOrEqual(-MAX_DRAWN_BELOW);
    expect(0.45 - drawn[29]!).toBeLessThan(0.012);
    expect(drawn[39]!).toBeCloseTo(0.45, 2);
  });

  it('absorbs a step down the same way and never lets the drawn root trail above by more than the foot IK can reach', () => {
    const state = createActorMotionState();
    settleDrawnHeight(state, 0.45, FRAME, true, true);
    let previous = 0.45;
    for (let i = 0; i < 40; i++) {
      const drawn = settleDrawnHeight(state, 0, FRAME, true, true);
      expect(drawn).toBeLessThanOrEqual(previous + 1e-12);
      expect(state.yOffset).toBeLessThanOrEqual(MAX_DRAWN_ABOVE + 1e-12);
      previous = drawn;
    }
    expect(previous).toBeLessThan(0.01);
  });

  it('leaves slopes and stairs of a walking gait (at most 4 m/s of rise) exactly on the simulated height', () => {
    const state = createActorMotionState();
    for (let i = 0; i <= 120; i++) {
      const sim = 2.5 * i * FRAME;
      expect(settleDrawnHeight(state, sim, FRAME, true, true)).toBeCloseTo(sim, 9);
    }
  });

  it('is independent of the frame rate', () => {
    const at = (dt: number): number => {
      const state = createActorMotionState();
      settleDrawnHeight(state, 0, dt, true, true);
      let time = 0, drawn = 0;
      while (time < 0.2 - 1e-9) { drawn = settleDrawnHeight(state, 0.4, dt, true, true); time += dt; }
      return drawn;
    };
    expect(Math.abs(at(1 / 60) - at(1 / 144))).toBeLessThan(0.03);
  });

  it('drains quickly in the air, snaps on teleport and holds the offset across a zero-length frame', () => {
    const state = createActorMotionState();
    settleDrawnHeight(state, 0, FRAME, true, true);
    settleDrawnHeight(state, 0.4, FRAME, true, true);
    const offset = state.yOffset;
    expect(offset).toBeLessThan(-0.2);
    expect(settleDrawnHeight(state, 0.4, 0, true, true)).toBeCloseTo(0.4 + offset, 12);
    expect(state.yOffset).toBe(offset);
    for (let i = 0; i < 12; i++) settleDrawnHeight(state, 0.4, FRAME, false, true);
    expect(Math.abs(state.yOffset)).toBeLessThan(0.02);
    settleDrawnHeight(state, 0.8, FRAME, true, true);
    expect(settleDrawnHeight(state, 5, FRAME, true, false)).toBe(5);
    expect(state.yOffset).toBe(0);
  });
});

describe('acceleration lean', () => {
  const run = (frames: number, dt: number, velocity: (i: number) => [number, number], yaw = 0, enabled = true) => {
    const state = createActorMotionState();
    let peakPitch = 0, peakRoll = 0;
    for (let i = 0; i < frames; i++) {
      const [vx, vz] = velocity(i);
      updateLean(state, vx, vz, yaw, dt, enabled);
      peakPitch = Math.max(peakPitch, Math.abs(state.pitch)); peakRoll = Math.max(peakRoll, Math.abs(state.roll));
    }
    return { state, peakPitch, peakRoll };
  };

  it('leans forward when speeding up along the heading, within the 3.5° cap, and returns upright at a constant speed', () => {
    const { state, peakPitch } = run(30, FRAME, (i) => [0, Math.min(6, i * 0.9)]);
    expect(peakPitch).toBeGreaterThan(0.02);
    expect(peakPitch).toBeLessThanOrEqual(MAX_PITCH + 1e-12);
    for (let i = 0; i < 90; i++) updateLean(state, 0, 6, 0, FRAME, true);
    expect(state.pitch).toBe(0);
    expect(state.roll).toBe(0);
  });

  it('leans back, more gently, when braking', () => {
    const accelerating = createActorMotionState(), braking = createActorMotionState();
    updateLean(accelerating, 0, 0, 0, FRAME, true); updateLean(braking, 0, 6, 0, FRAME, true);
    for (let i = 0; i < 6; i++) { updateLean(accelerating, 0, 6, 0, FRAME, true); updateLean(braking, 0, 0, 0, FRAME, true); }
    expect(accelerating.pitch).toBeGreaterThan(0);
    expect(braking.pitch).toBeLessThan(0);
    expect(Math.abs(braking.pitch)).toBeLessThan(accelerating.pitch);
  });

  it('rolls into a turn toward the side it accelerates to, within the 4° cap', () => {
    // Facing +Z, the right-hand side is -X: pushing the velocity toward -X rolls positive, toward +X rolls negative.
    const right = run(20, FRAME, (i) => [-Math.min(5, i * 0.8), 6]);
    const left = run(20, FRAME, (i) => [Math.min(5, i * 0.8), 6]);
    expect(right.state.roll).toBeGreaterThan(0.01);
    expect(left.state.roll).toBeLessThan(-0.01);
    expect(right.peakRoll).toBeLessThanOrEqual(MAX_ROLL + 1e-12);
    // Facing +X the right-hand side is +Z.
    const facingX = run(20, FRAME, (i) => [6, Math.min(5, i * 0.8)], Math.PI / 2);
    expect(facingX.state.roll).toBeGreaterThan(0.01);
  });

  it('stays upright when disabled (reduced motion, airborne) and recovers without a jump when re-enabled', () => {
    const off = run(30, FRAME, (i) => [0, i], 0, false);
    expect(off.peakPitch).toBe(0);
    expect(off.peakRoll).toBe(0);
    const state = createActorMotionState();
    updateLean(state, 0, 6, 0, FRAME, true);
    updateLean(state, 0, 6, 0, FRAME, true);
    expect(state.pitch).toBe(0);
  });

  it('is nearly frame-rate independent and finite on a zero-length frame', () => {
    const peak = (dt: number): number => {
      const state = createActorMotionState();
      let best = 0, time = 0;
      updateLean(state, 0, 0, 0, dt, true);
      while (time < 0.5) { time += dt; updateLean(state, 0, Math.min(6, time * 51), 0, dt, true); best = Math.max(best, state.pitch); }
      return best;
    };
    expect(Math.abs(peak(1 / 60) - peak(1 / 144))).toBeLessThan(0.012);
    const state = createActorMotionState();
    updateLean(state, 0, 3, 0, 0, true);
    updateLean(state, 0, 6, 0, 0, true);
    expect(Number.isFinite(state.pitch) && Number.isFinite(state.roll)).toBe(true);
  });
});

describe('start, stop and pivot settle', () => {
  /** Runs a velocity profile along the heading and records the pitch (+ = forward) every frame. */
  const pitchTrace = (frames: number, dt: number, velocity: (time: number) => number): number[] => {
    const state = createActorMotionState(), trace: number[] = [];
    updateLean(state, 0, velocity(0), 0, dt, true);
    for (let i = 1; i <= frames; i++) { updateLean(state, 0, velocity(i * dt), 0, dt, true); trace.push(state.pitch); }
    return trace;
  };
  /** Sprints from rest to 6 m/s in 0.25 s, runs, then stops in 0.15 s at t = 1.2 s. */
  const sprintAndStop = (t: number): number => t < 0.25 ? 24 * t : t < 1.2 ? 6 : Math.max(0, 6 - 40 * (t - 1.2));

  it('tips forward on the start, leans back on the stop and settles through a small rebound', () => {
    const trace = pitchTrace(240, 1 / 60, sprintAndStop);
    const start = Math.max(...trace.slice(0, 20)), stopStart = 72;
    const back = Math.min(...trace.slice(stopStart, stopStart + 30));
    expect(start).toBeGreaterThan(0.06);
    expect(back).toBeLessThan(-0.03);
    // After the stop the lean crosses zero (the rebound) by a visible but small amount, then rests exactly upright.
    const rebound = Math.max(...trace.slice(stopStart + 12, stopStart + 90));
    expect(rebound).toBeGreaterThan(0.002);
    expect(rebound).toBeLessThan(Math.abs(back));
    expect(trace[trace.length - 1]).toBe(0);
  });

  it('stays inside the hard caps even for a violent change of velocity', () => {
    const state = createActorMotionState();
    updateLean(state, 0, 0, 0, 1 / 60, true);
    for (let i = 0; i < 60; i++) {
      updateLean(state, 80 * (i % 2 ? 1 : -1), 80 * (i % 3 ? 1 : -1), i * 0.3, 1 / 60, true);
      expect(Math.abs(state.pitch)).toBeLessThanOrEqual(MAX_PITCH + 1e-12);
      expect(Math.abs(state.roll)).toBeLessThanOrEqual(MAX_ROLL + 1e-12);
    }
  });

  it('rocks through a pivot: braking leans back and accelerating the other way leans forward again', () => {
    // Facing +Z; the actor runs +Z at 6 m/s, reverses to -Z at 6 m/s over 0.3 s while keeping its heading.
    const trace = pitchTrace(120, 1 / 60, (t) => t < 0.3 ? 6 : t < 0.6 ? 6 - 40 * (t - 0.3) : -6);
    const braking = Math.min(...trace.slice(18, 40)), after = Math.max(...trace.slice(40));
    expect(braking).toBeLessThan(-0.03);
    expect(Math.abs(after)).toBeGreaterThan(0.001);
  });

  it('the settle is the same at 60 and at 144 frames per second', () => {
    const peak = (dt: number) => Math.min(...pitchTrace(Math.round(2 / dt), dt, sprintAndStop));
    expect(Math.abs(peak(1 / 60) - peak(1 / 144))).toBeLessThan(0.012);
  });
});
