import type { AttackDefinition } from './content.js';
import { GROVE_MONSTER_PROFILES } from './GroveContent.js';
import { MISTVEIL_MONSTER_PROFILES } from './MistveilContent.js';
import { MOONPINE_MONSTER_PROFILES } from './MoonpineContent.js';

export interface WildlifePressureTier {
  readonly tier: number;
  readonly engagedTicks: number;
  readonly cadenceTicks: number;
  readonly timingScale: number;
  readonly maxConcurrent: number;
  /** Trial monsters only: world ticks the monster repositions after an attack's recovery before the next cast. */
  readonly repositionTicks: number;
  /** Trial monsters only: every Nth cast is a two-attack chain (0 = never chains). */
  readonly chainEvery: number;
}

const TIERS: readonly WildlifePressureTier[] = [
  { tier: 0, engagedTicks: 0, cadenceTicks: 48, timingScale: 1, maxConcurrent: 2, repositionTicks: 70, chainEvery: 0 },
  { tier: 1, engagedTicks: 900, cadenceTicks: 40, timingScale: 0.9, maxConcurrent: 2, repositionTicks: 52, chainEvery: 3 },
  { tier: 2, engagedTicks: 1800, cadenceTicks: 33, timingScale: 0.78, maxConcurrent: 3, repositionTicks: 38, chainEvery: 2 },
  { tier: 3, engagedTicks: 3000, cadenceTicks: 27, timingScale: 0.66, maxConcurrent: 3, repositionTicks: 26, chainEvery: 2 },
];

const WINDUP_FLOOR = 24;
const COMMIT_FLOOR = 8;


export function getWildlifePressure(engagedWorldTicks: number): WildlifePressureTier {
  if (engagedWorldTicks < TIERS[1]!.engagedTicks) return TIERS[0]!;
  if (engagedWorldTicks < TIERS[2]!.engagedTicks) return TIERS[1]!;
  if (engagedWorldTicks < TIERS[3]!.engagedTicks) return TIERS[2]!;
  return TIERS[3]!;
}

export function scaleWildlifeAttack(def: AttackDefinition, pressure: WildlifePressureTier): AttackDefinition {
  const scale = pressure.timingScale;
  const scaledWindup = Math.max(WINDUP_FLOOR, Math.round(def.windupTicks * scale));
  const scaledCommit = Math.max(COMMIT_FLOOR, def.commitTicks);
  const scaledRecovery = Math.round(def.recoveryTicks * scale);
  if (scaledWindup === def.windupTicks && scaledCommit === def.commitTicks && scaledRecovery === def.recoveryTicks) return def;
  return { ...def, windupTicks: scaledWindup, commitTicks: scaledCommit, recoveryTicks: scaledRecovery };
}

// ---------------------------------------------------------------------------------------------
// Trial-monster locomotion. Simulation-only: the engine integrates the steering decision below with
// its own collision sweep, so nothing here reads or writes world state.
// ---------------------------------------------------------------------------------------------

/** Player distance (m) at which the current trial monster engages / loses interest. */
export const TRIAL_ENGAGE_RANGE = 14;
export const TRIAL_DISENGAGE_RANGE = 16;
/** Roar pause (world ticks, ~0.7 s): no locomotion, no casting, no damage. */
export const ROAR_TICKS = 42;
/** A monster only starts a cast once its body points within this many radians of the player. */
export const CAST_FACING_TOLERANCE = 0.42;
/** Upper bound (rad/s) on how fast a monster may swing to its committed attack direction between windup and the first active tick. */
export const ATTACK_TURN_RATE_MAX = 12;
/** Beyond this heading error (rad) the monster pivots in place instead of walking. */
const TURN_IN_PLACE_ANGLE = 1.5;
/** A cast is only started within `bandMax + CAST_RANGE_MARGIN` metres of the player (always < TRIAL_ENGAGE_RANGE). */
export const CAST_RANGE_MARGIN = 2.5;
const EDGE_MARGIN = 3;
export const STUCK_TICKS = 20;

/** Speeds in m/s, yaw rate in rad/s, ranges in metres from the player. */
export interface MonsterProfile {
  readonly radius: number;
  readonly bandMin: number;
  readonly bandMax: number;
  readonly advanceSpeed: number;
  readonly circleSpeed: number;
  readonly retreatSpeed: number;
  readonly yawRate: number;
  /** Min/max world ticks between strafe-direction decisions. */
  readonly strafeTicks: readonly [number, number];
}

export const MONSTER_PROFILES: Readonly<Record<string, MonsterProfile>> = {
  // Aggressive: holds 5–8 m, long steady strafes, quick to close.
  'corrupted-boar': { radius: 1.05, bandMin: 5, bandMax: 8, advanceSpeed: 4.2, circleSpeed: 2.8, retreatSpeed: 3.4, yawRate: 3.5, strafeTicks: [120, 210] },
  // Flanker: tighter 4–7 m band, fast and erratic circling.
  'greenwake-sap-stalker': { radius: 0.9, bandMin: 4, bandMax: 7, advanceSpeed: 4.6, circleSpeed: 3.6, retreatSpeed: 3.8, yawRate: 4.5, strafeTicks: [70, 150] },
  // Heavy: wide 6–9 m band, slow and ponderous turns.
  'greenwake-root-rammer': { radius: 1.2, bandMin: 6, bandMax: 9, advanceSpeed: 2.4, circleSpeed: 1.6, retreatSpeed: 2, yawRate: 2.6, strafeTicks: [180, 300] },
  // Whispering Canopy. Flanker: tight 4–7 m band, quick and erratic.
  'canopy-howler': { radius: 0.75, bandMin: 4, bandMax: 7, advanceSpeed: 4.8, circleSpeed: 4.0, retreatSpeed: 4.2, yawRate: 5.0, strafeTicks: [60, 130] },
  // Ranged: holds 6–10 m and circles in wide, committed arcs (drawn hovering above this ground body).
  'canopy-hornbill': { radius: 0.9, bandMin: 6, bandMax: 10, advanceSpeed: 5.2, circleSpeed: 4.4, retreatSpeed: 4.8, yawRate: 4.0, strafeTicks: [90, 180] },
  // Controller: slow, heavy 3.5–6 m band with long strafes.
  'canopy-mire-viper': { radius: 1.0, bandMin: 3.5, bandMax: 6, advanceSpeed: 2.6, circleSpeed: 1.9, retreatSpeed: 2.2, yawRate: 2.4, strafeTicks: [150, 260] },
  ...GROVE_MONSTER_PROFILES, ...MOONPINE_MONSTER_PROFILES, ...MISTVEIL_MONSTER_PROFILES,
};

export interface MonsterLunge {
  readonly hazardId: string;
  readonly kind: 'charge' | 'step';
  readonly dirX: number;
  readonly dirZ: number;
  /** Total metres to cover between `fromTick` and `toTick` (world ticks). */
  readonly travel: number;
  readonly fromTick: number;
  readonly toTick: number;
  done: number;
  landed: boolean;
}

/** Serializable locomotion state carried on a trial monster (world-tick clock). */
export interface MonsterMotionState {
  engaged: boolean;
  /** +1 / -1 circling direction. */
  strafe: 1 | -1;
  strafeUntil: number;
  roarUntil: number;
  roarFrom: number;
  /** Highest pressure tier already announced by an engage/escalation roar. */
  roarTier: number;
  /** Signed rad/s of the last integrated step (positive = increasing atan2(x, z)). */
  yawRate: number;
  seed: number;
  blockedTicks: number;
  nextCastAt: number;
  lunge?: MonsterLunge;
}

export function createMonsterMotion(seed: number): MonsterMotionState {
  return { engaged: false, strafe: 1, strafeUntil: 0, roarUntil: 0, roarFrom: 0, roarTier: 0, yawRate: 0, seed: seed >>> 0 || 1, blockedTicks: 0, nextCastAt: 0 };
}

export function wrapAngle(angle: number): number {
  let wrapped = angle % (2 * Math.PI);
  if (wrapped > Math.PI) wrapped -= 2 * Math.PI;
  else if (wrapped < -Math.PI) wrapped += 2 * Math.PI;
  return wrapped;
}

function nextRandom(motion: MonsterMotionState): number {
  motion.seed = (Math.imul(motion.seed, 1664525) + 1013904223) >>> 0;
  return motion.seed / 4294967296;
}

export interface MonsterSteerInput {
  /** Horizontal distance to the player and the heading (atan2(x, z)) towards them. */
  readonly distance: number;
  readonly toPlayer: number;
  /** Offset of the monster from its arena centre. */
  readonly fromCenterX: number;
  readonly fromCenterZ: number;
  readonly arenaRadius: number;
  /** True while a cast is due: square up to the player instead of strafing. */
  readonly squareUp: boolean;
  readonly worldTick: number;
  /** The previous integrated step made less than a third of its intended progress. */
  readonly blocked: boolean;
}

export interface MonsterSteer { readonly heading: number; readonly speed: number }

const steered = { heading: 0, speed: 0 };

/**
 * Chooses the desired heading and speed (m/s) for an engaged, free-moving monster: approach when
 * far, retreat when crowded, otherwise circle with a radial correction towards the band centre.
 * The returned object is a shared scratch value valid until the next call.
 */
export function steerMonster(profile: MonsterProfile, motion: MonsterMotionState, input: MonsterSteerInput): MonsterSteer {
  if (input.worldTick >= motion.strafeUntil || input.blocked) {
    if (input.blocked || nextRandom(motion) < 0.5) motion.strafe = motion.strafe === 1 ? -1 : 1;
    motion.strafeUntil = input.worldTick + profile.strafeTicks[0] + nextRandom(motion) * (profile.strafeTicks[1] - profile.strafeTicks[0]);
  }
  const { distance, toPlayer } = input;
  const mid = (profile.bandMin + profile.bandMax) / 2, half = (profile.bandMax - profile.bandMin) / 2;
  let heading = toPlayer, speed: number;
  if (distance > profile.bandMax) speed = profile.advanceSpeed;
  else if (distance < profile.bandMin && !(input.squareUp && distance >= profile.bandMin * 0.5)) { heading = toPlayer + Math.PI - motion.strafe * 0.5; speed = profile.retreatSpeed; }
  else if (input.squareUp) speed = 0;
  else {
    const radial = Math.max(-1, Math.min(1, (distance - mid) / half));
    heading = toPlayer + motion.strafe * (Math.PI / 2 - radial * Math.PI / 4);
    speed = profile.circleSpeed;
  }
  // Blend towards the arena centre near its rim so the monster never pins itself against the edge.
  const fromCenter = Math.hypot(input.fromCenterX, input.fromCenterZ);
  const inner = input.arenaRadius - EDGE_MARGIN - profile.radius;
  if (fromCenter > inner && speed > 0) {
    const weight = Math.min(1, (fromCenter - inner) / EDGE_MARGIN);
    const x = Math.sin(heading) * (1 - weight) - input.fromCenterX / fromCenter * weight;
    const z = Math.cos(heading) * (1 - weight) - input.fromCenterZ / fromCenter * weight;
    if (x !== 0 || z !== 0) heading = Math.atan2(x, z);
  }
  steered.heading = heading;
  steered.speed = speed;
  return steered;
}

/** Fraction of `speed` available at the remaining heading error: zero past the pivot angle. */
export function turnTranslationScale(remainingError: number): number {
  return Math.max(0, Math.min(1, 1 - Math.abs(remainingError) / TURN_IN_PLACE_ANGLE));
}

/**
 * Limits a planned step so the monster ends inside its arena circle. A monster that already sits
 * outside the circle (provisional layouts) may only move towards the centre. Writes the permitted
 * step into `out` and returns it.
 */
export function clampStepToArena(x: number, z: number, dx: number, dz: number, cx: number, cz: number, radius: number, out: { dx: number; dz: number }): { dx: number; dz: number } {
  const nx = x + dx - cx, nz = z + dz - cz;
  const end = Math.hypot(nx, nz), current = Math.hypot(x - cx, z - cz);
  out.dx = dx; out.dz = dz;
  if (end <= radius) return out;
  if (current > radius) {
    if (end >= current) { out.dx = 0; out.dz = 0; }
    return out;
  }
  const scale = radius / end;
  out.dx = cx + nx * scale - x;
  out.dz = cz + nz * scale - z;
  return out;
}
