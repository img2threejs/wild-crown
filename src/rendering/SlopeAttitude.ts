import type { GroundHeightFn } from './FootGrounding';

/** Largest pitch / roll (rad) a creature body follows the ground by, and the follow rate (1/s). */
export const MAX_SLOPE_TILT = 0.3;
const SLOPE_RATE = 8;
/** Tilts below this (rad) are noise: the body stays exactly level on flat ground. */
const DEAD_ZONE = 0.01;

/** Body attitude of a four-legged creature standing on a slope, in the YXZ Euler convention of the actor root (+pitch = nose down, +roll = toward the right hand). */
export interface SlopeAttitudeState { pitch: number; roll: number }

export function createSlopeAttitude(): SlopeAttitudeState { return { pitch: 0, roll: 0 }; }

/**
 * Target pitch and roll of a creature whose body is `halfLength` long and `halfWidth` wide (each side of its centre) at world (x, z), facing planar
 * (forwardX, forwardZ): the plane through the ground heights under its front, rear, left and right extents. A side without ground gives a level body.
 * The right-hand vector of a body facing (fx, fz) is (-fz, fx); pitch is negative when the ground rises ahead (nose up).
 */
export function slopeTarget(ground: GroundHeightFn, x: number, z: number, nearY: number, forwardX: number, forwardZ: number, halfLength: number, halfWidth: number, out: SlopeAttitudeState): void {
  const front = ground(x + forwardX * halfLength, z + forwardZ * halfLength, nearY), back = ground(x - forwardX * halfLength, z - forwardZ * halfLength, nearY);
  const right = ground(x - forwardZ * halfWidth, z + forwardX * halfWidth, nearY), left = ground(x + forwardZ * halfWidth, z - forwardX * halfWidth, nearY);
  out.pitch = front !== null && back !== null ? -Math.atan2(front - back, 2 * halfLength) : 0;
  out.roll = right !== null && left !== null ? -Math.atan2(right - left, 2 * halfWidth) : 0;
  out.pitch = Math.abs(out.pitch) < DEAD_ZONE ? 0 : Math.max(-MAX_SLOPE_TILT, Math.min(MAX_SLOPE_TILT, out.pitch));
  out.roll = Math.abs(out.roll) < DEAD_ZONE ? 0 : Math.max(-MAX_SLOPE_TILT, Math.min(MAX_SLOPE_TILT, out.roll));
}

/** Eases the drawn attitude toward the target; `enabled` false (airborne, hovering, reacting) returns it to level at the same rate. */
export function settleSlopeAttitude(state: SlopeAttitudeState, target: SlopeAttitudeState, dt: number, enabled: boolean): void {
  if (dt <= 0) return;
  const follow = 1 - Math.exp(-SLOPE_RATE * dt);
  state.pitch += ((enabled ? target.pitch : 0) - state.pitch) * follow;
  state.roll += ((enabled ? target.roll : 0) - state.roll) * follow;
  if (Math.abs(state.pitch) < 1e-4) state.pitch = 0;
  if (Math.abs(state.roll) < 1e-4) state.roll = 0;
}
