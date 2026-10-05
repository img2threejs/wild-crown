import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { AnimationMixer, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Node-only GLTFLoader environment. Decode actual embedded textures with sharp;
// no browser, renderer, replacement materials or skipped textures are used.
globalThis.self = globalThis;
globalThis.ProgressEvent ??= class ProgressEvent { constructor(type, values) { this.type = type; Object.assign(this, values); } };
const decodedImages = [];
globalThis.createImageBitmap = async blob => {
  const { data, info } = await sharp(Buffer.from(await blob.arrayBuffer())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  decodedImages.push({ width: info.width, height: info.height, channels: info.channels, decodedBytes: data.length });
  return { data, width: info.width, height: info.height, close() {} };
};

const files = process.argv.slice(2);
assert(files.length, 'Pass one or more provider-native GLBs');
const reports = [];
for (const file of files) {
  const bytes = await readFile(file);
  const jsonLength = bytes.readUInt32LE(12);
  const document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString().trim());
  const decodedStart = decodedImages.length;
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  gltf.scene.updateMatrixWorld(true);
  const meshes = [], bones = [];
  gltf.scene.traverse(node => { if (node.isSkinnedMesh) meshes.push(node); if (node.isBone) bones.push(node); });
  assert(meshes.length && bones.length, 'Native GLB must load real SkinnedMesh and Bone objects');
  const skinReports = meshes.map(mesh => {
    const position = mesh.geometry.getAttribute('position');
    const joints = mesh.geometry.getAttribute('skinIndex');
    const weights = mesh.geometry.getAttribute('skinWeight');
    assert(joints && weights && position.count === joints.count && joints.count === weights.count);
    let invalidJointInfluences = 0, nonfiniteWeights = 0, zeroWeightVertices = 0, maxWeightSumError = 0;
    const usedJoints = new Set();
    for (let i = 0; i < joints.count; i++) {
      let sum = 0;
      for (let c = 0; c < weights.itemSize; c++) {
        const weight = weights.array[i * weights.itemSize + c];
        const joint = joints.array[i * joints.itemSize + c];
        if (!Number.isFinite(weight) || weight < 0) nonfiniteWeights++;
        if (weight > 0) { usedJoints.add(joint); if (!Number.isInteger(joint) || joint >= mesh.skeleton.bones.length || joint < 0) invalidJointInfluences++; }
        sum += weight;
      }
      if (sum === 0) zeroWeightVertices++;
      maxWeightSumError = Math.max(maxWeightSumError, Math.abs(sum - 1));
    }
    assert.equal(invalidJointInfluences, 0);
    assert.equal(nonfiniteWeights, 0);
    assert.equal(zeroWeightVertices, 0);
    assert(maxWeightSumError < 0.001, 'Native skin weights must sum to one');
    return { mesh: mesh.name, vertices: position.count, bones: mesh.skeleton.bones.length, usedJoints: usedJoints.size, invalidJointInfluences, nonfiniteWeights, zeroWeightVertices, maxWeightSumError };
  });
  const jointNodeIds = new Set((document.skins || []).flatMap(skin => skin.joints));
  const channelReports = (document.animations || []).map(clip => ({ name: clip.name ?? null, channels: clip.channels.length, channelsTargetingSkinJoints: clip.channels.filter(channel => jointNodeIds.has(channel.target.node)).length, paths: [...new Set(clip.channels.map(channel => channel.target.path))], targetNodeCount: new Set(clip.channels.map(channel => channel.target.node)).size }));
  const clipReports = [];
  for (const clip of gltf.animations) {
    assert(clip.duration > 0 && Number.isFinite(clip.duration));
    assert(clip.tracks.length && clip.tracks.every(track => [...track.times, ...track.values].every(Number.isFinite)));
    const mixer = new AnimationMixer(gltf.scene);
    const action = mixer.clipAction(clip).play();
    mixer.setTime(0);
    gltf.scene.updateMatrixWorld(true);
    const initialBoneMatrices = bones.map(bone => bone.matrixWorld.elements.slice());
    const samples = meshes.flatMap(mesh => {
      const count = mesh.geometry.getAttribute('position').count;
      return Array.from({ length: Math.min(128, count) }, (_, i) => {
        const index = Math.floor(i * (count - 1) / Math.max(1, Math.min(128, count) - 1));
        const initial = new Vector3().fromBufferAttribute(mesh.geometry.getAttribute('position'), index);
        mesh.applyBoneTransform(index, initial);
        return { mesh, index, initial };
      });
    });
    const changedBones = new Set(), changedVertices = new Set();
    let maxSampleVertexDisplacement = 0;
    for (const fraction of [0.25, 0.5, 0.75]) {
      mixer.setTime(clip.duration * fraction);
      gltf.scene.updateMatrixWorld(true);
      bones.forEach((bone, i) => {
        assert(bone.matrixWorld.elements.every(Number.isFinite));
        if (bone.matrixWorld.elements.some((value, j) => Math.abs(value - initialBoneMatrices[i][j]) > 1e-7)) changedBones.add(i);
      });
      samples.forEach((sample, i) => {
        const current = new Vector3().fromBufferAttribute(sample.mesh.geometry.getAttribute('position'), sample.index);
        sample.mesh.applyBoneTransform(sample.index, current);
        assert([current.x, current.y, current.z].every(Number.isFinite));
        const displacement = current.distanceTo(sample.initial);
        maxSampleVertexDisplacement = Math.max(maxSampleVertexDisplacement, displacement);
        if (displacement > 1e-7) changedVertices.add(i);
      });
    }
    assert(changedBones.size && changedVertices.size, 'Native clip must animate skin bones and deform sampled vertices');
    clipReports.push({ name: clip.name, durationSeconds: clip.duration, tracks: clip.tracks.length, trackValueTypes: [...new Set(clip.tracks.map(track => track.ValueTypeName))], sampledFractions: [0, 0.25, 0.5, 0.75], changedBones: changedBones.size, sampledVertices: samples.length, changedSampleVertices: changedVertices.size, maxSampleVertexDisplacement });
    action.stop(); mixer.uncacheRoot(gltf.scene);
  }
  reports.push({ file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), generator: document.asset.generator ?? null, loader: 'Three.js 0.169.0 GLTFLoader.parseAsync', skinnedMeshes: meshes.length, bones: bones.length, skins: skinReports, nativeAnimationChannels: channelReports, loadedClips: clipReports, decodedImages: decodedImages.slice(decodedStart), limitations: ['Node loader and CPU skin/animation sampling only; no GPU texture upload or visual review.', 'Samples do not establish deformation quality, contact, anatomy, likeness, gameplay usability or production acceptance.'] });
  meshes.forEach(mesh => { mesh.geometry.dispose(); for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose(); });
}
console.log(JSON.stringify({ browserLaunched: false, reports }, null, 2));
