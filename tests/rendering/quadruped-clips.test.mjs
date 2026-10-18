import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, it, before } from 'node:test';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Validates the authored quadruped clip sets produced by scripts/assets/author-quadruped-clips.mjs.
// GLTFLoader parses the real runtime GLB in Node (a material-only plugin skips texture decoding, which
// would need DOM image APIs); clips are then sampled through three's own keyframe interpolants.
const root = process.cwd();
const FPS = 30;
const REQUIRED = {
  'monster-idle': { seconds: 3.0, loop: true },
  'monster-run': { seconds: [0.55, 0.7], loop: true },
  'monster-slash': { seconds: 1.2 },
  'monster-shoot': { seconds: 1.4 },
  'monster-jump': { seconds: 1.6 },
  'monster-hurt': { seconds: 0.7 },
  'monster-turn': { seconds: 1.0, loop: true },
  'monster-dive': { seconds: 1.0 },
  'monster-roar': { seconds: 2.0 },
  // Optional slot, authored for rigs with a real tail chain (all three Greenwake quadrupeds have one).
  'monster-tail': { seconds: 1.3 },
  // One-shot lifecycle slots: the collapse rests on the ground in a held pose, the entrance ends on the idle clip's first frame.
  'monster-death': { seconds: 1.6 },
  'monster-spawn': { seconds: 1.4 },
  // Knockdown / get-up: a non-lethal hit reaction. The knockdown is a faster fall (1.2 s, contact at 0.45, held lie from 0.62 to 1.0)
  // that ends on an alert held lie, the get-up starts on the knockdown's last frame and ends blended into the idle clip's first frame.
  'monster-knockdown': { seconds: 1.2 },
  'monster-getup': { seconds: 1.6 },
};
/** Greenwake quadrupeds replaced the raw 2.6 s Tripo walk preset with an authored ikGait `monster-walk` (cycle seconds). */
const AUTHORED_WALK_SECONDS = { 'actor-ember-boar': 0.5, 'actor-frost-sap-stalker': 0.5, 'actor-root-rammer': 0.8 };
/** Slots that leave the standing pose on purpose (collapse, crouched entrance, knockdown / get-up): excluded from the grounded-stance invariants below. */
const LIFECYCLE = ['monster-death', 'monster-spawn', 'monster-knockdown', 'monster-getup'];
const GROUNDED = ['monster-idle', 'monster-slash', 'monster-shoot', 'monster-hurt', 'monster-roar', 'monster-tail'];
const ASSETS = ['actor-ember-boar', 'actor-frost-sap-stalker', 'actor-root-rammer']
  .filter((id, index) => index < 2 || existsSync(`${root}/asset-source/generated/${id}-runtime-01/${id}-animated.glb`));
const EXPECTED_HEAD = { 'actor-ember-boar': '+Z', 'actor-frost-sap-stalker': '-Z', 'actor-root-rammer': '+X' };

const sanitize = name => THREE.PropertyBinding.sanitizeNodeName(name);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const toArrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const glbJson = bytes => JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)).trim());

const PLAYTEST_MANIFESTS = ['greenwake', 'canopy', 'grove', 'moonpine', 'mistveil', 'bamboo', 'later'];
const PLAYTEST_ENTRIES = (await Promise.all(PLAYTEST_MANIFESTS.map(name => readFile(`${root}/asset-source/playtests/${name}.json`, 'utf8').then(JSON.parse)))).flat();
const NATIVE_ATTACK_SOURCE_IDS = Object.keys(JSON.parse(await readFile(`${root}/asset-source/animation/enemy-attack-sources.json`, 'utf8')).nativeSources);
function rebuildCombatHash(id) {
  const output = execFileSync('bun', ['scripts/assets/author-enemy-attacks.mjs', id, '--dry-run'], { cwd: root, encoding: 'utf8', timeout: 120_000 });
  return output.trim().split('\n').map(line => JSON.parse(line)).find(row => row.assetId === id).outputHash;
}

describe('native enemy attack artifact reproducibility', () => {
  for (const id of NATIVE_ATTACK_SOURCE_IDS) {
    it(`${id}: rebuilds the manifest-selected attack runtime from its immutable source`, { timeout: 120_000 }, () => {
      const manifest = PLAYTEST_ENTRIES.find(entry => entry.id === id);
      assert.ok(manifest, `${id}: missing runtime catalog entry`);
      assert.equal(rebuildCombatHash(id), manifest.outputHash, `${id}: native attack runtime is stale`);
    });
  }
});
async function loadAsset(id) {
  const dir = `${root}/asset-source/generated/${id}-runtime-01`;
  const manifest = PLAYTEST_ENTRIES.find(entry => entry.id === id);
  assert.ok(manifest, `${id} has a native runtime manifest entry`);
  const [inputBytes, outputBytes, report, runtimeReport] = await Promise.all([
    readFile(`${dir}/${id}.glb`), readFile(`${root}/${manifest.runtimeUrl.replace(/^\//, '')}`), readFile(`${dir}/clips-report.json`, 'utf8').then(JSON.parse),
    readFile(`${root}/${manifest.provenance}`, 'utf8').then(JSON.parse),
  ]);
  const gltf = await new GLTFLoader()
    .register(() => ({ name: 'pose-only-material', loadMaterial: () => Promise.resolve(new THREE.MeshBasicMaterial()) }))
    .parseAsync(toArrayBuffer(outputBytes), '');
  let skinned;
  gltf.scene.traverse(object => { if (object.isSkinnedMesh) skinned = object; });
  assert.ok(skinned, 'runtime GLB must contain a skinned mesh');
  const bones = new Map(skinned.skeleton.bones.map(bone => [bone.name, bone]));
  const rest = new Map([...bones.values()].map(bone => [bone, { p: bone.position.clone(), q: bone.quaternion.clone() }]));
  gltf.scene.updateMatrixWorld(true);
  const restWorld = new Map([...bones.values()].map(bone => [bone, bone.getWorldPosition(new THREE.Vector3())]));
  const forward = new THREE.Vector3(report.suggestedCoordinateTransformForward.x, 0, report.suggestedCoordinateTransformForward.z);
  const left = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), forward);
  const restWorldQuaternion = bones.get(sanitize(report.rig.hips)).getWorldQuaternion(new THREE.Quaternion());
  return { id, dir, inputBytes, outputBytes, report, runtimeReport, manifest, gltf, bones, rest, restWorld, restWorldQuaternion, skinned, forward, left };
}

function resetRest(asset) {
  for (const [bone, pose] of asset.rest) { bone.position.copy(pose.p); bone.quaternion.copy(pose.q); }
}

/** Samples a clip with three's interpolants and returns per-frame world data. */
function sampleClip(asset, clip, frames = Math.round(clip.duration * FPS)) {
  const interpolants = clip.tracks.map(track => {
    const dot = track.name.lastIndexOf('.');
    const bone = asset.bones.get(track.name.slice(0, dot));
    assert.ok(bone, `track targets unknown bone ${track.name}`);
    return { bone, property: track.name.slice(dot + 1), interpolant: track.createInterpolant() };
  });
  const out = [];
  for (let f = 0; f <= frames; f++) {
    const time = Math.min(clip.duration, f / FPS);
    resetRest(asset);
    for (const { bone, property, interpolant } of interpolants) {
      const values = interpolant.evaluate(time);
      if (property === 'quaternion') bone.quaternion.fromArray(values).normalize();
      else if (property === 'position') bone.position.fromArray(values);
      else assert.fail(`unexpected animated property ${property}`);
    }
    asset.gltf.scene.updateMatrixWorld(true);
    const world = new Map();
    for (const bone of asset.bones.values()) {
      world.set(bone, { p: bone.getWorldPosition(new THREE.Vector3()), q: bone.getWorldQuaternion(new THREE.Quaternion()) });
    }
    out.push({ time, world, rootY: asset.bones.get(sanitize('tripo::Root')).position.y, local: new Map([...asset.bones.values()].map(b => [b, b.quaternion.clone()])) });
  }
  resetRest(asset);
  asset.gltf.scene.updateMatrixWorld(true);
  return out;
}

function probe(asset, sample, name) {
  const { joint, localOffset } = asset.report.rig.probes[name];
  const bone = asset.bones.get(sanitize(joint));
  const w = sample.world.get(bone);
  return new THREE.Vector3(...localOffset).applyQuaternion(w.q).add(w.p);
}

function legLeaves(asset) {
  const leaves = {};
  for (const [key, chain] of Object.entries(asset.report.rig.legs)) {
    const found = [];
    const visit = bone => { const kids = bone.children.filter(c => asset.bones.has(c.name)); if (!kids.length) found.push(bone); kids.forEach(visit); };
    visit(asset.bones.get(sanitize(chain.at(-1))));
    leaves[key] = found;
  }
  return leaves;
}

const peakSpeedTime = (samples, positions) => {
  const dt = 1 / FPS;
  let best = 0, bestFrame = 0;
  for (let f = 1; f < samples.length - 1; f++) {
    const speed = positions[f + 1].distanceTo(positions[f - 1]) / (2 * dt);
    if (speed > best) { best = speed; bestFrame = f; }
  }
  return { time: bestFrame / (samples.length - 1), speed: best };
};

for (const id of ASSETS) {
  describe(`${id} authored quadruped clips`, () => {
    let asset, clipsByName, samples, leaves, H;
    before(async () => {
      asset = await loadAsset(id);
      clipsByName = new Map(asset.gltf.animations.map(clip => [clip.name, clip]));
      samples = new Map();
      for (const name of Object.keys(REQUIRED)) samples.set(name, sampleClip(asset, clipsByName.get(name)));
      leaves = legLeaves(asset);
      H = asset.report.body.heightUnits;
    });

    it('parses through GLTFLoader and keeps the original walk clip and every original byte', () => {
      assert.ok(clipsByName.has('preset:quadruped:walk'));
      const inputJson = glbJson(asset.inputBytes), outputJson = glbJson(asset.outputBytes);
      assert.deepEqual(outputJson.animations[0], inputJson.animations[0], 'walk clip JSON must be untouched');
      assert.deepEqual(outputJson.nodes, inputJson.nodes, 'rest skeleton must be untouched');
      assert.deepEqual(outputJson.meshes, inputJson.meshes);
      assert.deepEqual(outputJson.skins, inputJson.skins);
      const inputBin = asset.inputBytes.subarray(20 + asset.inputBytes.readUInt32LE(12) + 8);
      const outputBin = asset.outputBytes.subarray(20 + asset.outputBytes.readUInt32LE(12) + 8);
      assert.ok(outputBin.subarray(0, inputBin.length).equals(inputBin), 'original binary data must be a prefix of the output');
    });

    it('reports hashes, head axis and body metrics that match the files', () => {
      const report = asset.report;
      assert.equal(report.input.sha256, sha256(asset.inputBytes));
      assert.equal(asset.runtimeReport.output.sha256, sha256(asset.outputBytes));
      assert.equal(asset.runtimeReport.output.bytes, asset.outputBytes.length);
      const head = asset.bones.get(sanitize(report.rig.headTipJoint)), tail = asset.bones.get(sanitize(report.rig.tail.at(-1)));
      const forwardVector = new THREE.Vector3(report.suggestedCoordinateTransformForward.x, 0, report.suggestedCoordinateTransformForward.z);
      const headward = asset.restWorld.get(head).clone().sub(asset.restWorld.get(tail)).dot(forwardVector);
      assert.ok(headward > 0.2, `suggested forward must point from the tail to the head (${headward})`);
      assert.equal(Math.abs(forwardVector.length() - 1) < 1e-9 && forwardVector.x * forwardVector.z === 0, true);
      assert.equal(report.headAxis, `${forwardVector.x + forwardVector.z > 0 ? '+' : '-'}${forwardVector.z !== 0 ? 'Z' : 'X'}`);
      if (EXPECTED_HEAD[id]) assert.equal(report.headAxis, EXPECTED_HEAD[id]);
      assert.ok(report.body.heightUnits > 0.3 && report.body.lengthUnits > 0.6);
      for (const name of Object.keys(REQUIRED)) assert.ok(report.clips[name], `report lacks ${name}`);
    });

    it('contains every required clip with a sane duration and 30 fps keyframes', () => {
      for (const [name, spec] of Object.entries(REQUIRED)) {
        const clip = clipsByName.get(name);
        assert.ok(clip, `missing ${name}`);
        if (Array.isArray(spec.seconds)) assert.ok(clip.duration >= spec.seconds[0] && clip.duration <= spec.seconds[1], `${name} duration ${clip.duration}`);
        else assert.ok(Math.abs(clip.duration - spec.seconds) < 0.05, `${name} duration ${clip.duration}`);
        assert.ok(Math.abs(asset.report.clips[name].durationSeconds - clip.duration) < 1e-4);
        const frames = Math.round(clip.duration * FPS);
        for (const track of clip.tracks) {
          assert.equal(track.times.length, frames + 1, `${name}:${track.name} keyframe count`);
          track.times.forEach((time, i) => assert.ok(Math.abs(time - i / FPS) < 1e-5, `${name}:${track.name} time ${i}`));
        }
      }
    });

    it('has finite, normalised keyframes and only animates rotation plus Root translation', () => {
      const rootName = sanitize(asset.report.rig.root);
      for (const name of Object.keys(REQUIRED)) {
        const rotationJoints = new Set();
        for (const track of clipsByName.get(name).tracks) {
          for (const value of track.values) assert.ok(Number.isFinite(value), `${name}:${track.name} has a non-finite value`);
          const [node, property] = [track.name.slice(0, track.name.lastIndexOf('.')), track.name.slice(track.name.lastIndexOf('.') + 1)];
          if (property === 'quaternion') {
            rotationJoints.add(node);
            for (let i = 0; i < track.values.length; i += 4) {
              const length = Math.hypot(track.values[i], track.values[i + 1], track.values[i + 2], track.values[i + 3]);
              assert.ok(Math.abs(length - 1) < 1e-4, `${name}:${track.name} quaternion not normalised`);
            }
          } else {
            assert.equal(property, 'position', `${name} animates ${property}`);
            assert.equal(node, rootName, `${name} translates ${node}`);
          }
        }
        assert.equal(rotationJoints.size, asset.skinned.skeleton.bones.length, `${name} must key every joint`);
      }
    });

    it('preserves every bone length at every frame', () => {
      for (const name of Object.keys(REQUIRED)) {
        for (const sample of samples.get(name)) {
          for (const bone of asset.bones.values()) {
            if (!asset.bones.has(bone.parent?.name)) continue;
            const restLength = asset.restWorld.get(bone).distanceTo(asset.restWorld.get(bone.parent));
            const length = sample.world.get(bone).p.distanceTo(sample.world.get(bone.parent).p);
            assert.ok(Math.abs(length - restLength) < 1e-5, `${name} f${Math.round(sample.time * FPS)} ${bone.name} length ${length} vs ${restLength}`);
          }
        }
      }
    });

    it('keeps all clips in place horizontally and translates the Root vertically only for jump and run', () => {
      const rootName = sanitize(asset.report.rig.root);
      const restRoot = asset.rest.get(asset.bones.get(rootName)).p;
      for (const name of Object.keys(REQUIRED)) {
        const track = clipsByName.get(name).tracks.find(t => t.name === `${rootName}.position`);
        assert.ok(track, `${name} has no Root translation track`);
        let maxHorizontal = 0, maxVertical = 0;
        for (let i = 0; i < track.values.length; i += 3) {
          maxHorizontal = Math.max(maxHorizontal, Math.abs(track.values[i] - restRoot.x), Math.abs(track.values[i + 2] - restRoot.z));
          maxVertical = Math.max(maxVertical, Math.abs(track.values[i + 1] - restRoot.y));
        }
        assert.ok(maxHorizontal < 1e-6, `${name} moves the Root horizontally by ${maxHorizontal}`);
        if (['monster-jump', 'monster-run', ...LIFECYCLE].includes(name)) assert.ok(maxVertical > 0.01, `${name} should move the Root vertically`);
        else assert.ok(maxVertical < 1e-6, `${name} must not translate the Root vertically (${maxVertical})`);
      }
    });

    it('loops seamlessly: first and last pose match and the wrap step is not an outlier', () => {
      for (const [name, spec] of Object.entries(REQUIRED)) {
        if (!spec.loop) continue;
        const frames = samples.get(name);
        const first = frames[0], last = frames.at(-1);
        for (const bone of asset.bones.values()) {
          assert.ok(first.world.get(bone).p.distanceTo(last.world.get(bone).p) < 1e-5, `${name} ${bone.name} position seam`);
          assert.ok(first.local.get(bone).angleTo(last.local.get(bone)) < 1e-4, `${name} ${bone.name} rotation seam`);
        }
        const step = (a, b) => [...asset.bones.values()].reduce((sum, bone) => sum + a.world.get(bone).p.distanceTo(b.world.get(bone).p), 0);
        const interior = [];
        for (let f = 1; f < frames.length - 1; f++) interior.push(step(frames[f - 1], frames[f]));
        const wrap = step(frames.at(-2), frames[1]) / 2;
        assert.ok(wrap <= Math.max(...interior) * 1.3, `${name} wrap step ${wrap} vs interior max ${Math.max(...interior)}`);
      }
    });

    it('never freezes mid-clip and contains clear secondary motion', () => {
      for (const name of Object.keys(REQUIRED)) {
        const frames = samples.get(name);
        // The collapse / knockdown end on a held pose (checked in the lifecycle tests): only their moving part must never
        // freeze. The heldFrom is read from the report so the freeze check respects the AUTHORED hold; a 5-frame safety
        // margin covers any earlier settle. The getup's last quarter is an idle-blend (the getup is held on the idle's
        // first frame at t = 1, so frames inside the last quarter are naturally static) and is exempt.
        const isLifecycleHold = name === 'monster-death' || name === 'monster-knockdown';
        const isIdleBlend = name === 'monster-getup';
        const heldFrom = isLifecycleHold
          ? Math.max(2, Math.round(asset.report.clips[name].measured.heldFromTime * (frames.length - 1)) - 5)
          : frames.length - 3;
        const idleBlendFrom = isIdleBlend ? Math.floor(frames.length * 3 / 4) : frames.length;
        for (let f = 2; f < Math.min(heldFrom, idleBlendFrom); f++) {
          let delta = 0;
          for (const bone of asset.bones.values()) delta += frames[f].world.get(bone).p.distanceTo(frames[f + 1].world.get(bone).p);
          assert.ok(delta > 1e-5, `${name} is static between frames ${f} and ${f + 1}`);
        }
        const tail = asset.bones.get(sanitize(asset.report.rig.tail.at(-1)));
        const travel = Math.max(...frames.map(s => s.world.get(tail).p.distanceTo(frames[0].world.get(tail).p)));
        assert.ok(travel > 0.01 * H, `${name} tail should show follow-through (${travel})`);
      }
    });

    it('measures strike, flinch, stamp and jump timings at the stated semantic times', () => {
      const stated = { 'monster-slash': 0.45, 'monster-shoot': 0.5, 'monster-dive': 0.4 };
      for (const [name, time] of Object.entries(stated)) {
        const frames = samples.get(name);
        const measured = peakSpeedTime(frames, frames.map(s => probe(asset, s, 'snout')));
        assert.ok(Math.abs(measured.time - time) <= 0.08, `${name} peak head speed at ${measured.time}, expected ${time}±0.08`);
        assert.ok(measured.speed > 2 * H, `${name} strike speed ${measured.speed} should be violent`);
        assert.ok(Math.abs(asset.report.clips[name].measured.measuredStrikeTime - measured.time) < 0.002);
      }
      // Hurt: the head jerks furthest from its rest position at ~0.2.
      const hurt = samples.get('monster-hurt'), restSnout = probe(asset, hurt[0], 'snout');
      const displacement = hurt.map(s => probe(asset, s, 'snout').distanceTo(restSnout));
      const peak = displacement.indexOf(Math.max(...displacement)) / (hurt.length - 1);
      assert.ok(Math.abs(peak - 0.2) <= 0.08, `hurt flinch peak at ${peak}`);
      assert.ok(Math.max(...displacement) > 0.1 * H);
      // Roar: front paw stamp contact at ~0.2, sustained shake through 0.25-0.8.
      const roar = samples.get('monster-roar'), stampLeg = asset.report.clips['monster-roar'].measured.stampLeg;
      const paw = leaves[stampLeg][0];
      const lift = roar.map(s => s.world.get(paw).p.y - asset.restWorld.get(paw).y);
      const top = lift.indexOf(Math.max(...lift));
      let contact = top;
      while (contact < lift.length - 1 && lift[contact] > 0.004) contact++;
      assert.ok(Math.abs(contact / (roar.length - 1) - 0.2) <= 0.08, `roar stamp contact at ${contact / (roar.length - 1)}`);
      assert.ok(Math.max(...lift) > 0.1 * H, 'stamp must visibly lift the paw');
      const heads = roar.map(s => probe(asset, s, 'snout'));
      // Shake = high-frequency content: mean absolute second difference of the snout path.
      const shake = (a, b) => { let total = 0, n = 0; for (let f = Math.ceil(a * (roar.length - 1)) + 1; f <= Math.floor(b * (roar.length - 1)) - 1; f++, n++) total += heads[f + 1].clone().sub(heads[f]).sub(heads[f].clone().sub(heads[f - 1])).length(); return total / n; };
      assert.ok(shake(0.3, 0.75) > 2 * shake(0.9, 1.0), 'roar shake window must jitter far more than the settle');
      assert.ok(heads.slice(Math.round(0.3 * 60), Math.round(0.75 * 60)).every(h => h.y > restSnout.y + 0.05 * H), 'roar keeps the head raised through the shake');
      // Jump: Root airborne arc peaks near 0.5 with the personality's baked height.
      const jump = samples.get('monster-jump'), rootRest = asset.rest.get(asset.bones.get(sanitize(asset.report.rig.root))).p.y;
      const rise = jump.map(s => s.rootY - rootRest);
      const peakRise = Math.max(...rise), peakFrame = rise.indexOf(peakRise) / (jump.length - 1);
      assert.ok(Math.abs(peakFrame - 0.5) <= 0.08, `jump peak at ${peakFrame}`);
      const personalityLeap = asset.report.personality.leap;
      assert.ok(Math.abs(peakRise / H - personalityLeap) < 0.01, `jump peak ${peakRise / H} body heights vs personality ${personalityLeap}`);
      assert.ok(peakRise / H > 0.2 && peakRise / H < 0.6);
      if (id === 'actor-ember-boar') assert.ok(Math.abs(peakRise / H - 0.35) < 0.02, 'boar jump peak should be ~0.35 body heights');
      const frameOf = u => Math.round(u * (jump.length - 1));
      assert.ok(Math.min(...rise.slice(0, frameOf(0.3))) < -0.05 * H, 'jump crouch lowers the Root before takeoff');
      assert.ok(rise.slice(frameOf(0.32), frameOf(0.68)).every(v => v > 0), 'Root stays airborne through 0.3-0.7');
      assert.ok(Math.min(...rise.slice(frameOf(0.72), frameOf(0.9))) < -0.04 * H, 'landing compresses the Root');
      assert.ok(Math.abs(rise.at(-1)) < 1e-6 && Math.abs(rise[0]) < 1e-6, 'jump starts and ends at rest height');
    });

    it('winds the head up before a lunge or spit and drives it through the strike, then rebounds', () => {
      const restY = probe(asset, samples.get('monster-slash')[0], 'snout').y;
      const heightAt = (name, u) => { const frames = samples.get(name); return (probe(asset, frames[Math.round(u * (frames.length - 1))], 'snout').y - restY) / H; };
      const raise = name => Math.max(...[0.2, 0.25, 0.3, 0.35, 0.4].map(u => heightAt(name, u)));
      assert.ok(raise('monster-dive') > 0.05, `dive winds the head up before the strike (${raise('monster-dive').toFixed(3)} H)`);
      assert.ok(heightAt('monster-dive', 0.5) < -0.08, `dive drives the head down through the strike (${heightAt('monster-dive', 0.5).toFixed(3)} H)`);
      assert.ok(raise('monster-shoot') > 0.15, `shoot rears the head up before the expel (${raise('monster-shoot').toFixed(3)} H)`);
      assert.ok(heightAt('monster-shoot', 0.6) < 0.1, 'shoot drops the head after the expel');
      // Slash: the head swings sideways relative to the hips (coil to one side, snap across the body).
      const hips = asset.bones.get(sanitize(asset.report.rig.hips));
      const frames = samples.get('monster-slash');
      const lateral = frames.map(s => probe(asset, s, 'snout').sub(s.world.get(hips).p).dot(asset.left) / H);
      assert.ok(Math.max(...lateral) - Math.min(...lateral) > 0.25, `slash swings the head across the body (${(Math.max(...lateral) - Math.min(...lateral)).toFixed(3)} H)`);
      assert.ok(Math.abs(lateral.at(-1) - lateral[0]) < 0.01, 'slash settles back to the rest pose');
    });

    it('tail whip: the hips wind one way, the tail cracks across a wide arc near 0.5 and rings down', () => {
      const frames = samples.get('monster-tail'), report = asset.report.clips['monster-tail'];
      assert.equal(report.semanticKeyTimes.strike, 0.5);
      const base = asset.bones.get(sanitize(asset.report.rig.tail[0])), hips = asset.bones.get(sanitize(asset.report.rig.hips));
      const bearing = s => { const v = probe(asset, s, 'tailTip').sub(s.world.get(base).p); return Math.atan2(v.dot(asset.left), v.dot(asset.forward)) * 180 / Math.PI; };
      const wrap = degrees => ((degrees + 540) % 360) - 180;
      const arc = frames.map(s => wrap(bearing(s) - bearing(frames[0])));
      assert.ok(Math.max(...arc) - Math.min(...arc) > 60, `the tail tip sweeps ${(Math.max(...arc) - Math.min(...arc)).toFixed(0)} degrees around its root`);
      const peak = peakSpeedTime(frames, frames.map(s => probe(asset, s, 'tailTip')));
      assert.ok(peak.time >= 0.4 && peak.time <= 0.65, `tail tip peaks at ${peak.time}`);
      assert.ok(peak.speed > 3 * H, `tail tip speed ${peak.speed} should crack`);
      const restQ = hips.getWorldQuaternion(new THREE.Quaternion());
      const hipYaw = u => {
        const delta = frames[Math.round(u * (frames.length - 1))].world.get(hips).q.clone().multiply(restQ.clone().invert());
        const v = asset.forward.clone().applyQuaternion(delta);
        return Math.atan2(v.dot(asset.left), v.dot(asset.forward)) * 180 / Math.PI;
      };
      assert.ok(hipYaw(0.34) > 3 && hipYaw(0.6) < -3, `hips wind up then drive through (${hipYaw(0.34).toFixed(1)} -> ${hipYaw(0.6).toFixed(1)} degrees)`);
    });

    it('hurt flinches, settles into a dazed pose held over 0.46-0.58 and recovers, so downed monsters never loop the flinch', () => {
      const frames = samples.get('monster-hurt'), restY = probe(asset, frames[0], 'snout').y;
      assert.equal(asset.report.clips['monster-hurt'].semanticKeyTimes.hold, 0.52);
      const at = u => frames[Math.round(u * (frames.length - 1))];
      const heights = [0.46, 0.49, 0.52, 0.55, 0.58].map(u => probe(asset, at(u), 'snout').y);
      assert.ok(heights.every(y => y < restY - 0.04 * H), 'the held pose carries the head low');
      assert.ok(Math.max(...heights) - Math.min(...heights) < 0.06 * H, 'the held pose is sustained, not mid-flinch');
      const speeds = frames.map((s, f) => (f ? probe(asset, s, 'snout').distanceTo(probe(asset, frames[f - 1], 'snout')) * FPS : 0));
      const holdSpeed = Math.max(...speeds.slice(Math.round(0.46 * (frames.length - 1)), Math.round(0.58 * (frames.length - 1)) + 1));
      assert.ok(holdSpeed < 0.35 * Math.max(...speeds), `the hold is calm (${holdSpeed} vs flinch ${Math.max(...speeds)})`);
      assert.ok(probe(asset, frames.at(-1), 'snout').distanceTo(probe(asset, frames[0], 'snout')) < 1e-5 * H, 'the clip recovers to the rest pose');
    });

    it('keeps planted feet within 0.03 body heights of rest in grounded clips', () => {
      for (const name of GROUNDED) {
        const stampLeg = name === 'monster-roar' ? asset.report.clips[name].measured.stampLeg : undefined;
        for (const sample of samples.get(name)) {
          const u = sample.time / clipsByName.get(name).duration;
          for (const [key, list] of Object.entries(leaves)) {
            if (key === stampLeg && u <= 0.3) continue; // deliberate stamp
            for (const bone of list) {
              const deviation = Math.abs(sample.world.get(bone).p.y - asset.restWorld.get(bone).y);
              assert.ok(deviation <= 0.03 * H, `${name} u=${u.toFixed(2)} ${bone.name} off the ground by ${(deviation / H).toFixed(3)} body heights`);
            }
          }
        }
      }
    });

    it('never passes legs through the body or the ground', () => {
      const lateral = asset.report.rig.legs;
      const forward = asset.forward;
      const left = asset.left;
      for (const name of Object.keys(REQUIRED).filter(slot => !LIFECYCLE.includes(slot))) {
        for (const sample of samples.get(name)) {
          for (const [key, chain] of Object.entries(lateral)) {
            const side = key[1] === 'L' ? 1 : -1;
            for (const jointName of chain.slice(1)) {
              const bone = asset.bones.get(sanitize(jointName));
              const rest = side * asset.restWorld.get(bone).dot(left);
              const now = side * sample.world.get(bone).p.dot(left);
              assert.ok(now >= 0.2 * rest, `${name} ${key} ${jointName} crosses the body (${now.toFixed(3)} vs rest ${rest.toFixed(3)})`);
            }
          }
          for (const list of Object.values(leaves)) {
            for (const bone of list) {
              assert.ok(sample.world.get(bone).p.y >= asset.restWorld.get(bone).y - 0.01 * H, `${name} ${bone.name} sinks into the ground`);
            }
          }
          assert.ok(probe(asset, sample, 'snout').y > 0.02 * H, `${name} snout hits the ground`);
          assert.ok(probe(asset, sample, 'tailTip').y > 0.0, `${name} tail tip hits the ground`);
        }
      }
    });

    it('turn clip yaw oscillation is zero-mean and the stepping legs alternate', () => {
      const frames = samples.get('monster-turn');
      const hips = asset.bones.get(sanitize(asset.report.rig.hips));
      const restForward = asset.forward;
      const restQ = hips.getWorldQuaternion(new THREE.Quaternion());
      let sum = 0, min = Infinity, max = -Infinity;
      const yaws = frames.slice(0, -1).map(sample => {
        const delta = sample.world.get(hips).q.clone().multiply(restQ.clone().invert());
        const v = restForward.clone().applyQuaternion(delta);
        return Math.atan2(v.dot(asset.left), v.dot(asset.forward)) * 180 / Math.PI;
      });
      for (const yaw of yaws) { sum += yaw; min = Math.min(min, yaw); max = Math.max(max, yaw); }
      assert.ok(Math.abs(sum / yaws.length) < 0.5, `turn mean yaw ${sum / yaws.length}`);
      assert.ok(max - min > 4, `turn yaw oscillation range ${max - min} should be visible`);
      assert.ok(Math.abs(asset.report.clips['monster-turn'].measured.meanBodyYawDegrees) < 0.5);
      const liftOf = key => frames.map(s => Math.max(...leaves[key].map(b => s.world.get(b).p.y - asset.restWorld.get(b).y)));
      const [fl, fr] = [liftOf('FL'), liftOf('FR')];
      assert.ok(Math.max(...fl) > 0.03 * H && Math.max(...fr) > 0.03 * H, 'both diagonal pairs must lift');
      const firstHalf = (list, from, to) => Math.max(...list.slice(from, to));
      assert.ok(firstHalf(fl, 0, 15) > 2 * firstHalf(fl, 17, 30) || firstHalf(fl, 17, 30) > 2 * firstHalf(fl, 0, 15), 'front-left steps in one half of the loop');
      assert.ok((firstHalf(fl, 0, 15) > firstHalf(fr, 0, 15)) !== (firstHalf(fl, 17, 30) > firstHalf(fr, 17, 30)), 'front legs alternate');
    });

    it('run clip uses the walk legs sped up with a Root bounce', () => {
      const run = clipsByName.get('monster-run');
      assert.ok(run.duration >= 0.55 && run.duration <= 0.7);
      const frames = samples.get('monster-run');
      const rootRest = asset.rest.get(asset.bones.get(sanitize(asset.report.rig.root))).p.y;
      const bounce = frames.map(s => s.rootY - rootRest);
      assert.ok(Math.min(...bounce) >= -1e-6 && Math.max(...bounce) > 0.03 * H, `run bounce range ${Math.min(...bounce)}..${Math.max(...bounce)}`);
      const walk = clipsByName.get('preset:quadruped:walk');
      assert.ok(walk.duration / run.duration > 3.5, 'run cycle must be several times faster than the walk');
      for (const [key, list] of Object.entries(leaves)) {
        const swing = frames.map(s => s.world.get(list[0]).p.dot(asset.forward));
        assert.ok(Math.max(...swing) - Math.min(...swing) > 0.15 * H, `${key} swing amplitude`);
      }
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Lifecycle clips (monster-death / monster-spawn) and authored walks of every Tripo quadruped
// ---------------------------------------------------------------------------------------------
const QUADRUPEDS = ['actor-ember-boar', 'actor-frost-sap-stalker', 'actor-root-rammer', 'actor-frostfang-tracker', 'actor-howl-scout', 'actor-ruun-chained-howl', 'actor-bog-lurker', 'actor-ghor-mire-maw',
  // Later chapters (asset-source/playtests/later.json): the Ridge companions and scouts, the Sunmane lion, the Crowned Beast and the Council envoy.
  'actor-luma', 'actor-sable', 'actor-nyra', 'actor-solkar', 'actor-orun-crowned-beast', 'actor-council-envoy'];
/** Authored ikGait walk cycle seconds (the toad hops, so its stance feet are not a planted gait). */
const WALK_SECONDS = { 'actor-ember-boar': 0.5, 'actor-frost-sap-stalker': 0.5, 'actor-root-rammer': 0.8, 'actor-frostfang-tracker': 0.6, 'actor-howl-scout': 0.5, 'actor-ruun-chained-howl': 0.7, 'actor-ghor-mire-maw': 1.6 };
/** Largest joint difference (degrees) between the entrance's last frame and the idle clip's first frame: the toad's knee-floor leg solve lands a leg 10 degrees off. */
const SIX_PRESET_REPLACED = ['actor-ember-boar', 'actor-frost-sap-stalker', 'actor-root-rammer', 'actor-frostfang-tracker', 'actor-howl-scout', 'actor-ruun-chained-howl'];

/** Creature-family reports (Howler, Rootling and its blighted twin, Hollowheart, Koro, Hornbill, Heron, Viper): the same final-frame measurements the quadruped GLB tests make, read from the clips reports. */
describe('creature-family lifecycle reports', () => {
  for (const id of ['actor-thornback-howler', 'actor-grove-rootling', 'actor-grove-blighted-rootling', 'actor-grove-hollowheart', 'actor-koro', 'actor-storm-hornbill', 'actor-lantern-heron', 'actor-mire-viper']) {
    it(`${id}: death rests on the floor in a held pose and the entrance ends within 3 degrees of idle`, async () => {
      const report = JSON.parse(await readFile(`${root}/asset-source/generated/${id}-runtime-01/clips-report.json`, 'utf8'));
      const death = report.slots['monster-death'], spawn = report.slots['monster-spawn'];
      assert.equal(death.durationSeconds, 1.6);
      assert.equal(spawn.durationSeconds, 1.4);
      assert.equal(death.loop, false);
      assert.ok(death.measured.floorContactBodyHeights.lowestOverClip >= -0.0105, `death sinks ${death.measured.floorContactBodyHeights.lowestOverClip} body heights`);
      assert.ok(death.measured.floorContactBodyHeights.final <= 0.03, `death hovers ${death.measured.floorContactBodyHeights.final} body heights`);
      assert.ok(death.measured.heldFromTime <= 0.9);
      assert.ok(spawn.measured.idleMatch.maxJointDegrees < 3, `entrance ends ${spawn.measured.idleMatch.maxJointDegrees} degrees from idle`);
    });

    it(`${id}: knockdown rests on the floor in an alert held lie from 0.62, getup ends within 3 degrees of idle`, async () => {
      const report = JSON.parse(await readFile(`${root}/asset-source/generated/${id}-runtime-01/clips-report.json`, 'utf8'));
      const knock = report.slots['monster-knockdown'], getup = report.slots['monster-getup'];
      assert.ok(knock, `${id} reports monster-knockdown`);
      assert.ok(getup, `${id} reports monster-getup`);
      assert.equal(knock.durationSeconds, 1.2);
      assert.equal(getup.durationSeconds, 1.6);
      assert.equal(knock.loop, false);
      assert.equal(getup.loop, false);
      // Floor guard: knockdown rests on the ground (settle) and never sinks through it.
      assert.ok(knock.measured.floorContactBodyHeights.lowestOverClip >= -0.0105, `knockdown sinks ${knock.measured.floorContactBodyHeights.lowestOverClip} body heights`);
      assert.ok(knock.measured.floorContactBodyHeights.final <= 0.03, `knockdown hovers ${knock.measured.floorContactBodyHeights.final} body heights`);
      assert.ok(knock.measured.heldFromTime <= 0.7, `knockdown held from ${knock.measured.heldFromTime} (must be <= 0.7)`);
      assert.ok(getup.measured.idleMatch.maxJointDegrees < 3, `getup ends ${getup.measured.idleMatch.maxJointDegrees} degrees from idle`);
    });

    it(`${id}: the get-up starts on the knockdown's last key and ends on the idle's first key on every encoded track (rotations and translations)`, async () => {
      const bytes = await readFile(`${root}/asset-source/generated/${id}-runtime-01/${id}-animated.glb`);
      const gltf = await new GLTFLoader().register(() => ({ name: 'pose-only-material', loadMaterial: () => Promise.resolve(new THREE.MeshBasicMaterial()) })).parseAsync(toArrayBuffer(bytes), '');
      const clip = name => new Map(gltf.animations.find(c => c.name === name).tracks.map(track => [track.name, track]));
      const [knock, getup, idle] = ['monster-knockdown', 'monster-getup', 'monster-idle'].map(clip);
      const duration = name => gltf.animations.find(c => c.name === name).duration;
      const at = (track, time) => track.createInterpolant().evaluate(time);
      const turn = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180 / Math.PI;
      assert.equal(knock.size, getup.size, 'the knockdown and the get-up key the same tracks');
      for (const [name, track] of getup) {
        const lastOfKnock = at(knock.get(name), duration('monster-knockdown')), firstOfGetup = at(track, 0), lastOfGetup = at(track, duration('monster-getup')), firstOfIdle = at(idle.get(name), 0);
        if (name.endsWith('.quaternion')) {
          // 0.05 degrees is the float32 noise floor of acos on two identical unit quaternions.
          assert.ok(turn(firstOfGetup, lastOfKnock) < 0.05, `${id} ${name}: the get-up starts ${turn(firstOfGetup, lastOfKnock).toFixed(3)} degrees from the knockdown's last key`);
          assert.ok(turn(lastOfGetup, firstOfIdle) < 0.05, `${id} ${name}: the get-up ends ${turn(lastOfGetup, firstOfIdle).toFixed(3)} degrees from the idle's first key`);
        } else {
          assert.ok(Math.hypot(...firstOfGetup.map((v, i) => v - lastOfKnock[i])) < 1e-6, `${id} ${name}: the get-up starts off the knockdown's last translation`);
          assert.ok(Math.hypot(...lastOfGetup.map((v, i) => v - firstOfIdle[i])) < 1e-6, `${id} ${name}: the get-up ends off the idle's first translation`);
        }
      }
    });

  }
});

/** Poses the asset's bones from a clip at `time` seconds (no tracks = the rest pose). */
function poseTo(asset, clip, time) {
  resetRest(asset);
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.'), bone = asset.bones.get(track.name.slice(0, dot)), property = track.name.slice(dot + 1);
    const values = track.createInterpolant().evaluate(time);
    if (property === 'quaternion') bone.quaternion.fromArray(values).normalize();
    else bone.position.fromArray(values);
  }
  asset.gltf.scene.updateMatrixWorld(true);
}

/**
 * Lowest and highest skinned vertex height (every 5th vertex of the real skinned mesh) of a clip at `time`. `lowest` / `highest` cover the body;
 * geometry bound to the Root alone is a ground attachment (chain links, tufts), not the body that collapses, and only counts toward `lowestAll`.
 */
function extremes(asset, clip, time, stride = 5) {
  poseTo(asset, clip, time);
  asset.skinned.skeleton.update();
  const vertex = new THREE.Vector3(), count = asset.skinned.geometry.attributes.position.count;
  let lowest = Infinity, highest = -Infinity, lowestAll = Infinity;
  const { skinIndex, skinWeight } = asset.skinned.geometry.attributes;
  const rootBone = asset.skinned.skeleton.bones.findIndex(bone => bone.name === sanitize(asset.report.rig.root));
  for (let i = 0; i < count; i += stride) {
    let dominant = 0;
    for (let k = 1; k < 4; k++) if (skinWeight.getComponent(i, k) > skinWeight.getComponent(i, dominant)) dominant = k;
    asset.skinned.getVertexPosition(i, vertex).applyMatrix4(asset.skinned.matrixWorld);
    lowestAll = Math.min(lowestAll, vertex.y);
    if (skinIndex.getComponent(i, dominant) === rootBone) continue;
    lowest = Math.min(lowest, vertex.y); highest = Math.max(highest, vertex.y);
  }
  resetRest(asset);
  asset.gltf.scene.updateMatrixWorld(true);
  return { lowest, highest, lowestAll };
}

const angleBetween = (a, b) => a.clone().normalize().angleTo(b.clone().normalize());

for (const id of QUADRUPEDS) {
  describe(`${id} lifecycle clips and walk`, () => {
    let asset, clips, rest, H, manifest;
    before(async () => {
      asset = await loadAsset(id);
      clips = new Map(asset.gltf.animations.map(clip => [clip.name, clip]));
      rest = extremes(asset, { tracks: [] }, 0);
      H = asset.report.body.heightUnits;
      manifest = asset.manifest;
    });

    it('carries a one-shot monster-death of 1.6 s that collapses onto the ground without passing through it and ends on a held pose', () => {
      const death = clips.get('monster-death');
      assert.ok(death, 'monster-death exists');
      assert.ok(Math.abs(death.duration - 1.6) < 0.02, `duration ${death.duration}`);
      assert.equal(asset.report.clips['monster-death'].loop, false);
      const frames = Math.round(death.duration * FPS);
      let lowest = Infinity, lowestAll = Infinity;
      for (let f = 0; f <= frames; f += 2) { const e = extremes(asset, death, f / FPS); lowest = Math.min(lowest, e.lowest); lowestAll = Math.min(lowestAll, e.lowestAll); }
      assert.ok(lowest >= rest.lowest - 0.02 * H, `the collapse sinks ${((rest.lowest - lowest) / H).toFixed(4)} body heights into the floor`);
      // Ground attachments (Ruun's chain links ride the Root alone) never go through the floor either: the body is lowered through the Root's children, not the Root.
      assert.ok(lowestAll >= rest.lowestAll - (id === 'actor-ruun-chained-howl' ? 0.002 : 0.02) * H, `ground-bound geometry sinks ${((rest.lowestAll - lowestAll) / H).toFixed(4)} body heights into the floor`);
      const end = extremes(asset, death, death.duration);
      assert.ok(end.lowest <= rest.lowest + 0.03 * H, `the held pose hovers ${((end.lowest - rest.lowest) / H).toFixed(4)} body heights above the floor`);
      if (id === 'actor-ruun-chained-howl') {
        const hover = (end.lowest - rest.lowest) * manifest.coordinateTransform.scale;
        assert.ok(hover >= -0.001 && hover <= 0.03, `Ruun's body rests ${hover.toFixed(4)} m above the floor (0-3 cm)`);
      }
      // Collapsed = clearly lower, or rolled over (a low-slung body on its side or back stands no lower than before, but its orientation is turned).
      const hips = asset.bones.get(sanitize(asset.report.rig.hips));
      poseTo(asset, death, death.duration);
      const turned = hips.getWorldQuaternion(new THREE.Quaternion()).angleTo(asset.restWorldQuaternion) * 180 / Math.PI;
      poseTo(asset, { tracks: [] }, 0);
      assert.ok(rest.highest - end.highest > 0.15 * H || turned > 40, `collapsed: highest point drops ${((rest.highest - end.highest) / H).toFixed(3)} body heights, hips turn ${turned.toFixed(0)} degrees`);
      // Held pose: the last five frames are identical, and the clip is moving well before that.
      const samples = sampleClip(asset, death);
      for (let f = samples.length - 6; f < samples.length - 1; f++) {
        for (const bone of asset.bones.values()) assert.ok(samples[f].world.get(bone).p.distanceTo(samples.at(-1).world.get(bone).p) < 1e-4, `${bone.name} still moves at frame ${f}`);
      }
      assert.ok(asset.report.clips['monster-death'].measured.heldFromTime <= 0.9, 'the held pose starts by 0.9 of the clip');
      const travel = [...asset.bones.values()].reduce((sum, bone) => sum + samples[Math.round(0.5 * frames)].world.get(bone).p.distanceTo(samples[0].world.get(bone).p), 0);
      assert.ok(travel > 0.5 * H, `the collapse is well under way by the middle of the clip (${travel})`);
    });

    it('carries a one-shot monster-spawn of 1.4 s that starts low and ends on the first frame of monster-idle', () => {
      const spawn = clips.get('monster-spawn'), idle = clips.get('monster-idle');
      assert.ok(spawn, 'monster-spawn exists');
      assert.ok(Math.abs(spawn.duration - 1.4) < 0.02, `duration ${spawn.duration}`);
      assert.equal(asset.report.clips['monster-spawn'].loop, false);
      const idleFirst = extremes(asset, idle, 0), first = extremes(asset, spawn, 0);
      if (['actor-bog-lurker', 'actor-ghor-mire-maw'].includes(id)) {
        // Belly-on-the-ground bodies cannot crouch lower: their entrance starts from a clearly different pose (head / neck tucked) instead.
        const spawnFirst = sampleClip(asset, spawn, 1)[0], idleFirstPose = sampleClip(asset, idle, 1)[0];
        const differs = Math.max(...[...asset.bones.values()].map(bone => angleBetween(spawnFirst.local.get(bone), idleFirstPose.local.get(bone)))) * 180 / Math.PI;
        assert.ok(differs > 5, `starts ${differs.toFixed(1)} degrees away from the idle pose`);
      } else assert.ok(idleFirst.highest - first.highest > 0.03 * H, `starts crouched (${((idleFirst.highest - first.highest) / H).toFixed(3)} body heights lower than idle)`);
      const frames = Math.round(spawn.duration * FPS);
      let lowest = Infinity;
      for (let f = 0; f <= frames; f += 2) lowest = Math.min(lowest, extremes(asset, spawn, f / FPS).lowest);
      // The entrance ends on the idle pose itself, which may dip a toe a little under the rest sole; it never sinks further than that.
      assert.ok(lowest >= Math.min(rest.lowest, idleFirst.lowest) - 0.02 * H, `the entrance sinks ${((rest.lowest - lowest) / H).toFixed(4)} body heights into the floor`);
      const last = sampleClip(asset, spawn).at(-1), idleSamples = sampleClip(asset, idle, 1)[0];
      for (const bone of asset.bones.values()) {
        assert.ok(angleBetween(last.local.get(bone), idleSamples.local.get(bone)) < 3 * Math.PI / 180, `${bone.name} ends ${(angleBetween(last.local.get(bone), idleSamples.local.get(bone)) * 180 / Math.PI).toFixed(2)} degrees from the idle pose`);
      }
      assert.ok(Math.abs(last.rootY - idleSamples.rootY) < 1e-4, `the Root ends ${(last.rootY - idleSamples.rootY).toFixed(4)} from the idle height`);
      assert.ok(asset.report.clips['monster-spawn'].measured.idleMatch.maxJointDegrees < 3);
    });

    it('carries a one-shot monster-knockdown of 1.2 s that seams cleanly to monster-getup and rests on the floor in a held lie from 0.62', () => {
      const knock = clips.get('monster-knockdown');
      assert.ok(knock, 'monster-knockdown exists');
      assert.ok(Math.abs(knock.duration - 1.2) < 0.02, `duration ${knock.duration}`);
      assert.equal(asset.report.clips['monster-knockdown'].loop, false);
      const frames = Math.round(knock.duration * FPS);
      let lowest = Infinity, lowestAll = Infinity;
      for (let f = 0; f <= frames; f += 2) { const e = extremes(asset, knock, f / FPS); lowest = Math.min(lowest, e.lowest); lowestAll = Math.min(lowestAll, e.lowestAll); }
      // Nothing under the floor by more than 1 cm at the manifest scale (the contract), measured on every 5th skinned vertex against the rest pose's same vertices.
      assert.ok((rest.lowest - lowest) * manifest.coordinateTransform.scale <= 0.01, `the knockdown sinks ${((rest.lowest - lowest) * manifest.coordinateTransform.scale * 100).toFixed(2)} cm into the floor`);
      assert.ok(lowestAll >= rest.lowestAll - (id === 'actor-ruun-chained-howl' ? 0.002 : 0.02) * H, `ground-bound geometry sinks ${((rest.lowestAll - lowestAll) / H).toFixed(4)} body heights into the floor`);
      const end = extremes(asset, knock, knock.duration);
      assert.ok(end.lowest <= rest.lowest + 0.03 * H, `the held lie hovers ${((end.lowest - rest.lowest) / H).toFixed(4)} body heights above the floor`);
      // Held lie from 0.62 to 1.0: the last five frames are identical (brief's "exactly held" requirement).
      const samples = sampleClip(asset, knock);
      const heldFrom = Math.round(0.62 * (samples.length - 1));
      for (let f = heldFrom; f < samples.length - 1; f++) {
        for (const bone of asset.bones.values()) {
          assert.ok(samples[f].world.get(bone).p.distanceTo(samples.at(-1).world.get(bone).p) < 1e-4, `${bone.name} still moves at frame ${f} (held from 0.62)`);
        }
      }
      // Ground contact by 0.45: the lowest skinned vertex reaches the rest ground by then.
      const contactFrame = Math.round(0.45 * frames);
      const contactLowest = extremes(asset, knock, contactFrame / FPS).lowest;
      assert.ok(contactLowest <= rest.lowest + 0.03 * H, `ground contact not reached by 0.45 (lowest ${((contactLowest - rest.lowest) / H).toFixed(4)} H)`);
    });

    it('carries a one-shot monster-getup of 1.6 s that starts on the knockdown\'s last frame and ends within 3 degrees of idle', () => {
      const getup = clips.get('monster-getup'), knock = clips.get('monster-knockdown'), idle = clips.get('monster-idle');
      assert.ok(getup, 'monster-getup exists');
      assert.ok(Math.abs(getup.duration - 1.6) < 0.02, `duration ${getup.duration}`);
      assert.equal(asset.report.clips['monster-getup'].loop, false);
      // Seam continuity: frame 0 of getup has the knockdown's last controls, so both clips hold the same keys: the only difference left is the float32
      // encode / decode round trip (angleTo of two identical float32 quaternions reads ~0.02 degrees through acos), far below the contract's 0.5 degrees.
      const getupFirst = sampleClip(asset, getup, 1)[0], knockLast = sampleClip(asset, knock).at(-1);
      const seamJoints = [...asset.bones.values()].map(bone => angleBetween(getupFirst.local.get(bone), knockLast.local.get(bone)) * 180 / Math.PI);
      const seamMaxDeg = Math.max(...seamJoints);
      assert.ok(seamMaxDeg < 0.05, `getup frame 0 differs from knockdown last by ${seamMaxDeg.toFixed(3)} degrees (max joint ${seamJoints.indexOf(seamMaxDeg)})`);
      const seamRoot = getupFirst.rootY - knockLast.rootY;
      assert.ok(Math.abs(seamRoot) < 1e-6, `getup Root differs from knockdown by ${seamRoot} units`);
      // Floor guard: the knockdown and the get-up rest exactly on the ground and never sink through it (well under 1 cm at the manifest scale);
      // a crouched idle that itself rests a little under the rest ground (the toad's) is the only floor the get-up may follow down.
      // The idle's own first pose may rest a little under the rest ground (the colossal Crowned Beast's paws, the toad's belly): measured on every vertex, that is the floor the get-up ends on.
      const frames = Math.round(getup.duration * FPS), floor = Math.min(rest.lowest, extremes(asset, idle, 0, 1).lowest);
      let lowest = Infinity;
      for (let f = 0; f <= frames; f += 2) lowest = Math.min(lowest, extremes(asset, getup, f / FPS).lowest);
      assert.ok((floor - lowest) * manifest.coordinateTransform.scale <= 0.01, `getup sinks ${((floor - lowest) * manifest.coordinateTransform.scale * 100).toFixed(2)} cm into the floor`);
      // Idle blend over the last quarter: the last frame IS the idle clip's first frame (angles and Root height), well inside the contract's 3 degrees / 1 cm.
      const last = sampleClip(asset, getup).at(-1), idleFirst = sampleClip(asset, idle, 1)[0];
      const idleJoints = [...asset.bones.values()].map(bone => angleBetween(last.local.get(bone), idleFirst.local.get(bone)) * 180 / Math.PI);
      const idleMaxDeg = Math.max(...idleJoints);
      assert.ok(idleMaxDeg < 0.05, `${id} getup ends ${idleMaxDeg.toFixed(2)} degrees from idle`);
      assert.ok(Math.abs(last.rootY - idleFirst.rootY) < 1e-6, `getup Root ends ${(last.rootY - idleFirst.rootY).toFixed(6)} from idle height`);
      for (const bone of asset.bones.values()) assert.ok(last.world.get(bone).p.distanceTo(idleFirst.world.get(bone).p) < 1e-4 * H, `${bone.name} ends off the idle pose`);
    });

    it('rolls back to sternal, rises without popping and ends upright: hips unrolled by 0.3, no joint travels more than a third of the body height in one frame', () => {
      const getup = clips.get('monster-getup'), hips = asset.bones.get(sanitize(asset.report.rig.hips));
      const hipsQuaternion = (clip, time) => {
        poseTo(asset, clip, time);
        const q = hips.getWorldQuaternion(new THREE.Quaternion());
        poseTo(asset, { tracks: [] }, 0);
        return q;
      };
      const rollAt = time => hipsQuaternion(getup, time).angleTo(asset.restWorldQuaternion) * 180 / Math.PI;
      const frames = Math.round(getup.duration * FPS), idleStart = hipsQuaternion(clips.get('monster-idle'), 0);
      assert.ok(rollAt(0) > 40, `the get-up starts lying (hips ${rollAt(0).toFixed(0)} degrees from standing)`);
      assert.ok(rollAt(0.3 * getup.duration) < 25, `rolled back to sternal by 0.3 (hips ${rollAt(0.3 * getup.duration).toFixed(0)} degrees from standing)`);
      const endTurn = hipsQuaternion(getup, getup.duration).angleTo(idleStart) * 180 / Math.PI;
      assert.ok(endTurn < 0.05, `ends on the idle's hips orientation (${endTurn.toFixed(3)} degrees apart)`);
      const samples = sampleClip(asset, getup);
      for (let f = 1; f < samples.length; f++) {
        for (const bone of asset.bones.values()) {
          const step = samples[f].world.get(bone).p.distanceTo(samples[f - 1].world.get(bone).p);
          // Bodies with kneeFloor legs (Ruun) slide a bent knee along the floor circle of its bone, which moves it up to ~0.4 body heights between two frames.
          assert.ok(step < (id === 'actor-ruun-chained-howl' ? 0.4 : 1 / 3) * H, `${bone.name} jumps ${(step / H).toFixed(2)} body heights between frames ${f - 1} and ${f}`);
        }
      }
    });

    it('is mapped in its playtest manifest with the synced hash, in-place root motion and a blocked evidence status', () => {
      assert.ok(manifest, `${id} has a playtest manifest entry`);
      assert.equal(manifest.outputHash, sha256(asset.outputBytes));
      for (const slot of ['monster-death', 'monster-spawn', 'monster-knockdown', 'monster-getup']) {
        assert.equal(manifest.actionToClipMapping[slot], slot, `${slot} not in actionToClipMapping`);
        assert.deepEqual(manifest.rootMotion[slot], { mode: 'in-place', evidenceStatus: 'verified' });
      }
      assert.equal(manifest.evidenceStatus, 'blocked');
    });


    if (WALK_SECONDS[id]) {
      it('walks on an authored ikGait loop with planted feet, keeping the raw Tripo preset only as provenance', () => {
        const walk = clips.get('monster-walk');
        assert.ok(walk, 'monster-walk exists');
        assert.ok(Math.abs(walk.duration - WALK_SECONDS[id]) < 0.02, `duration ${walk.duration}`);
        assert.equal(asset.report.clips['monster-walk'].loop, true);
        assert.ok(clips.has('preset:quadruped:walk'), 'the Tripo preset stays in the GLB');
        assert.equal(asset.report.walkClip.replacedBy, 'monster-walk');
        assert.equal(manifest.actionToClipMapping['monster-walk'], 'monster-walk');
        const samples = sampleClip(asset, walk), frames = samples.length - 1;
        for (const bone of asset.bones.values()) {
          assert.ok(samples[0].world.get(bone).p.distanceTo(samples.at(-1).world.get(bone).p) < 1e-5, `${bone.name} position seam`);
          assert.ok(samples[0].local.get(bone).angleTo(samples.at(-1).local.get(bone)) < 1e-4, `${bone.name} rotation seam`);
        }
        const step = (a, b) => [...asset.bones.values()].reduce((sum, bone) => sum + a.world.get(bone).p.distanceTo(b.world.get(bone).p), 0);
        const interior = []; for (let f = 1; f < frames; f++) interior.push(step(samples[f - 1], samples[f]));
        assert.ok(step(samples.at(-2), samples[1]) / 2 <= Math.max(...interior) * 1.3, 'the wrap step is not an outlier');
        // Planting: a planted foot moves backwards relative to the hips at one constant speed (the body's ground speed) through its stance.
        const hips = asset.bones.get(sanitize(asset.report.rig.hips)), speeds = [];
        let stanceFrames = 0;
        for (const chain of Object.values(asset.report.rig.legs)) {
          const foot = asset.bones.get(sanitize(chain.at(-1))), restY = asset.restWorld.get(foot).y;
          const rel = samples.map(s => s.world.get(foot).p.clone().sub(s.world.get(hips).p).dot(asset.forward));
          const minY = Math.min(...samples.map(s => s.world.get(foot).p.y));
          const onGround = samples.map(s => s.world.get(foot).p.y - minY < 0.004 * H);
          for (let f = 0; f < frames; f++) {
            if (onGround[f] && onGround[f + 1]) { speeds.push((rel[f + 1] - rel[f]) * FPS); stanceFrames++; }
          }
          for (const s of samples) assert.ok(s.world.get(foot).p.y >= restY - 0.01 * H, 'a foot never sinks into the ground');
        }
        const planted = -speeds.reduce((a, b) => a + b, 0) / speeds.length;
        assert.ok(planted > 0, 'feet move backwards under the body');
        const slide = speeds.map(speed => Math.abs(speed + planted) / planted);
        assert.ok(Math.max(...slide) < 0.06, `largest foot slide ${(100 * Math.max(...slide)).toFixed(1)}% of the ground speed`);
        assert.ok(slide.reduce((a, b) => a + b, 0) / slide.length < 0.03, 'mean foot slide stays under 3%');
        // Ruun's near-straight legs stop short of the floor target for part of the stance, so only ~0.18 of the leg-frames sit within 0.004 body heights of the sole.
        assert.ok(stanceFrames / (4 * frames) > 0.15, `feet are planted ${(100 * stanceFrames / (4 * frames)).toFixed(0)}% of the cycle`);
      });
    }

    if (SIX_PRESET_REPLACED.includes(id)) {
      it('reports its planting speed so MonsterAnimationProfiles can bind walkRef to it', () => {
        const planting = asset.report.clips['monster-walk'].measured.planting;
        assert.ok(planting.plantedSpeedUnitsPerSecond > 0.3 && planting.plantedSpeedUnitsPerSecond < 1.6);
        assert.ok(planting.maxSlidePercent < 6, `report slide ${planting.maxSlidePercent}%`);
      });
    }
  });
}

// ---------------------------------------------------------------------------------------------
// The Grove boss (actor-grove-hollowheart, biped rig v1.0) and the blighted rootling variant
// ---------------------------------------------------------------------------------------------
const HOLLOWHEART = 'actor-grove-hollowheart', BLIGHTED = 'actor-grove-blighted-rootling';
/** The fourteen slots of a tail-less monster, in the order the authoring kit writes them, with their authored seconds and loop flags. */
const BOSS_SLOTS = {
  'monster-idle': [3, true], 'monster-walk': [1.2, true], 'monster-run': [0.6, true], 'monster-slash': [1.2, false], 'monster-shoot': [1.4, false], 'monster-jump': [1.6, false],
  'monster-hurt': [0.7, false], 'monster-turn': [1, true], 'monster-dive': [1, false], 'monster-roar': [2, false], 'monster-death': [1.6, false], 'monster-spawn': [1.4, false],
  'monster-knockdown': [1.2, false], 'monster-getup': [1.6, false],
};

describe(`${HOLLOWHEART} biped clips`, () => {
  let report, gltf, skinned, bones, rest, manifest, clips;
  const dir = `${root}/asset-source/generated/${HOLLOWHEART}-runtime-01`;
  const poseAt = (clip, time) => {
    for (const [bone, pose] of rest) { bone.position.copy(pose.p); bone.quaternion.copy(pose.q); }
    for (const track of clip.tracks) {
      const dot = track.name.lastIndexOf('.'), bone = bones.get(track.name.slice(0, dot)), values = track.createInterpolant().evaluate(time);
      if (track.name.slice(dot + 1) === 'quaternion') bone.quaternion.fromArray(values).normalize(); else bone.position.fromArray(values);
    }
    gltf.scene.updateMatrixWorld(true);
    skinned.skeleton.update();
  };
  /** Lowest skinned vertex height (every 5th vertex of the real skinned mesh, body only: vertices dominated by the Root bone are ground attachments). */
  const lowest = () => {
    const vertex = new THREE.Vector3(), { skinIndex, skinWeight } = skinned.geometry.attributes, rootIndex = skinned.skeleton.bones.findIndex(bone => bone.name === sanitize(report.rootBone));
    let best = Infinity;
    for (let i = 0; i < skinned.geometry.attributes.position.count; i += 5) {
      let dominant = 0;
      for (let k = 1; k < 4; k++) if (skinWeight.getComponent(i, k) > skinWeight.getComponent(i, dominant)) dominant = k;
      if (skinIndex.getComponent(i, dominant) === rootIndex) continue;
      best = Math.min(best, skinned.getVertexPosition(i, vertex).applyMatrix4(skinned.matrixWorld).y);
    }
    return best;
  };
  const angle = (a, b) => a.clone().normalize().angleTo(b.clone().normalize());

  before(async () => {
    manifest = JSON.parse(await readFile(`${root}/asset-source/playtests/grove.json`, 'utf8')).find(entry => entry.id === HOLLOWHEART);
    report = JSON.parse(await readFile(`${dir}/clips-report.json`, 'utf8'));
    gltf = await new GLTFLoader().register(() => ({ name: 'pose-only-material', loadMaterial: () => Promise.resolve(new THREE.MeshBasicMaterial()) })).parseAsync(toArrayBuffer(await readFile(`${root}/${manifest.runtimeUrl.replace(/^\//, '')}`)), '');
    gltf.scene.traverse(object => { if (object.isSkinnedMesh) skinned = object; });
    assert.ok(skinned, 'runtime GLB must contain a skinned mesh');
    bones = new Map(skinned.skeleton.bones.map(bone => [bone.name, bone]));
    rest = new Map([...bones.values()].map(bone => [bone, { p: bone.position.clone(), q: bone.quaternion.clone() }]));
    clips = new Map(gltf.animations.map(clip => [clip.name, clip]));
    gltf.scene.updateMatrixWorld(true);
  });

  it('preserves the authored lifecycle and locomotion durations and loop flags', () => {
    for (const [slot, [seconds, loop]] of Object.entries(BOSS_SLOTS)) {
      assert.ok(Math.abs(clips.get(slot).duration - seconds) < 0.02, `${slot} lasts ${clips.get(slot).duration}`);
      assert.equal(report.slots[slot].loop, loop, `${slot} loop flag`);
    }
  });


  it('keeps every clip in place: the Hip never drifts more than 1% of the body height and loops close without a seam', () => {
    for (const [slot, entry] of Object.entries(report.slots)) {
      assert.ok(entry.measured.maxHipsDriftUnits <= 0.01 * report.body.heightUnits, `${slot} hips drift ${entry.measured.maxHipsDriftUnits}`);
      if (entry.loop) assert.ok(entry.measured.loopClosureStepDegrees <= 20, `${slot} loop seam ${entry.measured.loopClosureStepDegrees} degrees`);
    }
  });

  it('death collapses onto the ground without passing through it and ends on a held pose; the floor guard holds every frame', () => {
    const death = clips.get('monster-death');
    poseAt({ tracks: [] }, 0);
    const ground = lowest();
    let worst = Infinity;
    for (let f = 0; f <= Math.round(death.duration * FPS); f += 2) { poseAt(death, f / FPS); worst = Math.min(worst, lowest()); }
    const H = report.body.heightUnits;
    assert.ok(worst >= ground - 0.0105 * H, `death sinks ${((ground - worst) / H).toFixed(4)} body heights`);
    poseAt(death, death.duration);
    assert.ok(lowest() - ground <= 0.03 * H, `death hovers ${((lowest() - ground) / H).toFixed(4)} body heights`);
    assert.ok(report.slots['monster-death'].measured.heldFromTime <= 0.9);
    assert.ok(report.slots['monster-death'].measured.floorContactBodyHeights.lowestOverClip >= -0.0105);
  });

  it('spawn starts crouched and ends within 3 degrees of the first frame of the idle clip', () => {
    const spawn = clips.get('monster-spawn'), idle = clips.get('monster-idle');
    poseAt(idle, 0);
    const idleLocal = new Map([...bones.values()].map(bone => [bone, bone.quaternion.clone()]));
    const idleHigh = skinned.geometry.boundingBox ?? (skinned.geometry.computeBoundingBox(), skinned.geometry.boundingBox);
    assert.ok(idleHigh.max.y > 0);
    poseAt(spawn, spawn.duration);
    for (const bone of bones.values()) assert.ok(angle(bone.quaternion, idleLocal.get(bone)) < 3 * Math.PI / 180, `${bone.name} ends ${(angle(bone.quaternion, idleLocal.get(bone)) * 180 / Math.PI).toFixed(2)} degrees from idle`);
    assert.ok(report.slots['monster-spawn'].measured.idleMatch.maxJointDegrees < 3);
    poseAt(spawn, 0);
    const crouched = lowest();
    poseAt(idle, 0);
    assert.ok(crouched >= lowest() - 0.02 * report.body.heightUnits, 'the entrance never sinks below the idle sole');
  });

  it('knockdown / getup: knockdown rests on the floor in a held lie from 0.62, getup starts on the knockdown\'s last frame and ends within 3 degrees of idle', () => {
    const knock = clips.get('monster-knockdown'), getup = clips.get('monster-getup'), idle = clips.get('monster-idle');
    poseAt({ tracks: [] }, 0);
    const ground = lowest();
    let worst = Infinity;
    for (let f = 0; f <= Math.round(knock.duration * FPS); f += 2) { poseAt(knock, f / FPS); worst = Math.min(worst, lowest()); }
    const H = report.body.heightUnits;
    assert.ok(worst >= ground - 0.0105 * H, `knockdown sinks ${((ground - worst) / H).toFixed(4)} body heights`);
    poseAt(knock, knock.duration);
    assert.ok(lowest() - ground <= 0.03 * H, `knockdown hovers ${((lowest() - ground) / H).toFixed(4)} body heights`);
    assert.ok(report.slots['monster-knockdown'].measured.heldFromTime <= 0.7);
    assert.ok(report.slots['monster-knockdown'].measured.floorContactBodyHeights.lowestOverClip >= -0.0105);
    // Seam: getup frame 0 = knockdown last frame.
    poseAt(knock, knock.duration);
    const knockLast = new Map([...bones.values()].map(bone => [bone, { p: bone.position.clone(), q: bone.quaternion.clone() }]));
    poseAt(getup, 0);
    const seamMaxDeg = Math.max(...[...bones.values()].map(bone => angle(bone.quaternion, knockLast.get(bone).q))) * 180 / Math.PI;
    assert.ok(seamMaxDeg < 0.5, `getup frame 0 differs from knockdown last by ${seamMaxDeg.toFixed(3)} degrees`);
    // Idle blend: getup's last frame is within 3 degrees of the idle clip's first frame.
    poseAt(idle, 0);
    const idleLocal = new Map([...bones.values()].map(bone => [bone, bone.quaternion.clone()]));
    poseAt(getup, getup.duration);
    for (const bone of bones.values()) assert.ok(angle(bone.quaternion, idleLocal.get(bone)) < 3 * Math.PI / 180, `${bone.name} ends ${(angle(bone.quaternion, idleLocal.get(bone)) * 180 / Math.PI).toFixed(2)} degrees from idle`);
    assert.ok(report.slots['monster-getup'].measured.idleMatch.maxJointDegrees < 3);
  });


  it('maps a hash-verified native Grove boss with in-place lifecycle clips, a valid cast bone and the authored standing height', async () => {
    assert.ok(manifest, 'grove.json has an entry for the boss');
    assert.equal(manifest.actorId, 'grove-hollowheart');
    assert.equal(manifest.outputHash, sha256(await readFile(`${root}/${manifest.runtimeUrl.replace(/^\//, '')}`)));
    assert.equal(manifest.evidenceStatus, 'blocked');
    assert.equal(manifest.rigFamily, 'biped');
    for (const slot of Object.keys(BOSS_SLOTS)) assert.deepEqual(manifest.rootMotion[slot], { mode: 'in-place', evidenceStatus: 'verified' });
    assert.ok(bones.has(sanitize(manifest.castSocketBone)), `${manifest.castSocketBone} is a bone of the rig`);
    poseAt({ tracks: [] }, 0);
    const box = new THREE.Box3().setFromObject(skinned);
    const height = (box.max.y - box.min.y) * manifest.coordinateTransform.scale;
    assert.ok(Math.abs(height - 3.5) < 0.25, `boss stands ${height.toFixed(2)} m tall`);
  });
});

describe(`${BLIGHTED} (the rootling variant of stage 2)`, () => {
  it('is rebuilt byte for byte from the rootling runtime GLB, so it can never be stale', async () => {
    const { buildVariant } = await import('../../scripts/assets/build-grove-blighted-variant.mjs');
    const built = buildVariant({ write: false });
    const dir = `${root}/asset-source/generated/${BLIGHTED}-runtime-01`;
    const bytes = await readFile(`${dir}/${BLIGHTED}-animated.glb`);
    assert.equal(sha256(bytes), sha256(built.bytes));
    assert.deepEqual(JSON.parse(await readFile(`${dir}/clips-report.json`, 'utf8')), built.clipsReport);
    assert.deepEqual(JSON.parse(await readFile(`${dir}/provenance.json`, 'utf8')), built.provenance);
    const manifest = JSON.parse(await readFile(`${root}/asset-source/playtests/grove.json`, 'utf8'));
    const entry = manifest.find(item => item.id === BLIGHTED), rootling = manifest.find(item => item.id === 'actor-grove-rootling');
    assert.equal(entry.actorId, 'grove-blighted');
    assert.equal(entry.outputHash, sha256(await readFile(`${root}/${entry.runtimeUrl.replace(/^\//, '')}`)));
    assert.equal(entry.evidenceStatus, 'blocked');
    // Drawn a quarter larger than the 1.6 m sparring partner (2.0 m): same facing, scale 1.25x.
    assert.deepEqual(entry.coordinateTransform.forward, rootling.coordinateTransform.forward);
    assert.ok(Math.abs(entry.coordinateTransform.scale / rootling.coordinateTransform.scale - 1.25) < 0.01);
  });

  it('changes only the material: same geometry, skeleton, textures and animation bytes as the rootling, a darker base colour and a toxic emissive', async () => {
    const source = await readFile(`${root}/asset-source/generated/actor-grove-rootling-runtime-01/actor-grove-rootling-animated.glb`);
    const variant = await readFile(`${root}/asset-source/generated/${BLIGHTED}-runtime-01/${BLIGHTED}-animated.glb`);
    const a = glbJson(source), b = glbJson(variant);
    const binary = bytes => bytes.subarray(20 + ((bytes.readUInt32LE(12) + 3) & ~3) + 8);
    assert.ok(binary(source).equals(binary(variant)), 'the binary chunk is identical');
    const { materials: ma, ...restA } = a, { materials: mb, ...restB } = b;
    assert.deepEqual(restB, restA);
    assert.deepEqual(mb[0].pbrMetallicRoughness.baseColorFactor, [0.33, 0.35, 0.32, 1]);
    assert.deepEqual(mb[0].emissiveFactor, [0.03, 0.075, 0.012]);
    assert.equal(ma[0].emissiveFactor, undefined);
  });
});
