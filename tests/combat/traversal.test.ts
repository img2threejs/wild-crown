import { describe, expect, it } from 'bun:test';
import { CombatEngine, createEngineState, type CombatInput, type EngineState } from '../../src/game/combat/CombatEngine.js';
import type { RegionRouteDefinition } from '../../src/game/contracts.js';
import { REGIONS } from '../../src/content/campaign.js';
import { isSupportedCapsulePose } from '../../src/game/combat/geometry.js';

const v = (x: number, y = 0, z = 0) => ({ x, y, z });
const route: RegionRouteDefinition = { id: 'test-vault', from: v(0), to: v(4), anchors: [v(0, 1.2), v(4, 1.2)], destinationRegionId: 'greenwake', kind: 'path', traversalActionId: 'aren-staff-vault', traversal: { kind: 'vault', durationTicks: 60, startRadius: 1 }, colliderIds: [], traversalEvent: 'test-vaulted' };
const input = (patch: Partial<CombatInput> = {}): CombatInput => ({ tick: 1, move: v(0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false, ...patch });
function engine() {
  const state = createEngineState();
  state.arena.bounds = { min: v(-10, -2, -10), max: v(10, 10, 10) };
  state.arena.colliders = [{ id: 'log', kind: 'box', from: v(2, .4), halfExtents: v(.3, .4, 1), blocksMovement: true, blocksCamera: true }];
  const result = new CombatEngine(state);
  result.setTraversalGates([route]);
  return result;
}
const player = (engine: CombatEngine) => engine.snapshot().actors.find(a => a.id === 'aren')!;
const start = (engine: CombatEngine) => engine.fixedStep(input({ interactPressed: true, traversalId: route.id }));
const advance = (engine: CombatEngine, ticks: number) => { for (let i = 0; i < ticks; i++) engine.fixedStep(); };

describe('contextual traversal lifetime', () => {
  it('follows anchors over a blocked log and emits success only once after supported landing', () => {
    const e = engine(); start(e);
    expect(player(e).actionId).toBe('aren-staff-vault');
    expect(player(e).position).toEqual(v(0));
    expect(e.consumeEvents().filter(event => event.kind === 'traversal')).toEqual([]);
    advance(e, 30);
    expect(player(e).position.y).toBeCloseTo(1.2);
    expect(player(e).normalizedTime).toBeCloseTo(.5);
    e.fixedStep(input({ interactPressed: true, traversalId: route.id, dodgePressed: true, lightPressed: true, move: v(1) }));
    expect(player(e).actionId).toBe('aren-staff-vault');
    advance(e, 29);
    expect(player(e).position).toEqual(v(4));
    expect(e.consumeEvents().filter(event => event.kind === 'traversal').map(event => event.actionId)).toEqual([route.id]);
    advance(e, 80);
    expect(e.consumeEvents().filter(event => event.kind === 'traversal')).toEqual([]);
  });
  it('rejects locked, unsupported, wrong-height and remote starts without moving', () => {
    for (const patch of [{ unlockFact: 'locked' }, { from: v(0, 3) }, { destinationRegionId: 'the-grove' as const }]) {
      const e = engine(); e.setTraversalGates([{ ...route, ...patch }]); start(e); advance(e, 70);
      expect(player(e).position).toEqual(v(0));
      expect(e.consumeEvents().filter(event => event.kind === 'traversal')).toEqual([]);
    }
  });
  it('rejects unsupported start or landing on authored surface gaps', () => {
    for (const [minX, maxX] of [[-1, 1], [3, 6]]) {
      const e = engine(); const state = e.snapshotState();
      state.arena.surfaces = [{ id: 'island', profile: 'plane', points: [v(minX!, 0, -2), v(maxX!, 0, -2), v(maxX!, 0, 2), v(minX!, 0, 2)], elevation: 0, walkable: true, material: 'stone', colliderId: 'island' }];
      e.restore(JSON.stringify(state)); start(e); advance(e, 80);
      expect(player(e).position).toEqual(v(0));
      expect(e.isTraversing).toBe(false);
      expect(e.consumeEvents().filter(event => event.kind === 'traversal')).toEqual([]);
    }
  });
  it('rejects blocked landing or ceiling rather than snapping through it', () => {
    for (const obstacle of [{ id: 'landing', kind: 'box' as const, from: v(4, .8), halfExtents: v(.5, .8, .5), blocksMovement: true, blocksCamera: true }, { id: 'ceiling', kind: 'box' as const, from: v(2, 2), halfExtents: v(1, .1, 1), blocksMovement: true, blocksCamera: true }]) {
      const e = engine(); const state = e.snapshotState(); state.arena.colliders = [...state.arena.colliders, obstacle]; e.restore(JSON.stringify(state)); start(e); advance(e, 70);
      expect(player(e).position).toEqual(v(0));
      expect(e.consumeEvents().filter(event => event.kind === 'traversal')).toEqual([]);
    }
  });
  it('freezes on pause and discards in-flight runtime saves to the last safe pose', () => {
    const e = engine(); start(e); advance(e, 25); e.setTimePolicy('paused');
    const frozen = player(e); advance(e, 20); expect(player(e)).toEqual(frozen);
    const resumed = new CombatEngine(JSON.parse(e.serialize()));
    expect(player(resumed).position).toEqual(v(0));
    resumed.setTimePolicy('normal'); advance(resumed, 80);
    expect(resumed.consumeEvents().filter(event => event.kind === 'traversal')).toEqual([]);
    e.setTimePolicy('normal'); advance(e, 35); expect(player(e).position).toEqual(v(4));
  });
  it('reset clears a traversal even without an encounter checkpoint', () => {
    const e = engine(); start(e); advance(e, 25); e.resetToCheckpoint(); advance(e, 80);
    expect(player(e).position).toEqual(v(0));
    expect(e.consumeEvents().filter(event => event.kind === 'traversal')).toEqual([]);
  });
  it('aborts on actual incoming damage, including death, without completing or rewarding a route', () => {
    for (const damage of [5, 100]) {
      const e = engine(); const state = e.snapshotState();
      state.hazards = [{ id: 'incoming', attackId: 'asha-pounce', sourceId: 'asha', startTick: 0, activeFrom: 25, activeUntil: 35, target: v(2, 1.2), origin: v(2, 1.2), direction: v(1), hitIds: [], threatTicks: [], cue: 'Incoming pounce', kind: 'strike', width: 2, depth: 2, radius: 10, heightAboveGround: 3, damage, bounds: { min: v(-10, -2, -10), max: v(10, 5, 10) }, hitGroup: 'incoming' }];
      e.restore(JSON.stringify(state)); start(e); advance(e, 30);
      expect(e.snapshot().player.vitality).toBe(100 - damage);
      expect(player(e).position).toEqual(v(0));
      expect(e.isTraversing).toBe(false);
      advance(e, 80);
      expect(e.consumeEvents().filter(event => event.kind === 'traversal')).toEqual([]);
      expect(e.consumeWorldEvents()).toEqual([]);
      expect(e.snapshotState().regionId).toBe('greenwake');
    }
  });
  it('aborts before a newly blocked landing and restores its last supported pose', () => {
    const e = engine(); start(e); advance(e, 30);
    const live = (e as unknown as { state: EngineState }).state;
    live.arena.colliders = [...live.arena.colliders, { id: 'new-block', kind: 'box', from: v(4, .8), halfExtents: v(.5, .8, .5), blocksMovement: true, blocksCamera: true }];
    advance(e, 40);
    expect(player(e).position).toEqual(v(0));
    expect(e.isTraversing).toBe(false);
    expect(e.consumeEvents().filter(event => event.kind === 'traversal')).toEqual([]);
  });
  it('downing an actor mid-path cannot leave an airborne pose or pending state', () => {
    const e = engine(); start(e); advance(e, 30);
    (e as unknown as { state: EngineState }).state.actors[0]!.downed = true;
    e.fixedStep();
    expect(player(e).position).toEqual(v(0));
    expect(e.isTraversing).toBe(false);
    expect(e.consumeEvents().filter(event => event.kind === 'traversal')).toEqual([]);
  });
  it('explicit region load clears in-flight state rather than awarding the old route', () => {
    const e = engine(); start(e); advance(e, 30);
    e.loadRegion({ regionId: 'greenwake', runId: 'reload', presentActorIds: [], playerPosition: v(4, 0, 0) });
    expect(e.isTraversing).toBe(false);
    expect(player(e).position).toEqual(v(4));
    advance(e, 80);
    expect(e.consumeEvents().filter(event => event.kind === 'traversal')).toEqual([]);
    expect(e.consumeWorldEvents()).toEqual([]);
  });
  it('executes all four authored types through native IDs and geometry-supported landings', () => {
    const kinds: string[] = [];
    for (const region of REGIONS) for (const arc of region.traversalArcs) {
      if (!arc.traversal) continue;
      kinds.push(arc.traversal.kind);
      const e = new CombatEngine(); e.loadRegion({ regionId: region.id, runId: 'authored-traversal', presentActorIds: [], playerPosition: arc.from });
      const state = e.snapshotState();
      expect(isSupportedCapsulePose(state.arena, arc.from, .42, 1.6)).toBe(true);
      expect(isSupportedCapsulePose(state.arena, arc.to, .42, 1.6)).toBe(true);
      expect(e.nearestTraversal(arc.from)?.id).toBe(arc.id);
      e.fixedStep(input({ interactPressed: true, traversalId: arc.id }));
      expect(player(e).actionId).toBe(arc.traversalActionId);
      advance(e, Math.floor(arc.traversal.durationTicks / 2));
      expect(player(e).normalizedTime).toBeCloseTo(Math.floor(arc.traversal.durationTicks / 2) / arc.traversal.durationTicks);
      e.resetToCheckpoint();
      expect(e.isTraversing).toBe(false);
      expect(isSupportedCapsulePose(state.arena, player(e).position, .42, 1.6)).toBe(true);
      expect(e.consumeEvents().filter(event => event.kind === 'traversal')).toEqual([]);
      e.loadRegion({ regionId: region.id, runId: 'authored-traversal', presentActorIds: [], playerPosition: arc.from });
      e.fixedStep(input({ interactPressed: true, traversalId: arc.id })); advance(e, arc.traversal.durationTicks);
      expect(player(e).position).toEqual(arc.to);
      expect(e.consumeEvents().filter(event => event.kind === 'traversal').map(event => event.actionId)).toEqual([arc.id]);
      expect(e.consumeWorldEvents()).toEqual([]);
      expect(e.snapshotState().regionId).toBe(region.id);
    }
    expect(kinds.sort()).toEqual(['low-ledge', 'slide', 'swing', 'vault']);
  });
});
