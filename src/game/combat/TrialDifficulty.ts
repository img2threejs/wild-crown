import type { RegionId } from '../contracts.js';
import type { AttackDefinition } from './content.js';

/**
 * Progressive difficulty of the local combat-trial playtests (never the canonical encounters). Pure data: the engine reads these
 * numbers when it seeds monster HP, stamps hazards, paces casts and moves monsters.
 */
export interface TrialDifficulty {
  /** 0..11: map rank * 3 + stage index. */
  readonly level: number;
  /** Final stage of a map's run (the Grove has none). */
  readonly boss: boolean;
  readonly vitality: number;
  /** Multiplies a hazard's authored damage at hit time. */
  readonly damageScale: number;
  /** Divides cast cadence and reposition ticks, and windup/recovery. */
  readonly aggression: number;
  /** Multiplies trial-monster advance, circle and retreat speeds. */
  readonly speedScale: number;
}

/** Maps in campaign order; absent regions (the Grove) are exempt from the ramp. */
const MAP_RANK: Readonly<Partial<Record<RegionId, number>>> = {
  greenwake: 0,
  'whispering-canopy': 1,
  'moonpine-ridge': 2,
  'mistveil-basin': 3,
};
export const TRIAL_BASE_VITALITY = 100;
const WINDUP_FLOOR = 24;
const COMMIT_FLOOR = 8;
const NEUTRAL: TrialDifficulty = Object.freeze({ level: 0, boss: false, vitality: TRIAL_BASE_VITALITY, damageScale: 1, aggression: 1, speedScale: 1 });

/** Difficulty of one stage of a region's trial run. */
export function trialDifficulty(regionId: RegionId, stageIndex: number, stageCount: number): TrialDifficulty {
  const rank = MAP_RANK[regionId];
  if (rank === undefined) return NEUTRAL;
  const level = rank * 3 + stageIndex;
  const boss = stageIndex === stageCount - 1;
  return Object.freeze({
    level,
    boss,
    vitality: Math.round(TRIAL_BASE_VITALITY * (1 + 0.15 * level) * (boss ? 2.2 : 1)),
    damageScale: (1 + 0.05 * level) * (boss ? 1.35 : 1),
    aggression: 1 + 0.03 * level + (boss ? 0.1 : 0),
    speedScale: 1 + 0.02 * level + (boss ? 0.08 : 0),
  });
}

/** Every stage's difficulty in order; computed once per region load so per-tick readers never allocate. */
export function trialRamp(regionId: RegionId, stageCount: number): readonly TrialDifficulty[] {
  return Array.from({ length: stageCount }, (_, index) => trialDifficulty(regionId, index, stageCount));
}

/** Tightens an already pressure-scaled attack: windup and recovery shrink by `1 / aggression`, keeping the 24 / 8 tick floors. */
export function scaleTrialAttack(def: AttackDefinition, aggression: number): AttackDefinition {
  if (aggression === 1) return def;
  const windupTicks = Math.max(WINDUP_FLOOR, Math.round(def.windupTicks / aggression));
  const commitTicks = Math.max(COMMIT_FLOOR, def.commitTicks);
  const recoveryTicks = Math.round(def.recoveryTicks / aggression);
  if (windupTicks === def.windupTicks && commitTicks === def.commitTicks && recoveryTicks === def.recoveryTicks) return def;
  return { ...def, windupTicks, commitTicks, recoveryTicks };
}
