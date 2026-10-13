import type { BiomeProfile, ClutterRecipe, GroundLayerSpec, UnderstoryProfile } from './BiomeProfile';
import { smoothstep, valueNoise } from './GroundNoise';
import { MISTVEIL_BOUNDARY_ROCK_ID_PREFIX } from './MistveilBoundary';
import { createMistveilAtmosphere } from './MistveilAtmosphere';
import { MISTVEIL_CARVE, MISTVEIL_EXTENT, MISTVEIL_WATER } from './MistveilWater';

/**
 * Splat layers (Poly Haven CC0, see `asset-source/textures/mistveil/<layer>/provenance.json`): 0 wet forest mud, 1 moss, 2 root-laced
 * trail core, 3 damp leaf mud (worn shoulder / undergrowth band and wet banks), 4 river-bed stones.
 */
const LAYERS: readonly GroundLayerSpec[] = [
  { id: 'mud_forest', metersPerTile: 2.35, tint: [0.78, 0.86, 0.8] },
  { id: 'mossy_rock', metersPerTile: 3.0, tint: [0.42, 0.9, 0.58] },
  { id: 'roots', metersPerTile: 1.67, tint: [0.56, 0.52, 0.5] },
  { id: 'brown_mud_leaves_01', metersPerTile: 1.9, tint: [0.62, 0.62, 0.58] },
  { id: 'gray_rocks', metersPerTile: 1.8, tint: [0.42, 0.42, 0.5] },
];

const FERN_TINTS = [0xdff0e8, 0xb9dcc8, 0x8fc4a2] as const;
const LEAF_TINTS = [0xdff0e8, 0xbfe0cc, 0x9cc8ae] as const;
const STONE_TINTS = [0x555d5a, 0x474e4c, 0x646c68, 0x3c4442] as const;
const MUSHROOM_TINTS = [0xffffff, 0xbfe8d8, 0x9fd8c4] as const;
const NO_EXCLUSION = (): boolean => false;
/** The foggy glade (Trial 2): luminous fungi crowd its floor and rim. */
const GLADE = { minX: -6, maxX: 26, minZ: -32, maxZ: -2 } as const;

const CLUTTER: readonly ClutterRecipe[] = [
  {
    name: 'jungle-fern', tints: FERN_TINTS, tilt: 0.14, receiveShadow: true, sway: 'fern',
    scatters: [
      {
        // Marsh ferns in patches across the damp floor, thinner on the trail and across walkable interiors.
        cell: 1.5, seed: 153,
        place: (c, out) => {
          const { x, z, h, rng, mask: m } = c;
          const patch = smoothstep(0.35, 0.7, valueNoise(x * 0.06, z * 0.06, 19));
          if (m.core > 0.05 || m.shoulder > 0.25 || h > c.near() * (0.25 + 0.6 * patch) * (1 - m.walk * 0.9) * (1 - 0.75 * m.interior) * (1 - 0.7 * m.rock)) return;
          const size = 0.9 + 0.6 * rng;
          out.push(x, c.field.sample(x, z) - 0.01, z, rng * Math.PI * 2, size, size * (1 + 0.45 * h), size, Math.floor(rng * 997));
        },
      },
      {
        // Undergrowth band hugging the walk-mesh edge: the route reads as cut through reeds and ferns.
        cell: 1.1, seed: 161,
        place: (c, out) => {
          const { x, z, h, rng, mask: m } = c;
          if (m.edge < 0.25 || m.core > 0.05 || h > m.edge * 0.9) return;
          const size = 0.95 + 0.6 * rng;
          out.push(x, c.field.sample(x, z) - 0.01, z, rng * Math.PI * 2, size, size * (1.05 + 0.45 * h), size, Math.floor(rng * 997));
        },
      },
    ],
  },
  {
    name: 'big-leaf', tints: LEAF_TINTS, tilt: 0.12, receiveShadow: true, sway: 'broadleaf',
    scatters: [{
      // Wetland arum and elephant-ear plants thronging the damp: wet banks, hollows and the margins of every pool.
      cell: 2.2, seed: 183,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        const damp = Math.max(smoothstep(0.55, 0.9, m.moisture), m.mud);
        if (m.core > 0.02 || m.interior > 0.1 || m.walk > 0.2 || m.rock > 0.3 || h > c.near() * damp * smoothstep(0.25, 0.6, valueNoise(x * 0.08, z * 0.08, 27))) return;
        const size = 0.9 + 0.7 * rng;
        out.push(x, c.field.sample(x, z) - 0.02, z, rng * Math.PI * 2, size, size, size, Math.floor(rng * 997));
      },
    }],
  },
  {
    name: 'log', tints: [0xb8c4b8, 0x98a698, 0x7f8f84], tilt: 0.08, receiveShadow: true, sway: undefined,
    scatters: [{
      // Drowned logs, lying in the damp well off the route.
      cell: 6, seed: 197,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        if (m.core > 0.01 || m.walk > 0.05 || m.interior > 0.05 || m.rock > 0.2 || h > c.near() * (0.35 + 0.3 * m.mud)) return;
        const size = 0.8 + 0.6 * rng;
        out.push(x, c.field.sample(x, z) - 0.04, z, rng * Math.PI * 2, size, size, size, Math.floor(rng * 997));
      },
    }],
  },
  {
    name: 'root', tints: [0xc8cfc4, 0xa7b0a4, 0x8a9588], tilt: 0.12, receiveShadow: true, sway: undefined,
    scatters: [{
      // Surface roots arching out of the banks along the route's edges.
      cell: 2.0, seed: 201,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        if (m.edge < 0.2 || m.core > 0.01 || m.rock > 0.3 || h > m.edge * 0.55) return;
        const size = 0.7 + 0.8 * rng;
        out.push(x, c.field.sample(x, z) - 0.02, z, rng * Math.PI * 2, size, size * (0.8 + 0.6 * h), size, Math.floor(rng * 997));
      },
    }],
  },
  {
    name: 'mushroom', tints: MUSHROOM_TINTS, tilt: 0.25, receiveShadow: true, sway: undefined,
    scatters: [
      {
        // Luminous fungi in damp patches across the wetland.
        cell: 1.7, seed: 141,
        place: (c, out) => {
          const { x, z, h, rng, mask: m } = c;
          const patch = valueNoise(x * 0.09, z * 0.09, 17);
          if (patch < 0.5 || m.moisture < 0.45 || m.core > 0.3 || m.walk > 0.7 || h > c.near() * 0.6) return;
          const size = 0.8 + 1.0 * rng;
          out.push(x, c.field.sample(x, z) - 0.005, z, rng * 40, size, size, size, Math.floor(rng * 997));
        },
      },
      {
        // The foggy glade: clusters of glowing fungi across the floor and rim, never on the trail core.
        cell: 1.6, seed: 147,
        place: (c, out) => {
          const { x, z, h, rng, mask: m } = c;
          if (x < GLADE.minX || x > GLADE.maxX || z < GLADE.minZ || z > GLADE.maxZ || m.core > 0.05 || h > 0.42 + 0.3 * m.edge) return;
          const size = 0.9 + 1.1 * rng;
          out.push(x, c.field.sample(x, z) - 0.005, z, rng * 40, size, size, size, Math.floor(rng * 997));
        },
      },
    ],
  },
];

const UNDERSTORY: UnderstoryProfile = {
  // Tall, wet, blue-green grass: the same 12-tile pool as the other biomes, in a cooler palette.
  grass: { bladeHeight: 0.6, heightScale: 1.2, densityScale: 1.0, base: 0x112b24, tip: 0x5d9482, baseDry: 0x2a3a2c, tipDry: 0x86a082, cacheKey: 'mistveil-grass' },
  excluded: NO_EXCLUSION,
  clutter: CLUTTER,
  // Glowing fungi mark the way along the trail ribbons through the fog.
  trailDressing: { stoneTints: STONE_TINTS, glow: true },
  clutterNearFull: 18,
  clutterNearNone: 38,
};

/**
 * Mistveil Basin (playtest variant): a drowned wetland under dense low fog. Dark wet mud and moss, root-laced causeways, many
 * shallow murky pools and a river of purple-black Black Sap along the camera-far side; marsh ferns, big-leaved wetland plants,
 * drowned logs and luminous fungi; cool teal light, drifting mist and fireflies.
 */
export const MISTVEIL_BIOME: BiomeProfile = {
  id: 'mistveil-basin',
  terrain: {
    maxMound: 0.7,
    maxDip: -0.4,
    bermMinHeight: 0.25,
    bermMaxHeight: 0.7,
    embankment: { slopeMin: 1.2, slopeMax: 2.2, minRun: 1.1, maxRun: 3.6, rock: 0.3 },
    summits: [],
    backdrop: undefined,
    // The playable route spans x -56...102, z -28...-4; the camera looks towards -x, -z, so the far side gets the most ground.
    extent: MISTVEIL_EXTENT,
    refine: { flatOutside: 1.4, raisedOutside: 1.9 },
  },
  carve: MISTVEIL_CARVE,
  splat: {
    textureRoot: '/asset-source/textures/mistveil',
    layers: LAYERS,
    rock: { layer: 1, scale: 1.25, tint: [0.5, 0.62, 0.56], roughness: 0.6 },
    bed: { layer: 4, scale: 1, tint: [0.3, 0.3, 0.36], roughness: 0.35 },
    mud: { layer: 3, scale: 1, tint: [0.38, 0.4, 0.38], roughness: 0.3 },
    rockSlopeStart: 0.9,
    rockSlopeFull: 1.6,
    rockOnOpenSlopes: false,
    depthShade: { top: 0.5, bottom: -2, strength: 0.35 },
    macroLow: [0.78, 0.9, 0.88],
    macroHigh: [1.05, 1.1, 1.02],
    strata: 0.2,
    // Slow drifting patches of light and shade: thin fog banks passing over the ground.
    dapple: { strength: 0.12, scale: 0.7, speed: 0.6 },
  },
  understory: UNDERSTORY,
  water: MISTVEIL_WATER,
  features: [createMistveilAtmosphere],
  atmosphere: {
    background: 0x6f9193,
    fogColor: 0x6f9193,
    fogNear: 22,
    fogFar: 80,
    hemisphereSky: 0xa9cccb,
    hemisphereGround: 0x2f3d3b,
    hemisphereIntensity: 1.35,
    sunColor: 0xcdeee6,
    sunIntensity: 2.2,
    fillColor: 0x6f9fb0,
    fillIntensity: 0.5,
    sunOffset: { x: -30, y: 34, z: 10 },
    shadowHalfWidth: 22,
    shadowMapSize: 1536,
  },
  boundaryRocks: { idPrefix: MISTVEIL_BOUNDARY_ROCK_ID_PREFIX, assetId: 'prop-mire-bank-rock', footprintRadius: 2 },
};
