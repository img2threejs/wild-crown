import { VESPER } from '../game/combat/VesperSkills';

interface Timing { readonly seconds: number; readonly knots: readonly (readonly [number, number])[] }
function timing(ticks: number, nativeTicks: number, contacts: readonly number[], nativeContacts: readonly number[]): Timing {
  return { seconds: ticks / 60, knots: [[0, 0], ...contacts.map((at, i) => [at / ticks, nativeContacts[i]! / nativeTicks] as const), [1, 1]] };
}
/** Authored native contact markers (author-vesper-hero-clips.mjs), paired with the live, rounded simulation phases.
 * In particular seven rounded Requiem intervals must not drift ahead of the seventh captured sword cut.
 * Only native playback is warped: damage, world movement, mana, hit-stop and action durations remain simulation-owned.
 */
const TIMING: Readonly<Record<string, Timing>> = {
  ...Object.fromEntries(VESPER.iai.steps.map((step, i) => [`vesper-iai-${i + 1}`, timing(step.ticks, [18, 18, 22, 30][i]!, [step.activeAt], [i < 2 ? 6 : i === 2 ? 8 : 10])])),
  'vesper-shadow-step': timing(VESPER.shadowStep.ticks, 26, [VESPER.shadowStep.blinkAt, VESPER.shadowStep.strikeAt], [4, 8]),
  'vesper-thousand-cuts': timing(VESPER.thousandCuts.ticks, 72, [...VESPER.thousandCuts.strikeAt, VESPER.thousandCuts.finisherAt], [8, 18, 28, 38, 48, 58, 66]),
  'vesper-kunai-fan': timing(VESPER.kunaiFan.ticks, 24, [VESPER.kunaiFan.releaseAt], [9]),
  'vesper-shade-swap': timing(VESPER.shadeSwap.ticks, 40, [VESPER.shadeSwap.cloneLaunchAt, VESPER.shadeSwap.swapAt], [8, 30]),
  'vesper-severing-shadow': timing(VESPER.severingShadow.ticks, 36, [VESPER.severingShadow.strikeAt], [12]),
  'vesper-requiem': timing(VESPER.requiem.ticks, 120, [VESPER.requiem.markAt, ...Array.from({ length: VESPER.requiem.slashCount }, (_, i) => VESPER.requiem.slashFrom + i * VESPER.requiem.slashInterval), VESPER.requiem.detonationAt], [6, 12, 24, 36, 48, 60, 72, 84, 110]),
};

/** Undefined for locomotion, held charges and defensive clips, whose native clocks stay untouched. */
export function vesperActionSeconds(actionId: string): number | undefined { return TIMING[actionId]?.seconds; }

/** Allocation-free piecewise-linear phase sampling; interpolate snapshots before applying this mapping. */
export function vesperClipProgress(actionId: string, progress: number): number {
  const timing = TIMING[actionId];
  if (!timing) return progress;
  const p = Math.max(0, Math.min(1, progress)), knots = timing.knots;
  for (let i = 1; i < knots.length; i++) {
    const right = knots[i]!;
    if (p > right[0]) continue;
    const left = knots[i - 1]!;
    return left[1] + (right[1] - left[1]) * (p - left[0]) / (right[0] - left[0]);
  }
  return 1;
}
