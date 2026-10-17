import { describe, expect, it } from 'bun:test';
import { Object3D, Scene } from 'three';
import { StoryEffects } from '../../src/effects/StoryEffects.js';
import { StoryPresentation } from '../../src/effects/StoryPresentation.js';
import type { StoryCue } from '../../src/effects/story-cues.js';
import type { AttackId, WorldClockSnapshot } from '../../src/game/contracts.js';

const clock = (worldTick: number): WorldClockSnapshot => ({ simulationTick: Math.floor(worldTick), worldTick, worldTimeSeconds: worldTick / 60, timeScale: 1, policy: 'normal' });
function attackCue(scopeId: string, attackId: string, phase: 'anticipation' | 'active', worldTick: number, x: number): StoryCue {
  return {
    instanceId: `${scopeId}:${phase}`, scopeId, tick: worldTick, worldTick, worldTimeSeconds: worldTick / 60, kind: phase, phase, attackId: attackId as AttackId,
    actorId: 'monster', priority: 'essential', position: { x, y: 0, z: 0 }, from: { x, y: 0, z: -4 }, to: { x, y: 0, z: 0 },
    shape: 'burst', footprint: { width: 3, length: 3, angleRadians: 0 }, durationTicks: 120,
  };
}

describe('cancelled cues release every pooled resource they own', () => {
  it('a scope cancellation clears its fills, decals, spikes, lights and particles but leaves other scopes intact', () => {
    const scene = new Scene(), socket = new Object3D();
    socket.position.set(0, 1.5, -4);
    const effects = new StoryEffects({ scene, resolveSocket: () => socket });
    try {
      effects.emit(attackCue('stalker', 'sap-stalker-frost-bloom', 'anticipation', 60, -6));
      effects.emit(attackCue('stalker', 'sap-stalker-frost-bloom', 'active', 60, -6));
      effects.emit(attackCue('rammer', 'root-rammer-cinder-burst', 'active', 60, 6));
      for (let tick = 60; tick <= 72; tick += 4) effects.update(clock(tick));
      const { vfx } = effects;
      const before = { ground: vfx.ground.activeCount(), particles: vfx.particles.liveCount(vfx.time) };
      expect(vfx.spikes.livePositions(vfx.time, []).length).toBeGreaterThan(0);
      expect(vfx.lights.activeCount).toBe(2);

      effects.cancelScope('stalker', 'interrupt');
      effects.update(clock(73));
      expect(effects.activeCount).toBe(1);
      expect(vfx.spikes.livePositions(vfx.time, []).length).toBe(0);
      expect(vfx.lights.activeCount).toBe(1);
      const after = { ground: vfx.ground.activeCount(), particles: vfx.particles.liveCount(vfx.time) };
      expect(after.ground).toBeGreaterThan(0);
      expect(after.ground).toBeLessThan(before.ground);
      expect(after.particles).toBeGreaterThan(0);
      expect(after.particles).toBeLessThan(before.particles);

      effects.cancelAll('unload');
      effects.update(clock(74));
      expect(effects.activeCount).toBe(0);
      expect(vfx.ground.activeCount()).toBe(0);
      expect(vfx.particles.liveCount(vfx.time)).toBe(0);
      expect(vfx.lights.activeCount).toBe(0);
      expect(vfx.debris.liveCount).toBe(0);
    } finally { effects.dispose(); }
  });

  it('an anticipation telegraph returns its manual ground fill when it expires or is interrupted', () => {
    const scene = new Scene();
    const effects = new StoryEffects({ scene });
    try {
      effects.emit(attackCue('a', 'root-rammer-slam', 'anticipation', 10, 0));
      effects.update(clock(20));
      expect(effects.vfx.ground.activeCount()).toBe(1);
      effects.update(clock(130));
      expect(effects.activeCount).toBe(0);
      expect(effects.vfx.ground.activeCount()).toBe(0);

      effects.emit(attackCue('b', 'root-rammer-slam', 'anticipation', 140, 0));
      effects.update(clock(150));
      expect(effects.vfx.ground.activeCount()).toBe(1);
      effects.cancelScope('b', 'interrupt');
      expect(effects.vfx.ground.activeCount()).toBe(0);
    } finally { effects.dispose(); }
  });

  it('cancellation cues through the presentation stream also release story beams', () => {
    const presentation = new StoryPresentation({ scene: new Scene() });
    try {
      presentation.consumeTick([{ instanceId: 'tether', scopeId: 'bond', tick: 1, worldTick: 1, worldTimeSeconds: 1 / 60, kind: 'tether', phase: 'sustain', from: { x: 0, y: 1, z: 0 }, to: { x: 4, y: 1, z: 0 }, shape: 'beam', durationTicks: 120 }]);
      presentation.update(clock(5));
      expect(presentation.effects.vfx.beams.activeCount).toBe(1);
      presentation.consumeTick([{ instanceId: 'cancel', scopeId: 'bond', tick: 6, worldTick: 6, worldTimeSeconds: 6 / 60, kind: 'cancel', phase: 'resolve', cancellationReason: 'interrupt' }]);
      expect(presentation.activeEffectCount).toBe(0);
      expect(presentation.effects.vfx.beams.activeCount).toBe(0);
    } finally { presentation.dispose(); }
  });
});
