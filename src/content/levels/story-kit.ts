import type { RegionDefinition, RegionRouteDefinition, Vec3 } from "../../game/contracts.js";
import { v } from "./schema.js";

/** Constructors of the chapter story overlays: actor instances, interaction targets, landmarks and routes. */
export type EntityPlacement = "ground" | "canopy" | "water" | "elevated" | "underground";
export type PropPlacement = RegionDefinition["props"][number];

export const prop = (id: string, assetId: string, position: Vec3, placement: PropPlacement["placement"], rotationY = 0, scale = v(1, 1, 1), visibleWhen?: string): PropPlacement =>
  ({ id, assetId, position, placement, rotationY, scale, ...(visibleWhen ? { visibleWhen } : {}) });
export const actor = (id: string, actorId: string, assetId: string, position: Vec3, placement: EntityPlacement, visibleWhen?: string) =>
  ({ id, actorId, kind: "actor" as const, position, assetId, placement, ...(visibleWhen ? { visibleWhen } : {}) });
export const target = (id: string, position: Vec3, placement: EntityPlacement = "ground", visibleWhen?: string) =>
  ({ id, kind: "interaction" as const, position, placement, interactionId: id, ...(visibleWhen ? { visibleWhen } : {}) });
export const landmark = (id: string, assetId: string, position: Vec3, placement: EntityPlacement = "ground", visibleWhen?: string) =>
  ({ id, kind: "landmark" as const, assetId, position, placement, ...(visibleWhen ? { visibleWhen } : {}) });
/** A prop-kind entity (a trap): addressable by instance id like an actor, drawn from the matching `props` placement of the same id. */
export const propEntity = (id: string, assetId: string, position: Vec3, placement: EntityPlacement = "ground") =>
  ({ id, kind: "prop" as const, position, assetId, placement });
export const route = (
  id: string, from: Vec3, to: Vec3, destinationRegionId: RegionDefinition["id"], kind: RegionRouteDefinition["kind"], traversalActionId: string,
  colliderIds: readonly string[], traversalEvent: string, unlockFact?: string,
): RegionRouteDefinition =>
  ({ id, from, to, anchors: [from, to], destinationRegionId, kind, traversalActionId, colliderIds, traversalEvent, ...(unlockFact ? { unlockFact } : {}) });
