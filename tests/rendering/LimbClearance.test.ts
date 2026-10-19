import { describe, expect, it } from 'bun:test';
import { Bone, Group, Quaternion, Vector3 } from 'three';
import { applyPosture, FOLLOW_THROUGH, postureEnvelope, type PostureFactors } from '../../src/rendering/AttackPosture.js';
import { ActorProcedural } from '../../src/rendering/ActorProcedural.js';
import { BODY_RADII, LimbClearance, type LimbSide } from '../../src/rendering/LimbClearance.js';
import { findRigBones } from '../../src/rendering/RigBones.js';

/** A complete Mixamo biped (names sanitized like the glTF loader): trunk 0.46 m hips-to-neck, arms hanging 0.3 m from the spine axis, legs straight down. */
function biped() {
  const root = new Group();
  const make = (name: string, x: number, y: number, parent: Group | Bone): Bone => { const bone = new Bone(); bone.name = `mixamorig${name}`; bone.position.set(x, y, 0); parent.add(bone); return bone; };
  const hips = make('Hips', 0, 1, root), spine = make('Spine', 0, 0.1, hips), spine1 = make('Spine1', 0, 0.12, spine), spine2 = make('Spine2', 0, 0.12, spine1);
  const neck = make('Neck', 0, 0.12, spine2), head = make('Head', 0, 0.1, neck);
  const side = (name: 'Left' | 'Right', sign: number): LimbSide => {
    const arm = make(`${name}Arm`, 0.3 * sign, 0, spine2), foreArm = make(`${name}ForeArm`, 0, -0.26, arm), hand = make(`${name}Hand`, 0, -0.24, foreArm);
    const upLeg = make(`${name}UpLeg`, 0.09 * sign, -0.05, hips), leg = make(`${name}Leg`, 0, -0.4, upLeg), foot = make(`${name}Foot`, 0, -0.42, leg);
    return { arm, foreArm, hand, upLeg, leg, foot };
  };
  const left = side('Left', 1), right = side('Right', -1);
  root.updateMatrixWorld(true);
  return { root, hips, spine, spine1, spine2, neck, head, left, right, limbs: { hips, spine1, neck, head, left, right } };
}

const locals = (bones: readonly Bone[]): number[][] => bones.map((bone) => bone.quaternion.toArray());
const world = (bone: Bone): Vector3 => bone.getWorldPosition(new Vector3());

describe('limb clearance', () => {
  it('leaves a pose that never touches the body exactly as the clip posed it', () => {
    const rig = biped(), solver = new LimbClearance(rig.limbs);
    const all = [rig.left.arm, rig.left.foreArm, rig.right.arm, rig.right.foreArm, rig.spine1, rig.hips];
    const before = locals(all);
    expect(solver.apply()).toBe(false);
    expect(solver.lastCorrection).toBe(0);
    expect(locals(all)).toEqual(before);
  });

  it('carries a forearm folded through the chest out of it, bending only the arm', () => {
    const rig = biped(), solver = new LimbClearance(rig.limbs);
    // Elbow folded 90° across the chest line: the hand ends up inside the trunk.
    rig.left.arm.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), -0.25);
    rig.left.foreArm.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), -1.7);
    rig.root.updateMatrixWorld(true);
    const trunk = [rig.hips, rig.spine, rig.spine1, rig.spine2, rig.neck, rig.head, rig.right.arm, rig.right.foreArm].map((bone) => bone.quaternion.toArray());
    const handBefore = world(rig.left.hand);
    expect(Math.hypot(handBefore.x, handBefore.z)).toBeLessThan(0.1); // inside the 0.15 m chest radius
    expect(solver.apply()).toBe(true);
    const hand = world(rig.left.hand), axisDistance = Math.hypot(hand.x, hand.z);
    expect(axisDistance).toBeGreaterThan(BODY_RADII.chest * 0.9 + BODY_RADII.hand * 0.5);
    expect([rig.hips, rig.spine, rig.spine1, rig.spine2, rig.neck, rig.head, rig.right.arm, rig.right.foreArm].map((bone) => bone.quaternion.toArray())).toEqual(trunk);
    expect(solver.lastCorrection).toBeGreaterThan(0.05);
  });

  it('never snaps while an arm sweeps through the body: per frame the solved hand strays from the clip hand by at most the filter step times the arm’s reach', () => {
    const rig = biped(), solver = new LimbClearance(rig.limbs), pos = new Vector3(), previous = new Vector3(), raw = new Vector3();
    let rawPrevious: Vector3 | undefined, worst = 0;
    for (let degrees = 0; degrees <= 150; degrees += 1) {
      rig.left.arm.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), -degrees * 0.002);
      rig.left.foreArm.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), -degrees * Math.PI / 180);
      rig.root.updateMatrixWorld(true);
      raw.copy(world(rig.left.hand));
      solver.apply(1 / 60);
      pos.copy(world(rig.left.hand));
      if (degrees > 0) worst = Math.max(worst, pos.distanceTo(previous) - raw.distanceTo(rawPrevious!));
      previous.copy(pos); rawPrevious = raw.clone();
    }
    // 0.3 rad per call about the shoulder (0.5 m to the fingertips) plus 0.3 rad about the elbow (0.27 m).
    expect(worst).toBeLessThan(0.3 * 0.5 + 0.3 * 0.27);
  });

  it('keeps every correction inside the shoulder and elbow budgets', () => {
    const rig = biped(), solver = new LimbClearance(rig.limbs), start = new Quaternion();
    rig.left.arm.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), -0.5);
    rig.left.foreArm.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), -2.4);
    start.copy(rig.left.arm.quaternion);
    rig.root.updateMatrixWorld(true);
    solver.apply();
    expect(rig.left.arm.quaternion.angleTo(start)).toBeLessThan(3 * 0.62 + 1e-6);
    expect(solver.lastCorrection).toBeLessThan(0.85 + 1e-6);
  });

  it('is built by the procedural layer for a complete biped and corrects the clip pose it is handed', () => {
    const rig = biped(), bones = findRigBones(rig.root)!;
    expect(bones.biped?.left.hand).toBe(rig.left.hand);
    const procedural = new ActorProcedural(rig.root, bones, null);
    procedural.inputs.limbClearance = true;
    rig.left.foreArm.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), -2.0);
    rig.left.arm.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), -0.3);
    const clipPose = rig.left.foreArm.quaternion.toArray();
    procedural.apply(1 / 60);
    expect(rig.left.foreArm.quaternion.toArray()).not.toEqual(clipPose);
    procedural.restore();
    expect(rig.left.foreArm.quaternion.toArray()).toEqual(clipPose);
  });

});

describe('attack posture', () => {
  const factors = (peak: number, t: number): PostureFactors => postureEnvelope(peak, t, { coil: 0, lean: 0 });

  it('starts and ends every action at rest, coils before contact and follows through after it', () => {
    for (const peak of [0.15, 0.3, 0.6]) {
      expect(factors(peak, 0)).toEqual({ coil: 0, lean: 0 });
      const end = factors(peak, 1);
      expect(Math.abs(end.coil)).toBeLessThan(1e-9);
      expect(Math.abs(end.lean)).toBeLessThan(1e-9);
      expect(factors(peak, peak * 0.62).coil).toBeCloseTo(1, 1);
      expect(Math.abs(factors(peak, peak).coil)).toBeLessThan(0.1);
      expect(factors(peak, Math.min(1, peak * 1.25)).coil).toBeLessThan(0);
      expect(factors(peak, Math.min(1, peak * 1.25)).coil).toBeGreaterThan(-FOLLOW_THROUGH - 1e-9);
      expect(factors(peak, peak).lean).toBeGreaterThan(0.9);
    }
  });

  it('turns the chest toward the character’s left for a positive coil and pitches it forward for a lean, leaving the hips planted', () => {
    const rig = biped(), hipsBefore = rig.hips.quaternion.toArray();
    const forward = new Vector3(0, 0, 1), chestForward = () => new Vector3(0, 0, 1).applyQuaternion(rig.spine2.getWorldQuaternion(new Quaternion()));
    applyPosture([rig.spine, rig.spine1, rig.spine2], forward, 0.4, 0);
    rig.root.updateMatrixWorld(true);
    expect(chestForward().x).toBeGreaterThan(0.2);
    applyPosture([rig.spine, rig.spine1, rig.spine2], forward, 0, 0.3);
    rig.root.updateMatrixWorld(true);
    expect(world(rig.head).z).toBeGreaterThan(0.02);
    expect(rig.hips.quaternion.toArray()).toEqual(hipsBefore);
  });
});
