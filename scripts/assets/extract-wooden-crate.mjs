#!/usr/bin/env node
// Extract the complete two-crate wooden component, never the filter's metal drum or a procedural box.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGlb, encodeGlb, readAccessorAny } from './creature-rig-kit.mjs';

const inputPath = 'asset-source/generated/prop-black-sap-filter-drum-runtime-01/prop-black-sap-filter-drum.glb';
const outputDirectory = 'asset-source/generated/prop-wooden-crate-stack-runtime-01';
const outputPath = `${outputDirectory}/prop-wooden-crate-stack.glb`;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const input = readFileSync(inputPath);
const sourceHash = sha256(input);
if (sourceHash !== '88b46c9f4a9d06fab41bd1e32426f3507aece46aed3e879e82c9590e95bd89bb') throw new Error('The reviewed native source changed; remeasure its wooden component before extraction.');
const source = parseGlb(input), primitive = source.json.meshes[0].primitives[0];
const positions = readAccessorAny(source.json, source.bin, primitive.attributes.POSITION);
const indices = readAccessorAny(source.json, source.bin, primitive.indices);
const count = positions.length / 3, parent = Uint32Array.from({ length: count }, (_, index) => index);
const find = index => { while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; } return index; };
const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
const welded = new Map();
for (let index = 0; index < count; index++) {
  const key = [0, 1, 2].map(axis => Math.round(positions[index * 3 + axis] * 1e6)).join(',');
  const previous = welded.get(key);
  if (previous === undefined) welded.set(key, index); else union(index, previous);
}
for (let index = 0; index < indices.length; index += 3) { union(indices[index], indices[index + 1]); union(indices[index], indices[index + 2]); }
// The hash-bound seed is the complete wooden stack. Retain its disconnected bottom boards too, never crop triangles.
const component = find(3258), components = new Map();
for (const original of indices) {
  const root = find(original);
  let part = components.get(root);
  if (!part) { part = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], indices: 0 }; components.set(root, part); }
  part.indices++;
  for (let axis = 0; axis < 3; axis++) {
    const value = positions[original * 3 + axis];
    part.min[axis] = Math.min(part.min[axis], value); part.max[axis] = Math.max(part.max[axis], value);
  }
}
const woodenBounds = components.get(component);
if (woodenBounds?.indices !== 587 * 3) throw new Error('Native wooden component topology changed.');
const woodenParts = new Set();
for (const [root, part] of components) if (part.min.every((value, axis) => value >= woodenBounds.min[axis] - 1e-6) && part.max.every((value, axis) => value <= woodenBounds.max[axis] + 1e-6)) woodenParts.add(root);
const selected = [];
for (let index = 0; index < indices.length; index += 3) if (woodenParts.has(find(indices[index]))) selected.push(indices[index], indices[index + 1], indices[index + 2]);
const remap = new Uint32Array(count).fill(0xffffffff), originals = [];
const remapped = Uint32Array.from(selected, original => {
  if (remap[original] === 0xffffffff) { remap[original] = originals.length; originals.push(original); }
  return remap[original];
});
const json = structuredClone(source.json), pieces = [], views = [], accessors = [], attributes = {}, textures = [];
let length = 0;
const append = (bytes, target) => {
  const padding = (4 - length % 4) % 4;
  if (padding) { pieces.push(Buffer.alloc(padding)); length += padding; }
  const index = views.length;
  views.push({ buffer: 0, byteOffset: length, byteLength: bytes.length, ...(target ? { target } : {}) });
  pieces.push(bytes); length += bytes.length;
  return index;
};
const temporary = mkdtempSync(join(tmpdir(), 'wc-native-crate-'));
try {
  for (const [index, image] of json.images.entries()) {
    const view = source.json.bufferViews[image.bufferView];
    const bytes = source.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    const path = join(temporary, `${index}.jpg`);
    writeFileSync(path, bytes);
    const metadata = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], { encoding: 'utf8' });
    const width = Number(metadata.match(/pixelWidth: (\d+)/)?.[1]), height = Number(metadata.match(/pixelHeight: (\d+)/)?.[1]);
    if (!(width > 0 && height > 0 && Math.max(width, height) <= 1024)) throw new Error('Native crate textures exceed the 1K budget.');
    image.bufferView = append(bytes);
    textures.push({ index, width, height, bytes: bytes.length, sha256: sha256(bytes), method: 'Original embedded native image bytes, not re-encoded.' });
  }
} finally { rmSync(temporary, { recursive: true, force: true }); }
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (const original of originals) for (let axis = 0; axis < 3; axis++) {
  const value = positions[original * 3 + axis];
  min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value);
}
for (const [name, accessorId] of Object.entries(primitive.attributes)) {
  const accessor = source.json.accessors[accessorId], view = source.json.bufferViews[accessor.bufferView];
  const components = { VEC2: 2, VEC3: 3 }[accessor.type];
  if (accessor.componentType !== 5126 || !components || accessor.sparse) throw new Error('Unexpected native attribute layout.');
  const elementBytes = components * 4, stride = view.byteStride ?? elementBytes;
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0), bytes = Buffer.alloc(originals.length * elementBytes);
  for (const [destination, original] of originals.entries()) source.bin.copy(bytes, destination * elementBytes, base + original * stride, base + original * stride + elementBytes);
  attributes[name] = accessors.length;
  accessors.push({ bufferView: append(bytes, 34962), componentType: 5126, count: originals.length, type: accessor.type, ...(name === 'POSITION' ? { min, max } : {}) });
}
const indexAccessor = accessors.length;
accessors.push({ bufferView: append(Buffer.from(remapped.buffer), 34963), componentType: 5125, count: remapped.length, type: 'SCALAR' });
const translation = [-(min[0] + max[0]) / 2, -min[1], -(min[2] + max[2]) / 2];
json.meshes = [{ name: 'native-wooden-crate-stack', primitives: [{ ...primitive, attributes, indices: indexAccessor }] }];
json.nodes = [{ mesh: 0, name: 'native-wooden-crate-stack', translation }];
json.scenes = [{ nodes: [0] }]; json.scene = 0;
json.bufferViews = views; json.accessors = accessors; json.buffers = [{ byteLength: length }];
const bytes = encodeGlb(json, Buffer.concat(pieces, length));
const provenance = {
  schemaVersion: 1, assetId: 'prop-wooden-crate-stack', generator: 'scripts/assets/extract-wooden-crate.mjs', sourceType: 'native-glb',
  method: 'Complete connected wooden stack plus fully enclosed disconnected native bottom boards, seam-weld tolerance 0.000001. Original triangle order, selected position/normal/UV bytes and material images preserved. Node-only centering and grounding; no primitive substitute or metal-drum geometry.',
  inputs: { base: { path: inputPath, sha256: sourceHash }, upstreamProvenance: 'asset-source/generated/prop-black-sap-filter-drum-runtime-01/provenance.json', tripoSourceTask: '87f6085b-64e2-41f4-bc17-46e5830d21a5' },
  extraction: { seedVertex: 3258, componentRoots: [...woodenParts], triangles: selected.length / 3, vertices: originals.length, sourceBounds: { min, max }, nodeTranslation: translation, sourceVertexMapSha256: sha256(Buffer.from(Uint32Array.from(originals).buffer)) },
  output: { path: outputPath, sha256: sha256(bytes), bytes: bytes.length }, maxTexture: 1024, textures,
  assessment: { evidenceStatus: 'blocked', productionAcceptance: 'NOT_ESTABLISHED', note: 'Native authored two-crate stack retained as one small loose body; no rewards or quest authority.' },
};
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(outputPath, bytes);
writeFileSync(`${outputDirectory}/provenance.json`, JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify(provenance, null, 2));
