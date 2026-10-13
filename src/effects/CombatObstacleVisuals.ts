import {
  BufferGeometry, Color, ConeGeometry, CylinderGeometry, DataTexture, Float32BufferAttribute, Group, LinearMipmapLinearFilter, Mesh,
  MeshStandardMaterial, RepeatWrapping, RGBAFormat, SRGBColorSpace, type Scene,
} from 'three';
import type { CombatObstacleSnapshot, WorldClockSnapshot } from '../game/contracts.js';
import { createIceMaterial } from './vfx/IceMaterial.js';
import { DebrisFx } from './vfx/InstancedFx.js';

/** Hexagonal crystal spanning y ∈ [-0.5, 0.5] with a faceted, sunken crown; flat facet normals. */
function iceCrystalGeometry(): BufferGeometry {
  const source = new CylinderGeometry(0.5, 0.5, 1, 6, 2);
  const vertices = source.getAttribute('position');
  for (let i = 0; i < vertices.count; i++) {
    const x = vertices.getX(i), y = vertices.getY(i), z = vertices.getZ(i);
    if (y > 0.49 && x * x + z * z > 0.01) vertices.setXYZ(i, x * 0.72, 0.22 + Math.sin(Math.atan2(z, x) * 3) * 0.12, z * 0.72);
    else if (Math.abs(y) < 0.01) vertices.setXYZ(i, x * 0.94, y, z * 0.94);
  }
  const geometry = source.toNonIndexed();
  source.dispose();
  geometry.computeVertexNormals();
  return geometry;
}
function shardGeometry(): BufferGeometry {
  const geometry = new ConeGeometry(0.5, 1, 5).toNonIndexed();
  geometry.computeVertexNormals();
  return geometry;
}

const ROOT_AROUND = 14;
const ROOT_ALONG = 12;
/**
 * Gnarled root cluster in the unit collider box (|x|,|z| ≤ 0.5, y ∈ [-0.5, 0.5]): one twisted,
 * tapered main spike reaching the collider top plus four low twisted side roots. Bark ridges are
 * radial noise; every vertex is clamped inside the collider cylinder so bounds stay exact.
 */
function rootClusterGeometry(): BufferGeometry {
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  const spike = (ox: number, oz: number, bottom: number, height: number, baseRadius: number, leanX: number, leanZ: number, twist: number, seed: number): void => {
    const start = positions.length / 3;
    for (let j = 0; j <= ROOT_ALONG; j++) {
      const t = j / ROOT_ALONG;
      const taper = j === ROOT_ALONG ? 0.004 : 0.02 + baseRadius * (1 - Math.pow(t, 2.6));
      const cx = ox + leanX * t * t, cz = oz + leanZ * t * t, y = bottom + height * t;
      for (let i = 0; i <= ROOT_AROUND; i++) {
        const u = i / ROOT_AROUND, angle = u * Math.PI * 2 + twist * t;
        const ridge = 1 + 0.05 * Math.sin(angle * 3 + seed) + 0.025 * Math.sin(angle * 7 + seed * 2.3 + t * 5);
        let x = cx + Math.cos(angle) * taper * ridge, z = cz + Math.sin(angle) * taper * ridge;
        const radial = Math.hypot(x, z);
        if (radial > 0.5) { x *= 0.5 / radial; z *= 0.5 / radial; }
        positions.push(x, Math.min(0.5, Math.max(-0.5, y)), z);
        uvs.push(u, t * height * 2.2 + seed * 0.37);
      }
    }
    for (let j = 0; j < ROOT_ALONG; j++) for (let i = 0; i < ROOT_AROUND; i++) {
      const a = start + j * (ROOT_AROUND + 1) + i, b = a + ROOT_AROUND + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  };
  spike(0, 0, -0.5, 1, 0.48, 0.025, -0.02, 2.4, 0.7);
  for (let n = 0; n < 4; n++) {
    const angle = n * Math.PI / 2 + 0.6, distance = 0.27;
    spike(Math.cos(angle) * distance, Math.sin(angle) * distance, -0.5, 0.36 + 0.08 * (n % 2), 0.12, Math.cos(angle) * 0.15, Math.sin(angle) * 0.15, -3.1, 1.9 + n);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

function hash(x: number, y: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return h - Math.floor(h);
}
function valueNoise(x: number, y: number, period: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const wrap = (v: number): number => ((v % period) + period) % period;
  const a = hash(wrap(ix), iy), b = hash(wrap(ix + 1), iy), c = hash(wrap(ix), iy + 1), d = hash(wrap(ix + 1), iy + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
/** Seamless (in u) bark albedo with vertical fibres, and an emissive mask of thin sap cracks. */
function barkTextures(): { bark: DataTexture; cracks: DataTexture } {
  const width = 128, height = 256;
  const bark = new Uint8Array(width * height * 4), cracks = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const u = x / width * 16, v = y / height * 4;
    const fibre = valueNoise(u * 2, v * 0.6, 32) * 0.55 + valueNoise(u * 5, v * 1.5, 80) * 0.3 + valueNoise(u, v * 0.3, 16) * 0.15;
    const ridge = 1 - Math.abs(valueNoise(u, v * 0.45, 16) * 2 - 1);
    const crack = Math.max(0, (ridge - 0.9) / 0.1) * (0.6 + 0.4 * valueNoise(u * 3, v * 2, 48));
    const shade = 0.55 + 0.45 * fibre - 0.35 * crack;
    const offset = (y * width + x) * 4;
    bark[offset] = Math.round(92 * shade); bark[offset + 1] = Math.round(66 * shade); bark[offset + 2] = Math.round(42 * shade); bark[offset + 3] = 255;
    const glow = Math.round(Math.min(1, crack * 1.4) * 255);
    cracks[offset] = cracks[offset + 1] = cracks[offset + 2] = glow; cracks[offset + 3] = 255;
  }
  const make = (data: Uint8Array, name: string): DataTexture => {
    const texture = new DataTexture(data, width, height, RGBAFormat);
    texture.name = name;
    texture.wrapS = texture.wrapT = RepeatWrapping;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return texture;
  };
  const barkTexture = make(bark, 'root-bark-albedo');
  barkTexture.colorSpace = SRGBColorSpace;
  return { bark: barkTexture, cracks: make(cracks, 'root-sap-cracks') };
}

const SOIL = new Color().setRGB(0.24, 0.17, 0.1);
const ICE_CHUNK = new Color().setRGB(0.55, 0.78, 1);
/** Sap-green crack emission (linear); the pulse keeps it between ~1.0 and 1.9 HDR so it blooms green, never white. */
const SAP_GLOW = new Color().setRGB(0.42, 1, 0.18);
/** Spawn bursts only fire for obstacles first seen within this many world ticks of their spawn. */
const BURST_WINDOW_TICKS = 6;

interface ObstacleSlot { id: string; readonly group: Group; readonly roots: Group; readonly ice: Group }

/** Physical roots and translucent ice, never warning rings; visible mass exists for the whole collider lifetime. */
export class CombatObstacleVisuals {
  readonly group = new Group();
  /** Cosmetic soil/ice chunks thrown when an obstacle erupts; kept apart from the collider-sized mass. */
  readonly debris = new DebrisFx(64);
  private readonly iceGeometry = iceCrystalGeometry();
  private readonly crystalGeometry = shardGeometry();
  private readonly rootGeometry = rootClusterGeometry();
  private readonly barkTexture: DataTexture;
  private readonly crackTexture: DataTexture;
  private readonly rootMaterial: MeshStandardMaterial;
  /** Dense inner body (opaque, writes depth) under a translucent fresnel shell that blooms at the rim. */
  private readonly iceCoreMaterial = createIceMaterial({ opacity: 1, transparent: false, heightBase: -0.5, heightScale: 1, rimStrength: 0.9 });
  private readonly iceShellMaterial = createIceMaterial({ opacity: 0.32, transparent: true, heightBase: -0.5, heightScale: 1, rimStrength: 1.8 });
  private readonly slots: ObstacleSlot[] = [];
  private disposed = false;

  constructor(scene: Scene) {
    this.group.name = 'combat-obstacle-visuals';
    this.debris.mesh.name = 'combat-obstacle-debris';
    scene.add(this.group, this.debris.mesh);
    const { bark, cracks } = barkTextures();
    this.barkTexture = bark; this.crackTexture = cracks;
    this.rootMaterial = new MeshStandardMaterial({ map: bark, roughness: 0.92, metalness: 0, emissiveMap: cracks, emissive: SAP_GLOW, emissiveIntensity: 1.4 });
    this.rootMaterial.name = 'gnarled-root-bark';
    for (let i = 0; i < 8; i++) {
      const group = new Group(), roots = new Group(), ice = new Group();
      group.visible = false; group.add(roots, ice); this.group.add(group);
      const root = new Mesh(this.rootGeometry, this.rootMaterial);
      root.name = 'gnarled-root-spikes'; root.castShadow = true; root.receiveShadow = true;
      roots.add(root);
      const core = new Mesh(this.iceGeometry, this.iceCoreMaterial);
      core.name = 'ice-crystal-core'; core.scale.set(0.7, 0.96, 0.7);
      const shell = new Mesh(this.iceGeometry, this.iceShellMaterial);
      shell.name = 'ice-crystal-shell'; shell.renderOrder = 4;
      ice.add(core, shell);
      for (let n = 0; n < 3; n++) {
        const shard = new Mesh(this.crystalGeometry, this.iceShellMaterial);
        const angle = n * Math.PI * 2 / 3 + 0.4;
        shard.name = 'ice-crystal-shard';
        shard.position.set(Math.cos(angle) * 0.29, -0.04, Math.sin(angle) * 0.29);
        shard.scale.set(0.38, 0.9, 0.38); shard.rotation.y = angle; shard.renderOrder = 5;
        ice.add(shard);
      }
      this.slots.push({ id: '', group, roots, ice });
    }
  }

  update(obstacles: readonly CombatObstacleSnapshot[], clock: WorldClockSnapshot, reducedMotion: boolean): void {
    if (this.disposed) return;
    const seconds = clock.worldTimeSeconds;
    this.iceCoreMaterial.uniforms.uTime.value = this.iceShellMaterial.uniforms.uTime.value = reducedMotion ? 0 : seconds;
    this.rootMaterial.emissiveIntensity = reducedMotion ? 1.4 : 1.4 + 0.45 * Math.sin(seconds * 2.6);
    for (const slot of this.slots) {
      let retained = false;
      for (const obstacle of obstacles) if (obstacle.id === slot.id && clock.worldTick < obstacle.expiresAtWorldTick) { retained = true; break; }
      if (!retained) { slot.id = ''; slot.group.visible = false; }
    }
    for (const obstacle of obstacles) {
      if (clock.worldTick < obstacle.spawnedAtWorldTick || clock.worldTick >= obstacle.expiresAtWorldTick) continue;
      let slot: ObstacleSlot | undefined;
      for (const candidate of this.slots) if (candidate.id === obstacle.id) { slot = candidate; break; }
      const fresh = !slot;
      if (!slot) for (const candidate of this.slots) if (!candidate.id) { slot = candidate; break; }
      if (!slot) continue;
      const collider = obstacle.collider, extents = collider.halfExtents, radius = collider.radius ?? 0.45;
      const bottom = extents ? collider.from.y - extents.y : Math.min(collider.from.y, collider.to?.y ?? collider.from.y) - radius;
      const top = extents ? collider.from.y + extents.y : Math.max(collider.from.y, collider.to?.y ?? collider.from.y) + radius;
      slot.id = obstacle.id; slot.group.userData.obstacleId = obstacle.id;
      slot.group.position.set(collider.from.x, (bottom + top) / 2, collider.from.z);
      slot.group.scale.set(extents ? extents.x * 2 : radius * 2, top - bottom, extents ? extents.z * 2 : radius * 2);
      slot.roots.visible = obstacle.kind === 'roots'; slot.ice.visible = obstacle.kind === 'ice';
      // A stable per-obstacle yaw varies the cluster; rotation about Y keeps it inside the collider cylinder.
      slot.roots.rotation.y = hash(obstacle.spawnedAtWorldTick, collider.from.x + collider.from.z) * Math.PI * 2;
      slot.group.rotation.y = reducedMotion ? 0 : Math.sin((clock.worldTick - obstacle.spawnedAtWorldTick) * 0.016) * 0.025;
      slot.group.visible = true;
      if (fresh && clock.worldTick - obstacle.spawnedAtWorldTick < BURST_WINDOW_TICKS) this.burst(obstacle, bottom, Math.max(slot.group.scale.x, slot.group.scale.z) / 2, seconds, reducedMotion);
    }
    this.debris.update(seconds);
  }

  clear(): void {
    for (const slot of this.slots) { slot.id = ''; slot.group.visible = false; }
    this.debris.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.clear(); this.group.removeFromParent();
    this.iceGeometry.dispose(); this.crystalGeometry.dispose(); this.rootGeometry.dispose();
    this.rootMaterial.dispose(); this.barkTexture.dispose(); this.crackTexture.dispose();
    this.iceCoreMaterial.dispose(); this.iceShellMaterial.dispose();
    this.debris.dispose();
  }

  /** Soil (roots) or ice chunks flung out of the ground as the obstacle erupts. */
  private burst(obstacle: CombatObstacleSnapshot, ground: number, radius: number, seconds: number, reducedMotion: boolean): void {
    const count = reducedMotion ? 3 : 9, x = obstacle.collider.from.x, z = obstacle.collider.from.z;
    for (let i = 0; i < count; i++) {
      const seed = hash(obstacle.spawnedAtWorldTick + i * 13.1, x * 3.7 + z), angle = seed * Math.PI * 2 + i * 2.39996;
      const speed = 1.6 + 1.8 * hash(i * 7.7, seed * 31), lift = 3 + 2.2 * hash(seed * 17, i);
      this.debris.spawn(x + Math.cos(angle) * radius * 0.8, ground + 0.05, z + Math.sin(angle) * radius * 0.8,
        Math.cos(angle) * speed, lift, Math.sin(angle) * speed, 0.09 + 0.1 * hash(i, seed), 1.4, seconds, 0, obstacle.kind === 'ice' ? ICE_CHUNK : SOIL, seed);
    }
  }
}
