import { Quaternion, Vector3, type Object3D } from 'three';
import { BODY_RADII, BODY_REFERENCE_CHAIN, BODY_TOLERANCE as TOLERANCE } from './BodyVolumes.mjs';
import { rotateBoneWorld } from './RigBones';

export { BODY_RADII, BODY_REFERENCE_CHAIN };

/** One side of a Mixamo biped: the arm chain and the leg chain it must keep clear of. */
export interface LimbSide { readonly arm: Object3D; readonly foreArm: Object3D; readonly hand: Object3D; readonly upLeg: Object3D; readonly leg: Object3D; readonly foot: Object3D }
export interface BipedLimbs { readonly hips: Object3D; readonly spine1: Object3D; readonly neck: Object3D; readonly head: Object3D; readonly left: LimbSide; readonly right: LimbSide }

/** Largest total rotation a solve may add to a bone relative to the clip pose (radians). */
const MAX_SHOULDER = 0.9, MAX_ELBOW = 1.2;
/** Damping of the least-squares step (m²): bounds the rotation of a nearly degenerate lever. */
const DAMPING = 0.012;
const ITERATIONS = 3;
/** The correction relaxes toward each new solution at this rate (1/s) and by at most `MAX_STEP` radians per call: a deep, ambiguous overlap is never resolved in one pop. */
const FILTER_RATE = 28, MAX_STEP = 0.3;

interface Capsule { ax: number; ay: number; az: number; bx: number; by: number; bz: number; radius: number }
interface Sample { x: number; y: number; z: number; r: number }

const pivot = new Vector3(), tip = new Vector3(), lever = new Vector3(), push = new Vector3(), torque = new Vector3(), side = new Vector3(), omega = new Vector3(), hold = new Vector3();
const near = { x: 0, y: 0, z: 0 };
const target = new Quaternion(), delta = new Quaternion();

function closestOnCapsule(c: Capsule, x: number, y: number, z: number): number {
  const abx = c.bx - c.ax, aby = c.by - c.ay, abz = c.bz - c.az;
  const length2 = abx * abx + aby * aby + abz * abz;
  const t = length2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((x - c.ax) * abx + (y - c.ay) * aby + (z - c.az) * abz) / length2));
  near.x = c.ax + abx * t; near.y = c.ay + aby * t; near.z = c.az + abz * t;
  return Math.hypot(x - near.x, y - near.y, z - near.z);
}

/**
 * Keeps a biped's arms out of its own torso, head and legs after the clip pose (and any posture bend) has been evaluated. Sample points along
 * each arm are tested against capsules of the body; the elbow and then the shoulder take the damped least-squares rotation that carries every
 * penetrating sample out together (not just the deepest, so the result moves continuously as samples enter and leave). Zero penetration means zero
 * change, and the total rotation per bone is bounded. It rotates the bones the clip already animates, so skinning, sockets, weapon grips and
 * VFX anchors follow. Presentation only.
 */
export class LimbClearance {
  private readonly capsules: Capsule[] = [];
  private readonly samples: Sample[] = [];
  private readonly lateral = new Vector3(0, 0, 1);
  private readonly clip = new Map<Object3D, Quaternion>();
  /** Filtered correction (clip pose → drawn pose) of each arm bone, in the bone's local frame. */
  private readonly filtered = new Map<Object3D, Quaternion>();
  private unit = 1;
  /** Largest rotation (radians) the last `apply` added to any bone: instrumentation for tests and tuning. */
  lastCorrection = 0;

  constructor(private readonly limbs: BipedLimbs) {
    for (const s of [limbs.left, limbs.right]) for (const bone of [s.arm, s.foreArm]) { this.clip.set(bone, new Quaternion()); this.filtered.set(bone, new Quaternion()); }
  }

  /** Forgets the filtered correction (the actor was hidden, teleported or its clip changed discontinuously). */
  reset(): void { for (const q of this.filtered.values()) q.identity(); }

  /**
   * World matrices of every bone must be current. `dt` > 0 filters the correction over time (continuous playback); 0 solves each pose on its
   * own (audits, tests). Returns true when any bone moved.
   */
  apply(dt = 0): boolean {
    const limbs = this.limbs;
    this.lastCorrection = 0;
    for (const [bone, q] of this.clip) q.copy(bone.quaternion);
    let moved = false;
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      this.measure();
      let changed = false;
      for (const arm of [limbs.left, limbs.right]) {
        const sign = arm === limbs.left ? 1 : -1;
        changed = this.solve(arm, arm.foreArm, MAX_ELBOW, sign, false) || changed;
        changed = this.solve(arm, arm.arm, MAX_SHOULDER, sign, true) || changed;
      }
      if (!changed) break;
      moved = true;
    }
    if (dt > 0) moved = this.filter(dt) || moved;
    return moved;
  }

  /** Relaxes each arm bone's correction toward the solved one; identity (nothing to correct) relaxes it back to the clip pose. */
  private filter(dt: number): boolean {
    const blend = 1 - Math.exp(-FILTER_RATE * dt);
    let active = false;
    for (const [bone, previous] of this.filtered) {
      const clip = this.clip.get(bone)!;
      delta.copy(clip).invert().multiply(bone.quaternion);
      const distance = previous.angleTo(delta);
      const step = distance > 1e-6 ? Math.min(blend, MAX_STEP / distance) : 1;
      previous.slerp(delta, step);
      if (previous.angleTo(target.identity()) < 1e-4) { previous.identity(); bone.quaternion.copy(clip); } else { bone.quaternion.copy(clip).multiply(previous); active = true; }
      bone.updateWorldMatrix(false, true);
    }
    return active;
  }

  /** Rebuilds the obstacle capsules from the current bone positions. */
  private measure(): void {
    const { hips, spine1, neck, head, left, right } = this.limbs, list = this.capsules;
    list.length = 0;
    const chain = pivot.setFromMatrixPosition(hips.matrixWorld).distanceTo(tip.setFromMatrixPosition(neck.matrixWorld));
    // The straight hips-to-neck distance shrinks when the spine bends; the bend is small enough (≤ 8%) for it to size the volumes.
    this.unit = Math.max(0.2, chain / (BODY_REFERENCE_CHAIN * 0.86));
    // Unit vector from the right shoulder to the left one: the direction in which each arm leaves the trunk.
    this.lateral.setFromMatrixPosition(left.arm.matrixWorld).sub(lever.setFromMatrixPosition(right.arm.matrixWorld)).normalize();
    const u = this.unit;
    const add = (a: Object3D, b: Object3D, radius: number, extend = 0): void => {
      pivot.setFromMatrixPosition(a.matrixWorld); tip.setFromMatrixPosition(b.matrixWorld);
      if (extend !== 0) { lever.subVectors(tip, pivot).normalize().multiplyScalar(extend * u); tip.add(lever); }
      list.push({ ax: pivot.x, ay: pivot.y, az: pivot.z, bx: tip.x, by: tip.y, bz: tip.z, radius: radius * u });
    };
    add(hips, spine1, BODY_RADII.pelvis);
    add(spine1, neck, BODY_RADII.chest);
    add(neck, head, BODY_RADII.head, 0.1);
    for (const s of [left, right]) { add(s.upLeg, s.leg, BODY_RADII.thigh); add(s.leg, s.foot, BODY_RADII.shin); }
  }

  /** Samples of one arm: `upper` = the whole arm (upper arm outside the shoulder socket, forearm, hand); otherwise the forearm and hand only. */
  private sample(arm: LimbSide, upper: boolean): number {
    const u = this.unit, list = this.samples;
    let count = 0;
    const put = (x: number, y: number, z: number, r: number): void => { const s = (list[count] ??= { x: 0, y: 0, z: 0, r: 0 }); s.x = x; s.y = y; s.z = z; s.r = r * u - TOLERANCE * u; count += 1; };
    const shoulder = pivot.setFromMatrixPosition(arm.arm.matrixWorld), elbow = tip.setFromMatrixPosition(arm.foreArm.matrixWorld);
    if (upper) for (let s = 0; s < 3; s += 1) { const t = 0.5 + 0.5 * (s / 2); put(shoulder.x + (elbow.x - shoulder.x) * t, shoulder.y + (elbow.y - shoulder.y) * t, shoulder.z + (elbow.z - shoulder.z) * t, BODY_RADII.upperArm); }
    const e = hold.copy(tip), hand = lever.setFromMatrixPosition(arm.hand.matrixWorld);
    // The hand reaches 12% past the wrist joint to the fingertips.
    const tipX = e.x + (hand.x - e.x) * 1.12, tipY = e.y + (hand.y - e.y) * 1.12, tipZ = e.z + (hand.z - e.z) * 1.12;
    for (let s = 0; s < 5; s += 1) {
      const t = s / 4;
      put(e.x + (tipX - e.x) * t, e.y + (tipY - e.y) * t, e.z + (tipZ - e.z) * t, BODY_RADII.foreArm * (1 + 0.35 * t));
    }
    return count;
  }

  /**
   * Rotates `bone` about its own joint by the damped least-squares rotation ω that minimises Σ (depthᵢ − (ω × leverᵢ)·nᵢ)² + λ|ω|² over the
   * penetrating samples, then bounds the bone's total rotation from the clip pose.
   */
  private solve(arm: LimbSide, bone: Object3D, limit: number, sign: number, upper: boolean): boolean {
    const count = this.sample(arm, upper), joint = pivot.setFromMatrixPosition(bone.matrixWorld);
    // Normal matrix A (symmetric 3×3) and right-hand side b.
    let a00 = DAMPING, a01 = 0, a02 = 0, a11 = DAMPING, a12 = 0, a22 = DAMPING, b0 = 0, b1 = 0, b2 = 0, any = false;
    side.copy(this.lateral).multiplyScalar(sign);
    for (let i = 0; i < count; i += 1) {
      const s = this.samples[i]!;
      let deepest = 0;
      for (let c = 0; c < this.capsules.length; c += 1) {
        const body = this.capsules[c]!, d = closestOnCapsule(body, s.x, s.y, s.z), depth = s.r + body.radius - d;
        if (depth <= deepest) continue;
        deepest = depth;
        push.set(s.x - near.x, s.y - near.y, s.z - near.z);
        if (d < 1e-5) push.copy(side);
        else {
          push.divideScalar(d);
          // Trunk and head push toward the arm's own side, blended so an arm crossing the midline is carried on through to its side without a flip.
          if (c <= 2) push.addScaledVector(side, 1.5 * Math.max(0, 1 - push.dot(side))).normalize();
        }
      }
      if (deepest < 1e-4) continue;
      lever.set(s.x - joint.x, s.y - joint.y, s.z - joint.z);
      torque.crossVectors(lever, push);
      // Only the component of the push the joint can move (perpendicular to the lever) is asked of it.
      const w = Math.min(1, deepest / 0.01);
      a00 += w * torque.x * torque.x; a01 += w * torque.x * torque.y; a02 += w * torque.x * torque.z;
      a11 += w * torque.y * torque.y; a12 += w * torque.y * torque.z; a22 += w * torque.z * torque.z;
      b0 += deepest * torque.x; b1 += deepest * torque.y; b2 += deepest * torque.z;
      any = true;
    }
    if (!any) return false;
    // Cramer's rule on the symmetric system.
    const c00 = a11 * a22 - a12 * a12, c01 = a02 * a12 - a01 * a22, c02 = a01 * a12 - a02 * a11;
    const det = a00 * c00 + a01 * c01 + a02 * c02;
    if (Math.abs(det) < 1e-18) return false;
    omega.set(
      (b0 * c00 + b1 * c01 + b2 * c02) / det,
      (b0 * c01 + b1 * (a00 * a22 - a02 * a02) + b2 * (a01 * a02 - a00 * a12)) / det,
      (b0 * c02 + b1 * (a01 * a02 - a00 * a12) + b2 * (a00 * a11 - a01 * a01)) / det,
    );
    const angle = omega.length();
    if (angle < 1e-4) return false;
    omega.divideScalar(angle);
    rotateBoneWorld(bone, omega, Math.min(angle, limit));
    // Total rotation from the clip pose stays within the anatomical budget.
    const clip = this.clip.get(bone)!, total = bone.quaternion.angleTo(clip);
    if (total > limit) { target.copy(clip).slerp(bone.quaternion, limit / total); bone.quaternion.copy(target); }
    bone.updateWorldMatrix(false, true);
    this.lastCorrection = Math.max(this.lastCorrection, Math.min(total, limit));
    return true;
  }
}
