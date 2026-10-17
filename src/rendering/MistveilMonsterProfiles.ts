import { plan, type LocomotionProfile, type MonsterAttackPlan } from './MonsterAnimationPlan';
import type { MonsterHoverProfile } from './MonsterAnimationProfiles';

/**
 * Mistveil monsters (docs/features/mistveil-playtest.md): clip plan per attack id, walk/run references and optional hover per
 * native asset id. Every monster GLB exposes the ten generic MONSTER_SLOTS; tailed rigs (Ghor) add `monster-tail`. The plans choose among them like the canopy plans.
 * None of the three hovers: the Lantern Heron is a ground-bound wader.
 */
export const MISTVEIL_ATTACK_PLANS: Readonly<Record<string, MonsterAttackPlan>> = {
  // Bog Lurker. Tongue lash: the shoot clip expels at ~0.5 (the tongue leaves on the commit window), the long active window holds the lash.
  'bog-lurker-tongue-lash': plan('monster-shoot', [0, 0.46], [0.46, 0.58], [0.58, 0.78], [0.78, 1]),
  // Poison bubble: a slowed exhale (starts partway into the rear-back); the glob leaves on the expel and the long active window holds the pool.
  'bog-lurker-bubble-pool': plan('monster-shoot', [0.05, 0.5], [0.5, 0.62], [0.62, 0.72], [0.72, 1]),
  // Mud hop: crouch 0-0.3 (windup), airborne 0.3-0.7 (commit = the hop), landing 0.7-0.85 (active = the splat).
  'bog-lurker-mud-hop': plan('monster-jump', [0, 0.3], [0.3, 0.7], [0.7, 0.85], [0.85, 1]),
  // Lantern Heron. The dive clip's low lunge strikes ~0.4; the neck-coil windup is the first fifth, the commit drops into the lane.
  'lantern-heron-spear-dive': plan('monster-dive', [0, 0.2], [0.2, 0.36], [0.36, 0.62], [0.62, 1]),
  // Wingbeat: the slash clip as a wide sweep of the wing, its strike pose ~0.45 launches the gust.
  'lantern-heron-mist-gust': plan('monster-slash', [0.04, 0.32], [0.32, 0.45], [0.45, 0.72], [0.72, 1]),
  // Flare: the roar clip raises the head and spreads the wings (sustained 0.25-0.8); the lantern bursts as the raise tops out.
  'lantern-heron-flare-burst': plan('monster-roar', [0, 0.25], [0.25, 0.4], [0.4, 0.7], [0.7, 1]),
  // Ghor, the Mire Maw. Tail sweep: the tail clip coils the hips and cocks the tail (windup), accelerates the sweep (commit) and opens the active window on the crack (~0.5) as it whips low along the ground.
  'mire-maw-tail-sweep': plan('monster-tail', [0, 0.36], [0.36, 0.5], [0.5, 0.8], [0.8, 1]),
  // Bite lunge: rear back, then the dive clip's strike (~0.4) as the jaws close at the end of the step.
  'mire-maw-bite-lunge': plan('monster-dive', [0, 0.18], [0.18, 0.38], [0.38, 0.6], [0.6, 1]),
  // Black River wave: the jump clip is the rear-up (windup crouch, airborne commit) and the heavy slam that drives the wave (active = landing).
  'mire-maw-black-river-wave': plan('monster-jump', [0, 0.3], [0.3, 0.68], [0.68, 0.85], [0.85, 1]),
};

/** Walk/run references follow the AI profiles' advance/circle speeds (lurker 3.4/2.4, heron 4.4/3.8, Ghor 2.2/1.4 m/s). */
export const MISTVEIL_LOCOMOTION: Readonly<Record<string, LocomotionProfile>> = {
  'actor-bog-lurker': { runThreshold: 2.8, walkRef: 1.7, runRef: 3.4 },
  'actor-lantern-heron': { runThreshold: 3.4, walkRef: 2.4, runRef: 4.4 },
  'actor-ghor-mire-maw': { runThreshold: 1.8, walkRef: 1.1, runRef: 2.2 },
};

/** No Mistveil monster hovers. */
export const MISTVEIL_HOVER: Readonly<Record<string, MonsterHoverProfile>> = {};
