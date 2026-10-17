import type { RegionDefinition } from '../game/contracts';
import { GROVE_SURFACE_PREFIX } from '../content/levels/grove-layout';
import { MISTVEIL_SURFACE_PREFIX } from '../game/combat/MistveilTrialRegion';
import { MOONPINE_SURFACE_PREFIX } from '../game/combat/MoonpineTrialRegion';
import type { BiomeProfile } from './BiomeProfile';
import { BAMBOO_BIOME } from './BambooBiome';
import { CANOPY_BIOME } from './CanopyBiome';
import { GREENWAKE_BIOME } from './GreenwakeBiome';
import { GROVE_BIOME } from './GroveBiome';
import { HOLLOW_STORY_BIOME, MISTVEIL_STORY_BIOME, MOONPINE_STORY_BIOME, REFUGE_STORY_BIOME, SUNMANE_STORY_BIOME } from './LaterBiomes';
import { MISTVEIL_BIOME } from './MistveilBiome';
import { MOONPINE_BIOME } from './MoonpineBiome';

export const CANOPY_PLAYTEST_SURFACE_PREFIX = 'canopy-trial-';

const VARIANT_BIOMES: readonly (readonly [string, string, BiomeProfile | undefined])[] = [
  ['whispering-canopy', CANOPY_PLAYTEST_SURFACE_PREFIX, CANOPY_BIOME],
  ['the-grove', GROVE_SURFACE_PREFIX, GROVE_BIOME],
  ['moonpine-ridge', MOONPINE_SURFACE_PREFIX, MOONPINE_BIOME],
  ['mistveil-basin', MISTVEIL_SURFACE_PREFIX, MISTVEIL_BIOME],
  // Story-layout chapter regions: their surfaces start with the region id (the trial surfaces start with `moonpine-trial-` etc).
  ['moonpine-ridge', 'moonpine-ridge-', MOONPINE_STORY_BIOME],
  ['mistveil-basin', 'mistveil-basin-', MISTVEIL_STORY_BIOME],
  ['sunmane-expanse', 'sunmane-expanse-', SUNMANE_STORY_BIOME],
  ['refuge', 'refuge-', REFUGE_STORY_BIOME],
  ['heartroot-hollow', 'heartroot-hollow-', HOLLOW_STORY_BIOME],
];

export function biomeProfileFor(region: RegionDefinition): BiomeProfile | undefined {
  if (region.id === 'greenwake') return GREENWAKE_BIOME;
  if (region.id === 'blood-bamboo-valley') return BAMBOO_BIOME;
  const variant = VARIANT_BIOMES.find(([regionId, prefix]) => region.id === regionId && region.ground.surfaces.some((surface) => surface.id.startsWith(prefix)));
  return variant?.[2];
}