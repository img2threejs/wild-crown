import { expect, it } from 'bun:test';
import { GameApplication } from '../../src/app/GameApplication.js';
import { ASSET_PLAYTESTS, type AssetPlaytest } from '../../src/app/AssetPlaytests.js';
import { StageGoal } from '../../src/app/StageGoal.js';
import { PlaytestProgress } from '../../src/app/PlaytestProgress.js';
import { REGIONS } from '../../src/content/campaign.js';
import { CampaignDirector } from '../../src/game/campaign/CampaignDirector.js';
import { CombatEngine, type CombatInput } from '../../src/game/combat/CombatEngine.js';
import { createCombatTrialRegion } from '../../src/game/combat/TrialRegions.js';
import { appDefaults } from './fakeApp.js';
import { PRODUCTION_SESSION, trialsSession } from '../../src/app/SessionConfig.js';

const idle: CombatInput = { tick: 0, move: { x: 0, y: 0, z: 0 }, dodgePressed: false,
  lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };

function setup(playtest: AssetPlaytest) {
  const region = createCombatTrialRegion(REGIONS.find(candidate => candidate.id === playtest.regionId)!);
  const exit = region.exits.find(route => route.id === playtest.exitRouteId)!.from;
  return { region, exit };
}
function arrivalApp(playtest: AssetPlaytest, position?: { x: number; y: number; z: number }) {
  const { region, exit } = setup(playtest);
  const start = position ?? { x: exit.x - 2.3, y: exit.y, z: exit.z };
  const combat = new CombatEngine();
  combat.loadRegion({ regionId: playtest.regionId, regionDefinition: region, runId: 'arrival-test',
    presentActorIds: playtest.trialSet.trials.map(trial => trial.monsterId), playerPosition: start });
  combat.startEncounter({ encounterId: playtest.trialSet.encounterId, regionId: playtest.regionId, runId: 'arrival-test', playerPosition: start });
  combat.enableCombatTrials();
  const cleared = combat.snapshotState();
  cleared.combatTrial = { index: playtest.trialSet.trials.length, status: 'complete' };
  combat.restore(JSON.stringify(cleared));
  const director = new CampaignDirector({ runId: 'arrival-test' });
  const campaign = director.startShowcase('arrival-test', playtest.showcaseRegionId);
  const goal = new StageGoal(exit);
  const input = { enabled: true, clear() {}, setEnabled(value: boolean) { this.enabled = value; } };
  const progress = new PlaytestProgress(null);
  for (const previous of ASSET_PLAYTESTS.slice(0, ASSET_PLAYTESTS.indexOf(playtest))) progress.complete(previous.id);
  const app = Object.assign(Object.create(GameApplication.prototype), {
    ...appDefaults(),
    session: trialsSession(playtest.id), stageGoal: goal, stageCompleted: false, screen: 'game', screenHistory: [],
    playtestProgress: progress, worldReady: true, ready: true, disposed: false, suspended: false, loading: { active: false },
    error: null, sceneBlocked: false, region, campaign, combat, input,
    renderer: { sync() {}, render() {}, startPlayerOutcome() {}, beginWaystoneArrival() {} },
    presentation: null, damageNumbers: { clear() {} }, render() {},
  }) as Record<string, any>;
  return { app, goal, combat, input, exit, progress };
}

for (const playtest of ASSET_PLAYTESTS) {
  it(`${playtest.id}: destination boundary rejects corners and wrong elevation; pillar clears the arrival circle`, () => {
    const { region, exit } = setup(playtest);
    const goal = new StageGoal(exit);
    expect(goal.contains(exit)).toBe(true);
    expect(goal.contains({ ...exit, x: exit.x + goal.radius })).toBe(true);
    expect(goal.contains({ ...exit, z: exit.z - goal.radius })).toBe(true);
    expect(goal.contains({ ...exit, x: exit.x + goal.radius + .01 })).toBe(false);
    expect(goal.contains({ ...exit, x: exit.x + 2, z: exit.z + 2 })).toBe(false);
    expect(goal.contains({ ...exit, y: exit.y + 2 })).toBe(false);
    const pillar = goal.pillarPosition(region, { x: 1, y: 0, z: 0 });
    expect(Math.hypot(pillar.x - exit.x, pillar.z - exit.z)).toBeCloseTo(4.6);
    expect(goal.contains(pillar)).toBe(false);
  });

  it(`${playtest.id}: arrival locks gameplay immediately while the visual sequence precedes completion UI`, () => {
    const { app, combat, input, progress } = arrivalApp(playtest);
    const campaignBefore = JSON.stringify(app.campaign);
    app.checkStageArrival(combat.snapshot());
    expect(progress.isCleared(playtest.id)).toBe(false);
    for (let tick = 0; tick < 12 && !app.stageCompleted; tick++) {
      combat.fixedStep({ ...idle, move: { x: 1, y: 0, z: 0 } });
      app.checkStageArrival(combat.snapshot());
    }
    expect(app.stageCompleted).toBe(true);
    expect(app.screen).toBe('game');
    expect(app.playerOutcome).toBe('victory');
    expect(app.appAudio.calls.filter((call: unknown[]) => call[0] === 'playStinger')).toEqual([['playStinger', 'victory']]);
    expect(app.outcomeElapsed).toBe(0);
    expect(progress.isCleared(playtest.id)).toBe(true);
    expect(input.enabled).toBe(false);
    expect(combat.snapshot().worldClock.policy).toBe('paused');
    const arrived = combat.snapshot();
    app.checkStageArrival(combat.snapshot());
    for (let tick = 0; tick < 60; tick++) combat.fixedStep(idle);
    expect(combat.snapshot().worldClock.worldTick).toBe(arrived.worldClock.worldTick);
    expect(combat.snapshot().actors.find(actor => actor.id === 'aren')!.position)
      .toEqual(arrived.actors.find(actor => actor.id === 'aren')!.position);
    expect(JSON.stringify(app.campaign)).toBe(campaignBefore);
    app.setScreen('game');
    expect(app.screen).toBe('stage-complete');
    expect(input.enabled).toBe(false);
  });

  it(`${playtest.id}: dead players, uncleared required trials and production mode never complete`, () => {
    const blockers = ['death', 'gates', 'production'];
    for (const blockedBy of blockers) {
      const { app, combat, progress } = arrivalApp(playtest, setup(playtest).exit);
      const seed = combat.snapshotState();
      if (blockedBy === 'death') seed.player.vitality = 0;
      else if (blockedBy === 'gates') { seed.combatTrial!.index = 0; seed.combatTrial!.status = 'approach'; }
      else app.session = PRODUCTION_SESSION;
      combat.restore(JSON.stringify(seed));
      app.checkStageArrival(combat.snapshot());
      expect(app.stageCompleted).toBe(false);
      expect(progress.isCleared(playtest.id)).toBe(false);
    }
  });
}
