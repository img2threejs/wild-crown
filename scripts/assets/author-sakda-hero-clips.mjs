import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Matrix4, PropertyBinding, Quaternion, Vector3 } from 'three';
import { parseGlb, encodeGlb } from './import-aren-animation-set.mjs';
import { readAccessorAny } from './creature-rig-kit.mjs';
import { Rig, buildClip, appendClips, limitJoints, jointExcursions, skinDeformationReport, JOINT_LIMITS, COMBAT_LIMITS } from './retarget-aren-tripo-clips.mjs';
import { loadMixamoDonor } from './mixamo-import.mjs';

/**
 * Builds Sakda's Ember Fist clip set on his native 23-joint Tripo skeleton (rig-v1.0, spec mixamo) from captured motion only.
 *
 * Every clip plays a real motion source, chosen in this order: (1) a Tripo preset that Tripo retargeted onto this very rig (played raw), (2) a Mixamo
 * FBX (Y Bot, "Without Skin", 30 fps) loaded by `mixamo-import.mjs`, which turns it to the rig's heading and aligns its T-pose rest onto this rig's
 * A-pose. The only edits are light ones: a monotone time warp that lands the contact surface on the simulation's strike tick, a facing fix, in-place
 * pinning of the Hips' horizontal travel, a constant ground shift, a lowered jump apex (`lift`), removal of measured vertical root drift from gait loops,
 * seamless loop seams, cross-fades between consecutive real segments, whole-body sagittal mirrors for left elbows, and the shared soft joint guard.
 * There is no IK, stance-widening or hand-keyed pose layer. Sakda is barehanded: no weapon layer.
 *
 * Run: `node scripts/assets/author-sakda-hero-clips.mjs [--only=a,b] [--previews]`; `--timeline=<donor>:<animation>[:yaw[:mirror]]` (Mixamo:
 * `--timeline=m:<file>`) prints a retargeted source for authoring. Deterministic; reruns are byte-identical.
 * `--measure-gaits` prints 60 Hz moving-runtime cadence and skinned-sole measurements without writing assets; `--root-binding` loads the real hierarchy
 * through GLTFLoader to measure its runtime joint name. `--preview-crops` splits existing previews into readable panels without changing projection.
 * Nothing under asset-source/playtests/ is touched: the entry is only emitted as `manifest-entry.json`. The Mixamo FBX never ship: only the retargeted
 * clips end up in the hero GLB.
 * Knockdown / get-up (aren-knockdown, aren-knockdown-forward, aren-getup, aren-getup-forward): shared Mixamo reaction takes, see `lieClip` and the brief; `--lie-timeline=m:<take>`
 * and `--probe=<take>:<from>:<to>` are authoring aids for them.
 */
const args = process.argv.slice(2);
const root = fileURLToPath(new URL('../../', import.meta.url));
const DEG = Math.PI / 180;
const TICKS_PER_SECOND = 60;
const MODEL_TASK = 'e43e454e-0f8e-4fd9-b284-f838ca4ed685';
const rigPath = 'asset-source/generated/actor-sakda-hero-mixamo-rig-01/tripo-out/actor-sakda-hero-mixamo-rig-01-f646d7e4/model.glb';
const sources = {
  a: 'asset-source/generated/actor-sakda-hero-anim-a-01/tripo-out/actor-sakda-hero-anim-a-01-2-3127d082/model.glb',
  b: 'asset-source/generated/actor-sakda-hero-anim-b-01/tripo-out/actor-sakda-hero-anim-b-01-af7f38b5/model.glb',
  c: 'asset-source/generated/actor-sakda-hero-anim-c-01/tripo-out/actor-sakda-hero-anim-c-01-743269a9/model.glb',
  d: 'asset-source/generated/actor-sakda-hero-anim-d-01/tripo-out/actor-sakda-hero-anim-d-01-1238e5c9/model.glb',
  e: 'asset-source/generated/actor-sakda-hero-anim-e-01/tripo-out/actor-sakda-hero-anim-e-01-f9166626/model.glb',
  f: 'asset-source/generated/actor-sakda-hero-anim-f-01/tripo-out/actor-sakda-hero-anim-f-01-b4d07cc5/model.glb',
};
const tasks = {
  concept: '11d45f4c-6085-4b96-92da-eba90451eb68', model: MODEL_TASK, rig: 'f646d7e4-8001-47d5-823f-df5d96a5b509',
  a: '3127d082-8a72-4816-964d-e4f30c075f9d', b: 'af7f38b5-5da3-45d7-a2b6-84cebb96f881', c: '743269a9-bb7f-4e64-94bd-71ff496944f2',
  d: '1238e5c9-da53-42ff-9fb4-36e6ca606811', e: 'f9166626-20c8-4e01-acee-6028fae0b05d', f: 'b4d07cc5-6aba-4cb5-9a32-403dd7e90c53',
};
const presets = {
  a: ['idle', 'walk', 'run', 'box_01', 'box_02'], b: ['jump', 'dive', 'hurt', 'cheer', 'defeat_02'],
  c: ['box_03', 'front_kick_01', 'front_kick_02', 'hit_to_body_01', 'hit_to_stomach'],
  d: ['flip', 'volleyball', 'flee_02', 'run_upstairs', 'lift_heavy'], e: ['golf', 'pitch_baseball', 'standing_relax', 'chop', 'slash'],
  f: ['warm_up', 'jump_down', 'hit_to_head', 'hit_to_side', 'bow'],
};
/**
 * Credits of every Tripo task of this hero. `discarded`: the first rig (rig-v2.5, bone_N names) and its one retarget batch, superseded by rig-v1.0.
 * `tooling`: the one-preset FBX export of this rig ordered by the Mixamo-import worker as the loader's test file (not a clip source).
 */
const credits = { concept: 15, model: 70, rig: 25, a: 50, b: 50, c: 50, d: 50, e: 50, f: 50 };
const discarded = { rigV25: { task: '03c68e55-d7c1-4c34-bb8b-4593671c4744', credits: 25 }, animA: { task: '48e96a33-323f-4a89-a9f4-15fe7ab524f0', credits: 50 } };
const tooling = { mixamoImportFbxProof: { task: 'e9c57a60-591f-4317-9d91-76775470d1f2', credits: 10, presets: ['front_kick_01'], outFormat: 'fbx' } };
/** Mixamo FBX donors (asset-source/mixamo/sakda/<name>.fbx; catalogue ids and hashes in asset-source/mixamo/provenance.json). */
const MIXAMO_FILES = ['fight-idle-guard-up', 'jab-cross-medium', 'elbow-uppercut', 'elbow-cross', 'muay-thai-knee', 'roundhouse-rear', 'flying-knee-punch', 'stomp-hard',
  'boxing-step-forward-long'];
/** Shared Mixamo reaction donors (asset-source/mixamo/reactions/<name>.fbx, hero "shared-reactions" in the provenance): the fall, lie and get-up takes. */
const REACTION_FILES = ['knocked-out-back', 'falling-back', 'flying-back', 'react-backward', 'getting-up-back', 'stand-up-back', 'kip-up',
  'fall-flat-hit-back', 'knocked-down-stomach', 'react-forward', 'getting-up-stomach', 'stand-up-stomach', 'getting-up-knocked'];
const output = 'asset-source/generated/actor-sakda-hero-01';
/** Sakda stands 0.979 rig units tall; ×1.84 gives the 1.80 m hero (Aren and Yara use 1.7 for their 1.0-unit bodies). */
const RIG_SCALE = 1.84;

/* ------------------------------------------------------------------ kick limits */

/**
 * Muay Thai kicks swing the thigh and fold the knee beyond the native locomotion envelope (JOINT_LIMITS: UpLeg 129°, Leg 150°, Foot 56°). The Tripo
 * kick presets of this hero (front_kick_01/02, flip) were measured on the retargeted skeleton; KICK_LIMITS raises a joint above JOINT_LIMITS only as far
 * as those native presets need, with the same ceil((peak + 0.05°) / 0.9) soft-knee rule as NATIVE_LIMIT_RAISES. It is the soft guard of every motion clip.
 */
const KICK_RAISES = { UpLeg: { swing: 150, twist: 60 }, Leg: { twist: 18 }, Foot: { swing: 62, twist: 52 }, Spine: { swing: 42 }, Spine1: { swing: 42 }, Spine2: { swing: 42 } };
const KICK_LIMITS = Object.freeze(Object.fromEntries(Object.entries(JOINT_LIMITS).map(([joint, limit]) => {
  const short = joint.replace('mixamorig:', '').replace(/^(Left|Right)/, '');
  const raise = KICK_RAISES[short];
  return [joint, Object.freeze({ swing: raise?.swing ?? limit.swing, twist: raise?.twist ?? limit.twist })];
})));

/* ------------------------------------------------------------------ geometry helpers */

const UP = new Vector3(0, 1, 0);
const smooth = (x) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
const quaternionOf = (matrix, out = new Quaternion()) => out.setFromRotationMatrix(matrix);
const yawQ = (degrees) => new Quaternion().setFromAxisAngle(UP, degrees * DEG);

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

/** Hips travel in world rig units: `{ horizontal, vertical }` peak-to-peak range over the frames. */
function hipsTravel(target, frames, count) {
  const hips = target.index.get('mixamorig:Hips'), low = new Vector3(Infinity, Infinity, Infinity), high = new Vector3(-Infinity, -Infinity, -Infinity), p = new Vector3();
  for (let k = 0; k < count; k += 1) { p.setFromMatrixPosition(target.poseFrame(frames, k)[hips]); low.min(p); high.max(p); }
  return { horizontal: Math.hypot(high.x - low.x, high.z - low.z), vertical: high.y - low.y };
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
  return { up, right, forward, axis: Math.atan2(-head.z, head.x) / DEG, horizontalHead: Math.hypot(head.x, head.z) };
}

/** In-place (shared-toolkit clips): the hips keep their first-frame horizontal position and their vertical excursion is compressed to at most `maxVertical`. */
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

/** Monotone time warp through `keys` ([tick, value]); clamped outside the keys unless `extend` (loops) continues the last segment linearly. */
function timeWarp(keys, extend = false) {
  const times = keys.map((key) => key[0]), values = keys.map((key) => key[1]), n = keys.length;
  if (n === 1) return () => values[0];
  return (tick) => {
    if (tick <= times[0]) return values[0];
    if (tick >= times[n - 1]) return extend ? values[n - 1] + (tick - times[n - 1]) * (values[n - 1] - values[n - 2]) / (times[n - 1] - times[n - 2]) : values[n - 1];
    return monotoneAt(times, values, tick);
  };
}

/* ------------------------------------------------------------------ real motion (Tripo presets on this rig, Mixamo FBX) */

/**
 * Real-motion retarget onto the native rig, sampled at 60 Hz: every target joint with a donor partner takes the donor's world rotation away from its rest,
 *   W_t = P · Δ · R_t,   Δ = W_d · R_d⁻¹,
 * where P is the part's facing fix (a whole-body turn about the vertical, `yaw` degrees, + = toward the actor's left). Tripo presets were retargeted by
 * Tripo onto this very rig, so they play raw; Mixamo donors arrive from `loadMixamoDonor(file, { target })` already turned to the rig's heading and with
 * their T-pose rest aligned bone by bone onto this rig's A-pose rest, so the same formula applies. `mirror` reflects the motion across the rig's sagittal
 * plane (z = 0 here: the rig faces +X, its right is +Z), left/right partners swapping. The Hips translation is the donor's displacement (P-turned, scaled
 * by the hip-height ratio) relative to the first sampled frame horizontally.
 */
const mirrorName = (name) => name.replace(/^(mixamorig:)(Left|Right)/, (_, prefix, side) => prefix + (side === 'Left' ? 'Right' : 'Left'));
function retargetAligned(target, donor, decoded, count, sourceTime, { yaw = 0, mirror = false } = {}) {
  const partners = new Map();
  for (const i of target.joints) {
    const j = donor.index.get(mirror ? mirrorName(target.names[i]) : target.names[i]);
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
        if (mirror) delta.set(-delta.x, -delta.y, delta.z, delta.w);
        world.copy(P).multiply(delta).multiply(target.restWorldQuaternion[i]).normalize();
      } else world.copy(parentQ).multiply(target.restQuaternion[i]);
      worldQ[i].copy(world);
      local.copy(parentQ).invert().multiply(world).normalize().toArray(rotations[i], k * 4);
    }
    displacement.setFromMatrixPosition(donorWorld[donorHips]).sub(donor.restWorldPosition[donorHips]);
    if (mirror) displacement.z = -displacement.z;
    displacement.multiplyScalar(hipScale);
    if (k === 0) base.set(displacement.x, 0, displacement.z);
    displacement.sub(base).applyQuaternion(P).add(target.restWorldPosition[hips]).applyMatrix4(hipsParentInverse).toArray(positions[hips], k * 3);
  }
  return { rotations, positions };
}

/**
 * Source-time keys that are measured, not typed: `peak(joints, search)` is the source time inside `search` at which the joints reach farthest forward on
 * the target (relative to the Hips, after the part's turn); `floor(joints, search)` is the first source time the joints reach their lowest point (a stomp).
 */
const peak = (joints, search, metric = 'forward') => ({ metric, joints, search });
const floor = (joints, search) => ({ metric: 'floor', joints, search });
function resolveSourceKey(target, part, donor, decoded, key) {
  const [from, to] = key.search, n = Math.max(2, Math.round((to - from) * 240) + 1);
  const time = (k) => from + (to - from) * k / (n - 1);
  const frames = retargetAligned(target, donor, decoded, n, time, part.retarget);
  const ids = key.joints.map((name) => target.index.get(`mixamorig:${name}`)), hips = target.index.get('mixamorig:Hips'), p = new Vector3();
  const samples = Array.from({ length: n }, (_, k) => {
    const world = target.poseFrame(frames, k), origin = p.setFromMatrixPosition(world[hips]).x;
    const values = ids.map((id) => p.setFromMatrixPosition(world[id])[key.metric === 'floor' ? 'y' : 'x']);
    return key.metric === 'floor' ? Math.min(...values) : (key.metric === 'shin' ? values.reduce((a, b) => a + b, 0) / values.length : Math.max(...values)) - origin;
  });
  if (key.metric === 'floor') { const lowest = Math.min(...samples); return Math.round(time(samples.findIndex((y) => y <= lowest + 0.004)) * 1e4) / 1e4; }
  return Math.round(time(samples.indexOf(Math.max(...samples))) * 1e4) / 1e4;
}

const decodedCache = new Map();
function decodedOf(donor, animation) {
  if (!decodedCache.has(donor)) decodedCache.set(donor, new Map());
  const map = decodedCache.get(donor);
  if (!map.has(animation)) map.set(animation, donor.decodeAnimation(animation));
  return map.get(animation);
}

/** Frames of one donor part over `count` ticks (source time by its warp); measured keys are resolved once and kept on the part for the provenance. */
function sampleDonorPart(target, rigs, part, count, extend) {
  const donor = rigs[part.source.donor], decoded = decodedOf(donor, part.source.animation);
  part.resolvedKeys ??= part.keys.map(([tick, value]) => [tick, typeof value === 'number' ? value : resolveSourceKey(target, part, donor, decoded, value)]);
  return retargetAligned(target, donor, decoded, count, timeWarp(part.resolvedKeys, extend), part.retarget);
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
 * The soles of the native mesh: every 4th vertex whose dominant skin weight is a Foot or ToeBase bone, with what is needed to CPU-skin them. `lowest`
 * gives the lowest skinned sole height of one frame; `rest` is the bind pose's (the floor).
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
  const lowestOf = (world, coordinates = false) => {
    skinJoints.forEach((node, j) => matrices[j].multiplyMatrices(world[node], inverse.fromArray(inverseBind, j * 16)));
    let lowest = Infinity;
    lowestVertex = -1;
    const vertices = coordinates ? new Float64Array(soles.length * 3) : undefined;
    let index = 0;
    for (const v of soles) {
      let x = 0, y = 0, z = 0;
      for (let s = 0; s < 4; s += 1) {
        const w = weights[v * 4 + s];
        if (w <= 0) continue;
        const e = matrices[joints[v * 4 + s]].elements;
        y += w * (e[1] * positions[v * 3] + e[5] * positions[v * 3 + 1] + e[9] * positions[v * 3 + 2] + e[13]);
        if (coordinates) {
          x += w * (e[0] * positions[v * 3] + e[4] * positions[v * 3 + 1] + e[8] * positions[v * 3 + 2] + e[12]);
          z += w * (e[2] * positions[v * 3] + e[6] * positions[v * 3 + 1] + e[10] * positions[v * 3 + 2] + e[14]);
        }
      }
      if (y < lowest) { lowest = y; lowestVertex = v; }
      if (vertices) { vertices[index++] = x; vertices[index++] = y; vertices[index++] = z; }
    }
    return vertices ?? lowest;
  };
  const dominantBone = (v) => { let best = 0; for (let s = 1; s < 4; s += 1) if (weights[v * 4 + s] > weights[v * 4 + best]) best = s; return target.names[skinJoints[joints[v * 4 + best]]].replace('mixamorig:', ''); };
  return { rest: lowestOf(target.restWorld), lowest: (frames, k) => lowestOf(target.poseFrame(frames, k)), lowestBone: (frames, k) => { lowestOf(target.poseFrame(frames, k)); return dominantBone(lowestVertex); },
    vertices: (frames, k) => lowestOf(target.poseFrame(frames, k), true) };
}

/** Hips height offset that puts the clip's lowest skinned sole (any frame) on the floor: one constant shift, the motion is untouched. */
function groundShift(soles, frames, count) {
  let lowest = Infinity;
  for (let k = 0; k < count; k += 1) lowest = Math.min(lowest, soles.lowest(frames, k));
  return soles.rest - lowest;
}

/**
 * A real-motion clip at 60 Hz (one frame per simulation tick). `parts` are donor segments `{ source: { donor, animation }, keys: [[tick, seconds | peak |
 * floor]], retarget: { yaw, mirror }, ticks: [from] }` cross-faded as complete captured poses at each later part's first tick. Edits: the time warp;
 * `pin` (no horizontal Hips travel: the engine moves the actor); `lift` ([tick, rig units] keys added to the
 * Hips height, to lower a donor's jump apex); `loop: { overlapTicks }` (the head fades from the tail's continuation, so the last frame equals the first).
 * The joint guard and the ground shift (the lowest skinned sole touches the floor) follow in the build loop.
 */
function buildMotionClip(spec, target, rigs) {
  const totalTicks = spec.sim.totalTicks, count = totalTicks + 1, overlap = spec.loop?.overlapTicks ?? 0, raw = count + overlap;
  const crossfade = spec.crossfadeTicks ?? 3;
  let frames;
  spec.parts.forEach((part, index) => {
    const sampled = sampleDonorPart(target, rigs, part, raw, Boolean(spec.loop));
    if (index === 0) { frames = sampled; return; }
    const boundary = part.ticks[0];
    for (let k = 0; k < raw; k += 1) { const s = smooth((k - (boundary - crossfade)) / (2 * crossfade)); if (s > 0) blendInto(frames, sampled, k, k, s); }
  });
  if (spec.loop?.verticalDetrend) {
    const hips = target.index.get('mixamorig:Hips');
    const first = new Vector3().setFromMatrixPosition(target.poseFrame(frames, 0)[hips]);
    const last = new Vector3().setFromMatrixPosition(target.poseFrame(frames, totalTicks)[hips]);
    spec.verticalDriftRemovedRigUnits = last.y - first.y;
    offsetHips(target, frames, raw, (k) => [0, -spec.verticalDriftRemovedRigUnits * k / totalTicks, 0]);
  }
  for (let k = 0; k < overlap; k += 1) blendInto(frames, frames, k, k + totalTicks, smooth(1 - k / overlap));
  if (raw !== count) {
    for (const list of [frames.rotations, frames.positions]) list.forEach((track, node) => { if (track) list[node] = track.slice(0, count * (list === frames.rotations ? 4 : 3)); });
  }
  const hips = target.index.get('mixamorig:Hips');
  if (spec.pin) {
    const start = new Vector3().fromArray(frames.positions[hips], 0).applyMatrix4(target.restWorld[target.parent[hips]]);
    offsetHips(target, frames, count, (k, p) => [start.x - p.x, 0, start.z - p.z]);
  }
  if (spec.lift) { const lift = timeWarp(spec.lift); offsetHips(target, frames, count, (k) => [0, lift(k), 0]); }
  if (spec.travel) spec.travelScale = Math.round(limitTravel(target, frames, count, spec.travel.maxMetres) * 1e4) / 1e4;
  return { spec, frames, times: Float32Array.from({ length: count }, (_, k) => k / TICKS_PER_SECOND), count, duration: totalTicks / TICKS_PER_SECOND, keys: [], contact: undefined, totalTicks, jointNodes: [...target.joints], aim: undefined, guard: {} };
}


/**
 * The shared soft joint guard (`limitJoints`), applied so that a clamp stays local: walking the skeleton from the Hips outwards, every joint first resumes its
 * captured world orientation under its (possibly already clamped) parent and is then clamped to its own limit. A donor's clavicle or spine twist beyond the
 * table is thus reduced where it occurs, and the joints beyond it absorb the difference in their own local rotation (inside their own limits), without swinging
 * the whole arm or chest away from the captured motion. A joint whose parent kept its captured world keeps its rotation bit for bit, so a pose that is inside
 * every limit is untouched. Every joint ends inside its limit (the clamp is the last step on each joint). Returns the largest correction per joint (degrees).
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

/** Tick of the contact of `joints` within `radius` ticks of `around` (frames are ticks): farthest forward (+X), or the first arrival at the floor. */
function strikeTick(target, clip, joints, around, radius, metric = 'forward') {
  const ids = joints.map((joint) => target.index.get(`mixamorig:${joint}`)), p = new Vector3(), rows = [];
  for (let k = Math.max(0, around - radius); k <= Math.min(clip.count - 1, around + radius); k += 1) {
    const world = target.poseFrame(clip.frames, k);
    const xs = ids.map((id) => p.setFromMatrixPosition(world[id]).x);
    rows.push({ k, x: metric === 'shin' ? xs.reduce((a, b) => a + b, 0) / xs.length : Math.max(...xs), y: Math.min(...ids.map((id) => p.setFromMatrixPosition(world[id]).y)) });
  }
  if (metric === 'floor') { const lowest = Math.min(...rows.map((row) => row.y)); const row = rows.find((item) => item.y <= lowest + 0.004); return { tick: row.k, value: row.y }; }
  const best = rows.reduce((a, b) => (b.x > a.x ? b : a));
  return { tick: best.k, value: best.x };
}

/** Measurements of the built frames, not pose assumptions. Heights and seam position are rig units; stance width is measured sideways, not along a step. */
function motionQuality(target, clip, soles) {
  const at = (world, name) => new Vector3().setFromMatrixPosition(world[target.index.get(`mixamorig:${name}`)]);
  let lowestSole = Infinity, bothWristsAboveHead = -Infinity, minimumStanceWidth = Infinity, minimumWristAboveJaw = Infinity;
  for (let k = 0; k < clip.count; k += 1) {
    const world = target.poseFrame(clip.frames, k), head = at(world, 'Head'), left = at(world, 'LeftHand'), right = at(world, 'RightHand');
    lowestSole = Math.min(lowestSole, soles.lowest(clip.frames, k));
    bothWristsAboveHead = Math.max(bothWristsAboveHead, Math.min(left.y, right.y) - head.y);
    minimumWristAboveJaw = Math.min(minimumWristAboveJaw, left.y - head.y, right.y - head.y);
    const lf = at(world, 'LeftFoot'), rf = at(world, 'RightFoot');
    if (lf.y <= 0.06 && rf.y <= 0.06) minimumStanceWidth = Math.min(minimumStanceWidth, Math.abs(lf.z - rf.z));
  }
  const a = new Quaternion(), b = new Quaternion();
  let seamRotation = 0, seamPosition = 0, maximumJointStep = 0;
  for (const track of clip.frames.rotations) if (track) {
    seamRotation = Math.max(seamRotation, a.fromArray(track, 0).angleTo(b.fromArray(track, (clip.count - 1) * 4)));
    for (let k = 1; k < clip.count; k += 1) maximumJointStep = Math.max(maximumJointStep, a.fromArray(track, (k - 1) * 4).angleTo(b.fromArray(track, k * 4)));
  }
  for (const track of clip.frames.positions) if (track) seamPosition = Math.max(seamPosition, new Vector3().fromArray(track, 0).distanceTo(new Vector3().fromArray(track, (clip.count - 1) * 3)));
  const round = (value) => Math.round(value * 1e6) / 1e6;
  return {
    sampledFrames: clip.count, lowestSole: round(lowestSole), bothWristsAboveHead: round(bothWristsAboveHead), minimumWristAboveJaw: round(minimumWristAboveJaw),
    minimumGroundedStanceWidthMetres: Number.isFinite(minimumStanceWidth) ? round(minimumStanceWidth * RIG_SCALE) : null,
    seamRotationRadians: round(seamRotation), seamPositionMetres: round(seamPosition * RIG_SCALE),
    maximumJointStepDegreesPerTick: round(maximumJointStep / DEG / (clip.totalTicks / (clip.count - 1))),
  };
}

/* ------------------------------------------------------------------ knockdown / get-up (Mixamo reaction takes) */

const hipsWorld = (target, frames, k) => new Vector3().setFromMatrixPosition(target.poseFrame(frames, k)[target.index.get('mixamorig:Hips')]);
const wrapDegrees = (degrees) => ((((degrees + 180) % 360) + 360) % 360) - 180;
/** A skinned vertex within this height of the floor counts as touching it (rig units; 3 cm). */
const FLOOR_CONTACT = 0.03 / RIG_SCALE;
/** The lowest skinned vertex may dip this far below the floor at most (rig units; 3.7 mm, inside the brief's 1 cm). */
const FLOOR_MARGIN = 0.002;

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
 * or the torso is flat on the floor. In between (the fall, the flight of a kip-up) the donor's own height is kept, the lift is smoothed so the Hips do not
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
  for (let pass = 0; pass < 3; pass += 1) {
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

/** The first `count` ticks of the Hips' world XZ, and the standing XZ, in rig units. */
const standingXZ = (target, idle) => hipsWorld(target, idle.frames, 0);

/**
 * A get-up (`spec.getup`): the rise of the Mixamo take(s) `spec.parts` on this rig, in four edits.
 *  1. The take is turned about the vertical so its lie points the way the knockdown's held lie does (measured, not typed): no facing flip.
 *  2. The Hips' horizontal path is one smooth slide over `travel` ticks from where the knockdown left them (up to 0.7 m from the standing XZ) onto the standing XZ;
 *     their vertical motion stays the take's own.
 *  3. Over `blend` ticks the knockdown's held lie (`knock`'s last frame, frame 0 of this clip) is cross-faded into the take's own lying frames (lying to lying).
 *  4. (in `blendIdle`, after the floor) the last quarter is slerped into `aren-idle`'s first frame.
 * The joint guard runs on the take alone, before step 3 (see below).
 */
function buildGetup(spec, target, rigs, knock, idle) {
  const part = spec.parts[0], last = knock.count - 1, { blend, travel } = spec.getup;
  const donor = rigs[part.source.donor], decoded = decodedOf(donor, part.source.animation);
  const lie = retargetAligned(target, donor, decoded, 1, () => part.keys[0][1], { mirror: part.retarget.mirror });
  const donorAxis = torsoFrame(target, target.poseFrame(lie, 0)).axis, knockAxis = torsoFrame(target, target.poseFrame(knock.frames, last)).axis;
  const yaw = Math.round(wrapDegrees(knockAxis - donorAxis) * 10) / 10;
  for (const each of spec.parts) each.retarget = { ...each.retarget, yaw };
  const clip = buildMotionClip(spec, target, rigs), { frames, count } = clip;
  // The soft joint guard is not idempotent (it compresses a pose inside its knee a second time), so the take is guarded BEFORE the knockdown's already guarded
  // lie is blended in: frame 0 stays the knockdown's last frame exactly.
  clip.corrections = guardJoints(target, frames, count, spec.limits);
  const stand = standingXZ(target, idle), home = hipsWorld(target, knock.frames, last), [from, to] = travel;
  offsetHips(target, frames, count, (k, p) => {
    const ramp = smooth((k - from) / (to - from));
    return [home.x + (stand.x - home.x) * ramp - p.x, 0, home.z + (stand.z - home.z) * ramp - p.z];
  });
  for (let k = 0; k < blend; k += 1) blendInto(frames, knock.frames, k, last, 1 - smooth(k / blend));
  return clip;
}

/** The last quarter of a get-up (`from` = its first tick) slerps, whole body, into `aren-idle`'s first frame: the last frame IS that frame. */
function blendIdle(target, frames, count, idle, from) {
  for (let k = from; k < count; k += 1) blendInto(frames, idle.frames, k, 0, smooth((k - from) / (count - 1 - from)));
}

/** Largest rotation difference between two frames (degrees, over every rotation track) and the Hips' position difference (metres). */
function frameDelta(target, framesA, ka, framesB, kb) {
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

/** The take's playback speed against real time: the mean over the whole rise, and the fastest stretch between two keys (a take played in two parts: per part). */
function sourceTimeScale(spec) {
  const parts = spec.parts.map((part) => {
    const keys = part.resolvedKeys ?? part.keys, speeds = keys.slice(1).map(([tick, time], i) => (time - keys[i][1]) / ((tick - keys[i][0]) / TICKS_PER_SECOND)).filter((speed) => Number.isFinite(speed));
    return { take: part.source.donor.slice(2), fromSeconds: keys[0][1], toSeconds: keys.at(-1)[1], fastestKeyedStretch: Math.round(Math.max(...speeds) * 100) / 100 };
  });
  return parts;
}

/**
 * The measurements of the brief's acceptance list for one knockdown / get-up clip. Heights are of the Hips joint ("pelvis") in metres; floor clearances are of the
 * lowest skinned vertex of the whole mesh above the floor, in centimetres; a frame "lies" when the torso is flat (|forward.y| > 0.7) and the pelvis is below 30 cm.
 */
function lieReport(spec, target, clip, kit, knock, idle, corrections) {
  const hips = target.index.get('mixamorig:Hips'), stand = standingXZ(target, { frames: (idle ?? clip).frames }), rows = [];
  for (let k = 0; k < clip.count; k += 1) {
    const world = target.poseFrame(clip.frames, k), torso = torsoFrame(target, world), p = new Vector3().setFromMatrixPosition(world[hips]);
    rows.push({ k, pelvis: p.y * RIG_SCALE, x: p.x, z: p.z, facing: torso.forward.y, lowest: (kit.lowest(clip.frames, k) - kit.rest) * RIG_SCALE * 100 });
  }
  const round = (value, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;
  const lying = rows.filter((row) => Math.abs(row.facing) > 0.7 && row.pelvis < 0.3);
  const rest = target.restWorldPosition[hips];
  const result = {
    ticks: clip.totalTicks,
    pelvisMetresAtTick30: round(rows[30].pelvis),
    lyingFacing: round(rows[spec.lie ? spec.lie.holdFrom : 0].facing, 2),
    floorLowestVertexCm: { overAllFrames: round(Math.min(...rows.map((row) => row.lowest)), 2), lyingFramesMin: round(Math.min(...lying.map((row) => row.lowest)), 2), lyingFramesMax: round(Math.max(...lying.map((row) => row.lowest)), 2) },
    maxHipsHorizontalOffsetMetres: round(Math.max(...rows.map((row) => Math.hypot(row.x - rest.x, row.z - rest.z))) * RIG_SCALE),
    jointGuard: { jointsCorrected: Object.values(corrections).filter((degrees) => degrees > 0).length, maxCorrectionDegrees: round(Math.max(0, ...Object.values(corrections)), 2) },
    floor: spec.floor,
  };
  if (spec.lie) {
    // Ground contact: the first tick at which the pelvis is at or below 25 cm and never again rises above 30 cm (a settle/bounce of a few centimetres is allowed).
    const hold = spec.lie.holdFrom, groundTick = rows.findIndex((row, k) => row.pelvis <= 0.25 && rows.slice(k).every((later) => later.pelvis <= 0.3));
    // "Every key identical": compared component by component on the stored (float32) tracks, not through an angle.
    let maxRotation = 0, maxHips = 0;
    const component = (tracks, size) => { let worst = 0; for (const track of tracks) if (track) for (let k = hold + 1; k < clip.count; k += 1) for (let c = 0; c < size; c += 1) worst = Math.max(worst, Math.abs(track[k * size + c] - track[hold * size + c])); return worst; };
    maxRotation = component(clip.frames.rotations, 4); maxHips = component(clip.frames.positions, 3);
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
    Object.assign(result, {
      seamFromKnockdown: Object.fromEntries(Object.entries(frameDelta(target, clip.frames, 0, knock.frames, knock.count - 1)).map(([key, value]) => [key, round(value, 4)])),
      idleEnd: Object.fromEntries(Object.entries(frameDelta(target, clip.frames, clip.count - 1, idle.frames, 0)).map(([key, value]) => [key, round(value, 4)])),
      endHipsXZOffsetFromStandingMillimetres: round(Math.hypot(rows.at(-1).x - stand.x, rows.at(-1).z - stand.z) * RIG_SCALE * 1e3, 3),
      maxJointStepLastQuarterDegreesPerTick: round(maxJointStep(clip.frames, clip.count, Math.round((clip.count - 1) * 0.75)), 3),
      sourceTimeScale: sourceTimeScale(spec),
    });
  }
  return result;
}

/** Mirrors existing runtime root pinning and cadence (ActorAnimationDriver / AnimationController), plus the unchanged engine's steady forward motor. */
function movingGait(target, clip, speed) {
  const hips = target.index.get('mixamorig:Hips'), period = clip.count - 1, count = period * 2 + 1, track = clip.frames.positions[hips];
  const sourceSpeed = Math.hypot(track[period * 3] - track[0], track[period * 3 + 2] - track[2]) * RIG_SCALE / clip.duration;
  const rate = sourceSpeed > 0.05 ? speed / sourceSpeed : 1, dt = clip.duration / period / rate;
  const repeat = (tracks, size) => tracks.map((source) => {
    if (!source) return undefined;
    const out = new Float32Array(count * size);
    for (let k = 0; k < count; k += 1) out.set(source.subarray((k % period) * size, (k % period) * size + size), k * size);
    return out;
  });
  const frames = { rotations: repeat(clip.frames.rotations, 4), positions: repeat(clip.frames.positions, 3) };
  const parentWorld = target.restWorld[target.parent[hips]], up = new Vector3(0, 1, 0).transformDirection(parentWorld.clone().invert()), bind = target.restPosition[hips];
  for (let k = 0; k < count; k += 1) {
    const p = new Vector3().fromArray(frames.positions[hips], k * 3), vertical = p.sub(bind).dot(up);
    p.copy(bind).addScaledVector(up, vertical).toArray(frames.positions[hips], k * 3);
  }
  offsetHips(target, frames, count, (k) => [speed * k * dt / RIG_SCALE, 0, 0]);
  return { ...clip, spec: { ...clip.spec, clip: `${clip.spec.clip}-moving-${speed}mps` }, frames, count,
    times: Float32Array.from({ length: count }, (_, k) => k * dt), duration: (count - 1) * dt, runtimeRate: rate, motorSpeed: speed };
}

/** Tangential travel of actual sole vertices while they remain within 2.2 cm of the floor, across two moving gait cycles. No planted-foot IK. */
function movingGaitReport(target, clip, soles) {
  let previous, paths, lengths;
  const runs = [], samples = [];
  const closeRun = (v) => { if (lengths[v] >= 3) runs.push(paths[v] * RIG_SCALE); paths[v] = 0; lengths[v] = 0; };
  for (let k = 0; k < clip.count; k += 1) {
    const vertices = soles.vertices(clip.frames, k);
    if (!paths) { paths = new Float64Array(vertices.length / 3); lengths = new Uint32Array(paths.length); }
    if (previous) for (let v = 0; v < paths.length; v += 1) {
      const i = v * 3;
      if (vertices[i + 1] <= soles.rest + 0.012 && previous[i + 1] <= soles.rest + 0.012) {
        paths[v] += Math.hypot(vertices[i] - previous[i], vertices[i + 2] - previous[i + 2]); lengths[v] += 1;
      } else closeRun(v);
    }
    previous = vertices;
    const world = target.poseFrame(clip.frames, k);
    samples.push(Object.fromEntries(['LeftFoot', 'RightFoot'].map((name) => [name, new Vector3().setFromMatrixPosition(world[target.index.get(`mixamorig:${name}`)]).x])));
  }
  for (let v = 0; v < paths.length; v += 1) closeRun(v);
  runs.sort((a, b) => a - b);
  const period = (clip.count - 1) / 2, hipsTravel = clip.motorSpeed * clip.duration / RIG_SCALE;
  let stepsPerLoop = 0;
  const strides = ['LeftFoot', 'RightFoot'].map((name) => {
    const values = samples.slice(0, period).map((sample, k) => sample[name] - hipsTravel * k / (clip.count - 1));
    const low = Math.min(...values), high = Math.max(...values), middle = (low + high) / 2;
    // One forward half-stride crossing per step; wrap to count the seam without assuming a source's number of strides.
    stepsPerLoop += values.filter((value, k) => value > middle && values[(k + period - 1) % period] <= middle).length;
    return (high - low) * RIG_SCALE;
  });
  return { speedMetresPerSecond: clip.motorSpeed, runtimePlaybackRate: clip.runtimeRate, seconds: clip.duration, clipLoops: 2, stepsPerLoop,
    stepsPerSecond: stepsPerLoop * 2 / clip.duration, ankleForeAftExcursionMetres: strides,
    plantedVertexRuns: runs.length, plantedVertexTravelP95Metres: runs.length ? runs[Math.floor((runs.length - 1) * 0.95)] : null,
    plantedVertexTravelMaxMetres: runs.at(-1) ?? null };
}

/* ------------------------------------------------------------------ clip specs */

const specs = [];
const LOCOMOTION = JOINT_LIMITS;
/** Shared-toolkit donor clip (30 fps): the locomotion and reactions that play a Tripo preset with a plain window. */
const add = (clip, donor, animation, ticks, window, extra = {}) => specs.push({ clip, source: { donor, animation }, sim: { totalTicks: ticks }, window, origin: 'tripo', ...extra });
const compose = (clip, ticks, parts, extra = {}) => specs.push({ clip, sim: { totalTicks: ticks }, parts: parts.map(({ donor, animation, ...rest }) => ({ source: { donor, animation }, ...rest })), origin: 'tripo', ...extra });
/** Real-motion part: a Tripo preset of batch `donor`, or a Mixamo file (`m:<name>`). */
const tripo = (donor, animation, keys, extra = {}) => ({ source: { donor, animation }, keys, retarget: {}, ticks: [0], ...extra });
const mixamo = (name, keys, extra = {}) => ({ source: { donor: `m:${name}`, animation: 'mixamo.com', file: `asset-source/mixamo/sakda/${name}.fbx` }, keys, retarget: {}, ticks: [0], ...extra });
/** Real-motion clip (60 Hz). `active` is the simulation's strike tick, `extra.strikes` the contact surfaces the anatomy test verifies. */
const motion = (clip, ticks, active, parts, extra = {}) => specs.push({
  clip, motion: true, sim: { totalTicks: ticks, ...(active === undefined ? {} : { activeTick: active }) }, parts, pin: true, limits: 'kick',
  origin: [...new Set(parts.map((part) => (part.source.donor.startsWith('m:') ? 'mixamo' : 'tripo')))].join('+'), ...extra,
});
const LH = 'LeftHand', RH = 'RightHand';

// At the engine's 4.4 m/s, "walk" is physically a jog. Play the native captured Tripo run cycle at its normal cadence, not a 4× boxing shuffle.
// The 6.6 m/s run is a timing-only faster variant of the same gait. Neither has a synthetic thigh/arm layer.
motion('aren-idle', 144, undefined, [mixamo('fight-idle-guard-up', [[0, 0.1], [144, 2.5]])], { loop: { overlapTicks: 24 } });
motion('aren-walk', 38, undefined, [tripo('a', 'run', [[0, 0.26666667], [38, 0.9]])],
  { loop: { overlapTicks: 6, verticalDetrend: true }, limits: LOCOMOTION });
motion('aren-run', 24, undefined, [tripo('a', 'run', [[0, 0.26666667], [24, 0.9]])],
  { loop: { overlapTicks: 4, verticalDetrend: true }, limits: LOCOMOTION });
add('aren-jump', 'b', 'jump', 42, [0, 2.23333335], { airborne: true, limits: LOCOMOTION });
// Hit: the Tripo hit_to_head preset — the fighter's guard, the head snapped back, the guard restored — at 1.4×.
motion('aren-hit', 60, undefined, [tripo('f', 'hit_to_head', [[0, 0.05], [60, 1.45]])]);
add('aren-cheer', 'b', 'cheer', 300, [0, 5]);
add('aren-defeat', 'b', 'defeat_02', 360, [0, 8.46666622], { limits: LOCOMOTION });
// Second jump: two air steps, a somersault tuck, open-out and a soft landing, in place.
compose('aren-air-step', 60, [
  { donor: 'd', animation: 'run_upstairs', window: [0, 0.8], ticks: [0, 60] },
  { donor: 'd', animation: 'flip', keys: [[0, 0.9], [26, 1.2], [38, 2.2], [60, 3.4]], ticks: [14, 60] },
  { donor: 'b', animation: 'jump', window: [1.2, 2.2], ticks: [40, 60] },
], { airborne: true, crossfadeTicks: 4, pin: { maxVertical: 0.08 } });

// Eight Limbs. Strike ticks are the simulation's (SAKDA.limbs.steps); each warp lands the measured contact on its tick.
// 1 · jab-cross: Mixamo "Boxing Jab Cross Medium" (the Tripo box_02 jab is a body lunge: its fist travels 0.06 u from the hips; box_01 has no cross).
motion('sakda-limb-1', 20, 7, [mixamo('jab-cross-medium', [[0, 0.24], [7, peak([LH], [0.36, 0.56])], [14, peak([RH], [0.6, 0.8])], [20, 0.92]])],
  { strikes: [{ tick: 7, joints: [LH] }, { tick: 14, joints: [RH] }] });
// 2 · rising elbow (sok ngat): Mixamo "Illegal Elbow Uppercut".
motion('sakda-limb-2', 22, 8, [mixamo('elbow-uppercut', [[0, 0.45], [8, peak(['RightForeArm'], [0.6, 0.8])], [22, 1.15]])], { strikes: [{ tick: 8, joints: ['RightForeArm'] }] });
// 3 · clinch knee (khao trong): Mixamo "Muay Thai Illegal Knee" (the simulation steps 0.6 m).
motion('sakda-limb-3', 26, 10, [mixamo('muay-thai-knee', [[0, 0.5], [10, peak(['RightLeg'], [0.7, 1.0])], [26, 1.45]])], { strikes: [{ tick: 10, joints: ['RightLeg'] }] });
// 4 · rear roundhouse (tae tad) at body height: Mixamo "Roundhouse Kick With The Rear Foot" — the hip turns over and the support foot pivots.
motion('sakda-limb-4', 32, 13, [mixamo('roundhouse-rear', [[0, 0.27], [13, peak(['RightLeg', 'RightFoot'], [0.55, 0.8], 'shin')], [32, 1.3]])],
  { strikes: [{ tick: 13, joints: ['RightLeg', 'RightFoot'], metric: 'shin' }] });

// Skills. Strike ticks are the simulation's (SAKDA.*).
// Echo Wave: the Tripo box_02 rear straight; the fist lands on the release tick 9 and retracts along the same line (the same source played back).
motion('sakda-echo-wave', 24, 9, [tripo('a', 'box_02', [[0, 2.08], [9, peak([RH], [2.2, 2.3])], [24, 2.08]])], { strikes: [{ tick: 9, joints: [RH] }] });
// Resonating Strike: Tripo run strides in place for the dash (the simulation carries it on 4–18), then the Mixamo flying knee's take-off and knee on 18;
// the punch of that combo is cut: Sakda comes down out of the knee through the retraction of the Mixamo Muay Thai knee (the same knee shape, grounded).
// The donor's 1 m leap is lowered to a 0.3 m hop: the engine flies the actor.
motion('sakda-resonating-strike', 30, 18, [
  tripo('a', 'run', [[0, 0], [12, 0.3]]),
  mixamo('flying-knee-punch', [[10, 0.56], [18, peak(['RightLeg'], [0.8, 1.0])], [22, 0.98]], { ticks: [11] }),
  mixamo('muay-thai-knee', [[22, 0.97], [30, 1.3]], { ticks: [22] }),
], { strikes: [{ tick: 18, joints: ['RightLeg'] }], lift: [[0, 0], [10, 0], [16, -0.3], [18, -0.36], [22, -0.24], [25, 0]] });
// Elbow charge: the Mixamo fight idle's guard bounce, looped over 0.8 s.
motion('sakda-elbow-charge', 48, undefined, [mixamo('fight-idle-guard-up', [[0, 0.3], [48, 1.1]])], { loop: { overlapTicks: 12 } });
// Hundred Elbows: the captured long boxing step, then alternating cross elbows mirrored as whole-body segments, preserving the captured hip/foot
// counter-rotation instead of replacing the arm motion over frozen legs. The rising elbow finishes on 52.
const crossElbow = (tick, left) => mixamo('elbow-cross', [[tick - 3, 0.5], [tick, peak([left ? 'LeftForeArm' : 'RightForeArm'], [0.6, 0.8])], [tick + 3, 0.80]],
  { ticks: [tick - 3], ...(left ? { retarget: { mirror: true } } : {}) });
motion('sakda-hundred-elbows', 60, 12, [
  mixamo('boxing-step-forward-long', [[0, 0], [8, 0.5]]),
  crossElbow(12, false), crossElbow(18, true), crossElbow(24, false), crossElbow(30, true), crossElbow(36, false), crossElbow(42, true),
  mixamo('elbow-uppercut', [[46, 0.42], [52, peak(['RightForeArm'], [0.6, 0.8])], [60, 1.2]], { ticks: [46] }),
], { crossfadeTicks: 2, strikes: [12, 18, 24, 30, 36, 42, 52].map((tick, i) => ({ tick, joints: [i % 2 && i < 6 ? 'LeftForeArm' : 'RightForeArm'] })) });
// Tempest Stomp: Mixamo "Hard Floor Stomp"; the rear heel reaches the floor on tick 12.
motion('sakda-tempest', 28, 12, [mixamo('stomp-hard', [[0, 0.33], [12, floor(['RightFoot'], [0.6, 0.85])], [28, 1.0]])], { strikes: [{ tick: 12, joints: ['RightFoot'], metric: 'floor' }] });
// Knee charge: a later stretch of the same Mixamo guard bounce, looped over 0.8 s.
motion('sakda-knee-charge', 48, undefined, [mixamo('fight-idle-guard-up', [[0, 1.5], [48, 2.3]])], { loop: { overlapTicks: 12 } });
// Flying Knee: Mixamo "Jumping Knee Followed By A Punch" — crouch, leap, the knee on 30 — landing through the Mixamo Muay Thai knee's retraction (the
// punch is cut). The apex is lowered.
motion('sakda-flying-knee', 40, 30, [
  mixamo('flying-knee-punch', [[0, 0.4], [4, 0.5], [30, peak(['RightLeg'], [0.8, 1.0])], [33, 0.98]]),
  mixamo('muay-thai-knee', [[33, 0.97], [40, 1.3]], { ticks: [33] }),
], { strikes: [{ tick: 30, joints: ['RightLeg'] }], lift: [[0, 0], [4, 0], [18, -0.3], [30, -0.36], [33, -0.24], [36, 0]] });
// Iron Clinch: the Mixamo Muay Thai knee driven on the interrupt tick 12, then a slower release to the guard.
motion('sakda-iron-clinch', 36, 12, [mixamo('muay-thai-knee', [[0, 0.5], [12, peak(['RightLeg'], [0.7, 1.0])], [36, 1.7]])], { strikes: [{ tick: 12, joints: ['RightLeg'] }] });
// Guard Dash: Mixamo "Long Boxing Step Forward", hands up; in place (the simulation carries the 5.5 m).
motion('sakda-guard-dash', 32, undefined, [mixamo('boxing-step-forward-long', [[0, 0], [18, 0.6], [32, 1.0]])]);
// Cleanse: the Tripo bow, the bottom of the bow on the active tick 35.
motion('sakda-cleanse', 90, 35, [tripo('f', 'bow', [[0, 1.7], [35, 2.5], [62, 3.4], [90, 4.1]])]);
// Tiger's Wrath: the Tripo front_kick_02 preset — a full spinning wheel kick whose heel crosses the target line at head height on tick 24 — turned 83°
// (the preset kicks toward the rig's left) and warped onto the tick.
motion('sakda-tigers-wrath', 60, 24, [tripo('c', 'front_kick_02', [[0, 0.05], [24, peak(['RightFoot'], [0.7, 0.95])], [60, 1.4]], { retarget: { yaw: -83 } })],
  { strikes: [{ tick: 24, joints: ['RightFoot'] }] });
// Knockdown and get-up (shared Mixamo reaction takes, retargeted like every other Mixamo clip of this hero; the contract is in the brief). Sakda is a barehanded
// brawler: no weapon layer. The Hips keep the donor's vertical motion; only their horizontal travel is limited (`travel`: at most 0.62 m from the standing XZ).
const reaction = (name, keys, extra = {}) => ({ source: { donor: `m:${name}`, animation: 'mixamo.com', file: `asset-source/mixamo/reactions/${name}.fbx` }, keys, retarget: {}, ticks: [0], ...extra });
const lieClip = (clip, ticks, parts, extra) => specs.push({ clip, motion: true, sim: { totalTicks: ticks }, parts, limits: LOCOMOTION, origin: 'mixamo', ...extra });
const HOLD_FROM = 48, TRAVEL_METRES = 0.62;
lieClip('aren-knockdown', 90, [reaction('falling-back', [[0, 0.42], [18, 0.93], [30, 1.6], [HOLD_FROM, 1.85], [90, 1.85]])], { lie: { pose: 'back', holdFrom: HOLD_FROM }, travel: { maxMetres: TRAVEL_METRES } });
lieClip('aren-knockdown-forward', 90, [reaction('fall-flat-hit-back', [[0, 0.25], [30, 1.0], [HOLD_FROM, 1.95], [90, 1.95]])], { lie: { pose: 'stomach', holdFrom: HOLD_FROM }, travel: { maxMetres: TRAVEL_METRES } });
lieClip('aren-getup', 66, [reaction('kip-up', [[0, 0.27], [6, 0.27], [42, 1.35], [50, 1.55], [66, 1.8]])], { getup: { from: 'aren-knockdown', blend: 8, travel: [20, 40], idleFrom: 50 } });
lieClip('aren-getup-forward', 66, [
  reaction('getting-up-stomach', [[0, 2.35], [8, 2.45], [28, 3.2]]),
  reaction('getting-up-stomach', [[28, 4.2], [54, 5.4], [66, 5.6]], { ticks: [28] }),
], { getup: { from: 'aren-knockdown-forward', blend: 8, travel: [8, 46], idleFrom: 50 } });
// Reference clip (never shipped): the unmodified native dive preset, part of the deformation ceiling.
add('ref-dive', 'b', 'dive', 84, [0.15, 2.5], { airborne: true, limits: LOCOMOTION });
const referenceSpecs = specs.splice(specs.findIndex((item) => item.clip.startsWith('ref-')), specs.length);
for (const spec of specs) if (spec.limits === 'kick') spec.limits = KICK_LIMITS;

/* ------------------------------------------------------------------ build */

const option = (name) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = args.includes('--measure-gaits') ? ['aren-walk', 'aren-run'] : option('only')?.split(',');
const hash = (data) => createHash('sha256').update(data).digest('hex');
if (args.includes('--preview-crops')) { await cropPreviewImages(); process.exit(0); }
const base = await readFile(root + rigPath);
const baseGlb = parseGlb(base);
const rigs = { target: new Rig(baseGlb) };
for (const [key, path] of Object.entries(sources)) rigs[key] = new Rig(parseGlb(await readFile(root + path)));
const target = rigs.target;
const soles = soleKit(target, baseGlb);
/** Every 3rd vertex of the whole mesh (not only the soles): the floor contact of the lying clips. Built on first use. */
let wholeBody;
const bodyKit = () => (wholeBody ??= soleKit(target, baseGlb, { stride: 3, all: true }));
// Mixamo donors: turned to the rig's heading and rest-aligned onto its A-pose by the loader. Of the shared reaction takes only those a clip plays (and the one an
// authoring aid asks for) are loaded.
const mixamoSources = {};
const usedReactions = new Set([...specs, ...referenceSpecs].flatMap((spec) => (spec.parts ?? []).map((part) => part.source.donor.slice(2))).filter((name) => REACTION_FILES.includes(name)));
for (const aid of [option('lie-timeline')?.slice(2), option('probe')?.split(':')[0]]) if (aid) usedReactions.add(aid);
for (const name of [...MIXAMO_FILES, ...REACTION_FILES.filter((item) => usedReactions.has(item))]) {
  const file = `asset-source/mixamo/${REACTION_FILES.includes(name) ? 'reactions' : 'sakda'}/${name}.fbx`, donor = await loadMixamoDonor(file, { root, target });
  rigs[`m:${name}`] = donor.rig;
  mixamoSources[name] = { file, sha256: donor.sha256, durationSeconds: Math.round(donor.duration * 1e4) / 1e4, frames: donor.frames, facingDegrees: donor.facingDegrees };
}

// Load the real source hierarchy through GLTFLoader (without render-only mesh/textures) to measure Three's actual root binding name in Node.
if (args.includes('--root-binding')) {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const hierarchy = { asset: baseGlb.json.asset, scene: baseGlb.json.scene, scenes: baseGlb.json.scenes,
    nodes: baseGlb.json.nodes.map(({ mesh, skin, ...node }) => node) };
  const loaded = await new GLTFLoader().parseAsync(JSON.stringify(hierarchy), '');
  const name = PropertyBinding.sanitizeNodeName(target.names[target.index.get('mixamorig:Hips')]);
  console.log(JSON.stringify({ sourceJoint: 'mixamorig:Hips', runtimeRootName: name, loadedObjectName: loaded.scene.getObjectByName(name)?.name ?? null }));
  process.exit(0);
}

// Authoring aid: prints a retargeted source every 1/30 s on this rig: Hips height and heading, chest heading, and the fists, elbows, knees and ankles as
// [forward, up, right] from the Hips (rig units).
if (option('timeline')) {
  const fields = option('timeline').split(':');
  const [donor, animation, yaw = '0', mirror] = fields[0] === 'm' ? [`m:${fields[1]}`, 'mixamo.com', fields[2], fields[3]] : fields;
  const decoded = rigs[donor].decodeAnimation(animation), n = Math.round(decoded.duration * 30) + 1;
  const frames = retargetAligned(target, rigs[donor], decoded, n, (k) => decoded.duration * k / (n - 1), { yaw: Number(yaw), mirror: mirror === 'mirror' });
  const heading = (world, name) => { const id = target.index.get(`mixamorig:${name}`), f = new Vector3(1, 0, 0).applyQuaternion(quaternionOf(world[id]).multiply(target.restWorldQuaternion[id].clone().invert())); return Math.round(Math.atan2(-f.z, f.x) / DEG); };
  const names = ['LeftHand', 'RightHand', 'LeftForeArm', 'RightForeArm', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot'];
  console.log(`${donor} ${animation} ${decoded.duration.toFixed(3)} s · t hipsX hipsY hipsZ hipsYaw chestYaw leftFootYaw rightFootYaw | ${names.join(' ')}`);
  for (let k = 0; k < n; k += 1) {
    const world = target.poseFrame(frames, k), hips = new Vector3().setFromMatrixPosition(world[target.index.get('mixamorig:Hips')]);
    const at = (name) => { const p = new Vector3().setFromMatrixPosition(world[target.index.get(`mixamorig:${name}`)]); return [p.x - hips.x, p.y, p.z - hips.z].map((v) => v.toFixed(2)).join(','); };
    console.log((decoded.duration * k / (n - 1)).toFixed(2), hips.x.toFixed(3), hips.y.toFixed(2), hips.z.toFixed(3), heading(world, 'Hips'), heading(world, 'Spine2'), heading(world, 'LeftFoot'), heading(world, 'RightFoot'), '|', names.map(at).join(' '));
  }
  process.exit(0);
}

// Authoring aid for the knockdown / get-up sources: `--lie-timeline=m:<file>` prints, every 1/30 s on this rig, the Hips position in metres (x, height, z), the
// forward axis of the Hips and the chest in world space (y > 0.7: on the back, y < -0.7: on the stomach, ≈ 0: upright), the head height, the lowest skinned vertex
// above the floor (cm) and the lowest sole.
if (option('lie-timeline')) {
  const [, name] = option('lie-timeline').split(':'), donor = `m:${name}`, decoded = rigs[donor].decodeAnimation('mixamo.com'), n = Math.round(decoded.duration * 30) + 1;
  const frames = retargetAligned(target, rigs[donor], decoded, n, (k) => decoded.duration * k / (n - 1)), body = soleKit(target, baseGlb, { stride: 3, all: true });
  console.log(`${donor} ${decoded.duration.toFixed(3)} s · t hipsX hipsY hipsZ (m) hipsFwdY torsoFwdY lieAxis(deg) headY(m) lowestVertex(cm) lowestSole(cm)`);
  for (let k = 0; k < n; k += 1) {
    const world = target.poseFrame(frames, k), p = new Vector3().setFromMatrixPosition(world[target.index.get('mixamorig:Hips')]), head = new Vector3().setFromMatrixPosition(world[target.index.get('mixamorig:Head')]);
    const hipsId = target.index.get('mixamorig:Hips'), hipsFwd = new Vector3(1, 0, 0).applyQuaternion(quaternionOf(world[hipsId]).multiply(target.restWorldQuaternion[hipsId].clone().invert())), torso = torsoFrame(target, world);
    console.log((decoded.duration * k / (n - 1)).toFixed(2), (p.x * RIG_SCALE).toFixed(2), (p.y * RIG_SCALE).toFixed(2), (p.z * RIG_SCALE).toFixed(2), hipsFwd.y.toFixed(2), torso.forward.y.toFixed(2), torso.axis.toFixed(0),
      (head.y * RIG_SCALE).toFixed(2), ((body.lowest(frames, k) - body.rest) * RIG_SCALE * 100).toFixed(1), body.lowestBone(frames, k), ((soles.lowest(frames, k) - soles.rest) * RIG_SCALE * 100).toFixed(1));
  }
  process.exit(0);
}

// Authoring aid: `--probe=<reaction take>:<from s>:<to s>[:ticks]` writes /tmp/sakda-probe.glb with that stretch of a reaction take on this rig (no guard, no floor
// fix), `ticks` long (default: real time), as clip `probe` for `render-clip-preview.mjs`.
if (option('probe')) {
  const [name, from, to, ticks = String(Math.round((Number(to) - Number(from)) * TICKS_PER_SECOND))] = option('probe').split(':');
  const probe = buildMotionClip({ clip: 'probe', motion: true, sim: { totalTicks: Number(ticks) }, parts: [reaction(name, [[0, Number(from)], [Number(ticks), Number(to)]])] }, target, rigs);
  const glb = parseGlb(appendClips(base, [probe])), index = glb.json.nodes.length;
  glb.json.nodes.push({ name: 'SakdaForward', rotation: [0, -Math.SQRT1_2, 0, Math.SQRT1_2], children: glb.json.scenes[0].nodes });
  glb.json.scenes[0].nodes = [index];
  await writeFile('/tmp/sakda-probe.glb', encodeGlb(glb.json, glb.bin));
  process.exit(0);
}

const limitsName = (table) => (table === JOINT_LIMITS ? 'JOINT_LIMITS' : table === KICK_LIMITS ? 'KICK_LIMITS' : 'COMBAT_LIMITS');
const restHipsX = target.restWorldPosition[target.index.get('mixamorig:Hips')].x;
const report = {}, produced = new Map();
const specOf = (name) => specs.find((item) => item.clip === name);
/** Builds one clip (memoised: a get-up needs its knockdown and the idle, which are themselves clips of the set). */
function produce(spec) {
  if (!produced.has(spec.clip)) produced.set(spec.clip, makeClip(spec));
  return produced.get(spec.clip);
}
function makeClip(spec) {
  const lying = Boolean(spec.lie || spec.getup), limits = spec.limits ?? COMBAT_LIMITS;
  const knock = spec.getup ? produce(specOf(spec.getup.from)) : undefined, idle = spec.getup ? produce(specOf('aren-idle')) : undefined;
  const clip = spec.getup ? buildGetup(spec, target, rigs, knock, idle) : spec.motion ? buildMotionClip(spec, target, rigs) : buildClip(spec, rigs);
  if (!spec.motion) {
    if (spec.pin?.maxVertical !== undefined) pinHips(target, clip.frames, clip.count, spec.pin.maxVertical);
  }
  if (process.env.SAKDA_DEBUG) {
    const pre = jointExcursions(target, clip.frames, clip.count, limits);
    for (const [joint, e] of Object.entries(pre)) if (e.swing > 0.9 * limits[joint].swing || e.twist > 0.9 * limits[joint].twist) console.error(`pre-limit ${spec.clip} ${joint.replace('mixamorig:', '')} swing ${e.swing.toFixed(1)}/${limits[joint].swing} twist ${e.twist.toFixed(1)}/${limits[joint].twist}`);
  }
  const corrections = spec.getup ? clip.corrections : spec.motion ? guardJoints(target, clip.frames, clip.count, limits) : limitJoints(target, clip.frames, clip.count, limits);
  if (lying) {
    // Lying clips keep their vertical Hips motion (the fall reaches the floor, the rise leaves it); only the lowest skinned vertex of the WHOLE mesh is held to the floor, frame by frame.
    // A get-up is blended into the idle first (its last frame IS the idle's first), then grounded with both end frames pinned.
    if (spec.getup) blendIdle(target, clip.frames, clip.count, idle, spec.getup.idleFrom);
    spec.floor = floorCorrect(target, clip.frames, clip.count, bodyKit(), { holdFrom: spec.lie?.holdFrom, pinFirst: Boolean(spec.getup), pinLast: Boolean(spec.getup) });
  } else {
    const shift = groundShift(soles, clip.frames, clip.count);
    offsetHips(target, clip.frames, clip.count, () => [0, shift, 0]);
    spec.groundShift = Math.round(shift * 1e4) / 1e4;
  }
  continuity(clip.frames, clip.count);
  if (spec.strikes) {
    spec.strikeReport = spec.strikes.map(({ tick, joints, metric }) => {
      const contact = strikeTick(target, clip, joints, tick, 6, metric);
      return { tick, joints, contactTick: contact.tick, ...(metric === 'floor' ? { floorMetres: Math.round(contact.value * RIG_SCALE * 1e3) / 1e3 } : { forwardMetres: Math.round((contact.value - restHipsX) * RIG_SCALE * 1e3) / 1e3 }) };
    });
  }
  const excursions = jointExcursions(target, clip.frames, clip.count, limits);
  const worst = Object.entries(excursions).map(([joint, e]) => ({ joint: joint.replace('mixamorig:', ''), swing: e.swing, twist: e.twist }));
  report[spec.clip] = {
    origin: spec.origin, limits: limitsName(limits),
    peakSwing: Math.round(Math.max(...worst.map((e) => e.swing)) * 10) / 10, peakTwist: Math.round(Math.max(...worst.map((e) => e.twist)) * 10) / 10,
    corrections,
    motionQuality: motionQuality(target, clip, soles),
    ...(spec.strikeReport ? { strikes: spec.strikeReport } : {}),
    ...(spec.pin ? { hipsTravel: (() => { const t = hipsTravel(target, clip.frames, clip.count); return { horizontalMetres: Math.round(t.horizontal * RIG_SCALE * 1e4) / 1e4, verticalMetres: Math.round(t.vertical * RIG_SCALE * 1e4) / 1e4 }; })() } : {}),
    ...(lying ? { lie: lieReport(spec, target, clip, bodyKit(), knock, idle, corrections) } : {}),
  };
  return clip;
}
const clips = [...specs, ...referenceSpecs].filter((item) => (only ? only.includes(item.clip) : specs.includes(item))).map(produce);
const animated = parseGlb(appendClips(base, clips));
// Tripo's native biped motion faces +X. A scene-level child preserves bind/clip transforms while presenting the +Z forward convention used by the simulation.
for (const scene of animated.json.scenes) {
  const index = animated.json.nodes.length;
  animated.json.nodes.push({ name: 'SakdaForward', rotation: [0, -Math.SQRT1_2, 0, Math.SQRT1_2], children: scene.nodes });
  scene.nodes = [index];
}
const bytes = encodeGlb(animated.json, animated.bin);
if (args.includes('--measure-gaits')) {
  const moving = [['aren-walk', 4.4], ['aren-run', 6.6]].map(([name, speed]) => movingGait(target, clips.find((clip) => clip.spec.clip === name), speed));
  console.log(JSON.stringify({ clips: report, moving: moving.map((clip) => movingGaitReport(target, clip, soles)) }, null, 2));
  process.exit(0);
}
if (only) {
  await writeFile('/tmp/sakda-only.glb', bytes);
  if (process.env.SAKDA_DEFORM) for (const clip of clips) { const d = skinDeformationReport(bytes, clip.spec.clip); console.error('deformation', clip.spec.clip, d.p99, d.p999, d.max, d.worstBone, d.worstSeconds); }
  console.log(JSON.stringify(report, null, 1));
  process.exit(0);
}

/* ------------------------------------------------------------------ outputs */

await mkdir(root + output, { recursive: true });
await writeFile(root + output + '/sakda-hero-animated.glb', bytes);
const mapping = Object.fromEntries(clips.map((clip) => [clip.spec.clip, clip.spec.clip]));
for (const action of ['strafe']) mapping['aren-' + action] = 'aren-walk';
for (const action of ['stagger', 'stumble-recovery', 'hard-landing']) mapping['aren-' + action] = 'aren-hit';
for (const action of ['forward-left-dive-roll', 'forward-right-dive-roll', 'perfect-dodge-left', 'perfect-dodge-right', 'quick-step-left', 'quick-step-right', 'forward-shoulder-roll', 'back-handspring', 'left-cartwheel', 'right-cartwheel', 'back-left-pivot-roll', 'back-right-pivot-roll', 'low-slide', 'dodge-recovery']) mapping['aren-' + action] = 'sakda-guard-dash';
for (const action of ['staff-vault', 'low-ledge', 'swing']) mapping['aren-' + action] = 'aren-jump';
const rootMotion = {};
for (const [action, clipName] of Object.entries(mapping)) {
  const clip = clips.find((item) => item.spec.clip === clipName);
  if (clipName === 'aren-air-step') { rootMotion[action] = { mode: 'in-place', evidenceStatus: 'verified' }; continue; }
  const hips = target.index.get('mixamorig:Hips'), track = clip.frames.positions[hips];
  const samples = [0, Math.floor((clip.count - 1) / 2), clip.count - 1].map((i) => ({ time: clip.times[i], position: { x: track[i * 3], y: track[i * 3 + 1], z: track[i * 3 + 2] } }));
  rootMotion[action] = { mode: 'native-root-motion', rootNodeName: PropertyBinding.sanitizeNodeName(target.names[hips]), preserveVerticalMotion: action !== 'aren-jump', curveSamples: samples, evidenceStatus: 'verified' };
}
const entry = {
  id: 'actor-sakda-hero', actorId: 'aren', variantOf: 'actor-aren', sourceType: 'native-glb', kind: 'character', rigFamily: 'biped',
  tripoSourceTask: tasks.rig, sourceHash: hash(base), outputHash: hash(bytes), runtimeUrl: '/' + output + '/sakda-hero-animated.glb',
  coordinateTransform: { forward: { x: 0, y: 0, z: 1 }, scale: RIG_SCALE }, lodIds: [], requiredActionIds: [],
  actionToClipMapping: mapping, rootMotion, sockets: [], provenance: output + '/provenance.json', evidenceStatus: 'blocked',
};
await writeFile(root + output + '/manifest-entry.json', JSON.stringify(entry, null, 2) + '\n');

// Anatomy report: limits and skin deformation of every clip of the delivered GLB. The measurement (a CPU skin of the 600 k-vertex mesh) is a pure function of the mesh and the
// clip's frames, so reruns reuse a cache in the OS temp directory keyed by the hash of both; the numbers are identical with or without it.
const { tmpdir } = await import('node:os');
const cachePath = `${tmpdir()}/sakda-deformation-cache.json`;
const cache = await readFile(cachePath, 'utf8').then(JSON.parse, () => ({}));
const baseHash = hash(base);
const measure = (glb, clip) => {
  const key = hash(JSON.stringify([baseHash, clip.spec.clip, Array.from(clip.times), clip.frames.rotations.map((track) => track && Array.from(track)), clip.frames.positions.map((track) => track && Array.from(track))]));
  return (cache[key] ??= skinDeformationReport(glb, clip.spec.clip));
};
const deformation = {};
for (const clip of clips) {
  const measured = measure(bytes, clip);
  deformation[clip.spec.clip] = { p99: measured.p99, p999: measured.p999, max: measured.max, worstBone: measured.worstBone };
}
// The hero's locomotion ceiling: his own idle/walk/run/jump/guard dash and the native Tripo dive preset (the dodge every hero's dash replaces),
// built through the same pipeline but never shipped. Sakda's muscular mesh stretches more under every native preset than Yara's robe does.
const locomotion = ['aren-idle', 'aren-walk', 'aren-run', 'aren-jump', 'sakda-guard-dash'];
const referenceClip = buildClip(referenceSpecs.find((item) => item.clip === 'ref-dive'), rigs);
const referenceDive = measure(appendClips(base, [referenceClip]), referenceClip);
await writeFile(cachePath, JSON.stringify(cache));
const ceiling = Math.max(referenceDive.p999, ...locomotion.map((name) => deformation[name].p999));
const movingClips = [['aren-walk', 4.4], ['aren-run', 6.6]].map(([name, speed]) => movingGait(target, clips.find((clip) => clip.spec.clip === name), speed));
const anatomy = {
  schemaVersion: 1,
  outputHash: hash(bytes),
  scale: RIG_SCALE,
  kickLimits: { raisedFrom: 'JOINT_LIMITS', table: Object.fromEntries(Object.entries(KICK_LIMITS).filter(([joint, limit]) => limit.swing !== JOINT_LIMITS[joint].swing || limit.twist !== JOINT_LIMITS[joint].twist)) },
  deformationCeiling: { clips: locomotion, reference: { clip: 'native dive preset (not shipped)', p999: referenceDive.p999 }, p999: ceiling },
  movingLocomotion: Object.fromEntries(movingClips.map((clip) => [clip.spec.clip, movingGaitReport(target, clip, soles)])),
  clips: Object.fromEntries(clips.map((clip) => [clip.spec.clip, { ...report[clip.spec.clip], deformation: deformation[clip.spec.clip] }])),
};
await writeFile(root + output + '/anatomy-report.json', JSON.stringify(anatomy, null, 2) + '\n');
const creditTotal = [credits, ...[discarded, tooling].map((table) => Object.fromEntries(Object.entries(table).map(([key, value]) => [key, value.credits])))]
  .reduce((sum, table) => sum + Object.values(table).reduce((a, b) => a + b, 0), 0);
await writeFile(root + output + '/provenance.json', JSON.stringify({
  schemaVersion: 1, originalModelTask: MODEL_TASK, tasks, sources, presets, mixamo: mixamoSources, sourceHash: hash(base), outputHash: hash(bytes),
  operation: 'Captured whole-body motion on the native Sakda rig: Tripo presets and Mixamo FBX (Without Skin, 30 fps; heading/rest alignment by scripts/assets/mixamo-import.mjs). Edits: source windows/time warps, facing, in-place pinning, constant ground shift, lowered leap apex, measured gait-loop vertical root drift removal, loop seams, cross-fades between captured whole-body segments, whole-body mirror for alternating elbows, and the shared soft joint guard (KICK_LIMITS). Walk uses the stable native captured jog window 0.267–0.900 s at normal cadence for 4.4 m/s; run is its timing-only faster variant for 6.6 m/s. No IK, synthetic stance widening, partial-body replacement or hand-keyed poses. Native mesh retained; barehanded. Only manifest-entry.json is emitted; playtest manifests remain coordinator-owned.',
  knockdownGetup: 'aren-knockdown / aren-knockdown-forward / aren-getup / aren-getup-forward: Mixamo "Falling Back Death" (falling-back), "Fall Flat Hit Back" (fall-flat-hit-back), "Kip Up" (kip-up) and "Getting Up From Stomach" (getting-up-stomach) of asset-source/mixamo/reactions (provenance.json, hero shared-reactions), retargeted like every other Mixamo clip of this hero (mixamo-import.mjs facing/rest alignment + world-space retarget). Edits: time warps of the take (the stomach get-up is played in two stretches cross-faded over 6 ticks, skipping its slow shuffle), the Hips horizontal travel limited (knockdowns: uniform scale to at most 0.62 m from the standing XZ; get-ups: one smooth slide back onto the standing XZ), the Hips vertical motion kept, the shared soft joint guard (JOINT_LIMITS) applied to each take before blending, the whole-mesh lowest vertex held to the floor through the Hips height alone, a lying-to-lying cross-fade from the knockdown held lie into the take, and a gradual slerp of the last quarter into aren-idle frame 0. No IK, no hand-keyed poses; Sakda is unarmed.',
  credits, discarded, tooling, creditTotal, evidenceStatus: 'blocked',
  clips: specs.map((spec) => ({ ...spec, limits: limitsName(spec.limits ?? COMBAT_LIMITS) })),
}, null, 2) + '\n');
console.log(JSON.stringify({ output: output + '/sakda-hero-animated.glb', hash: hash(bytes), clips: clips.length, actions: Object.keys(mapping).length, deformationCeiling: ceiling }));

/* ------------------------------------------------------------------ previews (opt-in) */

if (args.includes('--previews')) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  await mkdir(root + output + '/previews', { recursive: true });
  const groups = [
    ['locomotion', ['aren-idle', 'aren-walk', 'aren-run', 'aren-jump', 'sakda-guard-dash', 'aren-hit']],
    ['reactions', ['aren-cheer', 'aren-defeat', 'aren-air-step', 'sakda-cleanse']],
    ['limbs', ['sakda-limb-1', 'sakda-limb-2', 'sakda-limb-3', 'sakda-limb-4']],
    ['echo-resonating', ['sakda-echo-wave', 'sakda-resonating-strike', 'sakda-elbow-charge', 'sakda-knee-charge']],
    ['elbows-tempest', ['sakda-hundred-elbows', 'sakda-tempest']],
    ['knee-clinch-wrath', ['sakda-flying-knee', 'sakda-iron-clinch', 'sakda-tigers-wrath']],
    ['knockdown', ['aren-knockdown', 'aren-knockdown-forward', 'aren-getup', 'aren-getup-forward']],
  ];
  const sheets = groups.flatMap(([name, names]) => ['side', 'iso', 'front'].map((view) => [`${name}-${view}`, view, names, 12]));
  const queue = [...sheets];
  const worker = async () => {
    for (let sheet = queue.shift(); sheet; sheet = queue.shift()) {
      const [name, view, names, frames] = sheet;
      await run('node', ['scripts/assets/render-clip-preview.mjs', root + output + '/sakda-hero-animated.glb', `${root}${output}/previews/${name}.png`, `--clips=${names.join(',')}`, `--frames=${frames}`, `--view=${view}`, '--cell=240'], { cwd: root, maxBuffer: 1 << 24 });
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  // Exact simulation-contact poses supplement the evenly spaced sheets. The temporary GLB remains inside our owned output and is removed after rendering.
  const contactClips = clips.flatMap((clip) => (clip.spec.strikes ?? []).map(({ tick }) => ({
    ...clip, spec: { ...clip.spec, clip: `${clip.spec.clip}@${tick}` }, count: 2, times: new Float32Array([0, 1 / 60]), duration: 1 / 60,
    frames: {
      rotations: clip.frames.rotations.map((track) => track && Float32Array.from([...track.subarray(tick * 4, tick * 4 + 4), ...track.subarray(tick * 4, tick * 4 + 4)])),
      positions: clip.frames.positions.map((track) => track && Float32Array.from([...track.subarray(tick * 3, tick * 3 + 3), ...track.subarray(tick * 3, tick * 3 + 3)])),
    },
  })));
  const contactGlb = parseGlb(appendClips(base, contactClips));
  const forwardNode = contactGlb.json.nodes.length;
  contactGlb.json.nodes.push({ name: 'SakdaForward', rotation: [0, -Math.SQRT1_2, 0, Math.SQRT1_2], children: [...contactGlb.json.scenes[0].nodes] });
  contactGlb.json.scenes[0].nodes = [forwardNode];
  const contactPath = root + output + '/previews/contact-frames.glb';
  await writeFile(contactPath, encodeGlb(contactGlb.json, contactGlb.bin));
  try {
    for (const view of ['front', 'side', 'iso']) {
      await run('node', ['scripts/assets/render-clip-preview.mjs', contactPath, `${root}${output}/previews/contacts-${view}.png`,
        `--clips=${contactClips.map((clip) => clip.spec.clip).join(',')}`, '--frames=1', `--view=${view}`, '--cell=280'], { cwd: root, maxBuffer: 1 << 24 });
    }
  } finally {
    await unlink(contactPath);
  }
  const movingGlb = parseGlb(appendClips(base, movingClips)), movingForward = movingGlb.json.nodes.length;
  movingGlb.json.nodes.push({ name: 'SakdaForward', rotation: [0, -Math.SQRT1_2, 0, Math.SQRT1_2], children: [...movingGlb.json.scenes[0].nodes] });
  movingGlb.json.scenes[0].nodes = [movingForward];
  const movingPath = root + output + '/previews/moving-gaits.glb';
  await writeFile(movingPath, encodeGlb(movingGlb.json, movingGlb.bin));
  try {
    for (const view of ['front', 'side', 'iso']) {
      await run('node', ['scripts/assets/render-clip-preview.mjs', movingPath, `${root}${output}/previews/moving-gaits-${view}.png`,
        `--clips=${movingClips.map((clip) => clip.spec.clip).join(',')}`, '--frames=12', `--view=${view}`, '--cell=320'], { cwd: root, maxBuffer: 1 << 24 });
    }
  } finally {
    await unlink(movingPath);
  }
  await cropPreviewImages();
}

/** Readable contact pages and moving-frame panels retain the original projection/pixels (no camera recentering or motion changes). */
async function cropPreviewImages() {
  const { execFile } = await import('node:child_process'), { promisify } = await import('node:util'), run = promisify(execFile);
  for (const view of ['front', 'side', 'iso']) {
    for (let page = 0; page < 3; page += 1) await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-i', `${root}${output}/previews/contacts-${view}.png`, '-vf', `crop=280:1680:0:${page * 1680}`, '-frames:v', '1',
      `${root}${output}/previews/contacts-${page + 1}-${view}.png`]);
    for (let page = 0; page < 2; page += 1) await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-i', `${root}${output}/previews/moving-gaits-${view}.png`, '-vf', `crop=1920:640:${page * 1920}:0`, '-frames:v', '1',
      `${root}${output}/previews/moving-gaits-${page + 1}-${view}.png`]);
  }
}
