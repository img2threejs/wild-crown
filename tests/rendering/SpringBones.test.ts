import { describe, expect, it } from 'bun:test';
import { Bone, Group, Vector3 } from 'three';
import { TAIL_SPRING } from '../../src/rendering/ActorProcedural.js';
import { SPRING_MAX_STEP, SpringChain, type SpringSpec } from '../../src/rendering/SpringBones.js';

const SPEC: SpringSpec = TAIL_SPRING;
const SEGMENT = 0.3;

/** A tail of `count` bones hanging behind a root, one bone every 0.3 m along -Z (the clip pose never moves). */
interface TailRig { root: Group; bones: Bone[]; chain: SpringChain }
function tail(count = 5, spec = SPEC): TailRig {
  const root = new Group();
  const bones: Bone[] = [];
  let parent: Group | Bone = root;
  for (let i = 0; i < count; i += 1) {
    const bone = new Bone();
    bone.position.set(0, i === 0 ? 0.5 : 0, i === 0 ? 0 : -SEGMENT);
    parent.add(bone); bones.push(bone); parent = bone;
  }
  root.updateMatrixWorld(true);
  return { root, bones, chain: new SpringChain(bones, spec) };
}
const step = (rig: TailRig, dt: number): void => {
  rig.chain.restore();
  rig.root.updateMatrixWorld(true);
  rig.chain.apply(dt, rig.root.position.x, rig.root.position.y, rig.root.position.z);
  rig.root.updateMatrixWorld(true);
};
const world = (bone: Bone): Vector3 => bone.getWorldPosition(new Vector3());
const tip = (rig: TailRig): Vector3 => world(rig.bones[rig.bones.length - 1]!);
/** Distance between the world positions of consecutive bones. */
const lengths = (rig: TailRig): number[] => rig.bones.slice(1).map((bone, i) => world(bone).distanceTo(world(rig.bones[i]!)));

describe('spring chain', () => {
  it('leaves a resting chain on its clip pose', () => {
    const rig = tail();
    for (let i = 0; i < 120; i += 1) step(rig, 1 / 60);
    // Light gravity droops the tip of a 1.2 m tail by a few centimetres at rest (3.5 cm measured).
    expect(tip(rig).distanceTo(new Vector3(0, 0.5, -SEGMENT * 4))).toBeLessThan(0.05);
  });

  it('lags behind a moving root and settles back when it stops', () => {
    const rig = tail();
    for (let i = 0; i < 30; i += 1) step(rig, 1 / 60);
    const rigid = (): Vector3 => new Vector3(rig.root.position.x, 0.5, rig.root.position.z - SEGMENT * 4);
    let furthest = 0;
    for (let i = 0; i < 60; i += 1) {
      rig.root.position.z += 4 / 60;
      step(rig, 1 / 60);
      furthest = Math.max(furthest, tip(rig).distanceTo(rigid()));
    }
    // The tip trails the rigid pose (root plus the clip offset) by a visible margin while the root moves...
    expect(furthest).toBeGreaterThan(0.05);
    for (let i = 0; i < 240; i += 1) step(rig, 1 / 60);
    // ...and returns to it (a little gravity droop remains).
    expect(tip(rig).distanceTo(rigid())).toBeLessThan(0.05);
  });

  it('overshoots when a moving root stops (secondary motion, not a rigid follow)', () => {
    const rig = tail(5, { stiffness: 14, drag: 3, gravity: 0, limit: 1 });
    for (let i = 0; i < 30; i += 1) step(rig, 1 / 60);
    for (let i = 0; i < 60; i += 1) { rig.root.position.x += 5 / 60; step(rig, 1 / 60); }
    let overshoot = 0;
    for (let i = 0; i < 90; i += 1) { step(rig, 1 / 60); overshoot = Math.max(overshoot, tip(rig).x - rig.root.position.x); }
    expect(overshoot).toBeGreaterThan(0.01);
  });

  it('keeps every bone length exact', () => {
    const rig = tail();
    for (let i = 0; i < 40; i += 1) step(rig, 1 / 60);
    for (let i = 0; i < 240; i += 1) {
      rig.root.position.set(Math.sin(i * 0.1) * 2, 0, Math.cos(i * 0.07) * 3);
      step(rig, 1 / 60);
      for (const length of lengths(rig)) expect(Math.abs(length - SEGMENT)).toBeLessThan(1e-4);
    }
  });

  it('limits the deflection of each bone from its clip direction', () => {
    const rig = tail(4, { ...SPEC, limit: 0.3 });
    for (let i = 0; i < 20; i += 1) step(rig, 1 / 60);
    let widest = 0;
    for (let i = 0; i < 120; i += 1) {
      rig.root.position.x += (i % 2 === 0 ? 1 : -1) * 0.4;
      step(rig, 1 / 60);
      // Bone i's clip direction is its parent's direction (a straight tail), so each bone may bend at most `limit` away from the one above it.
      let above = new Vector3(0, 0, -1);
      for (let index = 0; index < rig.chain.length; index += 1) {
        const direction = world(rig.bones[index + 1]!).sub(world(rig.bones[index]!)).normalize();
        widest = Math.max(widest, Math.acos(Math.min(1, direction.dot(above))));
        above = direction;
      }
    }
    expect(widest).toBeGreaterThan(0.2);
    expect(widest).toBeLessThan(0.3 + 1e-3);
  });
  it('cannot explode: huge frames, a violent root and a teleport stay finite and bounded', () => {
    const rig = tail(8, { stiffness: 40, drag: 1, gravity: 9.8, limit: 3 });
    for (const dt of [1, 5, 0.5, 1 / 60, 100]) {
      for (let i = 0; i < 40; i += 1) {
        rig.root.position.set((Math.sin(i * 7.3) * 4) | 0, 0, (Math.cos(i * 3.1) * 4) | 0);
        step(rig, dt);
        for (const bone of rig.bones) expect(world(bone).toArray().every(Number.isFinite)).toBe(true);
        expect(world(rig.bones[7]!).distanceTo(rig.root.position)).toBeLessThan(8 * SEGMENT + 3);
      }
    }
    rig.root.position.set(5000, 0, -5000);
    step(rig, 1 / 60); step(rig, 1 / 60);
    expect(tip(rig).distanceTo(rig.root.position)).toBeLessThan(8 * SEGMENT + 1);
  });

  it('a frame is clamped to the maximum step, so a long hitch moves the tail no further than one step', () => {
    const slow = tail(), fast = tail();
    for (let i = 0; i < 20; i += 1) { step(slow, 1 / 60); step(fast, 1 / 60); }
    slow.root.position.x = fast.root.position.x = 2;
    step(slow, SPRING_MAX_STEP); step(fast, 30);
    expect(tip(fast).distanceTo(tip(slow))).toBeLessThan(1e-9);
  });

  it('zero-length frames (hit-stop) hold the tail still', () => {
    const rig = tail();
    for (let i = 0; i < 20; i += 1) step(rig, 1 / 60);
    rig.root.position.x = 1;
    step(rig, 1 / 60);
    const held = tip(rig).clone();
    for (let i = 0; i < 10; i += 1) step(rig, 0);
    expect(tip(rig).distanceTo(held)).toBeLessThan(1e-9);
  });

  it('restart at rest after a reset', () => {
    const rig = tail();
    for (let i = 0; i < 20; i += 1) step(rig, 1 / 60);
    rig.root.position.x = 0.8;
    step(rig, 1 / 60);
    rig.chain.reset();
    rig.chain.restore();
    step(rig, 1 / 60);
    expect(tip(rig).x).toBeCloseTo(0.8, 4);
  });
});
