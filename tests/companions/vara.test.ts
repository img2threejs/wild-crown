import { describe, expect, it } from 'bun:test';
import type { ActorId, Bounds3, GroundSurfaceDefinition, Vec3 } from '../../src/game/contracts.js';
import type { CombatActor, EngineState } from '../../src/game/combat/CombatEngine.js';
import { arenaFromRegion } from '../../src/game/combat/geometry.js';
import { commandCompanion, createCompanionState, stepCompanions } from '../../src/game/companions/CompanionSystem.js';

const bounds: Bounds3 = { min: { x: -5, y: -1, z: -5 }, max: { x: 5, y: 8, z: 5 } };
const floor: GroundSurfaceDefinition = {
  id: 'floor', profile: 'plane', points: [{ x: -5, y: 0, z: -5 }, { x: 5, y: 0, z: -5 }, { x: 5, y: 0, z: 5 }, { x: -5, y: 0, z: 5 }],
  elevation: 0, walkable: true, material: 'soil', colliderId: 'floor',
};
function actor(id: string, position: Vec3, allegiance: string): CombatActor {
  return {
    id: id as ActorId, species: id === 'vara' ? 'harpy-eagle' : 'animal', allegiance, position, velocity: { x: 0, y: 0, z: 0 },
    facing: { x: 1, y: 0, z: 0 }, actionId: 'idle', phase: 'idle', normalizedTime: 0, vitality: 100, ferocity: 100,
    corruption: 0, visible: true, downed: false, possessedUntil: 0, radius: 0.3, maxVitality: 100, large: false,
    aerial: id === 'vara', recoveringUntil: 0, invulnerableUntil: 0, staggerUntil: 0, actionStartedTick: 0, actionEndsTick: 0,
  } as unknown as CombatActor;
}

function warningState(): EngineState {
  const region = { id: 'whispering-canopy', bounds, ground: { y: 0, surfaces: [floor], colliders: [] }, traversalArcs: [] };
  return {
    tick: 1, worldTick: 1, eventSequence: 0, worldTimeScale: 1, runId: 'warning-test', playerId: 'aren', regionId: 'whispering-canopy', encounter: null,
    worldFacts: {}, actors: [actor('aren', { x: 0, y: 0, z: 0 }, 'player'), actor('vara', { x: 0, y: 2, z: 0 }, 'ally'), actor('hostile', { x: -3, y: 0, z: 0 }, 'hostile')],
    arena: arenaFromRegion(region as never), companionState: createCompanionState('vara', 1),
    events: [], traversalGates: [], presentationCues: [], seenWorldKeys: [], worldEvents: [], hazards: [], telegraphs: [], movableObjects: [],
    chapter: { triggers: [], inside: [], intents: [], traps: [] },
  } as unknown as EngineState;
}

describe('Vara aerial scout mark', () => {
  it('marks a live target without spending a combat token or causing damage', () => {
    const region = { id: 'whispering-canopy', bounds, ground: { y: 0, surfaces: [floor], colliders: [] }, traversalArcs: [] };
    const state = {
      tick: 1, worldTick: 1, worldTimeScale: 1, runId: 'vara-test', playerId: 'aren', targetId: 'hostile', regionId: 'whispering-canopy', encounter: null,
      worldFacts: {}, actors: [actor('aren', { x: 0, y: 0, z: 0 }, 'player'), actor('vara', { x: 0, y: 0, z: 0 }, 'ally'), actor('hostile', { x: 0, y: 0, z: 0 }, 'hostile')],
      arena: arenaFromRegion(region as never), companionState: createCompanionState('vara', 1), events: [], traversalGates: [], presentationCues: [], seenWorldKeys: [], worldEvents: [], hazards: [], telegraphs: [], movableObjects: [],
      chapter: { triggers: [], inside: [], intents: [], traps: [] },
    } as unknown as EngineState;
    expect(commandCompanion(state, { companionId: 'vara', command: 'focus', target: { kind: 'actor', instanceId: 'hostile' as ActorId } })).toBe(true);
    expect(state.companionState.tokens.available).toBe(2);
    expect(state.actors.find(candidate => candidate.id === 'hostile')?.markState).toBeUndefined();
    for (let i = 0; i < 24; i++) { state.tick++; state.worldTick++; stepCompanions(state); }
    expect(state.actors.find(candidate => candidate.id === 'hostile')?.markState?.sourceId).toBe('vara');
    expect(state.actors.find(candidate => candidate.id === 'hostile')?.vitality).toBe(100);
    expect(state.events.some(event => event.actorId === 'vara' && event.message === 'Mark Weakness')).toBe(true);
  });

  it('requires a real rear warning followed by facing that same live threat; replay emits once', () => {
    const state = warningState();
    stepCompanions(state);
    expect(state.events.filter(event => event.actionId === 'vara-warning').map(event => event.targetId)).toEqual(['hostile']);
    expect(state.worldEvents).toEqual([]);
    stepCompanions(state);
    expect(state.worldEvents).toEqual([]);
    const restored = JSON.parse(JSON.stringify(state)) as EngineState;
    restored.actors[0]!.facing = { x: -1, y: 0, z: 0 };
    stepCompanions(restored);
    expect(restored.worldEvents.map(event => event.type === 'semantic-interaction' ? event.interactionId : event.type)).toEqual(['warning-response']);
    expect(restored.companionState.tokens.available).toBe(2);
    restored.worldTick = 700;
    restored.actors[0]!.facing = { x: 1, y: 0, z: 0 };
    stepCompanions(restored);
    restored.actors[0]!.facing = { x: -1, y: 0, z: 0 };
    stepCompanions(restored);
    expect(restored.worldEvents).toHaveLength(1);
  });

  it('never grants a response for front-facing danger, an expired warning, or a vanished threat', () => {
    const front = warningState();
    front.actors[0]!.facing = { x: -1, y: 0, z: 0 };
    stepCompanions(front);
    expect(front.companionState.slots.vara!.warning).toBeUndefined();
    expect(front.worldEvents).toEqual([]);
    for (const expired of [false, true]) {
      const state = warningState();
      stepCompanions(state);
      state.actors[0]!.facing = { x: -1, y: 0, z: 0 };
      if (expired) state.worldTick = 301;
      else state.actors[2]!.visible = false;
      stepCompanions(state);
      expect(state.worldEvents).toEqual([]);
      expect(state.companionState.slots.vara!.warning).toBeUndefined();
    }
  });

  it('cancels a pending warning if Vara becomes unavailable', () => {
    const state = warningState();
    stepCompanions(state);
    state.actors[1]!.possessedUntil = 100;
    state.actors[0]!.facing = { x: -1, y: 0, z: 0 };
    stepCompanions(state);
    expect(state.worldEvents).toEqual([]);
    expect(state.companionState.slots.vara!.warning).toBeUndefined();
  });
});
