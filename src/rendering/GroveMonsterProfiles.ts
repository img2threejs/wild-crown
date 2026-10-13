import { plan, type LocomotionProfile, type MonsterAttackPlan } from './MonsterAnimationPlan';
import type { MonsterHoverProfile } from './MonsterAnimationProfiles';

/** Grove monsters: clip plan per attack id, walk/run references and optional hover per native asset id. */
export const GROVE_ATTACK_PLANS: Readonly<Record<string, MonsterAttackPlan>> = {
  // Heartroot Sprig. Seed toss: the shoot clip expels at ~0.5, so the rear-back is the windup, the throw is the commit (the seed flies)
  // and the active window is the landing and follow-through.
  'sprig-seed-toss': plan('monster-shoot', [0, 0.5], [0.5, 0.68], [0.68, 0.85], [0.85, 1]),
  // Ground ripple: a low crouch and pat of the earth; the dive clip's lunge strikes ~0.38 and opens the active window.
  'sprig-ground-ripple': plan('monster-dive', [0, 0.2], [0.2, 0.38], [0.38, 0.6], [0.6, 1]),
  // Petal sweep: an open-handed side swipe; the slash clip's strike pose ~0.45 opens the active window.
  'sprig-petal-sweep': plan('monster-slash', [0, 0.3], [0.3, 0.45], [0.45, 0.74], [0.74, 1]),
};

export const GROVE_LOCOMOTION: Readonly<Record<string, LocomotionProfile>> = {
  // Sparring spirit: references follow the AI profile's gentle advance/circle speeds (2.2 / 1.5 m/s).
  'actor-grove-rootling': { runThreshold: 1.9, walkRef: 1.3, runRef: 2.2 },
  // Koro only idles and walks (its clips never include a run): the run threshold is out of reach of any walking pace.
  'actor-koro': { runThreshold: 6, walkRef: 1.4, runRef: 3 },
};

/** Nothing in the Grove hovers: both monsters are drawn on their simulation position. */
export const GROVE_HOVER: Readonly<Record<string, MonsterHoverProfile>> = {};
