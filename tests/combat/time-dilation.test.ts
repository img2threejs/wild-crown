import { describe, expect, it } from 'bun:test';
import * as THREE from 'three';
import { StoryEffects } from '../../src/effects/StoryEffects.js';
import { ATTACKS } from '../../src/game/combat/content.js';
import { CombatEngine, createEngineState, makeActor, type CombatInput, type EngineState, type EngineStateSeed, type LiveHazard } from '../../src/game/combat/CombatEngine.js';
import type { RegionRouteDefinition } from '../../src/game/contracts.js';
import { createCompanionState } from '../../src/game/companions/CompanionSystem.js';
import { vec, type CombatArena } from '../../src/game/combat/geometry.js';
import { REGIONS } from '../../src/content/campaign.js';

const idle: CombatInput = {
  tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false,
  heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false,
};

const floor: CombatArena = {
  bounds: { min: vec(-10, -2, -10), max: vec(10, 8, 10) }, groundY: 0,
  surfaces: [{
    id: 'test-floor', profile: 'plane', points: [vec(-10, 0, -10), vec(10, 0, -10), vec(10, 0, 10), vec(-10, 0, 10)],
    elevation: 0, walkable: true, material: 'stone', colliderId: 'test-floor-collider',
  }],
  colliders: [], routes: [], obstacles: [],
};

function makeClockState(duplicateHazard = false): EngineState {
  const state = createEngineState();
  const playerPosition = vec(0, 0, 0);
  const enemy = makeActor('hunter-melee-west', 'human', 'hostile', vec(0, 0, -1.2), false, false, 100, 'poacher-hunter');
  const player = makeActor('aren', 'human', 'player', playerPosition, false, false, 100);
  const attack = ATTACKS['poacher-hunter-spear']!;
  const hazard: LiveHazard = {
    ...structuredClone(attack.hazard),
    id: 'spear-volume-a', attackId: 'poacher-hunter-spear', sourceId: enemy.id,
    startTick: 0, activeFrom: 2, activeUntil: 120, target: playerPosition, origin: enemy.position,
    direction: vec(0, 0, 1), width: 0.1, depth: 0.4, damage: 0,
    hitIds: [], threatTicks: [2], cue: 'Test spear sweep', targetActorId: player.id,
  };

  state.runId = 'time-dilation-test';
  state.regionId = REGIONS.find(region => region.id === 'blood-bamboo-valley')!.id;
  state.encounterId = 'time-dilation-test';
  state.encounter = null;
  state.playerId = player.id;
  state.targetId = enemy.id;
  state.actors = [player, enemy];
  state.arena = floor;
  state.hazards = [hazard, ...(duplicateHazard ? [{ ...structuredClone(hazard), id: 'spear-volume-b' }] : [])];
  state.companionSlots = { combat: 'asha' };
  state.companionState = createCompanionState({ combat: 'asha' });
  state.companionState.slots.asha!.readyAt = 50;
  state.player.instinct = 0;
  return state;
}

function startClockEngine(duplicateHazard = false): CombatEngine {
  return new CombatEngine(makeClockState(duplicateHazard));
}

describe('Perfect Dodge world-clock time dilation', () => {
  for (const worldScale of [1, 0.25]) {
    it(`advances Aren by simulation ticks and every other actor by world scale ${worldScale}`, () => {
      const state = makeClockState();
      state.tick = 20;
      state.worldTick = 10;
      state.hazards = [];
      state.timePolicy = worldScale === 1 ? 'normal' : 'perfect-dodge-slow';
      state.worldTimeScale = worldScale;
      state.slowMotionRemainingTicks = worldScale === 1 ? 0 : 8;
      state.actors.push(
        makeActor('clock-ally', 'human', 'ally', vec(4, 0, 0), false, false, 100),
        makeActor('clock-neutral', 'human', 'neutral', vec(5, 0, 0), false, false, 100),
        makeActor('clock-wild', 'human', 'wild', vec(6, 0, 0), false, false, 100),
      );
      for (const actor of state.actors) {
        actor.phase = 'active';
        actor.actionStartedTick = actor.id === state.playerId ? 12 : 2;
        actor.actionEndsTick = actor.actionStartedTick + 40;
        actor.normalizedTime = 0.2;
      }
      const engine = new CombatEngine(state);
      for (let step = 0; step < 4; step++) engine.fixedStep(idle);
      const advanced = engine.snapshotState();
      expect(advanced.tick).toBe(24);
      expect(advanced.worldTick).toBe(10 + 4 * worldScale);
      for (const actor of advanced.actors) {
        const player = actor.id === advanced.playerId;
        expect(actor.normalizedTime).toBeCloseTo(0.2 + 4 * (player ? 1 : worldScale) / 40);
        expect(actor.actionStartedTick).toBe(player ? 12 : 2);
        expect(actor.actionEndsTick).toBe(player ? 52 : 42);
      }
    });
  }

  it('starts a finite player action during slow motion on simulation time and completes on its exact deadline', () => {
    const state = makeClockState();
    state.tick = 60;
    state.worldTick = 45.25;
    state.hazards = [];
    state.timePolicy = 'perfect-dodge-slow';
    state.worldTimeScale = 0.25;
    state.slowMotionRemainingTicks = 12;
    const engine = new CombatEngine(state);
    engine.fixedStep({ ...idle, heavyPressed: true });
    const started = engine.snapshotState();
    expect(started.tick).toBe(61);
    expect(started.worldTick).toBe(45.5);
    expect(started.actors.find(actor => actor.id === started.playerId)).toMatchObject({
      actionId: 'aren-heavy', actionStartedTick: 61, actionEndsTick: 124, normalizedTime: 0,
    });
    engine.fixedStep(idle);
    expect(engine.snapshotState().actors.find(actor => actor.id === started.playerId)?.normalizedTime).toBeCloseTo(1 / 63);
    const restored = new CombatEngine();
    restored.restore(engine.serialize());
    expect(restored.snapshotState().actors).toEqual(engine.snapshotState().actors);
    for (let step = 0; step < 61; step++) restored.fixedStep(idle);
    expect(restored.snapshotState().tick).toBe(123);
    expect(restored.snapshotState().actors.find(actor => actor.id === started.playerId)).toMatchObject({
      actionId: 'aren-heavy', actionStartedTick: 61, actionEndsTick: 124,
    });
    expect(restored.snapshotState().actors.find(actor => actor.id === started.playerId)?.normalizedTime).toBeCloseTo(62 / 63);
    restored.fixedStep(idle);
    expect(restored.snapshotState().tick).toBe(124);
    expect(restored.snapshotState().actionId).toBe('idle');
    expect(restored.snapshotState().actors.find(actor => actor.id === started.playerId)).toMatchObject({
      actionId: 'aren-idle', actionStartedTick: 124, actionEndsTick: 0, normalizedTime: 0, phase: 'idle',
    });
  });

  it('completes a finite Aren sample while a same-duration world actor remains slowed', () => {
    const state = makeClockState();
    state.tick = 20;
    state.worldTick = 10;
    state.hazards = [];
    state.timePolicy = 'perfect-dodge-slow';
    state.worldTimeScale = 0.25;
    state.slowMotionRemainingTicks = 8;
    for (const actor of state.actors) {
      actor.phase = 'active';
      actor.actionStartedTick = actor.id === state.playerId ? 18 : 8;
      actor.actionEndsTick = actor.actionStartedTick + 4;
      actor.normalizedTime = 0.5;
    }
    const engine = new CombatEngine(state);
    engine.fixedStep(idle);
    expect(engine.snapshotState().actors.find(actor => actor.id === state.playerId)?.normalizedTime).toBe(0.75);
    engine.fixedStep(idle);
    const completed = engine.snapshotState();
    expect(completed.actors.find(actor => actor.id === state.playerId)).toMatchObject({
      actionId: 'aren-idle', actionStartedTick: 22, actionEndsTick: 0, normalizedTime: 0, phase: 'idle',
    });
    expect(completed.actors.find(actor => actor.id !== state.playerId)).toMatchObject({
      actionStartedTick: 8, actionEndsTick: 12, normalizedTime: 0.625, phase: 'active',
    });
  });

  it('keeps contextual traversal movement and sampling on world time during slow motion', () => {
    const state = makeClockState();
    state.tick = 60;
    state.worldTick = 45.25;
    state.hazards = [];
    state.timePolicy = 'perfect-dodge-slow';
    state.worldTimeScale = 0.25;
    state.slowMotionRemainingTicks = 12;
    const route: RegionRouteDefinition = {
      id: 'clock-vault', from: vec(0, 0, 0), to: vec(4, 0, 0), anchors: [],
      destinationRegionId: state.regionId, kind: 'path', traversalActionId: 'aren-staff-vault',
      traversal: { kind: 'vault', durationTicks: 4, startRadius: 1 }, colliderIds: [], traversalEvent: 'clock-vaulted',
    };
    const engine = new CombatEngine(state);
    engine.setTraversalGates([route]);
    engine.fixedStep({ ...idle, interactPressed: true, traversalId: route.id });
    expect(engine.isTraversing).toBe(true);
    expect(engine.snapshotState().actors.find(actor => actor.id === state.playerId)).toMatchObject({
      actionStartedTick: 45.5, actionEndsTick: 0, normalizedTime: 0,
    });
    for (let step = 0; step < 4; step++) engine.fixedStep(idle);
    expect(engine.snapshotState()).toMatchObject({ tick: 65, worldTick: 46.5 });
    expect(engine.snapshotState().actors.find(actor => actor.id === state.playerId)).toMatchObject({
      actionStartedTick: 45.5, actionEndsTick: 0, normalizedTime: 0.25, position: vec(1, 0, 0),
    });
    expect(engine.isTraversing).toBe(true);
    expect(engine.consumeEvents().filter(event => event.kind === 'traversal')).toHaveLength(0);
  });

  it('slows hazards and hostile animation while Aren sampling and simulation input remain live', () => {
    const normal = startClockEngine();
    normal.fixedStep(idle);
    normal.fixedStep(idle);
    expect(normal.snapshot().hazards[0]?.active).toBe(true);

    const slowState = makeClockState();
    const enemy = slowState.actors.find(actor => actor.id === 'hunter-melee-west')!;
    enemy.phase = 'active';
    enemy.actionStartedTick = 0;
    enemy.actionEndsTick = 100;
    const engine = new CombatEngine(slowState);
    engine.fixedStep({ ...idle, dodgePressed: true, dodgeDirection: 'left' });
    const afterDodge = engine.snapshotState();
    expect(engine.snapshot().worldClock).toMatchObject({ simulationTick: 1, worldTick: 1, timeScale: 0.25, policy: 'perfect-dodge-slow' });
    expect(afterDodge.player.instinct).toBe(20);
    const cue = engine.queuePresentationCue({ kind: 'perfect-dodge', phase: 'hit', position: vec(0, 0, 0), durationTicks: 12, priority: 'essential' });
    expect(cue.tick).toBe(afterDodge.tick);
    expect(cue.worldTimeSeconds).toBe(engine.snapshot().worldClock.worldTimeSeconds);
    expect(afterDodge.actionRecoveryUntil - afterDodge.actionUntil).toBe(6);
    expect(afterDodge.companionState.slots.asha?.readyAt).toBe(32);
    const enemyAfterDodge = afterDodge.actors.find(actor => actor.id === 'hunter-melee-west')!;
    expect(enemyAfterDodge.normalizedTime).toBeCloseTo(1 / 100);
    expect(engine.snapshot().actors.find(actor => actor.id === 'hunter-melee-west')).toMatchObject({ weakPointExposed: true });
    const restored = new CombatEngine();
    restored.restore(engine.serialize());
    expect(restored.snapshot().worldClock).toEqual(engine.snapshot().worldClock);

    engine.fixedStep(idle);
    const slowed = engine.snapshotState();
    const player = slowed.actors.find(actor => actor.id === 'aren')!;
    const enemyDuringSlowMotion = slowed.actors.find(actor => actor.id === 'hunter-melee-west')!;
    expect(player.actionStartedTick).toBe(slowed.tick - 1);
    expect(player.normalizedTime).toBeCloseTo(1 / (player.actionEndsTick - player.actionStartedTick));
    expect(enemyDuringSlowMotion.normalizedTime - enemyAfterDodge.normalizedTime).toBeCloseTo(0.25 / 100);

    engine.fixedStep({ ...idle, lightPressed: true });
    const counterAction = engine.snapshotState();
    const playerAction = counterAction.actors.find(actor => actor.id === 'aren')!;
    expect(counterAction.actionId).toBe('light_1');
    expect(counterAction.pendingImpact?.counter).toBe(true);
    expect(playerAction.actionId).toBe('aren-light-1');
    expect(playerAction.actionStartedTick).toBe(counterAction.tick);
    expect(playerAction.actionEndsTick).toBe(counterAction.actionRecoveryUntil);
    for (let step = 0; step < 12; step++) engine.fixedStep(idle);
    expect(engine.snapshotState().actors.find(actor => actor.id === 'hunter-melee-west')?.vitality).toBe(88);
    const recoveryUntil = engine.snapshotState().actionRecoveryUntil;
    while (engine.snapshotState().tick <= recoveryUntil) engine.fixedStep(idle);
    const recovered = engine.snapshotState();
    const actorAfterRecovery = recovered.actors.find(actor => actor.id === 'aren')!;
    expect(recovered.tick).toBe(recoveryUntil + 1);
    expect(actorAfterRecovery.actionId).toBe('aren-idle');
    expect(actorAfterRecovery.normalizedTime).toBe(0);
    expect(actorAfterRecovery.actionEndsTick).toBe(0);
  });
  it('keeps ordinary dodges at normal time when the threat is outside the perfect window', () => {
    const state = makeClockState();
    state.hazards[0]!.activeFrom = 50;
    state.hazards[0]!.activeUntil = 60;
    state.hazards[0]!.threatTicks = [50];
    const engine = new CombatEngine(state);
    engine.fixedStep({ ...idle, dodgePressed: true, dodgeDirection: 'left' });
    expect(engine.snapshot().worldClock).toMatchObject({ worldTick: 1, timeScale: 1, policy: 'normal' });
    expect(engine.snapshotState().player.instinct).toBe(0);
    expect(engine.consumeEvents().filter(event => event.kind === 'perfect-dodge')).toHaveLength(0);
  });


  it('grants one Perfect Dodge reward for duplicate volumes in the same attack hit group', () => {
    const engine = startClockEngine(true);
    engine.fixedStep({ ...idle, dodgePressed: true, dodgeDirection: 'left' });
    expect(engine.snapshotState().player.instinct).toBe(20);
    expect(engine.consumeEvents().filter(event => event.kind === 'perfect-dodge')).toHaveLength(1);

    const retry = engine.snapshotState();
    retry.tick = 1;
    retry.worldTick = 1;
    retry.timePolicy = 'normal';
    retry.worldTimeScale = 1;
    retry.slowMotionRemainingTicks = 0;
    retry.actionId = 'idle';
    retry.actionUntil = retry.tick;
    retry.actionRecoveryUntil = retry.tick;
    retry.actionCancelable = true;
    retry.counterUntil = 0;
    retry.actors.find(actor => actor.id === 'aren')!.position = vec(0, 0, 0);
    retry.actors.find(actor => actor.id === 'aren')!.actionStartedTick = retry.tick;
    retry.actors.find(actor => actor.id === 'aren')!.actionEndsTick = 0;
    retry.actors.find(actor => actor.id === 'aren')!.normalizedTime = 0;
    retry.hazards[0]!.activeFrom = 3;
    retry.hazards[1]!.activeFrom = 3;
    retry.hazards[0]!.hitIds = ['aren'];
    retry.hazards[1]!.hitIds = [];
    retry.hazards[0]!.threatTicks = [2];
    retry.hazards[1]!.threatTicks = [2];

    const replay = new CombatEngine(retry);
    replay.fixedStep({ ...idle, dodgePressed: true, dodgeDirection: 'left' });
    expect(replay.snapshotState().player.instinct).toBe(20);
    expect(replay.snapshot().worldClock.policy).toBe('normal');
    expect(replay.consumeEvents().filter(event => event.kind === 'perfect-dodge')).toHaveLength(0);
  });

  it('preserves Koro attack selection across a monotonic checkpoint clock rebase', () => {
    const region = REGIONS.find(region => region.id === 'whispering-canopy')!;
    const makeEncounter = () => {
      const engine = new CombatEngine();
      engine.startEncounter({ encounterId: 'encounter-koro', regionId: region.id, runId: 'koro-clock-reset-selection' });
      const state = engine.snapshotState();
      expect(state.encounter?.phases[0]?.attackIds.length).toBeGreaterThan(1);
      state.checkpoint!.lastAttackTick = 1;
      state.lastAttackTick = 1;
      return state;
    };
    const baseline = new CombatEngine(makeEncounter());
    baseline.resetToCheckpoint();
    baseline.fixedStep(idle);
    const expectedAttack = baseline.snapshot().telegraphs[0]?.attackId;
    expect(expectedAttack).toBeDefined();

    const delayedState = makeEncounter();
    delayedState.worldTick += 120;
    const delayed = new CombatEngine(delayedState);
    delayed.resetToCheckpoint();
    delayed.fixedStep(idle);
    expect(delayed.snapshot().telegraphs[0]?.attackId).toBe(expectedAttack);
  });
  it('preserves subsequent Koro attack choices across a monotonic checkpoint clock rebase', () => {
    const region = REGIONS.find(region => region.id === 'whispering-canopy')!;
    const makeEncounter = () => {
      const engine = new CombatEngine();
      engine.startEncounter({ encounterId: 'encounter-koro', regionId: region.id, runId: 'koro-clock-reset-sequence' });
      const state = engine.snapshotState();
      expect(state.encounter?.phases[0]?.attackIds.length).toBeGreaterThan(1);
      state.checkpoint!.lastAttackTick = 1;
      state.lastAttackTick = 1;
      return state;
    };
    const attackSequence = (engine: CombatEngine) => {
      engine.resetToCheckpoint();
      const attacks: string[] = [];
      let previousTelegraphId: string | undefined;
      for (let step = 0; step < 720 && attacks.length < 2; step++) {
        engine.fixedStep(idle);
        const telegraph = engine.snapshot().telegraphs.find(item => item.sourceId === 'koro');
        if (telegraph && telegraph.id !== previousTelegraphId) {
          attacks.push(telegraph.attackId);
          previousTelegraphId = telegraph.id;
        }
      }
      return attacks;
    };
    const baseline = attackSequence(new CombatEngine(makeEncounter()));
    const delayedState = makeEncounter();
    delayedState.worldTick += 120;
    const delayedEngine = new CombatEngine(delayedState);
    delayedEngine.resetToCheckpoint();
    expect(delayedEngine.snapshotState().attackSelectionWorldOffset).toBe(120);
    const restoredDelayed = new CombatEngine();
    restoredDelayed.restore(delayedEngine.serialize());
    expect(restoredDelayed.snapshotState().attackSelectionWorldOffset).toBe(120);
    const delayed = attackSequence(restoredDelayed);
    expect(baseline).toHaveLength(2);
    expect(delayed).toEqual(baseline);
  });

  it('freezes the world clock on pause and restores normal time on checkpoint reset and region load', () => {
    const state = makeClockState();
    state.counterUntil = 14;
    state.lastAttackTick = 5;
    state.checkpoint = {
      tick: state.tick, worldTick: state.worldTick, lastAttackTick: state.lastAttackTick, counterUntil: state.counterUntil, actors: state.actors.map(actor => structuredClone(actor)), player: structuredClone(state.player),
      phaseIndex: 0, phaseLatch: 0, phaseActionFlags: [], rewardEmitted: false, companions: structuredClone(state.companionState),
    };
    state.counterUntil = 0;
    state.timePolicy = 'perfect-dodge-slow';
    state.worldTimeScale = 0.25;
    state.slowMotionRemainingTicks = 8;
    state.slowMotionElapsedTicks = 4;
    const engine = new CombatEngine(state);

    engine.setTimePolicy('paused');
    expect(engine.snapshotState()).toMatchObject({ slowMotionElapsedTicks: 0, slowMotionRemainingTicks: 0 });
    const paused = engine.snapshot().worldClock;
    expect(paused.timeScale).toBe(0);
    expect(engine.step({ ...idle, lightPressed: true }, 0.1)).toBe(0);
    engine.fixedStep(idle);
    expect(engine.snapshot().worldClock).toMatchObject({ simulationTick: paused.simulationTick, worldTick: paused.worldTick, timeScale: 0, policy: 'paused' });
    engine.setTimePolicy('normal');
    engine.fixedStep(idle);
    expect(engine.snapshot().worldClock).toMatchObject({ simulationTick: paused.simulationTick + 1, worldTick: paused.worldTick + 1, timeScale: 1, policy: 'normal' });

    engine.resetToCheckpoint();
    expect(engine.snapshot().worldClock).toMatchObject({ timeScale: 1, policy: 'normal' });
    expect(engine.snapshotState().counterUntil).toBe(14);
    expect(engine.snapshotState()).toMatchObject({ slowMotionElapsedTicks: 0, slowMotionRemainingTicks: 0 });
    engine.setTimePolicy('paused');
    const worldTickBeforeLoad = engine.snapshot().worldClock.worldTick;
    const region = REGIONS.find(candidate => candidate.id === 'blood-bamboo-valley')!;
    engine.loadRegion({ regionId: region.id, runId: 'time-dilation-load-reset', presentActorIds: [], playerPosition: region.entrances[0]!.from });
    expect(engine.snapshot().worldClock).toMatchObject({ worldTick: worldTickBeforeLoad, timeScale: 1, policy: 'normal' });
  });
  it('requires the live hit window to intersect evasion frames rather than warning ticks', () => {
    const future = makeClockState();
    future.tick = 34;
    future.worldTick = 34;
    future.hazards[0]!.activeFrom = 55;
    future.hazards[0]!.activeUntil = 63;
    future.hazards[0]!.threatTicks = [47, 51];
    const early = new CombatEngine(future);
    early.fixedStep({ ...idle, dodgePressed: true, dodgeDirection: 'left' });
    expect(early.snapshot().worldClock).toMatchObject({ simulationTick: 35, worldTick: 35, timeScale: 1, policy: 'normal' });
    expect(early.snapshotState().player.instinct).toBe(0);
    expect(early.consumeEvents().filter(event => event.kind === 'perfect-dodge')).toHaveLength(0);

    const intersecting = makeClockState();
    intersecting.tick = 34;
    intersecting.worldTick = 34;
    intersecting.hazards[0]!.activeFrom = 36.5;
    intersecting.hazards[0]!.activeUntil = 45;
    intersecting.hazards[0]!.threatTicks = [];
    const onTime = new CombatEngine(intersecting);
    onTime.fixedStep({ ...idle, dodgePressed: true, dodgeDirection: 'left' });
    expect(onTime.snapshotState().player.instinct).toBe(20);
    expect(onTime.snapshot().worldClock.policy).toBe('perfect-dodge-slow');
    expect(onTime.consumeEvents().filter(event => event.kind === 'perfect-dodge')).toHaveLength(1);
    const beyondSlow = makeClockState();
    beyondSlow.tick = 34;
    beyondSlow.worldTick = 34;
    beyondSlow.hazards[0]!.activeFrom = 41;
    beyondSlow.hazards[0]!.activeUntil = 45;
    beyondSlow.hazards[0]!.threatTicks = [41];
    const outsideSlow = new CombatEngine(beyondSlow);
    outsideSlow.fixedStep({ ...idle, dodgePressed: true, dodgeDirection: 'left' });
    expect(outsideSlow.snapshotState().player.instinct).toBe(0);
    expect(outsideSlow.snapshot().worldClock.policy).toBe('normal');
    expect(outsideSlow.consumeEvents().filter(event => event.kind === 'perfect-dodge')).toHaveLength(0);

    const slowed = makeClockState();
    slowed.tick = 34;
    slowed.worldTick = 34;
    slowed.timePolicy = 'perfect-dodge-slow';
    slowed.worldTimeScale = 0.25;
    slowed.slowMotionRemainingTicks = 2;
    slowed.hazards[0]!.activeFrom = 35.75;
    slowed.hazards[0]!.activeUntil = 43;
    slowed.hazards[0]!.threatTicks = [];
    const duringSlow = new CombatEngine(slowed);
    duringSlow.fixedStep({ ...idle, dodgePressed: true, dodgeDirection: 'left' });
    expect(duringSlow.snapshotState().player.instinct).toBe(20);
    expect(duringSlow.consumeEvents().filter(event => event.kind === 'perfect-dodge')).toHaveLength(1);
    const immediateState = makeClockState(true);
    immediateState.tick = 1;
    immediateState.worldTick = 1;
    immediateState.timePolicy = 'perfect-dodge-slow';
    immediateState.worldTimeScale = 0.25;
    immediateState.slowMotionRemainingTicks = 12;
    immediateState.hazards[0]!.hitIds = ['aren'];
    immediateState.hazards[1]!.hitGroup = 'unique-immediate-group';
    immediateState.hazards[1]!.activeFrom = 2;
    immediateState.hazards[1]!.activeUntil = 120;
    immediateState.hazards[1]!.threatTicks = [2];
    const immediateExtension = new CombatEngine(immediateState);
    immediateExtension.fixedStep({ ...idle, dodgePressed: true, dodgeDirection: 'left' });
    expect(immediateExtension.consumeEvents().filter(event => event.kind === 'perfect-dodge')).toHaveLength(1);
    expect(immediateExtension.snapshotState()).toMatchObject({ slowMotionElapsedTicks: 1, slowMotionRemainingTicks: 17 });
    expect(immediateExtension.snapshotState().slowMotionElapsedTicks + immediateExtension.snapshotState().slowMotionRemainingTicks).toBe(18);

    const extensionBoundary = makeClockState();
    extensionBoundary.tick = 34;
    extensionBoundary.worldTick = 34;
    extensionBoundary.timePolicy = 'perfect-dodge-slow';
    extensionBoundary.worldTimeScale = 0.25;
    extensionBoundary.slowMotionElapsedTicks = 6;
    extensionBoundary.slowMotionRemainingTicks = 6;
    extensionBoundary.hazards[0]!.hitGroup = 'unique-delayed-group';
    extensionBoundary.hazards[0]!.activeFrom = 35.75;
    extensionBoundary.hazards[0]!.activeUntil = 45;
    extensionBoundary.hazards[0]!.threatTicks = [];
    const extended = new CombatEngine(extensionBoundary);
    extended.fixedStep({ ...idle, dodgePressed: true, dodgeDirection: 'left' });
    expect(extended.consumeEvents().filter(event => event.kind === 'perfect-dodge')).toHaveLength(1);
    expect(extended.snapshotState()).toMatchObject({ slowMotionElapsedTicks: 7, slowMotionRemainingTicks: 11 });
    expect(extended.snapshotState().slowMotionElapsedTicks + extended.snapshotState().slowMotionRemainingTicks).toBe(18);
    const serializedEpisode = new CombatEngine();
    serializedEpisode.restore(extended.serialize());
    expect(serializedEpisode.snapshotState()).toMatchObject({ slowMotionElapsedTicks: 7, slowMotionRemainingTicks: 11 });
    for (let tick = 0; tick < 11; tick++) serializedEpisode.fixedStep(idle);
    expect(serializedEpisode.snapshot().worldClock.policy).toBe('normal');
    expect(serializedEpisode.snapshotState()).toMatchObject({ slowMotionElapsedTicks: 0, slowMotionRemainingTicks: 0 });

    const consumedGroup = makeClockState();
    consumedGroup.tick = 34;
    consumedGroup.worldTick = 34;
    consumedGroup.timePolicy = 'perfect-dodge-slow';
    consumedGroup.worldTimeScale = 0.25;
    consumedGroup.slowMotionRemainingTicks = 2;
    consumedGroup.hazards[0]!.activeFrom = 40;
    consumedGroup.hazards[0]!.activeUntil = 45;
    const consumedHazard = consumedGroup.hazards[0]!;
    consumedGroup.perfectDodgeKeys.push('hunter-melee-west:poacher-hunter-spear:' + consumedHazard.startTick + ':' + consumedHazard.hitGroup);
    const noExtension = new CombatEngine(consumedGroup);
    noExtension.fixedStep({ ...idle, dodgePressed: true, dodgeDirection: 'left' });
    expect(noExtension.snapshotState().player.instinct).toBe(0);
    expect(noExtension.snapshotState().slowMotionRemainingTicks).toBe(1);
    expect(noExtension.consumeEvents().filter(event => event.kind === 'perfect-dodge')).toHaveLength(0);
  });

  it('migrates a v1 serialized EngineState onto its legacy simulation-clock deadline origin', () => {
    const state = makeClockState();
    state.tick = 54;
    state.worldTick = 54;
    state.hazards[0]!.activeFrom = 55;
    state.hazards[0]!.activeUntil = 63;
    state.hazards[0]!.damage = 10;
    state.actors.find(actor => actor.id === 'hunter-melee-west')!.recoveringUntil = 70;
    Object.assign(state.actors.find(actor => actor.id === state.playerId)!, {
      actionId: 'aren-light-1', phase: 'active', actionStartedTick: 44, actionEndsTick: 84, normalizedTime: 0.25,
    });
    state.checkpoint = { tick: 54, worldTick: 54, lastAttackTick: state.lastAttackTick, counterUntil: state.counterUntil, actors: structuredClone(state.actors), player: structuredClone(state.player), phaseIndex: 0, phaseLatch: 0, phaseActionFlags: [], rewardEmitted: false, companions: structuredClone(state.companionState) };
    const legacy = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    legacy.schemaVersion = 1;
    delete legacy.worldTick;
    delete legacy.worldTimeScale;
    delete legacy.timePolicy;
    delete legacy.slowMotionRemainingTicks;
    const legacyCheckpoint = legacy.checkpoint as Record<string, unknown>;
    delete legacyCheckpoint.worldTick;
    delete legacyCheckpoint.lastAttackTick;
    delete legacyCheckpoint.counterUntil;

    const engine = new CombatEngine();
    engine.restore(JSON.stringify(legacy));
    expect(engine.snapshotState()).toMatchObject({ schemaVersion: 3, tick: 54, worldTick: 54, timePolicy: 'normal' });
    expect(engine.snapshotState().checkpoint?.lastAttackTick).toBe(54);
    expect(engine.snapshotState().actors.find(actor => actor.id === state.playerId)).toMatchObject({
      actionStartedTick: 44, actionEndsTick: 84, normalizedTime: 0.25,
    });
    expect(engine.snapshotState().checkpoint?.actors.find(actor => actor.id === state.playerId)).toMatchObject({
      actionStartedTick: 44, actionEndsTick: 84, normalizedTime: 0.25,
    });
    engine.fixedStep(idle);
    expect(engine.snapshotState().worldTick).toBe(55);
    expect(engine.snapshot().hazards[0]?.active).toBe(true);
    expect(engine.snapshotState().player.vitality).toBe(90);
    expect(engine.snapshotState().checkpoint?.worldTick).toBe(54);
    expect(engine.snapshotState().actors.find(actor => actor.id === 'hunter-melee-west')?.recoveringUntil).toBe(70);
    expect(engine.snapshotState().actors.find(actor => actor.id === state.playerId)?.normalizedTime).toBeCloseTo(0.275);
    engine.resetToCheckpoint();
    expect(engine.snapshotState()).toMatchObject({ tick: 54, worldTick: 55 });
    expect(engine.snapshotState().actors.find(actor => actor.id === state.playerId)).toMatchObject({
      actionStartedTick: 44, actionEndsTick: 84, normalizedTime: 0.25,
    });
    engine.fixedStep(idle);
    expect(engine.snapshotState().actors.find(actor => actor.id === state.playerId)?.normalizedTime).toBeCloseTo(0.275);

    const fractional = new CombatEngine();
    const fractionalState = createEngineState();
    fractionalState.tick = 9;
    fractionalState.worldTick = 7.25;
    const fractionalSource = new CombatEngine(fractionalState);
    fractional.restore(fractionalSource.serialize());
    expect(fractional.snapshot().worldClock.worldTick).toBe(7.25);
    expect(fractional.snapshotState().schemaVersion).toBe(3);
  });

  for (const schemaVersion of [2, undefined] as const) {
    it(`migrates ${schemaVersion === 2 ? 'v2' : 'unversioned world-clock'} player samples without changing live or checkpoint progress`, () => {
      const state = makeClockState();
      state.tick = 60;
      state.worldTick = 45.25;
      state.hazards = [];
      state.timePolicy = 'perfect-dodge-slow';
      state.worldTimeScale = 0.25;
      state.slowMotionRemainingTicks = 6;
      state.actionId = 'light_1';
      state.actionUntil = 65;
      state.actionRecoveryUntil = 83;
      const player = state.actors.find(actor => actor.id === state.playerId)!;
      Object.assign(player, {
        actionId: 'aren-light-1', phase: 'active', actionStartedTick: 34.25, actionEndsTick: 74.25, normalizedTime: 0.25,
      });
      const enemy = state.actors.find(actor => actor.id !== state.playerId)!;
      Object.assign(enemy, {
        phase: 'active', actionStartedTick: 37.25, actionEndsTick: 77.25, normalizedTime: 0.2, recoveringUntil: 77.25,
      });
      const checkpointActors = structuredClone(state.actors);
      Object.assign(checkpointActors.find(actor => actor.id === state.playerId)!, {
        actionStartedTick: 32.25, actionEndsTick: 72.25, normalizedTime: 0.1,
      });
      Object.assign(checkpointActors.find(actor => actor.id !== state.playerId)!, {
        actionStartedTick: 27.25, actionEndsTick: 67.25, recoveringUntil: 67.25,
      });
      state.checkpoint = {
        tick: 50, worldTick: 35.25, lastAttackTick: 0, counterUntil: 0, actors: checkpointActors,
        player: structuredClone(state.player), phaseIndex: 0, phaseLatch: 0, phaseActionFlags: [],
        rewardEmitted: false, companions: structuredClone(state.companionState),
      };
      const legacy = JSON.parse(JSON.stringify(state)) as EngineStateSeed;
      if (schemaVersion === undefined) delete legacy.schemaVersion;
      else legacy.schemaVersion = schemaVersion;
      const engine = new CombatEngine();
      engine.restore(JSON.stringify(legacy));
      const migrated = engine.snapshotState();
      expect(migrated.schemaVersion).toBe(3);
      expect(migrated.actors.find(actor => actor.id === state.playerId)).toMatchObject({
        actionStartedTick: 50, actionEndsTick: 90, normalizedTime: 0.25,
      });
      expect(migrated.checkpoint!.actors.find(actor => actor.id === state.playerId)).toMatchObject({
        actionStartedTick: 46, actionEndsTick: 86, normalizedTime: 0.1,
      });
      expect(migrated.actors.find(actor => actor.id === enemy.id)).toEqual(enemy);
      expect(migrated.checkpoint!.actors.find(actor => actor.id === enemy.id)).toEqual(checkpointActors.find(actor => actor.id === enemy.id));
      expect(migrated.actionUntil).toBe(state.actionUntil);
      expect(migrated.actionRecoveryUntil).toBe(state.actionRecoveryUntil);
      const roundTrip = new CombatEngine(JSON.parse(engine.serialize()) as EngineStateSeed);
      expect(roundTrip.snapshotState().actors).toEqual(migrated.actors);
      expect(roundTrip.snapshotState().checkpoint).toEqual(migrated.checkpoint);
      roundTrip.fixedStep(idle);
      expect(roundTrip.snapshotState()).toMatchObject({ tick: 61, worldTick: 45.5 });
      expect(roundTrip.snapshotState().actors.find(actor => actor.id === state.playerId)?.normalizedTime).toBeCloseTo(0.275);
      expect(roundTrip.snapshotState().actors.find(actor => actor.id === enemy.id)?.normalizedTime).toBeCloseTo(0.20625);
      roundTrip.resetToCheckpoint();
      expect(roundTrip.snapshotState()).toMatchObject({ tick: 50, worldTick: 45.5, timePolicy: 'normal' });
      expect(roundTrip.snapshotState().actors.find(actor => actor.id === state.playerId)).toMatchObject({
        actionStartedTick: 46, actionEndsTick: 86, normalizedTime: 0.1,
      });
      expect(roundTrip.snapshotState().actors.find(actor => actor.id === enemy.id)).toMatchObject({
        actionStartedTick: 37.5, actionEndsTick: 77.5, normalizedTime: 0.2, recoveringUntil: 77.5,
      });
      roundTrip.fixedStep(idle);
      expect(roundTrip.snapshotState().actors.find(actor => actor.id === state.playerId)?.normalizedTime).toBeCloseTo(0.125);
      expect(roundTrip.snapshotState().actors.find(actor => actor.id === enemy.id)?.normalizedTime).toBeCloseTo(0.225);
      roundTrip.resetToCheckpoint();
      expect(roundTrip.snapshotState().actors.find(actor => actor.id === state.playerId)).toMatchObject({
        actionStartedTick: 46, actionEndsTick: 86, normalizedTime: 0.1,
      });
      expect(roundTrip.snapshotState().actors.find(actor => actor.id === enemy.id)).toMatchObject({
        actionStartedTick: 38.5, actionEndsTick: 78.5, normalizedTime: 0.2,
      });
      expect(roundTrip.snapshotState().checkpoint).toEqual(migrated.checkpoint);
      for (let step = 0; step < 36; step++) roundTrip.fixedStep(idle);
      expect(roundTrip.snapshotState().tick).toBe(86);
      expect(roundTrip.snapshotState().actors.find(actor => actor.id === state.playerId)).toMatchObject({
        actionId: 'aren-idle', actionStartedTick: 86, actionEndsTick: 0, normalizedTime: 0,
      });
    });
  }

  it('retains v3 player action timestamps through restore and repeated monotonic-world checkpoint resets', () => {
    const state = makeClockState();
    state.tick = 60;
    state.worldTick = 45.25;
    state.hazards = [];
    Object.assign(state.actors.find(actor => actor.id === state.playerId)!, {
      actionId: 'aren-light-1', phase: 'active', actionStartedTick: 50, actionEndsTick: 90, normalizedTime: 0.25,
    });
    const checkpointActors = structuredClone(state.actors);
    Object.assign(checkpointActors.find(actor => actor.id === state.playerId)!, {
      actionStartedTick: 46, actionEndsTick: 86, normalizedTime: 0.1,
    });
    Object.assign(checkpointActors.find(actor => actor.id !== state.playerId)!, {
      phase: 'active', actionStartedTick: 27.25, actionEndsTick: 67.25, normalizedTime: 0.2, recoveringUntil: 67.25,
    });
    state.checkpoint = {
      tick: 50, worldTick: 35.25, lastAttackTick: 0, counterUntil: 0, actors: checkpointActors,
      player: structuredClone(state.player), phaseIndex: 0, phaseLatch: 0, phaseActionFlags: [],
      rewardEmitted: false, companions: structuredClone(state.companionState),
    };
    const engine = new CombatEngine();
    engine.restore(JSON.stringify(state));
    expect(engine.snapshotState().actors).toEqual(state.actors);
    expect(engine.snapshotState().checkpoint).toEqual(state.checkpoint);
    for (let retry = 0; retry < 2; retry++) {
      engine.resetToCheckpoint();
      expect(engine.snapshotState().actors.find(actor => actor.id === state.playerId)).toMatchObject({
        actionStartedTick: 46, actionEndsTick: 86, normalizedTime: 0.1,
      });
      const retryWorldTick = engine.snapshotState().worldTick;
      expect(engine.snapshotState().actors.find(actor => actor.id !== state.playerId)).toMatchObject({
        actionStartedTick: retryWorldTick - 8, actionEndsTick: retryWorldTick + 32, normalizedTime: 0.2,
      });
      engine.fixedStep(idle);
      expect(engine.snapshotState().actors.find(actor => actor.id === state.playerId)?.normalizedTime).toBeCloseTo(0.125);
      expect(engine.snapshotState().actors.find(actor => actor.id !== state.playerId)?.normalizedTime).toBeCloseTo(0.225);
    }
    expect(engine.snapshotState().checkpoint).toEqual(state.checkpoint);
  });


  it('hydrates legacy queued StoryCue timestamps and ages the hydrated cue through StoryEffects', () => {
    const source = new CombatEngine(makeClockState());
    const cue = source.queuePresentationCue({ kind: 'hit', phase: 'hit', position: vec(0, 0, 0), durationTicks: 6, priority: 'essential' });
    const legacy = JSON.parse(source.serialize()) as Record<string, unknown>;
    legacy.schemaVersion = 1;
    delete legacy.worldTick;
    delete legacy.worldTimeScale;
    delete legacy.timePolicy;
    delete legacy.slowMotionRemainingTicks;
    delete legacy.slowMotionElapsedTicks;
    const legacyCues = legacy.presentationCues as Array<Record<string, unknown>>;
    delete legacyCues[0]!.worldTimeSeconds;
    delete legacyCues[0]!.worldTick;
    const restored = new CombatEngine(legacy as EngineStateSeed);
    const migratedCue = restored.drainPresentationCues()[0]!;
    expect(migratedCue.worldTimeSeconds).toBe(cue.tick / 60);
    expect(migratedCue.worldTick).toBe(cue.tick);

    const scene = new THREE.Scene();
    const effects = new StoryEffects({ scene, capacity: 8 });
    expect(effects.emit(migratedCue)).toBe(true);
    effects.update(restored.snapshot().worldClock);
    expect(effects.activeCount).toBe(1);
    const activeMaterials = scene.getObjectByName('story-effects')!.children.map(child => (child as THREE.Mesh).material as THREE.MeshBasicMaterial);
    expect(activeMaterials.some(material => Number.isFinite(material.opacity) && material.opacity > 0)).toBe(true);
    for (let tick = 0; tick < 6; tick++) restored.fixedStep(idle);
    effects.update(restored.snapshot().worldClock);
    expect(effects.activeCount).toBe(0);
    expect(activeMaterials.every(material => Number.isFinite(material.opacity))).toBe(true);
    effects.dispose();
  });

  it('stamps and hydrates exact fractional cue ticks without quantizing through seconds', () => {
    const state = makeClockState(); state.worldTick = 1.25;
    const source = new CombatEngine(state);
    source.queuePresentationCue({ kind: 'hit', phase: 'hit', position: vec(0, 0, 0), durationTicks: 54, priority: 'essential' });
    const hydrated = new CombatEngine(JSON.parse(source.serialize()) as EngineStateSeed);
    expect(hydrated.drainPresentationCues()[0]?.worldTick).toBe(1.25);
    const legacy = JSON.parse(source.serialize()) as EngineStateSeed;
    if (legacy.presentationCues) for (const cue of legacy.presentationCues) Reflect.deleteProperty(cue, 'worldTick');
    const migrated = new CombatEngine(legacy);
    expect(migrated.drainPresentationCues()[0]?.worldTick).toBe(1.25);
  });

  it('publishes weakpoint exposure for a non-boss target and keeps boss exposure aligned', () => {
    const state = makeClockState();
    state.worldTick = 53;
    state.targetId = 'hunter-melee-west';
    const hunter = state.actors.find(actor => actor.id === 'hunter-melee-west')!;
    hunter.staggerUntil = 89;
    const staggerOnly = new CombatEngine(state).snapshot();
    expect(staggerOnly.actors.find(actor => actor.id === 'hunter-melee-west')).toMatchObject({ weakPointExposed: false });
    hunter.weakPointUntil = 89;
    const target = new CombatEngine(state).snapshot();
    expect(target.boss).toBeUndefined();
    expect(target.actors.find(actor => actor.id === 'hunter-melee-west')).toMatchObject({ weakPointExposed: true });

    const region = REGIONS.find(candidate => candidate.id === 'whispering-canopy')!;
    const bossEngine = new CombatEngine();
    bossEngine.startEncounter({ encounterId: 'encounter-koro', regionId: region.id, runId: 'weakpoint-boss-test' });
    const exposed = bossEngine.snapshotState();
    exposed.worldTick = 11;
    exposed.actors.find(actor => actor.id === 'koro')!.weakPointUntil = 20;
    const bossSnapshot = new CombatEngine(exposed).snapshot();
    expect(bossSnapshot.boss?.exposed).toBe(true);
    expect(bossSnapshot.actors.find(actor => actor.id === 'koro')).toMatchObject({ weakPointExposed: true });
  });

  it('rebases checkpoint actor deadlines while keeping world time monotonic', () => {
    const region = REGIONS.find(candidate => candidate.id === 'whispering-canopy')!;
    const started = new CombatEngine();
    started.startEncounter({ encounterId: 'encounter-koro', regionId: region.id, runId: 'checkpoint-rebase-test' });
    const state = started.snapshotState();
    const koro = state.actors.find(actor => actor.id === 'koro')!;
    koro.invulnerableUntil = 46;
    koro.recoveringUntil = 50;
    koro.possessedUntil = 44;
    koro.weakPointUntil = 48;
    koro.actionStartedTick = 5;
    koro.actionEndsTick = 25;
    const aren = state.actors.find(actor => actor.id === 'aren')!;
    aren.invulnerableUntil = 12;
    state.counterUntil = 14;
    state.checkpoint!.counterUntil = 14;
    const checkpointActor = state.checkpoint!.actors.find(actor => actor.id === 'koro')!;
    Object.assign(checkpointActor, { recoveringUntil: 50, invulnerableUntil: 46, possessedUntil: 44, weakPointUntil: 48, actionStartedTick: 5, actionEndsTick: 25 });
    state.checkpoint!.actors.find(actor => actor.id === 'aren')!.invulnerableUntil = 12;
    const firstAttack = makeClockState().hazards[0]!;
    state.perfectDodgeKeys.push('hunter-melee-west:poacher-hunter-spear:' + firstAttack.startTick + ':' + firstAttack.hitGroup);
    const engine = new CombatEngine(state);
    for (let step = 0; step < 60; step++) engine.fixedStep(idle);
    expect(engine.snapshot().worldClock.worldTick).toBe(60);
    engine.queuePresentationCue({ kind: 'hit', phase: 'hit', position: vec(0, 0, 0), durationTicks: 12, priority: 'essential' });
    engine.resetToCheckpoint();
    expect(engine.snapshot().worldClock).toMatchObject({ simulationTick: 0, worldTick: 60, timeScale: 1, policy: 'normal' });
    expect(engine.snapshotState()).toMatchObject({ counterUntil: 14, lastAttackTick: 0 });
    const restored = engine.snapshotState().actors.find(actor => actor.id === 'koro')!;
    expect(restored).toMatchObject({ invulnerableUntil: 106, recoveringUntil: 110, possessedUntil: 104, weakPointUntil: 108, actionStartedTick: 65, actionEndsTick: 85 });
    expect(engine.snapshotState().actors.find(actor => actor.id === 'aren')!.invulnerableUntil).toBe(12);
    engine.fixedStep(idle);
    expect(engine.snapshot().worldClock.worldTick).toBe(61);
    expect(engine.snapshotState().actors.find(actor => actor.id === 'koro')!.recoveringUntil).toBeGreaterThan(61);
    const retry = engine.snapshotState();
    const retryHazard = structuredClone(makeClockState().hazards[0]!);
    retryHazard.startTick = retry.worldTick;
    retryHazard.activeFrom = retry.worldTick + 2;
    retryHazard.activeUntil = retry.worldTick + 10;
    retryHazard.target = retry.actors.find(actor => actor.id === 'aren')!.position;
    retryHazard.hitIds = [];
    retry.hazards = [retryHazard];
    const replay = new CombatEngine(retry);
    replay.fixedStep({ ...idle, dodgePressed: true, dodgeDirection: 'left' });
    expect(replay.snapshot().worldClock.policy).toBe('perfect-dodge-slow');
    expect(replay.snapshotState().perfectDodgeKeys).toHaveLength(2);
    expect(replay.consumeEvents().filter(event => event.kind === 'perfect-dodge')).toHaveLength(1);
  });
  it('preserves checkpoint Koro attack choice across monotonic world-time rebase', () => {
    const region = REGIONS.find(candidate => candidate.id === 'whispering-canopy')!;
    const seed = createEngineState();
    seed.tick = 359;
    seed.worldTick = 359;
    seed.lastAttackTick = 239;
    const engine = new CombatEngine(seed);
    engine.startEncounter({ encounterId: 'encounter-koro', regionId: region.id, runId: 'checkpoint-attack-order-test' });
    expect(engine.snapshotState().checkpoint?.lastAttackTick).toBe(239);
    for (let step = 0; step < 60; step++) engine.fixedStep(idle);
    expect(engine.snapshotState().lastAttackTick).toBe(360);

    engine.resetToCheckpoint();
    expect(engine.snapshotState().lastAttackTick).toBe(299);
    engine.fixedStep(idle);
    expect(engine.snapshot().telegraphs.find(telegraph => telegraph.sourceId === 'koro')?.attackId).toBe('koro-fruit-burst');
  });
});
