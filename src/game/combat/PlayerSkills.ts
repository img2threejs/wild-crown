export const MAX_MANA = 100;
export const PLAYER_MAX_VITALITY = 100;
/** Grounded locomotion speeds in metres per second (Shift selects run). */
export const PLAYER_WALK_SPEED = 4.1;
export const PLAYER_RUN_SPEED = 6;
/** Only player-controlled grounded locomotion earns mana; evasions cannot repay themselves. */
export const MANA_PER_METRE = 4;
export const PLAYER_SKILLS = Object.freeze({
  dive: { label: 'Dive', binding: 'dodge', manaCost: 25 },
  jump: { label: 'Jump', binding: 'jump', manaCost: 8 },
  light: { label: 'Warden Blade', binding: 'light', manaCost: 0 },
  heavy: { label: 'Heavy', binding: 'heavy', manaCost: 12 },
  charged_heavy: { label: 'Thunder Cleave', binding: 'heavy', manaCost: 20 },
  sigil_bolt: { label: 'Sigil Bolt', binding: 'ranged', manaCost: 15 },
  sigil_barrage: { label: 'Barrage', binding: 'ranged', manaCost: 35 },
  judgement: { label: 'Judgement', binding: 'ultimate', manaCost: 0 },
  root_tether: { label: 'Root Tether', binding: 'ability', manaCost: 20 },
  cleanse: { label: 'Cleanse', binding: 'ability', manaCost: 30 },
  ferocity: { label: 'Ferocity', binding: 'ability', manaCost: 30 },
  corruption: { label: 'Corruption', binding: 'ability', manaCost: 25 },
} as const);
export type PlayerSkillId = keyof typeof PLAYER_SKILLS;
export function playerSkillId(action: string): PlayerSkillId {
  return action.startsWith('light_') ? 'light' : action as PlayerSkillId;
}

/** Targeted player actions resolved through the pending-impact path: reach (m), hit radius (m), damage, interrupt. */
export const TARGETED_STRIKES = Object.freeze({
  heavy: { range: 2.5, radius: 1, damage: 22, interrupt: true },
  charged_heavy: { range: 2.8, radius: 1.15, damage: 36, interrupt: true },
  ferocity: { range: 2.5, radius: 1, damage: 24, interrupt: true },
  corruption: { range: 2.5, radius: 1, damage: 18, interrupt: true },
  root_tether: { range: 6, radius: 0.4, damage: 0, interrupt: true },
  cleanse: { range: 2.5, radius: 1, damage: 0, interrupt: false },
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
  { ticks: 26, activeFrom: 9, activeTo: 12, reach: 2.3, arc: 2.4, damage: 9, hitStopTicks: 3, intensity: 1 },
  { ticks: 28, activeFrom: 10, activeTo: 13, reach: 2.4, arc: 2.4, damage: 11, hitStopTicks: 3, intensity: 1 },
  { ticks: 34, activeFrom: 10, activeTo: 18, reach: 2.8, arc: Math.PI * 2, damage: 13, hitStopTicks: 4, intensity: 1.3, spin: { from: 8, to: 20 } },
  { ticks: 40, activeFrom: 15, activeTo: 18, reach: 2.5, arc: 2.4, damage: 14, hitStopTicks: 4, intensity: 1.6, waveAt: 15 },
].map(step => Object.freeze(step)));
export const CHAIN_EARLY_TICKS = 4;
export const CHAIN_LATE_TICKS = 18;
/** Aren stays rooted until this many ticks before a light step's clip ends. */
export const LIGHT_LOCK_MARGIN_TICKS = 6;
/** A locked target this close pulls the swing's facing onto itself. */
export const LIGHT_ASSIST_RANGE = 4.5;

export const CRESCENT_WAVE = Object.freeze({ manaCost: 10, speed: 20, travel: 9, width: 2.8, damage: 12, hitStopTicks: 2, spawnForward: 0.8, height: 0.9 });

export const SIGIL = Object.freeze({
  boltTicks: 30, boltLockTicks: 22, boltLaunchTick: 16,
  barrageTicks: 40, barrageLockTicks: 32, barrageLaunchTicks: [8, 16, 24] as readonly number[], barrageAngles: [-12, 0, 12].map(degrees => degrees * Math.PI / 180) as readonly number[],
  barrageHoldTicks: 30, barrageSigilTicks: 8, chargeSustainTicks: 600,
  boltMana: 15, barrageMana: 35,
  forward: 0.9, height: 1.25,
  speed: 28, radius: 0.35, lifeTicks: 60, homingRange: 22, homingConeDegrees: 70, turnRate: 6,
  boltDamage: 14, barrageDamage: 12, instinct: 4, hitStopTicks: 2, staggerTicks: 15,
});

/** `holdTicks`: Heavy held at least this long (simulation ticks) releases as a charged Thunder Cleave. */
export const THUNDER_CLEAVE = Object.freeze({ holdTicks: 36, delayTicks: 8, radius: 3, damage: 18, hitStopTicks: 7, fallbackForward: 2.5, cueTicks: 18 });

export const JUDGEMENT = Object.freeze({
  ticks: 52, anticipationTicks: 10, dashFrom: 10, dashTo: 21, recoveryFrom: 22,
  dashDistance: 8, targetRange: 10, overshoot: 1.5,
  markCount: 5, markAngle: 0.6, markRadius: 2.2, markDamage: 12, detonationDelay: 24, detonationSpacing: 4, detonationHitStopTicks: 6,
  /** Dash ticks (counted from `dashFrom`) by which Aren has covered (i+1)/5 of the 12-tick dash, when mark `i` is dropped. */
  markOffsets: [2, 4, 7, 9, 11] as readonly number[],
});

/** World-clock freeze applied on a confirmed player hit; 7 ticks is full strength. */
export const HIT_STOP_FULL_TICKS = 7;
/** Heavy-class blows (Heavy, Ferocity, Corruption) and the Charged Heavy / Thunder Cleave. */
export const HIT_STOP_TICKS = Object.freeze({ heavy: 5, charged: 7 });
