import { describe, expect, it } from 'bun:test';
import { IMPULSE_MAX_SECONDS, IMPULSE_MAX_STRENGTH, ImpulseEnvelope } from '../../src/rendering/PostFX.js';

describe('screen impulse envelope', () => {
  it('is inactive at rest (the pass is skipped), decays quadratically and ends exactly at its duration', () => {
    const impulse = new ImpulseEnvelope();
    expect(impulse.active).toBe(false);
    expect(impulse.level).toBe(0);
    expect(impulse.add(0.5, 0.2)).toBe(true);
    expect(impulse.active).toBe(true);
    expect(impulse.level).toBeCloseTo(0.5, 9);
    impulse.advance(0.1);
    expect(impulse.level).toBeCloseTo(0.5 * 0.25, 9);
    impulse.advance(0.1);
    expect(impulse.active).toBe(false);
    expect(impulse.level).toBe(0);
  });

  it('caps strength and duration, ignores bad requests and keeps the stronger of overlapping impulses', () => {
    const impulse = new ImpulseEnvelope();
    expect(impulse.add(9, 30)).toBe(true);
    expect(impulse.level).toBeLessThanOrEqual(IMPULSE_MAX_STRENGTH);
    impulse.advance(IMPULSE_MAX_SECONDS + 0.01);
    expect(impulse.active).toBe(false);
    for (const [strength, seconds] of [[Number.NaN, 0.2], [0.4, Number.POSITIVE_INFINITY], [0, 0.2], [-1, 0.2], [0.4, 0], [0.4, -0.1]] as const) expect(impulse.add(strength, seconds)).toBe(false);
    expect(impulse.active).toBe(false);
    impulse.add(0.8, 0.3);
    impulse.advance(0.05);
    expect(impulse.add(0.1, 0.3)).toBe(false);
    expect(impulse.add(0.9, 0.3)).toBe(true);
    expect(impulse.level).toBeCloseTo(0.9, 9);
    impulse.clear();
    expect(impulse.active).toBe(false);
    expect(impulse.level).toBe(0);
  });
});
