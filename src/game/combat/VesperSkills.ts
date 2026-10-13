import type { PlayerSkillId } from './PlayerSkills.js';

/**
 * Vesper, the Moonshade Blade (`umbral`). Uses the shared mana costs, hold thresholds and Instinct of PlayerSkills.
 * Every tick count is in simulation ticks at 60 Hz from the first tick of the skill; `*At` fields are the tick the effect lands.
 */
export interface VesperIaiStep {
  readonly ticks: number;
  /** Tick the cut lands. */
  readonly activeAt: number;
  readonly damage: number;
  readonly reach: number;
  /** Cone width in degrees. */
  readonly arcDegrees: number;
}

export const VESPER = {
  /** Passive Death Mark: three hits within the window mark the target; the next hit consumes it. */
  deathMark: { stacksRequired: 3, stackWindowTicks: 180, markTicks: 240, executionDamage: 25, executionHitStopTicks: 6 },
  /** A hit from behind (dot(target.facing, target→player) below the threshold) deals the multiplier. */
  backstab: { dotThreshold: -0.3, multiplier: 1.5 },
  /** Moonlit Iai chain; step 4 "Crescent Rift" dashes through the target (collision-safe) and is untouchable while dashing. */
  iai: {
    steps: [
      { ticks: 18, activeAt: 6, damage: 12, reach: 2.6, arcDegrees: 140 },
      { ticks: 18, activeAt: 6, damage: 12, reach: 2.6, arcDegrees: 140 },
      { ticks: 22, activeAt: 8, damage: 15, reach: 2.8, arcDegrees: 140 },
      { ticks: 30, activeAt: 10, damage: 22, reach: 2.8, arcDegrees: 140 },
    ] as readonly VesperIaiStep[],
    chainEarlyTicks: 4, chainLateTicks: 18,
    riftDashFrom: 6, riftDashTo: 14, riftDashDistance: 4.5,
  },
  shadowStep: { ticks: 26, blinkAt: 4, strikeAt: 8, blinkRange: 9, fallbackDistance: 6, damage: 26 },
  thousandCuts: {
    ticks: 72, strikeAt: [8, 18, 28, 38, 48, 58] as readonly number[], strikeDamage: 9,
    finisherAt: 66, finisherDamage: 20, range: 8,
  },
  kunaiFan: {
    ticks: 24, releaseAt: 9, count: 3, spreadDegrees: 12, speed: 22, range: 16, damage: 9, radius: 0.15,
  },
  shadeSwap: {
    ticks: 40, cloneLaunchAt: 8, swapAt: 30, dashDistance: 8, laneWidth: 1.4, damage: 24, untouchableTicks: 12,
  },
  severingShadow: { ticks: 36, strikeAt: 12, range: 7, damage: 10 },
  /** Cleanse keeps Aren's timing. */
  cleanse: { lockTicks: 90, activeAt: 35 },
  mistBlink: { distance: 6.5, durationTicks: 12, iframes: 14, recoveryTicks: 12, hideFrom: 0.10, hideTo: 0.60 },
  requiem: {
    ticks: 120, markAt: 6, markRadius: 12, slashFrom: 12, slashInterval: 12, slashCount: 7, slashDamage: 8,
    detonationAt: 110, detonationDamage: 45,
  },
} as const;

export const VESPER_LABELS: Partial<Record<PlayerSkillId, string>> = {
  light: 'Moonlit Iai', heavy: 'Shadow Step', charged_heavy: 'Thousand Cuts',
  sigil_bolt: 'Kunai Fan', sigil_barrage: 'Shade Swap', root_tether: 'Severing Shadow',
  cleanse: 'Cleanse', dive: 'Mist Blink', judgement: 'Crimson Requiem',
};

export const VESPER_CLIPS: Readonly<Record<string, string>> = {
  light_1: 'vesper-iai-1', light_2: 'vesper-iai-2', light_3: 'vesper-iai-3', light_4: 'vesper-iai-4',
  heavy: 'vesper-shadow-step', heavy_charge: 'vesper-cuts-charge', charged_heavy: 'vesper-thousand-cuts',
  sigil_charge: 'vesper-shade-charge', sigil_bolt: 'vesper-kunai-fan', sigil_barrage: 'vesper-shade-swap',
  root_tether: 'vesper-severing-shadow', cleanse: 'vesper-cleanse', judgement: 'vesper-requiem',
  dodge: 'vesper-mist-blink',
};
