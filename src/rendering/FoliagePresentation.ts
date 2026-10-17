import { DEFAULT_FOLIAGE_LIMITS, type FoliageLimits } from './InstanceVisibility';

/**
 * Foliage presentation limits by static prop asset id (applied by `GameRenderer.loadRegion` to every placement batch of the asset, one batch per
 * 16 m cell). The Blood Bamboo grove cluster is drawn by the hundreds around the boss arenas and the hunter camp: it fades by screen-door
 * dither on an opaque, depth-writing material (the default alpha blend would shade every overlapping stem as a blended layer and leave the
 * boss, the telegraphs and the player to be drawn over it), and instances more than 64 m from the camera, three times the 21 m gameplay camera
 * offset (`GAMEPLAY_OFFSET`, 10/12/14 m) and inside the valley fog, are not drawn. Every other prop keeps the default limits.
 */
export const FOLIAGE_LIMITS: Readonly<Record<string, FoliageLimits>> = {
  'prop-bamboo-grove-cluster': { fade: 'dither', maxViewDistance: 64 },
};

export function foliageLimitsFor(assetId: string): FoliageLimits {
  return FOLIAGE_LIMITS[assetId] ?? DEFAULT_FOLIAGE_LIMITS;
}
