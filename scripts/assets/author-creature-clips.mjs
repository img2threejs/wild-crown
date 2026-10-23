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
  BodyFrame, DEG, FPS, HARPY_SLOTS, cleanStraySkinWeights, makeCentroidSampler, makeLowestSampler, MONSTER_SLOTS, MONSTER_TAIL_SLOT, PoseBuilder, Rig, SLOT_LOOPS, SLOT_SECONDS, TAU, anchorMap, blendLocals, clamp, compactBuffers, curve, encodeClips, encodeGlb,
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
 * arms.X.from (a joint) measures the offset from that joint's carried position (the pose before any arm / leg IK) instead of the rest hand;
 * ctl.feetCarried (0..1, or a boolean for a fully carried fall) blends planted feet into the hip-carried pose and back without a landing snap.
 * Offsets are measured from that pose; a carried foot never goes below its rest sole height. ctx.lift adds body height (the floor guard).
 */
export function bipedPose(ctx, ctl) {
  const { rig, body } = ctx;
  const pb = new PoseBuilder(rig, ctx.preserveHingeFrame);
  if (ctl.up || ctx.lift) pb.translate(ctx.hip, V(0, (ctl.up ?? 0) + ctx.lift, 0));
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
    const carried = Math.max(0, Math.min(1, Number(ctl.feetCarried ?? 0)));
    const base = carried === 0 ? ctx.restP[foot] : carried === 1 ? now.P[foot] : ctx.restP[foot].clone().lerp(now.P[foot], carried);
    const target = body.at(base, off[0], off[1], off[2]);
    if (carried) target.y = Math.max(target.y, ctx.restP[foot].y);
    pb.reach(thigh, calf, foot, target, body.F, 1 - carried);
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
    // One-shot death: a flinch recoil, the knees buckle and the torso slumps (the hips sink), then the whole body falls over backwards (hip
    // pitch, the legs ride the hip and the feet drag along the ground) with a small bounce on landing; arms fling out, the head lolls. The
    // last 0.18 is one held pose. The authored hip sinks deeper than any body can; the floor guard (spec.floor) lifts every frame to the
    // height at which the lowest skinned vertex touches the ground.
    'monster-death': {
      floor: true,
      keyTimes: { recoil: 0.1, buckle: 0.42, fall: 0.66, rest: 0.82 },
      pose(t, ctx) {
        const c = keys => curve(keys, t), H = ctx.H, hand = side => ctx.arm[side][2];
        const hit = c([[0, 0], [0.1, 1, 'out'], [0.26, 0.1], [0.36, 0]]);
        const sink = c([[0, 0], [0.1, 0.05], [0.42, 1, 'in2'], [0.5, 1, 'lin'], [1, 1]]);
        const fall = c([[0, 0], [0.34, 0], [0.64, 1, 'in'], [0.72, 1.05, 'out2'], [0.82, 1, 'io'], [1, 1]]);
        const flung = c([[0, 0], [0.36, 0], [0.66, 1, 'out'], [0.8, 0.85, 'io'], [1, 0.85]]);
        return bipedPose(ctx, {
          feetCarried: true,
          up: -0.55 * H * sink + 0.02 * H * hit,
          hip: [82 * fall - 8 * hit - 6 * sink * (1 - fall), 0, 5 * fall],
          torso: [-14 * sink * (1 - fall) + 12 * hit + 10 * fall, 4 * fall, 3 * fall],
          neck: [16 * hit - 10 * sink * (1 - fall) + 12 * fall, 10 * fall, 4 * fall],
          head: [12 * hit - 8 * sink * (1 - fall) + 10 * fall, 16 * fall, 6 * fall],
          shrug: 8 * hit - 6 * fall,
          arms: {
            L: { from: hand('L'), at: [-0.04 * H * hit + 0.05 * H * flung, 0.12 * H * flung, 0.2 * H * flung] },
            R: { from: hand('R'), at: [-0.04 * H * hit + 0.02 * H * flung, 0.06 * H * flung, -0.22 * H * flung] },
          },
          feet: { L: [-0.05 * H * fall, 0.03 * H * fall, 0.02 * H * fall], R: [-0.07 * H * fall, 0.02 * H * fall, -0.03 * H * fall] },
        });
      },
    },
    // One-shot entrance: the body starts crouched with the arms hanging low (emerging), rises past standing, snaps into an alert pose (chest out,
    // head sweeping left and right, arms ready), shakes the shoulders and head off with a decaying wobble and settles into the idle clip's
    // first frame (the sampler blends the last quarter into it).
    'monster-spawn': {
      floor: true,
      keyTimes: { risen: 0.4, alert: 0.54, shake: 0.7, idle: 1 },
      pose(t, ctx) {
        const c = keys => curve(keys, t), H = ctx.H;
        const low = c([[0, 1], [0.08, 1, 'lin'], [0.42, 0, 'io']]);
        const alert = window01(t, 0.3, 0.46, 0.62, 0.74);
        const look = c([[0.3, 0], [0.46, -1], [0.56, 1], [0.66, -0.35], [0.76, 0]]);
        const shake = window01(t, 0.56, 0.62, 0.8, 0.92);
        return bipedPose(ctx, {
          up: -0.3 * H * low,
          hip: [-10 * low, 0, 0],
          torso: [-26 * low + 8 * alert, 6 * shake * sin(t, 7, 0.3), 3 * shake * sin(t, 7)],
          neck: [-14 * low + 10 * alert, 14 * look + 6 * shake * sin(t, 7, 0.45), 0],
          head: [-10 * low + 6 * alert, 18 * look + 8 * shake * sin(t, 7, 0.6), 3 * shake * sin(t, 7, 0.9)],
          shrug: 12 * shake * sin(t, 7, 0.2) + 4 * alert,
          arms: {
            L: { at: [H * (-0.04 * low + 0.1 * alert), H * (-0.1 * low + 0.06 * alert), H * (0.04 * alert + 0.03 * shake * sin(t, 7))] },
            R: { at: [H * (-0.04 * low + 0.1 * alert), H * (-0.1 * low + 0.06 * alert), H * (-0.04 * alert - 0.03 * shake * sin(t, 7))] },
          },
        });
      },
    },
    // Knockdown (non-lethal): the body takes the same flinch / buckle / backwards fall as the death clip, but ends on an alert held lie
    // (not a limp death): the head is held off the ground a few degrees, the arms tuck close to the body instead of flinging wide, and the
    // floor guard pins the lowest skinned vertex to the rest ground for the entire 0.62-1.0 hold.
    'monster-knockdown': {
      floor: 'settle',
      keyTimes: { recoil: 0.1, buckle: 0.32, fall: 0.45, rest: 0.62 },
      pose(t, ctx) {
        const c = keys => curve(keys, t), H = ctx.H, hand = side => ctx.arm[side][2];
        const hit = c([[0, 0], [0.1, 1, 'out'], [0.26, 0.1], [0.36, 0]]);
        const sink = c([[0, 0], [0.1, 0.05], [0.32, 1, 'in2'], [0.4, 1, 'lin'], [0.62, 1, 'io'], [1, 1]]);
        // Faster fall: ground contact at 0.45, small bounce 0.5, settle to a held lie by 0.62.
        const fall = c([[0, 0], [0.18, 0], [0.44, 1, 'in'], [0.5, 1.06, 'out2'], [0.6, 1, 'io'], [0.62, 1, 'io'], [1, 1]]);
        const tuck = c([[0, 0], [0.36, 0], [0.5, 1, 'out'], [0.62, 1, 'io'], [1, 1]]);
        return bipedPose(ctx, {
          feetCarried: true,
          up: -0.55 * H * sink + 0.02 * H * hit,
          hip: [78 * fall - 8 * hit - 6 * sink * (1 - fall), 0, 4 * fall],
          torso: [-14 * sink * (1 - fall) + 12 * hit + 8 * fall, 3 * fall, 2 * fall],
          neck: [16 * hit - 10 * sink * (1 - fall) + 10 * fall, 8 * fall, 3 * fall],
          // Head lifts slightly while lying (eyes open, alert) instead of lolling.
          head: [10 * hit - 6 * sink * (1 - fall) - 14 * fall, 10 * fall, 4 * fall],
          shrug: 8 * hit - 4 * fall,
          arms: {
            L: { from: hand('L'), at: [0.04 * H * tuck, 0.04 * H * tuck, 0.08 * H * tuck] },
            R: { from: hand('R'), at: [0.02 * H * tuck, 0.02 * H * tuck, -0.08 * H * tuck] },
          },
          feet: { L: [-0.04 * H * fall, 0.02 * H * fall, 0.02 * H * fall], R: [-0.06 * H * fall, 0.02 * H * fall, -0.02 * H * fall] },
        });
      },
    },
    // Get-up (non-lethal): starts on the knockdown's last frame (lying on the back, alert), rolls to the side, pushes up to a side-sit,
    // onto hands and knees, stands into the alert pose and shakes off (the sampler blends the last quarter into the idle clip's first frame).
    'monster-getup': {
      floor: 'settle',
      keyTimes: { side: 0.18, sit: 0.34, kneel: 0.52, crouch: 0.72, stand: 0.86, idle: 1 },
      pose(t, ctx) {
        const c = keys => curve(keys, t), H = ctx.H;
        // Frame 0 = the knockdown's last frame: sample it lazily so ctx.lift (the outer floor guard's only mechanism) flows through every stage.
        const KNOCKDOWN = HOWLER.clips['monster-knockdown'];
        // Stage poses are built on demand from a control-set ctl: bipedPose adds ctx.lift to the hip translation, so the outer floor guard lifts every stage by the same amount and the seam between stages stays continuous.
        const stageCtl = [
          null, // stage 0 is the knockdown's last frame; resolved in the closure
          // Lying on the LEFT side, head up off the ground, arms tucked.
          { feetCarried: true, up: -0.5 * H, hip: [62, 0, 0], torso: [-12, 0, 0], neck: [22, 0, 0], head: [10, 0, 0],
            arms: { L: { at: [0.02 * H, 0.02 * H, 0.06 * H] }, R: { at: [0.02 * H, 0.02 * H, -0.06 * H] } },
            feet: { L: [-0.02 * H, 0.04 * H, 0.08 * H], R: [-0.04 * H, 0.02 * H, -0.06 * H] } },
          // Propped on the LEFT elbow, knees drawn in, head turned to the right.
          { feetCarried: true, up: -0.3 * H, hip: [12, 0, -22], torso: [16, 0, -8], neck: [-10, 18, 0], head: [-2, 22, 0],
            arms: { L: { at: [0.12 * H, 0.04 * H, 0.18 * H] }, R: { at: [0.02 * H, 0.04 * H, -0.12 * H] } },
            feet: { L: [-0.04 * H, 0.06 * H, 0.06 * H], R: [-0.06 * H, 0.04 * H, -0.04 * H] } },
          // On hands and knees, head down.
          { up: -0.18 * H, hip: [-22, 0, 0], torso: [34, 0, 0], neck: [-22, 0, 0], head: [-18, 0, 0],
            arms: { L: { at: [0.18 * H, -0.16 * H, 0.12 * H] }, R: { at: [0.18 * H, -0.16 * H, -0.12 * H] } },
            feet: { L: [-0.1 * H, 0.04 * H, 0.05 * H], R: [-0.1 * H, 0.04 * H, -0.05 * H] } },
          // Crouched, leaning forward.
          { up: -0.08 * H, hip: [-4, 0, 0], torso: [-18, 0, 0], neck: [4, 0, 0], head: [4, 0, 0],
            arms: { L: { at: [0.04 * H, -0.06 * H, 0.06 * H] }, R: { at: [0.04 * H, -0.06 * H, -0.06 * H] } } },
          // Standing (rest pose).
          {},
        ];
        const rig = ctx.rig, edges = [0, 0.18, 0.34, 0.52, 0.72, 0.86];
        return { pb: { solve: () => {
          // Stage 0 uses the same authored pose the knockdown ends on; the floor guard there was `settle`, so this stage sits on the ground.
          const stage0 = KNOCKDOWN.pose(1, ctx).pb.solve();
          if (t <= edges[0]) return stage0;
          const stages = [stage0, ...stageCtl.slice(1).map(ctl => bipedPose(ctx, ctl).pb.solve())];
          let i = 0;
          while (i < edges.length - 2 && t > edges[i + 1]) i++;
          return blendLocals(rig, stages[i], stages[i + 1], smoothstep((t - edges[i]) / (edges[i + 1] - edges[i])));
        } } };
      },
    },
  },
};

/** Run a clip's pose(t, ctx) through the floor guard the same way the main loop does (the get-up needs frame 0 = knockdown's last frame). */
function solveAuthoredStage(ctx, spec, u) {
  // Use the main solver so the held lie uses the same 'settle' floor the knockdown set.
  return solveOnFloor(ctx, spec, u);
}

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
  const pb = new PoseBuilder(rig, ctx.preserveHingeFrame);
  const pivot = ctx.restP[ctx.root];
  if (ctl.root) pb.rotateAbout(ctx.root, body.euler(ctl.root), V(pivot.x + 0.05, pivot.y + 0.35, pivot.z));
  // rootQ: a whole-body turn composed by the caller (e.g. pitch the torso level, then roll it onto its side) about the body centre (Spine_0).
  if (ctl.rootQ) pb.rotateAbout(ctx.root, ctl.rootQ, ctx.restP[ctx.spine]);
  if (ctl.up || ctx.lift) pb.translate(ctx.root, V(0, (ctl.up ?? 0) + ctx.lift, 0));
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
  // Root is the chest skin: the floor guard has to see it so the fallen body rests on the ground.
  floorIncludesRoot: true,
  presetMapping: {},
  slots: [...MONSTER_SLOTS, MONSTER_TAIL_SLOT],
  clips: {
    // One-shot death. The hornbill hovers (the renderer lifts it by MONSTER_HOVER and ActorAnimationDriver eases that offset to 0 over the clip, ground
    // contact at ~0.7): the wings flare and flail at the hit and keep beating while it drops, then fold as the torso pitches level and rolls onto its
    // left side. At contact (0.66-0.72) the body bounces once, the underside wing lies flat on the ground splayed outwards and the upper wing droops
    // half open; head and tail flop after it and the last 0.16 is one held pose. spec.floor = 'settle' rests the lowest skinned vertex on the ground.
    'monster-death': {
      floor: 'settle',
      keyTimes: { recoil: 0.1, flailEnd: 0.5, contact: 0.7, rest: 0.84 },
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        const hit = c([[0, 0], [0.1, 1, 'out'], [0.26, 0.1], [0.36, 0]]);
        const pitch = c([[0, 0], [0.12, 0.04, 'io'], [0.56, 0.9, 'in2'], [0.68, 1, 'out2'], [0.74, 1.03, 'out2'], [0.86, 1, 'io'], [1, 1]]);
        const roll = c([[0, 0], [0.32, 0, 'lin'], [0.68, 1, 'in2'], [0.75, 1.05, 'out2'], [0.86, 1, 'io'], [1, 1]]);
        const settle = c([[0, 0], [0.68, 0, 'lin'], [0.8, 1, 'out'], [1, 1]]);
        const flail = 30 * window01(t, 0.06, 0.12, 0.52, 0.68) * sin(t, 3.5);
        const spread = ph => 38 * hit + flail * (1 + 0.2 * ph);
        return hornbillPose(ctx, {
          rootQ: ctx.body.roll(88 * roll).multiply(ctx.body.pitch(-46 * pitch)),
          wing: {
            // Left wing (underside after the roll): rises with the flail, then swings out flat on the ground. Right wing (upper side): droops half open.
            L: { flap: [spread(0) + 58 * roll, 0.7 * spread(0) + 20 * roll, 0.5 * spread(0) + 12 * roll], sweep: [10 * settle, 6 * settle, 0], pitch: [0, 0, 0] },
            R: { flap: [spread(1) - 38 * roll, 0.7 * spread(1) - 18 * roll, 0.5 * spread(1) - 10 * roll], sweep: [16 * settle, 12 * settle, 0], pitch: [0, 0, 0] },
          },
          tail: [14 * hit - 10 * pitch, 12 * roll, 0],
          neck: [16 * hit - 20 * pitch, 14 * roll, 0],
          head: [14 * hit - 16 * pitch, 22 * roll, 8 * roll],
          beak: [16 * hit + 6 * pitch, 0, 0],
          legs: { L: [30 * hit + 40 * pitch, 0, 0], R: [30 * hit + 30 * pitch, 0, 0] },
        });
      },
    },
    // Knockdown (non-lethal): a faster version of the death fall (1.2 s, ground contact at 0.45, held lie from 0.62 to 1.0) that ends on an alert
    // held lie (head up, eyes open) instead of a limp death: the head is held off the ground a few degrees, the wings tuck close instead of drooping.
    'monster-knockdown': {
      floor: 'settle',
      keyTimes: { recoil: 0.1, flailEnd: 0.32, contact: 0.45, rest: 0.62 },
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        const hit = c([[0, 0], [0.1, 1, 'out'], [0.26, 0.1], [0.36, 0]]);
        const pitch = c([[0, 0], [0.1, 0.04, 'io'], [0.34, 0.9, 'in2'], [0.44, 1, 'out2'], [0.5, 1.04, 'out2'], [0.6, 1, 'io'], [0.62, 1, 'io'], [1, 1]]);
        const roll = c([[0, 0], [0.16, 0, 'lin'], [0.44, 1, 'in2'], [0.5, 1.05, 'out2'], [0.6, 1, 'io'], [0.62, 1, 'io'], [1, 1]]);
        const settle = c([[0, 0], [0.45, 0, 'lin'], [0.55, 1, 'out'], [0.62, 1, 'io'], [1, 1]]);
        const flail = 28 * window01(t, 0.06, 0.12, 0.36, 0.44) * sin(t, 3.5);
        const spread = ph => 32 * hit + flail * (1 + 0.2 * ph);
        return hornbillPose(ctx, {
          rootQ: ctx.body.roll(88 * roll).multiply(ctx.body.pitch(-40 * pitch)),
          wing: {
            L: { flap: [spread(0) + 50 * roll, 0.7 * spread(0) + 18 * roll, 0.5 * spread(0) + 10 * roll], sweep: [8 * settle, 5 * settle, 0], pitch: [0, 0, 0] },
            R: { flap: [spread(1) - 32 * roll, 0.7 * spread(1) - 16 * roll, 0.5 * spread(1) - 8 * roll], sweep: [14 * settle, 10 * settle, 0], pitch: [0, 0, 0] },
          },
          tail: [12 * hit - 8 * pitch, 8 * roll, 0],
          neck: [14 * hit - 16 * pitch, 8 * roll, 0],
          // Head lifts slightly while lying (alert): negative pitch, not the limp -16 of the death clip.
          head: [12 * hit - 6 * pitch, 14 * roll, 6 * roll],
          beak: [10 * hit + 4 * pitch, 0, 0],
          legs: { L: [24 * hit + 32 * pitch, 0, 0], R: [24 * hit + 24 * pitch, 0, 0] },
        });
      },
    },
    // Get-up (non-lethal): starts on the knockdown's last frame (lying alert on the left side), pushes up with a wing, rolls to sternal,
    // pushes up to a half-crouch and stands into the idle pose (the sampler blends the last quarter into the idle clip's first frame). 1.6 s.
    'monster-getup': {
      floor: 'settle',
      keyTimes: { wing: 0.18, sternal: 0.34, crouch: 0.62, stand: 0.86, idle: 1 },
      pose(t, ctx) {
        const c = keys => curve(keys, t), H = ctx.H;
        // Frame 0 = the knockdown's last frame: sample it lazily so the outer floor guard (ctx.lift) flows through every stage.
        const KNOCKDOWN = HORNBILL.clips['monster-knockdown'];
        // A `stand` window holds the stand phase 0.86-1.0 and lets the body settle into the rest pose before the
        // sampler blends the last quarter into the idle clip's first frame.
        const stand = c([[0, 0], [0.86, 0, 'lin'], [0.92, 1, 'out'], [1, 1, 'io']]);
        // Multi-stage get-up: lying alert on the left side, right wing push to sternal, push up to a half-crouch with wings half-spread, stand.
        const stageCtl = [
          null, // stage 0 is the knockdown's last frame; resolved in the closure
          // Wing push: right wing braces on the ground (90° sweep back + bend), the body rolls back to sternal.
          { rootQ: ctx.body.roll(60).multiply(ctx.body.pitch(-18)),
            wing: { L: { flap: [-18, -10, -6], sweep: [12, 6, 0], pitch: [0, 0, 0] },
                     R: { flap: [16, 12, 8], sweep: [44, 24, 0], pitch: [0, 0, 0] } },
            tail: [-8, 6, 0], neck: [22, 12, 0], head: [6, 18, 4], beak: 0, legs: { L: [40, 0, 0], R: [40, 0, 0] } },
          // Sternal: belly on the ground, head up, wings half-folded beside the body, legs tucked.
          { rootQ: ctx.body.roll(0).multiply(ctx.body.pitch(0)),
            wing: { L: { flap: [4, 2, 0], sweep: [8, 4, 0], pitch: [0, 0, 0] },
                     R: { flap: [4, 2, 0], sweep: [8, 4, 0], pitch: [0, 0, 0] } },
            tail: [-4, 0, 0], neck: [36, 0, 0], head: [10, 0, 0], beak: 0, legs: { L: [50, 0, 0], R: [50, 0, 0] } },
          // Push-up / crouch: head and chest off the ground, wings half-spread for balance, legs straightening.
          { up: 0.06 * H, root: [-12, 0, 0],
            wing: { L: { flap: [22, 14, 8], sweep: [-12, -6, 0], pitch: [0, 0, 0] },
                     R: { flap: [22, 14, 8], sweep: [-12, -6, 0], pitch: [0, 0, 0] } },
            tail: [4, 0, 0], neck: [22, 0, 0], head: [10, 0, 0], beak: 0, legs: { L: [28, 0, 0], R: [28, 0, 0] } },
          // Stand: brief shake-off with one wing flap, then `stand` holds the rest pose from 0.92 so the clip
          // ends on the idle pose's first frame (the sampler blends the last quarter into it).
          { up: 0, root: [0, 2 * sin(t, 3, 0.1) * (1 - stand), 0],
            wing: { L: { flap: [5 * sin(t, 1) * (1 - stand), 4 * sin(t, 1, -0.1) * (1 - stand), 0], sweep: [0, 0, 0], pitch: [0, 0, 0] },
                     R: { flap: [-5 * sin(t, 1) * (1 - stand), -4 * sin(t, 1, -0.1) * (1 - stand), 0], sweep: [0, 0, 0], pitch: [0, 0, 0] } },
            tail: [0, 3 * sin(t, 1, 0.1) * (1 - stand), 0], neck: [2 * (1 - stand), 4 * sin(t, 1, 0.45) * (1 - stand), 0],
            head: [2 * (1 - stand), 6 * sin(t, 1, 0.1) * (1 - stand), 1 * sin(t, 1) * (1 - stand)],
            legs: { L: [10 * (1 - stand) + 4 * sin(t, 2, 0.4) * (1 - stand), 0, 0], R: [10 * (1 - stand) + 4 * sin(t, 2, 0.45) * (1 - stand), 0, 0] } },
        ];
        const rig = ctx.rig, edges = [0, 0.18, 0.34, 0.62, 0.86];
        return { pb: { solve: () => {
          const stage0 = KNOCKDOWN.pose(1, ctx).pb.solve();
          if (t <= edges[0]) return stage0;
          const stages = [stage0, ...stageCtl.slice(1).map(ctl => hornbillPose(ctx, ctl).pb.solve())];
          let i = 0;
          while (i < edges.length - 2 && t > edges[i + 1]) i++;
          return blendLocals(rig, stages[i], stages[i + 1], smoothstep((t - edges[i]) / (edges[i + 1] - edges[i])));
        } } };
      },
    },
    // One-shot entrance: the hornbill starts crouched with the wings folded and the head tucked, rises, throws the wings wide with two hard beats,
    // looks left and right, ruffles with a decaying wing shake and settles into the idle clip's first frame (the last quarter blends into it).
    'monster-spawn': {
      floor: true,
      keyTimes: { risen: 0.4, alert: 0.54, shake: 0.7, idle: 1 },
      pose(t, ctx) {
        const c = keys => curve(keys, t), H = ctx.H;
        const low = c([[0, 1], [0.08, 1, 'lin'], [0.4, 0, 'io']]);
        const flare = window01(t, 0.28, 0.4, 0.58, 0.72);
        const beat = 26 * window01(t, 0.3, 0.38, 0.6, 0.72) * sin(t, 2.5);
        const look = c([[0.3, 0], [0.46, -1], [0.56, 1], [0.66, -0.35], [0.76, 0]]);
        const shake = window01(t, 0.58, 0.64, 0.8, 0.92);
        const wing = ph => ({
          flap: [-34 * low + 40 * flare + beat + 8 * shake * sin(t, 7, ph), 0.6 * (-34 * low + 40 * flare + beat) + 8 * shake * sin(t, 7, ph + 0.08), 0.4 * (-34 * low + 40 * flare + beat) + 9 * shake * sin(t, 7, ph + 0.16)],
          sweep: [30 * low, 14 * low, 0], pitch: [0, 0, 0],
        });
        return hornbillPose(ctx, {
          up: -0.12 * H * low + 0.04 * H * flare,
          root: [-8 * low + 10 * flare, 3 * shake * sin(t, 7, 0.1), 2 * shake * sin(t, 7, 0.3)],
          wing: { L: wing(0), R: wing(0.04) },
          tail: [-10 * low + 12 * flare, 5 * shake * sin(t, 7), 0],
          neck: [-14 * low + 12 * flare, 16 * look, 0],
          head: [-12 * low + 8 * flare, 20 * look, 0],
          beak: [10 * window01(t, 0.4, 0.46, 0.54, 0.62), 0, 0],
          legs: { L: [24 * low, 0, 0], R: [24 * low, 0, 0] },
        });
      },
    },
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
  ctx.hipsJoint = ctx.spine[1]; // mid body: the neck base swings forward in the strikes and the collapse, the coil behind it stays put
  ctx.rootJoint = ctx.root;
  ctx.strikeJoints = [ctx.head[0]];
  // The raised neck and head are carried by Root: scale the authored rear angles so the strikes, spit and roar
  // read from a gameplay camera (the first review sheet showed head swings of only a few degrees on the S-coil).
  ctx.gain = 1.45;
  return ctx;
}

/** Joint heights (model units) of the spine chain Tail_0..Tail_9 when the body lies flat: each joint at its rest height minus the clearance under its own skin (the arch under Tail_2 settles). */
const VIPER_LEVELS = [0.15, 0.07, 0.128, 0.119, 0.07, 0.07, 0.051, 0.047, 0.039, 0.028];

/**
 * Viper pose. ctl: { rear: [pitch, yaw, roll] of the rigid skull about the neck base,
 * wave: { amp, k, phase, from } travelling lateral wave down the spine chain, lash: tail-weighted extra yaw }.
 */
export function viperPose(ctx, ctl) {
  const { rig, body } = ctx;
  const pb = new PoseBuilder(rig, ctx.preserveHingeFrame);
  const qRear = body.euler((ctl.rear ?? [0, 0, 0]).map(v => v * ctx.gain)), qFall = new Quaternion();
  let shift;
  if (ctl.fall) {
    // Collapse: the raised neck column topples forward about the neck's ground base: the neck base joint (bone_1) swings to where that rotation
    // puts it (`shift`) and turns with it. Every body segment behind it is then re-aimed along its rest direction, its climb replaced by the
    // climb between ground-level joint heights as `flat` goes 0 -> 1 (the coils lie on the ground plane) and a travelling slack yaw.
    const f = ctl.fall, base = V(ctx.pivot.x, f.pivotY ?? 0.06, ctx.pivot.z + (f.pivotZ ?? -0.06));
    qFall.copy(body.euler([-(f.pitch ?? 0), f.yaw ?? 0, f.roll ?? 0]));
    shift = base.clone().add(ctx.pivot.clone().sub(base).applyQuaternion(qFall)).sub(ctx.pivot);
    ctx.spine.slice(0, -1).forEach((joint, i) => {
      const next = ctx.spine[i + 1], dir = ctx.restP[next].clone().sub(ctx.restP[joint]), level = k => Math.min(ctx.restP[ctx.spine[k]].y, VIPER_LEVELS[k]);
      dir.y += ((level(i + 1) - level(i)) - dir.y) * (f.flat ?? 0);
      dir.applyAxisAngle(body.U, (f.slack?.(i) ?? 0) * DEG);
      pb.aim(joint, next, dir);
    });
  }
  if (ctl.rear || ctl.bodyRoll || ctl.fall) {
    // bodyRoll (degrees, positive = left side down) turns the whole body about the neck base; rear only raises the neck / head.
    pb.rotateAbout(ctx.root, qRear.clone().multiply(qFall).multiply(body.euler([0, 0, ctl.bodyRoll ?? 0])), ctx.pivot);
    if (shift) pb.translate(ctx.root, shift);
    // The whole body hangs below Root: hold the neck base's world orientation and position so only the raised neck / head move.
    pb.rotate(ctx.neckBase, qRear.clone().invert());
  }
  if (ctl.up || ctx.lift) pb.translate(ctx.root, V(0, (ctl.up ?? 0) + ctx.lift, 0));
  // Head_0..5 run through the snout, cheek and crown, not a flexible neck. Rotating them separately caves in
  // the skull shared with Root. Keep their bind locals; Root above carries the whole head without folding it.
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

/**
 * Neck lunge: the neck column swings about its ground base (swing: degrees, + forward and down, - leaning back over the body; yaw: + to the left)
 * with the body behind it drawn into a lateral S (coil: degrees of travelling yaw, 0 = body straight) and the head holding its heading
 * (follow: share of the neck's pitch the head cancels; nose: extra head pitch, + up). The tail chain stays planted.
 */
function viperLunge(ctx, { swing, yaw = 0, nose = 0, coil = 0, follow = 0.85 }) {
  const angle = (follow * swing + nose) / ctx.gain, turn = 0.3 * yaw / ctx.gain;
  return viperPose(ctx, {
    rear: [angle, turn, 0],
    fall: { pitch: swing, yaw, flat: 0, slack: i => coil * Math.sin(0.7 * i + 0.6) * (0.4 + 0.6 * (i / 9)) },
  });
}

const VIPER = {
  setup: viperContext,
  // Root carries the skull top (the head), so the floor guard must see it: the collapsed head rests on the ground instead of sinking through it.
  floorIncludesRoot: true,
  presetMapping: { 'monster-walk': { preserved: 'preset:serpentine:march' } },
  slots: [...MONSTER_SLOTS, MONSTER_TAIL_SLOT],
  clips: {
    // One-shot death: the head whips up at the hit, then the neck column loses its strength and topples forward, the coils behind it go slack and
    // settle flat on the ground plane and the head drops last, resting on the floor in a limp S; the last 0.2 is one held pose. The authored body
    // height is chosen by the settle guard (spec.floor = 'settle'): every frame rests with the lowest skinned vertex (head included) on the ground.
    'monster-death': {
      floor: 'settle',
      keyTimes: { recoil: 0.1, topple: 0.52, headDown: 0.74, rest: 0.82 },
      pose(t, ctx) {
        const c = keys => curve(keys, t), H = ctx.H;
        const hit = c([[0, 0], [0.1, 1, 'out'], [0.26, 0.1], [0.36, 0]]);
        const sag = c([[0, 0], [0.1, 0.04], [0.54, 1, 'in2'], [0.62, 1.03, 'out2'], [0.76, 1, 'io'], [1, 1]]);
        const flat = c([[0, 0], [0.3, 0.12], [0.74, 1, 'io'], [1, 1]]);
        // The head keeps its heading while the neck folds under it (`follow` ~ 1 cancels the neck's pitch), lifts a little as the neck gives way, then drops last.
        const follow = c([[0, 1], [0.5, 1.1, 'io'], [0.7, 1.06, 'lin'], [0.82, 0.66, 'io'], [1, 0.66]]);
        const thrash = window01(t, 0.06, 0.12, 0.34, 0.56);
        const neck = 124 * sag, headAngle = neck * follow;
        return viperPose(ctx, {
          rear: [24 * hit + headAngle / ctx.gain, 14 * hit * sin(t, 2, 0.2), 0],
          fall: { pitch: neck, yaw: 12 * sag, flat, slack: i => 14 * sag * Math.sin(0.8 * i + 2.2) * (0.3 + 0.7 * (i / 9)) + 18 * thrash * sin(t, 3, -i * 0.1) },
        });
      },
    },
    // Knockdown (non-lethal): a faster version of the viper collapse (1.2 s, neck topples by 0.45, head rests alert by 0.62) that ends on an alert
    // held coil (head held off the ground, eyes open) instead of a limp S. The coils behind the neck go slack and the head follows the neck.
    'monster-knockdown': {
      floor: 'settle',
      keyTimes: { recoil: 0.1, topple: 0.4, headRest: 0.62 },
      pose(t, ctx) {
        const c = keys => curve(keys, t), H = ctx.H;
        const hit = c([[0, 0], [0.1, 1, 'out'], [0.26, 0.1], [0.36, 0]]);
        const sag = c([[0, 0], [0.1, 0.04], [0.4, 1, 'in2'], [0.5, 1.04, 'out2'], [0.6, 1, 'io'], [0.62, 1, 'io'], [1, 1]]);
        const flat = c([[0, 0], [0.2, 0.12], [0.45, 1, 'io'], [0.62, 1, 'io'], [1, 1]]);
        // The head lifts slightly while the neck folds under it (alert, not limp): the `follow` curve keeps the heading up.
        const follow = c([[0, 1], [0.3, 1.1, 'io'], [0.45, 1.06, 'lin'], [0.62, 1.0, 'io'], [1, 1.0]]);
        const thrash = window01(t, 0.06, 0.12, 0.26, 0.4);
        const neck = 116 * sag, headAngle = neck * follow;
        return viperPose(ctx, {
          rear: [22 * hit + headAngle / ctx.gain, 12 * hit * sin(t, 2, 0.2), 0],
          fall: { pitch: neck, yaw: 10 * sag, flat, slack: i => 12 * sag * Math.sin(0.8 * i + 2.2) * (0.3 + 0.7 * (i / 9)) + 16 * thrash * sin(t, 3, -i * 0.1) },
        });
      },
    },
    // Get-up (non-lethal): starts on the knockdown's last frame (coil resting alert on the ground), rolls back upright by re-coiling the spine
    // chain, rears the head into the alert pose, rattles the body with a decaying shake and settles into the idle clip's first frame (the sampler
    // blends the last quarter into it). 1.6 s.
    'monster-getup': {
      floor: 'settle',
      keyTimes: { coil: 0.32, alert: 0.6, shake: 0.78, idle: 1 },
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        // Frame 0 = the knockdown's last frame: sample it lazily so the outer floor guard (ctx.lift) flows through every stage.
        const KNOCKDOWN = VIPER.clips['monster-knockdown'];
        const stageCtl = [
          null, // stage 0 is the knockdown's last frame; resolved in the closure
          // Half-coil: the spine re-coils up; the neck starts to rear with the head held off the ground.
          { rear: [-8, 4 * sin(t, 1, 0.2), 0], wave: { t, cycles: 1, amp: 4, k: 0.08, taper: 1.2 } },
          // Alert: the neck rears high, head scans (yaw sweep), shoulders spread, body coils.
          { rear: [22 + 2 * sin(t, 1, 0.2), 14 * sin(t, 1, 0.4) + 6 * sin(t, 2, 0.3), 2 * sin(t, 1, 0.3)], wave: { t, cycles: 1, amp: 6, k: 0.08, taper: 1.4 } },
          // Stand: body settles to the idle S-coil with a short shake-off (decaying).
          { rear: [4 * sin(t, 1, 0.2) + 1.6 * sin(t, 2), 11 * sin(t, 1) + 2 * sin(t, 2, 0.3), 2.5 * sin(t, 1, 0.3)], wave: { t, cycles: 1, amp: 6, k: 0.08, taper: 1.5 } },
        ];
        const rig = ctx.rig, edges = [0, 0.32, 0.6, 0.78];
        return { pb: { solve: () => {
          const stage0 = KNOCKDOWN.pose(1, ctx).pb.solve();
          if (t <= edges[0]) return stage0;
          const stages = [stage0, ...stageCtl.slice(1).map(ctl => viperPose(ctx, ctl).pb.solve())];
          let i = 0;
          while (i < edges.length - 2 && t > edges[i + 1]) i++;
          return blendLocals(rig, stages[i], stages[i + 1], smoothstep((t - edges[i]) / (edges[i + 1] - edges[i])));
        } } };
      },
    },
    // One-shot entrance: the viper starts with the neck dropped low, raises its head into an alert pose, sweeps it left and right, rattles the body
    // with a decaying shake and settles into the idle clip's first frame (the last quarter blends into it).
    'monster-spawn': {
      floor: true,
      keyTimes: { risen: 0.4, alert: 0.54, shake: 0.7, idle: 1 },
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        const low = c([[0, 1], [0.08, 1, 'lin'], [0.42, 0, 'io']]);
        const alert = window01(t, 0.3, 0.46, 0.62, 0.74);
        const look = c([[0.3, 0], [0.46, -1], [0.56, 1], [0.66, -0.35], [0.76, 0]]);
        const shake = window01(t, 0.56, 0.62, 0.8, 0.92);
        return viperPose(ctx, {
          rear: [-30 * low + 26 * alert, 22 * look + 6 * shake * sin(t, 7, 0.3), 3 * shake * sin(t, 7)],
          wave: { t, cycles: 3, amp: 8 * low + 7 * shake, k: 0.1, taper: 1.2 },
        });
      },
    },
    'monster-idle': {
      pose(t, ctx) {
        return viperPose(ctx, {
          rear: [4 * sin(t, 1, 0.2) + 1.6 * sin(t, 2), 11 * sin(t, 1), 2.5 * sin(t, 1, 0.3)],
          wave: { t, cycles: 1, amp: 6, k: 0.08, taper: 1.5 },
        });
      },
    },
    'monster-run': {
      pose(t, ctx) {
        return viperPose(ctx, {
          rear: [-2 + 2 * sin(t, 2, 0.3), 10 * sin(t, 2, 0.1), 4 * sin(t, 2, 0.4)],
          wave: { t, cycles: 3, amp: 12, k: 0.08, taper: 0.8 },
        });
      },
    },
    'monster-slash': {
      keyTimes: { windupEnd: 0.35, strike: 0.45, followThroughEnd: 0.7 },
      pose(t, ctx) {
        // Side lash: the neck coils back and cocks to the left with the body drawn into an S (anticipation), then whips across to the right with the head
        // thrown forward (head travel ~0.6 body lengths), overshoots and rebounds.
        const c = keys => curve(keys, t);
        return viperLunge(ctx, {
          swing: c([[0, 0], [0.33, -26, 'io'], [0.37, -28, 'lin'], [0.46, 40, 'in'], [0.54, 44, 'out2'], [0.7, 14, 'io'], [1, 0]]),
          yaw: c([[0, 0], [0.33, 44, 'io'], [0.37, 46, 'lin'], [0.46, -52, 'in'], [0.54, -60, 'out2'], [0.64, -34, 'io'], [0.82, -6], [1, 0]]),
          nose: c([[0, 0], [0.33, -8], [0.46, -4, 'in'], [1, 0]]),
          coil: c([[0, 0], [0.33, 15, 'io'], [0.37, 16, 'lin'], [0.46, -8, 'in'], [0.7, 3], [1, 0]]),
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
          wave: { t, cycles: 1, amp: c([[0, 0], [0.26, 5], [0.5, 2], [0.78, 7], [1, 0]]), k: 0.12, taper: 1.2 },
        });
      },
    },
    'monster-hurt': {
      // Flinch: the neck is thrown back over the body at 0.18 (head travel ~0.5 body lengths at the peak), then slumps forward and the head hangs low,
      // held 0.44-0.62 before recovering (finite consumers sample `hold`).
      keyTimes: { flinch: 0.18, hold: 0.52 },
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        return viperLunge(ctx, {
          swing: c([[0, 0], [0.18, -34, 'out'], [0.3, -8], [0.44, 22, 'io'], [0.62, 22, 'lin'], [1, 0, 'io']]),
          nose: c([[0, 0], [0.18, 10, 'out'], [0.44, -14, 'io'], [0.62, -14, 'lin'], [1, 0, 'io']]),
          coil: c([[0, 0], [0.18, 14, 'out'], [0.5, 5], [1, 0, 'io']]),
        });
      },
    },
    'monster-turn': {
      pose(t, ctx) {
        return viperPose(ctx, {
          rear: [2, 12 * sin(t, 1, 0.1), 3 * sin(t, 1, 0.4)],
          wave: { t, cycles: 2, amp: 18, k: 0.1, taper: 1.8 },
          chain: 5 * sin(t, 1, 0.3),
        });
      },
    },
    'monster-dive': {
      keyTimes: { crouchEnd: 0.22, strike: 0.4, recoverStart: 0.55 },
      pose(t, ctx) {
        // Serpent strike: the neck leans back over the body and the body winds into a lateral S-coil (anticipation, held 0.22-0.3), the head then
        // launches forward and down the lane in ~0.1 s (head travel ~0.6 body lengths), overshoots, recoils and the coil unwinds.
        const c = keys => curve(keys, t);
        return viperLunge(ctx, {
          swing: c([[0, 0], [0.22, -38, 'io'], [0.3, -41, 'lin'], [0.4, 62, 'in'], [0.48, 66, 'out2'], [0.62, 38, 'io'], [0.82, 8, 'io'], [1, 0]]),
          nose: c([[0, 0], [0.22, -10, 'io'], [0.3, -14, 'lin'], [0.4, -8, 'in'], [0.5, -8, 'out'], [1, 0]]),
          coil: c([[0, 0], [0.22, 17, 'io'], [0.3, 19, 'lin'], [0.4, -4, 'in'], [0.62, 4], [1, 0]]),
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
  // rootQ: a whole-body turn composed by the caller (a fall onto the side) about the hips.
  if (ctl.rootQ) pb.rotateAbout(ctx.root, ctl.rootQ, ctx.restP[ctx.hips]);
  if (ctl.up || ctl.fwd || ctl.left || ctx.lift) pb.translate(ctx.root, body.at(V(0, 0, 0), ctl.fwd ?? 0, (ctl.up ?? 0) + ctx.lift, ctl.left ?? 0));
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
    if (ctl.feetFree) {
      // Legs ride the body (a collapse): no ankle target; legCurl = [knee, ankle] pitch (degrees) of the limp leg.
      const curl = ctl.legCurl?.[side];
      if (curl) { pb.rotate(knee, body.pitch(curl[0])); pb.rotate(ankle, body.pitch(curl[1])); }
      continue;
    }
    pb.reach(hip, knee, ankle, body.at(ctx.restP[ankle], off[0], off[1], off[2]), ctx.legHint[side], true);
  }
  // wingLay: { L, R } each { share, dir, twist }: blends every wing segment (shoulder .. wrist) from where the other controls left it towards the
  // world direction `dir` (a wing laid on the ground, or drooping from the shoulder), whatever the body's attitude, then twists the wing about that
  // direction by `twist` degrees (the feather sheet hangs below the wing's bone line in the rest pose; a quarter turn lays it flat).
  for (const side of ['L', 'R']) {
    const lay = ctl.wingLay?.[side];
    if (!lay) continue;
    ctx.wing[side].slice(0, -1).forEach((joint, i) => pb.aim(joint, ctx.wing[side][i + 1], current => current.lerp(lay.dir, lay.share)));
    if (lay.twist) pb.spin(ctx.wing[side][0], lay.dir, lay.twist * lay.share);
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
  // Root is the belly skin: the floor guard has to see it so the fallen body rests on the ground.
  floorIncludesRoot: true,
  presetMapping: {},
  cleanWeights: {},
  slots: [...MONSTER_SLOTS, MONSTER_TAIL_SLOT],
  clips: {
    // One-shot death: the neck whips back and the wings flare at the hit, the legs fold as the body sinks, then the bird topples onto its left side
    // (contact ~0.7): the underside wing lies flat on the ground splayed outwards, the upper wing droops half open and the neck goes limp along the
    // ground in front of the body; the last 0.16 is one held pose. The legs ride the body (no ankle targets) and spec.floor = 'settle' rests the
    // lowest skinned vertex on the ground.
    'monster-death': {
      floor: 'settle',
      keyTimes: { recoil: 0.1, collapse: 0.46, contact: 0.7, rest: 0.84 },
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        const hit = c([[0, 0], [0.1, 1, 'out'], [0.26, 0.1], [0.36, 0]]);
        const sink = c([[0, 0], [0.1, 0.05], [0.46, 1, 'in2'], [0.56, 1.05, 'out2'], [0.7, 1, 'io'], [1, 1]]);
        const roll = c([[0, 0], [0.32, 0, 'lin'], [0.68, 1, 'in2'], [0.75, 1.05, 'out2'], [0.86, 1, 'io'], [1, 1]]);
        const limp = c([[0, 0], [0.4, 0, 'lin'], [0.7, 1, 'io'], [0.77, 1.04, 'out2'], [0.86, 1, 'io'], [1, 1]]);
        const fold = c([[0, 0], [0.12, -0.5, 'out'], [0.4, 1, 'io'], [0.66, 0.9, 'lin'], [0.8, 0.15, 'io'], [1, 0.15]]);
        const flap = window01(t, 0.06, 0.12, 0.3, 0.5);
        const wings = heronWings(t, { raise: 40 * hit - 28 * fold, bend: -14 * fold, sweep: 40 * fold, flutter: 12 * flap, cycles: 4 });
        // The folded wings are laid out as the bird lands: the left wing (underside) is aimed flat along the ground, outwards and a little back, the
        // right wing (upper side) droops half open from the shoulder.
        const lay = Math.min(1, roll);
        return heronPose(ctx, {
          feetFree: true, legCurl: { L: [-30 * sink, 20 * sink], R: [-36 * sink, 16 * sink] },
          rootQ: ctx.body.yaw(14 * roll).multiply(ctx.body.roll(88 * roll)),
          neck: { ext: -0.4 * hit + 0.15 * sink * (1 - limp), T: 95, pitch: -14 * limp - 6 * sink, yaw: -80 * limp, roll: 0 },
          head: [12 * hit - 10 * sink, 24 * limp, 8 * limp],
          beak: 16 * hit + 6 * sink,
          wing: wings,
          wingLay: { L: { share: lay, dir: V(-0.25, 0.04, -1), twist: 90 }, R: { share: lay, dir: V(-0.2, 0.55, 1) } },
          tail: [14 * hit - 14 * sink, 10 * limp, 0],
        });
      },
    },
    // Knockdown (non-lethal): a faster version of the heron fall (1.2 s, ground contact at 0.45, held lie from 0.62 to 1.0) that ends on an alert
    // held lie (head and neck off the ground, wings tucked) instead of a limp death. The legs fold as the body sinks and the same wingLay lays
    // the underside wing flat on the ground; the upper wing droops half open as the body rolls.
    'monster-knockdown': {
      floor: 'settle',
      keyTimes: { recoil: 0.1, collapse: 0.3, contact: 0.45, rest: 0.6 },
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        const hit = c([[0, 0], [0.1, 1, 'out'], [0.26, 0.1], [0.36, 0]]);
        // Faster sink and lie curves: contact at 0.45, settled by 0.55, held from 0.6.
        const sink = c([[0, 0], [0.1, 0.05], [0.3, 1, 'in2'], [0.4, 1.04, 'out2'], [0.5, 1, 'io'], [0.6, 1, 'io'], [1, 1]]);
        const roll = c([[0, 0], [0.16, 0, 'lin'], [0.44, 1, 'in2'], [0.5, 1.05, 'out2'], [0.55, 1, 'io'], [0.6, 1, 'io'], [1, 1]]);
        const alert = c([[0, 0], [0.4, 0, 'lin'], [0.6, 1, 'out'], [1, 1, 'io']]);
        const fold = c([[0, 0], [0.1, -0.4, 'out'], [0.3, 0.9, 'io'], [0.5, 0.6, 'lin'], [0.6, 0.2, 'io'], [1, 0.2]]);
        const flap = window01(t, 0.06, 0.12, 0.24, 0.36);
        const wings = heronWings(t, { raise: 36 * hit - 22 * fold, bend: -12 * fold, sweep: 32 * fold, flutter: 10 * flap, cycles: 4 });
        const lay = Math.min(1, roll);
        return heronPose(ctx, {
          feetFree: true, legCurl: { L: [-26 * sink, 18 * sink], R: [-30 * sink, 14 * sink] },
          rootQ: ctx.body.yaw(12 * roll).multiply(ctx.body.roll(88 * roll)),
          neck: { ext: -0.4 * hit + 0.15 * sink * (1 - alert), T: 95, pitch: -10 * alert - 4 * sink, yaw: 0, roll: 0 },
          head: [10 * hit - 8 * sink, 16 * alert, 6 * alert],
          beak: 12 * hit + 4 * sink,
          wing: wings,
          wingLay: { L: { share: lay, dir: V(-0.25, 0.04, -1), twist: 90 }, R: { share: lay, dir: V(-0.2, 0.55, 1) } },
          tail: [12 * hit - 10 * sink, 8 * alert, 0],
        });
      },
    },
    // Get-up (non-lethal): starts on the knockdown's last frame (lying alert on the left side), pushes up with a wing, rolls to sternal,
    // pushes up to a half-crouch, stands into the alert pose (the sampler blends the last quarter into the idle clip's first frame). 1.6 s.
    'monster-getup': {
      floor: 'settle',
      keyTimes: { wing: 0.18, sternal: 0.34, crouch: 0.62, stand: 0.86, idle: 1 },
      pose(t, ctx) {
        const c = keys => curve(keys, t), H = ctx.H;
        // Frame 0 = the knockdown's last frame: sample it lazily so the outer floor guard (ctx.lift) flows through every stage.
        const KNOCKDOWN = HERON.clips['monster-knockdown'];
        // A `stand` window holds the stand phase 0.86-1.0 and lets the body settle into the rest pose before the
        // sampler blends the last quarter into the idle clip's first frame.
        const stand = c([[0, 0], [0.86, 0, 'lin'], [0.92, 1, 'out'], [1, 1, 'io']]);
        // Multi-stage get-up: lying alert on the left side, right wing push to sternal, push up to a half-crouch, stand.
        const stageCtl = [
          null, // stage 0 is the knockdown's last frame; resolved in the closure
          // Wing push: right wing braces on the ground, body rolls back toward sternal.
          { feetFree: true, legCurl: { L: [-12, 6], R: [-16, 4] },
            rootQ: ctx.body.yaw(8).multiply(ctx.body.roll(48)),
            neck: { ext: 0, T: 90, pitch: 12, yaw: 10, roll: 0 },
            head: [4, 14, 4], beak: 0,
            wing: { L: { flap: [-12, -8, -4, -2], sweep: [10, 5, 3, 0], pitch: [0, 0, 0, 0] },
                     R: { flap: [12, 8, 4, 2], sweep: [38, 20, 12, 0], pitch: [0, 0, 0, 0] } },
            tail: [-4, 4, 0] },
          // Sternal: belly on the ground, neck uncoiled, head up, wings half-folded beside the body, legs tucked.
          { feetFree: true, legCurl: { L: [10, -4], R: [10, -4] },
            rootQ: ctx.body.yaw(0).multiply(ctx.body.roll(0)),
            neck: { ext: 0.2, T: 60, pitch: 28, yaw: 0, roll: 0 },
            head: [8, 0, 0], beak: 0,
            wing: heronWings(t, { raise: 6, bend: 0, sweep: 10, flutter: 0, cycles: 1 }),
            tail: [0, 0, 0] },
          // Push-up / crouch: head and chest off the ground, wings half-spread for balance.
          { up: 0.04 * H, root: [-10, 0, 0],
            neck: { ext: 0.5, T: 50, pitch: 16, yaw: 0, roll: 0 },
            head: [6, 0, 0], beak: 0,
            wing: heronWings(t, { raise: 20, bend: -8, sweep: -10, flutter: 0, cycles: 1 }),
            tail: [4, 0, 0] },
          // Stand: brief shake-off with one wing flap, then `stand` holds the rest pose from 0.92 so the clip
          // ends on the idle pose's first frame (the sampler blends the last quarter into it).
          { up: 0, root: [0, 2 * sin(t, 3, 0.1) * (1 - stand), 0],
            neck: { ext: 0.2, T: 60, pitch: 3 * sin(t, 1, 0.2) * (1 - stand), yaw: 4 * sin(t, 1, 0.45) * (1 - stand) },
            head: [3 * (1 - stand), 6 * sin(t, 1, 0.1) * (1 - stand), 2 * sin(t, 1) * (1 - stand)],
            wing: { L: { flap: [5 * sin(t, 1) * (1 - stand), 4 * sin(t, 1, -0.1) * (1 - stand), 0, 0], sweep: [0, 0, 0, 0], pitch: [0, 0, 0, 0] },
                     R: { flap: [-5 * sin(t, 1) * (1 - stand), -4 * sin(t, 1, -0.1) * (1 - stand), 0, 0], sweep: [0, 0, 0, 0], pitch: [0, 0, 0, 0] } },
            tail: [3 * sin(t, 2, 0.3) * (1 - stand), 4 * sin(t, 1, 0.1) * (1 - stand), 0] },
        ];
        const rig = ctx.rig, edges = [0, 0.18, 0.34, 0.62, 0.86];
        return { pb: { solve: () => {
          const stage0 = KNOCKDOWN.pose(1, ctx).pb.solve();
          if (t <= edges[0]) return stage0;
          const stages = [stage0, ...stageCtl.slice(1).map(ctl => heronPose(ctx, ctl).pb.solve())];
          let i = 0;
          while (i < edges.length - 2 && t > edges[i + 1]) i++;
          return blendLocals(rig, stages[i], stages[i + 1], smoothstep((t - edges[i]) / (edges[i + 1] - edges[i])));
        } } };
      },
    },
    // One-shot entrance: the heron starts crouched with the neck coiled tight and the wings folded, unfolds the neck, flares the wings wide with a
    // flutter, sweeps its head left and right, shakes the feathers and settles into the idle clip's first frame (the last quarter blends into it).
    'monster-spawn': {
      floor: true,
      keyTimes: { risen: 0.4, alert: 0.52, shake: 0.7, idle: 1 },
      pose(t, ctx) {
        const c = keys => curve(keys, t), H = ctx.H;
        const low = c([[0, 1], [0.08, 1, 'lin'], [0.4, 0, 'io']]);
        const flare = window01(t, 0.3, 0.44, 0.6, 0.74);
        const look = c([[0.3, 0], [0.46, -1], [0.56, 1], [0.66, -0.35], [0.76, 0]]);
        const shake = window01(t, 0.56, 0.62, 0.8, 0.92);
        const ext = -0.4 * low + 0.35 * flare;
        return heronPose(ctx, {
          up: -0.1 * H * low,
          root: [-6 * low + 6 * flare, 3 * shake * sin(t, 7, 0.1), 2 * shake * sin(t, 7, 0.3)],
          neck: { ext, T: ext < 0 ? 95 : 60, pitch: -8 * low + 4 * flare, yaw: 26 * look + 6 * shake * sin(t, 7, 0.45) },
          head: [-6 * low + 4 * flare, 14 * look + 8 * shake * sin(t, 7, 0.6), 3 * shake * sin(t, 7, 0.9)],
          beak: 12 * window01(t, 0.4, 0.46, 0.54, 0.62),
          wing: heronWings(t, { raise: -26 * low + 44 * flare, bend: -12 * low, sweep: 40 * low, flutter: 10 * flare + 8 * shake, cycles: 6 }),
          tail: [-8 * low + 8 * flare, 6 * shake * sin(t, 6), 0],
        });
      },
    },
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
// Storm Harpy (Storm Crown's Vara companion, the production harpy-eagle raptor; Tripo rig v2.5 avian, world rest: feet y≈0.025,
// hips y≈0.205 at tripo::Spine_0, beak tip +X 0.163 at bone_40, wings T-pose spread ±Z with the +Z wing on bone_20..27 and the -Z wing
// split between bone_28..35 (off Head_0) AND tripo::Spine_1..Spine_3 > bone_45 > bone_47 > bone_48 > bone_49 (off the spine) — both chains
// have to be driven together or the wing tears; tail vertices are bound ~100% to tripo::Root so the body rides it). Every authored clip
// is in place (the simulation owns the actor's translation and altitude), 30 fps, and ends on its first frame so loops are seamless.
// ---------------------------------------------------------------------------------------------
function harpyContext(rig) {
  const j = name => rig.index(name);
  const body = new BodyFrame(V(1, 0, 0));
  // Standing height = bounds y = 0.521. Model is 52 cm tall; scaled 2.5x ≈ 1.3 m standing height, ~2.6 m wingspan (the loader derives).
  const ctx = { rig, body, H: 0.521, castSocketBone: 'tripo::Head_2' };
  ctx.root = j('tripo::Root');
  ctx.spine = j('tripo::Spine_0');   // hips / in-place anchor (the rig's feet bind weight to its parents, Root swings about Spine_0)
  ctx.chest = j('tripo::Spine_1');   // shoulders / wing bases
  // Right (+Z) wing: single chain off Head_0.
  ctx.wing = {
    R: ['bone_20', 'bone_22', 'bone_24', 'bone_25', 'bone_27'].map(j),
    covertsR: ['bone_21', 'bone_23'].map(j),
  };
  // Left (-Z) wing: Chain A off Head_0 mirrors the +Z chain; Chain B off Spine_1 has to follow the same world pose or the wing tears.
  ctx.wingL = {
    chainA: ['bone_28', 'bone_30', 'bone_32', 'bone_33', 'bone_35'].map(j),
    covertsA: ['bone_29', 'bone_31'].map(j),
    chainB: [j('tripo::Spine_2'), j('tripo::Spine_3'), j('bone_45'), j('bone_47'), j('bone_48')],
    covertsB: [j('bone_46')],
  };
  const restP = ctx.restP = rig.world(rig.restLocals()).P;
  if (!(restP[ctx.wing.R[4]].z > 0.2 && restP[ctx.wingL.chainA[4]].z < -0.2)) throw new Error('Harpy wing tip joints are not where the clip set expects (R wing +Z, L wing -Z)');
  // Legs (5 bones each, including toes): left tripo::0_Left_Limb_0..4 + toes (bone_4, bone_7, bone_8); right bone_9 + tripo::0_Right_Limb_0..3 + toes (bone_12, bone_15, bone_16).
  ctx.leg = {
    L: { chain: ['tripo::0_Left_Limb_0', 'tripo::0_Left_Limb_1', 'tripo::0_Left_Limb_2', 'tripo::0_Left_Limb_3', 'tripo::0_Left_Limb_4'].map(j), toes: ['bone_4', 'bone_7', 'bone_8'].map(j) },
    R: { chain: ['bone_9', 'tripo::0_Right_Limb_0', 'tripo::0_Right_Limb_1', 'tripo::0_Right_Limb_2', 'tripo::0_Right_Limb_3'].map(j), toes: ['bone_12', 'bone_15', 'bone_16'].map(j) },
  };
  // Head chain: Head_0 (chest anchor — kept near rest so wing turns don't drag the wings), Head_1 / Head_2 (real head rotation),
  // Head_3 (crest), bone_39 (subcrest), bone_40 (beak tip, +X 0.163).
  ctx.head = { chest: j('tripo::Head_0'), mid: j('tripo::Head_1'), upper: j('tripo::Head_2'), crest: j('tripo::Head_3'), subcrest: j('bone_39'), beak: j('bone_40') };
  // Anchor the in-place translation: rotation about Root's pivot (the brief says tail rides Root, the rig's Root swing is the in-place pivot).
  ctx.hipsJoint = ctx.spine;
  ctx.rootJoint = ctx.root;
  ctx.translationJoints = [ctx.root];
  // Strike joints (used by the author measurement for peak strike speed): wing tip + beak + foot toes for the strike clip.
  ctx.strikeJoints = [ctx.wing.R[3], ctx.wingL.chainA[3], ctx.leg.R.toes[0]];
  return ctx;
}

/** Mirrored +Z / -Z wing pose from one controls object. ap = { flap, sweep, pitch, lead } arrays of degrees.
 *  amp scales the symmetric angles (per joint amplitude); per-side asym is sign-independent */
function harpyWingPose(ctx, ap, { amp = 1, lag = 0.07, tipLag = 0.14, leadBias = 0 } = {}) {
  // ap uses +Z-side convention (positive degrees raise the +Z wing about F, sweep back about U, pitch leading edge about L).
  // Mirror to -Z by negating every axis-angle (sign() flips on the -Z side).
  const right = (flap, sweep, pitch) => ({ flap, sweep, pitch });
  const left = (flap, sweep, pitch) => ({ flap: flap.map(v => -v), sweep: sweep.map(v => -v), pitch: pitch.map(v => -v) });
  return { R: right(ap.flap.map(v => v * amp), ap.sweep.map(v => v * amp), ap.pitch.map(v => v * amp)), L: left(ap.flap.map(v => v * amp), ap.sweep.map(v => v * amp), ap.pitch.map(v => v * amp)), leadBias };
}

/** Apply one wing pose to both wings: chain R (single), chainA (single, mirrored) and chainB (split, mirrored) using the same world-space target.
 *  chainBScale reduces rotation magnitudes along Spine_1..3 so the spine keeps its natural curve while still driving the bound back-world verts of bone_49. */
function harpyPose(ctx, ctl) {
  const { rig, body } = ctx;
  const pb = new PoseBuilder(rig);
  // Root / hips translation (in place: never exceed ±0.04 of the body span on XZ, lift y for flight / takeoff / land).
  if (ctl.root) pb.rotateAbout(ctx.root, body.euler(ctl.root), ctx.restP[ctx.hipsJoint]);
  if (ctl.up) pb.translate(ctx.root, V(0, ctl.up, 0));
  // Chest: subtle counter-bob and pitch to weight body pitch for flight / dive.
  if (ctl.chest) pb.rotate(ctx.chest, body.euler(ctl.chest));
  // Head: Head_0 (chest anchor) is kept at rest; rotation lives on Head_1 / Head_2 (and a small share on the crest / beak).
  if (ctl.head1) pb.rotate(ctx.head.mid, body.euler(ctl.head1));
  if (ctl.head2) pb.rotate(ctx.head.upper, body.euler(ctl.head2));
  if (ctl.crest) pb.rotate(ctx.head.crest, body.euler(ctl.crest));
  if (ctl.beak) pb.rotate(ctx.head.beak, body.euler(ctl.beak));
  if (ctl.subcrest) pb.rotate(ctx.head.subcrest, body.euler(ctl.subcrest));
  // Right wing (single chain off Head_0): flap about F (positive raises), sweep about U (positive pulls back), pitch (leading edge) about L.
  if (ctl.wingR) for (let i = 0; i < ctl.wingR.flap.length; i++) {
    if (ctl.wingR.flap[i]) pb.rotate(ctx.wing.R[i], new Quaternion().setFromAxisAngle(body.F, ctl.wingR.flap[i] * DEG));
    if (ctl.wingR.sweep[i]) pb.rotate(ctx.wing.R[i], new Quaternion().setFromAxisAngle(body.U, ctl.wingR.sweep[i] * DEG));
    if (ctl.wingR.pitch[i]) pb.rotate(ctx.wing.R[i], new Quaternion().setFromAxisAngle(body.L, ctl.wingR.pitch[i] * DEG));
  }
  // Left wing Chain A (off Head_0) — mirror of right (sign-flipped on every axis).
  if (ctl.wingL) for (let i = 0; i < ctl.wingL.flap.length; i++) {
    if (ctl.wingL.flap[i]) pb.rotate(ctx.wingL.chainA[i], new Quaternion().setFromAxisAngle(body.F, ctl.wingL.flap[i] * DEG));
    if (ctl.wingL.sweep[i]) pb.rotate(ctx.wingL.chainA[i], new Quaternion().setFromAxisAngle(body.U, ctl.wingL.sweep[i] * DEG));
    if (ctl.wingL.pitch[i]) pb.rotate(ctx.wingL.chainA[i], new Quaternion().setFromAxisAngle(body.L, ctl.wingL.pitch[i] * DEG));
  }
  // Left wing Chain B (off Spine_1) — same mirror; per-joint scale so Spine_2/3 stay close to rest and the distal joints (bone_47/48/49) carry the weight.
  if (ctl.wingB) {
    const chainBscale = ctl.wingB.scale ?? [0.25, 0.4, 0.6, 0.85, 1.0];
    for (let i = 0; i < ctl.wingB.flap.length; i++) {
      const s = chainBscale[i] ?? 1;
      if (ctl.wingB.flap[i]) pb.rotate(ctx.wingL.chainB[i], new Quaternion().setFromAxisAngle(body.F, ctl.wingB.flap[i] * s * DEG));
      if (ctl.wingB.sweep[i]) pb.rotate(ctx.wingL.chainB[i], new Quaternion().setFromAxisAngle(body.U, ctl.wingB.sweep[i] * s * DEG));
      if (ctl.wingB.pitch[i]) pb.rotate(ctx.wingL.chainB[i], new Quaternion().setFromAxisAngle(body.L, ctl.wingB.pitch[i] * s * DEG));
    }
  }
  // Coverts ride the parent joint's flap (small share) so they don't poke through.
  if (ctl.covertScale != null) {
    for (let i = 0; i < ctx.wing.covertsR.length; i++) {
      const parent = ctx.wing.R[i];
      if (parent === undefined) continue;
      pb.rotate(ctx.wing.covertsR[i], new Quaternion().setFromAxisAngle(body.F, ctl.covertScale * DEG));
    }
    for (let i = 0; i < ctx.wingL.covertsA.length; i++) {
      const parent = ctx.wingL.chainA[i];
      if (parent === undefined) continue;
      pb.rotate(ctx.wingL.covertsA[i], new Quaternion().setFromAxisAngle(body.F, -ctl.covertScale * DEG));
    }
  }
  // Legs: 5-bone swing, [hip, thigh, knee, ankle, foot]. Per-joint weight [0.25, 0.22, 0.2, 0.18, 0.15] (sum 1) so the foot swing
  // distributes smoothly; toes swing on the foot joint (last bone).
  if (ctl.leg) for (const side of ['L', 'R']) {
    const chain = ctx.leg[side].chain, weights = [0.25, 0.22, 0.2, 0.18, 0.15], sig = side === 'R' ? 1 : -1;
    const angles = ctl.leg[side];
    for (let i = 0; i < chain.length; i++) {
      const swing = (angles?.[0] ?? 0) * weights[i];
      const bend = (angles?.[1] ?? 0) * weights[i];
      const yaw = (angles?.[2] ?? 0) * weights[i];
      if (swing) pb.rotate(chain[i], new Quaternion().setFromAxisAngle(body.F, sig * swing * DEG));
      if (bend) pb.rotate(chain[i], new Quaternion().setFromAxisAngle(body.L, sig * bend * DEG));
      if (yaw) pb.rotate(chain[i], new Quaternion().setFromAxisAngle(body.U, sig * yaw * DEG));
    }
    // Toes follow the foot swing at half amplitude.
    if (angles) for (const toe of ctx.leg[side].toes) {
      const swing = (angles[0] ?? 0) * 0.1, bend = (angles[1] ?? 0) * 0.1;
      if (swing) pb.rotate(toe, new Quaternion().setFromAxisAngle(body.F, sig * swing * DEG));
      if (bend) pb.rotate(toe, new Quaternion().setFromAxisAngle(body.L, sig * bend * DEG));
    }
  }
  return { pb };
}

/** Symmetric flap envelope at phase t (cycles per clip): per-joint flap amplitudes [shoulder, mid, wrist, tip1, tip2] with cumulative lag, like the Hornbill.
 *  Also returns sweep (mid-wing back) and pitch (leading-edge lead). Both wings share the envelope; harpyPose mirrors the sign for -Z. */
function harpyWingEnvelope(t, amp, { bias = 0, lag = 0.07, tipLag = 0.14, asym = 0, pitchAmp = 10, sweepAmp = 0 } = {}) {
  const f = (delay) => bias + amp * sin(t, 1, -delay); // 1 cycle per clip for the master flap
  return {
    flap: [f(0), f(lag) * 0.7, f(tipLag) * 0.55, f(2 * tipLag) * 0.4, f(3 * tipLag) * 0.3],
    sweep: [0, sweepAmp * 0.5, sweepAmp * 0.3, sweepAmp * 0.2, 0],
    pitch: [pitchAmp * sin(t, 1, -0.25), pitchAmp * 0.6 * sin(t, 1, -0.3), 0, 0, 0],
    asym,
  };
}

/** Convert a +Z wing envelope into the per-side rotation increments the harpyPose understands (signed for mirroring). */
function harpyWings(t, env, { covertScale = null } = {}) {
  return {
    wingR: { flap: env.flap.map(v => v), sweep: env.sweep.map(v => v), pitch: env.pitch.map(v => v) },
    wingL: { flap: env.flap.map(v => -v), sweep: env.sweep.map(v => -v), pitch: env.pitch.map(v => -v) },
    wingB: { flap: env.flap.map(v => -v), sweep: env.sweep.map(v => -v), pitch: env.pitch.map(v => -v), scale: [0.22, 0.35, 0.55, 0.8, 1.0] },
    covertScale,
  };
}

const HARPY = {
  setup: harpyContext,
  presetMapping: {},
  cleanWeights: { groundLevel: 0.03, groundDistance: 0.12 }, // keep the foot vertices bound to the leg so the talons stay on the ground
  slots: HARPY_SLOTS,
  clips: {
    // Perched idle: body breath, head scans (yaw + crest flicks), slow wing settle (1 flap per clip, low amplitude), short winding tail.
    'vara:idle': {
      pose(t, ctx) {
        const breath = sin(t, 2);
        const env = harpyWingEnvelope(t, 14, { bias: 5, lag: 0.06, tipLag: 0.12, pitchAmp: 6, sweepAmp: 0 });
        return harpyPose(ctx, {
          up: 0.005 * breath,
          chest: [1.5 * breath, 1.2 * sin(t, 1, 0.1), 0.8 * sin(t, 1, 0.3)],
          head1: [2 * sin(t, 1, 0.2), 4 * sin(t, 1, 0.45), 1.5 * sin(t, 1, 0.7)], // real head motion (Head_1, not Head_0)
          head2: [1.4 * sin(t, 1, 0.4), 6 * sin(t, 1, 0.55), 2.0 * sin(t, 1)],
          crest: [3 * sin(t, 1, 0.6), 4 * sin(t, 1, 0.9), 0], // crest flick
          beak: [3 * sin(t, 1, 0.7), 0, 0],
          ...harpyWings(t, env),
          leg: { L: [3 * sin(t, 1, 0.5), 0, 0], R: [3 * sin(t, 1, 0.55), 0, 0] },
        });
      },
    },
    // Walk: powerful grounded stride, half-open balancing wings, body counter-bob, head stabilised.
    'vara:walk': {
      pose(t, ctx) {
        const bob = sin(t, 2, 0.1);
        const env = harpyWingEnvelope(t, 18, { bias: 12, lag: 0.06, tipLag: 0.12, pitchAmp: 8, sweepAmp: 0 });
        // left foot down at t=0, right at t=0.5; stride forward at the swing.
        const footPhase = side => (((t - (side === 'R' ? 0.5 : 0)) % 1) + 1) % 1;
        const swingFoot = side => {
          const s = footPhase(side);
          if (s < 0.55) return [-12 * (1 - 2 * s / 0.55), 0, 0]; // planted, sliding back
          const k = (s - 0.55) / 0.45;
          return [12 * smoothstep(k), 4 * Math.sin(Math.PI * k), 0];
        };
        return harpyPose(ctx, {
          up: 0.008 * bob,
          chest: [-3 + 1.5 * bob, 0, 1 * sin(t, 1, 0.25)],
          head1: [4, 5 * sin(t, 1, 0.45), 0],
          head2: [2 + 1.5 * sin(t, 2, 0.1), 4 * sin(t, 1, 0.55), 0],
          ...harpyWings(t, env, { covertScale: 2 * sin(t, 2) }),
          leg: { L: swingFoot('L'), R: swingFoot('R') },
        });
      },
    },
    // Takeoff: crouch, legs flex (power stroke), explosive downstroke (~0.25), legs tuck at peak (~0.55).
    'vara:takeoff': {
      keyTimes: { crouchEnd: 0.22, launch: 0.28, peak: 0.55, tuckDone: 0.72 },
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        // Wing envelope: hold neutral, drive the downstroke hard from 0.28, hold tucked above rest.
        // Peak downstroke reduced from 36° to 30° to keep the wing-tip skin stretch under the locomotion deformation ceiling.
        const down = c([[0, 0], [0.22, -4, 'io'], [0.28, 4, 'lin'], [0.38, 30, 'out'], [0.52, 24, 'io'], [0.78, 16, 'in'], [1, 0]]);
        const sweep = c([[0, 0], [0.22, -6], [0.38, 20, 'out'], [0.6, 12], [1, 0]]);
        const up = ctx.H * c([[0, 0], [0.22, -0.04], [0.28, -0.04, 'lin'], [0.36, 0.06, 'out'], [0.5, 0.24, 'out2'], [0.6, 0.24, 'lin'], [0.78, 0.04], [1, 0]]);
        const env = { flap: [down, down * 0.7, down * 0.55, down * 0.4, down * 0.3], sweep: [sweep, sweep * 0.5, sweep * 0.3, sweep * 0.2, 0], pitch: [0, 0, 0, 0, 0] };
        return harpyPose(ctx, {
          up,
          chest: [c([[0, 0], [0.22, 8, 'io'], [0.32, -12, 'in'], [0.5, -4], [0.78, 6], [1, 0]]), 0, 0],
          head1: [c([[0, 0], [0.22, -8], [0.3, 6], [0.7, 4], [1, 0]]), 4 * sin(t, 1, 0.45), 0],
          head2: [c([[0, 0], [0.22, -6], [0.32, 4], [0.7, 4], [1, 0]]), 3 * sin(t, 1, 0.55), 0],
          ...harpyWings(t, env, { covertScale: c([[0, 0], [0.22, 6], [0.38, 22, 'out'], [0.6, 14], [1, 0]]) }),
          leg: { L: [c([[0, 0], [0.22, 18], [0.32, -16, 'in'], [0.5, 36, 'in2'], [0.78, 24], [1, 0]]), c([[0, 0], [0.22, 12], [0.32, 6], [0.5, 16, 'out'], [0.78, 8], [1, 0]]), 0],
                 R: [c([[0, 0], [0.22, 18], [0.32, -16, 'in'], [0.5, 36, 'in2'], [0.78, 24], [1, 0]]), c([[0, 0], [0.22, 12], [0.32, 6], [0.5, 16, 'out'], [0.78, 8], [1, 0]]), 0] },
        });
      },
    },
    // Fly: strong flapping, legs tucked, slight body pitch (down on downstroke), head stabilised.
    'vara:fly': {
      pose(t, ctx) {
        // Two flaps per clip with a fast downstroke (sharp raise + ease-out recovery) so the downstroke is faster than the upstroke.
        const phase = (((t * 2) % 1) + 1) % 1;
        // Downstroke 0..0.45 (fast), upstroke 0.45..1 (slower, wrist-folded).
        const down = curve([[0, 0], [0.18, 38, 'out'], [0.32, 32, 'io'], [0.45, -2, 'in'], [0.6, -18, 'out'], [0.78, -12], [1, 0]], phase);
        const pitchAmp = 12;
        const env = { flap: [down, down * 0.7, down * 0.55, down * 0.4, down * 0.3], sweep: [0, 4, 3, 2, 0], pitch: [pitchAmp * sin(TAU * phase, 1, -0.4), 0, 0, 0, 0] };
        return harpyPose(ctx, {
          up: 0.005 * sin(TAU * phase, 1, -0.25),
          chest: [-2, 0, 1.2 * sin(TAU * phase, 1, -0.25)],
          head1: [2, 1.5 * sin(TAU * phase, 1, -0.25), 0],
          head2: [1, 2 * sin(TAU * phase, 1, -0.4), 0],
          ...harpyWings(t, env, { covertScale: 2 * sin(TAU * phase, 1, -0.25) }),
          // Legs tucked: hips up, knees close to body.
          leg: { L: [22, 18, 0], R: [22, 18, 0] },
        });
      },
    },
    // Hover: upright body, deep fast flaps (1.5x rate), talons forward.
    'vara:hover': {
      pose(t, ctx) {
        const phase = (((t * 1.5) % 1) + 1) % 1;
        const down = curve([[0, 0], [0.12, 26, 'out'], [0.32, 30, 'io'], [0.48, -4, 'in'], [0.65, -14, 'out'], [0.85, -8], [1, 0]], phase);
        const env = { flap: [down, down * 0.65, down * 0.5, down * 0.35, down * 0.25], sweep: [0, 4, 3, 2, 0], pitch: [10 * sin(TAU * phase, 1, -0.3), 0, 0, 0, 0] };
        return harpyPose(ctx, {
          up: 0.01 * sin(TAU * phase, 1, -0.25),
          chest: [4, 0, 0], // upright
          head1: [1, 1 * sin(TAU * phase, 1, -0.25), 0],
          head2: [-1, 2 * sin(TAU * phase, 1, -0.4), 0],
          ...harpyWings(t, env, { covertScale: 3 * sin(TAU * phase, 1, -0.25) }),
          // Talons forward: leg swing forward (knee out, foot forward).
          leg: { L: [-8, -6, 0], R: [-8, -6, 0] },
        });
      },
    },
    // Land: wing flare/back-pedal flare, legs forward, settle.
    'vara:land': {
      keyTimes: { flarePeak: 0.3, touchdown: 0.55, settle: 0.85 },
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        // Peak flare reduced from 38° to 30° to keep the wing-tip skin stretch under the locomotion deformation ceiling.
        const flare = c([[0, 0], [0.3, 30, 'out'], [0.55, 22, 'io'], [0.85, 4], [1, 0]]);
        const sweep = c([[0, 0], [0.3, -18, 'out'], [0.55, -12, 'io'], [0.85, -4], [1, 0]]);
        const env = { flap: [flare, flare * 0.6, flare * 0.4, flare * 0.25, flare * 0.15], sweep: [sweep, sweep * 0.5, sweep * 0.3, sweep * 0.2, 0], pitch: [0, 0, 0, 0, 0] };
        return harpyPose(ctx, {
          up: ctx.H * c([[0, 0], [0.3, 0.06], [0.55, -0.03, 'in'], [0.85, -0.005], [1, 0]]),
          chest: [c([[0, 0], [0.3, -10], [0.55, 14, 'out'], [0.85, 6], [1, 0]]), 0, 0],
          head1: [c([[0, 0], [0.3, 6], [0.55, -6, 'in'], [0.85, -2], [1, 0]]), 2 * sin(t, 1, 0.45), 0],
          head2: [c([[0, 0], [0.3, 4], [0.55, -4, 'in'], [1, 0]]), 0, 0],
          ...harpyWings(t, env, { covertScale: c([[0, 0], [0.3, 12], [0.55, 8, 'io'], [0.85, 2], [1, 0]]) }),
          // Legs thrust forward and absorb: hip swing forward, knee bends (positive bend), foot forward at touchdown.
          leg: { L: [c([[0, 0], [0.3, -10], [0.55, 26, 'io'], [0.85, 14], [1, 0]]), c([[0, 0], [0.3, 4], [0.55, 18, 'out'], [0.85, 6], [1, 0]]), 0],
                 R: [c([[0, 0], [0.3, -10], [0.55, 26, 'io'], [0.85, 14], [1, 0]]), c([[0, 0], [0.3, 4], [0.55, 18, 'out'], [0.85, 6], [1, 0]]), 0] },
        });
      },
    },
    // Dive: wings folding back into a stoop, body drops, talons swinging forward at the end.
    'vara:dive': {
      keyTimes: { crouchEnd: 0.18, stoop: 0.4, talons: 0.7, recover: 0.9 },
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        // Wings fold back (high sweep, low flap): sweep dominant. Peak fold reduced from 60° to 36° to keep the wing-tip skin stretch under the locomotion ceiling.
        const fold = c([[0, 0], [0.18, 10], [0.4, 36, 'in'], [0.7, 28], [0.9, 8], [1, 0]]);
        const down = c([[0, 0], [0.18, 4], [0.4, 6], [0.7, -6], [0.9, 4], [1, 0]]);
        const env = { flap: [down, down * 0.6, down * 0.4, down * 0.25, down * 0.15], sweep: [fold, fold * 0.5, fold * 0.3, fold * 0.2, 0], pitch: [0, 0, 0, 0, 0] };
        return harpyPose(ctx, {
          up: ctx.H * c([[0, 0], [0.18, -0.01], [0.4, -0.06, 'in'], [0.7, -0.05, 'lin'], [0.9, -0.01], [1, 0]]),
          chest: [c([[0, 0], [0.18, 6], [0.4, -34, 'in'], [0.7, -28, 'lin'], [0.9, -8], [1, 0]]), 0, 0],
          head1: [c([[0, 0], [0.18, 8], [0.4, 22, 'in'], [0.7, 16], [0.9, 4], [1, 0]]), 4 * sin(t, 1, 0.45), 0],
          head2: [c([[0, 0], [0.18, 6], [0.4, 14, 'in'], [0.7, 8], [0.9, 2], [1, 0]]), 2 * sin(t, 1, 0.55), 0],
          ...harpyWings(t, env, { covertScale: c([[0, 0], [0.18, 4], [0.4, 16, 'in'], [0.7, 12], [0.9, 4], [1, 0]]) }),
          // Talons swing forward at the end (peak 0.7): leg swing + foot forward.
          leg: { L: [c([[0, 0], [0.18, 4], [0.4, 6], [0.7, 32, 'out'], [0.9, 8], [1, 0]]), c([[0, 0], [0.18, 2], [0.4, 6], [0.7, 12, 'out'], [0.9, 4], [1, 0]]), 0],
                 R: [c([[0, 0], [0.18, 4], [0.4, 6], [0.7, 32, 'out'], [0.9, 8], [1, 0]]), c([[0, 0], [0.18, 2], [0.4, 6], [0.7, 12, 'out'], [0.9, 4], [1, 0]]), 0] },
        });
      },
    },
    // Strike (talon rake / grab): legs thrust forward and close, wings mantle wide, beak open. Contact at the talon closure (~0.5).
    'vara:strike': {
      keyTimes: { mantlePeak: 0.35, contact: 0.5, recover: 0.78 },
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        const mantle = c([[0, 0], [0.35, 46, 'out'], [0.5, 30, 'io'], [0.78, 8], [1, 0]]);
        const sweep = c([[0, 0], [0.35, -10], [0.5, 18, 'in'], [0.78, 4], [1, 0]]);
        const env = { flap: [mantle, mantle * 0.6, mantle * 0.4, mantle * 0.25, mantle * 0.15], sweep: [sweep, sweep * 0.5, sweep * 0.3, sweep * 0.2, 0], pitch: [0, 0, 0, 0, 0] };
        return harpyPose(ctx, {
          up: ctx.H * c([[0, 0], [0.35, -0.02], [0.5, -0.04, 'in'], [0.78, -0.01], [1, 0]]),
          chest: [c([[0, 0], [0.35, -10], [0.5, 10, 'in'], [0.78, 4], [1, 0]]), 0, 0],
          head1: [c([[0, 0], [0.35, -4], [0.5, 14, 'in'], [0.78, 4], [1, 0]]), 0, 0],
          head2: [c([[0, 0], [0.35, -2], [0.5, 18, 'in'], [0.78, 4], [1, 0]]), 0, 0],
          beak: [c([[0, 0], [0.35, 0], [0.5, 22, 'out'], [0.66, 22, 'lin'], [0.78, 4], [1, 0]]), 0, 0],
          ...harpyWings(t, env, { covertScale: c([[0, 0], [0.35, 16], [0.5, 10, 'io'], [0.78, 4], [1, 0]]) }),
          // Legs thrust forward then close: hip swing forward (negative swing), knee bends hard (positive bend), foot snaps at contact.
          leg: { L: [c([[0, 0], [0.35, -10], [0.5, -22, 'in'], [0.78, -6], [1, 0]]), c([[0, 0], [0.35, 8], [0.5, 28, 'out'], [0.66, 22, 'lin'], [0.78, 6], [1, 0]]), 0],
                 R: [c([[0, 0], [0.35, -10], [0.5, -22, 'in'], [0.78, -6], [1, 0]]), c([[0, 0], [0.35, 8], [0.5, 28, 'out'], [0.66, 22, 'lin'], [0.78, 6], [1, 0]]), 0] },
        });
      },
    },
    // Screech (sky-mark): head thrown up, crest raised, beak open, wings half-spread.
    'vara-sky-mark': {
      keyTimes: { throwUp: 0.3, hold: 0.6 },
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        const raise = c([[0, 0], [0.3, 1, 'out'], [0.85, 1, 'lin'], [1, 0, 'io']]);
        const shake = window01(t, 0.32, 0.4, 0.84, 0.92);
        const halfSpread = 22 * raise + 4 * shake * sin(t, 9, 0.2);
        const env = { flap: [halfSpread, halfSpread * 0.5, halfSpread * 0.3, halfSpread * 0.2, halfSpread * 0.1], sweep: [-8 * raise, -4 * raise, -2 * raise, 0, 0], pitch: [0, 0, 0, 0, 0] };
        return harpyPose(ctx, {
          up: 0.006 * shake * sin(t, 9, 0.2),
          chest: [12 * raise + 2 * shake * sin(t, 9), 2 * shake * sin(t, 4.5), 0],
          head1: [c([[0, 0], [0.3, 16, 'out'], [0.85, 16, 'lin'], [1, 0, 'io']]), 3 * shake * sin(t, 9, 0.4), 0],
          head2: [c([[0, 0], [0.3, 28, 'out'], [0.85, 28, 'lin'], [1, 0, 'io']]) + 4 * shake * sin(t, 9, 0.5), 5 * shake * sin(t, 4.5, 0.1), 0],
          crest: [c([[0, 0], [0.3, 24, 'out'], [0.85, 24, 'lin'], [1, 0, 'io']]) + 4 * shake * sin(t, 9, 0.7), 0, 0],
          beak: [c([[0, 0], [0.3, 26, 'out'], [0.85, 26, 'lin'], [1, 0, 'io']]) + 8 * shake * sin(t, 9, 0.8), 0, 0],
          ...harpyWings(t, env, { covertScale: 10 * raise + 2 * shake * sin(t, 9, 0.3) }),
          leg: { L: [12 * raise, 0, 0], R: [12 * raise, 0, 0] },
        });
      },
    },
    // Survey: lower the gaze and sweep both sides with a braced, half-open wing stance.
    'vara-sky-survey': {
      keyTimes: { scanLeft: .3, scanRight: .65, reveal: .9 },
      pose(t, ctx) {
        const brace = curve([[0, 0], [.2, 1], [.85, 1], [1, 0]], t);
        const scan = curve([[0, 0], [.3, -28], [.65, 30], [.9, 0], [1, 0]], t);
        const env = { flap: [18 * brace, 10 * brace, 6 * brace, 3 * brace, 0], sweep: [4 * brace, 2 * brace, 0, 0, 0], pitch: [0, 0, 0, 0, 0] };
        return harpyPose(ctx, {
          chest: [-8 * brace, scan * .12, 0], head1: [-14 * brace, scan * .45, 0],
          head2: [-20 * brace, scan, 0], crest: [-6 * brace, 0, 0], beak: [0, 0, 0],
          ...harpyWings(t, env), leg: { L: [5 * brace, 0, 0], R: [5 * brace, 0, 0] },
        });
      },
    },
    // Hurt: recoil, wings jolt.
    'vara:hurt': {
      keyTimes: { flinch: 0.18, settle: 0.4 },
      pose(t, ctx) {
        const c = keys => curve(keys, t);
        const fl = keys => curve(keys, t);
        const jolt = fl([[0, 0], [0.18, 1, 'out'], [0.4, -0.4], [0.7, 0], [1, 0]]);
        const env = { flap: [22 * jolt - 6, 14 * jolt - 4, 8 * jolt - 2, 4 * jolt - 1, 2 * jolt], sweep: [0, 0, 0, 0, 0], pitch: [0, 0, 0, 0, 0] };
        return harpyPose(ctx, {
          up: -0.012 * jolt,
          chest: [fl([[0, 0], [0.18, 14, 'out'], [0.4, -4], [0.7, 0], [1, 0]]), fl([[0, 0], [0.18, -8, 'out'], [0.4, 2], [1, 0]]), fl([[0, 0], [0.18, 6, 'out'], [0.4, -2], [1, 0]])],
          head1: [fl([[0, 0], [0.18, 22, 'out'], [0.4, -6], [0.7, -2], [1, 0]]), fl([[0, 0], [0.18, -10, 'out'], [0.4, 4], [1, 0]]), 0],
          head2: [fl([[0, 0], [0.2, 14, 'out'], [0.4, -4], [1, 0]]), fl([[0, 0], [0.18, -16, 'out'], [0.4, 6], [1, 0]]), 0],
          crest: [fl([[0, 0], [0.18, 12, 'out'], [0.4, -2], [1, 0]]), 0, 0],
          beak: [fl([[0, 0], [0.18, 6, 'out'], [0.4, 0], [1, 0]]), 0, 0],
          ...harpyWings(t, env, { covertScale: 8 * jolt }),
          leg: { L: [fl([[0, 0], [0.18, 16, 'out'], [0.4, 4], [0.7, 0], [1, 0]]), 0, 0], R: [fl([[0, 0], [0.18, 16, 'out'], [0.4, 4], [0.7, 0], [1, 0]]), 0, 0] },
        });
      },
    },
  },
};



// Koro's native macaque rig: conditioned idle/walk, nonlethal lifecycle clips and four distinct
// companion gestures. These are skeletal tracks on the supplied mesh, not runtime body warps.
// ---------------------------------------------------------------------------------------------
const KORO = {
  setup: rig => {
    const accessor = rig.json.accessors[rig.json.meshes[0].primitives[0].attributes.POSITION];
    return howlerContext(rig, round(accessor.max[1] - accessor.min[1]));
  },
  slots: ['monster-idle', 'monster-walk', 'monster-death', 'monster-spawn', 'monster-knockdown', 'monster-getup', 'koro-throw', 'koro-push', 'koro-distract', 'koro-search'],
  idleEdges: { 'koro-throw': [.12, .2], 'koro-push': [.12, .18], 'koro-distract': [.1, .18], 'koro-search': [.1, .16] },
  presetMapping: { 'monster-idle': HOWLER.presetMapping['monster-idle'], 'monster-walk': HOWLER.presetMapping['monster-walk'] },
  clips: {
    'monster-death': HOWLER.clips['monster-death'], 'monster-spawn': HOWLER.clips['monster-spawn'],
    'monster-knockdown': HOWLER.clips['monster-knockdown'], 'monster-getup': HOWLER.clips['monster-getup'],
    'koro-throw': {
      floor: true, keyTimes: { windup: .3, release: .44, impact: .68, recover: .82 },
      strikeJoints: ctx => [ctx.arm.R[2]],
      pose(t, ctx) {
        const H = ctx.H, c = keys => curve(keys, t);
        const load = c([[0, 0], [.3, 1], [.44, 0, 'in'], [.6, 0], [1, 0]]);
        const reach = c([[0, 0], [.34, 0], [.44, 1, 'in'], [.58, .8], [.82, 0], [1, 0]]);
        return bipedPose(ctx, {
          up: -.035 * H * load, hip: [0, -12 * load + 9 * reach, 0],
          torso: [-8 * load + 12 * reach, -18 * load + 14 * reach, -5 * load],
          head: [4 * load, 5 * load, 0],
          arms: { R: { at: [H * (-.23 * load + .48 * reach), H * (.46 * load + .25 * reach), -.09 * H * load] }, L: { at: [.1 * H * load, .12 * H * load, .06 * H * load] } },
        });
      },
    },
    'koro-push': {
      floor: true, keyTimes: { plant: .24, push: .42, settle: .78 },
      pose(t, ctx) {
        const H = ctx.H, brace = window01(t, .02, .24, .78, 1), push = window01(t, .24, .42, .66, .86);
        return bipedPose(ctx, {
          up: -.08 * H * brace, torso: [22 * brace, 0, 0], head: [-10 * brace, 0, 0],
          arms: { L: { from: ctx.spine[1], at: [H * (.24 + .12 * push), -.08 * H, .17 * H] }, R: { from: ctx.spine[1], at: [H * (.24 + .12 * push), -.08 * H, -.17 * H] } },
          feet: { L: [-.08 * H * brace, 0, 0], R: [.06 * H * brace, 0, 0] },
        });
      },
    },
    'koro-distract': {
      floor: true, keyTimes: { handsUp: .32, attention: .5, settle: .82 },
      pose(t, ctx) {
        const H = ctx.H, wave = window01(t, .02, .28, .78, 1), sway = sin(t, 2) * wave;
        return bipedPose(ctx, {
          up: .02 * H * wave, torso: [-8 * wave, 12 * sway, 6 * sway], head: [-10 * wave, -8 * sway, 0],
          arms: { L: { at: [.05 * H, H * (.48 + .08 * sin(t, 3)) * wave, .12 * H * wave] }, R: { at: [.05 * H, H * (.48 - .08 * sin(t, 3)) * wave, -.12 * H * wave] } },
        });
      },
    },
    'koro-search': {
      floor: true, keyTimes: { crouch: .24, inspect: .6, reveal: .9 },
      pose(t, ctx) {
        const H = ctx.H, crouch = window01(t, 0, .24, .72, 1), sweep = sin(t, 1) * crouch;
        return bipedPose(ctx, {
          up: -.13 * H * crouch, torso: [30 * crouch, 12 * sweep, 0], head: [18 * crouch, 16 * sweep, 0],
          arms: { R: { at: [.22 * H * crouch, -.07 * H * crouch, -.12 * H * sweep] }, L: { at: [.08 * H * crouch, .09 * H * crouch, 0] } },
        });
      },
    },
  },
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

// ---------------------------------------------------------------------------------------------
// Hollowheart, the Sapbound Guardian (Grove boss, biped rig v1.0 like the Howler, 3.5 m tall). Tripo ships the full preset set for this
// rig: idle / walk / run / slash / pitch_baseball are conditioned with the Howler's windows (same presets, same durations, so the same
// anchors hold); jump / hurt / turn / dive / roar / death / spawn are the Howler's authored clips scaled to the guardian's measured height.
// ---------------------------------------------------------------------------------------------
// The guardian's arms hang to its knees: the Tripo slash and pitch presets swing the right hand 0.45 to 0.53 m (at the 3.5 m scale) under the
// ground, so those two conditioned clips are floor-guarded at the limb (`limbFloor`).
const HOLLOWHEART_ARM = ['R_Clavicle', 'R_Upperarm', 'R_Forearm', 'R_Hand', 'Spine02', 'Spine01', 'Waist'];
const HOLLOWHEART = {
  setup: ROOTLING.setup,
  presetMapping: HOWLER.presetMapping,
  clips: HOWLER.clips,
  limbFloor: { 'monster-slash': HOLLOWHEART_ARM, 'monster-shoot': HOLLOWHEART_ARM },
};

// ---------------------------------------------------------------------------------------------
// Blood Bamboo Valley (docs/features/asset-pipeline.md, "Blood Bamboo Valley assets").
//
// Koro, the Branchbreaker (Chapter 1 boss form of the monkey leader, the Black Sap thorn still in his shoulder): rig v1.0 biped like the Howler
// (Hip / Waist / Spine01 skeleton, no tail chain, so twelve slots). The boss kit is the Howler's with the Branchbreaker's attacks mapped on it:
// monster-shoot = rock throw (pitch preset), monster-slash = horizontal log sweep, monster-jump = background-to-foreground leap,
// monster-dive = platform charge, monster-roar = chest-beating challenge; the falling branch is an environment hazard, not a clip.
// ---------------------------------------------------------------------------------------------
// The monkey's arms hang to its knees too: the Tripo slash and pitch presets swing the right hand under the ground (0.216 m at the 1.5 m scale), so those two
// conditioned clips are floor-guarded at the limb like the Hollowheart's (`limbFloor`).
const KORO_BRANCHBREAKER = {
  setup: ROOTLING.setup,
  presetMapping: HOWLER.presetMapping,
  clips: HOWLER.clips,
  limbFloor: { 'monster-slash': HOLLOWHEART_ARM, 'monster-shoot': HOLLOWHEART_ARM },
};

// ---------------------------------------------------------------------------------------------
// Marek, the Ash Hunter (human NPC): rig v1.0 with the Mixamo spec (Root, Hips, Spine..Spine2, Neck, Head, shoulders, arms, legs; no fingers), the
// hero rig recipe on a decimated model. The conversation kit is idle, walk and run (Tripo presets, windowed and loop-closed like the Howler's) and the
// Howler's authored jump / hurt / turn / dive / death / spawn on the human skeleton, plus four talking idles that are not monster slots:
// npc-talk-relaxed (the Tripo standing_relax preset), npc-talk-explain (open hands), npc-talk-point (one-shot: points the way) and npc-talk-guarded
// (one hand shields the Black Sap vial on his belt while he glances about). There is no Tripo talk preset: swagger is a walking strut and is not used.
// ---------------------------------------------------------------------------------------------
function mixamoContext(rig, height) {
  const j = name => rig.index(`mixamorig:${name}`);
  const ctx = { rig, body: new BodyFrame(V(1, 0, 0)), H: height, strikeJoints: [j('LeftHand'), j('RightHand')], castSocketBone: 'mixamorig:Head' };
  ctx.hip = j('Hips'); ctx.waist = j('Spine'); ctx.spine = [j('Spine1'), j('Spine2')]; ctx.head = j('Head');
  // One neck joint carries both halves of the Howler's two neck twist joints.
  ctx.neck = [j('Neck'), j('Neck')];
  ctx.arm = { L: ['LeftArm', 'LeftForeArm', 'LeftHand'].map(j), R: ['RightArm', 'RightForeArm', 'RightHand'].map(j) };
  ctx.leg = { L: ['LeftUpLeg', 'LeftLeg', 'LeftFoot'].map(j), R: ['RightUpLeg', 'RightLeg', 'RightFoot'].map(j) };
  ctx.clavicle = { L: j('LeftShoulder'), R: j('RightShoulder') };
  ctx.rootJoint = rig.index('Root');
  ctx.translationJoints = [ctx.rootJoint, ctx.hip];
  ctx.hipsJoint = ctx.hip;
  ctx.restP = rig.world(rig.restLocals()).P;
  ctx.restWQ = rig.restWQ;
  return ctx;
}

/**
 * Slots that are not monster slots (they are not listed in creature-rig-kit's tables): Marek's talking idles and the Ash Hunters' subdued kneel set.
 * `slotOverrides` of a definition replace the seconds of a monster slot for that asset only (the hunters' attacks follow the combat table's windup + recovery).
 */
const EXTRA_SLOTS = {
  'npc-talk-relaxed': { seconds: 3.0, loop: true },
  'npc-talk-explain': { seconds: 3.0, loop: true },
  'npc-talk-point': { seconds: 2.4, loop: false },
  'npc-talk-guarded': { seconds: 3.2, loop: true },
  'hunter-thrust': { seconds: 1.8, loop: false },
  'hunter-subdue': { seconds: 1.6, loop: false },
  'hunter-kneel-idle': { seconds: 3.0, loop: true },
};
let activeSlotOverrides = {};
const slotSeconds = slot => activeSlotOverrides[slot] ?? EXTRA_SLOTS[slot]?.seconds ?? SLOT_SECONDS[slot];
const slotLoops = slot => EXTRA_SLOTS[slot]?.loop ?? SLOT_LOOPS[slot];

const MAREK = {
  setup: rig => {
    const accessor = rig.json.accessors[rig.json.meshes[0].primitives[0].attributes.POSITION];
    return mixamoContext(rig, round(accessor.max[1] - accessor.min[1]));
  },
  slots: ['monster-idle', 'monster-walk', 'monster-run', 'monster-jump', 'monster-hurt', 'monster-turn', 'monster-dive', 'monster-death', 'monster-spawn', 'monster-knockdown', 'monster-getup',
    'npc-talk-relaxed', 'npc-talk-explain', 'npc-talk-point', 'npc-talk-guarded'],
  presetMapping: {
    'monster-idle': HOWLER.presetMapping['monster-idle'], 'monster-walk': HOWLER.presetMapping['monster-walk'], 'monster-run': HOWLER.presetMapping['monster-run'],
    'npc-talk-relaxed': { preset: 'standing_relax', window: [4.0, 7.0], crossfade: 0.6 },
  },
  clips: {
    'monster-jump': HOWLER.clips['monster-jump'], 'monster-hurt': HOWLER.clips['monster-hurt'], 'monster-turn': HOWLER.clips['monster-turn'],
    'monster-dive': HOWLER.clips['monster-dive'], 'monster-death': HOWLER.clips['monster-death'], 'monster-spawn': HOWLER.clips['monster-spawn'],
    'monster-knockdown': HOWLER.clips['monster-knockdown'], 'monster-getup': HOWLER.clips['monster-getup'],
    // Open hands at chest height, alternating small sweeps, a slow nod and a shift of weight: the speaker explaining.
    'npc-talk-explain': {
      keyTimes: {},
      pose(t, ctx) {
        const H = ctx.H;
        const hand = (side, phase) => {
          const inward = side === 'L' ? -1 : 1;
          return { at: [H * (0.2 + 0.05 * sin(t, 2, phase)), H * (0.07 + 0.045 * sin(t, 2, phase + 0.25)), inward * H * (0.16 + 0.03 * sin(t, 1, phase))] };
        };
        return bipedPose(ctx, {
          up: H * 0.006 * sin(t, 2, 0.1),
          hip: [0, 3 * sin(t, 1, 0.1), 2 * sin(t, 1)],
          torso: [2 * sin(t, 2, 0.2), 5 * sin(t, 1, 0.35), 1.5 * sin(t, 1, 0.1)],
          neck: [3 * sin(t, 2, 0.05), 6 * sin(t, 1, 0.3), 0],
          head: [4 * sin(t, 2, 0.15), 8 * sin(t, 1, 0.35), 2 * sin(t, 1, 0.2)],
          arms: { L: hand('L', 0), R: hand('R', 0.5) },
        });
      },
    },
    // One-shot: the right arm rises and points ahead and slightly aside (where the camp lies), held, then lowers; the head follows the hand.
    'npc-talk-point': {
      keyTimes: { raise: 0.3, hold: 0.55, lower: 0.8 },
      pose(t, ctx) {
        const c = keys => curve(keys, t), H = ctx.H;
        const raise = c([[0, 0], [0.3, 1, 'out'], [0.8, 1, 'lin'], [1, 0, 'io']]);
        const settle = window01(t, 0.3, 0.38, 0.72, 0.8);
        return bipedPose(ctx, {
          up: H * 0.004 * raise,
          hip: [0, -6 * raise, 0],
          torso: [2 * raise, -10 * raise + 1.5 * settle * sin(t, 3), 0],
          neck: [-2 * raise, -10 * raise, 0],
          head: [-3 * raise, -12 * raise, 0],
          arms: {
            R: { at: [H * 0.34 * raise, H * 0.22 * raise, H * 0.06 * raise] },
            L: { at: [H * 0.03 * raise, H * 0.02 * raise, 0] },
          },
        });
      },
    },
    // Guarded: the left hand rests over the vial on his belt, the right arm is held across the chest, and the glance sweeps left and right.
    'npc-talk-guarded': {
      keyTimes: {},
      pose(t, ctx) {
        const H = ctx.H;
        return bipedPose(ctx, {
          up: -H * 0.004 + H * 0.004 * sin(t, 2, 0.1),
          hip: [0, 2 * sin(t, 1, 0.5), 2 * sin(t, 1, 0.25)],
          torso: [4 + 1.5 * sin(t, 2, 0.3), -6 * sin(t, 1, 0.45), 0],
          neck: [2, 14 * sin(t, 1, 0.1), 0],
          head: [2 + 2 * sin(t, 2, 0.2), 18 * sin(t, 1, 0.1), 0],
          shrug: 3,
          arms: {
            L: { at: [H * 0.03, -H * 0.05, -H * 0.14] },
            R: { at: [H * (0.2 + 0.01 * sin(t, 2)), H * 0.1, H * 0.15] },
          },
        });
      },
    },
  },
};

// ---------------------------------------------------------------------------------------------
// The Ash Hunters of the Black Sap extraction camp (actor-camp-hunter-melee, actor-camp-hunter-ranged): rig v1.0 with the Mixamo spec like Marek's, the weapon
// part of the mesh (repair-hunter-weapon-skin.mjs binds the melee trapping pole to the LEFT hand and removes detached foreign influences from the ranged
// crossbow net launcher so it follows the RIGHT hand). The weapon rides its hand rigidly, so every clip places the weapon arm explicitly instead of trusting a Tripo preset's arm: `hunterArms` solves a
// two-bone arm on the finished pose (chest-relative hand target + the world direction of the weapon's axis), for authored poses and as an overlay on conditioned
// presets alike. Slots: idle / walk / run (presets, windowed and loop-closed like Marek's, weapon arm overlaid), the melee slash (the preset's overhead chop with the
// pole swung on top) or the ranged shoot (aim + shoot, authored), hurt / turn / death (the knockdown) / spawn (the get-up from the knockdown pose) authored, and the
// non-lethal extras hunter-subdue (kneel down), hunter-kneel-idle (loop) and, for the melee hunter, hunter-thrust (the spear jab).
// ---------------------------------------------------------------------------------------------
const fromToQ = (a, b) => new Quaternion().setFromUnitVectors(a.clone().normalize(), b.clone().normalize());
const mixV = (a, b, w) => a.map((v, i) => v + (b[i] - v) * w);

function hunterContext(rig, spec) {
  const ctx = mixamoContext(rig, spec.height);
  ctx.strikeJoints = [rig.index(`mixamorig:${spec.side === 'L' ? 'Left' : 'Right'}Hand`)];
  ctx.weaponSide = spec.side;
  ctx.freeSide = spec.side === 'L' ? 'R' : 'L';
  ctx.weapon = { axis: spec.axis.clone().normalize(), normal: spec.normal?.clone().normalize() };
  ctx.carry = spec.carry;
  return ctx;
}

/**
 * Two-bone arm on a finished local pose: the hand reaches `target` (clamped to the arm's length), the elbow bends towards `hint`, and the hand takes the world
 * rotation `handWorldQ` (default: it rides the forearm). Shoulder and bone lengths stay as they are.
 */
function placeArm(ctx, locals, side, target, hint, handWorldQ) {
  const { rig } = ctx, [upper, lower, hand] = ctx.arm[side];
  const w = rig.world(locals), S = w.P[upper], E = w.P[lower], Hp = w.P[hand];
  const l1 = E.distanceTo(S), l2 = Hp.distanceTo(E);
  const toTarget = target.clone().sub(S), d = clamp(toTarget.length(), Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4), axis = toTarget.normalize();
  const along = (l1 * l1 - l2 * l2 + d * d) / (2 * d), height = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  let pole = hint.clone().addScaledVector(axis, -hint.dot(axis));
  if (pole.lengthSq() < 1e-10) pole = new Vector3(0, 1, 0).addScaledVector(axis, -axis.y);
  pole.normalize();
  const elbow = S.clone().addScaledVector(axis, along).addScaledVector(pole, height);
  const q1 = fromToQ(E.clone().sub(S), elbow.clone().sub(S));
  const handAfter = S.clone().add(Hp.clone().sub(S).applyQuaternion(q1));
  const q2 = fromToQ(handAfter.sub(elbow), S.clone().addScaledVector(axis, d).sub(elbow));
  const worldUpper = q1.clone().multiply(w.Q[upper]), worldLower = q2.clone().multiply(q1).multiply(w.Q[lower]);
  locals.Q[upper] = w.Q[rig.parent[upper]].clone().invert().multiply(worldUpper);
  locals.Q[lower] = worldUpper.clone().invert().multiply(worldLower);
  // A weapon hand (explicit world rotation): roll the forearm about its own axis (local +Y) so the hand carries no twist against it. The hand's world rotation is unchanged;
  // the wrist stays untwisted and the forearm turns with the weapon, instead of pinching the wrist skin by whatever roll the arm happened to have.
  if (handWorldQ) {
    const wrist = worldLower.clone().invert().multiply(handWorldQ);
    if (wrist.w < 0) wrist.set(-wrist.x, -wrist.y, -wrist.z, -wrist.w);
    worldLower.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 2 * Math.atan2(wrist.y, wrist.w)));
    locals.Q[lower] = worldUpper.clone().invert().multiply(worldLower);
  }
  locals.Q[hand] = worldLower.clone().invert().multiply(handWorldQ ?? q2.clone().multiply(q1).multiply(w.Q[hand]));
}

/** World rotation turning the weapon's rest axis onto `dir`; `upright` then rolls the rail normal (crossbow) to face up, `roll` adds degrees about the axis. */
function weaponTurn(ctx, dir, { roll = 0, upright = false } = {}) {
  const { axis, normal } = ctx.weapon, q = fromToQ(axis, dir);
  if (upright && normal) {
    const turned = normal.clone().applyQuaternion(q), want = new Vector3(0, 1, 0).addScaledVector(dir, -dir.y);
    if (want.lengthSq() > 1e-6) {
      want.normalize();
      q.premultiply(new Quaternion().setFromAxisAngle(dir, Math.atan2(turned.clone().cross(want).dot(dir), turned.dot(want))));
    }
  }
  if (roll) q.premultiply(new Quaternion().setFromAxisAngle(dir, roll * DEG));
  return q;
}

/**
 * Places both arms of a finished pose. hold = the weapon arm { at: [forward, up, outward] in body heights from the chest (or from the carried hand with
 * `carried`), dir: [forward, up, outward] of the weapon axis, roll, upright }; free = the other hand { at, carried } (null leaves a conditioned clip's own arm).
 */
function hunterArms(ctx, locals, ctl) {
  const { rig, body, H } = ctx, s = ctx.weaponSide === 'L' ? 1 : -1;
  const place = (side, sign, spec, handWorldQ) => {
    const hand = ctx.arm[side][2], world = rig.world(locals);
    const target = body.at(spec.carried ? world.P[hand] : world.P[ctx.spine[1]], spec.at[0] * H, spec.at[1] * H, sign * spec.at[2] * H);
    placeArm(ctx, locals, side, target, body.at(V(0, 0, 0), -0.3, -0.5, sign * 0.6), handWorldQ);
  };
  const free = ctl.free === undefined ? ctx.carry.free : ctl.free;
  if (free) place(ctx.freeSide, -s, free);
  const hold = ctl.hold ?? ctx.carry.hold;
  const dir = body.at(V(0, 0, 0), hold.dir[0], hold.dir[1], s * hold.dir[2]).normalize();
  place(ctx.weaponSide, s, hold, weaponTurn(ctx, dir, hold).multiply(rig.restWQ[ctx.arm[ctx.weaponSide][2]]));
}

/** bipedPose for the body (torso, hips, neck, head, legs), then both arms through hunterArms; `ctl.hold` / `ctl.free` default to the carry stance. */
function hunterPose(ctx, ctl) {
  const { pb } = bipedPose(ctx, ctl);
  return { pb: { solve: () => { const locals = pb.solve(); hunterArms(ctx, locals, ctl); return locals; } } };
}
const carryOverlay = (u, locals, ctx) => hunterArms(ctx, locals, { free: null });
const HUNTER_PRESETS = {
  'monster-idle': { ...HOWLER.presetMapping['monster-idle'], overlay: carryOverlay },
  'monster-walk': { ...HOWLER.presetMapping['monster-walk'], overlay: carryOverlay },
  'monster-run': { ...HOWLER.presetMapping['monster-run'], overlay: carryOverlay },
};

/** The weapon's dir in the carry stance moved by the recoil of a hit (flinch) and the slump of the dazed pose (held). */
const tiltDir = (carry, flinch, held) => carry.hold.dir.map((v, i) => v + carry.recoil[i] * flinch + carry.slump[i] * held);

const HUNTER_TURN = {
  keyTimes: {},
  pose(t, ctx) {
    const H = ctx.H, step = (t0, sideSign) => {
      const s = (((t - t0) % 1) + 1) % 1, swing = s < 0.45, k = swing ? s / 0.45 : (s - 0.45) / 0.55;
      const lateral = swing ? -1 + 2 * smoothstep(k) : 1 - 2 * k;
      return [swing ? 0.012 * H * Math.sin(Math.PI * k) : 0, swing ? 0.08 * H * Math.sin(Math.PI * k) : 0, sideSign * 0.04 * H * lateral];
    };
    return hunterPose(ctx, {
      up: -H * 0.012 * (0.5 - 0.5 * Math.cos(TAU * 2 * t)),
      hip: [0, 11 * sin(t, 1), 3 * sin(t, 2, 0.1)],
      torso: [4, -17 * sin(t, 1, 0.04), 0],
      neck: [0, 11 * sin(t, 1, 0.12), 0],
      head: [0, 8 * sin(t, 1, 0.18), 0],
      feet: { L: step(0, 1), R: step(0.5, -1) },
    });
  },
};

/** Hurt: the Howler's flinch (peak 0.2) and dazed hold (0.44-0.62) on the body, the weapon arm recoiling up and back and then hanging low. */
const HUNTER_HURT = {
  keyTimes: { flinch: 0.2, hold: 0.52 },
  pose(t, ctx) {
    const c = keys => curve(keys, t), H = ctx.H, { carry } = ctx;
    const held = c([[0, 0], [0.2, 0, 'lin'], [0.44, 1, 'io'], [0.62, 1, 'lin'], [1, 0, 'io']]);
    const flinch = (1 - held) * c([[0, 0], [0.2, 1, 'out'], [0.4, 0.15], [0.6, -0.06], [1, 0]]);
    const wob = (1 - held) * c([[0, 0], [0.2, 0, 'lin'], [0.36, 1], [0.56, -0.5], [1, 0]]);
    const breath = Math.sin(TAU * 1.4 * (t - 0.44)) * held;
    const [hf, hu, ho] = carry.hold.at, [ff, fu, fo] = carry.free.at;
    return hunterPose(ctx, {
      up: -H * (0.035 * flinch + 0.025 * held),
      hip: [-10 * flinch + 3 * held, 4 * wob, 5 * flinch],
      torso: [20 * flinch - 4 * wob - 10 * held + 1.2 * breath, -8 * flinch, -6 * flinch + 3 * held],
      neck: [26 * flinch - 8 * held + 1.6 * breath, 10 * wob, 0],
      head: [14 * flinch - 10 * held + 2 * breath, -10 * flinch + 10 * held, 0],
      shrug: 14 * flinch - 6 * held,
      free: { at: [ff - 0.12 * flinch + 0.03 * held, fu + 0.2 * flinch - 0.08 * held, fo - 0.1 * flinch] },
      hold: { ...carry.hold, at: [hf - 0.1 * flinch + 0.03 * held, hu + 0.16 * flinch - 0.1 * held, ho - 0.05 * flinch], dir: tiltDir(carry, flinch, held) },
      feet: { L: [-0.02 * flinch, 0, 0], R: [0.02 * flinch, 0, 0] },
    });
  },
};

/** Where the weapon lies once its owner is down: along the ground, parallel to the body, tip towards the head. */
const LYING_DIR = [-1, 0.02, 0.05];

/**
 * Knockdown (monster-death): the Howler's fall on a human: a flinch recoil, the knees buckle, the body falls over backwards onto its back with the arms flung and a
 * small bounce; the last 0.18 is one held pose (floor-guarded). The weapon turns from the carry stance to lying on the ground beside him as he falls. Non-lethal:
 * the presenter plays the head of this clip for a knockdown and `monster-spawn` as the get-up.
 */
const HUNTER_DEATH = {
  floor: true,
  keyTimes: { recoil: 0.1, buckle: 0.42, fall: 0.66, rest: 0.82 },
  pose(t, ctx) {
    const c = keys => curve(keys, t), H = ctx.H, { carry } = ctx;
    const hit = c([[0, 0], [0.1, 1, 'out'], [0.26, 0.1], [0.36, 0]]);
    const sink = c([[0, 0], [0.1, 0.05], [0.42, 1, 'in2'], [0.5, 1, 'lin'], [1, 1]]);
    const fall = c([[0, 0], [0.34, 0], [0.64, 1, 'in'], [0.72, 1.05, 'out2'], [0.82, 1, 'io'], [1, 1]]);
    const flung = c([[0, 0], [0.36, 0], [0.66, 1, 'out'], [0.8, 0.85, 'io'], [1, 0.85]]);
    const lie = c([[0, 0], [0.4, 0], [0.7, 1, 'io'], [1, 1]]);
    return hunterPose(ctx, {
      feetCarried: true,
      up: -0.55 * H * sink + 0.02 * H * hit,
      hip: [82 * fall - 8 * hit - 6 * sink * (1 - fall), 0, 5 * fall],
      torso: [-14 * sink * (1 - fall) + 12 * hit + 10 * fall, 4 * fall, 3 * fall],
      neck: [16 * hit - 10 * sink * (1 - fall) + 12 * fall, 10 * fall, 4 * fall],
      head: [12 * hit - 8 * sink * (1 - fall) + 10 * fall, 16 * fall, 6 * fall],
      shrug: 8 * hit - 6 * fall,
      free: { carried: true, at: [-0.04 * hit + 0.05 * flung, -0.02 * flung, 0.22 * flung] },
      hold: { ...carry.hold, carried: true, at: [-0.04 * hit + 0.05 * flung, -0.04 * flung, 0.2 * flung], dir: mixV(tiltDir(carry, hit, 0), LYING_DIR, lie) },
      feet: { L: [-0.05 * H * fall, 0.03 * H * fall, 0.02 * H * fall], R: [-0.07 * H * fall, 0.02 * H * fall, -0.03 * H * fall] },
    });
  },
};

/**
 * Where the weapon hangs from a limp hand once its owner has given up: the hand beside the thigh, the weapon slanting gently down in front so its tip rests near the ground
 * (the melee blade / the crossbow's bow), the butt end rising a little behind his hip.
 */
const DROPPED = { at: [0.2, -0.22, 0.2], dir: [0.93, -0.3, 0.12] };

/**
 * Defeated kneel as a control set: k = how far the body has dropped to both knees (0 standing, 1 kneeling: shins back along the ground, torso slumped forward, head
 * bowed), kw = how far the weapon has been let go (DROPPED; the free hand is raised open: yielding). breath is the idle's chest.
 */
function kneelControls(ctx, k, kw, breath = 0) {
  const H = ctx.H, { carry } = ctx, [ff, fu, fo] = carry.free.at;
  return {
    up: -0.3 * H * k,
    torso: [-16 * k + 1.2 * breath, 0, 0], neck: [-12 * k + 1.5 * breath, 0, 0], head: [-18 * k + 2 * breath, 0, 0], shrug: -4 * k,
    feet: { L: [-0.21 * H * k, 0.01 * H * k, 0], R: [-0.21 * H * k, 0.01 * H * k, 0] },
    free: { at: [ff + 0.1 * k, fu + 0.31 * k + 0.012 * breath, fo + 0.04 * k] },
    hold: { ...carry.hold, at: mixV(carry.hold.at, DROPPED.at, kw), dir: mixV(carry.hold.dir, DROPPED.dir, kw) },
  };
}

/** Subdue: a stagger, the knees buckle one after the other, the weapon is lowered to the ground, and the body settles bowed on its knees (the kneel idle's first frame). */
const HUNTER_SUBDUE = {
  keyTimes: { stagger: 0.12, buckled: 0.55, kneeling: 0.8 },
  floor: true,
  pose(t, ctx) {
    const c = keys => curve(keys, t), H = ctx.H;
    const k = c([[0, 0], [0.22, 0, 'lin'], [0.62, 1, 'io'], [1, 1]]), kw = c([[0, 0], [0.3, 0, 'lin'], [0.82, 1, 'io'], [1, 1]]);
    const stagger = window01(t, 0.02, 0.1, 0.18, 0.34), settle = window01(t, 0.6, 0.72, 0.78, 0.92);
    const ctl = kneelControls(ctx, k, kw);
    ctl.up -= 0.03 * H * stagger;
    ctl.torso = [ctl.torso[0] + 14 * stagger - 3 * settle, 0, 0];
    ctl.neck = [ctl.neck[0] + 12 * stagger, 0, 0];
    ctl.head = [ctl.head[0] + 10 * stagger - 4 * settle, 8 * stagger, 0];
    return hunterPose(ctx, ctl);
  },
};

/** Kneel idle: the bowed kneeling pose breathing, the head swaying slowly; zero at t = 0 so the subdue clip ends on its first frame. */
const HUNTER_KNEEL = {
  keyTimes: {},
  floor: true,
  pose(t, ctx) {
    const ctl = kneelControls(ctx, 1, 1, sin(t, 1));
    ctl.head = [ctl.head[0], 6 * sin(t, 1), 0];
    ctl.shrug = -4 + 1.5 * sin(t, 1);
    return hunterPose(ctx, ctl);
  },
};

/**
 * Get-up (monster-spawn): starts on the last frame of the knockdown, pushes up to sitting, kneels, crouches leaning on the weapon and stands into the idle's first frame
 * (the sampler blends the last quarter into it). Every key pose is a hunterPose; they are blended pose to pose.
 */
const HUNTER_SPAWN = {
  floor: true,
  keyTimes: { sitting: 0.34, kneeling: 0.52, crouching: 0.72, standing: 1 },
  pose(t, ctx) {
    const H = ctx.H, { carry } = ctx, [hf, hu, ho] = carry.hold.at, [ff, fu, fo] = carry.free.at;
    const lying = HUNTER_DEATH.pose(1, ctx).pb.solve();
    const sitting = hunterPose(ctx, {
      feetCarried: true, up: -0.46 * H, hip: [8, 0, 0], torso: [14, 0, 0], neck: [-8, 0, 0], head: [-6, 0, 0],
      feet: { L: [0.42 * H, 0, -0.03 * H], R: [0.42 * H, 0, 0.03 * H] },
      free: { carried: true, at: [-0.1, -0.12, 0.26] }, hold: { ...carry.hold, carried: true, at: [-0.1, -0.12, 0.28], dir: mixV(carry.hold.dir, LYING_DIR, 0.8) },
    }).pb.solve();
    const kneeling = hunterPose(ctx, {
      up: -0.3 * H, torso: [-6, 0, 0], neck: [-4, 0, 0], head: [-4, 0, 0],
      feet: { L: [-0.21 * H, 0.01 * H, 0], R: [-0.21 * H, 0.01 * H, 0] },
      free: { at: [ff + 0.12, fu + 0.02, fo] }, hold: { ...carry.hold, at: [hf + 0.12, hu - 0.16, ho - 0.02] },
    }).pb.solve();
    const crouching = hunterPose(ctx, {
      up: -0.17 * H, hip: [-4, 0, 0], torso: [-26, 0, 0], neck: [10, 0, 0], head: [8, 0, 0],
      free: { at: [ff + 0.2, fu - 0.14, fo - 0.02] }, hold: { ...carry.hold, at: [hf + 0.12, hu - 0.2, ho - 0.02] },
    }).pb.solve();
    const standing = hunterPose(ctx, {}).pb.solve();
    const rig = ctx.rig, stages = [lying, sitting, kneeling, crouching, standing], edges = [0.12, 0.34, 0.52, 0.72, 0.92];
    return { pb: { solve: () => {
      if (t <= edges[0]) return lying;
      let i = 0;
      while (i < edges.length - 2 && t > edges[i + 1]) i++;
      return blendLocals(rig, stages[i], stages[i + 1], smoothstep((t - edges[i]) / (edges[i + 1] - edges[i])));
    } } };
  },
};

/** hunter-thrust (melee): the pole is levelled at the target and drawn back, jabs forward in one lunge, is held out and returns to the carry. Phase markers in clip fractions. */
const HUNTER_THRUST = {
  keyTimes: { anticipationEnd: 0.39, activeStart: 0.44, activeEnd: 0.5, recoveryEnd: 0.8 },
  pose(t, ctx) {
    const c = keys => curve(keys, t), H = ctx.H, { carry } = ctx;
    const level = c([[0, 0], [0.12, 0, 'lin'], [0.39, 1, 'io'], [0.6, 1, 'lin'], [0.82, 0, 'io'], [1, 0]]);
    const at = [
      c([[0, carry.hold.at[0]], [0.12, carry.hold.at[0]], [0.39, -0.1], [0.44, -0.12, 'lin'], [0.5, 0.34, 'out'], [0.6, 0.34, 'lin'], [0.82, 0.12, 'io'], [1, carry.hold.at[0]]]),
      c([[0, carry.hold.at[1]], [0.12, carry.hold.at[1]], [0.39, -0.1], [0.5, -0.02], [0.6, -0.02, 'lin'], [0.82, -0.08, 'io'], [1, carry.hold.at[1]]]),
      c([[0, carry.hold.at[2]], [0.12, carry.hold.at[2]], [0.39, 0.2], [0.5, 0.1], [0.6, 0.1, 'lin'], [0.82, 0.18, 'io'], [1, carry.hold.at[2]]]),
    ];
    const lunge = c([[0, 0], [0.4, 0, 'lin'], [0.5, 1, 'out'], [0.62, 1, 'lin'], [0.88, 0, 'io'], [1, 0]]);
    const stepLift = window01(t, 0.4, 0.45, 0.5, 0.56);
    return hunterPose(ctx, {
      up: -H * (0.03 * level + 0.04 * lunge),
      hip: [-3 * level + 4 * lunge, -6 * level + 9 * lunge, 0],
      torso: [3 * level - 5 * lunge, -18 * level + 28 * lunge, 0],
      neck: [0, 4 * level - 8 * lunge, 0], head: [0, 6 * level - 10 * lunge, 0],
      feet: { L: [-0.04 * H * lunge, 0, 0], R: [0.16 * H * lunge, 0.07 * H * stepLift, 0] },
      hold: { at, dir: mixV(carry.hold.dir, [1, 0.12, 0.04], level) },
    });
  },
};

/** Melee slash: the preset's overhead chop on the body; the pole rises back and up over the head, comes down in front and is brought back to the carry. */
const slashKeys = [0, 0.14, 0.36, 0.4, 0.46, 0.62, 0.8, 1];
const SLASH_TRACK = {
  at: [[0.05, -0.04, -0.02, 0.18, 0.36, 0.36, 0.14, 0.05], [-0.05, 0.1, 0.28, 0.2, -0.22, -0.22, -0.12, -0.05], [0.24, 0.24, 0.16, 0.12, 0.1, 0.1, 0.2, 0.24]],
  dir: [[0.05, -0.25, -0.55, 0.15, 1, 1, 0.4, 0.05], [1, 1, 0.85, 0.95, -0.15, -0.15, 0.9, 1], [0.08, 0.1, 0.1, 0.1, 0.05, 0.05, 0.1, 0.08]],
};
const slashOverlay = (u, locals, ctx) => {
  const track = values => curve(slashKeys.map((time, i) => [time, values[i]]), u);
  hunterArms(ctx, locals, { free: null, hold: { at: SLASH_TRACK.at.map(track), dir: SLASH_TRACK.dir.map(track) } });
};

/** Ranged shoot: the crossbow is raised from the hip, aimed with both hands, loosed (kick), followed through and lowered. Phase markers in clip fractions. */
const HUNTER_SHOOT = {
  keyTimes: { aimed: 0.4, anticipationEnd: 0.4, activeStart: 0.5, activeEnd: 0.58, recoveryEnd: 0.85 },
  pose(t, ctx) {
    const c = keys => curve(keys, t), H = ctx.H, { carry } = ctx;
    const aim = c([[0, 0], [0.12, 0, 'lin'], [0.4, 1, 'io'], [0.62, 1, 'lin'], [0.85, 0, 'io'], [1, 0]]);
    const kick = window01(t, 0.5, 0.525, 0.54, 0.66);
    const sway = aim * (1 - kick) * 0.006;
    const at = mixV(carry.hold.at, [0.3, 0.07, 0.1], aim), freeAt = mixV(carry.free.at, [0.46, 0.04, -0.02], aim);
    return hunterPose(ctx, {
      up: -H * 0.015 * aim,
      hip: [0, -8 * aim, 0],
      torso: [-3 * aim + 4 * kick, -8 * aim, 0],
      neck: [-3 * aim, 6 * aim, 0], head: [-2 * aim + 2 * kick, 8 * aim, 0],
      feet: { L: [0.05 * H * aim, 0, 0], R: [-0.04 * H * aim, 0, 0] },
      free: { at: [freeAt[0] - 0.02 * kick, freeAt[1] + H * sway, freeAt[2]] },
      hold: { ...carry.hold, at: [at[0] - 0.05 * kick, at[1] + 0.02 * kick + H * sway, at[2]], dir: mixV(carry.hold.dir, [1, 0.02 + 0.14 * kick, -0.03], aim) },
    });
  },
};

/**
 * Knockdown (non-lethal) for the hunters: a shorter version of the hunter fall (1.2 s, ground contact by 0.45, held lie from 0.62 to 1.0) that
 * ends on an alert pose (head up, eyes open) instead of a limp death. Uses the same fall pattern as HUNTER_DEATH but with a smaller hip pitch and
 * a held body so the brief's "no final limp collapse" requirement is satisfied. The weapon turns from the carry stance to lying on the ground
 * beside him as he falls, exactly like HUNTER_DEATH.
 */
const HUNTER_KNOCKDOWN = {
  floor: 'settle',
  keyTimes: { recoil: 0.1, buckle: 0.32, fall: 0.45, rest: 0.62 },
  pose(t, ctx) {
    const c = keys => curve(keys, t), H = ctx.H, { carry } = ctx;
    const hit = c([[0, 0], [0.1, 1, 'out'], [0.26, 0.1], [0.36, 0]]);
    const sink = c([[0, 0], [0.1, 0.05], [0.32, 1, 'in2'], [0.4, 1, 'lin'], [0.62, 1, 'io'], [1, 1]]);
    // Faster fall: ground contact at 0.45, small bounce 0.5, settle to a held lie by 0.62.
    const fall = c([[0, 0], [0.18, 0], [0.44, 1, 'in'], [0.5, 1.06, 'out2'], [0.6, 1, 'io'], [0.62, 1, 'io'], [1, 1]]);
    const tuck = c([[0, 0], [0.36, 0], [0.5, 1, 'out'], [0.62, 1, 'io'], [1, 1]]);
    const lie = c([[0, 0], [0.4, 0], [0.7, 1, 'io'], [1, 1]]);
    return hunterPose(ctx, {
      feetCarried: true,
      up: -0.55 * H * sink + 0.02 * H * hit,
      hip: [78 * fall - 8 * hit - 6 * sink * (1 - fall), 0, 4 * fall],
      torso: [-14 * sink * (1 - fall) + 12 * hit + 8 * fall, 3 * fall, 2 * fall],
      neck: [16 * hit - 10 * sink * (1 - fall) + 10 * fall, 8 * fall, 3 * fall],
      // Head lifts slightly while lying (eyes open, alert) instead of lolling.
      head: [10 * hit - 6 * sink * (1 - fall) - 14 * fall, 10 * fall, 4 * fall],
      shrug: 8 * hit - 4 * fall,
      free: { carried: true, at: [0.04 * tuck, 0.04 * tuck, 0.08 * tuck] },
      hold: { ...carry.hold, carried: true, at: [0.04 * tuck, 0.04 * tuck, 0.08 * tuck], dir: mixV(tiltDir(carry, hit, 0), LYING_DIR, lie) },
      feet: { L: [-0.04 * H * fall, 0.02 * H * fall, 0.02 * H * fall], R: [-0.06 * H * fall, 0.02 * H * fall, -0.02 * H * fall] },
    });
  },
};

/**
 * Get-up (non-lethal) for the hunters: starts on the knockdown's last frame (lying alert on the back, weapon beside), rolls to side-sit, kneels,
 * crouches leaning on the weapon and stands into the idle's first frame (the sampler blends the last quarter into it). 1.6 s, matches the brief.
 */
const HUNTER_GETUP = {
  floor: 'settle',
  keyTimes: { side: 0.18, sit: 0.34, kneel: 0.52, crouch: 0.72, stand: 0.86, idle: 1 },
  pose(t, ctx) {
    const H = ctx.H, { carry } = ctx, [hf, hu, ho] = carry.hold.at, [ff, fu, fo] = carry.free.at;
    const lying = HUNTER_KNOCKDOWN.pose(1, ctx).pb.solve();
    const sideSit = hunterPose(ctx, {
      feetCarried: true, up: -0.32 * H, hip: [22, 0, -38], torso: [-2, 0, -14], neck: [10, 18, 0], head: [4, 22, 0],
      feet: { L: [-0.04 * H, 0.06 * H, 0.06 * H], R: [-0.06 * H, 0.04 * H, -0.04 * H] },
      free: { carried: true, at: [0.08, -0.06, 0.18] }, hold: { ...carry.hold, carried: true, at: [0.06, -0.12, 0.18], dir: mixV(carry.hold.dir, LYING_DIR, 0.4) },
    }).pb.solve();
    const kneeling = hunterPose(ctx, {
      up: -0.22 * H, torso: [-6, 0, 0], neck: [-4, 0, 0], head: [-4, 0, 0],
      feet: { L: [-0.16 * H, 0.02 * H, 0.02 * H], R: [-0.16 * H, 0.02 * H, -0.02 * H] },
      free: { at: [ff + 0.12, fu + 0.02, fo] }, hold: { ...carry.hold, at: [hf + 0.08, hu - 0.12, ho - 0.02] },
    }).pb.solve();
    const crouching = hunterPose(ctx, {
      up: -0.14 * H, hip: [-4, 0, 0], torso: [-22, 0, 0], neck: [6, 0, 0], head: [6, 0, 0],
      free: { at: [ff + 0.18, fu - 0.12, fo - 0.02] }, hold: { ...carry.hold, at: [hf + 0.1, hu - 0.18, ho - 0.02] },
    }).pb.solve();
    const standing = hunterPose(ctx, {}).pb.solve();
    const rig = ctx.rig, stages = [lying, sideSit, kneeling, crouching, standing], edges = [0, 0.18, 0.52, 0.72, 0.92];
    return { pb: { solve: () => {
      if (t <= edges[0]) return lying;
      let i = 0;
      while (i < edges.length - 2 && t > edges[i + 1]) i++;
      return blendLocals(rig, stages[i], stages[i + 1], smoothstep((t - edges[i]) / (edges[i + 1] - edges[i])));
    } } };
  },
};

const HUNTER_COMMON_CLIPS = { 'monster-hurt': HUNTER_HURT, 'monster-turn': HUNTER_TURN, 'monster-death': HUNTER_DEATH, 'monster-spawn': HUNTER_SPAWN, 'monster-knockdown': HUNTER_KNOCKDOWN, 'monster-getup': HUNTER_GETUP, 'hunter-subdue': HUNTER_SUBDUE, 'hunter-kneel-idle': HUNTER_KNEEL };
const HUNTER_COMMON_SLOTS = ['monster-hurt', 'monster-turn', 'monster-death', 'monster-spawn', 'monster-knockdown', 'monster-getup', 'hunter-subdue', 'hunter-kneel-idle'];

// Melee trapping pole: a thin rod 0.98 model units long, grip at 0.615 from the butt. Held in the LEFT hand (the model's -Z side), axis butt -> tip, carried upright at the side.
// Head top 0.959 (the pole tip is 0.982): the body height the clips scale their motion by.
const HUNTER_MELEE = {
  setup: rig => hunterContext(rig, {
    height: 0.959, side: 'L', axis: V(0.046, 0.98, -0.078),
    carry: { hold: { at: [0.05, -0.05, 0.24], dir: [0.05, 1, 0.08] }, free: { at: [0.02, -0.23, 0.16] }, recoil: [-0.45, 0, 0], slump: [0.25, 0, 0] },
  }),
  slots: ['monster-idle', 'monster-walk', 'monster-run', 'monster-slash', 'hunter-thrust', ...HUNTER_COMMON_SLOTS],
  slotOverrides: { 'monster-slash': 1.8 },
  markers: { 'monster-slash': { anticipationEnd: 0.36, activeStart: 0.4, activeEnd: 0.46, recoveryEnd: 0.66 } },
  idleEdges: { 'monster-slash': [0.05, 0.04], 'hunter-thrust': [0.08, 0.12], 'monster-hurt': [0.1, 0.12], 'monster-death': [0.1, 0], 'monster-knockdown': [0.06, 0], 'monster-getup': [0, 0.2], 'hunter-subdue': [0.1, 0] },
  presetMapping: {
    ...HUNTER_PRESETS,
    // The preset's overhead chop: the body hunches and raises the weapon (src 1.0-1.6 s), chops (1.6-2.15), holds low and recovers upright by src 4.9 (the idle's posture).
    'monster-slash': { preset: 'slash', anchors: [[0, 0.3], [0.12, 0.95], [0.36, 1.6], [0.46, 2.15], [0.56, 2.45], [0.66, 3.0], [0.96, 4.9], [1, 5.2]], overlay: slashOverlay },
  },
  clips: { ...HUNTER_COMMON_CLIPS, 'hunter-thrust': HUNTER_THRUST },
};

// Ranged crossbow net launcher: held in the RIGHT hand (+Z side); axis = the stock butt -> the bow (principal axis of its 5,186 hand-bound vertices), normal = the rail's
// side (the weapon's third principal axis, sign settled by the preview sheets). Carried low at the hip with the bow forward. Head top 0.979.
const HUNTER_RANGED = {
  setup: rig => hunterContext(rig, {
    height: 0.979, side: 'R', axis: V(0.596, 0.727, 0.342), normal: V(0.714, -0.674, 0.189),
    carry: { hold: { at: [0.07, -0.2, 0.15], dir: [0.9, -0.3, 0.1], upright: true }, free: { at: [0.02, -0.24, 0.145] }, recoil: [-0.5, 0.5, 0], slump: [0, -0.2, 0] },
  }),
  slots: ['monster-idle', 'monster-walk', 'monster-run', 'monster-shoot', ...HUNTER_COMMON_SLOTS],
  slotOverrides: { 'monster-shoot': 1.9 },
  idleEdges: { 'monster-shoot': [0.08, 0.12], 'monster-hurt': [0.1, 0.12], 'monster-death': [0.1, 0], 'monster-knockdown': [0.06, 0], 'monster-getup': [0, 0.2], 'hunter-subdue': [0.1, 0] },
  markers: {},
  presetMapping: HUNTER_PRESETS,
  clips: { ...HUNTER_COMMON_CLIPS, 'monster-shoot': HUNTER_SHOOT },
};

const DEFS = {
  'actor-thornback-howler': HOWLER, 'actor-koro': KORO, 'actor-grove-rootling': ROOTLING, 'actor-grove-hollowheart': HOLLOWHEART, 'actor-storm-hornbill': HORNBILL, 'actor-mire-viper': VIPER, 'actor-lantern-heron': HERON,
  'actor-koro-branchbreaker': KORO_BRANCHBREAKER, 'actor-marek': MAREK, 'actor-camp-hunter-melee': HUNTER_MELEE, 'actor-camp-hunter-ranged': HUNTER_RANGED,
  'actor-vara-harpy': HARPY,
};

/** The same anatomical frame used by the base native author, reused by attack conditioning. */
export function creatureRigContext(assetId, rig) {
  if (assetId === 'actor-orun') {
    const position = rig.json.accessors[rig.json.meshes[0].primitives[0].attributes.POSITION];
    const ctx = mixamoContext(rig, position.max[1] - position.min[1]);
    const lateral = rig.restP[ctx.leg.R[0]].clone().sub(rig.restP[ctx.leg.L[0]]).setY(0);
    ctx.body = new BodyFrame(new Vector3(0, 1, 0).cross(lateral).normalize());
    return ctx;
  }
  const def = DEFS[assetId === 'actor-grove-blighted-rootling' ? 'actor-grove-rootling' : assetId];
  if (!def) throw new Error(`No creature anatomical frame for ${assetId}`);
  return def.setup(rig);
}

// ---------------------------------------------------------------------------------------------
// Sampling and measurement
// ---------------------------------------------------------------------------------------------
function frameCount(slot) { return Math.round(slotSeconds(slot) * FPS); }

/**
 * Lowest skinned vertex of a local pose relative to the ground level; a clip with spec.floor may never pass through the ground:
 * a pose that would sink is lifted (the family's pose builder adds ctx.lift to its body height) by the smallest height that restores contact
 * (ctx.floorY, 1% of the body height under the rest ground). spec.floor === 'settle' also lowers a hovering pose: every frame rests with its lowest
 * skinned vertex exactly on the rest ground (no sink, no float), the contract of the death clips.
 */
function solveOnFloor(ctx, spec, u) {
  const { rig } = ctx;
  const settle = spec.floor === 'settle', level = settle ? ctx.groundY : ctx.floorY;
  const at = lift => { ctx.lift = lift; const { pb } = spec.pose(u, ctx); return pb.solve(); };
  const ok = pose => { const { P, Q } = rig.world(pose); return ctx.lowest(P, Q) >= level; };
  try {
    const pose = at(0);
    if (!spec.floor || (!settle && ok(pose))) return pose;
    let lo = settle ? -2 * ctx.H : 0, hi = 2 * ctx.H;
    const hiPose = at(hi);
    if (!ok(hiPose)) throw new Error(`Floor guard cannot lift the pose at u=${u.toFixed(3)} clear of the ground`);
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (ok(at(mid))) hi = mid; else lo = mid; }
    return at(hi);
  } finally { ctx.lift = 0; }
}

function sampleAuthored(ctx, slot, spec, idleFirst) {
  const frames = frameCount(slot), loop = slotLoops(slot);
  const poses = [];
  for (let f = 0; f < (loop ? frames : frames + 1); f++) {
    const u = f / frames;
    let pose = solveOnFloor(ctx, spec, u);
    // The entrance ends on the idle clip's first frame: the authored pose returns to rest by 0.78 and is blended into it over the rest.
    if ((slot === 'monster-spawn' || slot === 'monster-getup') && idleFirst) pose = blendLocals(ctx.rig, pose, idleFirst, smoothstep((u - 0.76) / 0.24));
    else if (ctx.idleEdges?.[slot] && idleFirst) pose = blendIdleEdges(ctx, pose, idleFirst, ctx.idleEdges[slot], u);
    poses.push(pose);
  }
  if (loop) poses.push(poses[0]);
  return { name: slot, frames, loop, poses, keyTimes: spec.keyTimes ?? {}, strikeJoints: spec.strikeJoints?.(ctx), produced: 'authored', floor: Boolean(spec.floor) };
}

/**
 * Clips that start and / or end standing (the hunters' hurt, attacks, subdue, knockdown) are blended into the idle clip's first frame over the first / last fraction of
 * their time (`idleEdges[slot] = [start, end]`, 0 = untouched), so idle -> clip -> idle never pops; the pose in between is the authored one.
 */
function blendIdleEdges(ctx, pose, idleFirst, edge, u) {
  const w = Math.max(edge[0] > 0 ? 1 - smoothstep(u / edge[0]) : 0, edge[1] > 0 ? smoothstep((u - (1 - edge[1])) / edge[1]) : 0);
  return w > 0 ? blendLocals(ctx.rig, pose, idleFirst, w) : pose;
}

/** Windows, retimes, loop-closes and in-places a Tripo preset into a monster slot clip. */
function sampleConditioned(ctx, bin, slot, map, idleFirst) {
  const { rig } = ctx;
  const clip = readAnimation(rig, bin, map.preset);
  const frames = frameCount(slot), loop = slotLoops(slot);
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
    if (map.overlay) map.overlay(u, locals, ctx);
    if (ctx.idleEdges?.[slot] && idleFirst) locals = blendIdleEdges(ctx, locals, idleFirst, ctx.idleEdges[slot], u);
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

/**
 * Limb floor guard for a conditioned clip: a frame whose lowest skinned vertex is under the floor (ctx.floorY, or the body's own lowest point
 * with the limb at rest when the feet already dip further, as the idle's toes do) eases the named limb joints towards their rest pose by the
 * smallest share that restores contact, so the limb stops at the ground instead of passing through it. Deterministic (fixed 24-step
 * bisection per frame).
 */
function keepLimbOnFloor(ctx, clip, jointNames) {
  const { rig } = ctx, joints = new Set(jointNames.map(name => rig.index(name))), rest = rig.restLocals();
  const lowestOf = pose => { const { P, Q } = rig.world(pose); return ctx.lowest(P, Q); };
  const towardRest = (pose, share) => ({
    T: pose.T.map((t, i) => (joints.has(i) ? t.clone().lerp(rest.T[i], share) : t)),
    Q: pose.Q.map((q, i) => (joints.has(i) ? q.clone().slerp(rest.Q[i], share) : q)),
  });
  let worst = 0;
  clip.poses = clip.poses.map(pose => {
    const level = Math.min(ctx.floorY, lowestOf(towardRest(pose, 1)));
    if (lowestOf(pose) >= level) return pose;
    let lo = 0, hi = 1;
    for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (lowestOf(towardRest(pose, mid)) >= level) hi = mid; else lo = mid; }
    worst = Math.max(worst, hi);
    return towardRest(pose, hi);
  });
  clip.limbFloor = { joints: jointNames, worstShareTowardRest: Math.round(worst * 1e4) / 1e4 };
}

function measure(ctx, clip, idle) {
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
  const floorMetrics = {};
  if (clip.floor) {
    // Lowest skinned vertex relative to the ground level, in body heights (negative = through the ground, positive = hovering) and the first
    // frame of the final held pose.
    const lowest = clip.poses.map(p => { const { P, Q } = rig.world(p); return (ctx.lowest(P, Q) - ctx.groundY) / ctx.H; });
    const last = clip.poses.at(-1);
    let held = clip.poses.length - 1;
    const same = (a, b) => rig.joints.every(j => a.Q[j].clone().normalize().angleTo(b.Q[j].clone().normalize()) < 1e-5) && ctx.translationJoints.every(j => a.T[j].distanceTo(b.T[j]) < 1e-6);
    while (held > 0 && same(clip.poses[held - 1], last)) held--;
    floorMetrics.floorContactBodyHeights = { lowestOverClip: round(Math.min(...lowest), 4), final: round(lowest.at(-1), 4) };
    floorMetrics.heldFromTime = round(held / clip.frames, 3);
  }
  return {
    ...floorMetrics,
    ...(clip.name === 'monster-spawn' && idle ? {
      // How far the last frame of the entrance is from the idle clip's first frame (largest joint rotation, largest translation).
      idleMatch: {
        maxJointDegrees: round(Math.max(...rig.joints.map(j => clip.poses.at(-1).Q[j].clone().normalize().angleTo(idle.poses[0].Q[j].clone().normalize()))) / DEG, 4),
        rootOffsetUnits: round(Math.max(...ctx.translationJoints.map(j => clip.poses.at(-1).T[j].distanceTo(idle.poses[0].T[j]))), 6),
      },
    } : (clip.name === 'monster-getup' && idle ? {
      // The getup also ends blended into the idle clip's first frame (sampler holds the last quarter to it). Same measurement as the spawn clip.
      idleMatch: {
        maxJointDegrees: round(Math.max(...rig.joints.map(j => clip.poses.at(-1).Q[j].clone().normalize().angleTo(idle.poses[0].Q[j].clone().normalize()))) / DEG, 4),
        rootOffsetUnits: round(Math.max(...ctx.translationJoints.map(j => clip.poses.at(-1).T[j].distanceTo(idle.poses[0].T[j]))), 6),
      },
    } : {})),
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
  activeSlotOverrides = def.slotOverrides ?? {};
  const ctx = def.setup(rig);
  ctx.idleEdges = def.idleEdges;
  ctx.centroid = makeCentroidSampler(rig, source.bin);
  ctx.lowest = makeLowestSampler(source.json, source.bin, rig.joints, 2, def.floorIncludesRoot ? [] : [ctx.rootJoint]);
  ctx.lift = 0;
  const clips = [];
  let idleFirst;
  for (const slot of def.slots ?? MONSTER_SLOTS) {
    const mapping = def.presetMapping[slot];
    if (mapping?.preserved) { clips.push({ name: slot, preserved: mapping.preserved }); continue; }
    clips.push(mapping ? sampleConditioned(ctx, source.bin, slot, mapping, idleFirst) : sampleAuthored(ctx, slot, def.clips[slot], idleFirst));
    if (def.markers?.[slot]) clips.at(-1).keyTimes = def.markers[slot];
    if (mapping && def.limbFloor?.[slot]) keepLimbOnFloor(ctx, clips.at(-1), def.limbFloor[slot]);
    if (slot === 'monster-idle') {
      // Ground level: the lowest skinned vertex of the rest pose; a pose may dip 1% of the body height under it.
      const idle = clips.at(-1), rest = rig.world(rig.restLocals());
      idleFirst = idle.poses[0];
      const groundY = ctx.lowest(rest.P, rest.Q);
      ctx.groundY = groundY;
      ctx.floorY = groundY - 0.01 * ctx.H;
    }
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
      semanticKeyTimes: clip.keyTimes, ...(clip.keyTimes.anticipationEnd === undefined ? {} : { attackWindow: ['anticipationEnd', 'activeStart', 'activeEnd', 'recoveryEnd'].map(key => round(clip.keyTimes[key] * clip.frames / FPS, 3)) }),
      ...(clip.source ? { source: clip.source } : {}), ...(clip.limbFloor ? { limbFloor: clip.limbFloor } : {}), measured: measure(ctx, clip, clips.find(other => other.name === 'monster-idle')),
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
