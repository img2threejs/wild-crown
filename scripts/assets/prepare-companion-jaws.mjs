#!/usr/bin/env node
// User-approved lower-jaw rig repairs; source GLBs and all exterior surface data stay untouched.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { parseGlb, encodeGlb, readAccessor } from './author-quadruped-clips.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const clamp = v => Math.max(0, Math.min(1, v));
const repairs = {
  sable: { pivot: [-.002, .505, -.325], fraction: p => p.z <= -.33 && p.y >= .40 && p.y <= .525 && Math.abs(p.x) <= .065 ? clamp((-.33 - p.z) / .03) : 0 },
  solkar: { pivot: [.33, .40, .002], fraction: p => p.x >= .34 && p.y >= .19 && p.y <= .395 && Math.abs(p.z) <= .12 ? clamp((p.x - .34) / .03) : 0 },
};

for (const [id, repair] of Object.entries(repairs)) {
  const sourcePath = resolve(ROOT, `asset-source/generated/actor-${id}-runtime-01/actor-${id}-combat.glb`);
  const source = readFileSync(sourcePath), { json, bin } = parseGlb(source);
  const parent = new Map();
  json.nodes.forEach((node, i) => node.children?.forEach(child => parent.set(child, i)));
  const worlds = new Map();
  const world = index => {
    if (worlds.has(index)) return worlds.get(index);
    const n = json.nodes[index];
    const local = n.matrix ? new Matrix4().fromArray(n.matrix) : new Matrix4().compose(
      new Vector3(...(n.translation ?? [0, 0, 0])), new Quaternion(...(n.rotation ?? [0, 0, 0, 1])), new Vector3(...(n.scale ?? [1, 1, 1])));
    const result = parent.has(index) ? new Matrix4().multiplyMatrices(world(parent.get(index)), local) : local;
    worlds.set(index, result); return result;
  };
  const meshes = json.nodes.map((node, index) => ({ node, index })).filter(({ node }) => node.mesh !== undefined && node.skin !== undefined);
  if (meshes.length !== 1 || json.skins.length !== 1) throw new Error(`${id}: expected the measured single-skin character`);
  const { node: meshNode } = meshes[0], skin = json.skins[meshNode.skin];
  const parentIndex = json.nodes.findIndex(node => node.name === 'tripo::Head_2');
  if (parentIndex < 0 || json.nodes.some(node => node.name === 'repair::Jaw')) throw new Error(`${id}: unexpected jaw hierarchy`);
  const jawWorld = new Matrix4().makeTranslation(...repair.pivot);
  const jawNode = json.nodes.length, jawIndex = skin.joints.length;
  const jawLocal = new Matrix4().copy(world(parentIndex)).invert().multiply(jawWorld);
  const jawTranslation = new Vector3(), jawRotation = new Quaternion(), jawScale = new Vector3();
  jawLocal.decompose(jawTranslation, jawRotation, jawScale);
  json.nodes.push({ name: 'repair::Jaw', translation: jawTranslation.toArray(), rotation: jawRotation.toArray(), scale: jawScale.toArray() });
  (json.nodes[parentIndex].children ??= []).push(jawNode);
  const oldBind = readAccessor(json, bin, skin.inverseBindMatrices);
  const bindMatrices = skin.joints.map((joint, i) => new Matrix4().multiplyMatrices(world(joint), new Matrix4().fromArray(oldBind, i * 16)));
  // Use the source skin's actual bind space, not the mesh-node transform (the authored vertices are already world aligned).
  const restTransform = bindMatrices[0];
  if (bindMatrices.some(matrix => matrix.elements.some((value, i) => Math.abs(value - restTransform.elements[i]) > 1e-5))) throw new Error(`${id}: original joints do not share one bind space`);
  const newBind = new Matrix4().copy(jawWorld).invert().multiply(restTransform);
  const bindData = [...oldBind, ...newBind.elements];
  skin.joints.push(jawNode);

  const chunks = [bin]; let offset = bin.length;
  function append(values, width, type, componentType = 5126) {
    const bytes = Buffer.alloc(values.length * (componentType === 5123 ? 2 : 4));
    for (let i = 0; i < values.length; i++) {
      if (componentType === 5123) bytes.writeUInt16LE(values[i], i * 2); else bytes.writeFloatLE(values[i], i * 4);
    }
    const view = json.bufferViews.length;
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    chunks.push(bytes); offset += bytes.length;
    const accessor = json.accessors.length;
    json.accessors.push({ bufferView: view, componentType, count: values.length / width, type });
    return accessor;
  }
  skin.inverseBindMatrices = append(bindData, 16, 'MAT4');
  let affected = 0, full = 0, discardedWeight = 0, maxRestError = 0;
  const point = new Vector3(), localPoint = new Vector3(), oldPoint = new Vector3(), newPoint = new Vector3(), temp = new Vector3();
  for (const primitive of json.meshes[meshNode.mesh].primitives) {
    const attrs = primitive.attributes, positions = readAccessor(json, bin, attrs.POSITION), weights = readAccessor(json, bin, attrs.WEIGHTS_0);
    const ja = json.accessors[attrs.JOINTS_0], jv = json.bufferViews[ja.bufferView];
    if (ja.sparse || ja.type !== 'VEC4' || ![5121, 5123].includes(ja.componentType) || positions.length / 3 !== weights.length / 4) throw new Error(`${id}: unexpected measured skin format`);
    const size = ja.componentType === 5121 ? 1 : 2;
    const data = new DataView(bin.buffer, bin.byteOffset, bin.byteLength), joints = [];
    for (let i = 0; i < ja.count; i++) for (let k = 0; k < 4; k++) {
      const at = (jv.byteOffset ?? 0) + (ja.byteOffset ?? 0) + i * (jv.byteStride ?? size * 4) + k * size;
      joints.push(size === 1 ? data.getUint8(at) : data.getUint16(at, true));
    }
    const nextJoints = [...joints], nextWeights = [...weights];
    for (let i = 0; i < ja.count; i++) {
      localPoint.fromArray(positions, i * 3); point.copy(localPoint).applyMatrix4(restTransform);
      const fraction = repair.fraction(point);
      if (!fraction) continue;
      affected++; if (fraction >= 1) full++;
      const influences = [], base = i * 4;
      let sum = 0; oldPoint.set(0, 0, 0);
      for (let k = 0; k < 4; k++) {
        const weight = weights[base + k], joint = joints[base + k]; sum += weight;
        oldPoint.addScaledVector(temp.copy(localPoint).applyMatrix4(bindMatrices[joint]), weight);
        if (weight * (1 - fraction) > 0) influences.push({ joint, weight: weight * (1 - fraction) });
      }
      influences.push({ joint: jawIndex, weight: sum * fraction });
      influences.sort((a, b) => b.weight - a.weight);
      const kept = influences.slice(0, 4), keptSum = kept.reduce((s, influence) => s + influence.weight, 0);
      discardedWeight = Math.max(discardedWeight, sum - keptSum);
      newPoint.set(0, 0, 0);
      for (let k = 0; k < 4; k++) {
        const influence = kept[k], joint = influence?.joint ?? 0, weight = influence ? influence.weight / keptSum : 0;
        nextJoints[base + k] = joint; nextWeights[base + k] = weight;
        newPoint.addScaledVector(temp.copy(localPoint).applyMatrix4(joint === jawIndex ? restTransform : bindMatrices[joint]), Math.fround(weight));
      }
      maxRestError = Math.max(maxRestError, oldPoint.distanceTo(newPoint));
    }
    attrs.JOINTS_0 = append(nextJoints, 4, 'VEC4', 5123);
    attrs.WEIGHTS_0 = append(nextWeights, 4, 'VEC4');
  }
  if (!affected || maxRestError > 1e-5) throw new Error(`${id}: jaw repair changes the bind appearance (${maxRestError})`);
  json.buffers[0].byteLength = offset;
  const report = { source: relative(ROOT, sourcePath), sourceSha256: sha(source), joint: 'repair::Jaw', parent: 'tripo::Head_2', pivot: repair.pivot,
    affectedVertices: affected, fullyAssignedVertices: full, maximumDiscardedInfluence: discardedWeight, maximumBindPositionError: maxRestError,
    preserved: 'Positions, normals, UVs, indices, textures, materials, existing joints and clips. Only lower-muzzle skin weights and the added jaw joint/inverse bind matrix differ.' };
  json.extras = { ...json.extras, companionJawRepair: report };
  const output = sourcePath.replace('-combat.glb', '-companion-rig.glb');
  const result = encodeGlb(json, Buffer.concat(chunks));
  writeFileSync(output, result);
  writeFileSync(resolve(dirname(output), 'companion-jaw-report.json'), JSON.stringify({ ...report, output: relative(ROOT, output), sha256: sha(result) }, null, 2) + '\n');
  console.log(JSON.stringify({ id, ...report, output: relative(ROOT, output), sha256: sha(result) }));
}
