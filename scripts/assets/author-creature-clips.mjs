#!/usr/bin/env node
// Builds the ten gameplay clip slots for the Whispering Canopy monsters on their Tripo rigs:
//   actor-thornback-howler (biped, rig v1.0)   idle/walk/run/slash/shoot from Tripo presets (windowed, retimed and
//                                              loop-closed), jump/hurt/turn/dive/roar authored (chest-beat roar)
//   actor-storm-hornbill   (avian, rig v2.5)   no Tripo preset exists for avian rigs: all ten clips authored
//   actor-mire-viper       (serpentine, v2.5)  walk = Tripo preset:serpentine:march, the rest authored
// Authored poses are world-space rotation increments (scripts/assets/creature-rig-kit.mjs) with two-bone IK for planted
// feet and reaching hands, sampled at 30 fps, in place (no horizontal root drift) and byte-deterministic.
//
// Usage: node scripts/assets/author-creature-clips.mjs <asset-id>
//   reads  asset-source/generated/<asset-id>-runtime-01/<asset-id>.glb          (scripts/assets/build-greenwake-runtime-asset.mjs)
//   writes asset-source/generated/<asset-id>-runtime-01/<asset-id>-animated.glb and clips-report.json
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Quaternion, Vector3 } from 'three';
import {
  BodyFrame, DEG, FPS, cleanStraySkinWeights, makeCentroidSampler, MONSTER_SLOTS, MONSTER_TAIL_SLOT, PoseBuilder, Rig, SLOT_LOOPS, SLOT_SECONDS, TAU, anchorMap, blendLocals, clamp, compactBuffers, curve, encodeClips, encodeGlb,
  parseGlb, readAnimation, round, shiftJointHorizontal, sin, smoothstep, window01,
} from './creature-rig-kit.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const V = (x, y, z) => new Vector3(x, y, z);
const sum = (a, b) => a + b;

/**
 * An authored clip: pose(t, ctx) builds a PoseBuilder for normalized time t (0..1).
 * A conditioned clip: `preset` names the Tripo clip, `anchors` maps output time [0..1] to source seconds, `crossfade` closes loops.
 */

// ---------------------------------------------------------------------------------------------
// Howler (biped, Mixamo-style Tripo rig v1.0). Faces +X; left = -Z.
// ---------------------------------------------------------------------------------------------
function howlerContext(rig, height) {
  const j = name => rig.index(name);
  const ctx = { rig, body: new BodyFrame(V(1, 0, 0)), H: height ?? 0.932, strikeJoints: ['L_Hand', 'R_Hand'].map(j), castSocketBone: 'Head' };
  ctx.hip = j('Hip'); ctx.waist = j('Waist'); ctx.spine = [j('Spine01'), j('Spine02')]; ctx.neck = [j('NeckTwist01'), j('NeckTwist02')]; ctx.head = j('Head');
  ctx.arm = { L: ['L_Upperarm', 'L_Forearm', 'L_Hand'].map(j), R: ['R_Upperarm', 'R_Forearm', 'R_Hand'].map(j) };
  ctx.leg = { L: ['L_Thigh', 'L_Calf', 'L_Foot'].map(j), R: ['R_Thigh', 'R_Calf', 'R_Foot'].map(j) };
  ctx.clavicle = { L: j('L_Clavicle'), R: j('R_Clavicle') };
  ctx.rootJoint = j('Root');
  ctx.translationJoints = [j('Root'), j('Hip')];
  ctx.hipsJoint = ctx.hip;
  ctx.restP = rig.world(rig.restLocals()).P;
  ctx.restWQ = rig.restWQ;
  return ctx;
}

/**
 * Biped pose from body-frame controls. ctl: { up, hip, torso, neck, head, arms: {L, R}, feet: {L, R} }.
 * arms.X = [forward, up, left] hand offset from the rest hand (units); feet.X = same for the foot (null = plant at rest).
 */
function bipedPose(ctx, ctl) {
  const { rig, body } = ctx;
  const pb = new PoseBuilder(rig);
  if (ctl.up) pb.translate(ctx.hip, V(0, ctl.up, 0));
  if (ctl.hip) pb.rotate(ctx.hip, body.euler(ctl.hip));
  const spread = (joints, angles, weights) => {
    if (!angles) return;
    const total = weights.reduce(sum, 0);
    joints.forEach((joint, i) => pb.rotate(joint, body.euler(angles.map(v => v * weights[i] / total))));
  };
  spread([ctx.waist, ...ctx.spine], ctl.torso, [0.25, 0.35, 0.4]);
  spread(ctx.neck, ctl.neck, [0.5, 0.5]);
  if (ctl.head) pb.rotate(ctx.head, body.euler(ctl.head));
  if (ctl.shrug) for (const side of ['L', 'R']) pb.rotate(ctx.clavicle[side], body.roll(side === 'L' ? -ctl.shrug : ctl.shrug));
  const now = rig.world(pb.solve());
  for (const side of ['L', 'R']) {
    const [thigh, calf, foot] = ctx.leg[side];
    const off = ctl.feet?.[side] ?? [0, 0, 0];
    pb.reach(thigh, calf, foot, body.at(ctx.restP[foot], off[0], off[1], off[2]), body.F, true);
    const arm = ctl.arms?.[side];
    if (arm) {
      const [upper, lower, hand] = ctx.arm[side];
      const target = arm.world ?? body.at(arm.from ? now.P[arm.from] : ctx.restP[hand], arm.at[0], arm.at[1], arm.at[2]);
      pb.reach(upper, lower, hand, target, arm.hint ?? body.at(V(0, 0, 0), -0.3, -0.5, side === 'L' ? 0.6 : -0.6));
    }
  }
  return { pb, now };
}

const HOWLER = {
  setup: howlerContext,
  presetMapping: {
    // output slot -> Tripo preset (clip name inside the retargeted GLB), source window and retiming
    'monster-idle': { preset: 'idle', window: [3.0, 3.0 + 3.0], crossfade: 0.6 },
    'monster-walk': { preset: 'walk', anchors: [[0, 0], [1, 2.3667]], crossfade: 0.4, centreHips: true },
    'monster-run': { preset: 'run', anchors: [[0, 0], [1, 1.2667]], crossfade: 0.25, centreHips: true },
    'monster-slash': { preset: 'slash', anchors: [[0, 0.95], [0.3, 1.6], [0.45, 2.15], [0.62, 2.45], [1, 3.35]] },
    'monster-shoot': { preset: 'pitch_baseball', anchors: [[0, 0.3], [0.5, 1.95], [0.7, 2.2], [1, 3.2]] },
  },
  clips: {
    'monster-jump': {
      keyTimes: { crouchEnd: 0.28, takeoff: 0.3, peak: 0.5, touchdown: 0.7, compressionBottom: 0.78 },
      pose(t, ctx) {
        const c = keys => curve(keys, t), H = ctx.H;
        const up = H * c([[0, 0], [0.26, -0.1], [0.3, 0, 'in'], [0.5, 0.3, 'out2'], [0.7, 0, 'in2'], [0.78, -0.1, 'out'], [0.84, -0.09, 'lin'], [0.95, 0.01], [1, 0]]);
        const lift = Math.max(up, 0) + H * c([[0, 0], [0.3, 0, 'lin'], [0.42, 0.13, 'out'], [0.6, 0.13, 'lin'], [0.7, 0, 'in'], [1, 0]]);
        const armsUp = c([[0, 0], [0.26, -0.3, 'io'], [0.34, 1, 'out'], [0.56, 1, 'lin'], [0.7, 0.1, 'in'], [0.76, -0.25, 'out'], [0.95, 0], [1, 0]]);
        const handForward = H * (0.1 + c([[0, 0], [0.26, -0.22], [0.34, 0.12], [0.56, 0.1], [0.7, 0.3], [0.78, 0.34], [0.95, 0.02], [1, 0]]));
        const handUp = H * (armsUp >= 0 ? 0.95 * armsUp : 0.2 * armsUp);
        const arm = side => ({ at: [handForward, handUp, 0.05 * (side === 'L' ? 1 : -1)] });
        return bipedPose(ctx, {
          up,
          hip: [c([[0, 0], [0.26, -8], [0.3, 6, 'in'], [0.5, 0], [0.7, -8], [0.78, -12, 'out'], [1, 0]]), 0, 0],
          torso: [c([[0, 0], [0.26, -22], [0.32, 14, 'in'], [0.5, 8], [0.68, -16], [0.78, -26, 'out'], [0.95, 3], [1, 0]]), 0, 0],
          neck: [c([[0, 0], [0.26, -8], [0.34, 14], [0.5, 8], [0.68, -12], [0.8, -14, 'out'], [1, 0]]), 0, 0],
          head: [c([[0, 0], [0.26, -6], [0.34, 10], [0.7, -8], [0.8, -10, 'out'], [1, 0]]), 0, 0],
          arms: { L: arm('L'), R: arm('R') },
          feet: { L: [0.03 * (lift > 0.001 ? 1 : 0), lift, 0], R: [0.03 * (lift > 0.001 ? 1 : 0), lift, 0] },
        });
      },
    },
    'monster-hurt': {
      // Flinch peaks at 0.2, then the body slumps into a dazed hunch held 0.44-0.62 (breathing) before recovering; finite consumers hold
      // the pose by sampling `hold` instead of looping the clip.
      keyTimes: { flinch: 0.2, hold: 0.52 },
      pose(t, ctx) {
        const c = keys => curve(keys, t), H = ctx.H;
        const held = c([[0, 0], [0.2, 0, 'lin'], [0.44, 1, 'io'], [0.62, 1, 'lin'], [1, 0, 'io']]);
        // The flinch's rebound terms fade out as the dazed pose fades in, so 0.46-0.58 is a calm, sustained pose.
        const flinch = (1 - held) * c([[0, 0], [0.2, 1, 'out'], [0.4, 0.15], [0.6, -0.06], [1, 0]]);
        const wob = (1 - held) * c([[0, 0], [0.2, 0, 'lin'], [0.36, 1], [0.56, -0.5], [1, 0]]);
        const breath = Math.sin(TAU * 1.4 * (t - 0.44)) * held;
        return bipedPose(ctx, {
          up: -H * (0.035 * flinch + 0.025 * held),
          hip: [-10 * flinch + 3 * held, 4 * wob, 5 * flinch],
          torso: [20 * flinch - 4 * wob - 10 * held + 1.2 * breath, -8 * flinch, -6 * flinch + 3 * held],
          neck: [26 * flinch - 8 * held + 1.6 * breath, 10 * wob, 0],
          head: [14 * flinch - 10 * held + 2 * breath, -10 * flinch + 10 * held, 0],
          shrug: 14 * flinch - 6 * held,
          arms: {
            L: { at: [-H * 0.12 * flinch + H * 0.03 * held, H * 0.2 * flinch - H * 0.08 * held, -H * 0.12 * flinch] },
            R: { at: [-H * 0.1 * flinch + H * 0.03 * held, H * 0.16 * flinch - H * 0.08 * held, H * 0.14 * flinch] },
          },
          feet: { L: [-0.02 * flinch, 0, 0], R: [0.02 * flinch, 0, 0] },
        });
      },
    },
    'monster-turn': {
      keyTimes: {},
      pose(t, ctx) {
        const H = ctx.H, step = (t0, sideSign) => {
          const s = (((t - t0) % 1) + 1) % 1, swing = s < 0.45, k = swing ? s / 0.45 : (s - 0.45) / 0.55;
          const lateral = swing ? -1 + 2 * smoothstep(k) : 1 - 2 * k;
          return [swing ? 0.012 * H * Math.sin(Math.PI * k) : 0, swing ? 0.08 * H * Math.sin(Math.PI * k) : 0, sideSign * 0.04 * H * lateral];
        };
        return bipedPose(ctx, {
          up: -H * 0.012 * (0.5 - 0.5 * Math.cos(TAU * 2 * t)),
          hip: [0, 11 * sin(t, 1), 3 * sin(t, 2, 0.1)],
          torso: [4, -17 * sin(t, 1, 0.04), 0],
          neck: [0, 11 * sin(t, 1, 0.12), 0],
          head: [0, 8 * sin(t, 1, 0.18), 0],
          arms: {
            L: { at: [H * 0.06 * sin(t, 1, 0.5), 0, H * 0.04 * sin(t, 2)] },
            R: { at: [H * 0.06 * sin(t, 1), 0, H * -0.04 * sin(t, 2)] },
          },
          feet: { L: step(0, 1), R: step(0.5, -1) },
        });
      },
    },
    'monster-dive': {
      keyTimes: { crouchEnd: 0.22, strike: 0.4, recoverStart: 0.55 },
      pose(t, ctx) {
        const c = keys => curve(keys, t), H = ctx.H;
        const reach = c([[0, 0], [0.22, -0.4, 'io'], [0.28, -0.4, 'lin'], [0.4, 1, 'in'], [0.5, 0.9, 'out'], [0.7, 0.15], [1, 0]]);
        const stepFwd = c([[0, 0], [0.2, 0, 'lin'], [0.42, 0.1, 'io'], [0.55, 0.1, 'lin'], [0.8, 0, 'io'], [1, 0]]);
        const stepLift = c([[0, 0], [0.24, 0, 'lin'], [0.32, 0.09, 'out'], [0.42, 0, 'in'], [0.6, 0, 'lin'], [1, 0]]);
        return bipedPose(ctx, {
          up: H * c([[0, 0], [0.22, -0.07], [0.28, -0.07, 'lin'], [0.4, -0.09, 'in'], [0.55, -0.08], [0.85, -0.01], [1, 0]]),
          hip: [c([[0, 0], [0.22, 8], [0.4, -14, 'in'], [0.6, -8], [1, 0]]), 0, 0],
          torso: [c([[0, 0], [0.22, 12], [0.28, 12, 'lin'], [0.4, -34, 'in'], [0.55, -20], [1, 0]]), c([[0, 0], [0.22, 6], [0.4, -4], [1, 0]]), 0],
          neck: [c([[0, 0], [0.22, 14], [0.4, -18, 'in'], [0.6, -8], [1, 0]]), 0, 0],
          head: [c([[0, 0], [0.22, 8], [0.4, -12, 'in'], [0.6, -4], [1, 0]]), 0, 0],
          arms: {
            L: { at: [H * (0.08 + 0.38 * reach), -H * (0.05 + 0.3 * Math.max(reach, 0)), 0.04] },
            R: { at: [H * (0.06 + 0.4 * reach), -H * (0.03 + 0.28 * Math.max(reach, 0)), -0.04] },
          },
          feet: { L: [stepFwd * H, stepLift * H, 0], R: [-0.01, 0, 0] },
        });
      },
    },
    'monster-roar': {
      keyTimes: { stamp: 0.2, shakeStart: 0.25, shakeEnd: 0.8 },
      pose(t, ctx) {
        const c = keys => curve(keys, t), H = ctx.H, body = ctx.body;
        const raise = c([[0, 0], [0.2, 1, 'out'], [0.82, 1, 'lin'], [1, 0, 'io']]);
        const beatEnvelope = window01(t, 0.2, 0.28, 0.78, 0.86);
        // 5 beats per hand over the 0.28..0.78 sustain (2.0 s clip): hands alternate between thrown wide and the chest.
        const beat = phase => 0.5 - 0.5 * Math.cos(TAU * (5 * (t - 0.28) / 0.5 + phase));
        const chest = body.at(ctx.restP[ctx.spine[1]], 0.07 * H, 0.015 * H, 0);
        const arm = (side, phase) => {
          const lateral = side === 'L' ? 1 : -1;
          const bump = 1 - beat(phase);
          const wide = V(0, 0, 0), chestTarget = body.at(chest, 0.04 * H * bump, -0.03 * H, 0.05 * H * lateral * 0.6);
          wide.copy(body.at(chest, 0.2 * H, 0.1 * H, 0.34 * H * lateral));
          const pos = wide.clone().lerp(chestTarget, beatEnvelope * (1 - beat(phase)));
          const toRaise = body.at(chest, 0.1 * H, 0.0, 0.36 * H * lateral);
          return { world: toRaise.clone().lerp(pos, beatEnvelope), hint: body.at(V(0, 0, 0), -0.3, -0.3, 0.8 * lateral) };
        };
        const shake = window01(t, 0.22, 0.3, 0.76, 0.86);
        return bipedPose(ctx, {
          up: H * (0.03 * raise + 0.004 * beatEnvelope * sin(t, 10)),
          hip: [-6 * raise, 0, 0],
          torso: [20 * raise + 2 * shake * sin(t, 5, 0.2), 2.5 * shake * sin(t, 2.5), 0],
          neck: [24 * raise + 3 * shake * sin(t, 10, 0.3), 3 * shake * sin(t, 5), 0],
          head: [18 * raise + 3 * shake * sin(t, 10, 0.5), 4 * shake * sin(t, 5, 0.1), 3 * shake * sin(t, 5, 0.3)],
          shrug: 6 * raise,
          arms: { L: arm('L', 0), R: arm('R', 0.5) },
        });
      },
    },
  },
};

// ---------------------------------------------------------------------------------------------
// Hornbill (avian, Tripo rig v2.5). Faces +X; left = -Z; wings span +-Z, tail trails down -X.
// ---------------------------------------------------------------------------------------------
function hornbillContext(rig) {
  const j = name => rig.index(name);
  const ctx = { rig, body: new BodyFrame(V(1, 0, 0)), H: 0.792, castSocketBone: 'tripo::Head_0' };
  ctx.root = j('tripo::Root');
  ctx.wing = { L: ['bone_9', 'bone_10', 'bone_11'].map(j), R: ['bone_12', 'bone_13', 'bone_14'].map(j) };
  const restP = ctx.restP = rig.world(rig.restLocals()).P;
  if (!(restP[ctx.wing.L[2]].z < -0.2 && restP[ctx.wing.R[2]].z > 0.2)) throw new Error('Hornbill wing joints are not where the clip set expects them (left wing at -Z)');
  ctx.leg = { L: ['tripo::0_Left_Limb_0', 'tripo::0_Left_Limb_1', 'tripo::0_Left_Limb_2'].map(j), R: ['tripo::0_Right_Limb_0', 'tripo::0_Right_Limb_1', 'tripo::0_Right_Limb_2'].map(j) };
  ctx.spine = j('tripo::Spine_0'); ctx.tail = ['tripo::Tail_0', 'tripo::Tail_1', 'tripo::Tail_2'].map(j);
  ctx.neck = j('bone_19'); ctx.head = [j('tripo::Head_0'), j('tripo::Head_1')];
  ctx.translationJoints = [ctx.root];
  ctx.hipsJoint = ctx.spine; // tail base, next to the body pivot: the in-place anchor (Root swings about a pivot above it)
  ctx.rootJoint = ctx.root;
  ctx.strikeJoints = [ctx.wing.L[2], ctx.wing.R[2]];
  return ctx;
}

/** Wing pose: flap (degrees up, per joint cumulative lag), sweep (degrees back), pitch (leading edge). */
function hornbillPose(ctx, ctl) {
  const { rig, body } = ctx;
  const pb = new PoseBuilder(rig);
  const pivot = ctx.restP[ctx.root];
  if (ctl.root) pb.rotateAbout(ctx.root, body.euler(ctl.root), V(pivot.x + 0.05, pivot.y + 0.35, pivot.z));
  if (ctl.up) pb.translate(ctx.root, V(0, ctl.up, 0));
  const spread = (joints, angles, weights) => {
    joints.forEach((joint, i) => pb.rotate(joint, body.euler(angles.map(v => v * weights[i] / weights.reduce(sum, 0)))));
  };
  if (ctl.tail) spread(ctx.tail, ctl.tail, [0.3, 0.35, 0.35]);
  // Per-joint tail angles [pitch, yaw, roll] (travelling whips); `tail` spreads one set of angles over the chain.
  if (ctl.tailJoints) ctx.tail.forEach((joint, i) => pb.rotate(joint, body.euler(ctl.tailJoints[i])));
  if (ctl.neck) pb.rotate(ctx.neck, body.euler(ctl.neck));
  if (ctl.head) pb.rotate(ctx.head[0], body.euler(ctl.head));
  if (ctl.beak) pb.rotate(ctx.head[1], body.euler(ctl.beak));
  for (const side of ['L', 'R']) {
    const wing = ctx.wing[side], w = ctl.wing?.[side];
    if (!w) continue;
    const sign = side === 'L' ? 1 : -1; // flap about F: positive raises the left wing, negative raises the right
    const flap = w.flap ?? [0, 0, 0], sweep = w.sweep ?? [0, 0, 0], pitch = w.pitch ?? [0, 0, 0];
    wing.forEach((joint, i) => {
      pb.rotate(joint, new Quaternion().setFromAxisAngle(body.F, sign * flap[i] * Math.PI / 180));
      if (sweep[i]) pb.rotate(joint, new Quaternion().setFromAxisAngle(body.U, sign * sweep[i] * Math.PI / 180));
      if (pitch[i]) pb.rotate(joint, new Quaternion().setFromAxisAngle(body.L, sign * pitch[i] * Math.PI / 180));
    });
  }
  for (const side of ['L', 'R']) {
    const leg = ctx.leg[side], l = ctl.legs?.[side];
    if (!l) continue;
    leg.forEach((joint, i) => pb.rotate(joint, body.euler(l.map(v => v * [0.4, 0.35, 0.25][i]))));
  }
  return { pb };
}

/** Symmetric wing cycle helper: returns ctl.wing for a flap phase t (cycles per clip) and amplitude [deg]. */
function wingCycle(t, cycles, amp, { lag = 0.07, tipLag = 0.14, bias = 0, pitchAmp = 10, sweepAmp = 0, asym = 0 } = {}) {
  const side = (sign, phaseShift) => {
    const f = (delay) => bias + amp * (1 + sign * asym) * sin(t, cycles, phaseShift - delay);
    return {
      flap: [f(0), f(lag) * 0.7, f(tipLag) * 0.6],
      pitch: [pitchAmp * sin(t, cycles, phaseShift - 0.25), pitchAmp * 0.6 * sin(t, cycles, phaseShift - 0.3), 0],
      sweep: [sweepAmp, sweepAmp * 0.5, 0],
    };
  };
  return { L: side(1, 0), R: side(-1, 0) };
}

const HORNBILL = {
  setup: hornbillContext,
  presetMapping: {},
  slots: [...MONSTER_SLOTS, MONSTER_TAIL_SLOT],
  clips: {
    'monster-idle': {
      pose(t, ctx) {
        const bob = sin(t, 3, 0.1);
        return hornbillPose(ctx, {
          up: 0.012 * bob, root: [2 * bob, 0, 1.2 * sin(t, 1, 0.2)],
          wing: wingCycle(t, 3, 21, { lag: 0.06, tipLag: 0.12, bias: 4, pitchAmp: 7 }),
          tail: [4 * sin(t, 3, 0.35), 5 * sin(t, 1, 0.1), 0], neck: [3 * sin(t, 1, 0.2), 6 * sin(t, 1, 0.45), 0], head: [4 * sin(t, 2, 0.1), 9 * sin(t, 1, 0.1), 2 * sin(t, 1)],
          legs: { L: [10 + 6 * sin(t, 3, 0.4), 0, 0], R: [10 + 6 * sin(t, 3, 0.45), 0, 0] },
        });
      },
    },
    'monster-walk': {
      pose(t, ctx) {
        const bob = sin(t, 2, 0.1);
        return hornbillPose(ctx, {
          up: 0.014 * bob, root: [-8 + 3 * bob, 0, 1.5 * sin(t, 1, 0.25)],
          wing: wingCycle(t, 2, 27, { lag: 0.07, tipLag: 0.14, bias: 2, pitchAmp: 9 }),
          tail: [8 + 4 * sin(t, 2, 0.35), 4 * sin(t, 1, 0.1), 0], neck: [8, 5 * sin(t, 1, 0.45), 0], head: [6 + 3 * sin(t, 2, 0.1), 7 * sin(t, 1, 0.1), 0],
          legs: { L: [18 + 6 * sin(t, 2, 0.4), 0, 0], R: [18 + 6 * sin(t, 2, 0.45), 0, 0] },
        });
      },
    },
    'monster-run': {
      pose(t, ctx) {
        const bob = sin(t, 2, 0.1);
        return hornbillPose(ctx, {
          up: 0.018 * bob, root: [-16 + 3 * bob, 0, 2 * sin(t, 1, 0.25)],
          wing: wingCycle(t, 2, 32, { lag: 0.08, tipLag: 0.16, bias: 0, pitchAmp: 10, sweepAmp: 10 }),
          tail: [14, 5 * sin(t, 1, 0.1), 0], neck: [12, 3 * sin(t, 1, 0.45), 0], head: [10, 5 * sin(t, 1, 0.1), 0],
          legs: { L: [34, 0, 0], R: [34, 0, 0] },
        });
      },
    },
    'monster-slash': {
      keyTimes: { windupEnd: 0.3, strike: 0.45, followThroughEnd: 0.72 },
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        const up = c([[0, 0], [0.3, 62, 'io'], [0.4, 70, 'lin'], [0.46, -42, 'in'], [0.58, -30, 'out'], [0.74, 18, 'io'], [0.86, -4], [1, 0]]);
        const bend = c([[0, 0], [0.3, 28, 'io'], [0.4, 30, 'lin'], [0.46, -16, 'in'], [0.6, -8], [1, 0]]);
        const wing = side => ({ flap: [up, up * 0.5 + bend, up * 0.3 + bend * 0.9], pitch: [c([[0, 0], [0.3, 16], [0.46, -26, 'in'], [0.7, 6], [1, 0]]), 0, 0], sweep: [0, 0, 0] });
        return hornbillPose(ctx, {
          up: ctx.H * 0.06 * c([[0, 0], [0.3, 0.8, 'io'], [0.46, -0.6, 'in'], [0.7, 0.2], [1, 0]]),
          root: [c([[0, 0], [0.3, 14, 'io'], [0.46, -12, 'in'], [0.7, 2], [1, 0]]), 0, 0],
          wing: { L: wing('L'), R: wing('R') },
          tail: [c([[0, 0], [0.3, -14], [0.46, 12, 'in'], [1, 0]]), 0, 0], neck: [c([[0, 0], [0.3, 10], [0.46, -10, 'in'], [1, 0]]), 0, 0], head: [c([[0, 0], [0.3, 8], [0.46, -14, 'in'], [1, 0]]), 0, 0],
          legs: { L: [c([[0, 0], [0.3, 30], [0.46, -10], [1, 0]]), 0, 0], R: [c([[0, 0], [0.3, 30], [0.46, -10], [1, 0]]), 0, 0] },
        });
      },
    },
    'monster-shoot': {
      keyTimes: { rearEnd: 0.4, expel: 0.5, holdEnd: 0.65 },
      pose(t, ctx) {
        // Wings flare wide and the body rears (anticipation), then the head thrusts forward as the wings snap back and the beak opens.
        const c = keys => curve(keys, t);
        const tremor = window01(t, 0.5, 0.54, 0.62, 0.68);
        const spread = c([[0, 0], [0.4, 40, 'io'], [0.47, 42, 'lin'], [0.52, 6, 'in'], [0.7, 14], [1, 0]]);
        const wing = (sign, ph) => ({
          flap: [spread + 9 * tremor * sin(t, 14, ph), 0.5 * spread + 11 * tremor * sin(t, 14, ph + 0.08), 0.3 * spread + 13 * tremor * sin(t, 14, ph + 0.16)],
          sweep: [c([[0, 0], [0.4, -38, 'io'], [0.52, 20, 'in'], [1, 0]]), 0, 0], pitch: [0, 0, 0],
        });
        return hornbillPose(ctx, {
          up: ctx.H * 0.03 * c([[0, 0], [0.4, 0.8], [0.52, -0.5, 'in'], [1, 0]]),
          root: [c([[0, 0], [0.4, 22, 'io'], [0.47, 23, 'lin'], [0.52, -16, 'in'], [0.7, -5], [1, 0]]), 0, 0],
          wing: { L: wing(1, 0), R: wing(-1, 0.05) },
          tail: [c([[0, 0], [0.4, -18], [0.52, 20, 'in'], [1, 0]]), 4 * tremor * sin(t, 12), 0],
          neck: [c([[0, 0], [0.4, 28], [0.47, 30, 'lin'], [0.53, -24, 'in'], [0.7, -6], [1, 0]]), 0, 0],
          head: [c([[0, 0], [0.4, 16], [0.46, 18, 'lin'], [0.54, -16, 'in'], [1, 0]]), 3 * tremor * sin(t, 13, 0.4), 0],
          beak: [c([[0, 0], [0.4, 0], [0.5, 18, 'out'], [0.66, 18, 'lin'], [0.82, 0]]), 0, 0],
          legs: { L: [c([[0, 0], [0.4, 28], [0.52, -8], [1, 0]]), 0, 0], R: [c([[0, 0], [0.4, 28], [0.52, -8], [1, 0]]), 0, 0] },
        });
      },
    },
    'monster-jump': {
      keyTimes: { crouchEnd: 0.28, takeoff: 0.3, peak: 0.5, touchdown: 0.7, compressionBottom: 0.78 },
      pose(t, ctx) {
        const c = keys => curve(keys, t), H = ctx.H;
        const up = H * c([[0, 0], [0.26, -0.07], [0.3, 0, 'in'], [0.5, 0.3, 'out2'], [0.7, 0, 'in2'], [0.78, -0.07, 'out'], [0.84, -0.06, 'lin'], [0.95, 0.008], [1, 0]]);
        const beat = (phase) => 50 * sin(t, 2.5, phase) * smoothstep((t - 0.28) / 0.06) * (1 - smoothstep((t - 0.74) / 0.06));
        const fold = c([[0, 0], [0.26, -34, 'io'], [0.3, -34, 'lin'], [0.36, 0, 'out'], [0.7, 0, 'lin'], [0.78, 38, 'out'], [0.95, 6], [1, 0]]);
        const wing = ph => ({ flap: [fold + beat(ph), (fold + beat(ph)) * 0.6, (fold + beat(ph)) * 0.4], sweep: [0, 0, 0], pitch: [0, 0, 0] });
        return hornbillPose(ctx, {
          up, root: [c([[0, 0], [0.26, 10], [0.31, -10, 'in'], [0.5, -4], [0.7, 8], [0.78, 12, 'out'], [1, 0]]), 0, 0],
          wing: { L: wing(0), R: wing(0) },
          tail: [c([[0, 0], [0.26, 12], [0.4, -10], [0.78, 14], [1, 0]]), 0, 0], neck: [c([[0, 0], [0.26, -8], [0.34, 12], [0.7, -6], [1, 0]]), 0, 0], head: [c([[0, 0], [0.26, -6], [0.34, 8], [0.7, -6], [1, 0]]), 0, 0],
          legs: { L: [c([[0, 0], [0.26, 24], [0.34, -12], [0.5, 30], [0.7, 24], [0.78, -10], [1, 0]]), 0, 0], R: [c([[0, 0], [0.26, 24], [0.34, -12], [0.5, 30], [0.7, 24], [0.78, -10], [1, 0]]), 0, 0] },
        });
      },
    },
    'monster-hurt': {
      // Flinch peaks at 0.2; the wings then droop, the head hangs and the body sinks, held 0.44-0.62 before recovering (finite consumers sample `hold`).
      keyTimes: { flinch: 0.2, hold: 0.52 },
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        const held = c([[0, 0], [0.2, 0, 'lin'], [0.44, 1, 'io'], [0.62, 1, 'lin'], [1, 0, 'io']]);
        const fl = keys => (1 - held) * curve(keys, t);
        const breath = Math.sin(TAU * 1.4 * (t - 0.44)) * held;
        const flare = fl([[0, 0], [0.2, 38, 'out'], [0.36, -10], [0.52, 8], [1, 0]]);
        const wing = ph => ({ flap: [flare - 30 * held + 2 * breath, flare * 0.7 + (1 - held) * 9 * sin(t, 4, ph) * (1 - t) - 20 * held + 2.5 * breath, flare * 0.5 + (1 - held) * 12 * sin(t, 4, ph + 0.1) * (1 - t) - 14 * held + 3 * breath], sweep: [0, 0, 0], pitch: [fl([[0, 0], [0.2, 14], [1, 0]]), 0, 0] });
        return hornbillPose(ctx, {
          up: -ctx.H * (0.02 * fl([[0, 0], [0.2, 1, 'out'], [0.5, -0.2], [1, 0]]) + 0.03 * held),
          root: [fl([[0, 0], [0.2, 18, 'out'], [0.4, -6], [0.6, 3], [1, 0]]) - 9 * held, fl([[0, 0], [0.2, -10, 'out'], [0.4, 4], [1, 0]]), fl([[0, 0], [0.2, 9, 'out'], [0.45, -4], [1, 0]]) + 3 * held],
          wing: { L: wing(0), R: wing(0.1) },
          tail: [fl([[0, 0], [0.2, -18], [0.4, 8], [1, 0]]) - 12 * held, fl([[0, 0], [0.2, 14], [0.4, -8], [1, 0]]), 0],
          neck: [fl([[0, 0], [0.2, 26, 'out'], [0.4, -6], [1, 0]]) - 20 * held + 1.5 * breath, fl([[0, 0], [0.2, -16], [0.4, 6], [1, 0]]) + 6 * held, 0],
          head: [fl([[0, 0], [0.23, 18, 'out'], [0.4, -4], [1, 0]]) - 16 * held + 2 * breath, fl([[0, 0], [0.24, -26, 'out'], [0.4, 10], [1, 0]]) + 10 * held, 0],
          legs: { L: [fl([[0, 0], [0.2, 30], [0.5, 8], [1, 0]]) + 10 * held, 0, 0], R: [fl([[0, 0], [0.2, 30], [0.5, 8], [1, 0]]) + 10 * held, 0, 0] },
        });
      },
    },
    'monster-turn': {
      pose(t, ctx) {
        const wing = (sign) => ({ flap: [24 * sin(t, 2, 0) * (1 + 0.5 * sign) + 6 * sign, 0.7 * 24 * sin(t, 2, -0.08) * (1 + 0.5 * sign), 0.5 * 24 * sin(t, 2, -0.16) * (1 + 0.5 * sign)], sweep: [sign * 12, 0, 0], pitch: [0, 0, 0] });
        return hornbillPose(ctx, {
          up: 0.01 * sin(t, 2, 0.1), root: [0, 14 * sin(t, 1, 0.05), 9 * sin(t, 1, 0.3)],
          wing: { L: wing(1), R: wing(-1) },
          tail: [0, 20 * sin(t, 1, 0.3), 0], neck: [0, 12 * sin(t, 1, 0.1), 0], head: [0, 16 * sin(t, 1, 0.12), 4 * sin(t, 1, 0.3)],
          legs: { L: [14 + 4 * sin(t, 2), 0, 0], R: [14 + 4 * sin(t, 2), 0, 0] },
        });
      },
    },
    'monster-dive': {
      keyTimes: { crouchEnd: 0.22, strike: 0.4, recoverStart: 0.55 },
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        const fold = c([[0, 0], [0.22, 1, 'io'], [0.4, 1, 'lin'], [0.58, 0.85], [0.85, 0.15], [1, 0]]);
        const wing = ph => ({
          flap: [c([[0, 0], [0.22, 38, 'io'], [0.4, 8, 'in'], [0.6, 14], [0.85, 4], [1, 0]]), 0.6 * (fold * 24), 0.5 * fold * 30],
          sweep: [fold * 58, fold * 34, fold * 18], pitch: [0, 0, 0],
        });
        return hornbillPose(ctx, {
          up: ctx.H * c([[0, 0], [0.22, 0.05], [0.4, -0.14, 'in'], [0.6, -0.1], [1, 0]]),
          root: [c([[0, 0], [0.22, 14, 'io'], [0.28, 14, 'lin'], [0.4, -58, 'in'], [0.55, -50], [0.85, -10], [1, 0]]), 0, 0],
          wing: { L: wing(0), R: wing(0) },
          tail: [c([[0, 0], [0.22, -16], [0.4, 22, 'in'], [1, 0]]), 0, 0], neck: [c([[0, 0], [0.22, 14], [0.4, 40, 'in'], [0.7, 14], [1, 0]]), 0, 0], head: [c([[0, 0], [0.22, 8], [0.4, 30, 'in'], [0.7, 10], [1, 0]]), 0, 0],
          legs: { L: [c([[0, 0], [0.22, 20], [0.4, 66, 'in'], [0.8, 30], [1, 0]]), 0, 0], R: [c([[0, 0], [0.22, 20], [0.4, 66, 'in'], [0.8, 30], [1, 0]]), 0, 0] },
        });
      },
    },
    'monster-roar': {
      keyTimes: { stamp: 0.2, shakeStart: 0.25, shakeEnd: 0.8 },
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        const raise = c([[0, 0], [0.2, 1, 'out'], [0.8, 1, 'lin'], [1, 0, 'io']]);
        const shake = window01(t, 0.22, 0.3, 0.76, 0.86);
        const wing = ph => ({
          flap: [34 * raise + 7 * shake * sin(t, 9, ph), 22 * raise + 10 * shake * sin(t, 9, ph + 0.08), 16 * raise + 12 * shake * sin(t, 9, ph + 0.16)],
          sweep: [-14 * raise, 0, 0], pitch: [0, 0, 0],
        });
        return hornbillPose(ctx, {
          up: ctx.H * (0.05 * raise + 0.006 * shake * sin(t, 9, 0.2)), root: [16 * raise + 2 * shake * sin(t, 9), 3 * shake * sin(t, 4.5), 0],
          wing: { L: wing(0), R: wing(0.04) },
          tail: [-16 * raise, 3 * shake * sin(t, 6), 0], neck: [26 * raise + 3 * shake * sin(t, 9, 0.3), 3 * shake * sin(t, 4.5), 0], head: [30 * raise + 4 * shake * sin(t, 9, 0.5), 6 * shake * sin(t, 4.5, 0.1), 0],
          beak: [16 * raise + 8 * shake * sin(t, 9, 0.7), 0, 0],
          legs: { L: [26 * raise, 0, 0], R: [26 * raise, 0, 0] },
        });
      },
    },

    // Tail-fan sweep: the tail fan lifts and cocks to one side while the body winds the other way (windup), the body snaps across and the fan
    // whips through with a travelling lag at ~0.5 (strike), rings down and settles. Wings half-flare for balance.
    'monster-tail': {
      keyTimes: { windupEnd: 0.36, strike: 0.5, followThroughEnd: 0.8 },
      strikeJoints: ctx => [ctx.tail[2]],
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        const swing = d => curve([[0, 0], [0.34, 34], [0.42, 40, 'lin'], [0.5, -56, 'in'], [0.57, -72, 'out'], [0.68, -36], [0.8, -4], [0.9, 8], [1, 0]], t - d);
        const fan = d => curve([[0, 0], [0.34, 22], [0.45, 30, 'out'], [0.52, 6, 'in'], [0.62, 18], [1, 0]], t - d);
        const weights = [0.3, 0.35, 0.4];
        const raise = c([[0, 0], [0.34, 1, 'io'], [0.5, 0.6, 'in'], [0.8, 0.2], [1, 0]]);
        const wing = sign => ({ flap: [14 * raise, 9 * raise, 6 * raise], sweep: [sign * c([[0, 0], [0.34, 8], [0.5, -10, 'in'], [1, 0]]), 0, 0], pitch: [0, 0, 0] });
        return hornbillPose(ctx, {
          up: ctx.H * 0.015 * raise,
          root: [c([[0, 0], [0.34, 4], [0.5, -3, 'in'], [1, 0]]), c([[0, 0], [0.34, 9], [0.42, 10, 'lin'], [0.5, -13, 'in'], [0.6, -10, 'out'], [0.8, -1], [1, 0]]), c([[0, 0], [0.34, 6], [0.5, -9, 'in'], [0.7, -2], [1, 0]])],
          wing: { L: wing(1), R: wing(-1) },
          tailJoints: weights.map((w, i) => [fan(0.03 * i) * w, swing(0.03 * i) * w, 0]),
          neck: [0, c([[0, 0], [0.34, -6], [0.5, 8, 'in'], [0.62, 5], [0.85, 0], [1, 0]]), 0],
          head: [0, c([[0, 0], [0.34, -8], [0.5, 10, 'in'], [0.62, 6], [0.85, 0], [1, 0]]), 0],
          legs: { L: [8, 0, 0], R: [8, 0, 0] },
        });
      },
    },
  },
};

// ---------------------------------------------------------------------------------------------
// Viper (serpentine, Tripo rig v2.5). Head toward -Z; left = -X. Spine chain: Root > bone_1 > Tail_0..Tail_9, head chain Head_0..5.
// ---------------------------------------------------------------------------------------------
function viperContext(rig) {
  const j = name => rig.index(name);
  const ctx = { rig, body: new BodyFrame(V(0, 0, -1)), H: 0.495, castSocketBone: 'tripo::Head_1' };
  ctx.root = j('tripo::Root'); ctx.neckBase = j('bone_1');
  ctx.spine = Array.from({ length: 10 }, (_, i) => j(`tripo::Tail_${i}`));
  ctx.head = Array.from({ length: 6 }, (_, i) => j(`tripo::Head_${i}`));
  ctx.restP = rig.world(rig.restLocals()).P;
  ctx.pivot = ctx.restP[ctx.neckBase].clone();
  ctx.translationJoints = [ctx.root];
  ctx.hipsJoint = ctx.neckBase;
  ctx.rootJoint = ctx.root;
  ctx.strikeJoints = [ctx.head[0]];
  return ctx;
}

/**
 * Viper pose. ctl: { rear: [pitch, yaw, roll] of the neck/head about the neck base, head: [..] per head joint share,
 * wave: { amp, k, phase, from } travelling lateral wave down the spine chain, lash: tail-weighted extra yaw }.
 */
function viperPose(ctx, ctl) {
  const { rig, body } = ctx;
  const pb = new PoseBuilder(rig);
  if (ctl.rear) {
    const q = body.euler(ctl.rear);
    pb.rotateAbout(ctx.root, q, ctx.pivot);
    // The whole body hangs below Root: hold the neck base's world orientation and position so only the raised neck / head move.
    pb.rotate(ctx.neckBase, q.clone().invert());
  }
  const spread = (joints, angles, weights) => {
    const total = weights.reduce(sum, 0);
    joints.forEach((joint, i) => pb.rotate(joint, body.euler(angles.map(v => v * weights[i] / total))));
  };
  if (ctl.head) spread(ctx.head, ctl.head, [0.34, 0.26, 0.2, 0.1, 0.05, 0.05]);
  const wave = ctl.wave;
  if (wave) ctx.spine.forEach((joint, i) => {
    const amp = wave.amp * (wave.taper ? 0.4 + 0.6 * (i / 9) ** wave.taper : 1);
    pb.rotate(joint, body.yaw(amp * sin(wave.t, wave.cycles ?? 1, -(i + 1) * (wave.k ?? 0.07) + (wave.phase ?? 0))));
  });
  if (ctl.chain) pb.rotate(ctx.neckBase, body.yaw(ctl.chain));
  // Travelling tail lash: lash(i) is the extra yaw (degrees) of spine joint i (0 = body end, 9 = tail tip).
  if (ctl.lash) ctx.spine.forEach((joint, i) => pb.rotate(joint, body.yaw(ctl.lash(i))));
  return { pb };
}

const VIPER = {
  setup: viperContext,
  presetMapping: { 'monster-walk': { preserved: 'preset:serpentine:march' } },
  slots: [...MONSTER_SLOTS, MONSTER_TAIL_SLOT],
  clips: {
    'monster-idle': {
      pose(t, ctx) {
        return viperPose(ctx, {
          rear: [4 * sin(t, 1, 0.2) + 1.6 * sin(t, 2), 11 * sin(t, 1), 2.5 * sin(t, 1, 0.3)],
          head: [4 * sin(t, 2, 0.3), 10 * sin(t, 1, -0.12), 3 * sin(t, 1, 0.1)],
          wave: { t, cycles: 1, amp: 3.6, k: 0.08, taper: 1.5 },
        });
      },
    },
    'monster-run': {
      pose(t, ctx) {
        return viperPose(ctx, {
          rear: [-2 + 2 * sin(t, 2, 0.3), 10 * sin(t, 2, 0.1), 4 * sin(t, 2, 0.4)],
          head: [-3 + 2 * sin(t, 2, 0.5), 14 * sin(t, 2, -0.1), 0],
          wave: { t, cycles: 3, amp: 12, k: 0.08, taper: 0.8 },
        });
      },
    },
    'monster-slash': {
      keyTimes: { windupEnd: 0.35, strike: 0.45, followThroughEnd: 0.7 },
      pose(t, ctx) {
        // Side lash: the neck coils back and cocks to one side with the body drawn into an S (anticipation), then whips across with overshoot and a rebound.
        const c = keys => curve(keys, t);
        return viperPose(ctx, {
          rear: [c([[0, 0], [0.33, 22, 'io'], [0.46, -8, 'in'], [0.7, 5], [1, 0]]), c([[0, 0], [0.33, 40, 'io'], [0.46, -46, 'in'], [0.52, -54, 'out'], [0.62, -18], [0.7, -26, 'io'], [0.85, -4], [1, 0]]), c([[0, 0], [0.33, 10], [0.46, -12, 'in'], [1, 0]])],
          head: [c([[0, 0], [0.33, 10], [0.46, -14, 'in'], [1, 0]]), c([[0, 0], [0.33, 52, 'io'], [0.46, -58, 'in'], [0.52, -68, 'out'], [0.62, -14, 'out'], [1, 0]]), 0],
          wave: { t, cycles: 1, amp: c([[0, 0], [0.33, 4], [0.5, 12], [1, 0]]), k: 0.12, taper: 1.2 },
        });
      },
    },
    'monster-shoot': {
      keyTimes: { rearEnd: 0.4, expel: 0.5, holdEnd: 0.65 },
      pose(t, ctx) {
        // Rear up and inflate (neck raised high), then throw the head forward and down to spit, recoil and hold.
        const c = keys => curve(keys, t);
        const tremor = window01(t, 0.5, 0.54, 0.62, 0.68);
        return viperPose(ctx, {
          rear: [c([[0, 0], [0.12, -3, 'out'], [0.4, 48, 'io'], [0.47, 50, 'lin'], [0.52, -24, 'in'], [0.6, -10, 'out'], [0.67, -11, 'lin'], [1, 0]]), 3 * tremor * sin(t, 13, 0.2), 0],
          head: [c([[0, 0], [0.4, 28, 'io'], [0.47, 32, 'lin'], [0.53, -28, 'in'], [0.6, -10, 'out'], [0.67, -10, 'lin'], [1, 0]]), 4 * tremor * sin(t, 13, 0.5), 0],
          wave: { t, cycles: 2, amp: c([[0, 0], [0.4, 3], [0.52, 8], [1, 0]]), k: 0.1, taper: 1.2 },
        });
      },
    },
    'monster-jump': {
      keyTimes: { crouchEnd: 0.28, takeoff: 0.3, peak: 0.5, touchdown: 0.7, compressionBottom: 0.78 },
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        return viperPose(ctx, {
          rear: [c([[0, 0], [0.26, -8, 'io'], [0.31, 44, 'in'], [0.5, 58, 'out2'], [0.7, 14, 'in'], [0.78, -16, 'out'], [0.95, 2], [1, 0]]), c([[0, 0], [0.26, 6], [0.5, -4], [1, 0]]), 0],
          head: [c([[0, 0], [0.26, -10], [0.34, 16], [0.5, 22], [0.7, -4], [0.8, -14, 'out'], [1, 0]]), 0, 0],
          wave: { t, cycles: 1, amp: c([[0, 0], [0.26, 5], [0.5, 2], [0.78, 7], [1, 0]]), k: 0.12, taper: 1.2 },
        });
      },
    },
    'monster-hurt': {
      // Flinch peaks at 0.2; the neck then slumps and the head hangs low, held 0.44-0.62 before recovering (finite consumers sample `hold`).
      keyTimes: { flinch: 0.2, hold: 0.52 },
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        const held = c([[0, 0], [0.2, 0, 'lin'], [0.44, 1, 'io'], [0.62, 1, 'lin'], [1, 0, 'io']]);
        const fl = keys => (1 - held) * curve(keys, t);
        const breath = Math.sin(TAU * 1.4 * (t - 0.44)) * held;
        return viperPose(ctx, {
          rear: [fl([[0, 0], [0.2, 22, 'out'], [0.4, -4], [0.6, 3], [1, 0]]) - 16 * held + 1.5 * breath, fl([[0, 0], [0.2, -18, 'out'], [0.4, 8], [0.6, -3], [1, 0]]) + 8 * held, fl([[0, 0], [0.2, 10, 'out'], [0.5, -3], [1, 0]]) + 3 * held],
          head: [fl([[0, 0], [0.23, 16, 'out'], [0.4, -4], [1, 0]]) - 14 * held + 2 * breath, fl([[0, 0], [0.24, -30, 'out'], [0.4, 12], [0.56, -4], [1, 0]]) + 12 * held, 0],
          wave: { t, cycles: 3, amp: fl([[0, 0], [0.2, 16, 'out'], [0.5, 5], [1, 0]]) + 1.5 * held * Math.abs(breath), k: 0.14, taper: 0.8 },
        });
      },
    },
    'monster-turn': {
      pose(t, ctx) {
        return viperPose(ctx, {
          rear: [2, 12 * sin(t, 1, 0.1), 3 * sin(t, 1, 0.4)],
          head: [0, 8 * sin(t, 1, 0.2), 0],
          wave: { t, cycles: 2, amp: 18, k: 0.1, taper: 1.8 },
          chain: 5 * sin(t, 1, 0.3),
        });
      },
    },
    'monster-dive': {
      keyTimes: { crouchEnd: 0.22, strike: 0.4, recoverStart: 0.55 },
      pose(t, ctx) {
        // Serpent strike: draw the neck back into a high S-coil (anticipation), launch the head down the lane, overshoot and recoil.
        const c = keys => curve(keys, t);
        return viperPose(ctx, {
          rear: [c([[0, 0], [0.22, 34, 'io'], [0.28, 34, 'lin'], [0.4, -42, 'in'], [0.5, -36, 'out'], [0.62, -26], [0.8, -4], [1, 0]]), c([[0, 0], [0.22, -4], [0.4, 2], [1, 0]]), 0],
          head: [c([[0, 0], [0.22, 24], [0.28, 24, 'lin'], [0.4, -38, 'in'], [0.55, -16, 'out'], [1, 0]]), 0, 0],
          wave: { t, cycles: 1, amp: c([[0, 0], [0.22, 7], [0.4, 14], [0.7, 6], [1, 0]]), k: 0.1, taper: 1.2 },
        });
      },
    },
    'monster-roar': {
      keyTimes: { stamp: 0.2, shakeStart: 0.25, shakeEnd: 0.8 },
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        const raise = c([[0, 0], [0.2, 1, 'out'], [0.8, 1, 'lin'], [1, 0, 'io']]);
        const shake = window01(t, 0.22, 0.3, 0.76, 0.86);
        return viperPose(ctx, {
          rear: [50 * raise + 3 * shake * sin(t, 9, 0.2), 8 * shake * sin(t, 4.5), 4 * shake * sin(t, 4.5, 0.3)],
          head: [32 * raise + 5 * shake * sin(t, 9, 0.5), 10 * shake * sin(t, 4.5, 0.1), 0],
          wave: { t, cycles: 3, amp: 3 * raise + 2 * shake, k: 0.1, taper: 1.2 },
        });
      },
    },

    // Tail lash: the body draws into an S with the tail cocked to one side while the head keeps watch (windup), the lash travels down the chain
    // from the body to the tip and cracks across at ~0.5 (strike), rings down and settles.
    'monster-tail': {
      keyTimes: { windupEnd: 0.36, strike: 0.5, followThroughEnd: 0.8 },
      strikeJoints: ctx => [ctx.spine[9]],
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        const keys = [[0, 0], [0.34, 9], [0.42, 10, 'lin'], [0.5, -15, 'in'], [0.57, -20, 'out'], [0.68, -10], [0.78, -1], [0.88, 3], [1, 0]];
        return viperPose(ctx, {
          rear: [c([[0, 0], [0.34, 6], [0.5, -3, 'in'], [1, 0]]), c([[0, 0], [0.34, -8], [0.5, 10, 'in'], [0.62, 6, 'out'], [0.85, 0], [1, 0]]), 0],
          head: [0, c([[0, 0], [0.34, -6], [0.5, 8, 'in'], [1, 0]]), 0],
          lash: i => curve(keys, t - 0.026 * i) * (0.35 + 0.65 * (i / 9) ** 1.3),
        });
      },
    },
  },
};

// ---------------------------------------------------------------------------------------------
// Lantern Heron (avian, Tripo rig v2.5, wings spread at rest). Faces +X; left = -Z. GROUND-BOUND WADER: both feet are IK
// targets in every clip (Limb_0 -> Limb_1 -> Limb_2, knee pole pointing back like a bird's ankle), the root never rises above the
// rest height except in the short wing-assisted hop, and the S-curved neck (bone_1 .. Head_5) is posed as one chain.
// Wings: left bone_14 > bone_15 > bone_16 > bone_17 (primaries follow); right Spine_1 > bone_25 > bone_26 > bone_27.
// ---------------------------------------------------------------------------------------------
function heronContext(rig) {
  const j = name => rig.index(name);
  const body = new BodyFrame(V(1, 0, 0));
  const ctx = { rig, body, H: 0.598, castSocketBone: 'tripo::Head_5' };
  ctx.root = j('tripo::Root'); ctx.hips = j('tripo::Spine_0');
  const restP = ctx.restP = rig.world(rig.restLocals()).P;
  ctx.wing = { L: ['bone_14', 'bone_15', 'bone_16', 'bone_17'].map(j), R: ['tripo::Spine_1', 'bone_25', 'bone_26', 'bone_27'].map(j) };
  if (!(restP[ctx.wing.L[3]].z < -0.15 && restP[ctx.wing.R[3]].z > 0.15)) throw new Error('Heron wing joints are not where the clip set expects them (left wing at -Z)');
  ctx.leg = { L: ['tripo::0_Left_Limb_0', 'tripo::0_Left_Limb_1', 'tripo::0_Left_Limb_2'].map(j), R: ['tripo::0_Right_Limb_0', 'tripo::0_Right_Limb_1', 'tripo::0_Right_Limb_2'].map(j) };
  ctx.neckChain = ['bone_1', 'bone_2', 'tripo::Head_0', 'tripo::Head_1', 'tripo::Head_2', 'tripo::Head_3', 'tripo::Head_4', 'tripo::Head_5'].map(j);
  ctx.beakLower = j('tripo::Head_6'); ctx.beakUpper = j('bone_9');
  ctx.tail = ['bone_12', 'bone_13'].map(j);
  // Pitch angle (degrees above +F) of every neck segment at rest: neck.ext blends all of them towards one target angle.
  ctx.neckAngles = ctx.neckChain.map((joint, i) => {
    const next = i + 1 < ctx.neckChain.length ? ctx.neckChain[i + 1] : ctx.beakLower, d = restP[next].clone().sub(restP[joint]);
    return Math.atan2(d.dot(body.U), d.dot(body.F)) / DEG;
  });
  // Knee pole: the way the rest knee bulges away from the hip -> ankle line (backwards for a bird).
  ctx.legHint = {};
  for (const side of ['L', 'R']) {
    const [hip, knee, ankle] = ctx.leg[side], axis = restP[ankle].clone().sub(restP[hip]).normalize();
    const rel = restP[knee].clone().sub(restP[hip]);
    ctx.legHint[side] = rel.addScaledVector(axis, -rel.dot(axis)).lengthSq() > 1e-8 ? rel.normalize() : body.F.clone().negate();
  }
  ctx.translationJoints = [ctx.root];
  ctx.hipsJoint = ctx.hips;
  ctx.rootJoint = ctx.root;
  ctx.strikeJoints = [ctx.beakUpper];
  return ctx;
}

/**
 * Heron pose. ctl: { up, fwd, left (root translation, units), root: [pitch, yaw, roll] about the hips,
 *   neck: { ext, T, pitch, yaw, roll }  ext blends every neck segment towards pitch angle T (ext < 0 coils the S tighter),
 *   head: [..] on Head_5, beak: opening degrees, tail: [..],
 *   wing: { L, R } each { flap[4], sweep[4], pitch[4] } (degrees, as in the hornbill set),
 *   feet: { L, R } = [forward, up, left] offsets of the planted ankle from its rest position }.
 */
function heronPose(ctx, ctl) {
  const { rig, body } = ctx;
  const pb = new PoseBuilder(rig);
  if (ctl.root) pb.rotateAbout(ctx.root, body.euler(ctl.root), ctx.restP[ctx.hips]);
  if (ctl.up || ctl.fwd || ctl.left) pb.translate(ctx.root, body.at(V(0, 0, 0), ctl.fwd ?? 0, ctl.up ?? 0, ctl.left ?? 0));
  if (ctl.neck) {
    const { ext = 0, T = 0, pitch = 0, yaw = 0, roll = 0 } = ctl.neck, n = ctx.neckChain.length;
    let previous = 0;
    ctx.neckChain.forEach((joint, i) => {
      const cumulative = ext * (T - ctx.neckAngles[i]);
      pb.rotate(joint, body.euler([cumulative - previous + pitch / n, yaw / n, roll / n]));
      previous = cumulative;
    });
  }
  if (ctl.head) pb.rotate(ctx.neckChain.at(-1), body.euler(ctl.head));
  if (ctl.beak) { pb.rotate(ctx.beakLower, body.pitch(-ctl.beak)); pb.rotate(ctx.beakUpper, body.pitch(ctl.beak * 0.6)); }
  if (ctl.tail) ctx.tail.forEach(joint => pb.rotate(joint, body.euler(ctl.tail.map(v => v / 2))));
  if (ctl.tailJoints) ctx.tail.forEach((joint, i) => pb.rotate(joint, body.euler(ctl.tailJoints[i])));
  for (const side of ['L', 'R']) {
    const w = ctl.wing?.[side];
    if (!w) continue;
    const sign = side === 'L' ? 1 : -1;
    ctx.wing[side].forEach((joint, i) => {
      if (w.flap?.[i]) pb.rotate(joint, new Quaternion().setFromAxisAngle(body.F, sign * w.flap[i] * DEG));
      if (w.sweep?.[i]) pb.rotate(joint, new Quaternion().setFromAxisAngle(body.U, sign * w.sweep[i] * DEG));
      if (w.pitch?.[i]) pb.rotate(joint, new Quaternion().setFromAxisAngle(body.L, sign * w.pitch[i] * DEG));
    });
  }
  for (const side of ['L', 'R']) {
    const [hip, knee, ankle] = ctx.leg[side], off = ctl.feet?.[side] ?? [0, 0, 0];
    pb.reach(hip, knee, ankle, body.at(ctx.restP[ankle], off[0], off[1], off[2]), ctx.legHint[side], true);
  }
  return { pb };
}

/**
 * Symmetric wing set from a few controls: raise (degrees, shoulder; the rest pose is 0), bend (elbow / wrist droop), sweep (back),
 * lead (leading-edge pitch) and a travelling flutter { amp, cycles, lag } (t is the clip phase).
 */
function heronWings(t, { raise = 0, bend = 0, sweep = 0, lead = 0, flutter = 0, cycles = 2, lag = 0.07, asym = 0 } = {}) {
  const side = (sign, phase) => {
    const f = delay => flutter * sin(t, cycles, phase - delay);
    const r = raise * (1 + sign * asym);
    return {
      flap: [r + f(0), r * 0.5 + bend + f(lag) * 0.8, r * 0.3 + bend * 0.8 + f(2 * lag) * 0.7, r * 0.2 + bend * 0.6 + f(3 * lag) * 0.6],
      sweep: [sweep, sweep * 0.5, sweep * 0.3, 0],
      pitch: [lead + flutter * 0.4 * sin(t, cycles, phase - 0.25), lead * 0.6, 0, 0],
    };
  };
  return { L: side(1, 0), R: side(-1, 0.04) };
}

/** One foot of a wading stride: planted (sliding back) for `duty` of the cycle, then a lifted swing arc. t0 offsets the phase. */
function heronStep(t, t0, stride, lift, duty) {
  const s = (((t - t0) % 1) + 1) % 1;
  if (s < duty) return [stride * (0.5 - s / duty), 0, 0];
  const k = (s - duty) / (1 - duty);
  return [stride * (-0.5 + smoothstep(k)), lift * Math.sin(Math.PI * k), 0];
}

const HERON = {
  setup: heronContext,
  presetMapping: {},
  cleanWeights: {},
  slots: [...MONSTER_SLOTS, MONSTER_TAIL_SLOT],
  clips: {
    'monster-idle': {
      pose(t, ctx) {
        const breath = sin(t, 2);
        return heronPose(ctx, {
          up: -0.008 + 0.004 * breath, root: [1.2 * breath, 2 * sin(t, 1, 0.1), 1.5 * sin(t, 1, 0.3)],
          neck: { pitch: 3 * sin(t, 1, 0.2), yaw: 14 * sin(t, 1, 0.05) + 4 * sin(t, 2, 0.3) },
          head: [3 * sin(t, 2, 0.1), 5 * sin(t, 1, 0.4), 2 * sin(t, 1, 0.2)],
          wing: heronWings(t, { raise: 5 * sin(t, 1), bend: 4 * sin(t, 1, -0.1), flutter: 4, cycles: 3 }),
          tail: [3 * sin(t, 2, 0.3), 4 * sin(t, 1, 0.1), 0],
        });
      },
    },
    'monster-walk': {
      pose(t, ctx) {
        return heronPose(ctx, {
          up: -0.022 - 0.006 * sin(t, 2, 0.25), left: 0.012 * sin(t, 1, 0.25), root: [-4 + 1.5 * sin(t, 2), 3 * sin(t, 1, 0.5), 2 * sin(t, 1, 0.25)],
          neck: { pitch: 4 * sin(t, 2, 0.2), yaw: 5 * sin(t, 1, 0.6) }, head: [3 * sin(t, 2, 0.45), 0, 0],
          wing: heronWings(t, { raise: -22, bend: -8, sweep: 30, flutter: 3, cycles: 2 }),
          tail: [3 * sin(t, 2, 0.3), 5 * sin(t, 1, 0.1), 0],
          feet: { L: heronStep(t, 0, 0.1, 0.05, 0.6), R: heronStep(t, 0.5, 0.1, 0.05, 0.6) },
        });
      },
    },
    'monster-run': {
      pose(t, ctx) {
        return heronPose(ctx, {
          up: -0.04 - 0.008 * sin(t, 2, 0.1), left: 0.014 * sin(t, 1, 0.25), root: [-9 + 2 * sin(t, 2, 0.3), 4 * sin(t, 1, 0.5), 3 * sin(t, 1, 0.25)],
          neck: { ext: 0.5, T: 8, pitch: 2 * sin(t, 2, 0.2) }, head: [2 * sin(t, 2, 0.45), 0, 0],
          wing: heronWings(t, { raise: -28, bend: -14, sweep: 52, flutter: 8, cycles: 2 }),
          tail: [8, 5 * sin(t, 1, 0.1), 0],
          feet: { L: heronStep(t, 0, 0.15, 0.07, 0.5), R: heronStep(t, 0.5, 0.15, 0.07, 0.5) },
        });
      },
    },
    'monster-slash': {
      keyTimes: { windupEnd: 0.35, strike: 0.45, followThroughEnd: 0.7 },
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        const lead = c([[0, 0], [0.4, 0, 'lin'], [0.48, 0.05, 'out'], [0.66, 0.05, 'lin'], [0.82, 0]]);
        return heronPose(ctx, {
          up: c([[0, 0], [0.33, -0.015], [0.46, -0.035, 'in'], [0.7, -0.01], [1, 0]]),
          fwd: c([[0, 0], [0.33, -0.01], [0.46, 0.05, 'in'], [0.7, 0.01], [1, 0]]),
          root: [c([[0, 0], [0.33, 5], [0.46, -16, 'in'], [0.7, -4], [1, 0]]), 0, 0],
          neck: {
            ext: c([[0, 0], [0.33, -0.32], [0.4, -0.34, 'lin'], [0.46, 1, 'in'], [0.56, 0.95, 'lin'], [0.74, 0.2], [1, 0]]),
            T: c([[0, 60], [0.33, 95], [0.46, 14, 'in'], [0.56, 14, 'lin'], [0.8, 60], [1, 60]]),
          },
          head: [c([[0, 0], [0.33, 8], [0.46, -8, 'in'], [0.7, 0], [1, 0]]), 0, 0],
          beak: c([[0, 0], [0.46, 0, 'lin'], [0.5, 9, 'out'], [0.62, 9, 'lin'], [0.8, 0]]),
          wing: heronWings(t, {
            raise: c([[0, 0], [0.33, 30], [0.46, 12, 'in'], [0.7, 10], [1, 0]]), sweep: c([[0, 0], [0.33, -15], [0.46, 20, 'in'], [0.7, 8], [1, 0]]),
            bend: c([[0, 0], [0.33, 10], [0.46, -14, 'in'], [1, 0]]), lead,
          }),
          tail: [c([[0, 0], [0.33, -8], [0.46, 12, 'in'], [1, 0]]), 0, 0],
          feet: { L: [c([[0, 0], [0.34, 0, 'lin'], [0.5, 0.06], [0.75, 0], [1, 0]]), c([[0, 0], [0.34, 0, 'lin'], [0.42, 0.04, 'out'], [0.5, 0, 'in'], [1, 0]]), 0], R: [0, 0, 0] },
        });
      },
    },
    'monster-shoot': {
      keyTimes: { rearEnd: 0.4, expel: 0.5, holdEnd: 0.65 },
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        const tremor = window01(t, 0.5, 0.54, 0.62, 0.68);
        return heronPose(ctx, {
          up: c([[0, 0], [0.4, -0.02], [0.52, -0.005, 'in'], [1, 0]]),
          root: [c([[0, 0], [0.4, 8], [0.47, 9, 'lin'], [0.52, -6, 'in'], [0.7, -2], [1, 0]]), 0, 0],
          neck: {
            ext: c([[0, 0], [0.4, -0.45], [0.47, -0.45, 'lin'], [0.53, 0.6, 'in'], [0.7, 0.2], [1, 0]]),
            T: c([[0, 60], [0.4, 95], [0.47, 95, 'lin'], [0.53, 50, 'in'], [0.8, 60], [1, 60]]),
            yaw: 4 * tremor * sin(t, 13, 0.2),
          },
          head: [c([[0, 0], [0.4, 6], [0.54, -8, 'in'], [1, 0]]), 3 * tremor * sin(t, 13, 0.5), 0],
          beak: c([[0, 0], [0.4, 0], [0.5, 18, 'out'], [0.66, 18, 'lin'], [0.82, 0]]),
          wing: heronWings(t, {
            raise: c([[0, 0], [0.4, 45], [0.47, 50, 'lin'], [0.52, 22, 'in'], [0.7, 30], [1, 0]]) + 4 * tremor,
            sweep: c([[0, 0], [0.4, 16], [0.47, 18, 'lin'], [0.53, -34, 'in'], [0.7, -20], [1, 0]]),
            bend: c([[0, 0], [0.4, 14], [0.52, -6, 'in'], [1, 0]]), flutter: 12 * tremor, cycles: 14, lag: 0.03,
          }),
          tail: [c([[0, 0], [0.4, -10], [0.52, 12, 'in'], [1, 0]]), 4 * tremor * sin(t, 12), 0],
        });
      },
    },
    'monster-jump': {
      keyTimes: { crouchEnd: 0.28, takeoff: 0.3, peak: 0.5, touchdown: 0.7, compressionBottom: 0.78 },
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        const up = c([[0, 0], [0.26, -0.035], [0.3, 0, 'in'], [0.5, 0.09, 'out2'], [0.7, 0, 'in2'], [0.78, -0.04, 'out'], [0.84, -0.035, 'lin'], [0.95, -0.004], [1, 0]]);
        const air = c([[0, 0], [0.3, 0, 'lin'], [0.4, 1, 'out'], [0.6, 1, 'lin'], [0.7, 0, 'in'], [1, 0]]);
        const lift = Math.max(up, 0) + 0.05 * air;
        const beat = phase => 30 * sin(t, 2.5, phase) * smoothstep((t - 0.28) / 0.06) * (1 - smoothstep((t - 0.6) / 0.08));
        const fold = c([[0, 0], [0.26, -14, 'io'], [0.3, -14, 'lin'], [0.36, 10, 'out'], [0.7, 10, 'lin'], [0.78, -6, 'out'], [0.95, -1], [1, 0]]);
        return heronPose(ctx, {
          up, root: [c([[0, 0], [0.26, 6], [0.31, -8, 'in'], [0.5, -4], [0.7, 6], [0.78, 9, 'out'], [1, 0]]), 0, 0],
          neck: { pitch: c([[0, 0], [0.26, -8], [0.34, 12], [0.7, -6], [0.8, -8, 'out'], [1, 0]]) }, head: [c([[0, 0], [0.26, -6], [0.34, 8], [0.7, -4], [1, 0]]), 0, 0],
          wing: heronWings(t, { raise: fold + beat(0), bend: 0.4 * (fold + beat(0)), sweep: 6 * air }),
          tail: [c([[0, 0], [0.26, 10], [0.4, -8], [0.78, 12], [1, 0]]), 0, 0],
          feet: { L: [0.02 * air, lift, 0], R: [0.02 * air, lift, 0] },
        });
      },
    },
    'monster-hurt': {
      // Flinch peaks at 0.2; the neck then droops, the wings sag and the body sinks, held 0.44-0.62 before recovering (finite consumers sample `hold`).
      keyTimes: { flinch: 0.2, hold: 0.52 },
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        const held = c([[0, 0], [0.2, 0, 'lin'], [0.44, 1, 'io'], [0.62, 1, 'lin'], [1, 0, 'io']]);
        const fl = keys => (1 - held) * curve(keys, t);
        const breath = Math.sin(TAU * 1.4 * (t - 0.44)) * held;
        return heronPose(ctx, {
          up: -0.02 * fl([[0, 0], [0.2, 1, 'out'], [0.5, 0.2], [1, 0]]) - 0.008 * held,
          root: [fl([[0, 0], [0.2, 14, 'out'], [0.4, -4], [0.6, 2], [1, 0]]) - 4 * held, fl([[0, 0], [0.2, -9, 'out'], [0.4, 3], [1, 0]]), fl([[0, 0], [0.2, 8, 'out'], [0.45, -3], [1, 0]]) + 2 * held],
          neck: { ext: fl([[0, 0], [0.2, -0.4, 'out'], [0.4, 0.05], [1, 0]]), T: 95, pitch: -10 * held + 1.5 * breath, yaw: fl([[0, 0], [0.2, -18, 'out'], [0.4, 6], [1, 0]]) + 10 * held },
          head: [fl([[0, 0], [0.23, 16, 'out'], [0.4, -4], [1, 0]]) - 14 * held + 2 * breath, fl([[0, 0], [0.24, -22, 'out'], [0.4, 8], [1, 0]]), 0],
          beak: fl([[0, 0], [0.22, 14, 'out'], [0.5, 4], [0.7, 0]]),
          wing: heronWings(t, { raise: fl([[0, 0], [0.2, 36, 'out'], [0.36, -8], [0.52, 6], [1, 0]]) - 24 * held, flutter: (1 - held) * 9 * (1 - t) + 1.5 * breath, cycles: 4, bend: fl([[0, 0], [0.2, -8], [1, 0]]) - 14 * held }),
          tail: [fl([[0, 0], [0.2, -16], [0.4, 8], [1, 0]]) - 10 * held, fl([[0, 0], [0.2, 12], [0.4, -8], [1, 0]]), 0],
        });
      },
    },
    'monster-turn': {
      pose(t, ctx) {
        return heronPose(ctx, {
          up: -0.018 - 0.004 * sin(t, 2, 0.1), root: [1 * sin(t, 2, 0.2), 14 * sin(t, 1, 0.05), 5 * sin(t, 1, 0.3)],
          neck: { yaw: -22 * sin(t, 1, 0.05), pitch: 2 }, head: [0, 10 * sin(t, 1, 0.12), 3 * sin(t, 1, 0.3)],
          wing: heronWings(t, { raise: -2, sweep: 16, flutter: 9, cycles: 2, asym: 0.5 }),
          tail: [0, 14 * sin(t, 1, 0.3), 0],
          feet: { L: heronStep(t, 0, 0.0, 0.04, 0.55).map((v, i) => (i === 2 ? 0.03 * (1 - 2 * ((((t) % 1) + 1) % 1)) : v)), R: heronStep(t, 0.5, 0.0, 0.04, 0.55) },
        });
      },
    },
    'monster-dive': {
      keyTimes: { crouchEnd: 0.22, strike: 0.4, recoverStart: 0.55 },
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        return heronPose(ctx, {
          up: c([[0, 0], [0.22, -0.03, 'io'], [0.28, -0.03, 'lin'], [0.4, -0.05, 'in'], [0.55, -0.045], [0.85, -0.01], [1, 0]]),
          fwd: c([[0, 0], [0.22, -0.01], [0.4, 0.05, 'in'], [0.55, 0.05, 'lin'], [0.85, 0.01], [1, 0]]),
          root: [c([[0, 0], [0.22, 8, 'io'], [0.28, 8, 'lin'], [0.4, -24, 'in'], [0.55, -20], [0.85, -4], [1, 0]]), 0, 0],
          neck: {
            ext: c([[0, 0], [0.22, -0.3], [0.28, -0.3, 'lin'], [0.4, 1, 'in'], [0.56, 0.9, 'lin'], [0.85, 0.15], [1, 0]]),
            T: c([[0, 60], [0.22, 95], [0.28, 95, 'lin'], [0.4, 10, 'in'], [0.56, 10, 'lin'], [0.85, 40], [1, 60]]),
          },
          head: [c([[0, 0], [0.22, 6], [0.4, -10, 'in'], [0.7, 0], [1, 0]]), 0, 0],
          beak: c([[0, 0], [0.38, 0], [0.43, 12, 'out'], [0.56, 12, 'lin'], [0.7, 0]]),
          wing: heronWings(t, {
            raise: c([[0, 0], [0.22, 24], [0.4, 30, 'io'], [0.6, 22], [0.85, 6], [1, 0]]), sweep: c([[0, 0], [0.22, 0], [0.4, 46, 'in'], [0.6, 36], [0.85, 8], [1, 0]]),
            bend: c([[0, 0], [0.4, -16], [1, 0]]),
          }),
          tail: [c([[0, 0], [0.22, -14], [0.4, 24, 'in'], [1, 0]]), 0, 0],
          feet: { L: [c([[0, 0], [0.2, 0, 'lin'], [0.42, 0.09, 'io'], [0.55, 0.09, 'lin'], [0.8, 0, 'io'], [1, 0]]), c([[0, 0], [0.26, 0, 'lin'], [0.34, 0.05, 'out'], [0.43, 0, 'in'], [1, 0]]), 0], R: [0, 0, 0] },
        });
      },
    },
    'monster-roar': {
      keyTimes: { stamp: 0.2, shakeStart: 0.25, shakeEnd: 0.8 },
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        const raise = c([[0, 0], [0.2, 1, 'out'], [0.8, 1, 'lin'], [1, 0, 'io']]);
        const shake = window01(t, 0.22, 0.3, 0.76, 0.86);
        return heronPose(ctx, {
          up: -0.012 * raise + 0.003 * shake * sin(t, 9, 0.2), root: [14 * raise + 2 * shake * sin(t, 9), 3 * shake * sin(t, 4.5), 1.5 * shake * sin(t, 4.5, 0.25)],
          neck: { ext: 0.95 * raise, T: 92, pitch: 3 * shake * sin(t, 9, 0.3), yaw: 5 * shake * sin(t, 4.5) },
          head: [28 * raise + 4 * shake * sin(t, 9, 0.5), 5 * shake * sin(t, 4.5, 0.1), 0],
          beak: 26 * raise + 8 * shake * sin(t, 9, 0.7),
          wing: heronWings(t, { raise: 40 * raise, bend: 8 * raise, sweep: -14 * raise, lead: 8 * raise, flutter: 14 * shake, cycles: 9, lag: 0.05 }),
          tail: [12 * raise, 4 * shake * sin(t, 6), 0],
        });
      },
    },

    // Tail flick: the short tail cocks up and to one side while the hips wind the other way (windup), then the body snaps across and the tail
    // whips through with a travelling lag at ~0.5 (strike), rings down and settles. Feet stay planted.
    'monster-tail': {
      keyTimes: { windupEnd: 0.36, strike: 0.5, followThroughEnd: 0.8 },
      strikeJoints: ctx => [ctx.tail[1]],
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        const swing = d => curve([[0, 0], [0.34, 36], [0.42, 42, 'lin'], [0.5, -60, 'in'], [0.57, -76, 'out'], [0.68, -38], [0.8, -4], [0.9, 8], [1, 0]], t - d);
        const rise = d => curve([[0, 0], [0.34, 14], [0.45, 22, 'out'], [0.52, 4, 'in'], [0.62, 12], [1, 0]], t - d);
        return heronPose(ctx, {
          root: [c([[0, 0], [0.34, 3], [0.5, -2, 'in'], [1, 0]]), c([[0, 0], [0.34, 8], [0.42, 9, 'lin'], [0.5, -12, 'in'], [0.6, -9, 'out'], [0.8, -1], [1, 0]]), c([[0, 0], [0.34, 4], [0.5, -6, 'in'], [0.7, -1], [1, 0]])],
          neck: { pitch: 0, yaw: c([[0, 0], [0.34, -7], [0.5, 9, 'in'], [0.62, 5], [0.85, 0], [1, 0]]) },
          head: [0, c([[0, 0], [0.34, -6], [0.5, 8, 'in'], [1, 0]]), 0],
          wing: heronWings(t, { raise: c([[0, 0], [0.34, 14], [0.5, 6, 'in'], [0.8, 3], [1, 0]]), sweep: c([[0, 0], [0.34, 6], [0.5, -8, 'in'], [1, 0]]) }),
          tailJoints: [0, 1].map(i => [rise(0.03 * i) / 2, swing(0.03 * i) / 2, 0]),
        });
      },
    },
  },
};

// ---------------------------------------------------------------------------------------------
// Koro (NPC macaque on the same Mixamo-style biped rig v1.0 as the Howler). Only the two clips the engine can ask a stationary
// non-combat actor for are produced: monster-idle and monster-walk, windowed / retimed / loop-closed from the Tripo idle and walk
// presets exactly like the Howler's, in place.
// ---------------------------------------------------------------------------------------------
const KORO = {
  setup: howlerContext,
  slots: ['monster-idle', 'monster-walk'],
  presetMapping: { 'monster-idle': HOWLER.presetMapping['monster-idle'], 'monster-walk': HOWLER.presetMapping['monster-walk'] },
  clips: {},
};

// ---------------------------------------------------------------------------------------------
// Grove Rootling (sparring spirit on the same biped rig v1.0 as the Howler). Tripo ships idle / walk / slash / pitch_baseball / hurt
// presets only: idle, walk, slash and shoot are conditioned exactly like the Howler's (same presets, same windows), jump / hurt / turn /
// dive / roar are the Howler's authored clips scaled to the Rootling's height, and the run is authored here (no run preset exists):
// a planted-foot stride on IK targets (stance slides back, swing is a high-knee arc), forward lean, counter-swinging bent arms.
// ---------------------------------------------------------------------------------------------
const ROOTLING = {
  setup: rig => {
    const accessor = rig.json.accessors[rig.json.meshes[0].primitives[0].attributes.POSITION];
    return howlerContext(rig, round(accessor.max[1] - accessor.min[1]));
  },
  presetMapping: Object.fromEntries(Object.entries(HOWLER.presetMapping).filter(([slot]) => slot !== 'monster-run')),
  clips: {
    ...HOWLER.clips,
    'monster-run': {
      pose(t, ctx) {
        const H = ctx.H, duty = 0.45, stride = 0.17 * H, lift = 0.2 * H;
        const foot = t0 => {
          const s = (((t - t0) % 1) + 1) % 1;
          if (s < duty) return [stride * (1 - 2 * s / duty), 0, 0];
          const k = (s - duty) / (1 - duty);
          return [stride * (-1 + 2 * smoothstep(k)), lift * Math.sin(Math.PI * k), 0];
        };
        const arm = phase => ({ at: [0.2 * H * sin(t, 1, phase), 0.1 * H + 0.03 * H * sin(t, 2, phase), 0] });
        return bipedPose(ctx, {
          up: H * (-0.05 + 0.02 * (0.5 - 0.5 * Math.cos(TAU * 2 * t))),
          hip: [-6, 4 * sin(t, 1, 0.25), 3 * sin(t, 1, 0.5)],
          torso: [-7 + 1.5 * sin(t, 2, 0.1), -8 * sin(t, 1, 0.25), 0],
          neck: [6, 4 * sin(t, 1, 0.75), 0],
          head: [4, 0, 0],
          arms: { L: arm(0.5), R: arm(0) },
          feet: { L: foot(0), R: foot(0.5) },
        });
      },
    },
  },
};

const DEFS = { 'actor-thornback-howler': HOWLER, 'actor-koro': KORO, 'actor-grove-rootling': ROOTLING, 'actor-storm-hornbill': HORNBILL, 'actor-mire-viper': VIPER, 'actor-lantern-heron': HERON };

// ---------------------------------------------------------------------------------------------
// Sampling and measurement
// ---------------------------------------------------------------------------------------------
function frameCount(slot) { return Math.round(SLOT_SECONDS[slot] * FPS); }

function sampleAuthored(ctx, slot, spec) {
  const frames = frameCount(slot), loop = SLOT_LOOPS[slot];
  const poses = [];
  for (let f = 0; f < (loop ? frames : frames + 1); f++) {
    const { pb } = spec.pose(f / frames, ctx);
    poses.push(pb.solve());
  }
  if (loop) poses.push(poses[0]);
  return { name: slot, frames, loop, poses, keyTimes: spec.keyTimes ?? {}, strikeJoints: spec.strikeJoints?.(ctx), produced: 'authored' };
}

/** Windows, retimes, loop-closes and in-places a Tripo preset into a monster slot clip. */
function sampleConditioned(ctx, bin, slot, map) {
  const { rig } = ctx;
  const clip = readAnimation(rig, bin, map.preset);
  const frames = frameCount(slot), loop = SLOT_LOOPS[slot];
  const duration = map.anchors ? undefined : map.window[1] - map.window[0];
  const srcAt = map.anchors ? anchorMap(map.anchors) : u => map.window[0] + u * duration;
  const spanSeconds = map.anchors ? map.anchors.at(-1)[1] - map.anchors[0][1] : duration;
  const poses = [];
  for (let f = 0; f < (loop ? frames : frames + 1); f++) {
    const u = f / frames;
    let locals = clip.sample(srcAt(u));
    if (loop && map.crossfade) {
      const w = map.crossfade / spanSeconds;
      if (u > 1 - w) {
        const mix = smoothstep((u - (1 - w)) / w);
        // Wrap: blend towards the pose the clip had one period earlier, which equals the first frame at u = 1.
        locals = blendLocals(rig, locals, clip.sample(Math.max(0, srcAt(u) - spanSeconds)), mix);
      }
    }
    poses.push(locals);
  }
  // In place: pin the hips horizontally to the rest XZ (loops keep their own oscillation about it).
  const hips = ctx.hipsJoint, restXZ = ctx.restP[hips];
  const offsets = poses.map(locals => { const p = rig.world(locals).P[hips]; return { x: p.x - restXZ.x, z: p.z - restXZ.z }; });
  const mean = map.centreHips ? { x: offsets.reduce((a, o) => a + o.x, 0) / offsets.length, z: offsets.reduce((a, o) => a + o.z, 0) / offsets.length } : undefined;
  poses.forEach((locals, i) => {
    const o = offsets[i];
    shiftJointHorizontal(rig, locals, hips, mean ? { x: -mean.x, z: -mean.z } : { x: -o.x, z: -o.z });
  });
  if (loop) poses.push(poses[0]);
  return { name: slot, frames, loop, poses, keyTimes: {}, produced: 'preset-conditioned', source: { preset: map.preset, anchors: map.anchors ?? null, window: map.window ?? null, crossfadeSeconds: map.crossfade ?? null } };
}

function measure(ctx, clip) {
  const { rig } = ctx;
  const rest = ctx.restP;
  const worlds = clip.poses.map(p => rig.world(p).P);
  const hipsRest = rest[ctx.hipsJoint];
  let hipsDrift = 0, rootTravel = 0, minY = Infinity, maxY = -Infinity;
  for (const P of worlds) {
    hipsDrift = Math.max(hipsDrift, Math.hypot(P[ctx.hipsJoint].x - hipsRest.x, P[ctx.hipsJoint].z - hipsRest.z));
    rootTravel = Math.max(rootTravel, Math.hypot(P[ctx.rootJoint].x - rest[ctx.rootJoint].x, P[ctx.rootJoint].z - rest[ctx.rootJoint].z));
    minY = Math.min(minY, P[ctx.hipsJoint].y - hipsRest.y); maxY = Math.max(maxY, P[ctx.hipsJoint].y - hipsRest.y);
  }
  // Informational: how far the skinned mesh centroid wanders horizontally (includes torso / limb lean, so it is not the in-place criterion).
  const restCentre = ctx.centroid(rig.restLocals());
  let centreDrift = 0;
  for (const pose of clip.poses) { const c = ctx.centroid(pose); centreDrift = Math.max(centreDrift, Math.hypot(c.x - restCentre.x, c.z - restCentre.z)); }
  // Strike: instant of peak speed of the strike joints (tips / hands / head).
  const speed = worlds.map((P, f) => {
    if (f === 0 || f === worlds.length - 1) return 0;
    return Math.max(...(clip.strikeJoints ?? ctx.strikeJoints).map(j => P[j].distanceTo(worlds[f - 1][j]) / (1 / FPS)));
  });
  const peak = speed.reduce((best, s, f) => (s > speed[best] ? f : best), 0);
  // Loop seam check: the step from the last distinct frame back to frame 0 must not exceed the clip's own largest interior frame step.
  const stepDegrees = (from, to) => rig.joints.reduce((m, j) => Math.max(m, clip.poses[from].Q[j].angleTo(clip.poses[to].Q[j]) / DEG), 0);
  const closureStep = clip.loop ? stepDegrees(clip.frames - 1, 0) : undefined;
  const interiorStep = clip.loop ? Math.max(...Array.from({ length: clip.frames - 2 }, (_, f) => stepDegrees(f, f + 1))) : undefined;
  return {
    maxHipsDriftUnits: round(hipsDrift), maxMeshCentroidWanderUnits: round(centreDrift), maxRootBoneTravelUnits: round(rootTravel), hipHeightRangeUnits: [round(minY), round(maxY)],
    peakStrikeSpeedUnitsPerSecond: round(speed[peak], 3), peakStrikeTime: round(peak / clip.frames, 3),
    ...(clip.loop ? { loopClosureStepDegrees: round(closureStep, 3), maxInteriorStepDegrees: round(interiorStep, 3) } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------
export function author(assetId, { write = true } = {}) {
  const def = DEFS[assetId];
  if (!def) throw new Error(`Unknown creature ${assetId}; known: ${Object.keys(DEFS).join(', ')}`);
  const dir = resolve(ROOT, 'asset-source/generated', `${assetId}-runtime-01`);
  const inputPath = join(dir, `${assetId}.glb`);
  if (!existsSync(inputPath)) throw new Error(`Missing input ${inputPath}`);
  const inputBytes = readFileSync(inputPath);
  const source = parseGlb(inputBytes);
  if (source.json.animations?.some(a => MONSTER_SLOTS.includes(a.name))) throw new Error('Input already contains monster-* clips');
  const rig = new Rig(source.json);
  const ctx = def.setup(rig);
  ctx.centroid = makeCentroidSampler(rig, source.bin);
  const clips = [];
  for (const slot of def.slots ?? MONSTER_SLOTS) {
    const mapping = def.presetMapping[slot];
    if (mapping?.preserved) { clips.push({ name: slot, preserved: mapping.preserved }); continue; }
    clips.push(mapping ? sampleConditioned(ctx, source.bin, slot, mapping) : sampleAuthored(ctx, slot, def.clips[slot]));
  }
  const generated = clips.filter(c => !c.preserved);
  const preservedNames = clips.filter(c => c.preserved).map(c => c.preserved);
  // Raw Tripo preset clips are dropped once conditioned (idle alone is 15 s); preserved presets stay as they are.
  const base = { json: structuredClone(source.json), bin: source.bin };
  base.json.animations = (base.json.animations ?? []).filter(a => preservedNames.includes(a.name));
  const encoded = compactBuffers(encodeClips(base, rig, generated, { translationJoints: ctx.translationJoints }));
  const skinCleanup = def.cleanWeights ? cleanStraySkinWeights(rig, encoded.json, encoded.bin, def.cleanWeights) : undefined;
  const outputBytes = encodeGlb(encoded.json, encoded.bin);
  const position = source.json.accessors[source.json.meshes[0].primitives[0].attributes.POSITION];
  const report = {
    schemaVersion: 1, assetId, generator: 'scripts/assets/author-creature-clips.mjs',
    input: { path: `asset-source/generated/${assetId}-runtime-01/${assetId}.glb`, sha256: sha256(inputBytes), bytes: inputBytes.length },
    output: { path: `asset-source/generated/${assetId}-runtime-01/${assetId}-animated.glb`, sha256: sha256(outputBytes), bytes: outputBytes.length },
    castSocketBone: ctx.castSocketBone,
    inPlaceAnchorBone: rig.nodes[ctx.hipsJoint].name,
    rootBone: rig.nodes[ctx.rootJoint].name,
    ...(skinCleanup ? { skinCleanup } : {}),
    body: { heightUnits: round(position.max[1] - position.min[1]), boundsMin: position.min.map(v => round(v)), boundsMax: position.max.map(v => round(v)) },
    fps: FPS, slots: {},
  };
  for (const clip of clips) {
    if (clip.preserved) {
      const raw = encoded.json.animations.find(a => a.name === clip.preserved);
      const seconds = Math.max(...raw.samplers.map(s => encoded.json.accessors[s.input].max[0]));
      report.slots[clip.name] = { clip: clip.preserved, produced: 'preset', durationSeconds: round(seconds), loop: true, note: 'Tripo preset kept untouched (rotation-only tracks, no root translation)' };
      continue;
    }
    report.slots[clip.name] = {
      clip: clip.name, produced: clip.produced, durationSeconds: round(clip.frames / FPS), frames: clip.frames + 1, loop: clip.loop,
      semanticKeyTimes: clip.keyTimes, ...(clip.source ? { source: clip.source } : {}), measured: measure(ctx, clip),
    };
  }
  if (write) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${assetId}-animated.glb`), outputBytes);
    writeFileSync(join(dir, 'clips-report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  return { report, outputBytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const assetId = process.argv[2];
  if (!assetId) { console.error('Usage: author-creature-clips.mjs <asset-id>'); process.exit(2); }
  const { report } = author(assetId);
  console.log(JSON.stringify({
    asset: assetId, output: report.output,
    slots: Object.fromEntries(Object.entries(report.slots).map(([slot, s]) => [slot, `${s.clip} ${s.produced} ${s.durationSeconds}s hips=${s.measured?.maxHipsDriftUnits ?? '-'} centroid=${s.measured?.maxMeshCentroidWanderUnits ?? '-'} strike=${s.measured?.peakStrikeTime ?? '-'}`])),
  }, null, 2));
}
