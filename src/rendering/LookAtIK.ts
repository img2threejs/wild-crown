import { Vector3, type Object3D } from 'three';
import { rotateBoneWorld } from './RigBones';

/** Clamp and weights of one look-at rig kind. `weights` are the shares of the head turn each bone carries, base first (sum 1). */
export interface LookAtSpec {
  readonly yawLimit: number;
  readonly pitchLimit: number;
  /** Past this angle to the target the gaze returns to neutral instead of whipping around (rad). */
  readonly behindFrom: number;
  readonly weights: readonly number[];
}

const DEG = Math.PI / 180;
/** Biped: Spine, Spine1, Spine2, Neck, Head. The head leads; the torso follows a little. */
export const BIPED_LOOK_AT: LookAtSpec = { yawLimit: 55 * DEG, pitchLimit: 28 * DEG, behindFrom: 100 * DEG, weights: [0.08, 0.12, 0.18, 0.27, 0.35] };
/** Creature: the head chain (Head_0..n) only, tighter limits (a boar does not look over its shoulder). */
export const CREATURE_LOOK_AT: LookAtSpec = { yawLimit: 38 * DEG, pitchLimit: 16 * DEG, behindFrom: 90 * DEG, weights: [] };

/** Per-second rates of the gaze: the angles follow the target, the weight fades in slowly and out fast (a reaction or an attack cancels it). */
const ANGLE_RATE = 9, WEIGHT_IN_RATE = 4, WEIGHT_OUT_RATE = 12;

const upAxis = new Vector3(0, 1, 0), rightAxis = new Vector3();

const clampSigned = (value: number, limit: number): number => value > limit ? limit : value < -limit ? -limit : value;
const smoothstep = (edge0: number, edge1: number, x: number): number => { const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0))); return t * t * (3 - 2 * t); };

/**
 * Yaw (rad, about +Y, counter-clockwise seen from above: a body facing +Z turns toward +X, its left) and pitch (positive = up) from an
 * eye point toward a target, relative to the planar `forward` (fx, fz) of the body. Writes the raw angles; callers clamp.
 */
export function lookAngles(eyeX: number, eyeY: number, eyeZ: number, fx: number, fz: number, targetX: number, targetY: number, targetZ: number, out: { yaw: number; pitch: number }): void {
  const dx = targetX - eyeX, dy = targetY - eyeY, dz = targetZ - eyeZ;
  const planar = Math.hypot(dx, dz);
  if (planar < 1e-4) { out.yaw = 0; out.pitch = dy > 0 ? Math.PI / 2 : dy < 0 ? -Math.PI / 2 : 0; return; }
  out.yaw = Math.atan2(dx * fz - dz * fx, dx * fx + dz * fz);
  out.pitch = Math.atan2(dy, planar);
}

/** Clamps raw angles to the spec and fades a target behind the body back to neutral. */
export function clampLookAngles(spec: LookAtSpec, angles: { yaw: number; pitch: number }): void {
  const behind = 1 - smoothstep(spec.behindFrom, spec.behindFrom + 40 * DEG, Math.abs(angles.yaw));
  angles.yaw = clampSigned(angles.yaw, spec.yawLimit) * behind;
  angles.pitch = clampSigned(angles.pitch, spec.pitchLimit) * behind;
}

const scratch = { yaw: 0, pitch: 0 };

/**
 * Head / spine look-at toward a world point: the angles are clamped, smoothed, and spread over the bones of the chain by their shares.
 * Rotations are applied in world axes on top of the clip pose (the caller restores the clip before each mixer evaluation).
 */
export class LookAtIK {
  private yaw = 0;
  private pitch = 0;
  private weight = 0;
  private readonly shares: number[];

  /** `bones` base first, the last one is the head (its position is the eye). `spec.weights` must match the bones; creatures pass an even split. */
  constructor(private readonly bones: readonly Object3D[], private readonly spec: LookAtSpec) {
    this.shares = bones.length === spec.weights.length ? [...spec.weights] : bones.map(() => 1 / bones.length);
  }

  /** Smoothed gaze strength 0..1 (tests, `enabled` fade). */
  get strength(): number { return this.weight; }
  get currentYaw(): number { return this.yaw; }
  get currentPitch(): number { return this.pitch; }

  reset(): void { this.yaw = 0; this.pitch = 0; this.weight = 0; }

  /**
   * `forwardX/Z` is the planar forward of the body in world space; `hasTarget` false (or `enabled` false) fades the gaze out and back to neutral.
   * Returns true when any bone was rotated (the caller then owns restoring the clip).
   */
  apply(dt: number, enabled: boolean, hasTarget: boolean, forwardX: number, forwardZ: number, targetX: number, targetY: number, targetZ: number): boolean {
    const bones = this.bones, head = bones[bones.length - 1];
    if (!head) return false;
    const wanted = enabled && hasTarget;
    if (dt > 0) this.weight += (wanted ? 1 - this.weight : -this.weight) * (1 - Math.exp(-(wanted ? WEIGHT_IN_RATE : WEIGHT_OUT_RATE) * dt));
    if (this.weight < 1e-3 && !wanted) { this.weight = 0; this.yaw = 0; this.pitch = 0; return false; }
    head.updateWorldMatrix(true, false);
    if (wanted) {
      const e = head.matrixWorld.elements;
      lookAngles(e[12]!, e[13]!, e[14]!, forwardX, forwardZ, targetX, targetY, targetZ, scratch);
      clampLookAngles(this.spec, scratch);
      const follow = dt > 0 ? 1 - Math.exp(-ANGLE_RATE * dt) : 0;
      this.yaw += (scratch.yaw - this.yaw) * follow;
      this.pitch += (scratch.pitch - this.pitch) * follow;
    }
    const yaw = this.yaw * this.weight, pitch = this.pitch * this.weight;
    if (Math.abs(yaw) < 1e-5 && Math.abs(pitch) < 1e-5) return false;
    rightAxis.set(-forwardZ, 0, forwardX);
    for (let i = 0; i < bones.length; i += 1) {
      const bone = bones[i]!, share = this.shares[i]!;
      // The previous bone refreshed its own world matrix; only the first bone (or a gap in the chain) needs its ancestors brought up to date.
      if (i === 0 || bone.parent !== bones[i - 1]) bone.parent?.updateWorldMatrix(true, false);
      rotateBoneWorld(bone, upAxis, yaw * share);
      rotateBoneWorld(bone, rightAxis, pitch * share);
    }
    return true;
  }
}
