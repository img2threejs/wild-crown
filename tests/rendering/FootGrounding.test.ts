import { describe, expect, it } from 'bun:test';
import { Bone, BufferAttribute, BufferGeometry, Group, MeshBasicMaterial, Quaternion, Skeleton, SkinnedMesh, Vector3 } from 'three';
import { FootGrounding, groundNormalAt, solveTwoBone, type GroundHeightFn } from '../../src/rendering/FootGrounding.js';

const FORWARD = new Vector3(0, 0, 1);

function solve(hip: Vector3, knee: Vector3, ankle: Vector3, target: Vector3, hint = FORWARD) {
  const outKnee = new Vector3(), outAnkle = new Vector3();
  solveTwoBone(hip, knee, ankle, target, hint, outKnee, outAnkle);
  return { outKnee, outAnkle };
}

describe('two-bone solver', () => {
  const hip = new Vector3(0, 1, 0), knee = new Vector3(0, 0.55, 0.05), ankle = new Vector3(0, 0.1, 0);
  const upper = hip.distanceTo(knee), lower = knee.distanceTo(ankle);

  it('reaches a reachable target and preserves both bone lengths', () => {
    for (const target of [new Vector3(0, 0.15, 0), new Vector3(0.1, 0.3, 0.2), new Vector3(0, 0.25, -0.1), new Vector3(-0.2, 0.2, 0.3)]) {
      const { outKnee, outAnkle } = solve(hip, knee, ankle, target);
      expect(outAnkle.distanceTo(target)).toBeLessThan(1e-9);
      expect(hip.distanceTo(outKnee)).toBeCloseTo(upper, 9);
      expect(outKnee.distanceTo(outAnkle)).toBeCloseTo(lower, 9);
    }
  });

  it('keeps the knee on the side of the clip pose', () => {
    const { outKnee } = solve(hip, knee, ankle, new Vector3(0, 0.3, 0));
    expect(outKnee.z).toBeGreaterThan(0.05);
    const backward = solve(hip, new Vector3(0, 0.55, -0.05), ankle, new Vector3(0, 0.3, 0));
    expect(backward.outKnee.z).toBeLessThan(-0.05);
  });

  it('clamps an out-of-reach target short of full extension along the same direction', () => {
    const target = new Vector3(0.3, -0.6, 0.2);
    const { outKnee, outAnkle } = solve(hip, knee, ankle, target);
    const reach = hip.distanceTo(outAnkle);
    expect(reach).toBeLessThan(upper + lower);
    expect(reach).toBeGreaterThan((upper + lower) * 0.99);
    expect(hip.distanceTo(outKnee)).toBeCloseTo(upper, 9);
    expect(outKnee.distanceTo(outAnkle)).toBeCloseTo(lower, 9);
    const toTarget = target.clone().sub(hip).normalize(), toAnkle = outAnkle.clone().sub(hip).normalize();
    expect(toTarget.dot(toAnkle)).toBeCloseTo(1, 9);
  });

  it('never folds the leg inside the shortest reachable distance', () => {
    const { outKnee, outAnkle } = solve(hip, knee, ankle, hip.clone().add(new Vector3(0.001, 0, 0)));
    expect(hip.distanceTo(outAnkle)).toBeGreaterThanOrEqual(Math.abs(upper - lower));
    expect(outKnee.distanceTo(outAnkle)).toBeCloseTo(lower, 9);
    expect(Number.isFinite(outKnee.x + outKnee.y + outKnee.z)).toBe(true);
  });

  it('bends a straight leg toward the body forward axis', () => {
    const straightKnee = new Vector3(0, 0.55, 0), straightAnkle = new Vector3(0, 0.1, 0);
    const { outKnee } = solve(hip, straightKnee, straightAnkle, new Vector3(0, 0.3, 0));
    expect(outKnee.z).toBeGreaterThan(0.1);
    expect(Number.isFinite(outKnee.x + outKnee.y + outKnee.z)).toBe(true);
  });
});

describe('ground normal', () => {
  it('follows the slope and is straight up on flat ground', () => {
    const slope: GroundHeightFn = (x, z) => 0.5 * x - 0.25 * z;
    const n = groundNormalAt(slope, 3, -2, slope(3, -2)!, new Vector3());
    expect(n.length()).toBeCloseTo(1, 9);
    expect(n.x / n.y).toBeCloseTo(-0.5, 6);
    expect(n.z / n.y).toBeCloseTo(0.25, 6);
    const flat = groundNormalAt(() => 1, 0, 0, 1, new Vector3());
    expect(flat.x).toBeCloseTo(0, 12);
    expect(flat.y).toBeCloseTo(1, 12);
    expect(flat.z).toBeCloseTo(0, 12);
    expect(groundNormalAt((x) => x > 0.1 ? null : 0, 0, 0, 0, new Vector3()).y).toBe(1);
  });
});

interface SoleVertex { bone: Bone; bind: Vector3 }
interface Rig { root: Group; bones: Record<string, Bone>; vertices: SoleVertex[] }

/**
 * A Mixamo-named biped: legs hang from the hips with a slightly forward knee, ankle 0.1 m and toe 0.02 m above the actor root.
 * With `sole`, a skinned mesh carries four sole vertices per foot (heel, toe tip and both edges) on the floor plane of the root.
 */
function biped(yaw = 0.7, sole = false): Rig {
  const root = new Group();
  root.rotation.y = yaw;
  const make = (name: string, x: number, y: number, z: number, parent: Group | Bone): Bone => {
    const bone = new Bone();
    bone.name = name.replace(':', '');
    bone.position.set(x, y, z);
    parent.add(bone);
    return bone;
  };
  const hips = make('mixamorig:Hips', 0, 1, 0, root);
  const bones: Record<string, Bone> = { hips };
  for (const [side, x] of [['Left', 0.1], ['Right', -0.1]] as const) {
    const upLeg = make(`mixamorig:${side}UpLeg`, x, 0, 0, hips);
    const leg = make(`mixamorig:${side}Leg`, 0, -0.45, 0.04, upLeg);
    const foot = make(`mixamorig:${side}Foot`, 0, -0.45, -0.04, leg);
    const toe = make(`mixamorig:${side}ToeBase`, 0, -0.08, 0.12, foot);
    Object.assign(bones, { [`${side}UpLeg`]: upLeg, [`${side}Leg`]: leg, [`${side}Foot`]: foot, [`${side}Toe`]: toe });
  }
  const vertices: SoleVertex[] = [];
  if (sole) {
    const positions: number[] = [], skinIndex: number[] = [], skinWeight: number[] = [];
    const carriers = [bones.LeftFoot!, bones.LeftToe!, bones.RightFoot!, bones.RightToe!];
    for (const [side, x] of [['Left', 0.1], ['Right', -0.1]] as const) {
      for (const [dx, dz, toe] of [[0, -0.05, false], [0, 0.17, true], [-0.04, 0.05, false], [0.04, 0.05, false]] as const) {
        const bone = bones[`${side}${toe ? 'Toe' : 'Foot'}`]!;
        positions.push(x + dx, 0, dz);
        skinIndex.push(carriers.indexOf(bone), 0, 0, 0);
        skinWeight.push(1, 0, 0, 0);
        vertices.push({ bone, bind: new Vector3(x + dx, 0, dz) });
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(skinIndex), 4));
    geometry.setAttribute('skinWeight', new BufferAttribute(new Float32Array(skinWeight), 4));
    const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
    root.add(mesh);
    root.updateMatrixWorld(true);
    mesh.bind(new Skeleton(carriers));
    for (const vertex of vertices) vertex.bind = vertex.bone.worldToLocal(root.localToWorld(vertex.bind.clone()));
  }
  root.updateMatrixWorld(true);
  return { root, bones, vertices };
}

const worldPosition = (bone: Bone): Vector3 => bone.getWorldPosition(new Vector3());
const run = (grounding: FootGrounding, root: Group, frames: number, dt = 1 / 60): void => {
  for (let i = 0; i < frames; i += 1) { grounding.restore(); grounding.apply(dt); root.updateMatrixWorld(true); }
};
const pose = (bones: Record<string, Bone>) => Object.values(bones).map(bone => [bone.position.toArray(), bone.quaternion.toArray()]);
/** Lowest sole vertex of one foot above the ground (negative = sunk in). */
const soleClearance = (rig: Rig, side: 'Left' | 'Right', ground: GroundHeightFn): number => {
  let lowest = Infinity;
  for (const { bone, bind } of rig.vertices) {
    if (!bone.name.includes(side)) continue;
    const world = bone.localToWorld(bind.clone());
    lowest = Math.min(lowest, world.y - ground(world.x, world.z)!);
  }
  return lowest;
};
const SLOPE: GroundHeightFn = (x, z) => 0.35 * x + 0.25 * z;

describe('foot grounding', () => {
  it('only exists for a complete Mixamo biped', () => {
    const { root } = biped();
    expect(FootGrounding.create(root, () => 0)).not.toBeNull();
    expect(FootGrounding.create(new Group(), () => 0)).toBeNull();
    const partial = biped().root;
    partial.getObjectByName('mixamorigRightFoot')!.name = 'foot';
    expect(FootGrounding.create(partial, () => 0)).toBeNull();
  });

  it('leaves the clip pose bit-exact on flat ground', () => {
    for (const sole of [false, true]) {
      const { root, bones } = biped(0.7, sole);
      const grounding = FootGrounding.create(root, () => 0)!;
      const before = pose(bones);
      run(grounding, root, 90);
      expect(pose(bones)).toEqual(before);
    }
  });

  it('plants both soles on a slope with unchanged bone lengths and a bent, never overstretched knee', () => {
    const rig = biped(0.7, true), { root, bones } = rig;
    const grounding = FootGrounding.create(root, SLOPE)!;
    const sides = ['Left', 'Right'] as const;
    const lengths = sides.map(side => [worldPosition(bones[`${side}UpLeg`]!).distanceTo(worldPosition(bones[`${side}Leg`]!)), worldPosition(bones[`${side}Leg`]!).distanceTo(worldPosition(bones[`${side}Foot`]!))]);
    const unsettled = sides.map(side => soleClearance(rig, side, SLOPE));
    expect(Math.min(...unsettled)).toBeLessThan(-0.01);
    run(grounding, root, 120);
    sides.forEach((side, index) => {
      const up = worldPosition(bones[`${side}UpLeg`]!), knee = worldPosition(bones[`${side}Leg`]!), ankle = worldPosition(bones[`${side}Foot`]!);
      expect(Math.abs(soleClearance(rig, side, SLOPE))).toBeLessThan(0.012);
      expect(up.distanceTo(knee)).toBeCloseTo(lengths[index]![0]!, 5);
      expect(knee.distanceTo(ankle)).toBeCloseTo(lengths[index]![1]!, 5);
      expect(up.distanceTo(ankle)).toBeLessThan((lengths[index]![0]! + lengths[index]![1]!) * 0.9951);
    });
    const normal = groundNormalAt(SLOPE, 0, 0, 0, new Vector3());
    const footUp = new Vector3(0, 1, 0).applyQuaternion(bones.LeftFoot!.getWorldQuaternion(new Quaternion()));
    expect(footUp.angleTo(normal)).toBeLessThan(0.08);
  });

  it('keeps a lifted foot on its clip target while the planted one is grounded', () => {
    const rig = biped(0.7, true), { root, bones } = rig;
    const ground: GroundHeightFn = (x, z) => 0.35 * x + 0.25 * z - 0.05;
    const grounding = FootGrounding.create(root, ground)!;
    bones.LeftUpLeg!.rotation.x = -1;
    root.updateMatrixWorld(true);
    const clipLeft = worldPosition(bones.LeftFoot!);
    run(grounding, root, 120);
    expect(worldPosition(bones.LeftFoot!).distanceTo(clipLeft)).toBeLessThan(2e-3);
    expect(Math.abs(soleClearance(rig, 'Right', ground))).toBeLessThan(0.012);
  });

  it('lifts a sole that the clip sinks into a slope, to within the contact tolerance', () => {
    const rig = biped(0, true), { root, bones } = rig;
    const grounding = FootGrounding.create(root, SLOPE)!;
    bones.hips!.position.y -= 0.04;
    root.updateMatrixWorld(true);
    expect(Math.min(soleClearance(rig, 'Left', SLOPE), soleClearance(rig, 'Right', SLOPE))).toBeLessThan(-0.04);
    run(grounding, root, 120);
    for (const side of ['Left', 'Right'] as const) {
      const clearance = soleClearance(rig, side, SLOPE);
      expect(clearance).toBeGreaterThan(-0.0075);
      expect(clearance).toBeLessThan(0.0075);
    }
  });

  it('keeps the clip pose as authored on flat ground, even when its soles sink in', () => {
    for (const sink of [0.004, 0.04]) {
      const rig = biped(0, true), { root, bones } = rig;
      const grounding = FootGrounding.create(root, () => 0)!;
      bones.hips!.position.y -= sink;
      root.updateMatrixWorld(true);
      const before = pose(bones);
      run(grounding, root, 90);
      expect(pose(bones)).toEqual(before);
    }
  });

  it('fades in without popping and out when the actor leaves the ground', () => {
    const { root, bones } = biped(0);
    const ground: GroundHeightFn = (x) => 0.45 * x;
    const grounding = FootGrounding.create(root, ground)!;
    const clip = worldPosition(bones.RightFoot!);
    let previous = clip.y, largest = 0;
    for (let i = 0; i < 90; i += 1) {
      grounding.restore(); grounding.apply(i === 0 ? 0 : 1 / 60); root.updateMatrixWorld(true);
      const y = worldPosition(bones.RightFoot!).y;
      largest = Math.max(largest, Math.abs(y - previous));
      previous = y;
    }
    expect(largest).toBeLessThan(0.02);
    expect(Math.abs(previous - clip.y)).toBeGreaterThan(0.03);
    grounding.grounded = false;
    for (let i = 0; i < 40; i += 1) {
      grounding.restore(); grounding.apply(1 / 60); root.updateMatrixWorld(true);
      const y = worldPosition(bones.RightFoot!).y;
      largest = Math.max(largest, Math.abs(y - previous));
      previous = y;
    }
    expect(largest).toBeLessThan(0.04);
    expect(worldPosition(bones.RightFoot!).distanceTo(clip)).toBeLessThan(1e-6);
  });

  it('restores the clip values it overwrote and ignores an actor that is airborne or over no ground', () => {
    const { root, bones } = biped();
    const grounding = FootGrounding.create(root, SLOPE)!;
    const before = pose(bones);
    run(grounding, root, 60);
    expect(Object.values(bones).map(bone => bone.position.toArray())).not.toEqual(before.map(entry => entry[0]));
    grounding.restore();
    expect(pose(bones)).toEqual(before);
    root.position.y = 0.6;
    run(grounding, root, 60);
    expect(pose(bones)).toEqual(before);
    root.position.y = 0;
    const nowhere = FootGrounding.create(root, () => null)!;
    run(nowhere, root, 60);
    expect(pose(bones)).toEqual(before);
  });

  it('drops the pelvis by the largest needed lowering, bounded', () => {
    const { root, bones } = biped(0);
    const hipsY = worldPosition(bones.hips!).y;
    const grounding = FootGrounding.create(root, (x) => x > -0.05 ? -0.1 : -0.8)!;
    run(grounding, root, 120);
    const drop = hipsY - worldPosition(bones.hips!).y;
    expect(drop).toBeGreaterThan(0.3);
    expect(drop).toBeLessThanOrEqual(0.35 + 1e-6);
  });

  it('drops the pelvis only as far as the lowest planted foot needs', () => {
    const { root, bones } = biped(0);
    const hipsY = worldPosition(bones.hips!).y;
    const grounding = FootGrounding.create(root, (x) => x > -0.05 ? 0.03 : -0.12)!;
    run(grounding, root, 120);
    expect(hipsY - worldPosition(bones.hips!).y).toBeCloseTo(0.12, 2);
  });
});

describe('stance foot-lock', () => {
  const DT = 1 / 60, SPEED = 3, CLIP_SPEED = 2.4;

  /**
   * An in-place gait the way Sakda and Vesper play it: the root moves at SPEED along +Z while the clip carries the planted foot (level, on the floor)
   * back in root space at CLIP_SPEED, so the foot slides over the ground at SPEED - CLIP_SPEED = 0.6 m/s. Returns the world left ankle at the start
   * and the end of a stance of `seconds`.
   */
  function stance(lock: boolean, seconds = 0.2) {
    const { root, bones } = biped(0);
    const grounding = FootGrounding.create(root, () => 0)!;
    grounding.footLock = lock;
    run(grounding, root, 40);
    const frame = (t: number) => {
      grounding.restore();
      bones.LeftFoot!.position.z = -0.04 - CLIP_SPEED * (t + DT);
      root.position.z += SPEED * DT;
      root.updateMatrixWorld(true);
      grounding.apply(DT);
      root.updateMatrixWorld(true);
      return worldPosition(bones.LeftFoot!);
    };
    const start = frame(0);
    let end = start;
    for (let i = 1; i <= Math.round(seconds / DT); i += 1) end = frame(i * DT);
    return { grounding, root, bones, start, end, frame };
  }

  it('without the lock a planted foot slides at the speed mismatch', () => {
    const { start, end } = stance(false);
    expect(Math.abs(end.z - start.z)).toBeGreaterThan(0.1);
  });

  it('pins the planted foot: the slide of a stance shrinks from 12 cm to a few', () => {
    const free = stance(false), locked = stance(true);
    const unlockedSlide = Math.abs(free.end.z - free.start.z), lockedSlide = Math.abs(locked.end.z - locked.start.z);
    expect(lockedSlide).toBeLessThan(0.04);
    expect(lockedSlide).toBeLessThan(unlockedSlide / 3);
  });

  it('corrects a short stance completely (the correction is within its 10 cm cap)', () => {
    const { start, end } = stance(true, 0.1);
    expect(Math.abs(end.z - start.z)).toBeLessThan(0.005);
  });

  it('never stretches the leg: the thigh keeps its length and the shin reaches exactly the clip foot offset while pinned', () => {
    const { bones, grounding, frame } = stance(true, 0.1);
    const upper = worldPosition(bones.LeftUpLeg!).distanceTo(worldPosition(bones.LeftLeg!));
    for (let i = 0; i < 20; i += 1) {
      frame(0.1 + i * DT);
      expect(worldPosition(bones.LeftUpLeg!).distanceTo(worldPosition(bones.LeftLeg!))).toBeCloseTo(upper, 6);
      expect(worldPosition(bones.LeftLeg!).distanceTo(worldPosition(bones.LeftFoot!))).toBeCloseTo(bones.LeftFoot!.position.length(), 6);
    }
    expect(grounding.footLock).toBe(true);
  });

  it('lets go when the foot lifts: the clip pose returns once the foot is free', () => {
    const { root, bones, grounding } = stance(true, 0.15);
    for (let i = 0; i < 40; i += 1) {
      grounding.restore();
      bones.LeftUpLeg!.rotation.x = 0.35; bones.LeftLeg!.rotation.x = 0.9;
      root.position.z += SPEED * DT;
      root.updateMatrixWorld(true);
      grounding.apply(DT);
      root.updateMatrixWorld(true);
    }
    const corrected = worldPosition(bones.LeftFoot!);
    grounding.restore();
    root.updateMatrixWorld(true);
    const clip = worldPosition(bones.LeftFoot!);
    expect(corrected.distanceTo(clip)).toBeLessThan(1e-3);
  });

  it('does nothing while the flag is off, leaving the clip pose bit-exact on flat ground', () => {
    const { root, bones } = biped(0.7);
    const grounding = FootGrounding.create(root, () => 0)!;
    grounding.footLock = false;
    const before = pose(bones);
    run(grounding, root, 60);
    expect(pose(bones)).toEqual(before);
  });
});
