import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { AnimationClip, AnimationMixer, Bone, BufferAttribute, BufferGeometry, Matrix4, MeshBasicMaterial, Object3D, QuaternionKeyframeTrack, Skeleton, SkinnedMesh, Vector3, VectorKeyframeTrack } from 'three';

// CPU-only native binding/channel playback. Does not decode textures or render.
const bytes = await readFile(process.argv[2]);
const jsonLength = bytes.readUInt32LE(12);
const doc = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').trim());
const bin = bytes.subarray(28 + jsonLength);
const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
function array(index) {
  const a = doc.accessors[index], v = doc.bufferViews[a.bufferView];
  const Type = { 5126: Float32Array, 5123: Uint16Array, 5121: Uint8Array, 5125: Uint32Array }[a.componentType];
  if (!Type || a.sparse || v.byteStride) throw new Error('Unsupported native accessor ' + index);
  const offset = bin.byteOffset + (v.byteOffset || 0) + (a.byteOffset || 0);
  return new Type(bytes.buffer, offset, a.count * width[a.type]);
}
const skin = doc.skins[0];
const jointSet = new Set(skin.joints);
const objects = doc.nodes.map((node, i) => {
  const object = jointSet.has(i) ? new Bone() : new Object3D();
  object.name = node.name || 'node-' + i;
  if (node.matrix) {
    object.matrix.fromArray(node.matrix);
    object.matrix.decompose(object.position, object.quaternion, object.scale);
  } else {
    if (node.translation) object.position.fromArray(node.translation);
    if (node.rotation) object.quaternion.fromArray(node.rotation);
    if (node.scale) object.scale.fromArray(node.scale);
  }
  return object;
});
const root = new Object3D();
for (let i = 0; i < objects.length; i++) for (const child of doc.nodes[i].children || []) objects[i].add(objects[child]);
for (const node of doc.scenes[doc.scene || 0].nodes) root.add(objects[node]);
root.updateMatrixWorld(true);
const inverses = array(skin.inverseBindMatrices);
const skeleton = new Skeleton(skin.joints.map(i => objects[i]), skin.joints.map((_, i) => new Matrix4().fromArray(inverses, i * 16)));
const meshNode = doc.nodes.findIndex(n => n.skin === 0);
const primitive = doc.meshes[doc.nodes[meshNode].mesh].primitives[0];
const geometry = new BufferGeometry();
for (const [semantic, name] of [['POSITION', 'position'], ['JOINTS_0', 'skinIndex'], ['WEIGHTS_0', 'skinWeight']]) {
  const index = primitive.attributes[semantic], a = doc.accessors[index];
  geometry.setAttribute(name, new BufferAttribute(array(index), width[a.type], a.normalized || false));
}
const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
objects[meshNode].add(mesh);
root.updateMatrixWorld(true);
mesh.bind(skeleton, objects[meshNode].matrixWorld);
const native = doc.animations[0];
if (native?.name !== 'preset:quadruped:walk') throw new Error('Missing native quadruped walk');
const tracks = native.channels.map(channel => {
  const sampler = native.samplers[channel.sampler];
  if (sampler.interpolation && sampler.interpolation !== 'LINEAR') throw new Error('Unexpected interpolation');
  const target = objects[channel.target.node];
  if (!target) throw new Error('Missing native target');
  const rotation = channel.target.path === 'rotation';
  if (!rotation && channel.target.path !== 'translation') throw new Error('Unexpected native channel path');
  const Track = rotation ? QuaternionKeyframeTrack : VectorKeyframeTrack;
  return new Track(target.uuid + '.' + (rotation ? 'quaternion' : 'position'), array(sampler.input), array(sampler.output));
});
const clip = new AnimationClip(native.name, -1, tracks);
if (!clip.validate() || !(clip.duration > 0)) throw new Error('Invalid runtime clip');
const mixer = new AnimationMixer(root);
mixer.clipAction(clip).play();
const ids = [0, 247401, 494803, 742204, 989605];
function sample(time) {
  mixer.setTime(time);
  root.updateMatrixWorld(true);
  skeleton.update();
  const points = ids.map(i => mesh.applyBoneTransform(i, new Vector3().fromBufferAttribute(geometry.attributes.position, i)).toArray());
  if (points.flat().some(n => !Number.isFinite(n)) || Array.from(skeleton.boneMatrices).some(n => !Number.isFinite(n))) throw new Error('Non-finite native playback');
  return { time, points };
}
const a = sample(0), b = sample(clip.duration * 0.25), c = sample(clip.duration * 0.5);
const displacements = a.points.map((point, i) => new Vector3().fromArray(point).distanceTo(new Vector3().fromArray(b.points[i])));
if (!displacements.some(d => d > 0.00001)) throw new Error('Native walk did not deform sampled vertices');
console.log(JSON.stringify({ sha256: createHash('sha256').update(bytes).digest('hex'), nativeClip: clip.name, durationSeconds: clip.duration, channels: native.channels.length, rotationChannels: native.channels.filter(c => c.target.path === 'rotation').length, translationChannels: native.channels.filter(c => c.target.path === 'translation').length, nativeSkinJoints: skeleton.bones.length, keyframeSamplesPerTrack: tracks.map(t => t.times.length), sampledVertexIndices: ids, quarterCycleDisplacements: displacements, playbackSamples: [a, b, c], finiteNativePlayback: true, nativeSampledVerticesDeformed: true, textureDecodeMeasured: false, browserRenderMeasured: false, gameReady: false }, null, 2));
geometry.dispose();
mesh.material.dispose();
mixer.stopAllAction();
mixer.uncacheRoot(root);
