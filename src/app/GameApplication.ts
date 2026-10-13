import { AudioListener, Color, Vector3 } from 'three';
import { CampaignDirector, CampaignChoiceRejectedError, SaveRepository, SaveRepositoryError, REGIONS, QUESTS, DIALOGUE, CAMPAIGN_CHOICES, INTERACTIONS, ENVIRONMENT_RECIPES } from '../game/campaign/index.js';
import type { SaveSlotSummary } from '../game/campaign/index.js';
import type { AssetManifestEntry, CampaignSnapshot, CombatSnapshot, EnvironmentRecipeDefinition, GameSettings, GameViewModel, InputBindingMaps, RegionDefinition, RegionId, UIAction, WorldEvent, ActorSnapshot } from '../game/contracts.js';
import { DEFAULT_GAME_SETTINGS, DEFAULT_INPUT_BINDINGS, normalizeInputBindings, isCanonicalKeyboardRemap } from '../game/contracts.js';
import { CombatEngine, COMBAT_ACTION_CLIPS, type CombatEvent, type CombatInput } from '../game/combat/CombatEngine.js';
import { COMPANION_ROSTER } from '../game/companions/CompanionSystem.js';
import { ACTORS } from '../content/campaign.js';
import { mountGameUI, type GameUIInstance, type HeroPreviewController } from '../ui/GameUI.js';
import { GameRenderer, mountCompanionPreview, type CompanionPreviewHandle } from '../rendering/GameRenderer.js';
import { mountHeroPreview, type HeroPreviewHandle } from '../rendering/HeroPreview.js';
import { NativeAssetError } from '../rendering/NativeAssetLoader.js';
import { StoryPresentation } from '../effects/index.js';
import { ENDINGS, STORY_DIALOGUE } from '../content/story.js';
import {
  NARRATIVE_CUES,
  cueForObjective,
  isCueBeatAuthored,
} from '../content/narrative-cues.js';
import { RuntimeInput } from '../input/RuntimeInput.js';
import { DamageNumbers } from '../ui/DamageNumbers.js';
import { StageGoal } from './StageGoal.js';
import { TRIAL_GATE_ASSET_ID } from '../game/combat/CombatTrials.js';
import { WAYSTONE_ASSET_ID } from '../rendering/WaystoneVisual.js';
import { createCombatTrialRegion } from '../game/combat/TrialRegions.js';
import { ASSET_PLAYTESTS, assetPlaytestFromSearch, type AssetPlaytest } from './AssetPlaytests.js';
import { STORY_CHAPTERS } from './StoryChapters.js';
import { HEROES, heroById, isHeroId, type HeroId } from '../game/heroes.js';
import { browserPlaytestProgress } from './PlaytestProgress.js';
import { MonsterLabels } from '../ui/MonsterLabels.js';
const STEP = 1 / 60;
const MAX_STEPS = 5;
const MANIFEST_URL = '/assets/manifest.json';
/** Rim hues only (HitFlash normalises colour and caps the rim): red for Aren, warm gold for struck monsters. */
const PLAYER_HIT_RIM = new Color().setRGB(1, 0.1, 0.05);
const ACTOR_HIT_RIM = new Color().setRGB(1, 0.7, 0.25);
const COMMANDS = ['follow', 'stay', 'focus', 'defend', 'search', 'distract', 'special', 'recall'] as const;
type Screen = GameViewModel['screen'];
type Manifest = readonly AssetManifestEntry[];
type ActiveCompanionSlots = Partial<Pick<CampaignSnapshot['party'], 'combat' | 'utility' | 'scout'>>;
const mountedApplications = new WeakMap<HTMLElement, GameApplication>();
const OVERLAY_SCREENS: readonly Screen[] = ['pause', 'map', 'journal', 'companions', 'settings', 'credits'];
const WORLD_PANELS: readonly Screen[] = ['pause', 'map', 'journal', 'companions', 'dialogue', 'choice', 'ending', 'stage-complete', 'defeat'];
function endingViewModel(id: NonNullable<CampaignSnapshot['ending']>): NonNullable<GameViewModel['ending']> {
    const ending = ENDINGS[id];
    return { id: ending.id, title: ending.title, summary: ending.summary };
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
class AssetGateError extends Error {
    constructor(message: string) { super(message); this.name = 'AssetGateError'; }
}
function isTransientAssetHttpFailure(error: NativeAssetError): boolean {
    const status = /\bHTTP (\d{3})\b/.exec(error.message)?.[1];
    if (!status) return false;
    const code = Number(status);
    return code === 408 || code === 429 || code >= 500;
}
function isTerminalAssetError(error: unknown): boolean {
    return error instanceof AssetGateError || error instanceof NativeAssetError && !isTransientAssetHttpFailure(error);
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function isStringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(entry => typeof entry === 'string'); }
function isActionMap(value: unknown): value is Record<string, string | null> { return isRecord(value) && Object.values(value).every(clip => clip === null || typeof clip === 'string'); }
function isPlaytestAnimation(value: unknown): value is NonNullable<AssetManifestEntry['playtestAnimation']> {
    if (!isRecord(value) || !['biped', 'avian', 'quadruped'].includes(String(value.rigFamily))
        || !isStringArray(value.actionIds) || value.actionIds.length === 0
        || value.actionIds.some(actionId => actionId.length === 0) || new Set(value.actionIds).size !== value.actionIds.length
        || ['torsoBoneNames', 'armRootNames', 'legRootNames', 'wingRootNames', 'wingSecondaryBoneNames', 'limbRootNames'].some(key => key in value && !isStringArray(value[key]))
        || ('headBoneName' in value && typeof value.headBoneName !== 'string')) return false;
    if (value.rigFamily === 'biped') {
        const needsLegRoots = (value.actionIds as string[]).some(actionId => /run|jump/i.test(actionId));
        return Array.isArray(value.armRootNames) && value.armRootNames.length === 2
            && Array.isArray(value.torsoBoneNames) && value.torsoBoneNames.length > 0
            && (!needsLegRoots || Array.isArray(value.legRootNames) && value.legRootNames.length === 2);
    }
    if (value.rigFamily === 'avian') return Array.isArray(value.wingRootNames) && value.wingRootNames.length === 2;
    return Array.isArray(value.limbRootNames) && value.limbRootNames.length === 4;
}
function optionalNullableString(record: Record<string, unknown>, key: string): boolean { return !(key in record) || record[key] === null || typeof record[key] === 'string'; }
function isVector3Value(value: unknown): value is { x: number; y: number; z: number } {
    return isRecord(value) && typeof value.x === 'number' && Number.isFinite(value.x)
        && typeof value.y === 'number' && Number.isFinite(value.y)
        && typeof value.z === 'number' && Number.isFinite(value.z);
}
function isCoordinateTransform(value: unknown): boolean {
    return isRecord(value) && typeof value.scale === 'number' && Number.isFinite(value.scale) && value.scale > 0
        && isVector3Value(value.forward)
        && (!('originOffset' in value) || isVector3Value(value.originOffset));
}
function isManifestEntry(value: unknown): value is AssetManifestEntry {
    if (!isRecord(value))
        return false;
    return typeof value.id === 'string' && value.id.length > 0
        && ['native-glb', 'composed-recipe', 'procedural'].includes(String(value.sourceType))
        && ['character', 'environment', 'prop', 'vfx', 'audio', 'ui'].includes(String(value.kind))
        && isStringArray(value.lodIds) && isStringArray(value.sockets)
        && isStringArray(value.requiredActionIds) && isActionMap(value.actionToClipMapping)
        && typeof value.provenance === 'string' && value.provenance.length > 0
        && ['not-started', 'in-progress', 'verified', 'blocked'].includes(String(value.evidenceStatus))
        && optionalNullableString(value, 'runtimeUrl') && optionalNullableString(value, 'sourceHash')
        && optionalNullableString(value, 'sourceInputHash') && optionalNullableString(value, 'outputHash')
        && (!('playtestAnimation' in value) || isPlaytestAnimation(value.playtestAnimation))
        && (!('actorId' in value) || typeof value.actorId === 'string')
        && (!('variantOf' in value) || typeof value.variantOf === 'string')
        && (!('componentAssetIds' in value) || isStringArray(value.componentAssetIds))
        && (!('proceduralRecipeId' in value) || typeof value.proceduralRecipeId === 'string')
        && (!('coordinateTransform' in value) || value.coordinateTransform === null || isCoordinateTransform(value.coordinateTransform));
}
function isManifest(value: unknown): value is Manifest { return Array.isArray(value) && value.every(isManifestEntry); }
export class GameApplication {
    private assetPlaytest: AssetPlaytest | null = import.meta.env.DEV ? assetPlaytestFromSearch(window.location.search) : null;
    private readonly playtestProgress = browserPlaytestProgress();
    private selectedHero: HeroId = 'aren';
    private readonly root: HTMLElement;
    private readonly world = document.createElement('div');
    private readonly canvas = document.createElement('canvas');
    private readonly overlay = document.createElement('div');
    private readonly inputHost = document.createElement('div');
    private readonly wheel = document.createElement('div');
    private readonly input: RuntimeInput;
    private readonly saves = new SaveRepository();
    private readonly campaignDirector = new CampaignDirector({ saves: this.saves });
    private readonly combat = new CombatEngine();
    private readonly ui: GameUIInstance;
    private readonly damageNumbers: DamageNumbers;
    private readonly monsterLabels: MonsterLabels;
    private stageGoal: StageGoal | null = null;
    private stageCompleted = false;
    private playerOutcome: 'victory' | 'defeat' | null = null;
    private outcomeElapsed = 0;
    private outcomeSnapshot: CombatSnapshot | null = null;
    private manifestPromise: Promise<Manifest>;
    private campaign: CampaignSnapshot | null = null;
    private settings: GameSettings = { ...DEFAULT_GAME_SETTINGS };
    private bindings: InputBindingMaps = {
        keyboard: { ...DEFAULT_INPUT_BINDINGS.keyboard },
        gamepad: { ...DEFAULT_INPUT_BINDINGS.gamepad },
    };
    private slots: SaveSlotSummary[] = [];
    private pendingNewRunId: string | null = null;
    private pendingLoadSlotId: string | null = null;
    private pendingImportPayload: string | null = null;
    private pendingTravel: { regionId: RegionId; entranceId: string } | null = null;
    private manifest: Manifest = [];
    private renderer: GameRenderer | null = null;
    private presentation: StoryPresentation | null = null;
    private readonly companionPreviews = new Map<CompanionPreviewHandle, HTMLElement>();
    private heroPreview: HeroPreviewHandle | null = null;
    private region: RegionDefinition | null = null;
    private activeCompanionSlots: ActiveCompanionSlots = {};
    private screen: Screen = 'title';
    private readonly screenHistory: Screen[] = [];
    private worldReady = false;
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
    private readonly onUserGesture = () => { void this.presentation?.unlockAudio(); };
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
        this.wheel.className = 'wc-command-wheel';
        this.wheel.setAttribute('role', 'status');
        this.wheel.hidden = true;
        if (this.assetPlaytest) {
            const banner = document.createElement('aside');
            banner.className = 'wc-asset-playtest-banner';
            banner.setAttribute('role', 'status');
            banner.textContent = this.assetPlaytest.banner;
            root.append(this.world, this.overlay, banner);
        } else {
            root.append(this.world, this.overlay);
        }
        this.overlay.append(this.inputHost);
        this.input = new RuntimeInput(this.inputHost);
        this.ui = mountGameUI(this.overlay, { onAction: action => { void this.dispatch(action); }, onPreviewHost: (host, id) => this.preview(host, id), onHeroPreviewHost: host => this.mountHeroPreviewHost(host) });
        this.damageNumbers = new DamageNumbers(this.overlay);
        this.monsterLabels = new MonsterLabels(this.overlay);
        this.manifestPromise = this.readManifest();
        void this.manifestPromise.catch(() => undefined);
        this.unsubscribe = this.campaignDirector.subscribe(snapshot => {
            if (this.activeRunId && snapshot.runId !== this.activeRunId) return;
            const prev = this.campaign;
            this.activeRunId = snapshot.runId;
            this.campaign = snapshot;
            this.primeNarrativeCuesFromTransition(prev, snapshot);
            this.render();
        });
        this.overlay.addEventListener('pointerdown', this.onUserGesture);
        this.overlay.addEventListener('keydown', this.onUserGesture);
        window.addEventListener('pagehide', this.onPageHide);
        window.addEventListener('pageshow', this.onPageShow);
        window.addEventListener('blur', this.onBlur);
        document.addEventListener('visibilitychange', this.onVisibility);
        this.raf = requestAnimationFrame(this.frame);
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
                this.bindings = normalizeInputBindings({
                    keyboard: { ...data.bindings.keyboard },
                    gamepad: { ...data.bindings.gamepad },
                });
            }
            this.slots = await this.saves.listSlots();
            if (!this.isLifecycleCurrent(generation)) return;
            this.input.setDeadzone(this.settings.gamepadDeadzone);
            this.applyBindings();
            this.ready = true;
            this.render();
        } catch (error) {
            if (!this.isLifecycleCurrent(generation)) return;
            this.error = { code: error instanceof SaveRepositoryError ? error.code : 'save-init', message: errorText(error), recoverable: true };
            this.render();
        }
    }
    private async readManifest(): Promise<Manifest> {
        const manifestUrl = this.assetPlaytest ? this.assetPlaytest.manifestUrl : MANIFEST_URL;
        const label = this.assetPlaytest ? this.assetPlaytest.manifestLabel : 'Required public asset manifest';
        const response = await fetch(manifestUrl, { cache: 'no-store' });
        if (!response.ok) {
            const message = label + ' ' + manifestUrl + ' is unavailable (HTTP ' + response.status + ').';
            if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) throw new AssetGateError(message);
            throw new Error(message);
        }
        let json: unknown;
        try { json = await response.json(); }
        catch (error) {
            if (error instanceof Error && error.name === 'AbortError') throw error;
            throw new AssetGateError(label + ' ' + manifestUrl + ' contains invalid JSON.');
        }
        if (!isManifest(json)) throw new AssetGateError(label + ' ' + manifestUrl + ' is not an AssetManifestEntry array.');
        return json;
    }
    private async prepareWorld(snapshot: CampaignSnapshot, showIntro = false, generation = this.beginWorldGeneration()): Promise<void> {
        const lifecycleGeneration = this.lifecycleGeneration;
        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        this.releaseWorld();
        this.pendingInteraction = null;
        this.pendingAbility = null;
        this.input.clear();
        this.screen = 'loading';
        this.combat.setTimePolicy('paused');
        this.loading = { active: true, label: 'Checking required native assets', progress: null, operationId: 'region-load', detail: { stage: 'checking-assets', message: 'Reading the manifest and confirming the forest\'s required native assets.' } };
        this.error = null;
        this.render();
        const allAssets = await this.readManifest();
        const npc = this.assetPlaytest ? heroById(this.selectedHero).npcActorId : undefined;
        const manifest = npc ? allAssets.filter(entry => entry.actorId !== npc) : allAssets;
        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        this.manifestPromise = Promise.resolve(manifest);
        this.manifest = manifest;
        const authoredRegion = REGIONS.find(item => item.id === snapshot.regionId);
        if (!authoredRegion) throw new AssetGateError('No authored region definition for ' + snapshot.regionId + '.');
        const region = this.assetPlaytest ? createCombatTrialRegion(authoredRegion, this.selectedHero) : authoredRegion;
        const authoredRecipe = ENVIRONMENT_RECIPES.find(item => item.id === region.environmentRecipeId);
        if (!authoredRecipe) throw new AssetGateError('No authored environment recipe for ' + region.id + '.');
        const recipe = region === authoredRegion ? authoredRecipe : { ...authoredRecipe, assetPlacementIds: region.props.map(prop => prop.id), groundSurfaceIds: region.ground.surfaces.map(surface => surface.id) };
        this.assertAssets(region, manifest, recipe);
        if (!this.renderer)
            this.renderer = new GameRenderer({ canvas: this.canvas, allowMissingActionClips: this.assetPlaytest !== null, simplifyBlockedPlaytestGeometry: this.assetPlaytest !== null });
        this.renderer.setReducedMotion(this.settings.reducedMotion);
        this.loading = { active: true, label: 'Loading ' + region.name, progress: 0, operationId: 'region-load', detail: { stage: 'loading-scene-assets', message: 'Preparing the forest...' } };
        this.render();
        await this.renderer.loadRegion(region, manifest, recipe, progress => {
            if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
            const total = Math.max(0, progress.total);
            const completed = Math.max(0, Math.min(progress.completed, total));
            const detail: GameViewModel['loading']['detail'] = { stage: 'loading-scene-assets', message: total > 0 ? `Loaded ${completed} of ${total} scene assets` : 'Preparing the forest...' };
            this.loading = { ...this.loading, progress: progress.ratio, detail };
            this.render();
        });
        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        await this.renderer.setPlayerHero(this.assetPlaytest ? this.selectedHero : 'aren');
        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        this.region = region;
        this.syncWorldFacts();
        const visibleActorEntities = region.entities.filter(entity => entity.actorId && (!entity.visibleWhen || snapshot.worldFacts[entity.visibleWhen] === true));
        const present = visibleActorEntities.map(entity => entity.id);
        const presentActors = new Map<string, number>();
        for (const entity of visibleActorEntities) {
            const actorId = entity.actorId!;
            presentActors.set(actorId, (presentActors.get(actorId) ?? 0) + 1);
        }
        const party: ActiveCompanionSlots = { ...snapshot.party };
        if (party.combat && presentActors.get(party.combat) !== 1) delete party.combat;
        if (party.utility && presentActors.get(party.utility) !== 1) delete party.utility;
        if (party.scout && presentActors.get(party.scout) !== 1) delete party.scout;
        this.activeCompanionSlots = party;
        this.combat.loadRegion({ regionId: region.id, regionDefinition: region, runId: snapshot.runId, presentActorIds: present, companionSlots: party, chapter: snapshot.chapter, wardenCall: snapshot.worldFacts.wardenCall === true, dominionUsed: snapshot.campaign.dominionHistory.length > 0, worldFacts: snapshot.worldFacts });
        this.combat.setPlayerHero(this.assetPlaytest ? this.selectedHero : 'aren');
        this.combat.setSceneColliders(this.renderer.getNativeSolidColliders());
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
        this.presentation.startBiomeAmbience(region.id);
        this.syncStoryState();
        if (this.assetPlaytest) {
            const exitId = this.assetPlaytest.exitRouteId;
            const exit = region.exits.find(route => route.id === exitId);
            if (!exit) throw new Error(this.assetPlaytest.name + ' playtest requires its authored exit ' + exitId + '.');
            this.stageGoal = new StageGoal(exit.from);
            await this.renderer.prepareWaystone(this.stageGoal.position, this.stageGoal.pillarPosition(region, this.renderer.getInputBasis().right));
        }
        this.renderer.prewarm([this.presentation.effects.group]);
        // Compile the cleanse-dissolve shell program once against the real trial monster rigs so the first cleanse never hitches.
        const monsterRoots = (this.assetPlaytest?.trialSet.trials ?? []).map(stage => this.renderer!.resolveActorRoot(stage.monsterId)).filter((root): root is NonNullable<typeof root> => root !== undefined);
        if (this.assetPlaytest && monsterRoots.length) this.presentation.effects.warden.dissolve.prewarm(monsterRoots, () => this.renderer!.prewarm(monsterRoots));
        this.renderer.render();
        this.loading = { active: false, label: '', progress: null };
        this.sceneBlocked = false;
        this.worldReady = true;
        this.screenHistory.length = 0;
        this.screen = showIntro ? 'dialogue' : 'game';
        this.combat.setTimePolicy(showIntro ? 'paused' : 'normal');
        this.dialogue = showIntro ? DIALOGUE['prologue-vision'] ?? null : null;
        this.dialogueLineIndex = 0;
        this.render();
        await this.startOrunEncounterIfReady(generation);
        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        if (!showIntro)
            await this.startWildlifeEncounterIfReady();
    }
    private async startOrunEncounterIfReady(generation = this.worldGeneration): Promise<void> {
        const lifecycleGeneration = this.lifecycleGeneration;
        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        if (!this.campaign || !this.region || !this.renderer || this.region.id !== 'heartroot-hollow' || !this.campaign.activeQuestIds.some(id => id === 'orun-the-hollow-king'))
            return;
        if (this.combat.snapshot().encounterId === 'encounter-orun')
            return;
        this.input.clear();
        this.screen = 'loading';
        this.combat.setTimePolicy('paused');
        this.loading = { active: true, label: 'Preparing Orun’s crowned-beast phase', progress: null, operationId: 'region-load' };
        this.render();
        await this.renderer.preloadActorVariant('orun', 'actor-orun-crowned-beast', this.manifest);
        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        this.combat.startEncounter({ encounterId: 'encounter-orun', regionId: 'heartroot-hollow', runId: this.campaign.runId, companionSlots: this.activeCompanionSlots });
        this.combat.setTimePolicy('paused');
        this.loading = { active: false, label: '', progress: null };
        this.screen = 'game';
        this.combat.setTimePolicy('normal');
        this.render();
    }
    private async startWildlifeEncounterIfReady(): Promise<void> {
        const generation = this.worldGeneration, lifecycleGeneration = this.lifecycleGeneration;
        const playtest = this.assetPlaytest;
        const encounterRegionId = playtest?.regionId ?? 'greenwake';
        if (!this.campaign || !this.region || this.region.id !== encounterRegionId || !playtest && (this.campaign.chapter !== 0 || !this.campaign.activeQuestIds.some(id => id === 'prologue'))) {
            if (this.screen === 'dialogue')
                this.setScreen('game');
            return;
        }
        const encounterId = playtest?.trialSet.encounterId ?? 'greenwake-boar';
        if (this.combat.snapshot().encounterId === encounterId && (!playtest || this.combat.snapshot().encounterStatus?.trial)) {
            this.setScreen('game');
            return;
        }
        this.input.clear();
        this.screen = 'loading';
        this.combat.setTimePolicy('paused');
        this.loading = { active: true, label: playtest?.loadingLabel ?? 'Beginning the Greenwake encounter', progress: null, operationId: 'region-load' };
        this.render();
        this.combat.startEncounter({ encounterId, regionId: encounterRegionId, runId: this.campaign.runId, companionSlots: this.activeCompanionSlots });
        if (playtest) {
            await this.renderer!.prepareCombatTrialGates();
            if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
            this.combat.enableCombatTrials();
        }
        const combatSnapshot = this.combat.snapshot();
        this.renderer?.sync(combatSnapshot.actors, combatSnapshot, 0);
        this.renderer?.render();
        this.combat.setTimePolicy('paused');
        this.loading = { active: false, label: '', progress: null };
        this.screen = 'game';
        this.combat.setTimePolicy('normal');
        this.render();
    }
    /**
     * Pushes authored narrative beats into the cue queue when a committed
     * campaign snapshot adds a new active quest, completes an active quest,
     * or completes a configured objective. Idempotent snapshots, identical
     * baseline transitions, and load/import of already-existing progress
     * never replay cues.
     */
    private primeNarrativeCuesFromTransition(prev: CampaignSnapshot | null, next: CampaignSnapshot): void {
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
    private assertAssets(region: RegionDefinition, manifest: Manifest, recipe: EnvironmentRecipeDefinition): void {
        const byId = new Map(manifest.map(entry => [entry.id, entry]));
        const recipeEntry = byId.get(recipe.id);
        if (!recipeEntry || recipeEntry.sourceType !== 'composed-recipe' || recipeEntry.kind !== 'environment') {
            throw new AssetGateError('Environment recipe ' + recipe.id + ' is not a normalized composed-recipe entry.');
        }
        const expectedComponents = [...new Set(region.props.map(prop => prop.assetId))].sort();
        const actualComponents = recipeEntry.componentAssetIds?.slice().sort();
        if (!actualComponents || new Set(actualComponents).size !== actualComponents.length || actualComponents.length !== expectedComponents.length || actualComponents.some((id, index) => id !== expectedComponents[index])) {
            throw new AssetGateError('Environment recipe ' + recipe.id + ' componentAssetIds do not exactly match the region’s authored prop assets.');
        }
        const expectedPlacements = region.props.map(prop => prop.id).sort();
        const actualPlacements = recipe.assetPlacementIds.slice().sort();
        if (new Set(actualPlacements).size !== actualPlacements.length || actualPlacements.length !== expectedPlacements.length || actualPlacements.some((id, index) => id !== expectedPlacements[index])) {
            throw new AssetGateError('Environment recipe ' + recipe.id + ' assetPlacementIds do not exactly match the region’s authored placements.');
        }
        const movableIds = new Set<string>();
        for (const movable of region.movableObjects) {
            if (movableIds.has(movable.id)) throw new AssetGateError('Region ' + region.id + ' repeats movable prop instance ' + movable.id + '.');
            movableIds.add(movable.id);
            const placements = region.props.filter(prop => prop.id === movable.id);
            if (placements.length !== 1 || placements[0]!.assetId !== movable.assetId) {
                throw new AssetGateError('Movable prop ' + movable.id + ' must match exactly one authored placement and asset.');
            }
            if (!region.ground.surfaces.some(surface => surface.id === movable.supportSurfaceId)) {
                throw new AssetGateError('Movable prop ' + movable.id + ' references missing support surface ' + movable.supportSurfaceId + '.');
            }
        }
        const playtest = this.assetPlaytest;
        if (playtest && region.id !== playtest.regionId) throw new AssetGateError('The real-asset candidate playtest only supports ' + playtest.name + '; other regions remain gated by production evidence.');
        const required = new Set<string>([region.environmentRecipeId, ...region.props.map(prop => prop.assetId), ...region.entities.filter(entity => entity.actorId).map(entity => entity.assetId ?? ACTORS[entity.actorId!]?.assetId).filter((id): id is string => Boolean(id)), ACTORS.aren?.assetId ?? 'actor-aren']);
        // Every playable kit is an explicit candidate dependency; variants remain character assets and an unarmed hero (Sakda) has no weapon prop.
        const standaloneProps = playtest ? [TRIAL_GATE_ASSET_ID, WAYSTONE_ASSET_ID, ...HEROES.flatMap(hero => hero.weaponAssetId ? [hero.weaponAssetId] : [])] : [];
        for (const id of standaloneProps) required.add(id);
        if (playtest) for (const hero of HEROES) if (hero.variantAssetId) required.add(hero.variantAssetId);
        if (region.id === 'heartroot-hollow') required.add('actor-orun-crowned-beast');
        if (!playtest && manifest.some(entry => entry.playtestAnimation)) throw new AssetGateError('Playtest-only animation profiles cannot enter the production asset manifest.');
        if (playtest) {
            if (manifest.length !== required.size || byId.size !== required.size || [...byId.keys()].some(id => !required.has(id))) {
                throw new AssetGateError(playtest.name + ' candidate playtest manifest must contain exactly the authored ' + playtest.name + ' dependencies, including the player asset.');
            }
            for (const id of required) {
                const entry = byId.get(id);
                if (!entry) throw new AssetGateError(playtest.name + ' candidate playtest manifest is missing ' + id + '.');
                if (entry.evidenceStatus === 'verified') throw new AssetGateError('Candidate playtest asset ' + id + ' must remain explicitly unverified.');
                if (id === region.environmentRecipeId) continue;
                const expectedKind = region.props.some(prop => prop.assetId === id) || standaloneProps.includes(id) ? 'prop' : 'character';
                if (entry.kind !== expectedKind || entry.sourceType !== 'native-glb') throw new AssetGateError('Candidate playtest asset ' + id + ' must be a native ' + expectedKind + ' GLB.');
                if (!entry.runtimeUrl?.startsWith('/asset-source/generated/') || entry.runtimeUrl.includes('..')) throw new AssetGateError('Candidate playtest asset ' + id + ' must load from a local generated GLB.');
                if (!entry.outputHash || !/^[a-f0-9]{64}$/i.test(entry.outputHash)) throw new AssetGateError('Candidate playtest asset ' + id + ' requires the SHA-256 of its actual GLB bytes.');
                if (entry.kind === 'character' && (!entry.actorId || entry.requiredActionIds.length > 0)) {
                    throw new AssetGateError('Candidate playtest character ' + id + ' must identify its actor and must not claim unverified action clips.');
                }
                if (entry.playtestAnimation && entry.evidenceStatus !== 'blocked') throw new AssetGateError('Playtest animation profiles must remain explicitly blocked from production acceptance.');
            }
            return;
        }
        for (const id of required) {
            const entry = byId.get(id);
            if (!entry) throw new AssetGateError('Required asset ' + id + ' is missing from ' + MANIFEST_URL + '.');
            if (entry.evidenceStatus !== 'verified') {
                throw new AssetGateError('Required asset ' + id + ' is not verified (' + entry.evidenceStatus + '); gameplay is blocked.');
            }
            if (entry.sourceType === 'native-glb') {
                if (!entry.runtimeUrl) throw new AssetGateError('Required native asset ' + id + ' has no runtimeUrl in ' + MANIFEST_URL + '.');
                if (!entry.outputHash) throw new AssetGateError('Required native asset ' + id + ' has no immutable outputHash in ' + MANIFEST_URL + '.');
                if (entry.kind === 'character') {
                    const missing = entry.requiredActionIds.filter(actionId => !entry.actionToClipMapping[actionId]);
                    if (missing.length) throw new AssetGateError('Required character asset ' + id + ' is missing evidenced animation clips for ' + missing.join(', ') + '.');
                }
            }
        }
        if (region.id === 'heartroot-hollow') {
            const variant = byId.get('actor-orun-crowned-beast');
            if (variant?.actorId !== 'orun' || variant.variantOf !== 'actor-orun' || variant.kind !== 'character' || variant.sourceType !== 'native-glb') {
                throw new AssetGateError('Orun crowned-beast phase requires exact verified actor variant actor-orun-crowned-beast.');
            }
        }
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
        void this.manifestPromise.then(assets => {
            const idleActionId = COMBAT_ACTION_CLIPS[`${id}-idle`];
            if (!idleActionId) throw new Error(`No exact idle action mapping exists for companion '${id}'.`);
            return mountCompanionPreview(host, id, assets, { idleActionId, loader: this.renderer?.assetLoader ?? undefined });
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
    /** Hero-select stage: the preview mounts once the candidate manifest is read; commands issued earlier are replayed. */
    private mountHeroPreviewHost(host: HTMLElement): HeroPreviewController {
        let handle: HeroPreviewHandle | null = null;
        let canceled = false;
        let shown: HeroId | null = null;
        void this.manifestPromise.then(assets => {
            if (canceled || this.disposed || !host.isConnected) return;
            handle = mountHeroPreview(host, assets, { reducedMotion: this.settings.reducedMotion });
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
    private disposeCompanionPreviews(): void {
        for (const handle of this.companionPreviews.keys()) handle.dispose();
        this.companionPreviews.clear();
    }
    private async dispatch(action: UIAction): Promise<void> {
        if (this.disposed)
            return;
        if (action.type === 'retry-load' && this.error?.recoverable === false) return;
        if (this.assetPlaytest) {
            if (action.type === 'map-select' || action.type === 'new-game' && this.screen === 'title') {
                if (action.type === 'map-select' && !['stage-complete', 'defeat', 'hero-select', 'map-select'].includes(this.screen)) return;
                this.beginWorldGeneration();
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
                this.releaseWorld();
                this.assetPlaytest = map;
                const banner = this.root.querySelector('.wc-asset-playtest-banner');
                if (banner) banner.textContent = map.banner;
                this.error = null;
                this.setScreen('hero-select');
                return;
            }
            if (action.type === 'select-hero') {
                if (this.screen !== 'hero-select' || !isHeroId(action.heroId) || !this.playtestProgress.isUnlocked(this.assetPlaytest.id)) return;
                this.selectedHero = action.heroId;
                action = { type: 'new-game', runId: action.runId };
            } else if (action.type === 'new-game' && !['stage-complete', 'defeat', 'loading'].includes(this.screen)) return;
            // Campaign saves are separate from local map/hero runs.
            if (['continue', 'load', 'import', 'travel', 'save', 'create-save-slot'].includes(action.type)) return;
        } else if (action.type === 'select-map' || action.type === 'select-hero' || action.type === 'map-select') return;
        if (this.playerOutcome && action.type !== 'new-game' && action.type !== 'return-title') return;
        if (this.failedWorldEvent) {
            const retryingEvent = action.type === 'retry-load' && action.operationId === 'durable-event';
            const replacingWorld = action.type === 'new-game' || action.type === 'continue' || action.type === 'load' || action.type === 'return-title';
            if (!retryingEvent && !replacingWorld) return;
        }
        const lifecycleGeneration = this.lifecycleGeneration;
        const supersedesWorld = action.type === 'new-game' || action.type === 'continue' || action.type === 'load' || action.type === 'import' || action.type === 'travel' || action.type === 'retry-load' || action.type === 'return-title';
        const generation = supersedesWorld ? this.beginWorldGeneration() : this.worldGeneration;
        if (supersedesWorld) {
            this.pendingInteraction = null;
            this.pendingAbility = null;
            this.screenHistory.length = 0;
            if (action.type !== 'retry-load' || action.operationId !== 'durable-event') this.worldReady = false;
        }
        try {
            switch (action.type) {
                case 'new-game':
                    this.pendingNewRunId = action.runId;
                    this.loading = { active: true, label: 'Starting a new journey', progress: null, operationId: 'new-game' };
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
                    this.pendingImportPayload = null;
                    this.pendingTravel = null;
                    const showcaseRegion = this.assetPlaytest?.showcaseRegionId;
                    this.campaign = showcaseRegion ? this.campaignDirector.startShowcase(action.runId, showcaseRegion) : this.campaignDirector.startNewRun(action.runId);
                    this.combat.startNewRun(this.campaign.runId);
                    this.pendingNewRunId = null;
                    this.activeRunId = this.campaign.runId;
                    this.lastCueSnapshot = this.campaign;
                    this.clearNarrativeCueQueue();
                    this.pendingNewRunId = null;
                    await this.prepareWorld(this.campaign, !this.assetPlaytest, generation);
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
                    await this.prepareWorld(this.campaign, false, generation);
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
                            await this.prepareWorld(this.campaign, false, generation);
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
                        await this.prepareWorld(this.campaign, false, generation);
                        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
                        this.sceneBlocked = false;
                        this.durableEvents = this.durableEvents.then(() => this.flushWorldEvents(generation, lifecycleGeneration));
                        await this.durableEvents;
                        if (this.isWorldGenerationCurrent(generation, lifecycleGeneration)) this.render();
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
                    this.activeCompanionSlots = {};
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
                    }
                    break;
                case 'save':
                    await this.campaignDirector.save(action.slotId, action.label);
                    await this.refreshSlots();
                    this.render();
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
                    await this.prepareWorld(this.campaign, false, generation);
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
                    await this.prepareWorld(this.campaign, false, generation);
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
                    this.campaign = this.campaignDirector.acceptQuest(action.questId);
                    this.render();
                    break;
                case 'track-objective':
                    this.campaign = this.campaignDirector.trackObjective(action.objectiveId);
                    this.render();
                    break;
                case 'select-companion':
                    this.campaign = this.campaignDirector.selectParty(action.slot, action.companionId);
                    this.reloadActors();
                    this.render();
                    break;
                case 'issue-command':
                    if (!this.combat.commandCompanion(action.companionId, action.command.command, action.command.targetId))
                        throw new Error('Companion is not available to receive this command.');
                    break;
                case 'use-ability': {
                    const ability = COMPANION_ROSTER.find(companion => companion.ability === action.abilityId);
                    if (!ability) {
                        this.pendingAbility = action.abilityId;
                        break;
                    }
                    const assigned = ability.id === 'vara'
                        ? this.activeCompanionSlots.scout === 'vara'
                        : this.activeCompanionSlots.combat === ability.id || this.activeCompanionSlots.utility === ability.id;
                    if (!assigned) throw new Error('Assign this companion to a support slot before using this ability.');
                    const command = ability.id === 'vara' ? 'focus' : 'special';
                    const targetId = action.targetId ?? this.combat.snapshot().targetId;
                    if (!this.combat.commandCompanion(ability.id, command, targetId))
                        throw new Error('This companion ability is not ready for the current target.');
                    this.render();
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
                        this.campaign = await this.campaignDirector.choose(action.choiceId, action.optionId);
                        this.choice = null;
                        this.ending = this.campaign.ending ? endingViewModel(this.campaign.ending) : null;
                        this.setScreen(this.ending ? 'ending' : 'game');
                    }
                    break;
                }
                case 'travel':
                    this.pendingTravel = { regionId: action.regionId, entranceId: action.entranceId };
                    await this.travel(action.regionId, action.entranceId, generation);
                    break;
                case 'update-settings':
                    this.settings = { ...this.settings, ...action.settings };
                    this.input.setDeadzone(this.settings.gamepadDeadzone);
                    this.presentation?.setSettings(this.settings);
                    this.renderer?.setReducedMotion(this.settings.reducedMotion);
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
            }
        }
        catch (error) {
            if (this.disposed) return;
            if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
            const operationId = action.type === 'new-game' ? this.loading.operationId ?? 'new-game'
                : action.type === 'continue' || action.type === 'load' || action.type === 'travel' ? action.type
                    : action.type === 'retry-load' ? action.operationId
                        : this.loading.operationId;
            const terminalAssetError = isTerminalAssetError(error);
            const code = error instanceof SaveRepositoryError ? error.code : terminalAssetError ? 'asset-unavailable' : 'application';
            this.error = { code, message: errorText(error), recoverable: !terminalAssetError };
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
    private async refreshSlots(): Promise<void> { this.slots = await this.saves.listSlots(); }
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
        this.campaign = await this.campaignDirector.travel(regionId, entranceId);
        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        this.activeRunId = this.campaign.runId;
        await this.prepareWorld(this.campaign, false, generation);
        if (!this.isWorldGenerationCurrent(generation, lifecycleGeneration)) return;
        this.pendingTravel = null;
    }
    private reloadActors(): void {
        if (!this.region || !this.campaign)
            return;
        const visibleActorEntities = this.region.entities.filter(entity => entity.actorId && (!entity.visibleWhen || this.campaign?.worldFacts[entity.visibleWhen] === true));
        const present = visibleActorEntities.map(entity => entity.id);
        const presentActors = new Map<string, number>();
        for (const entity of visibleActorEntities) {
            const actorId = entity.actorId!;
            presentActors.set(actorId, (presentActors.get(actorId) ?? 0) + 1);
        }
        const party: ActiveCompanionSlots = { ...this.campaign.party };
        if (party.combat && presentActors.get(party.combat) !== 1) delete party.combat;
        if (party.utility && presentActors.get(party.utility) !== 1) delete party.utility;
        if (party.scout && presentActors.get(party.scout) !== 1) delete party.scout;
        if (!this.combat.setCompanionSlots(party, present))
            throw new Error('Selected companion is not present and ready in this region.');
        this.activeCompanionSlots = party;
    }
    private download(contents: string, fileName: string): void { const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = fileName; anchor.click(); URL.revokeObjectURL(url); }
    private canPlayWorld(): boolean {
        return this.worldReady && !!this.renderer && !!this.region && !!this.campaign
            && this.region.id === this.campaign.regionId && !this.error && !this.loading.active && !this.sceneBlocked;
    }
    private setScreen(screen: Screen, returning = false): void {
        if (WORLD_PANELS.includes(screen) && !this.canPlayWorld()) {
            this.render();
            return;
        }
        if (screen === 'game' && !this.canPlayWorld()) screen = this.error || this.loading.active ? 'loading' : 'title';
        if (screen === 'game' && this.stageCompleted) screen = 'stage-complete';
        else if (screen === 'game' && this.playerOutcome === 'defeat') screen = 'defeat';
        else if (screen === 'game' && this.suspended) screen = 'pause';
        if (!returning && screen !== this.screen) {
            if (OVERLAY_SCREENS.includes(screen)) this.screenHistory.push(this.screen);
            else this.screenHistory.length = 0;
        }
        this.screen = screen;
        this.combat.setTimePolicy(screen === 'game' ? 'normal' : 'paused');
        this.pendingInteraction = null;
        this.pendingAbility = null;
        this.input.clear();
        this.input.setEnabled(screen === 'game' && this.ready && this.canPlayWorld());
        this.accumulator = 0;
        this.render();
    }
    private releaseWorld(): void {
        this.worldReady = false;
        this.previousRenderSnapshot = undefined;
        this.renderSnapshot = undefined;
        this.damageNumbers.clear();
        this.monsterLabels.clear();
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
    private applyBindings(): void {
        this.input.setBindings(this.bindings);
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
            const restoration = c && region.id !== 'greenwake' && region.id !== 'the-grove' && region.id !== 'refuge' && region.id !== 'heartroot-hollow'
                ? c.campaign.world.regions[region.id]
                : 'unvisited';
            return { id: region.id, name: region.name, unlocked: region.id === c?.regionId || region.id === 'greenwake' || entrances.some(entrance => entrance.unlocked), restoration, entrances };
        });
        const companionState = this.screen === 'companions' ? this.combat.companions : null;
        const abilityTarget = snap.targetId ? this.resolvePresentActor(snap.actors, snap.targetId, true) : undefined;
        const rosterAbilities = companionState ? COMPANION_ROSTER.map(companion => {
            const slot = companionState.slots[companion.id];
            const actor = this.resolvePresentActor(snap.actors, companion.id);
            const assigned = companion.id === 'vara'
                ? this.activeCompanionSlots.scout === 'vara'
                : this.activeCompanionSlots.combat === companion.id || this.activeCompanionSlots.utility === companion.id;
            const unavailableReason = !assigned ? 'Assign this companion to an active support slot.'
                : !actor || !actor.visible || actor.downed || actor.possessed ? 'This companion is not present and ready.'
                    : !abilityTarget ? 'A visible target is required.'
                        : companion.id === 'solkar' && companionState.dominionUsed && companionState.bond < 40 ? 'Solkar requires Bond 40 while Dominion is used.'
                            : !slot || slot.readyAt > this.combat.simulationTick ? 'This companion ability is recovering.'
                                : companion.id !== 'vara' && companionState.tokens.available < 1 ? 'No companion command token is available.'
                                    : null;
            return {
                id: companion.ability,
                label: companion.abilityLabel,
                available: unavailableReason === null,
                reason: unavailableReason ?? companion.abilityDescription,
            };
        }) : [];
        const abilities = companionState ? rosterAbilities : [];
        const view: GameViewModel = {
            screen: this.screen,
            canOpenWorldPanels: this.canPlayWorld() && !this.stageCompleted,
            loading: this.loading,
            error: this.error,
            settings: this.settings,
            bindings: this.bindings,
            saves: { slots: this.slots.map(slot => ({ ...slot, exists: true })), continueSlotId: last?.slotId ?? null },
            campaign: c,
            party: c?.party ?? null,
            relationships: c?.factions ?? null,
            journal: { quests: QUESTS, region: c?.regionId ?? null },
            map: { currentRegion: c?.regionId ?? null, regions },
            playtestStage: this.assetPlaytest?.stage,
            playtestSelection: this.assetPlaytest ? {
                selectedMapId: this.assetPlaytest.id, heroId: this.selectedHero,
                nextMapId: this.stageCompleted ? ASSET_PLAYTESTS[ASSET_PLAYTESTS.indexOf(this.assetPlaytest) + 1]?.id : undefined,
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
        const active = this.ready && this.screen === 'game' && this.canPlayWorld();
        this.input.setEnabled(active);
        this.damageNumbers.element.hidden = !(active || this.screen === 'defeat' && this.outcomeElapsed < 0.8);
        this.monsterLabels.element.hidden = !active;
        if (!active) this.input.clear();
        this.presentQueuedNarrativeCue();
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
        return; const combat = this.combat.snapshot(); const corruption = Math.max(0, ...combat.actors.map(actor => actor.corruption ?? 0)); const restoration = Object.values(this.campaign.campaign.world.regions).filter(state => state === 'restored').length; this.presentation.setStoryState({ corruption, restoration, bond: this.combat.companions.bond, dominion: this.campaign.campaign.dominionHistory.length }); }
    private syncWorldFacts(): void {
        if (!this.campaign) return;
        this.combat.syncWorldFacts(this.campaign.worldFacts);
        const facts = Object.fromEntries(Object.entries(this.campaign.worldFacts).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
        this.renderer?.syncWorldFacts(facts);
        if (this.renderer) this.combat.setSceneColliders(this.renderer.getNativeSolidColliders());
    }
    private queueEvents(events: readonly WorldEvent[]): void {
        if (!events.length) return;
        this.pendingWorldEvents.push(...events);
        const generation = this.worldGeneration;
        const lifecycleGeneration = this.lifecycleGeneration;
        this.durableEvents = this.durableEvents.then(() => this.flushWorldEvents(generation, lifecycleGeneration));
    }
    private async flushWorldEvents(generation = this.worldGeneration, lifecycleGeneration = this.lifecycleGeneration): Promise<void> {
        while (this.isWorldGenerationCurrent(generation, lifecycleGeneration) && this.pendingWorldEvents.length && !this.failedWorldEvent && !this.sceneBlocked) {
            const event = this.pendingWorldEvents[0]!;
            const fromRegion = this.campaign?.regionId;
            try {
                const snapshot = await this.campaignDirector.processEvent(event);
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
            if (this.campaign.regionId !== fromRegion) {
                this.presentation?.onRegionUnload();
                this.sceneBlocked = true;
                this.loading = { active: true, label: 'Following the authored route', progress: null, operationId: 'region-load' };
                this.screen = 'loading';
                this.combat.setTimePolicy('paused');
                this.render();
                try {
                    await this.prepareWorld(this.campaign, false, generation);
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
    private showWorldError(error: unknown, operationId: string): void {
        const terminalAssetError = isTerminalAssetError(error);
        const code = error instanceof SaveRepositoryError ? error.code : terminalAssetError ? 'asset-unavailable' : 'application';
        this.error = { code, message: errorText(error), recoverable: !terminalAssetError };
        this.loading = { active: false, label: 'World operation failed', progress: null, operationId };
        this.screen = 'loading';
        this.combat.setTimePolicy('paused');
        this.render();
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
        if (this.screen === 'companions' && !document.hidden && delta > 0) {
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
        if (this.screen !== 'game' || !this.canPlayWorld() || !this.renderer || !this.campaign || document.hidden) {
            this.accumulator = 0;
            this.previousRenderSnapshot = undefined;
            this.renderSnapshot = undefined;
            return;
        }
        this.accumulator = Math.min(this.accumulator + delta, STEP * MAX_STEPS);
        let steps = 0;
        while (this.screen === 'game' && this.accumulator + 1e-9 >= STEP && steps < MAX_STEPS) {
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
            this.renderer.render();
            if (steps > 0) this.ui.render(this.model(snapshot));
        }
    };
    private simulateTick(): void {
        const actions = this.input.sample();
        if (actions.pausePressed) {
            this.setScreen('pause');
            return;
        }
        if (actions.mapPressed) {
            this.setScreen('map');
            return;
        }
        if (actions.journalPressed) {
            this.setScreen('journal');
            return;
        }
        if (actions.companionsPressed) {
            this.setScreen('companions');
            return;
        }
        this.wheel.hidden = !actions.commandWheelHeld;
        if (actions.commandWheelHeld)
            this.wheel.textContent = 'COMPANION COMMAND · ' + COMMANDS.join(' · ');
        if (actions.commandIndex !== null) {
            const companion = this.activeCompanionSlots.combat ?? this.activeCompanionSlots.utility;
            if (companion)
                this.combat.commandCompanion(companion, COMMANDS[actions.commandIndex] ?? 'follow');
        }
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
        if (requestedDefinition?.success.type === 'choice') {
            const choiceId = requestedDefinition.success.choiceId;
            const options = (CAMPAIGN_CHOICES[choiceId] ?? []).filter(option => requestedDefinition.success.type === 'choice' && requestedDefinition.success.optionIds.includes(option.id)
                && (choiceId !== 'final-ending' || option.id !== 'living_pact' || this.campaignDirector.ending().available));
            if (!options.length)
                throw new Error('The authored choice has no available options.');
            this.choice = { id: choiceId, title: requestedDefinition.promptLabel, options };
            this.setScreen('choice');
            return;
        }
        const nearbyActionInteraction = this.interaction && currentInteractionDefinition?.inputHint === 'heavy' ? currentInteractionDefinition : undefined;
        const actionInteraction = requested && requestedDefinition?.inputHint === 'heavy' ? requested : !requested && nearbyActionInteraction ? this.interaction : null;
        const waitingForRequiredInput = requestedDefinition?.inputHint === 'heavy' || requestedDefinition?.inputHint === 'ability' && !actions.abilityPressed || Boolean(requestedDefinition?.playerActionId) || Boolean(requestedDefinition?.requiresCompanionCommand && !actions.abilityPressed);
        if (requested && !waitingForRequiredInput) {
            const command = requestedDefinition?.requiresCompanionCommand;
            const succeeded = command
                ? this.combat.commandCompanion(command.companionId, command.command, requested.targetId)
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
            lightPressed: actions.lightPressed, heavyPressed: actions.heavyPressed,
            heavyHeld: actions.heavyHeld, heavyReleased: actions.heavyReleased, interactPressed: traversalPressed,
            rangedPressed: actions.rangedPressed, rangedHeld: actions.rangedHeld, rangedReleased: actions.rangedReleased, ultimatePressed: actions.ultimatePressed,
            interactTargetId: actionInteraction?.targetId ?? requested?.targetId ?? this.interaction?.targetId,
            interactionId: actionInteraction?.interactionId,
            interactionTargetId: actionInteraction?.targetId,
            traversalId: traversalPressed ? route?.id : undefined,
            abilityPressed: ability || undefined,
            tetherPressed: ability === 'root-tether' || ability === 'contextual' && before.skills.some(skill => skill.id === 'root_tether'),
            cleansePressed: ability === 'cleanse' || ability === 'contextual' && before.skills.some(skill => skill.id === 'cleanse'),
            ferocityPressed: ability === 'ferocity', corruptionPressed: ability === 'corruption',
        };
        this.combat.step(input, STEP, { forward: inputBasis.forward, right: inputBasis.right });
        this.syncStoryState();
        const cues = this.combat.drainPresentationCues();
        if (cues.length)
            this.presentation?.consumeTick(cues);
        const events = this.combat.consumeEvents();
        this.damageNumbers.consume(events);
        this.presentDamageFeedback(events);
        this.queueEvents(this.combat.consumeWorldEvents());
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
        const playtest = this.assetPlaytest;
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
        if (!this.assetPlaytest || !this.stageGoal || this.stageCompleted || this.screen !== 'game'
            || !this.canPlayWorld() || snapshot.player.vitality <= 0) return;
        if (!snapshot.encounterStatus?.trial?.complete) return;
        const player = this.resolvePresentActor(snapshot.actors, 'aren');
        if (!player || !this.stageGoal.contains(player.position)) return;
        this.stageCompleted = true;
        this.playtestProgress.complete(this.assetPlaytest.id);
        this.combat.finishLocalStage();
        this.presentPlayerOutcome('victory', snapshot);
    }
    private presentPlayerOutcome(outcome: 'victory' | 'defeat', snapshot: CombatSnapshot): void {
        if (this.playerOutcome || !this.renderer) return;
        this.playerOutcome = outcome;
        this.outcomeElapsed = 0;
        this.outcomeSnapshot = snapshot;
        this.presentation?.onRegionUnload();
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
            const movableDefinition = this.region.movableObjects.find(object => object.id === interaction.targetId);
            const movable = movableDefinition ? snapshot.movableObjects.find(object => object.objectId === movableDefinition.id) : undefined;
            if (movableDefinition) {
                const koroInteraction = INTERACTIONS.find(candidate => candidate.id === movableDefinition.koroInteractionId);
                const requirement = koroInteraction?.requiresCompanionCommand;
                const koroReady = Boolean(requirement && this.activeCompanionSlots[requirement.slot] === requirement.companionId && this.resolvePresentActor(actors, requirement.companionId));
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
            const label = { vault: 'Vault', 'low-ledge': 'Climb low ledge', slide: 'Slide', swing: 'Swing' }[route.traversal!.kind];
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
    private onBlur = () => { this.input.clear(); if (this.screen === 'game')
        this.setScreen('pause'); };
    private onVisibility = () => { this.previousTime = 0; if (document.hidden) {
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
        this.damageNumbers.dispose();
        this.monsterLabels.dispose();
        this.saves.close();
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
