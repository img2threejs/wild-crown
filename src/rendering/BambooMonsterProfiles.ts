import type { LocomotionProfile } from './MonsterAnimationPlan';
import type { MonsterHoverProfile } from './MonsterAnimationProfiles';

/**
 * Blood Bamboo Valley native locomotion and story lifecycle clips. Combat attacks use their own continuous native clips
 * through EnemyAttackPresentation; the simulation remains the sole phase/window authority.
 */

/** Custom clip ids bound by the bamboo manifest entries one-to-one (`actionToClipMapping`); every one of them is a clip in the shipped GLB. */
export const BAMBOO_CLIP_ACTIONS = [
  'asha-stalk', 'asha-corrupted-idle', 'asha-stalk-pounce', 'asha-corrupt-slam', 'asha-bamboo-charge', 'asha-cleanse', 'asha-bond-idle',
  'tali-play', 'tali-nuzzle',
  'npc-talk-relaxed', 'npc-talk-explain', 'npc-talk-point', 'npc-talk-guarded',
  'hunter-thrust', 'hunter-subdue', 'hunter-kneel-idle',
] as const;
export type BambooClipAction = typeof BAMBOO_CLIP_ACTIONS[number];

/** Authored clip length (seconds, 30 fps) of every custom clip: clips-report `clips[id].durationSeconds`. */
export const BAMBOO_CLIP_SECONDS: Readonly<Record<BambooClipAction, number>> = {
  'asha-stalk': 1.2, 'asha-corrupted-idle': 2.4, 'asha-stalk-pounce': 1.5, 'asha-corrupt-slam': 1.8, 'asha-bamboo-charge': 1.6, 'asha-cleanse': 2.8, 'asha-bond-idle': 4,
  'tali-play': 1.6, 'tali-nuzzle': 2.4,
  'npc-talk-relaxed': 3, 'npc-talk-explain': 3, 'npc-talk-point': 2.4, 'npc-talk-guarded': 3.2,
  'hunter-thrust': 1.8, 'hunter-subdue': 1.6, 'hunter-kneel-idle': 3,
};


export const BAMBOO_LOCOMOTION: Readonly<Record<string, LocomotionProfile>> = {
  // Hostile Koro (Howler-family biped clips, 1.529 scale): walk 1.2 s, run 0.6 s loops.
  'actor-koro-branchbreaker': { runThreshold: 3.2, walkRef: 1.9, runRef: 4.4 },
  // Asha (quadruped, 2.217 scale): clips report walk.planting.plantedSpeedUnitsPerSecond 0.5507 x 2.217 = 1.22 m/s, rounded to 0.05.
  'actor-asha': { runThreshold: 3.4, walkRef: 1.2, runRef: 5 },
  // Tali (quadruped, 1.356 scale): 1.05 x 1.356 = 1.42 m/s.
  'actor-tali': { runThreshold: 2.6, walkRef: 1.4, runRef: 3.6 },
  // Marek (Mixamo-spec biped, 1.823 scale): idle, walk, run among his nine slots.
  'actor-marek': { runThreshold: 3.4, walkRef: 1.6, runRef: 4.4 },
  // Camp hunters (Marek-family biped clips, scale 1.929 melee / 1.756 ranged).
  'actor-camp-hunter-melee': { runThreshold: 3.2, walkRef: 1.7, runRef: 4.2 },
  'actor-camp-hunter-ranged': { runThreshold: 3.2, walkRef: 1.6, runRef: 4 },
};

/** Speed (m/s) at which `asha-stalk` plays at 1x: the belly-low prowl follows the walk reference at 0.75x (no planted-foot measurement exists for this loop). */
export const ASHA_STALK_REF_SPEED = BAMBOO_LOCOMOTION['actor-asha']!.walkRef * 0.75;

/** Nothing in the valley hovers: every actor is drawn on its simulation position. */
export const BAMBOO_HOVER: Readonly<Record<string, MonsterHoverProfile>> = {};

/** Native assets of the canonical story actors: their cleanse / subdue / shelter statuses are never a defeat. */
export const BAMBOO_STORY_ASSETS: Readonly<Record<string, true>> = {
  'actor-koro': true, 'actor-koro-branchbreaker': true, 'actor-asha': true, 'actor-tali': true, 'actor-marek': true,
  'actor-camp-hunter-melee': true, 'actor-camp-hunter-ranged': true,
};
