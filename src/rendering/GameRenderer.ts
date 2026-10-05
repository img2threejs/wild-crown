import { AmbientLight, Box3, DirectionalLight, Group, HemisphereLight, Mesh, PerspectiveCamera, Scene, Vector3, WebGLRenderer, type Object3D } from 'three';
import type { ActionId, ActorSnapshot, AssetManifestEntry, CombatSnapshot, EnvironmentRecipeDefinition, MovableObjectSnapshot, RegionDefinition, RegionMovableObjectDefinition, WorldAssetPlacement } from '../game/contracts';
import type { CameraDebugState } from './CameraDirector';
import { CameraDirector } from './CameraDirector';
import { NativeAssetLoader, type AssetLoadProgress, type NativeAssetInstance, type NativeStaticBatch } from './NativeAssetLoader';
import { DEFAULT_SCREEN_SPACE_LOD_POLICY, ScreenSpaceLOD, type ScreenSpaceLODPolicy, type ScreenSpaceLODDebugState } from './ScreenSpaceLOD';
import { RegionEnvironment, setSceneAtmosphere } from '../world/RegionEnvironment';

interface DisposableAsset { readonly assetId: string; readonly root: Object3D; dispose(): void }
interface MovablePropInstance { readonly definition: RegionMovableObjectDefinition; readonly root: Group; readonly placementRotationY: number; readonly visibleWhen?: string; awaitingCommit: boolean }
export interface RendererDebugSnapshot {
  regionId: string | null; loading: boolean; assetErrors: readonly string[]; lodWarnings: readonly string[]; missingActorAssets: readonly string[];
  loadedAssetIds: readonly string[]; actorCount: number; propCount: number; surfaceCount: number; colliderCount: number;
  lodMeasurements: readonly ScreenSpaceLODDebugState[]; camera: CameraDebugState;
}
export interface GameRendererOptions { canvas: HTMLCanvasElement; assetLoader?: NativeAssetLoader; onProgress?: (progress: AssetLoadProgress) => void; pixelRatioCap?: number; lodPolicy?: ScreenSpaceLODPolicy }
export interface CompanionPreviewOptions { idleActionId: ActionId; loader?: NativeAssetLoader }
export interface CompanionPreviewHandle { readonly actionTime: number | undefined; update(dt: number): void; dispose(): void }
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
  private readonly scratchForward = new Vector3();
  private readonly scratchUp = new Vector3(0, 1, 0);
  private readonly scratchRight = new Vector3();
  private readonly scratchTarget = new Vector3();
  private readonly ownedLoader: boolean;
  private readonly lodPolicy: ScreenSpaceLODPolicy;
  private readonly lodWarnings: string[] = [];
  private region: RegionDefinition | undefined;
  private environment: RegionEnvironment | undefined;
  private currentCombat: CombatSnapshot | undefined;
  private assetCatalog: ReadonlyMap<string, AssetManifestEntry> = new Map();
  private loading = false;
  private loadEpoch = 0;
  private disposed = false;
  private readonly assetErrors: string[] = [];
  private readonly missingActorAssets = new Set<string>();
  private readonly resizeObserver: ResizeObserver;

  constructor(options: GameRendererOptions) {
    this.ownedLoader = !options.assetLoader;
    this.assetLoader = options.assetLoader ?? new NativeAssetLoader({ onProgress: options.onProgress });
    this.lodPolicy = options.lodPolicy ?? DEFAULT_SCREEN_SPACE_LOD_POLICY;
    this.renderer = new WebGLRenderer({ canvas: options.canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, options.pixelRatioCap ?? 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = 2;
    this.scene.add(this.world);
    this.cameraDirector = new CameraDirector(this.scene);
    this.camera = this.cameraDirector.camera;
    this.scene.add(new AmbientLight(0xffffff, 0.05));
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(options.canvas);
    this.resize();
  }

  async loadRegion(region: RegionDefinition, assets: readonly AssetManifestEntry[], environmentRecipe: EnvironmentRecipeDefinition): Promise<void> {
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
    nextWorld.name = `region:${region.id}`;
    nextWorld.add(nextEnvironment.group);
    try {
      const recipe = byId.get(region.environmentRecipeId);
      if (environmentRecipe.id !== region.environmentRecipeId || environmentRecipe.regionId !== region.id) throw new Error(`Region ${region.id} has mismatched procedural recipe '${environmentRecipe.id}'.`);
      const requiredLayers = ['terrain', 'water', 'vegetation', 'fog', 'lighting', 'collision'];
      for (const layer of requiredLayers) if (!environmentRecipe.proceduralLayers.includes(layer as never)) throw new Error(`Region recipe '${environmentRecipe.id}' lacks required procedural layer '${layer}'.`);
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
      const placementsByAsset = new Map<string, WorldAssetPlacement[]>();
      for (const placement of region.props) {
        if (movableById.has(placement.id)) continue;
        const current = placementsByAsset.get(placement.assetId);
        if (current) current.push(placement);
        else placementsByAsset.set(placement.assetId, [placement]);
      }
      for (const [assetId, placements] of placementsByAsset) {
        const manifest = byId.get(assetId);
        if (!manifest) throw new Error(`Region ${region.id} placement ${placements[0]!.id} references missing manifest asset '${assetId}'.`);
        if (manifest.kind !== 'prop' || manifest.sourceType !== 'native-glb') throw new Error(`Prop placement ${placements[0]!.id} requires exact native-glb prop '${assetId}'.`);
        const baseBatch = await this.assetLoader.loadStaticBatch(manifest, placements);
        if (this.disposed || loadEpoch !== this.loadEpoch) { baseBatch.dispose(); throw new Error('Region load was superseded.'); }
        const batches: NativeStaticBatch[] = [baseBatch];
        for (const lodId of manifest.lodIds) {
          const lodManifest = byId.get(lodId);
          if (!lodManifest || lodManifest.kind !== 'prop' || lodManifest.sourceType !== 'native-glb' || !lodManifest.runtimeUrl || lodManifest.evidenceStatus !== 'verified') {
            this.lodWarnings.push(`LOD ${lodId} for ${assetId} not loaded: a verified native GLB with runtime URL is not available.`);
            continue;
          }
          try {
            const lodBatch = await this.assetLoader.loadStaticBatch(lodManifest, placements);
            if (this.disposed || loadEpoch !== this.loadEpoch) { lodBatch.dispose(); throw new Error('Region load was superseded.'); }
            batches.push(lodBatch);
          } catch (error) {
            if (this.disposed || loadEpoch !== this.loadEpoch) throw error;
            this.lodWarnings.push('LOD ' + lodId + ' for ' + assetId + ' not loaded: ' + (error instanceof Error ? error.message : String(error)));
          }
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
      }
      for (const definition of region.movableObjects) {
        const placement = movablePlacements.get(definition.id)!;
        const manifest = byId.get(definition.assetId);
        if (!manifest || manifest.id !== definition.assetId || manifest.kind !== 'prop' || manifest.sourceType !== 'native-glb') throw new Error('Movable prop ' + definition.id + ' requires exact native-glb prop asset ' + definition.assetId + '.');
        const loaded = await this.assetLoader.load(manifest);
        if (this.disposed || loadEpoch !== this.loadEpoch) { loaded.dispose(); throw new Error('Region load was superseded.'); }
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
      if (this.disposed || loadEpoch !== this.loadEpoch) throw new Error('Region load was disposed or superseded before commit.');
      const previousWorld = this.world.children[0];
      if (previousWorld) this.world.remove(previousWorld);
      this.world.add(nextWorld);
      const previousEnvironment = this.environment;
      const previousEntities = new Map(this.entityRoots);
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
      this.cameraDirector.setRegion(region);
      setSceneAtmosphere(this.scene, region.id);
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
    } catch (error) {
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

  sync(actors: readonly ActorSnapshot[], combat: CombatSnapshot, dt: number): void {
    this.assertAlive();
    this.currentCombat = combat;
    this.syncMovableObjects(combat.movableObjects);
    this.cameraDirector.update(combat, dt);
    this.syncActors(actors);
    for (const actor of actors) {
      this.actorRoots.get(actor.id)?.animation.update(dt);
      const requested = actor.renderVariantId;
      if (requested) this.actorVariants.get(actor.id)?.get(requested)?.animation.update(dt);
    }
    this.cameraDirector.copyTarget(this.scratchTarget);
    const height = this.renderer.domElement.clientHeight;
    for (const lod of this.staticLods) lod.update(this.camera, this.scratchTarget, height);
    this.renderer.render(this.scene, this.camera);
  }

  getInputBasis(): { forward: Vector3; right: Vector3 } {
    this.camera.getWorldDirection(this.scratchForward).setY(0).normalize();
    this.scratchRight.crossVectors(this.scratchForward, this.scratchUp).normalize();
    return { forward: this.scratchForward, right: this.scratchRight };
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
  resolveSocket(actorId: string, socketName: string): Object3D | undefined {
    const variantId = this.actorSnapshots.get(actorId)?.renderVariantId;
    const instance = variantId ? this.actorVariants.get(actorId)?.get(variantId) : this.actorRoots.get(actorId);
    return instance?.sockets[socketName];
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
  }

  private syncActors(actors: readonly ActorSnapshot[]): void {
    this.actorSnapshots.clear();
    this.missingActorAssets.clear();
    for (const actor of actors) {
      this.actorSnapshots.set(actor.id, actor);
      const base = this.actorRoots.get(actor.id);
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
      const variantId = actor.renderVariantId;
      const variants = this.actorVariants.get(actor.id);
      if (variants) for (const [assetId, instance] of variants) instance.root.visible = assetId === variantId && actor.visible;
      if (!variantId) { base.root.visible = actor.visible; this.applyActorSnapshot(base, actor); continue; }
      const variant = variants?.get(variantId);
      if (!variant) { base.root.visible = false; this.missingActorAssets.add(variantId); continue; }
      base.root.visible = false;
      variant.root.visible = actor.visible;
      this.applyActorSnapshot(variant, actor);
    }
  }


  private applyActorSnapshot(instance: NativeAssetInstance, actor: ActorSnapshot): void {
    const visibleWhen = this.actorVisibilityConditions.get(actor.id);
    instance.root.visible = actor.visible && (!visibleWhen || this.worldFacts[visibleWhen] === true);
    instance.root.position.set(actor.position.x, actor.position.y, actor.position.z);
    instance.root.rotation.y = Math.atan2(actor.facing.x, actor.facing.z);
    const clock = this.currentCombat?.worldClock;
    // Clock selection belongs to the actor snapshot, never to render delta or clip playback speed.
    const loopTimeSeconds = clock
      ? actor.allegiance === 'player' ? clock.simulationTick / 60 : clock.worldTimeSeconds
      : undefined;
    instance.animation.play(actor.actionId, actor.phase, actor.normalizedTime, loopTimeSeconds);
  }

  private resize(): void {
    if (this.disposed) return;
    const width = Math.max(1, this.renderer.domElement.clientWidth);
    const height = Math.max(1, this.renderer.domElement.clientHeight);
    this.renderer.setSize(width, height, false);
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
