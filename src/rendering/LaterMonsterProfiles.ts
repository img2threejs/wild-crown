import type { LocomotionProfile } from './MonsterAnimationPlan';
import { MOONPINE_LOCOMOTION } from './MoonpineMonsterProfiles';
import { MISTVEIL_LOCOMOTION } from './MistveilMonsterProfiles';

export type OrunClipAction = 'orun-root-tether' | 'orun-back-handspring' | 'orun-cartwheel-counter';


/** Measured native stance speed × manifest scale; human speeds use the pre-pinning retarget's world travel. */
export const LATER_LOCOMOTION: Readonly<Record<string, LocomotionProfile>> = {
  'actor-ruun': MOONPINE_LOCOMOTION['actor-ruun-chained-howl']!,
  'actor-ghor': MISTVEIL_LOCOMOTION['actor-ghor-mire-maw']!,
  'actor-luma': { runThreshold: 3.3, walkRef: 2.038, runRef: 4.891 },
  'actor-sable': { runThreshold: 3.5, walkRef: 2.114, runRef: 5.285 },
  'actor-nyra': { runThreshold: 1.8, walkRef: 0.788, runRef: 3.058 },
  'actor-solkar': { runThreshold: 2.8, walkRef: 1.419, runRef: 4.315 },
  'actor-orun': { runThreshold: 3.8, walkRef: 2.355, runRef: 9.194 },
  'actor-orun-crowned-beast': { runThreshold: 4, walkRef: 2.131, runRef: 6.642 },
  'actor-council-envoy': { runThreshold: 4.6, walkRef: 2.98, runRef: 7.322 },
};
