#!/usr/bin/env node
/**
 * Builds Yara's rigged base mesh (asset-source/generated/actor-yara-c-rig-01/yara-c-rig.glb) from two committed sources:
 *   - the Tripo v3.1 Ultra model (asset-source/generated/actor-yara-c-model-01/model.glb): material and textures;
 *   - Mixamo's auto-rig of that model (asset-source/mixamo/yara-rig/yara-c-tpose.fbx): the 65-joint skeleton, skin weights and the decimated mesh
 *     (200k triangles, uploaded as OBJ facing +Z, 170 cm tall). The "T-pose" download keeps the A-pose bind plus a one-frame clip that holds the T-pose.
 *
 * Steps, all deterministic:
 *   1. weld the FBX's per-corner vertices and restore `mixamorig:` bone names;
 *   2. rebind the leaf skirt (the auto-rigger glues it to the thighs, so every stride stretched it into a sheet between the legs): skirt vertices are the
 *      lower-body texels that are not skin (leaf texels anywhere, others outside the leg volume), grown across shared faces; each follows the hips, with a
 *      share on the thigh it lies over that falls off with its distance from that thigh's surface and grows towards the hem;
 *   3. drop the faces that join the two legs (Tripo fuses a thin web between the knees);
 *   4. bake the T-pose frame into the mesh and rebind there, so the rest pose is the X Bot rest of the Viggle/Mixamo takes (arms level);
 *   5. bind every joint of the hierarchy (finger tips, toe and head ends too: the runtime finger grasp needs `…4`) and scale to 1.0 (×1.7 in the manifest).
 * Usage: node scripts/assets/build-yara-mixamo-rig.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Box3, BufferAttribute, Matrix3, Matrix4, Quaternion, Skeleton, Vector3 } from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { parseGlb, encodeGlb } from './import-aren-animation-set.mjs';
import { parseFbx } from './mixamo-import.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const SOURCES = { fbx: 'asset-source/mixamo/yara-rig/yara-c-tpose.fbx', model: 'asset-source/generated/actor-yara-c-model-01/model.glb' };
const OUTPUT = 'asset-source/generated/actor-yara-c-rig-01';
const HEIGHT = 1.0;
/** Skirt rebind (centimetres, FBX units): thigh share at the knee, its fall-off from the thigh surface, thigh radius at hip/knee, shin radius, hem below the knee. */
const SKIRT = { thighShare: 0.8, falloff: 4, thighRadius: [10, 7.5], shinRadius: 8.5, hemBelowKnee: 25 };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/* ------------------------------------------------------------------ texture pixels */

/** Decodes an embedded image to RGB with ffmpeg (PPM): { width, height, rgb }. */
function decodeImage(bytes) {
  const ppm = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 'image2pipe', '-vcodec', 'ppm', 'pipe:1'], { input: bytes, maxBuffer: 1 << 30 });
  let offset = 0;
  const token = () => {
    while (ppm[offset] === 0x20 || ppm[offset] === 0x0a || ppm[offset] === 0x0d || ppm[offset] === 0x09) offset += 1;
    const start = offset;
    while (!(ppm[offset] === 0x20 || ppm[offset] === 0x0a || ppm[offset] === 0x0d || ppm[offset] === 0x09)) offset += 1;
    return ppm.subarray(start, offset).toString('ascii');
  };
  if (token() !== 'P6') throw new Error('Expected a binary PPM');
  const width = Number(token()), height = Number(token()), max = Number(token());
  if (max !== 255) throw new Error('Expected 8-bit PPM');
  offset += 1;
  return { width, height, rgb: ppm.subarray(offset, offset + width * height * 3) };
}

/* ------------------------------------------------------------------ skirt, bridges, rest bake */

function segDist(p, a, b) {
  const ab = b.clone().sub(a), t = Math.min(1, Math.max(0, p.clone().sub(a).dot(ab) / ab.lengthSq()));
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

function reskinSkirt(mesh, image) {
  const { thighShare, falloff, thighRadius, shinRadius, hemBelowKnee } = SKIRT;
  const uv = mesh.geometry.attributes.uv, { width: TW, height: TH, rgb } = image;
  const texel = (i) => (Math.min(TH - 1, Math.max(0, Math.floor(uv.getY(i) * TH))) * TW + Math.min(TW - 1, Math.max(0, Math.floor(uv.getX(i) * TW)))) * 3;
  const isSkin = (i) => { const o = texel(i), mx = Math.max(rgb[o], rgb[o + 1], rgb[o + 2]), mn = Math.min(rgb[o], rgb[o + 1], rgb[o + 2]); return mx > 160 && mx - mn < 50; };
  const isBoot = (i) => { const o = texel(i), r = rgb[o], g = rgb[o + 1], b = rgb[o + 2]; return Math.max(r, g, b) < 150 && r - b < 70 && r >= b; };
  const isLeaf = (i) => { const o = texel(i), r = rgb[o], g = rgb[o + 1], b = rgb[o + 2]; return r > 120 && r - b > 70 && r >= g; };
  const bones = mesh.skeleton.bones, idx = (name) => bones.findIndex((bone) => bone.name === `mixamorig:${name}`);
  const hips = idx('Hips'), spine = idx('Spine'), lUp = idx('LeftUpLeg'), rUp = idx('RightUpLeg'), lLeg = idx('LeftLeg'), rLeg = idx('RightLeg'), lFoot = idx('LeftFoot'), rFoot = idx('RightFoot');
  const lower = new Set([hips, spine, lUp, rUp, lLeg, rLeg, lFoot, rFoot]);
  const wp = (i) => bones[i].getWorldPosition(new Vector3());
  const P = { hips: wp(hips), spine: wp(spine), lUp: wp(lUp), rUp: wp(rUp), lLeg: wp(lLeg), rLeg: wp(rLeg), lFoot: wp(lFoot), rFoot: wp(rFoot) };
  const waistY = (P.hips.y + P.spine.y) / 2, kneeY = (P.lLeg.y + P.rLeg.y) / 2;
  const pos = mesh.geometry.attributes.position, si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
  const thighR = (p, up, knee) => { const t = Math.min(1, Math.max(0, (up.y - p.y) / (up.y - knee.y))); return thighRadius[0] + (thighRadius[1] - thighRadius[0]) * t; };
  const n = pos.count, world = new Float32Array(n * 3), candidate = new Uint8Array(n), inSkirt = new Uint8Array(n), v = new Vector3();
  for (let i = 0; i < n; i += 1) {
    v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld); world[i * 3] = v.x; world[i * 3 + 1] = v.y; world[i * 3 + 2] = v.z;
    if (v.y > waistY || v.y < kneeY - hemBelowKnee) continue;
    let other = 0;
    for (let k = 0; k < 4; k += 1) if (!lower.has(si.getComponent(i, k))) other += sw.getComponent(i, k);
    // Hands and gloves hang at hip height in the A-pose; skin is never skirt; below the knee the brown leather is boot.
    if (other > 0.05 || isSkin(i) || (v.y < kneeY && isBoot(i))) continue;
    candidate[i] = 1;
    const inThigh = segDist(v, P.lUp, P.lLeg) < thighR(v, P.lUp, P.lLeg) || segDist(v, P.rUp, P.rLeg) < thighR(v, P.rUp, P.rLeg);
    const inShin = segDist(v, P.lLeg, P.lFoot) < shinRadius || segDist(v, P.rLeg, P.rFoot) < shinRadius;
    if (isLeaf(i) || !(inThigh || inShin || v.y < kneeY)) inSkirt[i] = 1;
  }
  const index = mesh.geometry.index.array;
  let grown = 0;
  for (let pass = 0; pass < 8; pass += 1) {
    let added = 0;
    for (let t = 0; t < index.length; t += 3) {
      const a = index[t], b = index[t + 1], c = index[t + 2];
      if (!(inSkirt[a] || inSkirt[b] || inSkirt[c])) continue;
      for (const x of [a, b, c]) if (!inSkirt[x] && candidate[x]) { inSkirt[x] = 1; added += 1; }
    }
    grown += added;
    if (!added) break;
  }
  let skirt = 0;
  for (let i = 0; i < n; i += 1) {
    if (!inSkirt[i]) continue;
    skirt += 1;
    v.set(world[i * 3], world[i * 3 + 1], world[i * 3 + 2]);
    const t = Math.min(1, Math.max(0, (waistY - v.y) / (waistY - kneeY)));
    const reach = (up, knee) => Math.exp(-Math.max(0, segDist(v, up, knee) - thighR(v, up, knee)) / falloff);
    const cl = reach(P.lUp, P.lLeg), cr = reach(P.rUp, P.rLeg);
    const total = thighShare * Math.sqrt(t) * Math.max(cl, cr), wl = cl / (cl + cr + 1e-6);
    si.setXYZW(i, hips, lUp, rUp, 0); sw.setXYZW(i, 1 - total, total * wl, total * (1 - wl), 0);
  }
  return { skirt, grown };
}

function dropLegBridges(mesh) {
  const bones = mesh.skeleton.bones, g = mesh.geometry, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
  const side = new Int8Array(bones.length);
  bones.forEach((bone, i) => { if (/Left(UpLeg|Leg|Foot|ToeBase)/.test(bone.name)) side[i] = 1; else if (/Right(UpLeg|Leg|Foot|ToeBase)/.test(bone.name)) side[i] = -1; });
  const vs = new Int8Array(si.count);
  for (let i = 0; i < si.count; i += 1) {
    let l = 0, r = 0;
    for (let k = 0; k < 4; k += 1) { const s = side[si.getComponent(i, k)], w = sw.getComponent(i, k); if (s > 0) l += w; else if (s < 0) r += w; }
    vs[i] = l > 0.6 ? 1 : r > 0.6 ? -1 : 0;
  }
  const index = g.index.array, kept = [];
  let dropped = 0;
  for (let t = 0; t < index.length; t += 3) {
    const a = vs[index[t]], b = vs[index[t + 1]], c = vs[index[t + 2]];
    if ((a > 0 || b > 0 || c > 0) && (a < 0 || b < 0 || c < 0)) { dropped += 1; continue; }
    kept.push(index[t], index[t + 1], index[t + 2]);
  }
  g.setIndex(kept);
  return { dropped };
}

function bakeRestFromClip(group, mesh, clip) {
  const byName = new Map();
  group.traverse((node) => { if (node.isBone) byName.set(node.name.replace(':', ''), node); });
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.'), node = byName.get(track.name.slice(0, dot)), property = track.name.slice(dot + 1), v = track.values;
    if (!node) continue;
    if (property === 'quaternion') node.quaternion.set(v[0], v[1], v[2], v[3]);
    else if (property === 'position') node.position.set(v[0], v[1], v[2]);
    else if (property === 'scale') node.scale.set(v[0], v[1], v[2]);
  }
  group.updateMatrixWorld(true);
  const g = mesh.geometry, pos = g.attributes.position, nrm = g.attributes.normal, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
  const bones = mesh.skeleton.bones, inverses = mesh.skeleton.boneInverses;
  const boneMatrix = bones.map((bone, i) => new Matrix4().multiplyMatrices(mesh.bindMatrixInverse, bone.matrixWorld).multiply(inverses[i]).multiply(mesh.bindMatrix));
  const outP = new Float32Array(pos.count * 3), outN = new Float32Array(pos.count * 3), m = new Matrix4(), v = new Vector3(), n = new Vector3(), nm = new Matrix3();
  for (let i = 0; i < pos.count; i += 1) {
    m.elements.fill(0);
    for (let k = 0; k < 4; k += 1) { const w = sw.getComponent(i, k); if (!w) continue; const e = boneMatrix[si.getComponent(i, k)].elements; for (let j = 0; j < 16; j += 1) m.elements[j] += e[j] * w; }
    v.fromBufferAttribute(pos, i).applyMatrix4(m); outP[i * 3] = v.x; outP[i * 3 + 1] = v.y; outP[i * 3 + 2] = v.z;
    n.fromBufferAttribute(nrm, i).applyMatrix3(nm.setFromMatrix4(m)).normalize(); outN[i * 3] = n.x; outN[i * 3 + 1] = n.y; outN[i * 3 + 2] = n.z;
  }
  g.setAttribute('position', new BufferAttribute(outP, 3)); g.setAttribute('normal', new BufferAttribute(outN, 3));
}

/* ------------------------------------------------------------------ glTF writer */

function writeGlb(group, mesh, model) {
  const chunks = [], views = [], accessors = [];
  let length = 0;
  const pushView = (bytes, target) => {
    const pad = (4 - (length % 4)) % 4;
    if (pad) { chunks.push(Buffer.alloc(pad)); length += pad; }
    views.push({ buffer: 0, byteOffset: length, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
    chunks.push(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)); length += bytes.byteLength;
    return views.length - 1;
  };
  const pushAccessor = (array, type, componentType, target, extra = {}) => {
    accessors.push({ bufferView: pushView(array, target), componentType, count: array.length / { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type], type, ...extra });
    return accessors.length - 1;
  };
  // Nodes: the root, every bone (hierarchy order), the mesh.
  const nodes = [], nodeOf = new Map();
  const visit = (object) => {
    const id = nodes.length;
    nodeOf.set(object, id);
    const node = { name: object.name || 'Armature' };
    if (!object.position.equals(new Vector3())) node.translation = object.position.toArray();
    if (object.quaternion.w !== 1) node.rotation = object.quaternion.toArray();
    if (!object.scale.equals(new Vector3(1, 1, 1))) node.scale = object.scale.toArray();
    nodes.push(node);
    const children = object.children.filter((child) => child.isBone || child === mesh).map(visit);
    if (children.length) node.children = children;
    return id;
  };
  const rootId = visit(group);
  const g = mesh.geometry, position = g.attributes.position.array, box = new Box3().setFromBufferAttribute(g.attributes.position);
  const weights = new Float32Array(g.attributes.skinWeight.count * 4);
  for (let i = 0; i < g.attributes.skinWeight.count; i += 1) {
    let sum = 0;
    for (let k = 0; k < 4; k += 1) sum += g.attributes.skinWeight.getComponent(i, k);
    for (let k = 0; k < 4; k += 1) weights[i * 4 + k] = sum > 0 ? g.attributes.skinWeight.getComponent(i, k) / sum : (k === 0 ? 1 : 0);
  }
  const attributes = {
    POSITION: pushAccessor(new Float32Array(position), 'VEC3', 5126, 34962, { min: box.min.toArray(), max: box.max.toArray() }),
    NORMAL: pushAccessor(new Float32Array(g.attributes.normal.array), 'VEC3', 5126, 34962),
    TEXCOORD_0: pushAccessor(new Float32Array(g.attributes.uv.array), 'VEC2', 5126, 34962),
    JOINTS_0: pushAccessor(Uint16Array.from(g.attributes.skinIndex.array), 'VEC4', 5123, 34962),
    WEIGHTS_0: pushAccessor(weights, 'VEC4', 5126, 34962),
  };
  const indices = pushAccessor(Uint32Array.from(g.index.array), 'SCALAR', 5125, 34963);
  const bones = mesh.skeleton.bones, ibm = new Float32Array(bones.length * 16);
  mesh.skeleton.boneInverses.forEach((matrix, i) => ibm.set(matrix.elements, i * 16));
  const inverseBindMatrices = pushAccessor(ibm, 'MAT4', 5126);
  // Material and textures straight from the Tripo model (images copied byte for byte).
  const { json: mj, bin: mb } = model;
  const images = mj.images.map((image) => {
    const view = mj.bufferViews[image.bufferView], bytes = mb.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    return { name: image.name, mimeType: image.mimeType, bufferView: pushView(new Uint8Array(bytes)) };
  });
  const material = { ...mj.materials[0], name: 'yara' };
  const meshId = nodeOf.get(mesh);
  nodes[meshId] = { name: 'yara', mesh: 0, skin: 0 };
  const json = {
    asset: { version: '2.0', generator: 'wild-crown build-yara-mixamo-rig.mjs' },
    scene: 0, scenes: [{ name: 'Scene', nodes: [rootId] }], nodes,
    meshes: [{ name: 'yara', primitives: [{ attributes, indices, material: 0 }] }],
    skins: [{ name: 'yara', joints: bones.map((bone) => nodeOf.get(bone)), inverseBindMatrices }],
    materials: [material], textures: mj.textures, samplers: mj.samplers, images,
    accessors, bufferViews: views, buffers: [{ byteLength: length }],
  };
  return encodeGlb(json, Buffer.concat(chunks));
}

/* ------------------------------------------------------------------ build */

const fbxBytes = await readFile(root + SOURCES.fbx), modelBytes = await readFile(root + SOURCES.model);
const group = parseFbx(fbxBytes), model = parseGlb(modelBytes);
const meshes = [];
group.traverse((node) => { if (node.isSkinnedMesh) meshes.push(node); });
if (meshes.length !== 1) throw new Error(`Expected one skinned mesh, found ${meshes.length}`);
const mesh = meshes[0];
const clip = group.animations[0];
if (!clip) throw new Error('The T-pose FBX carries no pose clip');
// Mixamo received the OBJ with v' = 1 - v; flip back to the glTF texture convention of the Tripo material.
const uv = mesh.geometry.attributes.uv;
for (let i = 0; i < uv.count; i += 1) uv.setY(i, 1 - uv.getY(i));
group.traverse((node) => { if (node.isBone && /^mixamorig[^:]/.test(node.name)) node.name = node.name.replace(/^mixamorig/, 'mixamorig:'); });
mesh.geometry = mergeVertices(mesh.geometry, 1e-6);
group.updateMatrixWorld(true);
const baseColor = model.json.images[model.json.textures[model.json.materials[0].pbrMetallicRoughness.baseColorTexture.index].source];
const view = model.json.bufferViews[baseColor.bufferView];
const image = decodeImage(model.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
const skirt = reskinSkirt(mesh, image);
const bridges = dropLegBridges(mesh);
bakeRestFromClip(group, mesh, clip);
// Every joint of the hierarchy is a skin joint (unweighted ends included), scaled to HEIGHT.
const bound = new Set(mesh.skeleton.bones), extra = [];
group.traverse((node) => { if (node.isBone && !bound.has(node)) extra.push(node); });
group.name = 'Armature';
// Scale baked into the data (vertices and bone offsets), not a node scale: the 1.0-tall rig of the previous Yara, metres in the buffers. The rest pose is
// also turned +90° about +Y to face +X, the Tripo biped convention the Yara author script and its scene-level `YaraForward` node are written for.
const height = new Box3().setFromBufferAttribute(mesh.geometry.attributes.position), scale = HEIGHT / (height.max.y - height.min.y);
const facing = new Matrix4().makeRotationY(Math.PI / 2);
mesh.geometry.scale(scale, scale, scale);
mesh.geometry.applyMatrix4(facing);
group.traverse((node) => { if (node.isBone) node.position.multiplyScalar(scale); });
const hipsBone = group.children.find((node) => node.isBone);
hipsBone.position.applyMatrix4(facing);
hipsBone.quaternion.premultiply(new Quaternion().setFromRotationMatrix(facing));
group.scale.set(1, 1, 1); group.position.set(0, 0, 0); group.quaternion.identity();
group.updateMatrixWorld(true);
mesh.bind(new Skeleton(mesh.skeleton.bones.concat(extra)), mesh.matrixWorld);
mesh.skeleton.calculateInverses();
const glb = writeGlb(group, mesh, model);
await mkdir(root + OUTPUT, { recursive: true });
await writeFile(`${root}${OUTPUT}/yara-c-rig.glb`, glb);
const provenance = {
  schemaVersion: 1,
  operation: 'build-yara-mixamo-rig.mjs: Mixamo auto-rig of the Tripo v3.1 Ultra Yara (concept C) with the leaf skirt rebound to the hips, the knee web dropped, the T-pose baked as the rest pose and every joint bound',
  sources: Object.fromEntries(Object.entries(SOURCES).map(([key, path]) => [key, { path, sha256: sha256(key === 'fbx' ? fbxBytes : modelBytes) }])),
  tripo: { model: 'f1dd47dd-ee34-43b8-bc79-3562573e3be8 (multiview_to_model, v3.1-20260211, geometry_quality detailed, texture_quality extreme, pbr)', multiview: 'efaa5fde-b405-4c2f-b33c-90983b5dc3a3', apose: 'da7f4153-eeb3-4b5e-bdcc-1c0de018e3ab', concept: '954e5416-a654-42f9-9c7a-cd123941dbc1' },
  mixamo: 'Auto-rigger, Standard Skeleton (65), markers chin/wrists/elbows/knees/groin, uploaded as a 199,994-triangle OBJ (meshoptimizer simplify of the Tripo mesh), downloaded FBX Binary T-pose',
  skirt: { ...SKIRT, ...skirt }, bridges, joints: mesh.skeleton.bones.length, triangles: mesh.geometry.index.count / 3, vertices: mesh.geometry.attributes.position.count,
  height: HEIGHT, output: { file: `${OUTPUT}/yara-c-rig.glb`, sha256: sha256(glb), bytes: glb.length },
};
await writeFile(`${root}${OUTPUT}/provenance.json`, JSON.stringify(provenance, null, 2) + '\n');
console.log(JSON.stringify({ output: provenance.output, joints: provenance.joints, triangles: provenance.triangles, skirt, bridges }));
