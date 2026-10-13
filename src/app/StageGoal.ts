import type { RegionDefinition, Vec3 } from '../game/contracts.js';

/** Local playtest affordance only; arrival never writes campaign facts or unlocks a region. */
export class StageGoal {
  readonly position: Readonly<Vec3>;
  readonly radius = 2.2;

  constructor(position: Readonly<Vec3>) {
    this.position = { ...position };
  }

  /** Beside the landing, clear of both the arrival circle and authored approach. */
  pillarPosition(region: RegionDefinition, cameraRight: Readonly<Vec3>): Vec3 {
    let nearest: Readonly<Vec3> | undefined;
    let distance = Infinity;
    for (const node of region.navigation.nodes) {
      const dx = node.position.x - this.position.x, dz = node.position.z - this.position.z;
      const squared = dx * dx + dz * dz;
      if (squared > 0.01 && squared < distance) { nearest = node.position; distance = squared; }
    }
    if (!nearest) throw new Error('Waystone requires an authored exit approach.');
    const length = Math.sqrt(distance);
    let x = -(this.position.z - nearest.z) / length, z = (this.position.x - nearest.x) / length;
    if (x * cameraRight.x + z * cameraRight.z > 0) { x = -x; z = -z; }
    const offset = 4.6 / Math.SQRT2;
    return { x: this.position.x + (x + (this.position.x - nearest.x) / length) * offset,
      y: this.position.y, z: this.position.z + (z + (this.position.z - nearest.z) / length) * offset };
  }

  contains(position: Readonly<Vec3>): boolean {
    const dx = position.x - this.position.x, dz = position.z - this.position.z;
    return dx * dx + dz * dz <= this.radius * this.radius + 1e-9 && Math.abs(position.y - this.position.y) <= 0.75;
  }

}
