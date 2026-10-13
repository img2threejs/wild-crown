import { BufferAttribute, BufferGeometry, Group, Mesh } from 'three';
import type { RegionDefinition } from '../game/contracts';
import type { BiomeProfile } from './BiomeProfile';
import { bakeGroundMask, type GroundMask } from './GroundMask';
import { GroundMaterial } from './GroundMaterial';
import { buildTerrainMeshData, TerrainField } from './GroundTerrain';
import { GroundWater } from './GroundWater';

/**
 * Visual ground of a biome: one displaced grid mesh covering the region's ground extent (plus a margin) shaded by the PBR splat
 * material. It stands in for every terrain-backed walkable surface (all y = 0 surfaces and the raised ramps and cliff / ridge tops;
 * bridge decks are the one exception) and carries the profile's carved channels; their water is one extra transparent mesh.
 * Walkability itself never reads it. Owns the terrain field and splat mask so grass and clutter share them.
 */
export class RegionGround {
  readonly group = new Group();
  readonly field: TerrainField;
  readonly mask: GroundMask;
  readonly trail: GroundMaterial;
  readonly mesh: Mesh;
  readonly water: GroundWater;
  /** Vertices and triangles of the terrain mesh. */
  readonly vertexCount: number;
  readonly triangleCount: number;
  private readonly geometry: BufferGeometry;
  private disposed = false;

  constructor(region: RegionDefinition, readonly profile: BiomeProfile) {
    this.group.name = `${profile.id}-ground`;
    this.field = new TerrainField(region, profile);
    this.mask = bakeGroundMask(region, this.field, profile);
    this.trail = new GroundMaterial(this.mask, profile.splat, profile.id);
    const data = buildTerrainMeshData(this.field);
    this.vertexCount = data.positions.length / 3;
    this.triangleCount = data.indices.length / 3;
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
    this.geometry.setAttribute('normal', new BufferAttribute(data.normals, 3));
    this.geometry.setIndex(new BufferAttribute(data.indices, 1));
    this.geometry.computeBoundingSphere();
    this.mesh = new Mesh(this.geometry, this.trail.material);
    this.mesh.name = `${profile.id}-terrain`;
    this.mesh.receiveShadow = true;
    this.water = new GroundWater(this.field, profile.water);
    this.group.add(this.mesh, this.water.mesh);
  }

  /** Resolves when the Poly Haven layers are uploaded. */
  get ready(): Promise<void> {
    return this.trail.ready;
  }

  /** Advances the water flow and the canopy dapple from the shared world clock. */
  update(worldTimeSeconds: number): void {
    this.water.update(worldTimeSeconds);
    this.trail.update(worldTimeSeconds);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    this.group.clear();
    this.geometry.dispose();
    this.water.dispose();
    this.trail.dispose();
  }
}
