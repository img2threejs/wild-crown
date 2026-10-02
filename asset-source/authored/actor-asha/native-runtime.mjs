import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Texture, Vector3, Box3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
export const sourcePath = new URL('../../rigged/actor-asha/rig/model.glb', import.meta.url);
export const expectedSHA = '081579ba678e764a53a6f7ad5ab707d8fd31463bf4527eb316c787a623ab8ba0';
export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export function unpack(bytes) {
  if (bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw Error('Invalid GLB');
  const jsonLength = bytes.readUInt32LE(12);
  return { doc: JSON.parse(bytes.subarray(20, 20 + jsonLength)), bin: bytes.subarray(28 + jsonLength) };
}
export async function source() {
  const bytes = await readFile(sourcePath);
  if (bytes.length !== 99518156 || sha(bytes) !== expectedSHA) throw Error('Immutable source identity mismatch');
  return { bytes, ...unpack(bytes) };
}
export async function loadNative(bytes) {
  // Real GLTFLoader creates original geometry, skin, bind matrices, hierarchy and animation tracks.
  // CPU instrumentation explicitly skips image decoding; it does not measure textures or rendering.
  const loader = new GLTFLoader();
  loader.register(() => ({ name: 'CPU_MEASUREMENT_TEXTURE_SKIP', loadTexture: () => Promise.resolve(new Texture()) }));
  const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  gltf.scene.updateMatrixWorld(true);
  const meshes = [];
  gltf.scene.traverse(node => { if (node.isSkinnedMesh) meshes.push(node); });
  if (meshes.length !== 1 || meshes[0].skeleton.bones.length !== 21) throw Error('Unexpected native skin');
  return { ...gltf, mesh: meshes[0], bones: meshes[0].skeleton.bones };
}
export function update(runtime) {
  runtime.scene.updateMatrixWorld(true);
  runtime.mesh.skeleton.update();
  if ([...runtime.mesh.skeleton.boneMatrices].some(v => !Number.isFinite(v))) throw Error('Non-finite bone matrix');
}
const p = new Vector3();
export function vertex(runtime, i, target = new Vector3()) {
  target.fromBufferAttribute(runtime.mesh.geometry.attributes.position, i);
  runtime.mesh.applyBoneTransform(i, target);
  target.applyMatrix4(runtime.mesh.matrixWorld);
  if (![target.x, target.y, target.z].every(Number.isFinite)) throw Error('Non-finite skinned vertex');
  return target;
}
export function bounds(runtime) {
  const box = new Box3();
  for (let i = 0; i < runtime.mesh.geometry.attributes.position.count; i++) box.expandByPoint(vertex(runtime, i, p));
  return { min: box.min.toArray(), max: box.max.toArray() };
}
export async function packet(name, data) { await writeFile(new URL(name, import.meta.url), JSON.stringify(data, null, 2) + '\n'); }
