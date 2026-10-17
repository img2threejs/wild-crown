import { AudioContext as ThreeAudioContext, AudioListener, Color, Vector3 } from 'three';
import { AppAudio } from '../audio/AppAudio.js';
import type { RestorationState } from '../../packages/campaign/src/index.js';
import { CampaignDirector, CampaignChoiceRejectedError, SaveRepository, SaveRepositoryError, REGIONS, QUESTS, CAMPAIGN_CHOICES, INTERACTIONS, ENVIRONMENT_RECIPES } from '../game/campaign/index.js';
import type { SaveSlotSummary } from '../game/campaign/index.js';
import type { ActionId, ActorId, CampaignSnapshot, ChapterSpatialIntent, CombatSnapshot, CompanionId, CompanionTarget, EnvironmentRecipeDefinition, FieldCommand, GameSettings, GameViewModel, InputBindingMaps, RegionDefinition, RegionId, SaveScope, SceneRegionId, SessionConfig, UIAction, WorldEvent, ActorSnapshot } from '../game/contracts.js';
import { DEFAULT_GAME_SETTINGS, DEFAULT_INPUT_BINDINGS, normalizeInputBindings, isCanonicalKeyboardRemap, validateSessionConfig } from '../game/contracts.js';
import { CombatEngine, COMBAT_ACTION_CLIPS, type CombatEvent, type CombatInput } from '../game/combat/CombatEngine.js';
import { BOSS_ENCOUNTERS, WILDLIFE_ENCOUNTERS } from '../game/combat/content.js';
import { ALL_COMPANION_SKILLS, companionSkillFor, type CompanionSkill } from '../game/companions/CompanionSkills.js';
import { isCompanionId } from '../game/companions/CompanionLoadout.js';
import { ACTORS } from '../content/campaign.js';
import { CHAPTER_RUNTIME, LAYOUT_MIGRATIONS, RELATIONSHIP_RULES } from '../content/chapters.js';
import { mountGameUI, type GameUIInstance, type HeroPreviewController, type TitleStageController } from '../ui/GameUI.js';
import { GameRenderer, mountCompanionPreview, type CompanionPreviewHandle, type PreparedCompanionParty } from '../rendering/GameRenderer.js';
import { mountHeroPreview, type HeroPreviewHandle } from '../rendering/HeroPreview.js';
import { mountTitleStage, type TitleStageHandle } from '../rendering/TitleStage.js';
import { MONSTER_LOCOMOTION } from '../rendering/MonsterAnimationProfiles.js';
import { StoryPresentation } from '../effects/index.js';
import { ENDINGS, STORY_DIALOGUE } from '../content/story.js';
import { HUB_REGION_IDS, HUB_SERVICE_INTERACTION_IDS, HUB_UPGRADES } from '../content/hub.js';
import {
  NARRATIVE_CUES,
  cueForObjective,
  isCueBeatAuthored,
} from '../content/narrative-cues.js';
import { RuntimeInput, type ActionFrame } from '../input/RuntimeInput.js';
import { CommandWheel, WHEEL_COMMANDS, WHEEL_TIME_SCALE } from '../input/CommandWheel.js';
import { DamageNumbers } from '../ui/DamageNumbers.js';
import { BossIntro } from '../ui/BossIntro.js';
import { BOSS_TITLES, bossTitleFromLabel } from '../content/bossTitles.js';
import { StageGoal } from './StageGoal.js';
import { createCombatTrialRegion } from '../game/combat/TrialRegions.js';
import { ASSET_PLAYTESTS } from './AssetPlaytests.js';
import { dueTutorial } from './Tutorials.js';
import { STORY_CHAPTERS } from './StoryChapters.js';
import { heroById, isHeroId, type HeroId } from '../game/heroes.js';
import { browserPlaytestProgress } from './PlaytestProgress.js';
import { MonsterLabels } from '../ui/MonsterLabels.js';
import { CombatReadability } from '../ui/CombatReadability.js';
import { prefersReducedMotion } from '../ui/reduced-motion.js';
import { LoadProgress, type LoadPhaseSpec } from './LoadProgress.js';
import { AssetGateError, PRODUCTION_MANIFEST_URL, assertTrialAssets, fetchManifest, isTerminalAssetError, type Manifest } from './AssetGate.js';
import { assertAssetsForPolicy, loadChapterManifest, loadCompanionManifest, loadHeroKitManifest, regionForHero } from './ChapterAssets.js';
import { projectPartyIntoRegion } from './ChapterParty.js';
import { areaMapOf, chapterActOf, checkpointName, encounterVariantAssets, objectiveHudOf, questLogOf } from './ChapterFlow.js';
import { NURSERY_ESCORT } from '../content/side-quests.js';
import { CANDIDATE_CHAPTERS_SESSION, bannerOf, initialSession, isCandidateSession, sessionKindOf, trialMapOf, trialsSession } from './SessionConfig.js';
import { companionDisplayName, companionProgressOf, partyPanelOf } from './PartyModel.js';
const STEP = 1 / 60;
const MAX_STEPS = 5;
/** Rim hues only (HitFlash normalises colour and caps the rim): red for Aren, warm gold for struck monsters. */
const PLAYER_HIT_RIM = new Color().setRGB(1, 0.1, 0.05);
const ACTOR_HIT_RIM = new Color().setRGB(1, 0.7, 0.25);
/** Length of the camera sweep that reveals a map after its intro. */
const ESTABLISHING_SHOT_SECONDS = 4;
/** Gameplay input while the command wheel is open (and on the frame it closes): nothing reaches the simulation. */
const FROZEN_ACTIONS: ActionFrame = Object.freeze({
    moveX: 0, moveZ: 0, dodgePressed: false, jumpPressed: false, sprintHeld: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false,
    rangedPressed: false, rangedHeld: false, rangedReleased: false, ultimatePressed: false, interactPressed: false, abilityPressed: false, commandWheelPressed: false,
    commandWheelHeld: false, commandWheelReleased: false, wheelAimX: 0, wheelAimY: 0, wheelDigit: null, wheelCancelPressed: false,
    mapPressed: false, journalPressed: false, companionsPressed: false, pausePressed: false,
    lockOnPressed: false, lockOnHeld: false,
});
/**
 * Region scene used by the loading screen for each campaign region. Regions without authored scene art (Sunmane
 * Expanse, Refuge, Heartroot Hollow) use the Greenwake scene, the prologue region.
 */
const SCENE_BY_REGION: Partial<Record<RegionId, SceneRegionId>> = {
    'greenwake': 'greenwake', 'whispering-canopy': 'canopy', 'blood-bamboo-valley': 'bamboo', 'the-grove': 'grove', 'moonpine-ridge': 'moonpine', 'mistveil-basin': 'mistveil',
};
/**
 * Ordered, weighted phases of one world preparation. The weights are the share of the wait each phase is expected to
 * take; the bar only advances when a phase reports real work, so it is monotonic and reaches 100% when the world is ready.
 */
export function worldLoadPhases(playtest: boolean): LoadPhaseSpec[] {
    return [
        { id: 'manifest', label: 'Checking required native assets', weight: 3 },
        { id: 'assets', label: 'Gathering scene assets', weight: 58 },
        { id: 'hero', label: 'Awakening your hero', weight: 7 },
        { id: 'world', label: 'Raising the region', weight: 4 },
        ...(playtest ? [{ id: 'waystone', label: 'Planting the stage waystone', weight: 4 }] : []),
        { id: 'effects', label: 'Compiling effects and shaders', weight: 10 },
        { id: 'gpu', label: 'Warming the GPU', weight: 8 },
        { id: 'encounter', label: playtest ? 'Raising the trial gates' : 'Rousing the forest', weight: 6 },
    ];
}
type Screen = GameViewModel['screen'];
const mountedApplications = new WeakMap<HTMLElement, GameApplication>();
const OVERLAY_SCREENS: readonly Screen[] = ['pause', 'map', 'journal', 'companions', 'hub', 'settings', 'credits'];
/** Screens that share the menu tab bar: moving between them swaps the page, so Back leaves the menu instead of retracing tabs. */
const MENU_TABS: readonly Screen[] = ['map', 'journal', 'companions', 'hub', 'settings'];
const WORLD_PANELS: readonly Screen[] = ['pause', 'map', 'journal', 'companions', 'hub', 'dialogue', 'choice', 'ending', 'stage-complete', 'defeat'];
function endingViewModel(id: NonNullable<CampaignSnapshot['ending']>): NonNullable<GameViewModel['ending']> {
    const ending = ENDINGS[id];
    const lines = id === "living_pact"
      ? ((ENDINGS as Record<string, unknown>).living_pact as { lines?: readonly string[] }).lines ?? []
      : [];
    return { id: ending.id, title: ending.title, summary: ending.summary, grove: ending.grove, lines };
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
export class GameApplication {
    private session: SessionConfig = initialSession(window.location.search, import.meta.env.DEV);
    private readonly playtestProgress = browserPlaytestProgress();
    private selectedHero: HeroId = 'aren';
    private readonly root: HTMLElement;
    private readonly world = document.createElement('div');
    private readonly canvas = document.createElement('canvas');
    private readonly overlay = document.createElement('div');
    private readonly inputHost = document.createElement('div');
    private readonly wheel = new CommandWheel();
    /** How the open wheel was opened: a held key/button closes it on release; a pointer/UI open stays until a sector click or cancel. */
    private wheelOpenedBy: 'hold' | 'pointer' | null = null;
    private wheelCache: { key: string; model: NonNullable<GameViewModel['wheel']> } | null = null;
    private presentingStory = false;
    /** The open choice screen was opened from the Director's pending choice (it closes when that choice is answered), not from an interaction. */
    private choiceFromResume = false;
    /** Greater than zero while an authored transaction (checkpoint, encounter start) is in flight: the simulation pauses, input stays ignored. */
    private worldBusy = 0;
    private storyBusy = false;
    private chapterIntents: ChapterSpatialIntent[] = [];
    private intentRunning = false;
    private choiceNotice: string | null = null;
    private readonly input: RuntimeInput;
    private candidateSaves: SaveRepository | null = null;
    private readonly saves = new SaveRepository(undefined, { scope: 'production', chapters: CHAPTER_RUNTIME, layoutMigrations: LAYOUT_MIGRATIONS });
    private campaignDirector!: CampaignDirector;
    private readonly combat = new CombatEngine();
    private readonly ui: GameUIInstance;
    private readonly damageNumbers: DamageNumbers;
    private readonly monsterLabels: MonsterLabels;
    /** Boss reveal title card; the reveal camera itself lives in the renderer. */
    private readonly bossIntro: BossIntro;
    /** Bosses already introduced in a run (`runId:encounterId[:stage]`), so a checkpoint retry never replays the reveal. */
    private readonly revealedBosses = new Set<string>();
    private readonly combatReadability: CombatReadability;
    private stageGoal: StageGoal | null = null;
    private stageCompleted = false;
    private playerOutcome: 'victory' | 'defeat' | null = null;
    private outcomeElapsed = 0;
    private outcomeSnapshot: CombatSnapshot | null = null;
    private manifestPromise: Promise<Manifest>;
    private campaign: CampaignSnapshot | null = null;
    private settings: GameSettings = { ...DEFAULT_GAME_SETTINGS, heroCompanions: { ...DEFAULT_GAME_SETTINGS.heroCompanions } };
    private bindings: InputBindingMaps = {
        keyboard: { ...DEFAULT_INPUT_BINDINGS.keyboard },
        gamepad: { ...DEFAULT_INPUT_BINDINGS.gamepad },
    };
    private slots: SaveSlotSummary[] = [];
    private pendingNewRunId: string | null = null;
    private pendingLoadSlotId: string | null = null;
    private pendingImportPayload: string | null = null;
    private pendingTravel: { regionId: RegionId; entranceId: string; requestId: string } | null = null;
    private manifest: Manifest = [];
    private renderer: GameRenderer | null = null;
    private presentation: StoryPresentation | null = null;
    private readonly companionPreviews = new Map<CompanionPreviewHandle, HTMLElement>();
    private heroPreview: HeroPreviewHandle | null = null;
    private titleStage: TitleStageHandle | null = null;
    private region: RegionDefinition | null = null;
    private activeCompanionId: CompanionId | undefined;
    private partyChanging = false;
    private screen: Screen = 'title';
    private readonly screenHistory: Screen[] = [];
    private worldReady = false;
    /** Weighted progress of the world preparation in flight; null when no preparation is running. */
    private loadProgress: LoadProgress | null = null;
    /** True while the player reads the map intro: the world prepares in the background and the screen stays 'map-intro'. */
    private mapIntroHold = false;
    /** The map intro was left, or never shown, before the world finished: reveal it with the establishing shot when ready. */
    private entryShotWanted = false;
    /** The world finished preparing while the player was still on the map intro; Continue reveals it immediately. */
    private entryWaiting = false;
    /** True while the establishing camera sweep runs: simulation paused, gameplay input ignored, only Skip works. */
    private entryShot = false;
    private entryShotSnapshot: CombatSnapshot | null = null;
    /** The how-to-play card on screen: the simulation does not step and gameplay input is off until it is dismissed. */
    private tutorial: NonNullable<GameViewModel['tutorial']> | null = null;
    private loading: GameViewModel['loading'] = { active: false, label: '', progress: null };
    private error: GameViewModel['error'] = null;
    private dialogue: GameViewModel['dialogue'] = null;
    private dialogueLineIndex = 0;
    private choice: GameViewModel['choice'] = null;
    private ending: GameViewModel['ending'] = null;
    private interaction: GameViewModel['hud']['interaction'];
    private pendingInteraction: {
        interactionId: string;
        targetId: string;
    } | null = null;
    private pendingAbility: string | null = null;
    private accumulator = 0;
    private previousTime = 0;
    private previousRenderSnapshot: CombatSnapshot | undefined;
    private renderSnapshot: CombatSnapshot | undefined;
    private readonly listenerForward = new Vector3();
    private raf = 0;
    private disposed = false;
    private suspended = false;
    private ready = false;
    private initializationPromise: Promise<void> | null = null;
    private lifecycleGeneration = 0;
    private worldGeneration = 0;
    private activeRunId: string | null = null;
    private durableEvents: Promise<void> = Promise.resolve();
    private pendingWorldEvents: WorldEvent[] = [];
    private failedWorldEvent: WorldEvent | null = null;
    private sceneBlocked = false;
    /**
     * Ordered, in-memory queue of `STORY_DIALOGUE` beat ids the cue scheduler
     * has scheduled from committed campaign snapshot transitions. Each entry
     * is presented one beat at a time, never interrupting the currently
     * displayed beat, and is cleared on `skip-cinematic`, `return-title`, and
     * successful `new-game`, `load`, or `import`. Cues are never generated
     * while restoring existing progress (see {@link primeNarrativeCuesFromTransition}).
     */
    private pendingNarrativeCues: string[] = [];
    /**
     * Snapshot used as the cue diff baseline. `null` means the scheduler has
     * no baseline yet and the next transition seeds it from `prev` without
     * emitting cues; `loadingFromSave` skips cue detection and resets the
     * baseline once load/import completes (see dispatch handlers).
     */
    private lastCueSnapshot: CampaignSnapshot | null = null;
    /**
     * `true` while `CampaignDirector.load` / `importSave` publishes its
     * checkpoint-restore snapshots. This suppresses cue detection until the
     * loaded snapshot resets the baseline in the dispatch handler.
     */
    private loadingFromSave = false;
    private unsubscribe: (() => void) | null = null;
    /** Title score, UI sounds and region-mixer forwarding; shares three's audio context with the world listener. */
    private readonly appAudio = new AppAudio({ acquireContext: () => ThreeAudioContext.getContext() as AudioContext });
    private readonly onUserGesture = () => { void this.appAudio.unlock(); void this.presentation?.unlockAudio(); };
    constructor(root: HTMLElement) {
        this.root = root;
        mountedApplications.get(root)?.dispose();
        mountedApplications.set(root, this);
        this.combat.setTimePolicy('paused');
        root.replaceChildren();
        root.classList.add('wc-app');
        this.world.className = 'wc-world';
        this.world.setAttribute('aria-hidden', 'true');
        this.canvas.className = 'wc-world__canvas';
        this.canvas.setAttribute('aria-label', 'Wild Crown three-dimensional world');
        this.world.append(this.canvas);
        this.overlay.className = 'wc-overlay';
        this.inputHost.className = 'wc-input-host';
        this.inputHost.tabIndex = 0;
        this.inputHost.setAttribute('aria-label', 'Game input focus');
        root.append(this.world, this.overlay);
        this.updateBanner();
        this.overlay.append(this.inputHost);
        this.input = new RuntimeInput(this.inputHost);
        this.ui = mountGameUI(this.overlay, { onAction: action => { void this.dispatch(action); }, onPreviewHost: (host, id) => this.preview(host, id), onHeroPreviewHost: host => this.mountHeroPreviewHost(host), onTitleStageHost: host => this.mountTitleStageHost(host) });
        this.damageNumbers = new DamageNumbers(this.overlay);
        this.monsterLabels = new MonsterLabels(this.overlay);
        this.bossIntro = new BossIntro(this.overlay);
        this.combatReadability = new CombatReadability(this.overlay);
        this.manifestPromise = this.readManifest();
        void this.manifestPromise.catch(() => undefined);
        this.bindDirector();
        this.overlay.addEventListener('pointerdown', this.onUserGesture);
        this.overlay.addEventListener('keydown', this.onUserGesture);
        window.addEventListener('pagehide', this.onPageHide);
        window.addEventListener('pageshow', this.onPageShow);
        window.addEventListener('blur', this.onBlur);
        document.addEventListener('visibilitychange', this.onVisibility);
        this.raf = requestAnimationFrame(this.frame);
        this.appAudio.setSettings(this.settings);
        this.initializationPromise = this.initialize();
        this.render();
    }
    private isLifecycleCurrent(generation: number): boolean {
        return !this.disposed && generation === this.lifecycleGeneration;
    }
    private beginWorldGeneration(): number {
        this.worldGeneration++;
        return this.worldGeneration;
    }
    private isWorldGenerationCurrent(generation: number, lifecycle = this.lifecycleGeneration): boolean {
        return this.isLifecycleCurrent(lifecycle) && generation === this.worldGeneration;
    }
    private async initialize(): Promise<void> {
        const generation = this.lifecycleGeneration;
        try {
            await this.saves.init();
            if (!this.isLifecycleCurrent(generation)) { this.saves.close(); return; }
            const data = await this.saves.loadSettings();
            if (!this.isLifecycleCurrent(generation)) return;
            if (data) {
                this.settings = { ...DEFAULT_GAME_SETTINGS, ...data.settings };
                this.appAudio.setSettings(this.settings);
                this.bindings = normalizeInputBindings({
                    keyboard: { ...data.bindings.keyboard },
                    gamepad: { ...data.bindings.gamepad },
                });
            }
            if (this.session.kind === 'chapters' && this.session.saveScope === 'candidate-chapters') await this.scopeSaves('candidate-chapters').init();
            this.slots = this.activeSaves ? await this.activeSaves.listSlots() : [];
            if (!this.isLifecycleCurrent(generation)) return;
            this.input.setDeadzone(this.settings.gamepadDeadzone);
            this.combat.setAccessibilitySettings(this.settings);
            this.combatReadability.setSettings(this.settings);
            this.applyBindings();
            this.ready = true;
            this.enterInitialMode();
            this.render();
        } catch (error) {
            if (!this.isLifecycleCurrent(generation)) return;
            this.error = { code: error instanceof SaveRepositoryError ? error.code : 'save-init', message: errorText(error), recoverable: true };
            this.render();
        }
    }
    /** The catalog previews read before any region loads: the Trials map's manifest, the candidate hero kits, or the public production manifest. */
    private async readManifest(): Promise<Manifest> {
        const trial = trialMapOf(this.session);
        if (trial) return fetchManifest(trial.manifestUrl, trial.manifestLabel);
        if (this.session.assets === 'candidate') return loadHeroKitManifest('candidate');
        return fetchManifest(PRODUCTION_MANIFEST_URL, 'Required public asset manifest');
    }
    /** Screen shown while the world prepares: the map intro keeps the player's screen while it loads in the background. */
    private loadingScreen(): Screen { return this.mapIntroHold ? 'map-intro' : 'loading'; }
    /** Records real progress of the world preparation in flight; the caller renders. */
    private reportLoad(phaseId: string, within: number, message: string): void {
        const tracker = this.loadProgress;
        if (!tracker) return;
        const ratio = tracker.report(phaseId, within);
        this.loading = { active: true, label: this.loading.label, progress: ratio, operationId: 'region-load', detail: { stage: phaseId, phaseLabel: tracker.labelOf(phaseId), message } };
    }
    /** Starts a phase and lets the browser paint it before the next synchronous stretch of work blocks the main thread. */
    private async beginLoadPhase(phaseId: string, message: string): Promise<void> {
        this.reportLoad(phaseId, 0, message);
        this.render();
        // Resolves on the next frame, or after 50 ms when the tab is hidden and frames never come.
        await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, 50);
            requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
        });
    }
    private finishLoad(): void {
        this.loadProgress = null;
        this.loading = { active: false, label: '', progress: null };
    }
    private async prepareWorld(snapshot: CampaignSnapshot, generation = this.beginWorldGeneration()): Promise<void> {
        const lifecycleGeneration = this.lifecycleGeneration;
        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        this.releaseWorld();
        this.pendingInteraction = null;
        this.pendingAbility = null;
        this.input.clear();
        const trial = trialMapOf(this.session);
        // A chapter run's hero is part of its saved session and never changes; Trials use the hero chosen at select.
        const heroId = this.session.kind === 'chapters' ? snapshot.session.heroId : this.selectedHero;
        this.selectedHero = heroId;
        this.screen = this.loadingScreen();
        this.combat.setTimePolicy('paused');
        this.loadProgress = new LoadProgress(worldLoadPhases(trial !== null));
        this.loading = { active: true, label: 'Checking required native assets', progress: null, operationId: 'region-load' };
        this.reportLoad('manifest', 0, 'Reading the manifest and confirming the forest\'s required native assets.');
        this.error = null;
        this.render();
        const authoredRegion = REGIONS.find(item => item.id === snapshot.regionId);
        if (!authoredRegion) throw new AssetGateError('No authored region definition for ' + snapshot.regionId + '.');
        const playable = trial ? createCombatTrialRegion(authoredRegion, heroId) : regionForHero(authoredRegion, heroId);
        // Grove's stationary lookout is a separate canonical actor, even though it shares Koro's native geometry.
        const region = trial && playable.id === 'the-grove' ? {
            ...playable,
            entities: playable.entities.map(entity => entity.actorId === 'grove-koro' ? { ...entity, assetId: 'actor-grove-koro-lookout' } : entity),
            assetIds: playable.assetIds.map(id => id === 'actor-koro' ? 'actor-grove-koro-lookout' : id),
        } : playable;
        const authoredRecipe = ENVIRONMENT_RECIPES.find(item => item.id === region.environmentRecipeId);
        if (!authoredRecipe) throw new AssetGateError('No authored environment recipe for ' + region.id + '.');
        const recipe = region === authoredRegion ? authoredRecipe : { ...authoredRecipe, assetPlacementIds: region.props.map(prop => prop.id), groundSurfaceIds: region.ground.surfaces.map(surface => surface.id) };
        // Traveling allies are independent instances; narrative counterparts remain authored story actors.
        const safeSpawn = snapshot.lastSafeCheckpoint?.safeSpawn.regionId === region.id ? snapshot.lastSafeCheckpoint.safeSpawn : null;
        const partyProjection = projectPartyIntoRegion({
            region, party: snapshot.party, companions: snapshot.companions, worldFacts: snapshot.worldFacts,
            spawnPosition: safeSpawn?.position ?? null,
        });
        const enrichedRegion: RegionDefinition = partyProjection.entities.length
          ? { ...region, entities: [...region.entities, ...partyProjection.entities], assetIds: region.assetIds ? [...new Set([...region.assetIds, ...partyProjection.assetIds])] : region.assetIds }
          : region;
        const manifest = await this.loadWorldManifest(enrichedRegion, heroId, partyProjection.assetIds);
        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        this.manifestPromise = Promise.resolve(manifest);
        this.manifest = manifest;
        this.region = enrichedRegion;
        this.assertAssets(enrichedRegion, manifest, recipe, heroId);
        const candidate = isCandidateSession(this.session);
        if (!this.renderer)
            this.renderer = new GameRenderer({ canvas: this.canvas, allowMissingActionClips: candidate, simplifyBlockedPlaytestGeometry: candidate });
        this.renderer.setSettings(this.settings);
        this.loadProgress.complete('manifest');
        this.loading = { active: true, label: 'Loading ' + enrichedRegion.name, progress: null, operationId: 'region-load' };
        this.reportLoad('assets', 0, 'Preparing the forest...');
        this.render();
        await this.renderer.loadRegion(enrichedRegion, manifest, recipe, progress => {
            if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
            const total = Math.max(0, progress.total);
            const completed = Math.max(0, Math.min(progress.completed, total));
            this.reportLoad('assets', progress.ratio, total > 0 ? `Loaded ${completed} of ${total} scene assets` : 'Preparing the forest...');
            this.render();
        });
        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        this.loadProgress.complete('assets');
        await this.beginLoadPhase('hero', 'Loading ' + heroById(heroId).name + '.');
        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        await this.renderer.setPlayerHero(heroId);
        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        this.loadProgress.complete('hero');
        await this.beginLoadPhase('world', 'Placing actors, colliders and story state.');
        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        this.syncWorldFacts();
        const visibleActorEntities = enrichedRegion.entities.filter(entity => entity.actorId && (!entity.visibleWhen || snapshot.worldFacts[entity.visibleWhen] === true));
        const present = visibleActorEntities.map(entity => entity.id);
        const companionId = snapshot.party.companionId;
        if (companionId && !visibleActorEntities.some(entity => entity.id.includes('__party_') && entity.actorId === companionId))
            throw new AssetGateError('Selected companion ' + companionId + ' has no visible traveling instance.');
        this.activeCompanionId = companionId;
        // Chapter runs spawn at the Director's safe spawn of this region (arrival, checkpoint or retry), never at an app-chosen point.
        const spawn = this.session.kind === 'chapters' && safeSpawn ? safeSpawn.position : undefined;
        this.combat.loadRegion({
            regionId: region.id, regionDefinition: enrichedRegion, runId: snapshot.runId, presentActorIds: present, companionId, chapter: snapshot.chapter,
            wardenCall: snapshot.worldFacts.wardenCall === true, dominionUsed: snapshot.campaign.dominionHistory.length > 0, worldFacts: snapshot.worldFacts,
            eventKeys: this.campaignDirector.committedEventKeys(),
            ...(spawn ? { playerPosition: spawn } : {}),
            ...(this.session.kind === 'chapters' ? { chapterRuntime: this.campaignDirector.chapterDefinition(), companionProgress: snapshot.companions } : {}),
        });
        this.combat.setPlayerHero(heroId);
        this.combat.setSceneColliders(this.renderer.getNativeSolidColliders(), this.renderer.getNativeSupportFields());
        const initialCombatSnapshot = this.combat.snapshot();
        this.renderer.sync(initialCombatSnapshot.actors, initialCombatSnapshot, 0);
        this.combat.setTimePolicy('paused');
        this.refreshInteraction();
        this.presentation?.dispose();
        this.presentation = null;
        const listener = new AudioListener();
        this.renderer.camera.add(listener);
        this.presentation = new StoryPresentation({
            scene: this.renderer.scene,
            resolveSocket: (actor, socket) => this.renderer?.resolveSocket(actor, socket),
            resolveActorRoot: actor => this.renderer?.resolveActorRoot(actor),
            impact: {
                shake: (amplitude, duration, frequency) => this.renderer?.addCameraShake(amplitude, duration, frequency),
                flashActor: (actor, color, intensity, duration, mode) => this.renderer?.flashActor(actor, color, intensity, duration, mode),
                impulse: (strength, seconds) => this.renderer?.addScreenImpulse(strength, seconds),
            },
            audioListener: listener, reducedEffects: this.settings.reducedMotion,
        });
        this.presentation.setSettings(this.settings);
        this.appAudio.attachRegion(this.presentation.audio);
        void this.presentation.unlockAudio();
        this.presentation.startBiomeAmbience(region.id);
        this.syncStoryState();
        this.loadProgress.complete('world');
        if (trial) {
            const exitId = trial.exitRouteId;
            const exit = region.exits.find(route => route.id === exitId);
            if (!exit) throw new Error(trial.name + ' playtest requires its authored exit ' + exitId + '.');
            this.stageGoal = new StageGoal(exit.from);
            await this.beginLoadPhase('waystone', 'Planting the stage waystone.');
            if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
            await this.renderer.prepareWaystone(this.stageGoal.position, this.stageGoal.pillarPosition(region, this.renderer.getInputBasis().right));
            if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
            this.loadProgress.complete('waystone');
        }
        await this.beginLoadPhase('effects', 'Compiling effect and character shaders.');
        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        this.renderer.prewarm([this.presentation.effects.group]);
        // Compile the cleanse-dissolve shell program once against the real trial monster rigs so the first cleanse never hitches.
        const monsterRoots = (trial?.trialSet.trials ?? []).map(stage => this.renderer!.resolveActorRoot(stage.monsterId)).filter((root): root is NonNullable<typeof root> => root !== undefined);
        if (trial && monsterRoots.length) this.presentation.effects.warden.dissolve.prewarm(monsterRoots, () => this.renderer!.prewarm(monsterRoots));
        this.loadProgress.complete('effects');
        await this.beginLoadPhase('gpu', 'Uploading textures and warming the render pipeline.');
        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        this.renderer.warmGpu();
        this.renderer.render();
        this.loadProgress.complete('gpu');
        this.sceneBlocked = false;
        this.worldReady = true;
        this.screenHistory.length = 0;
        // The story queue and any pending choice are presented from the Director's durable resume state once the world is revealed.
        this.dialogue = null;
        this.dialogueLineIndex = 0;
        this.choice = null;
        await this.startOrunEncounterIfReady(generation);
        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        if (trial) await this.startWildlifeEncounterIfReady();
        else if (this.session.kind === 'chapters') await this.resumeChapterEncounter(snapshot, generation);
        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        // No encounter belongs to this region: the world is ready as it stands.
        if (this.loadProgress) {
            this.finishLoad();
            this.enterGame();
        }
    }
    /** The manifest this session's region loads: the strict candidate projection for Candidate Chapters, else the session's catalog. */
    private async loadWorldManifest(region: RegionDefinition, heroId: HeroId, partyAssetIds: readonly string[] = []): Promise<Manifest> {
        if (this.session.kind === 'chapters' && this.session.assets === 'candidate') {
            return loadChapterManifest(region, 'candidate', heroId);
        }
        const all = await this.readManifest();
        const npc = this.session.kind === 'trials' ? heroById(heroId).npcActorId : undefined;
        const base = (npc ? all.filter(entry => entry.actorId !== npc) : all).map(entry =>
            this.session.kind === 'trials' && region.id === 'the-grove' && entry.actorId === 'grove-koro'
                ? { ...entry, id: 'actor-grove-koro-lookout' } : entry);
        if (this.session.kind !== 'trials') return base;
        const companions = await loadCompanionManifest(this.session.assets);
        const ids = new Set(partyAssetIds);
        const merged = new Map(base.map(entry => [entry.id, entry]));
        for (const entry of companions) if (ids.has(entry.id)) merged.set(entry.id, entry);
        return [...merged.values()];
    }
    /**
     * The world is prepared and its encounter, if any, is running paused. While the player still reads the map intro the
     * reveal waits for Continue; otherwise the world is revealed, with the establishing shot after a map intro.
     */
    private enterGame(): void {
        if (this.mapIntroHold) {
            this.entryWaiting = true;
            this.render();
            return;
        }
        this.revealWorld();
    }
    private revealWorld(): void {
        const wantShot = this.entryShotWanted;
        this.entryShotWanted = false;
        if (wantShot && this.renderer && this.canPlayWorld()) {
            this.renderer.beginEstablishingShot({ seconds: ESTABLISHING_SHOT_SECONDS, reducedMotion: this.settings.reducedMotion || prefersReducedMotion() });
            this.entryShot = this.renderer.establishingShotActive;
            this.entryShotSnapshot = this.entryShot ? this.combat.snapshot() : null;
        }
        this.screen = 'game';
        this.combat.setTimePolicy(this.entryShot ? 'paused' : 'normal');
        this.render();
    }
    /** Leaves the establishing shot, jumping the camera to gameplay framing when `skip` is set. Callers render. */
    private endEntryShot(skip: boolean): void {
        if (this.entryShot && skip) this.renderer?.skipEstablishingShot();
        this.entryShot = false;
        this.entryShotSnapshot = null;
    }
    /** The shot is over: gameplay starts and the HUD fades in. */
    private finishEntryShot(skip: boolean): void {
        this.endEntryShot(skip);
        this.accumulator = 0;
        this.combat.setTimePolicy('normal');
        this.render();
    }
    /** Map intro, pending reveal and shot all end together whenever a new run, map or title replaces the world. */
    private resetEntryFlow(): void {
        this.mapIntroHold = false;
        this.entryWaiting = false;
        this.entryShotWanted = false;
        this.endEntryShot(true);
    }
    private async startOrunEncounterIfReady(generation = this.worldGeneration): Promise<void> {
        const lifecycleGeneration = this.lifecycleGeneration;
        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        // The Director owns the active encounter. The opportunistic legacy `orun-the-hollow-king` active-quest check
        // is gone: Hollow must be entered through the authored `hollow-pre-orun` checkpoint / `beginChapterEncounter`
        // path, never by the app inventing an encounter in this region.
        const activeEncounterId = this.campaign?.session.resume.activeEncounterId;
        if (!this.campaign || !this.region || !this.renderer) return;
        if (this.region.id !== 'heartroot-hollow') return;
        if (!activeEncounterId || this.combat.snapshot().encounterId === activeEncounterId) return;
        await this.startChapterEncounter(activeEncounterId, generation);
    }
    /** Trials only: the map's wildlife encounter hosts the trial gates. Chapters start encounters through authored entry intents. */
    private async startWildlifeEncounterIfReady(): Promise<void> {
        const generation = this.worldGeneration, lifecycleGeneration = this.lifecycleGeneration;
        const playtest = trialMapOf(this.session);
        if (!playtest || !this.campaign || !this.region || this.region.id !== playtest.regionId) {
            if (this.screen === 'dialogue')
                this.setScreen('game');
            return;
        }
        const encounterId = playtest.trialSet.encounterId;
        if (this.combat.snapshot().encounterId === encounterId && this.combat.snapshot().encounterStatus?.trial) {
            this.setScreen('game');
            return;
        }
        this.input.clear();
        this.screen = this.loadingScreen();
        this.combat.setTimePolicy('paused');
        this.beginEncounterLoading(playtest.loadingLabel);
        this.render();
        this.combat.startEncounter({ encounterId, regionId: playtest.regionId, runId: this.campaign.runId, companionId: this.activeCompanionId });
        await this.renderer!.prepareCombatTrialGates();
        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        this.combat.enableCombatTrials();
        const combatSnapshot = this.combat.snapshot();
        this.renderer?.sync(combatSnapshot.actors, combatSnapshot, 0);
        this.renderer?.render();
        this.combat.setTimePolicy('paused');
        this.loadProgress?.complete('encounter');
        this.finishLoad();
        this.enterGame();
    }
    /**
     * Starts one authored chapter encounter: the boss body variants it needs are loaded first, then the engine begins the
     * encounter from the region's placed participants. The Director has already committed the pre-fight checkpoint.
     */
    private async startChapterEncounter(encounterId: string, generation: number): Promise<void> {
        const lifecycleGeneration = this.lifecycleGeneration;
        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        if (!this.campaign || !this.region || !this.renderer) return;
        if (this.combat.snapshot().encounterId === encounterId) return;
        this.cancelWheel();
        this.input.clear();
        this.screen = this.loadingScreen();
        this.combat.setTimePolicy('paused');
        this.beginEncounterLoading('Preparing the encounter');
        this.render();
        for (const variant of encounterVariantAssets(encounterId)) {
            await this.renderer.preloadActorVariant(variant.actorId, variant.assetId, this.manifest);
            if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        }
        this.combat.startEncounter({ encounterId, regionId: this.region.id, runId: this.campaign.runId, companionId: this.activeCompanionId, worldFacts: this.campaign.worldFacts });
        this.combat.setTimePolicy('paused');
        const combatSnapshot = this.combat.snapshot();
        this.renderer.sync(combatSnapshot.actors, combatSnapshot, 0);
        this.renderer.render();
        this.loadProgress?.complete('encounter');
        this.finishLoad();
        this.enterGame();
    }
    /** A saved or restored run resumes its unresolved encounter from its entry (the pre-fight checkpoint the Director holds). */
    private async resumeChapterEncounter(snapshot: CampaignSnapshot, generation: number): Promise<void> {
        const encounterId = snapshot.session.resume.activeEncounterId;
        if (!encounterId || !this.region) return;
        const definition = BOSS_ENCOUNTERS[encounterId] ?? WILDLIFE_ENCOUNTERS[encounterId];
        if (!definition || definition.regionId !== this.region.id) return;
        await this.startChapterEncounter(encounterId, generation);
    }
    /** Encounter preparation is the last phase of the world load when one is running; otherwise an indeterminate loading state. */
    private beginEncounterLoading(message: string): void {
        if (this.loadProgress?.has('encounter')) this.reportLoad('encounter', 0, message);
        else this.loading = { active: true, label: message, progress: null, operationId: 'region-load' };
    }
    /**
     * Pushes authored narrative beats into the cue queue when a committed
     * campaign snapshot adds a new active quest, completes an active quest,
     * or completes a configured objective. Idempotent snapshots, identical
     * baseline transitions, and load/import of already-existing progress
     * never replay cues.
     */
    private primeNarrativeCuesFromTransition(prev: CampaignSnapshot | null, next: CampaignSnapshot): void {
        // Chapter sessions present story from the Director's durable resume state, never from this transition scheduler.
        if (this.session.kind === 'chapters') {
            this.lastCueSnapshot = next;
            return;
        }
        if (this.loadingFromSave) {
            this.lastCueSnapshot = next;
            return;
        }
        const baseline = this.lastCueSnapshot ?? prev;
        if (!baseline || baseline.runId !== next.runId) {
            this.lastCueSnapshot = next;
            return;
        }
        for (const objectiveId of next.completedObjectiveIds) {
            if (baseline.completedObjectiveIds.includes(objectiveId)) continue;
            const owner = this.findQuestOwningObjective(next, objectiveId);
            if (!owner) continue;
            const beat = cueForObjective(owner, objectiveId);
            if (beat) this.enqueueNarrativeCue(beat);
        }
        for (const questId of next.completedQuestIds) {
            if (baseline.completedQuestIds.includes(questId)) continue;
            const beat = NARRATIVE_CUES[questId]?.onComplete;
            if (beat) this.enqueueNarrativeCue(beat);
        }
        for (const questId of next.activeQuestIds) {
            if (baseline.activeQuestIds.includes(questId)) continue;
            const beat = NARRATIVE_CUES[questId]?.onActivate;
            if (beat) this.enqueueNarrativeCue(beat);
        }
        this.lastCueSnapshot = next;
    }
    private enqueueNarrativeCue(beatId: string): void {
        if (!isCueBeatAuthored(beatId)) return;
        this.pendingNarrativeCues.push(beatId);
    }
    /**
     * Locates the quest that owns a completed objective id, used to resolve
     * an objective-completion cue against the right quest key. Iterates the
     * snapshot's active and completed quest id arrays directly because the
     * owning quest can have just transitioned from active to completed in
     * the same snapshot.
     */
    private findQuestOwningObjective(snapshot: CampaignSnapshot, objectiveId: string): string | null {
        for (const questId of snapshot.activeQuestIds) {
            const quest = QUESTS.find(candidate => candidate.id === questId);
            if (quest && quest.objectives.some(objective => objective.id === objectiveId)) return questId;
        }
        for (const questId of snapshot.completedQuestIds) {
            const quest = QUESTS.find(candidate => candidate.id === questId);
            if (quest && quest.objectives.some(objective => objective.id === objectiveId)) return questId;
        }
        return null;
    }
    /**
     * Presents the next queued cue beat when no beat is currently displayed.
     * Resolves authored beat ids through `STORY_DIALOGUE` (which includes
     * `DIALOGUE` and `ADDITIONAL_DIALOGUE`) so optional quest beats that
     * live only in additional connective dialogue still resolve at runtime.
     * Honors the "never interrupt a currently displayed beat" invariant and
     * the "skip must clear the queue and continue safely" invariant.
     */
    private maybePresentNextNarrativeCue(): void {
        if (this.dialogue || !this.pendingNarrativeCues.length) return;
        if (!this.canPresentNarrativeCueNow()) return;
        const nextBeatId = this.pendingNarrativeCues.shift()!;
        const beat = STORY_DIALOGUE[nextBeatId] ?? null;
        if (!beat) {
            this.maybePresentNextNarrativeCue();
            return;
        }
        this.dialogue = beat;
        this.dialogueLineIndex = 0;
        this.choice = null;
        this.setScreen('dialogue');
    }
    /**
     * Defer presentation until the world is fully prepared and the active
     * region matches the campaign snapshot; otherwise a region-transition
     * event from the same committed snapshot would consume a cue before the
     * new region finishes loading and leave an invisible queued beat.
     */
    private canPresentNarrativeCueNow(): boolean {
        if (this.loading.active || this.sceneBlocked) return false;
        if (!this.worldReady || !this.region || !this.campaign) return false;
        if (this.region.id !== this.campaign.regionId) return false;
        if (this.screen !== 'game' && this.screen !== 'dialogue') return false;
        return true;
    }
    private clearNarrativeCueQueue(): void {
        this.pendingNarrativeCues.length = 0;
    }
    /** The asset gate of the current session for one region: production verified, Trials' exact candidate catalog, or the strict candidate-chapter projection. */
    private assertAssets(region: RegionDefinition, manifest: Manifest, recipe: EnvironmentRecipeDefinition, heroId: HeroId = this.selectedHero): void {
        const trial = trialMapOf(this.session);
        if (trial) assertTrialAssets(region, manifest, recipe, trial);
        else assertAssetsForPolicy(this.session.assets, region, manifest, recipe, heroId);
    }
    private preview(host: HTMLElement, id: string | null): () => void {
        if (!id) return () => host.replaceChildren();
        let canceled = false;
        let handle: CompanionPreviewHandle | null = null;
        const disposeHandle = () => {
            if (!handle) return;
            this.companionPreviews.delete(handle);
            handle.dispose();
            handle = null;
        };
        void loadCompanionManifest(this.session.assets).then(assets => {
            const idleActionId = this.session.assets === 'candidate' && MONSTER_LOCOMOTION['actor-' + id]
                ? 'monster-idle' as ActionId : COMBAT_ACTION_CLIPS[`${id}-idle`];
            if (!idleActionId) throw new Error(`No exact idle action mapping exists for companion '${id}'.`);
            return mountCompanionPreview(host, id, assets, { idleActionId, loader: this.renderer?.assetLoader ?? undefined, allowCandidateActions: this.session.assets === 'candidate', reducedEffects: this.settings.reducedMotion });
        }).then(preview => {
            if (canceled || this.disposed || !host.isConnected) {
                preview.dispose();
                return;
            }
            handle = preview;
            this.companionPreviews.set(preview, host);
        }).catch(error => {
            if (canceled || this.disposed || !host.isConnected) return;
            host.replaceChildren();
            const status = document.createElement('p');
            status.className = 'wc-preview-error';
            status.setAttribute('role', 'status');
            status.textContent = errorText(error);
            host.append(status);
        });
        return () => {
            canceled = true;
            disposeHandle();
        };
    }
    /** Hero-select assets stay preview-only: candidate pedestals never enter world catalogs or the verified gate. */
    private mountHeroPreviewHost(host: HTMLElement): HeroPreviewController {
        let handle: HeroPreviewHandle | null = null;
        let canceled = false;
        let shown: HeroId | null = null;
        void Promise.all([
            this.manifestPromise,
            this.session.assets === 'candidate'
                ? fetchManifest('/asset-source/playtests/hero-pedestals.json', 'Candidate hero pedestal manifest')
                : Promise.resolve([]),
        ]).then(([assets, pedestals]) => {
            if (canceled || this.disposed || !host.isConnected) return;
            handle = mountHeroPreview(host, [...assets, ...pedestals], { reducedMotion: this.settings.reducedMotion, motionBlur: this.settings.motionBlur });
            this.heroPreview = handle;
            if (shown) handle.show(shown);
        }).catch((error: unknown) => {
            if (canceled || this.disposed) return;
            const status = host.querySelector<HTMLElement>('[data-preview-placeholder]');
            if (status) status.textContent = errorText(error);
        });
        return {
            show: heroId => { shown = heroId; handle?.show(heroId); },
            showcase: actionIds => handle?.showcase(actionIds),
            dispose: () => {
                canceled = true;
                if (handle && this.heroPreview === handle) this.heroPreview = null;
                handle?.dispose();
                handle = null;
            },
        };
    }
    /**
     * Title diorama: mounts once the candidate manifest is read. Until then (or without WebGL) the title keeps its painted
     * fallback; a manifest failure leaves that fallback in place rather than printing an error over the title.
     */
    private mountTitleStageHost(host: HTMLElement): TitleStageController {
        let handle: TitleStageHandle | null = null;
        let canceled = false;
        void this.manifestPromise.then(assets => {
            if (canceled || this.disposed || !host.isConnected) return;
            handle = mountTitleStage(host, { assets, reducedMotion: this.settings.reducedMotion });
            this.titleStage = handle;
        }).catch(() => undefined);
        return {
            update: dt => { handle?.stage.update(dt); },
            dispose: () => {
                canceled = true;
                if (handle && this.titleStage === handle) this.titleStage = null;
                handle?.dispose();
                handle = null;
            },
        };
    }
    private disposeCompanionPreviews(): void {
        for (const handle of this.companionPreviews.keys()) handle.dispose();
        this.companionPreviews.clear();
    }
    private async dispatch(action: UIAction): Promise<void> {
        let requestedCompanion: CompanionId | undefined;
        if (this.disposed || this.partyChanging)
            return;
        this.appAudio.action(action.type);
        if (action.type === 'retry-load' && this.error?.recoverable === false) return;
        // The map intro is the entry through hero select only; Play Again, Try Again and retries load behind the loading scene.
        let enterThroughIntro = false;
        if (action.type === 'wheel') { this.handleWheelAction(action); return; }
        if (action.type === 'enter-mode') { await this.enterMode(action.mode); return; }
        if (action.type === 'begin-journey') {
            if (this.screen === 'chapters-menu' && this.session.kind === 'chapters' && this.session.assets === 'candidate') this.setScreen('hero-select');
            return;
        }
        // Returning from Trials restores the playable campaign and its browser save list.
        if (action.type === 'return-title' && this.session.kind === 'trials') await this.useSession(CANDIDATE_CHAPTERS_SESSION);
        if (action.type === 'new-game' && this.screen === 'title' && this.session.kind === 'chapters' && this.session.assets === 'candidate') {
            this.setScreen('hero-select');
            return;
        }
        const trial = trialMapOf(this.session);
        if (trial) {
            if (action.type === 'map-select') {
                if (!['stage-complete', 'defeat', 'hero-select', 'map-select'].includes(this.screen)) return;
                this.beginWorldGeneration();
                this.resetEntryFlow();
                this.releaseWorld();
                this.error = null;
                this.setScreen('map-select');
                return;
            }
            if (action.type === 'select-map') {
                if (!['map-select', 'stage-complete'].includes(this.screen) || !this.playtestProgress.isUnlocked(action.mapId)) return;
                const mapId = action.mapId;
                const map = ASSET_PLAYTESTS.find(candidate => candidate.id === mapId);
                if (!map) return;
                this.beginWorldGeneration();
                this.resetEntryFlow();
                this.releaseWorld();
                this.session = trialsSession(map.id);
                this.updateBanner();
                this.error = null;
                this.setScreen('hero-select');
                return;
            }
            if (action.type === 'select-hero') {
                if (this.screen !== 'hero-select' || !isHeroId(action.heroId) || !isCompanionId(action.companionId) || !this.playtestProgress.isUnlocked(trial.id)) return;
                this.selectedHero = action.heroId;
                requestedCompanion = action.companionId;
                enterThroughIntro = true;
                action = { type: 'new-game', runId: action.runId };
            } else if (action.type === 'new-game' && !['stage-complete', 'defeat', 'loading'].includes(this.screen)) return;
            // Campaign saves are separate from local map/hero runs.
            if (['continue', 'load', 'import', 'travel', 'save', 'create-save-slot', 'retry-checkpoint'].includes(action.type)) return;
        } else if (action.type === 'select-map') return;
        else if (action.type === 'select-hero') {
            if (this.screen !== 'hero-select' || !isHeroId(action.heroId) || !isCompanionId(action.companionId) || this.session.assets !== 'candidate') return;
            this.selectedHero = action.heroId;
            requestedCompanion = action.companionId;
            enterThroughIntro = true;
            action = { type: 'new-game', runId: action.runId };
        } else if (action.type === 'map-select') {
            if (this.screen === 'hero-select') this.setScreen('title');
            return;
        } else if (action.type === 'new-game' && this.session.assets === 'candidate' && this.pendingNewRunId !== action.runId) return;
        if (this.playerOutcome && action.type !== 'new-game' && action.type !== 'return-title' && action.type !== 'retry-checkpoint') return;
        if (this.failedWorldEvent) {
            const retryingEvent = action.type === 'retry-load' && action.operationId === 'durable-event';
            const replacingWorld = action.type === 'new-game' || action.type === 'continue' || action.type === 'load' || action.type === 'return-title';
            if (!retryingEvent && !replacingWorld) return;
        }
        const lifecycleGeneration = this.lifecycleGeneration;
        const supersedesWorld = action.type === 'new-game' || action.type === 'continue' || action.type === 'load' || action.type === 'import' || action.type === 'travel' || action.type === 'retry-load' || action.type === 'return-title' || action.type === 'retry-checkpoint';
        const generation = supersedesWorld ? this.beginWorldGeneration() : this.worldGeneration;
        if (supersedesWorld) {
            this.pendingInteraction = null;
            this.pendingAbility = null;
            this.screenHistory.length = 0;
            this.resetEntryFlow();
            if (action.type !== 'retry-load' || action.operationId !== 'durable-event') this.worldReady = false;
        }
        try {
            switch (action.type) {
                case 'new-game':
                    this.pendingNewRunId = action.runId;
                    this.mapIntroHold = enterThroughIntro;
                    this.entryShotWanted = enterThroughIntro;
                    this.loading = { active: true, label: 'Starting a new journey', progress: null, operationId: 'new-game' };
                    this.screen = this.loadingScreen();
                    this.combat.setTimePolicy('paused');
                    this.render();
                    await this.initializeIfNeeded();
                    if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
                    await this.durableEvents;
                    if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
                    this.pendingWorldEvents = [];
                    this.failedWorldEvent = null;
                    this.sceneBlocked = false;
                    this.pendingLoadSlotId = null;
                    this.pendingImportPayload = null;
                    this.pendingTravel = null;
                    if (this.session.kind === 'chapters' && this.session.assets !== 'candidate') this.selectedHero = 'aren';
                    await this.rememberCompanion(this.selectedHero, requestedCompanion ?? this.settings.heroCompanions[this.selectedHero]);
                    if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
                    if (this.session.kind === 'chapters') {
                        this.campaign = this.campaignDirector.startChapterRun({ runId: action.runId, heroId: this.selectedHero, companionId: this.settings.heroCompanions[this.selectedHero], saveScope: this.session.saveScope });
                        await this.campaignDirector.autosave();
                        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
                        await this.refreshSlots();
                    } else {
                        const showcaseRegion = trial?.showcaseRegionId;
                        this.campaign = showcaseRegion
                            ? this.campaignDirector.startShowcase(action.runId, showcaseRegion, { heroId: this.selectedHero, companionId: this.settings.heroCompanions[this.selectedHero] })
                            : this.campaignDirector.startNewRun(action.runId, this.selectedHero, this.settings.heroCompanions[this.selectedHero]);
                    }
                    this.combat.startNewRun(this.campaign.runId);
                    this.pendingNewRunId = null;
                    this.activeRunId = this.campaign.runId;
                    this.lastCueSnapshot = this.campaign;
                    this.clearNarrativeCueQueue();
                    await this.prepareWorld(this.campaign, generation);
                    break;
                case 'continue':
                    this.pendingLoadSlotId = action.slotId;
                    this.loading = { active: true, label: 'Loading saved journey', progress: null, operationId: 'continue' };
                    this.screen = 'loading';
                    this.combat.setTimePolicy('paused');
                    this.render();
                    await this.initializeIfNeeded();
                    if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
                    await this.durableEvents;
                    if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
                    this.pendingWorldEvents = [];
                    this.failedWorldEvent = null;
                    this.sceneBlocked = false;
                    this.pendingImportPayload = null;
                    this.pendingTravel = null;
                    this.loadingFromSave = true;
                    try {
                        await this.campaignDirector.load(action.slotId);
                    } finally {
                        this.loadingFromSave = false;
                    }
                    if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
                    this.campaign = this.campaignDirector.snapshot();
                    this.activeRunId = this.campaign.runId;
                    this.lastCueSnapshot = this.campaign;
                    this.clearNarrativeCueQueue();
                    this.pendingLoadSlotId = null;
                    await this.prepareWorld(this.campaign, generation);
                    break;
                case 'pause':
                    this.setScreen('pause');
                    break;
                case 'resume':
                    this.setScreen('game');
                    break;
                case 'retry-load':
                    if (action.operationId === 'durable-event' && this.failedWorldEvent) {
                        this.failedWorldEvent = null;
                        this.error = null;
                        this.durableEvents = this.durableEvents.then(() => this.flushWorldEvents(generation, lifecycleGeneration));
                        await this.durableEvents;
                        if (!this.failedWorldEvent && this.pendingWorldEvents.length === 0 && this.screen === 'loading' && this.loading.operationId === 'durable-event') {
                            this.loading = { active: false, label: '', progress: null };
                            this.screen = 'game';
                            this.combat.setTimePolicy('normal');
                            this.render();
                        }
                    }
                    else if (action.operationId === 'travel' && this.pendingTravel) {
                        const destination = this.pendingTravel;
                        this.error = null;
                        if (this.campaign?.regionId === destination.regionId) {
                            await this.prepareWorld(this.campaign, generation);
                            this.pendingTravel = null;
                        } else {
                            await this.travel(destination.regionId, destination.entranceId, generation);
                        }
                        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
                        this.sceneBlocked = false;
                        this.durableEvents = this.durableEvents.then(() => this.flushWorldEvents(generation, lifecycleGeneration));
                        await this.durableEvents;
                        if (this.isWorldGenerationCurrent(generation, lifecycleGeneration)) this.render();
                    } else if (this.campaign && action.operationId === 'region-load') {
                        this.error = null;
                        await this.prepareWorld(this.campaign, generation);
                        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
                        this.sceneBlocked = false;
                        this.durableEvents = this.durableEvents.then(() => this.flushWorldEvents(generation, lifecycleGeneration));
                        await this.durableEvents;
                        if (this.isWorldGenerationCurrent(generation, lifecycleGeneration)) this.render();
                    } else if (action.operationId === 'checkpoint' && this.campaign) {
                        await this.restoreCheckpointAndReload(generation, lifecycleGeneration, 'Returning to the last safe checkpoint');
                    } else if (action.operationId === 'new-game' && this.pendingNewRunId) {
                        await this.dispatch({ type: 'new-game', runId: this.pendingNewRunId });
                    } else if (action.operationId === 'continue' && this.pendingLoadSlotId) {
                        await this.dispatch({ type: 'continue', slotId: this.pendingLoadSlotId });
                    } else if (action.operationId === 'load' && this.pendingLoadSlotId) {
                        await this.dispatch({ type: 'load', slotId: this.pendingLoadSlotId });
                    } else if (action.operationId === 'import' && this.pendingImportPayload) {
                        await this.dispatch({ type: 'import', payload: this.pendingImportPayload });
                    }
                    break;
                case 'advance-dialogue':
                    if (this.session.kind === 'chapters') { await this.advanceStoryLine(false, action.beatId); break; }
                    if (this.dialogue?.id === action.beatId) {
                        const totalLines = this.dialogue.lines.length;
                        if (totalLines > 0 && this.dialogueLineIndex < totalLines - 1) {
                            this.dialogueLineIndex += 1;
                            this.setScreen('dialogue');
                        } else {
                            this.dialogue = this.dialogue.next ? STORY_DIALOGUE[this.dialogue.next] ?? null : null;
                            this.dialogueLineIndex = 0;
                            if (this.dialogue)
                                this.setScreen('dialogue');
                            else if (this.choice)
                                this.setScreen('choice');
                            else if (this.pendingNarrativeCues.length) {
                                this.maybePresentNextNarrativeCue();
                                if (!this.dialogue)
                                    await this.startWildlifeEncounterIfReady();
                            } else
                                await this.startWildlifeEncounterIfReady();
                        }
                    }
                    break;
                case 'return-title':
                    this.error = null;
                    this.releaseWorld();
                    this.setScreen('title');
                    await this.durableEvents;
                    if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
                    this.pendingWorldEvents = [];
                    this.failedWorldEvent = null;
                    this.sceneBlocked = false;
                    this.pendingNewRunId = null;
                    this.pendingLoadSlotId = null;
                    this.pendingImportPayload = null;
                    this.pendingTravel = null;
                    this.pendingInteraction = null;
                    this.pendingAbility = null;
                    this.campaign = null;
                    this.region = null;
                    this.activeRunId = null;
                    this.activeCompanionId = undefined;
                    this.interaction = undefined;
                    this.dialogue = null;
                    this.dialogueLineIndex = 0;
                    this.choice = null;
                    this.ending = null;
                    this.clearNarrativeCueQueue();
                    this.lastCueSnapshot = null;
                    this.loading = { active: false, label: '', progress: null };
                    this.error = null;
                    this.accumulator = 0;
                    this.previousTime = 0;
                    this.input.clear();
                    this.render();
                    break;
                case 'view-credits':
                    this.setScreen('credits');
                    break;
                case 'interact':
                    this.pendingInteraction = { interactionId: action.interactionId, targetId: action.targetId };
                    break;
                case 'open-hub':
                    if (this.session.kind === 'chapters' && HUB_REGION_IDS.some(id => id === this.campaign?.regionId)) this.setScreen('hub');
                    break;
                case 'learn-upgrade':
                    if (this.screen !== 'hub') break;
                    this.campaign = await this.campaignDirector.learnUpgrade(action.upgradeId);
                    if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
                    this.syncWorldFacts();
                    this.render();
                    break;
                case 'start-dodge-training':
                    if (this.screen !== 'hub') break;
                    this.combat.startDodgePractice();
                    this.setScreen('game');
                    break;
                case 'stop-dodge-training':
                    this.combat.stopDodgePractice();
                    this.render();
                    break;
                case 'open-map':
                    this.setScreen('map');
                    break;
                case 'open-journal':
                    this.setScreen('journal');
                    break;
                case 'open-companions':
                    this.setScreen('companions');
                    break;
                case 'open-settings':
                    this.setScreen('settings');
                    break;
                case 'close-screen': {
                    const previous = this.screenHistory.pop();
                    if (previous !== undefined) this.setScreen(previous, true);
                    else this.render();
                    break;
                }
                case 'create-save-slot':
                    if (this.campaign) {
                        await this.campaignDirector.saveNewSlot(action.label);
                        await this.refreshSlots();
                        this.setScreen('pause');
                        this.announceSave();
                    }
                    break;
                case 'save':
                    await this.campaignDirector.save(action.slotId, action.label);
                    await this.refreshSlots();
                    this.render();
                    this.announceSave();
                    break;
                case 'load':
                    this.pendingLoadSlotId = action.slotId;
                    this.loading = { active: true, label: 'Loading saved journey', progress: null, operationId: 'load' };
                    this.screen = 'loading';
                    this.combat.setTimePolicy('paused');
                    this.render();
                    await this.initializeIfNeeded();
                    if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
                    await this.durableEvents;
                    if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
                    this.pendingWorldEvents = [];
                    this.failedWorldEvent = null;
                    this.sceneBlocked = false;
                    this.pendingImportPayload = null;
                    this.pendingTravel = null;
                    this.loadingFromSave = true;
                    try {
                        await this.campaignDirector.load(action.slotId);
                    } finally {
                        this.loadingFromSave = false;
                    }
                    if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
                    this.campaign = this.campaignDirector.snapshot();
                    this.activeRunId = this.campaign.runId;
                    this.lastCueSnapshot = this.campaign;
                    this.clearNarrativeCueQueue();
                    this.pendingLoadSlotId = null;
                    await this.prepareWorld(this.campaign, generation);
                    break;
                case 'import':
                    this.pendingImportPayload = action.payload;
                    this.loading = { active: true, label: 'Importing saved journey', progress: null, operationId: 'import' };
                    this.screen = 'loading';
                    this.combat.setTimePolicy('paused');
                    this.render();
                    await this.initializeIfNeeded();
                    if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
                    await this.durableEvents;
                    if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
                    this.pendingWorldEvents = [];
                    this.failedWorldEvent = null;
                    this.sceneBlocked = false;
                    this.pendingLoadSlotId = null;
                    this.pendingTravel = null;
                    this.loadingFromSave = true;
                    try {
                        await this.campaignDirector.importSave(action.payload, 'import-' + Date.now().toString(36), 'Imported Journey');
                    } finally {
                        this.loadingFromSave = false;
                    }
                    if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
                    this.campaign = this.campaignDirector.snapshot();
                    this.activeRunId = this.campaign.runId;
                    this.lastCueSnapshot = this.campaign;
                    this.clearNarrativeCueQueue();
                    this.pendingImportPayload = null;
                    await this.refreshSlots();
                    if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
                    await this.prepareWorld(this.campaign, generation);
                    break;
                case 'export': {
                    const slot = action.slotId ?? this.slots[0]?.slotId;
                    if (!slot)
                        throw new Error('There is no saved journey to export.');
                    const payload = await this.campaignDirector.exportSave(slot);
                    if (!this.isLifecycleCurrent(lifecycleGeneration)) return;
                    this.download(payload, 'wild-crown-' + slot + '.json');
                    break;
                }
                case 'accept-quest':
                    this.campaign = await this.campaignDirector.acceptQuest(action.questId);
                    if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
                    this.syncWorldFacts();
                    this.render();
                    break;
                case 'track-objective':
                    this.campaign = this.campaignDirector.trackObjective(action.objectiveId);
                    this.render();
                    break;
                case 'select-companion':
                    await this.assignParty(action.companionId);
                    break;
                case 'issue-command':
                    if (!this.issueCommand(action.command.companionId, action.command.command, action.command.targetId))
                        this.ui.notify('Companion is not available to receive this command.');
                    break;
                case 'preview-companion-skill':
                    for (const [preview, host] of this.companionPreviews) {
                        if (host.dataset.companion === ALL_COMPANION_SKILLS.find(skill => skill.id === action.abilityId)?.companionId) preview.showcase(action.abilityId);
                    }
                    break;
                case 'use-ability': {
                    const skill = ALL_COMPANION_SKILLS.find(candidate => candidate.id === action.abilityId);
                    if (!skill) { this.pendingAbility = action.abilityId; break; }
                    const request = this.skillRequest(skill);
                    if (!request) { this.ui.notify('Choose a nearby movable object with Koro in Utility.'); break; }
                    const availability = this.combat.commandAvailability(request);
                    if (!availability.available || !this.combat.commandCompanion(request)) {
                        this.ui.notify(availability.reason ?? 'This skill is not ready.');
                        break;
                    }
                    this.setScreen('game');
                    break;
                }
                case 'choose': {
                    const site = INTERACTIONS.find(item => item.regionId === this.region?.id && item.success.type === 'choice' && item.success.choiceId === action.choiceId);
                    if (site?.success.type === 'choice') {
                        if (!site.success.optionIds.includes(action.optionId) || !this.combat.resolveInteraction(site.id, site.targetId, action.optionId))
                            throw new Error('The requested choice is not available at this site.');
                        this.choice = null;
                        this.screen = 'game';
                        this.combat.setTimePolicy('normal');
                        this.input.clear();
                        const cues = this.combat.drainPresentationCues();
                        if (cues.length)
                            this.presentation?.consumeTick(cues);
                        this.combat.consumeEvents();
                        this.queueEvents(this.combat.consumeWorldEvents());
                        this.render();
                    }
                    else {
                        try { this.campaign = await this.campaignDirector.choose(action.choiceId, action.optionId); }
                        catch (error) {
                            if (!(error instanceof CampaignChoiceRejectedError)) throw error;
                            this.choiceNotice = errorText(error);
                            this.render();
                            break;
                        }
                        this.choiceNotice = null;
                        this.choice = null;
                        this.ending = this.campaign.ending ? endingViewModel(this.campaign.ending) : null;
                        this.setScreen(this.ending ? 'ending' : 'game');
                    }
                    break;
                }
                case 'travel':
                    this.pendingTravel = { regionId: action.regionId, entranceId: action.entranceId, requestId: crypto.randomUUID() };
                    await this.travel(action.regionId, action.entranceId, generation);
                    break;
                case 'select-hero-companion':
                    if (this.screen !== 'hero-select' || !isHeroId(action.heroId) || !isCompanionId(action.companionId)) return;
                    await this.rememberCompanion(action.heroId, action.companionId);
                    break;
                case 'update-settings':
                    this.settings = { ...this.settings, ...action.settings };
                    this.input.setDeadzone(this.settings.gamepadDeadzone);
                    this.presentation?.setSettings(this.settings);
                    this.appAudio.setSettings(this.settings);
                    this.renderer?.setSettings(this.settings);
                    this.combat.setAccessibilitySettings(this.settings);
                    this.combatReadability.setSettings(this.settings);
                    await this.saves.saveSettings(this.settings, this.bindings);
                    this.render();
                    break;
                case 'remap': {
                    const deviceBindings = { ...this.bindings[action.device] };
                    const attempted = typeof action.binding === 'string' ? action.binding : '';
                    if (action.device === 'keyboard' && !isCanonicalKeyboardRemap(action.actionId, attempted)) {
                        deviceBindings[action.actionId] = DEFAULT_INPUT_BINDINGS.keyboard[action.actionId] ?? '';
                    } else {
                        deviceBindings[action.actionId] = action.binding;
                    }
                    this.bindings = {
                        ...this.bindings,
                        [action.device]: deviceBindings,
                    };
                    this.applyBindings();
                    await this.saves.saveSettings(this.settings, this.bindings);
                    this.render();
                    break;
                }
                case 'skip-cinematic':
                    if (this.session.kind === 'chapters') { await this.advanceStoryLine(true, this.dialogue?.id); break; }
                    this.presentation?.onCinematicSkip(action.cinematicId);
                    this.dialogue = null;
                    this.dialogueLineIndex = 0;
                    this.clearNarrativeCueQueue();
                    if (this.choice) {
                        this.setScreen('choice');
                    } else {
                        this.setScreen('game');
                        await this.startWildlifeEncounterIfReady();
                    }
                    break;
                case 'leave-map-intro':
                    if (this.screen !== 'map-intro') break;
                    this.mapIntroHold = false;
                    if (this.entryWaiting) {
                        this.entryWaiting = false;
                        this.revealWorld();
                    } else {
                        // Still loading: the loading scene takes over, and the reveal follows when the world is ready.
                        this.screen = 'loading';
                        this.render();
                    }
                    break;
                case 'skip-establishing-shot':
                    if (this.entryShot) this.finishEntryShot(true);
                    break;
                case 'retry-checkpoint':
                    if (!this.campaign?.lastSafeCheckpoint) break;
                    this.loading = { active: true, label: 'Returning to the last safe checkpoint', progress: null, operationId: 'checkpoint' };
                    this.screen = 'loading';
                    this.combat.setTimePolicy('paused');
                    this.render();
                    await this.durableEvents;
                    if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
                    await this.restoreCheckpointAndReload(generation, lifecycleGeneration, 'Returning to the last safe checkpoint');
                    break;
                case 'dismiss-tutorial': {
                    const seen = this.tutorial;
                    if (!seen) break;
                    this.tutorial = null;
                    this.settings = { ...this.settings, seenTutorials: [...this.settings.seenTutorials, seen] };
                    this.input.clear();
                    this.render();
                    await this.saves.saveSettings(this.settings, this.bindings);
                    break;
                }
                case 'reset-tutorials':
                    this.settings = { ...this.settings, seenTutorials: [] };
                    this.render();
                    await this.saves.saveSettings(this.settings, this.bindings);
                    break;
            }
        }
        catch (error) {
            if (this.disposed) return;
            if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
            const operationId = action.type === 'new-game' ? this.loading.operationId ?? 'new-game'
                : action.type === 'continue' || action.type === 'load' || action.type === 'travel' ? action.type
                    : action.type === 'retry-checkpoint' ? 'checkpoint'
                    : action.type === 'retry-load' ? action.operationId
                        : this.loading.operationId;
            const terminalAssetError = isTerminalAssetError(error);
            const code = error instanceof SaveRepositoryError ? error.code : terminalAssetError ? 'asset-unavailable' : 'application';
            this.error = { code, message: errorText(error), recoverable: !terminalAssetError };
            this.loadProgress = null;
            this.mapIntroHold = false;
            this.entryWaiting = false;
            this.entryShotWanted = false;
            this.loading = { active: false, label: 'Operation failed', progress: null, ...(operationId ? { operationId } : {}) };
            this.screen = 'loading';
            this.combat.setTimePolicy('paused');
            this.render();
        }
    }
    private async initializeIfNeeded(): Promise<void> {
        if (this.ready) return;
        const initialization = this.initializationPromise ??= this.initialize();
        await initialization;
        if (!this.ready) {
            this.initializationPromise = null;
            throw new Error(this.error?.message ?? 'Save data could not be initialized.');
        }
    }
    private async refreshSlots(): Promise<void> { this.slots = this.activeSaves ? await this.activeSaves.listSlots() : []; }
    private async travel(regionId: RegionId, entranceId: string, generation = this.worldGeneration): Promise<void> {
        const lifecycleGeneration = this.lifecycleGeneration;
        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        if (!this.campaign) throw new Error('Travel requires an active campaign.');
        this.input.clear();
        this.presentation?.onRegionUnload();
        this.screen = 'loading';
        this.combat.setTimePolicy('paused');
        this.loading = { active: true, label: 'Traveling to region', progress: null, operationId: 'travel' };
        this.render();
        await this.durableEvents;
        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        const destination = this.pendingTravel;
        if (this.session.kind === 'chapters') {
            const exit = this.region?.exits.find(route => route.destinationRegionId === regionId);
            if (!exit) throw new Error('There is no authored exit from here to that region.');
            this.campaign = await this.campaignDirector.advanceChapter({ exitId: exit.id, requestId: destination?.requestId ?? crypto.randomUUID() });
        } else this.campaign = await this.campaignDirector.travel(regionId, entranceId);
        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        this.activeRunId = this.campaign.runId;
        await this.prepareWorld(this.campaign, generation);
        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        this.pendingTravel = null;
    }
    /** Traveling instances take precedence over a same-species story counterpart. */
    private presentParty(): { readonly companionId?: CompanionId; readonly present: readonly string[] } | null {
        if (!this.region || !this.campaign) return null;
        const entities = this.region.entities.filter(entity => entity.actorId && (!entity.visibleWhen || this.campaign?.worldFacts[entity.visibleWhen] === true));
        const companionId = this.campaign.party.companionId;
        if (companionId && !entities.some(entity => entity.actorId === companionId && entity.id.includes('__party_'))) return null;
        return { companionId, present: entities.map(entity => entity.id) };
    }
    /**
     * Bond and story recruitment remain narrative state. Availability comes from the selected traveling party.
     */
    private syncCompanionProgress(): void {
        if (!this.campaign) return;
        this.combat.configureCompanionProgress(this.campaign.companions);
        const selection = this.presentParty();
        if (selection && this.combat.setCompanion(selection.companionId, selection.present)) this.activeCompanionId = selection.companionId;
    }
    private download(contents: string, fileName: string): void { const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName; anchor.click(); URL.revokeObjectURL(url); }
    private canPlayWorld(): boolean {
        return this.worldReady && !!this.renderer && !!this.region && !!this.campaign
            && this.region.id === this.campaign.regionId && !this.error && !this.loading.active && !this.sceneBlocked;
    }
    private setScreen(screen: Screen, returning = false): void {
        // While the map intro is on screen nothing else may take the screen; Continue or Skip leaves it.
        if (this.mapIntroHold) {
            this.render();
            return;
        }
        // A pause, panel or dialogue during the establishing shot ends it at gameplay framing.
        if (this.entryShot && screen !== 'game') this.endEntryShot(true);
        if (WORLD_PANELS.includes(screen) && !this.canPlayWorld()) {
            this.render();
            return;
        }
        if (screen === 'game' && !this.canPlayWorld()) screen = this.error || this.loading.active ? 'loading' : 'title';
        if (screen === 'game' && this.stageCompleted) screen = 'stage-complete';
        else if (screen === 'game' && this.playerOutcome === 'defeat') screen = 'defeat';
        else if (screen === 'game' && this.suspended) screen = 'pause';
        if (!returning && screen !== this.screen) {
            if (OVERLAY_SCREENS.includes(screen)) {
                if (!(MENU_TABS.includes(screen) && MENU_TABS.includes(this.screen))) this.screenHistory.push(this.screen);
            }
            else this.screenHistory.length = 0;
        }
        this.cancelWheel();
        this.screen = screen;
        if (screen !== 'game') this.endBossReveal();
        this.combat.setTimePolicy(screen === 'game' && !this.entryShot ? 'normal' : 'paused');
        this.pendingInteraction = null;
        this.pendingAbility = null;
        this.input.clear();
        this.input.setEnabled(screen === 'game' && !this.entryShot && this.ready && this.canPlayWorld());
        this.accumulator = 0;
        this.render();
    }
    private releaseWorld(): void {
        this.cancelWheel();
        this.worldBusy = 0;
        this.storyBusy = false;
        this.worldReady = false;
        this.entryShot = false;
        this.entryShotSnapshot = null;
        this.entryWaiting = false;
        this.tutorial = null;
        this.previousRenderSnapshot = undefined;
        this.renderSnapshot = undefined;
        this.endBossReveal();
        this.damageNumbers.clear();
        this.monsterLabels.clear();
        this.combatReadability.clear();
        this.stageGoal = null;
        this.stageCompleted = false;
        this.playerOutcome = null;
        this.outcomeElapsed = 0;
        this.outcomeSnapshot = null;
        this.disposeCompanionPreviews();
        this.presentation?.dispose();
        this.presentation = null;
        this.renderer?.dispose();
        this.renderer = null;
        this.region = null;
    }
    /**
     * Presents a newly engaged boss once per run: the renderer's reveal camera frames it and the title card names it; the frame
     * loop holds the world still while the reveal runs. Story encounters use the snapshot boss; Trials use the active monster of
     * the final (boss) stage once its fight starts.
     */
    private maybeRevealBoss(snapshot: CombatSnapshot): void {
        if (!this.renderer || !this.campaign || this.renderer.bossRevealActive) return;
        const status = snapshot.encounterStatus;
        let actorId: ActorId | undefined;
        let key = '';
        let title: { readonly name: string; readonly epithet: string } | undefined;
        if (snapshot.boss && snapshot.encounterId && !status?.trial) {
            actorId = snapshot.boss.actorId;
            key = `${this.campaign.runId}:${snapshot.encounterId}`;
            const archetype = snapshot.actors.find(actor => actor.id === actorId)?.archetypeId ?? actorId;
            title = BOSS_TITLES[archetype] ?? bossTitleFromLabel(status?.title ?? archetype, this.region?.name ?? '');
        } else if (status?.trial?.boss && status.trial.status === 'fighting') {
            const monster = status.monsters.find(candidate => candidate.active);
            if (!monster) return;
            actorId = monster.id;
            key = `${this.campaign.runId}:${snapshot.encounterId ?? 'trial'}:${status.trial.stage}`;
            title = bossTitleFromLabel(monster.name, status.title);
        }
        if (!actorId || !title || this.revealedBosses.has(key)) return;
        this.revealedBosses.add(key);
        if (!this.renderer.playBossReveal(actorId)) return;
        this.bossIntro.show(title.name, title.epithet, 2.25, this.settings.reducedMotion);
    }
    /** Ends a running boss reveal (leaving gameplay or the world): the camera cuts back and the card goes. */
    private endBossReveal(): void {
        if (this.renderer?.bossRevealActive) this.renderer.skipBossReveal();
        this.bossIntro.dispose();
    }
    /** Region scene for the loading screen, map intro and establishing shot. */
    private sceneModel(): NonNullable<GameViewModel['scene']> {
        const trial = trialMapOf(this.session);
        const regionId = trial ? trial.id : SCENE_BY_REGION[this.campaign?.regionId ?? 'greenwake'] ?? 'greenwake';
        const named = trial !== null || this.session.kind === 'chapters' && this.session.assets === 'candidate';
        return { regionId, heroName: named ? heroById(this.selectedHero).name : null, establishingShot: this.entryShot };
    }
    /**
     * One frame of the establishing shot: the simulation stays paused at its first snapshot, so only idle animation, the
     * camera sweep and rendering advance. The shot ends when the renderer reports it finished.
     */
    private stepEntryShot(delta: number): void {
        const renderer = this.renderer;
        const snapshot = this.entryShotSnapshot;
        if (!renderer || !snapshot || !this.canPlayWorld() || this.screen !== 'game') {
            this.endEntryShot(false);
            this.render();
            return;
        }
        if (document.hidden) return;
        renderer.sync(snapshot.actors, snapshot, delta);
        renderer.updateWaystone(delta, false);
        renderer.render();
        if (!renderer.establishingShotActive) this.finishEntryShot(false);
    }
    private applyBindings(): void {
        this.input.setBindings(this.bindings);
    }
    private hubModel(snap: CombatSnapshot): GameViewModel['hub'] {
        const campaign = this.campaign;
        if (!campaign || this.session.kind !== 'chapters' || !HUB_REGION_IDS.some(id => id === campaign.regionId)) return undefined;
        const facts = campaign.worldFacts;
        const reason = this.combat.dodgePracticeBlock();
        const grown = facts['choice:koro-pact'] === true && facts['choice:asha-pact'] === true;
        const label = (id: string) => id.replaceAll('-', ' ').replace(/\b[a-z]/g, letter => letter.toUpperCase());
        return {
            name: campaign.regionId === 'refuge' ? 'The Refuge' : 'The Grove',
            stage: campaign.regionId === 'refuge' ? (facts['hub:refuge-garden'] === true ? 'Shared Refuge' : 'Rebuilding Together')
                : grown ? 'Living Sanctuary' : 'Young Sanctuary',
            upgrades: HUB_UPGRADES.map(upgrade => ({
                id: upgrade.id, title: upgrade.title, description: upgrade.description, requirement: upgrade.requirement,
                learned: facts[upgrade.fact] === true,
                available: campaign.completedQuestIds.includes(upgrade.requiredQuestId)
                    && (!upgrade.requiredFact || facts[upgrade.requiredFact] === true),
            })),
            memories: this.screen === 'hub' ? campaign.session.resume.completedBeatIds.flatMap(id => {
                const beat = STORY_DIALOGUE[id];
                return beat ? [{ id, title: label(id), lines: beat.lines.filter(line => !line.condition || facts[line.condition] === true).map(line => ({ speaker: label(line.speaker), text: line.text })) }] : [];
            }) : [],
            practice: { available: reason === null, reason, ...(snap.dodgePractice ?? { active: false, attempts: 0, dodged: 0, phase: 'idle' }) },
        };
    }

    private model(snap: CombatSnapshot = this.combat.snapshot()): GameViewModel {
        const c = this.campaign;
        const last = this.slots.find(slot => slot.kind === 'campaign');
        const regions = REGIONS.map(region => {
            const exits = c ? REGIONS.find(item => item.id === c.regionId)?.exits.filter(route => route.destinationRegionId === region.id) ?? [] : [];
            const entrances = exits.map(route => {
                const entranceId = region.entrances.find(item => item.id === route.id.replace(/-out$/, '-in'))?.id ?? route.id;
                return { id: entranceId, label: 'Travel to ' + region.name, unlocked: !route.unlockFact || c?.worldFacts[route.unlockFact] === true };
            });
            const restoration = c && ['whispering-canopy', 'blood-bamboo-valley', 'moonpine-ridge', 'mistveil-basin', 'sunmane-expanse'].includes(region.id)
                ? c.campaign.world.regions[region.id as keyof typeof c.campaign.world.regions]
                : 'unvisited';
            return { id: region.id, name: region.name, unlocked: region.id === c?.regionId || region.id === 'greenwake' || entrances.some(entrance => entrance.unlocked), restoration, entrances };
        });
        const companionState = this.screen === 'companions' ? this.combat.companions : null;
        const rosterAbilities = companionState ? ALL_COMPANION_SKILLS.map(skill => {
            const request = this.skillRequest(skill);
            const availability = request ? this.combat.commandAvailability(request) : { available: false, tokenCost: 1, readyAtWorldTick: 0, reason: 'Equip Koro and choose a nearby movable object.' };
            return {
                id: skill.id, label: skill.label, companionId: skill.companionId, element: skill.element, description: skill.description, automatic: skill.automatic,
                tokenCost: availability.tokenCost, cooldownSeconds: Math.max(0, Math.ceil((availability.readyAtWorldTick - snap.worldClock.worldTick) / 60)),
                available: availability.available, reason: availability.reason ?? undefined,
            };
        }) : [];
        const abilities = companionState ? rosterAbilities : [];
        const trial = trialMapOf(this.session);
        const view: GameViewModel = {
            screen: this.screen,
            canOpenWorldPanels: this.canPlayWorld() && !this.stageCompleted && !this.entryShot,
            loading: this.loading,
            scene: this.screen === 'map-intro' || this.screen === 'loading' || this.loading?.active || this.entryShot ? this.sceneModel() : undefined,
            error: this.error ?? this.choiceError(),
            settings: this.settings,
            bindings: this.bindings,
            saves: { slots: this.slots.map(slot => ({ ...slot, exists: true })), continueSlotId: last?.slotId ?? null },
            campaign: c,
            party: c?.party ?? null,
            relationships: c?.factions ?? null,
            hub: this.hubModel(snap),
            journal: { quests: QUESTS, region: c?.regionId ?? null },
            ...(c ? { questLog: questLogOf(c, QUESTS) } : {}),
            map: { currentRegion: c?.regionId ?? null, regions },
            playtestStage: trial?.stage,
            playtestSelection: trial ? {
                selectedMapId: trial.id, heroId: this.selectedHero,
                nextMapId: this.stageCompleted ? ASSET_PLAYTESTS[ASSET_PLAYTESTS.indexOf(trial) + 1]?.id : undefined,
                progressWarning: this.playtestProgress.warning,
                maps: STORY_CHAPTERS.map(chapter => {
                    const map = ASSET_PLAYTESTS.find(playtest => playtest.id === chapter.playtestId);
                    return {
                        id: map?.id ?? chapter.id, label: chapter.label, name: chapter.name, setting: chapter.setting,
                        thumbnailUrl: map?.thumbnailUrl ?? null, mapArt: chapter.mapArt,
                        monsters: map ? map.trialSet.trials.map(trial => trial.monsterName) : [],
                        comingSoon: !map,
                        unlocked: map ? this.playtestProgress.isUnlocked(map.id) : false,
                        cleared: map ? this.playtestProgress.isCleared(map.id) : false,
                    };
                }),
            } : undefined,
            hud: {
                heroId: snap.player.heroId,
                vitality: snap.player.vitality,
                maxVitality: snap.player.maxVitality,
                mana: snap.player.mana,
                maxMana: snap.player.maxMana,
                skills: snap.skills,
                encounterStatus: snap.encounterStatus,
                instinct: snap.player.instinct,
                boss: snap.boss,
                interaction: this.interaction,
                targetId: snap.targetId,
                target: snap.actors.find(actor => actor.id === snap.targetId),
                destination: this.destinationHud(snap),
            },
            abilities,
            dialogue: this.dialogue,
            dialogueLineIndex: this.dialogue ? Math.max(0, Math.min(this.dialogueLineIndex, this.dialogue.lines.length - 1)) : 0,
            choice: this.choice,
            ending: this.ending ?? (c?.ending ? endingViewModel(c.ending) : null),
            trackedObjectiveId: c?.trackedObjectiveId ?? null,
            session: this.sessionModel(),
            ...this.chapterModels(snap, c),
            ...(this.tutorial ? { tutorial: this.tutorial } : {}),
        };
        return view;
    }
    private render(): void {
        if (this.disposed) return;
        if (this.suspended && this.screen === 'game') {
            this.setScreen(this.canPlayWorld() ? 'pause' : 'game');
            return;
        }
        if (this.screen !== 'companions') this.disposeCompanionPreviews();
        this.previousRenderSnapshot = undefined;
        this.renderSnapshot = undefined;
        const model = this.model();
        this.ui.render(model);
        this.appAudio.syncScreen(this.screen);
        // A how-to-play card freezes play: input stops and the floating world labels step aside so they cannot cover the card.
        const active = this.ready && this.screen === 'game' && !this.entryShot && !this.tutorial && this.canPlayWorld();
        this.input.setEnabled(active);
        this.damageNumbers.element.hidden = !(active || this.screen === 'defeat' && this.outcomeElapsed < 0.8);
        this.monsterLabels.element.hidden = !active;
        if (!active) this.combatReadability.clear();
        if (!active) this.input.clear();
        if (this.session.kind === 'chapters') this.presentChapterStory();
        else this.presentQueuedNarrativeCue();
    }
    /**
     * Render-time cue presentation: if no beat is currently displayed and a
     * queued cue is waiting, present it. `maybePresentNextNarrativeCue`
     * re-checks the world-readiness gate so a region-transition event fired
     * by the same committed snapshot defers presentation until the new
     * region is fully loaded.
     */
    private presentQueuedNarrativeCue(): void {
        if (this.dialogue) return;
        if (!this.pendingNarrativeCues.length) return;
        if (!this.canPresentNarrativeCueNow()) return;
        this.maybePresentNextNarrativeCue();
    }
    private syncStoryState(): void { if (!this.presentation || !this.campaign)
        return; const combat = this.combat.snapshot(); const corruption = Math.max(0, ...combat.actors.map(actor => actor.corruption ?? 0)); const restoration = Object.values(this.campaign.campaign.world.regions).filter(state => state === 'restored').length; this.presentation.setStoryState({ corruption, restoration, bond: this.combat.companions.bond, dominion: this.campaign.campaign.dominionHistory.length });
        this.presentation.audio.setRegionRestorationState((this.campaign.campaign.world.regions as Readonly<Record<string, RestorationState | undefined>>)[this.campaign.regionId]); }
    private syncWorldFacts(): void {
        if (!this.campaign) return;
        this.combat.syncWorldFacts(this.campaign.worldFacts);
        const facts = Object.fromEntries(Object.entries(this.campaign.worldFacts).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
        this.renderer?.syncWorldFacts(facts);
        if (this.renderer) this.combat.setSceneColliders(this.renderer.getNativeSolidColliders(), this.renderer.getNativeSupportFields());
    }
    private queueEvents(events: readonly WorldEvent[]): void {
        if (!events.length) return;
        this.pendingWorldEvents.push(...events);
        const generation = this.worldGeneration;
        const lifecycleGeneration = this.lifecycleGeneration;
        this.durableEvents = this.durableEvents.then(() => this.flushWorldEvents(generation, lifecycleGeneration));
    }
    /**
     * Commits one engine event. A cross-region traversal in a chapter session is the Director's single chapter-transition
     * operation (requirements, chapter advance and destination spawn in one atomic commit); everything else is an event.
     */
    private commitEvent(event: WorldEvent): Promise<CampaignSnapshot> {
        if (this.session.kind === 'chapters' && event.type === 'traversal' && event.fromRegion !== event.toRegion)
            return this.campaignDirector.advanceChapter({ exitId: event.routeId, requestId: event.idempotencyKey });
        return this.campaignDirector.processEvent(event);
    }
    private async flushWorldEvents(generation = this.worldGeneration, lifecycleGeneration = this.lifecycleGeneration): Promise<void> {
        while (this.isWorldGenerationCurrent(generation, lifecycleGeneration) && this.pendingWorldEvents.length && !this.failedWorldEvent && !this.sceneBlocked) {
            const event = this.pendingWorldEvents[0]!;
            const fromRegion = this.campaign?.regionId;
            try {
                const snapshot = await this.commitEvent(event);
                if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
                this.campaign = snapshot;
            }
            catch (error) {
                if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
                if (error instanceof CampaignChoiceRejectedError && event.type === 'choice') {
                    this.combat.discardRejectedChoice(event, this.campaignDirector.isEventCommitted(event.idempotencyKey));
                    this.pendingWorldEvents.shift();
                    this.campaign = this.campaignDirector.snapshot();
                    this.render();
                    continue;
                }
                if (event.type === 'traversal' && this.session.kind === 'chapters' && !(error instanceof SaveRepositoryError)) {
                    // The Director refused the exit (story requirements unmet): nothing was committed, the player is told why.
                    this.pendingWorldEvents.shift();
                    this.campaign = this.campaignDirector.snapshot();
                    this.ui.notify(errorText(error));
                    this.render();
                    continue;
                }
                this.failedWorldEvent = event;
                this.campaign = this.campaignDirector.snapshot();
                this.error = { code: error instanceof SaveRepositoryError ? error.code : 'durable-event', message: 'Story event was not committed: ' + errorText(error), recoverable: true };
                this.loading = { active: false, label: 'Story progress was not saved', progress: null, operationId: 'durable-event' };
                this.screen = 'loading';
                this.combat.setTimePolicy('paused');
                this.render();
                return;
            }
            this.pendingWorldEvents.shift();
            this.syncStoryState();
            if (this.campaign.ending) {
                this.ending = endingViewModel(this.campaign.ending);
                this.setScreen('ending');
                return;
            }
            if (this.campaign.recoveryRequest) {
                // Tali was not kept safe: nothing of this attempt is kept, the run resumes at its chosen safe checkpoint.
                try { await this.restoreCheckpointAndReload(generation, lifecycleGeneration, 'Tali was in danger. Returning to the last safe checkpoint.'); }
                catch (error) { if (this.isWorldGenerationCurrent(generation, lifecycleGeneration)) this.showWorldError(error, 'checkpoint'); }
                return;
            }
            if (this.campaign.regionId !== fromRegion) {
                this.cancelWheel();
                this.presentation?.onRegionUnload();
                this.sceneBlocked = true;
                this.loading = { active: true, label: 'Following the authored route', progress: null, operationId: 'region-load' };
                this.screen = 'loading';
                this.combat.setTimePolicy('paused');
                this.render();
                try {
                    await this.prepareWorld(this.campaign, generation);
                    this.sceneBlocked = false;
                    if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
                }
                catch (error) {
                    if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
                    this.showWorldError(error, 'region-load');
                    return;
                }
            }
            else {
                this.syncWorldFacts();
                try {
                    await this.startOrunEncounterIfReady(generation);
                    if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
                } catch (error) {
                    if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
                    this.sceneBlocked = true;
                    this.showWorldError(error, 'region-load');
                    return;
                }
                this.render();
            }
        }
    }
    /**
     * Restores the Director's last safe checkpoint (death, Tali danger or an explicit retry) and reloads the world at its
     * safe spawn; the checkpoint's unresolved encounter restarts from its entry. Presentation effects and pending events
     * of the failed attempt are dropped. Callers on the durable-event chain must not await that chain.
     */
    private async restoreCheckpointAndReload(generation: number, lifecycleGeneration: number, notice: string): Promise<void> {
        const checkpoint = this.campaign?.lastSafeCheckpoint;
        if (!checkpoint) throw new Error('There is no safe checkpoint to resume from.');
        this.cancelWheel();
        this.pendingWorldEvents = [];
        this.failedWorldEvent = null;
        this.sceneBlocked = false;
        this.playerOutcome = null;
        this.presentation?.onRegionUnload();
        this.combat.consumeEvents();
        this.combat.consumeWorldEvents();
        this.combat.consumeChapterIntents();
        if (!await this.campaignDirector.restoreCheckpoint(checkpoint)) throw new Error('The safe checkpoint could not be restored.');
        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        this.campaign = this.campaignDirector.snapshot();
        this.error = null;
        this.loading = { active: true, label: notice, progress: null, operationId: 'region-load' };
        this.screen = 'loading';
        this.render();
        await this.prepareWorld(this.campaign, generation);
    }
    private showWorldError(error: unknown, operationId: string): void {
        const terminalAssetError = isTerminalAssetError(error);
        const code = error instanceof SaveRepositoryError ? error.code : terminalAssetError ? 'asset-unavailable' : 'application';
        this.error = { code, message: errorText(error), recoverable: !terminalAssetError };
        this.loadProgress = null;
        this.mapIntroHold = false;
        this.entryWaiting = false;
        this.entryShotWanted = false;
        this.loading = { active: false, label: 'World operation failed', progress: null, operationId };
        this.screen = 'loading';
        this.combat.setTimePolicy('paused');
        this.render();
    }
    // ---- Sessions: asset policy and save scope are explicit, never inferred from a boolean --------------------------------
    /** The repository of the session's save scope; Trials have none (replay-isolated, never persisted). */
    private get activeSaves(): SaveRepository | null {
        return this.session.kind === 'trials' ? null : this.scopeSaves(this.session.saveScope);
    }
    private scopeSaves(scope: SaveScope): SaveRepository {
        if (scope === 'production') return this.saves;
        return this.candidateSaves ??= new SaveRepository(undefined, { scope, chapters: CHAPTER_RUNTIME, layoutMigrations: LAYOUT_MIGRATIONS });
    }
    /** A fresh Director on the session's repository; the old one stops publishing into this application. */
    private bindDirector(): void {
        this.unsubscribe?.();
        const saves = this.activeSaves;
        this.campaignDirector = new CampaignDirector({ ...(saves ? { saves } : {}), chapters: CHAPTER_RUNTIME, layoutMigrations: LAYOUT_MIGRATIONS, relationshipRules: RELATIONSHIP_RULES });
        this.unsubscribe = this.campaignDirector.subscribe(snapshot => {
            if (this.activeRunId && snapshot.runId !== this.activeRunId) return;
            const prev = this.campaign;
            this.activeRunId = snapshot.runId;
            this.campaign = snapshot;
            if (prev?.segmentId !== snapshot.segmentId && this.region?.id === snapshot.regionId) {
                this.combat.configureChapterRuntime(this.campaignDirector.chapterDefinition());
            }
            if (this.session.kind === 'chapters' && prev && prev.companions !== snapshot.companions && this.region?.id === snapshot.regionId) {
                this.syncCompanionProgress();
            }
            this.primeNarrativeCuesFromTransition(prev, snapshot);
            this.render();
        });
    }
    /**
     * Switches the session (title modes, Return to Title): the running world and every pending callback of the old mode are
     * released, the Director and repository of the new scope take over, and the banner follows. Nothing leaks across scopes.
     */
    private async useSession(next: SessionConfig): Promise<void> {
        const valid = validateSessionConfig(next, import.meta.env.DEV);
        this.beginWorldGeneration();
        this.resetEntryFlow();
        this.releaseWorld();
        await this.durableEvents;
        this.pendingWorldEvents = [];
        this.failedWorldEvent = null;
        this.chapterIntents = [];
        this.sceneBlocked = false;
        this.pendingNewRunId = null;
        this.pendingLoadSlotId = null;
        this.pendingImportPayload = null;
        this.pendingTravel = null;
        this.pendingInteraction = null;
        this.pendingAbility = null;
        this.campaign = null;
        this.region = null;
        this.activeRunId = null;
        this.activeCompanionId = undefined;
        this.interaction = undefined;
        this.dialogue = null;
        this.dialogueLineIndex = 0;
        this.choice = null;
        this.choiceNotice = null;
        this.ending = null;
        this.clearNarrativeCueQueue();
        this.lastCueSnapshot = null;
        this.loading = { active: false, label: '', progress: null };
        this.error = null;
        if (JSON.stringify(valid) !== JSON.stringify(this.session)) {
            this.session = valid;
            this.updateBanner();
            this.bindDirector();
            this.manifestPromise = this.readManifest();
            void this.manifestPromise.catch(() => undefined);
        }
        const saves = this.activeSaves;
        if (saves) await saves.init();
        this.slots = saves ? await saves.listSlots() : [];
    }
    private async enterMode(mode: 'chapters' | 'trials'): Promise<void> {
        if (this.screen !== 'title' || !import.meta.env.DEV) return;
        try {
            await this.useSession(mode === 'chapters' ? CANDIDATE_CHAPTERS_SESSION : trialsSession(trialMapOf(this.session)?.id ?? 'greenwake'));
            this.setScreen(mode === 'chapters' ? 'chapters-menu' : 'map-select');
        } catch (error) {
            this.error = { code: error instanceof SaveRepositoryError ? error.code : 'application', message: errorText(error), recoverable: true };
            this.render();
        }
    }
    /** A page loaded with `?chapters=candidate` or `?assetPlaytest=` lands on that mode's entry screen instead of the title. */
    private enterInitialMode(): void {
        if (this.screen !== 'title') return;
        if (this.session.kind === 'trials') this.setScreen('map-select');
        else if (this.session.assets === 'candidate' && new URLSearchParams(window.location.search).get('chapters') === 'candidate') this.setScreen('chapters-menu');
    }
    /** The persistent session banner (candidate chapters and Trials); absent in production. */
    private updateBanner(): void {
        const text = bannerOf(this.session);
        let banner = this.root.querySelector<HTMLElement>('.wc-asset-playtest-banner');
        if (!text) { banner?.remove(); return; }
        if (!banner) {
            banner = document.createElement('aside');
            banner.className = 'wc-asset-playtest-banner';
            banner.setAttribute('role', 'status');
            this.root.append(banner);
        }
        if (banner.textContent !== text) banner.textContent = text;
    }
    private sessionModel(): NonNullable<GameViewModel['session']> {
        const c = this.campaign;
        const chapters = this.session.kind === 'chapters';
        return {
            kind: sessionKindOf(this.session),
            banner: bannerOf(this.session),
            heroId: chapters && c ? c.session.heroId : this.session.kind === 'trials' ? this.selectedHero : null,
            saveScope: this.session.kind === 'chapters' ? this.session.saveScope : null,
            checkpointName: chapters && c ? checkpointName(c.session.resume.checkpointId) : null,
            segmentId: chapters && c ? c.segmentId : null,
            devModes: import.meta.env.DEV,
        };
    }
    private announceSave(): void {
        const name = this.campaign ? checkpointName(this.campaign.session.resume.checkpointId) : null;
        this.ui.notify(name ? 'Saved at ' + name + '. Unfinished encounters restart here.' : 'Journey saved.');
    }
    /** View-model parts only chapter sessions (and the wheel everywhere) provide. */
    private chapterModels(snap: CombatSnapshot, c: CampaignSnapshot | null): Partial<GameViewModel> {
        const out: { -readonly [K in keyof GameViewModel]?: GameViewModel[K] } = {};
        const wheel = this.wheelModel(snap);
        if (wheel) out.wheel = wheel;
        if (c) {
            out.companionProgress = companionProgressOf(c);
            if (this.screen === 'companions') out.partyPanel = partyPanelOf(c, this.combat.companionChangeBlocked || this.session.kind === 'chapters' && c.session.resume.activeEncounterId !== null);
        }
        if (this.session.kind !== 'chapters' || !c) return out;
        if (this.session.assets === 'candidate') out.hasCandidateSaves = this.slots.length > 0;
        out.dialogueChoice = { required: c.session.resume.pendingChoiceId !== null };
        const regionName = (id: RegionId) => REGIONS.find(item => item.id === id)?.name ?? id;
        const region = this.region && this.region.id === c.regionId ? this.region : null;
        if (this.screen === 'game' || this.screen === 'map' || this.screen === 'journal') {
            const act = chapterActOf(region, c, regionName, QUESTS);
            if (act) out.chapterAct = act;
        }
        const objectiveInput = () => {
            const player = this.resolvePresentActor(snap.actors, 'aren');
            return {
                snapshot: c, quests: QUESTS, interactions: INTERACTIONS, region, actors: snap.actors, movableObjects: snap.movableObjects, player: player?.position ?? null,
                nurseryEscortActive: snap.nurseryEscortActive,
                basis: this.renderer ? this.renderer.getInputBasis() : null, runtime: this.campaignDirector.chapterDefinition(),
                playerFacing: player?.facing ?? null,
            };
        };
        if (this.screen === 'game' && !this.entryShot) {
            const hud = objectiveHudOf(objectiveInput());
            if (hud) out.objectiveHud = hud;
        }
        if (this.screen === 'map' || this.screen === 'journal') {
            const area = areaMapOf({ ...objectiveInput(), regionName });
            if (area) out.areaMap = area;
        }
        return out;
    }
    /** A refused story choice (contradictory option) is shown on the choice screen itself. */
    private choiceError(): GameViewModel['error'] {
        return this.screen === 'choice' && this.choiceNotice ? { code: 'choice-rejected', message: this.choiceNotice, recoverable: true } : null;
    }
    // ---- Command wheel: GameUI-owned view, application-owned selection and time policy ----------------------------------
    private canOpenWheel(): boolean {
        return !!this.activeCompanionId && this.screen === 'game' && this.canPlayWorld() && !this.entryShot && this.worldBusy === 0 && !this.playerOutcome && !this.dialogue;
    }
    private openWheel(by: 'hold' | 'pointer'): void {
        if (!this.activeCompanionId) return;
        this.wheel.openFor(this.activeCompanionId);
        this.wheelOpenedBy = by;
        this.wheelCache = null;
        this.input.setExternalWheel(by === 'pointer');
    }
    /** Closes the wheel without commanding (Escape/B, blur, another panel, a transition). Callers render. */
    private cancelWheel(): void {
        if (!this.wheel.open) return;
        this.wheel.cancel();
        this.wheelOpenedBy = null;
        this.wheelCache = null;
        this.input.setExternalWheel(false);
    }
    /** Best target for a verb: the player's locked target when the simulation lists it, else the first valid one. */
    private pickWheelTarget(companionId: CompanionId, command: FieldCommand): CompanionTarget | undefined {
        const targets = this.combat.commandTargets(companionId, command);
        if (!targets.length) return undefined;
        const locked = this.combat.snapshot().targetId;
        return targets.find(target => target.kind === 'actor' && target.instanceId === locked) ?? targets[0];
    }
    private skillRequest(skill: CompanionSkill): { companionId: CompanionId; command: FieldCommand; target?: CompanionTarget } | null {
        const targets = this.combat.commandTargets(skill.companionId, skill.command);
        const eligible = targets.filter(target => skill.target === 'hostile' ? target.kind === 'actor'
            : skill.target === 'charge' ? target.kind === 'hazard' : target.kind === 'interaction');
        if (skill.target === 'object' && eligible.length === 0) return null;
        const locked = this.combat.snapshot().targetId;
        const target = eligible.find(candidate => candidate.kind === 'actor' && candidate.instanceId === locked) ?? eligible[0];
        return { companionId: skill.companionId, command: skill.command, ...(target ? { target } : {}) };
    }
    private wheelRequest(companionId: CompanionId, command: FieldCommand): { companionId: CompanionId; command: FieldCommand; target?: CompanionTarget } {
        const target = this.pickWheelTarget(companionId, command);
        return target ? { companionId, command, target } : { companionId, command };
    }
    private wheelAvailability(companionId: CompanionId, command: FieldCommand): { available: boolean; reason: string | null } {
        const result = this.combat.commandAvailability(this.wheelRequest(companionId, command));
        return { available: result.available, reason: result.reason };
    }
    /** Commits the selection once (or refuses with the simulation's reason); the wheel is closed afterwards either way. */
    private finishWheel(): void {
        const outcome = this.wheel.release((companionId, _sector, command) => this.wheelAvailability(companionId, command).available);
        this.wheelOpenedBy = null;
        this.wheelCache = null;
        this.input.setExternalWheel(false);
        if (outcome.kind === 'cancel') return;
        const companionId = outcome.companionId;
        if (outcome.kind === 'rejected') {
            this.ui.notify(this.wheelAvailability(companionId, outcome.command).reason ?? 'That command is unavailable.');
            return;
        }
        if (!this.combat.commandCompanion(this.wheelRequest(companionId, outcome.command)))
            this.ui.notify(this.wheelAvailability(companionId, outcome.command).reason ?? 'That command is unavailable.');
    }
    /** One frame of wheel input. Returns true while the wheel owns the frame (open, or closing on it): gameplay input is frozen. */
    private driveWheel(actions: ActionFrame): boolean {
        const wasOpen = this.wheel.open;
        let changed = false;
        if (!wasOpen && actions.commandWheelHeld && this.canOpenWheel()) { this.openWheel('hold'); changed = true; }
        if (this.wheel.open) {
            if (actions.wheelCancelPressed || actions.pausePressed) { this.cancelWheel(); changed = true; }
            else {
                if (actions.wheelDigit !== null) { this.wheel.selectSector(actions.wheelDigit); changed = true; }
                if (actions.wheelAimX !== 0 || actions.wheelAimY !== 0) {
                    const before = this.wheel.selectedSector;
                    this.wheel.aim(actions.wheelAimX, actions.wheelAimY);
                    changed ||= before !== this.wheel.selectedSector;
                }
                if (actions.commandWheelReleased && this.wheelOpenedBy === 'hold') { this.finishWheel(); changed = true; }
            }
        }
        if (changed) this.render();
        return wasOpen || this.wheel.open;
    }
    private handleWheelAction(action: Extract<UIAction, { type: 'wheel' }>): void {
        switch (action.op) {
            case 'open':
                if (!this.wheel.open && this.canOpenWheel()) this.openWheel('pointer');
                break;
            case 'cancel':
                this.cancelWheel();
                break;
            case 'sector':
                this.wheel.selectSector(action.sector ?? null);
                break;
            case 'commit':
                if (this.wheel.open) { this.wheel.selectSector(action.sector ?? null); this.finishWheel(); }
                break;
        }
        this.render();
    }
    /** The sole companion's eight verbs, using simulation-owned availability and cooldowns. */
    private wheelModel(snap: CombatSnapshot): GameViewModel['wheel'] | undefined {
        const companionId = this.activeCompanionId;
        if (this.screen !== 'game' || !this.worldReady || !companionId) return undefined;
        const key = this.combat.simulationTick + '|' + companionId + '|' + this.wheel.open + '|' + this.wheel.selectedSector;
        if (this.wheelCache?.key === key) return this.wheelCache.model;
        const selected = this.wheel.selectedSector;
        const aimed = selected !== null ? this.pickWheelTarget(companionId, WHEEL_COMMANDS[selected]!) : undefined;
        const locked = snap.actors.find(actor => actor.id === snap.targetId);
        const model: NonNullable<GameViewModel['wheel']> = {
            open: this.wheel.open, selectedSector: selected, tokens: this.combat.companions.tokens.available,
            target: aimed ? this.combat.targetLabel(aimed) : locked ? locked.id.toString().replaceAll('-', ' ') : null,
            companion: {
                companionId, name: companionDisplayName(companionId),
                commands: this.wheel.open ? WHEEL_COMMANDS.map(command => {
                    const result = this.wheelAvailability(companionId, command);
                    return { command, label: companionSkillFor(companionId, command)?.label ?? command.charAt(0).toUpperCase() + command.slice(1), available: result.available, reason: result.reason };
                }) : [],
            },
        };
        this.wheelCache = { key, model };
        return model;
    }
    // ---- Durable story: the Director owns the queue, line and pending choice; the application only presents it -----------
    private chapterStoryHead(): { beatId: string; lineIndex: number } | null {
        const resume = this.campaign?.session.resume;
        if (!resume) return null;
        if (resume.dialogue) return resume.dialogue;
        const head = resume.requiredBeatQueue[0];
        return head ? { beatId: head, lineIndex: 0 } : null;
    }
    private canPresentStoryNow(): boolean {
        if (this.loading.active || this.sceneBlocked || this.entryShot || this.worldBusy > 0 || this.playerOutcome || this.error) return false;
        if (!this.worldReady || !this.renderer || !this.region || !this.campaign || this.region.id !== this.campaign.regionId) return false;
        return this.screen === 'game' || this.screen === 'dialogue' || this.screen === 'choice';
    }
    /**
     * Presents exactly what the Director's resume state says: the current line of the head beat, then the pending pact
     * choice. Reloading restores both; skipping a beat never answers a pending choice.
     */
    private presentChapterStory(): void {
        if (this.presentingStory || !this.campaign || !this.canPresentStoryNow()) return;
        this.presentingStory = true;
        try {
            const head = this.chapterStoryHead();
            if (head) {
                const beat = STORY_DIALOGUE[head.beatId];
                if (!beat) throw new Error('The story beat ' + head.beatId + ' is not authored.');
                if (this.dialogue?.id !== beat.id || this.dialogueLineIndex !== head.lineIndex || this.screen !== 'dialogue') {
                    this.dialogue = beat;
                    this.dialogueLineIndex = head.lineIndex;
                    this.choice = null;
                    this.choiceFromResume = false;
                    this.setScreen('dialogue');
                }
                return;
            }
            const pending = this.campaign.session.resume.pendingChoiceId;
            if (pending) {
                const options = CAMPAIGN_CHOICES[pending] ?? [];
                if (!options.length) throw new Error('The story choice ' + pending + ' has no authored options.');
                if (this.choice?.id !== pending || this.screen !== 'choice') {
                    this.dialogue = null;
                    this.dialogueLineIndex = 0;
                    this.choice = { id: pending, title: pending.replace(/-pact$/, '').replace(/^./, letter => letter.toUpperCase()) + '’s Pact', options };
                    this.choiceFromResume = true;
                    this.setScreen('choice');
                }
                return;
            }
            if (this.screen === 'dialogue') {
                this.dialogue = null;
                this.dialogueLineIndex = 0;
                this.setScreen('game');
            } else if (this.screen === 'choice' && this.choiceFromResume) {
                this.choice = null;
                this.choiceFromResume = false;
                this.setScreen('game');
            }
        } catch (error) {
            this.showWorldError(error, 'region-load');
        } finally {
            this.presentingStory = false;
        }
    }
    /** Acknowledges the displayed line (or, with `skip`, the whole beat) through the Director; stale or double presses are ignored. */
    private async advanceStoryLine(skip: boolean, beatId: string | undefined): Promise<void> {
        const head = this.chapterStoryHead();
        if (!head || this.storyBusy || (beatId !== undefined && beatId !== head.beatId)) return;
        this.storyBusy = true;
        try {
            this.campaign = await this.campaignDirector.advanceStory({ beatId: head.beatId, lineIndex: head.lineIndex, skip });
        } finally {
            this.storyBusy = false;
        }
        this.render();
    }
    // ---- Party and commands ---------------------------------------------------------------------------------------------
    /** Asset loading is staged while paused; assignment never resets the live hero or encounter. */
    private async assignParty(companionId: CompanionId): Promise<void> {
        if (this.partyChanging || !this.campaign || !this.region || !this.renderer || this.campaign.party.companionId === companionId) return;
        if (this.combat.companionChangeBlocked) {
            this.ui.notify('The party cannot change during an active encounter.');
            return;
        }
        this.partyChanging = true;
        let staged: PreparedCompanionParty | undefined;
        try {
            const generation = this.worldGeneration, lifecycle = this.lifecycleGeneration;
            const party = { companionId };
            const authored = REGIONS.find(candidate => candidate.id === this.region!.id)!;
            const entities = this.region.entities.filter(entity => !entity.id.includes('__party_'));
            const used = new Set(entities.map(entity => entity.assetId));
            const retired = this.activeCompanionId ? ACTORS[this.activeCompanionId]!.assetId : null;
            const base = { ...this.region, assetIds: this.session.kind === 'chapters' ? authored.assetIds : this.region.assetIds.filter(id => id !== retired || used.has(id)), entities };
            const hero = this.combat.snapshot().actors.find(actor => actor.allegiance === 'player');
            const projection = projectPartyIntoRegion({ region: base, party, companions: this.campaign.companions, worldFacts: this.campaign.worldFacts, spawnPosition: hero?.position ?? null });
            const region = { ...base, assetIds: [...new Set([...base.assetIds, ...projection.assetIds])], entities: [...base.entities, ...projection.entities] };
            const assets = await this.loadWorldManifest(region, this.selectedHero, projection.assetIds);
            if (!this.isWorldGenerationCurrent(generation, lifecycle)) return;
            staged = await this.renderer.prepareCompanionParty(region, assets);
            if (!this.isWorldGenerationCurrent(generation, lifecycle)) return;
            const commitEngine = this.combat.prepareCompanionParty(region, companionId);
            this.campaign = await this.campaignDirector.selectParty(companionId);
            if (!this.isWorldGenerationCurrent(generation, lifecycle)) return;
            commitEngine(); staged.commit();
            this.region = region; this.manifest = assets; this.manifestPromise = Promise.resolve(assets); this.activeCompanionId = companionId;
            await this.rememberCompanion(this.selectedHero, companionId);
        } catch (error) { this.ui.notify(errorText(error)); }
        finally { staged?.dispose(); this.partyChanging = false; this.render(); }
    }
    private async rememberCompanion(heroId: HeroId, companionId: CompanionId): Promise<void> {
        if (this.settings.heroCompanions[heroId] === companionId) return;
        this.settings = { ...this.settings, heroCompanions: { ...this.settings.heroCompanions, [heroId]: companionId } };
        this.render();
        await this.saves.saveSettings(this.settings, this.bindings);
    }
    /** One command request to the simulation; Ask/Signal remain the later-act interaction abilities. */
    private issueCommand(companionId: CompanionId, command: FieldCommand | 'ask' | 'signal', targetId?: ActorId): boolean {
        if (command === 'ask' || command === 'signal') return this.combat.useAbility(command, targetId);
        return this.combat.commandCompanion({ companionId, command, ...(targetId ? { target: { kind: 'actor', instanceId: targetId } as const } : {}) });
    }
    // ---- Authored encounter and checkpoint transactions -----------------------------------------------------------------
    /** Queues the engine's one-shot spatial intents behind pending event commits; the simulation pauses while they run. */
    private queueChapterIntents(intents: readonly ChapterSpatialIntent[]): void {
        if (this.session.kind !== 'chapters' || !intents.length) return;
        this.chapterIntents.push(...intents);
        if (this.intentRunning) return;
        this.intentRunning = true;
        this.worldBusy++;
        const generation = this.worldGeneration, lifecycleGeneration = this.lifecycleGeneration;
        this.durableEvents = this.durableEvents.then(() => this.runChapterIntents(generation, lifecycleGeneration));
    }
    private async runChapterIntents(generation: number, lifecycleGeneration: number): Promise<void> {
        try {
            while (this.chapterIntents.length && this.isWorldGenerationCurrent(generation, lifecycleGeneration)) {
                await this.applyChapterIntent(this.chapterIntents.shift()!, generation, lifecycleGeneration);
            }
        } finally {
            this.chapterIntents = [];
            this.intentRunning = false;
            if (this.isWorldGenerationCurrent(generation, lifecycleGeneration)) this.worldBusy = Math.max(0, this.worldBusy - 1);
        }
    }
    /**
     * Spatial triggers come from simulation positions; the Director rechecks objective, prerequisites and checkpoint ids and
     * commits (and saves) before the engine reacts. A refused intent is not an error: the engine re-arms it on re-entry.
     */
    private async applyChapterIntent(intent: ChapterSpatialIntent, generation: number, lifecycleGeneration: number): Promise<void> {
        const definition = this.campaignDirector.chapterDefinition();
        if (!definition || !this.campaign) return;
        try {
            if (intent.kind === 'checkpoint') {
                if (!definition.checkpoints.some(item => item.id === intent.definitionId)) return;
                this.campaign = await this.campaignDirector.reachCheckpoint(intent.definitionId);
                return;
            }
            const entry = definition.encounterEntries.find(item => item.id === intent.definitionId);
            if (!entry || this.combat.snapshot().encounterId === entry.encounterId) return;
            this.campaign = await this.campaignDirector.beginChapterEncounter(entry.encounterId, entry.checkpointId);
            await this.startChapterEncounter(entry.encounterId, generation);
        } catch (error) {
            if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
            if (error instanceof SaveRepositoryError || isTerminalAssetError(error)) this.showWorldError(error, 'region-load');
        }
    }
    private frame = (nowMs: number): void => {
        if (this.disposed || this.suspended)
            return;
        this.raf = requestAnimationFrame(this.frame);
        const gamepad = [...(navigator.getGamepads?.() ?? [])].find(pad => pad?.connected) ?? null;
        this.ui.updateGamepad(gamepad);
        const now = nowMs / 1000;
        const delta = this.previousTime ? Math.min(Math.max(0, now - this.previousTime), STEP * MAX_STEPS) : 0;
        this.previousTime = now;
        if (this.screen === 'hero-select' && this.heroPreview && !document.hidden) this.heroPreview.update(delta);
        if (this.screen === 'title' && this.titleStage && !document.hidden) this.titleStage.stage.update(delta);
        if ((this.screen === 'companions' || this.screen === 'hero-select') && !document.hidden && delta > 0) {
            for (const [handle, host] of this.companionPreviews) {
                if (!host.isConnected) {
                    handle.dispose();
                    this.companionPreviews.delete(handle);
                    continue;
                }
                handle.update(delta);
            }
        }
        if (this.playerOutcome && this.renderer && this.outcomeSnapshot && !document.hidden) {
            this.outcomeElapsed += delta;
            this.renderer.updatePlayerOutcome(this.outcomeElapsed);
            if (this.playerOutcome === 'victory') {
                this.renderer.updateWaystone(delta, true);
                if (this.screen === 'game' && this.outcomeElapsed >= 1.2) this.setScreen('stage-complete');
            }
            if (this.playerOutcome === 'defeat' && this.outcomeElapsed >= 0.8) {
                this.damageNumbers.clear();
                this.damageNumbers.element.hidden = true;
            } else if (this.playerOutcome === 'defeat') {
                this.damageNumbers.update(this.outcomeSnapshot.worldClock, this.renderer.camera, this.root.clientWidth, this.root.clientHeight, this.settings.reducedMotion);
            }
            this.renderer.render();
            return;
        }
        if (this.entryShot) {
            this.stepEntryShot(delta);
            return;
        }
        if (this.screen !== 'game' || !this.canPlayWorld() || !this.renderer || !this.campaign || document.hidden || this.worldBusy > 0 || this.partyChanging) {
            this.accumulator = 0;
            this.previousRenderSnapshot = undefined;
            this.renderSnapshot = undefined;
            return;
        }
        if (this.tutorial) {
            // A how-to-play card is open: the world stays on screen but does not advance until it is dismissed.
            this.accumulator = 0;
            this.previousRenderSnapshot = undefined;
            this.renderer.render();
            return;
        }
        if (this.renderer.bossRevealActive) {
            // Boss reveal: the camera presents the boss while the world holds still; actors keep animating in place.
            this.accumulator = 0;
            this.previousRenderSnapshot = undefined;
            this.input.clear();
            const held = this.renderSnapshot ?? this.combat.snapshot();
            this.renderer.sync(held.actors, held, delta);
            this.renderer.render();
            return;
        }
        // The open command wheel slows the world by scaling the fixed-step accumulator; the simulation itself stays deterministic.
        this.accumulator = Math.min(this.accumulator + delta * (this.wheel.open ? WHEEL_TIME_SCALE : 1), STEP * MAX_STEPS);
        let steps = 0;
        while (this.screen === 'game' && this.worldBusy === 0 && !this.partyChanging && this.accumulator + 1e-9 >= STEP && steps < MAX_STEPS) {
            this.simulateTick();
            steps++;
            if (this.screen !== 'game') {
                this.accumulator = 0;
                break;
            }
            this.accumulator -= STEP;
        }
        if (this.screen === 'game' && steps === MAX_STEPS) {
            this.accumulator = 0;
        }
        if (this.screen === 'game') {
            const snapshot = this.renderSnapshot ?? this.combat.snapshot();
            this.renderSnapshot = snapshot;
            const alpha = this.previousRenderSnapshot ? this.accumulator / STEP : 1;
            this.renderer.sync(snapshot.actors, snapshot, delta, this.previousRenderSnapshot, alpha);
            this.maybeRevealBoss(snapshot);
            const camera = this.renderer.camera;
            camera.getWorldDirection(this.listenerForward);
            this.presentation?.update(snapshot.worldClock, { position: camera.position, forward: this.listenerForward, up: camera.up });
            this.presentation?.updateActors(snapshot.actors);
            this.presentation?.updateCombat(snapshot, alpha);
            for (const gate of this.renderer.drainGateOpenings()) this.presentation?.effects.impactBurst(gate, 'sap', 2.6);
            this.ui.setGateContact(this.renderer.closestClosedGateDistance <= 1.5);
            this.renderer.updateWaystone(delta, snapshot.encounterStatus?.trial?.complete === true);
            this.damageNumbers.update(snapshot.worldClock, camera, this.root.clientWidth, this.root.clientHeight, this.settings.reducedMotion);
            this.monsterLabels.update(snapshot, camera, this.root.clientWidth, this.root.clientHeight, id => this.renderer?.resolveSocket(id, 'cast'));
            this.combatReadability.update(snapshot, camera, this.root.clientWidth, this.root.clientHeight);
            this.renderer.render();
            if (steps > 0) this.ui.render(this.model(snapshot));
            const due = this.wheel.open ? null : dueTutorial(snapshot, this.settings.seenTutorials);
            if (due) {
                this.tutorial = due;
                this.render();
            }
        }
    };
    private simulateTick(): void {
        const sampled = this.input.sample();
        const wheelOpen = this.driveWheel(sampled);
        if (!wheelOpen) {
            if (sampled.pausePressed) {
                this.setScreen('pause');
                return;
            }
            if (sampled.mapPressed) {
                this.setScreen('map');
                return;
            }
            if (sampled.journalPressed) {
                this.setScreen('journal');
                return;
            }
            if (sampled.companionsPressed) {
                this.setScreen('companions');
                return;
            }
        } else {
            this.pendingInteraction = null;
            this.pendingAbility = null;
        }
        // The wheel freezes the player (movement, attacks, interaction) for as long as it is open and for the frame it closes on.
        const actions = wheelOpen ? FROZEN_ACTIONS : sampled;
        const before = this.combat.snapshot();
        const player = this.resolvePresentActor(before.actors, 'aren');
        if (!player)
            return;
        this.interaction = this.nearestInteraction(before, player.position);
        const route = this.nearestRoute(player.position);
        const currentInteractionDefinition = this.interaction ? INTERACTIONS.find(item => item.id === this.interaction?.interactionId) : undefined;
        const activateCurrentInteraction = actions.interactPressed || actions.abilityPressed && currentInteractionDefinition?.inputHint === 'ability';
        const selectedRoute = this.interaction?.interactionId === route?.id ? route : undefined;
        const pendingTraversal = Boolean(selectedRoute && this.pendingInteraction?.interactionId === selectedRoute.id && this.pendingInteraction.targetId === selectedRoute.id);
        const requested = this.combat.isTraversing || pendingTraversal ? null : this.pendingInteraction ?? (activateCurrentInteraction && this.interaction && !selectedRoute ? { interactionId: this.interaction.interactionId, targetId: this.interaction.targetId } : null);
        this.pendingInteraction = null;
        const traversalPressed = (actions.interactPressed || pendingTraversal) && !requested && Boolean(selectedRoute);
        const requestedDefinition = requested ? INTERACTIONS.find(item => item.id === requested.interactionId) : undefined;
        if (requested && this.session.kind === 'chapters' && HUB_SERVICE_INTERACTION_IDS.some(id => id === requested.interactionId)
            && this.interaction?.interactionId === requested.interactionId && this.interaction.targetId === requested.targetId) {
            this.setScreen('hub');
            return;
        }
        if (requestedDefinition?.success.type === 'choice') {
            const choiceId = requestedDefinition.success.choiceId;
            const options = (CAMPAIGN_CHOICES[choiceId] ?? []).filter(option => requestedDefinition.success.type === 'choice' && requestedDefinition.success.optionIds.includes(option.id)
                && (choiceId !== 'final-ending' || option.id !== 'living_pact' || this.campaignDirector.ending().available)
                && (choiceId !== 'solkar-listens' || option.id !== 'listen' || before.actors.some(actor => actor.archetypeId === 'solkar' && actor.visible && !actor.downed && !actor.possessed && actor.allegiance !== 'hostile')));
            if (!options.length)
                throw new Error('The authored choice has no available options.');
            this.choice = { id: choiceId, title: requestedDefinition.promptLabel, options };
            this.setScreen('choice');
            return;
        }
        const requestedCleansePulse = requestedDefinition?.actionId === 'cleanse-pulse';
        const nearbyActionInteraction = this.interaction && currentInteractionDefinition?.inputHint === 'heavy' ? currentInteractionDefinition : undefined;
        const actionInteraction = requested && (requestedDefinition?.inputHint === 'heavy' || requestedCleansePulse) ? requested : !requested && nearbyActionInteraction ? this.interaction : null;
        const waitingForRequiredInput = requestedCleansePulse || requestedDefinition?.inputHint === 'heavy' || requestedDefinition?.inputHint === 'ability' && !actions.abilityPressed || Boolean(requestedDefinition?.playerActionId) || Boolean(requestedDefinition?.requiresCompanionCommand && !actions.abilityPressed);
        if (requested && !waitingForRequiredInput) {
            const command = requestedDefinition?.requiresCompanionCommand;
            const succeeded = command
                ? this.combat.commandCompanion({ companionId: command.companionId, command: command.command, target: { kind: 'interaction', interactionId: requested.interactionId, targetId: requested.targetId } })
                : this.combat.resolveInteraction(requested.interactionId, requested.targetId);
            if (!succeeded) {
                this.error = { code: 'interaction-unavailable', message: 'The authored interaction is not available at this position or under the current world conditions.', recoverable: true };
                this.loading = { active: false, label: 'Interaction unavailable', progress: null, operationId: 'region-load' };
                this.screen = 'loading';
                this.combat.setTimePolicy('paused');
                this.render();
                return;
            }
        }
        const abilityInteractionActivated = Boolean(requested && requestedDefinition?.inputHint === 'ability' && actions.abilityPressed);
        const ability = this.pendingAbility ?? (actions.abilityPressed && !abilityInteractionActivated ? 'contextual' : '');
        this.pendingAbility = null;
        const inputBasis = this.renderer!.getInputBasis();
        const input: CombatInput = {
            tick: this.combat.simulationTick + 1, move: { x: actions.moveX, y: 0, z: actions.moveZ },
            dodgePressed: actions.dodgePressed, jumpPressed: actions.jumpPressed, sprintHeld: actions.sprintHeld,
            lockOnPressed: actions.lockOnPressed, lockOnHeld: actions.lockOnHeld,
            lightPressed: actions.lightPressed, heavyPressed: actions.heavyPressed,
            heavyHeld: actions.heavyHeld, heavyReleased: actions.heavyReleased, interactPressed: traversalPressed,
            rangedPressed: actions.rangedPressed, rangedHeld: actions.rangedHeld, rangedReleased: actions.rangedReleased, ultimatePressed: actions.ultimatePressed,
            interactTargetId: actionInteraction?.targetId ?? requested?.targetId ?? this.interaction?.targetId,
            interactionId: actionInteraction?.interactionId,
            interactionTargetId: actionInteraction?.targetId,
            traversalId: traversalPressed ? route?.id : undefined,
            abilityPressed: ability || undefined,
            tetherPressed: ability === 'root-tether' || ability === 'contextual' && before.skills.some(skill => skill.id === 'root_tether'),
            cleansePressed: ability === 'cleanse' || ability === 'contextual' && before.skills.some(skill => skill.id === 'cleanse') || abilityInteractionActivated && requestedCleansePulse,
            ferocityPressed: ability === 'ferocity', corruptionPressed: ability === 'corruption',
        };
        this.combat.step(input, STEP, { forward: inputBasis.forward, right: inputBasis.right });
        this.syncStoryState();
        const cues = this.combat.drainPresentationCues();
        if (cues.length)
            this.presentation?.consumeTick(cues);
        const events = this.combat.consumeEvents();
        for (const event of events) {
            if (event.kind === 'companion' && event.actionId === 'vara-warning') this.ui.notify(event.message);
        }
        this.damageNumbers.consume(events);
        this.presentDamageFeedback(events);
        this.queueEvents(this.combat.consumeWorldEvents());
        this.queueChapterIntents(this.combat.consumeChapterIntents());
        const after = this.combat.snapshot();
        this.previousRenderSnapshot = before;
        this.renderSnapshot = after;
        const afterPlayer = this.resolvePresentActor(after.actors, 'aren');
        this.interaction = afterPlayer ? this.nearestInteraction(after, afterPlayer.position) : undefined;
        if (after.player.vitality <= 0) this.presentPlayerOutcome('defeat', after);
        else this.checkStageArrival(after);
    }
    /** Presentation-only vitality-loss feedback: camera shake for Aren and a rim flash on every damaged actor (the red vignette pulses inside DamageNumbers). */
    private presentDamageFeedback(events: readonly CombatEvent[]): void {
        if (!this.renderer) return;
        for (const event of events) {
            const damage = event.damage;
            if (!damage || !(damage.amount > 0)) continue;
            if (damage.targetId !== 'aren') { this.renderer.flashActor(damage.targetId, ACTOR_HIT_RIM, 1.3, 0.18, 'hit'); continue; }
            this.renderer.addCameraShake(Math.min(0.32, 0.07 + damage.amount * 0.011), 0.3, 20);
            this.renderer.flashActor('aren', PLAYER_HIT_RIM, 1.6, 0.24, 'hit');
        }
    }
    private destinationHud(snapshot: CombatSnapshot): GameViewModel['hud']['destination'] {
        const playtest = trialMapOf(this.session);
        if (!playtest || !this.stageGoal || this.stageCompleted || !this.renderer) return undefined;
        const player = this.resolvePresentActor(snapshot.actors, 'aren');
        if (!player) return undefined;
        const trial = snapshot.encounterStatus?.trial;
        const stage = trial && !trial.complete ? playtest.trialSet.trials[trial.stage - 1] : undefined;
        const destination = stage?.monsterPosition ?? this.stageGoal.position;
        const dx = destination.x - player.position.x;
        const dz = destination.z - player.position.z;
        const basis = this.renderer.getInputBasis();
        return {
            label: stage ? stage.title + ' — Gate Locked' : playtest.stage.exitName + ' — Open',
            distanceMeters: Math.hypot(dx, dz),
            bearingDegrees: Math.atan2(dx * basis.right.x + dz * basis.right.z,
                dx * basis.forward.x + dz * basis.forward.z) * 180 / Math.PI,
        };
    }
    private checkStageArrival(snapshot: CombatSnapshot): void {
        if (this.session.kind !== 'trials' || !this.stageGoal || this.stageCompleted || this.screen !== 'game'
            || !this.canPlayWorld() || snapshot.player.vitality <= 0) return;
        if (!snapshot.encounterStatus?.trial?.complete) return;
        const player = this.resolvePresentActor(snapshot.actors, 'aren');
        if (!player || !this.stageGoal.contains(player.position)) return;
        this.stageCompleted = true;
        this.playtestProgress.complete(trialMapOf(this.session)!.id);
        this.combat.finishLocalStage();
        this.presentPlayerOutcome('victory', snapshot);
    }
    private presentPlayerOutcome(outcome: 'victory' | 'defeat', snapshot: CombatSnapshot): void {
        if (this.playerOutcome || !this.renderer) return;
        this.playerOutcome = outcome;
        this.outcomeElapsed = 0;
        this.outcomeSnapshot = snapshot;
        this.presentation?.onRegionUnload();
        this.appAudio.playStinger(outcome);
        if (outcome === 'victory') this.damageNumbers.clear();
        this.interaction = undefined;
        if (outcome === 'victory') {
            this.renderer.beginWaystoneArrival();
            this.combat.setTimePolicy('paused');
            this.input.clear();
            this.input.setEnabled(false);
        }
        this.renderer.sync(snapshot.actors, snapshot, 0);
        this.renderer.startPlayerOutcome(outcome);
        this.renderer.render();
        if (outcome === 'defeat') this.setScreen('defeat');
    }
    private resolvePresentActor(actors: readonly ActorSnapshot[], identity: string, allowPossessed = false): ActorSnapshot | undefined {
        const isPresent = (actor: ActorSnapshot) => actor.visible && !actor.downed && (allowPossessed || !actor.possessed);
        const exact = actors.find(actor => actor.id === identity && isPresent(actor));
        if (exact && !Object.hasOwn(ACTORS, identity) && exact.archetypeId !== identity) return exact;
        const archetypeMatches = actors.filter(actor => actor.archetypeId === identity && isPresent(actor));
        return archetypeMatches.length === 1 ? archetypeMatches[0] : undefined;
    }
    private nearestInteraction(snapshot: CombatSnapshot, position: { x: number; y: number; z: number }): GameViewModel['hud']['interaction'] {
        if (this.combat.isTraversing) return undefined;
        if (!this.region || !this.campaign) return undefined;
        const actors = snapshot.actors;
        let found: GameViewModel['hud']['interaction'];
        let nearest = Infinity;
        for (const interaction of INTERACTIONS) {
            if (interaction.regionId !== this.region.id || !interaction.requiresFacts.every(fact => this.campaign?.worldFacts[fact] === true) || interaction.requiresActors.some(id => !this.resolvePresentActor(actors, id))) continue;
            if (interaction.questId && this.campaign.completedQuestIds.includes(interaction.questId)
                || !interaction.repeatable && this.campaign.worldFacts[`interaction:${interaction.id}`] === true
                // Fragment, restoration and rescue interactions never write `interaction:<id>`; the engine's event record covers
                // them, and also the window before a semantic event's campaign commit lands.
                || this.combat.interactionSpent(interaction.id)) continue;
            if (snapshot.nurseryEscortActive && interaction.id === NURSERY_ESCORT.interactionId) continue;
            const delivery = this.region.deliveries?.find(item => item.pickupInteractionId === interaction.id || item.deliveryInteractionId === interaction.id);
            if (delivery) {
                const object = snapshot.movableObjects.find(item => item.objectId === delivery.id);
                if (!object || object.phase === 'settled'
                    || interaction.id === delivery.pickupInteractionId && object.phase !== 'resting'
                    || interaction.id === delivery.deliveryInteractionId && object.phase !== 'in-flight') continue;
            }
            const movableDefinition = this.region.movableObjects.find(object => object.id === interaction.targetId);
            const movable = movableDefinition ? snapshot.movableObjects.find(object => object.objectId === movableDefinition.id) : undefined;
            if (movableDefinition) {
                const koroInteraction = INTERACTIONS.find(candidate => candidate.id === movableDefinition.koroInteractionId);
                const requirement = koroInteraction?.requiresCompanionCommand;
                const koroReady = Boolean(requirement && this.activeCompanionId === requirement.companionId && this.resolvePresentActor(actors, requirement.companionId));
                if (interaction.id === movableDefinition.koroInteractionId && !koroReady) continue;
                if (interaction.id === movableDefinition.playerInteractionId && koroReady) continue;
                if (!movable || movable.phase !== 'resting' || this.campaign.worldFacts[movableDefinition.movedFactId] === true) continue;
            }
            const actor = this.resolvePresentActor(actors, interaction.targetId);
            const targetEntity = this.region.entities.find(entity => !entity.actorId && (entity.id === interaction.targetId || entity.interactionId === interaction.id));
            const hasActorIdentity = Object.hasOwn(ACTORS, interaction.targetId) || this.region.entities.some(entity => entity.id === interaction.targetId && entity.actorId !== undefined);
            if (!actor && !movable && (hasActorIdentity || !targetEntity)) continue;
            const target = actor?.position ?? movable?.position ?? targetEntity?.position;
            if (!target) continue;
            const distance = Math.hypot(target.x - position.x, target.z - position.z);
            if (distance <= interaction.radiusMeters && distance < nearest) {
                nearest = distance;
                found = { interactionId: interaction.id, targetId: actor?.id ?? movableDefinition?.id ?? interaction.targetId, label: interaction.promptLabel, actionId: interaction.actionId, inputHint: interaction.inputHint, activation: interaction.activation, requiresCompanionCommand: interaction.requiresCompanionCommand, playerActionId: interaction.playerActionId };
            }
        }
        const route = this.nearestRoute(position);
        if (route && Math.hypot(route.from.x - position.x, route.from.y - position.y, route.from.z - position.z) < nearest) {
            const label = { walk: 'Follow the marked path', vault: 'Vault', 'low-ledge': 'Climb low ledge', slide: 'Slide', swing: 'Swing' }[route.traversal!.kind];
            return { interactionId: route.id, targetId: route.id, label, actionId: route.traversalActionId, inputHint: 'interact' };
        }
        return found;
    }
    private refreshInteraction(): void {
        const snapshot = this.combat.snapshot();
        const player = this.resolvePresentActor(snapshot.actors, 'aren');
        this.interaction = player ? this.nearestInteraction(snapshot, player.position) : undefined;
    }
    private nearestRoute(position: {
        x: number;
        y: number;
        z: number;
    }) { return this.combat.nearestTraversal(position); }
    private onBlur = () => { this.cancelWheel(); this.input.clear(); if (this.screen === 'game')
        this.setScreen('pause'); };
    private onVisibility = () => { this.previousTime = 0; if (document.hidden) {
        this.cancelWheel();
        this.input.clear();
        if (this.screen === 'game')
            this.setScreen('pause');
    } };
    private onPageHide = (event: PageTransitionEvent) => {
        if (this.disposed) return;
        this.input.clear();
        if (event.persisted) {
            if (this.suspended) return;
            this.suspended = true;
            if (this.screen === 'game') this.setScreen('pause');
            cancelAnimationFrame(this.raf);
            this.raf = 0;
        } else this.dispose();
    };
    private onPageShow = (event: PageTransitionEvent) => {
        if (!event.persisted || this.disposed || !this.suspended) return;
        this.suspended = false;
        this.previousTime = 0;
        this.accumulator = 0;
        this.raf = requestAnimationFrame(this.frame);
    };
    dispose(): void {
        if (this.disposed)
            return;
        this.disposed = true;
        this.lifecycleGeneration++;
        this.combat.setTimePolicy('paused');
        cancelAnimationFrame(this.raf);
        this.raf = 0;
        this.overlay.removeEventListener('pointerdown', this.onUserGesture);
        this.overlay.removeEventListener('keydown', this.onUserGesture);
        this.input.dispose();
        this.ui.destroy();
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.releaseWorld();
        this.appAudio.dispose();
        this.damageNumbers.dispose();
        this.monsterLabels.dispose();
        this.combatReadability.dispose();
        this.saves.close();
        this.candidateSaves?.close();
        window.removeEventListener('pagehide', this.onPageHide);
        window.removeEventListener('pageshow', this.onPageShow);
        window.removeEventListener('blur', this.onBlur);
        document.removeEventListener('visibilitychange', this.onVisibility);
        this.world.remove();
        this.overlay.remove();
        if (mountedApplications.get(this.root) === this) {
            mountedApplications.delete(this.root);
            this.root.classList.remove('wc-app');
        }
    }
}
export function mountGameApplication(root: HTMLElement): GameApplication { return new GameApplication(root); }
