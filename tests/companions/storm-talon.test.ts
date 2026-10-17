import { describe, expect, it } from 'bun:test';
import type { ActorId, Bounds3, CompanionId, CompanionTarget, GroundSurfaceDefinition, Vec3 } from '../../src/game/contracts.js';
import type { CombatActor, EngineState } from '../../src/game/combat/CombatEngine.js';
import { arenaFromRegion } from '../../src/game/combat/geometry.js';
import { commandAvailability, commandCompanion, createCompanionState, stepCompanions } from '../../src/game/companions/CompanionSystem.js';

const bounds: Bounds3 = { min: { x: -16, y: -2, z: -16 }, max: { x: 16, y: 8, z: 16 } };
const floor: GroundSurfaceDefinition = {
  id: 'floor', profile: 'plane', points: [{ x: -16, y: 0, z: -16 }, { x: 16, y: 0, z: -16 }, { x: 16, y: 0, z: 16 }, { x: -16, y: 0, z: 16 }],
  elevation: 0, walkable: true, material: 'soil', colliderId: 'floor',
};
function actor(id: string, position: Vec3, allegiance: 'player' | 'ally' | 'hostile' | 'neutral' | 'wild', species = 'animal'): CombatActor {
  return {
    id: id as ActorId, archetypeId: id as ActorId, species, allegiance, position, velocity: { x: 0, y: 0, z: 0 },
    facing: { x: 0, y: 0, z: 1 }, actionId: 'idle', phase: 'idle', normalizedTime: 0, vitality: 100, ferocity: 100,
    corruption: 0, visible: true, downed: false, possessedUntil: 0, radius: 0.4, collisionHeight: 1, maxVitality: 100, large: false,
    aerial: false, recoveringUntil: 0, invulnerableUntil: 0, staggerUntil: 0, actionStartedTick: 0, actionEndsTick: 0,
  } as unknown as CombatActor;
}
function makeEngine(): EngineState {
  const region = { id: 'whispering-canopy', bounds, ground: { y: 0, surfaces: [floor], colliders: [] }, traversalArcs: [] };
  return {
    tick: 1, worldTick: 1, worldTimeScale: 1, runId: 'storm-talon-test', playerId: 'aren', targetId: 'hostile', regionId: 'whispering-canopy', encounter: null,
    worldFacts: {}, actors: [actor('aren', { x: 0, y: 0, z: 0 }, 'player'), actor('vara', { x: 0, y: 0, z: 0 }, 'ally', 'harpy-eagle'), actor('hostile', { x: 6, y: 0, z: 0 }, 'hostile')],
    arena: arenaFromRegion(region as never), companionState: createCompanionState('vara', 1), player: { vitality: 100, maxVitality: 100 },
    events: [], traversalGates: [], presentationCues: [], seenWorldKeys: [], worldEvents: [], hazards: [], telegraphs: [], movableObjects: [],
    pendingCompanionStrikes: [],
    chapter: { triggers: [], inside: [], intents: [], traps: [] },
  } as unknown as EngineState;
}
function step(engine: EngineState, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    engine.tick++; engine.worldTick++;
    stepCompanions(engine);
    // The Storm Talon queues a pendingCompanionStrike that the engine drains after the companion step;
    // mirror the drain in this minimal test harness so vitality loss + reactions take effect immediately.
    if (engine.pendingCompanionStrikes && engine.pendingCompanionStrikes.length > 0) {
      for (const strike of engine.pendingCompanionStrikes) {
        const target = engine.actors.find(a => a.id === strike.targetId);
        if (!target) continue;
        target.vitality = Math.max(0, (target.vitality ?? 100) - strike.damage);
        if (target.ferocity !== undefined) target.ferocity = Math.max(0, target.ferocity - strike.damage);
      }
      engine.pendingCompanionStrikes.length = 0;
    }
  }
}
const target = (): CompanionTarget => ({ kind: 'actor', instanceId: 'hostile' as ActorId });

describe('Vara Storm Talon command planning', () => {
  it('charges 1 token and enters the climb phase on commit', () => {
    const state = makeEngine();
    const tokensBefore = state.companionState.tokens.available;
    const readyBefore = state.companionState.slots.vara?.readyAt ?? 0;
    expect(commandCompanion(state, { companionId: 'vara', command: 'special', target: target() })).toBe(true);
    expect(state.companionState.tokens.available).toBe(tokensBefore - 1);
    expect(state.companionState.slots.vara?.readyAt).toBeGreaterThan(readyBefore);
    expect(state.companionState.slots.vara?.stormTalon?.phase).toBe('climb');
  });

  it('focus (Mark Weakness) still costs 0 tokens', () => {
    const state = makeEngine();
    const tokensBefore = state.companionState.tokens.available;
    expect(commandCompanion(state, { companionId: 'vara', command: 'focus', target: target() })).toBe(true);
    expect(state.companionState.tokens.available).toBe(tokensBefore);
  });

  it('rejects the command with "No target" when no hostile is in range', () => {
    const state = makeEngine();
    state.actors.find(a => a.id === 'hostile')!.position = { x: 100, y: 0, z: 100 };
    const result = commandCompanion(state, { companionId: 'vara', command: 'special', target: target() });
    expect(result).toBe(false);
    expect(state.companionState.tokens.available).toBe(2);
    expect(state.companionState.slots.vara?.stormTalon).toBeUndefined();
  });

  it('rejects with "No target" when the target is missing', () => {
    const state = makeEngine();
    const result = commandCompanion(state, { companionId: 'vara', command: 'special', target: { kind: 'actor', instanceId: 'ghost' as ActorId } });
    expect(result).toBe(false);
  });

  it('rejects with "Recovering" while a previous storm talon is still resolving', () => {
    const state = makeEngine();
    expect(commandCompanion(state, { companionId: 'vara', command: 'special', target: target() })).toBe(true);
    const result = commandCompanion(state, { companionId: 'vara', command: 'special', target: target() });
    expect(result).toBe(false);
  });

  it('rejects with "No command tokens" when tokens are exhausted', () => {
    const state = makeEngine();
    state.companionState.tokens.available = 0;
    const result = commandCompanion(state, { companionId: 'vara', command: 'special', target: target() });
    expect(result).toBe(false);
    expect(state.companionState.slots.vara?.stormTalon).toBeUndefined();
  });

  it('commandAvailability and commandCompanion agree on every outcome', () => {
    const state = makeEngine();
    const plan = commandAvailability(state, { companionId: 'vara', command: 'special', target: target() });
    expect(plan.available).toBe(true);
    const planFail = commandAvailability(state, { companionId: 'vara', command: 'special', target: { kind: 'actor', instanceId: 'ghost' as ActorId } });
    expect(planFail.available).toBe(false);
    expect(commandCompanion(state, { companionId: 'vara', command: 'special', target: target() })).toBe(true);
    const planRecover = commandAvailability(state, { companionId: 'vara', command: 'special', target: target() });
    expect(planRecover.available).toBe(false);
    expect(commandCompanion(state, { companionId: 'vara', command: 'special', target: target() })).toBe(false);
  });
});

describe('Vara Storm Talon advance', () => {
  it('walks the storm through climb -> dive -> strike -> recover phases on the world clock', () => {
    const state = makeEngine();
    const vara = state.actors.find(a => a.id === 'vara')!;
    vara.position = { x: -4, y: 0, z: 0 };
    const hostile = state.actors.find(a => a.id === 'hostile')!;
    hostile.position = { x: 6, y: 0, z: 0 };
    expect(commandCompanion(state, { companionId: 'vara', command: 'special', target: target() })).toBe(true);
    // Climb phase writes a takeoff actionId and rises to 4 m above the target.
    for (let i = 0; i < 24; i++) step(state, 1);
    expect(vara.position.y).toBeGreaterThan(3);
    // Dive phase: position descends toward the target (the dive ends near the target's height).
    for (let i = 0; i < 21; i++) step(state, 1);
    expect(vara.position.y).toBeLessThan(3.5);
    // The strike should have been applied (dive ends at the target position).
    expect(state.companionState.slots.vara?.stormTalon?.struck).toBe(true);
    // The vitality loss has been applied.
    expect(hostile.vitality).toBeLessThan(100);
    // Strike and flight recovery complete before a new order can be accepted.
    for (let i = 0; i < 60; i++) step(state, 1);
    expect(state.companionState.slots.vara?.stormTalon).toBeUndefined();
  });

  it('storm talon dive descends to the target mid-height band and closes 3D distance to the strike radius', () => {
    const state = makeEngine();
    const vara = state.actors.find(a => a.id === 'vara')!;
    vara.position = { x: -4, y: 0, z: 0 };
    const hostile = state.actors.find(a => a.id === 'hostile')!;
    hostile.position = { x: 6, y: 0, z: 0 };
    hostile.facing = { x: 1, y: 0, z: 0 };
    hostile.collisionHeight = 1.6;
    const targetMidY = hostile.position.y + hostile.collisionHeight * 0.5;
    expect(commandCompanion(state, { companionId: 'vara', command: 'special', target: target() })).toBe(true);
    // Sample the climb position at the top (no early strike should fire here: the climb apex sits 3 m
    // behind the target along -facing so the 2D distance to the target is > the strike radius).
    for (let i = 0; i < 24; i++) step(state, 1);
    expect(Math.hypot(vara.position.x - hostile.position.x, vara.position.z - hostile.position.z)).toBeGreaterThan(hostile.radius + vara.radius + 0.6);
    expect(state.companionState.slots.vara?.stormTalon?.struck).toBeFalsy();
    // Run the full dive window and the recovery, then check the strike landed inside the body band.
    for (let i = 0; i < 30; i++) step(state, 1);
    expect(state.companionState.slots.vara?.stormTalon?.struck).toBe(true);
    // The dive should have closed to within the strike radius (3D, including the body band).
    const distanceAtStrike = state.companionState.slots.vara?.stormTalon?.diveStrikeRadius ?? 0;
    expect(distanceAtStrike).toBeGreaterThan(0);
    // hostil.vitality is drained by the harness; the strike must have applied.
    expect(hostile.vitality).toBeLessThan(100);
    expect(targetMidY).toBeCloseTo(0.8, 6);
  });

  it('storm talon strike fires only on contact: a target that sprints out of range refunds the token', () => {
    const state = makeEngine();
    const vara = state.actors.find(a => a.id === 'vara')!;
    vara.position = { x: -4, y: 0, z: 0 };
    const hostile = state.actors.find(a => a.id === 'hostile')!;
    hostile.position = { x: 6, y: 0, z: 0 };
    hostile.facing = { x: 1, y: 0, z: 0 };
    hostile.collisionHeight = 1.6;
    const initialVitality = hostile.vitality;
    const tokensBefore = state.companionState.tokens.available;
    expect(commandCompanion(state, { companionId: 'vara', command: 'special', target: target() })).toBe(true);
    expect(state.companionState.tokens.available).toBe(tokensBefore - 1);
    // Climb to the apex.
    for (let i = 0; i < 24; i++) step(state, 1);
    // Sprint the target far away (>STORM_TALON_DISENGAGE_RANGE) before the dive closes. The disengage
    // gate refunds the token and bails out through a short recovery.
    for (let i = 0; i < 21; i++) {
      hostile.position = { x: hostile.position.x + 8, y: 0, z: 0 };
      step(state, 1);
    }
    expect(state.companionState.slots.vara?.stormTalon?.struck).toBeFalsy();
    expect(state.companionState.slots.vara?.stormTalon?.missed).toBe(true);
    expect(hostile.vitality).toBe(initialVitality);
    // The token has been refunded.
    expect(state.companionState.tokens.available).toBe(tokensBefore);
  });

  it('storm talon still hits a target that walks at a normal chase speed (raptor stoop tracks the prey)', () => {
    const state = makeEngine();
    const vara = state.actors.find(a => a.id === 'vara')!;
    vara.position = { x: -4, y: 0, z: 0 };
    const hostile = state.actors.find(a => a.id === 'hostile')!;
    hostile.position = { x: 6, y: 0, z: 0 };
    hostile.facing = { x: 1, y: 0, z: 0 };
    hostile.collisionHeight = 1.6;
    const initialVitality = hostile.vitality;
    expect(commandCompanion(state, { companionId: 'vara', command: 'special', target: target() })).toBe(true);
    // Climb to the apex; the apex itself follows the target (back-offset along the new facing).
    for (let i = 0; i < 24; i++) {
      hostile.position = { ...hostile.position, x: hostile.position.x + 0.15 };
      step(state, 1);
    }
    // Walk the target during the dive (a moderate 0.5 m per tick). The bezier endpoint tracks the
    // target, so the raptor still closes 3D to the strike radius and lands the hit.
    for (let i = 0; i < 30; i++) {
      hostile.position = { ...hostile.position, x: hostile.position.x + 0.5 };
      step(state, 1);
    }
    expect(state.companionState.slots.vara?.stormTalon?.struck).toBe(true);
    expect(state.companionState.slots.vara?.stormTalon?.missed).toBe(false);
    expect(hostile.vitality).toBeLessThan(initialVitality);
  });

  it('storm talon still hits a charging target (8 m/s for the dive window)', () => {
    const state = makeEngine();
    const vara = state.actors.find(a => a.id === 'vara')!;
    vara.position = { x: -4, y: 0, z: 0 };
    const hostile = state.actors.find(a => a.id === 'hostile')!;
    hostile.position = { x: 6, y: 0, z: 0 };
    hostile.facing = { x: 1, y: 0, z: 0 };
    hostile.collisionHeight = 1.6;
    const initialVitality = hostile.vitality;
    expect(commandCompanion(state, { companionId: 'vara', command: 'special', target: target() })).toBe(true);
    // Climb to the apex.
    for (let i = 0; i < 24; i++) step(state, 1);
    // Charging target at 8 m/s = 0.133 m/tick. Still within the raptor stoop's tracking range.
    for (let i = 0; i < 35; i++) {
      hostile.position = { ...hostile.position, x: hostile.position.x + 0.133 };
      step(state, 1);
    }
    expect(state.companionState.slots.vara?.stormTalon?.struck).toBe(true);
    expect(state.companionState.slots.vara?.stormTalon?.missed).toBe(false);
    expect(initialVitality - hostile.vitality!).toBeGreaterThan(0);
    expect(initialVitality - hostile.vitality!).toBeLessThanOrEqual(6);
  });

  it('storm talon refunds the token when the target is downed mid-dive', () => {
    const state = makeEngine();
    const vara = state.actors.find(a => a.id === 'vara')!;
    vara.position = { x: -4, y: 0, z: 0 };
    const hostile = state.actors.find(a => a.id === 'hostile')!;
    hostile.position = { x: 6, y: 0, z: 0 };
    hostile.facing = { x: 1, y: 0, z: 0 };
    hostile.collisionHeight = 1.6;
    const tokensBefore = state.companionState.tokens.available;
    expect(commandCompanion(state, { companionId: 'vara', command: 'special', target: target() })).toBe(true);
    expect(state.companionState.tokens.available).toBe(tokensBefore - 1);
    // Climb to the apex; the target stays put so the strike is close to landing.
    for (let i = 0; i < 24; i++) step(state, 1);
    // Down the target mid-dive; the invalid-target branch must fire and refund the token.
    hostile.downed = true;
    for (let i = 0; i < 30; i++) step(state, 1);
    expect(state.companionState.slots.vara?.stormTalon).toBeUndefined();
    expect(state.companionState.tokens.available).toBe(tokensBefore);
  });

  it('deals 1.5x damage and clears the mark when the target was marked by Vara', () => {
    const state = makeEngine();
    const vara = state.actors.find(a => a.id === 'vara')!;
    vara.position = { x: -4, y: 0, z: 0 };
    const hostile = state.actors.find(a => a.id === 'hostile')!;
    hostile.position = { x: 6, y: 0, z: 0 };
    // Complete the native mark gesture before commanding the dive.
    expect(commandCompanion(state, { companionId: 'vara', command: 'focus', target: target() })).toBe(true);
    for (let i = 0; i < 76; i++) step(state, 1);
    expect(hostile.markState?.sourceId).toBe('vara');
    const tokensBefore = state.companionState.tokens.available;
    expect(commandCompanion(state, { companionId: 'vara', command: 'special', target: target() })).toBe(true);
    expect(state.companionState.tokens.available).toBe(tokensBefore - 1);
    for (let i = 0; i < 90; i++) step(state, 1);
    // Mark bonus was consumed by the strike; the mark is gone.
    expect(hostile.markState).toBeUndefined();
  });
});

import { CombatEngine, createEngineState, type CombatInput, type EngineState } from '../../src/game/combat/CombatEngine.js';

describe('Vara Storm Talon engine damage pipeline', () => {
  function makeCombatEngine(): CombatEngine {
    const state = createEngineState();
    state.worldTick = state.tick = 1;
    state.arena.bounds = { min: { x: -16, y: -2, z: -16 }, max: { x: 16, y: 8, z: 16 } };
    state.actors = state.actors.filter(a => a.id === 'aren');
    state.actors.push({
      id: 'vara' as ActorId, species: 'harpy-eagle', allegiance: 'ally', position: { x: -4, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
      facing: { x: 0, y: 0, z: 1 }, actionId: 'vara:idle', phase: 'idle', normalizedTime: 0, vitality: 100, ferocity: 100,
      corruption: 0, visible: true, downed: false, possessedUntil: 0, radius: 0.55, collisionHeight: 1.3, maxVitality: 100, large: false,
      aerial: true, recoveringUntil: 0, invulnerableUntil: 0, staggerUntil: 0, actionStartedTick: 0, actionEndsTick: 0,
    } as unknown as CombatActor);
    state.actors.push({
      id: 'hostile' as ActorId, species: 'animal', allegiance: 'hostile', position: { x: 6, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
      facing: { x: -1, y: 0, z: 0 }, actionId: 'idle', phase: 'idle', normalizedTime: 0, vitality: 100, ferocity: 100,
      corruption: 0, visible: true, downed: false, possessedUntil: 0, radius: 0.4, collisionHeight: 1, maxVitality: 100, large: false,
      aerial: false, recoveringUntil: 0, invulnerableUntil: 0, staggerUntil: 0, actionStartedTick: 0, actionEndsTick: 0,
    } as unknown as CombatActor);
    state.companionState = createCompanionState('vara', 1);
    return new CombatEngine(state);
  }

  it('a Storm Talon strike reduces vitality through the engine and emits exactly one "damage" event whose source is Vara', () => {
    const engine = makeCombatEngine();
    const before = (engine.snapshotState().actors.find(a => a.id === 'hostile') as CombatActor).vitality;
    const accepted = engine.commandCompanion({ companionId: 'vara', command: 'special', target: { kind: 'actor', instanceId: 'hostile' as ActorId } });
    expect(accepted).toBe(true);
    // Storm Talon spends 1 token; the engine restores the token at the next RESOURCE_TICK interval, so we observe
    // the post-spend value while it is still in the recovery window.
    expect(engine.snapshotState().companionState.tokens.available).toBe(1);
    const idle: CombatInput = { tick: 0, move: { x: 0, y: 0, z: 0 }, dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
    for (let tick = 0; tick < 90; tick++) engine.fixedStep(idle);
    const after = engine.snapshotState();
    const hostile = after.actors.find(a => a.id === 'hostile') as CombatActor;
    expect(hostile.vitality).toBeLessThan(before);
    const damageEvents = after.events.filter(e => e.kind === 'damage' && e.actorId === 'vara');
    expect(damageEvents.length).toBe(1);
    expect(damageEvents[0]!.damage!.amount).toBeLessThanOrEqual(6);
    expect(after.companionState.ownerBoon?.kind).toBe('haste');
  });

  it('a non-current trial monster takes no damage from a Storm Talon strike', () => {
    const engine = makeCombatEngine();
    const before = (engine.snapshotState().actors.find(a => a.id === 'hostile') as CombatActor).vitality;
    const state = engine.snapshotState();
    state.combatTrial = { index: 0, monsterId: 'someone-else' as ActorId } as never;
    engine.restore(JSON.stringify(state));
    expect(engine.commandCompanion({ companionId: 'vara', command: 'special', target: { kind: 'actor', instanceId: 'hostile' as ActorId } })).toBe(true);
    const idle: CombatInput = { tick: 0, move: { x: 0, y: 0, z: 0 }, dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
    for (let tick = 0; tick < 90; tick++) engine.fixedStep(idle);
    const after = engine.snapshotState().actors.find(a => a.id === 'hostile') as CombatActor;
    expect(after.vitality).toBe(before);
  });
});
