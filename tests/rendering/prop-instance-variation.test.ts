import { describe, expect, it } from 'bun:test';
import {
  computePropVariation,
  FOLIAGE_ASSET_VARIATION,
  isStableForPlacement,
  isWithinVariationBudget,
  propVariationFor,
  variationSeed,
} from '../../src/rendering/PropInstanceVariation.js';

const foliageAssets = Object.keys(FOLIAGE_ASSET_VARIATION);

describe('prop instance variation', () => {
  it('returns a profile for every foliage asset id (trees, bushes, ferns, boulders, rocks)', () => {
    expect(foliageAssets).toContain('prop-erya-edge-tree');
    expect(foliageAssets).toContain('prop-moonpine-tree');
    expect(foliageAssets).toContain('prop-rainforest-canopy-tree');
    expect(foliageAssets).toContain('prop-bamboo-grove-cluster');
    expect(foliageAssets).toContain('prop-canopy-fern-cluster');
    expect(foliageAssets).toContain('prop-greenwake-boulder-cluster');
    expect(foliageAssets).toContain('prop-canopy-cliff-rock');
    expect(foliageAssets).toContain('prop-snow-ridge-rock');
    expect(propVariationFor('prop-bamboo-footbridge')).toBeUndefined();
    expect(propVariationFor('prop-monkey-rope-platform')).toBeUndefined();
    expect(propVariationFor('prop-migration-gate')).toBeUndefined();
  });

  it('keeps every variation within the profile budget (hue/value/scale/lean)', () => {
    for (const assetId of foliageAssets) {
      for (let i = 0; i < 16; i++) {
        const variation = computePropVariation(assetId, i * 0.7 + 1.3, 0, i * 0.5 - 2.1);
        expect(isWithinVariationBudget(assetId, variation)).toBe(true);
        expect(Math.abs(variation.hueShift)).toBeLessThanOrEqual(FOLIAGE_ASSET_VARIATION[assetId]!.hueJitter + 1e-6);
        expect(Math.abs(variation.valueScale - 1)).toBeLessThanOrEqual(FOLIAGE_ASSET_VARIATION[assetId]!.valueJitter + 1e-6);
        expect(Math.abs(variation.heightScale - 1)).toBeLessThanOrEqual(FOLIAGE_ASSET_VARIATION[assetId]!.heightJitter + 1e-6);
        expect(Math.abs(variation.widthScale - 1)).toBeLessThanOrEqual(FOLIAGE_ASSET_VARIATION[assetId]!.widthJitter + 1e-6);
        const lean = Math.hypot(variation.leanX, variation.leanZ);
        expect(lean).toBeLessThanOrEqual(FOLIAGE_ASSET_VARIATION[assetId]!.leanMaxRadians + 1e-6);
      }
    }
  });

  it('is stable for the same placement across calls (deterministic seed)', () => {
    for (const assetId of foliageAssets) {
      expect(isStableForPlacement(assetId, 5.7, 0, -3.2)).toBe(true);
      expect(isStableForPlacement(assetId, -12.1, 0, 8.6)).toBe(true);
    }
  });

  it('produces a different variation for the same asset at a different position', () => {
    let changed = 0;
    for (let i = 0; i < 8; i++) {
      const a = computePropVariation('prop-erya-edge-tree', i, 0, 0);
      const b = computePropVariation('prop-erya-edge-tree', i + 0.5, 0, 0);
      if (a.hueShift !== b.hueShift || a.heightScale !== b.heightScale || a.widthScale !== b.widthScale || a.leanX !== b.leanX) changed++;
    }
    expect(changed).toBe(8);
  });

  it('caps tree lean at 4° (~0.0698 rad) regardless of placement', () => {
    const fourLeapMaxRadians = (4 * Math.PI) / 180;
    for (let i = 0; i < 64; i++) {
      const variation = computePropVariation('prop-erya-edge-tree', i * 0.31, 0, i * 0.27);
      expect(Math.hypot(variation.leanX, variation.leanZ)).toBeLessThanOrEqual(fourLeapMaxRadians + 1e-6);
    }
  });

  it('places the sway phase in [0, 2π) so adjacent crowns desync', () => {
    for (const assetId of foliageAssets) {
      if (!FOLIAGE_ASSET_VARIATION[assetId]!.sways) continue;
      for (let i = 0; i < 16; i++) {
        const phase = computePropVariation(assetId, i, 0, i * 1.7).swayPhase;
        expect(phase).toBeGreaterThanOrEqual(0);
        expect(phase).toBeLessThan(Math.PI * 2);
      }
    }
  });

  it('returns the identity variation (no jitter) for assets that have no profile', () => {
    const variation = computePropVariation('prop-bamboo-footbridge', 1, 0, 1);
    expect(variation.hueShift).toBe(0);
    expect(variation.valueScale).toBe(1);
    expect(variation.heightScale).toBe(1);
    expect(variation.widthScale).toBe(1);
    expect(variation.leanX).toBe(0);
    expect(variation.leanZ).toBe(0);
    expect(variation.swayPhase).toBe(0);
  });

  it('derives the variation seed from placement position and asset id', () => {
    expect(variationSeed(1.5, 0, -2.3, 'prop-erya-edge-tree')).not.toBe(variationSeed(1.5, 0, -2.3, 'prop-moonpine-tree'));
    expect(variationSeed(1.5, 0, -2.3, 'prop-erya-edge-tree')).not.toBe(variationSeed(1.5, 0, -2.31, 'prop-erya-edge-tree'));
  });
});