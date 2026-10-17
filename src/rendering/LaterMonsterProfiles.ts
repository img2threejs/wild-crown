import { clip, loop, plan, type LocomotionProfile, type MonsterAttackPlan } from './MonsterAnimationPlan';
import { MOONPINE_LOCOMOTION } from './MoonpineMonsterProfiles';
import { MISTVEIL_LOCOMOTION } from './MistveilMonsterProfiles';

export type OrunClipAction = 'orun-root-tether' | 'orun-back-handspring' | 'orun-cartwheel-counter';

/** Native contact poses coincide with the corresponding attack's active boundary. */
export const LATER_ATTACK_PLANS: Readonly<Record<string, MonsterAttackPlan>> = {
  'ruun-track-charge': { windup: loop('monster-run', 0.35, 0.9), commit: loop('monster-run', 1.6, 2.4), active: clip('monster-dive', 0.3, 0.62), recovery: clip('monster-dive', 0.62, 1, 'out') },
  'ruun-pack-call': plan('monster-roar', [0, 0.25], [0.25, 0.4], [0.4, 0.8], [0.8, 1]),
  'ruun-claw-arc': plan('monster-slash', [0, 0.3], [0.3, 0.45], [0.45, 0.72], [0.72, 1]),
  'ghor-hammering-charge': { windup: loop('monster-run', 0.3, 0.8), commit: loop('monster-run', 1.4, 2), active: clip('monster-dive', 0.3, 0.62), recovery: clip('monster-dive', 0.62, 1, 'out') },
  'ghor-stonefall': plan('monster-roar', [0, 0.25], [0.25, 0.4], [0.4, 0.8], [0.8, 1]),
  'ghor-overhead-slam': plan('monster-jump', [0, 0.3], [0.3, 0.68], [0.68, 0.85], [0.85, 1]),
  'solkar-commanding-roar': plan('monster-roar', [0, 0.25], [0.25, 0.4], [0.4, 0.8], [0.8, 1]),
  'solkar-pride-rush': { windup: loop('monster-run', 0.4, 1), commit: loop('monster-run', 1.5, 2), active: clip('monster-dive', 0.3, 0.62), recovery: clip('monster-dive', 0.62, 1, 'out') },
  'solkar-paw-slam': plan('monster-dive', [0, 0.25], [0.25, 0.4], [0.4, 0.62], [0.62, 1]),
  'nyra-shadow-ambush': plan('monster-dive', [0, 0.2], [0.2, 0.4], [0.4, 0.62], [0.62, 1]),
  // The Last Warden (human `actor-orun`): native Warden clips for the tether, handspring and cartwheel; generic slots for the rest.
  'orun-root-tether': plan('orun-root-tether', [0, 0.35], [0.35, 0.5], [0.5, 0.72], [0.72, 1]),
  'orun-staff-combo': { windup: clip('monster-slash', 0, 0.3, 'inOut'), commit: clip('monster-slash', 0.3, 0.45, 'in'), active: loop('monster-slash', 1.6), recovery: clip('monster-slash', 0.72, 1, 'out') },
  'orun-cartwheel-counter': plan('orun-cartwheel-counter', [0, 0.3], [0.3, 0.45], [0.45, 0.7], [0.7, 1]),
  'orun-back-handspring': plan('orun-back-handspring', [0, 0.25], [0.25, 0.35], [0.35, 0.45], [0.45, 1]),
  'orun-dive-roll': { windup: clip('monster-dive', 0, 0.2, 'inOut'), commit: clip('monster-dive', 0.2, 0.3, 'in'), active: clip('monster-dive', 0.3, 0.62), recovery: clip('monster-dive', 0.62, 1, 'out') },
  'orun-companion-suppression': plan('monster-roar', [0, 0.25], [0.25, 0.4], [0.4, 0.8], [0.8, 1]),
  'orun-root-surge': plan('monster-shoot', [0, 0.35], [0.35, 0.5], [0.5, 0.75], [0.75, 1]),
  // The Crowned Beast (`actor-orun-crowned-beast`) and its Sky echoes (native storm hornbill).
  'orun-sky-aspect': plan('monster-roar', [0, 0.25], [0.25, 0.4], [0.4, 0.8], [0.8, 1]),
  'orun-sky-dive': plan('monster-dive', [0, 0.2], [0.2, 0.36], [0.36, 0.62], [0.62, 1]),
  'orun-canopy-root': plan('monster-shoot', [0, 0.35], [0.35, 0.5], [0.5, 0.75], [0.75, 1]),
  'orun-canopy-aspect': plan('monster-shoot', [0, 0.35], [0.35, 0.5], [0.5, 0.75], [0.75, 1]),
  'orun-fang-aspect': { windup: loop('monster-run', 0.35, 0.9), commit: loop('monster-run', 1.6, 2.4), active: clip('monster-dive', 0.3, 0.62), recovery: clip('monster-dive', 0.62, 1, 'out') },
  'orun-pack-aspect': plan('monster-roar', [0, 0.25], [0.25, 0.4], [0.4, 0.8], [0.8, 1]),
  'orun-shadow-aspect': plan('monster-roar', [0, 0.25], [0.25, 0.4], [0.4, 0.8], [0.8, 1]),
  'orun-crown-aspect': plan('monster-roar', [0, 0.3], [0.3, 0.45], [0.45, 0.8], [0.8, 1]),
  'orun-crown-possession': plan('monster-roar', [0, 0.25], [0.25, 0.4], [0.4, 0.8], [0.8, 1]),
};

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
