import type { CampaignSafeSpawn, RegionDefinition, RegionId } from "../contracts.js";

type AuthoredSurface = RegionDefinition["ground"]["surfaces"][number];
type AuthoredCollider = RegionDefinition["ground"]["colliders"][number];
type SpawnPosition = CampaignSafeSpawn["position"];

export function surfaceHeightAt(position: SpawnPosition, surface: AuthoredSurface): number | undefined {
  const points = surface.points;
  if (!surface.walkable || points.length < 3) return undefined;

  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const a = points[previous]!;
    const b = points[index]!;
    const cross = (position.x - a.x) * (b.z - a.z) - (position.z - a.z) * (b.x - a.x);
    if (Math.abs(cross) < 1e-5 &&
      position.x >= Math.min(a.x, b.x) - 1e-5 && position.x <= Math.max(a.x, b.x) + 1e-5 &&
      position.z >= Math.min(a.z, b.z) - 1e-5 && position.z <= Math.max(a.z, b.z) + 1e-5) {
      inside = true;
      break;
    }
    if ((a.z > position.z) !== (b.z > position.z) &&
      position.x < ((b.x - a.x) * (position.z - a.z)) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  if (!inside) return undefined;

  const origin = points[0]!;
  for (let index = 1; index < points.length - 1; index += 1) {
    const b = points[index]!;
    const c = points[index + 1]!;
    const denominator = (b.x - origin.x) * (c.z - origin.z) - (c.x - origin.x) * (b.z - origin.z);
    if (Math.abs(denominator) < 1e-8) continue;
    const alongB = ((position.x - origin.x) * (c.z - origin.z) - (c.x - origin.x) * (position.z - origin.z)) / denominator;
    const alongC = ((b.x - origin.x) * (position.z - origin.z) - (position.x - origin.x) * (b.z - origin.z)) / denominator;
    const alongOrigin = 1 - alongB - alongC;
    if (alongB >= -1e-4 && alongC >= -1e-4 && alongOrigin >= -1e-4) {
      return alongOrigin * origin.y + alongB * b.y + alongC * c.y;
    }
  }
  return undefined;
}

function colliderContainsSpawnPoint(position: SpawnPosition, collider: AuthoredCollider, region: RegionDefinition): boolean {
  if (collider.kind === "box") {
    if (collider.walkSurfaceId) {
      const surface = region.ground.surfaces.find(candidate => candidate.id === collider.walkSurfaceId);
      if (surface?.walkable && surfaceHeightAt(position, surface) === undefined) return false;
    }
    const half = collider.halfExtents;
    return !!half &&
      Math.abs(position.x - collider.from.x) < half.x &&
      Math.abs(position.y - collider.from.y) < half.y - 1e-5 &&
      Math.abs(position.z - collider.from.z) < half.z;
  }
  if (collider.radius === undefined) return false;
  const end = collider.to ?? collider.from;
  const delta = { x: end.x - collider.from.x, y: end.y - collider.from.y, z: end.z - collider.from.z };
  const lengthSquared = delta.x * delta.x + delta.y * delta.y + delta.z * delta.z;
  const along = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, (
    (position.x - collider.from.x) * delta.x +
    (position.y - collider.from.y) * delta.y +
    (position.z - collider.from.z) * delta.z
  ) / lengthSquared));
  const x = collider.from.x + along * delta.x - position.x;
  const y = collider.from.y + along * delta.y - position.y;
  const z = collider.from.z + along * delta.z - position.z;
  return x * x + y * y + z * z < collider.radius * collider.radius;
}

export function hasSafeWalkSurface(region: RegionDefinition, position: SpawnPosition): boolean {
  for (const surface of region.ground.surfaces) {
    const elevation = surfaceHeightAt(position, surface);
    if (elevation === undefined || Math.abs(position.y - elevation) > 0.35) continue;
    const obstructed = region.ground.colliders.some((collider) =>
      collider.id !== surface.colliderId &&
      (collider.blocksMovement || collider.blocksCamera) &&
      colliderContainsSpawnPoint(position, collider, region),
    );
    if (!obstructed) return true;
  }
  return false;
}

export function samePosition(first: SpawnPosition, second: SpawnPosition): boolean {
  return first.x === second.x && first.y === second.y && first.z === second.z;
}

export function liesOnSurface(region: RegionDefinition, position: SpawnPosition, surfaceId: string): boolean {
  const surface = region.ground.surfaces.find((item) => item.id === surfaceId);
  const height = surface && surfaceHeightAt(position, surface);
  return height !== undefined && Math.abs(position.y - height) <= 0.35;
}

/**
 * Resolves an authored safe spawn for a canonical nav node or entrance id. Returns null when the id is not an authored node,
 * its requirement fact is unmet, or its position is not a supported walkable point clear of blocking colliders.
 */
export function resolveSafeNode(
  region: RegionDefinition,
  nodeId: string,
  facts: Readonly<Record<string, boolean | number | string>>,
  preferredCameraAnchorId?: string,
): CampaignSafeSpawn | null {
  const entrance = region.entrances.find((item) => item.id === nodeId);
  const node = region.navigation.nodes.find((item) => item.id === nodeId);
  const position = entrance?.from ?? node?.position;
  const requirement = entrance?.unlockFact ?? node?.requirement;
  if (!position || (requirement && facts[requirement] !== true) || !hasSafeWalkSurface(region, position)) return null;
  const camera = region.cameraAnchors.find((anchor) => anchor.id === preferredCameraAnchorId)
    ?? region.cameraAnchors.find((anchor) => anchor.id === region.id + "-explore")
    ?? region.cameraAnchors[0];
  if (!camera) return null;
  return { regionId: region.id as RegionId, position: { ...position }, routeId: nodeId, cameraAnchorId: camera.id };
}
