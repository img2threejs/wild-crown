import { describe, expect, it } from 'bun:test';
import { CombatEngine, createEngineState, makeActor, type CombatInput, type LiveHazard } from '../../src/game/combat/CombatEngine.js';
import { ATTACKS } from '../../src/game/combat/content.js';
import { vec } from '../../src/game/combat/geometry.js';

const idle: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
const runRight: CombatInput = { ...idle, move: vec(1, 0, 0), sprintHeld: true };

type DamagePayload = { targetId: string; amount: number; position: { x: number; y: number; z: number }; worldTick: number };
type AnyEvent = { kind: string; actorId?: string; targetId?: string; damage?: DamagePayload };

function damagePayloads(events: readonly AnyEvent[]): DamagePayload[] {
  return events.filter(event => event.kind === 'damage' && event.damage !== undefined).map(event => event.damage!);
}

function damageEventByTarget(events: readonly AnyEvent[], targetId: string): AnyEvent | undefined {
  return events.find(event => event.kind === 'damage' && event.damage?.targetId === targetId);
}

function until(engine: CombatEngine, worldTick: number, input: CombatInput = idle): void {
  while (engine.snapshotState().worldTick < worldTick) engine.fixedStep(input);
}

function encounterWithHostileClose(): CombatEngine {
  const engine = new CombatEngine();
  engine.startEncounter({
    encounterId: 'greenwake-boar', regionId: 'greenwake', runId: 'damage-events',
    actors: [
      makeActor('aren', 'human', 'player', vec(0, 0, 0), false, false, 1000),
      makeActor('corrupted-boar', 'boar', 'hostile', vec(0, 0, -5), true, false, 1000),
    ],
  });
  const state = engine.snapshotState();
  state.arena = createEngineState().arena;
  state.arena.bounds = { min: vec(-12, -1, -12), max: vec(12, 12, 12) };
  state.player.vitality = state.player.maxVitality = 1000;
  state.wildlifeCombat = { engagedTicks: 0, sourceCursor: 0, attackCursors: {} };
  state.encounter!.phases = [{ id: 'damage-payload', attackIds: ['boar-ember-lance'] }];
  state.events = []; state.presentationCues = [];
  return new CombatEngine(state);
}

function playerVitality(engine: CombatEngine): number { return engine.snapshot().player.vitality; }
function playerWorldTick(engine: CombatEngine): number { return engine.snapshotState().worldTick; }
function playerPosition(engine: CombatEngine): { x: number; y: number; z: number } {
  const actor = engine.snapshotState().actors.find(candidate => candidate.id === 'aren')!;
  return { x: actor.position.x, y: actor.position.y, z: actor.position.z };
}

describe('CombatEvent damage payload — hazard damage to Aren', () => {
  it('attaches a payload for an ordinary hostile impact on Aren at the pre-push victim position with the exact world tick', () => {
    const engine = encounterWithHostileClose();
    engine.fixedStep(idle);
    const hazard = engine.snapshotState().hazards[0]!;
    const attack = ATTACKS[hazard.attackId]!;
    const prePushPlayer = playerPosition(engine);
    until(engine, hazard.activeFrom - 1);
    engine.drainPresentationCues();
    engine.consumeEvents();
    const vitalityBefore = playerVitality(engine);
    engine.fixedStep(idle);
    const events = engine.consumeEvents();
    const damages = damagePayloads(events);
    expect(damages).toHaveLength(1);
    expect(damages[0]).toEqual({
      targetId: 'aren',
      amount: vitalityBefore - playerVitality(engine),
      position: prePushPlayer,
      worldTick: playerWorldTick(engine),
    });
    expect(damages[0]!.amount).toBe(attack.hazard.damage);
  });

  it('caps overkill at the remaining vitality, including a lethal hit, and still emits a payload', () => {
    const seed = encounterWithHostileClose().snapshotState();
    seed.player.vitality = 5;
    seed.player.maxVitality = 5;
    const primed = new CombatEngine(seed);
    primed.fixedStep(idle);
    const hazard = primed.snapshotState().hazards[0]!;
    until(primed, hazard.activeFrom - 1);
    primed.drainPresentationCues();
    primed.consumeEvents();
    const vitalityBefore = playerVitality(primed);
    primed.fixedStep(idle);
    const events = primed.consumeEvents();
    const damages = damagePayloads(events);
    expect(damages).toHaveLength(1);
    expect(damages[0]!.targetId).toBe('aren');
    expect(damages[0]!.amount).toBe(vitalityBefore);
    expect(playerVitality(primed)).toBe(0);
  });

  it('ticks poison at every hazard interval with a fresh payload whose amount matches the actual vitality loss', () => {
    const seed = encounterWithHostileClose().snapshotState();
    seed.encounter!.phases = [{ id: 'damage-payload', attackIds: ['sap-stalker-venom-mist'] }];
    const sapStalker = makeActor('greenwake-sap-stalker', 'boar', 'hostile', vec(-5, 0, 0), true, false, 1000, 'corrupted-boar');
    seed.actors = [seed.actors.find(actor => actor.id === 'aren')!, sapStalker];
    const primed = new CombatEngine(seed);
    primed.fixedStep(idle);
    const hazard = primed.snapshotState().hazards[0]!;
    const attack = ATTACKS[hazard.attackId]!;
    const interval = attack.hitIntervalTicks ?? 0;
    expect(interval).toBeGreaterThan(0);
    // Let the AI cast one authentic cloud, then freeze the AI so no recasts/overlapping clouds pollute the run.
    until(primed, hazard.activeFrom - 1);
    primed.drainPresentationCues();
    primed.consumeEvents();
    const frozenSeed = primed.snapshotState();
    frozenSeed.encounter = null;
    const frozen = new CombatEngine(frozenSeed);
    const samples: { amount: number; loss: number; worldTick: number }[] = [];
    let lastVitality = playerVitality(frozen);
    for (let i = 0; i < 1000 && frozen.snapshotState().worldTick < hazard.activeUntil; i++) {
      frozen.fixedStep(idle);
      const vitalityNow = playerVitality(frozen);
      const damages = damagePayloads(frozen.consumeEvents());
      for (const damage of damages) {
        samples.push({ amount: damage.amount, loss: lastVitality - vitalityNow, worldTick: damage.worldTick });
      }
      lastVitality = vitalityNow;
    }
    expect(samples.length).toBeGreaterThanOrEqual(2);
    for (const sample of samples) {
      expect(sample.amount).toBe(sample.loss);
      expect(sample.amount).toBeGreaterThan(0);
    }
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!.worldTick - samples[i - 1]!.worldTick).toBe(interval);
    }
  });

  it('omits a damage payload when the hostile hazard is dodged clear of the lane', () => {
    const seed = encounterWithHostileClose().snapshotState();
    seed.arena.bounds = { min: vec(-40, -1, -40), max: vec(40, 12, 40) };
    const primed = new CombatEngine(seed);
    primed.fixedStep(idle);
    const hazard = primed.snapshotState().hazards[0]!;
    until(primed, hazard.activeUntil, runRight);
    expect(playerVitality(primed)).toBe(1000);
    expect(damagePayloads(primed.consumeEvents())).toEqual([]);
  });

  it('omits a damage payload on a non-damaging authored attack (zero hazard damage)', () => {
    const attack = ATTACKS['boar-ember-lance']!;
    const state = createEngineState();
    state.arena.bounds = { min: vec(-20, -2, -20), max: vec(20, 20, 20) };
    state.actors = [state.actors[0]!, makeActor('corrupted-boar', 'boar', 'hostile', vec(0, 0, -5), true, false, 1000)];
    state.player.vitality = state.player.maxVitality = 1000;
    const zeroHazard: LiveHazard = { ...structuredClone(attack.hazard), id: 'zero-damage-hazard', attackId: attack.id, sourceId: 'corrupted-boar', startTick: 0, activeFrom: 2, activeUntil: 6, target: vec(0, 0, 0), origin: vec(0, 0, -5), direction: vec(0, 0, 1), hitIds: [], threatTicks: [2], cue: attack.cue, damage: 0, bounds: { min: vec(-2, -1, -2), max: vec(2, 3, 2) } };
    state.hazards = [zeroHazard];
    const engine = new CombatEngine(state);
    engine.fixedStep(idle);
    until(engine, 6);
    expect(playerVitality(engine)).toBe(1000);
    expect(damagePayloads(engine.consumeEvents())).toEqual([]);
  });
});

describe('CombatEvent damage payload — Aren impact on hostile', () => {
  function hostileInRange(): CombatEngine {
    const state = createEngineState();
    state.arena.bounds = { min: vec(-20, -2, -20), max: vec(20, 20, 20) };
    state.actors = [state.actors[0]!, makeActor('corrupted-boar', 'boar', 'hostile', vec(0, 0, -1.6), true, false, 100)];
    state.player.vitality = state.player.maxVitality = 1000;
    state.targetId = 'corrupted-boar';
    // Disable encounter AI so no koro retaliation / extra hazards run during the test.
    return new CombatEngine(state);
  }

  it('attaches a payload to the player→hostile damage event with the impact position and authoritative world tick', () => {
    const engine = hostileInRange();
    const target = engine.snapshotState().actors.find(actor => actor.id === 'corrupted-boar')!;
    const impactPosition = { x: target.position.x, y: target.position.y, z: target.position.z };
    const vitalityBefore = target.vitality;
    engine.fixedStep({ ...idle, lightPressed: true });
    for (let t = 0; t < 12; t++) engine.fixedStep(idle);
    const events = engine.consumeEvents();
    const event = damageEventByTarget(events, 'corrupted-boar');
    expect(event).toBeDefined();
    expect(event!.damage).toBeDefined();
    expect(event!.damage!.targetId).toBe('corrupted-boar');
    expect(event!.damage!.amount).toBe(vitalityBefore - engine.snapshotState().actors.find(actor => actor.id === 'corrupted-boar')!.vitality);
    expect(event!.damage!.position).toEqual(impactPosition);
    expect(event!.damage!.worldTick).toBe(playerWorldTick(engine));
    expect(event!.actorId).toBe('aren');
  });

  it('amplifies the payload amount by the weak-point multiplier on an uncapped target', () => {
    const seed = hostileInRange().snapshotState();
    const boar = seed.actors.find(actor => actor.id === 'corrupted-boar')!;
    boar.vitality = 1000;
    boar.maxVitality = 1000;
    boar.weakPointUntil = seed.worldTick + 200;
    const primed = new CombatEngine(seed);
    const vitalityBefore = boar.vitality;
    primed.fixedStep({ ...idle, lightPressed: true });
    for (let t = 0; t < 12; t++) primed.fixedStep(idle);
    const events = primed.consumeEvents();
    const event = damageEventByTarget(events, 'corrupted-boar');
    expect(event).toBeDefined();
    expect(event!.damage).toBeDefined();
    expect(event!.damage!.targetId).toBe('corrupted-boar');
    // light_1 base 9, weakPoint multiplier 1.5 → ceil(13.5) = 14 actual positive loss.
    expect(event!.damage!.amount).toBe(14);
    expect(vitalityBefore - primed.snapshotState().actors.find(actor => actor.id === 'corrupted-boar')!.vitality).toBe(14);
  });

  it('clamps the weak-point payload at the remaining vitality and still emits a payload', () => {
    const seed = hostileInRange().snapshotState();
    const boar = seed.actors.find(actor => actor.id === 'corrupted-boar')!;
    boar.vitality = 5;
    boar.maxVitality = 1000;
    boar.weakPointUntil = seed.worldTick + 200;
    const primed = new CombatEngine(seed);
    const vitalityBefore = boar.vitality;
    primed.fixedStep({ ...idle, lightPressed: true });
    for (let t = 0; t < 12; t++) primed.fixedStep(idle);
    const events = primed.consumeEvents();
    const event = damageEventByTarget(events, 'corrupted-boar');
    expect(event).toBeDefined();
    expect(event!.damage).toBeDefined();
    expect(event!.damage!.targetId).toBe('corrupted-boar');
    expect(event!.damage!.amount).toBe(vitalityBefore);
    expect(primed.snapshotState().actors.find(actor => actor.id === 'corrupted-boar')!.vitality).toBe(0);
  });

  it('emits no payload on a player action that resolves against no target', () => {
    const state = createEngineState();
    state.arena.bounds = { min: vec(-20, -2, -20), max: vec(20, 20, 20) };
    state.actors = [state.actors[0]!];
    state.player.vitality = state.player.maxVitality = 1000;
    state.events = []; state.presentationCues = [];
    const engine = new CombatEngine(state);
    engine.fixedStep({ ...idle, lightPressed: true });
    for (let t = 0; t < 30; t++) engine.fixedStep(idle);
    expect(damagePayloads(engine.consumeEvents())).toEqual([]);
  });
});
