/**
 * Presentation-only motion polish for one displayed actor: a low-pass on the drawn root height that absorbs the simulation's
 * step and ledge pops, and a small lean of the root from the actor's acceleration. Nothing here reads or writes simulation state,
 * and every call works on one preallocated record, so a frame allocates nothing.
 */
export interface ActorMotionState {
  /** Drawn height minus simulated height (m); a critically damped spring pulls it to zero, so a pop starts with no velocity and eases out without overshoot. */
  yOffset: number;
  yVelocity: number;
  lastSimY: number;
  hasHeight: boolean;
  /** Low-passed planar velocity (m/s) whose difference from the live velocity is the acceleration. */
  smoothVx: number;
  smoothVz: number;
  hasVelocity: boolean;
  /** Current lean (rad): pitch about the body's right axis (+ = forward), roll about its forward axis (+ = toward the right hand), and their angular velocities (rad/s). */
  pitch: number;
  roll: number;
  pitchVelocity: number;
  rollVelocity: number;
}

/** Heights change by up to this much per second without being treated as a pop (slopes and stairs of a walking gait). */
export const STEP_FOLLOW_SPEED = 4;
/** Natural frequency (rad/s) of the absorbed pop on the ground, and the decay rate (1/s) once the actor is airborne (so a jump never starts with a stale offset). */
const STEP_OMEGA = 14;
const AIR_DECAY = 30;
/** The drawn root may trail the simulated one by at most this much: below it (after a step up) FootGrounding can lift a foot 0.45 m, above it (after a step down) it can lower one 0.35 m. */
export const MAX_DRAWN_BELOW = 0.45;
export const MAX_DRAWN_ABOVE = 0.3;
/**
 * Lean: rad per m/s² of smoothed acceleration, hard caps (about 6° pitch, 6.3° roll) and the low-pass rate (1/s) of the velocity the acceleration is read from.
 * The lean itself is an underdamped spring (LEAN_OMEGA rad/s, damping ratio LEAN_ZETA = 0.3, about 37 % overshoot of a step): a start tips the body forward, a stop leans it
 * back and then settles through a small rebound, and a pivot (brake, then accelerate the other way) rocks through both.
 */
const PITCH_GAIN = 0.0036;
const BRAKE_PITCH_SCALE = 0.6;
const ROLL_GAIN = 0.0042;
export const MAX_PITCH = 0.105;
export const MAX_ROLL = 0.11;
const VELOCITY_RATE = 10;
const LEAN_OMEGA = 18;
const LEAN_ZETA = 0.3;
/** The spring is integrated in steps no longer than this (s), so it stays inside the explicit-Euler stability limit at any frame rate. */
const LEAN_STEP = 1 / 120;

export function createActorMotionState(): ActorMotionState {
  return { yOffset: 0, yVelocity: 0, lastSimY: 0, hasHeight: false, smoothVx: 0, smoothVz: 0, hasVelocity: false, pitch: 0, roll: 0, pitchVelocity: 0, rollVelocity: 0 };
}

/**
 * Returns the height to draw for a simulated height `simY`. `continuous` is false for a teleport, a respawn or a first frame (snap) and
 * `grounded` false while the actor is airborne or hovering (the offset drains quickly instead of lingering). A frame of zero length keeps
 * the current offset untouched.
 */
export function settleDrawnHeight(state: ActorMotionState, simY: number, dt: number, grounded: boolean, continuous: boolean): number {
  if (!continuous || !state.hasHeight) { state.yOffset = 0; state.yVelocity = 0; }
  else if (dt > 0) {
    if (grounded) {
      const change = simY - state.lastSimY, allowed = STEP_FOLLOW_SPEED * dt;
      const pop = change - (change > allowed ? allowed : change < -allowed ? -allowed : change);
      state.yOffset -= pop;
      const decay = Math.exp(-STEP_OMEGA * dt), carry = (state.yVelocity + STEP_OMEGA * state.yOffset) * dt;
      state.yVelocity = (state.yVelocity - STEP_OMEGA * carry) * decay;
      state.yOffset = (state.yOffset + carry) * decay;
      state.yOffset = state.yOffset < -MAX_DRAWN_BELOW ? -MAX_DRAWN_BELOW : state.yOffset > MAX_DRAWN_ABOVE ? MAX_DRAWN_ABOVE : state.yOffset;
    } else { state.yOffset *= Math.exp(-AIR_DECAY * dt); state.yVelocity = 0; }
    if (Math.abs(state.yOffset) < 1e-4 && Math.abs(state.yVelocity) < 1e-3) { state.yOffset = 0; state.yVelocity = 0; }
  }
  state.lastSimY = simY;
  state.hasHeight = true;
  return simY + state.yOffset;
}

/**
 * Updates the lean from the actor's planar velocity and heading (`yaw`, radians about +Y). The acceleration is the gap between the live
 * velocity and its own low-pass, so it is smooth and independent of the frame rate. With `enabled` false (reduced motion, airborne,
 * downed) the lean returns to upright immediately.
 */
export function updateLean(state: ActorMotionState, velocityX: number, velocityZ: number, yaw: number, dt: number, enabled: boolean): void {
  if (!enabled) { state.pitch = 0; state.roll = 0; state.pitchVelocity = 0; state.rollVelocity = 0; state.hasVelocity = false; return; }
  if (!state.hasVelocity) { state.smoothVx = velocityX; state.smoothVz = velocityZ; state.hasVelocity = true; }
  if (dt <= 0) return;
  const accelX = (velocityX - state.smoothVx) * VELOCITY_RATE, accelZ = (velocityZ - state.smoothVz) * VELOCITY_RATE;
  const follow = 1 - Math.exp(-VELOCITY_RATE * dt);
  state.smoothVx += (velocityX - state.smoothVx) * follow;
  state.smoothVz += (velocityZ - state.smoothVz) * follow;
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  const forward = accelX * sin + accelZ * cos, right = -accelX * cos + accelZ * sin;
  const pitchGoal = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, (forward >= 0 ? forward : forward * BRAKE_PITCH_SCALE) * PITCH_GAIN));
  const rollGoal = Math.max(-MAX_ROLL, Math.min(MAX_ROLL, right * ROLL_GAIN));
  for (let left = dt; left > 1e-9;) {
    const step = left < LEAN_STEP ? left : LEAN_STEP;
    left -= step;
    state.pitchVelocity += ((pitchGoal - state.pitch) * LEAN_OMEGA * LEAN_OMEGA - 2 * LEAN_ZETA * LEAN_OMEGA * state.pitchVelocity) * step;
    state.rollVelocity += ((rollGoal - state.roll) * LEAN_OMEGA * LEAN_OMEGA - 2 * LEAN_ZETA * LEAN_OMEGA * state.rollVelocity) * step;
    state.pitch += state.pitchVelocity * step;
    state.roll += state.rollVelocity * step;
  }
  state.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, state.pitch));
  state.roll = Math.max(-MAX_ROLL, Math.min(MAX_ROLL, state.roll));
  // Come to rest exactly: a settled lean (no goal, no motion) is upright, never a residual hair of an angle.
  if (Math.abs(state.pitch) < 1e-5 && Math.abs(state.pitchVelocity) < 1e-4) { state.pitch = 0; state.pitchVelocity = 0; }
  if (Math.abs(state.roll) < 1e-5 && Math.abs(state.rollVelocity) < 1e-4) { state.roll = 0; state.rollVelocity = 0; }
}
