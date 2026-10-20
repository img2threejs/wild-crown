import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Quaternion, Vector3 } from 'three';
import { parseGlb } from '../../scripts/assets/import-aren-animation-set.mjs';
import { COMBAT_LIMITS, JOINT_LIMITS, Rig, jointExcursions, readClipFrames, skinDeformationReport } from '../../scripts/assets/retarget-aren-tripo-clips.mjs';

/**
 * Yara's delivered clip set (scripts/assets/author-yara-hero-clips.mjs): every clip is anatomically limited, none deforms the mesh more than her
 * locomotion does, the staff is carried near vertical while she walks, and the second jump (`aren-air-step`) plays in place.
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


test('every Yara clip stays inside its anatomical limits (locomotion: the native envelope, combat: the strict table)', () => {
  for (const spec of provenance.clips) {
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

test('the staff stays within 15° of vertical through the walk and run cycles (the idle holds it at the ready)', () => {
  const shaft = new Vector3(...report.grip.staffAxisHand), up = new Vector3(0, 1, 0), q = new Quaternion();
  for (const name of ['aren-walk', 'aren-run']) {
    const { frames, count } = readClipFrames(rig, name);
    let peak = 0;
    for (let k = 0; k < count; k += 1) {
      const world = rig.poseFrame(frames, k)[rig.index.get('mixamorig:RightHand')];
      peak = Math.max(peak, shaft.clone().applyQuaternion(q.setFromRotationMatrix(world)).angleTo(up) * 180 / Math.PI);
    }
    assert.ok(peak < 15, `${name}: staff tilt ${peak.toFixed(2)}°`);
  }
});

test('aren-air-step is in place: no horizontal Hips travel and at most 0.15 m of vertical Hips change', () => {
  const { frames, count } = readClipFrames(rig, 'aren-air-step');
  const low = new Vector3(Infinity, Infinity, Infinity), high = new Vector3(-Infinity, -Infinity, -Infinity);
  for (let k = 0; k < count; k += 1) { const p = hipsWorld(frames, k); low.min(p); high.max(p); }
  assert.ok(Math.hypot(high.x - low.x, high.z - low.z) * RIG_SCALE < 1e-3, 'horizontal Hips travel');
  assert.ok((high.y - low.y) * RIG_SCALE <= 0.15, `vertical Hips change ${((high.y - low.y) * RIG_SCALE).toFixed(3)} m`);
});
