import { describe, expect, it } from 'bun:test';
import type { ActorId, Bounds3, GroundSurfaceDefinition, RegionColliderDefinition, Vec3 } from '../../src/game/contracts.js';
import type { CombatActor, EngineState } from '../../src/game/combat/CombatEngine.js';
import { arenaFromRegion } from '../../src/game/combat/geometry.js';
import { commandCompanion, companionSignal, configureCompanions, createCompanionState, stepCompanions, type NavNode } from '../../src/game/companions/CompanionSystem.js';

const bounds: Bounds3 = { min: { x: -6, y: -2, z: -6 }, max: { x: 6, y: 6, z: 6 } };
const floor: GroundSurfaceDefinition = {
  id: 'floor', profile: 'plane', points: [{ x: -6, y: 0, z: -6 }, { x: 6, y: 0, z: -6 }, { x: 6, y: 0, z: 6 }, { x: -6, y: 0, z: 6 }],
  elevation: 0, walkable: true, material: 'soil', colliderId: 'floor-collider',
};
const wall: RegionColliderDefinition = { id: 'wall', kind: 'segment', from: { x: 0, y: 0, z: -4 }, to: { x: 0, y: 0, z: 4 }, radius: 0.12, blocksMovement: true, blocksCamera: false };
function makeEngine(companionIds: readonly ('vara' | 'koro' | 'asha' | 'sable' | 'nyra' | 'solkar')[], colliders: readonly RegionColliderDefinition[] = [wall]): EngineState {
  const actor = (id: string, position: Vec3, allegiance: string = 'ally') => ({
    id: id as ActorId, archetypeId: id as ActorId, species: 'animal', allegiance, position, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 1, y: 0, z: 0 },
    actionId: 'idle', phase: 'idle', normalizedTime: 0, vitality: 100, ferocity: 100, corruption: 100, targetId: undefined,
    visible: true, downed: false, possessedUntil: 0, radius: 0.3, maxVitality: 100, large: false, aerial: false,
    recoveringUntil: 0, invulnerableUntil: 0, staggerUntil: 0, actionStartedTick: 0, actionEndsTick: 0,
  } as unknown as CombatActor);
  const region = { bounds, ground: { y: 0, profile: 'flat', navGraphId: 'fixture', surfaces: [floor], colliders }, traversalArcs: [], id: 'greenwake', navigation: { nodes: [] } };
  const companionState = createCompanionState(companionIds[0], 1);
  return {
    tick: 0, worldTick: 0, worldTimeScale: 1, runId: 'companion-test', playerId: 'aren', player: {}, regionId: 'greenwake', encounter: null,
    worldFacts: {}, actors: [actor('aren', { x: 2, y: 0, z: 0 }, 'player'), ...companionIds.map(id => actor(id, { x: -2, y: 0, z: 0 })), actor('hostile-test', { x: 3, y: 0, z: 0 }, 'hostile')],
    arena: arenaFromRegion(region as never), movableObjects: [], companionState, events: [], traversalGates: [],
    presentationCues: [], seenWorldKeys: [], worldEvents: [], hazards: [], telegraphs: [],
    chapter: { triggers: [], inside: [], intents: [], traps: [] },
  } as unknown as EngineState;
}

describe('companion commands and grounded navigation', () => {
  it('refuses absent, possessed and non-slot companions without manufacturing allies', () => {
    const engine = makeEngine(['koro']);
    expect(commandCompanion(engine, { companionId: 'vara', command: 'special' })).toBe(false);
    expect(commandCompanion(engine, { companionId: 'solkar', command: 'special' })).toBe(false);
    expect(engine.actors.some(actor => actor.id === 'vara')).toBe(false);
    const koro = engine.actors.find(actor => actor.id === 'koro')!;
    engine.companionState.slots.koro!.possessed = true;
    expect(commandCompanion(engine, { companionId: 'koro', command: 'distract' })).toBe(false);
    engine.companionState.slots.koro!.possessed = false;
    koro.visible = false;
    expect(commandCompanion(engine, { companionId: 'koro', command: 'search' })).toBe(false);
  });


  it('preserves the explicit Warden’s Call fact instead of deriving it from chapter', () => {
    const engine = makeEngine(['koro']);
    configureCompanions(engine, { wardenCall: false, chapter: 5, bond: 9 });
    expect(engine.companionState.wardenCall).toBe(false);
    expect(companionSignal(engine, 'koro', 'hostile-test' as ActorId)).toBe(false);
    configureCompanions(engine, { chapter: 9 });
    expect(engine.companionState.wardenCall).toBe(false);
    engine.companionState.bond = 10;
    expect(companionSignal(engine, 'koro', 'hostile-test' as ActorId)).toBe(true);
  });

  it('follows only through reachable navigation links and stops safely when no path exists', () => {
    const engine = makeEngine(['koro']);
    const koro = engine.actors.find(actor => actor.id === 'koro')!;
    const nodes: NavNode[] = [
          { id: 'west', position: { x: -1, y: 0, z: 5.5 }, links: ['east'] },
          { id: 'east', position: { x: 1, y: 0, z: 5.5 }, links: ['west'], requirement: 'bridge_open' },
        ];
    configureCompanions(engine, { navNodes: nodes });
        const closedPosition = { ...koro.position };
        engine.tick = 0; engine.worldTick = 0; stepCompanions(engine);
        expect(koro.position).toEqual(closedPosition);
        expect(engine.companionState.slots.koro?.pathFallback).toBe(true);
        engine.worldFacts = { bridge_open: true };
    for (let tick = 0; tick < 300; tick++) { engine.tick = tick; engine.worldTick = tick; stepCompanions(engine); }
    expect(koro.position.x).toBeGreaterThan(0.5);
    expect(koro.position.z).toBeGreaterThan(0);
    engine.companionState.navNodes = [];
    koro.position = { x: -2, y: 0, z: 0 };
    const stopped = { ...koro.position };
    engine.tick++;
    engine.worldTick++;
    stepCompanions(engine);
    expect(koro.position).toEqual(stopped);
    expect(engine.companionState.slots.koro?.pathFallback).toBe(true);
  });

  it('does not traverse a navigation node whose gate fact is closed', () => {
    const engine = makeEngine(['koro']);
    const koro = engine.actors.find(actor => actor.id === 'koro')!;
    engine.companionState.navNodes = [{ id: 'closed-gate', position: { x: -1, y: 0, z: 3 }, links: [], requirement: 'canopy_bridge_open' }];
    const before = { ...koro.position };
    engine.tick = 1;
    engine.worldTick = 1;
    stepCompanions(engine);
    expect(koro.position).toEqual(before);
    expect(engine.companionState.slots.koro?.pathFallback).toBe(true);
  });
});
