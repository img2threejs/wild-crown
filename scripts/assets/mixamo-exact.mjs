import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { Quaternion, Vector3 } from 'three';
import { parseFbx } from './mixamo-import.mjs';

/**
 * Exact Mixamo takes on a hero rig whose own character was uploaded to Mixamo (Yara: `yara-mixamo`, Aren: `aren-mixamo`).
 *
 * A take exported onto that character carries the rig's own skeleton, so no retarget is needed: every bone's local rotation in the take is the rig's
 * local rotation, with one possible exception, the Hips facing (`hipsYawDegrees`):
 *
 *   rig Hips rotation = Ry(hipsYaw) · fbx Hips rotation
 *   rig Hips position = Ry(hipsYaw) · (fbx Hips position · scale),   scale = rig Hips rest height / T-pose FBX Hips height
 *
 * Only the rotations of every animated rig joint (the leaf joints keep the rig's rest) and the Hips translation are read; the Hips' horizontal travel
 * (x, z of the rig frame) is pinned to the take's first frame (the simulation moves the hero) and its vertical travel is kept.
 *
 * `createMixamoExact` verifies the mapping against the rig itself, from the character's T-pose take (it throws otherwise):
 *  - `rest: 'tpose'` (Yara: build-yara-mixamo-rig.mjs baked that T-pose as the rig rest): converting the T-pose must reproduce every rig rest rotation
 *    within `REST_TOLERANCE_DEGREES`;
 *  - `rest: 'native'` (Aren: the rig keeps its modeller's rest pose, arms not quite in a T): the FBX skeleton's bone offsets (each joint's position in
 *    its parent, i.e. the joint frames) must match the rig's within `BONE_TOLERANCE_DEGREES`, and the T-pose Hips must match the rig's rest facing within
 *    `REST_TOLERANCE_DEGREES` (so `hipsYawDegrees` is right). Matching joint frames make the take's locals the rig's locals; only the pose differs.
 */
export const REST_TOLERANCE_DEGREES = 0.05;
export const BONE_TOLERANCE_DEGREES = 0.1;
export const YARA_EXACT = Object.freeze({ tposeFile: 'asset-source/mixamo/yara-rig/yara-c-tpose.fbx', hipsYawDegrees: 90, rest: 'tpose' });
export const AREN_EXACT = Object.freeze({ tposeFile: 'asset-source/mixamo/aren-rig/aren-tpose.fbx', hipsYawDegrees: 0, rest: 'native' });
const DEG = Math.PI / 180;
const HIPS = 'mixamorig:Hips';
/** The leaf joints of the skeleton (finger tips, toe and head ends) carry no animation in a Mixamo take: they keep the rig's rest rotation. */
const LEAF = /(Thumb|Index|Middle|Ring|Pinky)4$|_End$/;

/** `mixamorig:Hips` (rig) → `mixamorigHips` (the name FBXLoader gives the bone). */
const fbxName = (rigName) => rigName.replace(':', '');

/** Raw tracks of an FBX take: `rotation` / `translation` keys by rig node index (`times`, `values` as parsed, no conversion). */
function decodeTake(scene, rig, label) {
  const clip = scene.animations[0];
  if (!clip) throw new Error(`${label}: FBX has no animation take`);
  const byFbxName = new Map(rig.joints.map((node) => [fbxName(rig.names[node]), node]));
  const tracks = new Map();
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.'), node = byFbxName.get(track.name.slice(0, dot)), property = track.name.slice(dot + 1);
    if (node === undefined || (property !== 'quaternion' && !(property === 'position' && rig.names[node] === HIPS))) continue;
    const entry = tracks.get(node) ?? {};
    entry[property === 'quaternion' ? 'rotation' : 'translation'] = { times: track.times, values: track.values, interpolant: track.createInterpolant() };
    tracks.set(node, entry);
  }
  const missing = rig.joints.filter((node) => !tracks.get(node)?.rotation && !LEAF.test(rig.names[node])).map((node) => rig.names[node]);
  if (missing.length) throw new Error(`${label}: no rotation track for ${missing.join(', ')}`);
  if (!tracks.get(rig.index.get(HIPS))?.translation) throw new Error(`${label}: no Hips position track`);
  return { duration: clip.duration, tracks };
}

/** Quaternion of a raw track at `time`, by hand from its two neighbouring keys (the independent reference of the exactness gate). */
function rawQuaternion(track, time, out, scratch) {
  const { times, values } = track, last = times.length - 1;
  if (time <= times[0]) return out.fromArray(values, 0);
  if (time >= times[last]) return out.fromArray(values, last * 4);
  let i = 0;
  while (times[i + 1] < time) i += 1;
  const f = (time - times[i]) / (times[i + 1] - times[i]);
  return out.fromArray(values, i * 4).slerp(scratch.fromArray(values, (i + 1) * 4), f);
}

/**
 * @param {{ root: string, rig: import('./retarget-aren-tripo-clips.mjs').Rig, tposeFile: string, hipsYawDegrees: number, rest: 'tpose' | 'native' }} options
 *   `rig`: the hero rig the takes play on; the rest are `YARA_EXACT` / `AREN_EXACT`.
 */
export async function createMixamoExact({ root, rig, tposeFile, hipsYawDegrees, rest }) {
  const hips = rig.index.get(HIPS), yaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), hipsYawDegrees * DEG);
  const tposeScene = parseFbx(await readFile(resolve(root, tposeFile)));
  const tpose = decodeTake(tposeScene, rig, tposeFile);
  const tposeHips = tpose.tracks.get(hips).translation.values[1];
  const scale = rig.restPosition[hips].y / tposeHips;
  const q = new Quaternion(), scratch = new Quaternion();

  /** The rig-frame local rotation of `node` from raw (FBX) rotation `q` (in place). */
  const toRig = (node, quaternion) => (node === hips ? quaternion.premultiply(yaw) : quaternion).normalize();
  const worst = { degrees: 0, joint: '' };
  const note = (degrees, node) => { if (degrees > worst.degrees) { worst.degrees = degrees; worst.joint = rig.names[node]; } };
  const fail = (what, limit) => { throw new Error(`Exact Mixamo mapping (${tposeFile}): ${what} differs from the rig by ${worst.degrees.toFixed(4)}° at ${worst.joint} (limit ${limit}°)`); };
  if (rest === 'tpose') {
    // The mapping must reproduce the rig's own rest pose from its T-pose FBX.
    for (const node of rig.joints) {
      if (!tpose.tracks.get(node)?.rotation) continue;
      note(toRig(node, rawQuaternion(tpose.tracks.get(node).rotation, 0, q, scratch)).angleTo(rig.restQuaternion[node]) / DEG, node);
    }
    if (worst.degrees > REST_TOLERANCE_DEGREES) fail('the T-pose', REST_TOLERANCE_DEGREES);
  } else {
    // Same joint frames: every joint sits where the rig's does in its parent (direction), and the T-pose Hips faces the way the rig rest does.
    const nodes = new Map();
    tposeScene.traverse((object) => nodes.set(object.name, object));
    for (const node of rig.joints) {
      const bone = nodes.get(fbxName(rig.names[node]));
      if (!bone || node === hips) continue;
      if (bone.position.lengthSq() > 1e-12 && rig.restPosition[node].lengthSq() > 1e-12) note(bone.position.angleTo(rig.restPosition[node]) / DEG, node);
    }
    if (worst.degrees > BONE_TOLERANCE_DEGREES) fail('a bone offset', BONE_TOLERANCE_DEGREES);
    const bones = { degrees: worst.degrees, joint: worst.joint };
    worst.degrees = toRig(hips, rawQuaternion(tpose.tracks.get(hips).rotation, 0, q, scratch)).angleTo(rig.restQuaternion[hips]) / DEG; worst.joint = HIPS;
    if (worst.degrees > REST_TOLERANCE_DEGREES) fail('the Hips facing', REST_TOLERANCE_DEGREES);
    Object.assign(worst, bones.degrees >= worst.degrees ? bones : {});
  }
  const restCheck = { rest, maxDegrees: Math.round(worst.degrees * 1e4) / 1e4, worstJoint: worst.joint.replace('mixamorig:', ''), toleranceDegrees: rest === 'tpose' ? REST_TOLERANCE_DEGREES : BONE_TOLERANCE_DEGREES, hipsYawDegrees, hipsScale: scale };

  return {
    scale, restCheck,
    /**
     * Loads one take. `sample(frames, k, time)` writes the rig-frame pose at source `time` (seconds, clamped to the take) into key `k` of `frames`
     * (`rotations[node]`, `positions[hips]`); `localAt(node, time, out)` is the unconverted-by-sampling reference: the FBX local (Hips yawed) from the raw keys.
     */
    async load(file) {
      const path = isAbsolute(file) ? file : resolve(root, file), bytes = await readFile(path);
      const take = decodeTake(parseFbx(bytes), rig, file), first = new Vector3();
      const pose = (time) => Math.min(Math.max(time, 0), take.duration);
      const hipsTranslation = take.tracks.get(hips).translation;
      const toPosition = (time, out) => out.fromArray(hipsTranslation.interpolant.evaluate(pose(time))).multiplyScalar(scale).applyQuaternion(yaw);
      toPosition(0, first);
      return {
        file, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, duration: take.duration, frames: Math.round(take.duration * 30) + 1,
        sample(frames, k, time) {
          for (const node of rig.joints) {
            const track = take.tracks.get(node)?.rotation;
            if (track) toRig(node, q.fromArray(track.interpolant.evaluate(pose(time)))).toArray(frames.rotations[node], k * 4);
            else rig.restQuaternion[node].toArray(frames.rotations[node], k * 4);
          }
          const p = toPosition(time, new Vector3());
          p.x = first.x; p.z = first.z;
          p.toArray(frames.positions[hips], k * 3);
        },
        localAt(node, time, out) {
          const track = take.tracks.get(node)?.rotation;
          return track ? toRig(node, rawQuaternion(track, pose(time), out, scratch)) : out.copy(rig.restQuaternion[node]);
        },
      };
    },
  };
}

/** Largest difference (degrees) a stored key may show from the FBX local at its source time. */
export const EXACT_TOLERANCE_DEGREES = 0.1;
const TICKS_PER_SECOND = 60, FPS = 30;
/** Angle (radians) between two rotations; atan2 form, accurate for the sub-0.1° differences `acos` of a dot product near 1 cannot resolve. */
export const rotationAngle = (a, b, scratch) => { scratch.copy(a).invert().multiply(b); return 2 * Math.atan2(Math.hypot(scratch.x, scratch.y, scratch.z), Math.abs(scratch.w)); };

/** Source seconds of output key `k` (30 Hz): piecewise linear through `keys` ([simulation tick, source seconds]), clamped outside them. */
export function exactTimeline(keys) {
  return (k) => {
    const tick = k * TICKS_PER_SECOND / FPS;
    if (tick <= keys[0][0]) return keys[0][1];
    if (tick >= keys.at(-1)[0]) return keys.at(-1)[1];
    let i = 0;
    while (i < keys.length - 2 && tick > keys[i + 1][0]) i += 1;
    const [t0, s0] = keys[i], [t1, s1] = keys[i + 1];
    return s0 + (s1 - s0) * ((tick - t0) / (t1 - t0));
  };
}

/** Frames (`rotations` of every joint, `positions` of the Hips) of `count` keys of a loaded take at `sourceTime(k)`. */
export function sampleExact(rig, take, count, sourceTime) {
  const hips = rig.index.get(HIPS);
  const frames = { rotations: rig.names.map(() => undefined), positions: rig.names.map(() => undefined) };
  for (const node of rig.joints) frames.rotations[node] = new Float32Array(count * 4);
  frames.positions[hips] = new Float32Array(count * 3);
  for (let k = 0; k < count; k += 1) take.sample(frames, k, sourceTime(k));
  return frames;
}

/**
 * The exactness gate: every stored key of every joint (but `skip`) against the FBX local at the key's source time, read independently from the raw FBX
 * keys. Throws above `EXACT_TOLERANCE_DEGREES`; returns `{ maxDegrees, worst }`.
 */
export function exactnessGate(label, rig, take, frames, count, sourceTime, skip = new Set()) {
  const a = new Quaternion(), b = new Quaternion(), relative = new Quaternion();
  let maxDegrees = 0, worst = '';
  for (let k = 0; k < count; k += 1) for (const node of rig.joints) {
    if (skip.has(node)) continue;
    const degrees = rotationAngle(a.fromArray(frames.rotations[node], k * 4).normalize(), take.localAt(node, sourceTime(k), b), relative) / DEG;
    if (degrees > maxDegrees) { maxDegrees = degrees; worst = `${rig.names[node].replace('mixamorig:', '')} @key ${k}`; }
  }
  if (maxDegrees > EXACT_TOLERANCE_DEGREES) throw new Error(`${label}: output differs from the Mixamo take by ${maxDegrees.toFixed(4)}° at ${worst} (limit ${EXACT_TOLERANCE_DEGREES}°)`);
  return { maxDegrees, worst };
}

/** Largest first-vs-last-key difference (degrees) over every joint: a loop's seam, measured and reported (exact loops are not blended). */
export function loopSeamDegrees(rig, frames, count) {
  const a = new Quaternion(), b = new Quaternion(), relative = new Quaternion();
  let seam = 0;
  for (const node of rig.joints) seam = Math.max(seam, rotationAngle(a.fromArray(frames.rotations[node], 0), b.fromArray(frames.rotations[node], (count - 1) * 4), relative) / DEG);
  return seam;
}
