import { describe, expect, it } from 'bun:test';
import { AdditiveBlending, Mesh, Scene } from 'three';
import { ParticlePool, ParticleSpec } from '../../src/effects/vfx/GpuParticles.js';
import { createVfxAtlas } from '../../src/effects/vfx/VfxAtlas.js';
import { StoryEffects } from '../../src/effects/StoryEffects.js';
import type { StoryCue } from '../../src/effects/story-cues.js';
import type { AttackId } from '../../src/game/contracts.js';

describe('GPU particle pools', () => {
  it('never draw more than their capacity and recycle the oldest ring slot', () => {
    const atlas = createVfxAtlas();
    const pool = new ParticlePool('test-pool', 16, atlas, AdditiveBlending);
    try {
      const spec = new ParticleSpec();
      spec.life = 10;
      for (let i = 0; i < 40; i++) pool.emit(spec, 1, i);
      pool.update(1.5);
      expect(pool.drawCount).toBe(16);
      expect(pool.liveCount(1.5)).toBe(16);
      // 40 spawns into 16 slots: slot 0 last held spawn 32, slot 7 spawn 39, the cursor wrapped to 8.
      expect(pool.ownerAt(0)).toBe(32);
      expect(pool.ownerAt(7)).toBe(39);
      expect(pool.nextSlot).toBe(8);
      expect(pool.liveCount(1.5, 3)).toBe(0);
      expect(pool.killOwner(39)).toBe(1);
      expect(pool.liveCount(1.5)).toBe(15);
      expect(pool.liveCount(11.5)).toBe(0);
      pool.clear(); pool.update(2);
      expect(pool.drawCount).toBe(0);
    } finally { pool.dispose(); atlas.dispose(); }
  });

  it('sustained combat stays within ~8k particles in at most two particle draw calls', () => {
    const scene = new Scene();
    const effects = new StoryEffects({ scene, capacity: 48 });
    try {
      const { particles } = effects.vfx;
      expect(particles.capacity).toBeLessThanOrEqual(8000);
      let drawCalls = 0;
      effects.group.traverse(node => { if (node instanceof Mesh && node.name.startsWith('vfx-particles')) drawCalls++; });
      expect(drawCalls).toBe(2);
      // Saturate: many overlapping detonations and sustained venom clouds for several seconds.
      for (let wave = 0; wave < 30; wave++) {
        const tick = wave * 12;
        for (const attackId of ['root-rammer-cinder-burst', 'sap-stalker-frost-bloom', 'sap-stalker-venom-mist', 'boar-ember-lance'] as const) {
          const cue: StoryCue = { instanceId: `${attackId}:${wave}`, scopeId: `${attackId}:${wave}`, tick, worldTick: tick, worldTimeSeconds: tick / 60, kind: 'active', phase: 'active', attackId: attackId as AttackId, priority: 'essential', position: { x: wave % 5, y: 0, z: wave % 3 }, shape: 'burst', footprint: { width: 3, length: 3, angleRadians: 0 }, durationTicks: 180 };
          effects.emit(cue);
        }
        for (let step = 0; step < 12; step++) effects.update({ simulationTick: tick + step, worldTick: tick + step, worldTimeSeconds: (tick + step) / 60, timeScale: 1, policy: 'normal' });
        expect(particles.additive.drawCount).toBeLessThanOrEqual(particles.additive.capacity);
        expect(particles.alpha.drawCount).toBeLessThanOrEqual(particles.alpha.capacity);
        expect(particles.liveCount(effects.vfx.time)).toBeLessThanOrEqual(particles.capacity);
      }
      expect(particles.additive.drawCount).toBe(particles.additive.capacity);
    } finally { effects.dispose(); }
  });
});
