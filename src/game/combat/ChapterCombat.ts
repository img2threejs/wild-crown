import type { ActorId, ChapterRuntimeDefinition, ChapterSpatialIntent, CompanionId, RegionDefinition, TrapSnapshot, Vec3 } from '../contracts.js';
import type { OrunAspect, OrunWardenMove } from './OrunBossContent.js';
import type { CombatActor, EngineState } from './CombatEngine.js';
import { distance2 } from './geometry.js';

/** Serializable chapter-combat state: spatial triggers, camp traps and the active boss cleanse sequence. */
export interface ChapterTrigger {
  readonly id: string;
  readonly kind: ChapterSpatialIntent['kind'];
  readonly center: Vec3;
  readonly radius: number;
  readonly requiresFacts: readonly string[];
}
export interface TrapState {
  readonly id: string;
  readonly position: Vec3;
  readonly radius: number;
  readonly disarmFact: string;
  /** One-hit latch: a sprung trap never fires again until the region is reloaded. */
  sprung: boolean;
  revealed: boolean;
}
export type SequenceKind = 'koro-thorn' | 'asha-cub';
export type SequenceStep = 'sealed' | 'thorn-exposed' | 'tethered' | 'settled' | 'stalking' | 'rage' | 'announce' | 'danger' | 'exposed' | 'failed';
export interface BossSequenceState {
  readonly kind: SequenceKind;
  step: SequenceStep;
  /** World tick the current timed window (announce, exposure, tether) ends; 0 when untimed. */
  until: number;
  /** Unpaused danger time left before Tali is lost (Asha). */
  dangerRemaining: number;
  /** Index into the Cub attack rotation. */
  attackCursor: number;
  /** Shelter-lane bamboo charges still in flight (hazard ids) and how many completed. */
  shelterHazardIds: string[];
  landedCharges: number;
  /** Authored positions read from the canonical region at encounter start (Asha). */
  shelter?: Vec3;
  arenaCenter?: Vec3;
  taliStatus?: 'in-danger' | 'sheltered' | 'reunion' | 'failed';
}
/** Serializable state of the Chapter 6 Fall of the Grove sequence (engine-owned transient state; world facts stay Director authority). */
export interface FallState {
  /** `possession` when an eligible recruit stood present when Orun struck; `player-only` turns Orun's roots on Aren. */
  branch: 'possession' | 'player-only';
  /** Canonical recruit id and its placed instance id (a projected party instance may carry a suffixed id). */
  allyId?: CompanionId;
  allyActorId?: ActorId;
  /** Possession hold instance (Orun's grasp hazard id) once it landed on the recruit. */
  possessionId?: string;
  /** Player-only branch: the root surge Aren must answer. */
  rootSurgeId?: string;
  /** Phase 0 resolved by the real break/answer; its `encounter-phase` cleared event was emitted. */
  protected: boolean;
  /** Tali waits at her placement, walks to the authored shelter once sent, and is sheltered when the safe rescue was emitted. */
  tali: 'waiting' | 'moving' | 'sheltered';
  pillarBraced: boolean;
  escaped: boolean;
}
/** A swept evasive body movement of Orun on the world clock (Perfect Dodge sidestep, Back Handspring flight); never a teleport. */
export interface OrunEvade {
  readonly move: 'perfect-dodge' | 'back-handspring';
  readonly dirX: number;
  readonly dirZ: number;
  readonly travel: number;
  done: number;
  fromTick: number;
  toTick: number;
}
/** One live Crowned Beast aspect attack: its hazards and how the hero answered it. */
export interface OrunAspectCast {
  readonly aspect: OrunAspect;
  /** Every hazard of the cast (Orun's and the Sky echoes'); the cast ends once all of them have closed. */
  hazardIds: string[];
  /** A cast hazard damaged the hero: the aspect stays unanswered. */
  hit: boolean;
  /** Sky: Vara's mark on the beast has lengthened the dives still in their windup (once per cast). */
  varaWarned?: boolean;
  /** Shadow: the true core window (world ticks) and whether the hero or Nyra struck it. */
  coreFrom?: number;
  coreUntil?: number;
  coreStruck?: boolean;
  /** Pack: the one depth band left open, and whether Sable revealed it. */
  gap?: Vec3;
  gapRevealed?: boolean;
  /** Canopy: Koro's accepted support asks for a vine escape; the transient swing route once built. */
  koroVine?: boolean;
  vine?: { from: Vec3; to: Vec3; anchors: Vec3[] };
  /** Crown: Solkar's accepted rally during the roar's windup (resists only at high per-companion Bond). */
  solkarRally?: boolean;
}
/** Serializable state of the Chapter 8 Heartroot Hollow duel (engine-owned transient state; world facts stay Director authority). */
export interface OrunState {
  /** Phase 1: Warden families shown, answered pressure, the proactive rotation and the reactive cooldowns. */
  shown: OrunWardenMove[];
  pressure: number;
  cursor: number;
  nextMoveAt: number;
  dodgeReadyAt: number;
  handspringReadyAt: number;
  evade?: OrunEvade;
  /** A Perfect Dodge queues the Cartwheel Counter riposte for the moment the sidestep ends. */
  riposte: boolean;
  /** Phase 2: the aspect cursor, the aspects answered and the live cast. */
  aspectIndex: number;
  answered: OrunAspect[];
  casts: number;
  cast?: OrunAspectCast;
  /** Phase 2 beast core and phase 3 crown core: Cleanse is accepted only before this world tick. */
  coreOpenUntil: number;
  /** Phase 3: recruits who already had their approach-to-core moment, and Orun's own attacks answered when no recruit remains. */
  moments: CompanionId[];
  soloAnswers: number;
}

export interface ChapterCombatState {
  triggers: ChapterTrigger[];
  /** Trigger ids the player currently stands inside (an intent re-arms only after the player leaves). */
  inside: string[];
  intents: ChapterSpatialIntent[];
  traps: TrapState[];
  sequence?: BossSequenceState;
  fall?: FallState;
  orun?: OrunState;
}
export function createChapterCombatState(): ChapterCombatState {
  return { triggers: [], inside: [], intents: [], traps: [] };
}

/** Resolves the runtime definition's checkpoints (nav node or entrance ids) and encounter entries against the loaded region. */
export function resolveChapterTriggers(runtime: ChapterRuntimeDefinition, region: RegionDefinition): ChapterTrigger[] {
  const triggers: ChapterTrigger[] = [];
  for (const checkpoint of runtime.checkpoints) {
    if (checkpoint.regionId !== region.id) continue;
    const node = region.navigation.nodes.find(candidate => candidate.id === checkpoint.nodeId);
    const entrance = node ? undefined : region.entrances.find(candidate => candidate.id === checkpoint.nodeId);
    const center = node?.position ?? entrance?.from;
    if (!center) throw new Error(`Chapter checkpoint ${checkpoint.id} references unknown node ${checkpoint.nodeId} in ${region.id}`);
    triggers.push({ id: checkpoint.id, kind: 'checkpoint', center: { ...center }, radius: checkpoint.radius, requiresFacts: [...checkpoint.requiresFacts] });
  }
  for (const entry of runtime.encounterEntries) {
    if (entry.regionId !== region.id) continue;
    triggers.push({ id: entry.id, kind: 'encounter-entry', center: { ...entry.center }, radius: entry.radius, requiresFacts: [...entry.requiresFacts] });
  }
  return triggers;
}

/**
 * Edge-triggered spatial intents: one intent when the player enters a trigger whose fact prerequisites hold, re-armed only after
 * the player leaves it. Allocation-free while nothing changes (the usual frame).
 */
export function updateChapterIntents(state: EngineState, player: CombatActor | undefined): void {
  const chapter = state.chapter;
  if (!chapter.triggers.length) return;
  for (const trigger of chapter.triggers) {
    const index = chapter.inside.indexOf(trigger.id);
    const inside = player !== undefined && !player.downed && distance2(player.position, trigger.center) <= trigger.radius && trigger.requiresFacts.every(fact => state.worldFacts[fact] === true);
    if (inside && index < 0) {
      chapter.inside.push(trigger.id);
      chapter.intents.push({ kind: trigger.kind, definitionId: trigger.id, simulationTick: state.tick });
    } else if (!inside && index >= 0) chapter.inside.splice(index, 1);
  }
}

/** Each field trap belongs to its own durable disarm group. */
export function trapsFromRegion(region: RegionDefinition): TrapState[] {
  return (region.fieldTraps ?? []).map(trap => ({
    id: trap.id, position: { ...trap.position }, radius: trap.radiusMeters,
    disarmFact: trap.disarmFact, sprung: false, revealed: false,
  }));
}
export function trapArmed(state: EngineState, trap: TrapState): boolean { return state.worldFacts[trap.disarmFact] !== true && !trap.sprung; }
export function trapSnapshots(state: EngineState): readonly TrapSnapshot[] {
  return state.chapter.traps.map(trap => ({ id: trap.id, position: { ...trap.position }, radius: trap.radius, armed: trapArmed(state, trap), sprung: trap.sprung, revealed: trap.revealed || trap.sprung }));
}
/** Reveals every trap within `radius` of `center` (a companion search or a Vara mark); returns how many became visible. */
export function revealTrapsNear(state: EngineState, center: Vec3, radius: number): number {
  let revealed = 0;
  for (const trap of state.chapter.traps) {
    if (!trap.revealed && distance2(trap.position, center) <= radius) { trap.revealed = true; revealed++; }
  }
  return revealed;
}
