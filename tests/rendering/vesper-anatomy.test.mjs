import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { parseGlb } from '../../scripts/assets/import-aren-animation-set.mjs';
import { readAccessorAny } from '../../scripts/assets/creature-rig-kit.mjs';
import { COMBAT_LIMITS, JOINT_LIMITS, Rig, jointExcursions, readClipFrames, skinDeformationReport } from '../../scripts/assets/retarget-aren-tripo-clips.mjs';
import { bladeClearance, buildBodyProxy, midFrameBladeDeviation, segmentSegmentDistance } from '../../scripts/assets/vesper-blade-clearance.mjs';
import { KATANA_GRIP } from '../../src/rendering/KatanaGrip.mjs';

/**
 * Vesper's delivered clip set (scripts/assets/author-vesper-hero-clips.mjs): every clip is anatomically limited, none deforms the mesh more than the
 * hero's locomotion/reaction ceiling, every skill clip has the simulation's length, the charge and locomotion loops are seamless, the blade lies in the
 * frontal arc and the edge leads every cut on its strike tick, the katana is carried low (never a torch) while moving, the steel never passes through the
 * torso, head or legs (blade-to-body clearance, every frame), no knee hyperextends, no foot sinks through the floor, the second jump plays in place, and
 * the manifest maps every shared action.
 */
const root = new URL('../../', import.meta.url).pathname;
const output = `${root}asset-source/generated/actor-vesper-hero-01/`;
const bytes = readFileSync(`${output}vesper-hero-animated.glb`);
const rig = new Rig(parseGlb(bytes));
const report = JSON.parse(readFileSync(`${output}anatomy-report.json`, 'utf8'));
const provenance = JSON.parse(readFileSync(`${output}provenance.json`, 'utf8'));
const entry = JSON.parse(readFileSync(`${output}manifest-entry.json`, 'utf8'));
const LOCOMOTION = ['aren-idle', 'aren-walk', 'aren-run', 'aren-jump', 'aren-hit', 'aren-cheer', 'aren-defeat', 'vesper-mist-blink'];
const SKILLS = ['vesper-iai-1', 'vesper-iai-2', 'vesper-iai-3', 'vesper-iai-4', 'vesper-shadow-step', 'vesper-cuts-charge', 'vesper-thousand-cuts', 'vesper-kunai-fan', 'vesper-shade-charge',
  'vesper-shade-swap', 'vesper-severing-shadow', 'vesper-cleanse', 'vesper-requiem'];
/** Simulation ticks per clip (src/game/combat/VesperSkills.ts, contract §4: charge loops are 1.0 s, the cleanse is Aren's 90-tick lock + 18 recovery, Mist Blink is 12 + 12). */
const TOTAL_TICKS = {
  'vesper-iai-1': 18, 'vesper-iai-2': 18, 'vesper-iai-3': 22, 'vesper-iai-4': 30, 'vesper-shadow-step': 26, 'vesper-cuts-charge': 60, 'vesper-thousand-cuts': 72, 'vesper-kunai-fan': 24,
  'vesper-shade-charge': 60, 'vesper-shade-swap': 40, 'vesper-severing-shadow': 36, 'vesper-cleanse': 108, 'vesper-requiem': 120, 'vesper-mist-blink': 24, 'aren-air-step': 60,
};
const ACTIVE_TICK = { 'vesper-iai-1': 6, 'vesper-iai-2': 6, 'vesper-iai-3': 8, 'vesper-iai-4': 10, 'vesper-shadow-step': 8, 'vesper-kunai-fan': 9, 'vesper-shade-swap': 8, 'vesper-severing-shadow': 12 };
/** Ticks on which a katana cut or thrust lands (strikes of Thousand Cuts 8…58 and the finisher 66; Requiem 12…84). Requiem tick 110 is the noto/detonation beat, not a blade contact: it is
 * checked for body and floor clearance with every other frame, but asserts no frontal arc, edge lead or speed. */
const STRIKE_TICKS = {
  'vesper-iai-1': [6], 'vesper-iai-2': [6], 'vesper-iai-3': [8], 'vesper-iai-4': [10], 'vesper-shadow-step': [8], 'vesper-severing-shadow': [12],
  'vesper-thousand-cuts': [8, 18, 28, 38, 48, 58, 66], 'vesper-requiem': [12, 24, 36, 48, 60, 72, 84],
};
/** Strike ticks that are thrusts, not cuts: the edge does not lead them. */
const NOT_CUTS = { 'vesper-shadow-step': [8], 'vesper-thousand-cuts': [58], 'vesper-requiem': [72] };
const LOOPS = ['aren-idle', 'aren-walk', 'aren-run', 'vesper-cuts-charge', 'vesper-shade-charge'];
const RIG_SCALE = entry.coordinateTransform.scale;
const bladeAxis = new Vector3(...report.grip.bladeAxisHand);
const hipsWorld = (frames, k) => new Vector3().setFromMatrixPosition(rig.poseFrame(frames, k)[rig.index.get('mixamorig:Hips')]);

test('the manifest and offline safety reports describe the exact delivered GLB', () => {
  const outputHash = createHash('sha256').update(bytes).digest('hex');
  const acceptance = JSON.parse(readFileSync(`${output}acceptance-report.json`, 'utf8'));
  for (const [name, artifact] of Object.entries({ manifest: entry, anatomy: report, acceptance, provenance })) {
    assert.equal(artifact.outputHash, outputHash, `${name} is stale for the delivered Vesper GLB`);
  }
  assert.equal(Object.keys(report.clips).length, 22);
  assert.equal(Object.keys(entry.actionToClipMapping).length, 43);
});

test('every Vesper clip stays inside its anatomical limits (locomotion: the native envelope, combat: the strict table)', () => {
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

test('no clip deforms the skin more than the locomotion/reaction ceiling (p99.9 of the triangle-edge stretch)', { timeout: 180_000 }, () => {
  const ceiling = Math.max(...LOCOMOTION.map((name) => report.clips[name].deformation.p999));
  assert.equal(report.deformationCeiling.p999, ceiling);
  assert.deepEqual(report.deformationCeiling.clips, LOCOMOTION);
  for (const name of Object.keys(report.clips)) assert.ok(report.clips[name].deformation.p999 <= ceiling + 1e-9, `${name}: ${report.clips[name].deformation.p999} > ${ceiling}`);
  // Approved delivered envelope, documented in docs/features/asset-pipeline.md (native run: 1.75485).
  // Pin the historical authority: a worse new reaction must never raise the acceptable ceiling.
  for (const name of Object.keys(report.clips)) assert.ok(report.clips[name].deformation.p999 <= 1.75485, `${name}: p99.9 ${report.clips[name].deformation.p999} > approved native 1.75485`);
  // The report is the measurement of the delivered bytes: re-measure the ceiling clip and the strongest skill.
  const strongest = SKILLS.reduce((best, name) => (report.clips[name].deformation.p999 > report.clips[best].deformation.p999 ? name : best));
  const ceilingClip = LOCOMOTION.find((name) => report.clips[name].deformation.p999 === ceiling);
  for (const name of new Set([ceilingClip, strongest])) {
    const measured = skinDeformationReport(bytes, name);
    assert.ok(Math.abs(measured.p999 - report.clips[name].deformation.p999) < 1e-4, `${name}: re-measured ${measured.p999} vs ${report.clips[name].deformation.p999}`);
    assert.ok(measured.p999 <= ceiling + 1e-4, `${name}: ${measured.p999} > ceiling ${ceiling}`);
  }
});

test('every skill and locomotion clip has the simulation length, and the manifest names every authored clip', () => {
  for (const [name, ticks] of Object.entries(TOTAL_TICKS)) {
    const { times, count } = readClipFrames(rig, name);
    const seconds = times[count - 1] - times[0];
    assert.ok(Math.abs(seconds * 60 - ticks) <= 1, `${name}: ${seconds * 60} ticks, expected ${ticks}`);
    assert.equal(provenance.clips.find((spec) => spec.clip === name).sim.totalTicks, ticks);
  }
  for (const [name, tick] of Object.entries(ACTIVE_TICK)) assert.equal(provenance.clips.find((spec) => spec.clip === name).sim.activeTick, tick, `${name} activeTick`);
  for (const spec of provenance.clips) assert.equal(entry.actionToClipMapping[spec.clip], spec.clip, `${spec.clip} is not mapped to itself`);
});

test('the shared locomotion, reaction, dodge and traversal action ids resolve to Vesper clips', () => {
  const mapping = entry.actionToClipMapping;
  for (const id of ['idle', 'walk', 'run', 'jump', 'hit', 'cheer', 'defeat', 'air-step', 'strafe', 'stagger', 'stumble-recovery', 'hard-landing']) assert.ok(mapping[`aren-${id}`], `aren-${id}`);
  for (const id of ['forward-left-dive-roll', 'forward-right-dive-roll', 'perfect-dodge-left', 'perfect-dodge-right', 'quick-step-left', 'quick-step-right', 'forward-shoulder-roll', 'back-handspring',
    'left-cartwheel', 'right-cartwheel', 'back-left-pivot-roll', 'back-right-pivot-roll', 'low-slide', 'dodge-recovery']) assert.equal(mapping[`aren-${id}`], 'vesper-mist-blink', `aren-${id}`);
  for (const id of ['staff-vault', 'low-ledge', 'swing']) assert.equal(mapping[`aren-${id}`], 'aren-jump', `aren-${id}`);
  for (const [action, clip] of Object.entries(mapping)) assert.ok(provenance.clips.some((spec) => spec.clip === clip), `${action} → ${clip} is not an authored clip`);
  for (const skill of SKILLS) assert.equal(mapping[skill], skill);
  assert.equal(entry.id, 'actor-vesper-hero');
  assert.equal(entry.actorId, 'aren');
  assert.equal(entry.variantOf, 'actor-aren');
  assert.equal(entry.evidenceStatus, 'blocked');
  assert.equal(entry.rigFamily, 'biped');
  assert.deepEqual(entry.sockets, []);
});

test('locomotion and charge loops are seamless: the last frame equals the first', () => {
  const a = new Quaternion(), b = new Quaternion();
  for (const name of LOOPS) {
    const { frames, count } = readClipFrames(rig, name);
    let worst = 0;
    for (const track of frames.rotations) if (track) worst = Math.max(worst, a.fromArray(track, 0).angleTo(b.fromArray(track, (count - 1) * 4)));
    assert.ok(worst < 2e-3, `${name}: loop seam ${worst} rad`);
  }
});

const katanaGrip = report.grip.katanaGrip;
const edgeAxis = new Vector3(...report.grip.edgeAxisHand), palmHand = new Vector3(...report.grip.palmHand);
const handNode = rig.index.get('mixamorig:RightHand');
/** One displayed pose between keys `k` and `k + 1` (each joint slerped by `f`, the way the engine plays 30 fps keys at 60 Hz), as single-frame data. */
function between(frames, k, f) {
  const a = new Quaternion(), b = new Quaternion();
  return {
    rotations: frames.rotations.map((track) => (track ? a.fromArray(track, k * 4).slerp(b.fromArray(track, (k + 1) * 4), f).toArray(new Float32Array(4)) : track)),
    positions: frames.positions.map((track) => (track ? Float32Array.from([0, 1, 2], (c) => track[k * 3 + c] * (1 - f) + track[(k + 1) * 3 + c] * f) : track)),
  };
}
/** Kissaki position, blade axis and edge direction (world) of a (fractional) frame. */
function katanaAt(frames, count, frame) {
  const clamped = Math.max(0, Math.min(count - 1, frame)), k = Math.min(count - 2, Math.floor(clamped));
  const world = rig.poseFrame(between(frames, k, clamped - k), 0), q = new Quaternion().setFromRotationMatrix(world[handNode]);
  const s = bladeAxis.clone().applyQuaternion(q), wrist = new Vector3().setFromMatrixPosition(world[handNode]);
  return { tip: wrist.add(palmHand.clone().applyQuaternion(q)).addScaledVector(s, (katanaGrip.length - katanaGrip.gripFromPommel) / RIG_SCALE), s, edge: edgeAxis.clone().applyQuaternion(q) };
}

test('the blade lies inside the 140° frontal arc (±70° of the chest heading) on every strike tick, searched ±1 frame around it', () => {
  const chest = rig.index.get('mixamorig:Spine2'), chestRestInverse = rig.restWorldQuaternion[chest].clone().invert();
  const q = new Quaternion(), delta = new Quaternion();
  for (const [name, ticks] of Object.entries(STRIKE_TICKS)) {
    const { frames, count } = readClipFrames(rig, name);
    for (const tick of ticks) {
      let best = Infinity;
      for (let k = Math.max(0, Math.round(tick / 2) - 1); k <= Math.min(count - 1, Math.round(tick / 2) + 1); k += 1) {
        const world = rig.poseFrame(frames, k);
        delta.setFromRotationMatrix(world[chest]).multiply(chestRestInverse);
        const heading = new Vector3(0, 0, 1).applyQuaternion(delta).setY(0).normalize(), blade = bladeAxis.clone().applyQuaternion(q.setFromRotationMatrix(world[handNode]));
        best = Math.min(best, blade.angleTo(heading) * 180 / Math.PI);
      }
      assert.ok(best <= 70, `${name} tick ${tick}: blade ${best.toFixed(1)}° from the heading`);
    }
  }
});

test('the edge leads every cut: on the exact strike tick the kissaki travels within 30° of the cutting edge and at real cutting speed', () => {
  for (const [name, ticks] of Object.entries(STRIKE_TICKS)) {
    const { frames, count } = readClipFrames(rig, name);
    for (const tick of ticks.filter((t) => !(NOT_CUTS[name] ?? []).includes(t))) {
      // The kissaki's velocity over the 60 Hz displayed poses either side of the strike tick (half a key each way).
      const k = tick / 2, before = katanaAt(frames, count, k - 0.5), now = katanaAt(frames, count, k), after = katanaAt(frames, count, k + 0.5);
      const velocity = after.tip.clone().sub(before.tip).multiplyScalar(30 * RIG_SCALE);
      assert.ok(velocity.length() >= 8, `${name} tick ${tick}: the kissaki moves ${velocity.length().toFixed(1)} m/s, a cut needs real speed`);
      const across = velocity.clone().addScaledVector(now.s, -velocity.dot(now.s));
      assert.ok(across.length() > 0.7 * velocity.length(), `${name} tick ${tick}: the kissaki travels along its own blade (butt/point first)`);
      const angle = velocity.angleTo(now.edge) * 180 / Math.PI;
      assert.ok(angle <= 30, `${name} tick ${tick}: the edge is ${angle.toFixed(1)}° off the travel direction`);
    }
  }
});

test('every captured thrust travels point-first within 20° of its blade on the exact contact tick', () => {
  for (const [name, tick] of [['vesper-shadow-step', 8], ['vesper-thousand-cuts', 58], ['vesper-requiem', 72]]) {
    const { frames, count } = readClipFrames(rig, name), k = tick / 2;
    const before = katanaAt(frames, count, k - 0.5), now = katanaAt(frames, count, k), after = katanaAt(frames, count, k + 0.5);
    const velocity = after.tip.clone().sub(before.tip).multiplyScalar(30 * RIG_SCALE);
    const angle = velocity.angleTo(now.s) * 180 / Math.PI;
    assert.ok(velocity.length() >= 3, `${name} tick ${tick}: thrust speed ${velocity.length()} m/s`);
    assert.ok(angle <= 20, `${name} tick ${tick}: blade/travel ${angle.toFixed(1)}°`);
  }
});

/** Cuts, thrusts and the kunai throw keep the donor's wrist within 30°; a merely carried sword (every other clip) may be bent up to 45° off the donor hand, still inside the native Hand joint table. */
const STRIKE_CLASS = ['vesper-iai-1', 'vesper-iai-2', 'vesper-iai-3', 'vesper-iai-4', 'vesper-shadow-step', 'vesper-thousand-cuts', 'vesper-requiem', 'vesper-severing-shadow', 'vesper-kunai-fan'];
test('all clips retain captured whole-body sources and only bounded wrist corrections (strikes ≤ 30°, carried sword ≤ 45°)', () => {
  for (const spec of provenance.clips) {
    assert.ok(['mixamo', 'tripo'].includes(spec.origin), `${spec.clip}: ${spec.origin}`);
    for (const field of ['body', 'arm', 'torso', 'aim', 'sway', 'joints']) assert.equal(spec[field], undefined, `${spec.clip}: synthetic ${field} layer`);
    const maximum = STRIKE_CLASS.includes(spec.clip) ? 30 : 45;
    assert.ok(report.clips[spec.clip].wristMaxCorrectionDegrees <= maximum + 0.01, `${spec.clip}: wrist correction ${report.clips[spec.clip].wristMaxCorrectionDegrees}° exceeds ${maximum}°`);
  }
});

test('finite segment clearance catches an intersection between blade samples and handles parallel segments', () => {
  const v = (...xyz) => new Vector3(...xyz);
  assert.ok(segmentSegmentDistance(v(-1, 0, 0), v(1, 0, 0), v(0.017, -1, 0), v(0.017, 1, 0)) < 1e-12);
  assert.equal(segmentSegmentDistance(v(0, 0, 0), v(1, 0, 0), v(0, 1, 0), v(1, 1, 0)), 1);
  assert.equal(segmentSegmentDistance(v(0, 0, 0), v(0, 0, 0), v(-1, 1, 0), v(1, 1, 0)), 1);
});

test('clearance rejects a body intersection that exists only between two otherwise-clear keys', () => {
  const start = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 3);
  const end = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 3);
  const frames = { rotations: [Float32Array.from([...start.toArray(), ...end.toArray()])], positions: [new Float32Array([0, 1, 0, 0, 1, 0])] };
  const fixture = {
    index: new Map([['mixamorig:RightHand', 0]]),
    poseFrame(data, k) {
      return [
        new Matrix4().compose(new Vector3().fromArray(data.positions[0], k * 3), new Quaternion().fromArray(data.rotations[0], k * 4), new Vector3(1, 1, 1)),
        new Matrix4().makeTranslation(0, 1, 0.6), new Matrix4().makeTranslation(0, 1, 0.7),
      ];
    },
  };
  const capsules = [{ name: 'Spine', node: 1, toNode: 2, radius: 0.03 }];
  const grip = { s: new Vector3(0, 0, 1), palm: new Vector3() };
  assert.ok(bladeClearance(fixture, frames, 2, capsules, grip, KATANA_GRIP, 1, 1).min > 0, 'both keys really are clear');
  const interpolated = bladeClearance(fixture, frames, 2, capsules, grip, KATANA_GRIP, 1);
  assert.ok(interpolated.min < 0, 'the interpolated shaft crosses the capsule');
  assert.equal(interpolated.frame, 0.5);
});

test('the katana is carried low (never a vertical torch): at least 10° below horizontal through the idle, walk, run and jump, and forward at rest and walking', () => {
  const up = new Vector3(0, 1, 0), q = new Quaternion(), chest = rig.index.get('mixamorig:Spine2'), chestRestInverse = rig.restWorldQuaternion[chest].clone().invert(), delta = new Quaternion();
  for (const name of ['aren-idle', 'aren-walk', 'aren-run', 'aren-jump']) {
    const { frames, count } = readClipFrames(rig, name);
    let low = Infinity, ahead = Infinity;
    for (let k = 0; k < count; k += 1) {
      const world = rig.poseFrame(frames, k), blade = bladeAxis.clone().applyQuaternion(q.setFromRotationMatrix(world[handNode]));
      low = Math.min(low, blade.angleTo(up) * 180 / Math.PI);
      delta.setFromRotationMatrix(world[chest]).multiply(chestRestInverse);
      ahead = Math.min(ahead, blade.dot(new Vector3(0, 0, 1).applyQuaternion(delta).setY(0).normalize()));
    }
    assert.ok(low >= 100, `${name}: the blade rises to ${low.toFixed(1)}° from vertical (needs ≥ 100°: at least 10° below horizontal)`);
    if (name === 'aren-idle' || name === 'aren-walk') assert.ok(ahead > 0.2, `${name}: the blade does not point forward (${ahead.toFixed(2)})`);
  }
});

const glb = parseGlb(bytes);
const proxy = buildBodyProxy(glb, rig);
const ARMS = /Arm|Hand/;
/** Zero penetration is required, including reactions and interpolated poses. */
const gripFrame = { s: bladeAxis, palm: palmHand };

test('the katana never passes through the torso, head or legs: blade-to-body clearance over every frame of every clip', () => {
  const body = proxy.filter((capsule) => !ARMS.test(capsule.name));
  for (const spec of provenance.clips) {
    const { frames, count } = readClipFrames(rig, spec.clip);
    const clearance = bladeClearance(rig, frames, count, body, gripFrame, katanaGrip, RIG_SCALE);
    assert.ok(clearance.min * RIG_SCALE >= 0, `${spec.clip}: the steel is ${(-clearance.min * RIG_SCALE).toFixed(3)} m inside ${clearance.bone} on frame ${clearance.frame}`);
  }
});

/** Air Step is only airborne: the engine lifts the actor (boost apex 2.1 m) and the driver maps its rising/falling phases onto the clip, so the model-relative floor at root y 0 is not a world floor.
 * Its floor is the measured engine + real-katana world minimum (asset-source/generated/actor-vesper-hero-01/measure-runtime-jump.mjs), bound to these exact hero bytes. */
const AIRBORNE_ONLY = ['aren-air-step'];
test('the katana clears both arms and the floor at keys and interpolated poses of every clip', () => {
  for (const spec of provenance.clips) {
    const { frames, count } = readClipFrames(rig, spec.clip);
    const clearance = bladeClearance(rig, frames, count, proxy, gripFrame, katanaGrip, RIG_SCALE);
    assert.ok(clearance.min >= 0, `${spec.clip}: the steel is ${(-clearance.min * RIG_SCALE).toFixed(3)} m inside ${clearance.bone} on frame ${clearance.frame}`);
    if (AIRBORNE_ONLY.includes(spec.clip)) continue;
    assert.ok(clearance.floor * RIG_SCALE >= 0.02, `${spec.clip}: the kissaki or pommel is ${(clearance.floor * RIG_SCALE).toFixed(3)} m above the floor on frame ${clearance.floorFrame}`);
  }
});

test('the airborne second jump keeps the real katana above the world floor through the actual engine jump (runtime report bound to the delivered bytes)', () => {
  const jump = JSON.parse(readFileSync(`${output}runtime-jump-report.json`, 'utf8'));
  assert.equal(jump.outputHash, createHash('sha256').update(bytes).digest('hex'), 'runtime-jump-report.json is stale: re-run measure-runtime-jump.mjs against the delivered GLB');
  assert.equal(jump.weaponHash, createHash('sha256').update(readFileSync(`${root}asset-source/generated/prop-vesper-katana-runtime-02/prop-vesper-katana.glb`)).digest('hex'), 'runtime-jump-report.json is stale for the shipped katana');
  assert.ok(jump.scenarios.length >= 4);
  for (const scenario of jump.scenarios) assert.ok(scenario.minimumWorldFloorMetres >= 0.02, `boost at ${scenario.boostAt}: the katana reaches ${scenario.minimumWorldFloorMetres.toFixed(3)} m above the world floor`);
});

test('no knee bends backwards and no foot sinks through the floor in any Vesper clip', () => {
  const hips = rig.index.get('mixamorig:Hips'), hipsRestInverse = rig.restWorldQuaternion[hips].clone().invert(), q = new Quaternion(), forward = new Vector3(), thigh = new Vector3(), shin = new Vector3(), p = new Vector3();
  const at = (world, name, out) => out.setFromMatrixPosition(world[rig.index.get(`mixamorig:${name}`)]);
  for (const spec of provenance.clips) {
    const { frames, count } = readClipFrames(rig, spec.clip);
    let worst = 0, lowest = Infinity;
    for (let k = 0; k < count; k += 1) {
      const world = rig.poseFrame(frames, k);
      forward.set(0, 0, 1).applyQuaternion(q.setFromRotationMatrix(world[hips]).multiply(hipsRestInverse));
      for (const side of ['Left', 'Right']) {
        at(world, `${side}Leg`, thigh).sub(at(world, `${side}UpLeg`, p)); at(world, `${side}Foot`, shin).sub(at(world, `${side}Leg`, p));
        const angle = thigh.angleTo(shin) * 180 / Math.PI;
        if (shin.clone().normalize().dot(forward) > thigh.clone().normalize().dot(forward)) worst = Math.max(worst, angle);
        for (const joint of ['Foot', 'ToeBase']) lowest = Math.min(lowest, at(world, `${side}${joint}`, p).y * RIG_SCALE);
      }
    }
    assert.ok(worst <= 6, `${spec.clip}: a knee bends backwards by ${worst.toFixed(1)}°`);
    if (SKILLS.includes(spec.clip) || ['aren-idle', 'aren-walk', 'aren-run'].includes(spec.clip)) assert.ok(lowest >= -0.03, `${spec.clip}: a foot sinks ${(-lowest).toFixed(3)} m through the floor`);
  }
});

test('aren-air-step is in place: no horizontal Hips travel and at most 0.15 m of vertical Hips change', () => {
  const { frames, count } = readClipFrames(rig, 'aren-air-step');
  const low = new Vector3(Infinity, Infinity, Infinity), high = new Vector3(-Infinity, -Infinity, -Infinity);
  for (let k = 0; k < count; k += 1) { const p = hipsWorld(frames, k); low.min(p); high.max(p); }
  assert.ok(Math.hypot(high.x - low.x, high.z - low.z) * RIG_SCALE < 1e-3, 'horizontal Hips travel');
  assert.ok((high.y - low.y) * RIG_SCALE <= 0.15, `vertical Hips change ${((high.y - low.y) * RIG_SCALE).toFixed(3)} m`);
  assert.equal(entry.rootMotion['aren-air-step'].mode, 'in-place');
});


/** Pose-to-pose pop limit (degrees of blade swing in an in-between frame): gaits and loops must be rigid-smooth, fast cuts and blinks may curve a little between keys. */
test('no in-between frame swings the blade off the path of its two keys (the 60 Hz engine slerps each joint between 30 fps keys)', () => {
  for (const spec of provenance.clips) {
    const { frames, count } = readClipFrames(rig, spec.clip);
    const { max, frame } = midFrameBladeDeviation(rig, frames, count, bladeAxis);
    const limit = LOCOMOTION.includes(spec.clip) && spec.clip !== 'vesper-mist-blink' || LOOPS.includes(spec.clip) ? 5 : 15;
    assert.ok(max <= limit, `${spec.clip}: the in-between pose after frame ${frame} swings the blade ${max.toFixed(1)}° off its keys (> ${limit}°)`);
  }
});

test('the Tripo credit ledger adds up and stays inside the 900-credit authorisation', () => {
  const sum = (record) => Object.values(record).reduce((total, value) => total + (typeof value === 'number' ? value : value.credits), 0);
  const spent = sum(provenance.credits) + sum(provenance.pipelineCredits) + sum(provenance.discarded);
  assert.equal(provenance.creditTotal, spent);
  assert.ok(spent <= 900, `${spent} credits`);
});

/* ------------------------------------------------------------------ coat bind-weight repair (scripts/assets/vesper-skin-weights.mjs) */

const rigFolder = `${root}asset-source/generated/actor-vesper-hero-mixamo-rig-01/tripo-out/`;
const [rigEntry] = readdirSync(rigFolder).filter((name) => !name.startsWith('.'));
const sourceBytes = readFileSync(`${rigFolder}${rigEntry}/model.glb`);
const sourceGlb = parseGlb(sourceBytes);
const repair = entry.skinWeightRepair;
const skinOf = (parsed) => {
  const primitive = parsed.json.meshes[0].primitives[0], read = (id) => readAccessorAny(parsed.json, parsed.bin, id);
  return { primitive, positions: read(primitive.attributes.POSITION), joints: read(primitive.attributes.JOINTS_0), weights: read(primitive.attributes.WEIGHTS_0), indices: read(primitive.indices), inverseBind: read(parsed.json.skins[0].inverseBindMatrices) };
};
const sameBytes = (a, b) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

test('the coat weight repair keeps the source mesh and skeleton and reweights only the coat band, normalised', { timeout: 120_000 }, () => {
  assert.equal(createHash('sha256').update(sourceBytes).digest('hex'), entry.sourceHash, 'the manifest sourceHash names the untouched rig file');
  assert.equal(provenance.sourceHash, entry.sourceHash);
  const before = skinOf(sourceGlb), after = skinOf(glb);
  for (const key of Object.keys(before.primitive.attributes)) {
    if (key === 'JOINTS_0' || key === 'WEIGHTS_0') continue;
    assert.ok(sameBytes(readAccessorAny(sourceGlb.json, sourceGlb.bin, before.primitive.attributes[key]), readAccessorAny(glb.json, glb.bin, after.primitive.attributes[key])), `${key} is bit-identical`);
  }
  assert.ok(sameBytes(before.indices, after.indices), 'topology is bit-identical');
  assert.ok(sameBytes(before.inverseBind, after.inverseBind), 'inverse bind matrices are bit-identical');
  const names = (parsed) => parsed.json.skins[0].joints.map((node) => parsed.json.nodes[node].name);
  assert.deepEqual(names(glb), names(sourceGlb));
  const jointNames = names(sourceGlb).map((name) => name.replace('mixamorig:', '')), UNTOUCHED = /^(Head|HeadTop_End|Neck|LeftHand|RightHand|RightForeArm|LeftForeArm|LeftFoot|RightFoot|LeftToeBase|RightToeBase|LeftLeg|RightLeg)$/;
  const vertices = before.positions.length / 3, topHeight = repair.params.armFade.top;
  let edited = 0;
  for (let v = 0; v < vertices; v += 1) {
    let sum = 0, changed = false, heaviest = 0;
    for (let s = 0; s < 4; s += 1) {
      const w = after.weights[v * 4 + s];
      assert.ok(w >= 0 && w <= 1 + 1e-6, `vertex ${v} weight ${w}`);
      sum += w;
      if (before.weights[v * 4 + s] > before.weights[v * 4 + heaviest]) heaviest = s;
      if (Math.abs(w - before.weights[v * 4 + s]) > 1e-6 || (w > 0 && after.joints[v * 4 + s] !== before.joints[v * 4 + s])) changed = true;
    }
    assert.ok(Math.abs(sum - 1) < 1e-3, `vertex ${v} weights sum to ${sum}`);
    if (!changed) continue;
    edited += 1;
    assert.ok(before.positions[v * 3 + 1] * repair.params.rigScale <= topHeight + 1e-3, `vertex ${v} above the coat band (${(before.positions[v * 3 + 1] * repair.params.rigScale).toFixed(3)} m) was reweighted`);
    assert.ok(!UNTOUCHED.test(jointNames[before.joints[v * 4 + heaviest]]), `vertex ${v} owned by ${jointNames[before.joints[v * 4 + heaviest]]} was reweighted`);
  }
  assert.ok(edited > 0 && edited <= repair.editedVertices, `${edited} vertices reweighted of ${repair.editedVertices} reported`);
});

test('the coat does not follow the swinging arm under the long-stride run pose: its edges stretch far less than with the source weights', { timeout: 300_000 }, () => {
  const before = skinOf(sourceGlb), after = skinOf(glb), vertices = before.positions.length / 3;
  const changed = new Uint8Array(vertices);
  for (let v = 0; v < vertices; v += 1) for (let s = 0; s < 4; s += 1) if (Math.abs(after.weights[v * 4 + s] - before.weights[v * 4 + s]) > 1e-6 || after.joints[v * 4 + s] !== before.joints[v * 4 + s]) { changed[v] = 1; break; }
  const seen = new Set(), edges = [];
  for (let t = 0; t < before.indices.length; t += 3) for (let e = 0; e < 3; e += 1) {
    const a = before.indices[t + e], b = before.indices[t + (e + 1) % 3];
    if (!changed[a] || !changed[b]) continue;
    const low = Math.min(a, b), high = Math.max(a, b), key = low * vertices + high;
    if (seen.has(key)) continue;
    seen.add(key);
    const length = Math.hypot(before.positions[a * 3] - before.positions[b * 3], before.positions[a * 3 + 1] - before.positions[b * 3 + 1], before.positions[a * 3 + 2] - before.positions[b * 3 + 2]);
    if (length >= 0.003) edges.push([low, high, length]);
  }
  assert.ok(edges.length > 2_000, `${edges.length} coat edges`);
  const { frames, count } = readClipFrames(rig, 'aren-run'), foot = (world, side) => new Vector3().setFromMatrixPosition(world[rig.index.get(`mixamorig:${side}Foot`)]);
  let widest = 0, widestFrame = 0;
  for (let k = 0; k < count; k += 1) { const world = rig.poseFrame(frames, k), spread = Math.hypot(foot(world, 'Left').x - foot(world, 'Right').x, foot(world, 'Left').z - foot(world, 'Right').z); if (spread > widest) { widest = spread; widestFrame = k; } }
  assert.ok(widest * RIG_SCALE > 0.6, `the run's widest stride is ${(widest * RIG_SCALE).toFixed(2)} m`);
  const world = rig.poseFrame(frames, widestFrame), matrices = new Float64Array(rig.joints.length * 16), m = new Matrix4(), inverse = new Matrix4();
  for (let j = 0; j < rig.joints.length; j += 1) { inverse.fromArray(before.inverseBind, j * 16); m.multiplyMatrices(world[rig.joints[j]], inverse).toArray(matrices, j * 16); }
  const skin = (skinData, v) => {
    const x = skinData.positions[v * 3], y = skinData.positions[v * 3 + 1], z = skinData.positions[v * 3 + 2], out = [0, 0, 0];
    for (let s = 0; s < 4; s += 1) {
      const w = skinData.weights[v * 4 + s]; if (w <= 0) continue;
      const o = skinData.joints[v * 4 + s] * 16;
      out[0] += w * (matrices[o] * x + matrices[o + 4] * y + matrices[o + 8] * z + matrices[o + 12]);
      out[1] += w * (matrices[o + 1] * x + matrices[o + 5] * y + matrices[o + 9] * z + matrices[o + 13]);
      out[2] += w * (matrices[o + 2] * x + matrices[o + 6] * y + matrices[o + 10] * z + matrices[o + 14]);
    }
    return out;
  };
  const stretches = (skinData) => edges.map(([a, b, length]) => { const p = skin(skinData, a), q = skin(skinData, b); return Math.abs(Math.log(Math.max(1e-9, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])) / length)); }).sort((x, y) => x - y);
  const quantile = (sorted, p) => sorted[Math.floor(p * (sorted.length - 1))];
  const source = stretches(before), repaired = stretches(after);
  assert.ok(quantile(repaired, 0.99) <= 0.8 * quantile(source, 0.99), `coat p99 stretch ${quantile(repaired, 0.99).toFixed(3)} vs source weights ${quantile(source, 0.99).toFixed(3)}`);
  assert.ok(quantile(repaired, 0.999) <= 0.85 * quantile(source, 0.999), `coat p99.9 stretch ${quantile(repaired, 0.999).toFixed(3)} vs source weights ${quantile(source, 0.999).toFixed(3)}`);
});
