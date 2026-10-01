import {
  createNewRun,
  importCheckpoint,
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
  type GameSettings,
  type InputBindingMaps,
  type RegionId,
} from "../contracts.js";

export const SAVE_DATABASE_NAME = "wild-crown-saves";
export const SAVE_DATABASE_VERSION = 2 as const;
export const SAVE_FORMAT_SCHEMA_VERSION = 1 as const;

type SaveKind = "campaign" | "showcase-replay";

export type SaveErrorCode =
  | "unavailable"
  | "corrupt"
  | "future-schema"
  | "invalid-schema"
  | "run-mismatch"
  | "replay-isolated"
  | "quota"
  | "transaction"
  | "transaction"
  | "not-found";

export interface CampaignProgressRecord {
  chapter: number;
  regionId: RegionId;
  activeQuestIds: string[];
  completedQuestIds: string[];
  completedObjectiveIds: string[];
  trackedObjectiveId: string | null;
  party: { combat?: string; utility?: string; scout: "vara" };
  choices: Record<string, string>;
  worldFacts: Record<string, boolean | number | string>;
  ending: "dominion" | "severance" | "living_pact" | null;
  eventLog: unknown[];
  eventKeys?: string[];
  revision?: number;
  safeSpawn?: CampaignSafeSpawn;
}

export interface GameSaveEnvelope {
  format: "wild-crown-save";
  schemaVersion: typeof SAVE_FORMAT_SCHEMA_VERSION;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isRegionId = (value: unknown): value is RegionId =>
  typeof value === "string" && REGIONS.some((region) => region.id === value);
const isStringMap = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");

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
    isOneOf(value.controlGlyphs, ["keyboard-mouse", "gamepad"])
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

function validProgress(value: unknown): value is CampaignProgressRecord {
  if (!isRecord(value)) return false;
  const stringArray = (field: unknown): field is string[] =>
    Array.isArray(field) && field.every((entry) => typeof entry === "string");
  const facts = value.worldFacts;
  const party = value.party;
  const safeSpawn = value.safeSpawn;
  const validSafeSpawn =
    safeSpawn === undefined ||
    (isRecord(safeSpawn) &&
      typeof safeSpawn.regionId === "string" &&
      typeof safeSpawn.routeId === "string" &&
      typeof safeSpawn.cameraAnchorId === "string" &&
      isRecord(safeSpawn.position) &&
      [safeSpawn.position.x, safeSpawn.position.y, safeSpawn.position.z].every(
        Number.isFinite,
      ));
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
    party.scout === "vara" &&
    (party.combat === undefined || typeof party.combat === "string") &&
    (party.utility === undefined || typeof party.utility === "string") &&
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
        typeof entry.idempotencyKey === "string",
    ) &&
    (value.eventKeys === undefined || stringArray(value.eventKeys)) &&
    (value.revision === undefined || Number.isInteger(value.revision)) &&
    validSafeSpawn
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

  constructor(private readonly factory: IDBFactory = globalThis.indexedDB) {}

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
        SAVE_DATABASE_NAME,
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
      .filter(
        (row): row is Record<string, unknown> =>
          isRecord(row) &&
          typeof row.slotId === "string" &&
          typeof row.label === "string" &&
          typeof row.runId === "string" &&
          typeof row.updatedAt === "number" &&
          typeof row.chapter === "number" &&
          isRegionId(row.regionId) &&
          (row.kind === "campaign" || row.kind === "showcase-replay"),
      )
      .map((row) => ({
        slotId: row.slotId as string,
        label: row.label as string,
        runId: row.runId as string,
        kind: row.kind as SaveKind,
        updatedAt: row.updatedAt as number,
        chapter: row.chapter as number,
        regionId: row.regionId as RegionId,
      }))
      .sort((left, right) => right.updatedAt - left.updatedAt);
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
    await this.init();
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
    if (progress && !validProgress(progress)) {
      throw new SaveRepositoryError(
        "invalid-schema",
        "Campaign progress is malformed.",
      );
    }

    const envelope: GameSaveEnvelope = {
      format: "wild-crown-save",
      schemaVersion: SAVE_FORMAT_SCHEMA_VERSION,
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
    const updatedAt = Date.now();
    const summary: SaveSlotSummary = {
      slotId,
      label,
      runId: envelope.runId,
      kind: envelope.kind,
      updatedAt,
      chapter,
      regionId,
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
    const rawLedger = await requestValue(
      transaction.objectStore("runs").get(slot.runId),
    );
    await done;
    if (rawLedger !== undefined && !validLedger(rawLedger)) {
      throw new SaveRepositoryError(
        "corrupt",
        "The run ledger is malformed; no stored data was changed.",
        await this.recovery(),
      );
    }
    const validation = this.validateEnvelope(slot.envelope);
    if (validation.accepted === false) {
      throw this.validationError(validation.reason, await this.recovery());
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
    return clone(slot.envelope);
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
    const envelope = await this.loadSlot(slotId, current.runId);
    const summary = (await this.listSlots()).find((slot) => slot.slotId === slotId);
    if (!summary) {
      throw new SaveRepositoryError("corrupt", "Save slot summary is missing.", await this.recovery());
    }
    if (!envelope.checkpoint || !envelope.campaign) {
      throw new SaveRepositoryError(
        "corrupt",
        "Campaign checkpoint is missing.",
        await this.recovery(),
      );
    }
    const imported = importCheckpoint(
      {
        ...current,
        dominionHistory: mergeDominion(
          current.dominionHistory,
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
      chapter: summary.chapter,
      regionId: summary.regionId,
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
    if (value.schemaVersion !== SAVE_FORMAT_SCHEMA_VERSION) {
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
    const campaign = value.campaign as unknown as CampaignState;
    const checkpoint = value.checkpoint as unknown as CheckpointSnapshot;
    const envelope = value as unknown as GameSaveEnvelope;
    if (
      !this.validCampaign(campaign, envelope.runId) ||
      (envelope.progress !== null &&
        envelope.progress !== undefined &&
        !validProgress(envelope.progress))
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
    envelope.campaign = {
      ...campaign,
      world: result.state.world,
      dominionHistory: mergeDominion(
        current.dominionHistory,
        campaign.dominionHistory,
      ),
    };
    envelope.eventKeys = [...new Set(envelope.eventKeys)];
    return { envelope: clone(envelope), result };
  }

  async commitImported(
    slotId: string,
    label: string,
    envelope: GameSaveEnvelope,
    chapter: number,
    regionId: RegionId,
  ): Promise<SaveSlotSummary> {
    const validated = await this.importSave(envelope);
    await this.init();
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
      if (current && !validLedger(current))
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
    if (
      !isRecord(record) ||
      record.id !== "global" ||
      !isGameSettings(record.settings) ||
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
      settings: clone(record.settings),
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

  private validCampaign(campaign: CampaignState, runId: string): boolean {
    const leaders = ["koro", "asha", "ruun", "luma", "nyra", "solkar"];
    if (
      campaign.schemaVersion !== 1 ||
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
      schemaVersion: 1,
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
        !validProgress(value.progress))
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
