import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const directory = fileURLToPath(new URL('../../asset-source/generated/actor-aren-user-supplied-01/', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function parseGlb(bytes) {
  if (bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2) throw new Error('Expected binary glTF 2.0');
  let json, bin;
  for (let offset = 12; offset < bytes.length;) {
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    if (type === 0x004e4942) bin = data;
    offset += 8 + length;
  }
  if (!json || !bin) throw new Error('Missing glTF JSON or binary chunk');
  return { json, bin };
}
export function encodeGlb(json, bin) {
  const text = Buffer.from(JSON.stringify(json));
  const jsonLength = (text.length + 3) & ~3, binLength = (bin.length + 3) & ~3;
  const result = Buffer.alloc(28 + jsonLength + binLength);
  result.writeUInt32LE(0x46546c67, 0); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(jsonLength, 12); result.writeUInt32LE(0x4e4f534a, 16);
  result.fill(32, 20, 20 + jsonLength); text.copy(result, 20);
  result.writeUInt32LE(binLength, 20 + jsonLength); result.writeUInt32LE(0x004e4942, 24 + jsonLength);
  bin.copy(result, 28 + jsonLength);
  return result;
}
function floatAt(source, accessorId, index, component = 0) {
  const accessor = source.json.accessors[accessorId], view = source.json.bufferViews[accessor.bufferView];
  if (accessor.componentType !== 5126 || accessor.sparse) throw new Error('Expected dense float animation accessor');
  const size = accessor.type === 'VEC3' ? 3 : accessor.type === 'VEC4' ? 4 : 1;
  return source.bin.readFloatLE((view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + index * (view.byteStride ?? size * 4) + component * 4);
}
export function transplantAnimations(targetBytes, donorBytes) {
  const target = parseGlb(targetBytes), donor = parseGlb(donorBytes), json = structuredClone(target.json);
  const targetNodes = new Map(json.nodes.map((node, index) => [node.name, index]));
  for (const joint of donor.json.skins[0].joints) {
    const sourceNode = donor.json.nodes[joint], recipient = json.nodes[targetNodes.get(sourceNode.name)];
    if (!recipient) throw new Error(`Unmatched joint ${sourceNode.name}`);
    for (const [field, fallback] of [['translation', [0, 0, 0]], ['rotation', [0, 0, 0, 1]], ['scale', [1, 1, 1]]]) {
      if ((sourceNode[field] ?? fallback).some((value, i) => Math.abs(value - (recipient[field] ?? fallback)[i]) > 1e-5)) throw new Error(`Incompatible bind pose: ${sourceNode.name}.${field}`);
    }
  }
  const pieces = [target.bin], views = new Map(), accessors = new Map();
  let byteLength = target.bin.length;
  const importAccessor = id => {
    if (accessors.has(id)) return accessors.get(id);
    const original = donor.json.accessors[id];
    if (original.sparse || original.bufferView === undefined) throw new Error('Unsupported sparse animation data');
    if (!views.has(original.bufferView)) {
      const view = donor.json.bufferViews[original.bufferView];
      if (view.buffer !== 0) throw new Error('Animation must use the embedded binary buffer');
      const padding = (4 - byteLength % 4) % 4;
      if (padding) { pieces.push(Buffer.alloc(padding)); byteLength += padding; }
      const bytes = donor.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
      const index = json.bufferViews.length;
      json.bufferViews.push({ ...view, buffer: 0, byteOffset: byteLength });
      views.set(original.bufferView, index); pieces.push(bytes); byteLength += bytes.length;
    }
    const index = json.accessors.length;
    json.accessors.push({ ...original, bufferView: views.get(original.bufferView) });
    accessors.set(id, index); return index;
  };
  const mappings = { 'aren-idle': 'idle.001', 'aren-cheer': 'cheer.001', 'aren-defeat': 'defeat_03.001' };
  const rootMotion = {}, clips = [];
  json.animations = json.animations.filter(animation => !Object.values(mappings).includes(animation.name));
  for (const [action, name] of Object.entries(mappings)) {
    const animation = donor.json.animations.find(item => item.name === name);
    if (!animation) throw new Error(`Missing supplied animation ${name}`);
    const imported = structuredClone(animation);
    for (const channel of imported.channels) {
      const nodeName = donor.json.nodes[channel.target.node].name;
      const targetIndex = targetNodes.get(nodeName);
      if (targetIndex === undefined) throw new Error(`Unbound animation target ${nodeName}`);
      channel.target.node = targetIndex;
    }
    for (const sampler of imported.samplers) { sampler.input = importAccessor(sampler.input); sampler.output = importAccessor(sampler.output); }
    json.animations.push(imported);
    const rootChannel = animation.channels.find(channel => donor.json.nodes[channel.target.node].name === 'mixamorig:Hips' && channel.target.path === 'translation');
    if (!rootChannel) throw new Error(`No native Hips translation in ${name}`);
    const sampler = animation.samplers[rootChannel.sampler], count = donor.json.accessors[sampler.input].count;
    const curveSamples = [0, Math.floor((count - 1) / 2), count - 1].map(index => ({ time: floatAt(donor, sampler.input, index), position: { x: floatAt(donor, sampler.output, index, 0), y: floatAt(donor, sampler.output, index, 1), z: floatAt(donor, sampler.output, index, 2) } }));
    rootMotion[action] = { mode: 'native-root-motion', rootNodeName: 'mixamorigHips', preserveVerticalMotion: true, curveSamples, evidenceStatus: 'verified' };
    clips.push({ action, name, durationSeconds: curveSamples.at(-1).time, channels: imported.channels.length });
  }
  json.buffers = [{ byteLength }];
  return { bytes: encodeGlb(json, Buffer.concat(pieces, byteLength)), mappings, rootMotion, clips };
}

// Standalone run: records the donor import. The runtime GLB (`aren-playtest-animated.glb`) is produced by
// retarget-aren-tripo-clips.mjs, which rebuilds this exact intermediate (`outputHash` below) in memory and appends the combat clips.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const input = process.argv[2] ?? `${directory}/animation-source.glb`;
  const [target, donor] = await Promise.all([readFile(`${directory}/aren-seam-repaired.glb`), readFile(input)]);
  const result = transplantAnimations(target, donor);
  if (resolve(input) !== resolve(`${directory}/animation-source.glb`)) await copyFile(input, `${directory}/animation-source.glb`);
  const report = { sourceHash: hash(donor), parentHash: hash(target), outputHash: hash(result.bytes), outputBytes: result.bytes.length, mappings: result.mappings, rootMotion: result.rootMotion, clips: result.clips };
  await writeFile(`${directory}/animation-import.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, rootMotion: result.rootMotion }, null, 2));
}
