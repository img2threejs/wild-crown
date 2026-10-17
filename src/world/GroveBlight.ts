import { clamp01, hash3, mulberry32, smoothstep, valueNoise } from './GroundNoise';
import { MEMORY_POOL, waterMargin } from './GrovePond';

/**
 * Pure layout of the Black Sap in the Grove (no three.js): where the sap has reached, and the set dressing that says so. The blight starts
 * at the first gate (z -38), is dense in the stage-2 hollow, creeps up the gated spur and is total round the Memory Pool, where it
 * comes from. The same field drives the ground (sap mud), the grass (wilted and black), the lush clutter and boundary ferns / trees that
 * are withheld inside it, and every merged blight mesh (GroveBlightDressing), so the stages read as one spreading infection.
 */
export const HOLLOW_CENTRE = { x: -24, z: -56 } as const;
export const ARENA_CENTRE = { x: -24, z: -96 } as const;
/** Walkable radius of the Memory Pool clearing (the fight arena has radius 11 inside it) and the radius of its ring of ancient stones. */
export const ARENA_WALK_RADIUS = 13.5;
export const STONE_RING_RADIUS = 16.4;
/** Camera-facing direction on the ground (the locked three-quarter camera sits at +x, +z of its target). */
const CAMERA_X = 0.5812;
const CAMERA_Z = 0.8137;
const SEED = 6113;

const segmentDistance = (x: number, z: number, ax: number, az: number, bx: number, bz: number): number => {
  const dx = bx - ax, dz = bz - az;
  const t = clamp01(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz));
  return Math.hypot(x - (ax + dx * t), z - (az + dz * t));
};

/** Blight strength 0..1 at a ground point: ragged-edged patches, zero south of the first gate and away from the north of the map. */
export function blightAt(x: number, z: number): number {
  const hollow = 1 - smoothstep(9, 22, Math.hypot(x - HOLLOW_CENTRE.x, z - HOLLOW_CENTRE.z));
  const spur = 0.7 * (1 - smoothstep(5, 15, segmentDistance(x, z, HOLLOW_CENTRE.x, HOLLOW_CENTRE.z - 9, ARENA_CENTRE.x, ARENA_CENTRE.z + 13)));
  const arena = 1 - smoothstep(15, 34, Math.hypot(x - ARENA_CENTRE.x, z - ARENA_CENTRE.z));
  const pool = 1 - smoothstep(4, 15, Math.hypot((x - MEMORY_POOL.x) / MEMORY_POOL.radiusX, (z - MEMORY_POOL.z) / MEMORY_POOL.radiusZ) * 6);
  const base = Math.max(hollow, spur, arena, pool);
  if (base <= 0.001) return 0;
  const grain = valueNoise(x * 0.23, z * 0.23, SEED) * 0.65 + valueNoise(x * 0.8 + 4, z * 0.8 + 4, SEED + 3) * 0.35;
  return smoothstep(0.1, 0.85, base + (grain - 0.5) * 0.5);
}

/** Share of the ground that is soaked, dark sap mud (the splat mud layer): ragged patches inside the blight, none outside it. */
export function sapMudAt(x: number, z: number): number {
  const blight = blightAt(x, z);
  if (blight <= 0.001) return 0;
  const patches = valueNoise(x * 0.17 + 9, z * 0.17 + 9, SEED + 7) * 0.7 + valueNoise(x * 0.55, z * 0.55, SEED + 11) * 0.3;
  return smoothstep(0.38, 0.62, patches + (blight - 0.5) * 0.5) * smoothstep(0.25, 0.6, blight);
}

/** Sickly ground grade (linear RGB multiplier) at a point: ochre round the hollow, bruised violet towards the Memory Pool. */
export function blightGrade(z: number): readonly [number, number, number] {
  const t = smoothstep(-64, -88, z);
  return [0.95 - 0.12 * t, 0.86 - 0.08 * t, 0.62 + 0.16 * t];
}

export interface StonePlan {
  readonly x: number;
  readonly z: number;
  readonly height: number;
  /** Half extents of the footprint along the stone's own axes (metres). */
  readonly halfWidth: number;
  readonly halfDepth: number;
  readonly yaw: number;
  readonly leanX: number;
  readonly leanZ: number;
  readonly seed: number;
}

export interface RootPlan {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly length: number;
  readonly height: number;
  readonly radius: number;
  readonly seed: number;
}

export interface BranchPlan {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly height: number;
  readonly seed: number;
}

export interface VeinPlan {
  /** Ground points (x, z) of the vein's centreline, wide end first. */
  readonly points: readonly (readonly [number, number])[];
  readonly width: number;
}

export interface PuddlePlan {
  readonly x: number;
  readonly z: number;
  readonly sizeX: number;
  readonly sizeZ: number;
  readonly yaw: number;
}

export interface BlightPlan {
  readonly stones: readonly StonePlan[];
  readonly roots: readonly RootPlan[];
  readonly trees: readonly BranchPlan[];
  readonly shrubs: readonly BranchPlan[];
  readonly veins: readonly VeinPlan[];
  readonly puddles: readonly PuddlePlan[];
}

export interface Obstacle { readonly x: number; readonly z: number; readonly radius: number }
export interface BlightField {
  /** Horizontal distance (capped at `limit`) to the nearest walkable surface. */
  walkDistance(x: number, z: number, limit: number): number;
}

/** 1 where a point's outward direction faces the gameplay camera: dressing standing there must stay low. */
const facing = (nx: number, nz: number): number => nx * CAMERA_X + nz * CAMERA_Z;
const wrap = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));

/** Standing stones of the Memory Pool's ring: tall behind the arena, knee-high towards the camera, open to the south entrance, the east trail and the pool. */
function ringStones(): StonePlan[] {
  const random = mulberry32(SEED + 21);
  const stones: StonePlan[] = [];
  const count = 22;
  for (let index = 0; index < count; index++) {
    const angle = (index / count) * Math.PI * 2 + (random() - 0.5) * 0.08;
    const radius = STONE_RING_RADIUS + (random() - 0.5) * 1.2;
    const x = ARENA_CENTRE.x + Math.cos(angle) * radius, z = ARENA_CENTRE.z + Math.sin(angle) * radius;
    // The south entrance (the spur), the Ridge Trail to the east and the water's edge stay open.
    if (Math.abs(wrap(angle - Math.PI / 2)) < 0.34 || Math.abs(wrap(angle)) < 0.3 || waterMargin(x, z) < 3.2) continue;
    const toward = clamp01((facing(Math.cos(angle), Math.sin(angle)) + 0.25) / 0.8);
    const broken = random() < 0.25;
    const tall = 3.4 + random() * 1.9;
    const height = (tall * (1 - smoothstep(0, 1, toward)) + (0.7 + random() * 0.5) * smoothstep(0, 1, toward)) * (broken ? 0.55 : 1);
    stones.push({
      x, z, height, halfWidth: 0.55 + random() * 0.45, halfDepth: 0.4 + random() * 0.3, yaw: angle + Math.PI / 2 + (random() - 0.5) * 0.4,
      leanX: (random() - 0.5) * 0.16, leanZ: (random() - 0.5) * 0.16, seed: index,
    });
    // A fallen slab or a low wall segment in the gap to the next stone.
    if (random() < 0.55) {
      const mid = angle + Math.PI / count;
      const mx = ARENA_CENTRE.x + Math.cos(mid) * (STONE_RING_RADIUS - 0.2), mz = ARENA_CENTRE.z + Math.sin(mid) * (STONE_RING_RADIUS - 0.2);
      if (Math.abs(wrap(mid - Math.PI / 2)) >= 0.4 && Math.abs(wrap(mid)) >= 0.36 && waterMargin(mx, mz) >= 3.2) {
        stones.push({ x: mx, z: mz, height: 0.5 + random() * 0.5, halfWidth: 1.0 + random() * 0.6, halfDepth: 0.38, yaw: mid + Math.PI / 2, leanX: 0, leanZ: (random() - 0.5) * 0.1, seed: 100 + index });
      }
    }
  }
  return stones;
}

/** Sap-crusted roots arching over the rims of the hollow and the arena. */
function rimRoots(): RootPlan[] {
  const random = mulberry32(SEED + 33);
  const roots: RootPlan[] = [];
  const rims = [
    { cx: HOLLOW_CENTRE.x, cz: HOLLOW_CENTRE.z, radius: 12.3, count: 12, gaps: [Math.PI / 2, -Math.PI / 2] },
    { cx: ARENA_CENTRE.x, cz: ARENA_CENTRE.z, radius: 15, count: 16, gaps: [Math.PI / 2, 0] },
  ] as const;
  for (const rim of rims) {
    for (let index = 0; index < rim.count; index++) {
      const angle = (index / rim.count) * Math.PI * 2 + (random() - 0.5) * 0.3;
      if (rim.gaps.some(gap => Math.abs(wrap(angle - gap)) < 0.42)) continue;
      const radius = rim.radius + (random() - 0.5) * 1.4;
      const x = rim.cx + Math.cos(angle) * radius, z = rim.cz + Math.sin(angle) * radius;
      if (waterMargin(x, z) < 2.5) continue;
      const toward = clamp01((facing(Math.cos(angle), Math.sin(angle)) + 0.2) / 0.7);
      roots.push({ x, z, yaw: angle + Math.PI / 2 + (random() - 0.5) * 0.7, length: 3 + random() * 2.4, height: (0.9 + random() * 1.1) * (1 - 0.65 * toward), radius: 0.1 + random() * 0.08, seed: roots.length });
    }
  }
  return roots;
}

/** Black sap running along the ground: veins from the hollow up the spur to the arena, and out of the Memory Pool across the arena floor. */
function sapVeins(): VeinPlan[] {
  const random = mulberry32(SEED + 47);
  const veins: VeinPlan[] = [];
  const meander = (from: readonly [number, number], to: readonly [number, number], steps: number, amplitude: number): [number, number][] => {
    const phase = random() * 6.28;
    const points: [number, number][] = [];
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      const side = Math.sin(t * 5.2 + phase) * amplitude * Math.sin(t * Math.PI);
      const dx = to[0] - from[0], dz = to[1] - from[1], length = Math.hypot(dx, dz);
      points.push([from[0] + dx * t - (dz / length) * side, from[1] + dz * t + (dx / length) * side]);
    }
    return points;
  };
  // Three strands climbing the spur from the hollow to the arena: the sap's road to the pool.
  for (let strand = 0; strand < 3; strand++) {
    const off = (strand - 1) * 1.6;
    veins.push({ points: meander([HOLLOW_CENTRE.x + off, HOLLOW_CENTRE.z - 6], [ARENA_CENTRE.x + off * 1.4, ARENA_CENTRE.z + 12], 26, 1.8), width: 0.55 - strand * 0.08 });
  }
  // A thin tendril creeping back towards the first gate.
  veins.push({ points: meander([HOLLOW_CENTRE.x + 0.8, HOLLOW_CENTRE.z + 2], [HOLLOW_CENTRE.x - 1.2, HOLLOW_CENTRE.z + 14], 12, 1.0), width: 0.34 });
  // Radials round the hollow centre (the blighted rootling's seep) and out of the pool's south bank (the Memory Pool's source).
  for (let radial = 0; radial < 7; radial++) {
    const angle = (radial / 7) * Math.PI * 2 + 0.3;
    const reach = 7 + random() * 4;
    veins.push({ points: meander([HOLLOW_CENTRE.x, HOLLOW_CENTRE.z - 1], [HOLLOW_CENTRE.x + Math.cos(angle) * reach, HOLLOW_CENTRE.z + Math.sin(angle) * reach - 1], 14, 2), width: 0.4 });
  }
  for (let radial = 0; radial < 9; radial++) {
    const angle = Math.PI * (0.1 + 0.8 * (radial / 8));
    const reach = 9 + random() * 4;
    veins.push({ points: meander([MEMORY_POOL.x + (random() - 0.5) * 6, MEMORY_POOL.z + MEMORY_POOL.radiusZ + 1.5], [ARENA_CENTRE.x + Math.cos(angle) * reach, ARENA_CENTRE.z + Math.sin(angle) * reach * 0.9 - 4], 20, 2.4), width: 0.5 });
  }
  return veins;
}

/** Pools of sap lying on the ground (diameter metres): the hollow's seep and the arena floor's south of the pool. */
function sapPuddles(): PuddlePlan[] {
  const list: readonly (readonly [number, number, number, number, number])[] = [
    [-24, -57, 7.5, 6, 0.3], [-29.5, -52, 5, 3.8, 0.9], [-18.5, -61, 5, 3.6, 2.1], [-26, -64, 3.8, 3, 0.4], [-20.5, -51.5, 3.2, 2.6, 1.3], [-32, -58, 3, 2.4, 0.2],
    [-24, -108, 11, 3.6, 0.05], [-31, -104, 6, 4.2, 0.6], [-17, -105, 6, 4.2, 2.6], [-24, -100.5, 4, 3, 0.9], [-29.5, -111.5, 5.5, 3.2, 0.3], [-18.5, -111, 5, 3, 2.9],
  ];
  return list.map(([x, z, sizeX, sizeZ, yaw]) => ({ x, z, sizeX, sizeZ, yaw }));
}

/**
 * Everything the blight adds to the map. Trees stand only behind the walkables' camera-averted edges, shrubs everywhere the blight
 * reaches, off the routes and arenas; both keep off every authored obstacle. Deterministic.
 */
export function planBlight(field: BlightField, obstacles: readonly Obstacle[]): BlightPlan {
  const blocked = (x: number, z: number, margin: number): boolean => obstacles.some(obstacle => Math.hypot(x - obstacle.x, z - obstacle.z) < obstacle.radius + margin);
  /** Ground the fights and the routes use stays free of dressing. */
  const reserved = (x: number, z: number): boolean =>
    Math.hypot(x - HOLLOW_CENTRE.x, z - HOLLOW_CENTRE.z) < 9.4 || Math.hypot(x - ARENA_CENTRE.x, z - ARENA_CENTRE.z) < 12.2
    || (Math.abs(x - ARENA_CENTRE.x) < 3.6 && z > ARENA_CENTRE.z + 11 && z < HOLLOW_CENTRE.z - 8) || (Math.abs(z - ARENA_CENTRE.z) < 3.6 && x > ARENA_CENTRE.x + 11);
  const stones = ringStones();
  const stoneCircles = stones.map(stone => ({ x: stone.x, z: stone.z, radius: Math.max(stone.halfWidth, stone.halfDepth) + 0.3 }));
  const outwardFacing = (x: number, z: number): number => {
    const gx = field.walkDistance(x + 1.5, z, 30) - field.walkDistance(x - 1.5, z, 30), gz = field.walkDistance(x, z + 1.5, 30) - field.walkDistance(x, z - 1.5, 30);
    const length = Math.hypot(gx, gz);
    return length < 1e-6 ? 0 : facing(gx / length, gz / length);
  };

  const trees: BranchPlan[] = [];
  const treeCell = 5.5;
  for (let cz = -142; cz < -36; cz += treeCell) {
    for (let cx = -60; cx < 8; cx += treeCell) {
      const i = Math.round(cx / treeCell), j = Math.round(cz / treeCell);
      const x = cx + hash3(i, j, 1, SEED) * treeCell, z = cz + hash3(i, j, 2, SEED) * treeCell;
      if (hash3(i, j, 3, SEED) < 0.2 || blightAt(x, z) < 0.25) continue;
      const distance = field.walkDistance(x, z, 30);
      if (distance < 2.8 || distance > 24 || blocked(x, z, 1.8) || stoneCircles.some(c => Math.hypot(x - c.x, z - c.z) < c.radius + 1.2) || waterMargin(x, z) < 3) continue;
      if (outwardFacing(x, z) > 0.28 || trees.some(other => Math.hypot(x - other.x, z - other.z) < 4.4)) continue;
      trees.push({ x, z, yaw: hash3(i, j, 4, SEED) * Math.PI * 2, height: 3.8 + hash3(i, j, 5, SEED) * 3.2, seed: trees.length });
    }
  }

  const shrubs: BranchPlan[] = [];
  const shrubCell = 2.3;
  for (let cz = -135; cz < -36; cz += shrubCell) {
    for (let cx = -56; cx < 6; cx += shrubCell) {
      const i = Math.round(cx / shrubCell), j = Math.round(cz / shrubCell);
      const x = cx + hash3(i, j, 11, SEED) * shrubCell, z = cz + hash3(i, j, 12, SEED) * shrubCell;
      const blight = blightAt(x, z);
      if (blight < 0.3 || hash3(i, j, 13, SEED) > 0.35 + 0.4 * blight) continue;
      const distance = field.walkDistance(x, z, 6);
      if (reserved(x, z) || blocked(x, z, 0.5) || stoneCircles.some(c => Math.hypot(x - c.x, z - c.z) < c.radius + 0.4) || waterMargin(x, z) < 1.6) continue;
      // Beside the routes' spurs the walkable is narrow: shrubs need the berm, not the path.
      if (distance < 0.5 && Math.hypot(x - HOLLOW_CENTRE.x, z - HOLLOW_CENTRE.z) > 10 && Math.hypot(x - ARENA_CENTRE.x, z - ARENA_CENTRE.z) > 13.2) continue;
      const toward = distance < 8 ? clamp01((outwardFacing(x, z) + 0.1) / 0.6) : 0;
      shrubs.push({ x, z, yaw: hash3(i, j, 14, SEED) * Math.PI * 2, height: (0.7 + hash3(i, j, 15, SEED) * 0.8) * (1 - 0.45 * toward), seed: shrubs.length });
    }
  }
  return { stones, roots: rimRoots(), trees, shrubs, veins: sapVeins(), puddles: sapPuddles() };
}

/** Plan-view circles the ring's stones occupy (keeps the boundary ferns, rocks and trees off them). */
export function stoneFootprints(): readonly Obstacle[] {
  return ringStones().map(stone => ({ x: stone.x, z: stone.z, radius: Math.max(stone.halfWidth, stone.halfDepth) + 0.5 }));
}
