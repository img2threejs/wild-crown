import { describe, expect, it } from 'bun:test';
import { GameApplication } from '../../src/app/GameApplication.js';
import { CANDIDATE_CHAPTERS_SESSION, trainingSession } from '../../src/app/SessionConfig.js';
import { CampaignDirector } from '../../src/game/campaign/CampaignDirector.js';
import { CombatEngine } from '../../src/game/combat/CombatEngine.js';
import { REGIONS } from '../../src/content/campaign.js';
import { CHAPTER_RUNTIME, LAYOUT_MIGRATIONS, RELATIONSHIP_RULES } from '../../src/content/chapters.js';
import type { CampaignSnapshot } from '../../src/game/contracts.js';
import { appDefaults } from './fakeApp.js';

type AppRecord = Record<string, any>;

/** Real campaign and combat state; only native asset/world I/O and UI rendering are replaced. */
async function returningPractice(withEarnedCompanion = false) {
  const director = new CampaignDirector({ saveScope: 'candidate-chapters', chapters: CHAPTER_RUNTIME, layoutMigrations: LAYOUT_MIGRATIONS, relationshipRules: RELATIONSHIP_RULES });
  let source = director.startChapterRun({ runId: 'original-journey', heroId: 'aren', saveScope: 'candidate-chapters' });
  if (withEarnedCompanion) {
    // An explicit earned legacy-roster fixture, not a claim that this test played the campaign.
    const checkpoint = await director.captureCheckpoint();
    checkpoint.worldCheckpoint.world.companions.koro = {
      id: 'koro', recruited: true, bondLevel: 10, dominionLevel: 0, unlockedAbilityIds: [], storyFlags: {},
    };
    expect(await director.restoreCheckpoint(checkpoint)).toBe(true);
    source = director.snapshot();
  }
  const region = REGIONS.find(region => region.id === source.regionId)!;
  const combat = new CombatEngine();
  combat.loadRegion({ regionId: region.id, regionDefinition: region, runId: source.runId, presentActorIds: ['aren'], companionProgress: source.companions });
  // Seed an injured, resource-depleted original simulation. No practice result may heal or refill it.
  const seed = JSON.parse(combat.serialize());
  seed.player.vitality = 37;
  seed.player.mana = 24;
  seed.player.instinct = 7;
  seed.actors.find((actor: { id: string }) => actor.id === seed.playerId).vitality = 37;
  combat.restore(JSON.stringify(seed));
  const savedCombat = combat.serialize();
  const originalCampaign = director.snapshot().campaign;
  combat.startNewRun('practice-run');
  const practiceDirector = new CampaignDirector({ saveScope: source.session.saveScope });
  const practice = practiceDirector.startPracticeRun({ runId: 'practice-run', source, regionId: region.id });
  combat.loadRegion({ regionId: region.id, regionDefinition: region, runId: practice.runId, presentActorIds: ['aren'], companionProgress: practice.companions });
  const app = Object.assign(Object.create(GameApplication.prototype), appDefaults(), {
    disposed: false, lifecycleGeneration: 0, worldGeneration: 0, ready: true, suspended: false,
    combat, campaignDirector: practiceDirector, campaign: practice, session: trainingSession('greenwake', 'candidate'),
    trainingReturn: { session: CANDIDATE_CHAPTERS_SESSION, director, snapshot: source, combat: savedCombat },
    trainingReturning: false, activeRunId: practice.runId, region, worldReady: true,
    screen: 'pause', screenHistory: [], loading: { active: false, label: '', progress: null }, error: null,
    sceneBlocked: false, stageCompleted: false, playerOutcome: null, entryShot: false,
    pendingWorldEvents: [], failedWorldEvent: null, pendingNarrativeCues: [], lastCueSnapshot: source,
    input: { clear() {}, setEnabled() {}, setExternalWheel() {} },
    renderer: { getNativeSolidColliders: () => [], getNativeSupportFields: () => [], sync() {} },
    render() {}, updateBanner() {},
  }) as AppRecord;
  const prepareWorld = async (snapshot: CampaignSnapshot) => {
    // Rebuilding a world starts from the practice engine's full resources unless the application restores its return ticket.
    combat.loadRegion({ regionId: region.id, regionDefinition: region, runId: snapshot.runId, presentActorIds: ['aren'], companionProgress: snapshot.companions });
    app.region = region;
    app.worldReady = true;
    app.loading = { active: false, label: '', progress: null };
    app.error = null;
    app.sceneBlocked = false;
  };
  app.prepareWorld = prepareWorld;
  return { app, combat, director, originalCampaign, prepareWorld };
}

function expectOriginalResources(combat: CombatEngine) {
  const player = combat.snapshot().player;
  expect({ vitality: player.vitality, mana: player.mana, instinct: player.instinct }).toEqual({ vitality: 37, mana: 24, instinct: 7 });
}

describe('isolated practice return', () => {
  it('restores injured campaign resources after rebuilding the native world, without replacing journey history', async () => {
    const { app, combat, director, originalCampaign } = await returningPractice();
    await app.leaveTraining();
    expectOriginalResources(combat);
    expect(app.screen).toBe('game');
    expect(app.session).toEqual(CANDIDATE_CHAPTERS_SESSION);
    expect(app.campaignDirector.snapshot().runId).toBe('original-journey');
    expect(director.snapshot().campaign).toEqual(originalCampaign);
    expect(app.trainingReturn).toBeNull();
  });

  it('keeps the original resource ticket across a failed world return and uses it on retry', async () => {
    const { app, combat, director, originalCampaign, prepareWorld } = await returningPractice();
    app.prepareWorld = async () => { throw new Error('Native world temporarily unavailable'); };
    await app.leaveTraining();
    expect(app.screen).toBe('loading');
    expect(app.loading.operationId).toBe('training-return');
    expect(app.error.recoverable).toBe(true);
    expect(app.trainingReturn).not.toBeNull();
    expect(director.snapshot().campaign).toEqual(originalCampaign);
    app.prepareWorld = prepareWorld;
    await app.dispatch({ type: 'retry-load', operationId: 'training-return' });
    expectOriginalResources(combat);
    expect(app.screen).toBe('game');
    expect(app.trainingReturn).toBeNull();
    expect(director.snapshot().campaign).toEqual(originalCampaign);
  });

  it('does not replace the restored journey with a practice party transaction that resolves late', async () => {
    const { app, combat, director, originalCampaign } = await returningPractice(true);
    const practiceDirector = app.campaignDirector as CampaignDirector;
    const selectParty = practiceDirector.selectParty.bind(practiceDirector);
    let release!: () => void, reached!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const selecting = new Promise<void>(resolve => { reached = resolve; });
    practiceDirector.selectParty = async companionId => {
      const selected = await selectParty(companionId);
      reached();
      await held;
      return selected;
    };
    app.loadWorldManifest = async () => [];
    app.renderer.prepareCompanionParty = async () => ({ commit() {}, dispose() {} });

    const pending = app.assignParty('koro');
    await selecting;
    await app.leaveTraining();
    release();
    await pending;

    expect(app.campaign.runId).toBe('original-journey');
    expect(app.campaign.party).toEqual({});
    expect(app.campaignDirector).toBe(director);
    expect(director.snapshot().campaign).toEqual(originalCampaign);
    expect(combat.companions.companionId).toBeUndefined();
    expectOriginalResources(combat);
  });
});
