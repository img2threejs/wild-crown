import type { CompanionId, Vec3 } from '../contracts.js';

/** One committed lunge; simulation owns its sweep, preview samples the identical path. */
export interface CompanionSkillMotion {
  readonly from: Vec3;
  readonly to: Vec3;
  readonly sideX: number;
  readonly sideZ: number;
  readonly flank: number;
  readonly height: number;
  readonly release: number;
  readonly contact: number;
  readonly ground: { x: number; y: number; z: number };
  blocked: boolean;
}

const clamp01 = (t: number): number => Math.max(0, Math.min(1, t));
const ease = (t: number): number => { const u = clamp01(t); return u * u * (3 - 2 * u); };

export function createCompanionSkillMotion(id: CompanionId, from: Vec3, target: Vec3, clearance: number, release: number, contact: number): CompanionSkillMotion | undefined {
  if (id !== 'asha' && id !== 'sable' && id !== 'nyra') return undefined;
  const dx = target.x - from.x, dz = target.z - from.z, distance = Math.hypot(dx, dz);
  // In-contact gestures have zero travel/lift, but still retain live body separation in simulation.
  const fx = distance > 0 ? dx / distance : 0, fz = distance > 0 ? dz / distance : 0;
  const travel = Math.max(0, Math.min(2.8, distance - clearance));
  return {
    from: { ...from }, to: { x: from.x + fx * travel, y: from.y, z: from.z + fz * travel },
    sideX: fz, sideZ: -fx, flank: id === 'sable' ? Math.min(.8, travel * .55) : 0,
    height: travel === 0 ? 0 : id === 'nyra' ? .6 : id === 'sable' ? .3 : .15,
    release, contact, ground: { ...from }, blocked: false,
  };
}

/** Writes absolute X/Z and vertical lift above the swept ground; no per-frame allocation. */
export function sampleCompanionSkillMotion(motion: CompanionSkillMotion, progress: number, out: { x: number; y: number; z: number }): void {
  const launch = clamp01((progress - motion.release) / (motion.contact - motion.release));
  const anticipation = ease((progress - .08) / (motion.release - .08));
  const travel = progress < motion.release ? .12 * anticipation : .12 + .88 * ease(launch);
  const side = motion.flank * (progress < motion.release ? anticipation : 1 - ease(launch));
  out.x = motion.from.x + (motion.to.x - motion.from.x) * travel + motion.sideX * side;
  out.z = motion.from.z + (motion.to.z - motion.from.z) * travel + motion.sideZ * side;
  out.y = Math.sin(Math.PI * launch) * motion.height;
}
