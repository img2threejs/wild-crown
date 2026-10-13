import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { parseGlb, encodeGlb } from './import-aren-animation-set.mjs';
import { readAccessorAny } from './creature-rig-kit.mjs';
import { Rig, buildClip, appendClips, limitJoints, jointExcursions, skinDeformationReport, JOINT_LIMITS, COMBAT_LIMITS, FPS } from './retarget-aren-tripo-clips.mjs';

/**
 * Authors Yara's Heartroot clip set on her native 23-joint Tripo skeleton.
 *
 * Bodies come from Tripo preset donors (retargeted by the shared toolkit, anatomically limited by `limitJoints`); the staff arm is then
 * authored by `armLayer`: a two-bone solve of the right arm to a hand target plus a staff direction, so the staff is held in the fixed fist of
 * `src/rendering/NativeHandGrip.ts` (no wrist twisting at runtime) and aims where the choreography wants it. A second solve can seat the left
 * palm on the shaft for the two-hand actions.
 *
 * Run: `node scripts/assets/author-yara-hero-clips.mjs [--previews] [--report] [--sync-manifest[=path]]`. Deterministic; reruns are byte-identical.
 * Without `--sync-manifest` nothing under asset-source/playtests/ is touched: the entry is only emitted as `manifest-entry.json`.
 */
const root = fileURLToPath(new URL('../../', import.meta.url));
const DEG = Math.PI / 180;
const TICKS_PER_SECOND = 60;
const rigPath = 'asset-source/generated/actor-yara-mixamo-rig-01/tripo-out/actor-yara-mixamo-rig-01-5e75ddbe/model.glb';
const sources = {
  a: 'asset-source/generated/actor-yara-hero-anim-a-01/tripo-out/actor-yara-hero-anim-a-01-579a27cd/model.glb',
  b: 'asset-source/generated/actor-yara-hero-anim-b-01/tripo-out/actor-yara-hero-anim-b-01-61519f46/model.glb',
  c: 'asset-source/generated/actor-yara-hero-anim-c-01/tripo-out/actor-yara-hero-anim-c-01-75b3e41f/model.glb',
  d: 'asset-source/generated/actor-yara-hero-anim-d-01/tripo-out/actor-yara-hero-anim-d-01-851be4be/model.glb',
  e: 'asset-source/generated/actor-yara-hero-anim-e-01/tripo-out/actor-yara-hero-anim-e-01-13b1a6ab/model.glb',
};
const tasks = {
  rig: '5e75ddbe-dbd3-4f5a-93d0-fac15ea06ba5', a: '579a27cd-1f53-4e60-987a-7d1d01236e0b', b: '61519f46-5e06-4ee6-ac15-4cd856414cbc',
  c: '75b3e41f-4fae-4871-af27-55699b6a970a', d: '851be4be-001a-49c0-b64d-a81c4d005d09', e: '13b1a6ab-eda4-4274-8520-bdc212de8673',
};
const presets = {
  a: ['idle', 'walk', 'run', 'cast_a_spell', 'shoot'], b: ['jump', 'dive', 'hurt', 'cheer', 'defeat_02'],
  c: ['fire', 'pitch_baseball', 'basketball_shot', 'golf', 'dig'], d: ['lift_heavy', 'standing_relax', 'run_upstairs', 'flip', 'sing_02'],
  e: ['football_pass', 'victory_celebration', 'dance_02', 'dance_04', 'sing_04'],
};
const credits = { rig: 25, a: 50, b: 50, c: 50, d: 50, e: 50 };
const output = 'asset-source/generated/actor-yara-hero-01';

/* ------------------------------------------------------------------ hand frames (mirrors src/rendering/NativeHandGrip.ts) */

/** Shaft tilt off the knuckle line toward the fingertips (HEARTROOT_GRIP.diagonalRadians); 0: the shaft follows the knuckle line. */
const STAFF_DIAGONAL = 0;
/** Share of the rig's 1.7 m scale: the staff is 1.85 m long in the world, 0.42 of it below the grip. */
const RIG_SCALE = 1.7;
const STAFF = { length: 1.85 / RIG_SCALE, grip: 0.42 };

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
 * Hand-local anatomy of one native hand from the bind mesh: metacarpal direction `d`, thumb side `thumb`, palm normal `n` and (right hand) the
 * fitted staff fist: shaft head direction `s`, shaft point `palm` and `shaftRadius` (all in hand-local rig units, identical to `computeHandGrip`).
 */
function handAnatomy(base, side) {
  const { json, bin } = base, primitive = json.meshes[0].primitives[0], joints = json.skins[0].joints;
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
  const n = (side === 'Right' ? thumb.clone().cross(d) : d.clone().cross(thumb)).normalize();
  // Middle-finger axis: centroid direction of the hand vertices farthest from the wrist.
  const far = points.map((point) => ({ point, distance: point.length() })).sort((x, y) => y.distance - x.distance).slice(0, Math.floor(points.length * 0.15));
  const fingers = far.reduce((sum, item) => sum.add(item.point), new Vector3()).divideScalar(far.length).normalize();
  const anatomy = { side, d, thumb, n, fingers, points };
  if (side === 'Right') {
    const s = thumb.clone().multiplyScalar(Math.cos(STAFF_DIAGONAL)).addScaledVector(d, Math.sin(STAFF_DIAGONAL)).normalize();
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
    anatomy.dPerp = d.clone().addScaledVector(s, -d.dot(s)).normalize();
    anatomy.shaftRadius = shaftRadius;
    anatomy.palm = bend.clone().multiplyScalar(hinge).addScaledVector(s, across).addScaledVector(n, plane + radius);
  } else {
    // The free left hand lays its flat palm on the shaft: the contact point is the palm-side surface over the palm centroid.
    const bend = d, lengths = points.map((point) => point.dot(bend)).sort((x, y) => x - y), hinge = lengths[Math.floor(lengths.length * 0.98)] * 0.42;
    const palmPoints = points.filter((point) => point.dot(bend) < hinge);
    let across = 0, along = 0, surface = -Infinity;
    for (const point of palmPoints) { across += point.dot(thumb); along += point.dot(d); surface = Math.max(surface, point.dot(n)); }
    across /= palmPoints.length; along /= palmPoints.length;
    anatomy.palmSurface = d.clone().multiplyScalar(along).addScaledVector(thumb, across).addScaledVector(n, surface);
  }
  return anatomy;
}

/* ------------------------------------------------------------------ arm layer */

const UP = new Vector3(0, 1, 0);
const rigDirection = (yaw, pitch) => new Vector3(Math.cos(pitch * DEG) * Math.cos(yaw * DEG), Math.sin(pitch * DEG), -Math.cos(pitch * DEG) * Math.sin(yaw * DEG));
const smooth = (x) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
const quaternionOf = (matrix, out = new Quaternion()) => out.setFromRotationMatrix(matrix);

/** Named staff-arm poses: `hand` is the wrist offset from the shoulder in chest axes (forward, up, right; rig units, 1.7 m = 1.0), `staff` the shaft head's [yaw° (+ toward her left), pitch°] about the chest heading. */
const POSES = {
  carry: { hand: [0.13, -0.105, 0.065], staff: [0, 86] },
  ready: { hand: [0.2, -0.04, 0.04], staff: [0, 62] },
  guard: { hand: [0.17, -0.05, 0.1], staff: [-12, 28] },
  hip: { hand: [0.1, -0.16, 0.1], staff: [0, 12] },
  thrust: { hand: [0.29, 0.0, 0.03], staff: [0, 8] },
  high: { hand: [0.1, 0.27, 0.06], staff: [0, 90] },
  overhead: { hand: [0.14, 0.22, 0.05], staff: [0, 62] },
  low: { hand: [0.2, -0.22, 0.08], staff: [0, -30] },
  plant: { hand: [0.2, 0.005, 0.05], staff: [0, 84] },
};

const BONE_Y = new Vector3(0, 1, 0);
const SWIVELS = [0, -20, 20, -40, 40, -60, 60];
/** Rest-relative swing and twist (radians) of a local rotation about the bone's +Y axis (the limitJoints convention of the retarget toolkit). */
function swingTwist(local, restInverse, scratch) {
  const rel = scratch.copy(restInverse).multiply(local);
  if (rel.w < 0) { rel.x = -rel.x; rel.y = -rel.y; rel.z = -rel.z; rel.w = -rel.w; }
  const twist = 2 * Math.atan2(rel.y, rel.w), half = twist / 2;
  const sw = rel.w * Math.cos(half) + rel.y * Math.sin(half), swing = 2 * Math.acos(Math.min(1, Math.abs(sw)));
  return { swing, twist: Math.abs(twist) > Math.PI ? twist - Math.sign(twist) * 2 * Math.PI : twist };
}

/**
 * The arm solve fixes the world pose; how its roll is shared between upper arm, forearm and hand is free (rolling a parent about its bone axis and
 * counter-rolling the child leaves every world pose unchanged). Picks the shares that keep the three joints furthest inside their limits.
 */
function balanceRoll(target, ids, local, limits, side, memory) {
  const names = ['arm', 'fore', 'hand'], suffix = { arm: 'Arm', fore: 'ForeArm', hand: 'Hand' };
  const restInverse = names.map((name) => target.restQuaternion[ids[name]].clone().invert());
  const lim = names.map((name) => limits[`mixamorig:${side}${suffix[name]}`]);
  const scratch = new Quaternion(), arm = new Quaternion(), fore = new Quaternion(), hand = new Quaternion(), rollA = new Quaternion(), rollB = new Quaternion();
  let best = { cost: Infinity };
  for (let ta = -80; ta <= 80; ta += 20) {
    rollA.setFromAxisAngle(BONE_Y, ta * DEG);
    arm.copy(local.arm).multiply(rollA);
    const armPart = swingTwist(arm, restInverse[0], scratch);
    for (let tf = -150; tf <= 150; tf += 6) {
      rollB.setFromAxisAngle(BONE_Y, tf * DEG);
      fore.copy(rollA).invert().multiply(local.fore).multiply(rollB);
      hand.copy(rollB).invert().multiply(local.hand);
      const parts = [armPart, swingTwist(fore, restInverse[1], scratch), swingTwist(hand, restInverse[2], scratch)];
      let cost = 0;
      parts.forEach((part, i) => { cost = Math.max(cost, Math.abs(part.twist) / (lim[i].twist * DEG), part.swing / (lim[i].swing * DEG)); });
      cost += 0.0004 * (Math.abs(ta - memory.ta) + Math.abs(tf - memory.tf));
      if (cost < best.cost) best = { cost, ta, tf };
    }
  }
  rollA.setFromAxisAngle(BONE_Y, best.ta * DEG); rollB.setFromAxisAngle(BONE_Y, best.tf * DEG);
  const nextArm = local.arm.clone().multiply(rollA), nextFore = rollA.clone().invert().multiply(local.fore).multiply(rollB), nextHand = rollB.clone().invert().multiply(local.hand);
  local.arm.copy(nextArm).normalize(); local.fore.copy(nextFore).normalize(); local.hand.copy(nextHand).normalize();
  memory.ta = best.ta; memory.tf = best.tf;
  return best.cost;
}

function armSolver(target, side) {
  const node = (name) => target.index.get(`mixamorig:${side}${name}`);
  const ids = { shoulder: node('Shoulder'), arm: node('Arm'), fore: node('ForeArm'), hand: node('Hand'), chest: target.index.get('mixamorig:Spine2') };
  const rp = (i) => target.restWorldPosition[i], rq = (i) => target.restWorldQuaternion[i];
  const restU = rp(ids.fore).clone().sub(rp(ids.arm)), restF = rp(ids.hand).clone().sub(rp(ids.fore));
  const L1 = restU.length(), L2 = restF.length();
  restU.normalize(); restF.normalize();
  const pole = new Vector3(-0.15, -0.65, side === 'Right' ? 0.75 : -0.75).normalize();
  const chestRestInverse = rq(ids.chest).clone().invert();
  const scratch = { a: new Quaternion(), b: new Quaternion(), c: new Quaternion(), v: new Vector3(), w: new Vector3(), m: new Matrix4() };
  return {
    ids, L1, L2,
    /** Chest delta from rest (rotation) of the posed world matrices. */
    chestDelta(world, out) { return quaternionOf(world[ids.chest], out).multiply(chestRestInverse); },
    position(world, id, out) { return out.setFromMatrixPosition(world[id]); },
    /**
     * Writes the solved local rotations of arm/forearm/hand into `out` for a wrist target `T` (world) and a hand frame: local vectors
     * (`a1`, `a2`) of the hand map onto world vectors (`b1`, `b2`) (`b2` is only used as the plane; the forearm direction supplies it when absent).
     */
    solve(world, T, a1, a2, b1, b2, out, roll = 0, swivel = 0) {
      const S = scratch.v.setFromMatrixPosition(world[ids.arm]).clone();
      const toTarget = T.clone().sub(S);
      const reach = Math.min(Math.max(toTarget.length(), Math.abs(L1 - L2) + 1e-3), L1 + L2 - 1e-3);
      const u = toTarget.normalize();
      const a = (L1 * L1 - L2 * L2 + reach * reach) / (2 * reach), h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
      const bendPlane = pole.clone().addScaledVector(u, -pole.dot(u));
      if (bendPlane.lengthSq() < 1e-8) bendPlane.set(0, -1, 0).addScaledVector(u, u.y);
      bendPlane.normalize();
      if (swivel) bendPlane.applyAxisAngle(u, swivel);
      const elbow = S.clone().addScaledVector(u, a).addScaledVector(bendPlane, h);
      const U = elbow.clone().sub(S).normalize(), F = S.clone().addScaledVector(u, reach).sub(elbow).normalize();
      const qa = new Quaternion().setFromUnitVectors(restU, U).multiply(rq(ids.arm));
      const qf = new Quaternion().setFromUnitVectors(restF, F).multiply(rq(ids.fore));
      // Hand: local frame (a1, a2) → world frame (b1, b2'), with b2' the part of b2 (or the forearm) perpendicular to b1.
      const second = (b2 ?? F).clone().addScaledVector(b1, -(b2 ?? F).dot(b1));
      if (second.lengthSq() < 1e-8) second.set(1, 0, 0).addScaledVector(b1, -b1.x);
      second.normalize();
      if (roll) second.applyAxisAngle(b1, roll);
      const local = new Matrix4().makeBasis(a1, a2, a1.clone().cross(a2)), global = new Matrix4().makeBasis(b1, second, b1.clone().cross(second));
      const qh = quaternionOf(global.multiply(local.invert()));
      const parent = quaternionOf(world[ids.shoulder]);
      out.arm = parent.clone().invert().multiply(qa).normalize();
      out.fore = qa.clone().invert().multiply(qf).normalize();
      out.hand = qf.clone().invert().multiply(qh).normalize();
      out.reach = reach;
      return out;
    },
  };
}

function resolveKeys(keys, defaults) {
  const result = [];
  let previous = { ...defaults };
  for (const key of keys) {
    const pose = key.pose ? POSES[key.pose] : undefined;
    if (key.pose && !pose) throw new Error(`Unknown pose ${key.pose}`);
    const merged = { ...previous, ...pose, ...Object.fromEntries(Object.entries(key).filter(([name]) => name !== 'pose')) };
    result.push(merged);
    previous = merged;
  }
  return result;
}

function sampleKey(keys, tick, field, out) {
  let i = 0;
  while (i < keys.length - 1 && tick > keys[i + 1].t) i += 1;
  const a = keys[i], b = keys[Math.min(i + 1, keys.length - 1)];
  const f = b.t === a.t || tick <= a.t ? 0 : smooth((tick - a.t) / (b.t - a.t));
  const va = a[field], vb = b[field];
  if (Array.isArray(va)) { for (let c = 0; c < va.length; c += 1) out[c] = va[c] + (vb[c] - va[c]) * f; return out; }
  return va + (vb - va) * f;
}

const slerpDirection = (from, to, t) => {
  const q = new Quaternion().setFromUnitVectors(from, to);
  return from.clone().applyQuaternion(new Quaternion().slerp(q, t)).normalize();
};

/**
 * Authors the staff arm. `layer = { keys, follow, pitchPerUnit, left }`: keys `{ t, pose?, hand?, staff?, w?, grip?, gw?, roll? }` in ticks. `w` blends donor →
 * authored arm (0 leaves the donor's arm untouched); `follow` keeps that fraction of the donor hand's motion (chest axes, deviation from its mean) so a
 * gait still swings the arm; `grip` is the distance (rig units) from the fist along the shaft where the left palm lands with weight `gw`.
 * Returns the staff-direction trace (degrees from vertical per frame) for the report.
 */
function armLayer(context, frames, count, layer, limits) {
  const { target, right, left, grip, leftGrip } = context;
  const keys = resolveKeys(layer.keys, { t: 0, hand: POSES.carry.hand, staff: POSES.carry.staff, w: 1, grip: 0.3, gw: 0, roll: 0 });
  const rightArm = armSolver(target, 'Right'), leftArm = layer.keys.some((key) => (key.gw ?? 0) > 0) ? armSolver(target, 'Left') : undefined;
  const follow = layer.follow ?? 0, pitchPerUnit = layer.pitchPerUnit ?? 0;
  const q = { chest: new Quaternion(), tmp: new Quaternion(), tmp2: new Quaternion() };
  // Donor hand offsets in chest axes (for `follow`).
  const donor = [], mean = new Vector3();
  for (let k = 0; k < count; k += 1) {
    const world = target.poseFrame(frames, k);
    const delta = rightArm.chestDelta(world, new Quaternion());
    const offset = rightArm.position(world, rightArm.ids.hand, new Vector3()).sub(rightArm.position(world, rightArm.ids.arm, new Vector3())).applyQuaternion(delta.clone().invert());
    donor.push(offset); mean.add(offset);
  }
  mean.divideScalar(count);
  const trace = [];
  /** Tries elbow swivels about the shoulder-wrist axis (each with its best roll share) and keeps the one that stays furthest inside the joint limits. */
  const trial = { arm: new Quaternion(), fore: new Quaternion(), hand: new Quaternion() };
  const solveBest = (solver, side, memory, out, solveWith) => {
    let best = { cost: Infinity };
    for (const swivel of SWIVELS) {
      solveWith(swivel * DEG, trial);
      const rolls = { ta: memory.ta, tf: memory.tf };
      const cost = balanceRoll(target, solver.ids, trial, limits, side, rolls) + 0.0008 * Math.abs(swivel) + 0.0004 * Math.abs(swivel - memory.swivel);
      if (cost < best.cost) best = { cost, swivel, rolls, arm: trial.arm.clone(), fore: trial.fore.clone(), hand: trial.hand.clone() };
    }
    out.arm = best.arm; out.fore = best.fore; out.hand = best.hand; out.reach = 0;
    memory.ta = best.rolls.ta; memory.tf = best.rolls.tf; memory.swivel = best.swivel;
  };
  const t = [0, 0, 0], st = [0, 0];
  const donorLocal = { arm: new Quaternion(), fore: new Quaternion(), hand: new Quaternion() };
  const solved = {}, solvedLeft = {}, memoryRight = { ta: 0, tf: 0, swivel: 0 }, memoryLeft = { ta: 0, tf: 0, swivel: 0 };
  const read = (track, k, out) => out.fromArray(track, k * 4);
  for (let k = 0; k < count; k += 1) {
    const tick = k * TICKS_PER_SECOND / FPS;
    const w = sampleKey(keys, tick, 'w'), gw = sampleKey(keys, tick, 'gw');
    const world = target.poseFrame(frames, k);
    const delta = rightArm.chestDelta(world, q.chest);
    const forward = new Vector3(1, 0, 0).applyQuaternion(delta), yaw = Math.atan2(-forward.z, forward.x), heading = new Quaternion().setFromAxisAngle(UP, yaw);
    const shoulder = rightArm.position(world, rightArm.ids.arm, new Vector3());
    const donorWrist = rightArm.position(world, rightArm.ids.hand, new Vector3());
    const donorHandQ = quaternionOf(world[rightArm.ids.hand]);
    if (w > 1e-4) {
      sampleKey(keys, tick, 'hand', t); sampleKey(keys, tick, 'staff', st);
      const roll = sampleKey(keys, tick, 'roll') * DEG;
      const swing = donor[k].clone().sub(mean);
      const authoredWrist = shoulder.clone().add(new Vector3(t[0], t[1], t[2]).addScaledVector(swing, follow).applyQuaternion(delta));
      const pitch = st[1] + pitchPerUnit * swing.x;
      const staffAuthored = rigDirection(st[0], pitch).applyQuaternion(heading);
      const staffDonor = grip.s.clone().applyQuaternion(donorHandQ);
      const wrist = donorWrist.clone().lerp(authoredWrist, w), staff = slerpDirection(staffDonor, staffAuthored, w);
      solveBest(rightArm, 'Right', memoryRight, solved, (swivel, out) => rightArm.solve(world, wrist, grip.s, grip.dPerp, staff, undefined, out, roll, swivel));
      if (process.env.YARA_DUMP) console.error('k', k, 'reach', solved.reach.toFixed(3), 'wristRel', wrist.clone().sub(shoulder).toArray().map((x) => x.toFixed(2)).join(','), 'staff', staff.toArray().map((x) => x.toFixed(2)).join(','), 'yaw', (yaw / DEG).toFixed(0), 'chestdelta', delta.toArray().map((x) => x.toFixed(2)).join(','), 'donorWristRel', donorWrist.clone().sub(shoulder).toArray().map((x) => x.toFixed(2)).join(','));
      const mix = smooth(w);
      for (const [name, id] of [['arm', rightArm.ids.arm], ['fore', rightArm.ids.fore], ['hand', rightArm.ids.hand]]) {
        read(frames.rotations[id], k, donorLocal[name]);
        donorLocal[name].slerp(solved[name], mix).normalize().toArray(frames.rotations[id], k * 4);
      }
    }
    // Staff direction actually carried (after the solve) for reporting; also the left-hand seat.
    const after = target.poseFrame(frames, k);
    const handQ = quaternionOf(after[rightArm.ids.hand]);
    const staffNow = grip.s.clone().applyQuaternion(handQ);
    trace.push(staffNow.angleTo(UP) / DEG);
    if (leftArm && gw > 1e-4) {
      const wrist = rightArm.position(after, rightArm.ids.hand, new Vector3());
      const fist = wrist.clone().add(grip.palm.clone().applyQuaternion(handQ));
      const along = sampleKey(keys, tick, 'grip');
      const seat = fist.clone().addScaledVector(staffNow, along);
      const rightward = new Vector3(0, 0, 1).applyQuaternion(heading);
      const palmNormal = rightward.clone().addScaledVector(staffNow, -rightward.dot(staffNow));
      if (palmNormal.lengthSq() < 1e-6) palmNormal.set(0, 1, 0);
      palmNormal.normalize();
      const fingers = staffNow.clone().cross(palmNormal).normalize();
      const global = new Matrix4().makeBasis(staffNow, fingers, palmNormal.clone().cross(fingers)); // thumb along the shaft, fingers across
      const local = new Matrix4().makeBasis(leftGrip.thumb, leftGrip.d, leftGrip.thumb.clone().cross(leftGrip.d));
      const handLeft = quaternionOf(global.clone().multiply(local.clone().invert()));
      const contact = seat.clone().addScaledVector(palmNormal, -grip.shaftRadius);
      const leftWrist = contact.clone().sub(leftGrip.palmSurface.clone().applyQuaternion(handLeft));
      solveBest(leftArm, 'Left', memoryLeft, solvedLeft, (swivel, out) => leftArm.solve(after, leftWrist, leftGrip.thumb, leftGrip.d, staffNow, fingers, out, 0, swivel));
      const mix = smooth(gw);
      for (const [name, id] of [['arm', leftArm.ids.arm], ['fore', leftArm.ids.fore], ['hand', leftArm.ids.hand]]) {
        read(frames.rotations[id], k, donorLocal[name]);
        donorLocal[name].slerp(solvedLeft[name], mix).normalize().toArray(frames.rotations[id], k * 4);
      }
    }
  }
  return trace;
}

/**
 * Donor stances turn the body sideways to cast. The simulation aims along the actor's facing, so the chest heading is kept within `maxDegrees` of the facing:
 * the excess is a smooth (tanh) rotation of the hips about the vertical, which carries the whole body.
 */
function faceForward(target, frames, count, maxDegrees) {
  const hips = target.index.get('mixamorig:Hips'), chest = target.index.get('mixamorig:Spine2'), parent = target.parent[hips];
  const chestRestInverse = target.restWorldQuaternion[chest].clone().invert();
  const limit = maxDegrees * DEG, track = frames.rotations[hips];
  const local = new Quaternion(), turn = new Quaternion(), parentWorld = new Quaternion(), delta = new Quaternion(), forward = new Vector3();
  for (let k = 0; k < count; k += 1) {
    const world = target.poseFrame(frames, k);
    delta.copy(quaternionOf(world[chest])).multiply(chestRestInverse);
    forward.set(1, 0, 0).applyQuaternion(delta);
    const yaw = Math.atan2(-forward.z, forward.x), correction = limit * Math.tanh(yaw / limit) - yaw;
    if (Math.abs(correction) < 1e-6) continue;
    quaternionOf(world[parent], parentWorld);
    local.fromArray(track, k * 4);
    turn.setFromAxisAngle(UP, correction);
    local.premultiply(parentWorld.clone().invert().multiply(turn).multiply(parentWorld)).normalize().toArray(track, k * 4);
  }
}

/** Staff shaft head direction per frame as [yaw°, pitch°] about the chest heading (+yaw toward her left) and its angle from vertical. */
function staffTrace(context, frames, count) {
  const { target, grip } = context, chest = target.index.get('mixamorig:Spine2'), hand = target.index.get('mixamorig:RightHand'), chestRestInverse = target.restWorldQuaternion[chest].clone().invert();
  const trace = [];
  for (let k = 0; k < count; k += 1) {
    const world = target.poseFrame(frames, k);
    const delta = quaternionOf(world[chest]).multiply(chestRestInverse), forward = new Vector3(1, 0, 0).applyQuaternion(delta), yaw = Math.atan2(-forward.z, forward.x);
    const world_s = grip.s.clone().applyQuaternion(quaternionOf(world[hand])), local = world_s.clone().applyAxisAngle(UP, -yaw);
    const fist = new Vector3().setFromMatrixPosition(world[hand]).add(grip.palm.clone().applyQuaternion(quaternionOf(world[hand])));
    trace.push({ pommelY: fist.y - world_s.y * STAFF.grip * STAFF.length, headY: fist.y + world_s.y * (1 - STAFF.grip) * STAFF.length, yaw: Math.atan2(-local.z, local.x) / DEG, pitch: Math.asin(Math.max(-1, Math.min(1, local.y))) / DEG, tilt: world_s.angleTo(UP) / DEG });
  }
  return trace;
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

// Locomotion: relaxed staff carry, near-vertical staff swinging with the gait.
add('aren-idle', 'a', 'idle', 240, [2, 6], { loop: { overlapSeconds: 0.4 }, limits: LOCOMOTION, arm: { follow: 0.2, keys: [{ t: 0, pose: 'carry' }] } });
add('aren-walk', 'a', 'walk', 142, [0, 2.3666665554], { loop: { overlapSeconds: 0.1 }, limits: LOCOMOTION, arm: { follow: 0.5, pitchPerUnit: 90, keys: [{ t: 0, pose: 'carry' }] } });
add('aren-run', 'a', 'run', 76, [0, 1.26666665], { loop: { overlapSeconds: 0.1 }, limits: LOCOMOTION, arm: { follow: 0.45, pitchPerUnit: 50, keys: [{ t: 0, pose: 'carry', hand: [0.19, -0.1, 0.03] }] } });
add('aren-jump', 'b', 'jump', 42, [0, 2.23333335], { airborne: true, limits: LOCOMOTION, arm: { follow: 0.25, keys: [{ t: 0, pose: 'carry', w: 0.9 }] } });
add('aren-forward-left-dive-roll', 'b', 'dive', 42, [0.15, 2.5], { airborne: true, limits: LOCOMOTION, arm: { follow: 0.3, keys: [{ t: 0, pose: 'carry', w: 0.55 }, { t: 21, w: 0.2 }, { t: 42, w: 0.55 }] } });
add('aren-hit', 'b', 'hurt', 24, [0, 1.4]);
add('aren-cheer', 'b', 'cheer', 300, [0, 5], { limits: LOCOMOTION });
add('aren-defeat', 'b', 'defeat_02', 360, [0, 8.46666622], { limits: LOCOMOTION });

// Heartroot skills. Release ticks are the simulation's (HEARTROOT_* / LIGHT_STEPS / SIGIL in src/game/combat): thorn bolts on tick 9/10/10, Root Spike on 20 (of 63),
// Eruption on 36 (of 76), Sap Lance launch on 16, Seed Storm launches on 12–42 every 6, Bloom meteors from 30 and its pulse on 132 (of 156).
const FACE = 28;
const BRACE = { hand: [0.21, -0.06, 0.05], staff: [0, 14] };
const TWO_HAND = { gw: 1, grip: 0.36 };
// Thornshot 1: the free left hand flicks an open-palm thorn while the staff stays at the ready.
add('yara-thornshot-1', 'a', 'cast_a_spell', 26, [2.0, 3.0], { mirror: true, sim: { totalTicks: 26, activeTick: 9 }, contact: { joints: ['LeftHand'], search: [2.2, 2.8], settle: 0 },
  arm: { keys: [{ t: 0, pose: 'carry' }, { t: 9, pose: 'carry', staff: [0, 74] }, { t: 26, pose: 'carry' }] } });
// Thornshot 2: a staff-tip thrust, hand drawn back and driven forward on the release tick.
add('yara-thornshot-2', 'a', 'cast_a_spell', 28, [2.0, 3.2], { sim: { totalTicks: 28, activeTick: 10 }, contact: { joints: ['RightHand'], search: [2.2, 2.8], settle: 0 },
  arm: { keys: [{ t: 0, pose: 'carry' }, { t: 5, pose: 'guard' }, { t: 10, pose: 'thrust' }, { t: 17, pose: 'thrust' }, { t: 28, pose: 'carry' }] } });
// Thornshot 3: both hands lob a seed over the shoulder.
add('yara-thornshot-3', 'c', 'basketball_shot', 34, [0, 1], { keys: [[0, 1.55], [6, 1.85], [10, 2.25], [16, 2.8], [34, 3.6]], sim: { totalTicks: 34 },
  arm: { keys: [{ t: 0, pose: 'carry', gw: 0 }, { t: 5, pose: 'overhead', ...TWO_HAND, grip: -0.26, hand: [0.1, 0.2, 0.06], staff: [0, 52] }, { t: 10, hand: [0.22, 0.22, 0.05], staff: [0, 36] }, { t: 18, hand: [0.22, 0.2, 0.05], staff: [0, 40] }, { t: 34, pose: 'carry', gw: 0 }] } });
// Root Spike: a low backswing and sweep that drives the staff tip along the ground lane on tick 20.
add('yara-root-spike', 'c', 'golf', 63, [0, 1], { keys: [[0, 6.3], [14, 7.4], [22, 8.0], [40, 8.6], [63, 9.4]], sim: { totalTicks: 63 },
  arm: { keys: [{ t: 0, pose: 'carry' }, { t: 12, hand: [0.05, -0.13, 0.15], staff: [-55, -12] }, { t: 20, hand: [0.22, -0.2, 0.06], staff: [8, -26] }, { t: 28, hand: [0.22, -0.2, 0.06], staff: [8, -32] }, { t: 63, pose: 'carry' }] } });
// Root charge: both hands raise the staff overhead; the loop breathes.
add('yara-root-charge', 'd', 'standing_relax', 90, [4, 7.5], { loop: { overlapSeconds: 0.3 }, sway: { joints: ['Spine1', 'Spine2', 'Head'], amplitude: 0.02 },
  arm: { keys: [{ t: 0, hand: [0.08, 0.235, 0.05], staff: [0, 84], ...TWO_HAND, grip: -0.24 }] } });
// Root Eruption: staff raised, then plunged into the ground on tick 36 while she drops into a knee, then rises.
compose('yara-root-eruption', 76, [
  { donor: 'd', animation: 'standing_relax', window: [4, 6] },
  { donor: 'c', animation: 'dig', window: [0.3, 1.5], ticks: [26, 76] },
  { donor: 'd', animation: 'standing_relax', window: [4, 6], ticks: [60, 76] },
], { crossfadeTicks: 8, arm: { keys: [{ t: 0, pose: 'carry', gw: 0 }, { t: 14, hand: [0.1, 0.2, 0.06], staff: [0, 82], ...TWO_HAND, grip: -0.26 }, { t: 26, hand: [0.1, 0.2, 0.06], staff: [0, 84] }, { t: 36, pose: 'plant', ...TWO_HAND, grip: -0.26 }, { t: 48, pose: 'plant' }, { t: 70, pose: 'carry', gw: 0 }] } });
// Seed charge: braced two-hand stance, staff levelled at the target; the loop breathes.
add('yara-seed-charge', 'c', 'fire', 90, [0.1, 1.5], { loop: { overlapSeconds: 0.3 }, sway: { joints: ['Spine1', 'Spine2', 'Head'], amplitude: 0.015 },
  arm: { keys: [{ t: 0, ...BRACE, ...TWO_HAND }] } });
// Sap Lance: pulled back, then driven forward on the launch tick 16; both hands on the shaft.
add('yara-sap-lance', 'a', 'cast_a_spell', 30, [0, 1], { keys: [[0, 2.2], [16, 2.45], [30, 3.3]], sim: { totalTicks: 30 },
  arm: { keys: [{ t: 0, ...BRACE, ...TWO_HAND }, { t: 8, hand: [0.12, -0.07, 0.06], staff: [0, 14] }, { t: 16, hand: [0.3, -0.02, 0.04], staff: [0, 6] }, { t: 22, hand: [0.3, -0.02, 0.04] }, { t: 30, pose: 'carry', gw: 0 }] } });
// Seed Storm: a spin with the staff swept out to her side while six seeds leave on ticks 12–42.
add('yara-seed-storm', 'e', 'dance_04', 60, [4.3, 5.8], { arm: { keys: [{ t: 0, pose: 'carry' }, { t: 10, hand: [0.0, 0.02, 0.27], staff: [-90, 12] }, { t: 46, hand: [0.0, 0.02, 0.27], staff: [-90, 12] }, { t: 60, pose: 'carry' }] } });
// Binding Vines: the free left hand whips the vine overhand (mirrored baseball pitch) while the staff stays low at her side.
add('yara-binding-vines', 'c', 'pitch_baseball', 54, [0.9, 2.5], { mirror: true, sim: { totalTicks: 54, activeTick: 18 }, contact: { joints: ['LeftHand'], search: [1.6, 2.1], settle: 0 },
  arm: { keys: [{ t: 0, pose: 'carry' }, { t: 18, pose: 'carry', staff: [0, 72] }, { t: 54, pose: 'carry' }] } });
// Cleanse: kneel, plant the staff upright in front of her and channel with both hands, then rise.
compose('yara-cleanse', 108, [
  { donor: 'd', animation: 'standing_relax', window: [4, 6] },
  { donor: 'c', animation: 'dig', window: [0.3, 1.5], ticks: [24, 108] },
  { donor: 'd', animation: 'standing_relax', window: [4, 6], ticks: [92, 108] },
], { crossfadeTicks: 12, arm: { keys: [{ t: 0, pose: 'carry', gw: 0 }, { t: 22, pose: 'plant', ...TWO_HAND, grip: -0.28, staff: [0, 86] }, { t: 80, pose: 'plant', staff: [0, 86] }, { t: 100, pose: 'carry', gw: 0 }] } });
// Heartroot Bloom: rising invocation with the staff held high, arms open to the sky, and a final pulse on tick 132.
compose('yara-heartroot-bloom', 156, [
  { donor: 'd', animation: 'standing_relax', window: [4, 6] },
  { donor: 'e', animation: 'victory_celebration', window: [0.6, 3.4], ticks: [14, 156] },
], { crossfadeTicks: 8, arm: { keys: [{ t: 0, pose: 'carry' }, { t: 16, pose: 'high' }, { t: 120, pose: 'high' }, { t: 130, pose: 'high', staff: [0, 100] }, { t: 134, hand: [0.26, 0.04, 0.05], staff: [0, -18] }, { t: 148, pose: 'carry' }] } });
// Second jump ("treading the wind"): two air steps, a somersault tuck, open-out and a soft landing, in place.
compose('aren-air-step', 60, [
  { donor: 'd', animation: 'run_upstairs', window: [0, 0.8], ticks: [0, 60] },
  { donor: 'd', animation: 'flip', keys: [[0, 0.9], [26, 1.2], [38, 2.2], [60, 3.4]], ticks: [14, 60] },
  { donor: 'b', animation: 'jump', window: [1.2, 2.2], ticks: [40, 60] },
], { airborne: true, crossfadeTicks: 4, pin: { maxVertical: 0.08 }, arm: { follow: 0.3, keys: [{ t: 0, pose: 'carry', w: 0.8 }, { t: 14, w: 0.8 }, { t: 24, w: 0.2 }, { t: 44, w: 0.2 }, { t: 54, w: 0.8 }, { t: 60, w: 0.8 }] } });

// Every skill faces the target along the simulation's facing; only the Seed Storm spin turns the whole body.
for (const spec of specs) if (spec.clip.startsWith('yara-') && spec.clip !== 'yara-seed-storm') spec.facing = FACE;

/* ------------------------------------------------------------------ build */

const args = process.argv.slice(2);
const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = option('only')?.split(',');
const hash = (data) => createHash('sha256').update(data).digest('hex');
const base = await readFile(root + rigPath);
const baseGlb = parseGlb(base);
const rigs = { target: new Rig(baseGlb) };
for (const [key, path] of Object.entries(sources)) rigs[key] = new Rig(parseGlb(await readFile(root + path)));
const target = rigs.target;
const grip = handAnatomy(baseGlb, 'Right'), leftGrip = handAnatomy(baseGlb, 'Left');
const context = { target, grip, leftGrip };

const clips = [], report = {};
for (const spec of specs.filter((item) => !only || only.includes(item.clip))) {
  const clip = buildClip(spec, rigs);
  const limits = spec.limits ?? COMBAT_LIMITS;
  if (spec.pin) pinHips(target, clip.frames, clip.count, spec.pin.maxVertical);
  if (spec.facing !== undefined) faceForward(target, clip.frames, clip.count, spec.facing);
  let staffTilt;
  if (spec.arm) staffTilt = armLayer(context, clip.frames, clip.count, spec.arm, limits);
  if (process.env.YARA_DEBUG) { const pre = jointExcursions(target, clip.frames, clip.count, limits); console.error(spec.clip, 'pre-limit', JSON.stringify(Object.fromEntries(Object.entries(pre).filter(([j]) => /Right(Arm|ForeArm|Hand|Shoulder)|Left(Arm|ForeArm|Hand)/.test(j)).map(([j, e]) => [j.replace('mixamorig:', ''), [Math.round(e.swing), Math.round(e.twist)]])))); }
  if (process.env.YARA_TRACE === spec.clip) {
    for (let k = 0; k < clip.count; k += 1) {
      const one = { rotations: clip.frames.rotations.map((track) => (track ? track.slice(k * 4, k * 4 + 4) : undefined)), positions: [] };
      const e = jointExcursions(target, one, 1, { 'mixamorig:RightHand': limits['mixamorig:RightHand'], 'mixamorig:RightForeArm': limits['mixamorig:RightForeArm'], 'mixamorig:RightArm': limits['mixamorig:RightArm'] });
      console.error(k, JSON.stringify(Object.fromEntries(Object.entries(e).map(([j, v]) => [j.slice(13), [Math.round(v.swing), Math.round(v.twist)]]))));
    }
  }
  const corrections = limitJoints(target, clip.frames, clip.count, limits);
  continuity(clip.frames, clip.count);
  if (process.env.YARA_STAFF === spec.clip) staffTrace(context, clip.frames, clip.count).forEach((e, k) => { if (k % 2 === 0) console.error('tick', k * 2, 'yaw', e.yaw.toFixed(0), 'pitch', e.pitch.toFixed(0), 'tilt', e.tilt.toFixed(0), 'pommelY', e.pommelY.toFixed(2), 'headY', e.headY.toFixed(2)); });
  const excursions = jointExcursions(target, clip.frames, clip.count, limits);
  const worst = Object.entries(excursions).map(([joint, e]) => ({ joint: joint.replace('mixamorig:', ''), swing: e.swing, twist: e.twist }));
  report[spec.clip] = {
    limits: limits === JOINT_LIMITS ? 'JOINT_LIMITS' : limits === COMBAT_LIMITS ? 'COMBAT_LIMITS' : 'custom',
    peakSwing: Math.round(Math.max(...worst.map((e) => e.swing)) * 10) / 10, peakTwist: Math.round(Math.max(...worst.map((e) => e.twist)) * 10) / 10,
    ...(staffTilt ? { staffTiltMax: Math.round(Math.max(...staffTilt) * 10) / 10, staffTiltMean: Math.round(staffTilt.reduce((s, v) => s + v, 0) / staffTilt.length * 10) / 10 } : {}),
    corrections,
    ...(spec.pin ? { hipsTravel: (() => { const t = hipsTravel(target, clip.frames, clip.count); return { horizontalMetres: Math.round(t.horizontal * RIG_SCALE * 1e4) / 1e4, verticalMetres: Math.round(t.vertical * RIG_SCALE * 1e4) / 1e4 }; })() } : {}),
  };
  clips.push(clip);
}
const animated = parseGlb(appendClips(base, clips));
// Tripo's native biped motion faces +X. A scene-level child preserves bind/clip transforms while presenting the +Z forward convention used by the simulation.
for (const scene of animated.json.scenes) {
  const index = animated.json.nodes.length;
  animated.json.nodes.push({ name: 'YaraForward', rotation: [0, -Math.SQRT1_2, 0, Math.SQRT1_2], children: scene.nodes });
  scene.nodes = [index];
}
const bytes = encodeGlb(animated.json, animated.bin);
if (only) {
  await writeFile('/tmp/yara-only.glb', bytes);
  await writeFile('/tmp/yara-grip.json', JSON.stringify({ s: grip.s.toArray(), d: grip.d.toArray(), n: grip.n.toArray(), palm: grip.palm.toArray(), shaftRadius: grip.shaftRadius }));
  if (process.env.YARA_DEFORM) for (const clip of clips) { const d = skinDeformationReport(bytes, clip.spec.clip); console.error('deformation', clip.spec.clip, d.p99, d.p999, d.max, d.worstBone, d.worstSeconds); }
  console.log(JSON.stringify(report, null, 1));
  process.exit(0);
}

/** Preview aid: a copy of the GLB with the staff shaft skinned to the right hand (positions of the fitted fist), so contact sheets show the carry. */
async function withStaff(glbBytes) {
  const source = parseGlb(glbBytes), { json, bin } = source, primitive = json.meshes[0].primitives[0];
  const joints = json.skins[0].joints, handJoint = joints.findIndex((node) => json.nodes[node].name === 'mixamorig:RightHand');
  const inverse = new Matrix4().fromArray(readAccessorAny(json, bin, json.skins[0].inverseBindMatrices), handJoint * 16).invert();
  const attribute = (name) => readAccessorAny(json, bin, primitive.attributes[name]);
  const position = attribute('POSITION'), normal = attribute('NORMAL'), uv = attribute('TEXCOORD_0'), jointIds = attribute('JOINTS_0'), weights = attribute('WEIGHTS_0'), indices = readAccessorAny(json, bin, primitive.indices);
  const segments = 14, u = grip.s.clone().cross(grip.d).normalize(), v = grip.s.clone().cross(u).normalize(), rim = [], normals = [], triangles = [];
  for (const along of [-STAFF.grip * STAFF.length, (1 - STAFF.grip) * STAFF.length]) for (let i = 0; i < segments; i += 1) {
    const angle = i / segments * 2 * Math.PI, radial = u.clone().multiplyScalar(Math.cos(angle)).addScaledVector(v, Math.sin(angle));
    rim.push(grip.palm.clone().addScaledVector(grip.s, along).addScaledVector(radial, grip.shaftRadius).applyMatrix4(inverse)); normals.push(radial.clone().transformDirection(inverse));
  }
  for (let i = 0; i < segments; i += 1) { const j = (i + 1) % segments; triangles.push(i, j, segments + i, j, segments + j, segments + i); }
  const first = position.length / 3, total = first + rim.length;
  const P = new Float32Array(total * 3), N = new Float32Array(total * 3), U = new Float32Array(total * 2), J = new Uint8Array(total * 4), W = new Float32Array(total * 4), I = new Uint32Array(indices.length + triangles.length);
  P.set(position); N.set(normal); U.set(uv); J.set(jointIds); W.set(weights); I.set(indices);
  rim.forEach((point, i) => { point.toArray(P, (first + i) * 3); normals[i].toArray(N, (first + i) * 3); U.set([0.5, 0.5], (first + i) * 2); J.set([handJoint, 0, 0, 0], (first + i) * 4); W.set([1, 0, 0, 0], (first + i) * 4); });
  triangles.forEach((index, i) => { I[indices.length + i] = first + index; });
  const parts = [bin];
  let offset = bin.length;
  const add = (array, type, componentType) => {
    const pad = (4 - offset % 4) % 4;
    if (pad) { parts.push(Buffer.alloc(pad)); offset += pad; }
    const data = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    parts.push(data);
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length });
    offset += data.length;
    json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType, count: array.length / { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type], type });
    return json.accessors.length - 1;
  };
  primitive.attributes.POSITION = add(P, 'VEC3', 5126);
  const bounds = json.accessors[primitive.attributes.POSITION];
  bounds.min = [Infinity, Infinity, Infinity]; bounds.max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < total; i += 1) for (let c = 0; c < 3; c += 1) { bounds.min[c] = Math.min(bounds.min[c], P[i * 3 + c]); bounds.max[c] = Math.max(bounds.max[c], P[i * 3 + c]); }
  primitive.attributes.NORMAL = add(N, 'VEC3', 5126); primitive.attributes.TEXCOORD_0 = add(U, 'VEC2', 5126);
  primitive.attributes.JOINTS_0 = add(J, 'VEC4', 5121); primitive.attributes.WEIGHTS_0 = add(W, 'VEC4', 5126); primitive.indices = add(I, 'SCALAR', 5125);
  const merged = Buffer.concat(parts);
  json.buffers[0].byteLength = merged.length;
  return encodeGlb(json, merged);
}

/* ------------------------------------------------------------------ outputs */

await mkdir(root + output, { recursive: true });
await writeFile(root + output + '/yara-hero-animated.glb', bytes);
const mapping = Object.fromEntries(clips.map((clip) => [clip.spec.clip, clip.spec.clip]));
for (const action of ['strafe']) mapping['aren-' + action] = 'aren-walk';
for (const action of ['stagger', 'stumble-recovery', 'hard-landing']) mapping['aren-' + action] = 'aren-hit';
for (const action of ['forward-right-dive-roll', 'perfect-dodge-left', 'perfect-dodge-right', 'quick-step-left', 'quick-step-right', 'forward-shoulder-roll', 'back-handspring', 'left-cartwheel', 'right-cartwheel', 'back-left-pivot-roll', 'back-right-pivot-roll', 'low-slide', 'dodge-recovery']) mapping['aren-' + action] = 'aren-forward-left-dive-roll';
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
  id: 'actor-yara-hero', actorId: 'aren', variantOf: 'actor-aren', sourceType: 'native-glb', kind: 'character', rigFamily: 'biped',
  tripoSourceTask: tasks.rig, sourceHash: hash(base), outputHash: hash(bytes), runtimeUrl: '/' + output + '/yara-hero-animated.glb',
  coordinateTransform: { forward: { x: 0, y: 0, z: 1 }, scale: 1.7 }, lodIds: [], requiredActionIds: [],
  actionToClipMapping: mapping, rootMotion, sockets: [], provenance: output + '/provenance.json', evidenceStatus: 'blocked',
};
await writeFile(root + output + '/manifest-entry.json', JSON.stringify(entry, null, 2) + '\n');

// Anatomy report: limits, staff carry and skin deformation of every clip of the delivered GLB, next to the baseline measured on the previous delivery.
const baseline = JSON.parse(await readFile(root + output + '/anatomy-baseline.json', 'utf8')).clips;
const deformation = {};
for (const clip of clips) {
  const measured = skinDeformationReport(bytes, clip.spec.clip);
  deformation[clip.spec.clip] = { p99: measured.p99, p999: measured.p999, max: measured.max, worstBone: measured.worstBone };
}
const locomotion = ['aren-idle', 'aren-walk', 'aren-run', 'aren-jump', 'aren-forward-left-dive-roll'];
const ceiling = Math.max(...locomotion.map((name) => deformation[name].p999));
const anatomy = {
  schemaVersion: 1,
  grip: {
    staffDiagonalDegrees: STAFF_DIAGONAL / DEG, staffToMiddleFingerDegrees: Math.acos(grip.s.dot(grip.fingers)) / DEG, staffToPrincipalAxisDegrees: Math.acos(grip.s.dot(grip.d)) / DEG, middleFingerHand: grip.fingers.toArray().map((v) => Math.round(v * 1e6) / 1e6), staffAxisHand: grip.s.toArray().map((v) => Math.round(v * 1e6) / 1e6),
    palmHand: grip.palm.toArray().map((v) => Math.round(v * 1e6) / 1e6), shaftRadiusRig: Math.round(grip.shaftRadius * 1e6) / 1e6, metacarpalHand: grip.d.toArray().map((v) => Math.round(v * 1e6) / 1e6),
    thumbSideHand: grip.thumb.toArray().map((v) => Math.round(v * 1e6) / 1e6), palmNormalHand: grip.n.toArray().map((v) => Math.round(v * 1e6) / 1e6),
  },
  deformationCeiling: { clips: locomotion, p999: ceiling },
  clips: Object.fromEntries(clips.map((clip) => [clip.spec.clip, { ...report[clip.spec.clip], deformation: deformation[clip.spec.clip], before: baseline[clip.spec.clip] ?? null }])),
};
await writeFile(root + output + '/anatomy-report.json', JSON.stringify(anatomy, null, 2) + '\n');
await writeFile(root + output + '/provenance.json', JSON.stringify({
  schemaVersion: 1, originalModelTask: 'f5c49b45-1eee-47e7-84fc-e6e592ae5c29', tasks, sources, presets, sourceHash: hash(base), outputHash: hash(bytes),
  operation: 'Offline Tripo animation retarget with the shared Rig/buildClip/appendClips/limitJoints toolkit; the staff arm is authored by a two-bone solve with the fixed-fist grip of src/rendering/NativeHandGrip.ts; original native skinned Yara mesh retained.',
  grip: anatomy.grip, credits, creditTotal: Object.values(credits).reduce((sum, value) => sum + value, 0), evidenceStatus: 'blocked',
  clips: specs.map((spec) => ({ ...spec, limits: spec.limits === JOINT_LIMITS ? 'JOINT_LIMITS' : 'COMBAT_LIMITS' })),
}, null, 2) + '\n');
console.log(JSON.stringify({ output: output + '/yara-hero-animated.glb', hash: hash(bytes), clips: clips.length, actions: Object.keys(mapping).length, deformationCeiling: ceiling }));

/* ------------------------------------------------------------------ previews and manifest sync (opt-in) */

if (args.includes('--previews')) {
  const { execFileSync } = await import('node:child_process');
  const staffed = await withStaff(bytes);
  const staffedPath = root + output + '/previews/_staffed.glb';
  await mkdir(root + output + '/previews', { recursive: true });
  await writeFile(staffedPath, staffed);
  const sheets = [
    ['locomotion-side', 'side', ['aren-idle', 'aren-walk', 'aren-run', 'aren-jump', 'aren-forward-left-dive-roll', 'aren-hit'], 8],
    ['reactions-side', 'side', ['aren-cheer', 'aren-defeat', 'aren-air-step'], 10],
    ['thornshot-side', 'side', ['yara-thornshot-1', 'yara-thornshot-2', 'yara-thornshot-3'], 10],
    ['thornshot-front', 'front', ['yara-thornshot-1', 'yara-thornshot-2', 'yara-thornshot-3'], 10],
    ['root-side', 'side', ['yara-root-spike', 'yara-root-charge', 'yara-root-eruption'], 10],
    ['root-front', 'front', ['yara-root-spike', 'yara-root-charge', 'yara-root-eruption'], 10],
    ['sap-seed-side', 'side', ['yara-seed-charge', 'yara-sap-lance', 'yara-seed-storm'], 10],
    ['sap-seed-front', 'front', ['yara-seed-charge', 'yara-sap-lance', 'yara-seed-storm'], 10],
    ['vines-cleanse-bloom-side', 'side', ['yara-binding-vines', 'yara-cleanse', 'yara-heartroot-bloom'], 10],
    ['vines-cleanse-bloom-front', 'front', ['yara-binding-vines', 'yara-cleanse', 'yara-heartroot-bloom'], 10],
    ['air-step-iso', 'iso', ['aren-air-step'], 12],
  ];
  for (const [name, view, names, frames] of sheets) {
    execFileSync('node', ['scripts/assets/render-clip-preview.mjs', staffedPath, `${root}${output}/previews/${name}.png`, `--clips=${names.join(',')}`, `--frames=${frames}`, `--view=${view}`, '--cell=240'], { cwd: root, stdio: 'ignore' });
  }
  await rm(staffedPath);
}

if (args.some((arg) => arg === '--sync-manifest' || arg.startsWith('--sync-manifest='))) {
  const path = option('sync-manifest') ?? 'asset-source/playtests/greenwake.json';
  const text = await readFile(resolve(root, path), 'utf8');
  const start = text.indexOf('  {\n    "id": "actor-yara-hero",');
  const close = text.indexOf('\n  }', start);
  if (start < 0 || close < 0) throw new Error(`No actor-yara-hero entry in ${path}`);
  const replacement = JSON.stringify(entry, null, 2).split('\n').map((line) => '  ' + line).join('\n');
  await writeFile(resolve(root, path), text.slice(0, start) + replacement + text.slice(close + '\n  }'.length));
  console.log(`Synced actor-yara-hero in ${path}`);
}
