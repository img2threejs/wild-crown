import { describe, expect, it } from 'bun:test';
import type { ActorId, Bounds3, CompanionId, Vec3 } from '../../src/game/contracts.js';
import type { CombatActor, EngineState } from '../../src/game/combat/CombatEngine.js';
import { CombatEngine } from '../../src/game/combat/CombatEngine.js';
import { CampaignDirector } from '../../src/game/campaign/CampaignDirector.js';
import { companionCommand, createCompanionState, stepCompanions } from '../../src/game/companions/CompanionSystem.js';
import { REGIONS } from '../../src/content/world.js';

const bounds: Bounds3 = { min: { x: -5, y: -2, z: -5 }, max: { x: 5, y: 5, z: 5 } };
function actor(id: string, position: Vec3, allegiance: string): CombatActor {
  return {
    id: id as ActorId, species: 'animal', allegiance, position, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 1, y: 0, z: 0 },
    actionId: 'idle', phase: 'idle', normalizedTime: 0, vitality: 100, ferocity: 100, corruption: 100,
    visible: true, downed: false, possessedUntil: 0, radius: 0.3, collisionHeight: 1.6, maxVitality: 100,
    large: false, aerial: false, recoveringUntil: 0, invulnerableUntil: 0, staggerUntil: 0, actionStartedTick: 0, actionEndsTick: 0,
  } as unknown as CombatActor;
}
function engine(): EngineState {
  const slots = { utility: 'nyra' as CompanionId };
  return {
    tick: 1, worldTick: 1, worldTimeScale: 1, runId: 'nyra-test', playerId: 'aren', targetId: 'hostile', counterUntil: 0,
    worldFacts: {}, actors: [actor('aren', { x: 0, y: 0, z: 0 }, 'player'), actor('nyra', { x: 0, y: 0, z: 0 }, 'ally'), actor('hostile', { x: 0, y: 0, z: 0 }, 'hostile')],
    arena: { bounds, groundY: 0, surfaces: [], colliders: [], routes: [], obstacles: [] },
    companionState: createCompanionState(slots), companionSlots: slots, movableObjects: [], events: [], traversalGates: [],
  } as unknown as EngineState;
}

describe('Nyra authored ambush support', () => {
  it('ambushes only a vulnerable opening and never strips corruption', () => {
    const state = engine();
    const target = state.actors.find(candidate => candidate.id === 'hostile')!;
    target.phase = 'recovery';
    expect(companionCommand(state, 'nyra', 'special', target.id)).toBe(true);
    stepCompanions(state);
    expect(target.staggerUntil).toBe(7);
    expect(target.corruption).toBe(100);
    expect(state.events.some(event => event.actorId === 'nyra' && event.message === 'Ambush')).toBe(true);
  });

  it('does not affect a fully cleansed target', () => {
    const state = engine();
    const target = state.actors.find(candidate => candidate.id === 'hostile')!;
    target.phase = 'recovery';
    target.corruption = 0;
    expect(companionCommand(state, 'nyra', 'special', target.id)).toBe(true);
    stepCompanions(state);
    expect(target.corruption).toBe(0);
    expect(target.phase).toBe('recovery');
  });

  it('waits through a closed opening and counters only the current Perfect Dodge target', () => {
    const state = engine();
    const target = state.actors.find(candidate => candidate.id === 'hostile')!;
    target.phase = 'active';
    expect(companionCommand(state, 'nyra', 'special', target.id)).toBe(true);
    stepCompanions(state);
    expect(target.staggerUntil).toBe(0);
    expect(target.phase).toBe('active');
    expect(state.events.some(event => event.actorId === 'nyra')).toBe(false);

    state.tick = 2;
    state.worldTick = 2;
    state.counterUntil = 10;
    state.targetId = 'other' as ActorId;
    state.companionState.slots.nyra!.readyAt = 0;
    expect(companionCommand(state, 'nyra', 'special', target.id)).toBe(true);
    const unmatchedEvents = state.events.length;
    stepCompanions(state);
    expect(target.staggerUntil).toBe(0);
    expect(state.events).toHaveLength(unmatchedEvents);

    state.targetId = target.id;
    state.tick = 3;
    state.worldTick = 3;
    state.companionState.tokens.available = 1;
    state.companionState.slots.nyra!.readyAt = 0;
    expect(companionCommand(state, 'nyra', 'special', target.id)).toBe(true);
    stepCompanions(state);
    expect(target.staggerUntil).toBe(15);
    expect(target.corruption).toBe(100);
    expect(state.events.some(event => event.actorId === 'nyra' && event.message === 'Ambush Counter')).toBe(true);
  });

  it('reveals the authored optional route as a Nyra semantic WorldEvent without completing a quest', async () => {
    const region = REGIONS.find(candidate => candidate.id === 'mistveil-basin')!;
    const nyra = region.entities.find(entity => entity.kind === 'actor' && entity.actorId === 'nyra')!;
    const engine = new CombatEngine();
    engine.loadRegion({
      regionId: region.id, runId: 'nyra-route-event-test', presentActorIds: [nyra.id],
      companionSlots: { utility: 'nyra' }, playerPosition: { ...nyra.position }, wardenCall: false, bond: 0,
    });
    expect(engine.resolveInteraction('nyra-reveal-hidden-route', nyra.id)).toBe(true);
    const event = engine.snapshotState().worldEvents.find(
      candidate => candidate.type === 'semantic-interaction' && candidate.actorId === nyra.id && candidate.interactionId === 'nyra-reveal-hidden-route',
    );
    expect(event?.type).toBe('semantic-interaction');
    if (event?.type !== 'semantic-interaction') throw new Error('Nyra route signal was not emitted.');
    expect(event.actorId).toBe(nyra.id);
    expect(event.kind).toBe('signal');
    expect(event.targetId).toBe('mistveil-hidden-route');

    const director = new CampaignDirector();
    const before = director.startNewRun('nyra-route-event-test');
    const discovered = await director.processEvent(event);
    expect(discovered.worldFacts.mistveil_nyra_hidden_route).toBe(true);
    expect(discovered.completedQuestIds).toEqual(before.completedQuestIds);
    const replayed = await director.processEvent(event);
    expect(replayed.revision).toBe(discovered.revision);
  });
});
