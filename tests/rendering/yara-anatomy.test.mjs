import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { Quaternion, Vector3 } from 'three';
import { parseGlb } from '../../scripts/assets/import-aren-animation-set.mjs';
import { COMBAT_LIMITS, JOINT_LIMITS, Rig, jointExcursions, readClipFrames, skinDeformationReport } from '../../scripts/assets/retarget-aren-tripo-clips.mjs';
import { createMixamoExact, REST_TOLERANCE_DEGREES, YARA_EXACT } from '../../scripts/assets/mixamo-exact.mjs';

/**
 * Yara's delivered clip set (scripts/assets/author-yara-hero-clips.mjs): her idle, Petal Step and the 12 Heartroot skills are Adobe Mixamo takes played exactly as
 * delivered (no limits, no layers), every retargeted clip is anatomically limited, none deforms the mesh more than her locomotion does, the staff is carried near
 * vertical while she walks, and the second jump (`aren-air-step`) plays in place.
 */
const root = new URL('../../', import.meta.url).pathname;
const output = `${root}asset-source/generated/actor-yara-hero-01/`;
const bytes = readFileSync(`${output}yara-hero-animated.glb`);
const rig = new Rig(parseGlb(bytes));
const report = JSON.parse(readFileSync(`${output}anatomy-report.json`, 'utf8'));
const provenance = JSON.parse(readFileSync(`${output}provenance.json`, 'utf8'));
const entry = JSON.parse(readFileSync(`${output}manifest-entry.json`, 'utf8'));
const LOCOMOTION = ['aren-idle', 'aren-walk', 'aren-run', 'aren-jump', 'aren-forward-left-dive-roll'];
const SKILLS = ['yara-thornshot-1', 'yara-thornshot-2', 'yara-thornshot-3', 'yara-root-spike', 'yara-root-eruption', 'yara-root-charge', 'yara-seed-charge', 'yara-sap-lance', 'yara-seed-storm', 'yara-binding-vines', 'yara-cleanse', 'yara-heartroot-bloom'];
const RIG_SCALE = entry.coordinateTransform.scale;
const hipsWorld = (frames, k) => new Vector3().setFromMatrixPosition(rig.poseFrame(frames, k)[rig.index.get('mixamorig:Hips')]);

const EXACT = provenance.clips.filter((spec) => spec.exact);
const ledger = JSON.parse(readFileSync(`${root}asset-source/mixamo/yara-skills/provenance.json`, 'utf8'));
const DEG = 180 / Math.PI;
/** Angle between two rotations in degrees (atan2 form: exact for tiny differences). */
const angle = (a, b) => { const r = a.clone().invert().multiply(b); return 2 * Math.atan2(Math.hypot(r.x, r.y, r.z), Math.abs(r.w)) * DEG; };
/** Source seconds of output key `k` (30 Hz) through the spec's keys ([tick, seconds], piecewise linear) or loop window, clamped. */
const sourceTime = (spec, k) => {
  const keys = spec.keys ?? [[0, spec.window[0]], [spec.sim.totalTicks, spec.window[1]]], tick = k * 2;
  if (tick <= keys[0][0]) return keys[0][1];
  if (tick >= keys.at(-1)[0]) return keys.at(-1)[1];
  const i = keys.findIndex((key, j) => j < keys.length - 1 && tick <= keys[j + 1][0]);
  return keys[i][1] + (keys[i + 1][1] - keys[i][1]) * ((tick - keys[i][0]) / (keys[i + 1][0] - keys[i][0]));
};

test('the 14 Mixamo takes are the ledger\'s files and every exact clip carries the contract ticks', () => {
  assert.equal(EXACT.length, 14);
  assert.equal(ledger.files.length, 14);
  for (const file of ledger.files) {
    const bytesOfFile = readFileSync(`${root}asset-source/mixamo/yara-skills/${file.file}`);
    assert.equal(createHash('sha256').update(bytesOfFile).digest('hex'), file.sha256, file.file);
    const spec = EXACT.find((item) => item.clip === file.clip);
    assert.ok(spec, `${file.clip} is an exact clip`);
    assert.equal(spec.source.file, `asset-source/mixamo/yara-skills/${file.file}`);
  }
  const TOTAL_TICKS = { 'aren-idle': 596, 'yara-thornshot-1': 26, 'yara-thornshot-2': 28, 'yara-thornshot-3': 34, 'yara-root-spike': 63, 'yara-root-charge': 120, 'yara-root-eruption': 76, 'yara-seed-charge': 112,
    'yara-sap-lance': 30, 'yara-seed-storm': 60, 'yara-binding-vines': 54, 'yara-cleanse': 108, 'yara-heartroot-bloom': 156, 'aren-forward-left-dive-roll': 42 };
  for (const spec of EXACT) {
    assert.equal(spec.sim.totalTicks, TOTAL_TICKS[spec.clip], `${spec.clip} totalTicks`);
    const clip = readClipFrames(rig, spec.clip);
    assert.equal(clip.count, Math.round(TOTAL_TICKS[spec.clip] / 2) + 1, `${spec.clip} key count`);
  }
});

test('exact clips are the Mixamo takes unchanged: every key equals the FBX local at its warped source time (≤ 0.1°), Hips pinned in place, loops not blended', { timeout: 120_000 }, async () => {
  const exact = await createMixamoExact({ root, rig, ...YARA_EXACT });
  assert.ok(exact.restCheck.maxDegrees <= REST_TOLERANCE_DEGREES, `T-pose rest reproduced within ${REST_TOLERANCE_DEGREES}°`);
  const a = new Quaternion(), b = new Quaternion(), hips = rig.index.get('mixamorig:Hips');
  for (const spec of EXACT) {
    const take = await exact.load(spec.source.file), { frames, count } = readClipFrames(rig, spec.clip);
    // `hold`: the idle's right arm is authored (the staff hip hold); every other joint is the take.
    const held = new Set(spec.hold ? ['RightArm', 'RightForeArm', 'RightHand'].map((name) => rig.index.get(`mixamorig:${name}`)) : []);
    let worst = 0;
    for (let k = 0; k < count; k += 1) for (const node of rig.joints) {
      if (held.has(node)) continue;
      worst = Math.max(worst, angle(a.fromArray(frames.rotations[node], k * 4).normalize(), take.localAt(node, sourceTime(spec, k), b)));
    }
    assert.ok(worst <= 0.1, `${spec.clip}: ${worst.toFixed(4)}° from the Mixamo take`);
    assert.ok(report.clips[spec.clip].exactness.maxDegrees <= 0.1, `${spec.clip}: reported exactness`);
    const track = frames.positions[hips];
    for (let k = 1; k < count; k += 1) assert.ok(Math.abs(track[k * 3] - track[0]) < 1e-9 && Math.abs(track[k * 3 + 2] - track[2]) < 1e-9, `${spec.clip}: Hips horizontal pinned`);
    if (spec.loop) {
      assert.equal(report.clips[spec.clip].loopSeam.blended, false, `${spec.clip}: loop not blended`);
      assert.ok(report.clips[spec.clip].loopSeam.maxDegrees <= 1, `${spec.clip}: loop seam ${report.clips[spec.clip].loopSeam.maxDegrees}°`);
    }
  }
});

test('every retargeted Yara clip stays inside its anatomical limits (locomotion: the native envelope, combat: the strict table)', () => {
  for (const spec of provenance.clips.filter((item) => !item.exact)) {
    const table = spec.limits === 'JOINT_LIMITS' ? JOINT_LIMITS : COMBAT_LIMITS;
    const { frames, count } = readClipFrames(rig, spec.clip);
    const excursions = jointExcursions(rig, frames, count, table);
    for (const [joint, peak] of Object.entries(excursions)) {
      assert.ok(peak.swing <= table[joint].swing + 1e-3, `${spec.clip} ${joint} swing ${peak.swing.toFixed(2)}° > ${table[joint].swing}°`);
      assert.ok(peak.twist <= table[joint].twist + 1e-3, `${spec.clip} ${joint} twist ${peak.twist.toFixed(2)}° > ${table[joint].twist}°`);
    }
  }
});

test('no clip deforms the skin more than her locomotion clips do (p99.9 of the triangle-edge stretch)', { timeout: 120_000 }, () => {
  const ceiling = Math.max(...LOCOMOTION.map((name) => Math.max(report.clips[name].deformation.p999, report.clips[name].before?.deformation?.p999 ?? 0)));
  assert.equal(report.deformationCeiling.p999, ceiling);
  for (const name of Object.keys(report.clips)) assert.ok(report.clips[name].deformation.p999 <= ceiling + 1e-9, `${name}: ${report.clips[name].deformation.p999} > ${ceiling}`);
  // The report is the measurement of the delivered bytes: re-measure its ceiling clip and the strongest attack.
  const strongest = SKILLS.reduce((best, name) => (report.clips[name].deformation.p999 > report.clips[best].deformation.p999 ? name : best));
  const ceilingClip = LOCOMOTION.reduce((best, name) => (report.clips[name].deformation.p999 > report.clips[best].deformation.p999 ? name : best));
  for (const name of [ceilingClip, strongest]) {
    const measured = skinDeformationReport(bytes, name);
    assert.ok(Math.abs(measured.p999 - report.clips[name].deformation.p999) < 1e-4, `${name}: re-measured ${measured.p999} vs ${report.clips[name].deformation.p999}`);
    assert.ok(measured.p999 <= ceiling + 1e-4, `${name}: ${measured.p999} > ceiling ${ceiling}`);
  }
});

test('the staff stays near vertical through the idle (18°: it leans out, away from her face) and the walk and run cycles (15°)', () => {
  const shaft = new Vector3(...report.grip.staffAxisHand), up = new Vector3(0, 1, 0), q = new Quaternion();
  for (const [name, limit] of [['aren-idle', 18], ['aren-walk', 15], ['aren-run', 15]]) {
    const { frames, count } = readClipFrames(rig, name);
    let peak = 0;
    for (let k = 0; k < count; k += 1) {
      const world = rig.poseFrame(frames, k)[rig.index.get('mixamorig:RightHand')];
      peak = Math.max(peak, shaft.clone().applyQuaternion(q.setFromRotationMatrix(world)).angleTo(up) * 180 / Math.PI);
    }
    assert.ok(peak < limit, `${name}: staff tilt ${peak.toFixed(2)}°`);
  }
});

test('her idle staff arm is anatomical: hinge elbow, near-straight wrist, upper arm hanging at her side', () => {
  const { frames, count } = readClipFrames(rig, 'aren-idle');
  const I = (name) => rig.index.get(`mixamorig:${name}`), at = (world, name) => new Vector3().setFromMatrixPosition(world[I(name)]);
  const fore = I('RightForeArm'), restInverse = rig.restQuaternion[fore].clone().invert(), local = new Quaternion();
  for (let k = 0; k < count; k += 1) {
    // The elbow only bends about its hinge (the forearm's local Z, the axis every Mixamo take bends it about) and does not roll the forearm.
    const rel = restInverse.clone().multiply(local.fromArray(frames.rotations[fore], k * 4).normalize());
    if (rel.w < 0) rel.set(-rel.x, -rel.y, -rel.z, -rel.w);
    const bend = 2 * Math.acos(Math.min(1, rel.w)) * DEG, offHinge = Math.atan2(Math.hypot(rel.x, rel.y), Math.abs(rel.z)) * DEG;
    assert.ok(bend > 30 && offHinge < 5, `frame ${k}: elbow bend ${bend.toFixed(1)}°, ${offHinge.toFixed(1)}° off its hinge`);
    const world = rig.poseFrame(frames, k);
    const shoulder = at(world, 'RightArm'), elbow = at(world, 'RightForeArm'), wrist = at(world, 'RightHand');
    const forearm = wrist.clone().sub(elbow).normalize(), hand = at(world, 'RightHandMiddle1').sub(wrist).normalize();
    const wristBend = forearm.angleTo(hand) * DEG, trunkDown = at(world, 'Hips').sub(at(world, 'Neck')).normalize();
    const fromTrunk = elbow.clone().sub(shoulder).normalize().angleTo(trunkDown) * DEG;
    assert.ok(wristBend < 25, `frame ${k}: wrist bent ${wristBend.toFixed(1)}°`);
    assert.ok(fromTrunk < 30, `frame ${k}: upper arm ${fromTrunk.toFixed(1)}° from her side`);
  }
});

test('her idle staff arm flows as smoothly as her free arm: no frame-to-frame pop, across the loop seam too', () => {
  const { frames, count } = readClipFrames(rig, 'aren-idle');
  const period = count - 1, a = new Quaternion(), b = new Quaternion();
  /** Angular velocity (degrees per frame, as a rotation vector) of a local track from frame k to k + 1, wrapped over the loop. */
  const velocity = (track, k) => {
    const d = a.fromArray(track, (k % period) * 4).invert().multiply(b.fromArray(track, ((k + 1) % period) * 4));
    if (d.w < 0) d.set(-d.x, -d.y, -d.z, -d.w);
    const s = Math.hypot(d.x, d.y, d.z);
    return new Vector3(d.x, d.y, d.z).multiplyScalar(s > 1e-9 ? 2 * Math.atan2(s, d.w) / s * DEG : 0);
  };
  const peakAcceleration = (name) => {
    const track = frames.rotations[rig.index.get(`mixamorig:${name}`)];
    let peak = 0;
    for (let k = 0; k < period; k += 1) peak = Math.max(peak, velocity(track, k + 1).sub(velocity(track, k)).length());
    return peak;
  };
  // The take's own left arm (Mixamo, untouched) peaks at 0.41°/frame²; a 20° elbow pop measures ~1.5 on the same scale.
  const ceiling = peakAcceleration('LeftArm');
  for (const name of ['RightArm', 'RightForeArm', 'RightHand']) assert.ok(peakAcceleration(name) <= ceiling, `${name}: ${peakAcceleration(name).toFixed(3)}°/frame² > free arm ${ceiling.toFixed(3)}`);
});

test('aren-air-step is in place: no horizontal Hips travel and at most 0.15 m of vertical Hips change', () => {
  const { frames, count } = readClipFrames(rig, 'aren-air-step');
  const low = new Vector3(Infinity, Infinity, Infinity), high = new Vector3(-Infinity, -Infinity, -Infinity);
  for (let k = 0; k < count; k += 1) { const p = hipsWorld(frames, k); low.min(p); high.max(p); }
  assert.ok(Math.hypot(high.x - low.x, high.z - low.z) * RIG_SCALE < 1e-3, 'horizontal Hips travel');
  assert.ok((high.y - low.y) * RIG_SCALE <= 0.15, `vertical Hips change ${((high.y - low.y) * RIG_SCALE).toFixed(3)} m`);
});
