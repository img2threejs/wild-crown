import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, it, before } from 'node:test';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DEG, Rig, parseGlb, readAccessorAny, readAnimation } from '../../scripts/assets/creature-rig-kit.mjs';
import { quadrupedRigContext } from '../../scripts/assets/author-quadruped-clips.mjs';
import { BAMBOO_CLIP_SECONDS } from '../../src/rendering/BambooMonsterProfiles.ts';
import attackPresentation from '../../src/content/enemy-attack-presentation.json' with { type: 'json' };
import nativeAnchors from '../../src/content/enemy-native-anchors.json' with { type: 'json' };

// Blood Bamboo Valley playtest assets (asset-source/playtests/bamboo.json, scripts/assets/build-bamboo-manifest.mjs): Koro the Branchbreaker, Asha, Tali,
// Marek, the two Ash Hunter camp actors (melee trapper, ranged netter), the bamboo grove, the Ash Hunters' camp, the ancient shrine and the Black Sap jaw trap.
//
// The consumer contract is the native GLB plus the shipped production tables, not the authoring reports: every mapped action must be an actual
// named clip in the runtime GLB, bound to real animation channels on real skin joints, anchored on a real bone, and driven by the production
// clip-seconds table. The authoring reports (clips-report / combat-clips-report / companion-clips-report) are not read here: their key sets are an
// authoring implementation detail, not a consumer contract. The manifest's `provenance` pointer is checked as a provenance and rights record
// (it must describe the loaded GLB, its Tripo task ids must be in the authentic ledger, and nothing may claim acceptance).
// Nothing here is release evidence: every entry stays evidence-blocked.
//
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
  // Biped rig v1.0 without a tail chain: the twelve monster slots plus the six boss attacks.
  'actor-koro-branchbreaker': { actorId: 'bamboo-koro-branchbreaker', slots: MONSTER, height: 1.5, family: 'creature' },
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
// The production renderer plays a clip either as an endless loop (a gait or a held stance) or as a finite one-shot (a strike, a ceremony, a
// lifecycle). The set below is the production contract from src/rendering/StoryActorAnimation.ts and src/rendering/MonsterAnimationProfiles.ts:
// every action listed there as a loop must close seamlessly on its own first frame. A finite one-shot may legitimately return to its starting
// pose, so no one-shot is constrained here.
const LOOPING_ACTIONS = new Set([
  'monster-idle', 'monster-walk', 'monster-run', 'monster-turn',
  'asha-stalk', 'asha-corrupted-idle', 'asha-bond-idle',
  'tali-play',
  'npc-talk-relaxed', 'npc-talk-explain', 'npc-talk-guarded',
  'hunter-kneel-idle',
]);

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

  it('every bamboo-built asset keeps its authored provenance record blocked and its production acceptance unestablished', async () => {
    // The manifest's provenance pointer is the record a reviewer reads; it must exist, name the runtime GLB and never claim acceptance. The
    // bamboo-built assets are the ones this chapter authored; the carried kit and heroes keep their own record shapes.
    const ledger = (await readFile(`${root}/${LOG}`, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    for (const id of [...Object.keys(CHARACTERS), ...Object.keys(PROPS)]) {
      const item = entry(id);
      assert.ok(item.provenance, `${id} needs a provenance record`);
      const path = `${root}/${item.provenance}`;
      assert.ok(existsSync(path), `${id}: ${item.provenance} does not exist`);
      const record = JSON.parse(await readFile(path, 'utf8'));
      // The record the manifest points at must describe the very GLB the manifest loads.
      assert.equal(record.output?.sha256, item.outputHash, `${id}: ${item.provenance} does not describe the loaded GLB`);
      // The generation provenance of the same runtime dir names the Tripo tasks; each must be a task id the authentic ledger records. The
      // ledger is the local record of the provider calls: this proves the task ids were logged, not that the provider executed them.
      const provenance = JSON.parse(await readFile(`${root}/${item.provenance.replace(/\/[^/]+$/, '')}/provenance.json`, 'utf8'));
      for (const [step, task] of Object.entries(provenance.tasks ?? {})) {
        assert.match(task, /^[0-9a-f-]{36}$/, `${id}: the ${step} task is not a task id`);
        assert.ok(ledger.some(row => row.task_id === task), `${id}: the ${step} task ${task} is not in the generation ledger`);
      }
      // A static prop's record carries the acceptance verdict: it must stay blocked and unestablished.
      if (item.kind === 'prop') {
        assert.ok(provenance.assessment, `${id}: the prop record has no assessment`);
        assert.equal(provenance.assessment.evidenceStatus, 'blocked', `${id} must stay evidence-blocked`);
        assert.equal(provenance.assessment.productionAcceptance, 'NOT_ESTABLISHED', `${id} must not claim production acceptance`);
      }
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
        let item, loaded, skinned, rig, json, bin;
        before(async () => {
          item = entry(id);
          loaded = await loadGlb(item.runtimeUrl);
          ({ json, bin } = parseGlb(loaded.bytes));
          rig = new Rig(json);
          loaded.gltf.scene.traverse(object => { if (object.isSkinnedMesh) skinned = object; });
        });

        it('maps every engine slot and extra to a native named clip that actually moves the rig', () => {
          assert.equal(item.actorId, stated.actorId);
          assert.equal(item.kind, 'character');
          assert.equal(item.sourceType, 'native-glb');
          const clips = new Map(loaded.gltf.animations.map(clip => [clip.name, clip]));
          for (const [action, clipName] of Object.entries(item.actionToClipMapping)) {
            const clip = clips.get(clipName);
            assert.ok(clip, `${id}: clip ${clipName} for ${action} is not in the GLB (has ${[...clips.keys()].join(', ')})`);
            assert.ok(clip.duration > 0.2, `${id}: ${clipName} is empty`);
            // A mapped clip must actually pose the character: the skin's own joints have to change rotation over the clip. Counting rotation
            // channels would pass for a clip whose channels target a static node or a joint that never moves.
            const sampler = readAnimation(rig, bin, clipName);
            const frames = Array.from({ length: 9 }, (_, step) => sampler.sample(sampler.duration * step / 8));
            let posed = 0;
            for (const joint of rig.joints) {
              const rest = frames[0].Q[joint];
              let travel = 0;
              for (const frame of frames) travel = Math.max(travel, rest.clone().normalize().angleTo(frame.Q[joint].clone().normalize()) / DEG);
              if (travel > 0.5) posed++;
            }
            assert.ok(posed >= 5, `${id}: ${clipName} poses only ${posed} of its ${rig.joints.length} skin joints`);
          }
        });

        it('declares every mapped action in-place and verified, exactly as the renderer requires', () => {
          for (const action of Object.keys(item.actionToClipMapping)) {
            assert.equal(item.rootMotion[action]?.mode, 'in-place', `${id}: ${action} root motion must be declared in-place`);
            assert.equal(item.rootMotion[action]?.evidenceStatus, 'verified', `${id}: ${action} root motion evidence must be verified`);
          }
        });

        it('exposes the castSocketBone node', () => {
          assert.ok(item.castSocketBone, `${id} needs castSocketBone`);
          const bone = loaded.gltf.scene.getObjectByName(sanitize(item.castSocketBone)) ?? loaded.gltf.scene.getObjectByName(item.castSocketBone);
          assert.ok(bone?.isBone, `${id}: ${item.castSocketBone} is not a bone of the rig`);
        });

        it('binds every attack the production presentation drives to a real native clip and anchor', () => {
          // The production attack presentation (src/content/enemy-attack-presentation.json) is the authority on which attack a bamboo actor
          // performs and which anatomy socket the effect follows. Every one of those attacks must be a real clip in this actor's GLB and must
          // resolve to real bones through the native anchor registry.
          const attacks = Object.entries(attackPresentation.attacks).filter(([, spec]) => spec.assets.includes(id));
          for (const [attackId, spec] of attacks) {
            const action = `wild-crown:${attackId}`;
            assert.ok(item.actionToClipMapping[action], `${id}: the production attack ${attackId} has no manifest action`);
            const clipName = item.actionToClipMapping[action];
            assert.ok(loaded.gltf.animations.some(clip => clip.name === clipName), `${id}: ${attackId} maps to ${clipName}, which is not in the GLB`);
            const anchor = nativeAnchors[id]?.[spec.socket];
            assert.ok(anchor, `${id}: the attack ${attackId} needs a native anchor for the '${spec.socket}' socket`);
            for (const part of ['base', 'tip']) {
              const bone = loaded.gltf.scene.getObjectByName(sanitize(anchor[part])) ?? loaded.gltf.scene.getObjectByName(anchor[part]);
              assert.ok(bone?.isBone, `${id}: the ${spec.socket} socket ${part} (${anchor[part]}) is not a bone of the rig`);
            }
          }
        });

        it('poses the body during the windup of every attack it drives', () => {
          // The production renderer drives one native clip across the four authoritative phases (windup / commit / active / recovery,
          // src/content/enemy-attack-presentation.json `phaseEnds`). The windup is the first phase, so the native clip has to already be
          // moving there: an attack clip that only poses later cannot read as a windup.
          const windupEnd = attackPresentation.phaseEnds[0];
          const attacks = Object.entries(attackPresentation.attacks).filter(([, spec]) => spec.assets.includes(id));
          for (const [attackId] of attacks) {
            const clipName = item.actionToClipMapping[`wild-crown:${attackId}`];
            const clip = readAnimation(rig, bin, clipName);
            const frames = Array.from({ length: 9 }, (_, step) => clip.sample(clip.duration * windupEnd * step / 8));
            let travel = 0;
            for (const joint of rig.joints) {
              const rest = frames[0].Q[joint];
              for (const frame of frames) travel = Math.max(travel, rest.clone().normalize().angleTo(frame.Q[joint].clone().normalize()) / DEG);
            }
            assert.ok(travel > 5, `${id}: the attack ${attackId} barely moves during its ${windupEnd} windup (${travel.toFixed(1)} degrees)`);
          }
        });

        it('plays every mapped clip in place and keeps the body on the ground plane', () => {
          assert.ok(skinned, 'runtime GLB must contain a skinned mesh');
          // In place means the native root joint never travels horizontally: the simulation owns the actor's position, so a clip that
          // carried its own displacement would double-move it. The root's translation track is read straight out of the GLB animation.
          const rootJoint = rig.rootJoint;
          for (const [action, clipName] of Object.entries(item.actionToClipMapping)) {
            const animation = rig.json.animations.find(candidate => candidate.name === clipName);
            assert.ok(animation, `${id}: ${clipName} is not an animation of the GLB`);
            const channel = animation.channels.find(candidate => candidate.target.node === rootJoint && candidate.target.path === 'translation');
            if (!channel) continue;
            const sampler = animation.samplers[channel.sampler];
            const values = readAccessorAny(rig.json, bin, sampler.output);
            let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
            for (let i = 0; i < values.length / 3; i++) {
              minX = Math.min(minX, values[i * 3]); maxX = Math.max(maxX, values[i * 3]);
              minZ = Math.min(minZ, values[i * 3 + 2]); maxZ = Math.max(maxZ, values[i * 3 + 2]);
            }
            const travel = Math.max(maxX - minX, maxZ - minZ) * item.coordinateTransform.scale;
            assert.ok(travel <= 1e-6, `${id}: ${action} (${clipName}) travels ${travel.toFixed(4)} m horizontally; the clip is not in place`);
          }
          // The body must stay on the ground plane while it plays: no clip may sink the mesh through the floor. The clip is played once and
          // clamped, so the last sample is the clip's real terminal pose (a looping action would otherwise wrap back to its first frame).
          const scale = item.coordinateTransform.scale;
          const mixer = new THREE.AnimationMixer(loaded.gltf.scene), vertex = new THREE.Vector3();
          for (const action of Object.keys(item.actionToClipMapping)) {
            const clip = loaded.gltf.animations.find(candidate => candidate.name === item.actionToClipMapping[action]);
            const playing = mixer.clipAction(clip);
            playing.setLoop(THREE.LoopOnce, 1);
            playing.clampWhenFinished = true;
            playing.play();
            let lowest = Infinity;
            for (let step = 0; step <= 12; step++) {
              playing.time = clip.duration * step / 12;
              mixer.update(0);
              loaded.gltf.scene.updateMatrixWorld(true);
              skinned.skeleton.update();
              for (let i = 0; i < skinned.geometry.attributes.position.count; i += 7) {
                skinned.getVertexPosition(i, vertex).applyMatrix4(skinned.matrixWorld);
                lowest = Math.min(lowest, vertex.y);
              }
            }
            playing.stop();
            mixer.stopAllAction();
            assert.ok(lowest * scale >= -SINK_TOLERANCE, `${id}: ${action} (${clip.name}) sinks ${(-lowest * scale).toFixed(3)} m below the ground`);
          }
        });

        it('has the stated size with its feet on y = 0', () => {
          const placed = placedBox(loaded.gltf, item.coordinateTransform), size = placed.getSize(new THREE.Vector3());
          if (stated.height) assert.ok(within(size.y, stated.height), `${id}: height ${size.y.toFixed(2)} m vs ${stated.height} m`);
          if (stated.shoulder) {
            // Shoulder height: the top joint of each front leg, measured on the native rig, plus 5% of the model height (hide / fur), exactly
            // as the manifest builder measures it when it scales the entry.
            const context = quadrupedRigContext(id, rig.json);
            const matrix = placement(item.coordinateTransform);
            const tops = ['FL', 'FR'].map(key => {
              const chain = context.legs[key].chain;
              const hip = context.nodes[chain[0]].name;
              const node = loaded.gltf.scene.getObjectByName(sanitize(hip)) ?? loaded.gltf.scene.getObjectByName(hip);
              return node.getWorldPosition(new THREE.Vector3()).applyMatrix4(matrix).y;
            });
            const shoulder = (tops[0] + tops[1]) / 2 + 0.05 * size.y;
            assert.ok(within(shoulder, stated.shoulder), `${id}: shoulder ${shoulder.toFixed(2)} m vs ${stated.shoulder} m`);
            assert.ok(size.y < stated.shoulder * 2.2, `${id}: ${size.y.toFixed(2)} m tall is out of proportion for a ${stated.shoulder} m shoulder`);
          }
          assert.ok(Math.abs(placed.min.y) <= 0.05, `${id}: base at y = ${placed.min.y.toFixed(3)}`);
        });


        it('plays the story clips at the length the production clip-seconds table declares', () => {
          // The renderer maps elapsed world time onto these clips through the production table
          // (src/rendering/BambooMonsterProfiles.ts BAMBOO_CLIP_SECONDS). The native clip must be exactly that long, or the ceremony or
          // gesture the table times would be cut short (or hold past its end).
          for (const [action, clipName] of Object.entries(item.actionToClipMapping)) {
            const declared = BAMBOO_CLIP_SECONDS[action];
            if (declared === undefined) continue;
            const clip = loaded.gltf.animations.find(candidate => candidate.name === clipName);
            assert.ok(clip, `${id}: ${action} maps to ${clipName}, which is not in the GLB`);
            assert.ok(Math.abs(clip.duration - declared) <= 1 / 30, `${id}: ${action} (${clipName}) runs ${clip.duration.toFixed(3)} s but the production table declares ${declared} s`);
          }
        });

        it('closes every looping action on its own first frame', () => {
          // The production renderer plays a gait or a held stance as an endless loop (src/rendering/StoryActorAnimation.ts
          // loopSample, src/rendering/MonsterAnimationProfiles.ts). A clip played that way must close on its own first frame, or the loop
          // visibly pops. The seam is measured on the native clip itself.
          for (const [action, clipName] of Object.entries(item.actionToClipMapping)) {
            if (!LOOPING_ACTIONS.has(action)) continue;
            const sampler = readAnimation(rig, bin, clipName);
            const first = sampler.sample(0), last = sampler.sample(sampler.duration);
            let seam = 0;
            for (const joint of rig.joints) seam = Math.max(seam, first.Q[joint].clone().normalize().angleTo(last.Q[joint].clone().normalize()) / DEG);
            assert.ok(seam <= 1, `${id}: ${action} (${clipName}) closes ${seam.toFixed(2)} degrees from its first frame`);
          }
        });
      });
    }
  });

  describe('Koro, the Branchbreaker attack kit', () => {
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

    it('binds the six boss attacks to native clips and the native rock-throw anchor', async () => {
      const item = entry('actor-koro-branchbreaker');
      const { gltf } = await loadGlb(item.runtimeUrl);
      const names = new Set(gltf.animations.map(clip => clip.name));
      for (const attack of ['koro-fruit-burst', 'koro-rock-throw', 'koro-falling-branch', 'koro-platform-charge', 'koro-vine-vault', 'koro-branch-swing']) {
        const action = `wild-crown:${attack}`;
        assert.ok(item.actionToClipMapping[action], `the boss attack ${attack} has no manifest action`);
        assert.ok(names.has(item.actionToClipMapping[action]), `the boss attack ${attack} maps to a clip that is not in the GLB`);
      }
      // The rock throw is a right-hand throw: the effect follows the hand anchor the production registry names.
      const anchor = nativeAnchors['actor-koro-branchbreaker']['hand-right'];
      for (const part of ['base', 'tip']) {
        const bone = gltf.scene.getObjectByName(sanitize(anchor[part])) ?? gltf.scene.getObjectByName(anchor[part]);
        assert.ok(bone?.isBone, `the rock-throw hand ${part} (${anchor[part]}) is not a bone of the rig`);
      }
    });
  });

  describe('Asha', () => {
    it('has a complete four-leg chain on every side after the rig repair', async () => {
      const record = await readJson('asset-source/generated/actor-asha-runtime-01/skin-repair.json');
      assert.deepEqual(Object.keys(record.chains), ['HL', 'HR']);
      assert.ok(record.chains.HR.verticesMirrored >= 2000, `only ${record.chains.HR.verticesMirrored} right hind vertices carry mirrored weights`);
      const path = 'asset-source/generated/actor-asha-runtime-01/actor-asha.glb';
      assert.equal(sha256(await readFile(`${root}/${path}`)), record.output.sha256, 'the base GLB is not the repaired one');
      // The repaired hind legs must still be real chains in the shipped rig: four joints each, and the repaired paws carry the skin.
      const { json } = parseGlb(await readFile(localPath(entry('actor-asha').runtimeUrl)));
      const context = quadrupedRigContext('actor-asha', json);
      for (const key of ['FL', 'FR', 'HL', 'HR']) {
        const chain = context.legs[key];
        assert.ok(chain, `Asha has no ${key} leg chain in the native rig`);
        assert.ok(chain.chain.length >= 4, `Asha's ${key} chain has only ${chain.chain.length} joints`);
        assert.ok(chain.lengths.every(length => length > 0), `Asha's ${key} chain has a zero-length bone`);
      }
      for (const key of ['HL', 'HR']) {
        const names = context.legs[key].chain.map(index => context.nodes[index].name);
        assert.ok(names.some(name => name.startsWith('repair::')), `Asha's ${key} chain carries no repaired joint: ${names.join(', ')}`);
      }
      const right = await dominantJoints(path, (x, y, z) => x < -0.05 && x > -0.3 && y < 0.1 && z > 0.04);
      const left = await dominantJoints(path, (x, y, z) => x < -0.05 && x > -0.3 && y < 0.1 && z < -0.04);
      for (const [name] of right.counts) assert.match(name, /^repair::HR_/, `a right hind paw vertex is skinned to ${name}`);
      for (const [name] of left.counts) assert.ok(/^repair::HL_|^tripo::0_Left_Limb_/.test(name), `a left hind paw vertex is skinned to ${name}`);
      assert.ok(right.total > 300 && left.total > 300);
    });

    it('binds the three boss phase attacks to distinct native clips', async () => {
      // The three phase attacks are the production attacks the presentation drives for her (src/content/enemy-attack-presentation.json);
      // each must be a distinct native clip of this actor. The phase timing itself belongs to the engine's attack windows, which the engine
      // timing suite covers; here only the native clip binding is asserted.
      const item = entry('actor-asha');
      const { gltf } = await loadGlb(item.runtimeUrl);
      const phaseAttacks = Object.entries(attackPresentation.attacks)
        .filter(([, spec]) => spec.assets.includes('actor-asha'))
        .map(([attackId]) => attackId);
      assert.ok(phaseAttacks.length >= 3, 'Asha must have at least three production attacks');
      const clips = new Set();
      for (const attackId of phaseAttacks) {
        const mapped = item.actionToClipMapping[`wild-crown:${attackId}`];
        assert.ok(mapped, `the production attack ${attackId} has no manifest action`);
        const clip = gltf.animations.find(candidate => candidate.name === mapped);
        assert.ok(clip, `the production attack ${attackId} maps to ${mapped}, which is not in the GLB`);
        clips.add(mapped);
      }
      assert.equal(clips.size, phaseAttacks.length, 'the production attacks must not share one native clip');
    });
  });

  describe('Tali', () => {
    it('is a cub of her own: half Asha\'s shoulder height with her own rig and her own repaired hind leg', async () => {
      const item = entry('actor-tali');
      assert.ok(item.coordinateTransform.scale > 0);
      assert.notEqual(item.tripoSourceTask, entry('actor-asha').tripoSourceTask);
      const record = await readJson('asset-source/generated/actor-tali-runtime-01/skin-repair.json');
      assert.deepEqual(Object.keys(record.chains), ['HL']);
      assert.ok(record.chains.HL.verticesMirrored >= 2000);
      const path = 'asset-source/generated/actor-tali-runtime-01/actor-tali.glb';
      assert.equal(sha256(await readFile(`${root}/${path}`)), record.output.sha256, 'the base GLB is not the repaired one');
      const left = await dominantJoints(path, (x, y, z) => x < -0.04 && y < 0.1 && z > 0.05);
      for (const [name] of left.counts) assert.match(name, /^repair::HL_|^tripo::1_Left_Limb_0$/, `a left hind paw vertex is skinned to ${name}`);
      // Her own rig: the repaired left hind chain is a real chain of four joints in the shipped GLB.
      const { json } = parseGlb(await readFile(localPath(item.runtimeUrl)));
      const context = quadrupedRigContext('actor-tali', json);
      const names = context.legs.HL.chain.map(index => context.nodes[index].name);
      assert.deepEqual(names, ['tripo::1_Left_Limb_0', 'repair::HL_1', 'repair::HL_2', 'repair::HL_3', 'repair::HL_4']);
    });
  });

  describe('Marek', () => {
    it('keeps the Mixamo-spec rig and four talking idles that are not monster slots', async () => {
      const item = entry('actor-marek');
      assert.equal(item.castSocketBone, 'mixamorig:Head');
      for (const slot of ['monster-slash', 'monster-shoot', 'monster-roar']) assert.equal(item.actionToClipMapping[slot], undefined, `${slot} makes no sense for the NPC`);
      // The four talking idles are the story gestures the renderer plays (src/rendering/StoryActorAnimation.ts) and each is a native clip.
      const { gltf } = await loadGlb(item.runtimeUrl);
      const names = new Set(gltf.animations.map(clip => clip.name));
      for (const gesture of ['npc-talk-relaxed', 'npc-talk-explain', 'npc-talk-point', 'npc-talk-guarded']) {
        assert.ok(item.actionToClipMapping[gesture], `${gesture} has no manifest action`);
        assert.ok(names.has(item.actionToClipMapping[gesture]), `${gesture} maps to a clip that is not in the GLB`);
      }
    });
  });

  describe('Ash Hunters of the camp', () => {
    // hand = the joint the weapon is bound to; attacks = the native attack slots the hunter plays.
    const HUNTERS = {
      'actor-camp-hunter-melee': { hand: 'mixamorig:LeftHand', attacks: ['monster-slash', 'hunter-thrust'], concepts: 2, anim: 50 },
      'actor-camp-hunter-ranged': { hand: 'mixamorig:RightHand', attacks: ['monster-shoot'], concepts: 4, anim: 40 },
    };
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
        let item, loaded, json, bin, rig, skinned, mixer;
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
        });

        it('plays every native attack from the idle pose and returns to it', () => {
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
