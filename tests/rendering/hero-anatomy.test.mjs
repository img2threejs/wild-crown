import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { Quaternion, Vector3 } from 'three';
import { parseGlb } from '../../scripts/assets/import-aren-animation-set.mjs';
import {
  COMBAT_LIMITS, IN_PLACE_VERTICAL_LIMIT, JOINT_LIMITS, NATIVE_CALIBRATION_CLIPS, OUTPUT_DIRECTORY, Rig,
  jointExcursions, limitJoints, readClipFrames, skinDeformationReport,
} from '../../scripts/assets/retarget-aren-tripo-clips.mjs';

const CROSS_KICK = '1 High and long jump with a cross-kick..001';
const TOLERANCE_DEGREES = 0.5;

describe('Aren anatomical guard and skin deformation', async () => {
  const bytes = await readFile(`${OUTPUT_DIRECTORY}aren-playtest-animated.glb`);
  const report = JSON.parse(await readFile(`${OUTPUT_DIRECTORY}retarget-report.json`, 'utf8'));
  const glb = parseGlb(bytes);
  const rig = new Rig(glb);
  const authored = report.clips.map((clip) => clip.action);
  const hipsName = 'mixamorig:Hips';


  it('passes every native supplied clip through the envelope unchanged', () => {
    for (const name of [...NATIVE_CALIBRATION_CLIPS, CROSS_KICK]) {
      const { frames, count } = readClipFrames(rig, name);
      const before = frames.rotations.map((track) => track && Float32Array.from(track));
      const excursions = jointExcursions(rig, frames, count, JOINT_LIMITS);
      for (const [joint, peak] of Object.entries(excursions)) {
        assert.ok(peak.swing <= JOINT_LIMITS[joint].swing && peak.twist <= JOINT_LIMITS[joint].twist, `${name}: ${joint} ${JSON.stringify(peak)} exceeds the envelope`);
      }
      assert.deepEqual(limitJoints(rig, frames, count, JOINT_LIMITS), {}, `${name}: the guard must not touch a native clip`);
      frames.rotations.forEach((track, node) => { if (track) assert.deepEqual(track, before[node], `${name}: ${rig.names[node]} changed`); });
    }
  });

  it('clamps a twist ramp smoothly: identity below the knee, monotone, never past the limit, no pops', () => {
    const name = 'mixamorig:RightHand', node = rig.index.get(name), limit = COMBAT_LIMITS[name], steps = 241;
    const child = (glb.json.nodes[node].children ?? []).find((c) => rig.joints.includes(c));
    const axis = rig.restPosition[child].clone().normalize();
    const frames = { rotations: rig.names.map(() => undefined), positions: rig.names.map(() => undefined) };
    frames.rotations[node] = new Float32Array(steps * 4);
    const input = [], q = new Quaternion();
    for (let k = 0; k < steps; k += 1) {
      const degrees = k * 0.5; // 0 … 120° of roll about the bone axis
      input.push(degrees);
      q.copy(rig.restQuaternion[node]).multiply(new Quaternion().setFromAxisAngle(axis, degrees * Math.PI / 180)).toArray(frames.rotations[node], k * 4);
    }
    const original = Float32Array.from(frames.rotations[node]);
    assert.ok(limitJoints(rig, frames, steps, { [name]: limit })[name] > 0, 'the ramp exceeds the limit, so a correction is reported');
    const twistAt = (k) => jointExcursions(rig, { rotations: rig.names.map((_, i) => (i === node ? frames.rotations[node].slice(k * 4, k * 4 + 4) : undefined)) }, 1, { [name]: limit })[name];
    const output = Array.from({ length: steps }, (_, k) => twistAt(k));
    output.forEach((value, k) => {
      assert.ok(value.twist <= limit.twist + 0.01, `frame ${k}: twist ${value.twist} passes the limit`);
      assert.ok(value.swing < 1, `frame ${k}: a pure roll must stay a pure roll`);
      if (input[k] <= 0.9 * limit.twist - 0.5) assert.deepEqual(frames.rotations[node].slice(k * 4, k * 4 + 4), original.slice(k * 4, k * 4 + 4), `frame ${k}: below the knee the pose is untouched`);
      if (k > 0) {
        const step = output[k].twist - output[k - 1].twist;
        assert.ok(step >= -0.01 && step <= 0.51, `frame ${k}: the clamped roll advances smoothly (${step})`);
      }
    });
    assert.ok(output.at(-1).twist > 0.97 * limit.twist, 'a large roll saturates just below the limit');
  });


  it('keeps every authored clip within the joint limits (±0.5°) and the combat clips within the combat limits', () => {
    for (const name of authored) {
      const { frames, count } = readClipFrames(rig, name);
      for (const [joint, peak] of Object.entries(jointExcursions(rig, frames, count, JOINT_LIMITS))) {
        assert.ok(peak.swing <= JOINT_LIMITS[joint].swing + TOLERANCE_DEGREES, `${name}: ${joint} swing ${peak.swing.toFixed(1)}° exceeds ${JOINT_LIMITS[joint].swing}°`);
        assert.ok(peak.twist <= JOINT_LIMITS[joint].twist + TOLERANCE_DEGREES, `${name}: ${joint} twist ${peak.twist.toFixed(1)}° exceeds ${JOINT_LIMITS[joint].twist}°`);
      }
    }
    for (const name of ['aren-root-tether', 'aren-cleanse']) {
      const { frames, count } = readClipFrames(rig, name), peaks = jointExcursions(rig, frames, count, COMBAT_LIMITS);
      assert.ok(peaks['mixamorig:Head'].twist <= 50 + TOLERANCE_DEGREES, `${name}: head twist ${peaks['mixamorig:Head'].twist}`);
      for (const side of ['Left', 'Right']) {
        assert.ok(peaks[`mixamorig:${side}Hand`].twist <= 35 + TOLERANCE_DEGREES, `${name}: ${side} hand twist ${peaks[`mixamorig:${side}Hand`].twist}`);
        assert.ok(peaks[`mixamorig:${side}Foot`].twist <= 25 + TOLERANCE_DEGREES, `${name}: ${side} foot twist ${peaks[`mixamorig:${side}Foot`].twist}`);
      }
    }
  });

  it('never deforms the skin of an authored clip beyond the worst native supplied clip (p99.9 edge stretch)', { timeout: 120_000 }, () => {
    const ceiling = Math.max(...NATIVE_CALIBRATION_CLIPS.map((name) => skinDeformationReport(bytes, name).p999));
    assert.ok(ceiling > 0.3 && ceiling < 3, `native ceiling is a sane stretch measure (${ceiling})`);
    for (const name of authored) {
      const stats = skinDeformationReport(bytes, name);
      assert.ok(Number.isFinite(stats.max) && stats.p99 <= stats.p999 && stats.p999 <= stats.max, `${name}: ordered percentiles`);
      assert.ok(stats.p999 <= ceiling, `${name}: p99.9 ${stats.p999} (worst bone ${stats.worstBone}) exceeds the native ceiling ${ceiling}`);
    }
  });

  it('provides the in-place second-jump clip: air steps, forward somersault, open out, soft landing', async () => {
    assert.ok(authored.includes('aren-air-step'));
    const { frames, count } = readClipFrames(rig, 'aren-air-step');
    const hipsTrack = frames.positions[rig.index.get(hipsName)];
    let horizontal = 0, low = Infinity, high = -Infinity;
    for (let k = 0; k < count; k += 1) {
      horizontal = Math.max(horizontal, Math.hypot(hipsTrack[k * 3] - hipsTrack[0], hipsTrack[k * 3 + 2] - hipsTrack[2]));
      low = Math.min(low, hipsTrack[k * 3 + 1]); high = Math.max(high, hipsTrack[k * 3 + 1]);
    }
    assert.ok(horizontal < 0.02, `hips horizontal travel ${horizontal} m`);
    assert.ok(high - low <= 0.15 && high - low <= IN_PLACE_VERTICAL_LIMIT + 1e-6, `hips vertical change ${high - low} m`);
    // The body turns over inside the 0.26–0.62 window and is upright again for the landing.
    const p = new Vector3(), h = new Vector3();
    const headAboveHips = Array.from({ length: count }, (_, k) => {
      const world = rig.poseFrame(frames, k);
      return p.setFromMatrixPosition(world[rig.index.get('mixamorig:Head')]).y - h.setFromMatrixPosition(world[rig.index.get(hipsName)]).y;
    });
    const at = (progress) => headAboveHips[Math.round(progress * (count - 1))];
    assert.ok(at(0) > 0.2 && at(0.12) > 0.2, 'the air steps keep the chest up');
    assert.ok(Math.min(...headAboveHips.slice(Math.round(0.3 * (count - 1)), Math.round(0.6 * (count - 1)) + 1)) < -0.1, 'the somersault inverts the body');
    assert.ok(at(0.9) > 0.2 && at(1) > 0.2, 'the landing absorbs upright');
  });

});
