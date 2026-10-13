import type { BiomeProfile, ClutterRecipe, GroundLayerSpec, UnderstoryProfile } from './BiomeProfile';
import { GROVE_BOUNDARY_ROCK_ID_PREFIX } from './GroveBoundary';
import { createGroveAtmosphere } from './GroveAtmosphere';
import { smoothstep, valueNoise } from './GroundNoise';
import { GROVE_CARVE, GROVE_WATER } from './GrovePond';
import { groveBackdrop } from './GroveTerrain';

/**
 * Splat layers reuse the five Poly Haven CC0 sets already shipped under `asset-source/textures/canopy` (no extra texture memory);
 * the tints grade them into a warm, golden-green meadow: sun-bleached grass for the litter layer, soft moss, a packed pale-earth
 * trail core, a warm worn shoulder and light river gravel for the pond bed.
 */
const LAYERS: readonly GroundLayerSpec[] = [
  { id: 'leafy_grass', metersPerTile: 2.1, tint: [0.84, 0.88, 0.44] },
  { id: 'mossy_rock', metersPerTile: 3.0, tint: [0.56, 0.8, 0.42] },
  { id: 'mud_forest', metersPerTile: 2.35, tint: [1.55, 1.38, 1.0] },
  { id: 'roots', metersPerTile: 1.67, tint: [0.86, 0.74, 0.48] },
  { id: 'gray_rocks', metersPerTile: 1.8, tint: [1, 0.97, 0.9] },
];

const FERN_TINTS = [0xffffff, 0xe6f2c8, 0xc2d98e] as const;
/** Blossom tints of the flowering understory: rose, cream, gold, soft lavender (the broadleaf recipe carries the flower heads). */
const BLOSSOM_TINTS = [0xffc2cf, 0xfff0cf, 0xffd36a, 0xe3c8f5, 0xffffff] as const;
const PETAL_TINTS = [0xffd0d8, 0xfff0d2, 0xffe3a0] as const;
const PEBBLE_TINTS = [0xcfc7ae, 0xb9b095, 0xe0d8c0] as const;
const STONE_TINTS = [0x8a8a76, 0x77785f, 0x9a9a84, 0x6c6c58] as const;
const NO_EXCLUSION = (): boolean => false;

const CLUTTER: readonly ClutterRecipe[] = [
  {
    name: 'fern', tints: FERN_TINTS, tilt: 0.12, receiveShadow: true, sway: 'fern',
    scatters: [
      {
        // Soft fern patches through the meadow, thinner on the trail and across the wide walkable interiors.
        cell: 1.6, seed: 53,
        place: (c, out) => {
          const { x, z, h, rng, mask: m } = c;
          const patch = smoothstep(0.4, 0.72, valueNoise(x * 0.06, z * 0.06, 9));
          if (m.core > 0.05 || m.shoulder > 0.25 || h > c.near() * patch * (1 - m.walk * 0.9) * (1 - 0.8 * m.interior) * (1 - 0.7 * m.rock)) return;
          const size = 0.85 + 0.6 * rng;
          out.push(x, c.field.sample(x, z) - 0.01, z, rng * Math.PI * 2, size, size * (1 + 0.4 * h), size, Math.floor(rng * 997));
        },
      },
      {
        // Undergrowth band hugging the walk-mesh edge: the glade reads as cut into a sheltering meadow.
        cell: 1.15, seed: 61,
        place: (c, out) => {
          const { x, z, h, rng, mask: m } = c;
          if (m.edge < 0.25 || m.core > 0.05 || h > m.edge * 0.85) return;
          const size = 0.9 + 0.6 * rng;
          out.push(x, c.field.sample(x, z) - 0.01, z, rng * Math.PI * 2, size, size * (1.05 + 0.4 * h), size, Math.floor(rng * 997));
        },
      },
    ],
  },
  {
    // Flowering understory: low blossom-tinted shrubs in drifts across the meadow, never on the trail or a walkable's interior.
    name: 'broadleaf', tints: BLOSSOM_TINTS, tilt: 0.1, receiveShadow: true, sway: 'broadleaf',
    scatters: [{
      cell: 1.5, seed: 71,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        const drift = smoothstep(0.45, 0.75, valueNoise(x * 0.07 + 3, z * 0.07 + 3, 13));
        if (m.core > 0.02 || m.shoulder > 0.1 || m.interior > 0.1 || m.walk > 0.2 || m.bed > 0.1 || h > c.near() * drift * (1 - m.rock) * (0.35 + 0.65 * m.edge)) return;
        const size = 0.6 + 0.5 * rng;
        out.push(x, c.field.sample(x, z) - 0.02, z, rng * Math.PI * 2, size, size * (0.85 + 0.4 * h), size, Math.floor(rng * 997));
      },
    }],
  },
  {
    // Fallen petals: soft rose and cream drifts along the trail shoulders and the pond's bank.
    name: 'leaf-pile', tints: PETAL_TINTS, tilt: 0.1, receiveShadow: false, sway: undefined,
    scatters: [{
      cell: 1.8, seed: 37,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        if (m.core > 0.2 || m.bed > 0.1 || h > c.near() * (0.1 + 0.3 * m.walk + 0.3 * m.shoulder + 0.2 * m.mud) * (0.5 + valueNoise(x * 0.2, z * 0.2, 5))) return;
        out.push(x, c.field.sample(x, z), z, rng * Math.PI * 2, 0.7 + 0.6 * h, 1, 0.7 + 0.6 * h, Math.floor(rng * 997));
      },
    }],
  },
  {
    name: 'pebble', tints: PEBBLE_TINTS, tilt: 0.35, receiveShadow: false, sway: undefined,
    scatters: [{
      cell: 0.9, seed: 11,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        if (m.core > 0.35 || m.bed > 0.2 || h > c.near() * (0.1 + 0.7 * m.shoulder + 0.1 * m.walk)) return;
        const size = 0.035 + 0.07 * rng * rng;
        out.push(x, c.field.sample(x, z) + size * 0.12, z, rng * 40, size, size * 0.55, size * (0.7 + 0.5 * h), Math.floor(rng * 997));
      },
    }],
  },
];

const UNDERSTORY: UnderstoryProfile = {
  // Longer, warmer grass than Greenwake with sun-bleached tips: a meadow, not a forest floor.
  grass: { bladeHeight: 0.6, heightScale: 1.2, densityScale: 1.05, base: 0x2a4a14, tip: 0xb4c15a, baseDry: 0x4a5a1c, tipDry: 0xd6c168, cacheKey: 'grove-grass' },
  excluded: NO_EXCLUSION,
  clutter: CLUTTER,
  trailDressing: { stoneTints: STONE_TINTS, glow: false },
  clutterNearFull: 18,
  clutterNearNone: 38,
};

/**
 * The Grove (playtest variant): a sheltered meadow sanctuary in warm late-afternoon light. Sun-bleached golden-green grass, a pale
 * packed-earth trail, a low mound for the young Heartroot and a calm pond beside it, soft swells of meadow far behind the route,
 * flowering shrubs and petals, drifting pollen and fireflies. The relief is gentle: no cliffs, no summits, no channels.
 */
export const GROVE_BIOME: BiomeProfile = {
  id: 'the-grove',
  terrain: {
    maxMound: 0.55,
    maxDip: -0.25,
    bermMinHeight: 0.2,
    bermMaxHeight: 0.6,
    embankment: { slopeMin: 1.5, slopeMax: 2.5, minRun: 1.1, maxRun: 4.2, rock: 0.2 },
    summits: [],
    backdrop: groveBackdrop,
    // The walk-mesh spans x -34.5…34, z -54…48; the camera looks towards -x, -z, so the far side gets the most ground.
    extent: { minX: -58, maxX: 50, minZ: -72, maxZ: 58 },
    refine: { flatOutside: 1.8, raisedOutside: 1.9 },
  },
  carve: GROVE_CARVE,
  splat: {
    textureRoot: '/asset-source/textures/canopy',
    layers: LAYERS,
    rock: { layer: 1, scale: 1.25, tint: [0.7, 0.74, 0.58], roughness: 0.6 },
    bed: { layer: 4, scale: 1, tint: [0.62, 0.6, 0.5], roughness: 0.4 },
    mud: { layer: 2, scale: 1, tint: [0.72, 0.64, 0.46], roughness: 0.45 },
    rockSlopeStart: 0.9,
    rockSlopeFull: 1.6,
    rockOnOpenSlopes: false,
    depthShade: { top: 0.5, bottom: -1.2, strength: 0.25 },
    macroLow: [0.92, 0.98, 0.78],
    macroHigh: [1.14, 1.1, 0.92],
    strata: 0.2,
    dapple: { strength: 0.12, scale: 0.45, speed: 0.6 },
  },
  understory: UNDERSTORY,
  water: GROVE_WATER,
  features: [createGroveAtmosphere],
  atmosphere: {
    background: 0xd3dca6,
    fogColor: 0xd3dca6,
    fogNear: 16,
    fogFar: 86,
    hemisphereSky: 0xe2ecb8,
    hemisphereGround: 0x5e5a30,
    hemisphereIntensity: 1.35,
    sunColor: 0xffc27a,
    sunIntensity: 3.4,
    fillColor: 0xa9c48d,
    fillIntensity: 0.5,
    sunOffset: { x: -36, y: 22, z: 8 },
    shadowHalfWidth: 24,
    shadowMapSize: 1536,
  },
  boundaryRocks: { idPrefix: GROVE_BOUNDARY_ROCK_ID_PREFIX, assetId: 'prop-greenwake-boulder-cluster', footprintRadius: 1.5 },
};
