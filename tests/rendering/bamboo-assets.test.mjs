import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, it, before } from 'node:test';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DEG, Rig, parseGlb, readAccessorAny, readAnimation } from '../../scripts/assets/creature-rig-kit.mjs';

// Blood Bamboo Valley playtest assets (asset-source/playtests/bamboo.json, scripts/assets/build-bamboo-manifest.mjs): Koro the Branchbreaker, Asha, Tali,
// Marek, the two Ash Hunter camp actors (melee trapper, ranged netter), the bamboo grove, the Ash Hunters' camp, the ancient shrine and the Black Sap jaw trap.
// Checks the manifest, the runtime hashes, the clip slots and extras, in-place playback, grounded feet, stated sizes, the rig repairs, byte-deterministic
// authoring and the Tripo credit ledger. Nothing here is release evidence: every entry stays evidence-blocked.
// GLTFLoader parses the real GLBs in Node (a material-only plugin skips texture decoding, which needs DOM image APIs).
const root = process.cwd();
const MANIFEST = 'asset-source/playtests/bamboo.json';
const LOG = 'asset-source/generated/bamboo-tripo-log.jsonl';
// Act I assets were approved to 1,200 credits; the Wave 2 coordinator decision 1 (native hunter actors) added a separate 450-credit ceiling for the two hunter jobs,
// so the shared bamboo log may total at most 1,650 and the hunter rows at most 450 (checked separately below).
const CREDIT_CEILING = 1650;
const HUNTER_CREDIT_CEILING = 450;
const MONSTER = ['monster-idle', 'monster-walk', 'monster-run', 'monster-slash', 'monster-shoot', 'monster-jump', 'monster-hurt', 'monster-turn', 'monster-dive', 'monster-roar', 'monster-death', 'monster-spawn', 'monster-knockdown', 'monster-getup'];
const TOLERANCE = 0.25;
/** A skinned vertex may dip this far (metres, after scaling) below the ground in any clip: skin bulge around planted joints. */
const SINK_TOLERANCE = 0.15;

const CHARACTERS = {
  // Biped rig v1.0 without a tail chain: twelve monster slots. Five are Tripo presets (idle, walk, run, slash, pitch), seven authored.
  'actor-koro-branchbreaker': { actorId: 'bamboo-koro-branchbreaker', slots: MONSTER, height: 1.5, family: 'creature', task: 'rig' },
  // Felid quadrupeds with a real tail chain: the twelve slots plus the tail sweep (13), and the extras.
  'actor-asha': {
    actorId: 'bamboo-asha', slots: [...MONSTER, 'monster-tail'], shoulder: 1.1, family: 'quadruped',
    extras: ['asha-stalk', 'asha-corrupted-idle', 'asha-stalk-pounce', 'asha-corrupt-slam', 'asha-bamboo-charge', 'asha-cleanse', 'asha-bond-idle'],
  },
  'actor-tali': { actorId: 'bamboo-tali', slots: [...MONSTER, 'monster-tail'], shoulder: 0.5, family: 'quadruped', extras: ['tali-play', 'tali-nuzzle'] },
  // Human NPC (Mixamo-spec rig): no slash / shoot / roar slots, four talking idles.
  'actor-marek': {
    actorId: 'bamboo-marek', slots: ['monster-idle', 'monster-walk', 'monster-run', 'monster-jump', 'monster-hurt', 'monster-turn', 'monster-dive', 'monster-death', 'monster-spawn', 'monster-knockdown', 'monster-getup'],
    height: 1.78, family: 'creature', extras: ['npc-talk-relaxed', 'npc-talk-explain', 'npc-talk-point', 'npc-talk-guarded'],
  },
  // Ash Hunters of the camp (rig v1.0, Mixamo spec like Marek). The weapon is part of the mesh: the melee pole's tip makes the bounds 0.982 tall (1.894 m for a 1.85 m body).
  // monster slots: idle / walk / run / the attack / hurt / turn, plus death (the knockdown) and spawn (the get-up); extras: the subdued kneel set (and the melee spear jab).
  'actor-camp-hunter-melee': {
    actorId: 'bamboo-camp-hunter-melee', slots: ['monster-idle', 'monster-walk', 'monster-run', 'monster-slash', 'monster-hurt', 'monster-turn', 'monster-death', 'monster-spawn', 'monster-knockdown', 'monster-getup'],
    height: 1.894, family: 'creature', extras: ['hunter-thrust', 'hunter-subdue', 'hunter-kneel-idle'],
  },
  'actor-camp-hunter-ranged': {
    actorId: 'bamboo-camp-hunter-ranged', slots: ['monster-idle', 'monster-walk', 'monster-run', 'monster-shoot', 'monster-hurt', 'monster-turn', 'monster-death', 'monster-spawn', 'monster-knockdown', 'monster-getup'],
    height: 1.72, family: 'creature', extras: ['hunter-subdue', 'hunter-kneel-idle'],
  },
};
// Stated size in metres and the decoration triangle budget (boundary decoration is drawn as hundreds of instances per frame).
const PROPS = {
  'prop-bamboo-grove-cluster': { height: 9, budget: 12000 },
  'prop-hunter-camp': { width: 8, budget: 18000 },
  'prop-ancient-bamboo-shrine': { width: 7, budget: 12000 },
  'prop-black-sap-jaw-trap': { width: 1.2, budget: 9000 },
};
// The reused environment kit (carried verbatim from the earlier manifests) the chapter is built from.
const KIT = ['prop-erya-edge-tree', 'prop-rainforest-canopy-tree', 'prop-greenwake-boulder-cluster', 'prop-canopy-cliff-rock', 'prop-mire-bank-rock', 'prop-canopy-fern-cluster', 'prop-greenwake-rope-bridge', 'prop-hunter-cage', 'prop-greenwake-bramble-wall', 'prop-root-arch', 'prop-hunter-extraction-rig', 'prop-black-sap-filter-drum', 'prop-root-cavern-mouth'];

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const toArrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const sanitize = name => THREE.PropertyBinding.sanitizeNodeName(name);
const localPath = url => `${root}/${url.replace(/^\//, '')}`;
const within = (measured, stated) => Math.abs(measured - stated) <= stated * TOLERANCE;
const readJson = async path => JSON.parse(await readFile(`${root}/${path}`, 'utf8'));

async function loadGlb(url) {
  const bytes = await readFile(localPath(url));
  const gltf = await new GLTFLoader()
    .register(() => ({ name: 'pose-only-material', loadMaterial: () => Promise.resolve(new THREE.MeshBasicMaterial()) }))
    .parseAsync(toArrayBuffer(bytes), '');
  gltf.scene.updateMatrixWorld(true);
  return { bytes, gltf };
}

/** The manifest's coordinateTransform as a matrix: rotation about Y by atan2(forward), uniform scale, origin offset. */
function placement(transform) {
  const angle = Math.atan2(transform.forward.x, transform.forward.z), offset = transform.originOffset ?? { x: 0, y: 0, z: 0 };
  return new THREE.Matrix4().compose(new THREE.Vector3(offset.x, offset.y, offset.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle), new THREE.Vector3(1, 1, 1).multiplyScalar(transform.scale));
}

/** Exact bounds of every bind-pose vertex after the manifest's placement. */
function placedBox(gltf, transform) {
  const matrix = placement(transform), box = new THREE.Box3(), v = new THREE.Vector3();
  gltf.scene.traverse(object => {
    if (!object.isMesh) return;
    const position = object.geometry.attributes.position, local = object.isSkinnedMesh ? new THREE.Matrix4() : object.matrixWorld;
    for (let i = 0; i < position.count; i++) box.expandByPoint(v.fromBufferAttribute(position, i).applyMatrix4(local).applyMatrix4(matrix));
  });
  return box;
}

function triangleCount(gltf) {
  let triangles = 0;
  gltf.scene.traverse(object => { if (object.isMesh) triangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3; });
  return triangles;
}

/** Dominant joint name of every vertex that satisfies `pick(x, y, z)` in a runtime GLB's bind pose. */
async function dominantJoints(path, pick) {
  const { json, bin } = parseGlb(await readFile(`${root}/${path}`));
  const rig = new Rig(json), primitive = json.meshes[0].primitives[0];
  const positions = readAccessorAny(json, bin, primitive.attributes.POSITION), joints = readAccessorAny(json, bin, primitive.attributes.JOINTS_0), weights = readAccessorAny(json, bin, primitive.attributes.WEIGHTS_0);
  const counts = new Map();
  for (let i = 0; i < positions.length / 3; i++) {
    if (!pick(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2])) continue;
    let best = 0;
    for (let k = 1; k < 4; k++) if (weights[i * 4 + k] > weights[i * 4 + best]) best = k;
    const name = rig.nodes[rig.joints[joints[i * 4 + best]]].name;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return { counts, total: [...counts.values()].reduce((a, b) => a + b, 0), skinNames: rig.joints.map(joint => rig.nodes[joint].name) };
}

describe('bamboo.json manifest', { skip: existsSync(`${root}/${MANIFEST}`) ? false : `${MANIFEST} has not been generated yet (scripts/assets/build-bamboo-manifest.mjs)` }, () => {
  let manifest;
  const entry = id => {
    const found = manifest.find(item => item.id === id);
    assert.ok(found, `bamboo.json has no entry ${id}`);
    return found;
  };
  before(async () => { manifest = await readJson(MANIFEST); });

  it('keeps candidate ids unique and all assets evidence-blocked, never verified', () => {
    const ids = manifest.map(item => item.id);
    assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
    for (const item of manifest) assert.equal(item.evidenceStatus, 'blocked', `${item.id} must stay evidence-blocked`);
  });

  it('resolves every environment component to a native prop and covers the chapter kit', () => {
    const environment = entry('blood-bamboo-valley-environment');
    assert.equal(environment.sourceType, 'composed-recipe');
    assert.equal(environment.kind, 'environment');
    assert.equal(environment.runtimeUrl, null);
    for (const id of environment.componentAssetIds) {
      const component = entry(id);
      assert.equal(component.kind, 'prop');
      assert.equal(component.sourceType, 'native-glb');
    }
    for (const id of [...Object.keys(PROPS), ...KIT]) assert.ok(environment.componentAssetIds.includes(id), `the environment recipe lacks ${id}`);
    assert.equal(new Set(environment.componentAssetIds).size, environment.componentAssetIds.length);
  });

  it('every runtimeUrl resolves to a local GLB whose sha256 matches outputHash', async () => {
    for (const item of manifest) {
      if (item.sourceType === 'composed-recipe') { assert.equal(item.runtimeUrl, null); continue; }
      assert.equal(typeof item.runtimeUrl, 'string', `${item.id} needs a runtime GLB`);
      assert.match(item.outputHash ?? '', /^[0-9a-f]{64}$/, `${item.id} needs a sha256 outputHash`);
      const path = localPath(item.runtimeUrl);
      assert.ok(existsSync(path), `${item.id}: ${item.runtimeUrl} does not exist`);
      assert.equal(sha256(await readFile(path)), item.outputHash, `${item.id}: outputHash does not match the file`);
    }
  });

  describe('Tripo ledger', () => {
    let rows;
    before(async () => { rows = (await readFile(`${root}/${LOG}`, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); });

    it(`spent at most ${CREDIT_CEILING} credits in total (Act I 1,200 + the 450 hunter ceiling), every task once`, () => {
      const total = rows.reduce((sum, row) => sum + (row.credits ?? 0), 0);
      assert.ok(total <= CREDIT_CEILING, `${total} credits exceed the ${CREDIT_CEILING} ceiling`);
      for (const row of rows) { assert.match(row.task_id, /^[0-9a-f-]{36}$/); assert.ok(Number.isInteger(row.credits), `${row.task_id} has no credit cost`); }
      assert.equal(new Set(rows.map(row => row.task_id)).size, rows.length, 'a task is logged twice');
    });

    it('logs the full chain of every built asset and the manifest source task is in it', () => {
      const stepsOf = id => new Set(rows.filter(row => row.asset === id).map(row => row.step));
      for (const id of Object.keys(CHARACTERS)) {
        for (const step of ['concept', 'model', 'decimate', 'check', 'rig', 'anim-a']) assert.ok(stepsOf(id).has(step), `${id}: the log lacks ${step}`);
        assert.ok(rows.some(row => row.task_id === entry(id).tripoSourceTask && row.step === 'rig'), `${id}: the manifest's tripoSourceTask is not its rig task`);
      }
      for (const id of Object.keys(PROPS)) {
        for (const step of ['concept', 'model', 'decimate']) assert.ok(stepsOf(id).has(step), `${id}: the log lacks ${step}`);
        assert.ok(rows.some(row => row.task_id === entry(id).tripoSourceTask), `${id}: the manifest's tripoSourceTask is not in the log`);
      }
    });

    it('documents the rejected bamboo grove concept and the discarded camp decimation instead of hiding them', async () => {
      assert.ok(existsSync(`${root}/asset-source/generated/prop-bamboo-grove-cluster-concept-01/result.json`), 'the cropped first grove concept is kept as evidence');
      assert.ok(existsSync(`${root}/asset-source/generated/prop-bamboo-grove-cluster-concept-02/result.json`));
      const camp = await readJson('asset-source/generated/prop-hunter-camp-runtime-01/provenance.json');
      assert.match(camp.inputs.base.path, /prop-hunter-camp-model-01/, 'the camp is built from the high-poly model, not from the collapsed Tripo decimation');
    });
  });

  describe('characters', () => {
    for (const [id, stated] of Object.entries(CHARACTERS)) {
      describe(id, () => {
        let item, loaded, report, skinned;
        before(async () => {
          item = entry(id);
          loaded = await loadGlb(item.runtimeUrl);
          report = await readJson(item.provenance);
          loaded.gltf.scene.traverse(object => { if (object.isSkinnedMesh) skinned = object; });
        });

        it('maps exactly the engine slots and extras to native named clips, in place', () => {
          assert.equal(item.actorId, stated.actorId);
          assert.equal(item.kind, 'character');
          assert.equal(item.sourceType, 'native-glb');
          const names = new Set(loaded.gltf.animations.map(clip => clip.name));
          for (const [action, clipName] of Object.entries(item.actionToClipMapping)) {
            assert.ok(names.has(clipName), `${id}: clip ${clipName} for ${action} is not in the GLB (has ${[...names].join(', ')})`);
            assert.ok(loaded.gltf.animations.find(clip => clip.name === clipName).duration > 0.2, `${id}: ${clipName} is empty`);
            assert.equal(item.rootMotion[action]?.mode, 'in-place', `${id}: ${action} root motion must be declared in-place`);
            assert.equal(item.rootMotion[action]?.evidenceStatus, 'verified');
          }
        });

        it('exposes the castSocketBone node', () => {
          assert.ok(item.castSocketBone, `${id} needs castSocketBone`);
          const bone = loaded.gltf.scene.getObjectByName(sanitize(item.castSocketBone)) ?? loaded.gltf.scene.getObjectByName(item.castSocketBone);
          assert.ok(bone?.isBone, `${id}: ${item.castSocketBone} is not a bone of the rig`);
        });

        it('records how every clip was produced', () => {
          for (const action of Object.keys(item.actionToClipMapping)) {
            const produced = action.startsWith('wild-crown:') ? report.attacks?.[action.slice('wild-crown:'.length)] : report.slots?.[action] ?? report.clips?.[action];
            assert.ok(produced, `${id}: clips-report has no ${action}`);
            if (report.slots) assert.ok(['preset', 'preset-conditioned', 'authored'].includes(produced.produced), `${id}: ${action} produced=${produced.produced}`);
            assert.ok(produced.durationSeconds > 0);
          }
        });

        it('plays every slot clip in place and keeps the body on the ground plane', () => {
          assert.ok(skinned, 'runtime GLB must contain a skinned mesh');
          const anchor = report.inPlaceAnchorBone ?? report.rig.hips;
          const bone = skinned.skeleton.bones.find(candidate => candidate.name === sanitize(anchor));
          assert.ok(bone, `anchor bone ${anchor} missing`);
          const box = placedBox(loaded.gltf, item.coordinateTransform), scale = item.coordinateTransform.scale;
          const span = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) / scale;
          const mixer = new THREE.AnimationMixer(loaded.gltf.scene), vertex = new THREE.Vector3();
          const rest = bone.getWorldPosition(new THREE.Vector3());
          for (const action of Object.keys(item.actionToClipMapping)) {
            const clip = loaded.gltf.animations.find(candidate => candidate.name === item.actionToClipMapping[action]);
            const playing = mixer.clipAction(clip);
            playing.play();
            let worstDrift = 0, lowest = Infinity;
            for (let step = 0; step <= 12; step++) {
              playing.time = clip.duration * step / 12;
              mixer.update(0);
              loaded.gltf.scene.updateMatrixWorld(true);
              skinned.skeleton.update();
              const position = bone.getWorldPosition(new THREE.Vector3());
              worstDrift = Math.max(worstDrift, Math.hypot(position.x - rest.x, position.z - rest.z));
              for (let i = 0; i < skinned.geometry.attributes.position.count; i += 7) {
                skinned.getVertexPosition(i, vertex).applyMatrix4(skinned.matrixWorld);
                lowest = Math.min(lowest, vertex.y);
              }
            }
            playing.stop();
            assert.ok(worstDrift <= 0.12 * span, `${id}: ${action} (${clip.name}) drifts ${(worstDrift / span * 100).toFixed(1)}% of the body span from the actor origin`);
            assert.ok(lowest * scale >= -SINK_TOLERANCE, `${id}: ${action} (${clip.name}) sinks ${(-lowest * scale).toFixed(3)} m below the ground`);
          }
        });

        it('has the stated size with its feet on y = 0', () => {
          const placed = placedBox(loaded.gltf, item.coordinateTransform), size = placed.getSize(new THREE.Vector3());
          if (stated.height) assert.ok(within(size.y, stated.height), `${id}: height ${size.y.toFixed(2)} m vs ${stated.height} m`);
          if (stated.shoulder) {
            // Shoulder height: top joints of the front legs plus 5% of the model height (hide / fur), as the manifest builder measures it.
            const matrix = placement(item.coordinateTransform);
            const tops = [report.rig.legs.FL[0], report.rig.legs.FR[0]].map(name => loaded.gltf.scene.getObjectByName(sanitize(name)).getWorldPosition(new THREE.Vector3()).applyMatrix4(matrix).y);
            const shoulder = (tops[0] + tops[1]) / 2 + 0.05 * size.y;
            assert.ok(within(shoulder, stated.shoulder), `${id}: shoulder ${shoulder.toFixed(2)} m vs ${stated.shoulder} m`);
            assert.ok(size.y < stated.shoulder * 2.2, `${id}: ${size.y.toFixed(2)} m tall is out of proportion for a ${stated.shoulder} m shoulder`);
          }
          assert.ok(Math.abs(placed.min.y) <= 0.05, `${id}: base at y = ${placed.min.y.toFixed(3)}`);
        });

        if (stated.family === 'creature') {
          it('closes every looping clip with a seam no bigger than about its own largest frame step', () => {
            // maxInteriorStepDegrees excludes the last frame step, so the seam may exceed it by a fraction of one ordinary step.
            for (const [slot, clip] of Object.entries(report.slots)) {
              if (!clip.loop || clip.produced === 'preset') continue;
              assert.ok(clip.measured.loopClosureStepDegrees <= 1.25 * clip.measured.maxInteriorStepDegrees, `${id}: ${slot} closes with ${clip.measured.loopClosureStepDegrees} degrees against an interior step of ${clip.measured.maxInteriorStepDegrees}`);
            }
          });

          it('ends the entrance on the idle pose and the collapse on a held pose resting on the ground', () => {
            const spawn = report.slots['monster-spawn'].measured, death = report.slots['monster-death'].measured;
            assert.ok(spawn.idleMatch.maxJointDegrees <= 3, `${id}: the entrance ends ${spawn.idleMatch.maxJointDegrees} degrees from the idle`);
            assert.ok(death.heldFromTime <= 0.9, `${id}: the collapse is held only from ${death.heldFromTime}`);
            assert.ok(death.floorContactBodyHeights.final >= -0.011 && death.floorContactBodyHeights.final <= 0.02, `${id}: the collapse rests ${death.floorContactBodyHeights.final} body heights off the ground`);
          });
        }
      });
    }
  });

  describe('Koro, the Branchbreaker attack kit', () => {
    it('maps the boss attacks onto Tripo presets and authored clips like the other biped bosses', async () => {
      const report = await readJson(entry('actor-koro-branchbreaker').provenance);
      for (const slot of ['monster-idle', 'monster-walk', 'monster-run', 'monster-slash', 'monster-shoot']) assert.equal(report.slots[slot].produced, 'preset-conditioned', slot);
      for (const slot of ['monster-jump', 'monster-hurt', 'monster-turn', 'monster-dive', 'monster-roar', 'monster-death', 'monster-spawn']) assert.equal(report.slots[slot].produced, 'authored', slot);
      assert.equal(report.slots['monster-shoot'].source.preset, 'pitch_baseball', 'the rock throw is the pitch preset');
      assert.equal(report.slots['monster-slash'].source.preset, 'slash', 'the log sweep is the slash preset');
    });

    it('rides the tail on the Hip: no tail vertex stays on a leg or hand joint', async () => {
      const record = await readJson('asset-source/generated/actor-koro-branchbreaker-runtime-01/tail-repair.json');
      assert.equal(record.reboundTo, 'Hip');
      assert.ok(record.verticesRebound >= 600, `only ${record.verticesRebound} tail vertices were rebound`);
      const path = 'asset-source/generated/actor-koro-branchbreaker-runtime-01/actor-koro-branchbreaker.glb';
      assert.equal(sha256(await readFile(`${root}/${path}`)), record.output.sha256, 'the base GLB is not the repaired one');
      const { counts, total } = await dominantJoints(path, (x, y, z) => x < -0.1 && y > 0.04 && y < 0.4 && z > -0.35 && z < 0.2);
      assert.ok(total >= 600);
      assert.deepEqual([...counts.keys()], ['Hip'], `tail vertices on ${[...counts.keys()].join(', ')}`);
    });
  });

  describe('Asha', () => {
    let report;
    before(async () => { report = await readJson(entry('actor-asha').provenance); });

    it('plants every foot of the authored walk (maximum stance slide below 3% of the stride)', () => {
      const walk = report.clips['monster-walk'].measured.planting;
      assert.ok(walk.maxSlidePercent <= 3, `walk slide ${walk.maxSlidePercent}%`);
      assert.ok(walk.stanceFraction >= 0.5 && walk.stanceFraction <= 0.7, `stance fraction ${walk.stanceFraction}`);
    });

    it('has a distinct attack window for each of the three phases', () => {
      const phases = { 1: 'asha-stalk-pounce', 2: 'asha-corrupt-slam', 3: 'asha-bamboo-charge' };
      const seen = new Set();
      for (const [phase, clipName] of Object.entries(phases)) {
        const clip = report.clips[clipName], window = clip.attackWindow;
        assert.ok(window, `phase ${phase}: ${clipName} has no attack window`);
        const [anticipation, start, end, recovery] = window.seconds;
        assert.ok(anticipation >= 0.3, `phase ${phase}: only ${anticipation} s of anticipation`);
        assert.ok(start > anticipation - 1e-9 && end > start && recovery > end, `phase ${phase}: window ${window.seconds.join(', ')} is not ordered`);
        assert.ok(end - start >= 0.25, `phase ${phase}: active window ${(end - start).toFixed(3)} s is too short to read`);
        assert.ok(recovery - end >= 0.2, `phase ${phase}: only ${(recovery - end).toFixed(3)} s of recovery`);
        assert.ok(recovery <= clip.durationSeconds + 1e-9, `phase ${phase}: the window ends after the clip`);
        assert.equal(clip.loop, false);
        seen.add(JSON.stringify(window.seconds));
      }
      assert.equal(seen.size, 3, 'the three phase attack windows must differ');
    });

    it('carries the stalk, corrupted idle, cleanse reaction and bonded idle with their loop flags', () => {
      assert.equal(report.clips['asha-stalk'].loop, true);
      assert.equal(report.clips['asha-corrupted-idle'].loop, true);
      assert.equal(report.clips['asha-bond-idle'].loop, true);
      assert.equal(report.clips['asha-cleanse'].loop, false);
      assert.ok(report.clips['asha-cleanse'].durationSeconds >= 2, 'the cleanse reaction needs room to read');
      assert.deepEqual(Object.keys(report.clips['asha-cleanse'].semanticKeyTimes), ['tense', 'shudder', 'peel', 'release', 'calm']);
    });

    it('moves the cleanse and bond poses without breaking contact: the feet stay on their rest spots', () => {
      for (const name of ['asha-cleanse', 'asha-bond-idle', 'asha-corrupted-idle']) {
        for (const [leg, deviation] of Object.entries(report.clips[name].measured.footDeviation)) assert.ok(deviation.maxBodyHeights <= 0.06, `${name}: ${leg} wanders ${deviation.maxBodyHeights} body heights`);
      }
    });

    it('has a complete hind-leg chain on both sides after the rig repair', async () => {
      const record = await readJson('asset-source/generated/actor-asha-runtime-01/skin-repair.json');
      assert.deepEqual(Object.keys(record.chains), ['HL', 'HR']);
      assert.ok(record.chains.HR.verticesMirrored >= 2000, `only ${record.chains.HR.verticesMirrored} right hind vertices carry mirrored weights`);
      const path = 'asset-source/generated/actor-asha-runtime-01/actor-asha.glb';
      assert.equal(sha256(await readFile(`${root}/${path}`)), record.output.sha256, 'the base GLB is not the repaired one');
      const right = await dominantJoints(path, (x, y, z) => x < -0.05 && x > -0.3 && y < 0.1 && z > 0.04);
      const left = await dominantJoints(path, (x, y, z) => x < -0.05 && x > -0.3 && y < 0.1 && z < -0.04);
      for (const [name] of right.counts) assert.match(name, /^repair::HR_/, `a right hind paw vertex is skinned to ${name}`);
      for (const [name] of left.counts) assert.ok(/^repair::HL_|^tripo::0_Left_Limb_/.test(name), `a left hind paw vertex is skinned to ${name}`);
      assert.ok(right.total > 300 && left.total > 300);
      for (const key of ['HL', 'HR']) assert.equal(report.rig.legs[key].length, 4, `${key} chain`);
    });
  });

  describe('Tali', () => {
    it('is a cub of her own: half Asha\'s shoulder height with her own rig, and plants the repaired left hind leg', async () => {
      const report = await readJson(entry('actor-tali').provenance);
      assert.ok(entry('actor-tali').coordinateTransform.scale > 0);
      assert.notEqual(entry('actor-tali').tripoSourceTask, entry('actor-asha').tripoSourceTask);
      assert.ok(report.clips['monster-walk'].measured.planting.maxSlidePercent <= 3);
      const record = await readJson('asset-source/generated/actor-tali-runtime-01/skin-repair.json');
      assert.deepEqual(Object.keys(record.chains), ['HL']);
      assert.ok(record.chains.HL.verticesMirrored >= 2000);
      const path = 'asset-source/generated/actor-tali-runtime-01/actor-tali.glb';
      assert.equal(sha256(await readFile(`${root}/${path}`)), record.output.sha256, 'the base GLB is not the repaired one');
      const left = await dominantJoints(path, (x, y, z) => x < -0.04 && y < 0.1 && z > 0.05);
      for (const [name] of left.counts) assert.match(name, /^repair::HL_|^tripo::1_Left_Limb_0$/, `a left hind paw vertex is skinned to ${name}`);
      assert.deepEqual(report.rig.legs.HL, ['tripo::1_Left_Limb_0', 'repair::HL_1', 'repair::HL_2', 'repair::HL_3', 'repair::HL_4']);
    });
  });

  describe('Marek', () => {
    it('keeps the Mixamo-spec rig and four talking idles that are not monster slots', async () => {
      const item = entry('actor-marek'), report = await readJson(item.provenance);
      assert.equal(item.castSocketBone, 'mixamorig:Head');
      for (const slot of ['monster-slash', 'monster-shoot', 'monster-roar']) assert.equal(item.actionToClipMapping[slot], undefined, `${slot} makes no sense for the NPC`);
      assert.equal(report.slots['npc-talk-relaxed'].produced, 'preset-conditioned');
      assert.equal(report.slots['npc-talk-relaxed'].source.preset, 'standing_relax');
      for (const slot of ['npc-talk-explain', 'npc-talk-point', 'npc-talk-guarded']) assert.equal(report.slots[slot].produced, 'authored', slot);
      assert.equal(report.slots['npc-talk-point'].loop, false);
      for (const slot of ['npc-talk-relaxed', 'npc-talk-explain', 'npc-talk-guarded']) assert.equal(report.slots[slot].loop, true, slot);
      assert.equal(report.slots['monster-walk'].source.preset, 'walk');
    });
  });

  describe('Ash Hunters of the camp', () => {
    // hand = the joint the weapon is bound to; attacks = [clip, ...] with an attack window; concepts = revisions kept on disk (the last one fed the model); anim = credits of the preset batch.
    const HUNTERS = {
      'actor-camp-hunter-melee': { hand: 'mixamorig:LeftHand', attacks: ['monster-slash', 'hunter-thrust'], concepts: 2, anim: 50 },
      'actor-camp-hunter-ranged': { hand: 'mixamorig:RightHand', attacks: ['monster-shoot'], concepts: 4, anim: 40 },
    };
    const AUTHORED = ['monster-hurt', 'monster-turn', 'monster-death', 'monster-spawn', 'hunter-subdue', 'hunter-kneel-idle'];
    const LOOPING = ['monster-idle', 'monster-walk', 'monster-run', 'monster-turn', 'hunter-kneel-idle'];
    let rows;
    before(async () => { rows = (await readFile(`${root}/${LOG}`, 'utf8')).trim().split('\n').map(line => JSON.parse(line)); });

    it(`logs every hunter task once and stays within the ${HUNTER_CREDIT_CEILING} credit hunter ceiling`, () => {
      const mine = rows.filter(row => row.asset in HUNTERS);
      assert.ok(mine.reduce((sum, row) => sum + row.credits, 0) <= HUNTER_CREDIT_CEILING, 'the hunter jobs overspent their ceiling');
      for (const [id, hunter] of Object.entries(HUNTERS)) {
        const credits = step => mine.filter(row => row.asset === id && row.step === step).map(row => row.credits);
        assert.deepEqual(credits('concept'), Array(hunter.concepts).fill(15), `${id}: concept revisions`);
        assert.deepEqual(credits('model'), [70]);
        assert.deepEqual(credits('decimate'), [30]);
        assert.deepEqual(credits('check'), [0]);
        assert.deepEqual(credits('rig'), [25]);
        assert.deepEqual(credits('anim-a'), [hunter.anim]);
        for (let revision = 1; revision <= hunter.concepts; revision++) assert.ok(existsSync(`${root}/asset-source/generated/${id}-concept-0${revision}/result.json`), `${id}: concept ${revision} is kept as evidence`);
      }
    });

    for (const [id, hunter] of Object.entries(HUNTERS)) {
      describe(id, () => {
        let item, report, loaded, json, bin, rig, skinned, mixer;
        const animations = new Map();
        const sampler = name => { if (!animations.has(name)) animations.set(name, readAnimation(rig, bin, name)); return animations.get(name); };
        const clipOf = action => item.actionToClipMapping[action];
        /** Largest local joint rotation difference (degrees) between two clip frames. */
        const difference = (a, b) => Math.max(...rig.joints.map(joint => a.Q[joint].clone().normalize().angleTo(b.Q[joint].clone().normalize()) / DEG));
        const start = action => sampler(clipOf(action)).sample(0), end = action => sampler(clipOf(action)).sample(sampler(clipOf(action)).duration);
        const head = () => skinned.skeleton.bones.find(bone => bone.name === sanitize('mixamorig:Head'));
        /** World height of the head bone (model units) at time t of a clip. */
        const headHeight = (action, t) => {
          const clip = loaded.gltf.animations.find(candidate => candidate.name === clipOf(action)), playing = mixer.clipAction(clip);
          playing.play(); playing.time = t; mixer.update(0);
          loaded.gltf.scene.updateMatrixWorld(true); skinned.skeleton.update();
          const y = head().getWorldPosition(new THREE.Vector3()).y;
          playing.stop();
          return y;
        };
        before(async () => {
          item = entry(id);
          report = await readJson(item.provenance);
          loaded = await loadGlb(item.runtimeUrl);
          ({ json, bin } = parseGlb(loaded.bytes));
          rig = new Rig(json);
          loaded.gltf.scene.traverse(object => { if (object.isSkinnedMesh) skinned = object; });
          mixer = new THREE.AnimationMixer(loaded.gltf.scene);
        });

        it('uses the Mixamo-spec rig and the monster slots the renderer already understands, with no roar, jump or dive', () => {
          assert.equal(item.castSocketBone, 'mixamorig:Head');
          assert.deepEqual(item.coordinateTransform.forward, { x: -1, y: 0, z: 0 });
          for (const slot of ['monster-roar', 'monster-jump', 'monster-dive', 'monster-tail']) assert.equal(item.actionToClipMapping[slot], undefined, `${slot} makes no sense for a human hunter`);
          assert.deepEqual(report.slots['monster-hurt'].semanticKeyTimes, { flinch: 0.2, hold: 0.52 }, 'the hurt clip follows the reaction presenter\'s hurt window');
          assert.equal(report.slots['monster-death'].semanticKeyTimes.rest, 0.82, 'the knockdown is held lying from 0.82');
        });

        it('conditions idle / walk / run from Tripo presets and authors the attacks, reactions and the subdued kneel set', () => {
          for (const [slot, preset] of [['monster-idle', 'idle'], ['monster-walk', 'walk'], ['monster-run', 'run']]) {
            assert.equal(report.slots[slot].produced, 'preset-conditioned', slot);
            assert.equal(report.slots[slot].source.preset, preset, slot);
          }
          if (id.endsWith('melee')) {
            assert.equal(report.slots['monster-slash'].produced, 'preset-conditioned');
            assert.equal(report.slots['monster-slash'].source.preset, 'slash', 'the hook-pole chop rides the slash preset body');
            assert.equal(report.slots['hunter-thrust'].produced, 'authored');
          } else assert.equal(report.slots['monster-shoot'].produced, 'authored', 'aim + shoot is authored around the carried crossbow');
          for (const slot of AUTHORED) assert.equal(report.slots[slot].produced, 'authored', slot);
          for (const [slot, clip] of Object.entries(report.slots)) assert.equal(clip.loop, LOOPING.includes(slot), `${slot} loop flag`);
        });

        it('gives every attack an ordered window with room to read: anticipation, a hit window, recovery', () => {
          for (const attack of hunter.attacks) {
            const clip = report.slots[attack], [anticipation, activeStart, activeEnd, recovery] = clip.attackWindow;
            assert.ok(anticipation >= 0.6 && anticipation <= 0.85, `${attack}: ${anticipation} s of anticipation (the combat windups are 0.7-0.8 s)`);
            assert.ok(activeStart >= anticipation && activeEnd - activeStart >= 0.1, `${attack}: active window ${activeStart}-${activeEnd}`);
            assert.ok(recovery - activeEnd >= 0.25 && recovery <= clip.durationSeconds + 1e-9, `${attack}: recovery ${recovery} s in a ${clip.durationSeconds} s clip`);
            assert.equal(clip.loop, false);
          }
        });

        it('starts every one-shot on the idle\'s first frame and ends the knockdown, get-up and subdue on exactly the pose the next clip starts from', () => {
          const idle = start('monster-idle');
          for (const action of [...hunter.attacks, 'monster-hurt', 'monster-death', 'hunter-subdue']) assert.ok(difference(start(action), idle) <= 0.5, `${action} does not start on the idle pose`);
          for (const action of [...hunter.attacks, 'monster-hurt']) assert.ok(difference(end(action), idle) <= 0.5, `${action} does not end on the idle pose`);
          assert.ok(difference(end('monster-death'), start('monster-spawn')) <= 0.5, 'the get-up must start on the last frame of the knockdown');
          assert.ok(difference(end('monster-spawn'), idle) <= 0.5, 'the get-up must end on the idle pose');
          assert.ok(difference(end('hunter-subdue'), start('hunter-kneel-idle')) <= 0.5, 'the subdue must end on the kneel idle\'s first frame');
        });

        it('is non-lethal in pose: knocked down it lies on the ground and gets up again; subdued it kneels with its head bowed', () => {
          const standing = headHeight('monster-idle', 0), lying = headHeight('monster-death', sampler(clipOf('monster-death')).duration), kneeling = headHeight('hunter-kneel-idle', 0);
          assert.ok(lying <= 0.35 * standing, `lying head at ${(lying / standing * 100).toFixed(0)}% of the standing height`);
          assert.ok(Math.abs(headHeight('monster-spawn', 0) - lying) <= 0.01 * standing, 'the get-up starts where the knockdown ended');
          assert.ok(kneeling >= 0.4 * standing && kneeling <= 0.8 * standing, `kneeling head at ${(kneeling / standing * 100).toFixed(0)}% of the standing height`);
          assert.ok(report.slots['monster-death'].measured.heldFromTime <= 0.9, 'the knockdown ends on a held pose');
          assert.ok(report.slots['hunter-kneel-idle'].measured.floorContactBodyHeights.final >= -0.011, 'the kneel rests on the ground, not through it');
        });

        it('carries its weapon rigidly: the two ends of the weapon keep their distance in every clip', async () => {
          const primitive = json.meshes[0].primitives[0];
          const positions = readAccessorAny(json, bin, primitive.attributes.POSITION), joints = readAccessorAny(json, bin, primitive.attributes.JOINTS_0), weights = readAccessorAny(json, bin, primitive.attributes.WEIGHTS_0);
          const handIndex = rig.joints.indexOf(rig.index(hunter.hand));
          // The weapon's ends: the vertices bound to the holding hand furthest apart along the weapon's rest axis (the pole's butt ring and blade tip; on the
          // crossbow, the root of the bow's right-hand rod beside the fist and the crossbow's front tip above the net drum, 0.22 apart).
          const pole = { from: [0.048, 0, -0.15], to: [0.094, 0.98, -0.228] };
          const poleDistance = (x, y, z) => {
            const ab = pole.to.map((v, i) => v - pole.from[i]), ap = [x - pole.from[0], y - pole.from[1], z - pole.from[2]];
            const t = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2)));
            return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
          };
          const axis = id.endsWith('melee') ? [0.046, 0.98, -0.078] : [0.596, 0.727, 0.342];
          const region = id.endsWith('melee') ? (x, y, z) => poleDistance(x, y, z) <= (y <= 0.5 ? 0.028 : 0.08) : (x, y, z) => z > 0.15 && y > 0.78;
          let low = -1, high = -1, lowest = Infinity, highest = -Infinity;
          for (let i = 0; i < positions.length / 3; i++) {
            const [x, y, z] = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
            if (!region(x, y, z)) continue;
            const along = x * axis[0] + y * axis[1] + z * axis[2];
            if (along < lowest) { lowest = along; low = i; }
            if (along > highest) { highest = along; high = i; }
          }
          for (const index of [low, high]) {
            let best = 0;
            for (let k = 1; k < 4; k++) if (weights[index * 4 + k] > weights[index * 4 + best]) best = k;
            assert.equal(joints[index * 4 + best], handIndex, `${id}: weapon end ${index} is dominated by ${rig.nodes[rig.joints[joints[index * 4 + best]]].name}, not the holding hand`);
          }
          const a = new THREE.Vector3(), b = new THREE.Vector3(), restLength = new THREE.Vector3(...positions.subarray(low * 3, low * 3 + 3)).distanceTo(new THREE.Vector3(...positions.subarray(high * 3, high * 3 + 3)));
          assert.ok(restLength > 0.2, `${id}: the weapon probe spans only ${restLength.toFixed(3)} model units`);
          let worst = 0;
          for (const action of Object.keys(item.actionToClipMapping)) {
            const clip = loaded.gltf.animations.find(candidate => candidate.name === clipOf(action)), playing = mixer.clipAction(clip);
            playing.play();
            for (let step = 0; step <= 8; step++) {
              playing.time = clip.duration * step / 8; mixer.update(0);
              loaded.gltf.scene.updateMatrixWorld(true); skinned.skeleton.update();
              skinned.getVertexPosition(low, a).applyMatrix4(skinned.matrixWorld);
              skinned.getVertexPosition(high, b).applyMatrix4(skinned.matrixWorld);
              worst = Math.max(worst, Math.abs(a.distanceTo(b) / restLength - 1));
            }
            playing.stop();
          }
          assert.ok(worst <= 0.01, `${id}: the weapon flexes by ${(worst * 100).toFixed(2)}% in some clip`);
        });
      });
    }

    it('bound the melee pole to the left hand: the butt ring Tripo skinned onto the left toe was rebound', async () => {
      const id = 'actor-camp-hunter-melee', record = await readJson(`asset-source/generated/${id}-runtime-01/weapon-repair.json`);
      assert.equal(record.reboundTo, 'mixamorig:LeftHand');
      assert.deepEqual(Object.keys(record.previousDominantJoint), ['mixamorig:LeftToeBase']);
      assert.ok(record.verticesRebound >= 60, `only ${record.verticesRebound} vertices were rebound`);
      const path = `asset-source/generated/${id}-runtime-01/${id}.glb`;
      assert.equal(sha256(await readFile(`${root}/${path}`)), record.output.sha256, 'the base GLB is not the repaired one');
      const { from, to, radius, yMax } = record.tube;
      const alongPole = (x, y, z) => {
        const ab = to.map((v, i) => v - from[i]), ap = [x - from[0], y - from[1], z - from[2]];
        const t = Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / (ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2)));
        return y <= yMax && Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t) <= radius;
      };
      const { counts, total } = await dominantJoints(path, alongPole);
      assert.ok(total >= 60);
      assert.deepEqual([...counts.keys()], ['mixamorig:LeftHand'], `pole vertices on ${[...counts.keys()].join(', ')}`);
    });

    it('preserves the ranged weapon repair provenance chain from the Tripo runtime base to the current GLB', async () => {
      const id = 'actor-camp-hunter-ranged', dir = `asset-source/generated/${id}-runtime-01`;
      const record = await readJson(`${dir}/weapon-repair.json`), provenance = await readJson(`${dir}/provenance.json`);
      assert.equal(record.input.sha256, provenance.output.sha256, 'the repair did not start from the Tripo runtime base');
      assert.equal(sha256(await readFile(`${root}/${dir}/${id}.glb`)), record.output.sha256, 'the base GLB is not the repaired one');
    });
  });

  describe('props', () => {
    for (const [id, stated] of Object.entries(PROPS)) {
      describe(id, () => {
        let item, loaded;
        before(async () => { item = entry(id); loaded = await loadGlb(item.runtimeUrl); });

        it('is a static native prop with the stated size and its base on y = 0', () => {
          assert.equal(item.kind, 'prop');
          assert.equal(item.sourceType, 'native-glb');
          assert.equal(loaded.gltf.animations.length, 0);
          const placed = placedBox(loaded.gltf, item.coordinateTransform), size = placed.getSize(new THREE.Vector3());
          if (stated.height) assert.ok(within(size.y, stated.height), `${id}: height ${size.y.toFixed(2)} m vs ${stated.height} m`);
          if (stated.width) assert.ok(within(Math.max(size.x, size.z), stated.width), `${id}: width ${Math.max(size.x, size.z).toFixed(2)} m vs ${stated.width} m`);
          assert.ok(Math.abs(placed.min.y) <= 0.05, `${id}: base at y = ${placed.min.y.toFixed(3)}`);
        });

        it(`stays within ${stated.budget} triangles (boundary decoration)`, () => {
          const triangles = triangleCount(loaded.gltf);
          assert.ok(triangles > 2000, `${id}: only ${triangles} triangles, the silhouette is gone`);
          assert.ok(triangles <= stated.budget, `${id}: ${triangles} triangles exceed the ${stated.budget} budget`);
        });
      });
    }

    it('the camp keeps its lookout tower: the structure is taller than a tent (the Tripo decimation had flattened it)', async () => {
      const item = entry('prop-hunter-camp'), { gltf } = await loadGlb(item.runtimeUrl);
      const size = placedBox(gltf, item.coordinateTransform).getSize(new THREE.Vector3());
      assert.ok(size.y >= 3, `the camp is only ${size.y.toFixed(2)} m tall`);
    });
  });
});
