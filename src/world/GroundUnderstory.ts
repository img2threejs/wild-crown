import { Group } from 'three';
import type { RegionDefinition, Vec3 } from '../game/contracts';
import type { BiomeProfile } from './BiomeProfile';
import { GroundClutter } from './GroundClutter';
import { GroundGrass } from './GroundGrass';
import type { GroundMask } from './GroundMask';
import type { TerrainField } from './GroundTerrain';

/**
 * Everything that grows or lies on the ground of a biome: streamed GPU grass and instanced
 * clutter / trail dressing, both reading the splat mask so nothing stands on the trail core.
 *
 * - `update(worldTimeSeconds, focus)`: writes the shared wind clock and streams grass tiles
 *   around the focus; no allocations.
 * - `dispose()`: idempotent.
 */
export class GroundUnderstory {
  readonly group = new Group();
  readonly grass: GroundGrass;
  readonly clutter: GroundClutter;
  private readonly wind: { value: number };
  private disposed = false;

  constructor(readonly region: RegionDefinition, field: TerrainField, mask: GroundMask, wind: { value: number }, profile: BiomeProfile) {
    this.group.name = `${profile.id}-understory`;
    this.wind = wind;
    this.grass = new GroundGrass(field, mask, wind, profile.understory);
    this.clutter = new GroundClutter(region, field, mask, wind, profile);
    this.group.add(this.grass.group, this.clutter.group);
  }

  /** Draw calls this understory can submit in one frame (grass tiles are streamed, never more than the pool). */
  get maxDrawCalls(): number {
    return this.clutter.drawCalls + this.grass.group.children.length;
  }

  update(worldTimeSeconds: number, focus?: Readonly<Vec3>): void {
    if (this.disposed) return;
    this.wind.value = worldTimeSeconds;
    if (focus) this.grass.update(focus.x, focus.z);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.grass.dispose();
    this.clutter.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}
