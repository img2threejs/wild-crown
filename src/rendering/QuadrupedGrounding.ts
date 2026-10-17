import { MathUtils, Quaternion, Vector3, type Object3D } from 'three';
import type { GroundingSlot } from './AnimationController';
import { solveTwoBone, swing, type GroundHeightFn } from './FootGrounding';

/** A planted foot is held (full weight) below this clip clearance over its rest height and free above the second value (metres). */
const PLANT_FULL = 0.04;
const PLANT_NONE = 0.2;
/** Bounds of one foot's vertical correction (m), its follow speed (m/s) and the weight fade rates (1/s) of the whole correction. */
const MAX_OFFSET = 0.35;
const MAX_OFFSET_RATE = 4;
const WEIGHT_IN_RATE = 6;
const WEIGHT_OUT_RATE = 14;
/** Corrections below this (m) leave the clip pose bit-exact. */
const EPSILON = 5e-4;
const TELEPORT_DISTANCE = 1.5;
const AIRBORNE_CLEARANCE = 0.2;

const hipV = new Vector3(), kneeV = new Vector3(), ankleV = new Vector3(), targetV = new Vector3(), outKnee = new Vector3(), outAnkle = new Vector3();
const forwardV = new Vector3(), fromV = new Vector3(), toV = new Vector3(), restV = new Vector3();
const smoothstep = (edge0: number, edge1: number, x: number): number => { const t = MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1); return t * t * (3 - 2 * t); };

interface Leg {
  readonly upper: Object3D; readonly lower: Object3D; readonly foot: Object3D;
  /** Foot position in the root's space on the bind pose, and its height over the root origin there (the ground when the bind pose was captured). */
  readonly restLocal: Vector3;
  readonly restClearance: number;
  readonly clipUpper: Quaternion; readonly clipLower: Quaternion;
  offset: number; effective: number; planted: number; saved: boolean;
}

/**
 * Presentation-only foot grounding for creature rigs (the last three bones of each `<n>_<Side>_Limb_<k>` chain). On flat ground the correction is
 * zero and the clip pose is left untouched; on a slope each planted foot is lowered or raised by the ground under it relative to where the
 * (slope-tilted) body would hold it at rest, solved with a two-bone IK that keeps the clip's knee side. The body's own pitch and roll come from
 * SlopeAttitude. Every weight fades; nothing here changes simulation state.
 */
export class QuadrupedGrounding implements GroundingSlot {
  /** Caller-supplied each frame: false while jumping, hopping, flying or downed. */
  grounded = true;
  private weight = 0;
  private lastX = 0;
  private lastZ = 0;
  private hasLast = false;

  private constructor(private readonly root: Object3D, private readonly legs: Leg[], private readonly ground: GroundHeightFn) {}

  /** Null unless at least two limb chains of three or more bones exist. */
  static create(root: Object3D, limbs: readonly (readonly Object3D[])[], ground: GroundHeightFn): QuadrupedGrounding | null {
    const usable = limbs.filter(chain => chain.length >= 3);
    if (usable.length < 2) return null;
    root.updateWorldMatrix(true, true);
    const rootY = root.matrixWorld.elements[13]!;
    const legs: Leg[] = usable.map((chain) => {
      const foot = chain[chain.length - 1]!;
      foot.updateWorldMatrix(true, false);
      const world = new Vector3().setFromMatrixPosition(foot.matrixWorld);
      return {
        upper: chain[chain.length - 3]!, lower: chain[chain.length - 2]!, foot,
        restLocal: root.worldToLocal(world.clone()), restClearance: world.y - rootY,
        clipUpper: new Quaternion(), clipLower: new Quaternion(), offset: 0, effective: 0, planted: 0, saved: false,
      };
    });
    return new QuadrupedGrounding(root, legs, ground);
  }

  restore(): void {
    for (const leg of this.legs) {
      if (!leg.saved) continue;
      leg.upper.quaternion.copy(leg.clipUpper); leg.lower.quaternion.copy(leg.clipLower);
      leg.saved = false;
    }
  }

  apply(dt: number): void {
    const { root, legs, ground } = this;
    if (!root.visible) { this.suspend(); return; }
    root.updateWorldMatrix(true, false);
    const e = root.matrixWorld.elements;
    const rootX = e[12]!, rootY = e[13]!, rootZ = e[14]!;
    const snap = !this.hasLast || Math.hypot(rootX - this.lastX, rootZ - this.lastZ) > TELEPORT_DISTANCE;
    this.hasLast = true; this.lastX = rootX; this.lastZ = rootZ;
    if (snap) this.weight = 0;
    const rootGround = ground(rootX, rootZ, rootY);
    const target = this.grounded && rootGround !== null && rootY - rootGround <= AIRBORNE_CLEARANCE ? 1 : 0;
    if (dt > 0) this.weight += MathUtils.clamp(target - this.weight, -WEIGHT_OUT_RATE * dt, WEIGHT_IN_RATE * dt);
    const gate = smoothstep(0, 1, this.weight);
    if (gate <= 1e-3) { for (const leg of legs) leg.offset = 0; return; }
    forwardV.set(e[8]!, 0, e[10]!);
    if (forwardV.lengthSq() < 1e-8) forwardV.set(0, 0, 1); else forwardV.normalize();
    for (const leg of legs) {
      leg.foot.updateWorldMatrix(true, false);
      ankleV.setFromMatrixPosition(leg.foot.matrixWorld);
      // Where the body, at its current tilt, would hold this foot at rest.
      restV.copy(leg.restLocal).applyMatrix4(root.matrixWorld);
      const clearance = ankleV.y - restV.y;
      leg.planted = 1 - smoothstep(PLANT_FULL, PLANT_NONE, Math.max(0, clearance));
      const height = ground(ankleV.x, ankleV.z, rootY);
      const wanted = height === null ? 0 : MathUtils.clamp(height - (restV.y - leg.restClearance), -MAX_OFFSET, MAX_OFFSET);
      if (snap || leg.planted < 0.01) leg.offset = wanted;
      else if (dt > 0) leg.offset += MathUtils.clamp(wanted - leg.offset, -MAX_OFFSET_RATE * dt, MAX_OFFSET_RATE * dt);
      leg.effective = leg.offset * leg.planted * gate;
      if (Math.abs(leg.effective) > EPSILON) this.solve(leg);
    }
  }

  private solve(leg: Leg): void {
    const { upper, lower, foot } = leg;
    leg.clipUpper.copy(upper.quaternion); leg.clipLower.copy(lower.quaternion); leg.saved = true;
    upper.updateWorldMatrix(true, false); lower.updateWorldMatrix(false, false); foot.updateWorldMatrix(false, false);
    hipV.setFromMatrixPosition(upper.matrixWorld); kneeV.setFromMatrixPosition(lower.matrixWorld); ankleV.setFromMatrixPosition(foot.matrixWorld);
    targetV.copy(ankleV); targetV.y += leg.effective;
    solveTwoBone(hipV, kneeV, ankleV, targetV, forwardV, outKnee, outAnkle);
    swing(upper, fromV.subVectors(kneeV, hipV).normalize(), toV.subVectors(outKnee, hipV).normalize());
    upper.updateWorldMatrix(false, false); lower.updateWorldMatrix(false, false); foot.updateWorldMatrix(false, false);
    kneeV.setFromMatrixPosition(lower.matrixWorld); ankleV.setFromMatrixPosition(foot.matrixWorld);
    swing(lower, fromV.subVectors(ankleV, kneeV).normalize(), toV.subVectors(outAnkle, kneeV).normalize());
    lower.updateWorldMatrix(false, false);
  }

  private suspend(): void {
    this.weight = 0; this.hasLast = false;
    for (const leg of this.legs) leg.offset = 0;
  }
}
