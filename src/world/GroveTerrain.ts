import { fbm, smoothstep } from './GroundNoise';

/**
 * Pure relief of the Grove meadow (no three.js): the low mound the young Heartroot rises on and two soft swells of meadow far
 * behind the route (west and north, never in front of the fixed camera). Every feature stands well away from every walkable
 * (the mound's foot is 8 m from the nearest edge, the swells start 10 m beyond it), so the walk-mesh keeps its exact height.
 */
export const HEARTROOT_MOUND = { x: -2, z: -13, radius: 5.5, height: 0.7 } as const;

const SEED = 4417;

/** Smooth bump: `height` at the centre, exactly 0 (with zero slope) at `radius`. */
function mound(x: number, z: number): number {
  const distance = Math.hypot(x - HEARTROOT_MOUND.x, z - HEARTROOT_MOUND.z);
  return HEARTROOT_MOUND.height * (1 - smoothstep(HEARTROOT_MOUND.radius * 0.15, HEARTROOT_MOUND.radius, distance));
}

/** Gentle far relief added to open ground: the mound, a 2.6 m meadow swell west of the camp and a 3 m one north of the overlook. */
export function groveBackdrop(x: number, z: number): number {
  const west = smoothstep(-44, -62, x);
  const north = smoothstep(-58, -74, z);
  const swells = 2.6 * west + 3 * north * (1 - west);
  const rough = swells > 0 ? swells * 0.12 * fbm(x / 9, z / 9, SEED, 2) : 0;
  return mound(x, z) + swells + rough;
}
