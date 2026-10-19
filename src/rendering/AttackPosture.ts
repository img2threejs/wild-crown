import { Vector3, type Object3D } from 'three';
import { rotateBoneWorld } from './RigBones';

/**
 * How a hero stages a strike with the torso: the chest coils away from the striking hand while the weapon is drawn back, releases through
 * the contact and follows through, with a forward lean into the blow. The authored clips already move the arms; most of them leave the
 * shoulders square to the hips, which reads as arm-waving. Profiles come from `scripts/assets/derive-attack-postures.mjs` (measured
 * against the reference game's strikes) and are applied as a bend of the spine on top of the clip. Presentation only.
 */
export interface PostureProfile {
  /** Peak chest coil in radians. Positive turns the chest toward the character's left (counter-clockwise from above); the sign is the striking side. */
  readonly coil: number;
  /** Peak forward lean of the chest at contact in radians. */
  readonly lean: number;
  /** Normalised action time of the contact (peak hand speed), 0..1. */
  readonly peak: number;
}

const smooth = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

export interface PostureFactors { coil: number; lean: number }

/**
 * Envelope of the coil (+1 at the draw-back, -FOLLOW through the swing) and lean (+1 at contact) at normalised action time `t`.
 * Both are 0 at the first and last frame so entering and leaving the clip never pops.
 */
export const FOLLOW_THROUGH = 0.3;
export function postureEnvelope(peak: number, t: number, out: PostureFactors): PostureFactors {
  const p = Math.min(0.9, Math.max(0.12, peak));
  const wind = smooth(0, 0.62 * p, t) * (1 - smooth(0.62 * p, p, t));
  const follow = smooth(p * 0.9, p * 1.25, t) * (1 - smooth(p * 1.25, Math.min(1, p + 0.3), t));
  out.coil = wind - FOLLOW_THROUGH * follow;
  out.lean = smooth(0.35 * p, p, t) * (1 - smooth(p + 0.08, Math.min(1, p + 0.32), t));
  return out;
}

/** Share of the bend each of the three spine bones carries, base first (chest-heavy so the hips stay planted). */
export const SPINE_SHARES = [0.2, 0.35, 0.45] as const;
const up = new Vector3(0, 1, 0), leanAxis = new Vector3();

/** Bends `spine` (base first, parent world matrices current) by `coil` about the vertical and `lean` forward of `forward` (unit, horizontal). */
export function applyPosture(spine: readonly Object3D[], forward: Vector3, coil: number, lean: number): void {
  if (spine.length === 0 || (coil === 0 && lean === 0)) return;
  leanAxis.set(forward.z, 0, -forward.x);
  spine[0]!.parent?.updateWorldMatrix(true, false);
  for (let i = 0; i < spine.length; i += 1) {
    const share = SPINE_SHARES[i] ?? 0;
    if (coil !== 0) rotateBoneWorld(spine[i]!, up, coil * share);
    if (lean !== 0) rotateBoneWorld(spine[i]!, leanAxis, lean * share);
  }
}
