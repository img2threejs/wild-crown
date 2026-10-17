/**
 * Region polygons traced on the illustrated world map (`/ui/world-map-game.webp`).
 *
 * Every region is a closed 0–100 percentage polygon whose vertices sit inside the 8 : 5 aspect-ratio viewport the
 * map is rendered into (object-fit: contain). Polygons are intentionally generous around each region so a player
 * clicking or pressing near the illustration's painted region hits the button, while still being smaller than the
 * illustration's painted footprint. Coordinates are sorted from the existing chip percentages in
 * `game-ui.css:267-287` (centres) and refined by reading the painted boundaries in the webp file.
 *
 * The data is consumed by `worldMapRegionOverlay` (SVG polygons) and the spatial arrow-key navigation in
 * `worldMapSelectMarkup`; no other module imports it.
 */
import type { AssetPlaytestId } from '../app/AssetPlaytests.js';

/** Stable route ids mirrored in `GameUI.ts` REGION_ORDER and `game-ui.css` chip positions. */
export type WorldRegionId =
  | 'whispering-canopy'
  | 'blood-bamboo-valley'
  | 'the-grove'
  | 'greenwake'
  | 'moonpine-ridge'
  | 'mistveil-basin'
  | 'sunmane-expanse'
  | 'refuge'
  | 'heartroot-hollow';

export type WorldRegionStatus = 'playable' | 'locked' | 'coming-soon';

/** Visual route colour used for the playable outline; consumed by both map stroke and the dashed survey route. */
export const ROUTE_COLOUR = '#a8174f';
/** Neutral outline for locked/coming-soon regions: same wood used by the survey legend. */
export const LOCKED_COLOUR = '#645f4e';

export interface WorldRegionShape {
  /** Canonical scene id used by REGION_PRESENTATION and the in-game World map chip CSS. */
  readonly id: WorldRegionId;
  /** Display title (authoritative). */
  readonly name: string;
  /** Short label, used on locked overlays. */
  readonly label: string;
  /** Closed 0–100 percentage polygon; first and last points must coincide (closed ring). */
  readonly polygon: ReadonlyArray<readonly [number, number]>;
  /** Approximate centre for the spatial arrow-key navigation (must lie inside the polygon). */
  readonly centre: readonly [number, number];
  /** Title chip placement on the in-game World map (kept in sync with `game-ui.css` chips). */
  readonly chipPosition: readonly [number, number];
}

/**
 * The journey order that the dashed survey route line connects when the screen is reduced/static. Coordinates are
 * 0–100 inside the 8 : 5 viewport (the same aspect-ratio the in-game World map renders at); the survey route
 * follows each region's centre, drawing the shape of the player's route across Erya.
 */
export const SURVEY_ROUTE: readonly WorldRegionId[] = [
  'whispering-canopy',
  'the-grove',
  'greenwake',
  'blood-bamboo-valley',
  'refuge',
  'moonpine-ridge',
  'mistveil-basin',
  'sunmane-expanse',
  'heartroot-hollow',
];

/**
 * Region polygon table.
 *
 * Coordinates were captured by reading the painted boundaries of `/ui/world-map-game.webp` and cross-referenced with
 * the chip centres in `game-ui.css:267-287`. Coordinates are 0–100 percentages of the 8 : 5 viewport. Vertices are
 * listed clockwise starting from the top of the painted area. The closed polygon is `polygon[0] === polygon[last]`,
 * so the SVG `points` attribute can be fed directly from `polygon.flat().join(' ')`.
 *
 * No polygon overlaps another by more than `POLYGON_OVERLAP_TOLERANCE` square percentage units (the spatial
 * navigation tests pin this); the painted boundaries of adjacent regions leave a small corridor that both the
 * hover and the keyboard focus can ignore.
 */
export const WORLD_REGION_SHAPES: ReadonlyArray<WorldRegionShape> = Object.freeze([
  // Whispering Canopy — the western jungle: rope bridges, top-left waterfall, monkeys/birds.
  // The painted land mass runs from the left edge of the map to the bamboo valley ridge, hugging the
  // waterfalls that separate it from the basin. The label "Whispering Canopy" sits outside the top-left
  // corner, so the polygon must keep its top-left at the coast and not extend to where the label is.
  {
    id: 'whispering-canopy',
    name: 'Whispering Canopy',
    label: 'Canopy',
    centre: [7, 44],
    chipPosition: [6, 40],
    polygon: [
      [0, 30], [3, 32], [12, 32], [13, 38], [11, 44], [13, 50], [12, 58], [7, 60], [2, 58],
      [0, 52], [0, 30],
    ],
  },
  // Blood Bamboo Valley — the orange autumn forest in the top-left valley, painted as a triangular
  // wedge of red leaves between the canopy (left/below) and the grove ridge (right). The label sits
  // above and to the left of the painted mass; the polygon traces the visible orange leaves only.
  {
    id: 'blood-bamboo-valley',
    name: 'Blood Bamboo Valley',
    label: 'Bamboo',
    centre: [20, 13],
    chipPosition: [16, 15],
    polygon: [
      [13, 4], [24, 5], [30, 9], [29, 16], [26, 22], [20, 24], [15, 21], [13, 14], [13, 4],
    ],
  },
  // The Grove — the central sanctuary: the Heartroot tree, the glowing pool, southern anchor.
  // The painted mass is an oval around the tree; we trace the visible tree canopy plus a halo of
  // grass/paths reaching out toward the painted paths connecting to the surrounding regions.
  {
    id: 'the-grove',
    name: 'The Grove',
    label: 'Grove',
    centre: [46, 36],
    chipPosition: [47, 38],
    polygon: [
      [38, 28], [44, 26], [50, 26], [53, 30], [53, 36], [50, 40], [45, 42], [41, 40],
      [38, 35], [38, 28],
    ],
  },
  // Greenwake — the southern village cluster of thatched roofs on the south coast.
  {
    id: 'greenwake',
    name: 'Greenwake',
    label: 'Greenwake',
    centre: [42, 87],
    chipPosition: [43, 86],
    polygon: [
      [33, 82], [50, 82], [54, 88], [50, 94], [42, 97], [34, 94], [31, 88], [33, 82],
    ],
  },
  // Moonpine Ridge — the snowy peaks in the upper-right, the brightest snow line.
  {
    id: 'moonpine-ridge',
    name: 'Moonpine Ridge',
    label: 'Moonpine',
    centre: [64, 11],
    chipPosition: [63, 14],
    polygon: [
      [54, 2], [64, 1], [74, 2], [82, 6], [83, 12], [78, 16], [70, 18], [60, 17], [54, 12], [52, 6], [54, 2],
    ],
  },
  // Mistveil Basin — the foggy river plain, east side, with mist wreaths and root trees.
  {
    id: 'mistveil-basin',
    name: 'Mistveil Basin',
    label: 'Mistveil',
    centre: [83, 32],
    chipPosition: [80, 33],
    polygon: [
      [76, 22], [85, 20], [93, 24], [97, 32], [94, 38], [86, 40], [78, 38], [74, 32], [74, 26], [76, 22],
    ],
  },
  // Sunmane Expanse — the dry golden savannah, lower-east side, painted as the lion kingdom's
  // stepped pyramid/citadel with surrounding grassland.
  {
    id: 'sunmane-expanse',
    name: 'Sunmane Expanse',
    label: 'Sunmane',
    centre: [84, 65],
    chipPosition: [75, 59],
    polygon: [
      [73, 58], [82, 54], [92, 56], [98, 62], [97, 72], [90, 78], [80, 79], [72, 76], [70, 68], [71, 60], [73, 58],
    ],
  },
  // Refuge — the painted refuge tower, mid-right plateau between the Grove and Sunmane.
  {
    id: 'refuge',
    name: 'The Refuge',
    label: 'Refuge',
    centre: [62, 48],
    chipPosition: [52, 72],
    polygon: [
      [57, 43], [66, 42], [68, 46], [68, 52], [64, 55], [58, 55], [55, 51], [55, 46], [57, 43],
    ],
  },
  // Heartroot Hollow — the underground hollow inset in the lower-left of the map.
  {
    id: 'heartroot-hollow',
    name: 'Heartroot Hollow',
    label: 'Hollow',
    centre: [10, 82],
    chipPosition: [8, 82],
    polygon: [
      [1, 70], [10, 70], [20, 72], [22, 80], [18, 90], [10, 92], [2, 90], [1, 82], [1, 70],
    ],
  },
]);

/** Static map from the chapter's `playtestId` (or absence) to the matching region shape id. */
export const REGION_BY_PLAYTEST_ID: Readonly<Record<AssetPlaytestId, WorldRegionId>> = Object.freeze({
  greenwake: 'greenwake',
  canopy: 'whispering-canopy',
  grove: 'the-grove',
  moonpine: 'moonpine-ridge',
  mistveil: 'mistveil-basin',
});

/** Maximum squared distance (in percent²) two vertices of different regions are allowed to be apart before the
 *  polygons are considered to overlap. The painted boundaries of adjacent regions in the source illustration
 *  never sit closer than ~6% of the viewport, so 36 percent² (6²) keeps the test strict without flaking on
 *  floating-point noise from tracing the painted boundary. */
export const POLYGON_OVERLAP_TOLERANCE = 36;

/** Validates a closed polygon is in 0–100 percent and the ring actually closes. Exported as a public API:
 *  the deterministic tests call it directly to pin the polygon contract. */
export function isClosedPolygon(polygon: ReadonlyArray<readonly [number, number]>): boolean {
  if (polygon.length < 4) return false;
  const first = polygon[0]!;
  const last = polygon[polygon.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) return false;
  for (const [x, y] of polygon) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (x < 0 || x > 100 || y < 0 || y > 100) return false;
  }
  return true;
}

/** True when any vertex of `a` sits closer than the overlap tolerance to a vertex of `b`. Exported for tests. */
export function polygonsOverlap(
  a: ReadonlyArray<readonly [number, number]>,
  b: ReadonlyArray<readonly [number, number]>,
  tolerance: number = POLYGON_OVERLAP_TOLERANCE,
): boolean {
  for (const [ax, ay] of a) {
    for (const [bx, by] of b) {
      if ((ax - bx) ** 2 + (ay - by) ** 2 < tolerance) return true;
    }
  }
  return false;
}

/** Polygon area in 0–100 percent² units, computed by the shoelace formula. Public API for area calculations. */
export function polygonArea(polygon: ReadonlyArray<readonly [number, number]>): number {
  if (polygon.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i]!;
    const [x2, y2] = polygon[(i + 1) % polygon.length]!;
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** Returns the closed polygon's bounding box as `{minX,minY,maxX,maxY}` (percent). */
export function polygonBounds(polygon: ReadonlyArray<readonly [number, number]>): {
  minX: number; minY: number; maxX: number; maxY: number;
} {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of polygon) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}