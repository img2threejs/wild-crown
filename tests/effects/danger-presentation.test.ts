import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { StoryPresentation } from '../../src/effects/StoryPresentation.js';
import type { AttackId } from '../../src/game/contracts.js';
import type { StoryCue } from '../../src/effects/story-cues.js';


test('cancellation stream removes only the interrupted attack and never creates a cue or sound', () => {
  const presentation = new StoryPresentation({ scene: new THREE.Scene() });
  const base: StoryCue = { instanceId: 'attack-a', tick: 1, worldTick: 0, worldTimeSeconds: 0, kind: 'anticipation', phase: 'anticipation', scopeId: 'a' };
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
  presentation.consumeTick([{ instanceId: 'fractional', tick: 200, worldTick: 180, worldTimeSeconds: 3, kind: 'commit', phase: 'commit', attackId: 'asha-ground-wave' as AttackId, position: { x: 0, y: 0, z: 0 }, footprint: { width: 7, length: 1.4 }, durationTicks: 0.25, shape: 'wave' }]);
  presentation.update({ simulationTick: 201, worldTick: 180.125, worldTimeSeconds: 3 + 0.125 / 60, timeScale: 0.25, policy: 'perfect-dodge-slow' });
  assert.equal(presentation.activeEffectCount, 1);
  presentation.update({ simulationTick: 202, worldTick: 180.3, worldTimeSeconds: 3 + 0.3 / 60, timeScale: 0.25, policy: 'perfect-dodge-slow' });
  assert.equal(presentation.activeEffectCount, 0);
  presentation.dispose();
});


test('anticipation ends at the exact authoritative windup boundary, not one tick later from seconds roundoff', () => {
  const presentation = new StoryPresentation({ scene: new THREE.Scene() });
  presentation.consumeTick([{ instanceId: 'exact-end', tick: 1, worldTick: 1, worldTimeSeconds: 1 / 60, kind: 'anticipation', phase: 'anticipation', attackId: 'asha-guarding-pounce' as AttackId, position: { x: 0, y: 0, z: 0 }, footprint: { width: 3, length: 3 }, durationTicks: 54, shape: 'burst' }]);
  presentation.update({ simulationTick: 54, worldTick: 54.75, worldTimeSeconds: 54.75 / 60, timeScale: 0.25, policy: 'perfect-dodge-slow' });
  assert.equal(presentation.activeEffectCount, 1, 'quarter tick before deadline remains visible');
  presentation.update({ simulationTick: 55, worldTick: 55, worldTimeSeconds: 55 / 60, timeScale: 1, policy: 'normal' });
  assert.equal(presentation.activeEffectCount, 0);
  presentation.dispose();
});

test('active strike energy survives a missed impact and expires at the authoritative deadline', () => {
  const presentation = new StoryPresentation({ scene: new THREE.Scene(), reducedEffects: true });
  const base = { tick: 67, worldTick: 67, worldTimeSeconds: 67 / 60, attackId: 'asha-guarding-pounce' as AttackId, scopeId: 'pounce-instance', position: { x: 0, y: 0, z: 0 }, footprint: { width: 3, length: 3 }, durationTicks: 9, shape: 'burst' as const };
  presentation.consumeTick([{ ...base, instanceId: 'active-without-hit', kind: 'active', phase: 'active' }]);
  presentation.update({ simulationTick: 75, worldTick: 75.75, worldTimeSeconds: 75.75 / 60, timeScale: 0.25, policy: 'perfect-dodge-slow' });
  assert.equal(presentation.activeEffectCount, 1);
  assert.ok(presentation.effects.vfx.ground.activeCount() > 0, 'the missed strike still detonates its shockwave and crack decal');
  presentation.update({ simulationTick: 76, worldTick: 76, worldTimeSeconds: 76 / 60, timeScale: 1, policy: 'normal' });
  assert.equal(presentation.activeEffectCount, 0);
  presentation.dispose();
});
