/**
 * The body volumes the limb-clearance solver (src/rendering/LimbClearance.ts) and the offline arm authoring (scripts/assets/author-yara-hero-clips.mjs)
 * keep an arm out of. Metres for a 0.5 m hips-to-neck chain (every hero rig is a Mixamo skeleton of similar proportions); callers rescale by the measured
 * chain. The radii are the bind-pose-clear fits of the four playable heroes.
 */
export const BODY_REFERENCE_CHAIN = 0.5;
export const BODY_RADII = Object.freeze({ pelvis: 0.125, chest: 0.15, head: 0.11, thigh: 0.125, shin: 0.075, upperArm: 0.07, foreArm: 0.058, hand: 0.055 });
/** Soft tissue, cloth and the capsules' own looseness: a sample may sink this far (metres) into a volume before it counts as a collision. */
export const BODY_TOLERANCE = 0.03;
