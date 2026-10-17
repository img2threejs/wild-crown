import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { StoryEffects } from '../../src/effects/StoryEffects.js';
import type { AttackId, WorldClockSnapshot } from '../../src/game/contracts.js';
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
  const visibleGround: THREE.Mesh[] = [];
  effects.group.traverse((node) => { if (node instanceof THREE.Mesh && node.name.startsWith('vfx-ground') && node.visible) visibleGround.push(node); });
  assert.equal(visibleGround.some((mesh) => mesh.position.x >= 12 && mesh.position.x < 18), false, 'evicted cosmetic cues release their ground surfaces');
  effects.dispose();
});

function visibleNamed(root: THREE.Object3D, name: string): THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[] {
  const found: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[] = [];
  root.traverse((node) => { if (node instanceof THREE.Mesh && node.name === name && node.visible) found.push(node as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>); });
  return found;
}

test('reduced effects retains tether endpoints, freezes on paused world time and releases at expiry', () => {
  const scene = new THREE.Scene();
  const effects = new StoryEffects({ scene, capacity: 8, reducedEffects: true });
  assert.equal(effects.emit(cue('tether-1', 'tether', 'sustain', { position: undefined, from: { x: 2, y: 0.8, z: 1 }, to: { x: 7, y: 1.1, z: 3 }, shape: 'beam', durationTicks: 12 })), true);
  effects.update(worldClock(121, 121));
  const [beam] = visibleNamed(effects.group, 'vfx-beam');
  assert.ok(beam, 'tether renders as a beam ribbon');
  const positions = beam.geometry.getAttribute('position');
  const start = new THREE.Vector3().fromBufferAttribute(positions, 0).add(new THREE.Vector3().fromBufferAttribute(positions, 1)).multiplyScalar(0.5);
  const end = new THREE.Vector3().fromBufferAttribute(positions, positions.count - 2).add(new THREE.Vector3().fromBufferAttribute(positions, positions.count - 1)).multiplyScalar(0.5);
  assert.ok(start.distanceTo(new THREE.Vector3(2, 0.8, 1)) < 1e-6, 'beam starts at the authored source');
  assert.ok(end.distanceTo(new THREE.Vector3(7, 1.1, 3)) < 1e-6, 'beam ends at the authored target');
  effects.update(worldClock(132, 123, 0.25, 'perfect-dodge-slow'));
  assert.equal(effects.currentTick, 132);
  assert.equal(effects.activeCount, 1);
  const slowAlpha = beam.material.uniforms.uAlpha!.value;
  effects.update(worldClock(144, 123, 0, 'paused'));
  assert.equal(effects.currentTick, 144, 'simulation ticks still advance while world time is paused');
  assert.equal(effects.activeCount, 1);
  assert.equal(beam.material.uniforms.uAlpha!.value, slowAlpha, 'zero world-time advancement freezes VFX');
  effects.update(worldClock(145, 132));
  assert.equal(effects.currentTick, 145);
  assert.equal(effects.activeCount, 0);
  assert.equal(visibleNamed(effects.group, 'vfx-beam').length, 0, 'expired tether returns its beam to the pool');
  effects.dispose();
});

test('essential attack telegraph fills its footprint through the last anticipation tick in reduced mode', () => {
  const scene = new THREE.Scene();
  const effects = new StoryEffects({ scene, capacity: 8, reducedEffects: true });
  assert.equal(effects.emit(cue('warning-fade', 'anticipation', 'anticipation', { attackId: 'root-rammer-slam' as AttackId, shape: 'burst', footprint: { width: 2.1, length: 2.1, angleRadians: 0 }, durationTicks: 60, priority: 'essential' })), true);
  effects.update(worldClock(179, 179));
  assert.equal(effects.activeCount, 1);
  const [fill] = visibleNamed(effects.group, 'vfx-ground-surface');
  assert.ok(fill, 'the telegraph covers the footprint with a ground fill, not an outline');
  assert.ok(fill.material.uniforms.uAlpha!.value >= 0.3, 'essential telegraph remains readable until authoritative expiry');
  effects.update(worldClock(180, 180));
  assert.equal(effects.activeCount, 0);
  assert.equal(visibleNamed(effects.group, 'vfx-ground-surface').length, 0);
  effects.dispose();
});

test('roar telegraph lifetime follows scaled world time and freezes when world time pauses', () => {
  const scene = new THREE.Scene();
  const effects = new StoryEffects({ scene, capacity: 8 });
  assert.equal(effects.emit(cue('roar-slow-warning', 'anticipation', 'anticipation', {
    tick: 100, worldTick: 300, worldTimeSeconds: 5, shape: 'sector', durationTicks: 60, priority: 'essential', attackId: 'asha-protective-roar' as AttackId,
    position: { x: 0, y: 0, z: 0 }, footprint: { width: 3, length: 6, angleRadians: 0, sectorRadians: Math.PI / 3 },
  })), true);
  effects.update(worldClock(100, 300));
  effects.update(worldClock(112, 303, 0.25, 'perfect-dodge-slow'));
  assert.equal(effects.currentTick, 112);
  assert.equal(effects.activeCount, 1, '12 simulation steps at 0.25 scale advance only 3 of 60 world ticks');
  const [fill] = visibleNamed(effects.group, 'vfx-ground-surface');
  assert.ok(fill);
  const slowProgress = fill.material.uniforms.uProgress!.value;

  effects.update(worldClock(124, 303, 0, 'paused'));
  assert.equal(effects.currentTick, 124, 'simulation tick advances independently of paused world time');
  assert.equal(effects.activeCount, 1);
  assert.equal(fill.material.uniforms.uProgress!.value, slowProgress);

  effects.update(worldClock(181, 360, 1, 'normal'));
  assert.equal(effects.activeCount, 0, 'one full second of world time exhausts the 60-tick warning lifetime');
  assert.equal(fill.visible, false);
  effects.dispose();
});

