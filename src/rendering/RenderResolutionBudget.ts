/** Presentation-only resolution control; no allocations or simulation-clock writes per sample. */
export class RenderResolutionBudget {
  private scale = 1;
  private elapsed = 0;
  private samples = 0;
  private slow = 0;
  private settling = 0.5;
  private recovery = 0;

  reset(scale = 1): void {
    this.scale = Number.isFinite(scale) ? Math.min(1, Math.max(0.75, scale)) : 1;
    this.elapsed = this.samples = this.slow = this.recovery = 0;
    this.settling = 0.5;
  }

  /** Real RAF intervals. Sustained misses lower only 3D resolution; isolated stalls do not. */
  observe(seconds: number): number {
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 0.25) return this.scale;
    if (this.settling > 0) { this.settling -= seconds; return this.scale; }
    this.elapsed += seconds;
    this.samples++;
    if (seconds > 0.0175) this.slow++;
    if (this.elapsed < 2 || this.samples < 30) return this.scale;

    const previous = this.scale;
    if (this.slow / this.samples > 0.04) {
      this.scale = Math.max(0.75, Math.round((this.scale - 0.1) * 100) / 100);
      this.recovery = 0;
    } else if (this.slow === 0 && this.elapsed / this.samples < 0.011) {
      // Only restore detail with clear headroom, not merely because a downgrade reached its target.
      this.recovery += this.elapsed;
      if (this.recovery >= 20) {
        this.scale = Math.min(1, Math.round((this.scale + 0.05) * 100) / 100);
        this.recovery = 0;
      }
    } else this.recovery = 0;

    this.elapsed = this.samples = this.slow = 0;
    if (this.scale !== previous) this.settling = 0.5;
    return this.scale;
  }
}
