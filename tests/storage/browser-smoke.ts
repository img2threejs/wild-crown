import { createCheckpoint, createNewRun, recordLeaderDominion } from "../../packages/campaign/src/index.js";
import { CampaignDirector } from "../../src/game/campaign/CampaignDirector.js";
import { DEFAULT_GAME_SETTINGS, DEFAULT_GAMEPAD_BINDINGS, DEFAULT_KEYBOARD_BINDINGS } from "../../src/game/contracts.js";
import { SaveRepository, SaveRepositoryError, type GameSaveEnvelope } from "../../src/game/storage/SaveRepository.js";

// Parent-only native browser exercise. Never opens or writes the production database.
const databaseName = `wild-crown-q04-${crypto.randomUUID()}`;
const handles = new Set<IDBDatabase>();
const checks: { name: string; result: "pass" | "fail"; detail?: string }[] = [];
const startedAt = new Date().toISOString();
const status = document.querySelector<HTMLPreElement>("#test-status")!;
const nativeFactory = globalThis.indexedDB;
const factory = new Proxy(nativeFactory, {
  get(target, property) {
    if (property === "open") return (_name: string, version: number) => {
      const request = target.open(databaseName, version);
      request.addEventListener("success", () => handles.add(request.result));
      return request;
    };
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const repository = new SaveRepository(factory);
const otherRepository = new SaveRepository(factory);
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}
async function rejected(operation: Promise<unknown>, expected: string): Promise<void> {
  try { await operation; } catch (error) {
    assert(error instanceof SaveRepositoryError && error.code === expected, `Expected ${expected}, got ${String(error)}`);
    return;
  }
  throw new Error(`Expected rejection: ${expected}`);
}
async function request<T>(pending: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    pending.addEventListener("success", () => resolve(pending.result), { once: true });
    pending.addEventListener("error", () => reject(pending.error), { once: true });
  });
}
async function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error), { once: true });
  });
}
async function check(name: string, exercise: () => Promise<void>): Promise<void> {
  try {
    await exercise();
    checks.push({ name, result: "pass" });
  } catch (error) {
    checks.push({ name, result: "fail", detail: String(error) });
    throw error;
  }
  status.textContent = JSON.stringify({ databaseName, checks }, null, 2);
}
async function rawDatabase(version = 2): Promise<IDBDatabase> {
  const database = await request(nativeFactory.open(databaseName, version));
  handles.add(database);
  return database;
}
async function rawRecords(): Promise<unknown> {
  const database = await rawDatabase();
  try {
    const transaction = database.transaction(["slots", "runs"], "readonly");
    const completed = done(transaction);
    const [slots, runs] = await Promise.all([
      request(transaction.objectStore("slots").getAll()),
      request(transaction.objectStore("runs").getAll()),
    ]);
    await completed;
    return { slots, runs };
  } finally { database.close(); }
}

async function run(): Promise<void> {
  let cleanup = false;
  let failure: string | null = null;
  const quotaPut = IDBObjectStore.prototype.put;
  try {
    await check("real v1→v2 migration preserves effective keyboard and gamepad maps", async () => {
      const opening = nativeFactory.open(databaseName, 1);
      opening.onupgradeneeded = () => {
        for (const [store, keyPath] of [["slots", "slotId"], ["runs", "runId"], ["settings", "id"]]) {
          opening.result.createObjectStore(store, { keyPath });
        }
      };
      const seed = await request(opening);
      handles.add(seed);
      const transaction = seed.transaction("settings", "readwrite");
      const completed = done(transaction);
      transaction.objectStore("settings").put({ id: "global", settings: { ...DEFAULT_GAME_SETTINGS, musicVolume: 0.37 },
        bindings: { light: "KeyJ", heavy: "Gamepad Button 8", map: "KeyM" } });
      await completed;
      seed.close();
      await repository.init();
      const migrated = await repository.loadSettings();
      const keyboard: Record<string, string> = { ...DEFAULT_KEYBOARD_BINDINGS, light: "KeyJ", map: "KeyM" };
      delete keyboard.heavy;
      equal(migrated?.bindings, { keyboard, gamepad: { ...DEFAULT_GAMEPAD_BINDINGS, heavy: "Gamepad Button 8" } }, "effective maps");
      assert(migrated?.settings.musicVolume === 0.37, "settings changed during migration");
      await repository.saveSettings(migrated.settings, { keyboard: {}, gamepad: {} });
      repository.close();
      await repository.init();
      equal((await repository.loadSettings())?.bindings, { keyboard: {}, gamepad: {} }, "intentional empty maps were refilled");
    });

    const initial = createNewRun("q04-native-run");
    const checkpoint = createCheckpoint(initial);
    await check("checkpoint close/reopen/load/export/import and fresh repository commit", async () => {
      await repository.saveCheckpoint("stable", "Stable", checkpoint, initial, 0, "greenwake", ["arrival"]);
      repository.close();
      const restored = await repository.loadCampaign("stable", initial);
      equal(restored.checkpoint, checkpoint, "checkpoint reload");
      equal(restored.campaign.world, initial.world, "world reload");
      const exported = await repository.exportSlot("stable");
      const imported = await repository.importSave(exported, initial);
      assert(imported.result?.accepted, "valid import rejected");
      await otherRepository.commitImported("imported", "Imported", imported.envelope, 0, "greenwake");
      equal((await otherRepository.loadSlot("imported")).checkpoint, checkpoint, "import commit changed checkpoint");
    });

    await check("malformed/future imports and direct commits preserve all valid slots and ledgers", async () => {
      const before = await rawRecords();
      const valid: GameSaveEnvelope = JSON.parse(await repository.exportSlot("stable"));
      await rejected(repository.importSave("{"), "corrupt");
      await rejected(repository.importSave({ ...valid, schemaVersion: 99 }), "future-schema");
      const malformed = structuredClone(valid);
      Object.assign(malformed.campaign!, { dominionHistory: [null] });
      await rejected(repository.importSave(malformed), "corrupt");
      await rejected(repository.commitImported("stable", "Invalid", malformed, 0, "greenwake"), "corrupt");
      const future = structuredClone(valid);
      Object.assign(future, { schemaVersion: 99 });
      await rejected(repository.commitImported("stable", "Future", future, 0, "greenwake"), "future-schema");
      equal(await rawRecords(), before, "rejected data changed persisted records");
    });

    await check("corrupt and future stored slots remain raw-exportable without changing good slots", async () => {
      const database = await rawDatabase();
      const transaction = database.transaction("slots", "readwrite");
      const completed = done(transaction);
      const store = transaction.objectStore("slots");
      const valid = await request(store.get("stable"));
      store.put({ ...valid, slotId: "future-stored", envelope: { ...valid.envelope, schemaVersion: 99 } });
      store.put({ ...valid, slotId: "corrupt-stored", envelope: { ...valid.envelope, campaign: null } });
      await completed;
      database.close();
      const before = await rawRecords();
      const rawFuture = await repository.exportRawSlot("future-stored");
      const rawCorrupt = await repository.exportRawSlot("corrupt-stored");
      await rejected(repository.loadSlot("future-stored"), "future-schema");
      await rejected(repository.exportSlot("corrupt-stored"), "corrupt");
      equal(await repository.exportRawSlot("future-stored"), rawFuture, "future raw export changed");
      equal(await repository.exportRawSlot("corrupt-stored"), rawCorrupt, "corrupt raw export changed");
      assert((await repository.recovery()).slots.some((slot) => slot.slotId === "stable"), "good recovery slot missing");
      equal(await rawRecords(), before, "recovery changed stored data");
    });

    await check("synthetic QuotaExceededError after slot put aborts the real multi-store transaction", async () => {
      const before = await rawRecords();
      // Synthetic error only: deliberately does not exhaust the physical browser quota.
      IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
        if (this.transaction.db.name === databaseName && this.name === "runs") {
          throw new DOMException("Q04 synthetic quota fault after slot write", "QuotaExceededError");
        }
        return quotaPut.apply(this, args);
      };
      try {
        await rejected(repository.saveCheckpoint("stable", "Must roll back", checkpoint, recordLeaderDominion(initial, "koro"), 0, "greenwake", ["quota-uncommitted"]), "quota");
      } finally { IDBObjectStore.prototype.put = quotaPut; }
      equal(await rawRecords(), before, "synthetic quota partially committed the slot or ledger");
    });

    await check("explicit native transaction abort rolls back slot and ledger", async () => {
      const before = await rawRecords();
      const database = await rawDatabase();
      try {
        const transaction = database.transaction(["slots", "runs"], "readwrite");
        const completed = done(transaction);
        transaction.objectStore("slots").put({ slotId: "aborted-native" });
        transaction.objectStore("runs").put({ runId: "aborted-native" });
        transaction.abort();
        await completed.catch(() => undefined);
      } finally { database.close(); }
      equal(await rawRecords(), before, "native aborted transaction committed records");
    });

    await check("concurrent same-run writes retain every event key and Dominion history on reopen", async () => {
      const concurrentRun = "q04-concurrent-run";
      await Promise.all([
        repository.appendRunLedger(concurrentRun, [{ sequence: 1, leaderId: "koro" }], ["event:koro"]),
        otherRepository.appendRunLedger(concurrentRun, [{ sequence: 1, leaderId: "asha" }], ["event:asha"]),
      ]);
      repository.close();
      otherRepository.close();
      const ledger = await repository.readRunLedger(concurrentRun);
      equal(ledger?.eventKeys.slice().sort(), ["event:asha", "event:koro"], "lost concurrent event keys");
      equal(ledger?.dominionHistory.map((event) => event.leaderId).sort(), ["asha", "koro"], "lost concurrent Dominion");
      equal(ledger?.dominionHistory.map((event) => event.sequence), [1, 2], "nonmonotonic sequence");
      const director = new CampaignDirector({ saves: repository, runId: "q04-director-run" });
      await Promise.all([
        director.processEvent({ type: "fragment", eventId: "native-sky", idempotencyKey: "native:sky", fragmentId: "heartroot-sky", sourceId: "vara" }),
        director.processEvent({ type: "semantic-interaction", eventId: "native-inspect", idempotencyKey: "native:inspect", actorId: "aren", interactionId: "q04-inspect", kind: "inspect", targetId: "q04-inspect", position: { x: 0, y: 0, z: 0 } }),
      ]);
      await director.save("world-events", "Concurrent world events");
      repository.close();
      const saved = await repository.loadSlot("world-events");
      assert(saved.campaign?.world.fragments.includes("heartroot-sky"), "fragment event was not durable");
      assert(saved.progress?.eventLog.some((event: unknown) => typeof event === "object" && event !== null && "idempotencyKey" in event && event.idempotencyKey === "native:inspect"), "inspect event was not durable");
      const eventLedger = await repository.readRunLedger("q04-director-run");
      assert(eventLedger?.eventKeys.includes("native:sky") && eventLedger.eventKeys.includes("native:inspect"), "concurrent Director history was lost");
      await repository.appendRunLedger(initial.runId, [{ sequence: 1, leaderId: "koro" }], ["dominion:koro"]);
      const oldCheckpoint = await repository.loadCampaign("stable", initial);
      equal(oldCheckpoint.checkpoint.world, initial.world, "older checkpoint world changed");
      equal(oldCheckpoint.campaign.dominionHistory, [{ sequence: 1, leaderId: "koro" }], "older checkpoint erased Dominion");
    });

    await check("versionchange close, native open failure and successful reconnect", async () => {
      otherRepository.close();
      const newer = await rawDatabase(3);
      newer.close();
      await rejected(repository.init(), "unavailable");
      await rejected(repository.init(), "unavailable");
      await request(nativeFactory.deleteDatabase(databaseName));
      await repository.init();
      await repository.saveCheckpoint("reconnected", "Reconnected", checkpoint, initial, 0, "greenwake", []);
      equal((await repository.loadSlot("reconnected")).checkpoint, checkpoint, "reconnection failed to persist");
    });
  } catch (error) {
    failure = String(error);
  } finally {
    IDBObjectStore.prototype.put = quotaPut;
    repository.close();
    otherRepository.close();
    for (const handle of handles) handle.close();
    try { await request(nativeFactory.deleteDatabase(databaseName)); cleanup = true; }
    catch (error) { failure ??= `Cleanup failed: ${String(error)}`; }
    const report = { databaseName, startedAt, endedAt: new Date().toISOString(), checks, cleanup,
      result: failure === null ? "pass" : "fail", failure,
      quotaEvidence: "synthetic QuotaExceededError with a real IndexedDB transaction; physical quota exhaustion NOT exercised",
      gameReady: false };
    Object.assign(window, { q04StorageSmoke: report });
    status.textContent = JSON.stringify(report, null, 2);
    document.documentElement.dataset.smokeResult = report.result;
  }
}
// Bound every native request, including cleanup: stalled work is an explicit failure.
const timeout = window.setTimeout(() => {
  repository.close(); otherRepository.close();
  for (const handle of handles) handle.close();
  IDBObjectStore.prototype.put = originalPut;
  const report = { databaseName, startedAt, endedAt: new Date().toISOString(), result: "fail", failure: "30-second smoke deadline exceeded", checks, cleanup: false, gameReady: false };
  Object.assign(window, { q04StorageSmoke: report });
  status.textContent = JSON.stringify(report, null, 2);
  document.documentElement.dataset.smokeResult = "fail";
}, 30_000);
const originalPut = IDBObjectStore.prototype.put;
void run().finally(() => window.clearTimeout(timeout));
