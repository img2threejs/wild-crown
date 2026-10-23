/**
 * Region polygons traced on the illustrated world map (`/ui/world-map-game.webp`).
 *
 * Both axes use 0–100 percentages of the unchanged 1536×960 artwork. Image-guided coast/biome contours are
 * inferred gameplay partitions, not artist-authored alpha mattes. The Pixi map uses the same contours for
 * its independent border nodes and geographic hit areas; the complete painting moves under one camera.
 * Admission and motion constraints: `.img2pixi2d/reconstruction.json`.
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
 * Contours follow the observed coastlines and biome changes of `/ui/world-map-game.webp`.
 * Interior divisions on the continuous land mass remain inferred. First and last points coincide.
 * Refuge remains a route waypoint, not a new selectable chapter.
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
    centre: [18, 40],
    chipPosition: [17.65, 40.2],
    polygon: [
      [6, 26], [10, 23], [15, 25], [19, 28], [23, 30], [26, 32], [29, 33], [30.5, 37],
      [32.5, 38], [33.5, 42], [32.5, 46], [31.8, 50], [30.6, 54], [29.4, 58], [30.3, 62],
      [28.8, 65.7], [28.4, 70.8], [25, 69], [21, 67], [17, 66], [13, 65], [10, 64],
      [7, 62], [4, 61], [2.5, 57], [1.8, 52], [2.5, 47], [2, 42], [3.5, 36], [4.5, 31], [6, 26],
    ],
  },
  // Blood Bamboo Valley — the orange autumn forest in the top-left valley, painted as a triangular
  // wedge of red leaves between the canopy (left/below) and the grove ridge (right). The label sits
  // above and to the left of the painted mass; the polygon traces the visible orange leaves only.
  {
    id: 'blood-bamboo-valley',
    name: 'Blood Bamboo Valley',
    label: 'Bamboo',
    centre: [28, 22],
    chipPosition: [27.8, 20.2],
    polygon: [
      [13.5, 19], [14, 16], [16.5, 15.6], [18, 12.8], [21, 12.8], [22.7, 9.5], [25.8, 9],
      [27.2, 8.2], [28.3, 11], [30, 10], [32, 13], [35, 13], [36.5, 15.5], [40, 17.7],
      [42.8, 21], [43.7, 25], [44.5, 29], [43.6, 31], [42, 32.8], [39, 33.6], [36.7, 35],
      [34, 33.3], [31.2, 32.4], [28.1, 31], [25, 29], [22, 26], [19, 24], [16, 23], [13.5, 19],
    ],
  },
  // The Grove — the central sanctuary: the Heartroot tree, the glowing pool, southern anchor.
  // The painted mass is an oval around the tree; we trace the visible tree canopy plus a halo of
  // grass/paths reaching out toward the painted paths connecting to the surrounding regions.
  {
    id: 'the-grove',
    name: 'The Grove',
    label: 'Grove',
    centre: [51, 44],
    chipPosition: [50.9, 43.5],
    polygon: [
      [39, 37.5], [42, 35], [46, 32], [49, 30], [52, 30.5], [56, 32], [60, 33.5], [63.5, 35],
      [65, 38], [64, 41], [64, 45], [62.5, 48], [61.6, 52], [59, 54.5], [57, 56.3], [54, 58.7],
      [49, 60], [46, 59], [43, 57.7], [40, 56], [37.5, 55], [35, 52.8], [34, 49], [34.5, 44.8],
      [34.8, 41.3], [37, 40], [39, 37.5],
    ],
  },
  // Greenwake — the southern village cluster of thatched roofs on the south coast.
  {
    id: 'greenwake',
    name: 'Greenwake',
    label: 'Greenwake',
    centre: [48, 79],
    chipPosition: [48.3, 78.8],
    polygon: [
      [35, 66], [38, 64], [41, 62], [44, 61.5], [47, 62], [51, 63.3], [53.5, 64.5], [56, 66.5],
      [58, 69], [59.3, 72], [61, 75], [61, 78], [60, 81], [59, 85], [57, 88], [54, 91],
      [51, 93], [47, 94], [43, 93.5], [39.5, 92], [36, 90], [34.3, 87], [33, 83],
      [32.8, 79], [32.5, 76], [32, 72], [33.5, 68], [35, 66],
    ],
  },
  // Moonpine Ridge — the snowy peaks in the upper-right, the brightest snow line.
  {
    id: 'moonpine-ridge',
    name: 'Moonpine Ridge',
    label: 'Moonpine',
    centre: [65, 20],
    chipPosition: [68.2, 17.6],
    polygon: [
      [44, 22], [45.8, 18], [49, 17], [51, 15], [53, 12.9], [55, 11.5], [57, 11.5],
      [59.2, 8.3], [62, 9.8], [63.5, 10.6], [65, 9.9], [67.1, 12.3], [69, 11.3],
      [71.3, 13.9], [73.4, 15], [76.3, 18.2], [78, 21.5], [77.5, 24], [80, 26.5],
      [78, 29], [75, 30], [71.6, 30.7], [68.5, 30], [66, 33], [63.2, 33], [60, 31],
      [57.5, 31], [55, 29], [52, 29], [50, 27], [47, 27], [44, 25], [44, 22],
    ],
  },
  // Mistveil Basin — the foggy river plain, east side, with mist wreaths and root trees.
  {
    id: 'mistveil-basin',
    name: 'Mistveil Basin',
    label: 'Mistveil',
    centre: [85, 38],
    chipPosition: [84.9, 36.9],
    polygon: [
      [80.2, 25.5], [84, 25], [87, 27], [90, 29], [91.5, 32], [94, 33.2], [96, 36],
      [97.5, 39], [98.8, 45], [97, 48], [94.5, 50], [91, 51.3], [88, 50.8], [85, 51.9],
      [81.5, 50.1], [78.1, 50.8], [75.6, 49], [72.3, 49.7], [69, 51.5], [66, 50.1],
      [64.7, 47], [66, 43.5], [65.7, 39.2], [67.9, 35], [69.1, 33], [72.1, 32],
      [75.4, 31.5], [78, 29.5], [80.2, 25.5],
    ],
  },
  // Sunmane Expanse — the dry golden savannah, lower-east side, painted as the lion kingdom's
  // stepped pyramid/citadel with surrounding grassland.
  {
    id: 'sunmane-expanse',
    name: 'Sunmane Expanse',
    label: 'Sunmane',
    centre: [82, 67],
    chipPosition: [82.4, 64.6],
    polygon: [
      [72.2, 52.4], [76.3, 51], [80, 52], [83, 52.5], [86, 52], [89, 54], [92, 55.5],
      [94, 58], [96, 60], [96.8, 64], [97.7, 67], [98.1, 71], [96.5, 75], [94.7, 78],
      [93, 81.2], [91, 83], [90, 87], [87, 90.2], [83, 93], [79, 95.3], [75, 97.2],
      [72, 97], [69, 95.8], [66.7, 93.7], [65, 90], [64.5, 87], [65.8, 84],
      [66.5, 80.7], [66, 77.5], [64, 73], [63, 69], [63.5, 65], [65, 61], [68, 59],
      [69.3, 56], [72.2, 52.4],
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
    centre: [16, 86],
    chipPosition: [16.4, 88.5],
    polygon: [
      [4, 71], [7, 72], [10, 71.5], [12.5, 72.8], [16, 74], [20, 77], [23.5, 80],
      [26, 83], [29, 84.5], [31, 87], [32, 90], [31.5, 93], [29, 95.2], [26, 96.8],
      [23, 97], [20, 95], [16, 94.5], [13, 94], [9, 93.2], [5, 92], [2.5, 89.5],
      [1.8, 86], [1.8, 82], [2.3, 77.5], [3, 74], [4, 71],
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