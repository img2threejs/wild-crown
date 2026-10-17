import type { BiomeProfile, ClutterRecipe, GroundCarve, GroundLayerSpec, UnderstoryProfile, WaterPlan, WaterRow } from './BiomeProfile';
import { CREEK_Z_END, CREEK_Z_START, creekSection, creekSurfaceHeight, creekWaterLevel, creekWetness, gullyMembership, insideCreekBand } from './GreenwakeCreekShape';
import { smoothstep, valueNoise } from './GroundNoise';
import { CORE_CLEAR_WEIGHT } from './GroundScatter';

/** Authored village footprint: ground cover must not grow through houses. */
const VILLAGE_EXCLUDE: ReadonlyArray<{ minX: number; maxX: number; minZ: number; maxZ: number }> = [
  { minX: -16, maxX: 16, minZ: -7, maxZ: 0 },
  { minX: -22, maxX: -2, minZ: -11, maxZ: -5 },
  { minX: -23, maxX: -21, minZ: -12, maxZ: -2 },
];

export function insideVillage(x: number, z: number): boolean {
  for (const box of VILLAGE_EXCLUDE) {
    if (x > box.minX - 0.4 && x < box.maxX + 0.4 && z > box.minZ - 0.4 && z < box.maxZ + 0.4) return true;
  }
  return false;
}

/** Poly Haven CC0 1k layers (asset-source/textures/greenwake/<id>/{diffuse,normal,arm}.jpg with provenance.json). */
const LAYERS: readonly GroundLayerSpec[] = [
  { id: 'leaves_forest_ground', metersPerTile: 1.26, tint: [0.95, 0.9, 0.82] },
  { id: 'forest_leaves_02', metersPerTile: 3.0, tint: [0.62, 0.98, 0.72] },
  { id: 'stony_dirt_path', metersPerTile: 2.17, tint: [1.9, 1.85, 1.75] },
  { id: 'grass_path_2', metersPerTile: 1.0, tint: [1.0, 0.98, 0.92] },
];

/** The creek gully between the ridge and the gateway ramp, under the rope bridge. Its rim stands at the walkable edges, rolled over by the bank profile itself. */
const CARVE: GroundCarve = {
  lipSmooth: 0.45,
  crestStart: 0,
  crestEnd: 0.3,
  bedNoise: 0.14,
  surfaceHeight: creekSurfaceHeight,
  insideBand: insideCreekBand,
  membership: gullyMembership,
  // Wet mud only on the lower banks.
  wetness: (x, z, surface) => creekWetness(x, z) * (1 - smoothstep(-0.5, 0.9, surface)),
  waterLevel: (_x, z) => creekWaterLevel(z),
};

/** Rows are 0.5 m apart along the creek; 13 columns span the strip (≈ 0.25 m apart in the gully reach). */
const ROW_SPACING = 0.5;
const COLUMNS = 13;
/** The strip reaches this far beyond the bed on both sides; terrain above the water plane hides the excess. */
const SHORE_MARGIN = 0.9;

function creekRows(): WaterRow[] {
  const count = Math.round((CREEK_Z_END - CREEK_Z_START) / ROW_SPACING) + 1;
  const rows: WaterRow[] = [];
  for (let row = 0; row < count; row++) {
    const z = CREEK_Z_START + row * ROW_SPACING;
    const section = creekSection(z);
    // Where the bed climbs out of the gully (head and tail) the strip is clamped below the surrounding ground and fully faded.
    const waterY = creekWaterLevel(z);
    const fade = smoothstep(CREEK_Z_START, CREEK_Z_START + 3, z) * (1 - smoothstep(CREEK_Z_END - 4, CREEK_Z_END, z)) * (1 - smoothstep(-0.95, -0.45, waterY));
    rows.push({ x: section.centerX, z, dirX: 0, dirZ: 1, halfWidth: section.bedHalfWidth + SHORE_MARGIN, waterY, fade, turbulence: 0 });
  }
  return rows;
}

const WATER: WaterPlan = {
  name: 'greenwake-creek-water',
  strips: [{ rows: creekRows(), columns: COLUMNS }],
  pools: [],
  palette: { shallow: 0x4e5b3f, deep: 0x1b4547, sky: 0x7f9f9b, sun: 0xffe2ad, foam: 0xcfd9c8 },
  deepDepth: 0.22,
};

const PEBBLE_TINTS = [0x5b574a, 0x6b6556, 0x4d4a41, 0x7a7262] as const;
const STONE_TINTS = [0x777266, 0x655f53, 0x8a8372, 0x59554a] as const;
const TWIG_TINTS = [0x3d2c1c, 0x4a3822, 0x2f2417] as const;

const CLUTTER: readonly ClutterRecipe[] = [
  {
    name: 'pebble', tints: PEBBLE_TINTS, tilt: 0.35, receiveShadow: false, sway: undefined,
    scatters: [{
      cell: 0.8, seed: 11,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        if (m.core > 0.35 || h > c.near() * (0.14 + 0.85 * m.shoulder + 0.12 * m.walk) || insideVillage(x, z)) return;
        const size = 0.035 + 0.075 * rng * rng;
        out.push(x, c.field.sample(x, z) + size * 0.12, z, rng * 40, size, size * 0.55, size * (0.7 + 0.5 * h), Math.floor(rng * 997));
      },
    }],
  },
  {
    name: 'twig', tints: TWIG_TINTS, tilt: 0.2, receiveShadow: false, sway: undefined,
    scatters: [
      {
        cell: 1.6, seed: 23,
        place: (c, out) => {
          const { x, z, h, rng, mask: m } = c;
          if (m.core > CORE_CLEAR_WEIGHT || h > c.near() * (0.18 + 0.25 * m.walk) || insideVillage(x, z)) return;
          out.push(x, c.field.sample(x, z) + 0.01, z, rng * Math.PI * 2, 0.3 + 0.5 * h, 0.012 + 0.014 * rng, 0.012 + 0.014 * rng, Math.floor(rng * 997));
        },
      },
      {
        // Half-buried roots along the berm band, in the same twig draw call.
        cell: 1.3, seed: 67,
        place: (c, out) => {
          const { x, z, h, rng, mask: m } = c;
          if (m.edge < 0.45 || m.core > 0.05 || h > 0.22 || insideVillage(x, z)) return;
          out.push(x, c.field.sample(x, z) - 0.012, z, rng * Math.PI * 2, 0.5 + 0.6 * rng, 0.05 + 0.04 * h, 0.05 + 0.04 * h, Math.floor(rng * 997));
        },
      },
    ],
  },
  {
    name: 'leaf-pile', tints: [0xffffff, 0xe8d9c8, 0xd2c2a2], tilt: 0.1, receiveShadow: false, sway: undefined,
    scatters: [{
      cell: 2.4, seed: 37,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        if (m.core > 0.2 || h > c.near() * (0.1 + 0.35 * m.walk + 0.3 * m.shoulder) * (0.5 + valueNoise(x * 0.2, z * 0.2, 5)) || insideVillage(x, z)) return;
        out.push(x, c.field.sample(x, z), z, rng * Math.PI * 2, 0.8 + 0.7 * h, 1, 0.8 + 0.7 * h, Math.floor(rng * 997));
      },
    }],
  },
  {
    name: 'mushroom', tints: [0xffffff, 0xe3c9b4, 0xc7ab8e], tilt: 0.25, receiveShadow: true, sway: undefined,
    scatters: [{
      cell: 1.1, seed: 41,
      place: (c, out) => {
        const { x, z, h, rng, mask: m } = c;
        const patch = valueNoise(x * 0.09, z * 0.09, 7);
        if (patch < 0.6 || m.moisture < 0.45 || m.core > CORE_CLEAR_WEIGHT || m.walk > 0.7 || h > c.near() * 0.55 || insideVillage(x, z)) return;
        const size = 0.7 + 0.9 * rng;
        out.push(x, c.field.sample(x, z) - 0.005, z, rng * 40, size, size, size, Math.floor(rng * 997));
      },
    }],
  },
  {
    name: 'fern', tints: [0xffffff, 0xe0f0d0, 0xb5cf94], tilt: 0.12, receiveShadow: true, sway: 'fern',
    scatters: [
      {
        cell: 1.5, seed: 53,
        place: (c, out) => {
          const { x, z, h, rng, mask: m } = c;
          const patch = smoothstep(0.5, 0.8, valueNoise(x * 0.07, z * 0.07, 9));
          if (m.core > 0.05 || m.shoulder > 0.25 || h > c.near() * patch * (1 - m.walk * 0.85) * (1 - 0.6 * m.interior) || insideVillage(x, z)) return;
          const size = 0.6 + 0.7 * rng;
          out.push(x, c.field.sample(x, z) - 0.01, z, rng * Math.PI * 2, size, size, size, Math.floor(rng * 997));
        },
      },
      {
        // Berm undergrowth: dense ferns along the walk-mesh edge.
        cell: 0.85, seed: 61,
        place: (c, out) => {
          const { x, z, h, rng, mask: m } = c;
          if (m.edge < 0.3 || m.core > 0.05 || h > m.edge * 0.8 || insideVillage(x, z)) return;
          const size = 0.75 + 0.75 * rng;
          out.push(x, c.field.sample(x, z) - 0.01, z, rng * Math.PI * 2, size, size * (0.9 + 0.4 * h), size, Math.floor(rng * 997));
        },
      },
    ],
  },
];

const UNDERSTORY: UnderstoryProfile = {
  grass: { bladeHeight: 0.42, heightScale: 1, densityScale: 1, base: 0x1d3510, tip: 0x6f9a3a, baseDry: 0x3a3412, tipDry: 0xa6963f, cacheKey: 'greenwake-grass' },
  excluded: insideVillage,
  clutter: CLUTTER,
  trailDressing: { stoneTints: STONE_TINTS, glow: true },
  clutterNearFull: 18,
  clutterNearNone: 36,
};

/**
 * Greenwake: a temperate forest-edge settlement. Open ground with gentle mounds (+1.2 m / −0.3 m), a berm around the flat
 * walkables, earthen embankments on the ridge and ramps, the creek gully between the ridge and the gateway, a cool misty
 * atmosphere and a low warm sun from the left of the fixed camera (≈34° elevation).
 */
export const GREENWAKE_BIOME: BiomeProfile = {
  id: 'greenwake',
  terrain: {
    maxMound: 1.2,
    maxDip: -0.3,
    bermMinHeight: 0.35,
    bermMaxHeight: 0.9,
    embankment: { slopeMin: 1, slopeMax: 1.6, minRun: 0.9, maxRun: 3.4, rock: 0.15 },
    summits: [],
    backdrop: undefined,
    extent: undefined,
    refine: { flatOutside: 3.4, raisedOutside: 4.2 },
  },
  carve: CARVE,
  splat: {
    textureRoot: '/asset-source/textures/greenwake',
    layers: LAYERS,
    rock: { layer: 2, scale: 1, tint: [1.2, 1.18, 1.1], roughness: 0.92 },
    bed: { layer: 2, scale: 2.3, tint: [1.35, 1.35, 1.28], roughness: 0.55 },
    mud: { layer: 0, scale: 1, tint: [0.5, 0.44, 0.36], roughness: 0.5 },
    rockSlopeStart: 0.85,
    rockSlopeFull: 1.7,
    rockOnOpenSlopes: false,
    depthShade: { top: 0, bottom: -1.2, strength: 0.4 },
    macroLow: [0.88, 0.9, 0.84],
    macroHigh: [1.1, 1.08, 0.98],
    strata: 1,
    dapple: undefined,
  },
  understory: UNDERSTORY,
  water: WATER,
  features: [],
  atmosphere: {
    background: 0x6f8a98,
    fogColor: 0x6f8a98,
    fogNear: 28,
    fogFar: 84,
    // Cool, dim hemisphere fill so the warm key light reads as the dominant source. The fill tints the deep shadows teal,
    // which is what sells the late golden-hour turning to dusk look.
    hemisphereSky: 0x6e8aac,
    hemisphereGround: 0x46342a,
    hemisphereIntensity: 0.85,
    // Strong warm key (the sun), modest cool ambient fill — the warm/cool contrast is the spine of the look.
    sunColor: 0xffc878,
    sunIntensity: 3.6,
    fillColor: 0x6f8aa8,
    fillIntensity: 0.32,
    // Sun lower in the sky (≈22° elevation, was ~34°): the projection hits the screen, shafts land, and the key
    // shadow length reads as "golden hour". The horizontal offset widens so the shaft direction is clearly off-axis.
    sunOffset: { x: -52, y: 18, z: 22 },
    /** 44 m square around the focus (22 m radius covers everything past the 22 m fog start that is still legible); 1536² keeps ≈2.9 cm/texel. */
    shadowHalfWidth: 22,
    shadowMapSize: 1536,
    sky: {
      // Late golden hour tipping into dusk: warm amber sun sinking through a teal sky, deep woods.
      zenith: 0x2a4458,
      horizon: 0xd2a26a,
      ground: 0x20282a,
      sunDiscSize: 0.026,
      sunDiscColor: 0xffd498,
      sunGlowSize: 0.32,
      sunGlowColor: 0xff8a3c,
      // Lower cloud coverage so the warm/cool sky split reads at the horizon instead of milking out the upper frame.
      cloudColor: 0xffc89a,
      cloudCoverage: 0.35,
      cloudSpeed: 0.7,
    },
    heightFog: {
      // Cooler body so the late golden-hour sun tints the far haze amber without lifting the whole frame to milk.
      // The `density` is now per-region tunable; the screen-Y bias + near-floor in the shader keeps the haze off the
      // play area and pools it toward the bottom / horizon.
      color: 0x5e7088,
      density: 0.045,
      falloff: 0.22,
      sunTint: 0.9,
      sunTintColor: 0xff7a36,
      groundBias: 0.85,
      nearFloor: 0.34,
    },
    grade: {
      // Warm key / cool fill: lift a touch cool in the shadows, gamma a touch warm in the highlights, gain boosts warm
      // channels, and a gentle S-curve comes from the gamma asymmetry. Saturation stays near 1 so the late greens are
      // not muddied; the warm/cool split tints are now effective (the shader reads them as direct colour adds).
      lift: [0.005, 0.012, 0.028],
      gamma: [0.96, 0.99, 1.04],
      gain: [1.04, 1.0, 0.94],
      saturation: 1.06,
      warmHighlight: [0.22, 0.14, 0.06],
      coolShadow: [0.04, 0.07, 0.14],
      vignette: 0.18,
    },
    // Strong shafts: the sun is now in-frame, the bridge drops the threshold to 0.55 (so the bloomed sun disc feeds
    // the radial blur) and uses the profile sunGlowColor so the rays read as warm. Strength 0.85 reads as visible rays.
    lightShafts: 0.85,
  },
  boundaryRocks: { idPrefix: 'greenwake-boundary-rock-', assetId: 'prop-greenwake-boulder-cluster', footprintRadius: 1.5 },
};
