import {
  AdditiveBlending, BufferAttribute, DynamicDrawUsage, InstancedBufferAttribute, InstancedBufferGeometry, Mesh, NormalBlending,
  ShaderMaterial, type Blending, type IUniform, type Texture,
} from 'three';
import { ATLAS_COLUMNS, ATLAS_ROWS } from './VfxAtlas.js';
import { capHdr } from './palette.js';

/** Mutable spawn record reused by every emitter; never retained by the pool. */
export class ParticleSpec {
  x = 0; y = 0; z = 0; vx = 0; vy = 0; vz = 0;
  /** Downward acceleration (m/s²) and exponential velocity drag (1/s). */
  gravity = 0; drag = 0;
  life = 1; delay = 0;
  size0 = 0.2; size1 = 0.2; spin = 0; spinRate = 0;
  /** Linear HDR start/end colours; values above 1 feed bloom. */
  r0 = 1; g0 = 1; b0 = 1; a0 = 1; r1 = 1; g1 = 1; b1 = 1;
  /** Alpha envelope as fractions of life. */
  fadeIn = 0.08; fadeOut = 0.55;
  frame = 0;
  /** Velocity-aligned stretch per m/s; 0 keeps a spinning billboard. */
  stretch = 0;

  reset(): this {
    this.x = this.y = this.z = this.vx = this.vy = this.vz = this.gravity = this.drag = this.delay = this.spin = this.spinRate = this.stretch = 0;
    this.life = 1; this.size0 = this.size1 = 0.2;
    this.r0 = this.g0 = this.b0 = this.a0 = this.r1 = this.g1 = this.b1 = 1;
    this.fadeIn = 0.08; this.fadeOut = 0.55; this.frame = 0;
    return this;
  }
}

const VERTEX = /* glsl */`
uniform float uTime;
attribute vec3 iOrigin;
attribute vec3 iVelocity;
attribute vec4 iTiming;
attribute vec4 iSize;
attribute vec4 iColor0;
attribute vec4 iColor1;
attribute vec4 iMisc;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  float age = uTime - iTiming.x;
  float life = iTiming.y;
  if (life <= 0.0 || age < 0.0 || age >= life) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vColor = vec4(0.0); vUv = vec2(0.0); return; }
  float t = age / life;
  float drag = iTiming.w;
  float travel = drag > 1e-4 ? (1.0 - exp(-drag * age)) / drag : age;
  vec3 pos = iOrigin + iVelocity * travel;
  pos.y -= 0.5 * iTiming.z * age * age;
  vec3 vel = iVelocity * exp(-drag * age);
  vel.y -= iTiming.z * age;
  float size = mix(iSize.x, iSize.y, 1.0 - (1.0 - t) * (1.0 - t));
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  vec2 corner = position.xy;
  if (iMisc.y > 0.0) {
    vec2 dir = (modelViewMatrix * vec4(vel, 0.0)).xy;
    float speed = length(dir);
    dir = speed > 1e-4 ? dir / speed : vec2(1.0, 0.0);
    vec2 perp = vec2(-dir.y, dir.x);
    mv.xy += dir * corner.x * size * (1.0 + speed * iMisc.y) + perp * corner.y * size;
  } else {
    // Round billboards (halos, rings, puffs) are pulled toward the camera by half their width and shrunk by
    // the same ratio, so the screen footprint is unchanged but a large quad near the floor no longer cuts
    // off along a hard line where its lower half would sink below the terrain.
    float distance = length(mv.xyz);
    float k = clamp(1.0 - 0.5 * size / max(distance, 1e-3), 0.2, 1.0);
    mv.xyz *= k;
    float angle = iSize.z + iSize.w * age;
    float c = cos(angle), s = sin(angle);
    mv.xy += vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y) * size * k;
  }
  gl_Position = projectionMatrix * mv;
  float frame = iMisc.x;
  vec2 cell = vec2(mod(frame, ${ATLAS_COLUMNS}.0), floor(frame / ${ATLAS_COLUMNS}.0));
  vUv = (cell + uv) / vec2(${ATLAS_COLUMNS}.0, ${ATLAS_ROWS}.0);
  float alpha = iColor0.a * smoothstep(0.0, max(iColor1.w, 1e-3), t) * (1.0 - smoothstep(iMisc.z, 1.0, t));
  vColor = vec4(mix(iColor0.rgb, iColor1.rgb, t), alpha);
}`;

const FRAGMENT = /* glsl */`
uniform sampler2D uAtlas;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 tex = texture2D(uAtlas, vUv);
  float alpha = vColor.a * tex.a;
  if (alpha < 0.002) discard;
  gl_FragColor = vec4(clamp(vColor.rgb * tex.rgb, vec3(0.0), vec3(4.0)), clamp(alpha, 0.0, 1.0));
}`;

/**
 * Stateless instanced billboards: motion, curves and expiry are integrated in the vertex
 * shader from spawn data, so the CPU only writes a ring-buffer slot per spawn.
 */
export class ParticlePool {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  readonly capacity: number;
  private readonly geometry = new InstancedBufferGeometry();
  private readonly origin: Float32Array;
  private readonly velocity: Float32Array;
  private readonly timing: Float32Array;
  private readonly size: Float32Array;
  private readonly color0: Float32Array;
  private readonly color1: Float32Array;
  private readonly misc: Float32Array;
  private readonly attributes: InstancedBufferAttribute[] = [];
  private readonly uTime: IUniform<number> = { value: 0 };
  private readonly owners: Int32Array;
  private cursor = 0;
  private highWater = 0;
  private dirtyMin = Infinity;
  private dirtyMax = -1;

  constructor(name: string, capacity: number, atlas: Texture, blending: Blending) {
    this.capacity = capacity;
    this.geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    this.geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const attribute = (key: string, itemSize: number): Float32Array => {
      const array = new Float32Array(capacity * itemSize);
      const value = new InstancedBufferAttribute(array, itemSize);
      value.setUsage(DynamicDrawUsage);
      this.geometry.setAttribute(key, value);
      this.attributes.push(value);
      return array;
    };
    this.origin = attribute('iOrigin', 3); this.velocity = attribute('iVelocity', 3); this.timing = attribute('iTiming', 4);
    this.size = attribute('iSize', 4); this.color0 = attribute('iColor0', 4); this.color1 = attribute('iColor1', 4); this.misc = attribute('iMisc', 4);
    this.owners = new Int32Array(capacity).fill(-1);
    this.geometry.instanceCount = 0;
    const material = new ShaderMaterial({
      name, vertexShader: VERTEX, fragmentShader: FRAGMENT,
      uniforms: { uTime: this.uTime, uAtlas: { value: atlas } },
      transparent: true, depthWrite: false, blending, premultipliedAlpha: false,
    });
    this.mesh = new Mesh(this.geometry, material);
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = blending === AdditiveBlending ? 12 : 11;
  }

  /**
   * Writes one particle into the next ring slot, recycling the oldest when full. Colours are capped
   * hue-preservingly (palette `capHdr`); a spawn with any non-finite value is rejected (returns -1)
   * so it can never reach the HDR target.
   */
  emit(spec: ParticleSpec, time: number, owner: number): number {
    if (!Number.isFinite(spec.x + spec.y + spec.z + spec.vx + spec.vy + spec.vz + spec.gravity + spec.drag + spec.life + spec.delay + time
      + spec.size0 + spec.size1 + spec.spin + spec.spinRate + spec.r0 + spec.g0 + spec.b0 + spec.a0 + spec.r1 + spec.g1 + spec.b1 + spec.stretch)) return -1;
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.highWater < this.capacity) this.highWater = Math.max(this.highWater, i + 1);
    this.owners[i] = owner;
    const o = this.origin, v = this.velocity, t = this.timing, s = this.size, c0 = this.color0, c1 = this.color1, m = this.misc;
    o[i * 3] = spec.x; o[i * 3 + 1] = spec.y; o[i * 3 + 2] = spec.z;
    v[i * 3] = spec.vx; v[i * 3 + 1] = spec.vy; v[i * 3 + 2] = spec.vz;
    t[i * 4] = time + spec.delay; t[i * 4 + 1] = Math.max(1e-3, spec.life); t[i * 4 + 2] = spec.gravity; t[i * 4 + 3] = Math.max(0, spec.drag);
    s[i * 4] = Math.max(0, spec.size0); s[i * 4 + 1] = Math.max(0, spec.size1); s[i * 4 + 2] = spec.spin; s[i * 4 + 3] = spec.spinRate;
    c0[i * 4] = Math.max(0, spec.r0); c0[i * 4 + 1] = Math.max(0, spec.g0); c0[i * 4 + 2] = Math.max(0, spec.b0); c0[i * 4 + 3] = Math.min(1, Math.max(0, spec.a0));
    c1[i * 4] = Math.max(0, spec.r1); c1[i * 4 + 1] = Math.max(0, spec.g1); c1[i * 4 + 2] = Math.max(0, spec.b1); c1[i * 4 + 3] = Math.min(1, Math.max(0, spec.fadeIn));
    capHdr(c0, i * 4); capHdr(c1, i * 4);
    m[i * 4] = spec.frame; m[i * 4 + 1] = Math.max(0, spec.stretch); m[i * 4 + 2] = Math.min(0.999, Math.max(0, spec.fadeOut)); m[i * 4 + 3] = 0;
    this.markDirty(i);
    return i;
  }

  /** Expires every particle spawned for one cue scope; the shader hides zero-life slots. */
  killOwner(owner: number): number {
    const timing = this.timing;
    let killed = 0;
    for (let i = 0; i < this.highWater; i++) {
      if (this.owners[i] !== owner) continue;
      this.owners[i] = -1;
      if (timing[i * 4 + 1]! > 0) { timing[i * 4 + 1] = 0; killed++; this.markDirty(i); }
    }
    return killed;
  }

  clear(): void {
    this.timing.fill(0);
    this.owners.fill(-1);
    this.cursor = 0;
    this.highWater = 0;
    this.dirtyMin = 0; this.dirtyMax = this.capacity - 1;
  }

  /** Particles that are pending (delayed) or alive at `time`, optionally for one owner. */
  liveCount(time: number, owner?: number): number {
    const timing = this.timing;
    let count = 0;
    for (let i = 0; i < this.highWater; i++) {
      const life = timing[i * 4 + 1]!;
      if (life > 0 && time < timing[i * 4]! + life && (owner === undefined || this.owners[i] === owner)) count++;
    }
    return count;
  }

  get drawCount(): number { return this.geometry.instanceCount; }
  get nextSlot(): number { return this.cursor; }
  ownerAt(index: number): number { return this.owners[index] ?? -1; }

  /** Upload only the ring range touched since the last frame. */
  update(time: number): void {
    this.uTime.value = time;
    this.geometry.instanceCount = this.highWater;
    this.mesh.visible = this.highWater > 0;
    if (this.dirtyMax < this.dirtyMin) return;
    const start = this.dirtyMin, count = this.dirtyMax - this.dirtyMin + 1;
    for (const attribute of this.attributes) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(start * attribute.itemSize, count * attribute.itemSize);
      attribute.needsUpdate = true;
    }
    this.dirtyMin = Infinity; this.dirtyMax = -1;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.mesh.material.dispose();
  }

  private markDirty(index: number): void {
    if (index < this.dirtyMin) this.dirtyMin = index;
    if (index > this.dirtyMax) this.dirtyMax = index;
  }
}

/** Two blend pools (two draw calls) sharing one atlas and spawn record. */
export class ParticleSystem {
  readonly additive: ParticlePool;
  readonly alpha: ParticlePool;
  readonly spec = new ParticleSpec();

  constructor(atlas: Texture, additiveCapacity = 5000, alphaCapacity = 3000) {
    this.additive = new ParticlePool('vfx-particles-additive', additiveCapacity, atlas, AdditiveBlending);
    this.alpha = new ParticlePool('vfx-particles-alpha', alphaCapacity, atlas, NormalBlending);
  }

  get capacity(): number { return this.additive.capacity + this.alpha.capacity; }
  update(time: number): void { this.additive.update(time); this.alpha.update(time); }
  killOwner(owner: number): void { this.additive.killOwner(owner); this.alpha.killOwner(owner); }
  clear(): void { this.additive.clear(); this.alpha.clear(); }
  liveCount(time: number, owner?: number): number { return this.additive.liveCount(time, owner) + this.alpha.liveCount(time, owner); }
  dispose(): void { this.additive.dispose(); this.alpha.dispose(); }
}
