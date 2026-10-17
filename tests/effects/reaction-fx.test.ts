import { describe, expect, it } from 'bun:test';
import { Object3D, Scene } from 'three';
import { StoryEffects } from '../../src/effects/StoryEffects.js';
import type { StoryCue } from '../../src/effects/story-cues.js';
import type { ImpactSink } from '../../src/effects/vfx/ElementKits.js';
import type { ParticlePool } from '../../src/effects/vfx/GpuParticles.js';
import { VFX_FRAME } from '../../src/effects/vfx/VfxAtlas.js';
import type { ActorSnapshot, CombatReactionKind, CombatReactionSnapshot } from '../../src/game/contracts.js';
import { fallSeconds } from '../../src/rendering/ReactionPresenter.js';

const clock = (tick: number) => ({ simulationTick: tick, worldTick: tick, worldTimeSeconds: tick / 60, timeScale: 0, policy: 'normal' as const });

interface Shake { readonly amplitude: number; readonly seconds: number }
interface Stage {
  readonly effects: StoryEffects;
  readonly additive: ParticlePool;
  readonly alpha: ParticlePool;
  readonly shakes: Shake[];
  readonly impulses: number[];
  readonly flashes: string[];
  tick: number;
}

function stage(reducedEffects = false): Stage {
  const body = new Object3D();
  body.position.set(3, 0, 2);
  const player = new Object3D();
  player.position.set(0, 0, 0);
  const shakes: Shake[] = [], impulses: number[] = [], flashes: string[] = [];
  const impact: ImpactSink = {
    shake: (amplitude, seconds) => { shakes.push({ amplitude, seconds }); },
    flashActor: (id) => { flashes.push(id); },
    impulse: (strength) => { impulses.push(strength); },
  };
  const effects = new StoryEffects({ scene: new Scene(), reducedEffects, impact, resolveActorRoot: id => id === 'boar' ? body : id === 'aren' ? player : undefined });
  return { effects, additive: effects.vfx.particles.additive, alpha: effects.vfx.particles.alpha, shakes, impulses, flashes, tick: 0 };
}
/** Advances the world clock one tick, as the application does every rendered frame. */
const advance = (s: Stage, ticks = 1): void => { for (let i = 0; i < ticks; i += 1) { s.tick += 1; s.effects.update(clock(s.tick)); } };
const live = (s: Stage): number => s.effects.vfx.particles.liveCount(s.effects.vfx.time);

let serial = 0;
const cue = (kind: StoryCue['kind'], actorId: string, patch: Partial<StoryCue> = {}): StoryCue => ({
  instanceId: `reaction:${kind}:${actorId}:${serial++}`, tick: 1, worldTick: 1, worldTimeSeconds: 1 / 60, kind, phase: 'hit', actorId, targetId: actorId,
  position: { x: 3, y: 0, z: 2 }, to: { x: 4, y: 0, z: 2 }, intensity: 0.8, ...patch,
} as StoryCue);
const reaction = (kind: CombatReactionKind, progress: number, patch: Partial<CombatReactionSnapshot> = {}): CombatReactionSnapshot => ({
  kind, direction: { x: 1, y: 0, z: 0 }, side: 'front', strength: 0.8, progress, durationTicks: 90, serial: 7, ...patch,
});
const actor = (id: string, r: CombatReactionSnapshot | undefined, visible = true): ActorSnapshot => ({ id, visible, reaction: r }) as unknown as ActorSnapshot;
/** Frames of the star particle alive in the additive pool. */
const stars = (s: Stage): number => {
  const pool = s.additive, misc = pool.mesh.geometry.getAttribute('iMisc').array, timing = pool.mesh.geometry.getAttribute('iTiming').array;
  let n = 0;
  for (let i = 0; i < pool.drawCount; i += 1) if (misc[i * 4] === VFX_FRAME.star && s.effects.vfx.time >= timing[i * 4]! && s.effects.vfx.time < timing[i * 4]! + timing[i * 4 + 1]!) n += 1;
  return n;
};
const starOrigins = (s: Stage): number[][] => {
  const pool = s.additive, misc = pool.mesh.geometry.getAttribute('iMisc').array, origin = pool.mesh.geometry.getAttribute('iOrigin').array;
  const out: number[][] = [];
  for (let i = 0; i < pool.drawCount; i += 1) if (misc[i * 4] === VFX_FRAME.star) out.push([origin[i * 3]!, origin[i * 3 + 1]!, origin[i * 3 + 2]!]);
  return out;
};

describe('reaction cues', () => {
  it('draw on their own emitters and never occupy a kit slot', () => {
    const s = stage();
    expect(s.effects.emit(cue('reaction-start', 'boar', { reactionKind: 'knockback' }))).toBe(true);
    expect(s.effects.emit(cue('wall-impact', 'boar'))).toBe(true);
    expect(s.effects.emit(cue('getup', 'boar'))).toBe(true);
    expect(s.effects.activeCount).toBe(0);
  });

  it('are drawn once: a repeated instance id does nothing', () => {
    const s = stage();
    const wall = cue('wall-impact', 'boar');
    expect(s.effects.emit(wall)).toBe(true);
    const shakes = s.shakes.length;
    expect(s.effects.emit(wall)).toBe(false);
    expect(s.shakes.length).toBe(shakes);
  });

  it('shake the camera in proportion to strength, harder for the hero, and not at all for a flinch', () => {
    const s = stage();
    s.effects.emit(cue('reaction-start', 'boar', { reactionKind: 'flinch', intensity: 0.9 }));
    expect(s.shakes.length).toBe(0);
    s.effects.emit(cue('reaction-start', 'boar', { reactionKind: 'knockback', intensity: 0.2 }));
    s.effects.emit(cue('reaction-start', 'boar', { reactionKind: 'knockback', intensity: 1 }));
    s.effects.emit(cue('reaction-start', 'aren', { reactionKind: 'knockback', intensity: 1 }));
    const [light, hard, hero] = s.shakes;
    expect(hard!.amplitude).toBeGreaterThan(light!.amplitude * 1.5);
    expect(hero!.amplitude).toBeGreaterThan(hard!.amplitude);
    expect(hard!.seconds).toBeGreaterThan(light!.seconds);
    // A strong hit also punches the screen; a light one does not.
    expect(s.impulses.length).toBe(2);
  });

  it('a wall impact throws dust and debris and shakes harder the harder the body hit', () => {
    const light = stage(), hard = stage();
    light.effects.emit(cue('wall-impact', 'boar', { intensity: 0.2 }));
    hard.effects.emit(cue('wall-impact', 'boar', { intensity: 1 }));
    advance(light); advance(hard);
    expect(live(light)).toBeGreaterThan(5);
    expect(hard.shakes[0]!.amplitude).toBeGreaterThan(light.shakes[0]!.amplitude);
    const debris = (s: Stage): number => s.effects.vfx.debris.liveCount;
    expect(debris(light)).toBeGreaterThan(0);
    expect(debris(hard)).toBeGreaterThan(debris(light));
  });

  it('a poise break bursts stars over the head and flashes the actor', () => {
    const s = stage();
    s.effects.emit(cue('poise-break', 'boar', { reactionKind: 'stun' }));
    advance(s);
    expect(stars(s)).toBe(8);
    expect(s.flashes).toEqual(['boar']);
    const heights = starOrigins(s).map(origin => origin[1]!);
    expect(Math.min(...heights)).toBeGreaterThan(1);
  });

  it('are ignored for an actor with no drawn body and no position', () => {
    const s = stage();
    expect(s.effects.emit(cue('wall-impact', 'ghost', { position: undefined, to: undefined }))).toBe(true);
    advance(s);
    expect(live(s)).toBe(0);
  });
});

describe('snapshot-driven reaction effects', () => {
  it('kicks dust only while a knocked-back body slides', () => {
    const s = stage();
    const run = (progress: number): number => {
      const before = live(s);
      for (let i = 0; i < 12; i += 1) { advance(s); s.effects.reactions.update([actor('boar', reaction('knockback', progress))]); }
      return live(s) - before;
    };
    expect(run(0.01)).toBe(0);
    expect(run(0.4)).toBeGreaterThan(2);
    const dust = stage();
    for (let i = 0; i < 12; i += 1) { advance(dust); dust.effects.reactions.update([actor('boar', reaction('knockback', 0.995))]); }
    expect(live(dust)).toBe(0);
    for (let i = 0; i < 12; i += 1) { advance(dust); dust.effects.reactions.update([actor('boar', undefined)]); }
    expect(live(dust)).toBe(0);
  });

  it('draws a swirl of three stars over a stunned actor that follows the world clock', () => {
    const s = stage();
    for (let i = 0; i < 40; i += 1) { advance(s); s.effects.reactions.update([actor('boar', reaction('stun', 0.5, { durationTicks: 180 }))]); }
    expect(stars(s)).toBeGreaterThanOrEqual(3);
    const first = starOrigins(s);
    expect(first.every(origin => origin[1]! > 1)).toBe(true);
    // Over the head of the boar at (3, 0, 2), inside the orbit radius.
    expect(first.every(origin => Math.hypot(origin[0]! - 3, origin[2]! - 2) <= 0.95)).toBe(true);
    // A frozen world clock (hit-stop, pause) emits nothing new.
    const before = s.additive.drawCount;
    for (let i = 0; i < 20; i += 1) s.effects.reactions.update([actor('boar', reaction('stun', 0.5, { durationTicks: 180 }))]);
    expect(s.additive.drawCount).toBe(before);
  });

  it('under reduced effects the stars hover in a static ring: fewer emissions, no orbit', () => {
    const full = stage(), reduced = stage(true);
    for (const s of [full, reduced]) for (let i = 0; i < 90; i += 1) { advance(s); s.effects.reactions.update([actor('boar', reaction('stun', 0.5, { durationTicks: 180 }))]); }
    expect(reduced.additive.drawCount).toBeLessThan(full.additive.drawCount / 3);
    const angles = new Set(starOrigins(reduced).map(o => Math.round(Math.atan2(o[2]! - 2, o[0]! - 3) * 100)));
    expect(angles.size).toBe(3);
  });

  it('throws landing dust and a thud the moment a knockdown\'s fall ends, once', () => {
    const s = stage();
    const seconds = 90 / 60, landing = fallSeconds(0.8, seconds) / seconds;
    const tick = (progress: number): void => { advance(s); s.effects.reactions.update([actor('boar', reaction('knockdown', progress))]); };
    tick(0.02); tick(landing - 0.05);
    expect(s.shakes.length).toBe(0);
    const before = live(s);
    tick(landing + 0.01);
    expect(live(s)).toBeGreaterThan(before + 5);
    expect(s.shakes.length).toBe(1);
    tick(landing + 0.2); tick(0.99);
    expect(s.shakes.length).toBe(1);
  });

  it('a launch ends with a landing thud when the next reaction takes over', () => {
    const s = stage();
    s.effects.reactions.update([actor('boar', reaction('launch', 0.9, { serial: 3 }))]);
    advance(s);
    const before = live(s);
    s.effects.reactions.update([actor('boar', reaction('knockdown', 0.01, { serial: 4 }))]);
    advance(s);
    expect(live(s)).toBeGreaterThan(before + 5);
    expect(s.shakes.length).toBe(1);
  });

  it('forgets actors that vanish and clears with the scope', () => {
    const s = stage();
    s.effects.reactions.update([actor('boar', reaction('stun', 0.5))]);
    s.effects.reactions.update([]);
    s.effects.cancelAll('unload');
    advance(s);
    expect(live(s)).toBe(0);
  });
});
