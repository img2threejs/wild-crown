import type { Vector3 } from 'three';
import { dangerFamily, type StoryCue } from '../story-cues.js';

export type FootprintShape = 'rect' | 'disk' | 'sector';
/** 0 radial from centre/apex, 1 along local +Z (lanes), 2 sideways from the centre line (waves). */
export type FillAxis = 0 | 1 | 2;

/**
 * Authored hazard area in a yaw frame: local +Z is `(sin angle, cos angle)` in world XZ, matching
 * `hazardPresentation` in the combat engine. Ground VFX never draw outside `bounds`.
 */
export class Footprint {
  shape: FootprintShape = 'disk';
  fillAxis: FillAxis = 0;
  cx = 0; cy = 0; cz = 0;
  angle = 0;
  /** Rect/disk half extents; sectors keep their radius in `halfLength`. */
  halfWidth = 1; halfLength = 1;
  aperture = 0;
  /** Superellipse exponent for 'rect' masks: lanes/bands read as rounded slabs, never crisp boxes. */
  readonly round = 3.5;
  minX = -1; maxX = 1; minZ = -1; maxZ = 1;

  set(shape: FootprintShape, cx: number, cy: number, cz: number, angle: number, halfWidth: number, halfLength: number, aperture = 0, fillAxis: FillAxis = 0): this {
    this.shape = shape; this.cx = cx; this.cy = cy; this.cz = cz; this.angle = angle; this.fillAxis = fillAxis;
    this.halfWidth = Math.max(0.05, halfWidth); this.halfLength = Math.max(0.05, halfLength); this.aperture = aperture;
    if (shape === 'sector') {
      const radius = this.halfLength, half = Math.min(Math.PI, aperture / 2);
      const side = half >= Math.PI / 2 ? radius : radius * Math.sin(half);
      this.halfWidth = side;
      this.minX = -side; this.maxX = side; this.minZ = Math.min(0, radius * Math.cos(half)); this.maxZ = radius;
    } else {
      this.minX = -this.halfWidth; this.maxX = this.halfWidth; this.minZ = -this.halfLength; this.maxZ = this.halfLength;
    }
    return this;
  }

  /**
   * Engine footprint convention: cones are apex sectors, strikes are disks, sweeps/waves are rounded
   * lanes/bands; square 'area' hazards are drawn as the ellipse inscribed in their rectangle.
   */
  setFromCue(cue: StoryCue, fallbackSize: number): this {
    const at = cue.position ?? cue.to ?? cue.from ?? { x: 0, y: 0, z: 0 };
    const width = cue.footprint?.width ?? fallbackSize, length = cue.footprint?.length ?? fallbackSize;
    const angle = cue.footprint?.angleRadians ?? 0;
    const aperture = cue.footprint?.sectorRadians;
    if (cue.shape === 'sector' && aperture !== undefined && aperture > 0) return this.set('sector', at.x, at.y, at.z, angle, length / 2, length / 2, aperture, 0);
    const family = dangerFamily(cue);
    if (family === 'sweep' || cue.shape === 'arc' || cue.shape === 'trail') return this.set('rect', at.x, at.y, at.z, angle, width / 2, length / 2, 0, 1);
    if (family === 'wave' || cue.shape === 'wave' || cue.shape === 'vein') return this.set('rect', at.x, at.y, at.z, angle, width / 2, length / 2, 0, 2);
    return this.set('disk', at.x, at.y, at.z, angle, width / 2, length / 2, 0, 0);
  }

  get forwardX(): number { return Math.sin(this.angle); }
  get forwardZ(): number { return Math.cos(this.angle); }

  toWorld(lx: number, lz: number, out: Vector3, lift = 0): Vector3 {
    const c = Math.cos(this.angle), s = Math.sin(this.angle);
    return out.set(this.cx + lx * c + lz * s, this.cy + lift, this.cz - lx * s + lz * c);
  }

  localX(wx: number, wz: number): number { return (wx - this.cx) * Math.cos(this.angle) - (wz - this.cz) * Math.sin(this.angle); }
  localZ(wx: number, wz: number): number { return (wx - this.cx) * Math.sin(this.angle) + (wz - this.cz) * Math.cos(this.angle); }

  /** Uniform area sample from two unit randoms; `inset` keeps volumetric emitters off the soft edge. */
  sample(r1: number, r2: number, out: Vector3, lift = 0, inset = 0.85): Vector3 {
    if (this.shape === 'rect') return this.toWorld((r1 - 0.5) * 2 * this.halfWidth * inset, (r2 - 0.5) * 2 * this.halfLength * inset, out, lift);
    if (this.shape === 'disk') {
      const a = r1 * Math.PI * 2, r = Math.sqrt(r2) * inset;
      return this.toWorld(Math.cos(a) * this.halfWidth * r, Math.sin(a) * this.halfLength * r, out, lift);
    }
    const a = (r1 - 0.5) * this.aperture * inset, r = Math.sqrt(r2) * this.halfLength * inset;
    return this.toWorld(Math.sin(a) * r, Math.cos(a) * r, out, lift);
  }

  contains(wx: number, wz: number, margin = 0): boolean {
    const x = this.localX(wx, wz), z = this.localZ(wx, wz);
    if (this.shape === 'rect') return Math.abs(x) <= this.halfWidth + margin && Math.abs(z) <= this.halfLength + margin;
    if (this.shape === 'disk') {
      const hw = this.halfWidth + margin, hl = this.halfLength + margin;
      return (x * x) / (hw * hw) + (z * z) / (hl * hl) <= 1 + 1e-9;
    }
    const r = Math.hypot(x, z);
    if (r <= margin) return true;
    if (r > this.halfLength + margin) return false;
    const off = Math.abs(Math.atan2(x, z)) - this.aperture / 2;
    return off <= 0 || r * Math.sin(Math.min(off, Math.PI / 2)) <= margin;
  }

  copy(source: Footprint): this {
    return this.set(source.shape, source.cx, source.cy, source.cz, source.angle, source.shape === 'sector' ? source.halfLength : source.halfWidth, source.halfLength, source.aperture, source.fillAxis);
  }
}
