import { channelSurface } from './GroundCarveShape';
import { smoothstep } from './GroundNoise';

/**
 * Pure geometry of the Greenwake creek gully (no three.js): the terrain carves it, the splat mask paints its banks
 * and bed, the creek water strip follows its centreline, and the boundary dressing places rocks along its banks.
 *
 * The gully runs roughly north–south (along +z) between the earthen ridge (x ≤ 13.5) and the grove gateway ramp
 * (x ≥ 17), under the rope bridge. Its surface is a profile across the centreline: a bed about 0.2 m deep in water,
 * then a concave bank that reaches the walkable rim height (+2.05 m over the bed) exactly where the walk surfaces'
 * edges stand, so the carve never has to undercut a walkable footprint.
 */
export const CREEK_WATER_Y = -1.1;
export const CREEK_BED_Y = -1.3;
/** Water strip extent along z; the strip fades to nothing at both ends. */
export const CREEK_Z_START = 9.5;
export const CREEK_Z_END = 33;
/** The carved gully runs out into ordinary ground between these z values (the bed climbs above any relief well before the far one). */
const GULLY_Z_START = 8.5;
const GULLY_Z_END = 40;
/** Height of the bank rim above the bed: the ridge / gateway top (y = 2) plus a 5 cm margin. */
const RIM_HEIGHT = 3.35;
const CENTER_X = 15.25;
/** Bed rises this far above its deepest level at the head and at the very end of the tail, so the gully runs out into ordinary ground. */
const END_RISE = 4.6;
/** Downstream the bed climbs gently by this much between z = 23 and z = 35 (a shallowing creek, not a pit), then vanishes. */
const TAIL_RISE = 1.2;
/** Water stands this deep over the thalweg: the strip lies at `bed + CREEK_WATER_DEPTH` (−1.1 over the bridge reach). */
export const CREEK_WATER_DEPTH = 0.2;
/** The water surface never rises above this height: the surrounding relief is never lower than −0.3 m, so the strip is always below the land. */
const MAX_WATER_Y = -0.4;

export interface CreekSection {
  centerX: number;
  /** 0 at the head / tail (no gully), 1 over the bridge reach. */
  fade: number;
  bed: number;
  bedHalfWidth: number;
  /** Lateral distance at which the bank profile reaches the rim height. */
  rimHalfWidth: number;
}

const scratch: CreekSection = { centerX: 0, fade: 0, bed: 0, bedHalfWidth: 0, rimHalfWidth: 0 };

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Creek cross-section parameters at `z` (written into `out`, which defaults to a shared scratch object). */
export function creekSection(z: number, out: CreekSection = scratch): CreekSection {
  // Head meanders east only (the ramp's east edge stands at x = 13), tail drifts west only (the gateway's west edge at x = 17).
  const head = 1 - smoothstep(11.5, 14, z);
  const tail = smoothstep(23, 26, z);
  out.centerX = CENTER_X + head * 0.7 * (0.5 + 0.5 * Math.sin(0.6 * (z - 9))) - tail * 1.3 * (0.5 + 0.5 * Math.sin(0.38 * (z - 23) + 0.5));
  out.fade = smoothstep(9.2, 14, z) * (1 - smoothstep(34, 40, z));
  out.bed = CREEK_BED_Y + END_RISE * (1 - smoothstep(9.2, 14, z)) + TAIL_RISE * smoothstep(23, 35, z) + END_RISE * smoothstep(33, 40, z);
  const bridgeReach = smoothstep(13, 14.5, z) * (1 - smoothstep(22.5, 25, z));
  out.bedHalfWidth = lerp(0.95, 0.5, bridgeReach);
  out.rimHalfWidth = z < 14 ? lerp(2.25, 1.75, smoothstep(12.5, 14, z)) : lerp(1.75, 4.6, smoothstep(22.5, 30, z));
  return out;
}

/** Height of the water surface at z: `bed + CREEK_WATER_DEPTH` (−1.1 m under the bridge), clamped below the ground where the bed climbs out of the gully. */
export function creekWaterLevel(z: number): number {
  return Math.min(creekSection(z).bed + CREEK_WATER_DEPTH, MAX_WATER_Y);
}

/** Gully surface height at (x, z): far above any ground outside the creek's reach, so the carve is `min(ground, creek)`. */
export function creekSurfaceHeight(x: number, z: number): number {
  if (z < GULLY_Z_START || z > GULLY_Z_END) return 100;
  const section = creekSection(z);
  return channelSurface(Math.abs(x - section.centerX), section.bed, section.bedHalfWidth, section.rimHalfWidth, RIM_HEIGHT);
}

/** True when (x, z) lies inside the band the gully can reshape; used to refine the terrain mesh there. */
export function insideCreekBand(x: number, z: number, margin = 0): boolean {
  if (z < GULLY_Z_START - margin || z > GULLY_Z_END + margin) return false;
  const section = creekSection(z);
  return Math.abs(x - section.centerX) <= section.rimHalfWidth + 1.6 + margin;
}

/** 1 in the gully bed and lower banks, fading to 0 at the rim; 0 outside the creek's length. */
export function gullyMembership(x: number, z: number): number {
  if (z < GULLY_Z_START || z > GULLY_Z_END) return 0;
  const section = creekSection(z);
  const lateral = Math.abs(x - section.centerX);
  return (1 - smoothstep(section.rimHalfWidth * 0.7, section.rimHalfWidth * 1.35, lateral)) * smoothstep(0.15, 0.55, section.fade);
}

/** 1 on the bed and the lower banks within about a metre of the water, fading to 0 two metres from it: where the ground is wet mud. */
export function creekWetness(x: number, z: number): number {
  if (z < GULLY_Z_START || z > GULLY_Z_END) return 0;
  const section = creekSection(z);
  const lateral = Math.abs(x - section.centerX);
  return (1 - smoothstep(section.bedHalfWidth + 0.9, section.bedHalfWidth + 2, lateral)) * smoothstep(0.15, 0.55, section.fade);
}
