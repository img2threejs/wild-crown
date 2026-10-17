import type { BiomeProfile, ClutterRecipe, GroundLayerSpec, UnderstoryProfile } from './BiomeProfile';
import { createCanopyAtmosphere } from './CanopyAtmosphere';
import { CANOPY_BOUNDARY_ROCK_ID_PREFIX } from './CanopyBoundary';
import { canopyBackdrop, CANOPY_SUMMITS } from './CanopyMassif';
import { CANOPY_CARVE, CANOPY_WATER } from './CanopyRiver';
import { createCanopyWaterfall } from './CanopyWaterfall';
import { smoothstep, valueNoise } from './GroundNoise';

const LAYERS: readonly GroundLayerSpec[] = [
  { id: 'mud_forest', metersPerTile: 2.35, tint: [1.4, 1.34, 1.2] },
  { id: 'mossy_rock', metersPerTile: 3.0, tint: [0.5, 0.92, 0.45] },
  { id: 'roots', metersPerTile: 1.67, tint: [0.66, 0.54, 0.42] },
  { id: 'leafy_grass', metersPerTile: 2.0, tint: [0.6, 0.78, 0.42] },
  { id: 'gray_rocks', metersPerTile: 1.8, tint: [1, 1, 1] },
];

const FERN_TINTS = [0xffffff, 0xd8f0c4, 0xa9d083] as const;
const LEAF_TINTS = [0xffffff, 0xcfe8b6, 0xa8cf8a] as const;
const STONE_TINTS = [0x666a5c, 0x555a4e, 0x74786a, 0x4a4e44] as const;
const MUSHROOM_TINTS = [0xffffff, 0xe3c9b4, 0xc7ab8e] as const;
const NO_EXCLUSION = (): boolean => false;

const CLUTTER: readonly ClutterRecipe[] = [
  {
    name: 'jungle-fern', tints: FERN_TINTS, tilt: 0.14, receiveShadow: true, sway: 'fern',
    scatters: [
      {
        // Dense fern carpet across the jungle floor, thinner on the trail and across walkable interiors.
        cell: 1.4, seed: 53,
        place: (c, out) => {
          const { x, z, h, rng, mask: m } = c;
          const patch = smoothstep(0.3, 0.65, valueNoise(x * 0.06, z * 0.06, 9));
          if (m.core > 0.05 || m.shoulder > 0.25 || h > c.near() * (0.3 + 0.7 * patch) * (1 - m.walk * 0.9) * (1 - 0.75 * m.interior) * (1 - 0.7 * m.rock)) return;
          const size = 0.95 + 0.7 * rng;
          out.push(x, c.field.sample(x, z) - 0.01, z, rng * Math.PI * 2, size, size * (1 + 0.5 * h), size, Math.floor(rng * 997));
        },
      },
      {
        // Undergrowth band hugging the walk-mesh edge: the route reads as cut through dense jungle.
        cell: 1.05, seed: 61,
        place: (c, out) => {
          const { x, z, h, rng, mask: m } = c;
          if (m.edge < 0.25 || m.core > 0.05 || h > m.edge * 0.95) return;
          const size = 1.0 + 0.7 * rng;
          out.push(x, c.field.sample(x, z) - 0.01, z, rng * Math.PI * 2, size, size * (1.05 + 0.5 * h), size, Math.floor(rng * 997));
        },
      },
    ],
  },
  {
    name: 'broadleaf', tints: LEAF_TINTS, tilt: 0.1, receiveShadow: true, sway: 'broadleaf',
    scatters: [{
      // Tall broad-leaved understory in patches, never on the trail or a walkable's interior.
      cell: 1.7, seed: 71,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        const patch = smoothstep(0.4, 0.72, valueNoise(x * 0.05 + 3, z * 0.05 + 3, 13));
        if (m.core > 0.02 || m.shoulder > 0.1 || m.interior > 0.1 || m.walk > 0.2 || h > c.near() * patch * (1 - m.rock) * (0.4 + 0.6 * m.edge + 0.6 * m.mud)) return;
        const size = 0.8 + 0.6 * rng;
        out.push(x, c.field.sample(x, z) - 0.02, z, rng * Math.PI * 2, size, size * (0.9 + 0.5 * h), size, Math.floor(rng * 997));
      },
    }],
  },
  {
    name: 'big-leaf', tints: LEAF_TINTS, tilt: 0.12, receiveShadow: true, sway: 'broadleaf',
    scatters: [{
      // Elephant-ear plants in the damp: wet banks, hollows and shaded moist ground.
      cell: 2.6, seed: 83,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        const damp = Math.max(smoothstep(0.7, 0.95, m.moisture), m.mud);
        if (m.core > 0.02 || m.interior > 0.1 || m.walk > 0.2 || m.rock > 0.3 || h > c.near() * damp * smoothstep(0.35, 0.7, valueNoise(x * 0.08, z * 0.08, 17))) return;
        const size = 0.9 + 0.6 * rng;
        out.push(x, c.field.sample(x, z) - 0.02, z, rng * Math.PI * 2, size, size, size, Math.floor(rng * 997));
      },
    }],
  },
  {
    name: 'log', tints: [0xffffff, 0xd8cdb8, 0xb8ac94], tilt: 0.08, receiveShadow: true, sway: undefined,
    scatters: [{
      // Fallen logs, lying on the ground, well off the route.
      cell: 6.5, seed: 97,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        if (m.core > 0.01 || m.walk > 0.05 || m.interior > 0.05 || m.rock > 0.2 || m.mud > 0.5 || h > c.near() * 0.55) return;
        const size = 0.8 + 0.6 * rng;
        out.push(x, c.field.sample(x, z) - 0.04, z, rng * Math.PI * 2, size, size, size, Math.floor(rng * 997));
      },
    }],
  },
  {
    name: 'root', tints: [0xffffff, 0xd9cdb6, 0xb9a98c], tilt: 0.12, receiveShadow: true, sway: undefined,
    scatters: [{
      // Surface roots arching out of the berm along the route's edges.
      cell: 2.2, seed: 101,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        if (m.edge < 0.2 || m.core > 0.01 || m.rock > 0.3 || h > m.edge * 0.5) return;
        const size = 0.7 + 0.8 * rng;
        out.push(x, c.field.sample(x, z) - 0.02, z, rng * Math.PI * 2, size, size * (0.8 + 0.6 * h), size, Math.floor(rng * 997));
      },
    }],
  },
  {
    name: 'mushroom', tints: MUSHROOM_TINTS, tilt: 0.25, receiveShadow: true, sway: undefined,
    scatters: [{
      cell: 1.8, seed: 41,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        const patch = valueNoise(x * 0.09, z * 0.09, 7);
        if (patch < 0.55 || m.moisture < 0.5 || m.core > 0.3 || m.walk > 0.7 || h > c.near() * 0.55) return;
        const size = 0.8 + 1.0 * rng;
        out.push(x, c.field.sample(x, z) - 0.005, z, rng * 40, size, size, size, Math.floor(rng * 997));
      },
    }],
  },
  {
    name: 'leaf-pile', tints: [0xffffff, 0xe8d9c8, 0xd2c2a2], tilt: 0.1, receiveShadow: false, sway: undefined,
    scatters: [{
      cell: 2.2, seed: 37,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        if (m.core > 0.2 || h > c.near() * (0.12 + 0.3 * m.walk + 0.3 * m.shoulder) * (0.5 + valueNoise(x * 0.2, z * 0.2, 5))) return;
        out.push(x, c.field.sample(x, z), z, rng * Math.PI * 2, 0.8 + 0.7 * h, 1, 0.8 + 0.7 * h, Math.floor(rng * 997));
      },
    }],
  },
];

const UNDERSTORY: UnderstoryProfile = {
  // Taller, denser grass than Greenwake: the same 12-tile pool, longer blades and a higher clump probability.
  grass: { bladeHeight: 0.62, heightScale: 1.25, densityScale: 1.1, base: 0x13300f, tip: 0x5f9a35, baseDry: 0x2c3a14, tipDry: 0x8fa043, cacheKey: 'canopy-grass' },
  excluded: NO_EXCLUSION,
  clutter: CLUTTER,
  trailDressing: { stoneTints: STONE_TINTS, glow: false },
  clutterNearFull: 18,
  clutterNearNone: 38,
};

/**
 * Whispering Canopy (playtest variant): a layered rainforest valley under a cliff massif. Dark humus and moss, a worn muddy trail
 * with roots, wet rock faces and river gravel; dense ferns, broadleaf and logs; a river through a gorge and a chasm; a humid
 * green-grey fog and warm light through the canopy.
 */
export const CANOPY_BIOME: BiomeProfile = {
  id: 'whispering-canopy',
  terrain: {
    maxMound: 1.5,
    maxDip: -0.45,
    bermMinHeight: 0.4,
    bermMaxHeight: 1.1,
    embankment: { slopeMin: 1.5, slopeMax: 2.5, minRun: 1.1, maxRun: 4.2, rock: 0.55 },
    summits: CANOPY_SUMMITS,
    backdrop: canopyBackdrop,
    // The playable route spans x −64…58, z −42…10; the camera looks towards −x, −z, so the far side gets the most ground.
    extent: { minX: -90, maxX: 70, minZ: -66, maxZ: 22 },
    refine: { flatOutside: 1.8, raisedOutside: 1.9 },
  },
  carve: CANOPY_CARVE,
  splat: {
    textureRoot: '/asset-source/textures/canopy',
    layers: LAYERS,
    rock: { layer: 1, scale: 1.25, tint: [0.62, 0.62, 0.56], roughness: 0.62 },
    bed: { layer: 4, scale: 1, tint: [0.4, 0.43, 0.38], roughness: 0.4 },
    mud: { layer: 0, scale: 1, tint: [0.62, 0.55, 0.45], roughness: 0.42 },
    rockSlopeStart: 0.8,
    rockSlopeFull: 1.5,
    rockOnOpenSlopes: true,
    depthShade: { top: 1, bottom: -4.5, strength: 0.4 },
    macroLow: [0.82, 0.9, 0.8],
    macroHigh: [1.12, 1.1, 0.95],
    strata: 0.7,
    dapple: { strength: 0.22, scale: 0.55, speed: 1 },
  },
  understory: UNDERSTORY,
  water: CANOPY_WATER,
  features: [createCanopyWaterfall, createCanopyAtmosphere],
  atmosphere: {
    background: 0x86a094,
    fogColor: 0x86a094,
    fogNear: 10,
    fogFar: 58,
    hemisphereSky: 0xa6c0b0,
    hemisphereGround: 0x4a4430,
    hemisphereIntensity: 1.3,
    sunColor: 0xffd59a,
    sunIntensity: 3.2,
    fillColor: 0x8fae94,
    fillIntensity: 0.42,
    sunOffset: { x: -34, y: 30, z: 12 },
    shadowHalfWidth: 22,
    shadowMapSize: 1536,
    sky: {
      // Humid morning; the canopy glows from a higher sun breaking through; cool fog bank sits at the horizon.
      zenith: 0x9bbac4,
      horizon: 0xd5e3d8,
      ground: 0x394a3a,
      sunDiscSize: 0.022,
      sunDiscColor: 0xfff0c8,
      sunGlowSize: 0.42,
      sunGlowColor: 0xfff2c8,
      cloudColor: 0xfafafa,
      cloudCoverage: 0.7,
      cloudSpeed: 0.6,
    },
    heightFog: {
      color: 0xcfdec5,
      density: 0.07,
      falloff: 0.15,
      sunTint: 0.7,
      sunTintColor: 0xfff2c8,
    },
    grade: {
      lift: [0.02, 0.03, 0.04],
      gamma: [0.99, 1.0, 1.02],
      gain: [1.02, 1.04, 1.04],
      saturation: 1.05,
      warmHighlight: [1.0, 0.92, 0.78],
      coolShadow: [0.55, 0.7, 0.85],
      vignette: 0.18,
    },
    lightShafts: 0.85,
  },
  boundaryRocks: { idPrefix: CANOPY_BOUNDARY_ROCK_ID_PREFIX, assetId: 'prop-canopy-cliff-rock', footprintRadius: 1.8 },
};
