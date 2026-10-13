import { Color, Group, Vector3, type DataTexture, type Object3D } from 'three';
import { createVfxAtlas, VFX_FRAME } from './VfxAtlas.js';
import { ParticleSystem, type ParticlePool, type ParticleSpec } from './GpuParticles.js';
import { GroundFx } from './GroundFx.js';
import { CrystalSpikesFx, DebrisFx } from './InstancedFx.js';
import { BeamsFx, WindBladesFx } from './RibbonFx.js';
import { FlashLights } from './FlashLights.js';
import { PALETTE, type VfxElement } from './palette.js';
import type { Footprint } from './footprint.js';

const REDUCED_SCALE = 0.35;
const DUST = new Color().setRGB(0.42, 0.36, 0.27);
const ROCK = new Color().setRGB(0.36, 0.3, 0.24);
const ICE_CHUNK = new Color().setRGB(0.62, 0.84, 1);
const SMOKE = new Color().setRGB(0.09, 0.08, 0.075);
const STEAM = new Color().setRGB(0.78, 0.88, 0.95);
const LEAF = new Color().setRGB(0.36, 0.52, 0.16);
const LEAF_DRY = new Color().setRGB(0.62, 0.48, 0.18);

/** Self-contained presentation module sharing the system's world clock, scope cancellation and disposal (the Warden arsenal). */
export interface VfxModule {
  readonly group: Object3D;
  update(time: number): void;
  killOwner(owner: number): void;
  clear(): void;
  dispose(): void;
}
/**
 * One owner for every pooled VFX resource: ≤ 2 particle draw calls, footprint ground quads,
 * instanced debris/spikes, ribbons and four flash lights. Time is the authoritative world clock
 * in seconds, so pause and Perfect Dodge slow motion freeze/slow everything consistently.
 */
export class VfxSystem {
  readonly group = new Group();
  readonly atlas: DataTexture = createVfxAtlas();
  readonly particles: ParticleSystem;
  readonly ground = new GroundFx();
  readonly debris = new DebrisFx();
  readonly spikes = new CrystalSpikesFx();
  readonly blades = new WindBladesFx();
  readonly beams = new BeamsFx();
  readonly lights = new FlashLights();
  readonly cameraPosition = new Vector3(10, 12, 14);
  time = 0;
  private reduced = false;
  private seed = 0x9e3779b9;
  private readonly scratch = new Vector3();
  private readonly modules: VfxModule[] = [];

  constructor() {
    this.group.name = 'vfx-system';
    this.particles = new ParticleSystem(this.atlas);
    this.group.add(this.ground.group, this.debris.mesh, this.spikes.mesh, this.blades.group, this.beams.group, this.lights.group, this.particles.alpha.mesh, this.particles.additive.mesh);
  }

  /** Registers a module whose group joins the system group and whose lifecycle follows this system. */
  addModule(module: VfxModule): void { this.modules.push(module); this.group.add(module.group); }
  get reducedEffects(): boolean { return this.reduced; }
  setReducedEffects(reduced: boolean): void { this.reduced = reduced; this.lights.setEnabled(!reduced); }

  /** Deterministic 0..1 sequence (mulberry32) so effect layouts are reproducible in tests. */
  random(): number {
    this.seed = (this.seed + 0x6d2b79f5) | 0;
    let t = this.seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(min: number, max: number): number { return min + (max - min) * this.random(); }
  /** Particle counts shrink in reduced-effects mode but never drop a requested emitter to zero. */
  count(n: number): number { return n <= 0 ? 0 : this.reduced ? Math.max(1, Math.round(n * REDUCED_SCALE)) : Math.round(n); }

  spec(): ParticleSpec { return this.particles.spec.reset(); }
  emit(pool: ParticlePool, owner: number): void { pool.emit(this.particles.spec, this.time, owner); }

  update(time: number): void {
    this.time = time;
    this.ground.update(time);
    this.debris.update(time);
    this.spikes.update(time);
    this.blades.update(time);
    this.beams.update(time, this.cameraPosition);
    this.lights.update(time);
    this.particles.update(time);
    for (const module of this.modules) module.update(time);
  }

  killOwner(owner: number): void {
    this.particles.killOwner(owner); this.ground.killOwner(owner); this.debris.killOwner(owner); this.spikes.killOwner(owner);
    this.blades.killOwner(owner); this.beams.killOwner(owner); this.lights.killOwner(owner);
    for (const module of this.modules) module.killOwner(owner);
  }

  clear(): void {
    this.particles.clear(); this.ground.clear(); this.debris.clear(); this.spikes.clear(); this.blades.clear(); this.beams.clear(); this.lights.clear();
    for (const module of this.modules) module.clear();
  }

  dispose(): void {
    this.clear();
    for (const module of this.modules) module.dispose();
    this.modules.length = 0;
    this.group.removeFromParent();
    this.particles.dispose(); this.ground.dispose(); this.debris.dispose(); this.spikes.dispose(); this.blades.dispose(); this.beams.dispose(); this.lights.dispose();
    this.atlas.dispose();
  }

  // ---- Emitter primitives shared by cue kits and actor effects ----

  /**
   * Detonation flash: a thin hot core (≤ 0.6 m, the only white-hot part), a saturated body halo and
   * an expanding ring. Skipped in reduced-effects mode (no flashes).
   */
  flash(x: number, y: number, z: number, size: number, element: VfxElement, owner: number, life = 0.2): void {
    if (this.reduced) return;
    const { hot, b } = PALETTE[element], p = this.spec();
    p.x = x; p.y = y; p.z = z; p.life = life * 0.8; p.size0 = Math.min(0.4, size * 0.2); p.size1 = Math.min(0.6, size * 0.3); p.frame = VFX_FRAME.glow;
    p.r0 = p.r1 = hot.r; p.g0 = p.g1 = hot.g; p.b0 = p.b1 = hot.b; p.a0 = 0.9; p.fadeIn = 0.02; p.fadeOut = 0.2;
    this.emit(this.particles.additive, owner);
    p.size0 = size * 0.45; p.size1 = size; p.life = life; p.a0 = 0.4;
    p.r0 = p.r1 = b.r; p.g0 = p.g1 = b.g; p.b0 = p.b1 = b.b;
    this.emit(this.particles.additive, owner);
    p.size0 = size * 0.3; p.size1 = size * 1.5; p.frame = VFX_FRAME.ring; p.life = life * 1.6; p.a0 = 0.5;
    this.emit(this.particles.additive, owner);
  }

  /** Velocity-stretched sparks in a cone around `up`; thin, so they may carry the hot core colour. */
  sparks(x: number, y: number, z: number, count: number, speed: number, element: VfxElement, owner: number, upBias = 0.6): void {
    const hot = PALETTE[element].hot, b = PALETTE[element].b;
    for (let i = this.count(count); i > 0; i--) {
      const p = this.spec(), a = this.random() * Math.PI * 2, up = upBias + (1 - upBias) * this.random(), s = speed * this.range(0.45, 1);
      const flat = Math.sqrt(Math.max(0, 1 - up * up));
      p.x = x; p.y = y; p.z = z; p.vx = Math.cos(a) * flat * s; p.vy = up * s; p.vz = Math.sin(a) * flat * s;
      p.gravity = 7; p.drag = 1.6; p.life = this.range(0.3, 0.65); p.size0 = this.range(0.04, 0.07); p.size1 = 0.02;
      p.frame = VFX_FRAME.spark; p.stretch = 0.09;
      p.r0 = hot.r; p.g0 = hot.g; p.b0 = hot.b; p.r1 = b.r; p.g1 = b.g; p.b1 = b.b; p.fadeIn = 0.02; p.fadeOut = 0.5;
      this.emit(this.particles.additive, owner);
    }
  }

  /** Glowing embers that float up or rain down; `gravity` < 0 makes them rise. */
  embers(x: number, y: number, z: number, count: number, spread: number, speed: number, gravity: number, owner: number, element: VfxElement = 'fire'): void {
    const hot = PALETTE[element].hot, a = PALETTE[element].a;
    for (let i = this.count(count); i > 0; i--) {
      const p = this.spec(), angle = this.random() * Math.PI * 2, r = Math.sqrt(this.random()) * spread;
      p.x = x + Math.cos(angle) * r; p.y = y + this.random() * 0.3; p.z = z + Math.sin(angle) * r;
      p.vx = Math.cos(angle) * speed * this.range(0.2, 0.7); p.vy = speed * this.range(0.6, 1.2); p.vz = Math.sin(angle) * speed * this.range(0.2, 0.7);
      p.gravity = gravity; p.drag = 0.9; p.life = this.range(0.8, 1.6); p.size0 = this.range(0.05, 0.1); p.size1 = 0.02;
      p.frame = VFX_FRAME.ember; p.spin = this.random() * 6;
      p.r0 = hot.r; p.g0 = hot.g; p.b0 = hot.b; p.r1 = a.r; p.g1 = a.g; p.b1 = a.b; p.fadeIn = 0.05; p.fadeOut = 0.6;
      this.emit(this.particles.additive, owner);
    }
  }

  /** Billowing alpha puffs; colour by kind (dust, smoke, steam/mist, venom). */
  smoke(x: number, y: number, z: number, count: number, spread: number, rise: number, size: number, life: number, color: Color, alpha: number, owner: number, outward = 0): void {
    for (let i = this.count(count); i > 0; i--) {
      const p = this.spec(), angle = this.random() * Math.PI * 2, r = Math.sqrt(this.random()) * spread;
      p.x = x + Math.cos(angle) * r; p.y = y + this.random() * 0.25; p.z = z + Math.sin(angle) * r;
      p.vx = Math.cos(angle) * outward * this.range(0.5, 1) + this.range(-0.15, 0.15); p.vy = rise * this.range(0.6, 1.2); p.vz = Math.sin(angle) * outward * this.range(0.5, 1) + this.range(-0.15, 0.15);
      p.drag = 1.8; p.gravity = -0.15; p.life = life * this.range(0.7, 1.2); p.size0 = size * 0.45; p.size1 = size * this.range(0.9, 1.4);
      p.spin = this.random() * 6.28; p.spinRate = this.range(-0.6, 0.6); p.frame = VFX_FRAME.smoke;
      p.r0 = color.r; p.g0 = color.g; p.b0 = color.b; p.r1 = color.r * 0.8; p.g1 = color.g * 0.8; p.b1 = color.b * 0.8; p.a0 = alpha;
      p.fadeIn = 0.12; p.fadeOut = 0.45;
      this.emit(this.particles.alpha, owner);
    }
  }

  /** Dust thrown radially along the ground from an impact point. */
  dustRing(x: number, y: number, z: number, radius: number, count: number, owner: number, color: Color = DUST): void {
    for (let i = this.count(count); i > 0; i--) {
      const p = this.spec(), angle = (i / count) * Math.PI * 2 + this.random() * 0.4, speed = radius * this.range(2.2, 3.4);
      p.x = x + Math.cos(angle) * radius * 0.25; p.y = y + 0.15; p.z = z + Math.sin(angle) * radius * 0.25;
      p.vx = Math.cos(angle) * speed; p.vy = this.range(0.3, 1.1); p.vz = Math.sin(angle) * speed;
      p.drag = 4.2; p.gravity = 0.4; p.life = this.range(0.7, 1.2); p.size0 = 0.35; p.size1 = this.range(0.9, 1.4);
      p.spin = this.random() * 6.28; p.spinRate = this.range(-1, 1); p.frame = VFX_FRAME.smoke;
      p.r0 = color.r; p.g0 = color.g; p.b0 = color.b; p.r1 = color.r * 0.85; p.g1 = color.g * 0.85; p.b1 = color.b * 0.85; p.a0 = 0.62;
      p.fadeIn = 0.05; p.fadeOut = 0.4;
      this.emit(this.particles.alpha, owner);
    }
  }

  leaves(x: number, y: number, z: number, count: number, spread: number, vx: number, vz: number, owner: number): void {
    for (let i = this.count(count); i > 0; i--) {
      const p = this.spec(), angle = this.random() * Math.PI * 2, r = Math.sqrt(this.random()) * spread, color = this.random() > 0.4 ? LEAF : LEAF_DRY;
      p.x = x + Math.cos(angle) * r; p.y = y + this.random() * 0.4; p.z = z + Math.sin(angle) * r;
      p.vx = vx * this.range(0.6, 1.2) + this.range(-0.4, 0.4); p.vy = this.range(0.6, 1.8); p.vz = vz * this.range(0.6, 1.2) + this.range(-0.4, 0.4);
      p.gravity = 1.2; p.drag = 1.1; p.life = this.range(1, 1.8); p.size0 = p.size1 = this.range(0.09, 0.15);
      p.spin = this.random() * 6.28; p.spinRate = this.range(-7, 7); p.frame = VFX_FRAME.leaf;
      p.r0 = p.r1 = color.r; p.g0 = p.g1 = color.g; p.b0 = p.b1 = color.b; p.a0 = 0.95; p.fadeIn = 0.05; p.fadeOut = 0.75;
      this.emit(this.particles.alpha, owner);
    }
  }

  /** Bright ice shards flung outward (additive, stretched). */
  shards(x: number, y: number, z: number, count: number, speed: number, owner: number): void {
    const hot = PALETTE.ice.hot, b = PALETTE.ice.b;
    for (let i = this.count(count); i > 0; i--) {
      const p = this.spec(), a = this.random() * Math.PI * 2, up = this.range(0.25, 0.9), s = speed * this.range(0.5, 1);
      p.x = x; p.y = y; p.z = z; p.vx = Math.cos(a) * s; p.vy = up * s; p.vz = Math.sin(a) * s;
      p.gravity = 9; p.drag = 1.2; p.life = this.range(0.45, 0.8); p.size0 = this.range(0.1, 0.16); p.size1 = 0.05;
      p.frame = VFX_FRAME.shard; p.stretch = 0.05;
      p.r0 = hot.r; p.g0 = hot.g; p.b0 = hot.b; p.r1 = b.r; p.g1 = b.g; p.b1 = b.b; p.fadeIn = 0.02; p.fadeOut = 0.6;
      this.emit(this.particles.additive, owner);
    }
  }

  /** Rising droplets/bubbles (poison, sap) that pop at the end of life. */
  bubbles(x: number, y: number, z: number, count: number, spread: number, owner: number, element: VfxElement): void {
    const hot = PALETTE[element].hot, a = PALETTE[element].a;
    for (let i = this.count(count); i > 0; i--) {
      const p = this.spec(), angle = this.random() * Math.PI * 2, r = Math.sqrt(this.random()) * spread;
      p.x = x + Math.cos(angle) * r; p.y = y + 0.05; p.z = z + Math.sin(angle) * r;
      p.vy = this.range(0.25, 0.7); p.drag = 0.5; p.life = this.range(0.6, 1.2); p.size0 = 0.04; p.size1 = this.range(0.1, 0.18);
      p.frame = VFX_FRAME.ring;
      p.r0 = hot.r; p.g0 = hot.g; p.b0 = hot.b; p.r1 = a.r; p.g1 = a.g; p.b1 = a.b; p.a0 = 0.9; p.fadeIn = 0.1; p.fadeOut = 0.85;
      this.emit(this.particles.additive, owner);
    }
  }

  /** Particles that converge on a point (energy gathering at a cast socket); body colour, small and dim. */
  gather(x: number, y: number, z: number, count: number, radius: number, element: VfxElement, owner: number): void {
    const { a, b } = PALETTE[element];
    for (let i = this.count(count); i > 0; i--) {
      const p = this.spec(), theta = this.random() * Math.PI * 2, phi = Math.acos(this.range(-0.6, 1)), r = radius * this.range(0.7, 1.1);
      const ox = Math.sin(phi) * Math.cos(theta) * r, oy = Math.cos(phi) * r * 0.8, oz = Math.sin(phi) * Math.sin(theta) * r;
      p.life = this.range(0.32, 0.5);
      p.x = x + ox; p.y = y + oy; p.z = z + oz; p.vx = -ox / p.life; p.vy = -oy / p.life; p.vz = -oz / p.life;
      p.size0 = this.range(0.04, 0.07); p.size1 = 0.015; p.frame = VFX_FRAME.spark; p.stretch = 0.05; p.a0 = 0.8;
      p.r0 = a.r; p.g0 = a.g; p.b0 = a.b; p.r1 = b.r; p.g1 = b.g; p.b1 = b.b; p.fadeIn = 0.3; p.fadeOut = 0.85;
      this.emit(this.particles.additive, owner);
    }
  }

  /** Soft additive glow blob (heat haze, energy body, aura) in the saturated body colour. */
  glow(x: number, y: number, z: number, size: number, life: number, element: VfxElement, alpha: number, owner: number, rise = 0): void {
    const color = PALETTE[element].b, p = this.spec();
    p.x = x; p.y = y; p.z = z; p.vy = rise; p.life = life; p.size0 = size * 0.8; p.size1 = size; p.frame = VFX_FRAME.glow;
    p.r0 = p.r1 = color.r; p.g0 = p.g1 = color.g; p.b0 = p.b1 = color.b; p.a0 = Math.min(0.6, alpha); p.fadeIn = 0.3; p.fadeOut = 0.6;
    this.emit(this.particles.additive, owner);
  }

  /**
   * Flame tongues licking upward. They use over (alpha) blending with saturated HDR colour, so any
   * number of overlapping flames can never exceed one flame's brightness or drift towards white.
   */
  flames(x: number, y: number, z: number, count: number, spread: number, height: number, owner: number, element: VfxElement = 'fire'): void {
    const pal = PALETTE[element];
    for (let i = this.count(count); i > 0; i--) {
      const p = this.spec(), angle = this.random() * Math.PI * 2, r = Math.sqrt(this.random()) * spread;
      p.x = x + Math.cos(angle) * r; p.y = y + 0.1; p.z = z + Math.sin(angle) * r;
      p.vy = height * this.range(1.2, 2.2); p.vx = this.range(-0.2, 0.2); p.vz = this.range(-0.2, 0.2); p.drag = 1.2; p.gravity = -1.5;
      p.life = this.range(0.35, 0.6); p.size0 = this.range(0.35, 0.55) * height; p.size1 = 0.12 * height; p.frame = VFX_FRAME.flame;
      p.spin = this.range(-0.25, 0.25); p.a0 = 0.85;
      p.r0 = pal.b.r * 1.2; p.g0 = pal.b.g * 1.2; p.b0 = pal.b.b * 1.2; p.r1 = pal.a.r; p.g1 = pal.a.g; p.b1 = pal.a.b; p.fadeIn = 0.1; p.fadeOut = 0.5;
      this.emit(this.particles.alpha, owner);
    }
  }

  /** Ballistic chunks that land inside `footprint` when given (spawn and landing both sampled inside). */
  chunks(x: number, y: number, z: number, count: number, speed: number, size: number, owner: number, ice = false, footprint?: Footprint): void {
    const n = this.reduced ? Math.max(1, Math.round(count * 0.5)) : count;
    for (let i = 0; i < n; i++) {
      let vx: number, vz: number;
      const vy = speed * this.range(0.7, 1.2), flight = 2 * vy / 9.8;
      if (footprint) {
        footprint.sample(this.random(), this.random(), this.scratch, 0, 0.8);
        vx = (this.scratch.x - x) / flight; vz = (this.scratch.z - z) / flight;
      } else {
        const a = this.random() * Math.PI * 2, s = speed * this.range(0.3, 0.8);
        vx = Math.cos(a) * s; vz = Math.sin(a) * s;
      }
      this.debris.spawn(x, y, z, vx, vy, vz, size * this.range(0.5, 1.1), this.range(1.4, 2.2), this.time, owner, ice ? ICE_CHUNK : ROCK, this.random());
    }
  }
}

export const VFX_COLORS = { dust: DUST, smoke: SMOKE, steam: STEAM } as const;
