import type { LocomotionProfile } from './MonsterAnimationPlan';
import type { MonsterHoverProfile } from './MonsterAnimationProfiles';


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
