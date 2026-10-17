import { describe, expect, it } from 'bun:test';
import { VESPER } from '../../src/game/combat/VesperSkills';
import { vesperClipProgress } from '../../src/rendering/VesperAnimation';

describe('Vesper captured-contact phase sampling', () => {
  it('keeps all seven Requiem cuts and the held detonation aligned after simulation-tick rounding', () => {
    const spec = VESPER.requiem;
    for (let i = 0; i < spec.slashCount; i++) {
      const progress = (spec.slashFrom + i * spec.slashInterval) / spec.ticks;
      expect(vesperClipProgress('vesper-requiem', progress)).toBeCloseTo((12 + i * 12) / 120, 12);
    }
    expect(vesperClipProgress('vesper-requiem', spec.detonationAt / spec.ticks)).toBeCloseTo(110 / 120, 12);
    // The last slash previously drifted ahead of the native contact; it must still move continuously between beats.
    const sixth = (spec.slashFrom + 5 * spec.slashInterval) / spec.ticks;
    const seventh = (spec.slashFrom + 6 * spec.slashInterval) / spec.ticks;
    expect(vesperClipProgress('vesper-requiem', (sixth + seventh) / 2)).toBeCloseTo(0.65, 12);
  });

  it('never reverses a finite sword pose and does not retime locomotion, defence or another hero', () => {
    let previous = -Infinity;
    for (let i = 0; i <= 1024; i++) {
      const sampled = vesperClipProgress('vesper-requiem', i / 1024);
      expect(sampled).toBeGreaterThan(previous);
      previous = sampled;
    }
    expect(vesperClipProgress('vesper-requiem', 0)).toBe(0);
    expect(vesperClipProgress('vesper-requiem', 1)).toBe(1);
    for (const action of ['aren-run', 'vesper-cuts-charge', 'vesper-mist-blink', 'vesper-cleanse', 'sakda-tigers-wrath', 'yara-bloom']) {
      for (const progress of [0, 0.13, 0.51, 0.92, 1]) expect(vesperClipProgress(action, progress)).toBe(progress);
    }
  });
});
