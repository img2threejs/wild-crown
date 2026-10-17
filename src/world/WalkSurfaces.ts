import type { GroundSurfaceDefinition } from '../game/contracts';

/** Region-wide supporting plane removed by the closed-route redesign; if it still exists it is never rendered. */
export const GREENWAKE_CANOPY_FLOOR_ID = 'greenwake-canopy-floor';
/**
 * Walk-surface materials of the bridge decks: not terrain-backed (the bridge model is the deck), the carved gully or
 * river runs beneath them.
 */
export const BRIDGE_DECK_MATERIALS: Readonly<Record<string, true>> = { 'greenwake-bridge-deck': true, 'canopy-bridge-deck': true, 'moonpine-bridge-deck': true };

const FLAT_EPSILON = 1e-3;

export function isGroundWalkSurface(surface: GroundSurfaceDefinition): boolean {
  return surface.walkable && surface.points.length >= 3 && surface.profile !== 'water' && surface.material !== 'water' && surface.id !== GREENWAKE_CANOPY_FLOOR_ID;
}

/** A walkable surface lying entirely on y = 0: rendered as part of the visual terrain instead of a flat plate. */
export function isFlatGroundSurface(surface: GroundSurfaceDefinition): boolean {
  return isGroundWalkSurface(surface) && surface.points.every((point) => Math.abs(point.y) < FLAT_EPSILON);
}

/** A walkable surface that rises above the ground (ramps, ridge and cliff tops, bridge decks). */
export function isRaisedWalkSurface(surface: GroundSurfaceDefinition): boolean {
  return isGroundWalkSurface(surface) && surface.points.some((point) => Math.abs(point.y) >= FLAT_EPSILON);
}

/** A bridge deck: walkable, but the bridge model is its only visual and the gully / river is carved beneath it. */
export function isBridgeDeckSurface(surface: GroundSurfaceDefinition): boolean {
  return isGroundWalkSurface(surface) && BRIDGE_DECK_MATERIALS[surface.material] === true;
}
