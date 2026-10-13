import { DataTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RGBAFormat } from 'three';

/** Frame indices in the 4×3 procedural atlas; row 0 is the bottom row (v = 0). `star` is a four-point flare, `cut` a thin tapered line, `drop` a hard round droplet, `mote` a tiny soft dot. */
export const VFX_FRAME = { glow: 0, smoke: 1, spark: 2, ember: 3, shard: 4, leaf: 5, ring: 6, flame: 7, star: 8, cut: 9, drop: 10, mote: 11 } as const;
export type VfxFrame = typeof VFX_FRAME[keyof typeof VFX_FRAME];
export const ATLAS_COLUMNS = 4;
export const ATLAS_ROWS = 3;
const CELL = 128;

function hash(x: number, y: number, seed: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed), c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function fbm(x: number, y: number, seed: number): number {
  let value = 0, amplitude = 0.5;
  for (let octave = 0; octave < 4; octave++) { value += amplitude * valueNoise(x, y, seed + octave * 13); x *= 2.03; y *= 2.03; amplitude *= 0.5; }
  return value;
}
const clamp01 = (value: number): number => value < 0 ? 0 : value > 1 ? 1 : value;
const smooth = (edge0: number, edge1: number, value: number): number => { const t = clamp01((value - edge0) / (edge1 - edge0)); return t * t * (3 - 2 * t); };

/** Returns [luminance, alpha] for one frame at cell coordinates u, v ∈ [0, 1]. */
function shade(frame: VfxFrame, u: number, v: number, out: Float32Array): void {
  const x = u * 2 - 1, y = v * 2 - 1, r = Math.hypot(x, y);
  let lum = 1, alpha = 0;
  switch (frame) {
    case VFX_FRAME.glow: alpha = Math.exp(-r * r * 5.5) * smooth(1, 0.82, r); break;
    case VFX_FRAME.smoke: {
      const n = fbm(u * 4.2, v * 4.2, 3);
      alpha = smooth(1, 0.15, r + (n - 0.5) * 0.55) * (0.55 + 0.45 * n);
      lum = 0.62 + 0.38 * clamp01(v * 0.8 + n * 0.4);
      break;
    }
    case VFX_FRAME.spark: alpha = Math.pow(Math.max(0, 1 - Math.abs(x)), 1.3) * Math.exp(-y * y * 26); break;
    case VFX_FRAME.ember: alpha = Math.max(Math.exp(-r * r * 30), 0.45 * Math.exp(-r * r * 6)) * smooth(1, 0.85, r); break;
    case VFX_FRAME.shard: {
      const diamond = Math.abs(x) * 0.62 + Math.abs(y) * 2.4;
      alpha = smooth(1, 0.72, diamond);
      lum = 0.7 + 0.3 * clamp01(1 - Math.abs(y + x * 0.25) * 3);
      break;
    }
    case VFX_FRAME.leaf: {
      const width = 0.46 * Math.pow(Math.max(0, 1 - x * x), 0.8);
      alpha = smooth(width + 0.04, width - 0.02, Math.abs(y)) * smooth(1, 0.9, Math.abs(x));
      lum = 0.7 + 0.3 * smooth(0.0, 0.05, Math.abs(y)) - 0.2 * Math.exp(-y * y * 900);
      break;
    }
    case VFX_FRAME.ring: alpha = Math.exp(-Math.pow((r - 0.72) / 0.09, 2)) * smooth(1, 0.94, r); break;
    case VFX_FRAME.flame: {
      const n = fbm(u * 3.1, v * 2.4, 11);
      const width = 0.62 * Math.pow(clamp01(1 - v), 0.55) * clamp01(v * 3.5 + 0.2);
      alpha = smooth(width, width * 0.25, Math.abs(x) + (n - 0.5) * 0.35) * smooth(1, 0.7, v + (n - 0.5) * 0.3);
      lum = 0.75 + 0.25 * (1 - v);
      break;
    }
    case VFX_FRAME.star: {
      const horizontal = Math.pow(Math.max(0, 1 - Math.abs(x)), 2.4) * Math.exp(-y * y * 260);
      const vertical = Math.pow(Math.max(0, 1 - Math.abs(y)), 2.4) * Math.exp(-x * x * 260);
      const dx = (x + y) * Math.SQRT1_2, dy = (x - y) * Math.SQRT1_2;
      const diagonal = 0.35 * (Math.pow(Math.max(0, 1 - Math.abs(dx)), 3) * Math.exp(-dy * dy * 220) + Math.pow(Math.max(0, 1 - Math.abs(dy)), 3) * Math.exp(-dx * dx * 220));
      alpha = Math.min(1, horizontal + vertical + diagonal + Math.exp(-r * r * 26) * 0.9);
      break;
    }
    case VFX_FRAME.cut:
      alpha = Math.min(1, Math.pow(Math.max(0, 1 - Math.abs(x)), 0.55) * Math.exp(-y * y * 1400) + 0.22 * Math.pow(Math.max(0, 1 - Math.abs(x)), 2) * Math.exp(-y * y * 70));
      break;
    case VFX_FRAME.drop:
      alpha = smooth(0.95, 0.62, r);
      lum = 0.55 + 0.45 * clamp01(1 - Math.hypot(x + 0.25, y - 0.3) * 1.8);
      break;
    case VFX_FRAME.mote: alpha = Math.min(1, Math.exp(-r * r * 70) + 0.22 * Math.exp(-r * r * 9)) * smooth(1, 0.8, r); break;
  }
  out[0] = clamp01(lum); out[1] = clamp01(alpha);
}

/** White masks tinted per particle; created once per VFX owner and disposed with it. */
export function createVfxAtlas(): DataTexture {
  const width = CELL * ATLAS_COLUMNS, height = CELL * ATLAS_ROWS;
  const pixels = new Uint8Array(width * height * 4);
  const sample = new Float32Array(2);
  for (let frame = 0; frame < ATLAS_COLUMNS * ATLAS_ROWS; frame++) {
    const column = frame % ATLAS_COLUMNS, row = Math.floor(frame / ATLAS_COLUMNS);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      shade(frame as VfxFrame, (x + 0.5) / CELL, (y + 0.5) / CELL, sample);
      const offset = ((row * CELL + y) * width + column * CELL + x) * 4;
      const lum = Math.round(sample[0]! * 255);
      pixels[offset] = lum; pixels[offset + 1] = lum; pixels[offset + 2] = lum;
      pixels[offset + 3] = Math.round(sample[1]! * 255);
    }
  }
  const texture = new DataTexture(pixels, width, height, RGBAFormat);
  texture.name = 'vfx-procedural-atlas';
  texture.colorSpace = NoColorSpace;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}
