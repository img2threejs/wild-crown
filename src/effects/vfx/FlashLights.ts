import { Color, Group, PointLight } from 'three';

/** Peak flash intensity (candela, decay 2): bright enough to light the ground, never to overflow HDR. */
const MAX_INTENSITY = 8;

/**
 * A fixed set of point lights that always stay in the scene (zero intensity when idle) so the lit
 * shader permutation never changes and no material recompiles when an explosion flashes.
 */
export class FlashLights {
  readonly group = new Group();
  readonly lights: readonly PointLight[];
  /** Fifth light dedicated to the travelling Sigil Bolt; always present so shader permutations never change. */
  readonly tracked: PointLight;
  private readonly start: Float64Array;
  private readonly life: Float64Array;
  private readonly peak: Float64Array;
  private readonly owners: Int32Array;
  private enabled = true;

  constructor(count = 4) {
    this.group.name = 'vfx-flash-lights';
    const lights: PointLight[] = [];
    for (let i = 0; i < count; i++) {
      const light = new PointLight(0xffffff, 0, 6, 2);
      light.name = 'vfx-flash-light';
      light.castShadow = false;
      lights.push(light);
      this.group.add(light);
    }
    this.lights = lights;
    this.tracked = new PointLight(0xffffff, 0, 7, 2);
    this.tracked.name = 'vfx-tracked-light';
    this.tracked.castShadow = false;
    this.group.add(this.tracked);
    this.start = new Float64Array(count).fill(-Infinity);
    this.life = new Float64Array(count);
    this.peak = new Float64Array(count);
    this.owners = new Int32Array(count).fill(-1);
  }

  /** Reduced-effects mode keeps the lights in place at zero intensity. */
  setEnabled(enabled: boolean): void { this.enabled = enabled; if (!enabled) this.clear(); }

  /**
   * Lights stay a few times brighter than the sun at most: unbounded point-light energy on glossy
   * surfaces overflows the half-float target. Colour is normalised so only hue comes from `color`.
   */
  pulse(x: number, y: number, z: number, color: Color, intensity: number, distance: number, life: number, time: number, owner: number): void {
    if (!this.enabled || !(intensity > 0) || !(life > 0) || !Number.isFinite(x + y + z)) return;
    let index = 0, oldest = Infinity;
    for (let i = 0; i < this.lights.length; i++) {
      const end = this.start[i]! + this.life[i]!;
      if (end <= time) { index = i; break; }
      if (this.start[i]! < oldest) { oldest = this.start[i]!; index = i; }
    }
    const light = this.lights[index]!;
    const peak = Math.min(MAX_INTENSITY, intensity), dominant = Math.max(color.r, color.g, color.b, 1e-3);
    light.position.set(x, y, z);
    light.color.setRGB(color.r / dominant, color.g / dominant, color.b / dominant);
    light.distance = Math.max(1, distance);
    this.start[index] = time; this.life[index] = life; this.peak[index] = peak; this.owners[index] = owner;
    light.intensity = peak;
  }

  /** Positions the dedicated travelling light (a bolt in flight); call `untrack` when it ends. Hue only comes from `color`. */
  track(x: number, y: number, z: number, color: Color, intensity: number, distance: number): void {
    if (!this.enabled || !(intensity > 0) || !Number.isFinite(x + y + z)) { this.tracked.intensity = 0; return; }
    const dominant = Math.max(color.r, color.g, color.b, 1e-3);
    this.tracked.position.set(x, y, z);
    this.tracked.color.setRGB(color.r / dominant, color.g / dominant, color.b / dominant);
    this.tracked.distance = Math.max(1, distance);
    this.tracked.intensity = Math.min(MAX_INTENSITY, intensity);
  }

  untrack(): void { this.tracked.intensity = 0; }

  update(time: number): void {
    for (let i = 0; i < this.lights.length; i++) {
      const age = time - this.start[i]!, life = this.life[i]!;
      const light = this.lights[i]!;
      light.intensity = age >= 0 && age < life ? this.peak[i]! * Math.pow(1 - age / life, 2) : 0;
    }
  }

  killOwner(owner: number): void {
    for (let i = 0; i < this.lights.length; i++) if (this.owners[i] === owner) { this.life[i] = 0; this.owners[i] = -1; this.lights[i]!.intensity = 0; }
  }

  clear(): void { for (let i = 0; i < this.lights.length; i++) { this.life[i] = 0; this.owners[i] = -1; this.lights[i]!.intensity = 0; } this.tracked.intensity = 0; }

  get activeCount(): number { let count = 0; for (const light of this.lights) if (light.intensity > 0) count++; return count; }

  dispose(): void { this.clear(); this.group.removeFromParent(); for (const light of this.lights) light.dispose(); this.tracked.dispose(); }
}
