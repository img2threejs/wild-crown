import type { ActionId, AttackId, Vec3 } from '../game/contracts.js';

export type StoryCueKind =
  | 'anticipation' | 'commit' | 'hit' | 'landing' | 'perfect-dodge'
  | 'heartroot' | 'tether' | 'cleanse' | 'bond' | 'dominion' | 'restoration'
  | 'restoration-water' | 'restoration-roots' | 'restoration-seeds' | 'restoration-animals'
  | 'possession' | 'phase' | 'ending' | 'ending-living-pact' | 'ending-dominion' | 'ending-severance'
  | 'sap-vein' | 'footprint' | 'pounce' | 'roar-cone' | 'low-wave'
  | 'grovebreak' | 'march' | 'reunion' | 'heartbeat';
export type CuePhase = 'anticipation' | 'commit' | 'hit' | 'landing' | 'sustain' | 'resolve';
export type CuePriority = 'essential' | 'story' | 'cosmetic';
export type CueShape = 'ring' | 'arc' | 'sector' | 'beam' | 'trail' | 'pulse' | 'footprint' | 'wave' | 'vein' | 'burst';

/** Presentation-only event stream. It is never a WorldEvent and carries no gameplay authority. */
export interface StoryCue {
  readonly instanceId: string;
  readonly tick: number;
  /** Engine-owned scaled world time at event creation; `tick` remains simulation identity. */
  readonly worldTimeSeconds: number;
  readonly kind: StoryCueKind;
  readonly phase: CuePhase;
  readonly actorId?: string;
  readonly targetId?: string;
  readonly scopeId?: string;
  readonly attackId?: AttackId;
  readonly actionId?: ActionId;
  readonly position?: Vec3;
  readonly from?: Vec3;
  readonly to?: Vec3;
  /** Authored hazard footprint in meters, plus orientation and actual arc aperture in radians. */
  readonly footprint?: Readonly<{ width: number; length: number; angleRadians?: number; sectorRadians?: number }>;
  /** Presentation lifetime in 60-Hz world ticks, aged by worldTimeSeconds. */
  readonly durationTicks?: number;
  readonly intensity?: number;
  readonly priority?: CuePriority;
  readonly shape?: CueShape;
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
