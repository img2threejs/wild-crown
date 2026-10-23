import { describe, expect, it } from 'bun:test';
import { Mesh, Object3D, Scene, ShaderMaterial } from 'three';
import { StoryEffects } from '../../src/effects/StoryEffects.js';
import type { StoryCue } from '../../src/effects/story-cues.js';
import { MAX_GUARDS, MAX_MARKS } from '../../src/effects/vfx/CompanionFx.js';
import type { ImpactSink } from '../../src/effects/vfx/ElementKits.js';
import type { ActorSnapshot, WorldClockSnapshot } from '../../src/game/contracts.js';
import { createEngineState, makeActor } from '../../src/game/combat/CombatEngine.js';
import { commandCompanion, createCompanionState } from '../../src/game/companions/CompanionSystem.js';

const clock = (worldTick: number): WorldClockSnapshot => ({ simulationTick: Math.floor(worldTick), worldTick, worldTimeSeconds: worldTick / 60, timeScale: 1, policy: 'normal' });

interface Stage { readonly effects: StoryEffects; readonly roots: Map<string, Object3D>; readonly shakes: number[] }
function stage(reducedEffects = false): Stage {
  const roots = new Map<string, Object3D>(), shakes: number[] = [];
  const impact: ImpactSink = { shake: amplitude => { shakes.push(amplitude); }, flashActor: () => undefined };
  const effects = new StoryEffects({ scene: new Scene(), reducedEffects, impact, resolveActorRoot: id => roots.get(id) });
  return { effects, roots, shakes };
}
const actor = (id: string, x: number, partial: Partial<ActorSnapshot> = {}): ActorSnapshot =>
  ({ id, archetypeId: id, allegiance: 'hostile', position: { x, y: 0, z: 0 }, visible: true, downed: false, ...partial }) as unknown as ActorSnapshot;
const mark = (remainingTicks: number, landing?: { x: number; y: number; z: number }) => ({ sourceId: 'vara', remainingTicks, landing });

let serial = 0;
const cue = (kind: StoryCue['kind'], patch: Partial<StoryCue> = {}): StoryCue => ({
  instanceId: `companion:${kind}:${serial++}`, tick: 1, worldTick: 100, worldTimeSeconds: 100 / 60, kind, phase: 'commit', position: { x: 4, y: 0, z: 1 }, ...patch,
} as StoryCue);
const quads = (effects: StoryEffects): { alpha: number; mode: number }[] => {
  const found: { alpha: number; mode: number }[] = [];
  effects.vfx.ground.group.traverse(node => {
    if (node instanceof Mesh && node.visible && node.material instanceof ShaderMaterial) found.push({ alpha: node.material.uniforms.uAlpha!.value, mode: node.material.uniforms.uMode!.value });
  });
  return found;
};

describe('Vara mark marker', () => {
  it('draws a ring, a head chevron and, for a committed boss attack, a landing hint with its line; all follow the snapshot', () => {
    const { effects } = stage();
    try {
      const landing = { x: 6, y: 0, z: 3 };
      effects.companions.update([actor('boar', 0, { mark: mark(120, landing) })]);
      expect(effects.companions.activeCount).toBe(1);
      expect(quads(effects).length).toBe(2);
      expect(effects.vfx.beams.activeCount).toBe(2);
      // The landing hint and ring are placed on the committed point and on the target.
      const positions: number[] = [];
      effects.vfx.ground.group.traverse(node => { if (node instanceof Mesh && node.visible) positions.push(node.position.x); });
      expect(positions.sort((a, b) => a - b)[0]).toBeCloseTo(0, 5);
      expect(positions.sort((a, b) => a - b)[1]).toBeCloseTo(6, 5);
    } finally { effects.dispose(); }
  });

  it('disappears the moment the snapshot loses the mark (expiry, recall, a new target) and leaves no quad or beam behind', () => {
    const { effects } = stage();
    try {
      effects.companions.update([actor('boar', 0, { mark: mark(60, { x: 5, y: 0, z: 0 }) })]);
      expect(effects.companions.activeCount).toBe(1);
      effects.companions.update([actor('boar', 0)]);
      expect(effects.companions.activeCount).toBe(0);
      expect(quads(effects).length).toBe(0);
      expect(effects.vfx.beams.activeCount).toBe(0);
      // A hidden or removed actor takes its marker with it.
      effects.companions.update([actor('boar', 0, { mark: mark(60) })]);
      effects.companions.update([]);
      expect(effects.companions.activeCount).toBe(0);
    } finally { effects.dispose(); }
  });

  it('is released by every transition (death, load, unload) and not redrawn from stale state', () => {
    for (const reason of ['death', 'load', 'unload'] as const) {
      const { effects } = stage();
      try {
        effects.companions.update([actor('boar', 0, { mark: mark(300) })]);
        effects.cancelAll(reason);
        expect(effects.companions.activeCount, reason).toBe(0);
        expect(quads(effects).length, reason).toBe(0);
        expect(effects.vfx.beams.activeCount, reason).toBe(0);
      } finally { effects.dispose(); }
    }
  });

  it('fades over its last half second and holds a steady ring under reduced effects', () => {
    const lively = stage(), reduced = stage(true);
    try {
      const ring = (s: Stage, remaining: number, time: number): number => {
        s.effects.vfx.time = time;
        s.effects.companions.update([actor('boar', 0, { mark: mark(remaining) })]);
        return quads(s.effects)[0]!.alpha;
      };
      expect(ring(lively, 4, 1)).toBeLessThan(ring(lively, 200, 1));
      expect(ring(reduced, 200, 1)).toBeCloseTo(ring(reduced, 200, 1.3), 9);
      expect(ring(lively, 200, 1)).not.toBeCloseTo(ring(lively, 200, 1.3), 3);
    } finally { lively.effects.dispose(); reduced.effects.dispose(); }
  });

  it('never exceeds its cap of marks, so the shared telegraph pool is not starved', () => {
    const { effects } = stage();
    try {
      effects.companions.update([0, 1, 2, 3].map(i => actor(`h${i}`, i * 3, { mark: mark(100) })));
      expect(effects.companions.activeCount).toBe(MAX_MARKS);
    } finally { effects.dispose(); }
  });

  it('lands with a sky ring and flash on the mark cue (the persistent marker is the snapshot\'s)', () => {
    const { effects } = stage();
    try {
      const before = effects.activeCount;
      expect(effects.emit(cue('mark', { actorId: 'vara', targetId: 'boar', scopeId: 'mark:boar' }))).toBe(true);
      expect(quads(effects).some(quad => quad.mode === 1)).toBe(true);
      expect(effects.activeCount).toBe(before);
      expect(effects.companions.activeCount).toBe(0);
    } finally { effects.dispose(); }
  });
});

describe('Asha guard feedback', () => {
  it('draws a ring on the protectee and a line from Asha while she moves in, then brightens on the block and dims in recovery', () => {
    const { effects } = stage();
    try {
      const snapshot = (state: 'moving' | 'blocking' | 'recovery'): ActorSnapshot[] => [
        actor('aren', 5, { allegiance: 'player' }), actor('asha', 0, { allegiance: 'ally', guard: { protecteeId: 'aren', state, remainingTicks: 30 } }),
      ];
      effects.vfx.time = 2;
      effects.companions.update(snapshot('moving'));
      expect(effects.companions.activeCount).toBe(1);
      expect(effects.vfx.beams.activeCount).toBe(1);
      const moving = quads(effects)[0]!.alpha;
      effects.companions.update(snapshot('blocking'));
      const blocking = quads(effects)[0]!.alpha;
      effects.companions.update(snapshot('recovery'));
      const recovery = quads(effects)[0]!.alpha;
      expect(blocking).toBe(1);
      expect(recovery).toBeLessThan(moving);
      effects.companions.update([actor('aren', 5, { allegiance: 'player' }), actor('asha', 0, { allegiance: 'ally' })]);
      expect(effects.companions.activeCount).toBe(0);
      expect(effects.vfx.beams.activeCount).toBe(0);
    } finally { effects.dispose(); }
  });

  it('shakes and flashes on the block cue only, never on a miss', () => {
    const { effects, shakes } = stage();
    try {
      effects.emit(cue('guard', { actorId: 'asha', targetId: 'aren', phase: 'anticipation', scopeId: 'guard:h1' }));
      expect(shakes.length).toBe(0);
      effects.emit(cue('guard', { actorId: 'asha', targetId: 'aren', phase: 'hit', scopeId: 'guard:h1' }));
      expect(shakes.length).toBe(1);
      expect(MAX_GUARDS).toBe(1);
    } finally { effects.dispose(); }
  });
});

describe('companion command feedback', () => {
  it('renders and expires the real Storm Talon takeoff without invalid danger geometry', () => {
    const { effects } = stage();
    const state = createEngineState();
    state.tick = state.worldTick = 1;
    state.actors = [makeActor('aren', 'human', 'player', { x: 0, y: 0, z: 0 }, false, false, 100),
      makeActor('vara', 'harpy-eagle', 'ally', { x: 1, y: 2.4, z: 0 }, false, true, 100),
      makeActor('corrupted-boar', 'boar', 'hostile', { x: 3, y: 0, z: 0 }, false, false, 100)];
    state.companionState = createCompanionState('vara');
    try {
      expect(commandCompanion(state, { companionId: 'vara', command: 'special', target: { kind: 'actor', instanceId: 'corrupted-boar' } })).toBe(true);
      for (const cue of state.presentationCues) effects.emit(cue);
      effects.update(clock(2));
      expect(quads(effects).length).toBeGreaterThan(0);
      effects.update(clock(100));
      expect(quads(effects)).toEqual([]);
    } finally { effects.dispose(); }
  });

});

describe("Tali's shelter", () => {
  it('holds a ring over the shelter for the danger window and releases it on expiry, on resolve and on cancel', () => {
    const { effects } = stage();
    try {
      const shelter = (patch: Partial<StoryCue> = {}) => cue('shelter', { actorId: 'tali', phase: 'sustain', worldTick: 100, durationTicks: 120, footprint: { width: 4, length: 4 }, scopeId: 'shelter:tali', ...patch });
      effects.emit(shelter({ instanceId: 'shelter-a' }));
      expect(effects.companions.activeCount).toBe(1);
      effects.update(clock(150));
      expect(quads(effects).length).toBe(1);
      effects.update(clock(221));
      expect(effects.companions.activeCount).toBe(0);
      expect(quads(effects).length).toBe(0);

      effects.emit(shelter({ instanceId: 'shelter-b', worldTick: 300 }));
      effects.emit(cue('shelter', { actorId: 'tali', phase: 'resolve', scopeId: 'shelter:tali' }));
      expect(effects.companions.activeCount).toBe(0);

      effects.emit(shelter({ instanceId: 'shelter-c', worldTick: 400 }));
      effects.cancelScope('shelter:tali', 'interrupt');
      expect(effects.companions.activeCount).toBe(0);
      expect(quads(effects).length).toBe(0);
    } finally { effects.dispose(); }
  });
});
