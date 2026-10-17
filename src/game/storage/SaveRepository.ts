import {
  createNewRun,
  importCheckpoint,
  LEGACY_SCHEMA_VERSION,
  migrateCampaignStateV1,
  migrateWorldV1,
  SCHEMA_VERSION,
  type CampaignState,
  type CheckpointSnapshot,
  type DominionEvent,
  type ImportResult,
} from "../../../packages/campaign/src/index.js";
import { REGIONS } from "../../content/world.js";
import {
  DEFAULT_GAMEPAD_BINDINGS,
  DEFAULT_KEYBOARD_BINDINGS,
  type CampaignSafeSpawn,
  type ChapterRuntimeDefinition,
  type ChapterSegmentId,
  type ChapterSessionMetadata,
  type CompanionParty,
  type GameSettings,
  type InputBindingMaps,
  type LayoutRevisionMigration,
  type RegionId,
  type SaveScope,
  type WorldEvent,
} from "../contracts.js";
import { DEFAULT_HERO_ID, isHeroId, type HeroId } from "../heroes.js";
import { DEFAULT_HERO_COMPANIONS, isCompanionId, migrateCompanionParty, validHeroCompanions } from "../companions/CompanionLoadout.js";
import {
  autosaveSlotId,
  ChapterMigrationError,
  deriveSegmentId,
  isAutosaveSlotId,
  isChapterSessionMetadata,
  migrateLayout,
  sessionContentProblem,
  withLegacySession,
  type MigrationContext,
} from "../campaign/session.js";
import { isRecord } from "../guards.js";

export const SAVE_DATABASE_NAME = "wild-crown-saves";
/** Isolated database for DEV candidate-asset chapter runs; the same repository implementation and stores. */
export const CANDIDATE_SAVE_DATABASE_NAME = "wild-crown-candidate-chapter-saves";
/** Nested record formats changed without any store/index change, so the IndexedDB structure stays at version 2. */
export const SAVE_DATABASE_VERSION = 2 as const;
/** Export/slot envelope version: 3 replaces the three role slots with one traveling companion. */
export const SAVE_FORMAT_SCHEMA_VERSION = 3 as const;
/** Original envelope version; versions 1 and 2 migrate on read and are rewritten only on an explicit save. */
export const LEGACY_SAVE_FORMAT_SCHEMA_VERSION = 1 as const;

type SaveKind = "campaign" | "showcase-replay";

export type SaveErrorCode =
  | "unavailable"
  | "corrupt"
  | "future-schema"
  | "invalid-schema"
  | "run-mismatch"
  | "replay-isolated"
  | "scope-mismatch"
  | "layout-revision"
  | "quota"
  | "transaction"
  | "not-found";

export interface SaveRepositoryOptions {
  /** Persistence scope; defaults to production. A candidate scope selects the candidate database. */
  scope?: SaveScope;
  /** Explicit database name (tests); defaults to the scope's database. */
  databaseName?: string;
  /** Authored chapter definitions used to validate checkpoints/layout revisions and derive legacy resume state. */
  chapters?: readonly ChapterRuntimeDefinition[];
  /** Explicit old-layout → new-layout safe-spawn mappings. */
  layoutMigrations?: readonly LayoutRevisionMigration[];
}

export interface CampaignProgressRecord {
  chapter: number;
  regionId: RegionId;
  activeQuestIds: string[];
  completedQuestIds: string[];
  completedObjectiveIds: string[];
  trackedObjectiveId: string | null;
  party: CompanionParty;
  choices: Record<string, string>;
  worldFacts: Record<string, boolean | number | string>;
  ending: "dominion" | "severance" | "living_pact" | null;
  eventLog: unknown[];
  eventKeys?: string[];
  revision?: number;
  safeSpawn?: CampaignSafeSpawn;
  /** Hero, scope, asset policy and chapter resume state (the shared persisted session definition). */
  session: ChapterSessionMetadata;
}

export interface GameSaveEnvelope {
  format: "wild-crown-save";
  schemaVersion: typeof SAVE_FORMAT_SCHEMA_VERSION;
  /** Persistence scope the payload belongs to; import and load reject a different scope before any mutation. */
  scope: SaveScope;
  kind: SaveKind;
  runId: string;
  checkpoint: CheckpointSnapshot | null;
  campaign: CampaignState | null;
  progress: CampaignProgressRecord | null;
  eventKeys: string[];
  savedAt: number;
}

export interface SaveSlotSummary {
  slotId: string;
  label: string;
  runId: string;
  kind: SaveKind;
  updatedAt: number;
  chapter: number;
  regionId: RegionId;
  scope: SaveScope;
  heroId: HeroId;
  segmentId: ChapterSegmentId | null;
  checkpointId: string | null;
  autosave: boolean;
}

export interface SaveSlotRecord extends SaveSlotSummary {
  envelope: GameSaveEnvelope;
}

export interface RunLedgerRecord {
  runId: string;
  dominionHistory: DominionEvent[];
  eventKeys: string[];
  updatedAt: number;
  kind: SaveKind;
}

export interface SaveSettingsRecord {
  id: "global";
  settings: GameSettings;
  bindings: InputBindingMaps;
}

export class SaveRepositoryError extends Error {
  constructor(
    readonly code: SaveErrorCode,
    message: string,
    readonly recovery?: {
      slots: readonly SaveSlotSummary[];
      exportAvailable: boolean;
    },
  ) {
    super(message);
    this.name = "SaveRepositoryError";
  }
}

const isRegionId = (value: unknown): value is RegionId =>
  typeof value === "string" && REGIONS.some((region) => region.id === value);
const isStringMap = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");

/** Structural boundary for persisted choice events, not a new choice authority. */
export function isValidChoiceEvent(value: unknown): value is Extract<WorldEvent, { type: "choice" }> {
  return isRecord(value) &&
    value.type === "choice" &&
    typeof value.eventId === "string" && value.eventId.trim().length > 0 &&
    typeof value.idempotencyKey === "string" && value.idempotencyKey.trim().length > 0 &&
    typeof value.choiceId === "string" && value.choiceId.trim().length > 0 &&
    typeof value.optionId === "string" && value.optionId.trim().length > 0 &&
    (value.leaderId === undefined || typeof value.leaderId === "string") &&
    (value.dominion === undefined || typeof value.dominion === "boolean");
}

function isInputBindingMaps(value: unknown): value is InputBindingMaps {
  return (
    isRecord(value) &&
    isStringMap(value.keyboard) &&
    isStringMap(value.gamepad)
  );
}
function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && options.includes(value as T);
}

function isGameSettings(value: unknown): value is GameSettings {
  return (
    isRecord(value) &&
    [
      value.masterVolume,
      value.musicVolume,
      value.effectsVolume,
      value.ambienceVolume,
      value.dialogueVolume,
      value.gamepadDeadzone,
    ].every((entry) => typeof entry === "number" && Number.isFinite(entry)) &&
    [
      value.subtitles,
      value.echoSubtitles,
      value.subtitleSpeakerLabels,
      value.reducedMotion,
      value.motionBlur,
      value.reducedCameraShake,
      value.highContrastTarget,
    ].every((entry) => typeof entry === "boolean") &&
    isOneOf(value.subtitleSize, ["small", "medium", "large"]) &&
    isOneOf(value.subtitleBackground, ["off", "translucent", "solid"]) &&
    isOneOf(value.telegraphIntensity, ["standard", "high"]) &&
    isOneOf(value.offscreenWarningStrength, ["low", "standard", "high"]) &&
    isOneOf(value.autoTargetAssist, ["off", "subtle", "strong"]) &&
    isOneOf(value.perfectDodgeWindow, ["standard", "wide"]) &&
    isOneOf(value.lockOnMode, ["hold", "toggle"]) &&
    isOneOf(value.controlGlyphs, ["keyboard-mouse", "gamepad"]) &&
    validHeroCompanions(value.heroCompanions) &&
    // Absent in settings saved before tutorials existed; the application fills the default.
    (value.seenTutorials === undefined ||
      (Array.isArray(value.seenTutorials) && value.seenTutorials.every((entry) => typeof entry === "string")))
  );
}


function migrateLegacyBindings(value: unknown): InputBindingMaps | null {
  if (!isStringMap(value)) return null;
  const keyboard = { ...DEFAULT_KEYBOARD_BINDINGS };
  const gamepad = { ...DEFAULT_GAMEPAD_BINDINGS };
  for (const [actionId, binding] of Object.entries(value)) {
    const prefix = "Gamepad Button ";
    const suffix = binding.slice(prefix.length);
    const isGamepadButton =
      binding.startsWith(prefix) &&
      suffix.length > 0 &&
      [...suffix].every((character) => character >= "0" && character <= "9");
    if (isGamepadButton) {
      gamepad[actionId] = binding;
      delete keyboard[actionId];
    } else {
      keyboard[actionId] = binding;
    }
  }
  return { keyboard, gamepad };
}


const clone = <T>(value: T): T => structuredClone(value);

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed."));
  });
}

function mergeDominion(
  current: readonly DominionEvent[],
  incoming: readonly DominionEvent[],
): DominionEvent[] {
  const merged = current.map((event) => ({ ...event }));
  let sequence = merged.at(-1)?.sequence ?? 0;
  for (const event of incoming) {
    if (
      merged.some(
        (saved) =>
          saved.sequence === event.sequence &&
          saved.leaderId === event.leaderId,
      )
    ) {
      continue;
    }
    merged.push({ sequence: ++sequence, leaderId: event.leaderId });
  }
  return merged;
}

function validParty(party: Record<string, unknown>): boolean {
  return Object.keys(party).every(key => key === "companionId")
    && (party.companionId === undefined || isCompanionId(party.companionId));
}

function validProgress(value: unknown, chapters: readonly ChapterRuntimeDefinition[]): value is CampaignProgressRecord {
  if (!isRecord(value)) return false;
  const stringArray = (field: unknown): field is string[] =>
    Array.isArray(field) && field.every((entry) => typeof entry === "string");
  const facts = value.worldFacts;
  const party = value.party;
  const safeSpawn = value.safeSpawn;
  const region = REGIONS.find((item) => item.id === value.regionId);
  const spawnRoute = isRecord(safeSpawn) && region
    ? region.entrances.find((item) => item.id === safeSpawn.routeId)
    : undefined;
  const spawnNode = isRecord(safeSpawn) && region
    ? region.navigation.nodes.find((item) => item.id === safeSpawn.routeId)
    : undefined;
  const authoredPosition = spawnRoute?.from ?? spawnNode?.position;
  const spawnRequirement = spawnRoute?.unlockFact ?? spawnNode?.requirement;
  const validSafeSpawn =
    safeSpawn === undefined ||
    (isRecord(safeSpawn) &&
      safeSpawn.regionId === value.regionId &&
      region?.cameraAnchors.some((anchor) => anchor.id === safeSpawn.cameraAnchorId) === true &&
      isRecord(safeSpawn.position) &&
      authoredPosition !== undefined &&
      safeSpawn.position.x === authoredPosition.x &&
      safeSpawn.position.y === authoredPosition.y &&
      safeSpawn.position.z === authoredPosition.z &&
      (!spawnRequirement || (isRecord(facts) && facts[spawnRequirement] === true)));
  return (
    typeof value.chapter === "number" &&
    Number.isInteger(value.chapter) &&
    value.chapter >= 0 &&
    value.chapter <= 8 &&
    isRegionId(value.regionId) &&
    stringArray(value.activeQuestIds) &&
    stringArray(value.completedQuestIds) &&
    stringArray(value.completedObjectiveIds) &&
    (typeof value.trackedObjectiveId === "string" ||
      value.trackedObjectiveId === null) &&
    isRecord(party) &&
    validParty(party) &&
    isRecord(value.choices) &&
    Object.values(value.choices).every((entry) => typeof entry === "string") &&
    isRecord(facts) &&
    Object.values(facts).every(
      (entry) =>
        typeof entry === "boolean" ||
        typeof entry === "number" ||
        typeof entry === "string",
    ) &&
    (value.ending === null ||
      value.ending === "dominion" ||
      value.ending === "severance" ||
      value.ending === "living_pact") &&
    Array.isArray(value.eventLog) &&
    value.eventLog.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.type === "string" &&
        typeof entry.idempotencyKey === "string" &&
        (entry.type !== "choice" || isValidChoiceEvent(entry)),
    ) &&
    (value.eventKeys === undefined || stringArray(value.eventKeys)) &&
    (value.revision === undefined || Number.isInteger(value.revision)) &&
    validSafeSpawn &&
    isChapterSessionMetadata(value.session) &&
    sessionContentProblem(value.session, value.regionId as RegionId, chapters) === null
  );
}

function validLedger(value: unknown): value is RunLedgerRecord {
  return (
    isRecord(value) &&
    typeof value.runId === "string" &&
    typeof value.updatedAt === "number" &&
    (value.kind === "campaign" || value.kind === "showcase-replay") &&
    Array.isArray(value.dominionHistory) &&
    value.dominionHistory.every(
      (event) =>
        isRecord(event) &&
        Number.isInteger(event.sequence) &&
        typeof event.leaderId === "string" &&
        ["koro", "asha", "ruun", "luma", "nyra", "solkar"].includes(
          event.leaderId,
        ),
    ) &&
    Array.isArray(value.eventKeys) &&
    value.eventKeys.every((key) => typeof key === "string")
  );
}
export class SaveRepository {
  private databaseHandle: IDBDatabase | null = null;
  private opening: Promise<void> | null = null;

  /** Persistence scope of this repository; a payload from a different scope is rejected before any mutation. */
  readonly scope: SaveScope;
  private readonly databaseName: string;
  readonly chapters: readonly ChapterRuntimeDefinition[];
  readonly layoutMigrations: readonly LayoutRevisionMigration[];

  constructor(private readonly factory: IDBFactory = globalThis.indexedDB, options: SaveRepositoryOptions = {}) {
    this.scope = options.scope ?? "production";
    this.databaseName = options.databaseName
      ?? (this.scope === "candidate-chapters" ? CANDIDATE_SAVE_DATABASE_NAME : SAVE_DATABASE_NAME);
    this.chapters = options.chapters ?? [];
    this.layoutMigrations = options.layoutMigrations ?? [];
  }

  /** Summary of a stored row (v1 rows without session fields are summarized by derivation); null for malformed or foreign-scope rows. */
  private rowSummary(row: unknown): SaveSlotSummary | null {
    if (!isRecord(row) || typeof row.slotId !== "string" || typeof row.label !== "string" || typeof row.runId !== "string" ||
      typeof row.updatedAt !== "number" || typeof row.chapter !== "number" || !isRegionId(row.regionId) ||
      (row.kind !== "campaign" && row.kind !== "showcase-replay")) return null;
    const scope = row.scope ?? this.scope;
    if (scope !== this.scope) return null;
    const envelope = isRecord(row.envelope) ? row.envelope : undefined;
    const progress = envelope && isRecord(envelope.progress) ? envelope.progress : undefined;
    const session = progress && isChapterSessionMetadata(progress.session) ? progress.session : undefined;
    const completed = progress && Array.isArray(progress.completedQuestIds) ? progress.completedQuestIds as string[] : [];
    return {
      slotId: row.slotId,
      label: row.label,
      runId: row.runId,
      kind: row.kind,
      updatedAt: row.updatedAt,
      chapter: row.chapter,
      regionId: row.regionId,
      scope: this.scope,
      heroId: isHeroId(row.heroId) ? row.heroId : session?.heroId ?? DEFAULT_HERO_ID,
      segmentId: "segmentId" in row
        ? (row.segmentId as ChapterSegmentId | null)
        : session?.resume.segmentId ?? deriveSegmentId(row.chapter, row.regionId, completed,
          progress && Array.isArray(progress.completedObjectiveIds) ? progress.completedObjectiveIds as string[] : [],
          session?.resume.completedBeatIds ?? []),
      checkpointId: "checkpointId" in row ? (row.checkpointId as string | null) : session?.resume.checkpointId ?? null,
      autosave: isAutosaveSlotId(row.slotId),
    };
  }

  async init(): Promise<void> {
    if (!this.factory) {
      throw new SaveRepositoryError(
        "unavailable",
        "IndexedDB is unavailable; campaign saves cannot be safely persisted.",
      );
    }
    if (this.databaseHandle) return;
    if (this.opening) return this.opening;

    this.opening = new Promise<void>((resolve, reject) => {
      const request = this.factory.open(
        this.databaseName,
        SAVE_DATABASE_VERSION,
      );
      request.onupgradeneeded = (event) => {
        const database = request.result;
        if (!database.objectStoreNames.contains("slots")) {
          database.createObjectStore("slots", { keyPath: "slotId" });
        }
        if (!database.objectStoreNames.contains("runs")) {
          database.createObjectStore("runs", { keyPath: "runId" });
        }
        if (!database.objectStoreNames.contains("settings")) {
          database.createObjectStore("settings", { keyPath: "id" });
        }
        if (event.oldVersion === 1) {
          const settings = request.transaction?.objectStore("settings");
          const cursorRequest = settings?.openCursor();
          if (cursorRequest) {
            cursorRequest.onsuccess = () => {
              const cursor = cursorRequest.result;
              if (!cursor) return;
              const record: unknown = cursor.value;
              if (isRecord(record) && record.id === "global") {
                const bindings = migrateLegacyBindings(record.bindings);
                if (bindings) cursor.update({ ...record, bindings });
              }
              cursor.continue();
            };
          }
        }
      };
      request.onsuccess = () => {
        this.databaseHandle = request.result;
        this.databaseHandle.onversionchange = () => {
          this.databaseHandle?.close();
          this.databaseHandle = null;
        };
        resolve();
      };
      request.onerror = () =>
        reject(
          new SaveRepositoryError(
            "unavailable",
            "Could not open the IndexedDB save database. A newer database schema may be installed.",
          ),
        );
      request.onblocked = () =>
        reject(
          new SaveRepositoryError(
            "transaction",
            "A save database upgrade is blocked by another tab.",
          ),
        );
    }).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private database(): IDBDatabase {
    if (!this.databaseHandle) {
      throw new SaveRepositoryError(
        "unavailable",
        "Call SaveRepository.init() before using saves.",
      );
    }
    return this.databaseHandle;
  }

  async listSlots(): Promise<SaveSlotSummary[]> {
    await this.init();
    const transaction = this.database().transaction("slots", "readonly");
    const done = transactionDone(transaction);
    const rows = await requestValue(transaction.objectStore("slots").getAll());
    await done;
    return (rows as unknown[])
      .flatMap((row) => {
        const summary = this.rowSummary(row);
        return summary ? [summary] : [];
      })
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  /**
   * Writes the run's stable autosave slot and run ledger in one transaction. The Director calls this for every committed
   * event/checkpoint/party change, so a failed write leaves slot and ledger unchanged.
   */
  async saveAutosave(
    checkpoint: CheckpointSnapshot,
    campaign: CampaignState,
    chapter: number,
    regionId: RegionId,
    eventKeys: readonly string[],
    progress: CampaignProgressRecord,
  ): Promise<SaveSlotSummary> {
    return this.writeSlot(autosaveSlotId(campaign.runId), "Autosave", checkpoint, campaign, chapter, regionId, eventKeys, "campaign", progress);
  }

  async saveCheckpoint(
    slotId: string,
    label: string,
    checkpoint: CheckpointSnapshot,
    campaign: CampaignState,
    chapter: number,
    regionId: RegionId,
    eventKeys: readonly string[],
    kind: SaveKind = "campaign",
    progress: CampaignProgressRecord | null = null,
  ): Promise<SaveSlotSummary> {
    return this.writeSlot(slotId, label, checkpoint, campaign, chapter, regionId, eventKeys, kind, progress);
  }

  private async writeSlot(
    slotId: string,
    label: string,
    checkpoint: CheckpointSnapshot,
    campaign: CampaignState,
    chapter: number,
    regionId: RegionId,
    eventKeys: readonly string[],
    kind: SaveKind = "campaign",
    progress: CampaignProgressRecord | null = null,
  ): Promise<SaveSlotSummary> {
    if (kind !== "campaign") {
      throw new SaveRepositoryError(
        "replay-isolated",
        "Showcase replay data cannot be written to campaign slots.",
      );
    }
    if (checkpoint.runId !== campaign.runId) {
      throw new SaveRepositoryError(
        "run-mismatch",
        "Checkpoint and campaign belong to different journeys.",
      );
    }
    if (progress && !validProgress(progress, this.chapters)) {
      throw new SaveRepositoryError(
        "invalid-schema",
        "Campaign progress is malformed.",
      );
    }

    const envelope: GameSaveEnvelope = {
      format: "wild-crown-save",
      schemaVersion: SAVE_FORMAT_SCHEMA_VERSION,
      scope: this.scope,
      kind,
      runId: campaign.runId,
      checkpoint: clone(checkpoint),
      campaign: clone(campaign),
      progress: progress ? clone(progress) : null,
      eventKeys: [...new Set(eventKeys)],
      savedAt: Date.now(),
    };
    return this.persist(slotId, label, envelope, chapter, regionId);
  }

  async saveRun(
    slotId: string,
    label: string,
    campaign: CampaignState,
    chapter: number,
    regionId: RegionId,
    eventKeys: readonly string[],
    checkpoint: CheckpointSnapshot | null = null,
  ): Promise<SaveSlotSummary> {
    if (!checkpoint) {
      throw new SaveRepositoryError(
        "corrupt",
        "A safe checkpoint is required before creating a campaign slot.",
      );
    }
    return this.saveCheckpoint(
      slotId,
      label,
      checkpoint,
      campaign,
      chapter,
      regionId,
      eventKeys,
    );
  }

  private async persist(
    slotId: string,
    label: string,
    envelope: GameSaveEnvelope,
    chapter: number,
    regionId: RegionId,
  ): Promise<SaveSlotSummary> {
    if (!slotId.trim())
      throw new SaveRepositoryError(
        "invalid-schema",
        "Slot ID must not be empty.",
      );
    const validation = this.validateEnvelope(envelope);
    if (validation.accepted === false) {
      throw this.validationError(validation.reason, await this.recovery());
    }
    if (!Number.isInteger(chapter) || chapter < 0 || chapter > 8 || !isRegionId(regionId) ||
      (envelope.progress && (envelope.progress.chapter !== chapter || envelope.progress.regionId !== regionId))) {
      throw new SaveRepositoryError("corrupt", "Save slot location must match its campaign progress.");
    }
    await this.init();
    const updatedAt = Date.now();
    const session = envelope.progress?.session;
    const summary: SaveSlotSummary = {
      slotId,
      label,
      runId: envelope.runId,
      kind: envelope.kind,
      updatedAt,
      chapter,
      regionId,
      scope: envelope.scope,
      heroId: session?.heroId ?? DEFAULT_HERO_ID,
      segmentId: session?.resume.segmentId ?? null,
      checkpointId: session?.resume.checkpointId ?? null,
      autosave: isAutosaveSlotId(slotId),
    };
    const transaction = this.database().transaction(
      ["slots", "runs"],
      "readwrite",
    );
    const done = transactionDone(transaction);
    const slots = transaction.objectStore("slots");
    const runs = transaction.objectStore("runs");
    try {
      const previous = (await requestValue(runs.get(envelope.runId))) as
        | RunLedgerRecord
        | undefined;
      if (previous !== undefined && (!validLedger(previous) || previous.runId !== envelope.runId || previous.kind !== "campaign")) {
        throw new SaveRepositoryError("corrupt", "The run ledger is malformed; no stored data was changed.");
      }
      const ledger: RunLedgerRecord = {
        runId: envelope.runId,
        kind: "campaign",
        dominionHistory: mergeDominion(
          previous?.dominionHistory ?? [],
          envelope.campaign?.dominionHistory ?? [],
        ),
        eventKeys: [
          ...new Set([...(previous?.eventKeys ?? []), ...envelope.eventKeys]),
        ],
        updatedAt,
      };
      if (envelope.campaign)
        envelope.campaign.dominionHistory = clone(ledger.dominionHistory);
      slots.put({ ...summary, envelope });
      runs.put(ledger);
      await done;
      return summary;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // A request failure may already have aborted the transaction.
      }
      try {
        await done;
      } catch {
        // The transaction's abort is the rollback boundary.
      }
      throw await this.writeError(error);
    }
  }

  async loadSlot(
    slotId: string,
    currentRunId?: string,
  ): Promise<GameSaveEnvelope> {
    return (await this.loadRecord(slotId, currentRunId)).envelope;
  }

  protected async loadRecord(
    slotId: string,
    currentRunId?: string,
  ): Promise<SaveSlotRecord> {
    await this.init();
    const transaction = this.database().transaction(
      ["slots", "runs"],
      "readonly",
    );
    const done = transactionDone(transaction);
    const slot = (await requestValue(
      transaction.objectStore("slots").get(slotId),
    )) as SaveSlotRecord | undefined;
    if (!slot) {
      await done;
      throw new SaveRepositoryError(
        "not-found",
        "The selected save slot does not exist.",
      );
    }
    if (slot.kind === "showcase-replay") {
      await done;
      throw new SaveRepositoryError(
        "replay-isolated",
        "Replay saves cannot be loaded as campaign progress.",
      );
    }
    if (currentRunId && slot.runId !== currentRunId) {
      await done;
      throw new SaveRepositoryError(
        "run-mismatch",
        "The selected slot belongs to a different journey.",
      );
    }
    if (slot.slotId !== slotId || typeof slot.label !== "string" ||
      typeof slot.runId !== "string" || !slot.runId.trim() ||
      slot.kind !== "campaign" || !Number.isFinite(slot.updatedAt) ||
      !Number.isInteger(slot.chapter) || slot.chapter < 0 || slot.chapter > 8 ||
      !isRegionId(slot.regionId)) {
      await done;
      throw new SaveRepositoryError("corrupt", "Save slot metadata is malformed.", await this.recovery());
    }
    const rawLedger = await requestValue(
      transaction.objectStore("runs").get(slot.runId),
    );
    await done;
    if (rawLedger !== undefined &&
      (!validLedger(rawLedger) || rawLedger.runId !== slot.runId || rawLedger.kind !== "campaign")) {
      throw new SaveRepositoryError(
        "corrupt",
        "The run ledger is malformed; no stored data was changed.",
        await this.recovery(),
      );
    }
    try {
      // Stored records migrate on read only; the raw original is preserved until the next explicit save succeeds.
      slot.envelope = this.upgradeEnvelope(slot.envelope);
    } catch (error) {
      throw this.migrationError(error, await this.recovery());
    }
    const validation = this.validateEnvelope(slot.envelope);
    if (validation.accepted === false) {
      throw this.validationError(validation.reason, await this.recovery());
    }
    if (slot.envelope.runId !== slot.runId) {
      throw new SaveRepositoryError("run-mismatch", "The slot and envelope journey IDs must match.", await this.recovery());
    }
    if (slot.envelope.progress &&
      (slot.envelope.progress.chapter !== slot.chapter || slot.envelope.progress.regionId !== slot.regionId)) {
      throw new SaveRepositoryError("corrupt", "Save slot location does not match its campaign progress.", await this.recovery());
    }
    if (!slot.envelope.campaign) {
      throw new SaveRepositoryError(
        "corrupt",
        "Save slot is missing campaign state.",
        await this.recovery(),
      );
    }
    const ledger = rawLedger as RunLedgerRecord | undefined;
    slot.envelope.campaign.dominionHistory = mergeDominion(
      ledger?.dominionHistory ?? [],
      slot.envelope.campaign.dominionHistory,
    );
    // Objective/idempotency state is branch-local and stays with the selected checkpoint.
    return clone(slot);
  }
  async loadCampaign(
    slotId: string,
    current: CampaignState,
  ): Promise<{
    campaign: CampaignState;
    checkpoint: CheckpointSnapshot;
    eventKeys: readonly string[];
    progress: CampaignProgressRecord | null;
    chapter: number;
    regionId: RegionId;
  }> {
    // Ordinary slot selection adopts the saved journey. Run-scoped checkpoint
    // restoration remains strict in importCheckpoint and loadSlot(currentRunId).
    const slot = await this.loadRecord(slotId);
    const envelope = slot.envelope;
    if (!envelope.checkpoint || !envelope.campaign) {
      throw new SaveRepositoryError(
        "corrupt",
        "Campaign checkpoint is missing.",
        await this.recovery(),
      );
    }
    const sameRun = current.runId === envelope.runId;
    const imported = importCheckpoint(
      {
        ...envelope.campaign,
        dominionHistory: mergeDominion(
          sameRun ? current.dominionHistory : [],
          envelope.campaign.dominionHistory,
        ),
      },
      envelope.checkpoint,
    );
    if (imported.accepted === false) throw this.importError(imported);
    return {
      campaign: {
        ...envelope.campaign,
        world: imported.state.world,
        dominionHistory: mergeDominion(
          imported.state.dominionHistory,
          envelope.campaign.dominionHistory,
        ),
      },
      checkpoint: {
        ...envelope.checkpoint,
        world: clone(envelope.checkpoint.world),
      },
      eventKeys: [...envelope.eventKeys],
      progress: envelope.progress ? clone(envelope.progress) : null,
      chapter: slot.chapter,
      regionId: slot.regionId,
    };
  }

  async exportSlot(slotId: string): Promise<string> {
    return JSON.stringify(await this.loadSlot(slotId));
  }

  async exportRawSlot(slotId: string): Promise<string> {
    await this.init();
    const transaction = this.database().transaction("slots", "readonly");
    const done = transactionDone(transaction);
    const record = await requestValue(
      transaction.objectStore("slots").get(slotId),
    );
    await done;
    if (record === undefined)
      throw new SaveRepositoryError(
        "not-found",
        "The selected save slot does not exist.",
      );
    return JSON.stringify(record);
  }

  async importSave(
    input: string | unknown,
    localRun?: CampaignState,
  ): Promise<{ envelope: GameSaveEnvelope; result: ImportResult | null }> {
    let value: unknown;
    try {
      value = typeof input === "string" ? JSON.parse(input) : input;
    } catch {
      throw new SaveRepositoryError(
        "corrupt",
        "Save export is not valid JSON.",
        await this.recovery(),
      );
    }
    if (
      !isRecord(value) ||
      value.format !== "wild-crown-save" ||
      typeof value.schemaVersion !== "number" ||
      typeof value.kind !== "string" ||
      typeof value.runId !== "string" ||
      !Array.isArray(value.eventKeys) ||
      !value.eventKeys.every((key) => typeof key === "string") ||
      typeof value.savedAt !== "number"
    ) {
      throw new SaveRepositoryError(
        "invalid-schema",
        "Save export does not match the required envelope.",
        await this.recovery(),
      );
    }
    if (value.schemaVersion > SAVE_FORMAT_SCHEMA_VERSION) {
      throw new SaveRepositoryError(
        "future-schema",
        "This save was created by a newer version. It was not changed.",
      );
    }
    if (![LEGACY_SAVE_FORMAT_SCHEMA_VERSION, 2, SAVE_FORMAT_SCHEMA_VERSION].includes(value.schemaVersion)) {
      throw new SaveRepositoryError(
        "invalid-schema",
        "Save export schema is unsupported.",
        await this.recovery(),
      );
    }
    if (value.kind === "showcase-replay") {
      throw new SaveRepositoryError(
        "replay-isolated",
        "Replay imports are isolated from campaign saves.",
      );
    }
    if (
      value.kind !== "campaign" ||
      !isRecord(value.campaign) ||
      !isRecord(value.checkpoint)
    ) {
      throw new SaveRepositoryError(
        "corrupt",
        "Campaign save is missing its state or checkpoint.",
        await this.recovery(),
      );
    }
    let envelope: GameSaveEnvelope;
    try {
      envelope = this.upgradeEnvelope(value);
    } catch (error) {
      throw this.migrationError(error, await this.recovery());
    }
    if (envelope.scope !== "production" && envelope.scope !== "candidate-chapters") {
      throw new SaveRepositoryError("invalid-schema", "Save export scope is not recognized.", await this.recovery());
    }
    if (envelope.scope !== this.scope) {
      throw new SaveRepositoryError(
        "scope-mismatch",
        envelope.scope === "candidate-chapters"
          ? "This save belongs to the candidate chapter scope and cannot be imported here. It was not changed."
          : "This save belongs to the production scope and cannot be imported here. It was not changed.",
      );
    }
    const campaign = envelope.campaign as unknown as CampaignState;
    const checkpoint = envelope.checkpoint as unknown as CheckpointSnapshot;
    if (
      !this.validCampaign(campaign, envelope.runId) ||
      (envelope.progress !== null &&
        envelope.progress !== undefined &&
        !validProgress(envelope.progress, this.chapters))
    ) {
      throw new SaveRepositoryError(
        "corrupt",
        "Campaign export contains malformed state or progress.",
        await this.recovery(),
      );
    }
    if (
      campaign.runId !== envelope.runId ||
      checkpoint.runId !== envelope.runId
    ) {
      throw new SaveRepositoryError(
        "run-mismatch",
        "Campaign, checkpoint, and envelope run IDs must match.",
      );
    }
    const current =
      localRun?.runId === envelope.runId
        ? localRun
        : createNewRun(envelope.runId);
    const result = importCheckpoint(
      {
        ...current,
        dominionHistory: mergeDominion(
          current.dominionHistory,
          campaign.dominionHistory,
        ),
      },
      checkpoint,
    );
    if (result.accepted === false) throw this.importError(result);
    const importedEnvelope: GameSaveEnvelope = {
      ...envelope,
      campaign: {
        ...campaign,
        world: result.state.world,
        dominionHistory: mergeDominion(
          current.dominionHistory,
          campaign.dominionHistory,
        ),
      },
      eventKeys: [...new Set(envelope.eventKeys)],
    };
    return { envelope: clone(importedEnvelope), result };
  }

  async commitImported(
    slotId: string,
    label: string,
    envelope: GameSaveEnvelope,
    chapter: number,
    regionId: RegionId,
  ): Promise<SaveSlotSummary> {
    const validated = await this.importSave(envelope);
    return this.persist(slotId, label, validated.envelope, chapter, regionId);
  }

  async appendRunLedger(
    runId: string,
    events: readonly DominionEvent[],
    eventKeys: readonly string[],
    kind: SaveKind = "campaign",
  ): Promise<void> {
    await this.init();
    if (kind === "showcase-replay") return;
    const transaction = this.database().transaction("runs", "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore("runs");
    try {
      const current = (await requestValue(store.get(runId))) as
        | RunLedgerRecord
        | undefined;
      if (current !== undefined &&
        (!validLedger(current) || current.runId !== runId || current.kind !== "campaign"))
        throw new SaveRepositoryError(
          "corrupt",
          "The run ledger is malformed.",
        );
      store.put({
        runId,
        kind,
        dominionHistory: mergeDominion(current?.dominionHistory ?? [], events),
        eventKeys: [...new Set([...(current?.eventKeys ?? []), ...eventKeys])],
        updatedAt: Date.now(),
      } satisfies RunLedgerRecord);
      await done;
    } catch (error) {
      try {
        await done;
      } catch {
        // An aborted IndexedDB transaction rolls back the ledger write.
      }
      throw await this.writeError(error);
    }
  }

  async readRunLedger(runId: string): Promise<RunLedgerRecord | null> {
    await this.init();
    const transaction = this.database().transaction("runs", "readonly");
    const done = transactionDone(transaction);
    const value = await requestValue(
      transaction.objectStore("runs").get(runId),
    );
    await done;
    if (value === undefined) return null;
    if (!validLedger(value))
      throw new SaveRepositoryError(
        "corrupt",
        "The run ledger is malformed.",
        await this.recovery(),
      );
    return clone(value);
  }

  async saveSettings(
    settings: GameSettings,
    bindings: InputBindingMaps,
  ): Promise<void> {
    if (!isGameSettings(settings) || !isInputBindingMaps(bindings)) {
      throw new SaveRepositoryError("invalid-schema", "Settings or device bindings are malformed.");
    }
    await this.init();
    const transaction = this.database().transaction("settings", "readwrite");
    const done = transactionDone(transaction);
    transaction
      .objectStore("settings")
      .put({
        id: "global",
        settings: clone(settings),
        bindings: clone(bindings),
      } satisfies SaveSettingsRecord);
    try {
      await done;
    } catch (error) {
      throw await this.writeError(error);
    }
  }

  async loadSettings(): Promise<SaveSettingsRecord | null> {
    await this.init();
    const transaction = this.database().transaction("settings", "readonly");
    const done = transactionDone(transaction);
    const record = await requestValue(
      transaction.objectStore("settings").get("global"),
    );
    await done;
    if (record === undefined) return null;
    const settings = isRecord(record) && isRecord(record.settings) && record.settings.heroCompanions === undefined
      ? { ...record.settings, heroCompanions: { ...DEFAULT_HERO_COMPANIONS } }
      : isRecord(record) ? record.settings : null;
    if (
      !isRecord(record) ||
      record.id !== "global" ||
      !isGameSettings(settings) ||
      !isInputBindingMaps(record.bindings)
    ) {
      throw new SaveRepositoryError(
        "corrupt",
        "Settings record is malformed.",
        await this.recovery(),
      );
    }
    return {
      id: "global",
      settings: clone(settings),
      bindings: clone(record.bindings),
    };

  }

  async removeSlot(slotId: string): Promise<void> {
    await this.init();
    const transaction = this.database().transaction("slots", "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore("slots").delete(slotId);
    try {
      await done;
    } catch (error) {
      throw await this.writeError(error);
    }
  }

  async recovery(): Promise<{
    slots: readonly SaveSlotSummary[];
    exportAvailable: boolean;
  }> {
    try {
      const slots = await this.listSlots();
      return { slots, exportAvailable: slots.length > 0 };
    } catch {
      return { slots: [], exportAvailable: false };
    }
  }

  close(): void {
    this.databaseHandle?.close();
    this.databaseHandle = null;
  }

  private migrationContext(): MigrationContext {
    return { scope: this.scope, chapters: this.chapters, layoutMigrations: this.layoutMigrations };
  }

  private migrationError(error: unknown, recovery: { slots: readonly SaveSlotSummary[]; exportAvailable: boolean }): SaveRepositoryError {
    if (error instanceof SaveRepositoryError) return error;
    if (error instanceof ChapterMigrationError) {
      const code: SaveErrorCode = error.code === "layout-revision" ? "layout-revision" : error.code === "invalid-schema" ? "invalid-schema" : "corrupt";
      return new SaveRepositoryError(code, error.message + " The stored save was not changed; export it for recovery.", recovery);
    }
    throw error;
  }

  /**
   * Strict pure upgrade of a stored/imported envelope to schema 3, in memory only. Schema 1 additionally gains:
   * production scope, Aren, derived safe-boundary resume, campaign/checkpoint worlds with derived companion progression.
   * Parts that cannot migrate are left unchanged so strict schema-3 validators reject them as corrupt. Legacy parties are
   * reduced at this boundary; installed layout revisions still validate through ChapterMigrationError.
   */
  private upgradeEnvelope(raw: unknown): GameSaveEnvelope {
    if (!isRecord(raw)) return raw as unknown as GameSaveEnvelope;
    let value: Record<string, unknown> = raw;
    if (value.schemaVersion === LEGACY_SAVE_FORMAT_SCHEMA_VERSION) {
      const campaign = migrateCampaignStateV1(value.campaign);
      const legacyCheckpoint = value.checkpoint;
      let checkpoint: unknown = legacyCheckpoint;
      if (campaign && isRecord(legacyCheckpoint) && legacyCheckpoint.schemaVersion === LEGACY_SCHEMA_VERSION) {
        const world = migrateWorldV1(legacyCheckpoint.world, campaign.dominionHistory);
        if (world) checkpoint = { ...legacyCheckpoint, schemaVersion: 2, world };
      }
      value = {
        ...value,
        schemaVersion: SAVE_FORMAT_SCHEMA_VERSION,
        scope: "production",
        campaign: campaign ?? value.campaign,
        checkpoint,
        progress: isRecord(value.progress) ? withLegacySession(value.progress, this.migrationContext()) : value.progress,
      };
    }
    if (raw.schemaVersion === 1 || raw.schemaVersion === 2) {
      const progress = value.progress;
      const party = isRecord(progress) ? migrateCompanionParty(progress.party) : null;
      value = { ...value, schemaVersion: SAVE_FORMAT_SCHEMA_VERSION,
        ...(party && isRecord(progress) ? { progress: { ...progress, party } } : {}) };
    }
    const progress = value.progress;
    if (value.schemaVersion === SAVE_FORMAT_SCHEMA_VERSION && isRecord(progress) && isChapterSessionMetadata(progress.session) && isRecord(progress.worldFacts)
      && typeof progress.regionId === "string") {
      const carrier = {
        regionId: progress.regionId as RegionId,
        ...(isRecord(progress.safeSpawn) ? { safeSpawn: progress.safeSpawn as unknown as CampaignSafeSpawn } : {}),
        worldFacts: progress.worldFacts as Record<string, boolean | number | string>,
        session: progress.session,
      };
      const migrated = migrateLayout(carrier, this.chapters, this.layoutMigrations);
      if (migrated !== carrier) {
        value = { ...value, progress: { ...progress, session: migrated.session, ...(migrated.safeSpawn ? { safeSpawn: migrated.safeSpawn } : {}) } };
      }
    }
    return value as unknown as GameSaveEnvelope;
  }

  private validCampaign(campaign: CampaignState, runId: string): boolean {
    const leaders = ["koro", "asha", "ruun", "luma", "nyra", "solkar"];
    if (
      campaign.schemaVersion !== SCHEMA_VERSION ||
      campaign.runId !== runId ||
      !Array.isArray(campaign.dominionHistory) ||
      !campaign.dominionHistory.every(
        (event, index) =>
          isRecord(event) &&
          Number.isInteger(event.sequence) &&
          event.sequence >= index + 1 &&
          leaders.includes(event.leaderId),
      )
    )
      return false;
    const checkpoint: CheckpointSnapshot = {
      kind: "campaign-checkpoint",
      schemaVersion: SCHEMA_VERSION,
      runId,
      world: campaign.world,
    };
    return importCheckpoint(campaign, checkpoint).accepted;
  }
  private validateEnvelope(
    value: unknown,
  ):
    | { accepted: true }
    | {
        accepted: false;
        reason:
          | "future_schema"
          | "schema_mismatch"
          | "run_mismatch"
          | "invalid_snapshot"
          | "scope_mismatch"
          | "replay_isolated";
      } {
    if (
      !isRecord(value) ||
      value.format !== "wild-crown-save" ||
      typeof value.schemaVersion !== "number"
    ) {
      return { accepted: false, reason: "invalid_snapshot" };
    }
    if (value.schemaVersion > SAVE_FORMAT_SCHEMA_VERSION)
      return { accepted: false, reason: "future_schema" };
    if (value.schemaVersion !== SAVE_FORMAT_SCHEMA_VERSION)
      return { accepted: false, reason: "schema_mismatch" };
    if (value.scope !== this.scope)
      return { accepted: false, reason: "scope_mismatch" };
    if (value.kind === "showcase-replay")
      return { accepted: false, reason: "replay_isolated" };
    if (
      value.kind !== "campaign" ||
      typeof value.runId !== "string" ||
      !isRecord(value.campaign) ||
      !isRecord(value.checkpoint)
    ) {
      return { accepted: false, reason: "invalid_snapshot" };
    }
    const campaign = value.campaign as unknown as CampaignState;
    const checkpoint = value.checkpoint as unknown as CheckpointSnapshot;
    if (campaign.runId !== value.runId || checkpoint.runId !== value.runId)
      return { accepted: false, reason: "run_mismatch" };
    if (
      !Array.isArray(value.eventKeys) ||
      !value.eventKeys.every((key) => typeof key === "string") ||
      !this.validCampaign(campaign, value.runId) ||
      (value.progress !== null &&
        value.progress !== undefined &&
        !validProgress(value.progress, this.chapters))
    ) {
      return { accepted: false, reason: "invalid_snapshot" };
    }
    const result = importCheckpoint(campaign, checkpoint);
    return result.accepted ? { accepted: true } : result;
  }

  private importError(result: ImportResult): SaveRepositoryError {
    if (result.accepted)
      return new SaveRepositoryError(
        "corrupt",
        "Save import validation did not return a rejection.",
      );
    const code: SaveErrorCode =
      result.reason === "future_schema"
        ? "future-schema"
        : result.reason === "run_mismatch"
          ? "run-mismatch"
          : result.reason === "replay_isolated"
            ? "replay-isolated"
            : result.reason === "schema_mismatch"
              ? "invalid-schema"
              : "corrupt";
    return new SaveRepositoryError(
      code,
      "Save import was rejected without overwriting local progress.",
    );
  }

  private validationError(
    reason: string,
    recovery: { slots: readonly SaveSlotSummary[]; exportAvailable: boolean },
  ): SaveRepositoryError {
    if (reason === "future_schema")
      return new SaveRepositoryError(
        "future-schema",
        "This save uses a future schema and was not changed.",
        recovery,
      );
    if (reason === "run_mismatch")
      return new SaveRepositoryError(
        "run-mismatch",
        "The save belongs to a different journey.",
        recovery,
      );
    if (reason === "scope_mismatch")
      return new SaveRepositoryError(
        "scope-mismatch",
        "The save belongs to a different persistence scope and was not changed.",
        recovery,
      );
    if (reason === "replay_isolated")
      return new SaveRepositoryError(
        "replay-isolated",
        "Replay saves cannot be loaded as campaign progress.",
        recovery,
      );
    return new SaveRepositoryError(
      "corrupt",
      "Save slot is corrupt or uses an unsupported schema.",
      recovery,
    );
  }

  private async writeError(error: unknown): Promise<SaveRepositoryError> {
    const name = (error as { name?: string } | null)?.name;
    if (name === "QuotaExceededError") {
      return new SaveRepositoryError(
        "quota",
        "Browser storage is full. Existing saves were preserved; export or remove an older slot before saving again.",
        await this.recovery(),
      );
    }
    if (error instanceof SaveRepositoryError) return error;
    return new SaveRepositoryError(
      "transaction",
      "Save transaction failed and was rolled back.",
      await this.recovery(),
    );
  }
}
