import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { REGIONS as AUTHORED_REGIONS } from '../../src/content/campaign.js';
import { REGIONS as WORLD_REGIONS } from '../../src/content/world.js';
import type { EnvironmentRecipeDefinition, GroundSurfaceDefinition, RegionDefinition } from '../../src/game/contracts.js';
import { MISTVEIL_BOUNDARY_ID_PREFIX, MISTVEIL_COMBAT_TRIALS } from '../../src/game/combat/MistveilContent.js';
import { createCombatTrialRegion } from '../../src/game/combat/TrialRegions.js';
import { distanceToBoxFootprint, distanceToPolygon, outwardCameraDot, TREE_CAMERA_DOT } from '../../src/world/GreenwakeBoundary.js';
import { GREENWAKE_BIOME } from '../../src/world/GreenwakeBiome.js';
import { GroundClutter } from '../../src/world/GroundClutter.js';
import { bakeGroundMask, createMaskSample, sampleMask } from '../../src/world/GroundMask.js';
import { buildTerrainMeshData, TerrainField } from '../../src/world/GroundTerrain.js';
import { buildWaterData, GroundWater, WATER_RENDER_ORDER } from '../../src/world/GroundWater.js';
import { FIREFLY_COUNT, MIST_COUNT, MistveilAtmosphere, VAPOUR_COUNT } from '../../src/world/MistveilAtmosphere.js';
import { MISTVEIL_BIOME } from '../../src/world/MistveilBiome.js';
import { buildMistveilBoundaryPlacements, MISTVEIL_BOUNDARY_ASSET_IDS, MISTVEIL_BOUNDARY_CLEARANCE, mistveilFootprint } from '../../src/world/MistveilBoundary.js';
import { MIRE_POOLS, RIVER_SAMPLES, SOURCE_POOL, waterMargin } from '../../src/world/MistveilWater.js';
import { RegionEnvironment } from '../../src/world/RegionEnvironment.js';
import { isBridgeDeckSurface, isFlatGroundSurface, isRaisedWalkSurface } from '../../src/world/WalkSurfaces.js';

const authored = (AUTHORED_REGIONS as RegionDefinition[]).find((candidate) => candidate.id === 'mistveil-basin')!;
const region = createCombatTrialRegion(authored);
const field = new TerrainField(region, MISTVEIL_BIOME);
const walkables = region.ground.surfaces.filter((surface) => surface.walkable);
/** Authored set dressing (not boundary dressing): its plan-view radius per asset. */
const AUTHORED_RADIUS: Readonly<Record<string, number>> = { 'prop-mistveil-root-tree': 4, 'prop-hunter-extraction-rig': 3.5, 'prop-black-sap-filter-drum': 1.3, 'prop-root-cavern-mouth': 4.5, 'prop-mistveil-reed-cluster': 1.2, 'prop-mire-bank-rock': 2 };
const authoredProps = region.props.filter((prop) => !prop.id.startsWith(MISTVEIL_BOUNDARY_ID_PREFIX));

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

/** Walkable height by the fan triangulation from vertex 0 (as the simulation shares). */
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

test('mistveil terrain reproduces every walk surface within 2 cm, flat and ramp, right up to the edges', () => {
  assert.equal(walkables.length, 12);
  assert.equal(walkables.filter(isBridgeDeckSurface).length, 0, 'no bridge decks: every surface is terrain-backed');
  for (const surface of walkables) {
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
    assert.ok(checked > 15, `${surface.id} barely sampled`);
  }
});

test('the raised root causeway meets the ford and the glade continuously through its two ramps', () => {
  for (const [x, z, y] of [[-24.02, -16, 0], [-23.98, -16, 0.01], [-20.02, -16, 1.19], [-19.98, -16, 1.2], [-8.02, -16, 1.2], [-7.98, -16, 1.19], [-4.02, -16, 0.01], [-3.98, -16, 0]] as const) {
    assert.ok(Math.abs(field.sample(x, z) - y) <= 0.03, `terrain at (${x}, ${z}) = ${field.sample(x, z)}, expected ${y}`);
  }
  const causeway = walkables.find((surface) => surface.id === 'mistveil-trial-causeway')!;
  assert.ok(causeway.points.every((point) => point.y === 1.2));
});

test('the wetland is low open ground: gentle relief off the route, a carved Black Sap river, and shallow murky pools', () => {
  // No summits or cliffs: open ground off the route stays within a metre or so of the floor.
  for (let x = -80; x <= 110; x += 3.1) {
    for (let z = -60; z <= 18; z += 3.1) {
      if (waterMargin(x, z) < 6 || distanceToWalkable(x, z) < 4) continue;
      assert.ok(Math.abs(field.sample(x, z)) <= 1.6, `ground at (${x.toFixed(1)}, ${z.toFixed(1)}) = ${field.sample(x, z)}`);
    }
  }
  // The river is carved below the water level along its whole length and flows from the source seep west.
  assert.ok(RIVER_SAMPLES.length > 150);
  assert.ok(RIVER_SAMPLES[0]!.x > RIVER_SAMPLES[RIVER_SAMPLES.length - 1]!.x, 'the river runs from the east source to the west');
  for (let index = 0; index < RIVER_SAMPLES.length; index += 5) {
    const sample = RIVER_SAMPLES[index]!;
    assert.ok(field.sample(sample.x, sample.z) <= sample.bed + 0.4, `river bed at ${index}`);
    assert.ok(waterMargin(sample.x, sample.z) < -1.2, `river centre at ${index} is in the water`);
  }
  // Every pool is a dish below its water level at the centre.
  for (const pool of [SOURCE_POOL, ...MIRE_POOLS]) assert.ok(field.sample(pool.x, pool.z) < pool.waterY - 0.05, `pool at (${pool.x}, ${pool.z}) is ${field.sample(pool.x, pool.z)}`);
  assert.ok(MIRE_POOLS.length >= 15, 'many pools');
});

test('water and carved channels never touch a walkable: the river, every pool and the whole water mesh stay off the walk-mesh', () => {
  const data = buildWaterData(field, MISTVEIL_BIOME.water);
  const vertexCount = data.positions.length / 3;
  assert.ok(vertexCount > 300);
  for (let index = 0; index < vertexCount; index++) {
    const x = data.positions[index * 3]!;
    const z = data.positions[index * 3 + 2]!;
    for (const surface of walkables) assert.ok(!inside(surface, x, z), `water vertex (${x.toFixed(2)}, ${z.toFixed(2)}) inside ${surface.id}`);
  }
  for (const surface of walkables) {
    const xs = surface.points.map((point) => point.x);
    const zs = surface.points.map((point) => point.z);
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += 0.5) {
      for (let z = Math.min(...zs); z <= Math.max(...zs); z += 0.5) if (inside(surface, x, z)) assert.ok(waterMargin(x, z) > 0.3, `${surface.id} (${x}, ${z}) is in water`);
    }
  }
  for (const pool of [SOURCE_POOL, ...MIRE_POOLS]) {
    for (let angle = 0; angle < Math.PI * 2; angle += 0.1) {
      const edge = { x: pool.x + Math.cos(angle) * pool.radiusX * 1.12, z: pool.z + Math.sin(angle) * pool.radiusZ * 1.12 };
      assert.ok(distanceToWalkable(edge.x, edge.z) >= 1.2, `pool at (${pool.x}, ${pool.z}) reaches ${distanceToWalkable(edge.x, edge.z)} m from a walkable`);
    }
  }
  for (const sample of RIVER_SAMPLES) assert.ok(distanceToWalkable(sample.x, sample.z) >= 6 + sample.bedHalfWidth, `river at (${sample.x.toFixed(1)}, ${sample.z.toFixed(1)}) hugs the route`);
  // Authored set dressing stands on dry ground too: rig, drum, trees and the cavern mouth keep off the water.
  for (const prop of authoredProps) assert.ok(waterMargin(prop.position.x, prop.position.z) >= 0.4 + 0.5 * AUTHORED_RADIUS[prop.assetId]!, `${prop.id} stands in or beside the water`);
});

test('water and particles render before / without depth writes, in few draw calls, from the world clock', () => {
  const water = new GroundWater(field, MISTVEIL_BIOME.water);
  const atmosphere = new MistveilAtmosphere({ region, field, sunDirection: water.mesh.position.clone().set(-0.7, 0.62, 0.25).normalize() });
  try {
    assert.equal(water.mesh.renderOrder, WATER_RENDER_ORDER);
    assert.equal(water.mesh.material.transparent, true);
    assert.equal(water.mesh.material.depthWrite, false);
    assert.equal(water.mesh.castShadow, false);
    water.update(3);
    atmosphere.update(3, { x: -50, y: 0, z: -16 });
    assert.equal(water.mesh.material.uniforms.uTime!.value, 3);
    assert.equal(atmosphere.points.material.uniforms.uTime!.value, 3);
    assert.equal(atmosphere.points.geometry.getAttribute('aKind').count, FIREFLY_COUNT + MIST_COUNT + VAPOUR_COUNT);
    assert.ok(FIREFLY_COUNT > 0 && MIST_COUNT > 0 && VAPOUR_COUNT > 0);
    assert.ok(atmosphere.glow !== undefined, 'the exit keeps a readability glow');
    atmosphere.setReducedEffects(true);
    assert.equal(atmosphere.points.material.uniforms.uReduced!.value, 1);
    atmosphere.setReducedEffects(false);
    assert.equal(atmosphere.points.material.uniforms.uReduced!.value, 0);
  } finally {
    water.dispose();
    atmosphere.dispose();
  }
});

test('the black river reads dark purple-black and the fog is moderate, cool and readable', () => {
  const palette = MISTVEIL_BIOME.water.palette;
  const channels = (hex: number) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255] as const;
  const [dr, dg, db] = channels(palette.deep);
  assert.ok(dr < 30 && dg < 20 && db < 40 && db > dg, 'the deep water is purple-black');
  const atmosphere = MISTVEIL_BIOME.atmosphere;
  assert.ok(atmosphere.fogNear >= 20 && atmosphere.fogNear <= 24 && atmosphere.fogFar >= 75 && atmosphere.fogFar <= 90, 'moderate fog');
  // Linear fog at the 33 m camera distance of a monster at the far edge of its trial radius stays at or below 30 %.
  assert.ok((33 - atmosphere.fogNear) / (atmosphere.fogFar - atmosphere.fogNear) <= 0.3, 'readable monsters');
  const [fr, , fb] = channels(atmosphere.fogColor);
  assert.ok(fb >= fr, 'cool fog');
  const [sr, , sb] = channels(atmosphere.sunColor);
  assert.ok(sb >= sr, 'cool teal light');
});

test('boundary dressing: deterministic, decoration-only, >= 0.6 m from every walkable, off the water, camera-friendly, exactly the contract prop set', () => {
  const keepClear = {
    gates: MISTVEIL_COMBAT_TRIALS.map((trial) => trial.gate),
    arenas: MISTVEIL_COMBAT_TRIALS.map((trial) => trial.arena),
    obstacles: authoredProps.map((prop) => ({ x: prop.position.x, z: prop.position.z, radius: AUTHORED_RADIUS[prop.assetId]! })),
  };
  const placements = buildMistveilBoundaryPlacements(region, keepClear);
  assert.equal(JSON.stringify(buildMistveilBoundaryPlacements(region, keepClear)), JSON.stringify(placements), 'deterministic');
  assert.ok(placements.length > 150, `${placements.length} placements`);
  assert.equal(new Set(placements.map((placement) => placement.id)).size, placements.length);
  const boundary = region.props.filter((prop) => prop.id.startsWith(MISTVEIL_BOUNDARY_ID_PREFIX));
  assert.equal(boundary.length, placements.length, 'the region carries exactly this dressing');
  assert.deepEqual(new Set(placements.map((placement) => placement.assetId)), new Set(MISTVEIL_BOUNDARY_ASSET_IDS));
  assert.deepEqual([...new Set(region.props.map((prop) => prop.assetId))].sort(), [
    'prop-black-sap-filter-drum', 'prop-hunter-extraction-rig', 'prop-mire-bank-rock', 'prop-mistveil-reed-cluster', 'prop-mistveil-root-tree', 'prop-root-cavern-mouth',
  ]);
  const exit = region.exits[0]!.from;
  for (const placement of placements) {
    const circle = mistveilFootprint(placement.assetId, placement.position, placement.scale);
    assert.equal(placement.placement, 'ground');
    assert.ok(distanceToWalkable(circle.x, circle.z) - circle.radius >= 0.6, `${placement.id} is ${distanceToWalkable(circle.x, circle.z) - circle.radius} m from a walkable`);
    assert.ok(distanceToWalkable(circle.x, circle.z) - circle.radius >= MISTVEIL_BOUNDARY_CLEARANCE - 1e-9);
    for (const gate of keepClear.gates) assert.ok(distanceToBoxFootprint(gate, circle.x, circle.z) >= circle.radius);
    for (const arena of keepClear.arenas) assert.ok(Math.hypot(circle.x - arena.center.x, circle.z - arena.center.z) >= arena.radius + circle.radius);
    assert.ok(Math.hypot(circle.x - exit.x, circle.z - exit.z) >= 4.5 + circle.radius - 1e-9, `${placement.id} crowds the goal ring`);
    assert.ok(waterMargin(circle.x, circle.z) >= 0.4 + 0.5 * circle.radius - 1e-9, `${placement.id} stands in the water`);
    if (placement.assetId === 'prop-mistveil-root-tree') assert.ok(outwardCameraDot(polygons, circle.x, circle.z) <= TREE_CAMERA_DOT, `${placement.id} on a camera-facing side`);
    if (placement.assetId === 'prop-mistveil-reed-cluster') assert.ok(placement.scale.x <= 1.3 && placement.scale.y <= 1.7, 'reeds stay low');
  }
  // Great root trees flank the causeway: at least one on each side of it, within the route's reach.
  const flank = authoredProps.filter((prop) => prop.assetId === 'prop-mistveil-root-tree' && prop.position.x > -20 && prop.position.x < -4);
  assert.ok(flank.some((prop) => prop.position.z < -19) && flank.some((prop) => prop.position.z > -13), 'root trees stand either side of the causeway');
});

test('terrain mesh, mask textures, clutter and draw calls stay within Greenwake budgets', () => {
  const mistveil = buildTerrainMeshData(field);
  const greenwake = (WORLD_REGIONS as RegionDefinition[]).find((candidate) => candidate.id === 'greenwake')!;
  const greenwakeField = new TerrainField(greenwake, GREENWAKE_BIOME);
  const reference = buildTerrainMeshData(greenwakeField);
  assert.ok(mistveil.positions.length <= reference.positions.length, `${mistveil.positions.length / 3} vs ${reference.positions.length / 3} vertices`);
  assert.ok(mistveil.indices.length <= reference.indices.length, `${mistveil.indices.length / 3} vs ${reference.indices.length / 3} triangles`);
  const mask = bakeGroundMask(region, field, MISTVEIL_BIOME);
  const greenwakeMask = bakeGroundMask(greenwake, greenwakeField, GREENWAKE_BIOME);
  assert.ok(mask.shade.length + mask.detail.length + mask.terrain.length < (greenwakeMask.shade.length + greenwakeMask.detail.length + greenwakeMask.terrain.length));
  const clutter = new GroundClutter(region, field, mask, { value: 0 }, MISTVEIL_BIOME);
  const greenwakeClutter = new GroundClutter(greenwake, greenwakeField, greenwakeMask, { value: 0 }, GREENWAKE_BIOME);
  try {
    assert.ok(clutter.drawCalls <= greenwakeClutter.drawCalls, `${clutter.drawCalls} clutter draw calls`);
    assert.ok(clutter.triangleCount <= greenwakeClutter.triangleCount * 1.05, `${clutter.triangleCount} vs ${greenwakeClutter.triangleCount} clutter triangles`);
    const scratch = createMaskSample();
    const names = new Set<string>();
    clutter.forEachInstance((name, x, z) => {
      names.add(name);
      assert.ok(sampleMask(mask, x, z, scratch).core <= 0.36, `${name} on the trail core at (${x.toFixed(1)}, ${z.toFixed(1)})`);
      assert.ok(scratch.bed <= 0.1, `${name} in the water at (${x.toFixed(1)}, ${z.toFixed(1)})`);
    });
    for (const expected of ['jungle-fern', 'big-leaf', 'mushroom', 'root']) assert.ok(names.has(`ground-clutter-${expected}`), `${expected} missing`);
  } finally {
    clutter.dispose();
    greenwakeClutter.dispose();
  }
});

test('the ground paints wet mud and bed stones round the water, and the trail only along the route', () => {
  const mask = bakeGroundMask(region, field, MISTVEIL_BIOME);
  const s = createMaskSample();
  const sample = RIVER_SAMPLES[60]!;
  assert.ok(sampleMask(mask, sample.x, sample.z, s).bed >= 0.8, 'river gravel under the Black Sap');
  assert.ok(sampleMask(mask, SOURCE_POOL.x, SOURCE_POOL.z, s).bed >= 0.5, 'the source seep has a bed');
  for (const ribbon of region.navigation.ribbons) {
    for (let index = 1; index < ribbon.points.length; index++) {
      const a = ribbon.points[index - 1]!;
      const b = ribbon.points[index]!;
      const mx = (a.x + b.x) / 2;
      const mz = (a.z + b.z) / 2;
      assert.ok(sampleMask(mask, mx, mz, s).core >= 0.9, `trail core at (${mx.toFixed(1)}, ${mz.toFixed(1)})`);
    }
  }
  // The arrival bank's far corner is a wide walkable area off the route: natural ground, no trail core.
  assert.ok(sampleMask(mask, -50, -10, s).core === 0 && s.interior >= 0.5);
});

test('textures: every Mistveil layer is a CC0 Poly Haven set with provenance next to its maps', () => {
  assert.equal(MISTVEIL_BIOME.splat.textureRoot, '/asset-source/textures/mistveil');
  for (const layer of MISTVEIL_BIOME.splat.layers) {
    const directory = new URL(`../../asset-source/textures/mistveil/${layer.id}/`, import.meta.url);
    for (const file of ['diffuse.jpg', 'normal.jpg', 'arm.jpg', 'provenance.json']) assert.ok(existsSync(new URL(file, directory)), `${layer.id}/${file}`);
    const provenance = JSON.parse(readFileSync(new URL('provenance.json', directory), 'utf8')) as { assetId: string; license: string; sourceUrl: string; files: Record<string, { bytes: number }> };
    assert.equal(provenance.assetId, layer.id);
    assert.equal(provenance.license, 'CC0');
    assert.ok(provenance.sourceUrl.startsWith('https://polyhaven.com/a/'));
    for (const file of ['diffuse.jpg', 'normal.jpg', 'arm.jpg']) assert.equal(readFileSync(new URL(file, directory)).length, provenance.files[file]!.bytes, `${layer.id}/${file} matches its provenance size`);
  }
  assert.equal(MISTVEIL_BIOME.splat.layers.length, 5, 'texture memory stays at the canopy budget of five layers');
});

test('RegionEnvironment keeps Mistveil trial terrain aligned with its walk surfaces', { timeout: 120_000 }, () => {
  const environment = new RegionEnvironment(region, {} as unknown as EnvironmentRecipeDefinition);
  environment.ready.catch(() => undefined);
  try {
    environment.update(5, { x: -50, y: 0, z: -16 });
    assert.ok(Math.abs(environment.visualGroundHeightAt(-14, -16) - 1.2) <= 0.02);
    assert.ok(Math.abs(environment.visualGroundHeightAt(-44, -16)) <= 0.02);
    environment.setReducedEffects(true);
  } finally {
    environment.dispose();
  }
});
