import type { LocomotionProfile } from './MonsterAnimationPlan';
import type { MonsterHoverProfile } from './MonsterAnimationProfiles';


/** Walk/run references follow the AI profiles' advance/circle speeds (lurker 3.4/2.4, heron 4.4/3.8, Ghor 2.2/1.4 m/s). */
export const MISTVEIL_LOCOMOTION: Readonly<Record<string, LocomotionProfile>> = {
  'actor-bog-lurker': { runThreshold: 2.8, walkRef: 1.7, runRef: 3.4 },
  'actor-lantern-heron': { runThreshold: 3.4, walkRef: 2.4, runRef: 4.4 },
  'actor-ghor-mire-maw': { runThreshold: 1.8, walkRef: 1.1, runRef: 2.2 },
};

/** No Mistveil monster hovers. */
export const MISTVEIL_HOVER: Readonly<Record<string, MonsterHoverProfile>> = {};
