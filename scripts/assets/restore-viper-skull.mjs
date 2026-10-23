#!/usr/bin/env node
// Restores only the crown discarded by Tripo's low-poly conversion. Existing body/jaw geometry, UVs,
// materials, skeleton and clips remain untouched. The replacement is sampled from the approved original,
// not a procedural cap. No network requests or paid generation. Run before author-creature-clips.mjs.
// First extraction: node scripts/assets/restore-viper-skull.mjs --source=<original provider GLB>
// Rebuild: regenerate the unmodified native base, then run this command without --source.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MeshoptSimplifier } from 'meshoptimizer';
import { encodeGlb, parseGlb, readAccessorAny } from './creature-rig-kit.mjs';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const BASE = 'asset-source/generated/actor-mire-viper-runtime-01/actor-mire-viper.glb';
const PROVENANCE = 'asset-source/generated/actor-mire-viper-runtime-01/provenance.json';
const REFERENCE = 'asset-source/generated/actor-mire-viper-skull-source-01/skull.glb';
const REFERENCE_REPORT = 'asset-source/generated/actor-mire-viper-skull-source-01/provenance.json';
const BASE_SHA = 'e155a6a279d77660a5591f5fe13e3db05684d6e0ea13f6d7d939ccb91984c003';
const SOURCE_SHA = '39ce6d0041cf424b91a94080de03a03846d2b8ce35bbd3b6652855abfd2c96c8';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (path, bytes) => { mkdirSync(dirname(resolve(ROOT, path)), { recursive: true }); writeFileSync(resolve(ROOT, path), bytes); };

function packer(json, initial = Buffer.alloc(0)) {
  const pieces = [initial]; let length = initial.length;
  const view = (bytes, target) => {
    const padding = (4 - length % 4) % 4;
    if (padding) { pieces.push(Buffer.alloc(padding)); length += padding; }
    const index = json.bufferViews.length;
    json.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length, ...(target ? { target } : {}) });
    pieces.push(bytes); length += bytes.length; return index;
  };
  const accessor = (values, type, componentType, target) => {
    const bufferView = view(Buffer.from(values.buffer, values.byteOffset, values.byteLength), target);
    const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type];
    const index = json.accessors.length;
    json.accessors.push({ bufferView, componentType, count: values.length / components, type });
    return index;
  };
  return { view, accessor, finish: () => { json.buffers = [{ byteLength: length }]; return Buffer.concat(pieces, length); } };
}

// A vertical surface lookup avoids lifting the intact underside into a roof. Only missing original
// exterior triangles above the existing head are restored; the intact eyes, snout and neck stay put.
function roofLookup(source) {
  const primitive = source.json.meshes[0].primitives[0];
  const p = readAccessorAny(source.json, source.bin, primitive.attributes.POSITION);
  const indices = readAccessorAny(source.json, source.bin, primitive.indices), cells = new Map(), cell = 0.01;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    if (Math.max(p[a + 1], p[b + 1], p[c + 1]) < 0.39) continue;
    const loX = Math.floor(Math.min(p[a], p[b], p[c]) / cell), hiX = Math.floor(Math.max(p[a], p[b], p[c]) / cell);
    const loZ = Math.floor(Math.min(p[a + 2], p[b + 2], p[c + 2]) / cell), hiZ = Math.floor(Math.max(p[a + 2], p[b + 2], p[c + 2]) / cell);
    for (let x = loX; x <= hiX; x++) for (let z = loZ; z <= hiZ; z++) {
      const key = `${x},${z}`; let bucket = cells.get(key);
      if (!bucket) cells.set(key, bucket = []);
      bucket.push(a, b, c);
    }
  }
  return (x, z) => {
    const bucket = cells.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) ?? [];
    let top = -Infinity;
    for (let i = 0; i < bucket.length; i += 3) {
      const a = bucket[i], b = bucket[i + 1], c = bucket[i + 2];
      const d = (p[b + 2] - p[c + 2]) * (p[a] - p[c]) + (p[c] - p[b]) * (p[a + 2] - p[c + 2]);
      if (Math.abs(d) < 1e-12) continue;
      const u = ((p[b + 2] - p[c + 2]) * (x - p[c]) + (p[c] - p[b]) * (z - p[c + 2])) / d;
      const v = ((p[c + 2] - p[a + 2]) * (x - p[c]) + (p[a] - p[c]) * (z - p[c + 2])) / d;
      if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6) top = Math.max(top, u * p[a + 1] + v * p[b + 1] + (1 - u - v) * p[c + 1]);
    }
    return top;
  };
}

async function extractReference(path, base) {
  const bytes = readFileSync(resolve(ROOT, path));
  assert.equal(hash(bytes), SOURCE_SHA, 'Expected the approved pre-retopology provider model');
  const source = parseGlb(bytes), primitive = source.json.meshes[0].primitives[0];
  const positions = Float32Array.from(readAccessorAny(source.json, source.bin, primitive.attributes.POSITION));
  // Same floor/centre translation used by the native rig, not independent bounding-box fitting.
  const armature = base.json.nodes.find(node => node.name === 'Armature');
  assert.ok(armature?.translation, 'Native Armature translation is required for source alignment');
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) positions[i + k] += armature.translation[k];
  const indices = readAccessorAny(source.json, source.bin, primitive.indices), roof = roofLookup(base), selected = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
    const x = (positions[a] + positions[b] + positions[c]) / 3;
    const y = (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3;
    const z = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3;
    if (y > 0.43 && z < -0.12 && y > roof(x, z) + 0.001) selected.push(indices[i], indices[i + 1], indices[i + 2]);
  }
  assert.ok(selected.length > 3000, 'Missing crown surface was not found');
  const uv = Float32Array.from(readAccessorAny(source.json, source.bin, primitive.attributes.TEXCOORD_0));
  await MeshoptSimplifier.ready;
  const [reduced, error] = MeshoptSimplifier.simplifyWithAttributes(Uint32Array.from(selected), positions, 3, uv, 2, [0.1, 0.1], null, 6000 * 3, 0.002, ['LockBorder']);
  assert.ok(Number.isFinite(error) && error <= 0.002 && reduced.length > 0, 'Crown simplification exceeded surface error');
  const remap = new Map(), used = [], outputIndices = Uint32Array.from(reduced, id => {
    if (!remap.has(id)) { remap.set(id, used.length); used.push(id); }
    return remap.get(id);
  });
  const copy = (values, size) => Float32Array.from(used.flatMap(id => Array.from(values.subarray(id * size, (id + 1) * size))));
  const json = { asset: { version: '2.0', generator: 'wild-crown source-faithful viper crown recovery' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'Recovered original viper crown' }],
    meshes: [{ primitives: [] }], accessors: [], bufferViews: [],
    materials: structuredClone(source.json.materials), textures: structuredClone(source.json.textures), samplers: structuredClone(source.json.samplers ?? []), images: [] };
  const pack = packer(json), position = copy(positions, 3), positionId = pack.accessor(position, 'VEC3', 5126, 34962);
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i < position.length; i++) { const k = i % 3; bounds.min[k] = Math.min(bounds.min[k], position[i]); bounds.max[k] = Math.max(bounds.max[k], position[i]); }
  Object.assign(json.accessors[positionId], bounds);
  json.meshes[0].primitives.push({ attributes: { POSITION: positionId,
    NORMAL: pack.accessor(copy(readAccessorAny(source.json, source.bin, primitive.attributes.NORMAL), 3), 'VEC3', 5126, 34962),
    TEXCOORD_0: pack.accessor(copy(uv, 2), 'VEC2', 5126, 34962) }, indices: pack.accessor(outputIndices, 'SCALAR', 5125, 34963), material: 0 });
  const work = mkdtempSync(join(tmpdir(), 'wc-viper-crown-'));
  try {
    for (const [index, image] of source.json.images.entries()) {
      const view = source.json.bufferViews[image.bufferView], input = join(work, `${index}.${image.mimeType === 'image/png' ? 'png' : 'jpg'}`), output = join(work, `${index}-1024.jpg`);
      writeFileSync(input, source.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
      execFileSync('sips', ['-Z', '1024', '-s', 'format', 'jpeg', '-s', 'formatOptions', '88', input, '--out', output], { stdio: 'ignore' });
      json.images.push({ ...image, mimeType: 'image/jpeg', bufferView: pack.view(readFileSync(output)) });
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
  const reference = encodeGlb(json, pack.finish());
  const report = { schemaVersion: 1, assetId: 'actor-mire-viper', generator: 'scripts/assets/restore-viper-skull.mjs',
    source: { taskId: '8a5060d5-40ec-4c95-bfd5-a3fd5f9373a6', sha256: SOURCE_SHA, bytes: bytes.length },
    discardedSurfaceSource: { taskId: '80178975-e50c-4619-8743-99a6efa0bac8', sha256: '41536db824ee74903e24fb027d7c3ed94392d137f708129e0bdef9ca94858ee9' },
    alignmentTranslation: armature.translation, method: 'Original exterior head triangles above the missing low-poly crown; no jaw inflation, sculpted cap or body replacement',
    selectedTriangles: selected.length / 3, output: { path: REFERENCE, sha256: hash(reference), bytes: reference.length, triangles: reduced.length / 3, vertices: used.length },
    relativeSimplificationError: error, textureMaxSize: 1024, evidenceStatus: 'blocked', productionAcceptance: 'NOT_ESTABLISHED' };
  save(REFERENCE, reference); save(REFERENCE_REPORT, JSON.stringify(report, null, 2) + '\n');
}

export async function restoreViperSkull({ sourcePath } = {}) {
  const bytes = readFileSync(resolve(ROOT, BASE)), provenance = JSON.parse(readFileSync(resolve(ROOT, PROVENANCE), 'utf8'));
  if (provenance.surfaceRestoration?.outputSha256 === hash(bytes) && !sourcePath) return provenance.surfaceRestoration;
  assert.equal(hash(bytes), BASE_SHA, 'Rebuild the unmodified native base before restoring its crown');
  const base = parseGlb(bytes);
  if (sourcePath) await extractReference(sourcePath, base);
  assert.ok(existsSync(resolve(ROOT, REFERENCE)), 'Missing recovered source surface: first run with --source=<approved provider GLB>');
  const referenceBytes = readFileSync(resolve(ROOT, REFERENCE)), report = JSON.parse(readFileSync(resolve(ROOT, REFERENCE_REPORT), 'utf8'));
  assert.equal(hash(referenceBytes), report.output.sha256, 'Recovered source surface SHA mismatch');
  const reference = parseGlb(referenceBytes), json = structuredClone(base.json), pack = packer(json, base.bin);
  const viewMap = reference.json.bufferViews.map(view => pack.view(reference.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength), view.target));
  const accessorOffset = json.accessors.length;
  for (const accessor of reference.json.accessors) json.accessors.push({ ...accessor, bufferView: viewMap[accessor.bufferView] });
  const imageOffset = json.images.length, textureOffset = json.textures.length, samplerOffset = (json.samplers ??= []).length, materialId = json.materials.length;
  json.images.push(...reference.json.images.map(image => ({ ...image, bufferView: viewMap[image.bufferView] })));
  json.samplers.push(...reference.json.samplers);
  json.textures.push(...reference.json.textures.map(texture => ({ ...texture, source: texture.source + imageOffset, ...(texture.sampler === undefined ? {} : { sampler: texture.sampler + samplerOffset }) })));
  const material = structuredClone(reference.json.materials[0]);
  material.name = 'Approved original viper crown';
  for (const texture of [material.normalTexture, material.pbrMetallicRoughness.baseColorTexture, material.pbrMetallicRoughness.metallicRoughnessTexture]) texture.index += textureOffset;
  json.materials.push(material);
  const original = reference.json.meshes[0].primitives[0], attributes = Object.fromEntries(Object.entries(original.attributes).map(([key, id]) => [key, id + accessorOffset]));
  const count = reference.json.accessors[original.attributes.POSITION].count;
  const rootIndex = json.skins[0].joints.findIndex(id => json.nodes[id].name === 'tripo::Root');
  assert.ok(rootIndex >= 0 && rootIndex < 256, 'Native skull Root was not found');
  const joints = new Uint8Array(count * 4), weights = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) { joints[i * 4] = rootIndex; weights[i * 4] = 1; }
  attributes.JOINTS_0 = pack.accessor(joints, 'VEC4', 5121, 34962);
  attributes.WEIGHTS_0 = pack.accessor(weights, 'VEC4', 5126, 34962);
  json.meshes[0].primitives.push({ attributes, indices: original.indices + accessorOffset, material: materialId });
  const output = encodeGlb(json, pack.finish());
  const position = reference.json.accessors[original.attributes.POSITION];
  provenance.output = { ...provenance.output, sha256: hash(output), bytes: output.length,
    vertices: provenance.output.vertices + count, triangles: provenance.output.triangles + report.output.triangles,
    boundsMin: provenance.output.boundsMin.map((value, i) => Math.min(value, position.min[i])), boundsMax: provenance.output.boundsMax.map((value, i) => Math.max(value, position.max[i])) };
  provenance.surfaceRestoration = { generator: 'scripts/assets/restore-viper-skull.mjs', inputSha256: BASE_SHA,
    reference: { path: REFERENCE, sha256: report.output.sha256 }, outputSha256: hash(output),
    addedTriangles: report.output.triangles, preserved: ['original body, eyes, snout and jaw attributes', 'original material and texture bytes', 'skeleton and bind transforms', 'native clips'],
    note: 'Restored the original outward-facing crown omitted by provider low-poly conversion; no runtime geometry or material overrides.' };
  save(BASE, output); save(PROVENANCE, JSON.stringify(provenance, null, 2) + '\n');
  return provenance.surfaceRestoration;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const sourcePath = process.argv.slice(2).find(arg => arg.startsWith('--source='))?.slice('--source='.length);
  console.log(JSON.stringify(await restoreViperSkull({ sourcePath })));
}
