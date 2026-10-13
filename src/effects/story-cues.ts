import type { ActionId, AttackId, Vec3 } from '../game/contracts.js';
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
  | 'root-eruption' | 'beam' | 'bloom' | 'blink';
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
  readonly priority?: CuePriority;
  readonly shape?: CueShape;
  /**
   * Elemental identity. For monster attacks it mirrors `AttackDefinition.element` (`ATTACKS[cue.attackId].element`);
   * Aren's own cues carry 'arcane' (blade, sigil) or 'lightning' (Thunder Cleave); Yara's carry 'heartroot'. Player cues have no ATTACKS entry.
   * Cues without an elemental source omit this field rather than carry a placeholder.
   */
  readonly element?: AttackElement;
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
