import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import type { Mesh } from 'three';
import { REGIONS as AUTHORED_REGIONS } from '../../src/content/campaign.js';
import { REGIONS as WORLD_REGIONS } from '../../src/content/world.js';
import type { EnvironmentRecipeDefinition, GroundSurfaceDefinition, RegionDefinition } from '../../src/game/contracts.js';
import { CANOPY_COMBAT_TRIALS } from '../../src/game/combat/CombatTrials.js';
import { createCombatTrialRegion } from '../../src/game/combat/TrialRegions.js';
import { biomeProfileFor } from '../../src/world/Biomes.js';
import { CANOPY_BIOME } from '../../src/world/CanopyBiome.js';
import { CANOPY_BOUNDARY_ASSET_IDS, CANOPY_BOUNDARY_CLEARANCE, CANOPY_BOUNDARY_ID_PREFIX, buildCanopyBoundaryPlacements, canopyFootprint } from '../../src/world/CanopyBoundary.js';
import { COURTYARD_POOLS, PLUNGE_POOL, waterMargin } from '../../src/world/CanopyRiver.js';
import { buildWaterfallGeometry, CanopyWaterfall } from '../../src/world/CanopyWaterfall.js';
import { CanopyAtmosphere, LEAF_COUNT, MIST_COUNT, MOTE_COUNT, SPRAY_COUNT } from '../../src/world/CanopyAtmosphere.js';
import { distanceToPolygon, distanceToBoxFootprint, outwardCameraDot, TREE_CAMERA_DOT } from '../../src/world/GreenwakeBoundary.js';
import { GREENWAKE_BIOME } from '../../src/world/GreenwakeBiome.js';
import { GroundClutter } from '../../src/world/GroundClutter.js';
import { createMaskSample, bakeGroundMask, sampleMask } from '../../src/world/GroundMask.js';
import { buildTerrainMeshData, TerrainField } from '../../src/world/GroundTerrain.js';
import { buildWaterData, GroundWater, WATER_RENDER_ORDER } from '../../src/world/GroundWater.js';
import { RegionEnvironment } from '../../src/world/RegionEnvironment.js';
import { isBridgeDeckSurface, isFlatGroundSurface, isRaisedWalkSurface } from '../../src/world/WalkSurfaces.js';

const authored = (AUTHORED_REGIONS as RegionDefinition[]).find((candidate) => candidate.id === 'whispering-canopy')!;
const region = createCombatTrialRegion(authored);
const field = new TerrainField(region, CANOPY_BIOME);
const walkables = region.ground.surfaces.filter((surface) => surface.walkable);
const decks = walkables.filter(isBridgeDeckSurface);
const terrainBacked = walkables.filter((surface) => !isBridgeDeckSurface(surface));

function inside(surface: GroundSurfaceDefinition, x: number, z: number): boolean {
  let result = false;
  const points = surface.points;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!;
    const b = points[j]!;
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) result = !result;
  }
  return result;
}

/** Walkable height by the fan triangulation from vertex 0 (as the simulation and the bridge model share). */
function planeHeight(surface: GroundSurfaceDefinition, x: number, z: number): number {
  const p = surface.points;
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[0]!;
    const b = p[i]!;
    const c = p[i + 1]!;
    const det = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
    if (det === 0) continue;
    const u = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / det;
    const v = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / det;
    if (u >= -1e-9 && v >= -1e-9 && 1 - u - v >= -1e-9) return u * a.y + v * b.y + (1 - u - v) * c.y;
  }
  return p[0]!.y;
}

const polygons = walkables.map((surface) => ({ points: surface.points.map((point) => ({ x: point.x, z: point.z })) }));
const distanceToWalkable = (x: number, z: number): number => Math.min(...polygons.map((polygon) => distanceToPolygon(polygon.points, x, z)));

test('the canopy playtest variant gets the canopy biome; the authored region and other regions keep the generic look', () => {
  assert.equal(biomeProfileFor(region), CANOPY_BIOME);
  assert.equal(biomeProfileFor(authored), undefined);
  assert.equal(biomeProfileFor((WORLD_REGIONS as RegionDefinition[]).find((candidate) => candidate.id === 'greenwake')!), GREENWAKE_BIOME);
});

test('canopy terrain reproduces every terrain-backed walk surface within 2 cm, flat and ramp, right up to the edges', () => {
  assert.equal(terrainBacked.length, 7);
  for (const surface of terrainBacked) {
    assert.ok(isFlatGroundSurface(surface) || isRaisedWalkSurface(surface));
    const xs = surface.points.map((point) => point.x);
    const zs = surface.points.map((point) => point.z);
    let checked = 0;
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += 0.37) {
      for (let z = Math.min(...zs); z <= Math.max(...zs); z += 0.37) {
        if (!inside(surface, x, z)) continue;
        checked++;
        const expected = planeHeight(surface, x, z);
        assert.ok(Math.abs(field.sample(x, z) - expected) <= 0.02, `${surface.id} at (${x.toFixed(2)}, ${z.toFixed(2)}): ${field.sample(x, z)} vs ${expected}`);
      }
    }
    for (let index = 0; index < surface.points.length; index++) {
      const a = surface.points[index]!;
      const b = surface.points[(index + 1) % surface.points.length]!;
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      for (let along = 0.05; along < length; along += 0.23) {
        for (const inset of [0.002, 0.03, 0.12, 0.3]) {
          for (const sign of [-1, 1]) {
            const x = a.x + ((b.x - a.x) / length) * along + (sign * (b.z - a.z) / length) * inset;
            const z = a.z + ((b.z - a.z) / length) * along - (sign * (b.x - a.x) / length) * inset;
            if (inside(surface, x, z)) assert.ok(Math.abs(field.sample(x, z) - planeHeight(surface, x, z)) <= 0.02, `${surface.id} edge (${x.toFixed(3)}, ${z.toFixed(3)})`);
          }
        }
      }
    }
    assert.ok(checked > 20, `${surface.id} barely sampled`);
  }
});

test('ramps meet flat and top surfaces continuously (root stair, temple descent)', () => {
  for (const [x, z, y] of [[-36.02, -28, 0], [-35.98, -28, 0.01], [-24.02, -28, 3.99], [-23.98, -28, 4], [23.98, -22, 4], [24.02, -22, 4], [37.98, -22, 0.01], [38.02, -22, 0]] as const) {
    assert.ok(Math.abs(field.sample(x, z) - y) <= 0.03, `terrain at (${x}, ${z}) = ${field.sample(x, z)}, expected ${y}`);
  }
});

test('the bridge decks are not terrain-backed and the gorge and chasm lie ≥ 2.5 m below them under the mid-spans', () => {
  assert.equal(decks.length, 2);
  for (const deck of decks) {
    assert.equal(deck.material, 'canopy-bridge-deck');
    const xs = deck.points.map((point) => point.x);
    const zs = deck.points.map((point) => point.z);
    const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
    const deckY = deck.points[0]!.y;
    assert.equal(field.surfaceHeightAt(mid, (Math.min(...zs) + Math.max(...zs)) / 2), undefined);
    for (let x = mid - 3.5; x <= mid + 3.5; x += 0.25) {
      for (let z = Math.min(...zs); z <= Math.max(...zs); z += 0.25) assert.ok(deckY - field.sample(x, z) >= 2.5, `${deck.id}: terrain ${field.sample(x, z)} under (${x.toFixed(2)}, ${z.toFixed(2)})`);
    }
    assert.ok(deckY - field.sample(mid, (Math.min(...zs) + Math.max(...zs)) / 2) >= 6, 'the bridges span a real drop');
  }
});

test('the cliff tops are summits of a rock massif: hummocky plateaus around the walkables and steep faces down to the valley floor', () => {
  for (const [x, z] of [[-20, -38], [2, -42]] as const) assert.ok(Math.abs(field.sample(x, z) - 4) <= 0.6, `giant tree base at (${x}, ${z}) = ${field.sample(x, z)}`);
  // South face of the roost: a 4 m cliff within a few metres, camera-facing.
  assert.ok(field.sample(2, -10) - field.sample(2, -5) >= 3, 'roost south face');
  // The west cliff behind the waterfall rises ≥ 9 m over the plunge pool.
  assert.ok(field.sample(-80, -39.5) - PLUNGE_POOL.waterY >= 9);
});

test('water and carved channels never touch a walkable: river, pools, waterfall and the whole water mesh stay off the walk-mesh', () => {
  const data = buildWaterData(field, CANOPY_BIOME.water);
  const vertexCount = data.positions.length / 3;
  for (let index = 0; index < vertexCount; index++) {
    const x = data.positions[index * 3]!;
    const z = data.positions[index * 3 + 2]!;
    for (const surface of terrainBacked) assert.ok(!inside(surface, x, z), `water vertex (${x.toFixed(2)}, ${z.toFixed(2)}) inside ${surface.id}`);
  }
  for (const surface of terrainBacked) {
    const xs = surface.points.map((point) => point.x);
    const zs = surface.points.map((point) => point.z);
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += 0.5) {
      for (let z = Math.min(...zs); z <= Math.max(...zs); z += 0.5) if (inside(surface, x, z)) assert.ok(waterMargin(x, z) > 0.3, `${surface.id} (${x}, ${z}) is in water`);
    }
  }
  // The plunge pool lies south-west of the basin edge, outside the walk-mesh; the courtyard pools too.
  for (const pool of [PLUNGE_POOL, ...COURTYARD_POOLS]) {
    for (let angle = 0; angle < Math.PI * 2; angle += 0.1) {
      const edge = { x: pool.x + Math.cos(angle) * pool.radiusX * 1.12, z: pool.z + Math.sin(angle) * pool.radiusZ * 1.12 };
      assert.ok(distanceToWalkable(edge.x, edge.z) >= 1.2, `pool at (${pool.x}, ${pool.z}) reaches ${distanceToWalkable(edge.x, edge.z)} m from a walkable`);
    }
  }
  const fall = buildWaterfallGeometry(field);
  for (let index = 0; index < fall.positions.length / 3; index++) {
    const x = fall.positions[index * 3]!;
    const y = fall.positions[index * 3 + 1]!;
    const z = fall.positions[index * 3 + 2]!;
    assert.ok(distanceToWalkable(x, z) >= 2, `waterfall vertex (${x.toFixed(1)}, ${z.toFixed(1)}) is ${distanceToWalkable(x, z)} m from a walkable`);
    // The sheet hugs the cliff: never buried in the rock, never floating more than a metre off it.
    if (fall.coordinates[index * 3 + 1]! > 0.12) assert.ok(field.sample(x, z) <= y + 0.05, `waterfall vertex buried at (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`);
    if (fall.coordinates[index * 3 + 1]! > 0.12) assert.ok(field.sample(x - 1, z) >= y - 0.5, `waterfall vertex floats at (${x.toFixed(1)}, ${y.toFixed(1)}, ${z.toFixed(1)})`);
  }
  assert.ok(fall.lipY - fall.baseY >= 9 && fall.lipY - fall.baseY <= 13);
});

test('water, waterfall and particles render before / without depth writes, in few draw calls, from the world clock', () => {
  const water = new GroundWater(field, CANOPY_BIOME.water);
  const waterfall = new CanopyWaterfall(field);
  const atmosphere = new CanopyAtmosphere({ region, field, sunDirection: water.mesh.position.clone().set(-0.7, 0.62, 0.25).normalize() });
  try {
    for (const mesh of [water.mesh, waterfall.mesh]) {
      assert.equal(mesh.renderOrder, WATER_RENDER_ORDER);
      assert.equal(mesh.material.transparent, true);
      assert.equal(mesh.material.depthWrite, false);
      assert.equal(mesh.castShadow, false);
    }
    water.update(3);
    waterfall.update(3);
    atmosphere.update(3, { x: -50, y: 0, z: -28 });
    assert.equal(water.mesh.material.uniforms.uTime!.value, 3);
    assert.equal(waterfall.mesh.material.uniforms.uTime!.value, 3);
    assert.equal(atmosphere.points.material.uniforms.uTime!.value, 3);
    assert.equal(atmosphere.points.geometry.getAttribute('aKind').count, LEAF_COUNT + MOTE_COUNT + SPRAY_COUNT + MIST_COUNT);
    assert.ok(MIST_COUNT > 0 && atmosphere.shafts !== undefined);
    atmosphere.setReducedEffects(true);
    assert.equal(atmosphere.points.material.uniforms.uReduced!.value, 1);
    assert.equal(atmosphere.shafts!.visible, false);
  } finally {
    water.dispose();
    waterfall.dispose();
    atmosphere.dispose();
  }
});

test('boundary dressing: deterministic, decoration-only, ≥ 0.6 m from every walkable and bridge, off the water, camera-friendly, exactly the contract prop set', () => {
  const keepClear = {
    gates: CANOPY_COMBAT_TRIALS.map((trial) => trial.gate),
    arenas: CANOPY_COMBAT_TRIALS.map((trial) => trial.arena),
    obstacles: region.props.filter((prop) => !prop.id.startsWith(CANOPY_BOUNDARY_ID_PREFIX) && (prop.assetId === 'prop-rainforest-canopy-tree' || prop.assetId === 'prop-ancient-canopy-shrine')).map((prop) => ({ x: prop.position.x, z: prop.position.z, radius: prop.assetId === 'prop-ancient-canopy-shrine' ? 7.5 : 4 })),
  };
  const placements = buildCanopyBoundaryPlacements(region, keepClear);
  assert.equal(JSON.stringify(buildCanopyBoundaryPlacements(region, keepClear)), JSON.stringify(placements), 'deterministic');
  assert.ok(placements.length > 150);
  assert.equal(new Set(placements.map((placement) => placement.id)).size, placements.length);
  const boundary = region.props.filter((prop) => prop.id.startsWith(CANOPY_BOUNDARY_ID_PREFIX));
  assert.equal(boundary.length, placements.length, 'the region carries exactly this dressing');
  assert.deepEqual(new Set(placements.map((placement) => placement.assetId)), new Set(CANOPY_BOUNDARY_ASSET_IDS));
  assert.deepEqual([...new Set(region.props.map((prop) => prop.assetId))].sort(), ['prop-ancient-canopy-shrine', 'prop-canopy-cliff-rock', 'prop-canopy-fern-cluster', 'prop-rainforest-canopy-tree', 'prop-vine-bridge']);
  const edgePolygons = polygons.filter((_, index) => !isBridgeDeckSurface(walkables[index]!));
  for (const placement of placements) {
    const circle = canopyFootprint(placement.assetId, placement.position, placement.scale);
    assert.equal(placement.placement, 'ground');
    assert.ok(distanceToWalkable(circle.x, circle.z) - circle.radius >= 0.6, `${placement.id} is ${distanceToWalkable(circle.x, circle.z) - circle.radius} m from a walkable`);
    for (const gate of keepClear.gates) assert.ok(distanceToBoxFootprint(gate, circle.x, circle.z) >= circle.radius);
    assert.ok(waterMargin(circle.x, circle.z) >= 0.4 + 0.5 * circle.radius - 1e-9, `${placement.id} stands in the water`);
    if (placement.assetId === 'prop-rainforest-canopy-tree') assert.ok(outwardCameraDot(edgePolygons, circle.x, circle.z) <= TREE_CAMERA_DOT, `${placement.id} on a camera-facing side`);
    if (placement.assetId === 'prop-canopy-fern-cluster') assert.ok(placement.scale.x <= 1.3 && placement.scale.y <= 1.7, 'ferns stay low');
  }
});

test('terrain mesh, mask textures, clutter and draw calls stay within Greenwake budgets', () => {
  const canopy = buildTerrainMeshData(field);
  const greenwake = (WORLD_REGIONS as RegionDefinition[]).find((candidate) => candidate.id === 'greenwake')!;
  const greenwakeField = new TerrainField(greenwake, GREENWAKE_BIOME);
  const reference = buildTerrainMeshData(greenwakeField);
  assert.ok(canopy.positions.length <= reference.positions.length, `${canopy.positions.length / 3} vs ${reference.positions.length / 3} vertices`);
  assert.ok(canopy.indices.length <= reference.indices.length, `${canopy.indices.length / 3} vs ${reference.indices.length / 3} triangles`);
  const mask = bakeGroundMask(region, field, CANOPY_BIOME);
  const greenwakeMask = bakeGroundMask(greenwake, greenwakeField, GREENWAKE_BIOME);
  assert.ok(mask.shade.length + mask.detail.length + mask.terrain.length < greenwakeMask.shade.length + greenwakeMask.detail.length + greenwakeMask.terrain.length);
  const clutter = new GroundClutter(region, field, mask, { value: 0 }, CANOPY_BIOME);
  const greenwakeClutter = new GroundClutter(greenwake, greenwakeField, greenwakeMask, { value: 0 }, GREENWAKE_BIOME);
  try {
    assert.ok(clutter.drawCalls <= greenwakeClutter.drawCalls, `${clutter.drawCalls} clutter draw calls`);
    assert.ok(clutter.triangleCount <= greenwakeClutter.triangleCount * 1.05, `${clutter.triangleCount} vs ${greenwakeClutter.triangleCount} clutter triangles`);
    assert.ok(CANOPY_BIOME.understory.grass.bladeHeight * CANOPY_BIOME.understory.grass.heightScale > GREENWAKE_BIOME.understory.grass.bladeHeight * GREENWAKE_BIOME.understory.grass.heightScale);
    const scratch = createMaskSample();
    const names = new Set<string>();
    clutter.forEachInstance((name, x, z) => {
      names.add(name);
      assert.ok(sampleMask(mask, x, z, scratch).core <= 0.36, `${name} on the trail core at (${x.toFixed(1)}, ${z.toFixed(1)})`);
      assert.ok(scratch.bed <= 0.1 && scratch.deck <= 0.05, `${name} in the water or under a bridge`);
    });
    for (const expected of ['jungle-fern', 'broadleaf', 'big-leaf', 'log', 'root', 'mushroom']) assert.ok(names.has(`ground-clutter-${expected}`), `${expected} missing`);
  } finally {
    clutter.dispose();
    greenwakeClutter.dispose();
  }
});

test('the ground paints rock on the cliffs, mud and gravel on the banks, and the trail only along the route', () => {
  const mask = bakeGroundMask(region, field, CANOPY_BIOME);
  const s = createMaskSample();
  assert.ok(sampleMask(mask, -13.6, -28.5, s).rock >= 0.5, 'gorge wall');
  assert.ok(sampleMask(mask, -9, -28.5, s).bed >= 0.8, 'river gravel under the bridge');
  assert.ok(sampleMask(mask, -9, -28.5, s).deck >= 0.9, 'bridge underside');
  for (const ribbon of region.navigation.ribbons) {
    for (let index = 1; index < ribbon.points.length; index++) {
      const a = ribbon.points[index - 1]!;
      const b = ribbon.points[index]!;
      const mx = (a.x + b.x) / 2;
      const mz = (a.z + b.z) / 2;
      if (decks.some((deck) => inside(deck, mx, mz))) continue;
      assert.ok(sampleMask(mask, mx, mz, s).core >= 0.9, `trail core at (${mx.toFixed(1)}, ${mz.toFixed(1)})`);
    }
  }
  // The roost's far corner is a wide walkable area off the route: natural ground, no trail core, short sparse cover rather than a bare plate.
  assert.ok(sampleMask(mask, 9, -36, s).core === 0 && s.interior >= 0.9 && s.walk <= 0.2);
});

test('textures: every canopy layer is a CC0 Poly Haven set with provenance next to its maps', () => {
  for (const layer of CANOPY_BIOME.splat.layers) {
    const directory = new URL(`../../asset-source/textures/canopy/${layer.id}/`, import.meta.url);
    for (const file of ['diffuse.jpg', 'normal.jpg', 'arm.jpg', 'provenance.json']) assert.ok(existsSync(new URL(file, directory)), `${layer.id}/${file}`);
    const provenance = JSON.parse(readFileSync(new URL('provenance.json', directory), 'utf8')) as { assetId: string; license: string; sourceUrl: string };
    assert.equal(provenance.assetId, layer.id);
    assert.equal(provenance.license, 'CC0');
    assert.ok(provenance.sourceUrl.startsWith('https://polyhaven.com/a/'));
  }
});

test('RegionEnvironment builds the canopy world for the playtest variant only: no slabs or bridge decks, water, waterfall and particles', { timeout: 120_000 }, () => {
  const environment = new RegionEnvironment(region, {} as unknown as EnvironmentRecipeDefinition);
  environment.ready.catch(() => undefined);
  const plain = new RegionEnvironment(authored, {} as unknown as EnvironmentRecipeDefinition);
  try {
    const names: string[] = [];
    environment.group.traverse((node) => {
      if ((node as Mesh).isMesh || node.type === 'Points') names.push(node.name);
    });
    assert.equal(names.filter((name) => name.startsWith('surface:')).length, 0);
    for (const expected of ['whispering-canopy-terrain', 'canopy-water', 'canopy-waterfall', 'canopy-particles', 'canopy-light-shafts']) assert.ok(names.includes(expected), `${expected} missing`);
    environment.update(5, { x: -50, y: 0, z: -28 });
    assert.ok(Math.abs(environment.visualGroundHeightAt(-20, -30) - 4) <= 0.02);
    assert.ok(environment.visualGroundHeightAt(-9, -28.5) <= 1.5);
    environment.setReducedEffects(true);
    assert.equal(plain.profile, undefined);
    let plainSlabs = 0;
    plain.group.traverse((node) => {
      if (node.name.startsWith('surface:')) plainSlabs++;
    });
    assert.ok(plainSlabs > 0, 'the authored canopy region keeps its generic slabs');
  } finally {
    environment.dispose();
    plain.dispose();
  }
});
