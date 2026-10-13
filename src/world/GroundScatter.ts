import type { UnderstoryProfile } from './BiomeProfile';
import type { MaskSample } from './GroundMask';
import { clamp01, smoothstep, valueNoise } from './GroundNoise';

/** Shared ground-cover rules so grass, clutter and trail dressing agree about where the trail is. */

/** Above this trail-core weight nothing but trail dressing may stand. */
export const CORE_CLEAR_WEIGHT = 0.3;
const GRASS_SEED = 1303;

/**
 * Grass clump probability: none on the trail core, sparse and tufted on the worn edges, lush off-route, densest on the berm band.
 * The rest of a wide walkable (cliff top, basin, courtyard) keeps natural short, sparse cover: only its interior share thins it.
 * Terrain features cut it further: none under a bridge or in a channel bed / water, almost none on rock faces, sparse on wet banks.
 */
export function grassDensity(mask: MaskSample, x: number, z: number, understory: UnderstoryProfile): number {
  if (understory.excluded(x, z)) return 0;
  const lawn = 1 - smoothstep(0.02, CORE_CLEAR_WEIGHT, mask.core);
  const finger = smoothstep(0.25, 0.75, valueNoise(x * 2.6, z * 2.6, GRASS_SEED + 1));
  const worn = 1 - mask.shoulder * (1 - 0.7 * finger);
  const clearing = 0.7 + 0.3 * valueNoise(x * 0.35, z * 0.35, GRASS_SEED);
  const trodden = Math.max(0.7 * mask.walk, 0.5 * mask.interior);
  const open = lawn * worn * (1 - trodden) * clearing * (0.65 + 0.6 * mask.moisture);
  // The berm undergrowth ignores the walkable-interior cut: the trail should read as cut through dense growth.
  const band = mask.edge * lawn * worn * (0.82 + 0.18 * clearing);
  return clamp01(Math.max(open, band) * terrainGrassFactor(mask) * understory.grass.densityScale);
}

/** Share of ground cover that survives the terrain features under a point (0 under a bridge or in a channel bed). */
export function terrainGrassFactor(mask: MaskSample): number {
  return (1 - smoothstep(0.02, 0.2, mask.deck)) * (1 - smoothstep(0.04, 0.3, mask.bed)) * (1 - 0.9 * mask.rock) * (1 - 0.65 * mask.mud);
}
