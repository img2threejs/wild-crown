import { describe, expect, it } from 'bun:test';
import { REGIONS } from '../../src/content/campaign.js';
import { solidPropKind } from '../../src/content/solid-props.js';
import { GREENWAKE_BOUNDARY_ID_PREFIX, TREE_CAMERA_DOT, distanceToBoxFootprint, distanceToWalkMesh, greenwakeFootprint, outwardCameraDot } from '../../src/world/GreenwakeBoundary.js';
import { GREENWAKE_COMBAT_TRIALS } from '../../src/game/combat/CombatTrials.js';
import { createCombatTrialRegion } from '../../src/game/combat/TrialRegions.js';
import { vec } from '../../src/game/combat/geometry.js';
import type { RegionDefinition, Vec3 } from '../../src/game/contracts.js';
import { describeSealedRoute } from './sealed-route-harness.js';

const authored = REGIONS.find(region => region.id === 'greenwake')!;
const region: RegionDefinition = createCombatTrialRegion(authored);
const gates = GREENWAKE_COMBAT_TRIALS.map(trial => trial.gate);
const exit = authored.exits.find(route => route.id === 'greenwake-canopy-out')!.from;

describeSealedRoute({
  name: 'Greenwake', regionId: 'greenwake', encounterId: 'greenwake-boar', region, trials: GREENWAKE_COMBAT_TRIALS,
  start: authored.navigation.nodes[0]!.position, exit, forward: [vec(0, 0, 1), vec(0, 0, 1), vec(1, 0, 0)], minWalkableCells: 4000,
});

describe('Greenwake arena pockets', () => {
  it('builds the Frost Hollow and Root Watch pockets as flat y=0 octagons with box colliders and no canopy floor', () => {
    for (const id of ['greenwake-frost-hollow', 'greenwake-root-watch']) {
      const surface = region.ground.surfaces.find(candidate => candidate.id === id)!;
      expect(surface.points.length).toBeGreaterThanOrEqual(5);
      expect(surface.points.every(point => point.y === 0)).toBe(true);
      const collider = region.ground.colliders.find(candidate => candidate.id === surface.colliderId)!;
      expect(collider.kind).toBe('box');
      expect(collider.walkSurfaceId).toBe(id);
    }
    expect(region.ground.surfaces.some(surface => surface.id === 'greenwake-canopy-floor')).toBe(false);
    expect(region.ground.colliders.some(collider => collider.id === 'greenwake-canopy-floor-collider')).toBe(false);
  });
});

describe('Greenwake boundary dressing', () => {
  const boundary = region.props.filter(prop => prop.id.startsWith(GREENWAKE_BOUNDARY_ID_PREFIX));
  const byAsset = (assetId: string) => boundary.filter(prop => prop.assetId === assetId);

  it('is deterministic, uniquely named, and spread over both rings', () => {
    expect(JSON.stringify(createCombatTrialRegion(authored).props)).toBe(JSON.stringify(region.props));
    expect(new Set(region.props.map(prop => prop.id)).size).toBe(region.props.length);
    // Perf budget: clustered placement (groups of 2-5) produces more instances per edge than the previous regular lattice; the
    // old ceiling was 36 bramble / 48 boulder / 48 tree (~ +16 boulder rock outcrops). The cluster budget is wider but still
    // far under an unthinned jungle, and the per-cell draw count remains the same.
    const brambles = byAsset('prop-greenwake-bramble-wall'), boulders = byAsset('prop-greenwake-boulder-cluster'), trees = byAsset('prop-erya-edge-tree');
    expect(brambles.length).toBeGreaterThan(8);
    expect(boulders.length).toBeGreaterThan(15);
    expect(trees.length).toBeGreaterThan(8);
    expect(brambles.length).toBeLessThanOrEqual(28);
    expect(boulders.length).toBeLessThanOrEqual(70);
    expect(trees.length).toBeLessThanOrEqual(36);
    // Bramble walls are stretched along the edge rather than multiplied.
    for (const bramble of brambles) expect(bramble.scale.x).toBeGreaterThan(bramble.scale.z * 1.4);
    for (const tree of trees) {
      expect(tree.scale.x).toBeGreaterThanOrEqual(0.5);
      expect(tree.scale.x).toBeLessThanOrEqual(0.8);
    }
    expect(boundary.every(prop => prop.placement === 'ground' && prop.position.y === 0)).toBe(true);
    // Clustered placement: each edge is broken into clusters of 2-5 props spaced 0.4-3 m apart (the cluster span), then a 3-8 m gap.
    // The old regular lattice (uniform 4-5.5 m / 6-9 m) is gone; the cluster-vs-gap signature replaces it. Variance on nearest-neighbour
    // spacing is a stronger signal of the decluster than any single bound.
    const edges = new Map<string, { position: Vec3; tree: boolean; serial: number }[]>();
    for (const prop of boundary) {
      if (prop.id.endsWith('corner')) continue;
      const [, kind, polygon, edge, serial] = prop.id.slice(GREENWAKE_BOUNDARY_ID_PREFIX.length - 1).split('-');
      const key = `${kind}-${polygon}-${edge}`;
      edges.set(key, [...(edges.get(key) ?? []), { position: prop.position, tree: kind === 'tree', serial: Number(serial) }]);
    }
    const spacings: number[] = [];
    for (const list of edges.values()) {
      list.sort((a, b) => a.serial - b.serial);
      for (let index = 1; index < list.length; index++) {
        spacings.push(Math.hypot(list[index]!.position.x - list[index - 1]!.position.x, list[index]!.position.z - list[index - 1]!.position.z));
      }
    }
    expect(spacings.length).toBeGreaterThan(20);
    const mean = spacings.reduce((acc, value) => acc + value, 0) / spacings.length;
    const variance = spacings.reduce((acc, value) => acc + (value - mean) ** 2, 0) / spacings.length;
    expect(variance).toBeGreaterThan(1.5); // a uniform 4-5 m lattice would score well under 1; clusters push this past 2.
    expect(Math.min(...spacings)).toBeLessThan(2.5); // in-cluster pairs sit within ~clusterSpan/2
    expect(Math.max(...spacings)).toBeGreaterThan(5); // cluster-to-cluster gaps exceed the cluster span
  });

  it('adds no simulation solids: boundary ids classify as decoration, authored trees stay trunks', () => {
    expect(boundary.length).toBeGreaterThan(40);
    for (const prop of boundary) expect(solidPropKind(prop)).toBe('decoration');
    const authoredTree = authored.props.find(prop => prop.id.startsWith('greenwake-edge-tree-'))!;
    expect(solidPropKind(authoredTree)).toBe('trunk');
    expect(solidPropKind({ ...authoredTree, id: 'greenwake-boundary-tree-x' })).toBe('decoration');
  });

  it('keeps every footprint 0.8 m off the walk-mesh and out of gate boxes, arenas and the Forest Exit', () => {
    for (const prop of boundary) {
      for (const circle of greenwakeFootprint(prop.assetId, prop.position, prop.rotationY, prop.scale)) {
        expect(distanceToWalkMesh(region, circle.x, circle.z)).toBeGreaterThanOrEqual(circle.radius + 0.8 - 1e-9);
        for (const gate of gates) expect(distanceToBoxFootprint(gate, circle.x, circle.z)).toBeGreaterThanOrEqual(circle.radius + 0.5 - 1e-9);
        for (const trial of GREENWAKE_COMBAT_TRIALS) {
          expect(Math.hypot(circle.x - trial.arena.center.x, circle.z - trial.arena.center.z)).toBeGreaterThanOrEqual(trial.arena.radius + circle.radius);
        }
        expect(Math.hypot(circle.x - exit.x, circle.z - exit.z)).toBeGreaterThanOrEqual(circle.radius + 2.2);
      }
    }
  });

  it('only places trees away from the camera side of the route (camera offset +10, +12, +14)', () => {
    const walkable = region.ground.surfaces.filter(surface => surface.walkable);
    const facing = (x: number, z: number) => outwardCameraDot(walkable, x, z);
    for (const tree of byAsset('prop-erya-edge-tree')) expect(facing(tree.position.x, tree.position.z)).toBeLessThanOrEqual(TREE_CAMERA_DOT + 1e-9);
    // Low props do wrap the camera-facing edges.
    expect(boundary.filter(prop => prop.assetId !== 'prop-erya-edge-tree' && facing(prop.position.x, prop.position.z) > 0.5).length).toBeGreaterThan(10);
  });
});
