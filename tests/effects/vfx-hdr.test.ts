import { describe, expect, it } from 'bun:test';
import { AdditiveBlending, BoxGeometry, Color, Group, Mesh, MeshStandardMaterial, type WebGLProgramParametersWithUniforms } from 'three';
import { ParticlePool, ParticleSpec } from '../../src/effects/vfx/GpuParticles.js';
import { createVfxAtlas } from '../../src/effects/vfx/VfxAtlas.js';
import { ActorHitFlash } from '../../src/effects/vfx/HitFlash.js';
import { HDR_DOMINANT_MAX, HDR_NEUTRAL_MAX, PALETTE } from '../../src/effects/vfx/palette.js';

/** Hue-preserving HDR rule: dominant channel ≤ 4; near-neutral (min ≥ 70 % of max) ≤ 1.5. */
function obeysRule(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return max <= HDR_DOMINANT_MAX + 1e-6 && (min < max * 0.7 || max <= HDR_NEUTRAL_MAX + 1e-6);
}

describe('hue-preserving HDR colour', () => {
  it('every element palette colour obeys the rule', () => {
    for (const [element, palette] of Object.entries(PALETTE)) for (const color of [palette.a, palette.b, palette.hot]) {
      expect({ element, ok: obeysRule(color.r, color.g, color.b) }).toEqual({ element, ok: true });
    }
  });

  it('particles cap overdriven colours without changing hue and reject non-finite spawns', () => {
    const atlas = createVfxAtlas();
    const pool = new ParticlePool('hdr-test', 8, atlas, AdditiveBlending);
    try {
      const spec = new ParticleSpec();
      spec.r0 = 12; spec.g0 = 4.8; spec.b0 = 1.2; spec.r1 = 9; spec.g1 = 9; spec.b1 = 8.5;
      const slot = pool.emit(spec, 0, 1);
      const color0 = pool.mesh.geometry.getAttribute('iColor0'), color1 = pool.mesh.geometry.getAttribute('iColor1');
      const r0 = color0.getX(slot), g0 = color0.getY(slot), b0 = color0.getZ(slot);
      expect(obeysRule(r0, g0, b0)).toBe(true);
      expect(g0 / r0).toBeCloseTo(4.8 / 12, 6);
      expect(b0 / r0).toBeCloseTo(1.2 / 12, 6);
      expect(obeysRule(color1.getX(slot), color1.getY(slot), color1.getZ(slot))).toBe(true);
      expect(Math.max(color1.getX(slot), color1.getY(slot), color1.getZ(slot))).toBeLessThanOrEqual(HDR_NEUTRAL_MAX + 1e-6);
      for (const key of ['x', 'vy', 'life', 'r0', 'size0'] as const) {
        const bad = new ParticleSpec();
        bad[key] = key === 'r0' ? Infinity : Number.NaN;
        expect(pool.emit(bad, 0, 2)).toBe(-1);
      }
      expect(pool.liveCount(0.1, 2)).toBe(0);
    } finally { pool.dispose(); atlas.dispose(); }
  });
});

function actor(): { root: Group; original: MeshStandardMaterial; mesh: Mesh } {
  const root = new Group(), original = new MeshStandardMaterial({ color: 0x7a5a3a });
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), original);
  root.add(mesh);
  return { root, original, mesh };
}
/** Runs the twin's real onBeforeCompile hook to reach the uniforms the GPU program would bind. */
function rimUniforms(mesh: Mesh): Record<string, { value: unknown }> {
  const material = mesh.material as MeshStandardMaterial;
  const shader = { uniforms: {}, fragmentShader: '#include <common>\n#include <emissivemap_fragment>' } as unknown as WebGLProgramParametersWithUniforms;
  material.onBeforeCompile(shader, undefined as never);
  return shader.uniforms;
}

describe('actor rim flash', () => {
  it('charge glow is a tinted rim capped at 1.5 with no body term, and the original material returns', () => {
    const flash = new ActorHitFlash(), { root, original, mesh } = actor();
    try {
      flash.flash(root, new Color(8, 3, 0.5), 10, 0.5, 'charge');
      expect(mesh.material).not.toBe(original);
      const uniforms = rimUniforms(mesh);
      let peak = 0;
      for (let i = 0; i < 29; i++) { flash.update(1 / 60); peak = Math.max(peak, uniforms.uHitStrength!.value as number); }
      expect(peak).toBeGreaterThan(0.5);
      expect(peak).toBeLessThanOrEqual(1.5);
      expect(uniforms.uHitBase!.value).toBe(0);
      const tint = uniforms.uHitColor!.value as Color;
      expect(Math.max(tint.r, tint.g, tint.b)).toBeCloseTo(1, 6);
      expect(tint.g / tint.r).toBeCloseTo(3 / 8, 6);
      flash.update(0.1);
      expect(mesh.material).toBe(original);
    } finally { flash.dispose(); }
  });

  it('hit flash is a short pulse capped at 2.0 that decays to zero and overrides a charge glow', () => {
    const flash = new ActorHitFlash(), { root, original, mesh } = actor();
    try {
      flash.flash(root, new Color(0, 1, 0), 1, 1, 'charge');
      flash.flash(root, new Color(1, 0.1, 0.05), 9, 0.2, 'hit');
      const uniforms = rimUniforms(mesh);
      expect(uniforms.uHitStrength!.value).toBe(2);
      expect(uniforms.uHitBase!.value as number).toBeLessThanOrEqual(0.1);
      flash.flash(root, new Color(0, 1, 0), 1, 1, 'charge');
      expect((uniforms.uHitColor!.value as Color).g).toBeLessThan(0.2);
      flash.update(0.21);
      expect(mesh.material).toBe(original);
      expect(uniforms.uHitStrength!.value).toBe(0);
    } finally { flash.dispose(); }
  });
});
