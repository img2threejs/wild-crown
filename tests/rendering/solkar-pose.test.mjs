import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it, before } from 'node:test';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Causal pose regression for Solkar (actor-solkar): the walk and run used to crane the neck until the
// muzzle pointed at the sky, because the ground guard measured the head against its REST height and
// answered the gait's own body dip by pitching the neck up. The neck must now keep the idle's
// carriage through the walk and the run.
//
// The sampler reads the real runtime GLB (the playable actor-solkar-companion.glb) through three's own
// GLTFLoader and keyframe interpolants, and measures the muzzle axis (the Head_2 -> Head_3 world
// direction). The same head-chain measurement is recorded separately in the native preview receipts.

const root = process.cwd();
const FPS = 30;
const COMPANION = 'asset-source/generated/actor-solkar-runtime-01/actor-solkar-companion.glb';
const toArrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const sanitize = name => THREE.PropertyBinding.sanitizeNodeName(name);

/** The head chain's own joints, base first (Solkar's explicit rig: Head_0..Head_3). */
const HEAD_CHAIN = ['tripo::Head_0', 'tripo::Head_1', 'tripo::Head_2', 'tripo::Head_3'];
/** The muzzle axis: from the skull's base (Head_2) to its tip (Head_3). */
const MUZZLE_FROM = 'tripo::Head_2', MUZZLE_TO = 'tripo::Head_3';

/** Elevation of a world direction above the horizontal, in degrees. */
const elevationOf = (a, b) => {
  const d = new THREE.Vector3().subVectors(b, a);
  return Math.asin(Math.max(-1, Math.min(1, d.y / d.length()))) * 180 / Math.PI;
};

describe('Solkar keeps a level head through the walk and the run', () => {
  let asset, clips, head, muzzleFrom, muzzleTo;

  before(async () => {
    const bytes = await readFile(`${root}/${COMPANION}`);
    const gltf = await new GLTFLoader()
      .register(() => ({ name: 'pose-only-material', loadMaterial: () => Promise.resolve(new THREE.MeshBasicMaterial()) }))
      .parseAsync(toArrayBuffer(bytes), '');
    let skinned;
    gltf.scene.traverse(object => { if (object.isSkinnedMesh) skinned = object; });
    assert.ok(skinned, 'the playable companion GLB must contain a skinned mesh');
    const bones = new Map(skinned.skeleton.bones.map(bone => [bone.name, bone]));
    for (const name of HEAD_CHAIN) assert.ok(bones.has(sanitize(name)), `the rig is missing ${name}`);
    const rest = new Map([...bones.values()].map(bone => [bone, { p: bone.position.clone(), q: bone.quaternion.clone() }]));
    asset = { gltf, bones, rest, skinned };
    clips = new Map(gltf.animations.map(clip => [clip.name, clip]));
    head = bones.get(sanitize(MUZZLE_TO));
    muzzleFrom = bones.get(sanitize(MUZZLE_FROM));
    muzzleTo = bones.get(sanitize(MUZZLE_TO));
  });

  /** Poses the rig from a clip at `time` and returns the muzzle elevation in degrees. */
  const muzzleElevationAt = (clipName, time) => {
    const clip = clips.get(clipName);
    assert.ok(clip, `missing clip ${clipName}`);
    for (const [bone, pose] of asset.rest) { bone.position.copy(pose.p); bone.quaternion.copy(pose.q); }
    for (const track of clip.tracks) {
      const dot = track.name.lastIndexOf('.');
      const bone = asset.bones.get(track.name.slice(0, dot));
      if (!bone) continue;
      const values = track.createInterpolant().evaluate(time);
      if (track.name.slice(dot + 1) === 'quaternion') bone.quaternion.fromArray(values).normalize();
      else bone.position.fromArray(values);
    }
    asset.gltf.scene.updateMatrixWorld(true);
    return elevationOf(muzzleFrom.getWorldPosition(new THREE.Vector3()), muzzleTo.getWorldPosition(new THREE.Vector3()));
  };

  /** Muzzle elevation sampled across a full clip cycle. */
  const elevations = clipName => {
    const clip = clips.get(clipName);
    const frames = Math.max(2, Math.round(clip.duration * FPS));
    const muzzle = [];
    for (let f = 0; f < frames; f++) {
      const time = clip.duration * f / frames;
      muzzle.push(muzzleElevationAt(clipName, time));
    }
    return { muzzle };
  };

  const stat = values => ({
    min: Math.min(...values), max: Math.max(...values), mean: values.reduce((sum, v) => sum + v, 0) / values.length,
  });


  it('keeps the walk muzzle at the idle carriage instead of craning the neck at the sky', () => {
    const idle = stat(elevations('monster-idle').muzzle);
    const walk = stat(elevations('monster-walk').muzzle);
    assert.ok(walk.max < 50, `the walk muzzle reaches ${walk.max.toFixed(2)} degrees (the skyward craning)`);
    assert.ok(Math.abs(walk.mean - idle.mean) < 6, `the walk muzzle (${walk.mean.toFixed(2)}) drifted from the idle carriage (${idle.mean.toFixed(2)})`);
  });

  it('keeps the run muzzle at the idle carriage instead of craning the neck at the sky', () => {
    const idle = stat(elevations('monster-idle').muzzle);
    const run = stat(elevations('monster-run').muzzle);
    assert.ok(run.max < 50, `the run muzzle reaches ${run.max.toFixed(2)} degrees (the skyward craning)`);
    assert.ok(Math.abs(run.mean - idle.mean) < 6, `the run muzzle (${run.mean.toFixed(2)}) drifted from the idle carriage (${idle.mean.toFixed(2)})`);
  });

  it('keeps the turn muzzle at the idle carriage too', () => {
    const idle = stat(elevations('monster-idle').muzzle);
    const turn = stat(elevations('monster-turn').muzzle);
    assert.ok(Math.abs(turn.mean - idle.mean) < 6, `the turn muzzle (${turn.mean.toFixed(2)}) drifted from the idle carriage (${idle.mean.toFixed(2)})`);
  });

  it('does not freeze the skeleton: the walk and the run still move the head and the tail', () => {
    for (const clipName of ['monster-walk', 'monster-run']) {
      const clip = clips.get(clipName);
      const frames = Math.round(clip.duration * FPS);
      const tail = asset.bones.get(sanitize('bone_37'));
      let headTravel = 0, tailTravel = 0;
      let previous = null;
      for (let f = 0; f <= frames; f++) {
        const time = Math.min(clip.duration, f / FPS);
        for (const [bone, pose] of asset.rest) { bone.position.copy(pose.p); bone.quaternion.copy(pose.q); }
        for (const track of clip.tracks) {
          const dot = track.name.lastIndexOf('.');
          const bone = asset.bones.get(track.name.slice(0, dot));
          if (!bone) continue;
          const values = track.createInterpolant().evaluate(time);
          if (track.name.slice(dot + 1) === 'quaternion') bone.quaternion.fromArray(values).normalize();
          else bone.position.fromArray(values);
        }
        asset.gltf.scene.updateMatrixWorld(true);
        const now = { head: head.getWorldPosition(new THREE.Vector3()), tail: tail.getWorldPosition(new THREE.Vector3()) };
        if (previous) {
          headTravel += now.head.distanceTo(previous.head);
          tailTravel += now.tail.distanceTo(previous.tail);
        }
        previous = now;
      }
      assert.ok(headTravel > 0.05, `${clipName}: the head barely moved (${headTravel.toFixed(4)})`);
      assert.ok(tailTravel > 0.05, `${clipName}: the tail barely moved (${tailTravel.toFixed(4)})`);
    }
  });

});
