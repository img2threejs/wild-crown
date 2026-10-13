import type { BiomeProfile, ClutterRecipe, GroundLayerSpec, UnderstoryProfile, WaterPlan } from './BiomeProfile';
import { smoothstep, valueNoise } from './GroundNoise';
import { createMoonpineAtmosphere } from './MoonpineAtmosphere';
import { MOONPINE_BOUNDARY_ROCK_ID_PREFIX } from './MoonpineBoundary';
import { createMoonpineIce } from './MoonpineIce';
import { moonpineBackdrop, MOONPINE_CARVE, MOONPINE_SUMMITS, onMoonpineIce } from './MoonpineTerrain';

/**
 * Poly Haven CC0 1k layers (asset-source/textures/moonpine/<id>/{diffuse,normal,arm}.jpg with provenance.json).
 * Layers 0-3 have fixed roles: snow cover (litter), a second snow (moss slot, so the whole off-trail ground is snow), pine needles
 * (trail core) and rocky trail (worn shoulder). Layer 4 serves the cliff and open-slope rock, the gorge bed and the frozen banks.
 */
const LAYERS: readonly GroundLayerSpec[] = [
  // Powder snow: tints lift the mid-grey Poly Haven snow to a bright, slightly blue white (final albedo 0xd9dce8 before light).
  { id: 'snow_cover', metersPerTile: 2.0, tint: [1.8, 1.9, 2.1] },
  // The "moss" slot is the second snow: a cooler, finer-grained drift that breaks up the first.
  { id: 'ice_bed', metersPerTile: 2.0, tint: [1.75, 1.85, 2.1] },
  { id: 'pine_needles', metersPerTile: 3.15, tint: [1.25, 1.2, 1.22] },
  { id: 'rocky_trail', metersPerTile: 2.0, tint: [0.85, 0.95, 1.1] },
  // Cliff rock, gorge bed and frozen banks: layer 4 takes no layer tint; the rock, bed and mud grades below make the brown Poly Haven rock cold blue-grey.
  { id: 'cold_rock', metersPerTile: 2.7, tint: [1, 1, 1] },
];

/** Dark frost-shattered stones plus pale snow-capped boulders: the pebble mesh is white, so the final colour is exactly the tint. */
const PEBBLE_TINTS = [0x59606a, 0x4a515b, 0x6b727c, 0xe6eef7, 0xd5e0ee, 0xc4d2e3, 0xb8c6d8] as const;
const STONE_TINTS = [0x707883, 0x5e6671, 0x838b96, 0x4f5761] as const;
/** Fallen pine branches and half-buried roots: the twig mesh is white too, so the tint is the final grey-brown bark. */
const TWIG_TINTS = [0x3a2e24, 0x46382b, 0x4a4038, 0x5b5047] as const;
/** Needle drifts: the shared leaf-pile mesh carries warm brown vertex colours; the cool tints below grade them to dull grey-brown needles. */
const NEEDLE_TINTS = [0x8fa6c0, 0x9aa9ba, 0xa9b4c2] as const;

const CLUTTER: readonly ClutterRecipe[] = [
  {
    name: 'pebble', tints: PEBBLE_TINTS, tilt: 0.35, receiveShadow: false, sway: undefined,
    scatters: [
      {
        // Frost-shattered stones along the worn shoulder of the trail.
        cell: 0.9, seed: 12,
        place: (c, out) => {
          const { x, z, h, rng, mask: m } = c;
          if (onMoonpineIce(x, z) || m.core > 0.35 || h > c.near() * (0.12 + 0.8 * m.shoulder + 0.1 * m.walk)) return;
          const size = 0.04 + 0.08 * rng * rng;
          out.push(x, c.field.sample(x, z) + size * 0.12, z, rng * 40, size, size * 0.55, size * (0.7 + 0.5 * h), Math.floor(rng * 997));
        },
      },
      {
        // Snow-capped boulders scattered over the open ground, thicker towards the berm band.
        cell: 3.2, seed: 15,
        place: (c, out) => {
          const { x, z, h, rng, mask: m } = c;
          if (onMoonpineIce(x, z) || m.core > 0.02 || m.walk > 0.1 || m.interior > 0.1 || m.rock > 0.3 || h > c.near() * (0.18 + 0.4 * m.edge) * smoothstep(0.35, 0.65, valueNoise(x * 0.09, z * 0.09, 21))) return;
          const size = 0.14 + 0.3 * rng * rng;
          out.push(x, c.field.sample(x, z) + size * 0.12, z, rng * 40, size * 1.4, size * 0.7, size, Math.floor(rng * 997));
        },
      },
    ],
  },
  {
    name: 'twig', tints: TWIG_TINTS, tilt: 0.2, receiveShadow: false, sway: undefined,
    scatters: [
      {
        // Dark fallen pine twigs on the snow, away from the trail core.
        cell: 1.5, seed: 24,
        place: (c, out) => {
          const { x, z, h, rng, mask: m } = c;
          if (onMoonpineIce(x, z) || m.core > 0.3 || h > c.near() * (0.2 + 0.25 * m.walk)) return;
          out.push(x, c.field.sample(x, z) + 0.01, z, rng * Math.PI * 2, 0.35 + 0.55 * h, 0.012 + 0.014 * rng, 0.012 + 0.014 * rng, Math.floor(rng * 997));
        },
      },
      {
        // Fallen pine branches half buried in the snow, well off the route.
        cell: 5, seed: 98,
        place: (c, out) => {
          const { x, z, h, rng, mask: m } = c;
          if (onMoonpineIce(x, z) || m.core > 0.01 || m.walk > 0.05 || m.interior > 0.05 || m.rock > 0.2 || m.mud > 0.5 || h > c.near() * 0.5) return;
          out.push(x, c.field.sample(x, z) + 0.02, z, rng * Math.PI * 2, 1.1 + 0.9 * h, 0.035 + 0.02 * rng, 0.035 + 0.02 * rng, Math.floor(rng * 997));
        },
      },
      {
        // Half-buried roots along the berm band, in the same twig draw call.
        cell: 1.3, seed: 68,
        place: (c, out) => {
          const { x, z, h, rng, mask: m } = c;
          if (onMoonpineIce(x, z) || m.edge < 0.45 || m.core > 0.05 || h > 0.22) return;
          out.push(x, c.field.sample(x, z) - 0.012, z, rng * Math.PI * 2, 0.5 + 0.6 * rng, 0.05 + 0.04 * h, 0.05 + 0.04 * h, Math.floor(rng * 997));
        },
      },
    ],
  },
  {
    name: 'leaf-pile', tints: NEEDLE_TINTS, tilt: 0.1, receiveShadow: false, sway: undefined,
    scatters: [{
      // Drifts of fallen pine needles, thicker beside the trail and under the pines on the berm.
      cell: 2.3, seed: 38,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        if (onMoonpineIce(x, z) || m.core > 0.2 || h > c.near() * (0.1 + 0.35 * m.walk + 0.3 * m.shoulder + 0.25 * m.edge) * (0.5 + valueNoise(x * 0.2, z * 0.2, 5))) return;
        out.push(x, c.field.sample(x, z), z, rng * Math.PI * 2, 0.8 + 0.7 * h, 1, 0.8 + 0.7 * h, Math.floor(rng * 997));
      },
    }],
  },
];

const UNDERSTORY: UnderstoryProfile = {
  // Sparse, short, frost-covered winter grass (pale blue-grey blades tipped white): the same 12-tile pool at 30 % clump probability.
  grass: { bladeHeight: 0.3, heightScale: 0.9, densityScale: 0.3, base: 0x7d8a88, tip: 0xe4ecee, baseDry: 0x8c8a7c, tipDry: 0xeeece4, cacheKey: 'moonpine-grass-frost' },
  excluded: onMoonpineIce,
  clutter: CLUTTER,
  trailDressing: { stoneTints: STONE_TINTS, glow: false },
  clutterNearFull: 18,
  clutterNearNone: 38,
};

/** The lake is drawn by the ice feature and the gorge creek is frozen: no open water anywhere on the ridge. */
const WATER: WaterPlan = {
  name: 'moonpine-water',
  strips: [],
  pools: [],
  palette: { shallow: 0x7fa0b8, deep: 0x24465e, sky: 0x9db8cf, sun: 0xdde9ff, foam: 0xe6f0fa },
  deepDepth: 0.3,
};

/**
 * Moonpine Ridge (playtest variant): a snowy pine ridge at the foot of cold mountains. Powder snow over rock and pine needles,
 * a worn needle trail, frost-shattered stones and frosted ferns; a frozen lake with a glossy ice sheet and its walkable shelf,
 * a deep gorge with a frozen creek under the log bridge, the temple massif and the mountain walls behind the route; snow falling
 * through cold blue fog under a low pale sun.
 */
export const MOONPINE_BIOME: BiomeProfile = {
  id: 'moonpine-ridge',
  terrain: {
    maxMound: 1.3,
    maxDip: -0.4,
    bermMinHeight: 0.4,
    bermMaxHeight: 1.0,
    embankment: { slopeMin: 1.4, slopeMax: 2.4, minRun: 1.1, maxRun: 4.4, rock: 0.6 },
    summits: MOONPINE_SUMMITS,
    backdrop: moonpineBackdrop,
    // The playable route spans x -72…58, z -33…19; the camera looks towards -x, -z, so the far side gets the most ground.
    extent: { minX: -90, maxX: 70, minZ: -66, maxZ: 26 },
    refine: { flatOutside: 1.8, raisedOutside: 1.9 },
  },
  carve: MOONPINE_CARVE,
  splat: {
    textureRoot: '/asset-source/textures/moonpine',
    layers: LAYERS,
    rock: { layer: 4, scale: 1.2, tint: [0.5, 0.8, 2.0], roughness: 0.7 },
    bed: { layer: 4, scale: 1, tint: [0.45, 0.75, 2.0], roughness: 0.3 },
    mud: { layer: 4, scale: 1, tint: [0.4, 0.7, 1.8], roughness: 0.45 },
    rockSlopeStart: 1.0,
    rockSlopeFull: 1.9,
    rockOnOpenSlopes: true,
    depthShade: { top: 0.5, bottom: -6, strength: 0.45 },
    macroLow: [0.86, 0.9, 0.98],
    macroHigh: [1.08, 1.08, 1.1],
    strata: 0.5,
    // Light and shade drifting through the pines.
    dapple: { strength: 0.12, scale: 0.6, speed: 0.6 },
  },
  understory: UNDERSTORY,
  water: WATER,
  features: [createMoonpineIce, createMoonpineAtmosphere],
  atmosphere: {
    background: 0x93a8bc,
    fogColor: 0x9db3c7,
    fogNear: 12,
    fogFar: 62,
    hemisphereSky: 0xb9d0ea,
    hemisphereGround: 0x5d6878,
    hemisphereIntensity: 1.25,
    sunColor: 0xd6e6ff,
    sunIntensity: 2.6,
    fillColor: 0x8fa6c2,
    fillIntensity: 0.4,
    sunOffset: { x: -36, y: 20, z: 14 },
    shadowHalfWidth: 22,
    shadowMapSize: 1536,
  },
  boundaryRocks: { idPrefix: MOONPINE_BOUNDARY_ROCK_ID_PREFIX, assetId: 'prop-snow-ridge-rock', footprintRadius: 2.5 },
};
