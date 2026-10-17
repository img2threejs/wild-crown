import { describe, expect, it } from 'bun:test';
import { Vector3 } from 'three';
import { DEFAULT_FOLIAGE_LIMITS, FADE_TWEEN_HALF, InstanceVisibility, OCCLUDED_ALPHA, VIEW_DISTANCE_HYSTERESIS } from '../../src/rendering/InstanceVisibility.js';
import { FOLIAGE_LIMITS, foliageLimitsFor } from '../../src/rendering/FoliagePresentation.js';

const at = (x: number, z: number): Vector3 => new Vector3(x, 0, z);
const noop = (): void => undefined;

describe('foliage presentation limits', () => {
  it('thins the bamboo grove cluster by dither on an opaque material and culls it at 64 m; every other prop keeps the default blend', () => {
    expect(foliageLimitsFor('prop-bamboo-grove-cluster')).toEqual({ fade: 'dither', maxViewDistance: 64 });
    expect(foliageLimitsFor('prop-rainforest-canopy-tree')).toBe(DEFAULT_FOLIAGE_LIMITS);
    expect(DEFAULT_FOLIAGE_LIMITS).toEqual({ fade: 'blend', maxViewDistance: Infinity });
    expect(Object.keys(FOLIAGE_LIMITS)).toEqual(['prop-bamboo-grove-cluster']);
  });
});

describe('instance visibility', () => {
  it('marks occluded instances for the next fade step and converges within FADE_TWEEN_HALF seconds', () => {
    const visibility = new InstanceVisibility([at(0, 10), at(0, 20), at(6, 10), at(0, -30)]);
    const changed = visibility.updateOcclusion(new Vector3(0, 0, 40), new Vector3(0, 0, 0), 1);
    expect(changed).toBe(true);
    visibility.advanceFade();
    expect([...visibility.alpha]).toEqual([OCCLUDED_ALPHA, OCCLUDED_ALPHA, 1, 1].map(Math.fround));
    expect(visibility.updateOcclusion(new Vector3(0, 0, 40), new Vector3(0, 0, 0), 1)).toBe(false);
    expect(visibility.updateOcclusion(new Vector3(40, 0, 0), new Vector3(0, 0, 0), 1)).toBe(true);
    visibility.advanceFade();
    expect(visibility.alpha[0]).toBe(1);
  });

  it('tweens monotonically toward the target and lands within ~0.25 s', () => {
    const visibility = new InstanceVisibility([at(0, 10)]);
    // A small dt forces many small steps; each step moves strictly toward the target (or lands on it).
    visibility.updateOcclusion(new Vector3(0, 0, 40), new Vector3(0, 0, 0), 0.02);
    let previous = visibility.alpha[0]!;
    let converged = false;
    for (let step = 0; step < 32; step++) {
      visibility.advanceFade();
      const current = visibility.alpha[0]!;
      if (current === OCCLUDED_ALPHA) {
        expect(Math.abs(previous - OCCLUDED_ALPHA)).toBeGreaterThan(0);
        converged = true;
        break;
      }
      expect(current).toBeLessThan(previous);
      previous = current;
    }
    expect(converged).toBe(true);
    expect(Math.abs(visibility.alpha[0]! - OCCLUDED_ALPHA)).toBeLessThan(1e-3);
    expect(FADE_TWEEN_HALF).toBeGreaterThanOrEqual(0.1);
    expect(FADE_TWEEN_HALF).toBeLessThanOrEqual(0.2);
  });

  it('survives a camera on its target (zero-length ray) without NaN', () => {
    const visibility = new InstanceVisibility([at(1, 1)]);
    visibility.updateOcclusion(new Vector3(5, 0, 5), new Vector3(5, 0, 5));
    visibility.advanceFade();
    expect(Number.isFinite(visibility.alpha[0])).toBe(true);
  });

  it('culls instances beyond the view distance, restores them inside the hysteresis band, and reports only the changes', () => {
    const visibility = new InstanceVisibility([at(10, 0), at(70, 0), at(63, 0)]);
    const changes: number[] = [];
    visibility.updateDistance(at(0, 0), 64, index => changes.push(index));
    expect(changes).toEqual([1]);
    expect(visibility.isDrawn(0)).toBe(true);
    expect(visibility.isDrawn(1)).toBe(false);
    expect(visibility.drawnCount).toBe(2);
    changes.length = 0;
    visibility.updateDistance(at(0, 0), 64, index => changes.push(index));
    expect(changes).toEqual([]);
    visibility.updateDistance(at(7, 0), 64, index => changes.push(index));
    expect(changes).toEqual([]);
    visibility.updateDistance(at(70 - 64 * (1 - VIEW_DISTANCE_HYSTERESIS) + 0.5, 0), 64, index => changes.push(index));
    expect(changes).toEqual([1]);
    expect(visibility.isDrawn(1)).toBe(true);
  });

  it('never culls with an unbounded limit', () => {
    const visibility = new InstanceVisibility([at(1e6, 0)]);
    visibility.updateDistance(at(0, 0), Infinity, () => { throw new Error('unexpected cull'); });
    expect(visibility.isDrawn(0)).toBe(true);
  });

  it('keeps a placement hidden by a world fact hidden when it comes back into range', () => {
    const visibility = new InstanceVisibility([at(10, 0)]);
    expect(visibility.setFactVisible(0, false)).toBe(true);
    expect(visibility.setFactVisible(0, false)).toBe(false);
    expect(visibility.isDrawn(0)).toBe(false);
    visibility.updateDistance(at(0, 0), 64, noop);
    expect(visibility.isDrawn(0)).toBe(false);
    expect(visibility.setFactVisible(0, true)).toBe(true);
    expect(visibility.isDrawn(0)).toBe(true);
  });
});