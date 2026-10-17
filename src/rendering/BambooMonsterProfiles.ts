import { clip, loop, plan, type LocomotionProfile, type MonsterAttackPlan } from './MonsterAnimationPlan';
import type { MonsterHoverProfile } from './MonsterAnimationProfiles';

/**
 * Blood Bamboo Valley actors (docs/features/full-renderer.md, "Blood Bamboo Valley presentation"): Koro the Branchbreaker (hostile body),
 * the Grove's ally Koro, Asha, Tali, Marek. Clip plan per attack id, walk/run references per native asset id, and the authored clip
 * durations the story lifecycle (cleanse, nuzzle, talk) is mapped onto. The attack ids and their 60 Hz phase boundaries are the combat
 * owner's (`ACT_ONE_ATTACK_WINDOWS`); this module only maps each simulation phase onto a window of the clip, never the other way round.
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

/**
 * Clip markers `[anticipation end, active start, active end, recovery end]` in seconds, from each attack clip's `attackWindow`
 * (clips-report). The simulation phase boundaries are `Math.ceil(seconds * 60)` of these (combat: ACT_ONE_ATTACK_WINDOWS).
 */
export type ClipMarkers = readonly [number, number, number, number];
export interface ClipSegments { readonly action: BambooClipAction; readonly markers: ClipMarkers }
export const ASHA_CLIP_SEGMENTS: Readonly<Record<string, ClipSegments>> = {
  // Tiger Pounce: crouch -> launch 0.38 -> apex -> impact 0.64 (the active window) -> recover.
  'asha-guarding-pounce': { action: 'asha-stalk-pounce', markers: [0.42, 0.66, 0.99, 1.35] },
  // Corrupted Pounce: rears and roars (windup), slams both forepaws at 0.54 (the active window); the clip tail past 1.656 is not played.
  'asha-corrupted-pounce': { action: 'asha-corrupt-slam', markers: [0.72, 0.9, 1.152, 1.656] },
  // Bamboo Charge: low wind-up with a paw scrape, head-down run-in-place burst 0.34-0.84 (the active window, the simulation moves her), skid.
  'asha-bamboo-charge': { action: 'asha-bamboo-charge', markers: [0.48, 0.608, 1.312, 1.536] },
};

/**
 * The Ground Corruption Wave is the slam clip too (the wave itself is drawn by BambooKits from the engine's wave hazard). Its simulation
 * phases are longer than the pounce's, so the recovery plays the slam clip's whole tail (to 1.8 s) instead of ending at the marker.
 */
const GROUND_WAVE_MARKERS: ClipMarkers = [0.72, 0.9, 1.152, 1.8];

/**
 * One finite clip played across the four attack phases with each phase mapped linearly onto its marker segment, so the clip pose at a phase
 * boundary is exactly the authored marker pose: `[0, a] [a, b] [b, c] [c, d]` seconds of the clip, normalized by its length.
 */
export function segmentPlan(action: BambooClipAction, markers: ClipMarkers): MonsterAttackPlan {
  const length = BAMBOO_CLIP_SECONDS[action];
  const t = markers.map(second => second / length) as unknown as readonly [number, number, number, number];
  return {
    windup: clip(action, 0, t[0], 'linear'), commit: clip(action, t[0], t[1], 'linear'),
    active: clip(action, t[1], t[2], 'linear'), recovery: clip(action, t[2], t[3], 'linear'),
  };
}

const HOWL = plan('monster-roar', [0, 0.25], [0.25, 0.4], [0.4, 0.8], [0.8, 1]);

export const BAMBOO_ATTACK_PLANS: Readonly<Record<string, MonsterAttackPlan>> = {
  // ---- Asha (docs/features/asset-pipeline.md "Asha"): the three phase attacks play their own clips; the rest reuse the thirteen slots ----
  ...Object.fromEntries(Object.entries(ASHA_CLIP_SEGMENTS).map(([attackId, segments]) => [attackId, segmentPlan(segments.action, segments.markers)])),
  'asha-ground-wave': segmentPlan('asha-corrupt-slam', GROUND_WAVE_MARKERS),
  // Claw Combo: a quick dash and a double swipe; the slash clip's strike pose ~0.45 opens the active window.
  'asha-claw-combination': plan('monster-slash', [0.06, 0.32], [0.32, 0.45], [0.45, 0.7], [0.7, 1]),
  // Side Charge: paws and revs on the spot (run cycle ramping up), the dive clip's lunge carries the charge; the engine sweeps her along the lane.
  'asha-side-charge': { windup: loop('monster-run', 0.35, 0.9), commit: loop('monster-run', 1.6, 2.4), active: clip('monster-dive', 0.3, 0.62), recovery: clip('monster-dive', 0.62, 1, 'out') },
  // Roar Cone: the roar clip lifts the head through the windup and holds the note while the cone is live.
  'asha-protective-roar': HOWL,
  // Black Sap Trail: the tail clip coils (windup), cracks at 0.5 (the lane opens) and sweeps the sap along it.
  'asha-black-sap-trail': plan('monster-tail', [0, 0.36], [0.36, 0.5], [0.5, 0.8], [0.8, 1]),

  // ---- Koro, the Branchbreaker (Howler-family biped clips; the falling branch is an environment hazard with no clip of its own) ----
  // Rock Throw: the shoot clip (`pitch_baseball`) expels at ~0.5, so the rear-back is the windup, the throw the commit and the active window the impact.
  'koro-rock-throw': plan('monster-shoot', [0, 0.5], [0.5, 0.68], [0.68, 0.85], [0.85, 1]),
  // Falling Branch: the chest-beat challenge (roar clip) while the branch comes down on the marked ground.
  'koro-falling-branch': HOWL,
  // Platform Charge: the run cycle revs on the spot (windup, commit) and the dive clip's lunge (0.3-0.62) carries the active window; the engine sweeps him along the lane.
  'koro-platform-charge': { windup: loop('monster-run', 0.35, 0.9), commit: loop('monster-run', 1.6, 2.4), active: clip('monster-dive', 0.3, 0.62), recovery: clip('monster-dive', 0.62, 1, 'out') },
  // Foreground Leap: crouch 0-0.3 (windup), airborne 0.3-0.7 (commit = the leap), landing 0.7-0.85 (active = the slam).
  'koro-vine-vault': plan('monster-jump', [0, 0.3], [0.3, 0.7], [0.7, 0.85], [0.85, 1]),
  // Horizontal Log Sweep: the slash clip's strike pose ~0.45 opens the active window of the long lane.
  'koro-branch-swing': plan('monster-slash', [0, 0.3], [0.3, 0.45], [0.45, 0.74], [0.74, 1]),
  // ---- Camp hunters: spear jab = hunter-thrust (window .702/.792/.9/1.44 of 1.8 s), crossbow = monster-shoot (.76/.95/1.102/1.615 of 1.9 s) ----
  'poacher-hunter-spear': plan('hunter-thrust', [0, 0.39], [0.39, 0.44], [0.44, 0.5], [0.5, 0.8]),
  'poacher-scout-net': plan('monster-shoot', [0, 0.4], [0.4, 0.5], [0.5, 0.58], [0.58, 0.85]),
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

/** Presentation-only hop height (m) of the leap's airborne segment, by native asset id (see ActorAnimationDriver.monsterHopHeight). */
export const BAMBOO_HOP_HEIGHT: Readonly<Record<string, number>> = { 'actor-koro-branchbreaker': 0.4 };

/** Native assets of the canonical story actors: their cleanse / subdue / shelter statuses are never a defeat. */
export const BAMBOO_STORY_ASSETS: Readonly<Record<string, true>> = {
  'actor-koro': true, 'actor-koro-branchbreaker': true, 'actor-asha': true, 'actor-tali': true, 'actor-marek': true,
  'actor-camp-hunter-melee': true, 'actor-camp-hunter-ranged': true,
};
