import { TARGETED_STRIKES, THUNDER_CLEAVE } from '../game/combat/PlayerSkills';

const cleave = TARGETED_STRIKES.charged_heavy;
const total = cleave.ticks + cleave.recoveryTicks;
const contact = cleave.activeAt / total;
const lightning = (cleave.activeAt + THUNDER_CLEAVE.delayTicks) / total;
/** Raise early, hold the overhead silhouette, then commit through the authored contact pose.
 * The native clip already meets the simulation marker; neither contact nor the delayed strike moves.
 */
const KNOTS: readonly (readonly [number, number])[] = [
  [0, 0], [12 / total, 0.2], [28 / total, 0.38], [48 / total, 0.41],
  [contact, contact], [lightning, lightning], [0.78, 0.7], [1, 1],
];

/** Sample after snapshot interpolation; no local clock, mutable phase state or per-frame allocation. */
export function arenClipProgress(actionId: string, progress: number): number {
  if (actionId !== 'aren-charged-heavy') return progress;
  const p = Math.max(0, Math.min(1, progress));
  for (let i = 1; i < KNOTS.length; i++) {
    const right = KNOTS[i]!;
    if (p > right[0]) continue;
    const left = KNOTS[i - 1]!;
    return left[1] + (right[1] - left[1]) * (p - left[0]) / (right[0] - left[0]);
  }
  return 1;
}
