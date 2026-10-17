import { Color, DodecahedronGeometry, Group, InstancedMesh, Matrix4, MeshStandardMaterial, Quaternion, Vector3 } from 'three';
import type { VfxModule } from './VfxSystem.js';

const HIDDEN = new Matrix4().makeScale(0, 0, 0);
/** Sap-stained basalt: dark, slightly green so the rock reads as bound by black sap, never as a clean boulder. */
const ROCK = new Color().setRGB(0.19, 0.18, 0.13);

/** One drawn rock. The owning cue kit moves it every frame (`place`) and releases it when its flight ends or the cue is cancelled. */
export interface RockSlot {
  readonly index: number;
  active: boolean;
  owner: number;
  x: number; y: number; z: number;
  /** Rock diameter in metres. */
  size: number;
  /** Tumble rate (rad/s) about a per-rock axis. */
  spinRate: number;
  seed: number;
}

/**
 * Sap-bound rocks hurled by the Thornback Howler: one instanced draw call for every rock in the world. Rock positions come
 * from the cue kit (an analytic arc evaluated on the authoritative world clock); the module only draws them, so pause and
 * slow motion need nothing special and a cancelled scope removes its rocks with `killOwner`.
 */
export class LobbedRocksFx implements VfxModule {
  readonly group = new Group();
  readonly mesh: InstancedMesh<DodecahedronGeometry, MeshStandardMaterial>;
  readonly capacity: number;
  private readonly slots: RockSlot[] = [];
  private readonly matrix = new Matrix4();
  private readonly position = new Vector3();
  private readonly scale = new Vector3();
  private readonly axis = new Vector3();
  private readonly rotation = new Quaternion();
  private live = 0;

  constructor(capacity = 6) {
    this.capacity = capacity;
    const geometry = new DodecahedronGeometry(0.5, 0);
    geometry.scale(1, 0.78, 0.92);
    this.mesh = new InstancedMesh(geometry, new MeshStandardMaterial({ color: 0xffffff, roughness: 0.94, metalness: 0, flatShading: true }), capacity);
    this.mesh.name = 'vfx-lobbed-rocks';
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    for (let i = 0; i < capacity; i++) {
      this.mesh.setMatrixAt(i, HIDDEN);
      this.mesh.setColorAt(i, ROCK);
      this.slots.push({ index: i, active: false, owner: -1, x: 0, y: 0, z: 0, size: 0.5, spinRate: 0, seed: 0 });
    }
    this.group.name = 'vfx-lobbed-rocks-group';
    this.group.add(this.mesh);
  }

  /** Takes a free rock, or recycles the first one when every rock is in flight (the capacity is a hard cap, never reallocated). */
  acquire(owner: number, seed: number, size: number, spinRate: number): RockSlot | undefined {
    const slot = this.slots.find(candidate => !candidate.active) ?? this.slots[0];
    if (!slot) return undefined;
    slot.active = true; slot.owner = owner; slot.seed = seed; slot.size = size; slot.spinRate = spinRate;
    return slot;
  }

  place(slot: RockSlot, x: number, y: number, z: number, size = slot.size): void { slot.x = x; slot.y = y; slot.z = z; slot.size = size; }

  release(slot: RockSlot): void {
    slot.active = false; slot.owner = -1;
    this.mesh.setMatrixAt(slot.index, HIDDEN);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(time: number): void {
    let live = 0;
    for (const slot of this.slots) {
      if (!slot.active) continue;
      live++;
      this.axis.set(Math.sin(slot.seed * 12.9), Math.cos(slot.seed * 7.3), Math.sin(slot.seed * 3.1 + 1)).normalize();
      this.rotation.setFromAxisAngle(this.axis, slot.spinRate * time + slot.seed * 6.28);
      this.position.set(slot.x, slot.y, slot.z);
      this.scale.setScalar(slot.size);
      this.mesh.setMatrixAt(slot.index, this.matrix.compose(this.position, this.rotation, this.scale));
    }
    if (live || this.live) this.mesh.instanceMatrix.needsUpdate = true;
    this.live = live;
    this.mesh.count = live ? this.capacity : 0;
  }

  killOwner(owner: number): void { for (const slot of this.slots) if (slot.active && slot.owner === owner) this.release(slot); }
  clear(): void { for (const slot of this.slots) if (slot.active) this.release(slot); this.live = 0; }
  get activeCount(): number { let count = 0; for (const slot of this.slots) if (slot.active) count++; return count; }

  dispose(): void {
    this.clear();
    this.group.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
  }
}
