import type { ActorId, PlayerProjectileSnapshot, Vec3 } from '../contracts.js';

/** Serializable live state of Aren's Warden Arsenal; every tick field is on the simulation clock unless noted. */
export interface LivePlayerProjectile {
  id: string;
  kind: PlayerProjectileSnapshot['kind'];
  ownerId: ActorId;
  position: Vec3;
  direction: Vec3;
  speed: number;
  /** Bolt radius, or the wave's half-width. */
  radius: number;
  /** World-clock ticks (fractional under slow motion). */
  ageTicks: number;
  lifeTicks: number;
  damage: number;
  targetId?: ActorId;
  hitIds: ActorId[];
  /** Clip id of the kit skill that fired it; cues use it instead of `kind` as their `actionId`. */
  actionId?: string;
  /** Hero-kit projectiles: the kit resolves each hit (`HeroKit.onProjectileHit`) and the end of flight (`onProjectileEnd`) under this id instead of the engine's default strike. */
  callbackId?: string;
  /** Lane projectile (the Crescent Wave is lane-shaped by kind): hits every hostile it sweeps through, `radius` is the half-width. Absent = single-hit bolt. */
  pierce?: boolean;
}
export interface LiveJudgementMark { id: string; position: Vec3; angleRadians: number; createdAtTick: number; detonateAtTick: number }
/** The light-combo swing currently inside its clip; cleared when its active window has passed. */
export interface PlayerSwing {
  step: 1 | 2 | 3 | 4; startedTick: number; hitIds: ActorId[]; counter: boolean; waveSpawned: boolean; slashed: boolean;
  /** Facing when the swing began; light_3's spin rotates relative to it. */
  baseFacing: Vec3;
}
export interface PlayerCast {
  kind: 'bolt' | 'barrage' | 'judgement' | 'root-spike' | 'root-eruption' | 'heartroot-bloom';
  position?: Vec3;
  startedTick: number;
  /** Bolts launched so far (barrage) or marks placed so far (judgement). */
  progress: number;
  /** Judgement only: the dash path fixed at the start of the dash. */
  dash?: { from: Vec3; direction: Vec3; distance: number };
  /** Judgement only: cues emitted so far (0 anticipation, 1 commit, 2 resolve). */
  stage: number;
}
export interface PendingLightning { atTick: number; position: Vec3 }
export interface HitStopState { remainingTicks: number; strength: number }
/** Release edges that arrived while the world was frozen; applied to the first live tick so no charge gets stuck. */
export interface DeferredRelease { heavy?: boolean; ranged?: boolean }

export function rotateY(v: Vec3, angle: number): Vec3 {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return { x: v.x * cos + v.z * sin, y: v.y, z: -v.x * sin + v.z * cos };
}

/** Unit vector from `direction` turned towards `desired` by at most `maxAngle` radians. */
export function turnTowards(direction: Vec3, desired: Vec3, maxAngle: number): Vec3 {
  const dot = Math.max(-1, Math.min(1, direction.x * desired.x + direction.y * desired.y + direction.z * desired.z));
  const angle = Math.acos(dot);
  if (angle <= maxAngle || angle < 1e-6) return desired;
  // Rotate within the plane spanned by both vectors: result = d·cos(t) + p·sin(t), p ⟂ d towards `desired`.
  let px = desired.x - direction.x * dot, py = desired.y - direction.y * dot, pz = desired.z - direction.z * dot;
  const length = Math.hypot(px, py, pz);
  if (length < 1e-9) return direction;
  px /= length; py /= length; pz /= length;
  const cos = Math.cos(maxAngle), sin = Math.sin(maxAngle);
  return { x: direction.x * cos + px * sin, y: direction.y * cos + py * sin, z: direction.z * cos + pz * sin };
}

/** Shortest XZ distance from `point` to the segment a→b, and how far along it (0..1) the closest point lies. */
export function segmentDistanceXZ(a: Vec3, b: Vec3, point: Vec3): { distance: number; t: number } {
  const dx = b.x - a.x, dz = b.z - a.z, lengthSquared = dx * dx + dz * dz;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSquared));
  return { distance: Math.hypot(point.x - (a.x + dx * t), point.z - (a.z + dz * t)), t };
}

export function yawOf(v: Vec3): number { return Math.atan2(v.x, v.z); }
