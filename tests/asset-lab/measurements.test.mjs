import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { measureG1, measureG3, measureG10, measureStaticGeometry } from '../../src/asset-lab/measurements.js';

function makeCharacter() {
  const root = new THREE.Group();
  const rootBone = new THREE.Bone(); rootBone.name = 'RootBone';
  const wrist = new THREE.Bone(); wrist.name = 'LeftWrist'; wrist.position.y = 0.5; rootBone.add(wrist); root.add(rootBone);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1], 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([0.5, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0.5, 0.5, 0, 0], 4));
  geometry.setIndex([0, 1, 2]);
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial()); mesh.name = 'Body'; root.add(mesh);
  const skeleton = new THREE.Skeleton([rootBone, wrist]); mesh.bind(skeleton); root.updateMatrixWorld(true);
  const wristRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.9);
  const contact = new THREE.AnimationClip('contact-and-wrist', 1, [
    new THREE.VectorKeyframeTrack('RootBone.position', [0, 1], [0, 0, 0, 0, 0.25, 0]),
    new THREE.QuaternionKeyframeTrack('LeftWrist.quaternion', [0, 1], [0, 0, 0, 1, ...wristRotation.toArray()]),
  ]);
  contact.userData = { markers: [
    { type: 'contact-window', startTime: 0.25, endTime: 0.75 },
    { type: 'transition-boundary', time: 0.5 },
  ] };
  const recovery = new THREE.AnimationClip('recovery', 1, [
    new THREE.VectorKeyframeTrack('RootBone.position', [0, 1], [0, 0.25, 0, 0, 0, 0]),
    new THREE.QuaternionKeyframeTrack('LeftWrist.quaternion', [0, 1], [...wristRotation.toArray(), 0, 0, 0, 1]),
  ]);
  recovery.userData = { markers: [
    { type: 'transition-boundary', time: 0.5 },
    { type: 'contact-window', startTime: 0.25, endTime: 0.75 },
  ] };
  const boundsReader = target => {
    target.updateMatrixWorld(true);
    const bounds = new THREE.Box3(); const point = new THREE.Vector3(); let vertices = 0;
    target.traverse(object => {
      if (!object.isMesh) return;
      const position = object.geometry.getAttribute('position');
      for (let i = 0; i < position.count; i++) {
        object.getVertexPosition(i, point); object.localToWorld(point); bounds.expandByPoint(point); vertices++;
      }
    });
    return { min: bounds.min.toArray(), max: bounds.max.toArray(), vertices };
  };
  return { root, mesh, geometry, clips: [contact, recovery], boundsReader };
}

test('native clip and rig measurements remain observable while semantic G10 controls fail closed without authored policies', () => {
  const fixture = makeCharacter(); const originalBoundingSphere = fixture.mesh.boundingSphere;
  const g1 = measureG1(fixture.root, fixture.clips);
  assert.equal(g1.clips.length, 2);
  assert.ok(g1.clips.every(clip => clip.evaluatedBoundProperties && clip.sampleCount >= 5));
  assert.equal(g1.negativeControl.detectedFailure, true);
  assert.equal(g1.status, 'measurement-complete-review-required');
  const g3 = measureG3(fixture.root, fixture.clips);
  assert.equal(g3.negativeControl.detectedFailure, true);
  assert.ok(g3.clipRestores.every(clip => clip.stop.localRestored && clip.stop.worldRestored && clip.reset.localRestored && clip.reset.worldRestored));
  assert.ok(g3.switchTransitions.every(transition => transition.localAndWorld.localRestored && transition.localAndWorld.worldRestored));
  assert.equal(g3.status, 'measurement-complete-review-required');

  const g10 = measureG10(fixture.root, fixture.clips, g1, fixture.boundsReader);
  const controls = new Map(g10.negativeControls.map(control => [control.id, control]));
  for (const id of [
    'G10-broken-planted-contact',
    'G10-mirrored-wrist',
    'G10-torn-skin-with-normalized-weights',
    'G10-wrong-lod-bind',
  ]) {
    assert.equal(controls.get(id)?.evaluationStatus, 'not-evaluated', id);
    assert.equal(controls.get(id)?.detectedFailure, false, id);
    assert.ok(controls.get(id)?.reason, id);
  }
  assert.equal(controls.get('G10-wrong-culling-bounds')?.detectedFailure, true);
  assert.deepEqual([controls.get('G10-wrong-culling-bounds').measurementBefore.frustumVisible, controls.get('G10-wrong-culling-bounds').measurementAfter.frustumVisible], [true, false]);
  assert.equal(controls.get('G10-corrupt-native-skin-weight')?.detectedFailure, true);
  assert.ok(g10.clips.every(clip => clip.contactCoverage && clip.deformedBoundsComplete));
  assert.equal(g10.status, 'incomplete');
  assert.deepEqual(g10.unresolvedSemanticControls.map(control => control.id), [
    'G10-broken-planted-contact', 'G10-mirrored-wrist',
    'G10-torn-skin-with-normalized-weights', 'G10-wrong-lod-bind',
  ]);
  assert.equal(fixture.mesh.geometry.getAttribute('position').getX(0), 0, 'native positions remain unchanged');
  assert.equal(fixture.mesh.geometry.getAttribute('skinWeight').getX(0), 0.5, 'skin-weight probe is restored');
  assert.equal(fixture.mesh.skeleton.boneInverses[0].elements[12], 0, 'bind matrices remain unchanged');
  assert.equal(fixture.mesh.boundingSphere, originalBoundingSphere, 'frustum culling sphere is restored');
  assert.deepEqual(Array.from(fixture.geometry.getAttribute('skinIndex').array.slice(0, 4)), [0, 1, 0, 1], 'skin indices remain unchanged');
  assert.ok(fixture.clips[0].tracks.every(track => track.values.every(Number.isFinite)), 'clip tracks remain unchanged');
});

test('G10 restores pre-existing bounding-sphere object and values after culling probes', () => {
  const fixture = makeCharacter();
  const g1 = measureG1(fixture.root, fixture.clips);
  const cachedSphere = new THREE.Sphere(new THREE.Vector3(4, 5, 6), 7);
  const expectedSphere = cachedSphere.clone();
  fixture.mesh.boundingSphere = cachedSphere;

  const g10 = measureG10(fixture.root, fixture.clips, g1, fixture.boundsReader);
  const control = g10.negativeControls.find(item => item.id === 'G10-wrong-culling-bounds');
  assert.equal(control?.detectedFailure, true);
  assert.equal(fixture.mesh.boundingSphere, cachedSphere);
  assert.deepEqual(fixture.mesh.boundingSphere.center.toArray(), expectedSphere.center.toArray());
  assert.equal(fixture.mesh.boundingSphere.radius, expectedSphere.radius);
});
test('G10 refuses completeness when normalized-byte corruption is unchanged by the native type', () => {
  const fixture = makeCharacter();
  fixture.geometry.setAttribute('skinWeight', new THREE.Uint8BufferAttribute(new Uint8Array([255, 0, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0]), 4, true));
  const g1 = measureG1(fixture.root, fixture.clips);
  const g10 = measureG10(fixture.root, fixture.clips, g1, fixture.boundsReader);
  const corruptWeights = g10.negativeControls.find(control => control.id === 'G10-corrupt-native-skin-weight');
  assert.equal(corruptWeights?.measurementBefore, 'valid');
  assert.equal(corruptWeights?.measurementAfter, 'valid');
  assert.equal(corruptWeights?.detectedFailure, false);
  assert.deepEqual(g10.unresolvedSemanticControls.map(control => control.id), [
    'G10-broken-planted-contact', 'G10-mirrored-wrist',
    'G10-torn-skin-with-normalized-weights', 'G10-wrong-lod-bind',
  ]);
  assert.equal(g10.status, 'incomplete');
});
test('G10 returns an incomplete report for a skinned model with no animation clips', () => {
  const fixture = makeCharacter();
  const g10 = measureG10(fixture.root, [], { clips: [] }, fixture.boundsReader);
  assert.equal(g10.skinIntegrity.status, 'valid');
  assert.deepEqual(g10.clips, []);
  assert.equal(g10.status, 'incomplete');
});

test('native static bounds accept matching accessors and reject corrupted accessor bounds', () => {
  const root = new THREE.Group();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, -1, 1, 0, -1, 0, 2, 1], 3));
  geometry.setIndex([0, 1, 2]); geometry.computeBoundingBox();
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()); mesh.name = 'StaticProp'; root.add(mesh);
  const gltf = {
    parser: {
      json: { nodes: [{ name: 'StaticProp', mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ min: [-1, 0, -1], max: [1, 2, 1] }], buffers: [], images: [] },
      associations: new Map([[mesh, { nodes: 0, meshes: 0, primitives: 0 }]]),
    },
  };
  const valid = measureStaticGeometry(gltf, root, 'fixture-static');
  assert.equal(valid.status, 'measurement-complete-review-required');
  const staticControl = valid.negativeControls.find(control => control.id === 'G10-static-bounds-corruption:0');
  assert.equal(staticControl?.detectedFailure, true);
  assert.equal(staticControl?.measurementBefore.finitePositionCount, 3);
  assert.equal(staticControl?.measurementAfter.finitePositionCount, 2);
  assert.equal(staticControl?.measurementAfter.nonFinitePositionCount, 1);
  const originalCachedBounds = geometry.boundingBox;
  const wrongCachedBounds = geometry.boundingBox.clone();
  wrongCachedBounds.min.x += 5; wrongCachedBounds.max.x += 5;
  geometry.boundingBox = wrongCachedBounds;
  const wrongCache = measureStaticGeometry(gltf, root, 'fixture-static');
  assert.equal(wrongCache.status, 'incomplete');
  assert.equal(wrongCache.staticGeometry.meshNodes[0].cachedBoundsMatch, false);
  geometry.boundingBox = originalCachedBounds;

  const position = geometry.getAttribute('position');
  const originalPosition = position.array[0];
  position.array[0] = Number.NaN; position.needsUpdate = true;
  const corruptNativePosition = measureStaticGeometry(gltf, root, 'fixture-static');
  assert.equal(corruptNativePosition.status, 'incomplete');
  assert.equal(corruptNativePosition.staticGeometry.meshNodes[0].nonFinitePositionCount, 1);
  position.array[0] = originalPosition; position.needsUpdate = true;

  
  gltf.parser.json.accessors[0].max[1] = 20;
  const wrongAccessor = measureStaticGeometry(gltf, root, 'fixture-static');
  assert.equal(wrongAccessor.status, 'incomplete');
  assert.equal(wrongAccessor.staticGeometry.meshNodes[0].accessorBoundsMatch, false);
});
