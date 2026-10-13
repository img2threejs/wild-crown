import { clip, loop, plan, type LocomotionProfile, type MonsterAttackPlan } from './MonsterAnimationPlan';
import type { MonsterHoverProfile } from './MonsterAnimationProfiles';

/**
 * Moonpine monsters (docs/features/moonpine-playtest.md): clip plan per attack id, walk/run references and optional hover per
 * native asset id. The three wolves share the quadruped clip slots; the howls play the `monster-roar` slot (head raised,
 * sustained 0.25-0.8), so the active window of a howl opens on the held note.
 */
export const MOONPINE_ATTACK_PLANS: Readonly<Record<string, MonsterAttackPlan>> = {
  // Frostfang Tracker. Pack rush: paws and revs on the spot (run cycle ramping up), the dive clip's lunge carries the charge.
  'frostfang-pack-rush': { windup: loop('monster-run', 0.35, 0.9), commit: loop('monster-run', 1.6, 2.4), active: clip('monster-dive', 0.3, 0.62), recovery: clip('monster-dive', 0.62, 1, 'out') },
  // Ice bite: rear back, then the head-snap of the slash clip (strike pose ~0.45) as the body steps in.
  'frostfang-ice-bite': plan('monster-slash', [0.04, 0.3], [0.3, 0.45], [0.45, 0.72], [0.72, 1]),
  // Frost breath: rear back and expel (shoot clip, expel ~0.5 as the commit opens); the cone is the active window.
  'frostfang-frost-breath': plan('monster-shoot', [0.05, 0.5], [0.5, 0.66], [0.66, 0.8], [0.8, 1]),
  // Howl Scout. Flank pounce: crouch 0-0.3 (windup), airborne 0.3-0.7 (commit = the leap), landing 0.7-0.85 (active).
  'howl-scout-flank-pounce': plan('monster-jump', [0, 0.3], [0.3, 0.7], [0.7, 0.85], [0.85, 1]),
  // Claw rake: a quick dash and a double swipe; the slash clip's strike pose ~0.45 opens the active window.
  'howl-scout-claw-rake': plan('monster-slash', [0.06, 0.32], [0.32, 0.45], [0.45, 0.7], [0.7, 1]),
  // Low howl: the roar clip lifts the head through the windup and holds the note while the shockwave rolls out.
  'howl-scout-low-howl': plan('monster-roar', [0, 0.25], [0.25, 0.4], [0.4, 0.8], [0.8, 1]),
  // Ruun, the Chained Howl. Chain pounce: a heavy jump against the chains, the landing is the active window.
  'chained-ruun-chain-pounce': plan('monster-jump', [0, 0.3], [0.3, 0.68], [0.68, 0.85], [0.85, 1]),
  // Howl shockwave: head thrown back for the three-beat howl, held through the burst.
  'chained-ruun-howl-shockwave': plan('monster-roar', [0, 0.3], [0.3, 0.45], [0.45, 0.8], [0.8, 1]),
  // Breaking ice: rears and stamps (dive clip, strike ~0.4); the ice splits along the wave.
  'chained-ruun-breaking-ice': plan('monster-dive', [0, 0.25], [0.25, 0.38], [0.38, 0.55], [0.55, 1]),
};

/** References follow the AI profiles' advance/circle speeds (tracker 4.6/3.2, scout 5.6/4.8, Ruun 2.8/2.0 m/s). */
export const MOONPINE_LOCOMOTION: Readonly<Record<string, LocomotionProfile>> = {
  'actor-frostfang-tracker': { runThreshold: 3.4, walkRef: 2.4, runRef: 4.6 },
  'actor-howl-scout': { runThreshold: 4, walkRef: 2.8, runRef: 5.6 },
  'actor-ruun-chained-howl': { runThreshold: 2.2, walkRef: 1.4, runRef: 2.8 },
};

/** No Moonpine monster flies: every wolf is drawn on its simulation position. */
export const MOONPINE_HOVER: Readonly<Record<string, MonsterHoverProfile>> = {};
