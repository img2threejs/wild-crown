import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { StoryPresentation } from '../../src/effects/StoryPresentation.js';
import type { AttackId } from '../../src/game/contracts.js';
import type { StoryCue } from '../../src/effects/story-cues.js';

const cases = [
  ['asha-guarding-pounce', 'strike', 3, 3],
  ['asha-claw-combination', 'sweep', 4.6, 2.2],
  ['asha-ground-wave', 'wave', 7, 1.4],
  ['koro-fruit-burst', 'area', 3.4, 3.4],
  ['poacher-scout-net', 'projectile', 1.3, 1.3],
] as const;

for (const reducedEffects of [false, true]) {
  for (const [attackId, family, width, length] of cases) {
    test(`${family} footprint encloses the authored danger boundary in ${reducedEffects ? 'reduced' : 'normal'} mode without moving over time`, () => {
      const scene = new THREE.Scene();
      const presentation = new StoryPresentation({ scene, reducedEffects });
      const cue: StoryCue = { instanceId: family, tick: 60, worldTimeSeconds: 1, kind: 'anticipation', phase: 'anticipation', attackId: attackId as AttackId, position: { x: 0, y: 0, z: 0 }, footprint: { width, length, angleRadians: 0 }, durationTicks: 60, priority: 'essential', shape: family === 'sweep' ? 'arc' : family === 'wave' ? 'wave' : family === 'area' ? 'ring' : 'burst' };
      presentation.consumeTick([cue]);
      presentation.update({ simulationTick: 60, worldTick: 60, worldTimeSeconds: 1, timeScale: 1, policy: 'normal' });
      const mesh = presentation.effects.group.children[0] as THREE.Mesh;
      const initial = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
      assert.ok(Math.abs(initial.x - width) < 1e-5, `width ${initial.x} != ${width}`);
      assert.ok(Math.abs(initial.z - length) < 1e-5, `length ${initial.z} != ${length}`);
      assert.ok(initial.y < 0.08, 'danger must stay on the ground rather than obscure feet with a burst sphere');
      if (family === 'sweep' || family === 'wave' || family === 'area') {
        const points = mesh.geometry.getAttribute('position');
        assert.ok(Array.from({ length: points.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(points, i)).some(p => Math.abs(Math.abs(p.x) - width / 2) < 1e-5 && Math.abs(Math.abs(p.z) - length / 2) < 1e-5), 'rectangular corner must be marked, not replaced by an inscribed ellipse/arc');
      }
      presentation.update({ simulationTick: 180, worldTick: 75, worldTimeSeconds: 1.25, timeScale: 0.25, policy: 'perfect-dodge-slow' });
      assert.ok(initial.distanceTo(new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3())) < 1e-8);
      const opacity = (mesh.material as THREE.MeshBasicMaterial).opacity;
      presentation.update({ simulationTick: 200, worldTick: 75, worldTimeSeconds: 1.25, timeScale: 0, policy: 'paused' });
      assert.equal((mesh.material as THREE.MeshBasicMaterial).opacity, opacity);
      assert.ok(mesh.visible);
      presentation.onInterrupt(cue.scopeId ?? 'unused');
      presentation.onDeath();
      assert.equal(presentation.activeEffectCount, 0);
      presentation.dispose();
    });
  }
}

test('cancellation stream removes only the interrupted attack and never creates a cue or sound', () => {
  const presentation = new StoryPresentation({ scene: new THREE.Scene() });
  const base: StoryCue = { instanceId: 'attack-a', tick: 1, worldTimeSeconds: 0, kind: 'anticipation', phase: 'anticipation', scopeId: 'a' };
  presentation.consumeTick([base, { ...base, instanceId: 'attack-b', scopeId: 'b' }]);
  assert.deepEqual(presentation.consumeTick([{ ...base, instanceId: 'cancel-a', kind: 'cancel', cancellationReason: 'interrupt' }]), { effects: 0, sounds: 0 });
  assert.equal(presentation.activeEffectCount, 1);
  for (const cancellationReason of ['death', 'unload', 'skip', 'load'] as const) {
    presentation.consumeTick([{ ...base, instanceId: cancellationReason, scopeId: cancellationReason }]);
    presentation.consumeTick([{ ...base, instanceId: 'cancel-' + cancellationReason, kind: 'cancel', scopeId: undefined, cancellationReason }]);
    assert.equal(presentation.activeEffectCount, 0);
  }
  presentation.dispose();
});

test('fractional commit lifetime expires at the engine deadline without rounding up', () => {
  const presentation = new StoryPresentation({ scene: new THREE.Scene() });
  presentation.consumeTick([{ instanceId: 'fractional', tick: 200, worldTimeSeconds: 3, kind: 'commit', phase: 'commit', attackId: 'asha-ground-wave' as AttackId, position: { x: 0, y: 0, z: 0 }, footprint: { width: 7, length: 1.4 }, durationTicks: 0.25, shape: 'wave' }]);
  presentation.update({ simulationTick: 201, worldTick: 180.125, worldTimeSeconds: 3 + 0.125 / 60, timeScale: 0.25, policy: 'perfect-dodge-slow' });
  assert.equal(presentation.activeEffectCount, 1);
  presentation.update({ simulationTick: 202, worldTick: 180.3, worldTimeSeconds: 3 + 0.3 / 60, timeScale: 0.25, policy: 'perfect-dodge-slow' });
  assert.equal(presentation.activeEffectCount, 0);
  presentation.dispose();
});

test('authored roar sector marks both radial safe edges without extending outside its radius or aperture', () => {
  const presentation = new StoryPresentation({ scene: new THREE.Scene(), reducedEffects: true });
  const radius = 4; const halfAngle = 35 * Math.PI / 180;
  presentation.consumeTick([{ instanceId: 'cone', tick: 0, worldTimeSeconds: 0, kind: 'anticipation', phase: 'anticipation', attackId: 'asha-protective-roar' as AttackId, position: { x: 0, y: 0, z: 0 }, footprint: { width: 7, length: radius * 2, angleRadians: Math.PI / 2, sectorRadians: halfAngle * 2 }, durationTicks: 54, shape: 'sector' }]);
  const mesh = presentation.effects.group.children[0] as THREE.Mesh;
  const points = mesh.geometry.getAttribute('position');
  let edgeVertices = 0; let maxRadius = 0;
  for (let i = 0; i < mesh.geometry.drawRange.count; i++) {
    const x = points.getX(i); const z = points.getZ(i); const distance = Math.hypot(x, z);
    if (distance === 0) { edgeVertices++; continue; }
    assert.ok(Math.abs(Math.atan2(x, z)) <= halfAngle + 1e-6);
    assert.ok(distance <= radius + 1e-6);
    maxRadius = Math.max(maxRadius, distance);
  }
  assert.ok(edgeVertices > 0, 'sector radial borders must reach the source instead of drawing only a distant rim');
  assert.ok(Math.abs(maxRadius - radius) < 1e-6);
  presentation.update({ simulationTick: 0, worldTick: 0, worldTimeSeconds: 0, timeScale: 1, policy: 'normal' });
  const bounds = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
  assert.ok(Math.abs(bounds.x - radius) < 1e-6, 'sector yaw comes directly from the authored orientation');
  presentation.dispose();
});
