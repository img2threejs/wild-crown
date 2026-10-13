import type { RegionDefinition } from '../game/contracts';
import { groundExtent, type BiomeProfile, type GroundCarve, type TerrainProfile } from './BiomeProfile';
import { clamp01, fbm, smoothstep, valueNoise } from './GroundNoise';
import { isBridgeDeckSurface, isFlatGroundSurface, isRaisedWalkSurface } from './WalkSurfaces';

export const TERRAIN_CELL = 1;
/** Cells near the walk-mesh are split into REFINE × REFINE sub-cells so edges and embankments start close to the walkable boundary. */
export const TERRAIN_REFINE = 4;
const FINE_CELL = TERRAIN_CELL / TERRAIN_REFINE;
/** Visual terrain extends past the region's ground extent so the fixed camera never sees the world edge. */
export const TERRAIN_MARGIN = 16;
/** Open-ground relief fades in this far (and over this distance) from the walk-mesh, past the berm. */
const RELIEF_START = 3;
const RELIEF_BLEND = 3.5;
/**
 * The berm and every raised embankment start at least one fine-cell diagonal (0.354 m) outside the walk-mesh.
 * Every triangle is then smaller than that distance, so no triangle can contain both a walkable point and a vertex
 * that has left the walkable height: terrain on the walk-mesh is exact on the rendered mesh, not only analytically.
 */
export const BERM_START = 0.36;
/** Longest rise-run allowed (height/width), so steep edges stay a bank rather than a wall. */
const BERM_MAX_SLOPE = 1.5;
/** Horizontal camera offset (+10, +14) normalised: edges whose outward normal points this way face the camera. */
const CAMERA_X = 0.5812;
const CAMERA_Z = 0.8137;
/** A terrain-backed raised surface keeps its edge height across this shoulder before the embankment falls away. */
export const EMBANKMENT_SHOULDER = 0.36;
/** Embankment influence ends this far from a raised footprint (the longest face is shoulder + embankment.maxRun). */
const EMBANKMENT_REACH = 6;
const NOISE_SEED = 90211;
const BERM_SEED = 4177;
const FACE_SEED = 5821;
const ROCK_SEED = 6113;
const BED_SEED = 7351;
const HUMMOCK_SEED = 3331;
/** Hummocks on a summit fade in from the walkables' and the summit's own edges. */
const HUMMOCK_FADE_START = 0.6;
const HUMMOCK_FADE_END = 2.8;
/** Refinement bands (profile): outside the flat walk-mesh and outside raised footprints; cells straddling an ownership change are always refined. */
const REFINE_INSIDE = 0.75;
const NO_OWNER = -2;
const FLAT_OWNER = -1;
const FLAT_EPSILON = 1e-3;
/** Edges within this much farther than the nearest one contribute to the berm's outward normal. */
const NORMAL_SLACK = 1;
const NORMAL_SHARPNESS = 5;

interface Footprint {
  readonly xs: Float64Array;
  readonly zs: Float64Array;
  readonly ys: Float64Array;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  /** Raised footprints only: flat footprints whose overlap with this one stays at y = 0 (the raised plane is cut out there). */
  readonly blockers: Footprint[];
  /** Summits only: amplitude of the plateau hummocks (0 for walkables). */
  readonly hummock: number;
}

function footprintOf(points: readonly { readonly x: number; readonly y: number; readonly z: number }[], hummock = 0): Footprint {
  const count = points.length;
  const xs = new Float64Array(count);
  const zs = new Float64Array(count);
  const ys = new Float64Array(count);
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let index = 0; index < count; index++) {
    const point = points[index]!;
    xs[index] = point.x;
    zs[index] = point.z;
    ys[index] = point.y;
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.z < minZ) minZ = point.z;
    if (point.z > maxZ) maxZ = point.z;
  }
  return { xs, zs, ys, minX, maxX, minZ, maxZ, blockers: [], hummock };
}

function insideFootprint(footprint: Footprint, x: number, z: number): boolean {
  const { xs, zs } = footprint;
  let inside = false;
  for (let index = 0, previous = xs.length - 1; index < xs.length; previous = index++) {
    const zi = zs[index]!;
    const zj = zs[previous]!;
    if ((zi > z) !== (zj > z) && x < ((xs[previous]! - xs[index]!) * (z - zi)) / (zj - zi) + xs[index]!) inside = !inside;
  }
  return inside;
}

function bboxDistance(footprint: Footprint, x: number, z: number): number {
  const dx = Math.max(footprint.minX - x, 0, x - footprint.maxX);
  const dz = Math.max(footprint.minZ - z, 0, z - footprint.maxZ);
  return Math.hypot(dx, dz);
}

/** Result of the nearest-boundary query; reused across calls. */
interface Nearest {
  distance: number;
  x: number;
  z: number;
}

/** Distance from (x, z) to the footprint's boundary segments (also from inside), with the closest boundary point. */
function boundaryNearest(footprint: Footprint, x: number, z: number, best: Nearest): void {
  const { xs, zs } = footprint;
  for (let index = 0, previous = xs.length - 1; index < xs.length; previous = index++) {
    const ax = xs[previous]!;
    const az = zs[previous]!;
    const dx = xs[index]! - ax;
    const dz = zs[index]! - az;
    const lengthSquared = dx * dx + dz * dz;
    const t = lengthSquared > 0 ? clamp01(((x - ax) * dx + (z - az) * dz) / lengthSquared) : 0;
    const qx = ax + dx * t;
    const qz = az + dz * t;
    const distance = Math.hypot(x - qx, z - qz);
    if (distance < best.distance) {
      best.distance = distance;
      best.x = qx;
      best.z = qz;
    }
  }
}

const closedProbe: Nearest = { distance: 0, x: 0, z: 0 };

/** Inside the footprint or on its boundary: ownership is a closed set, so vertices on a walkable's edge keep its height. */
function containsClosed(footprint: Footprint, x: number, z: number): boolean {
  if (x < footprint.minX || x > footprint.maxX || z < footprint.minZ || z > footprint.maxZ) return false;
  if (insideFootprint(footprint, x, z)) return true;
  closedProbe.distance = 1e-7;
  boundaryNearest(footprint, x, z, closedProbe);
  return closedProbe.distance < 1e-7;
}

/** Nearest boundary point of a raised footprint together with the surface height there (linear along the edge). */
interface EdgeHit {
  distance: number;
  height: number;
}

function boundaryNearestHeight(footprint: Footprint, x: number, z: number, best: EdgeHit): void {
  const { xs, zs, ys } = footprint;
  best.distance = Infinity;
  for (let index = 0, previous = xs.length - 1; index < xs.length; previous = index++) {
    const ax = xs[previous]!;
    const az = zs[previous]!;
    const dx = xs[index]! - ax;
    const dz = zs[index]! - az;
    const lengthSquared = dx * dx + dz * dz;
    const t = lengthSquared > 0 ? clamp01(((x - ax) * dx + (z - az) * dz) / lengthSquared) : 0;
    const distance = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
    if (distance < best.distance) {
      best.distance = distance;
      best.height = ys[previous]! + (ys[index]! - ys[previous]!) * t;
    }
  }
}

const edgeScratch: EdgeHit = { distance: 0, height: 0 };

/** Height of a raised surface at (x, z) using the polygon fan from vertex 0 (the triangulation the simulation and the bridge model share). */
function planeHeight(footprint: Footprint, x: number, z: number): number {
  const { xs, zs, ys } = footprint;
  const x0 = xs[0]!;
  const z0 = zs[0]!;
  for (let index = 1; index < xs.length - 1; index++) {
    const det = (zs[index]! - zs[index + 1]!) * (x0 - xs[index + 1]!) + (xs[index + 1]! - xs[index]!) * (z0 - zs[index + 1]!);
    if (det === 0) continue;
    const a = ((zs[index]! - zs[index + 1]!) * (x - xs[index + 1]!) + (xs[index + 1]! - xs[index]!) * (z - zs[index + 1]!)) / det;
    const b = ((zs[index + 1]! - z0) * (x - xs[index + 1]!) + (x0 - xs[index + 1]!) * (z - zs[index + 1]!)) / det;
    const c = 1 - a - b;
    if (a >= -1e-9 && b >= -1e-9 && c >= -1e-9) return a * ys[0]! + b * ys[index]! + c * ys[index + 1]!;
  }
  // Boundary rounding: the point is on the footprint's edge.
  boundaryNearestHeight(footprint, x, z, edgeScratch);
  return edgeScratch.height;
}

/** True when the footprints share positive area (sampled on a 0.5 m grid inside their common bounding box). */
function overlapsWithArea(a: Footprint, b: Footprint): boolean {
  const minX = Math.max(a.minX, b.minX);
  const maxX = Math.min(a.maxX, b.maxX);
  const minZ = Math.max(a.minZ, b.minZ);
  const maxZ = Math.min(a.maxZ, b.maxZ);
  for (let x = minX + 0.25; x < maxX; x += 0.5) {
    for (let z = minZ + 0.25; z < maxZ; z += 0.5) if (insideFootprint(a, x, z) && insideFootprint(b, x, z)) return true;
  }
  return false;
}

/**
 * A raised surface whose y = 0 foot lies inside a flat surface (the gateway ramp inside the first forest corridor, the root ramp
 * inside the forest floor) continues that flat ground: the ramp plane wins in the overlap. A raised surface that merely crosses a
 * flat one higher up (the root ramp's east flank over the boar thicket) never lifts that flat ground: flat y = 0 wins there.
 */
function hasEmbeddedFoot(raised: Footprint, flat: Footprint): boolean {
  const probe = { distance: Infinity, x: 0, z: 0 };
  for (let index = 0; index < raised.xs.length; index++) {
    if (Math.abs(raised.ys[index]!) >= FLAT_EPSILON || !insideFootprint(flat, raised.xs[index]!, raised.zs[index]!)) continue;
    probe.distance = Infinity;
    boundaryNearest(flat, raised.xs[index]!, raised.zs[index]!, probe);
    if (probe.distance >= 0.05) return true;
  }
  return false;
}

/** Unflattened mound/dip relief: up to `maxMound` m, down to `maxDip` m. */
function reliefAt(terrain: TerrainProfile, x: number, z: number): number {
  const broad = fbm(x / 17, z / 17, NOISE_SEED, 3);
  const fine = fbm(x / 4.6, z / 4.6, NOISE_SEED + 7, 2);
  const n = Math.max(-1, Math.min(1, broad * 1.7 + fine * 0.3));
  return n >= 0 ? n * terrain.maxMound : -n * terrain.maxDip;
}

/** Ridge profile of the berm at `distance` m outside the walk-mesh; (nx, nz) is the outward unit normal of the nearest edge. */
function bermAt(terrain: TerrainProfile, x: number, z: number, distance: number, nx: number, nz: number): number {
  // 1 on edges whose outward normal points away from the camera (the bank rises behind Aren), 0 on camera-facing edges.
  const away = 0.5 - 0.5 * (nx * CAMERA_X + nz * CAMERA_Z);
  const peak = terrain.bermMinHeight + (terrain.bermMaxHeight - terrain.bermMinHeight) * away * (0.55 + 0.45 * valueNoise(x * 0.31, z * 0.31, BERM_SEED));
  const rise = Math.max(Math.min(2.4, (2.3 - 1.85 * away) * (0.85 + 0.3 * valueNoise(x * 0.47, z * 0.47, BERM_SEED + 1))), peak / BERM_MAX_SLOPE, 0.4);
  const fall = 1.4 + 1.4 * valueNoise(x * 0.23, z * 0.23, BERM_SEED + 2);
  const top = BERM_START + rise;
  return peak * smoothstep(BERM_START, top, distance) * (1 - smoothstep(top, top + fall, distance));
}

/** Polynomial smooth minimum: rounds the crease where the carved surface meets the surrounding ground. */
function smoothMin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/**
 * Deterministic visual terrain of one region, driven by its {@link BiomeProfile}.
 *  - Height is exactly the walk surface on every terrain-backed walkable: 0 on y = 0 surfaces, the authored plane on
 *    raised ones (ramps, ridge and cliff tops). A bridge deck is the one walkable that is NOT terrain-backed.
 *  - Just outside a flat walkable a natural berm rises (`bermMinHeight`…`bermMaxHeight`, noise-varied): steeper and taller
 *    where the edge faces away from the camera, gentler where it faces it. Open-ground mounds and dips blend in further out.
 *  - A raised walkable keeps its edge height across a 0.36 m shoulder, then an embankment falls into the surrounding relief
 *    over a noise-varied run (profile slope plus rocky relief).
 *  - Summits (profile) are non-walkable planar raised footprints that continue a cliff top or slope around the walkables with
 *    hummocks; they fall off as cliff faces like walkable ones and can be carved.
 *  - The profile's carve (creek gully, rivers, pools) is `min`-ed with the ground. It fades in with distance from a walkable
 *    (the carve's crestStart…crestEnd, never before {@link BERM_START} where it undercuts the walkable's height), so it never
 *    lowers terrain inside a walkable footprint and cliff crests are rounded; the region under a bridge deck is carved.
 * Where a raised footprint overlaps a flat one, {@link hasEmbeddedFoot} decides which surface the terrain follows.
 * Cells near walkable boundaries and the carve are refined to 0.25 m (T-junction free).
 * Purely presentational: walkability stays with the simulation's walk-mesh.
 */
export class TerrainField {
  readonly cell = TERRAIN_CELL;
  readonly gridMinX: number;
  readonly gridMinZ: number;
  readonly cols: number;
  readonly rows: number;
  /** Coarse (1 m) vertex heights. */
  readonly heights: Float32Array;
  /** Per coarse cell: index into `fineHeights` blocks, or −1 when the cell is not refined. */
  readonly refineIndex: Int32Array;
  /** (REFINE + 1)² heights per refined cell, row-major, boundary vertices stitched to unrefined neighbours. */
  readonly fineHeights: Float32Array;
  readonly refinedCells: number;
  private readonly terrain: TerrainProfile;
  private readonly carve: GroundCarve;
  private readonly flat: Footprint[] = [];
  private readonly raised: Footprint[] = [];
  private readonly summits: Footprint[] = [];
  private readonly bridges: Footprint[] = [];
  private readonly nearest: Nearest = { distance: 0, x: 0, z: 0 };
  private readonly neighbour: Nearest = { distance: 0, x: 0, z: 0 };
  private readonly edge: EdgeHit = { distance: 0, height: 0 };

  constructor(region: RegionDefinition, profile: BiomeProfile) {
    this.terrain = profile.terrain;
    this.carve = profile.carve;
    for (const surface of region.ground.surfaces) {
      if (isBridgeDeckSurface(surface)) this.bridges.push(footprintOf(surface.points));
      else if (isFlatGroundSurface(surface)) this.flat.push(footprintOf(surface.points));
      else if (isRaisedWalkSurface(surface)) this.raised.push(footprintOf(surface.points));
    }
    for (const summit of this.terrain.summits) this.summits.push(footprintOf(summit.points, summit.hummock));
    for (const raised of [...this.raised, ...this.summits]) {
      for (const flat of this.flat) if (overlapsWithArea(raised, flat) && !hasEmbeddedFoot(raised, flat)) raised.blockers.push(flat);
    }
    const extent = groundExtent(region, profile);
    this.gridMinX = Math.floor(extent.minX) - TERRAIN_MARGIN;
    this.gridMinZ = Math.floor(extent.minZ) - TERRAIN_MARGIN;
    this.cols = Math.ceil(extent.maxX) + TERRAIN_MARGIN - this.gridMinX + 1;
    this.rows = Math.ceil(extent.maxZ) + TERRAIN_MARGIN - this.gridMinZ + 1;
    this.heights = new Float32Array(this.cols * this.rows);
    for (let row = 0; row < this.rows; row++) {
      for (let col = 0; col < this.cols; col++) {
        this.heights[row * this.cols + col] = this.heightAt(this.gridMinX + col * this.cell, this.gridMinZ + row * this.cell);
      }
    }
    const cellsX = this.cols - 1;
    const cellsZ = this.rows - 1;
    this.refineIndex = new Int32Array(cellsX * cellsZ).fill(-1);
    let refined = 0;
    for (let row = 0; row < cellsZ; row++) {
      for (let col = 0; col < cellsX; col++) {
        if (this.needsRefinement(this.gridMinX + (col + 0.5) * this.cell, this.gridMinZ + (row + 0.5) * this.cell)) this.refineIndex[row * cellsX + col] = refined++;
      }
    }
    this.refinedCells = refined;
    const side = TERRAIN_REFINE + 1;
    this.fineHeights = new Float32Array(refined * side * side);
    for (let row = 0; row < cellsZ; row++) {
      for (let col = 0; col < cellsX; col++) {
        const block = this.refineIndex[row * cellsX + col]!;
        if (block >= 0) this.fillFineCell(col, row, block);
      }
    }
  }

  /**
   * Who defines the terrain height at (x, z): the index of a raised walkable footprint (its plane), the index of a summit
   * (`raised.length` + its position: its plane plus hummocks, carvable), FLAT_OWNER (y = 0) or NO_OWNER (the terrain's own
   * relief, berm, embankment and carve). A raised footprint yields to the flat footprints in its `blockers`.
   */
  private ownerAt(x: number, z: number): number {
    const walkableRaised = this.raised.length;
    for (let index = 0; index < walkableRaised + this.summits.length; index++) {
      const raised = index < walkableRaised ? this.raised[index]! : this.summits[index - walkableRaised]!;
      if (!containsClosed(raised, x, z)) continue;
      let blocked = false;
      for (const blocker of raised.blockers) {
        if (containsClosed(blocker, x, z)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) return index;
    }
    for (const flat of this.flat) if (containsClosed(flat, x, z)) return FLAT_OWNER;
    return NO_OWNER;
  }

  /**
   * The walk surface height the terrain reproduces at (x, z): 0 on a flat walkable, the plane of a raised one, `undefined`
   * on ground no terrain-backed walkable owns (including the region under the bridge deck).
   */
  surfaceHeightAt(x: number, z: number): number | undefined {
    const owner = this.ownerAt(x, z);
    if (owner >= 0 && owner < this.raised.length) return planeHeight(this.raised[owner]!, x, z);
    return owner === FLAT_OWNER ? 0 : undefined;
  }

  /** True when (x, z) lies on a bridge-deck walkable, or within `margin` metres of one. */
  nearBridgeDeck(x: number, z: number, margin = 0): boolean {
    for (const deck of this.bridges) {
      if (bboxDistance(deck, x, z) > margin) continue;
      if (insideFootprint(deck, x, z)) return true;
      if (margin > 0) {
        const probe = this.nearest;
        probe.distance = margin;
        boundaryNearest(deck, x, z, probe);
        if (probe.distance < margin) return true;
      }
    }
    return false;
  }

  /**
   * True when the coarse cell centred at (x, z) needs fine triangles: it is not wholly inside one owner (a walkable
   * boundary or an ownership change crosses it), or it is unowned ground within the berm / embankment / gully bands.
   */
  private needsRefinement(x: number, z: number): boolean {
    const owner = this.ownerAt(x, z);
    const half = this.cell / 2;
    for (let index = 0; index < 4; index++) {
      if (this.ownerAt(x + (index & 1 ? half : -half), z + (index & 2 ? half : -half)) !== owner) return true;
    }
    for (let index = 0; index < 8; index++) {
      const angle = (index * Math.PI) / 4;
      if (this.ownerAt(x + Math.cos(angle) * REFINE_INSIDE, z + Math.sin(angle) * REFINE_INSIDE) !== owner) return true;
    }
    if (owner === FLAT_OWNER || (owner >= 0 && owner < this.raised.length)) return false;
    if (this.carve.insideBand(x, z, 0.5)) return true;
    if (owner !== NO_OWNER) return false;
    const probe = this.nearest;
    probe.distance = Infinity;
    for (const footprint of this.flat) {
      if (bboxDistance(footprint, x, z) >= Math.min(probe.distance, this.terrain.refine.flatOutside + 1)) continue;
      boundaryNearest(footprint, x, z, probe);
    }
    if (probe.distance <= this.terrain.refine.flatOutside) return true;
    probe.distance = Infinity;
    for (const group of [this.raised, this.summits]) {
      for (const footprint of group) {
        if (bboxDistance(footprint, x, z) >= Math.min(probe.distance, this.terrain.refine.raisedOutside + 1)) continue;
        boundaryNearest(footprint, x, z, probe);
      }
    }
    return probe.distance <= this.terrain.refine.raisedOutside;
  }

  private fillFineCell(col: number, row: number, block: number): void {
    const cellsX = this.cols - 1;
    const cellsZ = this.rows - 1;
    const side = TERRAIN_REFINE + 1;
    const base = block * side * side;
    const x0 = this.gridMinX + col * this.cell;
    const z0 = this.gridMinZ + row * this.cell;
    const h00 = this.heights[row * this.cols + col]!;
    const h10 = this.heights[row * this.cols + col + 1]!;
    const h01 = this.heights[(row + 1) * this.cols + col]!;
    const h11 = this.heights[(row + 1) * this.cols + col + 1]!;
    const leftPlain = col === 0 || this.refineIndex[row * cellsX + col - 1]! < 0;
    const rightPlain = col === cellsX - 1 || this.refineIndex[row * cellsX + col + 1]! < 0;
    const backPlain = row === 0 || this.refineIndex[(row - 1) * cellsX + col]! < 0;
    const frontPlain = row === cellsZ - 1 || this.refineIndex[(row + 1) * cellsX + col]! < 0;
    for (let v = 0; v <= TERRAIN_REFINE; v++) {
      for (let u = 0; u <= TERRAIN_REFINE; u++) {
        const fu = u / TERRAIN_REFINE;
        const fv = v / TERRAIN_REFINE;
        let height: number;
        if (u === 0 && v === 0) height = h00;
        else if (u === TERRAIN_REFINE && v === 0) height = h10;
        else if (u === 0 && v === TERRAIN_REFINE) height = h01;
        else if (u === TERRAIN_REFINE && v === TERRAIN_REFINE) height = h11;
        // Edges shared with an unrefined neighbour follow that neighbour's straight coarse edge exactly.
        else if (u === 0 && leftPlain) height = h00 + (h01 - h00) * fv;
        else if (u === TERRAIN_REFINE && rightPlain) height = h10 + (h11 - h10) * fv;
        else if (v === 0 && backPlain) height = h00 + (h10 - h00) * fu;
        else if (v === TERRAIN_REFINE && frontPlain) height = h01 + (h11 - h01) * fu;
        else height = this.heightAt(x0 + u * FINE_CELL, z0 + v * FINE_CELL);
        this.fineHeights[base + v * side + u] = height;
      }
    }
  }

  /** Horizontal distance (capped at `limit`) to the nearest walkable surface: flat, raised or bridge deck. */
  walkDistance(x: number, z: number, limit: number): number {
    let best = this.groupGap(this.flat, x, z, limit);
    if (best > 0) best = this.groupGap(this.raised, x, z, best);
    if (best > 0) best = this.groupGap(this.bridges, x, z, best);
    return best;
  }

  /**
   * Horizontal distance (capped at `limit`) to the nearest terrain-backed raised walkable or cliff summit (0 inside): where
   * embankments and rock faces stand.
   */
  raisedDistance(x: number, z: number, limit: number): number {
    const best = this.groupGap(this.raised, x, z, limit);
    return best > 0 ? this.groupGap(this.summits, x, z, best) : 0;
  }

  /** Horizontal distance (capped at `limit`) to the nearest terrain-backed walkable, flat or raised (bridge decks excluded). */
  walkableGap(x: number, z: number, limit: number): number {
    const best = this.groupGap(this.flat, x, z, limit);
    return best > 0 ? this.groupGap(this.raised, x, z, best) : 0;
  }

  private groupGap(group: readonly Footprint[], x: number, z: number, limit: number): number {
    let best = limit;
    for (const footprint of group) {
      if (bboxDistance(footprint, x, z) >= best) continue;
      best = Math.min(best, this.footprintGap(footprint, x, z, best));
      if (best === 0) return 0;
    }
    return best;
  }

  /** 0 when inside the footprint, otherwise the distance to its boundary (the caller's `limit` is only a prune hint). */
  private footprintGap(footprint: Footprint, x: number, z: number, limit: number): number {
    if (insideFootprint(footprint, x, z)) return 0;
    const probe = this.nearest;
    probe.distance = limit;
    boundaryNearest(footprint, x, z, probe);
    return probe.distance;
  }

  /** Analytic terrain height; the mesh samples this function at its vertices. */
  heightAt(x: number, z: number): number {
    const owner = this.ownerAt(x, z);
    const walkableRaised = this.raised.length;
    if (owner >= 0 && owner < walkableRaised) return planeHeight(this.raised[owner]!, x, z);
    if (owner === FLAT_OWNER) return 0;
    let height: number;
    let ownedDistance: number;
    if (owner >= 0) {
      // Inside a cliff summit: its plane (a plateau or a slope) with gentle hummocks away from walkables and from its own faces.
      const summit = this.summits[owner - walkableRaised]!;
      height = planeHeight(summit, x, z);
      ownedDistance = this.walkableGap(x, z, HUMMOCK_FADE_END);
      if (summit.hummock > 0) {
        const probe = this.neighbour;
        probe.distance = Infinity;
        boundaryNearest(summit, x, z, probe);
        const fade = smoothstep(HUMMOCK_FADE_START, HUMMOCK_FADE_END, Math.min(ownedDistance, probe.distance));
        if (fade > 0) height += summit.hummock * fbm(x / 7, z / 7, HUMMOCK_SEED, 2) * fade;
      }
    } else {
      const reach = RELIEF_START + RELIEF_BLEND;
      const probe = this.nearest;
      probe.distance = reach;
      for (const footprint of this.flat) {
        if (bboxDistance(footprint, x, z) >= probe.distance) continue;
        boundaryNearest(footprint, x, z, probe);
      }
      const distance = probe.distance;
      // Within one fine-cell diagonal of a flat walkable the ground is that walkable's height, whatever embankment or relief is
      // nearby: no triangle containing a walkable point may have a vertex that has left its height.
      if (distance <= BERM_START) return 0;
      const relief = reliefAt(this.terrain, x, z);
      height = distance >= reach ? relief : relief * smoothstep(RELIEF_START, reach, distance);
      if (distance > BERM_START && distance < reach) {
        // Blend the outward normals of every edge nearly as close as the nearest one: a single nearest-edge normal
        // flips across medial seams (concave corners) and would tear the berm there.
        let nx = 0;
        let nz = 0;
        for (const footprint of this.flat) {
          if (bboxDistance(footprint, x, z) >= distance + NORMAL_SLACK) continue;
          const other = this.neighbour;
          other.distance = distance + NORMAL_SLACK;
          boundaryNearest(footprint, x, z, other);
          if (other.distance >= distance + NORMAL_SLACK || other.distance < 1e-6) continue;
          const weight = Math.exp(-(other.distance - distance) * NORMAL_SHARPNESS) / other.distance;
          nx += (x - other.x) * weight;
          nz += (z - other.z) * weight;
        }
        const normalLength = Math.hypot(nx, nz) || 1;
        height += bermAt(this.terrain, x, z, distance, nx / normalLength, nz / normalLength);
      }
      if (height > this.terrain.maxMound) height = this.terrain.maxMound;
      if (this.terrain.backdrop) height += this.terrain.backdrop(x, z);
      // Embankments: each raised footprint (walkable or summit) holds its edge height across the shoulder, then falls into the
      // ground above. The nearest-point projection onto a convex footprint is continuous, so the d⁻⁴-weighted blend of
      // footprints is too, and a footprint's own edge (d = 0) dominates completely.
      const face = this.terrain.embankment;
      ownedDistance = distance;
      let weightSum = 0;
      let heightSum = 0;
      for (let index = 0; index < walkableRaised + this.summits.length; index++) {
        const footprint = index < walkableRaised ? this.raised[index]! : this.summits[index - walkableRaised]!;
        if (bboxDistance(footprint, x, z) >= EMBANKMENT_REACH) continue;
        boundaryNearestHeight(footprint, x, z, this.edge);
        const edgeDistance = this.edge.distance;
        if (edgeDistance >= EMBANKMENT_REACH) continue;
        if (index < walkableRaised && edgeDistance < ownedDistance) ownedDistance = edgeDistance;
        const edgeHeight = this.edge.height;
        const sigma = face.slopeMin + (face.slopeMax - face.slopeMin) * valueNoise(x * 0.31, z * 0.31, FACE_SEED);
        const run = Math.min(face.maxRun, Math.max(face.minRun, (1.5 * Math.abs(edgeHeight - height)) / sigma));
        const t = clamp01((edgeDistance - EMBANKMENT_SHOULDER) / run);
        const eased = t * t * (3 - 2 * t);
        const rock = t > 0 && t < 1 ? fbm(x * 1.7, z * 1.7, ROCK_SEED, 2) * face.rock * 4 * t * (1 - t) : 0;
        const weight = 1 / (edgeDistance * edgeDistance * edgeDistance * edgeDistance + 1e-6);
        weightSum += weight;
        heightSum += weight * (edgeHeight + (height - edgeHeight) * eased + rock);
      }
      if (weightSum > 0) height = heightSum / weightSum;
    }
    // The carve fades in with distance from a walkable (the profile's crestStart…crestEnd): never inside the shoulder when it cuts a cliff,
    // so the crest rolls over instead of a flat top ending in a hard corner.
    const carve = this.carve;
    const carved = carve.surfaceHeight(x, z);
    if (carved < height + carve.lipSmooth) {
      const protect = smoothstep(carve.crestStart, carve.crestEnd, ownedDistance);
      height += (smoothMin(height, carved, carve.lipSmooth) - height) * protect;
      const membership = carve.membership(x, z);
      if (membership > 0) height += (valueNoise(x * 2.3, z * 2.3, BED_SEED) - 0.5) * carve.bedNoise * membership * protect;
    }
    return height;
  }

  /** Height of the rendered mesh (same triangulation as {@link buildTerrainMeshData}). */
  sample(x: number, z: number): number {
    const cellsX = this.cols - 1;
    const cellsZ = this.rows - 1;
    const gx = Math.max(0, Math.min(cellsX - 1e-6, (x - this.gridMinX) / this.cell));
    const gz = Math.max(0, Math.min(cellsZ - 1e-6, (z - this.gridMinZ) / this.cell));
    const col = Math.floor(gx);
    const row = Math.floor(gz);
    const block = this.refineIndex[row * cellsX + col]!;
    if (block >= 0) {
      const side = TERRAIN_REFINE + 1;
      const sx = (gx - col) * TERRAIN_REFINE;
      const sz = (gz - row) * TERRAIN_REFINE;
      const u = Math.min(TERRAIN_REFINE - 1, Math.floor(sx));
      const v = Math.min(TERRAIN_REFINE - 1, Math.floor(sz));
      const base = block * side * side + v * side + u;
      return triangleHeight(this.fineHeights[base]!, this.fineHeights[base + 1]!, this.fineHeights[base + side]!, this.fineHeights[base + side + 1]!, sx - u, sz - v);
    }
    const i00 = row * this.cols + col;
    return triangleHeight(this.heights[i00]!, this.heights[i00 + 1]!, this.heights[i00 + this.cols]!, this.heights[i00 + this.cols + 1]!, gx - col, gz - row);
  }
}

/** Height at (fx, fz) inside a cell split along its (1,0)–(0,1) diagonal. */
function triangleHeight(h00: number, h10: number, h01: number, h11: number, fx: number, fz: number): number {
  if (fx + fz <= 1) return h00 + fx * (h10 - h00) + fz * (h01 - h00);
  return h11 + (1 - fx) * (h01 - h11) + (1 - fz) * (h10 - h11);
}

export interface TerrainMeshData {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
}

/**
 * Terrain mesh: the 1 m grid, with refined cells replaced by 0.25 m quads. Unrefined cells that touch a refined
 * neighbour re-triangulate their coarse triangles through that neighbour's boundary vertices (same plane, so no
 * geometry change, but no T-junctions). Quads split along the (col+1,row)–(col,row+1) diagonal everywhere, so
 * {@link TerrainField.sample} matches the rendered surface. Normals are area-weighted face normals.
 */
export function buildTerrainMeshData(field: TerrainField): TerrainMeshData {
  const { cols, rows, cell, heights, refineIndex } = field;
  const cellsX = cols - 1;
  const cellsZ = rows - 1;
  const F = TERRAIN_REFINE;
  const side = F + 1;
  const fineColumns = cellsX * F + 1;
  const fineRows = cellsZ * F + 1;
  const px: number[] = [];
  const py: number[] = [];
  const pz: number[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      px.push(field.gridMinX + col * cell);
      py.push(heights[row * cols + col]!);
      pz.push(field.gridMinZ + row * cell);
    }
  }
  // Global lattice of fine boundary/interior vertices; lattice corners alias the coarse vertices.
  const fineId = new Int32Array(fineColumns * fineRows).fill(-1);
  const vertexAt = (gx: number, gz: number): number => {
    if (gx % F === 0 && gz % F === 0) return (gz / F) * cols + gx / F;
    return fineId[gz * fineColumns + gx]!;
  };
  const indices: number[] = [];
  for (let row = 0; row < cellsZ; row++) {
    for (let col = 0; col < cellsX; col++) {
      const block = refineIndex[row * cellsX + col]!;
      if (block < 0) continue;
      for (let v = 0; v <= F; v++) {
        for (let u = 0; u <= F; u++) {
          const gx = col * F + u;
          const gz = row * F + v;
          if (vertexAt(gx, gz) >= 0) continue;
          fineId[gz * fineColumns + gx] = px.length;
          px.push(field.gridMinX + gx * (cell / F));
          py.push(field.fineHeights[block * side * side + v * side + u]!);
          pz.push(field.gridMinZ + gz * (cell / F));
        }
      }
      for (let v = 0; v < F; v++) {
        for (let u = 0; u < F; u++) {
          const a = vertexAt(col * F + u, row * F + v);
          const b = vertexAt(col * F + u + 1, row * F + v);
          const c = vertexAt(col * F + u, row * F + v + 1);
          const d = vertexAt(col * F + u + 1, row * F + v + 1);
          indices.push(a, c, b, b, c, d);
        }
      }
    }
  }
  const isRefined = (col: number, row: number): boolean => col >= 0 && row >= 0 && col < cellsX && row < cellsZ && refineIndex[row * cellsX + col]! >= 0;
  const ring: number[] = [];
  for (let row = 0; row < cellsZ; row++) {
    for (let col = 0; col < cellsX; col++) {
      if (refineIndex[row * cellsX + col]! >= 0) continue;
      const v00 = row * cols + col;
      const v10 = v00 + 1;
      const v01 = v00 + cols;
      const v11 = v01 + 1;
      const left = isRefined(col - 1, row);
      const back = isRefined(col, row - 1);
      const right = isRefined(col + 1, row);
      const front = isRefined(col, row + 1);
      if (!left && !back && !right && !front) {
        indices.push(v00, v01, v10, v10, v01, v11);
        continue;
      }
      // T1 = (v00, v01, v10): left side then back side. T2 = (v10, v01, v11): front side then right side.
      ring.length = 0;
      ring.push(v00);
      if (left) for (let k = 1; k < F; k++) ring.push(vertexAt(col * F, row * F + k));
      ring.push(v01, v10);
      if (back) for (let k = F - 1; k >= 1; k--) ring.push(vertexAt(col * F + k, row * F));
      earClip(ring, px, pz, indices);
      ring.length = 0;
      ring.push(v10, v01);
      if (front) for (let k = 1; k < F; k++) ring.push(vertexAt(col * F + k, (row + 1) * F));
      ring.push(v11);
      if (right) for (let k = F - 1; k >= 1; k--) ring.push(vertexAt((col + 1) * F, row * F + k));
      earClip(ring, px, pz, indices);
    }
  }
  const count = px.length;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  for (let index = 0; index < count; index++) {
    positions[index * 3] = px[index]!;
    positions[index * 3 + 1] = py[index]!;
    positions[index * 3 + 2] = pz[index]!;
  }
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const e1x = positions[b]! - positions[a]!;
    const e1y = positions[b + 1]! - positions[a + 1]!;
    const e1z = positions[b + 2]! - positions[a + 2]!;
    const e2x = positions[c]! - positions[a]!;
    const e2y = positions[c + 1]! - positions[a + 1]!;
    const e2z = positions[c + 2]! - positions[a + 2]!;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    normals[a] = normals[a]! + nx;
    normals[a + 1] = normals[a + 1]! + ny;
    normals[a + 2] = normals[a + 2]! + nz;
    normals[b] = normals[b]! + nx;
    normals[b + 1] = normals[b + 1]! + ny;
    normals[b + 2] = normals[b + 2]! + nz;
    normals[c] = normals[c]! + nx;
    normals[c + 1] = normals[c + 1]! + ny;
    normals[c + 2] = normals[c + 2]! + nz;
  }
  for (let index = 0; index < count; index++) {
    const o = index * 3;
    const length = Math.hypot(normals[o]!, normals[o + 1]!, normals[o + 2]!) || 1;
    normals[o] = normals[o]! / length;
    normals[o + 1] = normals[o + 1]! / length;
    normals[o + 2] = normals[o + 2]! / length;
  }
  return { positions, normals, indices: Uint32Array.from(indices) };
}

/** True when the segment from the ring vertex before `index` to the one after it passes through another ring vertex. */
function bridgesVertex(polygon: readonly number[], index: number, px: readonly number[], pz: readonly number[]): boolean {
  const previous = polygon[(index + polygon.length - 1) % polygon.length]!;
  const next = polygon[(index + 1) % polygon.length]!;
  const dx = px[next]! - px[previous]!;
  const dz = pz[next]! - pz[previous]!;
  const lengthSquared = dx * dx + dz * dz;
  for (let other = 0; other < polygon.length; other++) {
    const vertex = polygon[other]!;
    if (vertex === previous || vertex === next || other === index) continue;
    const wx = px[vertex]! - px[previous]!;
    const wz = pz[vertex]! - pz[previous]!;
    const along = (wx * dx + wz * dz) / lengthSquared;
    if (along > 1e-6 && along < 1 - 1e-6 && Math.abs(wx * dz - wz * dx) < 1e-7) return true;
  }
  return false;
}

/**
 * Triangulates a convex polygon (possibly with collinear boundary points) whose vertices wind like the terrain
 * triangles (negative signed area in the x/z plane). Collinear vertices are never ears, and an ear is rejected when
 * its closing edge would run through another ring vertex (that would recreate the T-junction being removed).
 */
function earClip(polygon: number[], px: readonly number[], pz: readonly number[], out: number[]): void {
  while (polygon.length > 3) {
    let clipped = false;
    for (let index = 0; index < polygon.length; index++) {
      const previous = polygon[(index + polygon.length - 1) % polygon.length]!;
      const current = polygon[index]!;
      const next = polygon[(index + 1) % polygon.length]!;
      const cross = (px[current]! - px[previous]!) * (pz[next]! - pz[current]!) - (pz[current]! - pz[previous]!) * (px[next]! - px[current]!);
      if (cross >= -1e-9 || bridgesVertex(polygon, index, px, pz)) continue;
      out.push(previous, current, next);
      polygon.splice(index, 1);
      clipped = true;
      break;
    }
    if (!clipped) return;
  }
  if (polygon.length === 3) out.push(polygon[0]!, polygon[1]!, polygon[2]!);
}
