import type { CompanionElement, CompanionId, FieldCommand } from '../contracts.js';

export interface CompanionSkill {
  readonly id: string;
  readonly companionId: CompanionId;
  readonly command: FieldCommand;
  readonly element: CompanionElement;
  readonly label: string;
  readonly description: string;
  readonly automatic: string;
  readonly actionId: string;
  readonly nativeAction: string;
  readonly ticks: number;
  readonly release: number;
  readonly contact: number;
  readonly target: 'hostile' | 'charge' | 'object' | 'search';
}
/** One primary combat benefit per companion. Durations use world ticks; hero skill deadlines use simulation ticks. */
export const COMPANION_SPECIALIZATIONS: Readonly<Record<CompanionId, { role: string; element: CompanionElement; cooldownTicks: number }>> = {
  asha: { role: 'Control', element: 'earth', cooldownTicks: 720 },
  sable: { role: 'Slow', element: 'water', cooldownTicks: 600 },
  koro: { role: 'Healing', element: 'wood', cooldownTicks: 840 },
  vara: { role: 'Haste', element: 'wind', cooldownTicks: 600 },
  nyra: { role: 'Cooldown', element: 'lightning', cooldownTicks: 720 },
  solkar: { role: 'Power', element: 'fire', cooldownTicks: 720 },
};
export const COMPANION_BALANCE = {
  healFraction: .08,
  hasteMultiplier: 1.12, hasteTicks: 240,
  powerMultiplier: 1.12, powerTicks: 300,
  slowFactor: .65, slowTicks: 240, bossSlowFactor: .85, bossSlowTicks: 180,
  stunTicks: 60, bossStunTicks: 15, controlImmunityTicks: 600,
  cooldownReduction: .2, cooldownReductionCap: 90,
  ownerRange: 12, minorDamage: 4,
} as const;

/** Only implemented skills belong here. Story recruitment grants Bond, not access to these actions. */
export const COMPANION_SKILLS: readonly CompanionSkill[] = [
  { id: 'storm-talon', companionId: 'vara', command: 'special', element: 'wind', label: 'Storm Talon', description: 'A native climb-and-dive carries a tailwind to you: +12% movement speed for 4 seconds. Only 4 damage (6 if marked); consumes the mark. 10-second support cooldown.', automatic: 'Marks an engaged threat, then dives to refresh your tailwind when a token can be spared.', actionId: 'vara:takeoff', nativeAction: 'vara:takeoff', ticks: 99, release: .24, contact: .45, target: 'hostile' },
  { id: 'sky-mark', companionId: 'vara', command: 'focus', element: 'lightning', label: 'Mark Weakness', description: 'A wing-spread screech marks one visible enemy for 5 seconds. Free; the next dive consumes its small 2-damage bonus.', automatic: 'Marks the current threat before her next dive.', actionId: 'vara-sky-mark', nativeAction: 'vara-sky-mark', ticks: 48, release: .35, contact: .5, target: 'hostile' },
  { id: 'canopy-route', companionId: 'koro', command: 'special', element: 'wood', label: 'Mending Seed', description: 'Toss a Wood seed at a nearby enemy. On contact, restore 8% of your maximum Vitality, never above full health. No vitality damage. 14-second support cooldown.', automatic: 'Mends you below 85% Vitality while an enemy is engaged.', actionId: 'koro-canopy-route', nativeAction: 'koro-throw', ticks: 72, release: .44, contact: .68, target: 'hostile' },
  { id: 'canopy-move', companionId: 'koro', command: 'special', element: 'earth', label: 'Move Object', description: 'Walk to a marked movable object, plant both hands and push it along its authored route. Equip Koro; does not share Mending Seed’s cooldown.', automatic: 'Objects move only on your order; story interactions are never triggered automatically.', actionId: 'koro-move-object', nativeAction: 'koro-push', ticks: 90, release: .24, contact: .42, target: 'object' },
  { id: 'canopy-distract', companionId: 'koro', command: 'distract', element: 'wood', label: 'Distract', description: 'An arm-wave draws a non-boss enemy’s attention for 3 seconds. Free; the same target cannot be locked into a permanent distraction.', automatic: 'Use on command when you want Koro to draw attention.', actionId: 'koro-distract', nativeAction: 'koro-distract', ticks: 66, release: .32, contact: .5, target: 'hostile' },
  { id: 'fang-guard', companionId: 'asha', command: 'special', element: 'earth', label: 'Charge Block', description: 'Intercept one reachable, committed guardable charge aimed at you. No vitality damage. Shares Asha’s 12-second support cooldown with Pin.', automatic: 'Intercepts a reachable charge before using Pin.', actionId: 'asha-fang-guard', nativeAction: 'monster-roar', ticks: 84, release: .25, contact: .5, target: 'charge' },
  { id: 'fang-pin', companionId: 'asha', command: 'focus', element: 'fire', label: 'Searing Pin', description: 'A forepaw pins an unarmoured enemy for 1 second; bosses resist to 0.25 seconds and keep committed attacks. No vitality damage or stun chaining. Shares Charge Block’s cooldown.', automatic: 'Pins an engaged enemy when no charge needs intercepting.', actionId: 'asha-pin', nativeAction: 'monster-slash', ticks: 72, release: .36, contact: .55, target: 'hostile' },
  { id: 'pack-flank', companionId: 'sable', command: 'special', element: 'water', label: 'Undertow Flank', description: 'Circle and lunge to slow enemy movement by 35% for 4 seconds. Bosses resist to 15% for 3 seconds. No vitality damage; never extends a stronger hero slow. 10-second cooldown.', automatic: 'Flanks the enemy threatening you, then applies Undertow.', actionId: 'sable-pack-flank', nativeAction: 'monster-jump', ticks: 72, release: .32, contact: .58, target: 'hostile' },
  { id: 'shadow-ambush', companionId: 'nyra', command: 'special', element: 'lightning', label: 'Static Ambush', description: 'A low pounce restores tempo: cut your remaining skill cooldowns by 20%, at most 1.5 seconds per skill. No vitality damage. 12-second support cooldown.', automatic: 'Pounces on an engaged threat when at least one of your skills is cooling down.', actionId: 'nyra-shadow-ambush', nativeAction: 'monster-dive', ticks: 60, release: .26, contact: .52, target: 'hostile' },
  { id: 'crown-rally', companionId: 'solkar', command: 'special', element: 'fire', label: 'Ember Rally', description: 'Roar beside a threat to give you +12% strike damage for 5 seconds. No Instinct refill, healing, ally cooldown reduction or vitality damage. 12-second support cooldown.', automatic: 'Rallies while you fight; the power boon never stacks with itself.', actionId: 'solkar-crown-rally', nativeAction: 'monster-roar', ticks: 96, release: .28, contact: .48, target: 'hostile' },
];

const SEARCH_LABEL: Readonly<Record<CompanionId, string>> = { vara: 'Sky Survey', koro: 'Canopy Search', asha: 'Fang Search', sable: 'Track', nyra: 'Reveal Traces', solkar: 'Pride Survey' };
const SEARCH_ELEMENT: Readonly<Record<CompanionId, CompanionElement>> = { vara: 'wind', koro: 'wood', asha: 'earth', sable: 'water', nyra: 'shadow', solkar: 'light' };
/** Field Search uses each species’ own native gesture, never a fabricated route/reward. */
export const COMPANION_SEARCH_SKILLS: readonly CompanionSkill[] = (Object.keys(SEARCH_LABEL) as CompanionId[]).map(companionId => ({
  id: `${companionId}-search`, companionId, command: 'search', element: SEARCH_ELEMENT[companionId], label: SEARCH_LABEL[companionId],
  description: 'Investigate a discovered trace or survey nearby ground to reveal traps. Free; available to your one equipped companion.',
  automatic: 'Searching and story interactions wait for your order.', actionId: `${companionId}-search`,
  nativeAction: companionId === 'vara' ? 'vara-sky-survey' : companionId === 'koro' ? 'koro-search' : 'monster-shoot',
  ticks: 60, release: .2, contact: .9, target: 'search',
}));

const DISTRACTORS: readonly CompanionId[] = ['asha', 'sable', 'nyra', 'solkar'];
const FIELD_DISTRACTIONS: readonly CompanionSkill[] = DISTRACTORS.map(companionId => ({
  id: `${companionId}-distract`, companionId, command: 'distract', element: companionId === 'asha' ? 'fire' : companionId === 'sable' ? 'ice' : companionId === 'nyra' ? 'shadow' : 'light', label: 'Distract',
  description: 'Turn and taunt a non-boss enemy to draw attention for 3 seconds. Free; a recovery gap prevents a permanent distraction lock.',
  automatic: 'Attention changes only on your order.', actionId: `${companionId}-distract`, nativeAction: 'monster-turn',
  ticks: 66, release: .32, contact: .5, target: 'hostile',
}));

export const ALL_COMPANION_SKILLS: readonly CompanionSkill[] = [...COMPANION_SKILLS, ...COMPANION_SEARCH_SKILLS, ...FIELD_DISTRACTIONS];
const BY_ACTION = new Map(ALL_COMPANION_SKILLS.map(skill => [skill.actionId, skill]));
export const companionSkillByAction = (actionId: string): CompanionSkill | undefined => BY_ACTION.get(actionId);
export function companionSkillFor(id: CompanionId, command: FieldCommand, object = false): CompanionSkill | undefined {
  if (command === 'search') return COMPANION_SEARCH_SKILLS.find(skill => skill.companionId === id);
  if (command === 'distract') return ALL_COMPANION_SKILLS.find(skill => skill.companionId === id && skill.command === 'distract');
  if (id === 'asha' && command === 'focus') return COMPANION_SKILLS.find(skill => skill.id === 'fang-pin');
  if (id === 'koro' && object) return COMPANION_SKILLS.find(skill => skill.id === 'canopy-move');
  if (command === 'focus' && id !== 'vara') return COMPANION_SKILLS.find(skill => skill.companionId === id && skill.command === 'special' && skill.target === 'hostile');
  return COMPANION_SKILLS.find(skill => skill.companionId === id && skill.command === command && !['object', 'search'].includes(skill.target));
}
