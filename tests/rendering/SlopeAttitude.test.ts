import { describe, expect, it } from 'bun:test';
import { Bone, Group, Vector3 } from 'three';
import type { GroundHeightFn } from '../../src/rendering/FootGrounding.js';
import { QuadrupedGrounding } from '../../src/rendering/QuadrupedGrounding.js';
import { MAX_SLOPE_TILT, createSlopeAttitude, settleSlopeAttitude, slopeTarget } from '../../src/rendering/SlopeAttitude.js';

describe('slope target attitude', () => {
  const target = (ground: GroundHeightFn, yaw = 0) => {
    const out = createSlopeAttitude();
    slopeTarget(ground, 0, 0, 0, Math.sin(yaw), Math.cos(yaw), 0.8, 0.4, out);
    return out;
  };

  it('is level on flat ground', () => {
    expect(target(() => 0)).toEqual({ pitch: 0, roll: 0 });
  });

  it('pitches the nose up when the ground rises ahead and down when it falls away', () => {
    // Facing +Z (yaw 0): rising toward +Z is rising ahead; the root convention is +pitch = nose down.
    const up = target((_x, z) => 0.2 * z);
    expect(up.pitch).toBeCloseTo(-Math.atan(0.2), 6);
    expect(up.roll).toBeCloseTo(0, 9);
    expect(target((_x, z) => -0.2 * z).pitch).toBeCloseTo(Math.atan(0.2), 6);
  });

  it('rolls with the ground across the body: the right hand is -X for a body facing +Z', () => {
    const higherRight = target((x) => -0.2 * x);
    expect(higherRight.roll).toBeCloseTo(-Math.atan(0.2), 6);
    expect(higherRight.pitch).toBeCloseTo(0, 9);
    expect(target((x) => 0.2 * x).roll).toBeCloseTo(Math.atan(0.2), 6);
  });

  it('follows the facing: a body turned a quarter has the same slope as a pitch', () => {
    // Facing +X, ground rising toward +X is rising ahead.
    expect(target((x) => 0.2 * x, Math.PI / 2).pitch).toBeCloseTo(-Math.atan(0.2), 6);
  });

  it('clamps steep ground, ignores a hair of slope and goes level where a side has no ground', () => {
    expect(target((_x, z) => 2 * z).pitch).toBeCloseTo(-MAX_SLOPE_TILT, 12);
    expect(target((_x, z) => 0.004 * z).pitch).toBe(0);
    expect(target((x, z) => z > 0.5 ? null : 0.2 * z)).toEqual({ pitch: 0, roll: 0 });
  });

  it('settles toward the target smoothly, returns level when disabled and ignores a zero-length frame', () => {
    const state = createSlopeAttitude(), goal = { pitch: -0.2, roll: 0.1 };
    settleSlopeAttitude(state, goal, 1 / 60, true);
    expect(state.pitch).toBeLessThan(0);
    expect(state.pitch).toBeGreaterThan(-0.05);
    for (let i = 0; i < 120; i += 1) settleSlopeAttitude(state, goal, 1 / 60, true);
    expect(state.pitch).toBeCloseTo(-0.2, 3);
    const held = { ...state };
    settleSlopeAttitude(state, goal, 0, true);
    expect(state).toEqual(held);
    for (let i = 0; i < 240; i += 1) settleSlopeAttitude(state, goal, 1 / 60, false);
    expect(state).toEqual({ pitch: 0, roll: 0 });
  });
});

/** A four-legged body: pelvis root with four limb chains (hip, knee, ankle, toe) hanging 0.8 m, at the corners of a 0.6 x 0.4 m rectangle. */
function creature() {
  const root = new Group();
  const make = (name: string, x: number, y: number, z: number, parent: Group | Bone): Bone => { const bone = new Bone(); bone.name = name; bone.position.set(x, y, z); parent.add(bone); return bone; };
  const pelvis = make('tripoSpine_0', 0, 0.8, 0, root);
  const limbs: Bone[][] = [];
  for (const [id, x, z] of [['0_Left', 0.2, 0.3], ['0_Right', -0.2, 0.3], ['1_Left', 0.2, -0.3], ['1_Right', -0.2, -0.3]] as const) {
    const chain = [make(`tripo${id}_Limb_0`, x, 0, z, pelvis)];
    chain.push(make(`tripo${id}_Limb_1`, 0, -0.4, 0.03, chain[0]!));
    chain.push(make(`tripo${id}_Limb_2`, 0, -0.4, -0.03, chain[1]!));
    chain.push(make(`tripo${id}_Limb_3`, 0, 0, 0.1, chain[2]!));
    limbs.push(chain);
  }
  root.updateMatrixWorld(true);
  return { root, limbs };
}
const run = (grounding: QuadrupedGrounding, root: Group, frames: number, dt = 1 / 60): void => {
  for (let i = 0; i < frames; i += 1) { grounding.restore(); grounding.apply(dt); root.updateMatrixWorld(true); }
};
const feet = (limbs: Bone[][]): Vector3[] => limbs.map(chain => chain[3]!.getWorldPosition(new Vector3()));

describe('quadruped foot grounding', () => {
  it('needs at least two limb chains', () => {
    const { root, limbs } = creature();
    expect(QuadrupedGrounding.create(root, limbs.slice(0, 1), () => 0)).toBeNull();
    expect(QuadrupedGrounding.create(root, limbs, () => 0)).not.toBeNull();
  });

  it('leaves the clip pose bit-exact on flat ground', () => {
    const { root, limbs } = creature();
    const grounding = QuadrupedGrounding.create(root, limbs, () => 0)!;
    const before = limbs.flat().map(bone => bone.quaternion.toArray());
    run(grounding, root, 60);
    expect(limbs.flat().map(bone => bone.quaternion.toArray())).toEqual(before);
  });

  it('reaches a foot onto a step under it and restores the clip pose afterwards', () => {
    const { root, limbs } = creature();
    // A 12 cm ledge under the front-left foot only.
    const step: GroundHeightFn = (x, z) => x > 0.1 && z > 0.1 ? 0.12 : 0;
    const grounding = QuadrupedGrounding.create(root, limbs, step)!;
    const clip = limbs.flat().map(bone => bone.quaternion.toArray());
    run(grounding, root, 90);
    const [frontLeft, frontRight] = feet(limbs);
    expect(frontLeft!.y).toBeGreaterThan(0.1);
    expect(Math.abs(frontRight!.y)).toBeLessThan(0.02);
    grounding.restore();
    expect(limbs.flat().map(bone => bone.quaternion.toArray())).toEqual(clip);
  });

  it('never moves a foot while the body is airborne', () => {
    const { root, limbs } = creature();
    const grounding = QuadrupedGrounding.create(root, limbs, (x, z) => x > 0.1 && z > 0.1 ? 0.12 : 0)!;
    grounding.grounded = false;
    const before = limbs.flat().map(bone => bone.quaternion.toArray());
    run(grounding, root, 60);
    expect(limbs.flat().map(bone => bone.quaternion.toArray())).toEqual(before);
  });

  it('keeps bone lengths while solving', () => {
    const { root, limbs } = creature();
    const grounding = QuadrupedGrounding.create(root, limbs, (x, z) => x > 0.1 && z > 0.1 ? 0.12 : 0)!;
    const chain = limbs[0]!;
    const length = (a: Bone, b: Bone) => a.getWorldPosition(new Vector3()).distanceTo(b.getWorldPosition(new Vector3()));
    const upper = length(chain[1]!, chain[2]!), lower = length(chain[2]!, chain[3]!);
    run(grounding, root, 90);
    expect(length(chain[1]!, chain[2]!)).toBeCloseTo(upper, 6);
    expect(length(chain[2]!, chain[3]!)).toBeCloseTo(lower, 6);
  });
});
