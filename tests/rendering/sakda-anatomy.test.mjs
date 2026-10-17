import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Matrix4, PropertyBinding, Quaternion, Vector3 } from 'three';
import { parseGlb } from '../../scripts/assets/import-aren-animation-set.mjs';
import { readAccessorAny } from '../../scripts/assets/creature-rig-kit.mjs';
import { COMBAT_LIMITS, JOINT_LIMITS, Rig, jointExcursions, readClipFrames, skinDeformationReport } from '../../scripts/assets/retarget-aren-tripo-clips.mjs';

/**
 * Sakda's delivered clip set (scripts/assets/author-sakda-hero-clips.mjs) is captured motion only: Tripo presets retargeted onto his rig and Mixamo FBX,
 * with timing and placement edits. Every clip is anatomically limited (the documented KICK_LIMITS guard), none deforms the mesh more than the hero's
 * locomotion ceiling, every skill clip has the simulation's length, the charge and locomotion loops are seamless, and the manifest maps every shared
 * action. The strikes land with the right surface on their tick (fist, elbow, knee, shin or heel farthest forward; the stomping heel on the floor), the
 * elbows and knees only ever bend the way a hinge bends, the feet never sink into the floor, and no fist or elbow passes through the head or the chest.
 */
const root = new URL('../../', import.meta.url).pathname;
const output = `${root}asset-source/generated/actor-sakda-hero-01/`;
const bytes = readFileSync(`${output}sakda-hero-animated.glb`);
const rig = new Rig(parseGlb(bytes));
const report = JSON.parse(readFileSync(`${output}anatomy-report.json`, 'utf8'));
const provenance = JSON.parse(readFileSync(`${output}provenance.json`, 'utf8'));
const entry = JSON.parse(readFileSync(`${output}manifest-entry.json`, 'utf8'));
const LOCOMOTION = ['aren-idle', 'aren-walk', 'aren-run', 'aren-jump', 'sakda-guard-dash'];

test('the report, provenance and emitted manifest bind the delivered bytes, and every root curve comes from the emitted joint', () => {
  const hash = createHash('sha256').update(bytes).digest('hex');
  for (const artifact of [report, provenance, entry]) assert.equal(artifact.outputHash, hash);
  const hips = rig.index.get('mixamorig:Hips');
  for (const spec of provenance.clips) {
    const motion = entry.rootMotion[spec.clip];
    if (motion.mode === 'in-place') continue;
    assert.equal(motion.rootNodeName, PropertyBinding.sanitizeNodeName(rig.names[hips]));
    const { frames, times, count } = readClipFrames(rig, spec.clip), track = frames.positions[hips];
    for (const sample of motion.curveSamples) {
      const k = Array.from(times).findIndex((time) => Math.abs(time - sample.time) < 1e-6);
      assert.ok(k >= 0 && k < count, `${spec.clip}: root sample is not on an emitted frame`);
      assert.deepEqual(sample.position, { x: track[k * 3], y: track[k * 3 + 1], z: track[k * 3 + 2] });
    }
  }
  for (const clip of parseGlb(bytes).json.animations) for (const channel of clip.channels) {
    assert.notEqual(channel.target.path, 'scale', `${clip.name}: animated mesh scale`);
    if (channel.target.path === 'translation') assert.equal(channel.target.node, hips, `${clip.name}: animated bone length`);
  }
});
const SKILLS = ['sakda-limb-1', 'sakda-limb-2', 'sakda-limb-3', 'sakda-limb-4', 'sakda-echo-wave', 'sakda-resonating-strike', 'sakda-elbow-charge', 'sakda-hundred-elbows', 'sakda-tempest',
  'sakda-knee-charge', 'sakda-flying-knee', 'sakda-iron-clinch', 'sakda-cleanse', 'sakda-tigers-wrath'];
/** Simulation ticks per clip (src/game/combat/SakdaSkills.ts, contract §5; Guard Dash = 18 dash + 14 recovery ticks; the loops are 0.8 s and the cleanse is Aren's 90-tick lock). */
const TOTAL_TICKS = {
  'sakda-limb-1': 20, 'sakda-limb-2': 22, 'sakda-limb-3': 26, 'sakda-limb-4': 32, 'sakda-echo-wave': 24, 'sakda-resonating-strike': 30, 'sakda-elbow-charge': 48,
  'sakda-hundred-elbows': 60, 'sakda-tempest': 28, 'sakda-knee-charge': 48, 'sakda-flying-knee': 40, 'sakda-iron-clinch': 36, 'sakda-cleanse': 90, 'sakda-tigers-wrath': 60, 'sakda-guard-dash': 32,
};
const ACTIVE_TICK = {
  'sakda-limb-1': 7, 'sakda-limb-2': 8, 'sakda-limb-3': 10, 'sakda-limb-4': 13, 'sakda-echo-wave': 9, 'sakda-resonating-strike': 18, 'sakda-hundred-elbows': 12, 'sakda-tempest': 12,
  'sakda-flying-knee': 30, 'sakda-iron-clinch': 12, 'sakda-cleanse': 35, 'sakda-tigers-wrath': 24,
};
const LOOPS = ['aren-idle', 'aren-walk', 'aren-run', 'sakda-elbow-charge', 'sakda-knee-charge'];
const RIG_SCALE = entry.coordinateTransform.scale;
const PRINT = Boolean(process.env.SAKDA_TEST_PRINT);
const joint = (name) => rig.index.get(`mixamorig:${name}`);
const jointAt = (frames, k, name) => new Vector3().setFromMatrixPosition(rig.poseFrame(frames, k)[joint(name)]);
const hipsWorld = (frames, k) => jointAt(frames, k, 'Hips');
const tableOf = (name) => (name === 'JOINT_LIMITS' ? JOINT_LIMITS : name === 'COMBAT_LIMITS' ? COMBAT_LIMITS : { ...JOINT_LIMITS, ...Object.fromEntries(Object.entries(report.kickLimits.table)) });
const clipOf = (name) => provenance.clips.find((spec) => spec.clip === name);
/** The SakdaForward scene node turns the rig's +X (the strike direction) into +Z. */
const forward = (position) => position.z;

test('every Sakda clip stays inside its anatomical limits (locomotion: the native envelope, strikes: the strict table, kicks: the documented kick table)', () => {
  for (const spec of provenance.clips) {
    const table = tableOf(spec.limits);
    const { frames, count } = readClipFrames(rig, spec.clip);
    const excursions = jointExcursions(rig, frames, count, table);
    for (const [name, peak] of Object.entries(excursions)) {
      assert.ok(peak.swing <= table[name].swing + 1e-3, `${spec.clip} ${name} swing ${peak.swing.toFixed(2)}° > ${table[name].swing}°`);
      assert.ok(peak.twist <= table[name].twist + 1e-3, `${spec.clip} ${name} twist ${peak.twist.toFixed(2)}° > ${table[name].twist}°`);
    }
  }
});

test('the kick table only raises limits above the native envelope and stays human (thigh swing ≤ 150°, knee ≤ 150°)', () => {
  for (const [name, limit] of Object.entries(report.kickLimits.table)) {
    assert.ok(limit.swing >= JOINT_LIMITS[name].swing && limit.twist >= JOINT_LIMITS[name].twist, `${name} was lowered`);
    if (/UpLeg$/.test(name)) assert.ok(limit.swing <= 150, `${name} swing ${limit.swing}`);
    if (/Leg$/.test(name) && !/UpLeg$/.test(name)) assert.ok(limit.swing <= 150, `${name} swing ${limit.swing}`);
  }
});

test('every clip plays captured motion: a Tripo preset of this rig (recorded task) or a Mixamo FBX whose bytes match the recorded hash; no hand-keyed poses', () => {
  const mixamoLedger = JSON.parse(readFileSync(`${root}asset-source/mixamo/provenance.json`, 'utf8'));
  const ledgerText = JSON.stringify(mixamoLedger);
  for (const spec of provenance.clips) {
    assert.equal(spec.pose, undefined, `${spec.clip} carries hand-keyed pose keys`);
    for (const part of spec.parts ?? [spec]) {
      const donor = part.source.donor;
      if (donor.startsWith('m:')) {
        const source = provenance.mixamo[donor.slice(2)];
        assert.ok(source, `${spec.clip}: Mixamo source ${donor} is not recorded`);
        assert.equal(createHash('sha256').update(readFileSync(root + source.file)).digest('hex'), source.sha256, `${source.file} changed since the build`);
        assert.ok(ledgerText.includes(source.sha256), `${source.file} is not in asset-source/mixamo/provenance.json`);
      } else {
        assert.ok(provenance.tasks[donor] && provenance.presets[donor]?.includes(part.source.animation), `${spec.clip}: ${donor}/${part.source.animation} is not a recorded Tripo preset`);
      }
    }
  }
});


test('no clip deforms the skin more than the locomotion ceiling (p99.9 of the triangle-edge stretch), and the authored skills stay well below it', { timeout: 180_000 }, () => {
  const ceiling = report.deformationCeiling.p999;
  assert.equal(ceiling, Math.max(report.deformationCeiling.reference.p999, ...LOCOMOTION.map((name) => report.clips[name].deformation.p999)));
  for (const name of Object.keys(report.clips)) assert.ok(report.clips[name].deformation.p999 <= ceiling + 1e-9, `${name}: ${report.clips[name].deformation.p999} > ${ceiling}`);
  for (const name of [...SKILLS, ...LOCOMOTION.filter((item) => item !== 'aren-jump')]) assert.ok(report.clips[name].deformation.p999 <= 1.5, `${name}: ${report.clips[name].deformation.p999} > 1.5 (captured combat/locomotion ceiling)`);
  // The report is the measurement of the delivered bytes: re-measure the strongest skill and the strongest clip overall.
  const strongest = SKILLS.reduce((best, name) => (report.clips[name].deformation.p999 > report.clips[best].deformation.p999 ? name : best));
  const worstOverall = Object.keys(report.clips).reduce((best, name) => (report.clips[name].deformation.p999 > report.clips[best].deformation.p999 ? name : best));
  for (const name of new Set([strongest, worstOverall])) {
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
    assert.equal(clipOf(name).sim.totalTicks, ticks);
  }
  for (const [name, tick] of Object.entries(ACTIVE_TICK)) assert.equal(clipOf(name).sim.activeTick, tick, `${name} activeTick`);
  for (const spec of provenance.clips) assert.equal(entry.actionToClipMapping[spec.clip], spec.clip, `${spec.clip} is not mapped to itself`);
});

test('the shared locomotion, reaction, dodge and traversal action ids resolve to Sakda clips', () => {
  const mapping = entry.actionToClipMapping;
  for (const id of ['idle', 'walk', 'run', 'jump', 'hit', 'cheer', 'defeat', 'air-step', 'strafe', 'stagger', 'stumble-recovery', 'hard-landing']) assert.ok(mapping[`aren-${id}`], `aren-${id}`);
  for (const id of ['forward-left-dive-roll', 'forward-right-dive-roll', 'perfect-dodge-left', 'perfect-dodge-right', 'quick-step-left', 'quick-step-right', 'forward-shoulder-roll', 'back-handspring',
    'left-cartwheel', 'right-cartwheel', 'back-left-pivot-roll', 'back-right-pivot-roll', 'low-slide', 'dodge-recovery']) assert.equal(mapping[`aren-${id}`], 'sakda-guard-dash', `aren-${id}`);
  for (const id of ['staff-vault', 'low-ledge', 'swing']) assert.equal(mapping[`aren-${id}`], 'aren-jump', `aren-${id}`);
  for (const [action, clip] of Object.entries(mapping)) assert.ok(provenance.clips.some((spec) => spec.clip === clip), `${action} → ${clip} is not an authored clip`);
  for (const skill of SKILLS) assert.equal(mapping[skill], skill);
  assert.equal(entry.id, 'actor-sakda-hero');
  assert.equal(entry.actorId, 'aren');
  assert.equal(entry.variantOf, 'actor-aren');
  assert.equal(entry.evidenceStatus, 'blocked');
  assert.deepEqual(entry.sockets, []);
});

test('locomotion and charge loops are seamless: the last frame equals the first', () => {
  const a = new Quaternion(), b = new Quaternion();
  for (const name of LOOPS) {
    const { frames, count } = readClipFrames(rig, name);
    let worst = 0;
    for (const track of frames.rotations) if (track) worst = Math.max(worst, a.fromArray(track, 0).angleTo(b.fromArray(track, (count - 1) * 4)));
    assert.ok(worst < 2e-3, `${name}: loop seam ${worst} rad`);
    for (const track of frames.positions) if (track) {
      const gap = new Vector3().fromArray(track, 0).distanceTo(new Vector3().fromArray(track, (count - 1) * 3));
      assert.ok(gap * RIG_SCALE < 1e-4, `${name}: loop position seam ${gap * RIG_SCALE} m`);
    }
  }
});

test('every clip with a strike tick reaches its contact surface within ±2 ticks of that tick (fist, elbow, knee, shin or heel farthest forward; a stomping heel first on the floor)', () => {
  const contactClips = Object.keys(ACTIVE_TICK).filter((name) => name !== 'sakda-cleanse');
  for (const name of contactClips) assert.ok(clipOf(name).strikes?.length, `${name} lists no contact surface`);
  let checked = 0, listed = 0;
  for (const spec of provenance.clips.filter((item) => item.strikes)) {
    const { frames, count, times } = readClipFrames(rig, spec.clip);
    for (const strike of spec.strikes) {
      listed += 1;
      const rows = [];
      for (let k = 0; k < count; k += 1) {
        const tick = Math.round(times[k] * 60);
        if (Math.abs(tick - strike.tick) > 6) continue;
        const points = strike.joints.map((name) => jointAt(frames, k, name));
        const reaches = points.map(forward);
        rows.push({ tick, reach: strike.metric === 'shin' ? reaches.reduce((a, b) => a + b, 0) / reaches.length : Math.max(...reaches), height: Math.min(...points.map((p) => p.y)) });
      }
      const lowest = Math.min(...rows.map((row) => row.height));
      const contact = strike.metric === 'floor' ? rows.find((row) => row.height <= lowest + 0.004) : rows.reduce((a, b) => (b.reach > a.reach ? b : a));
      assert.ok(Math.abs(contact.tick - strike.tick) <= 2, `${spec.clip}: ${strike.joints.join('+')} makes contact on tick ${contact.tick}, strike tick ${strike.tick}`);
      checked += 1;
    }
  }
  assert.equal(checked, listed);
  assert.ok(checked >= 18, `${checked} strikes checked`);
});

test('each strike hits with the right surface in the right place: fists extend with a bent elbow, the elbow leads in front of the chin, the knee rises to the hips, the kicks land extended', () => {
  const at = (name, tick) => ({ ...readClipFrames(rig, name), tick });
  const forwardOf = (clip, name) => forward(jointAt(clip.frames, clip.tick, name));
  const strikeOf = (name, joint) => clipOf(name).strikes.find((strike) => strike.joints.includes(joint)).tick;
  // Fists (jab and cross of limb-1, the echo wave's rear straight): a bent elbow, the fist well ahead of the face and the arm pointing along the line to the target (±25°),
  // however far the chest has turned.
  for (const [name, hand, shoulder, elbow] of [['sakda-limb-1', 'LeftHand', 'LeftArm', 'LeftForeArm'], ['sakda-limb-1', 'RightHand', 'RightArm', 'RightForeArm'], ['sakda-echo-wave', 'RightHand', 'RightArm', 'RightForeArm']]) {
    const tick = strikeOf(name, hand), clip = at(name, tick);
    const head = forwardOf(clip, 'Head'), reach = jointAt(clip.frames, tick, hand).sub(jointAt(clip.frames, tick, shoulder));
    assert.ok(forwardOf(clip, hand) - head > 0.2, `${name}: the fist is ${(forwardOf(clip, hand) - head).toFixed(2)} ahead of the head`);
    const aim = Math.atan2(Math.abs(reach.x), reach.z) * 180 / Math.PI; // scene x = lateral, z = toward the target
    assert.ok(aim <= 25, `${name}: the fist leaves the shoulder ${aim.toFixed(0)}° off the target line`);
    const upper = jointAt(clip.frames, tick, elbow).sub(jointAt(clip.frames, tick, shoulder)), lower = jointAt(clip.frames, tick, hand).sub(jointAt(clip.frames, tick, elbow));
    const bend = Math.acos(Math.min(1, upper.normalize().dot(lower.normalize()))) * 180 / Math.PI;
    assert.ok(bend >= 6 && reach.length() > 0.2, `${name}: elbow bend ${bend.toFixed(1)}°, reach ${reach.length().toFixed(2)}`); // never locked out
  }
  // Elbows (rising on 8 and 52, horizontal on 12/18/24/30/36/42): the elbow tip, not the fist, leads ahead of the chin at chin height with the fist by the head. The rising
  // elbow folds tight (interior angle ≤ 40°, ≤ 45° from the tick before to the tick after, loaded ≤ 70° three ticks before). The captured Mixamo cross elbow lands with
  // a looser fold (~60°) while its tip still leads the fist: ≤ 65° at contact and around it, loaded ≤ 80° three ticks before — still an elbow, not an open-arm swing.
  const interior = (frames, k, side) => {
    const shoulder = jointAt(frames, k, `${side}Arm`), elbow = jointAt(frames, k, `${side}ForeArm`), hand = jointAt(frames, k, `${side}Hand`);
    return Math.acos(Math.min(1, shoulder.sub(elbow).normalize().dot(hand.sub(elbow).normalize()))) * 180 / Math.PI;
  };
  for (const [name, tick, side, contactFold, chamberFold] of [['sakda-limb-2', 8, 'Right', [40, 45], 70], ['sakda-hundred-elbows', 52, 'Right', [40, 45], 70],
    ...[12, 18, 24, 30, 36, 42].map((tick, i) => ['sakda-hundred-elbows', tick, i % 2 ? 'Left' : 'Right', [65, 65], 80])]) {
    const clip = at(name, tick);
    const elbow = forwardOf(clip, `${side}ForeArm`), hand = forwardOf(clip, `${side}Hand`), head = forwardOf(clip, 'Head');
    assert.ok(elbow - head > 0.1, `${name}@${tick}: the ${side} elbow is only ${(elbow - head).toFixed(2)} ahead of the head`);
    assert.ok(elbow > hand + 0.03, `${name}@${tick}: the fist (${hand.toFixed(2)}) is ahead of the elbow (${elbow.toFixed(2)}): that is a punch, not an elbow`);
    const headPosition = jointAt(clip.frames, tick, 'Head');
    assert.ok(jointAt(clip.frames, tick, `${side}ForeArm`).y >= headPosition.y - 0.06, `${name}@${tick}: the elbow tip is below the chin`);
    assert.ok(jointAt(clip.frames, tick, `${side}Hand`).distanceTo(headPosition) <= 0.18, `${name}@${tick}: the fist has left the side of the head (a forearm swing)`);
    const fold = interior(clip.frames, tick, side);
    assert.ok(fold <= contactFold[0], `${name}@${tick}: elbow interior angle ${fold.toFixed(0)}° at contact (≤ ${contactFold[0]}°)`);
    for (let k = tick - 3; k <= tick + 1; k += 1) {
      const limit = k >= tick - 1 ? contactFold[1] : chamberFold;
      assert.ok(interior(clip.frames, k, side) <= limit, `${name}@${k}: the elbow opens to ${interior(clip.frames, k, side).toFixed(0)}° around the hit (≤ ${limit}°)`);
    }
  }
  // Knees (clinch knee on 10, resonating strike on 18, flying knee on 30, iron clinch on 12): the knee is at or above the hips and ahead of the pelvis, the foot is tucked behind it.
  for (const [name, tick] of [['sakda-limb-3', 10], ['sakda-resonating-strike', 18], ['sakda-flying-knee', 30], ['sakda-iron-clinch', 12]]) {
    const clip = at(name, tick), hips = hipsWorld(clip.frames, tick), knee = jointAt(clip.frames, tick, 'RightLeg'), foot = jointAt(clip.frames, tick, 'RightFoot');
    assert.ok(knee.y >= hips.y - 0.1, `${name}: the knee is ${(hips.y - knee.y).toFixed(2)} below the hips`);
    assert.ok(forward(knee) - forward(hips) >= 0.15, `${name}: the knee is only ${(forward(knee) - forward(hips)).toFixed(2)} ahead of the pelvis`);
    assert.ok(forward(foot) < forward(knee) - 0.05 && foot.y < knee.y - 0.1, `${name}: the foot is not tucked under the knee`);
  }
  // Kicks. The rear roundhouse on 13 (Mixamo body kick) and Tiger's Wrath on 24 (the Tripo spinning wheel kick): the leg lands nearly straight (5–35° of knee bend) well
  // ahead of the hips with the support foot on the floor and the pelvis turned over (kicking hip above the support hip). The roundhouse cuts at belt height or above with
  // the kicking-side arm swung down and the lead fist up in front of the face; the spinning kick's heel arrives at head height after the support foot has pivoted ≥ 105°.
  // (The captured body kick keeps its support foot planted, so the pivot is only required of the spin.)
  const heading = (clip, side, tick) => {
    const world = rig.poseFrame(clip.frames, tick), toe = new Vector3().setFromMatrixPosition(world[joint(`${side}ToeBase`)]), ankle = new Vector3().setFromMatrixPosition(world[joint(`${side}Foot`)]);
    return Math.atan2(toe.x - ankle.x, toe.z - ankle.z) * 180 / Math.PI;
  };
  for (const name of ['sakda-limb-4', 'sakda-tigers-wrath']) {
    const tick = ACTIVE_TICK[name], clip = at(name, tick), hips = hipsWorld(clip.frames, tick), foot = jointAt(clip.frames, tick, 'RightFoot'), head = jointAt(clip.frames, tick, 'Head');
    const thigh = jointAt(clip.frames, tick, 'RightUpLeg'), knee = jointAt(clip.frames, tick, 'RightLeg');
    const bend = Math.acos(Math.min(1, knee.clone().sub(thigh).normalize().dot(foot.clone().sub(knee).normalize()))) * 180 / Math.PI;
    assert.ok(bend >= 5 && bend <= 35, `${name}: knee bend ${bend.toFixed(1)}° at contact (5–35°)`);
    assert.ok(forward(foot) - forward(hips) > 0.3, `${name}: the kick reaches only ${(forward(foot) - forward(hips)).toFixed(2)}`);
    assert.ok(jointAt(clip.frames, tick, 'LeftFoot').y < 0.06, `${name}: the support foot has left the floor`);
    assert.ok(thigh.y - jointAt(clip.frames, tick, 'LeftUpLeg').y >= 0.04, `${name}: the pelvis has not turned over`);
    if (name === 'sakda-limb-4') {
      const shin = knee.clone().add(foot).multiplyScalar(0.5), lead = jointAt(clip.frames, tick, 'LeftHand');
      assert.ok(shin.y >= hips.y, `${name}: the mid-shin is at ${shin.y.toFixed(2)}, below the hips (${hips.y.toFixed(2)})`);
      assert.ok(jointAt(clip.frames, tick, 'RightHand').y <= head.y - 0.15, `${name}: the kicking-side arm has not swung down`);
      assert.ok(lead.y >= head.y - 0.1 && lead.distanceTo(head) <= 0.28, `${name}: the lead fist has left the face`);
    } else {
      assert.ok(foot.y >= 0.75, `${name}: the heel is at ${foot.y.toFixed(2)}, below head height`);
      let pivot = Math.abs(heading(clip, 'Left', tick) - heading(clip, 'Left', 0));
      if (pivot > 180) pivot = 360 - pivot;
      assert.ok(pivot >= 105, `${name}: the support foot pivoted only ${pivot.toFixed(0)}°`);
    }
  }
  // The stomp: the rear heel is on the floor on tick 12.
  const stomp = at('sakda-tempest', 12), stompFoot = jointAt(stomp.frames, 12, 'RightFoot');
  assert.ok(stompFoot.y < 0.06, `the stomping foot is ${stompFoot.y.toFixed(2)} above the floor on tick 12`);
});

/** Skinned positions of the arm (hand, forearm), head and foot vertices, thinned by `stride`, with the vertex tables needed to test them. */
function meshKit(stride = 4) {
  const source = parseGlb(bytes), { json, bin } = source, primitive = json.meshes[0].primitives[0];
  const positions = readAccessorAny(json, bin, primitive.attributes.POSITION), joints = readAccessorAny(json, bin, primitive.attributes.JOINTS_0);
  const weights = readAccessorAny(json, bin, primitive.attributes.WEIGHTS_0), inverseBind = readAccessorAny(json, bin, json.skins[0].inverseBindMatrices);
  const vertexCount = positions.length / 3, jointCount = rig.joints.length;
  const groups = { arm: [], head: [], foot: [] };
  for (let v = 0; v < vertexCount; v += 1) {
    let best = 0;
    for (let s = 1; s < 4; s += 1) if (weights[v * 4 + s] > weights[v * 4 + best]) best = s;
    const name = rig.names[rig.joints[joints[v * 4 + best]]].replace('mixamorig:', '');
    const group = /Hand|ForeArm/.test(name) ? 'arm' : /^(Head|Neck)$/.test(name) ? 'head' : /Foot|ToeBase/.test(name) ? 'foot' : undefined;
    if (group && (v % stride === 0 || group === 'head')) groups[group].push(v);
  }
  const matrices = new Float64Array(jointCount * 16), m = new Matrix4(), inverse = new Matrix4();
  const skin = (world, list) => {
    for (let j = 0; j < jointCount; j += 1) { inverse.fromArray(inverseBind, j * 16); m.multiplyMatrices(world[rig.joints[j]], inverse).toArray(matrices, j * 16); }
    const out = new Float64Array(list.length * 3);
    list.forEach((v, i) => {
      const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
      let sx = 0, sy = 0, sz = 0;
      for (let s = 0; s < 4; s += 1) {
        const w = weights[v * 4 + s];
        if (w <= 0) continue;
        const o = joints[v * 4 + s] * 16;
        sx += w * (matrices[o] * x + matrices[o + 4] * y + matrices[o + 8] * z + matrices[o + 12]);
        sy += w * (matrices[o + 1] * x + matrices[o + 5] * y + matrices[o + 9] * z + matrices[o + 13]);
        sz += w * (matrices[o + 2] * x + matrices[o + 6] * y + matrices[o + 10] * z + matrices[o + 14]);
      }
      out[i * 3] = sx; out[i * 3 + 1] = sy; out[i * 3 + 2] = sz;
    });
    return out;
  };
  // Bind-pose head sphere (skull centre in the Head joint's frame) and chest ellipse (in the Spine1 joint's frame).
  const bindWorld = rig.restWorld, head = joint('Head'), chest = joint('Spine1');
  const headBind = skin(bindWorld, groups.head), skull = [];
  groups.head.forEach((v, i) => { if (headBind[i * 3 + 1] > 0.83) skull.push(new Vector3(headBind[i * 3], headBind[i * 3 + 1], headBind[i * 3 + 2])); });
  const skullCentre = skull.reduce((sum, p) => sum.add(p), new Vector3()).divideScalar(skull.length);
  const skullRadius = skull.map((p) => p.distanceTo(skullCentre)).sort((a, b) => a - b)[Math.floor(skull.length / 2)];
  const centreLocal = skullCentre.clone().applyMatrix4(bindWorld[head].clone().invert());
  return { groups, skin, skullRadius, centreLocal, head, chest };
}

test('no foot sinks into the floor, no fist or elbow passes through the head, and no forearm is buried in the chest (sampled over every authored clip)', { timeout: 600_000 }, () => {
  const kit = meshKit(4);
  // Chest: an ellipse (half-depth 0.074, half-width 0.087 rig units) around the Spine1 joint, measured from the bind pose of the spine-weighted vertices, ±0.075 tall.
  const chestRest = rig.restWorld[kit.chest], chestInverse = chestRest.clone().invert();
  const rows = [];
  for (const spec of provenance.clips) {
    const { frames, count } = readClipFrames(rig, spec.clip);
    let lowest = Infinity, closest = Infinity, buried = 0;
    const step = count > 120 ? 6 : 2;
    for (let k = 0; k < count; k += step) {
      const world = rig.poseFrame(frames, k);
      const feet = kit.skin(world, kit.groups.foot);
      for (let i = 0; i < feet.length; i += 3) lowest = Math.min(lowest, feet[i + 1]);
      // Traversal, defeat and celebration retain their captured noncombat poses; their floor contact is still checked.
      if (/air-step|defeat|cheer/.test(spec.clip)) continue;
      const arms = kit.skin(world, kit.groups.arm), centre = kit.centreLocal.clone().applyMatrix4(world[kit.head]);
      const toChest = world[kit.chest].clone().multiply(chestInverse).invert(), p = new Vector3();
      for (let i = 0; i < arms.length; i += 3) {
        closest = Math.min(closest, Math.hypot(arms[i] - centre.x, arms[i + 1] - centre.y, arms[i + 2] - centre.z));
        // Into the chest's rest frame: undo the chest's motion, then test the rest-pose ellipse (scene axes: x = actor's left, y up, z forward).
        p.set(arms[i], arms[i + 1], arms[i + 2]).applyMatrix4(toChest);
        p.sub(new Vector3().setFromMatrixPosition(chestRest));
        const radial = Math.hypot((p.z + 0.021) / 0.074, p.x / 0.087);
        if (Math.abs(p.y) < 0.075 && radial < 1) buried = Math.max(buried, 1 - radial);
      }
    }
    rows.push({ clip: spec.clip, lowest, closest, buried });
    if (PRINT) console.log(spec.clip.padEnd(26), 'lowest foot', lowest.toFixed(4), 'closest arm to skull centre', closest.toFixed(3), `(radius ${kit.skullRadius.toFixed(3)})`, 'chest burial', buried.toFixed(2));
  }
  for (const row of rows) {
    assert.ok(row.lowest >= -0.012, `${row.clip}: a foot is ${(-row.lowest * RIG_SCALE * 100).toFixed(1)} cm below the floor`);
    assert.ok(row.closest >= 0.5 * kit.skullRadius, `${row.clip}: an arm vertex is ${row.closest.toFixed(3)} from the skull centre (radius ${kit.skullRadius.toFixed(3)})`);
    assert.ok(row.buried <= 0.5, `${row.clip}: an arm vertex is buried ${(row.buried * 100).toFixed(0)} % deep in the chest`);
  }
});

test('knees and elbows only fold the way a hinge folds: no hyperextension, and every strike keeps the elbow bent', () => {
  // The hinge direction of each joint is read from the frame of a clip that folds it hardest (the flying knee folds the right knee, the stomp's deep support squat the
  // left, the rising elbow the right arm, the hundred elbows the left).
  const relAt = (frames, k, node) => {
    const rel = rig.restQuaternion[node].clone().invert().multiply(new Quaternion().fromArray(frames.rotations[node], k * 4));
    if (rel.w < 0) rel.set(-rel.x, -rel.y, -rel.z, -rel.w);
    const angle = 2 * Math.acos(Math.min(1, rel.w)), s = Math.sqrt(Math.max(1e-12, 1 - rel.w * rel.w));
    return new Vector3(rel.x / s, rel.y / s, rel.z / s).multiplyScalar(angle);
  };
  const hinge = (clipName, name) => {
    const { frames, count } = readClipFrames(rig, clipName), node = joint(name);
    return Array.from({ length: count }, (_, k) => relAt(frames, k, node)).reduce((a, b) => (b.length() > a.length() ? b : a));
  };
  const references = {
    RightLeg: hinge('sakda-flying-knee', 'RightLeg'), LeftLeg: hinge('sakda-tempest', 'LeftLeg'),
    RightForeArm: hinge('sakda-limb-2', 'RightForeArm'), LeftForeArm: hinge('sakda-hundred-elbows', 'LeftForeArm'),
  };
  for (const [name, reference] of Object.entries(references)) {
    assert.ok(reference.length() * 180 / Math.PI > 60, `${name} reference fold ${(reference.length() * 180 / Math.PI).toFixed(0)}°`);
    const axis = reference.clone().normalize();
    for (const spec of provenance.clips) {
      const { frames, count } = readClipFrames(rig, spec.clip), node = joint(name);
      let least = Infinity;
      for (let k = 0; k < count; k += 1) {
        const rel = rig.restQuaternion[node].clone().invert().multiply(new Quaternion().fromArray(frames.rotations[node], k * 4));
        if (rel.w < 0) rel.set(-rel.x, -rel.y, -rel.z, -rel.w);
        const angle = 2 * Math.acos(Math.min(1, rel.w)), s = Math.sqrt(Math.max(1e-12, 1 - rel.w * rel.w));
        least = Math.min(least, new Vector3(rel.x / s, rel.y / s, rel.z / s).multiplyScalar(angle).dot(axis) * 180 / Math.PI);
      }
      assert.ok(least >= (/Leg/.test(name) ? -12 : -28), `${spec.clip}: ${name} is hyperextended (past straight) by ${(-least).toFixed(1)}° relative to its rest pose`);
    }
  }
});

test('idle guard and stance: fists up at the jaw, hands over 0.12 m apart, feet over 0.3 m apart; jab and cross reach near full extension', () => {
  // The captured Mixamo guard holds the wrists 0.09–0.11 below the head joint (Sakda's head joint sits at the jaw, the fists ride ~0.04 above the wrists), so the band
  // is head − 0.12 … head + 0.12 (the round-2 hand-keyed guard used − 0.1).
  const { frames } = readClipFrames(rig, 'aren-idle');
  for (const k of [0, 20, 60, 100]) {
    const l = jointAt(frames, k, 'LeftHand'), r = jointAt(frames, k, 'RightHand'), head = jointAt(frames, k, 'Head');
    for (const h of [l, r]) assert.ok(h.y > head.y - 0.12 && h.y < head.y + 0.12, `wrist height ${h.y.toFixed(2)} vs head ${head.y.toFixed(2)}`);
    assert.ok(l.distanceTo(r) * RIG_SCALE > 0.12, 'hands too close');
    assert.ok(jointAt(frames, k, 'LeftFoot').distanceTo(jointAt(frames, k, 'RightFoot')) * RIG_SCALE > 0.3, 'feet too close');
  }
  // The captured jab and cross land at 145–150° of elbow angle (a real medium-range punch, never locked): ≥ 140° and short of straight.
  for (const [hand, arm, elbow] of [['LeftHand', 'LeftArm', 'LeftForeArm'], ['RightHand', 'RightArm', 'RightForeArm']]) {
    const tick = clipOf('sakda-limb-1').strikes.find((strike) => strike.joints.includes(hand)).tick;
    const clip = readClipFrames(rig, 'sakda-limb-1'), P = (n) => jointAt(clip.frames, tick, n);
    const angle = Math.acos(P(arm).sub(P(elbow)).normalize().dot(P(hand).sub(P(elbow)).normalize())) * 180 / Math.PI;
    assert.ok(angle >= 140 && angle < 179, `sakda-limb-1 ${hand}: elbow angle ${angle.toFixed(0)}`);
    const travel = P(hand).distanceTo(jointAt(clip.frames, 0, hand)) * RIG_SCALE;
    assert.ok(travel >= 0.3, `sakda-limb-1 ${hand}: fist travel ${travel.toFixed(2)} m`);
  }
});

test('no clip raises both hands above the head; the stances stay wide and the walk is no longer a tightrope', () => {
  // The donor reactions (cheer, defeat) and airborne donors (jump, air-step) are exempt from the hands check.
  for (const name of [...SKILLS, 'aren-idle', 'aren-hit', 'sakda-guard-dash', 'aren-walk', 'aren-run']) {
    const { frames, count } = readClipFrames(rig, name);
    for (let k = 0; k < count; k += 1) {
      const head = jointAt(frames, k, 'Head'), lower = Math.min(jointAt(frames, k, 'LeftHand').y, jointAt(frames, k, 'RightHand').y);
      assert.ok(lower <= head.y + 0.08, `${name}@${k}: both wrists are ${(lower - head.y).toFixed(2)} above the head joint (the fists are over the head)`);
    }
  }
  // Guarded stance clips remain ≥ 0.33 m apart sideways. The engine's 4.4 m/s walk slot now plays a captured jog; jog foot crossover is natural, so
  // its quality is checked through stride and cadence below rather than the obsolete hand-keyed ≥ 0.30 m lateral separation in every grounded frame.
  for (const [name, minimum] of [['aren-idle', 0.33], ['aren-hit', 0.33], ['sakda-guard-dash', 0.33], ['sakda-elbow-charge', 0.33], ['sakda-knee-charge', 0.33]]) {
    const { frames, count } = readClipFrames(rig, name);
    for (let k = 0; k < count; k += 1) {
      const l = jointAt(frames, k, 'LeftFoot'), r = jointAt(frames, k, 'RightFoot');
      if (l.y > 0.06 || r.y > 0.06) continue;
      assert.ok(Math.abs(l.x - r.x) * RIG_SCALE >= minimum, `${name}@${k}: the feet are only ${(Math.abs(l.x - r.x) * RIG_SCALE).toFixed(2)} m apart sideways`);
    }
  }
});

test('the walk slot is a full captured jog at 4.4 m/s, not a narrow walk or frantic boxing shuffle', () => {
  const { frames, count } = readClipFrames(rig, 'aren-walk');
  for (const foot of ['LeftFoot', 'RightFoot']) {
    const values = Array.from({ length: count }, (_, k) => forward(jointAt(frames, k, foot)));
    const excursion = (Math.max(...values) - Math.min(...values)) * RIG_SCALE;
    assert.ok(excursion >= 0.85, `${foot}: fore-aft excursion ${excursion.toFixed(3)} m`);
  }
  const walk = report.movingLocomotion['aren-walk-moving-4.4mps'], run = report.movingLocomotion['aren-run-moving-6.6mps'];
  assert.equal(walk.speedMetresPerSecond, 4.4);
  assert.equal(run.speedMetresPerSecond, 6.6);
  assert.ok(walk.stepsPerSecond >= 2.5 && walk.stepsPerSecond <= 3.8, `jog cadence ${walk.stepsPerSecond} steps/s`);
  assert.ok(run.stepsPerSecond > walk.stepsPerSecond && run.stepsPerSecond <= 5, `sprint cadence ${run.stepsPerSecond} steps/s`);
  for (const [name, measured] of [['aren-walk', walk], ['aren-run', run]]) {
    assert.ok(measured.plantedVertexRuns >= 1000, `${name}: no sustained skinned-sole contact`);
    assert.ok(measured.plantedVertexTravelP95Metres <= 0.075, `${name}: excessive near-floor marker travel`);
    assert.ok(measured.plantedVertexTravelMaxMetres <= 0.08, `${name}: near-floor marker travel exceeds 8 cm`);
    const { frames: gait, count: n, times } = readClipFrames(rig, name), period = n - 1;
    let steps = 0;
    for (const foot of ['LeftFoot', 'RightFoot']) {
      const values = Array.from({ length: period }, (_, k) => forward(jointAt(gait, k, foot).sub(hipsWorld(gait, k))));
      const middle = (Math.min(...values) + Math.max(...values)) / 2;
      steps += values.filter((value, k) => value > middle && values[(k + period - 1) % period] <= middle).length;
    }
    assert.equal(measured.stepsPerLoop, steps, `${name}: independently counted steps`);
    assert.ok(Math.abs(measured.stepsPerSecond - steps / times[n - 1]) < 1e-5, `${name}: independently measured cadence`);
  }
});

test('the guard dash and aren-air-step play in place: no horizontal Hips travel; air-step changes Hips height by at most 0.15 m', () => {
  for (const name of ['aren-air-step', 'sakda-guard-dash']) {
    const { frames, count } = readClipFrames(rig, name);
    const low = new Vector3(Infinity, Infinity, Infinity), high = new Vector3(-Infinity, -Infinity, -Infinity);
    for (let k = 0; k < count; k += 1) { const p = hipsWorld(frames, k); low.min(p); high.max(p); }
    assert.ok(Math.hypot(high.x - low.x, high.z - low.z) * RIG_SCALE < 1e-3, `${name}: horizontal Hips travel`);
    if (name === 'aren-air-step') assert.ok((high.y - low.y) * RIG_SCALE <= 0.15, `vertical Hips change ${((high.y - low.y) * RIG_SCALE).toFixed(3)} m`);
  }
});

test('Sakda is barehanded: the manifest carries no weapon socket and the scene has no weapon node', () => {
  const names = parseGlb(bytes).json.nodes.map((node) => String(node.name ?? '').toLowerCase());
  assert.ok(!names.some((name) => /katana|staff|glaive|weapon/.test(name)));
  assert.ok(names.includes('sakdaforward'), 'forward-fix node');
  assert.equal(provenance.discarded.rigV25.credits + provenance.discarded.animA.credits, 75);
});

test('the Tripo credit ledger adds up and stays inside the 800-credit authorisation', () => {
  const spent = Object.values(provenance.credits).reduce((sum, value) => sum + value, 0)
    + [provenance.discarded, provenance.tooling].reduce((sum, table) => sum + Object.values(table).reduce((total, value) => total + value.credits, 0), 0);
  assert.equal(provenance.creditTotal, spent);
  assert.ok(spent <= 800, `${spent} credits`);
});
