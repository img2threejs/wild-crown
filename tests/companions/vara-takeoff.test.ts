import { describe, expect, it } from 'bun:test';
import type { ActorId, Bounds3, GroundSurfaceDefinition, Vec3 } from '../../src/game/contracts.js';
import type { CombatActor, EngineState } from '../../src/game/combat/CombatEngine.js';
import { arenaFromRegion } from '../../src/game/combat/geometry.js';
import { commandCompanion, createCompanionState, stepCompanions } from '../../src/game/companions/CompanionSystem.js';

const bounds: Bounds3 = { min: { x: -16, y: -2, z: -16 }, max: { x: 16, y: 8, z: 16 } };
const floor: GroundSurfaceDefinition = {
  id: 'floor', profile: 'plane', points: [{ x: -16, y: 0, z: -16 }, { x: 16, y: 0, z: -16 }, { x: 16, y: 0, z: 16 }, { x: -16, y: 0, z: 16 }],
  elevation: 0, walkable: true, material: 'soil', colliderId: 'floor',
};
function actor(id: string, position: Vec3, allegiance: 'player' | 'ally' | 'hostile' | 'neutral' | 'wild', species = 'animal'): CombatActor {
  return {
    id: id as ActorId, species, allegiance, position, velocity: { x: 0, y: 0, z: 0 },
    facing: { x: 0, y: 0, z: 1 }, actionId: 'idle', phase: 'idle', normalizedTime: 0, vitality: 100, ferocity: 100,
    corruption: 0, visible: true, downed: false, possessedUntil: 0, radius: 0.55, collisionHeight: 1.3, maxVitality: 100, large: false,
    aerial: id === 'vara', recoveringUntil: 0, invulnerableUntil: 0, staggerUntil: 0, actionStartedTick: 0, actionEndsTick: 0,
  } as unknown as CombatActor;
}
const region = { id: 'whispering-canopy', bounds, ground: { y: 0, surfaces: [floor], colliders: [] }, traversalArcs: [] };

function makeEngine(varaPosition: Vec3, arenPosition: Vec3): EngineState {
  return {
    tick: 1, worldTick: 1, worldTimeScale: 1, runId: 'takeoff-test', playerId: 'aren', regionId: 'whispering-canopy', encounter: null,
    worldFacts: {}, actors: [
      actor('aren', arenPosition, 'player'),
      actor('vara', varaPosition, 'ally', 'harpy-eagle'),
    ],
    arena: arenaFromRegion(region as never), companionState: createCompanionState('vara', 1),
    events: [], traversalGates: [], presentationCues: [], seenWorldKeys: [], worldEvents: [], hazards: [], telegraphs: [], movableObjects: [],
    pendingCompanionStrikes: [],
    chapter: { triggers: [], inside: [], intents: [], traps: [] },
  } as unknown as EngineState;
}

describe('Vara takeoff determinism (round-2 bug fixes)', () => {
  it('a slot that spawns overlapping Aren is snapped to a perch that keeps clearance from the hero', () => {
    const state = makeEngine({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    const vara = state.actors.find(a => a.id === 'vara')!;
    const aren = state.actors.find(a => a.id === 'aren')!;
    // The first tick inits the slot and runs the takeoff gate check; Vara must already sit at a perch.
    stepCompanions(state);
    const heroClearance = Math.hypot(vara.position.x - aren.position.x, vara.position.z - aren.position.z);
    expect(heroClearance).toBeGreaterThanOrEqual(vara.radius + aren.radius);
  });

  it('takeoff altitude rises monotonically and reaches the flight altitude within its duration while Aren keeps moving', () => {
    const state = makeEngine({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    const vara = state.actors.find(a => a.id === 'vara')!;
    const aren = state.actors.find(a => a.id === 'aren')!;
    stepCompanions(state);
    // Aren walks forward at 0.1 m per world tick (3.3 m/s scaled); the takeoff gate (3 m cumulative)
    // trips within the first second.
    const yCurve: number[] = [];
    const actions: string[] = [];
    for (let i = 0; i < 80; i++) {
      aren.position = { ...aren.position, x: aren.position.x + 0.1 };
      state.tick++; state.worldTick++;
      stepCompanions(state);
      yCurve.push(vara.position.y);
      actions.push(vara.actionId);
    }
    const takeoffStart = actions.indexOf('vara:takeoff');
    expect(takeoffStart).toBeGreaterThanOrEqual(0);
    // The first 30 samples after takeoff engages must be monotonically non-decreasing.
    for (let i = takeoffStart + 1; i < Math.min(takeoffStart + 30, yCurve.length); i++) {
      if (yCurve[i]! < yCurve[i - 1]! - 1e-6) {
        throw new Error(`y decreased at index ${i}: ${yCurve[i - 1]} -> ${yCurve[i]}`);
      }
    }
    // By the end of the takeoff window, Vara must have reached the flight altitude (VARA_FLY_ALTITUDE = 2.4m).
    const takeoffEnd = Math.min(takeoffStart + 29, yCurve.length - 1);
    expect(yCurve[takeoffEnd]!).toBeGreaterThan(2.0);
  });

  it('takeoff never overlaps the hero: the perch clears Arens body by at least combined radii', () => {
    const state = makeEngine({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    const vara = state.actors.find(a => a.id === 'vara')!;
    const aren = state.actors.find(a => a.id === 'aren')!;
    stepCompanions(state);
    // The slot inits perched with clearance.
    expect(Math.hypot(vara.position.x - aren.position.x, vara.position.z - aren.position.z))
      .toBeGreaterThanOrEqual(vara.radius + aren.radius);
    // Walk Aren across the arena; the perch (locked when takeoff engages) must keep clearance throughout.
    for (let i = 0; i < 60; i++) {
      aren.position = { ...aren.position, x: aren.position.x + 0.15 };
      state.tick++; state.worldTick++;
      stepCompanions(state);
      if (state.companionState.slots.vara?.flight?.phase === 'takeoff') {
        const clearance = Math.hypot(vara.position.x - aren.position.x, vara.position.z - aren.position.z);
        // Perch stays put while the takeoff animation runs; the actor must still clear the hero (the
        // hero is moving away, not toward the perch).
        expect(clearance).toBeGreaterThanOrEqual(vara.radius + aren.radius - 0.05);
      }
    }
  });
});

describe('Vara airborne field surveys', () => {
  for (const phase of ['grounded', 'landing'] as const) {
    it(`reaches an accepted search location from ${phase} instead of orbiting the stationary hero`, () => {
      const state = makeEngine({ x: -1.3, y: phase === 'landing' ? 1.2 : 0, z: -2.8 }, { x: 0, y: 0, z: -4 });
      state.regionId = 'greenwake';
      const vara = state.actors[1]!, slot = state.companionState.slots.vara!;
      slot.flight = { phase, phaseStartedAt: state.worldTick, perch: { x: -1.3, y: 0, z: -2.8 }, playerAnchor: { ...state.actors[0]!.position }, playerIdleSince: state.worldTick };
      expect(commandCompanion(state, { companionId: 'vara', command: 'search', target: { kind: 'interaction', interactionId: 'greenwake-roars', targetId: 'greenwake-roars' } })).toBe(true);
      let contactHeight = -1, contactDistance = Infinity;
      for (let tick = 0; tick < 400; tick++) {
        state.tick++; state.worldTick++; stepCompanions(state);
        if (slot.skill?.kind === 'search' && slot.skill.resolved) {
          contactHeight = vara.position.y;
          contactDistance = Math.hypot(vara.position.x + 2, vara.position.z + 7);
        }
      }
      expect(state.worldEvents.filter(event => event.type === 'semantic-interaction' && event.interactionId === 'greenwake-roars')).toHaveLength(1);
      expect(contactDistance).toBeLessThan(1.4);
      expect(contactHeight).toBeGreaterThan(1.8);
    });
  }

  it('takes off before an untargeted survey rather than banking its wings through the ground', () => {
    const state = makeEngine({ x: -1.3, y: 0, z: -2.8 }, { x: 0, y: 0, z: -4 });
    const vara = state.actors[1]!, slot = state.companionState.slots.vara!;
    slot.flight = { phase: 'grounded', phaseStartedAt: state.worldTick, perch: { ...vara.position }, playerAnchor: { ...state.actors[0]!.position }, playerIdleSince: state.worldTick };
    expect(commandCompanion(state, { companionId: 'vara', command: 'search' })).toBe(true);
    let contactHeight = -1;
    for (let tick = 0; tick < 100; tick++) {
      state.tick++; state.worldTick++; stepCompanions(state);
      if (slot.skill?.kind === 'search' && slot.skill.resolved) contactHeight = vara.position.y;
    }
    expect(contactHeight).toBeGreaterThan(2);
    expect(slot.job).toBeUndefined();
  });
});
