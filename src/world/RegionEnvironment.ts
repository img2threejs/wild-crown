import { AmbientLight, BufferAttribute, BufferGeometry, Color, DirectionalLight, Fog, Group, HemisphereLight, Mesh, MeshStandardMaterial, Scene, Vector3 } from 'three';
import type { EnvironmentRecipeDefinition, GroundSurfaceDefinition, RegionDefinition, RegionId, Vec3 } from '../game/contracts';
import { AtmosphericSky, DEFAULT_SKY } from './AtmosphericSky';
import { biomeProfileFor } from './Biomes';
import type { BiomeProfile, GroundFeature, HeightFogProfile, RegionGradeProfile, SkyProfile } from './BiomeProfile';
import { GREENWAKE_BIOME } from './GreenwakeBiome';
import { GroundUnderstory } from './GroundUnderstory';
import { RegionGround } from './RegionGround';
import { GREENWAKE_CANOPY_FLOOR_ID, isGroundWalkSurface } from './WalkSurfaces';

interface BiomeStyle { sky: number; fog: number; ground: number; grass: number; stone: number; water: number; sun: number; ambient: number }
const STYLES: Record<string, BiomeStyle> = {
  greenwake: { sky: 0x9dbfc2, fog: 0xb8cfbd, ground: 0x627a54, grass: 0x8e9a5b, stone: 0x777b69, water: 0x4f9290, sun: 0xffdca4, ambient: 0xacc5b7 },
  'the-grove': { sky: 0x829995, fog: 0x9cae91, ground: 0x465b3d, grass: 0x79854e, stone: 0x606953, water: 0x4c8580, sun: 0xffd18a, ambient: 0x9cb2a0 },
  'whispering-canopy': { sky: 0x65868a, fog: 0x829f91, ground: 0x445f4c, grass: 0x87975b, stone: 0x667465, water: 0x4d8c8c, sun: 0xffd596, ambient: 0x9eb7a8 },
  'blood-bamboo-valley': { sky: 0x849a8c, fog: 0xb0aa8b, ground: 0x675443, grass: 0x9c7757, stone: 0x777160, water: 0x527d77, sun: 0xffc37e, ambient: 0xc0b191 },
  'moonpine-ridge': { sky: 0x667b8a, fog: 0x97a9ad, ground: 0x4c5e61, grass: 0x667c75, stone: 0x838c91, water: 0x537481, sun: 0xc3dcff, ambient: 0xa9bdd0 },
  'mistveil-basin': { sky: 0x879da4, fog: 0xc2d0c7, ground: 0x586b62, grass: 0x829278, stone: 0x747e7c, water: 0x628d91, sun: 0xdce5d3, ambient: 0xc0d0c3 },
  'sunmane-expanse': { sky: 0xc69d6d, fog: 0xd9b684, ground: 0x9a784a, grass: 0xaf9658, stone: 0x88785e, water: 0x648b83, sun: 0xffdda0, ambient: 0xd6bc94 },
  refuge: { sky: 0x8da4a0, fog: 0xb3c1aa, ground: 0x53694a, grass: 0x8a9856, stone: 0x777866, water: 0x4f8581, sun: 0xffd498, ambient: 0xb4c8b7 },
  'heartroot-hollow': { sky: 0x596d72, fog: 0x758b7e, ground: 0x34453d, grass: 0x687c52, stone: 0x74776c, water: 0x4b7474, sun: 0xe5bf88, ambient: 0x91aa9f },
};
const PARTIAL_RESTORATION_TINT = new Color(0xd9cd9d);
const CLEARED_MISTVEIL_WATER = { shallow: 0x518d83, deep: 0x183f43, sky: 0x8baeb5, sun: 0xdce5d3, foam: 0xb6d4c6 };
/** Boundary rocks anchor to the lowest ground within this share of their footprint radius, then sink by ROCK_SINK of that radius. */
const ROCK_ANCHOR_SHARE = 0.6;
const ROCK_SINK = 0.18;

/** Regional procedural layers use the campaign's absolute ground vertices. */
export class RegionEnvironment {
  readonly group = new Group();
  readonly style: BiomeStyle;
  /** The biome that drives this region's visual ground (Greenwake, the canopy playtest variant), if it has one. */
  readonly profile: BiomeProfile | undefined;
  private readonly ownedMaterials: MeshStandardMaterial[] = [];
  private readonly ownedGeometries: BufferGeometry[] = [];
  private readonly baseSurfaceColors = new Map<MeshStandardMaterial, Color>();
  readonly ground: RegionGround | undefined;
  private readonly wind = { value: 0 };
  private understory: GroundUnderstory | undefined;
  private readonly features: GroundFeature[] = [];
  /** Plan-view anchor radius per boundary rock (keyed by position): rocks stand on the lowest terrain under their footprint. */
  private readonly rockAnchors = new Map<string, number>();
  /** Resolves when the region's texture layers are uploaded (profiled ground); immediate elsewhere. */
  readonly ready: Promise<void>;
  private readonly sun: DirectionalLight;
  private shadowOrigin: Vector3 = new Vector3();
  /** Fixed light position relative to the focused player (profiled regions). */
  private readonly sunOffset = new Vector3();
  /** Sky dome (gradient + sun + drifting clouds) attached under `this.group`; the dome positions itself to follow focus. */
  skyDome: AtmosphericSky | undefined;
  /** Cached per-region mood that the post-processing chain needs (grade, height fog, shafts). */
  readonly mood: { sky: SkyProfile; heightFog: HeightFogProfile | undefined; grade: RegionGradeProfile | undefined; lightShafts: number };
  /** Tracks the current reduced-effects setting so `update()` can pass it to the sky dome without re-querying. */
  private reducedEffects = false;
  /** Latest focus position passed to `update()`; the post-processing bridge uses it for sun projection. */
  private readonly lastFocus = new Vector3();
  private disposed = false;

  constructor(readonly region: RegionDefinition, readonly recipe: EnvironmentRecipeDefinition) {
    this.group.name = `environment:${region.id}`;
    this.profile = biomeProfileFor(region);
    this.style = STYLES[region.id] ?? STYLES.greenwake!;
    this.sun = this.buildAtmosphere();
    const profile = this.profile;
    let sunDirection: Vector3 | undefined;
    if (profile) {
      this.ground = new RegionGround(region, profile);
      sunDirection = this.sun.position.clone().sub(this.sun.target.position).normalize();
      this.ground.water.setSunDirection(sunDirection);
      this.group.add(this.ground.group);
      const rocks = profile.boundaryRocks;
      if (rocks) {
        for (const prop of region.props) {
          if (!prop.id.startsWith(rocks.idPrefix)) continue;
          this.rockAnchors.set(`${prop.position.x},${prop.position.z}`, rocks.footprintRadius * Math.max(prop.scale.x, prop.scale.z) * ROCK_ANCHOR_SHARE);
        }
      }
      this.baseSurfaceColors.set(this.ground.trail.material, this.ground.trail.material.color.clone());
      this.understory = new GroundUnderstory(region, this.ground.field, this.ground.mask, this.wind, profile);
      this.group.add(this.understory.group);
      for (const createFeature of profile.features) {
        const feature = createFeature({ region, field: this.ground.field, sunDirection });
        this.features.push(feature);
        this.group.add(feature.group);
      }
    }
    // Mood + sky dome are owned by every region (profiled and generic), so the post-processing chain has the per-region
    // values to feed even when the region has no biome profile (the literal-color regions reuse DEFAULT_SKY).
    const skyProfile: SkyProfile = profile?.atmosphere.sky ?? DEFAULT_SKY;
    this.mood = {
      sky: skyProfile,
      heightFog: profile?.atmosphere.heightFog,
      grade: profile?.atmosphere.grade,
      lightShafts: profile?.atmosphere.lightShafts ?? 0,
    };
    this.skyDome = new AtmosphericSky({ fallback: skyProfile });
    if (sunDirection) this.skyDome.setSunDirection(sunDirection);
    this.group.add(this.skyDome.mesh);
    this.ready = this.ground?.ready ?? Promise.resolve();
    for (const surface of region.ground.surfaces) this.buildSurface(surface);
  }

  /**
   * Visual terrain height (0 outside profiled regions) so props planted off-route can follow the mounds; never used for simulation.
   * Boundary rocks sit on the lowest terrain under their footprint and sink slightly, so on a slope the uphill side is buried.
   */
  visualGroundHeightAt(x: number, z: number): number {
    const field = this.ground?.field;
    if (!field) return 0;
    const anchor = this.rockAnchors.get(`${x},${z}`);
    if (anchor === undefined) return field.sample(x, z);
    let lowest = field.sample(x, z);
    for (let index = 0; index < 8; index++) {
      const angle = (index * Math.PI) / 4;
      lowest = Math.min(lowest, field.sample(x + Math.cos(angle) * anchor, z + Math.sin(angle) * anchor));
    }
    return lowest - anchor * ROCK_SINK;
  }

  syncWorldFacts(facts: Readonly<Record<string, boolean>>): void {
    const restored = facts[this.recipe.restorationFacts.restored] === true;
    const partial = !restored && facts[this.recipe.restorationFacts.partial] === true;
    if (this.region.id === 'mistveil-basin' && this.ground && this.profile) {
      this.ground.water.setWaterway(
        facts['side:river-cleared'] === true ? CLEARED_MISTVEIL_WATER : this.profile.water.palette,
        facts['riverRoute:break-dam'] === true ? 0.35 : 0,
      );
    }
    for (const [material, baseColor] of this.baseSurfaceColors) {
      if (restored) material.color.copy(baseColor).lerp(PARTIAL_RESTORATION_TINT, 0.1);
      else if (partial) material.color.copy(baseColor).lerp(PARTIAL_RESTORATION_TINT, 0.2);
      else material.color.copy(baseColor);
    }
  }

  /**
   * Fewer particles and no light shafts for the Reduced Motion / Reduced Effects settings (ground, water and vegetation are
   * unaffected; the water and foliage animation still follows the world clock). The sky dome's cloud drift freezes and the
   * god-rays pass is disabled (PostFX owns that toggle); the colour grade still applies under reduced effects (cheap).
   */
  setReducedEffects(reduced: boolean): void {
    this.reducedEffects = reduced;
    for (const feature of this.features) feature.setReducedEffects(reduced);
  }

  /**
   * Per-frame update. The bounded sun-shadow volume of a profiled region tracks the focused player (light direction
   * preserved); grass streams around the focus and all wind sway, water flow and canopy features read the same world
   * clock so they stay in sync with the renderer. The sky dome follows the focus so the player never sees its inner edge.
   */
  update(worldTimeSeconds: number, focus?: Readonly<Vec3>): void {
    if (this.disposed) return;
    if (focus) {
      this.lastFocus.set(focus.x, focus.y, focus.z);
      this.skyDome?.update(worldTimeSeconds, this.lastFocus, this.reducedEffects);
    }
    this.understory?.update(worldTimeSeconds, focus);
    this.ground?.update(worldTimeSeconds);
    for (const feature of this.features) feature.update(worldTimeSeconds, focus);
    if (this.profile && this.sun.castShadow) this.updateBoundedShadow(focus);
  }

  /** Last focus position the per-frame update sampled (player root or proxy). Used by the post-processing bridge. */
  getLastFocus(): Vector3 { return this.lastFocus; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    this.skyDome?.dispose();
    for (const geometry of this.ownedGeometries) geometry.dispose();
    for (const material of this.ownedMaterials) material.dispose();
    this.ownedGeometries.length = 0;
    this.ownedMaterials.length = 0;
    this.baseSurfaceColors.clear();
    this.understory?.dispose();
    for (const feature of this.features) feature.dispose();
    this.features.length = 0;
    this.ground?.dispose();
    this.sun.shadow.dispose();
  }

  private buildAtmosphere(): DirectionalLight {
    const profile = this.profile;
    if (profile) {
      const look = profile.atmosphere;
      const ambient = new HemisphereLight(look.hemisphereSky, look.hemisphereGround, look.hemisphereIntensity);
      ambient.name = 'regional-sky-fill';
      this.group.add(ambient);
      const sun = new DirectionalLight(look.sunColor, look.sunIntensity);
      sun.name = 'regional-key-light';
      // Fixed light direction so shadow geometry stays consistent with the
      // world-space route; only the orthographic volume follows the player.
      const centerX = (this.region.bounds.min.x + this.region.bounds.max.x) / 2;
      const centerZ = (this.region.bounds.min.z + this.region.bounds.max.z) / 2;
      this.shadowOrigin = new Vector3(centerX, 0, centerZ);
      this.sunOffset.set(look.sunOffset.x, look.sunOffset.y, look.sunOffset.z);
      sun.position.copy(this.sunOffset).add(this.shadowOrigin);
      sun.target.position.copy(this.shadowOrigin);
      sun.target.name = 'regional-sun-target';
      sun.target.updateMatrixWorld();
      this.group.add(sun.target);
      sun.castShadow = true;
      sun.shadow.mapSize.set(look.shadowMapSize, look.shadowMapSize);
      sun.shadow.camera.near = 1;
      sun.shadow.camera.far = 180;
      sun.shadow.camera.left = -look.shadowHalfWidth;
      sun.shadow.camera.right = look.shadowHalfWidth;
      sun.shadow.camera.top = look.shadowHalfWidth;
      sun.shadow.camera.bottom = -look.shadowHalfWidth;
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.04;
      this.group.add(sun);
      const fill = new AmbientLight(look.fillColor, look.fillIntensity);
      fill.name = 'regional-color-fill';
      this.group.add(fill);
      return sun;
    }
    const ambient = new HemisphereLight(this.style.sky, this.style.ground, 1.35);
    ambient.name = 'regional-sky-fill';
    this.group.add(ambient);
    const sun = new DirectionalLight(this.style.sun, 2.25);
    sun.name = 'regional-key-light';
    const centerX = (this.region.bounds.min.x + this.region.bounds.max.x) / 2;
    const centerZ = (this.region.bounds.min.z + this.region.bounds.max.z) / 2;
    const radius = Math.hypot(this.region.bounds.max.x - this.region.bounds.min.x, this.region.bounds.max.z - this.region.bounds.min.z) / 2 + 4;
    sun.position.set(centerX - 32, 54, centerZ - 28);
    sun.target.position.set(centerX, 0, centerZ);
    sun.target.name = 'regional-sun-target';
    this.group.add(sun.target);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = Math.max(120, radius * 2 + 80);
    sun.shadow.camera.left = -radius;
    sun.shadow.camera.right = radius;
    sun.shadow.camera.top = radius;
    sun.shadow.camera.bottom = -radius;
    // Match the profiled-light shadow bias so the generic fallback does not acne / leak on shallow character geometry
    // (notably the actors' black robes) when the same scene is rendered without a biome profile.
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    this.group.add(sun);
    const fill = new AmbientLight(this.style.ambient, 0.3);
    fill.name = 'regional-color-fill';
    this.group.add(fill);
    return sun;
  }

  private updateBoundedShadow(focus: Readonly<Vec3> | undefined): void {
    if (!focus) return;
    this.sun.target.position.set(focus.x, focus.y, focus.z);
    this.sun.position.copy(this.sun.target.position).add(this.sunOffset);
    this.sun.target.updateMatrixWorld();
  }

  private buildSurface(surface: GroundSurfaceDefinition): void {
    if (surface.points.length < 3) return;
    // Every walkable surface of a profiled region is drawn by the visual terrain, except bridge decks, whose only visual is
    // the bridge model; the region-wide floor of the old Greenwake layout is never drawn.
    if (this.ground && (surface.id === GREENWAKE_CANOPY_FLOOR_ID || isGroundWalkSurface(surface))) return;
    const points = surface.points.map((point) => new Vector3(point.x, point.y, point.z));
    const origin = points[0]!;
    const firstEdge = points[1]!;
    const secondEdge = points[2]!;
    const normalY = (firstEdge.z - origin.z) * (secondEdge.x - origin.x) - (firstEdge.x - origin.x) * (secondEdge.z - origin.z);
    const reverseWinding = normalY < 0;
    const triangles: number[][] = [];
    for (let index = 1; index < points.length - 1; index++) triangles.push(reverseWinding ? [0, index + 1, index] : [0, index, index + 1]);
    const positions = new Float32Array(points.length * 3);
    for (let index = 0; index < points.length; index++) {
      const point = points[index]!;
      positions[index * 3] = point.x;
      positions[index * 3 + 1] = point.y;
      positions[index * 3 + 2] = point.z;
    }
    const geometry = this.createGeometry(positions, triangles);
    if (surface.material === 'water' || surface.profile === 'water') {
      const material = new MeshStandardMaterial({ color: this.style.water, roughness: 0.28, metalness: 0.12, transparent: true, opacity: 0.82 });
      this.ownedMaterials.push(material);
      this.baseSurfaceColors.set(material, material.color.clone());
      const water = new Mesh(geometry, material);
      water.name = `water:${surface.id}`;
      water.receiveShadow = true;
      water.userData.groundSurfaceId = surface.id;
      water.userData.waterForSurface = surface.id;
      water.userData.colliderId = surface.colliderId;
      water.userData.walkable = surface.walkable;
      water.userData.traversalEvent = surface.traversalEvent;
      this.group.add(water);
      return;
    }
    const material = this.createSurfaceMaterial(surface.material);
    this.baseSurfaceColors.set(material, material.color.clone());
    const mesh = new Mesh(geometry, material);
    mesh.name = `surface:${surface.id}`;
    mesh.receiveShadow = true;
    mesh.userData.groundSurfaceId = surface.id;
    mesh.userData.colliderId = surface.colliderId;
    mesh.userData.walkable = surface.walkable;
    mesh.userData.traversalEvent = surface.traversalEvent;
    this.group.add(mesh);
  }

  private createGeometry(positions: Float32Array, triangles: readonly number[][]): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    const indices: number[] = [];
    for (const triangle of triangles) indices.push(triangle[0]!, triangle[1]!, triangle[2]!);
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    this.ownedGeometries.push(geometry);
    return geometry;
  }

  private createSurfaceMaterial(kind: string): MeshStandardMaterial {
    const color = kind === 'grass' || kind === 'moss' ? this.style.grass : kind === 'stone' || kind === 'wood' ? this.style.stone : this.style.ground;
    const material = new MeshStandardMaterial({ color, roughness: 0.9, metalness: 0 });
    this.ownedMaterials.push(material);
    return material;
  }
}

/**
 * Scene background and fog of a region. Pass the region definition so the Whispering Canopy playtest variant gets its humid
 * green-grey fog; a bare id resolves the profiled authored regions (Greenwake) and the generic style of every other one.
 */
export function setSceneAtmosphere(scene: Scene, region: RegionId | RegionDefinition): void {
  const regionId = typeof region === 'string' ? region : region.id;
  const profile = typeof region === 'string' ? (region === 'greenwake' ? GREENWAKE_BIOME : undefined) : biomeProfileFor(region);
  if (profile) {
    scene.background = new Color(profile.atmosphere.background);
    scene.fog = new Fog(new Color(profile.atmosphere.fogColor), profile.atmosphere.fogNear, profile.atmosphere.fogFar);
    return;
  }
  const style = STYLES[regionId] ?? STYLES.greenwake!;
  scene.background = new Color(style.sky);
  scene.fog = new Fog(new Color(style.fog), 14, 115);
}
