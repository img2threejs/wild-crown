import { describe, expect, it } from 'bun:test';
import { PETAL_STEP_TICKS, dodgeVanishWindow } from '../../src/rendering/DodgeVanish.js';

describe('dodge vanish window', () => {
  it('hides Yara for the whole Petal Step travel and keeps Vesper\'s umbral blink window', () => {
    const travel = PETAL_STEP_TICKS.travelTicks / PETAL_STEP_TICKS.dodgeTicks;
    const yara = dodgeVanishWindow('heartroot');
    // Gone the instant the step starts, back only once the travel has ended (and well before the recovery does).
    expect(yara.from).toBeLessThanOrEqual(0.05);
    expect(yara.to).toBeGreaterThanOrEqual(travel - 0.01);
    expect(yara.to).toBeLessThan(0.6);
    expect(dodgeVanishWindow('umbral')).toEqual({ from: 0.1, to: 0.6 });
  });
});
