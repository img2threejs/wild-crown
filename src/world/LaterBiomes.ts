import type { BiomeProfile, ClutterRecipe, Extent, GroundLayerSpec, UnderstoryProfile, WaterPlan } from './BiomeProfile';
import { smoothstep, valueNoise } from './GroundNoise';

/**
 * Story-layout biome profiles for the later-act regions: Moonpine Ridge (snowy ridge ascent to the wolf temple and the summit),
 * Mistveil Basin (drowned wetland with the Black Sap river and Ghor's arena), Sunmane Expanse (open grassland stepping up through
 * the migration terraces to the High Crown), Refuge (the sheltered Grove-family sanctuary with the relocated services) and
 * Heartroot Hollow (root caverns beneath Erya with the Orun arena). They reuse the same Poly Haven CC0 PBR layer folders the
 * playtest biomes use and keep the existing RegionGround stack (no generic floating plates as final ground).
 *
 * These profiles do not replace the playtest Moonpine / Mistveil biomes: their texture roots, terrain extents, carves,
 * water plans and understory are the trial variants (frozen lake and gorge for Moonpine, the Black Sap river and pools for
 * Mistveil) and must not be applied to the chapter layouts. The trial surfaces keep their `moonpine-trial-` /
 * `mistveil-trial-` prefix; the chapter regions match the new `-story-` prefix entries below.
 */

// ---- shared ids and prefixes ----

/** Walk-surface id prefix that selects the Moonpine Ridge story profile (the chapter region's surface ids start with this). */
export const MOONPINE_STORY_SURFACE_PREFIX = 'moonpine-ridge-';
/** Walk-surface id prefix that selects the Mistveil Basin story profile. */
export const MISTVEIL_STORY_SURFACE_PREFIX = 'mistveil-basin-';
/** Walk-surface id prefix that selects the Sunmane Expanse story profile. */
export const SUNMANE_STORY_SURFACE_PREFIX = 'sunmane-expanse-';
/** Walk-surface id prefix that selects the Refuge story profile. */
export const REFUGE_STORY_SURFACE_PREFIX = 'refuge-';
/** Walk-surface id prefix that selects the Heartroot Hollow story profile. */
export const HOLLOW_STORY_SURFACE_PREFIX = 'heartroot-hollow-';

const MOONPINE_STORY_ID = 'moonpine-ridge-story';
const MISTVEIL_STORY_ID = 'mistveil-basin-story';
const SUNMANE_STORY_ID = 'sunmane-expanse-story';
const REFUGE_STORY_ID = 'refuge-story';
const HOLLOW_STORY_ID = 'heartroot-hollow-story';

// ---- Moonpine Ridge story ----

/**
 * Reuses the moonpine/snow layer set but tints slightly warmer (late-day sun behind the temple) so the chapter reads as the
 * warmer shoulder of the season the trial captures in deep midwinter. The ice/lake carve is dropped: the chapter never visits
 * the frozen lake; the new carve is a deep null (no carved channel) so the terrain honours the absolute-height polygons of the
 * ridge surfaces and never accidentally places the lake or the gorge inside the chapter layout.
 */
const MOONPINE_STORY_LAYERS: readonly GroundLayerSpec[] = [
  { id: 'snow_cover', metersPerTile: 2.0, tint: [1.85, 1.95, 2.15] },
  { id: 'ice_bed', metersPerTile: 2.0, tint: [1.78, 1.88, 2.1] },
  { id: 'pine_needles', metersPerTile: 3.15, tint: [1.3, 1.25, 1.25] },
  { id: 'rocky_trail', metersPerTile: 2.0, tint: [0.9, 0.95, 1.05] },
  { id: 'cold_rock', metersPerTile: 2.7, tint: [1, 1, 1] },
];
const MOONPINE_STORY_PEBBLE_TINTS = [0x5e6770, 0x4f5661, 0x6e757f, 0xe9eef6, 0xd9e2ec, 0xc8d4e2, 0xc0ccdb] as const;
const MOONPINE_STORY_STONE_TINTS = [0x737a85, 0x616872, 0x858d97, 0x525a64] as const;
const MOONPINE_STORY_TWIG_TINTS = [0x3a2e24, 0x46382b, 0x4a4038, 0x5b5047] as const;
const MOONPINE_STORY_NEEDLE_TINTS = [0x92a7be, 0x9dadbd, 0xabb7c4] as const;
const MOONPINE_STORY_NO_EXCLUSION = (): boolean => false;
const MOONPINE_STORY_CLUTTER: readonly ClutterRecipe[] = [
  {
    name: 'pebble', tints: MOONPINE_STORY_PEBBLE_TINTS, tilt: 0.35, receiveShadow: false, sway: undefined,
    scatters: [{
      // Frost-shattered stones along the worn shoulder, never on the trail core.
      cell: 0.9, seed: 12,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        if (m.core > 0.35 || h > c.near() * (0.12 + 0.8 * m.shoulder + 0.1 * m.walk)) return;
        const size = 0.04 + 0.08 * rng * rng;
        out.push(x, c.field.sample(x, z) + size * 0.12, z, rng * 40, size, size * 0.55, size * (0.7 + 0.5 * h), Math.floor(rng * 997));
      },
    }],
  },
  {
    name: 'twig', tints: MOONPINE_STORY_TWIG_TINTS, tilt: 0.2, receiveShadow: false, sway: undefined,
    scatters: [{
      // Dark fallen pine twigs along the trail edge.
      cell: 1.5, seed: 24,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        if (m.core > 0.3 || h > c.near() * (0.2 + 0.25 * m.walk)) return;
        out.push(x, c.field.sample(x, z) + 0.01, z, rng * Math.PI * 2, 0.35 + 0.55 * h, 0.012 + 0.014 * rng, 0.012 + 0.014 * rng, Math.floor(rng * 997));
      },
    }],
  },
  {
    name: 'leaf-pile', tints: MOONPINE_STORY_NEEDLE_TINTS, tilt: 0.1, receiveShadow: false, sway: undefined,
    scatters: [{
      // Pine needle drifts thickening beside the trail and under the pines on the berm.
      cell: 2.3, seed: 38,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        if (m.core > 0.2 || h > c.near() * (0.1 + 0.35 * m.walk + 0.3 * m.shoulder + 0.25 * m.edge) * (0.5 + valueNoise(x * 0.2, z * 0.2, 5))) return;
        out.push(x, c.field.sample(x, z), z, rng * Math.PI * 2, 0.8 + 0.7 * h, 1, 0.8 + 0.7 * h, Math.floor(rng * 997));
      },
    }],
  },
];
const MOONPINE_STORY_UNDERSTORY: UnderstoryProfile = {
  grass: { bladeHeight: 0.32, heightScale: 0.95, densityScale: 0.35, base: 0x828d8a, tip: 0xe6eef0, baseDry: 0x8f8d7e, tipDry: 0xefede4, cacheKey: 'moonpine-story-grass' },
  excluded: MOONPINE_STORY_NO_EXCLUSION,
  clutter: MOONPINE_STORY_CLUTTER,
  trailDressing: { stoneTints: MOONPINE_STORY_STONE_TINTS, glow: false },
  clutterNearFull: 18,
  clutterNearNone: 38,
};
/** The story region has no carved channel: the trial's Black Sap-free river and lake are not present here. */
const MOONPINE_STORY_NO_CARVE = {
  lipSmooth: 0, crestStart: 0, crestEnd: 0, bedNoise: 0,
  surfaceHeight: () => 1e6,
  insideBand: () => false,
  membership: () => 0,
  wetness: () => 0,
  waterLevel: () => -Infinity,
} as const;
const MOONPINE_STORY_WATER: WaterPlan = {
  name: 'moonpine-story-water', strips: [], pools: [],
  palette: { shallow: 0x82a4bb, deep: 0x28496a, sky: 0x9eb9d2, sun: 0xe0eafc, foam: 0xe8f0fa },
  deepDepth: 0.3,
};
const MOONPINE_STORY_EXTENT: Extent = { minX: -90, maxX: 90, minZ: -68, maxZ: 68 };

// ---- Mistveil Basin story ----

/**
 * Wet reed and moss story with cool teal light. The carve is shallow and wide (a standing-water plan is omitted: the chapter
 * basin only crosses the causeway and the Black Sap river downstream of the polluted source; the source seep and the trial
 * pools live in the playtest variant). Tints are a touch cooler than the trial so the chapter reads as the head of the marsh
 * in late autumn.
 */
const MISTVEIL_STORY_LAYERS: readonly GroundLayerSpec[] = [
  { id: 'mud_forest', metersPerTile: 2.35, tint: [0.74, 0.82, 0.76] },
  { id: 'mossy_rock', metersPerTile: 3.0, tint: [0.4, 0.86, 0.55] },
  { id: 'roots', metersPerTile: 1.67, tint: [0.52, 0.5, 0.48] },
  { id: 'brown_mud_leaves_01', metersPerTile: 1.9, tint: [0.58, 0.58, 0.55] },
  { id: 'gray_rocks', metersPerTile: 1.8, tint: [0.4, 0.4, 0.48] },
];
const MISTVEIL_STORY_FERN_TINTS = [0xdceee2, 0xb6d8c2, 0x8cbfa0] as const;
const MISTVEIL_STORY_LEAF_TINTS = [0xdceee2, 0xbce0c8, 0x99c5ab] as const;
const MISTVEIL_STORY_STONE_TINTS = [0x525a57, 0x444b49, 0x616965, 0x3a4240] as const;
const MISTVEIL_STORY_MUSHROOM_TINTS = [0xffffff, 0xbce8d8, 0x9cd8c4] as const;
const MISTVEIL_STORY_NO_EXCLUSION = (): boolean => false;
const MISTVEIL_STORY_CLUTTER: readonly ClutterRecipe[] = [
  {
    name: 'fern', tints: MISTVEIL_STORY_FERN_TINTS, tilt: 0.18, receiveShadow: true, sway: 'fern',
    scatters: [{
      // Marsh ferns along the damp banks.
      cell: 1.8, seed: 17,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        const damp = Math.max(smoothstep(0.55, 0.9, m.moisture), m.mud);
        if (m.core > 0.05 || m.interior > 0.1 || m.walk > 0.15 || m.rock > 0.3 || h > c.near() * damp * smoothstep(0.25, 0.6, valueNoise(x * 0.08, z * 0.08, 27))) return;
        const size = 0.8 + 0.7 * rng;
        out.push(x, c.field.sample(x, z) - 0.02, z, rng * Math.PI * 2, size, size, size, Math.floor(rng * 997));
      },
    }],
  },
  {
    name: 'big-leaf', tints: MISTVEIL_STORY_LEAF_TINTS, tilt: 0.12, receiveShadow: true, sway: 'broadleaf',
    scatters: [{
      // Arum and elephant-ear plants around the margins of any standing water and damp patches.
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
    name: 'root', tints: [0xc8cfc4, 0xa7b0a4, 0x8a9588], tilt: 0.12, receiveShadow: true, sway: undefined,
    scatters: [{
      // Surface roots arching out of the causeway banks.
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
    name: 'mushroom', tints: MISTVEIL_STORY_MUSHROOM_TINTS, tilt: 0.25, receiveShadow: true, sway: undefined,
    scatters: [{
      // Luminous fungi in damp patches away from the trail core.
      cell: 1.7, seed: 141,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        const patch = valueNoise(x * 0.09, z * 0.09, 17);
        if (patch < 0.5 || m.moisture < 0.45 || m.core > 0.3 || m.walk > 0.7 || h > c.near() * 0.6) return;
        const size = 0.8 + 1.0 * rng;
        out.push(x, c.field.sample(x, z) - 0.005, z, rng * 40, size, size, size, Math.floor(rng * 997));
      },
    }],
  },
];
const MISTVEIL_STORY_UNDERSTORY: UnderstoryProfile = {
  grass: { bladeHeight: 0.55, heightScale: 1.15, densityScale: 0.95, base: 0x162b22, tip: 0x5a8c7c, baseDry: 0x2c3a2a, tipDry: 0x84a080, cacheKey: 'mistveil-story-grass' },
  excluded: MISTVEIL_STORY_NO_EXCLUSION,
  clutter: MISTVEIL_STORY_CLUTTER,
  trailDressing: { stoneTints: MISTVEIL_STORY_STONE_TINTS, glow: true },
  clutterNearFull: 18,
  clutterNearNone: 38,
};
const MISTVEIL_STORY_NO_CARVE = {
  lipSmooth: 0, crestStart: 0, crestEnd: 0, bedNoise: 0,
  surfaceHeight: () => 1e6,
  insideBand: () => false,
  membership: () => 0,
  wetness: () => 0,
  waterLevel: () => -Infinity,
} as const;
const MISTVEIL_STORY_WATER: WaterPlan = {
  name: 'mistveil-story-water', strips: [], pools: [],
  palette: { shallow: 0x5e8d8a, deep: 0x1d3936, sky: 0x9cc0bc, sun: 0xd6e6dc, foam: 0xe6efd8 },
  deepDepth: 0.3,
};
const MISTVEIL_STORY_EXTENT: Extent = { minX: -94, maxX: 94, minZ: -78, maxZ: 78 };

// ---- Sunmane Expanse story ----

/**
 * Dry warm grass and stone: the same canopy Poly Haven CC0 layer set the trial biomes use, graded into a sun-bleached
 * savanna palette. Wide open ground (the migration gate corridor, the council terrace, the High Crown); no carved channel
 * (the water-allotment terrace carries the only standing water, and the chapter profile does not draw it).
 */
const SUNMANE_STORY_LAYERS: readonly GroundLayerSpec[] = [
  { id: 'leafy_grass', metersPerTile: 2.1, tint: [1.0, 0.95, 0.6] },
  { id: 'mossy_rock', metersPerTile: 3.0, tint: [0.84, 0.78, 0.55] },
  { id: 'mud_forest', metersPerTile: 2.35, tint: [1.2, 0.95, 0.66] },
  { id: 'roots', metersPerTile: 1.67, tint: [0.95, 0.82, 0.55] },
  { id: 'gray_rocks', metersPerTile: 1.8, tint: [1.02, 0.95, 0.82] },
];
const SUNMANE_STORY_PEBBLE_TINTS = [0xb8a98c, 0xcfc1a6, 0xa89878] as const;
const SUNMANE_STORY_STONE_TINTS = [0x8c7e64, 0x766a52, 0x9a8c70, 0x65584a] as const;
const SUNMANE_STORY_NO_EXCLUSION = (): boolean => false;
const SUNMANE_STORY_CLUTTER: readonly ClutterRecipe[] = [
  {
    name: 'pebble', tints: SUNMANE_STORY_PEBBLE_TINTS, tilt: 0.35, receiveShadow: false, sway: undefined,
    scatters: [{
      // Sun-bleached pebbles along the trail shoulders.
      cell: 0.9, seed: 31,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        if (m.core > 0.35 || m.bed > 0.2 || h > c.near() * (0.1 + 0.7 * m.shoulder + 0.1 * m.walk)) return;
        const size = 0.035 + 0.07 * rng * rng;
        out.push(x, c.field.sample(x, z) + size * 0.12, z, rng * 40, size, size * 0.55, size * (0.7 + 0.5 * h), Math.floor(rng * 997));
      },
    }],
  },
  {
    name: 'edge-stone', tints: SUNMANE_STORY_STONE_TINTS, tilt: 0.12, receiveShadow: false, sway: undefined,
    scatters: [{
      // Pale outcrops along the berm and the terrace backs; never on the trail core.
      cell: 4.5, seed: 73,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        if (m.core > 0.05 || m.walk > 0.05 || m.interior > 0.05 || h > c.near() * 0.45) return;
        const size = 0.5 + 0.7 * rng;
        out.push(x, c.field.sample(x, z), z, rng * Math.PI * 2, size, size * 0.7, size * (0.9 + 0.4 * h), Math.floor(rng * 997));
      },
    }],
  },
];
const SUNMANE_STORY_UNDERSTORY: UnderstoryProfile = {
  grass: { bladeHeight: 0.5, heightScale: 1.0, densityScale: 0.9, base: 0x9aa158, tip: 0xc6b46e, baseDry: 0xb09a52, tipDry: 0xd9c074, cacheKey: 'sunmane-story-grass' },
  excluded: SUNMANE_STORY_NO_EXCLUSION,
  clutter: SUNMANE_STORY_CLUTTER,
  trailDressing: { stoneTints: SUNMANE_STORY_STONE_TINTS, glow: false },
  clutterNearFull: 16,
  clutterNearNone: 34,
};
const SUNMANE_STORY_NO_CARVE = {
  lipSmooth: 0, crestStart: 0, crestEnd: 0, bedNoise: 0,
  surfaceHeight: () => 1e6,
  insideBand: () => false,
  membership: () => 0,
  wetness: () => 0,
  waterLevel: () => -Infinity,
} as const;
const SUNMANE_STORY_WATER: WaterPlan = {
  name: 'sunmane-story-water', strips: [], pools: [],
  palette: { shallow: 0x82a08a, deep: 0x33483e, sky: 0xc0aa78, sun: 0xffd9a0, foam: 0xf2e6c8 },
  deepDepth: 0.3,
};
const SUNMANE_STORY_EXTENT: Extent = { minX: -104, maxX: 104, minZ: -84, maxZ: 84 };

// ---- Refuge story ----

/**
 * Sheltered Grove-family sanctuary: the same Poly Haven CC0 canopy layers the Grove uses, graded slightly cooler. Open ground
 * around the relocated services and the council landing, no carved channel, gentle relief (no cliffs, no summits).
 */
const REFUGE_STORY_LAYERS: readonly GroundLayerSpec[] = [
  { id: 'leafy_grass', metersPerTile: 2.1, tint: [0.84, 0.88, 0.44] },
  { id: 'mossy_rock', metersPerTile: 3.0, tint: [0.56, 0.8, 0.42] },
  { id: 'mud_forest', metersPerTile: 2.35, tint: [1.5, 1.35, 0.95] },
  { id: 'roots', metersPerTile: 1.67, tint: [0.86, 0.74, 0.48] },
  { id: 'gray_rocks', metersPerTile: 1.8, tint: [1, 0.97, 0.9] },
];
const REFUGE_STORY_PEBBLE_TINTS = [0xcfc7ae, 0xb9b095, 0xe0d8c0] as const;
const REFUGE_STORY_STONE_TINTS = [0x8a8a76, 0x77785f, 0x9a9a84, 0x6c6c58] as const;
const REFUGE_STORY_NO_EXCLUSION = (): boolean => false;
const REFUGE_STORY_CLUTTER: readonly ClutterRecipe[] = [
  {
    name: 'pebble', tints: REFUGE_STORY_PEBBLE_TINTS, tilt: 0.35, receiveShadow: false, sway: undefined,
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
const REFUGE_STORY_UNDERSTORY: UnderstoryProfile = {
  grass: { bladeHeight: 0.55, heightScale: 1.15, densityScale: 1.0, base: 0x2a4a14, tip: 0xb4c15a, baseDry: 0x4a5a1c, tipDry: 0xd6c168, cacheKey: 'refuge-story-grass' },
  excluded: REFUGE_STORY_NO_EXCLUSION,
  clutter: REFUGE_STORY_CLUTTER,
  trailDressing: { stoneTints: REFUGE_STORY_STONE_TINTS, glow: false },
  clutterNearFull: 14,
  clutterNearNone: 30,
};
const REFUGE_STORY_NO_CARVE = {
  lipSmooth: 0, crestStart: 0, crestEnd: 0, bedNoise: 0,
  surfaceHeight: () => 1e6,
  insideBand: () => false,
  membership: () => 0,
  wetness: () => 0,
  waterLevel: () => -Infinity,
} as const;
const REFUGE_STORY_WATER: WaterPlan = {
  name: 'refuge-story-water', strips: [], pools: [],
  palette: { shallow: 0x7fa08a, deep: 0x2c4a3e, sky: 0xb7a98a, sun: 0xffd9a0, foam: 0xf0e6cf },
  deepDepth: 0.3,
};
const REFUGE_STORY_EXTENT: Extent = { minX: -36, maxX: 36, minZ: -32, maxZ: 38 };

// ---- Heartroot Hollow story ----

/**
 * Cool mineral and root caverns beneath Erya: the moonpine cold-rock layer (re-used, same CC0 set) grades the cool stone of
 * the cavern floor, with a warm readable character key/fill (the Heartroot ember light and the actors stand readable against
 * the cool mineral rock). The carve is null; the depthShade band is set well below the cavern y range so nothing in the
 * Hollow darkens (the cavern atmosphere uses a hemisphere fill for cave-relative readability).
 */
const HOLLOW_STORY_LAYERS: readonly GroundLayerSpec[] = [
  { id: 'snow_cover', metersPerTile: 2.0, tint: [0.55, 0.6, 0.72] },
  { id: 'ice_bed', metersPerTile: 2.0, tint: [0.5, 0.55, 0.68] },
  { id: 'pine_needles', metersPerTile: 3.15, tint: [0.42, 0.32, 0.28] },
  { id: 'rocky_trail', metersPerTile: 2.0, tint: [0.45, 0.42, 0.4] },
  { id: 'cold_rock', metersPerTile: 2.7, tint: [0.7, 0.74, 0.82] },
];
const HOLLOW_STORY_STONE_TINTS = [0x5a6068, 0x484e55, 0x666c74, 0x3e444c] as const;
const HOLLOW_STORY_ROOT_TINTS = [0x6a5848, 0x7a6850, 0x5a4838, 0x4a3828] as const;
const HOLLOW_STORY_PEBBLE_TINTS = [0x6a6e76, 0x585c64, 0x787c84, 0x3e444c] as const;
const HOLLOW_STORY_NO_EXCLUSION = (): boolean => false;
const HOLLOW_STORY_CLUTTER: readonly ClutterRecipe[] = [
  {
    name: 'pebble', tints: HOLLOW_STORY_PEBBLE_TINTS, tilt: 0.3, receiveShadow: false, sway: undefined,
    scatters: [{
      // Cold shattered stones along the cavern terraces.
      cell: 0.9, seed: 21,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        if (m.core > 0.35 || h > c.near() * (0.1 + 0.6 * m.shoulder + 0.15 * m.walk)) return;
        const size = 0.04 + 0.08 * rng * rng;
        out.push(x, c.field.sample(x, z) + size * 0.12, z, rng * 40, size, size * 0.55, size * (0.7 + 0.5 * h), Math.floor(rng * 997));
      },
    }],
  },
  {
    name: 'root', tints: HOLLOW_STORY_ROOT_TINTS, tilt: 0.12, receiveShadow: true, sway: undefined,
    scatters: [{
      // Surface roots arching out of the cavern banks along the route edges.
      cell: 2.0, seed: 201,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        if (m.edge < 0.18 || m.core > 0.02 || m.rock > 0.3 || h > m.edge * 0.5) return;
        const size = 0.7 + 0.8 * rng;
        out.push(x, c.field.sample(x, z) - 0.02, z, rng * Math.PI * 2, size, size * (0.8 + 0.6 * h), size, Math.floor(rng * 997));
      },
    }],
  },
  {
    name: 'edge-stone', tints: HOLLOW_STORY_STONE_TINTS, tilt: 0.18, receiveShadow: false, sway: undefined,
    scatters: [{
      // Cool cavern boulders along the berm and beside the root columns.
      cell: 5.5, seed: 119,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        if (m.core > 0.05 || m.walk > 0.05 || m.interior > 0.05 || h > c.near() * 0.5) return;
        const size = 0.6 + 0.8 * rng;
        out.push(x, c.field.sample(x, z), z, rng * Math.PI * 2, size, size * 0.7, size * (0.9 + 0.4 * h), Math.floor(rng * 997));
      },
    }],
  },
];
const HOLLOW_STORY_UNDERSTORY: UnderstoryProfile = {
  grass: { bladeHeight: 0.2, heightScale: 0.6, densityScale: 0.18, base: 0x4a4048, tip: 0x6e6068, baseDry: 0x3e3838, tipDry: 0x6a5a58, cacheKey: 'hollow-story-grass' },
  excluded: HOLLOW_STORY_NO_EXCLUSION,
  clutter: HOLLOW_STORY_CLUTTER,
  trailDressing: { stoneTints: HOLLOW_STORY_STONE_TINTS, glow: true },
  clutterNearFull: 14,
  clutterNearNone: 30,
};
const HOLLOW_STORY_NO_CARVE = {
  lipSmooth: 0, crestStart: 0, crestEnd: 0, bedNoise: 0,
  surfaceHeight: () => 1e6,
  insideBand: () => false,
  membership: () => 0,
  wetness: () => 0,
  waterLevel: () => -Infinity,
} as const;
const HOLLOW_STORY_WATER: WaterPlan = {
  name: 'hollow-story-water', strips: [], pools: [],
  palette: { shallow: 0x4f6c80, deep: 0x1c2c3a, sky: 0x889ab0, sun: 0xd9c08a, foam: 0xefd9a0 },
  deepDepth: 0.3,
};
const HOLLOW_STORY_EXTENT: Extent = { minX: -120, maxX: 120, minZ: -90, maxZ: 90 };

// ---- public profiles ----

/**
 * Moonpine Ridge (chapter region): same ridge, the wolf temple ascent to the summit, late-day cold-blue sky. The chapter layout
 * carries the `moonpine-ridge-` surface prefix; the trial layout keeps its `moonpine-trial-` prefix and still matches the
 * trial Moonpine profile.
 */
export const MOONPINE_STORY_BIOME: BiomeProfile = {
  id: MOONPINE_STORY_ID,
  terrain: {
    maxMound: 1.2,
    maxDip: -0.35,
    bermMinHeight: 0.4,
    bermMaxHeight: 0.95,
    embankment: { slopeMin: 1.4, slopeMax: 2.4, minRun: 1.1, maxRun: 4.4, rock: 0.55 },
    summits: [],
    backdrop: undefined,
    extent: MOONPINE_STORY_EXTENT,
    refine: { flatOutside: 1.7, raisedOutside: 1.85 },
  },
  carve: MOONPINE_STORY_NO_CARVE,
  splat: {
    textureRoot: '/asset-source/textures/moonpine',
    layers: MOONPINE_STORY_LAYERS,
    rock: { layer: 4, scale: 1.2, tint: [0.55, 0.85, 2.0], roughness: 0.7 },
    bed: { layer: 4, scale: 1, tint: [0.5, 0.78, 2.0], roughness: 0.3 },
    mud: { layer: 4, scale: 1, tint: [0.45, 0.72, 1.8], roughness: 0.45 },
    rockSlopeStart: 1.0,
    rockSlopeFull: 1.9,
    rockOnOpenSlopes: true,
    depthShade: { top: 0.5, bottom: -2, strength: 0.25 },
    macroLow: [0.88, 0.92, 1.0],
    macroHigh: [1.1, 1.1, 1.12],
    strata: 0.5,
    dapple: { strength: 0.1, scale: 0.6, speed: 0.5 },
  },
  understory: MOONPINE_STORY_UNDERSTORY,
  water: MOONPINE_STORY_WATER,
  features: [],
  atmosphere: {
    background: 0x8ea6bd,
    fogColor: 0x8ea6bd,
    fogNear: 18,
    fogFar: 80,
    hemisphereSky: 0xa2bcd6,
    hemisphereGround: 0x464c54,
    hemisphereIntensity: 0.95,
    sunColor: 0xeed6a4,
    sunIntensity: 3.1,
    fillColor: 0x7a96b6,
    fillIntensity: 0.5,
    sunOffset: { x: -48, y: 16, z: 22 },
    shadowHalfWidth: 24,
    shadowMapSize: 1536,
    sky: {
      // Chapter Moonpine: late-day cold blue, a touch warmer than the trial (the sun is behind the temple).
      zenith: 0x2e4666,
      horizon: 0xd0d8e6,
      ground: 0x2e3640,
      sunDiscSize: 0.024,
      sunDiscColor: 0xf2dcb0,
      sunGlowSize: 0.3,
      sunGlowColor: 0xb8c8e0,
      cloudColor: 0xeef0f6,
      cloudCoverage: 0.15,
      cloudSpeed: 1,
    },
    heightFog: {
      color: 0x6e88a4,
      density: 0.04,
      falloff: 0.28,
      sunTint: 0.7,
      sunTintColor: 0xeacb8c,
      groundBias: 0.8,
      nearFloor: 0.3,
    },
    grade: {
      lift: [0.0, 0.01, 0.022],
      gamma: [0.97, 0.99, 1.04],
      gain: [1.02, 1.0, 0.96],
      saturation: 1.02,
      warmHighlight: [0.18, 0.12, 0.04],
      coolShadow: [0.03, 0.06, 0.14],
      vignette: 0.14,
    },
    lightShafts: 0.7,
  },
  boundaryRocks: undefined,
};

/**
 * Mistveil Basin (chapter region): wet reed/moss, the Black Sap downstream of the polluted source, cool teal light. The chapter
 * layout carries the `mistveil-basin-` surface prefix.
 */
export const MISTVEIL_STORY_BIOME: BiomeProfile = {
  id: MISTVEIL_STORY_ID,
  terrain: {
    maxMound: 0.6,
    maxDip: -0.35,
    bermMinHeight: 0.25,
    bermMaxHeight: 0.65,
    embankment: { slopeMin: 1.2, slopeMax: 2.2, minRun: 1.1, maxRun: 3.6, rock: 0.3 },
    summits: [],
    backdrop: undefined,
    extent: MISTVEIL_STORY_EXTENT,
    refine: { flatOutside: 1.4, raisedOutside: 1.85 },
  },
  carve: MISTVEIL_STORY_NO_CARVE,
  splat: {
    textureRoot: '/asset-source/textures/mistveil',
    layers: MISTVEIL_STORY_LAYERS,
    rock: { layer: 1, scale: 1.25, tint: [0.48, 0.6, 0.54], roughness: 0.6 },
    bed: { layer: 4, scale: 1, tint: [0.3, 0.3, 0.36], roughness: 0.35 },
    mud: { layer: 3, scale: 1, tint: [0.36, 0.38, 0.36], roughness: 0.3 },
    rockSlopeStart: 0.9,
    rockSlopeFull: 1.6,
    rockOnOpenSlopes: false,
    depthShade: { top: 0.5, bottom: -2, strength: 0.25 },
    macroLow: [0.78, 0.88, 0.86],
    macroHigh: [1.05, 1.08, 1.02],
    strata: 0.2,
    dapple: { strength: 0.1, scale: 0.7, speed: 0.55 },
  },
  understory: MISTVEIL_STORY_UNDERSTORY,
  water: MISTVEIL_STORY_WATER,
  features: [],
  atmosphere: {
    background: 0x5a7c80,
    fogColor: 0x5a7c80,
    fogNear: 26,
    fogFar: 90,
    hemisphereSky: 0x9cc6c2,
    hemisphereGround: 0x2a3836,
    hemisphereIntensity: 1.0,
    sunColor: 0xe6f0d8,
    sunIntensity: 2.6,
    fillColor: 0x6e98a4,
    fillIntensity: 0.55,
    sunOffset: { x: -42, y: 18, z: 18 },
    shadowHalfWidth: 22,
    shadowMapSize: 1536,
    sky: {
      // Chapter Mistveil: a touch more teal than the trial, the moon is even lower and the fog is thicker.
      zenith: 0x0a1c20,
      horizon: 0x3a6868,
      ground: 0x081414,
      sunDiscSize: 0.026,
      sunDiscColor: 0xc8e6dc,
      sunGlowSize: 0.34,
      sunGlowColor: 0x70b0a8,
      cloudColor: 0x88a4a0,
      cloudCoverage: 0.6,
      cloudSpeed: 0.3,
    },
    heightFog: {
      color: 0x406060,
      density: 0.05,
      falloff: 0.12,
      sunTint: 0.55,
      sunTintColor: 0x88c0b8,
      groundBias: 0.85,
      nearFloor: 0.36,
    },
    grade: {
      lift: [0.005, 0.014, 0.022],
      gamma: [0.96, 1.0, 1.05],
      gain: [0.96, 1.0, 1.04],
      saturation: 0.95,
      warmHighlight: [0.1, 0.18, 0.16],
      coolShadow: [0.02, 0.06, 0.1],
      vignette: 0.28,
    },
    lightShafts: 0.7,
  },
  boundaryRocks: undefined,
};

/**
 * Sunmane Expanse (chapter region): dry warm grass and stone, the migration gate corridor, the council terrace and the High
 * Crown. Wide open ground, warm amber light, restrained dapple. The chapter layout carries the `sunmane-expanse-` surface prefix.
 */
export const SUNMANE_STORY_BIOME: BiomeProfile = {
  id: SUNMANE_STORY_ID,
  terrain: {
    maxMound: 0.7,
    maxDip: -0.25,
    bermMinHeight: 0.3,
    bermMaxHeight: 0.7,
    embankment: { slopeMin: 1.4, slopeMax: 2.4, minRun: 1.1, maxRun: 4.0, rock: 0.4 },
    summits: [],
    backdrop: undefined,
    extent: SUNMANE_STORY_EXTENT,
    refine: { flatOutside: 1.6, raisedOutside: 1.8 },
  },
  carve: SUNMANE_STORY_NO_CARVE,
  splat: {
    textureRoot: '/asset-source/textures/canopy',
    layers: SUNMANE_STORY_LAYERS,
    rock: { layer: 4, scale: 1.2, tint: [0.92, 0.86, 0.74], roughness: 0.6 },
    bed: { layer: 4, scale: 1, tint: [0.78, 0.7, 0.58], roughness: 0.4 },
    mud: { layer: 2, scale: 1, tint: [0.92, 0.68, 0.5], roughness: 0.4 },
    rockSlopeStart: 0.9,
    rockSlopeFull: 1.6,
    rockOnOpenSlopes: false,
    depthShade: { top: 0.5, bottom: -2, strength: 0.18 },
    macroLow: [1.0, 0.92, 0.78],
    macroHigh: [1.18, 1.08, 0.9],
    strata: 0.25,
    dapple: { strength: 0.08, scale: 0.5, speed: 0.5 },
  },
  understory: SUNMANE_STORY_UNDERSTORY,
  water: SUNMANE_STORY_WATER,
  features: [],
  atmosphere: {
    background: 0xc89668,
    fogColor: 0xd4ac7a,
    fogNear: 22,
    fogFar: 100,
    hemisphereSky: 0xe8c08c,
    hemisphereGround: 0x4a3220,
    hemisphereIntensity: 1.0,
    sunColor: 0xffb46c,
    sunIntensity: 3.7,
    fillColor: 0xa87850,
    fillIntensity: 0.5,
    sunOffset: { x: -50, y: 17, z: 20 },
    shadowHalfWidth: 26,
    shadowMapSize: 1536,
    sky: {
      // Sunmane savanna gold: clear warm afternoon, the sun a bit lower and the haze hot and amber.
      zenith: 0x4a6c98,
      horizon: 0xffc88a,
      ground: 0x6a4a2a,
      sunDiscSize: 0.026,
      sunDiscColor: 0xffe0a0,
      sunGlowSize: 0.32,
      sunGlowColor: 0xff9040,
      cloudColor: 0xfff0d0,
      cloudCoverage: 0.18,
      cloudSpeed: 0.5,
    },
    heightFog: {
      color: 0xb88860,
      density: 0.04,
      falloff: 0.2,
      sunTint: 0.85,
      sunTintColor: 0xff7e2c,
      groundBias: 0.8,
      nearFloor: 0.32,
    },
    grade: {
      lift: [0.02, 0.012, 0.0],
      gamma: [1.04, 1.0, 0.94],
      gain: [1.06, 1.02, 0.94],
      saturation: 1.1,
      warmHighlight: [0.22, 0.14, 0.05],
      coolShadow: [0.06, 0.04, 0.02],
      vignette: 0.14,
    },
    lightShafts: 0.85,
  },
  boundaryRocks: undefined,
};

/**
 * The Refuge (chapter region): sheltered Grove-family sanctuary, the relocated services, the council landing and the collapse
 * rim. Warm late-afternoon light, gentle relief. The chapter layout carries the `refuge-` surface prefix.
 */
export const REFUGE_STORY_BIOME: BiomeProfile = {
  id: REFUGE_STORY_ID,
  terrain: {
    maxMound: 0.55,
    maxDip: -0.25,
    bermMinHeight: 0.2,
    bermMaxHeight: 0.6,
    embankment: { slopeMin: 1.5, slopeMax: 2.5, minRun: 1.1, maxRun: 4.2, rock: 0.2 },
    summits: [],
    backdrop: undefined,
    extent: REFUGE_STORY_EXTENT,
    refine: { flatOutside: 1.4, raisedOutside: 1.6 },
  },
  carve: REFUGE_STORY_NO_CARVE,
  splat: {
    textureRoot: '/asset-source/textures/canopy',
    layers: REFUGE_STORY_LAYERS,
    rock: { layer: 1, scale: 1.25, tint: [0.7, 0.74, 0.58], roughness: 0.6 },
    bed: { layer: 4, scale: 1, tint: [0.62, 0.6, 0.5], roughness: 0.4 },
    mud: { layer: 2, scale: 1, tint: [0.62, 0.55, 0.5], roughness: 0.35 },
    rockSlopeStart: 0.9,
    rockSlopeFull: 1.6,
    rockOnOpenSlopes: false,
    depthShade: { top: 0.5, bottom: -1.2, strength: 0.2 },
    macroLow: [0.92, 0.98, 0.78],
    macroHigh: [1.14, 1.1, 0.92],
    strata: 0.2,
    dapple: { strength: 0.1, scale: 0.45, speed: 0.5 },
  },
  understory: REFUGE_STORY_UNDERSTORY,
  water: REFUGE_STORY_WATER,
  features: [],
  atmosphere: {
    background: 0xa8b888,
    fogColor: 0xa8b888,
    fogNear: 22,
    fogFar: 92,
    hemisphereSky: 0xc8d2a4,
    hemisphereGround: 0x4a4a30,
    hemisphereIntensity: 1.0,
    sunColor: 0xffaa68,
    sunIntensity: 3.5,
    fillColor: 0x8aa078,
    fillIntensity: 0.5,
    sunOffset: { x: -50, y: 17, z: 16 },
    shadowHalfWidth: 22,
    shadowMapSize: 1536,
    sky: {
      // The Refuge: a touch cooler than the Grove, late afternoon haze hanging over the meadow.
      zenith: 0x4a6a78,
      horizon: 0xe6c886,
      ground: 0x2a3a26,
      sunDiscSize: 0.026,
      sunDiscColor: 0xffd098,
      sunGlowSize: 0.32,
      sunGlowColor: 0xffa050,
      cloudColor: 0xfff0d8,
      cloudCoverage: 0.3,
      cloudSpeed: 0.55,
    },
    heightFog: {
      color: 0xa89c70,
      density: 0.04,
      falloff: 0.2,
      sunTint: 0.85,
      sunTintColor: 0xff8c40,
      groundBias: 0.8,
      nearFloor: 0.32,
    },
    grade: {
      lift: [0.008, 0.018, 0.0],
      gamma: [1.03, 1.0, 0.96],
      gain: [1.04, 1.02, 0.97],
      saturation: 1.06,
      warmHighlight: [0.2, 0.14, 0.05],
      coolShadow: [0.04, 0.08, 0.08],
      vignette: 0.16,
    },
    lightShafts: 0.8,
  },
  boundaryRocks: undefined,
};

/**
 * Heartroot Hollow (chapter region): cool mineral and root caverns beneath Erya, with a warm readable character key/fill.
 * The depthShade band is set well below the cavern y range so nothing in the Hollow darkens; the cool cavern atmosphere
 * with the warm key/fill keeps Orun and the actors readable against the rock.
 *
 * The chapter layout carries the `heartroot-hollow-` surface prefix.
 */
export const HOLLOW_STORY_BIOME: BiomeProfile = {
  id: HOLLOW_STORY_ID,
  terrain: {
    maxMound: 0.8,
    maxDip: -0.3,
    bermMinHeight: 0.3,
    bermMaxHeight: 0.7,
    embankment: { slopeMin: 1.3, slopeMax: 2.3, minRun: 1.1, maxRun: 3.8, rock: 0.5 },
    summits: [],
    backdrop: undefined,
    extent: HOLLOW_STORY_EXTENT,
    refine: { flatOutside: 1.5, raisedOutside: 1.7 },
  },
  carve: HOLLOW_STORY_NO_CARVE,
  splat: {
    textureRoot: '/asset-source/textures/moonpine',
    layers: HOLLOW_STORY_LAYERS,
    rock: { layer: 4, scale: 1.2, tint: [0.55, 0.62, 0.78], roughness: 0.7 },
    bed: { layer: 4, scale: 1, tint: [0.45, 0.5, 0.65], roughness: 0.35 },
    mud: { layer: 4, scale: 1, tint: [0.4, 0.4, 0.5], roughness: 0.45 },
    rockSlopeStart: 0.9,
    rockSlopeFull: 1.7,
    rockOnOpenSlopes: true,
    // Hollow y range -36 to -7. Per SplatProfile depthShade, terrain BELOW `bottom` is darkened by `strength` (fading in
    // from `top`). Setting `bottom` deeper than the lowest cavern y means nothing in the cavern darkens; we keep the band
    // here as a no-op and rely on the cavern atmosphere (hemisphere fill + warm key) for cave-relative readability.
    depthShade: { top: -38, bottom: -45, strength: 0 },
    macroLow: [0.78, 0.84, 0.94],
    macroHigh: [1.05, 1.08, 1.12],
    strata: 0.6,
    dapple: { strength: 0.05, scale: 0.5, speed: 0.4 },
  },
  understory: HOLLOW_STORY_UNDERSTORY,
  water: HOLLOW_STORY_WATER,
  features: [],
  atmosphere: {
    background: 0x48545c,
    fogColor: 0x54605c,
    fogNear: 18,
    fogFar: 70,
    hemisphereSky: 0x7a8c9a,
    hemisphereGround: 0x2a3034,
    hemisphereIntensity: 0.95,
    // Warm key light (the Heartroot ember and the cavern mouth light) keeps Orun and the actors readable against the cool
    // mineral rock; the ambient fill warms the underside of every form so the black-robe outline stays visible.
    sunColor: 0xf4c08c,
    sunIntensity: 2.9,
    fillColor: 0xa68870,
    fillIntensity: 0.65,
    sunOffset: { x: -38, y: 14, z: 16 },
    shadowHalfWidth: 22,
    shadowMapSize: 1536,
    sky: {
      // Hollow: an underground cavern, so the dome shows a low amber ember glow overhead rather than a real sky.
      zenith: 0x14181c,
      horizon: 0x5a4232,
      ground: 0x0c0a08,
      sunDiscSize: 0.045,
      sunDiscColor: 0xffb070,
      sunGlowSize: 0.55,
      sunGlowColor: 0xb85830,
      cloudColor: 0x4a3c30,
      cloudCoverage: 0.7,
      cloudSpeed: 0.2,
    },
    heightFog: {
      color: 0x4a3830,
      density: 0.045,
      falloff: 0.18,
      sunTint: 0.75,
      sunTintColor: 0xff8838,
      groundBias: 0.85,
      nearFloor: 0.36,
    },
    grade: {
      lift: [0.018, 0.012, 0.005],
      gamma: [1.02, 0.98, 0.92],
      gain: [1.06, 1.0, 0.92],
      saturation: 1.08,
      warmHighlight: [0.22, 0.14, 0.05],
      coolShadow: [0.04, 0.05, 0.07],
      vignette: 0.32,
    },
    lightShafts: 0.55,
  },
  boundaryRocks: undefined,
};