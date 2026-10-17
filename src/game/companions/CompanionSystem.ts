import type { ActionId, ActorId, CommandAvailability, CompanionCommandRequest, CompanionId, CompanionProgress, CompanionTarget, FieldCommand, InteractionDefinition, Vec3 } from '../contracts.js';
import type { CombatActor, EngineState, LiveHazard, LiveMovableObject } from '../combat/CombatEngine.js';
import { COMPANION_COPY, INTERACTIONS, REGIONS } from '../../content/campaign.js';
import { ENCOUNTER_RESETTABLE_OBJECT_IDS, GUARDABLE_ATTACK_IDS, TRAP } from '../combat/ActOneBossContent.js';
import { revealTrapsNear } from '../combat/ChapterCombat.js';
import { ATTACKS } from '../combat/content.js';
import { appendCue, emitWorldEvent, pushEvent } from '../combat/EngineEffects.js';
import { wrapAngle } from '../combat/WildlifePressure.js';
import { distance2, facingFrom, groundHeightAt, isAerialCirclePathClear, isCirclePathClear, isSupportedCapsulePose, moveAerialCircle, moveCircle } from '../combat/geometry.js';
import { isArmoured, isBossActor, liveAttackOf, reactToCompanionHit } from '../combat/HitReactions.js';
import { movableObjectPathClear } from '../combat/MovableObjects.js';
import { beginReaction, hit, stunPlan } from '../combat/reactions.js';
import { ORUN_GUARDABLE_ATTACK_IDS } from '../combat/OrunBossContent.js';
import { orunAspectSupport } from '../combat/OrunPhases.js';
import { COMPANION_BALANCE as BALANCE, COMPANION_SPECIALIZATIONS, companionSkillByAction, companionSkillFor, type CompanionSkill } from './CompanionSkills.js';
import { isCompanionId } from './CompanionLoadout.js';

/** Every command a companion can receive: the eight field verbs plus the later-act Ask/Signal interaction abilities. */
export type CompanionCommand = FieldCommand | 'ask' | 'signal';
export type ReservationSlot = 'front' | 'left' | 'right' | 'rear' | 'far-support' | 'aerial';
export interface CompanionDefinition { id: CompanionId; species: string; faction: 'sky' | 'canopy' | 'fang' | 'pack' | 'shadow' | 'crown'; utilities: readonly string[]; ability: string; abilityLabel: string; abilityDescription: string; large: boolean; aerial: boolean; }
/** A finite command in progress. All times are world ticks. */
export interface CompanionJob {
  command: FieldCommand;
  phase: 'approach' | 'act';
  startedAt: number;
  /** Hard deadline: the job always ends by here. */
  endsAt: number;
  /** Where the job walks to (an interaction or object), when it has a place. */
  point?: Vec3;
  interactionId?: string;
  objectId?: string;
  /** World tick a timed act (the search dwell) completes. */
  actAt?: number;
}
/** One finite native gesture. Release and contact are separate, so a thrown seed really travels before it lands. */
export interface CompanionSkillState {
  actionId: string; kind: 'mark' | 'support' | 'search' | 'distract' | 'object';
  startedAt: number; releaseAt: number; contactAt: number; endsAt: number;
  released: boolean; resolved: boolean; scopeId: string;
}
/** Asha's finite charge intercept. */
export interface GuardState { protecteeId: ActorId; hazardId: string; state: 'moving' | 'blocking' | 'recovery'; until: number; }
/** Live Storm Talon job for Vara: windup on a target, dive along a swept path, strike on contact, recover back to flight altitude. */
export interface StormTalonState {
  phase: 'climb' | 'dive' | 'strike' | 'recover';
  startedAt: number;
  phaseEndTick: number;
  endsAt: number;
  targetId: ActorId;
  /** Windup altitude: above and behind the target by VARA_STORM_CLIMB_HEIGHT + back offset; refreshed each climb tick so the apex tracks a moving target. */
  climbPosition: Vec3;
  /** Strike point on the swept dive path; updated each dive tick. */
  diveFrom: Vec3;
  /** Strike goal at the target's body mid-height band, refreshed every dive tick so the raptor stoop tracks the prey. */
  diveTo: Vec3;
  /** Distance the swept capsule must close in 3D before the strike fires. */
  diveStrikeRadius: number;
  /** Tick the dive phase started; used to compute progress and the pursuit extension. */
  diveStartedAt: number;
  /** True once a real, in-contact strike has applied (so the tick handler can refund a missed strike). */
  struck: boolean;
  /** Whether the target carried Vara's mark when the dive started; consumed on strike. */
  wasMarked: boolean;
  /** True when the dive phase elapsed past its nominal duration with no contact; the recovery that follows refunds the token. */
  missed: boolean;
}
/** Vara's bird flight state machine. Ground operations use 'grounded' and 'walk' (the perch hop). Airborne states drive actionId selection. */
export interface FlightState {
  phase: 'grounded' | 'takeoff' | 'flying' | 'hovering' | 'landing';
  /** World tick the current phase started; transition at >=0.5 s for takeoff, >=0.6 s for landing. */
  phaseStartedAt: number;
  /** Last perch point (the supported ground node under the takeoff or landing target). */
  perch: Vec3 | undefined;
  /** Last reported Aren position (refreshed tick powers) for the >3 m wander gate. */
  playerAnchor: Vec3;
  /** Last Aren position when Aren first went still (used to count timer ticks while perched). */
  playerIdleSince: number;
}
export interface CompanionSlotState {
  companionId: CompanionId;
  mode: 'follow' | 'stay' | 'focus' | 'defend' | 'search' | 'distract' | 'special';
  targetId?: ActorId;
  /** World tick the next finite command is accepted. */
  readyAt: number;
  token: number;
  position: Vec3;
  pathFallback: boolean;
  possessed: boolean;
  job?: CompanionJob;
  skill?: CompanionSkillState;
  guard?: GuardState;
  /** Active Storm Talon dive on Vara; replaces the follow/move logic while running. */
  stormTalon?: StormTalonState;
  /** Vara's flight state machine; absent until first step. */
  flight?: FlightState;
  /** A real rear-threat warning awaiting the hero's facing response, in world ticks. */
  warning?: { targetId: ActorId; endsAt: number };
  warningReadyAt?: number;
  /** Where this companion stands relative to its target; assigned by `assignReservations`. */
  reservation?: ReservationSlot;
  /** World tick until which Orun's suppression binds this companion: no command, signal or support is accepted. */
  suppressedUntil?: number;
}
export interface CompanionObjectRequest { objectId: string; interactionId: string; actorId: ActorId; }
export interface CompanionRosterState {
  chapter: number; wardenCall: boolean; bond: number; dominionUsed: boolean;
  companionId?: CompanionId;
  slots: Partial<Record<CompanionId, CompanionSlotState>>;
  navNodes: readonly NavNode[];
  /** World ticks: `nextAt` is when the next token returns. */
  tokens: { available: number; maximum: number; nextAt: number };
  /** Narrative Bond/Dominion; roster access does not require story recruitment. */
  progress?: Partial<Record<CompanionId, CompanionProgress>>;
  /** Reservations must be recomputed (a target changed, died or a command was accepted). */
  reservationsDirty: boolean;
  /** Koro object moves waiting for the engine's movable-object transaction. */
  objectRequests: CompanionObjectRequest[];
  /** Automatic support checks reserve one command token for the player. */
  assistReadyAt?: number;
  /** Strong support cooldowns survive unequipping; these are deadlines, not additional active companions. */
  supportReadyAt: Partial<Record<CompanionId, number>>;
  ownerBoon?: { kind: 'haste' | 'power'; sourceId: CompanionId; untilWorldTick: number };
}
export interface NavNode { id: string; position: Vec3; links: readonly string[]; requirement?: string; }
export interface CompanionLimits { activeSupportSlots: number; maxActiveTokens: number; maxHostiles: number; maxLargeActors: number; }

export const COMPANION_ROSTER: readonly CompanionDefinition[] = [
  { id: 'vara', species: 'harpy-eagle', faction: 'sky', utilities: ['observe', 'mark', 'scout', 'warn'], ability: 'storm-talon', abilityLabel: COMPANION_COPY.vara.storm_talon.label, abilityDescription: COMPANION_COPY.vara.storm_talon.description, large: false, aerial: true },
  { id: 'koro', species: 'macaque', faction: 'canopy', utilities: ['move-object', 'open-route', 'distract', 'harvest'], ability: 'canopy-route', abilityLabel: COMPANION_COPY.koro.mending_seed.label, abilityDescription: COMPANION_COPY.koro.mending_seed.description, large: false, aerial: false },
  { id: 'asha', species: 'tiger', faction: 'fang', utilities: ['defend', 'protect', 'pin'], ability: 'fang-guard', abilityLabel: COMPANION_COPY.asha.charge_block.label, abilityDescription: COMPANION_COPY.asha.charge_block.description, large: true, aerial: false },
  { id: 'sable', species: 'wolf', faction: 'pack', utilities: ['track', 'coordinate', 'flank'], ability: 'pack-flank', abilityLabel: COMPANION_COPY.sable.flank.label, abilityDescription: COMPANION_COPY.sable.flank.description, large: false, aerial: false },
  { id: 'nyra', species: 'panther', faction: 'shadow', utilities: ['reveal', 'ambush', 'mark'], ability: 'shadow-ambush', abilityLabel: COMPANION_COPY.nyra.ambush.label, abilityDescription: COMPANION_COPY.nyra.ambush.description, large: false, aerial: false },
  { id: 'solkar', species: 'lion', faction: 'crown', utilities: ['rally', 'interrupt', 'calm-wildlife'], ability: 'crown-rally', abilityLabel: COMPANION_COPY.solkar.ember_rally.label, abilityDescription: COMPANION_COPY.solkar.ember_rally.description, large: true, aerial: false },
];
export const COMPANION_LIMITS: CompanionLimits = { activeSupportSlots: 1, maxActiveTokens: 2, maxHostiles: 6, maxLargeActors: 2 };

// ---- timing (all world ticks, so slow time and pause move companions in step with hazards) ----------------------------
const RESOURCE_TICK = 90;
const COMMAND_COOLDOWN = 75;
const ABILITY_COST = 1;
const SUPPORT_TIMEOUT = 300;
const DEFEND_TICKS = 600;
const SEARCH_TIMEOUT = 600;
const OBJECT_TIMEOUT = 600;
const DISTRACT_TICKS = 180;
/** A distraction cannot be reissued until its attention override has run out and this long has passed. */
const DISTRACT_REST = 120;
const MARK_TICKS = 300;
const MARK_EXTENSION = 30;
/** Command range and sight of focus/distract/mark, measured from the hero. */
const FOCUS_RANGE = 16;
const SEARCH_RANGE = 30;
/** Bond/Dominion thresholds of the proposed Act I tuning. */
const BOND_BONUS = 25;
const DOMINION_BONUS = 25;
const GUARD_STANCE = 1.3;
const GUARD_RADIUS = 2.1;
const GUARD_CONE_DEGREES = 70;
const GUARD_RECOVERY = 45;
const GUARD_SPEED = 0.055;
/** Companions step clear of hostile hazards that open within this many world ticks. */
const HAZARD_LOOKAHEAD = 40;

const COMPANION_RADIUS = 0.32;
const FOLLOW_DISTANCE = 1.65;
const ARRIVE_DISTANCE = 0.75;
/** Companion locomotion. Stride is metres per world tick (0.055 = 3.3 m/s); it ramps up over about 0.2 s and the reported velocity coasts to zero over a few ticks once the goal is reached. */
const COMPANION_STRIDE = 0.055;
const COMPANION_STRIDE_RAMP = 0.0045;
const COMPANION_COAST = 0.55;
const COMPANION_STOP_SPEED = 0.05;
const COMPANION_TURN_STEP = 0.17;
const WORLD_STEP_SECONDS = 1 / 60;

/** Vara's Storm Talon (Harpy Eagle). Phases all run on the world clock. */
const STORM_TALON_RISE_TICKS = 24; // ~0.4 s climb to ~4 m above the target
const STORM_TALON_DIVE_TICKS = 21; // ~0.35 s swept dive
/** Maximum extra ticks the dive may pursue a moving target beyond the nominal duration before declaring a miss. */
const STORM_TALON_DIVE_PURSUIT_TICKS = 12; // ~0.2 s of pursuit at dive speed
const STORM_TALON_RECOVER_TICKS = 36; // ~0.6 s climb back to follow altitude
const STORM_TALON_STRIKE_TICKS = 18;
const STORM_TALON_CLIMB_HEIGHT = 4; // metres above the target when the dive starts
/** Horizontal back-offset (along -target.facing) of the climb apex; large enough that the 2D strike check cannot fire at the top of the climb. */
const STORM_TALON_BACK_OFFSET = 3;
/** Extra reach granted to the strike beyond the combined radii (so a moving victim cannot dodge the talons). */
const STORM_TALON_STRIKE_REACH = 0.6;
const STORM_TALON_DAMAGE = BALANCE.minorDamage;
const STORM_TALON_POISE = 2;
const STORM_TALON_KNOCKBACK = 0.15;
const STORM_TALON_MARK_MULTIPLIER = 1.5;
/** Beyond this horizontal distance the dive target is considered out of range; the missed refund fires. */
const STORM_TALON_DISENGAGE_RANGE = 32;
/** A short recovery pose when the dive genuinely missed (the token is refunded and Vara regains flight altitude quickly). */
const STORM_TALON_MISS_RECOVER_TICKS = 18;
/** Vara's flight altitude while airborne (above ground). */
const VARA_FLY_ALTITUDE = 2.4;
/** Vara waits this many idle ticks after Aren stops moving before she considers perching (>=4 s). */
const VARA_PERCH_IDLE_TICKS = 240;
/** Vara's perch hop only succeeds within this radius of Aren; she never lands on unreachable terrain. */
const VARA_PERCH_REACH = 1.7;
/** Aren must have wandered at least this far for Vara to take off on movement. */
const VARA_TAKEOFF_TRAVEL = 3;
/** Vara takes off whenever any live hostile closes within this radius (overrides perch/idle). */
const VARA_THREAT_RADIUS = 14;

/** Where each companion prefers to stand around a target; conflicts resolve in companion-id order. */
const RESERVATION_PREFERENCE: Readonly<Record<CompanionId, readonly ReservationSlot[]>> = {
  vara: ['aerial'],
  koro: ['far-support', 'rear', 'left', 'right'],
  asha: ['right', 'left', 'rear', 'front'],
  sable: ['left', 'right', 'rear', 'front'],
  nyra: ['rear', 'left', 'right', 'front'],
  solkar: ['front', 'left', 'right', 'rear'],
};

export function createCompanionState(companionId?: CompanionId, chapter = 1): CompanionRosterState {
  if (companionId !== undefined && !isCompanionId(companionId)) throw new Error('Unknown companion.');
  const state: CompanionRosterState = {
    chapter, wardenCall: false, bond: 0, dominionUsed: false, companionId,
    slots: {}, navNodes: [], tokens: { available: COMPANION_LIMITS.maxActiveTokens, maximum: COMPANION_LIMITS.maxActiveTokens, nextAt: 0 },
    reservationsDirty: false, objectRequests: [], supportReadyAt: {},
  };
  if (companionId) state.slots[companionId] = newSlot(companionId, { x: 0, y: 0, z: 0 });
  return state;
}
function newSlot(id: CompanionId, position: Vec3): CompanionSlotState {
  return { companionId: id, mode: 'follow', readyAt: 0, token: 0, position: { ...position }, pathFallback: false, possessed: false };
}
/** Fills the fields a saved roster state may lack (states written before per-companion progression and world-clock jobs). */
export function normalizeCompanionState(saved: CompanionRosterState): CompanionRosterState {
  const legacy = saved as CompanionRosterState & Record<string, unknown>;
  if ('combat' in legacy || 'utility' in legacy || 'scout' in legacy) {
    const id = legacy.combat ?? legacy.utility ?? legacy.scout;
    if (id !== undefined && !isCompanionId(id)) throw new Error('Saved companion selection is invalid.');
    saved.companionId = id as CompanionId | undefined;
    delete legacy.combat; delete legacy.utility; delete legacy.scout; delete legacy.assistCursor;
  }
  const id = saved.companionId;
  if (id !== undefined && !isCompanionId(id)) throw new Error('Saved companion selection is invalid.');
  saved.slots = id ? { [id]: saved.slots[id] ?? newSlot(id, { x: 0, y: 0, z: 0 }) } : {};
  saved.reservationsDirty ??= false;
  saved.objectRequests ??= [];
  saved.supportReadyAt ??= {};
  return saved;
}

export function configureCompanions(state: EngineState, config: { chapter?: number; wardenCall?: boolean; bond?: number; dominionUsed?: boolean; navNodes?: readonly NavNode[] }): void {
  const companions = state.companionState;
  if (config.chapter !== undefined) companions.chapter = config.chapter;
  if (config.wardenCall !== undefined) companions.wardenCall = config.wardenCall;
  if (config.bond !== undefined) companions.bond = Math.max(0, Math.min(100, config.bond));
  if (config.dominionUsed !== undefined) companions.dominionUsed = config.dominionUsed;
  if (config.navNodes) companions.navNodes = structuredClone(config.navNodes);
}

/** Story relationship progress changes tuning, never access to the unlocked roster. */
export function configureCompanionProgress(state: EngineState, progress: Readonly<Record<CompanionId, CompanionProgress>>): void {
  state.companionState.progress = structuredClone(progress);
}
function bondOf(state: CompanionRosterState, id: CompanionId): number { return state.progress?.[id]?.bondLevel ?? state.bond; }
function dominionOf(state: CompanionRosterState, id: CompanionId): number { return state.progress?.[id]?.dominionLevel ?? 0; }
function cooldownOf(state: CompanionRosterState, id: CompanionId): number { return bondOf(state, id) >= BOND_BONUS ? Math.round(COMMAND_COOLDOWN * 0.8) : COMMAND_COOLDOWN; }

/** A source-bound, non-stacking owner benefit. Suppression, possession and expiry stop it immediately. */
export function companionOwnerMultiplier(engine: EngineState, kind: 'haste' | 'power'): number {
  const state = engine.companionState, boon = state.ownerBoon;
  if (!boon || boon.kind !== kind || boon.sourceId !== state.companionId || boon.untilWorldTick <= engine.worldTick) return 1;
  const slot = state.slots[boon.sourceId], actor = companionActor(engine, boon.sourceId);
  if (!slot || !actor?.visible || actor.downed || isPossessed(engine, slot, actor) || (slot.suppressedUntil ?? 0) > engine.worldTick) return 1;
  return kind === 'haste' ? BALANCE.hasteMultiplier : BALANCE.powerMultiplier;
}

function ownerInRange(engine: EngineState, source: CombatActor): CombatActor | undefined {
  const owner = playerOf(engine);
  return owner?.visible && !owner.downed && engine.player.vitality > 0 && distance2(owner.position, source.position) <= BALANCE.ownerRange ? owner : undefined;
}

// ---- command planning (one source for availability, targets and commit) ----------------------------------------------

type PlanKind = 'follow' | 'recall' | 'stay' | 'mark' | 'support' | 'defend' | 'guard' | 'search' | 'distract' | 'object' | 'storm-talon';
interface Plan {
  readonly ok: true;
  readonly kind: PlanKind;
  readonly slot: CompanionSlotState;
  readonly actor: CombatActor;
  readonly cost: number;
  readonly hostile?: CombatActor;
  readonly protectee?: CombatActor;
  readonly hazard?: LiveHazard;
  readonly interaction?: InteractionDefinition;
  readonly object?: LiveMovableObject;
  readonly point?: Vec3;
}
interface Rejection { readonly ok: false; readonly reason: string; readonly readyAt: number; readonly cost: number; }

function reject(reason: string, cost = 0, readyAt = 0): Rejection { return { ok: false, reason, readyAt, cost }; }
function costOf(id: CompanionId, command: FieldCommand): number {
  if (command === 'follow' || command === 'recall' || command === 'stay') return 0;
  // Vara's Mark Weakness stays free; her Storm Talon costs a token.
  if (id === 'vara' && command !== 'special') return 0;
  if (command === 'search' || command === 'distract') return 0;
  return ABILITY_COST;
}
function playerOf(engine: EngineState): CombatActor | undefined { return engine.actors.find(actor => actor.id === engine.playerId); }

function planCommand(engine: EngineState, request: CompanionCommandRequest): Plan | Rejection {
  const { companionId: id, command, target } = request;
  const state = engine.companionState, cost = costOf(id, command);
  const definition = COMPANION_ROSTER.find(companion => companion.id === id);
  if (!definition) return reject('Unknown companion', cost);
  const slot = state.slots[id], actor = companionActor(engine, id);
  if (!slot || !isActive(state, id)) return reject('Not equipped', cost);
  if (!actor || !actor.visible || actor.downed) return reject('Not available', cost);
  if (isPossessed(engine, slot, actor)) return reject('Possessed', cost);
  if (command === 'follow' || command === 'recall' || command === 'stay') return { ok: true, kind: command, slot, actor, cost };
  if (engine.worldTick < slot.readyAt) return reject('Recovering', cost, slot.readyAt);
  if ((slot.suppressedUntil ?? 0) > engine.worldTick) return reject('Suppressed', cost, slot.suppressedUntil);
  const support = command === 'focus' && id !== 'vara' || command === 'special' && !(id === 'koro' && target?.kind === 'interaction') || command === 'defend' && id === 'asha';
  const supportReadyAt = state.supportReadyAt[id] ?? 0;
  if (support && engine.worldTick < supportReadyAt) return reject('Support cooling down', cost, supportReadyAt);
  if (cost > 0 && state.tokens.available < cost) return reject('No command tokens', cost, state.tokens.nextAt);
  const player = playerOf(engine);
  if (!player) return reject('No hero', cost);
  switch (command) {
    case 'focus': {
      const hostile = hostileTarget(engine, player, target);
      if (typeof hostile === 'string') return reject(hostile, cost);
      return { ok: true, kind: id === 'vara' ? 'mark' : 'support', slot, actor, cost, hostile };
    }
    case 'defend': {
      if (id === 'asha') return planGuard(engine, player, slot, actor, cost, target);
      const protectee = protecteeTarget(engine, player, target);
      return typeof protectee === 'string' ? reject(protectee, cost) : { ok: true, kind: 'defend', slot, actor, cost, protectee };
    }
    case 'search': return planSearch(engine, player, slot, actor, cost, target);
    case 'distract': {
      const hostile = hostileTarget(engine, player, target);
      if (typeof hostile === 'string') return reject(hostile, cost);
      if (isBossActor(engine, hostile)) return reject('Target is immune to distraction', cost);
      if (hostile.attention && hostile.attention.untilWorldTick > engine.worldTick) return reject('Already distracted', cost);
      return { ok: true, kind: 'distract', slot, actor, cost, hostile };
    }
    case 'special': return planSpecial(engine, player, slot, actor, cost, request);
  }
}

function planSearch(engine: EngineState, player: CombatActor, slot: CompanionSlotState, actor: CombatActor, cost: number, target: CompanionTarget | undefined): Plan | Rejection {
  if (!target) return { ok: true, kind: 'search', slot, actor, cost };
  if (target.kind !== 'interaction') return reject('Search needs a place to look', cost);
  const interaction = INTERACTIONS.find(candidate => candidate.id === target.interactionId && candidate.targetId === target.targetId);
  if (!interaction || interaction.regionId !== engine.regionId) return reject('Unknown search target', cost);
  if (!['inspect', 'track', 'collect'].includes(interaction.kind) || interaction.success.type !== 'semantic-interaction') return reject('Nothing to search there', cost);
  if (interaction.requiresFacts.some(fact => engine.worldFacts[fact] !== true)) return reject('Not discovered yet', cost);
  if (engine.seenWorldKeys.includes(searchEventId(engine, interaction.id))) return reject('Already searched', cost);
  const point = interactionPoint(engine, interaction);
  if (!point) return reject('Unknown search target', cost);
  if (distance2(player.position, point) > SEARCH_RANGE) return reject('Out of range', cost);
  return { ok: true, kind: 'search', slot, actor, cost, interaction, point };
}

function planSpecial(engine: EngineState, player: CombatActor, slot: CompanionSlotState, actor: CombatActor, cost: number, request: CompanionCommandRequest): Plan | Rejection {
  const { companionId: id, target } = request;
  if (id === 'vara') {
    // Special is Storm Talon (the new harpy-eagle dive): cost 1 token, valid hostile with line of sight, no active storm dive in flight.
    const hostile = hostileTarget(engine, player, target ?? defaultTarget(engine));
    if (typeof hostile === 'string') return reject(hostile, cost);
    if (slot.stormTalon) return reject('Recovering', cost, slot.stormTalon.endsAt);
    return { ok: true, kind: 'storm-talon', slot, actor, cost, hostile };
  }
  if (id === 'asha') {
    return planGuard(engine, player, slot, actor, cost, target);
  }
  if (id === 'koro' && target?.kind === 'interaction') return planObject(engine, slot, actor, cost, target);
  const hostile = hostileTarget(engine, player, target ?? defaultTarget(engine));
  return typeof hostile === 'string' ? reject(hostile, cost) : { ok: true, kind: 'support', slot, actor, cost, hostile };
}

function planObject(engine: EngineState, slot: CompanionSlotState, actor: CombatActor, cost: number, target: Extract<CompanionTarget, { kind: 'interaction' }>): Plan | Rejection {
  const object = engine.movableObjects.find(candidate => candidate.objectId === target.targetId);
  const interaction = object && INTERACTIONS.find(candidate => candidate.id === target.interactionId && candidate.id === object.authored.koroInteractionId);
  if (!object || !interaction) return reject('Unknown object', cost);
  const definition = object.authored;
  if (definition.requiredCompanionId !== actor.archetypeId) return reject('This object needs its equipped companion', cost);
  const resettable = ENCOUNTER_RESETTABLE_OBJECT_IDS.includes(object.objectId);
  if (object.phase !== 'resting' || (!resettable && engine.worldFacts[definition.movedFactId] === true)) return reject('Already moved', cost);
  if (definition.requiredFacts.some(fact => engine.worldFacts[fact] !== true) || interaction.requiresFacts.some(fact => engine.worldFacts[fact] !== true)) return reject('Not ready', cost);
  if (resettable && engine.chapter?.sequence?.step !== 'danger') return reject('Nothing to release yet', cost);
  if (!movableObjectPathClear(engine, object, actor.id)) return reject('Object path blocked', cost);
  return { ok: true, kind: 'object', slot, actor, cost, interaction, object, point: { ...object.position } };
}

function planGuard(engine: EngineState, player: CombatActor, slot: CompanionSlotState, actor: CombatActor, cost: number, target: CompanionTarget | undefined): Plan | Rejection {
  if (target?.kind !== 'hazard') return reject('Pick an incoming charge to block', cost);
  const hazard = engine.hazards.find(candidate => candidate.id === target.hazardId);
  if (!hazard || engine.worldTick >= hazard.activeFrom) return reject('No incoming charge to block', cost);
  const attack = ATTACKS[hazard.attackId];
  if (!attack || !attack.interruptibleBy.includes('guard') || !(GUARDABLE_ATTACK_IDS.includes(attack.id) || ORUN_GUARDABLE_ATTACK_IDS.includes(attack.id))) return reject('That attack cannot be blocked', cost);
  const protectee = actorById(engine, target.protecteeId);
  if (!protectee || protectee.id !== player.id && protectee.allegiance !== 'ally' || !protectee.visible || protectee.downed) return reject('Nobody to protect', cost);
  if (hazard.targetActorId !== undefined && hazard.targetActorId !== protectee.id) return reject('That charge is not aimed at them', cost);
  // The charge must actually reach the protectee (a wall-clamped lane stops short) and the stance must lie on that committed lane,
  // on supported ground the guard can walk to before contact: an impossible block is refused before any token is spent.
  const dx = protectee.position.x - hazard.target.x, dz = protectee.position.z - hazard.target.z;
  const along = dx * hazard.direction.x + dz * hazard.direction.z, side = dx * -hazard.direction.z + dz * hazard.direction.x;
  if (Math.abs(along) > hazard.depth / 2 + protectee.radius || Math.abs(side) > hazard.width / 2 + protectee.radius) return reject('That charge will not reach them', cost);
  const stance = guardPoint(hazard, protectee);
  if (Math.abs((stance.x - hazard.target.x) * hazard.direction.x + (stance.z - hazard.target.z) * hazard.direction.z) > hazard.depth / 2) return reject('No room to intercept on that lane', cost);
  if (distance2(actor.position, stance) > GUARD_SPEED * (hazard.activeFrom - engine.worldTick) + GUARD_RADIUS) return reject('Too far to intercept', cost);
  const ground = groundHeightAt(engine.arena, stance.x, stance.z, stance.y);
  if (ground === null || navWaypoint(engine, actor.position, { x: stance.x, y: ground, z: stance.z }, actor.collisionHeight) === null) return reject('No path to intercept', cost);
  return { ok: true, kind: 'guard', slot, actor, cost, hazard, protectee };
}

function defaultTarget(engine: EngineState): CompanionTarget | undefined {
  return engine.targetId ? { kind: 'actor', instanceId: engine.targetId } : undefined;
}
function searchEventId(engine: EngineState, interactionId: string): string { return `${engine.runId}:companion-search:${interactionId}`; }
function interactionPoint(engine: EngineState, interaction: InteractionDefinition): Vec3 | undefined {
  const region = REGIONS.find(candidate => candidate.id === engine.regionId);
  const entity = region?.entities.find(candidate => candidate.interactionId === interaction.id || candidate.id === interaction.id) ?? region?.entities.find(candidate => candidate.id === interaction.targetId || candidate.actorId === interaction.targetId);
  return entity ? { ...entity.position } : undefined;
}
/** `hazard.direction` is the committed lane; the guard stands in the lane between the attacker and the protectee. */
function guardPoint(hazard: LiveHazard, protectee: CombatActor): Vec3 {
  return { x: protectee.position.x - hazard.direction.x * GUARD_STANCE, y: protectee.position.y, z: protectee.position.z - hazard.direction.z * GUARD_STANCE };
}

/** A hostile instance the hero can see within command range, or the reason it cannot be targeted. */
function hostileTarget(engine: EngineState, player: CombatActor, target: CompanionTarget | undefined): CombatActor | string {
  if (target?.kind !== 'actor') return 'No target';
  const resolved = resolveActor(engine, target.instanceId);
  if (typeof resolved === 'string') return resolved;
  if (!resolved.visible || resolved.downed) return 'Target is not available';
  if (resolved.allegiance !== 'hostile') return 'Not a hostile target';
  if (distance2(player.position, resolved.position) > FOCUS_RANGE) return 'Out of range';
  if (!hasLineOfSight(engine, player, resolved)) return 'Line of sight blocked';
  return resolved;
}
function protecteeTarget(engine: EngineState, player: CombatActor, target: CompanionTarget | undefined): CombatActor | string {
  if (!target) return player;
  if (target.kind !== 'actor') return 'Pick someone to protect';
  const resolved = resolveActor(engine, target.instanceId);
  if (typeof resolved === 'string') return resolved;
  return resolved.id === player.id || resolved.allegiance === 'ally' && resolved.visible && !resolved.downed ? resolved : 'Cannot protect that target';
}
function hasLineOfSight(engine: EngineState, from: CombatActor, to: CombatActor): boolean {
  const radius = 0.12;
  return isAerialCirclePathClear(engine.arena, { x: from.position.x, y: from.position.y + 1.1 - radius, z: from.position.z }, { x: to.position.x, y: to.position.y + 1.1 - radius, z: to.position.z }, radius, radius * 2);
}
/** An instance id, or an archetype id that names exactly one instance; two hunters sharing an archetype are never ambiguous targets by accident. */
function resolveActor(engine: EngineState, id: ActorId): CombatActor | string {
  const exact = engine.actors.find(actor => actor.id === id);
  if (exact) return exact;
  let match: CombatActor | undefined;
  for (const actor of engine.actors) {
    if (actor.archetypeId !== id) continue;
    if (match) return 'Ambiguous target: choose one instance';
    match = actor;
  }
  return match ?? 'Unknown target';
}
function actorById(engine: EngineState, id: ActorId): CombatActor | undefined {
  const resolved = resolveActor(engine, id);
  return typeof resolved === 'string' ? undefined : resolved;
}

/** Read-only: the exact acceptance result of `commandCompanion` without spending anything. */
export function commandAvailability(engine: EngineState, request: CompanionCommandRequest): CommandAvailability {
  const plan = planCommand(engine, request);
  return plan.ok
    ? { available: true, reason: null, readyAtWorldTick: engine.worldTick, tokenCost: plan.cost }
    : { available: false, reason: plan.reason, readyAtWorldTick: plan.readyAt, tokenCost: plan.cost };
}

/** Valid targets of `command` for `companionId`, ordered by distance then id; every entry would be accepted by `commandCompanion`. */
export function commandTargets(engine: EngineState, companionId: CompanionId, command: FieldCommand): CompanionTarget[] {
  const player = playerOf(engine);
  if (!player) return [];
  const candidates: CompanionTarget[] = [];
  if (companionId === 'asha' && command === 'special') {
    for (const hazard of engine.hazards) candidates.push({ kind: 'hazard', hazardId: hazard.id, protecteeId: player.id });
  } else if (command === 'search') {
    for (const interaction of INTERACTIONS) if (interaction.regionId === engine.regionId) candidates.push({ kind: 'interaction', interactionId: interaction.id, targetId: interaction.targetId });
  } else if (command === 'defend') {
    candidates.push({ kind: 'actor', instanceId: player.id });
    for (const actor of engine.actors) if (actor.allegiance === 'ally' && actor.id !== companionId) candidates.push({ kind: 'actor', instanceId: actor.id });
  } else if (command === 'focus' || command === 'distract' || command === 'special') {
    if (companionId === 'koro' && command === 'special') {
      for (const object of engine.movableObjects) candidates.push({ kind: 'interaction', interactionId: object.authored.koroInteractionId, targetId: object.objectId });
    }
    for (const actor of engine.actors) if (actor.allegiance === 'hostile') candidates.push({ kind: 'actor', instanceId: actor.id });
  }
  const accepted = candidates.filter(target => planCommand(engine, { companionId, command, target }).ok);
  return accepted.sort((a, b) => targetDistance(engine, player, a) - targetDistance(engine, player, b) || targetKey(a).localeCompare(targetKey(b)));
}
function targetKey(target: CompanionTarget): string { return target.kind === 'actor' ? target.instanceId : target.kind === 'interaction' ? target.interactionId : target.hazardId; }
function targetDistance(engine: EngineState, player: CombatActor, target: CompanionTarget): number {
  if (target.kind === 'actor') { const actor = actorById(engine, target.instanceId); return actor ? distance2(player.position, actor.position) : Infinity; }
  if (target.kind === 'hazard') { const hazard = engine.hazards.find(candidate => candidate.id === target.hazardId); return hazard ? distance2(player.position, hazard.origin) : Infinity; }
  const object = engine.movableObjects.find(candidate => candidate.objectId === target.targetId);
  const interaction = INTERACTIONS.find(candidate => candidate.id === target.interactionId);
  const point = object?.position ?? (interaction ? interactionPoint(engine, interaction) : undefined);
  return point ? distance2(player.position, point) : Infinity;
}
/** Plain-language name of a command target for the wheel and HUD. */
export function targetLabel(engine: EngineState, target: CompanionTarget): string {
  if (target.kind === 'actor') return target.instanceId.replaceAll('-', ' ');
  if (target.kind === 'hazard') return (engine.hazards.find(candidate => candidate.id === target.hazardId)?.attackId ?? target.hazardId).replace(/^[a-z]+-/, '').replaceAll('-', ' ');
  return INTERACTIONS.find(candidate => candidate.id === target.interactionId)?.promptLabel ?? target.targetId;
}

// ---- commit -----------------------------------------------------------------------------------------------------------

/** Validates and commits one field command; a rejected command spends nothing. Call between fixed steps. */
export function commandCompanion(engine: EngineState, request: CompanionCommandRequest): boolean {
  const plan = planCommand(engine, request);
  if (!plan.ok) return false;
  const { slot, actor, kind } = plan, state = engine.companionState, now = engine.worldTick;
  if (kind === 'follow' || kind === 'recall') {
    endCommand(engine, slot);
    if (kind === 'recall') clearMarksFrom(engine, actor.id);
    slot.mode = 'follow';
    slot.pathFallback = false;
  } else if (kind === 'stay') {
    endCommand(engine, slot);
    slot.mode = 'stay';
    slot.position = { ...actor.position };
  } else {
    endCommand(engine, slot);
    if (plan.cost > 0) {
      state.tokens.available -= plan.cost;
      state.tokens.nextAt = state.tokens.available === state.tokens.maximum ? 0 : now + RESOURCE_TICK;
    }
    slot.token++;
    slot.readyAt = now + cooldownOf(state, request.companionId);
    if (kind === 'support' || kind === 'guard' || kind === 'storm-talon') {
      state.supportReadyAt[request.companionId] = now + COMPANION_SPECIALIZATIONS[request.companionId].cooldownTicks;
    }
    startCommand(engine, plan, request);
  }
  if (kind === 'follow' || kind === 'recall' || kind === 'stay') {
    actor.actionEndsTick = 0;
    actor.normalizedTime = 0;
    actor.phase = 'idle';
  }
  state.reservationsDirty = true;
  const subject = plan.hostile ?? plan.protectee;
  appendCue(engine, { kind: 'command', phase: 'commit', actorId: actor.id, targetId: subject?.id ?? engine.playerId, actionId: request.command as never, position: { ...(subject ?? actor).position }, scopeId: `command:${request.companionId}`, durationTicks: 30, priority: 'story', shape: 'ring' });
  return true;
}

function startCommand(engine: EngineState, plan: Plan, request: CompanionCommandRequest): void {
  const { slot, actor, kind } = plan, now = engine.worldTick, id = request.companionId;
  switch (kind) {
    case 'mark': {
      slot.mode = 'focus';
      slot.targetId = plan.hostile!.id;
      actor.targetId = plan.hostile!.id;
      slot.job = { command: 'focus', phase: 'act', startedAt: now, endsAt: now + 48 };
      beginSkill(engine, actor, slot, companionSkillFor(id, 'focus')!, 'mark');
      return;
    }
    case 'support':
      slot.mode = 'focus';
      slot.targetId = plan.hostile!.id;
      actor.targetId = plan.hostile!.id;
      slot.job = { command: request.command, phase: 'approach', startedAt: now, endsAt: now + SUPPORT_TIMEOUT };
      return;
    case 'defend':
      slot.mode = 'defend';
      slot.targetId = plan.protectee!.id;
      actor.targetId = plan.protectee!.id;
      slot.job = { command: 'defend', phase: 'act', startedAt: now, endsAt: now + DEFEND_TICKS };
      return;
    case 'guard': {
      const hazard = plan.hazard!;
      slot.mode = 'defend';
      slot.targetId = plan.protectee!.id;
      actor.targetId = plan.protectee!.id;
      slot.guard = { protecteeId: plan.protectee!.id, hazardId: hazard.id, state: 'moving', until: hazard.activeUntil + 12 };
      slot.job = { command: 'special', phase: 'act', startedAt: now, endsAt: hazard.activeUntil + 12 };
      appendCue(engine, { kind: 'guard', phase: 'anticipation', actorId: actor.id, targetId: plan.protectee!.id, scopeId: `guard:${hazard.id}`, position: guardPoint(hazard, plan.protectee!), priority: 'essential', shape: 'ring' });
      return;
    }
    case 'search': {
      slot.mode = 'search';
      slot.job = { command: 'search', phase: 'approach', startedAt: now, endsAt: now + SEARCH_TIMEOUT, point: plan.point, interactionId: plan.interaction?.id };
      return;
    }
    case 'distract': {
      const target = plan.hostile!;
      slot.mode = 'distract';
      slot.targetId = target.id;
      actor.targetId = target.id;
      slot.job = { command: 'distract', phase: 'act', startedAt: now, endsAt: now + DISTRACT_TICKS + 66 };
      slot.readyAt = now + DISTRACT_TICKS + DISTRACT_REST;
      const skill = companionSkillFor(id, 'distract') ?? companionSkillFor(id, 'search')!;
      beginSkill(engine, actor, slot, skill, 'distract');
      return;
    }
    case 'object':
      slot.mode = 'special';
      slot.targetId = plan.object!.objectId as ActorId;
      actor.targetId = plan.object!.objectId as ActorId;
      slot.job = { command: 'special', phase: 'approach', startedAt: now, endsAt: now + OBJECT_TIMEOUT, point: plan.point, interactionId: plan.interaction!.id, objectId: plan.object!.objectId };
      return;
    case 'storm-talon': {
      // Vara's Storm Talon: climb from her current position to a perch above and behind the target, then
      // dive along a swept bezier that ends at the target's body mid-height (talons at the body, offset
      // by combined radii so the capsule does not intersect the victim). The climb apex and dive goal
      // both re-aim every tick so a raptor stoop tracks a moving prey.
      const hostile = plan.hostile!;
      // Anchor the perch "behind" the target along the target's facing: a 3.0 m back-offset along -facing
      // lifts the climb apex off the target's vertical axis so the 2D strike check cannot fire at the top of
      // the climb (the xz distance stays > the strike radius throughout the windup).
      const fx = hostile.facing.x, fz = hostile.facing.z;
      const flen = Math.hypot(fx, fz) || 1;
      const backX = fx / flen, backZ = fz / flen;
      const climbPosition: Vec3 = {
        x: hostile.position.x - backX * STORM_TALON_BACK_OFFSET,
        y: hostile.position.y + STORM_TALON_CLIMB_HEIGHT,
        z: hostile.position.z - backZ * STORM_TALON_BACK_OFFSET,
      };
      // The dive starts from Vara's actual current position (her flight altitude, or the ground if she
      // was perched). The climb animates the rise; we never pre-snap her to the climb height.
      const diveFrom: Vec3 = { x: actor.position.x, y: actor.position.y, z: actor.position.z };
      // The strike point sits just outside the target's collision capsule at body mid-height (talons reach
      // but the bodies do not interpenetrate).
      const targetMidY = hostile.position.y + (hostile.collisionHeight ?? 1.6) * 0.5;
      const strikeOffset = hostile.radius + actor.radius + 0.15;
      slot.stormTalon = {
        phase: 'climb',
        startedAt: now,
        phaseEndTick: now + STORM_TALON_RISE_TICKS,
        endsAt: now + STORM_TALON_RISE_TICKS + STORM_TALON_DIVE_TICKS + STORM_TALON_STRIKE_TICKS + STORM_TALON_RECOVER_TICKS,
        targetId: hostile.id,
        climbPosition,
        diveFrom,
        diveTo: { x: hostile.position.x, y: targetMidY, z: hostile.position.z },
        diveStrikeRadius: strikeOffset,
        diveStartedAt: now + STORM_TALON_RISE_TICKS,
        struck: false,
        wasMarked: hostile.markState?.sourceId === actor.id,
        missed: false,
      };
      slot.mode = 'special';
      slot.targetId = hostile.id;
      actor.targetId = hostile.id;
      // Force Vara airborne before the dive starts (so the presenter sees her take off first).
      const player = playerOf(engine);
      slot.flight = { phase: 'flying', phaseStartedAt: now, perch: undefined, playerAnchor: { ...(player?.position ?? actor.position) }, playerIdleSince: now };
      actor.actionId = 'vara:takeoff' as never;
      actor.phase = 'anticipation';
      actor.actionStartedTick = now;
      actor.normalizedTime = 0;
      actor.actionEndsTick = 0;
      appendCue(engine, { kind: 'storm-talon', phase: 'anticipation', actorId: actor.id, targetId: hostile.id, position: { ...actor.position }, to: { ...climbPosition }, scopeId: `storm-talon:${actor.id}:${now}`, durationTicks: STORM_TALON_RISE_TICKS, priority: 'essential', shape: 'ring' });
      return;
    }
    case 'follow': case 'recall': case 'stay': return;
  }
}

/** A finished/cancelled finite gesture must release the native pose, even if its object/attention job continues. */
function releaseSkillPose(actor: CombatActor | undefined, id: CompanionId): void {
  if (!actor || actor.downed || !companionSkillByAction(actor.actionId)) return;
  actor.actionId = `${id}:idle` as ActionId;
  actor.actionEndsTick = 0;
  actor.normalizedTime = 0;
  actor.phase = 'idle';
}

/** Drops whatever finite command the slot was running and releases its reservation. */
function endCommand(engine: EngineState, slot: CompanionSlotState): void {
  const job = slot.job;
  if (slot.skill) appendCue(engine, { kind: 'cancel', phase: 'resolve', scopeId: slot.skill.scopeId, cancellationReason: 'interrupt' });
  if (slot.stormTalon) appendCue(engine, { kind: 'cancel', phase: 'resolve', scopeId: `storm-talon:${companionActor(engine, slot.companionId)?.id ?? slot.companionId}:${slot.stormTalon.startedAt}`, cancellationReason: 'interrupt' });
  releaseSkillPose(companionActor(engine, slot.companionId), slot.companionId);
  slot.skill = undefined;
  slot.stormTalon = undefined;
  if (slot.mode === 'distract' && slot.targetId) {
    const target = engine.actors.find(actor => actor.id === slot.targetId);
    if (target && target.attention?.sourceId === companionActor(engine, slot.companionId)?.id) target.attention = undefined;
  }
  if (slot.guard) appendCue(engine, { kind: 'guard', phase: 'resolve', actorId: companionActor(engine, slot.companionId)?.id ?? slot.companionId, targetId: slot.guard.protecteeId, scopeId: `guard:${slot.guard.hazardId}`, priority: 'essential', shape: 'ring' });
  if (job?.objectId) engine.companionState.objectRequests = engine.companionState.objectRequests.filter(request => request.objectId !== job.objectId);
  slot.job = undefined;
  slot.guard = undefined;
  slot.targetId = undefined;
  slot.reservation = undefined;
  slot.mode = 'follow';
  engine.companionState.reservationsDirty = true;
}

/** An accepted but undeliverable job (the object move was refused) ends cleanly. */
export function failCompanionJob(engine: EngineState, actorId: ActorId): void {
  for (const slot of Object.values(engine.companionState.slots)) {
    const actor = slot && companionActor(engine, slot.companionId);
    if (slot && actor?.id === actorId && slot.job?.objectId) endCommand(engine, slot);
  }
}


/** The ask/signal abilities of later acts: one interaction ability, not a field verb. */
export function companionSignal(engine: EngineState, id: CompanionId, targetId?: ActorId): boolean {
  const state = engine.companionState, slot = state.slots[id], actor = companionActor(engine, id);
  if (!slot || !actor || !actor.visible || actor.downed || isPossessed(engine, slot, actor) || engine.worldTick < slot.readyAt || (slot.suppressedUntil ?? 0) > engine.worldTick) return false;
  if (id === 'solkar' && state.dominionUsed && bondOf(state, id) < 40) return false;
  if (!state.wardenCall && bondOf(state, id) < 10) return false;
  if (!isActive(state, id) || state.tokens.available < ABILITY_COST) return false;
  const request: CompanionCommandRequest = { companionId: id, command: 'focus', ...(targetId ? { target: { kind: 'actor', instanceId: targetId } as const } : {}) };
  const availability = commandAvailability(engine, request);
  if (!availability.available || !commandCompanion(engine, request)) return false;
  if (availability.tokenCost === 0) {
    state.tokens.available -= ABILITY_COST;
    state.tokens.nextAt = engine.worldTick + RESOURCE_TICK;
  }
  return true;
}

// ---- marks ------------------------------------------------------------------------------------------------------------

function markTicksOf(state: CompanionRosterState, id: CompanionId): number {
  return dominionOf(state, id) >= DOMINION_BONUS ? Math.round(MARK_TICKS * 1.5) : MARK_TICKS;
}
function applyMark(engine: EngineState, vara: CombatActor, target: CombatActor): void {
  clearMarksFrom(engine, vara.id, target);
  const fresh = target.markState?.sourceId !== vara.id;
  target.markState = { sourceId: vara.id, untilWorldTick: engine.worldTick + markTicksOf(engine.companionState, vara.archetypeId as CompanionId), extended: false };
  if (fresh) appendCue(engine, { kind: 'mark', phase: 'sustain', actorId: vara.id, targetId: target.id, position: { ...target.position }, to: markLanding(engine, target), scopeId: `mark:${target.id}`, durationTicks: target.markState.untilWorldTick - engine.worldTick, priority: 'essential', shape: 'ring' });
  revealTrapsNear(engine, target.position, TRAP.revealRadius);
  pushEvent(engine, 'companion', 'Mark Weakness', vara.id, target.id);
  const eventId = `${engine.runId}:bird-mark`;
  emitWorldEvent(engine, { type: 'semantic-interaction', eventId, idempotencyKey: eventId, actorId: vara.id, interactionId: 'bird-mark', kind: 'inspect', targetId: 'bird-mark', position: { ...target.position } });
}
/** Where the marked target's committed attack will land, or its own ground when it is not attacking. */
export function markLanding(engine: EngineState, target: CombatActor): Vec3 {
  const hazard = liveAttackOf(engine, target);
  return hazard && engine.worldTick < hazard.activeUntil ? { ...hazard.target } : { ...target.position };
}
function clearMarksFrom(engine: EngineState, sourceId: string, except?: CombatActor): void {
  for (const actor of engine.actors) if (actor.markState?.sourceId === sourceId && actor !== except) removeMark(engine, actor);
}
function removeMark(engine: EngineState, actor: CombatActor): void {
  actor.markState = undefined;
  appendCue(engine, { kind: 'cancel', phase: 'resolve', actorId: actor.id, scopeId: `mark:${actor.id}`, cancellationReason: 'interrupt' });
}
/** Expiry and the bounded counter benefit: an exposure the target already earned lasts longer, once per mark. */
function updateMarks(engine: EngineState): void {
  for (const target of engine.actors) {
    const mark = target.markState;
    if (!mark) continue;
    const source = companionActor(engine, mark.sourceId);
    if (engine.worldTick >= mark.untilWorldTick || target.downed || !target.visible || !source || source.downed || !isActive(engine.companionState, source.archetypeId as CompanionId)) { removeMark(engine, target); continue; }
    if (mark.extended) continue;
    const extension = bondOf(engine.companionState, source.archetypeId as CompanionId) >= BOND_BONUS ? Math.round(MARK_EXTENSION * 1.5) : MARK_EXTENSION;
    const stun = target.reactionState?.kind === 'stun';
    if (stun) { target.reactionState!.durationTicks += extension; target.staggerUntil += extension; target.recoveringUntil += extension; }
    else if (engine.worldTick < target.staggerUntil) target.staggerUntil += extension;
    else if (engine.worldTick < (target.weakPointUntil ?? 0)) target.weakPointUntil = (target.weakPointUntil ?? 0) + extension;
    else continue;
    mark.extended = true;
    pushEvent(engine, 'companion', 'Mark Counter', source.id, target.id);
  }
}

/** Presentation view of a mark for the snapshot. */
export function markSnapshot(engine: EngineState, target: CombatActor): { sourceId: ActorId; remainingTicks: number; landing?: Vec3 } | undefined {
  const mark = target.markState;
  if (!mark) return undefined;
  return { sourceId: mark.sourceId as ActorId, remainingTicks: Math.max(0, Math.ceil(mark.untilWorldTick - engine.worldTick)), landing: markLanding(engine, target) };
}

// ---- guard ------------------------------------------------------------------------------------------------------------

/**
 * A live hazard is about to hit `protectee`: true when a guarding companion intercepts exactly this hazard. Success cancels
 * the hazard for the protectee, hands the attacker a heavy reaction under the normal poise rules and puts the guard into recovery.
 */
export function tryGuardBlock(engine: EngineState, hazard: LiveHazard, protectee: CombatActor): boolean {
  for (const slot of Object.values(engine.companionState.slots)) {
    const guard = slot?.guard;
    if (!slot || !guard || guard.hazardId !== hazard.id || guard.protecteeId !== protectee.id || guard.state === 'recovery') continue;
    const asha = companionActor(engine, slot.companionId);
    if (!asha || asha.downed || asha.possessed) continue;
    const reach = distance2(asha.position, protectee.position);
    if (reach > GUARD_RADIUS || !inCone(protectee.position, asha.position, hazard.origin)) continue;
    hazard.hitIds.push(protectee.id);
    guard.state = 'recovery';
    guard.until = engine.worldTick + GUARD_RECOVERY;
    asha.recoveringUntil = engine.worldTick + GUARD_RECOVERY;
    asha.phase = 'recovery';
    const attacker = engine.actors.find(actor => actor.id === hazard.sourceId);
    if (attacker) {
      const push = facingFrom({ x: attacker.position.x - asha.position.x, y: 0, z: attacker.position.z - asha.position.z });
      reactToCompanionHit(engine, attacker, hit('heavy', 28, 1.6), push.x, push.z);
      const lunge = engine.bossLunges?.find(candidate => candidate.hazardId === hazard.id);
      if (lunge) lunge.landed = true;
    }
    appendCue(engine, { kind: 'guard', phase: 'hit', actorId: asha.id, targetId: protectee.id, scopeId: `guard:${hazard.id}`, position: { x: (asha.position.x + protectee.position.x) / 2, y: asha.position.y + 1, z: (asha.position.z + protectee.position.z) / 2 }, priority: 'essential', shape: 'burst' });
    pushEvent(engine, 'companion', 'Charge Block', asha.id, protectee.id);
    return true;
  }
  return false;
}
/** `candidate` stands within the cone from `protectee` toward `source`. */
function inCone(protectee: Vec3, candidate: Vec3, source: Vec3): boolean {
  const toSource = Math.atan2(source.x - protectee.x, source.z - protectee.z), toCandidate = Math.atan2(candidate.x - protectee.x, candidate.z - protectee.z);
  return Math.abs(wrapAngle(toSource - toCandidate)) <= GUARD_CONE_DEGREES * Math.PI / 180;
}

// ---- reservations -----------------------------------------------------------------------------------------------------

/** Deterministic target reservations: companions pick their first free slot per target in companion-id order. */
export function assignReservations(engine: EngineState): void {
  const state = engine.companionState;
  state.reservationsDirty = false;
  const taken = new Set<string>();
  const ids = (Object.keys(state.slots) as CompanionId[]).sort();
  for (const id of ids) {
    const slot = state.slots[id]!;
    slot.reservation = undefined;
    if (!slot.targetId || slot.mode === 'follow' || slot.mode === 'stay' || slot.mode === 'special') continue;
    const target = engine.actors.find(actor => actor.id === slot.targetId);
    if (!target || target.downed || !target.visible) continue;
    for (const candidate of RESERVATION_PREFERENCE[id]) {
      const key = `${slot.targetId}:${candidate}`;
      if (taken.has(key)) continue;
      taken.add(key);
      slot.reservation = candidate;
      break;
    }
  }
}
function reservationPoint(target: CombatActor, slot: ReservationSlot, aerial: boolean): Vec3 {
  const fx = target.facing.x, fz = target.facing.z;
  const reach = target.radius + 1.7;
  let dx = 0, dz = 0;
  switch (slot) {
    case 'front': dx = fx; dz = fz; break;
    case 'rear': dx = -fx; dz = -fz; break;
    case 'left': dx = -fz; dz = fx; break;
    case 'right': dx = fz; dz = -fx; break;
    case 'far-support': dx = -fx * 2.6; dz = -fz * 2.6; break;
    case 'aerial': break;
  }
  return { x: target.position.x + dx * reach, y: target.position.y + (aerial ? 1.8 : 0), z: target.position.z + dz * reach };
}

// ---- the world step ---------------------------------------------------------------------------------------------------

function beginSkill(engine: EngineState, actor: CombatActor, slot: CompanionSlotState, definition: CompanionSkill, kind: CompanionSkillState['kind']): void {
  const now = engine.worldTick;
  const skill: CompanionSkillState = {
    actionId: definition.actionId, kind, startedAt: now, releaseAt: now + definition.ticks * definition.release,
    contactAt: now + definition.ticks * definition.contact, endsAt: now + definition.ticks,
    released: false, resolved: false, scopeId: `companion:${actor.id}:${slot.token}:${now}`,
  };
  slot.skill = skill;
  if (slot.job) { slot.job.phase = 'act'; slot.job.endsAt = Math.max(slot.job.endsAt, skill.endsAt + 1); }
  slot.readyAt = Math.max(slot.readyAt, skill.endsAt);
  sampleSkill(engine, actor, skill);
  appendSkillCue(engine, actor, slot, 'anticipation');
}

function sampleSkill(engine: EngineState, actor: CombatActor, skill: CompanionSkillState): void {
  actor.actionId = skill.actionId as never;
  actor.actionStartedTick = skill.startedAt;
  actor.actionEndsTick = 0; // The world-clock skill, not updateActors' generic timer, owns this sample.
  actor.normalizedTime = Math.max(0, Math.min(1, (engine.worldTick - skill.startedAt) / (skill.endsAt - skill.startedAt)));
  actor.phase = engine.worldTick < skill.releaseAt ? 'anticipation' : engine.worldTick < skill.contactAt + 5 ? 'active' : 'recovery';
  Object.assign(actor.velocity, { x: 0, y: 0, z: 0 });
}

function appendSkillCue(engine: EngineState, actor: CombatActor, slot: CompanionSlotState, phase: 'anticipation' | 'commit' | 'hit' | 'resolve'): void {
  const skill = slot.skill!;
  const target = slot.targetId ? actorById(engine, slot.targetId) : undefined;
  const object = slot.job?.objectId ? engine.movableObjects.find(candidate => candidate.objectId === slot.job!.objectId) : undefined;
  const at = target?.position ?? object?.position ?? slot.job?.point ?? actor.position;
  appendCue(engine, { kind: 'command', phase, actorId: actor.id, targetId: target?.id, actionId: skill.actionId as never,
    from: { ...actor.position }, to: { ...at }, position: { ...at }, scopeId: skill.scopeId,
    durationTicks: Math.max(1, (phase === 'commit' ? skill.contactAt : skill.endsAt) - engine.worldTick), priority: 'essential', shape: phase === 'hit' ? 'burst' : 'trail' });
}

function advanceSkill(engine: EngineState, actor: CombatActor, slot: CompanionSlotState): void {
  const skill = slot.skill!, now = engine.worldTick;
  const target = slot.targetId ? actorById(engine, slot.targetId) : undefined;
  if (target && skill.kind !== 'object') {
    const dx = target.position.x - actor.position.x, dz = target.position.z - actor.position.z, length = Math.hypot(dx, dz);
    if (length > .01) Object.assign(actor.facing, { x: dx / length, z: dz / length });
  }
  sampleSkill(engine, actor, skill);
  if (!skill.released && now >= skill.releaseAt) { skill.released = true; appendSkillCue(engine, actor, slot, 'commit'); }
  if (!skill.resolved && now >= skill.contactAt) {
    skill.resolved = true;
    let landed = false;
    switch (skill.kind) {
      case 'mark':
        if (target && typeof hostileTarget(engine, playerOf(engine)!, { kind: 'actor', instanceId: target.id }) !== 'string') { applyMark(engine, actor, target); landed = true; }
        break;
      case 'support': {
        const reach = slot.companionId === 'koro' || slot.companionId === 'solkar' ? 8 : (target?.radius ?? 0) + 2.4;
        if (target?.visible && !target.downed && target.allegiance === 'hostile' && distance2(actor.position, target.position) <= reach && hasLineOfSight(engine, actor, target)) landed = applySupport(engine, actor, target);
        break;
      }
      case 'distract':
        if (target?.visible && !target.downed && target.allegiance === 'hostile') {
          target.attention = { sourceId: actor.id, untilWorldTick: now + DISTRACT_TICKS };
          cancelWindup(engine, target);
          if (slot.job) slot.job.endsAt = now + DISTRACT_TICKS;
          landed = true;
        }
        break;
      case 'search': {
        revealTrapsNear(engine, actor.position, TRAP.revealRadius);
        const interaction = slot.job?.interactionId ? INTERACTIONS.find(candidate => candidate.id === slot.job!.interactionId) : undefined;
        if (interaction?.success.type === 'semantic-interaction') {
          const eventId = searchEventId(engine, interaction.id);
          emitWorldEvent(engine, { type: 'semantic-interaction', eventId, idempotencyKey: eventId, actorId: actor.id, interactionId: interaction.id, kind: interaction.success.kind, targetId: interaction.success.targetId, position: { ...actor.position } });
        }
        pushEvent(engine, 'companion', 'Track', actor.id, slot.targetId);
        landed = true;
        break;
      }
      case 'object':
        if (slot.job?.objectId && slot.job.interactionId) {
          engine.companionState.objectRequests.push({ objectId: slot.job.objectId, interactionId: slot.job.interactionId, actorId: actor.id });
          landed = true;
        }
        break;
    }
    if (landed) appendSkillCue(engine, actor, slot, 'hit');
    else { endCommand(engine, slot); return; }
  }
  if (now >= skill.endsAt) {
    appendSkillCue(engine, actor, slot, 'resolve');
    slot.skill = undefined;
    releaseSkillPose(actor, slot.companionId);
    if (skill.kind !== 'object' && skill.kind !== 'distract') endCommand(engine, slot);
  }
}

function sampleGuard(engine: EngineState, actor: CombatActor, slot: CompanionSlotState): void {
  const guard = slot.guard!;
  actor.actionId = 'asha-fang-guard' as never;
  actor.actionEndsTick = 0;
  actor.normalizedTime = guard.state === 'recovery'
    ? .55 + .45 * Math.max(0, Math.min(1, 1 - (guard.until - engine.worldTick) / GUARD_RECOVERY))
    : Math.min(.48, Math.max(0, (engine.worldTick - (slot.job?.startedAt ?? engine.worldTick)) / 60));
  actor.phase = guard.state === 'recovery' ? 'recovery' : 'anticipation';
}

/** Never starts an encounter or solves an interaction. Free marking does not steal the next paid companion's turn. */
function autoSupport(engine: EngineState, player: CombatActor): void {
  const state = engine.companionState, now = engine.worldTick, id = state.companionId;
  if (!id || engine.encounter && engine.rewardEmitted || now < (state.assistReadyAt ?? 0)) return;
  state.assistReadyAt = now + 12;
  const slot = state.slots[id], actor = companionActor(engine, id);
  if (!slot || !actor?.visible || actor.downed || slot.mode !== 'follow' || slot.skill || slot.stormTalon || slot.job || slot.guard || now < slot.readyAt || isPossessed(engine, slot, actor) || (slot.suppressedUntil ?? 0) > now) return;
  let target: CombatActor | undefined, nearest = 12;
  for (const candidate of engine.actors) {
    if (!candidate.visible || candidate.downed || candidate.allegiance !== 'hostile' || (candidate.vitality ?? 1) <= 0) continue;
    const engaged = candidate.motion ? candidate.motion.engaged : candidate.id === engine.encounter?.bossId || candidate.targetId === player.id;
    if (!engaged) continue;
    const distance = distance2(player.position, candidate.position);
    if (distance < nearest && hasLineOfSight(engine, player, candidate)) { target = candidate; nearest = distance; }
  }
  if (!target) return;
  let command: FieldCommand = id === 'asha' ? 'focus' : 'special';
  let aim: CompanionTarget = { kind: 'actor', instanceId: target.id };
  if (id === 'vara' && (!target.markState || target.markState.untilWorldTick <= now)) command = 'focus';
  if (costOf(id, command) > 0 && state.tokens.available <= 1) return;
  if (id === 'koro' && engine.player.vitality >= engine.player.maxVitality * .85) return;
  if (id === 'nyra') {
    let cooling = false;
    for (const key in engine.skillReadyAt) if (engine.skillReadyAt[key as keyof typeof engine.skillReadyAt]! > engine.tick) { cooling = true; break; }
    if (!cooling) return;
  }
  if (id === 'asha') {
    for (const hazard of engine.hazards) {
      const guardAim: CompanionTarget = { kind: 'hazard', hazardId: hazard.id, protecteeId: player.id };
      if (planCommand(engine, { companionId: id, command: 'special', target: guardAim }).ok) { command = 'special'; aim = guardAim; break; }
    }
  }
  commandCompanion(engine, { companionId: id, command, target: aim });
}

export function stepCompanions(engine: EngineState): void {
  const state = engine.companionState;
  const player = playerOf(engine);
  if (!player || player.downed || engine.worldTimeScale <= 0) return;
  if (state.ownerBoon && companionOwnerMultiplier(engine, state.ownerBoon.kind) === 1) state.ownerBoon = undefined;
  for (const actor of engine.actors) if (actor.supportSlow && actor.supportSlow.untilWorldTick <= engine.worldTick) actor.supportSlow = undefined;
  if (state.tokens.available < state.tokens.maximum && engine.worldTick >= state.tokens.nextAt) {
    state.tokens.available++;
    state.tokens.nextAt = state.tokens.available < state.tokens.maximum ? engine.worldTick + RESOURCE_TICK : 0;
  }
  updateMarks(engine);
  updateScoutWarning(engine, player);
  if (state.reservationsDirty) assignReservations(engine);
  const id = state.companionId;
  if (id) {
    const slot = state.slots[id];
    const actor = companionActor(engine, id);
    if (!slot || !actor || !actor.visible || actor.downed || isPossessed(engine, slot, actor)) { if (actor) settleCompanion(engine, actor); if (slot?.job || slot?.guard || slot?.stormTalon || slot?.skill) endCommand(engine, slot); return; }
    // A suppressed companion keeps its place beside the hero but drops whatever command it was carrying out.
    if ((slot.suppressedUntil ?? 0) > engine.worldTick) { if (slot.job || slot.guard || slot.stormTalon || slot.skill) endCommand(engine, slot); }
    else advanceCommand(engine, actor, slot);
    // Finite action ownership wins over locomotion and Vara's flight machine.
    if (slot.stormTalon) return;
    if (slot.skill) { sampleSkill(engine, actor, slot.skill); return; }
    if (id === 'vara') {
      updateFlightState(engine, actor, slot, player);
      actor.actionEndsTick = 0;
      const flight = slot.flight;
      if (actor.actionId === 'vara:takeoff') actor.normalizedTime = flight?.phase === 'takeoff' ? Math.min(1, (engine.worldTick - flight.phaseStartedAt) / 30) : 1;
      else if (actor.actionId === 'vara:land') actor.normalizedTime = flight?.phase === 'landing' ? Math.min(1, (engine.worldTick - flight.phaseStartedAt) / 36) : 1;
      else { actor.phase = 'idle'; actor.normalizedTime = 0; }
    }
    else moveCompanion(engine, actor, slot, player);
    if (slot.guard) sampleGuard(engine, actor, slot);
  }
  autoSupport(engine, player);
}

function warningTargetValid(player: CombatActor, target: CombatActor): boolean {
  return target.visible && !target.downed && (target.vitality === undefined || target.vitality > 0)
    && target.allegiance === 'hostile' && distance2(player.position, target.position) <= 16;
}
function warningFacing(player: CombatActor, target: CombatActor): number {
  const dx = target.position.x - player.position.x, dz = target.position.z - player.position.z;
  const length = Math.hypot(dx, dz);
  return length > 0.001 ? (dx * player.facing.x + dz * player.facing.z) / length : 1;
}
function updateScoutWarning(engine: EngineState, player: CombatActor): void {
  const state = engine.companionState, slot = state.slots.vara;
  if (!slot) return;
  const vara = companionActor(engine, 'vara');
  if (state.companionId !== 'vara' || !vara?.visible || vara.downed || isPossessed(engine, slot, vara) || player.downed) {
    slot.warning = undefined;
    return;
  }
  if (slot.warning) {
    const target = actorById(engine, slot.warning.targetId);
    if (!target || !warningTargetValid(player, target) || engine.worldTick >= slot.warning.endsAt) { slot.warning = undefined; return; }
    if (warningFacing(player, target) < 0.7) return;
    const eventId = `${engine.runId}:warning-response`;
    emitWorldEvent(engine, { type: 'semantic-interaction', eventId, idempotencyKey: eventId, actorId: vara.id,
      interactionId: 'warning-response', kind: 'signal', targetId: 'warning-response', position: { ...target.position } });
    slot.warning = undefined;
    return;
  }
  if (engine.worldTick < (slot.warningReadyAt ?? 0)) return;
  let threat: CombatActor | undefined, nearest = Infinity;
  for (const target of engine.actors) {
    if (!warningTargetValid(player, target) || warningFacing(player, target) >= -0.25) continue;
    const distance = distance2(player.position, target.position);
    if (distance < nearest) { threat = target; nearest = distance; }
  }
  if (!threat) return;
  slot.warning = { targetId: threat.id, endsAt: engine.worldTick + 300 };
  slot.warningReadyAt = engine.worldTick + 600;
  pushEvent(engine, 'companion', 'Vara: danger behind you. Turn toward the threat.', vara.id, threat.id, 'vara-warning');
}

function isActive(state: CompanionRosterState, id: CompanionId): boolean { return state.companionId === id; }

/** Per-tick command state: target validity, timeouts, the search dwell, the object hand-off, the support action and the guard stance. */
function advanceCommand(engine: EngineState, actor: CombatActor, slot: CompanionSlotState): void {
  const now = engine.worldTick, job = slot.job;
  if (slot.targetId && slot.mode !== 'special' && slot.mode !== 'follow' && slot.mode !== 'stay') {
    const target = actorById(engine, slot.targetId);
    if (!target || target.downed || !target.visible || (slot.mode !== 'defend' && target.allegiance !== 'hostile')) { endCommand(engine, slot); return; }
    // A mark has no job: the scout keeps its station until the mark ends.
    if (!job && !slot.guard && slot.mode === 'focus' && target.markState?.sourceId !== actor.id) { endCommand(engine, slot); return; }
  }
  if (slot.stormTalon) { advanceStormTalon(engine, actor, slot); return; }
  if (slot.skill) { advanceSkill(engine, actor, slot); return; }
  if (slot.guard) { advanceGuard(engine, slot); return; }
  if (!job) return;
  if (now >= job.endsAt) { endCommand(engine, slot); return; }
  switch (job.command) {
    case 'search': advanceSearch(engine, actor, slot, job); return;
    // A Special aimed at an object is Koro's object move; a Special aimed at a hostile is the companion's support action.
    case 'special': if (job.objectId) advanceObject(engine, actor, slot, job); else advanceSupport(engine, actor, slot); return;
    case 'focus': advanceSupport(engine, actor, slot); return;
  }
}

function advanceGuard(engine: EngineState, slot: CompanionSlotState): void {
  const guard = slot.guard!, hazard = engine.hazards.find(candidate => candidate.id === guard.hazardId);
  if (guard.state === 'recovery') {
    if (engine.worldTick >= guard.until) endCommand(engine, slot);
    return;
  }
  if (!hazard || engine.worldTick >= guard.until || engine.worldTick >= hazard.activeUntil) { endCommand(engine, slot); return; }
  guard.state = engine.worldTick >= hazard.activeFrom ? 'blocking' : 'moving';
}

function advanceSearch(engine: EngineState, actor: CombatActor, slot: CompanionSlotState, job: CompanionJob): void {
  if (job.point && distance2(actor.position, job.point) > 1.4) return;
  job.phase = 'act';
  beginSkill(engine, actor, slot, companionSkillFor(slot.companionId, 'search')!, 'search');
}

function advanceObject(engine: EngineState, actor: CombatActor, slot: CompanionSlotState, job: CompanionJob): void {
  const object = engine.movableObjects.find(candidate => candidate.objectId === job.objectId);
  if (!object) { endCommand(engine, slot); return; }
  if (object.phase === 'settled') { endCommand(engine, slot); return; }
  if (object.phase === 'in-flight') return;
  if (job.phase === 'approach') {
    const interaction = INTERACTIONS.find(candidate => candidate.id === job.interactionId);
    const radius = Math.max(0.5, (interaction?.radiusMeters ?? 1.5) - 0.3);
    if (distance2(actor.position, object.position) > radius) return;
    beginSkill(engine, actor, slot, companionSkillFor(slot.companionId, 'special', true)!, 'object');
    return;
  }
  if (!slot.skill && object.phase === 'resting' && !engine.companionState.objectRequests.some(request => request.objectId === object.objectId)) endCommand(engine, slot);
}

/** Approach first; the actual effect and hit cue occur once at the native gesture's contact frame. */
function advanceSupport(engine: EngineState, actor: CombatActor, slot: CompanionSlotState): void {
  const target = slot.targetId ? actorById(engine, slot.targetId) : undefined;
  const reach = slot.companionId === 'koro' || slot.companionId === 'solkar' ? 8 : (target?.radius ?? 0) + 2.4;
  if (!target || actor.recoveringUntil > engine.worldTick || distance2(actor.position, target.position) > reach) return;
  slot.job!.phase = 'act';
  const skill = companionSkillFor(slot.companionId, slot.companionId === 'asha' ? 'focus' : 'special')!;
  beginSkill(engine, actor, slot, skill, 'support');
}

function applySupport(engine: EngineState, actor: CombatActor, target: CombatActor): boolean {
  // Aspect answers remain authored boss mechanics, independent of the companion's bounded owner benefit.
  const aspect = orunAspectSupport(engine, actor, target);
  const owner = ownerInRange(engine, actor);
  let message: string;
  switch (actor.archetypeId) {
    case 'koro':
      if (owner) {
        engine.player.vitality = Math.min(engine.player.maxVitality, engine.player.vitality + engine.player.maxVitality * BALANCE.healFraction);
        owner.vitality = engine.player.vitality;
      }
      message = 'Mending Seed';
      break;
    case 'asha': {
      const boss = isBossActor(engine, target);
      if (!target.anchored && !target.downed && !target.reactionState && engine.worldTick >= target.staggerUntil && engine.worldTick >= (target.companionControlReadyAt ?? 0) && !isArmoured(engine, target)) {
        const away = facingFrom({ x: target.position.x - actor.position.x, y: 0, z: target.position.z - actor.position.z });
        const plan = stunPlan(.35, boss ? BALANCE.bossStunTicks : BALANCE.stunTicks);
        beginReaction(target, boss ? { ...plan, cancelsAttack: false } : plan, away.x, away.z, engine.worldTick, false);
        target.companionControlReadyAt = engine.worldTick + BALANCE.controlImmunityTicks;
      }
      message = 'Searing Pin';
      break;
    }
    case 'sable': {
      const boss = isBossActor(engine, target);
      target.supportSlow = { factor: boss ? BALANCE.bossSlowFactor : BALANCE.slowFactor, untilWorldTick: engine.worldTick + (boss ? BALANCE.bossSlowTicks : BALANCE.slowTicks), sourceId: actor.id };
      message = 'Undertow Flank';
      break;
    }
    case 'nyra':
      if (owner) for (const key in engine.skillReadyAt) {
        const id = key as keyof typeof engine.skillReadyAt, deadline = engine.skillReadyAt[id]!;
        if (deadline > engine.tick) engine.skillReadyAt[id] = deadline - Math.min((deadline - engine.tick) * BALANCE.cooldownReduction, BALANCE.cooldownReductionCap);
      }
      message = 'Static Ambush';
      break;
    case 'solkar':
      if (owner) engine.companionState.ownerBoon = { kind: 'power', sourceId: 'solkar', untilWorldTick: engine.worldTick + BALANCE.powerTicks };
      message = 'Ember Rally';
      break;
    default: return false;
  }
  pushEvent(engine, 'companion', aspect ?? message, actor.id, target.id);
  return true;
}

/** Cancels a hostile's attack that is still in its windup (a distraction re-aims it); later phases are committed. */
function cancelWindup(engine: EngineState, target: CombatActor): void {
  const hazard = liveAttackOf(engine, target);
  if (!hazard || engine.worldTick >= (hazard.windupUntil ?? hazard.activeFrom)) return;
  hazard.activeUntil = hazard.castUntil = hazard.recoveryUntil = engine.worldTick;
  engine.telegraphs = engine.telegraphs.filter(telegraph => telegraph.id !== hazard.id);
  appendCue(engine, { kind: 'cancel', phase: 'resolve', scopeId: hazard.id, cancellationReason: 'interrupt' });
  pushEvent(engine, 'attack-interrupted', `${hazard.attackId} is drawn away.`, engine.playerId, target.id, 'distract', hazard.attackId);
  target.recoveringUntil = engine.worldTick;
  target.phase = 'idle';
}

// ---- Storm Talon (Vara's harpy-eagle dive) ---------------------------------------------------------------------------

/** Damage the target takes from a confirmed Storm Talon strike; marked targets take a multiplier and the mark is consumed. */
function applyStormTalonStrike(engine: EngineState, vara: CombatActor, target: CombatActor, stormTalon: StormTalonState): boolean {
  const marked = stormTalon.wasMarked;
  const damage = marked ? Math.round(STORM_TALON_DAMAGE * STORM_TALON_MARK_MULTIPLIER) : STORM_TALON_DAMAGE;
  const poise = marked ? Math.round(STORM_TALON_POISE * STORM_TALON_MARK_MULTIPLIER) : STORM_TALON_POISE;
  const away = facingFrom({ x: target.position.x - vara.position.x, y: 0, z: target.position.z - vara.position.z });
  // Queue the strike for the engine to apply this tick (the player-strike damage pipeline runs the gates, ferocity,
  // downed, encounter resolution and the 'damage' event; the reaction is applied in the same drain pass).
  if (!engine.pendingCompanionStrikes) engine.pendingCompanionStrikes = [];
  engine.pendingCompanionStrikes.push({
    sourceId: vara.id, targetId: target.id, damage, poise, knockback: STORM_TALON_KNOCKBACK, dirX: away.x, dirZ: away.z, attackId: 'vara-storm-talon',
  });
  // Mark bonus is single-use: clear the mark so the same dive cannot double-dip on a re-aimed target.
  if (marked) {
    clearMarksFrom(engine, vara.id, target);
    removeMark(engine, target);
  }
  stormTalon.struck = true;
  if (ownerInRange(engine, vara)) engine.companionState.ownerBoon = { kind: 'haste', sourceId: 'vara', untilWorldTick: engine.worldTick + BALANCE.hasteTicks };
  appendCue(engine, { kind: 'storm-talon', phase: 'hit', actorId: vara.id, targetId: target.id, scopeId: `storm-talon:${vara.id}:${stormTalon.startedAt}`, position: { ...target.position }, intensity: damage, priority: 'essential', shape: 'burst' });
  pushEvent(engine, 'companion', 'Storm Talon', vara.id, target.id);
  return true;
}

/** Drives Vara's Storm Talon through its windup, dive, strike and recovery on the world clock. */
function advanceStormTalon(engine: EngineState, actor: CombatActor, slot: CompanionSlotState): void {
  const storm = slot.stormTalon!, now = engine.worldTick;
  const target = actorById(engine, storm.targetId);
  if (storm.phase !== 'recover' && (!target?.visible || target.downed || target.allegiance !== 'hostile' || distance2(actor.position, target.position) > STORM_TALON_DISENGAGE_RANGE)) {
    beginStormRecovery(engine, actor, slot, !storm.struck);
  }
  const oldX = actor.position.x, oldY = actor.position.y, oldZ = actor.position.z;
  actor.actionEndsTick = 0;
  if (target) {
    const dx = target.position.x - oldX, dz = target.position.z - oldZ, length = Math.hypot(dx, dz);
    if (length > .01) Object.assign(actor.facing, { x: dx / length, z: dz / length });
  }
  switch (storm.phase) {
    case 'climb': {
      const victim = target!, length = Math.hypot(victim.facing.x, victim.facing.z) || 1;
      Object.assign(storm.climbPosition, {
        x: victim.position.x - victim.facing.x / length * STORM_TALON_BACK_OFFSET,
        y: victim.position.y + STORM_TALON_CLIMB_HEIGHT,
        z: victim.position.z - victim.facing.z / length * STORM_TALON_BACK_OFFSET,
      });
      const elapsed = now - storm.startedAt, progress = Math.min(1, elapsed / STORM_TALON_RISE_TICKS);
      Object.assign(actor.position, {
        x: storm.diveFrom.x + (storm.climbPosition.x - storm.diveFrom.x) * progress,
        y: storm.diveFrom.y + (storm.climbPosition.y - storm.diveFrom.y) * progress,
        z: storm.diveFrom.z + (storm.climbPosition.z - storm.diveFrom.z) * progress,
      });
      actor.actionId = (elapsed < 18 ? 'vara:takeoff' : 'vara:hover') as never;
      actor.normalizedTime = Math.min(1, elapsed / 18);
      actor.phase = elapsed < 18 ? 'anticipation' : 'idle';
      if (now >= storm.phaseEndTick) {
        storm.phase = 'dive';
        storm.phaseEndTick = now + STORM_TALON_DIVE_TICKS;
        storm.diveStartedAt = now;
        Object.assign(storm.diveFrom, actor.position);
        appendCue(engine, { kind: 'storm-talon', phase: 'active', actorId: actor.id, targetId: victim.id, scopeId: `storm-talon:${actor.id}:${storm.startedAt}`, from: { ...actor.position }, to: { x: victim.position.x, y: victim.position.y + victim.collisionHeight * .5, z: victim.position.z }, position: { ...actor.position }, durationTicks: STORM_TALON_DIVE_TICKS, priority: 'essential', shape: 'trail' });
      }
      break;
    }
    case 'dive': {
      const victim = target!, elapsed = now - storm.diveStartedAt;
      Object.assign(storm.diveTo, { x: victim.position.x, y: victim.position.y + victim.collisionHeight * .5, z: victim.position.z });
      const progress = Math.min(1, Math.max(0, elapsed) / STORM_TALON_DIVE_TICKS);
      const next = elapsed <= STORM_TALON_DIVE_TICKS
        ? bezierArc(storm.diveFrom, storm.climbPosition, storm.diveTo, progress)
        : chasePursuit(storm.diveFrom, storm.diveTo, elapsed);
      Object.assign(actor.position, next);
      actor.actionId = 'vara:dive' as never;
      actor.phase = 'active';
      actor.normalizedTime = progress;
      const yInBand = Math.abs(next.y - storm.diveTo.y) <= Math.max(.4, victim.collisionHeight * .5);
      const contact = Math.hypot(next.x - victim.position.x, next.y - victim.position.y, next.z - victim.position.z);
      if (!storm.struck && yInBand && contact <= storm.diveStrikeRadius + STORM_TALON_STRIKE_REACH) {
        storm.phase = 'strike';
        storm.phaseEndTick = now + STORM_TALON_STRIKE_TICKS;
        actor.actionId = 'vara:strike' as never;
        actor.normalizedTime = .44;
        applyStormTalonStrike(engine, actor, victim, storm);
      } else if (now >= storm.phaseEndTick + STORM_TALON_DIVE_PURSUIT_TICKS) beginStormRecovery(engine, actor, slot, true);
      break;
    }
    case 'strike':
      actor.actionId = 'vara:strike' as never;
      actor.phase = 'active';
      actor.normalizedTime = .44 + .5 * Math.min(1, 1 - (storm.phaseEndTick - now) / STORM_TALON_STRIKE_TICKS);
      if (now >= storm.phaseEndTick) beginStormRecovery(engine, actor, slot, false);
      break;
    case 'recover': {
      const player = playerOf(engine);
      const progress = Math.max(0, Math.min(1, (now - storm.phaseEndTick) / Math.max(1, storm.endsAt - storm.phaseEndTick)));
      const x = player ? player.position.x - 1.3 : storm.diveFrom.x;
      const y = player ? player.position.y + VARA_FLY_ALTITUDE : storm.diveFrom.y;
      const z = player ? player.position.z + 1.2 : storm.diveFrom.z;
      Object.assign(actor.position, {
        x: storm.diveFrom.x + (x - storm.diveFrom.x) * progress,
        y: storm.diveFrom.y + (y - storm.diveFrom.y) * progress,
        z: storm.diveFrom.z + (z - storm.diveFrom.z) * progress,
      });
      actor.actionId = 'vara:fly' as never;
      actor.phase = 'idle';
      actor.normalizedTime = progress;
      if (now >= storm.endsAt) {
        appendCue(engine, { kind: 'storm-talon', phase: 'landing', actorId: actor.id, position: { ...actor.position }, scopeId: `storm-talon:${actor.id}:${storm.startedAt}`, priority: 'cosmetic' });
        slot.stormTalon = undefined;
        endCommand(engine, slot);
      }
      break;
    }
  }
  const dt = Math.max(WORLD_STEP_SECONDS, engine.worldTimeScale * WORLD_STEP_SECONDS);
  Object.assign(actor.velocity, { x: (actor.position.x - oldX) / dt, y: (actor.position.y - oldY) / dt, z: (actor.position.z - oldZ) / dt });
}

/** Refund a genuinely missed dive exactly once. A target defeated by a successful strike is not a miss. */
function endStormTalonAsMissed(engine: EngineState, slot: CompanionSlotState, actor: CombatActor): void {
  const state = engine.companionState;
  if (state.tokens.available < state.tokens.maximum) {
    state.tokens.available++;
    state.tokens.nextAt = state.tokens.available < state.tokens.maximum ? engine.worldTick + RESOURCE_TICK : 0;
  }
  appendCue(engine, { kind: 'cancel', phase: 'resolve', actorId: actor.id, scopeId: `storm-talon:${actor.id}:${slot.stormTalon!.startedAt}`, cancellationReason: 'interrupt' });
  pushEvent(engine, 'companion', 'Storm Talon missed', actor.id, slot.stormTalon!.targetId);
}

function beginStormRecovery(engine: EngineState, actor: CombatActor, slot: CompanionSlotState, missed: boolean): void {
  const storm = slot.stormTalon!;
  if (storm.phase === 'recover') return;
  storm.phase = 'recover';
  storm.missed = missed;
  storm.phaseEndTick = engine.worldTick;
  storm.endsAt = engine.worldTick + (missed ? STORM_TALON_MISS_RECOVER_TICKS : STORM_TALON_RECOVER_TICKS);
  Object.assign(storm.diveFrom, actor.position);
  slot.readyAt = Math.max(slot.readyAt, storm.endsAt);
  if (missed) endStormTalonAsMissed(engine, slot, actor);
}


/** When the bezier has finished its 21-tick nominal arc, the raptor keeps tracking the live target for
 *  up to STORM_TALON_DIVE_PURSUIT_TICKS extra ticks at the same speed (a straight-line chase that
 *  preserves the dive's terminal velocity). The line is drawn from the dive's start point to the
 *  target's current mid-height point so the raptor actually reaches the prey. */
function chasePursuit(diveFrom: Vec3, diveTo: Vec3, elapsed: number): Vec3 {
  // Pick the live endpoint (the raptor is chasing the current target, not a frozen snapshot).
  const start = diveFrom;
  const end = diveTo;
  const dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z;
  const distance = Math.hypot(dx, dy, dz) || 1;
  // Cover the dive path in STORM_TALON_DIVE_TICKS, then keep going at the same speed.
  const diveSpeed = distance / STORM_TALON_DIVE_TICKS;
  const t = (elapsed - STORM_TALON_DIVE_TICKS) * diveSpeed;
  const overshoot = Math.max(0, t); // positive when the raptor has reached (or passed) the live target
  if (overshoot === 0) {
    // The chase is still inside the nominal window; defer to the bezier.
    return diveTo;
  }
  const cap = Math.min(distance, overshoot);
  return { x: start.x + dx / distance * cap, y: start.y + dy / distance * cap, z: start.z + dz / distance * cap };
}

/** A quadratic bezier with apex at `apex`, t∈[0,1]; used to bend the Storm Talon dive so the line of sight is preserved without making it look straight. */
function bezierArc(from: Vec3, apex: Vec3, to: Vec3, t: number): Vec3 {
  const u = 1 - t;
  return {
    x: u * u * from.x + 2 * u * t * apex.x + t * t * to.x,
    y: u * u * from.y + 2 * u * t * apex.y + t * t * to.y,
    z: u * u * from.z + 2 * u * t * apex.z + t * t * to.z,
  };
}

// ---- Flight state (Vara, the harpy eagle) ----------------------------------------------------------------------------

/** A live hostile inside this radius forces Vara into takeoff regardless of perch/idle state. */
function varaHostileNearby(engine: EngineState, vara: CombatActor): boolean {
  for (const actor of engine.actors) {
    if (actor.allegiance !== 'hostile' || actor.downed || !actor.visible) continue;
    if (distance2(vara.position, actor.position) <= VARA_THREAT_RADIUS) return true;
  }
  return false;
}

/** True when the hero has wandered further than VARA_TAKEOFF_TRAVEL since the last anchored tick. */
function varaPlayerTravelled(anchor: Vec3, player: CombatActor): boolean {
  return distance2(anchor, player.position) >= VARA_TAKEOFF_TRAVEL;
}

/** Tick-by-tick flight state machine for Vara. Updates slot.flight, sets actor.actionId, and never touches ground-occupied cells. */
function updateFlightState(engine: EngineState, actor: CombatActor, slot: CompanionSlotState, player: CombatActor): void {
  const now = engine.worldTick;
  let flight = slot.flight;
  if (!flight) {
    // The slot is fresh. Default to 'flying' (the historical behaviour that lets Vara start by banking
    // toward the hero) but only when she already sits at flight altitude and away from the hero. A
    // slot that spawns on top of Aren is snapped onto a perch with clearance from the hero's capsule
    // and starts 'grounded', so the first travel tick triggers a real takeoff animation rather than
    // crowding the hero and stalling the y-curve at the perch's ground height.
    const heroClearance = Math.hypot(actor.position.x - player.position.x, actor.position.z - player.position.z);
    const overlap = heroClearance < (actor.radius + player.radius + 0.25);
    if (overlap) {
      const perch = perchNearPlayer(engine, player, actor) ?? { x: player.position.x - 1.3, y: player.position.y, z: player.position.z + 1.2 };
      actor.position = { ...perch };
      flight = { phase: 'grounded', phaseStartedAt: now, perch, playerAnchor: { ...player.position }, playerIdleSince: now };
    } else {
      flight = { phase: 'flying', phaseStartedAt: now, perch: undefined, playerAnchor: { ...player.position }, playerIdleSince: now };
    }
    slot.flight = flight;
  }
  // The dive poses are owned by the Storm Talon advance; keep the flight machine dormant during the four dive phases.
  if (slot.stormTalon) return;
  // Edge-detect travel: we only refresh playerAnchor when the player transitions from idle to moving, so
  // a slow walk (each tick the player moves 0.05 m, well under VARA_TAKEOFF_TRAVEL) still trips the gate
  // exactly once per travel stretch and the takeoff animation is not interrupted by the anchor reset.
  const wasIdle = !varaPlayerTravelled(flight.playerAnchor, player);
  const travel = !wasIdle;
  if (wasIdle && travel) {
    flight.playerAnchor = { ...player.position };
    flight.playerIdleSince = now;
  }
  const hostileNear = varaHostileNearby(engine, actor);
  const moving = travel || hostileNear;
  switch (flight.phase) {
    case 'grounded': {
      actor.actionId = 'vara:idle' as never;
      actor.phase = 'idle';
      if (moving) {
        // Lock the perch on the first tick of takeoff so the animation has a fixed origin even as the
        // player keeps walking: without this the per-tick perch re-resolution follows the hero and the
        // y-curve never reaches VARA_FLY_ALTITUDE. The takeoff tick runs immediately afterwards so the
        // very first step after a slot init still raises the actor above the perch (rather than
        // leaving it pinned to the ground for one whole tick).
        const perch = flight.perch ?? perchNearPlayer(engine, player, actor) ?? actor.position;
        flight.phase = 'takeoff';
        flight.phaseStartedAt = now;
        flight.perch = perch;
        actor.position = { ...perch };
        appendCue(engine, { kind: 'command', phase: 'anticipation', actorId: actor.id, targetId: player.id, actionId: 'takeoff' as never, position: { ...perch }, scopeId: `vara-takeoff:${now}`, durationTicks: 30, priority: 'cosmetic', shape: 'ring' });
        // Inline the first tick of the takeoff: a 1/30 lift off the perch so y rises the same step the
        // phase is committed (the next step will continue the curve).
        actor.position = {
          x: perch.x + (player.position.x - 1.3 - perch.x) / 30,
          y: perch.y + (player.position.y + VARA_FLY_ALTITUDE - perch.y) / 30,
          z: perch.z + (player.position.z + 1.2 - perch.z) / 30,
        };
        actor.actionId = 'vara:takeoff' as never;
        actor.phase = 'anticipation';
        return;
      }
      // Slow hop walk: Vara stays grounded and re-positions around Aren on a slow cadence.
      const distanceFromAnchor = distance2(player.position, actor.position);
      if (distanceFromAnchor > VARA_PERCH_REACH) {
        const perch = perchNearPlayer(engine, player, actor);
        if (perch) {
          flight.perch = perch;
          // Walk toward the perch (a short grounded hop).
          actor.actionId = 'vara:walk' as never;
          actor.phase = 'active';
          const stride = COMPANION_STRIDE * engine.worldTimeScale;
          const dx = perch.x - actor.position.x, dz = perch.z - actor.position.z;
          const len = Math.hypot(dx, dz) || 1;
          const step = Math.min(stride, Math.hypot(dx, dz));
          const from = actor.position;
          actor.position = { x: actor.position.x + dx / len * step, y: perch.y, z: actor.position.z + dz / len * step };
          actor.velocity = { x: dx / len * 3.3, y: 0, z: dz / len * 3.3 };
          recordCompanionMotion(engine, actor, from, actor.position);
        }
      }
      return;
    }
    case 'takeoff': {
      actor.actionId = 'vara:takeoff' as never;
      actor.phase = 'anticipation';
      const elapsed = now - flight.phaseStartedAt;
      const progress = Math.min(1, elapsed / 30);
      // Take-off is a 0.5 s rise from the locked perch to the flight head (VARA_FLY_ALTITUDE above the
      // hero). The perch is fixed for the whole 30 ticks (set when entering the phase), so the curve
      // climbs monotonically even while the hero keeps moving.
      const perch = flight.perch ?? actor.position;
      const head = { x: player.position.x - 1.3, y: player.position.y + VARA_FLY_ALTITUDE, z: player.position.z + 1.2 };
      actor.position = {
        x: perch.x + (head.x - perch.x) * progress,
        y: perch.y + (head.y - perch.y) * progress,
        z: perch.z + (head.z - perch.z) * progress,
      };
      if (elapsed >= 30) {
        // Stay in 'flying' whenever the hero is still moving (so the aerial follow keeps working); only
        // switch to 'hovering' when the hero has come to a complete rest at the end of the takeoff.
        flight.phase = moving ? 'flying' : 'hovering';
        flight.phaseStartedAt = now;
        flight.perch = undefined;
      }
      return;
    }
    case 'flying': {
      actor.actionId = 'vara:fly' as never;
      actor.phase = 'active';
      // The wider banking orbit above Aren keeps Vara in clear sky at VARA_FLY_ALTITUDE.
      moveVaraAerial(engine, actor, { x: player.position.x - 1.3, y: player.position.y + VARA_FLY_ALTITUDE, z: player.position.z + 1.2 }, FOLLOW_DISTANCE + 0.35);
      if (!moving && now - flight.playerIdleSince >= VARA_PERCH_IDLE_TICKS) {
        const perch = perchNearPlayer(engine, player, actor);
        if (perch) {
          flight.phase = 'landing';
          flight.phaseStartedAt = now;
          flight.perch = perch;
          return;
        }
      }
      return;
    }
    case 'hovering': {
      actor.actionId = 'vara:hover' as never;
      actor.phase = 'idle';
      if (moving) {
        // Hero started moving again: a clean takeoff from the hover point so the perch lock captures the
        // current ground node, not whatever stale ground was sitting under the actor when she last landed.
        const perch = flight.perch ?? perchNearPlayer(engine, player, actor) ?? actor.position;
        flight.phase = 'takeoff';
        flight.phaseStartedAt = now;
        flight.perch = perch;
        actor.position = { ...perch };
        return;
      }
      // Hold position above the flight head (no travel, so no movement).
      moveVaraAerial(engine, actor, { x: player.position.x - 1.3, y: player.position.y + VARA_FLY_ALTITUDE, z: player.position.z + 1.2 }, ARRIVE_DISTANCE);
      return;
    }
    case 'landing': {
      actor.actionId = 'vara:land' as never;
      actor.phase = 'recovery';
      const elapsed = now - flight.phaseStartedAt;
      const progress = Math.min(1, elapsed / 36);
      const perch = flight.perch ?? perchNearPlayer(engine, player, actor) ?? { x: actor.position.x, y: actor.position.y - VARA_FLY_ALTITUDE, z: actor.position.z };
      actor.position = {
        x: actor.position.x + (perch.x - actor.position.x) * progress,
        y: actor.position.y + (perch.y - actor.position.y) * progress,
        z: actor.position.z + (perch.z - actor.position.z) * progress,
      };
      if (elapsed >= 36) {
        flight.phase = 'grounded';
        flight.phaseStartedAt = now;
        flight.perch = perch;
      }
      return;
    }
  }
}

/** A supported capsule point beside the player for Vara to perch on; null when no walkable point is reachable.
 *  The perch must keep clearance from the hero (combined radii + a 0.25 m margin) and from the actor's own
 *  current footprint so a fresh slot that starts overlapping the player snaps to a usable stance instead
 *  of returning the hero's own position. */
function perchNearPlayer(engine: EngineState, player: CombatActor, actor?: CombatActor): Vec3 | null {
  const arena = engine.arena;
  const candidates: Vec3[] = [];
  const heroRadius = player.radius;
  const actorRadius = actor?.radius ?? COMPANION_RADIUS;
  // Search on a 5x5 grid so a slot that starts exactly on the hero can still find a clearance point
  // somewhere within reach.
  for (const dx of [-1.6, -1.3, 1.3, 1.6, 0]) {
    for (const dz of [-1.5, -1.2, 1.2, 1.5, 0]) {
      const x = player.position.x + dx, z = player.position.z + dz;
      const y = groundHeightAt(arena, x, z, player.position.y);
      if (y === null || Math.abs(y - player.position.y) > 1.4) continue;
      // Clearance: the perch must sit outside the hero's body by the combined radii plus a margin.
      if (Math.hypot(x - player.position.x, z - player.position.z) < heroRadius + actorRadius + 0.25) continue;
      if (actor && Math.hypot(x - actor.position.x, z - actor.position.z) < actorRadius * 2 + 0.1) continue;
      if (!isSupportedCapsulePose(arena, { x, y, z: z }, COMPANION_RADIUS, .8)) continue;
      candidates.push({ x, y, z });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => distance2(player.position, a) - distance2(player.position, b));
  return candidates[0]!;
}

// ---- movement ---------------------------------------------------------------------------------------------------------

/** Re-bases every companion deadline after a checkpoint reset shifted the world clock by `offset`. */
export function shiftCompanionClocks(state: CompanionRosterState, offset: number): void {
  if (state.tokens.nextAt > 0) state.tokens.nextAt += offset;
  if (state.assistReadyAt) state.assistReadyAt += offset;
  for (const key in state.supportReadyAt) {
    const id = key as CompanionId;
    if (state.supportReadyAt[id]) state.supportReadyAt[id]! += offset;
  }
  if (state.ownerBoon) state.ownerBoon.untilWorldTick += offset;
  for (const slot of Object.values(state.slots)) {
    if (!slot) continue;
    slot.readyAt = slot.readyAt === 0 ? 0 : slot.readyAt + offset;
    if (slot.job) { slot.job.startedAt += offset; slot.job.endsAt += offset; if (slot.job.actAt !== undefined) slot.job.actAt += offset; }
    if (slot.skill) { slot.skill.startedAt += offset; slot.skill.releaseAt += offset; slot.skill.contactAt += offset; slot.skill.endsAt += offset; }
    if (slot.stormTalon) { slot.stormTalon.startedAt += offset; slot.stormTalon.phaseEndTick += offset; slot.stormTalon.endsAt += offset; slot.stormTalon.diveStartedAt += offset; }
    if (slot.flight) { slot.flight.phaseStartedAt += offset; slot.flight.playerIdleSince += offset; }
    if (slot.guard) slot.guard.until += offset;
    if (slot.suppressedUntil) slot.suppressedUntil += offset;
  }
}

function moveCompanion(engine: EngineState, actor: CombatActor, slot: CompanionSlotState, player: CombatActor): void {
  const escape = hazardEscape(engine, actor, slot.guard && slot.guard.state !== 'recovery' ? slot.guard.hazardId : undefined);
  if (escape) { moveToward(engine, actor, slot, escape, ARRIVE_DISTANCE); if (slot.mode === 'stay') slot.position = { ...actor.position }; return; }
  if (slot.mode === 'stay') { settleCompanion(engine, actor); return; }
  const job = slot.job;
  if (slot.mode === 'special' && job?.phase === 'act') { settleCompanion(engine, actor); return; }
  if (slot.guard) {
    const hazard = engine.hazards.find(candidate => candidate.id === slot.guard!.hazardId), protectee = actorById(engine, slot.guard.protecteeId);
    if (!hazard || !protectee || slot.guard.state === 'recovery') { settleCompanion(engine, actor); return; }
    moveToward(engine, actor, slot, guardPoint(hazard, protectee), 0.25);
    return;
  }
  if (job?.point && job.phase === 'approach') { moveToward(engine, actor, slot, job.point, job.command === 'special' ? 0.9 : 1.2); return; }
  const target = slot.targetId ? actorById(engine, slot.targetId) : undefined;
  if (target && (slot.mode === 'focus' || slot.mode === 'distract')) {
    moveToward(engine, actor, slot, reservationPoint(target, slot.reservation ?? 'rear', actor.aerial), ARRIVE_DISTANCE);
    return;
  }
  if (target && slot.mode === 'defend') { moveToward(engine, actor, slot, defendPoint(engine, target), ARRIVE_DISTANCE); return; }
  const arrive = slot.mode === 'follow' ? FOLLOW_DISTANCE : ARRIVE_DISTANCE;
  moveToward(engine, actor, slot, { x: player.position.x + (slot.mode === 'follow' ? -1.3 : 0), y: player.position.y + (actor.aerial ? 1.8 : 0), z: player.position.z + (slot.mode === 'follow' ? 1.2 : 0) }, arrive);
}

/** Interpose: stand between the protected one and the nearest live threat, otherwise beside them. */
function defendPoint(engine: EngineState, protectee: CombatActor): Vec3 {
  let best: CombatActor | undefined, distance = Infinity;
  for (const actor of engine.actors) {
    if (actor.allegiance !== 'hostile' || actor.downed || !actor.visible) continue;
    const separation = distance2(actor.position, protectee.position);
    if (separation < distance) { best = actor; distance = separation; }
  }
  if (!best || distance > 12) return { x: protectee.position.x - 1.3, y: protectee.position.y, z: protectee.position.z + 1.2 };
  const toward = facingFrom({ x: best.position.x - protectee.position.x, y: 0, z: best.position.z - protectee.position.z });
  return { x: protectee.position.x + toward.x * 1.4, y: protectee.position.y, z: protectee.position.z + toward.z * 1.4 };
}

/** A point just outside a hostile hazard footprint the companion stands in (or is about to be inside); undefined when clear. */
function hazardEscape(engine: EngineState, actor: CombatActor, guarded?: string): Vec3 | undefined {
  const x = actor.position.x, z = actor.position.z;
  for (const hazard of engine.hazards) {
    // A guard never flees the one committed charge it is stepping in to intercept; every other hazard is still avoided.
    if (hazard.id === guarded || hazard.sourceId === engine.playerId || engine.worldTick >= hazard.activeUntil || hazard.activeFrom - engine.worldTick > HAZARD_LOOKAHEAD) continue;
    const bounds = hazard.bounds, margin = actor.radius + 0.4;
    if (x < bounds.min.x - 0.2 || x > bounds.max.x + 0.2 || z < bounds.min.z - 0.2 || z > bounds.max.z + 0.2) continue;
    const west = x - bounds.min.x, east = bounds.max.x - x, north = z - bounds.min.z, south = bounds.max.z - z;
    const nearest = Math.min(west, east, north, south);
    const y = actor.position.y;
    if (nearest === west) return { x: bounds.min.x - margin, y, z };
    if (nearest === east) return { x: bounds.max.x + margin, y, z };
    if (nearest === north) return { x, y, z: bounds.min.z - margin };
    return { x, y, z: bounds.max.z + margin };
  }
  return undefined;
}

/** The ground step this tick may take: the last measured stride plus one ramp increment, capped at the cruise stride and by the distance left. */
function nextStride(actor: CombatActor, remaining: number): number {
  const last = (actor.aerial ? Math.hypot(actor.velocity.x, actor.velocity.y, actor.velocity.z) : Math.hypot(actor.velocity.x, actor.velocity.z)) * WORLD_STEP_SECONDS;
  return Math.min(COMPANION_STRIDE, last + COMPANION_STRIDE_RAMP, remaining);
}

/** Reports the displacement of one world tick as a world-time velocity and turns the heading toward the travel direction at a bounded rate. */
function recordCompanionMotion(engine: EngineState, actor: CombatActor, from: Vec3, to: Vec3): void {
  const worldStep = WORLD_STEP_SECONDS * engine.worldTimeScale;
  if (worldStep <= 0) return;
  const dx = to.x - from.x, dz = to.z - from.z;
  actor.velocity = { x: dx / worldStep, y: (to.y - from.y) / worldStep, z: dz / worldStep };
  if (dx * dx + dz * dz < 1e-10) return;
  const current = Math.atan2(actor.facing.x, actor.facing.z);
  const error = wrapAngle(Math.atan2(dx, dz) - current);
  const angle = current + Math.max(-COMPANION_TURN_STEP, Math.min(COMPANION_TURN_STEP, error));
  actor.facing = { x: Math.sin(angle), y: 0, z: Math.cos(angle) };
}

/** A companion that did not move this tick: its reported velocity decays instead of snapping to zero so the gait eases out. */
function settleCompanion(engine: EngineState, actor: CombatActor): void {
  if (engine.worldTimeScale <= 0) return;
  const speed = Math.hypot(actor.velocity.x, actor.velocity.y, actor.velocity.z);
  actor.velocity = speed < COMPANION_STOP_SPEED ? { x: 0, y: 0, z: 0 } : { x: actor.velocity.x * COMPANION_COAST, y: actor.velocity.y * COMPANION_COAST, z: actor.velocity.z * COMPANION_COAST };
}

/** Aerial locomotion through the shared arena path-clearance check; reports 3D world-time velocity and never writes lateral. */
function moveVaraAerial(engine: EngineState, actor: CombatActor, target: Vec3, arrive: number): void {
  const arena = engine.arena;
  const goal = {
    x: Math.max(arena.bounds.min.x + COMPANION_RADIUS, Math.min(arena.bounds.max.x - COMPANION_RADIUS, target.x)),
    y: target.y,
    z: Math.max(arena.bounds.min.z + COMPANION_RADIUS, Math.min(arena.bounds.max.z - COMPANION_RADIUS, target.z)),
  };
  const dx = goal.x - actor.position.x, dy = goal.y - actor.position.y, dz = goal.z - actor.position.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance < Math.max(arrive, FOLLOW_DISTANCE)) { settleCompanion(engine, actor); return; }
  const stride = Math.min(COMPANION_STRIDE, COMPANION_STRIDE_RAMP * 12 + COMPANION_STRIDE_RAMP, distance) * engine.worldTimeScale;
  const from = actor.position;
  const next = moveAerialCircle(arena, from, { x: dx / distance * stride, y: dy / distance * stride, z: dz / distance * stride }, COMPANION_RADIUS, actor.collisionHeight);
  if (distance2(from, next) < 1e-6 && Math.abs(from.y - next.y) < 1e-6) { settleCompanion(engine, actor); return; }
  actor.position = next;
  recordCompanionMotion(engine, actor, from, next);
}

function moveToward(engine: EngineState, actor: CombatActor, slot: CompanionSlotState, target: Vec3, arrive: number): void {
  const goal = {
    x: Math.max(engine.arena.bounds.min.x + COMPANION_RADIUS, Math.min(engine.arena.bounds.max.x - COMPANION_RADIUS, target.x)),
    y: target.y,
    z: Math.max(engine.arena.bounds.min.z + COMPANION_RADIUS, Math.min(engine.arena.bounds.max.z - COMPANION_RADIUS, target.z)),
  };
  if (actor.aerial) {
    const dx = goal.x - actor.position.x, dy = goal.y - actor.position.y, dz = goal.z - actor.position.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance < Math.max(arrive, FOLLOW_DISTANCE)) { slot.pathFallback = false; settleCompanion(engine, actor); return; }
    const stride = nextStride(actor, distance) * engine.worldTimeScale;
    const from = actor.position;
    const next = moveAerialCircle(engine.arena, from, { x: dx / distance * stride, y: dy / distance * stride, z: dz / distance * stride }, COMPANION_RADIUS, actor.collisionHeight);
    slot.pathFallback = distance2(from, next) < 1e-6 && Math.abs(from.y - next.y) < 1e-6;
    if (slot.pathFallback) { settleCompanion(engine, actor); return; }
    actor.position = next;
    recordCompanionMotion(engine, actor, from, next);
    return;
  }
  if (distance2(actor.position, goal) < arrive) { slot.pathFallback = false; settleCompanion(engine, actor); return; }
  const route = navWaypoint(engine, actor.position, goal, actor.collisionHeight);
  slot.pathFallback = route === null;
  if (!route) { settleCompanion(engine, actor); return; }
  const dx = route.x - actor.position.x, dz = route.z - actor.position.z, distance = Math.hypot(dx, dz);
  if (distance < 0.08) { settleCompanion(engine, actor); return; }
  const stride = nextStride(actor, distance) * engine.worldTimeScale;
  const from = actor.position;
  const next = moveCircle(engine.arena, from, { x: dx / distance * stride, y: 0, z: dz / distance * stride }, COMPANION_RADIUS, actor.collisionHeight);
  if (distance2(from, next) > 1e-6) { actor.position = next; recordCompanionMotion(engine, actor, from, next); }
  else { slot.pathFallback = true; settleCompanion(engine, actor); }
}

function navWaypoint(engine: EngineState, from: Vec3, to: Vec3, height: number): Vec3 | null {
  const arena = engine.arena;
  const destinationGround = groundHeightAt(arena, to.x, to.z, to.y);
  if (destinationGround === null) return null;
  const destination = { x: to.x, y: destinationGround, z: to.z };
  if (lineWalkable(engine, from, destination, height)) return destination;
  const nodes = engine.companionState.navNodes.filter(node => isNodeAvailable(engine, node));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const open = new Set(nodes.map(node => node.id));
  const costs = new Map<string, number>(), previous = new Map<string, string>();
  for (const node of nodes) {
    const point = groundNode(arena, node.position);
    if (point && lineWalkable(engine, from, point, height)) costs.set(node.id, distance2(from, point));
  }
  while (open.size) {
    let currentId: string | undefined, currentCost = Infinity;
    for (const id of open) { const cost = costs.get(id) ?? Infinity; if (cost < currentCost) { currentId = id; currentCost = cost; } }
    if (currentId === undefined || currentCost === Infinity) break;
    open.delete(currentId);
    const current = byId.get(currentId)!;
    const currentPosition = groundNode(arena, current.position);
    if (!currentPosition) continue;
    if (lineWalkable(engine, currentPosition, destination, height)) {
      const path = [currentId];
      while (previous.has(path[0]!)) path.unshift(previous.get(path[0]!)!);
      const firstPosition = groundNode(arena, byId.get(path[0]!)!.position);
      const firstStep = firstPosition && distance2(from, firstPosition) < 0.2 ? path[1] : path[0];
      return firstStep ? groundNode(arena, byId.get(firstStep)!.position) : destination;
    }
    for (const neighborId of current.links) {
      if (!open.has(neighborId)) continue;
      const neighbor = byId.get(neighborId), neighborPosition = neighbor && groundNode(arena, neighbor.position);
      if (!neighbor || !neighborPosition || !lineWalkable(engine, currentPosition, neighborPosition, height)) continue;
      const candidateCost = currentCost + distance2(currentPosition, neighborPosition);
      if (candidateCost < (costs.get(neighborId) ?? Infinity)) { costs.set(neighborId, candidateCost); previous.set(neighborId, currentId); }
    }
  }
  return null;
}

function lineWalkable(engine: EngineState, from: Vec3, to: Vec3, height: number): boolean {
  return isCirclePathClear(engine.arena, from, to, COMPANION_RADIUS, height);
}
function groundNode(arena: EngineState['arena'], point: Vec3): Vec3 | null {
  const y = groundHeightAt(arena, point.x, point.z, point.y);
  return y === null ? null : { x: point.x, y, z: point.z };
}
function isNodeAvailable(engine: EngineState, node: NavNode): boolean {
  if (!node.requirement) return true;
  if (engine.worldFacts[node.requirement] === true) return true;
  return engine.traversalGates.some(gate => (gate.id === node.requirement || gate.unlockFact === node.requirement) && gate.unlocked);
}
function isPossessed(engine: EngineState, slot: CompanionSlotState, actor: CombatActor): boolean {
  return slot.possessed || actor.possessed || actor.possessedUntil > engine.worldTick;
}
export function companionActor<T extends { readonly id: ActorId; readonly archetypeId?: ActorId }>(engine: { readonly actors: readonly T[] }, id: ActorId): T | undefined {
  // A traveling ally is a different instance from a story boss with the same archetype.
  for (const actor of engine.actors) if (actor.archetypeId === id && actor.id.includes('__party_')) return actor;
  const exact = engine.actors.find(actor => actor.id === id);
  if (exact) return exact;
  let match: T | undefined;
  for (const actor of engine.actors) {
    if (actor.archetypeId !== id) continue;
    if (match) return undefined;
    match = actor;
  }
  return match;
}

export function configureCompanion(engine: EngineState, companionId?: CompanionId): boolean {
  if (companionId !== undefined && !isCompanionId(companionId)) return false;
  const actor = companionId ? companionActor(engine, companionId) : undefined;
  if (companionId && (!actor || !actor.visible || actor.downed || actor.possessed || actor.possessedUntil > engine.worldTick || engine.companionState.slots[companionId]?.possessed)) return false;
  const state = engine.companionState;
  if (state.companionId === companionId) return true;
  state.ownerBoon = undefined;
  for (const target of engine.actors) if (target.supportSlow) target.supportSlow = undefined;
  for (const previous of Object.values(state.slots)) if (previous) {
    endCommand(engine, previous);
    clearMarksFrom(engine, companionActor(engine, previous.companionId)?.id ?? previous.companionId);
  }
  state.companionId = companionId;
  state.slots = companionId ? { [companionId]: newSlot(companionId, actor!.position) } : {};
  state.reservationsDirty = true;
  return true;
}
