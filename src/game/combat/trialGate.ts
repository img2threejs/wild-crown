import type { RegionColliderDefinition } from '../contracts.js';

const GATE_THICKNESS = 0.6;
const GATE_CLEARANCE = 4.5;

/**
 * A sealed gate: one solid box covering the complete walkable cross-section of a route chokepoint plus 1 m of void on
 * each side, at least 4 m above the highest floor under it. `acrossX` gates span X (the route runs along Z).
 */
export function trialGate(id: string, x: number, z: number, acrossX: boolean, lowFloor: number, highFloor: number): RegionColliderDefinition {
  const bottom = lowFloor - 0.5, top = highFloor + GATE_CLEARANCE;
  return {
    id: 'trial-gate:' + id, kind: 'box', from: { x, y: (bottom + top) / 2, z },
    halfExtents: acrossX ? { x: 4.5, y: (top - bottom) / 2, z: GATE_THICKNESS } : { x: GATE_THICKNESS, y: (top - bottom) / 2, z: 4.5 },
    blocksMovement: true, blocksCamera: true,
  };
}
