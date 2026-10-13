import assert from 'node:assert/strict';
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
};
const GROUNDED = ['monster-idle', 'monster-slash', 'monster-shoot', 'monster-hurt', 'monster-roar', 'monster-tail'];
const ASSETS = ['actor-ember-boar', 'actor-frost-sap-stalker', 'actor-root-rammer']
  .filter((id, index) => index < 2 || existsSync(`${root}/asset-source/generated/${id}-runtime-01/${id}-animated.glb`));
const EXPECTED_HEAD = { 'actor-ember-boar': '+Z', 'actor-frost-sap-stalker': '-Z', 'actor-root-rammer': '+X' };

const sanitize = name => THREE.PropertyBinding.sanitizeNodeName(name);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const toArrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const glbJson = bytes => JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)).trim());

async function loadAsset(id) {
  const dir = `${root}/asset-source/generated/${id}-runtime-01`;
  const [inputBytes, outputBytes, report] = await Promise.all([
    readFile(`${dir}/${id}.glb`), readFile(`${dir}/${id}-animated.glb`), readFile(`${dir}/clips-report.json`, 'utf8').then(JSON.parse),
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
  return { id, dir, inputBytes, outputBytes, report, gltf, bones, rest, restWorld, skinned, forward, left };
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
      assert.equal(asset.gltf.animations.length, 1 + Object.keys(REQUIRED).length);
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
      assert.equal(report.output.sha256, sha256(asset.outputBytes));
      assert.equal(report.output.bytes, asset.outputBytes.length);
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
        if (name === 'monster-jump' || name === 'monster-run') assert.ok(maxVertical > 0.01, `${name} should bounce the Root`);
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
        for (let f = 2; f < frames.length - 3; f++) {
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
      for (const name of Object.keys(REQUIRED)) {
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
