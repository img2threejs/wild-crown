import {
  createCheckpoint,
  createNewRun,
  createShowcaseReplay,
  collectFragment,
  evaluateEnding,
  importCheckpoint,
  recordLeaderDominion,
  REGION_IDS,
  REGIONAL_OBLIGATION_IDS,
  setCrownCouncilRepresentation,
  setPackLeader,
  type CampaignState,
  type CheckpointSnapshot,
  type FactionId,
  type FragmentId,
  type LeaderId,
  type RegionId as CanonRegionId,
  type RestorationState,
} from "../../../packages/campaign/src/index.js";
import type {
  CampaignDirectorAPI,
  ActorId,
  CampaignProgressCheckpoint,
  CampaignSafeCheckpoint,
  CampaignSafeSpawn,
  CampaignSnapshot,
  CompanionId,
  ObjectiveId,
  RegionId,
  RegionDefinition,
  WorldEvent,
} from "../contracts.js";
import {
  CAMPAIGN_CHOICES,
  CANONICAL_RESTORATION_FACT_IDS,
  INTERACTIONS,
  QUESTS,
  REGIONS,
  RESTORATION_PARTIAL_FACT_ID,
  RESTORATION_RESTORED_FACT_ID,
  RESTORATION_STATE_FACT_ID,
  RESTORATION_RANK,
  emptyWorldFacts,
  restorationStateFromFacts,
} from "../../content/campaign.js";
import { CHAPTERS } from "../../content/story.js";
import {
  SaveRepository,
  SaveRepositoryError,
  type CampaignProgressRecord,
} from "../storage/SaveRepository.js";

import { BOSS_ENCOUNTERS, WILDLIFE_ENCOUNTERS } from "../combat/content.js";

const ENCOUNTER_DEFINITIONS = [...Object.values(BOSS_ENCOUNTERS), ...Object.values(WILDLIFE_ENCOUNTERS)];

export interface CampaignDirectorOptions {
  saves?: SaveRepository;
  runId?: string;
}

/** An authored choice is permanently invalid, not a failed durable write to retry. */
export class CampaignChoiceRejectedError extends Error {
  constructor(
    readonly choiceId: string,
    readonly optionId: string,
    message: string,
  ) {
    super(message);
    this.name = "CampaignChoiceRejectedError";
  }
}

const REGION_CHAPTER: Partial<Record<RegionId, number>> = {
  greenwake: 0,
  "whispering-canopy": 1,
  "blood-bamboo-valley": 2,
  "moonpine-ridge": 3,
  "mistveil-basin": 4,
  "sunmane-expanse": 5,
  "the-grove": 6,
  refuge: 7,
  "heartroot-hollow": 8,
};
const LEADER_IDS: readonly LeaderId[] = [
  "koro",
  "asha",
  "ruun",
  "luma",
  "nyra",
  "solkar",
];

const createId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  "run-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);

function isCampaignEventHistory(value: unknown): boolean {
  return Array.isArray(value) && value.every((event) => {
    if (typeof event !== "object" || event === null || Array.isArray(event))
      return false;
    const entry = event as Record<string, unknown>;
    if (
      typeof entry.type !== "string" ||
      typeof entry.idempotencyKey !== "string"
    ) return false;
    if (entry.type !== "choice") return true;
    return (
      ["eventId", "idempotencyKey", "choiceId", "optionId"].every(
        (field) => typeof entry[field] === "string" &&
          (entry[field] as string).trim().length > 0,
      ) &&
      (entry.leaderId === undefined || typeof entry.leaderId === "string") &&
      (entry.dominion === undefined || typeof entry.dominion === "boolean")
    );
  });
}

function validateLoadedHistory(progress: CampaignProgressRecord | null): void {
  if (progress && !isCampaignEventHistory(progress.eventLog))
    throw new SaveRepositoryError("corrupt", "Campaign choice history is malformed.");
}

function isCampaignSafeCheckpoint(
  value: unknown,
): value is CampaignSafeCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  const progress = data.progress as Record<string, unknown> | null;
  const spawn = data.safeSpawn as Record<string, unknown> | null;
  const reset = data.encounterReset as Record<string, unknown> | null;
  if (
    data.kind !== "campaign-safe-checkpoint" ||
    data.schemaVersion !== 1 ||
    typeof data.runId !== "string" ||
    typeof data.checkpointId !== "string" ||
    !progress ||
    !spawn ||
    !reset
  )
    return false;
  return (
    Number.isInteger(progress.chapter) &&
    typeof progress.regionId === "string" &&
    Array.isArray(progress.activeQuestIds) &&
    progress.activeQuestIds.every((id) => typeof id === "string") &&
    Array.isArray(progress.completedQuestIds) &&
    progress.completedQuestIds.every((id) => typeof id === "string") &&
    Array.isArray(progress.completedObjectiveIds) &&
    progress.completedObjectiveIds.every((id) => typeof id === "string") &&
    isCampaignEventHistory(progress.eventLog) &&
    Array.isArray(progress.eventKeys) &&
    progress.eventKeys.every((key) => typeof key === "string") &&
    Number.isInteger(progress.revision) &&
    typeof spawn.regionId === "string" &&
    typeof spawn.routeId === "string" &&
    typeof spawn.cameraAnchorId === "string" &&
    typeof spawn.position === "object" &&
    typeof reset.policy === "string" &&
    (reset.encounterId === null || typeof reset.encounterId === "string") &&
    Array.isArray(reset.actorIds) &&
    reset.actorIds.every((id) => typeof id === "string")
  );
}

function eventMatches(requirement: string, event: WorldEvent): boolean {
  if (requirement.includes("|")) {
    return requirement
      .split("|")
      .some((alternative) => eventMatches(alternative, event));
  }
  const [kind, target, option] = requirement.split(":");
  switch (event.type) {
    case "semantic-interaction":
      return (
        (kind === "tend" &&
          event.kind === "tend" &&
          event.targetId === target) ||
        (kind === "semantic" &&
          (event.interactionId === target || event.targetId === target)) ||
        (kind === "interaction" && event.interactionId === target) ||
        (kind === "investigate" &&
          event.kind === "inspect" &&
          event.targetId === target) ||
        (kind === "ecology" &&
          ["repair", "restore", "cleanse", "coordinate", "break"].includes(
            event.kind,
          ) &&
          event.targetId === target) ||
        (kind === "coordinate" &&
          event.kind === "coordinate" &&
          event.targetId === target)
      );
    case "encounter-phase":
      return (
        kind === "encounter" &&
        event.phaseId === target &&
        event.state === "cleared"
      );
    case "encounter-resolved": {
      let expectedParticipants: readonly ActorId[] | undefined;
      if (target !== undefined) {
        for (const region of REGIONS) {
          expectedParticipants = region.encounterParticipants[target];
          if (expectedParticipants) break;
        }
      }
      return (
        kind === "encounter" &&
        event.encounterId === target &&
        (event.resolution === "cleansed" ||
          (target === "camp-hunters" && event.resolution === "subdued")) &&
        (!expectedParticipants ||
          expectedParticipants.every((actorId) => event.actorIds.includes(actorId)))
      );
    }
    case "rescue":
      return (
        (kind === "rescue" && event.targetId === target && event.safe) ||
        (kind === "tend" && event.targetId === target && event.safe)
      );
    case "restoration":
      return (
        kind === "restoration" &&
        event.regionId === target &&
        event.state === "restored"
      );
    case "fragment":
      return kind === "fragment" && event.fragmentId === target;
    case "choice":
      return (
        kind === "choice" &&
        event.choiceId === target &&
        (!option || event.optionId === option)
      );
    case "traversal":
      return kind === "traversal" && event.routeId === target;
    case "chapter-transition":
      return kind === "chapter" && event.toChapter === Number(target);
    default:
      return false;
  }
}

type AuthoredSurface = RegionDefinition["ground"]["surfaces"][number];
type AuthoredCollider = RegionDefinition["ground"]["colliders"][number];

function surfaceHeightAt(
  position: CampaignSafeSpawn["position"],
  surface: AuthoredSurface,
): number | undefined {
  const points = surface.points;
  if (!surface.walkable || points.length < 3) return undefined;

  let inside = false;
  for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
    const a = points[previous]!;
    const b = points[index]!;
    const cross = (position.x - a.x) * (b.z - a.z) - (position.z - a.z) * (b.x - a.x);
    if (Math.abs(cross) < 1e-5 &&
      position.x >= Math.min(a.x, b.x) - 1e-5 && position.x <= Math.max(a.x, b.x) + 1e-5 &&
      position.z >= Math.min(a.z, b.z) - 1e-5 && position.z <= Math.max(a.z, b.z) + 1e-5) {
      inside = true;
      break;
    }
    if ((a.z > position.z) !== (b.z > position.z) &&
      position.x < ((b.x - a.x) * (position.z - a.z)) / (b.z - a.z) + a.x) {
      inside = !inside;
    }
  }
  if (!inside) return undefined;

  const origin = points[0]!;
  for (let index = 1; index < points.length - 1; index += 1) {
    const b = points[index]!;
    const c = points[index + 1]!;
    const denominator = (b.x - origin.x) * (c.z - origin.z) - (c.x - origin.x) * (b.z - origin.z);
    if (Math.abs(denominator) < 1e-8) continue;
    const alongB = ((position.x - origin.x) * (c.z - origin.z) - (c.x - origin.x) * (position.z - origin.z)) / denominator;
    const alongC = ((b.x - origin.x) * (position.z - origin.z) - (position.x - origin.x) * (b.z - origin.z)) / denominator;
    const alongOrigin = 1 - alongB - alongC;
    if (alongB >= -1e-4 && alongC >= -1e-4 && alongOrigin >= -1e-4) {
      return alongOrigin * origin.y + alongB * b.y + alongC * c.y;
    }
  }
  return undefined;
}

function colliderContainsSpawnPoint(
  position: CampaignSafeSpawn["position"],
  collider: AuthoredCollider,
): boolean {
  if (collider.kind === "box") {
    const half = collider.halfExtents;
    return !!half &&
      Math.abs(position.x - collider.from.x) < half.x &&
      Math.abs(position.y - collider.from.y) < half.y &&
      Math.abs(position.z - collider.from.z) < half.z;
  }
  if (collider.radius === undefined) return false;
  const end = collider.to ?? collider.from;
  const delta = { x: end.x - collider.from.x, y: end.y - collider.from.y, z: end.z - collider.from.z };
  const lengthSquared = delta.x * delta.x + delta.y * delta.y + delta.z * delta.z;
  const along = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, (
    (position.x - collider.from.x) * delta.x +
    (position.y - collider.from.y) * delta.y +
    (position.z - collider.from.z) * delta.z
  ) / lengthSquared));
  const x = collider.from.x + along * delta.x - position.x;
  const y = collider.from.y + along * delta.y - position.y;
  const z = collider.from.z + along * delta.z - position.z;
  return x * x + y * y + z * z < collider.radius * collider.radius;
}

function hasSafeWalkSurface(
  region: RegionDefinition,
  position: CampaignSafeSpawn["position"],
): boolean {
  for (const surface of region.ground.surfaces) {
    const elevation = surfaceHeightAt(position, surface);
    if (elevation === undefined || Math.abs(position.y - elevation) > 0.35) continue;
    const obstructed = region.ground.colliders.some((collider) =>
      collider.id !== surface.colliderId &&
      (collider.blocksMovement || collider.blocksCamera) &&
      colliderContainsSpawnPoint(position, collider),
    );
    if (!obstructed) return true;
  }
  return false;
}

function samePosition(
  first: CampaignSafeSpawn["position"],
  second: CampaignSafeSpawn["position"],
): boolean {
  return first.x === second.x && first.y === second.y && first.z === second.z;
}

function liesOnSurface(
  region: RegionDefinition,
  position: CampaignSafeSpawn["position"],
  surfaceId: string,
): boolean {
  const surface = region.ground.surfaces.find((item) => item.id === surfaceId);
  const height = surface && surfaceHeightAt(position, surface);
  return height !== undefined && Math.abs(position.y - height) <= 0.35;
}
function factsWithMovableObjectDefaults(
  facts: Readonly<Record<string, boolean | number | string>>,
): Record<string, boolean | number | string> {
  const restored = { ...facts };
  for (const region of REGIONS) {
    for (const object of region.movableObjects) {
      if (restored[object.movedFactId] === undefined) restored[object.movedFactId] = false;
    }
  }
  return restored;
}

function factsWithRestorationDefaults(
  facts: Readonly<Record<string, boolean | number | string>>,
): Record<string, boolean | number | string> {
  const restored = factsWithMovableObjectDefaults(facts);
  for (const region of REGIONS) {
    const stateId = RESTORATION_STATE_FACT_ID(region.id);
    const partialId = RESTORATION_PARTIAL_FACT_ID(region.id);
    const restoredId = RESTORATION_RESTORED_FACT_ID(region.id);
    if (restored[stateId] === undefined) {
      // Legacy local-state migration: when a noncanonical region lacks the
      // explicit state fact, derive it from the persisted partial/restored
      // booleans BEFORE defaulting to "unvisited". An explicit valid state
      // fact already written by a newer envelope remains authoritative.
      const isNoncanonical = !REGION_IDS.includes(region.id as CanonRegionId);
      if (isNoncanonical && restored[restoredId] === true) {
        restored[stateId] = "restored";
      } else if (isNoncanonical && restored[partialId] === true) {
        restored[stateId] = "partial";
      } else {
        restored[stateId] = "unvisited";
      }
    }
    if (restored[partialId] === undefined) restored[partialId] = false;
    if (restored[restoredId] === undefined) restored[restoredId] = false;
  }
  return restored;
}

/**
 * Resolves the effective restoration state for any authored region. Canonical
 * regions always come from `campaign.world.regions`; noncanonical regions read
 * the persisted local fact (and fall back to booleans for legacy envelopes).
 */
function effectiveRestorationState(
  campaign: CampaignState,
  facts: Readonly<Record<string, boolean | number | string>>,
  region: RegionId,
): RestorationState {
  if (REGION_IDS.includes(region as CanonRegionId)) {
    return campaign.world.regions[region as CanonRegionId];
  }
  return restorationStateFromFacts(facts, region);
}

function applyRestorationBooleans(
  facts: Record<string, boolean | number | string>,
  region: RegionId,
  state: RestorationState,
): void {
  facts[RESTORATION_STATE_FACT_ID(region)] = state;
  facts[RESTORATION_PARTIAL_FACT_ID(region)] = state === "partial";
  facts[RESTORATION_RESTORED_FACT_ID(region)] = state === "restored";
}

/**
 * Reconciles canonical restoration facts and local-region booleans against
 * `campaign.world.regions`. Canonical regions are authoritative; noncanonical
 * regions keep the persisted state fact (or fall back to "unvisited" for
 * legacy envelopes that only carry booleans). The supplied owned facts map
 * is mutated in place; callers should already own it.
 */
function normalizeRestorationFacts(
  campaign: CampaignState,
  facts: Record<string, boolean | number | string>,
): void {
  for (const regionId of REGION_IDS) {
    const canonical = campaign.world.regions[regionId];
    facts[RESTORATION_STATE_FACT_ID(regionId)] = canonical;
    facts[RESTORATION_PARTIAL_FACT_ID(regionId)] = canonical === "partial";
    facts[RESTORATION_RESTORED_FACT_ID(regionId)] = canonical === "restored";
    facts[CANONICAL_RESTORATION_FACT_IDS[regionId]] = canonical === "restored";
  }
  for (const region of REGIONS) {
    if (REGION_IDS.includes(region.id as CanonRegionId)) continue;
    const state = restorationStateFromFacts(facts, region.id);
    facts[RESTORATION_STATE_FACT_ID(region.id)] = state;
    facts[RESTORATION_PARTIAL_FACT_ID(region.id)] = state === "partial";
    facts[RESTORATION_RESTORED_FACT_ID(region.id)] = state === "restored";
  }
}

interface DirectorRollbackState {
  campaign: CampaignState;
  region: RegionId;
  chapter: number;
  facts: Record<string, boolean | number | string>;
  choices: Record<string, string>;
  activeQuestIds: string[];
  completedQuestIds: string[];
  completedObjectiveIds: string[];
  trackedObjectiveId: ObjectiveId | null;
  party: { combat?: CompanionId; utility?: CompanionId; scout: "vara" };
  endingId: CampaignSnapshot["ending"];
  checkpoint: CheckpointSnapshot | null;
  lastSafeCheckpoint: CampaignSafeCheckpoint | null;
  safeSpawn: CampaignSafeSpawn;
  recoveryRequest: CampaignSnapshot["recoveryRequest"];
  lastEvent: WorldEvent | null;
  eventKeys: Set<string>;
  eventLog: WorldEvent[];
  revision: number;
}
export class CampaignDirector implements CampaignDirectorAPI {
  private campaign: CampaignState;
  private runId: string;
  private region: RegionId = "greenwake";
  private chapter = 0;
  private replay = false;
  private revision = 0;
  private facts: Record<string, boolean | number | string>;
  private choices: Record<string, string> = {};
  private activeQuestIds: string[] = [];
  private completedQuestIds: string[] = [];
  private completedObjectiveIds: string[] = [];
  private trackedObjectiveId: ObjectiveId | null = null;
  private recoveryRequest: CampaignSnapshot["recoveryRequest"] = null;
  private lastEvent: WorldEvent | null = null;
  private party: {
    combat?: CompanionId;
    utility?: CompanionId;
    scout: "vara";
  } = { scout: "vara" };
  private endingId: CampaignSnapshot["ending"] = null;
  private checkpoint: CheckpointSnapshot | null = null;
  private lastSafeCheckpoint: CampaignSafeCheckpoint | null = null;
  private safeSpawn!: CampaignSafeSpawn;
  private eventQueue: Promise<void> = Promise.resolve();
  private eventKeys = new Set<string>();
  private eventLog: WorldEvent[] = [];
  private listeners = new Set<(snapshot: CampaignSnapshot) => void>();
  private readonly saves?: SaveRepository;
  constructor(options: CampaignDirectorOptions = {}) {
    this.runId = options.runId ?? createId();
    this.campaign = createNewRun(this.runId);
    this.facts = emptyWorldFacts(this.campaign);
    this.facts.prologueStarted = true;
    this.saves = options.saves;
    this.activeQuestIds = ["prologue"];
    this.checkpoint = createCheckpoint(this.campaign);
    this.safeSpawn = this.safeSpawnFor("greenwake");
    this.lastSafeCheckpoint = this.createSafeCheckpoint();
  }

  startNewRun(runId = createId()): CampaignSnapshot {
    this.runId = runId;
    this.campaign = createNewRun(runId);
    this.region = "greenwake";
    this.chapter = 0;
    this.replay = false;
    this.revision = 0;
    this.facts = emptyWorldFacts(this.campaign);
    this.facts.prologueStarted = true;
    this.choices = {};
    this.activeQuestIds = ["prologue"];
    this.completedQuestIds = [];
    this.completedObjectiveIds = [];
    this.trackedObjectiveId = null;
    this.recoveryRequest = null;
    this.party = { scout: "vara" };
    this.endingId = null;
    this.eventKeys.clear();
    this.eventLog = [];
    this.checkpoint = createCheckpoint(this.campaign);
    this.safeSpawn = this.safeSpawnFor("greenwake");
    this.lastSafeCheckpoint = this.createSafeCheckpoint();
    return this.publish();
  }

  startShowcase(runId = "showcase-" + createId()): CampaignSnapshot {
    const replayState = createShowcaseReplay();
    this.runId = runId;
    this.campaign = { ...createNewRun(runId), world: replayState.world };
    this.region = "whispering-canopy";
    this.chapter = 1;
    this.replay = true;
    this.revision = 0;
    this.facts = emptyWorldFacts(this.campaign);
    this.facts.provisionalKoro = true;
    this.activeQuestIds = ["fallen-scout", "thief-in-the-branches"];
    this.completedQuestIds = [];
    this.completedObjectiveIds = [];
    this.trackedObjectiveId = null;
    this.recoveryRequest = null;
    this.party = { scout: "vara", utility: "koro" };
    this.endingId = null;
    this.eventKeys.clear();
    this.eventLog = [];
    this.checkpoint = createCheckpoint(this.campaign);
    this.safeSpawn = this.safeSpawnFor("whispering-canopy");
    this.lastSafeCheckpoint = this.createSafeCheckpoint();
    return this.publish();
  }

  snapshot(): CampaignSnapshot {
    return {
      lastEvent: this.lastEvent ? structuredClone(this.lastEvent) : null,
      recoveryRequest: this.recoveryRequest,
      trackedObjectiveId: this.trackedObjectiveId,
      schemaVersion: this.campaign.schemaVersion,
      runId: this.runId,
      replay: this.replay,
      chapter: this.chapter,
      chapterId: this.chapter === 0 ? "prologue" : "chapter-" + this.chapter,
      regionId: this.region,
      activeQuestIds: [...this.activeQuestIds] as never,
      completedQuestIds: [...this.completedQuestIds] as never,
      activeObjectiveIds: this.activeQuestIds.flatMap((id) =>
        this.objectivesFor(id)
          .filter(
            (objective) => !this.completedObjectiveIds.includes(objective.id),
          )
          .map((objective) => objective.id),
      ),
      completedObjectiveIds: [...this.completedObjectiveIds] as never,
      campaign: structuredClone(this.campaign),
      fragments: [...this.campaign.world.fragments],
      factions: structuredClone(this.campaign.world.factions),
      party: structuredClone(this.party),
      worldFacts: structuredClone(this.facts),
      lastSafeCheckpoint: this.lastSafeCheckpoint
        ? structuredClone(this.lastSafeCheckpoint)
        : null,
      choices: structuredClone(this.choices),
      ending: this.endingId,
      endingEvaluation: evaluateEnding(this.campaign),
      revision: this.revision,
    };
  }

  subscribe(listener: (snapshot: CampaignSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  processEvent(event: WorldEvent): Promise<CampaignSnapshot> {
    const operation = this.eventQueue.then(() => this.applyWorldEvent(event));
    this.eventQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  /** Query the current accepted event ledger without copying checkpoint metadata. */
  isEventCommitted(idempotencyKey: string): boolean {
    return this.eventKeys.has(idempotencyKey);
  }

  private async applyWorldEvent(event: WorldEvent): Promise<CampaignSnapshot> {
    if (!event.idempotencyKey.trim())
      throw new Error("World event requires a non-empty idempotencyKey.");
    if (
      event.type === "choice" &&
      this.validateChoice(event.choiceId, event.optionId, this.campaign)
    ) return this.snapshot();
    if (this.eventKeys.has(event.idempotencyKey)) return this.snapshot();
    const rollback = this.rollbackState();
    let nextCampaign = structuredClone(this.campaign);
    const nextFacts = { ...this.facts };
    const nextChoices = { ...this.choices };
    let nextRegion = this.region;
    let nextChapter = this.chapter;
    let nextEnding = this.endingId;
    const nextParty = { ...this.party };
    let nextSafeSpawn = this.safeSpawn;
    let nextRecoveryRequest = this.recoveryRequest;
    switch (event.type) {
      case "object-moved": {
        const region = REGIONS.find((item) => item.id === event.regionId);
        const movable = region?.movableObjects.find((item) => item.id === event.objectId);
        const propPlacements = region?.props.filter((item) => item.id === event.objectId) ?? [];
        if (!region || event.regionId !== this.region || !movable || propPlacements.length !== 1) {
          throw new Error("Moved object event is not registered in the active region.");
        }
        const prop = propPlacements[0]!;
        if (prop.assetId !== movable.assetId || !samePosition(prop.position, movable.from)) {
          throw new Error("Moved object event does not match its canonical prop placement.");
        }
        if (!samePosition(event.from, movable.from) || !samePosition(event.to, movable.to)) {
          throw new Error("Moved object event does not match its authored endpoints.");
        }
        if (
          !Number.isFinite(movable.radiusMeters) || movable.radiusMeters <= 0 ||
          !Number.isInteger(movable.animationTicks) || movable.animationTicks <= 0 ||
          !liesOnSurface(region, event.from, movable.supportSurfaceId) ||
          !liesOnSurface(region, event.to, movable.supportSurfaceId)
        ) {
          throw new Error("Moved object endpoints are outside their authored support surface.");
        }
        if (nextFacts[movable.movedFactId] === true) {
          throw new Error("This authored object has already been moved.");
        }
        if (movable.requiredFacts.some((fact) => nextFacts[fact] !== true)) {
          throw new Error("Moved object prerequisites are not met.");
        }
        const interaction = INTERACTIONS.find((item) => item.id === event.interactionId);
        const objectMove = interaction?.success.type === "object-move" &&
          interaction.success.objectId === movable.id;
        if (
          !interaction || interaction.regionId !== region.id || interaction.targetId !== movable.id ||
          interaction.kind !== "move-object" || !objectMove || interaction.repeatable ||
          [...interaction.requiresFacts, ...movable.requiredFacts].some((fact) => nextFacts[fact] !== true)
        ) {
          throw new Error("Moved object event does not match an available authored interaction.");
        }
        if (event.interactionId === movable.koroInteractionId) {
          const actor = region.entities.find((entity) => entity.id === event.actorId);
          const command = interaction.requiresCompanionCommand;
          if (
            !command || command.companionId !== movable.requiredCompanionId ||
            command.slot !== "utility" || command.command !== "special" ||
            !interaction.requiresActors.includes(movable.requiredCompanionId) ||
            interaction.inputHint !== "ability" ||
            this.party.utility !== movable.requiredCompanionId ||
            actor?.kind !== "actor" || actor.actorId !== movable.requiredCompanionId
          ) {
            throw new Error("Moved object event requires the assigned utility companion special.");
          }
        } else if (event.interactionId === movable.playerInteractionId) {
          if (
            interaction.playerActionId !== "staff-heavy" ||
            interaction.inputHint !== "heavy" ||
            interaction.activation !== "press-release" ||
            event.actorId !== "aren" ||
            this.party.combat === movable.requiredCompanionId ||
            this.party.utility === movable.requiredCompanionId
          ) {
            throw new Error("Moved object fallback requires an absent Koro and the staff-heavy player action.");
          }
        } else {
          throw new Error("Moved object event uses an unauthorized interaction.");
        }
        if (this.eventLog.some((prior) => prior.type === "object-moved" && prior.objectId === movable.id)) {
          throw new Error("This authored object already has a committed move event.");
        }
        nextFacts[movable.movedFactId] = true;
        break;
      }
      case "semantic-interaction":
        nextFacts["interaction:" + event.interactionId] = true;
        if (
          event.interactionId === "nyra-reveal-hidden-route" &&
          event.actorId === "nyra" &&
          event.kind === "signal" &&
          event.targetId === "mistveil-hidden-route"
        ) {
          nextFacts.mistveil_nyra_hidden_route = true;
        }
        if (
          this.chapter === 6 &&
          event.interactionId === "warden-call" &&
          event.actorId === "aren" &&
          event.kind === "signal" &&
          event.targetId === "warden-call"
        ) {
          nextFacts.wardenCall = true;
          nextFacts.askSignal = false;
        }
        break;
      case "encounter-phase":
        nextFacts[
          "encounterPhase:" +
            event.encounterId +
            ":" +
            event.phaseIndex +
            ":" +
            event.state
        ] = true;
        break;
      case "possession":
        nextFacts[
          "possession:" +
            event.actorId +
            ":" +
            event.phaseId +
            ":" +
            event.state
        ] = true;
        break;
      case "encounter-resolved":
        if (event.resolution === "dominated") {
          for (const actorId of event.actorIds) {
            if (LEADER_IDS.includes(actorId as LeaderId)) {
              nextCampaign = recordLeaderDominion(
                nextCampaign,
                actorId as LeaderId,
              );
            }
          }
        }
        if (event.resolution === "cleansed") {
          if (event.encounterId === "encounter-orun") {
            if (eventMatches("encounter:encounter-orun", event)) {
              nextFacts["orun-cleansed"] = true;
              nextCampaign.world.hollowReady = true;
            }
          } else {
            nextFacts[event.encounterId + "-cleansed"] = true;
          }
        }
        break;
      case "rescue":
        nextFacts["rescued:" + event.targetId] = event.safe;
        if (event.targetId === "tali" && event.safe) {
          nextFacts.bamboo_tali_safe = true;
          nextFacts.taliSafe = true;
          nextFacts.taliNeedsRescue = false;
          nextFacts.taliCageOpen = true;
          if (event.locationId === "the-grove") {
            nextFacts.taliInBamboo = false;
            nextFacts.taliInGrove = true;
          }
        }
        if (
          event.targetId === "tali" &&
          !event.safe &&
          this.lastSafeCheckpoint
        ) {
          nextRecoveryRequest = {
            kind: "restart-checkpoint",
            reason: "tali-safety",
            checkpointId: this.lastSafeCheckpoint.checkpointId,
          };
        }
        break;
      case "restoration": {
        const eventRegion = event.regionId as RegionId;
        const authoredRegion = REGIONS.some((region) => region.id === eventRegion);
        if (!authoredRegion) break;
        const prior = effectiveRestorationState(nextCampaign, nextFacts, eventRegion);
        if (RESTORATION_RANK[event.state] < RESTORATION_RANK[prior]) break;
        if (REGION_IDS.includes(eventRegion as CanonRegionId)) {
          const domainCanon = eventRegion as CanonRegionId;
          nextCampaign = {
            ...nextCampaign,
            world: {
              ...nextCampaign.world,
              regions: {
                ...nextCampaign.world.regions,
                [domainCanon]: event.state,
              },
            },
          };
        }
        applyRestorationBooleans(nextFacts, eventRegion, event.state);
        for (const region of REGIONS) {
          const state = effectiveRestorationState(nextCampaign, nextFacts, region.id);
          applyRestorationBooleans(nextFacts, region.id, state);
        }
        if (REGION_IDS.includes(eventRegion as CanonRegionId)) {
          nextFacts[CANONICAL_RESTORATION_FACT_IDS[eventRegion as CanonRegionId]] =
            event.state === "restored";
        }
        break;
      }
      case "fragment":
        nextCampaign = collectFragment(nextCampaign, event.fragmentId);
        break;
      case "choice": {
        nextChoices[event.choiceId] = event.optionId;
        // Authored choice and domain identity own history, never producer labels.
        const leaderId = event.choiceId === "sunmane-resolution"
          ? nextCampaign.world.factions.crown.leaderId ?? undefined
          : event.choiceId === "pack-leadership"
            ? event.optionId.endsWith("luma") ? "luma" : "ruun"
            : undefined;
        if (event.optionId.includes("dominion") && leaderId) {
          nextCampaign = recordLeaderDominion(nextCampaign, leaderId);
          nextFacts["dominion:" + leaderId] = true;
        }
        nextCampaign = this.applyChoice(
          nextCampaign,
          event.choiceId,
          event.optionId,
          leaderId,
          nextFacts,
        );
        if (nextCampaign.world.factions.crown.leaderStatus === "exiled") {
          nextFacts.solkarPresent = false;
          nextFacts["solkar-exiled"] = true;
          nextFacts.crownCouncilAvailable = true;
          if (nextParty.combat === "solkar") delete nextParty.combat;
          if (nextParty.utility === "solkar") delete nextParty.utility;
        }
        if (event.choiceId === "final-ending") {
          // validateChoice already checked the encounter and package predicate.
          if (
            event.optionId === "dominion" ||
            event.optionId === "severance" ||
            event.optionId === "living_pact"
          ) {
            nextEnding = event.optionId;
          }
        }
        break;
      }
      case "traversal": {
        const targetRegion = REGIONS.find(
          (region) => region.id === event.toRegion,
        );
        const targetEntrance = targetRegion?.entrances.find(
          (route) =>
            route.traversalEvent === event.routeId &&
            route.destinationRegionId === event.toRegion &&
            route.id === event.landmarkId,
        );
        const sourceRegion = REGIONS.find(
          (region) => region.id === event.fromRegion,
        );
        const sourceExit = sourceRegion?.exits.find(
          (route) =>
            route.destinationRegionId === event.toRegion &&
            route.traversalEvent === event.routeId,
        );
        if (
          event.fromRegion !== this.region ||
          !targetEntrance ||
          !sourceExit
        ) {
          throw new Error(
            "Traversal event does not match an authored region route.",
          );
        }
        nextRegion = event.toRegion;
        nextFacts["visited:" + event.toRegion] = true;
        if (
          event.toRegion === "the-grove" &&
          nextFacts.taliSafe === true &&
          this.completedQuestIds.includes("a-mothers-roar")
        ) {
          nextFacts.taliInBamboo = false;
          nextFacts.taliInGrove = true;
        }
        nextSafeSpawn = this.safeSpawnFor(event.toRegion, event.landmarkId);
        break;
      }
      case "chapter-transition":
        if (event.toChapter !== nextChapter + 1 || event.toChapter > 8) {
          throw new Error("Invalid campaign chapter transition.");
        }
        if (
          event.toChapter === 1 &&
          !this.completedQuestIds.includes("prologue")
        ) {
          throw new Error("The prologue must be completed before Chapter 1.");
        }
        if (
          event.toChapter > 1 &&
          QUESTS.some(
            (quest) =>
              !quest.optional &&
              quest.chapter > 0 &&
              quest.chapter < event.toChapter &&
              !this.completedQuestIds.includes(quest.id),
          )
        ) {
          throw new Error(
            "Required quests from the previous chapter must be completed before transition.",
          );
        }
        nextChapter = event.toChapter;
        nextFacts.chapter = nextChapter;
        if (nextChapter === 6) {
          nextFacts.wardenCall = false;
          nextFacts.askSignal = false;
          nextFacts.refugeOpen = true;
        }
        if (nextChapter === 8) {
          nextRegion = "heartroot-hollow";
          nextSafeSpawn = this.safeSpawnFor("heartroot-hollow");
        }
        break;
    }
    const nextKeys = new Set(this.eventKeys);
    nextKeys.add(event.idempotencyKey);
    const nextEventLog = [...this.eventLog, cloneEvent(event)];
    const dominionDelta = nextCampaign.dominionHistory.filter(
      (item) =>
        !this.campaign.dominionHistory.some(
          (prior) =>
            prior.sequence === item.sequence &&
            prior.leaderId === item.leaderId,
        ),
    );
    this.campaign = {
      ...nextCampaign,
      dominionHistory: mergeHistory(
        this.campaign.dominionHistory,
        nextCampaign.dominionHistory,
      ),
    };
    const completedObjectives = [...this.completedObjectiveIds];
    for (const questId of this.activeQuestIds) {
      for (const objective of this.objectivesFor(questId)) {
        if (
          !completedObjectives.includes(objective.id) &&
          objective.requiredEvents.every((requirement) =>
            nextEventLog.some((prior) => eventMatches(requirement, prior)),
          )
        ) {
          completedObjectives.push(objective.id);
        }
      }
    }
    this.facts = nextFacts;
    this.choices = nextChoices;
    this.region = nextRegion;
    this.chapter = nextChapter;
    this.completedObjectiveIds = completedObjectives;
    this.endingId = nextEnding;
    this.party = nextParty;
    this.eventKeys = nextKeys;
    this.eventLog = nextEventLog;
    this.recoveryRequest = nextRecoveryRequest;
    this.safeSpawn = nextSafeSpawn;
    this.updateQuestProgress();
    if (event.type === "chapter-transition")
      this.ensureChapterQuest(nextChapter);
    normalizeRestorationFacts(this.campaign, this.facts);
    this.revision += 1;
    const checkpointEvent =
      event.type === "object-moved" ||
      event.type === "chapter-transition" ||
      event.type === "restoration" ||
      event.type === "choice" ||
      event.type === "traversal" ||
      (event.type === "rescue" && event.safe) ||
      (event.type === "encounter-resolved" && event.resolution !== "escaped");
    if (checkpointEvent) {
      this.checkpoint = createCheckpoint(this.campaign);
      this.lastSafeCheckpoint = this.createSafeCheckpoint();
    }

    try {
      await this.saves?.appendRunLedger(
        this.runId,
        dominionDelta,
        [event.idempotencyKey],
        this.replay ? "showcase-replay" : "campaign",
      );
    } catch (error) {
      this.restoreRollbackState(rollback);
      if (error instanceof SaveRepositoryError) throw error;
      throw new SaveRepositoryError(
        "transaction",
        "The story event could not be committed to the run ledger.",
      );
    }
    this.lastEvent = structuredClone(event);
    return this.publish();
  }

  choose(choiceId: string, optionId: string): Promise<CampaignSnapshot> {
    return this.processEvent({
      type: "choice",
      eventId: createId(),
      idempotencyKey: "choice:" + choiceId + ":" + optionId,
      choiceId,
      optionId,
    });
  }

  trackObjective(objectiveId: ObjectiveId | null): CampaignSnapshot {
    if (
      objectiveId &&
      !this.snapshot().activeObjectiveIds.includes(objectiveId)
    ) {
      throw new Error("Only an active objective can be tracked.");
    }
    this.trackedObjectiveId = objectiveId;
    this.revision += 1;
    return this.publish();
  }

  acceptQuest(questId: import("../contracts.js").QuestId): CampaignSnapshot {
    const quest = QUESTS.find((item) => item.id === questId);
    if (!quest || !quest.optional)
      throw new Error("Only authored optional quests can be accepted.");
    if (quest.chapter > this.chapter)
      throw new Error("This quest is not unlocked yet.");
    for (const requirement of quest.prerequisites) {
      if (
        requirement.startsWith("region:") &&
        this.region !== requirement.slice(7) &&
        !this.facts["visited:" + requirement.slice(7)]
      ) {
        throw new Error("Travel to this region before accepting its quest.");
      }
      if (
        requirement.startsWith("quest:") &&
        !this.completedQuestIds.includes(requirement.slice(6))
      ) {
        throw new Error("A prerequisite quest is incomplete.");
      }
    }
    if (
      !this.activeQuestIds.includes(quest.id) &&
      !this.completedQuestIds.includes(quest.id)
    ) {
      this.activeQuestIds.push(quest.id);
    }
    this.revision += 1;
    return this.publish();
  }
  selectParty(
    slot: "combat" | "utility" | "scout",
    companionId: CompanionId,
  ): CampaignSnapshot {
    if (slot === "scout" && companionId !== "vara")
      throw new Error("Vara is the only scout companion.");
    if (slot !== "scout" && companionId === "vara")
      throw new Error("Vara occupies the aerial scout role.");
    if (
      companionId === "solkar" &&
      (this.campaign.world.factions.crown.leaderStatus === "exiled" ||
        this.choices["sunmane-resolution"] !== "bond")
    ) {
      throw new Error(
        "Solkar is selectable only after the voluntary alliance and cannot return after exile.",
      );
    }
    const fragmentByCompanion: Record<CompanionId, FragmentId> = {
      vara: "heartroot-sky",
      koro: "heartroot-canopy",
      asha: "heartroot-fang",
      sable: "heartroot-pack",
      nyra: "heartroot-shadow",
      solkar: "heartroot-crown",
    };
    if (
      !this.campaign.world.fragments.includes(fragmentByCompanion[companionId])
    ) {
      throw new Error(
        "This companion is not unlocked in the current campaign.",
      );
    }
    const party = { ...this.party };
    if (slot === "scout") {
      party.scout = "vara";
    } else if (slot === "combat") {
      if (party.utility === companionId)
        throw new Error("A companion cannot occupy both ground-party slots.");
      party.combat = companionId;
    } else {
      if (party.combat === companionId)
        throw new Error("A companion cannot occupy both ground-party slots.");
      party.utility = companionId;
    }
    this.party = party;
    return this.publish();
  }

  async travel(
    regionId: RegionId,
    entranceId: string,
  ): Promise<CampaignSnapshot> {
    const chapter = REGION_CHAPTER[regionId];
    if (chapter === undefined) throw new Error("Unknown campaign region.");
    if (regionId === "heartroot-hollow" && this.chapter < 8)
      throw new Error("Heartroot Hollow is not accessible before Chapter 8.");
    if (
      regionId === "refuge" &&
      (this.chapter < 6 || this.facts.refugeOpen !== true)
    ) {
      throw new Error("The Refuge does not open before the Fall of the Grove.");
    }
    const refugeOpenOnFall =
      regionId === "refuge" && this.chapter === 6 && this.facts.refugeOpen === true;
    if (chapter > this.chapter && regionId !== "the-grove" && !refugeOpenOnFall)
      throw new Error(
        "This region has not been unlocked by campaign progression.",
      );
    const target = REGIONS.find((item) => item.id === regionId);
    const entrance = target?.entrances.find(
      (route) =>
        route.id === entranceId && route.destinationRegionId === regionId,
    );
    const source = REGIONS.find((item) => item.id === this.region);
    const exit = source?.exits.find(
      (route) =>
        route.destinationRegionId === regionId &&
        route.traversalEvent === entrance?.traversalEvent,
    );
    if (!entrance || !exit)
      throw new Error(
        "The selected route is not an authored connection from the current region.",
      );
    if (entrance.unlockFact && this.facts[entrance.unlockFact] !== true) {
      throw new Error("The selected route has not been discovered.");
    }
    return this.processEvent({
      type: "traversal",
      eventId: createId(),
      idempotencyKey:
        "travel:" + this.region + ":" + regionId + ":" + entrance.id,
      routeId: entrance.traversalEvent,
      fromRegion: this.region,
      toRegion: regionId,
      landmarkId: entrance.id,
    });
  }

  async captureCheckpoint(): Promise<CampaignSafeCheckpoint> {
    if (this.replay)
      throw new Error("Replay data cannot be saved as a campaign checkpoint.");
    this.checkpoint = createCheckpoint(this.campaign);
    this.lastSafeCheckpoint = this.createSafeCheckpoint();
    return structuredClone(this.lastSafeCheckpoint);
  }

  async restoreCheckpoint(input: unknown): Promise<boolean> {
    if (
      this.replay ||
      !isCampaignSafeCheckpoint(input) ||
      input.runId !== this.runId ||
      input.worldCheckpoint.runId !== this.runId
    ) {
      return false;
    }
    const runHistory = this.campaign.dominionHistory;
    const imported = importCheckpoint(this.campaign, input.worldCheckpoint);
    if (imported.accepted === false) return false;
    this.campaign = {
      ...imported.state,
      dominionHistory: mergeHistory(runHistory, imported.state.dominionHistory),
    };
    this.restoreProgress(input.progress);
    this.safeSpawn = structuredClone(input.safeSpawn);
    this.checkpoint = createCheckpoint(this.campaign);
    this.lastSafeCheckpoint = structuredClone(input);
    this.recoveryRequest = null;
    this.publish();
    return true;
  }

  ending() {
    return evaluateEnding(this.campaign);
  }

  async save(slotId: string, label: string): Promise<void> {
    if (!this.saves)
      throw new SaveRepositoryError(
        "unavailable",
        "No SaveRepository was configured.",
      );
    if (this.replay) {
      throw new SaveRepositoryError("replay-isolated", "Replay data cannot be saved as a campaign checkpoint.");
    }
    const safe = this.createSafeCheckpoint();
    const campaign = this.campaign;
    const party = this.party;
    const recoveryCheckpoint = this.lastSafeCheckpoint;
    await this.saves.saveCheckpoint(
      slotId,
      label,
      safe.worldCheckpoint,
      campaign,
      safe.progress.chapter,
      safe.progress.regionId,
      safe.progress.eventKeys,
      "campaign",
      this.progressRecord(),
    );
    // Party selection and checkpoint capture can leave the campaign/revision unchanged.
    // Compare owned object identities, not the revision-derived checkpoint ID.
    if (
      this.campaign === campaign &&
      this.revision === safe.progress.revision &&
      this.party === party &&
      this.lastSafeCheckpoint === recoveryCheckpoint &&
      !this.replay
    ) {
      this.checkpoint = safe.worldCheckpoint;
      this.lastSafeCheckpoint = safe;
    }
  }

  async saveNewSlot(label: string): Promise<string> {
    if (!this.saves)
      throw new SaveRepositoryError(
        "unavailable",
        "No SaveRepository was configured.",
      );
    const slotId = "slot-" + createId();
    await this.save(slotId, label);
    return slotId;
  }

  async exportSave(slotId: string): Promise<string> {
    if (!this.saves)
      throw new SaveRepositoryError(
        "unavailable",
        "No SaveRepository was configured.",
      );
    return this.saves.exportSlot(slotId);
  }

  async importSave(
    input: string,
    slotId: string,
    label: string,
  ): Promise<CampaignSnapshot> {
    if (!this.saves)
      throw new SaveRepositoryError(
        "unavailable",
        "No SaveRepository was configured.",
      );
    // A showcase identity may be caller-supplied; even an equal ID cannot make
    // its transient history authoritative campaign history.
    const current = this.replay ? createNewRun(this.runId) : this.campaign;
    const imported = await this.saves.importSave(input, current);
    const progress = imported.envelope.progress;
    validateLoadedHistory(progress ?? null);
    await this.saves.commitImported(
      slotId,
      label,
      imported.envelope,
      progress?.chapter ?? 0,
      progress?.regionId ?? "greenwake",
    );
    const loaded = await this.saves.loadCampaign(slotId, current);
    this.applyLoadedState(
      loaded.campaign,
      loaded.checkpoint,
      loaded.eventKeys,
      loaded.progress,
      loaded.chapter,
      loaded.regionId,
    );
    return this.publish();
  }

  async load(slotId: string): Promise<CampaignSnapshot> {
    if (!this.saves)
      throw new SaveRepositoryError(
        "unavailable",
        "No SaveRepository was configured.",
      );
    const loaded = await this.saves.loadCampaign(
      slotId,
      this.replay ? createNewRun(this.runId) : this.campaign,
    );
    this.applyLoadedState(
      loaded.campaign,
      loaded.checkpoint,
      loaded.eventKeys,
      loaded.progress,
      loaded.chapter,
      loaded.regionId,
    );
    return this.publish();
  }

  private applyLoadedState(
    campaign: CampaignState,
    checkpoint: CheckpointSnapshot,
    eventKeys: readonly string[],
    progress: CampaignProgressRecord | null,
    fallbackChapter: number,
    fallbackRegionId: string,
  ): void {
    validateLoadedHistory(progress);
    // Validate legacy metadata and resolve an authored fallback before replacing
    // any live state; a rejected load must leave the current journey intact.
    const fallbackRegion = REGIONS.find((item) => item.id === fallbackRegionId);
    if (!progress && (!fallbackRegion || !Number.isInteger(fallbackChapter) ||
      fallbackChapter < 0 || fallbackChapter > 8)) {
      throw new SaveRepositoryError("corrupt", "Legacy save location is invalid.");
    }
    const nextSafeSpawn = progress?.safeSpawn
      ? structuredClone(progress.safeSpawn)
      : this.safeSpawnFor(progress?.regionId ?? fallbackRegion!.id);
    this.campaign = campaign;
    this.checkpoint = checkpoint;
    this.eventKeys = new Set(eventKeys);
    if (progress) {
      this.chapter = progress.chapter;
      this.region = progress.regionId as RegionId;
      this.activeQuestIds = [...progress.activeQuestIds];
      this.completedQuestIds = [...progress.completedQuestIds];
      this.completedObjectiveIds =
        progress.completedObjectiveIds as ObjectiveId[];
      this.trackedObjectiveId =
        progress.trackedObjectiveId as ObjectiveId | null;
      this.party = { ...progress.party } as typeof this.party;
      this.choices = { ...progress.choices };
      this.facts = factsWithRestorationDefaults(progress.worldFacts);
      normalizeRestorationFacts(campaign, this.facts);
      this.endingId = progress.ending;
      this.eventLog = progress.eventLog as WorldEvent[];
      this.eventKeys = new Set([
        ...eventKeys,
        ...(progress.eventKeys ?? []),
        ...progress.eventLog.map(
          (event) => (event as { idempotencyKey: string }).idempotencyKey,
        ),
      ]);
      this.safeSpawn = nextSafeSpawn;
      this.revision = progress.revision ?? 0;
    } else {
      const region = fallbackRegion!;
      this.chapter = fallbackChapter;
      this.region = region.id;
      this.completedQuestIds = QUESTS.filter(
        (quest) => !quest.optional && quest.chapter < fallbackChapter,
      ).map((quest) => quest.id);
      const firstQuest = CHAPTERS.find(
        (chapter) => chapter.number === fallbackChapter,
      )?.questIds.find((id) => {
        const quest = QUESTS.find((candidate) => candidate.id === id);
        return quest && !quest.optional && !this.completedQuestIds.includes(id);
      });
      this.activeQuestIds = firstQuest ? [firstQuest] : [];
      this.completedObjectiveIds = [];
      this.trackedObjectiveId = null;
      this.party = { scout: "vara" };
      this.choices = {};
      this.facts = emptyWorldFacts(campaign);
      this.facts.chapter = fallbackChapter;
      this.facts["visited:" + region.id] = true;
      normalizeRestorationFacts(campaign, this.facts);
      if (campaign.world.regionalObligations.bamboo_tali_safe) {
        this.facts.taliSafe = true;
        this.facts.taliNeedsRescue = false;
      }
      if (campaign.world.factions.crown.leaderStatus === "exiled")
        this.facts.solkarPresent = false;
      this.endingId = null;
      this.eventLog = [];
      this.eventKeys.clear();
      this.revision = 0;
      this.safeSpawn = nextSafeSpawn;
    }
    this.runId = campaign.runId;
    this.replay = false;
    if (campaign.world.factions.crown.leaderStatus === "exiled") {
      this.facts.solkarPresent = false;
      this.facts["solkar-exiled"] = true;
      this.facts.crownCouncilAvailable = true;
      if (this.party.combat === "solkar") delete this.party.combat;
      if (this.party.utility === "solkar") delete this.party.utility;
    }
    this.facts.refugeOpen = this.chapter >= 6;
    this.recoveryRequest = null;
    this.lastEvent = null;
    this.lastSafeCheckpoint = this.createSafeCheckpoint();
  }

  private restoreProgress(progress: CampaignProgressCheckpoint): void {
    this.chapter = progress.chapter;
    this.region = progress.regionId;
    this.activeQuestIds = [...progress.activeQuestIds];
    this.completedQuestIds = [...progress.completedQuestIds];
    this.completedObjectiveIds = [...progress.completedObjectiveIds];
    this.trackedObjectiveId = progress.trackedObjectiveId;
    this.party = structuredClone(progress.party);
    this.choices = { ...progress.choices };
    this.facts = factsWithRestorationDefaults(progress.worldFacts);
    normalizeRestorationFacts(this.campaign, this.facts);
    this.facts.refugeOpen = this.chapter >= 6;
    this.endingId = progress.ending;
    this.eventLog = progress.eventLog.map((event) => structuredClone(event));
    this.eventKeys = new Set(progress.eventKeys);
    this.revision = progress.revision;
    this.recoveryRequest = null;
    this.lastEvent = null;
  }

  private rollbackState(): DirectorRollbackState {
    return {
      campaign: this.campaign,
      region: this.region,
      chapter: this.chapter,
      facts: this.facts,
      choices: this.choices,
      activeQuestIds: this.activeQuestIds,
      completedQuestIds: this.completedQuestIds,
      completedObjectiveIds: this.completedObjectiveIds,
      trackedObjectiveId: this.trackedObjectiveId,
      party: this.party,
      endingId: this.endingId,
      checkpoint: this.checkpoint,
      lastSafeCheckpoint: this.lastSafeCheckpoint,
      safeSpawn: this.safeSpawn,
      recoveryRequest: this.recoveryRequest,
      lastEvent: this.lastEvent,
      eventKeys: this.eventKeys,
      eventLog: this.eventLog,
      revision: this.revision,
    };
  }

  private restoreRollbackState(rollback: DirectorRollbackState): void {
    this.campaign = rollback.campaign;
    this.region = rollback.region;
    this.chapter = rollback.chapter;
    this.facts = rollback.facts;
    this.choices = rollback.choices;
    this.activeQuestIds = rollback.activeQuestIds;
    this.completedQuestIds = rollback.completedQuestIds;
    this.completedObjectiveIds = rollback.completedObjectiveIds;
    this.trackedObjectiveId = rollback.trackedObjectiveId;
    this.party = rollback.party;
    this.endingId = rollback.endingId;
    this.checkpoint = rollback.checkpoint;
    this.lastSafeCheckpoint = rollback.lastSafeCheckpoint;
    this.safeSpawn = rollback.safeSpawn;
    this.recoveryRequest = rollback.recoveryRequest;
    this.lastEvent = rollback.lastEvent;
    this.eventKeys = rollback.eventKeys;
    this.eventLog = rollback.eventLog;
    this.revision = rollback.revision;
  }

  private progressRecord(): CampaignProgressRecord {
    return {
      chapter: this.chapter,
      regionId: this.region,
      activeQuestIds: [...this.activeQuestIds],
      completedQuestIds: [...this.completedQuestIds],
      completedObjectiveIds: [...this.completedObjectiveIds],
      trackedObjectiveId: this.trackedObjectiveId,
      party: { ...this.party },
      choices: { ...this.choices },
      worldFacts: { ...this.facts },
      ending: this.endingId,
      eventLog: this.eventLog.map((event) => structuredClone(event)),
      eventKeys: [...this.eventKeys],
      revision: this.revision,
      safeSpawn: structuredClone(this.safeSpawn),
    };
  }

  private checkpointProgress(): CampaignProgressCheckpoint {
    return {
      chapter: this.chapter,
      regionId: this.region,
      activeQuestIds: [...this.activeQuestIds] as never,
      completedQuestIds: [...this.completedQuestIds] as never,
      completedObjectiveIds: [...this.completedObjectiveIds] as never,
      trackedObjectiveId: this.trackedObjectiveId,
      party: structuredClone(this.party),
      choices: { ...this.choices },
      worldFacts: { ...this.facts },
      ending: this.endingId,
      eventLog: this.eventLog.map((event) => structuredClone(event)),
      eventKeys: [...this.eventKeys],
      revision: this.revision,
    };
  }

  private createSafeCheckpoint(): CampaignSafeCheckpoint {
    let encounter: (typeof ENCOUNTER_DEFINITIONS)[number] | undefined;
    for (const questId of this.activeQuestIds) {
      const quest = QUESTS.find((item) => item.id === questId);
      for (const objective of quest?.objectives ?? []) {
        if (objective.mechanic !== "encounter" || this.completedObjectiveIds.includes(objective.id)) continue;
        encounter = ENCOUNTER_DEFINITIONS.find((definition) =>
          definition.regionId === this.region &&
          (objective.targetIds.includes(definition.bossId) ||
            objective.requiredEvents.some((required) => required.split("|").includes("encounter:" + definition.id))) &&
          !this.eventLog.some((event) =>
            event.type === "encounter-resolved" && event.encounterId === definition.id,
          ),
        );
        if (encounter) break;
      }
      if (encounter) break;
    }
    const region = REGIONS.find((item) => item.id === this.region)!;
    const actorIds = encounter
      ? region.encounterParticipants[encounter.id] ?? encounter.actorIds.filter((id) => id !== "aren")
      : [];
    return {
      kind: "campaign-safe-checkpoint",
      schemaVersion: 1,
      runId: this.runId,
      checkpointId: this.runId + ":safe:" + this.revision,
      worldCheckpoint: createCheckpoint(this.campaign),
      progress: this.checkpointProgress(),
      safeSpawn: structuredClone(this.safeSpawn),
      encounterReset: {
        policy: "restart-from-entry",
        encounterId: encounter?.id ?? null,
        actorIds: [...actorIds],
      },
    };
  }
  private safeSpawnFor(regionId: RegionId, entranceId?: string): CampaignSafeSpawn {
    const region = REGIONS.find((item) => item.id === regionId);
    if (!region) throw new Error("No authored region exists for safe spawn.");

    const entrance = entranceId
      ? region.entrances.find((item) => item.id === entranceId)
      : undefined;
    let position: CampaignSafeSpawn["position"] | undefined;
    let spawnRouteId: string | undefined;
    if (
      entrance &&
      (!entrance.unlockFact || this.facts[entrance.unlockFact] === true) &&
      hasSafeWalkSurface(region, entrance.from)
    ) {
      position = entrance.from;
      spawnRouteId = entrance.id;
    }
    if (!position) {
      const root = region.navigation.nodes[0];
      if (
        root &&
        (!root.requirement || this.facts[root.requirement] === true) &&
        hasSafeWalkSurface(region, root.position)
      ) {
        position = root.position;
        spawnRouteId = root.id;
      }
    }
    if (!position || !spawnRouteId) {
      throw new Error("Region has no authored safe root on a walkable surface clear of blocking colliders.");
    }
    const camera =
      region.cameraAnchors.find(
        (anchor) => anchor.id === regionId + "-explore",
      ) ?? region.cameraAnchors[0];
    if (!camera) throw new Error("Region has no authored camera anchor.");
    return {
      regionId,
      position: { ...position },
      routeId: spawnRouteId,
      cameraAnchorId: camera.id,
    };
  }

  private objectivesFor(questId: string) {
    return QUESTS.find((quest) => quest.id === questId)?.objectives ?? [];
  }

  private updateQuestProgress(): void {
    for (const questId of [...this.activeQuestIds]) {
      const quest = QUESTS.find((item) => item.id === questId);
      const objectives = quest?.objectives ?? [];
      if (
        !objectives.length ||
        !objectives
          .filter((objective) => !objective.optional)
          .every((objective) =>
            this.completedObjectiveIds.includes(objective.id),
          )
      )
        continue;
      this.activeQuestIds = this.activeQuestIds.filter((id) => id !== questId);
      if (!this.completedQuestIds.includes(questId))
        this.completedQuestIds.push(questId);
      for (const fact of quest?.consequenceFacts ?? []) this.facts[fact] = true;
      this.applyQuestConsequences(questId, quest?.consequenceFacts ?? []);
      const chapter = quest?.chapter ?? 0;
      const sequence =
        CHAPTERS.find((item) => item.number === chapter)?.questIds ?? [];
      const nextQuestId = sequence.find((id) => {
        const nextQuest = QUESTS.find((item) => item.id === id);
        return Boolean(
          nextQuest &&
            !nextQuest.optional &&
            !this.completedQuestIds.includes(id),
        );
      });
      if (nextQuestId && !this.activeQuestIds.includes(nextQuestId))
        this.activeQuestIds.push(nextQuestId);
    }
  }

  private applyQuestConsequences(
    questId: string,
    facts: readonly string[],
  ): void {
    const obligations = facts.filter(
      (fact): fact is (typeof REGIONAL_OBLIGATION_IDS)[number] =>
        REGIONAL_OBLIGATION_IDS.includes(
          fact as (typeof REGIONAL_OBLIGATION_IDS)[number],
        ),
    );
    if (questId === "eyes-in-the-mist") obligations.push("mistveil_nyra_truth");
    if (questId === "the-lions-offer")
      obligations.push("sunmane_tribute_ended");
    if (questId === "a-mothers-roar")
      obligations.push("bamboo_tali_safe", "bamboo_snare_source");
    if (obligations.length) {
      const regionalObligations = {
        ...this.campaign.world.regionalObligations,
      };
      for (const obligation of obligations)
        regionalObligations[obligation] = true;
      this.campaign = {
        ...this.campaign,
        world: { ...this.campaign.world, regionalObligations },
      };
    }
    if (questId === "the-mire-maw") {
      this.campaign = {
        ...this.campaign,
        world: {
          ...this.campaign.world,
          regions: {
            ...this.campaign.world.regions,
            "mistveil-basin": "restored",
          },
        },
      };
      applyRestorationBooleans(this.facts, "mistveil-basin", "restored");
      this.facts.mistveil_restored = true;
    }
    if (questId === "orun-the-hollow-king") {
      this.campaign = {
        ...this.campaign,
        world: { ...this.campaign.world, hollowReady: true },
      };
    }
  }

  private applyChoice(
    campaign: CampaignState,
    choice: string,
    option: string,
    leaderId: string | undefined,
    facts: Record<string, boolean | number | string>,
  ): CampaignState {
    if (choice === "pack-leadership") {
      if (option === "ruun" || option === "luma") {
        campaign = setPackLeader(campaign, option);
        campaign = {
          ...campaign,
          world: {
            ...campaign.world,
            regionalObligations: {
              ...campaign.world.regionalObligations,
              moonpine_settlement: true,
            },
          },
        };
      }
      if (option === "dominion-ruun" || option === "dominion-luma") {
        campaign = setPackLeader(
          campaign,
          (leaderId ?? "ruun") as "ruun" | "luma",
        );
      }
    }
    if (choice === "sunmane-resolution") {
      if (option === "bond") {
        facts.sunmane_tribute_ended = true;
        facts.sunmane_voluntary_governance = true;
        campaign = this.markWilling(campaign, "crown");
        campaign = {
          ...campaign,
          world: {
            ...campaign.world,
            regionalObligations: {
              ...campaign.world.regionalObligations,
              sunmane_tribute_ended: true,
              sunmane_voluntary_governance: true,
            },
          },
        };
      } else if (option === "exile") {
        const crown = campaign.world.factions.crown;
        campaign = {
          ...campaign,
          world: {
            ...campaign.world,
            factions: {
              ...campaign.world.factions,
              crown: {
                ...crown,
                leaderStatus: "exiled",
                representative: {
                  id: "solkar",
                  source: "leader",
                  present: false,
                  willing: false,
                },
              },
            },
          },
        };
        campaign = setCrownCouncilRepresentation(campaign, false);
        facts.sunmane_tribute_ended = true;
        facts.sunmane_voluntary_governance = true;
        campaign = {
          ...campaign,
          world: {
            ...campaign.world,
            regionalObligations: {
              ...campaign.world.regionalObligations,
              sunmane_tribute_ended: true,
              sunmane_voluntary_governance: true,
            },
          },
        };
      } else if (option === "dominion") {
        facts.sunmane_tribute_ended = true;
        campaign = {
          ...campaign,
          world: {
            ...campaign.world,
            regionalObligations: {
              ...campaign.world.regionalObligations,
              sunmane_tribute_ended: true,
            },
          },
        };
      }
    }
    if (choice === "faction-covenant") {
      const faction = option as FactionId;
      const eligible: Record<FactionId, boolean> = {
        sky: campaign.world.fragments.includes("heartroot-sky"),
        canopy:
          campaign.world.regionalObligations.canopy_water_seed_accord &&
          campaign.world.fragments.includes("heartroot-canopy"),
        fang:
          campaign.world.regionalObligations.bamboo_tali_safe &&
          campaign.world.regionalObligations.bamboo_snare_source &&
          campaign.world.fragments.includes("heartroot-fang"),
        pack:
          campaign.world.regionalObligations.moonpine_settlement &&
          campaign.world.fragments.includes("heartroot-pack"),
        shadow:
          campaign.world.regionalObligations.mistveil_river_source &&
          campaign.world.regionalObligations.mistveil_nyra_truth &&
          campaign.world.fragments.includes("heartroot-shadow"),
        crown:
          campaign.world.regionalObligations.sunmane_voluntary_governance &&
          campaign.world.fragments.includes("heartroot-crown"),
      };
      if (!eligible[faction])
        throw new CampaignChoiceRejectedError(
          choice, option,
          "This faction covenant is not available until its story commitments are fulfilled.",
        );
      // A covenant records willingness, not a return of an absent representative.
      // In particular, it must not overturn the council's committed refusal.
      const current = campaign.world.factions[faction];
      campaign = {
        ...campaign,
        world: {
          ...campaign.world,
          factions: {
            ...campaign.world.factions,
            [faction]: {
              ...current,
              bondTier: 3,
              representative: {
                ...current.representative,
                willing: current.representative.present &&
                  !(faction === "crown" && this.choices["crown-council"] === "decline"),
              },
            },
          },
        },
      };
    }
    if (
      choice === "chapter-seven-commitment" &&
      option in campaign.world.renewedCommitments
    ) {
      const faction = option as FactionId;
      campaign = {
        ...campaign,
        world: {
          ...campaign.world,
          renewedCommitments: {
            ...campaign.world.renewedCommitments,
            [faction]: true,
          },
        },
      };
    }
    if (choice === "wild-march-formation") facts.wildMarchFormed = true;
    if (choice === "river-route") facts["riverRoute:" + option] = true;
    if (choice === "marek-fate") {
      campaign = {
        ...campaign,
        world: { ...campaign.world, marekPresent: option === "cleanse" },
      };
      facts.marekPresent = option === "cleanse";
    }
    if (choice === "crown-council")
      campaign = setCrownCouncilRepresentation(campaign, option === "willing");
    if (choice === "chapter-six-response") {
      facts.askSignal = true;
      facts.wardenResponse = option;
    }
    if (choice === "final-ending" && option === "living_pact")
      facts.circleOfTheWild = true;
    return campaign;
  }

  private validateChoice(
    choiceId: string,
    optionId: string,
    campaign: CampaignState,
  ): boolean {
    const options = CAMPAIGN_CHOICES[choiceId];
    if (!options || !options.some((option) => option.id === optionId))
      throw new CampaignChoiceRejectedError(choiceId, optionId, "Unknown campaign choice or option.");
    // Most choices settle one outcome. These two are authored once per faction.
    const factionScoped =
      choiceId === "faction-covenant" ||
      choiceId === "chapter-seven-commitment";
    const faction = optionId.replace(/^decline-/, "");
    const prior = this.eventLog.find(
      (event) =>
        event.type === "choice" &&
        event.choiceId === choiceId &&
        (!factionScoped || event.optionId.replace(/^decline-/, "") === faction),
    );
    const committed = prior?.type === "choice"
      ? prior.optionId
      : factionScoped ? undefined : this.choices[choiceId];
    if (committed !== undefined) {
      if (committed !== optionId)
        throw new CampaignChoiceRejectedError(choiceId, optionId, "This campaign choice already has a committed resolution.");
      return true;
    }
    if (
      choiceId === "sunmane-resolution" &&
      campaign.world.factions.crown.leaderStatus === "exiled" &&
      optionId !== "exile"
    ) {
      throw new CampaignChoiceRejectedError(choiceId, optionId, "Exiled Solkar cannot return through a new resolution.");
    }
     if (choiceId === "chapter-six-response") {
       if (this.chapter !== 6)
         throw new CampaignChoiceRejectedError(choiceId, optionId, "Ask or Signal is only available in Chapter 6.");
       if (this.facts.wardenCall !== true)
         throw new CampaignChoiceRejectedError(choiceId, optionId, "The Warden Call must happen before Ask or Signal.");
     }
    if (
      choiceId === "final-ending" &&
      optionId === "living_pact" &&
      !evaluateEnding(campaign).available
    ) {
      throw new CampaignChoiceRejectedError(choiceId, optionId, "Living Pact requirements are not met for this run.");
    }
    if (
      choiceId === "final-ending" &&
      !this.eventLog.some(
        (event) =>
          event.type === "encounter-resolved" &&
          eventMatches("encounter:encounter-orun", event),
      )
    ) {
      throw new CampaignChoiceRejectedError(choiceId, optionId, "Orun must be resolved before the final choice.");
    }
    if (
      choiceId === "wild-march-formation" &&
      !this.completedObjectiveIds.includes(
        "wild-march:commitments" as ObjectiveId,
      )
    ) {
      throw new CampaignChoiceRejectedError(
        choiceId, optionId,
        "Each faction must receive a Chapter 7 choice before the coalition route is formed.",
      );
    }
    if (choiceId === "faction-covenant" && this.chapter < 1)
      throw new CampaignChoiceRejectedError(
        choiceId, optionId,
        "Faction covenants are not available before regional commitments.",
      );
    if (choiceId === "sunmane-resolution" && this.chapter !== 5)
      throw new CampaignChoiceRejectedError(choiceId, optionId, "Sunmane governance is only decided in Chapter 5.");
    if (choiceId === "pack-leadership" && this.chapter !== 3)
      throw new CampaignChoiceRejectedError(choiceId, optionId, "Pack leadership is only decided in Chapter 3.");
    if (choiceId === "marek-fate" && this.chapter !== 4)
      throw new CampaignChoiceRejectedError(choiceId, optionId, "Marek’s fate is only decided in Chapter 4.");
    if (choiceId === "chapter-seven-commitment" && this.chapter !== 7)
      throw new CampaignChoiceRejectedError(choiceId, optionId, "Faction recommitments are only available in Chapter 7.");
    return false;
  }

  private markWilling(
    campaign: CampaignState,
    faction: FactionId,
  ): CampaignState {
    const current = campaign.world.factions[faction];
    return {
      ...campaign,
      world: {
        ...campaign.world,
        factions: {
          ...campaign.world.factions,
          [faction]: {
            ...current,
            representative: {
              ...current.representative,
              present: true,
              willing: true,
            },
          },
        },
      },
    };
  }

  private ensureChapterQuest(chapter: number): void {
    if (
      this.activeQuestIds.some(
        (id) => QUESTS.find((quest) => quest.id === id)?.chapter === chapter,
      )
    )
      return;
    const sequence =
      CHAPTERS.find((item) => item.number === chapter)?.questIds ?? [];
    const nextQuestId = sequence.find((id) => {
      const quest = QUESTS.find((item) => item.id === id);
      return Boolean(
        quest && !quest.optional && !this.completedQuestIds.includes(id),
      );
    });
    if (nextQuestId) this.activeQuestIds.push(nextQuestId);
  }

  private publish(): CampaignSnapshot {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }
}

function cloneEvent(event: WorldEvent): WorldEvent {
  return structuredClone(event);
}

function mergeHistory(
  existing: CampaignState["dominionHistory"],
  incoming: CampaignState["dominionHistory"],
): CampaignState["dominionHistory"] {
  const merged = existing.map((event) => ({ ...event }));
  for (const event of incoming) {
    if (
      merged.some(
        (saved) =>
          saved.sequence === event.sequence &&
          saved.leaderId === event.leaderId,
      )
    )
      continue;
    merged.push({ ...event, sequence: (merged.at(-1)?.sequence ?? 0) + 1 });
  }
  return merged;
}
