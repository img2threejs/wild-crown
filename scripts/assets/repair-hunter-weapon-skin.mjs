#!/usr/bin/env node
// Rebinds the carried weapon of an Ash Hunter that Tripo skinned onto the wrong bones, so the whole weapon rides its holding hand rigidly in every clip.
// - The melee hunter's trapping pole is a thin rod that the decimation reduced to two vertex rings (the grip at the hand and the butt end near the left foot);
//   Tripo's rig bound the butt ring to the LEFT TOE (84 vertices), so the pole stretched with every stride of the left foot. The vertices inside the pole's
//   lower tube whose dominant joint is not the holding hand are re-bound to the hand alone.
// - The ranged hunter's crossbow net launcher is held up in front of the right shoulder in the bind pose, its bow and net drum level with the head. Every one of
//   its vertices is dominated by the RIGHT hand, but Tripo blended islands of foreign influence into it: a RightShoulder (clavicle) share of up to 25% over the
//   bow, the drum and the front of the stock (3,419 vertices in five islands, none of them touching the clavicle's own skin) and a RightForeArm share of up
//   to 8% at the root of the rods leaving the fist (45 vertices, detached from the forearm's wrist blend). The bow swung with the clavicle against the rest of
//   the crossbow (two of its vertices 0.22 apart changed distance by 30% in the get-up). Each detached island's weight is removed, so the crossbow rides the
//   hand alone; the wrist's hand / forearm blend, which is connected to the forearm's own skin, is left as Tripo made it.
//
// Works on the runtime base GLB written by scripts/assets/build-greenwake-runtime-asset.mjs, in place, deterministically; `weapon-repair.json` beside the
// GLB records the hashes and the vertices touched. A second run finds nothing to rebind and writes the same GLB.
// Usage: node scripts/assets/repair-hunter-weapon-skin.mjs <asset-id>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rig, encodeGlb, parseGlb, readAccessorAny, round } from './creature-rig-kit.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/**
 * to = the holding hand, the joint that takes the vertices; reason = recorded in weapon-repair.json. One selection per weapon:
 * tube = a segment [from, to] (model units) and a radius; yMax limits it to the part of the rod below the grip (the blade and hook above it are already bound
 * to the hand). The vertices in the tube whose dominant joint is not `to` are re-bound to `to` alone.
 * detached = true: influence islands. For every other joint, the welded patches of the vertices carrying any of its weight; a patch in which every vertex is
 * dominated by `to` (the joint dominates none of it) is influence detached from that joint's own body part, and its weight is removed from those vertices
 * (the remaining weights are renormalised). Influence that reaches the hand from the forearm's own skin (the wrist blend) is connected to vertices the forearm
 * dominates and stays as it is.
 */
export const WEAPON_REPAIRS = {
  'actor-camp-hunter-melee': {
    reason: 'The decimated trapping pole is two vertex rings; Tripo bound the butt ring to the left toe, so the pole stretched with the left foot.',
    tube: { from: [0.048, 0, -0.15], to: [0.094, 0.98, -0.228], radius: 0.028, yMax: 0.5 },
    to: 'mixamorig:LeftHand',
  },
  'actor-camp-hunter-ranged': {
    reason: 'Tripo blended clavicle and forearm influence islands into the hand-bound crossbow, so its bow swung with the clavicle and the crossbow bent.',
    detached: true,
    to: 'mixamorig:RightHand',
  },
};

const distanceToSegment = (p, a, b) => {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const t = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / (ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2])));
  return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
};

/**
 * Influence islands detached from their joint (see WEAPON_REPAIRS.detached): Map joint -> { islands, vertices: [vertex], largestWeight }. Vertices are welded by
 * exact position (the mesh is split at UV seams) and joined by the triangles whose corners all carry the joint's weight.
 */
function detachedInfluence(count, positions, indices, slots, dominant, hand) {
  const welded = new Int32Array(count), first = new Map();
  for (let i = 0; i < count; i++) {
    const key = `${positions[i * 3]},${positions[i * 3 + 1]},${positions[i * 3 + 2]}`;
    if (!first.has(key)) first.set(key, i);
    welded[i] = first.get(key);
  }
  const joints = new Set();
  for (let i = 0; i < count; i++) for (const slot of slots(i)) if (slot.weight > 0) joints.add(slot.joint);
  const found = new Map();
  for (const joint of [...joints].sort((a, b) => a - b)) {
    if (joint === hand) continue;
    const weight = new Float64Array(count);
    for (let i = 0; i < count; i++) for (const slot of slots(i)) if (slot.joint === joint) weight[i] += slot.weight;
    const parent = Int32Array.from({ length: count }, (_, i) => i);
    const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const join = (a, b) => { if (weight[a] > 0 && weight[b] > 0) { a = find(a); b = find(b); if (a !== b) parent[b] = a; } };
    for (let i = 0; i < count; i++) join(welded[i], i);
    for (let t = 0; t < indices.length; t += 3) { join(indices[t], indices[t + 1]); join(indices[t + 1], indices[t + 2]); join(indices[t], indices[t + 2]); }
    const islands = new Map();
    for (let i = 0; i < count; i++) if (weight[i] > 0) { const r = find(i); if (!islands.has(r)) islands.set(r, []); islands.get(r).push(i); }
    const detached = [...islands.values()].filter(island => island.every(i => dominant(i) === hand));
    if (!detached.length) continue;
    const vertices = detached.flat().sort((a, b) => a - b);
    found.set(joint, { islands: detached.length, vertices, largestWeight: Math.max(...vertices.map(i => weight[i])) });
  }
  return found;
}

export function repair(assetId, { write = true } = {}) {
  const config = WEAPON_REPAIRS[assetId];
  if (!config) throw new Error(`No weapon repair for ${assetId}; known: ${Object.keys(WEAPON_REPAIRS).join(', ')}`);
  const path = resolve(ROOT, 'asset-source/generated', `${assetId}-runtime-01`, `${assetId}.glb`);
  const inputBytes = readFileSync(path);
  const { json, bin } = parseGlb(inputBytes);
  const rig = new Rig(json);
  const skin = json.skins[0], jointIndex = name => skin.joints.indexOf(rig.index(name)), jointName = joint => rig.nodes[skin.joints[joint]].name;
  const to = jointIndex(config.to);
  const primitive = json.meshes[0].primitives[0];
  const positions = readAccessorAny(json, bin, primitive.attributes.POSITION), count = positions.length / 3;
  const jointAccessor = json.accessors[primitive.attributes.JOINTS_0], weightAccessor = json.accessors[primitive.attributes.WEIGHTS_0];
  if (jointAccessor.componentType !== 5121 || weightAccessor.componentType !== 5126) throw new Error('Expected unsigned byte joints and float weights');
  const jointView = json.bufferViews[jointAccessor.bufferView], weightView = json.bufferViews[weightAccessor.bufferView];
  const jointOffset = i => (jointView.byteOffset ?? 0) + (jointAccessor.byteOffset ?? 0) + i * (jointView.byteStride ?? 4);
  const weightOffset = i => (weightView.byteOffset ?? 0) + (weightAccessor.byteOffset ?? 0) + i * (weightView.byteStride ?? 16);
  const output = Buffer.from(bin);
  const slots = i => [0, 1, 2, 3].map(k => ({ joint: output.readUInt8(jointOffset(i) + k), weight: output.readFloatLE(weightOffset(i) + k * 4) }));
  const dominant = i => { const s = slots(i); let best = 0; for (let k = 1; k < 4; k++) if (s[k].weight > s[best].weight) best = k; return s[best].joint; };
  const writeSlots = (i, list) => list.forEach(({ joint, weight }, k) => { output.writeUInt8(joint, jointOffset(i) + k); output.writeFloatLE(weight, weightOffset(i) + k * 4); });
  const handAlone = [{ joint: to, weight: 1 }, { joint: 0, weight: 0 }, { joint: 0, weight: 0 }, { joint: 0, weight: 0 }];
  let touched = 0, selection;
  if (config.tube) {
    const previous = new Map();
    for (let i = 0; i < count; i++) {
      const p = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
      if (p[1] > config.tube.yMax || distanceToSegment(p, config.tube.from, config.tube.to) > config.tube.radius) continue;
      const joint = dominant(i);
      if (joint === to) continue;
      writeSlots(i, handAlone);
      previous.set(jointName(joint), (previous.get(jointName(joint)) ?? 0) + 1);
      touched++;
    }
    selection = {
      tube: { from: config.tube.from.map(v => round(v)), to: config.tube.to.map(v => round(v)), radius: config.tube.radius, yMax: config.tube.yMax },
      reboundTo: config.to, verticesRebound: touched, previousDominantJoint: Object.fromEntries([...previous.entries()].sort()),
    };
  } else {
    const detached = detachedInfluence(count, positions, readAccessorAny(json, bin, primitive.indices), slots, dominant, to);
    const strip = new Map();
    for (const [joint, { vertices }] of detached) for (const i of vertices) strip.set(i, [...(strip.get(i) ?? []), joint]);
    for (const [i, joints] of [...strip.entries()].sort((a, b) => a[0] - b[0])) {
      const kept = slots(i).map(slot => (joints.includes(slot.joint) ? { joint: 0, weight: 0 } : slot));
      const total = kept.reduce((sum, slot) => sum + slot.weight, 0);
      writeSlots(i, kept.map(slot => ({ joint: slot.joint, weight: slot.weight / total })));
      touched++;
    }
    selection = {
      detachedInfluence: Object.fromEntries([...detached.entries()].map(([joint, found]) => [jointName(joint), { islands: found.islands, vertices: found.vertices.length, largestWeight: round(found.largestWeight) }]).sort()),
      reboundTo: config.to, verticesRebound: touched,
    };
  }
  const outputBytes = encodeGlb(json, output);
  const record = {
    schemaVersion: 1, assetId, generator: 'scripts/assets/repair-hunter-weapon-skin.mjs', reason: config.reason,
    input: { sha256: sha256(inputBytes), bytes: inputBytes.length }, output: { sha256: sha256(outputBytes), bytes: outputBytes.length },
    ...selection,
  };
  if (write) {
    writeFileSync(path, outputBytes);
    writeFileSync(resolve(path, '..', 'weapon-repair.json'), JSON.stringify(record, null, 2) + '\n');
  }
  return record;
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  const assetId = process.argv[2];
  if (!assetId) { console.error('Usage: repair-hunter-weapon-skin.mjs <asset-id>'); process.exit(2); }
  console.log(JSON.stringify(repair(assetId), null, 2));
}
