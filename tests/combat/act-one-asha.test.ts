import { describe, expect, it } from 'bun:test';
import { ASHA_SEQUENCE } from '../../src/game/combat/ActOneBossContent.js';
import type { CombatEngine } from '../../src/game/combat/CombatEngine.js';
import { vec } from '../../src/game/combat/geometry.js';
import { actorOf, bambooAshaBench, entity, idle, liveState, node, run, worldEvents } from './act-one-bench.js';

const REGION = 'blood-bamboo-valley';
const KORO_FACTS = { 'encounter-koro-cleansed': true };

function bench(runId: string, withKoro: boolean): CombatEngine {
  const engine = bambooAshaBench({
    runId, present: withKoro ? ['bamboo-koro'] : [], companionId: withKoro ? 'koro' : undefined,
    worldFacts: withKoro ? KORO_FACTS : undefined, playerAt: node(REGION, 'bamboo-den-terrace'),
  });
  const state = liveState(engine);
  state.player.vitality = state.player.maxVitality = 100_000;
  return engine;
}
/** Spends Asha's ferocity into the Cub phase and waits out the danger announcement. */
function enterDanger(engine: CombatEngine): void {
  const asha = liveState(engine).actors.find(actor => actor.id === 'asha')!;
  asha.ferocity = 30;
  run(engine, 3);
  expect(liveState(engine).chapter.sequence!.step).toBe('announce');
  run(engine, ASHA_SEQUENCE.announceTicks + 1);
  expect(liveState(engine).chapter.sequence!.step).toBe('danger');
}
function refill(engine: CombatEngine): void { liveState(engine).player.mana = liveState(engine).player.maxMana; }
function standBeside(engine: CombatEngine, id: string, offset = vec(0, 0, -1.6)): void {
  const state = liveState(engine), target = state.actors.find(actor => actor.id === id)!, player = state.actors.find(actor => actor.id === 'aren')!;
  player.position = vec(target.position.x + offset.x, target.position.y, target.position.z + offset.z);
  player.facing = vec(-offset.x, 0, -offset.z);
}
/** Cleanse until `cores` of Asha's three cores are eased, refilling mana like a long fight would. */
function cleanseCores(engine: CombatEngine, count: number): void {
  for (let eased = 0; eased < count; eased++) {
    while (liveState(engine).tick < liveState(engine).actionRecoveryUntil) engine.fixedStep(idle);
    refill(engine);
    standBeside(engine, 'asha');
    expect(engine.useAbility('cleanse', 'asha')).toBe(true);
    run(engine, 40);
  }
}
function releaseWithKoro(engine: CombatEngine): void {
  const koro = liveState(engine).actors.find(actor => actor.id === 'bamboo-koro')!;
  const bundle = entity(REGION, 'asha-shrine-bundle');
  koro.position = vec(bundle.x - 1.2, bundle.y, bundle.z);
  expect(engine.commandCompanion({ companionId: 'koro', command: 'special', target: { kind: 'interaction', interactionId: 'koro-bundle-drop', targetId: 'asha-shrine-bundle' } })).toBe(true);
  for (let tick = 0; tick < 200 && liveState(engine).chapter.sequence!.step === 'danger'; tick++) engine.fixedStep(idle);
}

describe('Asha: the three-phase causal sequence', () => {
  it('follows Ferocity through Stalking, Corruption Rage and the Cub, announcing the Tali danger only in the last', () => {
    const engine = bench('asha-phases', false);
    const asha = liveState(engine).actors.find(actor => actor.id === 'asha')!;
    asha.recoveringUntil = 1e9;
    asha.ferocity = 80;
    run(engine, 3);
    expect(engine.snapshot().boss?.phaseId).toBe('protective-instinct');
    expect(liveState(engine).chapter.sequence!.step).toBe('stalking');
    asha.ferocity = 60;
    run(engine, 3);
    expect(engine.snapshot().boss?.phaseId).toBe('mother-roar');
    expect(liveState(engine).chapter.sequence!.step).toBe('rage');
    expect(actorOf(engine, 'tali').chapterStatus).toBeUndefined();
    asha.ferocity = 30;
    run(engine, 3);
    expect(engine.snapshot().boss?.phaseId).toBe('reunion-opening');
    expect(liveState(engine).chapter.sequence!.step).toBe('announce');
    expect(actorOf(engine, 'tali').chapterStatus).toBe('in-danger');
    expect(worldEvents(engine, 'encounter-phase').filter(event => event.type === 'encounter-phase' && event.state === 'cleared').map(event => event.type === 'encounter-phase' ? event.phaseId : '')).toEqual(['protective-instinct', 'mother-roar']);
  });

  it('holds attacks during the announcement, then charges the shelter lane first with a swept, retimed Bamboo Charge', () => {
    const engine = bench('asha-charge-order', false);
    const state = liveState(engine);
    state.actors.find(actor => actor.id === 'asha')!.ferocity = 30;
    run(engine, 3);
    run(engine, ASHA_SEQUENCE.announceTicks - 5);
    expect(engine.snapshot().telegraphs.filter(telegraph => telegraph.sourceId === 'asha')).toHaveLength(0);
    run(engine, 10);
    const first = engine.snapshot().telegraphs.find(telegraph => telegraph.sourceId === 'asha')!;
    expect(first.attackId).toBe('asha-bamboo-charge');
    const hazard = state.hazards.find(candidate => candidate.id === first.id)!;
    const shelter = node(REGION, 'bamboo-tali-shelter');
    const lane = Math.atan2(hazard.direction.x, hazard.direction.z), toShelter = Math.atan2(shelter.x - hazard.origin.x, shelter.z - hazard.origin.z);
    expect(Math.abs(lane - toShelter)).toBeLessThan(0.01);
    expect(hazard.activeFrom - hazard.startTick).toBe(37);
    expect(hazard.castUntil! - hazard.startTick).toBe(79);
    expect(hazard.recoveryUntil! - hazard.startTick).toBe(93);
    const before = actorOf(engine, 'asha').position;
    const plannedTravel = state.bossLunges.find(lunge => lunge.hazardId === hazard.id)!.travel;
    expect(plannedTravel).toBeGreaterThan(2);
    run(engine, 90);
    const after = actorOf(engine, 'asha').position;
    expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeGreaterThan(plannedTravel - 0.25);
  });

  it('completes with Koro: bundle drop, stun, tether, three cleanses, Tali safe and a nonlethal reunion', () => {
    const engine = bench('asha-koro-path', true);
    enterDanger(engine);
    expect(actorOf(engine, 'tali').chapterStatus).toBe('in-danger');
    releaseWithKoro(engine);
    expect(liveState(engine).chapter.sequence!.step).toBe('exposed');
    expect(actorOf(engine, 'tali').chapterStatus).toBe('sheltered');
    expect(actorOf(engine, 'asha').chapterStatus).toBe('thorn-exposed');
    expect(engine.snapshot().boss?.exposed).toBe(true);
    expect(engine.snapshot().hazards.filter(hazard => hazard.active)).toHaveLength(0);

    refill(engine);
    standBeside(engine, 'asha');
    expect(engine.useAbility('root-tether', 'asha')).toBe(true);
    run(engine, 40);
    expect(liveState(engine).chapter.sequence!.step).toBe('tethered');
    expect(actorOf(engine, 'asha').chapterStatus).toBe('tethered');

    cleanseCores(engine, 3);
    run(engine, 30);
    const resolved = worldEvents(engine, 'encounter-resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ encounterId: 'encounter-asha', resolution: 'cleansed' });
    expect(worldEvents(engine, 'rescue')).toMatchObject([{ targetId: 'tali', locationId: 'tali-shelter', safe: true }]);
    expect(worldEvents(engine, 'restoration')).toHaveLength(0);
    expect(actorOf(engine, 'asha')).toMatchObject({ allegiance: 'ally', chapterStatus: 'reunion', downed: false });
    expect(actorOf(engine, 'tali').chapterStatus).toBe('reunion');
    expect(engine.snapshot().hazards).toHaveLength(0);
    expect(engine.snapshot().actors.find(actor => actor.id === 'asha')!.vitality).toBeGreaterThan(0);
  }, 30_000);

  it('completes the same sequence player-only through the manual bundle release (no Koro in the party)', () => {
    const engine = bench('asha-manual-path', false);
    enterDanger(engine);
    const bundle = entity(REGION, 'asha-shrine-bundle');
    liveState(engine).actors.find(actor => actor.id === 'aren')!.position = vec(bundle.x, bundle.y, bundle.z - 1.5);
    liveState(engine).actors.find(actor => actor.id === 'aren')!.facing = vec(0, 0, 1);
    engine.fixedStep({ ...idle, heavyPressed: true, interactionId: 'player-bundle-release', interactionTargetId: 'asha-shrine-bundle' });
    for (let tick = 0; tick < 200 && liveState(engine).chapter.sequence!.step === 'danger'; tick++) engine.fixedStep(idle);
    expect(liveState(engine).chapter.sequence!.step).toBe('exposed');
    while (liveState(engine).tick < liveState(engine).actionRecoveryUntil) engine.fixedStep(idle);
    refill(engine);
    standBeside(engine, 'asha');
    expect(engine.useAbility('root-tether', 'asha')).toBe(true);
    run(engine, 40);
    cleanseCores(engine, 3);
    run(engine, 30);
    expect(worldEvents(engine, 'encounter-resolved')).toHaveLength(1);
    expect(worldEvents(engine, 'object-moved')).toMatchObject([{ objectId: 'asha-shrine-bundle' }]);
  }, 30_000);

  it('cannot release the bundle, tether or cleanse out of sequence', () => {
    const engine = bench('asha-order', true);
    const koro = liveState(engine).actors.find(actor => actor.id === 'bamboo-koro')!;
    const bundle = entity(REGION, 'asha-shrine-bundle');
    koro.position = vec(bundle.x - 1.2, bundle.y, bundle.z);
    const request = { companionId: 'koro', command: 'special', target: { kind: 'interaction', interactionId: 'koro-bundle-drop', targetId: 'asha-shrine-bundle' } } as const;
    expect(engine.commandAvailability(request)).toMatchObject({ available: false, reason: 'Nothing to release yet' });
    expect(engine.commandCompanion(request)).toBe(false);
    expect(liveState(engine).companionState.tokens.available).toBe(2);
    standBeside(engine, 'asha');
    expect(engine.useAbility('cleanse', 'asha')).toBe(false);
    enterDanger(engine);
    standBeside(engine, 'asha');
    refill(engine);
    // Nothing has exposed her yet: neither a sealed cleanse nor a sequence tether without a live attack is accepted.
    const sequence = liveState(engine).chapter.sequence!;
    expect(sequence.step).toBe('danger');
    expect(engine.useAbility('cleanse', 'asha')).toBe(false);
    expect(liveState(engine).worldEvents.filter(event => event.type === 'encounter-resolved')).toHaveLength(0);
  });

  it('loses Tali after two landed shelter charges: a typed failed rescue, cleared hazards, held attacks, then a safe retry', () => {
    const engine = bench('asha-tali-failure', false);
    enterDanger(engine);
    // Stay out of the way and let the charges run.
    liveState(engine).actors.find(actor => actor.id === 'aren')!.position = node(REGION, 'bamboo-den-ramp');
    for (let tick = 0; tick < 900 && liveState(engine).chapter.sequence!.step === 'danger'; tick++) engine.fixedStep(idle);
    expect(liveState(engine).chapter.sequence!.step).toBe('failed');
    expect(worldEvents(engine, 'rescue')).toMatchObject([{ targetId: 'tali', locationId: 'tali-shelter', safe: false }]);
    expect(engine.snapshot().hazards).toHaveLength(0);
    expect(liveState(engine).events.some(event => event.message === 'tali-danger-failed')).toBe(true);
    run(engine, 200);
    expect(engine.snapshot().telegraphs.filter(telegraph => telegraph.sourceId === 'asha')).toHaveLength(0);
    expect(worldEvents(engine, 'rescue')).toHaveLength(1);

    engine.resetToCheckpoint();
    const retry = liveState(engine);
    expect(retry.chapter.sequence!.step).toBe('stalking');
    expect(retry.movableObjects.find(object => object.objectId === 'asha-shrine-bundle')!.phase).toBe('resting');
    expect(retry.actors.find(actor => actor.id === 'asha')!.ferocity).toBe(100);
    expect(retry.player.vitality).toBe(retry.checkpoint!.player.vitality);
  });

  it('retries the bundle: an exposure that runs out hands the lane back and rests the bundle again', () => {
    const engine = bench('asha-retry-bundle', true);
    enterDanger(engine);
    releaseWithKoro(engine);
    expect(liveState(engine).movableObjects.find(object => object.objectId === 'asha-shrine-bundle')!.phase).toBe('settled');
    run(engine, ASHA_SEQUENCE.exposureTicks + 5);
    expect(liveState(engine).chapter.sequence!.step).toBe('danger');
    expect(liveState(engine).movableObjects.find(object => object.objectId === 'asha-shrine-bundle')!.phase).toBe('resting');
    expect(actorOf(engine, 'tali').chapterStatus).toBe('in-danger');
    liveState(engine).actors.find(actor => actor.id === 'bamboo-koro')!.position = vec(entity(REGION, 'asha-shrine-bundle').x - 1.2, 2, entity(REGION, 'asha-shrine-bundle').z);
    liveState(engine).companionState.tokens.available = 2;
    liveState(engine).companionState.slots.koro!.readyAt = 0;
    releaseWithKoro(engine);
    expect(liveState(engine).chapter.sequence!.step).toBe('exposed');
  }, 30_000);

  it('never joins the party merely because the fight was loaded', () => {
    const engine = bench('asha-not-party', false);
    expect(liveState(engine).companionState.companionId).toBeUndefined();
    expect(actorOf(engine, 'asha').allegiance).toBe('hostile');
    expect(() => bambooAshaBench({ runId: 'asha-in-party', companionId: 'asha' })).toThrow();
  });
});
