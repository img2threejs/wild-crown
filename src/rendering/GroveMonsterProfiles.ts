import { plan, type LocomotionProfile, type MonsterAttackPlan } from './MonsterAnimationPlan';
import type { MonsterHoverProfile } from './MonsterAnimationProfiles';

/** The practice partner and the blighted rootling share one native asset and one clip slot per shape; only the numbers and the look differ. */
const SEED_TOSS = plan('monster-shoot', [0, 0.5], [0.5, 0.68], [0.68, 0.85], [0.85, 1]);
const GROUND_RIPPLE = plan('monster-dive', [0, 0.2], [0.2, 0.38], [0.38, 0.6], [0.6, 1]);
const SWEEP = plan('monster-slash', [0, 0.3], [0.3, 0.45], [0.45, 0.74], [0.74, 1]);

/** Grove monsters: clip plan per attack id, walk/run references and optional hover per native asset id. */
export const GROVE_ATTACK_PLANS: Readonly<Record<string, MonsterAttackPlan>> = {
  // Heartroot Sprig. Seed toss: the shoot clip expels at ~0.5, so the rear-back is the windup, the throw is the commit (the seed flies)
  // and the active window is the landing and follow-through.
  'sprig-seed-toss': SEED_TOSS,
  // Ground ripple: a low crouch and pat of the earth; the dive clip's lunge strikes ~0.38 and opens the active window.
  'sprig-ground-ripple': GROUND_RIPPLE,
  // Petal sweep: an open-handed side swipe; the slash clip's strike pose ~0.45 opens the active window.
  'sprig-petal-sweep': SWEEP,
  // Blighted Rootling: the same three bodies of motion as the sprig, played on the same clips.
  'blighted-seed-lob': SEED_TOSS,
  'blighted-ground-pulse': GROUND_RIPPLE,
  'blighted-lash-sweep': SWEEP,
  // Hollowheart, the Sapbound Guardian (Howler-family biped clips). Leap smash: the jump clip crouches 0-0.3 (windup), is airborne 0.3-0.7
  // (commit = the leap) and lands 0.7-0.85 (active = the smash), like the Howler's leap slam.
  'hollowheart-leap-smash': plan('monster-jump', [0, 0.3], [0.3, 0.7], [0.7, 0.85], [0.85, 1]),
  // Antler sweep: the slash clip's strike pose ~0.45 opens the active window of the long lane.
  'hollowheart-antler-sweep': plan('monster-slash', [0, 0.3], [0.3, 0.45], [0.45, 0.74], [0.74, 1]),
  // Ichor hurl: the shoot clip expels at ~0.5, so the clot leaves the hand as the commit opens and bursts on the mark in the active window.
  'hollowheart-ichor-hurl': plan('monster-shoot', [0.05, 0.5], [0.5, 0.68], [0.68, 0.85], [0.85, 1]),
  // Heartlight burst: the roar clip's chest beats (held 0.25-0.8) draw the heart-light up; the burst opens on the held beat.
  'hollowheart-heartlight-burst': plan('monster-roar', [0, 0.3], [0.3, 0.45], [0.45, 0.8], [0.8, 1]),
};

export const GROVE_LOCOMOTION: Readonly<Record<string, LocomotionProfile>> = {
  // Sparring spirit: references follow the AI profile's gentle advance/circle speeds (2.2 / 1.5 m/s).
  'actor-grove-rootling': { runThreshold: 1.9, walkRef: 1.3, runRef: 2.2 },
  // Its blighted twin (same clips, own asset): advance 3, circle 2.2 m/s, so it runs whenever it circles and the run loop plays at 1x on the advance.
  'actor-grove-blighted-rootling': { runThreshold: 1.9, walkRef: 1.3, runRef: 3 },
  // Koro only idles and walks (its clips never include a run): the run threshold is out of reach of any walking pace.
  'actor-koro': { runThreshold: 6, walkRef: 1.4, runRef: 3 },
  // Guardian: 3.5 m tall on the Howler-family biped clips; the references scale the rootling's with its height (advance 2.6, circle 1.8 m/s).
  'actor-grove-hollowheart': { runThreshold: 2.2, walkRef: 2.2, runRef: 3.8 },
};

/** Nothing in the Grove hovers: every monster is drawn on its simulation position. */
export const GROVE_HOVER: Readonly<Record<string, MonsterHoverProfile>> = {};
