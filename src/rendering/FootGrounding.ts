import { MathUtils, Matrix4, PropertyBinding, Quaternion, SkinnedMesh, Vector3, type Object3D } from 'three';
import type { GroundingSlot } from './AnimationController';

/** Height (m) of the walkable ground under a world X/Z, resolved near `nearY`; null where there is none. */
export type GroundHeightFn = (x: number, z: number, nearY: number) => number | null;

/** Fraction of the full leg length a solved leg may reach: a straight knee would read as hyperextension. */
const MAX_STRETCH = 0.995;
/** Metres the clip's knee offset is nudged toward the body's forward axis so a near-straight leg keeps a stable bend direction. */
const POLE_BIAS = 0.005;
/** A foot is planted (full weight) below this clip clearance and free (no weight) above the second value; metres above the standing rest height. */
const PLANT_FULL = 0.025;
const PLANT_NONE = 0.12;
/** Bounds of the vertical correction of one foot (m) and of the pelvis drop that makes lower ground reachable. */
const MIN_OFFSET = -0.35;
const MAX_OFFSET = 0.45;
const MAX_DROP = 0.35;
/** The foot target follows the ground at most this fast (m/s): ramps pass untouched, stair edges and spawns cannot pop. */
const MAX_OFFSET_RATE = 4;
const MAX_TILT = 25 * Math.PI / 180;
const TILT_RATE = 24;
/** Stance foot-lock: a planted foot is pinned in the world once its plant weight passes LOCK_ENTER and released below LOCK_EXIT; the pin never moves a foot further than MAX_SLIP (m) from the clip pose. */
const LOCK_ENTER = 0.6;
const LOCK_EXIT = 0.3;
const MAX_SLIP = 0.1;
/** Weight fade (1/s) of the whole correction: slow in, fast out so a jump never starts with the legs still pinned. */
const WEIGHT_IN_RATE = 6;
const WEIGHT_OUT_RATE = 14;
/** A body whose root is this far above the ground is airborne: no grounding. */
const AIRBORNE_CLEARANCE = 0.15;
/** Horizontal root displacement between two passes that counts as a teleport. */
const TELEPORT_DISTANCE = 1;
/** Corrections below this (m / rad) leave the clip pose bit-exact. */
const EPSILON = 5e-4;
const NORMAL_STEP = 0.2;
/** The clip's own foot height wins within this much of true sole contact; beyond it the sole is moved the rest of the way. */
const CONTACT_TOLERANCE = 0.006;
/** Ground tilt (rad) under a foot below which the clip pose is kept as authored, and above which the measured sole contact applies fully. */
const CONTACT_SLOPE_START = 0.02;
const CONTACT_SLOPE_FULL = 0.06;
/** Vertices this close to the lowest point of a foot belong to its sole. */
const SOLE_BAND = 0.05;
/** Sole points sampled along the length of a foot, heel and tip included. */
const SOLE_SAMPLES = 5;
const MIN_SOLE_VERTICES = 3;

const BONE_NAMES = {
  hips: 'mixamorig:Hips',
  left: ['mixamorig:LeftUpLeg', 'mixamorig:LeftLeg', 'mixamorig:LeftFoot', 'mixamorig:LeftToeBase'],
  right: ['mixamorig:RightUpLeg', 'mixamorig:RightLeg', 'mixamorig:RightFoot', 'mixamorig:RightToeBase'],
} as const;

const hipV = new Vector3(), kneeV = new Vector3(), ankleV = new Vector3(), targetV = new Vector3();
const dirA = new Vector3(), pole = new Vector3(), hintPerp = new Vector3(), outKnee = new Vector3(), outAnkle = new Vector3();
const forwardV = new Vector3(), fromV = new Vector3(), toV = new Vector3(), scaleV = new Vector3(), posV = new Vector3(), normalV = new Vector3();
const UP = new Vector3(0, 1, 0);
const parentQ = new Quaternion(), parentInv = new Quaternion(), swingQ = new Quaternion(), desiredQ = new Quaternion(), tiltQ = new Quaternion();
const IDENTITY = new Quaternion();
const matrix = new Matrix4();
const soleV = new Vector3();

const smoothstep = (edge0: number, edge1: number, x: number): number => { const t = MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1); return t * t * (3 - 2 * t); };

/**
 * Two-bone IK in world space. Moves `ankle` toward `target` with the knee on the side of the current knee (`knee` relative to the
 * hip→target line; `hint` only disambiguates a straight leg). Bone lengths are preserved exactly; an unreachable target is clamped to
 * `maxStretch` of the full leg (or the fully folded minimum) along the same direction. Writes the solved joints to `outKnee`/`outAnkle`.
 */
export function solveTwoBone(hip: Vector3, knee: Vector3, ankle: Vector3, target: Vector3, hint: Vector3, kneeOut: Vector3, ankleOut: Vector3, maxStretch = MAX_STRETCH): void {
  const l1 = hip.distanceTo(knee), l2 = knee.distanceTo(ankle);
  dirA.subVectors(target, hip);
  let distance = dirA.length();
  const fold = Math.abs(l1 - l2) + 1e-4, reach = Math.max(fold, (l1 + l2) * maxStretch);
  if (distance < 1e-9) { dirA.set(0, -1, 0); distance = fold; } else dirA.multiplyScalar(1 / distance);
  distance = MathUtils.clamp(distance, fold, reach);
  pole.subVectors(knee, hip);
  pole.addScaledVector(dirA, -pole.dot(dirA));
  hintPerp.copy(hint).addScaledVector(dirA, -hint.dot(dirA));
  if (hintPerp.lengthSq() > 1e-12) pole.addScaledVector(hintPerp.normalize(), POLE_BIAS);
  if (pole.lengthSq() < 1e-12) { const axisX = Math.abs(dirA.x) < 0.9; pole.set(axisX ? 1 : 0, axisX ? 0 : 1, 0).addScaledVector(dirA, -(axisX ? dirA.x : dirA.y)); }
  pole.normalize();
  const cosine = MathUtils.clamp((l1 * l1 + distance * distance - l2 * l2) / (2 * l1 * distance), -1, 1);
  const sine = Math.sqrt(1 - cosine * cosine);
  kneeOut.copy(hip).addScaledVector(dirA, l1 * cosine).addScaledVector(pole, l1 * sine);
  ankleOut.copy(hip).addScaledVector(dirA, distance);
}

/** Unit normal of the ground at x/z from forward differences of `ground` around height `y`; straight up where a neighbour has no ground. */
export function groundNormalAt(ground: GroundHeightFn, x: number, z: number, y: number, out: Vector3, step = NORMAL_STEP): Vector3 {
  const hx = ground(x + step, z, y), hz = ground(x, z + step, y);
  if (hx === null || hz === null) return out.set(0, 1, 0);
  return out.set(-(hx - y) / step, 1, -(hz - y) / step).normalize();
}

/** A point of the sole in the local space of the foot or toe bone that carries it. */
interface SolePoint { readonly bone: Object3D; readonly local: Vector3 }

interface Leg {
  readonly upLeg: Object3D; readonly leg: Object3D; readonly foot: Object3D; readonly toe: Object3D | undefined;
  /** Standing rest height of the ankle and toe above the actor root, measured on the bind pose. */
  readonly ankleRest: number; readonly toeRest: number;
  /** Where the sole touches the ground, as points fixed in the foot or toe bone: along the measured sole of the foot. */
  readonly points: SolePoint[];
  readonly clipUpLeg: Quaternion; readonly clipLeg: Quaternion; readonly clipFoot: Quaternion;
  readonly ankle0: Vector3; readonly footWorld0: Quaternion;
  readonly tilt: Quaternion; readonly tiltTarget: Quaternion;
  offset: number; effective: number; planted: number; solve: boolean; saved: boolean;
  /** Foot-lock: world X/Z the planted foot is pinned to, and the planar correction (m) currently applied to the clip foot. */
  locked: boolean; lockX: number; lockZ: number; slipX: number; slipZ: number;
}

/**
 * Presentation-only foot grounding for Mixamo-named biped rigs. After the clip pose, each planted foot is moved by the height
 * difference between the ground under it and the actor root (zero on flat ground, so the clip pose is left untouched), the pelvis
 * drops by the largest lowering so the leg can reach it, UpLeg/Leg are solved with the clip's own knee side, and the sole tilts
 * toward the ground normal (bounded). Every weight fades in and out; nothing here changes simulation state.
 */
export class FootGrounding implements GroundingSlot {
  /** Caller-supplied each frame: false while jumping, vaulting, downed or otherwise off the ground. */
  grounded = true;
  /** Caller-supplied each frame: pin planted feet in the world (hero in-place gaits slide a few cm per stance otherwise). */
  footLock = false;
  private readonly legs: [Leg, Leg];
  private readonly clipHips = new Vector3();
  private hipsSaved = false;
  private weight = 0;
  private lastX = 0;
  private lastZ = 0;
  private hasLast = false;

  private constructor(private readonly root: Object3D, private readonly hips: Object3D, legs: [Leg, Leg], private readonly ground: GroundHeightFn) { this.legs = legs; }

  /** Null unless `root` contains a complete Mixamo-named hip and both legs. Measures the standing rest heights from the current (bind) pose. */
  static create(root: Object3D, ground: GroundHeightFn): FootGrounding | null {
    const find = (name: string): Object3D | undefined => root.getObjectByName(PropertyBinding.sanitizeNodeName(name)) ?? root.getObjectByName(name);
    const hips = find(BONE_NAMES.hips);
    if (!hips) return null;
    root.updateWorldMatrix(true, true);
    const rootY = root.matrixWorld.elements[13]!;
    const legs: Leg[] = [];
    for (const names of [BONE_NAMES.left, BONE_NAMES.right]) {
      const upLeg = find(names[0]), leg = find(names[1]), foot = find(names[2]), toe = find(names[3]);
      if (!upLeg || !leg || !foot) return null;
      legs.push({
        upLeg, leg, foot, toe,
        ankleRest: foot.matrixWorld.elements[13]! - rootY, toeRest: toe ? toe.matrixWorld.elements[13]! - rootY : 0,
        clipUpLeg: new Quaternion(), clipLeg: new Quaternion(), clipFoot: new Quaternion(), ankle0: new Vector3(), footWorld0: new Quaternion(),
        tilt: new Quaternion(), tiltTarget: new Quaternion(), offset: 0, effective: 0, planted: 0, solve: false, saved: false, points: [],
        locked: false, lockX: 0, lockZ: 0, slipX: 0, slipZ: 0,
      });
    }
    const feet = legs as [Leg, Leg];
    const candidates: Vector3[][] = [[], []];
    const owners: Object3D[][] = [[], []];
    const ownerOf = new Map<Object3D, number>();
    feet.forEach((leg, index) => { ownerOf.set(leg.foot, index); if (leg.toe) ownerOf.set(leg.toe, index); });
    root.traverse(node => {
      if (!(node instanceof SkinnedMesh)) return;
      const joints = node.skeleton.bones.map(bone => ownerOf.get(bone) ?? -1);
      if (joints.every(owner => owner < 0)) return;
      const position = node.geometry.getAttribute('position'), index = node.geometry.getAttribute('skinIndex'), weight = node.geometry.getAttribute('skinWeight');
      if (!position || !index || !weight) return;
      for (let i = 0; i < position.count; i += 1) {
        let best = 0;
        for (let j = 1; j < 4; j += 1) if (weight.getComponent(i, j) > weight.getComponent(i, best)) best = j;
        const side = joints[index.getComponent(i, best)] ?? -1;
        if (side < 0) continue;
        candidates[side]!.push(new Vector3().fromBufferAttribute(position, i).applyMatrix4(node.matrixWorld));
        owners[side]!.push(node.skeleton.bones[index.getComponent(i, best)]!);
      }
    });
    feet.forEach((leg, side) => leg.points.push(...solePoints(leg, candidates[side]!, owners[side]!, rootY, root)));
    return new FootGrounding(root, hips, feet, ground);
  }

  /**
   * Lift (m) the foot would need so that its lowest sole point rests on the ground, with the foot tilted as it will be drawn: the clip
   * sole points hang rigidly off the ankle, so each lands at ankle0 + tilt · (point − ankle0). NaN when no point has ground under it.
   */
  private contactLift(leg: Leg, rootY: number): number {
    let lift = -Infinity;
    for (const point of leg.points) {
      soleV.copy(point.local).applyMatrix4(point.bone.matrixWorld).sub(leg.ankle0).applyQuaternion(tiltQ);
      const ground = this.ground(leg.ankle0.x + soleV.x, leg.ankle0.z + soleV.z, rootY);
      if (ground !== null) lift = Math.max(lift, ground - (leg.ankle0.y + soleV.y));
    }
    return lift === -Infinity ? Number.NaN : lift;
  }

  restore(): void {
    if (this.hipsSaved) { this.hips.position.copy(this.clipHips); this.hipsSaved = false; }
    for (const leg of this.legs) {
      if (!leg.saved) continue;
      leg.upLeg.quaternion.copy(leg.clipUpLeg); leg.leg.quaternion.copy(leg.clipLeg); leg.foot.quaternion.copy(leg.clipFoot);
      leg.saved = false;
    }
  }

  apply(dt: number): void {
    const { root, hips, legs, ground } = this;
    if (!root.visible) { this.suspend(); return; }
    hips.updateWorldMatrix(true, false);
    const rootElements = root.matrixWorld.elements;
    const rootX = rootElements[12]!, rootY = rootElements[13]!, rootZ = rootElements[14]!;
    const snap = !this.hasLast || Math.hypot(rootX - this.lastX, rootZ - this.lastZ) > TELEPORT_DISTANCE;
    this.hasLast = true; this.lastX = rootX; this.lastZ = rootZ;
    if (snap) this.weight = 0;
    const rootGround = ground(rootX, rootZ, rootY);
    const target = this.grounded && rootGround !== null && rootY - rootGround <= AIRBORNE_CLEARANCE ? 1 : 0;
    if (dt > 0) this.weight += MathUtils.clamp(target - this.weight, -WEIGHT_OUT_RATE * dt, WEIGHT_IN_RATE * dt);
    const gate = smoothstep(0, 1, this.weight);
    if (gate <= 1e-3) { for (const leg of legs) { leg.offset = 0; leg.tilt.identity(); leg.locked = false; leg.slipX = leg.slipZ = 0; } return; }

    forwardV.set(rootElements[8]!, 0, rootElements[10]!);
    if (forwardV.lengthSq() < 1e-8) forwardV.set(0, 0, 1); else forwardV.normalize();
    let drop = 0, any = false;
    for (const leg of legs) {
      leg.upLeg.updateWorldMatrix(false, false); leg.leg.updateWorldMatrix(false, false); leg.foot.updateWorldMatrix(false, false);
      leg.ankle0.setFromMatrixPosition(leg.foot.matrixWorld);
      leg.foot.matrixWorld.decompose(posV, leg.footWorld0, scaleV);
      let clearance = leg.ankle0.y - rootY - leg.ankleRest;
      if (leg.toe) { leg.toe.updateWorldMatrix(false, false); clearance = Math.min(clearance, leg.toe.matrixWorld.elements[13]! - rootY - leg.toeRest); }
      leg.planted = 1 - smoothstep(PLANT_FULL, PLANT_NONE, Math.max(0, clearance));
      const height = ground(leg.ankle0.x, leg.ankle0.z, rootY);
      let wanted = height === null ? 0 : MathUtils.clamp(height - rootY, MIN_OFFSET, MAX_OFFSET);
      const blend = leg.planted * gate;
      if (height === null || blend < 0.01) leg.tiltTarget.identity();
      else {
        groundNormalAt(ground, leg.ankle0.x, leg.ankle0.z, height, normalV);
        leg.tiltTarget.setFromUnitVectors(UP, normalV);
        const angle = 2 * Math.acos(MathUtils.clamp(leg.tiltTarget.w, -1, 1));
        if (angle > MAX_TILT) leg.tiltTarget.slerp(IDENTITY, 1 - MAX_TILT / angle);
      }
      if (snap || blend < 0.01) leg.tilt.copy(leg.tiltTarget); else if (dt > 0) leg.tilt.slerp(leg.tiltTarget, 1 - Math.exp(-TILT_RATE * dt));
      tiltQ.identity().slerp(leg.tilt, blend);
      const slope = smoothstep(CONTACT_SLOPE_START, CONTACT_SLOPE_FULL, 2 * Math.acos(MathUtils.clamp(leg.tilt.w, -1, 1)));
      if (height !== null && blend >= 0.01 && slope > 0) {
        // On a slope the measured sole contact corrects what the clip's flat-ground pose gets wrong (a toe-off or heel-strike sole sunk
        // into the rise); past a small tolerance it wins. Flat ground keeps the clip pose exactly as authored.
        const excess = this.contactLift(leg, rootY) - wanted;
        if (Number.isFinite(excess)) wanted = MathUtils.clamp(wanted + slope * Math.sign(excess) * Math.max(0, Math.abs(excess) - CONTACT_TOLERANCE), MIN_OFFSET, MAX_OFFSET);
      }
      if (snap || leg.planted < 0.01) leg.offset = wanted;
      else if (dt > 0) leg.offset += MathUtils.clamp(wanted - leg.offset, -MAX_OFFSET_RATE * dt, MAX_OFFSET_RATE * dt);
      leg.effective = leg.offset * blend;
      // Stance foot-lock: the correction that holds a planted foot where it first touched down, up to MAX_SLIP; a lifting foot lets go (the blend fades it).
      if (this.footLock && !snap && leg.planted >= (leg.locked ? LOCK_EXIT : LOCK_ENTER)) {
        if (!leg.locked) { leg.locked = true; leg.lockX = leg.ankle0.x; leg.lockZ = leg.ankle0.z; }
        let slipX = leg.lockX - leg.ankle0.x, slipZ = leg.lockZ - leg.ankle0.z;
        const slip = Math.hypot(slipX, slipZ);
        if (slip > MAX_SLIP) {
          const k = MAX_SLIP / slip;
          slipX *= k; slipZ *= k;
          leg.lockX = leg.ankle0.x + slipX; leg.lockZ = leg.ankle0.z + slipZ;
        }
        leg.slipX = slipX; leg.slipZ = slipZ;
      } else { leg.locked = false; leg.slipX = leg.slipZ = 0; }
      const tilted = 2 * Math.acos(MathUtils.clamp(tiltQ.w, -1, 1)) > EPSILON;
      leg.solve = Math.abs(leg.effective) > EPSILON || tilted || Math.hypot(leg.slipX, leg.slipZ) * blend > EPSILON;
      if (leg.solve) any = true;
      drop = Math.max(drop, -leg.effective);
    }
    drop = Math.min(drop, MAX_DROP);
    if (drop > EPSILON) any = true;
    if (!any) return;
    if (drop > EPSILON) {
      this.clipHips.copy(hips.position); this.hipsSaved = true;
      posV.setFromMatrixPosition(hips.matrixWorld); posV.y -= drop;
      const parent = hips.parent;
      if (parent) hips.position.copy(posV.applyMatrix4(matrix.copy(parent.matrixWorld).invert())); else hips.position.copy(posV);
      hips.updateWorldMatrix(false, false);
    }
    for (const leg of legs) if (leg.solve || drop > EPSILON) this.solveLeg(leg, leg.planted * gate);
  }

  private solveLeg(leg: Leg, blend: number): void {
    const { upLeg, leg: lower, foot } = leg;
    leg.clipUpLeg.copy(upLeg.quaternion); leg.clipLeg.copy(lower.quaternion); leg.clipFoot.copy(foot.quaternion); leg.saved = true;
    upLeg.updateWorldMatrix(false, false); lower.updateWorldMatrix(false, false); foot.updateWorldMatrix(false, false);
    hipV.setFromMatrixPosition(upLeg.matrixWorld); kneeV.setFromMatrixPosition(lower.matrixWorld); ankleV.setFromMatrixPosition(foot.matrixWorld);
    targetV.copy(leg.ankle0); targetV.y += leg.effective; targetV.x += leg.slipX * blend; targetV.z += leg.slipZ * blend;
    solveTwoBone(hipV, kneeV, ankleV, targetV, forwardV, outKnee, outAnkle);
    swing(upLeg, fromV.subVectors(kneeV, hipV).normalize(), toV.subVectors(outKnee, hipV).normalize());
    upLeg.updateWorldMatrix(false, false); lower.updateWorldMatrix(false, false); foot.updateWorldMatrix(false, false);
    kneeV.setFromMatrixPosition(lower.matrixWorld); ankleV.setFromMatrixPosition(foot.matrixWorld);
    swing(lower, fromV.subVectors(ankleV, kneeV).normalize(), toV.subVectors(outAnkle, kneeV).normalize());
    lower.updateWorldMatrix(false, false);
    tiltQ.identity().slerp(leg.tilt, blend);
    desiredQ.multiplyQuaternions(tiltQ, leg.footWorld0);
    lower.matrixWorld.decompose(posV, parentQ, scaleV);
    foot.quaternion.copy(parentInv.copy(parentQ).invert()).multiply(desiredQ).normalize();
    foot.updateWorldMatrix(false, false);
  }

  /** Drops all state while the actor is hidden or its rig is being released; the next visible pass starts from zero weight. */
  private suspend(): void {
    this.weight = 0; this.hasLast = false;
    for (const leg of this.legs) { leg.offset = 0; leg.tilt.identity(); leg.locked = false; leg.slipX = leg.slipZ = 0; }
  }
}

/** Rotates `bone` so that world direction `from` turns into `to` (both unit), leaving the bone's twist about the swing axis as it was. */
export function swing(bone: Object3D, from: Vector3, to: Vector3): void {
  swingQ.setFromUnitVectors(from, to);
  const parent = bone.parent;
  if (!parent) return;
  parent.matrixWorld.decompose(posV, parentQ, scaleV);
  parentInv.copy(parentQ).invert();
  swingQ.premultiply(parentInv).multiply(parentQ);
  bone.quaternion.premultiply(swingQ).normalize();
}

/**
 * Up to seven sole points (heel, tip, both edges and three along the length) of the lowest vertices a foot's bones carry on the bind pose; without skinned
 * vertices, the foot and toe origins dropped to the actor root's height. Each is stored in the local space of its carrying bone.
 */
function solePoints(leg: Leg, vertices: readonly Vector3[], owners: readonly Object3D[], rootY: number, root: Object3D): SolePoint[] {
  const localTo = (bone: Object3D, world: Vector3): Vector3 => new Vector3().copy(world).applyMatrix4(matrix.copy(bone.matrixWorld).invert());
  if (vertices.length < MIN_SOLE_VERTICES) {
    return [leg.foot, ...(leg.toe ? [leg.toe] : [])].map(bone => ({ bone, local: localTo(bone, posV.setFromMatrixPosition(bone.matrixWorld).setY(rootY)) }));
  }
  let lowest = Infinity;
  for (const vertex of vertices) lowest = Math.min(lowest, vertex.y);
  const axis = new Vector3();
  if (leg.toe) axis.setFromMatrixPosition(leg.toe.matrixWorld).sub(posV.setFromMatrixPosition(leg.foot.matrixWorld));
  axis.y = 0;
  if (axis.lengthSq() < 1e-8) axis.set(root.matrixWorld.elements[8]!, 0, root.matrixWorld.elements[10]!);
  axis.normalize();
  const chosen: number[] = [];
  const soleVertices: number[] = [];
  vertices.forEach((vertex, index) => { if (vertex.y <= lowest + SOLE_BAND) soleVertices.push(index); });
  const along = (index: number): number => vertices[index]!.dot(axis);
  const across = (index: number): number => vertices[index]!.x * axis.z - vertices[index]!.z * axis.x;
  let first = soleVertices[0]!, last = first, left = first, right = first;
  for (const index of soleVertices) {
    if (along(index) < along(first)) first = index;
    if (along(index) > along(last)) last = index;
    if (across(index) < across(left)) left = index;
    if (across(index) > across(right)) right = index;
  }
  chosen.push(first, last, left, right);
  // A pitched sole rests on whichever part of its curve is lowest, so sample the length of the foot too.
  for (let step = 1; step < SOLE_SAMPLES - 1; step += 1) {
    const wanted = along(first) + (along(last) - along(first)) * step / (SOLE_SAMPLES - 1);
    let nearest = first;
    for (const index of soleVertices) {
      const gap = Math.abs(along(index) - wanted), best = Math.abs(along(nearest) - wanted);
      if (gap < best - 1e-6 || (Math.abs(gap - best) <= 1e-6 && vertices[index]!.y < vertices[nearest]!.y)) nearest = index;
    }
    chosen.push(nearest);
  }
  return [...new Set(chosen)].map(index => ({ bone: owners[index]!, local: localTo(owners[index]!, vertices[index]!) }));
}
