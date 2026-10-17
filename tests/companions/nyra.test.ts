import { describe, expect, it } from 'bun:test';
import type { ActorId, Bounds3, CompanionId, Vec3 } from '../../src/game/contracts.js';
import type { CombatActor, EngineState } from '../../src/game/combat/CombatEngine.js';
import { CombatEngine, createEngineState } from '../../src/game/combat/CombatEngine.js';
import { CampaignDirector } from '../../src/game/campaign/CampaignDirector.js';
import { commandCompanion, createCompanionState, stepCompanions } from '../../src/game/companions/CompanionSystem.js';
import { REGIONS } from '../../src/content/world.js';

const bounds: Bounds3 = { min: { x: -5, y: -2, z: -5 }, max: { x: 5, y: 5, z: 5 } };
function actor(id: string, position: Vec3, allegiance: string): CombatActor {
  return {
    id: id as ActorId, archetypeId: id as ActorId, species: 'animal', allegiance, position, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 1, y: 0, z: 0 },
    actionId: 'idle', phase: 'idle', normalizedTime: 0, vitality: 100, ferocity: 100, corruption: 100,
    visible: true, downed: false, possessedUntil: 0, radius: 0.3, collisionHeight: 1.6, maxVitality: 100,
    large: false, aerial: false, recoveringUntil: 0, invulnerableUntil: 0, staggerUntil: 0, actionStartedTick: 0, actionEndsTick: 0,
  } as unknown as CombatActor;
}
function engine(): EngineState {
  return {
    tick: 1, worldTick: 1, worldTimeScale: 1, runId: 'nyra-test', playerId: 'aren', targetId: 'hostile', counterUntil: 0,
    worldFacts: {}, actors: [actor('aren', { x: 0, y: 0, z: 0 }, 'player'), actor('nyra', { x: 0, y: 0, z: 0 }, 'ally'), actor('hostile', { x: 0, y: 0, z: 0 }, 'hostile')],
    arena: { bounds, groundY: 0, surfaces: [], colliders: [], routes: [], obstacles: [] },
    companionState: createCompanionState('nyra'), player: createEngineState().player, skillReadyAt: {}, movableObjects: [], events: [], traversalGates: [], presentationCues: [], seenWorldKeys: [], worldEvents: [], hazards: [], telegraphs: [], chapter: { triggers: [], inside: [], intents: [], traps: [] },
  } as unknown as EngineState;
}
function advance(state: EngineState, ticks: number): void {
  for (let i = 0; i < ticks; i++) { state.tick++; state.worldTick++; stepCompanions(state); }
}

describe('Nyra authored ambush support', () => {

  it('never adds corruption to a fully cleansed target', () => {
    const state = engine();
    const target = state.actors.find(candidate => candidate.id === 'hostile')!;
    target.corruption = 0;
    expect(commandCompanion(state, { companionId: 'nyra', command: 'focus', target: { kind: 'actor', instanceId: target.id } })).toBe(true);
    advance(state, 35);
    expect(target.corruption).toBe(0);
  });


  it('reveals the authored optional route as a Nyra semantic WorldEvent without completing a quest', async () => {
    const region = REGIONS.find(candidate => candidate.id === 'mistveil-basin')!;
    const nyra = region.entities.find(entity => entity.kind === 'actor' && entity.actorId === 'nyra')!;
    const engine = new CombatEngine();
    engine.loadRegion({regionId: region.id, runId: 'nyra-route-event-test', presentActorIds: [nyra.id], companionId: 'nyra', playerPosition: { ...nyra.position }, wardenCall: false, bond: 0,});
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
