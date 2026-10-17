import { describe, expect, it } from 'bun:test';
import { BladeTrailFx, TRAIL_S_HIGH, TRAIL_S_LOW, TrailSampler, type TrailBuffers } from '../../src/effects/vfx/BladeTrailFx.js';
import { LineBatch } from '../../src/effects/vfx/LineBatch.js';
import { jaggedPath, pathPoints } from '../../src/effects/vfx/LightningGen.js';
import { HDR_DOMINANT_MAX, HDR_NEUTRAL_MAX, PALETTE } from '../../src/effects/vfx/palette.js';
import { RUNE_GLYPHS, RUNE_TEXTURE_SIZE, createRuneTexture } from '../../src/effects/vfx/RuneTexture.js';
import { Vector3 } from 'three';

const FRAME = 1 / 60;
const buffers = (): TrailBuffers => ({ positions: new Float32Array(192 * 6), uvs: new Float32Array(192 * 4), weights: new Float32Array(192 * 2) });
const obeysRule = (r: number, g: number, b: number): boolean => {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max <= HDR_DOMINANT_MAX + 1e-6 && (min < max * 0.7 || max <= HDR_NEUTRAL_MAX + 1e-6);
};

/** A blade sweeping `step` radians per frame around the origin: base at radius 0.4, tip at radius 1.5, height 1. */
function sweep(sampler: TrailSampler, frames: number, step: number, start = 0): void {
  for (let k = 0; k < frames; k++) {
    const a = start + k * step;
    sampler.push(Math.cos(a) * 0.4, 1, Math.sin(a) * 0.4, Math.cos(a) * 1.5, 1, Math.sin(a) * 1.5, (start / step + k) * FRAME, 1);
  }
}
/** Tip point of row `i` (the blade edge sits at s = 1). */
function tipOf(out: TrailBuffers, row: number, target = new Vector3()): Vector3 {
  const lo = new Vector3(out.positions[row * 6]!, out.positions[row * 6 + 1]!, out.positions[row * 6 + 2]!), hi = new Vector3(out.positions[row * 6 + 3]!, out.positions[row * 6 + 4]!, out.positions[row * 6 + 5]!);
  return target.lerpVectors(lo, hi, (1 - TRAIL_S_LOW) / (TRAIL_S_HIGH - TRAIL_S_LOW));
}
const cross2 = (ax: number, az: number, bx: number, bz: number): number => ax * bz - az * bx;
function segmentsCross(p: Vector3, q: Vector3, r: Vector3, s: Vector3): boolean {
  const d1 = cross2(q.x - p.x, q.z - p.z, r.x - p.x, r.z - p.z), d2 = cross2(q.x - p.x, q.z - p.z, s.x - p.x, s.z - p.z);
  const d3 = cross2(s.x - r.x, s.z - r.z, p.x - r.x, p.z - r.z), d4 = cross2(s.x - r.x, s.z - r.z, q.x - r.x, q.z - r.z);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

describe('blade trail sub-sampling', () => {
  it('inserts Catmull-Rom rows between frames, keeping time and swing order monotone and the crescent free of self-intersections', () => {
    const sampler = new TrailSampler(), out = buffers();
    sweep(sampler, 8, 0.3);
    const now = 7 * FRAME, rows = sampler.build(now, 0.2, out);
    expect(rows).toBeGreaterThan(8 * 2);
    let lastAge = Infinity, lastAngle = -Infinity;
    const tips: Vector3[] = [];
    for (let row = 0; row < rows; row++) {
      const age = out.uvs[row * 4]!, tip = tipOf(out, row), angle = Math.atan2(tip.z, tip.x);
      expect(age).toBeLessThanOrEqual(lastAge + 1e-9);
      expect(angle).toBeGreaterThan(lastAngle);
      expect(Math.hypot(tip.x, tip.z)).toBeGreaterThan(1.3);
      expect(Math.hypot(tip.x, tip.z)).toBeLessThan(1.7);
      lastAge = age; lastAngle = angle;
      tips.push(tip);
    }
    for (let i = 0; i + 1 < tips.length; i++) for (let j = i + 2; j + 1 < tips.length; j++) expect(segmentsCross(tips[i]!, tips[i + 1]!, tips[j]!, tips[j + 1]!)).toBe(false);
    // The strip passes exactly through the recorded first and last frame.
    expect(tips[0]!.distanceTo(new Vector3(1.5, 1, 0))).toBeLessThan(1e-4);
    expect(tips[rows - 1]!.distanceTo(new Vector3(Math.cos(2.1) * 1.5, 1, Math.sin(2.1) * 1.5))).toBeLessThan(1e-4);
  });

  it('dies within its lifetime, ignores repeated instants (hit-stop), restarts after a gap and rejects bad samples', () => {
    const sampler = new TrailSampler(), out = buffers();
    sweep(sampler, 6, 0.3);
    const last = 5 * FRAME;
    expect(sampler.build(last, 0.16, out)).toBeGreaterThanOrEqual(2);
    expect(sampler.build(last + 0.1, 0.16, out)).toBeGreaterThanOrEqual(2);
    expect(sampler.build(last + 0.1, 0.16, out)).toBeLessThan(sampler.build(last, 0.16, out));
    expect(sampler.build(last + 0.16 + 1e-6, 0.16, out)).toBe(0);
    expect(sampler.push(0, 0, 0, 1, 1, 1, last, 1)).toBe(false);
    expect(sampler.push(Number.NaN, 0, 0, 1, 1, 1, last + FRAME, 1)).toBe(false);
    const size = sampler.size;
    expect(sampler.push(0, 0, 0, 1, 1, 1, last + 1, 1)).toBe(true);
    expect(sampler.size).toBe(1);
    expect(size).toBeGreaterThan(1);
  });

  it('reports the newest tip direction for the hit cut line', () => {
    const sampler = new TrailSampler(), direction = { x: 0, y: 0, z: 0 };
    expect(sampler.tipDirection(direction)).toBe(false);
    sweep(sampler, 3, 0.3);
    expect(sampler.tipDirection(direction)).toBe(true);
    expect(Math.hypot(direction.x, direction.y, direction.z)).toBeCloseTo(1, 6);
    expect(direction.z).toBeGreaterThan(0);
  });

  it('the mesh shows only while samples are younger than the trail life and its colours obey the palette rule', () => {
    const trail = new BladeTrailFx();
    try {
      const uniforms = trail.mesh.material.uniforms as Record<string, { value: { r: number; g: number; b: number } }>;
      for (const element of ['arcane', 'gold', 'judgement'] as const) {
        trail.setStyle(element, 1.4, 0.2);
        for (const key of ['uEdge', 'uBody', 'uGlow']) expect(obeysRule(uniforms[key]!.value.r, uniforms[key]!.value.g, uniforms[key]!.value.b)).toBe(true);
      }
      trail.setStyle('arcane', 1, 0.16);
      for (let k = 0; k < 6; k++) trail.push(Math.cos(k * 0.3) * 0.4, 1, Math.sin(k * 0.3) * 0.4, Math.cos(k * 0.3) * 1.5, 1, Math.sin(k * 0.3) * 1.5, k * FRAME, 1);
      trail.update(5 * FRAME);
      expect(trail.mesh.visible).toBe(true);
      expect(trail.visibleRows).toBeGreaterThan(6);
      trail.update(5 * FRAME + 0.2);
      expect(trail.mesh.visible).toBe(false);
      expect(trail.visibleRows).toBe(0);
    } finally { trail.dispose(); }
  });
});

describe('line batch', () => {
  it('caps HDR colours per hue, rejects non-finite or over-capacity polylines and hides when empty', () => {
    const lines = new LineBatch(8);
    try {
      lines.begin(new Vector3(10, 12, 14));
      lines.style.cr = 12; lines.style.cg = 4.8; lines.style.cb = 1.2; lines.style.gr = 9; lines.style.gg = 9; lines.style.gb = 8.5;
      expect(lines.add([0, 0, 0, 1, 0, 0, 2, 0, 1], 3)).toBe(true);
      expect(lines.add([0, 0, 0, Number.NaN, 0, 0], 2)).toBe(false);
      expect(lines.add(new Float32Array(30), 10)).toBe(false);
      lines.end();
      const core = lines.mesh.geometry.getAttribute('aCore'), glow = lines.mesh.geometry.getAttribute('aGlow');
      expect(obeysRule(core.getX(0), core.getY(0), core.getZ(0))).toBe(true);
      expect(core.getY(0) / core.getX(0)).toBeCloseTo(4.8 / 12, 6);
      expect(Math.max(glow.getX(0), glow.getY(0), glow.getZ(0))).toBeLessThanOrEqual(HDR_NEUTRAL_MAX + 1e-6);
      expect(lines.mesh.visible).toBe(true);
      expect(lines.usedPoints).toBe(3);
      lines.begin(new Vector3()); lines.end();
      expect(lines.mesh.visible).toBe(false);
    } finally { lines.dispose(); }
  });
});

describe('procedural lightning and rune texture', () => {
  it('midpoint displacement keeps exact endpoints, finite points and bounded, reproducible jitter', () => {
    const levels = 5, a = new Vector3(0.3, 9, -0.2), b = new Vector3(0, 0, 0);
    const make = (): Float32Array => {
      let seed = 7;
      const random = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      const out = new Float32Array(pathPoints(levels) * 3);
      expect(jaggedPath(out, a.x, a.y, a.z, b.x, b.y, b.z, levels, 0.2, random)).toBe(pathPoints(levels));
      return out;
    };
    const out = make();
    expect(Array.from(make())).toEqual(Array.from(out));
    expect(Array.from(out.slice(0, 3))).toEqual([Math.fround(a.x), Math.fround(a.y), Math.fround(a.z)]);
    expect(Array.from(out.slice(-3))).toEqual([0, 0, 0]);
    const axis = b.clone().sub(a), length = axis.length();
    axis.normalize();
    for (let i = 0; i < out.length / 3; i++) {
      const point = new Vector3(out[i * 3], out[i * 3 + 1], out[i * 3 + 2]).sub(a);
      expect(Number.isFinite(point.x + point.y + point.z)).toBe(true);
      expect(point.clone().addScaledVector(axis, -point.dot(axis)).length()).toBeLessThanOrEqual(3.5 * 0.2 * length);
    }
  });

  it('rune texture packs three populated layers, a glyph set inside its box, and is deterministic', () => {
    expect(RUNE_GLYPHS.length).toBeGreaterThanOrEqual(12);
    for (const glyph of RUNE_GLYPHS) { expect(glyph.length % 4).toBe(0); for (const value of glyph) { expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThanOrEqual(1); } }
    const first = createRuneTexture(), second = createRuneTexture();
    try {
      const data = first.image.data as Uint8Array, again = second.image.data as Uint8Array, covered = [0, 0, 0];
      expect(first.image.width).toBe(RUNE_TEXTURE_SIZE);
      for (let i = 0; i < data.length; i += 4) { for (let c = 0; c < 3; c++) if (data[i + c]! > 128) covered[c]!++; expect(data[i + 3]).toBe(Math.max(data[i]!, data[i + 1]!, data[i + 2]!)); }
      for (const count of covered) { expect(count).toBeGreaterThan(1500); expect(count).toBeLessThan(RUNE_TEXTURE_SIZE * RUNE_TEXTURE_SIZE * 0.3); }
      expect(Buffer.from(data).equals(Buffer.from(again))).toBe(true);
      // The disc corners stay empty: nothing is drawn outside the unit circle.
      expect(data[3]).toBe(0);
    } finally { first.dispose(); second.dispose(); }
  });

  it('the new Warden palettes (arcane, lightning, gold, judgement) obey the HDR colour rule', () => {
    for (const element of ['arcane', 'lightning', 'gold', 'judgement'] as const) for (const color of [PALETTE[element].a, PALETTE[element].b, PALETTE[element].hot]) expect(obeysRule(color.r, color.g, color.b)).toBe(true);
  });
});
