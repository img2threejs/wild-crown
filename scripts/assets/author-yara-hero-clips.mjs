import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { parseGlb, encodeGlb } from './import-aren-animation-set.mjs';
import { readAccessorAny } from './creature-rig-kit.mjs';
import { Rig, buildClip, appendClips, limitJoints, jointExcursions, skinDeformationReport, JOINT_LIMITS, COMBAT_LIMITS, FPS } from './retarget-aren-tripo-clips.mjs';
import { loadMixamoDonor, resolveMixamoSources } from './mixamo-import.mjs';
import { armDepth, capsules as bodyCapsules, clearArms } from './arm-body-clearance.mjs';

/**
 * Authors Yara's Heartroot clip set on her native 23-joint Tripo skeleton.
 *
 * Bodies come from Tripo preset donors (retargeted by the shared toolkit, anatomically limited by `limitJoints`); the staff arm is then
 * authored by `armLayer`: a two-bone solve of the right arm to a hand target plus a staff direction, so the staff is held in the fixed fist of
 * `src/rendering/NativeHandGrip.ts` (no wrist twisting at runtime) and aims where the choreography wants it. A second solve can seat the left
 * palm on the shaft for the two-hand actions.
 *
 * Knockdown / get-up (aren-knockdown, aren-knockdown-forward, aren-getup, aren-getup-forward): four 60 Hz clips that play captured Mixamo reaction takes
 * (asset-source/mixamo/reactions) through the world-space retarget of mixamo-import.mjs; see `lieClip`, `buildGetup`, `floorCorrect` and `staffClearance`.
 * Authoring aids: `--lie-timeline=m:<take>[:from:to]` prints a take on this rig, `--probe=<take>:<from s>:<to s>[:ticks]` writes /tmp/yara-probe.glb.
 *
 * Run: `node scripts/assets/author-yara-hero-clips.mjs [--previews] [--only=a,b] [--sync-manifest[=path]]`. Deterministic; reruns are byte-identical.
 * Without `--sync-manifest` nothing under asset-source/playtests/ is touched: the entry is only emitted as `manifest-entry.json`.
 */
const root = fileURLToPath(new URL('../../', import.meta.url));
const DEG = Math.PI / 180;
const TICKS_PER_SECOND = 60;
/** Yara (concept C): Tripo v3.1 Ultra mesh on Mixamo's 65-joint auto-rig, built by build-yara-mixamo-rig.mjs (fingers, leaf skirt rebound, T-pose rest facing +X). */
const rigPath = 'asset-source/generated/actor-yara-c-rig-01/yara-c-rig.glb';
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
    // The finger-chain fist of `computeHandGrip` (the rig has finger joints): the shaft runs along the knuckle line (index base − pinky base), tilted
    // STAFF_DIAGONAL toward the wrist; it lies in the palm `shaftRadius` off its surface, under the middle finger's base.
    const local = (name) => new Vector3().setFromMatrixPosition(matrix(jointIndex(`mixamorig:RightHand${name}`)).clone().invert()).applyMatrix4(handMatrix);
    const index = local('Index1'), pinky = local('Pinky1'), middle = local('Middle1'), thumbBase = local('Thumb1');
    const width = index.clone().sub(pinky), knuckleLine = width.clone().normalize();
    const direction = middle.clone().addScaledVector(knuckleLine, -middle.dot(knuckleLine)).normalize();
    const normal = knuckleLine.clone().cross(direction).normalize();
    if (normal.dot(thumbBase) < 0) normal.negate();
    const s = knuckleLine.clone().multiplyScalar(Math.cos(STAFF_DIAGONAL)).addScaledVector(direction, -Math.sin(STAFF_DIAGONAL)).normalize();
    const shaftRadius = width.length() * 0.16;
    // Palm vertices: carried by the hand joint itself (not a finger).
    const handOnly = [];
    for (const vertex of seen) {
      let own = 0;
      for (let c = 0; c < 4; c += 1) if (json.nodes[joints[jointIds[vertex * 4 + c]]].name === 'mixamorig:RightHand') own += weights[vertex * 4 + c];
      if (own > 0.6) handOnly.push(new Vector3(position[vertex * 3], position[vertex * 3 + 1], position[vertex * 3 + 2]).applyMatrix4(handMatrix));
    }
    let surface = 0;
    for (const point of handOnly) if (point.dot(direction) > middle.dot(direction) * 0.5 && point.dot(direction) < middle.dot(direction)) surface = Math.max(surface, point.dot(normal));
    anatomy.s = s;
    anatomy.dPerp = direction.clone().addScaledVector(s, -direction.dot(s)).normalize();
    anatomy.shaftRadius = shaftRadius;
    anatomy.palm = middle.clone().multiplyScalar(0.92).addScaledVector(normal, surface + shaftRadius);
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
const SWIVELS = [0, -20, 20, -40, 40, -60, 60, -80, 80, -100, 100];
/** Cost per rig unit of arm-in-body depth: a centimetre of overlap outweighs the whole preference for a small swivel. */
const BODY_PRICE = 14;
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
      out.reach = reach; out.shoulder = S; out.elbow = elbow; out.wrist = S.clone().addScaledVector(u, reach);
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
  /** Body volumes of the frame being solved (set per frame): an elbow placement that sinks the arm into the trunk, head or legs is priced out. */
  let body;
  const solveBest = (solver, side, memory, out, solveWith) => {
    let best = { cost: Infinity };
    for (const swivel of SWIVELS) {
      solveWith(swivel * DEG, trial);
      const rolls = { ta: memory.ta, tf: memory.tf };
      const cost = balanceRoll(target, solver.ids, trial, limits, side, rolls) + 0.0008 * Math.abs(swivel) + 0.0004 * Math.abs(swivel - memory.swivel) + BODY_PRICE * armDepth(body, trial.shoulder, trial.elbow, trial.wrist);
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
    body = bodyCapsules(target, world);
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
    body = bodyCapsules(target, after);
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
/**
 * Keeps the trunk upright: wherever the Hips → Neck line leans more than `maxDegrees` from vertical (a donor hunching or bowing over its cast), the
 * excess is rotated back out of the spine, shared over Spine, Spine1 and Spine2 (rotation about the horizontal axis across the lean, in world space),
 * with a soft knee (tanh) so a lean just past the limit is barely touched. Legs, hips and arms keep their captured motion.
 */
const UPRIGHT_SHARES = [['Spine', 0.34], ['Spine1', 0.33], ['Spine2', 0.33]];
function limitLean(target, frames, count, maxDegrees) {
  const hips = target.index.get('mixamorig:Hips'), neck = target.index.get('mixamorig:Neck'), limit = maxDegrees * DEG;
  const h = new Vector3(), n = new Vector3(), dir = new Vector3(), axis = new Vector3(), parentWorld = new Quaternion(), turn = new Quaternion(), local = new Quaternion();
  for (let k = 0; k < count; k += 1) {
    let world = target.poseFrame(frames, k);
    h.setFromMatrixPosition(world[hips]); n.setFromMatrixPosition(world[neck]);
    dir.subVectors(n, h).normalize();
    const lean = Math.acos(Math.min(1, Math.max(-1, dir.dot(UP))));
    if (lean <= limit * 0.5) continue;
    const allowed = limit * 0.5 + limit * 0.5 * Math.tanh((lean - limit * 0.5) / (limit * 0.5)), correction = lean - allowed;
    if (correction < 1e-4) continue;
    axis.crossVectors(dir, UP);
    if (axis.lengthSq() < 1e-10) continue;
    axis.normalize();
    for (const [name, share] of UPRIGHT_SHARES) {
      const node = target.index.get(`mixamorig:${name}`);
      world = target.poseFrame(frames, k);
      quaternionOf(world[target.parent[node]], parentWorld);
      turn.setFromAxisAngle(axis, correction * share);
      local.fromArray(frames.rotations[node], k * 4);
      local.premultiply(parentWorld.clone().invert().multiply(turn).multiply(parentWorld)).normalize().toArray(frames.rotations[node], k * 4);
    }
  }
}

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

/* ------------------------------------------------------------------ knockdown / get-up pipeline (60 Hz Mixamo takes on the native rig) */

const yawQ = (degrees) => new Quaternion().setFromAxisAngle(UP, degrees * DEG);
const wrapDegrees = (degrees) => ((((degrees + 180) % 360) + 360) % 360) - 180;
const hipsWorld = (target, frames, k) => new Vector3().setFromMatrixPosition(target.poseFrame(frames, k)[target.index.get('mixamorig:Hips')]);
/** A skinned vertex within this height of the floor counts as touching it (rig units; 3 cm). */
const FLOOR_CONTACT = 0.03 / RIG_SCALE;
/** The lowest skinned vertex may dip this far below the floor at most (rig units; 3.4 mm, inside the brief's 1 cm). */
const FLOOR_MARGIN = 0.002;

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

/** Monotone time warp through `keys` ([tick, source seconds]); clamped outside the keys. */
function timeWarp(keys) {
  const times = keys.map((key) => key[0]), values = keys.map((key) => key[1]), n = keys.length;
  if (n === 1) return () => values[0];
  return (tick) => (tick <= times[0] ? values[0] : tick >= times[n - 1] ? values[n - 1] : monotoneAt(times, values, tick));
}

/**
 * Real-motion retarget onto the native rig, sampled at 60 Hz: every target joint with a donor partner takes the donor's world rotation away from its rest,
 *   W_t = P · Δ · R_t,   Δ = W_d · R_d⁻¹,
 * where P is a whole-body turn about the vertical (`yaw` degrees). Mixamo donors arrive from `loadMixamoDonor(file, { target })` already turned to the rig's
 * heading and with their T-pose rest aligned bone by bone onto this rig's A-pose rest. The Hips translation is the donor's displacement (turned by P, scaled
 * by the hip-height ratio), horizontally relative to the first sampled frame.
 */
function retargetAligned(target, donor, decoded, count, sourceTime, { yaw = 0 } = {}) {
  const partners = new Map();
  for (const i of target.joints) {
    const j = donor.index.get(target.names[i]);
    if (j !== undefined && donor.joints.includes(j)) partners.set(i, j);
  }
  const P = yawQ(yaw);
  const hips = target.index.get('mixamorig:Hips'), donorHips = donor.index.get('mixamorig:Hips');
  const hipScale = target.restWorldPosition[hips].y / donor.restWorldPosition[donorHips].y;
  const rotations = target.names.map(() => undefined), positions = target.names.map(() => undefined);
  for (const joint of target.joints) rotations[joint] = new Float32Array(count * 4);
  positions[hips] = new Float32Array(count * 3);
  const worldQ = target.names.map((_, i) => target.restWorldQuaternion[i].clone());
  const delta = new Quaternion(), world = new Quaternion(), local = new Quaternion(), base = new Vector3(), displacement = new Vector3();
  const hipsParentInverse = target.restWorld[target.parent[hips]].clone().invert();
  for (let k = 0; k < count; k += 1) {
    const donorWorld = donor.pose(decoded, sourceTime(k));
    for (const i of target.order) {
      if (!target.joints.includes(i)) continue;
      const parentQ = target.parent[i] < 0 ? new Quaternion() : worldQ[target.parent[i]], j = partners.get(i);
      if (j !== undefined) {
        quaternionOf(donorWorld[j], delta).multiply(donor.restWorldQuaternion[j].clone().invert());
        world.copy(P).multiply(delta).multiply(target.restWorldQuaternion[i]).normalize();
      } else world.copy(parentQ).multiply(target.restQuaternion[i]);
      worldQ[i].copy(world);
      local.copy(parentQ).invert().multiply(world).normalize().toArray(rotations[i], k * 4);
    }
    displacement.setFromMatrixPosition(donorWorld[donorHips]).sub(donor.restWorldPosition[donorHips]).multiplyScalar(hipScale);
    if (k === 0) base.set(displacement.x, 0, displacement.z);
    displacement.sub(base).applyQuaternion(P).add(target.restWorldPosition[hips]).applyMatrix4(hipsParentInverse).toArray(positions[hips], k * 3);
  }
  return { rotations, positions };
}

const decodedCache = new Map();
function decodedOf(donor, animation) {
  if (!decodedCache.has(donor)) decodedCache.set(donor, new Map());
  const map = decodedCache.get(donor);
  if (!map.has(animation)) map.set(animation, donor.decodeAnimation(animation));
  return map.get(animation);
}

/** Whole-body cross-fade between captured frames, with shortest-path rotations. */
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

/** Adds a world-space offset `(dx, dy, dz)(k, hipsWorld)` to the Hips. */
function offsetHips(target, frames, count, offset) {
  const hips = target.index.get('mixamorig:Hips'), world = target.restWorld[target.parent[hips]], inverse = world.clone().invert(), p = new Vector3();
  for (let k = 0; k < count; k += 1) {
    p.fromArray(frames.positions[hips], k * 3).applyMatrix4(world);
    const [dx, dy, dz] = offset(k, p);
    p.set(p.x + dx, p.y + dy, p.z + dz).applyMatrix4(inverse).toArray(frames.positions[hips], k * 3);
  }
}

/**
 * The skinned mesh of the native model, with what is needed to CPU-skin every `stride`-th vertex (`all`) or the vertices whose dominant skin weight is a Foot or
 * ToeBase bone. `lowest` gives the lowest skinned vertex height of one frame; `rest` is the bind pose's (the floor).
 */
function soleKit(target, glb, { stride = 4, all = false } = {}) {
  const { json, bin } = glb, primitive = json.meshes[0].primitives[0], read = (id) => readAccessorAny(json, bin, id);
  const positions = read(primitive.attributes.POSITION), joints = read(primitive.attributes.JOINTS_0), weights = read(primitive.attributes.WEIGHTS_0), inverseBind = read(json.skins[0].inverseBindMatrices);
  const skinJoints = json.skins[0].joints, soles = [];
  for (let v = 0; v < positions.length / 3; v += stride) {
    let best = 0;
    for (let s = 1; s < 4; s += 1) if (weights[v * 4 + s] > weights[v * 4 + best]) best = s;
    if (all || /Foot|ToeBase/.test(target.names[skinJoints[joints[v * 4 + best]]])) soles.push(v);
  }
  const matrices = skinJoints.map(() => new Matrix4()), inverse = new Matrix4();
  let lowestVertex = -1;
  const lowestOf = (world) => {
    skinJoints.forEach((node, j) => matrices[j].multiplyMatrices(world[node], inverse.fromArray(inverseBind, j * 16)));
    let lowest = Infinity;
    lowestVertex = -1;
    for (const v of soles) {
      let y = 0;
      for (let s = 0; s < 4; s += 1) {
        const w = weights[v * 4 + s];
        if (w <= 0) continue;
        const e = matrices[joints[v * 4 + s]].elements;
        y += w * (e[1] * positions[v * 3] + e[5] * positions[v * 3 + 1] + e[9] * positions[v * 3 + 2] + e[13]);
      }
      if (y < lowest) { lowest = y; lowestVertex = v; }
    }
    return lowest;
  };
  const dominantBone = (v) => { let best = 0; for (let s = 1; s < 4; s += 1) if (weights[v * 4 + s] > weights[v * 4 + best]) best = s; return target.names[skinJoints[joints[v * 4 + best]]].replace('mixamorig:', ''); };
  return { rest: lowestOf(target.restWorld), lowest: (frames, k) => lowestOf(target.poseFrame(frames, k)), lowestBone: (frames, k) => { lowestOf(target.poseFrame(frames, k)); return dominantBone(lowestVertex); } };
}

/**
 * The torso's own frame from one posed skeleton (independent of any rest convention): `up` = Hips → Neck, `right` = LeftArm → RightArm, `forward` = up × right
 * (the rig faces +X with +Y up and its right +Z, so a standing hero has forward = +X). `forward.y > 0.7` is lying on the back (the chest faces the sky),
 * `< -0.7` on the stomach. `axis` is the heading of Hips → Head in the floor plane (degrees, 0 = +X forward, + toward -Z), the direction a lying body points to.
 */
function torsoFrame(target, world) {
  const at = (name) => new Vector3().setFromMatrixPosition(world[target.index.get(`mixamorig:${name}`)]);
  const hips = at('Hips'), up = at('Neck').sub(hips).normalize(), right = at('RightArm').sub(at('LeftArm')).normalize(), forward = new Vector3().crossVectors(up, right).normalize();
  const head = at('Head').sub(hips);
  return { up, right, forward, axis: Math.atan2(-head.z, head.x) / DEG };
}

/**
 * The shared soft joint guard (`limitJoints`), applied so that a clamp stays local: walking the skeleton from the Hips outwards, every joint first resumes its
 * captured world orientation under its (possibly already clamped) parent and is then clamped to its own limit. Every joint ends inside its limit.
 * Returns the largest correction per joint (degrees).
 */
function guardJoints(target, frames, count, limits) {
  const corrections = {}, order = target.order.filter((i) => target.joints.includes(i)), a = new Quaternion(), b = new Quaternion();
  const captured = Array.from({ length: count }, (_, k) => target.poseFrame(frames, k).map((matrix) => quaternionOf(matrix)));
  const world = Array.from({ length: count }, () => target.names.map((_, i) => target.restWorldQuaternion[i].clone()));
  for (const i of order) {
    const track = frames.rotations[i], parent = target.parent[i], limit = limits[target.names[i]];
    for (let k = 0; k < count; k += 1) {
      if (parent >= 0 && world[k][parent].angleTo(captured[k][parent]) > 1e-6) world[k][parent].clone().invert().multiply(captured[k][i]).normalize().toArray(track, k * 4);
    }
    if (limit) for (const [joint, degrees] of Object.entries(limitJoints(target, frames, count, { [target.names[i]]: limit }))) corrections[joint] = degrees;
    for (let k = 0; k < count; k += 1) world[k][i].copy(parent < 0 ? a.identity() : world[k][parent]).multiply(b.fromArray(track, k * 4));
  }
  return corrections;
}

/**
 * Limits the Hips' horizontal travel (from the clip's first frame, which stands at the rest XZ) to `maxMetres` by scaling the whole donor displacement
 * uniformly: the donor's direction is kept and a held frame stays held. The vertical Hips motion is not touched. Returns the scale applied.
 */
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
 * or the torso is flat on the floor. In between (the fall, the push-up of a get-up) the donor's own height is kept, the lift is smoothed so the Hips do not
 * jerk, and the no-penetration lift is re-applied last. Frames from `holdFrom` on rest exactly on the floor and are identical to each other; `pinFirst` / `pinLast`
 * keep the height of frame 0 / the last frame (a seam to the neighbouring clip). Returns the lift range in metres.
 */
function floorCorrect(target, frames, count, kit, { holdFrom = count, pinFirst = false, pinLast = false } = {}) {
  const hips = target.index.get('mixamorig:Hips'), low = [], flat = [];
  for (let k = 0; k < count; k += 1) {
    const world = target.poseFrame(frames, k);
    low.push(kit.lowest(frames, k) - kit.rest);
    flat.push(Math.abs(torsoFrame(target, world).forward.y) > 0.7 && (world[hips].elements[13] - low[k]) < 0.3 / RIG_SCALE);
  }
  const seated = (k) => k >= holdFrom || flat[k] || low[k] < FLOOR_CONTACT;
  const pinned = (k) => (pinFirst && k === 0) || (pinLast && k === count - 1);
  let lift = low.map((l, k) => (seated(k) && !pinned(k) ? -l : 0));
  const smoothed = Math.min(holdFrom, count);
  for (let pass = 0; pass < 6; pass += 1) {
    const next = lift.slice();
    for (let k = 0; k < smoothed; k += 1) if (!pinned(k)) next[k] = (lift[Math.max(0, k - 1)] + 2 * lift[k] + lift[Math.min(count - 1, k + 1)]) / 4;
    lift = next;
  }
  lift = lift.map((value, k) => {
    if (pinned(k)) return 0;
    if (k >= holdFrom || flat[k]) return -low[k];
    return Math.max(value, -FLOOR_MARGIN - low[k]);
  });
  offsetHips(target, frames, count, (k) => [0, lift[k], 0]);
  const metres = (value) => Math.round(value * RIG_SCALE * 1e4) / 1e4;
  return { liftMinMetres: metres(Math.min(...lift)), liftMaxMetres: metres(Math.max(...lift)) };
}

/**
 * Last floor pass of a get-up, after its blends: lifts the Hips wherever the lowest skinned vertex of the whole mesh dips below the floor guard, and keeps the frames
 * whose torso lies flat on the floor within 1 cm of it (a lying-to-lying blend can leave the body hovering a few centimetres above it). Each frame's lift has a
 * corridor (never deeper than the guard; a flat frame never more than 1 cm above the floor) and the lifts are smoothed inside it, so the Hips do not jerk where the
 * corridor changes. `pinFirst` keeps frame 0. Returns the lift range in metres.
 */
function keepAboveFloor(target, frames, count, kit, { pinFirst = false } = {}) {
  const hips = target.index.get('mixamorig:Hips'), low = [], flat = [];
  for (let k = 0; k < count; k += 1) {
    const world = target.poseFrame(frames, k);
    low.push(kit.lowest(frames, k) - kit.rest);
    flat.push(Math.abs(torsoFrame(target, world).forward.y) > 0.7 && (world[hips].elements[13] - low[k]) < 0.3 / RIG_SCALE);
  }
  const pinned = (k) => pinFirst && k === 0;
  const tolerance = 0.01 / RIG_SCALE;
  const lower = low.map((l, k) => (pinned(k) ? 0 : flat[k] ? -FLOOR_MARGIN - l : Math.max(0, -FLOOR_MARGIN - l)));
  const upper = low.map((l, k) => (pinned(k) ? 0 : flat[k] ? tolerance - l : Infinity));
  let lift = low.map((l, k) => (pinned(k) ? 0 : flat[k] ? -l : Math.max(0, -FLOOR_MARGIN - l)));
  for (let pass = 0; pass < 12; pass += 1) {
    const smoothed = lift.map((value, k) => (lift[Math.max(0, k - 1)] + 2 * value + lift[Math.min(count - 1, k + 1)]) / 4);
    lift = smoothed.map((value, k) => Math.min(upper[k], Math.max(lower[k], value)));
  }
  offsetHips(target, frames, count, (k) => [0, lift[k], 0]);
  const metres = (value) => Math.round(value * RIG_SCALE * 1e4) / 1e4;
  return { liftMinMetres: metres(Math.min(...lift)), liftMaxMetres: metres(Math.max(...lift)) };
}

/** Height (metres) the axis of the fitted staff keeps above the floor (its radius is 1.2 cm). */
const STAFF_FLOOR_MARGIN = 0.03;
/** Bone axes the staff keeps out of: `[from joint, to joint, limb radius in metres]` (the staff's own radius included). */
const STAFF_BODY = [['Hips', 'Spine', 0.11], ['Spine', 'Spine1', 0.11], ['Spine1', 'Spine2', 0.12], ['Spine2', 'Neck', 0.11], ['Neck', 'Head', 0.08],
  ['LeftUpLeg', 'LeftLeg', 0.085], ['RightUpLeg', 'RightLeg', 0.085], ['LeftLeg', 'LeftFoot', 0.06], ['RightLeg', 'RightFoot', 0.06]];
/** The first 0.2 m of the shaft on either side of the fist are not tested against the body: the hand and forearm hold it there. */
const STAFF_HAND_SPAN = 0.2;

/**
 * The staff is fitted to the right fist at runtime (src/rendering/NativeHandGrip.ts), so its pose is the hand's. A fall or a rise swings the fist through poses that
 * drive an end of the 1.85 m shaft into the floor or through the body (the shaft pivots about the fist: its pommel side is 0.42 of it, its head side 0.58). This layer
 * turns the HAND about the wrist; arm and forearm keep the captured motion. Per frame it considers turns of the shaft direction (up to 72° in 4° steps, 16 azimuths)
 * and costs each by its angle, by how far it leaves the floor margin (`STAFF_FLOOR_MARGIN`) or a limb of `STAFF_BODY`, and by how far the hand would leave its joint
 * limit; a Viterbi pass over the frames picks the cheapest path with the smoothest change of turn (the correction eases in and out, and is zero where nothing is
 * wrong). `pinFirst` keeps frame 0 (the seam to a knockdown); frames from `pinFrom` on (a held lie) are copies of that frame. Returns the lowest staff point and
 * the closest the shaft comes to a limb axis before / after (metres) and the correction applied.
 */
function staffClearance(target, frames, count, limits, { pinFirst = false, pinFrom = count } = {}) {
  const hand = target.index.get('mixamorig:RightHand'), parent = target.parent[hand], track = frames.rotations[hand];
  const below = STAFF.grip * STAFF.length, above = (1 - STAFF.grip) * STAFF.length, margin = STAFF_FLOOR_MARGIN / RIG_SCALE;
  const last = Math.min(count - 1, pinFrom), limit = limits['mixamorig:RightHand'];
  const bones = STAFF_BODY.map(([from, to, radius]) => ({ from: target.index.get(`mixamorig:${from}`), to: target.index.get(`mixamorig:${to}`), radius: radius / RIG_SCALE }));
  const samples = [];
  // Samples every 1.5 cm along the shaft: a coarser step lets the shaft pass a limb between two samples.
  for (let t = -below; t <= above + 1e-9; t += 0.015 / RIG_SCALE) if (Math.abs(t) >= STAFF_HAND_SPAN / RIG_SCALE) samples.push(t);
  const handQ = new Quaternion(), parentQ = new Quaternion(), restInverse = target.restQuaternion[hand].clone().invert(), scratch = new Quaternion(), local = new Quaternion();
  const point = new Vector3(), a = new Vector3(), b = new Vector3(), ab = new Vector3();
  /** Measures the staff of one posed skeleton along `d` from `fist`: lowest point (rig units) and the deepest entry into a limb (rig units) over the samples. */
  const measure = (world, fist, d) => {
    const low = Math.min(fist.y - below * d.y, fist.y + above * d.y);
    let depth = 0, closest = Infinity;
    for (const bone of bones) {
      a.setFromMatrixPosition(world[bone.from]); b.setFromMatrixPosition(world[bone.to]); ab.subVectors(b, a);
      const lengthSq = ab.lengthSq();
      for (const t of samples) {
        point.copy(fist).addScaledVector(d, t);
        const u = Math.max(0, Math.min(1, point.sub(a).dot(ab) / lengthSq)), distance = point.addScaledVector(ab, -u).length();
        closest = Math.min(closest, distance - bone.radius); depth = Math.max(depth, bone.radius - distance);
      }
    }
    return { low, depth, closest };
  };
  const thetas = [0]; for (let degrees = 4; degrees <= 72; degrees += 4) thetas.push(degrees);
  const AZIMUTHS = 16, perFrame = [];
  const before = [], beforeBody = [];
  for (let k = 0; k <= last; k += 1) {
    const world = target.poseFrame(frames, k);
    quaternionOf(world[hand], handQ); quaternionOf(world[parent], parentQ);
    const fist = new Vector3().setFromMatrixPosition(world[hand]).add(grip.palm.clone().applyQuaternion(handQ)), d0 = grip.s.clone().applyQuaternion(handQ).normalize();
    const helper = Math.abs(d0.y) < 0.9 ? UP : new Vector3(1, 0, 0), u = new Vector3().crossVectors(d0, helper).normalize(), v = new Vector3().crossVectors(d0, u);
    const here = measure(world, fist, d0);
    before.push(here.low * RIG_SCALE); beforeBody.push(here.closest * RIG_SCALE);
    const candidates = [];
    for (const degrees of thetas) for (let step = 0; step < (degrees === 0 ? 1 : AZIMUTHS); step += 1) {
      if (pinFirst && k === 0 && degrees > 0) continue;
      const phi = step * 2 * Math.PI / AZIMUTHS, direction = u.clone().multiplyScalar(Math.cos(phi)).addScaledVector(v, Math.sin(phi));
      const d = d0.clone().multiplyScalar(Math.cos(degrees * DEG)).addScaledVector(direction, Math.sin(degrees * DEG));
      const turn = new Quaternion().setFromUnitVectors(d0, d), spin = new Vector3().crossVectors(d0, direction).multiplyScalar(degrees);
      const measured = measure(world, fist, d);
      local.copy(parentQ).invert().multiply(turn).multiply(handQ).normalize();
      const { swing, twist } = swingTwist(local, restInverse, scratch);
      const overLimit = Math.max(0, swing / DEG - 0.9 * limit.swing) + Math.max(0, Math.abs(twist) / DEG - 0.9 * limit.twist);
      const violation = Math.max(0, margin - measured.low) + measured.depth;
      // A turn past the hand's limit is priced well above a centimetre of clearance: the joint guard would clamp it afterwards and snap the staff between frames.
      candidates.push({ turn, spin, cost: degrees + 4000 * violation * RIG_SCALE + 40 * overLimit });
    }
    perFrame.push(candidates);
  }
  // Viterbi: the cheapest path of candidates, each change of turn between two ticks costing 2 per degree of rotation vector (a fall swings the fist fast;
  // a cheaper change lets the path jump between azimuths and snap the staff).
  const total = perFrame.map((candidates) => candidates.map(() => 0)), from = perFrame.map((candidates) => candidates.map(() => 0));
  total[0] = perFrame[0].map((candidate) => candidate.cost);
  for (let k = 1; k <= last; k += 1) {
    perFrame[k].forEach((candidate, j) => {
      let best = Infinity, arg = 0;
      perFrame[k - 1].forEach((previous, i) => { const value = total[k - 1][i] + 2 * previous.spin.distanceTo(candidate.spin); if (value < best) { best = value; arg = i; } });
      total[k][j] = best + candidate.cost; from[k][j] = arg;
    });
  }
  let pick = total[last].indexOf(Math.min(...total[last]));
  const chosen = [];
  for (let k = last; k >= 0; k -= 1) { chosen[k] = perFrame[k][pick]; pick = from[k][pick]; }
  const one = { rotations: target.names.map(() => undefined), positions: [] };
  one.rotations[hand] = new Float32Array(4);
  const handLimit = { 'mixamorig:RightHand': limit };
  let changed = 0, largest = 0;
  for (let k = 0; k <= last; k += 1) {
    const angle = chosen[k].turn.angleTo(new Quaternion());
    if (angle < 1e-4) continue;
    const world = target.poseFrame(frames, k);
    quaternionOf(world[hand], handQ); quaternionOf(world[parent], parentQ);
    parentQ.invert().multiply(chosen[k].turn).multiply(handQ).normalize().toArray(one.rotations[hand], 0);
    limitJoints(target, one, 1, handLimit);
    for (let c = 0; c < 4; c += 1) track[k * 4 + c] = one.rotations[hand][c];
    changed += 1; largest = Math.max(largest, angle / DEG);
  }
  for (let k = last + 1; k < count; k += 1) for (let c = 0; c < 4; c += 1) track[k * 4 + c] = track[last * 4 + c];
  const afterLow = [], afterBody = [];
  for (let k = 0; k < count; k += 1) {
    const world = target.poseFrame(frames, k);
    quaternionOf(world[hand], handQ);
    const fist = new Vector3().setFromMatrixPosition(world[hand]).add(grip.palm.clone().applyQuaternion(handQ)), measured = measure(world, fist, grip.s.clone().applyQuaternion(handQ).normalize());
    afterLow.push(measured.low * RIG_SCALE); afterBody.push(measured.closest * RIG_SCALE);
  }
  const round = (value) => Math.round(value * 1e3) / 1e3;
  return {
    lowestBeforeMetres: round(Math.min(...before)), lowestAfterMetres: round(Math.min(...afterLow)),
    deepestIntoLimbBeforeMetres: round(Math.max(0, -Math.min(...beforeBody))), deepestIntoLimbAfterMetres: round(Math.max(0, -Math.min(...afterBody))),
    framesTurned: changed, largestTurnDegrees: Math.round(largest * 10) / 10,
  };
}

/* ------------------------------------------------------------------ clip specs */

const specs = [];
const add = (clip, donor, animation, ticks, window, extra = {}) => specs.push({ clip, source: { donor, animation }, sim: { totalTicks: ticks }, window, ...extra });
/** Multi-donor clip: `parts` are `{ donor, animation, ticks: [from, to], keys | window, mirror? }` cross-faded at their boundaries. */
const compose = (clip, ticks, parts, extra = {}) => specs.push({ clip, sim: { totalTicks: ticks }, parts: parts.map(({ donor, animation, ...rest }) => ({ source: { donor, animation }, ...rest })), ...extra });
const LOCOMOTION = JOINT_LIMITS;

// Idle: the combat-ready stance of a staff fighter (a Viggle take): weight on the back leg, the staff held across her front in the right fist, head raised
// forward. Walk, run and jump keep the relaxed carry of the Tripo locomotion.
specs.push({ clip: 'aren-idle', source: { donor: 'mixamo', file: 'asset-source/viggle/y3-idle-1.glb', inPlace: true }, sim: { totalTicks: 240 }, window: [0.3, 3.7], loop: { overlapSeconds: 0.4 }, limits: LOCOMOTION, upright: 26 });
add('aren-walk', 'a', 'walk', 142, [0, 2.3666665554], { loop: { overlapSeconds: 0.1 }, limits: LOCOMOTION, arm: { follow: 0.5, pitchPerUnit: 90, keys: [{ t: 0, pose: 'carry' }] } });
add('aren-run', 'a', 'run', 76, [0, 1.26666665], { loop: { overlapSeconds: 0.1 }, limits: LOCOMOTION, arm: { follow: 0.45, pitchPerUnit: 50, keys: [{ t: 0, pose: 'carry', hand: [0.19, -0.1, 0.03] }] } });
add('aren-jump', 'b', 'jump', 42, [0, 2.23333335], { airborne: true, limits: LOCOMOTION, arm: { follow: 0.25, keys: [{ t: 0, pose: 'carry', w: 0.9 }] } });
// Petal Step (every evasion action plays it): two light steps forward with the staff across her body in both hands (a Viggle take, in place: the simulation
// moves her).
specs.push({ clip: 'aren-forward-left-dive-roll', source: { donor: 'mixamo', file: 'asset-source/viggle/y3-petal-step-2.glb', inPlace: true }, sim: { totalTicks: 42 }, window: [0.05, 1.9], airborne: true,
  upright: 26, clearStaff: true, idleBlendTail: 0.25 });
add('aren-hit', 'b', 'hurt', 24, [0, 1.4]);
add('aren-cheer', 'b', 'cheer', 300, [0, 5], { limits: LOCOMOTION });
add('aren-defeat', 'b', 'defeat_02', 360, [0, 8.46666622], { limits: LOCOMOTION });

// Knockdown / get-up: four 60 Hz clips (90 + 90 + 66 + 66 ticks) that play captured Mixamo reaction takes through the world-space retarget (mixamo-import.mjs
// facing/rest alignment). `reaction(take, keys)` is one part: `keys` are [tick, source seconds] of its monotone time warp. A knockdown starts standing in the idle's
// stance, falls, touches down by tick 30 and holds the lie exactly from tick 48 (`lie.holdFrom`; the last keys of the warp repeat one source time). A get-up
// (`getup`) starts on its knockdown's last frame, cross-fades over `blend` ticks into the take's own lying frames, rises, and from `idleFrom` on slerps into
// `aren-idle`'s first frame. Nothing is hand-keyed: the only edits are the time warps, one whole-body turn that points the take's lie the way the knockdown's lie
// points, a smooth slide of the Hips onto the standing XZ, the shared joint guard and the floor (Hips height only).
const reaction = (name, keys, extra = {}) => ({ source: { donor: `m:${name}`, animation: 'mixamo.com', file: `asset-source/mixamo/reactions/${name}.fbx` }, keys, retarget: {}, ticks: [0], ...extra });
const lieClip = (clip, ticks, parts, extra) => specs.push({ clip, sim: { totalTicks: ticks }, parts, limits: LOCOMOTION, ...extra });
const HOLD_FROM = 48, TRAVEL_METRES = 0.62;
lieClip('aren-knockdown', 90, [reaction('falling-back', [[0, 0.2], [6, 0.5], [17, 0.85], [30, 1.6], [HOLD_FROM, 2.55], [90, 2.55]])], { lie: { pose: 'back', holdFrom: HOLD_FROM, fromIdle: 6 }, travel: { maxMetres: TRAVEL_METRES } });
lieClip('aren-knockdown-forward', 90, [reaction('react-forward', [[0, 0.85], [12, 1.25], [22, 1.95], [30, 2.3], [HOLD_FROM, 3.4], [90, 3.4]])], { lie: { pose: 'stomach', holdFrom: HOLD_FROM, fromIdle: 8 }, travel: { maxMetres: TRAVEL_METRES } });
lieClip('aren-getup', 66, [reaction('getting-up-knocked', [[0, 0.25], [66, 2.0]])], { getup: { from: 'aren-knockdown', blend: 10, travel: [10, 40], idleFrom: 50 } });
lieClip('aren-getup-forward', 66, [
  reaction('getting-up-stomach', [[0, 2.45], [36, 3.3]]),
  reaction('getting-up-stomach', [[36, 4.25], [66, 5.05]], { ticks: [36] }),
], { getup: { from: 'aren-knockdown-forward', blend: 8, travel: [8, 46], idleFrom: 50 } });

// Heartroot skills. Release ticks are the simulation's (HEARTROOT_* / LIGHT_STEPS / SIGIL in src/game/combat): thorn bolts on tick 9/10/10, Root Spike on 20 (of 63),
// Eruption on 36 (of 76), Sap Lance launch on 16, Seed Storm launches on 12–42 every 6, Bloom meteors from 30 and its pulse on 132 (of 156).
const FACE = 28;
// Every Heartroot skill is a Viggle/PINOC text-to-motion take of a battle sorceress fighting with a quarterstaff, on the Mixamo rig
// (asset-source/viggle/y3-<name>.glb, ledger asset-source/viggle/provenance.json), played in place. The takes carry the staff: her right hand grips it
// near the middle and the left joins it on the shaft or casts with an open palm, so both arms play as captured; the runtime fist (finger chain wrapped
// around the shaft, src/rendering/NativeHandGrip.ts) holds the staff along her knuckle line, and `clearStaff` only turns the hand where the shaft would
// pass through her legs, trunk, head or the floor. Keyed warps ([tick, source seconds]) land each strike's fastest staff or palm motion on the
// simulation release tick. Thornshot 1–3 are one continuous three-strike take cut at its quiet instants (steps 2 and 3 open on the previous step's last
// pose, `seamFrom`); charges loop a held pose and their releases start from it the same way.
const VG = (name) => ({ donor: 'mixamo', file: `asset-source/viggle/${name}.glb`, inPlace: true });
const cast = (clip, name, ticks, extra) => specs.push({ clip, source: VG(name), sim: { totalTicks: ticks }, ...extra });
const LEFT = ['LeftHand'], RIGHT = ['RightHand'], BOTH = ['LeftHand', 'RightHand'];
// Thornshot 1–3 (y3-thornshot-1): an open-palm thrust at the enemy, a horizontal staff swing from right to left, an overhead whip of the staff head.
cast('yara-thornshot-1', 'y3-thornshot-1', 26, { sim: { totalTicks: 26, activeTick: 9 }, keys: [[0, 0.42], [9, 0.77], [22, 0.9], [26, 0.93]], contact: { joints: LEFT, search: [0.65, 0.9] } });
cast('yara-thornshot-2', 'y3-thornshot-1', 28, { sim: { totalTicks: 28, activeTick: 10 }, keys: [[0, 0.93], [10, 1.25], [24, 1.75], [28, 1.8]], contact: { joints: RIGHT, search: [1.1, 1.35] }, seamFrom: { clip: 'yara-thornshot-1', ticks: 4 } });
cast('yara-thornshot-3', 'y3-thornshot-1', 34, { sim: { totalTicks: 34, activeTick: 10 }, keys: [[0, 1.8], [10, 2.23], [34, 3.2]], contact: { joints: RIGHT, search: [2.1, 2.35] }, seamFrom: { clip: 'yara-thornshot-2', ticks: 4 }, idleBlendTail: 0.3 });
// Root Spike (y3-root-spike-2): the body plays the take's lift and lunge; the arm layer holds the staff upright in both fists (left below right), raised
// in front of her face, and drives its butt into the ground before her front foot on tick 20, held, lifted away (the take's own hands turn the shaft
// sideways across her head).
const RAISED_TWO = { pose: 'high', hand: [0.26, 0.21, 0.08], gw: 1, grip: -0.26, w: 1 };
const PLANT_TWO = { pose: 'plant', gw: 1, grip: -0.26, w: 1 };
const HOLD_TWO = { hand: [0.22, 0.02, 0.06], staff: [0, 88], gw: 1, grip: -0.26, w: 1 };
// (A key inherits every field it leaves out from the previous key, `w` included: these poses set `w: 1` so they follow a `w: 0` key.)
cast('yara-root-spike', 'y3-root-spike-2', 63, { sim: { totalTicks: 63, activeTick: 20 }, keys: [[0, 0.9], [17, 1.66], [20, 1.78], [23, 1.88], [40, 2.5], [63, 3.0]], contact: { joints: BOTH, search: [1.65, 1.9] }, idleBlendTail: 0.25,
  arm: { follow: 0, keys: [{ t: 0, ...HOLD_TWO, w: 0 }, { t: 9, ...HOLD_TWO }, { t: 14, ...RAISED_TWO }, { t: 17, ...RAISED_TWO }, { t: 20, ...PLANT_TWO }, { t: 40, ...PLANT_TWO }, { t: 63, ...PLANT_TWO, w: 0 }] } });
// Root charge (held): the staff upright before her chest in both hands, head lowered (y3-root-full-2). Heartroot Eruption is Root Spike's stab, slower,
// opening on the charge.
cast('yara-root-charge', 'y3-root-full-2', 90, { window: [0.6, 1.4], loop: { overlapSeconds: 0.2 }, arm: { follow: 0, keys: [{ t: 0, ...HOLD_TWO }] } });
cast('yara-root-eruption', 'y3-root-spike-2', 76, { sim: { totalTicks: 76, activeTick: 36 }, keys: [[0, 1.2], [33, 1.66], [36, 1.78], [39, 1.88], [55, 2.5], [76, 3.0]], contact: { joints: BOTH, search: [1.65, 1.9] }, seamFrom: { clip: 'yara-root-charge', ticks: 18 }, idleBlendTail: 0.25,
  arm: { follow: 0, keys: [{ t: 0, ...HOLD_TWO }, { t: 24, ...HOLD_TWO }, { t: 31, ...RAISED_TWO }, { t: 33, ...RAISED_TWO }, { t: 36, ...PLANT_TWO }, { t: 58, ...PLANT_TWO }, { t: 76, ...PLANT_TWO, w: 0 }] } });
// Seed charge (held) and Sap Lance are one take (y3-seed-full-3): the body plays the take's lance stance and lunge; the arm layer levels the staff at the
// enemy (the take's right hand turns it sideways): the right fist back at the hip line, the left hand forward on the shaft (`gw`, `grip` metres toward
// the head), driven to full reach on the release tick. Seed Storm (y3-seed-storm-3) opens on the same aim: the staff swung above her head, then three
// flicked volleys at the enemy.
const AIM = { hand: [0.2, -0.04, 0.06], staff: [0, 6], gw: 1, grip: 0.36, w: 1 };
const THRUST = { hand: [0.33, 0.0, 0.04], staff: [0, 4], gw: 1, grip: 0.36, w: 1 };
cast('yara-seed-charge', 'y3-seed-full-3', 90, { window: [0.9, 1.7], loop: { overlapSeconds: 0.2 }, arm: { follow: 0, keys: [{ t: 0, ...AIM }] } });
cast('yara-sap-lance', 'y3-seed-full-3', 30, { sim: { totalTicks: 30, activeTick: 16 }, keys: [[0, 1.75], [13, 2.3], [16, 2.43], [19, 2.52], [30, 3.0]], contact: { joints: BOTH, search: [2.25, 2.55] }, seamFrom: { clip: 'yara-seed-charge', ticks: 6 }, idleBlendTail: 0.3,
  arm: { follow: 0, keys: [{ t: 0, ...AIM }, { t: 12, ...AIM, hand: [0.14, -0.04, 0.06] }, { t: 16, ...THRUST }, { t: 22, ...THRUST }, { t: 30, ...AIM }] } });
cast('yara-seed-storm', 'y3-seed-storm-3', 60, { keys: [[0, 0.4], [12, 0.95], [42, 2.9], [60, 3.4]], seamFrom: { clip: 'yara-seed-charge', ticks: 8 }, idleBlendTail: 0.25 });
// Binding Vines (y3-binding-vines-2): the open left hand shot at the enemy on tick 18, then the fist yanked back to the hip; the staff stays upright at her
// right side through the cast (the take swings it down behind her).
cast('yara-binding-vines', 'y3-binding-vines-2', 54, { sim: { totalTicks: 54, activeTick: 18 }, keys: [[0, 0.05], [18, 0.37], [40, 2.6], [54, 3.0]], contact: { joints: LEFT, search: [0.25, 0.5] }, idleBlendTail: 0.3,
  arm: { follow: 0.25, keys: [{ t: 0, pose: 'carry', w: 0 }, { t: 8, pose: 'carry', w: 1 }, { t: 44, pose: 'carry', w: 1 }, { t: 54, pose: 'carry', w: 0 }] } });
// Cleanse (y3-cleanse-2): the staff planted upright beside her right foot, the open left palm raised forward, channelling.
cast('yara-cleanse', 'y3-cleanse-2', 108, { window: [0.05, 4.0], idleBlendTail: 0.2 });
// Heartroot Bloom (y3-bloom-1): the staff raised high in both hands, the invocation, then swung down to strike the ground for the final pulse on tick 132.
cast('yara-heartroot-bloom', 'y3-bloom-1', 156, { keys: [[0, 0.1], [30, 1.2], [124, 3.25], [132, 3.46], [156, 4.9]], idleBlendTail: 0.15 });
// Second jump ("treading the wind"): two air steps, a somersault tuck, open-out and a soft landing, in place.
compose('aren-air-step', 60, [
  { donor: 'd', animation: 'run_upstairs', window: [0, 0.8], ticks: [0, 60] },
  { donor: 'd', animation: 'flip', keys: [[0, 0.9], [26, 1.2], [38, 2.2], [60, 3.4]], ticks: [14, 60] },
  { donor: 'b', animation: 'jump', window: [1.2, 2.2], ticks: [40, 60] },
], { airborne: true, idleBlendTail: 0.3, crossfadeTicks: 4, pin: { maxVertical: 0.08 }, arm: { follow: 0.3, keys: [{ t: 0, pose: 'carry', w: 0.8 }, { t: 14, w: 0.8 }, { t: 24, w: 0.2 }, { t: 44, w: 0.2 }, { t: 54, w: 0.8 }, { t: 60, w: 0.8 }] } });

// Every skill faces the target along the simulation's facing, and keeps the trunk within UPRIGHT_DEGREES of vertical (a caster stands tall).
const UPRIGHT_DEGREES = 26;
for (const spec of specs) if (spec.clip.startsWith('yara-')) { spec.facing = FACE; spec.upright = UPRIGHT_DEGREES; spec.clearStaff = true; }
// Every clip built from donor motion keeps the arms out of the trunk, head and legs (arm-body-clearance.mjs); the captured knockdown and get-up takes are left as recorded.
for (const spec of specs) if (!spec.lie && !spec.getup) spec.clearArms = true;

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
await resolveMixamoSources(specs, rigs, root);
const grip = handAnatomy(baseGlb, 'Right'), leftGrip = handAnatomy(baseGlb, 'Left');
const context = { target, grip, leftGrip };
/** The Mixamo reaction donors (asset-source/mixamo/reactions/<name>.fbx; ledger in asset-source/mixamo/provenance.json): the fall, lie and get-up takes. Only the takes a clip plays are loaded. */
const REACTION_FILES = ['knocked-out-back', 'falling-back', 'flying-back', 'react-backward', 'getting-up-back', 'stand-up-back', 'kip-up',
  'fall-flat-hit-back', 'knocked-down-stomach', 'react-forward', 'getting-up-stomach', 'stand-up-stomach', 'getting-up-knocked'];
const soles = soleKit(target, baseGlb);
/** Every vertex of the whole mesh (not only the soles): the floor contact of the lying clips (a sparser sample misses the leaf hem and the boots' toes). */
const body = soleKit(target, baseGlb, { stride: 1, all: true });
const usedReactions = new Set(specs.flatMap((spec) => (spec.parts ?? []).map((part) => part.source.donor.slice(2))));
for (const aid of [option('lie-timeline')?.split(':')[1], option('probe')?.split(':')[0]]) if (aid) usedReactions.add(aid);
const mixamoProvenance = {};
for (const name of REACTION_FILES.filter((item) => usedReactions.has(item))) {
  const file = `asset-source/mixamo/reactions/${name}.fbx`, donor = await loadMixamoDonor(file, { root, target });
  rigs[`m:${name}`] = donor.rig;
  mixamoProvenance[name] = { file, sha256: donor.sha256, durationSeconds: Math.round(donor.duration * 1e4) / 1e4, frames: donor.frames, facingDegrees: donor.facingDegrees };
}

// Authoring aid: `--lie-timeline=m:<take>[:from:to]` prints, every 1/30 s on this rig, the Hips position in metres (x, height, z), the forward axis of the chest in
// world space (y > 0.7: on the back, y < -0.7: on the stomach, ≈ 0: upright), the lean of Hips → Neck from vertical, the lie heading, the head height, the lowest
// skinned vertex above the floor (cm) and its bone, and the lowest sole.
if (option('lie-timeline')) {
  const [, name, from, to] = option('lie-timeline').split(':'), donor = `m:${name}`, decoded = rigs[donor].decodeAnimation('mixamo.com'), n = Math.round(decoded.duration * 30) + 1;
  const frames = retargetAligned(target, rigs[donor], decoded, n, (k) => decoded.duration * k / (n - 1));
  console.log(`${donor} ${decoded.duration.toFixed(3)} s · t hipsX hipsY hipsZ (m) torsoFwdY lean(deg) lieAxis(deg) headY(m) lowestVertex(cm) bone lowestSole(cm)`);
  for (let k = 0; k < n; k += 1) {
    const t = decoded.duration * k / (n - 1);
    if ((from !== undefined && t < Number(from)) || (to !== undefined && t > Number(to))) continue;
    const world = target.poseFrame(frames, k), p = new Vector3().setFromMatrixPosition(world[target.index.get('mixamorig:Hips')]), head = new Vector3().setFromMatrixPosition(world[target.index.get('mixamorig:Head')]);
    const torso = torsoFrame(target, world);
    console.log(t.toFixed(2), (p.x * RIG_SCALE).toFixed(2), (p.y * RIG_SCALE).toFixed(2), (p.z * RIG_SCALE).toFixed(2), torso.forward.y.toFixed(2), (torso.up.angleTo(UP) / DEG).toFixed(0), torso.axis.toFixed(0),
      (head.y * RIG_SCALE).toFixed(2), ((body.lowest(frames, k) - body.rest) * RIG_SCALE * 100).toFixed(1), body.lowestBone(frames, k), ((soles.lowest(frames, k) - soles.rest) * RIG_SCALE * 100).toFixed(1));
  }
  process.exit(0);
}

// Authoring aid: `--probe=<take>:<from s>:<to s>[:ticks]` writes /tmp/yara-probe.glb with that stretch of a reaction take on this rig (no guard, no floor fix), `ticks`
// long (default: real time), as clip `probe` for `render-clip-preview.mjs`.
if (option('probe')) {
  const [name, from, to, ticks = String(Math.round((Number(to) - Number(from)) * TICKS_PER_SECOND))] = option('probe').split(':');
  const probe = buildLieClip({ clip: 'probe', sim: { totalTicks: Number(ticks) }, parts: [reaction(name, [[0, Number(from)], [Number(ticks), Number(to)]])] });
  const glb = parseGlb(appendClips(base, [probe])), index = glb.json.nodes.length;
  glb.json.nodes.push({ name: 'YaraForward', rotation: [0, -Math.SQRT1_2, 0, Math.SQRT1_2], children: glb.json.scenes[0].nodes });
  glb.json.scenes[0].nodes = [index];
  await writeFile('/tmp/yara-probe.glb', encodeGlb(glb.json, glb.bin));
  process.exit(0);
}

/* ------------------------------------------------------------------ knockdown / get-up clips */

/**
 * A knockdown or get-up part sequence at 60 Hz (one frame per simulation tick). `parts` are donor segments `{ source, keys: [[tick, seconds]], retarget: { yaw },
 * ticks: [from] }` cross-faded as complete captured poses at each later part's first tick. Edits: the time warp, and `travel` (the Hips' horizontal path
 * scaled to at most `travel.maxMetres` from the standing XZ).
 */
function buildLieClip(spec) {
  const totalTicks = spec.sim.totalTicks, count = totalTicks + 1, crossfade = spec.crossfadeTicks ?? 3;
  let frames;
  spec.parts.forEach((part, index) => {
    const donor = rigs[part.source.donor], sampled = retargetAligned(target, donor, decodedOf(donor, part.source.animation), count, timeWarp(part.keys), part.retarget);
    if (index === 0) { frames = sampled; return; }
    const boundary = part.ticks[0];
    for (let k = 0; k < count; k += 1) { const s = smooth((k - (boundary - crossfade)) / (2 * crossfade)); if (s > 0) blendInto(frames, sampled, k, k, s); }
  });
  if (spec.travel) spec.travelScale = Math.round(limitTravel(target, frames, count, spec.travel.maxMetres) * 1e4) / 1e4;
  return { spec, frames, times: Float32Array.from({ length: count }, (_, k) => k / TICKS_PER_SECOND), count, duration: totalTicks / TICKS_PER_SECOND, keys: [], contact: undefined, totalTicks, jointNodes: [...target.joints], aim: undefined, guard: {} };
}

/**
 * A get-up (`spec.getup`): the rise of the take(s) `spec.parts` on this rig, in five edits (the first two here, the rest in `makeLieClip`).
 *  1. The take is turned about the vertical so its lie points the way the knockdown's held lie does (measured, not typed): no facing flip.
 *  2. The Hips' horizontal path is one smooth slide over `travel` ticks from where the knockdown left them (up to 0.7 m from the standing XZ) onto the standing XZ;
 *     their vertical motion stays the take's own.
 *  3. The take is put on the floor (`floorCorrect`) on its own.
 *  4. Over `blend` ticks the knockdown's held lie (`knock`'s last frame, frame 0 of this clip) is cross-faded into the take's own lying frames (lying to lying).
 *  5. The last quarter is slerped into `aren-idle`'s first frame (`blendIdle`).
 * The joint guard runs on the take alone, before step 4: the soft joint guard is not idempotent, so frame 0 stays the knockdown's last frame exactly.
 */
function buildGetup(spec, knock, idle) {
  const part = spec.parts[0], last = knock.count - 1, { travel } = spec.getup;
  const donor = rigs[part.source.donor], decoded = decodedOf(donor, part.source.animation);
  const lie = retargetAligned(target, donor, decoded, 1, () => part.keys[0][1], part.retarget);
  const donorAxis = torsoFrame(target, target.poseFrame(lie, 0)).axis, knockAxis = torsoFrame(target, target.poseFrame(knock.frames, last)).axis;
  const yaw = Math.round(wrapDegrees(knockAxis - donorAxis) * 10) / 10;
  for (const each of spec.parts) each.retarget = { ...each.retarget, yaw };
  const clip = buildLieClip(spec), { frames, count } = clip;
  clip.corrections = guardJoints(target, frames, count, spec.limits);
  const stand = hipsWorld(target, idle.frames, 0), home = hipsWorld(target, knock.frames, last), [from, to] = travel;
  offsetHips(target, frames, count, (k, p) => {
    const ramp = smooth((k - from) / (to - from));
    return [home.x + (stand.x - home.x) * ramp - p.x, 0, home.z + (stand.z - home.z) * ramp - p.z];
  });
  return clip;
}

/** The last quarter of a get-up (`from` = its first tick) slerps, whole body, into `aren-idle`'s first frame: the last frame IS that frame. */
function blendIdle(frames, count, idle, from) {
  for (let k = from; k < count; k += 1) blendInto(frames, idle.frames, k, 0, smooth((k - from) / (count - 1 - from)));
}

/** Largest rotation difference between two frames (degrees, over every rotation track) and the Hips' position difference (millimetres). */
function frameDelta(framesA, ka, framesB, kb) {
  const a = new Quaternion(), b = new Quaternion(), hips = target.index.get('mixamorig:Hips');
  let rotation = 0;
  framesA.rotations.forEach((track, node) => { if (track && framesB.rotations[node]) rotation = Math.max(rotation, a.fromArray(track, ka * 4).normalize().angleTo(b.fromArray(framesB.rotations[node], kb * 4).normalize())); });
  const position = new Vector3().fromArray(framesA.positions[hips], ka * 3).distanceTo(new Vector3().fromArray(framesB.positions[hips], kb * 3));
  return { rotationDegrees: rotation / DEG, hipsMillimetres: position * RIG_SCALE * 1e3 };
}

/** Largest per-tick rotation step (degrees) of any joint between ticks `from` and the last. */
function maxJointStep(frames, count, from) {
  const a = new Quaternion(), b = new Quaternion();
  let worst = 0;
  for (const track of frames.rotations) if (track) for (let k = Math.max(1, from); k < count; k += 1) worst = Math.max(worst, a.fromArray(track, (k - 1) * 4).normalize().angleTo(b.fromArray(track, k * 4).normalize()));
  return worst / DEG;
}

/** The take's playback speed against real time: per part, the fastest keyed stretch. */
function sourceTimeScale(spec) {
  return spec.parts.map((part) => {
    const keys = part.keys, speeds = keys.slice(1).map(([tick, time], i) => (time - keys[i][1]) / ((tick - keys[i][0]) / TICKS_PER_SECOND)).filter((speed) => Number.isFinite(speed));
    return { take: part.source.donor.slice(2), fromSeconds: keys[0][1], toSeconds: keys.at(-1)[1], fastestKeyedStretch: Math.round(Math.max(...speeds) * 100) / 100 };
  });
}

/**
 * The measurements of the brief's acceptance list for one knockdown / get-up clip. Heights are of the Hips joint ("pelvis") in metres; floor clearances are of the
 * lowest skinned vertex of the whole mesh above the floor, in centimetres; a frame "lies" when the torso is flat (|forward.y| > 0.7) and the pelvis is below 30 cm.
 */
function lieReport(spec, clip, knock, idle, corrections) {
  const hips = target.index.get('mixamorig:Hips'), stand = hipsWorld(target, (idle ?? clip).frames, 0), rows = [];
  for (let k = 0; k < clip.count; k += 1) {
    const world = target.poseFrame(clip.frames, k), torso = torsoFrame(target, world), p = new Vector3().setFromMatrixPosition(world[hips]);
    rows.push({ k, pelvis: p.y * RIG_SCALE, x: p.x, z: p.z, facing: torso.forward.y, lean: torso.up.angleTo(UP) / DEG, lowest: (body.lowest(clip.frames, k) - body.rest) * RIG_SCALE * 100 });
  }
  const round = (value, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;
  const lying = rows.filter((row) => Math.abs(row.facing) > 0.7 && row.pelvis < 0.3);
  const rest = target.restWorldPosition[hips];
  const result = {
    ticks: clip.totalTicks,
    pelvisMetresAtTick0: round(rows[0].pelvis), leanDegreesAtTick0: round(rows[0].lean, 1),
    pelvisMetresAtTick30: round(rows[30].pelvis),
    lyingFacing: round(rows[spec.lie ? spec.lie.holdFrom : 0].facing, 2),
    floorLowestVertexCm: { overAllFrames: round(Math.min(...rows.map((row) => row.lowest)), 2), lyingFramesMin: round(Math.min(...lying.map((row) => row.lowest)), 2), lyingFramesMax: round(Math.max(...lying.map((row) => row.lowest)), 2) },
    maxHipsHorizontalOffsetMetres: round(Math.max(...rows.map((row) => Math.hypot(row.x - rest.x, row.z - rest.z))) * RIG_SCALE),
    jointGuard: { jointsCorrected: Object.values(corrections).filter((degrees) => degrees > 0).length, maxCorrectionDegrees: round(Math.max(0, ...Object.values(corrections)), 2) },
    floor: spec.floor,
    staff: spec.staff,
  };
  if (spec.lie) {
    // Ground contact: the first tick at which the pelvis is at or below 25 cm and never again rises above 30 cm (a settle/bounce of a few centimetres is allowed).
    const hold = spec.lie.holdFrom, groundTick = rows.findIndex((row, k) => row.pelvis <= 0.25 && rows.slice(k).every((later) => later.pelvis <= 0.3));
    // "Every key identical": compared component by component on the stored (float32) tracks, not through an angle.
    const component = (tracks, size) => { let worst = 0; for (const track of tracks) if (track) for (let k = hold + 1; k < clip.count; k += 1) for (let c = 0; c < size; c += 1) worst = Math.max(worst, Math.abs(track[k * size + c] - track[hold * size + c])); return worst; };
    const maxRotation = component(clip.frames.rotations, 4), maxHips = component(clip.frames.positions, 3);
    Object.assign(result, {
      groundContactTick: groundTick,
      pelvisMetresAtContactTick: round(rows[groundTick].pelvis),
      pelvisMetresMaxFromContactOn: round(Math.max(...rows.slice(groundTick).map((row) => row.pelvis))),
      pelvisMetresInLie: round(rows[hold].pelvis),
      heldRange: { fromTick: hold, toTick: clip.count - 1, maxRotationComponentDelta: maxRotation, maxHipsComponentDelta: maxHips, identical: maxRotation === 0 && maxHips === 0 },
      lieHipsOffsetFromStandingMetres: { back: round((rest.x - rows[hold].x) * RIG_SCALE), side: round((rows[hold].z - rest.z) * RIG_SCALE) },
    });
  }
  if (spec.getup) {
    const seam = frameDelta(clip.frames, 0, knock.frames, knock.count - 1), end = frameDelta(clip.frames, clip.count - 1, idle.frames, 0);
    Object.assign(result, {
      seamFromKnockdown: { rotationDegrees: round(seam.rotationDegrees, 4), hipsMillimetres: round(seam.hipsMillimetres, 4) },
      idleEnd: { rotationDegrees: round(end.rotationDegrees, 4), hipsMillimetres: round(end.hipsMillimetres, 4) },
      endHipsXZOffsetFromStandingMillimetres: round(Math.hypot(rows.at(-1).x - stand.x, rows.at(-1).z - stand.z) * RIG_SCALE * 1e3, 3),
      maxJointStepLastQuarterDegreesPerTick: round(maxJointStep(clip.frames, clip.count, Math.round((clip.count - 1) * 0.75)), 3),
      sourceTimeScale: sourceTimeScale(spec),
    });
  }
  return result;
}

/** Builds one clip (memoised: a get-up needs its knockdown and the idle, which are themselves clips of the set). */
const clips = [], report = {}, produced = new Map();
const specOf = (name) => specs.find((item) => item.clip === name);
function produce(spec) {
  if (!produced.has(spec.clip)) produced.set(spec.clip, spec.lie || spec.getup ? makeLieClip(spec) : makeClip(spec));
  return produced.get(spec.clip);
}

/** Slerps the last `tail` share of a clip's frames into the idle's first frame (smoothstep), so a strike hands back to the idle stance instead of freezing in its follow-through. */
function blendTailToIdle(clip, idle, tail) {
  const from = Math.floor(clip.count * (1 - tail)), a = new Quaternion(), b = new Quaternion();
  for (let k = from; k < clip.count; k += 1) {
    const x = Math.min(1, Math.max(0, (k - from) / Math.max(1, clip.count - 1 - from))), w = x * x * (3 - 2 * x);
    clip.frames.rotations.forEach((track, node) => {
      const rest = idle.frames.rotations[node];
      if (!track || !rest) return;
      a.fromArray(track, k * 4); b.fromArray(rest, 0);
      a.slerp(b, w).toArray(track, k * 4);
    });
    clip.frames.positions.forEach((track, node) => {
      const rest = idle.frames.positions[node];
      if (!track || !rest) return;
      for (let c = 0; c < 3; c += 1) track[k * 3 + c] += (rest[c] - track[k * 3 + c]) * w;
    });
  }
}

function makeClip(spec) {
  const clip = buildClip(spec, rigs);
  if (spec.idleBlendTail) blendTailToIdle(clip, produce(specOf('aren-idle')), spec.idleBlendTail);
  const limits = spec.limits ?? COMBAT_LIMITS;
  if (spec.pin) pinHips(target, clip.frames, clip.count, spec.pin.maxVertical);
  if (spec.upright) limitLean(target, clip.frames, clip.count, spec.upright);
  if (spec.facing !== undefined) faceForward(target, clip.frames, clip.count, spec.facing);
  let staffTilt;
  if (spec.arm) staffTilt = armLayer(context, clip.frames, clip.count, spec.arm, limits);
  // Loops keep their seam bit-exact: the pass is a pure function of a frame, but the time smoothing is not periodic, so loops skip it.
  const armClearance = spec.clearArms ? clearArms(target, clip.frames, clip.count, { smooth: spec.loop ? 0 : 0.5 }) : undefined;
  // Skills: the staff shaft is kept out of her legs, trunk and the floor by turning the hand (the same layer the falls use).
  const staffReport = spec.clearStaff ? staffClearance(target, clip.frames, clip.count, spec.limits ?? COMBAT_LIMITS, { pinFirst: Boolean(spec.loop) }) : undefined;
  if (process.env.YARA_DEBUG) { const pre = jointExcursions(target, clip.frames, clip.count, limits); console.error(spec.clip, 'pre-limit', JSON.stringify(Object.fromEntries(Object.entries(pre).filter(([j]) => /Right(Arm|ForeArm|Hand|Shoulder)|Left(Arm|ForeArm|Hand)/.test(j)).map(([j, e]) => [j.replace('mixamorig:', ''), [Math.round(e.swing), Math.round(e.twist)]])))); }
  if (process.env.YARA_TRACE === spec.clip) {
    for (let k = 0; k < clip.count; k += 1) {
      const one = { rotations: clip.frames.rotations.map((track) => (track ? track.slice(k * 4, k * 4 + 4) : undefined)), positions: [] };
      const e = jointExcursions(target, one, 1, { 'mixamorig:RightHand': limits['mixamorig:RightHand'], 'mixamorig:RightForeArm': limits['mixamorig:RightForeArm'], 'mixamorig:RightArm': limits['mixamorig:RightArm'] });
      console.error(k, JSON.stringify(Object.fromEntries(Object.entries(e).map(([j, v]) => [j.slice(13), [Math.round(v.swing), Math.round(v.twist)]]))));
    }
  }
  const corrections = limitJoints(target, clip.frames, clip.count, limits);
  // A release that follows a held charge starts on the charge loop's pose and blends into its own motion over `seamFrom.ticks`.
  if (spec.seamFrom) {
    const from = produce(specOf(spec.seamFrom.clip)), n = Math.max(1, Math.round(spec.seamFrom.ticks * FPS / TICKS_PER_SECOND));
    for (let k = 0; k < Math.min(n, clip.count); k += 1) blendInto(clip.frames, from.frames, k, from.count - 1, 1 - smooth(k / n));
  }
  continuity(clip.frames, clip.count);
  if (process.env.YARA_STAFF === spec.clip) staffTrace(context, clip.frames, clip.count).forEach((e, k) => { if (k % 2 === 0) console.error('tick', k * 2, 'yaw', e.yaw.toFixed(0), 'pitch', e.pitch.toFixed(0), 'tilt', e.tilt.toFixed(0), 'pommelY', e.pommelY.toFixed(2), 'headY', e.headY.toFixed(2)); });
  const excursions = jointExcursions(target, clip.frames, clip.count, limits);
  const worst = Object.entries(excursions).map(([joint, e]) => ({ joint: joint.replace('mixamorig:', ''), swing: e.swing, twist: e.twist }));
  report[spec.clip] = {
    limits: limits === JOINT_LIMITS ? 'JOINT_LIMITS' : limits === COMBAT_LIMITS ? 'COMBAT_LIMITS' : 'custom',
    peakSwing: Math.round(Math.max(...worst.map((e) => e.swing)) * 10) / 10, peakTwist: Math.round(Math.max(...worst.map((e) => e.twist)) * 10) / 10,
    ...(staffTilt ? { staffTiltMax: Math.round(Math.max(...staffTilt) * 10) / 10, staffTiltMean: Math.round(staffTilt.reduce((s, v) => s + v, 0) / staffTilt.length * 10) / 10 } : {}),
    corrections,
    ...(armClearance ? { armClearance } : {}),
    ...(staffReport ? { staffClearance: staffReport } : {}),
    ...(spec.pin ? { hipsTravel: (() => { const t = hipsTravel(target, clip.frames, clip.count); return { horizontalMetres: Math.round(t.horizontal * RIG_SCALE * 1e4) / 1e4, verticalMetres: Math.round(t.vertical * RIG_SCALE * 1e4) / 1e4 }; })() } : {}),
  };
  return clip;
}

function makeLieClip(spec) {
  const limits = spec.limits;
  const knock = spec.getup ? produce(specOf(spec.getup.from)) : undefined, idle = spec.getup || spec.lie?.fromIdle ? produce(specOf('aren-idle')) : undefined;
  const clip = spec.getup ? buildGetup(spec, knock, idle) : buildLieClip(spec);
  // A knockdown starts where the hero stands: its first frame is `aren-idle`'s first frame, cross-faded over `fromIdle` ticks into the take's own stance.
  if (spec.lie?.fromIdle) for (let k = 0; k < spec.lie.fromIdle; k += 1) blendInto(clip.frames, idle.frames, k, 0, 1 - smooth(k / spec.lie.fromIdle));
  const corrections = spec.getup ? clip.corrections : guardJoints(target, clip.frames, clip.count, limits);
  // Lying clips keep their vertical Hips motion (the fall reaches the floor, the rise leaves it); only the lowest skinned vertex of the WHOLE mesh is held to the floor,
  // frame by frame. A knockdown is grounded as a whole (its lie is held from `holdFrom`). A get-up is grounded as the bare take first, then the knockdown's lie (already
  // grounded) is blended in, then the last quarter into the idle, and a last pass lifts what the blends pushed into the floor and seats the flat frames (the idle itself rests
  // 1.0-1.3 cm below the bind-pose floor, so the last frame is lifted onto the floor guard instead of being pinned to the idle's height). The staff layer runs last: it
  // reads the final Hips heights.
  if (spec.getup) {
    const taken = floorCorrect(target, clip.frames, clip.count, body);
    for (let k = 0; k < spec.getup.blend; k += 1) blendInto(clip.frames, knock.frames, k, knock.count - 1, 1 - smooth(k / spec.getup.blend));
    blendIdle(clip.frames, clip.count, idle, spec.getup.idleFrom);
    spec.floor = { take: taken, final: keepAboveFloor(target, clip.frames, clip.count, body, { pinFirst: true }) };
  } else spec.floor = floorCorrect(target, clip.frames, clip.count, body, { holdFrom: spec.lie.holdFrom });
  spec.staff = staffClearance(target, clip.frames, clip.count, limits, { pinFirst: Boolean(spec.getup), pinFrom: spec.lie?.holdFrom });
  // The staff pass turns the right hand, and a turned fist can dip below the floor: a get-up is lifted once more (frame 0 stays the knockdown's last frame).
  if (spec.getup) spec.floor.afterStaff = keepAboveFloor(target, clip.frames, clip.count, body, { pinFirst: true });
  continuity(clip.frames, clip.count);
  // The held lie is one pose: every key from `holdFrom` on is a copy of that key (the per-frame passes above can differ in the last float bit).
  if (spec.lie) for (const track of [...clip.frames.rotations, ...clip.frames.positions]) if (track) { const size = track.length / clip.count; for (let k = spec.lie.holdFrom + 1; k < clip.count; k += 1) track.copyWithin(k * size, spec.lie.holdFrom * size, (spec.lie.holdFrom + 1) * size); }
  const excursions = jointExcursions(target, clip.frames, clip.count, limits);
  const worst = Object.entries(excursions).map(([joint, e]) => ({ joint: joint.replace('mixamorig:', ''), swing: e.swing, twist: e.twist }));
  report[spec.clip] = {
    limits: 'JOINT_LIMITS',
    peakSwing: Math.round(Math.max(...worst.map((e) => e.swing)) * 10) / 10, peakTwist: Math.round(Math.max(...worst.map((e) => e.twist)) * 10) / 10,
    corrections,
    lie: lieReport(spec, clip, knock, idle, corrections),
  };
  return clip;
}

for (const spec of specs.filter((item) => !only || only.includes(item.clip))) clips.push(produce(spec));

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
// Brief §Contract: aren-knockdown / aren-knockdown-forward / aren-getup / aren-getup-forward resolve to their authored clips.
mapping['aren-knockdown'] = 'aren-knockdown';
mapping['aren-knockdown-forward'] = 'aren-knockdown-forward';
mapping['aren-getup'] = 'aren-getup';
mapping['aren-getup-forward'] = 'aren-getup-forward';
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
// The envelope is her native locomotion: the clips delivered now and, for the evasion clip that was re-authored from the native Tripo dive roll into the Mixamo
// forward bound, the native dive's own measurement in the baseline (the native skin was approved at that stretch; the bound stays below it).
const ceiling = Math.max(...locomotion.map((name) => Math.max(deformation[name].p999, baseline[name]?.deformation?.p999 ?? 0)));
const anatomy = {
  schemaVersion: 1,
  grip: {
    staffDiagonalDegrees: STAFF_DIAGONAL / DEG, staffToMiddleFingerDegrees: Math.acos(grip.s.dot(grip.fingers)) / DEG, staffToPrincipalAxisDegrees: Math.acos(grip.s.dot(grip.d)) / DEG, middleFingerHand: grip.fingers.toArray().map((v) => Math.round(v * 1e6) / 1e6), staffAxisHand: grip.s.toArray().map((v) => Math.round(v * 1e6) / 1e6),
    palmHand: grip.palm.toArray().map((v) => Math.round(v * 1e6) / 1e6), shaftRadiusRig: Math.round(grip.shaftRadius * 1e6) / 1e6, metacarpalHand: grip.d.toArray().map((v) => Math.round(v * 1e6) / 1e6),
    thumbSideHand: grip.thumb.toArray().map((v) => Math.round(v * 1e6) / 1e6), palmNormalHand: grip.n.toArray().map((v) => Math.round(v * 1e6) / 1e6),
  },
  deformationCeiling: { clips: locomotion, includesBaseline: true, p999: ceiling },
  clips: Object.fromEntries(clips.map((clip) => [clip.spec.clip, { ...report[clip.spec.clip], deformation: deformation[clip.spec.clip], before: baseline[clip.spec.clip] ?? null }])),
};
await writeFile(root + output + '/anatomy-report.json', JSON.stringify(anatomy, null, 2) + '\n');
await writeFile(root + output + '/provenance.json', JSON.stringify({
  schemaVersion: 1, originalModelTask: 'f5c49b45-1eee-47e7-84fc-e6e592ae5c29', tasks, sources, presets, sourceHash: hash(base), outputHash: hash(bytes),
  operation: 'Offline Tripo animation retarget with the shared Rig/buildClip/appendClips/limitJoints toolkit; the staff arm is authored by a two-bone solve with the fixed-fist grip of src/rendering/NativeHandGrip.ts; the knockdown / get-up clips additionally retarget four Mixamo FBX takes via the reaction-batch loader with rest alignment and heading turn, time-warped onto the simulation timelines and joint-held; original native skinned Yara mesh retained.',
  grip: anatomy.grip, credits, mixamo: mixamoProvenance, creditTotal: Object.values(credits).reduce((sum, value) => sum + value, 0), evidenceStatus: 'blocked',
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
    ['knockdown-side', 'side', ['aren-knockdown', 'aren-knockdown-forward', 'aren-getup', 'aren-getup-forward'], 10],
    ['knockdown-front', 'front', ['aren-knockdown', 'aren-knockdown-forward', 'aren-getup', 'aren-getup-forward'], 10],
    ['knockdown-iso', 'iso', ['aren-knockdown', 'aren-knockdown-forward', 'aren-getup', 'aren-getup-forward'], 10],
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
