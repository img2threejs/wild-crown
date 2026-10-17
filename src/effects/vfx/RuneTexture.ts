import { DataTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RGBAFormat } from 'three';

/** Rune strokes in a unit glyph box (x right, y up): each glyph is a list of segments [x0, y0, x1, y1]. */
export const RUNE_GLYPHS: readonly (readonly number[])[] = [
  [0.5, 0, 0.5, 1, 0.5, 0.8, 0.85, 0.95, 0.5, 0.55, 0.85, 0.7],
  [0.2, 0, 0.2, 1, 0.2, 1, 0.8, 0.7, 0.8, 0.7, 0.8, 0],
  [0.25, 0, 0.25, 1, 0.25, 0.75, 0.75, 0.5, 0.75, 0.5, 0.25, 0.25],
  [0.3, 0, 0.3, 1, 0.3, 1, 0.8, 0.75, 0.3, 0.7, 0.8, 0.45],
  [0.25, 0, 0.25, 1, 0.25, 1, 0.75, 0.78, 0.75, 0.78, 0.25, 0.55, 0.25, 0.55, 0.8, 0],
  [0.75, 0.9, 0.25, 0.5, 0.25, 0.5, 0.75, 0.1],
  [0.2, 1, 0.8, 0, 0.8, 1, 0.2, 0],
  [0.25, 0, 0.25, 1, 0.25, 1, 0.75, 0.75, 0.75, 0.75, 0.25, 0.5],
  [0.25, 0, 0.25, 1, 0.75, 0, 0.75, 1, 0.25, 0.6, 0.75, 0.4],
  [0.5, 0, 0.5, 1, 0.2, 0.65, 0.8, 0.35],
  [0.5, 0, 0.5, 1, 0.5, 1, 0.25, 0.7, 0.5, 0.4, 0.8, 0.7],
  [0.5, 0, 0.5, 1, 0.5, 0.55, 0.15, 1, 0.5, 0.55, 0.85, 1],
];
export const RUNE_TEXTURE_SIZE = 512;
/** Glyph count around the rune band of the outer layer. */
export const RUNE_BAND_COUNT = 36;

const TAU = Math.PI * 2;
const BAND_INNER = 0.79, BAND_OUTER = 0.93;
const clamp01 = (value: number): number => value < 0 ? 0 : value > 1 ? 1 : value;
const smooth = (edge0: number, edge1: number, value: number): number => { const t = clamp01((value - edge0) / (edge1 - edge0)); return t * t * (3 - 2 * t); };

/** Distance from point to segment, in the caller's units. */
function segmentDistance(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0, dy = y1 - y0, lengthSq = dx * dx + dy * dy;
  const t = lengthSq > 0 ? clamp01(((px - x0) * dx + (py - y0) * dy) / lengthSq) : 0;
  return Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t));
}

/**
 * Procedural rune sigil, generated once: three independently rotating layers packed into the
 * R (outer: rings, tick marks, 36 rune glyphs), G (middle: rings, hexagram, knot dots) and B
 * (inner: ring, crescent moon, star) channels. Coordinates are unit-disc space (x, y ∈ [-1, 1]).
 */
export function createRuneTexture(): DataTexture {
  const size = RUNE_TEXTURE_SIZE, pixels = new Uint8Array(size * size * 4), pw = 2 / size;
  const line = (d: number, w: number): number => 1 - smooth(w - pw * 0.7, w + pw * 0.7, d);
  const bandStep = TAU / RUNE_BAND_COUNT, tickStep = TAU / 72, knotStep = TAU / 12, spokeStep = TAU / 24;
  const star: number[] = [];
  for (const base of [Math.PI / 2, -Math.PI / 2]) for (let k = 0; k < 3; k++) { const a0 = base + (k * TAU) / 3, a1 = base + ((k + 1) * TAU) / 3; star.push(Math.cos(a0) * 0.68, Math.sin(a0) * 0.68, Math.cos(a1) * 0.68, Math.sin(a1) * 0.68); }
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    const x = ((px + 0.5) / size) * 2 - 1, y = ((py + 0.5) / size) * 2 - 1, r = Math.hypot(x, y), theta = Math.atan2(y, x) + Math.PI;
    let outer = 0, mid = 0, inner = 0;
    if (r < 1.02 && r > 0.7) {
      outer = Math.max(line(Math.abs(r - 0.985), 0.011), 0.7 * line(Math.abs(r - 0.945), 0.005), line(Math.abs(r - 0.775), 0.008), 0.6 * line(Math.abs(r - 0.742), 0.004));
      if (r > 0.935 && r < 0.99) {
        const slot = theta / tickStep, nearest = Math.round(slot), major = ((nearest % 6) + 6) % 6 === 0;
        const arc = Math.abs(slot - nearest) * tickStep * r;
        if ((major && r < 0.975) || (!major && r > 0.952 && r < 0.972)) outer = Math.max(outer, 0.85 * line(arc, 0.0045));
      }
      if (r > BAND_INNER && r < BAND_OUTER) {
        const slot = theta / bandStep, index = Math.floor(slot) % RUNE_BAND_COUNT, glyph = RUNE_GLYPHS[index % RUNE_GLYPHS.length]!;
        // Local glyph box: along the band (u) and radially outward (v), kept inside a 12 % margin.
        const u = (slot - Math.floor(slot) - 0.5) * (bandStep * r) / 0.105 + 0.5, v = (r - BAND_INNER) / (BAND_OUTER - BAND_INNER);
        const gx = (u - 0.12) / 0.76, gy = (v - 0.12) / 0.76;
        if (gx > -0.2 && gx < 1.2 && gy > -0.2 && gy < 1.2) {
          let distance = Infinity;
          for (let s = 0; s < glyph.length; s += 4) distance = Math.min(distance, segmentDistance(gx, gy, glyph[s]!, glyph[s + 1]!, glyph[s + 2]!, glyph[s + 3]!));
          outer = Math.max(outer, 0.95 * line(distance * 0.1, 0.0062));
        }
      }
    }
    if (r > 0.45 && r < 0.72) {
      mid = Math.max(line(Math.abs(r - 0.68), 0.012), 0.6 * line(Math.abs(r - 0.655), 0.004), line(Math.abs(r - 0.5), 0.008));
      let hex = Infinity;
      for (let s = 0; s < star.length; s += 4) hex = Math.min(hex, segmentDistance(x, y, star[s]!, star[s + 1]!, star[s + 2]!, star[s + 3]!));
      mid = Math.max(mid, 0.85 * line(hex, 0.0055));
      const slot = theta / knotStep, nearest = Math.round(slot), knotTheta = nearest * knotStep;
      mid = Math.max(mid, line(Math.abs(Math.hypot(x - Math.cos(knotTheta - Math.PI) * 0.59, y - Math.sin(knotTheta - Math.PI) * 0.59) - 0.028), 0.0045));
      if (r > 0.5 && r < 0.545) { const spoke = theta / spokeStep; mid = Math.max(mid, 0.7 * line(Math.abs(spoke - Math.round(spoke)) * spokeStep * r, 0.004)); }
    }
    if (r < 0.46) {
      inner = Math.max(line(Math.abs(r - 0.4), 0.011), 0.6 * line(Math.abs(r - 0.372), 0.004));
      const outerDisc = Math.hypot(x, y) - 0.27, cut = Math.hypot(x - 0.1, y - 0.04) - 0.235;
      const crescent = Math.min(1 - smooth(-pw, pw, outerDisc), smooth(-pw, pw, cut));
      inner = Math.max(inner, crescent * 0.95);
      const sx = x - 0.12, sy = y - 0.02;
      inner = Math.max(inner, line(segmentDistance(sx, sy, -0.07, 0, 0.07, 0), 0.006), line(segmentDistance(sx, sy, 0, -0.07, 0, 0.07), 0.006));
      for (let k = 0; k < 8; k++) { const a = (k * TAU) / 8 + 0.2; inner = Math.max(inner, 0.8 * (1 - smooth(0.009, 0.014, Math.hypot(x - Math.cos(a) * 0.345, y - Math.sin(a) * 0.345)))); }
    }
    const o = (py * size + px) * 4;
    pixels[o] = Math.round(clamp01(outer) * 255); pixels[o + 1] = Math.round(clamp01(mid) * 255); pixels[o + 2] = Math.round(clamp01(inner) * 255);
    pixels[o + 3] = Math.max(pixels[o]!, pixels[o + 1]!, pixels[o + 2]!);
  }
  return toTexture(pixels, size, 'vfx-rune-sigil');
}

function toTexture(pixels: Uint8Array, size: number, name: string): DataTexture {
  const texture = new DataTexture(pixels, size, size, RGBAFormat);
  texture.name = name;
  texture.colorSpace = NoColorSpace;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** Heartroot glyphs: leaf vein, seed, fork, root, sprout, leaf, spiral, petal trio. Same unit box as `RUNE_GLYPHS`. */
export const HEARTROOT_GLYPHS: readonly (readonly number[])[] = [
  [0.5, 0, 0.5, 1, 0.5, 0.3, 0.25, 0.55, 0.5, 0.3, 0.75, 0.55, 0.5, 0.6, 0.3, 0.82, 0.5, 0.6, 0.7, 0.82],
  [0.5, 0.05, 0.2, 0.4, 0.2, 0.4, 0.5, 0.95, 0.5, 0.95, 0.8, 0.4, 0.8, 0.4, 0.5, 0.05],
  [0.5, 0, 0.5, 0.5, 0.5, 0.5, 0.2, 1, 0.5, 0.5, 0.8, 1, 0.5, 0.72, 0.34, 0.72],
  [0.5, 1, 0.5, 0.45, 0.5, 0.45, 0.2, 0.1, 0.5, 0.45, 0.8, 0.1, 0.5, 0.3, 0.5, 0],
  [0.5, 0, 0.5, 0.6, 0.5, 0.6, 0.15, 0.9, 0.5, 0.6, 0.85, 0.9],
  [0.2, 0.1, 0.5, 0.95, 0.5, 0.95, 0.8, 0.1, 0.2, 0.1, 0.8, 0.1],
  [0.5, 0.5, 0.7, 0.5, 0.7, 0.5, 0.7, 0.75, 0.7, 0.75, 0.3, 0.75, 0.3, 0.75, 0.3, 0.25, 0.3, 0.25, 0.8, 0.25],
  [0.5, 0.1, 0.5, 0.9, 0.5, 0.1, 0.15, 0.7, 0.5, 0.1, 0.85, 0.7],
];
/** Glyph count around the heartroot band (Aren's storm sigil uses `RUNE_BAND_COUNT`). */
export const HEARTROOT_BAND_COUNT = 24;

/**
 * Heartroot sigil, same channel layout as `createRuneTexture` but botanical: a vine-wave ring with leaf notches and 24
 * leaf/seed/root glyphs (R), a five-petal rosette with a root ring (G) and a seed spiral with a sprouting seed (B).
 */
export function createHeartrootRuneTexture(): DataTexture {
  const size = RUNE_TEXTURE_SIZE, pixels = new Uint8Array(size * size * 4), pw = 2 / size;
  const line = (d: number, w: number): number => 1 - smooth(w - pw * 0.7, w + pw * 0.7, d);
  const bandStep = TAU / HEARTROOT_BAND_COUNT, notchStep = TAU / 24;
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    const x = ((px + 0.5) / size) * 2 - 1, y = ((py + 0.5) / size) * 2 - 1, r = Math.hypot(x, y), theta = Math.atan2(y, x) + Math.PI;
    let outer = 0, mid = 0, inner = 0;
    if (r < 1.02 && r > 0.7) {
      const vine = 0.945 + 0.011 * Math.sin(theta * 18);
      outer = Math.max(line(Math.abs(r - 0.985), 0.011), 0.8 * line(Math.abs(r - vine), 0.006), line(Math.abs(r - 0.775), 0.008), 0.6 * line(Math.abs(r - 0.742), 0.004));
      if (r > 0.952 && r < 0.978) {
        // Leaf notches: short radial strokes pinched toward the ring.
        const slot = theta / notchStep, nearest = Math.round(slot), arc = Math.abs(slot - nearest) * notchStep * r;
        outer = Math.max(outer, 0.85 * line(arc, 0.0042 + 0.004 * (1 - Math.abs(r - 0.965) / 0.013)));
      }
      if (r > BAND_INNER && r < BAND_OUTER) {
        const slot = theta / bandStep, index = Math.floor(slot) % HEARTROOT_BAND_COUNT, glyph = HEARTROOT_GLYPHS[index % HEARTROOT_GLYPHS.length]!;
        const u = (slot - Math.floor(slot) - 0.5) * (bandStep * r) / 0.105 + 0.5, v = (r - BAND_INNER) / (BAND_OUTER - BAND_INNER);
        const gx = (u - 0.12) / 0.76, gy = (v - 0.12) / 0.76;
        if (gx > -0.2 && gx < 1.2 && gy > -0.2 && gy < 1.2) {
          let distance = Infinity;
          for (let s = 0; s < glyph.length; s += 4) distance = Math.min(distance, segmentDistance(gx, gy, glyph[s]!, glyph[s + 1]!, glyph[s + 2]!, glyph[s + 3]!));
          outer = Math.max(outer, 0.95 * line(distance * 0.1, 0.0062));
        }
      }
    }
    if (r > 0.45 && r < 0.72) {
      // Five-petal rosette (polar |cos| curve) over a root ring with twelve knots.
      const petal = 0.2 + 0.46 * Math.abs(Math.cos(2.5 * theta));
      mid = Math.max(line(Math.abs(r - petal) * 0.75, 0.011), 0.7 * line(Math.abs(r - 0.5), 0.007), 0.5 * line(Math.abs(r - 0.684), 0.004));
      const slot = theta / (TAU / 10), nearest = Math.round(slot), knotTheta = nearest * (TAU / 10);
      mid = Math.max(mid, line(Math.abs(Math.hypot(x - Math.cos(knotTheta - Math.PI) * 0.6, y - Math.sin(knotTheta - Math.PI) * 0.6) - 0.026), 0.0045));
    }
    if (r < 0.46) {
      inner = 0.6 * line(Math.abs(r - 0.4), 0.007);
      let spiral = Infinity;
      for (let k = 0; k < 3; k++) spiral = Math.min(spiral, Math.abs(r - (0.05 + 0.055 * (theta + k * TAU))));
      if (r > 0.06 && r < 0.38) inner = Math.max(inner, 0.9 * line(spiral, 0.0085));
      const seed = Math.abs(Math.hypot(x / 0.085, (y + 0.02) / 0.14) - 1) * 0.1, sprout = segmentDistance(x, y, 0, 0.1, 0.0, 0.27);
      inner = Math.max(inner, line(seed, 0.007), line(sprout, 0.0075), line(segmentDistance(x, y, 0, 0.22, 0.08, 0.3), 0.0065), line(segmentDistance(x, y, 0, 0.22, -0.08, 0.3), 0.0065));
    }
    const o = (py * size + px) * 4;
    pixels[o] = Math.round(clamp01(outer) * 255); pixels[o + 1] = Math.round(clamp01(mid) * 255); pixels[o + 2] = Math.round(clamp01(inner) * 255);
    pixels[o + 3] = Math.max(pixels[o]!, pixels[o + 1]!, pixels[o + 2]!);
  }
  return toTexture(pixels, size, 'vfx-heartroot-sigil');
}

/** Umbral glyphs: crescent, slit, kunai, crossed cuts, mask, fang, moon-notch, three-stroke claw. Same unit box as `RUNE_GLYPHS`. */
export const UMBRAL_GLYPHS: readonly (readonly number[])[] = [
  [0.75, 0.05, 0.3, 0.3, 0.3, 0.3, 0.25, 0.7, 0.25, 0.7, 0.7, 0.95],
  [0.5, 0, 0.5, 1, 0.42, 0.45, 0.58, 0.55],
  [0.5, 0, 0.5, 0.75, 0.5, 0.75, 0.3, 0.6, 0.5, 0.75, 0.7, 0.6, 0.5, 0.95, 0.5, 0.75],
  [0.15, 0.1, 0.85, 0.9, 0.15, 0.9, 0.85, 0.1],
  [0.2, 0.7, 0.5, 0.2, 0.5, 0.2, 0.8, 0.7, 0.2, 0.7, 0.8, 0.7],
  [0.3, 0.95, 0.4, 0.2, 0.4, 0.2, 0.55, 0.95, 0.7, 0.95, 0.6, 0.2],
  [0.65, 0.05, 0.25, 0.5, 0.25, 0.5, 0.65, 0.95, 0.5, 0.3, 0.5, 0.7],
  [0.25, 0.05, 0.4, 0.95, 0.45, 0.05, 0.6, 0.95, 0.65, 0.05, 0.8, 0.95],
];
/** Ember glyphs: flame, fist, knee, elbow, spark, star, rising flame pair, ring-and-dot. */
export const EMBER_GLYPHS: readonly (readonly number[])[] = [
  [0.5, 0, 0.25, 0.4, 0.25, 0.4, 0.5, 1, 0.5, 1, 0.75, 0.4, 0.75, 0.4, 0.5, 0, 0.5, 0.2, 0.5, 0.55],
  [0.2, 0.2, 0.2, 0.8, 0.2, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.2, 0.8, 0.2, 0.2, 0.2, 0.35, 0.2, 0.35, 0.8, 0.5, 0.2, 0.5, 0.8, 0.65, 0.2, 0.65, 0.8],
  [0.2, 0.05, 0.5, 0.5, 0.5, 0.5, 0.8, 0.3, 0.8, 0.3, 0.8, 0.95, 0.5, 0.5, 0.35, 0.95],
  [0.15, 0.9, 0.5, 0.1, 0.5, 0.1, 0.85, 0.9, 0.3, 0.5, 0.7, 0.5],
  [0.5, 0, 0.5, 1, 0.1, 0.5, 0.9, 0.5],
  [0.5, 0.05, 0.62, 0.38, 0.62, 0.38, 0.95, 0.4, 0.95, 0.4, 0.68, 0.6, 0.68, 0.6, 0.78, 0.95, 0.78, 0.95, 0.5, 0.75, 0.5, 0.75, 0.22, 0.95, 0.22, 0.95, 0.32, 0.6, 0.32, 0.6, 0.05, 0.4, 0.05, 0.4, 0.38, 0.38, 0.38, 0.38, 0.5, 0.05],
  [0.3, 0, 0.2, 0.5, 0.2, 0.5, 0.3, 1, 0.7, 0, 0.8, 0.5, 0.8, 0.5, 0.7, 1],
  [0.5, 0.1, 0.8, 0.5, 0.8, 0.5, 0.5, 0.9, 0.5, 0.9, 0.2, 0.5, 0.2, 0.5, 0.5, 0.1, 0.5, 0.45, 0.5, 0.55],
];

type StyledSigil = 'umbral' | 'ember';
const STYLED: Readonly<Record<StyledSigil, { readonly glyphs: readonly (readonly number[])[]; readonly count: number; readonly name: string }>> = {
  umbral: { glyphs: UMBRAL_GLYPHS, count: 28, name: 'vfx-umbral-sigil' },
  ember: { glyphs: EMBER_GLYPHS, count: 20, name: 'vfx-ember-sigil' },
};

/**
 * Umbral / ember sigil with the same channel layout as `createRuneTexture`.
 * Umbral: a razor double ring with crescent notches and 28 blade glyphs (R), eight interlocking crescent blades (G) and a crescent moon cut by a slit (B).
 * Ember: a flame-toothed ring with 20 fist/flame glyphs (R), an eight-point flame star over a ring (G) and a spiralling fire core (B).
 */
function createStyledRuneTexture(style: StyledSigil): DataTexture {
  const spec = STYLED[style], size = RUNE_TEXTURE_SIZE, pixels = new Uint8Array(size * size * 4), pw = 2 / size;
  const line = (d: number, w: number): number => 1 - smooth(w - pw * 0.7, w + pw * 0.7, d);
  const bandStep = TAU / spec.count, notchStep = TAU / 36;
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    const x = ((px + 0.5) / size) * 2 - 1, y = ((py + 0.5) / size) * 2 - 1, r = Math.hypot(x, y), theta = Math.atan2(y, x) + Math.PI;
    let outer = 0, mid = 0, inner = 0;
    if (r < 1.02 && r > 0.7) {
      outer = Math.max(line(Math.abs(r - 0.985), style === 'umbral' ? 0.006 : 0.011), 0.7 * line(Math.abs(r - 0.955), 0.004), line(Math.abs(r - 0.775), 0.008), 0.6 * line(Math.abs(r - 0.742), 0.004));
      if (r > 0.94 && r < 0.995) {
        // Umbral: slim crescent notches leaning with the ring; ember: triangular flame teeth.
        const slot = theta / notchStep, nearest = Math.round(slot), arc = Math.abs(slot - nearest) * notchStep * r;
        if (style === 'umbral') outer = Math.max(outer, 0.85 * line(arc + Math.abs(r - 0.965) * 0.35, 0.0034));
        else outer = Math.max(outer, 0.85 * (1 - smooth(0, 0.03 * (1 - (r - 0.94) / 0.055) + 0.001, arc)) * (r < 0.99 ? 1 : 0));
      }
      if (r > BAND_INNER && r < BAND_OUTER) {
        const slot = theta / bandStep, index = Math.floor(slot) % spec.count, glyph = spec.glyphs[index % spec.glyphs.length]!;
        const u = (slot - Math.floor(slot) - 0.5) * (bandStep * r) / 0.105 + 0.5, v = (r - BAND_INNER) / (BAND_OUTER - BAND_INNER);
        const gx = (u - 0.12) / 0.76, gy = (v - 0.12) / 0.76;
        if (gx > -0.2 && gx < 1.2 && gy > -0.2 && gy < 1.2) {
          let distance = Infinity;
          for (let s = 0; s < glyph.length; s += 4) distance = Math.min(distance, segmentDistance(gx, gy, glyph[s]!, glyph[s + 1]!, glyph[s + 2]!, glyph[s + 3]!));
          outer = Math.max(outer, 0.95 * line(distance * 0.1, 0.0062));
        }
      }
    }
    if (r > 0.45 && r < 0.72) {
      if (style === 'umbral') {
        // Eight crescent blades: each is the gap between two offset circles, so they interlock round the ring.
        const slot = theta / (TAU / 8), nearest = Math.round(slot), a = nearest * (TAU / 8) - Math.PI;
        const cx = Math.cos(a) * 0.58, cy = Math.sin(a) * 0.58, blade = Math.abs(Math.hypot(x - cx, y - cy) - 0.17), cut = Math.abs(Math.hypot(x - cx * 1.12, y - cy * 1.12) - 0.2);
        mid = Math.max(0.9 * line(Math.min(blade, cut), 0.0065), line(Math.abs(r - 0.69), 0.007), 0.6 * line(Math.abs(r - 0.47), 0.005));
      } else {
        // Eight-point flame star: alternating long and short spikes between a thin ring and an inner ring.
        const spike = 0.52 + 0.17 * Math.abs(Math.cos(4 * theta)) * (0.7 + 0.3 * Math.cos(8 * theta));
        mid = Math.max(line(Math.abs(r - spike) * 0.8, 0.011), 0.7 * line(Math.abs(r - 0.5), 0.007), 0.6 * line(Math.abs(r - 0.7), 0.005));
      }
    }
    if (r < 0.46) {
      if (style === 'umbral') {
        inner = Math.max(line(Math.abs(r - 0.4), 0.006), 0.5 * line(Math.abs(r - 0.372), 0.003));
        const moon = Math.min(1 - smooth(-pw, pw, Math.hypot(x, y) - 0.29), smooth(-pw, pw, Math.hypot(x - 0.12, y - 0.05) - 0.24));
        inner = Math.max(inner, moon * 0.95, line(segmentDistance(x, y, -0.1, -0.33, 0.12, 0.33), 0.0055));
      } else {
        inner = 0.6 * line(Math.abs(r - 0.4), 0.007);
        let spiral = Infinity;
        for (let k = 0; k < 2; k++) spiral = Math.min(spiral, Math.abs(r - (0.04 + 0.075 * (theta + k * TAU))));
        if (r > 0.05 && r < 0.38) inner = Math.max(inner, 0.9 * line(spiral, 0.009));
        const flame = Math.abs(Math.hypot(x / (0.1 - 0.05 * Math.max(0, y)), (y - 0.04) / 0.2) - 1) * 0.1;
        inner = Math.max(inner, line(flame, 0.007));
      }
    }
    const o = (py * size + px) * 4;
    pixels[o] = Math.round(clamp01(outer) * 255); pixels[o + 1] = Math.round(clamp01(mid) * 255); pixels[o + 2] = Math.round(clamp01(inner) * 255);
    pixels[o + 3] = Math.max(pixels[o]!, pixels[o + 1]!, pixels[o + 2]!);
  }
  return toTexture(pixels, size, spec.name);
}

export function createUmbralRuneTexture(): DataTexture { return createStyledRuneTexture('umbral'); }
export function createEmberRuneTexture(): DataTexture { return createStyledRuneTexture('ember'); }
