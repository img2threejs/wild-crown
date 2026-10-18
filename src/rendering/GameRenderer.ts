import { AmbientLight, Box3, DirectionalLight, Fog, Frustum, Group, HemisphereLight, InstancedBufferGeometry, InstancedMesh, Matrix4, Mesh, PerspectiveCamera, PropertyBinding, Scene, Sphere, Texture, Vector3, WebGLRenderer, type BufferGeometry, type Color, type Material, type Object3D } from 'three';
import type { ActionId, ActorSnapshot, AssetManifestEntry, CombatSnapshot, EnvironmentRecipeDefinition, GameSettings, MovableObjectSnapshot, RegionColliderDefinition, RegionDefinition, RegionMovableObjectDefinition, Vec3, WorldAssetPlacement } from '../game/contracts';
import { OrunPresentation } from './OrunPresentation';
import type { CameraDebugState } from './CameraDirector';
import { MAX_SHOT_DISTANCE, planEstablishingShot, type EstablishingFraming } from './EstablishingShot';
import { CameraDirector } from './CameraDirector';
import { createActorMotionState, settleDrawnHeight, updateLean, type ActorMotionState } from './ActorMotionSmoothing';
import { ActorProcedural, type ProceduralDetail } from './ActorProcedural';
import { QuadrupedGrounding } from './QuadrupedGrounding';
import { REACTION_CLIPS, ReactionPresenter, localReactionDirection, type ReactionContext } from './ReactionPresenter';
import { findRigBones } from './RigBones';
import { createSlopeAttitude, settleSlopeAttitude, slopeTarget, type SlopeAttitudeState } from './SlopeAttitude';
import { NativeAssetLoader, setFoliageReducedMotion, setFoliageWorldWind, type AssetLoadProgress, type NativeAssetInstance, type NativeStaticBatch } from './NativeAssetLoader';
import { DEFAULT_SCREEN_SPACE_LOD_POLICY, ScreenSpaceLOD, type ScreenSpaceLODPolicy, type ScreenSpaceLODDebugState } from './ScreenSpaceLOD';
import { RegionEnvironment, setSceneAtmosphere } from '../world/RegionEnvironment';
import { configureRegionAtmosphere, updateRegionShafts, type RegionAtmosphereBindings } from './RegionAtmosphereBridge';
import { PoseAfterimages } from './PoseAfterimages';
import { buildStaticPropColliders, type NativeSolidCollider } from './NativeSolidColliders';
import { MIGRATION_GATE_ASSET_ID, NativeMigrationGate } from './NativeMigrationGate';
import { arenaFromRegion, groundHeightAt, type CombatArena, type SupportField } from '../game/combat/geometry';
import { ContactShadows, GROUNDED_FADE, HOVER_FADE, contactShadowOpacity, measureFootprint, type ContactFootprint } from './ContactShadows';
import { FootGrounding, groundNormalAt, type GroundHeightFn } from './FootGrounding';
import { CombatObstacleVisuals } from '../effects/CombatObstacleVisuals';
import { EnvironmentPropVisuals } from './EnvironmentPropVisuals';
import { ActorHitFlash } from '../effects/vfx/HitFlash';
import { ActorBodies } from '../effects/vfx/ActorBounds';
import { PostFX } from './PostFX';
import { NativeTrialGates } from './NativeTrialGates';
import { TRIAL_GATE_ASSET_ID, combatTrialSetFor, type CombatTrialDefinition } from '../game/combat/CombatTrials';
import { driveActorAnimation } from './ActorAnimationDriver';
import { assertActorVariantBinding, assertRegionActorBinding, resolveDisplayedAsset, type DisplayedAsset } from './ActorBinding';
import { BAMBOO_STORY_ASSETS } from './BambooMonsterProfiles';
import { createStoryAnimationInput, type NpcTalk, type StoryAnimationInput } from './StoryActorAnimation';
import { foliageLimitsFor } from './FoliagePresentation';
import { MONSTER_HOVER, MONSTER_LOCOMOTION, monsterHoverHeight, settleMonsterHover } from './MonsterAnimationProfiles';
import { WARDEN_WEAPON_ASSET_ID, WardenWeapon, weaponKindForGrip, type WardenSocketName, type WardenWeaponKind } from './WardenWeapon';
import { ALL_COMPANION_SKILLS, type CompanionSkill } from '../game/companions/CompanionSkills';
import { StoryEffects } from '../effects/StoryEffects';
import type { CuePhase } from '../effects/story-cues';
import { fitUnarmedFists, releaseHandGeometry, type HandGeometryEdit } from './NativeHandGrip';
import { solidPropKind } from '../content/solid-props';
import { heroById, type HeroId } from '../game/heroes';
import { HERO_COMBAT } from '../game/combat/HeroProfiles';
import { WaystoneVisual, WAYSTONE_ASSET_ID } from './WaystoneVisual';
import { enemyAttackAirborne } from './EnemyAttackPresentation';
import enemyNativeAnchorSource from '../content/enemy-native-anchors.json';

const ENEMY_NATIVE_ANCHORS: Readonly<Record<string, Readonly<Record<string, { readonly base: string; readonly tip: string }>>>> = enemyNativeAnchorSource;

const STATIC_BATCH_CELL_SIZE = 16;
/** Light 3 (Warden Blade spin): the simulation rotates Aren's facing a full turn across the swing. */
const SPIN_ACTION_ID = 'aren-light-3';
/** The player's steering heading turns at most 16 rad/s (0.27 rad per tick); a per-tick turn up to this is followed exactly, a larger one (an attack or dodge setting the heading outright) eases in. */
const STEERED_TURN_MAX = 0.4;
const EMPTY_COMBAT_OBSTACLES = Object.freeze([]);
const EMPTY_ENVIRONMENT_PROPS = Object.freeze([]);
/** Actions during which the feet leave the ground by design (jumps, rolls, vaults, slides, flips, defeat): no foot grounding. */
const OFF_GROUND_ACTION = /jump|air-step|dive|roll|vault|slide|cartwheel|handspring|defeat/;
/** Hero actions that are plain locomotion or standing: the gaze and the stance foot-lock run only in these. */
const LOCOMOTION_ACTION = /(?:^|-)(?:idle|walk|run|strafe)$/;
/** Animation LOD: actors closer than NEAR to the camera run the full procedural layer every frame; up to FAR they skip IK and springs and update every second frame; beyond (or off-screen) every fourth / sixth. */
const LOD_NEAR = 26, LOD_FAR = 52;
const LOD_STRIDE = { near: 1, mid: 2, far: 4, offscreen: 6 } as const;
/** Head look-at range (m): a hero looks at the nearest hostile inside it, a monster at the hero. */
const LOOK_RANGE = 14;
/** Body sockets every hero exposes (VFX trails on fists and feet): mixamorig hand and foot bones. */
const BODY_SOCKET_BONES: Readonly<Record<string, string>> = Object.freeze({
  'fist-left': 'mixamorig:LeftHand', 'fist-right': 'mixamorig:RightHand', 'foot-left': 'mixamorig:LeftFoot', 'foot-right': 'mixamorig:RightFoot',
});

interface DisposableAsset { readonly assetId: string; readonly root: Object3D; dispose(): void }
/** Procedural rig of one displayed actor: biped foot IK, creature foot IK, and the bone layer (reaction bends, look-at, spring tails) that wraps them. */
interface ActorRig { readonly foot: FootGrounding | null; readonly quad: QuadrupedGrounding | null; readonly procedural: ActorProcedural | null; readonly creature: boolean }
/** Presentation state of one displayed actor besides height and lean (ActorMotionSmoothing): reaction pose, slope attitude and animation LOD bookkeeping. */
interface ActorExtras {
  readonly reaction: ReactionPresenter;
  readonly slope: SlopeAttitudeState;
  /** Stable 0..1 from the actor id: staggers the LOD frames and the stun sway of a pack. */
  readonly phase: number;
  /** Frame index the clip and procedural layer last ran (-1 before the first), the real time owed to the next run, and whether this frame reuses the last pose. */
  lastDriven: number;
  pendingDt: number;
  lodSkip: boolean;
}
type MovablePropDefinition = Pick<RegionMovableObjectDefinition, 'id' | 'assetId' | 'from' | 'to' | 'supportSurfaceId' | 'movedFactId'>;
interface MovablePropInstance { readonly definition: MovablePropDefinition; readonly root: Group; readonly placementRotationY: number; readonly visibleWhen?: string; awaitingCommit: boolean }
export interface RendererDebugSnapshot {
  regionId: string | null; loading: boolean; assetErrors: readonly string[]; lodWarnings: readonly string[]; missingActorAssets: readonly string[];
  loadedAssetIds: readonly string[]; actorCount: number; propCount: number; surfaceCount: number; colliderCount: number;
  lodMeasurements: readonly ScreenSpaceLODDebugState[]; camera: CameraDebugState;
  /** Missing native clips (`assetId:actionId`) of loaded actors, and the variant assets preloaded next to their base (Koro's ally body). */
  animationIssues: readonly string[]; loadedVariantAssetIds: readonly string[];
}
export interface GameRendererOptions { canvas: HTMLCanvasElement; assetLoader?: NativeAssetLoader; onProgress?: (progress: AssetLoadProgress) => void; pixelRatioCap?: number; lodPolicy?: ScreenSpaceLODPolicy; allowMissingActionClips?: boolean; simplifyBlockedPlaytestGeometry?: boolean }
export interface CompanionPreviewOptions { idleActionId: ActionId; loader?: NativeAssetLoader; allowCandidateActions?: boolean; reducedEffects?: boolean }
export interface CompanionPreviewHandle { readonly actionTime: number | undefined; showcase(skillId: string): void; update(dt: number): void; dispose(): void }
export interface PreparedCompanionParty { commit(): void; dispose(): void }
/**
 * Per-invocation aggregate progress for `GameRenderer.loadRegion`. Tracks the
 * real count of native-asset load operations the load plan will execute,
 * including any optional LOD attempts that are skipped because the LOD is
 * unavailable or failed recoverably. A required native-asset failure must
 * throw and never reach 100%; the callback must report `ratio` as 0 before
 * the first operation and increment strictly as each operation completes.
 */
export interface RegionLoadProgress { readonly completed: number; readonly total: number; readonly ratio: number }
export type RegionLoadProgressCallback = (progress: RegionLoadProgress) => void;
/** Scene owner. Region replacement is transactional: failed native loads preserve the previous committed region. */
export class GameRenderer {
  readonly scene = new Scene();
  readonly renderer: WebGLRenderer;
  readonly cameraDirector: CameraDirector;
  readonly camera: PerspectiveCamera;
  readonly assetLoader: NativeAssetLoader;
  private readonly world = new Group();
  private readonly actorRoots = new Map<string, NativeAssetInstance>();
  private readonly actorVariants = new Map<string, Map<string, NativeAssetInstance>>();
  private readonly actorManifests = new Map<string, AssetManifestEntry>();
  private readonly actorSnapshots = new Map<string, ActorSnapshot>();
  private readonly placementBatches = new Map<string, readonly NativeStaticBatch[]>();
  private readonly entityRoots = new Map<string, DisposableAsset>();
  private readonly movableProps = new Map<string, MovablePropInstance>();
  private readonly migrationGates = new Map<string, NativeMigrationGate>();
  private readonly actorVisibilityConditions = new Map<string, string>();
  private worldFacts: Readonly<Record<string, boolean>> = {};
  private readonly staticLods = new Set<ScreenSpaceLOD>();
  private readonly scratchTarget = new Vector3();
  private readonly ownedLoader: boolean;
  private readonly lodPolicy: ScreenSpaceLODPolicy;
  private readonly lodWarnings: string[] = [];
  private region: RegionDefinition | undefined;
  private environment: RegionEnvironment | undefined;
  /** The loaded region's sky/height-fog/grade/shafts feed for the post chain; replaced with the environment. */
  private atmosphere: RegionAtmosphereBindings | null = null;
  private currentCombat: CombatSnapshot | undefined;
  private renderSimulationTick = 0;
  private renderWorldTimeSeconds = 0;
  /** Rendered world-clock advance since the previous sync: zero through hit-stop and pause, scaled by slow motion. */
  private renderWorldDeltaSeconds = 0;
  private lastRenderWorldTimeSeconds: number | undefined;
  /** Presentation-only flight height per flying monster instance (drawn above its simulation position); dropped on a clock rewind. */
  private monsterHover = new WeakMap<NativeAssetInstance, number>();
  private assetCatalog: ReadonlyMap<string, AssetManifestEntry> = new Map();
  private loading = false;
  private loadEpoch = 0;
  private disposed = false;
  private readonly assetErrors: string[] = [];
  private readonly missingActorAssets = new Set<string>();
  private readonly resizeObserver: ResizeObserver;
  private afterimages: PoseAfterimages | null = null;
  private readonly obstacleVisuals: CombatObstacleVisuals;
  private readonly propResponses: EnvironmentPropVisuals;
  private readonly orunPresentation: OrunPresentation;
  private nativeSolidEntries: NativeSolidCollider[] = [];
  private readonly sceneColliders: RegionColliderDefinition[] = [];
  private readonly sceneSupports: SupportField[] = [];
  /** Walk-surface arena the actors' ground is sampled from (the engine's own `groundHeightAt` over the region and native support fields). */
  private groundArena: CombatArena | undefined;
  private contactShadows: ContactShadows | null = null;
  private readonly footprints = new WeakMap<NativeAssetInstance, ContactFootprint | null>();
  private readonly footGrounding = new WeakMap<NativeAssetInstance, ActorRig>();
  /** Combat reaction, procedural bone layer and animation LOD state per displayed instance. */
  private readonly actorExtras = new WeakMap<NativeAssetInstance, ActorExtras>();
  private readonly actorBodies = new ActorBodies();
  private readonly lodFrustum = new Frustum();
  private readonly lodMatrix = new Matrix4();
  private readonly lodSphere = new Sphere();
  private presentationFrame = 0;
  private syncedActors: readonly ActorSnapshot[] = [];
  private readonly lookTarget = new Vector3();
  private readonly localHit = { forward: 0, right: 0 };
  private readonly slopeGoal = createSlopeAttitude();
  private readonly reactionContext: { -readonly [K in keyof ReactionContext]: ReactionContext[K] } = {
    body: 'hero', clockSeconds: 0, bodyHeight: 1.7, hasHit: false, hasKnockdown: false, hasKnockdownForward: false, afterLaunch: false, getupLead: 0, attacking: false, phase: 0, progress: 0, motionScale: 1,
  };
  /** Animation LOD counters of the last sync: actors whose clip and procedural layer ran, and actors that reused their last pose. */
  readonly animationLod = { updated: 0, skipped: 0 };
  private readonly groundNormal = new Vector3();
  /** Presentation-only height low-pass and lean state per displayed instance (see ActorMotionSmoothing). */
  private readonly actorMotion = new WeakMap<NativeAssetInstance, ActorMotionState>();
  private establishingClock = 0;
  private revealClock = 0;
  private readonly shotMatrix = new Matrix4();
  private readonly shotPoint = new Vector3();
  private readonly shotBox = new Box3();
  /** The scene fog while the establishing shot has pushed it outward; null once restored. */
  private shotFog: { fog: Fog; near: number; far: number; spread: number } | null = null;
  private readonly groundHeight: GroundHeightFn = (x, z, nearY) => this.groundArena ? groundHeightAt(this.groundArena, x, z, nearY) : null;
  private reducedMotion = false;
  /** In-game motion-blur flag (true = full HUD/FOF cues; false = suppress impulse + afterimage trails). Reduced motion wins. */
  private motionBlur = true;
  private playerOutcome: { instance: NativeAssetInstance; actionId: ActionId; elapsed: number; baseScale: number } | null = null;
  private trialGates: NativeTrialGates | null = null;
  private waystone: WaystoneVisual | null = null;
  private trialDefinitions: readonly CombatTrialDefinition[] = [];
  private readonly postFx: PostFX;
  private readonly hitFlash = new ActorHitFlash();
  private wardenWeapon: WardenWeapon | null = null;
  private orunWeapon: WardenWeapon | null = null;
  private unarmedFists: HandGeometryEdit | null = null;
  /** Variant asset whose body hides during dodge blinks (hero `dodgeVanish`), with the visible-fraction window of the dodge clip. */
  private dodgeVanish: { assetId: string; from: number; to: number } | null = null;
  /** Grounded walk speed of the chosen hero (m/s); the driver uses it to pick walk versus run when a dash tail blends into locomotion. */
  private playerWalkSpeed = HERO_COMBAT.aren.walkSpeed;
  /** Grounded run speed of the chosen hero (m/s): the reference the driver scales the in-place run clip against. */
  private playerRunSpeed = HERO_COMBAT.aren.runSpeed;
  /** One role record per trial monster, rewritten in place each frame so the driver context never allocates. */
  private readonly trialMonsterRoles = new Map<string, { active: boolean; boss: boolean }>();
  private readonly bodySockets = new WeakMap<NativeAssetInstance, Map<string, Object3D | null>>();
  private readonly pixelRatioCap: number;
  private readonly gateOpenings: Vec3[] = [];
  private readonly drainedGateOpenings: Vec3[] = [];
  /** In-flight variant loads by actor + asset (see `preloadActorVariant`). */
  private readonly variantLoads = new Map<string, Promise<void>>();
  /** Renderer facts of the story cast (Asha, Tali, Marek, Koro) per actor instance, rewritten in place each frame. */
  private readonly storyFacts = new Map<string, { readonly input: StoryAnimationInput; displayedAssetId: string | undefined }>();
  private storyCalm = true;
  private readonly displayedScratch: DisplayedAsset = { kind: 'base', assetId: '' };

  constructor(options: GameRendererOptions) {
    this.ownedLoader = !options.assetLoader;
    this.assetLoader = options.assetLoader ?? new NativeAssetLoader({
      onProgress: options.onProgress,
      allowMissingActionClips: options.allowMissingActionClips,
      simplifyBlockedCandidates: options.simplifyBlockedPlaytestGeometry === true,
    });
    this.lodPolicy = options.lodPolicy ?? DEFAULT_SCREEN_SPACE_LOD_POLICY;
    // MSAA lives in the HDR composer target; the default framebuffer only receives the output pass.
    this.renderer = new WebGLRenderer({ canvas: options.canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    this.pixelRatioCap = options.pixelRatioCap ?? 1;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.pixelRatioCap));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = 2;
    this.scene.add(this.world);
    this.cameraDirector = new CameraDirector(this.scene);
    this.camera = this.cameraDirector.camera;
    this.obstacleVisuals = new CombatObstacleVisuals(this.scene);
    this.propResponses = new EnvironmentPropVisuals(this.scene, this.placementBatches);
    this.orunPresentation = new OrunPresentation(this.scene);
    this.postFx = new PostFX(this.renderer, this.scene, this.camera, { pixelRatioCap: this.pixelRatioCap });
    this.scene.add(new AmbientLight(0xffffff, 0.05));
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(options.canvas);
    this.resize();
  }

  async loadRegion(region: RegionDefinition, assets: readonly AssetManifestEntry[], environmentRecipe: EnvironmentRecipeDefinition, onProgress?: RegionLoadProgressCallback): Promise<void> {
    this.assertAlive();
    const loadEpoch = ++this.loadEpoch;
    this.loading = true;
    this.assetErrors.length = 0;
    this.lodWarnings.length = 0;
    const byId = new Map(assets.map((entry) => [entry.id, entry]));
    const nextEnvironment = new RegionEnvironment(region, environmentRecipe);
    const nextWorld = new Group();
    const stagedEntities = new Map<string, DisposableAsset>();
    const stagedActors = new Map<string, NativeAssetInstance>();
    const stagedMovableProps = new Map<string, MovablePropInstance>();
    const stagedMigrationGates = new Map<string, NativeMigrationGate>();
    const stagedPlacementBatches = new Map<string, readonly NativeStaticBatch[]>();
    const stagedActorVisibility = new Map<string, string>();
    const stagedActorManifests = new Map<string, AssetManifestEntry>();
    const stagedLods = new Set<ScreenSpaceLOD>();
    const stagedSolids: NativeSolidCollider[] = [];
    let stagedAfterimages: PoseAfterimages | null = null;
    let stagedWeapon: WardenWeapon | null = null;
    let stagedOrunWeapon: WardenWeapon | null = null;
    let stagedShadows: ContactShadows | null = null;
    nextWorld.name = `region:${region.id}`;
    nextWorld.add(nextEnvironment.group);
    try {
      await nextEnvironment.ready;
      const recipe = byId.get(region.environmentRecipeId);
      if (environmentRecipe.id !== region.environmentRecipeId || environmentRecipe.regionId !== region.id) throw new Error(`Region ${region.id} has mismatched procedural recipe '${environmentRecipe.id}'.`);
      const requiredLayers: EnvironmentRecipeDefinition['proceduralLayers'][number][] = ['terrain', 'fog', 'lighting'];
      if (region.ground.surfaces.some((surface) => surface.profile === 'water') || region.props.some((placement) => placement.placement === 'water-edge')) requiredLayers.push('water');
      if (region.props.length > 0) requiredLayers.push('vegetation');
      if (region.ground.colliders.length > 0) requiredLayers.push('collision');
      for (const layer of requiredLayers) if (!environmentRecipe.proceduralLayers.includes(layer)) throw new Error(`Region recipe '${environmentRecipe.id}' lacks required procedural layer '${layer}'.`);
      const recipePlacementIds = new Set(environmentRecipe.assetPlacementIds);
      const regionPlacementIds = new Set(region.props.map((placement) => placement.id));
      if (recipePlacementIds.size !== regionPlacementIds.size || [...recipePlacementIds].some((id) => !regionPlacementIds.has(id))) throw new Error(`Region recipe '${environmentRecipe.id}' placement IDs do not exactly match the region content.`);
      const recipeSurfaceIds = new Set(environmentRecipe.groundSurfaceIds);
      const regionSurfaceIds = new Set(region.ground.surfaces.map((surface) => surface.id));
      if (recipeSurfaceIds.size !== regionSurfaceIds.size || [...recipeSurfaceIds].some((id) => !regionSurfaceIds.has(id))) throw new Error(`Region recipe '${environmentRecipe.id}' ground surfaces do not exactly match shared navigation/collision geometry.`);
      if (!recipe || recipe.sourceType !== 'composed-recipe' || recipe.proceduralRecipeId !== region.environmentRecipeId) {
        throw new Error(`Region ${region.id} requires composed environment recipe '${region.environmentRecipeId}' in the explicit manifest; it is not a GLB.`);
      }
      const requiredPropIds = new Set(region.props.map((placement) => placement.assetId));
      const recipePropIds = new Set(recipe.componentAssetIds ?? []);
      for (const id of requiredPropIds) if (!recipePropIds.has(id)) throw new Error(`Recipe '${recipe.id}' does not declare required native prop '${id}'.`);

      const movingDefinitions: readonly MovablePropDefinition[] = [...region.movableObjects, ...(region.deliveries ?? [])];
      const movableById = new Map<string, MovablePropDefinition>();
      const movablePlacements = new Map<string, WorldAssetPlacement>();
      for (const movable of movingDefinitions) {
        if (movableById.has(movable.id)) throw new Error('Region ' + region.id + ' repeats movable prop instance ' + movable.id + '.');
        let placement: WorldAssetPlacement | undefined;
        for (const candidate of region.props) if (candidate.id === movable.id) {
          if (placement) throw new Error('Region ' + region.id + ' repeats props[] instance ' + movable.id + ' for a movable object.');
          placement = candidate;
        }
        if (!placement || placement.assetId !== movable.assetId) throw new Error('Region ' + region.id + ' movable prop ' + movable.id + ' must match exactly one props[] instance and manifest asset.');
        if (!region.ground.surfaces.some((surface) => surface.id === movable.supportSurfaceId)) throw new Error('Region ' + region.id + ' movable prop ' + movable.id + ' references missing support surface ' + movable.supportSurfaceId + '.');
        movableById.set(movable.id, movable);
        movablePlacements.set(movable.id, placement);
      }
      // Keep instanced bounds local; a visible tree must not submit the entire route. Batches never mix solid and
      // decoration placements, because a batch's collider kind comes from its first placement.
      const placementGroups = new Map<string, WorldAssetPlacement[]>();
      const gatePlacements: WorldAssetPlacement[] = [];
      for (const authored of region.props) {
        if (movableById.has(authored.id)) continue;
        // Authored Y already includes a walk-surface height; add only visual relief beyond that surface, never the ramp twice.
        const surfaceY = nextEnvironment.ground?.field.surfaceHeightAt(authored.position.x, authored.position.z) ?? 0;
        const lift = authored.placement === 'ground' ? nextEnvironment.visualGroundHeightAt(authored.position.x, authored.position.z) - surfaceY : 0;
        const placement = lift === 0 ? authored : { ...authored, position: { ...authored.position, y: authored.position.y + lift } };
        if (placement.assetId === MIGRATION_GATE_ASSET_ID) { gatePlacements.push(placement); continue; }
        const cellX = Math.floor(placement.position.x / STATIC_BATCH_CELL_SIZE);
        const cellZ = Math.floor(placement.position.z / STATIC_BATCH_CELL_SIZE);
        const key = `${placement.assetId}:${solidPropKind(placement)}:${cellX}:${cellZ}`;
        const current = placementGroups.get(key);
        if (current) current.push(placement);
        else placementGroups.set(key, [placement]);
      }
      // Pre-count every native-asset load operation the load plan will execute so
      // the per-invocation progress callback can report an integer percentage that
      // covers the whole region. Counts the static base batch per placement group
      // plus each verified-and-available LOD attempt (skipped LODs do not count),
      // every movable prop load, every actor instance load, and the fallback Aren
      // player load when no authored actor instance covers it. A required LOD
      // attempt that fails recoverably still counts as completed.
      let eligibleLodAttempts = 0;
      for (const placements of placementGroups.values()) {
        const initialManifest = byId.get(placements[0]!.assetId);
        if (!initialManifest || initialManifest.kind !== 'prop' || initialManifest.sourceType !== 'native-glb') continue;
        for (const lodId of initialManifest.lodIds) {
          const lodManifest = byId.get(lodId);
          if (!lodManifest || lodManifest.kind !== 'prop' || lodManifest.sourceType !== 'native-glb' || !lodManifest.runtimeUrl || lodManifest.evidenceStatus !== 'verified') continue;
          eligibleLodAttempts += 1;
        }
      }
      const authoredArenCount = region.entities.reduce((count, entity) => count + (entity.id === 'aren' && entity.kind === 'actor' && Boolean(entity.actorId) ? 1 : 0), 0);
      const requiresArenFallback = authoredArenCount === 0 && Boolean(byId.get('actor-aren'));
      const weaponManifest = byId.get(WARDEN_WEAPON_ASSET_ID);
      const orunEntity = region.entities.find(entity => entity.kind === 'actor' && entity.actorId === 'orun');
      const authoredActorCount = region.entities.reduce((count, entity) => count + (entity.kind === 'actor' && Boolean(entity.actorId) ? 1 : 0), 0);
      const totalOperations = placementGroups.size
        + eligibleLodAttempts
        + movingDefinitions.length
        + gatePlacements.length
        + authoredActorCount
        + (requiresArenFallback ? 1 : 0)
        + (weaponManifest && (authoredArenCount > 0 || requiresArenFallback) ? 1 : 0)
        + (orunEntity ? 1 : 0);
      let completedOperations = 0;
      const emitProgress = () => {
        if (!onProgress) return;
        if (loadEpoch !== this.loadEpoch || this.disposed) return;
        const total = Math.max(1, totalOperations);
        const completed = Math.min(completedOperations, totalOperations);
        const ratio = Math.max(0, Math.min(1, completed / total));
        onProgress({ completed, total: totalOperations, ratio });
      };
      if (loadEpoch === this.loadEpoch && !this.disposed) onProgress?.({ completed: 0, total: totalOperations, ratio: 0 });
      const completeOperation = () => {
        completedOperations += 1;
        emitProgress();
      };
      for (const placement of gatePlacements) {
        const manifest = byId.get(placement.assetId);
        if (!manifest || manifest.kind !== 'prop' || manifest.sourceType !== 'native-glb') throw new Error(`Migration gate ${placement.id} requires its native GLB manifest.`);
        const gate = await NativeMigrationGate.load(this.assetLoader, manifest, placement, region);
        if (this.disposed || loadEpoch !== this.loadEpoch) { gate.dispose(); throw new Error('Region load was superseded.'); }
        stagedEntities.set(placement.id, gate);
        stagedMigrationGates.set(placement.id, gate);
        nextWorld.add(gate.root);
        completeOperation();
      }
      for (const placements of placementGroups.values()) {
        const assetId = placements[0]!.assetId;
        const manifest = byId.get(assetId);
        if (!manifest) throw new Error(`Region ${region.id} placement ${placements[0]!.id} references missing manifest asset '${assetId}'.`);
        if (manifest.kind !== 'prop' || manifest.sourceType !== 'native-glb') throw new Error(`Prop placement ${placements[0]!.id} requires exact native-glb prop '${assetId}'.`);
        const baseBatch = await this.assetLoader.loadStaticBatch(manifest, placements, foliageLimitsFor(assetId));
        if (this.disposed || loadEpoch !== this.loadEpoch) { baseBatch.dispose(); throw new Error('Region load was superseded.'); }
        completeOperation();
        const batches: NativeStaticBatch[] = [baseBatch];
        for (const lodId of manifest.lodIds) {
          const lodManifest = byId.get(lodId);
          if (!lodManifest || lodManifest.kind !== 'prop' || lodManifest.sourceType !== 'native-glb' || !lodManifest.runtimeUrl || lodManifest.evidenceStatus !== 'verified') {
            this.lodWarnings.push(`LOD ${lodId} for ${assetId} not loaded: a verified native GLB with runtime URL is not available.`);
            continue;
          }
          let lodAttemptSettled = false;
          try {
            const lodBatch = await this.assetLoader.loadStaticBatch(lodManifest, placements, foliageLimitsFor(assetId));
            if (this.disposed || loadEpoch !== this.loadEpoch) { lodBatch.dispose(); throw new Error('Region load was superseded.'); }
            batches.push(lodBatch);
            lodAttemptSettled = true;
          } catch (error) {
            if (this.disposed || loadEpoch !== this.loadEpoch) throw error;
            this.lodWarnings.push('LOD ' + lodId + ' for ' + assetId + ' not loaded: ' + (error instanceof Error ? error.message : String(error)));
            lodAttemptSettled = true;
          }
          if (lodAttemptSettled) completeOperation();
        }
        const worldHeight = estimateAssetHeight(batches[0]!, manifest, placements);
        const lod = new ScreenSpaceLOD(batches, placements, worldHeight, this.lodPolicy);
        lod.root.traverse((node) => { if (node instanceof Mesh) { node.castShadow = true; node.receiveShadow = true; } });
        lod.root.userData.assetId = assetId;
        lod.root.userData.lodIds = manifest.lodIds;
        nextWorld.add(lod.root);
        stagedLods.add(lod);
        for (const placement of placements) stagedEntities.set(placement.id, { assetId, root: lod.root, dispose: () => lod.dispose() });
        for (const placement of placements) stagedPlacementBatches.set(placement.id, batches);
        stagedSolids.push(...buildStaticPropColliders(baseBatch, placements, region));
      }
      for (const definition of movingDefinitions) {
        const placement = movablePlacements.get(definition.id)!;
        const manifest = byId.get(definition.assetId);
        if (!manifest || manifest.id !== definition.assetId || manifest.kind !== 'prop' || manifest.sourceType !== 'native-glb') throw new Error('Movable prop ' + definition.id + ' requires exact native-glb prop asset ' + definition.assetId + '.');
        const loaded = await this.assetLoader.load(manifest);
        if (this.disposed || loadEpoch !== this.loadEpoch) { loaded.dispose(); throw new Error('Region load was superseded.'); }
        completeOperation();
        const root = new Group();
        root.name = 'movable-prop:' + definition.id;
        root.userData.movableObjectId = definition.id;
        root.userData.assetId = definition.assetId;
        const position = this.worldFacts[definition.movedFactId] === true ? definition.to : definition.from;
        root.position.set(position.x, position.y, position.z);
        root.rotation.y = placement.rotationY;
        root.scale.set(placement.scale.x, placement.scale.y, placement.scale.z);
        root.add(loaded.root);
        root.traverse((node) => { if (node instanceof Mesh) { node.castShadow = true; node.receiveShadow = true; } });
        nextWorld.add(root);
        stagedEntities.set(definition.id, { assetId: definition.assetId, root, dispose: () => loaded.dispose() });
        stagedMovableProps.set(definition.id, { definition, root, placementRotationY: placement.rotationY, visibleWhen: placement.visibleWhen, awaitingCommit: false });
      }
      for (const entity of region.entities) {
        if (entity.kind !== 'actor' || !entity.actorId) continue;
        const manifest = byId.get(entity.assetId ?? '');
        assertRegionActorBinding(region.id, entity, manifest);
        const loaded = await this.assetLoader.load(manifest);
        if (this.disposed || loadEpoch !== this.loadEpoch) { loaded.dispose(); throw new Error('Region load was superseded.'); }
        completeOperation();
        loaded.root.position.set(entity.position.x, entity.position.y, entity.position.z);
        loaded.root.userData.regionEntityId = entity.id;
        loaded.root.userData.actorInstanceId = entity.id;
        loaded.root.userData.assetId = manifest.id;
        loaded.root.userData.actorId = entity.actorId;
        castShadows(loaded.root);
        nextWorld.add(loaded.root);
        stagedEntities.set(entity.id, loaded);
        stagedActors.set(entity.id, loaded);
        stagedActorManifests.set(entity.id, manifest);
        if (entity.visibleWhen) stagedActorVisibility.set(entity.id, entity.visibleWhen);
      }
      if (stagedEntities.has('aren') && !stagedActors.has('aren')) throw new Error('Region ' + region.id + ' uses the reserved player actor instance ID aren.');
      if (!stagedActors.has('aren')) {
        const playerManifest = byId.get('actor-aren');
        if (playerManifest) {
          if (playerManifest.actorId !== 'aren' || playerManifest.kind !== 'character' || playerManifest.sourceType !== 'native-glb' || playerManifest.variantOf) {
            throw new Error('Region ' + region.id + ' requires the canonical native character asset actor-aren for the player.');
          }
          const player = await this.assetLoader.load(playerManifest);
          if (this.disposed || loadEpoch !== this.loadEpoch) { player.dispose(); throw new Error('Region load was superseded.'); }
          completeOperation();
          player.root.visible = false;
          player.root.userData.actorInstanceId = 'aren';
          player.root.userData.actorId = 'aren';
          player.root.userData.assetId = playerManifest.id;
          castShadows(player.root);
          nextWorld.add(player.root);
          stagedEntities.set('aren', player);
          stagedActors.set('aren', player);
          stagedActorManifests.set('aren', playerManifest);
        }
      }
      if (this.disposed || loadEpoch !== this.loadEpoch) throw new Error('Region load was disposed or superseded before commit.');
      const stagedPlayer = stagedActors.get('aren');
      if (stagedPlayer && weaponManifest) {
        if (weaponManifest.kind !== 'prop' || weaponManifest.sourceType !== 'native-glb') throw new Error('Region ' + region.id + ' requires native-glb prop ' + WARDEN_WEAPON_ASSET_ID + ' for the player weapon.');
        const glaive = await this.assetLoader.load(weaponManifest);
        if (this.disposed || loadEpoch !== this.loadEpoch) { glaive.dispose(); throw new Error('Region load was superseded.'); }
        completeOperation();
        try { stagedWeapon = new WardenWeapon(glaive, stagedPlayer); } catch (error) { glaive.dispose(); throw error; }
      }
      const stagedOrun = orunEntity ? stagedActors.get(orunEntity.id) : undefined;
      if (stagedOrun) {
        if (!weaponManifest || weaponManifest.kind !== 'prop' || weaponManifest.sourceType !== 'native-glb') throw new Error('Orun requires native-glb prop ' + WARDEN_WEAPON_ASSET_ID + '.');
        const glaive = await this.assetLoader.load(weaponManifest);
        if (this.disposed || loadEpoch !== this.loadEpoch) { glaive.dispose(); throw new Error('Region load was superseded.'); }
        completeOperation();
        // Orun's measured 23-joint rig has no finger chains; fit its actual hand mesh like the native staff carrier.
        try { stagedOrunWeapon = new WardenWeapon(glaive, stagedOrun, 'warden', true); } catch (error) { glaive.dispose(); throw error; }
      }
      // The weapon hangs on the hand before the afterimages clone Aren, so every ghost carries it too.
      if (stagedPlayer) { stagedAfterimages = new PoseAfterimages(this.scene, stagedPlayer.root); stagedAfterimages.setStyle('warden'); }
      stagedShadows = new ContactShadows();
      nextWorld.add(stagedShadows.mesh);
      const previousWorld = this.world.children[0];
      if (previousWorld) this.world.remove(previousWorld);
      this.world.add(nextWorld);
      const previousEnvironment = this.environment;
      const previousEntities = new Map(this.entityRoots);
      // Ghosts borrow the fitted geometry; retire them before restoring/freeing it.
      this.afterimages?.dispose();
      if (this.unarmedFists) { releaseHandGeometry(this.unarmedFists); this.unarmedFists = null; }
      this.wardenWeapon?.dispose();
      this.wardenWeapon = stagedWeapon;
      stagedWeapon = null;
      this.orunWeapon?.dispose();
      this.orunWeapon = stagedOrunWeapon;
      stagedOrunWeapon = null;
      this.trialGates?.dispose(); this.trialGates = null; this.gateOpenings.length = 0;
      this.waystone?.dispose(); this.waystone = null;
      this.afterimages = stagedAfterimages;
      stagedAfterimages = null;
      this.contactShadows?.dispose();
      this.contactShadows = stagedShadows;
      stagedShadows = null;
      this.playerOutcome = null;
      this.obstacleVisuals.clear();
      this.orunPresentation.clear();
      this.nativeSolidEntries = stagedSolids;
      for (const variants of this.actorVariants.values()) for (const instance of variants.values()) instance.dispose();
      this.actorVariants.clear();
      this.variantLoads.clear();
      this.storyFacts.clear();
      for (const lod of this.staticLods) lod.dispose();
      this.staticLods.clear();
      this.skipEstablishingShot();
      this.region = region;
      this.groundArena = arenaFromRegion(region);
      this.environment = nextEnvironment;
      this.entityRoots.clear();
      this.actorRoots.clear();
      this.actorManifests.clear();
      this.propResponses.clear();
      this.placementBatches.clear();
      this.movableProps.clear();
      this.migrationGates.clear();
      this.actorVisibilityConditions.clear();
      for (const [id, instance] of stagedEntities) this.entityRoots.set(id, instance);
      for (const [id, instance] of stagedActors) this.actorRoots.set(id, instance);
      for (const [id, instance] of stagedMovableProps) this.movableProps.set(id, instance);
      for (const [id, gate] of stagedMigrationGates) this.migrationGates.set(id, gate);
      for (const [id, manifest] of stagedActorManifests) this.actorManifests.set(id, manifest);
      for (const lod of stagedLods) this.staticLods.add(lod);
      for (const [id, batches] of stagedPlacementBatches) this.placementBatches.set(id, batches);
      for (const [id, fact] of stagedActorVisibility) this.actorVisibilityConditions.set(id, fact);
      this.assetCatalog = byId;
      setSceneAtmosphere(this.scene, region);
      this.environment.setReducedEffects(this.reducedMotion);
      const environment = this.environment;
      this.atmosphere = environment.skyDome ? {
        sky: environment.skyDome, heightFog: environment.mood.heightFog, grade: environment.mood.grade, lightShafts: environment.mood.lightShafts,
        getFocus: () => environment.getLastFocus(),
      } : null;
      if (this.atmosphere) configureRegionAtmosphere(this.postFx, this.atmosphere);
      this.environment.syncWorldFacts(this.worldFacts);
      this.applyMovableWorldFacts();
      this.applyPlacementVisibility();
      previousEnvironment?.dispose();
      for (const instance of new Set(previousEntities.values())) if (![...stagedEntities.values()].includes(instance)) instance.dispose();
      stagedEntities.clear();
      stagedActors.clear();
      stagedActorManifests.clear();
      stagedLods.clear();
      this.missingActorAssets.clear();
      this.assetErrors.length = 0;
      this.syncActors(this.currentCombat?.actors ?? []);
      this.hitFlash.forget(root => [...this.actorRoots.values()].some(instance => instance.root === root));
      this.prewarmHitFlash();
    } catch (error) {
      stagedAfterimages?.dispose();
      stagedShadows?.dispose();
      stagedWeapon?.dispose();
      stagedOrunWeapon?.dispose();
      nextEnvironment.dispose();
      for (const instance of new Set(stagedEntities.values())) instance.dispose();
      for (const lod of stagedLods) lod.dispose();
      const message = error instanceof Error ? error.message : String(error);
      if (loadEpoch === this.loadEpoch) this.assetErrors.push(message);
      throw error;
    } finally {
      if (loadEpoch === this.loadEpoch) this.loading = false;
    }
  }

  async setPlayerHero(heroId: HeroId): Promise<void> {
    this.assertAlive();
    const hero = heroById(heroId);
    if (!hero.variantAssetId) {
      const player = this.actorRoots.get('aren');
      if (!player) throw new Error('Missing canonical native player asset.');
      // The region's glaive may have been retired when an unarmed/variant hero was equipped.
      if (this.wardenWeapon?.carrier !== player.root) {
        const manifest = hero.weaponAssetId ? this.assetCatalog.get(hero.weaponAssetId) : undefined;
        if (!manifest || manifest.kind !== 'prop' || manifest.sourceType !== 'native-glb') throw new Error('Missing native assets for ' + hero.name);
        const epoch = this.loadEpoch;
        const source = await this.assetLoader.load(manifest);
        let weapon: WardenWeapon | null = null;
        let ghosts: PoseAfterimages | null = null;
        try {
          if (this.disposed || !this.region || epoch !== this.loadEpoch) throw new Error('Hero weapon load was superseded.');
          weapon = new WardenWeapon(source, player, weaponKindForGrip(hero.weaponGrip));
          ghosts = new PoseAfterimages(this.scene, player.root);
          ghosts.setStyle(hero.style);
        } catch (error) {
          ghosts?.dispose();
          if (weapon) weapon.dispose(); else source.dispose();
          throw error;
        }
        this.afterimages?.dispose();
        this.wardenWeapon?.dispose();
        if (this.unarmedFists) { releaseHandGeometry(this.unarmedFists); this.unarmedFists = null; }
        this.wardenWeapon = weapon;
        this.afterimages = ghosts;
      }
      this.applyHeroSpeeds(heroId);
      this.dodgeVanish = null;
      this.afterimages?.setStyle(hero.style);
      this.prewarm([player.root]);
      return;
    }
    if (!hero.weaponAssetId) {
      const manifest = this.assetCatalog.get(hero.variantAssetId);
      const base = this.actorManifests.get('aren');
      if (!manifest || !base || manifest.kind !== 'character' || manifest.sourceType !== 'native-glb' || manifest.actorId !== base.actorId || manifest.variantOf !== base.id) throw new Error('Missing native assets for ' + hero.name);
      const epoch = this.loadEpoch;
      // Stage a fresh skeleton clone: an equip failure must leave the current carrier and ghosts intact.
      const player = await this.assetLoader.load(manifest);
      let fists: HandGeometryEdit | null = null;
      let ghosts: PoseAfterimages | null = null;
      try {
        if (this.disposed || !this.region || epoch !== this.loadEpoch) throw new Error('Hero load was superseded.');
        player.root.visible = false;
        castShadows(player.root);
        fists = fitUnarmedFists(player.root);
        player.root.userData.actorInstanceId = 'aren';
        player.root.userData.actorId = manifest.actorId;
        player.root.userData.assetId = manifest.id;
        const snapshot = this.actorSnapshots.get('aren');
        if (snapshot?.renderVariantId === manifest.id) this.applyActorSnapshot(player, snapshot);
        ghosts = new PoseAfterimages(this.scene, player.root);
        ghosts.setStyle(hero.style);
      } catch (error) {
        ghosts?.dispose();
        if (fists) releaseHandGeometry(fists);
        player.dispose();
        throw error;
      }
      const variants = this.actorVariants.get('aren') ?? new Map<string, NativeAssetInstance>();
      const previous = variants.get(hero.variantAssetId);
      this.afterimages?.dispose();
      this.wardenWeapon?.dispose(); this.wardenWeapon = null;
      if (this.unarmedFists) releaseHandGeometry(this.unarmedFists);
      previous?.dispose();
      this.unarmedFists = fists;
      this.afterimages = ghosts;
      variants.set(hero.variantAssetId, player);
      this.actorVariants.set('aren', variants);
      this.world.children[0]?.add(player.root);
      this.applyHeroSpeeds(heroId);
      this.dodgeVanish = hero.dodgeVanish ? { assetId: manifest.id, from: .15, to: .55 } : null;
      this.prewarm([player.root]);
      return;
    }
    this.applyHeroSpeeds(heroId);
    const epoch = this.loadEpoch;
    await this.preloadActorVariant('aren', hero.variantAssetId);
    if (this.disposed || epoch !== this.loadEpoch) throw new Error('Hero load was superseded.');
    const player = this.actorVariants.get('aren')?.get(hero.variantAssetId);
    if (!player) throw new Error('Missing native assets for ' + hero.name);
    // An unarmed hero (no weapon asset) fights with fists and feet; every other hero carries a native weapon.
    let weaponSource: NativeAssetInstance | null = null;
    let kind: WardenWeaponKind | null = null;
    if (hero.weaponAssetId) {
      const manifest = this.assetCatalog.get(hero.weaponAssetId);
      if (!manifest || manifest.kind !== 'prop' || manifest.sourceType !== 'native-glb') throw new Error('Missing native assets for ' + hero.name);
      kind = weaponKindForGrip(hero.weaponGrip);
      weaponSource = await this.assetLoader.load(manifest);
      if (this.disposed || epoch !== this.loadEpoch) { weaponSource.dispose(); throw new Error('Hero weapon load was superseded.'); }
    }
    // Re-equipping the same native carrier must restore its mesh and hook before fitting again.
    if (this.wardenWeapon?.carrier === player.root) {
      this.afterimages?.dispose();
      this.afterimages = null;
      this.wardenWeapon.dispose();
      this.wardenWeapon = null;
    }
    let weapon: WardenWeapon | null = null;
    if (weaponSource && kind) {
      try { weapon = new WardenWeapon(weaponSource, player, kind); } catch (error) { weaponSource.dispose(); throw error; }
    }
    this.afterimages?.dispose();
    if (this.unarmedFists) { releaseHandGeometry(this.unarmedFists); this.unarmedFists = null; }
    this.wardenWeapon?.dispose();
    this.wardenWeapon = weapon;
    this.afterimages = new PoseAfterimages(this.scene, player.root);
    this.afterimages.setStyle(hero.style);
    this.dodgeVanish = hero.dodgeVanish ? { assetId: hero.variantAssetId, from: hero.style === 'umbral' ? 0.1 : 0.15, to: hero.style === 'umbral' ? 0.6 : 0.55 } : null;
    // The variant body, its weapon and the fresh ghost pool are hidden until the next sync; link and upload them now.
    this.prewarm([player.root]);
  }

  /** Stage native party bodies without replacing the live region or its encounter. */
  async prepareCompanionParty(region: RegionDefinition, assets: readonly AssetManifestEntry[]): Promise<PreparedCompanionParty> {
    const epoch = this.loadEpoch;
    const byId = new Map(assets.map(entry => [entry.id, entry]));
    const placements = region.entities.filter(entity => entity.kind === 'actor' && entity.id.includes('__party_'));
    const nextIds = new Set(placements.map(entity => entity.id));
    const staged = new Map<string, NativeAssetInstance>();
    let committed = false;
    const dispose = () => { if (!committed) { for (const instance of staged.values()) instance.dispose(); staged.clear(); } };
    try {
      for (const entity of placements) {
        const manifest = byId.get(entity.assetId ?? '');
        assertRegionActorBinding(region.id, entity, manifest);
        if (this.actorRoots.has(entity.id)) continue;
        const instance = await this.assetLoader.load(manifest);
        staged.set(entity.id, instance);
        if (this.disposed || epoch !== this.loadEpoch) throw new Error('Party load was superseded.');
        instance.root.position.set(entity.position.x, entity.position.y, entity.position.z);
        Object.assign(instance.root.userData, { regionEntityId: entity.id, actorInstanceId: entity.id, assetId: manifest.id, actorId: entity.actorId });
        castShadows(instance.root);
      }
    } catch (error) { dispose(); throw error; }
    return {
      dispose,
      commit: () => {
        if (committed) return;
        if (this.disposed || epoch !== this.loadEpoch) { dispose(); throw new Error('Party load was superseded.'); }
        committed = true;
        for (const [id, instance] of this.actorRoots) {
          if (!id.includes('__party_') || nextIds.has(id)) continue;
          for (const variant of this.actorVariants.get(id)?.values() ?? []) { variant.root.removeFromParent(); variant.dispose(); }
          this.actorVariants.delete(id);
          instance.root.removeFromParent(); instance.dispose();
          this.actorRoots.delete(id); this.actorManifests.delete(id); this.actorSnapshots.delete(id); this.entityRoots.delete(id);
        }
        for (const [id, instance] of staged) {
          this.world.add(instance.root); this.actorRoots.set(id, instance); this.entityRoots.set(id, instance);
        }
        for (const entity of placements) this.actorManifests.set(entity.id, byId.get(entity.assetId!)!);
        this.assetCatalog = byId;
        this.region = region;
        this.hitFlash.forget(root => [...this.actorRoots.values()].some(instance => instance.root === root));
      },
    };
  }

  /**
   * Loads a native character variant of the placed instance's base asset (same canonical actor, `variantOf` = the base asset) and keeps it
   * hidden until a snapshot asks for it by `renderVariantId` (Koro's hostile body -> ally body, Orun's crowned form). Idempotent per
   * (actor, asset): a repeated or concurrent call shares the one load. The variant is linked and uploaded here, so the swap never stalls on a
   * program link; a region load that supersedes the call disposes the staged instance instead of attaching it to the new world.
   */
  preloadActorVariant(actorId: string, assetId: string, assets: readonly AssetManifestEntry[] = [...this.assetCatalog.values()]): Promise<void> {
    this.assertAlive();
    const baseManifest = this.actorManifests.get(actorId);
    if (!baseManifest) return Promise.reject(new Error(`Actor ${actorId} has no loaded base asset in the current region.`));
    const manifest = assets.find((entry) => entry.id === assetId);
    try { assertActorVariantBinding(baseManifest, manifest, assetId); } catch (error) { return Promise.reject(error); }
    if (this.actorVariants.get(actorId)?.has(assetId)) return Promise.resolve();
    const key = actorId + '\u0000' + assetId;
    const pending = this.variantLoads.get(key);
    if (pending) return pending;
    const loadEpoch = this.loadEpoch;
    const load = (async () => {
      const loaded = await this.assetLoader.load(manifest);
      if (this.disposed || !this.region || loadEpoch !== this.loadEpoch) { loaded.dispose(); throw new Error('Renderer or region changed while loading actor variant.'); }
      const variants = this.actorVariants.get(actorId) ?? new Map<string, NativeAssetInstance>();
      variants.set(assetId, loaded);
      this.actorVariants.set(actorId, variants);
      loaded.root.userData.actorInstanceId = actorId;
      loaded.root.userData.actorId = manifest.actorId;
      loaded.root.userData.assetId = assetId;
      castShadows(loaded.root);
      this.world.children[0]?.add(loaded.root);
      const snapshot = this.actorSnapshots.get(actorId);
      if (snapshot?.renderVariantId === assetId) this.applyActorSnapshot(loaded, snapshot);
      else loaded.root.visible = false;
      this.prewarm([loaded.root]);
    })().finally(() => { if (this.variantLoads.get(key) === load) this.variantLoads.delete(key); });
    this.variantLoads.set(key, load);
    return load;
  }

  /** Sample native actors and camera before socket-bound presentation is updated. */
  sync(actors: readonly ActorSnapshot[], combat: CombatSnapshot, dt: number, previous?: CombatSnapshot, alpha = 1): void {
    this.assertAlive();
    this.currentCombat = combat;
    // Only consecutive fixed steps can be interpolated; loads, resets and teleports snap.
    const adjacent = previous && previous.worldClock.simulationTick + 1 === combat.worldClock.simulationTick
      && previous.worldClock.worldTick <= combat.worldClock.worldTick;
    const prior = adjacent ? previous : undefined;
    const blend = prior ? Math.max(0, Math.min(1, alpha)) : 1;
    this.renderSimulationTick = prior
      ? prior.worldClock.simulationTick + blend : combat.worldClock.simulationTick;
    this.renderWorldTimeSeconds = prior
      ? prior.worldClock.worldTimeSeconds + (combat.worldClock.worldTimeSeconds - prior.worldClock.worldTimeSeconds) * blend
      : combat.worldClock.worldTimeSeconds;
    const lastWorldTime = this.lastRenderWorldTimeSeconds;
    if (lastWorldTime !== undefined && this.renderWorldTimeSeconds < lastWorldTime) this.monsterHover = new WeakMap();
    this.renderWorldDeltaSeconds = lastWorldTime === undefined ? 0 : Math.max(0, this.renderWorldTimeSeconds - lastWorldTime);
    this.lastRenderWorldTimeSeconds = this.renderWorldTimeSeconds;
    this.syncMovableObjects(combat.movableObjects);
    this.lodMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.lodFrustum.setFromProjectionMatrix(this.lodMatrix);
    this.presentationFrame += 1;
    this.syncedActors = actors;
    this.animationLod.updated = 0; this.animationLod.skipped = 0;
    this.syncActors(actors, prior, blend, dt);
    // Fades share the sampled actor's clock: hostile/ally world time, player simulation time.
    const frozen = (combat.hitStop?.remainingTicks ?? 0) > 0 || combat.worldClock.policy === 'paused';
    for (const actor of actors) {
      const animationDt = actor.allegiance === 'player' ? dt : this.renderWorldDeltaSeconds;
      this.advanceAnimation(this.actorRoots.get(actor.id), animationDt, frozen);
      const requested = actor.renderVariantId;
      if (requested) this.advanceAnimation(this.actorVariants.get(actor.id)?.get(requested), animationDt, frozen);
    }
    const player = actors.find((actor) => actor.id === 'aren') ?? actors.find((actor) => actor.allegiance === 'player');
    const base = player && this.actorRoots.get(player.id);
    const active = player?.renderVariantId && player.renderVariantId !== base?.assetId
      ? this.actorVariants.get(player.id)?.get(player.renderVariantId) : base;
    this.updateContactShadows(actors);
    this.environment?.update(this.renderWorldTimeSeconds, active?.root.position ?? player?.position);
    // Instanced trees/bushes sway on the same world clock as the grass (frozen with it under hit-stop and pause).
    setFoliageWorldWind(this.renderWorldTimeSeconds);
    if (this.atmosphere) updateRegionShafts(this.postFx, this.atmosphere, this.camera);
    if (player) this.afterimages?.update(player, combat.worldClock, this.reducedMotion || !this.motionBlur);
    this.obstacleVisuals.update(combat.combatObstacles ?? EMPTY_COMBAT_OBSTACLES, combat.worldClock, this.reducedMotion);
    if (this.propResponses.update(combat.environmentProps ?? EMPTY_ENVIRONMENT_PROPS, combat.worldClock, this.reducedMotion)) this.applyPlacementVisibility();
    this.orunPresentation.sync(combat, this.reducedMotion);
    this.trialGates?.update(combat.trialGates ?? []);
    this.trialGates?.animate(this.renderWorldTimeSeconds, active?.root.position ?? player?.position);
    if (this.trialGates) this.collectGateOpenings(this.trialGates);
    this.cameraDirector.update(combat, active?.root.position, dt);
    this.hitFlash.update(dt);
    this.cameraDirector.copyTarget(this.scratchTarget);
    const height = this.renderer.domElement.clientHeight;
    for (const lod of this.staticLods) lod.update(this.camera, this.scratchTarget, height);
    this.trialGates?.updateOcclusion(this.camera, this.scratchTarget);
  }

  /** Draw after presentation has consumed the same authoritative world clock. */
  render(): void {
    this.assertAlive();
    if (this.cameraDirector.establishingShotActive) {
      const now = performance.now();
      this.cameraDirector.advanceEstablishingShot(Math.min(0.1, (now - this.establishingClock) / 1000));
      this.establishingClock = now;
    }
    if (this.cameraDirector.revealActive) {
      const now = performance.now();
      this.cameraDirector.advanceReveal(Math.min(0.1, (now - this.revealClock) / 1000));
      this.revealClock = now;
    }
    // Also after a sweep that ended on its own (or by reduced motion): the fog returns to the authored values before the draw.
    if (this.shotFog) this.applyShotFog();
    this.cameraDirector.copyTarget(this.scratchTarget);
    this.orunPresentation.applyFog(this.scene, this.camera, this.scratchTarget);
    this.postFx.render(0);
  }

  private applyReducedMotion(reduced: boolean): void {
    if (reduced === this.reducedMotion) return;
    this.reducedMotion = reduced;
    setFoliageReducedMotion(reduced);
    if (reduced) this.afterimages?.clear();
    this.cameraDirector.setReducedMotion(reduced);
    this.applyShotFog();
    this.hitFlash.setEnabled(!reduced);
    this.postFx.setReducedEffects(reduced);
    this.environment?.setReducedEffects(reduced);
  }

  /**
   * Applies persisted accessibility settings. `reducedMotion` reuses the single reduced-motion path; `motionBlur` is
   * only enabled while reduced motion is off; `reducedCameraShake` sets the camera shake scale independently — but
   * reduced-motion still suppresses shake through the existing `setReducedMotion` path.
   */
  setSettings(settings: GameSettings): void {
    this.applyReducedMotion(settings.reducedMotion);
    const motionBlurEnabled = !settings.reducedMotion && settings.motionBlur;
    this.motionBlur = settings.motionBlur;
    this.postFx.setMotionBlur(motionBlurEnabled);
    this.afterimages?.setMotionBlur(motionBlurEnabled);
    this.cameraDirector.setShakeScale(settings.reducedCameraShake ? 0.25 : 1);
  }

  /** Presentation-only camera shake (e.g. gate opening, impacts); ignored in reduced motion. */
  addCameraShake(amplitude: number, durationSeconds: number, frequency = 18): void { this.cameraDirector.addShake(amplitude, durationSeconds, frequency); }

  /**
   * Boss reveal: frames the supplied actor id for the requested duration (~2-2.5 s) with a slow push-in and orbit,
   * then eases back to the gameplay pose. The simulation must be paused by the caller (the chapter encounter path
   * already holds `timePolicy = 'paused'` while the intro runs); the renderer does not touch the world clock.
   * Reduced motion hard-cuts to a static boss framing for the same duration then cuts back. Returns false when the
   * actor isn't present or the duration is non-positive.
   */
  playBossReveal(actorId: string, durationSeconds = 2.25): boolean {
    this.assertAlive();
    const snapshot = this.actorSnapshots.get(actorId);
    if (!snapshot) return false;
    if (!this.cameraDirector.beginReveal(snapshot.position, durationSeconds)) return false;
    this.revealClock = performance.now();
    return true;
  }

  /** Skip the boss reveal early; cuts back to the gameplay pose immediately. Idempotent. */
  skipBossReveal(): void { this.cameraDirector.skipReveal(); }

  /** True while the boss reveal sequence runs. */
  get bossRevealActive(): boolean { return this.cameraDirector.revealActive; }

  /**
   * Presentation-only establishing shot: the camera starts on a high wide orbit of the current region and eases down to exactly the
   * gameplay framing of the player. Driven by real time inside `render()`; the simulation is untouched. Reduced motion or a
   * non-positive duration is a no-op.
   */
  beginEstablishingShot(options: { readonly seconds: number; readonly reducedMotion: boolean }): void {
    this.assertAlive();
    // A second begin restarts from the true fog and gameplay framing rather than capturing the pushed-out fog as authored.
    this.skipEstablishingShot();
    const player = this.actorSnapshots.get('aren');
    if (this.currentCombat) this.cameraDirector.update(this.currentCombat, player && this.displayedInstance(player.id)?.root.position, 0);
    const shot = this.establishingFraming();
    if (!shot) return;
    if (!this.cameraDirector.beginEstablishingShot({ ...shot.framing, seconds: options.seconds, reducedMotion: options.reducedMotion || this.reducedMotion })) return;
    this.establishingClock = performance.now();
    const fog = this.scene.fog;
    this.shotFog = fog instanceof Fog && shot.fogSpread > 1 ? { fog, near: fog.near, far: fog.far, spread: shot.fogSpread } : null;
    this.applyShotFog();
  }

  /** Jumps to the gameplay framing immediately. */
  skipEstablishingShot(): void {
    this.cameraDirector.skipEstablishingShot();
    this.applyShotFog();
  }

  /** True while the establishing sweep runs. */
  get establishingShotActive(): boolean { return this.cameraDirector.establishingShotActive; }

  /**
   * The fog is pushed outward for the sweep and eased back with the camera, then restored to the exact authored near/far (the fog
   * object is only ever scaled, never replaced). Presentation only: the region keeps its own fog values.
   */
  private applyShotFog(): void {
    const shot = this.shotFog;
    if (!shot) return;
    const scale = this.cameraDirector.establishingShotActive ? 1 + (shot.spread - 1) * (1 - this.cameraDirector.establishingShotEase) : 1;
    shot.fog.near = shot.near * scale;
    shot.fog.far = shot.far * scale;
    if (scale === 1) this.shotFog = null;
  }

  /**
   * Opening orbit (see `planEstablishingShot`): it looks at a point 60 % of the way from the middle of the walkable surfaces' bounds
   * to the player (so the player's surroundings and the route ahead fill the frame) at a distance that fits the walkable diagonal
   * (44–80 m, inside the far plane), from 32° above the horizon plus one degree for every metre by which the tallest static prop around
   * the look point exceeds 12 m (up to 54°). Candidate distances and sweep directions are checked so that no frame ray at any sampled
   * step lands past the drawn terrain mesh unless the fog there is at least 90 % opaque; the fog is spread only as
   * far as that allows and as the look point needs (its 70 %-opaque distance at least 1.3× the start distance, up to 3×).
   */
  private establishingFraming(): { framing: EstablishingFraming; fogSpread: number } | undefined {
    const region = this.region;
    if (!region) return undefined;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, elevation = 0, samples = 0;
    for (const surface of region.ground.surfaces) {
      if (!surface.walkable) continue;
      for (const point of surface.points) {
        minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x); minZ = Math.min(minZ, point.z); maxZ = Math.max(maxZ, point.z);
        elevation += point.y; samples++;
      }
    }
    if (samples === 0) { minX = region.bounds.min.x; maxX = region.bounds.max.x; minZ = region.bounds.min.z; maxZ = region.bounds.max.z; elevation = region.ground.y; samples = 1; }
    const player = this.actorSnapshots.get('aren')?.position;
    const lean = player ? 0.6 : 0;
    const centerX = (minX + maxX) / 2, centerY = elevation / samples, centerZ = (minZ + maxZ) / 2;
    const look = { x: centerX + (player ? player.x - centerX : 0) * lean, y: centerY + (player ? player.y - centerY : 0) * lean, z: centerZ + (player ? player.z - centerZ : 0) * lean };
    this.cameraDirector.copyTarget(this.scratchTarget);
    const fog = this.scene.fog instanceof Fog ? this.scene.fog : null;
    let terrain: { minX: number; maxX: number; minZ: number; maxZ: number } | undefined;
    // The drawn terrain mesh (`<biome>-terrain`) ends where the world ends; regions without one fall back to the region bounds plus 12 m.
    this.scene.traverse((node) => {
      if (terrain || !(node as Mesh).isMesh || !node.name.endsWith('-terrain')) return;
      this.shotBox.setFromObject(node);
      terrain = { minX: this.shotBox.min.x + 1, maxX: this.shotBox.max.x - 1, minZ: this.shotBox.min.z + 1, maxZ: this.shotBox.max.z - 1 };
    });
    const bounds = region.bounds, margin = 12;
    const plan = planEstablishingShot({
      look, target: { x: this.scratchTarget.x, y: this.scratchTarget.y, z: this.scratchTarget.z },
      diagonal: Math.hypot(maxX - minX, maxZ - minZ),
      tallest: Math.max(0, this.tallestPropTop(look.x, look.z, MAX_SHOT_DISTANCE + 10) - look.y),
      terrain: terrain ?? { minX: bounds.min.x - margin, maxX: bounds.max.x + margin, minZ: bounds.min.z - margin, maxZ: bounds.max.z + margin },
      groundY: look.y, fovDegrees: this.camera.fov, aspect: this.camera.aspect,
      fog: fog ? { near: fog.near, far: fog.far } : null,
    }, { x: centerX, y: centerY, z: centerZ });
    return { framing: plan.framing, fogSpread: plan.fogSpread };
  }

  /** World height of the tallest static prop whose base lies within `radius` (horizontally) of x/z; 0 when none. Runs once per shot, over the placement batches' instance matrices. */
  private tallestPropTop(x: number, z: number, radius: number): number {
    let top = 0;
    for (const batches of this.placementBatches.values()) {
      for (const batch of batches) {
        batch.root.updateWorldMatrix(true, true);
        batch.root.traverse((node) => {
          const mesh = node as Mesh;
          if (!mesh.isMesh) return;
          if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
          const bounds = mesh.geometry.boundingBox!;
          if (!(mesh as InstancedMesh).isInstancedMesh) {
            this.shotBox.setFromObject(mesh);
            if (!this.shotBox.isEmpty() && Math.hypot((this.shotBox.min.x + this.shotBox.max.x) / 2 - x, (this.shotBox.min.z + this.shotBox.max.z) / 2 - z) <= radius) top = Math.max(top, this.shotBox.max.y);
            return;
          }
          const instanced = mesh as InstancedMesh;
          for (let index = 0; index < instanced.count; index++) {
            instanced.getMatrixAt(index, this.shotMatrix);
            this.shotMatrix.premultiply(instanced.matrixWorld);
            this.shotPoint.set((bounds.min.x + bounds.max.x) / 2, bounds.max.y, (bounds.min.z + bounds.max.z) / 2).applyMatrix4(this.shotMatrix);
            if (this.shotPoint.y > top && Math.hypot(this.shotPoint.x - x, this.shotPoint.z - z) <= radius) top = this.shotPoint.y;
          }
        });
      }
    }
    return top;
  }

  /** Presentation-only post-processing kick (hit impacts, finishers); ignored in reduced motion. */
  addScreenImpulse(strength: number, seconds: number): void { this.postFx.addImpulse(strength, seconds); }

  /** Emissive rim flash on the actor's visible render instance; `charge` ramps up instead of decaying. */
  flashActor(actorId: string, color: Color, intensity: number, durationSeconds: number, mode: 'hit' | 'charge' = 'hit'): void {
    const root = this.resolveActorRoot(actorId);
    if (root) this.hitFlash.flash(root, color, intensity, durationSeconds, mode);
  }

  /** Render root of the actor's currently displayed instance (base asset or active variant). */
  resolveActorRoot(actorId: string): Object3D | undefined { return this.displayedInstance(actorId)?.root; }

  /** Presentation-only: one soft contact shadow per visible grounded actor, placed under the displayed (interpolated) root and fading as it leaves the ground. */
  private updateContactShadows(actors: readonly ActorSnapshot[]): void {
    const shadows = this.contactShadows;
    if (!shadows) return;
    shadows.begin();
    for (const actor of actors) {
      const instance = this.displayedInstance(actor.id);
      const root = instance?.root;
      if (!instance || !root || !root.visible) continue;
      let footprint = this.footprints.get(instance);
      if (footprint === undefined) { footprint = measureFootprint(root); this.footprints.set(instance, footprint); }
      if (!footprint) continue;
      const { x, z } = root.position;
      // The drawn root may trail a step the simulation already took; the shadow and its fade follow the simulated ground contact.
      const y = root.position.y - (this.actorMotion.get(instance)?.yOffset ?? 0);
      const ground = this.groundHeight(x, z, y) ?? this.environment?.visualGroundHeightAt(x, z);
      if (ground === undefined) continue;
      groundNormalAt(this.groundHeight, x, z, ground, this.groundNormal);
      const opacity = contactShadowOpacity(y - ground, MONSTER_HOVER[instance.assetId] ? HOVER_FADE : GROUNDED_FADE);
      shadows.add(footprint, x, ground, z, root.rotation.y, this.groundNormal.x, this.groundNormal.y, this.groundNormal.z, root.scale.x, opacity);
    }
    shadows.end();
  }

  /** A LOD-held instance owes only elapsed actor-clock time, never paused or hit-stop frames. */
  private advanceAnimation(instance: NativeAssetInstance | undefined, dt: number, frozen: boolean): void {
    if (!instance || frozen) return;
    const extras = this.actorExtras.get(instance);
    if (extras?.lodSkip) { extras.pendingDt += dt; return; }
    instance.animation.update(extras ? dt + extras.pendingDt : dt);
    if (extras) extras.pendingDt = 0;
  }

  /**
   * Procedural rig of an instance, resolved once: foot IK for complete Mixamo bipeds and for creature limbs (never for flyers), and the bone
   * layer over them (reaction bends, look-at, spring tails) wherever the rig has the bones for it. Installed as the controller's grounding slot.
   */
  private rigFor(instance: NativeAssetInstance): ActorRig {
    let rig = this.footGrounding.get(instance);
    if (rig === undefined) {
      const bones = findRigBones(instance.root);
      const hover = MONSTER_HOVER[instance.assetId] !== undefined;
      const foot = hover ? null : FootGrounding.create(instance.root, this.groundHeight);
      const quad = hover || foot || !bones ? null : QuadrupedGrounding.create(instance.root, bones.limbs, this.groundHeight);
      const procedural = bones ? new ActorProcedural(instance.root, bones, foot ?? quad) : null;
      rig = { foot, quad, procedural, creature: bones?.kind === 'creature' };
      this.footGrounding.set(instance, rig);
      const slot = procedural ?? foot ?? quad;
      if (slot) instance.animation.setGrounding(slot);
    }
    return rig;
  }

  private displayedInstance(actorId: string): NativeAssetInstance | undefined {
    const variantId = this.actorSnapshots.get(actorId)?.renderVariantId;
    const base = this.actorRoots.get(actorId);
    return variantId && variantId !== base?.assetId ? this.actorVariants.get(actorId)?.get(variantId) : base;
  }

  /** Per-instance height/lean state; its root takes yaw-then-pitch-then-roll so the lean is about the body's own axes. */
  private motionFor(instance: NativeAssetInstance): ActorMotionState {
    let motion = this.actorMotion.get(instance);
    if (!motion) {
      motion = createActorMotionState();
      instance.root.rotation.order = 'YXZ';
      this.actorMotion.set(instance, motion);
    }
    return motion;
  }

  private applyHeroSpeeds(heroId: HeroId): void {
    this.playerWalkSpeed = HERO_COMBAT[heroId].walkSpeed;
    this.playerRunSpeed = HERO_COMBAT[heroId].runSpeed;
  }

  /** The combat-trial role (`encounterStatus.monsters[]`) of a non-player actor, or undefined outside the trials. */
  private trialMonsterRole(actor: ActorSnapshot): { active: boolean; boss: boolean } | undefined {
    const monsters = this.currentCombat?.encounterStatus?.monsters;
    if (!monsters || actor.allegiance === 'player') return undefined;
    for (const entry of monsters) {
      if (entry.id !== actor.id) continue;
      let role = this.trialMonsterRoles.get(actor.id);
      if (!role) { role = { active: false, boss: false }; this.trialMonsterRoles.set(actor.id, role); }
      role.active = entry.active;
      role.boss = Boolean(entry.boss);
      return role;
    }
    return undefined;
  }

  /**
   * Compiles programs for currently hidden objects (pooled VFX, actors awaiting their first sync,
   * hit-flash twins, pose afterimages, pooled combat obstacles) against the HDR target and uploads
   * every texture the scene references, so a first appearance never stalls on a program link or a
   * texImage2D. Load-time and hero-switch only; the frame loop never compiles.
   */
  prewarm(roots: readonly Object3D[]): void {
    this.assertAlive();
    const hidden: Object3D[] = [];
    const reveal = (node: Object3D) => { if (!node.visible) { hidden.push(node); node.visible = true; } };
    for (const root of roots) root.traverse(reveal);
    this.afterimages?.group.traverse(reveal);
    this.obstacleVisuals.group.traverse(reveal);
    this.obstacleVisuals.debris.mesh.traverse(reveal);
    try { this.postFx.compile(this.scene, this.camera); } finally { for (const node of hidden) node.visible = false; }
    this.uploadTextures();
  }

  /** Submit actual GPU draws while loading: linking shaders alone leaves first-use buffers and driver pipelines cold. */
  warmGpu(): void {
    this.assertAlive();
    const hidden: Object3D[] = [], culled: Object3D[] = [];
    const emptyMeshes: InstancedMesh[] = [], emptyGeometry: InstancedBufferGeometry[] = [], emptyRanges: BufferGeometry[] = [];
    this.scene.traverse(node => {
      if (!node.visible) { hidden.push(node); node.visible = true; }
      if (node.frustumCulled) { culled.push(node); node.frustumCulled = false; }
      if (!(node instanceof Mesh)) return;
      if (node instanceof InstancedMesh && node.count === 0 && node.instanceMatrix.count > 0) { emptyMeshes.push(node); node.count = 1; }
      const geometry = node.geometry;
      if (geometry instanceof InstancedBufferGeometry && geometry.instanceCount === 0) { emptyGeometry.push(geometry); geometry.instanceCount = 1; }
      if (geometry.drawRange.count === 0) {
        emptyRanges.push(geometry);
        geometry.drawRange.count = Math.min(3, geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0);
      }
    });
    try { this.postFx.warmGpu(this.scene, this.camera); } finally {
      for (const node of hidden) node.visible = false;
      for (const node of culled) node.frustumCulled = true;
      for (const mesh of emptyMeshes) mesh.count = 0;
      for (const geometry of emptyGeometry) geometry.instanceCount = 0;
      for (const geometry of emptyRanges) geometry.drawRange.count = 0;
    }
  }

  private prewarmHitFlash(): void {
    const roots = [...this.actorRoots.values()].map(instance => instance.root);
    this.hitFlash.prewarm(roots, () => this.prewarm(roots));
  }

  /** `renderer.compile` links programs but leaves textures on the CPU; an actor or prop entering view would upload them mid-frame. */
  private uploadTextures(): void {
    const textures = new Set<Texture>();
    const collect = (material: Material) => {
      for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
      const uniforms = (material as Material & { uniforms?: Record<string, { value: unknown }> }).uniforms;
      if (uniforms) for (const uniform of Object.values(uniforms)) if (uniform?.value instanceof Texture) textures.add(uniform.value);
    };
    this.scene.traverse(node => {
      const material = (node as Mesh).material as Material | Material[] | undefined;
      if (!material) return;
      if (Array.isArray(material)) for (const item of material) collect(item); else collect(material);
    });
    for (const texture of textures) {
      const image = texture.image as { complete?: boolean } | null | undefined;
      if (texture.isRenderTargetTexture || texture.version === 0 || !image || image.complete === false) continue;
      this.renderer.initTexture(texture);
    }
  }

  getNativeSolidColliders(): readonly RegionColliderDefinition[] { return this.sceneColliders; }
  getNativeSupportFields(): readonly SupportField[] { return this.sceneSupports; }

  async prepareCombatTrialGates(): Promise<void> {
    this.assertAlive();
    const trials = this.region ? combatTrialSetFor(this.region.id)?.trials : undefined;
    if (!trials) throw new Error('Combat trials require a region with an authored trial set.');
    const manifest = this.assetCatalog.get(TRIAL_GATE_ASSET_ID);
    if (!manifest) throw new Error('Combat trials require the native root gate asset.');
    const epoch = this.loadEpoch;
    const gates = await NativeTrialGates.load(this.scene, this.assetLoader, manifest, trials);
    if (this.disposed || epoch !== this.loadEpoch) { gates.dispose(); throw new Error('Trial gate load superseded.'); }
    this.trialGates?.dispose(); this.trialGates = gates; this.trialDefinitions = trials;
    for (const stage of trials) if (!this.actorRoots.get(stage.monsterId)) throw new Error('Missing native trial monster ' + stage.monsterId);
    this.gateOpenings.length = 0;
    this.prewarmHitFlash();
  }

  async prepareWaystone(position: Readonly<Vec3>, pillarPosition: Readonly<Vec3>): Promise<void> {
    this.assertAlive();
    const manifest = this.assetCatalog.get(WAYSTONE_ASSET_ID);
    if (!manifest || !this.region) throw new Error('Playtest requires the native Warden waystone.');
    const epoch = this.loadEpoch;
    const waystone = await WaystoneVisual.load(this.scene, this.assetLoader, manifest, position, pillarPosition, this.region.id);
    if (this.disposed || epoch !== this.loadEpoch) { waystone.dispose(); throw new Error('Waystone load superseded.'); }
    this.waystone?.dispose();
    this.waystone = waystone;
    this.prewarm([waystone.group]);
  }

  updateWaystone(dt: number, open: boolean): void { this.waystone?.update(dt, open, this.reducedMotion); }
  beginWaystoneArrival(): void { this.waystone?.beginArrival(); }

  /**
   * Ground points of trial gates that started opening since the previous call (presentation burst
   * trigger). The array is reused; copy anything that must outlive the frame.
   */
  drainGateOpenings(): readonly Vec3[] {
    this.drainedGateOpenings.length = 0;
    for (const position of this.gateOpenings) this.drainedGateOpenings.push(position);
    this.gateOpenings.length = 0;
    return this.drainedGateOpenings;
  }

  /** Horizontal metres from Aren to the nearest still-closed trial gate (Infinity without trials). */
  get closestClosedGateDistance(): number { return this.trialGates?.closestClosedGateDistance ?? Infinity; }

  /** Queues a ground-level burst point at each opening gate's floor centre (the burst also shakes the camera). */
  private collectGateOpenings(gates: NativeTrialGates): void {
    for (const event of gates.openingEvents()) {
      const gate = this.trialDefinitions.find(stage => stage.gate.id === event.gateId)?.gate;
      const floor = gate?.halfExtents ? gate.from.y - gate.halfExtents.y + 0.5 : event.position.y;
      this.gateOpenings.push({ x: event.position.x, y: floor, z: event.position.z });
    }
  }

  /** Native outcome poses advance visually while gameplay remains paused. */
  startPlayerOutcome(outcome: 'victory' | 'defeat'): void {
    const instance = this.displayedInstance('aren');
    if (!instance) throw new Error('A native player instance is required for outcome playback.');
    const actionId = (outcome === 'victory' ? 'aren-cheer' : 'aren-defeat') as ActionId;
    this.afterimages?.clear();
    this.obstacleVisuals.clear();
    this.hitFlash.clear();
    this.cameraDirector.clearShake();
    instance.animation.play(actionId, 'active', 0);
    this.playerOutcome = { instance, actionId, elapsed: 0, baseScale: instance.root.scale.x };
  }

  updatePlayerOutcome(elapsedSeconds: number): void {
    const outcome = this.playerOutcome;
    if (!outcome || this.disposed) return;
    const elapsed = Math.max(outcome.elapsed, elapsedSeconds);
    const dt = Math.min(0.1, elapsed - outcome.elapsed);
    const duration = outcome.instance.animation.activeDuration ?? 0;
    outcome.instance.animation.play(outcome.actionId, 'active', duration > 0 ? elapsed / duration : 1);
    outcome.instance.animation.update(dt);
    if (outcome.actionId === 'aren-cheer') {
      const progress = Math.max(0, Math.min(1, (elapsed - 0.65) / 0.5));
      if (!this.reducedMotion) outcome.instance.root.scale.setScalar(outcome.baseScale * (1 - progress * progress * (3 - 2 * progress)));
      outcome.instance.root.visible = elapsed < 1.15;
    }
    outcome.elapsed = elapsed;
  }

  getInputBasis(): { forward: Vector3; right: Vector3 } {
    return { forward: this.cameraDirector.forward, right: this.cameraDirector.right };
  }

  get cameraPosition(): readonly [number, number, number] { return this.cameraDirector.cameraPosition; }
  syncWorldFacts(facts: Readonly<Record<string, boolean>>): void {
    this.assertAlive();
    this.worldFacts = facts;
    this.environment?.syncWorldFacts(facts);
    this.applyMovableWorldFacts();
    this.applyPlacementVisibility();
    if (this.actorSnapshots.size) this.syncActors([...this.actorSnapshots.values()]);
  }
  /** Named manifest socket; `root` falls back to the actor's render root when no socket is authored. */
  resolveSocket(actorId: string, socketName: string): Object3D | undefined {
    const instance = this.displayedInstance(actorId);
    const weapon = this.orunWeapon?.carrier === instance?.root ? this.orunWeapon : this.wardenWeapon;
    const weaponSocket = instance && weapon?.carrier === instance.root ? weapon.sockets[socketName as WardenSocketName] : undefined;
    return weaponSocket ?? instance?.sockets[socketName] ?? (instance ? this.bodySocket(instance, socketName) : undefined) ?? (socketName === 'root' ? instance?.root : undefined);
  }

  /** Hero body sockets and authored enemy anatomy are cached per actual instance, including variant swaps. */
  private bodySocket(instance: NativeAssetInstance, socketName: string): Object3D | undefined {
    let cache = this.bodySockets.get(instance);
    if (!cache) { cache = new Map(); this.bodySockets.set(instance, cache); }
    let bone = cache.get(socketName);
    if (bone === undefined) {
      let boneName = BODY_SOCKET_BONES[socketName];
      if (!boneName && socketName.startsWith('enemy:')) {
        const divider = socketName.lastIndexOf(':');
        const pair = ENEMY_NATIVE_ANCHORS[instance.assetId]?.[socketName.slice(6, divider)];
        boneName = pair?.[socketName.slice(divider + 1) as 'base' | 'tip'];
      }
      if (!boneName) { cache.set(socketName, null); return undefined; }
      bone = instance.root.getObjectByName(PropertyBinding.sanitizeNodeName(boneName)) ?? instance.root.getObjectByName(boneName) ?? null;
      cache.set(socketName, bone);
    }
    return bone ?? undefined;
  }
  addWorldModule(group: Object3D): () => void { this.assertAlive(); this.scene.add(group); return () => group.removeFromParent(); }

  /** Missing-clip issues recorded by the animation controllers of every loaded actor instance (`assetId:actionId`); a candidate with a missing clip is reported here instead of silently holding a pose. */
  private collectAnimationIssues(): string[] {
    const issues: string[] = [];
    const collect = (instance: NativeAssetInstance) => { for (const issue of instance.animation.issues) issues.push(issue.assetId + ':' + issue.actionId); };
    for (const instance of this.actorRoots.values()) collect(instance);
    for (const variants of this.actorVariants.values()) for (const instance of variants.values()) collect(instance);
    return issues;
  }

  capture(): RendererDebugSnapshot {
    return {
      regionId: this.region?.id ?? null, loading: this.loading, assetErrors: [...this.assetErrors], lodWarnings: [...this.lodWarnings], missingActorAssets: [...this.missingActorAssets],
      loadedAssetIds: [...new Set([...this.entityRoots.values()].map((instance) => instance.assetId))], actorCount: this.actorRoots.size,
      propCount: this.region?.props.length ?? 0, surfaceCount: this.region?.ground.surfaces.length ?? 0, colliderCount: this.region?.ground.colliders.length ?? 0,
      lodMeasurements: [...this.staticLods].map((lod) => lod.debugState), camera: this.cameraDirector.debugState,
      animationIssues: this.collectAnimationIssues(), loadedVariantAssetIds: [...this.actorVariants.values()].flatMap((variants) => [...variants.keys()]),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver.disconnect();
    this.afterimages?.dispose();
    this.afterimages = null;
    if (this.unarmedFists) { releaseHandGeometry(this.unarmedFists); this.unarmedFists = null; }
    this.wardenWeapon?.dispose();
    this.wardenWeapon = null;
    this.orunWeapon?.dispose();
    this.orunWeapon = null;
    this.hitFlash.dispose();
    this.obstacleVisuals.dispose();
    this.propResponses.dispose();
    this.orunPresentation.dispose();
    this.trialGates?.dispose(); this.trialGates = null;
    this.waystone?.dispose(); this.waystone = null;
    this.playerOutcome = null;
    this.nativeSolidEntries.length = 0;
    this.sceneColliders.length = 0;
    this.sceneSupports.length = 0;
    for (const instance of new Set(this.entityRoots.values())) instance.dispose();
    for (const variants of this.actorVariants.values()) for (const instance of variants.values()) instance.dispose();
    for (const lod of this.staticLods) lod.dispose();
    this.actorVariants.clear();
    this.variantLoads.clear();
    this.storyFacts.clear();
    this.actorRoots.clear();
    this.entityRoots.clear();
    this.movableProps.clear();
    this.migrationGates.clear();
    this.actorManifests.clear();
    this.actorSnapshots.clear();
    this.staticLods.clear();
    this.contactShadows?.dispose();
    this.contactShadows = null;
    this.groundArena = undefined;
    this.environment?.dispose();
    this.world.clear();
    if (this.ownedLoader) this.assetLoader.dispose();
    this.postFx.dispose();
    this.renderer.dispose();
  }

  private syncMovableObjects(snapshots: readonly MovableObjectSnapshot[]): void {
    if (!this.region) return;
    for (const snapshot of snapshots) {
      const movable = this.movableProps.get(snapshot.objectId);
      if (!movable) throw new Error('Combat snapshot movable object ' + snapshot.objectId + ' has no loaded prop instance in region ' + (this.region?.id ?? '<none>') + '.');
      if (snapshot.phase === 'resting') {
        movable.awaitingCommit = false;
        const position = this.worldFacts[movable.definition.movedFactId] === true ? movable.definition.to : movable.definition.from;
        movable.root.position.set(position.x, position.y, position.z);
        movable.root.rotation.y = movable.placementRotationY;
      } else {
        movable.root.position.set(snapshot.position.x, snapshot.position.y, snapshot.position.z);
        movable.root.rotation.y = snapshot.rotationY ?? movable.placementRotationY;
        movable.awaitingCommit = snapshot.phase === 'settled' && this.worldFacts[movable.definition.movedFactId] !== true;
      }
      movable.root.visible = !movable.awaitingCommit && (!movable.visibleWhen || this.worldFacts[movable.visibleWhen] === true);
    }
  }

  private applyMovableWorldFacts(): void {
    for (const movable of this.movableProps.values()) {
      const moved = this.worldFacts[movable.definition.movedFactId] === true;
      if (moved) movable.awaitingCommit = false;
      if (!movable.awaitingCommit) {
        const position = moved ? movable.definition.to : movable.definition.from;
        movable.root.position.set(position.x, position.y, position.z);
        movable.root.rotation.y = movable.placementRotationY;
      }
      movable.root.visible = !movable.awaitingCommit && (!movable.visibleWhen || this.worldFacts[movable.visibleWhen] === true);
    }
  }

  private applyPlacementVisibility(): void {
    if (!this.region) return;
    for (const placement of this.region.props) {
      const visible = !placement.visibleWhen || this.worldFacts[placement.visibleWhen] === true;
      for (const batch of this.placementBatches.get(placement.id) ?? []) batch.setPlacementVisible(placement.id, visible);
      const movable = this.movableProps.get(placement.id);
      if (movable) movable.root.visible = !movable.awaitingCommit && visible;
      const gate = this.migrationGates.get(placement.id);
      if (gate) { gate.root.visible = visible; gate.syncWorldFacts(this.worldFacts); }
    }
    this.sceneColliders.length = 0;
    this.sceneSupports.length = 0;
    for (const entry of this.nativeSolidEntries) {
      if (entry.visibleWhen && this.worldFacts[entry.visibleWhen] !== true) continue;
      if (this.propResponses.brokenFoliageIds.has(entry.placementId)) continue;
      this.sceneColliders.push(entry.collider);
      if (entry.support && !this.sceneSupports.includes(entry.support)) this.sceneSupports.push(entry.support);
    }
    for (const gate of this.migrationGates.values()) {
      if (gate.root.visible) for (const entry of gate.solids) this.sceneColliders.push(entry.collider);
    }
    if (this.groundArena) this.groundArena.supports = this.sceneSupports.slice();
  }

  private syncActors(actors: readonly ActorSnapshot[], previous?: CombatSnapshot, alpha = 1, dt = 0): void {
    this.actorSnapshots.clear();
    this.missingActorAssets.clear();
    this.storyCalm = true;
    for (const actor of actors) if (actor.allegiance === 'hostile' && actor.visible && !actor.downed && (actor.vitality === undefined || actor.vitality > 0)) { this.storyCalm = false; break; }
    for (const actor of actors) {
      this.actorSnapshots.set(actor.id, actor);
      const base = this.actorRoots.get(actor.id);
      const prior = previous?.actors.find((candidate) => candidate.id === actor.id && candidate.archetypeId === actor.archetypeId);
      const baseManifest = this.actorManifests.get(actor.id);
      const variants = this.actorVariants.get(actor.id);
      const displayed = base ? resolveDisplayedAsset(actor, baseManifest, variants, this.displayedScratch) : undefined;
      if (!base || !displayed) {
        if (base) base.root.visible = false;
        let expectedAssetId: string | undefined;
        for (const manifest of this.assetCatalog.values()) {
          if (manifest.kind === 'character' && manifest.actorId === actor.archetypeId && !manifest.variantOf) { expectedAssetId = manifest.id; break; }
        }
        this.missingActorAssets.add(expectedAssetId ?? String(actor.archetypeId));
        continue;
      }
      if (displayed.kind === 'missing') { base.root.visible = false; this.missingActorAssets.add(displayed.assetId); continue; }
      this.noteDisplayedAsset(actor.id, displayed.assetId);
      const variantId = displayed.kind === 'variant' ? displayed.assetId : undefined;
      if (variants) for (const [assetId, instance] of variants) instance.root.visible = assetId === variantId && actor.visible;
      if (!variantId) { base.root.visible = actor.visible; this.applyActorSnapshot(base, actor, prior, alpha, dt); continue; }
      base.root.visible = false;
      const variant = variants!.get(variantId)!;
      variant.root.visible = actor.visible;
      this.applyActorSnapshot(variant, actor, prior, alpha, dt);
    }
  }

  /** Renderer facts one story actor needs (boss phase, calm, line gesture, swap entrance); null for every other actor. Rewritten in place, never allocated per frame. */
  private storyInputFor(actor: ActorSnapshot): StoryAnimationInput | undefined {
    const facts = this.storyFacts.get(actor.id);
    if (!facts) return undefined;
    const boss = this.currentCombat?.boss;
    facts.input.bossPhaseIndex = boss !== undefined && (boss.actorId === actor.id || boss.actorId === actor.archetypeId) ? boss.phaseIndex : -1;
    facts.input.calm = this.storyCalm;
    return facts.input;
  }

  /** Records which asset an actor is drawn with; a change of a story actor's asset inside one region (Koro's cleanse swap) starts its entrance on the world clock. */
  private noteDisplayedAsset(actorId: string, assetId: string): void {
    if (!BAMBOO_STORY_ASSETS[assetId]) return;
    let facts = this.storyFacts.get(actorId);
    if (!facts) { facts = { input: createStoryAnimationInput(), displayedAssetId: undefined }; this.storyFacts.set(actorId, facts); }
    if (facts.displayedAssetId !== undefined && facts.displayedAssetId !== assetId) facts.input.entranceStartedAt = this.renderWorldTimeSeconds;
    facts.displayedAssetId = assetId;
  }

  /**
   * Presentation-only line gesture of an NPC while it speaks (Marek's talking idles); `undefined` ends it. Called by the application when a
   * dialogue line of that speaker starts or ends; never read by the simulation.
   */
  setNpcTalk(actorId: string, talk: NpcTalk | undefined): void {
    this.assertAlive();
    const facts = this.storyFacts.get(actorId);
    if (!facts) { if (talk !== undefined) throw new Error(`Actor ${actorId} is not a story actor with a talking idle in the current region.`); return; }
    facts.input.talk = talk ?? null;
    facts.input.talkSerial += 1;
  }


  private applyActorSnapshot(instance: NativeAssetInstance, actor: ActorSnapshot, previous?: ActorSnapshot, alpha = 1, dt = 0): void {
    const visibleWhen = this.actorVisibilityConditions.get(actor.id);
    instance.root.visible = actor.visible && (!visibleWhen || this.worldFacts[visibleWhen] === true);
    const vanish = this.dodgeVanish;
    const dodgeBlink = vanish !== null && instance.assetId === vanish.assetId
      && (actor.actionId.includes('dive-roll') || actor.actionId.includes('perfect-dodge'))
      && actor.normalizedTime > vanish.from && actor.normalizedTime < vanish.to;
    if (dodgeBlink) instance.root.visible = false;
    const position = actor.position;
    const prior = previous?.position;
    // Finite enemy poses and contact cues use the current authoritative tick: a delayed root/yaw would detach the posed strike from its hazard.
    const interpolate = previous && prior && previous.visible === actor.visible && !actor.downed && !actor.attackPhase
      && Math.hypot(position.x - prior.x, position.y - prior.y, position.z - prior.z) < 4;
    if (interpolate) {
      instance.root.position.set(
        prior.x + (position.x - prior.x) * alpha,
        prior.y + (position.y - prior.y) * alpha,
        prior.z + (position.z - prior.z) * alpha,
      );
    } else instance.root.position.set(position.x, position.y, position.z);
    // Drawn height: the simulation snaps up and down stairs and ledges (up to 0.45 m in one tick); the drawn root absorbs the pop and settles. Feet and shadow keep reading the real ground.
    const motion = this.motionFor(instance);
    const hovering = MONSTER_HOVER[instance.assetId] !== undefined;
    const onGround = !actor.downed && actor.jumpPhase === undefined && !OFF_GROUND_ACTION.test(actor.actionId) && !enemyAttackAirborne(actor);
    instance.root.position.y = settleDrawnHeight(motion, instance.root.position.y, dt, onGround && !hovering, Boolean(interpolate));
    if (actor.allegiance !== 'player') {
      const hoverTarget = monsterHoverHeight(actor, instance.assetId, this.renderWorldTimeSeconds);
      if (hoverTarget !== 0 || this.monsterHover.has(instance)) {
        const hover = settleMonsterHover(this.monsterHover.get(instance), hoverTarget, actor, this.renderWorldDeltaSeconds);
        this.monsterHover.set(instance, hover);
        instance.root.position.y += hover;
      }
    }
    const yaw = Math.atan2(actor.facing.x, actor.facing.z);
    const turn = Math.atan2(Math.sin(yaw - instance.root.rotation.y), Math.cos(yaw - instance.root.rotation.y));
    const priorYaw = previous ? Math.atan2(previous.facing.x, previous.facing.z) : yaw;
    const steered = Math.atan2(Math.sin(yaw - priorYaw), Math.cos(yaw - priorYaw));
    if (actor.actionId === SPIN_ACTION_ID && interpolate && previous) {
      // The simulation turns the facing 30° per tick through the spin; smoothing would trail the blade by a quarter turn, so follow the snapshots exactly.
      instance.root.rotation.y = priorYaw + steered * alpha;
    } else if (actor.allegiance === 'player' && dt > 0 && interpolate && previous && Math.abs(steered) <= STEERED_TURN_MAX) {
      // The player's steering heading is turn-rate limited in the simulation (at most ~0.27 rad per tick): follow its snapshots exactly rather than lagging behind them.
      instance.root.rotation.y = priorYaw + steered * alpha;
    } else instance.root.rotation.y = dt > 0 && interpolate
      ? instance.root.rotation.y + turn * (1 - Math.exp(-20 * dt)) : yaw;
    const extras = this.extrasFor(instance, actor.id);
    const rig = this.rigFor(instance);
    const root = instance.root, bodyHeight = this.actorBodies.get(root).height;
    const monsterBody = actor.allegiance !== 'player' && MONSTER_LOCOMOTION[instance.assetId] !== undefined;
    const detail = this.animationDetail(instance, actor, extras, bodyHeight);
    // Combat reaction (flinch, stagger, knockback, knockdown, launch, stun, get-up): the pose it asks of the clip and the body.
    const reaction = actor.reaction;
    let progress = reaction?.progress ?? 0;
    if (reaction && interpolate && previous?.reaction?.serial === reaction.serial && previous.reaction.progress <= progress) {
      progress = previous.reaction.progress + (progress - previous.reaction.progress) * alpha;
    }
    const context = this.reactionContext, animation = instance.animation;
    context.body = monsterBody ? 'monster' : 'hero';
    context.clockSeconds = this.renderWorldTimeSeconds; context.bodyHeight = bodyHeight; context.phase = extras.phase; context.progress = progress;
    context.motionScale = this.reducedMotion ? 0.5 : 1;
    context.hasHit = animation.hasAction(monsterBody ? 'monster-hurt' : 'aren-hit');
    const clips = REACTION_CLIPS[context.body];
    context.hasKnockdown = animation.hasAction(clips.knockdown) && animation.hasAction(clips.getup);
    context.hasKnockdownForward = animation.hasAction(clips.knockdownForward) && animation.hasAction(clips.getupForward);
    context.attacking = monsterBody ? actor.attackPhase !== undefined : !LOCOMOTION_ACTION.test(actor.actionId);
    const pose = extras.reaction.update(reaction, context, dt);
    const reacting = extras.reaction.active;
    const leaning = actor.allegiance === 'player' || actor.allegiance === 'ally';
    if (leaning) updateLean(motion, actor.velocity.x, actor.velocity.z, root.rotation.y, dt, !this.reducedMotion && onGround && !hovering && !reacting && Boolean(interpolate));
    // Creatures follow the slope they stand on (pitch and roll of the plane through the ground under their extents).
    const slope = extras.slope;
    if (rig.creature && !hovering) {
      const footprint = this.footprintOf(instance);
      if (footprint) slopeTarget(this.groundHeight, root.position.x, root.position.z, root.position.y, Math.sin(root.rotation.y), Math.cos(root.rotation.y), Math.max(0.35, footprint.rz * 0.8), Math.max(0.25, footprint.rx * 0.7), this.slopeGoal);
      else { this.slopeGoal.pitch = 0; this.slopeGoal.roll = 0; }
      settleSlopeAttitude(slope, this.slopeGoal, dt, onGround && !reacting && Boolean(interpolate) && !this.reducedMotion);
    }
    let pitch = (leaning ? motion.pitch : 0) + slope.pitch, roll = (leaning ? motion.roll : 0) + slope.roll;
    if (reacting) {
      // The top of the body tilts along the push; a lying body is shifted back over its footprint and rests on the ground, not in it.
      localReactionDirection(pose.dirX, pose.dirZ, root.rotation.y, this.localHit);
      pitch += pose.tilt * this.localHit.forward; roll += pose.tilt * this.localHit.right;
      root.position.x -= pose.dirX * pose.shift; root.position.z -= pose.dirZ * pose.shift;
      root.position.y += pose.lift + Math.max(0, Math.sin(pose.tilt)) * bodyHeight * 0.085;
    }
    root.rotation.x = pitch; root.rotation.z = roll;
    const standing = pose.kind !== 'knockdown' && pose.kind !== 'launch' && pose.kind !== 'getup';
    if (rig.foot) { rig.foot.grounded = onGround && standing; rig.foot.footLock = !monsterBody && onGround && !reacting && LOCOMOTION_ACTION.test(actor.actionId) && !this.reducedMotion; }
    if (rig.quad) rig.quad.grounded = onGround && !hovering && standing;
    const inputs = rig.procedural?.inputs;
    if (inputs) {
      inputs.detail = this.reducedMotion && detail === 'full' ? 'reaction' : detail;
      inputs.reaction = reacting ? pose : undefined;
      const gaze = !this.reducedMotion && !reacting && actor.visible && !actor.downed && (monsterBody
        ? actor.attackPhase === undefined && actor.roarProgress === undefined && !actor.weakPointExposed && (actor.vitality === undefined || actor.vitality > 0)
        : LOCOMOTION_ACTION.test(actor.actionId));
      inputs.lookEnabled = gaze && detail === 'full';
      inputs.hasTarget = inputs.lookEnabled && this.selectLookTarget(actor, this.lookTarget);
      if (inputs.hasTarget) { inputs.targetX = this.lookTarget.x; inputs.targetY = this.lookTarget.y; inputs.targetZ = this.lookTarget.z; }
    }
    if (extras.lodSkip) return;
    const loopTimeSeconds = this.currentCombat
      ? actor.allegiance === 'player' ? this.renderSimulationTick / 60 : this.renderWorldTimeSeconds
      : undefined;
    const hop = driveActorAnimation(instance, actor, previous, {
      interpolate: Boolean(interpolate), alpha, loopTimeSeconds, manifest: this.assetCatalog.get(instance.assetId),
      vitality: actor.allegiance === 'player' ? this.currentCombat?.player.vitality : undefined,
      walkSpeed: actor.allegiance === 'player' ? this.playerWalkSpeed : undefined,
      runSpeed: actor.allegiance === 'player' ? this.playerRunSpeed : undefined,
      trialMonster: this.trialMonsterRole(actor),
      reaction: reacting ? pose : undefined,
      story: this.storyInputFor(actor),
    });
    // Only a defeated flyer's held fall offset remains outside native skeletal motion.
    if (hop !== 0) root.position.y += hop;
  }

  /** Presentation state of an instance besides height and lean, created on first use. */
  private extrasFor(instance: NativeAssetInstance, actorId: string): ActorExtras {
    let extras = this.actorExtras.get(instance);
    if (!extras) {
      let hash = 2166136261;
      for (let i = 0; i < actorId.length; i += 1) hash = Math.imul(hash ^ actorId.charCodeAt(i), 16777619);
      extras = { reaction: new ReactionPresenter(), slope: createSlopeAttitude(), phase: (hash >>> 0) / 4294967296, lastDriven: -1, pendingDt: 0, lodSkip: false };
      this.actorExtras.set(instance, extras);
    }
    return extras;
  }

  private footprintOf(instance: NativeAssetInstance): ContactFootprint | null {
    let footprint = this.footprints.get(instance);
    if (footprint === undefined) { footprint = measureFootprint(instance.root); this.footprints.set(instance, footprint); }
    return footprint;
  }

  /**
   * Animation LOD: how much of the procedural layer an actor runs and whether its clip is re-evaluated this frame. Attacks always update, including
   * off-screen bodies whose sockets feed presentation. Other critical actors update while visible; idle actors update every frame within LOD_NEAR,
   * every 2nd within LOD_FAR, every 4th beyond and every 6th off-screen (their last pose is held; owed time is replayed on the next update).
   */
  private animationDetail(instance: NativeAssetInstance, actor: ActorSnapshot, extras: ActorExtras, bodyHeight: number): ProceduralDetail {
    const root = instance.root, camera = this.camera.position;
    const sphere = this.lodSphere;
    sphere.center.set(root.position.x, root.position.y + bodyHeight * 0.5, root.position.z);
    sphere.radius = bodyHeight + 2.5;
    const visible = this.lodFrustum.intersectsSphere(sphere);
    const distance = Math.hypot(root.position.x - camera.x, root.position.y - camera.y, root.position.z - camera.z);
    // A ceremony in progress (cleanse, reunion, a cub in danger) always updates: its one-shot clips start on the frame the status begins.
    const critical = actor.allegiance === 'player' || actor.reaction !== undefined || actor.attackPhase !== undefined || actor.chapterStatus === 'cleansed' || actor.chapterStatus === 'reunion' || actor.chapterStatus === 'in-danger' || actor.job !== undefined;
    const stride = actor.attackPhase !== undefined ? LOD_STRIDE.near : visible ? critical || distance < LOD_NEAR ? LOD_STRIDE.near : distance < LOD_FAR ? LOD_STRIDE.mid : LOD_STRIDE.far : LOD_STRIDE.offscreen;
    const due = extras.lastDriven < 0 || this.presentationFrame - extras.lastDriven >= stride;
    extras.lodSkip = !due;
    if (due) { extras.lastDriven = this.presentationFrame; this.animationLod.updated += 1; } else this.animationLod.skipped += 1;
    return !visible ? 'off' : critical || distance < LOD_NEAR ? 'full' : distance < LOD_FAR ? 'reaction' : 'off';
  }

  /** Nearest valid gaze target of an actor, written to `out`: a hero or companion looks at the nearest hostile in range, a monster at the hero. */
  private selectLookTarget(actor: ActorSnapshot, out: Vector3): boolean {
    const friendly = actor.allegiance === 'player' || actor.allegiance === 'ally';
    let best = LOOK_RANGE * LOOK_RANGE, found = false;
    for (const other of this.syncedActors) {
      if (other === actor || !other.visible || other.downed || (other.vitality !== undefined && other.vitality <= 0)) continue;
      if (friendly ? other.allegiance !== 'hostile' : other.allegiance !== 'player') continue;
      const dx = other.position.x - actor.position.x, dz = other.position.z - actor.position.z, distanceSq = dx * dx + dz * dz;
      if (distanceSq >= best) continue;
      best = distanceSq; found = true;
      out.set(other.position.x, (this.displayedInstance(other.id)?.root.position.y ?? other.position.y) + (friendly ? 1.0 : 1.45), other.position.z);
    }
    return found;
  }

  private resize(): void {
    if (this.disposed) return;
    const width = Math.max(1, this.renderer.domElement.clientWidth);
    const height = Math.max(1, this.renderer.domElement.clientHeight);
    this.renderer.setSize(width, height, false);
    this.postFx.setSize(width, height, window.devicePixelRatio || 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private assertAlive(): void { if (this.disposed) throw new Error('Renderer has been disposed.'); }
}

/** Every mesh of a displayed character casts and receives the sun shadow; the one place instances are flagged, so a loaded variant can never miss it. */
function castShadows(root: Object3D): void {
  root.traverse((node) => { if (node instanceof Mesh) { node.castShadow = true; node.receiveShadow = true; } });
}

function estimateAssetHeight(batch: NativeStaticBatch, manifest: AssetManifestEntry, placements: readonly WorldAssetPlacement[]): number {
  let radius = 0;
  batch.root.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.geometry) return;
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
    const boundingRadius = mesh.geometry.boundingSphere?.radius ?? 1;
    if (boundingRadius > radius) radius = boundingRadius;
  });
  let maxScale = 1;
  for (const placement of placements) maxScale = Math.max(maxScale, placement.scale.x, placement.scale.y, placement.scale.z);
  return Math.max(0.1, radius * 2 * maxScale * (manifest.coordinateTransform?.scale ?? 1));
}

export async function mountCompanionPreview(host: HTMLElement, companionId: string, assets: readonly AssetManifestEntry[], options: CompanionPreviewOptions): Promise<CompanionPreviewHandle> {
  const manifest = assets.find((entry) => entry.id === 'actor-' + companionId && entry.kind === 'character');
  if (!manifest) throw new Error('No exact character manifest entry exists for companion ' + companionId + '.');
  if (manifest.sourceType !== 'native-glb' || !manifest.runtimeUrl) throw new Error('Companion ' + companionId + ' is unavailable: native GLB runtime asset is not ready.');
  const idleActionId = String(options.idleActionId);
  const candidateAction = options.allowCandidateActions === true && manifest.evidenceStatus === 'blocked'
    && (!!manifest.actionToClipMapping[idleActionId] || manifest.playtestAnimation?.actionIds.some(actionId => String(actionId) === idleActionId));
  if (!candidateAction && (!manifest.requiredActionIds.some((actionId) => String(actionId) === idleActionId) || !manifest.actionToClipMapping[idleActionId])) throw new Error('Companion ' + companionId + ' has no explicitly required native idle action ' + idleActionId + '.');
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', companionId + ' 3D companion preview');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  const caption = host.querySelector('.wc-preview-caption');
  host.replaceChildren(canvas, ...(caption ? [caption] : []));
  let renderer: WebGLRenderer;
  try { renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true }); }
  catch (error) { canvas.remove(); throw error; }
  const scene = new Scene();
  scene.background = null;
  scene.add(new HemisphereLight(0xe4ecf0, 0x53463a, 0.75));
  const keyLight = new DirectionalLight(0xffdfbc, 2.1);
  const fillLight = new DirectionalLight(0xb8d0e5, 0.7);
  scene.add(keyLight, fillLight);
  const camera = new PerspectiveCamera(34, 1, 0.1, 100);
  const previewCenter = new Vector3();
  const viewDirection = new Vector3(0.55, 0.35, 1).normalize();
  let previewRadius = 0;
  const ownsLoader = !options.loader;
  const assetLoader = options.loader ?? new NativeAssetLoader({ allowMissingActionClips: options.allowCandidateActions === true });
  let instance: NativeAssetInstance;
  try { instance = await assetLoader.load(manifest); }
  catch (error) { renderer.dispose(); canvas.remove(); if (ownsLoader) assetLoader.dispose(); throw error; }
  if (!canvas.isConnected || !host.contains(canvas)) {
    instance.dispose();
    scene.clear();
    renderer.dispose();
    if (ownsLoader) assetLoader.dispose();
    canvas.remove();
    throw new Error('Companion preview host detached before its native asset load completed.');
  }
  try {
    if (!instance.animation.hasAction(options.idleActionId)) throw new Error('Companion ' + companionId + ' has no loaded native idle action ' + idleActionId + '.');
    instance.root.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(instance.root);
    if (bounds.isEmpty()) throw new Error('Native companion asset has no renderable bounds.');
    previewCenter.copy(bounds.getCenter(new Vector3()));
    const size = bounds.getSize(new Vector3());
    previewRadius = Math.max(Math.hypot(size.x, size.y, size.z) * 0.5, 0.05);
    scene.add(instance.root);
    instance.animation.playPreview(options.idleActionId);
  } catch (error) {
    instance.dispose();
    scene.clear();
    renderer.dispose();
    if (ownsLoader) assetLoader.dispose();
    canvas.remove();
    throw error;
  }
  let disposed = false;
  const effects = new StoryEffects({ scene, reducedEffects: options.reducedEffects, resolveActorRoot: id => id === companionId ? instance.root : undefined });
  let previewClock = 0, showcaseStart = 0, sequence = 0, skill: CompanionSkill | undefined;
  let released = false, contacted = false;
  const emit = (phase: CuePhase) => {
    if (!skill) return;
    const storm = skill.id === 'storm-talon';
    effects.emit({ instanceId: `preview:${sequence}:${phase}`, scopeId: `preview:${sequence}`, tick: previewClock * 60,
      worldTick: previewClock * 60, worldTimeSeconds: previewClock, actorId: companionId,
      kind: storm ? 'storm-talon' : 'command', phase: storm && phase === 'commit' ? 'active' : phase,
      actionId: skill.actionId as ActionId, from: { x: 0, y: .8, z: 0 }, to: { x: 1.5, y: .6, z: 0 },
      position: phase === 'anticipation' ? { x: 0, y: 0, z: 0 } : { x: 1.5, y: 0, z: 0 },
      durationTicks: Math.max(1, skill.ticks * (skill.contact - skill.release)), priority: 'essential', shape: 'burst' });
  };
  let observer: ResizeObserver | undefined;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    effects.dispose();
    instance.dispose();
    scene.clear();
    renderer.dispose();
    if (ownsLoader) assetLoader.dispose();
    canvas.remove();
  };
  const render = () => {
    if (disposed) return;
    if (!canvas.isConnected || !host.contains(canvas)) { dispose(); return; }
    const width = Math.max(1, host.clientWidth);
    const height = Math.max(1, host.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    const verticalHalfFov = camera.fov * Math.PI / 360;
    const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * camera.aspect);
    const limitingHalfFov = Math.max(0.01, Math.min(verticalHalfFov, horizontalHalfFov));
    const distance = previewRadius / Math.sin(limitingHalfFov) * 1.45;
    camera.position.copy(previewCenter).addScaledVector(viewDirection, distance);
    camera.near = Math.max(0.005, distance / 1000);
    camera.far = distance + previewRadius * 8;
    camera.lookAt(previewCenter);
    keyLight.position.set(previewCenter.x - previewRadius, previewCenter.y + previewRadius * 2.2, previewCenter.z + previewRadius * 1.5);
    fillLight.position.set(previewCenter.x + previewRadius * 1.2, previewCenter.y + previewRadius * 0.7, previewCenter.z - previewRadius);
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  };
  observer = new ResizeObserver(render);
  observer.observe(host);
  render();
  host.dataset.previewState = 'ready';
  return {
    get actionTime() { return instance.animation.activeTime; },
    showcase: id => {
      const next = ALL_COMPANION_SKILLS.find(candidate => candidate.id === id && candidate.companionId === companionId);
      if (!next) throw new Error('Unknown companion preview skill ' + id + '.');
      if (!instance.animation.hasAction(next.nativeAction as ActionId)) throw new Error('Missing native skill animation ' + next.nativeAction + '.');
      effects.cancelAll('load'); sequence++; skill = next; showcaseStart = previewClock; released = contacted = false;
      host.dataset.previewSkill = id; emit('anticipation');
    },
    update: (dt) => {
      if (disposed) return;
      if (!canvas.isConnected || !host.contains(canvas)) { dispose(); return; }
      const step = Math.max(0, Math.min(dt, .1));
      previewClock += step;
      if (skill) {
        const elapsed = (previewClock - showcaseStart) * 60;
        const progress = Math.min(1, elapsed / skill.ticks);
        let action = skill.nativeAction, sample = progress;
        if (skill.id === 'storm-talon') {
          if (elapsed < 24) { action = 'vara:takeoff'; sample = Math.min(1, elapsed / 18); }
          else if (elapsed < 45) { action = 'vara:dive'; sample = (elapsed - 24) / 21; }
          else if (elapsed < 63) { action = 'vara:strike'; sample = .44 + .5 * (elapsed - 45) / 18; }
          else { action = 'vara:fly'; sample = (elapsed - 63) / 36; }
        }
        instance.animation.play(action as ActionId, 'active', sample, previewClock, 1);
        if (!released && progress >= skill.release) { released = true; emit('commit'); }
        if (!contacted && progress >= skill.contact) { contacted = true; emit('hit'); }
        if (progress >= 1) { skill = undefined; instance.animation.playPreview(options.idleActionId); }
      } else instance.animation.update(step);
      effects.update({ simulationTick: previewClock * 60, worldTick: previewClock * 60, worldTimeSeconds: previewClock, timeScale: 1, policy: 'normal' }, camera.position);
      render();
    },
    dispose,
  };
}
