#!/usr/bin/env node
// Rebinds the tail of a Tripo rig v1.0 biped that has no tail joints. Tripo skins such a tail onto whatever bones are nearest; Koro, the Branchbreaker's
// curled tail came back bound to the LEFT calf and foot (396 vertices), so every stride and kick swung the tail about like a stick. The vertices in the
// tail box whose dominant joint is one of the leg joints are re-bound to the Hip alone, so the tail rides the pelvis in every clip.
//
// Works on the runtime base GLB written by scripts/assets/build-greenwake-runtime-asset.mjs, in place, deterministically; `tail-repair.json` beside the
// GLB records the hashes and the vertices touched. A second run finds nothing to rebind and writes the same GLB.
// Usage: node scripts/assets/repair-biped-tail-weights.mjs <asset-id>
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rig, encodeGlb, parseGlb, readAccessorAny, round } from './creature-rig-kit.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** box = [xMin, xMax, yMin, yMax, zMin, zMax] in model units; from = joints that may not carry tail skin; to = the joint that takes it. */
export const TAIL_REPAIRS = {
  'actor-koro-branchbreaker': {
    box: [-0.25, -0.1, 0.04, 0.4, -0.35, 0.2],
    from: ['Waist', 'L_Forearm', 'L_ForearmTwist01', 'L_ForearmTwist02', 'L_Hand', 'L_Thigh', 'L_ThighTwist01', 'L_ThighTwist02', 'L_Calf', 'L_CalfTwist01', 'L_CalfTwist02', 'L_Foot', 'L_ToeBase', 'R_Thigh', 'R_ThighTwist01', 'R_ThighTwist02', 'R_Calf', 'R_CalfTwist01', 'R_CalfTwist02', 'R_Foot', 'R_ToeBase'],
    to: 'Hip',
  },
};

export function repair(assetId, { write = true } = {}) {
  const config = TAIL_REPAIRS[assetId];
  if (!config) throw new Error(`No tail repair for ${assetId}; known: ${Object.keys(TAIL_REPAIRS).join(', ')}`);
  const path = resolve(ROOT, 'asset-source/generated', `${assetId}-runtime-01`, `${assetId}.glb`);
  const inputBytes = readFileSync(path);
  const { json, bin } = parseGlb(inputBytes);
  const rig = new Rig(json);
  const skin = json.skins[0], jointIndex = name => skin.joints.indexOf(rig.index(name));
  const from = new Set(config.from.map(jointIndex)), to = jointIndex(config.to);
  const primitive = json.meshes[0].primitives[0];
  const positions = readAccessorAny(json, bin, primitive.attributes.POSITION);
  const jointAccessor = json.accessors[primitive.attributes.JOINTS_0], weightAccessor = json.accessors[primitive.attributes.WEIGHTS_0];
  if (jointAccessor.componentType !== 5121 || weightAccessor.componentType !== 5126) throw new Error('Expected unsigned byte joints and float weights');
  const jointView = json.bufferViews[jointAccessor.bufferView], weightView = json.bufferViews[weightAccessor.bufferView];
  const jointOffset = i => (jointView.byteOffset ?? 0) + (jointAccessor.byteOffset ?? 0) + i * (jointView.byteStride ?? 4);
  const weightOffset = i => (weightView.byteOffset ?? 0) + (weightAccessor.byteOffset ?? 0) + i * (weightView.byteStride ?? 16);
  const [x0, x1, y0, y1, z0, z1] = config.box;
  const output = Buffer.from(bin);
  const dominant = new Map();
  let touched = 0;
  for (let i = 0; i < positions.length / 3; i++) {
    const [x, y, z] = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    if (x < x0 || x > x1 || y < y0 || y > y1 || z < z0 || z > z1) continue;
    let best = 0;
    for (let k = 1; k < 4; k++) if (output.readFloatLE(weightOffset(i) + k * 4) > output.readFloatLE(weightOffset(i) + best * 4)) best = k;
    const joint = output.readUInt8(jointOffset(i) + best);
    if (!from.has(joint)) continue;
    for (let k = 0; k < 4; k++) { output.writeUInt8(k === 0 ? to : 0, jointOffset(i) + k); output.writeFloatLE(k === 0 ? 1 : 0, weightOffset(i) + k * 4); }
    dominant.set(rig.nodes[skin.joints[joint]].name, (dominant.get(rig.nodes[skin.joints[joint]].name) ?? 0) + 1);
    touched++;
  }
  const outputBytes = encodeGlb(json, output);
  const record = {
    schemaVersion: 1, assetId, generator: 'scripts/assets/repair-biped-tail-weights.mjs',
    reason: 'Tripo rig v1.0 biped without tail joints: the tail vertices were bound to the left calf / foot, so the tail swung with every stride.',
    input: { sha256: sha256(inputBytes), bytes: inputBytes.length }, output: { sha256: sha256(outputBytes), bytes: outputBytes.length },
    box: config.box.map(v => round(v)), reboundTo: config.to, verticesRebound: touched, previousDominantJoint: Object.fromEntries([...dominant.entries()].sort()),
  };
  if (write) {
    writeFileSync(path, outputBytes);
    writeFileSync(resolve(path, '..', 'tail-repair.json'), JSON.stringify(record, null, 2) + '\n');
  }
  return record;
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  const assetId = process.argv[2];
  if (!assetId) { console.error('Usage: repair-biped-tail-weights.mjs <asset-id>'); process.exit(2); }
  console.log(JSON.stringify(repair(assetId), null, 2));
}
