/**
 * Cross-section helpers shared by every carved channel (creek gully, rivers, pools): a bed with a slight thalweg, then a bank
 * that is concave at the toe, steepest in the middle and arrives at the rim with zero slope (a rounded crest, never a corner).
 */

/** Lowest point of the thalweg above the nominal bed. */
export const THALWEG = 0.12;
/** The bank follows `t^BANK_POWER` up to BANK_ROLL_START of its width, then a cubic Hermite arc eases it flat into the rim. */
const BANK_POWER = 1.5;
const BANK_ROLL_START = 0.55;

/** Bank profile 0 → 1 across the bank width; beyond the rim it keeps rising, `outside` times as steeply as the standard bank. */
export function bankProfile(t: number, outside = 1): number {
  if (t <= BANK_ROLL_START) return Math.pow(t, BANK_POWER);
  if (t >= 1) return 1 + (t - 1) * BANK_POWER * outside;
  const span = 1 - BANK_ROLL_START;
  const start = Math.pow(BANK_ROLL_START, BANK_POWER);
  const slope = BANK_POWER * Math.pow(BANK_ROLL_START, BANK_POWER - 1) * span;
  const s = (t - BANK_ROLL_START) / span;
  const s2 = s * s;
  const s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * start + (s3 - 2 * s2 + s) * slope + (-2 * s3 + 3 * s2);
}

/** Carved surface height at `lateral` metres from a channel's centreline: bed `bed`, flat bed half width `bedHalfWidth`, rim at `rimHalfWidth`. */
export function channelSurface(lateral: number, bed: number, bedHalfWidth: number, rimHalfWidth: number, rimHeight: number, outside = 1): number {
  if (lateral >= bedHalfWidth) {
    const t = (lateral - bedHalfWidth) / (rimHalfWidth - bedHalfWidth);
    return bed + THALWEG + (rimHeight - THALWEG) * bankProfile(t, outside);
  }
  const t = lateral / bedHalfWidth;
  return bed + THALWEG * t * t;
}

/** Lateral distance at which a channel's carved surface crosses `level` (bisection on the monotone bank profile). */
export function lateralAtLevel(level: number, bed: number, bedHalfWidth: number, rimHalfWidth: number, rimHeight: number): number {
  let low = bedHalfWidth;
  let high = rimHalfWidth * 2;
  for (let step = 0; step < 24; step++) {
    const middle = (low + high) / 2;
    if (channelSurface(middle, bed, bedHalfWidth, rimHalfWidth, rimHeight) < level) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}
