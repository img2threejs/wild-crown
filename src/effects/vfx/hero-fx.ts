import { Color, Matrix4, Quaternion, Vector3 } from 'three';
import { VFX_FRAME } from './VfxAtlas.js';
import type { VfxSystem } from './VfxSystem.js';

/** Hue pair of a thin additive effect: `hot` is the thin HDR core, `body` the saturated body. */
export interface Tint { readonly hot: { readonly r: number; readonly g: number; readonly b: number }; readonly body: { readonly r: number; readonly g: number; readonly b: number } }

const F = new Vector3();
const S = new Vector3();
const N = new Vector3();
const M = new Matrix4();

/**
 * Orientation of a crescent blade (`CrescentFx`: chord along local X, convex edge toward local +Y) swung along `heading` (yaw, radians; local +Z is
 * `(sin, cos)` like the footprints): the convex edge leads, `tilt` raises the leading edge and `roll` banks the blade around the travel direction.
 */
export function crescentOrientation(out: Quaternion, heading: number, tilt: number, roll: number): Quaternion {
  const sinH = Math.sin(heading), cosH = Math.cos(heading), cosT = Math.cos(tilt), sinT = Math.sin(tilt), cosR = Math.cos(roll), sinR = Math.sin(roll);
  S.set(cosH, 0, -sinH);
  F.set(sinH * cosT, sinT, cosH * cosT);
  N.crossVectors(S, F);
  // Bank the (side, normal) pair around the forward axis.
  const sx = S.x * cosR + N.x * sinR, sy = S.y * cosR + N.y * sinR, sz = S.z * cosR + N.z * sinR;
  const nx = N.x * cosR - S.x * sinR, ny = N.y * cosR - S.y * sinR, nz = N.z * cosR - S.z * sinR;
  S.set(sx, sy, sz); N.set(nx, ny, nz);
  M.makeBasis(S, F, N);
  return out.setFromRotationMatrix(M);
}

/** Heading (yaw) of the horizontal vector (dx, dz); 0 when it is degenerate. */
export function headingOf(dx: number, dz: number): number { return Math.abs(dx) + Math.abs(dz) < 1e-6 ? 0 : Math.atan2(dx, dz); }

/** Velocity-stretched additive sparks in a cone around `up`, like `VfxSystem.sparks` but with an explicit tint (crimson rims, gold sparks). */
export function tintSparks(vfx: VfxSystem, owner: number, x: number, y: number, z: number, count: number, speed: number, tint: Tint, upBias = 0.4): void {
  for (let i = vfx.count(count); i > 0; i--) {
    const p = vfx.spec(), a = vfx.random() * Math.PI * 2, up = upBias + (1 - upBias) * vfx.random(), s = speed * vfx.range(0.45, 1), flat = Math.sqrt(Math.max(0, 1 - up * up));
    p.x = x; p.y = y; p.z = z; p.vx = Math.cos(a) * flat * s; p.vy = up * s; p.vz = Math.sin(a) * flat * s;
    p.gravity = 7; p.drag = 1.6; p.life = vfx.range(0.3, 0.65); p.size0 = vfx.range(0.04, 0.07); p.size1 = 0.02; p.frame = VFX_FRAME.spark; p.stretch = 0.09;
    p.r0 = tint.hot.r; p.g0 = tint.hot.g; p.b0 = tint.hot.b; p.r1 = tint.body.r; p.g1 = tint.body.g; p.b1 = tint.body.b; p.fadeIn = 0.02; p.fadeOut = 0.5;
    vfx.emit(vfx.particles.additive, owner);
  }
}

/** Sparks fired along (dx, dy, dz) (unit) in a narrow cone: the spray of a strike, a thrown blade, a kick. */
export function directedSparks(vfx: VfxSystem, owner: number, x: number, y: number, z: number, dx: number, dy: number, dz: number, count: number, speed: number, spread: number, tint: Tint): void {
  for (let i = vfx.count(count); i > 0; i--) {
    const p = vfx.spec(), s = speed * vfx.range(0.5, 1);
    p.x = x; p.y = y; p.z = z;
    p.vx = (dx + vfx.range(-spread, spread)) * s; p.vy = (dy + vfx.range(-spread, spread)) * s; p.vz = (dz + vfx.range(-spread, spread)) * s;
    p.gravity = 4; p.drag = 1.3; p.life = vfx.range(0.22, 0.5); p.size0 = vfx.range(0.04, 0.075); p.size1 = 0.02; p.frame = VFX_FRAME.spark; p.stretch = 0.1;
    p.r0 = tint.hot.r; p.g0 = tint.hot.g; p.b0 = tint.hot.b; p.r1 = tint.body.r; p.g1 = tint.body.g; p.b1 = tint.body.b; p.fadeIn = 0.02; p.fadeOut = 0.5;
    vfx.emit(vfx.particles.additive, owner);
  }
}

/** Sparks distributed along the segment a → b that barely move: the afterglow of a dash, blink or blade lane. */
export function laneSparks(vfx: VfxSystem, owner: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, count: number, spread: number, tint: Tint): void {
  for (let i = vfx.count(count); i > 0; i--) {
    const p = vfx.spec(), t = vfx.random();
    p.x = ax + (bx - ax) * t + vfx.range(-spread, spread); p.y = ay + (by - ay) * t + vfx.range(-spread, spread) * 0.6; p.z = az + (bz - az) * t + vfx.range(-spread, spread);
    p.vx = vfx.range(-0.6, 0.6); p.vy = vfx.range(0, 1.2); p.vz = vfx.range(-0.6, 0.6); p.drag = 1.8; p.gravity = 1.5; p.life = vfx.range(0.3, 0.6);
    p.size0 = vfx.range(0.04, 0.07); p.size1 = 0.015; p.frame = VFX_FRAME.mote;
    p.r0 = tint.hot.r; p.g0 = tint.hot.g; p.b0 = tint.hot.b; p.r1 = tint.body.r; p.g1 = tint.body.g; p.b1 = tint.body.b; p.a0 = 0.85; p.fadeIn = 0.05; p.fadeOut = 0.6;
    vfx.emit(vfx.particles.additive, owner);
  }
}

/** One razor cut sprite (`VFX_FRAME.cut`) at (x, y, z) stretched along (tx, ty, tz); `length` is the visible chord in metres. */
export function cutSprite(vfx: VfxSystem, owner: number, x: number, y: number, z: number, tx: number, ty: number, tz: number, length: number, life: number, tint: Tint): void {
  const p = vfx.spec();
  p.x = x; p.y = y; p.z = z; p.vx = tx * 0.05; p.vy = ty * 0.05; p.vz = tz * 0.05; p.stretch = 0.01;
  p.frame = VFX_FRAME.cut; p.life = life; p.size0 = length * 0.7; p.size1 = length;
  p.r0 = p.r1 = tint.hot.r; p.g0 = p.g1 = tint.hot.g; p.b0 = p.b1 = tint.hot.b; p.a0 = 1; p.fadeIn = 0.04; p.fadeOut = 0.5;
  vfx.emit(vfx.particles.additive, owner);
}

/** Camera-facing star flash (a thin additive glint that never grows into a disc). */
export function starFlash(vfx: VfxSystem, owner: number, x: number, y: number, z: number, size: number, life: number, tint: Tint): void {
  const p = vfx.spec();
  p.x = x; p.y = y; p.z = z; p.frame = VFX_FRAME.star; p.life = life; p.size0 = size * 0.5; p.size1 = size; p.spin = vfx.random() * 6.28;
  p.r0 = p.r1 = tint.hot.r; p.g0 = p.g1 = tint.hot.g; p.b0 = p.b1 = tint.hot.b; p.a0 = 0.9; p.fadeIn = 0.05; p.fadeOut = 0.5;
  vfx.emit(vfx.particles.additive, owner);
}

/** Alpha smoke puffs that fly INTO (x, y, z) from `radius`: a shadow collapsing onto a point. */
export function implode(vfx: VfxSystem, owner: number, x: number, y: number, z: number, count: number, radius: number, size: number, color: Color, alpha: number): void {
  for (let i = vfx.count(count); i > 0; i--) {
    const p = vfx.spec(), theta = vfx.random() * Math.PI * 2, phi = Math.acos(vfx.range(-0.5, 1)), r = radius * vfx.range(0.7, 1.1);
    const ox = Math.sin(phi) * Math.cos(theta) * r, oy = Math.cos(phi) * r * 0.9, oz = Math.sin(phi) * Math.sin(theta) * r;
    p.life = vfx.range(0.18, 0.3);
    p.x = x + ox; p.y = y + oy; p.z = z + oz; p.vx = -ox / p.life; p.vy = -oy / p.life; p.vz = -oz / p.life; p.drag = 0;
    p.size0 = size; p.size1 = size * 0.25; p.frame = VFX_FRAME.smoke; p.spin = vfx.random() * 6.28; p.spinRate = vfx.range(-3, 3);
    p.r0 = p.r1 = color.r; p.g0 = p.g1 = color.g; p.b0 = p.b1 = color.b; p.a0 = alpha; p.fadeIn = 0.15; p.fadeOut = 0.5;
    vfx.emit(vfx.particles.alpha, owner);
  }
}

/** A standing body-shaped column of alpha puffs (a fading silhouette / shade) with a faint additive rim glow; sizes follow a human height `height`. */
export function silhouette(vfx: VfxSystem, owner: number, x: number, y: number, z: number, height: number, life: number, color: Color, alpha: number, rim: Tint): void {
  const steps = vfx.reducedEffects ? 2 : 4;
  for (let i = 0; i < steps; i++) {
    const f = (i + 0.5) / steps, p = vfx.spec(), width = i === steps - 1 ? 0.3 : i === 0 ? 0.34 : 0.4;
    p.x = x; p.y = y + height * f; p.z = z; p.vy = 0.15; p.drag = 1.2; p.life = life; p.size0 = width * 1.6; p.size1 = width * 2.1;
    p.frame = VFX_FRAME.smoke; p.spin = vfx.random() * 6.28; p.spinRate = vfx.range(-0.5, 0.5);
    p.r0 = p.r1 = color.r; p.g0 = p.g1 = color.g; p.b0 = p.b1 = color.b; p.a0 = alpha; p.fadeIn = 0.05; p.fadeOut = 0.85;
    vfx.emit(vfx.particles.alpha, owner);
    p.frame = VFX_FRAME.glow; p.size0 = width * 2.2; p.size1 = width * 2.8; p.a0 = 0.18; p.fadeIn = 0.1;
    p.r0 = p.r1 = rim.body.r; p.g0 = p.g1 = rim.body.g; p.b0 = p.b1 = rim.body.b;
    vfx.emit(vfx.particles.additive, owner);
  }
}

/**
 * Remembers the point impacts a hero kit drew (projectile impacts) so the engine's same-tick `hit` cue for the same contact adds no second burst.
 * A contact matches on world tick and clip, then on the struck target (or, with no target ids, within `POINT_MARGIN` metres).
 */
export class ContactLedger {
  static readonly SIZE = 16;
  static readonly POINT_MARGIN = 1.6;
  private readonly tick = new Float64Array(ContactLedger.SIZE).fill(-Infinity);
  private readonly owner = new Int32Array(ContactLedger.SIZE).fill(-1);
  private readonly x = new Float32Array(ContactLedger.SIZE);
  private readonly z = new Float32Array(ContactLedger.SIZE);
  private readonly action: string[] = new Array<string>(ContactLedger.SIZE).fill('');
  private readonly target: string[] = new Array<string>(ContactLedger.SIZE).fill('');
  private readonly used = new Uint8Array(ContactLedger.SIZE);
  private cursor = 0;

  record(tick: number, action: string, owner: number, x: number, z: number, target: string): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % ContactLedger.SIZE;
    this.tick[i] = tick; this.action[i] = action; this.owner[i] = owner; this.x[i] = x; this.z[i] = z; this.target[i] = target; this.used[i] = 0;
  }

  /** True when a drawn contact of this tick and clip covers it (each recorded contact covers one duplicate). */
  claim(tick: number, action: string, x: number, z: number, target: string): boolean {
    for (let i = 0; i < ContactLedger.SIZE; i++) {
      if (this.tick[i] !== tick || this.action[i] !== action || this.used[i]) continue;
      const known = this.target[i]!;
      if (known && target ? known !== target : Math.hypot(x - this.x[i]!, z - this.z[i]!) > ContactLedger.POINT_MARGIN) continue;
      this.used[i] = 1;
      return true;
    }
    return false;
  }

  /** Forgets the contacts of one cue scope (cancellation) or of every scope. */
  forget(owner?: number): void {
    for (let i = 0; i < ContactLedger.SIZE; i++) if (owner === undefined || this.owner[i] === owner) this.tick[i] = -Infinity;
  }
}

/** Unit horizontal direction a → b (falls back to (fx, fz)); returns the horizontal distance. */
export function horizontalDirection(ax: number, az: number, bx: number, bz: number, fx: number, fz: number, out: Vector3): number {
  const dx = bx - ax, dz = bz - az, length = Math.hypot(dx, dz);
  if (length > 1e-5) out.set(dx / length, 0, dz / length); else out.set(fx, 0, fz);
  return length;
}
