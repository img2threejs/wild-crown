import type { BiomeProfile, ClutterRecipe, GroundCarve, GroundLayerSpec, UnderstoryProfile, WaterPlan } from './BiomeProfile';
import { BAMBOO_BOUNDARY_ROCK_ID_PREFIX } from './BambooBoundary';
import { smoothstep, valueNoise } from './GroundNoise';

/**
 * Blood Bamboo Valley reuses the five Poly Haven CC0 sets already shipped under `asset-source/textures/canopy` (no extra
 * texture memory), graded into warm red-ochre earth: cut-bamboo litter for the litter layer, dry moss, a packed rust-brown trail
 * core, a worn shoulder and pale river gravel.
 */
const LAYERS: readonly GroundLayerSpec[] = [
  { id: 'leafy_grass', metersPerTile: 2.2, tint: [1.15, 0.88, 0.52] },
  { id: 'mossy_rock', metersPerTile: 3.0, tint: [0.78, 0.74, 0.46] },
  { id: 'mud_forest', metersPerTile: 2.35, tint: [1.65, 1.15, 0.82] },
  { id: 'roots', metersPerTile: 1.67, tint: [1.0, 0.7, 0.46] },
  { id: 'gray_rocks', metersPerTile: 1.8, tint: [1.02, 0.94, 0.84] },
];

const FERN_TINTS = [0xffffff, 0xe3d9a6, 0xc4b274] as const;
const LEAF_TINTS = [0xf2d9a8, 0xd9a971, 0xb57a49] as const;
const STONE_TINTS = [0x7a6e5a, 0x6a5f4d, 0x8a7e68, 0x5d5444] as const;
const NO_EXCLUSION = (): boolean => false;

const CLUTTER: readonly ClutterRecipe[] = [
  {
    // Low ferns thinning out across the open floor: broad, clear sight lines for the camp and the den.
    name: 'fern', tints: FERN_TINTS, tilt: 0.12, receiveShadow: true, sway: 'fern',
    scatters: [
      {
        cell: 1.7, seed: 53,
        place: (c, out) => {
          const { x, z, h, rng, mask: m } = c;
          const patch = smoothstep(0.42, 0.72, valueNoise(x * 0.06, z * 0.06, 9));
          if (m.core > 0.05 || m.shoulder > 0.25 || h > c.near() * patch * (1 - m.walk * 0.9) * (1 - 0.85 * m.interior) * (1 - 0.7 * m.rock)) return;
          const size = 0.8 + 0.5 * rng;
          out.push(x, c.field.sample(x, z) - 0.01, z, rng * Math.PI * 2, size, size * (1 + 0.4 * h), size, Math.floor(rng * 997));
        },
      },
      {
        // Undergrowth band hugging the walk-mesh edge.
        cell: 1.2, seed: 61,
        place: (c, out) => {
          const { x, z, h, rng, mask: m } = c;
          if (m.edge < 0.25 || m.core > 0.05 || h > m.edge * 0.8) return;
          const size = 0.85 + 0.5 * rng;
          out.push(x, c.field.sample(x, z) - 0.01, z, rng * Math.PI * 2, size, size * (1.05 + 0.4 * h), size, Math.floor(rng * 997));
        },
      },
    ],
  },
  {
    // Fallen bamboo leaves: warm drifts along the trail shoulders.
    name: 'leaf-pile', tints: LEAF_TINTS, tilt: 0.1, receiveShadow: false, sway: undefined,
    scatters: [{
      cell: 1.9, seed: 37,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        if (m.core > 0.2 || h > c.near() * (0.14 + 0.35 * m.walk + 0.3 * m.shoulder) * (0.5 + valueNoise(x * 0.2, z * 0.2, 5))) return;
        out.push(x, c.field.sample(x, z), z, rng * Math.PI * 2, 0.8 + 0.7 * h, 1, 0.8 + 0.7 * h, Math.floor(rng * 997));
      },
    }],
  },
  {
    name: 'pebble', tints: STONE_TINTS, tilt: 0.35, receiveShadow: false, sway: undefined,
    scatters: [{
      cell: 0.9, seed: 11,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        if (m.core > 0.35 || m.bed > 0.2 || h > c.near() * (0.1 + 0.6 * m.shoulder + 0.1 * m.walk)) return;
        const size = 0.035 + 0.07 * rng * rng;
        out.push(x, c.field.sample(x, z) + size * 0.12, z, rng * 40, size, size * 0.55, size * (0.7 + 0.5 * h), Math.floor(rng * 997));
      },
    }],
  },
  {
    // Snapped bamboo stems lying off the route.
    name: 'log', tints: [0xe0c890, 0xc2a566, 0xa88a4c], tilt: 0.08, receiveShadow: true, sway: undefined,
    scatters: [{
      cell: 6, seed: 97,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        if (m.core > 0.01 || m.walk > 0.05 || m.interior > 0.05 || m.rock > 0.2 || h > c.near() * 0.5) return;
        const size = 0.6 + 0.5 * rng;
        out.push(x, c.field.sample(x, z) - 0.04, z, rng * Math.PI * 2, size, size, size, Math.floor(rng * 997));
      },
    }],
  },
];

const UNDERSTORY: UnderstoryProfile = {
  // Short, dry, straw-and-russet grass: warm ground cover, never a meadow that hides a trap or a telegraph.
  grass: { bladeHeight: 0.42, heightScale: 0.9, densityScale: 0.7, base: 0x4a3a1c, tip: 0xc9a85a, baseDry: 0x6a4e26, tipDry: 0xd8b66c, cacheKey: 'bamboo-grass' },
  excluded: NO_EXCLUSION,
  clutter: CLUTTER,
  trailDressing: { stoneTints: STONE_TINTS, glow: false },
  clutterNearFull: 15,
  clutterNearNone: 32,
};

/** The valley floor is dry: no channel, no pool; the creek the Canopy hands over lies upstream. */
const NO_CARVE: GroundCarve = {
  lipSmooth: 0, crestStart: 0, crestEnd: 0, bedNoise: 0,
  surfaceHeight: () => 1e6,
  insideBand: () => false,
  membership: () => 0,
  wetness: () => 0,
  waterLevel: () => -Infinity,
};
const NO_WATER: WaterPlan = {
  name: 'bamboo-water', strips: [], pools: [],
  palette: { shallow: 0x7fa08a, deep: 0x2c4a3e, sky: 0xb7a98a, sun: 0xffd9a0, foam: 0xf0e6cf },
  deepDepth: 0.3,
};

/**
 * Blood Bamboo Valley (Act I chapter map): terraced bamboo slopes under a warm red canopy light. Rust-brown packed earth, straw
 * grass, cut-bamboo litter and pale stones; broad low floors around the hunter camp and the den so telegraphs, traps and the boss
 * stay readable; restrained amber fog, no weather system and no transparent leaf layer in front of the combat camera. The tall
 * bamboo stands behind the route (BambooBoundary), the camera-facing edges stay low.
 */
export const BAMBOO_BIOME: BiomeProfile = {
  id: 'blood-bamboo-valley',
  terrain: {
    maxMound: 0.8,
    maxDip: -0.3,
    bermMinHeight: 0.3,
    bermMaxHeight: 0.8,
    embankment: { slopeMin: 1.4, slopeMax: 2.4, minRun: 1.1, maxRun: 4.4, rock: 0.4 },
    summits: [],
    backdrop: undefined,
    // The walk-mesh spans x -68…68, z -43…45; the camera looks towards -x, -z, so the far side gets the most ground.
    extent: { minX: -92, maxX: 84, minZ: -70, maxZ: 62 },
    refine: { flatOutside: 1.6, raisedOutside: 1.8 },
  },
  carve: NO_CARVE,
  splat: {
    textureRoot: '/asset-source/textures/canopy',
    layers: LAYERS,
    rock: { layer: 4, scale: 1.2, tint: [0.88, 0.8, 0.7], roughness: 0.6 },
    bed: { layer: 4, scale: 1, tint: [0.7, 0.62, 0.5], roughness: 0.4 },
    mud: { layer: 2, scale: 1, tint: [0.85, 0.62, 0.45], roughness: 0.4 },
    rockSlopeStart: 0.9,
    rockSlopeFull: 1.6,
    rockOnOpenSlopes: false,
    depthShade: { top: 0.5, bottom: -2, strength: 0.2 },
    macroLow: [0.96, 0.86, 0.74],
    macroHigh: [1.14, 1.04, 0.88],
    strata: 0.25,
    dapple: { strength: 0.1, scale: 0.5, speed: 0.6 },
  },
  understory: UNDERSTORY,
  water: NO_WATER,
  features: [],
  atmosphere: {
    background: 0xc7a47a,
    fogColor: 0xc9a77c,
    fogNear: 18,
    fogFar: 92,
    hemisphereSky: 0xe8c090,
    hemisphereGround: 0x5a3c26,
    hemisphereIntensity: 1.3,
    sunColor: 0xffb56e,
    sunIntensity: 3.3,
    fillColor: 0xb98a62,
    fillIntensity: 0.45,
    sunOffset: { x: -34, y: 24, z: 10 },
    shadowHalfWidth: 24,
    shadowMapSize: 1536,
    sky: {
      // Blood-red/amber sunset; smoke tints the low sky and the dome pulls deep crimson overhead.
      zenith: 0x4a1c20,
      horizon: 0xa83820,
      ground: 0x1a0a0a,
      sunDiscSize: 0.028,
      sunDiscColor: 0xff7a4a,
      sunGlowSize: 0.35,
      sunGlowColor: 0xd04020,
      cloudColor: 0x9a3520,
      cloudCoverage: 0.75,
      cloudSpeed: 0.4,
    },
    heightFog: {
      color: 0x9a4a2a,
      density: 0.085,
      falloff: 0.1,
      sunTint: 0.9,
      sunTintColor: 0xd04a18,
    },
    grade: {
      lift: [0.06, 0.02, 0.0],
      gamma: [1.06, 0.98, 0.94],
      gain: [1.08, 0.96, 0.9],
      saturation: 1.18,
      warmHighlight: [1.0, 0.5, 0.3],
      coolShadow: [0.4, 0.18, 0.12],
      vignette: 0.36,
    },
    lightShafts: 0.78,
  },
  boundaryRocks: { idPrefix: BAMBOO_BOUNDARY_ROCK_ID_PREFIX, assetId: 'prop-canopy-cliff-rock', footprintRadius: 1.8 },
};
