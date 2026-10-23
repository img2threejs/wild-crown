import { describe, expect, it } from 'bun:test';
import type { ActorId, Bounds3, CompanionId, FieldCommand, GroundSurfaceDefinition, Vec3 } from '../../src/game/contracts.js';
import { CombatEngine, type CombatActor, type CombatInput, type EngineState } from '../../src/game/combat/CombatEngine.js';
import { arenaFromRegion } from '../../src/game/combat/geometry.js';
import { commandAvailability, commandCompanion, commandTargets, createCompanionState, stepCompanions } from '../../src/game/companions/CompanionSystem.js';

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

  it('finishes the Canopy mark and rear-warning lesson on unengaged wildlife without provoking or damaging it', () => {
    const engine = new CombatEngine();
    engine.loadRegion({
      regionId: 'whispering-canopy', runId: 'wild-scout',
      presentActorIds: ['canopy-vara', 'canopy-howler'], companionId: 'vara', chapter: 1,
      playerPosition: { x: -46, y: 0, z: -29 },
    });
    const request = { companionId: 'vara', command: 'focus', target: { kind: 'actor', instanceId: 'canopy-howler' } } as const;
    const before = engine.snapshot().actors.find(candidate => candidate.id === 'canopy-howler')!;
    expect(before.allegiance).toBe('wild');
    expect(engine.commandTargets('vara', 'focus')).toContainEqual(request.target);
    expect(engine.commandCompanion(request)).toBe(true);
    for (let frame = 0; frame < 24; frame += 1) engine.fixedStep();
    const marked = engine.snapshot().actors.find(candidate => candidate.id === 'canopy-howler')!;
    expect(marked.mark?.sourceId).toBe('canopy-vara');
    expect(engine.scoutWarningTargetId).toBe('canopy-howler');
    expect(engine.consumeWorldEvents().filter(event => event.type === 'semantic-interaction').map(event => event.interactionId)).toEqual(['bird-mark']);
    const turn: CombatInput = {
      tick: 1, move: { x: 0, y: 0, z: -1 }, dodgePressed: false, lightPressed: false,
      heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false, lockOnPressed: false, lockOnHeld: false,
    };
    for (let frame = 0; frame < 16; frame += 1) engine.fixedStep(turn);
    expect(engine.consumeWorldEvents().filter(event => event.type === 'semantic-interaction').map(event => event.interactionId)).toEqual(['warning-response']);
    expect(engine.scoutWarningTargetId).toBeUndefined();
    for (let frame = 0; frame < 120; frame += 1) engine.fixedStep();
    const after = engine.snapshot().actors.find(candidate => candidate.id === 'canopy-howler')!;
    expect(after.allegiance).toBe('wild');
    expect(after.vitality).toBe(before.vitality);
    expect(after.position).toEqual(before.position);
    expect(after.targetId).toBeUndefined();
    expect(engine.companions.tokens.available).toBe(2);
    expect(engine.consumeWorldEvents().filter(event => event.type === 'semantic-interaction')).toEqual([]);
  });

  it('does not make wild combatants valid targets for offensive commands', () => {
    const cases: readonly [CompanionId, FieldCommand][] = [['vara', 'special'], ['vara', 'distract'], ['koro', 'focus']];
    for (const [companionId, command] of cases) {
      const state = warningState();
      state.actors[1] = actor(companionId, { x: 0, y: 2, z: 0 }, 'ally');
      state.companionState = createCompanionState(companionId, 1);
      const target = state.actors[2]!;
      target.archetypeId = 'canopy-howler';
      const request = { companionId, command, target: { kind: 'actor', instanceId: target.id } } as const;
      expect(commandAvailability(state, request).available).toBe(true);
      target.allegiance = 'wild';
      expect(commandAvailability(state, request).available).toBe(false);
      expect(commandTargets(state, companionId, command)).not.toContainEqual(request.target);
      expect(commandCompanion(state, request)).toBe(false);
      expect(state.companionState.tokens.available).toBe(2);
      expect(target.vitality).toBe(100);
    }
  });

  it('does not scout ambient animals, allies, hidden, downed or out-of-range wild targets', () => {
    for (const unavailable of ['ambient', 'ally', 'hidden', 'downed', 'range'] as const) {
      const state = warningState(), target = state.actors[2]!;
      target.archetypeId = unavailable === 'ambient' ? 'roost-hornbill' : 'canopy-howler';
      target.allegiance = unavailable === 'ally' ? 'ally' : 'wild';
      if (unavailable === 'hidden') target.visible = false;
      if (unavailable === 'downed') target.downed = true;
      if (unavailable === 'range') target.position.x = -100;
      expect(commandCompanion(state, { companionId: 'vara', command: 'focus', target: { kind: 'actor', instanceId: target.id } })).toBe(false);
      stepCompanions(state);
      expect(state.companionState.slots.vara?.warning).toBeUndefined();
      expect(state.worldEvents).toEqual([]);
      expect(target.markState).toBeUndefined();
    }
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
