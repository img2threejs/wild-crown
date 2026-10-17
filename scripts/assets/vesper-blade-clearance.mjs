import { Matrix4, Quaternion, Vector3 } from 'three';
import { readAccessorAny } from './creature-rig-kit.mjs';
import { KATANA_GRIP } from '../../src/rendering/KatanaGrip.mjs';

/**
 * Blade-to-body clearance for Vesper's katana (shared by `author-vesper-hero-clips.mjs` and `tests/rendering/vesper-anatomy.test.mjs`).
 *
 * The body is a set of capsules along bone segments, radii fitted to the bind mesh (a percentile of the distance of the vertices dominated by each
 * bone to its segment). The blade is the line from the pommel to the kissaki through the fitted fist (`palm`, hand-local) along the shaft axis `s`.
 * Clearance = exact finite shaft-segment distance to a fitted capsule surface (negative = proxy penetration). Rig units: 1.7 m = 1.0.
 */
const SEGMENTS = [
  ['Hips', 'Spine'], ['Spine', 'Spine1'], ['Spine1', 'Spine2'], ['Spine2', 'Neck'], ['Neck', 'Head'], ['Head', null],
  ['LeftUpLeg', 'LeftLeg'], ['LeftLeg', 'LeftFoot'], ['LeftFoot', 'LeftToeBase'], ['RightUpLeg', 'RightLeg'], ['RightLeg', 'RightFoot'], ['RightFoot', 'RightToeBase'],
  ['LeftArm', 'LeftForeArm'], ['LeftForeArm', 'LeftHand'], ['RightArm', 'RightForeArm'], ['RightForeArm', 'RightHand'],
];
/** Bones whose capsule is only checked beyond this distance (rig units) from the fist along the shaft (the fist holds the tsuka inside them). */
export const NEAR_FIST = Object.freeze({ RightForeArm: 0.075, RightArm: 0.05 });
const RADIUS_PERCENTILE = 0.8;
/** The Head capsule is fitted to the skull only: hair and the ponytail (weighted to the head bone) would otherwise inflate it past the face. */
const HEAD_RADIUS = 0.075;
const HEAD_TIP = new Vector3(0, 0.15, 0);

function segmentDistance(point, a, b, scratch) {
  scratch.subVectors(b, a);
  const length2 = scratch.lengthSq();
  const t = length2 < 1e-12 ? 0 : Math.max(0, Math.min(1, point.clone().sub(a).dot(scratch) / length2));
  return point.distanceTo(a.clone().addScaledVector(scratch, t));
}

/** Capsules fitted to the bind mesh of a Vesper GLB (parsed `{ json, bin }`); `rig` is its `Rig`. */
export function buildBodyProxy(glb, rig) {
  const { json, bin } = glb, primitive = json.meshes[0].primitives[0];
  const position = readAccessorAny(json, bin, primitive.attributes.POSITION), jointIds = readAccessorAny(json, bin, primitive.attributes.JOINTS_0), weights = readAccessorAny(json, bin, primitive.attributes.WEIGHTS_0);
  const inverseBind = readAccessorAny(json, bin, json.skins[0].inverseBindMatrices), joints = json.skins[0].joints;
  const nodeOf = (name) => rig.index.get(`mixamorig:${name}`);
  const jointOf = (name) => joints.indexOf(nodeOf(name));
  const bindWorld = (name) => new Matrix4().fromArray(inverseBind, jointOf(name) * 16).invert();
  const capsules = [];
  const scratch = new Vector3(), vertex = new Vector3();
  for (const [from, to] of SEGMENTS) {
    const matrix = bindWorld(from);
    const a = new Vector3().setFromMatrixPosition(matrix), b = to ? new Vector3().setFromMatrixPosition(bindWorld(to)) : HEAD_TIP.clone().applyMatrix4(matrix);
    const distances = [];
    for (let v = 0; v < position.length / 3; v += 1) {
      let best = 0, bestWeight = 0;
      for (let c = 0; c < 4; c += 1) if (weights[v * 4 + c] > bestWeight) { bestWeight = weights[v * 4 + c]; best = jointIds[v * 4 + c]; }
      if (best !== jointOf(from) || bestWeight < 0.5) continue;
      distances.push(segmentDistance(vertex.set(position[v * 3], position[v * 3 + 1], position[v * 3 + 2]), a, b, scratch));
    }
    distances.sort((x, y) => x - y);
    capsules.push({ name: from, node: nodeOf(from), toNode: to ? nodeOf(to) : undefined, headTip: !to, radius: !to ? HEAD_RADIUS : distances.length ? distances[Math.floor(distances.length * RADIUS_PERCENTILE)] : 0.03 });
  }
  return capsules;
}

/** The same per-joint slerp/translation interpolation used by the runtime mixer. */
export function interpolateFrame(frames, frame, out = {
  rotations: frames.rotations.map((track) => track ? new Float32Array(4) : track),
  positions: frames.positions.map((track) => track ? new Float32Array(3) : track),
}) {
  const k = Math.floor(frame), f = frame - k, a = new Quaternion(), b = new Quaternion();
  frames.rotations.forEach((track, node) => {
    if (track) a.fromArray(track, k * 4).slerp(b.fromArray(track, (k + (f > 0 ? 1 : 0)) * 4), f).toArray(out.rotations[node]);
  });
  frames.positions.forEach((track, node) => {
    if (track) for (let c = 0; c < 3; c += 1) out.positions[node][c] = track[k * 3 + c] * (1 - f) + track[(k + (f > 0 ? 1 : 0)) * 3 + c] * f;
  });
  return out;
}

/** Exact distance of two finite segments, including parallel and degenerate segments. */
export function segmentSegmentDistance(p, q, a, b) {
  const u = q.clone().sub(p), v = b.clone().sub(a), w = p.clone().sub(a);
  const uu = u.lengthSq(), vv = v.lengthSq(), uv = u.dot(v), uw = u.dot(w), vw = v.dot(w);
  if (uu < 1e-12) return segmentDistance(p, a, b, new Vector3());
  if (vv < 1e-12) return segmentDistance(a, p, q, new Vector3());
  const denominator = uu * vv - uv * uv, clamp = (t) => Math.max(0, Math.min(1, t));
  let s = denominator > 1e-12 ? clamp((uv * vw - vv * uw) / denominator) : 0;
  let t = (uv * s + vw) / vv;
  if (t < 0) { t = 0; s = clamp(-uw / uu); }
  else if (t > 1) { t = 1; s = clamp((uv - uw) / uu); }
  return w.addScaledVector(u, s).addScaledVector(v, -t).length();
}

const GUARD_SAMPLES = 16, guardU = new Vector3(), guardV = new Vector3(), guardPoint = new Vector3(), guardScratch = new Vector3();
/**
 * Clearance (rig units) of the tsuba disc to a capsule `a`–`b` of `radius`: rim and half-radius rings on both faces of the guard.
 * `seat` = the grip point and `axis` = the unit blade axis, both in the capsule's space.
 */
export function guardClearance(seat, axis, a, b, radius, katana = KATANA_GRIP, scale = 1.7) {
  guardU.set(0, 1, 0).cross(axis);
  if (guardU.lengthSq() < 1e-6) guardU.set(1, 0, 0).cross(axis);
  guardU.normalize(); guardV.copy(axis).cross(guardU);
  let min = Infinity;
  for (const along of katana.guardFromPommel) {
    const face = (along - katana.gripFromPommel) / scale;
    for (const ring of [0.5, 1]) for (let i = 0; i < GUARD_SAMPLES; i += 1) {
      const angle = i / GUARD_SAMPLES * 2 * Math.PI, r = ring * katana.guardRadius / scale;
      guardPoint.copy(seat).addScaledVector(axis, face).addScaledVector(guardU, Math.cos(angle) * r).addScaledVector(guardV, Math.sin(angle) * r);
      min = Math.min(min, segmentDistance(guardPoint, a, b, guardScratch) - radius);
    }
  }
  return min;
}

/**
 * Minimum shaft/body-proxy clearance over keys and eight joint-slerp subdivisions per key interval.
 * `grip` = `{ s, palm }` in hand-local rig units; katana dimensions default to the runtime authority in metres.
 */
export function bladeClearance(rig, frames, count, capsules, grip, katana = KATANA_GRIP, scale = 1.7, subdivisions = 8) {
  const handNode = rig.index.get('mixamorig:RightHand');
  const result = { min: Infinity, frame: -1, bone: '', perFrame: [], bones: [], floor: Infinity, floorFrame: -1, subdivisions };
  const palm = new Vector3(), axis = new Vector3(), wrist = new Vector3(), handQ = new Quaternion(), a = new Vector3(), b = new Vector3();
  const pommel = -katana.gripFromPommel / scale, tip = (katana.length - katana.gripFromPommel) / scale;
  let interpolated;
  for (let step = 0; step <= (count - 1) * subdivisions; step += 1) {
    const frame = step / subdivisions;
    interpolated = interpolateFrame(frames, frame, interpolated);
    const world = rig.poseFrame(interpolated, 0);
    handQ.setFromRotationMatrix(world[handNode]);
    wrist.setFromMatrixPosition(world[handNode]);
    palm.copy(grip.palm).applyQuaternion(handQ).add(wrist);
    axis.copy(grip.s).applyQuaternion(handQ);
    let frameMin = Infinity, frameBone = '';
    const at = (along) => palm.clone().addScaledVector(axis, along);
    const kissaki = at(tip), pommelPoint = at(pommel);
    const low = Math.min(kissaki.y, pommelPoint.y);
    if (low < result.floor) { result.floor = low; result.floorFrame = frame; }
    for (const capsule of capsules) {
      a.setFromMatrixPosition(world[capsule.node]);
      if (capsule.headTip) b.copy(HEAD_TIP).applyMatrix4(world[capsule.node]); else b.setFromMatrixPosition(world[capsule.toNode]);
      const near = NEAR_FIST[capsule.name];
      const intervals = near === undefined ? [[pommel, tip]] : [[pommel, -near], [near, tip]];
      for (const [lo, hi] of intervals) {
        if (hi < lo) continue;
        const clearance = segmentSegmentDistance(at(lo), at(hi), a, b) - capsule.radius;
        if (clearance < frameMin) { frameMin = clearance; frameBone = capsule.name; }
      }
      // The sword arm's own capsules wrap the fist; the guard is checked against every other body part.
      if (near === undefined) {
        const guard = guardClearance(palm, axis, a, b, capsule.radius, katana, scale);
        if (guard < frameMin) { frameMin = guard; frameBone = capsule.name; }
      }
    }
    result.perFrame.push(frameMin); result.bones.push(frameBone);
    if (frameMin < result.min) { result.min = frameMin; result.frame = frame; result.bone = frameBone; }
  }
  return result;
}

/**
 * Worst in-between-frame deviation of the blade (degrees). The engine plays at 60 Hz over 30 fps keys, so every other displayed pose is the
 * per-joint slerp of two neighbours: if the joint rotations of consecutive keys differ in their roll shares, the blade swings away from the path of both
 * keys in between (a candy-wrapper pop that no key frame shows). Compares the blade axis of the interpolated pose with the great-circle midpoint of the
 * two keys' blade axes. `axis` = the blade axis in hand-local space. Returns `{ max, frame }`.
 */
export function midFrameBladeDeviation(rig, frames, count, axis) {
  const handNode = rig.index.get('mixamorig:RightHand');
  const mid = { rotations: frames.rotations.map((track) => (track ? new Float32Array(4) : track)), positions: frames.positions.map((track) => (track ? new Float32Array(3) : track)) };
  const a = new Quaternion(), b = new Quaternion(), blade = (world) => axis.clone().applyQuaternion(new Quaternion().setFromRotationMatrix(world[handNode]));
  let result = { max: 0, frame: -1 }, previous = blade(rig.poseFrame(frames, 0));
  for (let k = 0; k + 1 < count; k += 1) {
    const next = blade(rig.poseFrame(frames, k + 1));
    frames.rotations.forEach((track, node) => { if (track) a.fromArray(track, k * 4).slerp(b.fromArray(track, (k + 1) * 4), 0.5).toArray(mid.rotations[node]); });
    frames.positions.forEach((track, node) => { if (track) for (let c = 0; c < 3; c += 1) mid.positions[node][c] = (track[k * 3 + c] + track[(k + 1) * 3 + c]) / 2; });
    const expected = previous.clone().add(next);
    if (expected.lengthSq() > 1e-6) {
      const deviation = blade(rig.poseFrame(mid, 0)).angleTo(expected.normalize()) * 180 / Math.PI;
      if (deviation > result.max) result = { max: deviation, frame: k };
    }
    previous = next;
  }
  return result;
}
