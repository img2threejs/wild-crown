import { describe, expect, it } from 'bun:test';
import { REGIONS } from '../../src/content/campaign.js';
import { createCombatTrialRegion } from '../../src/game/combat/TrialRegions.js';
import { arenaFromRegion, moveCircle, type CombatArena, type SupportField } from '../../src/game/combat/geometry.js';
import type { RegionDefinition, Vec3 } from '../../src/game/contracts.js';
import { isBridgeDeckSurface } from '../../src/world/WalkSurfaces.js';
import { buildStaticPropColliders } from '../../src/rendering/NativeSolidColliders.js';
import { glbStaticBatch } from './glb-static-batch.js';

/**
 * The real bridge models, measured as the renderer measures them, against the authored walk-mesh the simulation uses:
 * the rendered deck is the supported height, and the deck can be crossed end to end with the feet on it.
 */
interface Bridge { readonly name: string; readonly playtest: string; readonly region: RegionDefinition; readonly placementId: string; readonly from: Vec3; readonly length: number }

const authoredRegion = (id: string) => REGIONS.find(region => region.id === id)!;
const BRIDGES: readonly Bridge[] = [
  { name: 'Canopy vine bridge A', playtest: 'canopy', region: createCombatTrialRegion(authoredRegion('whispering-canopy')), placementId: 'canopy-trial-bridge-a', from: { x: -19, y: 4, z: -28.5 }, length: 18 },
  { name: 'Canopy vine bridge B', playtest: 'canopy', region: createCombatTrialRegion(authoredRegion('whispering-canopy')), placementId: 'canopy-trial-bridge-b', from: { x: 8, y: 4, z: -23.5 }, length: 18 },
  { name: 'Moonpine log bridge', playtest: 'moonpine', region: createCombatTrialRegion(authoredRegion('moonpine-ridge')), placementId: 'moonpine-trial-bridge', from: { x: -20, y: 0, z: -22 }, length: 18 },
  { name: 'Greenwake rope bridge', playtest: 'greenwake', region: authoredRegion('greenwake'), placementId: 'greenwake-branch-bridge', from: { x: 10, y: 2, z: 18.5 }, length: 14 },
];

function measure(bridge: Bridge): { arena: CombatArena; field: SupportField } {
  const placement = bridge.region.props.find(candidate => candidate.id === bridge.placementId)!;
  const entries = buildStaticPropColliders(glbStaticBatch(bridge.playtest, placement), [placement], { ...bridge.region, movableObjects: [] });
  const field = entries.find(entry => entry.support)!.support!;
  const authored = arenaFromRegion(bridge.region);
  return { arena: { ...authored, colliders: [...authored.colliders, ...entries.map(entry => entry.collider)], supports: [field] }, field };
}

function walk(arena: CombatArena, from: Vec3, lane: number, length: number): { x: number; y: number; min: number; max: number } {
  let position = { x: from.x, y: from.y, z: from.z + lane };
  let min = Infinity, max = -Infinity;
  for (let step = 0; step < length / 0.0667; step++) {
    position = moveCircle(arena, position, { x: 0.0667, y: 0, z: 0 }, 0.42, 1.6);
    min = Math.min(min, position.y); max = Math.max(max, position.y);
  }
  return { x: position.x, y: position.y, min, max };
}

describe('measured bridge decks of the real native models', () => {
  for (const bridge of BRIDGES) {
    const { arena, field } = measure(bridge);
    const deckSurfaces = arena.surfaces.filter(isBridgeDeckSurface);

    it(`${bridge.name}: the rendered deck agrees with the authored deck height it replaces`, () => {
      expect(deckSurfaces.length).toBeGreaterThan(0);
      let compared = 0;
      for (let row = 0; row < field.rows; row++) for (let column = 0; column < field.cols; column++) {
        const index = row * field.cols + column;
        if (field.stand[index] !== 1) continue;
        const x = field.minX + (column + 0.5) * field.cell, z = field.minZ + (row + 0.5) * field.cell;
        const surface = deckSurfaces.find(candidate => x >= Math.min(...candidate.points.map(point => point.x)) && x <= Math.max(...candidate.points.map(point => point.x))
          && z >= Math.min(...candidate.points.map(point => point.z)) && z <= Math.max(...candidate.points.map(point => point.z)));
        if (!surface) continue;
        compared++;
        expect(Math.abs(field.top[index]! - surface.elevation)).toBeLessThan(0.3);
      }
      expect(compared).toBeGreaterThan(40);
    });

    it(`${bridge.name}: is crossed end to end by the capsule with its feet on the measured deck`, () => {
      expect(walk(arena, bridge.from, 0, bridge.length).x).toBeGreaterThan(bridge.from.x + bridge.length - 0.1);
      // The feet follow the measured deck: no snap up onto a rail or post top, no drop into the gully beneath.
      const onDeck = walk(arena, bridge.from, 0, bridge.length / 2);
      expect(onDeck.max - onDeck.min).toBeLessThan(0.7);
    });

    it(`${bridge.name}: a lane beyond the measured deck width is not walkable in the air`, () => {
      const result = walk(arena, bridge.from, 1.6, bridge.length);
      expect(result.x).toBeLessThan(bridge.from.x + bridge.length - 1);
    });
  }
});
