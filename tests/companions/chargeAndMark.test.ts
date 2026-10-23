import { describe, expect, it } from 'bun:test';
import type { ActorId, Bounds3, CompanionId, GroundSurfaceDefinition, Vec3 } from '../../src/game/contracts.js';
import { CombatEngine, type CombatInput, type CombatActor, type EngineState, type LiveHazard } from '../../src/game/combat/CombatEngine.js';
import { arenaFromRegion } from '../../src/game/combat/geometry.js';
import { commandAvailability, commandCompanion, createCompanionState, markSnapshot, stepCompanions, tryGuardBlock } from '../../src/game/companions/CompanionSystem.js';

const bounds: Bounds3 = { min: { x: -8, y: -2, z: -8 }, max: { x: 8, y: 6, z: 8 } };
const floor: GroundSurfaceDefinition = {
  id: 'floor', profile: 'plane', points: [{ x: -8, y: 0, z: -8 }, { x: 8, y: 0, z: -8 }, { x: 8, y: 0, z: 8 }, { x: -8, y: 0, z: 8 }],
  elevation: 0, walkable: true, material: 'soil', colliderId: 'floor',
};
function actor(id: string, position: Vec3, allegiance = 'ally'): CombatActor {
  return {
    id: id as ActorId, archetypeId: id as ActorId, species: 'animal', allegiance, position, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 1, y: 0, z: 0 },
    actionId: 'idle', phase: 'idle', normalizedTime: 0, vitality: 100, ferocity: 100, corruption: 100, visible: true, downed: false,
    possessedUntil: 0, radius: 0.3, collisionHeight: 1.6, maxVitality: 100, large: false, aerial: false, recoveringUntil: 0,
    invulnerableUntil: 0, staggerUntil: 0, actionStartedTick: 0, actionEndsTick: 0,
  } as unknown as CombatActor;
}
function makeEngine(companionId?: CompanionId): EngineState {
  const region = { id: 'whispering-canopy', bounds, ground: { y: 0, surfaces: [floor], colliders: [] }, traversalArcs: [] };
  const companionState = createCompanionState(companionId, 1);
  return {
    tick: 1, worldTick: 1, worldTimeScale: 1, runId: 'charge-mark-test', playerId: 'aren', targetId: 'hostile', regionId: 'whispering-canopy', encounter: null,
    worldFacts: {}, actors: [actor('aren', { x: 0, y: 0, z: 0 }, 'player'), ...(companionId ? [actor(companionId, { x: 0, y: 0, z: 0 })] : []), actor('hostile', { x: 0, y: 0, z: 4 }, 'hostile')],
    arena: arenaFromRegion(region as never), movableObjects: [], companionState, events: [], traversalGates: [], presentationCues: [], seenWorldKeys: [], worldEvents: [], hazards: [], telegraphs: [], bossLunges: [],
    chapter: { triggers: [], inside: [], intents: [], traps: [] },
  } as unknown as EngineState;
}
function advance(state: EngineState, ticks: number): void {
  for (let i = 0; i < ticks; i++) { state.tick++; state.worldTick++; stepCompanions(state); }
}
/** Seeds a guardable bamboo-charge hazard aimed at the player with `windupRemaining` ticks before the active window opens. */
function seedChargeHazard(state: EngineState, origin: Vec3, target: Vec3, targetActorId: string, windupRemaining = 8, attackId = 'asha-bamboo-charge' as never): LiveHazard {
  const hostile = state.actors.find(candidate => candidate.id === 'hostile')!;
  const direction = { x: target.x - origin.x, y: 0, z: target.z - origin.z };
  const magnitude = Math.hypot(direction.x, direction.z) || 1;
  const normalised = { x: direction.x / magnitude, y: 0, z: direction.z / magnitude };
  const now = state.worldTick;
  const hazard: LiveHazard = {
    id: `hazard-${attackId}-${now}`,
    attackId,
    sourceId: hostile.id,
    startTick: now,
    windupUntil: now + windupRemaining,
    activeFrom: now + windupRemaining,
    activeUntil: now + windupRemaining + 30,
    castUntil: now + windupRemaining + 30,
    recoveryUntil: now + windupRemaining + 60,
    target: { ...target },
    origin: { ...origin },
    direction: normalised,
    range: 6,
    angleDeg: 70,
    hitIds: [],
    threatTicks: [now + windupRemaining - 2, now + windupRemaining],
    cue: 'windup',
    targetActorId,
    warningPresentationEmitted: false,
    kind: 'sweep', width: 2.6, depth: 6, radius: 0, heightAboveGround: 1.4, damage: 20, bounds: { min: { x: -8, y: -2, z: -8 }, max: { x: 8, y: 6, z: 8 } }, hitGroup: attackId,
  };
  state.hazards.push(hazard);
  state.telegraphs.push({ id: hazard.id, attackId: hazard.attackId, sourceId: hostile.id, targetPosition: { ...target }, phase: 'windup', remainingTicks: windupRemaining, cue: 'windup' });
  return hazard;
}

function resolveCharge(guarded: boolean): EngineState {
  const engine = new CombatEngine();
  engine.loadRegion({regionId: 'blood-bamboo-valley', runId: 'guard-integration',
  presentActorIds: ['asha', 'hunter-ranged'], playerPosition: { x: 0, y: 0, z: 0 }, companionId: 'asha', worldFacts: { 'encounter-asha-cleansed': true },});
  const state = engine.snapshotState();
  state.arena = makeEngine().arena;
  state.worldTick = state.tick = 1;
  state.actors = state.actors.filter(actor => ['aren', 'asha', 'hunter-ranged'].includes(actor.id));
  const asha = state.actors.find(actor => actor.id === 'asha')!;
  asha.position = { x: 0, y: 0, z: 1.65 };
  const hostile = state.actors.find(actor => actor.id === 'hunter-ranged')!;
  hostile.id = 'hostile' as ActorId;
  hostile.position = { x: 0, y: 0, z: 4 };
  hostile.recoveringUntil = 1000;
  const hazard = seedChargeHazard(state, hostile.position, { x: 0, y: 0, z: 0 }, 'aren');
  engine.restore(JSON.stringify(state));
  if (guarded) expect(engine.commandCompanion({
    companionId: 'asha', command: 'special',
    target: { kind: 'hazard', hazardId: hazard.id, protecteeId: 'aren' },
  })).toBe(true);
  const idle: CombatInput = { tick: 0, move: { x: 0, y: 0, z: 0 }, dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
  for (let tick = 0; tick < 12; tick++) engine.fixedStep(idle);
  return engine.snapshotState();
}

describe('Asha charge block guards Aren against an active hostile charge', () => {
  it('prevents charge damage through the live engine hazard consumer, unlike an unguarded charge', () => {
    const unguarded = resolveCharge(false), guarded = resolveCharge(true);
    expect(unguarded.player.vitality).toBeLessThan(unguarded.player.maxVitality);
    expect(guarded.player.vitality).toBe(guarded.player.maxVitality);
    expect(guarded.companionState.tokens.available).toBe(unguarded.companionState.tokens.available - 1);
    expect(guarded.companionState.slots.asha?.guard?.state).toBe('recovery');
    expect(guarded.presentationCues.some(cue => cue.kind === 'guard' && cue.phase === 'hit' && cue.targetId === 'aren')).toBe(true);
  });

  it('refuses to intercept when Asha stands outside the supported GUARD_RADIUS of the protectee', () => {
    const state = makeEngine('asha');
    const asha = state.actors.find(candidate => candidate.id === 'asha')!;
    asha.position = { x: 5, y: 0, z: 0 };
    const tokensBefore = state.companionState.tokens.available;
    const readyBefore = state.companionState.slots.asha?.readyAt ?? 0;
    const hazard = seedChargeHazard(state, { x: 0, y: 0, z: 4 }, { x: 0, y: 0, z: 0 }, 'aren');
    expect(commandCompanion(state, { companionId: 'asha', command: 'special', target: { kind: 'hazard', hazardId: hazard.id, protecteeId: 'aren' as ActorId } })).toBe(false);
    expect(state.companionState.tokens.available).toBe(tokensBefore);
    expect(state.companionState.slots.asha?.readyAt).toBe(readyBefore);
    expect(state.companionState.slots.asha?.guard).toBeUndefined();
  });

  it('refuses to intercept when Asha stands outside the protectee-to-attacker cone', () => {
    const state = makeEngine('asha');
    const asha = state.actors.find(candidate => candidate.id === 'asha')!;
    asha.position = { x: 0, y: 0, z: 0.6 };
    const tokensBefore = state.companionState.tokens.available;
    const readyBefore = state.companionState.slots.asha?.readyAt ?? 0;
    const hazard = seedChargeHazard(state, { x: 4, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 'aren');
    // Source gate accepts (Asha is within the guard-point reach), but the active tryGuardBlock must miss because she is not
    // standing on the protectee-to-attacker cone. Position Asha next to the protectee, command the guard, then move her aside.
    asha.position = { x: 0.5, y: 0, z: 0.4 };
    expect(commandCompanion(state, { companionId: 'asha', command: 'special', target: { kind: 'hazard', hazardId: hazard.id, protecteeId: 'aren' as ActorId } })).toBe(true);
    asha.position = { x: 0, y: 0, z: 0.6 };
    state.worldTick = hazard.activeFrom + 1;
    const aren = state.actors.find(candidate => candidate.id === 'aren')!;
    expect(tryGuardBlock(state, hazard, aren)).toBe(false);
    expect(hazard.hitIds).not.toContain('aren');
    expect(state.companionState.tokens.available).toBe(tokensBefore - 1);
    expect(state.companionState.slots.asha?.readyAt).toBeGreaterThan(readyBefore);
  });

  it('rejects a non-guardable hazard and a hazard past its activeFrom without spending tokens', () => {
    const state = makeEngine('asha');
    const asha = state.actors.find(candidate => candidate.id === 'asha')!;
    asha.position = { x: 0.5, y: 0, z: 0.4 };
    const tokensBefore = state.companionState.tokens.available;
    const readyBefore = state.companionState.slots.asha?.readyAt ?? 0;
    const modeBefore = state.companionState.slots.asha?.mode;
    const guardBefore = state.companionState.slots.asha?.guard;

    const nonGuardable = seedChargeHazard(state, { x: 0, y: 0, z: 4 }, { x: 0, y: 0, z: 0 }, 'aren', 8, 'asha-protective-roar' as never);
    expect(commandCompanion(state, { companionId: 'asha', command: 'special', target: { kind: 'hazard', hazardId: nonGuardable.id, protecteeId: 'aren' as ActorId } })).toBe(false);
    expect(state.companionState.tokens.available).toBe(tokensBefore);
    expect(state.companionState.slots.asha?.readyAt).toBe(readyBefore);
    expect(state.companionState.slots.asha?.mode).toBe(modeBefore);
    expect(state.companionState.slots.asha?.guard).toBe(guardBefore);

    const expired = seedChargeHazard(state, { x: 0, y: 0, z: 4 }, { x: 0, y: 0, z: 0 }, 'aren', 8, 'asha-bamboo-charge' as never);
    state.worldTick = expired.activeFrom;
    expect(commandCompanion(state, { companionId: 'asha', command: 'special', target: { kind: 'hazard', hazardId: expired.id, protecteeId: 'aren' as ActorId } })).toBe(false);
    expect(state.companionState.tokens.available).toBe(tokensBefore);
    expect(state.companionState.slots.asha?.readyAt).toBe(readyBefore);
    expect(state.companionState.slots.asha?.guard).toBe(guardBefore);
  });

  it('refuses an unearned Asha and lets an earned one guard without granting a narrative alliance', () => {
    const state = makeEngine('asha');
    const asha = state.actors.find(candidate => candidate.id === 'asha')!;
    asha.position = { x: 0.5, y: 0, z: 0.4 };
    const tokensBefore = state.companionState.tokens.available;
    const hazard = seedChargeHazard(state, { x: 0, y: 0, z: 4 }, { x: 0, y: 0, z: 0 }, 'aren');
    const request = { companionId: 'asha', command: 'special', target: { kind: 'hazard', hazardId: hazard.id, protecteeId: 'aren' } } as const;
    expect(commandAvailability(state, request).available).toBe(true);
    // An unearned companion is refused: the roster is authoritative, so no charge is blocked and no token is spent.
    state.companionState.progress = { asha: { id: 'asha', recruited: false, bondLevel: 0, dominionLevel: 0, unlockedAbilityIds: [], storyFlags: {} } };
    expect(commandAvailability(state, request).available).toBe(false);
    expect(commandCompanion(state, request)).toBe(false);
    expect(state.companionState.tokens.available).toBe(tokensBefore);
    expect(state.companionState.slots.asha?.guard?.hazardId).toBeUndefined();
    // The earned companion guards the charge, and the guard grants no narrative alliance of its own.
    state.companionState.progress = { asha: { id: 'asha', recruited: true, bondLevel: 10, dominionLevel: 0, unlockedAbilityIds: [], storyFlags: {} } };
    expect(commandCompanion(state, request)).toBe(true);
    expect(state.companionState.tokens.available).toBe(tokensBefore - 1);
    expect(state.companionState.progress.asha?.recruited).toBe(true);
    expect(state.companionState.slots.asha?.guard?.hazardId).toBe(hazard.id);
  });
});

describe('Vara aerial scout mark persists on the marked target', () => {
  it('records markState with the authored duration and exposes a live snapshot/landing for the marked target', () => {
    const state = makeEngine('vara');
    const vara = state.actors.find(candidate => candidate.id === 'vara')!;
    const hostile = state.actors.find(candidate => candidate.id === 'hostile')!;
    vara.position = { x: -1.5, y: 2, z: 1 };
    hostile.position = { x: 4, y: 0, z: 2 };
    expect(commandCompanion(state, { companionId: 'vara', command: 'focus', target: { kind: 'actor', instanceId: 'hostile' as ActorId } })).toBe(true);
    expect(state.companionState.tokens.available).toBe(2);
    expect(hostile.markState).toBeUndefined();
    advance(state, 24);
    expect(hostile.markState).toBeDefined();
    expect(hostile.markState?.sourceId).toBe('vara');
    expect(hostile.markState?.untilWorldTick).toBe(state.worldTick + 300);
    expect(hostile.markState?.extended).toBe(false);

    const snapshot = markSnapshot(state, hostile);
    expect(snapshot?.sourceId).toBe('vara');
    expect(snapshot?.remainingTicks).toBeGreaterThan(0);
    expect(snapshot?.remainingTicks).toBeLessThanOrEqual(300);
    expect(snapshot?.landing).toEqual({ x: 4, y: 0, z: 2 });

    const attacks = { id: 'hazard-vara', attackId: 'vara-test' as never, sourceId: hostile.id, startTick: state.worldTick, windupUntil: state.worldTick + 20, activeFrom: state.worldTick + 25, activeUntil: state.worldTick + 60, castUntil: state.worldTick + 60, recoveryUntil: state.worldTick + 90, target: { x: 1, y: 0, z: 1 }, origin: { x: 4, y: 0, z: 2 }, direction: { x: -1, y: 0, z: 0 }, range: 4, angleDeg: 70, hitIds: [], threatTicks: [state.worldTick + 24, state.worldTick + 28], cue: 'windup', targetActorId: 'aren', warningPresentationEmitted: false, kind: 'sweep', width: 2.4, depth: 4, radius: 0, heightAboveGround: 1.2, damage: 14, bounds: bounds, hitGroup: 'vara-test' } as never;
    state.hazards.push(attacks);
    const landing = markSnapshot(state, hostile)?.landing;
    expect(landing).toEqual({ x: 1, y: 0, z: 1 });

    expect(state.events.some(event => event.actorId === 'vara' && event.message === 'Mark Weakness')).toBe(true);
    expect(state.worldEvents.some(event => event.type === 'semantic-interaction' && event.actorId === 'vara' && event.interactionId === 'bird-mark')).toBe(true);
    expect(state.presentationCues.some(cue => cue.kind === 'mark' && cue.actorId === 'vara' && cue.targetId === 'hostile')).toBe(true);
  });

  it('extends the marked target stagger window by the authored mark extension while the mark is active', () => {
    const state = makeEngine('vara');
    const hostile = state.actors.find(candidate => candidate.id === 'hostile')!;
    hostile.position = { x: 4, y: 0, z: 2 };
    hostile.staggerUntil = state.worldTick + 50;
    expect(commandCompanion(state, { companionId: 'vara', command: 'focus', target: { kind: 'actor', instanceId: 'hostile' as ActorId } })).toBe(true);
    expect(hostile.staggerUntil).toBe(state.worldTick + 50);
    advance(state, 25);
    expect(hostile.staggerUntil).toBe(81);
    expect(hostile.markState?.extended).toBe(true);
    expect(state.events.some(event => event.actorId === 'vara' && event.message === 'Mark Counter')).toBe(true);
  });

  it('refuses an unearned Vara and lets an earned one mark without changing her story recruitment', () => {
    const state = makeEngine('vara');
    const tokensBefore = state.companionState.tokens.available;
    // An unearned companion cannot mark: the roster is authoritative.
    state.companionState.progress = { vara: { id: 'vara', recruited: false, bondLevel: 0, dominionLevel: 0, unlockedAbilityIds: [], storyFlags: {} } };
    expect(commandCompanion(state, { companionId: 'vara', command: 'focus', target: { kind: 'actor', instanceId: 'hostile' as ActorId } })).toBe(false);
    advance(state, 24);
    expect(state.companionState.tokens.available).toBe(tokensBefore);
    expect(state.actors.find(candidate => candidate.id === 'hostile')?.markState).toBeUndefined();
    // The earned companion marks the threat, and the mark grants no narrative recruitment of its own.
    state.companionState.progress = { vara: { id: 'vara', recruited: true, bondLevel: 10, dominionLevel: 0, unlockedAbilityIds: [], storyFlags: {} } };
    expect(commandCompanion(state, { companionId: 'vara', command: 'focus', target: { kind: 'actor', instanceId: 'hostile' as ActorId } })).toBe(true);
    advance(state, 24);
    expect(state.companionState.tokens.available).toBe(tokensBefore);
    expect(state.companionState.progress.vara?.recruited).toBe(true);
    expect(state.actors.find(candidate => candidate.id === 'hostile')?.markState).toBeDefined();
  });
});
