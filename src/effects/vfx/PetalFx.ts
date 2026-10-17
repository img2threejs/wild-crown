import { VFX_FRAME } from './VfxAtlas.js';
import type { VfxSystem } from './VfxSystem.js';

/**
 * Heartroot petal particle shapes shared by the cue kits (`HeartrootCues`) and the snapshot-driven actor effects (`ActorVfx`):
 * petal pink/ivory/amber over-blended sprites, all drawn from the shared alpha particle pool.
 */

/** Petals orbiting (x, y, z) at `radius` while climbing at `rise` m/s; `dir` (±1) picks the swirl handedness. */
export function emitPetalSwirl(vfx: VfxSystem, owner: number, x: number, y: number, z: number, count: number, radius: number, rise: number, dir: number): void {
  for (let i = vfx.count(count); i > 0; i--) {
    const p = vfx.spec(), angle = (i / count) * Math.PI * 2 + vfx.random() * 0.5, r = radius * vfx.range(0.6, 1.1), speed = 3.2 * dir;
    p.x = x + Math.cos(angle) * r; p.y = y + vfx.range(0, 0.5); p.z = z + Math.sin(angle) * r;
    p.vx = -Math.sin(angle) * speed; p.vz = Math.cos(angle) * speed; p.vy = rise * vfx.range(0.5, 1.1); p.drag = 1.2; p.gravity = 0.4;
    p.frame = VFX_FRAME.leaf; p.life = vfx.range(0.6, 1.1); p.size0 = vfx.range(0.12, 0.2); p.size1 = 0.05; p.spin = vfx.random() * 6; p.spinRate = vfx.range(-7, 7);
    p.r0 = p.r1 = 1; p.g0 = p.g1 = i % 3 ? 0.5 : 0.88; p.b0 = p.b1 = i % 3 ? 0.68 : 0.76; p.a0 = 0.9; p.fadeIn = 0.05; p.fadeOut = 0.6;
    vfx.emit(vfx.particles.alpha, owner);
  }
}

/** A flat ring of petals thrown outward along the ground (Heartroot's counterpart of a wind disc). */
export function emitPetalRing(vfx: VfxSystem, owner: number, x: number, y: number, z: number, count: number, radius: number): void {
  for (let i = vfx.count(count); i > 0; i--) {
    const p = vfx.spec(), angle = (i / count) * Math.PI * 2 + vfx.random() * 0.3, speed = radius * vfx.range(2.2, 3.4);
    p.x = x + Math.cos(angle) * radius * 0.2; p.y = y + 0.1; p.z = z + Math.sin(angle) * radius * 0.2;
    p.vx = Math.cos(angle) * speed; p.vz = Math.sin(angle) * speed; p.vy = vfx.range(0.2, 0.8); p.drag = 3.2; p.gravity = 0.5;
    p.frame = VFX_FRAME.leaf; p.life = vfx.range(0.6, 1); p.size0 = vfx.range(0.12, 0.2); p.size1 = 0.05; p.spin = vfx.random() * 6; p.spinRate = vfx.range(-8, 8);
    p.r0 = p.r1 = 1; p.g0 = p.g1 = i % 3 ? 0.55 : 0.9; p.b0 = p.b1 = i % 3 ? 0.62 : 0.76; p.a0 = 0.9; p.fadeIn = 0.04; p.fadeOut = 0.6;
    vfx.emit(vfx.particles.alpha, owner);
  }
}
