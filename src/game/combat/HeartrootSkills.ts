import type { PlayerSkillId } from './PlayerSkills.js';

/** Action/contact offsets share the simulation clock; projectile lifetime and mana costs are independent. */
export const HEARTROOT = {
  thornDamage: 16, twinDamage: 12, seedDamage: 32, seedRadius: 2.4,
  projectileSpeed: 14, projectileTicks: 90,
  spikeRange: 9, spikeWidth: 1.5, spikeDamage: 37, spikeAt: 30, spikeTicks: 95,
  eruptionRange: 12, eruptionRadius: 3, eruptionDamage: 55, eruptionAt: 54, eruptionTicks: 114,
  lanceRange: 14, lanceWidth: 0.65, lanceDamage: 40,
  stormTicks: 90, stormLockTicks: 75, stormLaunches: [18, 27, 36, 45, 54, 63] as readonly number[], stormDamage: 13,
  bloomTicks: 234, bloomRadius: 8, meteorFrom: 45, meteorInterval: 15, meteorCount: 9,
  meteorRadius: 1.8, meteorDamage: 13, bloomPulseAt: 198, bloomPulseDamage: 58,
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
