import type { RegionId } from '../../src/game/contracts.js';
import { trialDifficulty } from '../../src/game/combat/TrialDifficulty.js';

/** The damage the player loses from an attack of authored `damage` cast at `stageIndex` of a map's trial run. */
export function rampedDamage(regionId: RegionId, stageIndex: number, stageCount: number, damage: number): number {
  return Math.round(damage * trialDifficulty(regionId, stageIndex, stageCount).damageScale);
}
