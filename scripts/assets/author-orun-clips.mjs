#!/usr/bin/env node
// Retarget the existing native Warden library onto Orun's own Mixamo skeleton. No mesh/skin donor substitution.
// A lateral hand-supported cartwheel is authored on Orun's measured skeleton; all output is baked native GLB motion.
// Usage: node scripts/assets/author-orun-clips.mjs
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Quaternion, Vector3 } from 'three';
import { Rig as RetargetRig, retargetFrames } from './retarget-aren-tripo-clips.mjs';
import { Rig, PoseBuilder, FPS, SLOT_SECONDS, SLOT_LOOPS, parseGlb, encodeGlb, encodeClips, compactBuffers, makeLowestSampler, blendLocals, smoothstep } from './creature-rig-kit.mjs';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const DIR = 'asset-source/generated/actor-orun-runtime-01';
const DONOR = 'asset-source/generated/actor-aren-user-supplied-01/aren-playtest-animated.glb';
const UP = new Vector3(0, 1, 0);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const round = value => Number(value.toFixed(6));
const SOURCES = {
  'monster-idle': { source: 'idle.001' },
  'monster-walk': { source: 'walk.001' },
  'monster-run': { source: 'run.001' },
  'monster-slash': { source: 'aren-light-1', contact: 0.45 },
  'monster-shoot': { source: 'aren-charged-heavy', contact: 0.5 },
  'monster-jump': { source: 'One long jump.001', airborne: true },
  'monster-hurt': { source: 'aren-stagger', hold: true },
  'monster-turn': { source: 'walk.001' },
  'monster-dive': { source: 'dive.001', airborne: true },
  'monster-roar': { source: 'aren-cleanse' },
  'monster-death': { source: 'defeat_03.001', collapse: true },
  'monster-spawn': { source: 'defeat_03.001', reverse: true },
  'orun-root-tether': { source: 'aren-root-tether', seconds: 1.4, contact: 0.5 },
  'orun-back-handspring': { source: 'aren-back-handspring', seconds: 1, airborne: true },
};

function heading(rig) {
  const left = rig.index.get('mixamorig:LeftUpLeg'), right = rig.index.get('mixamorig:RightUpLeg');
  if (left === undefined || right === undefined) throw new Error('Warden retarget requires both anatomical hip joints');
  const lateral = rig.restWorldPosition[right].clone().sub(rig.restWorldPosition[left]);
  lateral.y = 0;
  if (lateral.lengthSq() < 1e-10) throw new Error('Warden retarget requires distinct hip positions');
  return UP.clone().cross(lateral).normalize();
}

export function author({ write = true } = {}) {
  const inputBytes = readFileSync(resolve(ROOT, DIR, 'actor-orun.glb'));
  const donorBytes = readFileSync(resolve(ROOT, DONOR));
  const source = parseGlb(inputBytes), donorSource = parseGlb(donorBytes);
  const target = new RetargetRig(source), originalDonor = new RetargetRig(donorSource);
  const forward = heading(target), donorForward = heading(originalDonor);
  const yaw = Math.atan2(forward.x, forward.z) - Math.atan2(donorForward.x, donorForward.z);
  const alignment = new Quaternion().setFromAxisAngle(UP, yaw);
  // Rotate the donor's coordinate frame, not its mesh or Orun's bind pose. World-space motion deltas now share a heading.
  for (const index of originalDonor.order) if (originalDonor.parent[index] < 0) {
    const node = donorSource.json.nodes[index];
    node.rotation = alignment.clone().multiply(originalDonor.restQuaternion[index]).toArray();
    node.translation = originalDonor.restPosition[index].clone().applyQuaternion(alignment).toArray();
  }
  const donor = new RetargetRig(donorSource), rig = new Rig(source.json);
  const hips = rig.index('mixamorig:Hips'), head = rig.index('mixamorig:Head');
  const timing = JSON.parse(readFileSync(resolve(ROOT, 'asset-source/generated/actor-aren-user-supplied-01/retarget-report.json'), 'utf8'));
  const lowest = makeLowestSampler(source.json, source.bin, rig.joints, 1);
  const floor = lowest(rig.restP, rig.restWQ);
  const clips = [], slots = {};
  const ground = (pose, airborne = false) => {
    const world = rig.world(pose), below = lowest(world.P, world.Q);
    const offset = airborne ? Math.max(0, floor - below) : floor - below;
    const parent = rig.parent[hips];
    // Tripo's scene root permutes axes: local hips X/Z are not world-horizontal.
    // Simulation owns travel; preserve only the native vertical displacement.
    const correction = new Vector3(rig.restP[hips].x - world.P[hips].x, offset, rig.restP[hips].z - world.P[hips].z);
    pose.T[hips].add(correction.applyQuaternion(parent < 0 ? new Quaternion() : world.Q[parent].clone().invert()));
    return pose;
  };
  for (const [name, spec] of Object.entries(SOURCES)) {
    const decoded = donor.decodeAnimation(spec.source), seconds = spec.seconds ?? SLOT_SECONDS[name];
    const frames = Math.round(seconds * FPS), count = frames + 1;
    const nativeTiming = timing.clips.find(clip => clip.action === spec.source);
    const sourceContact = nativeTiming?.contact?.outputNormalizedTime
      ?? (nativeTiming?.simulation?.activeTick !== undefined ? nativeTiming.simulation.activeTick / nativeTiming.simulation.totalTicks : undefined);
    if (spec.contact !== undefined && !Number.isFinite(sourceContact)) throw new Error(`Missing measured contact timing for ${spec.source}`);
    const timeAt = frame => {
      let u = frame / frames;
      if (spec.hold) u = u < 0.2 ? u * 1.5 : u <= 0.62 ? 0.3 : 0.3 + (u - 0.62) * 0.7 / 0.38;
      if (spec.collapse) u = Math.min(1, u / 0.82);
      if (spec.contact !== undefined) u = u <= spec.contact ? u * sourceContact / spec.contact : sourceContact + (u - spec.contact) * (1 - sourceContact) / (1 - spec.contact);
      if (spec.reverse) u = 1 - u;
      return u * decoded.duration;
    };
    const data = retargetFrames(target, donor, decoded, count, timeAt);
    const poses = [];
    for (let frame = 0; frame < count; frame++) {
      const pose = rig.restLocals();
      for (const joint of rig.joints) if (data.rotations[joint]) pose.Q[joint].fromArray(data.rotations[joint], frame * 4);
      pose.T[hips].fromArray(data.positions[hips], frame * 3);
      poses.push(ground(pose, spec.airborne));
    }
    const loop = SLOT_LOOPS[name] ?? false;
    if (loop) {
      const overlap = Math.max(2, Math.round(frames * 0.15));
      for (let frame = frames - overlap; frame <= frames; frame++) poses[frame] = blendLocals(rig, poses[frame], poses[0], smoothstep((frame - frames + overlap) / overlap));
    }
    clips.push({ name, frames, loop, poses });
    slots[name] = { clip: name, source: spec.source, seconds: frames / FPS, frames: count, loop, ...(spec.contact === undefined ? {} : { contactNormalizedTime: spec.contact }) };
    if (name === 'monster-walk' || name === 'monster-run') {
      const parent = rig.parent[hips], rotation = parent < 0 ? new Quaternion() : rig.restWQ[parent];
      const start = new Vector3().fromArray(data.positions[hips], 0).applyQuaternion(rotation);
      const end = new Vector3().fromArray(data.positions[hips], frames * 3).applyQuaternion(rotation);
      slots[name].plantingSpeedUnits = Math.hypot(end.x - start.x, end.z - start.z) / (frames / FPS);
    }
  }
  const idle = clips[0].poses[0];
  const spawn = clips.find(clip => clip.name === 'monster-spawn');
  for (let frame = Math.floor(spawn.frames * 0.8); frame <= spawn.frames; frame++) spawn.poses[frame] = ground(blendLocals(rig, spawn.poses[frame], idle, smoothstep((frame / spawn.frames - 0.8) / 0.2)));

  const frames = 48, poses = [];
  for (let frame = 0; frame <= frames; frame++) {
    const u = frame / frames, gate = smoothstep(u / 0.15) * smoothstep((1 - u) / 0.15);
    const roll = new Quaternion().setFromAxisAngle(forward, Math.PI * 2 * smoothstep((u - 0.1) / 0.8));
    const builder = new PoseBuilder(rig).rotate(hips, roll);
    for (const [side, sign] of [['Left', 1], ['Right', -1]]) {
      const arm = rig.index(`mixamorig:${side}Arm`), elbow = rig.index(`mixamorig:${side}ForeArm`), hand = rig.index(`mixamorig:${side}Hand`);
      const armDirection = rig.restP[elbow].clone().sub(rig.restP[arm]).normalize().lerp(UP, gate).normalize().applyQuaternion(roll);
      builder.aim(arm, elbow, armDirection).aim(elbow, hand, armDirection);
      const thigh = rig.index(`mixamorig:${side}UpLeg`), knee = rig.index(`mixamorig:${side}Leg`), foot = rig.index(`mixamorig:${side}Foot`);
      const legDirection = rig.restP[knee].clone().sub(rig.restP[thigh]).normalize().applyAxisAngle(forward, sign * 0.6 * Math.sin(Math.PI * u)).applyQuaternion(roll);
      builder.aim(thigh, knee, legDirection).aim(knee, foot, legDirection);
    }
    poses.push(ground(blendLocals(rig, idle, builder.solve(), gate)));
  }
  clips.push({ name: 'orun-cartwheel-counter', frames, loop: false, poses });
  slots['orun-cartwheel-counter'] = { clip: 'orun-cartwheel-counter', source: 'authored lateral hand-supported rotation', seconds: frames / FPS, frames: frames + 1, loop: false };
  const encoded = compactBuffers(encodeClips(source, rig, clips, { translationJoints: [hips], keepAnimations: false }));
  const bytes = encodeGlb(encoded.json, encoded.bin);
  const report = {
    schemaVersion: 1, assetId: 'actor-orun', method: 'heading-aligned world-rest Warden retarget and authored lateral cartwheel',
    input: { path: `${DIR}/actor-orun.glb`, sha256: hash(inputBytes) }, donor: { path: DONOR, sha256: hash(donorBytes), yawAlignmentRadians: round(yaw) },
    output: { path: `${DIR}/actor-orun-animated.glb`, sha256: hash(bytes), bytes: bytes.length },
    castSocketBone: rig.nodes[head].name,
    suggestedCoordinateTransformForward: { x: forward.x, y: 0, z: forward.z },
    rig: { joints: rig.joints.length, headTipJoint: rig.nodes[head].name },
    floorUnits: floor, slots,
  };
  if (write) {
    writeFileSync(resolve(ROOT, DIR, 'actor-orun-animated.glb'), bytes);
    writeFileSync(resolve(ROOT, DIR, 'clips-report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  return { bytes, report };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(author().report, null, 2));
