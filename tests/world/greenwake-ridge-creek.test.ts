import assert from 'node:assert/strict';
import test from 'node:test';
import type { Mesh, ShaderMaterial } from 'three';
import { REGIONS } from '../../src/content/world.js';
import type { EnvironmentRecipeDefinition, GroundSurfaceDefinition, RegionDefinition } from '../../src/game/contracts.js';
import { GREENWAKE_BOUNDARY_ID_PREFIX, GREENWAKE_BOUNDARY_ROCK_ID_PREFIX, buildGreenwakeBoundaryPlacements, distanceToWalkMesh, greenwakeFootprint } from '../../src/world/GreenwakeBoundary.js';
import { GREENWAKE_BIOME } from '../../src/world/GreenwakeBiome.js';
import { CREEK_WATER_DEPTH, CREEK_WATER_Y, CREEK_Z_END, CREEK_Z_START, creekSection, creekSurfaceHeight, creekWaterLevel, gullyMembership } from '../../src/world/GreenwakeCreekShape.js';
import { GroundClutter } from '../../src/world/GroundClutter.js';
import { GroundGrass } from '../../src/world/GroundGrass.js';
import { bakeGroundMask, createMaskSample, groundTrailSegments, MASK_TEXEL, sampleMask } from '../../src/world/GroundMask.js';
import { buildTerrainMeshData, TerrainField } from '../../src/world/GroundTerrain.js';
import { buildWaterData, GroundWater, WATER_RENDER_ORDER } from '../../src/world/GroundWater.js';
import { RegionEnvironment } from '../../src/world/RegionEnvironment.js';
import { isBridgeDeckSurface, isFlatGroundSurface, isRaisedWalkSurface } from '../../src/world/WalkSurfaces.js';

const region = REGIONS.find((candidate): candidate is RegionDefinition => candidate.id === 'greenwake')!;
const field = new TerrainField(region, GREENWAKE_BIOME);
const mask = bakeGroundMask(region, field, GREENWAKE_BIOME);
const walkables = region.ground.surfaces.filter((surface) => surface.walkable);
const deck = region.ground.surfaces.find((surface) => isBridgeDeckSurface(surface))!;
const terrainBacked = walkables.filter((surface) => surface !== deck);
const flatSurfaces = region.ground.surfaces.filter(isFlatGroundSurface);
const raisedSurfaces = region.ground.surfaces.filter((surface) => isRaisedWalkSurface(surface) && !isBridgeDeckSurface(surface));

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

function distanceToSurface(surface: GroundSurfaceDefinition, x: number, z: number): number {
  if (inside(surface, x, z)) return 0;
  let best = Infinity;
  const points = surface.points;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j]!;
    const b = points[i]!;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(x - a.x - dx * t, z - a.z - dz * t));
  }
  return best;
}

const deckBox = { minX: 13.5, maxX: 17, minZ: 17, maxZ: 20 };

/** True inside the creek strip's reach (the only place water can stand). */
function inCreek(x: number, z: number): boolean {
  const section = creekSection(z);
  return z >= CREEK_Z_START && z <= CREEK_Z_END && Math.abs(x - section.centerX) <= section.bedHalfWidth + 0.9;
}

test('the rope-bridge deck is not terrain-backed: the creek gully runs beneath it, well below the planks', () => {
  assert.equal(deck.id, 'greenwake-gully-bridge');
  assert.equal(deck.material, 'greenwake-bridge-deck');
  assert.equal(field.surfaceHeightAt(15.25, 18.5), undefined, 'no walkable owns the ground under the deck');
  const midpoint = field.sample(15.25, 18.5);
  assert.ok(midpoint <= -0.9 && midpoint >= -1.45, `terrain under the bridge midpoint ${midpoint}`);
  let checked = 0;
  let highest = -Infinity;
  for (let x = deckBox.minX + 0.45; x <= deckBox.maxX - 0.45 + 1e-9; x += 0.05) {
    for (let z = deckBox.minZ + 0.02; z <= deckBox.maxZ - 0.02; z += 0.1) {
      checked++;
      highest = Math.max(highest, field.sample(x, z));
      assert.ok(2 - field.sample(x, z) >= 0.3, `terrain ${field.sample(x, z)} is within 0.3 m of the deck at (${x.toFixed(2)}, ${z.toFixed(2)})`);
    }
  }
  assert.ok(checked > 1_000);
  // Just past the ridge and gateway edges the terrain falls away at once: the rolled crest holds the walkable height for 0.36 m and
  // rounds over the next few tenths, so the 0.3 m gap under the planks is measured from there.
  assert.ok(highest <= 1.8 + 1e-6, `highest ${highest}`);
  for (const x of [14.5, 15, 15.25, 15.5, 16]) assert.ok(field.sample(x, 18.5) <= 0.6, `bank at x=${x}: ${field.sample(x, 18.5)}`);
});

test('the gully never lowers terrain inside a walkable footprint and leaves the boar thicket untouched', () => {
  const thicket = region.ground.surfaces.find((surface) => surface.id === 'greenwake-boar-thicket')!;
  // Every probe inside a terrain-backed footprint inside the creek's reach still equals the walkable's own height (0 or its plane).
  let probes = 0;
  for (let x = 8; x <= 24; x += 0.07) {
    for (let z = 4; z <= 36; z += 0.07) {
      const owner = field.surfaceHeightAt(x, z);
      if (owner === undefined) continue;
      probes++;
      assert.ok(Math.abs(field.heightAt(x, z) - owner) <= 1e-6, `terrain ${field.heightAt(x, z)} differs from walk surface ${owner} at (${x.toFixed(2)}, ${z.toFixed(2)})`);
    }
  }
  assert.ok(probes > 20_000);
  // Every walkable edge inside the creek band keeps its height exactly (the carve fades to nothing at the footprint).
  for (const surface of terrainBacked) {
    for (const point of surface.points) {
      if (point.x > 8 && point.x < 24 && point.z > 9 && point.z < 34) assert.ok(Math.abs(field.heightAt(point.x, point.z) - point.y) <= 1e-6, `${surface.id} vertex (${point.x}, ${point.z})`);
    }
  }
  for (let x = 12; x <= 18; x += 0.25) for (let z = 5; z <= 9; z += 0.25) {
    if (inside(thicket, x, z)) assert.ok(Math.abs(field.sample(x, z)) <= 0.02 || x < 13.25, `thicket at (${x}, ${z}) = ${field.sample(x, z)}`);
  }
  // The gully starts north of the thicket and the carve never reaches it.
  for (let z = 4; z <= 9.5; z += 0.25) assert.ok(creekSurfaceHeight(15.25, z) > 3, `creek carves at z=${z}`);
  assert.equal(gullyMembership(15.25, 9), 0);
});

test('the creek gully separates the ridge from the gateway: centreline near x = 15.25, bed about −1.3 m, banks that fade into the forest', () => {
  for (const z of [15, 17, 18.5, 20, 22]) {
    const section = creekSection(z);
    assert.ok(Math.abs(section.centerX - 15.25) <= 0.1, `centreline at z=${z}: ${section.centerX}`);
    assert.ok(field.sample(section.centerX, z) <= -1.2 && field.sample(section.centerX, z) >= -1.45, `bed at z=${z}: ${field.sample(section.centerX, z)}`);
  }
  // A gentle meander: the centreline is not a straight line, and stays between the head and the grove.
  const centres = Array.from({ length: 24 }, (_, index) => creekSection(10 + index).centerX);
  assert.ok(Math.max(...centres) - Math.min(...centres) >= 0.8 && Math.min(...centres) >= 13.5 && Math.max(...centres) <= 16.5);
  // Head near z ≈ 10 and fade at z ≈ 30: both ends run out into ordinary ground (relief within −0.3 … 1.2 m).
  for (const z of [10, 10.5, 31, 33, 36]) {
    const section = creekSection(z);
    for (let offset = -2; offset <= 2; offset += 0.5) assert.ok(field.sample(section.centerX + offset, z) >= -0.45, `creek end at z=${z}, offset ${offset}: ${field.sample(section.centerX + offset, z)}`);
  }
  // Steep, but earth and rock rather than a sheer drop at the walkable edges: the whole mesh stays under a 4.5 rise/run.
  let steepest = 0;
  const step = 0.125;
  for (let x = 0; x < 32; x += step) {
    for (let z = 0; z < 38; z += step) {
      steepest = Math.max(steepest, Math.hypot((field.sample(x + step, z) - field.sample(x, z)) / step, (field.sample(x, z + step) - field.sample(x, z)) / step));
    }
  }
  // The crest rolls over (zero slope at the rim) and the face below it is steeper to make up for it, but still earth and rock.
  assert.ok(steepest <= 5, `steepest face ${steepest}`);
});

test('embankments fall away from the ridge and ramps as earth-and-rock faces, never a vertical wall', () => {
  // Faces sampled away from flat walkables (ownership curbs) and from the creek reach.
  const faces: number[] = [];
  const step = 0.25;
  for (let x = 0; x < 30; x += step) {
    for (let z = 0; z < 36; z += step) {
      if (x > 11 && x < 19.5 && z > 8 && z < 34) continue;
      if (field.surfaceHeightAt(x, z) !== undefined || field.raisedDistance(x, z, 6) < 0.45 || field.raisedDistance(x, z, 6) >= 6) continue;
      if (flatSurfaces.some((surface) => distanceToSurface(surface, x, z) < 0.8)) continue;
      faces.push(Math.hypot((field.sample(x + step, z) - field.sample(x, z)) / step, (field.sample(x, z + step) - field.sample(x, z)) / step));
    }
  }
  faces.sort((a, b) => a - b);
  assert.ok(faces.length > 1_000, `${faces.length} embankment probes`);
  const p99 = faces[Math.floor(faces.length * 0.99)]!;
  assert.ok(p99 <= 1.9 && faces[faces.length - 1]! <= 2.6, `embankment slope p99 ${p99}, max ${faces[faces.length - 1]}`);
  assert.ok(faces.filter((slope) => slope >= 1).length >= 80, 'faces must actually be steep in places');
  // The ridge top (2 m) falls to the surrounding relief across the shoulder, noise-varied along the edge.
  const dropAt = (z: number): number => field.sample(2, z) - field.sample(0, z);
  assert.ok(dropAt(16) > 0.5 && Math.abs(dropAt(16) - dropAt(19)) > 0.01, 'the west face varies along the ridge edge');
  // Shoulder: the edge height holds for 0.36 m beyond the footprint.
  for (const [x, z] of [[1.7, 16], [1.7, 18], [7, 20.3], [11, 20.3]]) assert.ok(field.sample(x, z) >= 1.9, `shoulder at (${x}, ${z}) = ${field.sample(x, z)}`);
});

test('terrain mesh size and refinement stay bounded', () => {
  const data = buildTerrainMeshData(field);
  const vertices = data.positions.length / 3;
  const triangles = data.indices.length / 3;
  assert.ok(vertices <= 75_000 && triangles <= 140_000, `${vertices} vertices, ${triangles} triangles`);
  assert.ok(field.refinedCells > 1_400 && field.refinedCells < 2_400, `${field.refinedCells} refined cells`);
});

test('creek water is one transparent strip confined to the gully', () => {
  const strip = buildWaterData(field, GREENWAKE_BIOME.water);
  const vertexCount = strip.positions.length / 3;
  assert.ok(vertexCount > 300 && vertexCount < 1_500, `${vertexCount} water vertices`);
  assert.equal(strip.indices.length % 3, 0);
  for (const index of strip.indices) assert.ok(index < vertexCount);
  for (let index = 0; index < vertexCount; index++) {
    const x = strip.positions[index * 3]!;
    const y = strip.positions[index * 3 + 1]!;
    const z = strip.positions[index * 3 + 2]!;
    const section = creekSection(z);
    assert.ok(z >= CREEK_Z_START - 1e-6 && z <= CREEK_Z_END + 1e-6, `water vertex at z=${z}`);
    assert.ok(Math.abs(x - section.centerX) <= section.bedHalfWidth + 0.9 + 1e-4, `water vertex ${x} is ${Math.abs(x - section.centerX)} m from the centreline at z=${z}`);
    assert.ok(Math.abs(y - creekWaterLevel(z)) <= 1e-5, 'the strip lies a fixed depth over the bed (clamped below the ground at the ends)');
    assert.ok(y <= -0.4 + 1e-6, `water at y=${y}`);
    for (const surface of terrainBacked) assert.ok(!inside(surface, x, z), `water vertex (${x.toFixed(2)}, ${z.toFixed(2)}) lies inside ${surface.id}`);
    // Fades to nothing at both ends.
    if (z <= CREEK_Z_START + 1e-6 || z >= CREEK_Z_END - 1e-6) assert.equal(strip.flow[index * 2 + 1], 0);
  }
  // Over the bridge reach the strip sits at about −1.1 m, as authored.
  const underDeck = creekSection(18.5);
  assert.ok(Math.abs(underDeck.bed + CREEK_WATER_DEPTH - CREEK_WATER_Y) <= 1e-9 && Math.abs(CREEK_WATER_Y + 1.1) <= 1e-9);
  // Water is only ever visible in the gully: wherever the terrain is below the local water surface, the point is in the strip's reach.
  let wet = 0;
  for (let x = 6; x <= 26; x += 0.1) {
    for (let z = 6; z <= 40; z += 0.1) {
      const section = creekSection(z);
      if (field.sample(x, z) >= creekWaterLevel(z) - 0.005) continue;
      wet++;
      assert.ok(z >= CREEK_Z_START - 1 && z <= CREEK_Z_END + 1 && Math.abs(x - section.centerX) <= section.bedHalfWidth + 0.9, `submerged ground outside the strip at (${x.toFixed(1)}, ${z.toFixed(1)})`);
    }
  }
  assert.ok(wet > 100, `${wet} submerged probes`);
});

test('the creek renders in one transparent, shadowless draw call and animates from the world clock', () => {
  const creek = new GroundWater(field, GREENWAKE_BIOME.water);
  try {
    assert.equal(creek.mesh.geometry.getIndex()!.count, creek.data.indices.length);
    assert.equal(creek.mesh.material.transparent, true);
    assert.equal(creek.mesh.material.depthWrite, false);
    assert.equal(creek.mesh.material.fog, true);
    assert.equal(creek.mesh.castShadow, false);
    assert.equal(creek.mesh.receiveShadow, false);
    assert.equal(creek.mesh.children.length, 0);
    assert.equal(creek.mesh.renderOrder, WATER_RENDER_ORDER);
    assert.ok(WATER_RENDER_ORDER < 0, 'water is drawn before the (depthWrite = false) transparent prop batches');
    creek.update(12.5);
    assert.equal(creek.mesh.material.uniforms.uTime!.value, 12.5);
  } finally {
    creek.dispose();
  }
});

test('trail paints the ramp, ridge top and gateway like the y = 0 trails, never under the bridge; the gully gets bed gravel, mud and rock', () => {
  const segments = groundTrailSegments(region);
  // Corners are rounded by a spline now, so the trail ends near (not exactly on) the authored ribbon vertex before the bridge.
  assert.ok(segments.some((s) => Math.hypot(s.bx - 12.8, s.bz - 18.5) < 2.2), 'ridge-top trail up to the bridge');
  assert.ok(segments.some((s) => Math.hypot(s.ax - 17, s.az - 18) < 2.2), 'gateway trail from the bridge');
  assert.ok(segments.some((s) => Math.hypot(s.ax - 9.5, s.az - 10) < 2.2 || Math.hypot(s.bx - 9.5, s.bz - 10) < 2.2), 'ramp trail');
  for (const s of segments) assert.ok(!inside(deck, (s.ax + s.bx) / 2, (s.az + s.bz) / 2), 'no trail segment lies on the bridge deck');
  const scratch = createMaskSample();
  // The ramp, the ridge top and the gateway carry the same trail core and shoulder as the flat routes.
  for (const [x, z] of [[9.5, 8], [9.6, 12], [10, 16], [11.4, 17.75], [18, 18.3], [19.5, 19.2]]) {
    assert.ok(sampleMask(mask, x, z, scratch).core >= 0.8, `trail core at (${x}, ${z}) = ${scratch.core}`);
  }
  assert.ok(sampleMask(mask, 8.2, 8, scratch).shoulder + sampleMask(mask, 11.2, 8, scratch).shoulder > 0.3, 'gravel shoulder along the ramp trail');
  // Under the bridge: bare, no trail, no cover.
  for (let x = deckBox.minX + 0.3; x < deckBox.maxX - 0.3; x += 0.5) {
    for (let z = deckBox.minZ + 0.3; z < deckBox.maxZ - 0.3; z += 0.5) {
      sampleMask(mask, x, z, scratch);
      assert.ok(scratch.core === 0 && scratch.shoulder === 0 && scratch.deck > 0.9, `under the bridge at (${x}, ${z}): core ${scratch.core}, deck ${scratch.deck}`);
    }
  }
  // Creek bed gravel, wet mud on the lower banks, rock on the steep upper banks and embankment faces.
  assert.ok(sampleMask(mask, 15.25, 15, scratch).bed >= 0.9);
  assert.ok(sampleMask(mask, 14.25, 15, scratch).mud >= 0.5 && sampleMask(mask, 16.25, 15, scratch).mud >= 0.5, 'wet banks');
  assert.ok(sampleMask(mask, 13.8, 18.5, scratch).rock >= 0.5, `rock on the ridge's east face: ${scratch.rock}`);
  assert.ok(sampleMask(mask, 5.2, 10, scratch).rock + sampleMask(mask, 6, 3, scratch).rock >= 0, 'weights stay in range');
  assert.ok(mask.terrainRect[0] <= 10 && mask.terrainRect[2] >= 20 && mask.terrainRect[1] <= 12 && mask.terrainRect[3] >= 30, `terrain rect ${mask.terrainRect}`);
  assert.equal(mask.terrain.length, mask.width * mask.height * 4);
  assert.ok(MASK_TEXEL <= 0.25);
});

test('grass and clutter follow the new terrain and stay out of the water and off the bridge', () => {
  const clutter = new GroundClutter(region, field, mask, { value: 0 }, GREENWAKE_BIOME);
  const grass = new GroundGrass(field, mask, { value: 0 }, GREENWAKE_BIOME.understory);
  try {
    let instances = 0;
    let onBanks = 0;
    clutter.forEachInstance((name, x, z) => {
      instances++;
      const section = creekSection(z);
      assert.ok(!field.nearBridgeDeck(x, z, 0.05), `${name} under the bridge at (${x.toFixed(2)}, ${z.toFixed(2)})`);
      if (name.includes('glow')) return;
      assert.ok(!inCreek(x, z) || field.sample(x, z) > creekWaterLevel(z) + 0.05, `${name} in the creek at (${x.toFixed(2)}, ${z.toFixed(2)})`);
      if (field.sample(x, z) < -0.2 && z > 10 && z < 34) onBanks++;
    });
    assert.ok(instances > 5_000);
    assert.ok(onBanks >= 0);
    let clumps = 0;
    for (const [fx, fz] of [[15.25, 18.5], [15.25, 14], [14, 25], [20, 20], [9.5, 8]] as const) {
      for (let frame = 0; frame < 12; frame++) grass.update(fx, fz);
      grass.forEachClump((x, z) => {
        clumps++;
        const section = creekSection(z);
        assert.ok(!field.nearBridgeDeck(x, z, 0.05), `grass under the bridge at (${x.toFixed(2)}, ${z.toFixed(2)})`);
        assert.ok(!inCreek(x, z) || field.sample(x, z) > creekWaterLevel(z) + 0.05, `grass in the creek at (${x.toFixed(2)}, ${z.toFixed(2)})`);
        // Blades follow the terrain surface.
        assert.ok(Number.isFinite(field.sample(x, z)));
      });
    }
    assert.ok(clumps > 5_000, `${clumps} grass clumps near the creek and ramps`);
  } finally {
    clutter.dispose();
    grass.dispose();
  }
});

test('rock outcrops dress the embankment faces and creek banks as decoration: deterministic, off every walkable and the bridge, never in the water', () => {
  const placements = buildGreenwakeBoundaryPlacements(region);
  const rocks = placements.filter((placement) => placement.id.startsWith(GREENWAKE_BOUNDARY_ROCK_ID_PREFIX));
  assert.equal(GREENWAKE_BOUNDARY_ROCK_ID_PREFIX.startsWith(GREENWAKE_BOUNDARY_ID_PREFIX), true);
  assert.ok(rocks.length >= 10 && rocks.length <= 24, `${rocks.length} rock outcrops`);
  assert.equal(JSON.stringify(buildGreenwakeBoundaryPlacements(region)), JSON.stringify(placements), 'deterministic');
  assert.equal(new Set(placements.map((placement) => placement.id)).size, placements.length);
  let nearFaces = 0;
  let onBanks = 0;
  const scales = new Set<string>();
  for (const rock of rocks) {
    assert.equal(rock.assetId, 'prop-greenwake-boulder-cluster');
    assert.equal(rock.placement, 'ground');
    assert.equal(rock.position.y, 0);
    scales.add(rock.scale.x.toFixed(2));
    assert.ok(distanceToWalkMesh(region, rock.position.x, rock.position.z) >= 0.6);
    for (const circle of greenwakeFootprint(rock.assetId, rock.position, rock.rotationY, rock.scale)) {
      assert.ok(distanceToWalkMesh(region, circle.x, circle.z) >= circle.radius + 0.6, `${rock.id} footprint reaches within 0.6 m of a walkable`);
      for (const surface of walkables) assert.ok(distanceToSurface(surface, circle.x, circle.z) >= circle.radius + 0.6);
      // The rope bridge model spans x 13–17.5 over the deck (3 m wide): keep every rock 0.6 m clear of it too.
      const dx = Math.max(13 - circle.x, 0, circle.x - 17.5);
      const dz = Math.max(17 - circle.z, 0, circle.z - 20);
      assert.ok(Math.hypot(dx, dz) >= circle.radius + 0.6, `${rock.id} too close to the bridge`);
      const section = creekSection(circle.z);
      if (circle.z > CREEK_Z_START && circle.z < CREEK_Z_END) assert.ok(Math.abs(circle.x - section.centerX) >= section.bedHalfWidth + 0.45, `${rock.id} stands in the creek bed`);
    }
    if (raisedSurfaces.some((surface) => distanceToSurface(surface, rock.position.x, rock.position.z) <= 4)) nearFaces++;
    const section = creekSection(rock.position.z);
    if (rock.position.z > 10 && rock.position.z < 33 && Math.abs(rock.position.x - section.centerX) <= section.rimHalfWidth + 3) onBanks++;
  }
  assert.ok(nearFaces >= 8 && onBanks >= 3, `${nearFaces} rocks on embankment faces, ${onBanks} on creek banks`);
  assert.ok(scales.size >= 8, 'rock sizes vary');
});

test('RegionEnvironment draws no slab, timber or deck meshes for Greenwake, one creek strip, and animates the creek from the world clock', async () => {
  const props = [...region.props, ...buildGreenwakeBoundaryPlacements(region)];
  const environment = new RegionEnvironment({ ...region, props }, {} as unknown as EnvironmentRecipeDefinition);
  environment.ready.catch(() => undefined);
  try {
    const meshes: Mesh[] = [];
    environment.group.traverse((node) => {
      if ((node as Mesh).isMesh) meshes.push(node as Mesh);
    });
    assert.deepEqual(meshes.filter((mesh) => mesh.name.startsWith('surface:') || mesh.name.startsWith('timber-edge:')).map((mesh) => mesh.name), []);
    assert.equal(meshes.filter((mesh) => mesh.name === 'greenwake-terrain').length, 1);
    const water = meshes.filter((mesh) => mesh.name === 'greenwake-creek-water');
    assert.equal(water.length, 1);
    assert.equal(water[0]!.castShadow, false);
    environment.update(7.5, { x: 15, y: 0, z: 18 });
    assert.equal((water[0]!.material as ShaderMaterial).uniforms.uTime!.value, 7.5);
    // Water draws before the transparent prop batches (bridges, trunks: depthWrite = false), so planks are never painted over.
    assert.ok(water[0]!.renderOrder < 0, `water renderOrder ${water[0]!.renderOrder}`);
    // Props follow the visual terrain: the ridge top is 2 m up, the bridge midpoint sits in the gully.
    assert.ok(Math.abs(environment.visualGroundHeightAt(8, 17) - 2) <= 0.02);
    assert.ok(environment.visualGroundHeightAt(15.25, 18.5) <= -0.9);
    // Rocks anchor to the lowest ground under their footprint (uphill side buried): never higher than the terrain at their centre.
    for (const rock of props.filter((prop) => prop.id.startsWith(GREENWAKE_BOUNDARY_ROCK_ID_PREFIX))) {
      assert.ok(environment.visualGroundHeightAt(rock.position.x, rock.position.z) <= field.sample(rock.position.x, rock.position.z) - 0.01, `${rock.id} is not sunk`);
    }
  } finally {
    environment.dispose();
  }
});
