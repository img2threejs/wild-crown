import type { ActionId, AttackId, CombatReactionKind, Vec3 } from '../game/contracts.js';
import { ATTACKS, type AttackElement } from '../game/combat/content.js';

export type StoryCueKind =
  | 'cancel'
  | 'anticipation' | 'commit' | 'active' | 'hit' | 'landing' | 'perfect-dodge'
  | 'heartroot' | 'tether' | 'cleanse' | 'bond' | 'dominion' | 'restoration'
  | 'restoration-water' | 'restoration-roots' | 'restoration-seeds' | 'restoration-animals'
  | 'possession' | 'phase' | 'ending' | 'ending-living-pact' | 'ending-dominion' | 'ending-severance'
  | 'sap-vein' | 'footprint' | 'pounce' | 'roar-cone' | 'low-wave'
  | 'grovebreak' | 'march' | 'reunion' | 'heartbeat'
  | 'sigil' | 'projectile' | 'projectile-impact' | 'slash' | 'lightning' | 'judgement' | 'judgement-mark'
  // Yara (Heartroot Mage): root eruptions (lane/disk footprint), the Sap Lance beam, Heartroot Bloom phases and Petal Step blinks.
  | 'root-eruption' | 'beam' | 'bloom' | 'blink'
  // Combat reactions: victim id in actorId and targetId (player = 'aren'), `reactionKind`, intensity = strength 0..1, position = victim, to = position + push direction.
  | 'reaction-start' | 'wall-impact' | 'poise-break' | 'getup'
  // Companion field verbs: Vara's mark (actorId = vara, targetId = the hostile, position = the target, to = landing point or the target), Asha's guard (targetId = the protectee,
  // phase 'hit' on a block at the contact point), a field command (actionId = the FieldCommand, position = where it lands) and Tali's shelter (position = centre, footprint = its size, phase 'sustain' while in danger).
  // Vara's Storm Talon: 'anticipation' (climb), 'commit' (dive start), 'active' (swept dive), 'hit' (talon strike), 'sustain' (mark screech), 'landing' (back to perch).
  | 'mark' | 'guard' | 'command' | 'shelter' | 'storm-talon';
export type CuePhase = 'anticipation' | 'commit' | 'active' | 'hit' | 'landing' | 'sustain' | 'resolve';
export type CuePriority = 'essential' | 'story' | 'cosmetic';
export type CueShape = 'ring' | 'arc' | 'sector' | 'beam' | 'trail' | 'pulse' | 'footprint' | 'wave' | 'vein' | 'burst';

/** Presentation-only event stream. It is never a WorldEvent and carries no gameplay authority. */
export interface StoryCue {
  readonly instanceId: string;
  readonly tick: number;
  /** Exact engine-owned scaled world tick, including quarter ticks during slow motion. */
  readonly worldTick: number;
  /** Engine-owned scaled world time at event creation; `tick` remains simulation identity. */
  readonly worldTimeSeconds: number;
  readonly kind: StoryCueKind;
  readonly phase: CuePhase;
  /** Original phase start; restored cues retain progress while durationTicks is the remaining lifetime. */
  readonly phaseStartedAtWorldTick?: number;
  readonly actorId?: string;
  readonly targetId?: string;
  readonly scopeId?: string;
  readonly cancellationReason?: CueCancellationReason;
  readonly attackId?: AttackId;
  readonly actionId?: ActionId;
  readonly position?: Vec3;
  readonly from?: Vec3;
  readonly to?: Vec3;
  /** Authored hazard footprint in meters, plus orientation and actual arc aperture in radians. */
  readonly footprint?: Readonly<{ width: number; length: number; angleRadians?: number; sectorRadians?: number }>;
  /** Presentation lifetime in 60-Hz world ticks, aged by exact engine worldTick. */
  readonly durationTicks?: number;
  readonly intensity?: number;
  /** Reaction kind of a 'reaction-start' | 'wall-impact' | 'poise-break' | 'getup' cue. */
  readonly reactionKind?: CombatReactionKind;
  /** Actual vitality lost by this contact; hit feedback must not predict or award damage. */
  readonly confirmedDamage?: number;
  readonly priority?: CuePriority;
  readonly shape?: CueShape;
  /**
   * Elemental identity. For monster attacks it mirrors `AttackDefinition.element` (`ATTACKS[cue.attackId].element`);
   * Aren's own cues carry 'arcane' (blade, sigil) or 'lightning' (Thunder Cleave); Yara's carry 'heartroot'. Player cues have no ATTACKS entry.
   * Cues without an elemental source omit this field rather than carry a placeholder.
   */
  readonly element?: AttackElement;
  /**
   * Optional surface-contact metadata for cues which carry proof of a real, engine-confirmed touch.
   * `position` is the actual contact point; `to - position` is the attack travel direction, not a surface normal.
   * `normal` is the world-space surface normal at the contact point; it is the only thing a wall mark may use for orientation.
   * Surface id (when supplied) lets the residue renderer choose texture/material per surface family (rock, bark, ice, metal).
   * - Actor contacts: cue.kind === 'hit' with `confirmedDamage > 0` and a `targetId`. No expiry/miss ever carries contact metadata.
   * - Environment contacts: cue.kind === 'projectile-impact' (phase 'hit') with no `confirmedDamage`, accompanied by melee/proof metadata on the engine side.
   */
  readonly contact?: Readonly<{ readonly kind: 'actor' | 'solid' | 'ground'; readonly normal: Vec3; readonly surfaceId?: string }>;
}

export interface StoryCueSource {
  drainPresentationCues(): readonly StoryCue[];
}

export interface StoryCueActorState {
  readonly id: string;
  readonly position: Vec3;
  readonly sockets: Readonly<Record<string, Vec3>>;
  readonly downed: boolean;
  readonly possessed: boolean;
}

export interface StoryCueWorldState {
  readonly actors: readonly StoryCueActorState[];
  readonly tick: number;
}

export type CueCancellationReason = 'interrupt' | 'death' | 'unload' | 'skip' | 'load';

/** Authored family identity only; geometry and phase time always come from the emitted cue. */
export function dangerFamily(cue: StoryCue): 'strike' | 'sweep' | 'wave' | 'area' | 'projectile' | undefined {
  if (!cue.attackId || (cue.kind !== 'anticipation' && cue.kind !== 'commit' && cue.kind !== 'active' && cue.kind !== 'hit')) return undefined;
  const kind = ATTACKS[cue.attackId]?.hazard.kind;
  return kind === 'cone' ? 'area' : kind;
}
