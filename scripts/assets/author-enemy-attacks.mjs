#!/usr/bin/env bun
// Offline native conditioning only. Simulation remains the sole movement, collision and damage authority.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Quaternion, Vector3 } from 'three';
import { BodyFrame, FPS, PoseBuilder, Rig, blendLocals, curve, encodeClips, encodeGlb, makeLowestSampler, parseGlb, readAnimation, smoothstep, solveHingedTwoBone } from './creature-rig-kit.mjs';
import { creatureRigContext } from './author-creature-clips.mjs';
import { airborneAttack, bipedAttackPose, cartwheelAttackPose, elapsedAttackSeconds, quadAttackPose, serpentAttackPose } from './enemy-attack-poses.mjs';
import { ATTACKS } from '../../src/game/combat/content.ts';
import { quadrupedRigContext } from './author-quadruped-clips.mjs';
import { MONSTER_HOVER } from '../../src/rendering/MonsterAnimationProfiles.ts';
import { bindNativeEnemyAttacks } from './playtest-manifest-kit.mjs';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const CATALOG_PATH = 'src/content/enemy-attack-presentation.json';
const SOURCE_PATH = 'asset-source/animation/enemy-attack-sources.json';
const MAPS = ['greenwake', 'canopy', 'grove', 'moonpine', 'mistveil', 'bamboo', 'later'];
const PHASES = ['windup', 'commit', 'active', 'recovery'];
const FRAMES = 120;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));
const round = value => Number(value.toFixed(7));
const clamp = x => Math.max(0, Math.min(1, x));
const ease = (kind, t) => kind === 'in' ? t * t : kind === 'out' ? 1 - (1 - t) ** 2 : kind === 'inOut' ? smoothstep(t) : t;
const list = x => x === undefined ? [] : Array.isArray(x) ? x : [x];
const actionKey = id => `wild-crown:${id}`;

/** Exact world-space rotation increments over a sampled pose, with parent motion inherited once. */
function overlay(rig, pose, increments) {
  const base = rig.world(pose).Q, world = [];
  for (const joint of rig.order) {
    const parent = rig.parent[joint], inc = increments.get(joint);
    const delta = parent < 0 ? new Quaternion() : world[parent].clone().multiply(base[parent].clone().invert());
    const target = (inc ? inc.clone().multiply(delta) : delta).multiply(base[joint]);
    pose.Q[joint] = parent < 0 ? target : world[parent].clone().invert().multiply(target).normalize();
    world[joint] = target;
  }
  return pose;
}

function anatomy(assetId, source, family, rig) {
  const position = source.json.accessors[source.json.meshes[0].primitives[0].attributes.POSITION];
  const H = position.max[1] - position.min[1];
  if (!(H > 0)) throw new Error(`${assetId}: invalid native mesh height`);
  if (family === 'quadruped') {
    const quad = quadrupedRigContext(assetId, source.json);
    // A lateral shoulder/hip girdle is not a freely folding limb hinge.
    // Keep that native offset rigid; otherwise planar FABRIK can fold the body's width into the knee plane.
    for (const key of quad.legKeys) {
      const leg = quad.legs[key];
      while (leg.chain.length > 3) {
        const segment = quad.restP[leg.chain[1]].clone().sub(quad.restP[leg.chain[0]]);
        if (Math.abs(segment.dot(quad.L)) < segment.length() * .6) break;
        leg.chain = leg.chain.slice(1); leg.lengths = leg.lengths.slice(1);
      }
    }
    return { rig, quad, H, body: new BodyFrame(quad.F), hip: quad.hips, torso: [...quad.torso, ...quad.chest], neck: quad.neck, head: quad.head,
      tail: quad.tail, hands: { L: quad.legs.FL.chain, R: quad.legs.FR.chain }, feet: { L: quad.legs.HL.chain, R: quad.legs.HR.chain }, root: quad.rootJoint };
  }
  const ctx = creatureRigContext(assetId, rig);
  ctx.lift = 0;
  ctx.preserveHingeFrame = true;
  return { rig, ctx, H, body: ctx.body, hip: ctx.hipsJoint, torso: [...list(ctx.waist), ...list(ctx.spine)], neck: list(ctx.neckChain ?? ctx.neck ?? ctx.neckBase),
    head: list(ctx.head), tail: list(ctx.tail ?? (family === 'serpentine' ? ctx.spine : undefined)), hands: ctx.arm ?? ctx.wing,
    feet: ctx.leg, wings: ctx.wing, root: ctx.rootJoint };
}

function solvedQuad(a, ctl) {
  const q = a.quad, legOverride = {};
  for (const key of q.legKeys) {
    const leg = q.legs[key];
    legOverride[key] = { rel0: q.restWQ[leg.reference].clone().invert().multiply(q.restWQ[leg.chain[0]]), locals: leg.chain.slice(1).map(joint => q.restQ[joint].clone()) };
  }
  const solved = q.solve({ ...ctl, plant: false, rigidLegs: false, legOverride }), pose = a.rig.restLocals();
  for (const joint of a.rig.joints) pose.Q[joint] = solved.locals[joint].clone();
  pose.T[a.quad.rootJoint] = solved.rootT.clone();
  if (solved.bodyUp) {
    for (const joint of a.quad.bodyJoints) {
      const parentQ = solved.Q[a.quad.parent[joint]];
      pose.T[joint].add(new Vector3(0, solved.bodyUp, 0).applyQuaternion(parentQ.clone().invert()));
    }
  }
  const world = a.rig.world(pose), carried = world.Q[q.hips].clone().multiply(q.restWQ[q.hips].clone().invert());
  for (const key of q.legKeys) {
    const leg = q.legs[key], spec = ctl.legs?.[key] ?? {}, [upper, lower, wrist] = leg.chain;
    // Only the native upper/lower limb fold. The wrist/hock and distal paw retain their native rigid shape.
    const flight = ctl.flightWeight ?? (ctl.rigidLegs ? 1 : 0);
    const footRotation = new Quaternion().slerp(carried, flight).multiply(spec.foot ? q.body(spec.foot) : new Quaternion());
    const target = q.restP[leg.foot].clone();
    if (flight) target.lerp(q.restP[leg.foot].clone().sub(q.restP[q.hips]).applyQuaternion(carried).add(world.P[q.hips]), flight);
    const reach = leg.lengths[0] + leg.lengths[1], liftLimit = Math.max(0, q.restP[upper].y - q.restP[wrist].y) * .65;
    target.addScaledVector(q.F, Math.max(-reach * .7, Math.min(reach * .7, spec.fwd ?? 0)))
      .addScaledVector(q.U, Math.min(liftLimit, spec.up ?? 0)).addScaledVector(q.L, spec.left ?? 0);
    const offset = q.restP[leg.foot].clone().sub(q.restP[wrist]).applyQuaternion(footRotation);
    const wristQ = footRotation.multiply(q.restWQ[wrist]);
    const nativeAxis = world.P[wrist].clone().sub(world.P[upper]).normalize();
    const pole = world.P[lower].clone().sub(world.P[upper]); pole.addScaledVector(nativeAxis, -pole.dot(nativeAxis));
    const reached = solveHingedTwoBone(world.P[upper], world.P[lower], world.P[wrist], target.sub(offset), pole, world.Q[upper], world.Q[lower]);
    pose.Q[upper] = world.Q[a.rig.parent[upper]].clone().invert().multiply(reached.upper);
    const lowerParent = reached.upper.clone().multiply(world.Q[upper].clone().invert()).multiply(world.Q[a.rig.parent[lower]]);
    pose.Q[lower] = lowerParent.invert().multiply(reached.lower);
    const wristParent = reached.lower.clone().multiply(world.Q[lower].clone().invert()).multiply(world.Q[a.rig.parent[wrist]]);
    pose.Q[wrist] = wristParent.invert().multiply(wristQ);
  }
  return pose;
}

/** Authored crown invocations have different limbs, levels and silhouettes, not five renamed roars. */
function crownPose(a, motion, u) {
  if (!a.quad) return undefined;
  const c = keys => curve(keys, u), H = a.H;
  const gather = c([[0, 0], [.22, 1], [.35, 1], [.5, .75], [.75, .55], [1, 0]]);
  const release = c([[0, 0], [.33, 0], [.5, 1, 'in'], [.59, .7], [.78, .3], [1, 0]]);
  const ctl = { bodyUp: -H * .035 * gather, torso: [-4 * gather, 0, 0], head: [6 * gather, 0, 0] };
  switch (motion) {
    case 'sky-invocation':
      Object.assign(ctl, { bodyUp: -H * .025 * gather, torso: [12 * gather, -5 * gather, 0], neck: [15 * gather, 0, 0], head: [20 * gather, 8 * release, 0],
        legs: { FL: { up: H * .12 * gather, fwd: H * .08 * gather }, FR: { up: H * .09 * gather, fwd: H * .1 * gather } }, tail: [10 * gather, -12 * gather, 0] });
      break;
    case 'pack-stamp': {
      const lift = c([[0, 0], [.25, .23], [.35, .27], [.5, 0, 'in'], [.58, 0], [.76, .04], [1, 0]]);
      Object.assign(ctl, { torso: [4 * gather - 12 * release, 9 * gather - 14 * release, 3 * gather], head: [-6 * release, -12 * gather, 0],
        legs: { FR: { up: H * lift, fwd: H * .14 * gather, left: -H * .03 * gather } }, tail: [0, -18 * gather, 0] });
      break;
    }
    case 'shadow-coil':
      Object.assign(ctl, { bodyUp: -H * .085 * gather, torso: [-9 * gather, 18 * gather - 28 * release, -5 * gather], neck: [-5 * gather, -18 * gather + 25 * release, 0],
        head: [0, -15 * gather + 23 * release, 0], tail: [4 * gather, -42 * gather + 55 * release, 8 * gather],
        legs: { FL: { left: H * .035 * gather }, HR: { left: -H * .035 * gather } } });
      break;
    case 'crown-roar':
      Object.assign(ctl, { bodyUp: -H * .025 * gather, torso: [7 * gather, 0, 0], neck: [18 * gather, 0, 0], head: [22 * gather - 12 * release, 0, 0],
        jaw: [15 * release, 0, 0], legs: { FL: { fwd: H * .06 * gather }, FR: { fwd: H * .06 * gather } }, tail: [8 * gather, 7 * release, 0] });
      break;
    case 'possession-grasp':
      Object.assign(ctl, { torso: [3 * gather, -10 * gather, -4 * gather], neck: [3 * gather, 12 * gather, 0], head: [-7 * release, 8 * release, 0],
        legs: { FR: { up: H * .22 * gather, fwd: H * (.12 * gather + .12 * release), left: -H * .03 * gather } }, tail: [3 * gather, 18 * gather, 0] });
      break;
    case 'root-rend':
    case 'root-rend-heavy': {
      const heavy = motion === 'root-rend-heavy' ? 1.25 : .8;
      const lift = c([[0, 0], [.25, .16], [.35, .2], [.5, 0, 'in'], [.6, 0], [1, 0]]) * heavy;
      Object.assign(ctl, { bodyUp: -H * .055 * release, torso: [6 * gather - 13 * release, 0, 0], neck: [-7 * release, 0, 0],
        legs: { FL: { up: H * lift, fwd: H * .08 * gather }, FR: { up: H * lift * .9, fwd: H * .09 * gather } }, tail: [8 * gather, 0, 0] });
      break;
    }
    default: return undefined;
  }
  return solvedQuad(a, ctl);
}

function bipedGesture(a, motion, u) {
  const ctx = a.ctx;
  if (!ctx?.arm || !['possession-grasp', 'canopy-shake'].includes(motion)) return undefined;
  const gate = smoothstep(u / .12) * smoothstep((1 - u) / .22);
  const pb = new PoseBuilder(a.rig, true), H = a.H;
  for (const side of ['L', 'R']) {
    const [upper, lower, hand] = ctx.arm[side];
    if (motion === 'possession-grasp' && side === 'L') continue;
    const other = side === 'L' ? 1 : -1;
    const raised = motion === 'canopy-shake' ? .48 + .08 * Math.sin((u - .35) * Math.PI * 8 + other) : .18;
    const target = a.body.at(a.rig.restP[hand], H * (.36 * gate), H * raised * gate, H * .08 * other * gate);
    pb.reach(upper, lower, hand, target, a.body.at(new Vector3(), -.3, -.4, other * .7));
  }
  for (const joint of a.torso) pb.rotate(joint, a.body.pitch(-6 * gate / a.torso.length));
  return pb.solve();
}

function sourcePose(rig, clips, plan, ends, u) {
  let phase = ends.findIndex(end => u < end);
  if (phase < 0) phase = 3;
  const start = phase ? ends[phase - 1] : 0, t = clamp((u - start) / (ends[phase] - start));
  const sample = (step, progress) => {
    const clip = clips.get(step.action);
    if (!clip) throw new Error(`Missing actual native source clip for ${step.action}`);
    const normalized = 'loopRate' in step
      ? (progress * (step.loopRate + ((step.toLoopRate ?? step.loopRate) - step.loopRate) * progress * .5)) % 1
      : step.from + (step.to - step.from) * ease(step.ease, progress);
    return clip.sample(clamp(normalized) * clip.duration);
  };
  let pose = sample(plan[PHASES[phase]], t);
  // Bridge different source actions BEFORE the boundary; the damaging pose is already complete on contact.
  if (phase < 3 && plan[PHASES[phase]].action !== plan[PHASES[phase + 1]].action) {
    const bridge = Math.min(.055, (ends[phase] - start) * .35), w = smoothstep((u - ends[phase] + bridge) / bridge);
    if (w > 0) pose = blendLocals(rig, pose, sample(plan[PHASES[phase + 1]], 0), w);
  }
  return pose;
}

function articulatedPose(a, spec, sampleSource, u, clips) {
  const crown = crownPose(a, spec.motion, u);
  if (crown) return crown;
  if (a.quad) return quadAttackPose(a, spec, u, solvedQuad);
  const anatomical = cartwheelAttackPose(a, spec, u) ?? serpentAttackPose(a, spec, u) ?? bipedAttackPose(a, spec, u);
  if (anatomical) return anatomical;
  let base = sampleSource();
  const gesture = bipedGesture(a, spec.motion, u);
  if (gesture) return blendLocals(a.rig, base, gesture, smoothstep(u / .12) * smoothstep((1 - u) / .2));
  if (spec.motion === 'staff-combo') {
    let t;
    if (u < .35) t = .3 * smoothstep(u / .35);
    else if (u < .5) t = .3 + .15 * ((u - .35) / .15) ** 2;
    else if (u < .75) {
      const stroke = (u - .5) / .25 * 3;
      t = stroke < 2 ? curve([[0, .45], [.4, .78], [.7, .2], [1, .45, 'in']], stroke % 1) : .45 + .45 * smoothstep(stroke - 2);
    } else t = .9 + .1 * smoothstep((u - .75) / .25);
    base = clips.get('monster-slash').sample(t * clips.get('monster-slash').duration);
  }
  const load = curve([[0, 0], [.27, 1], [.35, .8], [.5, -.4, 'in'], [.7, -.15], [1, 0]], u);
  const follow = curve([[0, 0], [.35, 0], [.5, 1, 'in'], [.7, .45], [1, 0]], u);
  const inc = new Map(), add = (joint, angles) => {
    if (joint === undefined) return;
    const q = a.body.euler(angles);
    inc.set(joint, inc.has(joint) ? q.multiply(inc.get(joint)) : q);
  };
  const spread = (chain, angles) => chain.forEach(j => add(j, angles.map(v => v / chain.length)));
  if (/charge|rush|pounce|lunge/.test(spec.motion)) {
    spread(a.torso, [-5 * load - 3 * follow, 0, spec.motion === 'side-charge' ? 7 * load : 0]);
    spread(a.neck, [4 * load - 3 * follow, spec.motion === 'flank-pounce' ? 9 * load : 0, 0]);
  } else if (/sweep|scythe|lash|rake|thrash|claw/.test(spec.motion)) {
    const sign = spec.socket === 'paw-left' || spec.socket === 'hand-left' ? -1 : 1;
    spread(a.torso, [-2 * follow, sign * (8 * load - 11 * follow), 0]);
    spread(a.head, [0, -sign * 5 * load, 0]);
    if (/tail/.test(spec.motion)) spread(a.tail, [0, 14 * load - 20 * follow, 0]);
  } else if (/breath|exhale|spit|tongue/.test(spec.motion)) {
    spread(a.neck, [6 * load - 8 * follow, 0, 0]);
    spread(a.head, [-3 * load + 5 * follow, 0, 0]);
  } else if (/roar|howl|call|flare|heartlight/.test(spec.motion)) {
    spread(a.torso, [3 * load, 0, 0]);
    spread(a.neck, [7 * load + 5 * follow, 0, 0]);
    spread(a.head, [4 * follow, /low-howl/.test(spec.motion) ? -7 * follow : 0, 0]);
  } else if (/slam|smash|stamp|tap|pulse|snap/.test(spec.motion)) {
    spread(a.torso, [6 * load - 8 * follow, 0, 0]);
    spread(a.neck, [4 * load - 5 * follow, 0, 0]);
  } else if (/hurl|throw|toss|lob|scatter|release|volley|tether|cast|thrust/.test(spec.motion)) {
    spread(a.torso, [3 * load - 5 * follow, 5 * load - 8 * follow, 0]);
    spread(a.head, [0, -4 * load, 0]);
  }
  return overlay(a.rig, base, inc);
}

function anchors(a) {
  const name = j => { if (j === undefined) throw new Error('Missing required anatomical anchor'); return a.rig.nodes[j].name; };
  const pair = chain => { if (!chain?.length) return undefined; return { base: name(chain[Math.max(0, chain.length - 2)]), tip: name(chain.at(-1)) }; };
  const limb = key => {
    const leg = a.quad.legs[key], ankle = leg.chain.at(-1);
    const tip = leg.leaves.reduce((best, j) => a.rig.restP[j].distanceToSquared(a.rig.restP[ankle]) > a.rig.restP[best].distanceToSquared(a.rig.restP[ankle]) ? j : best, ankle);
    return tip === ankle ? leg.chain : [...leg.chain, tip];
  };
  const head = pair([...a.neck, ...a.head]);
  const body = pair([a.hip, ...a.torso]);
  const left = pair(a.quad ? limb('FL') : a.hands?.L ?? a.feet?.L), right = pair(a.quad ? limb('FR') : a.hands?.R ?? a.feet?.R);
  const feet = pair(a.quad ? limb('HR') : a.feet?.R ?? a.hands?.R);
  const result = { head, mouth: head, crown: head, chest: body, shoulders: body, tail: pair(a.tail),
    'hand-left': left, 'hand-right': right, 'paw-left': left, 'paw-right': right, paws: right, hands: right, feet, wings: pair(a.wings?.R),
    'weapon-tip': right, 'weapon-edge': right };
  for (const [key, value] of Object.entries(result)) if (!value) delete result[key];
  return result;
}

export function authorEnemy(assetId, { write = true } = {}) {
  const catalog = json(CATALOG_PATH), sources = json(SOURCE_PATH), record = sources.nativeSources[assetId];
  if (!record) throw new Error(`No immutable native source for ${assetId}`);
  const input = readFileSync(resolve(ROOT, '.' + record.runtimeUrl));
  if (hash(input) !== record.sha256) throw new Error(`${assetId}: immutable source SHA mismatch`);
  const source = parseGlb(input), rig = new Rig(source.json), a = anatomy(assetId, source, record.rigFamily, rig);
  a.family = record.rigFamily;
  const mapping = {};
  for (const map of MAPS) for (const entry of json(`asset-source/playtests/${map}.json`)) {
    if (entry.id === assetId) Object.assign(mapping, entry.actionToClipMapping);
  }
  const clips = new Map();
  for (const clip of source.json.animations ?? []) clips.set(clip.name, readAnimation(rig, source.bin, clip.name));
  for (const [key, clipName] of Object.entries(mapping)) if (clips.has(clipName)) clips.set(key, clips.get(clipName));
  const idle = clips.get('monster-idle')?.sample(0);
  if (!idle) throw new Error(`${assetId}: no native idle boundary pose`);
  const lowest = makeLowestSampler(source.json, source.bin, rig.joints, 1);
  const idleWorld = rig.world(idle), floor = lowest(idleWorld.P, idleWorld.Q);
  const translationJoints = new Set([rig.rootJoint, ...(a.quad?.bodyJoints ?? []), ...(a.ctx?.translationJoints ?? [])]);
  for (const animation of source.json.animations ?? []) for (const channel of animation.channels) if (channel.target.path === 'translation') translationJoints.add(channel.target.node);
  const authored = [], slots = {}, anchorTable = anchors(a);
  for (const [id, spec] of Object.entries(catalog.attacks)) {
    if (!spec.assets.includes(assetId)) continue;
    if (!anchorTable[spec.socket]) throw new Error(`${assetId}/${id}: missing actual ${spec.socket} anchor`);
    const plan = sources.assetSourceOverrides[assetId]?.[id] ?? sources.phaseSources[id];
    if (!plan) throw new Error(`${id}: no source choreography`);
    for (const phase of PHASES) if (!clips.has(plan[phase].action)) throw new Error(`${assetId}/${id}: missing ${phase} source ${plan[phase].action}`);
    a.elapsed = u => elapsedAttackSeconds(ATTACKS[id], catalog.phaseEnds, u);
    const poses = [], metrics = { maxRootHorizontalDrift: 0, maxJointStepDegrees: 0, maxFloorCorrection: 0, lowestSkinnedHeight: Infinity, maxNonBaseTranslationDelta: 0 };
    for (let frame = 0; frame <= FRAMES; frame++) {
      const u = frame / FRAMES;
      let pose = articulatedPose(a, spec, () => sourcePose(rig, clips, plan, catalog.phaseEnds, u), u, clips);
      const edge = smoothstep(u / .1) * smoothstep((1 - u) / .15);
      pose = blendLocals(rig, idle, pose, edge);
      let world = rig.world(pose);
      const root = rig.rootJoint, parent = rig.parent[root], anchor = a.family === 'serpentine' || a.family === 'avian' ? a.hip : root;
      const correction = new Vector3(rig.restP[anchor].x - world.P[anchor].x, 0, rig.restP[anchor].z - world.P[anchor].z);
      pose.T[root].add(correction.applyQuaternion(parent < 0 ? new Quaternion() : world.Q[parent].clone().invert()));
      world = rig.world(pose);
      const bottom = lowest(world.P, world.Q), lift = MONSTER_HOVER[assetId] ? 0 : airborneAttack(spec, u) ? Math.max(0, floor - bottom) : floor - bottom;
      if (Math.abs(lift) > 1e-9) {
        pose.T[root].add(new Vector3(0, lift, 0).applyQuaternion(parent < 0 ? new Quaternion() : world.Q[parent].clone().invert()));
        metrics.maxFloorCorrection = Math.max(metrics.maxFloorCorrection, Math.abs(lift) / a.H);
      }
      world = rig.world(pose);
      metrics.lowestSkinnedHeight = Math.min(metrics.lowestSkinnedHeight, (lowest(world.P, world.Q) - floor) / a.H);
      metrics.maxRootHorizontalDrift = Math.max(metrics.maxRootHorizontalDrift, Math.hypot(world.P[anchor].x - rig.restP[anchor].x, world.P[anchor].z - rig.restP[anchor].z));
      for (const joint of rig.joints) {
        if (!pose.Q[joint].toArray().every(Number.isFinite)) throw new Error(`${assetId}/${id}: non-finite native quaternion at frame ${frame}, joint ${rig.nodes[joint].name}`);
        if (!translationJoints.has(joint)) metrics.maxNonBaseTranslationDelta = Math.max(metrics.maxNonBaseTranslationDelta, pose.T[joint].distanceTo(rig.restT[joint]));
        if (frame) metrics.maxJointStepDegrees = Math.max(metrics.maxJointStepDegrees, poses[frame - 1].Q[joint].angleTo(pose.Q[joint]) * 180 / Math.PI);
      }
      poses.push(pose);
    }
    if (metrics.maxNonBaseTranslationDelta > 1e-5) throw new Error(`${assetId}/${id}: an anatomical joint was stretched`);
    if (metrics.maxRootHorizontalDrift > 1e-5) throw new Error(`${assetId}/${id}: authored motion escaped its simulation root`);
    if (metrics.maxJointStepDegrees > 90) throw new Error(`${assetId}/${id}: native joint flipped by ${metrics.maxJointStepDegrees.toFixed(2)} degrees between adjacent 30 Hz samples`);
    const name = actionKey(id);
    authored.push({ name, frames: FRAMES, loop: false, poses });
    slots[id] = { clip: name, produced: 'authored', durationSeconds: FRAMES / FPS, loop: false, motion: spec.motion, socket: spec.socket, phaseEnds: catalog.phaseEnds, frames: FRAMES + 1,
      sourcePlan: plan, metrics: Object.fromEntries(Object.entries(metrics).map(([key, value]) => [key, round(value)])) };
  }
  if (!authored.length) throw new Error(`${assetId}: no owned attacks`);
  const encoded = encodeClips(source, rig, authored, { translationJoints: [...translationJoints] });
  encoded.json.extras = { ...encoded.json.extras, wildCrownEnemyAttacks: { schemaVersion: 1, phaseEnds: catalog.phaseEnds, sourceSha256: record.sha256 } };
  const bytes = encodeGlb(encoded.json, encoded.bin), outputUrl = record.runtimeUrl.replace(/-animated\.glb$/, '-combat.glb');
  if (outputUrl === record.runtimeUrl) throw new Error(`${assetId}: output must not overwrite the original native source`);
  const inheritedPath = `${dirname(record.runtimeUrl).slice(1)}/clips-report.json`;
  const inheritedBytes = readFileSync(resolve(ROOT, inheritedPath)), inherited = JSON.parse(inheritedBytes.toString());
  if (inherited.output.sha256 !== record.sha256) throw new Error(`${assetId}: inherited report does not describe the immutable source`);
  const report = { schemaVersion: 1, assetId, generator: 'scripts/assets/author-enemy-attacks.mjs', method: 'continuous conditioned native skeletal motion with anatomical action mechanics',
    input: { path: record.runtimeUrl.slice(1), sha256: hash(input) },
    output: { path: outputUrl.slice(1), sha256: hash(bytes), bytes: bytes.length },
    preserved: ['meshes', 'skins', 'materials', 'textures', 'node bind transforms'], animationScaleChannelsAdded: 0,
    nativeHeight: a.H, groundUnits: floor, anchors: anchorTable, attacks: slots,
    inheritedProvenance: { path: inheritedPath, sha256: hash(inheritedBytes) },
    rig: inherited.rig, inPlaceAnchorBone: inherited.inPlaceAnchorBone, slots: inherited.slots, clips: inherited.clips };
  if (write) {
    writeFileSync(resolve(ROOT, '.' + outputUrl), bytes);
    writeFileSync(resolve(ROOT, '.' + dirname(outputUrl), 'combat-clips-report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  return { bytes, report, outputUrl, anchors: anchorTable };
}

export function authorAll({ write = true, assetIds } = {}) {
  const sources = json(SOURCE_PATH), outputs = new Map();
  const anchorsPath = 'src/content/enemy-native-anchors.json';
  const anchorTable = existsSync(resolve(ROOT, anchorsPath)) ? json(anchorsPath) : {};
  for (const assetId of assetIds ?? Object.keys(sources.nativeSources)) {
    const output = authorEnemy(assetId, { write });
    outputs.set(assetId, output); anchorTable[assetId] = output.anchors;
    console.log(JSON.stringify({ assetId, attacks: Object.keys(output.report.attacks).length, outputHash: output.report.output.sha256, bytes: output.bytes.length, worstFloorCorrection: Math.max(...Object.values(output.report.attacks).map(s => s.metrics.maxFloorCorrection)) }));
  }
  for (const [alias, sourceId] of Object.entries(sources.runtimeAliases)) {
    if (!anchorTable[sourceId]) throw new Error(`Missing native anchor source ${sourceId} for canonical ${alias}`);
    anchorTable[alias] = anchorTable[sourceId];
  }
  if (write) {
    for (const map of MAPS) {
      const path = `asset-source/playtests/${map}.json`, entries = json(path);
      for (const entry of entries) {
        const output = outputs.get(sources.runtimeAliases[entry.id] ?? entry.id);
        if (!output) continue;
        bindNativeEnemyAttacks(entry, output.report);
      }
      writeFileSync(resolve(ROOT, path), JSON.stringify(entries, null, 2) + '\n');
    }
    writeFileSync(resolve(ROOT, 'src/content/enemy-native-anchors.json'), JSON.stringify(anchorTable, null, 2) + '\n');
  }
  return { sources: outputs.size, attackOwnerPairs: [...outputs.values()].reduce((sum, o) => sum + Object.keys(o.report.attacks).length, 0) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const selected = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
  console.log(JSON.stringify(authorAll({ write: !process.argv.includes('--dry-run'), ...(selected.length ? { assetIds: selected } : {}) })));
}
