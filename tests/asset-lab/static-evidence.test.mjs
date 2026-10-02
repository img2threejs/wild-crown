import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { measureStaticGeometry } from '../../src/asset-lab/measurements.js';

// Disposable native GLB schema probe, never production evidence.
function nativeGlb({ aliasAccessors = false, interleaved = true } = {}) {
  const values = interleaved ? [99, -0.123456789, 0, 0, 99, 1, 0, 0, 99, 0, 1, 0] : [-0.123456789, 0, 0, 1, 0, 0, 0, 1, 0];
  const bin = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bin.writeFloatLE(value, index * 4));
  const json = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }],
    nodes: [{ mesh: 0, name: 'shared-primitives', translation: [4, 2, -3], rotation: [0, 0, Math.sin(0.3), Math.cos(0.3)], scale: [2, 1, 0.5] }, { mesh: 0, name: 'second-node', translation: [-5, 0, 2] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }, { attributes: { POSITION: aliasAccessors ? 1 : 0 }, material: 0 }] }],
    materials: [{}], buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteLength: bin.length, byteStride: interleaved ? 16 : undefined }],
    accessors: Array.from({ length: aliasAccessors ? 2 : 1 }, () => ({ bufferView: 0, byteOffset: interleaved ? 4 : 0, componentType: 5126, count: 3, type: 'VEC3', min: [Math.fround(-0.123456789), 0, 0], max: [1, 1, 0] })),
  };
  const raw = Buffer.from(JSON.stringify(json));
  const chunk = Buffer.concat([raw, Buffer.alloc((4 - raw.length % 4) % 4, 32)]);
  const header = Buffer.alloc(20); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + chunk.length + bin.length, 8); header.writeUInt32LE(chunk.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(bin.length); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, chunk, binHeader, bin]);
}
async function loaded(options) {
  const bytes = nativeGlb(options);
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const meshes = []; gltf.scene.traverse(mesh => { if (mesh.isMesh) meshes.push(mesh); });
  return { bytes, gltf, meshes, sourceHash: createHash('sha256').update(bytes).digest('hex') };
}

test('every loaded native node measures real POSITION and mesh-frustum failure, restoring shared buffers and cache objects', async () => {
  const { bytes, gltf, meshes, sourceHash } = await loaded();
  const caches = meshes.map(mesh => {
    mesh.geometry.computeBoundingSphere();
    return { geometry: mesh.geometry, box: mesh.geometry.boundingBox, boxValue: mesh.geometry.boundingBox.clone(), sphere: mesh.geometry.boundingSphere, sphereValue: mesh.geometry.boundingSphere.clone(), position: mesh.geometry.getAttribute('position'), array: Array.from(mesh.geometry.getAttribute('position').data.array), version: mesh.geometry.getAttribute('position').data.version };
  });
  const result = measureStaticGeometry(gltf, gltf.scene, 'native-static-probe', sourceHash);
  assert.equal(result.status, 'measurement-complete-review-required');
  assert.deepEqual(result.staticGeometry.meshNodes.map(row => row.nodeIndex), [0, 1]);
  for (const row of result.staticGeometry.meshNodes) {
    assert.equal(row.measuredLocalBounds.min[0], Math.fround(-0.123456789));
    const controls = result.negativeControls.filter(control => row.negativeControlIds.includes(control.id));
    assert.equal(controls.length, 2);
    const position = controls.find(control => control.id.startsWith('G10-static-bounds-corruption:'));
    assert.equal(position.measurementBefore.finitePositionCount, 6);
    assert.equal(position.measurementAfter.finitePositionCount, 4);
    assert.equal(position.measurementAfter.nonFinitePositionCount, 2);
    const culling = controls.find(control => control.id.startsWith('G10-wrong-culling-bounds:'));
    assert.deepEqual([culling.measurementBefore.frustumVisible, culling.measurementAfter.frustumVisible], [true, false]);
    assert.deepEqual(culling.measurementBefore.primitives.map(primitive => primitive.frustumVisible), [true, true]);
    assert.deepEqual(culling.measurementAfter.primitives.map(primitive => primitive.frustumVisible), [false, false]);
    for (const control of controls) {
      assert.equal(control.detectedFailure, true); assert.equal(control.restoredAfterTest, true);
      assert.equal(control.assetId, 'native-static-probe'); assert.equal(control.sourceHash, sourceHash);
      assert.equal(control.measurementBefore.nodeIndex, row.nodeIndex); assert.equal(control.measurementAfter.nodeIndex, row.nodeIndex);
    }
  }
  for (const cache of caches) {
    assert.deepEqual(Array.from(cache.position.data.array), cache.array);
    assert.equal(cache.position.data.version, cache.version);
    assert.equal(cache.geometry.boundingBox, cache.box); assert.ok(cache.box.equals(cache.boxValue));
    assert.equal(cache.geometry.boundingSphere, cache.sphere); assert.ok(cache.sphere.equals(cache.sphereValue));
  }
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sourceHash);
});

test('unchanged real frustum predicate cannot be claimed as detected and exception paths restore caches', async () => {
  const { gltf, meshes, sourceHash } = await loaded();
  const original = THREE.Frustum.prototype.intersectsObject;
  const caches = meshes.map(mesh => ({ geometry: mesh.geometry, sphere: mesh.geometry.boundingSphere, box: mesh.geometry.boundingBox }));
  try {
    THREE.Frustum.prototype.intersectsObject = () => true;
    const noop = measureStaticGeometry(gltf, gltf.scene, 'native-static-probe', sourceHash);
    assert.equal(noop.status, 'incomplete');
    assert.ok(noop.negativeControls.filter(control => control.id.startsWith('G10-wrong-culling-bounds:')).every(control => control.detectedFailure === false));
    THREE.Frustum.prototype.intersectsObject = () => { throw new Error('native frustum probe failed'); };
    const failed = measureStaticGeometry(gltf, gltf.scene, 'native-static-probe', sourceHash);
    assert.equal(failed.status, 'incomplete');
  } finally { THREE.Frustum.prototype.intersectsObject = original; }
  for (const cache of caches) { assert.equal(cache.geometry.boundingSphere, cache.sphere); assert.equal(cache.geometry.boundingBox, cache.box); }
});

test('a native POSITION corruption remains rejected rather than repaired by its own controls', async () => {
  const { gltf, meshes, sourceHash } = await loaded();
  const position = meshes[0].geometry.getAttribute('position');
  const original = position.data.array[position.offset];
  try {
    position.data.array[position.offset] = NaN;
    const result = measureStaticGeometry(gltf, gltf.scene, 'native-static-probe', sourceHash);
    assert.equal(result.status, 'incomplete');
    assert.equal(result.staticGeometry.meshNodes[0].nonFinitePositionCount, 2);
    assert.ok(Number.isNaN(position.getX(0)), 'measurement restores the input state, not a fabricated valid position');
  } finally { position.data.array[position.offset] = original; }
});

test('normalized integer POSITION cannot falsely report detection when NaN becomes unchanged zero', async () => {
  const { gltf, meshes, sourceHash } = await loaded();
  gltf.parser.json.accessors[0].min = [0, 0, 0];
  const seen = new Set();
  for (const mesh of meshes) if (!seen.has(mesh.geometry)) {
    seen.add(mesh.geometry);
    mesh.geometry.setAttribute('position', new THREE.Uint16BufferAttribute([0, 0, 0, 65535, 0, 0, 0, 65535, 0], 3, true));
    mesh.geometry.computeBoundingBox(); mesh.geometry.computeBoundingSphere();
  }
  const result = measureStaticGeometry(gltf, gltf.scene, 'native-static-probe', sourceHash);
  assert.equal(result.status, 'incomplete');
  for (const control of result.negativeControls.filter(control => control.id.startsWith('G10-static-bounds-corruption:'))) {
    assert.equal(control.detectedFailure, false);
    assert.equal(control.measurementAfter.finitePositionCount, control.measurementBefore.finitePositionCount);
    assert.equal(control.measurementAfter.nonFinitePositionCount, 0);
  }
  for (const mesh of meshes) assert.equal(mesh.geometry.getAttribute('position').getX(0), 0);
});

for (const interleaved of [false, true]) test('restores original bytes across distinct aliased ' + (interleaved ? 'interleaved/subarray' : 'native accessor') + ' POSITION views', async () => {
  const { gltf, meshes, sourceHash } = await loaded({ aliasAccessors: true, interleaved });
  const first = meshes[0].geometry.getAttribute('position');
  const second = meshes[1].geometry.getAttribute('position');
  if (interleaved) {
    // A second runtime view over the same native interleaved bytes is not the same array object.
    const array = first.data.array.subarray(first.offset);
    second.data = new THREE.InterleavedBuffer(array, first.data.stride);
    second.data.count = first.data.count;
    second.offset = 0;
  }
  const arrays = meshes.slice(0, 2).map(mesh => { const attribute = mesh.geometry.getAttribute('position'); return attribute.array || attribute.data.array; });
  assert.notEqual(arrays[0], arrays[1]); assert.equal(arrays[0].buffer, arrays[1].buffer);
  assert.equal(arrays[0].byteOffset + (first.offset || 0) * arrays[0].BYTES_PER_ELEMENT, arrays[1].byteOffset + (second.offset || 0) * arrays[1].BYTES_PER_ELEMENT);
  const before = Uint8Array.from(new Uint8Array(arrays[0].buffer));
  const caches = meshes.map(mesh => {
    mesh.geometry.computeBoundingSphere();
    const attribute = mesh.geometry.getAttribute('position');
    return { geometry: mesh.geometry, box: mesh.geometry.boundingBox, boxValue: mesh.geometry.boundingBox.clone(), sphere: mesh.geometry.boundingSphere, sphereValue: mesh.geometry.boundingSphere.clone(), attribute, version: attribute.data?.version ?? attribute.version };
  });
  const measured = measureStaticGeometry(gltf, gltf.scene, 'native-static-probe', sourceHash);
  assert.equal(measured.status, 'measurement-complete-review-required');
  assert.ok(measured.negativeControls.every(control => control.detectedFailure && control.restoredAfterTest));
  assert.deepEqual(new Uint8Array(arrays[0].buffer), before);
  for (const cache of caches) {
    assert.equal(cache.attribute.data?.version ?? cache.attribute.version, cache.version);
    assert.equal(cache.geometry.boundingBox, cache.box); assert.ok(cache.box.equals(cache.boxValue));
    assert.equal(cache.geometry.boundingSphere, cache.sphere); assert.ok(cache.sphere.equals(cache.sphereValue));
  }

  // Actual invalid native data makes the culling path throw; its original NaN payload
  // and all aliased bytes must still survive the POSITION control and finally blocks.
  const nativeByte = arrays[0].byteOffset + ((first.offset || 0) + (interleaved ? first.data.stride : first.itemSize)) * arrays[0].BYTES_PER_ELEMENT;
  new DataView(arrays[0].buffer).setUint32(nativeByte, 0x7fc12345, true);
  const invalidBefore = Uint8Array.from(new Uint8Array(arrays[0].buffer));
  const failed = measureStaticGeometry(gltf, gltf.scene, 'native-static-probe', sourceHash);
  assert.equal(failed.status, 'incomplete');
  assert.ok(failed.negativeControls.filter(control => control.id.startsWith('G10-wrong')).every(control => control.detectedFailure === false && control.reason.includes('Native POSITION is non-finite')));
  assert.deepEqual(new Uint8Array(arrays[0].buffer), invalidBefore);
  for (const cache of caches) {
    assert.equal(cache.attribute.data?.version ?? cache.attribute.version, cache.version);
    assert.equal(cache.geometry.boundingBox, cache.box); assert.ok(cache.box.equals(cache.boxValue));
    assert.equal(cache.geometry.boundingSphere, cache.sphere); assert.ok(cache.sphere.equals(cache.sphereValue));
  }
});
