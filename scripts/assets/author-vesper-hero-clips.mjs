import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { parseGlb, encodeGlb } from './import-aren-animation-set.mjs';
import { readAccessorAny } from './creature-rig-kit.mjs';
import { buildBodyProxy, bladeClearance, guardClearance, interpolateFrame, midFrameBladeDeviation, NEAR_FIST, segmentSegmentDistance } from './vesper-blade-clearance.mjs';
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
/** The toolkit's 30 fps key rate; the layers below shadow `FPS` with `layer.fps ?? LAYER_FPS` so a 60 Hz clip (the knockdown / get-up set) maps frames to ticks correctly. */
const LAYER_FPS = FPS;
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
 * Right-hand native bind anatomy: metacarpal direction `d`, calibration side `thumb` (whole-hand skew), palm normal `n`;
 * katana rigid fist: shaft direction `s`, seat `palm`, `shaftRadius` in hand-local rig units, mirroring `computeHandGrip` and its rigid katana fist.
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
  // Calibration frame of the captured blade and edge (kept stable); the anatomical palm is resolved from the thumb below.
  const reference = thumb.clone().cross(d).normalize();
  // Middle-finger axis: centroid direction of the hand vertices farthest from the wrist.
  const far = points.map((point) => ({ point, distance: point.length() })).sort((x, y) => y.distance - x.distance).slice(0, Math.floor(points.length * 0.15));
  const fingers = far.reduce((sum, item) => sum.add(item.point), new Vector3()).divideScalar(far.length).normalize();
  const s = thumb.clone().multiplyScalar(Math.cos(KATANA_GRIP.diagonalRadians)).addScaledVector(d, Math.sin(KATANA_GRIP.diagonalRadians)).normalize();
  const bend = d.clone().addScaledVector(s, -d.dot(s)).normalize();
  // The katana seat mirrors the runtime rigid fist (katanaHandGrip): Vesper's thumb protrudes below the knuckles, and thumb × fingers is the palm.
  const lengths = points.map((point) => point.dot(d)).sort((x, y) => x - y), length = lengths[Math.floor(lengths.length * 0.98)], hinge = length * 0.42;
  const natural = s.clone().addScaledVector(d, -s.dot(d)).normalize();
  const fingerPoints = points.filter((point) => point.dot(d) > hinge);
  const laterals = points.filter((point) => point.dot(d) > hinge + (length - hinge) * 0.25).map((point) => point.dot(natural)).sort((x, y) => x - y);
  const middle = laterals[Math.floor(laterals.length / 2)];
  let positive = 0, negative = 0;
  for (const point of points) {
    const along = point.dot(d);
    if (along <= length * 0.15 || along >= hinge) continue;
    const lateral = point.dot(natural) - middle;
    positive = Math.max(positive, lateral); negative = Math.max(negative, -lateral);
  }
  const n = natural.clone().multiplyScalar(positive > negative ? 1 : -1).cross(d).normalize();
  const fingerLengths = fingerPoints.map((point) => point.dot(d)).sort((x, y) => x - y), reach = fingerLengths[Math.floor(fingerLengths.length * 0.98)] - hinge;
  let acrossMin = Infinity, acrossMax = -Infinity, surface = -Infinity;
  for (const point of fingerPoints) {
    const across = point.dot(natural);
    acrossMin = Math.min(acrossMin, across); acrossMax = Math.max(acrossMax, across); surface = Math.max(surface, point.dot(n));
  }
  const shaftRadius = Math.min((acrossMax - acrossMin) * 0.09, reach * 0.18);
  const anatomy = { side, d, thumb, n, fingers, points };
  anatomy.s = s;
  // The cutting edge: cos(edgeRadians)·(-reference) + sin(edgeRadians)·bend, mirroring computeHandGrip.
  anatomy.dPerp = reference.clone().negate().multiplyScalar(Math.cos(KATANA_GRIP.edgeRadians)).addScaledVector(bend, Math.sin(KATANA_GRIP.edgeRadians)).normalize();
  anatomy.shaftRadius = shaftRadius;
  anatomy.palm = d.clone().multiplyScalar(hinge).addScaledVector(natural, (acrossMin + acrossMax) / 2).addScaledVector(n, surface + shaftRadius)
    .applyQuaternion(new Quaternion().setFromUnitVectors(natural, s));
  anatomy.rigid = { bend, hinge, plane: surface + shaftRadius - reach / 3, radius: reach / 3 };
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
  const FPS = layer.fps ?? LAYER_FPS; // key rate of `frames`: 30 for the toolkit clips, 60 for the knockdown / get-up clips
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
      if (near === undefined) min = Math.min(min, guardClearance(rotated, direction, a, b, r, KATANA_GRIP, RIG_SCALE));
    }
    const base = rotated.y;
    return { min, low: Math.min(base + direction.y * tipReach, base + direction.y * pommelAlong) };
  }
  const aimKeys = layer.aim?.map(([t, yaw, pitch, w = 1]) => ({ t, yaw, pitch, w }));
  const raw = [], applied = { swing: 0, roll: 0 };
  const evals = [];
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
      evals[k] = evaluate;
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
    // The cap binds the edge roll before the blade swing: the swing keeps the blade in its frontal arc and clear of the body.
    let total = roll.clone().multiply(swing);
    const angleOf = (q) => 2 * Math.acos(Math.min(1, Math.abs(q.w)));
    if (angleOf(total) > maxCorrection) {
      if (angleOf(swing) >= maxCorrection) total = swing.clone().slerp(new Quaternion(), 1 - maxCorrection / angleOf(swing));
      else {
        let low = 0, high = 1;
        for (let pass = 0; pass < 24; pass += 1) {
          const mid = (low + high) / 2;
          if (angleOf(new Quaternion().slerp(roll, mid).multiply(swing)) > maxCorrection) high = mid; else low = mid;
        }
        total = new Quaternion().slerp(roll, low).multiply(swing);
      }
    }
    raw.push(total);
  }
  // `coherent`: a key whose own solution leaves the steel inside the margins adopts whichever neighbouring key's rotation clears best (the ring search can jump between two far-apart solutions from one key to the next).
  if (layer.coherent && layer.clear !== false) {
    const score = (r) => Math.min(r.min - clearMargin, r.low - clearFloor);
    for (let pass = 0; pass < 4; pass += 1) for (let k = 0; k < count; k += 1) {
      let best = raw[k], bestScore = score(evals[k](raw[k]));
      if (bestScore >= 0) continue;
      for (const j of [k - 1, k + 1, k - 2, k + 2]) if (j >= 0 && j < count) { const s = score(evals[k](raw[j])); if (s > bestScore) { bestScore = s; best = raw[j]; } }
      raw[k] = best;
    }
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

/**
 * Bounded shoulder correction for captured poses whose palm-seated katana cannot clear the body or reach its frontal arc with the wrist alone.
 * Only `mixamorig:RightArm` is rotated (a world rotation about the shoulder; forearm, hand and katana follow); the wrist layer runs afterwards and limitJoints still clamps.
 *   `clear: { margin, floor, maxDegrees, axes?, maxPitch? }`  the smallest rotation that keeps the steel and tsuba `margin` metres from every torso, head, leg and left-arm capsule, both blade ends `floor` metres up and, with `maxPitch`, the blade at or below that pitch (degrees);
 *   `frontal: { ticks, degrees }`  turns the blade toward the chest heading by at most `degrees`, ramped in over ±4 ticks around each strike tick;
 *   `thrusts: [{ tick, from, to, degrees }]`  bends the kissaki's path inside each thrust window onto the blade line of its strike tick (≤ `degrees` per frame), so the point travels along the steel.
 * Corrections are smoothed over ±`smooth` frames; `afterWrist` runs the layer after the wrist layer (a carried blade the wrist re-aims). Returns the largest applied rotation (degrees).
 */
function armLayer(context, frames, count, layer) {
  const { target, grip } = context;
  const FPS = layer.fps ?? LAYER_FPS;
  const id = (name) => target.index.get(`mixamorig:${name}`);
  const arm = id('RightArm'), hand = id('RightHand'), parent = target.parent[arm], chest = id('Spine2');
  const chestRestInverse = target.restWorldQuaternion[chest].clone().invert();
  const tipReach = (KATANA_GRIP.length - KATANA_GRIP.gripFromPommel) * M, pommelAlong = -KATANA_GRIP.gripFromPommel * M;
  const capsules = proxy.filter((capsule) => !/^Right(Arm|ForeArm)$/.test(capsule.name));
  const clear = layer.clear, margin = (clear?.margin ?? 0.04) / RIG_SCALE, floor = (clear?.floor ?? 0.04) / RIG_SCALE, maxClear = (clear?.maxDegrees ?? 20) * DEG;
  // A carried blade keeps its low carry while the shoulder clears it: the blade may not rise above `maxPitch` degrees.
  const pitchCeiling = clear?.maxPitch === undefined ? Infinity : Math.sin(clear.maxPitch * DEG);
  const axisCount = clear?.axes ?? 96, axes = Array.from({ length: axisCount }, (_, i) => {
    const y = 1 - 2 * (i + 0.5) / axisCount, radius = Math.sqrt(1 - y * y), phi = i * Math.PI * (3 - Math.sqrt(5));
    return new Vector3(Math.cos(phi) * radius, y, Math.sin(phi) * radius);
  });
  const at = (k) => (layer.loop ? ((k % (count - 1)) + (count - 1)) % (count - 1) : Math.max(0, Math.min(count - 1, k)));
  const angleOf = (q) => 2 * Math.acos(Math.min(1, Math.abs(q.w)));
  const thrustLines = (layer.thrusts ?? []).map(({ tick, from, to, degrees }) => {
    const k = Math.round(tick * FPS / TICKS_PER_SECOND), world = target.poseFrame(frames, k), q = quaternionOf(world[hand]);
    return { k, from: Math.round(from * FPS / TICKS_PER_SECOND), to: Math.round(to * FPS / TICKS_PER_SECOND), limit: (degrees ?? 12) * DEG, blade: grip.s.clone().applyQuaternion(q),
      tip: new Vector3().setFromMatrixPosition(world[hand]).add(grip.palm.clone().addScaledVector(grip.s, tipReach).applyQuaternion(q)) };
  });
  const raw = [];
  for (let k = 0; k < count; k += 1) {
    const world = target.poseFrame(frames, k), shoulder = new Vector3().setFromMatrixPosition(world[arm]);
    const handQ = quaternionOf(world[hand]), wrist = new Vector3().setFromMatrixPosition(world[hand]);
    const blade = grip.s.clone().applyQuaternion(handQ), seat = wrist.clone().add(grip.palm.clone().applyQuaternion(handQ));
    let rotation = new Quaternion();
    if (layer.frontal) {
      const tick = k * TICKS_PER_SECOND / FPS;
      const weight = Math.max(0, ...layer.frontal.ticks.map((strike) => 1 - Math.abs(tick - strike) / 4));
      if (weight > 0) {
        const heading = new Vector3(1, 0, 0).applyQuaternion(quaternionOf(world[chest]).multiply(chestRestInverse)).setY(0).normalize();
        const turn = new Quaternion().setFromUnitVectors(blade, heading), limit = layer.frontal.degrees * DEG * weight, angle = angleOf(turn);
        rotation = angle > limit ? new Quaternion().slerp(turn, limit / angle) : turn;
      }
    }
    for (const line of thrustLines) {
      if (k <= line.from || k >= line.to || k === line.k) continue;
      const weight = 1 - Math.abs(k - line.k) / (k < line.k ? line.k - line.from : line.to - line.k);
      const tip = wrist.clone().add(grip.palm.clone().addScaledVector(grip.s, tipReach).applyQuaternion(handQ)).sub(shoulder).applyQuaternion(rotation).add(shoulder);
      const onLine = line.tip.clone().addScaledVector(line.blade, tip.clone().sub(line.tip).dot(line.blade));
      const bend = new Quaternion().setFromUnitVectors(tip.sub(shoulder).normalize(), onLine.sub(shoulder).normalize()), angle = angleOf(bend) * weight;
      rotation = new Quaternion().slerp(bend, Math.min(angle, line.limit) / Math.max(angleOf(bend), 1e-9)).multiply(rotation);
    }
    if (clear) {
      const segments = capsules.map((capsule) => ({ name: capsule.name, a: new Vector3().setFromMatrixPosition(world[capsule.node]), b: capsule.headTip ? new Vector3(0, 0.15, 0).applyMatrix4(world[capsule.node]) : new Vector3().setFromMatrixPosition(world[capsule.toNode]), r: capsule.radius }));
      const from = new Vector3(), to = new Vector3(), base = new Vector3(), direction = new Vector3();
      const evaluate = (q) => {
        base.copy(seat).sub(shoulder).applyQuaternion(q).add(shoulder); direction.copy(blade).applyQuaternion(q);
        let min = Infinity;
        for (const { a, b, r } of segments) {
          from.copy(base).addScaledVector(direction, pommelAlong); to.copy(base).addScaledVector(direction, tipReach);
          min = Math.min(min, segmentSegmentDistance(from, to, a, b) - r, guardClearance(base, direction, a, b, r, KATANA_GRIP, RIG_SCALE));
        }
        return Math.min(min - margin, Math.min(base.y + direction.y * tipReach, base.y + direction.y * pommelAlong) - floor, (pitchCeiling - direction.y) * 0.5);
      };
      if (evaluate(rotation) < 0) {
        let best = rotation, bestScore = evaluate(rotation);
        search: for (let degrees = 2; degrees <= maxClear / DEG + 1e-9; degrees += 2) {
          for (const axis of axes) {
            const candidate = new Quaternion().setFromAxisAngle(axis, degrees * DEG).multiply(rotation), score = evaluate(candidate) - 0.0005 * degrees;
            if (score > bestScore) { bestScore = score; best = candidate; }
          }
          if (bestScore >= -0.0005 * degrees) break search;
        }
        rotation = best;
      }
    }
    raw.push(rotation);
  }
  const radius = layer.smooth ?? 2, total = new Quaternion(), reference = new Quaternion(), identity = new Quaternion();
  let largest = 0;
  for (let k = 0; k < count; k += 1) {
    let x = 0, y = 0, z = 0, w = 0;
    for (let j = -radius; j <= radius; j += 1) {
      const q = raw[at(k + j)], weight = radius + 1 - Math.abs(j), sign = q.w < 0 ? -1 : 1;
      x += sign * weight * q.x; y += sign * weight * q.y; z += sign * weight * q.z; w += sign * weight * q.w;
    }
    total.set(x, y, z, w).normalize();
    largest = Math.max(largest, angleOf(total) / DEG);
    const world = target.poseFrame(frames, k), parentWorld = quaternionOf(world[parent], reference);
    parentWorld.invert().multiply(total).multiply(quaternionOf(world[parent])).multiply(frames.rotations[arm] ? new Quaternion().fromArray(frames.rotations[arm], k * 4) : identity).normalize().toArray(frames.rotations[arm], k * 4);
  }
  return largest;
}

/**
 * Katana clearance of the knockdown / get-up clips over BOTH katana layers at once: the shoulder (`arm`: the upper arm turns about the shoulder, the fist, the hand and the blade
 * turn with it) and the wrist (`wrist`: the hand turns about its own joint). The per-key searches of `wristLayer` / `armLayer` pick an unrelated rotation at each key, average the
 * neighbours and fix one layer before the other, which is neither smooth nor safe in a lying pose (the fist often rests against the thigh, where only the shoulder can free it and only
 * the wrist can then free the blade, inside a thin region of rotation pairs). Here the pair of rotations is one path found by Viterbi over per-key candidate lists:
 *  - the candidates of a key are the identity (the donor's own pose), the best of a coarse grid of pairs (`axes` × the layer's `cap`), and the previous key's candidates; every one of
 *    them is polished by a pattern search (steps of 6°, 3°, 1.5° along the three axes of each layer) until the steel clears `margin` from the body capsules (and the guard) and
 *    both blade ends clear `floor`, so a thin feasible region is followed from key to key instead of being missed by a grid;
 *  - each node pays for what is still short (the floor part first answered by a bounded Hips lift, below), for the size of both rotations (the donor's pose is kept wherever it
 *    already clears) and for every degree either rotation changes between keys (steps over JUMP_FREE cost extra), and every transition is also scored at the in-between poses the engine slerps (against the geometry of
 *    the keys around them, with an extra margin); bridge candidates (small steps from the best earlier poses toward the best poses of the key) let a path walk between two clear poses;
 *  - a switch the Viterbi still makes (two clear poses the path cannot walk between) is re-planned: first through a Dijkstra over clear poses at the geometry of the switch (`planBridge`), and when the two poses are
 *    not connected by any clear path inside the caps (the back get-up's sit-up, tick 30) it is left as the one documented hand switch.
 * The Hips lift (`lift.flat` metres in a lying frame, `lift.free` otherwise) is answered per key for the floor term only and is widened and blurred over ±`lift.spread` keys so it never steps.
 * `pin` fixes the first key's pose and lift to the previous clip's last (a get-up's seam); `holdKey` makes the keys from it on one state. Returns the largest applied `{ arm, wrist, lift, last }` (degrees, degrees, metres).
 */
function dpPair(context, frames, count, arm, wrist, holdKey, pin) {
  const { target, grip } = context;
  const id = (name) => target.index.get(`mixamorig:${name}`);
  const armNode = id('RightArm'), handNode = id('RightHand'), hipsNode = id('Hips');
  const tipReach = (KATANA_GRIP.length - KATANA_GRIP.gripFromPommel) * M, pommelAlong = -KATANA_GRIP.gripFromPommel * M;
  const margin = arm.margin / RIG_SCALE, floor = arm.floor / RIG_SCALE, capA = arm.cap * DEG, capW = wrist.cap * DEG;
  const MID_MARGIN = 0.008;
  let marginExtra = 0;
  const weight = { shortfall: arm.shortfallWeight ?? 1500, change: arm.changeWeight ?? 0.5, size: arm.sizeWeight ?? 0.01 };
  const lift = { flat: arm.lift?.flat ?? 0.026, free: arm.lift?.free ?? 0.14, weight: arm.lift?.weight ?? 0.1, spread: arm.lift?.spread ?? 12 };
  const angleOf = (q) => 2 * Math.acos(Math.min(1, Math.abs(q.w)));
  const between = (p, q) => 2 * Math.acos(Math.min(1, Math.abs(p.dot(q))));
  const grid = (cap, axes) => {
    const out = [new Quaternion()];
    for (let i = 0; i < axes; i += 1) {
      const y = 1 - 2 * (i + 0.5) / axes, radius = Math.sqrt(1 - y * y), phi = i * Math.PI * (3 - Math.sqrt(5)), axis = new Vector3(Math.cos(phi) * radius, y, Math.sin(phi) * radius);
      for (const fraction of [0.5, 1]) out.push(new Quaternion().setFromAxisAngle(axis, cap * fraction));
    }
    return out;
  };
  const gridA = grid(capA, arm.axes ?? 10), gridW = grid(capW, wrist.axes ?? 10);
  const geometry = (k, source = frames) => {
    const world = target.poseFrame(source, k), q = quaternionOf(world[handNode]);
    const pivot = new Vector3().setFromMatrixPosition(world[armNode]), wristPos = new Vector3().setFromMatrixPosition(world[handNode]);
    const seat = wristPos.clone().add(grip.palm.clone().applyQuaternion(q)), blade = grip.s.clone().applyQuaternion(q);
    const segments = proxy.map((capsule) => ({ name: capsule.name, a: new Vector3().setFromMatrixPosition(world[capsule.node]), b: capsule.headTip ? new Vector3(0, 0.15, 0).applyMatrix4(world[capsule.node]) : new Vector3().setFromMatrixPosition(world[capsule.toNode]), r: capsule.radius }));
    const flat = Math.abs(torsoFrame(target, world).forward.y) > 0.7 && world[hipsNode].elements[13] < 0.3 / RIG_SCALE;
    return { pivot, wristPos, seat, blade, segments, cap: (flat ? lift.flat : lift.free) / RIG_SCALE };
  };
  const from = new Vector3(), to = new Vector3(), rotated = new Vector3(), direction = new Vector3(), wrist1 = new Vector3(), seat1 = new Vector3(), blade1 = new Vector3();
  /** Shortfalls (rig units) of the steel for the shoulder rotation `qa` followed by the wrist rotation `qw`: `{ body, floor }`. */
  const shortfall = (g, qa, qw) => {
    wrist1.copy(g.wristPos).sub(g.pivot).applyQuaternion(qa).add(g.pivot); seat1.copy(g.seat).sub(g.pivot).applyQuaternion(qa).add(g.pivot); blade1.copy(g.blade).applyQuaternion(qa);
    rotated.copy(seat1).sub(wrist1).applyQuaternion(qw).add(wrist1); direction.copy(blade1).applyQuaternion(qw);
    let min = Infinity;
    for (const segment of g.segments) {
      const { name, r } = segment, moved = /^Right(Arm|ForeArm)$/.test(name);
      const a = moved ? segment.a.clone().sub(g.pivot).applyQuaternion(qa).add(g.pivot) : segment.a, b = moved ? segment.b.clone().sub(g.pivot).applyQuaternion(qa).add(g.pivot) : segment.b;
      const near = NEAR_FIST[name], intervals = near === undefined ? [[pommelAlong, tipReach]] : [[pommelAlong, -near], [near, tipReach]];
      for (const [lo, hi] of intervals) {
        if (hi < lo) continue;
        from.copy(rotated).addScaledVector(direction, lo); to.copy(rotated).addScaledVector(direction, hi);
        min = Math.min(min, segmentSegmentDistance(from, to, a, b) - r);
      }
      if (near === undefined) min = Math.min(min, guardClearance(rotated, direction, a, b, r, KATANA_GRIP, RIG_SCALE));
    }
    const low = Math.min(rotated.y + direction.y * tipReach, rotated.y + direction.y * pommelAlong);
    return { body: Math.max(0, margin + marginExtra - min), floor: Math.max(0, floor - low) };
  };
  /** What a candidate costs before smoothness: the body shortfall, the floor part the Hips lift cannot cover, a small price for the lift, and the size of both rotations. */
  const price = (g, qa, qw) => {
    const s = shortfall(g, qa, qw), covered = Math.min(s.floor, g.cap), unpaid = s.body + Math.max(0, s.floor - g.cap);
    return { unpaid, deficit: covered, cost: weight.shortfall * (unpaid + lift.weight * covered) + weight.size * (angleOf(qa) + angleOf(qw)) / DEG };
  };
  const clamp = (q, cap) => { const angle = angleOf(q); if (angle > cap) q.slerp(new Quaternion(), 1 - cap / angle); return q; };
  const AXES = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
  const polish = (g, candidate) => {
    let current = { qa: candidate.qa.clone(), qw: candidate.qw.clone(), ...price(g, candidate.qa, candidate.qw) };
    for (const [step, iterations] of [[6 * DEG, 24], [3 * DEG, 10], [1.5 * DEG, 8]]) for (let iteration = 0; iteration < iterations && current.unpaid > 0; iteration += 1) {
      let best;
      for (const layer of [0, 1]) for (const axis of AXES) for (const sign of [1, -1]) {
        const turn = new Quaternion().setFromAxisAngle(axis, sign * step), qa = layer === 0 ? clamp(turn.clone().multiply(current.qa), capA) : current.qa, qw = layer === 1 ? clamp(turn.clone().multiply(current.qw), capW) : current.qw;
        const priced = price(g, qa, qw);
        if (priced.cost < (best?.cost ?? current.cost) - 1e-9) best = { qa, qw, ...priced };
      }
      if (!best) break;
      current = best;
    }
    return current;
  };
  const KEEP = arm.keep ?? 18, SEEDS = arm.seeds ?? 8, BRIDGE_FROM = 6, BRIDGE_GOALS = 2, BRIDGE_STEPS = [0.1, 0.25];
  const lists = [];
  let previous = [];
  const geoms = [];
  for (let k = 0; k < count; k += 1) {
    const g = geometry(k), seeds = [{ qa: new Quaternion(), qw: new Quaternion() }];
    if (k === 0 && pin) { geoms.push(g); const kept = [{ qa: pin.qa.clone(), qw: pin.qw.clone(), ...price(g, pin.qa, pin.qw) }]; lists.push(kept); previous = kept; continue; }
    geoms.push(g);
    const coarse = [];
    for (const qa of gridA) for (const qw of gridW) coarse.push({ qa, qw, ...price(g, qa, qw) });
    coarse.sort((x, y) => x.cost - y.cost);
    for (const item of coarse.slice(0, SEEDS)) seeds.push({ qa: item.qa, qw: item.qw });
    for (const item of previous) seeds.push({ qa: item.qa, qw: item.qw });
    // Bridges: a small step from each of the best previous states toward each of the best states of this key, so a path can walk between two feasible islands over several keys instead of jumping.
    for (const from of previous.slice(0, BRIDGE_FROM)) for (const goal of coarse.slice(0, BRIDGE_GOALS)) for (const f of BRIDGE_STEPS) seeds.push({ qa: from.qa.clone().slerp(goal.qa, f), qw: from.qw.clone().slerp(goal.qw, f) });
    const polished = seeds.map((seed) => polish(g, seed)).sort((x, y) => x.cost - y.cost), kept = [];
    for (const item of polished) {
      if (kept.length >= KEEP) break;
      if (kept.every((other) => between(other.qa, item.qa) + between(other.qw, item.qw) > 2 * DEG)) kept.push(item);
    }
    if (!kept.some((item) => angleOf(item.qa) === 0 && angleOf(item.qw) === 0)) kept.push({ qa: new Quaternion(), qw: new Quaternion(), ...price(g, new Quaternion(), new Quaternion()) });
    lists.push(kept); previous = kept;
  }
  // Viterbi over the lists.
  const cost = lists.map((list) => new Float64Array(list.length)), back = lists.map((list) => new Int32Array(list.length));
  lists[0].forEach((item, s) => { cost[0][s] = item.cost; });
  // A transition is also scored at the poses the engine plays between the two keys (slerp at ¼, ½, ¾ of each layer's rotation, against the later key's geometry).
  const middle = new Quaternion(), middleW = new Quaternion();
  const T_MID = [0.25, 0.5, 0.75];
  const mids = (k) => (midCache[k] ??= T_MID.map((t) => geometry(0, interpolateFrame(frames, k - 1 + t))));
  const midCache = [];
  const inBetween = (k, p, s) => {
    let worst = 0;
    for (const [i, t] of T_MID.entries()) for (const g of [mids(k)[i], geoms[k]]) {
      middle.copy(p.qa).slerp(s.qa, t); middleW.copy(p.qw).slerp(s.qw, t);
      marginExtra = MID_MARGIN / RIG_SCALE;
      const priced = price(g, middle, middleW);
      marginExtra = 0;
      worst = Math.max(worst, priced.unpaid);
    }
    return worst;
  };
  // A step between two keys is free up to JUMP_FREE degrees (shoulder + wrist) and then pays JUMP_WEIGHT per degree: the shoulder / wrist walk between two feasible poses over several keys (the bridge seeds) instead of snapping.
  const JUMP_FREE = 12, JUMP_WEIGHT = 20;
  for (let k = 1; k < count; k += 1) lists[k].forEach((item, s) => {
    let best = Infinity, arg = 0;
    lists[k - 1].forEach((other, p) => {
      const turn = (between(other.qa, item.qa) + between(other.qw, item.qw)) / DEG;
      const value = cost[k - 1][p] + weight.change * turn + JUMP_WEIGHT * Math.max(0, turn - JUMP_FREE) + weight.shortfall * inBetween(k, other, item);
      if (value < best) { best = value; arg = p; }
    });
    cost[k][s] = best + item.cost; back[k][s] = arg;
  });
  const path = new Int32Array(count);
  let bestEnd = Infinity;
  cost[count - 1].forEach((value, s) => { if (value < bestEnd) { bestEnd = value; path[count - 1] = s; } });
  for (let k = count - 1; k > 0; k -= 1) path[k - 1] = back[k][path[k]];
  // From `holdKey` on the clip holds one pose (every key identical), so those keys take one state (the first held key's) and, below, one lift.
  const chosenRaw = (k) => lists[holdKey !== undefined && k > holdKey ? holdKey : k][path[holdKey !== undefined && k > holdKey ? holdKey : k]];
  const states = Array.from({ length: count }, (_, k) => chosenRaw(k));
  // A jump between two keys (more than JUMP_FREE degrees: the optimum switched between two feasible poses that the straight slerp between them also keeps feasible) is spread over the keys before it, or failing that after it,
  // along that slerp, 8° per key at most, wherever every key and every in-between pose of the ramp stays clear.
  const RAMP_STEP = 8, RAMP_KEY_TOLERANCE = 0.011 / RIG_SCALE, RAMP_BETWEEN_TOLERANCE = 0.018 / RIG_SCALE;
  const stateAt = (k, qa, qw) => ({ qa, qw, ...price(geoms[k], qa, qw) });
  const rampClear = (list, from, to) => { for (let k = Math.max(1, from); k <= to; k += 1) { if (list[k].unpaid > RAMP_KEY_TOLERANCE || inBetween(k, list[k - 1], list[k]) > RAMP_BETWEEN_TOLERANCE) return false; } return true; };
  // A branch switch between two feasible poses whose straight slerp is not feasible: plan a path through feasible poses at the geometry of the switch (Dijkstra over the neighbouring keys' candidates and some
  // seeded random poses, an edge where the slerp between two poses is feasible at both keys' geometry), then walk it along the keys around the switch.
  const STATIC_TOLERANCE = 0.004 / RIG_SCALE, EDGE_DEGREES = 30, PLAN_SAMPLES = 700;
  const planBridge = (k) => {
    const g0 = geoms[k - 1], g1 = geoms[k], p = states[k - 1], s = states[k], mid = new Quaternion(), midW = new Quaternion();
    const feasible = (qa, qw) => price(g0, qa, qw).unpaid <= STATIC_TOLERANCE && price(g1, qa, qw).unpaid <= STATIC_TOLERANCE;
    const nodes = [p, s];
    for (let j = Math.max(0, k - 3); j <= Math.min(count - 1, k + 2); j += 1) for (const item of lists[j]) if (feasible(item.qa, item.qw)) nodes.push(item);
    let seed = 12345 + k;
    const random = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const randomState = (cap) => { const u = random() * 2 - 1, phi = random() * 2 * Math.PI, r = Math.sqrt(1 - u * u); return new Quaternion().setFromAxisAngle(new Vector3(r * Math.cos(phi), u, r * Math.sin(phi)), random() * cap); };
    const perturb = (q, cap, spread) => { const turned = randomState(spread).multiply(q); return angleOf(turned) > cap ? q.clone() : turned; };
    for (let i = 0; i < PLAN_SAMPLES; i += 1) {
      const origin = nodes[i % 2 === 0 ? Math.floor(random() * nodes.length) : i % 4 === 1 ? 0 : 1];
      const qa = perturb(origin.qa, capA, 18 * DEG), qw = perturb(origin.qw, capW, 18 * DEG);
      if (feasible(qa, qw)) nodes.push({ qa, qw });
    }
    const distance = (x, y) => (between(x.qa, y.qa) + between(x.qw, y.qw)) / DEG;
    const best = new Float64Array(nodes.length).fill(Infinity), from = new Int32Array(nodes.length).fill(-1), done = new Uint8Array(nodes.length);
    best[0] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < nodes.length; i += 1) if (!done[i] && best[i] < Infinity && (u < 0 || best[i] < best[u])) u = i;
      if (u < 0 || u === 1) break;
      done[u] = 1;
      for (let v = 0; v < nodes.length; v += 1) {
        if (done[v]) continue;
        const d = distance(nodes[u], nodes[v]);
        if (d > EDGE_DEGREES || best[u] + d >= best[v]) continue;
        let clear = true;
        for (const t of [0.25, 0.5, 0.75]) { mid.copy(nodes[u].qa).slerp(nodes[v].qa, t); midW.copy(nodes[u].qw).slerp(nodes[v].qw, t); if (!feasible(mid, midW)) { clear = false; break; } }
        if (clear) { best[v] = best[u] + d; from[v] = u; }
      }
    }
    if (!(best[1] < Infinity)) return false;
    const route = [];
    for (let i = 1; i >= 0; i = from[i]) route.unshift(nodes[i]);
    const lengths = [0];
    for (let i = 1; i < route.length; i += 1) lengths.push(lengths[i - 1] + distance(route[i - 1], route[i]));
    const total = lengths.at(-1);
    for (let span = Math.max(4, Math.ceil(total / RAMP_STEP)); span <= 48; span += 2) {
      const start = k - 1 - Math.floor(span / 2), end = start + span;
      if (start < 1 || end > count - 1) break;
      const trial = states.slice();
      for (let j = start + 1; j < end; j += 1) {
        const d = (j - start) / span * total;
        let i = 1; while (i < route.length - 1 && lengths[i] < d) i += 1;
        const f = lengths[i] === lengths[i - 1] ? 1 : (d - lengths[i - 1]) / (lengths[i] - lengths[i - 1]);
        trial[j] = stateAt(j, route[i - 1].qa.clone().slerp(route[i].qa, f), route[i - 1].qw.clone().slerp(route[i].qw, f));
      }
      if (rampClear(trial, start + 1, end)) { for (let j = start + 1; j < end; j += 1) states[j] = trial[j]; return true; }
    }
    return false;
  };
  for (let k = 1; k < count; k += 1) {
    const turn = (between(states[k - 1].qa, states[k].qa) + between(states[k - 1].qw, states[k].qw)) / DEG;
    if (turn <= JUMP_FREE) continue;
    planBridge(k);
  }
  const chosen = (k) => states[k];
  // The Hips lift the chosen path asks for, widened and blurred over ±spread keys so it never drops below what a key needs and never steps.
  const spread = lift.spread, need = Float64Array.from({ length: count }, (_, k) => chosen(k).deficit), widened = new Float64Array(count), lifts = new Float64Array(count);
  for (let k = 1; k < count; k += 1) {
    const p = chosen(k - 1), s = chosen(k);
    for (const [i, t] of T_MID.entries()) {
      middle.copy(p.qa).slerp(s.qa, t); middleW.copy(p.qw).slerp(s.qw, t);
      need[k] = Math.max(need[k], price(mids(k)[i], middle, middleW).deficit);
    }
  }
  for (let k = 0; k < count; k += 1) for (let j = Math.max(0, k - spread); j <= Math.min(count - 1, k + spread); j += 1) widened[k] = Math.max(widened[k], need[j]);
  for (let k = 0; k < count; k += 1) { let sum = 0, weightSum = 0; for (let j = -spread; j <= spread; j += 1) { const i = Math.max(0, Math.min(count - 1, k + j)), w = spread + 1 - Math.abs(j); sum += w * widened[i]; weightSum += w; } lifts[k] = Math.max(need[k], sum / weightSum); }
  // Apply: first the shoulder over the whole clip, then the wrist (its pivot is where the shoulder put it), then the lift.
  const reference = new Quaternion(), identity = new Quaternion(), largest = { arm: 0, wrist: 0, lift: 0 };
  const apply = (node, parent, pick, key) => {
    for (let k = 0; k < count; k += 1) {
      const total = pick(chosen(k));
      largest[key] = Math.max(largest[key], angleOf(total) / DEG);
      const world = target.poseFrame(frames, k), parentWorld = quaternionOf(world[parent], reference);
      parentWorld.invert().multiply(total).multiply(quaternionOf(world[parent])).multiply(frames.rotations[node] ? new Quaternion().fromArray(frames.rotations[node], k * 4) : identity).normalize().toArray(frames.rotations[node], k * 4);
    }
  };
  apply(armNode, target.parent[armNode], (item) => item.qa, 'arm');
  apply(handNode, target.parent[handNode], (item) => item.qw, 'wrist');
  if (holdKey !== undefined) { const held = Math.max(...Array.from(lifts).slice(holdKey)); for (let k = holdKey; k < count; k += 1) lifts[k] = held; }
  // A pinned first key (a get-up's seam) carries exactly the lift the knockdown ended with, so frame 0 is the knockdown's last frame; `last.lift` is what a following clip pins.
  if (pin) lifts[0] = pin.lift ?? 0;
  largest.lift = Math.max(...lifts) * RIG_SCALE;
  largest.last = { qa: chosen(count - 1).qa.clone(), qw: chosen(count - 1).qw.clone(), lift: lifts[count - 1] };
  offsetHips(target, frames, count, (k) => [0, lifts[k], 0]);
  return largest;
}

/** Head-joint vertices farther than this from the skull axis (rig units) are hair, not floor contacts (the same constant is in tests/rendering/vesper-anatomy.test.mjs). */
const HAIR_RADIUS = 0.09;
/**
 * Every skin vertex that a triangle references and that a Foot/ToeBase bone dominates (with `all`: every referenced vertex, every `stride`-th), CPU-skinned on demand; `rest` is
 * the bind pose's lowest height (the floor). `skipHair` leaves out the hair: the Head-dominated vertices farther than `HAIR_RADIUS` (0.09 rig units) from the skull's axis (Head joint to 0.15 up, the
 * capsule the blade clearance fits to the skull) in the bind pose. The hair is skinned rigidly to the head, so a lying Vesper pushes it 15–30 cm through the floor; real hair
 * drapes over the floor, and no pose of the head can change that. The skull itself (inside the radius, with a margin over its widest vertices) rests on the floor.
 */
function soleKit(target, glb, { all = false, stride = 1, skipHair = false } = {}) {
  const { json, bin } = glb, primitive = json.meshes[0].primitives[0], read = (id) => readAccessorAny(json, bin, id);
  const positions = read(primitive.attributes.POSITION), joints = read(primitive.attributes.JOINTS_0), weights = read(primitive.attributes.WEIGHTS_0), inverseBind = read(json.skins[0].inverseBindMatrices), indices = read(primitive.indices);
  const skinJoints = json.skins[0].joints, soles = [], referenced = new Uint8Array(positions.length / 3);
  const headNode = target.index.get('mixamorig:Head'), skullA = new Vector3().setFromMatrixPosition(target.restWorld[headNode]), skullAxis = new Vector3(0, 0.15, 0).applyMatrix4(target.restWorld[headNode]).sub(skullA), point = new Vector3(), nearest = new Vector3();
  const hairOf = (v) => {
    point.set(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
    const along = Math.max(0, Math.min(1, point.clone().sub(skullA).dot(skullAxis) / skullAxis.lengthSq()));
    return point.distanceTo(nearest.copy(skullA).addScaledVector(skullAxis, along)) > HAIR_RADIUS;
  };
  for (const index of indices) referenced[index] = 1;
  for (let v = 0; v < referenced.length; v += 1) {
    if (!referenced[v]) continue;
    let best = 0;
    for (let s = 1; s < 4; s += 1) if (weights[v * 4 + s] > weights[v * 4 + best]) best = s;
    const hair = skipHair && skinJoints[joints[v * 4 + best]] === headNode && hairOf(v);
    if (!hair && v % stride === 0 && (all || /Foot|ToeBase/.test(target.names[skinJoints[joints[v * 4 + best]]]))) soles.push(v);
  }
  const matrices = skinJoints.map(() => new Matrix4()), inverse = new Matrix4();
  let lowestVertex = -1;
  const lowestOf = (world) => {
    skinJoints.forEach((node, j) => matrices[j].multiplyMatrices(world[node], inverse.fromArray(inverseBind, j * 16)));
    let lowest = Infinity;
    for (const v of soles) {
      let y = 0;
      for (let s = 0; s < 4; s += 1) { const w = weights[v * 4 + s]; if (w > 0) { const e = matrices[joints[v * 4 + s]].elements; y += w * (e[1] * positions[v * 3] + e[5] * positions[v * 3 + 1] + e[9] * positions[v * 3 + 2] + e[13]); } }
      if (y < lowest) { lowest = y; lowestVertex = v; }
    }
    return lowest;
  };
  const dominantBone = (v) => { let best = 0; for (let s = 1; s < 4; s += 1) if (weights[v * 4 + s] > weights[v * 4 + best]) best = s; return target.names[skinJoints[joints[v * 4 + best]]].replace('mixamorig:', ''); };
  return { rest: lowestOf(target.restWorld), lowest: (frames, k) => lowestOf(target.poseFrame(frames, k)), lowestBone: (frames, k) => { lowestOf(target.poseFrame(frames, k)); return dominantBone(lowestVertex); } };
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

/* ------------------------------------------------------------------ knockdown / get-up (60 Hz, Mixamo reaction takes) */

const hipsWorld = (target, frames, k) => new Vector3().setFromMatrixPosition(target.poseFrame(frames, k)[target.index.get('mixamorig:Hips')]);
const wrapDegrees = (degrees) => ((((degrees + 180) % 360) + 360) % 360) - 180;
/** A skinned vertex within this height of the floor counts as touching it (rig units; 3 cm). */
const FLOOR_CONTACT = 0.03 / RIG_SCALE;
/** The lowest skinned vertex may dip this far below the floor at most (rig units; ~3.4 mm, inside the brief's 1 cm). */
const FLOOR_MARGIN = 0.002;
/** A body lying flat settles this far into the floor (rig units; 8 mm, inside the brief's 1 cm): Vesper's coat, hair and chest are deep, and this keeps his pelvis (Hips joint) at or under 25 cm. */
const FLOOR_SINK = 0.008 / RIG_SCALE;
/** The knockdown / get-up clips are keyed four times per simulation tick (240 Hz): the engine's joint-wise slerp between two keys is then the pose the katana layers measured, however fast the take turns the hand. Every tick-valued input below (`keys`, `holdFrom`, `blend`, `travel`, `idleFrom`) stays in ticks. */
const KEY_RATE = 240, KPT = KEY_RATE / TICKS_PER_SECOND;

/** Adds a world-space offset `(dx, dy, dz)(k, hipsWorld)` to the Hips. */
function offsetHips(target, frames, count, offset) {
  const hips = target.index.get('mixamorig:Hips'), world = target.restWorld[target.parent[hips]], inverse = world.clone().invert(), p = new Vector3();
  for (let k = 0; k < count; k += 1) {
    p.fromArray(frames.positions[hips], k * 3).applyMatrix4(world);
    const [dx, dy, dz] = offset(k, p);
    p.set(p.x + dx, p.y + dy, p.z + dz).applyMatrix4(inverse).toArray(frames.positions[hips], k * 3);
  }
}

/** Whole-body cross-fade between captured frames (`s` of `other` frame `ko` into frame `k`), shortest-path rotations. */
function blendInto(frames, other, k, ko, s) {
  const a = new Quaternion(), b = new Quaternion();
  frames.rotations.forEach((track, node) => {
    if (!track || !other.rotations[node]) return;
    a.fromArray(track, k * 4).slerp(b.fromArray(other.rotations[node], ko * 4), s).normalize().toArray(track, k * 4);
  });
  frames.positions.forEach((track, node) => {
    if (!track || !other.positions[node]) return;
    for (let c = 0; c < 3; c += 1) track[k * 3 + c] += (other.positions[node][ko * 3 + c] - track[k * 3 + c]) * s;
  });
}

/** A deep copy of rotation/position frame data. */
const cloneFrames = (frames) => ({ rotations: frames.rotations.map((track) => track && track.slice()), positions: frames.positions.map((track) => track && track.slice()) });

/** Monotone-cubic (Fritsch–Carlson) interpolation of one scalar series (no overshoot between keys; zero slope where the series turns). */
function monotoneAt(times, values, tick) {
  const n = times.length;
  let i = 0;
  while (i < n - 2 && tick > times[i + 1]) i += 1;
  const t0 = times[i], t1 = times[i + 1], h = t1 - t0;
  if (h <= 0) return values[i + 1];
  const slope = (a, b) => (values[b] - values[a]) / (times[b] - times[a]);
  const tangent = (j) => {
    if (j === 0 || j === n - 1) return j === 0 ? slope(0, 1) : slope(n - 2, n - 1);
    const before = slope(j - 1, j), after = slope(j, j + 1), hb = times[j] - times[j - 1], ha = times[j + 1] - times[j];
    if (before * after <= 0) return 0;
    const w1 = 2 * ha + hb, w2 = ha + 2 * hb;
    return (w1 + w2) / (w1 / before + w2 / after);
  };
  const s = (tick - t0) / h, s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * values[i] + (s3 - 2 * s2 + s) * h * tangent(i) + (-2 * s3 + 3 * s2) * values[i + 1] + (s3 - s2) * h * tangent(i + 1);
}
/** Monotone time warp through `keys` ([tick, source seconds]); clamped outside the keys, so a held key range plays one constant source time (identical frames). */
function timeWarp(keys) {
  const times = keys.map((key) => key[0]), values = keys.map((key) => key[1]), n = keys.length;
  if (n === 1) return () => values[0];
  return (tick) => (tick <= times[0] ? values[0] : tick >= times[n - 1] ? values[n - 1] : monotoneAt(times, values, tick));
}

/**
 * The torso's own frame from one posed skeleton (independent of any rest convention): `up` = Hips → Neck, `right` = LeftArm → RightArm, `forward` = up × right
 * (the rig faces +X with +Y up and its right +Z, so a standing hero has forward = +X). `forward.y > 0.7` is lying on the back, `< -0.7` on the stomach.
 * `axis` is the heading of Hips → Head in the floor plane (degrees, 0 = +X forward, + toward -Z), the direction a lying body points to.
 */
function torsoFrame(target, world) {
  const at = (name) => new Vector3().setFromMatrixPosition(world[target.index.get(`mixamorig:${name}`)]);
  const hips = at('Hips'), up = at('Neck').sub(hips).normalize(), right = at('RightArm').sub(at('LeftArm')).normalize(), forward = new Vector3().crossVectors(up, right).normalize();
  const head = at('Head').sub(hips);
  return { up, right, forward, axis: Math.atan2(-head.z, head.x) / DEG };
}

/** Turns a retargeted take about the vertical (world yaw `degrees`, + toward the actor's left): every world rotation and the Hips' displacement from its rest position. */
function yawFrames(target, frames, count, degrees) {
  const hips = target.index.get('mixamorig:Hips'), parent = target.parent[hips], turn = new Quaternion().setFromAxisAngle(UP, degrees * DEG);
  const parentQ = target.restWorldQuaternion[parent], parentWorld = target.restWorld[parent], inverse = parentWorld.clone().invert(), rest = target.restWorldPosition[hips];
  const local = new Quaternion(), p = new Vector3();
  for (let k = 0; k < count; k += 1) {
    local.fromArray(frames.rotations[hips], k * 4);
    parentQ.clone().invert().multiply(turn).multiply(parentQ).multiply(local).normalize().toArray(frames.rotations[hips], k * 4);
    p.fromArray(frames.positions[hips], k * 3).applyMatrix4(parentWorld).sub(rest).applyQuaternion(turn).add(rest).applyMatrix4(inverse).toArray(frames.positions[hips], k * 3);
  }
}

/** Scales the Hips' horizontal travel (from the clip's first frame) uniformly so it never exceeds `maxMetres`; the vertical Hips motion is not touched. Returns the scale. */
function limitTravel(target, frames, count, maxMetres) {
  const first = hipsWorld(target, frames, 0), offsets = [];
  let peak = 0;
  for (let k = 0; k < count; k += 1) { const p = hipsWorld(target, frames, k); offsets.push([p.x - first.x, p.z - first.z]); peak = Math.max(peak, Math.hypot(p.x - first.x, p.z - first.z)); }
  const scale = Math.min(1, maxMetres / RIG_SCALE / peak);
  offsetHips(target, frames, count, (k) => [offsets[k][0] * (scale - 1), 0, offsets[k][1] * (scale - 1)]);
  return scale;
}

/**
 * Floor contact of a lying clip, frame by frame, through the Hips height alone (every rotation and the horizontal travel stay the donor's): the lowest skinned
 * vertex of the WHOLE mesh is lifted out of the floor wherever it dips below it, and lowered onto it wherever it is within 3 cm of it (a body resting there)
 * or the torso is flat on the floor. In between (the fall, the flight of a kip-up) the donor's own height is kept, the lift is smoothed so the Hips do not
 * jerk, and the no-penetration lift is re-applied last. Frames from `holdFrom` on rest exactly on the floor and are identical to each other. `first` / `last`
 * (a lift in rig units) pin frame 0 / the last frame to that lift (a seam to the neighbouring clip). `settle` is the lighter finishing pass after the katana layers. Returns the applied lifts (rig units).
 */
function floorCorrect(target, frames, count, kit, { holdFrom = count, first, last, settle = false } = {}) {
  const hips = target.index.get('mixamorig:Hips'), low = [], flat = [];
  for (let k = 0; k < count; k += 1) {
    const world = target.poseFrame(frames, k);
    low.push(kit.lowest(frames, k) - kit.rest);
    flat.push(Math.abs(torsoFrame(target, world).forward.y) > 0.7 && (world[hips].elements[13] - low[k]) < 0.3 / RIG_SCALE);
  }
  const pinnedValue = (k) => (k === 0 && first !== undefined ? first : k === count - 1 && last !== undefined ? last : undefined);
  if (settle) {
    // The finishing pass after the katana layers: the layers measured their floor clearance at the heights floor contact had already given the Hips, so no frame is lowered or re-seated (that
    // would move the blade the layers just cleared); only a vertex that the layers pushed below the floor is lifted out, and the seam frames keep the pin.
    const lifts = low.map((l, k) => pinnedValue(k) ?? Math.max(0, -FLOOR_MARGIN - l));
    offsetHips(target, frames, count, (k) => [0, lifts[k], 0]);
    return lifts;
  }
  const seated = (k) => k >= holdFrom || flat[k] || low[k] < FLOOR_CONTACT;
  let lift = low.map((l, k) => pinnedValue(k) ?? (seated(k) ? -l : 0));
  const smoothed = Math.min(holdFrom, count);
  for (let pass = 0; pass < 24; pass += 1) {
    const next = lift.slice();
    for (let k = 0; k < smoothed; k += 1) if (pinnedValue(k) === undefined) next[k] = (lift[Math.max(0, k - 1)] + 2 * lift[k] + lift[Math.min(count - 1, k + 1)]) / 4;
    lift = next;
  }
  lift = lift.map((value, k) => {
    if (pinnedValue(k) !== undefined) return pinnedValue(k);
    if (k >= holdFrom || flat[k]) return -low[k] - FLOOR_SINK;
    return Math.max(value, -FLOOR_MARGIN - low[k]);
  });
  offsetHips(target, frames, count, (k) => [0, lift[k], 0]);
  return lift;
}

/** Largest rotation difference between two frames (degrees, every rotation track) and the Hips' position difference (millimetres). */
function frameDelta(target, framesA, ka, framesB, kb) {
  const a = new Quaternion(), b = new Quaternion(), hips = target.index.get('mixamorig:Hips');
  let rotation = 0;
  framesA.rotations.forEach((track, node) => { if (track && framesB.rotations[node]) rotation = Math.max(rotation, a.fromArray(track, ka * 4).normalize().angleTo(b.fromArray(framesB.rotations[node], kb * 4).normalize())); });
  const position = new Vector3().fromArray(framesA.positions[hips], ka * 3).distanceTo(new Vector3().fromArray(framesB.positions[hips], kb * 3));
  return { rotationDegrees: rotation / DEG, hipsMillimetres: position * RIG_SCALE * 1e3 };
}

/** Largest per-tick rotation step (degrees) of any joint (between keys one simulation tick apart) from key `from` to the last. */
function maxJointStep(frames, count, from) {
  const a = new Quaternion(), b = new Quaternion();
  let worst = 0;
  for (const track of frames.rotations) if (track) for (let k = Math.max(KPT, from); k < count; k += 1) worst = Math.max(worst, a.fromArray(track, (k - KPT) * 4).normalize().angleTo(b.fromArray(track, k * 4).normalize()));
  return worst / DEG;
}

/** One take part of a knockdown / get-up at 240 Hz (key k = tick k / 4): the toolkit retarget of the part's donor through the monotone time warp of its `keys`, turned by `part.yaw`. */
function sampleReaction(target, rigs, part, count) {
  const donor = rigs[part.source.donor], decoded = donor.decodeAnimation(part.source.animation), warp = timeWarp(part.keys);
  const frames = retargetFrames(target, donor, decoded, count, (k) => warp(k / KPT), Boolean(part.mirror));
  if (part.yaw) yawFrames(target, frames, count, part.yaw);
  return frames;
}

/**
 * A knockdown (`spec.lie`) or get-up (`spec.getup`) at 60 Hz from Mixamo reaction takes, before the katana layers:
 *  - every part is sampled (`keys`: [tick, source seconds], monotone warp; later parts cross-faded in over ±`crossfadeTicks` around their first tick) and the shared
 *    joint guard (`limits`) is applied to the take alone;
 *  - knockdown: the Hips' horizontal travel is scaled to at most `spec.travel.maxMetres`; get-up: the take is turned about the vertical so its lie points the way the
 *    knockdown's held lie does (measured), the Hips' horizontal path is one smooth slide over `getup.travel` ticks from where the knockdown left them onto the standing
 *    XZ, and over `getup.blend` ticks the knockdown's held lie (its last frame before the katana layers, which therefore become the get-up's frame 0) is cross-faded
 *    into the take's own lying frames;
 *  - the whole-mesh lowest vertex is put on the floor through the Hips height alone (`floorCorrect`); the clip keeps a copy of those frames as `pre`.
 */
function buildLying(spec, target, rigs, kit, knock, idle) {
  const count = spec.sim.totalTicks * KPT + 1, first = spec.parts[0];
  if (spec.getup) {
    const donor = rigs[first.source.donor], lie = retargetFrames(target, donor, donor.decodeAnimation(first.source.animation), 1, () => first.keys[0][1], Boolean(first.mirror));
    const donorAxis = torsoFrame(target, target.poseFrame(lie, 0)).axis, knockAxis = torsoFrame(target, target.poseFrame(knock.pre, knock.count - 1)).axis;
    const yaw = Math.round(wrapDegrees(knockAxis - donorAxis) * 10) / 10;
    for (const part of spec.parts) part.yaw = yaw;
  }
  if (spec.lie && spec.parts.length > 1) {
    // A later part (the take whose lying frame the knockdown holds, and the get-up starts from) is turned about the vertical onto the lie the earlier part reaches at its boundary.
    for (let i = 1; i < spec.parts.length; i += 1) {
      const boundary = spec.parts[i].ticks[0] * KPT, axisOf = (part) => torsoFrame(target, target.poseFrame(sampleReaction(target, rigs, part, boundary + 1), boundary)).axis;
      spec.parts[i].yaw = Math.round(wrapDegrees(axisOf(spec.parts[i - 1]) - axisOf({ ...spec.parts[i], yaw: 0 })) * 10) / 10;
    }
  }
  const sampled = spec.parts.map((part) => sampleReaction(target, rigs, part, count)), frames = sampled[0], crossfade = spec.crossfadeTicks ?? 3;
  if (spec.lie) {
    // The lying part's own Hips XZ is where its take started (near the standing spot); carry on from where the fall left the Hips at the boundary instead of snapping back.
    for (let i = 1; i < sampled.length; i += 1) {
      const key = spec.parts[i].ticks[0] * KPT, before = hipsWorld(target, sampled[i - 1], key), after = hipsWorld(target, sampled[i], key);
      offsetHips(target, sampled[i], count, () => [before.x - after.x, 0, before.z - after.z]);
    }
  }
  for (let i = 1; i < sampled.length; i += 1) {
    const boundary = spec.parts[i].ticks[0];
    for (let k = 0; k < count; k += 1) { const s = smooth((k / KPT - (boundary - crossfade)) / (2 * crossfade)); if (s > 0) blendInto(frames, sampled[i], k, k, s); }
  }
  const guard = limitJoints(target, frames, count, spec.limits);
  if (spec.lie) spec.travelScale = Math.round(limitTravel(target, frames, count, spec.travel.maxMetres) * 1e4) / 1e4;
  if (spec.getup) {
    const last = knock.count - 1, stand = hipsWorld(target, idle.frames, 0), home = hipsWorld(target, knock.pre, last), [from, to] = spec.getup.travel;
    offsetHips(target, frames, count, (k, p) => {
      const ramp = smooth((k / KPT - from) / (to - from));
      return [home.x + (stand.x - home.x) * ramp - p.x, 0, home.z + (stand.z - home.z) * ramp - p.z];
    });
    const blend = spec.getup.blend * KPT;
    for (let k = 0; k < blend; k += 1) blendInto(frames, knock.pre, k, last, 1 - smooth(k / blend));
  }
  const lift = floorCorrect(target, frames, count, kit, { holdFrom: spec.lie ? spec.lie.holdFrom * KPT : undefined, first: spec.getup ? 0 : undefined });
  const clip = { spec, frames, times: Float32Array.from({ length: count }, (_, k) => k / KEY_RATE), count, duration: spec.sim.totalTicks / TICKS_PER_SECOND, keys: spec.parts.flatMap((part) => part.keys), contact: undefined, totalTicks: spec.sim.totalTicks, jointNodes: [...target.joints], aim: undefined, guard };
  clip.pre = cloneFrames(frames);
  clip.floorLiftMetres = { min: Math.round(Math.min(...lift) * RIG_SCALE * 1e4) / 1e4, max: Math.round(Math.max(...lift) * RIG_SCALE * 1e4) / 1e4 };
  return clip;
}

/** The take's playback speed against real time per part: its source range and the fastest keyed stretch (source seconds per second). */
function sourceTimeScale(spec) {
  return spec.parts.map((part) => {
    const keys = part.keys, speeds = keys.slice(1).map(([tick, time], i) => (time - keys[i][1]) / ((tick - keys[i][0]) / TICKS_PER_SECOND)).filter((speed) => Number.isFinite(speed));
    return { take: part.source.file.replace(/^.*\//, '').replace(/\.fbx$/, ''), fromSeconds: keys[0][1], toSeconds: keys.at(-1)[1], fastestKeyedStretch: Math.round(Math.max(...speeds) * 100) / 100 };
  });
}

/**
 * The measurements of the brief's acceptance list for one knockdown / get-up clip. Heights are of the Hips joint ("pelvis") in metres; floor clearances are of the
 * lowest skinned vertex of the whole mesh above the floor, in centimetres; a frame "lies" when the torso is flat (|forward.y| > 0.7) and the pelvis is below 30 cm.
 */
function lieReport(spec, target, clip, kit, knock, idle, corrections) {
  const hips = target.index.get('mixamorig:Hips'), rows = [];
  for (let k = 0; k < clip.count; k += 1) {
    const world = target.poseFrame(clip.frames, k), torso = torsoFrame(target, world), p = new Vector3().setFromMatrixPosition(world[hips]);
    rows.push({ k, pelvis: p.y * RIG_SCALE, x: p.x, z: p.z, facing: torso.forward.y, lowest: (kit.lowest(clip.frames, k) - kit.rest) * RIG_SCALE * 100 });
  }
  const round = (value, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;
  const lying = rows.filter((row) => Math.abs(row.facing) > 0.7 && row.pelvis < 0.3), rest = target.restWorldPosition[hips];
  const result = {
    ticks: clip.totalTicks,
    pelvisMetresAtTick30: round(rows[30 * KPT].pelvis),
    lyingFacing: round(rows[spec.lie ? spec.lie.holdFrom * KPT : 0].facing, 2),
    floorLowestVertexCm: { overAllFrames: round(Math.min(...rows.map((row) => row.lowest)), 2), lyingFramesMin: round(Math.min(...lying.map((row) => row.lowest)), 2), lyingFramesMax: round(Math.max(...lying.map((row) => row.lowest)), 2) },
    maxHipsHorizontalOffsetMetres: round(Math.max(...rows.map((row) => Math.hypot(row.x - rest.x, row.z - rest.z))) * RIG_SCALE),
    jointGuard: { jointsCorrected: Object.values(corrections).filter((degrees) => degrees > 0).length, maxCorrectionDegrees: round(Math.max(0, ...Object.values(corrections)), 2) },
    sourceTimeScale: sourceTimeScale(spec),
    ...(clip.floorLiftMetres ? { floorLiftMetres: clip.floorLiftMetres } : {}),
  };
  if (spec.lie) {
    // Ground contact: the first tick at which the pelvis is at or below 25 cm and never again rises above 30 cm (a settle/bounce of a few centimetres is allowed).
    const hold = spec.lie.holdFrom * KPT, groundKey = rows.findIndex((row, k) => row.pelvis <= 0.25 && rows.slice(k).every((later) => later.pelvis <= 0.3)), groundTick = groundKey < 0 ? -1 : groundKey / KPT;
    // "Every key identical": compared component by component on the stored (float32) tracks, not through an angle.
    const component = (tracks, size) => { let worst = 0; for (const track of tracks) if (track) for (let k = hold + 1; k < clip.count; k += 1) for (let c = 0; c < size; c += 1) worst = Math.max(worst, Math.abs(track[k * size + c] - track[hold * size + c])); return worst; };
    const maxRotation = component(clip.frames.rotations, 4), maxHips = component(clip.frames.positions, 3);
    Object.assign(result, {
      groundContactTick: groundTick < 0 ? null : groundTick,
      pelvisMetresAtContactTick: groundTick < 0 ? null : round(rows[groundKey].pelvis),
      pelvisMetresMaxFromContactOn: groundTick < 0 ? null : round(Math.max(...rows.slice(groundKey).map((row) => row.pelvis))),
      pelvisMetresInLie: round(rows[hold].pelvis),
      heldRange: { fromTick: hold / KPT, toTick: (clip.count - 1) / KPT, keyRateHz: KEY_RATE, maxRotationComponentDelta: maxRotation, maxHipsComponentDelta: maxHips, identical: maxRotation === 0 && maxHips === 0 },
      lieHipsOffsetFromStandingMetres: { back: round((rest.x - rows[hold].x) * RIG_SCALE), side: round((rows[hold].z - rest.z) * RIG_SCALE) },
    });
  }
  if (spec.getup) {
    const stand = hipsWorld(target, idle.frames, 0);
    Object.assign(result, {
      seamFromKnockdown: Object.fromEntries(Object.entries(frameDelta(target, clip.frames, 0, knock.frames, knock.count - 1)).map(([key, value]) => [key, round(value, 4)])),
      idleEnd: Object.fromEntries(Object.entries(frameDelta(target, clip.frames, clip.count - 1, idle.frames, 0)).map(([key, value]) => [key, round(value, 4)])),
      endHipsXZOffsetFromStandingMillimetres: round(Math.hypot(rows.at(-1).x - stand.x, rows.at(-1).z - stand.z) * RIG_SCALE * 1e3, 3),
      maxJointStepLastQuarterDegreesPerTick: round(maxJointStep(clip.frames, clip.count, Math.round((clip.count - 1) * 0.75)), 3),
    });
  }
  return result;
}

/** The last quarter of a get-up (`from` = its first tick) slerps, whole body, into `aren-idle`'s first frame: the last frame IS that frame. */
function blendIdle(frames, count, idle, from) {
  for (let k = from; k < count; k += 1) blendInto(frames, idle.frames, k, 0, smooth((k - from) / (count - 1 - from)));
}

/** Hips-only vertical contact of the finished clip (after the katana layers and the joint guard) — the last step, so every pin is bit-exact. */
function settleLying(spec, target, clip, kit, knock, idle) {
  if (spec.getup) {
    // The layers smooth their corrections over ±2 keys, which moves a get-up's frame 0 off the knockdown's identical lie by a hair: the seam frame is the knockdown's own.
    const last = knock.count - 1;
    clip.frames.rotations.forEach((track, node) => { if (track && knock.frames.rotations[node]) for (let c = 0; c < 4; c += 1) track[c] = knock.frames.rotations[node][last * 4 + c]; });
    blendIdle(clip.frames, clip.count, idle, spec.getup.idleFrom * KPT);
  }
  continuity(clip.frames, clip.count);
  const hold = spec.lie ? spec.lie.holdFrom * KPT : undefined;
  const first = spec.getup ? knock.finalLift[knock.count - 1] : undefined;
  clip.finalLift = floorCorrect(target, clip.frames, clip.count, kit, { holdFrom: hold, first, last: spec.getup ? 0 : undefined, settle: true });
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
/** Shoulder layer for captured poses that press the sword fist against the body: the palm-seated tsuka needs the hand lifted off the thigh or torso, which no wrist turn provides. */
const armClear = (margin, floor, maxDegrees, smooth = 2, maxPitch) => ({ clear: { margin, floor, maxDegrees, ...(maxPitch === undefined ? {} : { maxPitch }) }, smooth });
realParts('aren-idle', 240, [{ donor: 'mixamo', file: 'asset-source/mixamo/vesper/melee-idle.fbx', ticks: [0, 240], window: [0, 4] }], { loop: { overlapSeconds: 0.4 }, wrist: carryReach(36, { aim: [[0, 0, -25]], frame: 'chest' }) });
// Walk 4.9 m/s: Mixamo run-with-sword (in place, unmirrored), the full 0.8 s cycle in 30 ticks (4 steps/s). Full wrist-axis sampling and a 5 cm capsule margin clear the fitted katana's guard from the leg-weighted coat; pitch <= -15deg retains the forward-low carry after smoothing.
realParts('aren-walk', 30, [{ donor: 'mixamo', file: 'asset-source/mixamo/vesper/run-with-sword.fbx', ticks: [0, 30], window: [0, 0.8] }], { loop: { overlapSeconds: 0 }, ground: true, arm: { ...armClear(0.08, 0.06, 30, 1, -12), afterWrist: true }, wrist: { ...CARRY_WRIST, maxSwing: 45, maxCorrection: 45, smooth: 1, clear: false, carry: { pitch: -15, aheadMin: 0.25 }, frame: 'chest' } });
// Run 7.5 m/s: the same capture, left/right mirrored, in 22 ticks (5.46 steps/s); a constant Hips lift from the actual skinned sole envelope grounds the cycle (no foot edit); the blade is carried low and forward (pitch <= -12deg).
realParts('aren-run', 22, [{ donor: 'mixamo', file: 'asset-source/mixamo/vesper/run-with-sword.fbx', ticks: [0, 22], window: [0, 0.8], mirror: true }], { loop: { overlapSeconds: 0 }, ground: true, arm: { ...armClear(0.04, 0.06, 25, 1, -11), afterWrist: true }, wrist: { ...CARRY_WRIST, maxSwing: 45, maxCorrection: 45, smooth: 0, clear: false, carry: { pitch: -12 }, frame: 'chest' } });
// The native jump take is five hops in 2.23 s; one hop is keyed onto the engine's phase spans (rising 0-10, apex ~18, falling to 42) so the clip is not five jumps aliased into one.
real('aren-jump', 42, 'b', 'jump', undefined, { keys: [[0, 0], [10, 0.117], [18.5, 0.25], [28.5, 0.4], [42, 0.533]], airborne: true, arm: { ...armClear(0.04, 0.05, 30, 1, -11), afterWrist: true }, wrist: carryReach(45, { smooth: 1, clear: false, carry: { pitch: -15 }, frame: 'chest' }) });
real('aren-hit', 24, 'f', 'hit_to_body_01', [0.12, 0.9], { arm: armClear(0.12, 0.06, 15, 1), wrist: CARRY_WRIST });
// The cheer's arms-up phase starts at 2 s of the take (its first seconds peak at p99.9 1.9 on the native shoulder skin); [2, 7] keeps the arms-up cheer and the lowering.
real('aren-cheer', 300, 'b', 'cheer', [2, 7], { arm: { ...armClear(0.06, 0.05, 30), afterWrist: true }, wrist: CARRY_WRIST });
// Retain the complete captured defeat. The shoulder lifts the palm-seated fist off the thigh; full wrist-axis sampling then rolls the fist clear.
real('aren-defeat', 360, 'b', 'defeat_02', [0, 8.46666622], { arm: armClear(0.02, 0.04, 35), wrist: carryReach(30, { smooth: 1, clear: { maxPush: 30, floor: 0.03, margin: 0.01, axes: 120 } }) });
// Captured full-body sword motion, with separate loaded anticipation, cutting acceleration,
// overshoot and controlled settling. Contact markers remain on the simulation's normalized beats.
const MX = (file) => `asset-source/mixamo/vesper/${file}.fbx`;
const mxPart = (file, ticks, tick, search, extra = {}) => ({ donor: 'mixamo', file: MX(file), mirror: Boolean(extra.mirror), reverse: Boolean(extra.reverse), ticks, strike: { tick, search, kind: extra.kind ?? 'cut', preRate: extra.preRate ?? 1.5, postRate: extra.postRate ?? 1.1, accent: true, ...extra } });
const STRIKE = { pin: { maxVertical: 0.16 }, wrist: CUT_WRIST };
const strikeClip = (clip, ticks, parts, strikes, extra = {}) => {
  const thrusts = parts.filter((part) => part.strike?.kind === 'thrust').map((part) => ({ tick: part.strike.tick, from: part.ticks[0], to: part.ticks[1] }));
  realParts(clip, ticks, parts, { sim: strikes.length === 1 ? { activeTick: strikes[0] } : {}, strikes, ...STRIKE, ...extra,
    wrist: { ...(extra.wrist ?? CUT_WRIST), thrusts } });
};
const mxChain = (strikes, ranges, files) => strikes.map((tick, i) => typeof files[i] === 'function' ? files[i](ranges[i], tick) : mxPart(files[i][0], ranges[i], tick, files[i][1], files[i][2]));
// Cut windows whose retargeted skin stretch stays inside the approved native envelope (measured per donor window by VESPER_AUDIT=deform|…): the inward sword slash (1.17 s) and
// the one-handed sword combo's second (2.00 s, forward-right diagonal) and third (2.97 s, forward-left downward diagonal) cuts. The axe/outward/360 takes peak at 1.9-2.0 on the native shoulder skin.
const SLASHES = {
  inward: ['sword-inward-slash', [1.05, 1.25], { accent: false }], lead: ['sword-inward-slash', [1.05, 1.25], { preRate: 0.3, postRate: 0.8, accent: false }], last: ['sword-inward-slash', [1.05, 1.25], { postRate: 0.3 }], down: ['one-hand-sword-combo', [1.9, 2.1]], pass: ['one-hand-sword-combo', [2.9, 3.05]],
  thrust: ['thrust-slash', [0.7, 0.8], { kind: 'thrust', preRate: 0.45, postRate: 0.45, accent: false }],
  // Short thrusts retain their captured point-first velocity; the surrounding diagonal cuts carry the accents.
  quickThrust: ['thrust-slash', [0.7, 0.8], { kind: 'thrust', preRate: 0.55, postRate: 0.55, accent: false }],
  passEnd: ['one-hand-sword-combo', [2.9, 3.05], { postRate: 0.15, settleHold: true }],
};
/** The inward and outward donors hold the blade sideways at their contact (80-106° off the chest heading); a wrist aim toward the chest heading, ramped in only around those ticks, brings it inside the 140° frontal arc (swing ≤ 30°). */
const frontalWrist = (...ticks) => ({ ...CUT_WRIST, maxSwing: 30, aim: ticks.flatMap((tick) => [[tick - 4, 0, 0, 0], [tick, 0, 0, 1], [tick + 4, 0, 0, 0]]), frame: 'chest' });
/** Where the wrist's 30° budget leaves the sideways donor blade just outside the frontal arc, the shoulder turns it a few degrees further toward the chest heading. */
const frontalArm = (...ticks) => ({ frontal: { ticks, degrees: 12 }, smooth: 0 });
// Four distinct commitments: loaded draw, return diagonal, rising cut and low through-cut.
strikeClip('vesper-iai-1', 18, [
  { donor: 'mixamo', file: MX('draw-sword-1'), ticks: [0, 2], window: [0, 0.1] },
  mxPart(SLASHES.inward[0], [2, 18], 6, SLASHES.inward[1], { preRate: 1.5, postRate: 1.1 }),
], [6], { crossfadeTicks: 3, arm: armClear(0.02, 0.04, 20, 2), wrist: frontalWrist(6) });
strikeClip('vesper-iai-2', 18, [mxPart('one-hand-sword-combo', [0, 18], 6, [2.9, 3.05], { preRate: 1.35, postRate: 0.45 })], [6], { arm: armClear(0.04, 0.05, 20, 1) });
strikeClip('vesper-iai-3', 22, [mxPart('sword-outward-slash', [0, 22], 8, [0.85, 0.9], { preRate: 0.8, postRate: 0.45 })], [8], { arm: frontalArm(8), wrist: frontalWrist(8) });
strikeClip('vesper-iai-4', 30, [mxPart('sword-inward-slash', [0, 30], 10, [1.05, 1.25], { preRate: 0.8, postRate: 0.8, settleHold: true })], [10], { arm: frontalArm(10), wrist: frontalWrist(10) });
strikeClip('vesper-thousand-cuts', 72, mxChain([8, 18, 28, 38, 48, 58, 66], [[0, 13], [13, 23], [23, 33], [33, 43], [43, 53], [53, 62], [62, 72]],
  [SLASHES.lead, SLASHES.down, SLASHES.pass, SLASHES.inward, SLASHES.down, SLASHES.quickThrust, SLASHES.pass]), [8, 18, 28, 38, 48, 58, 66], { arm: { ...frontalArm(8, 38), clear: { margin: 0.02, floor: 0.04, maxDegrees: 20 }, thrusts: [{ tick: 58, from: 53, to: 62, degrees: 8 }] }, wrist: frontalWrist(8, 38) });
// The down-cut -> diagonal-cut junction at tick 30 needs the existing blend over +/-4 ticks: +/-3 concentrates the captured forearm/hand turns into keys 28->30 and bows the intervening blade path by 16.3deg even before the wrist layer. This blends actual donor poses; all contact ticks and source rates stay unchanged.
strikeClip('vesper-requiem', 120, [
  ...mxChain([12, 24, 36, 48, 60, 72, 84], [[0, 18], [18, 30], [30, 42], [42, 54], [54, 66], [66, 78], [78, 120]],
    [SLASHES.lead, SLASHES.down, SLASHES.pass, SLASHES.inward, SLASHES.down, SLASHES.thrust, SLASHES.passEnd]),
], [12, 24, 36, 48, 60, 72, 84, 110], { crossfadeTicks: 4, arm: { ...frontalArm(12, 48), thrusts: [{ tick: 72, from: 66, to: 78, degrees: 4 }] }, wrist: frontalWrist(12, 48) });
strikeClip('vesper-severing-shadow', 36, [mxPart('one-hand-sword-combo', [0, 36], 12, [2.9, 3.05], { preRate: 0.5, postRate: 0.28, settleHold: true })], [12], { arm: armClear(0.04, 0.05, 20, 1) });
strikeClip('vesper-shadow-step', 26, [mxPart(SLASHES.thrust[0], [0, 26], 8, SLASHES.thrust[1], { ...SLASHES.thrust[2], preRate: 0.6, postRate: 0.5, accent: true, settleHold: true })], [8], { arm: { thrusts: [{ tick: 8, from: 0, to: 26, degrees: 4 }], smooth: 0 }, wrist: CARRY_WRIST });
// The cast proper between the initial knee-lift step and the hip-turning recovery. The broader [1.1, 2.9] window includes both knee-sign failures; this continuous captured window retains the spell gesture without either.
real('vesper-cleanse', 108, 'd', 'cast_a_spell', [1.1333333, 2.6333333], { arm: armClear(0.14, 0.06, 35, 1), wrist: { ...CARRY_WRIST, maxSwing: 30, smooth: 1, clear: { maxPush: 30, floor: 0.05, margin: 0.08, axes: 120 } } });
// Loaded blade and a summoning hand-sign: charge silhouettes are no longer two melee-idle loops.
realParts('vesper-cuts-charge', 60, [{ donor: 'mixamo', file: MX('sheath-sword-1'), ticks: [0, 60], keys: [[0, 0.1], [30, 0.22], [60, 0.1]] }], { loop: { overlapSeconds: 0 }, pin: { maxVertical: 0.12 }, arm: armClear(0.05, 0.06, 30, 1), wrist: carryReach(45, { smooth: 1, clear: { maxPush: 45, floor: 0.05, margin: 0.04, axes: 120 } }) });
realParts('vesper-shade-charge', 60, [{ donor: 'd', animation: 'cast_a_spell', ticks: [0, 60], keys: [[0, 1.5], [30, 1.63], [60, 1.5]] }], { loop: { overlapSeconds: 0 }, pin: { maxVertical: 0.12 }, arm: armClear(0.14, 0.06, 35, 1), wrist: CARRY_WRIST });
// The left-hand release is compressed into a knife flick; Shade instead commands a spectre with a captured casting gesture.
const THROW_WRIST = { ...CARRY_WRIST, maxSwing: 30, maxCorrection: 30, smooth: 0, clear: { maxPush: 30, floor: 0.07, margin: 0.04 } };
realParts('vesper-kunai-fan', 24, [{ donor: 'e', animation: 'pitch_baseball', mirror: true, ticks: [0, 24], keys: [[0, 1.72], [6, 1.75], [9, 1.833], [12, 1.93], [24, 1.97]] }], { sim: { activeTick: 9 }, arm: armClear(0.05, 0.08, 30, 1), wrist: THROW_WRIST });
realParts('vesper-shade-swap', 40, [{ donor: 'd', animation: 'cast_a_spell', ticks: [0, 40], keys: [[0, 1.3], [5, 1.4], [8, 1.6333333], [16, 1.9], [29, 2.0], [30, 2.12], [40, 2.2]] }], { sim: { activeTick: 8 }, pin: { maxVertical: 0.12 }, arm: armClear(0.14, 0.06, 35, 1), wrist: { ...CARRY_WRIST, maxSwing: 30, clear: { maxPush: 30, floor: 0.05, margin: 0.08, axes: 120 } } });
realParts('vesper-mist-blink', 24, [{ donor: 'mixamo', file: MX('idle-to-sprint'), ticks: [0, 24], keys: [[0, 0.1], [5, 0.14], [10, 0.3], [16, 0.45], [24, 0.5]] }], { airborne: true, pin: { maxVertical: 0.12 }, arm: { ...armClear(0.13, 0.05, 25, 1), afterWrist: true }, wrist: carryReach(45, { aim: [[0, 0, -30]], frame: 'chest' }) });
// Second jump ("treading the wind"): two air steps, a somersault tuck, open-out and a soft landing, in place.
compose('aren-air-step', 60, [
  { donor: 'd', animation: 'run_upstairs', window: [0, 0.8], ticks: [0, 60] },
  { donor: 'd', animation: 'flip', keys: [[0, 0.9], [26, 1.2], [38, 1.9], [60, 3.4]], ticks: [14, 60] },
  { donor: 'b', animation: 'jump', keys: [[40, 0.8], [49, 0.967], [60, 1.067]], ticks: [40, 60] },
], { limits: LOCOMOTION, airborne: true, crossfadeTicks: 4, pin: { maxVertical: 0.08 }, arm: { ...armClear(0.06, 0.05, 25, 1), afterWrist: true }, wrist: carryReach(45, { smooth: 1, aim: [[0, 45, -20]], frame: 'chest' }) });

/* ------------------------------------------------------------------ knockdown / get-up (aren-knockdown, aren-knockdown-forward, aren-getup, aren-getup-forward) */
// Real motion only (shared Mixamo reaction takes, retargeted like every other Mixamo clip of this hero), 60 Hz keys (one per simulation tick): `buildLying` samples the
// takes, keeps their vertical Hips motion, limits only the Hips' horizontal travel, puts the WHOLE mesh's lowest vertex on the floor through the Hips height, and holds
// the knockdowns' lie exactly from tick 48. The katana layers below then keep the steel seated in the fitted fist, clear of the body, the arms and the floor.
const R = (file) => `asset-source/mixamo/reactions/${file}.fbx`;
const HOLD_FROM = 48, TRAVEL_METRES = 0.62;
/**
 * Katana layers of the four clips (240 Hz keys, `dpPair`): the shoulder and the wrist are chosen together, so the steel stays ≥ 12 mm from the body capsules and both blade ends ≥ 30 mm above the floor
 * (the gates are 0 and 20 mm). The budgets are the carried-sword ones (shoulder ≤ 35°, wrist ≤ 45°) for the knockdowns and the stomach get-up.
 * EXCEPTION, `aren-getup` only (approved by the coordinator; the per-clip limits are `GETUP_BACK_CAPS` in tests/rendering/vesper-anatomy.test.mjs): the back get-up's sit-up holds the katana fist about 7 cm off
 * the floor with the donor's blade pointing 40° down through the floor and the right leg, which no pair of ≤ 45° / ≤ 35° corrections clears; it gets a first pass of shoulder ≤ 50° / wrist ≤ 75° plus a
 * second, measured refinement pass of ≤ 10° / ≤ 15° (total ≤ 60° / ≤ 90°), still inside the Hand / Arm joint tables.
 */
const REACT_MARGIN = 0.012, REACT_FLOOR = 0.03;
const REACT_ARM = { dp: true, cap: 35, axes: 10, margin: REACT_MARGIN, floor: REACT_FLOOR, changeWeight: 1, fps: KEY_RATE };
const REACT_WRIST = { dp: true, cap: 45, axes: 10, margin: REACT_MARGIN, floor: REACT_FLOOR, fps: KEY_RATE };
const GETUP_BACK_ARM = { ...REACT_ARM, cap: 50, refine: { arm: 10, wrist: 15, margin: 0.03, floor: 0.03 } }, GETUP_BACK_WRIST = { ...REACT_WRIST, cap: 75 };
const lieClip = (clip, ticks, parts, extra) => realParts(clip, ticks, parts.map(({ take, ...rest }) => ({ donor: 'mixamo', file: R(take), ...rest })), { arm: REACT_ARM, wrist: REACT_WRIST, ...extra });
lieClip('aren-knockdown', 90, [
  { take: 'react-backward', ticks: [0, 44], keys: [[0, 1.55], [30, 2.3], [44, 2.7]] },
  { take: 'getting-up-back', mirror: true, ticks: [44, 90], keys: [[44, 3.05], [HOLD_FROM, 3.05], [90, 3.05]] },
], { lie: { holdFrom: HOLD_FROM }, travel: { maxMetres: TRAVEL_METRES } });
lieClip('aren-knockdown-forward', 90, [{ take: 'fall-flat-hit-back', ticks: [0, 90], keys: [[0, 0.25], [30, 1.0], [HOLD_FROM, 1.95], [90, 1.95]] }], { lie: { holdFrom: HOLD_FROM }, travel: { maxMetres: TRAVEL_METRES } });
lieClip('aren-getup', 66, [{ take: 'getting-up-back', mirror: true, ticks: [0, 66], keys: [[0, 3.05], [8, 3.3], [26, 4.3], [42, 5.0], [58, 5.85], [66, 5.95]] }],
  { getup: { from: 'aren-knockdown', blend: 8, travel: [26, 56], idleFrom: 50 }, arm: GETUP_BACK_ARM, wrist: GETUP_BACK_WRIST });
lieClip('aren-getup-forward', 66, [
  { take: 'getting-up-stomach', ticks: [0, 30], keys: [[0, 2.35], [8, 2.45], [28, 3.2]] },
  { take: 'getting-up-stomach', ticks: [28, 66], keys: [[28, 4.2], [54, 5.4], [66, 5.6]] },
], { getup: { from: 'aren-knockdown-forward', blend: 8, travel: [8, 46], idleFrom: 50 } });


for (const spec of specs) for (const layer of ['arm', 'wrist']) if (spec[layer]) spec[layer] = { ...spec[layer], loop: Boolean(spec.loop) };

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
/** Every 3rd vertex of the whole mesh (not only the soles): the floor contact of the lying clips. Built on first use. */
let wholeBody;
const bodyKit = () => (wholeBody ??= soleKit(target, baseGlb, { all: true, stride: 3, skipHair: true }));
const context = { target, grip };
// Authoring aids for the knockdown / get-up takes. `--lie-timeline=<take>` prints, every 1/30 s of the retargeted take: Hips x / height / z (m, from the standing XZ),
// the torso's forward.y (> 0.7 on the back, < -0.7 on the stomach), the lie axis, the head height and the lowest skinned vertex above the floor (cm).
// `--probe=<take>:<from s>:<to s>[:ticks]` writes /tmp/vesper-probe.glb with that stretch of the take (60 Hz, no katana layers, no floor fix) as clip `probe`.
if (option('lie-timeline') || option('probe')) {
  const [name, from, to, ticks] = (option('probe') ?? option('lie-timeline')).split(':');
  const loaded = await loadMixamoDonor(root + R(name), { target });
  rigs.probe = loaded.rig;
  if (option('probe')) {
    const length = Number(ticks ?? Math.round((Number(to) - Number(from)) * TICKS_PER_SECOND));
    const frames = sampleReaction(target, rigs, { source: { donor: 'probe', animation: loaded.animation }, keys: [[0, Number(from)], [length, Number(to)]] }, length * KPT + 1);
    const probe = { spec: { clip: 'probe' }, frames, times: Float32Array.from({ length: length * KPT + 1 }, (_, k) => k / KEY_RATE), count: length * KPT + 1, duration: length / TICKS_PER_SECOND, keys: [], contact: undefined, totalTicks: length, jointNodes: [...target.joints], aim: undefined, guard: {} };
    const glb = parseGlb(appendClips(base, [probe])), index = glb.json.nodes.length;
    glb.json.nodes.push({ name: 'VesperForward', rotation: [0, -Math.SQRT1_2, 0, Math.SQRT1_2], children: glb.json.scenes[0].nodes });
    glb.json.scenes[0].nodes = [index];
    await writeFile('/tmp/vesper-probe.glb', encodeGlb(glb.json, glb.bin));
    process.exit(0);
  }
  const decoded = loaded.rig.decodeAnimation(loaded.animation), n = Math.round(decoded.duration * 30) + 1;
  const frames = retargetFrames(target, loaded.rig, decoded, n, (k) => k / 30, args.includes('--mirror')), kit = bodyKit(), hipsNode = target.index.get('mixamorig:Hips'), handNode = target.index.get('mixamorig:RightHand');
  const tipReach = (KATANA_GRIP.length - KATANA_GRIP.gripFromPommel) * M, pommelAlong = -KATANA_GRIP.gripFromPommel * M;
  console.log(`${name}${args.includes('--mirror') ? ' (mirrored)' : ''} ${decoded.duration.toFixed(3)} s · floor (bind lowest vertex) ${(kit.rest * RIG_SCALE).toFixed(4)} m · t hipsX hipsY hipsZ (m) torsoFwdY lieAxis(deg) headY(m) lowestVertex(cm) bone | blade pitch(deg) kissakiY pommelY (m, body on the floor)`);
  for (let k = 0; k < n; k += 1) {
    const world = target.poseFrame(frames, k), p = new Vector3().setFromMatrixPosition(world[hipsNode]), head = new Vector3().setFromMatrixPosition(world[target.index.get('mixamorig:Head')]), torso = torsoFrame(target, world);
    const q = quaternionOf(world[handNode]), blade = grip.s.clone().applyQuaternion(q), seat = new Vector3().setFromMatrixPosition(world[handNode]).add(grip.palm.clone().applyQuaternion(q)), low = kit.lowest(frames, k) - kit.rest;
    console.log((k / 30).toFixed(2), ((p.x - target.restWorldPosition[hipsNode].x) * RIG_SCALE).toFixed(2), (p.y * RIG_SCALE).toFixed(2), ((p.z - target.restWorldPosition[hipsNode].z) * RIG_SCALE).toFixed(2), torso.forward.y.toFixed(2), torso.axis.toFixed(0), (head.y * RIG_SCALE).toFixed(2), (low * RIG_SCALE * 100).toFixed(1), kit.lowestBone(frames, k), '|', Math.round(Math.asin(blade.y) / DEG), ((seat.y + blade.y * tipReach - low) * RIG_SCALE).toFixed(2), ((seat.y + blade.y * pommelAlong - low) * RIG_SCALE).toFixed(2));
  }
  process.exit(0);
}
// `--splice-scan=<take>:<a from>:<a to>:<b from>:<b to>[:m]` (0.1 s grid): for every pair (a, b) the lowest kissaki height (m, body on the floor) over the cross-fade from the pose at `a` into the one at `b`,
// to find a splice whose blend keeps the carried blade off the floor (`m` mirrors the take).
if (option('splice-scan')) {
  const [name, a0, a1, b0, b1, flag] = option('splice-scan').split(':'), loaded = await loadMixamoDonor(root + R(name), { target }), decoded = loaded.rig.decodeAnimation(loaded.animation), kit = bodyKit();
  const handNode = target.index.get('mixamorig:RightHand'), reach = (KATANA_GRIP.length - KATANA_GRIP.gripFromPommel) * M, back = -KATANA_GRIP.gripFromPommel * M;
  const pose = (time) => retargetFrames(target, loaded.rig, decoded, 1, () => time, flag === 'm');
  // The blade rotation (degrees) a pose needs to lift both ends of the steel 2.5 cm off the floor about the fist: the pitch it has against the pitch the fist height allows.
  const measure = (frames) => {
    const w = target.poseFrame(frames, 0), q = quaternionOf(w[handNode]), b = grip.s.clone().applyQuaternion(q), seat = new Vector3().setFromMatrixPosition(w[handNode]).add(grip.palm.clone().applyQuaternion(q)), low = kit.lowest(frames, 0) - kit.rest;
    const fist = seat.y - low, floor = 0.025 / RIG_SCALE, pitch = Math.asin(Math.max(-1, Math.min(1, b.y)));
    const tipPitch = Math.asin(Math.max(-1, Math.min(1, (floor - fist) / reach))), pommelPitch = Math.asin(Math.max(-1, Math.min(1, (fist - floor) / -back)));
    return Math.max(0, (tipPitch - pitch) / DEG, (pitch - pommelPitch) / DEG);
  };
  const bs = []; for (let b = Number(b0); b <= Number(b1) + 1e-9; b += 0.1) bs.push(b);
  console.log('rows: a, columns: b =', bs.map((b) => b.toFixed(1)).join(' '));
  for (let a = Number(a0); a <= Number(a1) + 1e-9; a += 0.1) {
    const cells = bs.map((b) => {
      let worst = 0;
      for (const s of [0, 0.2, 0.4, 0.5, 0.6, 0.8, 1]) { const mix = cloneFrames(pose(a)); blendInto(mix, pose(b), 0, 0, s); worst = Math.max(worst, measure(mix)); }
      return worst.toFixed(0).padStart(4);
    });
    console.log(a.toFixed(1), cells.join(' '));
  }
  process.exit(0);
}
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
    const start = clampTime(pick.time - sign * preRate * (tick - from) / TICKS_PER_SECOND);
    const finish = clampTime(pick.time + sign * postRate * (to - tick) / TICKS_PER_SECOND);
    if (part.strike.accent) {
      const windup = Math.max(from, tick - 4), overshoot = Math.min(to, tick + 4);
      const before = pick.time - sign * Math.abs(pick.time - start) * 0.45;
      const after = pick.time + sign * Math.abs(finish - pick.time) * 0.35;
      part.keys = [[from, start], ...(windup > from ? [[windup, before]] : []), [tick, pick.time],
        ...(overshoot < to ? [[overshoot, after]] : []),
        ...(part.strike.settleHold && to - overshoot > 8 ? [[Math.min(to - 2, tick + 10), finish]] : []), [to, finish]];
    } else part.keys = [[from, start], [tick, pick.time], [to, finish]];
    part.strike.resolved = { kind, reversed: Boolean(part.reverse), sourceSeconds: pick.time, donorTipMetresPerSecond: pick.speed, donorContactAngle: pick.lead, contactWithinMax: Boolean(best), preRate, postRate, accent: Boolean(part.strike.accent) };
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
// A get-up is built from its knockdown's held lie and ends in the idle, so `--only` pulls those two clips in.
const wanted = only && new Set(only.flatMap((name) => { const spec = specs.find((item) => item.clip === name); return spec?.getup ? [name, spec.getup.from, 'aren-idle'] : [name]; }));
const selected = specs.filter((item) => !wanted || wanted.has(item.clip));
const mixamoProvenance = await resolveMixamoSources(selected, rigs, root);
resolveStrikes(selected);
const proxy = buildBodyProxy(baseGlb, target);
/** Separate torso/head/leg proxy metrics are supplemental; every capsule still gates acceptance. */
const ARM_CAPSULES = /Arm|Hand/;
const layerDeform = (stage, built) => { const d = skinDeformationReport(appendClips(base, [built]), built.spec.clip); console.error('layer', built.spec.clip, stage, 'p99', d.p99, 'p999', d.p999, 'max', d.max, d.worstBone, d.worstSeconds); };
for (const spec of selected) {
  if (process.env.VESPER_LAYERS && !spec.lie && !spec.getup) {
    // Layer-causal diagnosis: skin deformation of the raw retarget, after the toolkit limits, after the wrist layer and after the final limits/continuity.
    const raw = buildClip({ ...spec, limits: null }, rigs); if (spec.pin) pinHips(target, raw.frames, raw.count, spec.pin.maxVertical); layerDeform('raw', raw);
    const limited = buildClip(spec, rigs); if (spec.pin) pinHips(target, limited.frames, limited.count, spec.pin.maxVertical); layerDeform('limits', limited);
    if (spec.arm && !spec.arm.afterWrist) { armLayer(context, limited.frames, limited.count, spec.arm); layerDeform('arm', limited); }
    if (spec.wrist) { wristLayer(context, limited.frames, limited.count, spec.wrist); layerDeform('wrist', limited); }
    if (spec.arm?.afterWrist) { armLayer(context, limited.frames, limited.count, spec.arm); layerDeform('arm', limited); }
  }
  const lying = Boolean(spec.lie || spec.getup), knock = spec.getup ? clips.find((item) => item.spec.clip === spec.getup.from) : undefined, idle = spec.getup ? clips.find((item) => item.spec.clip === 'aren-idle') : undefined;
  const clip = lying ? buildLying(spec, target, rigs, bodyKit(), knock, idle) : buildClip(spec, rigs);
  const limits = spec.limits ?? COMBAT_LIMITS;
  if (spec.pin) pinHips(target, clip.frames, clip.count, spec.pin.maxVertical);
  // Constant world-Y lift of the Hips (rig units). Used by the knockdown clips so the lying donor pose (which the captured Mixamo take settles
  // with the katana fist almost on the floor) clears the wrist layer's floor guard; the held lie still reads as the body on the floor (≤ 2 cm above it).
  // The parent of the Hips is the root node, which only carries a rest yaw on Mixamo-retargeted rigs, so a world +Y shift is a parent-local +Y shift too.
  if (spec.hipsLift) {
    const hipsNode = target.index.get('mixamorig:Hips'), track = clip.frames.positions[hipsNode], shift = spec.hipsLift / RIG_SCALE;
    for (let k = 0; k < clip.count; k += 1) track[k * 3 + 1] += shift;
  }
  // The knockdown / get-up clips clear the katana with both layers at once (`dpPair`); the other clips keep the per-key layers (a carried blade the wrist re-aims is cleared by the shoulder afterwards).
  let armApplied, wristApplied;
  if (spec.arm?.dp) {
    const applied = dpPair(context, clip.frames, clip.count, spec.arm, spec.wrist, spec.lie ? spec.lie.holdFrom * KPT : undefined, spec.getup ? knock.dpLast : undefined);
    clip.dpLast = applied.last;
    armApplied = applied.arm; wristApplied = { swing: applied.wrist };
    if (spec.arm.refine && spec.getup) {
      // A second, small pass on the corrected frames (their displayed in-between poses are now measured, not modelled): the shoulder / wrist budgets of the passes add up to the clip's caps.
      const { arm: armCap, wrist: wristCap, margin, floor } = spec.arm.refine, identity = { qa: new Quaternion(), qw: new Quaternion() };
      const again = dpPair(context, clip.frames, clip.count, { ...spec.arm, cap: armCap, margin: margin ?? spec.arm.margin, floor: floor ?? spec.arm.floor }, { ...spec.wrist, cap: wristCap }, undefined, identity);
      armApplied += again.arm; wristApplied = { swing: applied.wrist + again.wrist };
    }
  } else {
    armApplied = spec.arm && !spec.arm.afterWrist ? armLayer(context, clip.frames, clip.count, spec.arm) : undefined;
    wristApplied = spec.wrist ? wristLayer(context, clip.frames, clip.count, spec.wrist) : undefined;
    if (spec.arm?.afterWrist) armApplied = armLayer(context, clip.frames, clip.count, spec.arm);
  }
  const corrections = limitJoints(target, clip.frames, clip.count, limits);
  continuity(clip.frames, clip.count);
  // The knockdown / get-up clips end with the idle blend (get-ups) and the final Hips-only floor contact, after the katana layers and the joint guard.
  if (lying) settleLying(spec, target, clip, bodyKit(), knock, idle);
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
    ...(armApplied !== undefined ? { armMaxCorrectionDegrees: Math.round(armApplied * 10) / 10 } : {}),
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
    ...(lying ? { lie: lieReport(spec, target, clip, bodyKit(), knock, idle, corrections) } : {}),
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
  // `--only` authoring aid: the clips with the katana prism seated in the fitted fist, for `render-clip-preview.mjs` (the delivered GLB is not touched).
  await writeFile('/tmp/vesper-only.glb', await withKatana(bytes));
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
  // Retain the already-approved back-get-up hand release (GETUP_BACK_CAPS in vesper-anatomy.test.mjs), not an offensive wrist allowance.
  const wristMaximum = spec.clip === 'aren-getup' ? 90 : spec.strikes || spec.clip === 'vesper-kunai-fan' ? 30 : 45;
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
  animationRework: { reason: 'Moonshade pressure choreography: captured loaded windups, accelerated contacts, carried overshoot and controlled settles; distinct sword-charge and summoning poses, knife flick and Shade command. Existing native skeleton, skin/clearance gates and normalized hit markers retained.', newTripoTasks: 0, newCredits: 0 },
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
    ['knockdown-side', 'side', ['aren-knockdown', 'aren-knockdown-forward', 'aren-getup', 'aren-getup-forward'], 10],
    ['knockdown-front', 'front', ['aren-knockdown', 'aren-knockdown-forward', 'aren-getup', 'aren-getup-forward'], 10],
    ['knockdown-iso', 'iso', ['aren-knockdown', 'aren-knockdown-forward', 'aren-getup', 'aren-getup-forward'], 10],
  ];
  for (const view of ['front', 'side', 'iso']) sheets.push([`contacts-${view}`, view, contactClips.map((clip) => clip.spec.clip), 1]);
  for (const [name, view, names, frames] of sheets) {
    execFileSync('node', ['scripts/assets/render-clip-preview.mjs', armedPath, `${root}${output}/previews/${name}.png`, `--clips=${names.join(',')}`, `--frames=${frames}`, `--view=${view}`, '--cell=240'], { cwd: root, stdio: 'ignore' });
  }
  await rm(armedPath);
}
