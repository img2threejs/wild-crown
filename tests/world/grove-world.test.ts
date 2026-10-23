import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { PerspectiveCamera, Vector3 } from 'three';
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
import { GroveAtmosphere, EMBER_COUNT, FIREFLY_COUNT, PETAL_COUNT, POLLEN_COUNT, SPORE_COUNT } from '../../src/world/GroveAtmosphere.js';
import {
  ARENA_CENTRE, ARENA_WALK_RADIUS, blightAt, blightGrade, HOLLOW_CENTRE, planBlight, sapMudAt, STONE_RING_RADIUS, stoneFootprints,
} from '../../src/world/GroveBlight.js';
import { buildDecalGeometry, buildDressingGeometry, buildWashGeometry, GroveBlightDressing } from '../../src/world/GroveBlightDressing.js';
import { GROVE_BIOME } from '../../src/world/GroveBiome.js';
import {
  buildGroveBoundaryPlacements, GROVE_BOUNDARY_ASSET_IDS, GROVE_BOUNDARY_CLEARANCE, GROVE_BOUNDARY_ROCK_ID_PREFIX, GROVE_EXIT_CLEAR_RADIUS, groveFootprint,
} from '../../src/world/GroveBoundary.js';
import { channelReach, GROVE_CARVE, GROVE_POND, GROVE_WATER, MEMORY_POOL, MEMORY_POOL_MEAN_RADIUS, POND_MEAN_RADIUS, waterMargin } from '../../src/world/GrovePond.js';
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

/**
 * One baked grove ground mask, shared by every case that reads it.
 *
 * `bakeGroundMask` is a pure function of (region, field, biome): it writes no state back into the region or the
 * terrain field, and two bakes of the same inputs are byte-identical (verified in the repair's evidence). Baking
 * it once here removes two redundant full-resolution bakes (each one rasterises a 448x808 weight grid plus a
 * 896x1616 detail grid) from the file's critical path.
 */
const groveMask = bakeGroundMask(region, field, GROVE_BIOME);

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
  assert.equal(biomeProfileFor(authored), GROVE_BIOME, 'the Act I hub shares the Trial layout and so its biome');
  assert.ok(region.ground.surfaces.every((surface) => surface.id.startsWith(GROVE_SURFACE_PREFIX)));
  assert.equal(biomeProfileFor((WORLD_REGIONS as RegionDefinition[]).find((candidate) => candidate.id === 'greenwake')!), GREENWAKE_BIOME);
  const canopy = createCombatTrialRegion((AUTHORED_REGIONS as RegionDefinition[]).find((candidate) => candidate.id === 'whispering-canopy')!);
  assert.ok(canopy.ground.surfaces.every((surface) => surface.id.startsWith(CANOPY_PLAYTEST_SURFACE_PREFIX)));
  assert.equal(biomeProfileFor(canopy), CANOPY_BIOME);
  assert.equal(GROVE_BIOME.id, 'the-grove');
});

test('grove terrain reproduces every walk surface within 2 cm, right up to the edges (all twelve are flat y = 0 ground)', () => {
  assert.equal(walkables.length, 12);
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
  for (const px of [-74, -70]) assert.ok(groveBackdrop(px, 0) > 1);
  assert.ok(groveBackdrop(0, -156) > 1.5);
  assert.equal(groveBackdrop(40, 56), 0);
  assert.equal(groveBackdrop(10, 50), 0);
});

test('both pools are real carved pools: water level over a carved bed, outside the walk-mesh, with the whole water mesh off every walkable', () => {
  assert.equal(GROVE_WATER.pools.length, 2);
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
  // The Memory Pool lies just north of the boss arena, close enough to stand behind the guardian in the camera, and off every walkable.
  assert.ok(GROVE_CARVE.waterLevel(MEMORY_POOL.x, MEMORY_POOL.z) === MEMORY_POOL.waterY);
  assert.ok(field.sample(MEMORY_POOL.x, MEMORY_POOL.z) <= MEMORY_POOL.waterY - 0.3, `Memory Pool bed ${field.sample(MEMORY_POOL.x, MEMORY_POOL.z)}`);
  assert.ok(waterMargin(MEMORY_POOL.x, MEMORY_POOL.z) < -MEMORY_POOL_MEAN_RADIUS + 0.01);
  const guardian = GROVE_COMBAT_TRIALS[2]!;
  assert.ok(MEMORY_POOL.z + MEMORY_POOL.radiusZ > guardian.arena.center.z - ARENA_WALK_RADIUS - 8, 'the pool lies within 8 m of the arena rim');
  assert.ok(MEMORY_POOL.z - guardian.monsterPosition.z > -20, 'the pool stands within 20 m behind the guardian');
  for (let angle = 0; angle < Math.PI * 2; angle += 0.1) {
    const edge = { x: MEMORY_POOL.x + Math.cos(angle) * MEMORY_POOL.radiusX * 1.12, z: MEMORY_POOL.z + Math.sin(angle) * MEMORY_POOL.radiusZ * 1.12 };
    assert.ok(distanceToWalkable(edge.x, edge.z) >= 0.8, `the Memory Pool reaches ${distanceToWalkable(edge.x, edge.z)} m from a walkable`);
  }
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
    assert.equal(atmosphere.points.geometry.getAttribute('aKind').count, POLLEN_COUNT + FIREFLY_COUNT + PETAL_COUNT + SPORE_COUNT + EMBER_COUNT);
    assert.ok(POLLEN_COUNT > 0 && FIREFLY_COUNT > 0 && PETAL_COUNT > 0 && SPORE_COUNT > 0 && EMBER_COUNT > 0);
    assert.equal(atmosphere.points.material.depthWrite, false);
    const kinds = Array.from(atmosphere.data.particleKinds);
    assert.deepEqual([0, 1, 2, 3, 4].map((kind) => kinds.filter((value) => value === kind).length), [POLLEN_COUNT, FIREFLY_COUNT, PETAL_COUNT, SPORE_COUNT, EMBER_COUNT]);
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

test('Grove ambient particles stay world-grounded through a jump and landing while their horizontal volume streams', () => {
  const atmosphere = new GroveAtmosphere({ region, field, sunDirection: new Vector3(-0.8, 0.45, 0.2) });
  try {
    atmosphere.update(7, { x: 8, y: 0, z: 10 });
    const groundedAnchor = (atmosphere.points.material.uniforms.uFocus!.value as Vector3).clone();
    for (const y of [0.6, 1.25, 0.6, 0, -2]) {
      atmosphere.update(7, { x: 8, y, z: 10 });
      assert.deepEqual(atmosphere.points.material.uniforms.uFocus!.value, groundedAnchor, 'jumping or falling must not lift the whole particle field');
    }
    atmosphere.update(8, { x: 16, y: 1.25, z: 20 });
    assert.deepEqual(atmosphere.points.material.uniforms.uFocus!.value, new Vector3(16, groundedAnchor.y, 20), 'horizontal streaming must remain independent of airborne altitude');
  } finally {
    atmosphere.dispose();
  }
});

test('boundary dressing: deterministic, decoration-only, >= 0.6 m from every walkable, off the water, camera-friendly, exactly the contract prop set', () => {
  const authoredProps = region.props.filter((prop) => !prop.id.startsWith(GROVE_BOUNDARY_ID_PREFIX));
  const footprints: Readonly<Record<string, number>> = {
    'prop-heartroot-trunk': 3, 'prop-refuge-shelter': 2.6, 'prop-grove-platform': 3, 'prop-training-post': 0.8, 'prop-water-basin': 2.6,
    'prop-ancient-canopy-shrine': 6.5, 'prop-root-cavern-mouth': 4.6, 'prop-canopy-cliff-rock': 2.2, 'prop-mire-bank-rock': 1.8,
  };
  const radiusOf = (prop: (typeof authoredProps)[number]): number => footprints[prop.assetId]! * Math.max(prop.scale.x, prop.scale.z);
  const keepClear = {
    gates: GROVE_COMBAT_TRIALS.map((trial) => trial.gate),
    arenas: GROVE_COMBAT_TRIALS.map((trial) => trial.arena),
    obstacles: [...authoredProps.map((prop) => ({ x: prop.position.x, z: prop.position.z, radius: radiusOf(prop) })), ...stoneFootprints()],
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
    'prop-ancient-canopy-shrine', 'prop-canopy-cliff-rock', 'prop-canopy-fern-cluster', 'prop-erya-edge-tree', 'prop-greenwake-boulder-cluster', 'prop-grove-platform',
    'prop-heartroot-trunk', 'prop-mire-bank-rock', 'prop-refuge-shelter', 'prop-root-cavern-mouth', 'prop-training-post', 'prop-water-basin',
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
    for (const prop of authoredProps) assert.ok(Math.hypot(circle.x - prop.position.x, circle.z - prop.position.z) >= 0.6 * (circle.radius + radiusOf(prop)) - 1e-9, `${placement.id} overlaps ${prop.id}`);
    for (const stone of stoneFootprints()) assert.ok(Math.hypot(circle.x - stone.x, circle.z - stone.z) >= 0.6 * (circle.radius + stone.radius) - 1e-9, `${placement.id} overlaps a ring stone`);
    // Inside the Black Sap the lush ferns and trees are withheld.
    if (placement.assetId === 'prop-canopy-fern-cluster') assert.ok(blightAt(circle.x, circle.z) <= 0.15, `${placement.id} is a lush fern in the blight`);
    if (placement.assetId === 'prop-erya-edge-tree') assert.ok(blightAt(circle.x, circle.z) <= 0.25, `${placement.id} is a lush tree in the blight`);
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
  const mask = groveMask;
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
  const mask = groveMask;
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
  assert.equal(GROVE_BIOME.features.length, 2);
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

test('RegionEnvironment keeps Grove walk surfaces and Heartroot mound aligned with visible terrain', { timeout: 120_000 }, () => {
  const environment = new RegionEnvironment(region, {} as unknown as EnvironmentRecipeDefinition);
  environment.ready.catch(() => undefined);
  try {
    environment.update(5, { x: 8, y: 0, z: 10 });
    assert.ok(Math.abs(environment.visualGroundHeightAt(8, 10)) <= 0.02);
    assert.ok(environment.visualGroundHeightAt(HEARTROOT_MOUND.x, HEARTROOT_MOUND.z) >= HEARTROOT_MOUND.height * 0.5, 'ground props follow the mound');
    environment.setReducedEffects(true);
  } finally {
    environment.dispose();
  }
});

test('the Black Sap field: none south of the first gate, dense in the hollow, thinner up the spur, total round the Memory Pool', () => {
  // Nothing of the practice ring, the glade, the camp or the trailhead is touched.
  for (const [x, z] of [[-24, -22], [-24, -30], [-30, -20], [10, 0], [8, 21], [10, 40], [26, 5], [-22, 3]] as const) assert.equal(blightAt(x, z), 0, `blight at (${x}, ${z})`);
  const mean = (cx: number, cz: number, radius: number): number => {
    let sum = 0, count = 0;
    for (let dx = -radius; dx <= radius; dx += 1) for (let dz = -radius; dz <= radius; dz += 1) { sum += blightAt(cx + dx, cz + dz); count++; }
    return sum / count;
  };
  const hollow = mean(HOLLOW_CENTRE.x, HOLLOW_CENTRE.z, 5), spur = mean(-24, -76, 3), arena = mean(ARENA_CENTRE.x, ARENA_CENTRE.z, 5), practice = mean(-24, -22, 6);
  assert.ok(hollow > 0.85, `hollow ${hollow}`);
  assert.ok(arena > 0.85, `arena ${arena}`);
  assert.ok(spur > 0.2 && spur < Math.min(hollow, arena), `spur ${spur}`);
  assert.equal(practice, 0);
  for (let index = 0; index < 400; index++) {
    const x = -60 + (index % 20) * 4.1, z = -140 + Math.floor(index / 20) * 5.3;
    const value = blightAt(x, z), mud = sapMudAt(x, z);
    assert.ok(value >= 0 && value <= 1 && mud >= 0 && mud <= 1);
    if (value === 0) assert.equal(mud, 0, 'no sap mud without blight');
  }
  // Ragged patches, not one smooth disc: the hollow's rim has both blighted and clean ground within a few metres.
  const rim = Array.from({ length: 40 }, (_, step) => blightAt(HOLLOW_CENTRE.x + 12 + step * 0.15, HOLLOW_CENTRE.z + step * 0.1));
  assert.ok(Math.max(...rim) - Math.min(...rim) > 0.3, 'the edge of the blight is ragged');
  // The sap-mud patches are real ground: the splat mask paints wet mud there and nowhere in the stage-1 clearing.
  const mask = groveMask;
  const s = createMaskSample();
  let soaked = 0;
  for (let x = ARENA_CENTRE.x - 12; x <= ARENA_CENTRE.x + 12; x += 1.5) for (let z = ARENA_CENTRE.z - 12; z <= ARENA_CENTRE.z + 12; z += 1.5) if (sampleMask(mask, x, z, s).mud > 0.5) soaked++;
  assert.ok(soaked > 20, `${soaked} soaked samples in the arena`);
  for (let x = -32; x <= -16; x += 2) for (let z = -30; z <= -14; z += 2) assert.equal(sampleMask(mask, x, z, s).mud, 0, `mud in the practice ring at (${x}, ${z})`);
  // The ground grade runs from ochre at the hollow to violet at the pool and the grass uses the same field.
  const ochre = blightGrade(HOLLOW_CENTRE.z), violet = blightGrade(ARENA_CENTRE.z);
  assert.ok(ochre[0] > ochre[2] + 0.2, 'ochre: red well above blue');
  assert.ok(violet[2] > violet[1] - 0.05 && violet[2] > ochre[2], 'violet: blue lifted towards the pool');
  assert.equal(GROVE_BIOME.understory.grass.blight!.amount, blightAt);
  assert.ok(GROVE_BIOME.understory.grass.blight!.shrink > 0.3);
});

test('the dead dressing: a ring of ancient stones round the arena, dead trees and shrubs only where the sap is, nothing on a route or an arena', () => {
  const props = region.props.filter((prop) => !prop.id.startsWith(GROVE_BOUNDARY_ID_PREFIX));
  const obstacles = region.props.map((prop) => ({ x: prop.position.x, z: prop.position.z, radius: 1.4 }));
  const plan = planBlight(field, obstacles);
  assert.equal(JSON.stringify(planBlight(field, obstacles)), JSON.stringify(plan), 'deterministic');
  assert.ok(plan.stones.length >= 14 && plan.roots.length >= 14 && plan.trees.length >= 8 && plan.shrubs.length >= 60, `${plan.stones.length} stones, ${plan.roots.length} roots, ${plan.trees.length} trees, ${plan.shrubs.length} shrubs`);
  assert.ok(plan.veins.length >= 15 && plan.puddles.length >= 10);
  for (const stone of plan.stones) {
    const radius = Math.hypot(stone.x - ARENA_CENTRE.x, stone.z - ARENA_CENTRE.z);
    assert.ok(Math.abs(radius - STONE_RING_RADIUS) <= 1.2, `a ring stone stands ${radius} m from the arena centre`);
    assert.ok(distanceToWalkable(stone.x, stone.z) >= 1.5, 'stones stand outside the walkable clearing');
    assert.ok(waterMargin(stone.x, stone.z) >= 3);
    // Tall behind the arena, knee-high on the camera's side so the Warden and the guardian stay visible.
    const outward = ((stone.x - ARENA_CENTRE.x) * 0.5812 + (stone.z - ARENA_CENTRE.z) * 0.8137) / radius;
    if (outward > 0.6) assert.ok(stone.height <= 1.7, `a camera-side stone is ${stone.height} m tall`);
    if (outward < -0.4 && stone.seed < 100) assert.ok(stone.height >= 1.6, 'the far stones stand tall');
    // The south entrance and the Ridge Trail stay open.
    const angle = Math.atan2(stone.z - ARENA_CENTRE.z, stone.x - ARENA_CENTRE.x);
    assert.ok(Math.abs(angle - Math.PI / 2) >= 0.3 && Math.abs(angle) >= 0.28, 'a stone blocks the entrance or the trail');
  }
  assert.ok(Math.max(...plan.stones.map((stone) => stone.height)) >= 3.4, 'tall standing stones behind the arena');
  for (const tree of plan.trees) {
    assert.ok(blightAt(tree.x, tree.z) >= 0.25 && distanceToWalkable(tree.x, tree.z) >= 2.7, 'a dead tree in the blight and off the walk-mesh');
    assert.ok(Math.hypot(tree.x - ARENA_CENTRE.x, tree.z - ARENA_CENTRE.z) > STONE_RING_RADIUS, 'dead trees stand behind the ring');
    assert.ok(tree.height >= 3.8 && tree.height <= 7.1);
  }
  for (const shrub of plan.shrubs) {
    assert.ok(blightAt(shrub.x, shrub.z) >= 0.3, 'a dead shrub only in the blight');
    assert.ok(Math.hypot(shrub.x - HOLLOW_CENTRE.x, shrub.z - HOLLOW_CENTRE.z) >= 9.4, 'no shrub in the hollow fight');
    assert.ok(Math.hypot(shrub.x - ARENA_CENTRE.x, shrub.z - ARENA_CENTRE.z) >= 12.2, 'no shrub in the arena fight');
    assert.ok(shrub.height <= 1.5);
    assert.ok(!(Math.abs(shrub.x + 24) < 3.6 && shrub.z < HOLLOW_CENTRE.z - 8 && shrub.z > ARENA_CENTRE.z + 11), 'no shrub on the spur route');
    for (const prop of props) assert.ok(Math.hypot(shrub.x - prop.position.x, shrub.z - prop.position.z) > 0.9, `shrub on ${prop.id}`);
  }
  // Nothing of it south of the first gate: the practice ring stays a sunlit meadow.
  for (const item of [...plan.trees, ...plan.shrubs, ...plan.roots, ...plan.stones]) assert.ok(item.z < -38, 'blight dressing south of the first gate');
  for (const vein of plan.veins) for (const [, z] of vein.points) assert.ok(z < -38);
});

test('the merged blight meshes: four draw calls, vertex-coloured, finite and bounded; reduced effects still the sap; dispose frees them', () => {
  const plan = planBlight(field, region.props.map((prop) => ({ x: prop.position.x, z: prop.position.z, radius: 1.4 })));
  const solids = buildDressingGeometry(plan, field);
  const triangles = solids.index!.count / 3;
  assert.ok(triangles > 8000 && triangles < 60000, `${triangles} solid triangles`);
  for (const attribute of ['position', 'color', 'normal']) assert.ok(Array.from(solids.getAttribute(attribute).array).every(Number.isFinite), `${attribute} is finite`);
  solids.computeBoundingBox();
  assert.ok(solids.boundingBox!.min.y > -1 && solids.boundingBox!.max.y < 9, `solid heights ${solids.boundingBox!.min.y}..${solids.boundingBox!.max.y}`);
  assert.ok(solids.boundingBox!.max.z < -36, 'no solid south of the first gate');
  const decals = buildDecalGeometry(plan, field);
  assert.ok(decals.index!.count / 3 > 300 && decals.getAttribute('aInfo').count === decals.getAttribute('position').count);
  assert.ok(Array.from(decals.getAttribute('aInfo').array).every(Number.isFinite));
  const wash = buildWashGeometry(field);
  const grades = wash.getAttribute('aGrade'), washPositions = wash.getAttribute('position');
  let strong = 0;
  for (let index = 0; index < grades.count; index++) {
    const alpha = grades.getW(index);
    if (alpha > 0.8) strong++;
    if (washPositions.getZ(index) > -34) assert.fail('the wash reaches the practice ring');
    if (blightAt(washPositions.getX(index), washPositions.getZ(index)) === 0) assert.equal(alpha, 0);
  }
  assert.ok(strong > 100, `${strong} strongly graded wash vertices`);

  const water = new GroundWater(field, GROVE_WATER);
  const feature = new GroveBlightDressing({ region, field, sunDirection: water.mesh.position.clone().set(-0.8, 0.45, 0.2).normalize() });
  try {
    assert.deepEqual(feature.group.children.map((child) => child.name), ['grove-blight-solids', 'grove-blight-wash', 'grove-sap-decals', 'grove-memory-pool-surface']);
    assert.equal(feature.group.children.length, 4, 'four draw calls');
    assert.equal(feature.wash.material.blending, 5, 'the wash multiplies (custom blending)');
    assert.equal(feature.wash.material.depthWrite, false);
    assert.equal(feature.decals.material.depthWrite, false);
    assert.equal(feature.poolSurface.material.depthWrite, false);
    assert.ok(feature.solids.material.vertexColors && feature.solids.castShadow && feature.solids.receiveShadow);
    assert.ok(Math.abs(feature.poolSurface.position.x - MEMORY_POOL.x) < 1e-9 && Math.abs(feature.poolSurface.position.z - MEMORY_POOL.z) < 1e-9);
    assert.ok(feature.poolSurface.position.y > MEMORY_POOL.waterY, 'the corrupted surface lies just over the water');
    feature.update(7);
    assert.equal(feature.decals.material.uniforms.uTime!.value, 7);
    assert.equal(feature.poolSurface.material.uniforms.uTime!.value, 7);
    feature.setReducedEffects(true);
    assert.equal(feature.decals.material.uniforms.uMotion!.value, 0);
    assert.equal(feature.poolSurface.material.uniforms.uMotion!.value, 0);
    assert.ok(feature.group.children.every((child) => child.visible), 'reduced effects keep every shape and colour');
    feature.setReducedEffects(false);
    assert.equal(feature.poolSurface.material.uniforms.uMotion!.value, 1);
  } finally {
    feature.dispose();
    water.dispose();
  }
  assert.equal(feature.group.parent, null);
});

test('framing: from the gameplay camera the Memory Pool and the ring of stones stand behind the guardian while the player is in the arena', () => {
  const guardian = GROVE_COMBAT_TRIALS[2]!;
  const camera = new PerspectiveCamera(34, 1.6, 0.1, 100);
  const project = (x: number, y: number, z: number, from: { x: number; z: number }): Vector3 => {
    camera.position.set(from.x + 10, 12, from.z + 14);
    camera.lookAt(from.x, 0, from.z);
    camera.updateMatrixWorld(true);
    return new Vector3(x, y, z).project(camera);
  };
  // The player stands between the guardian and the entrance, 6 to 8 m south of it, as the fight keeps him.
  for (const standoff of [5, 7.5]) {
    const player = { x: guardian.monsterPosition.x, z: guardian.monsterPosition.z + standoff };
    const boss = project(guardian.monsterPosition.x, 1.5, guardian.monsterPosition.z, player);
    const pool = project(MEMORY_POOL.x, MEMORY_POOL.waterY, MEMORY_POOL.z, player);
    assert.ok(Math.abs(boss.x) < 0.5 && Math.abs(boss.y) < 0.85, `the guardian is framed at ${boss.x}, ${boss.y}`);
    assert.ok(Math.abs(pool.x) < 1 && Math.abs(pool.y) < 1, `the pool centre is framed (${pool.x}, ${pool.y}) at ${standoff} m`);
    assert.ok(pool.y > boss.y, 'the pool stands behind (above, on screen) the guardian');
    const nearEdge = project(MEMORY_POOL.x, MEMORY_POOL.waterY, MEMORY_POOL.z + MEMORY_POOL.radiusZ, player);
    assert.ok(nearEdge.y < pool.y && nearEdge.y > boss.y, 'the pool\'s near edge is between the guardian and the pool centre');
  }
});
