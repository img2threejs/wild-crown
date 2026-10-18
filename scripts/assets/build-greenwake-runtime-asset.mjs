#!/usr/bin/env node
// Builds a web runtime GLB from Tripo outputs: merges retarget clip batches that share one
// rig (identical bind pose required), optionally simplifies static triangle lists with
// meshoptimizer, re-encodes embedded textures with macOS `sips` (JPEG for opaque maps), and
// writes provenance with hashes and clip durations.
// Usage: node scripts/assets/build-greenwake-runtime-asset.mjs <asset-id> [--input=<native-glb>] [--runtime-candidate] [--simplify=<ratio>] [--max-error=<relative>] [--max-texture=<px>] [--revision=<n>] [--prune-slivers=<aspect[,aspect...]>] [--sliver-edge=<fraction[,fraction...]>] [--simplify-skinned] [--compact] [--cull-to-source=<distance>] [--simplify-flags=<Flag,...>] [--uv-weight=<w>] [--base=model]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MeshoptSimplifier } from 'meshoptimizer';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const asset = process.argv[2];
if (!asset) { console.error('Usage: build-greenwake-runtime-asset.mjs <asset-id> [--input=<native-glb>] [--runtime-candidate] [--simplify=<ratio>] [--max-error=<relative>] [--max-texture=<px>] [--revision=<n>] [--prune-slivers=<aspect[,aspect...]>] [--sliver-edge=<fraction[,fraction...]>] [--simplify-skinned] [--compact] [--cull-to-source=<distance>] [--simplify-flags=<Flag,...>] [--uv-weight=<w>]'); process.exit(2); }
const option = name => process.argv.slice(3).find(arg => arg.startsWith(`--${name}=`))?.split('=')[1];
// Recondition a hash-bound native input without requiring Tripo task sidecars.
const inputPath = option('input');
const runtimeCandidate = process.argv.includes('--runtime-candidate');
const simplifyRatio = option('simplify') === undefined ? undefined : Number(option('simplify'));
const maxTexture = Number(option('max-texture') ?? 2048);
/** Relative (to mesh extent) geometric error the simplifier may introduce before stopping short of the ratio. */
const maxError = Number(option('max-error') ?? 0.02);
/** Skinned assets keep Tripo's topology unless this flag opts in: the simplifier only removes triangles, never moves or re-weights vertices. */
/** meshoptimizer flags for --simplify (default LockBorder, which keeps every open border; Permissive/Prune reach much lower counts). */
const simplifyFlags = (option('simplify-flags') ?? 'LockBorder').split(',').filter(Boolean);
/** With a weight > 0 the simplifier also tracks TEXCOORD_0, so collapses that would smear the baked texture cost more. */
const uvWeight = Number(option('uv-weight') ?? 0);
const allowSkinned = runtimeCandidate || process.argv.includes('--simplify-skinned');
/**
 * Tripo's decimator can grow thin rods of tiny triangles into empty space (the high-poly source has none). With this option
 * every triangle with a vertex farther than <distance> (model units, the decimated GLB is normalised to ~1 unit) from the
 * high-poly source model's surface is dropped.
 */
const cullDistance = option('cull-to-source') === undefined ? undefined : Number(option('cull-to-source'));
if (cullDistance !== undefined && !(cullDistance > 0)) throw new Error('--cull-to-source must be a positive distance');
/** Drops vertices no triangle references any more (simplification leaves them in the buffers) and re-packs every attribute tightly. */
const compact = process.argv.includes('--compact');
/**
 * Tripo's decimator can leave fans of needle triangles. A triangle is dropped when its longest edge exceeds the edge fraction
 * of the bounding-box diagonal and area / longest-edge^2 is below the matching aspect. Comma lists give several (aspect, edge)
 * tiers, e.g. --prune-slivers=0.003,0.02 --sliver-edge=0.03,0.12 (very thin and fairly long, or merely thin and very long).
 */
const sliverAspects = option('prune-slivers') === undefined ? undefined : option('prune-slivers').split(',').map(Number);
const sliverEdges = sliverAspects?.map((_, tier) => Number((option('sliver-edge') ?? '0.03').split(',')[tier] ?? (option('sliver-edge') ?? '0.03').split(',')[0]));
if (sliverAspects?.some(aspect => !(aspect > 0 && aspect < 0.1))) throw new Error('--prune-slivers must list aspects in (0, 0.1)');
if (simplifyRatio !== undefined && !(simplifyRatio > 0 && simplifyRatio < 1)) throw new Error('--simplify must be a ratio in (0, 1)');
if (!(maxTexture >= 256)) throw new Error('--max-texture must be at least 256');
const revisionTag = String(Number(option('revision') ?? 1)).padStart(2, '0');
const generated = name => resolve(ROOT, 'asset-source/generated', `${asset}-${name}-${revisionTag}`);
const result = name => existsSync(join(generated(name), 'result.json')) ? JSON.parse(readFileSync(join(generated(name), 'result.json'), 'utf8')) : undefined;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function parse(bytes) {
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
function encode(json, bin) {
  const text = Buffer.from(JSON.stringify(json));
  const jsonLength = (text.length + 3) & ~3, binLength = (bin.length + 3) & ~3;
  const out = Buffer.alloc(28 + jsonLength + binLength);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonLength, 12); out.writeUInt32LE(0x4e4f534a, 16);
  out.fill(32, 20, 20 + jsonLength); text.copy(out, 20);
  out.writeUInt32LE(binLength, 20 + jsonLength); out.writeUInt32LE(0x004e4942, 24 + jsonLength);
  bin.copy(out, 28 + jsonLength);
  return out;
}

/** Rebuilds the binary chunk from the views still referenced, appending replacement image bytes. */
function repack(source, replacements) {
  const json = structuredClone(source.json), pieces = [];
  let length = 0;
  const viewMap = new Map();
  const append = bytes => {
    const pad = (4 - length % 4) % 4;
    if (pad) { pieces.push(Buffer.alloc(pad)); length += pad; }
    const offset = length; pieces.push(bytes); length += bytes.length; return offset;
  };
  const used = new Set([...(json.accessors ?? []).map(a => a.bufferView), ...(json.images ?? []).map(i => i.bufferView)].filter(v => v !== undefined));
  const views = [];
  for (const [index, view] of source.json.bufferViews.entries()) {
    if (!used.has(index)) continue;
    const imageIndex = (json.images ?? []).findIndex(image => image.bufferView === index);
    const bytes = imageIndex >= 0 && replacements.has(imageIndex)
      ? replacements.get(imageIndex).bytes
      : source.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    viewMap.set(index, views.length);
    views.push({ ...view, buffer: 0, byteOffset: append(bytes), byteLength: bytes.length });
  }
  json.bufferViews = views;
  for (const accessor of json.accessors ?? []) if (accessor.bufferView !== undefined) accessor.bufferView = viewMap.get(accessor.bufferView);
  for (const [index, image] of (json.images ?? []).entries()) {
    image.bufferView = viewMap.get(image.bufferView);
    if (replacements.has(index)) image.mimeType = replacements.get(index).mimeType;
  }
  json.buffers = [{ byteLength: length }];
  return { json, bin: Buffer.concat(pieces, length) };
}

function mergeClips(base, donor) {
  const json = structuredClone(base.json);
  const names = new Map(json.nodes.map((node, index) => [node.name, index]));
  for (const joint of donor.json.skins[0].joints) {
    const node = donor.json.nodes[joint], recipient = json.nodes[names.get(node.name)];
    if (!recipient) throw new Error(`Unmatched joint ${node.name}`);
    for (const [field, fallback] of [['translation', [0, 0, 0]], ['rotation', [0, 0, 0, 1]], ['scale', [1, 1, 1]]]) {
      if ((node[field] ?? fallback).some((value, i) => Math.abs(value - (recipient[field] ?? fallback)[i]) > 1e-5)) throw new Error(`Incompatible bind pose: ${node.name}.${field}`);
    }
  }
  const pieces = [base.bin];
  let length = base.bin.length;
  const views = new Map(), accessors = new Map();
  const importAccessor = id => {
    if (accessors.has(id)) return accessors.get(id);
    const original = donor.json.accessors[id];
    if (original.sparse || original.bufferView === undefined) throw new Error('Unsupported sparse animation data');
    if (!views.has(original.bufferView)) {
      const view = donor.json.bufferViews[original.bufferView];
      const pad = (4 - length % 4) % 4;
      if (pad) { pieces.push(Buffer.alloc(pad)); length += pad; }
      const bytes = donor.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
      views.set(original.bufferView, json.bufferViews.length);
      json.bufferViews.push({ ...view, buffer: 0, byteOffset: length });
      pieces.push(bytes); length += bytes.length;
    }
    const index = json.accessors.length;
    json.accessors.push({ ...original, bufferView: views.get(original.bufferView) });
    accessors.set(id, index); return index;
  };
  for (const animation of donor.json.animations ?? []) {
    if ((json.animations ?? []).some(existing => existing.name === animation.name)) throw new Error(`Duplicate clip ${animation.name}`);
    const imported = structuredClone(animation);
    for (const channel of imported.channels) {
      const target = names.get(donor.json.nodes[channel.target.node].name);
      if (target === undefined) throw new Error(`Unbound channel target ${donor.json.nodes[channel.target.node].name}`);
      channel.target.node = target;
    }
    for (const sampler of imported.samplers) { sampler.input = importAccessor(sampler.input); sampler.output = importAccessor(sampler.output); }
    (json.animations ??= []).push(imported);
  }
  json.buffers = [{ byteLength: length }];
  return { json, bin: Buffer.concat(pieces, length) };
}

function recodeTextures(source, maxSize) {
  const work = mkdtempSync(join(tmpdir(), `wc-${asset}-`));
  const replacements = new Map(), report = [];
  try {
    for (const [index, image] of (source.json.images ?? []).entries()) {
      const view = source.json.bufferViews[image.bufferView];
      const bytes = source.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
      const ext = image.mimeType === 'image/png' ? 'png' : 'jpg';
      const input = join(work, `${index}.${ext}`), output = join(work, `${index}-out.jpg`);
      writeFileSync(input, bytes);
      const alpha = execFileSync('sips', ['-g', 'hasAlpha', input], { encoding: 'utf8' }).includes('hasAlpha: yes');
      if (alpha) { report.push({ index, kept: image.mimeType, bytes: bytes.length, reason: 'alpha channel' }); continue; }
      execFileSync('sips', ['-Z', String(maxSize), '-s', 'format', 'jpeg', '-s', 'formatOptions', '88', input, '--out', output], { stdio: 'ignore' });
      const encoded = readFileSync(output);
      replacements.set(index, { bytes: encoded, mimeType: 'image/jpeg' });
      report.push({ index, from: image.mimeType, fromBytes: bytes.length, toBytes: encoded.length });
    }
  } finally { rmSync(work, { recursive: true, force: true }); }
  return { packed: repack(source, replacements), report };
}

function clipDurations(json) {
  return (json.animations ?? []).map(animation => ({
    name: animation.name,
    durationSeconds: Math.max(...animation.samplers.map(sampler => json.accessors[sampler.input].max?.[0] ?? 0)),
    channels: animation.channels.length,
  }));
}

function accessorFloats(source, accessorId) {
  const accessor = source.json.accessors[accessorId], view = source.json.bufferViews[accessor.bufferView];
  if (accessor.componentType !== 5126 || accessor.type !== 'VEC3' || accessor.sparse) throw new Error('Expected dense float VEC3 positions');
  const stride = view.byteStride ?? 12, base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const out = new Float32Array(accessor.count * 3);
  for (let i = 0; i < accessor.count; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = source.bin.readFloatLE(base + i * stride + c * 4);
  return out;
}
function texcoords(source, accessorId) {
  const accessor = source.json.accessors[accessorId], view = source.json.bufferViews[accessor.bufferView];
  if (accessor.componentType !== 5126 || accessor.type !== 'VEC2') throw new Error('Expected float VEC2 texture coordinates');
  const stride = view.byteStride ?? 8, base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const out = new Float32Array(accessor.count * 2);
  for (let i = 0; i < accessor.count; i++) for (let c = 0; c < 2; c++) out[i * 2 + c] = source.bin.readFloatLE(base + i * stride + c * 4);
  return out;
}
function accessorIndices(source, accessorId) {
  const accessor = source.json.accessors[accessorId], view = source.json.bufferViews[accessor.bufferView];
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0), out = new Uint32Array(accessor.count);
  if (accessor.componentType === 5125) for (let i = 0; i < accessor.count; i++) out[i] = source.bin.readUInt32LE(base + i * 4);
  else if (accessor.componentType === 5123) for (let i = 0; i < accessor.count; i++) out[i] = source.bin.readUInt16LE(base + i * 2);
  else throw new Error('Unsupported index component type ' + accessor.componentType);
  return out;
}

/** Squared distance from point p to triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
function pointTriangleDistanceSquared(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  const dist = (qx, qy, qz) => (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
  if (d1 <= 0 && d2 <= 0) return dist(ax, ay, az);
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return dist(bx, by, bz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return dist(ax + v * abx, ay + v * aby, az + v * abz); }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return dist(cx, cy, cz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return dist(ax + w * acx, ay + w * acy, az + w * acz); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return dist(bx + w * (cx - bx), by + w * (cy - by), bz + w * (cz - bz)); }
  const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
  return dist(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

/** Drops triangles with a vertex farther than cullDistance from the high-poly source model's surface. */
function cullToSource(source, sourceGlb) {
  const json = structuredClone(source.json), pieces = [source.bin];
  let length = source.bin.length;
  const reference = parse(sourceGlb);
  const cell = cullDistance, buckets = new Map(), triangles = [];
  for (const mesh of reference.json.meshes) for (const primitive of mesh.primitives) {
    const positions = accessorFloats(reference, primitive.attributes.POSITION), indices = accessorIndices(reference, primitive.indices);
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3, id = triangles.length / 9;
      triangles.push(positions[a], positions[a + 1], positions[a + 2], positions[b], positions[b + 1], positions[b + 2], positions[c], positions[c + 1], positions[c + 2]);
      const lo = [0, 1, 2].map(k => Math.floor((Math.min(positions[a + k], positions[b + k], positions[c + k]) - cell) / cell));
      const hi = [0, 1, 2].map(k => Math.floor((Math.max(positions[a + k], positions[b + k], positions[c + k]) + cell) / cell));
      for (let x = lo[0]; x <= hi[0]; x++) for (let y = lo[1]; y <= hi[1]; y++) for (let z = lo[2]; z <= hi[2]; z++) {
        const key = `${x},${y},${z}`;
        let bucket = buckets.get(key);
        if (!bucket) buckets.set(key, bucket = []);
        bucket.push(id);
      }
    }
  }
  const limit = cell * cell;
  const near = (x, y, z) => {
    const bucket = buckets.get(`${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`);
    if (!bucket) return false;
    for (const id of bucket) {
      const o = id * 9;
      if (pointTriangleDistanceSquared(x, y, z, triangles[o], triangles[o + 1], triangles[o + 2], triangles[o + 3], triangles[o + 4], triangles[o + 5], triangles[o + 6], triangles[o + 7], triangles[o + 8]) <= limit) return true;
    }
    return false;
  };
  const report = [];
  for (const mesh of json.meshes) for (const primitive of mesh.primitives) {
    if (primitive.indices === undefined || (primitive.mode ?? 4) !== 4) continue;
    const indices = accessorIndices(source, primitive.indices), positions = accessorFloats(source, primitive.attributes.POSITION);
    const floating = new Map();
    const isFloating = i => { let f = floating.get(i); if (f === undefined) floating.set(i, f = !near(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2])); return f; };
    const kept = [];
    for (let t = 0; t < indices.length; t += 3) if (!isFloating(indices[t]) && !isFloating(indices[t + 1]) && !isFloating(indices[t + 2])) kept.push(indices[t], indices[t + 1], indices[t + 2]);
    if (kept.length === indices.length) continue;
    const reduced = Uint32Array.from(kept);
    const pad = (4 - length % 4) % 4;
    if (pad) { pieces.push(Buffer.alloc(pad)); length += pad; }
    const bytes = Buffer.from(reduced.buffer, reduced.byteOffset, reduced.byteLength);
    json.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length, target: 34963 });
    pieces.push(bytes); length += bytes.length;
    json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5125, count: reduced.length, type: 'SCALAR' });
    report.push({ trianglesBefore: indices.length / 3, trianglesAfter: reduced.length / 3, removed: (indices.length - reduced.length) / 3, distance: cullDistance });
    primitive.indices = json.accessors.length - 1;
  }
  json.buffers = [{ byteLength: length }];
  return { built: { json, bin: Buffer.concat(pieces, length) }, report };
}

/** Removes needle triangles (see sliverAspect) from every indexed triangle primitive; vertices stay untouched. */
function pruneSlivers(source) {
  const json = structuredClone(source.json), pieces = [source.bin];
  let length = source.bin.length;
  const report = [];
  for (const mesh of json.meshes) for (const primitive of mesh.primitives) {
    if (primitive.indices === undefined || (primitive.mode ?? 4) !== 4) continue;
    const indices = accessorIndices(source, primitive.indices), positions = accessorFloats(source, primitive.attributes.POSITION);
    const accessor = source.json.accessors[primitive.attributes.POSITION];
    const diagonal = Math.hypot(...accessor.max.map((value, axis) => value - accessor.min[axis]));
    const kept = [];
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
      const ab = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
      const ac = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
      const bc = [positions[c] - positions[b], positions[c + 1] - positions[b + 1], positions[c + 2] - positions[b + 2]];
      const longest = Math.max(Math.hypot(...ab), Math.hypot(...ac), Math.hypot(...bc));
      const area = Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]) / 2;
      if (sliverAspects.some((aspect, tier) => longest > sliverEdges[tier] * diagonal && area / (longest * longest) < aspect)) continue;
      kept.push(indices[t], indices[t + 1], indices[t + 2]);
    }
    if (kept.length === indices.length) continue;
    const reduced = Uint32Array.from(kept);
    const pad = (4 - length % 4) % 4;
    if (pad) { pieces.push(Buffer.alloc(pad)); length += pad; }
    const bytes = Buffer.from(reduced.buffer, reduced.byteOffset, reduced.byteLength);
    json.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length, target: 34963 });
    pieces.push(bytes); length += bytes.length;
    json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5125, count: reduced.length, type: 'SCALAR' });
    report.push({ trianglesBefore: indices.length / 3, trianglesAfter: reduced.length / 3, removed: (indices.length - reduced.length) / 3 });
    primitive.indices = json.accessors.length - 1;
  }
  json.buffers = [{ byteLength: length }];
  return { built: { json, bin: Buffer.concat(pieces, length) }, report };
}

const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
/** Rewrites each primitive onto only the vertices its indices reference; attribute accessors must not be shared between primitives. */
function compactVertices(source) {
  const json = structuredClone(source.json), pieces = [source.bin];
  let length = source.bin.length;
  const claimed = new Set();
  const append = bytes => {
    const pad = (4 - length % 4) % 4;
    if (pad) { pieces.push(Buffer.alloc(pad)); length += pad; }
    const offset = length; pieces.push(bytes); length += bytes.length; return offset;
  };
  const report = [];
  for (const mesh of json.meshes) for (const primitive of mesh.primitives) {
    if (primitive.indices === undefined || (primitive.mode ?? 4) !== 4 || primitive.targets) continue;
    const indices = accessorIndices(source, primitive.indices);
    const count = source.json.accessors[primitive.attributes.POSITION].count;
    const used = new Uint8Array(count);
    for (const index of indices) used[index] = 1;
    if (runtimeCandidate && primitive.attributes.JOINTS_0 !== undefined) {
      // The live skinned simplifier retains the original bounds. Keep its six native extent vertices too,
      // without drawing extra triangles, so compaction cannot alter NPC fitting or grounded placement.
      const positions = accessorFloats(source, primitive.attributes.POSITION);
      const extrema = [0, 0, 0, 0, 0, 0];
      for (let i = 1; i < count; i++) for (let axis = 0; axis < 3; axis++) {
        if (positions[i * 3 + axis] < positions[extrema[axis] * 3 + axis]) extrema[axis] = i;
        if (positions[i * 3 + axis] > positions[extrema[axis + 3] * 3 + axis]) extrema[axis + 3] = i;
      }
      for (const index of extrema) used[index] = 1;
    }
    const remap = new Uint32Array(count);
    let kept = 0;
    for (let i = 0; i < count; i++) if (used[i]) remap[i] = kept++;
    if (kept === count) continue;
    const remapped = Uint32Array.from(indices, index => remap[index]);
    for (const [name, accessorId] of Object.entries(primitive.attributes)) {
      if (claimed.has(accessorId)) throw new Error(`Attribute accessor ${accessorId} (${name}) is shared between primitives`);
      claimed.add(accessorId);
      const accessor = source.json.accessors[accessorId], view = source.json.bufferViews[accessor.bufferView];
      if (accessor.sparse) throw new Error('Unsupported sparse attribute accessor');
      const elementBytes = COMPONENT_BYTES[accessor.componentType] * TYPE_COMPONENTS[accessor.type];
      const stride = view.byteStride ?? elementBytes, base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
      const out = Buffer.alloc(kept * ((elementBytes + 3) & ~3));
      const padded = (elementBytes + 3) & ~3;
      for (let i = 0; i < count; i++) if (used[i]) source.bin.copy(out, remap[i] * padded, base + i * stride, base + i * stride + elementBytes);
      json.bufferViews.push({ buffer: 0, byteOffset: append(out), byteLength: out.length, ...(padded === elementBytes ? {} : { byteStride: padded }), target: 34962 });
      const next = { ...accessor, bufferView: json.bufferViews.length - 1, byteOffset: 0, count: kept };
      if (name === 'POSITION') {
        const positions = new Float32Array(kept * 3);
        for (let i = 0; i < kept; i++) for (let c = 0; c < 3; c++) positions[i * 3 + c] = out.readFloatLE(i * padded + c * 4);
        next.min = [Infinity, Infinity, Infinity]; next.max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < kept; i++) for (let c = 0; c < 3; c++) { next.min[c] = Math.min(next.min[c], positions[i * 3 + c]); next.max[c] = Math.max(next.max[c], positions[i * 3 + c]); }
      }
      json.accessors.push(next);
      primitive.attributes[name] = json.accessors.length - 1;
    }
    const bytes = Buffer.from(remapped.buffer, remapped.byteOffset, remapped.byteLength);
    json.bufferViews.push({ buffer: 0, byteOffset: append(bytes), byteLength: bytes.length, target: 34963 });
    json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5125, count: remapped.length, type: 'SCALAR' });
    primitive.indices = json.accessors.length - 1;
    report.push({ verticesBefore: count, verticesAfter: kept });
  }
  json.buffers = [{ byteLength: length }];
  pruneOrphanAccessors(json);
  return { built: { json, bin: Buffer.concat(pieces, length) }, report };
}

/** Removes accessors nothing references (earlier build stages leave replaced index / vertex accessors behind) and renumbers the rest. */
function pruneOrphanAccessors(json) {
  const referenced = new Set();
  for (const mesh of json.meshes) for (const primitive of mesh.primitives) {
    Object.values(primitive.attributes).forEach(id => referenced.add(id));
    if (primitive.indices !== undefined) referenced.add(primitive.indices);
    for (const target of primitive.targets ?? []) Object.values(target).forEach(id => referenced.add(id));
  }
  for (const skin of json.skins ?? []) if (skin.inverseBindMatrices !== undefined) referenced.add(skin.inverseBindMatrices);
  for (const animation of json.animations ?? []) for (const sampler of animation.samplers) { referenced.add(sampler.input); referenced.add(sampler.output); }
  const renumber = new Map(), accessors = [];
  json.accessors.forEach((accessor, id) => { if (referenced.has(id)) { renumber.set(id, accessors.length); accessors.push(accessor); } });
  json.accessors = accessors;
  for (const mesh of json.meshes) for (const primitive of mesh.primitives) {
    for (const name of Object.keys(primitive.attributes)) primitive.attributes[name] = renumber.get(primitive.attributes[name]);
    if (primitive.indices !== undefined) primitive.indices = renumber.get(primitive.indices);
    for (const target of primitive.targets ?? []) for (const name of Object.keys(target)) target[name] = renumber.get(target[name]);
  }
  for (const skin of json.skins ?? []) if (skin.inverseBindMatrices !== undefined) skin.inverseBindMatrices = renumber.get(skin.inverseBindMatrices);
  for (const animation of json.animations ?? []) for (const sampler of animation.samplers) { sampler.input = renumber.get(sampler.input); sampler.output = renumber.get(sampler.output); }
}

/** Reduces each indexed triangle primitive, locking UV/material borders; vertices stay untouched (skinned assets only with --simplify-skinned). */
async function simplifyStatic(source, ratio) {
  if (source.json.skins?.length && !allowSkinned) throw new Error('Simplification is for static props; skinned assets keep their authored topology (opt in with --simplify-skinned)');
  await MeshoptSimplifier.ready;
  const json = structuredClone(source.json), pieces = [source.bin];
  let length = source.bin.length;
  const report = [];
  for (const mesh of json.meshes) for (const primitive of mesh.primitives) {
    if (primitive.indices === undefined || (primitive.mode ?? 4) !== 4) continue;
    const indices = accessorIndices(source, primitive.indices), positions = accessorFloats(source, primitive.attributes.POSITION);
    if (runtimeCandidate && indices.length / 3 <= 50_000) continue;
    const effectiveRatio = runtimeCandidate
      ? (primitive.attributes.WEIGHTS_0 !== undefined ? 0.05 : Math.min(0.05, 24_000 / indices.length))
      : ratio;
    const target = Math.max(3, Math.floor(indices.length * effectiveRatio / 3) * 3);
    const uvAccessor = primitive.attributes.TEXCOORD_0;
    const [reduced, error] = runtimeCandidate
      ? MeshoptSimplifier.simplify(indices, positions, 3, target, 0.01, ['LockBorder', 'Prune'])
      : uvWeight > 0 && uvAccessor !== undefined
        ? MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3, texcoords(source, uvAccessor), 2, [uvWeight, uvWeight], null, target, maxError, simplifyFlags)
        : MeshoptSimplifier.simplify(indices, positions, 3, target, maxError, simplifyFlags);
    if (!Number.isFinite(error) || reduced.length % 3 !== 0 || reduced.length === 0) throw new Error('Simplification produced invalid geometry');
    const pad = (4 - length % 4) % 4;
    if (pad) { pieces.push(Buffer.alloc(pad)); length += pad; }
    const bytes = Buffer.from(reduced.buffer, reduced.byteOffset, reduced.byteLength);
    json.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length, target: 34963 });
    pieces.push(bytes); length += bytes.length;
    json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5125, count: reduced.length, type: 'SCALAR' });
    report.push({ trianglesBefore: indices.length / 3, trianglesAfter: reduced.length / 3, relativeError: error });
    primitive.indices = json.accessors.length - 1;
  }
  json.buffers = [{ byteLength: length }];
  return { built: { json, bin: Buffer.concat(pieces, length) }, report };
}

/** Bind-pose position bounds over every primitive, plus scene-space bounds (node transforms applied) for static assets. */
function meshBounds(json) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  let vertices = 0, triangles = 0;
  for (const mesh of json.meshes) for (const primitive of mesh.primitives) {
    const position = json.accessors[primitive.attributes.POSITION];
    vertices += position.count;
    triangles += primitive.indices === undefined ? position.count / 3 : json.accessors[primitive.indices].count / 3;
    for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], position.min[axis]); max[axis] = Math.max(max[axis], position.max[axis]); }
  }
  const round = values => values.map(value => Number(value.toFixed(5)));
  const result = { vertices, triangles, min: round(min), max: round(max) };
  if (json.skins?.length) return result;
  const world = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const compose = (parent, node) => {
    const local = node.matrix ?? composeTrs(node.translation ?? [0, 0, 0], node.rotation ?? [0, 0, 0, 1], node.scale ?? [1, 1, 1]);
    return multiply(parent, local);
  };
  const visit = (index, parent) => {
    const node = json.nodes[index], matrix = compose(parent, node);
    if (node.mesh !== undefined) for (const primitive of json.meshes[node.mesh].primitives) {
      const position = json.accessors[primitive.attributes.POSITION];
      for (let corner = 0; corner < 8; corner++) {
        const point = [corner & 1 ? position.max[0] : position.min[0], corner & 2 ? position.max[1] : position.min[1], corner & 4 ? position.max[2] : position.min[2]];
        for (let axis = 0; axis < 3; axis++) {
          const value = matrix[axis] * point[0] + matrix[4 + axis] * point[1] + matrix[8 + axis] * point[2] + matrix[12 + axis];
          world.min[axis] = Math.min(world.min[axis], value); world.max[axis] = Math.max(world.max[axis], value);
        }
      }
    }
    for (const child of node.children ?? []) visit(child, matrix);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const rootNode of json.scenes[json.scene ?? 0].nodes) visit(rootNode, identity);
  result.world = { min: round(world.min), max: round(world.max) };
  return result;
}
/** Column-major 4x4 helpers (glTF convention); corner bounds are exact for translation/rotation/uniform-or-not scale hierarchies. */
function composeTrs([tx, ty, tz], [x, y, z, w], [sx, sy, sz]) {
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}
function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
  return out;
}

const rig = inputPath ? undefined : result('rig'), lod = inputPath ? undefined : result('decimate'), model = inputPath ? undefined : result('model');
// Every retarget batch (anim-a, anim-b, ...) produced by the chain shares the rig; the first is the base.
const anims = [];
if (!inputPath) for (let code = 97; code <= 122 && result(`anim-${String.fromCharCode(code)}`); code++) anims.push(result(`anim-${String.fromCharCode(code)}`));
// Rigged assets without retarget batches (authored-only clip sets) start from the bare rig output.
// `--base=model` starts a static prop from the high-poly model output instead of the Tripo decimation (Tripo's decimator collapsed the Ash Hunters' camp:
// its thin bamboo frames and tents came back as floating fragments); the local meshoptimizer pass then does the reduction.
const baseResult = option('base') === 'model' ? model : anims[0] ?? rig ?? lod;
if (option('base') !== undefined && option('base') !== 'model') throw new Error('--base must be "model"');
if (!inputPath && !baseResult) throw new Error(`No Tripo outputs for ${asset}`);
const basePath = resolve(ROOT, inputPath ?? join(baseResult.output_dir, 'model.glb'));
if (basePath === resolve(ROOT, 'asset-source/generated', `${asset}-runtime-${revisionTag}`, `${asset}.glb`)) throw new Error('Never overwrite the native input.');
let built = parse(readFileSync(basePath));
for (const donor of anims.slice(1)) built = mergeClips(built, parse(readFileSync(resolve(ROOT, donor.output_dir, 'model.glb'))));
let floatingCull = null;
if (cullDistance !== undefined) {
  if (!model) throw new Error('--cull-to-source needs the high-poly model step output');
  ({ built, report: floatingCull } = cullToSource(built, readFileSync(resolve(ROOT, model.output_dir, 'model.glb'))));
}
let slivers = null;
if (sliverAspects) ({ built, report: slivers } = pruneSlivers(built));
let simplification = null;
if (simplifyRatio !== undefined || runtimeCandidate) {
  ({ built, report: simplification } = await simplifyStatic(built, simplifyRatio));
  // Edge collapses re-triangulate across the mesh and can create fresh needles, so prune once more.
  if (sliverAspects) { const again = pruneSlivers(built); built = again.built; slivers = [...slivers, ...again.report]; }
}
let compaction = null;
if (compact || runtimeCandidate) ({ built, report: compaction } = compactVertices(built));
if (runtimeCandidate) for (const scene of built.json.scenes) scene.extras = { ...scene.extras, wildCrownCandidateGeometryBudget: 1 };
const { packed, report: textures } = recodeTextures(built, maxTexture);
const bytes = encode(packed.json, packed.bin);
const outDir = resolve(ROOT, 'asset-source/generated', `${asset}-runtime-${revisionTag}`);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${asset}.glb`), bytes);
const bounds = meshBounds(packed.json);
const rigTask = rig ? JSON.parse(readFileSync(resolve(ROOT, rig.output_dir, 'task.json'), 'utf8')) : undefined;
const rigLabel = rigTask ? `rig ${rigTask.input?.model_version ?? 'v2.5'} ${rigTask.input?.topology ?? 'unknown'} (${rigTask.input?.spec ?? 'tripo'} spec)` : null;
const provenance = {
  schemaVersion: 1, assetId: asset, generator: inputPath ? 'scripts/assets/build-greenwake-runtime-asset.mjs' : 'Tripo API via tripo-cli (scripts/assets/tripo-greenwake-chain.mjs)',
  tasks: {
    model: model?.task_id, decimate: lod?.task_id, rig: rig?.task_id,
    ...Object.fromEntries(anims.map((anim, index) => [`anim${String.fromCharCode(65 + index)}`, anim.task_id])),
  },
  settings: {
    ...(inputPath ? { operation: 'recondition-existing-native-glb' } : { model: 'tripo-v3.1', geometry_quality: 'detailed', texture_quality: 'extreme', pbr: true, rig: rigLabel, retarget: rig ? 'animate_in_place' : null }),
    simplifyRatio: simplifyRatio ?? null, maxError: runtimeCandidate ? .01 : simplifyRatio === undefined ? null : maxError,
    ...(runtimeCandidate ? { simplifyFlags: ['LockBorder', 'Prune'] } : simplifyRatio !== undefined && (simplifyFlags.join() !== 'LockBorder' || uvWeight) ? { simplifyFlags, uvWeight } : {}),
    maxTexture, ...(sliverAspects ? { pruneSlivers: sliverAspects.map((aspect, tier) => ({ aspect, edgeFractionOfDiagonal: sliverEdges[tier] })) } : {}),
    ...(cullDistance === undefined ? {} : { cullToSourceDistance: cullDistance }),
  },
  ...(runtimeCandidate ? { runtimeCandidateGeometry: { version: 1, recipe: 'CandidateGeometrySimplifier: static target 8000 triangles, deforming ratio 0.05, relative error 0.01, LockBorder + Prune; original selected vertex bytes and skinned bounds retained.' } } : {}),
  inputs: { base: { path: inputPath ?? baseResult.output_dir + '/model.glb', sha256: sha256(readFileSync(basePath)) } },
  output: { path: `asset-source/generated/${asset}-runtime-${revisionTag}/${asset}.glb`, sha256: sha256(bytes), bytes: bytes.length, vertices: bounds.vertices, triangles: bounds.triangles, boundsMin: bounds.min, boundsMax: bounds.max, ...(bounds.world ? { worldBoundsMin: bounds.world.min, worldBoundsMax: bounds.world.max } : {}) },
  clips: clipDurations(packed.json), textures, simplification, ...(floatingCull ? { floatingCull } : {}), ...(slivers ? { slivers } : {}), ...(compaction ? { compaction } : {}),
  assessment: { evidenceStatus: 'blocked', productionAcceptance: 'NOT_ESTABLISHED', note: 'Local playtest candidate; deformation and clip quality require in-game visual review.' },
};
writeFileSync(join(outDir, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ asset, output: provenance.output, clips: provenance.clips.map(clip => `${clip.name}:${clip.durationSeconds.toFixed(2)}`), textures }));
