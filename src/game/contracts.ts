import type {
  CampaignCompanionId,
  CampaignState,
  CheckpointSnapshot,
  CompanionProgress,
  EndingEvaluation,
  FragmentId,
  RegionId as CanonRegionId,
  RestorationState,
} from "../../packages/campaign/src/index.js";
import type { HeroId } from "./heroes.js";
import { DEFAULT_HERO_COMPANIONS } from "./companions/CompanionLoadout.js";
export type { FragmentId, CompanionProgress };

export type RegionId =
  | "greenwake"
  | "the-grove"
  | CanonRegionId
  | "refuge"
  | "heartroot-hollow";
export type ActorId = string & {};
/** One companion identity union, owned by the campaign package. */
export type CompanionId = CampaignCompanionId;
export type CompanionElement = "fire" | "water" | "ice" | "lightning" | "wood" | "wind" | "earth" | "shadow" | "light";
export type QuestId = string & { readonly __questId?: unique symbol };
export type ObjectiveId = string & { readonly __objectiveId?: unique symbol };
export type AttackId = string & { readonly __attackId?: unique symbol };
export type ActionId = string & { readonly __actionId?: unique symbol };
export type InteractionInputHint = "interact" | "heavy" | "ability";
export type InteractionActivation = "press" | "press-release";

/** Read-only presentation at an authored objective or an earned chapter exit; never grants progress. */
export interface WorldObjectiveCue {
  readonly id: string;
  readonly position: Readonly<Vec3>;
  readonly kind: "objective" | "exit";
  readonly status: "approach" | "ready" | "blocked";
}
export interface InputBindingMaps {
  keyboard: Readonly<Record<string, string>>;
  gamepad: Readonly<Record<string, string>>;
}

/** Keyboard keys reserved for Jump and the default Dive shortcut. */
export const RESERVED_KEYBOARD_BINDINGS = Object.freeze({
  jump: "space",
  dodge: "f",
} as const);

/**
 * Normalize stored keyboard bindings without discarding non-conflicting custom remaps.
 * Space always belongs to Jump; the historical Dodge-on-Space binding migrates to F.
 */
export function normalizeInputBindings(
  bindings: InputBindingMaps,
  defaults: InputBindingMaps = DEFAULT_INPUT_BINDINGS,
): InputBindingMaps {
  const keyboard = { ...defaults.keyboard, ...bindings.keyboard };
  const reserved = RESERVED_KEYBOARD_BINDINGS;
  for (const [actionId, value] of Object.entries(keyboard)) {
    if (typeof value !== "string") continue;
    const normalized = value.toLowerCase();
    if (
      (normalized === reserved.jump && actionId !== "jump")
      || (normalized === reserved.dodge && actionId !== "dodge")
    ) {
      const fallback = defaults.keyboard[actionId];
      if (
        typeof fallback === "string"
        && fallback.toLowerCase() !== reserved.jump
        && (actionId === "dodge" || fallback.toLowerCase() !== reserved.dodge)
      ) {
        keyboard[actionId] = fallback;
      } else {
        delete keyboard[actionId];
      }
    }
  }
  keyboard.jump = reserved.jump;
  if (typeof keyboard.dodge !== "string" || keyboard.dodge.toLowerCase() === reserved.jump) {
    const defaultDodge = defaults.keyboard.dodge;
    keyboard.dodge = typeof defaultDodge === "string" && defaultDodge.toLowerCase() !== reserved.jump
      ? defaultDodge
      : reserved.dodge;
  }
  return { keyboard, gamepad: { ...bindings.gamepad } };
}

/** Keep Space exclusive to Jump and F exclusive to the default Dive binding. */
export function isCanonicalKeyboardRemap(
  actionId: string,
  binding: string,
): boolean {
  const normalized = typeof binding === "string" ? binding.toLowerCase() : "";
  if (actionId === "jump") return normalized === RESERVED_KEYBOARD_BINDINGS.jump;
  if (normalized === RESERVED_KEYBOARD_BINDINGS.jump) return false;
  if (actionId !== "dodge" && normalized === RESERVED_KEYBOARD_BINDINGS.dodge) return false;
  return true;
}

export const DEFAULT_KEYBOARD_BINDINGS: Readonly<Record<string, string>> =
  Object.freeze({
    moveForward: "w",
    moveBack: "s",
    moveLeft: "a",
    moveRight: "d",
    dodge: RESERVED_KEYBOARD_BINDINGS.dodge,
    jump: RESERVED_KEYBOARD_BINDINGS.jump,
    sprint: "shift",
    light: "j",
    heavy: "k",
    ranged: "l",
    ultimate: "u",
    interact: "e",
    ability: "q",
    map: "m",
    journal: "tab",
    companions: "c",
    pause: "escape",
    commandWheel: "r",
    lockOn: "t",
  });

export const DEFAULT_GAMEPAD_BINDINGS: Readonly<Record<string, string>> =
  Object.freeze({
    dodge: "Gamepad Button 1",
    ability: "Gamepad Button 2",
    light: "Gamepad Button 3",
    interact: "Gamepad Button 4",
    map: "Gamepad Button 5",
    heavy: "Gamepad Button 6",
    ranged: "Gamepad Button 12",
    ultimate: "Gamepad Button 11",
    commandWheel: "Gamepad Button 7",
    journal: "Gamepad Button 8",
    companions: "Gamepad Button 9",
    pause: "Gamepad Button 10",
    jump: "Gamepad Button 13",
    sprint: "Gamepad Button 14",
    lockOn: "Gamepad Button 16",
  });

export const DEFAULT_INPUT_BINDINGS: InputBindingMaps = Object.freeze({
  keyboard: DEFAULT_KEYBOARD_BINDINGS,
  gamepad: DEFAULT_GAMEPAD_BINDINGS,
});
export type Vec3 = Readonly<{ x: number; y: number; z: number }>;
export interface Bounds3 {
  min: Vec3;
  max: Vec3;
}
export type WorldPosition = Vec3;
export type Allegiance = "player" | "ally" | "neutral" | "hostile" | "wild";
export type SemanticInteractionKind =
  | "inspect"
  | "tend"
  | "rescue"
  | "cleanse"
  | "repair"
  | "restore"
  | "signal"
  | "ask"
  | "break"
  | "move-object"
  | "collect"
  | "track"
  | "traverse"
  | "shelter"
  | "coordinate"
  | "choose";

export interface InteractionRequirement {
  kind: SemanticInteractionKind;
  targetId: string;
  requiredActionId?: ActionId;
  minimumParty?: CompanionId[];
  conditionFact?: string;
}

export type CombatReactionKind = 'flinch' | 'stagger' | 'knockback' | 'knockdown' | 'launch' | 'stun' | 'getup';
export interface CombatReactionSnapshot {
  readonly kind: CombatReactionKind;
  /** Unit planar direction the hit pushed the actor (world XZ, y = 0), i.e. from attacker toward victim. */
  readonly direction: Vec3;
  /** Hit side relative to the victim's facing when the reaction started. */
  readonly side: 'front' | 'back' | 'left' | 'right';
  /** 0..1 strength (attack weight / poise damage), drives presentation amplitude. */
  readonly strength: number;
  /** Progress 0..1 through this reaction; ticks are world-clock ticks. */
  readonly progress: number;
  readonly durationTicks: number;
  /** Stable id increasing per new reaction on this actor (lets presentation restart cleanly on re-hit). */
  readonly serial: number;
  /** Metres the body is lifted above the ground by a launch arc (0 for every other kind). */
  readonly lift?: number;
}
export interface ActorSnapshot {
  /** Unique runtime instance ID; equal to the placed RegionEntityDefinition.id. */
  id: ActorId;
  /** Canonical ACTORS/asset archetype; repeated instances share this identity. */
  archetypeId: ActorId;
  species: string;
  allegiance: Allegiance;
  position: Vec3;
  velocity: Vec3;
  facing: Vec3;
  actionId: ActionId;
  phase: "start" | "anticipation" | "active" | "recovery" | "idle";
  normalizedTime: number;
  vitality?: number;
  maxVitality?: number;
  ferocity?: number;
  corruption?: number;
  targetId?: ActorId;
  renderVariantId?: string;
  sockets: Readonly<Record<string, Vec3>>;
  interactionRequirements: readonly InteractionRequirement[];
  visible: boolean;
  downed: boolean;
  possessed: boolean;
  /** True while the authoritative world-clock stagger or Perfect Dodge weakpoint window is open. */
  weakPointExposed?: boolean;
  /** Monster attack phase driven by the live hazard timeline; absent outside an attack. */
  attackPhase?: "windup" | "commit" | "active" | "recovery";
  /** Progress 0..1 through `attackPhase`. */
  attackPhaseProgress?: number;
  /** Signed yaw rate in rad/s while a monster rotates (positive = increasing atan2(facing.x, facing.z)). */
  yawRate?: number;
  /** Progress 0..1 through a roar pause; absent otherwise. */
  roarProgress?: number;
  /** Authoritative physical reaction in progress (flinch, stagger, knockback, knockdown, launch, stun, getup); absent otherwise. */
  reaction?: CombatReactionSnapshot;
  /** 0..1 stun/poise build-up for hostiles (UI shows it under the health bar); absent for actors without poise. */
  poise?: number;
  /** Authoritative airborne phase, used to time native jump poses without moving the capsule. */
  jumpPhase?: "takeoff" | "rising" | "falling" | "landing";
  jumpPhaseProgress?: number;
  jumpBoosted?: boolean;
  /** Hero-kit statuses on a hostile (Vesper Death Mark stacks, Sakda Echo mark, cripple...); absent when none. */
  heroMarks?: readonly HeroMarkSnapshot[];
  /** Vara mark on a hostile (timed on the world clock); absent when unmarked. */
  mark?: { readonly sourceId: ActorId; readonly remainingTicks: number; readonly landing?: Vec3 };
  /** Active finite companion job (search/distract/special...); absent when idle. */
  job?: { readonly command: FieldCommand; readonly targetId?: string; readonly remainingTicks: number };
  /** Asha intercept state for a protectee/hazard; absent when not guarding. */
  guard?: { readonly protecteeId: ActorId; readonly hazardId?: string; readonly state: "moving" | "blocking" | "recovery"; readonly remainingTicks: number };
  /** Typed chapter presentation status (cleanse/reunion/dialogue action); the renderer never infers it from quest strings. */
  chapterStatus?: ChapterPresentationStatus;
}
export type ChapterPresentationStatus =
  | "sealed" | "thorn-exposed" | "tethered" | "cleansed" | "reunion"
  | "subdued" | "kneeling" | "in-danger" | "sheltered";
/** A status a hero kit has put on a hostile; `remainingTicks` counts down on the world clock. */
export interface HeroMarkSnapshot {
  readonly kind: 'death-stack' | 'death-mark' | 'echo-mark' | 'requiem-mark' | 'cripple';
  readonly stacks?: number;
  readonly remainingTicks: number;
}


export interface MovableObjectSnapshot {
  objectId: string;
  position: Vec3;
  phase: "resting" | "in-flight" | "settled";
  rotationY?: number;
}

export interface WorldClockSnapshot {
  /** Fixed simulation-step count; new engines start at zero and snapshot restore preserves it. */
  readonly simulationTick: number;
  /** Fractional 60Hz ticks; monotonic across region loads/checkpoint resets and preserved by snapshot restore. */
  readonly worldTick: number;
  /** `worldTick / 60`; do not derive this from render delta. */
  readonly worldTimeSeconds: number;
  /** World ticks advanced per simulation tick: 1 normal, 0.25 slow, 0 paused. */
  readonly timeScale: number;
  /** Perfect-dodge slow motion is engine-controlled, not accepted by `setTimePolicy`. */
  readonly policy: "normal" | "perfect-dodge-slow" | "paused";
}

/** Engine-owned temporary solid created by a committed attack. */
export interface CombatObstacleSnapshot {
  readonly id: string;
  readonly sourceId: ActorId;
  readonly attackId: AttackId;
  readonly kind: "ice" | "roots";
  readonly collider: RegionColliderDefinition;
  readonly spawnedAtWorldTick: number;
  readonly expiresAtWorldTick: number;
}

/** A player-owned flying effect (Sigil Bolt or Crescent Wave); positions advance on the world clock. */
export interface PlayerProjectileSnapshot {
  readonly id: string;
  /** Aren: `sigil-bolt`, `crescent-wave`. Yara: `thorn-bolt` (Thornshot), `bloom-seed` (lobbed Bloom Burst seed), `storm-seed` (Seed Storm). Vesper: `kunai`, `shade-clone`. Sakda: `echo-wave`. */
  readonly kind: 'sigil-bolt' | 'crescent-wave' | 'thorn-bolt' | 'bloom-seed' | 'storm-seed' | 'kunai' | 'echo-wave' | 'shade-clone';
  readonly ownerId: ActorId;
  readonly position: Vec3;
  readonly direction: Vec3;
  readonly speed: number;
  readonly radius: number;
  readonly ageTicks: number;
  readonly lifeTicks: number;
  readonly targetId?: ActorId;
}
/** A Warden's Judgement mark waiting to detonate on the simulation clock. */
export interface JudgementMarkSnapshot {
  readonly id: string;
  readonly position: Vec3;
  readonly angleRadians: number;
  readonly createdAtTick: number;
  readonly detonateAtTick: number;
}

export interface PlayerSkillSnapshot {
  readonly id: string;
  readonly label: string;
  readonly binding: string;
  readonly manaCost: number;
  readonly available: boolean;
  readonly reason: string;
}
export interface EncounterStatusSnapshot {
  readonly title: string;
  /**
   * What the current boss phase asks of the player (story encounters only; absent for Trials): `wear-down` lowers Ferocity
   * to the next phase threshold; `tether`/`counter`/`cleanse` is the phase's required action, `done` once it has landed.
   */
  readonly step?: { readonly action: 'wear-down' | 'tether' | 'counter' | 'cleanse'; readonly done: boolean };
  /** True when this story encounter is resolved by cleansing its boss rather than by defeating or subduing it. */
  readonly endsWithCleanse?: boolean;
  readonly monsters: readonly { id: ActorId; name: string; skills: readonly string[]; active: boolean; cleared: boolean; vitality?: number; maxVitality?: number; boss?: boolean }[];
  readonly trial?: {
    readonly stage: number;
    readonly totalStages: number;
    readonly status: 'approach' | 'fighting' | 'open' | 'complete';
    readonly complete: boolean;
    /** Final stage of a map's trial run (the Grove has none). Filled by the trial difficulty ramp. */
    readonly boss?: boolean;
    /** Difficulty level 0..11 of the stage. Filled by the trial difficulty ramp. */
    readonly level?: number;
  };
}
export interface TrialGateSnapshot {
  readonly id: string;
  readonly collider: RegionColliderDefinition;
  readonly open: boolean;
}
export interface TrapSnapshot {
  readonly id: string;
  readonly position: Vec3;
  readonly radius: number;
  readonly armed: boolean;
  readonly sprung: boolean;
  readonly revealed: boolean;
}
/**
 * Authoritative presentation of the Heartroot Hollow duel (engine-owned; the renderer draws, never infers). `fog` is true only
 * while the Shadow aspect actually obscures the arena; `coreExposed` while a real core window is open (Shadow pulse, beast core,
 * recruit moment opening, final Crown core); `safeGap` only while the Pack rows are live and Sable has revealed their one safe band.
 */
export interface OrunPresentationSnapshot {
  readonly phase: 'last-warden' | 'crowned-beast' | 'crown-choice-possession';
  readonly aspect?: 'sky' | 'canopy' | 'fang' | 'pack' | 'shadow' | 'crown';
  readonly fog: boolean;
  readonly coreExposed: boolean;
  readonly safeGap?: Vec3;
  readonly suppressedCompanionIds: readonly CompanionId[];
}
export interface DodgePracticeSnapshot {
  readonly active: boolean;
  readonly attempts: number;
  readonly dodged: number;
  readonly phase: "idle" | "warning" | "strike" | "recovery";
}

/** Simulation-owned response of one native prop. Local damage is not a quest/world fact. */
export interface EnvironmentPropSnapshot {
  readonly id: string;
  readonly material: 'wood' | 'structure' | 'foliage' | 'stone' | 'loose-stone' | 'loose-wood';
  readonly position: Vec3;
  readonly offset: Vec3;
  readonly tiltX: number;
  readonly tiltZ: number;
  readonly damage: number;
  readonly broken: boolean;
  readonly impactSerial: number;
  readonly impactWorldTick: number;
}

export interface CombatSnapshot {
  actors: readonly ActorSnapshot[];
  movableObjects: readonly MovableObjectSnapshot[];
  /** Visible armed/sprung/revealed state of authored traps (engine-owned latch; armed derives from world facts). */
  readonly traps?: readonly TrapSnapshot[];
  readonly dodgePractice?: DodgePracticeSnapshot;
  readonly nurseryEscortActive?: boolean;
  readonly worldClock: WorldClockSnapshot;
  readonly combatObstacles?: readonly CombatObstacleSnapshot[];
  readonly environmentProps?: readonly EnvironmentPropSnapshot[];
  readonly skills: readonly PlayerSkillSnapshot[];
  readonly encounterStatus?: EncounterStatusSnapshot;
  readonly trialGates?: readonly TrialGateSnapshot[];
  readonly playerProjectiles?: readonly PlayerProjectileSnapshot[];
  readonly judgementMarks?: readonly JudgementMarkSnapshot[];
  /** Present while a confirmed player hit freezes the world clock; `strength` is 0..1 (7 ticks = 1). */
  readonly hitStop?: { readonly remainingTicks: number; readonly strength: number };
  /** The live Orun duel in Heartroot Hollow; absent in every other encounter. */
  readonly orun?: OrunPresentationSnapshot;
  player: {
    /** Playable hero occupying the player slot (actor instance `aren`); fixed for the run. */
    heroId: HeroId;
    vitality: number;
    maxVitality: number;
    instinct: number;
    mana: number;
    maxMana: number;
    /** Sakda Guard Dash: remaining absorb points; absent when no shield is up. */
    shield?: number;
    /** Sakda Flurry: J hits left that play faster and restore mana. */
    flurryCharges?: number;
    /** True while a hero skill makes the player untargetable (Thousand Cuts, Requiem, Tiger's Wrath). */
    untargetable?: boolean;
  };
  encounterId?: string;
  boss?: {
    actorId: ActorId;
    phaseId: string;
    phaseIndex: number;
    ferocity: number;
    maxFerocity: number;
    corruption: number;
    exposed: boolean;
    corruptionCores?: readonly { id: string; cleansed: boolean }[];
  };
  telegraphs: readonly {
    id: string;
    attackId: AttackId;
    sourceId: ActorId;
    targetPosition: Vec3;
    phase: string;
    remainingTicks: number;
    /**
     * The hostile or companion this telegraph's authored hazard is locked onto (matches the corresponding
     * LiveHazard.targetActorId when one exists). Absent for non-hazard or player-object telegraphs. The
     * presentation layer uses this to render warning UI without inferring a distracted-companion target from
     * `targetPosition`.
     */
    targetActorId?: ActorId;
  }[];
  hazards: readonly {
    id: string;
    kind: "strike" | "sweep" | "wave" | "area" | "projectile";
    bounds: Bounds3;
    active: boolean;
  }[];
  targetId?: ActorId;
  /**
   * `explicit` only when the player locked the target via the Lock-On action (toggle/hold) and it is still in
   * range/visible/standing; `implicit` when the target came from a kit helper, target cycling, or an engine
   * assignment (loadRegion, startEncounter, trial fighting). Absent when there is no current target. Lets the
   * HUD distinguish a manual lock from an auto-pick while preserving the single `targetId` authority.
   */
  lockStatus?: "explicit" | "implicit";
  events: readonly WorldEvent[];
}

export interface WorldAssetPlacement {
  id: string;
  assetId: string;
  position: Vec3;
  rotationY: number;
  scale: Vec3;
  placement: "ground" | "canopy" | "water-edge" | "elevated" | "underground";
  visibleWhen?: string;
}
export interface EnvironmentRecipeDefinition {
  id: string;
  regionId: RegionId;
  restorationFacts: { partial: string; restored: string };
  proceduralLayers: readonly (
    | "terrain"
    | "water"
    | "vegetation"
    | "fog"
    | "lighting"
    | "collision"
  )[];
  assetPlacementIds: readonly string[];
  groundSurfaceIds: readonly string[];
}
export interface ActorDefinition {
  id: ActorId;
  species:
    | "human"
    | "hornbill"
    | "harpy-eagle"
    | "macaque"
    | "tiger"
    | "tiger-cub"
    | "wolf"
    | "panther"
    | "lion"
    | "crocodile"
    | "boar"
    | "antelope"
    | "howler-monkey"
    | "storm-hornbill"
    | "viper"
    | "toad"
    | "heron"
    | "rootling";
  role:
    | "player"
    | "mentor"
    | "scout"
    | "leader"
    | "companion"
    | "cub"
    | "envoy"
    | "boss"
    | "enemy"
    | "wild";
  allegiance: Allegiance;
  combatRole:
    | "player"
    | "companion"
    | "political-only"
    | "noncombat"
    | "hostile";
  assetId: string;
  assetVariants?: Readonly<Record<string, string>>;
  absentSafeAlternative?: string;
}
export type InteractionSuccess =
  | {
      type: "semantic-interaction";
      kind: SemanticInteractionKind;
      targetId: string;
    }
  | { type: "object-move"; objectId: string }
  | { type: "carry-object"; objectId: string; phase: "pick-up" | "deliver" }
  | { type: "rescue"; targetId: ActorId; locationId: string }
  | { type: "fragment"; fragmentId: FragmentId; sourceId: string }
  | {
      type: "restoration";
      regionId: RegionId;
      state: RestorationState;
      causeId: string;
    }
  | {
      type: "choice";
      choiceId: string;
      targetId: string;
      optionIds: readonly string[];
    }
  | {
      type: "traversal";
      routeId: string;
      fromRegion: RegionId;
      toRegion: RegionId;
      landmarkId: string;
    }
  | { type: "checkpoint"; checkpointId: string };
export interface InteractionDefinition {
  id: string;
  regionId: RegionId;
  /** Owning optional quest; completed quest sites no longer occupy the interaction prompt. */
  questId?: QuestId;
  targetId: string;
  kind: SemanticInteractionKind;
  promptLabel: string;
  radiusMeters: number;
  actionId?: ActionId;
  inputHint?: InteractionInputHint;
  activation?: InteractionActivation;
  requiresCompanionCommand?: {
    companionId: CompanionId;
    command: "special";
  };
  playerActionId?: ActionId;
  requiresFacts: readonly string[];
  requiresActors: readonly ActorId[];
  success: InteractionSuccess;
  repeatable: boolean;
}

export interface RegionEntityDefinition {
  /** Unique placement instance ID; joins one actor entity to ActorSnapshot.id. */
  id: string;
  /** Canonical ACTORS key shared by all instances of this archetype. */
  actorId?: ActorId;
  kind: "actor" | "interaction" | "prop" | "landmark" | "spawn";
  position: Vec3;
  /** Exact manifest asset ID; never derive it from the placement instance ID. */
  assetId?: string;
  interactionId?: string;
  placement: "ground" | "canopy" | "water" | "elevated" | "underground";
  visibleWhen?: string;
}
export interface RegionRouteDefinition {
  id: string;
  from: Vec3;
  to: Vec3;
  anchors: readonly Vec3[];
  destinationRegionId: RegionId;
  kind: "path" | "bridge" | "canopy" | "water" | "cavern" | "gate";
  traversalActionId: ActionId;
  /** Contextual local capsule path; omitted on ordinary paths and interregion travel. */
  traversal?: { kind: "walk" | "vault" | "low-ledge" | "slide" | "swing"; durationTicks: number; startRadius: number; ledge?: { riseMeters: number; maxCrossingMeters: number; faceColliderId: string } };
  colliderIds: readonly string[];
  unlockFact?: string;
  traversalEvent: string;
}
export interface GroundSurfaceDefinition {
  id: string;
  profile:
    | "plane"
    | "ramp"
    | "terrace"
    | "ridge"
    | "canopy"
    | "water"
    | "cavern";
  points: readonly Vec3[];
  elevation: number;
  thickness?: number;
  walkable: boolean;
  material: string;
  colliderId: string;
  traversalEvent?: string;
}
export interface RegionColliderDefinition {
  id: string;
  kind: "box" | "capsule" | "segment";
  from: Vec3;
  to?: Vec3;
  radius?: number;
  halfExtents?: Vec3;
  blocksMovement: boolean;
  blocksCamera: boolean;
  walkSurfaceId?: string;
}
export interface RegionMovableObjectDefinition {
  /** Unique RegionDefinition.props instance id; the same placement keeps the same assetId after a move. */
  id: string;
  assetId: string;
  from: Vec3;
  to: Vec3;
  supportSurfaceId: string;
  radiusMeters: number;
  animationTicks: number;
  requiredCompanionId: CompanionId;
  koroInteractionId: string;
  playerInteractionId: string;
  movedFactId: string;
  requiredFacts: readonly string[];
  effect: {
    kind: "distraction";
    targetActorInstanceId: string;
    radiusMeters: number;
    interruptRangedWindupTicks: number;
  };
}
export type RegionAuthoringStatus = "unaccepted" | "in-progress" | "verified" | "blocked";
export interface RegionFieldTrapDefinition {
  id: string;
  position: Vec3;
  radiusMeters: number;
  disarmFact: string;
}
export interface RegionDeliveryDefinition {
  id: string;
  assetId: string;
  questId: QuestId;
  from: Vec3;
  to: Vec3;
  supportSurfaceId: string;
  pickupInteractionId: string;
  deliveryInteractionId: string;
  movedFactId: string;
  requiredFacts: readonly string[];
}
export interface RegionDefinition {
  id: RegionId;
  authoringStatus: RegionAuthoringStatus;
  name: string;
  biome: string;
  bounds: Bounds3;
  environmentRecipeId: string;
  props: readonly WorldAssetPlacement[];
  movableObjects: readonly RegionMovableObjectDefinition[];
  fieldTraps?: readonly RegionFieldTrapDefinition[];
  deliveries?: readonly RegionDeliveryDefinition[];
  ground: {
    y: number;
    profile: "flat" | "terraced" | "ridge" | "basin" | "canopy" | "cavern";
    navGraphId: string;
    surfaces: readonly GroundSurfaceDefinition[];
    colliders: readonly RegionColliderDefinition[];
  };
  navigation: {
    nodes: readonly {
      id: string;
      position: Vec3;
      links: readonly string[];
      requirement?: string;
    }[];
    ribbons: readonly {
      id: string;
      points: readonly Vec3[];
      width: number;
      depthBand: string;
    }[];
  };
  cameraAnchors: readonly {
    id: string;
    position: Vec3;
    lookAt: Vec3;
    mode: "exploration" | "encounter" | "story";
  }[];
  entrances: readonly RegionRouteDefinition[];
  exits: readonly RegionRouteDefinition[];
  traversalArcs: readonly RegionRouteDefinition[];
  entities: readonly RegionEntityDefinition[];
  encounterIds: readonly string[];
  encounterParticipants: Readonly<Record<string, readonly ActorId[]>>;
  restorationStates: readonly RestorationState[];
  assetIds: readonly string[];
}

export type ObjectiveMechanic =
  | "reach"
  | "interact"
  | "rescue"
  | "encounter"
  | "ecology"
  | "traversal"
  | "investigate"
  | "coordinate"
  | "choice"
  | "survive"
  | "collect";
export interface ObjectiveDefinition {
  id: ObjectiveId;
  title: string;
  description: string;
  mechanic: ObjectiveMechanic;
  requiredEvents: readonly string[];
  targetIds: readonly string[];
  count?: number;
  optional?: boolean;
  next?: readonly ObjectiveId[];
  variant?: string;
}
export interface QuestDefinition {
  id: QuestId;
  title: string;
  description: string;
  chapter: number;
  region: RegionId;
  prerequisites: readonly string[];
  objectives: readonly ObjectiveDefinition[];
  optional: boolean;
  consequenceFacts: readonly string[];
  dialogueIds: readonly string[];
  callbackIds: readonly string[];
}
export interface DialogueLine {
  id: string;
  speaker: ActorId | "narrator" | "echo";
  text: string;
  delivery: "spoken" | "echo" | "vision" | "subtitle";
  condition?: string;
}
export interface DialogueBeat {
  id: string;
  lines: readonly DialogueLine[];
  next?: string;
  choices?: readonly ChoiceDefinition[];
}
export interface ChoiceDefinition {
  id: string;
  title: string;
  description: string;
  effects: readonly string[];
  requires?: string;
  irreversible?: boolean;
}

/** In-game how-to-play cards; each is shown once (persisted in settings) when its moment first arrives. */
export type TutorialId = "controls" | "cleanse-boss" | "tether" | "counter" | "cleanse";
export interface GameSettings {
  masterVolume: number;
  musicVolume: number;
  effectsVolume: number;
  ambienceVolume: number;
  dialogueVolume: number;
  subtitles: boolean;
  echoSubtitles: boolean;
  subtitleSize: "small" | "medium" | "large";
  subtitleBackground: "off" | "translucent" | "solid";
  subtitleSpeakerLabels: boolean;
  reducedMotion: boolean;
  motionBlur: boolean;
  reducedCameraShake: boolean;
  telegraphIntensity: "standard" | "high";
  offscreenWarningStrength: "low" | "standard" | "high";
  highContrastTarget: boolean;
  autoTargetAssist: "off" | "subtle" | "strong";
  perfectDodgeWindow: "standard" | "wide";
  lockOnMode: "hold" | "toggle";
  controlGlyphs: "keyboard-mouse" | "gamepad";
  gamepadDeadzone: number;
  /** One remembered traveling companion per hero; continuing a run still honors that run's saved choice. */
  heroCompanions: Record<HeroId, CompanionId>;
  /** Tutorial cards the player has already dismissed. */
  seenTutorials: readonly TutorialId[];
}
export const DEFAULT_GAME_SETTINGS: GameSettings = {
  masterVolume: 1,
  musicVolume: 0.8,
  effectsVolume: 1,
  ambienceVolume: 0.7,
  dialogueVolume: 1,
  subtitles: true,
  echoSubtitles: true,
  subtitleSize: "medium",
  subtitleBackground: "translucent",
  subtitleSpeakerLabels: true,
  reducedMotion: false,
  motionBlur: true,
  reducedCameraShake: false,
  telegraphIntensity: "standard",
  offscreenWarningStrength: "standard",
  highContrastTarget: false,
  autoTargetAssist: "subtle",
  perfectDodgeWindow: "standard",
  lockOnMode: "toggle",
  controlGlyphs: "keyboard-mouse",
  gamepadDeadzone: 0.18,
  heroCompanions: { ...DEFAULT_HERO_COMPANIONS },
  seenTutorials: [],
};
export interface InputFrame {
  tick: number;
  move: Vec3;
  dodgePressed: boolean;
  jumpPressed?: boolean;
  sprintHeld?: boolean;
  lightPressed: boolean;
  heavyPressed: boolean;
  heavyHeld: boolean;
  heavyReleased: boolean;
  rangedPressed?: boolean;
  rangedHeld?: boolean;
  rangedReleased?: boolean;
  ultimatePressed?: boolean;
  interactPressed: boolean;
  abilityPressed?: string;
  /** Edge-fired the tick the Lock-On key/button was pressed; cleared on release or any reset (disable/blur/hidden/wheel/dispose). */
  lockOnPressed: boolean;
  /** True while the Lock-On key/button is held; never carries an edge in the same frame as a release. */
  lockOnHeld: boolean;
  command?: {
    companionId: CompanionId;
    command: FieldCommand | "ask" | "signal";
    targetId?: ActorId;
  };
}

export type WorldEvent =
  | {
      type: "semantic-interaction";
      eventId: string;
      idempotencyKey: string;
      actorId: ActorId;
      interactionId: string;
      kind: SemanticInteractionKind;
      targetId: string;
      position: Vec3;
      facts?: Readonly<Record<string, boolean | number | string>>;
    }
  | {
      type: "object-moved";
      eventId: string;
      idempotencyKey: string;
      regionId: RegionId;
      objectId: string;
      interactionId: string;
      actorId: ActorId;
      from: Vec3;
      to: Vec3;
    }
  | {
      type: "encounter-resolved";
      eventId: string;
      idempotencyKey: string;
      encounterId: string;
      resolution: "cleansed" | "subdued" | "escaped" | "dominated";
      actorIds: readonly ActorId[];
      facts?: Readonly<Record<string, boolean | number | string>>;
    }
  | {
      type: "encounter-phase";
      eventId: string;
      idempotencyKey: string;
      encounterId: string;
      actorId: ActorId;
      phaseId: string;
      phaseIndex: number;
      state: "entered" | "cleared";
      simulationTick: number;
    }
  | {
      type: "possession";
      eventId: string;
      idempotencyKey: string;
      actorId: ActorId;
      targetId: ActorId;
      phaseId: string;
      state: "telegraphed" | "began" | "broken" | "escaped";
      simulationTick: number;
    }
  | {
      type: "rescue";
      eventId: string;
      idempotencyKey: string;
      targetId: ActorId;
      locationId: string;
      safe: boolean;
    }
  | {
      type: "restoration";
      eventId: string;
      idempotencyKey: string;
      regionId: RegionId;
      state: RestorationState;
      causeId: string;
    }
  | {
      type: "fragment";
      eventId: string;
      idempotencyKey: string;
      fragmentId: FragmentId;
      sourceId: string;
    }
  | {
      type: "choice";
      eventId: string;
      idempotencyKey: string;
      choiceId: string;
      optionId: string;
      leaderId?: string;
      dominion?: boolean;
    }
  | {
      type: "traversal";
      eventId: string;
      idempotencyKey: string;
      routeId: string;
      fromRegion: RegionId;
      toRegion: RegionId;
      landmarkId: string;
    }
  | {
      type: "chapter-transition";
      eventId: string;
      idempotencyKey: string;
      fromChapter: number;
      toChapter: number;
      triggerId: string;
    };

export interface BossPhaseDefinition {
  id: string;
  actorVariantId?: string;
  attackIds: readonly AttackId[];
  arenaModifierIds: readonly string[];
  requiredEvents: readonly string[];
  interruptionPolicy: "none" | "stagger" | "tether" | "cleanse";
}
export interface EncounterDefinition {
  id: string;
  regionId: RegionId;
  bossId?: ActorId;
  actorIds: readonly ActorId[];
  phaseIds: readonly string[];
  phases: readonly BossPhaseDefinition[];
  playerOnlyCounters: readonly string[];
  supportSlots: readonly CompanionId[];
  failureCheckpointId: string;
}
export interface AssetManifestEntry {
  id: string;
  actorId?: ActorId;
  variantOf?: string;
  sourceType: "native-glb" | "composed-recipe" | "procedural";
  componentAssetIds?: readonly string[];
  proceduralRecipeId?: string;
  kind: "character" | "environment" | "prop" | "vfx" | "audio" | "ui";
  tripoSourceTask?: string;
  /** SHA-256 of the native source GLB; not the Tripo input image digest. */
  sourceHash?: string;
  /** SHA-256 of the input image or upstream source artifact when applicable. */
  sourceInputHash?: string;
  /** SHA-256 of the immutable runtime derivative addressed by runtimeUrl. */
  outputHash?: string;
  runtimeUrl?: string | null;
  materialId?: string;
  lodIds: readonly string[];
  rigFamily?: string;
  /** Native bone exposed as the `cast` socket (spell/VFX origin) when no authored `cast` socket node exists. */
  castSocketBone?: string;
  requiredActionIds: readonly ActionId[];
  actionToClipMapping: Readonly<Record<string, string | null>>;
  /** Development-only in-memory motion; never qualifies as a native GLTF action clip. */
  playtestAnimation?: {
    rigFamily: "biped" | "avian" | "quadruped";
    actionIds: readonly ActionId[];
    torsoBoneNames?: readonly string[];
    headBoneName?: string;
    armRootNames?: readonly string[];
    legRootNames?: readonly string[];
    wingRootNames?: readonly string[];
    wingSecondaryBoneNames?: readonly string[];
    limbRootNames?: readonly string[];
  };
  /** Per-action root-motion and contact evidence; missing values remain explicitly unavailable. */
  rootMotion?: Readonly<
    Record<
      string,
      {
        mode: "in-place" | "native-root-motion" | "authored-curve" | "unverified";
        rootNodeName?: string;
        curveHash?: string;
        curveUrl?: string | null;
        curveSamples?: readonly { time: number; position: Vec3 }[];
        evidenceStatus: "not-started" | "in-progress" | "verified" | "blocked";
        /**
         * Opt-in policy that suppresses the X/Z bind reset so the renderer
         * can keep authored native crouch/bob while simulation drives the
         * actor's horizontal travel. Default false preserves the generic
         * full-root consumption; only measured Greenwake Aren native clip
         * mappings should set this to true.
         */
        preserveVerticalMotion?: boolean;
      }
    >
  >;
  contacts?: readonly { actionId: ActionId; markerId: string; normalizedTime: number; socketId?: string; expectedPosition?: Vec3; measuredPosition?: Vec3; toleranceMeters?: number; evidenceStatus: 'not-started' | 'in-progress' | 'verified' | 'blocked' }[];
  coordinateTransform?: { forward: Vec3; scale: number; originOffset?: Vec3 } | null;
  sockets: readonly string[];
  collisionProxyId?: string;
  provenance: string;
  evidenceStatus: "not-started" | "in-progress" | "verified" | "blocked";
}

/** Asset policy and persistence scope are independent of gameplay mode; validate the combination with `validateSessionConfig`. */
export type AssetPolicy = "verified" | "candidate";
export type SaveScope = "production" | "candidate-chapters";
export type SessionConfig =
  | { kind: "chapters"; assets: AssetPolicy; saveScope: SaveScope }
  | { kind: "trials"; assets: "candidate"; mapId: string }
  | { kind: "training"; assets: AssetPolicy; mapId: string };

/**
 * Verified chapters use production scope; playable candidate chapters use candidate scope. DEV-only Trials use their own
 * PlaytestProgress and never a chapter repository. Throws on an invalid combination.
 */
export function validateSessionConfig(config: SessionConfig, isDev: boolean): SessionConfig {
  if (config.kind === "trials") {
    if (config.assets !== "candidate" || !config.mapId.trim()) throw new Error("Trials require candidate assets and a map id.");
    if (!isDev) throw new Error("Trials are available only in DEV builds.");
    return config;
  }
  if (config.kind === "training") {
    if (!config.mapId.trim() || !["candidate", "verified"].includes(config.assets)) throw new Error("Training Grounds require a map and an explicit asset policy.");
    return config;
  }
  const production = config.assets === "verified" && config.saveScope === "production";
  const candidate = config.assets === "candidate" && config.saveScope === "candidate-chapters";
  if (!production && !candidate) throw new Error("Asset policy and save scope must match: verified↔production, candidate↔candidate-chapters.");
  return config;
}
/** The asset policy implied by a save scope. */
export function assetPolicyForScope(scope: SaveScope): AssetPolicy {
  return scope === "candidate-chapters" ? "candidate" : "verified";
}

export type ChapterSegmentId =
  | "prologue"
  | "greenwake"
  | "canopy"
  | "bamboo"
  | "grove"
  | "moonpine"
  | "mistveil"
  | "sunmane"
  | "grove-fall"
  | "refuge"
  | "return-canopy"
  | "return-bamboo"
  | "return-moonpine"
  | "return-mistveil"
  | "return-sunmane"
  | "hollow";
export interface ChapterCheckpointDefinition {
  id: string;
  regionId: RegionId;
  /** Canonical nav node or entrance id in the region. */
  nodeId: string;
  cameraAnchorId: string;
  radius: number;
  requiresFacts: readonly string[];
  /** Encounter this checkpoint resets (the pre-fight checkpoint of that encounter), or null. */
  encounterId: string | null;
}
export interface ChapterEncounterEntry {
  /** Stable trigger id. */
  id: string;
  encounterId: string;
  regionId: RegionId;
  objectiveId: ObjectiveId;
  center: Vec3;
  radius: number;
  checkpointId: string;
  requiresFacts: readonly string[];
}
export interface ChapterRuntimeDefinition {
  segmentId: ChapterSegmentId;
  /** Prologue/greenwake = 0; a Grove visit preserves chapter 2. */
  chapter: number;
  regionId: RegionId;
  layoutRevision: number;
  checkpoints: readonly ChapterCheckpointDefinition[];
  encounterEntries: readonly ChapterEncounterEntry[];
  /**
   * Requirements that must hold before `advanceChapter` leaves this segment. Grammar: a world-fact key that is true,
   * `quest:<id>` completed, `objective:<id>` completed, `choice:<id>[:<option>]` committed, `beat:<id>` completed.
   */
  exitRequirements: readonly string[];
}
/**
 * Durable, Director-owned story/resume entitlement. `segmentId`/`checkpointId` are null only where no chapter runtime
 * definition applies (chapters 3–8 and legacy saves outside Act I); dialogue/choice resume still applies there.
 */
export interface ChapterResumeState {
  segmentId: ChapterSegmentId | null;
  layoutRevision: number;
  checkpointId: string | null;
  activeEncounterId: string | null;
  requiredBeatQueue: readonly string[];
  dialogue: { beatId: string; lineIndex: number } | null;
  completedBeatIds: readonly string[];
  pendingChoiceId: string | null;
}
export interface ChapterSessionMetadata {
  saveScope: SaveScope;
  assetPolicy: AssetPolicy;
  heroId: HeroId;
  resume: ChapterResumeState;
}
/** Explicit content-revision mapping: where an old layout's safe spawn node moves when a region layout is revised. */
export interface LayoutRevisionMigration {
  regionId: RegionId;
  fromRevision: number;
  toRevision: number;
  /** Old safe-spawn route/node id → new canonical node or entrance id. Ids absent here are kept only if still a safe authored node. */
  nodeMap: Readonly<Record<string, string>>;
  /** Authored safe node used when an old id is neither mapped nor still valid. */
  fallbackNodeId: string;
}
/** Authored one-shot relationship award; `id` keys idempotency, `requiredEvent` uses the objective event grammar. */
export interface CompanionRelationshipRule {
  id: string;
  companionId: CompanionId;
  requiredEvent: string;
  bond?: number;
  recruit?: boolean;
  storyFlag?: string;
}

/** The eight player-facing field verbs. Later-act Ask/Signal stay separate interaction abilities. */
export type FieldCommand =
  | "follow" | "stay" | "focus" | "defend"
  | "search" | "distract" | "special" | "recall";
export type CompanionTarget =
  | { kind: "actor"; instanceId: ActorId }
  | { kind: "interaction"; interactionId: string; targetId: string }
  | { kind: "hazard"; hazardId: string; protecteeId: ActorId };
export interface CompanionCommandRequest {
  companionId: CompanionId;
  command: FieldCommand;
  target?: CompanionTarget;
}
export interface CommandAvailability {
  available: boolean;
  reason: string | null;
  readyAtWorldTick: number;
  tokenCost: number;
}
export interface ChapterSpatialIntent {
  kind: "checkpoint" | "encounter-entry";
  definitionId: string;
  simulationTick: number;
}
export interface CompanionParty {
  companionId?: CompanionId;
}
export interface CampaignProgressCheckpoint {
  chapter: number;
  regionId: RegionId;
  activeQuestIds: readonly QuestId[];
  completedQuestIds: readonly QuestId[];
  completedObjectiveIds: readonly ObjectiveId[];
  trackedObjectiveId: ObjectiveId | null;
  party: CompanionParty;
  choices: Readonly<Record<string, string>>;
  worldFacts: Readonly<Record<string, boolean | number | string>>;
  ending: "dominion" | "severance" | "living_pact" | null;
  eventLog: readonly WorldEvent[];
  eventKeys: readonly string[];
  revision: number;
  /** The one persisted definition of session fields shared with `CampaignProgressRecord`. */
  session: ChapterSessionMetadata;
}
export interface CampaignSafeSpawn {
  regionId: RegionId;
  position: Vec3;
  routeId: string;
  cameraAnchorId: string;
}
export interface CampaignSafeCheckpoint {
  kind: "campaign-safe-checkpoint";
  schemaVersion: 3;
  runId: string;
  checkpointId: string;
  worldCheckpoint: CheckpointSnapshot;
  progress: CampaignProgressCheckpoint;
  safeSpawn: CampaignSafeSpawn;
  encounterReset: {
    policy: "restart-from-entry";
    encounterId: string | null;
    actorIds: readonly ActorId[];
  };
}
export interface CampaignSnapshot {
  lastEvent: WorldEvent | null;
  recoveryRequest: {
    kind: "restart-checkpoint";
    reason: "tali-safety";
    checkpointId: string;
  } | null;
  trackedObjectiveId: ObjectiveId | null;
  schemaVersion: number;
  runId: string;
  replay: boolean;
  chapter: number;
  chapterId: string;
  regionId: RegionId;
  activeQuestIds: readonly QuestId[];
  completedQuestIds: readonly QuestId[];
  activeObjectiveIds: readonly ObjectiveId[];
  completedObjectiveIds: readonly ObjectiveId[];
  campaign: CampaignState;
  fragments: readonly FragmentId[];
  factions: CampaignState["world"]["factions"];
  party: CompanionParty;
  worldFacts: Readonly<Record<string, boolean | number | string>>;
  lastSafeCheckpoint: CampaignSafeCheckpoint | null;
  choices: Readonly<Record<string, string>>;
  ending: "dominion" | "severance" | "living_pact" | null;
  endingEvaluation: EndingEvaluation;
  revision: number;
  /** Hero, scope, asset policy and durable chapter resume state of this journey. */
  session: ChapterSessionMetadata;
  /** Authored story segment, or null outside Act I (chapters 3–8 have no chapter runtime definition). */
  segmentId: ChapterSegmentId | null;
  /** Per-companion Bond/Dominion progression, recruitment state and unlocked abilities. */
  companions: Readonly<Record<CompanionId, CompanionProgress>>;
}
/** Presentation key of a region scene (loading scene, map intro, establishing shot); mirrors `RegionSceneId`. */
export type SceneRegionId = "greenwake" | "canopy" | "grove" | "bamboo" | "moonpine" | "mistveil";
export interface HubViewModel {
  name: string;
  stage: string;
  upgrades: readonly {
    id: string;
    title: string;
    description: string;
    learned: boolean;
    available: boolean;
    requirement: string;
  }[];
  memories: readonly {
    id: string;
    title: string;
    lines: readonly { speaker: string; text: string }[];
  }[];
  practice: {
    available: boolean;
    reason: string | null;
    active: boolean;
    attempts: number;
    dodged: number;
    phase: "idle" | "warning" | "strike" | "recovery";
  };
}
export interface GameViewModel {
  trackedObjectiveId: ObjectiveId | null;
  canOpenWorldPanels: boolean;
  screen:
    | "title"
    | "map-select"
    | "training-select"
    | "hero-select"
    | "map-intro"
    | "chapters-menu"
    | "loading"
    | "game"
    | "pause"
    | "credits"
    | "map"
    | "journal"
    | "companions"
    | "hub"
    | "settings"
    | "dialogue"
    | "choice"
    | "ending"
    | "stage-complete"
    | "defeat";
  loading: {
    active: boolean;
    label: string;
    progress: number | null;
    operationId?: string;
    /** Narrative stage text and per-stage detail shown alongside the progress bar. */
    detail?: { stage: string; phaseLabel?: string; message?: string };
  };
  /**
   * Region scene shown by the loading screen, map intro and establishing shot; absent when no scene is on screen.
   * `establishingShot` is true while the world is revealed by the camera sweep: simulation is paused and only Skip works.
   */
  scene?: { regionId: SceneRegionId; heroName: string | null; establishingShot: boolean };
  error: { code: string; message: string; recoverable: boolean } | null;
  hud: {
    heroId?: HeroId;
    vitality: number;
    maxVitality: number;
    mana: number;
    maxMana: number;
    skills: readonly PlayerSkillSnapshot[];
    encounterStatus?: EncounterStatusSnapshot;
    instinct: number;
    boss: CombatSnapshot["boss"];
    interaction?: {
      interactionId: string;
      targetId: ActorId;
      label: string;
      actionId?: ActionId;
      inputHint?: InteractionInputHint;
      activation?: InteractionActivation;
      requiresCompanionCommand?: { companionId: CompanionId; command: "special" };
      playerActionId?: ActionId;
    };
    targetId?: ActorId;
    target?: ActorSnapshot;
    /** Development playtest destination (the active trial gate, then the stage exit); does not represent campaign completion. */
    destination?: { label: string; distanceMeters: number; bearingDegrees: number };
  };
  /** Local asset-playtest wording (exit name and stage-complete copy); absent outside a playtest. */
  playtestStage?: { exitName: string; completeKicker: string; completeCopy: string };
  playtestSelection?: {
    selectedMapId: string;
    heroId: HeroId;
    nextMapId?: string;
    progressWarning?: string;
    /** Story chapters in order; `comingSoon` chapters have no playable map and never unlock. */
    maps: readonly {
      id: string; label: string; name: string; setting: string;
      thumbnailUrl: string | null; mapArt?: { size: string; position: string };
      monsters: readonly string[]; comingSoon: boolean; unlocked: boolean; cleared: boolean;
    }[];
  };
  /** Campaign-earned practice choices; practice never contributes to campaign history or saves. */
  training?: {
    active: boolean;
    available: boolean;
    reason: string | null;
    maps: readonly { id: string; name: string; regionId: RegionId; unlocked: boolean; reason: string | null; thumbnailUrl: string }[];
  };
  campaign: CampaignSnapshot | null;
  journal: { quests: readonly QuestDefinition[]; region: RegionId | null };
  map: {
    currentRegion: RegionId | null;
    regions: readonly {
      id: RegionId;
      name: string;
      unlocked: boolean;
      reason?: string | null;
      restoration: RestorationState;
      entrances: readonly { id: string; label: string; unlocked: boolean; reason?: string | null }[];
    }[];
  };
  party: CampaignSnapshot["party"] | null;
  abilities: readonly {
    id: string;
    label: string;
    companionId?: CompanionId;
    element?: CompanionElement;
    description?: string;
    automatic?: string;
    tokenCost?: number;
    cooldownSeconds?: number;
    available: boolean;
    reason?: string;
    previewAvailable: boolean;
    previewReason: string | null;
  }[];
  relationships: CampaignState["world"]["factions"] | null;
  hub?: HubViewModel;
  settings: GameSettings;
  bindings: InputBindingMaps;
  saves: { slots: readonly SaveSlotViewModel[]; continueSlotId: string | null };
  dialogue: DialogueBeat | null;
  dialogueLineIndex: number;
  choice: {
    id: string;
    title: string;
    options: readonly ChoiceDefinition[];
  } | null;
  ending: {
    id: "dominion" | "severance" | "living_pact";
    title: string;
    summary: string;
    /** The Grove line the chosen ending delivers (authored epilogue). */
    grove?: string;
    /** Optional two-line epilogue; Living Pact has one. */
    lines?: readonly string[];
  } | null;
  /** Chapter/trial/production session banner and entry-mode data. */
  session?: {
    kind: "chapters" | "trials" | "training" | "production";
    banner: string | null;
    heroId: HeroId | null;
    saveScope: SaveScope | null;
    checkpointName: string | null;
    segmentId: ChapterSegmentId | null;
    devModes: boolean;
  };
  objectiveHud?: {
    chapterLabel: string;
    questTitle: string;
    objectiveTitle: string;
    /** Position of the current objective within its quest (1-based), e.g. step 4 of 6. */
    step: { index: number; total: number } | null;
    counter: string | null;
    interaction: string | null;
    interactionInputHint: InteractionDefinition['inputHint'] | 'companions' | 'commandWheel';
    /** Authored story context and honest approach/requirement instructions. */
    guidance?: string;
    status?: "approach" | "ready" | "blocked";
    destination: { label: string; distanceMeters: number | null; bearingDegrees: number | null; hint: string | null } | null;
  };
  wheel?: {
    open: boolean;
    selectedSector: number | null;
    tokens: number;
    target: string | null;
    companion: {
      companionId: CompanionId;
      name: string;
      commands: readonly { command: FieldCommand; label: string; available: boolean; reason: string | null }[];
    };
  };
  partyPanel?: {
    companionId: CompanionId | null;
    name: string;
    options: readonly { companionId: CompanionId; name: string; available: boolean; reason: string | null }[];
  };
  dialogueChoice?: { required: boolean };
  chapterAct?: {
    exits: readonly { id: string; label: string; available: boolean; reason: string | null }[];
    actTwoNotice: string | null;
  };
  companionProgress?: Readonly<Record<CompanionId, { name: string; recruited: boolean; bond: number; dominion: number }>>;
  hasCandidateSaves?: boolean;
  /** The how-to-play card on screen; gameplay is frozen until it is dismissed. */
  tutorial?: TutorialId;
  /** One shared answer to "what am I doing": the HUD, Journal and Map all read the same current quest and objective. */
  questLog?: QuestLogViewModel;
  /** Top-down map of the region Aren is in, oriented so "up" is the camera's forward direction. */
  areaMap?: AreaMapViewModel;
}
export type QuestObjectiveState = "done" | "current" | "active" | "upcoming";
export interface QuestLogEntry {
  id: QuestId;
  title: string;
  description: string;
  optional: boolean;
  objectives: readonly { id: ObjectiveId; title: string; description: string; optional: boolean; state: QuestObjectiveState }[];
}
export interface QuestLogViewModel {
  currentQuestId: QuestId | null;
  currentObjectiveId: ObjectiveId | null;
  /** Active quests, the current quest first, then main story, then side quests. Future quests are never listed. */
  active: readonly QuestLogEntry[];
  completed: readonly QuestLogEntry[];
}
/** Map-space point: `u` grows to the screen right, `v` grows away from the camera (screen up). Metres. */
export interface AreaMapPoint { u: number; v: number }
export interface AreaMapViewModel {
  regionName: string;
  bounds: { minU: number; maxU: number; minV: number; maxV: number };
  /** Survey grid square size in metres; columns are lettered from the left, rows numbered from the top. */
  gridStep: number;
  surfaces: readonly { id: string; water: boolean; points: readonly AreaMapPoint[] }[];
  paths: readonly (readonly [AreaMapPoint, AreaMapPoint])[];
  player: (AreaMapPoint & { headingDegrees: number; grid: string }) | null;
  markers: readonly {
    id: string;
    kind: "current" | "objective" | "exit";
    label: string;
    /** Exits: whether the route is open; objectives: always true. */
    available: boolean;
    detail: string | null;
    at: AreaMapPoint;
    grid: string;
  }[];
}
export interface SaveSlotViewModel {
  slotId: string;
  label: string;
  runId: string;
  kind: "campaign" | "showcase-replay";
  updatedAt: number;
  chapter: number;
  regionId: RegionId;
  exists: boolean;
  /** Isolated persistence scope the slot lives in. */
  scope: SaveScope;
  heroId: HeroId | null;
  segmentId: ChapterSegmentId | null;
  /** Authored checkpoint the slot resumes at ("Saved at <checkpoint>"). */
  checkpointId: string | null;
  /** True for the per-run autosave slot written atomically with each committed event. */
  autosave: boolean;
}
export type UIAction =
  | { type: "new-game"; runId: string }
  | { type: "select-map"; mapId: string }
  | { type: "select-hero"; heroId: HeroId; companionId?: CompanionId; runId: string }
  | { type: "select-hero-companion"; heroId: HeroId; companionId: CompanionId }
  | { type: "map-select" }
  | { type: "continue"; slotId: string }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "retry-load"; operationId: string }
  | { type: "advance-dialogue"; beatId: string }
  | { type: "return-title" }
  | {
      type: "view-credits";
      endingId?: "dominion" | "severance" | "living_pact";
    }
  | { type: "interact"; interactionId: string; targetId: ActorId }
  | { type: "open-map" }
  | { type: "open-journal" }
  | { type: "open-companions" }
  | { type: "open-hub" }
  | { type: "open-training" }
  | { type: "start-training"; mapId: string }
  | { type: "leave-training" }
  | { type: "learn-upgrade"; upgradeId: string }
  | { type: "start-dodge-training" }
  | { type: "stop-dodge-training" }
  | { type: "open-settings" }
  | { type: "close-screen" }
  | { type: "create-save-slot"; label: string }
  | { type: "save"; slotId: string; label: string }
  | { type: "load"; slotId: string }
  | { type: "import"; payload: string }
  | { type: "export"; slotId?: string }
  | { type: "accept-quest"; questId: QuestId }
  | { type: "track-objective"; objectiveId: ObjectiveId | null }
  | {
      type: "select-companion";
      companionId: CompanionId;
    }
  | {
      type: "issue-command";
      companionId: CompanionId;
      command: NonNullable<InputFrame["command"]>;
    }
  | { type: "use-ability"; abilityId: string; targetId?: ActorId }
  | { type: "preview-companion-skill"; abilityId: string }
  | { type: "choose"; choiceId: string; optionId: string }
  | { type: "travel"; regionId: RegionId; entranceId: string }
  | { type: "update-settings"; settings: Partial<GameSettings> }
  | { type: "remap"; device: keyof InputBindingMaps; actionId: string; binding: string }
  | { type: "skip-cinematic"; cinematicId: string }
  | { type: "leave-map-intro" }
  | { type: "skip-establishing-shot" }
  | { type: "enter-mode"; mode: "chapters" | "trials" }
  | { type: "begin-journey" }
  | { type: "wheel"; op: "open" | "cancel" | "sector" | "commit"; sector?: number }
  | { type: "retry-checkpoint" }
  | { type: "dismiss-tutorial" }
  | { type: "reset-tutorials" };

/** Operations Wave 2 adds to the Director; all serialize on the same queue as event writes. */
export interface ChapterDirectorAPI {
  /** Creates a normal Prologue run with an immutable hero and no traveling companion; supplied companion gifts are refused. */
  startChapterRun(input: { runId: string; heroId: HeroId; companionId?: CompanionId; saveScope: SaveScope }): CampaignSnapshot;
  /** Commits the named pre-fight checkpoint and the active-encounter intent before combat starts. */
  beginChapterEncounter(encounterId: string, checkpointId: string): Promise<CampaignSnapshot>;
  /** Activates an authored chapter checkpoint as the safe spawn once its prerequisites are met. */
  reachCheckpoint(checkpointId: string): Promise<CampaignSnapshot>;
  /** The single chapter-transition operation: validates exit requirements, advances the chapter if needed and travels, atomically. */
  advanceChapter(input: { exitId: string; requestId: string }): Promise<CampaignSnapshot>;
  /** Acknowledges one dialogue line (or, with `skip`, the whole beat) while keeping any required choice pending. */
  advanceStory(input: { beatId: string; lineIndex: number; skip: boolean }): Promise<CampaignSnapshot>;
  /** Durable replacement of the sole earned, present companion outside an active encounter. */
  selectParty(companionId: CompanionId): Promise<CampaignSnapshot>;
  /** Persists the current progress to the run's autosave slot (serialized with event writes). */
  autosave(): Promise<void>;
}

export interface CampaignDirectorAPI extends ChapterDirectorAPI {
  startNewRun(runId?: string, heroId?: HeroId, companionId?: CompanionId): CampaignSnapshot;
  startShowcase(runId?: string, regionId?: "greenwake" | "whispering-canopy" | "the-grove" | "moonpine-ridge" | "mistveil-basin", loadout?: { heroId: HeroId; companionId: CompanionId }): CampaignSnapshot;
  /** Creates replay-isolated practice from earned state; a Director with a SaveRepository must refuse it. */
  startPracticeRun(input: { runId: string; source: CampaignSnapshot; regionId: RegionId }): CampaignSnapshot;
  snapshot(): CampaignSnapshot;
  subscribe(listener: (snapshot: CampaignSnapshot) => void): () => void;
  processEvent(event: WorldEvent): Promise<CampaignSnapshot>;
  choose(choiceId: string, optionId: string): Promise<CampaignSnapshot>;
  acceptQuest(questId: QuestId): Promise<CampaignSnapshot>;
  learnUpgrade(upgradeId: string): Promise<CampaignSnapshot>;
  trackObjective(objectiveId: ObjectiveId | null): CampaignSnapshot;
  travel(regionId: RegionId, entranceId: string): Promise<CampaignSnapshot>;
  captureCheckpoint(): Promise<CampaignSafeCheckpoint>;
  restoreCheckpoint(input: unknown): Promise<boolean>;
  save(slotId: string, label: string): Promise<void>;
  saveNewSlot(label: string): Promise<string>;
  load(slotId: string): Promise<CampaignSnapshot>;
  exportSave(slotId: string): Promise<string>;
  importSave(
    input: string,
    slotId: string,
    label: string,
  ): Promise<CampaignSnapshot>;
  ending(): EndingEvaluation;
}
