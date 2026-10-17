import { Matrix4, Vector3, type BufferGeometry } from 'three';
import { SUPPORT_EMPTY_BOTTOM, SUPPORT_EMPTY_TOP, type SupportField } from '../game/combat/geometry.js';

/** One native mesh with the matrix that carries its vertices into world space. */
export interface SupportSource {
  readonly geometry: BufferGeometry;
  readonly matrix: Matrix4;
}

/** Cell size (m): fine enough that a deck's measured ends are within about 6 cm of the model's real ends. */
export const SUPPORT_CELL = 0.125;
/** A triangle whose world normal points at least this far upward can be stood on (about 32 degrees of slope). */
const STAND_NORMAL_Y = 0.85;
/** A triangle whose world normal points this far downward is an underside. */
const UNDERSIDE_NORMAL_Y = -0.2;
/** Up-facing triangles within this height of the dominant deck level are the deck surface. */
const DECK_BAND = 0.2;
const DECK_LEVEL_BIN = 0.05;
/** Geometry in this height range above a deck cell stands in the capsule's way, so the cell cannot be stood on. */
const HEADROOM_FROM = 0.3;
const HEADROOM_TO = 1.6;
/** Under-deck search for the slab's own underside; a deck without a measurable underside is treated as a thin slab. */
const DECK_UNDERSIDE_SEARCH = 0.8;
const THIN_DECK = 0.15;
/** Largest gap (in cells, 0.5 m) between measured deck cells that is bridged rather than left as a hole: a plank or log gap. */
const DECK_FILL_SPAN = 4;
const DECK_FILL_PASSES = 4;
const DECK_SMOOTH_PASSES = 3;
/** A rough prop top is averaged over this many passes with neighbours within this height (m) of the cell, and stood on where its slope is below the limit. */
const TOP_SMOOTH_PASSES = 5;
const TOP_SMOOTH_RANGE = 0.3;
const TOP_STAND_SLOPE = 0.65;
/** Guard against a prop whose footprint would rasterise to an absurd grid. */
const MAX_CELLS = 400_000;

interface CellHits { y: number[]; kind: number[] }
const UP = 1, DOWN = -1, SIDE = 0;

const a = new Vector3(), b = new Vector3(), c = new Vector3(), e1 = new Vector3(), e2 = new Vector3();

/**
 * Measures the standable top of a native prop by rasterising its world-space triangles onto a fixed XZ grid (cells aligned to
 * multiples of {@link SUPPORT_CELL}, sampled at the cell centre). A 'deck' keeps only its dominant walking level (rails and
 * posts are not supports) and a thin slab below it, so the space under a bridge stays open; a 'top' is a solid column from
 * its underside to its highest surface. A cell is standable only where its top triangle faces up and nothing stands in the
 * capsule's headroom above it. Returns null when no geometry was measured.
 */
export function measureSupportField(id: string, ownerId: string, kind: SupportField['kind'], sources: readonly SupportSource[]): SupportField | null {
  const cell = SUPPORT_CELL;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const { geometry, matrix } of sources) {
    const vertices = geometry.getAttribute('position');
    for (let i = 0; i < vertices.count; i++) {
      a.fromBufferAttribute(vertices, i).applyMatrix4(matrix);
      if (a.x < minX) minX = a.x; if (a.x > maxX) maxX = a.x;
      if (a.z < minZ) minZ = a.z; if (a.z > maxZ) maxZ = a.z;
    }
  }
  if (!Number.isFinite(minX)) return null;
  const originX = Math.floor(minX / cell) * cell, originZ = Math.floor(minZ / cell) * cell;
  const cols = Math.max(1, Math.ceil((maxX - originX) / cell)), rows = Math.max(1, Math.ceil((maxZ - originZ) / cell));
  if (cols * rows > MAX_CELLS) return null;

  const hits: (CellHits | undefined)[] = new Array(cols * rows);
  const levelArea = new Map<number, number>();
  for (const { geometry, matrix } of sources) {
    const vertices = geometry.getAttribute('position'), indices = geometry.index;
    const count = indices?.count ?? vertices.count;
    for (let i = 0; i + 2 < count; i += 3) {
      a.fromBufferAttribute(vertices, indices ? indices.getX(i) : i).applyMatrix4(matrix);
      b.fromBufferAttribute(vertices, indices ? indices.getX(i + 1) : i + 1).applyMatrix4(matrix);
      c.fromBufferAttribute(vertices, indices ? indices.getX(i + 2) : i + 2).applyMatrix4(matrix);
      e1.subVectors(b, a); e2.subVectors(c, a);
      const nx = e1.y * e2.z - e1.z * e2.y, ny = e1.z * e2.x - e1.x * e2.z, nz = e1.x * e2.y - e1.y * e2.x;
      const twiceArea = Math.hypot(nx, ny, nz);
      if (twiceArea < 1e-12) continue;
      const facing = ny / twiceArea;
      const kindOf = facing >= STAND_NORMAL_Y ? UP : facing <= UNDERSIDE_NORMAL_Y ? DOWN : SIDE;
      if (kindOf === UP) {
        const level = Math.round((a.y + b.y + c.y) / 3 / DECK_LEVEL_BIN);
        levelArea.set(level, (levelArea.get(level) ?? 0) + twiceArea / 2);
      }
      const denominator = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
      if (Math.abs(denominator) < 1e-12) continue;
      const firstCol = Math.max(0, Math.ceil((Math.min(a.x, b.x, c.x) - originX) / cell - 0.5));
      const lastCol = Math.min(cols - 1, Math.floor((Math.max(a.x, b.x, c.x) - originX) / cell - 0.5));
      const firstRow = Math.max(0, Math.ceil((Math.min(a.z, b.z, c.z) - originZ) / cell - 0.5));
      const lastRow = Math.min(rows - 1, Math.floor((Math.max(a.z, b.z, c.z) - originZ) / cell - 0.5));
      for (let row = firstRow; row <= lastRow; row++) {
        const z = originZ + (row + 0.5) * cell;
        for (let col = firstCol; col <= lastCol; col++) {
          const x = originX + (col + 0.5) * cell;
          const u = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / denominator;
          const v = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / denominator;
          const w = 1 - u - v;
          if (u < -1e-9 || v < -1e-9 || w < -1e-9) continue;
          const index = row * cols + col;
          const cellHits = hits[index] ?? (hits[index] = { y: [], kind: [] });
          cellHits.y.push(u * a.y + v * b.y + w * c.y);
          cellHits.kind.push(kindOf);
        }
      }
    }
  }

  const top = new Array<number>(cols * rows).fill(SUPPORT_EMPTY_TOP);
  const bottom = new Array<number>(cols * rows).fill(SUPPORT_EMPTY_BOTTOM);
  const stand = new Array<number>(cols * rows).fill(0);
  if (kind === 'deck') {
    let level = NaN, best = 0;
    for (const [bin, area] of levelArea) if (area > best || (area === best && bin < level / DECK_LEVEL_BIN)) { best = area; level = bin * DECK_LEVEL_BIN; }
    if (!Number.isFinite(level)) return null;
    // The deck is a connected walking surface: seed it where an up-facing hit lies at the dominant level, then grow it across
    // neighbouring cells along slope-limited hits, so a sagging or rising span is followed and rails and post tops are left out.
    const deckTop = new Array<number>(cols * rows).fill(-Infinity);
    const queue: number[] = [];
    for (let index = 0; index < hits.length; index++) {
      const nearest = nearestUp(hits[index], level, DECK_BAND);
      if (nearest !== null) { deckTop[index] = nearest; queue.push(index); }
    }
    for (let head = 0; head < queue.length; head++) {
      const index = queue[head]!, col = index % cols, row = (index - col) / cols, current = deckTop[index]!;
      for (let n = 0; n < 4; n++) {
        const nc = col + NEIGHBOUR_X[n]!, nr = row + NEIGHBOUR_Z[n]!;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows || deckTop[nr * cols + nc] !== -Infinity) continue;
        const nearest = nearestUp(hits[nr * cols + nc], current, DECK_STEP);
        if (nearest === null) continue;
        deckTop[nr * cols + nc] = nearest;
        queue.push(nr * cols + nc);
      }
    }
    for (let index = 0; index < hits.length; index++) {
      const cellHits = hits[index], surface = deckTop[index]!;
      if (!cellHits || surface === -Infinity) continue;
      let underside = -Infinity, clear = true;
      for (let h = 0; h < cellHits.y.length; h++) {
        const y = cellHits.y[h]!;
        if (cellHits.kind[h] === DOWN && y < surface - 1e-4 && y >= surface - DECK_UNDERSIDE_SEARCH && y > underside) underside = y;
        if (y > surface + HEADROOM_FROM && y < surface + HEADROOM_TO) clear = false;
      }
      top[index] = surface; bottom[index] = underside === -Infinity ? surface - THIN_DECK : underside; stand[index] = clear ? 1 : 0;
    }
    // Repeat until a pass fills nothing: a gap that is only closed along one axis opens the other.
    for (let pass = 0; pass < DECK_FILL_PASSES; pass++) if (!fillDeckHoles(top, bottom, stand, cols, rows)) break;
    // The deck is exactly what was measured: no landing is invented past its last plank (the route is made to meet the real model).
    // Round logs and plank gaps make the raw tops bob by centimetres; the walkway follows the smoothed surface, slab thickness kept.
    for (let pass = 0; pass < DECK_SMOOTH_PASSES; pass++) smoothDeckTops(top, bottom, cols, rows);
  } else {
    const topKind = new Array<number>(cols * rows).fill(SIDE);
    for (let index = 0; index < hits.length; index++) {
      const cellHits = hits[index];
      if (!cellHits) continue;
      let highest = 0;
      for (let h = 1; h < cellHits.y.length; h++) if (cellHits.y[h]! > cellHits.y[highest]!) highest = h;
      const surface = cellHits.y[highest]!;
      let lowest = Infinity;
      for (let h = 0; h < cellHits.y.length; h++) {
        const y = cellHits.y[h]!;
        if (y < lowest) lowest = y;
      }
      top[index] = surface; bottom[index] = lowest; topKind[index] = cellHits.kind[highest]!;
    }
    // A rough prop (Tripo rock) is walked on as its smoothed surface: tops are averaged with neighbours of similar height (cliffs
    // and the prop's edge stay sharp), and a cell is standable where that surface is gentle, not where a single facet is steep.
    for (let pass = 0; pass < TOP_SMOOTH_PASSES; pass++) smoothTops(top, bottom, cols, rows, TOP_SMOOTH_RANGE);
    for (let index = 0; index < top.length; index++) {
      if (top[index]! <= SUPPORT_EMPTY_TOP) continue;
      stand[index] = topKind[index] !== DOWN && slopeAt(top, cols, rows, index) <= TOP_STAND_SLOPE ? 1 : 0;
    }
  }

  let firstCol = cols, lastCol = -1, firstRow = rows, lastRow = -1, lowY = Infinity, highY = -Infinity;
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const index = row * cols + col;
    if (top[index]! <= SUPPORT_EMPTY_TOP) continue;
    if (col < firstCol) firstCol = col; if (col > lastCol) lastCol = col;
    if (row < firstRow) firstRow = row; if (row > lastRow) lastRow = row;
    if (bottom[index]! < lowY) lowY = bottom[index]!; if (top[index]! > highY) highY = top[index]!;
  }
  if (lastCol < 0) return null;
  const croppedCols = lastCol - firstCol + 1, croppedRows = lastRow - firstRow + 1;
  const outTop: number[] = [], outBottom: number[] = [], outStand: number[] = [];
  for (let row = firstRow; row <= lastRow; row++) for (let col = firstCol; col <= lastCol; col++) {
    const index = row * cols + col;
    outTop.push(top[index]!); outBottom.push(bottom[index]!); outStand.push(stand[index]!);
  }
  return { id, ownerId, kind, minX: originX + firstCol * cell, minZ: originZ + firstRow * cell, cell, cols: croppedCols, rows: croppedRows, minY: lowY, maxY: highY, top: outTop, bottom: outBottom, stand: outStand };
}

/**
 * A plank gap or a rope shadow between measured deck cells must not become a hole in the walkway: an empty cell lying in a gap of at
 * most {@link DECK_FILL_SPAN} cells with deck on both sides (along X, else along Z) takes the interpolated slab. Returns whether any
 * cell was filled; the caller repeats until a pass fills nothing, so a gap that is only closed from one axis fills from both.
 */
function fillDeckHoles(top: number[], bottom: number[], stand: number[], cols: number, rows: number): boolean {
  let changed = false;
  const filledTop = top.slice(), filledBottom = bottom.slice(), filledStand = stand.slice();
  const occupied = (index: number) => top[index]! > SUPPORT_EMPTY_TOP;
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const index = row * cols + col;
    if (occupied(index)) continue;
    for (const [dx, dz] of [[1, 0], [0, 1]] as const) {
      let before = -1, after = -1;
      for (let step = 1; step <= DECK_FILL_SPAN && before < 0; step++) { const x = col - dx * step, z = row - dz * step; if (x >= 0 && z >= 0 && occupied(z * cols + x)) before = step; }
      for (let step = 1; step <= DECK_FILL_SPAN && after < 0; step++) { const x = col + dx * step, z = row + dz * step; if (x < cols && z < rows && occupied(z * cols + x)) after = step; }
      if (before < 0 || after < 0 || before + after - 1 > DECK_FILL_SPAN) continue;
      const left = (row - dz * before) * cols + (col - dx * before), right = (row + dz * after) * cols + (col + dx * after);
      const t = before / (before + after);
      filledTop[index] = top[left]! + (top[right]! - top[left]!) * t;
      filledBottom[index] = bottom[left]! + (bottom[right]! - bottom[left]!) * t;
      filledStand[index] = stand[left]! === 1 && stand[right]! === 1 ? 1 : 0;
      changed = true;
      break;
    }
  }
  for (let index = 0; index < top.length; index++) { top[index] = filledTop[index]!; bottom[index] = filledBottom[index]!; stand[index] = filledStand[index]!; }
  return changed;
}

const NEIGHBOUR_X = [1, -1, 0, 0] as const;
const NEIGHBOUR_Z = [0, 0, 1, -1] as const;
/** Largest height change between neighbouring deck cells: the 31 degree stand slope over one cell. */
const DECK_STEP = SUPPORT_CELL * 0.68;

/** The up-facing hit of a cell nearest to `target` and within `tolerance` of it, else null. */
function nearestUp(cellHits: CellHits | undefined, target: number, tolerance: number): number | null {
  if (!cellHits) return null;
  let best: number | null = null;
  for (let h = 0; h < cellHits.y.length; h++) {
    if (cellHits.kind[h] !== UP) continue;
    const error = Math.abs(cellHits.y[h]! - target);
    if (error <= tolerance && (best === null || error < Math.abs(best - target))) best = cellHits.y[h]!;
  }
  return best;
}

/** One 3x3 weighted average (centre 2, neighbours 1) over occupied cells; the slab underside follows its top. */
function smoothDeckTops(top: number[], bottom: number[], cols: number, rows: number): void {
  const smoothed = top.slice();
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const index = row * cols + col;
    if (top[index]! <= SUPPORT_EMPTY_TOP) continue;
    let sum = top[index]! * 2, weight = 2;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const c = col + dx, r = row + dz;
      if ((dx === 0 && dz === 0) || c < 0 || r < 0 || c >= cols || r >= rows || top[r * cols + c]! <= SUPPORT_EMPTY_TOP) continue;
      sum += top[r * cols + c]!; weight++;
    }
    smoothed[index] = sum / weight;
  }
  for (let index = 0; index < top.length; index++) {
    if (top[index]! <= SUPPORT_EMPTY_TOP) continue;
    bottom[index] = bottom[index]! + smoothed[index]! - top[index]!;
    top[index] = smoothed[index]!;
  }
}

/** One 3x3 weighted average (centre 2, neighbours 1) over occupied neighbours within `range` of the cell's height; underside kept below the top. */
function smoothTops(top: number[], bottom: number[], cols: number, rows: number, range: number): void {
  const smoothed = top.slice();
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const index = row * cols + col;
    if (top[index]! <= SUPPORT_EMPTY_TOP) continue;
    let sum = top[index]! * 2, weight = 2;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const c = col + dx, r = row + dz;
      if ((dx === 0 && dz === 0) || c < 0 || r < 0 || c >= cols || r >= rows) continue;
      const neighbour = top[r * cols + c]!;
      if (neighbour <= SUPPORT_EMPTY_TOP || Math.abs(neighbour - top[index]!) > range) continue;
      sum += neighbour; weight++;
    }
    smoothed[index] = sum / weight;
  }
  for (let index = 0; index < top.length; index++) {
    if (top[index]! <= SUPPORT_EMPTY_TOP) continue;
    top[index] = smoothed[index]!;
    if (bottom[index]! > top[index]! - 0.02) bottom[index] = top[index]! - 0.02;
  }
}

/** Gradient magnitude of the top surface at a cell (one-sided where a neighbour is missing; an edge cliff reads as steep). */
function slopeAt(top: number[], cols: number, rows: number, index: number): number {
  const col = index % cols, row = (index - col) / cols, here = top[index]!;
  const height = (c: number, r: number) => (c < 0 || r < 0 || c >= cols || r >= rows || top[r * cols + c]! <= SUPPORT_EMPTY_TOP ? here - 100 : top[r * cols + c]!);
  const east = height(col + 1, row), west = height(col - 1, row), north = height(col, row + 1), south = height(col, row - 1);
  return Math.hypot((east - west) / (2 * SUPPORT_CELL), (north - south) / (2 * SUPPORT_CELL));
}
