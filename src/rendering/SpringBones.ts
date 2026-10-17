import { Vector3, type Object3D, type Quaternion } from 'three';
import { swing } from './FootGrounding';

/** Tuning of one spring chain. Frequencies in rad/s, `drag` in 1/s, `gravity` in m/s² on the tail point. */
export interface SpringSpec {
  /** Natural frequency of the pull of each tail point back to where the clip pose puts it. */
  readonly stiffness: number;
  /** Velocity damping: ~2·stiffness is critically damped, lower leaves visible overshoot. */
  readonly drag: number;
  readonly gravity: number;
  /** Largest deflection (rad) of one bone from its clip direction. */
  readonly limit: number;
}

/** Longest step integrated at once (s): longer frames (a tab switch, a hitch) are clamped, never extrapolated. */
export const SPRING_MAX_STEP = 1 / 30;
/** Fixed sub-step (s) of the integration: with the frequencies above (≤ 40 rad/s) the explicit step stays well inside its stability limit. */
const SUB_STEP = 1 / 120;
/** Root displacement (m) between two updates that counts as a teleport (the springs restart at rest). */
const TELEPORT_DISTANCE = 1.5;

const headV = new Vector3(), restV = new Vector3(), toV = new Vector3(), fromV = new Vector3(), childV = new Vector3(), accelV = new Vector3(), perpV = new Vector3();

/** One simulated joint: the bone that rotates, the point where its child sits, and that point's velocity. */
interface Joint {
  readonly bone: Object3D;
  readonly child: Object3D;
  /** Bone length (m), measured on the first pass. */
  length: number;
  readonly tail: Vector3;
  readonly velocity: Vector3;
  readonly clip: Quaternion;
}

/**
 * Secondary motion for bone chains (creature tails; hair, coats and charms on rigs that carry such joints): each joint's child point is a
 * damped spring pulled toward where the clip pose puts it, so the chain lags and overshoots the animated motion and drags behind a
 * moving root. Bone lengths are exact (the tail point is projected back onto its sphere every step), deflection from the clip is limited,
 * and the sub-stepped integration cannot explode: a frame is clamped to SPRING_MAX_STEP and a teleport restarts the chain at rest.
 * Presentation only; nothing here touches the simulation. The caller restores the clip pose (`restore`) before every mixer evaluation.
 */
export class SpringChain {
  private readonly joints: Joint[] = [];
  private primed = false;
  /** True while the bones carry rotations `apply` wrote and `restore` has not yet taken back (a reset must still restore them). */
  private modified = false;
  private lastRootX = 0;
  private lastRootY = 0;
  private lastRootZ = 0;

  /** `bones` base first, each a descendant of the previous; every bone but the last rotates toward the simulated point where its child sits. */
  constructor(bones: readonly Object3D[], private readonly spec: SpringSpec) {
    for (let i = 0; i < bones.length - 1; i += 1) {
      const bone = bones[i]!, child = bones[i + 1]!;
      this.joints.push({ bone, child, length: 0, tail: new Vector3(), velocity: new Vector3(), clip: bone.quaternion.clone() });
    }
  }

  get length(): number { return this.joints.length; }

  /** World position of joint `index`'s simulated tail point (tests, debugging). */
  tailOf(index: number): Vector3 { return this.joints[index]!.tail; }

  /** Puts back the clip rotations `apply` replaced. */
  restore(): void {
    if (!this.modified) return;
    for (const joint of this.joints) joint.bone.quaternion.copy(joint.clip);
    this.modified = false;
  }

  /** Drops the simulated state; the next `apply` starts every tail at rest on the clip pose. */
  reset(): void { this.primed = false; }

  /**
   * Simulates `dt` seconds on top of the clip pose already evaluated into the bones and rotates every joint toward its tail point.
   * `rootX/Y/Z` is the actor's world position (teleport detection).
   */
  apply(dt: number, rootX: number, rootY: number, rootZ: number): void {
    const joints = this.joints;
    if (joints.length === 0) return;
    if (this.primed && Math.hypot(rootX - this.lastRootX, rootY - this.lastRootY, rootZ - this.lastRootZ) > TELEPORT_DISTANCE) this.primed = false;
    this.lastRootX = rootX; this.lastRootY = rootY; this.lastRootZ = rootZ;
    const step = Math.min(Math.max(dt, 0), SPRING_MAX_STEP);
    const spec = this.spec;
    for (let i = 0; i < joints.length; i += 1) {
      const joint = joints[i]!, bone = joint.bone;
      bone.updateWorldMatrix(true, false);
      joint.child.updateWorldMatrix(false, false);
      joint.clip.copy(bone.quaternion);
      headV.setFromMatrixPosition(bone.matrixWorld);
      restV.setFromMatrixPosition(joint.child.matrixWorld);
      if (!this.primed) {
        joint.length = Math.max(1e-6, restV.distanceTo(headV));
        joint.tail.copy(restV); joint.velocity.set(0, 0, 0);
        continue;
      }
      // Where the clip pose (under the already-moved parent chain) puts the tail; the spring pulls toward it.
      restV.sub(headV);
      const length = restV.length();
      if (length < 1e-9) continue;
      restV.multiplyScalar(1 / length);
      fromV.copy(restV);
      const target = childV.copy(headV).addScaledVector(restV, joint.length);
      if (step > 0) {
        let left = step;
        while (left > 1e-9) {
          const h = Math.min(SUB_STEP, left);
          left -= h;
          // Semi-implicit Euler on a damped spring toward the clip tail, plus gravity.
          accelV.copy(target).sub(joint.tail).multiplyScalar(spec.stiffness * spec.stiffness);
          accelV.y -= spec.gravity;
          joint.velocity.addScaledVector(accelV, h).multiplyScalar(Math.exp(-spec.drag * h));
          joint.tail.addScaledVector(joint.velocity, h);
          // Keep the bone length exact and take the radial velocity out so a tail never springs along its own bone.
          toV.copy(joint.tail).sub(headV);
          const distance = toV.length();
          if (distance < 1e-9) joint.tail.copy(target);
          else {
            toV.multiplyScalar(1 / distance);
            joint.tail.copy(headV).addScaledVector(toV, joint.length);
            joint.velocity.addScaledVector(toV, -joint.velocity.dot(toV));
          }
        }
      }
      toV.copy(joint.tail).sub(headV).normalize();
      // Deflection limit: turn the direction back toward the clip direction until it is within `limit`.
      const dot = Math.max(-1, Math.min(1, toV.dot(fromV)));
      if (dot < Math.cos(spec.limit)) {
        perpV.copy(toV).addScaledVector(fromV, -dot);
        const perpLength = perpV.length();
        if (perpLength > 1e-9) perpV.multiplyScalar(1 / perpLength); else perpV.set(0, 0, 0);
        toV.copy(fromV).multiplyScalar(Math.cos(spec.limit)).addScaledVector(perpV, Math.sin(spec.limit)).normalize();
        joint.tail.copy(headV).addScaledVector(toV, joint.length);
      }
      swing(bone, fromV, toV);
      bone.updateWorldMatrix(false, false);
    }
    this.primed = true;
    this.modified = true;
  }
}
