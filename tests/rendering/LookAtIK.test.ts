import { describe, expect, it } from 'bun:test';
import { Bone, Group, Vector3 } from 'three';
import { BIPED_LOOK_AT, CREATURE_LOOK_AT, LookAtIK, clampLookAngles, lookAngles } from '../../src/rendering/LookAtIK.js';

const DEG = Math.PI / 180;

describe('look angles', () => {
  const angles = { yaw: 0, pitch: 0 };
  it('is zero toward a target straight ahead at eye height', () => {
    lookAngles(0, 1.6, 0, 0, 1, 0, 1.6, 5, angles);
    expect(angles.yaw).toBeCloseTo(0, 12);
    expect(angles.pitch).toBeCloseTo(0, 12);
  });

  it('turns toward the side of the target and up toward a raised one', () => {
    lookAngles(0, 1.6, 0, 0, 1, 5, 1.6, 0, angles);
    expect(angles.yaw).toBeCloseTo(Math.PI / 2, 9);
    lookAngles(0, 1.6, 0, 0, 1, -5, 1.6, 0, angles);
    expect(angles.yaw).toBeCloseTo(-Math.PI / 2, 9);
    lookAngles(0, 1.6, 0, 0, 1, 0, 6.6, 5, angles);
    expect(angles.pitch).toBeCloseTo(Math.PI / 4, 9);
    lookAngles(0, 1.6, 0, 0, 1, 0, -3.4, 5, angles);
    expect(angles.pitch).toBeCloseTo(-Math.PI / 4, 9);
  });

  it('is relative to the body forward, not the world', () => {
    lookAngles(0, 1.6, 0, 1, 0, 5, 1.6, 0, angles);
    expect(angles.yaw).toBeCloseTo(0, 12);
  });

  it('survives a target exactly overhead', () => {
    lookAngles(0, 1.6, 0, 0, 1, 0, 9, 0, angles);
    expect(angles.yaw).toBe(0);
    expect(angles.pitch).toBeCloseTo(Math.PI / 2, 12);
  });
});

describe('look clamps', () => {
  it('clamps yaw and pitch to the spec', () => {
    const a = { yaw: 80 * DEG, pitch: -60 * DEG };
    clampLookAngles(BIPED_LOOK_AT, a);
    expect(a.yaw).toBeCloseTo(BIPED_LOOK_AT.yawLimit, 12);
    expect(a.pitch).toBeCloseTo(-BIPED_LOOK_AT.pitchLimit, 12);
    const b = { yaw: 70 * DEG, pitch: 40 * DEG };
    clampLookAngles(CREATURE_LOOK_AT, b);
    expect(b.yaw).toBeCloseTo(CREATURE_LOOK_AT.yawLimit, 12);
    expect(b.pitch).toBeCloseTo(CREATURE_LOOK_AT.pitchLimit, 12);
  });

  it('keeps angles inside the limit untouched', () => {
    const a = { yaw: 20 * DEG, pitch: -10 * DEG };
    clampLookAngles(BIPED_LOOK_AT, a);
    expect(a.yaw).toBeCloseTo(20 * DEG, 12);
    expect(a.pitch).toBeCloseTo(-10 * DEG, 12);
  });

  it('returns a target behind the body to neutral instead of whipping the head around', () => {
    const a = { yaw: 175 * DEG, pitch: 20 * DEG };
    clampLookAngles(BIPED_LOOK_AT, a);
    expect(a.yaw).toBe(0);
    expect(a.pitch).toBe(0);
    const edge = { yaw: 120 * DEG, pitch: 0 };
    clampLookAngles(BIPED_LOOK_AT, edge);
    expect(edge.yaw).toBeGreaterThan(0);
    expect(edge.yaw).toBeLessThan(BIPED_LOOK_AT.yawLimit);
  });
});

/** Bones of a spine-neck-head chain standing at the origin facing +Z, with their clip pose being identity. */
interface ChainRig { root: Group; bones: Bone[]; head: Bone }
function chain(): ChainRig {
  const root = new Group();
  const make = (y: number, parent: Group | Bone): Bone => { const bone = new Bone(); bone.position.set(0, y, 0); parent.add(bone); return bone; };
  const spine = make(1, root), spine1 = make(0.15, spine), spine2 = make(0.15, spine1), neck = make(0.2, spine2), head = make(0.12, neck);
  root.updateMatrixWorld(true);
  return { root, bones: [spine, spine1, spine2, neck, head], head };
}
const forwardYaw = (bone: Bone): number => { const d = bone.getWorldDirection(new Vector3()); return Math.atan2(d.x, d.z); };
const forwardPitch = (bone: Bone): number => { const d = bone.getWorldDirection(new Vector3()); return Math.atan2(d.y, Math.hypot(d.x, d.z)); };
/** One frame the way the animation controller runs it: the clip pose (identity) is restored, then the look-at is applied on top. */
const run = (rig: ChainRig, look: LookAtIK, frames: number, enabled: boolean, target: [number, number, number], dt = 1 / 60): void => {
  for (let i = 0; i < frames; i += 1) {
    for (const bone of rig.bones) bone.quaternion.identity();
    rig.root.updateMatrixWorld(true);
    look.apply(dt, enabled, true, 0, 1, ...target);
    rig.root.updateMatrixWorld(true);
  }
};

describe('look-at on a bone chain', () => {
  it('turns the head toward the target by at most the clamp and spreads the turn over the chain', () => {
    const rig = chain(), look = new LookAtIK(rig.bones, BIPED_LOOK_AT);
    run(rig, look, 120, true, [6, 1.5, 0]);
    expect(forwardYaw(rig.head)).toBeGreaterThan(BIPED_LOOK_AT.yawLimit * 0.95);
    expect(forwardYaw(rig.head)).toBeLessThan(BIPED_LOOK_AT.yawLimit + 1e-6);
    expect(forwardYaw(rig.bones[0]!)).toBeGreaterThan(0.03);
    expect(forwardYaw(rig.bones[0]!)).toBeLessThan(forwardYaw(rig.head) * 0.2);
  });

  it('is smoothed: one frame never snaps the head', () => {
    const rig = chain(), look = new LookAtIK(rig.bones, BIPED_LOOK_AT);
    run(rig, look, 1, true, [6, 1.5, 0]);
    expect(Math.abs(forwardYaw(rig.head))).toBeLessThan(5 * DEG);
  });

  it('looks up and down within the pitch clamp', () => {
    const rig = chain(), look = new LookAtIK(rig.bones, BIPED_LOOK_AT);
    run(rig, look, 120, true, [0, 12, 3]);
    expect(forwardPitch(rig.head)).toBeGreaterThan(BIPED_LOOK_AT.pitchLimit * 0.9);
    expect(forwardPitch(rig.head)).toBeLessThan(BIPED_LOOK_AT.pitchLimit + 1e-6);
  });

  it('fades back to the clip pose when disabled, and reports it unchanged', () => {
    const rig = chain(), look = new LookAtIK(rig.bones, BIPED_LOOK_AT);
    run(rig, look, 90, true, [6, 1.5, 0]);
    const restore = () => { for (const bone of rig.bones) bone.quaternion.identity(); };
    for (let i = 0; i < 120; i += 1) { restore(); rig.root.updateMatrixWorld(true); look.apply(1 / 60, false, true, 0, 1, 6, 1.5, 0); }
    expect(look.strength).toBe(0);
    expect(Math.abs(forwardYaw(rig.head))).toBeLessThan(1e-9);
    restore(); rig.root.updateMatrixWorld(true);
    expect(look.apply(1 / 60, false, false, 0, 1, 0, 0, 0)).toBe(false);
  });

  it('a target behind the body returns the gaze to neutral', () => {
    const rig = chain(), look = new LookAtIK(rig.bones, BIPED_LOOK_AT);
    run(rig, look, 90, true, [0, 1.5, -6]);
    expect(Math.abs(forwardYaw(rig.head))).toBeLessThan(2 * DEG);
  });

  it('never leaves a non-finite rotation, whatever the target', () => {
    const rig = chain(), look = new LookAtIK(rig.bones, BIPED_LOOK_AT);
    for (const target of [[0, 1.6 + 1, 0], [0, 1.6, 0], [1e-9, 50, 1e-9], [1e6, -1e6, 1e6]] as [number, number, number][]) run(rig, look, 10, true, target);
    for (const bone of rig.bones) expect(bone.quaternion.toArray().every(Number.isFinite)).toBe(true);
  });

  it('a creature head chain with no explicit weights splits the turn evenly', () => {
    const rig = chain(), look = new LookAtIK(rig.bones.slice(2), CREATURE_LOOK_AT);
    run(rig, look, 120, true, [6, 1.5, 0]);
    expect(forwardYaw(rig.head)).toBeGreaterThan(CREATURE_LOOK_AT.yawLimit * 0.95);
    expect(forwardYaw(rig.head)).toBeLessThan(CREATURE_LOOK_AT.yawLimit + 1e-6);
  });
});
