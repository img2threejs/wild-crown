import { createHash } from 'node:crypto';
import { Matrix4, Vector3 } from 'three';
import { readAccessorAny } from './creature-rig-kit.mjs';

/**
 * Vesper coat-flap skin-weight repair (offline, deterministic, Vesper-specific).
 *
 * Cause (measured on the native rig): Tripo's auto-skin gives the lower side/back coat flaps 0.22–0.46 of the upper-arm
 * bone from the shoulder down to below the hip, and thigh weight up to 19 cm above the hip joint, with a hard
 * 4-influence slot flip at belt height. A high-knee stride with the arm swept back stretches 5 mm flap edges to 7 cm.
 * Evidence and acceptance measurements are recorded by Main in the asset-pipeline docs.
 *
 * Repair, applied to a copy of the GLB (only the JOINTS_0 / WEIGHTS_0 bytes change; positions, topology, textures,
 * skeleton and inverse-bind matrices are bit-identical):
 *   1. Arm rule: on vertices carrying upper-arm weight but no forearm/hand weight, that lie farther than `armClear`
 *      from the arm bone chain, below the shoulder, and that already belong to the lower torso (`torsoGate`: Hips+Spine+Spine1
 *      weight; measured sleeve and pauldron vertices carry < 0.05 of it, flap vertices ≥ 0.2), the upper-arm weight is faded
 *      out (smoothstep in height between `armFade.top` and `armFade.bottom`, in distance between `armClear.keep` and
 *      `armClear.remove`, and in lower-torso weight between `torsoGate.from` and `torsoGate.to`) and handed to the vertex's
 *      torso influences in proportion (Hips/Spine/Spine1/Spine2; the nearest spine bone when it has none).
 *      Vertices with forearm/hand weight, within the sleeve radius (0.086 m measured) or without lower-torso weight are never touched.
 *   2. Thigh rule: thigh weight more than `thighFade.bottom` above the hip joint and farther than `thighClear` from the
 *      leg bone chain is faded out by height up to `thighFade.top` and handed to Hips, so the pelvis ↔ thigh hand-over on
 *      the flap is continuous instead of a slot flip. The groin and the thigh itself (≤ 6 cm above the joint, or within 12 cm of the femur) keep their weights.
 *   3. Mask-restricted smoothing: `smoothing.iterations` Laplacian passes (weight `smoothing.lambda`) over the edited
 *      vertices only, reading their 1-ring (unedited neighbours are read, never written), then top-4 truncation and
 *      renormalisation (non-negative, sum 1). Nothing outside the mask is modified.
 * All distances are metres on the 1.7 m rig (rig unit × 1.7). Everything is pure arithmetic in vertex order, so reruns are byte-identical.
 */
export const VESPER_FLAP_REPAIR = Object.freeze({
  rigScale: 1.7,
  armFade: { top: 1.20, bottom: 1.02 },        // height (m): upper-arm weight fully kept at/above top, fully removed at/below bottom
  armClear: { keep: 0.10, remove: 0.16 },      // distance to the arm chain (m): kept within `keep`, removed beyond `remove` (sleeve max 0.086)
  torsoGate: { from: 0.05, to: 0.20 },         // Hips+Spine+Spine1 weight: no arm removal below `from`, full removal above `to`
  thighFade: { bottom: 0.92, top: 1.06 },      // height (m): thigh weight kept at/below bottom, removed at/above top
  thighClear: 0.12,                            // distance to the leg chain (m) below which thigh weight is never touched
  smoothing: { iterations: 3, lambda: 0.5 },
});
/** glTF VEC4 skin: exactly four influences per vertex are written, so the normalised sum always lands in the stored slots. */
const MAX_INFLUENCES = 4;

const smoothstep = (edge0, edge1, x) => { const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0))); return t * t * (3 - 2 * t); };
const segmentDistance = (p, a, b, scratch) => { const ab = scratch.copy(b).sub(a), t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / ab.lengthSq())); return p.distanceTo(ab.multiplyScalar(t).add(a)); };

function accessorLayout(json, id) {
  const accessor = json.accessors[id], view = json.bufferViews[accessor.bufferView];
  const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[accessor.type], bytes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[accessor.componentType];
  return { accessor, comps, bytes, stride: view.byteStride ?? comps * bytes, base: (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) };
}

/** @param glb {{ json, bin }} parsed GLB (scripts/assets/import-aren-animation-set.mjs parseGlb). Returns `{ glb: { json, bin }, report }` without touching the input. */
export function repairVesperFlapWeights(glb, params = VESPER_FLAP_REPAIR) {
  const { json: sourceJson, bin: sourceBin } = glb, S = params.rigScale;
  const primitive = sourceJson.meshes[0].primitives[0], skin = sourceJson.skins[0];
  const positions = readAccessorAny(sourceJson, sourceBin, primitive.attributes.POSITION), jointIds = readAccessorAny(sourceJson, sourceBin, primitive.attributes.JOINTS_0);
  const weights = readAccessorAny(sourceJson, sourceBin, primitive.attributes.WEIGHTS_0), inverseBind = readAccessorAny(sourceJson, sourceBin, skin.inverseBindMatrices), indices = readAccessorAny(sourceJson, sourceBin, primitive.indices);
  const vertexCount = positions.length / 3, jointCount = skin.joints.length;
  const names = skin.joints.map((node) => sourceJson.nodes[node].name.replace('mixamorig:', ''));
  const slot = (name) => { const index = names.indexOf(name); if (index < 0) throw new Error(`vesper-skin-weights: missing joint ${name}`); return index; };
  const jointPosition = (name) => new Vector3().setFromMatrixPosition(new Matrix4().fromArray(inverseBind, slot(name) * 16).invert()).multiplyScalar(S);
  const torso = ['Hips', 'Spine', 'Spine1', 'Spine2'].map(slot), spineByHeight = (y) => slot(y < jointPosition('Spine').y + 0.055 ? 'Spine' : y < jointPosition('Spine1').y + 0.055 ? 'Spine1' : 'Spine2');

  // Dense per-vertex weight rows (jointCount wide) for the mask only; everything else stays packed.
  const sides = ['Right', 'Left'].map((side) => ({
    side, arm: slot(`${side}Arm`), fore: slot(`${side}ForeArm`), hand: slot(`${side}Hand`), upLeg: slot(`${side}UpLeg`),
    A: jointPosition(`${side}Arm`), F: jointPosition(`${side}ForeArm`), H: jointPosition(`${side}Hand`), U: jointPosition(`${side}UpLeg`), L: jointPosition(`${side}Leg`), K: jointPosition(`${side}Foot`),
  }));
  const hips = slot('Hips'), spine = slot('Spine'), spine1 = slot('Spine1');
  const rows = new Map(), scratch = new Vector3(), point = new Vector3();
  const rowOf = (v) => { let row = rows.get(v); if (!row) { row = new Float64Array(jointCount); for (let s = 0; s < 4; s += 1) if (weights[v * 4 + s] > 0) row[jointIds[v * 4 + s]] += weights[v * 4 + s]; rows.set(v, row); } return row; };
  const stats = { armRule: { Right: 0, Left: 0 }, thighRule: { Right: 0, Left: 0 }, armRemoved: 0, thighRemoved: 0, bounds: { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] } };
  const touch = (v, y, x, z) => { const b = stats.bounds; b.min[0] = Math.min(b.min[0], x); b.min[1] = Math.min(b.min[1], y); b.min[2] = Math.min(b.min[2], z); b.max[0] = Math.max(b.max[0], x); b.max[1] = Math.max(b.max[1], y); b.max[2] = Math.max(b.max[2], z); };
  for (let v = 0; v < vertexCount; v += 1) {
    point.set(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]).multiplyScalar(S);
    const y = point.y;
    for (const side of sides) {
      let armW = 0, foreHandW = 0, legW = 0, lowerTorsoW = 0;
      for (let s = 0; s < 4; s += 1) { const j = jointIds[v * 4 + s], w = weights[v * 4 + s]; if (j === side.arm) armW += w; else if (j === side.fore || j === side.hand) foreHandW += w; else if (j === side.upLeg) legW += w; else if (j === hips || j === spine || j === spine1) lowerTorsoW += w; }
      if (armW > 0 && foreHandW === 0 && y < params.armFade.top && lowerTorsoW > params.torsoGate.from) {
        const armDistance = Math.min(segmentDistance(point, side.A, side.F, scratch), segmentDistance(point, side.F, side.H, scratch));
        const removal = (1 - smoothstep(params.armFade.bottom, params.armFade.top, y)) * smoothstep(params.armClear.keep, params.armClear.remove, armDistance) * smoothstep(params.torsoGate.from, params.torsoGate.to, lowerTorsoW);
        if (removal > 1e-6) {
          const row = rowOf(v), moved = row[side.arm] * removal;
          row[side.arm] -= moved;
          let torsoTotal = 0; for (const t of torso) torsoTotal += row[t];
          if (torsoTotal > 0) for (const t of torso) row[t] += moved * row[t] / torsoTotal; else row[spineByHeight(y)] += moved;
          stats.armRule[side.side] += 1; stats.armRemoved = Math.max(stats.armRemoved, moved); touch(v, y, point.x, point.z);
        }
      }
      if (legW > 0 && y > params.thighFade.bottom) {
        const legDistance = Math.min(segmentDistance(point, side.U, side.L, scratch), segmentDistance(point, side.L, side.K, scratch));
        if (legDistance > params.thighClear) {
          const removal = smoothstep(params.thighFade.bottom, params.thighFade.top, y);
          if (removal > 1e-6) {
            const row = rowOf(v), moved = row[side.upLeg] * removal;
            row[side.upLeg] -= moved; row[hips] += moved;
            stats.thighRule[side.side] += 1; stats.thighRemoved = Math.max(stats.thighRemoved, moved); touch(v, y, point.x, point.z);
          }
        }
      }
    }
  }
  const mask = new Set(rows.keys());

  // Mask-restricted Laplacian smoothing of the weight rows: edited vertices read their full 1-ring, unedited neighbours are never written.
  const neighbours = new Map();
  for (let t = 0; t < indices.length; t += 3) for (let e = 0; e < 3; e += 1) {
    const a = indices[t + e], b = indices[t + (e + 1) % 3];
    if (mask.has(a)) { let set = neighbours.get(a); if (!set) { set = new Set(); neighbours.set(a, set); } set.add(b); }
    if (mask.has(b)) { let set = neighbours.get(b); if (!set) { set = new Set(); neighbours.set(b, set); } set.add(a); }
  }
  const ordered = [...mask].sort((x, y) => x - y);
  const readRow = (v) => rows.get(v) ?? rowOf(v);
  for (let iteration = 0; iteration < params.smoothing.iterations; iteration += 1) {
    const next = new Map();
    for (const v of ordered) {
      const own = rows.get(v), ring = neighbours.get(v) ?? new Set(), sum = new Float64Array(jointCount);
      let n = 0;
      for (const u of ring) { const row = readRow(u); for (let j = 0; j < jointCount; j += 1) sum[j] += row[j]; n += 1; }
      const out = new Float64Array(jointCount);
      for (let j = 0; j < jointCount; j += 1) out[j] = n ? own[j] * (1 - params.smoothing.lambda) + params.smoothing.lambda * sum[j] / n : own[j];
      next.set(v, out);
    }
    for (const [v, row] of next) rows.set(v, row);
  }
  // Unedited vertices pulled into `rows` only as read-only neighbours must not be written back.
  for (const v of rows.keys()) if (!mask.has(v)) rows.delete(v);

  // Pack: the four heaviest influences (glTF VEC4 skin), non-negative, normalised; write into copies of the buffers.
  const bin = Buffer.from(sourceBin), json = JSON.parse(JSON.stringify(sourceJson));
  const J = accessorLayout(json, primitive.attributes.JOINTS_0), W = accessorLayout(json, primitive.attributes.WEIGHTS_0);
  if (J.comps !== 4 || W.comps !== 4 || W.accessor.componentType !== 5126 || W.accessor.normalized) throw new Error('vesper-skin-weights: expected VEC4 float WEIGHTS_0 and VEC4 JOINTS_0');
  if (J.accessor.componentType !== 5121 && J.accessor.componentType !== 5123) throw new Error(`vesper-skin-weights: unsupported JOINTS_0 componentType ${J.accessor.componentType} (expected 5121 or 5123)`);
  const writeJoint = (o, value) => { if (J.accessor.componentType === 5121) bin.writeUInt8(value, o); else bin.writeUInt16LE(value, o); };
  let maxWeightDelta = 0, edited = 0, maxInfluencesSeen = 0;
  for (const v of ordered) {
    const row = rows.get(v), order = Array.from({ length: jointCount }, (_, j) => j).filter((j) => row[j] > 1e-9).sort((x, y) => row[y] - row[x] || x - y);
    maxInfluencesSeen = Math.max(maxInfluencesSeen, order.length);
    const kept = order.slice(0, MAX_INFLUENCES);
    let total = 0; for (const j of kept) total += row[j];
    const before = new Float64Array(jointCount); for (let s = 0; s < 4; s += 1) if (weights[v * 4 + s] > 0) before[jointIds[v * 4 + s]] += weights[v * 4 + s];
    const after = new Float64Array(jointCount); for (const j of kept) after[j] = row[j] / total;
    let delta = 0; for (let j = 0; j < jointCount; j += 1) delta = Math.max(delta, Math.abs(after[j] - before[j]));
    if (delta < 1e-7) continue;
    maxWeightDelta = Math.max(maxWeightDelta, delta); edited += 1;
    for (let s = 0; s < 4; s += 1) {
      const j = kept[s] ?? 0;
      writeJoint(J.base + v * J.stride + s * J.bytes, j);
      bin.writeFloatLE(kept[s] === undefined ? 0 : after[j], W.base + v * W.stride + s * W.bytes);
    }
  }
  const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
  const skinBytes = (buffer) => Buffer.concat([buffer.subarray(J.base, J.base + vertexCount * J.stride), buffer.subarray(W.base, W.base + vertexCount * W.stride)]);
  const report = {
    repair: 'vesper-coat-flap-weights', params,
    input: { binSha256: sha(sourceBin), skinSha256: sha(skinBytes(sourceBin)), vertices: vertexCount, joints: jointCount },
    output: { binSha256: sha(bin), skinSha256: sha(skinBytes(bin)) },
    selection: { maskVertices: mask.size, armRule: stats.armRule, thighRule: stats.thighRule, maxArmWeightMoved: round(stats.armRemoved), maxThighWeightMoved: round(stats.thighRemoved), boundsMetres: { min: stats.bounds.min.map(round), max: stats.bounds.max.map(round) } },
    editedVertices: edited, maxWeightDelta: round(maxWeightDelta), maxInfluencesBeforeTruncation: maxInfluencesSeen,
    normalization: 'top-4 by weight, non-negative, renormalised to sum 1 (float32)',
  };
  return { glb: { json, bin }, report };
}
const round = (x) => Math.round(x * 1e5) / 1e5;
