import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { Vector3, type BufferGeometry } from 'three';
import { REGIONS as AUTHORED_REGIONS } from '../../src/content/campaign.js';
import { REGIONS as WORLD_REGIONS } from '../../src/content/world.js';
import type { EnvironmentRecipeDefinition, GroundSurfaceDefinition, RegionDefinition } from '../../src/game/contracts.js';
import { MOONPINE_BOUNDARY_ID_PREFIX, MOONPINE_COMBAT_TRIALS } from '../../src/game/combat/MoonpineContent.js';
import { createCombatTrialRegion } from '../../src/game/combat/TrialRegions.js';
import { biomeProfileFor } from '../../src/world/Biomes.js';
import { distanceToBoxFootprint, distanceToPolygon, outwardCameraDot, TREE_CAMERA_DOT } from '../../src/world/GreenwakeBoundary.js';
import { GREENWAKE_BIOME } from '../../src/world/GreenwakeBiome.js';
import { GroundClutter } from '../../src/world/GroundClutter.js';
import { bakeGroundMask, createMaskSample, sampleMask } from '../../src/world/GroundMask.js';
import { buildTerrainMeshData, TerrainField } from '../../src/world/GroundTerrain.js';
import { buildWaterData } from '../../src/world/GroundWater.js';
import { MOONPINE_BIOME } from '../../src/world/MoonpineBiome.js';
import { buildMoonpineBoundaryPlacements, MOONPINE_BOUNDARY_ASSET_IDS, MOONPINE_BOUNDARY_CLEARANCE, MOONPINE_BOUNDARY_ROCK_ID_PREFIX, moonpineFootprint } from '../../src/world/MoonpineBoundary.js';
import { GLINT_COUNT, MIST_COUNT, MoonpineAtmosphere, SNOW_COUNT, SPINDRIFT_COUNT } from '../../src/world/MoonpineAtmosphere.js';
import { buildIceGeometry, buildIcePixels, ICE_LAKE_RINGS, ICE_LAKE_Y, ICE_SHELF_Y, ICE_TEXTURE_SIZE, MoonpineIce } from '../../src/world/MoonpineIce.js';
import { gorgeIceLevel, LAKE, lakeDistance, lakeOutline, MOONPINE_LAKE_MATERIAL, MOONPINE_SHELF, onMoonpineIce } from '../../src/world/MoonpineTerrain.js';
import { RegionEnvironment } from '../../src/world/RegionEnvironment.js';
import { isBridgeDeckSurface, isFlatGroundSurface, isRaisedWalkSurface } from '../../src/world/WalkSurfaces.js';

const authored = (AUTHORED_REGIONS as RegionDefinition[]).find((candidate) => candidate.id === 'moonpine-ridge')!;
const region = createCombatTrialRegion(authored);
const field = new TerrainField(region, MOONPINE_BIOME);
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

test('Moonpine terrain reproduces every terrain-backed walk surface within 2 cm, flat and ramp, right up to the edges', () => {
  assert.equal(terrainBacked.length, 10);
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

test('ramps meet flat and top surfaces continuously (temple stair, temple descent)', () => {
  for (const [x, z, y] of [[23.98, -22, 0], [24.02, -22, 0.01], [35.98, -22, 4], [36.02, -22, 4], [47, -1.02, 4], [47, -0.98, 3.99], [47, 10.98, 0.01], [47, 11.02, 0]] as const) {
    assert.ok(Math.abs(field.sample(x, z) - y) <= 0.03, `terrain at (${x}, ${z}) = ${field.sample(x, z)}, expected ${y}`);
  }
});

test('the log bridge deck is not terrain-backed and the gorge lies >= 2.5 m below it under the mid-span', () => {
  assert.equal(decks.length, 1);
  const [deck] = decks;
  assert.equal(deck!.material, 'moonpine-bridge-deck');
  const xs = deck!.points.map((point) => point.x);
  const zs = deck!.points.map((point) => point.z);
  const mid = (Math.min(...xs) + Math.max(...xs)) / 2;
  const deckY = deck!.points[0]!.y;
  assert.equal(field.surfaceHeightAt(mid, (Math.min(...zs) + Math.max(...zs)) / 2), undefined);
  for (let x = mid - 3.5; x <= mid + 3.5; x += 0.25) {
    for (let z = Math.min(...zs); z <= Math.max(...zs); z += 0.25) assert.ok(deckY - field.sample(x, z) >= 2.5, `terrain ${field.sample(x, z)} under (${x.toFixed(2)}, ${z.toFixed(2)})`);
  }
  assert.ok(deckY - field.sample(mid, (Math.min(...zs) + Math.max(...zs)) / 2) >= 6, 'the bridge spans a real drop');
  // The gorge climbs out of the ground at its ends and the walkable rims on both sides keep their exact height.
  assert.ok(Math.abs(field.sample(-14.2, -22)) <= 0.7);
  assert.ok(Math.abs(field.sample(-3.8, -22)) <= 0.7);
  assert.ok(field.sample(-9, -64) > -1, 'gorge has climbed out of the ground to the north');
});

test('the temple massif and the mountains: a plateau around the terrace, steep faces, a mountain wall behind the route', () => {
  for (const [x, z] of [[47, -45], [39, -50], [56, -50]] as const) assert.ok(Math.abs(field.sample(x, z) - 4) <= 0.6, `plateau at (${x}, ${z}) = ${field.sample(x, z)}`);
  // Chain anchor bases stand on the plateau.
  for (const anchor of region.props.filter((prop) => prop.assetId === 'prop-temple-chain-anchor')) assert.ok(Math.abs(field.sample(anchor.position.x, anchor.position.z) - 4) <= 0.6, `${anchor.id} at ${field.sample(anchor.position.x, anchor.position.z)}`);
  // East face of the plateau drops towards the camera; the stair hillside rises along the ramp.
  assert.ok(field.sample(60, -30) - field.sample(68, -30) >= 2.5, 'east face');
  assert.ok(Math.abs(field.sample(30, -30) - 2) <= 0.6, 'stair hillside');
  // The mountain behind the route rises well above the valley floor, north and west.
  assert.ok(field.sample(20, -64) - field.sample(20, -40) >= 8, 'north mountain');
  assert.ok(field.sample(-88, -20) - field.sample(-72, -10) >= 4, 'west shoulder');
});

test('the frozen lake: a dish under the ice north of the shelf, shoreline off every walkable but the shelf, no open water', () => {
  assert.equal(biomeProfileFor(region)!.water.strips.length + biomeProfileFor(region)!.water.pools.length, 0);
  const water = buildWaterData(field, MOONPINE_BIOME.water);
  assert.equal(water.positions.length, 0);
  // The dish lies 1 m or more below the sheet in the middle of the lake and the shore meets ground level.
  assert.ok(field.sample(LAKE.x, LAKE.z) <= -1, `lake floor ${field.sample(LAKE.x, LAKE.z)}`);
  assert.ok(lakeDistance(LAKE.x, LAKE.z) < -8);
  assert.ok(lakeDistance(LAKE.x + LAKE.radiusX * 1.5, LAKE.z) > 3);
  // The shoreline stays clear of every walkable except the shelf (the lake overlaps the shelf's north side by design).
  const others = walkables.filter((surface) => surface.material !== MOONPINE_LAKE_MATERIAL).map((surface) => ({ points: surface.points.map((point) => ({ x: point.x, z: point.z })) }));
  for (const point of lakeOutline(180)) {
    for (const other of others) assert.ok(distanceToPolygon(other.points, point.x, point.z) >= 1.5, `shore (${point.x.toFixed(1)}, ${point.z.toFixed(1)}) is ${distanceToPolygon(other.points, point.x, point.z)} m from a walkable`);
  }
  // The shelf is walkable ice: the surface carries the lake material, and ground cover treats it as ice.
  const shelf = region.ground.surfaces.find((surface) => surface.material === MOONPINE_LAKE_MATERIAL)!;
  assert.deepEqual(shelf.points.map((point) => ({ x: point.x, z: point.z })), [...MOONPINE_SHELF]);
  assert.equal(onMoonpineIce(-46, -22), true);
  assert.equal(onMoonpineIce(-46, -40), true);
  assert.equal(onMoonpineIce(-66, -22), false);
  assert.equal(onMoonpineIce(-9, -22), false);
  // Gorge creek: frozen below the bridge.
  assert.ok(gorgeIceLevel(-22) < -6);
});

test('the ice sheet: one mesh over the lake and the shelf, facing up, flush with the shelf, at most 2 cm over the ground, with a tiling texture', () => {
  const shelves = walkables.filter((surface) => surface.material === MOONPINE_LAKE_MATERIAL).map((surface) => surface.points.map((point) => ({ x: point.x, z: point.z })));
  const geometry: BufferGeometry = buildIceGeometry(shelves);
  const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal'), index = geometry.getIndex()!;
  assert.ok(index.count > 0 && index.count % 3 === 0);
  for (let i = 0; i < normal.count; i++) assert.ok(normal.getY(i) > 0.99, `ice normal ${i} is ${normal.getY(i)}`);
  let low = Infinity, high = -Infinity;
  for (let i = 0; i < position.count; i++) { low = Math.min(low, position.getY(i)); high = Math.max(high, position.getY(i)); }
  assert.ok(Math.abs(low - ICE_LAKE_Y) < 1e-6);
  assert.ok(Math.abs(high - ICE_SHELF_Y) < 1e-6);
  assert.ok(high <= 0.02);
  // Every shelf point lies under the sheet at the shelf height, flush with the walkable floor within a centimetre.
  for (const point of MOONPINE_SHELF) assert.ok(Math.abs(ICE_SHELF_Y - field.sample(point.x, point.z)) <= 0.02);
  // Texture: 256 x 256 RGBA, opaque, tileable (opposite edges differ by no more than neighbouring texels do on average).
  const pixels = buildIcePixels();
  assert.equal(pixels.length, ICE_TEXTURE_SIZE * ICE_TEXTURE_SIZE * 4);
  let alphaMin = 255, wrapDifference = 0, innerDifference = 0;
  for (let row = 0; row < ICE_TEXTURE_SIZE; row++) {
    for (let channel = 0; channel < 3; channel++) {
      wrapDifference += Math.abs(pixels[(row * ICE_TEXTURE_SIZE) * 4 + channel]! - pixels[(row * ICE_TEXTURE_SIZE + ICE_TEXTURE_SIZE - 1) * 4 + channel]!);
      innerDifference += Math.abs(pixels[(row * ICE_TEXTURE_SIZE + 100) * 4 + channel]! - pixels[(row * ICE_TEXTURE_SIZE + 101) * 4 + channel]!);
    }
    for (let col = 0; col < ICE_TEXTURE_SIZE; col++) alphaMin = Math.min(alphaMin, pixels[(row * ICE_TEXTURE_SIZE + col) * 4 + 3]!);
  }
  assert.equal(alphaMin, 255);
  assert.ok(wrapDifference <= innerDifference * 3 + ICE_TEXTURE_SIZE * 3 * 4, `texture seam ${wrapDifference} vs ${innerDifference}`);
  // Lake ice, not floor tiles: dark deep-water vertex colours at the centre fading to frosted white at the rim, the shelf lighter than the lake.
  const color = geometry.getAttribute('color');
  const lum = (i: number): number => color.getX(i) + color.getY(i) + color.getZ(i);
  let centreIndex = -1, rimLum = 0, rimCount = 0;
  for (let i = 0; i < position.count; i++) {
    if (position.getY(i) === Math.fround(ICE_LAKE_Y) && Math.hypot(position.getX(i) - LAKE.x, position.getZ(i) - LAKE.z) < 1e-4) centreIndex = i;
    if (position.getY(i) === Math.fround(ICE_LAKE_Y) && lum(i) > 2.99) { rimLum += lum(i); rimCount++; }
  }
  assert.ok(centreIndex >= 0 && rimCount >= 72);
  assert.ok(lum(centreIndex) < rimLum / rimCount - 0.5, 'darker toward the centre');
  assert.ok(ICE_LAKE_RINGS[0]![1][0] < ICE_LAKE_RINGS[ICE_LAKE_RINGS.length - 1]![1][0]);
  // Crack networks are irregular: no repeating cell lattice, so the texture's autocorrelation has no strong peak at any shift of 1/12..1/3 on the crack detail.
  const size = ICE_TEXTURE_SIZE, raw = (c: number, r: number): number => pixels[(((r % size) + size) % size * size + ((c % size) + size) % size) * 4]!;
  // High-pass (pixel minus the mean of four neighbours 8 texels away): the crack detail, without the broad deep-water patches.
  const grey = (c: number, r: number): number => raw(c, r) - (raw(c - 8, r) + raw(c + 8, r) + raw(c, r - 8) + raw(c, r + 8)) / 4;
  let mean = 0;
  for (let r = 0; r < size; r += 2) for (let c = 0; c < size; c += 2) mean += grey(c, r);
  mean /= (size / 2) ** 2;
  const correlate = (dc: number, dr: number): number => {
    let sum = 0, norm = 0;
    for (let r = 0; r < size; r += 2) for (let c = 0; c < size; c += 2) { const a = grey(c, r) - mean, b = grey(c + dc, r + dr) - mean; sum += a * b; norm += a * a; }
    return sum / norm;
  };
  for (const shift of [Math.round(size / 12), Math.round(size / 7), Math.round(size / 5), Math.round(size / 3)]) for (const [dc, dr] of [[shift, 0], [0, shift], [shift, shift], [shift, -shift]] as const) assert.ok(correlate(dc, dr) < 0.35, `texture repeats at (${dc}, ${dr}): ${correlate(dc, dr)}`);
  // Blue-white ice: blue is the strongest channel on average.
  let r = 0, b = 0;
  for (let i = 0; i < pixels.length; i += 4) { r += pixels[i]!; b += pixels[i + 2]!; }
  assert.ok(b > r * 1.15);
});

test('water, ice and particles: static ice, snow from the world clock, reduced effects thin the snow and drop the glints, spindrift and shafts', () => {
  const sunDirection = new Vector3(-0.7, 0.62, 0.25).normalize();
  const ice = new MoonpineIce({ region, field, sunDirection });
  const atmosphere = new MoonpineAtmosphere({ region, field, sunDirection });
  try {
    assert.equal(ice.mesh.castShadow, false);
    assert.equal(ice.mesh.receiveShadow, true);
    assert.equal(ice.mesh.material.polygonOffset, true);
    ice.update();
    ice.setReducedEffects();
    atmosphere.update(3, { x: -60, y: 0, z: -22 });
    assert.equal(atmosphere.points.material.uniforms.uTime!.value, 3);
    assert.equal(atmosphere.points.material.transparent, true);
    assert.equal(atmosphere.points.material.depthWrite, false);
    assert.equal(atmosphere.points.geometry.getAttribute('aKind').count, SNOW_COUNT + SPINDRIFT_COUNT + GLINT_COUNT + MIST_COUNT);
    assert.ok(SNOW_COUNT > 0 && GLINT_COUNT > 0 && MIST_COUNT > 0 && SPINDRIFT_COUNT > 0);
    atmosphere.setReducedEffects(true);
    assert.equal(atmosphere.points.material.uniforms.uReduced!.value, 1);
    atmosphere.setReducedEffects(false);
    assert.equal(atmosphere.points.material.uniforms.uReduced!.value, 0);
  } finally {
    ice.dispose();
    atmosphere.dispose();
  }
});

test('boundary dressing: deterministic, decoration-only, >= 0.6 m from every walkable and bridge, off the ice and camera-friendly', () => {
  const obstacleRadius: Record<string, number> = { 'prop-moonpine-tree': 3, 'prop-buried-wolf-temple': 9, 'prop-snow-ridge-rock': 2.5, 'prop-temple-chain-anchor': 0.8 };
  const keepClear = {
    gates: MOONPINE_COMBAT_TRIALS.map((trial) => trial.gate),
    arenas: MOONPINE_COMBAT_TRIALS.map((trial) => trial.arena),
    obstacles: region.props.filter((prop) => !prop.id.startsWith(MOONPINE_BOUNDARY_ID_PREFIX) && obstacleRadius[prop.assetId] !== undefined).map((prop) => ({ x: prop.position.x, z: prop.position.z, radius: obstacleRadius[prop.assetId]! })),
  };
  const placements = buildMoonpineBoundaryPlacements(region, keepClear);
  assert.equal(JSON.stringify(buildMoonpineBoundaryPlacements(region, keepClear)), JSON.stringify(placements), 'deterministic');
  assert.ok(placements.length > 100, `${placements.length} placements`);
  assert.equal(new Set(placements.map((placement) => placement.id)).size, placements.length);
  const boundary = region.props.filter((prop) => prop.id.startsWith(MOONPINE_BOUNDARY_ID_PREFIX));
  assert.equal(boundary.length, placements.length, 'the region carries exactly this dressing');
  assert.deepEqual(new Set(placements.map((placement) => placement.assetId)), new Set(MOONPINE_BOUNDARY_ASSET_IDS));
  for (const placement of placements) if (placement.id.startsWith(MOONPINE_BOUNDARY_ROCK_ID_PREFIX)) assert.equal(placement.assetId, 'prop-snow-ridge-rock');
  const edgePolygons = polygons.filter((_, index) => !isBridgeDeckSurface(walkables[index]!));
  let trees = 0, rocks = 0;
  for (const placement of placements) {
    const circle = moonpineFootprint(placement.assetId, placement.position, placement.scale);
    assert.equal(placement.placement, 'ground');
    assert.ok(distanceToWalkable(circle.x, circle.z) - circle.radius >= 0.6, `${placement.id} is ${distanceToWalkable(circle.x, circle.z) - circle.radius} m from a walkable`);
    for (const gate of keepClear.gates) assert.ok(distanceToBoxFootprint(gate, circle.x, circle.z) >= circle.radius);
    assert.ok(lakeDistance(circle.x, circle.z) >= 0.4 + 0.5 * circle.radius - 1e-9, `${placement.id} stands on the ice`);
    if (placement.assetId === 'prop-moonpine-tree') { trees++; assert.ok(outwardCameraDot(edgePolygons, circle.x, circle.z) <= TREE_CAMERA_DOT, `${placement.id} on a camera-facing side`); } else rocks++;
  }
  assert.ok(trees >= 40 && rocks >= 20, `${trees} pines, ${rocks} rocks`);
});

test('mask textures, clutter and draw calls stay within Greenwake budgets', () => {
  const greenwake = (WORLD_REGIONS as RegionDefinition[]).find((candidate) => candidate.id === 'greenwake')!;
  const greenwakeField = new TerrainField(greenwake, GREENWAKE_BIOME);
  const mask = bakeGroundMask(region, field, MOONPINE_BIOME);
  const greenwakeMask = bakeGroundMask(greenwake, greenwakeField, GREENWAKE_BIOME);
  assert.ok(mask.shade.length + mask.detail.length + mask.terrain.length < greenwakeMask.shade.length + greenwakeMask.detail.length + greenwakeMask.terrain.length);
  const clutter = new GroundClutter(region, field, mask, { value: 0 }, MOONPINE_BIOME);
  const greenwakeClutter = new GroundClutter(greenwake, greenwakeField, greenwakeMask, { value: 0 }, GREENWAKE_BIOME);
  try {
    assert.ok(clutter.drawCalls <= greenwakeClutter.drawCalls, `${clutter.drawCalls} clutter draw calls`);
    assert.ok(clutter.triangleCount <= greenwakeClutter.triangleCount * 1.05, `${clutter.triangleCount} vs ${greenwakeClutter.triangleCount} clutter triangles`);
    assert.ok(MOONPINE_BIOME.splat.layers.length === 5);
    const scratch = createMaskSample();
    const names = new Set<string>();
    clutter.forEachInstance((name, x, z) => {
      names.add(name);
      assert.ok(sampleMask(mask, x, z, scratch).core <= 0.36, `${name} on the trail core at (${x.toFixed(1)}, ${z.toFixed(1)})`);
      assert.ok(scratch.bed <= 0.1 && scratch.deck <= 0.05, `${name} in the gorge bed or under the bridge`);
      assert.equal(onMoonpineIce(x, z), false, `${name} on the ice at (${x.toFixed(1)}, ${z.toFixed(1)})`);
    });
    for (const expected of ['pebble', 'twig', 'leaf-pile']) assert.ok(names.has(`ground-clutter-${expected}`), `${expected} missing`);
    // Nothing tropical: the green fern, fallen-log and root recipes are not part of the ridge.
    for (const banned of ['fern', 'jungle-fern', 'broadleaf', 'big-leaf', 'log', 'root', 'mushroom']) assert.ok(!names.has(`ground-clutter-${banned}`), `${banned} should not grow on the ridge`);
  } finally {
    clutter.dispose();
    greenwakeClutter.dispose();
  }
});

test('the ground paints rock on the cliffs, frozen mud and ice gravel in the gorge, and the trail only along the route', () => {
  const mask = bakeGroundMask(region, field, MOONPINE_BIOME);
  const s = createMaskSample();
  assert.ok(sampleMask(mask, -12.5, -30, s).rock >= 0.5, 'gorge wall');
  assert.ok(sampleMask(mask, -9, -22, s).bed >= 0.8, 'frozen creek bed under the bridge');
  assert.ok(sampleMask(mask, -9, -22, s).deck >= 0.9, 'bridge underside');
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
  // The hollow's far corner is a wide walkable area off the route: natural ground, no trail core.
  assert.ok(sampleMask(mask, 9, -29, s).core === 0 && s.interior >= 0.9 && s.walk <= 0.2);
});

test('the off-trail ground is snow: layers 0 and 1 are the two snow sets, graded bright, with needles for the trail core and cold grey rock for faces', () => {
  const [litter, moss, core, shoulder, cliff] = MOONPINE_BIOME.splat.layers;
  assert.deepEqual([litter!.id, moss!.id, core!.id, shoulder!.id, cliff!.id], ['snow_cover', 'ice_bed', 'pine_needles', 'rocky_trail', 'cold_rock']);
  // Mean sRGB of the Poly Haven diffuse maps (measured): final linear albedo = texture x tint must stay bright and blue-white for snow.
  const toLinear = (value: number): number => ((value / 255) <= 0.04045 ? value / 255 / 12.92 : (((value / 255) + 0.055) / 1.055) ** 2.4);
  for (const [layer, mean] of [[litter!, [165, 165, 167]], [moss!, [157, 155, 149]]] as const) {
    const albedo = mean.map((value, channel) => toLinear(value) * layer.tint[channel]!);
    assert.ok(Math.min(...albedo) > 0.55, `${layer.id} albedo ${albedo.join(', ')}`);
    assert.ok(albedo[2]! >= albedo[0]!, `${layer.id} is blue-white`);
  }
  // The needle trail stays distinguishable from the snow: much darker and warm.
  const needles = [106, 90, 68].map((value, channel) => toLinear(value) * core!.tint[channel]!);
  assert.ok(needles[0]! > needles[2]! && needles[0]! < 0.35);
  // Rock is graded blue-grey (blue is its strongest channel after the rock tint).
  const rock = [131, 105, 80].map((value, channel) => toLinear(value) * MOONPINE_BIOME.splat.rock.tint[channel]!);
  assert.ok(rock[2]! >= rock[0]! && rock[2]! >= rock[1]!);
  assert.equal(MOONPINE_BIOME.splat.rock.layer, 4);
});

test('textures: every Moonpine layer is a CC0 Poly Haven set with provenance next to its maps', () => {
  for (const layer of MOONPINE_BIOME.splat.layers) {
    const directory = new URL(`../../asset-source/textures/moonpine/${layer.id}/`, import.meta.url);
    for (const file of ['diffuse.jpg', 'normal.jpg', 'arm.jpg', 'provenance.json']) assert.ok(existsSync(new URL(file, directory)), `${layer.id}/${file}`);
    const provenance = JSON.parse(readFileSync(new URL('provenance.json', directory), 'utf8')) as { assetId: string; license: string; sourceUrl: string; resolution: string; physicalSizeMeters: number; files: Record<string, { bytes: number; sha256: string }> };
    assert.equal(provenance.assetId, layer.id);
    assert.equal(provenance.license, 'CC0');
    assert.ok(provenance.sourceUrl.startsWith('https://polyhaven.com/a/'));
    assert.equal(provenance.resolution, '1024x1024');
    assert.equal(provenance.physicalSizeMeters, layer.metersPerTile);
    for (const file of ['diffuse.jpg', 'normal.jpg', 'arm.jpg']) {
      assert.equal(readFileSync(new URL(file, directory)).length, provenance.files[file]!.bytes, `${layer.id}/${file} size`);
      assert.match(provenance.files[file]!.sha256, /^[0-9a-f]{64}$/);
    }
  }
});

test('RegionEnvironment keeps Moonpine trial terrain aligned with its walk surfaces and gorge', { timeout: 120_000 }, () => {
  const environment = new RegionEnvironment(region, {} as unknown as EnvironmentRecipeDefinition);
  environment.ready.catch(() => undefined);
  try {
    environment.update(5, { x: -60, y: 0, z: -22 });
    assert.ok(Math.abs(environment.visualGroundHeightAt(30, -22) - 2) <= 0.02);
    assert.ok(Math.abs(environment.visualGroundHeightAt(47, -22) - 4) <= 0.02);
    assert.ok(environment.visualGroundHeightAt(-9, -22) <= -5);
    environment.setReducedEffects(true);
  } finally {
    environment.dispose();
  }
});
