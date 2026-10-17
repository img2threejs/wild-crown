#!/usr/bin/env node
// Split the native gate's thin wood lattice from its stone frame without changing triangles or UVs.
// Native X is depth. The lattice measures X=-0.01562..0.03448; the stone spans ~0.42.
// Keep all three vertices inside the wood depth slab, opening width and lintel height.
// Both review poses are reconstructed from the serialized derived GLB. Acceptance remains blocked.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeGlb, parseGlb, readAccessorAny } from './creature-rig-kit.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const option = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const SRC = resolve(ROOT, option('src', 'asset-source/generated/prop-migration-gate-runtime-01/prop-migration-gate.glb'));
const OUT_GLB = resolve(ROOT, option('out-glb', 'asset-source/generated/prop-migration-gate-runtime-01/prop-migration-gate-articulated.glb'));
const OUT_PROV = resolve(ROOT, option('out-prov', 'asset-source/generated/prop-migration-gate-runtime-01/provenance-articulated.json'));
const REVIEW_DIR = resolve(ROOT, option('review-dir', 'asset-source/generated/prop-migration-gate-runtime-01'));
const LIFT = Number(option('lift', '0.40'));
const MANIFEST_SCALE = 8.33; // matches the later-chapter propEntry.scale; used to report the runtime lift in metres.

if (!existsSync(SRC)) throw new Error(`Original GLB not found: ${SRC}`);

const { json, bin } = parseGlb(readFileSync(SRC));
const prim = json.meshes[0].primitives[0];
const positions = readAccessorAny(json, bin, prim.attributes.POSITION);
const normals = readAccessorAny(json, bin, prim.attributes.NORMAL);
const uvs = readAccessorAny(json, bin, prim.attributes.TEXCOORD_0);
const idx = readAccessorAny(json, bin, prim.indices);
const triangleCount = idx.length / 3;
const isPanelTri = t => {
  for (let corner = 0; corner < 3; corner++) {
    const offset = idx[t + corner] * 3;
    const x = positions[offset], y = positions[offset + 1], z = positions[offset + 2];
    if (x < -0.025 || x > 0.04 || Math.abs(z) >= 0.25 || y >= 0.22) return false;
  }
  return true;
};

// Build a vertex remap per part: each primitive only references the vertices it actually uses.
function buildPart(panelFlag) {
  const oldToNew = new Map();
  const newIdx = [];
  for (let t = 0; t < idx.length; t += 3) {
    if (isPanelTri(t) !== panelFlag) continue;
    for (let i = 0; i < 3; i++) {
      const v = idx[t + i];
      if (!oldToNew.has(v)) oldToNew.set(v, oldToNew.size);
      newIdx.push(oldToNew.get(v));
    }
  }
  const vertexCount = oldToNew.size;
  const newPos = new Float32Array(vertexCount * 3);
  const newNorm = new Float32Array(vertexCount * 3);
  const newUv = new Float32Array(vertexCount * 2);
  for (const [old, next] of oldToNew) {
    newPos[next * 3] = positions[old * 3];
    newPos[next * 3 + 1] = positions[old * 3 + 1];
    newPos[next * 3 + 2] = positions[old * 3 + 2];
    newNorm[next * 3] = normals[old * 3];
    newNorm[next * 3 + 1] = normals[old * 3 + 1];
    newNorm[next * 3 + 2] = normals[old * 3 + 2];
    newUv[next * 2] = uvs[old * 2];
    newUv[next * 2 + 1] = uvs[old * 2 + 1];
  }
  const indexU32 = new Uint32Array(newIdx);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < vertexCount; i++) {
    if (newPos[i * 3] < minX) minX = newPos[i * 3]; if (newPos[i * 3] > maxX) maxX = newPos[i * 3];
    if (newPos[i * 3 + 1] < minY) minY = newPos[i * 3 + 1]; if (newPos[i * 3 + 1] > maxY) maxY = newPos[i * 3 + 1];
    if (newPos[i * 3 + 2] < minZ) minZ = newPos[i * 3 + 2]; if (newPos[i * 3 + 2] > maxZ) maxZ = newPos[i * 3 + 2];
  }
  return { triangleCount: newIdx.length / 3, vertexCount, indexU32, newPos, newNorm, newUv,
    bounds: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } };
}

const frame = buildPart(false);
const panel = buildPart(true);
if (frame.triangleCount + panel.triangleCount !== triangleCount) throw new Error(`Triangle count mismatch: frame ${frame.triangleCount} + panel ${panel.triangleCount} != original ${triangleCount}`);

// Build the new GLB: keep the original textures/images/materials verbatim, drop the original mesh
// + node + its primitive, add two compact primitives (frame + panel), and a node hierarchy
// (root → frame node + panel node). The panel node carries the closed/open translations.
function align4(buf) { const pad = (4 - buf.length % 4) % 4; return pad ? Buffer.concat([buf, Buffer.alloc(pad)]) : buf; }

const textures = json.textures ?? [];
const images = json.images ?? [];
const samplers = json.samplers ?? (textures.length ? [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }] : []);
const material = structuredClone(json.materials[prim.material]);

const pieces = [];
let length = 0;
const viewMap = [];
function pushView(bytes, target) {
  const pad = (4 - length % 4) % 4;
  if (pad) { pieces.push(Buffer.alloc(pad)); length += pad; }
  pieces.push(bytes); viewMap.push({ buffer: 0, byteOffset: length, byteLength: bytes.length, target }); length += bytes.length;
  return viewMap.length - 1;
}
const imageBytes = images.map((img) => {
  const view = json.bufferViews[img.bufferView];
  return { src: bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength), mime: img.mimeType ?? 'image/jpeg', name: img.name };
});
const imageViewIds = imageBytes.map(({ src }) => pushView(src, undefined));
const accessors = [];
function pushAccessor(viewId, componentType, count, type, minMax) {
  const id = accessors.length;
  const acc = { bufferView: viewId, componentType, count, type };
  if (minMax) { acc.min = minMax.min; acc.max = minMax.max; }
  accessors.push(acc);
  return id;
}
function pushPartAttributes(part) {
  const posView = pushView(align4(Buffer.from(part.newPos.buffer)), 34962);
  const normView = pushView(align4(Buffer.from(part.newNorm.buffer)), 34962);
  const uvView = pushView(align4(Buffer.from(part.newUv.buffer)), 34962);
  const idxView = pushView(align4(Buffer.from(part.indexU32.buffer)), 34963);
  const posId = pushAccessor(posView, 5126, part.vertexCount, 'VEC3', { min: part.bounds.min, max: part.bounds.max });
  const normId = pushAccessor(normView, 5126, part.vertexCount, 'VEC3');
  const uvId = pushAccessor(uvView, 5126, part.vertexCount, 'VEC2');
  const idxId = pushAccessor(idxView, 5125, part.indexU32.length, 'SCALAR');
  return { posId, normId, uvId, idxId };
}
const frameAcc = pushPartAttributes(frame);
const panelAcc = pushPartAttributes(panel);
const framePrim = { attributes: { POSITION: frameAcc.posId, NORMAL: frameAcc.normId, TEXCOORD_0: frameAcc.uvId }, indices: frameAcc.idxId, material: 0, mode: 4 };
const panelPrim = { attributes: { POSITION: panelAcc.posId, NORMAL: panelAcc.normId, TEXCOORD_0: panelAcc.uvId }, indices: panelAcc.idxId, material: 0, mode: 4 };
const frameMesh = { name: 'tripo_mesh_migration_gate_frame', primitives: [framePrim] };
const panelMesh = { name: 'tripo_mesh_migration_gate_panel', primitives: [panelPrim] };
const frameNode = { name: 'migration_gate_frame', mesh: 0 };
const panelNode = { name: 'migration_gate_panel', mesh: 1, extras: { closedTranslation: [0, 0, 0], openTranslation: [0, LIFT, 0] } };
const rootNode = { name: 'migration_gate', children: [1, 2] };
const newJson = {
  asset: { version: '2.0', generator: 'author-migration-gate.mjs' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [rootNode, frameNode, panelNode],
  meshes: [frameMesh, panelMesh],
  materials: [material],
  textures: structuredClone(textures),
  images: images.map((img, i) => ({ ...img, bufferView: imageViewIds[i] })),
  samplers,
  accessors,
  bufferViews: viewMap,
  buffers: [{ byteLength: length }],
};
const newBin = Buffer.concat(pieces, length);
const outGlb = encodeGlb(newJson, newBin);
writeFileSync(OUT_GLB, outGlb);

// Verify the new GLB parses cleanly.
const verify = parseGlb(readFileSync(OUT_GLB));
if (verify.json.meshes.length !== 2) throw new Error(`Derived GLB expected 2 meshes, got ${verify.json.meshes.length}`);
if (verify.json.nodes.length !== 3) throw new Error(`Derived GLB expected 3 nodes, got ${verify.json.nodes.length}`);
const panelNodeVerify = verify.json.nodes[2];
if (panelNodeVerify.name !== 'migration_gate_panel') throw new Error(`Panel node name mismatch: ${panelNodeVerify.name}`);
if (!panelNodeVerify.extras || !Array.isArray(panelNodeVerify.extras.openTranslation)) throw new Error('Panel node missing openTranslation extras');
if (panelNodeVerify.extras.closedTranslation[0] !== 0 || panelNodeVerify.extras.closedTranslation[1] !== 0 || panelNodeVerify.extras.closedTranslation[2] !== 0) throw new Error('Panel closedTranslation must be origin');
if (panelNodeVerify.extras.openTranslation[1] !== LIFT) throw new Error(`Panel openTranslation[1] must equal LIFT (${LIFT})`);

// Verified counts: every original triangle ends up in exactly one part. Compute via a position-set
// comparison so the result is independent of the per-part vertex remap.
const triSet = (positions, indices) => {
  const set = new Set();
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    const pa = `${positions[a * 3].toFixed(6)},${positions[a * 3 + 1].toFixed(6)},${positions[a * 3 + 2].toFixed(6)}`;
    const pb = `${positions[b * 3].toFixed(6)},${positions[b * 3 + 1].toFixed(6)},${positions[b * 3 + 2].toFixed(6)}`;
    const pc = `${positions[c * 3].toFixed(6)},${positions[c * 3 + 1].toFixed(6)},${positions[c * 3 + 2].toFixed(6)}`;
    const keys = [pa, pb, pc].sort();
    set.add(`${keys[0]}|${keys[1]}|${keys[2]}`);
  }
  return set;
};
const origSet = triSet(positions, idx);
const framePosCheck = new Float32Array(frame.newPos.buffer.slice(0));
const frameIdxCheck = new Uint32Array(frame.indexU32.buffer.slice(0));
const panelPosCheck = new Float32Array(panel.newPos.buffer.slice(0));
const panelIdxCheck = new Uint32Array(panel.indexU32.buffer.slice(0));
const frameSet = triSet(framePosCheck, frameIdxCheck);
const panelSet = triSet(panelPosCheck, panelIdxCheck);
let inBoth = 0, inNeither = 0;
for (const tri of origSet) {
  const f = frameSet.has(tri), p = panelSet.has(tri);
  if (f && p) inBoth++;
  else if (!f && !p) inNeither++;
}
if (inBoth > 0) throw new Error(`Partition defect: ${inBoth} triangles appear in BOTH frame and panel`);
if (inNeither > 0) throw new Error(`Partition defect: ${inNeither} triangles appear in NEITHER frame nor panel`);
if (frameSet.size + panelSet.size !== origSet.size) throw new Error(`Partition defect: frame (${frameSet.size}) + panel (${panelSet.size}) != original unique (${origSet.size})`);

// Selected-bounds measurement only; real passage clearance also depends on the fixed frame.
const panelMinY = panel.bounds.min[1];
const liftedPanelMinY = panelMinY + LIFT;
const clearOpeningRuntime = LIFT * MANIFEST_SCALE;

// Sanity: native model minimum Y is what the manifest transform places at runtime Y ≈ 0.
const originalProv = JSON.parse(readFileSync(resolve(ROOT, 'asset-source/generated/prop-migration-gate-runtime-01/provenance.json'), 'utf8'));
const nativeMinYRuntime = originalProv.output.worldBoundsMin[1] * MANIFEST_SCALE + 3.15157; // matches propEntry.originOffset

// Write provenance JSON.
const originalSha = createHash('sha256').update(readFileSync(SRC)).digest('hex');
const derivedSha = createHash('sha256').update(outGlb).digest('hex');
const provenance = {
  schemaVersion: 1,
  assetId: 'prop-migration-gate',
  generator: 'author-migration-gate.mjs (Tripo API via tripo-greenwake-chain.mjs + native partition)',
  tasks: originalProv.tasks,
  settings: originalProv.settings,
  inputs: { ...originalProv.inputs, articulatedSource: { path: 'asset-source/generated/prop-migration-gate-runtime-01/prop-migration-gate.glb', sha256: originalSha } },
  output: {
    path: 'asset-source/generated/prop-migration-gate-runtime-01/prop-migration-gate-articulated.glb',
    sha256: derivedSha,
    bytes: outGlb.length,
    meshes: 2,
    nodes: 3,
    panelNodeName: 'migration_gate_panel',
    panelNodeExtras: { closedTranslation: [0, 0, 0], openTranslation: [0, LIFT, 0] },
    partition: { rule: 'all vertices inside X[-0.025,0.04], |Z|<0.25, Y<0.22', frameTriangles: frame.triangleCount, panelTriangles: panel.triangleCount, originalTriangles: triangleCount, frameVertices: frame.vertexCount, panelVertices: panel.vertexCount, frameUniqueTriangles: frameSet.size, panelUniqueTriangles: panelSet.size, originalUniqueTriangles: origSet.size },
    bounds: { frame: { min: frame.bounds.min, max: frame.bounds.max }, panel: { min: panel.bounds.min, max: panel.bounds.max } },
    lift: { nativeMetres: LIFT, runtimeMetres: Math.round(LIFT * MANIFEST_SCALE * 1000) / 1000, manifestScale: MANIFEST_SCALE },
    clearOpening: {
      floorRuntimeMetres: Math.round(nativeMinYRuntime * 1000) / 1000,
      lowestSelectedVertexNativeY: Math.round(panelMinY * 1000) / 1000,
      lowestSelectedVertexLiftedNativeY: Math.round(liftedPanelMinY * 1000) / 1000,
      lowestSelectedVertexLiftedRuntimeMetres: Math.round((liftedPanelMinY + 3.15157 / MANIFEST_SCALE) * MANIFEST_SCALE * 1000) / 1000,
      liftRuntimeMetres: Math.round(clearOpeningRuntime * 1000) / 1000,
      spec: '>= 3m physically clear passage; selected panel bounds alone do not prove this.',
      met: false,
      note: 'Requires native collider passage and visual verification of the wood/stone partition.',
    },
    textures: originalProv.textures,
  },
  assessment: { evidenceStatus: 'blocked', productionAcceptance: 'NOT_ESTABLISHED', note: 'Local candidate requiring visual partition review and physical passage verification.' },
};
writeFileSync(OUT_PROV, JSON.stringify(provenance, null, 2) + '\n');

// The existing CPU preview accepts one primitive; combine the actual derived primitives at each pose.
const PREVIEW = resolve(ROOT, 'scripts/assets/render-clip-preview.mjs');
function renderWithExisting(outPng, srcGlb, view = 'iso', cell = 360) {
  const r = spawnSync(process.execPath, [PREVIEW, srcGlb, outPng, `--view=${view}`, `--cell=${String(cell)}`], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`render-clip-preview failed (${r.status}): ${r.stderr || r.stdout || ''}`);
  }
  return r.stdout.trim();
}
const originalReviewPng = join(REVIEW_DIR, 'original-review.png');
const closedReviewPng = join(REVIEW_DIR, 'derived-static-review.png');
const openReviewPng = join(REVIEW_DIR, 'derived-open-review.png');
renderWithExisting(originalReviewPng, SRC, 'iso', 360);

// Build the temporary combined single-mesh GLB for the open render.
function buildCombinedPosedGlb(panelYOffset) {
  const [frame, panel] = verify.json.meshes.map(mesh => {
    const primitive = mesh.primitives[0];
    const newPos = readAccessorAny(verify.json, verify.bin, primitive.attributes.POSITION);
    const indexU32 = readAccessorAny(verify.json, verify.bin, primitive.indices);
    return { newPos, indexU32, vertexCount: newPos.length / 3, triangleCount: indexU32.length / 3,
      newNorm: readAccessorAny(verify.json, verify.bin, primitive.attributes.NORMAL),
      newUv: readAccessorAny(verify.json, verify.bin, primitive.attributes.TEXCOORD_0) };
  });
  // Combine the frame and translated panel into a single mesh with one primitive.
  const totalVerts = frame.vertexCount + panel.vertexCount;
  const totalTris = frame.triangleCount + panel.triangleCount;
  const combinedPos = new Float32Array(totalVerts * 3);
  const combinedNorm = new Float32Array(totalVerts * 3);
  const combinedUv = new Float32Array(totalVerts * 2);
  combinedPos.set(frame.newPos, 0);
  combinedPos.set(panel.newPos, frame.newPos.length);
  combinedNorm.set(frame.newNorm, 0);
  combinedNorm.set(panel.newNorm, frame.newNorm.length);
  combinedUv.set(frame.newUv, 0);
  combinedUv.set(panel.newUv, frame.newUv.length);
  // Apply Y translation to the placed panel vertices.
  for (let i = frame.newPos.length / 3; i < totalVerts; i++) combinedPos[i * 3 + 1] += panelYOffset;
  const combinedIdx = new Uint32Array(totalTris * 3);
  combinedIdx.set(frame.indexU32, 0);
  for (let i = 0; i < panel.indexU32.length; i++) combinedIdx[frame.indexU32.length + i] = panel.indexU32[i] + frame.vertexCount;
  // Build a new glTF JSON mirroring the original asset shape (single mesh, single primitive).
  const cPieces = [];
  let cLength = 0;
  const cViewMap = [];
  function cPushView(bytes, target) {
    const pad = (4 - cLength % 4) % 4;
    if (pad) { cPieces.push(Buffer.alloc(pad)); cLength += pad; }
    cPieces.push(bytes); cViewMap.push({ buffer: 0, byteOffset: cLength, byteLength: bytes.length, target }); cLength += bytes.length;
    return cViewMap.length - 1;
  }
  const cImageViewIds = imageBytes.map(({ src }) => cPushView(src, undefined));
  const cAccessors = [];
  function cPushAccessor(viewId, componentType, count, type, minMax) {
    const id = cAccessors.length;
    const acc = { bufferView: viewId, componentType, count, type };
    if (minMax) { acc.min = minMax.min; acc.max = minMax.max; }
    cAccessors.push(acc);
    return id;
  }
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < totalVerts; i++) {
    if (combinedPos[i * 3] < minX) minX = combinedPos[i * 3]; if (combinedPos[i * 3] > maxX) maxX = combinedPos[i * 3];
    if (combinedPos[i * 3 + 1] < minY) minY = combinedPos[i * 3 + 1]; if (combinedPos[i * 3 + 1] > maxY) maxY = combinedPos[i * 3 + 1];
    if (combinedPos[i * 3 + 2] < minZ) minZ = combinedPos[i * 3 + 2]; if (combinedPos[i * 3 + 2] > maxZ) maxZ = combinedPos[i * 3 + 2];
  }
  const posView = cPushView(align4(Buffer.from(combinedPos.buffer)), 34962);
  const normView = cPushView(align4(Buffer.from(combinedNorm.buffer)), 34962);
  const uvView = cPushView(align4(Buffer.from(combinedUv.buffer)), 34962);
  const idxView = cPushView(align4(Buffer.from(combinedIdx.buffer)), 34963);
  const posId = cPushAccessor(posView, 5126, totalVerts, 'VEC3', { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] });
  const normId = cPushAccessor(normView, 5126, totalVerts, 'VEC3');
  const uvId = cPushAccessor(uvView, 5126, totalVerts, 'VEC2');
  const idxId = cPushAccessor(idxView, 5125, totalTris * 3, 'SCALAR');
  const combinedPrim = { attributes: { POSITION: posId, NORMAL: normId, TEXCOORD_0: uvId }, indices: idxId, material: 0, mode: 4 };
  const combinedJson = {
    asset: { version: '2.0', generator: 'author-migration-gate.mjs (combined open pose)' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'migration_gate_open_pose', mesh: 0 }],
    meshes: [{ name: 'tripo_mesh_migration_gate_open_pose', primitives: [combinedPrim] }],
    materials: [material],
    textures: structuredClone(textures),
    images: images.map((img, i) => ({ ...img, bufferView: cImageViewIds[i] })),
    samplers,
    accessors: cAccessors,
    bufferViews: cViewMap,
    buffers: [{ byteLength: cLength }],
  };
  return { json: combinedJson, bin: Buffer.concat(cPieces, cLength) };
}

const tempDir = mkdtempSync(join(tmpdir(), 'wc-mg-'));
const tempGlb = join(tempDir, 'migration-gate-open-posed.glb');
try {
  const closed = buildCombinedPosedGlb(0);
  writeFileSync(tempGlb, encodeGlb(closed.json, closed.bin));
  renderWithExisting(closedReviewPng, tempGlb, 'iso', 360);
  const combined = buildCombinedPosedGlb(LIFT);
  writeFileSync(tempGlb, encodeGlb(combined.json, combined.bin));
  renderWithExisting(openReviewPng, tempGlb, 'iso', 360);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log(JSON.stringify({
  src: 'asset-source/generated/prop-migration-gate-runtime-01/prop-migration-gate.glb',
  srcSha256: originalSha,
  outGlb: 'asset-source/generated/prop-migration-gate-runtime-01/prop-migration-gate-articulated.glb',
  outSha256: derivedSha,
  outProvenance: 'asset-source/generated/prop-migration-gate-runtime-01/provenance-articulated.json',
  originalTriangles: triangleCount,
  frameTriangles: frame.triangleCount,
  panelTriangles: panel.triangleCount,
  frameVertices: frame.vertexCount,
  panelVertices: panel.vertexCount,
  uniqueTriangles: { original: origSet.size, frame: frameSet.size, panel: panelSet.size, inBoth, inNeither },
  panelNodeExtras: panelNode.extras,
  lift: { nativeMetres: LIFT, runtimeMetres: Math.round(LIFT * MANIFEST_SCALE * 1000) / 1000 },
  clearOpening: {
    floorRuntimeMetres: Math.round(nativeMinYRuntime * 1000) / 1000,
    lowestSelectedVertexNativeY: Math.round(panelMinY * 1000) / 1000,
    lowestSelectedVertexLiftedNativeY: Math.round(liftedPanelMinY * 1000) / 1000,
    liftRuntimeMetres: Math.round(clearOpeningRuntime * 1000) / 1000,
    metSpec: false,
  },
  reviews: { original: 'original-review.png', closed: 'derived-static-review.png', open: 'derived-open-review.png' },
}, null, 2));
