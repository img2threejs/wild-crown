import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Asset-specific binary measurement, not a visual or production gate.
const file = process.argv[2];
if (!file) throw new Error('Usage: node inspect-skin.mjs <native.glb>');
const bytes = await readFile(file);
if (bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw new Error('Invalid GLB header');
let doc, bin;
for (let offset = 12; offset < bytes.length;) {
  const size = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4);
  offset += 8;
  if (size % 4 || offset + size > bytes.length) throw new Error('Invalid chunk bounds');
  if (type === 0x4e4f534a) doc = JSON.parse(bytes.subarray(offset, offset + size).toString('utf8').trim());
  if (type === 0x004e4942) bin = bytes.subarray(offset, offset + size);
  offset += size;
}
if (!doc || !bin) throw new Error('Missing JSON or binary chunk');
const widths = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const components = { 5121: [1, 'readUInt8', 255], 5123: [2, 'readUInt16LE', 65535], 5125: [4, 'readUInt32LE', 4294967295], 5126: [4, 'readFloatLE', 1] };
function accessor(index) {
  const a = doc.accessors[index], view = doc.bufferViews[a?.bufferView];
  const component = components[a?.componentType], width = widths[a?.type];
  if (!a || !view || !component || !width || a.sparse || view.buffer !== 0) throw new Error('Unsupported accessor ' + index);
  const [size, method, divisor] = component;
  const base = (view.byteOffset || 0) + (a.byteOffset || 0), stride = view.byteStride || size * width;
  const end = base + (a.count - 1) * stride + size * width;
  if (stride < size * width || end > bin.length || end > (view.byteOffset || 0) + view.byteLength) throw new Error('Accessor exceeds binary view ' + index);
  return { count: a.count, width, type: a.type, componentType: a.componentType, value(row, col) { return bin[method](base + row * stride + col * size) / (a.normalized ? divisor : 1); } };
}
const skinReports = (doc.skins || []).map(skin => {
  if (!skin.joints?.length || skin.joints.some(i => !doc.nodes[i])) throw new Error('Invalid skin joints');
  const inverse = accessor(skin.inverseBindMatrices);
  if (inverse.count !== skin.joints.length || inverse.type !== 'MAT4' || inverse.componentType !== 5126) throw new Error('Invalid inverse bind matrix shape');
  for (let i = 0; i < inverse.count; i++) for (let c = 0; c < 16; c++) if (!Number.isFinite(inverse.value(i, c))) throw new Error('Non-finite inverse bind matrix');
  return { name: skin.name || null, jointCount: skin.joints.length, jointNames: skin.joints.map(i => doc.nodes[i].name || null), inverseBindMatrices: { count: inverse.count, finite: true } };
});
const primitiveReports = [];
for (const node of doc.nodes || []) {
  if (node.skin === undefined) continue;
  const skin = doc.skins[node.skin], mesh = doc.meshes[node.mesh];
  if (!skin || !mesh) throw new Error('Invalid skinned mesh reference');
  for (const primitive of mesh.primitives) {
    const position = accessor(primitive.attributes.POSITION), joints = accessor(primitive.attributes.JOINTS_0), weights = accessor(primitive.attributes.WEIGHTS_0);
    if (joints.width !== 4 || weights.width !== 4 || position.count !== joints.count || joints.count !== weights.count) throw new Error('Invalid skin attribute shape');
    let minWeightSum = Infinity, maxWeightSum = -Infinity, maxJointIndex = -1, nonzeroInfluences = 0;
    for (let i = 0; i < weights.count; i++) {
      let sum = 0;
      for (let c = 0; c < 4; c++) {
        const joint = joints.value(i, c), weight = weights.value(i, c);
        if (!Number.isInteger(joint) || joint < 0 || joint >= skin.joints.length || !Number.isFinite(weight) || weight < 0) throw new Error('Invalid skin influence at vertex ' + i);
        sum += weight;
        maxJointIndex = Math.max(maxJointIndex, joint);
        if (weight > 0) nonzeroInfluences++;
      }
      if (Math.abs(sum - 1) > 0.0001) throw new Error('Non-normalized skin weights at vertex ' + i);
      minWeightSum = Math.min(minWeightSum, sum);
      maxWeightSum = Math.max(maxWeightSum, sum);
      for (let c = 0; c < position.width; c++) if (!Number.isFinite(position.value(i, c))) throw new Error('Non-finite position');
    }
    primitiveReports.push({ vertices: position.count, attributes: Object.keys(primitive.attributes), minWeightSum, maxWeightSum, maxJointIndex, nonzeroInfluences });
  }
}
const animationReports = (doc.animations || []).map(clip => ({ name: clip.name || null, channels: clip.channels.map(channel => ({ node: channel.target.node, path: channel.target.path, inputSamples: accessor(clip.samplers[channel.sampler].input).count })) }));
console.log(JSON.stringify({ sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, gltfVersion: doc.asset.version, skins: skinReports, primitives: primitiveReports, animations: animationReports, binarySkinChecksPassed: true, visualQuality: 'not-measured', gameReady: false }, null, 2));
