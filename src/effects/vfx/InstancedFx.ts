import { Color, ConeGeometry, DodecahedronGeometry, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3, type BufferGeometry } from 'three';
import { createIceMaterial, type IceMaterial } from './IceMaterial.js';

const GRAVITY = 9.8;
const HIDDEN = new Matrix4().makeScale(0, 0, 0);

/** Ballistic rock/ice chunks; analytic flight to the spawn ground plane, then rest and shrink. */
export class DebrisFx {
  readonly mesh: InstancedMesh<BufferGeometry, MeshStandardMaterial>;
  readonly capacity: number;
  private readonly data: Float32Array;
  private readonly owners: Int32Array;
  private readonly matrix = new Matrix4();
  private readonly position = new Vector3();
  private readonly scale = new Vector3();
  private readonly axis = new Vector3();
  private readonly rotation = new Quaternion();
  private cursor = 0;
  private highWater = 0;
  private live = 0;

  constructor(capacity = 120) {
    this.capacity = capacity;
    const geometry = new DodecahedronGeometry(0.5, 0);
    geometry.scale(1, 0.72, 0.9);
    this.mesh = new InstancedMesh(geometry, new MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0, flatShading: true }), capacity);
    this.mesh.name = 'vfx-debris';
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    // x y z vx vy vz ax ay az spin size birth life ground hitTime
    this.data = new Float32Array(capacity * 15);
    this.owners = new Int32Array(capacity).fill(-1);
    const white = new Color(1, 1, 1);
    for (let i = 0; i < capacity; i++) { this.mesh.setMatrixAt(i, HIDDEN); this.mesh.setColorAt(i, white); }
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, size: number, life: number, time: number, owner: number, color: Color, seed: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.highWater = Math.max(this.highWater, i + 1);
    const d = this.data, o = i * 15;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = vx; d[o + 4] = vy; d[o + 5] = vz;
    this.axis.set(Math.sin(seed * 12.9), Math.cos(seed * 7.3), Math.sin(seed * 3.1 + 1)).normalize();
    d[o + 6] = this.axis.x; d[o + 7] = this.axis.y; d[o + 8] = this.axis.z;
    d[o + 9] = 6 + 10 * ((seed * 5.7) % 1); d[o + 10] = size; d[o + 11] = time; d[o + 12] = life; d[o + 13] = y;
    d[o + 14] = Math.max(0, 2 * vy / GRAVITY);
    this.owners[i] = owner;
    this.mesh.setColorAt(i, color);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(time: number): void {
    if (!this.highWater) return;
    const d = this.data;
    let live = 0;
    for (let i = 0; i < this.highWater; i++) {
      const o = i * 15, age = time - d[o + 11]!, life = d[o + 12]!;
      if (life <= 0 || age < 0 || age >= life) { this.mesh.setMatrixAt(i, HIDDEN); continue; }
      live++;
      const flight = Math.min(age, d[o + 14]!);
      this.position.set(d[o]! + d[o + 3]! * flight, Math.max(d[o + 13]!, d[o + 1]! + d[o + 4]! * flight - 0.5 * GRAVITY * flight * flight), d[o + 2]! + d[o + 5]! * flight);
      this.axis.set(d[o + 6]!, d[o + 7]!, d[o + 8]!);
      this.rotation.setFromAxisAngle(this.axis, d[o + 9]! * flight);
      const shrink = Math.min(1, (life - age) / (life * 0.3));
      this.scale.setScalar(d[o + 10]! * shrink);
      this.position.y += d[o + 10]! * 0.3 * shrink;
      this.mesh.setMatrixAt(i, this.matrix.compose(this.position, this.rotation, this.scale));
    }
    if (live || this.live) this.mesh.instanceMatrix.needsUpdate = true;
    this.live = live;
    this.mesh.count = this.highWater;
  }

  killOwner(owner: number): void {
    for (let i = 0; i < this.highWater; i++) if (this.owners[i] === owner) { this.data[i * 15 + 12] = 0; this.owners[i] = -1; }
  }

  clear(): void {
    for (let i = 0; i < this.capacity; i++) { this.data[i * 15 + 12] = 0; this.owners[i] = -1; this.mesh.setMatrixAt(i, HIDDEN); }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.cursor = 0; this.highWater = 0; this.live = 0; this.mesh.count = 0;
  }

  get liveCount(): number { return this.live; }

  dispose(): void { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.mesh.dispose(); }
}

/** Fresnel ice spikes that erupt with overshoot, hold, then shrink back into the ground. */
export class CrystalSpikesFx {
  readonly mesh: InstancedMesh<BufferGeometry, IceMaterial>;
  readonly capacity: number;
  private readonly data: Float32Array;
  private readonly owners: Int32Array;
  private readonly matrix = new Matrix4();
  private readonly position = new Vector3();
  private readonly scale = new Vector3();
  private readonly tilt = new Quaternion();
  private readonly axis = new Vector3();
  private cursor = 0;
  private highWater = 0;
  private live = 0;

  constructor(capacity = 64) {
    this.capacity = capacity;
    const geometry = new ConeGeometry(0.5, 1, 6, 1).translate(0, 0.5, 0).toNonIndexed();
    geometry.computeVertexNormals();
    this.mesh = new InstancedMesh(geometry, createIceMaterial({ opacity: 0.62, transparent: true, heightBase: 0, heightScale: 1, rimStrength: 2.4 }), capacity);
    this.mesh.material.depthWrite = true;
    this.mesh.name = 'vfx-crystal-spikes';
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    // x y z height radius tiltX tiltZ birth life
    this.data = new Float32Array(capacity * 9);
    this.owners = new Int32Array(capacity).fill(-1);
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, HIDDEN);
  }

  spawn(x: number, y: number, z: number, height: number, radius: number, tiltX: number, tiltZ: number, birth: number, life: number, owner: number): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this.highWater = Math.max(this.highWater, i + 1);
    const d = this.data, o = i * 9;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = height; d[o + 4] = radius; d[o + 5] = tiltX; d[o + 6] = tiltZ; d[o + 7] = birth; d[o + 8] = life;
    this.owners[i] = owner;
  }

  update(time: number): void {
    this.mesh.material.uniforms.uTime.value = time;
    if (!this.highWater) return;
    const d = this.data;
    let live = 0;
    for (let i = 0; i < this.highWater; i++) {
      const o = i * 9, age = time - d[o + 7]!, life = d[o + 8]!;
      if (life <= 0 || age < 0 || age >= life) { this.mesh.setMatrixAt(i, HIDDEN); continue; }
      live++;
      const g = Math.min(1, age / 0.14), c1 = 1.70158, c3 = c1 + 1;
      const grow = 1 + c3 * Math.pow(g - 1, 3) + c1 * Math.pow(g - 1, 2);
      const shrink = Math.min(1, (life - age) / 0.35);
      const height = d[o + 3]! * grow * shrink;
      this.position.set(d[o]!, d[o + 1]! - d[o + 3]! * (1 - shrink) * 0.4, d[o + 2]!);
      this.axis.set(d[o + 5]!, 0, d[o + 6]!);
      const angle = this.axis.length();
      if (angle > 1e-5) this.tilt.setFromAxisAngle(this.axis.multiplyScalar(1 / angle), angle); else this.tilt.identity();
      this.scale.set(d[o + 4]! * 2 * Math.max(0.2, shrink), Math.max(1e-3, height), d[o + 4]! * 2 * Math.max(0.2, shrink));
      this.mesh.setMatrixAt(i, this.matrix.compose(this.position, this.tilt, this.scale));
    }
    if (live || this.live) this.mesh.instanceMatrix.needsUpdate = true;
    this.live = live;
    this.mesh.count = this.highWater;
  }

  /** Instance world positions of live spikes at `time`, for footprint containment checks. */
  livePositions(time: number, out: Vector3[]): Vector3[] {
    out.length = 0;
    for (let i = 0; i < this.highWater; i++) {
      const o = i * 9, age = time - this.data[o + 7]!;
      if (this.data[o + 8]! > 0 && age >= 0 && age < this.data[o + 8]!) out.push(new Vector3(this.data[o]!, this.data[o + 1]!, this.data[o + 2]!));
    }
    return out;
  }

  killOwner(owner: number): void {
    for (let i = 0; i < this.highWater; i++) if (this.owners[i] === owner) { this.data[i * 9 + 8] = 0; this.owners[i] = -1; }
  }

  clear(): void {
    for (let i = 0; i < this.capacity; i++) { this.data[i * 9 + 8] = 0; this.owners[i] = -1; this.mesh.setMatrixAt(i, HIDDEN); }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.cursor = 0; this.highWater = 0; this.live = 0; this.mesh.count = 0;
  }

  dispose(): void { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.mesh.dispose(); }
}
