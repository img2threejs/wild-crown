import { AmbientLight, Box3, DirectionalLight, Group, HemisphereLight, Mesh, PerspectiveCamera, PropertyBinding, Scene, Vector3, WebGLRenderer, type Color, type Object3D } from 'three';
import type { ActionId, ActorSnapshot, AssetManifestEntry, CombatSnapshot, EnvironmentRecipeDefinition, MovableObjectSnapshot, RegionColliderDefinition, RegionDefinition, RegionMovableObjectDefinition, Vec3, WorldAssetPlacement } from '../game/contracts';
import type { CameraDebugState } from './CameraDirector';
import { CameraDirector } from './CameraDirector';
import { NativeAssetLoader, type AssetLoadProgress, type NativeAssetInstance, type NativeStaticBatch } from './NativeAssetLoader';
import { DEFAULT_SCREEN_SPACE_LOD_POLICY, ScreenSpaceLOD, type ScreenSpaceLODPolicy, type ScreenSpaceLODDebugState } from './ScreenSpaceLOD';
import { RegionEnvironment, setSceneAtmosphere } from '../world/RegionEnvironment';
import { PoseAfterimages } from './PoseAfterimages';
import { buildStaticPropColliders, type NativeSolidCollider } from './NativeSolidColliders';
import { CombatObstacleVisuals } from '../effects/CombatObstacleVisuals';
import { ActorHitFlash } from '../effects/vfx/HitFlash';
import { PostFX } from './PostFX';
import { NativeTrialGates } from './NativeTrialGates';
import { TRIAL_GATE_ASSET_ID, combatTrialSetFor, type CombatTrialDefinition } from '../game/combat/CombatTrials';
import { driveActorAnimation } from './ActorAnimationDriver';
import { monsterHoverHeight, settleMonsterHover } from './MonsterAnimationProfiles';
import { WARDEN_WEAPON_ASSET_ID, WardenWeapon, weaponKindForGrip, type WardenSocketName, type WardenWeaponKind } from './WardenWeapon';
import { fitUnarmedFists, releaseHandGeometry, type HandGeometryEdit } from './NativeHandGrip';
import { solidPropKind } from '../content/solid-props';
import { heroById, type HeroId } from '../game/heroes';
import { HERO_COMBAT } from '../game/combat/HeroProfiles';
import { WaystoneVisual, WAYSTONE_ASSET_ID } from './WaystoneVisual';

const STATIC_BATCH_CELL_SIZE = 16;
/** Light 3 (Warden Blade spin): the simulation rotates Aren's facing a full turn across the swing. */
const SPIN_ACTION_ID = 'aren-light-3';
const EMPTY_COMBAT_OBSTACLES = Object.freeze([]);
/** Body sockets every hero exposes (VFX trails on fists and feet): mixamorig hand and foot bones. */
const BODY_SOCKET_BONES: Readonly<Record<string, string>> = Object.freeze({
  'fist-left': 'mixamorig:LeftHand', 'fist-right': 'mixamorig:RightHand', 'foot-left': 'mixamorig:LeftFoot', 'foot-right': 'mixamorig:RightFoot',
});

interface DisposableAsset { readonly assetId: string; readonly root: Object3D; dispose(): void }
interface MovablePropInstance { readonly definition: RegionMovableObjectDefinition; readonly root: Group; readonly placementRotationY: number; readonly visibleWhen?: string; awaitingCommit: boolean }
export interface RendererDebugSnapshot {
  regionId: string | null; loading: boolean; assetErrors: readonly string[]; lodWarnings: readonly string[]; missingActorAssets: readonly string[];
  loadedAssetIds: readonly string[]; actorCount: number; propCount: number; surfaceCount: number; colliderCount: number;
  lodMeasurements: readonly ScreenSpaceLODDebugState[]; camera: CameraDebugState;
}
export interface GameRendererOptions { canvas: HTMLCanvasElement; assetLoader?: NativeAssetLoader; onProgress?: (progress: AssetLoadProgress) => void; pixelRatioCap?: number; lodPolicy?: ScreenSpaceLODPolicy; allowMissingActionClips?: boolean; simplifyBlockedPlaytestGeometry?: boolean }
export interface CompanionPreviewOptions { idleActionId: ActionId; loader?: NativeAssetLoader }
export interface CompanionPreviewHandle { readonly actionTime: number | undefined; update(dt: number): void; dispose(): void }
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
  private readonly actorVisibilityConditions = new Map<string, string>();
  private worldFacts: Readonly<Record<string, boolean>> = {};
  private readonly staticLods = new Set<ScreenSpaceLOD>();
  private readonly scratchTarget = new Vector3();
  private readonly ownedLoader: boolean;
  private readonly lodPolicy: ScreenSpaceLODPolicy;
  private readonly lodWarnings: string[] = [];
  private region: RegionDefinition | undefined;
  private environment: RegionEnvironment | undefined;
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
  private nativeSolidEntries: NativeSolidCollider[] = [];
  private readonly sceneColliders: RegionColliderDefinition[] = [];
  private reducedMotion = false;
  private playerOutcome: { instance: NativeAssetInstance; actionId: ActionId; elapsed: number; baseScale: number } | null = null;
  private trialGates: NativeTrialGates | null = null;
  private waystone: WaystoneVisual | null = null;
  private trialDefinitions: readonly CombatTrialDefinition[] = [];
  private readonly postFx: PostFX;
  private readonly hitFlash = new ActorHitFlash();
  private wardenWeapon: WardenWeapon | null = null;
  private unarmedFists: HandGeometryEdit | null = null;
  /** Variant asset whose body hides during dodge blinks (hero `dodgeVanish`), with the visible-fraction window of the dodge clip. */
  private dodgeVanish: { assetId: string; from: number; to: number } | null = null;
  /** Grounded walk speed of the chosen hero (m/s); the driver uses it to pick walk versus run when a dash tail blends into locomotion. */
  private playerWalkSpeed = HERO_COMBAT.aren.walkSpeed;
  private readonly bodySockets = new WeakMap<NativeAssetInstance, Map<string, Object3D | null>>();
  private readonly pixelRatioCap: number;
  private readonly gateOpenings: Vec3[] = [];
  private readonly drainedGateOpenings: Vec3[] = [];

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
    const stagedPlacementBatches = new Map<string, readonly NativeStaticBatch[]>();
    const stagedActorVisibility = new Map<string, string>();
    const stagedActorManifests = new Map<string, AssetManifestEntry>();
    const stagedLods = new Set<ScreenSpaceLOD>();
    const stagedSolids: NativeSolidCollider[] = [];
    let stagedAfterimages: PoseAfterimages | null = null;
    let stagedWeapon: WardenWeapon | null = null;
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

      const movableById = new Map<string, RegionMovableObjectDefinition>();
      const movablePlacements = new Map<string, WorldAssetPlacement>();
      for (const movable of region.movableObjects) {
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
      for (const authored of region.props) {
        if (movableById.has(authored.id)) continue;
        // Ground props follow the visual terrain relief (flat on and near the walk-mesh, so route colliders are unchanged).
        const lift = authored.placement === 'ground' ? nextEnvironment.visualGroundHeightAt(authored.position.x, authored.position.z) : 0;
        const placement = lift === 0 ? authored : { ...authored, position: { ...authored.position, y: authored.position.y + lift } };
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
      const authoredActorCount = region.entities.reduce((count, entity) => count + (entity.kind === 'actor' && Boolean(entity.actorId) ? 1 : 0), 0);
      const totalOperations = placementGroups.size
        + eligibleLodAttempts
        + region.movableObjects.length
        + authoredActorCount
        + (requiresArenFallback ? 1 : 0)
        + (weaponManifest && (authoredArenCount > 0 || requiresArenFallback) ? 1 : 0);
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
      for (const placements of placementGroups.values()) {
        const assetId = placements[0]!.assetId;
        const manifest = byId.get(assetId);
        if (!manifest) throw new Error(`Region ${region.id} placement ${placements[0]!.id} references missing manifest asset '${assetId}'.`);
        if (manifest.kind !== 'prop' || manifest.sourceType !== 'native-glb') throw new Error(`Prop placement ${placements[0]!.id} requires exact native-glb prop '${assetId}'.`);
        const baseBatch = await this.assetLoader.loadStaticBatch(manifest, placements);
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
            const lodBatch = await this.assetLoader.loadStaticBatch(lodManifest, placements);
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
      for (const definition of region.movableObjects) {
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
        const manifestId = entity.assetId;
        if (!manifestId) throw new Error('Actor instance ' + entity.id + ' has no explicit native character assetId.');
        const manifest = byId.get(manifestId);
        if (!manifest || manifest.id !== manifestId || manifest.actorId !== entity.actorId) throw new Error('Region ' + region.id + ' actor instance ' + entity.id + ' does not map to a manifest for canonical actor ' + entity.actorId + '.');
        if (manifest.kind !== 'character' || manifest.sourceType !== 'native-glb') throw new Error('Actor ' + entity.actorId + ' requires exact native-glb character asset ' + manifestId + '.');
        const loaded = await this.assetLoader.load(manifest);
        if (this.disposed || loadEpoch !== this.loadEpoch) { loaded.dispose(); throw new Error('Region load was superseded.'); }
        completeOperation();
        loaded.root.position.set(entity.position.x, entity.position.y, entity.position.z);
        loaded.root.userData.regionEntityId = entity.id;
        loaded.root.userData.actorInstanceId = entity.id;
        loaded.root.userData.assetId = manifest.id;
        loaded.root.userData.actorId = entity.actorId;
        loaded.root.traverse((node) => { if (node instanceof Mesh) { node.castShadow = true; node.receiveShadow = true; } });
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
          player.root.traverse((node) => { if (node instanceof Mesh) { node.castShadow = true; node.receiveShadow = true; } });
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
      // The weapon hangs on the hand before the afterimages clone Aren, so every ghost carries it too.
      if (stagedPlayer) { stagedAfterimages = new PoseAfterimages(this.scene, stagedPlayer.root); stagedAfterimages.setStyle('warden'); }
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
      this.trialGates?.dispose(); this.trialGates = null; this.gateOpenings.length = 0;
      this.waystone?.dispose(); this.waystone = null;
      this.afterimages = stagedAfterimages;
      stagedAfterimages = null;
      this.playerOutcome = null;
      this.obstacleVisuals.clear();
      this.nativeSolidEntries = stagedSolids;
      for (const variants of this.actorVariants.values()) for (const instance of variants.values()) instance.dispose();
      this.actorVariants.clear();
      for (const lod of this.staticLods) lod.dispose();
      this.staticLods.clear();
      this.region = region;
      this.environment = nextEnvironment;
      this.entityRoots.clear();
      this.actorRoots.clear();
      this.actorManifests.clear();
      this.placementBatches.clear();
      this.movableProps.clear();
      this.actorVisibilityConditions.clear();
      for (const [id, instance] of stagedEntities) this.entityRoots.set(id, instance);
      for (const [id, instance] of stagedActors) this.actorRoots.set(id, instance);
      for (const [id, instance] of stagedMovableProps) this.movableProps.set(id, instance);
      for (const [id, manifest] of stagedActorManifests) this.actorManifests.set(id, manifest);
      for (const lod of stagedLods) this.staticLods.add(lod);
      for (const [id, batches] of stagedPlacementBatches) this.placementBatches.set(id, batches);
      for (const [id, fact] of stagedActorVisibility) this.actorVisibilityConditions.set(id, fact);
      this.assetCatalog = byId;
      setSceneAtmosphere(this.scene, region);
      this.environment.setReducedEffects(this.reducedMotion);
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
      stagedWeapon?.dispose();
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
      this.playerWalkSpeed = HERO_COMBAT[heroId].walkSpeed;
      this.dodgeVanish = null;
      this.afterimages?.setStyle(hero.style);
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
      this.playerWalkSpeed = HERO_COMBAT[heroId].walkSpeed;
      this.dodgeVanish = hero.dodgeVanish ? { assetId: manifest.id, from: .15, to: .55 } : null;
      return;
    }
    this.playerWalkSpeed = HERO_COMBAT[heroId].walkSpeed;
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
  }

  async preloadActorVariant(actorId: string, assetId: string, assets: readonly AssetManifestEntry[] = [...this.assetCatalog.values()]): Promise<void> {
    this.assertAlive();
    const baseManifest = this.actorManifests.get(actorId);
    if (!baseManifest) throw new Error(`Actor ${actorId} has no loaded base asset in the current region.`);
    const manifest = assets.find((entry) => entry.id === assetId);
    if (!manifest || manifest.kind !== 'character' || manifest.sourceType !== 'native-glb' || manifest.actorId !== baseManifest.actorId || manifest.variantOf !== baseManifest.id) {
      throw new Error('Variant ' + assetId + ' is not a native character variant of canonical actor ' + baseManifest.actorId + '.');
    }
    const loadEpoch = this.loadEpoch;
    const loaded = await this.assetLoader.load(manifest);
    if (this.disposed || !this.region || loadEpoch !== this.loadEpoch) { loaded.dispose(); throw new Error('Renderer or region changed while loading actor variant.'); }
    const variants = this.actorVariants.get(actorId) ?? new Map<string, NativeAssetInstance>();
    variants.get(assetId)?.dispose();
    variants.set(assetId, loaded);
    this.actorVariants.set(actorId, variants);
    loaded.root.userData.actorInstanceId = actorId;
    loaded.root.userData.actorId = manifest.actorId;
    loaded.root.userData.assetId = assetId;
    this.world.children[0]?.add(loaded.root);
    const snapshot = this.actorSnapshots.get(actorId);
    if (snapshot?.renderVariantId === assetId) this.applyActorSnapshot(loaded, snapshot);
    else loaded.root.visible = false;
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
    this.syncActors(actors, prior, blend, dt);
    // Simulation hit-stop holds the sampled pose; the real-time fades must not run out underneath it.
    const frozen = (combat.hitStop?.remainingTicks ?? 0) > 0;
    for (const actor of actors) {
      this.actorRoots.get(actor.id)?.animation.update(dt, frozen);
      const requested = actor.renderVariantId;
      if (requested) this.actorVariants.get(actor.id)?.get(requested)?.animation.update(dt, frozen);
    }
    const player = actors.find((actor) => actor.id === 'aren') ?? actors.find((actor) => actor.allegiance === 'player');
    const base = player && this.actorRoots.get(player.id);
    const active = player?.renderVariantId && player.renderVariantId !== base?.assetId
      ? this.actorVariants.get(player.id)?.get(player.renderVariantId) : base;
    this.environment?.update(this.renderWorldTimeSeconds, active?.root.position ?? player?.position);
    if (player) this.afterimages?.update(player, combat.worldClock, this.reducedMotion);
    this.obstacleVisuals.update(combat.combatObstacles ?? EMPTY_COMBAT_OBSTACLES, combat.worldClock, this.reducedMotion);
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
    this.postFx.render(0);
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    if (reduced) this.afterimages?.clear();
    this.cameraDirector.setReducedMotion(reduced);
    this.hitFlash.setEnabled(!reduced);
    this.postFx.setReducedEffects(reduced);
    this.environment?.setReducedEffects(reduced);
  }

  /** Presentation-only camera shake (e.g. gate opening, impacts); ignored in reduced motion. */
  addCameraShake(amplitude: number, durationSeconds: number, frequency = 18): void { this.cameraDirector.addShake(amplitude, durationSeconds, frequency); }

  /** Presentation-only post-processing kick (hit impacts, finishers); ignored in reduced motion. */
  addScreenImpulse(strength: number, seconds: number): void { this.postFx.addImpulse(strength, seconds); }

  /** Emissive rim flash on the actor's visible render instance; `charge` ramps up instead of decaying. */
  flashActor(actorId: string, color: Color, intensity: number, durationSeconds: number, mode: 'hit' | 'charge' = 'hit'): void {
    const root = this.resolveActorRoot(actorId);
    if (root) this.hitFlash.flash(root, color, intensity, durationSeconds, mode);
  }

  /** Render root of the actor's currently displayed instance (base asset or active variant). */
  resolveActorRoot(actorId: string): Object3D | undefined { return this.displayedInstance(actorId)?.root; }

  private displayedInstance(actorId: string): NativeAssetInstance | undefined {
    const variantId = this.actorSnapshots.get(actorId)?.renderVariantId;
    const base = this.actorRoots.get(actorId);
    return variantId && variantId !== base?.assetId ? this.actorVariants.get(actorId)?.get(variantId) : base;
  }

  /**
   * Compiles programs for currently hidden objects (pooled VFX, actors awaiting their first sync,
   * hit-flash twins) against the HDR target so their first appearance never stalls on a link.
   */
  prewarm(roots: readonly Object3D[]): void {
    this.assertAlive();
    const hidden: Object3D[] = [];
    for (const root of roots) root.traverse(node => { if (!node.visible) { hidden.push(node); node.visible = true; } });
    try { this.postFx.compile(this.scene, this.camera); } finally { for (const node of hidden) node.visible = false; }
  }

  private prewarmHitFlash(): void {
    const roots = [...this.actorRoots.values()].map(instance => instance.root);
    this.hitFlash.prewarm(roots, () => this.prewarm(roots));
  }

  getNativeSolidColliders(): readonly RegionColliderDefinition[] { return this.sceneColliders; }

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
    const weapon = this.wardenWeapon;
    const weaponSocket = instance && weapon?.carrier === instance.root ? weapon.sockets[socketName as WardenSocketName] : undefined;
    return weaponSocket ?? instance?.sockets[socketName] ?? (instance ? this.bodySocket(instance, socketName) : undefined) ?? (socketName === 'root' ? instance?.root : undefined);
  }

  /** `fist-*`/`foot-*` sockets resolve to the mixamorig hand and foot bones (raw and glTF-sanitized names), cached per instance so lookups never traverse again. */
  private bodySocket(instance: NativeAssetInstance, socketName: string): Object3D | undefined {
    const boneName = BODY_SOCKET_BONES[socketName];
    if (!boneName) return undefined;
    let cache = this.bodySockets.get(instance);
    if (!cache) { cache = new Map(); this.bodySockets.set(instance, cache); }
    let bone = cache.get(socketName);
    if (bone === undefined) {
      bone = instance.root.getObjectByName(PropertyBinding.sanitizeNodeName(boneName)) ?? instance.root.getObjectByName(boneName) ?? null;
      cache.set(socketName, bone);
    }
    return bone ?? undefined;
  }
  addWorldModule(group: Object3D): () => void { this.assertAlive(); this.scene.add(group); return () => group.removeFromParent(); }

  capture(): RendererDebugSnapshot {
    return {
      regionId: this.region?.id ?? null, loading: this.loading, assetErrors: [...this.assetErrors], lodWarnings: [...this.lodWarnings], missingActorAssets: [...this.missingActorAssets],
      loadedAssetIds: [...new Set([...this.entityRoots.values()].map((instance) => instance.assetId))], actorCount: this.actorRoots.size,
      propCount: this.region?.props.length ?? 0, surfaceCount: this.region?.ground.surfaces.length ?? 0, colliderCount: this.region?.ground.colliders.length ?? 0,
      lodMeasurements: [...this.staticLods].map((lod) => lod.debugState), camera: this.cameraDirector.debugState,
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
    this.hitFlash.dispose();
    this.obstacleVisuals.dispose();
    this.trialGates?.dispose(); this.trialGates = null;
    this.waystone?.dispose(); this.waystone = null;
    this.playerOutcome = null;
    this.nativeSolidEntries.length = 0;
    this.sceneColliders.length = 0;
    for (const instance of new Set(this.entityRoots.values())) instance.dispose();
    for (const variants of this.actorVariants.values()) for (const instance of variants.values()) instance.dispose();
    for (const lod of this.staticLods) lod.dispose();
    this.actorVariants.clear();
    this.actorRoots.clear();
    this.entityRoots.clear();
    this.movableProps.clear();
    this.actorManifests.clear();
    this.actorSnapshots.clear();
    this.staticLods.clear();
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
    }
    this.sceneColliders.length = 0;
    for (const entry of this.nativeSolidEntries) {
      if (!entry.visibleWhen || this.worldFacts[entry.visibleWhen] === true) this.sceneColliders.push(entry.collider);
    }
  }

  private syncActors(actors: readonly ActorSnapshot[], previous?: CombatSnapshot, alpha = 1, dt = 0): void {
    this.actorSnapshots.clear();
    this.missingActorAssets.clear();
    for (const actor of actors) {
      this.actorSnapshots.set(actor.id, actor);
      const base = this.actorRoots.get(actor.id);
      const prior = previous?.actors.find((candidate) => candidate.id === actor.id && candidate.archetypeId === actor.archetypeId);
      const baseManifest = this.actorManifests.get(actor.id);
      if (!base || !baseManifest || baseManifest.actorId !== actor.archetypeId) {
        if (base) base.root.visible = false;
        let expectedAssetId: string | undefined;
        for (const manifest of this.assetCatalog.values()) {
          if (manifest.kind === 'character' && manifest.actorId === actor.archetypeId && !manifest.variantOf) { expectedAssetId = manifest.id; break; }
        }
        this.missingActorAssets.add(expectedAssetId ?? String(actor.archetypeId));
        continue;
      }
      const variantId = actor.renderVariantId === baseManifest.id ? undefined : actor.renderVariantId;
      const variants = this.actorVariants.get(actor.id);
      if (variants) for (const [assetId, instance] of variants) instance.root.visible = assetId === variantId && actor.visible;
      if (!variantId) { base.root.visible = actor.visible; this.applyActorSnapshot(base, actor, prior, alpha, dt); continue; }
      const variant = variants?.get(variantId);
      if (!variant) { base.root.visible = false; this.missingActorAssets.add(variantId); continue; }
      base.root.visible = false;
      variant.root.visible = actor.visible;
      this.applyActorSnapshot(variant, actor, prior, alpha, dt);
    }
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
    const interpolate = previous && prior && previous.visible === actor.visible && !actor.downed
      && Math.hypot(position.x - prior.x, position.y - prior.y, position.z - prior.z) < 4;
    if (interpolate) {
      instance.root.position.set(
        prior.x + (position.x - prior.x) * alpha,
        prior.y + (position.y - prior.y) * alpha,
        prior.z + (position.z - prior.z) * alpha,
      );
    } else instance.root.position.set(position.x, position.y, position.z);
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
    if (actor.actionId === SPIN_ACTION_ID && interpolate && previous) {
      // The simulation turns the facing 30° per tick through the spin; smoothing would trail the blade by a quarter turn, so follow the snapshots exactly.
      const priorYaw = Math.atan2(previous.facing.x, previous.facing.z);
      instance.root.rotation.y = priorYaw + Math.atan2(Math.sin(yaw - priorYaw), Math.cos(yaw - priorYaw)) * alpha;
    } else instance.root.rotation.y = dt > 0 && interpolate
      ? instance.root.rotation.y + turn * (1 - Math.exp(-20 * dt)) : yaw;
    const loopTimeSeconds = this.currentCombat
      ? actor.allegiance === 'player' ? this.renderSimulationTick / 60 : this.renderWorldTimeSeconds
      : undefined;
    const hop = driveActorAnimation(instance, actor, previous, {
      interpolate: Boolean(interpolate), alpha, loopTimeSeconds, manifest: this.assetCatalog.get(instance.assetId),
      vitality: actor.allegiance === 'player' ? this.currentCombat?.player.vitality : undefined,
      walkSpeed: actor.allegiance === 'player' ? this.playerWalkSpeed : undefined,
    });
    // Presentation-only monster hop (jump-slot attack, active window); the simulation position is untouched.
    if (hop !== 0) instance.root.position.y += hop;
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
  if (!manifest.requiredActionIds.some((actionId) => String(actionId) === idleActionId) || !manifest.actionToClipMapping[idleActionId]) throw new Error('Companion ' + companionId + ' has no explicitly required native idle action ' + idleActionId + '.');
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', companionId + ' 3D companion preview');
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  host.replaceChildren(canvas);
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
  const assetLoader = options.loader ?? new NativeAssetLoader();
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
  let observer: ResizeObserver | undefined;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
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
    const distance = previewRadius / Math.sin(limitingHalfFov) * 1.15;
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
  return {
    get actionTime() { return instance.animation.activeTime; },
    update: (dt) => {
      if (disposed) return;
      if (!canvas.isConnected || !host.contains(canvas)) { dispose(); return; }
      instance.animation.update(Math.max(0, Math.min(dt, 0.1)));
      render();
    },
    dispose,
  };
}
