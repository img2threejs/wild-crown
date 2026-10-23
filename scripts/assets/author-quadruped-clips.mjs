#!/usr/bin/env node
// Authors the gameplay clip set for Tripo "tripo spec" quadruped rigs and bakes it into a runtime GLB.
// Tripo only ships a walk preset for quadrupeds, so every other clip is hand-authored here as real
// keyframed tracks (30 fps) on the same skeleton: monster-idle, -run, -slash, -shoot, -jump, -hurt,
// -turn, -dive, -roar. The original walk clip is preserved untouched.
//
// Usage: node scripts/assets/author-quadruped-clips.mjs <asset-id>
//   reads  asset-source/generated/<asset-id>-runtime-01/<asset-id>.glb
//   writes asset-source/generated/<asset-id>-runtime-01/<asset-id>-animated.glb  (deterministic bytes)
//          asset-source/generated/<asset-id>-runtime-01/clips-report.json
//
// Method: poses are authored as world-space rotation increments in a body frame (forward = head
// direction, up, left). Each increment is converted to a local quaternion through the hierarchy
// (W'_child = D_child * D_parent * W_rest_child, local = W'_parent^-1 * W'_child), so the authored
// numbers are independent of Tripo's arbitrary bone axes. Grounded legs are pinned to their rest foot
// positions with a FABRIK solve (bone lengths are preserved exactly; only rotations are keyed, plus
// Root translation for jump and run). The run clip is the walk clip's own leg motion, time-scaled and
// amplified about its mean pose.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Matrix4, Quaternion, Vector3 } from 'three';
// creature-rig-kit.mjs imports this module back (its container helpers are hoisted function declarations, so the cycle is safe).
import { cleanStraySkinWeights, makeLowestSampler } from './creature-rig-kit.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const FPS = 30;
export const REQUIRED_CLIPS = [
  'monster-idle', 'monster-run', 'monster-slash', 'monster-shoot', 'monster-jump',
  'monster-hurt', 'monster-turn', 'monster-dive', 'monster-roar', 'monster-death', 'monster-spawn',
  'monster-knockdown', 'monster-getup',
];
/** Optional tail whip / sweep slot, authored only for rigs that carry a real tail chain (never faked on tail-less bodies such as the toad). */
export const TAIL_CLIP = 'monster-tail';
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const round = (value, digits = 4) => Number(value.toFixed(digits));

// ---------------------------------------------------------------------------------------------
// GLB container (same container handling as scripts/assets/build-greenwake-runtime-asset.mjs)
// ---------------------------------------------------------------------------------------------
export function parseGlb(bytes) {
  if (bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2) throw new Error('Expected binary glTF 2.0');
  let json, bin;
  for (let offset = 12; offset < bytes.length;) {
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(data.toString('utf8'));
    if (type === 0x004e4942) bin = data;
    offset += 8 + length;
  }
  if (!json || !bin) throw new Error('Missing glTF JSON or binary chunk');
  return { json, bin };
}
export function encodeGlb(json, bin) {
  const text = Buffer.from(JSON.stringify(json));
  const jsonLength = (text.length + 3) & ~3, binLength = (bin.length + 3) & ~3;
  const out = Buffer.alloc(28 + jsonLength + binLength);
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(jsonLength, 12); out.writeUInt32LE(0x4e4f534a, 16);
  out.fill(32, 20, 20 + jsonLength); text.copy(out, 20);
  out.writeUInt32LE(binLength, 20 + jsonLength); out.writeUInt32LE(0x004e4942, 24 + jsonLength);
  bin.copy(out, 28 + jsonLength);
  return out;
}
const COMPONENTS = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 };
export function readAccessor(json, bin, id) {
  const accessor = json.accessors[id];
  if (accessor.componentType !== 5126 || accessor.sparse || accessor.bufferView === undefined) throw new Error(`Unsupported accessor ${id}`);
  const view = json.bufferViews[accessor.bufferView];
  const offset = bin.byteOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const count = accessor.count * COMPONENTS[accessor.type];
  // Return a VIEW (not a copy) so mutations propagate to the original bin (used by the post-encoding track-space blend).
  return new Float32Array(bin.buffer, offset, count);
}

// ---------------------------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------------------------
const IDENTITY = new Quaternion();
/** Largest pitch (degrees) the planting solver may add about the hips / Root to keep feet reachable. */
const MAX_HIP_COMPENSATION = 14;
const MAX_ROOT_COMPENSATION = 10;
/**
 * The clips whose ground guard measures the head and tail against the body's own vertical travel
 * (see the GroundGuard class comment). Only the steady locomotion is affected: every other clip
 * (idle, jump, the attacks, the roar, the reactions, the death and the entrances) keeps the absolute
 * rest-height floor, so its authored transform is untouched.
 */
const LOCOMOTION_FLOOR_CLIPS = new Set(['monster-walk', 'monster-run', 'monster-turn']);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smoothstep = x => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };

/** Rotation vector (axis * angle) of the shortest rotation represented by q. */
function logQ(q) {
  const s = q.w < 0 ? -1 : 1;
  const w = clamp(s * q.w, -1, 1);
  const sin = Math.sqrt(Math.max(0, 1 - w * w));
  if (sin < 1e-9) return new Vector3();
  return new Vector3(s * q.x, s * q.y, s * q.z).multiplyScalar(2 * Math.acos(w) / sin);
}
function expQ(v) {
  const angle = v.length();
  if (angle < 1e-12) return new Quaternion();
  return new Quaternion().setFromAxisAngle(v.clone().multiplyScalar(1 / angle), angle);
}
/** Mean orientation of a periodic sample set, computed in log space around the first sample. */
function meanQ(samples) {
  let mean = samples[0].clone();
  for (let pass = 0; pass < 3; pass++) {
    const sum = new Vector3();
    for (const q of samples) sum.add(logQ(mean.clone().invert().multiply(q)));
    mean = mean.multiply(expQ(sum.multiplyScalar(1 / samples.length)));
  }
  return mean;
}
/** Scales the rotation of q away from `mean` by `gain` (gain > 1 amplifies the swing). */
const amplifyQ = (q, mean, gain) => mean.clone().multiply(expQ(logQ(mean.clone().invert().multiply(q)).multiplyScalar(gain)));
/** Angle (radians) between two orientations after normalising both (three's angleTo is only as exact as the inputs are unit length). */
const angleBetween = (a, b) => a.clone().normalize().angleTo(b.clone().normalize());

// ---------------------------------------------------------------------------------------------
// Rig: resolves the Tripo quadruped skeleton roles from the real hierarchy
// ---------------------------------------------------------------------------------------------
const SPINE = /^tripo::Spine_(\d+)$/, HEAD = /^tripo::Head_(\d+)$/, TAIL = /^tripo::Tail_(\d+)$/;
const LEG = /^tripo::(\d+)_(Left|Right)_Limb_0$/;

export class QuadrupedRig {
  /**
   * options (all off by default so the original Tripo quadruped rigs keep their exact poses):
   *   freeHeading  body axis may sit at any yaw (spine -> head direction) instead of snapping to +-X / +-Z
   *   climbLegs    leg chains start at the helper bones above Limb_0 (up to the spine), not at Limb_0
   *   planarLegs   false: legs are solved without forcing knees into the fore/aft plane (sprawled legs)
   */
  constructor(json, options = {}) {
    this.options = options;
    this.json = json;
    const nodes = this.nodes = json.nodes;
    if (!json.skins?.length) throw new Error('Asset has no skin');
    this.joints = json.skins[0].joints;
    const jointSet = new Set(this.joints);
    this.parent = new Array(nodes.length).fill(-1);
    nodes.forEach((node, i) => (node.children ?? []).forEach(child => { this.parent[child] = i; }));
    this.order = [];
    const visit = i => { this.order.push(i); (nodes[i].children ?? []).forEach(visit); };
    for (const rootNode of json.scenes[json.scene ?? 0].nodes) visit(rootNode);
    this.restT = nodes.map(n => new Vector3(...(n.translation ?? [0, 0, 0])));
    this.restQ = nodes.map(n => new Quaternion(...(n.rotation ?? [0, 0, 0, 1])));
    for (const [i, node] of nodes.entries()) {
      if (node.scale && node.scale.some(s => Math.abs(s - 1) > 1e-4)) throw new Error(`Unsupported node scale on ${node.name ?? i}`);
      if (node.matrix) throw new Error(`Unsupported matrix transform on ${node.name ?? i}`);
    }
    this.restP = new Array(nodes.length); this.restWQ = new Array(nodes.length);
    for (const i of this.order) {
      const p = this.parent[i];
      if (p < 0) { this.restP[i] = this.restT[i].clone(); this.restWQ[i] = this.restQ[i].clone(); continue; }
      this.restWQ[i] = this.restWQ[p].clone().multiply(this.restQ[i]);
      this.restP[i] = this.restP[p].clone().add(this.restT[i].clone().applyQuaternion(this.restWQ[p]));
    }
    const named = re => this.joints.map(j => ({ j, m: re.exec(nodes[j].name) })).filter(x => x.m)
      .sort((a, b) => Number(a.m[1]) - Number(b.m[1])).map(x => x.j);
    this.rootJoint = this.joints.find(j => nodes[j].name === 'tripo::Root');
    // Joints hanging directly off the Root: lowering them together (ctl.bodyUp) lowers the whole body while skin bound to the Root alone stays put.
    this.bodyJoints = this.joints.filter(j => this.parent[j] === this.rootJoint);
    // options.explicit = { hips, torso[], neck[], head[], tail[], legs: { FL|FR|HL|HR: [hip ... foot] } } names the joints directly
    // for rigs whose Tripo bone naming does not follow the Spine / Head / Tail / Limb convention (e.g. the bog toad).
    const ex = options.explicit;
    const byName = name => { const j = this.joints.find(candidate => nodes[candidate].name === name); if (j === undefined) throw new Error(`Explicit rig mapping: no joint ${name}`); return j; };
    const spine = ex ? [ex.hips, ...ex.torso].map(byName) : named(SPINE), head = ex ? [...ex.neck, ...ex.head].map(byName) : named(HEAD), tail = ex ? ex.tail.map(byName) : named(TAIL), limbs = ex ? [] : named(LEG);
    if (this.rootJoint === undefined || spine.length < 2 || head.length < (ex ? 1 : 2) || (tail.length < 1 && !(ex && !tail.length))) throw new Error('Skeleton is not a Tripo quadruped (missing Root/Spine/Head/Tail joints)');
    this.hips = spine[0];
    this.headTip = head.at(-1);
    this.isAncestor = (a, b) => { for (let i = this.parent[b]; i >= 0; i = this.parent[i]) if (i === a) return true; return false; };
    // Tail chain: from the first Tail joint's helper ancestors down to the deepest descendant, minus
    // any joint that also carries a leg (rammer: bone_19 parents both the tail and the hind legs).
    const jointKids = i => (nodes[i].children ?? []).filter(c => jointSet.has(c));
    const depth = i => 1 + Math.max(0, ...jointKids(i).map(depth));
    if (ex) {
      this.tail = tail;
      this.tailTip = tail.length ? tail.at(-1) : this.hips; // tail-less bodies (toad): the rump stands in for the tail tip
    } else {
      const tailUp = [];
      for (let j = tail[0]; j >= 0 && j !== this.hips; j = this.parent[j]) tailUp.unshift(j);
      for (let j = tail[0]; jointKids(j).length;) {
        j = jointKids(j).reduce((best, kid) => (depth(kid) > depth(best) ? kid : best));
        tailUp.push(j);
      }
      this.tail = tailUp.filter(j => !limbs.some(limb => this.isAncestor(j, limb)));
      if (this.tail.length < 2) throw new Error('Tail chain too short');
      this.tailTip = this.tail.at(-1);
    }
    // Body frame: forward is the head direction, snapped to the dominant horizontal axis.
    const dir = this.restP[this.headTip].clone().sub(this.restP[this.tailTip]).setY(0);
    const horizontal = Math.max(Math.abs(dir.x), Math.abs(dir.z));
    const axisAligned = dir.length() >= 0.2 && horizontal / dir.length() >= 0.9;
    if (!axisAligned && !options.freeHeading) throw new Error('Head direction is not axis aligned');
    if (axisAligned) {
      this.F = Math.abs(dir.z) >= Math.abs(dir.x) ? new Vector3(0, 0, Math.sign(dir.z)) : new Vector3(Math.sign(dir.x), 0, 0);
    } else {
      // The tail may curve away from the body axis, so the heading follows hips -> head instead.
      const axis = this.restP[this.headTip].clone().sub(this.restP[this.hips]).setY(0);
      if (axis.length() < 0.2) throw new Error('Head direction is not defined');
      this.F = axis.normalize();
    }
    this.axisAligned = axisAligned;
    this.U = new Vector3(0, 1, 0);
    this.L = new Vector3().crossVectors(this.U, this.F);
    this.headAxis = axisAligned ? `${this.F.z + this.F.x > 0 ? '+' : '-'}${this.F.z !== 0 ? 'Z' : 'X'}` : `yaw ${round(Math.atan2(this.F.x, this.F.z) / DEG, 1)} deg (atan2(x, z))`;
    // Torso carriers are Spine joints (k >= 1) that carry the head; the rest are chest branches.
    const neckBase = head[0];
    this.torso = spine.slice(1).filter(j => this.isAncestor(j, neckBase));
    this.chest = spine.slice(1).filter(j => !this.isAncestor(j, neckBase));
    if (!this.torso.length) throw new Error('No spine joint carries the neck');
    const headCount = head.length > 3 ? 2 : 1;
    this.neck = head.slice(0, head.length - headCount);
    this.head = head.slice(head.length - headCount);
    // Legs: the chain follows the single real child from Limb_0; the foot is the last chain joint.
    const realKids = i => jointKids(i).filter(c => this.restT[c].length() > 0.01);
    if (!ex && limbs.length !== 4) throw new Error(`Expected 4 legs, found ${limbs.length}`);
    const mean = limbs.reduce((sum, j) => sum.add(this.restP[j]), new Vector3()).multiplyScalar(0.25);
    this.legs = {};
    const legSpecs = ex ? Object.entries(ex.legs).map(([key, names]) => ({ key, chain: names.map(byName) })) : limbs.map(limb => {
      const offset = this.restP[limb].clone().sub(mean);
      const key = `${offset.dot(this.F) > 0 ? 'F' : 'H'}${offset.dot(this.L) > 0 ? 'L' : 'R'}`;
      const chain = [limb];
      // Follow the chain while exactly one child has real length (zero-length helper bones are ignored).
      for (let kids = realKids(limb); kids.length === 1; kids = realKids(chain.at(-1))) chain.push(kids[0]);
      if (options.climbLegs) for (let p = this.parent[limb]; p >= 0 && p !== this.rootJoint && !spine.includes(p) && jointSet.has(p); p = this.parent[p]) chain.unshift(p);
      return { key, chain };
    });
    for (const { key, chain } of legSpecs) {
      if (this.legs[key]) throw new Error(`Duplicate leg ${key}`);
      const foot = chain.at(-1), leaves = [];
      const collect = i => { const kids = (nodes[i].children ?? []).filter(c => jointSet.has(c)); if (!kids.length) leaves.push(i); kids.forEach(collect); };
      collect(foot);
      this.legs[key] = {
        key, chain, foot, leaves, front: key[0] === 'F',
        lengths: chain.slice(1).map((j, i) => this.restP[j].distanceTo(this.restP[chain[i]])),
        reference: (() => {
          const ref = key[0] === 'F' ? this.torso.at(-1) : this.hips;
          if (this.order.indexOf(ref) < this.order.indexOf(chain[0])) return ref;
          // The default reference is solved after this leg (front legs hang off a lower spine joint): use the deepest spine ancestor of the leg instead.
          return [this.hips, ...this.torso].filter(j => this.isAncestor(j, chain[0])).reduce((best, j) => (this.order.indexOf(j) > this.order.indexOf(best) ? j : best));
        })(),
        // Lowest rest height of the joints between hip and foot: with options.kneeFloor the solver keeps them from sinking below it.
        floorY: options.kneeFloor ? Math.min(...chain.slice(1, -1).map(j => this.restP[j].y)) : undefined,
      };
    }
    if (Object.keys(this.legs).length !== 4) throw new Error('Leg classification failed');
    this.legKeys = ['FL', 'FR', 'HL', 'HR'];
  }

  /**
   * Probe points ride the last head / tail joints and mark the visible mesh extremes (the Tripo tip
   * joints sit inside the snout and tail tuft, so joint positions alone understate the motion).
   */
  defineProbes(min, max, vertices) {
    let front, back;
    if (this.axisAligned) {
      const along = this.F.z !== 0 ? 'z' : 'x', sign = this.F.z !== 0 ? this.F.z : this.F.x;
      front = sign > 0 ? max[along === 'z' ? 2 : 0] : -min[along === 'z' ? 2 : 0];
      back = sign > 0 ? -min[along === 'z' ? 2 : 0] : max[along === 'z' ? 2 : 0];
    } else {
      // Free heading: the extremes along F come from the actual mesh vertices (the bounding box over-reaches on a diagonal body).
      front = -Infinity; back = -Infinity;
      for (let i = 0; i < vertices.length; i += 3) { const d = vertices[i] * this.F.x + vertices[i + 2] * this.F.z; front = Math.max(front, d); back = Math.max(back, -d); }
    }
    const make = (joint, offset, direction) => ({
      joint,
      local: direction.clone().multiplyScalar(Math.max(0, offset)).applyQuaternion(this.restWQ[joint].clone().invert()),
    });
    const tipAlong = joint => this.restP[joint].dot(this.F);
    this.probes = {
      snout: make(this.headTip, front - tipAlong(this.headTip), this.F),
      tailTip: make(this.tailTip, back + tipAlong(this.tailTip), this.F.clone().negate()),
    };
  }

  probe(pose, name) {
    const { joint, local } = this.probes[name];
    return local.clone().applyQuaternion(pose.Q[joint]).add(pose.P[joint]);
  }

  /** world rotation for an authored [pitchUp, yawLeft, leanLeft] (degrees) in the body frame */
  body(angles) {
    const [pitch = 0, yaw = 0, lean = 0] = angles;
    const q = new Quaternion().setFromAxisAngle(this.U, yaw * DEG);
    q.multiply(new Quaternion().setFromAxisAngle(this.L, -pitch * DEG));
    return q.multiply(new Quaternion().setFromAxisAngle(this.F, -lean * DEG));
  }

  /** Pure forward kinematics from local rotations; returns world positions and rotations. `bodyUp` (world y) lowers / raises the Root's child joints. */
  forward(locals, rootT, bodyUp = 0) {
    const P = new Array(this.nodes.length), Q = new Array(this.nodes.length);
    for (const i of this.order) {
      const p = this.parent[i];
      let t = i === this.rootJoint ? rootT : this.restT[i];
      if (bodyUp && p >= 0 && p === this.rootJoint) t = t.clone().add(new Vector3(0, bodyUp, 0).applyQuaternion(Q[p].clone().invert()));
      if (p < 0) { Q[i] = locals[i].clone(); P[i] = t.clone(); continue; }
      Q[i] = Q[p].clone().multiply(locals[i]);
      P[i] = P[p].clone().add(t.clone().applyQuaternion(Q[p]));
    }
    return { P, Q };
  }

  /**
   * Which side of the hip -> foot axis (along the body's forward direction) each interior joint of a leg folds to in the rest pose: -1 behind, +1 ahead
   * (a straight rest joint takes the side of the leg's first bent one, else +1). Seeding FABRIK with it keeps a deeply folded leg (a body rising from the
   * ground) from flipping its knee between frames when the forward kinematics start point crosses the axis. Only legs authored with `seedKnees` use it.
   */
  kneeSeed(key) {
    const cached = (this.kneeSeeds ??= {})[key];
    if (cached) return cached;
    const leg = this.legs[key], a = this.restP[leg.chain[0]], axis = this.restP[leg.foot].clone().sub(a).normalize();
    const signs = leg.chain.slice(1, -1).map(j => {
      const d = this.restP[j].clone().sub(a);
      d.addScaledVector(axis, -d.dot(axis));
      const side = d.dot(this.F);
      return Math.abs(side) < 1e-4 ? 0 : Math.sign(side);
    });
    const fallback = signs.find(s => s !== 0) ?? 1;
    return (this.kneeSeeds[key] = signs.map(s => s || fallback));
  }

  /**
   * Solves one pose. ctl fields (all optional, angles [pitchUp, yawLeft, leanLeft] in degrees):
   *   rootUp (world units), root, hip, torso, chest, neck, head, jaw, tail, tailJoints[], where tail
   *   angles are [tailUp, tailLeft, lean] (positive raises / swings the tail tip) instead of nose-based
   *   legs[key] = { fwd, up, left, foot:[..] }   IK ankle target offset from rest + foot rotation
   *   legOverride[key] = { rel0, locals[] }       FK leg driven by sampled (walk) data
   *   rigidLegs (with plant: false)               ankle targets ride the hips' transform instead of staying on the rest ground
   */
  solve(ctl) {
    const n = this.nodes.length;
    const inc = new Map();
    const add = (j, q) => inc.set(j, inc.has(j) ? q.clone().multiply(inc.get(j)) : q);
    const spread = (chain, angles, weights) => {
      if (!angles || !chain.length) return;
      const w = weights ?? chain.map(() => 1), sum = w.reduce((a, b) => a + b, 0);
      chain.forEach((j, i) => add(j, this.body(angles.map(v => v * w[i] / sum))));
    };
    if (ctl.root) add(this.rootJoint, this.body(ctl.root));
    if (ctl.hip) add(this.hips, this.body(ctl.hip));
    spread(this.torso, ctl.torso);
    spread(this.chest, ctl.chest);
    spread(this.neck, ctl.neck);
    spread(this.head, ctl.head);
    if (ctl.jaw) add(this.head.at(-1), this.body(ctl.jaw));
    const tailAngles = a => [-a[0], -a[1], a[2]];
    if (ctl.tailJoints) ctl.tailJoints.forEach((angles, i) => add(this.tail[i], this.body(tailAngles(angles))));
    else spread(this.tail, ctl.tail && tailAngles(ctl.tail));

    const rootT = this.restT[this.rootJoint].clone();
    const rootParentQ = this.parent[this.rootJoint] >= 0 ? this.restWQ[this.parent[this.rootJoint]] : IDENTITY;
    if (ctl.rootUp) rootT.add(new Vector3(0, ctl.rootUp, 0).applyQuaternion(rootParentQ.clone().invert()));
    // bodyUp: world height added to the Root's child joints only (ctl.rootUp moves the Root and everything bound to it, ground-bound skin included).
    const bodyUp = ctl.bodyUp ?? 0;

    const overrides = new Map();
    for (const key of this.legKeys) {
      const spec = ctl.legOverride?.[key];
      if (!spec) continue;
      const leg = this.legs[key];
      overrides.set(leg.chain[0], { rel0: spec.rel0, reference: leg.reference });
      leg.chain.slice(1).forEach((j, i) => overrides.set(j, { local: spec.locals[i] }));
    }

    // Ankle IK targets (rest foot position plus authored offset in the body frame).
    const targets = {};
    for (const key of this.legKeys) {
      if (ctl.legOverride?.[key]) continue;
      const spec = ctl.legs?.[key] ?? {};
      targets[key] = this.restP[this.legs[key].foot].clone()
        .addScaledVector(this.F, spec.fwd ?? 0).addScaledVector(this.U, spec.up ?? 0).addScaledVector(this.L, spec.left ?? 0);
    }

    // One forward pass of the authored increments plus optional pitch compensation about Root/hips.
    const pass = (rootPitch = 0, hipPitch = 0) => {
      const total = new Map(inc);
      const addTo = (j, q) => total.set(j, total.has(j) ? q.clone().multiply(total.get(j)) : q);
      if (rootPitch) addTo(this.rootJoint, this.body([rootPitch, 0, 0]));
      if (hipPitch) addTo(this.hips, this.body([hipPitch, 0, 0]));
      const locals = new Array(n), Q = new Array(n), P = new Array(n);
      for (const i of this.order) {
        const p = this.parent[i];
        const qp = p < 0 ? IDENTITY : Q[p];
        let local;
        const override = overrides.get(i);
        if (override?.local) local = override.local.clone();
        else if (override?.rel0) local = qp.clone().invert().multiply(Q[override.reference]).multiply(override.rel0);
        else if (total.has(i)) {
          const dParent = p < 0 ? IDENTITY : qp.clone().multiply(this.restWQ[p].clone().invert());
          local = qp.clone().invert().multiply(total.get(i)).multiply(dParent).multiply(this.restWQ[i]);
        } else local = this.restQ[i].clone();
        locals[i] = local;
        Q[i] = qp.clone().multiply(local);
        let t = i === this.rootJoint ? rootT : this.restT[i];
        if (bodyUp && p >= 0 && p === this.rootJoint) t = t.clone().add(new Vector3(0, bodyUp, 0).applyQuaternion(qp.clone().invert()));
        P[i] = p < 0 ? t.clone() : P[p].clone().add(t.clone().applyQuaternion(qp));
      }
      return { locals, Q, P };
    };

    let solved = pass();
    let rigidRotation;
    // rigidLegs: true carries the feet fully with the hips; a number in (0, 1) blends the carried targets with the planted ones (a body unrolling).
    const rigidWeight = ctl.rigidLegs === true ? 1 : Math.max(0, Math.min(1, Number(ctl.rigidLegs) || 0));
    if (rigidWeight > 0) {
      // Legs that ride the body (a collapsed animal rolling onto its side): every ankle target is the rest foot position carried by the hips'
      // own transform (rotation and lift), plus the authored world-axis offset, so a rolled body never drags its feet back to the old ground,
      // and the paws turn with the body too. Feet are kept on or above the rest ground.
      const carriedRotation = solved.Q[this.hips].clone().multiply(this.restWQ[this.hips].clone().invert());
      rigidRotation = rigidWeight < 1 ? IDENTITY.clone().slerp(carriedRotation, rigidWeight) : carriedRotation;
      for (const key of this.legKeys) {
        if (ctl.legOverride?.[key]) continue;
        const spec = ctl.legs?.[key] ?? {};
        const carried = solved.P[this.hips].clone().add(this.restP[this.legs[key].foot].clone().sub(this.restP[this.hips]).applyQuaternion(carriedRotation))
          .addScaledVector(this.F, spec.fwd ?? 0).addScaledVector(this.U, spec.up ?? 0).addScaledVector(this.L, spec.left ?? 0);
        carried.y = Math.max(carried.y, this.restP[this.legs[key].foot].y);
        targets[key] = rigidWeight < 1 ? targets[key].clone().lerp(carried, rigidWeight) : carried;
      }
    }
    let rootPitch = 0, hipPitch = 0;
    if (ctl.plant !== false) {
      // Tripo legs are nearly straight at rest (only millimetres of slack), so body rotations that
      // raise a shoulder or hip would lift a planted foot. Without translating the Root, pitch the
      // front body down about the hips (front legs) or tilt the whole body up about the Root (hind
      // legs) by the smallest angle that keeps every planted foot reachable.
      const reach = 0.0025;
      const overshoot = (state, keys) => Math.max(0, ...keys.filter(k => targets[k]).map(k => {
        const leg = this.legs[k];
        return state.P[leg.chain[0]].distanceTo(targets[k]) - (leg.lengths.reduce((a, b) => a + b, 0) - reach);
      }));
      const smallest = (evaluate, limit) => {
        if (evaluate(0) <= 0) return 0;
        if (evaluate(limit) > 0) return limit;
        let lo = 0, hi = limit;
        for (let i = 0; i < 22; i++) { const mid = (lo + hi) / 2; if (evaluate(mid) > 0) lo = mid; else hi = mid; }
        return hi;
      };
      const front = ['FL', 'FR'], hind = ['HL', 'HR'];
      if (overshoot(solved, front) > 0 || overshoot(solved, hind) > 0) {
        for (let round = 0; round < 3; round++) {
          hipPitch = smallest(e => overshoot(pass(rootPitch, -e), front), MAX_HIP_COMPENSATION) * -1;
          rootPitch = smallest(e => overshoot(pass(e, hipPitch), hind), MAX_ROOT_COMPENSATION);
        }
        hipPitch = smallest(e => overshoot(pass(rootPitch, -e), front), MAX_HIP_COMPENSATION) * -1;
        solved = pass(rootPitch, hipPitch);
      }
    }
    const { locals, Q, P } = solved;

    let ikApplied = false;
    for (const key of this.legKeys) {
      const leg = this.legs[key], spec = ctl.legs?.[key] ?? {};
      let target = targets[key], footQ;
      if (target) {
        footQ = (rigidRotation ?? IDENTITY).clone().multiply(spec.foot ? this.body(spec.foot) : IDENTITY.clone()).multiply(this.restWQ[leg.foot]);
        const footMoved = (spec.foot && spec.foot.some(v => v !== 0)) || (rigidRotation && rigidRotation.angleTo(IDENTITY) > 1e-6);
        if (P[leg.foot].distanceTo(target) < 1e-7 && !footMoved) continue;
      } else if (ctl.groundClamp) {
        // FK-driven leg (run): only raise a foot that would otherwise sink below its rest sole height.
        const sink = Math.max(...leg.leaves.map(j => this.restP[j].y - P[j].y));
        if (sink <= 0) continue;
        target = P[leg.foot].clone().addScaledVector(this.U, sink);
        footQ = Q[leg.foot].clone();
      } else continue;
      const pts = leg.chain.map(j => P[j]);
      const seed = spec.warm ?? (spec.seedKnees ? this.kneeSeed(key) : undefined);
      const solvedChain = fabrik(pts[0], pts, leg.lengths, target, this.F, this.options.planarLegs !== false, leg.floorY, seed);
      const newQ = [];
      for (let i = 0; i < leg.chain.length - 1; i++) {
        const from = pts[i + 1].clone().sub(pts[i]).normalize(), to = solvedChain[i + 1].clone().sub(solvedChain[i]).normalize();
        newQ.push(new Quaternion().setFromUnitVectors(from, to).multiply(Q[leg.chain[i]]));
      }
      newQ.push(footQ);
      leg.chain.forEach((j, i) => {
        const parentQ = i === 0 ? Q[this.parent[j]] : newQ[i - 1];
        locals[j] = parentQ.clone().invert().multiply(newQ[i]);
      });
      ikApplied = true;
    }
    const world = ikApplied ? this.forward(locals, rootT, bodyUp) : { P, Q };
    return { locals, rootT, bodyUp, P: world.P, Q: world.Q, compensation: { rootPitch, hipPitch } };
  }
}

/**
 * FABRIK with a fixed root. Bone lengths are preserved exactly. Intermediate joints are kept in the
 * plane that contains the hip -> ankle axis and `bendHint` (the body's forward direction), so knees
 * keep bending fore/aft instead of swinging sideways through the body when a leg folds.
 * `seed` (one -1 / 0 / +1 per interior joint, see QuadrupedRig.kneeSeed) restarts the solve from points spread along the hip -> ankle axis and pushed to that
 * side of it, so the fold direction no longer depends on where the forward kinematics happen to leave the chain.
 */
function fabrik(rootP, pts, lens, target, bendHint, flattenKnees = true, floorY, seed) {
  const last = pts.length - 1, p = pts.map(v => v.clone());
  const axis = target.clone().sub(rootP);
  const reach = axis.length();
  if (reach >= lens.reduce((a, b) => a + b, 0)) {
    const dir = axis.normalize();
    p[0].copy(rootP);
    for (let i = 0; i < last; i++) p[i + 1].copy(p[i]).addScaledVector(dir, lens[i]);
    return p;
  }
  axis.normalize();
  // A seeded leg whose axis runs nearly along the forward direction (a leg stretched back or forward along the ground) has no stable fore/aft bend plane: the hint
  // turns smoothly towards the world up axis as the axis lines up with it, so the knee bends up there instead of swapping sides between frames.
  const parallel = Math.abs(bendHint.dot(axis)), swing = seed ? Math.min(1, Math.max(0, (parallel - 0.8) / 0.15)) : 0;
  const hint = swing > 0 ? bendHint.clone().multiplyScalar(1 - swing).add(new Vector3(0, swing, 0)) : bendHint;
  const normal = new Vector3().crossVectors(axis, hint.clone().addScaledVector(axis, -hint.dot(axis)));
  const planar = flattenKnees && normal.length() > 1e-6 && last > 1;
  if (planar) normal.normalize();
  const flatten = () => { if (planar) for (let i = 1; i < last; i++) p[i].addScaledVector(normal, -p[i].clone().sub(rootP).dot(normal)); };
  if (seed?.[0]?.isVector3) {
    for (let i = 1; i < last; i++) p[i].copy(rootP).add(seed[i - 1]);
  } else if (seed) {
    const total = lens.reduce((a, b) => a + b, 0), perp = hint.clone().addScaledVector(axis, -hint.dot(axis));
    if (perp.lengthSq() > 1e-12) {
      perp.normalize();
      let along = 0;
      for (let i = 1; i < last; i++) {
        along += lens[i - 1];
        p[i].copy(rootP).addScaledVector(axis, reach * along / total).addScaledVector(perp, (seed[i - 1] ?? 0) * 0.3 * lens[i - 1]);
      }
    }
  }
  flatten();
  for (let iter = 0; iter < 120; iter++) {
    p[last].copy(target);
    for (let i = last - 1; i >= 0; i--) { const dir = p[i].clone().sub(p[i + 1]).normalize(); p[i].copy(p[i + 1]).addScaledVector(dir, lens[i]); }
    p[0].copy(rootP);
    flatten();
    for (let i = 0; i < last; i++) {
      const dir = p[i + 1].clone().sub(p[i]).normalize();
      p[i + 1].copy(p[i]).addScaledVector(dir, lens[i]);
      if (floorY !== undefined && i + 1 < last && p[i + 1].y < floorY) {
        // Slide the joint along the horizontal circle of its bone at the floor height (bone length is kept).
        const dy = floorY - p[i].y, horizontal = Math.sqrt(Math.max(0, lens[i] * lens[i] - dy * dy));
        const flat = new Vector3(dir.x, 0, dir.z);
        if (flat.lengthSq() > 1e-12 && Math.abs(dy) < lens[i]) p[i + 1].set(p[i].x + flat.normalize().x * horizontal, floorY, p[i].z + flat.z * horizontal);
      }
    }
    if (p[last].distanceTo(target) < 1e-8) break;
  }
  return p;
}

// ---------------------------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------------------------
const EASE = {
  lin: x => x,
  io: x => x * x * x * (x * (6 * x - 15) + 10),
  in: x => x * x * x,
  out: x => 1 - (1 - x) ** 3,
  in2: x => x * x,
  out2: x => 1 - (1 - x) ** 2,
  snap: x => x ** 4,
};
/** Piecewise eased curve through [time, value, easeIntoThisKey = 'io'] keys. */
function curve(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, v0] = keys[i - 1], [t1, v1, e = 'io'] = keys[i];
      return v0 + (v1 - v0) * EASE[e]((t - t0) / (t1 - t0));
    }
  }
  return keys.at(-1)[1];
}
const sin = (t, cycles, phase = 0) => Math.sin(TAU * (cycles * t + phase));
const window01 = (t, a, b, c, d) => smoothstep((t - a) / (b - a)) * (1 - smoothstep((t - c) / (d - c)));

// ---------------------------------------------------------------------------------------------
// Personalities
// ---------------------------------------------------------------------------------------------
const TOAD_RIG = {
  explicit: {
    hips: 'tripo::Spine_0', torso: ['tripo::Spine_1'], neck: ['tripo::0_Right_Limb_0'], head: ['tripo::Head_0'], tail: [],
    legs: {
      FL: ['bone_37', 'bone_38', 'bone_39', 'bone_40'],
      FR: ['0_Right_Limb_1', '0_Right_Limb_2', '0_Right_Limb_3', '0_Right_Limb_4'].map(n => 'tripo::' + n),
      HL: ['bone_12', 'tripo::0_Left_Limb_0', 'tripo::0_Left_Limb_1', 'tripo::0_Left_Limb_2'],
      HR: ['tripo::1_Left_Limb_0', 'tripo::1_Left_Limb_1', 'tripo::1_Left_Limb_2', 'tripo::1_Left_Limb_3'],
    },
  },
  planarLegs: false, kneeFloor: true,
};
/** Ruun's Tripo rig names the tail bone_22..26 (children of Root) and the neck Spine_3 / Spine_4, so the joints are mapped by name. */
const RUUN_RIG = {
  explicit: {
    hips: 'tripo::Spine_0', torso: ['tripo::Spine_1', 'tripo::Spine_2'], neck: ['tripo::Spine_3', 'tripo::Spine_4', 'tripo::Head_0'], head: ['tripo::Head_1'],
    tail: ['bone_22', 'bone_23', 'bone_24', 'bone_25', 'bone_26'],
    legs: {
      FL: ['bone_4', ...[0, 1, 2, 3].map(k => 'tripo::0_Left_Limb_' + k)],
      FR: [0, 1, 2, 3, 4].map(k => 'tripo::0_Right_Limb_' + k),
      HL: [0, 1, 2, 3].map(k => 'tripo::1_Left_Limb_' + k),
      HR: [0, 1, 2, 3].map(k => 'tripo::1_Right_Limb_' + k),
    },
  },
};
/** The tracker's Tripo rig names the tail's last three joints 1_Left_Limb_0..2 and the hind-left leg bone_23..26, so the joints are mapped by name. */
const TRACKER_RIG = {
  explicit: {
    hips: 'tripo::Spine_0', torso: ['tripo::Spine_1', 'tripo::Spine_2'], neck: ['tripo::Spine_3', 'tripo::Spine_4', 'tripo::Head_0'], head: ['tripo::Head_1', 'tripo::Head_2'],
    tail: ['bone_27', 'bone_28', 'tripo::Tail_0', 'tripo::1_Left_Limb_0', 'tripo::1_Left_Limb_1', 'tripo::1_Left_Limb_2'],
    legs: {
      FL: ['bone_4', ...[0, 1, 2, 3].map(k => 'tripo::0_Left_Limb_' + k)],
      FR: ['bone_9', ...[0, 1, 2, 3].map(k => 'tripo::0_Right_Limb_' + k)],
      HL: ['bone_23', 'bone_24', 'bone_25', 'bone_26'],
      HR: [0, 1, 2, 3].map(k => 'tripo::1_Right_Limb_' + k),
    },
  },
};
/**
 * Asha's Tripo rig names her spine 0_Right_Limb_0..2 (pelvis to chest), the neck / head Head_0..3 (Head_3 is the lower jaw), both front legs hang off the
 * chest (Spine_0 -> bone_21..24 left, 0_Right_Limb_3..7 right) and the tail is bone_30 + 1_Left_Limb_0..3. The hind legs are the left chain
 * 0_Left_Limb_0..2 and the paw / right-leg joints that scripts/assets/repair-quadruped-hind-legs.mjs adds (the rig shipped without a right hind leg).
 */
const ASHA_RIG = {
  explicit: {
    hips: 'tripo::0_Right_Limb_0', torso: ['tripo::0_Right_Limb_1', 'tripo::0_Right_Limb_2'], neck: ['tripo::Head_0', 'tripo::Head_1'], head: ['tripo::Head_2', 'tripo::Head_3'],
    tail: ['bone_30', 'tripo::1_Left_Limb_0', 'tripo::1_Left_Limb_1', 'tripo::1_Left_Limb_2', 'tripo::1_Left_Limb_3'],
    legs: {
      FL: ['tripo::Spine_0', 'bone_21', 'bone_22', 'bone_23', 'bone_24'],
      FR: ['tripo::0_Right_Limb_3', 'tripo::0_Right_Limb_4', 'tripo::0_Right_Limb_5', 'tripo::0_Right_Limb_6', 'tripo::0_Right_Limb_7'],
      HL: ['tripo::0_Left_Limb_0', 'tripo::0_Left_Limb_1', 'tripo::0_Left_Limb_2', 'repair::HL_Paw'],
      HR: ['repair::HR_0', 'repair::HR_1', 'repair::HR_2', 'repair::HR_Paw'],
    },
  },
};
/** Tali faces -z: spine 0_Left_Limb_0, 0_Left_Limb_1, Spine_0; neck / head Head_0, Head_1; tail bone_1, bone_2, Tail_0..2; the left hind leg is the lone 1_Left_Limb_0 plus the joints repaired in. */
const TALI_RIG = {
  explicit: {
    hips: 'tripo::0_Left_Limb_0', torso: ['tripo::0_Left_Limb_1', 'tripo::Spine_0'], neck: ['tripo::Head_0'], head: ['tripo::Head_1'],
    tail: ['bone_1', 'bone_2', 'tripo::Tail_0', 'tripo::Tail_1', 'tripo::Tail_2'],
    legs: {
      FL: ['tripo::0_Left_Limb_2', 'tripo::0_Left_Limb_3', 'tripo::0_Left_Limb_4', 'tripo::0_Left_Limb_5', 'tripo::0_Left_Limb_6'],
      FR: ['bone_17', 'bone_18', 'bone_19', 'bone_20', 'bone_21'],
      HL: ['tripo::1_Left_Limb_0', 'repair::HL_1', 'repair::HL_2', 'repair::HL_3', 'repair::HL_4'],
      HR: ['tripo::0_Right_Limb_0', 'tripo::0_Right_Limb_1', 'tripo::0_Right_Limb_2', 'tripo::0_Right_Limb_3', 'tripo::0_Right_Limb_4'],
    },
  },
};
// Measured native bind hierarchies: Tripo labels Nyra's spine and the Crowned Beast's tail as limbs.
const NYRA_RIG = {
  explicit: {
    hips: 'tripo::0_Right_Limb_0', torso: ['tripo::0_Right_Limb_1', 'tripo::0_Right_Limb_2'],
    neck: ['tripo::Head_0', 'tripo::Head_1', 'tripo::Head_2'], head: ['tripo::Head_3', 'tripo::Head_4'],
    tail: ['bone_31', 'bone_32', 'tripo::Tail_0', 'tripo::Tail_1', 'tripo::Tail_2', 'tripo::Tail_3', 'tripo::Tail_4', 'tripo::0_Left_Limb_0'],
    legs: {
      FL: ['bone_13', 'bone_14', 'bone_15', 'bone_16', 'bone_17'],
      FR: ['tripo::Spine_0', 'tripo::Spine_1', 'bone_20', 'bone_21', 'bone_22'],
      HL: ['bone_23', 'bone_24', 'bone_25', 'bone_26'],
      HR: ['bone_27', 'bone_28', 'bone_29', 'bone_30'],
    },
  },
};
const SOLKAR_RIG = {
  explicit: {
    hips: 'tripo::1_Left_Limb_0', torso: ['tripo::Spine_0', 'tripo::Spine_1'],
    neck: ['tripo::Head_0', 'tripo::Head_1'], head: ['tripo::Head_2', 'tripo::Head_3'],
    tail: ['bone_30', 'bone_31', 'tripo::Tail_0', 'tripo::Tail_1', 'tripo::Tail_2', 'tripo::Tail_3', 'tripo::Tail_4', 'bone_37'],
    legs: {
      FL: ['bone_7', 'tripo::0_Left_Limb_0', 'tripo::0_Left_Limb_1', 'tripo::0_Left_Limb_2', 'tripo::0_Left_Limb_3', 'tripo::0_Left_Limb_4'],
      FR: ['bone_13', 'tripo::0_Right_Limb_0', 'tripo::0_Right_Limb_1', 'tripo::0_Right_Limb_2', 'tripo::0_Right_Limb_3', 'tripo::0_Right_Limb_4'],
      HL: ['tripo::1_Left_Limb_1', 'tripo::1_Left_Limb_2', 'tripo::1_Left_Limb_3', 'tripo::1_Left_Limb_4', 'tripo::1_Left_Limb_5'],
      HR: ['bone_25', 'bone_26', 'bone_27', 'bone_28', 'bone_29'],
    },
  },
};
const CROWNED_RIG = {
  explicit: {
    hips: 'tripo::Spine_0', torso: ['tripo::Spine_1', 'tripo::Spine_2', 'tripo::Spine_3'],
    neck: [], head: ['tripo::Head_0'],
    tail: ['bone_39', 'tripo::Tail_0', 'tripo::Tail_1', 'tripo::1_Left_Limb_0', 'tripo::1_Left_Limb_1'],
    legs: {
      FL: ['tripo::0_Left_Limb_0', 'tripo::0_Left_Limb_1', 'tripo::0_Left_Limb_2', 'tripo::0_Left_Limb_3'],
      FR: ['tripo::Spine_4', 'bone_36', 'bone_37', 'bone_38'],
      HL: ['tripo::0_Right_Limb_0', 'tripo::0_Right_Limb_1', 'tripo::0_Right_Limb_2', 'tripo::0_Right_Limb_3', 'tripo::0_Right_Limb_4'],
      HR: ['tripo::1_Right_Limb_0', 'tripo::1_Right_Limb_1', 'tripo::1_Right_Limb_2', 'tripo::1_Right_Limb_3', 'tripo::1_Right_Limb_4'],
    },
  },
};
const PERSONALITIES = {
  // Authored ikGait walks (authoredWalk): every foot is an IK target, so planting is by construction. `seconds` is the walk cycle, `stride` the
  // stance travel in body heights (about 0.85 of the shortest leg), `dip` / `bob` lower the body so the near-straight Tripo legs reach it.
  // The planting speed (clips report: walk.planting) times the manifest scale is the locomotion walkRef in MonsterAnimationProfiles.
  'actor-ember-boar': { label: 'heavy-stubby', amp: 1.0, tusk: 1.35, headBias: -6, spine: 0.7, tail: 0.8, leap: 0.35, mass: 1.25, hold: 1.0, legSwing: 1.25, jumpTuck: 1.0, strike: 1.0, swing: 1.3, whip: 1.2, dazed: 0.55, dive: 0.5,
    authoredWalk: true, seconds: { 'monster-walk': 0.5 }, ikGait: { walk: { stride: 0.34, lift: 0.12, duty: 0.55, sway: 6, tailYaw: 14, tailUp: 2, dip: 0.05, bob: 0.02 } } },
  'actor-frost-sap-stalker': { label: 'agile-feline', amp: 1.05, tusk: 0.9, headBias: 0, spine: 1.6, tail: 1.7, leap: 0.45, mass: 0.8, hold: 0.9, legSwing: 1.35, jumpTuck: 1.2, strike: 1.15, swing: 1.0, whip: 1.3,
    authoredWalk: true, seconds: { 'monster-walk': 0.5 }, ikGait: { walk: { stride: 0.34, lift: 0.14, duty: 0.55, sway: 8, tailYaw: 22, tailUp: 4, dip: 0.06, bob: 0.02 } } },
  'actor-root-rammer': { label: 'slow-massive', amp: 0.8, tusk: 1.0, headBias: -5, spine: 0.55, tail: 0.6, leap: 0.25, mass: 1.6, hold: 1.5, legSwing: 1.15, jumpTuck: 0.8, strike: 1.5, swing: 2.1, whip: 1.45, dive: 1.5,
    authoredWalk: true, seconds: { 'monster-walk': 0.8 }, ikGait: { walk: { stride: 0.37, lift: 0.1, duty: 0.6, sway: 4, tailYaw: 8, tailUp: 0, dip: 0.05, bob: 0.015 } } },
  // Mistveil Basin (rigs are irregular Tripo output: see QuadrupedRig options)
  // Moonpine Ridge wolves (standard Tripo quadruped rigs; only the walk preset exists)
  'actor-frostfang-tracker': { label: 'agile-wolf-tracker', amp: 1.05, tusk: 1.1, headBias: -1, spine: 1.4, tail: 1.4, leap: 0.42, mass: 0.9, hold: 0.9, legSwing: 1.4, jumpTuck: 1.1, rigOptions: TRACKER_RIG, groundGuard: true, strike: 1.25, swing: 1.2, whip: 1.2, howl: 1.5, yawCap: 0.75,
    authoredWalk: true, seconds: { 'monster-walk': 0.6 }, ikGait: { walk: { stride: 0.48, lift: 0.13, duty: 0.6, sway: 6, tailYaw: 16, tailUp: 5, dip: 0.05, bob: 0.02 } } },
  'actor-howl-scout': { label: 'light-twitchy-scout', amp: 1.25, tusk: 0.9, headBias: 2, spine: 1.8, tail: 1.5, leap: 0.5, mass: 0.6, hold: 0.7, legSwing: 1.45, jumpTuck: 1.3, rigOptions: { freeHeading: true }, groundGuard: true, strike: 1.25, swing: 1.25, whip: 1.2, howl: 1.5, yawCap: 0.75,
    authoredWalk: true, seconds: { 'monster-walk': 0.5 }, ikGait: { walk: { stride: 0.44, lift: 0.14, duty: 0.55, sway: 7, tailYaw: 18, tailUp: 5, dip: 0.07, bob: 0.02 } } },
  'actor-ruun-chained-howl': { label: 'heavy-deliberate-elder', rootFixed: true, crouch: 0.2, amp: 0.8, tusk: 1.2, headBias: -5, spine: 0.5, tail: 0.9, leap: 0.2, mass: 1.7, hold: 1.6, legSwing: 1.1, jumpTuck: 0.7, rigOptions: { ...RUUN_RIG, kneeFloor: true }, groundGuard: true, cleanWeights: { groundLevel: 0.03, groundDistance: 0.12 }, strike: 1.4, swing: 2.0, whip: 1.3, howl: 1.5,
    authoredWalk: true, seconds: { 'monster-walk': 0.7 }, ikGait: { walk: { stride: 0.4, lift: 0.1, duty: 0.6, sway: 4, tailYaw: 10, tailUp: 2, dip: 0.02, bob: 0.01 } } },
  // Mistveil Basin
  // groundSlack: how far (body heights) the knockdown / get-up may sit under the rest ground; the toad's belly and splayed toes dip a few thousandths whatever the lift (0.65% = 0.9 cm at its scale).
  'actor-bog-lurker': { label: 'squat-hopper', groundSlack: 0.0065, amp: 1.3, idleGain: 2.2, crouch: 0.6, tusk: 1.3, headBias: -3, spine: 0.5, tail: 1, leap: 0.5, mass: 1.5, hold: 1.2, legSwing: 1.1, jumpTuck: 1.4, rigOptions: TOAD_RIG, groundGuard: true, authoredWalk: true, seconds: { 'monster-walk': 1.2, 'monster-run': 0.7 }, strike: 1.25, swing: 1.4, dive: 0.75,
    ikGait: { walk: { hop: true, height: 0.1, dip: 0.05, reach: 0.12, tuck: 0.05 }, run: { hop: true, height: 0.28, dip: 0.1, reach: 0.25, tuck: 0.1 } } },
  'actor-ghor-mire-maw': { label: 'low-long-heavy-croc', amp: 0.75, idleGain: 1.8, tusk: 1.5, headBias: -8, spine: 0.6, tail: 1.6, leap: 0.2, mass: 1.9, hold: 1.7, legSwing: 1.0, jumpTuck: 0.45, rigOptions: { freeHeading: true, climbLegs: true, planarLegs: false, kneeFloor: true }, strike: 1.6, swing: 2.0, whip: 1.0, dazed: 0,
    crouch: 0.3, groundGuard: true, authoredWalk: true, seconds: { "monster-run": 0.8 },
    ikGait: {
      walk: { stride: 0.34, lift: 0.1, duty: 0.65, sway: 7, tailYaw: 16, tailUp: 4 },
      run: { stride: 0.5, lift: 0.15, duty: 0.55, sway: 9, tailYaw: 20, tailUp: 8, pitch: -1 },
    } },
  // Blood Bamboo Valley tigers (rigs repaired by scripts/assets/repair-quadruped-hind-legs.mjs; every foot of both gaits is an IK target)
  'actor-asha': { label: 'protective-heavy-tigress', amp: 1.0, tusk: 1.2, headBias: -3, spine: 1.4, tail: 1.3, leap: 0.4, mass: 1.15, hold: 1.1, legSwing: 1.3, jumpTuck: 1.0, rigOptions: ASHA_RIG, groundGuard: true, strike: 1.35, swing: 1.3, whip: 1.25, howl: 1.4, yawCap: 0.9,
    authoredWalk: true, seconds: { 'monster-walk': 0.7, 'monster-run': 0.5 },
    extraClips: ['asha-stalk', 'asha-corrupted-idle', 'asha-stalk-pounce', 'asha-corrupt-slam', 'asha-bamboo-charge', 'asha-cleanse', 'asha-bond-idle'],
    ikGait: { walk: { stride: 0.4, lift: 0.12, duty: 0.6, sway: 6, tailYaw: 14, tailUp: 3, dip: 0.04, bob: 0.015 }, run: { stride: 0.62, lift: 0.2, duty: 0.45, sway: 8, tailYaw: 18, tailUp: 8, dip: 0.06, bob: 0.03 }, stalk: { stride: 0.28, lift: 0.1, duty: 0.7, sway: 5, tailYaw: 8, tailUp: -3, dip: 0.1, bob: 0.01 } } },
  'actor-tali': { label: 'playful-cub', amp: 1.3, tusk: 1.0, headBias: 0, spine: 1.8, tail: 1.7, leap: 0.5, mass: 0.6, hold: 0.7, legSwing: 1.45, jumpTuck: 1.3, rigOptions: TALI_RIG, groundGuard: true, strike: 1.0, swing: 0.9, whip: 1.4, howl: 1.2, yawCap: 0.9, dive: 0.7,
    authoredWalk: true, seconds: { 'monster-walk': 0.45, 'monster-run': 0.4 }, extraClips: ['tali-play', 'tali-nuzzle'],
    ikGait: { walk: { stride: 0.4, lift: 0.15, duty: 0.55, sway: 8, tailYaw: 20, tailUp: 4, dip: 0.05, bob: 0.02 }, run: { stride: 0.65, lift: 0.22, duty: 0.45, sway: 10, tailYaw: 22, tailUp: 10, dip: 0.07, bob: 0.03 } } },
  'actor-luma': { label: 'young-alert-wolf', amp: 1.1, tusk: 1, headBias: 1, spine: 1.3, tail: 1.4, leap: 0.42, mass: 0.8, hold: 0.85, legSwing: 1.35, jumpTuck: 1.1, rigOptions: { freeHeading: true }, groundGuard: true, howl: 1.4, yawCap: 0.8,
    authoredWalk: true, seconds: { 'monster-walk': 0.55, 'monster-run': 0.45 },
    ikGait: { walk: { stride: 0.42, lift: 0.13, duty: 0.6, sway: 5, tailYaw: 15, tailUp: 4, dip: 0.05, bob: 0.02 }, run: { stride: 0.64, lift: 0.2, duty: 0.45, sway: 7, tailYaw: 18, tailUp: 7, dip: 0.06, bob: 0.025 } } },
  'actor-sable': { label: 'watchful-pack-scout', amp: 1, tusk: 1.1, headBias: -1, spine: 1.3, tail: 1.2, leap: 0.4, mass: 0.95, hold: 1, legSwing: 1.35, jumpTuck: 1.1, rigOptions: { freeHeading: true }, groundGuard: true, strike: 1.2, howl: 1.5, yawCap: 0.8,
    authoredWalk: true, seconds: { 'monster-walk': 0.6, 'monster-run': 0.45 },
    ikGait: { walk: { stride: 0.44, lift: 0.12, duty: 0.6, sway: 5, tailYaw: 13, tailUp: 3, dip: 0.05, bob: 0.015 }, run: { stride: 0.66, lift: 0.2, duty: 0.45, sway: 7, tailYaw: 18, tailUp: 7, dip: 0.06, bob: 0.025 } } },
  'actor-nyra': { label: 'low-silent-panther', amp: 0.95, tusk: 1.1, headBias: -3, spine: 1.5, tail: 1.6, leap: 0.45, mass: 0.9, hold: 1, legSwing: 1.3, jumpTuck: 1.2, rigOptions: NYRA_RIG, groundGuard: true, strike: 1.3, whip: 1.3, yawCap: 0.85,
    authoredWalk: true, seconds: { 'monster-walk': 0.75, 'monster-run': 0.5 },
    ikGait: { walk: { stride: 0.36, lift: 0.1, duty: 0.65, sway: 5, tailYaw: 16, tailUp: 1, dip: 0.06, bob: 0.01 }, run: { stride: 0.63, lift: 0.2, duty: 0.45, sway: 8, tailYaw: 20, tailUp: 7, dip: 0.06, bob: 0.025 } } },
  'actor-solkar': { label: 'heavy-regal-lion', amp: 0.85, tusk: 1.25, headBias: -2, spine: 0.9, tail: 1, leap: 0.32, mass: 1.4, hold: 1.3, legSwing: 1.2, jumpTuck: 0.85, rigOptions: SOLKAR_RIG, groundGuard: true, strike: 1.4, swing: 1.6, howl: 1.6, yawCap: 0.75,
    // The mane hangs low over the ground, so the guard's fixed rest-height floor read the walk / run dip as a floor violation and craned the
    // neck up to answer it: the muzzle pointed at the sky for the whole walk and run (74 and 88 degrees against the idle's 39). With a
    // body-relative floor the guard measures the head against the body's own travel, so the dip is no longer a violation and the neck
    // keeps the idle's carriage while a real nose dive is still caught.
    bodyRelativeFloor: true,
    authoredWalk: true, seconds: { 'monster-walk': 0.8, 'monster-run': 0.55 },
    ikGait: { walk: { stride: 0.35, lift: 0.1, duty: 0.65, sway: 4, tailYaw: 10, tailUp: 2, dip: 0.04, bob: 0.01 }, run: { stride: 0.58, lift: 0.18, duty: 0.5, sway: 6, tailYaw: 15, tailUp: 6, dip: 0.05, bob: 0.02 } } },
  'actor-orun-crowned-beast': { label: 'colossal-root-lion', amp: 0.7, tusk: 1.4, headBias: -4, spine: 0.6, tail: 0.8, leap: 0.22, mass: 1.8, hold: 1.6, legSwing: 1.1, jumpTuck: 0.65, rigOptions: CROWNED_RIG, groundGuard: true, strike: 1.6, swing: 1.8, whip: 1.2, howl: 1.6, yawCap: 0.7,
    authoredWalk: true, seconds: { 'monster-walk': 1, 'monster-run': 0.7 },
    ikGait: { walk: { stride: 0.28, lift: 0.09, duty: 0.7, sway: 3, tailYaw: 8, tailUp: 1, dip: 0.03, bob: 0.01 }, run: { stride: 0.48, lift: 0.15, duty: 0.55, sway: 5, tailYaw: 12, tailUp: 4, dip: 0.04, bob: 0.02 } } },
  'actor-council-envoy': { label: 'alert-savanna-antelope', amp: 1.05, tusk: 0.8, headBias: 2, spine: 1, tail: 0.7, leap: 0.48, mass: 0.7, hold: 0.8, legSwing: 1.4, jumpTuck: 1.15, rigOptions: { freeHeading: true }, groundGuard: true, strike: 0.9, swing: 0.9, yawCap: 0.8,
    authoredWalk: true, seconds: { 'monster-walk': 0.6, 'monster-run': 0.45 },
    ikGait: { walk: { stride: 0.5, lift: 0.14, duty: 0.6, sway: 4, tailYaw: 8, tailUp: 3, dip: 0.05, bob: 0.015 }, run: { stride: 0.72, lift: 0.22, duty: 0.45, sway: 6, tailYaw: 12, tailUp: 7, dip: 0.06, bob: 0.025 } } },
};

/** Retains the measured per-species repairs and explicit limb chains in all native attack authors. */
export function quadrupedRigContext(assetId, json) {
  const personality = PERSONALITIES[assetId];
  if (!personality) throw new Error(`No quadruped anatomical frame for ${assetId}`);
  return new QuadrupedRig(json, personality.rigOptions);
}
const NEUTRAL = { label: 'neutral', amp: 1, tusk: 1, headBias: 0, spine: 1, tail: 1, leap: 0.35, mass: 1, hold: 1, legSwing: 1.35, jumpTuck: 1 };

/** Slows time inside [a, a + e] (slow-motion hold) and compresses the rest so the clip still ends at 1. */
function holdWarp(u, a, hold) {
  const e = Math.max(0, hold - 1) * 0.12;
  if (e === 0 || u <= a) return u;
  const slow = 0.2;
  if (u <= a + e) return a + slow * (u - a);
  return a + slow * e + (u - a - e) * (1 - a - slow * e) / (1 - a - e);
}

// ---------------------------------------------------------------------------------------------
// Clips. Each returns { ctl(t, x) } with t the authored (warped) normalized time.
// x = { rig, amp, tusk, spine, tail, mass, ..., H (body height), walk }
// ---------------------------------------------------------------------------------------------
function tailWhip(x, t, keysTotal, lag, pitchKeys) {
  const n = x.rig.tail.length;
  const pitchScale = x.tailPitch / x.tail;
  return Array.from({ length: n }, (_, i) => [
    pitchKeys ? curve(pitchKeys, t - lag * i) / n * pitchScale : 0,
    curve(keysTotal, t - lag * i) / n,
    0,
  ]);
}
/**
 * Hopping gait (toads): one hop per loop. The body dips, launches, rises by `height` body heights with the feet tucked under it
 * (IK targets follow the body up), lands and dips again; feet are planted at their rest spots whenever the body is down.
 * personality.ikGait[mode] = { hop: true, height, dip, reach, tuck } (all in body heights).
 */
function hopCtl(t, x, mode) {
  const g = x.ikGait[mode], H = x.H, n = x.rig.tail.length;
  const c = keys => curve(keys, t);
  const rootUp = H * c([[0, 0], [0.2, -g.dip], [0.3, 0, 'in'], [0.52, g.height, 'out2'], [0.74, 0, 'in2'], [0.84, -g.dip * 0.8, 'out'], [1, 0, 'io']]);
  const lift = Math.max(rootUp, 0);
  const air = c([[0, 0], [0.3, 0, 'lin'], [0.4, 1, 'out'], [0.66, 1, 'lin'], [0.74, 0, 'in'], [1, 0]]);
  const hind = {
    fwd: H * g.reach * c([[0, 0], [0.3, 0, 'lin'], [0.42, -1, 'out'], [0.6, -0.5], [0.7, 0.5], [0.74, 0, 'in'], [1, 0]]),
    up: lift + H * g.tuck * air,
  };
  const front = {
    fwd: H * g.reach * 0.6 * c([[0, 0], [0.3, 0, 'lin'], [0.4, 1, 'out'], [0.62, 1], [0.7, 0.2], [0.74, 0, 'in'], [1, 0]]),
    up: lift + H * g.tuck * 0.8 * air,
  };
  return {
    rootUp,
    root: [c([[0, 0], [0.2, 6], [0.32, -10, 'in'], [0.52, -4], [0.74, 6], [0.84, 9, 'out'], [1, 0]]), 0, 0],
    hip: [c([[0, 0], [0.2, -4], [0.32, 5, 'in'], [0.74, -3], [1, 0]]), 0, 0],
    torso: [c([[0, 0], [0.2, -5], [0.32, 6, 'in'], [0.52, 3], [0.74, -4], [1, 0]]), 0, 0],
    neck: [c([[0, 0], [0.2, -6], [0.34, 12, 'in'], [0.52, 6], [0.76, -8], [1, 0]]), 0, 0],
    head: [c([[0, 0], [0.2, -4], [0.34, 8, 'in'], [0.76, -6], [1, 0]]), 0, 0],
    legs: { FL: front, FR: front, HL: hind, HR: hind },
    tailJoints: Array.from({ length: n }, () => [0, 0, 0]),
  };
}

/**
 * Stepping gait for rigs whose Tripo walk preset does not suit them (sprawled / short legs, long bodies): every foot is an IK
 * target that stays on its rest height during stance and follows a lifted arc during swing, so feet can neither sink nor slide
 * by construction. Diagonal pairs (FL+HR, FR+HL) move together; the spine, neck and tail counter-swing laterally.
 * personality.ikGait[mode] = { stride, lift (both in body heights), duty (stance fraction), sway (degrees), tailYaw, tailUp }.
 * Optional `dip` / `bob` (body heights) lower the whole body by `dip` and add up to `bob` more at the stance transitions, so near-straight
 * Tripo legs can reach their stride extremes (the body is highest when the stance legs are vertical, like an inverted pendulum).
 */
function ikGaitCtl(t, x, mode) {
  if (x.ikGait[mode].hop) return hopCtl(t, x, mode);
  const g = x.ikGait[mode], H = x.H, n = x.rig.tail.length;
  const step = offset => {
    const s = (((t - offset) % 1) + 1) % 1;
    if (s < g.duty) return { fwd: g.stride * H * (0.5 - s / g.duty), up: 0 };
    const k = (s - g.duty) / (1 - g.duty);
    return { fwd: g.stride * H * (-0.5 + EASE.io(k)), up: g.lift * H * Math.sin(Math.PI * k) };
  };
  const tail = Array.from({ length: n }, (_, i) => [
    g.tailUp / n,
    g.tailYaw * x.tail * sin(t, 1, -0.12 * (i + 1)) * (0.5 + i / n) / n * 2,
    0,
  ]);
  const bounce = g.dip === undefined ? {} : { rootUp: -H * (g.dip + (g.bob ?? 0) * (0.5 - 0.5 * Math.cos(TAU * 2 * (t - g.duty / 2)))) };
  return {
    ...bounce,
    root: [g.pitch ?? 0, 0.5 * g.sway * sin(t, 1, 0.5), 1.2 * sin(t, 2, 0.1)],
    hip: [0, -g.sway * sin(t, 1, 0.5), 0],
    torso: [0.8 * sin(t, 2, 0.2), g.sway * x.yawSpine * sin(t, 1, 0), 0],
    neck: [1.6 * sin(t, 2, 0.1), -0.8 * g.sway * sin(t, 1, 0.1), 0],
    head: [1.2 * sin(t, 2, 0.2), -0.6 * g.sway * sin(t, 1, 0.1), 0],
    legs: { FL: step(0), HR: step(0), FR: step(0.5), HL: step(0.5) },
    tailJoints: tail,
  };
}

const CLIPS = {
  'monster-idle': {
    seconds: 3.0, loop: true,
    ctl(t, x) {
      // idleGain (default 1) amplifies the breathing and weight shift of bodies whose idle read as a still frame on the review sheet (toad, croc).
      const A = x.amp, breath = sin(t, 2), n = x.rig.tail.length, G = x.idleGain ?? 1;
      const tailYaw = Array.from({ length: n }, (_, i) => [
        2.2 * sin(t, 2, -0.1 * i) * x.tail / n * 2,
        (7 * sin(t, 1, -0.09 * i) + 2.5 * sin(t, 2, 0.2 - 0.09 * i)) * x.tail * A * (0.5 + i / n) / n * 2,
        0,
      ]);
      return {
        root: [0, 1.2 * sin(t, 1, 0.5) * A, 1.6 * sin(t, 1, 0.25) * x.mass * G],
        hip: [-0.8 * breath * G, -1 * sin(t, 1, 0.3) * G, 1.6 * sin(t, 1, 0.25) * x.mass * G],
        torso: [1.6 * breath * A * G, 1.5 * sin(t, 1, 0.1) * A * G, 0],
        chest: [3.2 * breath * A * G, 0, 0],
        neck: [2.8 * sin(t, 2, -0.1) + 3 * sin(t, 1, 0.2), 9 * sin(t, 1, 0.1) + 3 * sin(t, 2, 0.35), 2 * sin(t, 1, 0.1)],
        head: [4 * sin(t, 1, 0.55) + 1.6 * sin(t, 3, 0.1), 14 * sin(t, 1, -0.02) + 4 * sin(t, 2, 0.3), 3 * sin(t, 1, 0.05)],
        tailJoints: tailYaw,
      };
    },
  },

  'monster-run': {
    seconds: 0.6, loop: true,
    ctl(t, x) {
      if (x.ikGait?.run) return ikGaitCtl(t, x, 'run');
      const A = x.amp, S = x.spine, n = x.rig.tail.length;
      const bounce = 0.5 - 0.5 * Math.cos(TAU * (2 * t + 0.15)); // two bounces per cycle, never below rest
      const tailYaw = Array.from({ length: n }, (_, i) => [
        (11 + 5 * sin(t, 2, -0.08 * i)) / n * x.tail,
        8 * sin(t, 1, -0.1 * i) / n * x.tail * 2,
        0,
      ]);
      return {
        rootUp: x.H * 0.07 * A * bounce,
        root: [-2 + 2.5 * sin(t, 2, 0.35), 1.5 * sin(t, 1, 0.05), 1.5 * sin(t, 1, 0.3)],
        hip: [-6 * S * sin(t, 1, 0.05), 2 * sin(t, 1, 0.5), 0],
        torso: [8 * S * sin(t, 1, 0.3), 3 * x.yawSpine * sin(t, 1, 0.5), 1.5 * sin(t, 1, 0.3)],
        chest: [3 * sin(t, 1, 0.3), 0, 0],
        neck: [-4 + 5.5 * sin(t, 2, 0.1), -3 * sin(t, 1, 0.55), 0],
        head: [2 + 4 * sin(t, 2, 0.02), -4 * sin(t, 1, 0.6), 0],
        tailJoints: tailYaw,
        walkPhase: t,
        groundClamp: true,
      };
    },
  },

  // Only authored for personalities that opt in (personality.authoredWalk); everything else keeps the Tripo walk preset.
  'monster-walk': {
    seconds: 1.6, loop: true,
    ctl(t, x) { return ikGaitCtl(t, x, 'walk'); },
  },

  'monster-slash': {
    seconds: 1.2, loop: false, holdAt: 0.5,
    keyTimes: { windupEnd: 0.35, strike: 0.45, followThroughEnd: 0.7 },
    ctl(t, x) {
      // Head-swipe / bite: coil away (weight back, head cocked, jaws open), snap across with overshoot, rebound once and settle.
      const A = x.amp, T = x.tusk, M = x.mass, S = x.spine, W = x.tail, Y = Math.min(x.yawSpine * x.swing, x.yawCap ?? 1.0), G = x.strike, B = Math.sqrt(G);
      const c = keys => curve(keys, t);
      const tail = tailWhip(x, t, [[0, 0], [0.33, 20 * W], [0.52, -36 * W], [0.72, -10 * W], [0.92, 3 * W], [1, 0]], 0.03,
        [[0, 0], [0.45, 0], [0.52, 14 * W, 'out'], [0.85, 0, 'io']]);
      return {
        root: [
          c([[0, 0], [0.33, 7 * M], [0.46, -4 * M, 'in'], [0.58, -1.5, 'out'], [0.72, 1.2], [0.86, -0.3], [1, 0]]),
          c([[0, 0], [0.33, -3.5 * A * B], [0.46, 4 * A * B, 'in'], [0.62, 1.5, 'out'], [1, 0]]),
          c([[0, 0], [0.33, -3.5 * A * B], [0.46, 3.5 * A * B, 'in'], [0.7, 0.8, 'out'], [1, 0]]),
        ],
        hip: [
          c([[0, 0], [0.33, -4 * M], [0.46, 3.5 * M, 'in'], [1, 0]]),
          c([[0, 0], [0.33, -3.5 * B], [0.46, 5 * B, 'in'], [0.7, 1.5], [1, 0]]),
          0,
        ],
        torso: [
          c([[0, 0], [0.33, 4 * S], [0.46, -7 * S * M, 'in'], [0.65, -2, 'out'], [1, 0]]),
          c([[0, 0], [0.33, -5 * Y * A], [0.47, 7 * Y * A, 'in'], [0.62, 3.5 * Y * A, 'out'], [0.85, 0.8], [1, 0]]),
          c([[0, 0], [0.33, -5 * S], [0.47, 6 * S, 'in'], [1, 0]]),
        ],
        neck: [
          c([[0, 0], [0.33, 7 * A], [0.455, -9 * A, 'in'], [0.6, -3, 'out'], [1, 0]]),
          c([[0, 0], [0.12, -3, 'out'], [0.33, -12 * A * G], [0.36, -13 * A * G, 'lin'], [0.455, 16 * A * T * G, 'in'], [0.5, 20 * A * T * G, 'out'], [0.62, 10 * A * T * G], [0.7, 13 * A * T * G, 'io'], [0.84, 2], [1, 0]]),
          c([[0, 0], [0.33, -8 * A], [0.455, 10 * A, 'in'], [0.62, 4], [1, 0]]),
        ],
        head: [
          c([[0, 0], [0.33, 12 * A], [0.47, -14 * A * T, 'in'], [0.6, -5, 'out'], [1, 0]]),
          c([[0, 0], [0.12, -4], [0.34, -28 * A * G], [0.37, -29 * A * G, 'lin'], [0.47, 34 * A * T * G, 'in'], [0.53, 44 * A * T * G, 'out'], [0.64, 20 * A * T * G], [0.72, 26 * A * T * G, 'io'], [0.86, 3], [1, 0]]),
          c([[0, 0], [0.34, -14 * A], [0.48, 16 * A * T, 'in'], [0.66, 4], [1, 0]]),
        ],
        jaw: [c([[0, 0], [0.3, 0], [0.37, 22 * A, 'out'], [0.45, 24 * A, 'lin'], [0.49, 0, 'in'], [0.7, 0]]), 0, 0],
        tailJoints: tail,
      };
    },
  },

  'monster-shoot': {
    seconds: 1.4, loop: false, holdAt: 0.55,
    keyTimes: { rearEnd: 0.4, expel: 0.5, holdEnd: 0.65 },
    ctl(t, x) {
      // Rear up and inhale (chest, neck and head rise), then thrust the head forward and down as the jaws open, recoil and hold.
      const A = x.amp, M = x.mass, S = x.spine, W = x.tail, G = x.strike, B = Math.sqrt(G);
      const c = keys => curve(keys, t);
      const tremor = window01(t, 0.5, 0.54, 0.62, 0.68);
      const tail = tailWhip(x, t, [[0, 0], [0.4, 8 * W], [0.52, -12 * W, 'in'], [0.7, 4 * W], [1, 0]], 0.025,
        [[0, 0], [0.4, 22 * W], [0.53, -6 * W, 'in'], [0.75, 4 * W], [1, 0]]);
      return {
        root: [
          c([[0, 0], [0.1, -1.5, 'out'], [0.4, 7 * M * A * B], [0.47, 7.5 * M * A * B, 'lin'], [0.52, -5 * M, 'in'], [0.58, -2.5, 'out'], [0.67, -1.5, 'lin'], [0.8, 0.6], [1, 0]]),
          1.2 * tremor * sin(t, 12),
          0,
        ],
        hip: [c([[0, 0], [0.4, -5 * M], [0.52, 5, 'in'], [0.67, 2], [1, 0]]), 0, 0],
        torso: [c([[0, 0], [0.4, 12 * S * A * B], [0.47, 13 * S * A * B, 'lin'], [0.52, -8 * S, 'in'], [0.67, -3 * S], [1, 0]]), 0, 0],
        chest: [c([[0, 0], [0.4, 11 * A], [0.52, -4, 'in'], [1, 0]]), 0, 0],
        neck: [
          c([[0, 0], [0.12, -5, 'out'], [0.4, 26 * A * G], [0.46, 28 * A * G, 'lin'], [0.53, -18 * A * G, 'in'], [0.6, -10, 'out'], [0.67, -10, 'lin'], [1, 0]]),
          3 * tremor * sin(t, 13, 0.2),
          0,
        ],
        head: [c([[0, 0], [0.4, 13 * A * G], [0.46, 16 * A * G, 'lin'], [0.54, -9 * A * G, 'in'], [0.6, 0, 'out'], [0.67, 0, 'lin'], [1, 0]]), 3 * tremor * sin(t, 13, 0.5), 0],
        jaw: [c([[0, 0], [0.4, 0], [0.5, 30 * A, 'out'], [0.67, 30 * A, 'lin'], [0.82, 0]]), 0, 0],
        tailJoints: tail,
      };
    },
  },

  'monster-jump': {
    seconds: 1.6, loop: false,
    keyTimes: { crouchEnd: 0.28, takeoff: 0.3, peak: 0.5, touchdown: 0.7, compressionBottom: 0.78 },
    ctl(t, x) {
      const A = x.amp, M = x.mass, S = x.spine, W = x.tail, H = x.H, tuck = x.jumpTuck;
      const c = keys => curve(keys, t);
      const K = x.crouch ?? 1; // low-slung bodies (belly near the ground) cannot crouch as deep
      const rootUp = H * c([[0, 0], [0.26, -0.11 * M * K], [0.3, 0, 'in'], [0.5, x.leap, 'out2'], [0.7, 0, 'in2'], [0.78, -0.09 * M * K, 'out'], [0.84, -0.085 * K, 'lin'], [0.95, 0.012], [1, 0]]);
      const lift = Math.max(rootUp, 0);
      const hind = {
        fwd: H * c([[0, 0], [0.3, 0, 'lin'], [0.42, -0.1, 'out'], [0.56, -0.06], [0.62, 0.05], [0.7, 0, 'in'], [1, 0]]),
        up: lift + H * tuck * c([[0, 0], [0.3, 0, 'lin'], [0.44, 0.16, 'out'], [0.6, 0.16, 'lin'], [0.7, 0, 'in'], [1, 0]]),
      };
      const front = {
        fwd: H * c([[0, 0], [0.3, 0, 'lin'], [0.4, 0.02, 'out'], [0.56, 0.02], [0.64, 0.13, 'io'], [0.7, 0, 'in'], [1, 0]]),
        up: lift + H * tuck * c([[0, 0], [0.3, 0, 'lin'], [0.42, 0.14, 'out'], [0.54, 0.14, 'lin'], [0.62, -0.08, 'io'], [0.7, 0, 'in'], [1, 0]]),
      };
      const tail = tailWhip(x, t, [[0, 0], [0.26, 6 * W], [0.4, -16 * W], [0.62, 12 * W], [0.78, -10 * W], [1, 0]], 0.03,
        [[0, 0], [0.26, -14 * W], [0.4, 26 * W], [0.62, 6 * W], [0.78, -22 * W], [0.9, 6 * W], [1, 0]]);
      return {
        rootUp,
        root: [c([[0, 0], [0.26, -4 * M], [0.31, 8 * A, 'in'], [0.5, 3 * A], [0.7, -6 * A], [0.78, -2 * M, 'out'], [0.95, 1], [1, 0]]), 0, 0],
        hip: [c([[0, 0], [0.26, 6 * M], [0.31, -6 * A, 'in'], [0.5, -3], [0.7, 4], [0.78, 6 * M, 'out'], [1, 0]]), 0, 0],
        torso: [c([[0, 0], [0.26, -10 * S * M], [0.31, 10 * S * A, 'in'], [0.5, 6 * S], [0.68, -5 * S], [0.78, -12 * S * M, 'out'], [0.95, 2], [1, 0]]), 0, 0],
        chest: [c([[0, 0], [0.26, -6], [0.32, 8, 'in'], [0.78, -8, 'io'], [1, 0]]), 0, 0],
        neck: [c([[0, 0], [0.2, -8 * A], [0.26, -10 * A, 'lin'], [0.34, 18 * A, 'in'], [0.5, 10 * A], [0.66, -10 * A], [0.78, -12 * A, 'out'], [0.95, 2], [1, 0]]), 0, 0],
        head: [c([[0, 0], [0.26, -5], [0.36, 14 * A, 'in'], [0.52, 8], [0.68, -8 * A], [0.8, -8 * A, 'out'], [0.96, 2], [1, 0]]), 0, 0],
        legs: { FL: front, FR: front, HL: hind, HR: hind },
        tailJoints: tail,
      };
    },
  },

  'monster-dive': {
    seconds: 1.0, loop: false, holdAt: 0.45,
    keyTimes: { crouchEnd: 0.22, strike: 0.4, recoverStart: 0.55 },
    ctl(t, x) {
      // Lunge / bite: sink onto the haunches with the neck coiled back (anticipation), drive the chest and head forward and down with the jaws
      // snapping shut at the strike, front paws reaching, then overshoot, rebound and settle.
      // D scales how far the head and chest drop at the strike: low-snouted bodies (boar) would otherwise push the muzzle into the ground.
      const A = x.amp, M = x.mass, S = x.spine, W = x.tail, H = x.H, lunge = Math.min(Math.sqrt(S / 0.7) * Math.sqrt(x.strike), 1.0), G = x.strike, D = x.dive ?? 1;
      const c = keys => curve(keys, t);
      const stepFwd = c([[0, 0], [0.2, 0], [0.42, 0.24 * Math.min(A, 1), 'io'], [0.55, 0.24 * Math.min(A, 1), 'lin'], [0.8, 0, 'io'], [1, 0]]);
      const stepLift = c([[0, 0], [0.24, 0], [0.33, 0.16, 'out'], [0.43, 0, 'in'], [0.6, 0, 'lin'], [0.68, 0.08, 'out'], [0.8, 0, 'in'], [1, 0]]);
      const tail = tailWhip(x, t, [[0, 0], [0.22, 10 * W], [0.42, -8 * W], [0.7, 4 * W], [1, 0]], 0.03,
        [[0, 0], [0.22, -6 * W], [0.4, 16 * W, 'in'], [0.6, 6 * W], [1, 0]]);
      return {
        root: [c([[0, 0], [0.22, 5 * M], [0.28, 5 * M, 'lin'], [0.4, -15 * A * lunge * D, 'in'], [0.46, -18 * A * lunge * D, 'out'], [0.55, -12 * D], [0.7, -4], [0.82, 2], [1, 0]]), 0, 0],
        hip: [c([[0, 0], [0.22, -6 * M], [0.4, 8, 'in'], [0.6, 3], [1, 0]]), 0, 0],
        torso: [c([[0, 0], [0.22, -14 * Math.min(S, 1.2)], [0.28, -14 * Math.min(S, 1.2), 'lin'], [0.4, 14 * Math.min(S, 1.2) * A * lunge, 'in'], [0.55, 5 * Math.min(S, 1.2)], [1, 0]]), 0, 0],
        chest: [c([[0, 0], [0.22, -8], [0.4, 10, 'in'], [1, 0]]), 0, 0],
        neck: [c([[0, 0], [0.22, 24 * A], [0.28, 24 * A, 'lin'], [0.4, -46 * A * G * D, 'in'], [0.5, -38 * A * G * D, 'out'], [0.8, -4], [1, 0]]), 0, 0],
        head: [c([[0, 0], [0.22, 16 * A], [0.28, 16 * A, 'lin'], [0.4, -32 * A * G * D, 'in'], [0.52, -18 * D, 'out'], [0.85, 0], [1, 0]]), 0, 0],
        jaw: [c([[0, 0], [0.22, 0], [0.34, 28 * A, 'out'], [0.4, 30 * A, 'lin'], [0.44, 0, 'in'], [0.62, 0]]), 0, 0],
        legs: {
          FL: { fwd: stepFwd * H, up: stepLift * H },
          FR: { fwd: stepFwd * H * 0.9, up: stepLift * H },
        },
        tailJoints: tail,
      };
    },
  },

  'monster-hurt': {
    seconds: 0.7, loop: false,
    // Flinch peaks at 0.2; the recoil then settles into a dazed, lowered pose that is held 0.44-0.62 (breathing) before recovering. Finite
    // consumers hold the pose by sampling `hold` instead of looping the clip (downed, weak point exposed).
    keyTimes: { flinch: 0.2, hold: 0.52 },
    ctl(t, x) {
      const A = x.amp, M = x.mass, S = x.spine, W = x.tail, Y = x.yawSpine;
      const c = keys => curve(keys, t);
      const held = c([[0, 0], [0.2, 0, 'lin'], [0.44, 1, 'io'], [0.62, 1, 'lin'], [1, 0, 'io']]);
      // The flinch's rebound terms fade out as the dazed pose fades in, so 0.46-0.58 is a calm, sustained pose.
      const fl = keys => (1 - held) * curve(keys, t);
      const dazed = (x.dazed ?? 1) * held;
      const breath = Math.sin(TAU * 1.4 * (t - 0.44)) * held;
      const tail = tailWhip(x, t, [[0, 0], [0.2, 24 * W, 'out'], [0.34, -14 * W], [0.52, 6 * W], [1, 0]], 0.03,
        [[0, 0], [0.2, 16 * W, 'out'], [0.34, -4 * W], [0.46, -14 * W, 'io'], [0.62, -14 * W, 'lin'], [1, 0, 'io']]).map(([p, y, r]) => [p, y * (1 - held), r]);
      return {
        root: [
          fl([[0, 0], [0.2, 6 * A, 'out'], [0.36, -2], [0.55, 1], [1, 0]]) - 2.5 * M * dazed,
          fl([[0, 0], [0.2, -3 * A, 'out'], [0.38, 1], [0.6, -0.5], [1, 0]]),
          fl([[0, 0], [0.2, -3 * A, 'out'], [0.38, 1], [0.6, -0.5], [1, 0]]) + 2.5 * dazed,
        ],
        hip: [fl([[0, 0], [0.2, 4 * M, 'out'], [0.4, -1], [1, 0]]), fl([[0, 0], [0.2, 2, 'out'], [0.4, -1], [1, 0]]), 0],
        torso: [
          fl([[0, 0], [0.2, -12 * S * M, 'out'], [0.36, 3 * S], [0.55, -1], [1, 0]]) - 5 * S * dazed + 0.8 * Math.sqrt(x.dazed ?? 1) * breath,
          fl([[0, 0], [0.2, -3 * Y, 'out'], [0.4, 1], [1, 0]]),
          fl([[0, 0], [0.2, -4 * S, 'out'], [0.4, 1.5], [1, 0]]) + 3 * held,
        ],
        chest: [-3 * dazed + 0.9 * breath, 0, 0],
        neck: [
          fl([[0, 0], [0.2, 22 * A, 'out'], [0.34, -5], [0.5, 3], [1, 0]]) - 13 * A * dazed + 1.2 * breath,
          fl([[0, 0], [0.2, -14 * A, 'out'], [0.36, 5], [0.52, -2], [1, 0]]) + 6 * held,
          fl([[0, 0], [0.2, -6 * A, 'out'], [0.38, 3], [1, 0]]),
        ],
        head: [
          fl([[0, 0], [0.23, 12 * A, 'out'], [0.38, -5], [0.55, 2], [1, 0]]) - 14 * A * dazed + 1.5 * breath,
          fl([[0, 0], [0.24, -24 * A, 'out'], [0.4, 10], [0.56, -4], [1, 0]]) + 12 * held,
          0,
        ],
        tailJoints: tail,
      };
    },
  },

  'monster-turn': {
    seconds: 1.0, loop: true,
    ctl(t, x) {
      const A = x.amp, H = x.H, n = x.rig.tail.length;
      const phase = t0 => (((t - t0) % 1) + 1) % 1;
      const step = (t0, sign) => {
        const s = phase(t0);
        const swing = s < 0.45;
        const k = swing ? s / 0.45 : (s - 0.45) / 0.55;
        const lateral = swing ? -1 + 2 * EASE.io(k) : 1 - 2 * k;
        return { left: sign * 0.035 * H * lateral, up: swing ? 0.1 * H * Math.sin(Math.PI * k) : 0, fwd: swing ? 0.015 * H * Math.sin(Math.PI * k) : 0 };
      };
      const tailYaw = Array.from({ length: n }, (_, i) => [0, 7 * x.tail * sin(t, 1, -0.2 - 0.07 * i) / n * 2, 0]);
      return {
        root: [0, 5 * A * sin(t, 1), 1.2 * sin(t, 2, 0.1)],
        hip: [0, -2 * A * sin(t, 1, -0.05), 0],
        torso: [1 * sin(t, 2, 0.2), 3 * A * x.yawSpine * sin(t, 1, 0.1), 0],
        neck: [0, 8 * A * sin(t, 1, 0.14), 0],
        head: [0, 8 * A * sin(t, 1, 0.2), 1 * sin(t, 1, 0.1)],
        legs: { FL: step(0, 1), HR: step(0, -1), FR: step(0.5, 1), HL: step(0.5, -1) },
        tailJoints: tailYaw,
      };
    },
  },

  'monster-roar': {
    seconds: 2.0, loop: false,
    keyTimes: { stamp: 0.2, shakeStart: 0.25, shakeEnd: 0.8 },
    stampLeg: 'FL',
    ctl(t, x) {
      // R keeps heavy bodies from a token roar: the head always rears at least the neutral amount; `howl` throws the head further back for howlers.
      const A = x.amp, R = Math.max(A, 1) * (x.howl ?? 1), M = x.mass, S = x.spine, W = x.tail, H = x.H, n = x.rig.tail.length;
      const c = keys => curve(keys, t);
      const shake = window01(t, 0.22, 0.3, 0.76, 0.86);
      const raise = c([[0, 0], [0.2, 1, 'out'], [0.8, 1, 'lin'], [1, 0, 'io']]);
      const jolt = c([[0.19, 0], [0.205, 1, 'out'], [0.3, 0, 'io']]);
      const tailYaw = Array.from({ length: n }, (_, i) => [
        (10 * raise + 6 * shake * sin(t, 12, -0.08 * i)) * W / n,
        (18 * shake * sin(t, 6, -0.1 * i) + 6 * sin(t, 1, -0.1 * i) * raise) * W / n * 1.5,
        0,
      ]);
      return {
        root: [8 * A * raise * M ** 0.5 - 3 * jolt, 1 * shake * sin(t, 6, 0.1), 1 * shake * sin(t, 12, 0.3)],
        hip: [-5 * raise * M ** 0.5, 0, 0],
        torso: [10 * S * A * raise + 1.5 * shake * sin(t, 12, 0.2) - 2 * jolt, 1.5 * shake * sin(t, 6, 0.4), 0],
        chest: [8 * A * raise + 2 * shake * sin(t, 12, 0.5), 0, 0],
        neck: [22 * R * raise + 4.5 * shake * sin(t, 12, 0.35), 6 * shake * sin(t, 6, 0), 2.5 * shake * sin(t, 6, 0.2)],
        head: [18 * R * raise + 4 * shake * sin(t, 12, 0.6), 12 * shake * sin(t, 6, 0.12), 3 * shake * sin(t, 6, 0.3)],
        jaw: [14 * R * raise + 6 * shake * sin(t, 12, 0.7), 0, 0],
        legs: {
          FL: { up: H * c([[0, 0], [0.08, 0.14, 'out'], [0.2, 0, 'in'], [1, 0]]), foot: [c([[0, 0], [0.08, 25, 'out'], [0.2, -3, 'in'], [0.3, 0, 'io']]), 0, 0] },
          FR: { fwd: 0.04 * H * raise, left: -0.03 * H * raise },
        },
        tailJoints: tailYaw,
      };
    },
  },

  // One-shot death: a flinch recoil, the legs buckle and the body sinks (front first), then the body topples onto its side (deathRoll degrees
  // about the Root; the legs ride the body and splay, feet that would pass through the ground stay on it) with a small bounce when it lands,
  // the head and tail flopping after it with a travelling lag. The last 0.2 of the clip is one held pose (a dead animal does not breathe).
  // The authored root sinks deeper than any body can, and the floor guard (def.floor) lifts every frame by exactly the height at which the
  // lowest skinned vertex touches the ground, so the collapse rests on the floor without passing through it.
  'monster-death': {
    seconds: 1.6, loop: false, floor: true,
    keyTimes: { recoil: 0.08, buckle: 0.4, topple: 0.62, rest: 0.8 },
    ctl(t, x) {
      const A = x.amp, M = x.mass, S = x.spine, W = x.tail, H = x.H, n = x.rig.tail.length, side = x.deathSide, roll = x.deathRoll ?? 78;
      const c = keys => curve(keys, t);
      const hit = c([[0, 0], [0.08, 1, 'out'], [0.24, 0.12], [0.34, 0]]);
      const SINK = [[0, 0], [0.1, 0.04], [0.4, 1, 'in2'], [0.5, 1, 'lin'], [1, 1]];
      const LIE = [[0, 0], [0.3, 0], [0.56, 1, 'in'], [0.64, 1.07, 'out2'], [0.74, 1, 'io'], [1, 1]];
      const sink = c(SINK), lie = c(LIE), front = curve(SINK, t - 0.04), recoil = c([[0, 0], [0.08, 1, 'out'], [0.3, 0]]);
      const lag = i => 0.1 * i / Math.max(1, n - 1);
      const tail = Array.from({ length: n }, (_, i) => [
        (14 * recoil - 30 * curve(SINK, t - lag(i))) * W / n,
        side * 16 * curve(LIE, t - lag(i)) * W * (0.4 + i / n) / n * 2,
        0,
      ]);
      // Legs: feet slide outward while the body buckles, the upper side reaches out and the lower side tucks as the body topples.
      const leg = key => {
        const down = (key[1] === 'L') === (side > 0), isFront = key[0] === 'F', sign = key[1] === 'L' ? 1 : -1;
        return {
          fwd: H * (isFront ? 0.08 : -0.07) * (0.6 * sink + 0.4 * lie),
          left: sign * H * (down ? 0.06 : 0.14) * sink,
          up: down ? 0 : H * 0.04 * lie,
        };
      };
      return {
        rigidLegs: true, plant: false,
        // rootFixed bodies (Ruun: chain links bound to the Root alone, which would sink through the floor with it) lower the body through the Root's children (bodyUp): the Root and its chain links stay put.
        rootUp: x.rootFixed ? 0 : -0.45 * H * sink + H * 0.025 * hit,
        bodyUp: x.rootFixed ? -0.45 * H * sink + H * 0.025 * hit : 0,
        // The Root of a rootFixed body never turns either (it would swing the chain links about itself): the same pitch goes through the hips.
        root: x.rootFixed ? [0, 0, 0] : [6 * hit - 4 * front * M, 0, 0],
        hip: [-4 * hit * M + (x.rootFixed ? 6 * hit - 4 * front * M : 0), 0, side * roll * lie],
        torso: [(4 * hit - 6 * sink) * S, side * 6 * lie, side * 8 * lie],
        chest: [-3 * front, 0, 0],
        neck: [(18 * hit - 30 * front) * A, side * 18 * lie, side * 10 * lie],
        head: [(14 * hit - 16 * front) * A, side * 24 * lie, side * 8 * lie],
        jaw: [14 * c([[0, 0], [0.1, 1, 'out'], [0.46, 0.5], [0.7, 0.4, 'io'], [1, 0.4]]) * A, 0, 0],
        legs: { FL: leg('FL'), FR: leg('FR'), HL: leg('HL'), HR: leg('HR') },
        tailJoints: tail,
      };
    },
  },

  // One-shot entrance: the body starts low to the ground with head and tail down (emerging), rises past standing with a small overshoot,
  // snaps up into an alert pose (head high and sweeping to both sides, tail up, a forepaw stamp), shakes the whole body off with a decaying
  // high-frequency wobble and settles into the idle pose: every term is zero at t = 1, where the idle clip's first frame is added back.
  'monster-spawn': {
    seconds: 1.4, loop: false, floor: true,
    keyTimes: { risen: 0.4, alert: 0.54, shake: 0.72, idle: 1 },
    ctl(t, x) {
      const A = x.amp, M = x.mass, S = x.spine, W = x.tail, H = x.H, n = x.rig.tail.length;
      const c = keys => curve(keys, t);
      const low = c([[0, 1], [0.12, 0.93, 'out2'], [0.42, 0, 'io']]);
      const alert = window01(t, 0.3, 0.46, 0.62, 0.74);
      const look = c([[0, -1], [0.46, -1], [0.56, 1], [0.66, -0.35], [0.76, 0]]);
      const shake = window01(t, 0.56, 0.62, 0.82, 0.95);
      const stamp = window01(t, 0.34, 0.4, 0.46, 0.52);
      const tail = Array.from({ length: n }, (_, i) => [
        (-26 * Math.max(low, 0) + 24 * alert) * W / n,
        (22 * shake * sin(t, 7, -0.1 * i) * (0.5 + i / n)) * W / n * 1.5,
        0,
      ]);
      const shape = {
        rootUp: x.rootFixed ? 0 : -0.45 * H * low,
        bodyUp: x.rootFixed ? -0.45 * H * low : 0,
        root: [-6 * low + 4 * alert * M ** 0.5, 2.5 * shake * sin(t, 7, 0.1), 2 * shake * sin(t, 7, 0.35)],
        hip: [-3 * alert, 0, 0],
        torso: [-8 * low * S + 5 * alert * S, 3.5 * shake * sin(t, 7, 0.3) * A, 3 * shake * sin(t, 7, 0.55)],
        chest: [4 * alert * A, 0, 0],
        neck: [(-34 * low + 16 * alert) * A, 16 * look + 7 * shake * sin(t, 7, 0.45), 4 * shake * sin(t, 7, 0.7)],
        head: [(-20 * low + 10 * alert) * A, 20 * look + 10 * shake * sin(t, 7, 0.6), 4 * shake * sin(t, 7, 0.9)],
        jaw: [12 * window01(t, 0.4, 0.46, 0.54, 0.62) * A, 0, 0],
        legs: { FL: { up: H * 0.06 * stamp, fwd: 0.02 * H * stamp } },
        tailJoints: tail,
      };
      return addCtl(shape, CLIPS['monster-idle'].ctl(0, x));
    },
  },

  // Knockdown (non-lethal): a faster version of the death topple (1.2 s, contact at 0.45, held lie from 0.62 to 1.0) that ends on an alert
  // held lie on the SIDE (head lifted a few degrees, legs loosely tucked) instead of a limp death. Reuses the death clip's `side * roll * lie`
  // pattern (roll = 78° about the spine) so the impact reads as a clear roll onto the flank, not a belly-flop.
  'monster-knockdown': {
    seconds: 1.2, loop: false, floor: true,
    keyTimes: { recoil: 0.08, buckle: 0.3, topple: 0.45, rest: 0.62 },
    ctl(t, x) {
      const A = x.amp, M = x.mass, S = x.spine, W = x.tail, H = x.H, n = x.rig.tail.length, side = x.deathSide, roll = x.deathRoll ?? 78;
      const c = keys => curve(keys, t);
      const hit = c([[0, 0], [0.08, 1, 'out'], [0.24, 0.12], [0.34, 0]]);
      // Faster sink and lie curves: contact at 0.45 (vs 0.56 in death), held from 0.62 (vs 0.74 in death). The lie and sink are
      // truly constant from 0.5 (well before 0.62) to 1.0 so every key from frame ceil(0.62*(n-1)) to the end is identical, and the
      // floor guard sits on the ground with the secondary motion settled.
      const SINK = [[0, 0], [0.1, 0.04], [0.3, 1, 'in2'], [0.4, 1, 'lin'], [0.5, 1, 'io'], [1, 1]];
      const LIE = [[0, 0], [0.16, 0], [0.45, 1, 'in'], [0.5, 1, 'io'], [1, 1]];
      const sink = c(SINK), lie = c(LIE), front = curve(SINK, t - 0.04), recoil = c([[0, 0], [0.08, 1, 'out'], [0.3, 0]]);
      // All secondary motion (tail whip, head lift, jaw slack) settles by t=0.5 and is held flat at t=0.5 (the held lie).
      const tail = Array.from({ length: n }, (_, i) => {
        const settle = c([[0, 0], [0.4, 0, 'lin'], [0.5, 1, 'out'], [1, 1]]);
        return [
          (14 * recoil - 26 * curve(SINK, t - 0.1 * i / Math.max(1, n - 1))) * W / n * settle,
          side * 14 * curve(LIE, t - 0.1 * i / Math.max(1, n - 1)) * W * (0.4 + i / n) / n * 2 * settle,
          0,
        ];
      });
      const leg = key => {
        const down = (key[1] === 'L') === (side > 0), isFront = key[0] === 'F', sign = key[1] === 'L' ? 1 : -1;
        // Legs swing out / kick during the fall (faster than the death clip) and tuck loosely for the held lie.
        return {
          fwd: H * (isFront ? 0.08 : -0.07) * (0.6 * sink + 0.4 * lie),
          left: sign * H * (down ? 0.06 : 0.14) * sink,
          up: down ? 0 : H * 0.04 * lie,
          seedKnees: true,
        };
      };
      // Jaw opens at the hit then closes / is held slack from 0.5 on (the death clip keeps it slack; the knockdown alerts slightly less).
      const jaw = c([[0, 0], [0.1, 1, 'out'], [0.32, 0.4], [0.5, 0.2, 'io'], [0.6, 0.2, 'io'], [0.62, 0.2, 'io'], [1, 0.2]]) * A;
      return {
        rigidLegs: true, plant: false,
        rootUp: x.rootFixed ? 0 : -0.45 * H * sink + H * 0.025 * hit,
        bodyUp: x.rootFixed ? -0.45 * H * sink + H * 0.025 * hit : 0,
        root: x.rootFixed ? [0, 0, 0] : [6 * hit - 4 * front * M, 0, 0],
        // Full topple (78° roll) onto the side about the spine, exactly like the death clip — the impact reads as a clear roll, not a belly-flop.
        hip: [-4 * hit * M + (x.rootFixed ? 6 * hit - 4 * front * M : 0), 0, side * roll * lie],
        torso: [(4 * hit - 6 * sink) * S, side * 6 * lie, side * 8 * lie],
        chest: [-3 * front, 0, 0],
        // Head lifts slightly while lying (-10 alert pitch) instead of the death clip's limp -16, and the head yaw / roll is held alert (not +24 / +8 limp).
        neck: [(18 * hit - 30 * front) * A, side * 12 * lie, side * 6 * lie],
        head: [(14 * hit - 10 * front) * A, side * 12 * lie, side * 4 * lie],
        jaw: [jaw, 0, 0],
        legs: { FL: leg('FL'), FR: leg('FR'), HL: leg('HL'), HR: leg('HR') },
        tailJoints: tail,
      };
    },
  },

  // Get-up (non-lethal): frame 0 is the knockdown's held lie exactly (the controls start AS the knockdown's last controls and leave them
  // over the first tenth), the body rolls back to sternal (belly down, head lifted) by 0.24, plants the front legs and pushes the chest up
  // by 0.44, gathers and plants the hind legs by 0.62, stands by 0.75 and shakes the whole body off while the last quarter blends into the
  // idle clip's first controls: the final frame IS the idle's first frame (the settle at u >= GETUP_SETTLE drops the floor guard and lift,
  // like the entrance's). Everything is authored in control space, so the seam and the idle match are exact by construction.
  'monster-getup': {
    seconds: 1.6, loop: false, floor: true,
    keyTimes: { sternal: 0.24, frontLegs: 0.44, hindLegs: 0.62, stand: 0.75, idle: 1 },
    ctl(t, x) {
      const A = x.amp, M = x.mass, S = x.spine, W = x.tail, H = x.H, n = x.rig.tail.length, side = x.deathSide;
      const c = keys => curve(keys, t);
      const roll = c([[0, 1], [0.24, 0, 'io']]);
      // Body height: lowered like the knockdown (the floor guard lifts it onto the ground) until the front legs push, then rising.
      const sink = c([[0, 1], [0.24, 1, 'lin'], [0.44, 0.55, 'io'], [0.62, 0.16, 'io'], [0.72, -0.03, 'out'], [0.8, 0, 'io'], [1, 0]]);
      const pitch = c([[0, -4 * M], [0.24, 0, 'io'], [0.44, 11 * M ** 0.5, 'out'], [0.62, 3, 'io'], [0.75, -1.5, 'io'], [0.85, 0, 'io'], [1, 0]]);
      const shake = window01(t, 0.56, 0.64, 0.84, 0.94);
      const alert = window01(t, 0.5, 0.62, 0.7, 0.8);
      const tailDown = c([[0, 1], [0.3, 0.55], [0.62, 0.1], [0.75, 0], [1, 0]]);
      const tail = Array.from({ length: n }, (_, i) => [
        (-26 * tailDown + 10 * alert) * W / n,
        (side * 14 * roll * (0.4 + i / n) * 2 + 8 * shake * sin(t, 7, -0.1 * i) * (0.4 + i / n) * 1.5) * W / n,
        0,
      ]);
      const splay = c([[0, 1], [0.24, 0.7], [0.5, 0.25], [0.7, 0], [1, 0]]);
      const fwdFront = c([[0, 0.08], [0.24, 0.09], [0.44, 0.04, 'io'], [0.62, 0.02], [0.75, 0], [1, 0]]);
      const fwdHind = c([[0, -0.07], [0.3, -0.07, 'lin'], [0.44, 0.02, 'io'], [0.62, 0, 'io'], [0.75, 0], [1, 0]]);
      const leg = key => {
        const down = (key[1] === 'L') === (side > 0), isFront = key[0] === 'F', sign = key[1] === 'L' ? 1 : -1;
        return {
          fwd: H * (isFront ? fwdFront : fwdHind),
          left: sign * H * (0.06 + (down ? 0 : 0.08) * roll) * splay,
          up: down ? 0 : H * 0.04 * roll,
        };
      };
      const lowering = -0.45 * H * sink;
      // The body shakes off about the Root (rootFixed bodies: through the hips, their Root never turns).
      const wobble = [3 * shake * sin(t, 7, 0.1) * M ** 0.5, 5 * shake * sin(t, 7, 0.35) * A, 4 * shake * sin(t, 7, 0.6)];
      const pose = {
        rootUp: x.rootFixed ? 0 : lowering,
        bodyUp: x.rootFixed ? lowering : 0,
        root: x.rootFixed ? [0, 0, 0] : [pitch + wobble[0], wobble[1], wobble[2]],
        hip: x.rootFixed ? [pitch + wobble[0], wobble[1], side * (x.deathRoll ?? 78) * roll + wobble[2]] : [0, 0, side * (x.deathRoll ?? 78) * roll],
        torso: [(-6 * sink + 4 * alert) * S, side * 6 * roll + 6 * shake * sin(t, 7, 0.3) * A, side * 8 * roll + 5 * shake * sin(t, 7, 0.55)],
        chest: [-3 * sink + 3 * alert * A, 0, 0],
        neck: [c([[0, -30], [0.24, 12, 'out'], [0.44, 22, 'io'], [0.62, 6, 'io'], [0.75, 0, 'io'], [1, 0]]) * A, side * 12 * roll + 12 * shake * sin(t, 7, 0.45) * A, side * 6 * roll + 4 * shake * sin(t, 7, 0.7)],
        head: [c([[0, -10], [0.24, 8, 'out'], [0.44, 14, 'io'], [0.62, 2, 'io'], [0.75, 0, 'io'], [1, 0]]) * A, side * 12 * roll + 16 * shake * sin(t, 7, 0.6) * A, side * 4 * roll + 5 * shake * sin(t, 7, 0.9)],
        jaw: [(0.2 * c([[0, 1], [0.3, 0, 'io'], [1, 0]]) + 6 * window01(t, 0.58, 0.64, 0.72, 0.8)) * A, 0, 0],
        legs: { FL: leg('FL'), FR: leg('FR'), HL: leg('HL'), HR: leg('HR') },
        tailJoints: tail,
      };
      const lie = CLIPS['monster-knockdown'].ctl(1, x), idle = CLIPS['monster-idle'].ctl(0, x);
      // The first frame IS the knockdown's last controls and the last frame IS the idle's first controls, bit for bit.
      if (t <= 0) return lie;
      if (t >= 1) return idle;
      const away = smoothstep(t / 0.1), toIdle = smoothstep((t - 0.7) / 0.3);
      const blended = lerpCtl(lerpCtl(lie, pose, away), idle, toIdle);
      // The legs ride the rolling body only while it is rolled; the pose stays uncompensated (plant: false) until the settle hands over to the
      // idle's own solve. Once unrolled the knees are seeded to their rest fold side so they cannot flip while the body rises.
      delete blended.rigidLegs;
      delete blended.plant;
      const rolled = 1 - away + away * roll;
      if (rolled > 0) blended.rigidLegs = rolled >= 1 ? true : rolled;
      if (t < GETUP_SETTLE) blended.plant = false;
      for (const key of Object.keys(blended.legs)) { if (t < GETUP_SETTLE) blended.legs[key].seedKnees = true; else delete blended.legs[key].seedKnees; }
      return blended;
    },
  },

  // Tail whip / sweep (tailed rigs only): the chain cocks to one side while the hips and chest wind the opposite way (windup), the hips
  // drive across and the tail follows with a travelling lag so the tip cracks past the body at ~0.5 (strike), then it rings down and settles.
  // Feet stay planted; the tail tip sweeps a wide arc.
  'monster-tail': {
    seconds: 1.3, loop: false,
    keyTimes: { windupEnd: 0.36, strike: 0.5, followThroughEnd: 0.8 },
    ctl(t, x) {
      const A = x.amp, M = x.mass, S = x.spine, Y = Math.min(x.yawSpine * x.swing, x.yawCap ?? 1.0), V = x.whip, n = x.rig.tail.length;
      const c = keys => curve(keys, t);
      const sweep = [[0, 0], [0.34, 52 * V], [0.42, 60 * V, 'lin'], [0.5, -86 * V, 'in'], [0.57, -108 * V, 'out'], [0.68, -58 * V], [0.78, -8 * V], [0.88, 16 * V], [1, 0]];
      const rise = [[0, 0], [0.34, 8 * V], [0.42, 14 * V, 'out'], [0.5, 0, 'in'], [0.58, 10 * V], [0.8, 3 * V], [1, 0]];
      const tailJoints = Array.from({ length: n }, (_, i) => {
        const lag = 0.03 * i, k = 0.75 + 0.5 * i / Math.max(1, n - 1);
        const swing = curve(sweep, t - lag) / n * k;
        // A tail that hangs down barely moves when yawed about the vertical axis: its sideways whip comes from rolling about the body axis.
        return [curve(rise, t - lag) / n * k, swing * x.tailAxes.yaw, swing * x.tailAxes.roll * x.tailAxes.rollSign];
      });
      return {
        root: [c([[0, 0], [0.34, 2 * M], [0.5, -1.5, 'in'], [0.7, 0.6], [1, 0]]), c([[0, 0], [0.34, 3 * A], [0.5, -5 * A, 'in'], [0.62, -3 * A, 'out'], [0.85, 0.6], [1, 0]]), c([[0, 0], [0.34, 3 * A], [0.5, -4 * A, 'in'], [0.7, -0.6], [1, 0]])],
        hip: [0, c([[0, 0], [0.34, 6 * Y], [0.42, 7 * Y, 'lin'], [0.5, -8 * Y, 'in'], [0.6, -10 * Y, 'out'], [0.8, -2 * Y], [1, 0]]), 0],
        torso: [0, c([[0, 0], [0.34, 3.5 * Y], [0.5, -3.5 * Y, 'in'], [0.62, -4 * Y, 'out'], [0.85, 0], [1, 0]]), c([[0, 0], [0.34, 3 * S], [0.5, -3 * S, 'in'], [1, 0]])],
        neck: [c([[0, 0], [0.34, 3 * A], [0.5, -2, 'in'], [1, 0]]), c([[0, 0], [0.34, -6 * A], [0.5, 8 * A, 'in'], [0.62, 6 * A, 'out'], [0.85, 0], [1, 0]]), 0],
        head: [c([[0, 0], [0.34, 2], [0.5, -2, 'in'], [1, 0]]), c([[0, 0], [0.34, -9 * A], [0.5, 12 * A, 'in'], [0.62, 9 * A, 'out'], [0.85, 0], [1, 0]]), 0],
        tailJoints,
      };
    },
  },

  // ---------------------------------------------------------------------------------------------
  // Blood Bamboo Valley extras (Asha, Tali): personality.extraClips lists them; none is a monster slot. `attackWindow` = normalized
  // [anticipation end, active start, active end, recovery end]: the combat owner reads the seconds from the clips report.
  // ---------------------------------------------------------------------------------------------

  // Phase 1 (Stalking), Tiger Pounce: coil low, launch, a long arc with the forepaws reaching ahead, land chest-first with the jaws open, recover.
  'asha-stalk-pounce': {
    seconds: 1.5, loop: false,
    keyTimes: { crouchEnd: 0.28, launch: 0.38, apex: 0.5, impact: 0.64, recoverStart: 0.78 },
    attackWindow: [0.28, 0.44, 0.66, 0.9],
    ctl(t, x) {
      const A = x.amp, M = x.mass, S = x.spine, W = x.tail, H = x.H, G = x.strike, tuck = x.jumpTuck;
      const c = keys => curve(keys, t);
      const rootUp = H * c([[0, 0], [0.28, -0.11 * M], [0.38, -0.02, 'in'], [0.5, x.leap * 1.2, 'out2'], [0.64, 0, 'in2'], [0.72, -0.08 * M, 'out'], [0.88, -0.02], [1, 0]]);
      const lift = Math.max(rootUp, 0);
      const hind = {
        fwd: H * c([[0, 0], [0.38, 0, 'lin'], [0.46, -0.12, 'out'], [0.58, -0.06], [0.64, 0.05], [0.7, 0, 'in'], [1, 0]]),
        up: lift + H * tuck * c([[0, 0], [0.38, 0, 'lin'], [0.48, 0.15, 'out'], [0.6, 0.14, 'lin'], [0.68, 0, 'in'], [1, 0]]),
      };
      const front = {
        fwd: H * c([[0, 0], [0.38, 0, 'lin'], [0.46, 0.1, 'out'], [0.6, 0.3, 'io'], [0.66, 0.3, 'lin'], [0.76, 0.04, 'io'], [1, 0]]),
        up: lift + H * tuck * c([[0, 0], [0.36, 0, 'lin'], [0.46, 0.12, 'out'], [0.58, 0.1, 'lin'], [0.65, -0.03, 'in'], [0.7, 0, 'io'], [1, 0]]),
      };
      const tail = tailWhip(x, t, [[0, 0], [0.28, 12 * W], [0.4, -20 * W], [0.64, 16 * W], [0.8, -10 * W], [1, 0]], 0.03,
        [[0, 0], [0.28, -10 * W], [0.42, 26 * W], [0.64, 4 * W], [0.8, -14 * W], [0.92, 4 * W], [1, 0]]);
      return {
        rootUp,
        root: [c([[0, 0], [0.28, -5 * M], [0.36, 10 * A, 'in'], [0.5, 2 * A], [0.64, -11 * A, 'in'], [0.72, -12 * M, 'out'], [0.9, -2], [1, 0]]), 0, 0],
        hip: [c([[0, 0], [0.28, 7 * M], [0.36, -6 * A, 'in'], [0.64, 3], [0.72, 6 * M, 'out'], [1, 0]]), 0, 0],
        torso: [c([[0, 0], [0.28, -12 * S * M], [0.36, 11 * S * A, 'in'], [0.5, 4 * S], [0.64, -8 * S, 'in'], [0.72, -12 * S * M, 'out'], [1, 0]]), 0, 0],
        chest: [c([[0, 0], [0.28, -6], [0.36, 8, 'in'], [0.72, -8, 'io'], [1, 0]]), 0, 0],
        neck: [c([[0, 0], [0.2, -8 * A], [0.28, -12 * A, 'lin'], [0.36, 16 * A, 'in'], [0.5, 6 * A], [0.62, -26 * A * G, 'in'], [0.74, -14 * A, 'out'], [0.9, 2], [1, 0]]), 0, 0],
        head: [c([[0, 0], [0.28, -6], [0.38, 12 * A, 'in'], [0.54, 4], [0.64, -16 * A * G, 'in'], [0.76, -6 * A, 'out'], [1, 0]]), 0, 0],
        jaw: [c([[0, 0], [0.5, 0], [0.58, 30 * A, 'out'], [0.72, 28 * A, 'lin'], [0.86, 0]]), 0, 0],
        legs: { FL: front, FR: front, HL: hind, HR: hind },
        tailJoints: tail,
      };
    },
  },

  // Phase 2 (Corruption Rage), Corrupted Pounce: she rears onto the hind legs with a roar, then crashes both forepaws down; the Ground Corruption
  // Wave leaves the impact (hazard visuals are the renderer's). The slam is the active window.
  'asha-corrupt-slam': {
    seconds: 1.8, loop: false,
    keyTimes: { riseEnd: 0.4, slam: 0.54, recoverStart: 0.8 },
    attackWindow: [0.4, 0.5, 0.64, 0.92],
    ctl(t, x) {
      const A = x.amp, M = x.mass, S = x.spine, W = x.tail, H = x.H, G = x.strike, R = Math.max(A, 1) * (x.howl ?? 1);
      const c = keys => curve(keys, t);
      const shake = window01(t, 0.26, 0.34, 0.48, 0.52);
      const front = side => ({
        up: H * c([[0, 0], [0.14, 0], [0.4, 0.3, 'out'], [0.5, 0.3, 'lin'], [0.56, 0, 'in'], [1, 0]]),
        fwd: H * c([[0, 0], [0.4, 0.1, 'out'], [0.5, 0.12], [0.56, 0.18, 'in'], [0.66, 0.15], [0.86, 0], [1, 0]]),
        left: side * H * 0.03 * window01(t, 0.2, 0.4, 0.5, 0.6),
      });
      const tail = tailWhip(x, t, [[0, 0], [0.4, 10 * W], [0.56, -26 * W, 'in'], [0.74, 12 * W], [1, 0]], 0.03,
        [[0, 0], [0.4, 22 * W], [0.56, -8 * W, 'in'], [0.8, 6 * W], [1, 0]]);
      return {
        rootUp: H * c([[0, 0], [0.14, -0.05 * M, 'io'], [0.4, 0.1 * A, 'out'], [0.5, 0.1 * A, 'lin'], [0.56, -0.03 * M, 'in'], [0.66, 0, 'out'], [1, 0]]),
        root: [c([[0, 0], [0.14, -4 * M], [0.4, 20 * A, 'out'], [0.5, 20 * A, 'lin'], [0.56, -6 * M, 'in'], [0.68, -2], [0.92, 0], [1, 0]]) + 1.2 * shake * sin(t, 12), 0, 1.2 * shake * sin(t, 9, 0.2)],
        hip: [c([[0, 0], [0.14, 6 * M], [0.4, -10 * A, 'out'], [0.5, -10 * A, 'lin'], [0.56, 4, 'in'], [1, 0]]), 0, 0],
        torso: [c([[0, 0], [0.14, -8 * S * M], [0.4, 12 * S * A, 'out'], [0.5, 12 * S * A, 'lin'], [0.56, -12 * S, 'in'], [0.72, -3 * S], [1, 0]]), 1.5 * shake * sin(t, 7, 0.4), 0],
        chest: [c([[0, 0], [0.4, 10 * A, 'out'], [0.5, 10 * A, 'lin'], [0.56, -6, 'in'], [1, 0]]) + 1.5 * shake * sin(t, 12, 0.3), 0, 0],
        neck: [c([[0, 0], [0.14, -8 * A], [0.4, 20 * R, 'out'], [0.5, 20 * R, 'lin'], [0.56, -30 * A * G, 'in'], [0.72, -10 * A], [1, 0]]) + 3 * shake * sin(t, 12, 0.35), 4 * shake * sin(t, 6), 0],
        head: [c([[0, 0], [0.14, -6], [0.4, 16 * R, 'out'], [0.5, 16 * R, 'lin'], [0.56, -22 * A * G, 'in'], [0.74, -6 * A], [1, 0]]) + 3 * shake * sin(t, 12, 0.6), 8 * shake * sin(t, 6, 0.12), 0],
        jaw: [c([[0, 0], [0.28, 0], [0.4, 32 * R, 'out'], [0.5, 32 * R, 'lin'], [0.58, 0, 'in'], [1, 0]]) + 5 * shake * sin(t, 12, 0.7), 0, 0],
        legs: { FL: front(1), FR: front(-1) },
        tailJoints: tail,
      };
    },
  },

  // Phase 3 (The Cub), Bamboo Charge: a low wind-up with a forepaw scrape, a head-down run-in-place burst on the run gait (the simulation carries the body), and a
  // skidding settle. The burst is the active window.
  'asha-bamboo-charge': {
    seconds: 1.6, loop: false,
    keyTimes: { scrapeEnd: 0.28, burstStart: 0.34, burstEnd: 0.84, settled: 1 },
    attackWindow: [0.3, 0.38, 0.82, 0.96],
    ctl(t, x) {
      const A = x.amp, M = x.mass, S = x.spine, W = x.tail, H = x.H;
      const c = keys => curve(keys, t);
      const burst = window01(t, 0.32, 0.4, 0.8, 0.9);
      const coil = window01(t, 0.02, 0.14, 0.26, 0.34);
      const phase = (((t - 0.34) / 0.5) * 2) % 1;
      const gait = scaleCtl(ikGaitCtl(phase < 0 ? phase + 1 : phase, x, 'run'), burst);
      const scrape = window01(t, 0.08, 0.14, 0.26, 0.32) * sin(t, 4, 0.1);
      const tail = Array.from({ length: x.rig.tail.length }, (_, i) => [(-4 * coil - 6 * burst) / x.rig.tail.length, 10 * W * coil * sin(t, 2, -0.1 * i) / x.rig.tail.length, 0]);
      const stance = {
        rootUp: -H * (0.07 * M * coil + 0.03 * burst),
        root: [-4 * coil - 8 * burst, 0, 0],
        hip: [3 * coil, 0, 0],
        torso: [-8 * S * coil - 4 * S * burst, 0, 0],
        chest: [-4 * coil - 3 * burst, 0, 0],
        neck: [-20 * A * coil - 16 * A * burst, 3 * coil * sin(t, 3), 0],
        head: [-10 * A * coil - 10 * A * burst, 0, 0],
        jaw: [4 * window01(t, 0.44, 0.5, 0.78, 0.86) * A, 0, 0],
        legs: { FL: { fwd: -H * 0.12 * scrape * coil, up: H * 0.06 * Math.max(scrape, 0) * coil } },
        tailJoints: tail,
      };
      return addCtl(gait, stance);
    },
  },

  // Cleanse reaction: the corrupted body braces rigid, shudders as the sap peels away, then lets go - the body sinks, the head lowers, the tail drops -
  // and settles into the calm stance (the bond clip continues from it).
  'asha-cleanse': {
    seconds: 2.8, loop: false,
    keyTimes: { tense: 0.15, shudder: 0.4, peel: 0.52, release: 0.7, calm: 0.9 },
    ctl(t, x) {
      const A = x.amp, M = x.mass, S = x.spine, W = x.tail, H = x.H, n = x.rig.tail.length;
      const c = keys => curve(keys, t);
      const tense = window01(t, 0, 0.12, 0.34, 0.46);
      const shudder = window01(t, 0.3, 0.38, 0.56, 0.68);
      const release = c([[0.52, 0], [0.7, 1, 'io'], [0.88, 1, 'lin'], [1, 0, 'io']]);
      const breath = Math.sin(TAU * 1.5 * (t - 0.7)) * release;
      const tail = Array.from({ length: n }, (_, i) => [(8 * tense - 18 * release) * W / n, (10 * shudder * sin(t, 8, -0.1 * i) + 4 * release * sin(t, 1, -0.1 * i)) * W / n * 1.4, 0]);
      return {
        rootUp: H * (0.012 * tense - 0.05 * M * release),
        root: [3 * tense * A - 3 * release, 2 * shudder * sin(t, 9, 0.1), 1.5 * shudder * sin(t, 11, 0.3)],
        hip: [-2 * tense, 0, 0],
        torso: [(6 * tense - 5 * release) * S + 1.6 * breath, 5 * shudder * sin(t, 8, 0.2), 2 * shudder * sin(t, 10)],
        chest: [4 * tense - 3 * release + 1.2 * breath, 0, 0],
        neck: [(10 * tense - 16 * release) * A + 3 * shudder * sin(t, 9, 0.35) + 1.2 * breath, 10 * shudder * sin(t, 7), 3 * shudder * sin(t, 8, 0.2)],
        head: [(8 * tense - 12 * release) * A + 3 * shudder * sin(t, 9, 0.6), 16 * shudder * sin(t, 7, 0.1) + 8 * release * sin(t, 1, 0.3), 4 * shudder * sin(t, 8, 0.4)],
        jaw: [-6 * release * A + 8 * shudder * window01(t, 0.36, 0.42, 0.5, 0.56), 0, 0],
        legs: {
          FL: { left: H * 0.04 * (tense + 0.5 * shudder) }, FR: { left: -H * 0.04 * (tense + 0.5 * shudder) },
          HL: { left: H * 0.03 * tense }, HR: { left: -H * 0.03 * tense },
        },
        tailJoints: tail,
      };
    },
  },

  // Bonded idle (after the cleanse): a calm, slightly lowered stance, slow breath, the head resting low with a gentle sway and a loose, slowly swinging tail.
  'asha-bond-idle': {
    seconds: 4.0, loop: true,
    ctl(t, x) {
      const A = x.amp, M = x.mass, S = x.spine, W = x.tail, H = x.H, n = x.rig.tail.length;
      const breath = sin(t, 3);
      const tail = Array.from({ length: n }, (_, i) => [-3 / n, 9 * W * sin(t, 1, -0.1 * i) * (0.5 + i / n) / n * 2, 0]);
      return {
        rootUp: -H * 0.025 * M,
        root: [-1 + 0.6 * sin(t, 1, 0.5), 1.4 * sin(t, 1, 0.25), 0.8 * sin(t, 1, 0.1)],
        hip: [-0.6 * breath, -1 * sin(t, 1, 0.3), 1.2 * sin(t, 1, 0.25) * M],
        torso: [-2 * S + 1.4 * breath, 1.2 * sin(t, 1, 0.1), 0],
        chest: [2.4 * breath, 0, 0],
        neck: [-9 * A + 1.6 * sin(t, 3, -0.1), 6 * sin(t, 1, 0.1), 3 * sin(t, 1, 0.2)],
        head: [-5 * A + 1.2 * sin(t, 3, 0.1), 8 * sin(t, 1, 0.05), 4 * sin(t, 1, 0.3)],
        tailJoints: tail,
      };
    },
  },

  // Stalking walk (Phase 1): a slow, belly-low prowl on the IK gait with the head carried below the shoulders.
  'asha-stalk': {
    seconds: 1.2, loop: true,
    ctl(t, x) {
      const A = x.amp;
      return addCtl(ikGaitCtl(t, x, 'stalk'), { root: [-3, 0, 0], torso: [-4 * x.spine, 0, 0], neck: [-14 * A, 0, 0], head: [-8 * A, 0, 0] });
    },
  },

  // Corrupted idle (Phase 2): shoulders up and head low, the head swinging from side to side, a faint high-frequency quiver, the tail stiff and low.
  'asha-corrupted-idle': {
    seconds: 2.4, loop: true,
    ctl(t, x) {
      const A = x.amp, S = x.spine, W = x.tail, H = x.H, n = x.rig.tail.length;
      const tail = Array.from({ length: n }, (_, i) => [-5 / n, 6 * W * sin(t, 2, -0.08 * i) / n * 2, 0]);
      return {
        rootUp: -H * 0.02,
        root: [-3 + 0.8 * sin(t, 2), 0.8 * sin(t, 1, 0.25), 0.8 * sin(t, 12, 0.1)],
        torso: [-4 * S + 0.8 * sin(t, 2, 0.1), 2 * sin(t, 1, 0.1), 0.5 * sin(t, 10)],
        chest: [-3 + 1.5 * sin(t, 2), 0, 0],
        neck: [-12 * A + 1.5 * sin(t, 2, 0.2), 10 * sin(t, 1), 1.5 * sin(t, 10, 0.3)],
        head: [-8 * A + 1.2 * sin(t, 2, 0.35), 14 * sin(t, 1, 0.05), 2 * sin(t, 12, 0.5)],
        legs: { FL: { left: H * 0.03 }, FR: { left: -H * 0.03 } },
        tailJoints: tail,
      };
    },
  },

  // Tali, play: a play bow (chest low, forepaws reaching ahead, hindquarters up) with a bouncing rhythm and a wagging tail.
  'tali-play': {
    seconds: 1.6, loop: true,
    ctl(t, x) {
      const A = x.amp, W = x.tail, H = x.H, n = x.rig.tail.length;
      const bounce = 0.5 - 0.5 * Math.cos(TAU * 2 * t);
      const tail = Array.from({ length: n }, (_, i) => [4 / n, 24 * W * sin(t, 4, -0.1 * i) / n * 2, 0]);
      return {
        rootUp: H * 0.03 * bounce,
        root: [-4 - 2 * bounce, 3 * sin(t, 2, 0.25), 2 * sin(t, 2, 0.1)],
        hip: [-18 - 3 * bounce, 0, 0],
        torso: [-10 * x.spine, 0, 0],
        chest: [-8, 0, 0],
        neck: [-14 * A + 4 * sin(t, 2, 0.1), 7 * sin(t, 1), 0],
        head: [6 * A + 5 * sin(t, 2, 0.3), 8 * sin(t, 1, 0.15), 4 * sin(t, 2)],
        jaw: [10 * window01(t, 0.1, 0.2, 0.4, 0.5) * A, 0, 0],
        legs: { FL: { fwd: H * 0.18, up: 0 }, FR: { fwd: H * 0.18, up: 0 } },
        tailJoints: tail,
      };
    },
  },

  // Tali, nuzzle (the reunion): the head lowers and presses forward, rubs from side to side with a soft roll, the shoulders lean in, the tail curls and sways.
  'tali-nuzzle': {
    seconds: 2.4, loop: false,
    keyTimes: { lean: 0.25, rub: 0.55, release: 0.85 },
    ctl(t, x) {
      const A = x.amp, S = x.spine, W = x.tail, H = x.H, n = x.rig.tail.length;
      const lean = window01(t, 0.06, 0.28, 0.72, 0.92);
      const rub = window01(t, 0.3, 0.4, 0.7, 0.8) * sin(t, 3, 0.1);
      const tail = Array.from({ length: n }, (_, i) => [(8 * lean) / n, 14 * W * lean * sin(t, 2, -0.1 * i) / n * 2, 0]);
      return {
        rootUp: -H * 0.02 * lean,
        root: [-4 * lean, 3 * rub, 2 * rub],
        torso: [-5 * S * lean, 3 * rub, 0],
        neck: [-16 * A * lean, 14 * rub, 6 * rub],
        head: [-6 * A * lean, 18 * rub, 8 * rub],
        jaw: [3 * lean * A, 0, 0],
        legs: { FL: { fwd: H * 0.05 * lean }, FR: { fwd: H * 0.05 * lean } },
        tailJoints: tail,
      };
    },
  },
};

// ---------------------------------------------------------------------------------------------
// Walk-derived leg motion for the run clip
// ---------------------------------------------------------------------------------------------
function readWalk(rig, json, bin, gains) {
  const walk = json.animations?.find(a => a.name === 'preset:quadruped:walk');
  if (!walk) throw new Error('Input has no preset:quadruped:walk clip');
  const times = readAccessor(json, bin, walk.samplers[0].input);
  const tracks = new Map();
  for (const channel of walk.channels) {
    if (channel.target.path !== 'rotation') continue;
    const values = readAccessor(json, bin, walk.samplers[channel.sampler].output);
    tracks.set(channel.target.node, Array.from(times, (_, k) => new Quaternion(values[4 * k], values[4 * k + 1], values[4 * k + 2], values[4 * k + 3])));
  }
  // The preset ends on its first pose (last key == first key), so one period is count - 1 samples.
  const period = times.length - 1;
  const frames = [];
  for (let k = 0; k < period; k++) {
    const locals = rig.restQ.map((q, i) => (tracks.has(i) ? tracks.get(i)[k] : q).clone());
    frames.push({ locals, ...rig.forward(locals, rig.restT[rig.rootJoint]) });
  }
  const legs = {};
  for (const key of rig.legKeys) {
    const leg = rig.legs[key];
    const rel0 = frames.map(f => f.Q[leg.reference].clone().invert().multiply(f.Q[leg.chain[0]]));
    const chain = leg.chain.slice(1).map(j => frames.map(f => f.locals[j].clone()));
    const gain = gains.legSwing;
    const meanRel = meanQ(rel0);
    legs[key] = {
      rel0: rel0.map(q => amplifyQ(q, meanRel, gain)),
      locals: chain.map(samples => { const m = meanQ(samples); return samples.map(q => amplifyQ(q, m, gain)); }),
    };
  }
  return {
    period,
    sample(phase) {
      const s = (((phase % 1) + 1) % 1) * period, i = Math.floor(s) % period, f = s - Math.floor(s);
      const mix = list => list[i].clone().slerp(list[(i + 1) % period], f);
      const out = {};
      for (const key of rig.legKeys) out[key] = { rel0: mix(legs[key].rel0), locals: legs[key].locals.map(mix) };
      return out;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Sampling, measurement
// ---------------------------------------------------------------------------------------------
/**
 * Keeps tail and head from digging into the ground (heavy low-slung bodies: tail whips and nose dives would otherwise push
 * skinned vertices below y = 0). Each region's lowest skinned vertex may not drop below its rest height (minus a small
 * tolerance) RELATIVE TO THE BODY'S OWN VERTICAL MOTION; when it would, the smallest extra pitch that restores it is added to
 * the tail chain or to the neck/head.
 *
 * The floor follows the body because a resting floor is only meaningful for a resting body: a gait that dips the whole body
 * (the authored ikGait `dip` / `bob`) carries the neck base and the tail root down with it, so a fixed rest-height floor would
 * report that ordinary dip as a floor violation and crane the neck up to answer it. On a rig whose head sits low over the
 * ground (Solkar's mane) that craning points the muzzle at the sky for the whole walk and run. The reference is the body's own
 * root travel (the Root's rest height plus its authored vertical offset), so the guard still catches the poses that really do
 * push the head or tail into the ground (a nose dive, a collapse) and leaves the body's own bounce alone.
 *
 * The body-relative floor applies to the locomotion clips only (LOCOMOTION_FLOOR_CLIPS). Every other clip keeps the absolute
 * rest-height floor, so its authored transform is untouched: a neck correction there would otherwise rotate the hips and swing
 * the knees, which is a change to a clip the correction never aimed at.
 */
class GroundGuard {
  constructor(rig, json, bin, H, bodyRelativeFloor = false) {
    const primitive = json.meshes[0].primitives[0];
    const read = id => {
      const a = json.accessors[id], view = json.bufferViews[a.bufferView], comps = COMPONENTS[a.type];
      const width = { 5121: 1, 5123: 2, 5126: 4 }[a.componentType], stride = view.byteStride ?? comps * width, base = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
      const out = new Float64Array(a.count * comps);
      for (let i = 0; i < a.count; i++) for (let c = 0; c < comps; c++) {
        const o = base + i * stride + c * width;
        let v = a.componentType === 5126 ? bin.readFloatLE(o) : a.componentType === 5123 ? bin.readUInt16LE(o) : bin.readUInt8(o);
        if (a.normalized) v /= a.componentType === 5123 ? 65535 : 255;
        out[i * comps + c] = v;
      }
      return out;
    };
    this.rig = rig;
    this.tolerance = 0.01 * H;
    const positions = read(primitive.attributes.POSITION), joints = read(primitive.attributes.JOINTS_0), weights = read(primitive.attributes.WEIGHTS_0);
    this.inverse = read(json.skins[0].inverseBindMatrices);
    const regionOf = node => (rig.tail.includes(node) ? 'tail' : rig.neck.includes(node) || rig.head.includes(node) ? 'head' : undefined);
    this.vertices = { tail: [], head: [] };
    for (let i = 0; i < positions.length / 3; i += 3) {
      let best = 0;
      for (let k = 1; k < 4; k++) if (weights[i * 4 + k] > weights[i * 4 + best]) best = k;
      const region = regionOf(rig.joints[joints[i * 4 + best]]);
      if (!region) continue;
      const influences = [];
      for (let k = 0; k < 4; k++) if (weights[i * 4 + k] > 0) influences.push([joints[i * 4 + k], weights[i * 4 + k]]);
      this.vertices[region].push({ p: [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]], influences });
    }
    this.floor = {};
    for (const region of Object.keys(this.vertices)) this.floor[region] = this.min(rig.restP, rig.restWQ, region) - this.tolerance;
    this.bodyRelativeFloor = bodyRelativeFloor;
  }

  /** Lowest skinned vertex y of a region for world joint transforms P / Q. */
  min(P, Q, region) {
    const cache = new Map();
    const matrix = k => {
      let m = cache.get(k);
      if (!m) {
        const joint = this.rig.joints[k];
        m = new Matrix4().compose(P[joint], Q[joint], new Vector3(1, 1, 1)).multiply(new Matrix4().fromArray(Array.from(this.inverse.subarray(k * 16, k * 16 + 16)))).elements;
        cache.set(k, m);
      }
      return m;
    };
    let lowest = Infinity;
    for (const { p, influences } of this.vertices[region]) {
      let y = 0;
      for (const [k, w] of influences) { const m = matrix(k); y += w * (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]); }
      if (y < lowest) lowest = y;
    }
    return lowest;
  }

  /** ctl with `degrees` of extra upward pitch on the region (tail: spread along the chain, head: neck and head halves). */
  lift(ctl, region, degrees) {
    if (region === 'tail') return { ...ctl, tailJoints: ctl.tailJoints.map(a => [a[0] + degrees / ctl.tailJoints.length, a[1], a[2]]) };
    return { ...ctl, neck: [ctl.neck[0] + degrees * 0.5, ctl.neck[1], ctl.neck[2]], head: [ctl.head[0] + degrees * 0.5, ctl.head[1], ctl.head[2]] };
  }

  /**
   * The floor a region's lowest vertex must stay above, in world height, for the given solve.
   *
   * With `bodyRelativeFloor` the reference is the body's own vertical travel: the solved Root's height against its rest height.
   * The rest floor was measured in the bind pose, where the Root sat at its rest height, so adding the Root's travel to it keeps
   * the floor at the height the region would occupy if the body had not moved. A gait that dips the body therefore no longer
   * reads as a floor violation, and a pose that really does push the head or tail into the ground still does. Without the option
   * the floor is the fixed rest height, as before.
   */
  floorFor(solved, region) {
    if (!this.bodyRelativeFloor) return this.floor[region];
    const root = this.rig.rootJoint;
    const travel = solved.P[root].y - this.rig.restP[root].y;
    return this.floor[region] + travel;
  }

  solve(ctl, clipName) {
    let current = ctl, solved = this.rig.solve(ctl);
    // Only the locomotion clips use the body-relative floor; every other clip (idle, jump, the attacks,
    // the roar, the reactions, the death and the entrances) keeps the absolute rest-height floor, so its
    // authored transform is untouched.
    const relative = this.bodyRelativeFloor && LOCOMOTION_FLOOR_CLIPS.has(clipName);
    for (const region of Object.keys(this.vertices)) {
      const ok = s => this.min(s.P, s.Q, region) >= (relative ? this.floorFor(s, region) : this.floor[region]);
      if (ok(solved)) continue;
      const trial = degrees => { const c = this.lift(current, region, degrees); return { c, s: this.rig.solve(c) }; };
      let lo = 0, hi = 70;
      if (ok(trial(hi).s)) for (let i = 0; i < 12; i++) { const mid = (lo + hi) / 2; if (ok(trial(mid).s)) hi = mid; else lo = mid; }
      const final = trial(hi);
      current = final.c; solved = final.s;
    }
    return solved;
  }
}

/** Scales a control set by a weight: every number is multiplied (arrays and objects recursively), so a gait can be blended in and out of another clip. */
function scaleCtl(ctl, weight) {
  if (typeof ctl === 'number') return ctl * weight;
  if (Array.isArray(ctl)) return ctl.map(value => scaleCtl(value, weight));
  return Object.fromEntries(Object.entries(ctl).map(([key, value]) => [key, scaleCtl(value, weight)]));
}

/** Adds two control sets: numbers add, arrays add element-wise (a missing entry counts as 0) and objects add key by key. */
function addCtl(a, b) {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (typeof a === 'number') return a + b;
  if (Array.isArray(a)) return Array.from({ length: Math.max(a.length, b.length) }, (_, i) => addCtl(a[i], b[i]));
  return Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(key => [key, addCtl(a[key], b[key])]));
}

/**
 * Blends two control sets: numbers interpolate (a missing number counts as 0), arrays element-wise, objects key by key. At k = 0 the result is
 * `a` and at k = 1 it is `b`, bit for bit. Flags (rigidLegs, plant) are not numbers: they are taken from `a` and set by the caller.
 */
function lerpCtl(a, b, k) {
  if (typeof a === 'number' || typeof b === 'number') return (a ?? 0) * (1 - k) + (b ?? 0) * k;
  if (Array.isArray(a) || Array.isArray(b)) return Array.from({ length: Math.max(a?.length ?? 0, b?.length ?? 0) }, (_, i) => lerpCtl(a?.[i], b?.[i], k));
  if (a && typeof a === 'object' || b && typeof b === 'object') {
    return Object.fromEntries([...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].map(key => [key, lerpCtl(a?.[key], b?.[key], k)]));
  }
  return a ?? b;
}

/** Normalized get-up time from which the pose is the idle clip's own solve (idle guard, no floor lift): the last frame only, so no leg changes fold at a hand-over. */
const GETUP_SETTLE = 0.99;

/** Controls of one frame (normalized authored time u) with the personality's neck gain and head bias applied. */
function frameControls(def, context, u) {
  const t = def.holdAt ? holdWarp(u, def.holdAt, context.hold) : u;
  const ctl = def.ctl(t, context);
  for (const part of ['neck', 'head', 'jaw']) if (ctl[part]) ctl[part] = ctl[part].map(v => v * context.neckGain);
  // Personality baseline: heavy animals carry the head lower in every clip.
  ctl.neck = [(ctl.neck?.[0] ?? 0) + context.headBias * 0.4, ctl.neck?.[1] ?? 0, ctl.neck?.[2] ?? 0];
  ctl.head = [(ctl.head?.[0] ?? 0) + context.headBias * 0.6, ctl.head?.[1] ?? 0, ctl.head?.[2] ?? 0];
  if (ctl.walkPhase !== undefined) ctl.legOverride = context.walk.sample(ctl.walkPhase);
  return ctl;
}

/**
 * A planted sole rolled with the body (or tilted by a folded leg) dips its own toes below the ground whatever the body's lift, because the feet stay on their
 * IK targets: raise each such leg's target by exactly the dip (two passes) so the soles rest ON the ground and only the body decides the lift.
 */
function liftSoles(solve, ctl, level, context) {
  let current = ctl;
  for (let pass = 0; pass < 3; pass++) {
    const s = solve(current), legs = { ...current.legs };
    let moved = false;
    for (const [key, lowest] of Object.entries(context.lowestLeg)) {
      const dip = level - lowest(s.P, s.Q);
      if (dip > 1e-7) { legs[key] = { ...legs[key], up: (legs[key]?.up ?? 0) + dip }; moved = true; }
    }
    if (!moved) break;
    current = { ...current, legs };
  }
  return current;
}

/**
 * Solves one frame. With def.floor the pose may never pass through the ground: the head and tail may rest on it (context.floorGuard pitches
 * them up by the smallest angle that keeps them out of it), and when any other part would sink the body is lifted by the smallest height that
 * restores contact (feet stay on their IK targets), so a collapse rests on the floor. A body whose Root carries ground-bound skin (rootFixed:
 * Ruun's chain links) is lifted through its Root's child joints (ctl.bodyUp), never the Root, and its death settles: every frame is lowered or
 * raised until the lowest skinned body vertex touches the rest ground exactly (the chain links stay on the ground).
 */
function solveFrameCore(rig, ctlIn, def, context, u = 0, clipName = '') {
  // The entrance's last tenth (and the get-up's, from GETUP_SETTLE) is the idle clip's own first frame: it uses the idle guard and no floor lift, so it ends on that pose exactly.
  const settling = (def === CLIPS['monster-spawn'] && u >= 0.9) || (def === CLIPS['monster-getup'] && u >= GETUP_SETTLE);
  // The knockdown and get-up rest on the ground to within 0.1% of the body height over every skinned vertex (head and tail included); the death / entrance may dip 1% below it.
  const onGround = def === CLIPS['monster-knockdown'] || def === CLIPS['monster-getup'];
  const guard = def.floor && !settling ? (onGround ? context.groundGuard : context.floorGuard) : context.guard;
  const solve = c => (guard ? guard.solve(c, clipName) : rig.solve(c));
  const settle = Boolean(context.rootFixed) && def === CLIPS['monster-death'];
  const level = settle ? context.groundY : def === CLIPS['monster-knockdown'] ? context.groundFine - context.groundSlack : def === CLIPS['monster-getup'] ? context.groundFine - context.groundSlack + context.idleDip * smoothstep((u - 0.6) / 0.3) : context.floorY;
  const ctl = onGround && def.floor && !settling ? liftSoles(solve, ctlIn, level, context) : ctlIn;
  const solved = solve(ctl);
  if (!def.floor || settling) return solved;
  // (the soles settle within 0.05% of the body height of their targets, so that much is not a reason to lift the whole body onto another window)
  const ok = s => (onGround ? context.lowestFine : context.lowest)(s.P, s.Q) >= level - (onGround ? 0.0005 * context.H : 0);
  if (!settle && ok(solved)) { if (onGround) context.lastLift = 0; return solved; }
  const lifted = d => solve(context.rootFixed ? { ...ctl, bodyUp: (ctl.bodyUp ?? 0) + d } : { ...ctl, rootUp: (ctl.rootUp ?? 0) + d });
  let lo = settle ? -2 * context.H : 0, hi = 2 * context.H;
  if (onGround) {
    // A body lifted past the reach of its planted legs pulls its feet under the ground again, so "clears the ground" is not monotonic in the lift
    // (a bisection over the whole range can land in either window and the body pops by a third of its height between frames). The lift is searched
    // outwards from the previous frame's for the nearest height that clears the ground (the first frame: from the authored height up), then walked
    // down to the lower edge of that window and bisected inside the last step only.
    const step = 0.02 * context.H, from = context.lastLift ?? 0, top = 2 * context.H;
    let found;
    for (let k = 0; found === undefined; k++) {
      const up = from + k * step, down = from - k * step;
      if (up > top && down < 0) throw new Error(`Floor guard cannot lift the ${def === CLIPS['monster-knockdown'] ? 'knockdown' : 'get-up'} pose clear of the ground at u=${u.toFixed(3)}`);
      if (up <= top && ok(lifted(up))) found = up;
      else if (k > 0 && down > 0 && ok(lifted(down))) found = down;
    }
    hi = found;
    for (lo = Math.max(0, found - step); lo > 0 && ok(lifted(lo)); lo = Math.max(0, lo - step)) hi = lo;
  } else if (!ok(lifted(hi))) {
    const top = lifted(hi);
    throw new Error(`Floor guard cannot lift the ${def === CLIPS['monster-death'] ? 'death' : 'spawn'} pose clear of the ground (lowest vertex ${(context.lowest(top.P, top.Q) - level).toFixed(4)} under the floor with the body raised ${hi.toFixed(3)})`);
  }
  for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (ok(lifted(mid))) hi = mid; else lo = mid; }
  if (onGround) context.lastLift = hi;
  return lifted(hi);
}

/**
 * The knockdown and get-up are solved frame after frame: each leg's knees start from where the previous frame left them (`warm`, relative to the leg's
 * root joint) so a deeply folded leg can never flip its fold between frames, and a frame whose controls equal the previous frame's (the held lie, and the
 * get-up's first frame after the knockdown's last) IS the previous frame's solve, bit for bit. The get-up's settle hands over to the idle's own solve.
 */
function solveFrame(rig, ctl, def, context, u = 0, clipName = '') {
  const onGround = def === CLIPS['monster-knockdown'] || def === CLIPS['monster-getup'];
  if (!onGround || (def === CLIPS['monster-getup'] && u >= GETUP_SETTLE)) return solveFrameCore(rig, ctl, def, context, u, clipName);
  if (def === CLIPS['monster-knockdown'] && u === 0) { context.warm = context.previous = undefined; context.lastLift = 0; }
  const key = JSON.stringify(ctl);
  if (context.previous?.key === key) return context.previous.solved;
  // Over the get-up's last stretch the knees start from the idle's own solved chain (weighted like the pose blend), so the hand-over to the idle's solve keeps every fold.
  const toIdle = def === CLIPS['monster-getup'] ? smoothstep((u - 0.7) / 0.3) : 0;
  const startOf = leg => toIdle > 0 ? context.warm[leg].map((offset, i) => offset.clone().lerp(context.idleChain[leg][i], toIdle)) : context.warm[leg];
  const warmed = context.warm ? { ...ctl, legs: Object.fromEntries(Object.entries(ctl.legs).map(([leg, spec]) => [leg, { ...spec, warm: startOf(leg) }])) } : ctl;
  const solved = solveFrameCore(rig, warmed, def, context, u, clipName);
  context.warm = Object.fromEntries(rig.legKeys.map(leg => [leg, rig.legs[leg].chain.slice(1, -1).map(joint => solved.P[joint].clone().sub(solved.P[rig.legs[leg].chain[0]]))]));
  context.previous = { key, solved };
  return solved;
}

function sampleClip(rig, name, def, context) {
  const frames = Math.round((context.seconds?.[name] ?? def.seconds) * FPS);
  const count = def.loop ? frames : frames + 1;
  const solved = Array.from({ length: count }, (_, f) => solveFrame(rig, frameControls(def, context, f / frames), def, context, f / frames, name));
  const poses = solved.map(s => ({ locals: s.locals, rootT: s.rootT, bodyUp: s.bodyUp, P: s.P, Q: s.Q, compensation: s.compensation }));
  if (def.loop) poses.push(poses[0]);
  return { name, def, frames, poses };
}

function measureClip(rig, clip, H, context) {
  const { poses, frames, def } = clip;
  const dt = 1 / FPS, tipOf = pose => rig.probe(pose, 'snout');
  const speed = [0];
  for (let f = 1; f < frames; f++) speed.push(tipOf(poses[f + 1]).distanceTo(tipOf(poses[f - 1])) / (2 * dt));
  speed.push(0);
  let strike = 0;
  speed.forEach((s, f) => { if (s > speed[strike]) strike = f; });
  const restTip = tipOf(poses[0]);
  let maxDisp = 0, dispFrame = 0;
  poses.forEach((pose, f) => { const d = tipOf(pose).distanceTo(restTip); if (d > maxDisp) { maxDisp = d; dispFrame = f; } });
  const rootRest = rig.restT[rig.rootJoint].y;
  const rootRises = poses.map(p => p.rootT.y - rootRest);
  const peakRoot = Math.max(...rootRises), peakFrame = rootRises.indexOf(peakRoot);
  const footDeviation = {};
  for (const key of rig.legKeys) {
    let max = 0, maxFrame = 0;
    poses.forEach((pose, f) => {
      for (const j of rig.legs[key].leaves) { const d = Math.abs(pose.P[j].y - rig.restP[j].y); if (d > max) { max = d; maxFrame = f; } }
    });
    footDeviation[key] = { maxBodyHeights: round(max / H, 4), atNormalizedTime: round(maxFrame / frames, 3) };
  }
  const metrics = {
    measuredStrikeTime: round(strike / frames, 3),
    peakHeadSpeedUnitsPerSecond: round(speed[strike], 3),
    peakHeadDisplacementTime: round(dispFrame / frames, 3),
    peakHeadDisplacementBodyHeights: round(maxDisp / H, 3),
    rootPeakBodyHeights: round(peakRoot / H, 4),
    rootPeakTime: round(peakFrame / frames, 3),
    rootMinBodyHeights: round(Math.min(...rootRises) / H, 4),
    footDeviation,
  };
  if (def.stampLeg) {
    const leg = rig.legs[def.stampLeg], lift = poses.map(p => Math.max(...leg.leaves.map(j => p.P[j].y - rig.restP[j].y)));
    const top = lift.indexOf(Math.max(...lift));
    let contact = top;
    while (contact < frames && lift[contact] > 0.004) contact++;
    metrics.stampLeg = def.stampLeg;
    metrics.stampLiftBodyHeights = round(Math.max(...lift) / H, 3);
    metrics.stampContactTime = round(contact / frames, 3);
  }
  if (def.loop) {
    const mean = poses.slice(0, frames).reduce((sum, p) => sum + rootRises[poses.indexOf(p)], 0) / frames;
    metrics.rootMeanRiseBodyHeights = round(mean / H, 4);
  }
  if (def.floor) {
    // Lowest skinned vertex relative to the rest floor (feet / belly), in body heights: negative = through the ground, positive = hovering.
    const lowest = poses.map(p => (context.lowest(p.P, p.Q) - context.groundY) / H);
    const last = poses.at(-1);
    let held = poses.length - 1;
    while (held > 0 && poses[held - 1].locals.every((q, i) => angleBetween(q, last.locals[i]) < 1e-5) && poses[held - 1].rootT.distanceTo(last.rootT) < 1e-6 && Math.abs((poses[held - 1].bodyUp ?? 0) - (last.bodyUp ?? 0)) < 1e-6) held--;
    metrics.floorContactBodyHeights = { lowestOverClip: round(Math.min(...lowest), 4), final: round(lowest.at(-1), 4) };
    metrics.heldFromTime = round(held / frames, 3);
    metrics.rootDropBodyHeights = round(-Math.min(...rootRises) / H, 4);
  }
  return metrics;
}

/**
 * Foot planting of an authored walk. For every leg the stance frames are those with the foot within 0.02 body heights of its rest sole
 * height; a planted foot moves backwards relative to the hips at exactly the body's ground speed, so the stance speed of the foot along the
 * body axis is the speed at which the clip plays without sliding. `maxSlidePercent` is the largest deviation from that constant speed.
 */
function measurePlanting(rig, clip, H) {
  const { poses, frames } = clip;
  const samples = [];
  const hipsOf = pose => pose.P[rig.hips];
  for (const key of rig.legKeys) {
    const leg = rig.legs[key], rel = poses.map(p => p.P[leg.foot].clone().sub(hipsOf(p)).dot(rig.F));
    const stance = poses.map(p => p.P[leg.foot].y - rig.restP[leg.foot].y < 0.002 * H);
    for (let f = 0; f < frames; f++) if (stance[f] && stance[f + 1]) samples.push({ key, f, speed: (rel[f + 1] - rel[f]) * FPS });
  }
  const planted = -samples.reduce((sum, s) => sum + s.speed, 0) / samples.length;
  const slide = samples.map(s => Math.abs(s.speed + planted) / planted);
  const stanceFraction = samples.length / (4 * frames);
  return {
    plantedSpeedUnitsPerSecond: round(planted, 4),
    strideUnits: round(planted * (frames / FPS) * stanceFraction, 4),
    stanceFraction: round(stanceFraction, 3),
    maxSlidePercent: round(100 * Math.max(...slide), 1),
    meanSlidePercent: round(100 * slide.reduce((a, b) => a + b, 0) / slide.length, 1),
  };
}

/** How far the last frame of the entrance clip is from the idle clip's first frame: largest joint rotation difference and Root offset. */
function idleMatch(rig, spawn, idle) {
  const a = spawn.poses.at(-1), b = idle.poses[0];
  return {
    maxJointDegrees: round(Math.max(...rig.joints.map(j => angleBetween(a.locals[j], b.locals[j]))) / DEG, 4),
    rootOffsetUnits: round(a.rootT.distanceTo(b.rootT), 6),
  };
}

/** Mean world yaw of the hips about the up axis over a loop; must be ~0 for the turn clip. */
function meanYawDegrees(rig, clip) {
  let sum = 0;
  const rest = rig.restWQ[rig.hips];
  for (let f = 0; f < clip.frames; f++) {
    const delta = clip.poses[f].Q[rig.hips].clone().multiply(rest.clone().invert());
    const forward = rig.F.clone().applyQuaternion(delta);
    sum += Math.atan2(forward.dot(rig.L), forward.dot(rig.F)) / DEG;
  }
  return sum / clip.frames;
}

// ---------------------------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------------------------
function encodeClips(source, rig, clips, bodyJoints = []) {
  const json = structuredClone(source.json);
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
  const addAccessor = (view, byteOffset, count, type, extra = {}) => {
    json.accessors.push({ bufferView: view, byteOffset, componentType: 5126, count, type, ...extra });
    return json.accessors.length - 1;
  };
  for (const clip of clips) {
    if (json.animations.some(a => a.name === clip.name)) throw new Error(`Duplicate clip ${clip.name}`);
    const count = clip.frames + 1;
    const times = new Float32Array(count).map((_, f) => f / FPS);
    const input = addAccessor(addView(times), 0, count, 'SCALAR', { min: [times[0]], max: [times[count - 1]] });
    const channels = [], samplers = [];
    const track = (node, path, floats, type) => {
      const view = addView(floats);
      samplers.push({ input, output: addAccessor(view, 0, count, type), interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node, path } });
    };
    track(rig.rootJoint, 'translation', Float32Array.from(clip.poses.flatMap(p => [p.rootT.x, p.rootT.y, p.rootT.z])), 'VEC3');
    for (const joint of bodyJoints) {
      track(joint, 'translation', Float32Array.from(clip.poses.flatMap(p => {
        const t = rig.restT[joint].clone().add(new Vector3(0, p.bodyUp ?? 0, 0).applyQuaternion(p.Q[rig.rootJoint].clone().invert()));
        return [t.x, t.y, t.z];
      })), 'VEC3');
    }
    for (const joint of rig.joints) {
      const values = new Float32Array(count * 4);
      let previous;
      clip.poses.forEach((pose, f) => {
        let q = pose.locals[joint].clone().normalize();
        if (f === count - 1 && clip.def.loop) q = new Quaternion(values[0], values[1], values[2], values[3]);
        else if (previous && previous.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
        values.set([q.x, q.y, q.z, q.w], f * 4);
        previous = q;
      });
      track(joint, 'rotation', values, 'VEC4');
    }
    json.animations.push({ name: clip.name, channels, samplers });
  }
  json.buffers = [{ byteLength: length }];
  return encodeGlb(json, Buffer.concat(pieces, length));
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------
export function author(assetId, { write = true } = {}) {
  const dir = resolve(ROOT, 'asset-source/generated', `${assetId}-runtime-01`);
  const inputPath = join(dir, `${assetId}.glb`);
  if (!existsSync(inputPath)) throw new Error(`Missing input ${inputPath}`);
  const inputBytes = readFileSync(inputPath);
  const source = parseGlb(inputBytes);
  const personality = PERSONALITIES[assetId] ?? NEUTRAL;
  const authored = source.json.animations?.filter(a => [...REQUIRED_CLIPS, TAIL_CLIP, ...(personality.extraClips ?? [])].includes(a.name));
  if (authored?.length) throw new Error(`Input already contains authored clips: ${authored.map(a => a.name).join(', ')}`);
  const rig = new QuadrupedRig(source.json, personality.rigOptions);
  const position = source.json.accessors[source.json.meshes[0].primitives[0].attributes.POSITION];
  rig.defineProbes(position.min, position.max, rig.axisAligned ? undefined : readAccessor(source.json, source.bin, source.json.meshes[0].primitives[0].attributes.POSITION));
  const H = position.max[1] - position.min[1];
  const bodyLength = rig.axisAligned ? (rig.F.z !== 0 ? position.max[2] - position.min[2] : position.max[0] - position.min[0]) : rig.probe({ P: rig.restP, Q: rig.restWQ }, 'snout').sub(rig.probe({ P: rig.restP, Q: rig.restWQ }, 'tailTip')).dot(rig.F);
  const walk = readWalk(rig, source.json, source.bin, personality);
  const restSnout = rig.probe({ P: rig.restP, Q: rig.restWQ }, 'snout');
  const neckReach = restSnout.distanceTo(rig.restP[rig.neck[0] ?? rig.head[0]]);
  /** How a tail whip is split between yaw (tails that extend backwards) and roll about the body axis (tails that hang down), and which roll sign swings the tip to the body-left. */
  const tailAxes = (() => {
    if (rig.tail.length < 2) return { yaw: 1, roll: 0, rollSign: 1 };
    const d = rig.restP[rig.tailTip].clone().sub(rig.restP[rig.tail[0]]);
    const down = clamp(Math.abs(d.y) / d.length(), 0, 1);
    const probe = rig.solve({ tailJoints: rig.tail.map(() => [0, 0, 10]), plant: false });
    return { yaw: Math.sqrt(1 - down * down), roll: down, rollSign: probe.P[rig.tailTip].clone().sub(rig.restP[rig.tailTip]).dot(rig.L) >= 0 ? 1 : -1 };
  })();
  const context = {
    tailAxes,
    rig, H, walk, yawSpine: Math.min(personality.spine, 1.2),
    // Short-necked rigs need larger head angles for the same visible snout travel.
    neckGain: clamp(0.35 / neckReach, 0.9, 1.7),
    tailPitch: Math.min(personality.tail, 1.1),
    // Strike / body-swing / tail-whip gains default to the neutral animal; personalities override them.
    strike: 1, swing: 1, whip: clamp(personality.tail ?? 1, 0.9, 1.5),
    ...personality,
  };
  // The locomotion guard measures the head and tail against their REST height, so a rig whose head hangs low over the ground needs the
  // body-relative floor (see the GroundGuard class comment): otherwise the walk / run dip reads as a floor violation.
  if (personality.groundGuard) context.guard = new GroundGuard(rig, source.json, source.bin, H, personality.bodyRelativeFloor === true);
  // Floor contact of the one-shot collapse / entrance poses: the rest pose's lowest skinned vertex (feet and belly) is the ground level,
  // and a pose may dip 1% of the body height below it (idle leans and sole rotations dip a toe a hair under the rest sole).
  // Skin weights as they ship: Ruun's ground-anchored chain pieces are bound to the Root alone (cleanWeights) and are ignored as ground attachments.
  const skinBin = personality.cleanWeights ? Buffer.from(source.bin) : source.bin;
  if (personality.cleanWeights) cleanStraySkinWeights(rig, structuredClone(source.json), skinBin, personality.cleanWeights);
  context.lowest = makeLowestSampler(source.json, skinBin, rig.joints, 2, [rig.rootJoint]);
  context.groundY = context.lowest(rig.restP, rig.restWQ);
  context.floorY = context.groundY - 0.01 * H;
  // Head and tail may lie on the ground, so their guard floor is the ground level rather than their rest height.
  context.floorGuard = new GroundGuard(rig, source.json, source.bin, H);
  context.floorGuard.floor = { tail: context.floorY, head: context.floorY };
  context.groundGuard = new GroundGuard(rig, source.json, source.bin, H);
  context.groundSlack = (personality.groundSlack ?? 0.001) * H;
  // The knockdown / get-up are floor-checked on EVERY skinned vertex (the death's stride-2 sample misses toe tips): the ground is the rest pose's lowest vertex.
  context.lowestFine = makeLowestSampler(source.json, skinBin, rig.joints, 1, [rig.rootJoint]);
  context.lowestLeg = Object.fromEntries(rig.legKeys.map(key => {
    const leaves = new Set(rig.legs[key].leaves);
    return [key, makeLowestSampler(source.json, skinBin, rig.joints, 1, rig.joints.filter(joint => !leaves.has(joint)))];
  }));
  context.groundFine = context.lowestFine(rig.restP, rig.restWQ);
  context.groundGuard.floor = { tail: context.groundFine - context.groundSlack, head: context.groundFine - context.groundSlack };
  context.deathSide ??= 1;
  // A crouched idle (the toad's) can rest a little below the rest ground: the get-up's floor follows it down while the pose blends into the idle.
  const idle0 = solveFrame(rig, frameControls(CLIPS['monster-idle'], context, 0), CLIPS['monster-idle'], context, 0);
  context.idleDip = Math.min(0, context.lowestFine(idle0.P, idle0.Q) - context.groundFine);
  context.idleChain = Object.fromEntries(rig.legKeys.map(leg => [leg, rig.legs[leg].chain.slice(1, -1).map(joint => idle0.P[joint].clone().sub(idle0.P[rig.legs[leg].chain[0]]))]));
  const clips = [...REQUIRED_CLIPS, ...(personality.authoredWalk ? ['monster-walk'] : []), ...(rig.tail.length >= 2 ? [TAIL_CLIP] : []), ...(personality.extraClips ?? [])].map(name => sampleClip(rig, name, CLIPS[name], context));
  // Rigs whose Root carries ground-bound skin (rootFixed) lower the body through the Root's child joints: those joints get translation tracks in every clip.
  const outputBytes = encodeClips(source, rig, clips, personality.rootFixed ? rig.bodyJoints : []);
  // Optional skin cleanup (personality.cleanWeights): rewrites weights in place inside the encoded GLB's binary chunk.
  let skinCleanup;
  if (personality.cleanWeights) {
    const encoded = parseGlb(outputBytes);
    skinCleanup = cleanStraySkinWeights(rig, encoded.json, encoded.bin, personality.cleanWeights);
  }
  const outputPath = join(dir, `${assetId}-animated.glb`);
  const report = {
    schemaVersion: 1,
    assetId,
    generator: 'scripts/assets/author-quadruped-clips.mjs',
    input: { path: `asset-source/generated/${assetId}-runtime-01/${assetId}.glb`, sha256: sha256(inputBytes), bytes: inputBytes.length },
    output: { path: `asset-source/generated/${assetId}-runtime-01/${assetId}-animated.glb`, sha256: sha256(outputBytes), bytes: outputBytes.length },
    headAxis: rig.headAxis,
    suggestedCoordinateTransformForward: { x: rig.F.x, y: 0, z: rig.F.z },
    body: {
      heightUnits: round(H), lengthUnits: round(bodyLength),
      boundsMin: position.min.map(v => round(v)), boundsMax: position.max.map(v => round(v)),
    },
    fps: FPS,
    ...(skinCleanup ? { skinCleanup } : {}),
    personality: { id: PERSONALITIES[assetId] ? assetId : 'neutral', ...personality },
    rig: {
      root: rig.nodes[rig.rootJoint].name, hips: rig.nodes[rig.hips].name,
      torso: rig.torso.map(j => rig.nodes[j].name), neck: rig.neck.map(j => rig.nodes[j].name), head: rig.head.map(j => rig.nodes[j].name),
      tail: rig.tail.map(j => rig.nodes[j].name),
      legs: Object.fromEntries(rig.legKeys.map(k => [k, rig.legs[k].chain.map(j => rig.nodes[j].name)])),
      headTipJoint: rig.nodes[rig.headTip].name,
      probes: Object.fromEntries(Object.entries(rig.probes).map(([name, p]) => [name, { joint: rig.nodes[p.joint].name, localOffset: p.local.toArray().map(v => round(v, 5)) }])),
    },
    walkClip: { preserved: true, name: 'preset:quadruped:walk', periodFrames: walk.period, ...(personality.authoredWalk ? { replacedBy: 'monster-walk', note: 'The raw Tripo preset stays in the GLB for provenance; the manifest binds monster-walk to the authored ikGait clip.' } : {}) },
    clips: {},
  };
  for (const clip of clips) {
    const metrics = measureClip(rig, clip, H, context);
    if (clip.name === 'monster-turn') metrics.meanBodyYawDegrees = round(meanYawDegrees(rig, clip), 4);
    if (clip.name === 'monster-walk' && !personality.ikGait.walk.hop) metrics.planting = measurePlanting(rig, clip, H);
    if (clip.name === 'monster-run' && personality.ikGait?.run && !personality.ikGait.run.hop) metrics.planting = measurePlanting(rig, clip, H);
    if (clip.name === 'monster-spawn' || clip.name === 'monster-getup') metrics.idleMatch = idleMatch(rig, clip, clips.find(other => other.name === 'monster-idle'));
    report.clips[clip.name] = {
      durationSeconds: round(clip.frames / FPS, 4), frames: clip.frames + 1, loop: clip.def.loop,
      semanticKeyTimes: clip.def.keyTimes ?? {},
      ...(clip.def.attackWindow ? { attackWindow: {
        normalized: clip.def.attackWindow,
        seconds: clip.def.attackWindow.map(u => round(u * clip.frames / FPS, 4)),
        note: '[anticipation end, active start, active end, recovery end]',
      } } : {}),
      measured: metrics,
    };
  }
  if (write) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(outputPath, outputBytes);
    writeFileSync(join(dir, 'clips-report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  return { report, rig, clips, outputBytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const assetId = process.argv[2];
  if (!assetId) { console.error('Usage: author-quadruped-clips.mjs <asset-id>'); process.exit(2); }
  const { report } = author(assetId);
  console.log(JSON.stringify({
    asset: assetId, output: report.output, headAxis: report.headAxis,
    clips: Object.fromEntries(Object.entries(report.clips).map(([name, clip]) => [name, `${clip.durationSeconds}s`])),
  }, null, 2));
}
