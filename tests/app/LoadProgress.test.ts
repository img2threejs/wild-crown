import { describe, expect, it } from 'bun:test';
import { LoadProgress } from '../../src/app/LoadProgress.js';
import { worldLoadPhases } from '../../src/app/GameApplication.js';

describe('LoadProgress', () => {
  const plan = () => new LoadProgress([{ id: 'a', label: 'A', weight: 1 }, { id: 'b', label: 'B', weight: 3 }]);

  it('weights phases and places each phase after the ones before it', () => {
    const progress = plan();
    expect(progress.ratio).toBe(0);
    expect(progress.report('a', 0.5)).toBeCloseTo(0.125, 10);
    expect(progress.complete('a')).toBeCloseTo(0.25, 10);
    expect(progress.report('b', 0.5)).toBeCloseTo(0.625, 10);
    expect(progress.complete('b')).toBe(1);
  });

  it('never moves backwards and clamps bad input', () => {
    const progress = plan();
    progress.report('b', 0.8);
    const high = progress.ratio;
    expect(progress.report('a', 0)).toBe(high);
    expect(progress.report('b', 0.2)).toBe(high);
    expect(progress.report('b', Number.NaN)).toBe(high);
    expect(progress.report('b', 7)).toBe(1);
    expect(progress.report('b', -3)).toBe(1);
  });

  it('rejects unknown and duplicate phases and empty plans', () => {
    expect(() => plan().report('c', 0)).toThrow('Unknown load phase c');
    expect(() => plan().labelOf('c')).toThrow('Unknown load phase c');
    expect(() => new LoadProgress([{ id: 'a', label: 'A', weight: 1 }, { id: 'a', label: 'A', weight: 1 }])).toThrow('Duplicate load phase a');
    expect(() => new LoadProgress([])).toThrow();
    expect(plan().has('a')).toBe(true);
    expect(plan().has('c')).toBe(false);
  });
});

describe('world load phases', () => {
  it('cover every step of preparing a world in order, so the bar is not at 100% when only the assets are in', () => {
    const playtest = worldLoadPhases(true);
    expect(playtest.map(phase => phase.id)).toEqual(['manifest', 'assets', 'hero', 'world', 'waystone', 'effects', 'gpu', 'encounter']);
    expect(worldLoadPhases(false).map(phase => phase.id)).toEqual(['manifest', 'assets', 'hero', 'world', 'effects', 'gpu', 'encounter']);
    const tracker = new LoadProgress(playtest);
    tracker.complete('assets');
    expect(tracker.ratio).toBeGreaterThan(0.5);
    expect(tracker.ratio).toBeLessThan(0.8);
    for (const phase of playtest) expect(tracker.labelOf(phase.id).length).toBeGreaterThan(0);
  });
});
