import type { RegionDefinition } from '../game/contracts';
import { groundExtent, type BiomeProfile } from './BiomeProfile';
import { clamp01, fbm, smoothstep, valueNoise } from './GroundNoise';
import type { TerrainField } from './GroundTerrain';
import { isBridgeDeckSurface } from './WalkSurfaces';

/** Splat weights are baked at ≤ 0.25 m/texel; the trail detail (ruts, footprints) at half that. */
export const MASK_TEXEL = 0.25;
export const DETAIL_TEXEL = 0.125;
/** Distance between two footprints of the same foot along the trail. */
export const STEP_PERIOD = 1.3;
/** Margin around the bridge deck where nothing grows and no trail is painted. */
const DECK_MARGIN = 0.3;
const EDGE_LIMIT = 4.8;
/** The undergrowth band hugging the walk-mesh edge starts this far out, wobbled by up to ±EDGE_WOBBLE so no straight outline shows. */
const EDGE_START = 0.4;
const EDGE_WOBBLE = 0.35;
/** The walkable interior weight fades from 1 on the surface to 0 this far outside it. */
const INTERIOR_BLEND = 0.45;
const SEED_WOBBLE = 4421;
const SEED_GRAVEL = 6007;
const SEED_MOISTURE = 7919;
const SEED_MOSS = 3109;
const SEED_BLEND = 2203;
const SEED_GRAIN = 8191;
const SEED_EDGE = 9127;

export interface TrailSegment {
  readonly ax: number;
  readonly az: number;
  readonly bx: number;
  readonly bz: number;
  readonly halfWidth: number;
  readonly length: number;
  /** Arc length of the segment start measured from the first ribbon vertex. */
  readonly startArc: number;
}

/**
 * CPU weights (`data`, RGBA8, texel centres at min + (i + ½)·texel):
 *  R trail core (compacted earth, peaks on the ribbon centreline)
 *  G worn shoulder / gravel band
 *  B route proximity (disturbed litter along the trail ribbons only: not the whole walkable surface)
 *  A moisture (moss and grass versus dry litter)
 * GPU weights (`shade`, same grid): R core, G shoulder, B moss-over-litter weight (already thresholded
 * from moisture, route proximity and patch noise), A anti-tiling cross-fade between the two texture scales.
 * Terrain weights (`terrain`, RGBA8, same grid): R wet mud on the lower banks of the carved channels, G channel-bed gravel and
 * pebbles, B rock (steep faces: embankments, summits and channel banks), A bridge-deck underside (nothing grows, no trail).
 * Detail (`detail`, RGBA8, ≤ 1.7 half widths around a ribbon, neutral grey elsewhere): R/G cos/sin of the
 * footstep phase along the trail, B signed lateral offset (metres / 4 + ½), A edge grain noise.
 */
export interface GroundMask {
  readonly minX: number;
  readonly minZ: number;
  readonly width: number;
  readonly height: number;
  readonly texel: number;
  readonly data: Uint8Array;
  readonly shade: Uint8Array;
  readonly terrain: Uint8Array;
  /** World rectangle (minX, minZ, maxX, maxZ) that contains every non-zero `terrain` weight; the shader only fetches `terrain` inside it. */
  readonly terrainRect: readonly [number, number, number, number];
  /** Single channel, same grid as `data`: weight of the dense fern / tall-grass band along the walk-mesh edge. */
  readonly edge: Uint8Array;
  /** Single channel, same grid as `data`: 1 on a walkable surface, fading out over {@link INTERIOR_BLEND} metres beyond its edge. */
  readonly interior: Uint8Array;
  readonly detailWidth: number;
  readonly detailHeight: number;
  readonly detailTexel: number;
  readonly detail: Uint8Array;
  readonly segments: readonly TrailSegment[];
}

export interface MaskSample {
  core: number;
  shoulder: number;
  /** Proximity to the trail ribbons (1 on the core, 0 beyond ~1.7 half widths). */
  walk: number;
  moisture: number;
  /** Undergrowth band on the berm just outside the walk-mesh (0 inside it and beyond ~4.8 m). */
  edge: number;
  /** On a walkable surface (1) or just beyond its edge (fading to 0): wide walkables carry short sparse cover here. */
  interior: number;
  /** Wet bank mud, channel-bed gravel, steep rock, and bridge-deck underside weights (see {@link GroundMask}). */
  mud: number;
  bed: number;
  rock: number;
  deck: number;
}

export function createMaskSample(): MaskSample {
  return { core: 0, shoulder: 0, walk: 0, moisture: 0, edge: 0, interior: 0, mud: 0, bed: 0, rock: 0, deck: 0 };
}

function insidePolygon(points: readonly { readonly x: number; readonly z: number }[], x: number, z: number): boolean {
  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const a = points[index]!;
    const b = points[previous]!;
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** Corners of a ribbon turning more than this (radians) are rounded with a quadratic arc; the arc starts at most CORNER_RADIUS m before the corner. */
const CORNER_MIN_TURN = 0.3;
const CORNER_RADIUS = 4;
const CORNER_STEPS = 8;
/** The trail width breathes by ±WIDTH_BREATH around the authored width (noise along the arc). */
const WIDTH_BREATH = 0.16;
const SEED_BREATH = 5003;

interface XZ {
  readonly x: number;
  readonly z: number;
}

/** The ribbon's centreline with its corners rounded by a spline (a quadratic arc of radius ≈ 3–5 m), never straying outside the corner. */
function roundedRibbon(points: readonly XZ[]): XZ[] {
  const out: XZ[] = [points[0]!];
  for (let index = 1; index < points.length - 1; index++) {
    const before = points[index - 1]!;
    const corner = points[index]!;
    const after = points[index + 1]!;
    const lengthIn = Math.hypot(corner.x - before.x, corner.z - before.z);
    const lengthOut = Math.hypot(after.x - corner.x, after.z - corner.z);
    if (lengthIn < 1e-6 || lengthOut < 1e-6) continue;
    const inX = (corner.x - before.x) / lengthIn;
    const inZ = (corner.z - before.z) / lengthIn;
    const outX = (after.x - corner.x) / lengthOut;
    const outZ = (after.z - corner.z) / lengthOut;
    const turn = Math.acos(Math.max(-1, Math.min(1, inX * outX + inZ * outZ)));
    if (turn < CORNER_MIN_TURN) {
      out.push(corner);
      continue;
    }
    const radius = Math.min(CORNER_RADIUS, 0.45 * lengthIn, 0.45 * lengthOut);
    const ax = corner.x - inX * radius;
    const az = corner.z - inZ * radius;
    const bx = corner.x + outX * radius;
    const bz = corner.z + outZ * radius;
    for (let step = 0; step <= CORNER_STEPS; step++) {
      const t = step / CORNER_STEPS;
      const u = 1 - t;
      out.push({ x: u * u * ax + 2 * u * t * corner.x + t * t * bx, z: u * u * az + 2 * u * t * corner.z + t * t * bz });
    }
  }
  out.push(points[points.length - 1]!);
  return out;
}

/**
 * Every ribbon segment becomes trail (ramps, the ridge top and the gateway are terrain, so they carry the same worn
 * packed earth as the y = 0 routes), except segments that lie on a bridge deck: the rope-bridge model is the deck.
 * Corners are rounded and the width breathes with noise, so the trail reads as a worn path, not an engineered band.
 */
export function groundTrailSegments(region: RegionDefinition): TrailSegment[] {
  const decks = region.ground.surfaces.filter(isBridgeDeckSurface);
  const segments: TrailSegment[] = [];
  for (const ribbon of region.navigation.ribbons) {
    let arc = 0;
    const path = roundedRibbon(ribbon.points);
    for (let index = 1; index < path.length; index++) {
      const a = path[index - 1]!;
      const b = path[index]!;
      const length = Math.hypot(b.x - a.x, b.z - a.z);
      const onDeck = decks.some((deck) => insidePolygon(deck.points, (a.x + b.x) / 2, (a.z + b.z) / 2));
      if (length > 0 && !onDeck) {
        const breath = 1 + WIDTH_BREATH * (valueNoise((arc + length / 2) * 0.22, a.x * 0.05 + a.z * 0.05, SEED_BREATH) * 2 - 1);
        segments.push({ ax: a.x, az: a.z, bx: b.x, bz: b.z, halfWidth: (ribbon.width / 2) * breath, length, startArc: arc });
      }
      arc += length;
    }
  }
  return segments;
}

interface NearestTrail {
  /** Distance to the closest centreline in units of the ribbon half width. */
  readonly normalized: Float32Array;
  readonly lateral: Float32Array;
  readonly arc: Float32Array;
}

/** For every texel within `influence` half widths of a segment, records the closest segment's distance, side and arc. */
function rasterizeNearest(segments: readonly TrailSegment[], minX: number, minZ: number, width: number, height: number, texel: number, influence: number): NearestTrail {
  const normalized = new Float32Array(width * height).fill(Infinity);
  const lateral = new Float32Array(width * height);
  const arc = new Float32Array(width * height);
  for (const segment of segments) {
    const reach = segment.halfWidth * influence;
    const dx = segment.bx - segment.ax;
    const dz = segment.bz - segment.az;
    const x0 = Math.max(0, Math.floor((Math.min(segment.ax, segment.bx) - reach - minX) / texel));
    const x1 = Math.min(width - 1, Math.ceil((Math.max(segment.ax, segment.bx) + reach - minX) / texel));
    const z0 = Math.max(0, Math.floor((Math.min(segment.az, segment.bz) - reach - minZ) / texel));
    const z1 = Math.min(height - 1, Math.ceil((Math.max(segment.az, segment.bz) + reach - minZ) / texel));
    for (let row = z0; row <= z1; row++) {
      const pz = minZ + (row + 0.5) * texel;
      for (let col = x0; col <= x1; col++) {
        const px = minX + (col + 0.5) * texel;
        const t = clamp01(((px - segment.ax) * dx + (pz - segment.az) * dz) / (segment.length * segment.length));
        const ox = px - (segment.ax + dx * t);
        const oz = pz - (segment.az + dz * t);
        const distance = Math.hypot(ox, oz);
        const ratio = distance / segment.halfWidth;
        const index = row * width + col;
        if (ratio >= normalized[index]!) continue;
        normalized[index] = ratio;
        lateral[index] = dx * oz - dz * ox >= 0 ? distance : -distance;
        arc[index] = segment.startArc + t * segment.length;
      }
    }
  }
  return { normalized, lateral, arc };
}

const toByte = (value: number): number => Math.round(clamp01(value) * 255);

/** Distance-wobbled core profile: 1 on the centreline, 0 beyond ~0.85 half widths. */
export function trailCoreProfile(normalizedDistance: number): number {
  return 1 - smoothstep(0.15, 0.82, normalizedDistance);
}

export function bakeGroundMask(region: RegionDefinition, field: TerrainField, profile: BiomeProfile): GroundMask {
  const extent = groundExtent(region, profile);
  const min = { x: extent.minX, z: extent.minZ };
  const max = { x: extent.maxX, z: extent.maxZ };
  const { carve, splat } = profile;
  const segments = groundTrailSegments(region);
  const width = Math.ceil((max.x - min.x) / MASK_TEXEL);
  const height = Math.ceil((max.z - min.z) / MASK_TEXEL);
  const nearest = rasterizeNearest(segments, min.x, min.z, width, height, MASK_TEXEL, 1.7);
  const data = new Uint8Array(width * height * 4);
  const shade = new Uint8Array(width * height * 4);
  const terrain = new Uint8Array(width * height * 4);
  const edge = new Uint8Array(width * height);
  const interior = new Uint8Array(width * height);
  let rectMinX = Infinity;
  let rectMinZ = Infinity;
  let rectMaxX = -Infinity;
  let rectMaxZ = -Infinity;
  const slopeStep = MASK_TEXEL;
  for (let row = 0; row < height; row++) {
    const z = min.z + (row + 0.5) * MASK_TEXEL;
    for (let col = 0; col < width; col++) {
      const x = min.x + (col + 0.5) * MASK_TEXEL;
      const index = row * width + col;
      let core = 0;
      let shoulder = 0;
      const ratio = nearest.normalized[index]!;
      if (ratio < 1.7) {
        // Wobble scales the distance, never offsets it, so the peak stays on the centreline.
        const wobbled = ratio * (1 + 0.16 * (valueNoise(x * 0.9, z * 0.9, SEED_WOBBLE) * 2 - 1));
        core = trailCoreProfile(wobbled);
        shoulder = smoothstep(0.5, 0.9, wobbled) * (1 - smoothstep(1.05, 1.6, wobbled)) * (0.55 + 0.45 * valueNoise(x * 2.3, z * 2.3, SEED_GRAVEL));
      }
      // Terrain features: steep faces read as rock, carved channels paint wet mud and bed gravel, the bridge deck's underside is bare.
      const membership = carve.membership(x, z);
      const inGully = smoothstep(0.1, 0.5, membership);
      const surface = field.sample(x, z);
      let rock = 0;
      const raisedGap = field.raisedDistance(x, z, 5);
      if (inGully > 0 || raisedGap < 5 || splat.rockOnOpenSlopes) {
        const slope = Math.hypot(field.sample(x + slopeStep, z) - field.sample(x - slopeStep, z), field.sample(x, z + slopeStep) - field.sample(x, z - slopeStep)) / (2 * slopeStep);
        const reach = splat.rockOnOpenSlopes ? 1 : Math.max(1 - smoothstep(3, 5, raisedGap), inGully);
        rock = smoothstep(splat.rockSlopeStart, splat.rockSlopeFull, slope) * reach;
      }
      // Gravel under the water and on the shore just above it (the water surface rises with the bed towards a channel's ends).
      const bed = inGully * (1 - smoothstep(0, 0.5, surface - carve.waterLevel(x, z)));
      const mud = carve.wetness(x, z, surface) * (1 - bed);
      const deck = field.nearBridgeDeck(x, z, DECK_MARGIN) ? 1 : 0;
      // No trail on channel banks, steep faces or under the bridge: only on the walkable surfaces and gentle ground.
      if (field.surfaceHeightAt(x, z) === undefined) {
        const suppress = Math.max(deck, inGully, rock);
        core *= 1 - suppress;
        shoulder *= 1 - suppress;
      }
      const base = index * 4;
      terrain[base] = toByte(mud);
      terrain[base + 1] = toByte(bed);
      terrain[base + 2] = toByte(rock);
      terrain[base + 3] = toByte(deck);
      if (terrain[base]! + terrain[base + 1]! + terrain[base + 2]! + terrain[base + 3]! > 0) {
        if (x < rectMinX) rectMinX = x;
        if (z < rectMinZ) rectMinZ = z;
        if (x > rectMaxX) rectMaxX = x;
        if (z > rectMaxZ) rectMaxZ = z;
      }
      // The worn trail, its litter and the moss gap follow the ribbons only; a wide walkable (cliff top, basin, courtyard) keeps natural ground
      // beyond ~1.7 half widths. The undergrowth band hugs the walkable edge with a wobbled start so no clean outline shows.
      const route = 1 - smoothstep(0.75, 1.7, ratio);
      const gap = field.walkDistance(x, z, EDGE_LIMIT);
      const gapWobbled = gap + (valueNoise(x * 0.8, z * 0.8, SEED_EDGE) * 2 - 1) * EDGE_WOBBLE;
      edge[index] = toByte(smoothstep(EDGE_START, EDGE_START + 0.55, gapWobbled) * (1 - smoothstep(3.2, EDGE_LIMIT, gap)));
      const inside = 1 - smoothstep(0, INTERIOR_BLEND, field.walkableGap(x, z, INTERIOR_BLEND));
      interior[index] = toByte(inside);
      const moisture = 0.5 + 0.6 * fbm(x / 9, z / 9, SEED_MOISTURE, 3);
      data[base] = toByte(core);
      data[base + 1] = toByte(shoulder);
      data[base + 2] = toByte(route);
      data[base + 3] = toByte(moisture);
      const mossInput = moisture * 0.7 + (1 - Math.max(route, inside * 0.35)) * 0.55 + (valueNoise(x * 0.17 + 11, z * 0.17 + 11, SEED_MOSS) - 0.5) * 0.4;
      shade[base] = data[base]!;
      shade[base + 1] = data[base + 1]!;
      shade[base + 2] = toByte(smoothstep(0.47, 0.59, mossInput));
      shade[base + 3] = toByte(smoothstep(0.25, 0.75, valueNoise(x * 0.21 + 3.7, z * 0.21 + 3.7, SEED_BLEND)));
    }
  }
  // Texel centres are ½ texel inside the rectangle's covered area; pad by one texel so bilinear filtering never clips a weight.
  const terrainRect: [number, number, number, number] = Number.isFinite(rectMinX)
    ? [rectMinX - MASK_TEXEL, rectMinZ - MASK_TEXEL, rectMaxX + MASK_TEXEL, rectMaxZ + MASK_TEXEL]
    : [0, 0, 0, 0];

  const detailWidth = Math.ceil((max.x - min.x) / DETAIL_TEXEL);
  const detailHeight = Math.ceil((max.z - min.z) / DETAIL_TEXEL);
  const detail = new Uint8Array(detailWidth * detailHeight * 4);
  new Uint32Array(detail.buffer).fill(0x80808080);
  const near = rasterizeNearest(segments, min.x, min.z, detailWidth, detailHeight, DETAIL_TEXEL, 1.7);
  const phaseScale = (Math.PI * 2) / STEP_PERIOD;
  for (let index = 0; index < near.normalized.length; index++) {
    if (near.normalized[index]! >= 1.7) continue;
    const phase = near.arc[index]! * phaseScale;
    const base = index * 4;
    const grainX = min.x + ((index % detailWidth) + 0.5) * DETAIL_TEXEL;
    const grainZ = min.z + (Math.floor(index / detailWidth) + 0.5) * DETAIL_TEXEL;
    detail[base] = toByte(Math.cos(phase) * 0.5 + 0.5);
    detail[base + 1] = toByte(Math.sin(phase) * 0.5 + 0.5);
    detail[base + 2] = toByte(near.lateral[index]! / 4 + 0.5);
    detail[base + 3] = toByte(valueNoise(grainX * 2.6, grainZ * 2.6, SEED_GRAIN));
  }
  return { minX: min.x, minZ: min.z, width, height, texel: MASK_TEXEL, data, shade, terrain, terrainRect, edge, interior, detailWidth, detailHeight, detailTexel: DETAIL_TEXEL, detail, segments };
}

/** Bilinear splat weights at a world position (0..1 each); `out` is overwritten. */
export function sampleMask(mask: GroundMask, x: number, z: number, out: MaskSample): MaskSample {
  const gx = Math.max(0, Math.min(mask.width - 1.000001, (x - mask.minX) / mask.texel - 0.5));
  const gz = Math.max(0, Math.min(mask.height - 1.000001, (z - mask.minZ) / mask.texel - 0.5));
  const col = Math.floor(gx);
  const row = Math.floor(gz);
  const fx = gx - col;
  const fz = gz - row;
  const i00 = (row * mask.width + col) * 4;
  const i10 = i00 + 4;
  const i01 = i00 + mask.width * 4;
  const i11 = i01 + 4;
  const d = mask.data;
  const w00 = (1 - fx) * (1 - fz);
  const w10 = fx * (1 - fz);
  const w01 = (1 - fx) * fz;
  const w11 = fx * fz;
  const k = 1 / 255;
  out.core = (d[i00]! * w00 + d[i10]! * w10 + d[i01]! * w01 + d[i11]! * w11) * k;
  out.shoulder = (d[i00 + 1]! * w00 + d[i10 + 1]! * w10 + d[i01 + 1]! * w01 + d[i11 + 1]! * w11) * k;
  out.walk = (d[i00 + 2]! * w00 + d[i10 + 2]! * w10 + d[i01 + 2]! * w01 + d[i11 + 2]! * w11) * k;
  out.moisture = (d[i00 + 3]! * w00 + d[i10 + 3]! * w10 + d[i01 + 3]! * w01 + d[i11 + 3]! * w11) * k;
  const e = mask.edge;
  const j00 = row * mask.width + col;
  out.edge = (e[j00]! * w00 + e[j00 + 1]! * w10 + e[j00 + mask.width]! * w01 + e[j00 + mask.width + 1]! * w11) * k;
  const n = mask.interior;
  out.interior = (n[j00]! * w00 + n[j00 + 1]! * w10 + n[j00 + mask.width]! * w01 + n[j00 + mask.width + 1]! * w11) * k;
  const t = mask.terrain;
  out.mud = (t[i00]! * w00 + t[i10]! * w10 + t[i01]! * w01 + t[i11]! * w11) * k;
  out.bed = (t[i00 + 1]! * w00 + t[i10 + 1]! * w10 + t[i01 + 1]! * w01 + t[i11 + 1]! * w11) * k;
  out.rock = (t[i00 + 2]! * w00 + t[i10 + 2]! * w10 + t[i01 + 2]! * w01 + t[i11 + 2]! * w11) * k;
  out.deck = (t[i00 + 3]! * w00 + t[i10 + 3]! * w10 + t[i01 + 3]! * w01 + t[i11 + 3]! * w11) * k;
  return out;
}
