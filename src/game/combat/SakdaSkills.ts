import type { PlayerSkillId } from './PlayerSkills.js';

/**
 * Sakda, the Ember Fist (`ember`). Uses the shared mana costs, hold thresholds and Instinct of PlayerSkills.
 * Every tick count is in simulation ticks at 60 Hz from the first tick of the skill; `*At` fields are the tick the effect lands.
 */
export interface SakdaLimbStep {
  readonly ticks: number;
  readonly activeAt: number;
  readonly damage: number;
  readonly reach: number;
  /** Forward step in metres taken by the strike (clinch knee). */
  readonly stepMetres?: number;
  /** Cone width in degrees; 360 is a full ring. */
  readonly arcDegrees?: number;
  /** Extra ember ring around Sakda: radius (m), damage and how many ticks it keeps hitting. It is a separate strike from the kick, with its own hit tracking. */
  readonly ring?: { readonly radius: number; readonly damage: number; readonly ticks: number };
}

export const SAKDA = {
  /** Passive Flurry: after any skill but J, the next `charges` J hits within the window play faster and restore mana. */
  flurry: { charges: 2, windowTicks: 180, speedBonus: 0.35, manaPerHit: 6 },
  /** Eight Limbs chain: jab-cross, rising elbow, clinch knee, roundhouse. */
  limbs: {
    steps: [
      { ticks: 20, activeAt: 7, damage: 10, reach: 2.0 },
      { ticks: 22, activeAt: 8, damage: 11, reach: 2.0 },
      { ticks: 26, activeAt: 10, damage: 14, reach: 2.2, stepMetres: 0.6 },
      { ticks: 32, activeAt: 13, damage: 18, reach: 2.6, arcDegrees: 200, ring: { radius: 3, damage: 8, ticks: 8 } },
    ] as readonly SakdaLimbStep[],
    chainEarlyTicks: 4, chainLateTicks: 18,
  },
  echoWave: { ticks: 24, releaseAt: 9, speed: 26, range: 14, width: 0.8, damage: 16, markTicks: 180 },
  resonatingStrike: {
    ticks: 30, dashFrom: 4, dashTo: 18, maxDashSpeed: 24, maxDashRange: 14, impactAt: 18,
    damage: 18, missingHealthRatio: 0.08, missingHealthCap: 30,
  },
  hundredElbows: {
    ticks: 60, dashFrom: 0, dashTo: 8, dashDistance: 3, hitAt: [12, 18, 24, 30, 36, 42] as readonly number[],
    hitDamage: 7, uppercutAt: 52, uppercutDamage: 14,
  },
  tempestStomp: { ticks: 28, activeAt: 12, radius: 4, damage: 20, crippleTicks: 120, crippleSpeedFactor: 0.6 },
  flyingKnee: {
    ticks: 40, leapFrom: 4, leapTo: 30, range: 10, impactAt: 30, damage: 38, ringRadius: 3, ringDamage: 12,
  },
  ironClinch: { ticks: 36, strikeAt: 12, range: 6, damage: 8 },
  /** Cleanse keeps Aren's timing. */
  cleanse: { lockTicks: 90, activeAt: 35 },
  /** Guard Dash (Safeguard): the shield absorbs damage before vitality. The design table gives no recovery; 14 ticks is the authored choice. */
  guardDash: { distance: 5.5, durationTicks: 18, iframes: 8, recoveryTicks: 14, shield: 25, shieldTicks: 120 },
  tigersWrath: {
    ticks: 60, untargetableTo: 30, kickAt: 24, dashRange: 2, damage: 60, knockback: 7, staggerTicks: 90, slideDamage: 40,
  },
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
