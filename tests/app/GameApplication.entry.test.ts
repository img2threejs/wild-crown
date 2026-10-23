import { afterEach, describe, expect, it } from 'bun:test';
import { REGIONS } from '../../src/content/campaign.js';
import { GameApplication, worldLoadPhases } from '../../src/app/GameApplication.js';
import { CANOPY_PLAYTEST } from '../../src/app/AssetPlaytests.js';
import { CANDIDATE_CHAPTERS_SESSION, PRODUCTION_SESSION, trialsSession } from '../../src/app/SessionConfig.js';
import { appDefaults } from './fakeApp.js';
import { CampaignDirector } from '../../src/game/campaign/CampaignDirector.js';
import { LoadProgress } from '../../src/app/LoadProgress.js';
import { CombatEngine } from '../../src/game/combat/CombatEngine.js';
import { DEFAULT_GAME_SETTINGS, DEFAULT_INPUT_BINDINGS, type GameViewModel, type UIAction } from '../../src/game/contracts.js';
import { createFakeAppAudio } from './fakeAppAudio.js';
import { SaveRepository } from '../../src/game/storage/SaveRepository.js';
import { FakeIDBFactory } from '../storage/fakeIndexedDB.js';

type AppRecord = Record<string, any>;
const proto = GameApplication.prototype as unknown as AppRecord;

/** A fake renderer with a controllable establishing shot that records everything the application asks of it. */
function fakeRenderer() {
  const calls: string[] = [];
  const renderer = {
    shotActive: true,
    shotOptions: [] as { seconds: number; reducedMotion: boolean }[],
    get establishingShotActive() { return renderer.shotActive; },
    beginEstablishingShot(options: { seconds: number; reducedMotion: boolean }) { calls.push('begin'); renderer.shotOptions.push(options); renderer.shotActive = options.seconds > 0 && !options.reducedMotion; },
    skipEstablishingShot() { calls.push('skip'); renderer.shotActive = false; },
    sync() { calls.push('sync'); },
    updateWaystone() { calls.push('waystone'); },
    setChapterGuidance() {},
    updateChapterGuidance() {},
    render() { calls.push('render'); },
    dispose() {},
    calls,
  };
  return renderer;
}

/** The application with real view-model and render code, a real (paused) CombatEngine and recording stand-ins at the edges. */
function entryApp(overrides: AppRecord = {}) {
  const app = Object.create(GameApplication.prototype) as AppRecord;
  const combat = new CombatEngine();
  combat.setTimePolicy('paused');
  const policies: string[] = [];
  const setPolicy = combat.setTimePolicy.bind(combat);
  combat.setTimePolicy = (policy: Parameters<CombatEngine['setTimePolicy']>[0]) => { policies.push(policy); setPolicy(policy); };
  const region = REGIONS.find(item => item.id === 'whispering-canopy')!;
  const director = new CampaignDirector();
  const campaign = director.startShowcase('entry-run', 'whispering-canopy', { heroId: 'aren', companionId: 'koro' });
  const models: GameViewModel[] = [];
  const inputEnabled: boolean[] = [];
  const renderer = fakeRenderer();
  Object.assign(app, {
    disposed: false, lifecycleGeneration: 0, worldGeneration: 0, screenHistory: [], worldReady: true, ready: true, suspended: false,
    ...appDefaults(),
    session: trialsSession('canopy'), selectedHero: 'aren', playtestProgress: { isUnlocked: () => true, isCleared: () => false },
    settings: { ...DEFAULT_GAME_SETTINGS }, bindings: { keyboard: { ...DEFAULT_INPUT_BINDINGS.keyboard }, gamepad: { ...DEFAULT_INPUT_BINDINGS.gamepad } },
    slots: [], region, renderer, combat, activeCompanionId: undefined, companionPreviews: new Map(),
    campaign, campaignDirector: director,
    screen: 'hero-select', loading: { active: false, label: '', progress: null }, error: null, sceneBlocked: false, stageCompleted: false, playerOutcome: null,
    stageGoal: null, dialogue: null, dialogueLineIndex: 0, choice: null, ending: null, interaction: undefined,
    pendingWorldEvents: [], failedWorldEvent: null, durableEvents: Promise.resolve(), pendingNarrativeCues: [], lastCueSnapshot: null, loadingFromSave: false,
    accumulator: 0, previousTime: 0,
    damageNumbers: { clear() {}, update() {}, element: { hidden: true } }, monsterLabels: { clear() {}, update() {}, element: { hidden: true } },
    input: { clear() {}, setEnabled: (value: boolean) => { inputEnabled.push(value); } },
    ui: { render: (model: GameViewModel) => { models.push(model); }, updateGamepad() {}, setGateContact() {} },
    ...overrides,
  });
  return { app, combat, policies, models, inputEnabled, renderer, region };
}
const dispatch = (app: AppRecord, action: UIAction) => app.dispatch(action) as Promise<void>;
const last = <T,>(items: readonly T[]): T => items[items.length - 1]!;

const savedDocument = globalThis.document;
afterEach(() => {
  Object.assign(globalThis, { document: savedDocument });
  delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
});

describe('map intro entry', () => {
  it('shows the map intro at once after hero select and starts loading behind it without waiting for Continue', async () => {
    const { app, models } = entryApp();
    const seen: { screen: string; hold: boolean; wanted: boolean }[] = [];
    app.prepareWorld = async () => { seen.push({ screen: app.screen, hold: app.mapIntroHold, wanted: app.entryShotWanted }); };
    await dispatch(app, { type: 'select-hero', heroId: 'aren', companionId: 'koro', runId: 'run-1' });
    expect(seen).toEqual([{ screen: 'map-intro', hold: true, wanted: true }]);
    expect(last(models).screen).toBe('map-intro');
    expect(last(models).scene).toEqual({ regionId: 'canopy', heroName: 'Aren', establishingShot: false });
    expect(last(models).canOpenWorldPanels).toBe(false);
    expect(app.appAudio.calls).toContainEqual(['action', 'select-hero']);
    expect(app.appAudio.calls).toContainEqual(['syncScreen', 'map-intro']);
  });

  it('loads behind the plain loading scene for Play Again without another intro or shot', async () => {
    const replay = entryApp({ screen: 'stage-complete' });
    let seenScreen = '';
    replay.app.prepareWorld = async () => { seenScreen = replay.app.screen; };
    await dispatch(replay.app, { type: 'new-game', runId: 'again' });
    expect([seenScreen, replay.app.mapIntroHold, replay.app.entryShotWanted]).toEqual(['loading', false, false]);
    expect(last(replay.models).scene?.regionId).toBe('canopy');

  });

  for (const [session, scope] of [[CANDIDATE_CHAPTERS_SESSION, 'candidate-chapters'], [PRODUCTION_SESSION, 'production']] as const) {
    it(`${scope}: waits for hero confirmation and Continue restores that hero without a companion gift`, async () => {
      const factory = new FakeIDBFactory() as unknown as IDBFactory;
      const saves = new SaveRepository(factory, { scope });
      await saves.init();
      const director = new CampaignDirector({ saves });
      director.startChapterRun({ runId: 'existing', heroId: 'aren', saveScope: scope });
      await director.autosave();
      const before = await saves.listSlots();
      const { app } = entryApp({
        session, screen: 'title', saves, candidateSaves: scope === 'candidate-chapters' ? saves : null, campaignDirector: director,
        slots: before, campaign: director.snapshot(), prepareWorld: async () => {},
      });
      await dispatch(app, { type: 'new-game', runId: 'not-confirmed' });
      expect(app.screen).toBe('hero-select');
      expect(director.snapshot().runId).toBe('existing');
      expect(await saves.listSlots()).toEqual(before);
      await dispatch(app, { type: 'map-select' });
      expect(app.screen).toBe('title');
      await dispatch(app, { type: 'new-game', runId: 'still-not-confirmed' });
      await dispatch(app, { type: 'select-hero', runId: 'confirmed', heroId: 'sakda', companionId: 'solkar' });
      expect(app.error).toBeNull();
      const reopened = new SaveRepository(factory, { scope });
      await reopened.init();
      const slots = await reopened.listSlots();
      const continued = await new CampaignDirector({ saves: reopened }).load(slots.find(slot => slot.runId === 'confirmed')!.slotId);
      expect(continued).toMatchObject({ runId: 'confirmed', regionId: 'greenwake', chapter: 0, session: { heroId: 'sakda', saveScope: scope } });
      expect(continued.party).toEqual({});
      expect(continued.companions.solkar.recruited).toBe(false);
      expect(slots.some(slot => slot.runId === 'existing')).toBe(true);
    });
  }

  it('maps campaign regions without authored scene art to the prologue scene', () => {
    const { app } = entryApp({ session: PRODUCTION_SESSION, campaign: { regionId: 'sunmane-expanse' } });
    expect(app.sceneModel().regionId).toBe('greenwake');
    app.campaign = { regionId: 'moonpine-ridge' };
    expect(app.sceneModel().regionId).toBe('moonpine');
    app.campaign = null;
    expect(app.sceneModel().regionId).toBe('greenwake');
  });

  it('keeps the intro on screen when the world is ready early; Continue then reveals it with the establishing shot', async () => {
    const { app, policies, models, inputEnabled, renderer } = entryApp({ screen: 'map-intro', mapIntroHold: true, entryShotWanted: true });
    app.loadProgress = new LoadProgress(worldLoadPhases(true));
    app.enterGame();
    expect(app.screen).toBe('map-intro');
    expect(app.entryWaiting).toBe(true);
    expect(renderer.calls).toEqual([]);
    // Nothing else may take the screen while the intro is up.
    app.setScreen('pause');
    expect(app.screen).toBe('map-intro');

    await dispatch(app, { type: 'leave-map-intro' });
    expect(renderer.calls).toEqual(['begin']);
    expect(renderer.shotOptions).toEqual([{ seconds: 4, reducedMotion: false }]);
    expect(app.screen).toBe('game');
    expect(app.entryShot).toBe(true);
    expect(last(policies)).toBe('paused');
    expect(last(inputEnabled)).toBe(false);
    expect(last(models).scene?.establishingShot).toBe(true);
    expect(last(models).canOpenWorldPanels).toBe(false);
  });

  it('shows the loading scene when Continue arrives before the world is ready, then reveals the world when it is', async () => {
    const { app, renderer, models } = entryApp({ screen: 'map-intro', mapIntroHold: true, entryShotWanted: true, loading: { active: true, label: 'Loading', progress: 0.4, operationId: 'region-load' } });
    await dispatch(app, { type: 'leave-map-intro' });
    expect(app.screen).toBe('loading');
    expect(app.mapIntroHold).toBe(false);
    expect(last(models).scene?.regionId).toBe('canopy');
    expect(renderer.calls).toEqual([]);
    app.finishLoad();
    app.enterGame();
    expect(app.screen).toBe('game');
    expect(app.entryShot).toBe(true);
    expect(renderer.calls).toEqual(['begin']);
  });

  it('reveals straight into play when the shot is a no-op (reduced motion) and never pauses the simulation', async () => {
    const { app, renderer, policies } = entryApp({ screen: 'map-intro', mapIntroHold: true, entryShotWanted: true, settings: { ...DEFAULT_GAME_SETTINGS, reducedMotion: true } });
    app.enterGame();
    await dispatch(app, { type: 'leave-map-intro' });
    expect(renderer.shotOptions).toEqual([{ seconds: 4, reducedMotion: true }]);
    expect(app.entryShot).toBe(false);
    expect(app.screen).toBe('game');
    expect(last(policies)).toBe('normal');
  });

  it('turns a failed background load into the loading error screen and drops the intro flow', async () => {
    const { app, models } = entryApp();
    app.prepareWorld = async () => { throw new Error('asset fetch failed'); };
    await dispatch(app, { type: 'select-hero', heroId: 'aren', companionId: 'koro', runId: 'run-2' });
    expect(app.screen).toBe('loading');
    expect(app.mapIntroHold).toBe(false);
    expect(app.entryShotWanted).toBe(false);
    expect(app.loadProgress).toBeNull();
    expect(app.error).toMatchObject({ message: 'asset fetch failed', recoverable: true });
    expect(last(models).screen).toBe('loading');
  });

  it('ignores Continue outside the intro', async () => {
    const { app, renderer } = entryApp({ screen: 'game' });
    await dispatch(app, { type: 'leave-map-intro' });
    expect(app.screen).toBe('game');
    expect(renderer.calls).toEqual([]);
  });
});

describe('establishing shot', () => {
  function shotApp() {
    const fixture = entryApp({ screen: 'map-intro', mapIntroHold: true, entryShotWanted: true });
    fixture.app.enterGame();
    return fixture;
  }

  it('freezes the simulation while the shot runs: only idle animation, the camera sweep and rendering advance', async () => {
    const { app, combat, renderer, inputEnabled } = shotApp();
    await dispatch(app, { type: 'leave-map-intro' });
    Object.assign(globalThis, { document: { hidden: false } });
    app.simulateTick = () => { throw new Error('the simulation must not step during the establishing shot'); };
    const tick = combat.simulationTick;
    renderer.calls.length = 0;
    for (let index = 0; index < 5; index++) app.stepEntryShot(1 / 60);
    expect(combat.simulationTick).toBe(tick);
    expect(renderer.calls.filter(call => call === 'render')).toHaveLength(5);
    expect(renderer.calls.filter(call => call === 'sync')).toHaveLength(5);
    expect(app.entryShot).toBe(true);
    expect(last(inputEnabled)).toBe(false);
  });

  it('hands over to play when the sweep finishes on its own, with the HUD model back', async () => {
    const { app, renderer, policies, models, inputEnabled } = shotApp();
    await dispatch(app, { type: 'leave-map-intro' });
    Object.assign(globalThis, { document: { hidden: false } });
    app.stepEntryShot(1 / 60);
    expect(app.entryShot).toBe(true);
    renderer.shotActive = false;
    app.stepEntryShot(1 / 60);
    expect(app.entryShot).toBe(false);
    expect(last(policies)).toBe('normal');
    expect(last(inputEnabled)).toBe(true);
    expect(last(models).scene).toBeUndefined();
    expect(last(models).canOpenWorldPanels).toBe(true);
    expect(renderer.calls).not.toContain('skip');
  });

  it('skips on request: the camera jumps to gameplay framing and play starts at once', async () => {
    const { app, renderer, policies, inputEnabled } = shotApp();
    await dispatch(app, { type: 'leave-map-intro' });
    await dispatch(app, { type: 'skip-establishing-shot' });
    expect(renderer.calls.filter(call => call === 'skip')).toHaveLength(1);
    expect(app.entryShot).toBe(false);
    expect(app.screen).toBe('game');
    expect(last(policies)).toBe('normal');
    expect(last(inputEnabled)).toBe(true);
    // A second skip with no shot running does nothing.
    await dispatch(app, { type: 'skip-establishing-shot' });
    expect(renderer.calls.filter(call => call === 'skip')).toHaveLength(1);
  });

  it('ends at gameplay framing when the player pauses (window blur) mid-shot', async () => {
    const { app, renderer } = shotApp();
    await dispatch(app, { type: 'leave-map-intro' });
    app.setScreen('pause');
    expect(renderer.calls).toContain('skip');
    expect(app.entryShot).toBe(false);
    expect(app.screen).toBe('pause');
  });

  it('is cancelled when a new run replaces the world', async () => {
    const { app, renderer } = shotApp();
    await dispatch(app, { type: 'leave-map-intro' });
    app.prepareWorld = async () => {};
    app.error = { code: 'application', message: 'retry', recoverable: true };
    await dispatch(app, { type: 'retry-load', operationId: 'region-load' });
    expect(app.entryShot).toBe(false);
    expect(app.entryShotWanted).toBe(false);
    expect(renderer.calls).toContain('skip');
  });
});

describe('truthful world-load progress', () => {
  it('spans the whole preparation and never decreases, whatever order the callbacks report in', () => {
    const { app, models } = entryApp({ screen: 'map-intro', mapIntroHold: true });
    app.loadProgress = new LoadProgress(worldLoadPhases(true));
    app.loading = { active: true, label: 'Loading Whispering Canopy', progress: null, operationId: 'region-load' };
    const reports: { stage: string; phase: string | undefined; progress: number }[] = [];
    const report = (phase: string, within: number) => {
      app.reportLoad(phase, within, 'detail');
      reports.push({ stage: app.loading.detail.stage, phase: app.loading.detail.phaseLabel, progress: app.loading.progress });
    };
    report('manifest', 0); app.loadProgress.complete('manifest');
    for (const ratio of [0, 0.25, 0.6, 0.45, 1, 0.9]) report('assets', ratio);
    app.loadProgress.complete('assets');
    const afterAssets = app.loadProgress.ratio;
    expect(afterAssets).toBeLessThan(0.8);
    for (const phase of ['hero', 'world', 'waystone', 'effects', 'gpu', 'encounter']) { report(phase, 0); app.loadProgress.complete(phase); }
    report('encounter', 1);
    const values = reports.map(entry => entry.progress);
    for (let index = 1; index < values.length; index++) expect(values[index]!).toBeGreaterThanOrEqual(values[index - 1]!);
    expect(values[0]).toBe(0);
    expect(values.at(-1)).toBe(1);
    // Asset loading alone does not read as done: the hero, shader and GPU phases still lie ahead.
    expect(reports.find(entry => entry.stage === 'hero')!.progress).toBeGreaterThan(0.5);
    expect(reports.find(entry => entry.stage === 'hero')!.progress).toBeLessThan(0.8);
    expect(reports.map(entry => entry.phase)).toContain('Warming the GPU');
    expect(new Set(reports.map(entry => entry.stage))).toEqual(new Set(['manifest', 'assets', 'hero', 'world', 'waystone', 'effects', 'gpu', 'encounter']));
    app.render();
    expect(last(models).loading.progress).toBe(1);
  });

  it('starts the world load at 0% on the manifest phase, behind whichever screen the player is on', async () => {
    for (const hold of [true, false]) {
      const { app } = entryApp({ mapIntroHold: hold, screen: hold ? 'map-intro' : 'loading' });
      const { promise: pending } = Promise.withResolvers<never>();
      app.readManifest = () => pending;
      void app.prepareWorld(app.campaign);
      expect(app.screen).toBe(hold ? 'map-intro' : 'loading');
      expect(app.loading).toMatchObject({ active: true, progress: 0, detail: { stage: 'manifest', phaseLabel: 'Checking required native assets' } });
    }
  });

  it('keeps the loading state, at the encounter phase, while the encounter is prepared', () => {
    const { app } = entryApp();
    app.loadProgress = new LoadProgress(worldLoadPhases(true));
    app.loading = { active: true, label: 'Loading Whispering Canopy', progress: 0.9, operationId: 'region-load' };
    app.beginEncounterLoading('Beginning the Whispering Canopy trials');
    expect(app.loading).toMatchObject({ active: true, label: 'Loading Whispering Canopy', detail: { stage: 'encounter', message: 'Beginning the Whispering Canopy trials' } });
    // Without a running preparation (a mid-game encounter) the loading state is indeterminate with its own label.
    app.loadProgress = null;
    app.beginEncounterLoading('Preparing Orun');
    expect(app.loading).toMatchObject({ active: true, label: 'Preparing Orun', progress: null });
  });
});
