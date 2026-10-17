import { HERO_COMBAT } from './HeroProfiles.js';
import type { PlayerSkillId } from './PlayerSkills.js';
import { hit, type HitSpec } from './reactions.js';

/**
 * Sakda, the Ember Fist (`ember`). Uses the shared mana costs, hold thresholds and Instinct of PlayerSkills.
 * Every tick count is in simulation ticks at 60 Hz from the first tick of the skill; `*At` fields are the tick the effect lands.
 * Offensive durations and phase offsets share Sakda's attack rate, preserving normalized contact frames.
 * Cooldowns, hold thresholds, defensive actions and status lifetimes retain their own balance windows.
 */
export interface SakdaLimbStep {
  readonly ticks: number;
  readonly activeAt: number;
  readonly damage: number;
  readonly reach: number;
  /** Forward step in metres taken by the strike (clinch knee). */
  readonly stepMetres?: number;
  /** Magnetism: metres closed towards the locked target over the windup (never into its body, never without a target). */
  readonly lungeMetres?: number;
  /** Cone width in degrees; 360 is a full ring. */
  readonly arcDegrees?: number;
  /** Extra ember ring around Sakda: radius (m), damage and how many ticks it keeps hitting. It is a separate strike from the kick, with its own hit tracking. */
  readonly ring?: { readonly radius: number; readonly damage: number; readonly ticks: number };
}

const attackTicks = (ticks: number): number => Math.round(ticks / HERO_COMBAT.sakda.attackPlaybackRate);

export const SAKDA = {
  /** Passive Flurry: after any skill but J, the next `charges` J hits within the window play faster and restore mana. */
  flurry: { charges: 2, windowTicks: 180, speedBonus: 0.35, manaPerHit: 6 },
  /** Eight Limbs chain: jab-cross, rising elbow, clinch knee, roundhouse. */
  limbs: {
    steps: [
      { ticks: attackTicks(30), activeAt: attackTicks(11), damage: 10, reach: 2.0, lungeMetres: 0.4 },
      { ticks: attackTicks(33), activeAt: attackTicks(12), damage: 11, reach: 2.0, lungeMetres: 0.5 },
      { ticks: attackTicks(39), activeAt: attackTicks(15), damage: 14, reach: 2.2, stepMetres: 0.6 },
      { ticks: attackTicks(48), activeAt: attackTicks(20), damage: 18, reach: 2.6, lungeMetres: 1, arcDegrees: 200, ring: { radius: 3, damage: 8, ticks: attackTicks(8) } },
    ] as readonly SakdaLimbStep[],
    chainEarlyTicks: attackTicks(6), chainLateTicks: attackTicks(27),
  },
  echoWave: { ticks: attackTicks(36), releaseAt: attackTicks(14), speed: 26, range: 14, width: 0.8, damage: 16, markTicks: 180 },
  resonatingStrike: {
    ticks: attackTicks(45), dashFrom: attackTicks(6), dashTo: attackTicks(27), maxDashSpeed: 24, maxDashRange: 14, impactAt: attackTicks(27),
    damage: 18, missingHealthRatio: 0.08, missingHealthCap: 30,
  },
  hundredElbows: {
    ticks: attackTicks(90), dashFrom: 0, dashTo: attackTicks(12), dashDistance: 3, hitAt: [18, 27, 36, 45, 54, 63].map(attackTicks) as readonly number[],
    hitDamage: 7, uppercutAt: attackTicks(78), uppercutDamage: 14,
  },
  tempestStomp: { ticks: attackTicks(42), activeAt: attackTicks(18), radius: 4, damage: 20, crippleTicks: 120, crippleSpeedFactor: 0.6 },
  flyingKnee: {
    ticks: attackTicks(60), leapFrom: attackTicks(6), leapTo: attackTicks(45), range: 10, impactAt: attackTicks(45), damage: 38, ringRadius: 3, ringDamage: 12,
  },
  ironClinch: { ticks: attackTicks(54), strikeAt: attackTicks(18), range: 6, damage: 8 },
  /** Cleanse keeps Aren's timing. */
  cleanse: { lockTicks: 90, activeAt: 35 },
  /** Guard Dash (Safeguard): the shield absorbs damage before vitality. The design table gives no recovery; 14 ticks is the authored choice. */
  guardDash: { distance: 5.5, durationTicks: 18, iframes: 8, recoveryTicks: 14, shield: 25, shieldTicks: 120 },
  tigersWrath: {
    ticks: attackTicks(90), untargetableTo: attackTicks(45), kickAt: attackTicks(36), dashRange: 2, damage: 60, knockback: 7, staggerTicks: 90, slideDamage: 40,
  },
} as const;

/**
 * Weight, poise damage and knockback of every Sakda blow (reactions.ts). Eight Limbs climbs from a jab (flinch) through the rising
 * elbow (stagger) and the clinch knee (pushes a heavy body back) to the roundhouse, a finisher that knocks light bodies down; Hundred
 * Elbows staggers and ends in a knockdown uppercut; Tiger's Wrath always knocks the target down (its slide is the kit's own).
 */
export const SAKDA_HITS = {
  limbs: [hit('light', 6, 0), hit('medium', 12, 0.5), hit('heavy', 20, 1.2), hit('finisher', 32, 3)] as readonly HitSpec[],
  ring: hit('light', 4, 0),
  resonate: hit('heavy', 22, 1.4),
  elbow: hit('medium', 9, 0.2),
  uppercut: hit('finisher', 30, 2.2),
  stomp: hit('heavy', 26, 1.8),
  flyingKnee: hit('finisher', 34, 2.6),
  kneeRing: hit('medium', 10, 0.6),
  clinch: hit('medium', 10, 0),
  echo: hit('light', 5, 0),
  wrath: hit('finisher', 70, 0, { knockdown: true }),
  wrathSlide: hit('heavy', 20, 0),
} as const;

export const SAKDA_LABELS: Partial<Record<PlayerSkillId, string>> = {
  light: 'Eight Limbs', heavy: 'Tempest Stomp', charged_heavy: 'Flying Knee',
  sigil_bolt: 'Echo Wave', sigil_barrage: 'Hundred Elbows', root_tether: 'Iron Clinch',
  cleanse: 'Cleanse', dive: 'Guard Dash', judgement: "Tiger's Wrath",
};

export const SAKDA_CLIPS: Readonly<Record<string, string>> = {
  light_1: 'sakda-limb-1', light_2: 'sakda-limb-2', light_3: 'sakda-limb-3', light_4: 'sakda-limb-4',
  heavy: 'sakda-tempest', heavy_charge: 'sakda-knee-charge', charged_heavy: 'sakda-flying-knee',
  sigil_charge: 'sakda-elbow-charge', sigil_bolt: 'sakda-echo-wave', sigil_barrage: 'sakda-hundred-elbows',
  /** Second tap of Echo Wave on an echoed target. */
  sigil_recast: 'sakda-resonating-strike',
  root_tether: 'sakda-iron-clinch', cleanse: 'sakda-cleanse', judgement: 'sakda-tigers-wrath',
  dodge: 'sakda-guard-dash',
};
