import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { parseGlb } from '../../scripts/assets/import-aren-animation-set.mjs';
import { readAccessorAny } from '../../scripts/assets/creature-rig-kit.mjs';
import { JOINT_LIMITS, Rig, jointExcursions, readClipFrames, skinDeformationReport } from '../../scripts/assets/retarget-aren-tripo-clips.mjs';

/**
 * Sakda's four knockdown / get-up clips (aren-knockdown, aren-knockdown-forward, aren-getup, aren-getup-forward; scripts/assets/author-sakda-hero-clips.mjs,
 * brief: hero knockdown / get-up clips from Mixamo mocap) are measured on the ENCODED tracks of the delivered GLB, not on the script's own numbers:
 * the simulation timing (90 / 90 / 66 / 66 ticks at 60 Hz), the exactly held lie (ticks 48–90), the pelvis on the floor by tick 30 and in the lie, the facing of
 * each lie (the chest faces the sky after the back fall, the floor after the stomach fall), the whole mesh resting on the floor and never below it, frame 0 of
 * each get-up equal to its knockdown's last frame, the last quarter of each get-up blending gradually into the idle, the Hips never farther than 0.7 m from their
 * standing XZ, and the skin deformation under the locomotion ceiling.
 */
const root = new URL('../../', import.meta.url).pathname;
const output = `${root}asset-source/generated/actor-sakda-hero-01/`;
const bytes = readFileSync(`${output}sakda-hero-animated.glb`);
const glb = parseGlb(bytes);
const rig = new Rig(glb);
const report = JSON.parse(readFileSync(`${output}anatomy-report.json`, 'utf8'));
const provenance = JSON.parse(readFileSync(`${output}provenance.json`, 'utf8'));
const entry = JSON.parse(readFileSync(`${output}manifest-entry.json`, 'utf8'));
const RIG_SCALE = entry.coordinateTransform.scale;
const DEG = Math.PI / 180;
const KNOCKDOWN = 'aren-knockdown', KNOCKDOWN_FORWARD = 'aren-knockdown-forward', GETUP = 'aren-getup', GETUP_FORWARD = 'aren-getup-forward';
const CLIPS = [KNOCKDOWN, KNOCKDOWN_FORWARD, GETUP, GETUP_FORWARD];
const TICKS = { [KNOCKDOWN]: 90, [KNOCKDOWN_FORWARD]: 90, [GETUP]: 66, [GETUP_FORWARD]: 66 };
const PAIRS = [[KNOCKDOWN, GETUP], [KNOCKDOWN_FORWARD, GETUP_FORWARD]];
const HOLD_FROM = 48;

const cache = new Map();
const clipData = (name) => {
  if (!cache.has(name)) cache.set(name, readClipFrames(rig, name));
  return cache.get(name);
};
const hips = rig.index.get('mixamorig:Hips');
/** `poseFrame` returns one shared buffer: every pose read here is a copy. */
const world = (name, k) => rig.poseFrame(clipData(name).frames, k).map((matrix) => matrix.clone());
const FRONT = new Vector3(entry.coordinateTransform.forward.x, 0, entry.coordinateTransform.forward.z);
/** Distance of a rig-space point along the actor's front (the manifest's forward axis; rig units). */
const along = (point) => point.dot(FRONT);
const at = (matrices, joint) => new Vector3().setFromMatrixPosition(matrices[rig.index.get(`mixamorig:${joint}`)]);
const metresHigh = (matrices, joint) => at(matrices, joint).y * RIG_SCALE;
/** The torso's own frame, independent of any rest convention: forward = (Hips→Neck) × (LeftArm→RightArm); a standing hero faces +X, so forward.y > 0.7 is lying on the back. */
const torso = (matrices) => {
  const base = at(matrices, 'Hips'), up = at(matrices, 'Neck').sub(base).normalize(), right = at(matrices, 'RightArm').sub(at(matrices, 'LeftArm')).normalize();
  const head = at(matrices, 'Head').sub(base);
  return { forward: new Vector3().crossVectors(up, right).normalize(), axis: Math.atan2(-head.z, head.x) / DEG };
};
const angleBetween = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.clone().normalize().dot(b.clone().normalize())))) / DEG;
const rotationOf = (frames, node, k) => new Quaternion().fromArray(frames.rotations[node], k * 4);
/** Largest joint rotation difference (degrees) and Hips translation difference (metres) between two frames of two clips, on the encoded tracks. */
function delta(nameA, ka, nameB, kb) {
  const a = clipData(nameA).frames, b = clipData(nameB).frames;
  let rotation = 0;
  a.rotations.forEach((track, node) => { if (track && b.rotations[node]) rotation = Math.max(rotation, angleBetween(rotationOf(a, node, ka), rotationOf(b, node, kb))); });
  const position = new Vector3().fromArray(a.positions[hips], ka * 3).distanceTo(new Vector3().fromArray(b.positions[hips], kb * 3)) * RIG_SCALE;
  return { rotation, position };
}
const spec = (name) => provenance.clips.find((item) => item.clip === name);
const counts = (name) => clipData(name).count;
const lastOf = (name) => counts(name) - 1;

/** Lowest skinned vertex (metres above the floor, which is the bind pose's lowest vertex) of every `stride`-th vertex of the WHOLE mesh. */
function lowestKit(stride = 5) {
  const primitive = glb.json.meshes[0].primitives[0], read = (id) => readAccessorAny(glb.json, glb.bin, id);
  const positions = read(primitive.attributes.POSITION), joints = read(primitive.attributes.JOINTS_0), weights = read(primitive.attributes.WEIGHTS_0), inverseBind = read(glb.json.skins[0].inverseBindMatrices);
  const skinJoints = glb.json.skins[0].joints, matrices = skinJoints.map(() => new Matrix4()), inverse = new Matrix4();
  const lowestOf = (worldMatrices) => {
    skinJoints.forEach((node, j) => matrices[j].multiplyMatrices(worldMatrices[node], inverse.fromArray(inverseBind, j * 16)));
    let lowest = Infinity;
    for (let v = 0; v < positions.length / 3; v += stride) {
      let y = 0;
      for (let s = 0; s < 4; s += 1) {
        const w = weights[v * 4 + s];
        if (w <= 0) continue;
        const e = matrices[joints[v * 4 + s]].elements;
        y += w * (e[1] * positions[v * 3] + e[5] * positions[v * 3 + 1] + e[9] * positions[v * 3 + 2] + e[13]);
      }
      lowest = Math.min(lowest, y);
    }
    return lowest;
  };
  const floor = lowestOf(rig.restWorld);
  return (name, k) => (lowestOf(world(name, k)) - floor) * RIG_SCALE;
}

test('the four clips are in the GLB at the simulation length, one key per 60 Hz tick, and the manifest maps each action to its own clip', () => {
  const names = glb.json.animations.map((clip) => clip.name);
  for (const name of CLIPS) {
    assert.ok(names.includes(name), `${name} is not in the GLB`);
    const { times, count } = clipData(name);
    assert.equal(count, TICKS[name] + 1, `${name}: ${count} keys`);
    for (let k = 0; k < count; k += 1) assert.ok(Math.abs(times[k] - k / 60) < 1e-6, `${name}: key ${k} is at ${times[k]} s`);
    assert.equal(spec(name).sim.totalTicks, TICKS[name]);
    assert.equal(entry.actionToClipMapping[name], name, `${name} is not mapped to itself`);
    assert.equal(spec(name).limits, 'JOINT_LIMITS', `${name}: the native/locomotion limits, as aren-defeat uses`);
    assert.notEqual(entry.rootMotion[name], undefined);
  }
});

test('the knockdowns hold the lie exactly from tick 48 to the end: every stored key of every joint and of the Hips is identical', () => {
  for (const name of [KNOCKDOWN, KNOCKDOWN_FORWARD]) {
    const { frames, count } = clipData(name);
    assert.equal(count - 1, 90);
    for (const track of [...frames.rotations, ...frames.positions]) {
      if (!track) continue;
      const size = track.length / count;
      for (let k = HOLD_FROM + 1; k < count; k += 1) for (let c = 0; c < size; c += 1) assert.equal(track[k * size + c], track[HOLD_FROM * size + c], `${name}: key ${k} differs from key ${HOLD_FROM}`);
    }
    assert.equal(report.clips[name].lie.heldRange.identical, true);
  }
});

test('the pelvis (Hips joint) is within 0.25 m of the floor at tick 30 and in the lie, and the vertical Hips motion is kept (the hero really goes down, and comes up)', () => {
  for (const name of [KNOCKDOWN, KNOCKDOWN_FORWARD]) {
    assert.ok(metresHigh(world(name, 0), 'Hips') > 0.6, `${name}: starts standing`);
    assert.ok(metresHigh(world(name, 30), 'Hips') <= 0.25, `${name}: pelvis ${metresHigh(world(name, 30), 'Hips')} m at tick 30`);
    for (let k = 30; k < counts(name); k += 1) assert.ok(metresHigh(world(name, k), 'Hips') <= 0.3, `${name}: pelvis bounces to ${metresHigh(world(name, k), 'Hips')} m at tick ${k}`);
    for (let k = HOLD_FROM; k < counts(name); k += 1) assert.ok(metresHigh(world(name, k), 'Hips') <= 0.25, `${name}: pelvis ${metresHigh(world(name, k), 'Hips')} m in the lie`);
    const contact = report.clips[name].lie.groundContactTick;
    assert.ok(contact <= 30, `${name}: ground contact tick ${contact}`);
  }
  for (const name of [GETUP, GETUP_FORWARD]) {
    const rise = Math.max(...Array.from({ length: counts(name) }, (_, k) => metresHigh(world(name, k), 'Hips')));
    assert.ok(rise > 0.7, `${name}: the pelvis only reaches ${rise} m`);
    assert.ok(metresHigh(world(name, 0), 'Hips') <= 0.25, `${name}: starts lying`);
  }
});

test('the back fall ends supine (chest to the sky, back and pelvis on the floor), the stomach fall ends prone (chest, thighs and legs on the floor, legs not raised)', () => {
  const back = world(KNOCKDOWN, 90), stomach = world(KNOCKDOWN_FORWARD, 90);
  assert.ok(torso(back).forward.y > 0.9, `aren-knockdown: torso forward.y ${torso(back).forward.y} (must face the sky)`);
  assert.ok(torso(stomach).forward.y < -0.9, `aren-knockdown-forward: torso forward.y ${torso(stomach).forward.y} (must face the floor)`);
  for (const joint of ['Spine2', 'Spine', 'Hips']) assert.ok(metresHigh(back, joint) <= 0.3, `supine ${joint} ${metresHigh(back, joint)} m`);
  for (const joint of ['Spine2', 'Spine', 'Hips', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot']) assert.ok(metresHigh(stomach, joint) <= 0.3, `prone ${joint} ${metresHigh(stomach, joint)} m (legs must be on the floor)`);
  // The head lies beyond the pelvis: back fall = behind the standing direction, stomach fall = the head toward the hero's front.
  assert.ok(along(at(back, 'Head')) < along(at(back, 'Hips')) - 0.1, 'supine head must point back');
  assert.ok(along(at(stomach, 'Head')) > along(at(stomach, 'Hips')) + 0.1, 'prone head must point forward');
  // Every frame of the lie keeps the facing sign.
  for (let k = HOLD_FROM; k < 91; k += 1) {
    assert.ok(torso(world(KNOCKDOWN, k)).forward.y > 0.7);
    assert.ok(torso(world(KNOCKDOWN_FORWARD, k)).forward.y < -0.7);
  }
  // The hold is the only lie: the first lying frame of each get-up has the same facing.
  assert.ok(torso(world(GETUP, 0)).forward.y > 0.9);
  assert.ok(torso(world(GETUP_FORWARD, 0)).forward.y < -0.9);
});

test('the whole mesh never sinks below the floor by more than 1 cm, and rests on it (within 2 cm) in every lying frame', { timeout: 300_000 }, () => {
  const lowest = lowestKit();
  for (const name of CLIPS) {
    let flat = 0;
    for (let k = 0; k < counts(name); k += 1) {
      const m = world(name, k), low = lowest(name, k);
      assert.ok(low >= -0.01, `${name} tick ${k}: the mesh is ${(-low * 100).toFixed(2)} cm below the floor`);
      if (Math.abs(torso(m).forward.y) > 0.7 && metresHigh(m, 'Hips') - Math.max(0, low) < 0.3) {
        flat += 1;
        assert.ok(low <= 0.02, `${name} tick ${k}: lying ${(low * 100).toFixed(2)} cm above the floor`);
        assert.ok(low >= -0.01);
      }
    }
    assert.ok(flat >= (name.includes('knockdown') ? 40 : 6), `${name}: only ${flat} lying frames`);
  }
});

test('each get-up starts exactly where its knockdown ended: every joint within 0.5° and the Hips within 1 mm (encoded tracks), lying to lying, with no facing flip', () => {
  for (const [down, up] of PAIRS) {
    const seam = delta(up, 0, down, lastOf(down));
    assert.ok(seam.rotation <= 0.5, `${up}: frame 0 differs from ${down}'s last frame by ${seam.rotation.toFixed(4)}°`);
    assert.ok(seam.position <= 0.001, `${up}: Hips ${(seam.position * 1000).toFixed(3)} mm`);
    // The first ticks stay lying (pelvis on the floor, torso flat) and keep the knockdown's facing and lie direction: no pop, no flip.
    const lieAxis = torso(world(down, lastOf(down))).axis, sign = Math.sign(torso(world(down, lastOf(down))).forward.y);
    const blend = spec(up).getup.blend;
    assert.ok(blend <= 12, `${up}: lying-to-lying blend of ${blend} ticks`);
    for (let k = 0; k <= blend; k += 1) {
      const m = world(up, k), t = torso(m);
      assert.equal(Math.sign(t.forward.y), sign, `${up} tick ${k}: facing flipped`);
      assert.ok(Math.abs(t.forward.y) > 0.7, `${up} tick ${k}: not lying (forward.y ${t.forward.y})`);
      assert.ok(metresHigh(m, 'Hips') <= 0.3, `${up} tick ${k}: pelvis ${metresHigh(m, 'Hips')} m`);
      const turn = Math.abs(((t.axis - lieAxis + 540) % 360) - 180);
      assert.ok(turn <= 25, `${up} tick ${k}: the lie turned ${turn.toFixed(1)}° from the knockdown's`);
    }
    // No pop at the seam: the first steps are ordinary.
    for (let k = 1; k <= 3; k += 1) assert.ok(delta(up, k - 1, up, k).rotation <= 25, `${up}: step into tick ${k}`);
  }
});

test('every joint and the Hips keep continuous encoded tracks across each get-up (no frame is a repeat or a jump), and the whole clip steps at most as fast as the donor take', () => {
  for (const name of CLIPS) {
    const { frames, count } = clipData(name);
    frames.rotations.forEach((track, node) => {
      if (!track) return;
      for (let k = 1; k < count; k += 1) {
        const a = rotationOf(frames, node, k - 1), b = rotationOf(frames, node, k);
        assert.ok(a.dot(b) >= 0, `${name} ${rig.names[node]} key ${k}: opposite quaternion hemisphere`);
        assert.ok(angleBetween(a, b) <= 90, `${name} ${rig.names[node]} key ${k}: ${angleBetween(a, b).toFixed(1)}° in one tick`);
      }
    });
    const track = frames.positions[hips];
    for (let k = 1; k < count; k += 1) {
      const step = new Vector3().fromArray(track, k * 3).distanceTo(new Vector3().fromArray(track, (k - 1) * 3)) * RIG_SCALE;
      assert.ok(step <= 0.15, `${name}: the Hips jump ${(step * 100).toFixed(1)} cm in tick ${k}`);
    }
  }
});

test('the last quarter of each get-up is a gradual slerp into aren-idle frame 0: the end mismatch is under 2°, the Hips under 1 mm, and no joint steps abruptly in it', () => {
  for (const name of [GETUP, GETUP_FORWARD]) {
    const end = delta(name, lastOf(name), 'aren-idle', 0);
    assert.ok(end.rotation < 2, `${name}: ends ${end.rotation.toFixed(4)}° from aren-idle`);
    assert.ok(end.position <= 0.001, `${name}: Hips ${(end.position * 1000).toFixed(3)} mm from aren-idle`);
    const first = Math.round(lastOf(name) * 0.75), { frames, count } = clipData(name);
    let worst = 0, worstFinal = 0;
    frames.rotations.forEach((track, node) => {
      if (!track) return;
      for (let k = first; k < count; k += 1) {
        const step = angleBetween(rotationOf(frames, node, k - 1), rotationOf(frames, node, k));
        worst = Math.max(worst, step);
        if (k >= count - 3) worstFinal = Math.max(worstFinal, step);
      }
    });
    if (process.env.SAKDA_TEST_PRINT) console.log(name, 'last quarter max joint step', worst.toFixed(2), '°/tick; last three ticks', worstFinal.toFixed(2));
    assert.ok(worst <= 40, `${name}: a joint steps ${worst.toFixed(1)}°/tick in the last quarter`);
    assert.ok(worstFinal <= 8, `${name}: a joint steps ${worstFinal.toFixed(1)}°/tick over the last three ticks (the idle must be reached gradually)`);
    // It is a blend, not a stamp: the distance to the idle frame shrinks monotonically-ish over the last quarter and is large at its start.
    const distance = (k) => delta(name, k, 'aren-idle', 0).rotation;
    assert.ok(distance(first) > 10, `${name}: already at the idle ${distance(first).toFixed(1)}° at the start of the last quarter`);
    for (let k = first + 6; k < count; k += 1) assert.ok(distance(k) <= distance(k - 6) + 1e-6, `${name}: moves away from the idle at tick ${k}`);
  }
});

test('the Hips stay within 0.7 m of their standing XZ in every frame, and each get-up returns them onto it', () => {
  const stand = at(world('aren-idle', 0), 'Hips');
  for (const name of CLIPS) {
    let worst = 0;
    for (let k = 0; k < counts(name); k += 1) {
      const p = at(world(name, k), 'Hips');
      worst = Math.max(worst, Math.hypot(p.x - stand.x, p.z - stand.z) * RIG_SCALE);
    }
    assert.ok(worst <= 0.7, `${name}: the Hips are ${worst.toFixed(3)} m from their standing XZ`);
  }
  for (const name of [GETUP, GETUP_FORWARD]) {
    const p = at(world(name, lastOf(name)), 'Hips');
    assert.ok(Math.hypot(p.x - stand.x, p.z - stand.z) * RIG_SCALE <= 0.001, `${name} does not end on the standing XZ`);
  }
  // The back fall moves the Hips back, the stomach fall forward (the actor's +X is its front).
  assert.ok(along(at(world(KNOCKDOWN, 90), 'Hips')) < along(stand) - 0.2);
  assert.ok(along(at(world(KNOCKDOWN_FORWARD, 90), 'Hips')) > along(stand) + 0.2);
});

test('every joint of the four clips is inside the native/locomotion limits the aren-defeat clip uses (JOINT_LIMITS)', () => {
  for (const name of CLIPS) {
    const { frames, count } = clipData(name);
    for (const [joint, peak] of Object.entries(jointExcursions(rig, frames, count, JOINT_LIMITS))) {
      assert.ok(peak.swing <= JOINT_LIMITS[joint].swing + 1e-3, `${name} ${joint} swing ${peak.swing.toFixed(2)}° > ${JOINT_LIMITS[joint].swing}°`);
      assert.ok(peak.twist <= JOINT_LIMITS[joint].twist + 1e-3, `${name} ${joint} twist ${peak.twist.toFixed(2)}° > ${JOINT_LIMITS[joint].twist}°`);
    }
  }
});

test('the four clips play captured Mixamo reaction takes (recorded bytes), Sakda is unarmed, and the deformation ceiling is still the pre-existing locomotion/dive one', { timeout: 300_000 }, () => {
  const ledger = JSON.stringify(JSON.parse(readFileSync(`${root}asset-source/mixamo/provenance.json`, 'utf8')));
  const expected = { [KNOCKDOWN]: ['falling-back'], [KNOCKDOWN_FORWARD]: ['fall-flat-hit-back'], [GETUP]: ['kip-up'], [GETUP_FORWARD]: ['getting-up-stomach'] };
  for (const name of CLIPS) {
    assert.equal(spec(name).pose, undefined, `${name}: hand-keyed pose keys`);
    const takes = new Set(spec(name).parts.map((part) => part.source.donor.slice(2)));
    assert.deepEqual([...takes], expected[name], `${name}: takes`);
    for (const take of takes) {
      const source = provenance.mixamo[take];
      assert.ok(source?.file.startsWith('asset-source/mixamo/reactions/'), `${take} is not a recorded reaction take`);
      assert.equal(createHash('sha256').update(readFileSync(root + source.file)).digest('hex'), source.sha256, `${source.file} changed since the build`);
      assert.ok(ledger.includes(source.sha256), `${source.file} is not in asset-source/mixamo/provenance.json`);
    }
  }
  const LOCOMOTION = ['aren-idle', 'aren-walk', 'aren-run', 'aren-jump', 'sakda-guard-dash'];
  assert.deepEqual(report.deformationCeiling.clips, LOCOMOTION);
  const ceiling = Math.max(report.deformationCeiling.reference.p999, ...LOCOMOTION.map((name) => report.clips[name].deformation.p999));
  assert.equal(report.deformationCeiling.p999, ceiling);
  for (const name of CLIPS) assert.ok(report.clips[name].deformation.p999 <= ceiling, `${name}: p99.9 ${report.clips[name].deformation.p999} > ceiling ${ceiling}`);
  const worst = CLIPS.reduce((best, name) => (report.clips[name].deformation.p999 > report.clips[best].deformation.p999 ? name : best));
  const measured = skinDeformationReport(bytes, worst);
  assert.ok(Math.abs(measured.p999 - report.clips[worst].deformation.p999) < 1e-4, `${worst}: re-measured ${measured.p999} vs ${report.clips[worst].deformation.p999}`);
  assert.ok(measured.p999 <= ceiling + 1e-4, `${worst}: ${measured.p999} > ceiling ${ceiling}`);
  assert.equal(entry.sockets.length, 0, 'Sakda is barehanded: no weapon socket');
});
