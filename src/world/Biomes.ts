import type { RegionDefinition } from '../game/contracts';
import { GROVE_SURFACE_PREFIX } from '../game/combat/GroveTrialRegion';
import { MISTVEIL_SURFACE_PREFIX } from '../game/combat/MistveilTrialRegion';
import { MOONPINE_SURFACE_PREFIX } from '../game/combat/MoonpineTrialRegion';
import type { BiomeProfile } from './BiomeProfile';
import { CANOPY_BIOME } from './CanopyBiome';
import { GREENWAKE_BIOME } from './GreenwakeBiome';
import { GROVE_BIOME } from './GroveBiome';
import { MISTVEIL_BIOME } from './MistveilBiome';
import { MOONPINE_BIOME } from './MoonpineBiome';

/** Walk-surface id prefix of the Whispering Canopy playtest variant (`CanopyTrialRegion`); the authored region has none. */
export const CANOPY_PLAYTEST_SURFACE_PREFIX = 'canopy-trial-';

/** Playtest variants other than Greenwake: authored region id, the variant's walk-surface prefix and its biome. */
const VARIANT_BIOMES: readonly (readonly [string, string, BiomeProfile | undefined])[] = [
  ['whispering-canopy', CANOPY_PLAYTEST_SURFACE_PREFIX, CANOPY_BIOME],
  ['the-grove', GROVE_SURFACE_PREFIX, GROVE_BIOME],
  ['moonpine-ridge', MOONPINE_SURFACE_PREFIX, MOONPINE_BIOME],
  ['mistveil-basin', MISTVEIL_SURFACE_PREFIX, MISTVEIL_BIOME],
];

/**
 * The visual ground profile of a region, or `undefined` for regions that keep the generic procedural look (flat plates, one
 * style): Greenwake, and the playtest variants (recognised by their walk-surface prefix; the authored regions keep the generic look).
 */
export function biomeProfileFor(region: RegionDefinition): BiomeProfile | undefined {
  if (region.id === 'greenwake') return GREENWAKE_BIOME;
  const variant = VARIANT_BIOMES.find(([regionId, prefix]) => region.id === regionId && region.ground.surfaces.some((surface) => surface.id.startsWith(prefix)));
  return variant?.[2];
}
