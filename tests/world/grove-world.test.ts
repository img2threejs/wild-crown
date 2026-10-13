import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import type { Mesh } from 'three';
import { REGIONS as AUTHORED_REGIONS } from '../../src/content/campaign.js';
import { REGIONS as WORLD_REGIONS } from '../../src/content/world.js';
import type { EnvironmentRecipeDefinition, GroundSurfaceDefinition, RegionDefinition } from '../../src/game/contracts.js';
import { GROVE_BOUNDARY_ID_PREFIX, GROVE_COMBAT_TRIALS } from '../../src/game/combat/GroveContent.js';
import { GROVE_SURFACE_PREFIX } from '../../src/game/combat/GroveTrialRegion.js';
import { createCombatTrialRegion } from '../../src/game/combat/TrialRegions.js';
import { biomeProfileFor, CANOPY_PLAYTEST_SURFACE_PREFIX } from '../../src/world/Biomes.js';
import { CANOPY_BIOME } from '../../src/world/CanopyBiome.js';
import { GREENWAKE_BIOME } from '../../src/world/GreenwakeBiome.js';
import { distanceToBoxFootprint, distanceToPolygon, outwardCameraDot, TREE_CAMERA_DOT } from '../../src/world/GreenwakeBoundary.js';
import { GroundClutter } from '../../src/world/GroundClutter.js';
import { bakeGroundMask, createMaskSample, sampleMask } from '../../src/world/GroundMask.js';
import { buildTerrainMeshData, TerrainField } from '../../src/world/GroundTerrain.js';
import { buildWaterData, GroundWater, WATER_RENDER_ORDER } from '../../src/world/GroundWater.js';
import { GroveAtmosphere, FIREFLY_COUNT, PETAL_COUNT, POLLEN_COUNT } from '../../src/world/GroveAtmosphere.js';
import { GROVE_BIOME } from '../../src/world/GroveBiome.js';
import {
  buildGroveBoundaryPlacements, GROVE_BOUNDARY_ASSET_IDS, GROVE_BOUNDARY_CLEARANCE, GROVE_BOUNDARY_ROCK_ID_PREFIX, GROVE_EXIT_CLEAR_RADIUS, groveFootprint,
} from '../../src/world/GroveBoundary.js';
import { channelReach, GROVE_CARVE, GROVE_POND, GROVE_WATER, POND_MEAN_RADIUS, waterMargin } from '../../src/world/GrovePond.js';
import { groveBackdrop, HEARTROOT_MOUND } from '../../src/world/GroveTerrain.js';
import { RegionEnvironment } from '../../src/world/RegionEnvironment.js';
import { isBridgeDeckSurface, isFlatGroundSurface } from '../../src/world/WalkSurfaces.js';

const authored = (AUTHORED_REGIONS as RegionDefinition[]).find((candidate) => candidate.id === 'the-grove')!;
const region = createCombatTrialRegion(authored);
const field = new TerrainField(region, GROVE_BIOME);
const walkables = region.ground.surfaces.filter((surface) => surface.walkable);
const polygons = walkables.map((surface) => ({ points: surface.points.map((point) => ({ x: point.x, z: point.z })) }));
const distanceToWalkable = (x: number, z: number): number => Math.min(...polygons.map((polygon) => distanceToPolygon(polygon.points, x, z)));
const exit = region.exits[0]!.from;

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

test('the grove playtest variant gets the grove biome; the authored region and other regions keep their look', () => {
  assert.equal(biomeProfileFor(region), GROVE_BIOME);
  assert.equal(biomeProfileFor(authored), undefined);
  assert.ok(region.ground.surfaces.every((surface) => surface.id.startsWith(GROVE_SURFACE_PREFIX)));
  assert.equal(biomeProfileFor((WORLD_REGIONS as RegionDefinition[]).find((candidate) => candidate.id === 'greenwake')!), GREENWAKE_BIOME);
  const canopy = createCombatTrialRegion((AUTHORED_REGIONS as RegionDefinition[]).find((candidate) => candidate.id === 'whispering-canopy')!);
  assert.ok(canopy.ground.surfaces.every((surface) => surface.id.startsWith(CANOPY_PLAYTEST_SURFACE_PREFIX)));
  assert.equal(biomeProfileFor(canopy), CANOPY_BIOME);
  assert.equal(GROVE_BIOME.id, 'the-grove');
});

test('grove terrain reproduces every walk surface within 2 cm, right up to the edges (all nine are flat y = 0 ground)', () => {
  assert.equal(walkables.length, 9);
  for (const surface of walkables) {
    assert.ok(isFlatGroundSurface(surface));
    assert.ok(!isBridgeDeckSurface(surface));
    const xs = surface.points.map((point) => point.x);
    const zs = surface.points.map((point) => point.z);
    let checked = 0;
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += 0.37) {
      for (let z = Math.min(...zs); z <= Math.max(...zs); z += 0.37) {
        if (!inside(surface, x, z)) continue;
        checked++;
        assert.ok(Math.abs(field.sample(x, z)) <= 0.02, `${surface.id} at (${x.toFixed(2)}, ${z.toFixed(2)}): ${field.sample(x, z)}`);
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
            if (inside(surface, x, z)) assert.ok(Math.abs(field.sample(x, z)) <= 0.02, `${surface.id} edge (${x.toFixed(3)}, ${z.toFixed(3)})`);
          }
        }
      }
    }
    assert.ok(checked > 20, `${surface.id} barely sampled`);
  }
});

test('the young Heartroot stands on a low smooth mound well clear of the walk-mesh; far meadow swells rise only behind the route', () => {
  const { x, z, radius, height } = HEARTROOT_MOUND;
  assert.equal(region.props.find((prop) => prop.id === 'grove-trial-heartroot')!.position.x, x);
  assert.equal(region.props.find((prop) => prop.id === 'grove-trial-heartroot')!.position.z, z);
  assert.ok(distanceToWalkable(x, z) >= radius + 2, `mound foot is ${distanceToWalkable(x, z) - radius} m from the walk-mesh`);
  assert.ok(Math.abs(groveBackdrop(x, z) - height) <= 0.05, 'the mound peaks under the trunk');
  assert.ok(field.sample(x, z) >= height * 0.5 && field.sample(x, z) <= height + 0.6, `terrain under the trunk is ${field.sample(x, z)}`);
  assert.equal(groveBackdrop(x + radius, z), 0);
  assert.ok(Math.abs(groveBackdrop(x + radius * 0.5, z) - height * 0.5) < height * 0.45);
  assert.ok(height <= 1, 'a low mound');
  // Relief stays gentle everywhere the camera can see: no step above 0.35 m between 1 m neighbours.
  let steepest = 0;
  for (let px = -50; px <= 44; px += 1) for (let pz = -70; pz <= 54; pz += 1) steepest = Math.max(steepest, Math.abs(field.sample(px + 1, pz) - field.sample(px, pz)), Math.abs(field.sample(px, pz + 1) - field.sample(px, pz)));
  assert.ok(steepest <= 0.9, `steepest 1 m step is ${steepest} m`);
  // The swells stand 10 m or more behind the route (west and north), never in front of it.
  for (const surface of walkables) for (const point of surface.points) assert.equal(groveBackdrop(point.x, point.z), 0, `relief on the walkable corner (${point.x}, ${point.z})`);
  for (const px of [-60, -56]) assert.ok(groveBackdrop(px, 0) > 1);
  assert.ok(groveBackdrop(0, -75) > 1.5);
  assert.equal(groveBackdrop(40, 56), 0);
  assert.equal(groveBackdrop(10, 50), 0);
});

test('the pond is a real carved pond: water level over a carved bed, outside the walk-mesh, with the whole water mesh off every walkable', () => {
  assert.equal(GROVE_WATER.pools.length, 1);
  assert.equal(GROVE_WATER.strips.length, 0);
  assert.ok(GROVE_CARVE.waterLevel(GROVE_POND.x, GROVE_POND.z) === GROVE_POND.waterY);
  assert.equal(GROVE_CARVE.waterLevel(GROVE_POND.x + 30, GROVE_POND.z), -Infinity);
  assert.ok(field.sample(GROVE_POND.x, GROVE_POND.z) <= GROVE_POND.waterY - 0.3, `pond bed ${field.sample(GROVE_POND.x, GROVE_POND.z)}`);
  assert.ok(waterMargin(GROVE_POND.x, GROVE_POND.z) < -POND_MEAN_RADIUS + 0.01);
  assert.ok(channelReach(GROVE_POND.x, GROVE_POND.z) < 0.01);
  const data = buildWaterData(field, GROVE_WATER);
  const vertexCount = data.positions.length / 3;
  assert.ok(vertexCount > 40);
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
  for (let angle = 0; angle < Math.PI * 2; angle += 0.1) {
    const edge = { x: GROVE_POND.x + Math.cos(angle) * GROVE_POND.radiusX * 1.12, z: GROVE_POND.z + Math.sin(angle) * GROVE_POND.radiusZ * 1.12 };
    assert.ok(distanceToWalkable(edge.x, edge.z) >= 2.5, `the pond reaches ${distanceToWalkable(edge.x, edge.z)} m from a walkable`);
  }
  // The pond lies beside the Heartroot: north of the glade, between the mound and the north trail.
  assert.ok(GROVE_POND.x > HEARTROOT_MOUND.x + 8 && GROVE_POND.x < exit.x - 6);
});

test('water and particles render without depth writes, in one draw call, from the world clock; reduced effects thin them', () => {
  const water = new GroundWater(field, GROVE_WATER);
  const atmosphere = new GroveAtmosphere({ region, field, sunDirection: water.mesh.position.clone().set(-0.8, 0.45, 0.2).normalize() });
  try {
    assert.equal(water.mesh.renderOrder, WATER_RENDER_ORDER);
    assert.equal(water.mesh.material.transparent, true);
    assert.equal(water.mesh.material.depthWrite, false);
    assert.equal(water.mesh.castShadow, false);
    water.update(3);
    atmosphere.update(3, { x: 8, y: 0, z: 10 });
    assert.equal(water.mesh.material.uniforms.uTime!.value, 3);
    assert.equal(atmosphere.points.material.uniforms.uTime!.value, 3);
    assert.equal(atmosphere.points.geometry.getAttribute('aKind').count, POLLEN_COUNT + FIREFLY_COUNT + PETAL_COUNT);
    assert.ok(POLLEN_COUNT > 0 && FIREFLY_COUNT > 0 && PETAL_COUNT > 0);
    assert.equal(atmosphere.points.material.depthWrite, false);
    const kinds = Array.from(atmosphere.data.particleKinds);
    assert.deepEqual([0, 1, 2].map((kind) => kinds.filter((value) => value === kind).length), [POLLEN_COUNT, FIREFLY_COUNT, PETAL_COUNT]);
    // Deterministic seeds: the same data every build.
    assert.deepEqual(Array.from(new GroveAtmosphere({ region, field, sunDirection: water.mesh.position.clone() }).data.particleSeeds), Array.from(atmosphere.data.particleSeeds));
    atmosphere.setReducedEffects(false);
    assert.equal(atmosphere.points.material.uniforms.uReduced!.value, 0);
    assert.equal(atmosphere.heartrootGlow.visible, true);
    atmosphere.setReducedEffects(true);
    assert.equal(atmosphere.points.material.uniforms.uReduced!.value, 1);
    assert.equal(atmosphere.heartrootGlow.visible, false);
    // The exit glow is a readability aid and stays on.
    assert.ok(atmosphere.exitGlow !== undefined);
    assert.ok(Math.abs(atmosphere.exitGlow.position.x - exit.x) < 1e-9 && Math.abs(atmosphere.exitGlow.position.z - exit.z) < 1e-9);
  } finally {
    water.dispose();
    atmosphere.dispose();
  }
});

test('boundary dressing: deterministic, decoration-only, >= 0.6 m from every walkable, off the water, camera-friendly, exactly the contract prop set', () => {
  const authoredProps = region.props.filter((prop) => !prop.id.startsWith(GROVE_BOUNDARY_ID_PREFIX));
  const footprints: Readonly<Record<string, number>> = { 'prop-heartroot-trunk': 3, 'prop-refuge-shelter': 2.6, 'prop-grove-platform': 3, 'prop-training-post': 0.8, 'prop-water-basin': 2.6 };
  const keepClear = {
    gates: GROVE_COMBAT_TRIALS.map((trial) => trial.gate),
    arenas: GROVE_COMBAT_TRIALS.map((trial) => trial.arena),
    obstacles: authoredProps.map((prop) => ({ x: prop.position.x, z: prop.position.z, radius: footprints[prop.assetId]! })),
  };
  const placements = buildGroveBoundaryPlacements(region, keepClear);
  assert.equal(JSON.stringify(buildGroveBoundaryPlacements(region, keepClear)), JSON.stringify(placements), 'deterministic');
  assert.ok(placements.length > 120, `${placements.length} placements`);
  assert.equal(new Set(placements.map((placement) => placement.id)).size, placements.length);
  assert.ok(placements.every((placement) => placement.id.startsWith(GROVE_BOUNDARY_ID_PREFIX)));
  const boundary = region.props.filter((prop) => prop.id.startsWith(GROVE_BOUNDARY_ID_PREFIX));
  assert.equal(boundary.length, placements.length, 'the region carries exactly this dressing');
  assert.deepEqual(new Set(placements.map((placement) => placement.assetId)), new Set(GROVE_BOUNDARY_ASSET_IDS));
  assert.deepEqual([...GROVE_BOUNDARY_ASSET_IDS].sort(), ['prop-canopy-fern-cluster', 'prop-erya-edge-tree', 'prop-greenwake-boulder-cluster']);
  assert.deepEqual([...new Set(region.props.map((prop) => prop.assetId))].sort(), [
    'prop-canopy-fern-cluster', 'prop-erya-edge-tree', 'prop-greenwake-boulder-cluster', 'prop-grove-platform', 'prop-heartroot-trunk', 'prop-refuge-shelter', 'prop-training-post', 'prop-water-basin',
  ]);
  assert.ok(placements.some((placement) => placement.id.startsWith(GROVE_BOUNDARY_ROCK_ID_PREFIX)));
  assert.equal(GROVE_BIOME.boundaryRocks?.idPrefix, GROVE_BOUNDARY_ROCK_ID_PREFIX);
  assert.equal(GROVE_BIOME.boundaryRocks?.assetId, 'prop-greenwake-boulder-cluster');
  for (const placement of placements) {
    const circle = groveFootprint(placement.assetId, placement.position, placement.scale);
    assert.equal(placement.placement, 'ground');
    assert.ok(distanceToWalkable(circle.x, circle.z) - circle.radius >= 0.6, `${placement.id} is ${distanceToWalkable(circle.x, circle.z) - circle.radius} m from a walkable`);
    for (const gate of keepClear.gates) assert.ok(distanceToBoxFootprint(gate, circle.x, circle.z) >= circle.radius);
    for (const arena of keepClear.arenas) assert.ok(Math.hypot(circle.x - arena.center.x, circle.z - arena.center.z) >= arena.radius + circle.radius);
    assert.ok(Math.hypot(circle.x - exit.x, circle.z - exit.z) >= GROVE_EXIT_CLEAR_RADIUS + circle.radius - 1e-9, `${placement.id} crowds the exit`);
    assert.ok(waterMargin(circle.x, circle.z) >= 0.4 + 0.5 * circle.radius - 1e-9, `${placement.id} stands in the water`);
    assert.ok(Math.hypot(circle.x - HEARTROOT_MOUND.x, circle.z - HEARTROOT_MOUND.z) >= HEARTROOT_MOUND.radius, `${placement.id} stands on the mound`);
    if (placement.assetId === 'prop-erya-edge-tree') assert.ok(outwardCameraDot(polygons, circle.x, circle.z) <= TREE_CAMERA_DOT, `${placement.id} on a camera-facing side`);
    if (placement.assetId === 'prop-canopy-fern-cluster') assert.ok(placement.scale.x <= 1.3 && placement.scale.y <= 1.7, 'ferns stay low');
    for (const prop of authoredProps) assert.ok(Math.hypot(circle.x - prop.position.x, circle.z - prop.position.z) >= 0.6 * (circle.radius + footprints[prop.assetId]!) - 1e-9, `${placement.id} overlaps ${prop.id}`);
  }
  // Dressing frames the pond's bank, the Heartroot's foot and the route; there are trees, boulders and ferns.
  const near = (cx: number, cz: number, range: number) => placements.filter((placement) => Math.hypot(placement.position.x - cx, placement.position.z - cz) < range).length;
  assert.ok(near(GROVE_POND.x, GROVE_POND.z, 11) >= 6, 'pond bank');
  assert.ok(near(HEARTROOT_MOUND.x, HEARTROOT_MOUND.z, 12) >= 6, 'Heartroot foot');
  for (const asset of GROVE_BOUNDARY_ASSET_IDS) assert.ok(placements.filter((placement) => placement.assetId === asset).length >= 8, `${asset} count`);
});

test('terrain mesh, mask textures, clutter and draw calls stay within Greenwake budgets', () => {
  const grove = buildTerrainMeshData(field);
  const greenwake = (WORLD_REGIONS as RegionDefinition[]).find((candidate) => candidate.id === 'greenwake')!;
  const greenwakeField = new TerrainField(greenwake, GREENWAKE_BIOME);
  const reference = buildTerrainMeshData(greenwakeField);
  assert.ok(grove.positions.length <= reference.positions.length, `${grove.positions.length / 3} vs ${reference.positions.length / 3} vertices`);
  assert.ok(grove.indices.length <= reference.indices.length, `${grove.indices.length / 3} vs ${reference.indices.length / 3} triangles`);
  const mask = bakeGroundMask(region, field, GROVE_BIOME);
  const greenwakeMask = bakeGroundMask(greenwake, greenwakeField, GREENWAKE_BIOME);
  assert.ok(mask.shade.length + mask.detail.length + mask.terrain.length < greenwakeMask.shade.length + greenwakeMask.detail.length + greenwakeMask.terrain.length);
  const clutter = new GroundClutter(region, field, mask, { value: 0 }, GROVE_BIOME);
  const greenwakeClutter = new GroundClutter(greenwake, greenwakeField, greenwakeMask, { value: 0 }, GREENWAKE_BIOME);
  try {
    assert.ok(clutter.drawCalls <= greenwakeClutter.drawCalls, `${clutter.drawCalls} clutter draw calls`);
    assert.ok(clutter.triangleCount <= greenwakeClutter.triangleCount * 1.05, `${clutter.triangleCount} vs ${greenwakeClutter.triangleCount} clutter triangles`);
    assert.ok(GROVE_BIOME.understory.grass.bladeHeight * GROVE_BIOME.understory.grass.heightScale > GREENWAKE_BIOME.understory.grass.bladeHeight * GREENWAKE_BIOME.understory.grass.heightScale);
    const scratch = createMaskSample();
    const names = new Set<string>();
    let blossoms = 0;
    clutter.forEachInstance((name, x, z) => {
      names.add(name);
      if (name === 'ground-clutter-broadleaf') blossoms++;
      assert.ok(sampleMask(mask, x, z, scratch).core <= 0.36, `${name} on the trail core at (${x.toFixed(1)}, ${z.toFixed(1)})`);
      assert.ok(scratch.bed <= 0.1 && scratch.deck <= 0.05, `${name} in the water`);
    });
    for (const expected of ['fern', 'broadleaf', 'leaf-pile', 'pebble']) assert.ok(names.has(`ground-clutter-${expected}`), `${expected} missing`);
    assert.ok(blossoms > 20, 'the flowering understory is present');
  } finally {
    clutter.dispose();
    greenwakeClutter.dispose();
  }
});

test('the ground paints the pond bed, the pale trail only along the route, and short sparse meadow cover across the glade', () => {
  const mask = bakeGroundMask(region, field, GROVE_BIOME);
  const s = createMaskSample();
  assert.ok(sampleMask(mask, GROVE_POND.x, GROVE_POND.z, s).bed >= 0.8, 'pond gravel bed');
  assert.ok(sampleMask(mask, GROVE_POND.x, GROVE_POND.z, s).deck === 0);
  for (const ribbon of region.navigation.ribbons) {
    for (let index = 1; index < ribbon.points.length; index++) {
      const a = ribbon.points[index - 1]!;
      const b = ribbon.points[index]!;
      const mx = (a.x + b.x) / 2;
      const mz = (a.z + b.z) / 2;
      assert.ok(sampleMask(mask, mx, mz, s).core >= 0.9, `trail core at (${mx.toFixed(1)}, ${mz.toFixed(1)})`);
    }
  }
  // A wide corner of the camp, far from every ribbon: natural ground, no trail core.
  assert.ok(sampleMask(mask, -31, 12, s).core === 0 && s.interior >= 0.9 && s.walk <= 0.2);
});

test('palette and light: warm late-afternoon meadow, golden-green layers, open fog, gentle terrain, no summits', () => {
  const { atmosphere, terrain, splat } = GROVE_BIOME;
  const channel = (color: number, shift: number) => (color >> shift) & 0xff;
  // Sun low and warm (red > green > blue); fog and sky golden-green; fog reaches farther than the canopy's jungle fog.
  assert.ok(channel(atmosphere.sunColor, 16) > channel(atmosphere.sunColor, 8) && channel(atmosphere.sunColor, 8) > channel(atmosphere.sunColor, 0));
  assert.ok(channel(atmosphere.fogColor, 8) >= channel(atmosphere.fogColor, 0) + 20 && channel(atmosphere.fogColor, 16) >= channel(atmosphere.fogColor, 0));
  assert.ok(atmosphere.fogFar > CANOPY_BIOME.atmosphere.fogFar && atmosphere.fogNear > CANOPY_BIOME.atmosphere.fogNear);
  assert.ok(atmosphere.sunOffset.y / Math.hypot(atmosphere.sunOffset.x, atmosphere.sunOffset.z) < 0.75, 'a low, late sun');
  assert.equal(atmosphere.shadowMapSize <= 1536, true);
  assert.equal(terrain.summits.length, 0);
  assert.ok(terrain.maxMound <= 0.6 && terrain.maxDip >= -0.3);
  assert.equal(GROVE_BIOME.features.length, 1);
  assert.equal(splat.layers.length, 5);
  assert.ok(splat.layers.every((layer) => layer.tint.every((value) => value > 0)));
  assert.equal(splat.rockOnOpenSlopes, false);
});

test('textures: the grove reuses the five CC0 Poly Haven canopy layers (no new texture memory), each with provenance next to its maps', () => {
  assert.equal(GROVE_BIOME.splat.textureRoot, CANOPY_BIOME.splat.textureRoot);
  assert.deepEqual(GROVE_BIOME.splat.layers.map((layer) => layer.id).sort(), CANOPY_BIOME.splat.layers.map((layer) => layer.id).sort());
  for (const layer of GROVE_BIOME.splat.layers) {
    const directory = new URL(`../../asset-source/textures/canopy/${layer.id}/`, import.meta.url);
    for (const file of ['diffuse.jpg', 'normal.jpg', 'arm.jpg', 'provenance.json']) assert.ok(existsSync(new URL(file, directory)), `${layer.id}/${file}`);
    const provenance = JSON.parse(readFileSync(new URL('provenance.json', directory), 'utf8')) as { assetId: string; license: string; sourceUrl: string };
    assert.equal(provenance.assetId, layer.id);
    assert.equal(provenance.license, 'CC0');
    assert.ok(provenance.sourceUrl.startsWith('https://polyhaven.com/a/'));
  }
});

test('RegionEnvironment builds the grove world for the playtest variant only: no slabs, pond water and particles; the authored region keeps its slabs', { timeout: 120_000 }, () => {
  const environment = new RegionEnvironment(region, {} as unknown as EnvironmentRecipeDefinition);
  environment.ready.catch(() => undefined);
  const plain = new RegionEnvironment(authored, {} as unknown as EnvironmentRecipeDefinition);
  try {
    const names: string[] = [];
    environment.group.traverse((node) => {
      if ((node as Mesh).isMesh || node.type === 'Points') names.push(node.name);
    });
    assert.equal(names.filter((name) => name.startsWith('surface:')).length, 0);
    for (const expected of ['the-grove-terrain', 'grove-water', 'grove-particles', 'grove-exit-glow', 'grove-heartroot-glow']) assert.ok(names.includes(expected), `${expected} missing`);
    environment.update(5, { x: 8, y: 0, z: 10 });
    assert.ok(Math.abs(environment.visualGroundHeightAt(8, 10)) <= 0.02);
    assert.ok(environment.visualGroundHeightAt(HEARTROOT_MOUND.x, HEARTROOT_MOUND.z) >= HEARTROOT_MOUND.height * 0.5, 'ground props follow the mound');
    environment.setReducedEffects(true);
    assert.equal(plain.profile, undefined);
    let plainSlabs = 0;
    plain.group.traverse((node) => {
      if (node.name.startsWith('surface:')) plainSlabs++;
    });
    assert.ok(plainSlabs > 0, 'the authored grove region keeps its generic slabs');
  } finally {
    environment.dispose();
    plain.dispose();
  }
});
