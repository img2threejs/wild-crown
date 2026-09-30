#!/usr/bin/env node
import { readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";

function fail(message) { throw new Error(message); }
const file = process.argv[2];
if (!file || process.argv.length !== 3) fail("Usage: node scripts/assets/inspect-glb.mjs <file.glb>");
const bytes = await readFile(file);
if (bytes.length < 20) fail("GLB is truncated before its first chunk");
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
if (view.getUint32(0, true) !== 0x46546c67) fail("Invalid GLB magic; expected glTF");
const version = view.getUint32(4, true);
if (version !== 2) fail("Unsupported GLB version " + version);
if (view.getUint32(8, true) !== bytes.length) fail("GLB declared length does not match file length");
let offset = 12, document = null, binBytes = null;
while (offset < bytes.length) {
  if (offset + 8 > bytes.length) fail("Truncated GLB chunk header");
  const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true);
  offset += 8;
  if (length % 4 !== 0 || offset + length > bytes.length) fail("Invalid GLB chunk length or alignment");
  if (type === 0x4e4f534a) {
    if (document !== null || offset !== 20) fail("GLB must begin with one JSON chunk");
    try { document = JSON.parse(new TextDecoder().decode(bytes.subarray(offset, offset + length)).replace(/\0+$/u, "").trim()); }
    catch { fail("Invalid GLB JSON chunk"); }
  } else if (type === 0x004e4942) {
    if (binBytes !== null) fail("Multiple BIN chunks are not supported");
    binBytes = length;
  }
  offset += length;
}
if (!document || !Array.isArray(document.nodes)) fail("GLB JSON must contain a nodes array");
const arrays = ["accessors", "bufferViews", "buffers", "meshes", "nodes", "skins", "animations", "scenes"];
for (const name of arrays) if (document[name] !== undefined && !Array.isArray(document[name])) fail(name + " must be an array");
const length = name => (document[name] || []).length;
const ref = (name, value, label) => { if (!Number.isInteger(value) || value < 0 || value >= length(name)) fail(label + " references missing " + name + "[" + value + "]"); };
for (const [i, node] of (document.nodes || []).entries()) {
  if (node.mesh !== undefined) ref("meshes", node.mesh, "nodes[" + i + "].mesh");
  if (node.skin !== undefined) ref("skins", node.skin, "nodes[" + i + "].skin");
  for (const child of node.children || []) ref("nodes", child, "nodes[" + i + "].children");
}
for (const [i, skin] of (document.skins || []).entries()) {
  if (!Array.isArray(skin.joints) || skin.joints.length === 0) fail("skins[" + i + "] has no joints");
  for (const joint of skin.joints) ref("nodes", joint, "skins[" + i + "].joints");
  if (skin.skeleton !== undefined) ref("nodes", skin.skeleton, "skins[" + i + "].skeleton");
  if (skin.inverseBindMatrices !== undefined) ref("accessors", skin.inverseBindMatrices, "skins[" + i + "].inverseBindMatrices");
}
for (const [i, mesh] of (document.meshes || []).entries()) {
  if (!Array.isArray(mesh.primitives) || !mesh.primitives.length) fail("meshes[" + i + "] has no primitives");
  for (const [j, primitive] of mesh.primitives.entries()) {
    if (primitive.indices !== undefined) ref("accessors", primitive.indices, "mesh indices");
    for (const accessor of Object.values(primitive.attributes || {})) ref("accessors", accessor, "mesh attributes");
    for (const target of primitive.targets || []) for (const accessor of Object.values(target)) ref("accessors", accessor, "mesh morph target");
  }
}
for (const [i, animation] of (document.animations || []).entries()) {
  for (const [j, sampler] of (animation.samplers || []).entries()) {
    ref("accessors", sampler.input, "animations[" + i + "].samplers[" + j + "].input");
    ref("accessors", sampler.output, "animations[" + i + "].samplers[" + j + "].output");
  }
  for (const [j, channel] of (animation.channels || []).entries()) {
    ref("nodes", channel.target && channel.target.node, "animations[" + i + "].channels[" + j + "].target.node");
    if (!Number.isInteger(channel.sampler) || channel.sampler < 0 || channel.sampler >= (animation.samplers || []).length) fail("animation channel references missing sampler");
  }
}
for (const [i, accessor] of (document.accessors || []).entries()) if (accessor.bufferView !== undefined) ref("bufferViews", accessor.bufferView, "accessors[" + i + "].bufferView");
for (const [i, item] of (document.bufferViews || []).entries()) if (item.buffer !== undefined) ref("buffers", item.buffer, "bufferViews[" + i + "].buffer");
const report = {
  path: await realpath(file), sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length,
  gltfVersion: document.asset && document.asset.version || null,
  counts: Object.fromEntries(arrays.map(name => [name, length(name)])), binaryChunkBytes: binBytes,
  skins: (document.skins || []).map((skin, index) => ({ index, name: skin.name || null, jointCount: skin.joints.length, inverseBindMatricesAccessor: skin.inverseBindMatrices === undefined ? null : skin.inverseBindMatrices, hasInverseBindMatrices: skin.inverseBindMatrices !== undefined })),
  animationClips: (document.animations || []).map((clip, index) => ({ index, name: clip.name || "animation-" + index, channels: (clip.channels || []).length, samplers: (clip.samplers || []).length })),
  structuralReferencesValid: true, rigQuality: "not-measured", animationQuality: "not-measured"
};
console.log(JSON.stringify(report, null, 2));
