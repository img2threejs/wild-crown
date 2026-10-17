import { HERO_COMBAT } from './HeroProfiles.js';
import type { PlayerSkillId } from './PlayerSkills.js';
import { hit, type HitSpec } from './reactions.js';

/**
 * Vesper, the Moonshade Blade (`umbral`). Uses the shared mana costs, hold thresholds and Instinct of PlayerSkills.
 * Every tick count is in simulation ticks at 60 Hz from the first tick of the skill; `*At` fields are the tick the effect lands.
 * Offensive durations and phase offsets share Vesper's attack rate, preserving normalized contact frames.
 * Cooldowns, hold thresholds, defensive actions and status lifetimes retain their own balance windows.
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

const attackTicks = (ticks: number): number => Math.round(ticks / HERO_COMBAT.vesper.attackPlaybackRate);

export const VESPER = {
  /** Passive Death Mark: three hits within the window mark the target; the next hit consumes it. */
  deathMark: { stacksRequired: 3, stackWindowTicks: 180, markTicks: 240, executionDamage: 25, executionHitStopTicks: 6 },
  /** A hit from behind (dot(target.facing, target→player) below the threshold) deals the multiplier. */
  backstab: { dotThreshold: -0.3, multiplier: 1.5 },
  /** Moonlit Iai chain; step 4 "Crescent Rift" dashes through the target (collision-safe) and is untouchable while dashing. */
  iai: {
    steps: [
      { ticks: attackTicks(27), activeAt: attackTicks(9), damage: 12, reach: 2.6, arcDegrees: 140 },
      { ticks: attackTicks(27), activeAt: attackTicks(9), damage: 12, reach: 2.6, arcDegrees: 140 },
      { ticks: attackTicks(33), activeAt: attackTicks(12), damage: 15, reach: 2.8, arcDegrees: 140 },
      { ticks: attackTicks(45), activeAt: attackTicks(15), damage: 22, reach: 2.8, arcDegrees: 140 },
    ] as readonly VesperIaiStep[],
    chainEarlyTicks: attackTicks(6), chainLateTicks: attackTicks(27),
    riftDashFrom: attackTicks(9), riftDashTo: attackTicks(21), riftDashDistance: 4.5,
  },
  shadowStep: { ticks: attackTicks(39), blinkAt: attackTicks(6), strikeAt: attackTicks(12), blinkRange: 9, fallbackDistance: 6, damage: 26 },
  thousandCuts: {
    ticks: attackTicks(108), strikeAt: [12, 27, 42, 57, 72, 87].map(attackTicks) as readonly number[], strikeDamage: 9,
    finisherAt: attackTicks(99), finisherDamage: 20, range: 8,
  },
  kunaiFan: {
    ticks: attackTicks(36), releaseAt: attackTicks(14), count: 3, spreadDegrees: 12, speed: 22, range: 16, damage: 9, radius: 0.15,
  },
  shadeSwap: {
    ticks: attackTicks(60), cloneLaunchAt: attackTicks(12), swapAt: attackTicks(45), dashDistance: 8, laneWidth: 1.4, damage: 24, untouchableTicks: 12,
  },
  severingShadow: { ticks: attackTicks(54), strikeAt: attackTicks(18), range: 7, damage: 10 },
  /** Cleanse keeps Aren's timing. */
  cleanse: { lockTicks: 90, activeAt: 35 },
  mistBlink: { distance: 6.5, durationTicks: 12, iframes: 14, recoveryTicks: 12, hideFrom: 0.10, hideTo: 0.60 },
  requiem: {
    ticks: attackTicks(180), markAt: attackTicks(9), markRadius: 12, slashFrom: attackTicks(18), slashInterval: attackTicks(18), slashCount: 7, slashDamage: 8,
    detonationAt: attackTicks(165), detonationDamage: 45,
  },
} as const;

/**
 * Weight, poise damage and knockback of every Vesper blow (reactions.ts). The iai cuts flinch (steps 1-2) and stagger (step 3);
 * the Crescent Rift finisher breaks poise (a stun for any non-boss). Thousand Cuts flinches every strike and ends in a knockdown.
 */
export const VESPER_HITS = {
  iai: [hit('light', 7, 0), hit('light', 8, 0), hit('medium', 14, 0), hit('finisher', 45, 1.8, { stun: true })] as readonly HitSpec[],
  shadowStep: hit('heavy', 24, 1.2),
  cut: hit('light', 3, 0),
  cutsFinisher: hit('finisher', 30, 2),
  sever: hit('medium', 10, 0),
  requiemSlash: hit('light', 3, 0),
  requiem: hit('finisher', 50, 2.5),
  kunai: hit('light', 3, 0),
  clone: hit('heavy', 22, 1.5),
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
