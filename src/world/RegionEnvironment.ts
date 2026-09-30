import { AmbientLight, BoxGeometry, BufferAttribute, BufferGeometry, Color, CylinderGeometry, DirectionalLight, DoubleSide, Fog, Group, HemisphereLight, Mesh, MeshBasicMaterial, MeshStandardMaterial, Scene, SphereGeometry, Vector3 } from 'three';
import type { EnvironmentRecipeDefinition, GroundSurfaceDefinition, RegionColliderDefinition, RegionDefinition, RegionId } from '../game/contracts';

interface BiomeStyle { sky: number; fog: number; ground: number; grass: number; stone: number; water: number; sun: number; ambient: number }
const STYLES: Record<string, BiomeStyle> = {
  greenwake: { sky: 0x9dbfc2, fog: 0xb8cfbd, ground: 0x627a54, grass: 0x8e9a5b, stone: 0x777b69, water: 0x4f9290, sun: 0xffdca4, ambient: 0xacc5b7 },
  'the-grove': { sky: 0x829995, fog: 0x9cae91, ground: 0x465b3d, grass: 0x79854e, stone: 0x606953, water: 0x4c8580, sun: 0xffd18a, ambient: 0x9cb2a0 },
  'whispering-canopy': { sky: 0x65868a, fog: 0x829f91, ground: 0x445f4c, grass: 0x87975b, stone: 0x667465, water: 0x4d8c8c, sun: 0xffd596, ambient: 0x9eb7a8 },
  'blood-bamboo-valley': { sky: 0x849a8c, fog: 0xb0aa8b, ground: 0x675443, grass: 0x9c7757, stone: 0x777160, water: 0x527d77, sun: 0xffc37e, ambient: 0xc0b191 },
  'moonpine-ridge': { sky: 0x667b8a, fog: 0x97a9ad, ground: 0x4c5e61, grass: 0x667c75, stone: 0x838c91, water: 0x537481, sun: 0xc3dcff, ambient: 0xa9bdd0 },
  'mistveil-basin': { sky: 0x879da4, fog: 0xc2d0c7, ground: 0x586b62, grass: 0x829278, stone: 0x747e7c, water: 0x628d91, sun: 0xdce5d3, ambient: 0xc0d0c3 },
  'sunmane-expanse': { sky: 0xc69d6d, fog: 0xd9b684, ground: 0x9a784a, grass: 0xaf9658, stone: 0x88785e, water: 0x648b83, sun: 0xffdda0, ambient: 0xd6bc94 },
  refuge: { sky: 0x8da4a0, fog: 0xb3c1aa, ground: 0x53694a, grass: 0x8a9856, stone: 0x777866, water: 0x4f8581, sun: 0xffd498, ambient: 0xb4c8b7 },
  'heartroot-hollow': { sky: 0x596d72, fog: 0x758b7e, ground: 0x34453d, grass: 0x687c52, stone: 0x74776c, water: 0x4b7474, sun: 0xe5bf88, ambient: 0x91aa9f },
};
const PARTIAL_RESTORATION_TINT = new Color(0xd9cd9d);

/** Regional procedural layers share the campaign's absolute ground vertices and authored camera colliders. */
export class RegionEnvironment {
  readonly group = new Group();
  readonly style: BiomeStyle;
  private readonly ownedMaterials: MeshStandardMaterial[] = [];
  private readonly ownedGeometries: BufferGeometry[] = [];
  private readonly baseSurfaceColors = new Map<MeshStandardMaterial, Color>();
  private readonly occluders: Mesh[] = [];
  private readonly colliderMaterial: MeshBasicMaterial;
  private disposed = false;

  constructor(readonly region: RegionDefinition, readonly recipe: EnvironmentRecipeDefinition) {
    this.group.name = `environment:${region.id}`;
    this.style = STYLES[region.id] ?? STYLES.greenwake!;
    this.colliderMaterial = new MeshBasicMaterial({ colorWrite: false, depthWrite: false, side: DoubleSide });
    this.buildAtmosphere();
    for (const surface of region.ground.surfaces) this.buildSurface(surface);
    for (const collider of region.ground.colliders) if (collider.blocksCamera) this.buildCameraCollider(collider);
  }

  syncWorldFacts(facts: Readonly<Record<string, boolean>>): void {
    const restored = facts[this.recipe.restorationFacts.restored] === true;
    const partial = !restored && facts[this.recipe.restorationFacts.partial] === true;
    for (const [material, baseColor] of this.baseSurfaceColors) {
      if (restored) material.color.copy(baseColor).lerp(PARTIAL_RESTORATION_TINT, 0.1);
      else if (partial) material.color.copy(baseColor).lerp(PARTIAL_RESTORATION_TINT, 0.2);
      else material.color.copy(baseColor);
    }
  }

  get cameraOccluders(): readonly Mesh[] { return this.occluders; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    for (const geometry of this.ownedGeometries) geometry.dispose();
    for (const material of this.ownedMaterials) material.dispose();
    this.colliderMaterial.dispose();
    this.ownedGeometries.length = 0;
    this.ownedMaterials.length = 0;
    this.baseSurfaceColors.clear();
    this.occluders.length = 0;
  }

  private buildAtmosphere(): void {
    const ambient = new HemisphereLight(this.style.sky, this.style.ground, 1.35);
    ambient.name = 'regional-sky-fill';
    this.group.add(ambient);
    const sun = new DirectionalLight(this.style.sun, 2.25);
    sun.name = 'regional-key-light';
    sun.position.set(-32, 54, -28);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 120;
    sun.shadow.camera.left = -38;
    sun.shadow.camera.right = 38;
    sun.shadow.camera.top = 38;
    sun.shadow.camera.bottom = -38;
    this.group.add(sun);
    const fill = new AmbientLight(this.style.ambient, 0.3);
    fill.name = 'regional-color-fill';
    this.group.add(fill);
  }

  private buildSurface(surface: GroundSurfaceDefinition): void {
    if (surface.points.length < 3) return;
    const points = surface.points.map((point) => new Vector3(point.x, point.y, point.z));
    const origin = points[0]!;
    const firstEdge = points[1]!;
    const secondEdge = points[2]!;
    const normalY = (firstEdge.z - origin.z) * (secondEdge.x - origin.x) - (firstEdge.x - origin.x) * (secondEdge.z - origin.z);
    const reverseWinding = normalY < 0;
    const triangles: number[][] = [];
    for (let index = 1; index < points.length - 1; index++) triangles.push(reverseWinding ? [0, index + 1, index] : [0, index, index + 1]);
    const positions = new Float32Array(points.length * 3);
    for (let index = 0; index < points.length; index++) {
      const point = points[index]!;
      positions[index * 3] = point.x;
      positions[index * 3 + 1] = point.y;
      positions[index * 3 + 2] = point.z;
    }
    const geometry = this.createGeometry(positions, triangles);
    if (surface.material === 'water' || surface.profile === 'water') {
      const material = new MeshStandardMaterial({ color: this.style.water, roughness: 0.28, metalness: 0.12, transparent: true, opacity: 0.82 });
      this.ownedMaterials.push(material);
      this.baseSurfaceColors.set(material, material.color.clone());
      const water = new Mesh(geometry, material);
      water.name = `water:${surface.id}`;
      water.receiveShadow = true;
      water.userData.groundSurfaceId = surface.id;
      water.userData.waterForSurface = surface.id;
      water.userData.colliderId = surface.colliderId;
      water.userData.walkable = surface.walkable;
      water.userData.traversalEvent = surface.traversalEvent;
      this.group.add(water);
      return;
    }
    const material = this.createSurfaceMaterial(surface.material);
    this.baseSurfaceColors.set(material, material.color.clone());
    const mesh = new Mesh(geometry, material);
    mesh.name = `surface:${surface.id}`;
    mesh.receiveShadow = true;
    mesh.userData.groundSurfaceId = surface.id;
    mesh.userData.colliderId = surface.colliderId;
    mesh.userData.walkable = surface.walkable;
    mesh.userData.traversalEvent = surface.traversalEvent;
    this.group.add(mesh);
  }

  private createGeometry(positions: Float32Array, triangles: readonly number[][]): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    const indices: number[] = [];
    for (const triangle of triangles) indices.push(triangle[0]!, triangle[1]!, triangle[2]!);
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    this.ownedGeometries.push(geometry);
    return geometry;
  }

  private buildCameraCollider(collider: RegionColliderDefinition): void {
    if (collider.kind === 'box' && collider.halfExtents) {
      const geometry = new BoxGeometry(collider.halfExtents.x * 2, collider.halfExtents.y * 2, collider.halfExtents.z * 2);
      geometry.translate(collider.from.x, collider.from.y, collider.from.z);
      this.registerCameraCollider(new Mesh(geometry, this.colliderMaterial), geometry, collider.id);
      return;
    }
    if (!collider.to) return;
    const start = new Vector3(collider.from.x, collider.from.y, collider.from.z);
    const end = new Vector3(collider.to.x, collider.to.y, collider.to.z);
    const delta = new Vector3().subVectors(end, start);
    const radius = collider.radius ?? 0.3;
    if (collider.kind !== 'capsule') {
      const geometry = new CylinderGeometry(radius, radius, delta.length(), 8, 1, false);
      const mesh = new Mesh(geometry, this.colliderMaterial);
      mesh.position.copy(start).add(end).multiplyScalar(0.5);
      if (delta.lengthSq() > 0) mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), delta.normalize());
      this.registerCameraCollider(mesh, geometry, collider.id);
      return;
    }
    const capsule = new Group();
    capsule.name = 'camera-collider:' + collider.id;
    capsule.userData.colliderId = collider.id;
    this.group.add(capsule);
    const length = delta.length();
    if (length > 0) {
      const bodyGeometry = new CylinderGeometry(radius, radius, length, 12, 1, false);
      const body = new Mesh(bodyGeometry, this.colliderMaterial);
      body.position.copy(start).add(end).multiplyScalar(0.5);
      body.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), delta.clone().normalize());
      this.registerCameraCollider(body, bodyGeometry, collider.id, capsule);
    }
    const startGeometry = new SphereGeometry(radius, 16, 12);
    const startCap = new Mesh(startGeometry, this.colliderMaterial);
    startCap.position.copy(start);
    this.registerCameraCollider(startCap, startGeometry, collider.id, capsule);
    if (length > 0) {
      const endGeometry = new SphereGeometry(radius, 16, 12);
      const endCap = new Mesh(endGeometry, this.colliderMaterial);
      endCap.position.copy(end);
      this.registerCameraCollider(endCap, endGeometry, collider.id, capsule);
    }
  }

  private registerCameraCollider(mesh: Mesh, geometry: BufferGeometry, colliderId: string, parent: Group = this.group): void {
    mesh.userData.cameraOccluder = true;
    mesh.userData.colliderId = colliderId;
    parent.add(mesh);
    this.ownedGeometries.push(geometry);
    this.occluders.push(mesh);
  }

  private createSurfaceMaterial(kind: string): MeshStandardMaterial {
    const color = kind === 'grass' || kind === 'moss' ? this.style.grass : kind === 'stone' || kind === 'wood' ? this.style.stone : this.style.ground;
    const material = new MeshStandardMaterial({ color, roughness: 0.9, metalness: 0 });
    this.ownedMaterials.push(material);
    return material;
  }
}

export function setSceneAtmosphere(scene: Scene, regionId: RegionId): void {
  const style = STYLES[regionId] ?? STYLES.greenwake!;
  scene.background = new Color(style.sky);
  scene.fog = new Fog(new Color(style.fog), 14, 115);
}
