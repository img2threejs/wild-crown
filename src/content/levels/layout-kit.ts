import type { GroundSurfaceDefinition, RegionColliderDefinition, RegionDefinition, Vec3, WorldAssetPlacement } from "../../game/contracts.js";
import { v } from "./schema.js";

/**
 * Shared constructors of the neutral physical layouts (Canopy, Grove, Blood Bamboo Valley). A layout is pure geometry:
 * walk surfaces with their support colliders, navigation, cameras and set dressing. Trial regions and chapter regions
 * both assemble from these modules and add their own overlays (gates and trial monsters, or story interactions).
 */
export type SurfaceProfile = GroundSurfaceDefinition["profile"];
export interface WalkSurface { readonly surface: GroundSurfaceDefinition; readonly collider: RegionColliderDefinition }
export type CameraAnchor = RegionDefinition["cameraAnchors"][number];
export type NavNode = RegionDefinition["navigation"]["nodes"][number];
export type NavRibbon = RegionDefinition["navigation"]["ribbons"][number];

export const bounds2 = (points: readonly Vec3[]) => ({
  minX: Math.min(...points.map((point) => point.x)), maxX: Math.max(...points.map((point) => point.x)),
  minZ: Math.min(...points.map((point) => point.z)), maxZ: Math.max(...points.map((point) => point.z)),
});

/** A flat walk surface with a thin support slab under it (top flush with the floor) covering the polygon's bounding box. */
export function flat(id: string, profile: SurfaceProfile, material: string, thickness: number, points: readonly Vec3[]): WalkSurface {
  const elevation = points[0]!.y, box = bounds2(points);
  return {
    surface: { id, profile, points, elevation, thickness, walkable: true, material, colliderId: id + "-collider" },
    collider: {
      id: id + "-collider", kind: "box", from: v((box.minX + box.maxX) / 2, elevation - thickness / 2, (box.minZ + box.maxZ) / 2),
      halfExtents: v((box.maxX - box.minX) / 2, thickness / 2, (box.maxZ - box.minZ) / 2), blocksMovement: true, blocksCamera: false, walkSurfaceId: id,
    },
  };
}

/**
 * A ramp quad: the support collider is a non-blocking centre-line segment from the middle of its lowest edge to the middle of its
 * highest edge, as wide as the ramp. Works along any axis (the Canopy and Grove layouts ramp along +x, Blood Bamboo along +z).
 */
export function ramp(id: string, material: string, thickness: number, points: readonly Vec3[]): WalkSurface {
  const lowY = Math.min(...points.map((point) => point.y)), highY = Math.max(...points.map((point) => point.y));
  const low = points.filter((point) => point.y === lowY), high = points.filter((point) => point.y === highY);
  const mid = (edge: readonly Vec3[]): Vec3 => v(edge.reduce((sum, point) => sum + point.x, 0) / edge.length, edge[0]!.y, edge.reduce((sum, point) => sum + point.z, 0) / edge.length);
  const lowMid = mid(low), highMid = mid(high);
  const width = Math.hypot(low[0]!.x - low[low.length - 1]!.x, low[0]!.z - low[low.length - 1]!.z);
  return {
    surface: { id, profile: "ramp", points, elevation: (lowY + highY) / 2, thickness, walkable: true, material, colliderId: id + "-collider" },
    collider: { id: id + "-collider", kind: "segment", from: lowMid, to: highMid, radius: width / 2, blocksMovement: false, blocksCamera: false, walkSurfaceId: id },
  };
}

export const rect = (minX: number, minZ: number, maxX: number, maxZ: number, y = 0): Vec3[] => [v(minX, y, minZ), v(maxX, y, minZ), v(maxX, y, maxZ), v(minX, y, maxZ)];
/** A regular polygon (centimetre-rounded), first vertex due east of the centre. */
export const ngon = (cx: number, cz: number, radius: number, sides: number): Vec3[] =>
  Array.from({ length: sides }, (_, index) => v(Math.round((cx + Math.cos(index / sides * Math.PI * 2) * radius) * 100) / 100, 0, Math.round((cz + Math.sin(index / sides * Math.PI * 2) * radius) * 100) / 100));

/** Cameras keep the locked three-quarter offset (+10, +12, +14) from the point they frame. */
export const camera = (id: string, look: Vec3, mode: CameraAnchor["mode"]): CameraAnchor =>
  ({ id, position: v(look.x + 10, look.y + 12, look.z + 14), lookAt: look, mode });

export const placement = (id: string, assetId: string, position: Vec3, placementKind: WorldAssetPlacement["placement"], rotationY: number, scale: Vec3): WorldAssetPlacement =>
  ({ id, assetId, position, placement: placementKind, rotationY, scale });
export const uniform = (size: number): Vec3 => v(size, size, size);
