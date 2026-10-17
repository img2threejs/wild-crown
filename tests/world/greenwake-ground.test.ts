import assert from 'node:assert/strict';
import test from 'node:test';
import { REGIONS } from '../../src/content/world.js';
import type { GroundSurfaceDefinition, RegionDefinition, Vec3 } from '../../src/game/contracts.js';
import { insideVillage, GREENWAKE_BIOME } from '../../src/world/GreenwakeBiome.js';
import { GLOW_EMISSIVE_INTENSITY, GroundClutter } from '../../src/world/GroundClutter.js';
import { GRASS_MAX_BLADES, GRASS_POOL, GroundGrass, grassKeepFraction } from '../../src/world/GroundGrass.js';
import { bakeGroundMask, createMaskSample, groundTrailSegments, MASK_TEXEL, sampleMask } from '../../src/world/GroundMask.js';
import { CORE_CLEAR_WEIGHT, grassDensity } from '../../src/world/GroundScatter.js';
import { shadowKernelPatchable, withCheapShadows } from '../../src/world/GroundShadow.js';
import { buildTerrainMeshData, TerrainField } from '../../src/world/GroundTerrain.js';
import { GREENWAKE_CANOPY_FLOOR_ID, isBridgeDeckSurface, isFlatGroundSurface, isRaisedWalkSurface } from '../../src/world/WalkSurfaces.js';
import { arenaFromRegion, groundHeightAt, moveCircle } from '../../src/game/combat/geometry.js';

const region = REGIONS.find((candidate): candidate is RegionDefinition => candidate.id === 'greenwake')!;
const field = new TerrainField(region, GREENWAKE_BIOME);
const mask = bakeGroundMask(region, field, GREENWAKE_BIOME);
const segments = groundTrailSegments(region);
const flatSurfaces = region.ground.surfaces.filter(isFlatGroundSurface);
const raisedSurfaces = region.ground.surfaces.filter(isRaisedWalkSurface);
const terrainBackedRaised = raisedSurfaces.filter((surface) => !isBridgeDeckSurface(surface));

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

/** Rendered height of a raised surface (fan triangulation from vertex 0, as RegionEnvironment builds it). */
function surfaceHeight(surface: GroundSurfaceDefinition, x: number, z: number): number | undefined {
  const p = surface.points;
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[0]!;
    const b = p[i]!;
    const c = p[i + 1]!;
    const det = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
    if (det === 0) continue;
    const u = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / det;
    const v = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / det;
    const w = 1 - u - v;
    if (u >= 0 && v >= 0 && w >= 0) return u * a.y + v * b.y + w * c.y;
  }
  return undefined;
}

function bounds(surface: GroundSurfaceDefinition): { minX: number; maxX: number; minZ: number; maxZ: number } {
  const xs = surface.points.map((point) => point.x);
  const zs = surface.points.map((point) => point.z);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minZ: Math.min(...zs), maxZ: Math.max(...zs) };
}

function distanceToTrail(x: number, z: number): { distance: number; halfWidth: number } {
  let best = { distance: Infinity, halfWidth: 1 };
  for (const s of segments) {
    const dx = s.bx - s.ax;
    const dz = s.bz - s.az;
    const t = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / (s.length * s.length)));
    const distance = Math.hypot(x - s.ax - dx * t, z - s.az - dz * t);
    if (distance < best.distance) best = { distance, halfWidth: s.halfWidth };
  }
  return best;
}

test('the forest bank and thicket share the root ramp height without a hidden lower floor or a crossing step', () => {
  const arena = arenaFromRegion(region);
  for (let z = 4.05; z < 8.95; z += .17) {
    for (const x of [6.2, 9.5, 12.98, 13.02, 14.5]) {
      const height = groundHeightAt(arena, x, z, 0);
      assert.notEqual(height, null, `missing bank support at ${x},${z}`);
      assert.ok(Math.abs(field.sample(x, z) - height!) < .02, `rendered ground disagrees with foot support at ${x},${z}`);
    }
  }
  const across = moveCircle(arena, { x: 12, y: .8, z: 8 }, { x: 2, y: 0, z: 0 }, .42, 1.6);
  assert.ok(Math.abs(across.x - 14) < 1e-6 && Math.abs(across.y - .8) < 1e-6, 'the ramp-to-thicket seam must be directly walkable');
});

test('Greenwake terrain is exactly flat on every y=0 walkable surface, right up to its edge', () => {
  assert.ok(flatSurfaces.length >= 5, 'Greenwake must expose several y=0 walkable surfaces');
  for (const surface of flatSurfaces) {
    const box = bounds(surface);
    let checked = 0;
    const check = (x: number, z: number): void => {
      checked++;
      assert.ok(Math.abs(field.heightAt(x, z)) <= 0.02, `${surface.id} analytic height at (${x.toFixed(3)}, ${z.toFixed(3)}) = ${field.heightAt(x, z)}`);
      assert.ok(Math.abs(field.sample(x, z)) <= 0.02, `${surface.id} mesh height at (${x.toFixed(3)}, ${z.toFixed(3)}) = ${field.sample(x, z)}`);
    };
    for (let x = box.minX; x <= box.maxX; x += 0.37) {
      for (let z = box.minZ; z <= box.maxZ; z += 0.37) if (inside(surface, x, z)) check(x, z);
    }
    // Points hugging the boundary from the inside, where a berm vertex outside would contaminate a coarse triangle.
    const points = surface.points;
    for (let index = 0; index < points.length; index++) {
      const a = points[index]!;
      const b = points[(index + 1) % points.length]!;
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      for (let along = 0.05; along < length; along += 0.19) {
        for (const inset of [0.002, 0.03, 0.12, 0.3]) {
          for (const sign of [-1, 1]) {
            const x = a.x + ((b.x - a.x) / length) * along + (sign * (b.z - a.z) / length) * inset;
            const z = a.z + ((b.z - a.z) / length) * along - (sign * (b.x - a.x) / length) * inset;
            if (inside(surface, x, z)) check(x, z);
          }
        }
      }
    }
    assert.ok(checked > 0, `${surface.id} was never sampled`);
  }
});

/** Flat walkables whose overlap with `raised` the terrain gives to the raised plane: one of its y = 0 vertices lies inside the flat surface. */
function raisedWinsOver(raised: GroundSurfaceDefinition, flat: GroundSurfaceDefinition): boolean {
  return raised.points.some((point) => Math.abs(point.y) < 1e-3 && inside(flat, point.x, point.z) && distanceToSurfaceEdge(flat, point.x, point.z) >= 0.05);
}

function distanceToSurfaceEdge(surface: GroundSurfaceDefinition, x: number, z: number): number {
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

interface WalkOwner {
  /** The raised surface whose plane applies; undefined for y = 0 ground. */
  readonly surface: GroundSurfaceDefinition | undefined;
  readonly height: number;
}

/** Plane of a (planar) surface, extended beyond its footprint. */
function planeAt(surface: GroundSurfaceDefinition, x: number, z: number): number {
  const [a, b, c] = surface.points as [Vec3, Vec3, Vec3];
  const det = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
  const u = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / det;
  const v = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / det;
  return u * a.y + v * b.y + (1 - u - v) * c.y;
}

/** Which terrain-backed walkable defines the terrain at (x, z) and its height there; undefined where none does (including under the bridge deck). */
function walkOwner(x: number, z: number): WalkOwner | undefined {
  for (const surface of terrainBackedRaised) {
    if (!inside(surface, x, z)) continue;
    const blocked = flatSurfaces.some((flat) => inside(flat, x, z) && !raisedWinsOver(surface, flat));
    if (!blocked) return { surface, height: surfaceHeight(surface, x, z)! };
  }
  return flatSurfaces.some((flat) => inside(flat, x, z)) ? { surface: undefined, height: 0 } : undefined;
}

/** True when every walkable owner within `radius` of (x, z) continues the owner's own plane: no ownership cliff nearby. */
function ownerIsSteady(owner: WalkOwner, x: number, z: number, radius: number): boolean {
  for (let k = 0; k < 16; k++) {
    const qx = x + Math.cos((k * Math.PI) / 8) * radius;
    const qz = z + Math.sin((k * Math.PI) / 8) * radius;
    const other = walkOwner(qx, qz);
    if (other && Math.abs(other.height - (owner.surface ? planeAt(owner.surface, qx, qz) : 0)) > 0.005) return false;
  }
  return true;
}

test('every terrain-backed walkable, flat or raised, is reproduced by the terrain mesh within 2 cm', () => {
  assert.ok(!flatSurfaces.some((surface) => surface.id === GREENWAKE_CANOPY_FLOOR_ID) && !raisedSurfaces.some((surface) => surface.id === GREENWAKE_CANOPY_FLOOR_ID));
  assert.deepEqual(raisedSurfaces.filter(isBridgeDeckSurface).map((surface) => surface.id), ['greenwake-gully-bridge']);
  let checked = 0;
  let raisedChecked = 0;
  for (let x = -1; x <= 40; x += 0.13) {
    for (let z = -1; z <= 30; z += 0.13) {
      const owner = walkOwner(x, z);
      if (!owner) continue;
      const expected = owner.height;
      // Ownership changes (a raised edge beside a lower flat walkable) force a cliff inside one 0.25 m cell: skip 0.3 m around them.
      if (!ownerIsSteady(owner, x, z, 0.3)) continue;
      checked++;
      if (expected > 0.05) raisedChecked++;
      assert.ok(Math.abs(field.surfaceHeightAt(x, z)! - expected) <= 1e-6, `owner height ${field.surfaceHeightAt(x, z)} vs ${expected} at (${x.toFixed(2)}, ${z.toFixed(2)})`);
      assert.ok(Math.abs(field.heightAt(x, z) - expected) <= 1e-6, `analytic ${field.heightAt(x, z)} vs ${expected} at (${x.toFixed(2)}, ${z.toFixed(2)})`);
      assert.ok(Math.abs(field.sample(x, z) - expected) <= 0.02, `mesh ${field.sample(x, z)} vs ${expected} at (${x.toFixed(2)}, ${z.toFixed(2)})`);
    }
  }
  assert.ok(checked > 20_000 && raisedChecked > 8_000, `${checked} walk-surface probes, ${raisedChecked} on raised surfaces`);
});

test('raised planes join the flat ground and each other continuously', () => {
  const joins: Array<[number, number, number]> = [
    [9.5, 4.02, 0.004], // root ramp foot on the boar clearing
    [9.5, 3.98, 0],
    [7, 13.98, 1.996], // ramp top meets the ridge top
    [7, 14.02, 2],
    [11, 14, 2],
    [22.99, 20, 0.003], // gateway foot meets the first forest corridor
    [23.01, 20, 0],
    [17.02, 20, 1.993], // gateway head at the bridge
  ];
  for (const [x, z, expected] of joins) assert.ok(Math.abs(field.sample(x, z) - expected) <= 0.02, `terrain at (${x}, ${z}) = ${field.sample(x, z)}, expected ${expected}`);
  // The ridge and the gateway retain their shared 2 m landing.
  for (const [x, z] of [[2.2, 14.2], [12, 19], [13.4, 17], [13.5, 14.5]]) assert.ok(Math.abs(field.sample(x, z) - 2) <= 0.02, `ridge top at (${x}, ${z}) = ${field.sample(x, z)}`);
});

test('Greenwake terrain covers the region bounds with bounded relief and is deterministic', () => {
  const { min, max } = region.bounds;
  assert.ok(field.gridMinX <= min.x && field.gridMinZ <= min.z);
  assert.ok(field.gridMinX + (field.cols - 1) * field.cell >= max.x && field.gridMinZ + (field.rows - 1) * field.cell >= max.z);
  let low = Infinity;
  let high = -Infinity;
  for (const heights of [field.heights, field.fineHeights]) {
    for (const height of heights) {
      low = Math.min(low, height);
      high = Math.max(high, height);
    }
  }
  // Highest: the 2 m ridge top (plus rocky relief on its faces); lowest: the creek bed (about −1.3).
  assert.ok(high <= 2.2 && low >= -1.45 && low <= -1.2, `terrain ${low}..${high}`);
  // Open ground away from every walkable and the creek keeps the old relief envelope.
  let open = 0;
  let openHigh = -Infinity;
  let openLow = Infinity;
  for (let x = region.bounds.min.x; x < region.bounds.max.x; x += 1.7) {
    for (let z = region.bounds.min.z; z < region.bounds.max.z; z += 1.7) {
      if (field.walkDistance(x, z, 8) < 8 || (x > 8 && x < 22 && z > 8 && z < 36)) continue;
      open++;
      openHigh = Math.max(openHigh, field.sample(x, z));
      openLow = Math.min(openLow, field.sample(x, z));
    }
  }
  assert.ok(open > 1000 && openHigh <= GREENWAKE_BIOME.terrain.maxMound + 1e-6 && openLow >= GREENWAKE_BIOME.terrain.maxDip - 0.1 && openHigh > 0.5, `${open} open probes ${openLow}..${openHigh}`);
  const again = new TerrainField(region, GREENWAKE_BIOME);
  assert.deepEqual(Array.from(again.heights.subarray(0, 4000)), Array.from(field.heights.subarray(0, 4000)));
  assert.deepEqual(Array.from(again.fineHeights.subarray(0, 4000)), Array.from(field.fineHeights.subarray(0, 4000)));
});

interface EdgeProbe {
  /** Point on the walk-mesh boundary and the outward unit normal there. */
  qx: number;
  qz: number;
  nx: number;
  nz: number;
  /** 1 when the edge faces away from the camera, 0 when it faces it (same convention as the terrain). */
  away: number;
}

/** Boundary points of the union of y=0 walkable surfaces, with outward normals, 1 m apart along every edge. */
function unionBoundaryProbes(): EdgeProbe[] {
  const probes: EdgeProbe[] = [];
  const insideUnion = (x: number, z: number): boolean => flatSurfaces.some((surface) => inside(surface, x, z));
  for (const surface of flatSurfaces) {
    const points = surface.points;
    for (let index = 0; index < points.length; index++) {
      const a = points[index]!;
      const b = points[(index + 1) % points.length]!;
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      for (let along = 0.5; along < length; along += 1) {
        const qx = a.x + ((b.x - a.x) / length) * along;
        const qz = a.z + ((b.z - a.z) / length) * along;
        for (const sign of [-1, 1]) {
          const nx = (sign * (b.z - a.z)) / length;
          const nz = (-sign * (b.x - a.x)) / length;
          // A genuine union-boundary point has open ground 6 m outward along the normal's near side only.
          if (insideUnion(qx + nx * 0.02, qz + nz * 0.02) || !insideUnion(qx - nx * 0.02, qz - nz * 0.02)) continue;
          probes.push({ qx, qz, nx, nz, away: 0.5 - 0.5 * (nx * 0.5812 + nz * 0.8137) });
        }
      }
    }
  }
  return probes;
}

test('a natural berm rises just outside the walk-mesh, steeper on edges facing away from the camera', () => {
  const probes = unionBoundaryProbes();
  assert.ok(probes.length > 200, `only ${probes.length} boundary probes`);
  const farFromRaised = (x: number, z: number): boolean => raisedSurfaces.every((surface) => distanceToSurface(surface, x, z) > 3.5);
  const at = (probe: EdgeProbe, distance: number): { x: number; z: number } | undefined => {
    const x = probe.qx + probe.nx * distance;
    const z = probe.qz + probe.nz * distance;
    // Concave corners, narrow gaps and neighbouring surfaces make "distance along the normal" ambiguous: only use clean probes.
    return Math.abs(field.walkDistance(x, z, 6) - distance) < 0.03 && farFromRaised(x, z) ? { x, z } : undefined;
  };
  let tallest = 0;
  const awayHeights: number[] = [];
  const facingHeights: number[] = [];
  const facingAll: number[] = [];
  for (const probe of probes) {
    const start = at(probe, 0.2);
    if (start) assert.ok(Math.abs(field.sample(start.x, start.z)) <= 0.02, 'terrain must stay flat until the berm starts 0.36 m out');
    for (const distance of [0.5, 1, 1.5, 2.2]) {
      const point = at(probe, distance);
      if (!point) continue;
      const height = field.sample(point.x, point.z);
      tallest = Math.max(tallest, height);
      assert.ok(height <= GREENWAKE_BIOME.terrain.maxMound + 1e-6, `berm taller than the relief limit: ${height}`);
      // Quads are 0.25 m: a 0.9 m bank over 0.6 m deviates up to ~0.12 m from the analytic crest curvature.
      assert.ok(Math.abs(height - field.heightAt(point.x, point.z)) <= 0.15, 'rendered mesh must follow the analytic berm');
      if (distance === 1.5 && probe.away > 0.75) awayHeights.push(height);
      if (distance === 1.5 && probe.away < 0.25) facingHeights.push(height);
      if (probe.away < 0.25) facingAll.push(height);
    }
  }
  assert.ok(tallest >= 0.7 && tallest <= 0.9 + 0.2, `tallest berm ${tallest}`);
  assert.ok(awayHeights.length > 15 && facingHeights.length > 15, `${awayHeights.length} away / ${facingHeights.length} facing probes`);
  const mean = (values: number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length;
  assert.ok(mean(awayHeights) >= 0.4, `away-facing berm too low: ${mean(awayHeights)}`);
  assert.ok(mean(awayHeights) > mean(facingHeights) + 0.12, `away ${mean(awayHeights)} vs facing ${mean(facingHeights)}`);
  // Camera-facing banks stay low so they never hide Aren; corner probes can blend a neighbouring edge, so judge the bulk.
  const gentle = facingAll.filter((height) => height <= 0.52).length / facingAll.length;
  assert.ok(gentle >= 0.9 && mean(facingAll) <= 0.35, `${(gentle * 100).toFixed(0)}% of camera-facing probes gentle, mean ${mean(facingAll)}`);
});


test('terrain mesh is watertight, upward facing, T-junction free and matches the field sampler', () => {
  const data = buildTerrainMeshData(field);
  const triangles = data.indices.length / 3;
  assert.ok(triangles > 60_000 && triangles <= 240_000, `${triangles} terrain triangles`);
  assert.ok(field.refinedCells > 200, 'cells along the walk-mesh boundary must be refined');
  const vertexCount = data.positions.length / 3;
  const edges = new Map<number, number>();
  for (let t = 0; t < data.indices.length; t += 3) {
    const a = data.indices[t]!;
    const b = data.indices[t + 1]!;
    const c = data.indices[t + 2]!;
    assert.ok(a < vertexCount && b < vertexCount && c < vertexCount);
    const ax = data.positions[a * 3]!;
    const az = data.positions[a * 3 + 2]!;
    const area = (data.positions[b * 3]! - ax) * (data.positions[c * 3 + 2]! - az) - (data.positions[b * 3 + 2]! - az) * (data.positions[c * 3]! - ax);
    assert.ok(area < -1e-9, 'every terrain triangle must face up with non-zero area');
    for (const [from, to] of [[a, b], [b, c], [c, a]] as const) {
      const key = Math.min(from, to) * vertexCount + Math.max(from, to);
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  let openEdges = 0;
  for (const count of edges.values()) {
    assert.ok(count <= 2, 'an edge shared by more than two triangles');
    if (count === 1) openEdges++;
  }
  assert.equal(openEdges, 2 * (field.cols - 1 + field.rows - 1), 'only the outer rim may be open: every other edge must be shared (no T-junction cracks)');
  for (let index = 0; index < vertexCount; index += 7) {
    const x = data.positions[index * 3]!;
    const y = data.positions[index * 3 + 1]!;
    const z = data.positions[index * 3 + 2]!;
    assert.ok(Math.abs(field.sample(x, z) - y) <= 1e-4, `sampler disagrees with mesh vertex at (${x}, ${z})`);
    assert.ok(data.normals[index * 3 + 1]! > 0.2, 'terrain normals must point up');
  }
});

test('trail mask peaks on ribbon centrelines and vanishes 6 m away', () => {
  assert.ok(segments.length >= 10);
  const scratch = createMaskSample();
  for (const s of segments) {
    for (let along = 0; along <= s.length; along += 0.5) {
      const x = s.ax + ((s.bx - s.ax) / s.length) * along;
      const z = s.az + ((s.bz - s.az) / s.length) * along;
      // Where the ribbon runs off the terrain-backed walkables (the gully rim beside the bridge) the trail is deliberately not painted.
      const owner = walkOwner(x, z);
      if (!owner || !ownerIsSteady(owner, x, z, 0.3) || Array.from({ length: 16 }, (_, k) => walkOwner(x + Math.cos((k * Math.PI) / 8) * 0.3, z + Math.sin((k * Math.PI) / 8) * 0.3)).some((other) => !other)) continue;
      assert.ok(sampleMask(mask, x, z, scratch).core >= 0.9, `core weight ${scratch.core} on a ribbon centreline at (${x.toFixed(2)}, ${z.toFixed(2)})`);
    }
  }
  let peak = 0;
  for (let row = 0; row < mask.height; row++) {
    const z = mask.minZ + (row + 0.5) * MASK_TEXEL;
    for (let col = 0; col < mask.width; col++) {
      const value = mask.data[(row * mask.width + col) * 4]!;
      if (value > peak) peak = value;
      const shoulder = mask.data[(row * mask.width + col) * 4 + 1]!;
      if (value === 0 && shoulder === 0) continue;
      const x = mask.minX + (col + 0.5) * MASK_TEXEL;
      const nearest = distanceToTrail(x, z);
      if (value >= 242) assert.ok(nearest.distance <= 0.35 * nearest.halfWidth + 0.2, `core ≥ 0.95 at ${nearest.distance.toFixed(2)} m from a centreline`);
      if (nearest.distance >= 6) assert.ok(value === 0 && shoulder === 0, 'trail weights must vanish 6 m from every centreline');
    }
  }
  assert.equal(peak, 255);
  for (let row = 0; row < mask.height; row += 3) {
    for (let col = 0; col < mask.width; col += 3) {
      const x = mask.minX + (col + 0.5) * MASK_TEXEL;
      const z = mask.minZ + (row + 0.5) * MASK_TEXEL;
      if (distanceToTrail(x, z).distance < 6) continue;
      assert.equal(mask.data[(row * mask.width + col) * 4], 0);
    }
  }
  assert.ok(MASK_TEXEL <= 0.25 && mask.detailTexel <= 0.25);
});

test('berm undergrowth band hugs the walk-mesh edge and tall grass fills it densely', () => {
  const scratch = createMaskSample();
  let peak = 0;
  let dense = 0;
  let sparse = 0;
  for (let row = 0; row < mask.height; row += 2) {
    const z = mask.minZ + (row + 0.5) * MASK_TEXEL;
    for (let col = 0; col < mask.width; col += 2) {
      const x = mask.minX + (col + 0.5) * MASK_TEXEL;
      const value = mask.edge[row * mask.width + col]!;
      const gap = field.walkDistance(x, z, 6);
      peak = Math.max(peak, value);
      if (gap === 0 || gap >= 4.8) assert.equal(value, 0, `undergrowth band must not exist on the walk-mesh or beyond 4.8 m (gap ${gap})`);
      if (value >= 242 && !insideVillage(x, z)) {
        sampleMask(mask, x, z, scratch);
        if (scratch.core > 0.02 || scratch.shoulder > 0.02) continue;
        // Rock faces, wet banks, creek bed and the bridge's underside deliberately carry little or no ground cover.
        if (scratch.rock > 0.02 || scratch.mud > 0.02 || scratch.bed > 0.02 || scratch.deck > 0.02) continue;
        if (grassDensity(scratch, x, z, GREENWAKE_BIOME.understory) >= 0.8) dense++;
        else sparse++;
      }
    }
  }
  assert.equal(peak, 255);
  assert.ok(dense > 500 && sparse / (dense + sparse) < 0.05, `${dense} dense vs ${sparse} sparse tall-grass texels in the band`);
});

test('grass streams within the 12-draw / 150k-blade budget and never grows on the trail core', () => {
  const wind = { value: 0 };
  const grass = new GroundGrass(field, mask, wind, GREENWAKE_BIOME.understory);
  try {
    let drawn = 0;
    let unthinned = 0;
    let thinned = 0;
    const scratch = createMaskSample();
    for (const s of segments.filter((_, index) => index % 3 === 0)) {
      for (let frame = 0; frame < 4; frame++) grass.update(s.ax, s.az);
      const stats = grass.activeStats;
      assert.ok(stats.tiles <= GRASS_POOL && stats.blades <= 150_000 && GRASS_MAX_BLADES <= 150_000);
      assert.ok(stats.tiles > 0, 'grass must be drawn around the route');
      unthinned += stats.bladesUnthinned;
      thinned += stats.blades;
      grass.forEachClump((x, z) => {
        drawn++;
        assert.ok(sampleMask(mask, x, z, scratch).core <= CORE_CLEAR_WEIGHT + 1e-6, `grass clump on the trail core at (${x.toFixed(2)}, ${z.toFixed(2)})`);
        assert.ok(!insideVillage(x, z));
      });
    }
    assert.ok(drawn > 5_000);
    assert.ok(thinned <= unthinned * 0.6, `distance thinning submitted ${thinned} of ${unthinned} blades`);
  } finally {
    grass.dispose();
  }
});

test('grass density falls monotonically with distance from 1 near the player to 0 outside the fade', () => {
  assert.equal(grassKeepFraction(0), 1);
  assert.equal(grassKeepFraction(4.5), 1);
  assert.equal(grassKeepFraction(13.5), 0);
  let previous = 1;
  for (let distance = 0; distance <= 14; distance += 0.25) {
    const keep = grassKeepFraction(distance);
    assert.ok(keep <= previous + 1e-9, `keep fraction rose at ${distance} m`);
    previous = keep;
  }
  assert.ok(grassKeepFraction(12) >= 0.2 - 1e-9 && grassKeepFraction(12) <= 0.5);
});

test('cheap shadow kernels replace the 16-fetch PCFSoft block and stay compilable text', () => {
  assert.ok(shadowKernelPatchable(), 'three changed its PCFSoft chunk; update GroundShadow');
  const stock = 'before\n#include <shadowmap_pars_fragment>\nafter';
  const bilinear = withCheapShadows(stock, 'bilinear');
  const hard = withCheapShadows(stock, 'hard');
  for (const patched of [bilinear, hard]) {
    assert.ok(patched.startsWith('before\n') && patched.endsWith('\nafter'));
    assert.ok(!patched.includes('2.0 * dx'), 'the 16-tap PCFSoft kernel must be gone');
    assert.ok(patched.includes('SHADOWMAP_TYPE_VSM') && patched.includes('float getShadow('));
  }
  const taps = (text: string): number => (text.match(/texture2DCompare\( shadowMap/g) ?? []).length;
  assert.equal(taps(bilinear) - taps(hard), 3, 'bilinear kernel is four fetches, hard is one');
});

test('GPU shade mask mirrors the CPU trail weights and detail is neutral away from the trail', () => {
  for (let index = 0; index < mask.width * mask.height; index += 97) {
    assert.equal(mask.shade[index * 4], mask.data[index * 4]);
    assert.equal(mask.shade[index * 4 + 1], mask.data[index * 4 + 1]);
  }
  let sawMoss = false;
  let sawLitter = false;
  for (let index = 2; index < mask.width * mask.height * 4; index += 4 * 53) {
    const moss = mask.shade[index]!;
    if (moss > 200) sawMoss = true;
    if (moss < 50) sawLitter = true;
  }
  assert.ok(sawMoss && sawLitter, 'both moss patches and leaf litter must exist off-route');
  let checked = 0;
  for (let row = 0; row < mask.detailHeight; row += 11) {
    for (let col = 0; col < mask.detailWidth; col += 11) {
      const x = mask.minX + (col + 0.5) * mask.detailTexel;
      const z = mask.minZ + (row + 0.5) * mask.detailTexel;
      if (distanceToTrail(x, z).distance < 6) continue;
      checked++;
      const base = (row * mask.detailWidth + col) * 4;
      assert.deepEqual(Array.from(mask.detail.subarray(base, base + 4)), [128, 128, 128, 128]);
    }
  }
  assert.ok(checked > 1000);
});

test('clutter stays off the trail core and the whole ground layer fits the draw-call budget', () => {
  const clutter = new GroundClutter(region, field, mask, { value: 0 }, GREENWAKE_BIOME);
  try {
    assert.ok(clutter.drawCalls >= 5 && clutter.drawCalls + GRASS_POOL + 1 <= 40, `${clutter.drawCalls} clutter draw calls`);
    assert.ok(GLOW_EMISSIVE_INTENSITY > 1);
    const scratch = createMaskSample();
    const names = new Set<string>();
    clutter.forEachInstance((name, x, z) => {
      names.add(name);
      assert.ok(sampleMask(mask, x, z, scratch).core <= 0.36, `${name} on the trail core at (${x.toFixed(2)}, ${z.toFixed(2)})`);
    });
    for (const expected of ['pebble', 'twig', 'leaf-pile', 'mushroom', 'fern', 'edge-stone']) {
      assert.ok(names.has(`ground-clutter-${expected}`), `${expected} missing`);
    }
    // The berm undergrowth lives in the existing fern / twig draw calls: at most +2000 instances over the 6,813 of the pre-berm clutter.
    assert.ok(clutter.instanceCount <= 6813 + 2000, `${clutter.instanceCount} clutter instances`);
    let bandUndergrowth = 0;
    clutter.forEachInstance((name, x, z) => {
      const gap = field.walkDistance(x, z, 6);
      if ((name.endsWith('-fern') || name.endsWith('-twig')) && gap >= 0.5 && gap <= 4) bandUndergrowth++;
    });
    assert.ok(bandUndergrowth >= 1200, `only ${bandUndergrowth} ferns/roots along the berm`);
  } finally {
    clutter.dispose();
  }
});
