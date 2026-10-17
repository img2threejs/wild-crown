#!/usr/bin/env node
// Completes the hind-leg chains of Tripo quadruped rigs whose far-side leg came back without its own bones (Blood Bamboo Valley: Asha's
// right hind leg was skinned onto the LEFT hind joints, Tali's left hind leg onto one lone hip joint, so no IK gait could plant it).
//
// The repair works on the runtime base GLB written by scripts/assets/build-greenwake-runtime-asset.mjs and is deterministic:
//   1. new joint nodes are appended to the skeleton (mirrored from the intact leg across the body's sagittal plane, or a paw joint below
//      the hock), each with an identity world rotation and an inverse bind matrix of its own;
//   2. every vertex that belongs to the leg (old weight on `oldJoints` of at least `minShare`, on the leg's side of the plane) gets the old
//      leg weight re-distributed over the leg's chain by its position along the chain polyline (nearest point, linear hat weights); all
//      other influences (Root, spine, ...) are kept, the four strongest influences are normalised;
//   3. `skin-repair.json` beside the GLB records the hashes, the joints, the vertices touched and the weight ranges.
// Run it exactly once per freshly built base GLB (a second run finds the repair joints and stops).
//
// Usage: node scripts/assets/repair-quadruped-hind-legs.mjs <asset-id>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Quaternion, Vector3 } from 'three';
import { Rig, encodeGlb, parseGlb, readAccessorAny, round } from './creature-rig-kit.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/**
 * Per asset: `plane` = [axis index, coordinate] of the sagittal plane; chains name the leg, its parent joint, the existing joints, the joints to
 * create (`mirror`: take the position of the named joint reflected across the plane; `at`: an absolute rest position) and the side
 * (`sign` of the vertex coordinate on the plane's axis relative to the plane). A chain with `mirrorFrom` (the intact leg's joints, index for
 * index) copies the weights of each vertex's mirror image (nearest vertex within `maxMirrorDistance` of the reflected position, whose weight on
 * those joints is at least `minTwinShare`, default 0.1) so the thigh and belly blend as on the intact side; a vertex without a mirror image
 * falls back to the chain-position weights of its old `oldJoints` share (at least `minShare`).
 */
export const REPAIRS = {
  // Left hind leg (z < 0): hip / knee / hock exist, a paw joint is added below the hock. Right hind leg (z > 0): the chain is mirrored from the left one.
  'actor-asha': {
    plane: [2, -0.002],
    chains: [
      { key: 'HL', sign: -1, parent: 'tripo::Root', existing: ['tripo::0_Left_Limb_0', 'tripo::0_Left_Limb_1', 'tripo::0_Left_Limb_2'], create: [{ name: 'repair::HL_Paw', at: [-0.212, 0.048, -0.075] }], oldJoints: ['tripo::0_Left_Limb_0', 'tripo::0_Left_Limb_1', 'tripo::0_Left_Limb_2'], minShare: 0.25 },
      { key: 'HR', sign: 1, parent: 'tripo::Root', existing: [], create: [
        { name: 'repair::HR_0', mirror: 'tripo::0_Left_Limb_0' }, { name: 'repair::HR_1', mirror: 'tripo::0_Left_Limb_1' }, { name: 'repair::HR_2', mirror: 'tripo::0_Left_Limb_2' }, { name: 'repair::HR_Paw', at: [-0.212, 0.048, 0.071] },
      ], oldJoints: ['tripo::0_Left_Limb_0', 'tripo::0_Left_Limb_1', 'tripo::0_Left_Limb_2'], minShare: 0.25, mirrorFrom: ['tripo::0_Left_Limb_0', 'tripo::0_Left_Limb_1', 'tripo::0_Left_Limb_2', 'repair::HL_Paw'], maxMirrorDistance: 0.03 },
    ],
  },
  // Right hind leg (x > 0) is complete (5 joints); the left one is a lone hip joint: its knee / hock / paw / toe are mirrored from the right chain.
  'actor-tali': {
    plane: [0, -0.002],
    chains: [
      { key: 'HL', sign: -1, parent: 'tripo::1_Left_Limb_0', existing: ['tripo::1_Left_Limb_0'], create: [
        { name: 'repair::HL_1', mirror: 'tripo::0_Right_Limb_1' }, { name: 'repair::HL_2', mirror: 'tripo::0_Right_Limb_2' }, { name: 'repair::HL_3', mirror: 'tripo::0_Right_Limb_3' }, { name: 'repair::HL_4', mirror: 'tripo::0_Right_Limb_4' },
      ], oldJoints: ['tripo::1_Left_Limb_0'], minShare: 0.3, mirrorFrom: ['tripo::0_Right_Limb_0', 'tripo::0_Right_Limb_1', 'tripo::0_Right_Limb_2', 'tripo::0_Right_Limb_3', 'tripo::0_Right_Limb_4'], maxMirrorDistance: 0.03 },
    ],
  },
};

export function repair(assetId, { write = true } = {}) {
  const config = REPAIRS[assetId];
  if (!config) throw new Error(`No hind-leg repair for ${assetId}; known: ${Object.keys(REPAIRS).join(', ')}`);
  const path = resolve(ROOT, 'asset-source/generated', `${assetId}-runtime-01`, `${assetId}.glb`);
  const inputBytes = readFileSync(path);
  const { json, bin } = parseGlb(inputBytes);
  if (json.nodes.some(node => node.name?.startsWith('repair::'))) throw new Error(`${assetId}: the base GLB already carries repair joints; rebuild it first`);
  const rig = new Rig(json);
  const [axis, planeAt] = config.plane;
  const worldQ = joint => rig.restWQ[joint], position = joint => rig.restP[joint].clone();
  const skin = json.skins[0];
  const created = new Map(); // name -> { node, position }
  const jointsOf = chain => [...chain.existing.map(name => rig.index(name)), ...chain.create.map(spec => created.get(spec.name).node)];

  // 1. Joint nodes.
  for (const chain of config.chains) {
    let parent = rig.index(chain.parent), parentP = position(parent), parentQ = worldQ(parent);
    if (chain.existing.length) { const last = rig.index(chain.existing.at(-1)); parent = last; parentP = position(last); parentQ = worldQ(last); }
    for (const spec of chain.create) {
      const p = spec.mirror ? position(rig.index(spec.mirror)) : new Vector3(...spec.at);
      if (spec.mirror) { const flat = p.toArray(); flat[axis] = 2 * planeAt - flat[axis]; p.fromArray(flat); }
      const inverse = parentQ.clone().invert();
      const node = json.nodes.length;
      json.nodes.push({ name: spec.name, rotation: inverse.toArray(), translation: p.clone().sub(parentP).applyQuaternion(inverse).toArray().map(v => round(v, 7)) });
      (json.nodes[parent].children ??= []).push(node);
      skin.joints.push(node);
      created.set(spec.name, { node, position: p });
      parent = node; parentP = p; parentQ = new Quaternion();
    }
  }

  // 2. Inverse bind matrices: the old ones followed by one translation per new joint (world rotation identity).
  const ibmAccessor = json.accessors[skin.inverseBindMatrices];
  const ibmView = json.bufferViews[ibmAccessor.bufferView];
  const oldIbm = bin.subarray((ibmView.byteOffset ?? 0) + (ibmAccessor.byteOffset ?? 0), (ibmView.byteOffset ?? 0) + (ibmAccessor.byteOffset ?? 0) + ibmAccessor.count * 64);
  const addedIbm = Buffer.alloc(created.size * 64);
  [...created.values()].forEach(({ position: p }, k) => {
    const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -p.x, -p.y, -p.z, 1];
    m.forEach((value, i) => addedIbm.writeFloatLE(value, k * 64 + i * 4));
  });
  const padTo4 = buffer => Buffer.concat([buffer, Buffer.alloc((4 - buffer.length % 4) % 4)]);
  const base = padTo4(bin);
  const newBin = Buffer.concat([base, oldIbm, addedIbm]);
  json.bufferViews.push({ buffer: 0, byteOffset: base.length, byteLength: oldIbm.length + addedIbm.length });
  json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5126, count: ibmAccessor.count + created.size, type: 'MAT4' });
  skin.inverseBindMatrices = json.accessors.length - 1;
  json.buffers = [{ byteLength: newBin.length }];

  // 3. Skin weights.
  const primitive = json.meshes[0].primitives[0];
  const positions = readAccessorAny(json, newBin, primitive.attributes.POSITION);
  const jointAccessor = json.accessors[primitive.attributes.JOINTS_0], weightAccessor = json.accessors[primitive.attributes.WEIGHTS_0];
  if (jointAccessor.componentType !== 5121 || weightAccessor.componentType !== 5126) throw new Error('Expected unsigned byte joints and float weights');
  const jointView = json.bufferViews[jointAccessor.bufferView], weightView = json.bufferViews[weightAccessor.bufferView];
  const jointOffset = i => (jointView.byteOffset ?? 0) + (jointAccessor.byteOffset ?? 0) + i * (jointView.byteStride ?? 4);
  const weightOffset = i => (weightView.byteOffset ?? 0) + (weightAccessor.byteOffset ?? 0) + i * (weightView.byteStride ?? 16);
  const jointIndexOf = node => skin.joints.indexOf(node);
  const report = { chains: {} };
  const claimed = new Set();
  const readInfluences = i => Array.from({ length: 4 }, (_, k) => [newBin.readUInt8(jointOffset(i) + k), newBin.readFloatLE(weightOffset(i) + k * 4)]);
  const writeInfluences = (i, next) => {
    const strongest = [...next.entries()].filter(([, weight]) => weight > 0).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 4);
    const total = strongest.reduce((sum, [, weight]) => sum + weight, 0);
    for (let k = 0; k < 4; k++) {
      const [joint, weight] = strongest[k] ?? [0, 0];
      newBin.writeUInt8(joint, jointOffset(i) + k);
      newBin.writeFloatLE(weight / total, weightOffset(i) + k * 4);
    }
  };
  const CELL = 0.02;
  const cellKey = (x, y, z) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`;
  for (const chain of config.chains) {
    const chainNodes = jointsOf(chain), chainPoints = chainNodes.map(node => (created.get(json.nodes[node].name)?.position) ?? position(node));
    const old = new Set(chain.oldJoints.map(name => jointIndexOf(rig.index(name))));
    const chainIndices = chainNodes.map(jointIndexOf);
    const nodeOf = name => created.get(name)?.node ?? rig.index(name);
    const source = chain.mirrorFrom?.map(name => jointIndexOf(nodeOf(name)));
    // Mirror transfer: the intact leg's vertices (before this chain is touched) indexed on a grid; a vertex of this side copies the weights of its mirror image.
    const grid = new Map();
    if (source) for (let i = 0; i < positions.length / 3; i++) {
      if (Math.sign(positions[i * 3 + axis] - planeAt) !== -chain.sign) continue;
      const key = cellKey(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(i);
    }
    const nearestMirror = (x, y, z) => {
      const reflected = [x, y, z]; reflected[axis] = 2 * planeAt - reflected[axis];
      const [cx, cy, cz] = reflected.map(v => Math.floor(v / CELL));
      let best = -1, bestDistance = chain.maxMirrorDistance;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        for (const candidate of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
          const d = Math.hypot(positions[candidate * 3] - reflected[0], positions[candidate * 3 + 1] - reflected[1], positions[candidate * 3 + 2] - reflected[2]);
          if (d < bestDistance) { bestDistance = d; best = candidate; }
        }
      }
      return best;
    };
    let rebound = 0, mirrored = 0, fallback = 0, maxShare = 0;
    const vertex = new Vector3(), hits = new Array(chainNodes.length).fill(0);
    const polyline = (i, influences, share) => {
      vertex.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
      // Nearest point on the chain polyline: s = segment index + fraction.
      let best = Infinity, s = 0;
      for (let seg = 0; seg < chainPoints.length - 1; seg++) {
        const a = chainPoints[seg], b = chainPoints[seg + 1], ab = b.clone().sub(a), t = Math.min(1, Math.max(0, vertex.clone().sub(a).dot(ab) / ab.lengthSq()));
        const distance = a.clone().addScaledVector(ab, t).distanceTo(vertex);
        if (distance < best) { best = distance; s = seg + t; }
      }
      const chainWeights = chainIndices.map((_, k) => Math.max(0, 1 - Math.abs(s - k)));
      const next = new Map();
      for (const [joint, weight] of influences) if (weight > 0 && !old.has(joint)) next.set(joint, (next.get(joint) ?? 0) + weight);
      chainIndices.forEach((joint, k) => { if (chainWeights[k] > 0) next.set(joint, (next.get(joint) ?? 0) + share * chainWeights[k]); });
      writeInfluences(i, next);
      chainWeights.forEach((w, k) => { if (w > 0.5) hits[k]++; });
    };
    for (let i = 0; i < positions.length / 3; i++) {
      if (claimed.has(i)) continue;
      if (Math.sign(positions[i * 3 + axis] - planeAt) !== chain.sign) continue;
      const influences = readInfluences(i);
      const share = influences.reduce((sum, [joint, weight]) => sum + (old.has(joint) ? weight : 0), 0);
      const twin = source ? nearestMirror(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]) : -1;
      const twinInfluences = twin >= 0 ? readInfluences(twin) : undefined;
      const twinShare = twinInfluences?.reduce((sum, [joint, weight]) => sum + (source.includes(joint) ? weight : 0), 0) ?? 0;
      if (share < chain.minShare && twinShare < (chain.minTwinShare ?? 0.1)) continue;
      if (twinInfluences && twinShare >= (chain.minTwinShare ?? 0.1)) {
        const next = new Map();
        for (const [joint, weight] of twinInfluences) {
          const k = source.indexOf(joint), target = k >= 0 ? chainIndices[k] : joint;
          next.set(target, (next.get(target) ?? 0) + weight);
        }
        writeInfluences(i, next);
        mirrored++;
      } else { polyline(i, influences, share); fallback++; }
      claimed.add(i);
      rebound++; maxShare = Math.max(maxShare, share);
    }
    report.chains[chain.key] = { joints: chainNodes.map(node => json.nodes[node].name), createdJoints: chain.create.map(spec => spec.name), verticesRebound: rebound, verticesMirrored: mirrored, verticesByChainPosition: fallback, verticesNearestJoint: hits, largestOldShare: round(maxShare, 4) };
  }

  const outputBytes = encodeGlb(json, newBin);
  const record = {
    schemaVersion: 1, assetId, generator: 'scripts/assets/repair-quadruped-hind-legs.mjs',
    reason: 'Tripo rig v2.5 quadruped: the far-side hind leg has no (or only a lone) joint; the chain is completed so an IK gait can plant every foot.',
    input: { sha256: sha256(inputBytes), bytes: inputBytes.length }, output: { sha256: sha256(outputBytes), bytes: outputBytes.length },
    plane: { axis: 'xyz'[axis], at: planeAt }, ...report,
  };
  if (write) {
    writeFileSync(path, outputBytes);
    writeFileSync(resolve(path, '..', 'skin-repair.json'), JSON.stringify(record, null, 2) + '\n');
  }
  return record;
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  const assetId = process.argv[2];
  if (!assetId) { console.error('Usage: repair-quadruped-hind-legs.mjs <asset-id>'); process.exit(2); }
  console.log(JSON.stringify(repair(assetId), null, 2));
}
