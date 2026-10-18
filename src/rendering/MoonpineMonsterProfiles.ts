import type { LocomotionProfile } from './MonsterAnimationPlan';
import type { MonsterHoverProfile } from './MonsterAnimationProfiles';


/**
 * runRef follows the AI profiles' advance speeds (tracker 4.6, scout 5.6, Ruun 2.8 m/s). walkRef is the ground speed at which the authored
 * ikGait walk keeps its feet planted: the clips report's walk.planting.plantedSpeedUnitsPerSecond times the manifest scale (tracker
 * 0.9871 x 2.247, scout 1.3971 x 1.736, Ruun 0.5864 x 3.548, rounded to 0.05 m/s).
 */
export const MOONPINE_LOCOMOTION: Readonly<Record<string, LocomotionProfile>> = {
  'actor-frostfang-tracker': { runThreshold: 3.4, walkRef: 2.2, runRef: 4.6 },
  'actor-howl-scout': { runThreshold: 4, walkRef: 2.4, runRef: 5.6 },
  'actor-ruun-chained-howl': { runThreshold: 2.2, walkRef: 2.1, runRef: 2.8 },
};

/** No Moonpine monster flies: every wolf is drawn on its simulation position. */
export const MOONPINE_HOVER: Readonly<Record<string, MonsterHoverProfile>> = {};
