/** Point count of a midpoint-displaced path with `levels` subdivisions. */
export const pathPoints = (levels: number): number => (1 << levels) + 1;

/**
 * Midpoint displacement between A and B into `out` (xyz triples, `pathPoints(levels)` points): each
 * subdivision offsets the segment midpoint perpendicular to the segment by up to `jitter` × segment
 * length. Endpoints are written exactly. No allocation; `random` yields 0..1.
 */
export function jaggedPath(out: Float32Array, ax: number, ay: number, az: number, bx: number, by: number, bz: number, levels: number, jitter: number, random: () => number): number {
  const last = 1 << levels;
  out[0] = ax; out[1] = ay; out[2] = az; out[last * 3] = bx; out[last * 3 + 1] = by; out[last * 3 + 2] = bz;
  for (let step = last; step > 1; step >>= 1) {
    const half = step >> 1;
    for (let i = 0; i < last; i += step) {
      const a = i * 3, b = (i + step) * 3, m = (i + half) * 3;
      const dx = out[b]! - out[a]!, dy = out[b + 1]! - out[a + 1]!, dz = out[b + 2]! - out[a + 2]!;
      const length = Math.hypot(dx, dy, dz);
      let mx = (out[a]! + out[b]!) / 2, my = (out[a + 1]! + out[b + 1]!) / 2, mz = (out[a + 2]! + out[b + 2]!) / 2;
      if (length > 1e-6) {
        const nx = dx / length, ny = dy / length, nz = dz / length;
        // Any helper axis not parallel to the segment gives the perpendicular basis (u, v).
        const hx = Math.abs(ny) < 0.9 ? 0 : 1, hy = Math.abs(ny) < 0.9 ? 1 : 0;
        let ux = -nz * hy, uy = nz * hx, uz = nx * hy - ny * hx;
        const un = Math.hypot(ux, uy, uz) || 1;
        ux /= un; uy /= un; uz /= un;
        const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
        const r1 = (random() * 2 - 1) * jitter * length, r2 = (random() * 2 - 1) * jitter * length;
        mx += ux * r1 + vx * r2; my += uy * r1 + vy * r2; mz += uz * r1 + vz * r2;
      }
      out[m] = mx; out[m + 1] = my; out[m + 2] = mz;
    }
  }
  return last + 1;
}
