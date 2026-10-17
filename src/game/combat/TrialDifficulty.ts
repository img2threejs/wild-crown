import type { RegionId } from '../contracts.js';
import type { AttackDefinition } from './content.js';

/**
 * Progressive difficulty of the local combat-trial playtests (never the canonical encounters). Pure data: the engine reads these
 * numbers when it seeds monster HP, stamps hazards, paces casts and moves monsters.
 */
export interface TrialDifficulty {
  /** 0..11: map rank * 3 + stage index (the Grove names its three stage levels, see STAGE_LEVELS). */
  readonly level: number;
  /** Final stage of a map's run. */
  readonly boss: boolean;
  readonly vitality: number;
  /** Multiplies a hazard's authored damage at hit time. */
  readonly damageScale: number;
  /** Divides cast cadence and reposition ticks, and windup/recovery. */
  readonly aggression: number;
  /** Multiplies trial-monster advance, circle and retreat speeds. */
  readonly speedScale: number;
}

/** Maps in campaign order; regions absent from both tables are exempt from the ramp. */
const MAP_RANK: Readonly<Partial<Record<RegionId, number>>> = {
  greenwake: 0,
  'whispering-canopy': 1,
  'moonpine-ridge': 2,
  'mistveil-basin': 3,
};
/**
 * Explicit stage levels of a map that sits between ranks. The Grove sparring stays at authored strength (level 0), the Black Sap
 * incursion is one step up and the Memory Pool guardian, its final stage, is the boss at level 3 (a notch below the Canopy boss).
 */
const STAGE_LEVELS: Readonly<Partial<Record<RegionId, readonly number[]>>> = { 'the-grove': [0, 1, 3] };
/** Base vitality lifted from 100 → 160 so the Grove practice also gains meaningful health and later ranks still feel progressive. */
export const TRIAL_BASE_VITALITY = 160;
const WINDUP_FLOOR = 36;
/** Hard commit floor so an unavoidable strike still reads before its hit lands. */
const COMMIT_FLOOR = 12;
/**
 * Hard ceiling on the aggression multiplier per stage. Without it, late ranks compress windup/recovery so far that
 * telegraphs disappear and the player loses readable reaction windows. The ceiling still keeps later fights harder
 * (damage and speed continue to scale), but never via opaque fast windups.
 */
const AGGRESSION_MAX = 1.18;
const NEUTRAL: TrialDifficulty = Object.freeze({ level: 0, boss: false, vitality: TRIAL_BASE_VITALITY, damageScale: 1, aggression: 1, speedScale: 1 });

/** Difficulty of one stage of a region's trial run. */
export function trialDifficulty(regionId: RegionId, stageIndex: number, stageCount: number): TrialDifficulty {
  const rank = MAP_RANK[regionId], explicit = STAGE_LEVELS[regionId]?.[stageIndex];
  if (rank === undefined && explicit === undefined) return NEUTRAL;
  const level = explicit ?? rank! * 3 + stageIndex;
  const boss = stageIndex === stageCount - 1;
  const aggression = Math.min(AGGRESSION_MAX, 1 + 0.03 * level + (boss ? 0.06 : 0));
  return Object.freeze({
    level,
    boss,
    vitality: Math.round(TRIAL_BASE_VITALITY * (1 + 0.15 * level) * (boss ? 2.2 : 1)),
    damageScale: (1 + 0.05 * level) * (boss ? 1.35 : 1),
    aggression,
    speedScale: 1 + 0.02 * level + (boss ? 0.08 : 0),
  });
}

/** Every stage's difficulty in order; computed once per region load so per-tick readers never allocate. */
export function trialRamp(regionId: RegionId, stageCount: number): readonly TrialDifficulty[] {
  return Array.from({ length: stageCount }, (_, index) => trialDifficulty(regionId, index, stageCount));
}

/** Rank pressure acts on the already-slowed wildlife timing, never applies the baseline slowdown twice. */
export function scaleTrialAttack(def: AttackDefinition, aggression: number): AttackDefinition {
  const scale = 1 / aggression;
  const windupTicks = Math.max(WINDUP_FLOOR, Math.round(def.windupTicks * scale));
  const commitTicks = Math.max(COMMIT_FLOOR, def.commitTicks);
  const recoveryTicks = Math.round(def.recoveryTicks * scale);
  if (windupTicks === def.windupTicks && commitTicks === def.commitTicks && recoveryTicks === def.recoveryTicks) return def;
  return { ...def, windupTicks, commitTicks, recoveryTicks };
}