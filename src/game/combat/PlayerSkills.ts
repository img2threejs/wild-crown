export const MAX_MANA = 100;
export const PLAYER_MAX_VITALITY = 100;
/** Grounded locomotion speeds in metres per second (Shift selects run). */
export const PLAYER_WALK_SPEED = 4.1;
export const PLAYER_RUN_SPEED = 6;
/** Only player-controlled grounded locomotion earns mana; evasions cannot repay themselves. */
export const MANA_PER_METRE = 4;
/**
 * Player skill catalogue with shared mana cost and a cooldown in simulation ticks from accepted cast.
 * Heavy and Charged Heavy share one family lock; Sigil Bolt and Barrage share another: the family lock uses the
 * selected skill's cooldownTicks. Jump must remain usable mid-air (double jump), so its cooldown is 0;
 * Cleanse is a progression action with no combat cooldown; Light combo cooldown is 0 because the combo gating
 * is the chain window itself.
 */
export const PLAYER_SKILLS = Object.freeze({
  dive: { label: 'Dive', binding: 'dodge', manaCost: 25, cooldownTicks: 90 },
  jump: { label: 'Jump', binding: 'jump', manaCost: 8, cooldownTicks: 0 },
  light: { label: 'Warden Blade', binding: 'light', manaCost: 0, cooldownTicks: 0 },
  heavy: { label: 'Heavy', binding: 'heavy', manaCost: 12, cooldownTicks: 180 },
  charged_heavy: { label: 'Thunder Cleave', binding: 'heavy', manaCost: 20, cooldownTicks: 300 },
  sigil_bolt: { label: 'Sigil Bolt', binding: 'ranged', manaCost: 15, cooldownTicks: 150 },
  sigil_barrage: { label: 'Barrage', binding: 'ranged', manaCost: 35, cooldownTicks: 300 },
  judgement: { label: 'Judgement', binding: 'ultimate', manaCost: 0, cooldownTicks: 900 },
  root_tether: { label: 'Root Tether', binding: 'ability', manaCost: 20, cooldownTicks: 300 },
  cleanse: { label: 'Cleanse', binding: 'ability', manaCost: 30, cooldownTicks: 0 },
  ferocity: { label: 'Ferocity', binding: 'ability', manaCost: 30, cooldownTicks: 240 },
  corruption: { label: 'Corruption', binding: 'ability', manaCost: 25, cooldownTicks: 240 },
} as const);
export type PlayerSkillId = keyof typeof PLAYER_SKILLS;
export function playerSkillId(action: string): PlayerSkillId {
  return action.startsWith('light_') ? 'light' : action as PlayerSkillId;
}

/** Targeted strikes: geometry, damage and coordinated animation/contact/recovery timing (60 Hz). */
export const TARGETED_STRIKES = Object.freeze({
  heavy: { range: 2.5, radius: 1, damage: 22, interrupt: true, ticks: 68, activeAt: 30, recoveryTicks: 27 },
  charged_heavy: { range: 2.8, radius: 1.15, damage: 36, interrupt: true, ticks: 87, activeAt: 54, recoveryTicks: 27 },
  ferocity: { range: 2.5, radius: 1, damage: 24, interrupt: true, ticks: 63, activeAt: 18, recoveryTicks: 27 },
  corruption: { range: 2.5, radius: 1, damage: 18, interrupt: true, ticks: 63, activeAt: 18, recoveryTicks: 27 },
  root_tether: { range: 6, radius: 0.4, damage: 0, interrupt: true, ticks: 54, activeAt: 18, recoveryTicks: 27 },
  cleanse: { range: 2.5, radius: 1, damage: 0, interrupt: false, ticks: 90, activeAt: 35, recoveryTicks: 18 },
} as const);
type TargetedStrikeId = keyof typeof TARGETED_STRIKES;
function isTargetedStrike(action: string): action is TargetedStrikeId { return Object.hasOwn(TARGETED_STRIKES, action); }
/** Unlisted actions (e.g. scripted interactions) resolve like Cleanse: in reach, no damage, no interrupt. */
export function targetedStrike(action: string): (typeof TARGETED_STRIKES)[TargetedStrikeId] {
  return isTargetedStrike(action) ? TARGETED_STRIKES[action] : TARGETED_STRIKES.cleanse;
}

/** Instinct a full Warden's Judgement requires and consumes. */
export const JUDGEMENT_INSTINCT = 100;

/**
 * Warden Blade melee combo, in simulation ticks from action start. `activeFrom`..`activeTo` is inclusive.
 * A step may chain from `ticks - CHAIN_EARLY_TICKS` through `ticks + CHAIN_LATE_TICKS`; otherwise the combo restarts.
 * All phase offsets (ticks, activeFrom, activeTo, spin range, wave spawn) scale together at 1.5× so the normalized
 * native contact frame stays aligned across the combo.
 */
export interface LightStep {
  readonly ticks: number; readonly activeFrom: number; readonly activeTo: number;
  /** Metres from Aren's root, plus the target's body radius. */
  readonly reach: number;
  /** Full sector aperture in radians around Aren's facing (2π = every direction). */
  readonly arc: number;
  readonly damage: number; readonly hitStopTicks: number; readonly intensity: number;
  /** Facing makes one full turn across these ticks (light_3). */
  readonly spin?: { readonly from: number; readonly to: number };
  /** Spawns a crescent-wave projectile on this tick when the mana is there. */
  readonly waveAt?: number;
}
export const LIGHT_STEPS: readonly LightStep[] = Object.freeze([
  { ticks: 39, activeFrom: 14, activeTo: 18, reach: 2.3, arc: 2.4, damage: 9, hitStopTicks: 3, intensity: 1 },
  { ticks: 42, activeFrom: 15, activeTo: 20, reach: 2.4, arc: 2.4, damage: 11, hitStopTicks: 3, intensity: 1 },
  { ticks: 51, activeFrom: 15, activeTo: 27, reach: 2.8, arc: Math.PI * 2, damage: 13, hitStopTicks: 4, intensity: 1.3, spin: { from: 12, to: 30 } },
  { ticks: 60, activeFrom: 23, activeTo: 27, reach: 2.5, arc: 2.4, damage: 14, hitStopTicks: 6, intensity: 1.6, waveAt: 23 },
].map(step => Object.freeze(step)));
export const CHAIN_EARLY_TICKS = 6;
export const CHAIN_LATE_TICKS = 27;
/** Aren stays rooted until this many ticks before a light step's clip ends. */
export const LIGHT_LOCK_MARGIN_TICKS = 9;
/** A locked target this close pulls the swing's facing onto itself. */
export const LIGHT_ASSIST_RANGE = 4.5;

export const CRESCENT_WAVE = Object.freeze({ manaCost: 10, speed: 20, travel: 9, width: 2.8, damage: 12, hitStopTicks: 2, spawnForward: 0.8, height: 0.9 });

export const SIGIL = Object.freeze({
  boltTicks: 45, boltLockTicks: 33, boltLaunchTick: 24,
  barrageTicks: 60, barrageLockTicks: 48, barrageLaunchTicks: [12, 24, 36] as readonly number[], barrageAngles: [-12, 0, 12].map(degrees => degrees * Math.PI / 180) as readonly number[],
  barrageHoldTicks: 45, barrageSigilTicks: 12, chargeSustainTicks: 900,
  boltMana: 15, barrageMana: 35,
  forward: 0.9, height: 1.25,
  speed: 28, radius: 0.35, lifeTicks: 60, homingRange: 22, homingConeDegrees: 70, turnRate: 6,
  boltDamage: 14, barrageDamage: 12, instinct: 4, hitStopTicks: 2, staggerTicks: 15,
});

/** `holdTicks`: Heavy held at least this long (simulation ticks) releases as a charged Thunder Cleave. */
export const THUNDER_CLEAVE = Object.freeze({ holdTicks: 54, delayTicks: 12, radius: 3, damage: 18, hitStopTicks: 9, fallbackForward: 2.5, cueTicks: 27 });

export const JUDGEMENT = Object.freeze({
  ticks: 78, anticipationTicks: 15, dashFrom: 15, dashTo: 32, recoveryFrom: 33,
  dashDistance: 8, targetRange: 10, overshoot: 1.5,
  markCount: 5, markAngle: 0.6, markRadius: 2.2, markDamage: 12, detonationDelay: 36, detonationSpacing: 6, detonationHitStopTicks: 6,
  /** Dash ticks (counted from `dashFrom`) by which Aren has covered (i+1)/5 of the 17-tick dash, when mark `i` is dropped. */
  markOffsets: [3, 7, 10, 14, 17] as readonly number[],
});

/** World-clock freeze applied on a confirmed player hit; 7 ticks is full strength (intentionally not scaled with the combo). */
export const HIT_STOP_FULL_TICKS = 7;
/** Heavy-class blows (Heavy, Ferocity, Corruption) and the Charged Heavy / Thunder Cleave.
 *  Hit-stop ticks are heavier than before so impactful blows read clearly; the world-clock freeze still ages the
 *  same pre-aged particles, and the strength (ticks/7) clamps to 1 at full strength. */
export const HIT_STOP_TICKS = Object.freeze({ heavy: 7, charged: 9 });