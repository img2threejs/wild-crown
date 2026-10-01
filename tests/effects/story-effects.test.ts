import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { StoryEffects } from '../../src/effects/StoryEffects.js';
import type { WorldClockSnapshot } from '../../src/game/contracts.js';
import type { StoryCue } from '../../src/effects/story-cues.js';

function cue(instanceId: string, kind: StoryCue['kind'], phase: StoryCue['phase'] = 'hit', extra: Partial<StoryCue> = {}): StoryCue {
  return { instanceId, tick: 120, worldTick: 120, worldTimeSeconds: 2, kind, phase, position: { x: 4, y: 0.1, z: -3 }, scopeId: 'encounter-a', ...extra };
}

function worldClock(simulationTick: number, worldTick: number, timeScale = 1, policy: WorldClockSnapshot['policy'] = 'normal'): WorldClockSnapshot {
  return { simulationTick, worldTick, worldTimeSeconds: worldTick / 60, timeScale, policy };
}

test('cue instances deduplicate and cancellation only releases matching scope', () => {
  const scene = new THREE.Scene();
  const effects = new StoryEffects({ scene, capacity: 8 });
  assert.equal(effects.emit(cue('windup-a', 'anticipation', 'anticipation')), true);
  assert.equal(effects.emit(cue('windup-a', 'anticipation', 'anticipation')), false);
  assert.equal(effects.emit(cue('hit-b', 'hit', 'hit', { scopeId: 'encounter-b' })), true);
  assert.equal(effects.activeCount, 2);

  effects.cancelScope('encounter-a', 'interrupt');
  assert.equal(effects.activeCount, 1);
  assert.equal(effects.emit(cue('land-c', 'landing')), true);
  assert.equal(effects.activeCount, 2);
  effects.cancelAll('load');
  assert.equal(effects.activeCount, 0);
  assert.equal(effects.emit(cue('windup-a', 'anticipation', 'anticipation')), true, 'load resets the dedup namespace for a reused local event ID');
  effects.dispose();
  assert.equal(scene.children.length, 0);
});

test('essential telegraphs retain reserved capacity and evict cosmetics first', () => {
  const scene = new THREE.Scene();
  const effects = new StoryEffects({ scene, capacity: 8 });
  for (let i = 0; i < 6; i++) assert.equal(effects.emit(cue(`cosmetic-${i}`, 'sap-vein', 'sustain', { position: { x: 12 + i, y: 0.04, z: 9 }, shape: 'vein' })), true);
  assert.equal(effects.emit(cue('cosmetic-overflow', 'footprint')), false);
  for (let i = 0; i < 7; i++) assert.equal(effects.emit(cue(`telegraph-${i}`, 'anticipation', 'anticipation', { position: { x: i, y: 0, z: 0 }, priority: 'essential', footprint: { width: 2.4, length: 4.8, angleRadians: 0.3 } })), true);
  assert.equal(effects.activeCount, 8);
  assert.equal(effects.emit(cue('last-telegraph', 'commit', 'commit', { priority: 'essential' })), true);
  assert.equal(effects.activeCount, 8);
  effects.update(worldClock(120, 120));
  const meshes = effects.group.children as THREE.Mesh[];
  assert.equal(meshes.some((mesh) => mesh.position.x >= 12 && mesh.position.x < 18 && mesh.visible), false);
  const telegraph = meshes.find((mesh) => mesh.position.x === 0 && mesh.position.z === 0);
  assert.ok(telegraph?.visible);
  assert.equal(telegraph!.position.x, 0);
  assert.equal(telegraph!.position.z, 0);
  effects.dispose();
});

test('reduced effects retains tether endpoints and shape, and elapsed time releases the pool', () => {
  const scene = new THREE.Scene();
  const effects = new StoryEffects({ scene, capacity: 8, reducedEffects: true });
  assert.equal(effects.emit(cue('tether-1', 'tether', 'sustain', { position: undefined, from: { x: 2, y: 0.8, z: 1 }, to: { x: 7, y: 1.1, z: 3 }, shape: 'beam', durationTicks: 12 })), true);
  const beam = effects.group.children[0] as THREE.Mesh;
  assert.ok(beam.geometry instanceof THREE.CylinderGeometry);
  assert.ok(beam.material instanceof THREE.MeshBasicMaterial);
  assert.equal(beam.position.x, 4.5);
  assert.ok(Math.abs(beam.position.y - 0.95) < 1e-9);
  assert.equal(beam.position.z, 2);
  effects.update(worldClock(132, 123, 0.25, 'perfect-dodge-slow'));
  assert.equal(effects.currentTick, 132);
  assert.equal(effects.activeCount, 1);
  const slowOpacity = beam.material.opacity;
  effects.update(worldClock(144, 123, 0, 'paused'));
  assert.equal(effects.currentTick, 144, 'simulation ticks still advance while world time is paused');
  assert.equal(effects.activeCount, 1);
  assert.equal(beam.material.opacity, slowOpacity, 'zero world-time advancement freezes VFX');
  effects.update(worldClock(145, 132));
  assert.equal(effects.currentTick, 145);
  assert.equal(effects.activeCount, 0);
  effects.dispose();
});

test('restoration stages keep distinct ecological geometry at the same fixed tick', () => {
  const scene = new THREE.Scene();
  const effects = new StoryEffects({ scene, capacity: 8 });
  const stages = ['restoration-water', 'restoration-roots', 'restoration-seeds', 'restoration-animals'] as const;
  for (const [index, kind] of stages.entries()) {
    assert.equal(effects.emit(cue(`restore-${kind}`, kind, 'resolve', { position: { x: index, y: 0.05, z: 0 }, durationTicks: 60 })), true);
  }
  effects.update(worldClock(120, 120));
  const meshes = effects.group.children as THREE.Mesh[];
  assert.ok(meshes[0]!.geometry instanceof THREE.TorusGeometry);
  assert.ok(meshes[1]!.geometry instanceof THREE.CircleGeometry);
  assert.ok(meshes[2]!.geometry instanceof THREE.SphereGeometry);
  assert.ok(meshes[3]!.geometry instanceof THREE.RingGeometry);
  assert.deepEqual(meshes.slice(0, 4).map((mesh) => mesh.position.x), [0, 1, 2, 3]);
  assert.equal(effects.activeCount, 4);
  effects.dispose();
});

test('authored sector keeps world angle/normal, dimensions, and footprint across ticks', () => {
  const scene = new THREE.Scene();
  const effects = new StoryEffects({ scene, capacity: 8 });
  const position = { x: 4, y: 0, z: -3 };
  assert.equal(effects.emit(cue('cone-telegraph', 'anticipation', 'anticipation', {
    shape: 'sector', position, footprint: { width: 2, length: 4, angleRadians: Math.PI / 2, sectorRadians: Math.PI / 2 },
  })), true);
  const sector = effects.group.children[0] as THREE.Mesh;
  const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(sector.getWorldQuaternion(new THREE.Quaternion())).normalize();
   assert.ok(Math.abs(normal.x) < 1e-9 && Math.abs(normal.y - 1) < 1e-9 && Math.abs(normal.z) < 1e-9);
   let maxRadius = 0;
   const attr = sector.geometry.getAttribute('position');
  const centerRay = new THREE.Vector3().fromBufferAttribute(attr, 20 * 6).applyMatrix4(sector.matrixWorld);
  assert.ok(Math.abs(centerRay.x - position.x - 2) < 1e-6 && Math.abs(centerRay.z - position.z) < 1e-6, 'sector yaw follows its authored world angle');
   for (let i = 0; i < attr.count; i++) {
     const vertex = new THREE.Vector3().fromBufferAttribute(attr, i).applyMatrix4(sector.matrixWorld);
     maxRadius = Math.max(maxRadius, Math.hypot(vertex.x - position.x, vertex.z - position.z));
   }
   assert.ok(Math.abs(maxRadius - 2) < 1e-6);
  const before = new THREE.Box3().setFromObject(sector).getSize(new THREE.Vector3());
  effects.update(worldClock(150, 150));
  sector.updateMatrixWorld(true);
  const after = new THREE.Box3().setFromObject(sector).getSize(new THREE.Vector3());
  assert.ok(before.distanceTo(after) < 1e-9, 'telegraph footprint must not grow or shrink across simulation time');
  assert.equal(effects.activeCount, 1);
  effects.dispose();
});

test('non-square telegraph ring matches its authored width and range at all simulation ticks', () => {
  const scene = new THREE.Scene();
  const effects = new StoryEffects({ scene, capacity: 8, reducedEffects: true });
  assert.equal(effects.emit(cue('rectangle-danger', 'anticipation', 'anticipation', { position: { x: 0, y: 0, z: 0 }, footprint: { width: 2, length: 4, angleRadians: Math.PI / 2 }, durationTicks: 60 })), true);
  const ring = effects.group.children[0] as THREE.Mesh;
  const measure = () => new THREE.Box3().setFromObject(ring).getSize(new THREE.Vector3());
  effects.update(worldClock(120, 120));
  const initial = measure();
  assert.ok(Math.abs(initial.x - 4) < 1e-6);
  assert.ok(Math.abs(initial.z - 2) < 1e-6);
  effects.update(worldClock(150, 150));
  const later = measure();
  assert.ok(initial.distanceTo(later) < 1e-9);
  effects.dispose();
});

test('sector slot refreshes cached bounds when a loaded run reuses a different aperture', () => {
  const scene = new THREE.Scene();
  const effects = new StoryEffects({ scene, capacity: 8 });
  const position = { x: 0, y: 0, z: 0 };
  const narrow = cue('cone-warning', 'anticipation', 'anticipation', { shape: 'sector', position, footprint: { width: 1, length: 4, angleRadians: 0, sectorRadians: Math.PI / 8 } });
  assert.equal(effects.emit(narrow), true);
  const sector = effects.group.children[0] as THREE.Mesh;
  const geometry = sector.geometry as THREE.BufferGeometry;
  geometry.computeBoundingSphere();
  const narrowSphere = geometry.boundingSphere!.clone();
  assert.ok(narrowSphere.radius < 0.3);

  effects.cancelAll('load');
  assert.equal(effects.emit({ ...narrow, footprint: { ...narrow.footprint!, sectorRadians: Math.PI * 2 } }), true);
  assert.equal(sector.geometry, geometry);
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  const currentSphere = geometry.boundingSphere!;
  assert.ok(Math.abs(currentSphere.radius - 1) < 1e-6, 'full-aperture reuse must replace the narrow cached sphere');
  assert.ok(currentSphere.center.length() < 1e-6);
  const vertices = geometry.getAttribute('position');
  for (let i = 0; i < vertices.count; i++) {
    const distance = new THREE.Vector3().fromBufferAttribute(vertices, i).distanceTo(currentSphere.center);
    assert.ok(distance <= currentSphere.radius + 1e-6, `vertex ${i} must remain inside the current cached sphere`);
  }
  effects.dispose();
});

test('essential anticipation remains readable through the last active tick in reduced mode', () => {
  const scene = new THREE.Scene();
  const effects = new StoryEffects({ scene, capacity: 8, reducedEffects: true });
  assert.equal(effects.emit(cue('warning-fade', 'anticipation', 'anticipation', { durationTicks: 60 })), true);
  const warning = effects.group.children[0] as THREE.Mesh;
  effects.update(worldClock(179, 179));
  assert.equal(effects.activeCount, 1);
  assert.equal(warning.visible, true);
  assert.ok(warning.material instanceof THREE.MeshBasicMaterial);
  assert.ok(warning.material.opacity >= 0.3, 'essential warning keeps a readable opacity floor until authoritative expiry');
  effects.update(worldClock(180, 180));
  assert.equal(effects.activeCount, 0);
  assert.equal(warning.visible, false);
  effects.dispose();
});

test('roar telegraph lifetime follows scaled world time and freezes when world time pauses', () => {
  const scene = new THREE.Scene();
  const effects = new StoryEffects({ scene, capacity: 8 });
  assert.equal(effects.emit(cue('roar-slow-warning', 'anticipation', 'anticipation', {
    tick: 100, worldTick: 300, worldTimeSeconds: 5, shape: 'sector', durationTicks: 60, priority: 'essential',
    position: { x: 0, y: 0, z: 0 }, footprint: { width: 3, length: 6, angleRadians: 0, sectorRadians: Math.PI / 3 },
  })), true);
  const warning = effects.group.children[0] as THREE.Mesh;
  assert.ok(warning.material instanceof THREE.MeshBasicMaterial);
  effects.update(worldClock(100, 300));
  effects.update(worldClock(112, 303, 0.25, 'perfect-dodge-slow'));
  assert.equal(effects.currentTick, 112);
  assert.equal(effects.activeCount, 1, '12 simulation steps at 0.25 scale advance only 3 of 60 world ticks');
  assert.ok(warning.visible);
  assert.ok(Math.abs(warning.material.opacity - 0.798) < 1e-9);
  const slowOpacity = warning.material.opacity;

  effects.update(worldClock(124, 303, 0, 'paused'));
  assert.equal(effects.currentTick, 124, 'simulation tick advances independently of paused world time');
  assert.equal(effects.activeCount, 1);
  assert.equal(warning.material.opacity, slowOpacity);

  effects.update(worldClock(181, 360, 1, 'normal'));
  assert.equal(effects.activeCount, 0, 'one full second of world time exhausts the 60-tick warning lifetime');
  assert.equal(warning.visible, false);
  effects.dispose();
});
