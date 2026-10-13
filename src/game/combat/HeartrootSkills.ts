import type { PlayerSkillId } from './PlayerSkills.js';

/** Uses the shared player action clocks, mana costs, charge thresholds and cancellation rules. */
export const HEARTROOT = {
  thornDamage: 16, twinDamage: 12, seedDamage: 32, seedRadius: 2.4,
  projectileSpeed: 14, projectileTicks: 90,
  spikeRange: 9, spikeWidth: 1.5, spikeDamage: 37, spikeAt: 20, spikeTicks: 63,
  eruptionRange: 12, eruptionRadius: 3, eruptionDamage: 55, eruptionAt: 36, eruptionTicks: 76,
  lanceRange: 14, lanceWidth: 0.65, lanceDamage: 40,
  stormLaunches: [12, 18, 24, 30, 36, 42] as readonly number[], stormDamage: 13,
  bloomTicks: 156, bloomRadius: 8, meteorFrom: 30, meteorInterval: 10, meteorCount: 9,
  meteorRadius: 1.8, meteorDamage: 13, bloomPulseAt: 132, bloomPulseDamage: 58,
} as const;

export const HEARTROOT_LABELS: Partial<Record<PlayerSkillId, string>> = {
  light: 'Thornshot', heavy: 'Root Spike', charged_heavy: 'Heartroot Eruption',
  sigil_bolt: 'Sap Lance', sigil_barrage: 'Seed Storm', root_tether: 'Binding Vines',
  cleanse: 'Cleanse', dive: 'Petal Step', judgement: 'Heartroot Bloom',
};

export const HEARTROOT_CLIPS: Readonly<Record<string, string>> = {
  light_1: 'yara-thornshot-1', light_2: 'yara-thornshot-2', light_3: 'yara-thornshot-3',
  heavy: 'yara-root-spike', charged_heavy: 'yara-root-eruption',
  sigil_charge: 'yara-seed-charge', sigil_bolt: 'yara-sap-lance', sigil_barrage: 'yara-seed-storm',
  root_tether: 'yara-binding-vines', cleanse: 'yara-cleanse', judgement: 'yara-heartroot-bloom',
};
