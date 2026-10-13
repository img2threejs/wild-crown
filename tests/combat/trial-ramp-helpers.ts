import type { RegionId } from '../../src/game/contracts.js';
import { trialDifficulty } from '../../src/game/combat/TrialDifficulty.js';

/** The authored [windup, commit, active, recovery] of an attack as it plays at `stageIndex` of a map's trial run (pressure tier 0). */
export function rampedTiming(regionId: RegionId, stageIndex: number, stageCount: number, timing: readonly [number, number, number, number]): [number, number, number, number] {
  const { aggression } = trialDifficulty(regionId, stageIndex, stageCount);
  const [windup, commit, active, recovery] = timing;
  return [Math.max(24, Math.round(windup / aggression)), Math.max(8, commit), active, Math.round(recovery / aggression)];
}

/** The damage the player loses from an attack of authored `damage` cast at `stageIndex` of a map's trial run. */
export function rampedDamage(regionId: RegionId, stageIndex: number, stageCount: number, damage: number): number {
  return Math.round(damage * trialDifficulty(regionId, stageIndex, stageCount).damageScale);
}
