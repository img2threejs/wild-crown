import { describe, expect, it } from 'bun:test';
import { Object3D, Scene } from 'three';
import { StoryEffects } from '../../src/effects/StoryEffects.js';
import type { StoryCue } from '../../src/effects/story-cues.js';
import type { ParticlePool } from '../../src/effects/vfx/GpuParticles.js';
import { VFX_FRAME } from '../../src/effects/vfx/VfxAtlas.js';
import type { ActionId } from '../../src/game/contracts.js';

const BLOW_FROM = { x: 2, y: 0.9, z: 1 };
const clock = (tick: number) => ({ simulationTick: tick, worldTick: tick, worldTimeSeconds: tick / 60, timeScale: 0, policy: 'normal' as const });

function strike(tick: number, patch: Partial<StoryCue> = {}): StoryCue {
  return {
    instanceId: `hit:${tick}:${patch.confirmedDamage}:${patch.actionId}:${patch.scopeId}`, tick, worldTick: tick, worldTimeSeconds: tick / 60, kind: 'hit', phase: 'hit',
    actorId: 'aren', targetId: 'greenwake-root-rammer', actionId: 'aren-light-1' as ActionId, position: BLOW_FROM, to: { x: 3, y: 0.9, z: 1 },
    element: 'arcane', priority: 'essential', shape: 'burst', intensity: 1, ...patch,
  } as StoryCue;
}

interface Stage { readonly effects: StoryEffects; readonly alpha: ParticlePool; readonly additive: ParticlePool }

function stage(reducedEffects = false): Stage {
  const monster = new Object3D();
  monster.position.set(2.4, 0, 1);
  const effects = new StoryEffects({ scene: new Scene(), reducedEffects, resolveActorRoot: id => (id === 'greenwake-root-rammer' ? monster : undefined) });
  return { effects, alpha: effects.vfx.particles.alpha, additive: effects.vfx.particles.additive };
}
const live = (s: Stage): number => s.alpha.liveCount(s.effects.vfx.time) + s.additive.liveCount(s.effects.vfx.time);

/** One GPU particle as the vertex shader sees it, read back from the pool's real instance attributes. */
interface Particle {
  readonly born: number; readonly life: number; readonly frame: number; readonly r: number; readonly g: number; readonly b: number;
  readonly a0: number; readonly fadeIn: number; readonly fadeOut: number;
  readonly origin: readonly [number, number, number]; readonly velocity: readonly [number, number, number];
}
function readPool(pool: ParticlePool): Particle[] {
  const a = (name: string) => pool.mesh.geometry.getAttribute(name).array;
  const origin = a('iOrigin'), velocity = a('iVelocity'), timing = a('iTiming'), c0 = a('iColor0'), c1 = a('iColor1'), misc = a('iMisc');
  const out: Particle[] = [];
  for (let i = 0; i < pool.drawCount; i++) {
    out.push({
      born: timing[i * 4]!, life: timing[i * 4 + 1]!, frame: misc[i * 4]!, r: c0[i * 4]!, g: c0[i * 4 + 1]!, b: c0[i * 4 + 2]!, a0: c0[i * 4 + 3]!, fadeIn: c1[i * 4 + 3]!, fadeOut: misc[i * 4 + 2]!,
      origin: [origin[i * 3]!, origin[i * 3 + 1]!, origin[i * 3 + 2]!], velocity: [velocity[i * 3]!, velocity[i * 3 + 1]!, velocity[i * 3 + 2]!],
    });
  }
  return out;
}
const smoothstep = (edge0: number, edge1: number, x: number): number => { const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0))); return t * t * (3 - 2 * t); };
/** The vertex shader's alpha at `time` (0 when not yet born or expired). */
function alphaAt(p: Particle, time: number): number {
  const t = (time - p.born) / p.life;
  return p.life <= 0 || t < 0 || t >= 1 ? 0 : p.a0 * smoothstep(0, Math.max(p.fadeIn, 1e-3), t) * (1 - smoothstep(p.fadeOut, 1, t));
}
/** Red blood droplets in the alpha pool alive at `time`. */
const bloodDrops = (s: Stage, time: number): Particle[] => readPool(s.alpha).filter(p => p.frame === VFX_FRAME.drop && p.r > 8 * p.g && p.r > 8 * p.b && p.life > 0 && time >= p.born && time < p.born + p.life);
const HIT_TICK = 10, HIT_TIME = HIT_TICK / 60;

describe('confirmed hit impacts', () => {
  it('draws nothing for a strike that lost no vitality', () => {
    const s = stage();
    try {
      expect(s.effects.emit(strike(HIT_TICK, { confirmedDamage: 0 }))).toBe(false);
      s.effects.update(clock(HIT_TICK));
      expect(live(s)).toBe(0);
      expect(s.effects.vfx.debris.liveCount).toBe(0);
      expect(s.effects.vfx.ground.activeCount()).toBe(0);
    } finally { s.effects.dispose(); }
  });

  it('keeps legacy cues without proof of damage free of blood', () => {
    const s = stage();
    try {
      expect(s.effects.emit(strike(HIT_TICK))).toBe(true);
      s.effects.update(clock(HIT_TICK));
      expect(bloodDrops(s, HIT_TIME)).toHaveLength(0);
    } finally { s.effects.dispose(); }
  });

  it('sprays red droplets from the contact point along the blow, visible on the frozen hit-stop frame', () => {
    const s = stage();
    try {
      expect(s.effects.emit(strike(HIT_TICK, { confirmedDamage: 12 }))).toBe(true);
      s.effects.update(clock(HIT_TICK));
      const drops = bloodDrops(s, HIT_TIME);
      expect(drops.length).toBeGreaterThanOrEqual(8);
      // Spatially at the engine contact point, travelling along the +x blow (not sideways or back).
      for (const p of drops) { expect(p.origin[0]).toBeCloseTo(BLOW_FROM.x, 4); expect(p.origin[1]).toBeCloseTo(BLOW_FROM.y, 4); expect(p.origin[2]).toBeCloseTo(BLOW_FROM.z, 4); }
      const forward = drops.filter(p => p.life > 0.4 && p.velocity[0] > 2);
      expect(forward.length).toBeGreaterThanOrEqual(5);
      const meanX = drops.reduce((sum, p) => sum + p.velocity[0], 0) / drops.length, meanZ = drops.reduce((sum, p) => sum + p.velocity[2], 0) / drops.length;
      expect(meanX).toBeGreaterThan(1.5);
      expect(Math.abs(meanZ)).toBeLessThan(meanX * 0.5);
      // Already fading in on the frozen clock: the alpha envelope is positive for the whole contact, not 0 until the freeze ends.
      for (const p of drops) expect(alphaAt(p, HIT_TIME)).toBeGreaterThan(0.5 * p.a0);
    } finally { s.effects.dispose(); }
  });

  it('holds the same buffers and the same clock while the world is frozen, then expires and cancels', () => {
    const s = stage();
    try {
      s.effects.emit(strike(HIT_TICK, { confirmedDamage: 12, scopeId: 'fight' }));
      s.effects.update(clock(HIT_TICK));
      const before = Array.from(s.alpha.mesh.geometry.getAttribute('iTiming').array);
      const visible = bloodDrops(s, HIT_TIME).map(p => alphaAt(p, HIT_TIME));
      for (let frame = 0; frame < 6; frame++) {
        s.effects.update(clock(HIT_TICK));
        expect(s.alpha.mesh.material.uniforms.uTime!.value).toBe(HIT_TIME);
      }
      expect(Array.from(s.alpha.mesh.geometry.getAttribute('iTiming').array)).toEqual(before);
      expect(bloodDrops(s, HIT_TIME).map(p => alphaAt(p, HIT_TIME))).toEqual(visible);
      // Once the world resumes, the contact is gone within its short lifetime.
      s.effects.update(clock(HIT_TICK + 150));
      expect(live(s)).toBe(0);
      // A fresh contact cancelled with its scope leaves nothing behind.
      s.effects.emit(strike(HIT_TICK + 151, { confirmedDamage: 12, scopeId: 'fight-2' }));
      s.effects.update(clock(HIT_TICK + 151));
      expect(live(s)).toBeGreaterThan(0);
      s.effects.cancelScope('fight-2', 'interrupt');
      s.effects.update(clock(HIT_TICK + 151));
      expect(live(s)).toBe(0);
    } finally { s.effects.dispose(); }
  });

  it('scales the amount of blood with the damage actually dealt', () => {
    const counts: number[] = [];
    for (const damage of [6, 12, 26]) {
      const s = stage();
      try { s.effects.emit(strike(HIT_TICK, { confirmedDamage: damage })); s.effects.update(clock(HIT_TICK)); counts.push(bloodDrops(s, HIT_TIME).length); } finally { s.effects.dispose(); }
    }
    expect(counts[1]!).toBeGreaterThan(counts[0]!);
    expect(counts[2]!).toBeGreaterThan(counts[1]!);
  });

  it('reduced effects keeps a smaller bounded impact with no heavy ground extras', () => {
    const full = stage(), reduced = stage(true);
    try {
      for (const s of [full, reduced]) { s.effects.emit(strike(HIT_TICK, { confirmedDamage: 24, actionId: 'aren-charged-heavy' as ActionId })); s.effects.update(clock(HIT_TICK)); }
      expect(bloodDrops(reduced, HIT_TIME).length).toBeGreaterThan(0);
      expect(live(reduced)).toBeLessThan(live(full));
      expect(reduced.effects.vfx.ground.activeCount()).toBe(0);
      expect(reduced.effects.vfx.debris.liveCount).toBeLessThan(full.effects.vfx.debris.liveCount);
      expect(full.effects.vfx.ground.activeCount()).toBeGreaterThan(0);
    } finally { full.effects.dispose(); reduced.effects.dispose(); }
  });
});
