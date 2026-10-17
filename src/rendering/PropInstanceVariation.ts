import { mulberry32 } from '../world/GroundNoise.js';

/**
 * Deterministic, seeded per-instance variation for decorative vegetation and rocks.
 *
 * Variation is a presentation detail only: it never alters the placement's authoring contract (`position`, `rotationY`,
 * `scale`, asset id) and is never read by collision or movement. The values below are the budget for the whole prop set —
 * hue/value jitter stays subtle so the foliage still feels like a coherent biome, scale jitter is asymmetric (height vs
 * width) so trees don't get wider with the height, and lean is small enough that canopies never overlap their neighbours.
 *
 *   hue  ±4%  (HSL)
 *   val  ±10% (HSL value)
 *   sy   ±12% (vertical scale)
 *   sxz  ±8%  (horizontal scale)
 *   lean ≤4°  (rotation around a random horizontal axis through the base)
 *
 * Every value comes from a placement-keyed hash so the same position always renders the same instance, independent of
 * load order or batch size.
 */
export interface PropVariationProfile {
  readonly assetId: string;
  readonly hueJitter: number;
  readonly valueJitter: number;
  readonly heightJitter: number;
  readonly widthJitter: number;
  readonly leanMaxRadians: number;
  readonly sways: boolean;
}

const HUE_JITTER = 0.04;
const VALUE_JITTER = 0.1;
const HEIGHT_JITTER = 0.12;
const WIDTH_JITTER = 0.08;
const LEAN_MAX = (4 * Math.PI) / 180;

const DEFAULT_PROFILE: PropVariationProfile = {
  assetId: '*', hueJitter: HUE_JITTER, valueJitter: VALUE_JITTER, heightJitter: HEIGHT_JITTER, widthJitter: WIDTH_JITTER, leanMaxRadians: LEAN_MAX, sways: true,
};

/** Decoration asset ids that get per-instance variation; gameplay colliders (crates, gates, movable props) are not listed. */
export const FOLIAGE_ASSET_VARIATION: Readonly<Record<string, PropVariationProfile>> = {
  'prop-erya-edge-tree': { ...DEFAULT_PROFILE, assetId: 'prop-erya-edge-tree', sways: true },
  'prop-moonpine-tree': { ...DEFAULT_PROFILE, assetId: 'prop-moonpine-tree', sways: true },
  'prop-rainforest-canopy-tree': { ...DEFAULT_PROFILE, assetId: 'prop-rainforest-canopy-tree', sways: true },
  'prop-savanna-acacia': { ...DEFAULT_PROFILE, assetId: 'prop-savanna-acacia', sways: true },
  'prop-heartroot-trunk': { ...DEFAULT_PROFILE, assetId: 'prop-heartroot-trunk', sways: true },
  'prop-bamboo-cluster': { ...DEFAULT_PROFILE, assetId: 'prop-bamboo-cluster', sways: true },
  'prop-bamboo-grove-cluster': { ...DEFAULT_PROFILE, assetId: 'prop-bamboo-grove-cluster', sways: true },
  'prop-canopy-fern-cluster': { ...DEFAULT_PROFILE, assetId: 'prop-canopy-fern-cluster', heightJitter: 0.18, widthJitter: 0.18, leanMaxRadians: 0 },
  'prop-mistveil-reed-cluster': { ...DEFAULT_PROFILE, assetId: 'prop-mistveil-reed-cluster', heightJitter: 0.18, widthJitter: 0.18, leanMaxRadians: 0 },
  'prop-greenwake-bramble-wall': { ...DEFAULT_PROFILE, assetId: 'prop-greenwake-bramble-wall', sways: false, leanMaxRadians: 0 },
  'prop-greenwake-boulder-cluster': { ...DEFAULT_PROFILE, assetId: 'prop-greenwake-boulder-cluster', hueJitter: 0.02, valueJitter: 0.08, heightJitter: 0.18, widthJitter: 0.18, leanMaxRadians: 0, sways: false },
  'prop-canopy-cliff-rock': { ...DEFAULT_PROFILE, assetId: 'prop-canopy-cliff-rock', hueJitter: 0.02, valueJitter: 0.08, heightJitter: 0.18, widthJitter: 0.18, leanMaxRadians: 0, sways: false },
  'prop-snow-ridge-rock': { ...DEFAULT_PROFILE, assetId: 'prop-snow-ridge-rock', hueJitter: 0.02, valueJitter: 0.08, heightJitter: 0.18, widthJitter: 0.18, leanMaxRadians: 0, sways: false },
  'prop-mire-bank-rock': { ...DEFAULT_PROFILE, assetId: 'prop-mire-bank-rock', hueJitter: 0.02, valueJitter: 0.08, heightJitter: 0.18, widthJitter: 0.18, leanMaxRadians: 0, sways: false },
  'prop-bamboo-stone': { ...DEFAULT_PROFILE, assetId: 'prop-bamboo-stone', hueJitter: 0.02, valueJitter: 0.08, heightJitter: 0.18, widthJitter: 0.18, leanMaxRadians: 0, sways: false },
};

/** Returns the variation profile for an asset id, or `undefined` when the asset is gameplay-critical (no variation). */
export function propVariationFor(assetId: string): PropVariationProfile | undefined {
  return FOLIAGE_ASSET_VARIATION[assetId];
}

/** Placement-keyed seed: the same position always returns the same value across loads. */
export function variationSeed(x: number, y: number, z: number, assetId: string): number {
  let h = Math.imul(Math.round(x * 1000) | 0, 0x27d4eb2d) ^ Math.imul(Math.round(y * 1000) | 0, 0x165667b1) ^ Math.imul(Math.round(z * 1000) | 0, 0x9e3779b1);
  for (let index = 0; index < assetId.length; index++) h = Math.imul(h ^ assetId.charCodeAt(index), 0x85ebca6b);
  return h >>> 0;
}

export interface PropVariation {
  readonly hueShift: number;
  readonly valueScale: number;
  readonly heightScale: number;
  readonly widthScale: number;
  readonly leanX: number;
  readonly leanZ: number;
  readonly swayPhase: number;
}

/** Deterministic, bounded variation for one instance of `assetId` at placement position `(x, y, z)`. */
export function computePropVariation(assetId: string, x: number, y: number, z: number): PropVariation {
  const profile = propVariationFor(assetId);
  const seed = variationSeed(x, y, z, assetId);
  const random = mulberry32(seed);
  if (!profile) {
    return { hueShift: 0, valueScale: 1, heightScale: 1, widthScale: 1, leanX: 0, leanZ: 0, swayPhase: 0 };
  }
  const hueShift = (random() * 2 - 1) * profile.hueJitter;
  const valueScale = 1 + (random() * 2 - 1) * profile.valueJitter;
  const heightScale = 1 + (random() * 2 - 1) * profile.heightJitter;
  const widthScale = 1 + (random() * 2 - 1) * profile.widthJitter;
  const leanAngle = (random() * 2 - 1) * profile.leanMaxRadians;
  const leanHeading = random() * Math.PI * 2;
  const leanX = Math.sin(leanHeading) * leanAngle;
  const leanZ = Math.cos(leanHeading) * leanAngle;
  const swayPhase = random() * Math.PI * 2;
  return { hueShift, valueScale, heightScale, widthScale, leanX, leanZ, swayPhase };
}

/** Bounds-checked variation suitable for tests. Returns true if the values stay within the profile budget. */
export function isWithinVariationBudget(assetId: string, variation: PropVariation): boolean {
  const profile = propVariationFor(assetId);
  if (!profile) return variation.hueShift === 0 && variation.valueScale === 1 && variation.heightScale === 1 && variation.widthScale === 1 && variation.leanX === 0 && variation.leanZ === 0;
  if (Math.abs(variation.hueShift) > profile.hueJitter + 1e-6) return false;
  if (Math.abs(variation.valueScale - 1) > profile.valueJitter + 1e-6) return false;
  if (Math.abs(variation.heightScale - 1) > profile.heightJitter + 1e-6) return false;
  if (Math.abs(variation.widthScale - 1) > profile.widthJitter + 1e-6) return false;
  const leanMagnitude = Math.hypot(variation.leanX, variation.leanZ);
  return leanMagnitude <= profile.leanMaxRadians + 1e-6;
}

/** Test seam: the same position yields the same variation across calls. */
export function isStableForPlacement(assetId: string, x: number, y: number, z: number): boolean {
  const a = computePropVariation(assetId, x, y, z);
  const b = computePropVariation(assetId, x, y, z);
  return a.hueShift === b.hueShift && a.valueScale === b.valueScale && a.heightScale === b.heightScale && a.widthScale === b.widthScale && a.leanX === b.leanX && a.leanZ === b.leanZ && a.swayPhase === b.swayPhase;
}