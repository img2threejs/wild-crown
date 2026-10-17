import type { Vec3 } from '../../game/contracts.js';
import { flat, ngon, ramp, type NavNode, type NavRibbon, type WalkSurface } from './layout-kit.js';
import { v } from './schema.js';

const EPSILON = 1e-8;
const ROAD_WIDTH = 6;
const MAX_SLOPE = 0.32;

function side(a: Vec3, b: Vec3, p: Vec3): number {
  return (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x);
}

/** Clip a convex authored floor against one half-plane; all resulting vertices keep its absolute floor height. */
function clip(points: readonly Vec3[], a: Vec3, b: Vec3, inside: boolean): Vec3[] {
  const result: Vec3[] = [];
  for (let index = 0; index < points.length; index++) {
    const p = points[index]!, q = points[(index + 1) % points.length]!;
    const dp = side(a, b, p), dq = side(a, b, q);
    const pInside = inside ? dp >= -EPSILON : dp <= EPSILON;
    const qInside = inside ? dq >= -EPSILON : dq <= EPSILON;
    if (pInside) result.push(p);
    if (pInside !== qInside) {
      const t = dp / (dp - dq);
      result.push(v(p.x + (q.x - p.x) * t, p.y, p.z + (q.z - p.z) * t));
    }
  }
  return result.filter((point, index) => {
    const previous = result[(index + result.length - 1) % result.length]!;
    return Math.hypot(point.x - previous.x, point.z - previous.z) > EPSILON;
  });
}

function area(points: readonly Vec3[]): number {
  let twice = 0;
  for (let index = 0; index < points.length; index++) {
    const a = points[index]!, b = points[(index + 1) % points.length]!;
    twice += a.x * b.z - b.x * a.z;
  }
  return Math.abs(twice) / 2;
}

/** Convex difference, partitioned into convex pieces so the existing polygon-fan terrain remains exact. */
function subtract(points: readonly Vec3[], road: readonly Vec3[]): readonly Vec3[][] {
  let remaining = [...points];
  const outside: Vec3[][] = [];
  for (let index = 0; index < road.length && remaining.length >= 3; index++) {
    const a = road[index]!, b = road[(index + 1) % road.length]!;
    const piece = clip(remaining, a, b, false);
    if (piece.length >= 3 && area(piece) > EPSILON) outside.push(piece);
    remaining = clip(remaining, a, b, true);
  }
  return outside;
}

function quad(from: Vec3, to: Vec3, nx: number, nz: number): Vec3[] {
  return [v(from.x + nx, from.y, from.z + nz), v(from.x - nx, from.y, from.z - nz),
    v(to.x - nx, to.y, to.z - nz), v(to.x + nx, to.y, to.z + nz)];
}

/** Roads replace intersecting plateau pieces, rather than passing invisibly through a higher platform's solid slab. */
export function buildLaterWalkways(regionId: string, floors: readonly WalkSurface[], nodes: readonly NavNode[]): {
  readonly walks: readonly WalkSurface[];
  readonly ribbons: readonly NavRibbon[];
} {
  const roads: WalkSurface[] = [], cuts: Vec3[][] = [], ribbons: NavRibbon[] = [];
  const visited = new Set<string>();
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const node of nodes) for (const targetId of node.links) {
    const target = byId.get(targetId);
    if (!target) throw new Error(`${regionId}: missing walk destination ${targetId}`);
    const key = [node.id, target.id].sort().join('--');
    if (visited.has(key)) continue;
    visited.add(key);
    const from = node.position, to = target.position;
    const dx = to.x - from.x, dz = to.z - from.z, length = Math.hypot(dx, dz);
    if (length < EPSILON) continue;
    const ux = dx / length, uz = dz / length, nx = -uz * ROAD_WIDTH / 2, nz = ux * ROAD_WIDTH / 2;
    const id = `${regionId}-walk-${key}`, material = `${regionId}-trail`;
    const footprint = quad(from, to, nx, nz);
    ribbons.push({ id, points: [from, to], width: ROAD_WIDTH, depthBand: regionId === 'heartroot-hollow' ? 'underground' : 'ground' });
    if (Math.abs(from.y - to.y) < EPSILON) {
      roads.push(flat(id, 'plane', material, 0.8, footprint));
      continue;
    }
    const pad = Math.min(6, (length - Math.abs(to.y - from.y) / MAX_SLOPE) / 2);
    if (pad < 1.5) throw new Error(`${id}: insufficient length for a supported ramp and landings`);
    const first = v(from.x + ux * pad, from.y, from.z + uz * pad);
    const last = v(to.x - ux * pad, to.y, to.z - uz * pad);
    cuts.push(footprint);
    roads.push(flat(id + '-from', 'plane', material, 0.8, quad(from, first, nx, nz)),
      ramp(id + '-ramp', material, 0.8, quad(first, last, nx, nz)),
      flat(id + '-to', 'plane', material, 0.8, quad(last, to, nx, nz)));
  }
  const walks: WalkSurface[] = [];
  for (const floor of floors) {
    let pieces: readonly Vec3[][] = [[...floor.surface.points]];
    for (const cut of cuts) pieces = pieces.flatMap(piece => subtract(piece, cut));
    pieces.forEach((points, index) => walks.push(flat(index === 0 ? floor.surface.id : `${floor.surface.id}-rim-${index}`,
      floor.surface.profile, floor.surface.material, floor.surface.thickness ?? 0.8, points)));
  }
  for (const node of nodes) {
    const pad = ngon(node.position.x, node.position.z, 1.5, 12).map(point => v(point.x, node.position.y, point.z));
    walks.push(flat(`${regionId}-landing-${node.id}`, 'plane', `${regionId}-trail`, 0.8, pad));
  }
  return { walks: [...walks, ...roads], ribbons };
}
