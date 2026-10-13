import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { parseGlb, encodeGlb } from './import-aren-animation-set.mjs';
import { readAccessorAny } from './creature-rig-kit.mjs';
import { buildBodyProxy, bladeClearance, interpolateFrame, midFrameBladeDeviation, NEAR_FIST, segmentSegmentDistance } from './vesper-blade-clearance.mjs';
import { Rig, buildClip, appendClips, limitJoints, jointExcursions, skinDeformationReport, retargetFrames, JOINT_LIMITS, COMBAT_LIMITS, FPS } from './retarget-aren-tripo-clips.mjs';
import { resolveMixamoSources, loadMixamoDonor } from './mixamo-import.mjs';
import { repairVesperFlapWeights } from './vesper-skin-weights.mjs';
import { KATANA_GRIP } from '../../src/rendering/KatanaGrip.mjs';

/**
 * Authors Vesper's Moonshade clip set (docs/hero-expansion contract §4/§6) on his native 23-joint Tripo skeleton.
 *
 * Every clip uses captured Mixamo or native Tripo motion. Only source timing/windows,
 * mirroring, in-place pinning, looping and bounded wrist corrections are applied.
 * No arm/full-body IK or hand-keyed pose replacement is retained.
 * KatanaGrip.mjs is the runtime and clearance authority; clearance includes interpolated poses.
 *
 * Run: `node scripts/assets/author-vesper-hero-clips.mjs [--previews] [--only=a,b]`. Deterministic; reruns are byte-identical.
 * Nothing under asset-source/playtests/ is touched: the entry is only emitted as `manifest-entry.json`.
 */
const root = fileURLToPath(new URL('../../', import.meta.url));
const DEG = Math.PI / 180;
const TICKS_PER_SECOND = 60;
// Approved delivered native envelope: docs/features/asset-pipeline.md, Anatomy method,
// original GLB SHA256 93ebfb377d0a9a2c44bcd10d5f457f57f09c4ca95fc5821371d7b975582c81b4.
const APPROVED_NATIVE_P999 = 1.75485;
const output = 'asset-source/generated/actor-vesper-hero-01';

/* ------------------------------------------------------------------ hand frames (mirrors src/rendering/NativeHandGrip.ts) */

const RIG_SCALE = 1.7;

function principalAxis(points, seed, perpendicular) {
  const mean = new Vector3();
  for (const point of points) mean.add(point);
  mean.divideScalar(points.length);
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const point of points) {
    const x = point.x - mean.x, y = point.y - mean.y, z = point.z - mean.z;
    xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
  }
  const axis = seed.clone().normalize();
  for (let iteration = 0; iteration < 32; iteration += 1) {
    axis.set(xx * axis.x + xy * axis.y + xz * axis.z, xy * axis.x + yy * axis.y + yz * axis.z, xz * axis.x + yz * axis.y + zz * axis.z);
    if (perpendicular) axis.addScaledVector(perpendicular, -axis.dot(perpendicular));
    axis.normalize();
  }
  if (axis.dot(seed) < 0) axis.negate();
  return axis;
}

/**
 * Right-hand native bind anatomy: metacarpal direction `d`, thumb side `thumb`, palm normal `n`;
 * katana rigid fist: shaft direction `s`, point `palm`, `shaftRadius` in hand-local rig units, mirroring `computeHandGrip`.
 */
function handAnatomy(base) {
  const side = 'Right', { json, bin } = base, primitive = json.meshes[0].primitives[0], joints = json.skins[0].joints;
  const position = readAccessorAny(json, bin, primitive.attributes.POSITION), jointIds = readAccessorAny(json, bin, primitive.attributes.JOINTS_0);
  const weights = readAccessorAny(json, bin, primitive.attributes.WEIGHTS_0), indices = readAccessorAny(json, bin, primitive.indices);
  const inverseBind = readAccessorAny(json, bin, json.skins[0].inverseBindMatrices);
  const jointIndex = (name) => joints.findIndex((node) => json.nodes[node].name === name);
  const matrix = (joint) => new Matrix4().fromArray(inverseBind, joint * 16);
  const handMatrix = matrix(jointIndex(`mixamorig:${side}Hand`));
  const points = [], seen = new Set();
  for (const vertex of indices) {
    if (seen.has(vertex)) continue;
    seen.add(vertex);
    let total = 0;
    for (let c = 0; c < 4; c += 1) if (json.nodes[joints[jointIds[vertex * 4 + c]]].name.includes(`${side}Hand`)) total += weights[vertex * 4 + c];
    if (total >= 0.6) points.push(new Vector3(position[vertex * 3], position[vertex * 3 + 1], position[vertex * 3 + 2]).applyMatrix4(handMatrix));
  }
  const forearm = new Vector3().setFromMatrixPosition(matrix(jointIndex(`mixamorig:${side}ForeArm`)).clone().invert()).applyMatrix4(handMatrix).negate().normalize();
  const d = principalAxis(points, forearm);
  const knuckles = principalAxis(points, new Vector3(0, 1, 0).transformDirection(handMatrix), d);
  let mean = 0;
  for (const point of points) mean += point.dot(knuckles);
  mean /= points.length;
  let skew = 0;
  for (const point of points) skew += (point.dot(knuckles) - mean) ** 3;
  const thumb = knuckles.clone().multiplyScalar(skew > 0 ? 1 : -1);
  const n = thumb.clone().cross(d).normalize();
  // Middle-finger axis: centroid direction of the hand vertices farthest from the wrist.
  const far = points.map((point) => ({ point, distance: point.length() })).sort((x, y) => y.distance - x.distance).slice(0, Math.floor(points.length * 0.15));
  const fingers = far.reduce((sum, item) => sum.add(item.point), new Vector3()).divideScalar(far.length).normalize();
  const anatomy = { side, d, thumb, n, fingers, points };
  const s = thumb.clone().multiplyScalar(Math.cos(KATANA_GRIP.diagonalRadians)).addScaledVector(d, Math.sin(KATANA_GRIP.diagonalRadians)).normalize();
  const bend = d.clone().addScaledVector(s, -d.dot(s)).normalize();
  const lengths = points.map((point) => point.dot(bend)).sort((x, y) => x - y), length = lengths[Math.floor(lengths.length * 0.98)], hinge = length * 0.42;
  const palmPoints = points.filter((point) => point.dot(bend) < hinge);
  let plane = 0, across = 0;
  for (const point of palmPoints) { plane += point.dot(n); across += point.dot(s); }
  plane /= palmPoints.length; across /= palmPoints.length;
  let low = Infinity, high = -Infinity, fingerDepth = 0;
  for (const point of points) {
    low = Math.min(low, point.dot(s)); high = Math.max(high, point.dot(s));
    if (point.dot(bend) > hinge) fingerDepth = Math.max(fingerDepth, point.dot(n) - plane);
  }
  const shaftRadius = (high - low) * 0.16, radius = Math.max((length - hinge) / 2.7, fingerDepth + shaftRadius);
  anatomy.s = s;
  // The cutting edge: cos(edgeRadians)·(-n) + sin(edgeRadians)·bend, mirroring computeHandGrip.
  anatomy.dPerp = n.clone().negate().multiplyScalar(Math.cos(KATANA_GRIP.edgeRadians)).addScaledVector(bend, Math.sin(KATANA_GRIP.edgeRadians)).normalize();
  anatomy.shaftRadius = shaftRadius;
  anatomy.palm = bend.clone().multiplyScalar(hinge).addScaledVector(s, across).addScaledVector(n, plane + radius);
  anatomy.rigid = { bend, hinge, plane, radius };
  return anatomy;
}

/* ------------------------------------------------------------------ pose layers */

const UP = new Vector3(0, 1, 0);
/** Metres → rig units (the rig is 1.7 m tall = 1.0). Every authored distance below is in metres. */
const M = 1 / RIG_SCALE;
const rigDirection = (yaw, pitch) => new Vector3(Math.cos(pitch * DEG) * Math.cos(yaw * DEG), Math.sin(pitch * DEG), -Math.cos(pitch * DEG) * Math.sin(yaw * DEG));
const smooth = (x) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
const quaternionOf = (matrix, out = new Quaternion()) => out.setFromRotationMatrix(matrix);
/** Segment easing, chosen by the key a segment ends on: `in` accelerates into it (blade speed peaks on the strike key), `out` decelerates out of the previous one. */
const EASE = { smooth, lin: (x) => Math.max(0, Math.min(1, x)), in: (x) => { const t = Math.max(0, Math.min(1, x)); return t * t; }, out: (x) => { const t = Math.max(0, Math.min(1, x)); return 1 - (1 - t) * (1 - t); } };

const slerpDirection = (from, to, t) => {
  const q = new Quaternion().setFromUnitVectors(from, to);
  return from.clone().applyQuaternion(new Quaternion().slerp(q, t)).normalize();
};


/**
 * Light wrist-only katana correction for clips played from real motion. Only `mixamorig:RightHand` is rotated (a world rotation about the wrist, children follow);
 * the arm, the torso and the timing stay exactly the donor's. Three optional corrections, each clamped (`maxSwing`, `maxTwist`) so the donor's hand never moves far:
 *   `cone: [lo, hi]`  keeps the blade between `lo` and `hi` degrees of the forearm line (the tenouchi: the blade continues the forearm, bent a little at the wrist);
 *   `aim: [[tick, yaw, pitch, weight], …]`  pulls the blade toward a carry direction (actor frame, or the chest's heading with `frame: 'chest'`);
 *   `lead: 0..1`  rolls the blade about its axis (≤ `maxTwist`) so the cutting edge faces the kissaki's travel while it is fast.
 * The per-frame corrections are smoothed over ±`smooth` frames. Returns the largest swing / roll applied (degrees).
 */
function wristLayer(context, frames, count, layer) {
  const { target, grip } = context;
  const id = (name) => target.index.get(`mixamorig:${name}`);
  const hand = id('RightHand'), fore = id('RightForeArm'), parent = target.parent[hand], chest = id('Spine2');
  const chestRestInverse = target.restWorldQuaternion[chest].clone().invert();
  const tipReach = (KATANA_GRIP.length - KATANA_GRIP.gripFromPommel) * M;
  const maxSwing = (layer.maxSwing ?? 25) * DEG, maxTwist = (layer.maxTwist ?? 20) * DEG, maxCorrection = (layer.maxCorrection ?? 30) * DEG, ease = layer.ease ? EASE[layer.ease] : smooth;
  const handQ0 = [], wrists = [], tips = [], blades = [], edges = [], forearms = [], headings = [];
  for (let k = 0; k < count; k += 1) {
    const world = target.poseFrame(frames, k), q = quaternionOf(world[hand]);
    const wrist = new Vector3().setFromMatrixPosition(world[hand]), elbow = new Vector3().setFromMatrixPosition(world[fore]);
    wrists.push(wrist);
    const blade = grip.s.clone().applyQuaternion(q);
    handQ0.push(q); blades.push(blade); edges.push(grip.dPerp.clone().applyQuaternion(q)); forearms.push(wrist.clone().sub(elbow).normalize());
    tips.push(wrist.clone().add(grip.palm.clone().applyQuaternion(q)).addScaledVector(blade, tipReach));
    const delta = quaternionOf(world[chest]).multiply(chestRestInverse), forward = new Vector3(1, 0, 0).applyQuaternion(delta);
    headings.push(new Quaternion().setFromAxisAngle(UP, Math.atan2(-forward.z, forward.x)));
  }
  // Frame neighbours: a loop's last frame equals its first, so the neighbours wrap over `count - 1` frames; otherwise they clamp.
  const at = (k) => (layer.loop ? ((k % (count - 1)) + (count - 1)) % (count - 1) : Math.max(0, Math.min(count - 1, k)));
  // A constant hand-local correction over each thrust preserves the captured wrist
  // acceleration; fitting per-frame world aim would invent lateral kissaki motion.
  const thrustFits = (layer.thrusts ?? []).map(({ tick, from, to }) => {
    const k = Math.round(tick * FPS / TICKS_PER_SECOND);
    const point = (j, local) => wrists[j].clone().add(grip.palm.clone().addScaledVector(grip.s, tipReach).applyQuaternion(handQ0[j].clone().multiply(local)));
    const evaluate = (local) => {
      const velocity = point(at(k + 1), local).sub(point(at(k - 1), local));
      return velocity.angleTo(grip.s.clone().applyQuaternion(handQ0[k].clone().multiply(local))) / DEG;
    };
    let local = new Quaternion(), score = Math.max(0, evaluate(local) - 12) * 10;
    const across = grip.s.clone().cross(grip.dPerp).normalize();
    for (let angle = 2; angle <= maxSwing / DEG; angle += 2) for (let ring = 0; ring < 24; ring += 1) {
      const phi = ring * Math.PI / 12, axis = grip.dPerp.clone().multiplyScalar(Math.cos(phi)).addScaledVector(across, Math.sin(phi));
      const candidate = new Quaternion().setFromAxisAngle(axis, angle * DEG), cost = Math.max(0, evaluate(candidate) - 12) * 10 + angle;
      if (cost < score) { score = cost; local = candidate; }
    }
    return { tick, from, to, local };
  });
  const bodyCapsules = proxy;
  const clearMargin = (layer.clear?.margin ?? 0.03) / RIG_SCALE, clearFloor = (layer.clear?.floor ?? 0.04) / RIG_SCALE, maxPush = Math.min(layer.clear?.maxPush ?? 25, maxSwing / DEG) * DEG;
  // A carried fist can need a small roll as well as blade-axis swing: the off-axis palm anchor moves with the wrist. Opt-in full rotation-axis sampling leaves the approved strike/gait searches unchanged.
  const searchAxes = layer.clear?.axes ? Array.from({ length: layer.clear.axes }, (_, i) => {
    const y = 1 - 2 * (i + 0.5) / layer.clear.axes, radius = Math.sqrt(1 - y * y), phi = i * Math.PI * (3 - Math.sqrt(5));
    return new Vector3(Math.cos(phi) * radius, y, Math.sin(phi) * radius);
  }) : undefined;
  const pommelAlong = -KATANA_GRIP.gripFromPommel * M, rotated = new Vector3();
  /** Minimum body clearance of the blade (pommel → kissaki, rig units) and the lowest height of its ends for the hand rotated by `q` about the wrist. */
  function bladeClearanceNow(q, wristPos, palmWorld, bladeAxis, segments) {
    rotated.copy(palmWorld).applyQuaternion(q).add(wristPos);
    const direction = bladeAxis.clone().applyQuaternion(q), from = new Vector3(), to = new Vector3();
    let min = Infinity;
    for (const { a, b, r, name } of segments) {
      const near = NEAR_FIST[name], intervals = near === undefined ? [[pommelAlong, tipReach]] : [[pommelAlong, -near], [near, tipReach]];
      for (const [lo, hi] of intervals) {
        if (hi < lo) continue;
        from.copy(rotated).addScaledVector(direction, lo); to.copy(rotated).addScaledVector(direction, hi);
        min = Math.min(min, segmentSegmentDistance(from, to, a, b) - r);
      }
    }
    const base = rotated.y;
    return { min, low: Math.min(base + direction.y * tipReach, base + direction.y * pommelAlong) };
  }
  const aimKeys = layer.aim?.map(([t, yaw, pitch, w = 1]) => ({ t, yaw, pitch, w }));
  const raw = [], applied = { swing: 0, roll: 0 };
  for (let k = 0; k < count; k += 1) {
    const tick = k * TICKS_PER_SECOND / FPS;
    let wanted = blades[k].clone();
    if (layer.cone) {
      const angle = blades[k].angleTo(forearms[k]) / DEG, clamped = Math.max(layer.cone[0], Math.min(layer.cone[1], angle));
      if (Math.abs(clamped - angle) > 1e-4) {
        const axis = forearms[k].clone().cross(blades[k]);
        if (axis.lengthSq() < 1e-8) axis.copy(edges[k]);
        wanted = forearms[k].clone().applyAxisAngle(axis.normalize(), clamped * DEG);
      }
    }
    if (aimKeys) {
      let i = 0;
      while (i < aimKeys.length - 1 && tick > aimKeys[i + 1].t) i += 1;
      const a = aimKeys[i], b = aimKeys[Math.min(i + 1, aimKeys.length - 1)], f = b.t === a.t ? 0 : ease(Math.max(0, Math.min(1, (tick - a.t) / (b.t - a.t))));
      const direction = rigDirection(a.yaw + (b.yaw - a.yaw) * f, a.pitch + (b.pitch - a.pitch) * f);
      if (layer.frame === 'chest') direction.applyQuaternion(headings[k]);
      wanted = slerpDirection(wanted, direction, a.w + (b.w - a.w) * f);
    }
    if (layer.carry) {
      // Carry region in the chest-heading frame: blade pitch <= carry.pitch (deg), forward component within [carry.aheadMin, carry.ahead]; wanted = the nearest in-region direction to the captured blade.
      const sy = Math.sin(layer.carry.pitch * DEG), ax = layer.carry.ahead ?? 2, amin = layer.carry.aheadMin ?? -2, v = blades[k].clone().applyQuaternion(headings[k].clone().invert());
      for (let pass = 0; pass < 12; pass += 1) {
        let changed = false;
        if (v.y > sy) { const h = Math.hypot(v.x, v.z) || 1e-6, nh = Math.sqrt(Math.max(0, 1 - sy * sy)); v.set(v.x / h * nh, sy, v.z / h * nh); changed = true; }
        if (v.x > ax) { const h = Math.hypot(v.y, v.z) || 1e-6, nh = Math.sqrt(Math.max(0, 1 - ax * ax)); v.set(ax, v.y / h * nh, v.z / h * nh); changed = true; }
        if (v.x < amin) { const h = Math.hypot(v.y, v.z) || 1e-6, nh = Math.sqrt(Math.max(0, 1 - amin * amin)); v.set(amin, v.y / h * nh, v.z / h * nh); changed = true; }
        if (!changed) break;
      }
      wanted = v.normalize().applyQuaternion(headings[k]);
    }
    const thrust = thrustFits.find(({ from, to }) => tick >= from && tick <= to);
    const thrustWeight = thrust ? 1 : 0;
    if (thrust) wanted = grip.s.clone().applyQuaternion(thrust.local).applyQuaternion(handQ0[k]);
    const swing = new Quaternion().setFromUnitVectors(blades[k], wanted);
    const angle = 2 * Math.acos(Math.min(1, Math.abs(swing.w)));
    if (angle > maxSwing) swing.slerp(new Quaternion(), 1 - maxSwing / angle);
    if (layer.clear !== false) {
      // Keep the steel clear of the body and the kissaki above the floor: the smallest extra wrist swing (≤ `maxPush`) that does it, in the direction found by a ring search.
      const world = target.poseFrame(frames, k), wristPos = new Vector3().setFromMatrixPosition(world[hand]), palmWorld = grip.palm.clone().applyQuaternion(handQ0[k]);
      const segments = bodyCapsules.map((capsule) => ({ name: capsule.name, a: new Vector3().setFromMatrixPosition(world[capsule.node]), b: capsule.headTip ? new Vector3(0, 0.15, 0).applyMatrix4(world[capsule.node]) : new Vector3().setFromMatrixPosition(world[capsule.toNode]), r: capsule.radius }));
      const evaluate = (q) => bladeClearanceNow(q, wristPos, palmWorld, blades[k], segments);
      const ok = (r) => r.min >= clearMargin && r.low >= clearFloor;
      let result = evaluate(swing);
      if (!ok(result)) {
        const bladeNow = blades[k].clone().applyQuaternion(swing), e1 = new Vector3(0, 1, 0).cross(bladeNow);
        if (e1.lengthSq() < 1e-6) e1.set(1, 0, 0);
        e1.normalize();
        const e2 = bladeNow.clone().cross(e1);
        let best, bestScore = -Infinity;
        search: for (let step = 1; step <= Math.round(maxPush / (3 * DEG)); step += 1) {
          for (let ring = 0; ring < (searchAxes?.length ?? 16); ring += 1) {
            const phi = ring * Math.PI / 8, u = e1.clone().multiplyScalar(Math.cos(phi)).addScaledVector(e2, Math.sin(phi));
            const axis = searchAxes?.[ring] ?? bladeNow.clone().cross(u).normalize();
            const candidate = new Quaternion().setFromAxisAngle(axis, step * 3 * DEG).multiply(swing), r = evaluate(candidate), score = Math.min(r.min - clearMargin, r.low - clearFloor) - 0.002 * step;
            if (score > bestScore) { bestScore = score; best = candidate; }
          }
          if (bestScore >= -0.002 * step) break search;
        }
        if (process.env.VESPER_DEBUG_WRIST && best) { const after = evaluate(best); console.error('wrist', k, 'before', result.min.toFixed(3), result.low.toFixed(3), 'after', after.min.toFixed(3), after.low.toFixed(3), 'need', clearMargin.toFixed(3), clearFloor.toFixed(3), 'angle', (2 * Math.acos(Math.min(1, Math.abs(best.w))) / DEG).toFixed(0)); }
        if (best) swing.copy(best);
      }
    }
    const blade = blades[k].clone().applyQuaternion(swing), edge = edges[k].clone().applyQuaternion(swing);
    let roll = new Quaternion();
    if (layer.lead && thrustWeight === 0) {
      const velocity = tips[at(k + 1)].clone().sub(tips[at(k - 1)]).multiplyScalar(FPS / 2);
      const speed = velocity.length() * RIG_SCALE, across = velocity.addScaledVector(blade, -velocity.dot(blade));
      const weight = layer.lead * smooth((speed - 2.5) / 4);
      if (weight > 1e-3 && across.lengthSq() > 1e-8) {
        across.normalize();
        const phi = Math.atan2(blade.dot(edge.clone().cross(across)), edge.dot(across));
        roll = new Quaternion().setFromAxisAngle(blade, Math.max(-maxTwist, Math.min(maxTwist, phi)) * weight);
      }
    }
    const total = roll.multiply(swing);
    const correctionAngle = 2 * Math.acos(Math.min(1, Math.abs(total.w)));
    if (correctionAngle > maxCorrection) total.slerp(new Quaternion(), 1 - maxCorrection / correctionAngle);
    raw.push(total);
  }
  // Smooth the corrections (aligned to one hemisphere) so a clamp switching on or off never kinks the wrist.
  const radius = layer.smooth ?? 2, total = new Quaternion(), reference = new Quaternion(), identity = new Quaternion();
  for (let k = 0; k < count; k += 1) {
    let x = 0, y = 0, z = 0, w = 0;
    for (let j = -radius; j <= radius; j += 1) {
      const q = raw[at(k + j)], weight = radius + 1 - Math.abs(j), sign = q.dot(raw[k]) < 0 ? -1 : 1;
      x += sign * weight * q.x; y += sign * weight * q.y; z += sign * weight * q.z; w += sign * weight * q.w;
    }
    total.set(x, y, z, w).normalize();
    applied.swing = Math.max(applied.swing, 2 * Math.acos(Math.min(1, Math.abs(total.w))) / DEG);
    const world = target.poseFrame(frames, k), parentWorld = quaternionOf(world[parent], reference);
    parentWorld.invert().multiply(total).multiply(quaternionOf(world[parent])).multiply(frames.rotations[hand] ? new Quaternion().fromArray(frames.rotations[hand], k * 4) : identity).normalize().toArray(frames.rotations[hand], k * 4);
  }
  return applied;
}

/** Every skin vertex that a triangle references and that a Foot/ToeBase bone dominates, CPU-skinned on demand; `rest` is the bind pose's lowest sole height (the floor). */
function soleKit(target, glb) {
  const { json, bin } = glb, primitive = json.meshes[0].primitives[0], read = (id) => readAccessorAny(json, bin, id);
  const positions = read(primitive.attributes.POSITION), joints = read(primitive.attributes.JOINTS_0), weights = read(primitive.attributes.WEIGHTS_0), inverseBind = read(json.skins[0].inverseBindMatrices), indices = read(primitive.indices);
  const skinJoints = json.skins[0].joints, soles = [], referenced = new Uint8Array(positions.length / 3);
  for (const index of indices) referenced[index] = 1;
  for (let v = 0; v < referenced.length; v += 1) {
    if (!referenced[v]) continue;
    let best = 0;
    for (let s = 1; s < 4; s += 1) if (weights[v * 4 + s] > weights[v * 4 + best]) best = s;
    if (/Foot|ToeBase/.test(target.names[skinJoints[joints[v * 4 + best]]])) soles.push(v);
  }
  const matrices = skinJoints.map(() => new Matrix4()), inverse = new Matrix4();
  const lowestOf = (world) => {
    skinJoints.forEach((node, j) => matrices[j].multiplyMatrices(world[node], inverse.fromArray(inverseBind, j * 16)));
    let lowest = Infinity;
    for (const v of soles) {
      let y = 0;
      for (let s = 0; s < 4; s += 1) { const w = weights[v * 4 + s]; if (w > 0) { const e = matrices[joints[v * 4 + s]].elements; y += w * (e[1] * positions[v * 3] + e[5] * positions[v * 3 + 1] + e[9] * positions[v * 3 + 2] + e[13]); } }
      lowest = Math.min(lowest, y);
    }
    return lowest;
  };
  return { rest: lowestOf(target.restWorld), lowest: (frames, k) => lowestOf(target.poseFrame(frames, k)) };
}
let soleCache;
/** One constant Hips lift (world Y) that puts the lowest skinned sole of the whole cycle on the actor's ground (Y = 0, the exported actor root sits on the floor with no origin offset) plus 1 mm; the bind-rest sole height is NOT the runtime floor (measured by the runtime probe). No per-frame change, no foot edit. Returns metres. */
function groundHips(target, frames, count) {
  const soles = (soleCache ??= soleKit(target, baseGlb)), hips = target.index.get('mixamorig:Hips'), parentWorld = target.restWorld[target.parent[hips]], inverse = parentWorld.clone().invert(), p = new Vector3();
  let low = Infinity;
  // 240 Hz: every 30 fps key plus 8 joint-slerp subdivisions per interval (the displayed in-between poses), the same sampling as the blade clearance.
  for (let k = 0; k < count; k += 1) for (let sub = 0; sub < (k === count - 1 ? 1 : 8); sub += 1) low = Math.min(low, soles.lowest(interpolateFrame(frames, k + sub / 8), 0));
  const shift = 0.001 / RIG_SCALE - low;
  for (let k = 0; k < count; k += 1) { p.fromArray(frames.positions[hips], k * 3).applyMatrix4(parentWorld); p.y += shift; p.applyMatrix4(inverse).toArray(frames.positions[hips], k * 3); }
  return shift * RIG_SCALE;
}

/** Hips travel in world rig units: `{ horizontal, vertical }` peak-to-peak range over the frames. */
function hipsTravel(target, frames, count) {
  const hips = target.index.get('mixamorig:Hips'), low = new Vector3(Infinity, Infinity, Infinity), high = new Vector3(-Infinity, -Infinity, -Infinity), p = new Vector3();
  for (let k = 0; k < count; k += 1) { p.setFromMatrixPosition(target.poseFrame(frames, k)[hips]); low.min(p); high.max(p); }
  return { horizontal: Math.hypot(high.x - low.x, high.z - low.z), vertical: high.y - low.y };
}

/** In-place: the hips keep their first-frame horizontal position and their vertical excursion is compressed to at most `maxVertical` (rig units). */
function pinHips(target, frames, count, maxVertical) {
  const hips = target.index.get('mixamorig:Hips'), parent = target.parent[hips], track = frames.positions[hips];
  const heights = [], worlds = [];
  for (let k = 0; k < count; k += 1) { const world = target.poseFrame(frames, k); worlds.push(new Vector3().setFromMatrixPosition(world[hips])); }
  const base = worlds[0], ys = worlds.map((w) => w.y), range = Math.max(...ys) - Math.min(...ys), scale = range > maxVertical ? maxVertical / range : 1;
  for (let k = 0; k < count; k += 1) {
    const inverse = target.poseFrame(frames, k)[parent].clone().invert();
    heights.push(new Vector3(base.x, base.y + (worlds[k].y - base.y) * scale, base.z).applyMatrix4(inverse));
  }
  heights.forEach((v, k) => v.toArray(track, k * 3));
}

/** Keeps each rotation track on one hemisphere (shortest-path interpolation between keyframes). */
function continuity(frames, count) {
  for (const track of frames.rotations) {
    if (!track) continue;
    for (let k = 1; k < count; k += 1) {
      let dot = 0;
      for (let c = 0; c < 4; c += 1) dot += track[k * 4 + c] * track[(k - 1) * 4 + c];
      if (dot < 0) for (let c = 0; c < 4; c += 1) track[k * 4 + c] = -track[k * 4 + c];
    }
  }
}

/* ------------------------------------------------------------------ clip specs */

const specs = [];
const add = (clip, donor, animation, ticks, window, extra = {}) => specs.push({ clip, source: { donor, animation }, sim: { totalTicks: ticks }, window, ...extra });
/** Multi-donor clip: `parts` are `{ donor, animation, ticks: [from, to], keys | window, mirror? }` cross-faded at their boundaries. */
const compose = (clip, ticks, parts, extra = {}) => specs.push({ clip, sim: { totalTicks: ticks }, parts: parts.map(({ donor, animation, ...rest }) => ({ source: { donor, animation }, ...rest })), ...extra });
const LOCOMOTION = JOINT_LIMITS;
// Captured whole-body motion only. Explicit source choices; no synthetic fallback.
const real = (clip, ticks, donor, animation, window, extra = {}) => add(clip, donor, animation, ticks, window, { limits: LOCOMOTION, ...extra, ...(extra.wrist ? { wrist: { ...extra.wrist } } : {}) });
/** Strike clip(s) from strike parts: `{ donor, animation, mirror?, ticks, strike: { tick, search, rate?, leadMax? } }` (resolved by `resolveStrikes`) or any `compose` part. */
const realParts = (clip, ticks, parts, extra = {}) => specs.push({ clip, sim: { totalTicks: ticks, ...extra.sim }, parts: parts.map(({ donor, animation, file, ...rest }) => ({ source: { donor, animation, file }, ...rest })), limits: LOCOMOTION, ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'sim')), ...(extra.wrist ? { wrist: { ...extra.wrist } } : {}) });
/** Wrist-only katana corrections. A carry pulls the blade toward a direction (it trails back-down along the right side); a cut rolls the edge onto the kissaki's travel. */
const CUT_WRIST = { lead: 1, maxTwist: 30, maxSwing: 25, maxCorrection: 30, smooth: 0 };
const CARRY_WRIST = { maxSwing: 25, maxCorrection: 30, smooth: 2 };
/** Non-strike carry only (the sword hand is merely carried, nothing is cut): the bounded correction is raised to the smallest cap that clears the body and the floor on the captured gait. Strikes and throws stay ≤ 30°. */
const carryReach = (cap, extra = {}) => ({ ...CARRY_WRIST, maxSwing: cap, maxCorrection: cap, clear: { maxPush: cap, floor: 0.05, margin: 0.04 }, ...extra });
realParts('aren-idle', 240, [{ donor: 'mixamo', file: 'asset-source/mixamo/vesper/melee-idle.fbx', ticks: [0, 240], window: [0, 4] }], { loop: { overlapSeconds: 0.4 }, wrist: carryReach(36, { aim: [[0, 0, -25]], frame: 'chest' }) });
// Walk 4.9 m/s: Mixamo run-with-sword (in place, unmirrored), the full 0.8 s cycle in 30 ticks (4 steps/s). Full wrist-axis sampling and a 5 cm capsule margin clear the fitted katana's guard from the leg-weighted coat; pitch <= -15deg retains the forward-low carry after smoothing.
realParts('aren-walk', 30, [{ donor: 'mixamo', file: 'asset-source/mixamo/vesper/run-with-sword.fbx', ticks: [0, 30], window: [0, 0.8] }], { loop: { overlapSeconds: 0 }, ground: true, wrist: { ...CARRY_WRIST, maxSwing: 45, maxCorrection: 45, smooth: 1, clear: { maxPush: 45, floor: 0.05, margin: 0.05, axes: 120 }, carry: { pitch: -15, aheadMin: 0.25 }, frame: 'chest' } });
// Run 7.5 m/s: the same capture, left/right mirrored, in 22 ticks (5.46 steps/s); a constant Hips lift from the actual skinned sole envelope grounds the cycle (no foot edit); the blade is carried low and forward (pitch <= -12deg).
realParts('aren-run', 22, [{ donor: 'mixamo', file: 'asset-source/mixamo/vesper/run-with-sword.fbx', ticks: [0, 22], window: [0, 0.8], mirror: true }], { loop: { overlapSeconds: 0 }, ground: true, wrist: { ...CARRY_WRIST, maxSwing: 45, maxCorrection: 45, smooth: 0, clear: { maxPush: 45, floor: 0.05, margin: 0.04 }, carry: { pitch: -12 }, frame: 'chest' } });
// The native jump take is five hops in 2.23 s; one hop is keyed onto the engine's phase spans (rising 0-10, apex ~18, falling to 42) so the clip is not five jumps aliased into one.
real('aren-jump', 42, 'b', 'jump', undefined, { keys: [[0, 0], [10, 0.117], [18.5, 0.25], [28.5, 0.4], [42, 0.533]], airborne: true, wrist: carryReach(45, { smooth: 1, carry: { pitch: -15 }, frame: 'chest' }) });
real('aren-hit', 24, 'f', 'hit_to_body_01', [0.12, 0.9], { wrist: CARRY_WRIST });
// The cheer's arms-up phase starts at 2 s of the take (its first seconds peak at p99.9 1.9 on the native shoulder skin); [2, 7] keeps the arms-up cheer and the lowering.
real('aren-cheer', 300, 'b', 'cheer', [2, 7], { wrist: CARRY_WRIST });
// Retain the complete captured defeat. Full wrist-axis sampling clears the thigh by rolling the off-axis fist anchor; blade-direction-only swings miss that feasible correction.
real('aren-defeat', 360, 'b', 'defeat_02', [0, 8.46666622], { wrist: carryReach(30, { smooth: 1, clear: { maxPush: 30, floor: 0.03, margin: 0.01, axes: 120 } }) });
// Skill clips from real motion. Mixamo sword takes (asset-source/mixamo/vesper) where they carry the cut, Tripo presets otherwise; each strike part puts the
// donor's fastest edge-leading kissaki on the engine tick (`resolveStrikes`) and plays its own acceleration around it (`preRate` / `postRate` source seconds per second).
const MX = (file) => `asset-source/mixamo/vesper/${file}.fbx`;
const mxPart = (file, ticks, tick, search, extra = {}) => ({ donor: 'mixamo', file: MX(file), mirror: Boolean(extra.mirror), reverse: Boolean(extra.reverse), ticks, strike: { tick, search, kind: extra.kind ?? 'cut', preRate: extra.preRate ?? 1.5, postRate: extra.postRate ?? 1.1 } });
const STRIKE = { pin: { maxVertical: 0.12 }, wrist: CUT_WRIST };
const strikeClip = (clip, ticks, parts, strikes, extra = {}) => {
  const thrusts = parts.filter((part) => part.strike?.kind === 'thrust').map((part) => ({ tick: part.strike.tick, from: part.ticks[0], to: part.ticks[1] }));
  realParts(clip, ticks, parts, { sim: strikes.length === 1 ? { activeTick: strikes[0] } : {}, strikes, ...STRIKE, ...extra,
    wrist: { ...(extra.wrist ?? CUT_WRIST), thrusts } });
};
const mxChain = (strikes, ranges, files) => strikes.map((tick, i) => typeof files[i] === 'function' ? files[i](ranges[i], tick) : mxPart(files[i][0], ranges[i], tick, files[i][1], files[i][2]));
// Cut windows whose retargeted skin stretch stays inside the approved native envelope (measured per donor window by VESPER_AUDIT=deform|…): the inward sword slash (1.17 s) and
// the one-handed sword combo's second (2.00 s, forward-right diagonal) and third (2.97 s, forward-left downward diagonal) cuts. The axe/outward/360 takes peak at 1.9-2.0 on the native shoulder skin.
const SLASHES = {
  inward: ['sword-inward-slash', [1.05, 1.25]], lead: ['sword-inward-slash', [1.05, 1.25], { preRate: 0.3, postRate: 0.8 }], last: ['sword-inward-slash', [1.05, 1.25], { postRate: 0.3 }], down: ['one-hand-sword-combo', [1.9, 2.1]], pass: ['one-hand-sword-combo', [2.9, 3.05]],
  thrust: ['thrust-slash', [0.7, 0.8], { kind: 'thrust', preRate: 0.45, postRate: 0.45 }],
  passEnd: ['one-hand-sword-combo', [2.9, 3.05], { postRate: 0.15 }],
};
/** The inward and outward donors hold the blade sideways at their contact (80-106° off the chest heading); a wrist aim toward the chest heading, ramped in only around those ticks, brings it inside the 140° frontal arc (swing ≤ 30°). */
const frontalWrist = (...ticks) => ({ ...CUT_WRIST, maxSwing: 30, aim: ticks.flatMap((tick) => [[tick - 4, 0, 0, 0], [tick, 0, 0, 1], [tick + 4, 0, 0, 0]]), frame: 'chest' });
strikeClip('vesper-iai-1', 18, [
  { donor: 'mixamo', file: MX('draw-sword-1'), ticks: [0, 2], window: [0, 0.1] },
  mxPart(SLASHES.inward[0], [2, 18], 6, SLASHES.inward[1]),
], [6], { crossfadeTicks: 3, wrist: frontalWrist(6) });
strikeClip('vesper-iai-2', 18, [mxPart('one-hand-sword-combo', [0, 18], 6, [2.9, 3.05], { preRate: 1, postRate: 0.5 })], [6]);
strikeClip('vesper-iai-3', 22, [mxPart('sword-outward-slash', [0, 22], 8, [0.85, 0.9], { preRate: 0.6, postRate: 0.3 })], [8], { wrist: frontalWrist(8) });
strikeClip('vesper-iai-4', 30, [mxPart('sword-inward-slash', [0, 30], 10, [1.05, 1.25], { preRate: 0.3, postRate: 0.8 })], [10], { wrist: frontalWrist(10) });
strikeClip('vesper-thousand-cuts', 72, mxChain([8, 18, 28, 38, 48, 58, 66], [[0, 13], [13, 23], [23, 33], [33, 43], [43, 53], [53, 62], [62, 72]],
  [SLASHES.lead, SLASHES.down, SLASHES.pass, SLASHES.inward, SLASHES.down, SLASHES.thrust, SLASHES.pass]), [8, 18, 28, 38, 48, 58, 66], { wrist: frontalWrist(8, 38) });
// The down-cut -> diagonal-cut junction at tick 30 needs the existing blend over +/-4 ticks: +/-3 concentrates the captured forearm/hand turns into keys 28->30 and bows the intervening blade path by 16.3deg even before the wrist layer. This blends actual donor poses; all contact ticks and source rates stay unchanged.
strikeClip('vesper-requiem', 120, [
  ...mxChain([12, 24, 36, 48, 60, 72, 84], [[0, 18], [18, 30], [30, 42], [42, 54], [54, 66], [66, 78], [78, 120]],
    [SLASHES.lead, SLASHES.down, SLASHES.pass, SLASHES.inward, SLASHES.down, SLASHES.thrust, SLASHES.passEnd]),
], [12, 24, 36, 48, 60, 72, 84, 110], { crossfadeTicks: 4, wrist: frontalWrist(12, 48) });
strikeClip('vesper-severing-shadow', 36, [mxPart('one-hand-sword-combo', [0, 36], 12, [2.9, 3.05], { preRate: 0.3, postRate: 0.25 })], [12]);
strikeClip('vesper-shadow-step', 26, [mxPart(SLASHES.thrust[0], [0, 26], 8, SLASHES.thrust[1], SLASHES.thrust[2])], [8], { wrist: CARRY_WRIST });
// The cast proper between the initial knee-lift step and the hip-turning recovery. The broader [1.1, 2.9] window includes both knee-sign failures; this continuous captured window retains the spell gesture without either.
real('vesper-cleanse', 108, 'd', 'cast_a_spell', [1.1333333, 2.6333333], { wrist: { ...CARRY_WRIST, maxSwing: 30, smooth: 1, clear: { maxPush: 30, floor: 0.05, margin: 0.04 } } });
realParts('vesper-cuts-charge', 60, [{ donor: 'mixamo', file: MX('melee-idle'), ticks: [0, 60], window: [0.5, 1.5] }], { loop: { overlapSeconds: 0.3 }, wrist: CARRY_WRIST });
realParts('vesper-shade-charge', 60, [{ donor: 'mixamo', file: MX('melee-idle'), ticks: [0, 60], window: [1.5, 2.5] }], { loop: { overlapSeconds: 0.3 }, wrist: CARRY_WRIST });
// Left-handed throws (the katana stays in the right fist): the left-right mirror of Tripo's overhand baseball pitch; the engine tick lands on the forward overhand release (left hand 10 m/s, pitch -22° at tick 9).
const THROW_WRIST = { ...CARRY_WRIST, maxSwing: 30, maxCorrection: 30, smooth: 0, clear: { maxPush: 30, floor: 0.07, margin: 0.04 } };
realParts('vesper-kunai-fan', 24, [{ donor: 'e', animation: 'pitch_baseball', mirror: true, ticks: [0, 24], keys: [[0, 1.683], [9, 1.833], [24, 2.083]] }], { sim: { activeTick: 9 }, wrist: THROW_WRIST });
realParts('vesper-shade-swap', 40, [{ donor: 'e', animation: 'pitch_baseball', mirror: true, ticks: [0, 40], keys: [[0, 1.7], [8, 1.833], [40, 2.3]] }], { sim: { activeTick: 8 }, wrist: THROW_WRIST });
realParts('vesper-mist-blink', 24, [{ donor: 'mixamo', file: MX('idle-to-sprint'), ticks: [0, 24], window: [0.1, 0.5] }], { airborne: true, pin: { maxVertical: 0.12 }, wrist: carryReach(45, { aim: [[0, 0, -30]], frame: 'chest' }) });
// Second jump ("treading the wind"): two air steps, a somersault tuck, open-out and a soft landing, in place.
compose('aren-air-step', 60, [
  { donor: 'd', animation: 'run_upstairs', window: [0, 0.8], ticks: [0, 60] },
  { donor: 'd', animation: 'flip', keys: [[0, 0.9], [26, 1.2], [38, 1.9], [60, 3.4]], ticks: [14, 60] },
  { donor: 'b', animation: 'jump', keys: [[40, 0.8], [49, 0.967], [60, 1.067]], ticks: [40, 60] },
], { limits: LOCOMOTION, airborne: true, crossfadeTicks: 4, pin: { maxVertical: 0.08 }, wrist: carryReach(45, { smooth: 1, aim: [[0, 45, -20]], frame: 'chest' }) });


for (const spec of specs) if (spec.wrist) spec.wrist = { ...spec.wrist, loop: Boolean(spec.loop) };

/* ------------------------------------------------------------------ build */

const args = process.argv.slice(2);
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = option('only')?.split(',');
const hash = (data) => createHash('sha256').update(data).digest('hex');

/** Finds a Tripo output (`<dir>/tripo-out/<name>-<id8>/model.glb`) and its task id. */
async function locate(dir) {
  const base = `asset-source/generated/${dir}/tripo-out/`;
  const [entry] = (await readdir(root + base)).filter((name) => !name.startsWith('.'));
  const task = JSON.parse(await readFile(root + base + entry + '/task.json', 'utf8'));
  return { path: base + entry + '/model.glb', task: task.task_id, credits: task.credits_consumed };
}
const found = {
  rig: await locate('actor-vesper-hero-mixamo-rig-01'), a: await locate('actor-vesper-hero-anim-a-01'), b: await locate('actor-vesper-hero-anim-b-01'),
  c: await locate('actor-vesper-hero-anim-c-01'), d: await locate('actor-vesper-hero-anim-d-01'), e: await locate('actor-vesper-hero-anim-e-01'),
  f: await locate('actor-vesper-hero-anim-f-01'), g: await locate('actor-vesper-hero-anim-g-01'),
};
const rigPath = found.rig.path;
const sources = Object.fromEntries(Object.entries(found).filter(([key]) => key !== 'rig').map(([key, item]) => [key, item.path]));
const tasks = Object.fromEntries(Object.entries(found).map(([key, item]) => [key, item.task]));
const credits = Object.fromEntries(Object.entries(found).map(([key, item]) => [key, item.credits]));
const presets = {
  a: ['idle', 'walk', 'run', 'slash', 'chop'], b: ['jump', 'dive', 'hurt', 'cheer', 'defeat_02'], c: ['flee_02', 'golf', 'volleyball', 'front_kick_01', 'box_01'],
  d: ['flip', 'run_upstairs', 'cast_a_spell', 'lift_heavy', 'standing_relax'], e: ['pitch_baseball', 'fire', 'dig', 'box_02', 'flee_01'],
  f: ['hit_to_head', 'hit_to_side', 'hit_to_body_01', 'warm_up', 'swagger'], g: ['box_03', 'jump_down', 'fall', 'football_pass', 'shoot'],
};
const sourceBytes = await readFile(root + rigPath);
// Offline bind-weight repair of the coat-flap bleed (RightArm / thigh influence on the coat); positions, topology, rig and textures are bit-identical and the source file stays untouched.
const skinRepair = repairVesperFlapWeights(parseGlb(sourceBytes));
const baseGlb = skinRepair.glb;
const base = Buffer.from(encodeGlb(baseGlb.json, baseGlb.bin));
const rigs = { target: new Rig(baseGlb) };
for (const [key, path] of Object.entries(sources)) rigs[key] = new Rig(parseGlb(await readFile(root + path)));
const target = rigs.target;
const grip = handAnatomy(baseGlb);
const context = { target, grip };
if (process.env.VESPER_AUDIT === 'grade') {
  // Edge-to-travel at every fast kissaki peak (> 8 m/s) of the Mixamo sword clips, for the grip in force.
  const hand = target.index.get('mixamorig:RightHand'), tipReach = (KATANA_GRIP.length - KATANA_GRIP.gripFromPommel) * M, all = [];
  for (const name of ['one-hand-sword-combo', 'sword-inward-slash', 'sword-outward-slash', 'melee-horizontal-rl', 'melee-downward', 'melee-backhand-up', 'melee-360-high', 'thrust-slash', 'draw-sword-1']) for (const mirror of [false, true]) {
    const loaded = await loadMixamoDonor(root + `asset-source/mixamo/vesper/${name}.fbx`, { target }), decoded = loaded.rig.decodeAnimation(loaded.animation), count = Math.floor(decoded.duration * FPS) + 1;
    const frames = retargetFrames(target, loaded.rig, decoded, count, (k) => k / FPS, mirror), rows = [];
    for (let k = 0; k < count; k += 1) {
      const world = target.poseFrame(frames, k), q = quaternionOf(world[hand]), blade = grip.s.clone().applyQuaternion(q);
      rows.push({ blade, edge: grip.dPerp.clone().applyQuaternion(q), tip: new Vector3().setFromMatrixPosition(world[hand]).add(grip.palm.clone().applyQuaternion(q)).addScaledVector(blade, tipReach) });
    }
    const speed = (k) => rows[k + 1].tip.clone().sub(rows[k - 1].tip).length() * FPS / 2 * RIG_SCALE, line = [];
    for (let k = 2; k < count - 2; k += 1) {
      const s = speed(k);
      if (s < Number(process.env.VESPER_MINSPEED ?? 8) || s < speed(k - 1) || s < speed(k + 1)) continue;
      const velocity = rows[k + 1].tip.clone().sub(rows[k - 1].tip), across = velocity.clone().addScaledVector(rows[k].blade, -velocity.dot(rows[k].blade)), lead = Math.round(across.angleTo(rows[k].edge) / DEG);
      const along = Math.round(velocity.angleTo(rows[k].blade) / DEG);
      line.push(`${(k / FPS).toFixed(2)}s ${s.toFixed(0)}m/s lead${lead} along${along}`); all.push({ lead, s });
    }
    console.log(name + (mirror ? ':m' : ''), line.join(' | '));
  }
  const good = all.filter((x) => x.lead <= 30).length;
  console.log(`peaks ${all.length}, lead<=30: ${good}, speed-weighted mean lead ${Math.round(all.reduce((s, x) => s + x.lead * x.s, 0) / all.reduce((s, x) => s + x.s, 0))}`);
  process.exit(0);
}
/**
 * Source audit (VESPER_AUDIT=a:slash,e:pitch_baseball:m,…; `:m` mirrors): retargets each donor take unedited and prints, for every kissaki speed peak above 3 m/s, the
 * blade direction (actor yaw + left / pitch + up, as the key poses use), the edge-to-travel angle, the kissaki speed and the hand offset from the hips (fwd, up, right; metres).
 * With `:carry` it prints the blade direction and its angle to the forearm every 0.25 s instead.
 */
async function auditDonors(items) {
  const hand = target.index.get('mixamorig:RightHand'), fore = target.index.get('mixamorig:RightForeArm'), hips = target.index.get('mixamorig:Hips');
  const tipReach = (KATANA_GRIP.length - KATANA_GRIP.gripFromPommel) * M, degrees = (value) => Math.round(value / DEG);
  for (const item of items) {
    let key, animation, flag;
    if (item.startsWith('mx|')) {
      const [, file, option] = item.split('|'), loaded = await loadMixamoDonor(root + 'asset-source/mixamo/vesper/' + file, { target });
      key = 'mixamo:' + file; rigs[key] = loaded.rig; animation = loaded.animation; flag = option;
    } else [key, animation, flag] = item.split(':');
    const donor = rigs[key], decoded = donor.decodeAnimation(animation);
    const count = Math.floor(decoded.duration * FPS) + 1;
    const flags = flag?.split('+') ?? [], frames = retargetFrames(target, donor, decoded, count, (k) => k / FPS, flags.includes('m'));
    const rows = [];
    for (let k = 0; k < count; k += 1) {
      const world = target.poseFrame(frames, k), q = quaternionOf(world[hand]), wrist = new Vector3().setFromMatrixPosition(world[hand]);
      const blade = grip.s.clone().applyQuaternion(q), edge = grip.dPerp.clone().applyQuaternion(q);
      rows.push({ k, blade, edge, forearm: wrist.clone().sub(new Vector3().setFromMatrixPosition(world[fore])).normalize(), wrist, hips: new Vector3().setFromMatrixPosition(world[hips]), tip: flags.includes('release') ? new Vector3().setFromMatrixPosition(world[target.index.get('mixamorig:LeftHand')]) : wrist.clone().add(grip.palm.clone().applyQuaternion(q)).addScaledVector(blade, tipReach) });
    }
    const aim = (v) => `yaw ${degrees(Math.atan2(-v.z, v.x))} pitch ${degrees(Math.asin(Math.max(-1, Math.min(1, v.y))))}`;
    console.log(`== ${item} (${decoded.duration.toFixed(2)} s, ${count} frames)`);
    if (flags.includes('gait')) {
      // Stance-foot ground speed of the unedited take at native rate (VESPER_TRACE=from,to seconds): per foot the frames where the ankle is in the lowest 25 % of its height range are fitted by
      // forward position vs time; the slope is the speed the body moves over the planted foot. A clip played in place must run at actor speed / this speed.
      const [from, to] = (process.env.VESPER_TRACE ?? `0,${decoded.duration}`).split(',').map(Number), result = [];
      for (const side of ['Left', 'Right']) {
        const ankle = target.index.get(`mixamorig:${side}Foot`), samples = [];
        for (let k = Math.max(0, Math.floor(from * FPS)); k <= Math.min(count - 1, Math.floor(to * FPS)); k += 1) { const world = target.poseFrame(frames, k), p = new Vector3().setFromMatrixPosition(world[ankle]).sub(new Vector3().setFromMatrixPosition(world[hips])); samples.push({ t: k / FPS, x: p.x * RIG_SCALE, y: p.y * RIG_SCALE }); }
        const low = Math.min(...samples.map((s) => s.y)), high = Math.max(...samples.map((s) => s.y)), stance = samples.filter((s) => s.y <= low + 0.25 * (high - low));
        const mean = (list, key) => list.reduce((sum, s) => sum + s[key], 0) / list.length, mt = mean(stance, 't'), mx = mean(stance, 'x');
        const slope = stance.reduce((sum, s) => sum + (s.t - mt) * (s.x - mx), 0) / stance.reduce((sum, s) => sum + (s.t - mt) ** 2, 0);
        result.push(`${side}: stance speed ${(-slope).toFixed(2)} m/s over ${stance.length}/${samples.length} frames, ankle x range ${(Math.max(...samples.map((s) => s.x)) - Math.min(...samples.map((s) => s.x))).toFixed(2)} m, height ${low.toFixed(2)}..${high.toFixed(2)}`);
      }
      console.log(result.join(' | '));
      continue;
    }
    if (flags.includes('trace')) {
      // VESPER_TRACE=from,to (seconds): the (left-hand with `release`) point per frame: hand offset from the hips (fwd, up, right; m) and velocity speed / yaw / pitch.
      const [from, to] = process.env.VESPER_TRACE.split(',').map(Number);
      for (let k = Math.max(1, Math.floor(from * FPS)); k <= Math.min(count - 2, Math.ceil(to * FPS)); k += 1) {
        const r = rows[k], rel = (flags.includes('release') ? r.tip : r.wrist).clone().sub(r.hips).multiplyScalar(RIG_SCALE), v = rows[k + 1].tip.clone().sub(rows[k - 1].tip).multiplyScalar(FPS / 2 * RIG_SCALE);
        console.log(`t ${(k / FPS).toFixed(3)} hand ${rel.x.toFixed(2)},${rel.y.toFixed(2)},${rel.z.toFixed(2)} | ${v.length().toFixed(1)} m/s ${aim(v.clone().normalize())}`);
      }
      continue;
    }
    if (flags.includes('carry')) {
      for (let k = 0; k < count; k += 8) { const r = rows[k]; console.log(`t ${(k / FPS).toFixed(2)} blade ${aim(r.blade)} | to forearm ${degrees(r.blade.angleTo(r.forearm))} | edge ${aim(r.edge)}`); }
      continue;
    }
    const speeds = rows.map((r, k) => (k === 0 || k === count - 1 ? 0 : rows[k + 1].tip.clone().sub(rows[k - 1].tip).length() * FPS / 2 * RIG_SCALE));
    for (let k = 1; k < count - 1; k += 1) {
      if (speeds[k] < Number(process.env.VESPER_MINSPEED ?? 3) || speeds[k] < speeds[k - 1] || speeds[k] < speeds[k + 1]) continue;
      const r = rows[k], velocity = rows[k + 1].tip.clone().sub(rows[k - 1].tip), across = velocity.clone().addScaledVector(r.blade, -velocity.dot(r.blade));
      const rel = (flags.includes('release') ? r.tip : r.wrist).clone().sub(r.hips).multiplyScalar(RIG_SCALE);
      console.log(`t ${(k / FPS).toFixed(2)} ${flags.includes('release') ? 'left-hand' : 'tip'} ${speeds[k].toFixed(1)} m/s | blade ${aim(r.blade)} | edge-to-travel ${degrees(across.angleTo(r.edge))} | travel ${aim(velocity.normalize())} | to forearm ${degrees(r.blade.angleTo(r.forearm))} | hand ${rel.x.toFixed(2)},${rel.y.toFixed(2)},${rel.z.toFixed(2)}`);
    }
  }
}
if (process.env.VESPER_AUDIT === 'hand') {
  // Where the donor's blade lies in the hand: the wrist's hand-local travel direction through the thrust of thrust-slash (a thrust moves along the blade).
  const hand = target.index.get('mixamorig:RightHand'), r6 = (v) => v.toArray().map((x) => Math.round(x * 100) / 100).join(',');
  console.log('grip s', r6(grip.s), 'edge dPerp', r6(grip.dPerp), 'd', r6(grip.d), 'thumb', r6(grip.thumb), 'n(palm)', r6(grip.n), 'fingers', r6(grip.fingers));
  const loaded = await loadMixamoDonor(root + 'asset-source/mixamo/vesper/thrust-slash.fbx', { target }), decoded = loaded.rig.decodeAnimation(loaded.animation), count = Math.floor(decoded.duration * FPS) + 1;
  const frames = retargetFrames(target, loaded.rig, decoded, count, (k) => k / FPS, false);
  for (let k = 4; k < 30; k += 1) {
    const pa = new Vector3().setFromMatrixPosition(target.poseFrame(frames, k - 1)[hand]), pb = new Vector3().setFromMatrixPosition(target.poseFrame(frames, k + 1)[hand]);
    const q = quaternionOf(target.poseFrame(frames, k)[hand]).invert(), v = pb.sub(pa);
    console.log((k / FPS).toFixed(2), 'speed', (v.length() * FPS / 2 * RIG_SCALE).toFixed(1), 'handLocalDir', r6(v.normalize().applyQuaternion(q)));
  }
  process.exit(0);
}
/**
 * Donor deformation audit (VESPER_AUDIT=deform|<file.fbx>[|m][,deform|…]  or  deform|tripo:<donor>:<take>[:m]): retargets the whole unedited take onto the native mesh, CPU-skins it
 * and prints the p99.9 of the triangle-edge stretch pooled over every 10-frame window (stride 5), so clean cut windows can be told from the shoulder/neck-distorting ones.
 */
async function auditDeformation(items) {
  const mesh = baseGlb.json.meshes[0].primitives[0], positions = readAccessorAny(baseGlb.json, baseGlb.bin, mesh.attributes.POSITION), joints = readAccessorAny(baseGlb.json, baseGlb.bin, mesh.attributes.JOINTS_0), weights = readAccessorAny(baseGlb.json, baseGlb.bin, mesh.attributes.WEIGHTS_0);
  const inverseBind = readAccessorAny(baseGlb.json, baseGlb.bin, baseGlb.json.skins[0].inverseBindMatrices), indices = readAccessorAny(baseGlb.json, baseGlb.bin, mesh.indices), vertexCount = positions.length / 3, seen = new Set(), edgeA = [], edgeB = [], bind = [];
  for (let t = 0; t < indices.length; t += 3) for (let e = 0; e < 3; e += 1) {
    const a = indices[t + e], b = indices[t + (e + 1) % 3], low = Math.min(a, b), high = Math.max(a, b), key = low * vertexCount + high;
    if (seen.has(key)) continue;
    seen.add(key);
    const length = Math.hypot(positions[a * 3] - positions[b * 3], positions[a * 3 + 1] - positions[b * 3 + 1], positions[a * 3 + 2] - positions[b * 3 + 2]);
    if (length >= 0.003) { edgeA.push(low); edgeB.push(high); bind.push(length); }
  }
  const edgeCount = edgeA.length, matrices = new Float64Array(target.joints.length * 16), skinned = new Float64Array(vertexCount * 3), m = new Matrix4(), inverse = new Matrix4();
  for (const item of items) {
    const [, source, option] = item.split('|'), mirror = option === 'm';
    let donor, decoded;
    if (source.startsWith('tripo:')) { const [, key, take, flag] = source.split(':'); donor = rigs[key]; decoded = donor.decodeAnimation(take); if (flag === 'm') { /* mirror below */ } }
    else { const loaded = await loadMixamoDonor(root + 'asset-source/mixamo/vesper/' + source, { target }); donor = loaded.rig; decoded = loaded.decoded ?? donor.decodeAnimation(loaded.animation); }
    const flip = mirror || source.endsWith(':m'), count = Math.floor(decoded.duration * FPS) + 1, frames = retargetFrames(target, donor, decoded, count, (k) => k / FPS, flip);
    const samples = new Float32Array(edgeCount * count);
    for (let k = 0; k < count; k += 1) {
      const world = target.poseFrame(frames, k);
      for (let j = 0; j < target.joints.length; j += 1) { inverse.fromArray(inverseBind, j * 16); m.multiplyMatrices(world[target.joints[j]], inverse).toArray(matrices, j * 16); }
      for (let v = 0; v < vertexCount; v += 1) {
        const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
        let sx = 0, sy = 0, sz = 0;
        for (let s = 0; s < 4; s += 1) { const w = weights[v * 4 + s]; if (w <= 0) continue; const o = joints[v * 4 + s] * 16; sx += w * (matrices[o] * x + matrices[o + 4] * y + matrices[o + 8] * z + matrices[o + 12]); sy += w * (matrices[o + 1] * x + matrices[o + 5] * y + matrices[o + 9] * z + matrices[o + 13]); sz += w * (matrices[o + 2] * x + matrices[o + 6] * y + matrices[o + 10] * z + matrices[o + 14]); }
        skinned[v * 3] = sx; skinned[v * 3 + 1] = sy; skinned[v * 3 + 2] = sz;
      }
      for (let e = 0; e < edgeCount; e += 1) { const a = edgeA[e] * 3, b = edgeB[e] * 3; samples[k * edgeCount + e] = Math.abs(Math.log(Math.max(1e-9, Math.hypot(skinned[a] - skinned[b], skinned[a + 1] - skinned[b + 1], skinned[a + 2] - skinned[b + 2])) / bind[e])); }
    }
    const pooled = (from, to) => { const slice = samples.slice(from * edgeCount, to * edgeCount).sort(); return slice[Math.floor(0.999 * (slice.length - 1))]; };
    const line = [];
    for (let k = 0; k + 10 <= count; k += 5) line.push(`${(k / FPS).toFixed(2)}-${((k + 9) / FPS).toFixed(2)}:${pooled(k, k + 10).toFixed(2)}`);
    console.log(`== ${item} (${decoded.duration.toFixed(2)} s) whole ${pooled(0, count).toFixed(3)}\n${line.join('  ')}`);
    if (process.env.VESPER_EDGES) {
      // Which edges form the p99.9 tail: grouped by the dominant bones of their two vertices, with bind length, stretch (signed ln ratio is not kept: |ln|) and the weight disagreement of the endpoints.
      const threshold = pooled(0, count), dominant = (v) => { let best = 0; for (let s = 1; s < 4; s += 1) if (weights[v * 4 + s] > weights[v * 4 + best]) best = s; return target.names[target.joints[joints[v * 4 + best]]].replace('mixamorig:', ''); };
      const weightOf = (v) => { const map = new Map(); for (let s = 0; s < 4; s += 1) if (weights[v * 4 + s] > 0) map.set(joints[v * 4 + s], weights[v * 4 + s]); return map; };
      const groups = new Map(), edgeHits = new Map();
      for (let k = 0; k < count; k += 1) for (let e = 0; e < edgeCount; e += 1) if (samples[k * edgeCount + e] >= threshold) edgeHits.set(e, (edgeHits.get(e) ?? 0) + 1);
      for (const [e, hits] of edgeHits) {
        const a = edgeA[e], b = edgeB[e], key = [dominant(a), dominant(b)].sort().join(' | '), wa = weightOf(a), wb = weightOf(b);
        let disagreement = 0; for (const j of new Set([...wa.keys(), ...wb.keys()])) disagreement += Math.abs((wa.get(j) ?? 0) - (wb.get(j) ?? 0));
        const g = groups.get(key) ?? { edges: 0, hits: 0, bind: 0, disagreement: 0 };
        g.edges += 1; g.hits += hits; g.bind += bind[e]; g.disagreement += disagreement; groups.set(key, g);
      }
      console.log(`tail threshold ${threshold.toFixed(3)} (${edgeHits.size} distinct edges of ${edgeCount}); by dominant-bone pair:`);
      for (const [key, g] of [...groups].sort((p, q) => q[1].hits - p[1].hits).slice(0, 14)) console.log(`  ${key}: edges ${g.edges}, samples ${g.hits}, mean bind ${(g.bind / g.edges * 1000).toFixed(1)} mm, mean endpoint weight disagreement ${(g.disagreement / g.edges).toFixed(2)}`);
    }
  }
}
if (process.env.VESPER_AUDIT?.startsWith('deform|')) { await auditDeformation(process.env.VESPER_AUDIT.split(',')); process.exit(0); }
if (process.env.VESPER_AUDIT) { await auditDonors(process.env.VESPER_AUDIT.split(',')); process.exit(0); }

/* ------------------------------------------------------------------ real-motion sources */

const scans = new Map();
/** Unedited retarget of a donor take: per frame the kissaki's position, blade and edge (rig units), cached per (donor, take, handedness). */
function scanDonor(part) {
  const key = `${part.source.donor}:${part.source.animation}:${part.mirror ? 'm' : ''}`;
  if (scans.has(key)) return scans.get(key);
  const donor = rigs[part.source.donor], decoded = donor.decodeAnimation(part.source.animation), count = Math.floor(decoded.duration * FPS) + 1;
  const frames = retargetFrames(target, donor, decoded, count, (k) => k / FPS, Boolean(part.mirror)), hand = target.index.get('mixamorig:RightHand'), rows = [];
  const tipReach = (KATANA_GRIP.length - KATANA_GRIP.gripFromPommel) * M;
  for (let k = 0; k < count; k += 1) {
    const world = target.poseFrame(frames, k), q = quaternionOf(world[hand]), blade = grip.s.clone().applyQuaternion(q);
    rows.push({ blade, edge: grip.dPerp.clone().applyQuaternion(q), tip: new Vector3().setFromMatrixPosition(world[hand]).add(grip.palm.clone().applyQuaternion(q)).addScaledVector(blade, tipReach) });
  }
  const scan = { duration: decoded.duration, count, rows };
  scans.set(key, scan);
  return scan;
}

/**
 * A strike part (`strike: { tick, search: [from, to] seconds, rate?, leadMax? }`) puts the donor's contact on the engine tick: the contact is the frame of the
 * fastest kissaki inside `search` whose edge leads its travel within `leadMax` degrees (the fastest frame when none does), and the donor plays `rate` source seconds
 * per second on both sides of it, so the cut keeps its own acceleration instead of being stretched between three keys. Writes `part.keys` (tick, source seconds).
 */
function resolveStrikes(list) {
  for (const spec of list) for (const part of spec.parts ?? []) {
    if (!part.strike) continue;
    const { tick, search, kind = 'cut', rate = 1.5, preRate = rate, postRate = rate, leadMax = kind === 'thrust' ? 20 : 30 } = part.strike, scan = scanDonor(part);
    let best, fastest;
    for (let k = 1; k < scan.count - 1; k += 1) {
      const time = k / FPS;
      if (time < search[0] || time > search[1]) continue;
      const r = scan.rows[k], velocity = scan.rows[k + 1].tip.clone().sub(scan.rows[k - 1].tip).multiplyScalar(FPS / 2 * (part.reverse ? -1 : 1)), speed = velocity.length() * RIG_SCALE;
      const across = velocity.clone().addScaledVector(r.blade, -velocity.dot(r.blade)), lead = (kind === 'thrust' ? velocity.angleTo(r.blade) : across.angleTo(r.edge)) / DEG;
      const found = { time, speed, lead };
      if (speed >= (kind === 'thrust' ? 3 : 8) && lead <= leadMax && (!best || speed > best.speed)) best = found;
      if (!fastest || speed > fastest.speed) fastest = found;
    }
    const pick = best ?? fastest;
    if (!pick) throw new Error(`${spec.clip}: nothing to strike inside ${search}`);
    const [from, to] = part.ticks;
    const sign = part.reverse ? -1 : 1, clampTime = (time) => Math.max(0, Math.min(scan.duration, time));
    part.keys = [[from, clampTime(pick.time - sign * preRate * (tick - from) / TICKS_PER_SECOND)], [tick, pick.time], [to, clampTime(pick.time + sign * postRate * (to - tick) / TICKS_PER_SECOND)]];
    part.strike.resolved = { kind, reversed: Boolean(part.reverse), sourceSeconds: pick.time, donorTipMetresPerSecond: pick.speed, donorContactAngle: pick.lead, contactWithinMax: Boolean(best), preRate, postRate };
  }
}

const originOf = (spec) => ((spec.parts ?? [spec]).some((part) => String(part.source.donor).startsWith('mixamo')) ? 'mixamo' : 'tripo');

/** Edge lead at a strike: the angle (°) between the kissaki's travel direction (its velocity across the blade) and the edge (palm side of the fist), and the kissaki speed (m/s). */
function edgeLead(frames, count, ticks) {
  const hand = target.index.get('mixamorig:RightHand'), result = {};
  const tipAt = (k) => {
    const world = target.poseFrame(interpolateFrame(frames, Math.max(0, Math.min(count - 1, k))), 0), q = quaternionOf(world[hand]);
    const s = grip.s.clone().applyQuaternion(q);
    return { tip: new Vector3().setFromMatrixPosition(world[hand]).add(grip.palm.clone().applyQuaternion(q)).addScaledVector(s, (KATANA_GRIP.length - KATANA_GRIP.gripFromPommel) * M), s, n: grip.dPerp.clone().applyQuaternion(q) };
  };
  for (const tick of ticks) {
    const k = tick * FPS / TICKS_PER_SECOND, before = tipAt(k - 0.5), now = tipAt(k), after = tipAt(k + 0.5);
    const velocity = after.tip.clone().sub(before.tip).multiplyScalar(FPS);
    const across = velocity.clone().addScaledVector(now.s, -velocity.dot(now.s));
    // Frontal arc (the anatomy test's gate): the smallest angle between the blade and the chest heading (the Spine2 yaw from rest) over the displayed keys ±1 around the tick.
    const chest = target.index.get('mixamorig:Spine2'), chestRestInverse = target.restWorldQuaternion[chest].clone().invert();
    let frontal = Infinity;
    for (let j = Math.max(0, Math.round(tick / 2) - 1); j <= Math.min(count - 1, Math.round(tick / 2) + 1); j += 1) {
      const world = target.poseFrame(interpolateFrame(frames, j), 0), heading = new Vector3(1, 0, 0).applyQuaternion(quaternionOf(world[chest]).multiply(chestRestInverse)).setY(0).normalize();
      frontal = Math.min(frontal, grip.s.clone().applyQuaternion(quaternionOf(world[hand])).angleTo(heading) / DEG);
    }
    result[tick] = { frontalDegrees: frontal, edgeAngle: velocity.angleTo(now.n) / DEG, edgeAcrossAngle: across.angleTo(now.n) / DEG, bladeToTravelAngle: velocity.angleTo(now.s) / DEG, tipMetresPerSecond: velocity.length() / M, travelPitchDegrees: Math.asin(velocity.clone().normalize().y) / DEG };
  }
  return result;
}

const clips = [], report = {};
const selected = specs.filter((item) => !only || only.includes(item.clip));
const mixamoProvenance = await resolveMixamoSources(selected, rigs, root);
resolveStrikes(selected);
const proxy = buildBodyProxy(baseGlb, target);
/** Separate torso/head/leg proxy metrics are supplemental; every capsule still gates acceptance. */
const ARM_CAPSULES = /Arm|Hand/;
const layerDeform = (stage, built) => { const d = skinDeformationReport(appendClips(base, [built]), built.spec.clip); console.error('layer', built.spec.clip, stage, 'p99', d.p99, 'p999', d.p999, 'max', d.max, d.worstBone, d.worstSeconds); };
for (const spec of selected) {
  if (process.env.VESPER_LAYERS) {
    // Layer-causal diagnosis: skin deformation of the raw retarget, after the toolkit limits, after the wrist layer and after the final limits/continuity.
    const raw = buildClip({ ...spec, limits: null }, rigs); if (spec.pin) pinHips(target, raw.frames, raw.count, spec.pin.maxVertical); layerDeform('raw', raw);
    const limited = buildClip(spec, rigs); if (spec.pin) pinHips(target, limited.frames, limited.count, spec.pin.maxVertical); layerDeform('limits', limited);
    if (spec.wrist) { wristLayer(context, limited.frames, limited.count, spec.wrist); layerDeform('wrist', limited); }
  }
  const clip = buildClip(spec, rigs);
  const limits = spec.limits ?? COMBAT_LIMITS;
  if (spec.pin) pinHips(target, clip.frames, clip.count, spec.pin.maxVertical);
  const wristApplied = spec.wrist ? wristLayer(context, clip.frames, clip.count, spec.wrist) : undefined;
  const corrections = limitJoints(target, clip.frames, clip.count, limits);
  continuity(clip.frames, clip.count);
  if (spec.ground) spec.groundMetres = groundHips(target, clip.frames, clip.count);
  if (process.env.VESPER_LAYERS) layerDeform('final', clip);
  const excursions = jointExcursions(target, clip.frames, clip.count, limits);
  const worst = Object.entries(excursions).map(([joint, e]) => ({ joint: joint.replace('mixamorig:', ''), swing: e.swing, twist: e.twist }));
  const clearance = bladeClearance(target, clip.frames, clip.count, proxy, grip, KATANA_GRIP, RIG_SCALE);
  const bodyClearance = bladeClearance(target, clip.frames, clip.count, proxy.filter((capsule) => !ARM_CAPSULES.test(capsule.name)), grip, KATANA_GRIP, RIG_SCALE);
  const midBlade = midFrameBladeDeviation(target, clip.frames, clip.count, grip.s);
  report[spec.clip] = {
    origin: originOf(spec),
    source: (spec.parts ?? [spec]).map((part) => ({ donor: part.source.file ?? `tripo:${part.source.animation}`, ...(part.mirror ? { mirrored: true } : {}), ...(part.strike?.resolved ? { strike: part.strike.resolved } : {}) })),
    ...(wristApplied ? { wristMaxCorrectionDegrees: Math.round(wristApplied.swing * 10) / 10 } : {}),
    limits: limits === JOINT_LIMITS ? 'JOINT_LIMITS' : limits === COMBAT_LIMITS ? 'COMBAT_LIMITS' : 'custom',
    peakSwing: Math.round(Math.max(...worst.map((e) => e.swing)) * 10) / 10, peakTwist: Math.round(Math.max(...worst.map((e) => e.twist)) * 10) / 10,
    corrections,
    midFrameBladeDegrees: { max: Math.round(midBlade.max * 10) / 10, frame: midBlade.frame },
    bladeClearance: { subdivisions: clearance.subdivisions, bodyMinMetres: bodyClearance.min * RIG_SCALE, bodyBone: bodyClearance.bone, bodyFrame: bodyClearance.frame, floorMetres: clearance.floor * RIG_SCALE, floorFrame: clearance.floorFrame,
      intersections: clearance.perFrame.map((v, k) => v < 0 ? { frame: k / clearance.subdivisions, bone: clearance.bones[k], metres: v * RIG_SCALE } : undefined).filter(Boolean),
      minRigUnits: clearance.min, minMetres: clearance.min * RIG_SCALE, frame: clearance.frame, bone: clearance.bone },
    ...(spec.strikes ? { edgeLead: edgeLead(clip.frames, clip.count, spec.strikes) } : {}),
    ...(spec.pin ? { hipsTravel: (() => { const t = hipsTravel(target, clip.frames, clip.count); return { horizontalMetres: Math.round(t.horizontal * RIG_SCALE * 1e4) / 1e4, verticalMetres: Math.round(t.vertical * RIG_SCALE * 1e4) / 1e4 }; })() } : {}),
    ...(spec.ground ? { soleGroundShiftMetres: Math.round(spec.groundMetres * 1e5) / 1e5 } : {}),
  };
  clips.push(clip);
}
const animated = parseGlb(appendClips(base, clips));
// Tripo's native biped motion faces +X. A scene-level child preserves bind/clip transforms while presenting the +Z forward convention used by the simulation.
for (const scene of animated.json.scenes) {
  const index = animated.json.nodes.length;
  animated.json.nodes.push({ name: 'VesperForward', rotation: [0, -Math.SQRT1_2, 0, Math.SQRT1_2], children: scene.nodes });
  scene.nodes = [index];
}
const bytes = encodeGlb(animated.json, animated.bin);
if (only) {
  if (process.env.VESPER_DEFORM) for (const clip of clips) { const d = skinDeformationReport(bytes, clip.spec.clip); console.error('deformation', clip.spec.clip, d.p99, d.p999, d.max, d.worstBone, d.worstSeconds); }
  const measured = args.includes('--summary') ? Object.fromEntries(Object.entries(report).map(([name, { bladeClearance: { intersections, ...clearance }, ...rest }]) => [name, { ...rest, bladeClearance: clearance }])) : report;
  console.log(JSON.stringify(measured, null, 1));
  process.exit(0);
}

/** Preview aid: a copy of the GLB with a katana-shaped prism (tsuka + blade, KATANA_GRIP proportions) skinned to the right hand's fitted fist, so contact sheets show the carry. */
async function withKatana(glbBytes) {
  const source = parseGlb(glbBytes), { json, bin } = source, primitive = json.meshes[0].primitives[0];
  const joints = json.skins[0].joints, handJoint = joints.findIndex((node) => json.nodes[node].name === 'mixamorig:RightHand');
  const inverse = new Matrix4().fromArray(readAccessorAny(json, bin, json.skins[0].inverseBindMatrices), handJoint * 16).invert();
  const attribute = (name) => readAccessorAny(json, bin, primitive.attributes[name]);
  const position = attribute('POSITION'), normal = attribute('NORMAL'), uv = attribute('TEXCOORD_0'), jointIds = attribute('JOINTS_0'), weights = attribute('WEIGHTS_0'), indices = readAccessorAny(json, bin, primitive.indices);
  // Rings along the shaft (rig units): pommel, tsuka end (0.49 m from the pommel), then the thin flat blade to the tip; the blade section is elongated along the edge axis (the knuckle-side axis), the edge being its +bend end (the knuckle side).
  const segments = 10, edgeAxis = grip.dPerp.clone(), flatAxis = grip.s.clone().cross(edgeAxis).normalize(), rim = [], normals = [], triangles = [];
  const metre = 1 / RIG_SCALE, tsukaEnd = 0.49, rings = [[-KATANA_GRIP.gripFromPommel * metre, grip.shaftRadius, grip.shaftRadius], [(tsukaEnd - 0.1 - KATANA_GRIP.gripFromPommel) * metre, grip.shaftRadius, grip.shaftRadius], [(tsukaEnd - KATANA_GRIP.gripFromPommel) * metre, 0.02 * metre, 0.02 * metre], [(tsukaEnd - KATANA_GRIP.gripFromPommel) * metre, 0.008 * metre, 0.016 * metre], [(KATANA_GRIP.length - KATANA_GRIP.gripFromPommel) * metre, 0.004 * metre, 0.004 * metre]];
  for (const [along, flat, edge] of rings) for (let i = 0; i < segments; i += 1) {
    const angle = i / segments * 2 * Math.PI, radial = edgeAxis.clone().multiplyScalar(Math.cos(angle) * edge).addScaledVector(flatAxis, Math.sin(angle) * flat);
    rim.push(grip.palm.clone().addScaledVector(grip.s, along).add(radial).applyMatrix4(inverse)); normals.push(radial.clone().normalize().transformDirection(inverse));
  }
  for (let ring = 0; ring < rings.length - 1; ring += 1) for (let i = 0; i < segments; i += 1) {
    const j = (i + 1) % segments, a = ring * segments + i, b = ring * segments + j, c = (ring + 1) * segments + i, d = (ring + 1) * segments + j;
    triangles.push(a, b, c, b, d, c);
  }
  const first = position.length / 3, total = first + rim.length;
  const P = new Float32Array(total * 3), N = new Float32Array(total * 3), U = new Float32Array(total * 2), J = new Uint8Array(total * 4), W = new Float32Array(total * 4), I = new Uint32Array(indices.length + triangles.length);
  P.set(position); N.set(normal); U.set(uv); J.set(jointIds); W.set(weights); I.set(indices);
  // Preview-only fist fitting mirrors fitRigidNativeHand; delivered mesh stays native.
  const toHand = inverse.clone().invert(), { bend, hinge, plane, radius } = grip.rigid;
  const point = new Vector3();
  for (let vertex = 0; vertex < first; vertex += 1) {
    let weight = 0;
    for (let c = 0; c < 4; c += 1) if (J[vertex * 4 + c] === handJoint) weight += W[vertex * 4 + c];
    if (weight < 0.6) continue;
    point.fromArray(P, vertex * 3).applyMatrix4(toHand);
    const length = point.dot(bend) - hinge;
    if (length <= 0) continue;
    const angle = length / radius, radial = radius - (point.dot(grip.n) - plane), along = point.dot(grip.s);
    point.copy(bend).multiplyScalar(hinge + radial * Math.sin(angle)).addScaledVector(grip.n, plane + radius - radial * Math.cos(angle)).addScaledVector(grip.s, along).applyMatrix4(inverse).toArray(P, vertex * 3);
  }
  rim.forEach((point, i) => { point.toArray(P, (first + i) * 3); normals[i].toArray(N, (first + i) * 3); U.set([0.5, 0.5], (first + i) * 2); J.set([handJoint, 0, 0, 0], (first + i) * 4); W.set([1, 0, 0, 0], (first + i) * 4); });
  triangles.forEach((index, i) => { I[indices.length + i] = first + index; });
  const parts = [bin];
  let offset = bin.length;
  const addBuffer = (array, type, componentType) => {
    const pad = (4 - offset % 4) % 4;
    if (pad) { parts.push(Buffer.alloc(pad)); offset += pad; }
    const data = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    parts.push(data);
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length });
    offset += data.length;
    json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType, count: array.length / { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type], type });
    return json.accessors.length - 1;
  };
  primitive.attributes.POSITION = addBuffer(P, 'VEC3', 5126);
  const bounds = json.accessors[primitive.attributes.POSITION];
  bounds.min = [Infinity, Infinity, Infinity]; bounds.max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < total; i += 1) for (let c = 0; c < 3; c += 1) { bounds.min[c] = Math.min(bounds.min[c], P[i * 3 + c]); bounds.max[c] = Math.max(bounds.max[c], P[i * 3 + c]); }
  primitive.attributes.NORMAL = addBuffer(N, 'VEC3', 5126); primitive.attributes.TEXCOORD_0 = addBuffer(U, 'VEC2', 5126);
  primitive.attributes.JOINTS_0 = addBuffer(J, 'VEC4', 5121); primitive.attributes.WEIGHTS_0 = addBuffer(W, 'VEC4', 5126); primitive.indices = addBuffer(I, 'SCALAR', 5125);
  const merged = Buffer.concat(parts);
  json.buffers[0].byteLength = merged.length;
  return encodeGlb(json, merged);
}

/* ------------------------------------------------------------------ outputs */

await mkdir(root + output, { recursive: true });
await writeFile(root + output + '/vesper-hero-animated.glb', bytes);
const mapping = Object.fromEntries(clips.map((clip) => [clip.spec.clip, clip.spec.clip]));
for (const action of ['strafe']) mapping['aren-' + action] = 'aren-walk';
for (const action of ['stagger', 'stumble-recovery', 'hard-landing']) mapping['aren-' + action] = 'aren-hit';
for (const action of ['forward-left-dive-roll', 'forward-right-dive-roll', 'perfect-dodge-left', 'perfect-dodge-right', 'quick-step-left', 'quick-step-right', 'forward-shoulder-roll', 'back-handspring', 'left-cartwheel', 'right-cartwheel', 'back-left-pivot-roll', 'back-right-pivot-roll', 'low-slide', 'dodge-recovery']) mapping['aren-' + action] = 'vesper-mist-blink';
for (const action of ['staff-vault', 'low-ledge', 'swing']) mapping['aren-' + action] = 'aren-jump';
const rootMotion = {};
for (const [action, clipName] of Object.entries(mapping)) {
  const clip = clips.find((item) => item.spec.clip === clipName);
  if (clipName === 'aren-air-step') { rootMotion[action] = { mode: 'in-place', evidenceStatus: 'verified' }; continue; }
  const hips = target.index.get('mixamorig:Hips'), track = clip.frames.positions[hips];
  const samples = [0, Math.floor((clip.count - 1) / 2), clip.count - 1].map((i) => ({ time: clip.times[i], position: { x: track[i * 3], y: track[i * 3 + 1], z: track[i * 3 + 2] } }));
  rootMotion[action] = { mode: 'native-root-motion', rootNodeName: 'mixamorigHips', preserveVerticalMotion: action !== 'aren-jump', curveSamples: samples, evidenceStatus: 'verified' };
}
const entry = {
  id: 'actor-vesper-hero', actorId: 'aren', variantOf: 'actor-aren', sourceType: 'native-glb', kind: 'character', rigFamily: 'biped',
  tripoSourceTask: tasks.rig, sourceHash: hash(sourceBytes), skinWeightRepair: { ...skinRepair.report, repairedBaseHash: hash(base) }, outputHash: hash(bytes), runtimeUrl: '/' + output + '/vesper-hero-animated.glb',
  coordinateTransform: { forward: { x: 0, y: 0, z: 1 }, scale: RIG_SCALE }, lodIds: [], requiredActionIds: [],
  actionToClipMapping: mapping, rootMotion, sockets: [], provenance: output + '/provenance.json', evidenceStatus: 'blocked',
};
await writeFile(root + output + '/manifest-entry.json', JSON.stringify(entry, null, 2) + '\n');

// Anatomy report: limits, katana carry and skin deformation of every clip of the delivered GLB.
const deformation = {};
for (const clip of clips) {
  const measured = skinDeformationReport(bytes, clip.spec.clip);
  deformation[clip.spec.clip] = { p99: measured.p99, p999: measured.p999, max: measured.max, worstBone: measured.worstBone };
}
// Locomotion ceiling: the shared locomotion/reaction clips (contract §6) that are native Tripo motion, plus the dash clip. Skill clips must not deform more than these do.
const locomotion = ['aren-idle', 'aren-walk', 'aren-run', 'aren-jump', 'aren-hit', 'aren-cheer', 'aren-defeat', 'vesper-mist-blink'];
const runCeiling = Math.max(...['aren-idle', 'aren-walk', 'aren-run', 'aren-jump', 'vesper-mist-blink'].map((name) => deformation[name].p999));
const ceiling = Math.max(...locomotion.map((name) => deformation[name].p999));
const round6 = (vector) => vector.toArray().map((v) => Math.round(v * 1e6) / 1e6);
const anatomy = {
  schemaVersion: 1, outputHash: hash(bytes),
  grip: {
    katanaGrip: KATANA_GRIP, bladeDiagonalDegrees: KATANA_GRIP.diagonalRadians / DEG, bladeToMiddleFingerDegrees: Math.acos(grip.s.dot(grip.fingers)) / DEG, bladeToPrincipalAxisDegrees: Math.acos(grip.s.dot(grip.d)) / DEG,
    middleFingerHand: round6(grip.fingers), bladeAxisHand: round6(grip.s), palmHand: round6(grip.palm), shaftRadiusRig: Math.round(grip.shaftRadius * 1e6) / 1e6, metacarpalHand: round6(grip.d),
    thumbSideHand: round6(grip.thumb), palmNormalHand: round6(grip.n), edgeAxisHand: round6(grip.dPerp),
    rigidFist: { bendHand: round6(grip.rigid.bend), hingeRig: grip.rigid.hinge, planeRig: grip.rigid.plane, radiusRig: grip.rigid.radius },
  },
  deformationCeiling: { clips: locomotion, p999: ceiling, gaitCeilingP999: runCeiling },
  clips: Object.fromEntries(clips.map((clip) => [clip.spec.clip, { ...report[clip.spec.clip], deformation: deformation[clip.spec.clip] }])),
};
await writeFile(root + output + '/anatomy-report.json', JSON.stringify(anatomy, null, 2) + '\n');
const nonCuts = { 'vesper-shadow-step': [8], 'vesper-thousand-cuts': [58], 'vesper-requiem': [72, 110] };
const acceptance = Object.fromEntries(clips.map(({ spec }) => {
  const measured = report[spec.clip], failures = [];
  for (const [tick, contact] of Object.entries(measured.edgeLead ?? {})) {
    if (spec.clip === 'vesper-requiem' && Number(tick) === 110) continue; // Noto/detonation, not blade contact.
    const thrust = (nonCuts[spec.clip] ?? []).includes(Number(tick));
    const angle = thrust ? contact.bladeToTravelAngle : contact.edgeAngle, max = thrust ? 20 : 30;
    if (angle > max) failures.push({ gate: thrust ? 'thrust-angle' : 'cut-angle', tick: Number(tick), degrees: angle, maximum: max });
    if (contact.tipMetresPerSecond < (thrust ? 3 : 8)) failures.push({ gate: 'contact-speed', tick: Number(tick), metresPerSecond: contact.tipMetresPerSecond });
    if (contact.frontalDegrees > 70) failures.push({ gate: 'frontal-arc', tick: Number(tick), degrees: contact.frontalDegrees, maximum: 70 });
  }
  const clear = measured.bladeClearance;
  if (clear.minMetres < 0) failures.push({ gate: 'capsule-clearance', frame: clear.frame, bone: clear.bone, metres: clear.minMetres });
  // Air Step is lifted by the engine (boost apex 2.1 m): its floor is the world minimum of runtime-jump-report.json (measure-runtime-jump.mjs), not the model-relative value at root y 0.
  if (clear.floorMetres < 0.02 && spec.clip !== 'aren-air-step') failures.push({ gate: 'floor-clearance', frame: clear.floorFrame, metres: clear.floorMetres });
  // Wrist delta from the donor hand: strikes, thrusts and throws stay ≤ 30°; a merely carried sword (nothing is cut) may use up to 45°, always inside the native Hand joint table (limitJoints runs after the wrist layer).
  const wristMaximum = spec.strikes || spec.clip === 'vesper-kunai-fan' ? 30 : 45;
  if ((measured.wristMaxCorrectionDegrees ?? 0) > wristMaximum + 0.01) failures.push({ gate: 'wrist-delta', degrees: measured.wristMaxCorrectionDegrees, maximum: wristMaximum });
  const skinLimit = APPROVED_NATIVE_P999;
  if (deformation[spec.clip].p999 > skinLimit) failures.push({ gate: 'skin-deformation', p999: deformation[spec.clip].p999, maximum: skinLimit });
  return [spec.clip, { source: measured.source, contact: measured.edgeLead, clearance: { ...clear, intersections: undefined }, wristDegrees: measured.wristMaxCorrectionDegrees, failures }];
}));
await writeFile(root + output + '/acceptance-report.json', JSON.stringify({
  schemaVersion: 1, outputHash: hash(bytes), evidenceStatus: 'blocked', approvedNativeP999: APPROVED_NATIVE_P999, clips: acceptance,
  method: 'Actual delivered 30fps keys and eight joint-slerp subdivisions per interval; exact finite shaft-to-body-capsule distance. Capsules are a fitted proxy, not a triangle-mesh intersection proof; floor is shaft endpoints. Final acceptance requires main runtime review.',
}, null, 2) + '\n');
// katanaRev2*: the second katana (1.25 m, slender razor blade, prop-vesper-katana-*-02; ledger: asset-source/generated/heroes-tripo-log.jsonl, revision 2); the animation rework itself ordered no new Tripo task.
const pipelineCredits = { concept: 15, model: 70, katanaConcept: 15, katanaModel: 70, katanaDecimate: 30, katanaRev2Concept: 15, katanaRev2ModelRejected: 70, katanaRev2ConceptRedo: 15, katanaRev2Model: 70, katanaRev2Decimate: 30 };
const discarded = {
  rigV25: { task: '37d04cd2-27c9-4a53-9c6b-ad51d2591445', credits: 25, note: 'spec mixamo on the default rig (v2.5) returned a 46-bone tripo-named skeleton' },
  retargetIdleBatch: { task: 'a7818a31-a3fa-4f48-b076-6361ff2014ea', credits: 0, note: 'failed with 1004 on the v2.5 rig' },
  retargetJumpBatch: { task: 'f0f7d690-92c9-46e6-aa78-9ad888aaf758', credits: 0, note: 'failed with 1004 on the v2.5 rig' },
};
const spent = Object.values(credits).reduce((sum, value) => sum + value, 0) + Object.values(pipelineCredits).reduce((sum, value) => sum + value, 0) + Object.values(discarded).reduce((sum, value) => sum + value.credits, 0);
await writeFile(root + output + '/provenance.json', JSON.stringify({
  schemaVersion: 1, originalModelTask: '3f1576b2-896f-42cf-8b59-b9368468cef2', conceptTask: 'bd53412d-7442-4aae-b977-ecbe1aa4ab46', katanaTasks: { concept: '6023d57f-5e39-4697-abd0-92e08b9a02d7', model: 'fca9127c-62c2-4fe3-81a1-7ffc6fa8c40b', decimate: 'b88adf6d-e632-4c14-ba67-1c80f6e90e1c' },
  katanaTasksRevision2: { concept: '41a68468-0a85-4b8d-aa39-1fdfdc8c85bc', modelRejected: '7df29eae-352a-465e-9831-f90a2f183d19', conceptRedo: '75aaa1f6-6e22-41ed-a65f-a7c68af3300e', model: '74d921f2-eb21-4288-b141-1c532e5ad6c0', decimate: '5674dcee-968a-4920-a8b9-428e53394b52' },
  animationRework: { reason: 'Replaced synthetic full-body/arm IK with captured Mixamo sword motion and native Tripo presets; timing, in-place pinning, loops and bounded wrist corrections only', newTripoTasks: 0, newCredits: 0 },
  tasks, sources, presets, sourceHash: hash(sourceBytes), skinWeightRepair: { ...skinRepair.report, repairedBaseHash: hash(base) }, outputHash: hash(bytes),
  operation: 'Offline captured-motion retarget through Rig/buildClip/appendClips; original native skinned mesh retained. Runtime and authoring import KatanaGrip.mjs.',
  rigNotes: 'The delivered rig is task 97eb3992 (biped, spec mixamo, -p model=rig-v1.0) on the full-quality model; the default v2.5 rig ignores the mixamo naming and was discarded (see discarded).',
  grip: anatomy.grip, credits, pipelineCredits, discarded, creditTotal: spent, evidenceStatus: 'blocked',
  mixamoFiles: mixamoProvenance,
  clips: selected.map((spec) => ({ ...spec, origin: originOf(spec), limits: spec.limits === JOINT_LIMITS ? 'JOINT_LIMITS' : 'COMBAT_LIMITS' })),
}, null, 2) + '\n');
console.log(JSON.stringify({ output: output + '/vesper-hero-animated.glb', hash: hash(bytes), clips: clips.length, actions: Object.keys(mapping).length, deformationCeiling: ceiling }));

/* ------------------------------------------------------------------ previews (opt-in) */

if (args.includes('--previews')) {
  const { execFileSync } = await import('node:child_process');
  const contactClips = clips.flatMap((clip) => (clip.spec.strikes ?? []).map((tick) => {
    const frame = interpolateFrame(clip.frames, tick * FPS / TICKS_PER_SECOND);
    const frames = Object.fromEntries(Object.entries(frame).map(([kind, tracks]) => [kind, tracks.map((track) => track ? Float32Array.from([...track, ...track]) : track)]));
    return { spec: { clip: `${clip.spec.clip}-contact-${tick}` }, frames, count: 2, times: new Float32Array([0, 1 / 60]), jointNodes: clip.jointNodes };
  }));
  const armed = appendClips(await withKatana(bytes), contactClips);
  const armedPath = root + output + '/previews/_katana.glb';
  await mkdir(root + output + '/previews', { recursive: true });
  await writeFile(armedPath, armed);
  const sheets = [
    ['locomotion-side', 'side', ['aren-idle', 'aren-walk', 'aren-run', 'aren-jump', 'vesper-mist-blink', 'aren-hit'], 8],
    ['locomotion-front', 'front', ['aren-idle', 'aren-walk', 'aren-run', 'aren-jump', 'vesper-mist-blink', 'aren-hit'], 8],
    ['locomotion-iso', 'iso', ['aren-idle', 'aren-walk', 'aren-run', 'aren-jump', 'vesper-mist-blink', 'aren-hit'], 8],
    ['reactions-side', 'side', ['aren-cheer', 'aren-defeat', 'aren-air-step'], 10],
    ['reactions-front', 'front', ['aren-cheer', 'aren-defeat', 'aren-air-step'], 10],
    ['reactions-iso', 'iso', ['aren-cheer', 'aren-defeat', 'aren-air-step'], 10],
    ['iai-side', 'side', ['vesper-iai-1', 'vesper-iai-2', 'vesper-iai-3', 'vesper-iai-4'], 10],
    ['iai-front', 'front', ['vesper-iai-1', 'vesper-iai-2', 'vesper-iai-3', 'vesper-iai-4'], 10],
    ['iai-iso', 'iso', ['vesper-iai-1', 'vesper-iai-2', 'vesper-iai-3', 'vesper-iai-4'], 10],
    ['shadow-kunai-side', 'side', ['vesper-shadow-step', 'vesper-kunai-fan', 'vesper-severing-shadow'], 10],
    ['shadow-kunai-front', 'front', ['vesper-shadow-step', 'vesper-kunai-fan', 'vesper-severing-shadow'], 10],
    ['shadow-kunai-iso', 'iso', ['vesper-shadow-step', 'vesper-kunai-fan', 'vesper-severing-shadow'], 10],
    ['charges-side', 'side', ['vesper-cuts-charge', 'vesper-shade-charge', 'vesper-shade-swap'], 10],
    ['charges-front', 'front', ['vesper-cuts-charge', 'vesper-shade-charge', 'vesper-shade-swap'], 10],
    ['charges-iso', 'iso', ['vesper-cuts-charge', 'vesper-shade-charge', 'vesper-shade-swap'], 10],
    ['cuts-requiem-side', 'side', ['vesper-thousand-cuts', 'vesper-requiem', 'vesper-cleanse'], 12],
    ['cuts-requiem-front', 'front', ['vesper-thousand-cuts', 'vesper-requiem', 'vesper-cleanse'], 12],
    ['cuts-requiem-iso', 'iso', ['vesper-thousand-cuts', 'vesper-requiem', 'vesper-cleanse'], 12],
    ['air-step-iso', 'iso', ['aren-air-step'], 12],
  ];
  for (const view of ['front', 'side', 'iso']) sheets.push([`contacts-${view}`, view, contactClips.map((clip) => clip.spec.clip), 1]);
  for (const [name, view, names, frames] of sheets) {
    execFileSync('node', ['scripts/assets/render-clip-preview.mjs', armedPath, `${root}${output}/previews/${name}.png`, `--clips=${names.join(',')}`, `--frames=${frames}`, `--view=${view}`, '--cell=240'], { cwd: root, stdio: 'ignore' });
  }
  await rm(armedPath);
}
