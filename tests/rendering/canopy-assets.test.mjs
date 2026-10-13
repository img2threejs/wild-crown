import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, it, before } from 'node:test';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Whispering Canopy playtest assets (asset-source/playtests/canopy.json): runtime GLB hashes, the ten monster clip slots,
// castSocketBone nodes, in-place clips, measured sizes against the design contract and the bridge's level deck.
// GLTFLoader parses the real GLBs in Node (a material-only plugin skips texture decoding, which needs DOM image APIs).
const root = process.cwd();
const SLOTS = ['monster-idle', 'monster-walk', 'monster-run', 'monster-slash', 'monster-shoot', 'monster-jump', 'monster-hurt', 'monster-turn', 'monster-dive', 'monster-roar'];
const TOLERANCE = 0.25;
/** Sizes stated by the contract (.opencode/plans/2026-10-11-whispering-canopy-playtest.md §4) and the Tripo brief, metres. */
const STATED = {
  'actor-thornback-howler': { height: 1.7 },
  'actor-storm-hornbill': { wingspan: 3.2 },
  'actor-mire-viper': { length: 7 },
  'prop-vine-bridge': { length: 12, width: 3.4 },
  'prop-ancient-canopy-shrine': { width: 14 },
  'prop-rainforest-canopy-tree': { height: 22 },
  'prop-canopy-cliff-rock': { height: 6 },
  'prop-canopy-fern-cluster': { height: 1.5, width: 2.4 },
};
/** Boundary decoration is drawn as hundreds of instances per frame, so these runtime GLBs have hard triangle budgets. */
const TRIANGLE_BUDGET = { 'prop-canopy-fern-cluster': 1800, 'prop-canopy-cliff-rock': 2500, 'prop-rainforest-canopy-tree': 7000 };
const MONSTERS = { 'actor-thornback-howler': 'canopy-howler', 'actor-storm-hornbill': 'canopy-hornbill', 'actor-mire-viper': 'canopy-mire-viper' };
const REGION_PROPS = ['prop-vine-bridge', 'prop-ancient-canopy-shrine', 'prop-rainforest-canopy-tree', 'prop-canopy-cliff-rock', 'prop-canopy-fern-cluster'];

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const toArrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const sanitize = name => THREE.PropertyBinding.sanitizeNodeName(name);
const localPath = url => `${root}/${url.replace(/^\//, '')}`;

const manifest = JSON.parse(await readFile(`${root}/asset-source/playtests/canopy.json`, 'utf8'));
const entry = id => {
  const found = manifest.find(item => item.id === id);
  assert.ok(found, `canopy.json has no entry ${id}`);
  return found;
};

async function loadGlb(url) {
  const bytes = await readFile(localPath(url));
  const gltf = await new GLTFLoader()
    .register(() => ({ name: 'pose-only-material', loadMaterial: () => Promise.resolve(new THREE.MeshBasicMaterial()) }))
    .parseAsync(toArrayBuffer(bytes), '');
  return { bytes, gltf };
}

/** Bind-pose bounds of every mesh primitive (glTF accessor min/max; skinned meshes ignore their node transform). */
function bindBounds(gltf) {
  const box = new THREE.Box3();
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse(object => {
    if (!object.isMesh) return;
    object.geometry.computeBoundingBox();
    const local = object.geometry.boundingBox.clone();
    box.union(object.isSkinnedMesh ? local : local.applyMatrix4(object.matrixWorld));
  });
  return box;
}

/** Size of the model box after the manifest's coordinateTransform (rotation about Y by forward, uniform scale, origin offset). */
function placedBox(box, transform) {
  const angle = Math.atan2(transform.forward.x, transform.forward.z), offset = transform.originOffset ?? { x: 0, y: 0, z: 0 };
  const matrix = new THREE.Matrix4().compose(new THREE.Vector3(offset.x, offset.y, offset.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle), new THREE.Vector3(1, 1, 1).multiplyScalar(transform.scale));
  return box.clone().applyMatrix4(matrix);
}

const within = (measured, stated) => Math.abs(measured - stated) <= stated * TOLERANCE;

describe('canopy.json manifest', () => {
  it('lists the playtest asset set with blocked evidence', () => {
    const ids = manifest.map(item => item.id);
    for (const id of ['whispering-canopy-environment', 'actor-aren', 'actor-vara', 'prop-greenwake-root-gate', 'prop-warden-glaive', ...Object.keys(MONSTERS), ...REGION_PROPS]) assert.ok(ids.includes(id), `missing ${id}`);
    assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
    for (const item of manifest) assert.equal(item.evidenceStatus, 'blocked', `${item.id} must stay evidence-blocked`);
  });

  it('composes the environment from exactly the five region props', () => {
    const environment = entry('whispering-canopy-environment');
    assert.equal(environment.sourceType, 'composed-recipe');
    assert.equal(environment.kind, 'environment');
    assert.deepEqual([...environment.componentAssetIds].sort(), [...REGION_PROPS].sort());
  });

  it('copies the shared Greenwake entries unchanged', async () => {
    const greenwake = JSON.parse(await readFile(`${root}/asset-source/playtests/greenwake.json`, 'utf8'));
    for (const id of ['actor-aren', 'actor-vara', 'prop-greenwake-root-gate', 'prop-warden-glaive']) assert.deepEqual(entry(id), greenwake.find(item => item.id === id), `${id} must match greenwake.json`);
  });

  it('every runtimeUrl resolves to a local GLB whose sha256 matches outputHash', async () => {
    let checked = 0;
    for (const item of manifest) {
      if (!item.runtimeUrl) continue;
      assert.match(item.outputHash ?? '', /^[0-9a-f]{64}$/, `${item.id} needs a sha256 outputHash`);
      const path = localPath(item.runtimeUrl);
      assert.ok(existsSync(path), `${item.id}: ${item.runtimeUrl} does not exist`);
      assert.equal(sha256(await readFile(path)), item.outputHash, `${item.id}: outputHash does not match the file`);
      checked++;
    }
    assert.ok(checked >= 12, `expected at least 12 runtime GLBs, found ${checked}`);
  });

  it('every Tripo source task of the new assets is in the generation log', async () => {
    const log = (await readFile(`${root}/asset-source/generated/canopy-tripo-log.jsonl`, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const logged = new Set(log.flatMap(row => [row.task_id, ...(row.tasks ?? []).map(task => task.task_id)]).filter(Boolean));
    for (const id of [...Object.keys(MONSTERS), ...REGION_PROPS]) {
      const item = entry(id);
      assert.ok(logged.has(item.tripoSourceTask), `${id}: Tripo task ${item.tripoSourceTask} is not in canopy-tripo-log.jsonl`);
    }
    assert.ok(log.some(row => row.event === 'balance-before') && log.some(row => row.event === 'balance-after'), 'log must record the Tripo balance before and after');
  });
});

describe('canopy monsters', () => {
  for (const [id, actorId] of Object.entries(MONSTERS)) {
    describe(id, () => {
      let item, loaded, report;
      before(async () => {
        item = entry(id);
        loaded = await loadGlb(item.runtimeUrl);
        report = JSON.parse(await readFile(localPath(`/${item.provenance}`), 'utf8'));
      });

      it('maps all ten clip slots to native named clips', () => {
        assert.equal(item.actorId, actorId);
        assert.equal(item.kind, 'character');
        assert.equal(item.sourceType, 'native-glb');
        const names = new Set(loaded.gltf.animations.map(clip => clip.name));
        for (const slot of SLOTS) {
          const clipName = item.actionToClipMapping[slot];
          assert.ok(clipName, `${id}: ${slot} is not mapped`);
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

      it('plays every slot clip in place (hips stay over the actor origin)', () => {
        const anchor = report.inPlaceAnchorBone;
        assert.ok(anchor, 'clips-report must name the in-place anchor bone');
        let skinned;
        loaded.gltf.scene.traverse(object => { if (object.isSkinnedMesh) skinned = object; });
        assert.ok(skinned, 'runtime GLB must contain a skinned mesh');
        const bone = skinned.skeleton.bones.find(candidate => candidate.name === sanitize(anchor));
        assert.ok(bone, `anchor bone ${anchor} missing`);
        const box = bindBounds(loaded.gltf), span = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
        const mixer = new THREE.AnimationMixer(loaded.gltf.scene);
        const origin = new THREE.Vector3();
        loaded.gltf.scene.updateMatrixWorld(true);
        const rest = bone.getWorldPosition(origin.clone());
        for (const slot of Object.keys(item.actionToClipMapping)) {
          const clip = loaded.gltf.animations.find(candidate => candidate.name === item.actionToClipMapping[slot]);
          const action = mixer.clipAction(clip);
          action.play();
          let worst = 0;
          for (let step = 0; step <= 12; step++) {
            action.time = clip.duration * step / 12;
            mixer.update(0);
            loaded.gltf.scene.updateMatrixWorld(true);
            const position = bone.getWorldPosition(new THREE.Vector3());
            worst = Math.max(worst, Math.hypot(position.x - rest.x, position.z - rest.z));
          }
          action.stop();
          assert.ok(worst <= 0.12 * span, `${id}: ${slot} (${clip.name}) drifts ${(worst / span * 100).toFixed(1)}% of the body span from the actor origin`);
        }
      });

      it('has the stated size with its base on y = 0', () => {
        const placed = placedBox(bindBounds(loaded.gltf), item.coordinateTransform);
        const stated = STATED[id];
        if (stated.height) assert.ok(within(placed.max.y - placed.min.y, stated.height), `${id}: height ${(placed.max.y - placed.min.y).toFixed(2)} m vs ${stated.height} m`);
        const horizontal = Math.max(placed.max.x - placed.min.x, placed.max.z - placed.min.z);
        if (stated.wingspan) assert.ok(within(horizontal, stated.wingspan), `${id}: wingspan ${horizontal.toFixed(2)} m vs ${stated.wingspan} m`);
        if (stated.length) assert.ok(within(horizontal, stated.length), `${id}: length ${horizontal.toFixed(2)} m vs ${stated.length} m`);
        assert.ok(Math.abs(placed.min.y) <= 0.05, `${id}: base at y = ${placed.min.y.toFixed(3)}`);
      });

      it('records how every slot clip was produced', () => {
        for (const slot of SLOTS) {
          const produced = report.slots[slot];
          assert.ok(produced, `${id}: clips-report has no ${slot}`);
          assert.ok(['preset', 'preset-conditioned', 'authored'].includes(produced.produced), `${id}: ${slot} produced=${produced.produced}`);
          assert.ok(produced.durationSeconds > 0);
        }
      });
    });
  }
});

describe('canopy decoration triangle budgets', () => {
  for (const [id, budget] of Object.entries(TRIANGLE_BUDGET)) {
    it(`${id} stays within ${budget} triangles`, async () => {
      const { gltf } = await loadGlb(entry(id).runtimeUrl);
      let triangles = 0;
      gltf.scene.traverse(object => { if (object.isMesh) triangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3; });
      assert.ok(triangles > 500, `${id}: only ${triangles} triangles, the silhouette is gone`);
      assert.ok(triangles <= budget, `${id}: ${triangles} triangles exceed the ${budget} budget`);
    });
  }
});

describe('canopy props', () => {
  for (const id of REGION_PROPS) {
    describe(id, () => {
      let item, loaded;
      before(async () => { item = entry(id); loaded = await loadGlb(item.runtimeUrl); });

      it('is a static native prop with the stated size and its base on y = 0', () => {
        assert.equal(item.kind, 'prop');
        assert.equal(item.sourceType, 'native-glb');
        assert.equal(loaded.gltf.animations.length, 0);
        const placed = placedBox(bindBounds(loaded.gltf), item.coordinateTransform);
        const stated = STATED[id], size = placed.getSize(new THREE.Vector3());
        if (stated.height) assert.ok(within(size.y, stated.height), `${id}: height ${size.y.toFixed(2)} m vs ${stated.height} m`);
        if (id === 'prop-vine-bridge') {
          assert.ok(within(size.z, stated.length), `${id}: length ${size.z.toFixed(2)} m vs ${stated.length} m`);
          assert.ok(within(size.x, stated.width), `${id}: width ${size.x.toFixed(2)} m vs ${stated.width} m`);
        } else if (stated.width) assert.ok(within(Math.max(size.x, size.z), stated.width), `${id}: width ${Math.max(size.x, size.z).toFixed(2)} m vs ${stated.width} m`);
        if (id !== 'prop-vine-bridge') assert.ok(Math.abs(placed.min.y) <= 0.05, `${id}: base at y = ${placed.min.y.toFixed(3)}`);
      });
    });
  }

  it('prop-vine-bridge is at least 11 m long along +z with a level deck at local y 0', async () => {
    const item = entry('prop-vine-bridge'), { gltf } = await loadGlb(item.runtimeUrl);
    const { scale } = item.coordinateTransform, offsetY = item.coordinateTransform.originOffset?.y ?? 0;
    assert.deepEqual(item.coordinateTransform.forward, { x: 0, y: 0, z: 1 }, 'the bridge length must run along local +z');
    const box = bindBounds(gltf);
    assert.ok((box.max.z - box.min.z) * scale >= 11, `bridge is ${((box.max.z - box.min.z) * scale).toFixed(2)} m long`);
    assert.ok((box.max.z - box.min.z) > (box.max.x - box.min.x) * 2, 'the length axis must be z');
    // Top surface along the centre line (x = 0, between the rails): vertical ray against every triangle.
    const triangles = [];
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse(object => {
      if (!object.isMesh) return;
      const position = object.geometry.attributes.position, index = object.geometry.index;
      const vertex = i => new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
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
    const heights = [];
    const zMin = box.min.z + 0.04 * (box.max.z - box.min.z), zMax = box.max.z - 0.04 * (box.max.z - box.min.z);
    for (let k = 0; k <= 48; k++) {
      const z = zMin + (zMax - zMin) * k / 48, h = topAt(0, z);
      if (Number.isFinite(h)) heights.push(h * scale + offsetY); // planks are separated by gaps
    }
    assert.ok(heights.length >= 36, `only ${heights.length} of 49 centre-line samples hit the deck`);
    const spread = Math.max(...heights) - Math.min(...heights), mean = heights.reduce((a, b) => a + b, 0) / heights.length;
    assert.ok(spread <= 0.25, `deck height varies ${spread.toFixed(3)} m along its length (limit 0.25 m)`);
    assert.ok(Math.abs(mean) <= 0.06, `deck sits ${mean.toFixed(3)} m from local y 0`);
  });
});
