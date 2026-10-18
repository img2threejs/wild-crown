// Shared kit for authoring and conditioning Tripo creature clips (biped, avian, serpentine).
// Poses are expressed as world-space rotation increments applied joint by joint down the hierarchy
// (W'_j = d_j * D_parent * W_rest_j, local_j = W'_parent^-1 * W'_j), so authored angles do not depend on
// Tripo's arbitrary bone axes. Everything is deterministic: the same inputs give byte-identical GLBs.
import { Matrix4, Quaternion, Vector3 } from 'three';
import { encodeGlb, parseGlb, readAccessor } from './author-quadruped-clips.mjs';

export { encodeGlb, parseGlb };
export const FPS = 30;
export const DEG = Math.PI / 180;
export const TAU = Math.PI * 2;
export const MONSTER_SLOTS = [
  'monster-idle', 'monster-walk', 'monster-run', 'monster-slash', 'monster-shoot',
  'monster-jump', 'monster-hurt', 'monster-turn', 'monster-dive', 'monster-roar',
  'monster-death', 'monster-spawn',
  // Knockdown + get-up pair the physical-reaction presenter plays for a non-lethal hit (the head of `monster-death` is the impact and the
  // tail is the settled lie; `monster-knockdown` is the matched non-lethal shove to the ground, `monster-getup` the matched stand-back-up).
  'monster-knockdown', 'monster-getup',
];
/** Optional eleventh slot: a tail whip / sweep, produced only for rigs with a real tail chain (a report lists it under `slots` / `clips` when present). */
export const MONSTER_TAIL_SLOT = 'monster-tail';
/** Companion / harpy skeleton skill set (Storm Harpy native clip contract for Vara, scripts/assets/author-creature-clips.mjs):
 * idle (loop), walk (loop), takeoff, fly (loop), hover (loop), land, dive, strike, screech (sky-mark), sky-survey, hurt. */
export const HARPY_SLOTS = [
  'vara:idle', 'vara:walk', 'vara:takeoff', 'vara:fly', 'vara:hover',
  'vara:land', 'vara:dive', 'vara:strike', 'vara-sky-mark', 'vara:hurt',
  'vara-sky-survey',
];
/** Durations the Greenwake clip contract uses (seconds); finite clips are driven by normalized time. */
export const SLOT_SECONDS = {
  'monster-idle': 3.0, 'monster-walk': 1.2, 'monster-run': 0.6, 'monster-slash': 1.2, 'monster-shoot': 1.4,
  'monster-jump': 1.6, 'monster-hurt': 0.7, 'monster-turn': 1.0, 'monster-dive': 1.0, 'monster-roar': 2.0, 'monster-tail': 1.3,
  // One-shots: death ends on a held collapsed pose resting on the ground, spawn ends on the idle pose.
  'monster-death': 1.6, 'monster-spawn': 1.4,
  // Knockdown / get-up: non-lethal hit reaction. Knockdown is the same fall as the death clip but ends on an alert held lie
  // (not a limp death); get-up starts on the knockdown's last frame and ends blended into the idle pose.
  'monster-knockdown': 1.2, 'monster-getup': 1.6,
  // Storm Harpy (Vara) native clip durations.
  'vara:idle': 3.0, 'vara:walk': 0.8, 'vara:takeoff': 0.6, 'vara:fly': 0.7, 'vara:hover': 0.9,
  'vara:land': 0.7, 'vara:dive': 0.4, 'vara:strike': 0.55, 'vara-sky-mark': 0.8, 'vara:hurt': 0.5,
  'vara-sky-survey': 1,
  // Koro's companion-only gestures on the original native macaque rig.
  'koro-throw': 1.2, 'koro-push': 1.5, 'koro-distract': 1.1, 'koro-search': 1,
};
export const SLOT_LOOPS = {
  'monster-idle': true, 'monster-walk': true, 'monster-run': true, 'monster-slash': false, 'monster-shoot': false,
  'monster-jump': false, 'monster-hurt': false, 'monster-turn': true, 'monster-dive': false, 'monster-roar': false, 'monster-tail': false,
  'monster-death': false, 'monster-spawn': false,
  'monster-knockdown': false, 'monster-getup': false,
  'vara:idle': true, 'vara:walk': true, 'vara:takeoff': false, 'vara:fly': true, 'vara:hover': true,
  'vara:land': false, 'vara:dive': false, 'vara:strike': false, 'vara-sky-mark': false, 'vara:hurt': false,
  'vara-sky-survey': false,
  'koro-throw': false, 'koro-push': false, 'koro-distract': false, 'koro-search': false,
};

export const round = (value, digits = 4) => Number(value.toFixed(digits));
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const smoothstep = x => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
export const sin = (t, cycles, phase = 0) => Math.sin(TAU * (cycles * t + phase));
export const cos = (t, cycles, phase = 0) => Math.cos(TAU * (cycles * t + phase));
export const window01 = (t, a, b, c, d) => smoothstep((t - a) / (b - a)) * (1 - smoothstep((t - c) / (d - c)));

const EASE = {
  lin: x => x,
  io: x => x * x * x * (x * (6 * x - 15) + 10),
  in: x => x * x * x,
  out: x => 1 - (1 - x) ** 3,
  in2: x => x * x,
  out2: x => 1 - (1 - x) ** 2,
};
/** Piecewise eased curve through [time, value, easeIntoThisKey = 'io'] keys. */
export function curve(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1], [t1, v1, e = 'io'] = keys[i];
      return v0 + (v1 - v0) * EASE[e]((t - t0) / (t1 - t0));
    }
  }
  return keys.at(-1)[1];
}

/** Rotation vector (axis * angle) of the shortest rotation represented by q. */
export function logQ(q) {
  const s = q.w < 0 ? -1 : 1;
  const w = clamp(s * q.w, -1, 1);
  const sinHalf = Math.sqrt(Math.max(0, 1 - w * w));
  if (sinHalf < 1e-9) return new Vector3();
  return new Vector3(s * q.x, s * q.y, s * q.z).multiplyScalar(2 * Math.acos(w) / sinHalf);
}
export function expQ(v) {
  const angle = v.length();
  if (angle < 1e-12) return new Quaternion();
  return new Quaternion().setFromAxisAngle(v.clone().multiplyScalar(1 / angle), angle);
}

export class Rig {
  constructor(json) {
    this.json = json;
    const nodes = this.nodes = json.nodes;
    if (!json.skins?.length) throw new Error('Asset has no skin');
    this.joints = json.skins[0].joints;
    this.parent = new Array(nodes.length).fill(-1);
    nodes.forEach((node, i) => (node.children ?? []).forEach(child => { this.parent[child] = i; }));
    this.order = [];
    const visit = i => { this.order.push(i); (nodes[i].children ?? []).forEach(visit); };
    for (const rootNode of json.scenes[json.scene ?? 0].nodes) visit(rootNode);
    for (const [i, node] of nodes.entries()) {
      if (node.matrix) throw new Error(`Unsupported matrix transform on ${node.name ?? i}`);
    }
    this.restT = nodes.map(n => new Vector3(...(n.translation ?? [0, 0, 0])));
    this.restQ = nodes.map(n => new Quaternion(...(n.rotation ?? [0, 0, 0, 1])));
    this.restS = nodes.map(n => new Vector3(...(n.scale ?? [1, 1, 1])));
    this.restWQ = new Array(nodes.length);
    this.restP = new Array(nodes.length);
    for (const i of this.order) {
      const p = this.parent[i];
      if (p < 0) { this.restWQ[i] = this.restQ[i].clone(); this.restP[i] = this.restT[i].clone(); continue; }
      this.restWQ[i] = this.restWQ[p].clone().multiply(this.restQ[i]);
      this.restP[i] = this.restP[p].clone().add(this.restT[i].clone().multiply(this.restS[p]).applyQuaternion(this.restWQ[p]));
    }
    this.byName = new Map(nodes.map((node, i) => [node.name, i]));
    this.rootJoint = this.joints.find(j => this.parent[j] < 0 || !this.joints.includes(this.parent[j]));
  }

  index(name) {
    const i = this.byName.get(name);
    if (i === undefined) throw new Error(`Rig has no node ${name}`);
    return i;
  }

  /** True when `a` is a strict ancestor of `b`. */
  isAncestor(a, b) { for (let i = this.parent[b]; i >= 0; i = this.parent[i]) if (i === a) return true; return false; }

  /** Joint children of a node, in hierarchy order. */
  jointChildren(i) { return (this.nodes[i].children ?? []).filter(c => this.joints.includes(c)); }

  restLocals() { return { T: this.restT.map(v => v.clone()), Q: this.restQ.map(q => q.clone()) }; }

  /** Forward kinematics (world positions and rotations) from local translations and rotations. */
  world(locals) {
    const n = this.nodes.length, P = new Array(n), Q = new Array(n);
    for (const i of this.order) {
      const p = this.parent[i];
      if (p < 0) { Q[i] = locals.Q[i].clone(); P[i] = locals.T[i].clone(); continue; }
      Q[i] = Q[p].clone().multiply(locals.Q[i]);
      P[i] = P[p].clone().add(locals.T[i].clone().multiply(this.restS[p]).applyQuaternion(Q[p]));
    }
    return { P, Q };
  }

  /**
   * Local pose from world-space rotation increments (Map joint -> Quaternion). `translations` optionally
   * overrides local translations (Map joint -> Vector3), e.g. a bobbing root.
   */
  pose(increments, translations) {
    const n = this.nodes.length, Q = new Array(n), T = this.restT.map(v => v.clone()), localQ = new Array(n);
    for (const [joint, t] of translations ?? []) T[joint] = t.clone();
    for (const i of this.order) {
      const p = this.parent[i];
      const inc = increments.get(i);
      if (p < 0) {
        localQ[i] = inc ? inc.clone().multiply(this.restQ[i]) : this.restQ[i].clone();
        Q[i] = localQ[i].clone();
        continue;
      }
      const dParent = Q[p].clone().multiply(this.restWQ[p].clone().invert());
      const target = (inc ? inc.clone().multiply(dParent) : dParent).multiply(this.restWQ[i]);
      localQ[i] = Q[p].clone().invert().multiply(target);
      Q[i] = Q[p].clone().multiply(localQ[i]);
    }
    return { T, Q: localQ };
  }
}

/** Accumulates world-space increments per joint (later calls rotate after earlier ones). */
export class Increments {
  constructor() { this.map = new Map(); }
  add(joint, q) { this.map.set(joint, this.map.has(joint) ? q.clone().multiply(this.map.get(joint)) : q.clone()); return this; }
  /** Rotation about a world axis by `degrees`. */
  axis(joint, axis, degrees) { return this.add(joint, new Quaternion().setFromAxisAngle(axis, degrees * DEG)); }
}

/** Reads one animation as a sampler over local translations and rotations (STEP and LINEAR). */
export function readAnimation(rig, bin, name) {
  const json = rig.json;
  const animation = json.animations?.find(a => a.name === name);
  if (!animation) throw new Error(`No clip named ${name}`);
  const tracks = new Map();
  let duration = 0;
  for (const channel of animation.channels) {
    if (channel.target.path === 'scale') continue;
    const sampler = animation.samplers[channel.sampler];
    const times = readAccessor(json, bin, sampler.input), values = readAccessor(json, bin, sampler.output);
    duration = Math.max(duration, times[times.length - 1]);
    const width = channel.target.path === 'rotation' ? 4 : 3;
    tracks.set(`${channel.target.node}:${channel.target.path}`, { times, values, width, step: sampler.interpolation === 'STEP' });
  }
  const find = (track, t) => {
    const { times } = track;
    if (t <= times[0]) return [0, 0, 0];
    if (t >= times[times.length - 1]) return [times.length - 1, times.length - 1, 0];
    let lo = 0, hi = times.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid; }
    return [lo, hi, (t - times[lo]) / (times[hi] - times[lo])];
  };
  return {
    name, duration, tracks,
    /** Local pose (translations + rotations) at time t seconds; joints without tracks keep their rest pose. */
    sample(t) {
      const locals = rig.restLocals();
      for (const [key, track] of tracks) {
        const [nodeText, path] = key.split(':'), node = Number(nodeText), [lo, hi, f] = find(track, t);
        const a = track.values, w = track.width;
        if (path === 'rotation') {
          const qa = new Quaternion(a[lo * w], a[lo * w + 1], a[lo * w + 2], a[lo * w + 3]);
          locals.Q[node] = track.step || lo === hi ? qa : qa.slerp(new Quaternion(a[hi * w], a[hi * w + 1], a[hi * w + 2], a[hi * w + 3]), f);
        } else {
          const va = new Vector3(a[lo * w], a[lo * w + 1], a[lo * w + 2]);
          locals.T[node] = track.step || lo === hi ? va : va.lerp(new Vector3(a[hi * w], a[hi * w + 1], a[hi * w + 2]), f);
        }
      }
      return locals;
    },
  };
}

/** Appends keyframed clips (30 fps) to a GLB. clip = { name, frames, loop, poses[frames or frames+1] -> {T, Q} }. */
export function encodeClips(source, rig, clips, { translationJoints = [rig.rootJoint], keepAnimations = true } = {}) {
  const json = structuredClone(source.json);
  if (!keepAnimations) json.animations = [];
  json.animations ??= [];
  const pieces = [source.bin];
  let length = source.bin.length;
  const append = bytes => {
    const pad = (4 - length % 4) % 4;
    if (pad) { pieces.push(Buffer.alloc(pad)); length += pad; }
    const offset = length; pieces.push(bytes); length += bytes.length; return offset;
  };
  const addView = floats => {
    const bytes = Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
    json.bufferViews.push({ buffer: 0, byteOffset: append(Buffer.from(bytes)), byteLength: bytes.length });
    return json.bufferViews.length - 1;
  };
  const addAccessor = (view, count, type, extra = {}) => {
    json.accessors.push({ bufferView: view, byteOffset: 0, componentType: 5126, count, type, ...extra });
    return json.accessors.length - 1;
  };
  for (const clip of clips) {
    if (json.animations.some(a => a.name === clip.name)) throw new Error(`Duplicate clip ${clip.name}`);
    const count = clip.frames + 1;
    const times = new Float32Array(count).map((_, f) => f / FPS);
    const input = addAccessor(addView(times), count, 'SCALAR', { min: [times[0]], max: [times[count - 1]] });
    const channels = [], samplers = [];
    const track = (node, path, floats, type) => {
      samplers.push({ input, output: addAccessor(addView(floats), count, type), interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node, path } });
    };
    for (const joint of translationJoints) {
      track(joint, 'translation', Float32Array.from(clip.poses.slice(0, count).flatMap(p => [p.T[joint].x, p.T[joint].y, p.T[joint].z])), 'VEC3');
    }
    for (const joint of rig.joints) {
      const values = new Float32Array(count * 4);
      let previous;
      clip.poses.slice(0, count).forEach((pose, f) => {
        let q = pose.Q[joint].clone().normalize();
        if (f === count - 1 && clip.loop) q = new Quaternion(values[0], values[1], values[2], values[3]);
        else if (previous && previous.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
        values.set([q.x, q.y, q.z, q.w], f * 4);
        previous = q;
      });
      track(joint, 'rotation', values, 'VEC4');
    }
    json.animations.push({ name: clip.name, channels, samplers });
  }
  json.buffers = [{ byteLength: length }];
  return { json, bin: Buffer.concat(pieces, length) };
}

/** World positions of a few named joints plus mesh-extreme probes, used to measure authored clips. */
export function horizontalDrift(rig, clip, joint) {
  const rest = rig.restP[joint];
  let max = 0;
  const start = rig.world(clip.poses[0]).P[joint];
  let net = 0;
  clip.poses.forEach((pose, f) => {
    const p = rig.world(pose).P[joint];
    max = Math.max(max, Math.hypot(p.x - rest.x, p.z - rest.z));
    if (f === clip.poses.length - 1) net = Math.hypot(p.x - start.x, p.z - start.z);
  });
  return { maxFromRest: max, net };
}

// ---------------------------------------------------------------------------------------------
// Body frame, pose builder with two-bone IK
// ---------------------------------------------------------------------------------------------
/** Orthonormal body frame: F forward (head direction), U up, L = U x F (left). Angles are degrees. */
export class BodyFrame {
  constructor(forward) {
    this.F = forward.clone().normalize();
    this.U = new Vector3(0, 1, 0);
    this.L = new Vector3().crossVectors(this.U, this.F);
  }
  /** Rotation raising the nose (forward -> up) by `degrees`; negative lowers it. */
  pitch(degrees) { return new Quaternion().setFromAxisAngle(this.L, -degrees * DEG); }
  /** Rotation turning the nose to the left by `degrees`. */
  yaw(degrees) { return new Quaternion().setFromAxisAngle(this.U, degrees * DEG); }
  /** Rotation banking to the left (left side down) by `degrees`. */
  roll(degrees) { return new Quaternion().setFromAxisAngle(this.F, -degrees * DEG); }
  /** Combined [pitchUp, yawLeft, rollLeft] (degrees) as yaw * pitch * roll. */
  euler([pitch = 0, yaw = 0, roll = 0]) { return this.yaw(yaw).multiply(this.pitch(pitch)).multiply(this.roll(roll)); }
  /** Point in world space from body coordinates (forward, up, left) offsets. */
  at(origin, forward = 0, up = 0, left = 0) { return origin.clone().addScaledVector(this.F, forward).addScaledVector(this.U, up).addScaledVector(this.L, left); }
}

const fromTo = (a, b) => new Quaternion().setFromUnitVectors(a.clone().normalize(), b.clone().normalize());

const hingeBasis = new Matrix4();
function hingeWorldRotation(direction, normal, wantedDirection, wantedNormal, worldQ) {
  const x = direction.clone().normalize(), y = normal.clone().cross(x).normalize();
  const rest = new Quaternion().setFromRotationMatrix(hingeBasis.makeBasis(x, y, normal));
  x.copy(wantedDirection).normalize(); y.copy(wantedNormal).cross(x).normalize();
  return new Quaternion().setFromRotationMatrix(hingeBasis.makeBasis(x, y, wantedNormal)).multiply(rest.invert()).multiply(worldQ).normalize();
}

/** Fixed-length anatomical two-bone reach. A signed hinge frame removes shortest-arc roll flips at the rest-axis antipode. */
export function solveHingedTwoBone(S, E, H, target, hint, upperQ, lowerQ) {
  const first = E.clone().sub(S), second = H.clone().sub(E), l1 = first.length(), l2 = second.length();
  if (l1 < 1e-9 || l2 < 1e-9) throw new Error('A native hinge needs two positive-length anatomical bones');
  const nativeAxis = H.clone().sub(S), nativeNormal = first.clone().cross(second);
  if (nativeAxis.lengthSq() < 1e-18) nativeAxis.copy(first);
  nativeAxis.normalize();
  if (nativeNormal.lengthSq() < 1e-8 * l1 * l1 * l2 * l2) nativeNormal.copy(hint ?? new Vector3(0, 0, 1)).cross(nativeAxis);
  if (nativeNormal.lengthSq() < 1e-10) nativeNormal.set(Math.abs(nativeAxis.x) < .8 ? 1 : 0, 0, Math.abs(nativeAxis.x) < .8 ? 0 : 1).cross(nativeAxis);
  nativeNormal.normalize();
  const axis = target.clone().sub(S), reach = axis.length();
  if (reach < 1e-9) axis.copy(nativeAxis); else axis.multiplyScalar(1 / reach);
  const smaller = Math.min(l1, l2), distance = clamp(reach, Math.abs(l1 - l2) + smaller * 1e-4, l1 + l2 - smaller * .06);
  const pole = (hint ?? first).clone().addScaledVector(axis, -(hint ?? first).dot(axis));
  if (pole.lengthSq() < 1e-10) pole.copy(axis).cross(nativeNormal);
  if (pole.lengthSq() < 1e-10) {
    pole.set(Math.abs(axis.x) < .8 ? 1 : 0, 0, Math.abs(axis.x) < .8 ? 0 : 1);
    pole.addScaledVector(axis, -pole.dot(axis));
  }
  pole.normalize();
  const normal = pole.clone().cross(axis).normalize();
  const along = (l1 * l1 - l2 * l2 + distance * distance) / (2 * distance), height = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  const elbow = S.clone().addScaledVector(axis, along).addScaledVector(pole, height), end = S.clone().addScaledVector(axis, distance);
  return {
    upper: hingeWorldRotation(first, nativeNormal, elbow.clone().sub(S), normal, upperQ),
    lower: hingeWorldRotation(second, nativeNormal, end.clone().sub(elbow), normal, lowerQ),
    end,
  };
}

export class PoseBuilder {
  /** Wide attack arcs lock the anatomical hinge frame; conditioned lifecycle poses retain minimal-swing joint rotations. */
  constructor(rig, preserveHingeFrame = false) { this.rig = rig; this.preserveHingeFrame = preserveHingeFrame; this.inc = new Increments(); this.translations = new Map(); this.ik = []; }
  rotate(joint, q) { this.inc.add(joint, q); return this; }
  /** Rotates a root-level joint about a world pivot (its own origin moves accordingly). */
  rotateAbout(joint, q, pivot) {
    this.inc.add(joint, q);
    const rest = this.rig.restP[joint], moved = pivot.clone().add(rest.clone().sub(pivot).applyQuaternion(q));
    this.translate(joint, moved.sub(rest));
    return this;
  }
  /** Adds a world-space offset to a joint's rest position (only valid for joints whose parent does not move). */
  translate(joint, delta) {
    const parent = this.rig.parent[joint], parentQ = parent >= 0 ? this.rig.restWQ[parent] : new Quaternion();
    const current = this.translations.get(joint) ?? this.rig.restT[joint];
    this.translations.set(joint, current.clone().add(delta.clone().applyQuaternion(parentQ.clone().invert())));
    return this;
  }
  /**
   * Plants a two-bone chain: after all increments queued so far, `end` reaches `target` (clamped to the chain length),
   * bending towards `hint` (a world direction). `keepEndWorld` restores the end joint's rest world orientation.
   */
  reach(upper, lower, end, target, hint, keepEndWorld = false) { this.ik.push({ upper, lower, end, target, hint, keepEndWorld }); return this; }
  /**
   * Turns `joint` so the segment towards `child` points along `direction`, evaluated after every increment and earlier reach / aim queued so far
   * (so chains are aimed from the parent outward). `direction` is a world vector or a function of the segment's current world direction
   * (e.g. flattening its height); the segment keeps its length and the joint keeps its position.
   */
  aim(joint, child, direction) { this.ik.push({ aim: { joint, child, direction } }); return this; }
  /**
   * After the reaches / aims queued so far, turns `joint` and everything below it rigidly about the world `axis` through the joint's own origin by
   * `degrees` (a twist an aim cannot express). World-space increments of descendants are conjugated by the turn so the subtree keeps its shape.
   */
  spin(joint, axis, degrees) { this.ik.push({ spin: { joint, q: new Quaternion().setFromAxisAngle(axis.clone().normalize(), degrees * DEG) } }); return this; }

  solve() {
    const rig = this.rig;
    for (const entry of this.ik) {
      if (entry.spin) {
        const { joint, q } = entry.spin, back = q.clone().invert();
        for (const [descendant, inc] of this.inc.map) if (rig.isAncestor(joint, descendant)) this.inc.map.set(descendant, q.clone().multiply(inc).multiply(back));
        this.inc.add(joint, q);
        continue;
      }
      if (entry.aim) {
        const { joint, child, direction } = entry.aim;
        const state = rig.world(rig.pose(this.inc.map, this.translations));
        const current = state.P[child].clone().sub(state.P[joint]).normalize();
        const wanted = (typeof direction === 'function' ? direction(current.clone()) : direction).clone().normalize();
        this.inc.add(joint, fromTo(current, wanted));
        continue;
      }
      const { upper, lower, end, target, hint, keepEndWorld } = entry;
      const state = rig.world(rig.pose(this.inc.map, this.translations));
      const S = state.P[upper], E = state.P[lower], H = state.P[end];
      if (!this.preserveHingeFrame) {
        const l1 = E.distanceTo(S), l2 = H.distanceTo(E);
        const toTarget = target.clone().sub(S);
        const d = clamp(toTarget.length(), Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
        const axis = toTarget.clone().normalize();
        const along = (l1 * l1 - l2 * l2 + d * d) / (2 * d), height = Math.sqrt(Math.max(0, l1 * l1 - along * along));
        let pole = (hint ?? E.clone().sub(S)).clone();
        pole.addScaledVector(axis, -pole.dot(axis));
        if (pole.lengthSq() < 1e-10) pole = new Vector3(0, 1, 0).addScaledVector(axis, -axis.y);
        pole.normalize();
        const elbow = S.clone().addScaledVector(axis, along).addScaledVector(pole, height);
        const q1 = fromTo(E.clone().sub(S), elbow.clone().sub(S));
        this.inc.add(upper, q1);
        const handAfter = S.clone().add(H.clone().sub(S).applyQuaternion(q1));
        const q2 = fromTo(handAfter.clone().sub(elbow), S.clone().addScaledVector(axis, d).sub(elbow));
        this.inc.add(lower, q2);
        if (keepEndWorld) {
          const after = rig.world(rig.pose(this.inc.map, this.translations));
          this.inc.add(end, rig.restWQ[end].clone().multiply(after.Q[end].clone().invert()));
        }
        continue;
      }
      const reached = solveHingedTwoBone(S, E, H, target, hint, state.Q[upper], state.Q[lower]);
      const q1 = reached.upper.clone().multiply(state.Q[upper].clone().invert());
      this.inc.add(upper, q1);
      const carriedLower = q1.clone().multiply(state.Q[lower]);
      this.inc.add(lower, reached.lower.clone().multiply(carriedLower.invert()));
      if (keepEndWorld) {
        const after = rig.world(rig.pose(this.inc.map, this.translations));
        const wanted = after.Q[end].clone().slerp(rig.restWQ[end], Number(keepEndWorld));
        this.inc.add(end, wanted.multiply(after.Q[end].clone().invert()));
      }
    }
    return rig.pose(this.inc.map, this.translations);
  }
}

// ---------------------------------------------------------------------------------------------
// Preset conditioning: window, retime and loop-close a Tripo preset clip
// ---------------------------------------------------------------------------------------------
/** Piecewise-linear map from normalized output time to source seconds through [out, src] anchors. */
export function anchorMap(anchors) {
  return u => {
    if (u <= anchors[0][0]) return anchors[0][1];
    for (let i = 1; i < anchors.length; i++) {
      if (u <= anchors[i][0]) {
        const [u0, s0] = anchors[i - 1], [u1, s1] = anchors[i];
        return s0 + (s1 - s0) * (u - u0) / (u1 - u0);
      }
    }
    return anchors.at(-1)[1];
  };
}

/** Blends two local poses (slerp rotations, lerp translations). */
export function blendLocals(rig, a, b, w) {
  return { T: a.T.map((t, i) => t.clone().lerp(b.T[i], w)), Q: a.Q.map((q, i) => q.clone().slerp(b.Q[i], w)) };
}

/** Moves `joint` horizontally (world XZ) by `delta`, expressed through its parent's current world rotation. */
export function shiftJointHorizontal(rig, locals, joint, deltaXZ) {
  const parent = rig.parent[joint], parentQ = rig.world(locals).Q[parent];
  locals.T[joint].add(new Vector3(deltaXZ.x, 0, deltaXZ.z).applyQuaternion(parentQ.clone().invert()));
}

/** Drops accessors nothing references and the buffer views only they used, then re-packs the binary chunk (order preserved). */
export function compactBuffers(source) {
  const json = structuredClone(source.json);
  const referenced = new Set();
  for (const mesh of json.meshes) for (const primitive of mesh.primitives) {
    Object.values(primitive.attributes).forEach(id => referenced.add(id));
    if (primitive.indices !== undefined) referenced.add(primitive.indices);
  }
  for (const skin of json.skins ?? []) if (skin.inverseBindMatrices !== undefined) referenced.add(skin.inverseBindMatrices);
  for (const animation of json.animations ?? []) for (const sampler of animation.samplers) { referenced.add(sampler.input); referenced.add(sampler.output); }
  const accessorMap = new Map(), accessors = [];
  json.accessors.forEach((accessor, id) => { if (referenced.has(id)) { accessorMap.set(id, accessors.length); accessors.push(accessor); } });
  const usedViews = new Set([...accessors.map(a => a.bufferView), ...(json.images ?? []).map(i => i.bufferView)].filter(v => v !== undefined));
  const viewMap = new Map(), views = [], pieces = [];
  let length = 0;
  json.bufferViews.forEach((view, id) => {
    if (!usedViews.has(id)) return;
    const pad = (4 - length % 4) % 4;
    if (pad) { pieces.push(Buffer.alloc(pad)); length += pad; }
    const bytes = source.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    viewMap.set(id, views.length);
    views.push({ ...view, buffer: 0, byteOffset: length });
    pieces.push(bytes); length += bytes.length;
  });
  json.bufferViews = views;
  for (const accessor of accessors) if (accessor.bufferView !== undefined) accessor.bufferView = viewMap.get(accessor.bufferView);
  for (const image of json.images ?? []) image.bufferView = viewMap.get(image.bufferView);
  json.accessors = accessors;
  const remap = id => accessorMap.get(id);
  for (const mesh of json.meshes) for (const primitive of mesh.primitives) {
    for (const name of Object.keys(primitive.attributes)) primitive.attributes[name] = remap(primitive.attributes[name]);
    if (primitive.indices !== undefined) primitive.indices = remap(primitive.indices);
  }
  for (const skin of json.skins ?? []) if (skin.inverseBindMatrices !== undefined) skin.inverseBindMatrices = remap(skin.inverseBindMatrices);
  for (const animation of json.animations ?? []) for (const sampler of animation.samplers) { sampler.input = remap(sampler.input); sampler.output = remap(sampler.output); }
  json.buffers = [{ byteLength: length }];
  return { json, bin: Buffer.concat(pieces, length) };
}

const TYPE_WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const COMPONENT_WIDTH = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
/** Reads any dense accessor (honouring byteStride and `normalized`) as a Float64Array of count * components values. */
export function readAccessorAny(json, bin, id) {
  const a = json.accessors[id], view = json.bufferViews[a.bufferView];
  const comps = TYPE_WIDTH[a.type], bytes = COMPONENT_WIDTH[a.componentType];
  const stride = view.byteStride ?? comps * bytes, base = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const out = new Float64Array(a.count * comps);
  for (let i = 0; i < a.count; i++) for (let c = 0; c < comps; c++) {
    const o = base + i * stride + c * bytes;
    let value = a.componentType === 5126 ? bin.readFloatLE(o) : a.componentType === 5123 ? bin.readUInt16LE(o) : a.componentType === 5121 ? bin.readUInt8(o) : bin.readUInt32LE(o);
    if (a.normalized) value /= a.componentType === 5123 ? 65535 : 255;
    out[i * comps + c] = value;
  }
  return out;
}

/** Skinned mesh centroid (every `stride`-th vertex) for a local pose: the whole-body in-place criterion. */
export function makeCentroidSampler(rig, bin, stride = 6) {
  const json = rig.json, primitive = json.meshes[0].primitives[0];
  const positions = readAccessorAny(json, bin, primitive.attributes.POSITION), joints = readAccessorAny(json, bin, primitive.attributes.JOINTS_0);
  const weights = readAccessorAny(json, bin, primitive.attributes.WEIGHTS_0), inverse = readAccessorAny(json, bin, json.skins[0].inverseBindMatrices);
  const count = positions.length / 3;
  return locals => {
    const { P, Q } = rig.world(locals);
    // joint matrix = world * inverseBind, applied as rotate-then-translate on the bind position
    const matrices = rig.joints.map((joint, k) => {
      const m = new Matrix4().compose(P[joint], Q[joint], new Vector3(1, 1, 1));
      return m.multiply(new Matrix4().fromArray(Array.from(inverse.subarray(k * 16, k * 16 + 16))));
    });
    const sum3 = new Vector3(), v = new Vector3(), acc = new Vector3();
    let n = 0;
    for (let i = 0; i < count; i += stride) {
      acc.set(0, 0, 0);
      for (let k = 0; k < 4; k++) {
        const w = weights[i * 4 + k];
        if (w <= 0) continue;
        v.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]).applyMatrix4(matrices[joints[i * 4 + k]]);
        acc.addScaledVector(v, w);
      }
      sum3.add(acc); n++;
    }
    return sum3.multiplyScalar(1 / n);
  };
}

/**
 * Lowest skinned vertex height (every `stride`-th vertex) for world joint positions P and rotations Q: the ground-contact criterion of
 * the death clips (the collapsed pose must rest on the floor, neither sink into it nor hover). Works for any rig shape, since it
 * skins the real mesh instead of trusting joint heights. Vertices whose dominant joint is in `ignoreJoints` are skipped: geometry bound
 * to the Root alone (chain links or tufts lying on the ground) is a ground attachment, not part of the body that collapses.
 */
export function makeLowestSampler(json, bin, joints, stride = 3, ignoreJoints = []) {
  const primitive = json.meshes[0].primitives[0];
  const positions = readAccessorAny(json, bin, primitive.attributes.POSITION), jointIds = readAccessorAny(json, bin, primitive.attributes.JOINTS_0);
  const weights = readAccessorAny(json, bin, primitive.attributes.WEIGHTS_0), inverse = readAccessorAny(json, bin, json.skins[0].inverseBindMatrices);
  const count = positions.length / 3, inverseMatrices = joints.map((_, k) => new Matrix4().fromArray(Array.from(inverse.subarray(k * 16, k * 16 + 16))));
  const unit = new Vector3(1, 1, 1), v = new Vector3();
  const ignored = new Set(ignoreJoints);
  const sampled = [];
  for (let i = 0; i < count; i += stride) {
    let dominant = 0;
    for (let k = 1; k < 4; k++) if (weights[i * 4 + k] > weights[i * 4 + dominant]) dominant = k;
    if (!ignored.has(joints[jointIds[i * 4 + dominant]])) sampled.push(i);
  }
  return (P, Q) => {
    const matrices = joints.map((joint, k) => new Matrix4().compose(P[joint], Q[joint], unit).multiply(inverseMatrices[k]));
    let lowest = Infinity;
    for (const i of sampled) {
      let y = 0;
      for (let k = 0; k < 4; k++) {
        const w = weights[i * 4 + k];
        if (w <= 0) continue;
        y += w * v.set(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]).applyMatrix4(matrices[jointIds[i * 4 + k]]).y;
      }
      if (y < lowest) lowest = y;
    }
    return lowest;
  };
}

/**
 * Removes stray skin influences in place (Tripo auto-rigging occasionally ties a vertex to a bone on the far side of the body, e.g. a toe
 * vertex weighted 23% to the beak, which stretches a spike across the model as soon as that bone moves). An influence is dropped when its
 * joint's rest position is farther than `minDistance` from the vertex AND farther than `ratio` times the distance to the vertex's dominant
 * joint (never closer than `floor`); the remaining weights are renormalised. Returns counts for the clips report.
 * With `groundLevel` / `groundDistance` a vertex lying on the ground (rest y <= groundLevel) that is farther than groundDistance from its
 * dominant joint (a chain link or tuft resting beside a leg yet skinned to it) is bound to the Root alone, so it stays on the ground.
 */
export function cleanStraySkinWeights(rig, json, bin, { ratio = 5, floor = 0.03, minDistance = 0.2, groundLevel, groundDistance } = {}) {
  const primitive = json.meshes[0].primitives[0];
  const positions = readAccessorAny(json, bin, primitive.attributes.POSITION), joints = readAccessorAny(json, bin, primitive.attributes.JOINTS_0), weights = readAccessorAny(json, bin, primitive.attributes.WEIGHTS_0);
  const jointAccessor = json.accessors[primitive.attributes.JOINTS_0], weightAccessor = json.accessors[primitive.attributes.WEIGHTS_0];
  const jointView = json.bufferViews[jointAccessor.bufferView], weightView = json.bufferViews[weightAccessor.bufferView];
  const jointStride = jointView.byteStride ?? 4 * COMPONENT_WIDTH[jointAccessor.componentType], weightStride = weightView.byteStride ?? 4 * COMPONENT_WIDTH[weightAccessor.componentType];
  const jointBase = (jointView.byteOffset ?? 0) + (jointAccessor.byteOffset ?? 0), weightBase = (weightView.byteOffset ?? 0) + (weightAccessor.byteOffset ?? 0);
  const writeWeight = (i, k, value) => {
    const o = weightBase + i * weightStride + k * COMPONENT_WIDTH[weightAccessor.componentType];
    if (weightAccessor.componentType === 5126) bin.writeFloatLE(value, o);
    else if (weightAccessor.componentType === 5123) bin.writeUInt16LE(Math.round(value * 65535), o);
    else bin.writeUInt8(Math.round(value * 255), o);
  };
  const writeJoint = (i, k, value) => {
    const o = jointBase + i * jointStride + k * COMPONENT_WIDTH[jointAccessor.componentType];
    if (jointAccessor.componentType === 5123) bin.writeUInt16LE(value, o); else bin.writeUInt8(value, o);
  };
  let vertices = 0, removed = 0, grounded = 0;
  const rootIndex = rig.joints.indexOf(rig.rootJoint);
  for (let i = 0; i < positions.length / 3; i++) {
    const p = new Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    const distance = k => p.distanceTo(rig.restP[rig.joints[joints[i * 4 + k]]]);
    let dominant = 0;
    for (let k = 1; k < 4; k++) if (weights[i * 4 + k] > weights[i * 4 + dominant]) dominant = k;
    if (groundLevel !== undefined && p.y <= groundLevel && distance(dominant) > groundDistance) {
      writeWeight(i, 0, 1); writeJoint(i, 0, rootIndex);
      for (let k = 1; k < 4; k++) { writeWeight(i, k, 0); writeJoint(i, k, 0); }
      grounded++;
      continue;
    }
    const limit = Math.max(minDistance, ratio * Math.max(floor, distance(dominant)));
    const keep = [0, 1, 2, 3].map(k => weights[i * 4 + k] > 0 && distance(k) <= limit);
    const dropped = [0, 1, 2, 3].filter(k => weights[i * 4 + k] > 0 && !keep[k]);
    if (!dropped.length || !keep[dominant]) continue;
    const total = [0, 1, 2, 3].reduce((s, k) => s + (keep[k] ? weights[i * 4 + k] : 0), 0);
    for (let k = 0; k < 4; k++) {
      if (keep[k]) writeWeight(i, k, weights[i * 4 + k] / total);
      else { writeWeight(i, k, 0); writeJoint(i, k, 0); }
    }
    vertices++; removed += dropped.length;
  }
  return { verticesCleaned: vertices, influencesRemoved: removed, ratio, floor, minDistance, ...(groundLevel === undefined ? {} : { groundAnchoredVertices: grounded, groundLevel, groundDistance }) };
}
