import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { parseGlb } from '../../scripts/assets/import-aren-animation-set.mjs';
import { readAccessorAny } from '../../scripts/assets/creature-rig-kit.mjs';
import { JOINT_LIMITS, Rig, jointExcursions, readClipFrames, skinDeformationReport } from '../../scripts/assets/retarget-aren-tripo-clips.mjs';

/**
 * Yara's four knockdown / get-up clips (aren-knockdown, aren-knockdown-forward, aren-getup, aren-getup-forward; scripts/assets/author-yara-hero-clips.mjs,
 * brief: hero knockdown / get-up clips from Mixamo mocap) measured on the ENCODED tracks of the delivered GLB, not on the script's own numbers:
 *  - the simulation timing (90 / 90 / 66 / 66 ticks at 60 Hz, one key per tick), the exactly held lie (ticks 48–90);
 *  - both knockdowns START STANDING (pelvis within 10 % of the idle's, spine near vertical, soles on the floor) and fall: pelvis ≤ 0.25 m at tick 30;
 *  - the facing of each held lie (chest to the sky after the back fall, to the floor after the stomach fall, head pointing back / forward);
 *  - the whole mesh never below the floor by more than 1 cm and resting on it while lying;
 *  - seam continuity on the encoded tracks of every joint and of the Hips translation: each get-up's frame 0 is its knockdown's last frame (lying to lying, no
 *    facing flip), its last quarter slerps gradually into aren-idle's first frame;
 *  - each get-up is a real rise (anti-plank): the Hips never stall for more than 15 ticks before standing and never jump more than 6 cm in one tick;
 *  - the Hips stay within 0.7 m of their standing XZ and every get-up returns onto it; every joint inside the locomotion limits; the skin deformation under the
 *    ceiling of the pre-existing locomotion clips.
 */
const root = new URL('../../', import.meta.url).pathname;
const output = `${root}asset-source/generated/actor-yara-hero-01/`;
const bytes = readFileSync(`${output}yara-hero-animated.glb`);
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
const IDLE = 'aren-idle';
const LOCOMOTION = ['aren-idle', 'aren-walk', 'aren-run', 'aren-jump', 'aren-forward-left-dive-roll'];

const cache = new Map();
const clipData = (name) => {
  if (!cache.has(name)) cache.set(name, readClipFrames(rig, name));
  return cache.get(name);
};
const hips = rig.index.get('mixamorig:Hips');
/** `poseFrame` returns one shared buffer: every pose read here is a copy. */
const world = (name, k) => rig.poseFrame(clipData(name).frames, k).map((matrix) => matrix.clone());
const FRONT = new Vector3(entry.coordinateTransform.forward.x, 0, entry.coordinateTransform.forward.z);
const at = (matrices, joint) => new Vector3().setFromMatrixPosition(matrices[rig.index.get(`mixamorig:${joint}`)]);
const metresHigh = (matrices, joint) => at(matrices, joint).y * RIG_SCALE;
/** The torso's own frame, independent of any rest convention: forward = (Hips→Neck) × (LeftArm→RightArm); a standing hero faces +X, so forward.y > 0.7 is lying on the back. */
const torso = (matrices) => {
  const base = at(matrices, 'Hips'), up = at(matrices, 'Neck').sub(base).normalize(), right = at(matrices, 'RightArm').sub(at(matrices, 'LeftArm')).normalize();
  const head = at(matrices, 'Head').sub(base);
  return { up, forward: new Vector3().crossVectors(up, right).normalize(), axis: Math.atan2(-head.z, head.x) / DEG, shoulders: Math.atan2(-right.z, right.x) / DEG, lean: up.angleTo(new Vector3(0, 1, 0)) / DEG };
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
const hipsMetres = (name) => Array.from({ length: counts(name) }, (_, k) => metresHigh(world(name, k), 'Hips'));

/**
 * Lowest skinned vertex (metres above the floor, which is the bind pose's lowest vertex) of every `stride`-th vertex of the WHOLE mesh (`feet`: only those
 * whose dominant skin weight is a Foot or ToeBase bone).
 */
function lowestKit({ stride = 5, feet = false } = {}) {
  const primitive = glb.json.meshes[0].primitives[0], read = (id) => readAccessorAny(glb.json, glb.bin, id);
  const positions = read(primitive.attributes.POSITION), joints = read(primitive.attributes.JOINTS_0), weights = read(primitive.attributes.WEIGHTS_0), inverseBind = read(glb.json.skins[0].inverseBindMatrices);
  const skinJoints = glb.json.skins[0].joints, matrices = skinJoints.map(() => new Matrix4()), inverse = new Matrix4(), picked = [];
  for (let v = 0; v < positions.length / 3; v += stride) {
    let best = 0;
    for (let s = 1; s < 4; s += 1) if (weights[v * 4 + s] > weights[v * 4 + best]) best = s;
    if (!feet || /Foot|ToeBase/.test(rig.names[skinJoints[joints[v * 4 + best]]])) picked.push(v);
  }
  const lowestOf = (worldMatrices) => {
    skinJoints.forEach((node, j) => matrices[j].multiplyMatrices(worldMatrices[node], inverse.fromArray(inverseBind, j * 16)));
    let lowest = Infinity;
    for (const v of picked) {
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

test('both knockdowns START STANDING: pelvis ≥ 90 % of the idle\'s, spine within 25° of vertical, soles within 3 cm of the floor; they are not already lying or airborne', { timeout: 120_000 }, () => {
  const idle = world(IDLE, 0), idleHips = metresHigh(idle, 'Hips');
  const feet = lowestKit({ stride: 2, feet: true });
  for (const name of [KNOCKDOWN, KNOCKDOWN_FORWARD]) {
    const first = world(name, 0), t = torso(first);
    assert.ok(metresHigh(first, 'Hips') >= 0.9 * idleHips, `${name}: pelvis ${metresHigh(first, 'Hips').toFixed(3)} m < 90 % of the idle's ${idleHips.toFixed(3)} m`);
    assert.ok(t.lean <= 25, `${name}: the spine leans ${t.lean.toFixed(1)}° from vertical at tick 0`);
    assert.ok(Math.abs(t.forward.y) < 0.5, `${name}: the chest already faces the ${t.forward.y > 0 ? 'sky' : 'floor'} at tick 0 (${t.forward.y.toFixed(2)})`);
    const sole = feet(name, 0);
    assert.ok(sole >= -0.01 && sole <= 0.03, `${name}: the lowest sole vertex is ${(sole * 100).toFixed(2)} cm above the floor at tick 0`);
    // the first ticks stay on their feet: no frame before the pelvis drops below 90 % of the idle's is airborne
    for (let k = 0; k < 3; k += 1) assert.ok(feet(name, k) <= 0.03 && metresHigh(world(name, k), 'Hips') >= 0.9 * idleHips, `${name}: tick ${k} is not standing`);
    // and it is the idle's own first frame, every joint
    const seam = delta(name, 0, IDLE, 0);
    assert.ok(seam.rotation <= 0.5 && seam.position <= 0.03, `${name}: tick 0 differs from the idle's first frame by ${seam.rotation.toFixed(3)}° / ${(seam.position * 1000).toFixed(2)} mm (the Hips are lifted at most 3 cm onto the floor guard)`);
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

test('the pelvis (Hips joint, real metres) is within 0.25 m of the floor at tick 30 and goes down and (get-ups) up again', () => {
  for (const name of [KNOCKDOWN, KNOCKDOWN_FORWARD]) {
    const h = hipsMetres(name);
    assert.ok(h[30] <= 0.25, `${name}: pelvis ${h[30].toFixed(3)} m at tick 30`);
    for (let k = 30; k < h.length; k += 1) assert.ok(h[k] <= 0.3, `${name}: pelvis bounces to ${h[k].toFixed(3)} m at tick ${k}`);
    assert.ok(h[0] > 0.7, `${name}: starts standing`);
    // it really falls: the pelvis is above 0.6 m for more than a few ticks and descends monotonically enough (never rises above its tick-0 height)
    assert.ok(Math.max(...h) <= h[0] + 0.03, `${name}: the pelvis rises to ${Math.max(...h).toFixed(3)} m`);
    assert.ok(report.clips[name].lie.groundContactTick <= 30 || report.clips[name].lie.pelvisMetresAtTick30 <= 0.25, `${name}: ground contact tick ${report.clips[name].lie.groundContactTick}`);
  }
  for (const name of [GETUP, GETUP_FORWARD]) {
    const h = hipsMetres(name);
    assert.ok(Math.max(...h) > 0.7, `${name}: the pelvis only reaches ${Math.max(...h)} m`);
    assert.ok(h[0] <= 0.3, `${name}: starts lying`);
  }
});

test('the back fall ends supine (chest to the sky, head back, pelvis/back on the floor), the stomach fall prone (chest to the floor, head forward, chest + thighs on the floor)', () => {
  const back = world(KNOCKDOWN, 90), stomach = world(KNOCKDOWN_FORWARD, 90);
  assert.ok(torso(back).forward.y > 0.9, `aren-knockdown: torso forward.y ${torso(back).forward.y} (must face the sky)`);
  assert.ok(torso(stomach).forward.y < -0.9, `aren-knockdown-forward: torso forward.y ${torso(stomach).forward.y} (must face the floor)`);
  for (const joint of ['Spine2', 'Spine', 'Hips']) assert.ok(metresHigh(back, joint) <= 0.3, `supine ${joint} ${metresHigh(back, joint)} m`);
  for (const joint of ['Spine2', 'Spine', 'Hips', 'LeftUpLeg', 'RightUpLeg']) assert.ok(metresHigh(stomach, joint) <= 0.32, `prone ${joint} ${metresHigh(stomach, joint)} m (chest and thighs must be on the floor)`);
  // The head lies beyond the pelvis: back fall = behind the standing direction, stomach fall = the head toward the hero's front.
  const headBack = at(back, 'Head').sub(at(back, 'Hips')).dot(FRONT), headStomach = at(stomach, 'Head').sub(at(stomach, 'Hips')).dot(FRONT);
  assert.ok(headBack * RIG_SCALE < -0.3, `supine head must point back (${(headBack * RIG_SCALE).toFixed(2)} m along the front)`);
  assert.ok(headStomach * RIG_SCALE > 0.3, `prone head must point forward (${(headStomach * RIG_SCALE).toFixed(2)} m along the front)`);
  // Every frame of the held lie keeps the facing sign.
  for (let k = HOLD_FROM; k < 91; k += 1) {
    assert.ok(torso(world(KNOCKDOWN, k)).forward.y > 0.9, `${KNOCKDOWN} tick ${k}`);
    assert.ok(torso(world(KNOCKDOWN_FORWARD, k)).forward.y < -0.9, `${KNOCKDOWN_FORWARD} tick ${k}`);
  }
  // Each fall goes the right way over its whole length: the back fall never shows the chest to the floor, the stomach fall never to the sky (no flip through the fall).
  for (let k = 0; k < 91; k += 1) {
    assert.ok(torso(world(KNOCKDOWN, k)).forward.y > -0.6, `${KNOCKDOWN} tick ${k}: face-down while falling backward`);
    assert.ok(torso(world(KNOCKDOWN_FORWARD, k)).forward.y < 0.6, `${KNOCKDOWN_FORWARD} tick ${k}: face-up while falling forward`);
  }
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
      }
    }
    assert.ok(flat >= (name.includes('knockdown') ? 40 : 3), `${name}: only ${flat} lying frames`);
  }
});

test('seam continuity on the encoded tracks: each get-up\'s frame 0 is its knockdown\'s last frame (every joint within 0.5°, Hips within 1 mm), lying to lying with no facing flip', () => {
  for (const [down, up] of PAIRS) {
    const seam = delta(up, 0, down, lastOf(down));
    assert.ok(seam.rotation <= 0.5, `${up}: frame 0 differs from ${down}'s last frame by ${seam.rotation.toFixed(4)}°`);
    assert.ok(seam.position <= 0.001, `${up}: Hips ${(seam.position * 1000).toFixed(3)} mm`);
    // every rotation track and the Hips translation track individually, raw components (the stored tracks are what the mixer plays)
    const a = clipData(down).frames, b = clipData(up).frames;
    for (const [tracksA, tracksB, size] of [[a.rotations, b.rotations, 4], [a.positions, b.positions, 3]]) {
      tracksA.forEach((track, node) => {
        if (!track || !tracksB[node]) return;
        if (size === 4) assert.ok(angleBetween(rotationOf(a, node, lastOf(down)), rotationOf(b, node, 0)) <= 0.5, `${up} ${rig.names[node]}: seam`);
        else for (let c = 0; c < 3; c += 1) assert.ok(Math.abs(track[lastOf(down) * 3 + c] - tracksB[node][c]) * RIG_SCALE <= 0.001, `${up} ${rig.names[node]}: Hips translation component ${c}`);
      });
    }
    // The first ticks stay lying (pelvis low) and keep the knockdown's facing and lie direction (the shoulder line in the floor plane): no pop, no flip.
    const lieShoulders = torso(world(down, lastOf(down))).shoulders, sign = Math.sign(torso(world(down, lastOf(down))).forward.y);
    const blend = spec(up).getup.blend;
    assert.ok(blend <= 12, `${up}: lying-to-lying blend of ${blend} ticks`);
    for (let k = 0; k <= blend; k += 1) {
      const m = world(up, k), t = torso(m);
      assert.equal(Math.sign(t.forward.y), sign, `${up} tick ${k}: facing flipped`);
      assert.ok(metresHigh(m, 'Hips') <= 0.4, `${up} tick ${k}: pelvis ${metresHigh(m, 'Hips')} m`);
      const turn = Math.abs(((t.shoulders - lieShoulders + 540) % 360) - 180);
      assert.ok(turn <= 30, `${up} tick ${k}: the shoulders turned ${turn.toFixed(1)}° from the knockdown's`);
    }
  }
});

test('every joint and the Hips keep continuous encoded tracks in all four clips (one quaternion hemisphere, no jump), and the end of each get-up is aren-idle\'s first frame', () => {
  for (const name of CLIPS) {
    const { frames, count } = clipData(name);
    frames.rotations.forEach((track, node) => {
      if (!track) return;
      for (let k = 1; k < count; k += 1) {
        const a = rotationOf(frames, node, k - 1), b = rotationOf(frames, node, k);
        assert.ok(a.dot(b) >= 0, `${name} ${rig.names[node]} key ${k}: opposite quaternion hemisphere`);
        assert.ok(angleBetween(a, b) <= 75, `${name} ${rig.names[node]} key ${k}: ${angleBetween(a, b).toFixed(1)}° in one tick`);
      }
    });
  }
  for (const name of [GETUP, GETUP_FORWARD]) {
    const end = delta(name, lastOf(name), IDLE, 0);
    assert.ok(end.rotation < 2, `${name}: ends ${end.rotation.toFixed(4)}° from aren-idle`);
    assert.ok(end.position <= 0.03, `${name}: Hips ${(end.position * 1000).toFixed(3)} mm from aren-idle (lifted at most 3 cm onto the floor guard)`);
  }
});

test('anti-plank: each get-up rises (no stretch of more than 15 ticks without a 2 cm Hips rise before standing) and the Hips never jump 6 cm in one tick', () => {
  const idleHips = metresHigh(world(IDLE, 0), 'Hips');
  for (const name of [GETUP, GETUP_FORWARD]) {
    const h = hipsMetres(name), standing = h.findIndex((value) => value >= 0.9 * idleHips);
    assert.ok(standing > 0 && standing < lastOf(name), `${name}: the pelvis reaches standing height at tick ${standing}`);
    for (let k = 0; k + 16 <= standing; k += 1) {
      const rise = Math.max(...h.slice(k + 1, k + 17)) - h[k];
      assert.ok(rise >= 0.02, `${name}: the pelvis rises only ${(rise * 100).toFixed(2)} cm over ticks ${k}–${k + 16} (a plank-like stall)`);
    }
    for (let k = 1; k < counts(name); k += 1) {
      const step = at(world(name, k), 'Hips').distanceTo(at(world(name, k - 1), 'Hips')) * RIG_SCALE;
      assert.ok(step < 0.06, `${name}: the Hips move ${(step * 100).toFixed(2)} cm in tick ${k}`);
    }
  }
  // A fall is free fall: the pelvis may drop faster than a rise moves it, but never more than 10 cm in one tick.
  for (const name of [KNOCKDOWN, KNOCKDOWN_FORWARD]) {
    for (let k = 1; k < counts(name); k += 1) {
      const step = at(world(name, k), 'Hips').distanceTo(at(world(name, k - 1), 'Hips')) * RIG_SCALE;
      assert.ok(step < 0.1, `${name}: the Hips move ${(step * 100).toFixed(2)} cm in tick ${k}`);
    }
  }
});

test('the last quarter of each get-up is a gradual slerp into aren-idle frame 0: it starts far from the idle, closes monotonically, and no joint steps abruptly in it', () => {
  for (const name of [GETUP, GETUP_FORWARD]) {
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
    assert.ok(worst <= 40, `${name}: a joint steps ${worst.toFixed(1)}°/tick in the last quarter`);
    assert.ok(worstFinal <= 8, `${name}: a joint steps ${worstFinal.toFixed(1)}°/tick over the last three ticks (the idle must be reached gradually)`);
    const distance = (k) => delta(name, k, IDLE, 0).rotation;
    assert.ok(distance(first) > 10, `${name}: already at the idle ${distance(first).toFixed(1)}° at the start of the last quarter`);
    for (let k = first + 6; k < count; k += 1) assert.ok(distance(k) <= distance(k - 6) + 1e-6, `${name}: moves away from the idle at tick ${k}`);
  }
});

test('the Hips stay within 0.7 m of their standing XZ in every frame, and each get-up returns them onto it', () => {
  const stand = at(world(IDLE, 0), 'Hips');
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
  assert.ok(at(world(KNOCKDOWN, 90), 'Hips').dot(FRONT) < stand.dot(FRONT) - 0.2 / RIG_SCALE);
  assert.ok(at(world(KNOCKDOWN_FORWARD, 90), 'Hips').dot(FRONT) > stand.dot(FRONT) + 0.2 / RIG_SCALE);
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

test('the four clips play captured Mixamo reaction takes (recorded bytes), and the deformation ceiling is the pre-existing locomotion one (the new clips are not part of it)', { timeout: 300_000 }, () => {
  const ledger = JSON.stringify(JSON.parse(readFileSync(`${root}asset-source/mixamo/provenance.json`, 'utf8')));
  for (const name of CLIPS) {
    assert.equal(spec(name).pose, undefined, `${name}: hand-keyed pose keys`);
    const takes = new Set(spec(name).parts.map((part) => part.source.donor.slice(2)));
    assert.ok(takes.size >= 1);
    for (const take of takes) {
      const source = provenance.mixamo[take];
      assert.ok(source?.file.startsWith('asset-source/mixamo/reactions/'), `${take} is not a recorded reaction take`);
      assert.equal(createHash('sha256').update(readFileSync(root + source.file)).digest('hex'), source.sha256, `${source.file} changed since the build`);
      assert.ok(ledger.includes(source.sha256), `${source.file} is not in asset-source/mixamo/provenance.json`);
    }
  }
  // The rises are the push-up / roll takes (no stand-in hand-keyed pose), the falls the stand-and-fall takes.
  assert.deepEqual(spec(GETUP_FORWARD).parts.map((part) => part.source.donor), ['m:getting-up-stomach', 'm:getting-up-stomach']);
  assert.deepEqual(report.deformationCeiling.clips, LOCOMOTION);
  const ceiling = Math.max(...LOCOMOTION.map((name) => report.clips[name].deformation.p999));
  assert.equal(report.deformationCeiling.p999, ceiling);
  for (const name of CLIPS) assert.ok(report.clips[name].deformation.p999 <= ceiling, `${name}: p99.9 ${report.clips[name].deformation.p999} > ceiling ${ceiling}`);
  const worst = CLIPS.reduce((best, name) => (report.clips[name].deformation.p999 > report.clips[best].deformation.p999 ? name : best));
  const measured = skinDeformationReport(bytes, worst);
  assert.ok(Math.abs(measured.p999 - report.clips[worst].deformation.p999) < 1e-4, `${worst}: re-measured ${measured.p999} vs ${report.clips[worst].deformation.p999}`);
  assert.ok(measured.p999 <= ceiling + 1e-4, `${worst}: ${measured.p999} > ceiling ${ceiling}`);
});

test('the fitted staff (fist + shaft axis from the report\'s grip) stays off the floor and out of the legs and torso in every frame, at least as clear of them as aren-defeat\'s', () => {
  const s = new Vector3(...report.grip.staffAxisHand), palm = new Vector3(...report.grip.palmHand), hand = rig.index.get('mixamorig:RightHand');
  const LENGTH = 1.85 / RIG_SCALE, GRIP = 0.42, SKIP = 0.2 / RIG_SCALE;
  const limbs = [['Hips', 'Spine'], ['Spine', 'Spine1'], ['Spine1', 'Spine2'], ['Spine2', 'Neck'], ['Neck', 'Head'], ['LeftUpLeg', 'LeftLeg'], ['RightUpLeg', 'RightLeg'], ['LeftLeg', 'LeftFoot'], ['RightLeg', 'RightFoot']]
    .map(([from, to]) => [rig.index.get(`mixamorig:${from}`), rig.index.get(`mixamorig:${to}`)]);
  const measure = (name) => {
    let lowest = Infinity, closest = Infinity;
    const { frames, count } = clipData(name);
    for (let k = 0; k < count; k += 1) {
      const matrices = rig.poseFrame(frames, k), fist = palm.clone().applyMatrix4(matrices[hand]), d = s.clone().transformDirection(matrices[hand]).normalize();
      lowest = Math.min(lowest, Math.min(fist.y - GRIP * LENGTH * d.y, fist.y + (1 - GRIP) * LENGTH * d.y) * RIG_SCALE);
      const ends = limbs.map(([from, to]) => [new Vector3().setFromMatrixPosition(matrices[from]), new Vector3().setFromMatrixPosition(matrices[to])]);
      for (let t = -GRIP * LENGTH; t <= (1 - GRIP) * LENGTH; t += 0.03) {
        if (Math.abs(t) < SKIP) continue;
        const p = fist.clone().addScaledVector(d, t);
        for (const [a, b] of ends) {
          const ab = b.clone().sub(a), u = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / ab.lengthSq()));
          closest = Math.min(closest, p.distanceTo(a.clone().addScaledVector(ab, u)) * RIG_SCALE);
        }
      }
    }
    return { lowest, closest };
  };
  const defeat = measure('aren-defeat');
  for (const name of CLIPS) {
    const staff = measure(name);
    assert.ok(staff.lowest >= 0, `${name}: the staff axis dips to ${staff.lowest.toFixed(3)} m (the floor)`);
    assert.ok(staff.closest >= Math.min(0.055, defeat.closest) - 0.005, `${name}: the staff comes ${(staff.closest * 100).toFixed(1)} cm from a limb axis (aren-defeat: ${(defeat.closest * 100).toFixed(1)} cm)`);
    assert.ok(report.clips[name].lie.staff.lowestAfterMetres >= 0, `${name}: report`);
  }
});
