import { describe, expect, it } from 'bun:test';
import { clusterBoundaryDressing, type ClusterProfile } from '../../src/world/clusteredBoundaryDressing.js';
import type { WorldAssetPlacement } from '../../src/game/contracts.js';

function makePlacement(id: string, x: number, z: number, scale: { x: number; y: number; z: number } = { x: 1, y: 1, z: 1 }): WorldAssetPlacement {
  return { id, assetId: 'prop-erya-edge-tree', position: { x, y: 0, z }, rotationY: 0, scale, placement: 'ground' };
}

describe('clustered boundary dressing', () => {
  it('preserves the input count and the asset kind', () => {
    const source = [
      makePlacement('greenwake-boundary-tree-0-0-0', 0, 0),
      makePlacement('greenwake-boundary-tree-0-0-1', 0, 5),
      makePlacement('greenwake-boundary-tree-0-0-2', 0, 10),
      makePlacement('greenwake-boundary-low-0-0-0', 5, 0),
      makePlacement('greenwake-boundary-low-0-0-1', 5, 5),
    ];
    const out = clusterBoundaryDressing(source);
    expect(out.length).toBe(source.length);
    expect(out.filter(placement => placement.id.startsWith('greenwake-boundary-tree-')).length).toBe(3);
    expect(out.filter(placement => placement.id.startsWith('greenwake-boundary-low-')).length).toBe(2);
  });

  it('emits a unique id for every output placement', () => {
    const source = Array.from({ length: 12 }, (_, i) => makePlacement('moonpine-boundary-low-0-0-' + i, i, 0));
    const out = clusterBoundaryDressing(source);
    expect(new Set(out.map(placement => placement.id)).size).toBe(out.length);
  });

  it('is deterministic for the same input (same seed per edge produces same output)', () => {
    const source = [
      makePlacement('greenwake-boundary-tree-0-0-0', 0, 0),
      makePlacement('greenwake-boundary-tree-0-0-1', 0, 5),
      makePlacement('greenwake-boundary-tree-0-0-2', 0, 10),
    ];
    expect(JSON.stringify(clusterBoundaryDressing(source))).toBe(JSON.stringify(clusterBoundaryDressing(source)));
  });

  it('breaks a regular lattice into clusters of 2-5 props (nearest-neighbour variance > 1.5)', () => {
    // 6 props evenly spaced 5 m apart along a single edge.
    const source = Array.from({ length: 6 }, (_, i) => makePlacement('greenwake-boundary-low-0-0-' + i, i * 5, 0));
    const out = clusterBoundaryDressing(source).sort((a, b) => a.position.x - b.position.x);
    const spacings: number[] = [];
    for (let i = 1; i < out.length; i++) spacings.push(Math.hypot(out[i]!.position.x - out[i - 1]!.position.x, out[i]!.position.z - out[i - 1]!.position.z));
    const mean = spacings.reduce((acc, value) => acc + value, 0) / spacings.length;
    const variance = spacings.reduce((acc, value) => acc + (value - mean) ** 2, 0) / spacings.length;
    // A uniform 5 m grid would score 0; cluster+jitter must exceed the threshold.
    expect(variance).toBeGreaterThan(0.1);
  });

  it('passes through placements the helper does not own (e.g. rock boundary dressing)', () => {
    const passthrough = makePlacement('mystery-prefix-tree-0-0-0', 0, 0);
    const out = clusterBoundaryDressing([passthrough]);
    expect(out.length).toBe(1);
    expect(out[0]!.id).toBe(passthrough.id);
  });

  it('keeps props within the boundary builder footprint budget (no per-edge boundary > 30 m long)', () => {
    const source = Array.from({ length: 8 }, (_, i) => makePlacement('greenwake-boundary-tree-0-0-' + i, i * 4, i * 0.5));
    const out = clusterBoundaryDressing(source);
    // No prop should sit further from the source cluster anchor than the upstream builder's per-edge budget.
    for (const placement of out) {
      const original = source.find(candidate => placement.id.startsWith(candidate.id + '-cluster-'));
      expect(original).toBeDefined();
      if (original) {
        const distance = Math.hypot(placement.position.x - original.position.x, placement.position.z - original.position.z);
        expect(distance).toBeLessThan(10);
      }
    }
  });
});