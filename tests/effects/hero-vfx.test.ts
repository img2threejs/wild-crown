import { describe, expect, it } from 'bun:test';
import { Color, Mesh, Object3D, Scene } from 'three';
import { StoryEffects } from '../../src/effects/StoryEffects.js';
import { StoryPresentation } from '../../src/effects/StoryPresentation.js';
import type { StoryCue } from '../../src/effects/story-cues.js';
import type { ImpactSink } from '../../src/effects/vfx/ElementKits.js';
import { ATTACKS } from '../../src/game/combat/content.js';
import type { ActionId, ActorSnapshot, AttackId, CombatSnapshot } from '../../src/game/contracts.js';

let sequence = 0;
function cue(partial: Partial<StoryCue> & Pick<StoryCue, 'kind' | 'phase'>, tick = 0): StoryCue {
  return { instanceId: `hero:${++sequence}`, tick, worldTick: tick, worldTimeSeconds: tick / 60, priority: 'essential', ...partial };
}
const yara = (partial: Partial<StoryCue> & Pick<StoryCue, 'kind' | 'phase'>, tick = 0): StoryCue => cue({ element: 'heartroot', actorId: 'aren', ...partial }, tick);
const aren = (partial: Partial<StoryCue> & Pick<StoryCue, 'kind' | 'phase'>, tick = 0): StoryCue => cue({ element: 'arcane', actorId: 'aren', ...partial }, tick);
function clock(effects: StoryEffects, tick: number): void { effects.update({ simulationTick: tick, worldTick: tick, worldTimeSeconds: tick / 60, timeScale: 1, policy: 'normal' }); }
function spawned(effects: StoryEffects): number { const p = effects.vfx.particles; return p.additive.nextSlot + p.alpha.nextSlot; }
function sink(): ImpactSink & { shakes: number[]; rims: string[]; impulses: number[] } {
  const record = { shakes: [] as number[], rims: [] as string[], impulses: [] as number[] };
  return Object.assign(record, {
    shake: (amplitude: number) => { record.shakes.push(amplitude); },
    flashActor: (id: string, _color: Color, _intensity: number, _seconds: number, mode: string) => { record.rims.push(`${id}:${mode}`); },
    impulse: (strength: number) => { record.impulses.push(strength); },
  });
}
const at = { x: 4, y: 0.9, z: -3 };

describe('Yara contact feedback', () => {
  it('a thorn hit bursts once: the projectile-impact cue spawns, the same-tick hit cue does not', () => {
    const impact = sink(), effects = new StoryEffects({ scene: new Scene(), impact });
    try {
      effects.emit(yara({ kind: 'projectile-impact', phase: 'hit', targetId: 'boar', scopeId: 'thorn-bolt:1', position: at, actionId: 'thorn-bolt' as ActionId }, 10));
      const afterImpact = spawned(effects), shakes = impact.shakes.length;
      expect(afterImpact).toBeGreaterThan(0);
      effects.emit(yara({ kind: 'hit', phase: 'hit', targetId: 'boar', position: at, actionId: 'yara-thornshot-1' as ActionId, attackId: 'aren-light' as AttackId }, 10));
      expect(spawned(effects)).toBe(afterImpact);
      expect(impact.shakes.length).toBe(shakes);
      expect(impact.rims.filter(entry => entry === 'boar:hit')).toHaveLength(1);
    } finally { effects.dispose(); }
  });

  it('independent contacts keep their own burst: another skill at the same place and tick, the same skill on the next tick, a second hit, and two impacts in one tick', () => {
    const effects = new StoryEffects({ scene: new Scene() });
    try {
      const impactAt = (scope: string, target: string, tick: number, x = at.x): StoryCue => yara({ kind: 'projectile-impact', phase: 'hit', targetId: target, scopeId: scope, position: { x, y: at.y, z: at.z }, actionId: 'thorn-bolt' as ActionId }, tick);
      const hit = (action: string, target: string, tick: number): StoryCue => yara({ kind: 'hit', phase: 'hit', targetId: target, position: at, actionId: action as ActionId }, tick);
      const grew = (emit: StoryCue): number => { const before = spawned(effects); effects.emit(emit); return spawned(effects) - before; };
      expect(grew(impactAt('t1', 'boar', 10))).toBeGreaterThan(0);
      expect(grew(hit('yara-root-spike', 'boar', 10))).toBeGreaterThan(0);
      expect(grew(hit('yara-thornshot-1', 'boar', 10))).toBe(0);
      expect(grew(hit('yara-thornshot-1', 'boar', 10))).toBeGreaterThan(0);
      expect(grew(hit('yara-thornshot-1', 'boar', 11))).toBeGreaterThan(0);
      expect(grew(impactAt('t2', 'wolf', 20, 12))).toBeGreaterThan(0);
      expect(grew(impactAt('t3', 'boar', 20))).toBeGreaterThan(0);
    } finally { effects.dispose(); }
  });

  it('cancelling a scope or the whole system forgets its bursts, so a later same-tick hit renders on its own', () => {
    const effects = new StoryEffects({ scene: new Scene() });
    try {
      const impactAt = (scope: string, tick: number): StoryCue => yara({ kind: 'projectile-impact', phase: 'hit', targetId: 'boar', scopeId: scope, position: at, actionId: 'thorn-bolt' as ActionId }, tick);
      const hit = (tick: number): StoryCue => yara({ kind: 'hit', phase: 'hit', targetId: 'boar', position: at, actionId: 'yara-thornshot-1' as ActionId }, tick);
      const grew = (emit: StoryCue): number => { const before = spawned(effects); effects.emit(emit); return spawned(effects) - before; };
      effects.emit(impactAt('s1', 10));
      effects.cancelScope('s1', 'interrupt');
      expect(grew(hit(10))).toBeGreaterThan(0);
      effects.emit(impactAt('s2', 30));
      effects.cancelAll('load');
      expect(grew(hit(30))).toBeGreaterThan(0);
    } finally { effects.dispose(); }
  });

  it('a bloom area burst covers the per-target hit cues that follow in the same tick, rimming each struck target without a second shake', () => {
    const impact = sink(), effects = new StoryEffects({ scene: new Scene(), impact });
    try {
      effects.emit(yara({ kind: 'bloom', phase: 'hit', actionId: 'yara-heartroot-bloom' as ActionId, position: at, footprint: { width: 16, length: 16 } }, 50));
      const burst = spawned(effects), shakes = impact.shakes.length;
      expect(shakes).toBeGreaterThan(0);
      effects.emit(yara({ kind: 'hit', phase: 'hit', targetId: 'boar', position: { x: at.x + 2, y: at.y, z: at.z }, actionId: 'yara-heartroot-bloom' as ActionId }, 50));
      effects.emit(yara({ kind: 'hit', phase: 'hit', targetId: 'wolf', position: { x: at.x - 2, y: at.y, z: at.z }, actionId: 'yara-heartroot-bloom' as ActionId }, 50));
      expect(spawned(effects)).toBe(burst);
      expect(impact.shakes).toHaveLength(shakes);
      expect(impact.rims).toEqual(expect.arrayContaining(['boar:hit', 'wolf:hit']));
    } finally { effects.dispose(); }
  });

  it('reduced effects keep every Yara kit running with fewer particles, and disposal leaves nothing in the scene', () => {
    const scene = new Scene();
    const full = new StoryEffects({ scene: new Scene() }), reduced = new StoryEffects({ scene, reducedEffects: true });
    try {
      const play = (effects: StoryEffects): number => {
        const before = spawned(effects);
        effects.emit(yara({ kind: 'bloom', phase: 'hit', actionId: 'yara-heartroot-bloom' as ActionId, position: at, footprint: { width: 16, length: 16 } }, 20));
        effects.emit(yara({ kind: 'blink', phase: 'commit', from: at, to: { x: 9, y: 0.9, z: -3 }, durationTicks: 20 }, 20));
        clock(effects, 21);
        return spawned(effects) - before;
      };
      const normalCount = play(full), reducedCount = play(reduced);
      expect(reducedCount).toBeGreaterThan(0);
      expect(reducedCount).toBeLessThan(normalCount);
    } finally { full.dispose(); reduced.dispose(); }
    expect(scene.children.length).toBe(0);
  });

  it('saturating Yara and Aren cues stays within two particle draw calls and the pool capacity', () => {
    const effects = new StoryEffects({ scene: new Scene(), capacity: 48 });
    try {
      let draws = 0;
      effects.group.traverse(node => { if (node instanceof Mesh && node.name.startsWith('vfx-particles')) draws++; });
      expect(draws).toBe(2);
      for (let wave = 0; wave < 40; wave++) {
        const tick = wave * 6;
        effects.emit(yara({ kind: 'bloom', phase: 'hit', actionId: 'yara-heartroot-bloom' as ActionId, position: { x: wave % 7, y: 0, z: 0 }, footprint: { width: 16, length: 16 } }, tick));
        effects.emit(yara({ kind: 'blink', phase: 'commit', from: at, to: { x: 9, y: 0.9, z: -3 }, durationTicks: 20 }, tick));
        effects.emit(aren({ kind: 'slash', phase: 'active', actionId: 'aren-light-3' as ActionId, position: at, footprint: { width: 2.4, length: 2.4, angleRadians: 0, sectorRadians: Math.PI * 2 }, durationTicks: 4 }, tick));
        clock(effects, tick + 1);
        expect(effects.vfx.particles.liveCount(effects.vfx.time)).toBeLessThanOrEqual(effects.vfx.particles.capacity);
      }
      expect(effects.vfx.particles.capacity).toBeLessThanOrEqual(8000);
    } finally { effects.dispose(); }
  });
});

describe('monster contact timing', () => {
  it('a leap windup/commit never shakes the camera; the shake lands on the active (contact) frame', () => {
    const impact = sink(), scene = new Scene(), cast = new Object3D(), root = new Object3D();
    cast.position.set(3, 1.7, -2); scene.add(cast, root);
    const effects = new StoryEffects({ scene, impact, resolveSocket: (_id, name) => name === 'cast' ? cast : name === 'root' ? root : undefined });
    try {
      effects.setFocus({ x: 3, y: 0, z: -1 });
      const attack = ATTACKS['howler-leap-slam']!, mk = (phase: 'anticipation' | 'commit' | 'active', tick: number): StoryCue => ({
        instanceId: `leap:${phase}`, scopeId: 'leap', tick, worldTick: tick, worldTimeSeconds: tick / 60, kind: phase, phase, attackId: 'howler-leap-slam' as AttackId, element: attack.element, actorId: 'canopy-howler', targetId: 'aren',
        priority: 'essential', position: { x: 3, y: 0, z: -1 }, from: { x: 3, y: 0, z: -2 }, to: { x: 3, y: 0, z: 1 }, shape: 'burst', durationTicks: 20, footprint: { width: 3, length: 3, angleRadians: 0 },
      });
      effects.emit(mk('anticipation', 60)); clock(effects, 62);
      effects.emit(mk('commit', 80)); clock(effects, 82);
      expect(impact.shakes).toHaveLength(0);
      effects.emit(mk('active', 100)); clock(effects, 101);
      expect(impact.shakes.length).toBeGreaterThan(0);
    } finally { effects.dispose(); }
  });

  it('a map-kit windup charge core is spawned on the cast socket and follows it when the bone moves', () => {
    const scene = new Scene(), cast = new Object3D(), root = new Object3D();
    cast.position.set(3, 1.7, -2); scene.add(cast, root);
    const effects = new StoryEffects({ scene, resolveSocket: (_id, name) => name === 'cast' ? cast : name === 'root' ? root : undefined });
    try {
      effects.emit({ instanceId: 'wind', scopeId: 'wind', tick: 60, worldTick: 60, worldTimeSeconds: 1, kind: 'anticipation', phase: 'anticipation', attackId: 'howler-rock-hurl' as AttackId, element: 'earth', actorId: 'canopy-howler', priority: 'essential', position: { x: 3, y: 0, z: -2 }, from: { x: 3, y: 0, z: -2 }, to: { x: 3, y: 0, z: 3 }, durationTicks: 40, shape: 'burst', footprint: { width: 2, length: 2, angleRadians: 0 } });
      const pool = effects.vfx.particles.additive, origin = pool.mesh.geometry.getAttribute('iOrigin');
      /** Distance from `target` to the nearest particle spawned in the ring slots [from, to). */
      const nearest = (from: number, to: number, target: Object3D): number => {
        let best = Infinity;
        for (let i = from; i < to; i++) best = Math.min(best, Math.hypot(origin.getX(i) - target.position.x, origin.getY(i) - target.position.y, origin.getZ(i) - target.position.z));
        return best;
      };
      let from = pool.nextSlot;
      clock(effects, 64);
      expect(nearest(from, pool.nextSlot, cast)).toBeLessThan(0.01);
      cast.position.set(9, 2.4, 5);
      from = pool.nextSlot;
      clock(effects, 66);
      expect(nearest(from, pool.nextSlot, cast)).toBeLessThan(0.01);
    } finally { effects.dispose(); }
  });
});

function actorSnapshot(partial: Partial<ActorSnapshot>): ActorSnapshot {
  return {
    id: 'aren', archetypeId: 'aren', species: 'human', allegiance: 'player', position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: 1 }, actionId: 'aren-idle', phase: 'idle',
    normalizedTime: 0, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false, ...partial,
  } as ActorSnapshot;
}
function shockMeshes(presentation: StoryPresentation): number {
  let count = 0;
  presentation.effects.group.traverse(node => { if (node instanceof Mesh && node.name === 'vfx-ground-shock' && node.visible) count++; });
  return count;
}

describe('jump presentation from snapshots', () => {
  function run(heroId: 'aren' | 'yara', boosted: boolean): { presentation: StoryPresentation; step: (tick: number, partial: Partial<ActorSnapshot>) => void } {
    const presentation = new StoryPresentation({ scene: new Scene() });
    presentation.actors.setHero(heroId);
    const step = (tick: number, partial: Partial<ActorSnapshot>): void => {
      presentation.update({ simulationTick: tick, worldTick: tick, worldTimeSeconds: tick / 60, timeScale: 1, policy: 'normal' });
      presentation.updateActors([actorSnapshot({ actionId: 'aren-jump' as ActionId, jumpBoosted: boosted, ...partial })]);
      presentation.effects.vfx.update(tick / 60);
    };
    return { presentation, step };
  }

  it('a boosted second jump ripples a ground disc at each of its two air steps; a plain jump has none', () => {
    for (const heroId of ['aren', 'yara'] as const) {
      const boosted = run(heroId, true), plain = run(heroId, false);
      try {
        boosted.step(10, { phase: 'startup', jumpPhase: 'takeoff', jumpPhaseProgress: 0.2 });
        boosted.step(11, { phase: 'active', jumpPhase: 'rising', jumpPhaseProgress: 0.05 });
        const afterFirst = shockMeshes(boosted.presentation);
        expect(afterFirst).toBe(1);
        boosted.step(14, { phase: 'active', jumpPhase: 'rising', jumpPhaseProgress: 0.2 });
        expect(shockMeshes(boosted.presentation)).toBe(1);
        boosted.step(20, { phase: 'active', jumpPhase: 'rising', jumpPhaseProgress: 0.5 });
        expect(shockMeshes(boosted.presentation)).toBe(2);
        boosted.step(26, { phase: 'active', jumpPhase: 'falling', jumpPhaseProgress: 0.5 });
        expect(shockMeshes(boosted.presentation)).toBe(2);
        plain.step(10, { phase: 'startup', jumpPhase: 'takeoff', jumpPhaseProgress: 0.2 });
        plain.step(20, { phase: 'active', jumpPhase: 'rising', jumpPhaseProgress: 0.5 });
        plain.step(30, { phase: 'active', jumpPhase: 'falling', jumpPhaseProgress: 0.5 });
        expect(shockMeshes(plain.presentation)).toBe(0);
      } finally { boosted.presentation.dispose(); plain.presentation.dispose(); }
    }
  });

  it('landing dust scales with the fall time (clamped 0.6..1.8)', () => {
    const scales: number[] = [];
    for (const fallTicks of [6, 30, 90]) {
      const presentation = new StoryPresentation({ scene: new Scene() });
      try {
        let tick = 0;
        const step = (partial: Partial<ActorSnapshot>): void => {
          presentation.update({ simulationTick: tick, worldTick: tick, worldTimeSeconds: tick / 60, timeScale: 1, policy: 'normal' });
          presentation.updateActors([actorSnapshot({ actionId: 'aren-jump' as ActionId, ...partial })]);
          tick++;
        };
        step({ phase: 'startup', jumpPhase: 'takeoff' });
        step({ phase: 'active', jumpPhase: 'rising', jumpPhaseProgress: 0.5 });
        step({ phase: 'active', jumpPhase: 'falling', jumpPhaseProgress: 0 });
        tick += fallTicks;
        step({ phase: 'recovery', jumpPhase: 'landing', jumpPhaseProgress: 0 });
        scales.push(presentation.actors.lastLandingScale);
      } finally { presentation.dispose(); }
    }
    expect(scales[0]!).toBeGreaterThanOrEqual(0.6);
    expect(scales[1]!).toBeGreaterThan(scales[0]!);
    expect(scales[2]!).toBeGreaterThan(scales[1]!);
    expect(scales[2]!).toBeLessThanOrEqual(1.8);
  });

  it('Root Tether draws a lash plus a cyan wind wrap for Aren, a single vine for Yara, and releases both when the action ends', () => {
    const beams = (presentation: StoryPresentation): number => {
      let count = 0;
      presentation.effects.group.traverse(node => { if (node instanceof Mesh && node.name === 'vfx-beam' && node.visible) count++; });
      return count;
    };
    for (const [heroId, expected] of [['aren', 2], ['yara', 1]] as const) {
      const presentation = new StoryPresentation({ scene: new Scene() });
      try {
        presentation.actors.setHero(heroId);
        const action = heroId === 'aren' ? 'aren-root-tether' : 'yara-binding-vines';
        presentation.update({ simulationTick: 1, worldTick: 1, worldTimeSeconds: 1 / 60, timeScale: 1, policy: 'normal' });
        presentation.updateActors([actorSnapshot({ actionId: action as ActionId, targetId: 'boar' as ActorSnapshot['targetId'] })]);
        presentation.effects.vfx.update(1 / 60);
        expect(beams(presentation)).toBe(expected);
        presentation.updateActors([actorSnapshot({ actionId: 'aren-idle' as ActionId })]);
        presentation.effects.vfx.update(2 / 60);
        expect(beams(presentation)).toBe(0);
      } finally { presentation.dispose(); }
    }
  });
});

describe('hero identity from the combat snapshot', () => {
  it('updateCombat switches the actor effects and the warden to the snapshot hero', () => {
    const presentation = new StoryPresentation({ scene: new Scene() });
    try {
      const snapshot = (heroId: 'aren' | 'yara'): CombatSnapshot => ({
        actors: [actorSnapshot({})], player: { heroId }, worldClock: { simulationTick: 1, worldTick: 1, worldTimeSeconds: 1 / 60, timeScale: 1, policy: 'normal' },
      } as unknown as CombatSnapshot);
      presentation.updateCombat(snapshot('yara'), 0);
      expect(presentation.effects.warden.player.hero).toBe('yara');
      presentation.updateCombat(snapshot('aren'), 0);
      expect(presentation.effects.warden.player.hero).toBe('aren');
    } finally { presentation.dispose(); }
  });
});
