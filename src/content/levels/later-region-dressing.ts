import type { RegionDefinition, Vec3, WorldAssetPlacement } from '../../game/contracts.js';
import {
  distanceToPolygon,
  distanceToSegment,
  outwardCameraDot,
  polygonArea,
  TREE_CAMERA_DOT,
  type FootprintCircle,
  type Point,
} from '../../world/GreenwakeBoundary.js';
import { mulberry32 } from '../../world/GroundNoise.js';

/** Native boundary dressing; semantic props remain aligned with their authored interactions. */

/** Boundary placement prefix keyed by region id (decoration only when measured footprints clear walkable). */
export const LATER_REGION_BOUNDARY_ID_PREFIXES: Readonly<Record<string, string>> = {
  'moonpine-ridge': 'moonpine-later-boundary-',
  'mistveil-basin': 'mistveil-later-boundary-',
  'sunmane-expanse': 'sunmane-later-boundary-',
  refuge: 'refuge-later-boundary-',
  'heartroot-hollow': 'hollow-later-boundary-',
};

const LATER_BOUNDARY_CLEARANCE = 0.8;
const CAMERA_FACING = 0.15;
const EDGE_SPACING_LOW = [4.5, 7] as const;
const EDGE_SPACING_TALL = [7, 11] as const;
const ROUTE_VISIBILITY_RANGE = 25;
const TALL_VISIBILITY_RANGE = 40;
const SEEDS: Readonly<Record<string, number>> = {
  'moonpine-ridge': 0x4f10a01,
  'mistveil-basin': 0x5e4b4a02,
  'sunmane-expanse': 0x631ba03,
  refuge: 0x6c1ec04,
  'heartroot-hollow': 0x79a4a05,
};

const MOONPINE_TREE = 'prop-moonpine-tree';
const MOONPINE_ROCK = 'prop-snow-ridge-rock';
const MISTVEIL_REED = 'prop-mistveil-reed-cluster';
const MISTVEIL_ROCK = 'prop-mire-bank-rock';
const SUNMANE_ACACIA = 'prop-savanna-acacia';
const HOLLOW_COLUMN = 'prop-heartroot-root-column';
const HOLLOW_CAVERN_ROCK = 'prop-hollow-cavern-rock';

const PINE_RADIUS = 3;
const MOONPINE_ROCK_RADIUS = 2.5;
const REED_RADIUS = 1.2;
const MIRE_ROCK_RADIUS = 2;
const ACACIA_RADIUS = 4;
const HOLLOW_COLUMN_RADIUS = 3;
const HOLLOW_ROCK_RADIUS = 3.5;

const FOOTPRINT_RADIUS_BY_ASSET: Readonly<Record<string, number>> = {
  [MOONPINE_TREE]: PINE_RADIUS,
  [MOONPINE_ROCK]: MOONPINE_ROCK_RADIUS,
  [MISTVEIL_REED]: REED_RADIUS,
  [MISTVEIL_ROCK]: MIRE_ROCK_RADIUS,
  [SUNMANE_ACACIA]: ACACIA_RADIUS,
  [HOLLOW_COLUMN]: HOLLOW_COLUMN_RADIUS,
  [HOLLOW_CAVERN_ROCK]: HOLLOW_ROCK_RADIUS,
};


interface WalkableSurface { readonly points: readonly Point[] }

interface EdgePlacementRule {
  readonly kind: 'tree' | 'rock' | 'reed' | 'column' | 'cavern';
  readonly assetId: string;
  readonly minScale: number;
  readonly maxScale: number;
  readonly spacing: readonly [number, number];
  readonly footprintRadius: number;
  readonly visibilityRange: number;
  readonly cameraFacingAllowed: boolean;
  readonly cameraFacingDistance?: number;
  readonly cameraFacingMaxScale?: number;
}

interface RegionDressingPlan {
  readonly rules: readonly EdgePlacementRule[];
  readonly idPrefix: string;
  readonly treeClearingCenter?: Readonly<Vec3>;
  readonly treeClearingRadius?: number;
  readonly arenaCenters?: readonly { readonly center: Vec3; readonly radius: number }[];
  readonly fillExtent?: { readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number; readonly cell: number };
  readonly fillKind?: 'pine' | 'acacia';
  readonly fillExclusionExtent?: { readonly minX: number; readonly maxX: number; readonly minZ: number; readonly maxZ: number };
}

const MOONPINE_PLANE: RegionDressingPlan = {
  idPrefix: 'moonpine-later-boundary-',
  rules: [
    { kind: 'rock', assetId: MOONPINE_ROCK, minScale: 0.4, maxScale: 1.2, spacing: EDGE_SPACING_LOW, footprintRadius: MOONPINE_ROCK_RADIUS, visibilityRange: ROUTE_VISIBILITY_RANGE, cameraFacingAllowed: true, cameraFacingDistance: 4, cameraFacingMaxScale: 0.55 },
    { kind: 'tree', assetId: MOONPINE_TREE, minScale: 0.6, maxScale: 1.05, spacing: EDGE_SPACING_TALL, footprintRadius: PINE_RADIUS, visibilityRange: TALL_VISIBILITY_RANGE, cameraFacingAllowed: false },
  ],
  fillExtent: { minX: -85, maxX: 85, minZ: -65, maxZ: 65, cell: 6 },
  fillKind: 'pine',
};

const MISTVEIL_PLANE: RegionDressingPlan = {
  idPrefix: 'mistveil-later-boundary-',
  rules: [
    { kind: 'reed', assetId: MISTVEIL_REED, minScale: 0.75, maxScale: 1.3, spacing: EDGE_SPACING_LOW, footprintRadius: REED_RADIUS, visibilityRange: ROUTE_VISIBILITY_RANGE, cameraFacingAllowed: true, cameraFacingDistance: 4, cameraFacingMaxScale: 0.6 },
    { kind: 'rock', assetId: MISTVEIL_ROCK, minScale: 0.5, maxScale: 1.05, spacing: EDGE_SPACING_LOW, footprintRadius: MIRE_ROCK_RADIUS, visibilityRange: ROUTE_VISIBILITY_RANGE, cameraFacingAllowed: true, cameraFacingDistance: 4, cameraFacingMaxScale: 0.7 },
  ],
};

const SUNMANE_PLANE: RegionDressingPlan = {
  idPrefix: 'sunmane-later-boundary-',
  rules: [
    { kind: 'tree', assetId: SUNMANE_ACACIA, minScale: 0.7, maxScale: 1.05, spacing: EDGE_SPACING_TALL, footprintRadius: ACACIA_RADIUS, visibilityRange: TALL_VISIBILITY_RANGE, cameraFacingAllowed: false },
  ],
  fillExtent: { minX: -100, maxX: 100, minZ: -80, maxZ: 80, cell: 11 },
  fillKind: 'acacia',
};

const REFUGE_PLANE: RegionDressingPlan = {
  idPrefix: 'refuge-later-boundary-',
  rules: [
    { kind: 'rock', assetId: MISTVEIL_ROCK, minScale: 0.45, maxScale: 0.8, spacing: EDGE_SPACING_LOW, footprintRadius: MIRE_ROCK_RADIUS, visibilityRange: ROUTE_VISIBILITY_RANGE, cameraFacingAllowed: true, cameraFacingDistance: 4, cameraFacingMaxScale: 0.6 },
    { kind: 'tree', assetId: SUNMANE_ACACIA, minScale: 0.6, maxScale: 0.85, spacing: EDGE_SPACING_TALL, footprintRadius: ACACIA_RADIUS, visibilityRange: TALL_VISIBILITY_RANGE, cameraFacingAllowed: false },
  ],
  treeClearingCenter: { x: -10, y: 0, z: -2 },
  treeClearingRadius: 8,
};

const HOLLOW_PLANE: RegionDressingPlan = {
  idPrefix: 'hollow-later-boundary-',
  arenaCenters: [{ center: { x: 17, y: -7, z: -45 }, radius: 14 }],
  fillExclusionExtent: { minX: -6, maxX: 48, minZ: -68, maxZ: -20 },
  rules: [
    { kind: 'column', assetId: HOLLOW_COLUMN, minScale: 0.85, maxScale: 1.15, spacing: [9, 13], footprintRadius: HOLLOW_COLUMN_RADIUS, visibilityRange: TALL_VISIBILITY_RANGE, cameraFacingAllowed: false },
    { kind: 'cavern', assetId: HOLLOW_CAVERN_ROCK, minScale: 0.7, maxScale: 1.1, spacing: EDGE_SPACING_LOW, footprintRadius: HOLLOW_ROCK_RADIUS, visibilityRange: ROUTE_VISIBILITY_RANGE, cameraFacingAllowed: true, cameraFacingDistance: 4, cameraFacingMaxScale: 0.85 },
  ],
};

function buildWalkables(region: RegionDefinition): WalkableSurface[] {
  const surfaces: WalkableSurface[] = [];
  for (const surface of region.ground.surfaces) {
    if (!surface.walkable) continue;
    const points = surface.points.map((point) => ({ x: point.x, z: point.z }));
    if (polygonArea(points) < 0) points.reverse();
    surfaces.push({ points });
  }
  return surfaces;
}

function routeSegmentsFor(region: RegionDefinition): [Point, Point][] {
  const segments: [Point, Point][] = [];
  for (const ribbon of region.navigation.ribbons) {
    for (let index = 1; index < ribbon.points.length; index++) segments.push([ribbon.points[index - 1]!, ribbon.points[index]!]);
  }
  for (const route of region.exits) segments.push([route.from, route.to]);
  for (const route of region.entrances) segments.push([route.from, route.to]);
  return segments;
}

/** The native anchor's measured XZ bounding radius is <1.28m at authored scale 0.9. */
function applyPropFootprintCorrection(placement: WorldAssetPlacement): WorldAssetPlacement {
  if (placement.id !== 'heartroot-hollow-placement-4') return placement;
  return { ...placement, position: { ...placement.position, x: 94, z: 86 } };
}

function applyPlan(plan: RegionDressingPlan, region: RegionDefinition): WorldAssetPlacement[] {
  const walkables = buildWalkables(region);
  const routeSegments = routeSegmentsFor(region);
  const visibleFromRoute = (x: number, z: number, range: number): boolean => routeSegments.some(([a, b]) => distanceToSegment(x, z, a, b) <= range);

  const authoredPlacements = region.props.map(applyPropFootprintCorrection);
  const authored = new Map<string, FootprintCircle>();
  for (const placement of authoredPlacements) authored.set(placement.id, { x: placement.position.x, z: placement.position.z, radius: (FOOTPRINT_RADIUS_BY_ASSET[placement.assetId] ?? 1.5) * Math.max(placement.scale.x, placement.scale.z) });

  const placed: FootprintCircle[] = [...authored.values()];
  const placements: WorldAssetPlacement[] = [];
  const seed = SEEDS[region.id] ?? 0x42a04;
  const random = mulberry32(seed);
  const between = (min: number, max: number): number => min + (max - min) * random();

  const clear = (circle: FootprintCircle, range: number, clearance: number): boolean => {
    if (circle.x - circle.radius < region.bounds.min.x || circle.x + circle.radius > region.bounds.max.x ||
        circle.z - circle.radius < region.bounds.min.z || circle.z + circle.radius > region.bounds.max.z) return false;
    if (routeSegments.some(([a, b]) => distanceToSegment(circle.x, circle.z, a, b) < circle.radius + 1.25)) return false;
    for (const surface of walkables) if (distanceToPolygon(surface.points, circle.x, circle.z) < circle.radius + clearance) return false;
    if (plan.arenaCenters && Math.min(...plan.arenaCenters.map((arena) => Math.hypot(circle.x - arena.center.x, circle.z - arena.center.z) - arena.radius)) < circle.radius + 0.5) return false;
    if (plan.treeClearingCenter && circle.radius > 1.5 && Math.hypot(circle.x - plan.treeClearingCenter.x, circle.z - plan.treeClearingCenter.z) < (plan.treeClearingRadius ?? 0) + circle.radius) return false;
    for (const other of placed) if (Math.hypot(circle.x - other.x, circle.z - other.z) < 0.55 * (circle.radius + other.radius)) return false;
    return visibleFromRoute(circle.x, circle.z, range);
  };

  const placeOnEdge = (base: Point, normal: Point): WorldAssetPlacement | null => {
    for (const rule of plan.rules) {
      let scale = between(rule.minScale, rule.maxScale);
      const facingEdge = outwardCameraDot(walkables, base.x + normal.x * 1.5, base.z + normal.z * 1.5) > CAMERA_FACING;
      if (facingEdge && !rule.cameraFacingAllowed) continue;
      const distanceToWalkable = Math.min(...walkables.map((surface) => distanceToPolygon(surface.points, base.x + normal.x * 2, base.z + normal.z * 2)));
      if (facingEdge && rule.cameraFacingDistance !== undefined && distanceToWalkable < rule.cameraFacingDistance) continue;
      if (facingEdge && rule.cameraFacingMaxScale !== undefined) scale = Math.min(scale, rule.cameraFacingMaxScale);
      const radius = rule.footprintRadius * scale;
      if (!facingEdge && outwardCameraDot(walkables, base.x + normal.x * (LATER_BOUNDARY_CLEARANCE + radius + 2), base.z + normal.z * (LATER_BOUNDARY_CLEARANCE + radius + 2)) > TREE_CAMERA_DOT) continue;
      const offset = LATER_BOUNDARY_CLEARANCE + radius + 0.1 + between(0, 0.9);
      const x = base.x + normal.x * offset;
      const z = base.z + normal.z * offset;
      const scales = { x: scale, y: scale * (rule.kind === 'rock' || rule.kind === 'cavern' ? between(0.8, 1.15) : 1), z: scale };
      const circle = { x, z, radius: rule.footprintRadius * scale };
      if (!clear(circle, rule.visibilityRange, LATER_BOUNDARY_CLEARANCE)) continue;
      if (plan.fillExclusionExtent && x >= plan.fillExclusionExtent.minX && x <= plan.fillExclusionExtent.maxX && z >= plan.fillExclusionExtent.minZ && z <= plan.fillExclusionExtent.maxZ) continue;
      placed.push(circle);
      const id = `${plan.idPrefix}${rule.kind}-${placements.length}`;
      return { id, assetId: rule.assetId, position: { x, y: 0, z }, rotationY: random() * Math.PI * 2, scale: scales, placement: 'ground' };
    }
    return null;
  };

  for (const surface of walkables) {
    const pts = surface.points;
    for (let index = 0; index < pts.length; index++) {
      const a = pts[index]!;
      const b = pts[(index + 1) % pts.length]!;
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      if (length < 1e-6) continue;
      const direction: Point = { x: (b.x - a.x) / length, z: (b.z - a.z) / length };
      const normal: Point = { x: direction.z, z: -direction.x };
      for (const side of [1, -1]) {
        const nx = normal.x * side;
        const nz = normal.z * side;
        const probe = { x: (a.x + b.x) / 2 + nx * 0.5, z: (a.z + b.z) / 2 + nz * 0.5 };
        if (walkables.some((other) => distanceToPolygon(other.points, probe.x, probe.z) < 0.4)) continue;
        for (let distance = between(0.5, 2.5); distance < length - 0.2; distance += between(EDGE_SPACING_LOW[0], EDGE_SPACING_LOW[1])) {
          const base: Point = { x: a.x + direction.x * distance, z: a.z + direction.z * distance };
          const placement = placeOnEdge(base, { x: nx, z: nz });
          if (placement) placements.push(placement);
        }
      }
    }
  }

  if (plan.fillExtent && plan.fillKind) {
    const tallRule = plan.rules.find((rule) => rule.kind === 'tree' && rule.cameraFacingAllowed === false);
    if (tallRule) {
      const extent = plan.fillExtent;
      for (let z = extent.minZ; z < extent.maxZ; z += extent.cell) {
        for (let x = extent.minX; x < extent.maxX; x += extent.cell) {
          const tx = x + between(0, extent.cell);
          const tz = z + between(0, extent.cell);
          if (random() < 0.18) continue;
          if (plan.fillExclusionExtent && tx >= plan.fillExclusionExtent.minX && tx <= plan.fillExclusionExtent.maxX && tz >= plan.fillExclusionExtent.minZ && tz <= plan.fillExclusionExtent.maxZ) continue;
          const scale = between(tallRule.minScale, tallRule.maxScale);
          const circle = { x: tx, z: tz, radius: tallRule.footprintRadius * scale };
          if (!clear(circle, tallRule.visibilityRange, LATER_BOUNDARY_CLEARANCE)) continue;
          placed.push(circle);
          const id = `${plan.idPrefix}fill-${placements.length}`;
          placements.push({ id, assetId: tallRule.assetId, position: { x: tx, y: 0, z: tz }, rotationY: random() * Math.PI * 2, scale: { x: scale, y: scale, z: scale }, placement: 'ground' });
        }
      }
    }
  }

  return placements;
}

const LATER_REGION_PLANS: Readonly<Record<string, RegionDressingPlan>> = {
  'moonpine-ridge': MOONPINE_PLANE,
  'mistveil-basin': MISTVEIL_PLANE,
  'sunmane-expanse': SUNMANE_PLANE,
  refuge: REFUGE_PLANE,
  'heartroot-hollow': HOLLOW_PLANE,
};

/** Wrap a chapter region with deterministic native boundary dressing + the surgical Hollow spawn footprint fix. Returns the region unchanged for any other region id. */
export function dressLaterRegion(region: RegionDefinition): RegionDefinition {
  const plan = LATER_REGION_PLANS[region.id];
  if (!plan) return region;
  const corrected = region.props.map(applyPropFootprintCorrection);
  const dressing = applyPlan(plan, region);
  return { ...region, props: [...corrected, ...dressing] };
}

/** Test seam: returns true for the five later chapter region ids. */
export function isLaterChapterRegion(regionId: string): boolean {
  return LATER_REGION_PLANS[regionId] !== undefined;
}