import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { encodeGlb, parseGlb, transplantAnimations } from './import-aren-animation-set.mjs';
import { resolveMixamoSources } from './mixamo-import.mjs';
import { AREN_EXACT, createMixamoExact, exactnessGate, exactTimeline, loopSeamDegrees, sampleExact } from './mixamo-exact.mjs';

/**
 * Retargets Tripo combat clips onto Aren's 65-joint Mixamo skeleton and appends them to the playtest GLB.
 *
 * Tripo re-rigged the same Aren mesh (22 mixamo joints below a rotated 'Root'); its local joint frames differ from the
 * runtime skeleton, so retargeting is done per frame in world space against both rest poses. Every clip is warped
 * so that its strike frame lands on the simulation's hit tick: the controller samples finite actions by
 * `normalizedTime = (tick - actionStartedTick) / (actionEndsTick - actionStartedTick)` and CombatEngine resolves the
 * impact on `activeAt`, so `contactOutput / duration` must equal `activeTick / totalTicks`.
 *
 * Run: `node scripts/assets/retarget-aren-tripo-clips.mjs` (deterministic; reruns are byte-identical).
 */
export const FPS = 30;
const TICKS_PER_SECOND = 60;
const generated = fileURLToPath(new URL('../../asset-source/generated/', import.meta.url));
export const OUTPUT_DIRECTORY = `${generated}actor-aren-user-supplied-01/`;
export const DONORS = {
  rig: { file: 'actor-aren-tripo-rig-01/tripo-out/actor-aren-tripo-rig-01-75e69cb6/model.glb', taskId: '75e69cb6-d7ad-4db3-83a1-6e08389132f6' },
  a: { file: 'actor-aren-tripo-anim-a-01/tripo-out/actor-aren-tripo-anim-a-01-9f762457/model.glb', taskId: '9f762457-7422-453a-8240-42c383db3669' },
  b: { file: 'actor-aren-tripo-anim-b-01/tripo-out/actor-aren-tripo-anim-b-01-ef9aa285/model.glb', taskId: 'ef9aa285-4a4a-4fa5-9319-2b52ce9c94a1' },
  c: { file: 'actor-aren-tripo-anim-c-01/tripo-out/actor-aren-tripo-anim-c-01-5b96245e/model.glb', taskId: '5b96245e-6640-4d23-8bb4-b520939d5b6f' },
  d: { file: 'actor-aren-tripo-anim-d-01/tripo-out/actor-aren-tripo-anim-d-01-af8260fb/model.glb', taskId: 'af8260fb-fb18-4a74-ad54-6bcfcd021a33', credits: 50, presets: ['golf', 'pitch_baseball', 'lift_heavy', 'dig', 'volleyball'] },
  e: { file: 'actor-aren-tripo-anim-e-01/tripo-out/actor-aren-tripo-anim-e-01-0ea3e070/model.glb', taskId: '0ea3e070-b33c-40ad-9d98-f3ffd61111a8', credits: 50, presets: ['run_upstairs', 'football_pass', 'flee_02', 'basketball_shot', 'shovel'] },
};
const NATIVE_CROSS_KICK = '1 High and long jump with a cross-kick..001';
const UPPER_BODY = /^mixamorig:(Spine\d?|Neck|Head|(Left|Right)(Shoulder|Arm|ForeArm|Hand))$/;
const HANDS = ['RightHand', 'LeftHand'], FEET = ['RightFoot', 'LeftFoot'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** Left/right partner of a joint name (centre joints map to themselves). */
const mirrorName = (name) => name.replace(/^(mixamorig:)(Left|Right)/, (_, prefix, side) => prefix + (side === 'Left' ? 'Right' : 'Left'));

/**
 * Simulation timing (CombatEngine.startPlayerAction / evasion.ts): the finite clip spans `totalTicks` (or `lockTicks + recoveryTicks`)
 * and the impact (or the evasion's committed flight end) is resolved on `activeTick`.
 * `window` is the donor segment [start, end]; `contact.settle` moves the peak-speed instant to the end of the swing.
 * `mirror` plays the donor reflected across the sagittal plane (left-hand strikes become right-hand ones); `parts`/`keys`/`loop`
 * are described at `buildClip`. `aim` ([tick, yaw°, pitch°, weight?], yaw 0 forward, + toward Aren's left) steers the glaive.
 */
/** An exact Mixamo take of Aren's (asset-source/mixamo/aren-skills): played as delivered, see `buildExactClip`. */
const AX = (file) => ({ donor: 'aren-exact', file: `asset-source/mixamo/aren-skills/${file}` });
const CARRY = [15, 30];
export const CLIP_SPECS = [
  // Aren's idle and every Warden skill play an Adobe Mixamo take exactly as delivered, exported onto his own uploaded character `aren-mixamo`
  // (asset-source/mixamo/aren-skills, ledger provenance.json; mixamo-exact.mjs AREN_EXACT): no limits, no aim, no seam or idle blends. `keys`
  // ([simulation tick, source seconds]) only warp time: each blow's fastest hand motion sits on the simulation's hit tick, so the cue timing holds.
  // Loops (`window`) play their whole take, which starts and ends on the same pose (seam reported). The glaive is placed per clip at runtime
  // (src/rendering/warden-glaive-profiles.json).
  // Idle: a relaxed, attack-ready combat stance (the glaive held low and back, the free fist up).
  { clip: 'aren-idle', exact: true, source: AX('sword-and-shield-idle.fbx'), loop: true, window: [0, 2.5333] },
  { clip: 'aren-light-1', exact: true, source: AX('great-sword-low-slash.fbx'), sim: { totalTicks: 26, activeTick: 9 }, keys: [[0, 0.5], [9, 0.8], [26, 1.4]] },
  { clip: 'aren-light-2', exact: true, source: AX('great-sword-downward-slash.fbx'), sim: { totalTicks: 28, activeTick: 10 }, keys: [[0, 0.3], [10, 0.57], [28, 1.2]] },
  // Light 3 is the simulation's spin (it turns Aren 360° over ticks 12–30), so its take is a level sweep that does not turn the hips itself.
  { clip: 'aren-light-3', exact: true, source: AX('standing-melee-attack-horizontal.fbx'), sim: { totalTicks: 34, activeTick: 10 }, keys: [[0, 0.62], [10, 0.97], [34, 1.75]] },
  { clip: 'aren-light-4', exact: true, source: AX('great-sword-power-slash.fbx'), sim: { totalTicks: 40, activeTick: 15 }, keys: [[0, 0.35], [15, 0.73], [40, 1.55]] },
  { clip: 'aren-sigil-charge', exact: true, source: AX('two-handed-sword-spell-cast.fbx'), loop: true, window: [0, 1.1333] },
  { clip: 'aren-sigil-bolt', exact: true, source: AX('standing-2h-magic-attack-01.fbx'), sim: { totalTicks: 30, activeTick: 16 }, keys: [[0, 0.55], [16, 1.13], [30, 1.7]] },
  // Barrage launches on ticks 8, 16 and 24: the take's thrust, then its sustained cast.
  { clip: 'aren-sigil-barrage', exact: true, source: AX('standing-2h-magic-attack-04.fbx'), sim: { totalTicks: 40 }, keys: [[0, 0.5], [8, 0.93], [24, 2.2], [40, 3.0]] },
  // Judgement dashes over ticks 10–21 of the clip (15–32 of the simulation): the take's slide, its slash at the end of the dash.
  { clip: 'aren-judgement', exact: true, source: AX('great-sword-slide-attack.fbx'), sim: { totalTicks: 52 }, keys: [[0, 0.6], [10, 1.0], [21, 1.5], [52, 2.1]] },
  { clip: 'aren-heavy', exact: true, source: AX('heavy-weapon-swing.fbx'), sim: { lockTicks: 45, recoveryTicks: 18, activeTick: 20 }, keys: [[0, 1.9], [20, 2.62], [63, 3.9]] },
  { clip: 'aren-charged-heavy-charge', exact: true, source: AX('great-sword-power-up.fbx'), loop: true, window: [0, 3.5] },
  { clip: 'aren-charged-heavy', exact: true, source: AX('standing-melee-run-jump-attack.fbx'), sim: { lockTicks: 58, recoveryTicks: 18, activeTick: 36 }, keys: [[0, 0.6], [36, 1.7], [76, 2.9]] },
  { clip: 'aren-root-tether', exact: true, source: AX('standing-2h-magic-area-attack-02.fbx'), sim: { lockTicks: 36, recoveryTicks: 18, activeTick: 12 }, keys: [[0, 1.3], [12, 1.8], [54, 3.2]] },
  // Cleanse plays at the simulation's own length (not stretched): its raised channel peaks on the cleanse tick 35.
  { clip: 'aren-cleanse', exact: true, source: AX('standing-2h-cast-spell-01.fbx'), sim: { lockTicks: 90, recoveryTicks: 18, activeTick: 35 }, keys: [[0, 0], [35, 0.63], [108, 2.13]] },
  { clip: 'aren-hit', source: { donor: 'b', animation: 'hit_to_body_01' }, durationSeconds: 0.35, window: [0.12, 0.9], joints: UPPER_BODY },
  { clip: 'aren-stagger', source: { donor: 'b', animation: 'hit_to_stomach' }, durationSeconds: 0.7, window: [0.1, 1.2], aim: [[0, ...CARRY], [42, ...CARRY]] },
  // Tripo's flip is a forward somersault; Back Handspring travels backwards, so the segment plays in reverse.
  { clip: 'aren-back-handspring', source: { donor: 'b', animation: 'flip' }, sim: { lockTicks: 27, recoveryTicks: 20, activeTick: 27 }, window: [3.25, 0.85], airborne: true, aim: [[0, ...CARRY], [47, ...CARRY]] },
  // Second jump ("treading the wind"), in place, 90 ticks: air steps 0–0.26 (run_upstairs, legs swapped), tucked forward somersault 0.26–0.62 (flip), open out 0.62–0.82, soft landing absorb 0.82–1.
  { clip: 'aren-air-step', sim: { totalTicks: 90 }, airborne: true, inPlace: true,
    parts: [
      { ticks: [0, 11], source: { donor: 'e', animation: 'run_upstairs' }, window: [0, 0.4] },
      { ticks: [11, 23], source: { donor: 'e', animation: 'run_upstairs' }, window: [0.4, 0.8] },
      { ticks: [23, 56], source: { donor: 'b', animation: 'flip' }, window: [1.0, 2.5] },
      { ticks: [56, 74], source: { donor: 'b', animation: 'flip' }, window: [2.5, 3.1] },
      { ticks: [74, 90], source: { donor: 'b', animation: 'flip' }, window: [3.1, 3.7] },
    ],
    aim: [[0, ...CARRY], [90, ...CARRY]] },
  // Knockdown (back, hit from front): Mixamo "Knocked Out Falling To Back". The actual fall lives in source 1.0–2.6 s; we warp
  // that whole segment onto output 0–1.5 s and freeze source 2.6 s for the held range ticks 48–90 (every key identical).
  // `inPlace: true` pins the donor Hips horizontal so the fall stays in place (within the brief's ±0.7 m budget).
  // `lyingSurface: 'Spine1'` aligns the floor by the mid-spine joint, not the feet (which hover when lying on back).
  { clip: 'aren-knockdown', source: { donor: 'mixamo', file: 'asset-source/mixamo/reactions/knocked-out-back.fbx', inPlace: true }, sim: { totalTicks: 90 }, airborne: true, lyingSurface: 'Spine1', groundContactTick: 30,
    keys: [[0, 1.0], [30, 2.4], [48, 2.6], [90, 2.6]] },
  // Knockdown-forward (stomach, hit from behind): Use Mixamo's "Standing React Death Forward" film — the only stomach-fall
  // film that starts STANDING (Hips ~0.49 m at source t=0). We play the falling portion source [0, 2.4] (well before the
  // t≈3 s death-settle) so the actor is upright at frame 0, hits the floor by tick 30 (source t≈2.0, Hips ~0.23 m), and
  // settles into a flat-prone hold by tick 48 (source t≈2.4, Hips ~0.11 m). Held-prone range ticks 48–90 = source 2.4 s
  // (constant for the verbatim contract). `inPlace: true` keeps the fall in place within the brief's ±0.7 m Hips XZ budget.
  { clip: 'aren-knockdown-forward', source: { donor: 'mixamo', file: 'asset-source/mixamo/reactions/react-forward.fbx', inPlace: true }, sim: { totalTicks: 90 }, airborne: true, lyingSurface: 'Spine1', groundContactTick: 30,
    keys: [[0, 0.0], [30, 2.0], [48, 2.4], [90, 2.4]] },
  // Get-up (back, 66 ticks): Mixamo "Kip Up" plays the full lie→knee→mid-air→plant→rise→stand (Hips 113°, UpLeg 100° in source);
  // source 0–1.7 s into 66 ticks is 1.55× (within the brief's 1.6× cap). Seam onto `aren-knockdown`'s hold via `seamFromHold`; last 25 % blend to idle.
  { clip: 'aren-getup', source: { donor: 'mixamo', file: 'asset-source/mixamo/reactions/kip-up.fbx', inPlace: true }, sim: { totalTicks: 66 }, airborne: true, lyingSurface: 'Spine1', seamFromHold: 'aren-knockdown', idleBlendTail: 0.25,
    keys: [[0, 0.0], [40, 0.5], [66, 1.7]] },
  // Get-up-forward (stomach): Mixamo "Getting Up From Stomach" plays the captured push-up rise from prone to stand
  // (Hips y goes 0.05 → 0.36 between source 2.0–3.4 s). `seamFromHold: 'aren-knockdown-forward'` with `seamBlendTicks: 12` slerps
  // every joint + Hips translation from the held-prone lie to the take's first lying frame over the first 12 ticks
  // (≈0.4 s) — both prone, same headZ sign, no body flip. Source 2.0–3.4 s into 66 ticks = 1.27× (within the 1.6× cap).
  // The last 25 % are an idle-blend tail.
  { clip: 'aren-getup-forward', source: { donor: 'mixamo', file: 'asset-source/mixamo/reactions/getting-up-stomach.fbx', inPlace: true }, sim: { totalTicks: 66 }, airborne: true, lyingSurface: 'Spine1', seamFromHold: 'aren-knockdown-forward', seamBlendTicks: 12, idleBlendTail: 0.25,
    keys: [[0, 2.0], [10, 2.1], [30, 2.4], [50, 3.0], [66, 3.4]] },
];

/** Dense float accessor → fresh Float32Array (honours byteStride). */
export function readAccessor(source, id) {
  const accessor = source.json.accessors[id], view = source.json.bufferViews[accessor.bufferView];
  if (accessor.componentType !== 5126 || accessor.sparse) throw new Error('Expected dense float accessor');
  const size = { SCALAR: 1, VEC3: 3, VEC4: 4 }[accessor.type];
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0), stride = view.byteStride ?? size * 4;
  const result = new Float32Array(accessor.count * size);
  for (let i = 0; i < accessor.count; i += 1) for (let c = 0; c < size; c += 1) result[i * size + c] = source.bin.readFloatLE(base + i * stride + c * 4);
  return result;
}

function worldQuaternion(matrix, out) {
  matrix.decompose(scratchPosition, out, scratchScale);
  return out;
}
const scratchPosition = new Vector3(), scratchScale = new Vector3();

function bracket(times, time) {
  const last = times.length - 1;
  if (time <= times[0]) return [0, 0, 0];
  if (time >= times[last]) return [last, last, 0];
  let lo = 0, hi = last;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= time) lo = mid; else hi = mid; }
  return [lo, hi, (time - times[lo]) / (times[hi] - times[lo])];
}
function sampleVector(track, time, out) {
  const [a, b, f] = bracket(track.times, time), v = track.values, w = track.step ? 0 : f;
  out.set(v[a * 3] + (v[b * 3] - v[a * 3]) * w, v[a * 3 + 1] + (v[b * 3 + 1] - v[a * 3 + 1]) * w, v[a * 3 + 2] + (v[b * 3 + 2] - v[a * 3 + 2]) * w);
}
const slerpScratch = new Quaternion();
function sampleQuaternion(track, time, out) {
  const [a, b, f] = bracket(track.times, time);
  out.fromArray(track.values, a * 4);
  if (a !== b && !track.step) out.slerp(slerpScratch.fromArray(track.values, b * 4), f);
  out.normalize();
}

/** glTF node tree with rest-local TRS, topological order and a posable local state. */
export class Rig {
  constructor(source) {
    this.source = source;
    const nodes = source.json.nodes;
    this.names = nodes.map((node) => node.name);
    this.index = new Map(this.names.map((name, i) => [name, i]));
    this.parent = new Array(nodes.length).fill(-1);
    nodes.forEach((node, i) => (node.children ?? []).forEach((child) => { this.parent[child] = i; }));
    this.order = [];
    const visit = (i) => { this.order.push(i); (nodes[i].children ?? []).forEach(visit); };
    nodes.forEach((_, i) => { if (this.parent[i] < 0) visit(i); });
    this.restPosition = nodes.map((node) => new Vector3().fromArray(node.translation ?? [0, 0, 0]));
    this.restQuaternion = nodes.map((node) => new Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]));
    this.restScale = nodes.map((node) => new Vector3().fromArray(node.scale ?? [1, 1, 1]));
    this.joints = source.json.skins[0].joints;
    this.position = this.restPosition.map((v) => v.clone());
    this.quaternion = this.restQuaternion.map((q) => q.clone());
    this.scale = this.restScale.map((v) => v.clone());
    this.world = nodes.map(() => new Matrix4());
    this.restWorld = this.evaluate().map((matrix) => matrix.clone());
    this.restWorldPosition = this.restWorld.map((m) => new Vector3().setFromMatrixPosition(m));
    this.restWorldQuaternion = this.restWorld.map((m) => worldQuaternion(m, new Quaternion()));
  }

  resetPose() {
    for (let i = 0; i < this.names.length; i += 1) { this.position[i].copy(this.restPosition[i]); this.quaternion[i].copy(this.restQuaternion[i]); this.scale[i].copy(this.restScale[i]); }
  }

  /** World matrices (shared buffers) of the current local pose. */
  evaluate() {
    const local = new Matrix4();
    for (const i of this.order) {
      local.compose(this.position[i], this.quaternion[i], this.scale[i]);
      if (this.parent[i] < 0) this.world[i].copy(local); else this.world[i].multiplyMatrices(this.world[this.parent[i]], local);
    }
    return this.world;
  }

  /** Decodes one animation into typed arrays keyed by node index. */
  decodeAnimation(name) {
    const animation = this.source.json.animations.find((item) => item.name === name);
    if (!animation) throw new Error(`Missing animation ${name}`);
    const tracks = new Map();
    for (const channel of animation.channels) {
      const sampler = animation.samplers[channel.sampler];
      if (sampler.interpolation === 'CUBICSPLINE') throw new Error('CUBICSPLINE is not supported');
      const entry = tracks.get(channel.target.node) ?? {};
      entry[channel.target.path] = { times: readAccessor(this.source, sampler.input), values: readAccessor(this.source, sampler.output), step: sampler.interpolation === 'STEP' };
      tracks.set(channel.target.node, entry);
    }
    const duration = Math.max(...[...tracks.values()].flatMap((entry) => Object.values(entry).map((track) => track.times[track.times.length - 1])));
    return { name, tracks, duration };
  }

  /** Poses the locals at `time` (rest where untracked) and returns the shared world matrices. */
  pose(decoded, time) {
    this.resetPose();
    for (const [node, entry] of decoded.tracks) {
      if (entry.translation) sampleVector(entry.translation, time, this.position[node]);
      if (entry.scale) sampleVector(entry.scale, time, this.scale[node]);
      if (entry.rotation) sampleQuaternion(entry.rotation, time, this.quaternion[node]);
    }
    return this.evaluate();
  }

  /** Poses frame `k` of resampled clip data (`rotations[node]`, optional `positions[node]`). */
  poseFrame(frames, k) {
    this.resetPose();
    frames.rotations.forEach((track, node) => { if (track) this.quaternion[node].fromArray(track, k * 4); });
    frames.positions.forEach((track, node) => { if (track) this.position[node].fromArray(track, k * 3); });
    return this.evaluate();
  }
}

/**
 * World-space rest-pose retarget of a donor animation sampled at `sourceTime(k)` for k in [0, count).
 * For every donor joint with world rest R_d and animated world W_d(t): Δ = W_d(t)·R_d⁻¹, target world rotation = Δ·R_t,
 * local = parentWorld_t(t)⁻¹·W_t. Joints absent from the donor keep their rest local. Hips translation is the target
 * rest plus the donor world displacement scaled by target/donor hip height; the horizontal displacement is relative to
 * the first sampled frame so a clip with an arbitrary authored offset stays in place.
 *
 * `mirror` reflects the whole motion across the target's sagittal plane, inferred from its bind-pose hip pair.
 * Left/right partners swap; quaternion axes reflect as pseudovectors, while hips displacement reflects as a vector.
 * This preserves forward motion for both +Z-facing and +X-facing rigs.
 */
export function retargetFrames(target, donor, decoded, count, sourceTime, mirror = false) {
  const mapped = new Map();
  for (const [name, targetIndex] of target.index) {
    const donorIndex = donor.index.get(mirror ? mirrorName(name) : name);
    if (donorIndex !== undefined && donor.joints.includes(donorIndex) && target.joints.includes(targetIndex)) mapped.set(targetIndex, donorIndex);
  }
  const hipsTarget = target.index.get('mixamorig:Hips'), hipsDonor = donor.index.get('mixamorig:Hips');
  if (!mapped.has(hipsTarget)) throw new Error('Retarget requires mixamorig:Hips on both rigs');
  const hipScale = target.restWorldPosition[hipsTarget].y / donor.restWorldPosition[hipsDonor].y;
  const lateral = new Vector3();
  if (mirror) {
    const left = target.index.get('mixamorig:LeftUpLeg'), right = target.index.get('mixamorig:RightUpLeg');
    if (left === undefined || right === undefined) throw new Error('Mirrored retarget requires the target hip pair');
    lateral.subVectors(target.restWorldPosition[right], target.restWorldPosition[left]);
    lateral.y = 0;
    if (lateral.lengthSq() < 1e-12) throw new Error('Mirrored retarget requires distinct horizontal hip positions');
    lateral.normalize();
    // Ignore bind-export float noise on cardinal planes (Aren's lateral z is 2.25e-7).
    // This keeps axis-aligned captures byte-stable without changing genuinely rotated rigs.
    lateral.set(Math.abs(lateral.x) < 1e-6 ? 0 : lateral.x, 0, Math.abs(lateral.z) < 1e-6 ? 0 : lateral.z).normalize();
  }
  const rotations = target.names.map(() => undefined);
  for (const joint of target.joints) rotations[joint] = new Float32Array(count * 4);
  const hipPositions = new Float32Array(count * 3);
  const animatedQuaternion = target.names.map(() => new Quaternion()), animatedWorld = target.names.map(() => new Matrix4());
  const delta = new Quaternion(), donorRestInverse = new Quaternion(), world = new Quaternion(), parentInverse = new Quaternion(), local = new Matrix4(), parentMatrix = new Matrix4();
  const displacement = new Vector3(), base = new Vector3(), donorPosition = new Vector3();
  for (let k = 0; k < count; k += 1) {
    const donorWorld = donor.pose(decoded, sourceTime(k));
    for (const i of target.order) {
      const parent = target.parent[i], donorIndex = mapped.get(i), pose = target.quaternion[i], position = target.position[i];
      position.copy(target.restPosition[i]);
      if (donorIndex !== undefined) {
        delta.copy(worldQuaternion(donorWorld[donorIndex], delta)).multiply(donorRestInverse.copy(donor.restWorldQuaternion[donorIndex]).invert());
        if (mirror) {
          const twiceAlong = 2 * (lateral.x * delta.x + lateral.y * delta.y + lateral.z * delta.z);
          delta.set(twiceAlong * lateral.x - delta.x, twiceAlong * lateral.y - delta.y, twiceAlong * lateral.z - delta.z, delta.w);
        }
        world.copy(delta).multiply(target.restWorldQuaternion[i]);
        if (parent < 0) pose.copy(world); else pose.copy(parentInverse.copy(animatedQuaternion[parent]).invert().multiply(world));
        pose.normalize();
      } else pose.copy(target.restQuaternion[i]);
      if (i === hipsTarget) {
        displacement.copy(donorPosition.setFromMatrixPosition(donorWorld[hipsDonor])).sub(donor.restWorldPosition[hipsDonor]);
        if (k === 0) base.set(displacement.x, 0, displacement.z);
        displacement.sub(base);
        if (mirror) displacement.addScaledVector(lateral, -2 * displacement.dot(lateral));
        displacement.multiplyScalar(hipScale).add(target.restWorldPosition[i]);
        position.copy(displacement);
        if (parent >= 0) position.applyMatrix4(parentMatrix.copy(animatedWorld[parent]).invert());
        position.toArray(hipPositions, k * 3);
      }
      if (parent < 0) animatedQuaternion[i].copy(pose); else animatedQuaternion[i].copy(animatedQuaternion[parent]).multiply(pose);
      local.compose(position, pose, target.restScale[i]);
      if (parent < 0) animatedWorld[i].copy(local); else animatedWorld[i].multiplyMatrices(animatedWorld[parent], local);
      if (rotations[i]) pose.toArray(rotations[i], k * 4);
    }
  }
  const positions = target.names.map(() => undefined);
  positions[hipsTarget] = hipPositions;
  return { rotations, positions };
}

/** Samples the target's own native animation (no retarget) as frame data. */
export function nativeFrames(target, decoded, count, sourceTime) {
  const rotations = target.names.map(() => undefined), positions = target.names.map(() => undefined);
  for (const joint of target.joints) { rotations[joint] = new Float32Array(count * 4); positions[joint] = new Float32Array(count * 3); }
  for (let k = 0; k < count; k += 1) {
    target.pose(decoded, sourceTime(k));
    for (const joint of target.joints) { target.quaternion[joint].toArray(rotations[joint], k * 4); target.position[joint].toArray(positions[joint], k * 3); }
  }
  return { rotations, positions };
}

function jointPosition(world, rig, name, out) {
  return out.setFromMatrixPosition(world[rig.index.get(`mixamorig:${name}`)]);
}

/** Largest vertical Hips excursion (metres) of an in-place clip; the hips' horizontal track is pinned to its first frame. */
export const IN_PLACE_VERTICAL_LIMIT = 0.14;

/** Pins the Hips' horizontal track to frame 0 and compresses its vertical excursion to `limit` metres (scaled about frame 0 only when exceeded). */
function flattenToInPlace(target, frames, count, limit) {
  const track = frames.positions[target.index.get('mixamorig:Hips')];
  let low = Infinity, high = -Infinity;
  for (let k = 0; k < count; k += 1) { low = Math.min(low, track[k * 3 + 1]); high = Math.max(high, track[k * 3 + 1]); }
  const scale = high - low > limit ? limit / (high - low) : 1, x = track[0], y = track[1], z = track[2];
  for (let k = 0; k < count; k += 1) { track[k * 3] = x; track[k * 3 + 1] = y + (track[k * 3 + 1] - y) * scale; track[k * 3 + 2] = z; }
}

/** Lowers the hips of grounded clips whose retargeted feet hover above the rest-pose ground (Tripo's ankle joints sit lower than Aren's). */
function lockToGround(target, frames, count) {
  const hips = frames.positions[target.index.get('mixamorig:Hips')];
  const ground = Math.min(...FEET.map((name) => target.restWorldPosition[target.index.get(`mixamorig:${name}`)].y));
  const p = new Vector3();
  for (let k = 0; k < count; k += 1) {
    const world = target.poseFrame(frames, k);
    const lift = Math.min(...FEET.map((name) => jointPosition(world, target, name, p).y)) - ground;
    if (lift > 0) hips[k * 3 + 1] -= lift;
  }
}

/** Knocked-down / get-up clips rest the body's contact point on the floor via this joint instead of the feet (whose world Y floats when lying). */
const LYING_GROUND_EPSILON = 0.02;
/** Per-frame floor alignment: translate Hips Y so a chosen contact joint (`Spine1`/`Spine2`) lands on the floor plane.
 *  When `firstFrameOnly` is true, only frame 0 receives the offset (used for get-up clips where the actor must rise from the lie).
 *  When `fromFrameToFrame` is given as `[fromFrame, toFrame]`, only that frame range receives the offset (used for knockdowns to
 *  keep the captured fall upright and only put the held-prone frames on the floor). */
function pinLyingSurface(target, frames, count, jointName, firstFrameOnly = false, fromFrameToFrame = null) {
  const hips = frames.positions[target.index.get('mixamorig:Hips')], surface = target.index.get(`mixamorig:${jointName}`);
  const p = new Vector3();
  if (firstFrameOnly) {
    const world = target.poseFrame(frames, 0);
    const y = jointPosition(world, target, jointName, p).y;
    const delta = y - LYING_GROUND_EPSILON;
    hips[0 * 3 + 1] -= delta;
    void surface;
    return;
  }
  const lo = fromFrameToFrame ? fromFrameToFrame[0] : 0;
  const hi = fromFrameToFrame ? fromFrameToFrame[1] : count;
  for (let k = lo; k < hi; k += 1) {
    const world = target.poseFrame(frames, k);
    const y = jointPosition(world, target, jointName, p).y;
    const delta = y - LYING_GROUND_EPSILON;
    hips[k * 3 + 1] -= delta;
  }
  void surface;
}

/** Slerp every `jointName` quaternion toward identity by `amount` (0..1) over a frame range. Softens captured
 *  bent-knee prone holds so the feet trail near the floor instead of pointing up like a corpse pose. */
function softenJointRange(target, frames, count, jointName, fromSec, toSec, amount) {
  const node = target.index.get(`mixamorig:${jointName}`);
  if (!frames.rotations[node]) return;
  const track = frames.rotations[node];
  const fromFrame = Math.round(fromSec * FPS), toFrame = Math.round(toSec * FPS) + 1;
  const restInverse = target.restQuaternion[node].clone().invert();
  const current = new Quaternion(), rel = new Quaternion(), reduced = new Quaternion();
  for (let k = fromFrame; k < toFrame; k += 1) {
    current.fromArray(track, k * 4);
    rel.copy(restInverse).multiply(current);
    reduced.set(0, 0, 0, 1).slerp(rel, 1 - amount);
    restInverse.clone().invert().multiply(reduced).normalize().toArray(track, k * 4);
  }
}

/** Clamp the held-lying section so every key is byte-identical (knockdown contract: ticks 48–90). */
function freezeHeldSection(frames, count, fromSeconds, toSeconds, totalTicks) {
  const fromFrame = Math.round(fromSeconds * FPS), toFrame = Math.round(toSeconds * FPS);
  const reference = count - 1;
  for (let k = fromFrame; k < toFrame; k += 1) {
    for (const list of [frames.rotations, frames.positions]) for (const track of list) if (track) {
      const stride = list === frames.rotations ? 4 : 3;
      for (let c = 0; c < stride; c += 1) track[k * stride + c] = track[reference * stride + c];
    }
  }
  void totalTicks;
}

/** Copy every joint rotation and the Hips translation from frame `fromFrame` of one frame set into frame `toFrame` of another (lying-seam continuity). */
function copyFrame(fromFrames, fromFrame, toFrames, toFrame) {
  for (const [node, track] of toFrames.rotations.entries()) if (track && fromFrames.rotations[node]) for (let c = 0; c < 4; c += 1) track[toFrame * 4 + c] = fromFrames.rotations[node][fromFrame * 4 + c];
  for (const [node, track] of toFrames.positions.entries()) if (track && fromFrames.positions[node]) for (let c = 0; c < 3; c += 1) track[toFrame * 3 + c] = fromFrames.positions[node][fromFrame * 3 + c];
}

/** Blend frames [0..N) of `toFrames` from the corresponding frame values of `fromFrames` to the natural toFrames values.
 *  `fromFrame` is a single reference index into `fromFrames`; `toFrames` is overwritten at every k in [0, N) by
 *  `slerp(fromFrames[fromFrame], toFrames[k], smoothstep(1 - k/N))` so frame 0 stays at the fromFrames pose and frame N-1 is the natural pose. */
function blendSeamFrames(fromFrames, fromFrame, toFrames, frameCount) {
  const qa = new Quaternion(), qb = new Quaternion();
  for (let k = 0; k < frameCount; k += 1) {
    const t = k / frameCount;
    const s = t * t * (3 - 2 * t); // smoothstep
    for (const [node, toTrack] of toFrames.rotations.entries()) {
      const fromTrack = fromFrames.rotations[node];
      if (!toTrack || !fromTrack) continue;
      qa.fromArray(fromTrack, fromFrame * 4);
      qb.fromArray(toTrack, k * 4);
      qa.slerp(qb, s).normalize().toArray(toTrack, k * 4);
    }
    for (const [node, toTrack] of toFrames.positions.entries()) {
      const fromTrack = fromFrames.positions[node];
      if (!toTrack || !fromTrack) continue;
      for (let c = 0; c < 3; c += 1) {
        toTrack[k * 3 + c] = fromTrack[fromFrame * 3 + c] * (1 - s) + toTrack[k * 3 + c] * s;
      }
    }
  }
}

/** Peak hips-relative speed time (seconds) of `joints` inside `search`, sampled on `frames` at FPS. */
export function peakSpeedTime(target, frames, count, joints, search) {
  const hips = new Vector3(), now = joints.map(() => new Vector3()), previous = joints.map(() => new Vector3()), p = new Vector3();
  let best = { time: undefined, speed: -1 };
  for (let k = 0; k < count; k += 1) {
    const world = target.poseFrame(frames, k);
    jointPosition(world, target, 'Hips', hips);
    joints.forEach((name, j) => now[j].copy(jointPosition(world, target, name, p)).sub(hips));
    const time = k / FPS;
    if (k > 0 && time >= search[0] && time <= search[1]) {
      const speed = Math.max(...joints.map((_, j) => now[j].distanceTo(previous[j]) * FPS));
      if (speed > best.speed) best = { time: time - 0.5 / FPS, speed };
    }
    joints.forEach((_, j) => previous[j].copy(now[j]));
  }
  if (best.time === undefined) throw new Error(`No motion found in ${search}`);
  return best;
}

function sourceFor(part, rigs) {
  const target = rigs.target;
  if (part.source.donor === 'native') return { rig: target, decoded: target.decodeAnimation(part.source.animation), native: true };
  const donor = rigs[part.source.donor];
  return { rig: donor, decoded: donor.decodeAnimation(part.source.animation), native: false };
}
function resample(target, source, count, sourceTime, mirror = false) {
  return source.native ? nativeFrames(target, source.decoded, count, sourceTime) : retargetFrames(target, source.rig, source.decoded, count, sourceTime, mirror);
}

/**
 * Native blade aim shared with src/rendering/WardenWeapon.ts: knuckle-line direction tilted toward the wrist.
 * Palm placement and handle thickness are fitted to the real hand at runtime; the clip author only needs the blade axis.
 */
export const GRIP = { tiltRadians: 0.5 };
const DEGREES = Math.PI / 180;

/** Hand-local unit vector of the glaive axis (pommel → tip) in the target bind pose. */
export function bladeAxisLocal(target) {
  const rest = (name) => target.restWorldPosition[target.index.get(`mixamorig:${name}`)];
  const inverse = target.restWorldQuaternion[target.index.get('mixamorig:RightHand')].clone().invert();
  const local = (name) => rest(name).clone().sub(rest('RightHand')).applyQuaternion(inverse);
  const axis = local('RightHandIndex1').sub(local('RightHandPinky1')).normalize();
  const wrist = local('RightHandMiddle1').negate().normalize();
  wrist.addScaledVector(axis, -wrist.dot(axis)).normalize();
  return axis.multiplyScalar(Math.cos(GRIP.tiltRadians)).addScaledVector(wrist, Math.sin(GRIP.tiltRadians)).normalize();
}

/** Aim keys are [tick, yawDegrees, pitchDegrees, weight?]; yaw 0 is forward (+z), positive toward Aren's left (+x). */
function aimAt(aim, tick, out) {
  let i = 0;
  while (i < aim.length - 2 && tick > aim[i + 1][0]) i += 1;
  const [t0, y0, p0, w0 = 1] = aim[i], [t1, y1, p1, w1 = 1] = aim[i + 1];
  const f = Math.max(0, Math.min(1, (tick - t0) / (t1 - t0)));
  const yaw = (y0 + (y1 - y0) * f) * DEGREES, pitch = (p0 + (p1 - p0) * f) * DEGREES;
  out.direction.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
  out.weight = w0 + (w1 - w0) * f;
  return out;
}

/**
 * Anatomical guard (shared with the Yara script). Limits are degrees of rest-relative rotation in the bone's own frame, split into
 * swing (bend away from the bone axis, which points at the first child joint) and twist (roll about that axis).
 *
 * Two profiles, `COMBAT_LIMITS ≤ JOINT_LIMITS` per joint:
 *  - `COMBAT_LIMITS` are the coordinator's starting limits. `buildClip` applies them to every clip that contains a retargeted Tripo
 *    segment (before the glaive aim solve), so donor twists never reach the mesh.
 *  - `JOINT_LIMITS` is the envelope calibrated so the native supplied clips (idle, walk, run, jump, dive, cheer, defeat and the
 *    cross-kick donor) pass `limitJoints` unchanged (peak ≤ 90 % of the limit, the start of the soft roll-off). A limit is raised
 *    above its starting value only as far as a native clip needs (ceil(peak / 0.9)); `NATIVE_LIMIT_RAISES` records every raise.
 *    The starting hand/head/foot twist limits are lower than what the supplied dive/defeat clips do, hence the two tiers.
 */
const COMBAT_ROWS = [
  ['Spine', 35, 25], ['Spine1', 35, 25], ['Spine2', 35, 25], ['Neck', 35, 35], ['Head', 40, 50],
  ['Shoulder', 30, 15], ['Arm', 140, 80], ['ForeArm', 150, 70], ['Hand', 75, 35],
  ['UpLeg', 120, 40], ['Leg', 150, 15], ['Foot', 50, 25], ['ToeBase', 40, 10],
];
/**
 * [joint, swing, twist, native clip that required the raise (swing | twist)] for every limit raised above the starting value.
 * Each value is ceil((peak + 0.05°) / 0.9) of the peak measured with `readClipFrames` on the delivered GLB (every native keyframe, the seven
 * NATIVE_CALIBRATION_CLIPS plus the cross-kick donor); the margin keeps the peak strictly below the soft knee (0.9 × limit) despite float32
 * rounding. Measured peaks (°): Head swing 84.54 / twist 60.30 (defeat_03), Shoulder swing 74.29 (dive) / twist 19.01 (cheer), Arm twist 125.94 (dive),
 * Hand twist 79.43 (dive), UpLeg swing 115.34 / twist 51.11 (dive), Leg twist 16.00 (idle), Foot swing 50.18 (cross-kick) / twist 43.73 (dive),
 * ToeBase swing 88.37 / twist 58.62 (defeat_03).
 */
export const NATIVE_LIMIT_RAISES = [
  ['Head', 94, 68, 'defeat_03 | defeat_03'], ['Shoulder', 83, 22, 'dive | cheer'], ['Arm', undefined, 140, 'dive'], ['Hand', undefined, 89, 'dive'],
  ['UpLeg', 129, 57, 'dive | dive'], ['Leg', undefined, 18, 'idle'], ['Foot', 56, 49, 'cross-kick | dive'], ['ToeBase', 99, 66, 'defeat_03 | defeat_03'],
];
const SIDED = new Set(['Shoulder', 'Arm', 'ForeArm', 'Hand', 'UpLeg', 'Leg', 'Foot', 'ToeBase']);
const expandLimits = (rows) => Object.freeze(Object.fromEntries(rows.flatMap(([name, swing, twist]) =>
  (SIDED.has(name) ? [`Left${name}`, `Right${name}`] : [name]).map((joint) => [`mixamorig:${joint}`, Object.freeze({ swing, twist })]))));
export const COMBAT_LIMITS = expandLimits(COMBAT_ROWS);
export const JOINT_LIMITS = expandLimits(COMBAT_ROWS.map(([name, swing, twist]) => {
  const raise = NATIVE_LIMIT_RAISES.find(([joint]) => joint === name);
  return [name, raise?.[1] ?? swing, raise?.[2] ?? twist];
}));
/** Soft clamp: identity up to 90 % of the limit, then a C1 tanh roll-off that never reaches the limit. */
const SOFT_KNEE = 0.9;
const softClamp = (x, limit) => {
  const knee = SOFT_KNEE * limit;
  return x <= knee ? x : knee + (limit - knee) * Math.tanh((x - knee) / (limit - knee));
};

/** Bone axis in the bone's own frame: towards its first child joint (falls back to +Y). */
function boneAxis(target, node) {
  const child = (target.source.json.nodes[node].children ?? []).find((c) => target.joints.includes(c));
  const axis = child === undefined ? new Vector3(0, 1, 0) : target.restPosition[child].clone();
  return axis.lengthSq() < 1e-12 ? new Vector3(0, 1, 0) : axis.normalize();
}

/** `rel = rest⁻¹·local` split as `rel = swing · twist` (twist about `axis`); returns signed twist and swing angle (radians). */
function decomposeSwingTwist(rel, axis, twistOut, swingOut) {
  if (rel.w < 0) { rel.x = -rel.x; rel.y = -rel.y; rel.z = -rel.z; rel.w = -rel.w; }
  const projection = rel.x * axis.x + rel.y * axis.y + rel.z * axis.z;
  if (projection * projection + rel.w * rel.w < 1e-12) twistOut.identity(); else twistOut.set(axis.x * projection, axis.y * projection, axis.z * projection, rel.w).normalize();
  swingOut.copy(rel).multiply(twistScratchInverse.copy(twistOut).invert());
  if (swingOut.w < 0) { swingOut.x = -swingOut.x; swingOut.y = -swingOut.y; swingOut.z = -swingOut.z; swingOut.w = -swingOut.w; }
  const twistAngle = 2 * Math.atan2(twistOut.x * axis.x + twistOut.y * axis.y + twistOut.z * axis.z, twistOut.w);
  return { twist: twistAngle, swing: 2 * Math.acos(Math.min(1, swingOut.w)) };
}
const twistScratchInverse = new Quaternion();

/** Peak swing/twist (degrees) of every limited joint over the frames; `frames.rotations` must hold the clip's rotations. */
export function jointExcursions(target, frames, count, limits = JOINT_LIMITS) {
  const result = {}, rel = new Quaternion(), local = new Quaternion(), restInverse = new Quaternion(), twistQ = new Quaternion(), swingQ = new Quaternion();
  for (const name of Object.keys(limits)) {
    const node = target.index.get(name), track = frames.rotations[node];
    if (!track) continue;
    const axis = boneAxis(target, node);
    restInverse.copy(target.restQuaternion[node]).invert();
    let swing = 0, twist = 0;
    for (let k = 0; k < count; k += 1) {
      rel.copy(restInverse).multiply(local.fromArray(track, k * 4));
      const split = decomposeSwingTwist(rel, axis, twistQ, swingQ);
      swing = Math.max(swing, split.swing); twist = Math.max(twist, Math.abs(split.twist));
    }
    result[name] = { swing: swing / DEGREES, twist: twist / DEGREES };
  }
  return result;
}

const clampRel = new Quaternion(), clampTwistQ = new Quaternion(), clampSwingQ = new Quaternion(), clampTwistNew = new Quaternion(), clampIdentity = new Quaternion(), clampRestInverse = new Quaternion();

/**
 * Clamps one local rotation `q` (rest-relative swing/twist about `axis`) to `maxSwing`/`maxTwist` radians with the soft roll-off, in place.
 * Returns the largest angular correction (radians); 0 when `q` is inside the soft knee and left bit-for-bit untouched.
 */
function clampRotation(q, restQuaternion, axis, maxSwing, maxTwist) {
  clampRel.copy(clampRestInverse.copy(restQuaternion).invert()).multiply(q);
  const { twist, swing } = decomposeSwingTwist(clampRel, axis, clampTwistQ, clampSwingQ);
  const twistLimited = softClamp(Math.abs(twist), maxTwist), swingLimited = softClamp(swing, maxSwing);
  if (twistLimited === Math.abs(twist) && swingLimited === swing) return 0;
  clampTwistNew.setFromAxisAngle(axis, Math.sign(twist) * twistLimited);
  if (swing > 1e-9) clampSwingQ.slerp(clampIdentity, 1 - swingLimited / swing);
  clampRel.copy(clampSwingQ).multiply(clampTwistNew).normalize();
  q.copy(restQuaternion).multiply(clampRel).normalize();
  return Math.max(Math.abs(twist) - twistLimited, swing - swingLimited);
}

/**
 * Clamps every limited joint's rotation to its swing/twist limits, frame by frame, with a smooth roll-off (continuous in the input, so no
 * pops). Operates on rotation tracks only (Hips translation untouched); joints without a track are skipped. Returns the largest
 * correction applied per joint (degrees) so callers can report it.
 */
export function limitJoints(target, frames, count, limits = JOINT_LIMITS) {
  const corrections = {}, local = new Quaternion();
  for (const [name, limit] of Object.entries(limits)) {
    const node = target.index.get(name), track = frames.rotations[node];
    if (!track) continue;
    const axis = boneAxis(target, node), maxSwing = limit.swing * DEGREES, maxTwist = limit.twist * DEGREES;
    let largest = 0;
    for (let k = 0; k < count; k += 1) {
      local.fromArray(track, k * 4);
      const correction = clampRotation(local, target.restQuaternion[node], axis, maxSwing, maxTwist);
      if (correction > 0) { local.toArray(track, k * 4); largest = Math.max(largest, correction / DEGREES); }
    }
    if (largest > 0) corrections[name] = round(largest, 2);
  }
  return corrections;
}

/** Dense accessor of any component type → Float64Array (normalised integers are scaled to 0..1). */
function readAccessorAny(source, id) {
  const accessor = source.json.accessors[id], view = source.json.bufferViews[accessor.bufferView];
  const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[accessor.type], width = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 }[accessor.componentType];
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0), stride = view.byteStride ?? size * width, result = new Float64Array(accessor.count * size);
  for (let i = 0; i < accessor.count; i += 1) for (let c = 0; c < size; c += 1) {
    const at = base + i * stride + c * width;
    let value = accessor.componentType === 5126 ? source.bin.readFloatLE(at) : accessor.componentType === 5123 ? source.bin.readUInt16LE(at) : accessor.componentType === 5121 ? source.bin.readUInt8(at) : source.bin.readUInt32LE(at);
    if (accessor.normalized) value /= accessor.componentType === 5123 ? 65535 : 255;
    result[i * size + c] = value;
  }
  return result;
}

/** Resamples a clip of a GLB onto its own keyframe times: `{ frames, count, times }` (frame data as `nativeFrames`). */
export function readClipFrames(rig, clipName) {
  const decoded = rig.decodeAnimation(clipName), times = [...decoded.tracks.values()].flatMap((entry) => Object.values(entry)).reduce((best, track) => (track.times.length > best.length ? track.times : best), []);
  const count = times.length, frames = nativeFrames(rig, decoded, count, (k) => times[k]);
  return { frames, count, times, decoded };
}

/** Percentile of an ascending Float32Array (nearest rank). */
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];

/**
 * Skin deformation of one clip: CPU-skins the target mesh at every keyframe and measures |ln(length / bind length)| of every unique
 * triangle edge whose bind length is ≥ 3 mm. Returns p99, p99.9 and max over all (edge, frame) samples plus the dominant bone of the
 * worst edge's heavier-weighted vertex. Pure function of the GLB bytes (deterministic).
 */
export function skinDeformationReport(glbBytes, clipName) {
  const source = parseGlb(glbBytes), rig = new Rig(source), { json } = source, primitive = json.meshes[0].primitives[0];
  const positions = readAccessorAny(source, primitive.attributes.POSITION), joints = readAccessorAny(source, primitive.attributes.JOINTS_0);
  const weights = readAccessorAny(source, primitive.attributes.WEIGHTS_0), inverseBind = readAccessorAny(source, json.skins[0].inverseBindMatrices), indices = readAccessorAny(source, primitive.indices);
  const vertexCount = positions.length / 3, jointCount = rig.joints.length;
  const seen = new Set(), edgeA = [], edgeB = [], edgeBind = [];
  for (let t = 0; t < indices.length; t += 3) for (let e = 0; e < 3; e += 1) {
    const a = indices[t + e], b = indices[t + (e + 1) % 3], low = Math.min(a, b), high = Math.max(a, b), key = low * vertexCount + high;
    if (seen.has(key)) continue;
    seen.add(key);
    const length = Math.hypot(positions[a * 3] - positions[b * 3], positions[a * 3 + 1] - positions[b * 3 + 1], positions[a * 3 + 2] - positions[b * 3 + 2]);
    if (length >= 0.003) { edgeA.push(low); edgeB.push(high); edgeBind.push(length); }
  }
  const edgeCount = edgeA.length, { count, times, decoded } = readClipFrames(rig, clipName);
  const samples = new Float32Array(edgeCount * count), skinned = new Float64Array(vertexCount * 3), matrices = new Float64Array(jointCount * 16), m = new Matrix4(), inverse = new Matrix4();
  let worst = { value: -1, edge: 0, frame: 0 };
  for (let k = 0; k < count; k += 1) {
    const world = rig.pose(decoded, times[k]);
    for (let j = 0; j < jointCount; j += 1) {
      inverse.fromArray(inverseBind, j * 16);
      m.multiplyMatrices(world[rig.joints[j]], inverse).toArray(matrices, j * 16);
    }
    for (let v = 0; v < vertexCount; v += 1) {
      const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
      let sx = 0, sy = 0, sz = 0;
      for (let s = 0; s < 4; s += 1) {
        const w = weights[v * 4 + s];
        if (w <= 0) continue;
        const o = joints[v * 4 + s] * 16;
        sx += w * (matrices[o] * x + matrices[o + 4] * y + matrices[o + 8] * z + matrices[o + 12]);
        sy += w * (matrices[o + 1] * x + matrices[o + 5] * y + matrices[o + 9] * z + matrices[o + 13]);
        sz += w * (matrices[o + 2] * x + matrices[o + 6] * y + matrices[o + 10] * z + matrices[o + 14]);
      }
      skinned[v * 3] = sx; skinned[v * 3 + 1] = sy; skinned[v * 3 + 2] = sz;
    }
    for (let e = 0; e < edgeCount; e += 1) {
      const a = edgeA[e] * 3, b = edgeB[e] * 3;
      const value = Math.abs(Math.log(Math.max(1e-9, Math.hypot(skinned[a] - skinned[b], skinned[a + 1] - skinned[b + 1], skinned[a + 2] - skinned[b + 2])) / edgeBind[e]));
      samples[k * edgeCount + e] = value;
      if (value > worst.value) worst = { value, edge: e, frame: k };
    }
  }
  const sorted = samples.sort();
  const dominant = (v) => { let best = 0; for (let s = 1; s < 4; s += 1) if (weights[v * 4 + s] > weights[v * 4 + best]) best = s; return rig.names[rig.joints[joints[v * 4 + best]]].replace('mixamorig:', ''); };
  const endA = edgeA[worst.edge], endB = edgeB[worst.edge], heaviest = (v) => Math.max(weights[v * 4], weights[v * 4 + 1], weights[v * 4 + 2], weights[v * 4 + 3]);
  return { clip: clipName, frames: count, edges: edgeCount, p99: round(percentile(sorted, 0.99), 5), p999: round(percentile(sorted, 0.999), 5), max: round(sorted[sorted.length - 1], 5), worstBone: dominant(heaviest(endA) >= heaviest(endB) ? endA : endB), worstSeconds: round(times[worst.frame], 4) };
}

/** Wrist limits: bend (swing) is expensive and bounded; roll (twist about the bone axis) is cheap, shared between forearm and hand. */
const MAX_WRIST_SWING = 40 * DEGREES, MAX_WRIST_TWIST = 100 * DEGREES, SWING_PENALTY = 0.05, FOREARM_TWIST_SHARE = 0.65;
/** Aim chain (hand first): fraction of the remaining blade error each joint absorbs per pass and the soft cap (°) of its deviation from the donor pose. */
const AIM_CHAIN = [{ joint: 'RightHand', fraction: 0.6, cap: 70 }, { joint: 'RightForeArm', fraction: 0.5, cap: 100 }, { joint: 'RightArm', fraction: 0.35, cap: 60 }];
const AIM_PASSES = 10;
const BONE_AXIS = new Vector3(0, 1, 0);
const UP_AXIS = new Vector3(0, 1, 0);
const twistScratch = new Quaternion(), swingScratch = new Quaternion();

/** Rotation about the bone axis (+Y) contained in `q` (radians, −π..π) and the angle of the remaining swing (`q = swing · twist`). */
function splitTwist(q) {
  let twist = 2 * Math.atan2(q.y, q.w);
  if (twist > Math.PI) twist -= 2 * Math.PI; else if (twist < -Math.PI) twist += 2 * Math.PI;
  swingScratch.copy(q).multiply(twistScratch.setFromAxisAngle(BONE_AXIS, twist).invert());
  return { twist, swing: 2 * Math.acos(Math.min(1, Math.abs(swingScratch.w))) };
}

/**
 * Aims the glaive. Stage 1: one constant wrist rotation (hand-local, minimal rotation from the grip axis) chosen so the blade
 * follows the authored `aim` curve as closely as the arm motion allows (deterministic Fibonacci-sphere scan inside the wrist
 * limits, then a shrinking pattern search, so reruns are byte-identical); 65 % of its roll about the forearm axis moves from the
 * hand onto the forearm bone so the wrist does not wring. Stage 2: per-frame cyclic-coordinate descent over hand, forearm and upper
 * arm (see AIM_CHAIN) closes the remaining error inside the anatomical limits.
 */
function solveWrist(target, frames, count, aim, limits) {
  const hand = target.index.get('mixamorig:RightHand'), forearm = target.index.get('mixamorig:RightForeArm'), axis = bladeAxisLocal(target);
  const track = frames.rotations[hand], forearmTrack = frames.rotations[forearm];
  const quaternions = [], desired = [], weights = [], scratch = { direction: new Vector3(), weight: 1 };
  const elbow = new Vector3(), wristPoint = new Vector3();
  for (let k = 0; k < count; k += 1) {
    const world = target.poseFrame(frames, k);
    quaternions.push(worldQuaternion(world[hand], new Quaternion()));
    if (Array.isArray(aim)) aimAt(aim, k * TICKS_PER_SECOND / FPS, scratch);
    else {
      // `{ along: 'forearm', lift }`: the blade continues the line of the striking forearm (elbow → wrist), tipped up by `lift` — the way a held
      // polearm extends the arm through every captured swing, without hand-keyed aim curves.
      elbow.setFromMatrixPosition(world[forearm]); wristPoint.setFromMatrixPosition(world[hand]);
      scratch.direction.subVectors(wristPoint, elbow).normalize().addScaledVector(UP_AXIS, aim.lift ?? 0).normalize();
      scratch.weight = 1;
    }
    desired.push(scratch.direction.clone()); weights.push(scratch.weight);
  }
  const weightSum = weights.reduce((sum, w) => sum + w, 0), probe = new Vector3(), q = new Quaternion();
  const error = (u, k) => Math.acos(Math.max(-1, Math.min(1, probe.copy(u).applyQuaternion(quaternions[k]).dot(desired[k]))));
  /** Cost of aiming the blade along hand-local `u`; Infinity outside the wrist limits. */
  const cost = (u) => {
    const { twist, swing } = splitTwist(q.setFromUnitVectors(axis, u));
    if (swing > MAX_WRIST_SWING || Math.abs(twist) > MAX_WRIST_TWIST) return Infinity;
    let sum = 0;
    for (let k = 0; k < count; k += 1) sum += weights[k] * error(u, k) ** 2;
    return sum / weightSum + SWING_PENALTY * swing ** 2 + 0.002 * twist ** 2;
  };
  const best = axis.clone();
  let bestCost = cost(best);
  // A forearm-aligned clip keeps the grip as fitted (no clip-wide wrist offset): stage 2 alone is a function of each frame, so two combo steps cut
  // from one take produce the same pose at their shared boundary.
  const candidates = Array.isArray(aim) ? 6000 : 0, golden = Math.PI * (3 - Math.sqrt(5)), u = new Vector3();
  for (let i = 0; i < candidates; i += 1) {
    const z = 1 - 2 * (i + 0.5) / candidates, r = Math.sqrt(1 - z * z);
    const c = cost(u.set(r * Math.cos(i * golden), r * Math.sin(i * golden), z));
    if (c < bestCost) { bestCost = c; best.copy(u); }
  }
  const e1 = new Vector3(), e2 = new Vector3(), next = new Vector3();
  for (const step of candidates ? [0.1, 0.05, 0.025, 0.0125, 0.006, 0.003] : []) {
    for (let improved = true; improved;) {
      improved = false;
      e1.set(1, 0, 0).cross(best).normalize(); e2.crossVectors(best, e1);
      for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const c = cost(next.copy(best).addScaledVector(e1, a * step).addScaledVector(e2, b * step).normalize());
        if (c < bestCost - 1e-12) { bestCost = c; best.copy(next); improved = true; }
      }
    }
  }
  const offset = new Quaternion().setFromUnitVectors(axis, best), constant = splitTwist(offset);
  // The constant wrist rotation: its roll about the forearm axis is shared between forearm and hand (hand world rotation is unchanged by the share).
  const share = new Quaternion().setFromAxisAngle(BONE_AXIS, constant.twist * FOREARM_TWIST_SHARE), shareInverse = share.clone().invert();
  const forearmLocal = new Quaternion(), local = new Quaternion();
  for (let k = 0; k < count; k += 1) {
    forearmLocal.fromArray(forearmTrack, k * 4).multiply(share).normalize().toArray(forearmTrack, k * 4);
    local.fromArray(track, k * 4).multiply(offset).premultiply(shareInverse).normalize().toArray(track, k * 4);
  }
  // Stage 2: per-frame cyclic-coordinate descent hand → forearm → upper arm. Each joint takes a fraction of the remaining blade error as a
  // world rotation about itself, its deviation from the donor pose is soft-capped (the arm only assists) and it is clamped to the anatomical
  // limits, so the blade follows the cut without a wrung wrist. Continuous in the error, deterministic, no per-frame state.
  const chain = AIM_CHAIN.map(({ joint, fraction, cap }) => {
    const name = `mixamorig:${joint}`, node = target.index.get(name), limit = limits[name];
    return { node, track: frames.rotations[node], fraction, cap: cap * DEGREES, axis: boneAxis(target, node), rest: target.restQuaternion[node], maxSwing: limit ? limit.swing * DEGREES : Infinity, maxTwist: limit ? limit.twist * DEGREES : Infinity, pre: new Quaternion(), current: new Quaternion() };
  });
  const handQ = new Quaternion(), parentQ = new Quaternion(), delta = new Quaternion(), conjugate = new Quaternion(), identity = new Quaternion(), blade = new Vector3(), deviation = new Quaternion();
  let maxAssist = 0, maxMoved = 0;
  for (let k = 0; k < count; k += 1) {
    for (const entry of chain) entry.pre.fromArray(entry.track, k * 4);
    for (let pass = 0; pass < AIM_PASSES; pass += 1) for (const entry of chain) {
      const world = target.poseFrame(frames, k);
      blade.copy(axis).applyQuaternion(worldQuaternion(world[hand], handQ));
      const angle = blade.angleTo(desired[k]);
      if (angle < 1e-7) continue;
      delta.setFromUnitVectors(blade, desired[k]).slerp(identity, 1 - entry.fraction);
      worldQuaternion(world[target.parent[entry.node]], parentQ);
      conjugate.copy(parentQ).invert().multiply(delta).multiply(parentQ);
      entry.current.fromArray(entry.track, k * 4).premultiply(conjugate);
      deviation.copy(entry.pre).invert().multiply(entry.current);
      if (deviation.w < 0) { deviation.x = -deviation.x; deviation.y = -deviation.y; deviation.z = -deviation.z; deviation.w = -deviation.w; }
      const moved = 2 * Math.acos(Math.min(1, deviation.w));
      if (moved > 1e-9) { deviation.slerp(identity, 1 - softClamp(moved, entry.cap) / moved); entry.current.copy(entry.pre).multiply(deviation); }
      clampRotation(entry.current, entry.rest, entry.axis, entry.maxSwing, entry.maxTwist);
      entry.current.normalize().toArray(entry.track, k * 4);
    }
    for (const [index, entry] of chain.entries()) {
      deviation.copy(entry.pre).invert().multiply(entry.current.fromArray(entry.track, k * 4));
      const moved = 2 * Math.acos(Math.min(1, Math.abs(deviation.w))) / DEGREES;
      maxMoved = Math.max(maxMoved, moved);
      if (index === AIM_CHAIN.length - 1) maxAssist = Math.max(maxAssist, moved);
    }
  }
  let sum = 0, peak = 0;
  for (let k = 0; k < count; k += 1) {
    blade.copy(axis).applyQuaternion(worldQuaternion(target.poseFrame(frames, k)[hand], handQ));
    const remaining = blade.angleTo(desired[k]) / DEGREES;
    sum += weights[k] * remaining; peak = Math.max(peak, remaining);
  }
  return { bendDegrees: constant.swing / DEGREES, rollDegrees: constant.twist / DEGREES, maxResidualDegrees: maxMoved, armAssistDegrees: maxAssist, meanErrorDegrees: sum / weightSum, maxErrorDegrees: peak };
}

const smoothstep = (t) => { const x = Math.max(0, Math.min(1, t)); return x * x * (3 - 2 * x); };

/** frames[a] ← lerp(frames[a], frames[b], s) per joint (shortest-arc slerp for rotations). */
function blendFrames(a, b, ka, kb, s, qa = new Quaternion(), qb = new Quaternion()) {
  a.rotations.forEach((track, node) => { if (track) qa.fromArray(track, ka * 4).slerp(qb.fromArray(b.rotations[node], kb * 4), s).normalize().toArray(track, ka * 4); });
  a.positions.forEach((track, node) => { if (track && b.positions[node]) for (let c = 0; c < 3; c += 1) track[ka * 3 + c] += (b.positions[node][kb * 3 + c] - track[ka * 3 + c]) * s; });
}

/**
 * Slow chest/head sway (world-space pitch about the lateral axis) so a held pose breathes; periodic in `period` frames, so loops stay seamless.
 */
function addSway(target, frames, count, period, joints, amplitude) {
  const parentWorld = new Quaternion(), sway = new Quaternion(), local = new Quaternion(), axis = new Vector3(1, 0, 0), world = new Quaternion();
  for (let k = 0; k < count; k += 1) {
    const matrices = target.poseFrame(frames, k);
    joints.forEach((name, j) => {
      const node = target.index.get(`mixamorig:${name}`), parent = target.parent[node];
      worldQuaternion(matrices[parent], parentWorld);
      sway.setFromAxisAngle(axis, amplitude * Math.sin(2 * Math.PI * k / period - j * 0.6));
      // local' = parentWorld⁻¹ · sway · parentWorld · local
      local.fromArray(frames.rotations[node], k * 4);
      world.copy(parentWorld).multiply(local);
      local.copy(parentWorld).invert().multiply(sway).multiply(world).normalize().toArray(frames.rotations[node], k * 4);
      target.poseFrame(frames, k);
    });
  }
}

/** Share of a torso yaw taken by each spine joint (bottom-up). */
const TORSO_SHARE = [['Spine', 0.3], ['Spine1', 0.3], ['Spine2', 0.4]];

/**
 * Adds a world-vertical yaw (`keys`: [tick, degrees] with smoothstep easing, positive towards Aren's left) spread over the spine, so a
 * sweep or throw is led by the body (coil, then release) instead of only by the arm. Applied before the anatomical guard.
 */
function addTorsoYaw(target, frames, count, keys) {
  const parentWorld = new Quaternion(), yaw = new Quaternion(), local = new Quaternion(), world = new Quaternion(), up = new Vector3(0, 1, 0);
  for (let k = 0; k < count; k += 1) {
    const tick = k * TICKS_PER_SECOND / FPS;
    let i = 0;
    while (i < keys.length - 2 && tick > keys[i + 1][0]) i += 1;
    const [t0, a0] = keys[i], [t1, a1] = keys[Math.min(i + 1, keys.length - 1)];
    const angle = tick <= t0 ? a0 : tick >= t1 ? a1 : a0 + (a1 - a0) * smoothstep((tick - t0) / (t1 - t0));
    for (const [name, share] of TORSO_SHARE) {
      const node = target.index.get(`mixamorig:${name}`);
      worldQuaternion(target.poseFrame(frames, k)[target.parent[node]], parentWorld);
      yaw.setFromAxisAngle(up, angle * DEGREES * share);
      local.fromArray(frames.rotations[node], k * 4);
      world.copy(parentWorld).multiply(local);
      local.copy(parentWorld).invert().multiply(yaw).multiply(world).normalize().toArray(frames.rotations[node], k * 4);
    }
  }
}

/**
 * Builds one clip. A clip is one or more parts, each a donor segment warped onto an output tick range (clamped outside it) and
 * cross-faded at the part boundaries. Within a part the warp is either `keys` ([tick, source seconds] pairs) or a contact: the
 * hips-relative peak speed of `contact.joints` found on the whole source lands on `sim.activeTick` (+ `peakTick` offset).
 * `loop` blends the tail into the head so the last frame equals the first.
 */
export function buildClip(spec, rigs) {
  const target = rigs.target;
  const parts = spec.parts ?? [spec];
  const totalTicks = spec.sim?.totalTicks ?? (spec.sim ? spec.sim.lockTicks + spec.sim.recoveryTicks : undefined);
  const duration = totalTicks !== undefined ? totalTicks / TICKS_PER_SECOND : spec.durationSeconds;
  const period = Math.round(duration * FPS), overlap = spec.loop ? Math.round(spec.loop.overlapSeconds * FPS) : 0;
  const count = period + 1, length = period / FPS, rawCount = count + overlap;
  const built = parts.map((part) => {
    // A loop's source window also covers the overlap frames (its tail continuation), so a held pose keeps playing instead of freezing on the window's end.
    const source = sourceFor(part, rigs), ticks = part.ticks ?? [0, (rawCount - 1) / FPS * TICKS_PER_SECOND];
    let contact, keys;
    if (part.keys) {
      keys = part.keys.map(([tick, seconds]) => [tick / TICKS_PER_SECOND, seconds]);
      // Keys that also name a contact: the warp is the keys' own (they place the blow and shape the recovery); the contact is reported from the
      // measured peak and the key at the hit tick, so the timing checks see the same facts as a contact-warped clip.
      if (part.contact) {
        const scanCount = Math.floor(source.decoded.duration * FPS) + 1;
        const peak = peakSpeedTime(target, resample(target, source, scanCount, (k) => k / FPS, part.mirror), scanCount, part.contact.joints, part.contact.search);
        const hit = part.keys.find(([tick]) => tick === spec.sim.activeTick);
        if (!hit) throw new Error(`${spec.clip}: keys need a key on the hit tick ${spec.sim.activeTick}`);
        contact = { peakSource: peak.time, peakSpeed: peak.speed, source: hit[1], outputFraction: spec.sim.activeTick / totalTicks, window: [part.keys[0][1], part.keys.at(-1)[1]], settle: hit[1] - peak.time, keys };
      }
    } else {
      const [start, end] = part.window;
      if (part.contact) {
        const scanCount = Math.floor(source.decoded.duration * FPS) + 1;
        const scan = resample(target, source, scanCount, (k) => k / FPS, part.mirror);
        const peak = peakSpeedTime(target, scan, scanCount, part.contact.joints, part.contact.search);
        contact = { peakSource: peak.time, peakSpeed: peak.speed, source: peak.time + part.contact.settle, outputFraction: spec.sim.activeTick / totalTicks, window: part.window, settle: part.contact.settle };
      }
      keys = contact ? [[ticks[0] / TICKS_PER_SECOND, start], [contact.outputFraction * length, contact.source], [ticks[1] / TICKS_PER_SECOND, end]] : [[ticks[0] / TICKS_PER_SECOND, start], [ticks[1] / TICKS_PER_SECOND, end]];
      if (contact) contact.keys = keys;
    }
    const sourceTime = (k) => {
      const t = k / FPS;
      if (t <= keys[0][0]) return keys[0][1];
      if (t >= keys[keys.length - 1][0]) return keys[keys.length - 1][1];
      let i = 0;
      while (i < keys.length - 2 && t > keys[i + 1][0]) i += 1;
      const [t0, s0] = keys[i], [t1, s1] = keys[i + 1];
      return t1 === t0 ? s1 : s0 + (s1 - s0) * ((t - t0) / (t1 - t0));
    };
    return { part, source, keys, contact, ticks, sourceTime };
  });
  const sample = (entry, n) => resample(target, entry.source, n, entry.sourceTime, entry.part.mirror);
  const frames = sample(built[0], rawCount);
  const crossfade = spec.crossfadeTicks ?? 3;
  for (let i = 1; i < built.length; i += 1) {
    const next = sample(built[i], rawCount), boundary = built[i].ticks[0];
    for (let k = 0; k < rawCount; k += 1) {
      const s = smoothstep((k * TICKS_PER_SECOND / FPS - (boundary - crossfade)) / (2 * crossfade));
      if (s > 0) blendFrames(frames, next, k, k, s);
    }
  }
  // Seamless loop: the head fades from the tail's continuation (frame k + period) into the clip, so frame `period` equals frame 0.
  for (let k = 0; k < overlap; k += 1) blendFrames(frames, frames, k, k + period, smoothstep(1 - k / overlap));
  if (rawCount !== count) {
    for (const list of [frames.rotations, frames.positions]) list.forEach((track, node) => { if (track) list[node] = track.slice(0, count * (list === frames.rotations ? 4 : 3)); });
  }
if (spec.sway) addSway(target, frames, count, period, spec.sway.joints, spec.sway.amplitude);
  if (spec.torso) addTorsoYaw(target, frames, count, spec.torso);
  if (spec.lyingSurface) {
    let firstFrameOnly = Boolean(spec.seamFromHold);
    let range = null;
    if (!firstFrameOnly && spec.groundContactTick && spec.sim?.totalTicks) {
      // For knockdowns, only put the held-prone pose on the floor; the upright fall uses the captured motion.
      const startFrame = Math.round((spec.groundContactTick * FPS) / spec.sim.totalTicks * (count - 1));
      range = [startFrame, count];
    }
    pinLyingSurface(target, frames, count, spec.lyingSurface, firstFrameOnly, range);
  }
  // Anatomical guard: every clip with a retargeted Tripo segment is clamped before grounding and before the glaive aim solve.
  const limits = spec.limits === undefined ? (built.some((entry) => !entry.source.native) ? COMBAT_LIMITS : null) : spec.limits;
  const guardCorrections = limits ? limitJoints(target, frames, count, limits) : {};
  if (!spec.airborne && !built.some((entry) => entry.source.native)) lockToGround(target, frames, count);
  if (spec.inPlace) flattenToInPlace(target, frames, count, IN_PLACE_VERTICAL_LIMIT);
  const aimReport = spec.aim ? solveWrist(target, frames, count, spec.aim, limits ?? JOINT_LIMITS) : undefined;
  const only = spec.joints;
  const jointNodes = target.joints.filter((node) => !only || only.test(target.names[node]));
  const keep = new Set(jointNodes);
  frames.rotations.forEach((track, node) => { if (track && !keep.has(node)) frames.rotations[node] = undefined; });
  frames.positions.forEach((track, node) => { if (track && !keep.has(node)) frames.positions[node] = undefined; });
  signContinuity(frames, count);
  for (const track of [...frames.rotations, ...frames.positions]) if (track && track.some((value) => !Number.isFinite(value))) throw new Error(`${spec.clip} contains non-finite samples`);
  // Held section freeze: knockdowns expose `sim.totalTicks` and the brief mandates every key from tick 48 to clip end is identical.
  let heldLastFrame = null;
  if (spec.lyingSurface && !spec.seamFromHold && spec.sim?.totalTicks) {
    const heldStartSec = 48 / TICKS_PER_SECOND, heldEndSec = spec.sim.totalTicks / TICKS_PER_SECOND;
    freezeHeldSection(frames, count, heldStartSec, heldEndSec, spec.sim.totalTicks);
    heldLastFrame = count - 1;
  }
  const times = Float32Array.from({ length: count }, (_, k) => k / FPS);
  const contact = built.find((entry) => entry.contact)?.contact;
  return { spec, frames, times, count, duration: length, keys: built.flatMap((entry) => entry.keys), contact, totalTicks, jointNodes, aim: aimReport, guard: guardCorrections, heldLastFrame };
}

/** Flips each rotation key into the hemisphere of the key before it, so linear sampling between keys never takes the long way round. */
function signContinuity(frames, count) {
  for (const track of frames.rotations) if (track) for (let k = 1; k < count; k += 1) {
    let dot = 0;
    for (let c = 0; c < 4; c += 1) dot += track[k * 4 + c] * track[(k - 1) * 4 + c];
    if (dot < 0) for (let c = 0; c < 4; c += 1) track[k * 4 + c] = -track[k * 4 + c];
  }
}

/**
 * An exact clip (`spec.exact`): the Mixamo take sampled at 30 Hz through the `keys` time warp (a loop: its `window`, at the take's speed), in Aren's rig
 * frame with the Hips pinned horizontally (mixamo-exact.mjs). Nothing else touches it; the exactness gate fails the build if a key differs from the FBX
 * local at its source time by more than 0.1°. A hit tick's key is reported as the contact, next to the measured fastest-hand instant around it.
 */
function buildExactClip(spec, take, target) {
  const totalTicks = spec.sim?.totalTicks ?? (spec.sim ? spec.sim.lockTicks + spec.sim.recoveryTicks : undefined);
  const keys = spec.keys ?? [[0, spec.window[0]], [(spec.window[1] - spec.window[0]) * TICKS_PER_SECOND, spec.window[1]]];
  if (totalTicks !== undefined && keys.at(-1)[0] !== totalTicks) throw new Error(`${spec.clip}: keys must end on the clip's ${totalTicks} ticks`);
  const period = Math.round(keys.at(-1)[0] / TICKS_PER_SECOND * FPS), count = period + 1;
  const sourceTime = exactTimeline(keys), frames = sampleExact(target, take, count, sourceTime);
  signContinuity(frames, count);
  for (const track of [...frames.rotations, ...frames.positions]) if (track && track.some((value) => !Number.isFinite(value))) throw new Error(`${spec.clip} contains non-finite samples`);
  const gate = exactnessGate(spec.clip, target, take, frames, count, sourceTime);
  let contact;
  if (spec.sim?.activeTick !== undefined) {
    const hit = keys.find(([tick]) => tick === spec.sim.activeTick);
    if (!hit) throw new Error(`${spec.clip}: keys need a key on the hit tick ${spec.sim.activeTick}`);
    const scanCount = Math.floor(take.duration * FPS) + 1, scan = sampleExact(target, take, scanCount, (k) => k / FPS);
    const peak = peakSpeedTime(target, scan, scanCount, ['RightHand'], [hit[1] - 0.2, hit[1] + 0.2]);
    const secondsKeys = keys.map(([tick, seconds]) => [tick / TICKS_PER_SECOND, seconds]);
    contact = { peakSource: peak.time, peakSpeed: peak.speed, source: hit[1], outputFraction: spec.sim.activeTick / totalTicks, window: [keys[0][1], keys.at(-1)[1]], settle: round(hit[1] - peak.time), keys: secondsKeys };
  }
  const times = Float32Array.from({ length: count }, (_, k) => k / FPS);
  return {
    spec, frames, times, count, duration: period / FPS, keys: keys.map(([tick, seconds]) => [tick / TICKS_PER_SECOND, seconds]), contact, totalTicks, jointNodes: [...target.joints], aim: undefined, guard: {}, heldLastFrame: null,
    exact: { file: spec.source.file, sha256: take.sha256, exactness: { maxDegrees: round(gate.maxDegrees, 5), keys: count }, ...spec.loop && { loopSeamDegrees: round(loopSeamDegrees(target, frames, count), 4) } },
  };
}

export function appendClips(baseBytes, clips) {
  const base = parseGlb(baseBytes), json = structuredClone(base.json);
  const pieces = [base.bin.subarray(0, base.json.buffers[0].byteLength)];
  let length = pieces[0].length;
  const addAccessor = (data, type, extra = {}) => {
    const padding = (4 - length % 4) % 4;
    if (padding) { pieces.push(Buffer.alloc(padding)); length += padding; }
    const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    json.bufferViews.push({ buffer: 0, byteOffset: length, byteLength: bytes.length });
    pieces.push(bytes); length += bytes.length;
    json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5126, count: data.length / { SCALAR: 1, VEC3: 3, VEC4: 4 }[type], type, ...extra });
    return json.accessors.length - 1;
  };
  const names = new Set(clips.map((clip) => clip.spec.clip));
  json.animations = (json.animations ?? []).filter((animation) => !names.has(animation.name));
  for (const clip of clips) {
    const input = addAccessor(clip.times, 'SCALAR', { min: [clip.times[0]], max: [clip.times[clip.count - 1]] });
    const animation = { name: clip.spec.clip, channels: [], samplers: [] };
    const add = (node, path, data, type) => {
      animation.samplers.push({ input, output: addAccessor(data, type), interpolation: 'LINEAR' });
      animation.channels.push({ sampler: animation.samplers.length - 1, target: { node, path } });
    };
    for (const node of clip.jointNodes) {
      // Bone lengths are rigid: only the Hips carry translation; every other joint is driven by its rotation track.
      if (clip.frames.positions[node] && json.nodes[node].name === 'mixamorig:Hips') add(node, 'translation', clip.frames.positions[node], 'VEC3');
      add(node, 'rotation', clip.frames.rotations[node], 'VEC4');
    }
    json.animations.push(animation);
  }
  json.buffers = [{ byteLength: length }];
  return encodeGlb(json, Buffer.concat(pieces, length));
}

function round(value, digits = 4) { return Number(value.toFixed(digits)); }

/** Glaive direction in the clip (yaw° 0 forward / + toward Aren's left, pitch° above horizontal) at every aim key (none for a forearm-aligned clip), plus hand-speed peaks (ticks). */
function bladeReport(clip, target) {
  const hand = target.index.get('mixamorig:RightHand'), axis = bladeAxisLocal(target), quaternion = new Quaternion(), direction = new Vector3();
  const directionAt = (k) => direction.copy(axis).applyQuaternion(worldQuaternion(target.poseFrame(clip.frames, k)[hand], quaternion));
  const keys = (Array.isArray(clip.spec.aim) ? clip.spec.aim : []).map(([tick, yaw, pitch]) => {
    const k = Math.min(clip.count - 1, Math.round(tick * FPS / TICKS_PER_SECOND)), d = directionAt(k);
    return { tick, aimYawDegrees: yaw, aimPitchDegrees: pitch, yawDegrees: round(Math.atan2(d.x, d.z) / DEGREES, 1), pitchDegrees: round(Math.asin(Math.max(-1, Math.min(1, d.y))) / DEGREES, 1) };
  });
  const hips = new Vector3(), now = new Vector3(), previous = new Vector3(), speeds = [];
  for (let k = 0; k < clip.count; k += 1) {
    const world = target.poseFrame(clip.frames, k);
    jointPosition(world, target, 'Hips', hips);
    now.setFromMatrixPosition(world[hand]).sub(hips);
    speeds.push(k > 0 ? now.distanceTo(previous) * FPS : 0);
    previous.copy(now);
  }
  const top = Math.max(...speeds);
  // Frame k's speed spans (k − 1, k): its centre sits half a frame earlier.
  const peaks = speeds.flatMap((speed, k) => k > 0 && speed >= 0.45 * top && speed >= speeds[k - 1] && speed > (speeds[k + 1] ?? 0) ? [{ tick: round((k - 0.5) * TICKS_PER_SECOND / FPS, 2), speed: round(speed, 3) }] : []);
  return { ...clip.aim && { wristBendDegrees: round(clip.aim.bendDegrees, 2), wristRollDegrees: round(clip.aim.rollDegrees, 2), maxAimDeviationDegrees: round(clip.aim.maxResidualDegrees, 2), maxArmAssistDegrees: round(clip.aim.armAssistDegrees, 2), meanAimErrorDegrees: round(clip.aim.meanErrorDegrees, 2), maxAimErrorDegrees: round(clip.aim.maxErrorDegrees, 2) }, blade: keys, handSpeedPeaks: peaks };
}

/** Per-clip numeric facts recorded in the report (and re-derived independently by the tests). */
function clipReport(clip, target, ids) {
  const { spec, frames, count, duration, contact, keys } = clip;
  const hips = target.index.get('mixamorig:Hips');
  const hipTrack = frames.positions[hips];
  const probe = { hipsY: [Infinity, -Infinity], horizontal: 0, footY: Infinity, handAboveHips: -Infinity };
  const p = new Vector3(), h = new Vector3();
  for (let k = 0; k < count; k += 1) {
    const world = target.poseFrame(frames, k);
    jointPosition(world, target, 'Hips', h);
    probe.hipsY = [Math.min(probe.hipsY[0], h.y), Math.max(probe.hipsY[1], h.y)];
    for (const foot of FEET) probe.footY = Math.min(probe.footY, jointPosition(world, target, foot, p).y);
    for (const hand of HANDS) probe.handAboveHips = Math.max(probe.handAboveHips, jointPosition(world, target, hand, p).y - h.y);
    if (hipTrack) probe.horizontal = Math.max(probe.horizontal, Math.hypot(hipTrack[k * 3] - hipTrack[0], hipTrack[k * 3 + 2] - hipTrack[2]));
  }
  const parts = spec.parts ?? [spec];
  const describe = (part) => {
    const isMixamo = part.source.donor?.startsWith('mixamo:');
    const source = part.source.donor === 'aren-exact' ? { mixamoFile: part.source.file, exact: true }
      : part.source.donor === 'native' ? { native: part.source.animation }
      : isMixamo ? { mixamoFile: part.source.file, animation: part.source.animation }
      : { taskId: ids[part.source.donor], animation: part.source.animation };
    return {
      source,
      ...part.mirror && { mirrored: true },
      ...part.window && { sourceWindowSeconds: part.window },
      ...part.keys && { tickToSourceSeconds: part.keys },
      ...part.ticks && { ticks: part.ticks },
      ...part.window && part.window[1] < part.window[0] && { reversed: true },
      ...isMixamo && { inPlace: part.source.inPlace === true },
      ...spec.lyingSurface && { lyingSurface: spec.lyingSurface },
      ...spec.seamFromHold && { seamFromHold: spec.seamFromHold },
    };
  };
  const settle = contact?.settle, window = contact?.window;
  const speeds = contact && contact.keys.slice(1).map(([t, s], i) => round(Math.abs(s - contact.keys[i][1]) / (t - contact.keys[i][0]), 3));
  return {
    action: spec.clip,
    ...parts.length === 1 ? describe(parts[0]) : { parts: parts.map(describe) },
    ...spec.loop && { loop: { periodSeconds: round(duration, 5), overlapSeconds: spec.loop.overlapSeconds } },
    outputFrames: count,
    outputDurationSeconds: round(duration, 5),
    simulation: spec.sim && { ...spec.sim.lockTicks !== undefined && { lockTicks: spec.sim.lockTicks, recoveryTicks: spec.sim.recoveryTicks }, totalTicks: clip.totalTicks, ...spec.sim.activeTick !== undefined && { activeTick: spec.sim.activeTick } },
    contact: contact && { peakSourceSeconds: round(contact.peakSource), peakHipsRelativeSpeed: round(contact.peakSpeed, 3), settleSeconds: settle, sourceSeconds: round(contact.source), outputSeconds: round(contact.outputFraction * duration, 5), outputNormalizedTime: round(contact.outputFraction, 5), peakOutputNormalizedTime: round(contact.outputFraction * (contact.peakSource - window[0]) / (contact.source - window[0]), 5) },
    playbackSpeedBeforeAfterContact: speeds,
    channels: clip.jointNodes.reduce((count, node) => count + 1 + (clip.frames.positions[node] && target.names[node] === 'mixamorig:Hips' ? 1 : 0), 0),
    hipsY: probe.hipsY.map((value) => round(value)),
    maxHorizontalHipsTravel: round(probe.horizontal),
    lowestFootY: round(probe.footY),
    maxHandHeightAboveHips: round(probe.handAboveHips),
    ...spec.aim && bladeReport(clip, target),
    ...clip.exact && { exact: clip.exact },
  };
}

function rootMotionEntry(clip, target) {
  if (clip.spec.inPlace) return { mode: 'in-place', evidenceStatus: 'verified' };
  const hips = target.index.get('mixamorig:Hips'), track = clip.frames.positions[hips];
  if (!track) return { mode: 'in-place', evidenceStatus: 'verified' };
  const samples = [0, Math.floor((clip.count - 1) / 2), clip.count - 1].map((k) => ({ time: round(k / FPS, 6), position: { x: round(track[k * 3], 6), y: round(track[k * 3 + 1], 6), z: round(track[k * 3 + 2], 6) } }));
  return { mode: 'native-root-motion', rootNodeName: 'mixamorigHips', preserveVerticalMotion: true, curveSamples: samples, evidenceStatus: 'verified' };
}

/** Native supplied clips the anatomical calibration and the deformation ceiling are measured on. */
export const NATIVE_CALIBRATION_CLIPS = ['One long jump.001', 'dive.001', 'run.001', 'walk.001', 'idle.001', 'cheer.001', 'defeat_03.001'];

/** Builds the playtest GLB (existing clips + retargeted ones) and its report from the repository sources. */
export async function retargetAren() {
  const donorNames = ['a', 'b', 'c', 'd', 'e'];
  const [seam, animationSource, rig, ...donorBytes] = await Promise.all([
    readFile(`${OUTPUT_DIRECTORY}aren-seam-repaired.glb`), readFile(`${OUTPUT_DIRECTORY}animation-source.glb`),
    readFile(`${generated}${DONORS.rig.file}`), ...donorNames.map((name) => readFile(`${generated}${DONORS[name].file}`)),
  ]);
  const base = transplantAnimations(seam, animationSource);
  const rigs = { target: new Rig(parseGlb(base.bytes)), ...Object.fromEntries(donorNames.map((name, i) => [name, new Rig(parseGlb(donorBytes[i]))])) };
  // Deep-clone CLIP_SPECS into a per-call array so resolveMixamoSources's in-place rewrites of `donor: 'mixamo:…'`
  // never leak back into the exported CLIP_SPECS (would otherwise break the byte-identical rebuild gate on a second call).
  const specs = structuredClone(CLIP_SPECS);
  const root = fileURLToPath(new URL('../../', import.meta.url));
  await resolveMixamoSources(specs, rigs, root);
  // Exact Mixamo takes (asset-source/mixamo/aren-skills): the loader checks the takes' skeleton against the rig before any is played.
  const exactApi = await createMixamoExact({ root, rig: rigs.target, ...AREN_EXACT }), takes = new Map();
  for (const spec of specs) if (spec.exact && !takes.has(spec.source.file)) takes.set(spec.source.file, await exactApi.load(spec.source.file));
  const clips = specs.map((spec) => spec.exact ? buildExactClip(spec, takes.get(spec.source.file), rigs.target) : buildClip(spec, rigs));
  // Lying-seam pass: copy each knockdown's frozen last frame into its paired get-up's frame 0 (lying pose matches every joint within the brief tolerance).
  const heldByName = Object.fromEntries(clips.filter((clip) => clip.spec.lyingSurface && !clip.spec.seamFromHold).map((clip) => [clip.spec.clip, clip]));
  const target = rigs.target;
  const byName = Object.fromEntries(clips.map((clip) => [clip.spec.clip, clip]));
  // Tails hand back to the idle the game plays: the authored `aren-idle` (its first key), else the native idle.001.
  const idle = byName['aren-idle']?.frames ?? (() => {
    try { return readClipFrames(target, 'idle.001').frames; } catch { return undefined; }
  })();
  for (const clip of clips) {
    const spec = clip.spec;
    // A release that follows a held charge (`seamFrom: { clip, ticks }`) starts on the charge loop's pose and blends into its own motion.
    if (spec.seamFrom) {
      const from = byName[spec.seamFrom.clip];
      blendSeamFrames(from.frames, from.count - 1, clip.frames, Math.min(clip.count, Math.max(1, Math.round(spec.seamFrom.ticks * FPS / TICKS_PER_SECOND))));
    }
    if (spec.seamFromHold && heldByName[spec.seamFromHold]) {
      const heldClip = heldByName[spec.seamFromHold];
      const blendTicks = spec.seamBlendTicks ?? 0;
      if (blendTicks > 0) {
        const blendFrames = Math.max(1, Math.round(blendTicks * FPS / TICKS_PER_SECOND));
        blendSeamFrames(heldClip.frames, heldClip.count - 1, clip.frames, Math.min(blendFrames, clip.count));
      } else {
        copyFrame(heldClip.frames, heldClip.count - 1, clip.frames, 0);
      }
    }
    if (spec.idleBlendTail && idle) {
      const tailStart = Math.floor(clip.count * (1 - spec.idleBlendTail));
      const qa = new Quaternion(), qb = new Quaternion();
      for (let k = tailStart; k < clip.count; k += 1) {
        const s = smoothstep((k - tailStart) / Math.max(1, (clip.count - 1) - tailStart));
        blendFrames(clip.frames, idle, k, 0, s, qa, qb);
      }
    }
  }
  const bytes = appendClips(base.bytes, clips);
  const ids = Object.fromEntries(donorNames.map((name) => [name, DONORS[name].taskId]));
  for (const spec of specs) for (const holder of spec.parts ?? [spec]) if (holder.source?.donor?.startsWith?.('mixamo:')) ids[holder.source.donor] = `mixamo:${holder.source.file}`;
  const actionToClipMapping = Object.fromEntries(clips.map((clip) => [clip.spec.clip, clip.spec.clip]));
  const rootMotion = Object.fromEntries(clips.map((clip) => [clip.spec.clip, rootMotionEntry(clip, rigs.target)]));
  const finished = new Rig(parseGlb(bytes)), peaks = (name) => { const { frames, count } = readClipFrames(finished, name); return Object.fromEntries(Object.entries(jointExcursions(finished, frames, count)).map(([joint, e]) => [joint.replace('mixamorig:', ''), { swingDegrees: round(e.swing, 1), twistDegrees: round(e.twist, 1) }])); };
  const deformation = (name) => { const { clip, frames, ...stats } = skinDeformationReport(bytes, name); void clip; void frames; return stats; };
  const nativeDeformation = Object.fromEntries(NATIVE_CALIBRATION_CLIPS.map((name) => [name, deformation(name)]));
  const report = {
    schemaVersion: 3,
    method: 'exact clips (idle and every Warden skill): Adobe Mixamo takes exported onto Aren\'s own character, sampled at 30 fps through a time warp that puts each blow on the simulation hit tick, every key within 0.1 degrees of the FBX (exactness gate); reaction and locomotion clips: world-space rest-pose retarget per frame, resampled at 30 fps, clamped to COMBAT_LIMITS (swing/twist about the bone axis)',
    exactMapping: { ...exactApi.restCheck, ledger: 'asset-source/mixamo/aren-skills/provenance.json' },
    inputs: {
      parentSeamRepairedSha256: sha256(seam), animationSourceSha256: sha256(animationSource), nativeBaseOutputSha256: sha256(base.bytes), donorImportReport: 'animation-import.json',
      tripoRig: { taskId: DONORS.rig.taskId, sha256: sha256(rig) },
      ...Object.fromEntries(donorNames.map((name, i) => [`tripoAnim${name.toUpperCase()}`, { taskId: DONORS[name].taskId, sha256: sha256(donorBytes[i]), ...DONORS[name].presets && { presets: DONORS[name].presets, creditsConsumed: DONORS[name].credits, outputDirectory: DONORS[name].file.split('/tripo-out/')[0] } }])),
    },
    grip: { tiltRadians: GRIP.tiltRadians, bladeAxisHandLocal: bladeAxisLocal(rigs.target).toArray().map((value) => round(value, 5)) },
    anatomy: {
      combatLimits: COMBAT_LIMITS, jointLimits: JOINT_LIMITS, nativeLimitRaises: NATIVE_LIMIT_RAISES.map(([joint, swing, twist, clip]) => ({ joint, swingDegrees: swing, twistDegrees: twist, requiredBy: clip })),
      nativeDeformation, nativeMaxP999: Math.max(...Object.values(nativeDeformation).map((stats) => stats.p999)),
    },
    output: { file: 'aren-playtest-animated.glb', sha256: sha256(bytes), bytes: bytes.length },
    notes: CLIP_NOTES,
    actionToClipMapping,
    rootMotion,
    clips: clips.map((clip) => ({ ...clipReport(clip, rigs.target, ids), anatomy: { guardMaxCorrectionDegrees: clip.guard, peaks: peaks(clip.spec.clip), deformation: deformation(clip.spec.clip) } })),
  };
  return { bytes, report };
}

const MANIFEST_PATH = fileURLToPath(new URL('../../asset-source/playtests/greenwake.json', import.meta.url));

function formatRootMotion(name, motion) {
  if (motion.mode === 'in-place') return `      "${name}": { "mode": "in-place", "evidenceStatus": "verified" }`;
  const samples = motion.curveSamples.map(({ time, position }) => `          { "time": ${time}, "position": { "x": ${position.x}, "y": ${position.y}, "z": ${position.z} } }`).join(',\n');
  return `      "${name}": {\n        "mode": "native-root-motion", "rootNodeName": "${motion.rootNodeName}", "preserveVerticalMotion": true,\n        "curveSamples": [\n${samples}\n        ],\n        "evidenceStatus": "verified"\n      }`;
}

/** Replaces/appends the entries of one 4-space-indented object section of the actor-aren block (entries keyed by their 6-space-indented name). */
function rewriteSection(block, key, entries) {
  const open = block.indexOf(`    "${key}": {\n`), bodyStart = block.indexOf('\n', open) + 1, bodyEnd = block.indexOf('\n    }', bodyStart);
  const existing = block.slice(bodyStart, bodyEnd).split(/,\n(?=      "[^"\s])/);
  const byName = new Map(existing.map((entry) => [/^      "([^"]+)"/.exec(entry)[1], entry]));
  for (const [name, text] of Object.entries(entries)) byName.set(name, text);
  return `${block.slice(0, bodyStart)}${[...byName.values()].join(',\n')}${block.slice(bodyEnd)}`;
}

/** Brings the actor-aren entry of the Greenwake playtest manifest in line with a retarget report (output hash, clip mapping, root-motion policies). */
export function syncManifest(text, report) {
  const start = text.indexOf('    "id": "actor-aren",'), end = text.indexOf('    "id": "actor-yara"');
  let block = text.slice(start, end);
  block = block.replace(/("outputHash": ")[0-9a-f]{64}(")/, `$1${report.output.sha256}$2`);
  block = rewriteSection(block, 'actionToClipMapping', Object.fromEntries(Object.entries(report.actionToClipMapping).map(([name, clip]) => [name, `      "${name}": "${clip}"`])));
  block = rewriteSection(block, 'rootMotion', Object.fromEntries(Object.entries(report.rootMotion).map(([name, motion]) => [name, formatRootMotion(name, motion)])));
  return text.slice(0, start) + block + text.slice(end);
}

export const CLIP_NOTES = [
  'Anatomical guard: every clip with a retargeted segment is clamped to COMBAT_LIMITS (swing/twist about each bone axis, soft roll-off) before the glaive aim solve; the aim solve distributes the blade error over hand, forearm and upper arm inside the same limits. JOINT_LIMITS is the native-calibrated envelope and is only used to report.',
  'Aren\'s idle and every Warden skill (Warden Blade 1-4, Heavy, Thunder Cleave charge and release, Sigil charge, Bolt and Barrage, Judgement, Root Tether, Cleanse) are Adobe Mixamo takes exported onto his own uploaded character aren-mixamo (asset-source/mixamo/aren-skills, ledger provenance.json) and played exactly as delivered: every key equals the FBX local at its warped source time within 0.1 degrees (`exactness`), the Hips pinned horizontally. Keys only warp time so each blow\'s fastest hand motion lands on the simulation hit tick; no limits, aim, seam or idle blend touch them. The glaive is placed per clip at runtime (src/rendering/warden-glaive-profiles.json).',
  'aren-back-handspring plays Tripo flip in reverse (forward somersault -> backward). aren-hit carries upper-body tracks only so the presentation overlay never disturbs legs or hips.',
  'aren-air-step is the in-place second-jump clip: run_upstairs air steps, flip somersault, open out and landing absorb; its Hips track is pinned horizontally and compressed vertically (IN_PLACE_VERTICAL_LIMIT).',
];

/** `--no-sync` writes the GLB and report only and leaves asset-source/playtests/greenwake.json untouched (coordinator-owned while other writers are active). */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sync = !process.argv.includes('--no-sync');
  const { bytes, report } = await retargetAren();
  await writeFile(`${OUTPUT_DIRECTORY}aren-playtest-animated.glb`, bytes);
  await writeFile(`${OUTPUT_DIRECTORY}retarget-report.json`, `${JSON.stringify(report, null, 2)}\n`);
  if (sync) await writeFile(MANIFEST_PATH, syncManifest(await readFile(MANIFEST_PATH, 'utf8'), report));
  console.log(JSON.stringify({ manifestSynced: sync, output: report.output, clips: report.clips.map((clip) => ({ action: clip.action, durationSeconds: clip.outputDurationSeconds, aimError: clip.meanAimErrorDegrees, p999: clip.anatomy.deformation.p999 })) }, null, 2));
}
