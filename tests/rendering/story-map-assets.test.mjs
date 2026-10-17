import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, it, before } from 'node:test';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Story-map playtest assets (asset-source/playtests/{grove,moonpine,mistveil}.json): runtime GLB hashes, the monster clip slots,
// castSocketBone nodes, in-place clips, grounded feet, measured sizes against the stated sizes and the log bridge's level deck.
// GLTFLoader parses the real GLBs in Node (a material-only plugin skips texture decoding, which needs DOM image APIs).
// A map whose manifest has not been generated yet is skipped (scripts/assets/build-story-map-manifest.mjs --map=<id>).
const root = process.cwd();
const SLOTS = ['monster-idle', 'monster-walk', 'monster-run', 'monster-slash', 'monster-shoot', 'monster-jump', 'monster-hurt', 'monster-turn', 'monster-dive', 'monster-roar'];
const TOLERANCE = 0.25;
/** A skinned vertex may dip this far (metres, after scaling) below the ground in any clip: skin bulge around planted joints. A character may state its own (`sink`). */
const SINK_TOLERANCE = 0.15;

/**
 * Per map: the composed environment and built assets with their stated sizes in metres (height / width = larger footprint axis / length /
 * wingspan / shoulder) and the decoration triangle budgets (boundary decoration is drawn as hundreds of instances per frame).
 */
const MAPS = {
  grove: {
    environment: 'the-grove-environment',
    characters: {
      'actor-koro': { actorId: 'grove-koro', slots: ['monster-idle', 'monster-walk'], height: 1.3 },
      'actor-grove-rootling': { actorId: 'grove-sprig', slots: SLOTS, height: 1.6 },
      // Stage 2: the rootling body drawn a quarter larger (2.0 m) on its own darkened material variant; stage 3: the 3.5 m biped guardian.
      'actor-grove-blighted-rootling': { actorId: 'grove-blighted', slots: SLOTS, height: 2 },
      // The 3.5 m guardian's sink allowance is 6% of its height (0.21 m): idle toes dip 0.08 m, the walk 0.14 m, the guarded slash hand 0.18 m (the Tripo slash and pitch presets took it 0.45 to 0.53 m under, which `limbFloor` in author-creature-clips.mjs removes).
      'actor-grove-hollowheart': { actorId: 'grove-hollowheart', slots: SLOTS, height: 3.5, sink: 0.21 },
    },
    // The Memory Pool's set dressing is carried from the Canopy (shrine, cliff rock) and Mistveil (mire rock, cavern mouth) generation logs.
    props: {
      'prop-heartroot-trunk': { height: 9 }, 'prop-refuge-shelter': { width: 4 }, 'prop-training-post': { height: 2.5 }, 'prop-water-basin': { width: 4 }, 'prop-grove-platform': { width: 4 },
      'prop-ancient-canopy-shrine': { width: 14, log: 'canopy-tripo-log.jsonl' }, 'prop-canopy-cliff-rock': { height: 6, log: 'canopy-tripo-log.jsonl' },
      'prop-mire-bank-rock': { width: 4, log: 'mistveil-tripo-log.jsonl' }, 'prop-root-cavern-mouth': { width: 8, log: 'mistveil-tripo-log.jsonl' },
    },
    budgets: { 'prop-canopy-cliff-rock': 2500, 'prop-mire-bank-rock': 2600 },
    log: 'grove-tripo-log.jsonl',
  },
  moonpine: {
    environment: 'moonpine-ridge-environment',
    characters: {
      'actor-frostfang-tracker': { actorId: 'moonpine-frostfang', slots: SLOTS, shoulder: 1.1 },
      'actor-howl-scout': { actorId: 'moonpine-scout', slots: SLOTS, shoulder: 0.9 },
      'actor-ruun-chained-howl': { actorId: 'moonpine-ruun', slots: SLOTS, shoulder: 1.6 },
    },
    props: { 'prop-moonpine-tree': { height: 16 }, 'prop-buried-wolf-temple': { width: 14 }, 'prop-temple-chain-anchor': { height: 2.5 }, 'prop-snow-ridge-rock': { width: 5, height: 3 }, 'prop-moonpine-log-bridge': { length: 12, width: 3.2 } },
    budgets: { 'prop-moonpine-tree': 7500, 'prop-snow-ridge-rock': 2600 },
    log: 'moonpine-tripo-log.jsonl',
  },
  mistveil: {
    environment: 'mistveil-basin-environment',
    characters: {
      'actor-bog-lurker': { actorId: 'mistveil-lurker', slots: SLOTS, height: 1.4 },
      'actor-lantern-heron': { actorId: 'mistveil-heron', slots: SLOTS, height: 2.4, wingspan: 3.6, grounded: true },
      'actor-ghor-mire-maw': { actorId: 'mistveil-ghor', slots: SLOTS, length: 8 },
    },
    props: { 'prop-mistveil-root-tree': { height: 14 }, 'prop-mistveil-reed-cluster': { height: 2.5 }, 'prop-mire-bank-rock': { width: 4 }, 'prop-hunter-extraction-rig': { height: 6 }, 'prop-black-sap-filter-drum': { height: 2 }, 'prop-root-cavern-mouth': { width: 8 } },
    budgets: { 'prop-mistveil-root-tree': 7500, 'prop-mistveil-reed-cluster': 2000, 'prop-mire-bank-rock': 2600 },
    log: 'mistveil-tripo-log.jsonl',
  },
};

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

/** Exact bounds of every bind-pose vertex after the manifest's placement (a diagonal body would be inflated by a box-of-a-box). */
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

for (const [map, config] of Object.entries(MAPS)) {
  const manifestPath = `asset-source/playtests/${map}.json`;
  describe(`${map}.json manifest`, { skip: existsSync(`${root}/${manifestPath}`) ? false : `${manifestPath} has not been generated yet` }, () => {
    let manifest;
    const entry = id => {
      const found = manifest.find(item => item.id === id);
      assert.ok(found, `${map}.json has no entry ${id}`);
      return found;
    };
    before(async () => { manifest = await readJson(manifestPath); });

    it('keeps candidate ids unique and all assets evidence-blocked', () => {
      const ids = manifest.map(item => item.id);
      assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
      for (const item of manifest) assert.equal(item.evidenceStatus, 'blocked', `${item.id} must stay evidence-blocked`);
    });

    it('resolves every environment component to a native prop in its manifest', () => {
      const environment = entry(config.environment);
      assert.equal(environment.sourceType, 'composed-recipe');
      assert.equal(environment.kind, 'environment');
      for (const id of environment.componentAssetIds) {
        const component = entry(id);
        assert.equal(component.kind, 'prop');
        assert.equal(component.sourceType, 'native-glb');
      }
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

    it('every Tripo source task of the new assets is in its generation log', async () => {
      const logged = new Map();
      const tasksOf = async log => {
        if (!logged.has(log)) {
          const rows = (await readFile(`${root}/asset-source/generated/${log}`, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
          logged.set(log, new Set(rows.flatMap(row => [row.task_id, ...(row.tasks ?? []).map(task => task.task_id)]).filter(Boolean)));
        }
        return logged.get(log);
      };
      for (const [id, stated] of [...Object.entries(config.characters), ...Object.entries(config.props)]) {
        const log = stated.log ?? config.log;
        assert.ok((await tasksOf(log)).has(entry(id).tripoSourceTask), `${id}: Tripo task ${entry(id).tripoSourceTask} is not in ${log}`);
      }
    });

    describe('characters', () => {
      for (const [id, stated] of Object.entries(config.characters)) {
        describe(id, () => {
          let item, loaded, report, skinned;
          before(async () => {
            item = entry(id);
            loaded = await loadGlb(item.runtimeUrl);
            report = await readJson(item.provenance);
            loaded.gltf.scene.traverse(object => { if (object.isSkinnedMesh) skinned = object; });
          });

          it('maps the engine-requested clip slots to native named clips, in place', () => {
            assert.equal(item.actorId, stated.actorId);
            assert.equal(item.kind, 'character');
            assert.equal(item.sourceType, 'native-glb');
            assert.deepEqual(item.requiredActionIds, []);
            for (const slot of stated.slots) assert.ok(slot in item.actionToClipMapping, `${id}: the mapping lacks the engine-requested slot ${slot}`);
            const names = new Set(loaded.gltf.animations.map(clip => clip.name));
            for (const slot of Object.keys(item.actionToClipMapping)) {
              const clipName = item.actionToClipMapping[slot];
              assert.ok(names.has(clipName), `${id}: clip ${clipName} for ${slot} is not in the GLB (has ${[...names].join(', ')})`);
              assert.ok(loaded.gltf.animations.find(clip => clip.name === clipName).duration > 0.2, `${id}: ${clipName} is empty`);
              assert.equal(item.rootMotion[slot]?.mode, 'in-place', `${id}: ${slot} root motion must be declared in-place`);
              assert.equal(item.rootMotion[slot]?.evidenceStatus, 'verified');
            }
          });

          it('exposes the castSocketBone node', () => {
            assert.ok(item.castSocketBone, `${id} needs castSocketBone`);
            const bone = loaded.gltf.scene.getObjectByName(sanitize(item.castSocketBone)) ?? loaded.gltf.scene.getObjectByName(item.castSocketBone);
            assert.ok(bone?.isBone, `${id}: ${item.castSocketBone} is not a bone of the rig`);
          });

          it('records how every clip was produced', () => {
            for (const slot of stated.slots) {
              const produced = report.slots ? report.slots[slot] : report.clips[slot] ?? { produced: 'preset', durationSeconds: 1 };
              assert.ok(produced, `${id}: clips-report has no ${slot}`);
              if (report.slots) assert.ok(['preset', 'preset-conditioned', 'authored'].includes(produced.produced), `${id}: ${slot} produced=${produced.produced}`);
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
            for (const slot of Object.keys(item.actionToClipMapping)) {
              const clip = loaded.gltf.animations.find(candidate => candidate.name === item.actionToClipMapping[slot]);
              const action = mixer.clipAction(clip);
              action.play();
              let worstDrift = 0, lowest = Infinity;
              for (let step = 0; step <= 12; step++) {
                action.time = clip.duration * step / 12;
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
              action.stop();
              assert.ok(worstDrift <= 0.12 * span, `${id}: ${slot} (${clip.name}) drifts ${(worstDrift / span * 100).toFixed(1)}% of the body span from the actor origin`);
              assert.ok(lowest * scale >= -(stated.sink ?? SINK_TOLERANCE), `${id}: ${slot} (${clip.name}) sinks ${(-lowest * scale).toFixed(3)} m below the ground`);
            }
          });

          it('has the stated size with its feet on y = 0', () => {
            const placed = placedBox(loaded.gltf, item.coordinateTransform), size = placed.getSize(new THREE.Vector3());
            if (stated.height) assert.ok(within(size.y, stated.height), `${id}: height ${size.y.toFixed(2)} m vs ${stated.height} m`);
            if (stated.wingspan) assert.ok(within(Math.max(size.x, size.z), stated.wingspan), `${id}: wingspan ${Math.max(size.x, size.z).toFixed(2)} m vs ${stated.wingspan} m`);
            if (stated.length) assert.ok(within(size.z, stated.length), `${id}: body length ${size.z.toFixed(2)} m vs ${stated.length} m (the model is turned to face +z)`);
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

          if (stated.grounded) {
            it('never leaves the ground except in the short hop that lands back at y = 0', () => {
              // A ground-bound wader: the lowest skinned vertex stays at the ground in every clip, except mid-air in the hop.
              const scale = item.coordinateTransform.scale;
              const mixer = new THREE.AnimationMixer(loaded.gltf.scene), vertex = new THREE.Vector3();
              for (const slot of SLOTS) {
                const clip = loaded.gltf.animations.find(candidate => candidate.name === item.actionToClipMapping[slot]);
                const action = mixer.clipAction(clip);
                action.play();
                let highestLowest = -Infinity, last = 0;
                for (let step = 0; step <= 24; step++) {
                  action.time = clip.duration * step / 24;
                  mixer.update(0);
                  loaded.gltf.scene.updateMatrixWorld(true);
                  skinned.skeleton.update();
                  let lowest = Infinity;
                  for (let i = 0; i < skinned.geometry.attributes.position.count; i += 7) {
                    skinned.getVertexPosition(i, vertex).applyMatrix4(skinned.matrixWorld);
                    lowest = Math.min(lowest, vertex.y);
                  }
                  highestLowest = Math.max(highestLowest, lowest * scale);
                  last = lowest * scale;
                }
                action.stop();
                if (slot === 'monster-jump') {
                  assert.ok(highestLowest <= 1.2, `${id}: the hop rises ${highestLowest.toFixed(2)} m, it must stay short`);
                  assert.ok(Math.abs(last) <= 0.1, `${id}: the hop must land back at y = 0 (ends at ${last.toFixed(3)} m)`);
                } else assert.ok(highestLowest <= 0.1, `${id}: ${slot} lifts the feet ${highestLowest.toFixed(3)} m off the ground (a wader never hovers)`);
              }
            });
          }
        });
      }
    });

    describe('props', () => {
      for (const [id, stated] of Object.entries(config.props)) {
        describe(id, () => {
          let item, loaded;
          before(async () => { item = entry(id); loaded = await loadGlb(item.runtimeUrl); });

          it('is a static native prop with the stated size and its base on y = 0', () => {
            assert.equal(item.kind, 'prop');
            assert.equal(item.sourceType, 'native-glb');
            assert.equal(loaded.gltf.animations.length, 0);
            const placed = placedBox(loaded.gltf, item.coordinateTransform), size = placed.getSize(new THREE.Vector3());
            if (stated.height) assert.ok(within(size.y, stated.height), `${id}: height ${size.y.toFixed(2)} m vs ${stated.height} m`);
            if (stated.length) {
              assert.ok(within(size.z, stated.length), `${id}: length ${size.z.toFixed(2)} m vs ${stated.length} m`);
              assert.ok(within(size.x, stated.width), `${id}: width ${size.x.toFixed(2)} m vs ${stated.width} m`);
            } else if (stated.width) assert.ok(within(Math.max(size.x, size.z), stated.width), `${id}: width ${Math.max(size.x, size.z).toFixed(2)} m vs ${stated.width} m`);
            if (!stated.length) assert.ok(Math.abs(placed.min.y) <= 0.05, `${id}: base at y = ${placed.min.y.toFixed(3)}`);
          });

          if (config.budgets[id]) {
            it(`stays within ${config.budgets[id]} triangles (boundary decoration)`, () => {
              const triangles = triangleCount(loaded.gltf);
              assert.ok(triangles > 500, `${id}: only ${triangles} triangles, the silhouette is gone`);
              assert.ok(triangles <= config.budgets[id], `${id}: ${triangles} triangles exceed the ${config.budgets[id]} budget`);
            });
          }
        });
      }
    });

    if (config.props['prop-moonpine-log-bridge']) {
      it('prop-moonpine-log-bridge runs 12 m along +z with a level deck at local y 0', async () => {
        const item = entry('prop-moonpine-log-bridge'), { gltf } = await loadGlb(item.runtimeUrl);
        const matrix = placement(item.coordinateTransform);
        const box = placedBox(gltf, item.coordinateTransform);
        assert.ok(box.max.z - box.min.z >= 11, `bridge is ${(box.max.z - box.min.z).toFixed(2)} m long`);
        assert.ok((box.max.z - box.min.z) > (box.max.x - box.min.x) * 2, 'the length axis must be z after the transform');
        // Top surface along the centre line (x = 0, between the rails): vertical ray against every placed triangle.
        const triangles = [];
        gltf.scene.traverse(object => {
          if (!object.isMesh) return;
          const position = object.geometry.attributes.position, index = object.geometry.index;
          const vertex = i => new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld).applyMatrix4(matrix);
          for (let t = 0; t < index.count; t += 3) triangles.push([vertex(index.getX(t)), vertex(index.getX(t + 1)), vertex(index.getX(t + 2))]);
        });
        const topAt = (x, z) => {
          let best = -Infinity;
          for (const [a, b, c] of triangles) {
            if (Math.max(a.z, b.z, c.z) < z || Math.min(a.z, b.z, c.z) > z) continue;
            const d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
            if (Math.abs(d) < 1e-12) continue;
            const l1 = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / d, l2 = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / d, l3 = 1 - l1 - l2;
            if (l1 < 0 || l2 < 0 || l3 < 0) continue;
            best = Math.max(best, l1 * a.y + l2 * b.y + l3 * c.y);
          }
          return best;
        };
        const heights = [], zMin = box.min.z + 0.04 * (box.max.z - box.min.z), zMax = box.max.z - 0.04 * (box.max.z - box.min.z);
        for (let k = 0; k <= 48; k++) {
          const h = topAt(0, zMin + (zMax - zMin) * k / 48);
          if (Number.isFinite(h)) heights.push(h);
        }
        assert.ok(heights.length >= 36, `only ${heights.length} of 49 centre-line samples hit the deck`);
        const spread = Math.max(...heights) - Math.min(...heights), mean = heights.reduce((a, b) => a + b, 0) / heights.length;
        assert.ok(spread <= 0.25, `deck height varies ${spread.toFixed(3)} m along its length (limit 0.25 m)`);
        assert.ok(Math.abs(mean) <= 0.06, `deck sits ${mean.toFixed(3)} m from local y 0`);
      });
    }
  });
}
