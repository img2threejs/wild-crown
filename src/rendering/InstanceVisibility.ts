import { Vector3 } from 'three';

/**
 * Per-instance presentation limits of one static batch (docs/features/full-renderer.md, "Foliage presentation").
 * `fade`: how an instance between the camera and its target is thinned: `blend` is the default alpha blend (the material is transparent and
 * writes no depth), `dither` is a screen-door discard on an opaque, depth-writing material, so dense foliage costs no blended overdraw and
 * never needs sorting. `maxViewDistance`: instances farther than this from the camera are not drawn (the authored fog has long hidden them).
 */
export interface FoliageLimits {
  readonly fade: 'blend' | 'dither';
  readonly maxViewDistance: number;
}
export const DEFAULT_FOLIAGE_LIMITS: FoliageLimits = { fade: 'blend', maxViewDistance: Infinity };

/** Fraction of `maxViewDistance` over which a culled instance must come back before it is drawn again (no popping at the edge). */
export const VIEW_DISTANCE_HYSTERESIS = 0.06;
/** An instance fades when it lies within this radius (m) of the camera-to-target ray, between 8 % and 98 % of the way to the camera. */
export const OCCLUSION_RADIUS = 2;
/** Stored in a Float32Array, so the constant is its float32 value: a steady fade compares equal and uploads nothing. */
export const OCCLUDED_ALPHA = Math.fround(0.3);
/** Half-duration (seconds) of the occlusion fade tween: the alpha lands within 0.001 of the target after `2 * FADE_TWEEN_HALF` seconds. */
export const FADE_TWEEN_HALF = 0.125;

const RAY = new Vector3();
const DELTA = new Vector3();
const CLOSEST = new Vector3();

/**
 * Bookkeeping of which instances of a static batch are drawn and how opaque: a placement hidden by a world fact, an instance culled by the
 * view-distance limit, and the occlusion fade. Pure data over the instance anchors (no GPU resources); the owner writes matrices only for
 * the indices a `update*` call reports through `onChange`, so a steady camera costs no buffer upload.
 *
 * The opacity is tweened over `~0.25 s` toward the target each frame (`advanceFade`): a steady camera costs nothing; a change in target
 * produces a smooth fade instead of snapping 1 -> 0.3 / 0.3 -> 1.
 */
export class InstanceVisibility {
  /** Current rendered alpha (Float32 shared with the GPU `instanceOpacity` attribute). */
  readonly alpha: Float32Array;
  /** Where the occlusion test last wanted the alpha to land. */
  private readonly target: Float32Array;
  /** What the next `advanceFade` write should change by; reset to 0 once applied so steady frames cost no comparison. */
  private readonly dirty: Uint8Array;
  private readonly culled: Uint8Array;
  private readonly factHidden: Uint8Array;
  /** 1/dt after the next advanceFade (set in updateOcclusion so dt-less advance calls converge to the target). */
  private fadeRate = 0;
  /** Last timestamp fed to `updateOcclusion`; the next call's dt defaults to (now - lastMs) when `dt` is omitted. */
  private lastUpdateMs = 0;
  /** True once the first `updateOcclusion` has recorded a timestamp; the very first frame uses 0.016 s (~60 fps) so the first fade still moves. */
  private hadUpdate = false;

  constructor(private readonly positions: readonly Vector3[]) {
    this.alpha = new Float32Array(positions.length).fill(1);
    this.target = new Float32Array(positions.length).fill(1);
    this.dirty = new Uint8Array(positions.length);
    this.culled = new Uint8Array(positions.length);
    this.factHidden = new Uint8Array(positions.length);
  }

  get count(): number { return this.positions.length; }

  /** True while instance `index` should be drawn at all (neither hidden by a fact nor culled by distance). */
  isDrawn(index: number): boolean { return this.culled[index] === 0 && this.factHidden[index] === 0; }

  /** Number of instances drawn right now. */
  get drawnCount(): number {
    let drawn = 0;
    for (let i = 0; i < this.positions.length; i++) if (this.culled[i] === 0 && this.factHidden[i] === 0) drawn++;
    return drawn;
  }

  /** Placement shown or hidden by a world fact; returns whether the drawn state changed. */
  setFactVisible(index: number, visible: boolean): boolean {
    const hidden = visible ? 0 : 1;
    if (this.factHidden[index] === hidden) return false;
    this.factHidden[index] = hidden;
    return true;
  }

  /**
   * Culls instances beyond `maxDistance` of the camera and restores those back inside `maxDistance * (1 - VIEW_DISTANCE_HYSTERESIS)`;
   * `onChange(index)` is called for every instance whose drawn state changed through the cull. Allocation free.
   */
  updateDistance(camera: Vector3, maxDistance: number, onChange: (index: number) => void): void {
    if (!(maxDistance < Infinity)) return;
    const farSq = maxDistance * maxDistance, nearLimit = maxDistance * (1 - VIEW_DISTANCE_HYSTERESIS), nearSq = nearLimit * nearLimit;
    for (let i = 0; i < this.positions.length; i++) {
      const distanceSq = this.positions[i]!.distanceToSquared(camera);
      const culled = this.culled[i] === 1;
      if (!culled && distanceSq > farSq) { this.culled[i] = 1; onChange(i); }
      else if (culled && distanceSq < nearSq) { this.culled[i] = 0; onChange(i); }
    }
  }

  /** Computes the fade target from the camera-to-target ray. Sets the `fadeRate` the next `advanceFade` will use. */
  updateOcclusion(camera: Vector3, target: Vector3, dt?: number): boolean {
    const ray = RAY.subVectors(camera, target), rayLengthSq = ray.lengthSq();
    let anyChanged = false;
    for (let i = 0; i < this.positions.length; i++) {
      const position = this.positions[i]!;
      const along = rayLengthSq > 0 ? Math.max(0, Math.min(1, DELTA.subVectors(position, target).dot(ray) / rayLengthSq)) : 0;
      CLOSEST.copy(target).addScaledVector(ray, along);
      const faded = along > 0.08 && along < 0.98 && position.distanceToSquared(CLOSEST) < OCCLUSION_RADIUS * OCCLUSION_RADIUS;
      const targetAlpha = faded ? OCCLUDED_ALPHA : 1;
      if (this.target[i] !== targetAlpha) { this.target[i] = targetAlpha; this.dirty[i] = 1; anyChanged = true; }
    }
    // Derive dt from `performance.now()` when not supplied; the renderer hot path calls without one.
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    let stepDt: number;
    if (dt !== undefined && dt > 0) stepDt = dt;
    else if (this.hadUpdate) stepDt = Math.min(0.1, Math.max(0.001, (now - this.lastUpdateMs) / 1000));
    else stepDt = 1 / 60;
    this.lastUpdateMs = now;
    this.hadUpdate = true;
    // Use the largest jump found in this frame as the fade rate; clamp by dt so a 0 dt frame converges.
    this.fadeRate = stepDt > 0 ? 1 / (FADE_TWEEN_HALF * stepDt) : 0;
    return anyChanged;
  }

  /**
   * Tweens every dirty instance toward its target and reports whether the rendered alpha changed (so the GPU attribute can be re-uploaded).
   * The step is monotone: when the target is above `alpha` we add up to `move(1/dt)` toward the target; when it is below we subtract the same
   * amount. The magnitude is constant per-frame regardless of how far the target sits, so the duration is bounded by `2 * FADE_TWEEN_HALF`
   * even when a wave of instances flips at once. Allocation free.
   */
  advanceFade(): boolean {
    const step = this.fadeRate;
    let changed = false;
    if (step === 0) {
      // 0 dt: jump straight to the target. `dirty` resets so the next non-zero dt starts from a stable state.
      for (let i = 0; i < this.alpha.length; i++) {
        if (this.dirty[i] === 0) continue;
        const target = this.target[i]!;
        if (this.alpha[i] !== target) { this.alpha[i] = target; changed = true; }
        this.dirty[i] = 0;
      }
      return changed;
    }
    for (let i = 0; i < this.alpha.length; i++) {
      if (this.dirty[i] === 0) continue;
      const current = this.alpha[i] as number;
      const desired = this.target[i] as number;
      if (current === desired) { this.dirty[i] = 0; continue; }
      const delta = desired - current;
      const next = delta > 0 ? current + Math.min(delta, step) : current - Math.min(-delta, step);
      if (Math.abs(desired - next) < 1e-3) this.dirty[i] = 0;
      if (next !== current) { this.alpha[i] = next; changed = true; }
    }
    return changed;
  }
}