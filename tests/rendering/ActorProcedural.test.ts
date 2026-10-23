import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { AnimationMixer, Bone, Group, MeshBasicMaterial, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { GroundingSlot } from '../../src/rendering/AnimationController.js';
import { ActorProcedural } from '../../src/rendering/ActorProcedural.js';
import { createReactionPose, type ReactionPose } from '../../src/rendering/ReactionPresenter.js';
import { findRigBones } from '../../src/rendering/RigBones.js';

/** Mixamo-named torso: Hips → Spine → Spine1 → Spine2 → Neck → Head, standing at the origin facing +Z. Names are sanitized like the glTF loader does. */
function biped() {
  const root = new Group();
  const make = (name: string, y: number, parent: Group | Bone): Bone => { const bone = new Bone(); bone.name = name; bone.position.set(0, y, 0); parent.add(bone); return bone; };
  const hips = make('mixamorigHips', 1, root), spine = make('mixamorigSpine', 0.1, hips), spine1 = make('mixamorigSpine1', 0.15, spine), spine2 = make('mixamorigSpine2', 0.15, spine1);
  const neck = make('mixamorigNeck', 0.2, spine2), head = make('mixamorigHead', 0.12, neck);
  root.updateMatrixWorld(true);
  return { root, hips, spine, spine1, spine2, neck, head };
}

/** Tripo-named creature: pelvis root Spine_0…3, Head_0…2, a four-bone tail, and one limb chain per leg; names sanitized (no colons). */
function creature() {
  const root = new Group();
  const make = (name: string, x: number, y: number, z: number, parent: Group | Bone): Bone => { const bone = new Bone(); bone.name = name; bone.position.set(x, y, z); parent.add(bone); return bone; };
  const pelvis = make('tripoSpine_0', 0, 0.8, 0, root);
  const spine = [pelvis]; for (let i = 1; i <= 3; i += 1) spine.push(make(`tripoSpine_${i}`, 0, 0, 0.3, spine[i - 1]!));
  const head = [make('tripoHead_0', 0, 0.1, 0.2, spine[3]!)]; for (let i = 1; i <= 2; i += 1) head.push(make(`tripoHead_${i}`, 0, 0, 0.15, head[i - 1]!));
  const tail = [make('tripoTail_0', 0, 0, -0.1, pelvis)]; for (let i = 1; i <= 3; i += 1) tail.push(make(`tripoTail_${i}`, 0, 0, -0.25, tail[i - 1]!));
  for (const [id, x, z] of [['0_Left', 0.2, 0.3], ['0_Right', -0.2, 0.3], ['1_Left', 0.2, -0.3], ['1_Right', -0.2, -0.3]] as const) {
    let parent: Bone = make(`tripo${id}_Limb_0`, x, -0.1, z, pelvis);
    for (let i = 1; i <= 3; i += 1) parent = make(`tripo${id}_Limb_${i}`, 0, -0.2, 0, parent);
  }
  root.updateMatrixWorld(true);
  return { root, spine, head, tail };
}

const recorder = () => { const calls: string[] = []; const slot: GroundingSlot = { restore: () => { calls.push('restore'); }, apply: () => { calls.push('apply'); } }; return { calls, slot }; };
const quaternions = (bones: readonly Bone[]): number[][] => bones.map(bone => bone.quaternion.toArray());
const yawOf = (bone: Bone): number => { const d = bone.getWorldDirection(new Vector3()); return Math.atan2(d.x, d.z); };
const pitchOf = (bone: Bone): number => { const d = bone.getWorldDirection(new Vector3()); return Math.atan2(d.y, Math.hypot(d.x, d.z)); };

describe('rig bone discovery', () => {
  it('finds a Mixamo torso and head with their raw or sanitized names', () => {
    const rig = findRigBones(biped().root)!;
    expect(rig.kind).toBe('biped');
    expect(rig.spine.map(bone => bone.name)).toEqual(['mixamorigSpine', 'mixamorigSpine1', 'mixamorigSpine2']);
    expect(rig.head.map(bone => bone.name)).toEqual(['mixamorigNeck', 'mixamorigHead']);
    expect(rig.limbs).toEqual([]);
  });

  it('finds creature spine (without the pelvis root), head, tail and limb chains in order', () => {
    const rig = findRigBones(creature().root)!;
    expect(rig.kind).toBe('creature');
    expect(rig.spine.map(bone => bone.name)).toEqual(['tripoSpine_1', 'tripoSpine_2', 'tripoSpine_3']);
    expect(rig.head.map(bone => bone.name)).toEqual(['tripoHead_0', 'tripoHead_1', 'tripoHead_2']);
    expect(rig.tails.length).toBe(1);
    expect(rig.tails[0]!.map(bone => bone.name)).toEqual(['tripoTail_0', 'tripoTail_1', 'tripoTail_2', 'tripoTail_3']);
    expect(rig.limbs.length).toBe(4);
    expect(rig.limbs.every(limb => limb.length === 4)).toBe(true);
  });

  it('returns null for a rig without any of them, and ignores a single tail bone', () => {
    const empty = new Group(); empty.add(new Bone());
    expect(findRigBones(empty)).toBeNull();
    const lone = new Group(); const bone = new Bone(); bone.name = 'tripoTail_0'; lone.add(bone);
    expect(findRigBones(lone)!.tails).toEqual([]);
  });
});

describe('procedural layer', () => {
  const resting = (): ReactionPose => createReactionPose();
  const frame = (root: Group, slot: ActorProcedural, dt = 1 / 60) => { slot.restore(); root.updateMatrixWorld(true); slot.apply(dt); root.updateMatrixWorld(true); };

  it('detail off skips everything but the wrapped foot grounding', () => {
    const rig = biped(), bones = findRigBones(rig.root)!, { calls, slot: inner } = recorder();
    const procedural = new ActorProcedural(rig.root, bones, inner);
    procedural.inputs.detail = 'off'; procedural.inputs.lookEnabled = true; procedural.inputs.hasTarget = true; procedural.inputs.targetX = 6; procedural.inputs.targetY = 1.5;
    const before = quaternions([...bones.spine, ...bones.head]);
    for (let i = 0; i < 30; i += 1) frame(rig.root, procedural);
    expect(quaternions([...bones.spine, ...bones.head])).toEqual(before);
    expect(calls.filter(call => call === 'apply').length).toBe(30);
  });

  it('look-at turns the head toward a target and restore returns the clip pose exactly', () => {
    const rig = biped(), bones = findRigBones(rig.root)!, procedural = new ActorProcedural(rig.root, bones, null);
    const clip = quaternions([...bones.spine, ...bones.head]);
    procedural.inputs.lookEnabled = true; procedural.inputs.hasTarget = true; procedural.inputs.targetX = 6; procedural.inputs.targetY = 1.45; procedural.inputs.targetZ = 0;
    for (let i = 0; i < 90; i += 1) frame(rig.root, procedural);
    expect(yawOf(rig.head)).toBeGreaterThan(0.5);
    procedural.restore();
    expect(quaternions([...bones.spine, ...bones.head])).toEqual(clip);
  });

  it('a reaction bends the torso and head toward the push and stops the gaze', () => {
    const rig = biped(), bones = findRigBones(rig.root)!, procedural = new ActorProcedural(rig.root, bones, null);
    const pose = resting();
    pose.kind = 'knockback'; pose.dirX = 0; pose.dirZ = -1; pose.spine = 0.4; pose.head = 0.5;
    procedural.inputs.reaction = pose; procedural.inputs.lookEnabled = true; procedural.inputs.hasTarget = true; procedural.inputs.targetX = 6; procedural.inputs.targetY = 1.45;
    frame(rig.root, procedural);
    // Pushed toward -Z (the body faces +Z): the top leans back, so the head looks up and away.
    expect(pitchOf(rig.head)).toBeGreaterThan(0.5);
    expect(Math.abs(yawOf(rig.head))).toBeLessThan(1e-6);
    expect(procedural.lookAt!.strength).toBe(0);
  });

  it('a push to the right tilts the body to its right and a dazed sway rolls it about the facing axis', () => {
    const rig = biped(), bones = findRigBones(rig.root)!, procedural = new ActorProcedural(rig.root, bones, null);
    const pose = resting();
    pose.kind = 'stun'; pose.sway = 0.2; pose.spine = 0.0; pose.head = 0;
    procedural.inputs.reaction = pose;
    frame(rig.root, procedural);
    const up = new Vector3(0, 1, 0).applyQuaternion(rig.spine2.getWorldQuaternion(rig.root.quaternion.clone()));
    // +sway is toward the body's right hand (-X for a +Z-facing body).
    expect(up.x).toBeLessThan(-0.02);
    expect(Math.abs(up.z)).toBeLessThan(1e-6);
  });

  it('springs only the tail and only at full detail; reduced detail restores the tail pose', () => {
    const rig = creature(), bones = findRigBones(rig.root)!, procedural = new ActorProcedural(rig.root, bones, null);
    expect(procedural.springChains.length).toBe(1);
    const clip = quaternions(rig.tail);
    for (let i = 0; i < 20; i += 1) frame(rig.root, procedural);
    for (let i = 0; i < 20; i += 1) { rig.root.position.x += 0.1; frame(rig.root, procedural); }
    expect(quaternions(rig.tail)).not.toEqual(clip);
    procedural.inputs.detail = 'reaction';
    for (let i = 0; i < 3; i += 1) frame(rig.root, procedural);
    expect(quaternions(rig.tail)).toEqual(clip);
  });

  it('keeps the native viper skull and body intact under gaze and reactions across its authored clips', async () => {
    const bytes = await readFile(new URL('../../asset-source/generated/actor-mire-viper-runtime-01/actor-mire-viper-combat.glb', import.meta.url));
    const gltf = await new GLTFLoader().register(() => ({
      name: 'pose-only-material',
      loadMaterial: () => Promise.resolve(new MeshBasicMaterial()),
    })).parseAsync(Uint8Array.from(bytes).buffer, '');
    const root = gltf.scene;
    root.scale.setScalar(7.157);
    root.rotation.y = Math.PI;
    root.updateMatrixWorld(true);
    const meshes: SkinnedMesh[] = [];
    root.traverse(node => { if (node instanceof SkinnedMesh) meshes.push(node); });
    const point = new Vector3();
    const vertices = (): Float64Array[] => {
      root.updateMatrixWorld(true);
      return meshes.map(mesh => {
        mesh.skeleton.update();
        const positions = new Float64Array(mesh.geometry.getAttribute('position').count * 3);
        for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
          mesh.getVertexPosition(vertex, point);
          point.toArray(positions, vertex * 3);
        }
        return positions;
      });
    };
    const difference = (a: Float64Array[], b: Float64Array[]): number => {
      let maximum = 0;
      for (let mesh = 0; mesh < a.length; mesh += 1) {
        for (let index = 0; index < a[mesh]!.length; index += 1) {
          maximum = Math.max(maximum, Math.abs(a[mesh]![index]! - b[mesh]![index]!));
        }
      }
      return maximum;
    };
    const mixer = new AnimationMixer(root);
    const procedural = new ActorProcedural(root, findRigBones(root)!, null);
    procedural.inputs.lookEnabled = true;
    procedural.inputs.hasTarget = true;
    procedural.inputs.targetX = -8;
    procedural.inputs.targetY = 1.45;
    procedural.inputs.targetZ = 1;
    const reaction = resting();
    reaction.kind = 'knockback'; reaction.dirX = 1; reaction.spine = 0.4; reaction.head = 0.5;
    let previousPose: Float64Array[] | undefined;
    let maximumNativeMotion = 0;
    let maximumDistortion = 0;
    for (const clip of gltf.animations) {
      procedural.restore();
      mixer.stopAllAction();
      const action = mixer.clipAction(clip).play();
      mixer.update(clip.duration * 0.4);
      const nativePose = vertices();
      if (previousPose) maximumNativeMotion = Math.max(maximumNativeMotion, difference(nativePose, previousPose));
      previousPose = nativePose;
      procedural.inputs.reaction = undefined;
      for (let frame = 0; frame < 45; frame += 1) {
        procedural.restore();
        root.position.x += 0.02;
        root.updateMatrixWorld(true);
        procedural.apply(1 / 60);
      }
      maximumDistortion = Math.max(maximumDistortion, difference(vertices(), nativePose));
      procedural.restore();
      procedural.inputs.reaction = reaction;
      procedural.apply(1 / 60);
      maximumDistortion = Math.max(maximumDistortion, difference(vertices(), nativePose));
      action.stop();
    }
    procedural.restore();
    mixer.stopAllAction();
    expect(maximumNativeMotion).toBeGreaterThan(0.01);
    expect(maximumDistortion).toBeLessThan(1e-7);
  });

  it('LOD round trip: switching detail off and on again restarts the springs at rest, not with stale velocity', () => {
    const rig = creature(), bones = findRigBones(rig.root)!, procedural = new ActorProcedural(rig.root, bones, null);
    for (let i = 0; i < 20; i += 1) { rig.root.position.x += 0.1; frame(rig.root, procedural); }
    procedural.inputs.detail = 'off';
    frame(rig.root, procedural);
    rig.root.position.x += 10;
    for (let i = 0; i < 5; i += 1) frame(rig.root, procedural);
    procedural.inputs.detail = 'full';
    frame(rig.root, procedural);
    const tip = rig.tail[3]!.getWorldPosition(new Vector3());
    const rest = new Vector3(rig.root.position.x, 0.8, -0.1 - 0.25 * 3);
    expect(tip.distanceTo(rest)).toBeLessThan(0.02);
  });
});
