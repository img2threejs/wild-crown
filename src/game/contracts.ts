import type {
  CampaignState,
  CheckpointSnapshot,
  EndingEvaluation,
  FragmentId,
  RegionId as CanonRegionId,
  RestorationState,
} from "../../packages/campaign/src/index.js";
export type { FragmentId };

export type RegionId =
  | "greenwake"
  | "the-grove"
  | CanonRegionId
  | "refuge"
  | "heartroot-hollow";
export type ActorId = string & {};
export type CompanionId =
  | "vara"
  | "koro"
  | "asha"
  | "sable"
  | "nyra"
  | "solkar";
export type QuestId = string & { readonly __questId?: unique symbol };
export type ObjectiveId = string & { readonly __objectiveId?: unique symbol };
export type AttackId = string & { readonly __attackId?: unique symbol };
export type ActionId = string & { readonly __actionId?: unique symbol };
export type InteractionInputHint = "interact" | "heavy" | "ability";
export type InteractionActivation = "press" | "press-release";
export interface InputBindingMaps {
  keyboard: Readonly<Record<string, string>>;
  gamepad: Readonly<Record<string, string>>;
}

export const DEFAULT_KEYBOARD_BINDINGS: Readonly<Record<string, string>> =
  Object.freeze({
    moveForward: "w",
    moveBack: "s",
    moveLeft: "a",
    moveRight: "d",
    dodge: "space",
    light: "j",
    heavy: "k",
    interact: "e",
    ability: "q",
    map: "m",
    journal: "tab",
    companions: "c",
    pause: "escape",
    commandWheel: "r",
  });

export const DEFAULT_GAMEPAD_BINDINGS: Readonly<Record<string, string>> =
  Object.freeze({
    dodge: "Gamepad Button 1",
    ability: "Gamepad Button 2",
    light: "Gamepad Button 3",
    interact: "Gamepad Button 4",
    map: "Gamepad Button 5",
    heavy: "Gamepad Button 6",
    commandWheel: "Gamepad Button 7",
    journal: "Gamepad Button 8",
    companions: "Gamepad Button 9",
    pause: "Gamepad Button 10",
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

export interface CombatSnapshot {
  actors: readonly ActorSnapshot[];
  movableObjects: readonly MovableObjectSnapshot[];
  readonly worldClock: WorldClockSnapshot;
  player: {
    vitality: number;
    maxVitality: number;
    instinct: number;
    dodgeCharges: number;
    maxDodgeCharges: number;
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
  }[];
  hazards: readonly {
    id: string;
    kind: "strike" | "sweep" | "wave" | "area" | "projectile";
    bounds: Bounds3;
    active: boolean;
  }[];
  targetId?: ActorId;
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
    | "macaque"
    | "tiger"
    | "tiger-cub"
    | "wolf"
    | "panther"
    | "lion"
    | "crocodile"
    | "boar"
    | "antelope";
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
  targetId: string;
  kind: SemanticInteractionKind;
  promptLabel: string;
  radiusMeters: number;
  actionId?: ActionId;
  inputHint?: InteractionInputHint;
  activation?: InteractionActivation;
  requiresCompanionCommand?: {
    companionId: CompanionId;
    slot: "utility";
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
export interface RegionDefinition {
  id: RegionId;
  authoringStatus: RegionAuthoringStatus;
  name: string;
  biome: string;
  bounds: Bounds3;
  environmentRecipeId: string;
  props: readonly WorldAssetPlacement[];
  movableObjects: readonly RegionMovableObjectDefinition[];
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
};
export interface InputFrame {
  tick: number;
  move: Vec3;
  dodgePressed: boolean;
  lightPressed: boolean;
  heavyPressed: boolean;
  heavyHeld: boolean;
  heavyReleased: boolean;
  interactPressed: boolean;
  abilityPressed?: string;
  command?: {
    companionId: CompanionId;
    command:
      | "follow"
      | "stay"
      | "focus"
      | "defend"
      | "search"
      | "distract"
      | "special"
      | "recall"
      | "ask"
      | "signal";
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
  requiredActionIds: readonly ActionId[];
  actionToClipMapping: Readonly<Record<string, string | null>>;
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
      }
    >
  >;
  contacts?: readonly { actionId: ActionId; markerId: string; normalizedTime: number; socketId?: string; expectedPosition?: Vec3; measuredPosition?: Vec3; toleranceMeters?: number; evidenceStatus: 'not-started' | 'in-progress' | 'verified' | 'blocked' }[];
  coordinateTransform?: { forward: Vec3; scale: number };
  sockets: readonly string[];
  collisionProxyId?: string;
  provenance: string;
  evidenceStatus: "not-started" | "in-progress" | "verified" | "blocked";
}
export interface CampaignProgressCheckpoint {
  chapter: number;
  regionId: RegionId;
  activeQuestIds: readonly QuestId[];
  completedQuestIds: readonly QuestId[];
  completedObjectiveIds: readonly ObjectiveId[];
  trackedObjectiveId: ObjectiveId | null;
  party: { combat?: CompanionId; utility?: CompanionId; scout: "vara" };
  choices: Readonly<Record<string, string>>;
  worldFacts: Readonly<Record<string, boolean | number | string>>;
  ending: "dominion" | "severance" | "living_pact" | null;
  eventLog: readonly WorldEvent[];
  eventKeys: readonly string[];
  revision: number;
}
export interface CampaignSafeSpawn {
  regionId: RegionId;
  position: Vec3;
  routeId: string;
  cameraAnchorId: string;
}
export interface CampaignSafeCheckpoint {
  kind: "campaign-safe-checkpoint";
  schemaVersion: 1;
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
  party: { combat?: CompanionId; utility?: CompanionId; scout: "vara" };
  worldFacts: Readonly<Record<string, boolean | number | string>>;
  lastSafeCheckpoint: CampaignSafeCheckpoint | null;
  choices: Readonly<Record<string, string>>;
  ending: "dominion" | "severance" | "living_pact" | null;
  endingEvaluation: EndingEvaluation;
  revision: number;
}
export interface GameViewModel {
  trackedObjectiveId: ObjectiveId | null;
  screen:
    | "title"
    | "loading"
    | "game"
    | "pause"
    | "credits"
    | "map"
    | "journal"
    | "companions"
    | "settings"
    | "dialogue"
    | "choice"
    | "ending";
  loading: {
    active: boolean;
    label: string;
    progress: number | null;
    operationId?: string;
  };
  error: { code: string; message: string; recoverable: boolean } | null;
  hud: {
    vitality: number;
    maxVitality: number;
    dodgeCharges: number;
    maxDodgeCharges: number;
    instinct: number;
    boss: CombatSnapshot["boss"];
    interaction?: {
      interactionId: string;
      targetId: ActorId;
      label: string;
      actionId?: ActionId;
      inputHint?: InteractionInputHint;
      activation?: InteractionActivation;
      requiresCompanionCommand?: { companionId: CompanionId; slot: "utility"; command: "special" };
      playerActionId?: ActionId;
    };
    targetId?: ActorId;
    target?: ActorSnapshot;
  };
  campaign: CampaignSnapshot | null;
  journal: { quests: readonly QuestDefinition[]; region: RegionId | null };
  map: {
    currentRegion: RegionId | null;
    regions: readonly {
      id: RegionId;
      name: string;
      unlocked: boolean;
      restoration: RestorationState;
      entrances: readonly { id: string; label: string; unlocked: boolean }[];
    }[];
  };
  party: CampaignSnapshot["party"] | null;
  abilities: readonly {
    id: string;
    label: string;
    available: boolean;
    reason?: string;
  }[];
  relationships: CampaignState["world"]["factions"] | null;
  settings: GameSettings;
  bindings: InputBindingMaps;
  saves: { slots: readonly SaveSlotViewModel[]; continueSlotId: string | null };
  dialogue: DialogueBeat | null;
  choice: {
    id: string;
    title: string;
    options: readonly ChoiceDefinition[];
  } | null;
  ending: {
    id: "dominion" | "severance" | "living_pact";
    title: string;
    summary: string;
  } | null;
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
}
export type UIAction =
  | { type: "new-game"; runId: string }
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
      slot: "combat" | "utility" | "scout";
      companionId: CompanionId;
    }
  | {
      type: "issue-command";
      companionId: CompanionId;
      command: NonNullable<InputFrame["command"]>;
    }
  | { type: "use-ability"; abilityId: string; targetId?: ActorId }
  | { type: "choose"; choiceId: string; optionId: string }
  | { type: "travel"; regionId: RegionId; entranceId: string }
  | { type: "update-settings"; settings: Partial<GameSettings> }
  | { type: "remap"; device: keyof InputBindingMaps; actionId: string; binding: string }
  | { type: "skip-cinematic"; cinematicId: string };

export interface CampaignDirectorAPI {
  startNewRun(runId?: string): CampaignSnapshot;
  startShowcase(runId?: string): CampaignSnapshot;
  snapshot(): CampaignSnapshot;
  subscribe(listener: (snapshot: CampaignSnapshot) => void): () => void;
  processEvent(event: WorldEvent): Promise<CampaignSnapshot>;
  choose(choiceId: string, optionId: string): Promise<CampaignSnapshot>;
  selectParty(
    slot: "combat" | "utility" | "scout",
    companionId: CompanionId,
  ): CampaignSnapshot;
  acceptQuest(questId: QuestId): CampaignSnapshot;
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
