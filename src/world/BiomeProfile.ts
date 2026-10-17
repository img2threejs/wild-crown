import type { Object3D, Vector3 } from 'three';
import type { RegionDefinition, Vec3 } from '../game/contracts';
import type { MaskSample } from './GroundMask';
import type { TerrainField } from './GroundTerrain';

/**
 * Everything that makes one region's visual ground different from another's. The shared world stack (terrain field and mesh,
 * splat mask and material, grass, clutter, water, shadow) is parameterised by one profile per region; simulation walkability
 * never reads it.
 */
export interface BiomeProfile {
  readonly id: string;
  readonly terrain: TerrainProfile;
  readonly carve: GroundCarve;
  readonly splat: SplatProfile;
  readonly understory: UnderstoryProfile;
  readonly water: WaterPlan;
  readonly atmosphere: AtmosphereProfile;
  /** Extra ground features of this biome (canopy: waterfall, drifting leaves, light shafts). */
  readonly features: readonly ((context: FeatureContext) => GroundFeature)[];
  /** Id prefix of decoration-only boundary rocks that stand on the lowest ground under their footprint (RegionEnvironment). */
  readonly boundaryRocks: BoundaryRockProfile | undefined;
}

export interface Extent {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/** The region's visual ground extent: its bounds unless the profile narrows it to where the fixed camera can ever see ground. */
export function groundExtent(region: RegionDefinition, profile: BiomeProfile): Extent {
  return profile.terrain.extent ?? { minX: region.bounds.min.x, maxX: region.bounds.max.x, minZ: region.bounds.min.z, maxZ: region.bounds.max.z };
}

export interface BoundaryRockProfile {
  readonly idPrefix: string;
  readonly assetId: string;
  /** Plan-view radius of one rock at unit scale (anchors it on the lowest ground under its footprint). */
  readonly footprintRadius: number;
}

/** A planar, convex, non-walkable raised footprint (a cliff massif or its slope): ground continues its plane and falls off as a cliff face. */
export interface SummitSpec {
  readonly id: string;
  readonly points: readonly Vec3[];
  /** Amplitude (m) of the gentle hummocks on the plateau away from walkables. */
  readonly hummock: number;
}

export interface TerrainProfile {
  /** Open-ground relief: mounds up to `maxMound`, dips down to `maxDip` (negative). */
  readonly maxMound: number;
  readonly maxDip: number;
  /** Berm just outside flat walkables, taller on edges that face away from the fixed camera. */
  readonly bermMinHeight: number;
  readonly bermMaxHeight: number;
  /** Embankment faces: rise/run between slopeMin and slopeMax, run between minRun and maxRun, plus `rock` metres of crags. */
  readonly embankment: {
    readonly slopeMin: number;
    readonly slopeMax: number;
    readonly minRun: number;
    readonly maxRun: number;
    readonly rock: number;
  };
  readonly summits: readonly SummitSpec[];
  /** Far relief added to open ground (rising massif behind the route), 0 where the ground should stay low. */
  readonly backdrop: ((x: number, z: number) => number) | undefined;
  /** Narrower than the region bounds when the camera can never see the rest. */
  readonly extent: Extent | undefined;
  /** Fine-mesh (0.25 m) bands: this far outside flat walkables (the berm) and outside raised footprints / summits (the faces). */
  readonly refine: { readonly flatOutside: number; readonly raisedOutside: number };
}

/**
 * Carved channels (creek gully, rivers, plunge pools). The terrain takes `min(ground, carve)` away from walkables, the splat
 * mask paints wet banks and bed gravel from it, and refinement concentrates triangles where it matters.
 */
export interface GroundCarve {
  /** Rounding of the lip where the carved surface meets the ground (m). */
  readonly lipSmooth: number;
  /**
   * The carve fades in over this range of distances (m) from a walkable. A channel whose rim stands exactly at the walkable's
   * edge (the creek gully) starts at 0; one that undercuts a walkable (a cliff above a gorge) must start at the berm / shoulder
   * distance (0.36 m) so the walkable stays exact, and rolls the crest over until `crestEnd`.
   */
  readonly crestStart: number;
  readonly crestEnd: number;
  /** Peak-to-peak bed roughness (m) added inside the channel. */
  readonly bedNoise: number;
  /** Carved surface height: far above any ground outside the channel's reach. */
  surfaceHeight(x: number, z: number): number;
  /** True where the mesh should be fine (the channel and its immediate banks, grown by `margin`). */
  insideBand(x: number, z: number, margin: number): boolean;
  /** 1 in the bed and lower banks, fading to 0 at the rim. */
  membership(x: number, z: number): number;
  /** 1 on the lower banks within about a metre of the water (given the terrain height there), where the ground is wet mud. */
  wetness(x: number, z: number, surface: number): number;
  /** Water surface height at the point (−Infinity where no water stands). */
  waterLevel(x: number, z: number): number;
}

export interface GroundLayerSpec {
  readonly id: string;
  readonly metersPerTile: number;
  /** Linear multiplier grading the layer into one cohesive palette. */
  readonly tint: readonly [number, number, number];
}

/** A texture layer used for a terrain feature (rock, river bed, wet bank): which layer, its scale multiplier and grade. */
export interface FeatureLayerSpec {
  readonly layer: number;
  readonly scale: number;
  readonly tint: readonly [number, number, number];
  readonly roughness: number;
}

/**
 * Splat layers 0–3 are fixed roles: 0 litter (cross-faded at two scales), 1 moss, 2 trail core, 3 worn shoulder / undergrowth
 * band. Further layers (4) only serve features.
 */
export interface SplatProfile {
  /** URL root of `<id>/{diffuse,normal,arm}.jpg`. */
  readonly textureRoot: string;
  readonly layers: readonly GroundLayerSpec[];
  readonly rock: FeatureLayerSpec;
  readonly bed: FeatureLayerSpec;
  readonly mud: FeatureLayerSpec;
  readonly rockSlopeStart: number;
  readonly rockSlopeFull: number;
  /** Steep ground away from walkables and channels reads as rock too (a cliff massif), not only embankment and bank faces. */
  readonly rockOnOpenSlopes: boolean;
  /** Terrain below `bottom` is darkened by `strength` (gully shade), fading in from `top`. */
  readonly depthShade: { readonly top: number; readonly bottom: number; readonly strength: number };
  readonly macroLow: readonly [number, number, number];
  readonly macroHigh: readonly [number, number, number];
  /** Strata banding on rock faces (0 none). */
  readonly strata: number;
  /** Slowly drifting patches of light and shade on the ground (light through a canopy); undefined for open sky. */
  readonly dapple: { readonly strength: number; readonly scale: number; readonly speed: number } | undefined;
}

export interface GrassProfile {
  readonly bladeHeight: number;
  /** Multiplier on every blade's height (the berm band adds its own). */
  readonly heightScale: number;
  /** Multiplier on grass clump probability. */
  readonly densityScale: number;
  readonly base: number;
  readonly tip: number;
  readonly baseDry: number;
  readonly tipDry: number;
  readonly cacheKey: string;
  /** Optional blight (an infection spreading over the ground): per-point strength 0..1, the dead blade colours and the share of height lost at full strength. */
  readonly blight?: { amount(x: number, z: number): number; readonly base: number; readonly tip: number; readonly shrink: number };
}

export interface ScatterContext {
  readonly x: number;
  readonly z: number;
  /** Uniform random numbers deterministic in the grid cell. */
  readonly h: number;
  readonly rng: number;
  readonly mask: MaskSample;
  readonly field: TerrainField;
  /** 1 within `clutterNearFull` of the walk-mesh, fading to 0 at `clutterNearNone` (computed on demand). */
  near(): number;
}

export interface InstanceSink {
  push(x: number, y: number, z: number, yaw: number, sx: number, sy: number, sz: number, tint: number): void;
}

export interface ClutterScatter {
  readonly cell: number;
  readonly seed: number;
  place(context: ScatterContext, out: InstanceSink): void;
}

export type ClutterGeometryKind = 'pebble' | 'twig' | 'leaf-pile' | 'mushroom' | 'fern' | 'jungle-fern' | 'edge-stone' | 'broadleaf' | 'log' | 'root' | 'big-leaf';

export interface ClutterRecipe {
  readonly name: ClutterGeometryKind;
  readonly tints: readonly number[];
  readonly tilt: number;
  readonly receiveShadow: boolean;
  /** Vertex-sway wind kind of the material, if any. */
  readonly sway: 'fern' | 'broadleaf' | undefined;
  readonly scatters: readonly ClutterScatter[];
}

export interface TrailDressing {
  readonly stoneTints: readonly number[];
  /** Softly glowing mushroom clusters guiding the eye along the ribbons. */
  readonly glow: boolean;
}

export interface UnderstoryProfile {
  readonly grass: GrassProfile;
  /** True where nothing may grow (authored buildings). */
  excluded(x: number, z: number): boolean;
  readonly clutter: readonly ClutterRecipe[];
  readonly trailDressing: TrailDressing;
  /** Distance from the walk-mesh at which clutter starts to fade, and is gone. */
  readonly clutterNearFull: number;
  readonly clutterNearNone: number;
}

export interface WaterRow {
  readonly x: number;
  readonly z: number;
  /** Unit flow direction in the xz plane. */
  readonly dirX: number;
  readonly dirZ: number;
  readonly halfWidth: number;
  readonly waterY: number;
  /** End fade 0–1 (a strip fades to nothing where the bed climbs out of its channel). */
  readonly fade: number;
  /** 0 calm … 1 rapids (more foam, faster ripples). */
  readonly turbulence: number;
}

export interface WaterStripSpec {
  readonly rows: readonly WaterRow[];
  readonly columns: number;
}

/** An elliptical pool whose rim fades out. */
export interface WaterPoolSpec {
  readonly x: number;
  readonly z: number;
  readonly radiusX: number;
  readonly radiusZ: number;
  readonly rotation: number;
  readonly waterY: number;
  /** Foam / churn at the pool (0 calm … 1 under a waterfall). */
  readonly turbulence: number;
  /** Where a waterfall lands: turbulence peaks here and falls to the pool's own value over `radius` metres. */
  readonly impact?: { readonly x: number; readonly z: number; readonly radius: number };
}

export interface WaterPalette {
  readonly shallow: number;
  readonly deep: number;
  readonly sky: number;
  readonly sun: number;
  readonly foam: number;
}

export interface WaterPlan {
  readonly name: string;
  readonly strips: readonly WaterStripSpec[];
  readonly pools: readonly WaterPoolSpec[];
  readonly palette: WaterPalette;
  /** Metres of depth at which the water is fully deep-coloured. */
  readonly deepDepth: number;
}

/**
 * Per-region mood values that drive the sky dome (gradient + sun + drifting clouds), the screen-space height fog and the
 * final color grade pass. The legacy `background` is the flat colour the sky shader falls back to when the dome is hidden
 * (e.g. inside a closed structure); `fogNear`/`fogFar` remain the linear `three.Fog` exposed to the establishing-shot
 * planner and to the Orun presentation easing (the height-fog pass is layered on top and gives the regional mood).
 */
export interface SkyProfile {
  /** Top-of-sky colour at the zenith. */
  readonly zenith: number;
  /** Horizon band colour (where the sky meets the terrain). */
  readonly horizon: number;
  /** Colour rendered below the horizon (bowl beneath the terrain ring); usually a darker horizon tint. */
  readonly ground: number;
  /** Sun-direction angular half-width of the visible disc, radians. */
  readonly sunDiscSize: number;
  /** Sun-disc body colour. */
  readonly sunDiscColor: number;
  /** Glow halo size (radians); the halo fades between sunDiscSize and sunGlowSize. */
  readonly sunGlowSize: number;
  /** Sun glow halo colour (the bloom-friendly in-scatter behind the disc). */
  readonly sunGlowColor: number;
  /** Cloud colour blended over the dome; near white for midday, warm for sunset, blue for moonlit. */
  readonly cloudColor: number;
  /** 0..1 cloud coverage. */
  readonly cloudCoverage: number;
  /** Drift speed multiplier on the cloud-noise world-clock (the dome freezes drift under reduced motion). */
  readonly cloudSpeed: number;
}

/**
 * Screen-space height fog layered onto the HDR scene buffer before the grade pass. The base linear `three.Fog` keeps the
 * establishing-shot near/far ease; the height-fog pass fades the air with altitude so deep hollows stay readable while
 * hilltops stay clear. Density and falloff are tuned per region; the sun tint lets fog lift a warm/cool hue toward the sun.
 */
export interface HeightFogProfile {
  readonly color: number;
  /** Exponential density (0..1, exponent base `-density*dist*falloff`). */
  readonly density: number;
  /** Multiplier on `(cameraY - targetY)` in the height falloff. 0 = uniform, higher = clearer up high. */
  readonly falloff: number;
  /** Mix 0..1 between `color` and `sunTintColor` in the sun direction. */
  readonly sunTint: number;
  /** Sun-direction in-scatter tint; defaults to the profile sun colour. */
  readonly sunTintColor: number;
  /** 0..1 vertical-pooling strength: 0 = uniform, 1 = pools entirely at the bottom of the frame. */
  readonly groundBias?: number;
  /** Bottom-N share of the frame kept nearly fog-free (keeps the play area at full contrast). */
  readonly nearFloor?: number;
}

/**
 * Per-region colour grade pack applied in the final pre-output pass: lift/gamma/gain (linear HDR), saturation,
 * split-toning warm-highlight/cool-shadow and a soft vignette. All entries are non-negative; the pass leaves the image
 * unchanged when the grade pack is undefined.
 */
export interface RegionGradeProfile {
  readonly lift: readonly [number, number, number];
  readonly gamma: readonly [number, number, number];
  readonly gain: readonly [number, number, number];
  readonly saturation: number;
  /** Warm highlight tint (added to highlight luminance in linear HDR). */
  readonly warmHighlight: readonly [number, number, number];
  /** Cool shadow tint (added to shadow luminance in linear HDR). */
  readonly coolShadow: readonly [number, number, number];
  /** 0..1 vignette strength. */
  readonly vignette: number;
}

/** 0..1 absolute strength of the screen-space light shafts (god rays) for this region. 0 disables the pass. */
export type LightShaftsStrength = number;

export interface AtmosphereProfile {
  readonly background: number;
  readonly fogColor: number;
  readonly fogNear: number;
  readonly fogFar: number;
  readonly hemisphereSky: number;
  readonly hemisphereGround: number;
  readonly hemisphereIntensity: number;
  readonly sunColor: number;
  readonly sunIntensity: number;
  readonly fillColor: number;
  readonly fillIntensity: number;
  /** Light position relative to its target (the focused player). */
  readonly sunOffset: Vec3;
  readonly shadowHalfWidth: number;
  readonly shadowMapSize: number;
  /** Per-region sky dome values; falls back to defaults when undefined. */
  readonly sky?: SkyProfile;
  /** Per-region height-fog values; falls back to no extra pass when undefined. */
  readonly heightFog?: HeightFogProfile;
  /** Per-region colour grade; falls back to identity when undefined. */
  readonly grade?: RegionGradeProfile;
  /** Light-shaft strength (0..1). 0 or undefined disables the screen-space shafts pass for this region. */
  readonly lightShafts?: LightShaftsStrength;
}


/** A per-region visual feature built on the ground (waterfall, drifting leaves, light shafts); animated from the world clock. */
export interface GroundFeature {
  readonly group: Object3D;
  update(worldTimeSeconds: number, focus: Readonly<Vec3> | undefined): void;
  /** Fewer / simpler particles for the Reduced Motion and Reduced Effects settings. */
  setReducedEffects(reduced: boolean): void;
  dispose(): void;
}

export interface FeatureContext {
  readonly region: RegionDefinition;
  readonly field: TerrainField;
  /** Unit direction from the ground towards the sun. */
  readonly sunDirection: Vector3;
}
