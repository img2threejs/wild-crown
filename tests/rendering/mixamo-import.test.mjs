import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Quaternion, Vector3 } from 'three';
import { parseGlb } from '../../scripts/assets/import-aren-animation-set.mjs';
import { Rig, buildClip, retargetFrames } from '../../scripts/assets/retarget-aren-tripo-clips.mjs';
import { loadMixamoDonor, normalizeBoneName, pinHipsHorizontal, resolveMixamoSources } from '../../scripts/assets/mixamo-import.mjs';

/**
 * The Mixamo FBX donor loader (scripts/assets/mixamo-import.mjs).
 *   1. Proof on a Tripo `--out-format fbx` export of preset `front_kick_01` on Sakda's own rig (task e9c57a60): the FBX's bone tracks map, the duration is right
 *      and the pose retargeted onto the hero matches the same preset's GLB (task 743269a9).
 *   2. Real Mixamo "Without Skin" files (asset-source/mixamo/*): units, heading, T-pose → A-pose alignment, in-place pinning and `buildClip` integration.
 * Fixtures that are not present in the checkout (the Mixamo files are licence-restricted, the Tripo FBX is 90 MB) skip their tests instead of failing.
 */
const root = new URL('../../', import.meta.url).pathname;
const generated = `${root}asset-source/generated/`;
const SAKDA_RIG = `${generated}actor-sakda-hero-mixamo-rig-01/tripo-out/actor-sakda-hero-mixamo-rig-01-f646d7e4/model.glb`;
const VESPER_RIG = `${generated}actor-vesper-hero-mixamo-rig-01/tripo-out/actor-vesper-hero-mixamo-rig-01-2-97eb3992/model.glb`;
const TRIPO_FBX = `${generated}actor-sakda-hero-anim-fbx-01/tripo-out/actor-sakda-hero-anim-fbx-01-e9c57a60/model.fbx`;
const KICK_GLB = `${generated}actor-sakda-hero-anim-c-01/tripo-out/actor-sakda-hero-anim-c-01-743269a9/model.glb`;
const mixamo = (hero, name) => `${root}asset-source/mixamo/${hero}/${name}.fbx`;
const loadRig = async (path) => new Rig(parseGlb(await readFile(path)));
const skipUnless = (...paths) => paths.find((path) => !existsSync(path)) === undefined ? false : 'fixture not present in this checkout';
const angle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * 180 / Math.PI;
const BONE_CHILDREN = { Hips: 'Spine', Spine: 'Spine1', Spine2: 'Neck', Neck: 'Head', LeftArm: 'LeftForeArm', LeftForeArm: 'LeftHand', RightArm: 'RightForeArm', RightForeArm: 'RightHand',
  LeftUpLeg: 'LeftLeg', LeftLeg: 'LeftFoot', RightUpLeg: 'RightLeg', RightLeg: 'RightFoot', };
const direction = (rig, world, from, to, out) => out.setFromMatrixPosition(world[rig.index.get(`mixamorig:${to}`)]).sub(new Vector3().setFromMatrixPosition(world[rig.index.get(`mixamorig:${from}`)])).normalize();

/** Largest angle (degrees) between every hero bone and the donor bone it follows, over every frame of the clip. */
function boneDirectionError(target, donor, count, frames, decoded) {
  const a = new Vector3(), b = new Vector3();
  let worst = 0;
  for (let k = 0; k < count; k += 1) {
    const world = target.poseFrame(frames, k).map((matrix) => matrix.clone()), donorWorld = donor.pose(decoded, k / 30);
    for (const [from, to] of Object.entries(BONE_CHILDREN)) worst = Math.max(worst, Math.acos(Math.min(1, direction(target, world, from, to, a).dot(direction(donor, donorWorld, from, to, b)))) * 180 / Math.PI);
  }
  return worst;
}

test('bone names fold to the Mixamo form', () => {
  assert.equal(normalizeBoneName('mixamorigHips'), 'mixamorig:Hips');
  assert.equal(normalizeBoneName('mixamorig1:LeftArm'), 'mixamorig:LeftArm');
  assert.equal(normalizeBoneName('mixamorig:RightFoot'), 'mixamorig:RightFoot');
  assert.equal(normalizeBoneName('Root'), 'Root');
});

test('pinHipsHorizontal removes Hips travel along the ground and keeps the vertical bob', () => {
  const values = Float32Array.from([0, 1, 0, 0.5, 1.1, 0.25, 2, 1, -3]);
  const times = Float32Array.from([0, 1, 2]);
  const bin = Buffer.concat([Buffer.from(times.buffer), Buffer.from(values.buffer)]);
  const source = {
    json: {
      nodes: [{ name: '__parent', children: [1] }, { name: 'mixamorig:Hips', translation: [0, 1, 0] }], skins: [{ joints: [1] }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
      accessors: [{ bufferView: 0, byteOffset: 0, componentType: 5126, count: 3, type: 'SCALAR' }, { bufferView: 0, byteOffset: 12, componentType: 5126, count: 3, type: 'VEC3' }],
      animations: [{ name: 'travel', samplers: [{ input: 0, output: 1, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }] }],
    },
    bin,
  };
  pinHipsHorizontal(source, new Rig(source), 1);
  const track = new Rig(source).decodeAnimation('travel').tracks.get(1).translation.values;
  assert.deepEqual(Array.from(track), [0, 1, 0, 0, 1.1, 0, 0, 1, 0].map((value) => Math.fround(value)));
});

test('Tripo FBX of front_kick_01 loads on Sakda\'s rig and retargets like the GLB of the same preset', { skip: skipUnless(TRIPO_FBX, KICK_GLB, SAKDA_RIG), timeout: 600000 }, async () => {
  const target = await loadRig(SAKDA_RIG), glb = await loadRig(KICK_GLB);
  const donor = await loadMixamoDonor(TRIPO_FBX, { target });
  assert.equal(donor.bindPose, true, 'a skinned FBX takes its rest from the bind pose');
  assert.equal(donor.unitScale, 0.01);
  assert.ok(Math.abs(donor.facingDegrees) < 1, `same rig family keeps its heading, got ${donor.facingDegrees}`);

  // Every mixamorig joint of the hero exists in the FBX skeleton at the same rest position (bind pose + unit conversion), and has a rotation track.
  const decoded = donor.rig.decodeAnimation(donor.animation), glbDecoded = glb.decodeAnimation('front_kick_01');
  const joints = target.joints.map((node) => target.names[node]).filter((name) => name.startsWith('mixamorig:'));
  assert.equal(joints.length, 22);
  for (const name of joints) {
    const node = donor.rig.index.get(name);
    assert.ok(node !== undefined, `${name} missing from the FBX skeleton`);
    assert.ok(decoded.tracks.get(node)?.rotation, `${name} has no rotation track`);
    assert.ok(donor.rig.restWorldPosition[node].distanceTo(target.restWorldPosition[target.index.get(name)]) < 1e-3, `${name} rest position differs from the hero's`);
  }

  // Duration: the FBX take starts at t = 0 and is 2.5 s; the GLB of the preset carries the same 76 keys shifted by one frame (it starts at 1/30 s).
  assert.ok(Math.abs(donor.duration - 2.5) < 1e-3, `duration ${donor.duration}`);
  assert.ok(Math.abs(glbDecoded.duration - donor.duration - 1 / 30) < 1e-3);
  assert.equal(donor.frames, 76);

  // Pose match. Tripo's FBX writes some tracks key-reduced (it keeps the key values but not the curve tangents, which FBXLoader cannot evaluate) and the GLB
  // animates the Root bone that the FBX leaves still, so the comparison is made on the joints whose FBX track is as dense as the GLB's: their retargeted
  // local rotation (hero joint frame) is the GLB's, frame for frame.
  const count = 75, fromFbx = retargetFrames(target, donor.rig, decoded, count, (k) => k / 30), fromGlb = retargetFrames(target, glb, glbDecoded, count, (k) => k / 30 + 1 / 30);
  const dense = joints.filter((name) => !['Root', 'mixamorig:Hips'].includes(name) && decoded.tracks.get(donor.rig.index.get(name)).rotation.times.length === glbDecoded.tracks.get(glb.index.get(name)).rotation.times.length);
  assert.ok(dense.length >= 6, `only ${dense.length} dense joints`);
  const a = new Quaternion(), b = new Quaternion();
  let worst = 0;
  for (const name of dense) {
    const node = target.index.get(name);
    for (let k = 0; k < count; k += 1) worst = Math.max(worst, angle(a.fromArray(fromFbx.rotations[node], k * 4), b.fromArray(fromGlb.rotations[node], k * 4)));
  }
  assert.ok(worst < 0.5, `retargeted local rotations differ by up to ${worst.toFixed(2)}°`);
  // Every bone of the hero follows the donor bone's direction.
  assert.ok(boneDirectionError(target, donor.rig, count, fromFbx, decoded) < 0.5);
});

test('real Mixamo roundhouse-rear on Sakda: units, heading, rest alignment, in-place pinning', { skip: skipUnless(mixamo('sakda', 'roundhouse-rear'), mixamo('sakda', 'flying-knee-punch'), SAKDA_RIG), timeout: 300000 }, async () => {
  const target = await loadRig(SAKDA_RIG);
  const donor = await loadMixamoDonor(mixamo('sakda', 'roundhouse-rear'), { target });
  assert.equal(donor.unitScale, 0.01, 'Mixamo files are centimetres');
  const hipsDonor = donor.rig.restWorldPosition[donor.rig.index.get('mixamorig:Hips')];
  assert.ok(hipsDonor.y > 0.9 && hipsDonor.y < 1.1, `hips rest height ${hipsDonor.y} m`);
  assert.equal(donor.rig.names.filter((name) => name.startsWith('mixamorig:')).length, 65, 'the full Mixamo skeleton');
  assert.ok(Math.abs(donor.duration - 1.5) < 0.02 && donor.frames === 46, `duration ${donor.duration}, ${donor.frames} frames`);
  assert.ok(donor.facingDegrees > 85 && donor.facingDegrees < 95, `Y Bot faces +Z, the hero +X: turn ${donor.facingDegrees}°`);
  assert.ok(donor.alignment.RightArm > 20, 'the T-pose arms differ from the hero A-pose');

  const decoded = donor.rig.decodeAnimation(donor.animation);
  for (const name of target.joints.map((node) => target.names[node]).filter((joint) => joint.startsWith('mixamorig:'))) assert.ok(decoded.tracks.get(donor.rig.index.get(name))?.rotation, `${name} has no track`);
  const count = donor.frames, frames = retargetFrames(target, donor.rig, decoded, count, (k) => k / 30);
  assert.ok(boneDirectionError(target, donor.rig, count, frames, decoded) < 0.5, 'every hero bone follows the donor bone');
  // The kicking right foot reaches well in front of the hips (+X), at hip height: a rear roundhouse, not a sideways or backwards swing.
  const hips = new Vector3(), foot = new Vector3();
  let reach = -Infinity;
  for (let k = 0; k < count; k += 1) {
    const world = target.poseFrame(frames, k);
    hips.setFromMatrixPosition(world[target.index.get('mixamorig:Hips')]);
    foot.setFromMatrixPosition(world[target.index.get('mixamorig:RightFoot')]).sub(hips);
    reach = Math.max(reach, foot.x);
  }
  assert.ok(reach > 0.4, `kick reach ${reach.toFixed(2)}`);

  // In place: flying-knee-punch travels 3.8 m; `inPlace` pins it.
  const free = await loadMixamoDonor(mixamo('sakda', 'flying-knee-punch'), { target }), pinned = await loadMixamoDonor(mixamo('sakda', 'flying-knee-punch'), { target, inPlace: true });
  const travel = (rig, animation) => {
    const track = rig.decodeAnimation(animation).tracks.get(rig.index.get('mixamorig:Hips')).translation.values, last = track.length / 3 - 1;
    return Math.hypot(track[last * 3] - track[0], track[last * 3 + 2] - track[2]);
  };
  assert.ok(travel(free.rig, free.animation) > 3, 'the file travels');
  assert.ok(travel(pinned.rig, pinned.animation) < 1e-4, 'in place pins the travel');
});

test('spec sources {donor:"mixamo"} resolve and build through buildClip (strike on its tick)', { skip: skipUnless(mixamo('sakda', 'roundhouse-rear'), SAKDA_RIG), timeout: 300000 }, async () => {
  const rigs = { target: await loadRig(SAKDA_RIG) };
  const spec = { clip: 'test-roundhouse', source: { donor: 'mixamo', file: 'asset-source/mixamo/sakda/roundhouse-rear.fbx' }, sim: { totalTicks: 32, activeTick: 14 }, window: [0.2, 1.3], contact: { joints: ['RightFoot'], search: [0.3, 1.2], settle: 0 } };
  const provenance = await resolveMixamoSources([spec], rigs, root);
  const entry = provenance['asset-source/mixamo/sakda/roundhouse-rear.fbx'];
  assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  assert.ok(spec.source.donor.startsWith('mixamo:') && rigs[spec.source.donor] instanceof Rig);
  const clip = buildClip(spec, rigs);
  assert.equal(clip.count, Math.round(32 / 60 * 30) + 1);
  assert.ok(Math.abs(clip.contact.outputFraction - 14 / 32) < 1e-9);
  assert.ok(clip.contact.source >= 0.3 && clip.contact.source <= 1.2, `contact at ${clip.contact.source}s of the source`);
  const hipsTrack = clip.frames.positions[rigs.target.index.get('mixamorig:Hips')];
  assert.ok(hipsTrack.every(Number.isFinite));
});

test('real Mixamo sword clip on Vesper keeps every bone on the donor direction', { skip: skipUnless(mixamo('vesper', 'sword-outward-slash'), VESPER_RIG), timeout: 300000 }, async () => {
  const target = await loadRig(VESPER_RIG);
  const donor = await loadMixamoDonor(mixamo('vesper', 'sword-outward-slash'), { target });
  assert.ok(Math.abs(donor.duration - 2.033) < 0.02 && donor.frames === 62);
  const decoded = donor.rig.decodeAnimation(donor.animation), frames = retargetFrames(target, donor.rig, decoded, donor.frames, (k) => k / 30);
  assert.ok(boneDirectionError(target, donor.rig, donor.frames, frames, decoded) < 0.5);
});

for (const [facing, heading] of [['+Z', 0], ['+X', Math.PI / 2], ['diagonal', Math.PI / 4]]) {
  test(`mirroring a ${facing}-facing rig swaps sides without reversing its forward stroke or root travel`, () => {
    const yaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), heading);
    const source = { json: {
      nodes: [
        { name: 'mixamorig:Hips', translation: [0, 1, 0], rotation: yaw.toArray(), children: [1, 2, 3, 4] },
        { name: 'mixamorig:LeftUpLeg', translation: [-0.2, -0.1, 0] },
        { name: 'mixamorig:RightUpLeg', translation: [0.2, -0.1, 0] },
        { name: 'mixamorig:LeftHand', translation: [-0.5, 0.5, 0] },
        { name: 'mixamorig:RightHand', translation: [0.5, 0.5, 0] },
      ],
      skins: [{ joints: [0, 1, 2, 3, 4] }],
    }, bin: Buffer.alloc(0) };
    const donor = new Rig(source), target = new Rig(source);
    const handTurn = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 3)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 6));
    const travel = new Vector3(0.2, 0.1, 0.4).applyQuaternion(yaw);
    const decoded = { duration: 1, tracks: new Map([
      [0, { translation: { times: Float32Array.from([0, 1]), values: Float32Array.from([0, 1, 0, travel.x, 1 + travel.y, travel.z]) } }],
      [3, { rotation: { times: Float32Array.from([0, 1]), values: Float32Array.from([0, 0, 0, 1, ...handTurn.toArray()]) } }],
    ]) };
    for (const mirrored of [false, true]) {
      const frames = retargetFrames(target, donor, decoded, 2, (k) => k, mirrored);
      const world = target.poseFrame(frames, 1), inverseYaw = yaw.clone().invert();
      const hips = new Vector3().setFromMatrixPosition(world[0]).sub(new Vector3(0, 1, 0)).applyQuaternion(inverseYaw);
      assert.ok(hips.distanceTo(new Vector3(mirrored ? -0.2 : 0.2, 0.1, 0.4)) < 1e-6, `${facing}: forward root travel must not reverse`);
      const moved = mirrored ? 4 : 3, still = mirrored ? 3 : 4;
      const direction = new Vector3(0, 1, 0).transformDirection(world[moved]).applyQuaternion(inverseYaw);
      const expected = new Vector3(0, 1, 0).applyQuaternion(handTurn);
      if (mirrored) expected.x = -expected.x;
      assert.ok(expected.z > 0.7, 'the source stroke points forward');
      assert.ok(direction.distanceTo(expected) < 1e-6, `${facing}: the opposite hand must retain forward/upward motion`);
      assert.ok(new Vector3(0, 1, 0).transformDirection(world[still]).applyQuaternion(inverseYaw).distanceTo(new Vector3(0, 1, 0)) < 1e-6, 'the other hand retains its rest orientation');
    }
  });
}
