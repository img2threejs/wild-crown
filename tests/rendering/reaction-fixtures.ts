import type { CombatReactionKind, CombatReactionSnapshot } from '../../src/game/contracts.js';

/** A combat reaction snapshot as the simulation reports it: pushed toward -Z (a hit from the front on a body facing +Z). */
export function reactionAt(kind: CombatReactionKind, progress: number, partial: Partial<CombatReactionSnapshot> = {}): CombatReactionSnapshot {
  return { kind, direction: { x: 0, y: 0, z: -1 }, side: 'front', strength: 0.5, progress, durationTicks: 12, serial: 1, ...partial };
}

/** The 12-tick flinch a light player hit causes. */
export const flinchAt = (progress: number, partial: Partial<CombatReactionSnapshot> = {}): CombatReactionSnapshot => reactionAt('flinch', progress, partial);
