import { createCheckpoint, createNewRun, recordLeaderDominion } from "../../packages/campaign/src/index.js";
import { CampaignDirector } from "../../src/game/campaign/CampaignDirector.js";
import { DEFAULT_GAME_SETTINGS, DEFAULT_GAMEPAD_BINDINGS, DEFAULT_KEYBOARD_BINDINGS } from "../../src/game/contracts.js";
import { SaveRepository, SaveRepositoryError, type GameSaveEnvelope } from "../../src/game/storage/SaveRepository.js";
import { REGIONS } from "../../src/content/campaign.js";

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

    await check("fresh Director slot load adopts stored journey after native reopen and isolates two runs", async () => {
      const saved = new CampaignDirector({ saves: repository, runId: "saved-journey" });
      await saved.processEvent({ type: "fragment", eventId: "adoption-sky", idempotencyKey: "adoption:sky", fragmentId: "heartroot-sky", sourceId: "vara" });
      await saved.save("adopt-a", "Existing journey");
      const expected = saved.snapshot();
      const unrelated = new CampaignDirector({ saves: otherRepository, runId: "unrelated-journey" });
      await unrelated.processEvent({ type: "encounter-resolved", eventId: "other-asha", idempotencyKey: "other:asha", encounterId: "encounter-asha", resolution: "dominated", actorIds: ["asha"] });
      await unrelated.save("adopt-b", "Independent journey");
      repository.close();
      otherRepository.close();
      const before = await rawRecords();
      const fresh = new CampaignDirector({ saves: repository, runId: "fresh-title" });
      const loaded = await fresh.load("adopt-a");
      assert(loaded.runId === "saved-journey" && loaded.campaign.runId === loaded.runId, "fresh title did not adopt stored identity");
      equal(loaded.fragments, expected.fragments, "selected branch fragments");
      equal(loaded.completedObjectiveIds, expected.completedObjectiveIds, "selected objective branch");
      equal(loaded.lastSafeCheckpoint?.safeSpawn, expected.lastSafeCheckpoint?.safeSpawn, "stored safe spawn");
      await rejected(repository.loadSlot("adopt-a", "fresh-title"), "run-mismatch");
      equal(await rawRecords(), before, "ordinary load wrote persisted data");
      const switched = await unrelated.load("adopt-a");
      equal(switched.campaign.dominionHistory, [], "other journey's Dominion contaminated selected run");
      await fresh.processEvent({ type: "semantic-interaction", eventId: "adopted-inspect", idempotencyKey: "adopted:inspect", actorId: "aren", interactionId: "adoption-inspect", kind: "inspect", targetId: "adoption-inspect", position: { x: 0, y: 0, z: 0 } });
      assert((await repository.readRunLedger("saved-journey"))?.eventKeys.includes("adopted:inspect"), "later event wrote wrong run ledger");
      equal((await repository.readRunLedger("unrelated-journey"))?.dominionHistory.map(event => event.leaderId), ["asha"], "unrelated ledger was replaced");
      const newGame = fresh.startNewRun("explicit-new-game");
      equal(newGame.campaign.dominionHistory, [], "New Game inherited Dominion");
      equal(newGame.fragments, [], "New Game inherited fragments");
      assert(newGame.lastSafeCheckpoint?.runId === "explicit-new-game", "New Game checkpoint owns wrong run");
    });

    await check("adopted journey checkpoint saves to an actual new slot and survives reopen", async () => {
      const director = new CampaignDirector({ saves: repository, runId: "save-after-adoption-title" });
      await director.load("adopt-a");
      await director.processEvent({ type: "fragment", eventId: "adopted-canopy", idempotencyKey: "adopted:canopy", fragmentId: "heartroot-canopy", sourceId: "koro" });
      const slotId = await director.saveNewSlot("Adopted journey checkpoint");
      const expected = director.snapshot();
      repository.close();
      const fresh = new CampaignDirector({ saves: repository, runId: "fresh-after-adopted-save" });
      const loaded = await fresh.load(slotId);
      assert(loaded.runId === "saved-journey", "saving after adoption minted or retained the wrong journey");
      equal(loaded.fragments, expected.fragments, "adopted checkpoint world did not persist");
      equal(loaded.lastSafeCheckpoint?.progress.eventKeys, expected.lastSafeCheckpoint?.progress.eventKeys, "adopted checkpoint branch audit did not persist");
      const independent = fresh.startNewRun("new-game-save-isolated");
      const independentSlot = await fresh.saveNewSlot("Independent new game");
      repository.close();
      const reopened = await director.load(independentSlot);
      assert(reopened.runId === independent.runId, "New Game slot retained the adopted ID");
      equal(reopened.fragments, [], "New Game save retained previous fragments");
      equal(reopened.campaign.dominionHistory, [], "New Game save retained previous Dominion");
      assert((await repository.loadSlot(slotId)).runId === "saved-journey", "New Game save replaced the adopted slot");
    });

    await check("legacy adoption uses one native record even if the slot is replaced after its read", async () => {
      const original = createNewRun("snapshot-original");
      const replacement = createNewRun("snapshot-replacement");
      await repository.saveCheckpoint("snapshot-selection", "Original", createCheckpoint(original), original, 0, "greenwake", []);
      class ReplacingRepository extends SaveRepository {
        protected override async loadRecord(...args: Parameters<SaveRepository["loadSlot"]>) {
          const selected = await super.loadRecord(...args);
          await otherRepository.saveCheckpoint("snapshot-selection", "Replacement", createCheckpoint(replacement), replacement, 5, "sunmane-expanse", []);
          return selected;
        }
      }
      const snapshotRepository = new ReplacingRepository(factory);
      try {
        const director = new CampaignDirector({ saves: snapshotRepository, runId: "snapshot-title" });
        const adopted = await director.load("snapshot-selection");
        assert((await repository.loadSlot("snapshot-selection")).runId === replacement.runId, "probe did not actually replace the slot");
        assert(adopted.runId === original.runId && adopted.chapter === 0 && adopted.regionId === "greenwake", "adoption mixed original envelope with replacement metadata");
      } finally { snapshotRepository.close(); }
    });

    await check("fresh same-run older slot/import keeps durable Dominion but not later objective event keys", async () => {
      const runId = "native-old-slot-journey";
      const source = new CampaignDirector({ saves: repository, runId });
      await source.save("older-branch", "Before fragment");
      const olderExport = await source.exportSave("older-branch");
      const fragment = { type: "fragment" as const, eventId: "rewind-sky", idempotencyKey: "rewind:sky", fragmentId: "heartroot-sky" as const, sourceId: "vara" };
      await source.processEvent(fragment);
      await source.processEvent({ type: "encounter-resolved", eventId: "rewind-koro", idempotencyKey: "rewind:koro", encounterId: "encounter-koro", resolution: "dominated", actorIds: ["koro"] });
      await source.save("newer-branch", "After Dominion");
      repository.close();
      const fresh = new CampaignDirector({ saves: repository, runId: "another-title" });
      const loaded = await fresh.load("older-branch");
      assert(loaded.runId === runId, "older branch identity was not adopted");
      equal(loaded.campaign.dominionHistory.map(event => event.leaderId), ["koro"], "older slot erased durable Dominion");
      equal(loaded.fragments, [], "older slot did not rewind world");
      assert(!loaded.lastSafeCheckpoint?.progress.eventKeys.includes(fragment.idempotencyKey), "later branch event key poisoned old branch");
      await fresh.processEvent(fragment);
      equal(fresh.snapshot().fragments, ["heartroot-sky"], "repeated branch event was suppressed after rewind");
      const imported = await fresh.importSave(olderExport, "older-imported", "Older imported branch");
      equal(imported.campaign.dominionHistory.map(event => event.leaderId), ["koro"], "old import erased Dominion");
      equal(imported.fragments, [], "old import retained later branch fragments");
      assert(!imported.lastSafeCheckpoint?.progress.eventKeys.includes(fragment.idempotencyKey), "import adopted durable objective keys");
      const ledger = await repository.readRunLedger(runId);
      assert(ledger?.eventKeys.includes(fragment.idempotencyKey), "durable event audit was erased");
      repository.close();
      const unrelated = new CampaignDirector({ saves: otherRepository, runId: "import-title" });
      const reopened = await unrelated.load("older-imported");
      equal(reopened.campaign.dominionHistory.map(event => event.leaderId), ["koro"], "imported old slot lost ledger on reopen");
      const oldRunCheckpoint = await unrelated.captureCheckpoint();
      unrelated.startNewRun("independent-after-import");
      assert(await unrelated.restoreCheckpoint(oldRunCheckpoint) === false, "cross-run checkpoint restore was allowed");
    });

    await check("replay loads/imports remain rejected and failed Director loads preserve live branch", async () => {
      const valid: GameSaveEnvelope = JSON.parse(await repository.exportSlot("stable"));
      const replay = { ...valid, kind: "showcase-replay" as const };
      const database = await rawDatabase();
      const transaction = database.transaction("slots", "readwrite");
      const completed = done(transaction);
      const stored = await request(transaction.objectStore("slots").get("stable"));
      transaction.objectStore("slots").put({ ...stored, slotId: "replay-stored", kind: "showcase-replay", envelope: replay });
      await completed;
      database.close();
      const before = await rawRecords();
      const director = new CampaignDirector({ saves: repository, runId: "preserved-on-failure" });
      const current = director.snapshot();
      await rejected(director.load("replay-stored"), "replay-isolated");
      await rejected(director.importSave(JSON.stringify(replay), "stable", "Must not replace"), "replay-isolated");
      equal(director.snapshot(), current, "rejected replay replaced live branch");
      equal(await rawRecords(), before, "rejected replay wrote data");
    });

    await check("colliding showcase identity cannot promote replay history through campaign load/import", async () => {
      const before = await rawRecords();
      const exported = await repository.exportSlot("stable");
      const director = new CampaignDirector({ saves: repository, runId: "replay-title" });
      const replayDominion = async () => {
        director.startShowcase(initial.runId);
        await director.processEvent({ type: "encounter-resolved", eventId: "replay-asha", idempotencyKey: "replay:asha", encounterId: "encounter-asha", resolution: "dominated", actorIds: ["asha"] });
        equal(director.snapshot().campaign.dominionHistory.map(event => event.leaderId), ["asha"], "replay scenario did not exercise transient Dominion");
      };
      await replayDominion();
      equal((await director.load("stable")).campaign.dominionHistory, [], "ordinary load promoted replay history");
      equal(await rawRecords(), before, "replay/load changed durable history");
      await replayDominion();
      const imported = await director.importSave(exported, "campaign-from-replay", "Campaign selection");
      equal(imported.campaign.dominionHistory, [], "import promoted replay history");
      assert(!imported.replay && imported.runId === initial.runId, "campaign selection did not leave replay");
      equal((await repository.readRunLedger(initial.runId))?.dominionHistory, [], "replay history became durable");
    });

    await check("non-default safe spawn and exact camp encounter reset survive native save/reopen", async () => {
      // Imported branch-entry fixture, not proof of organically reaching Bamboo.
      const source = new CampaignDirector({ saves: repository, runId: "native-camp-checkpoint" });
      const initialSafe = await source.captureCheckpoint();
      const region = REGIONS.find(item => item.id === "blood-bamboo-valley")!;
      const node = region.navigation.nodes.find(item => item.id === "bamboo-hunter-camp")!;
      const safeSpawn = { regionId: region.id, position: node.position, routeId: node.id, cameraAnchorId: region.cameraAnchors[0]!.id };
      assert(node.id !== region.navigation.nodes[0]!.id, "spawn probe accidentally uses default root");
      assert(await source.restoreCheckpoint({ ...initialSafe, safeSpawn,
        progress: { ...initialSafe.progress, chapter: 2, regionId: region.id, activeQuestIds: ["the-ash-hunters"], completedObjectiveIds: [], worldFacts: { ...initialSafe.progress.worldFacts, chapter: 2 } },
      }), "branch-entry checkpoint rejected");
      await source.save("camp-checkpoint", "Camp checkpoint");
      repository.close();
      const fresh = new CampaignDirector({ saves: repository, runId: "fresh-camp-title" });
      const loaded = await fresh.load("camp-checkpoint");
      equal(loaded.lastSafeCheckpoint?.safeSpawn, safeSpawn, "non-default safe spawn was replaced");
      equal(loaded.lastSafeCheckpoint?.encounterReset, { policy: "restart-from-entry", encounterId: "camp-hunters", actorIds: ["hunter-melee-west", "hunter-melee-east", "hunter-ranged"] }, "camp reset used archetypes or wrong encounter");
      await fresh.processEvent({ type: "encounter-resolved", eventId: "native-camp-resolved", idempotencyKey: "native:camp-resolved", encounterId: "camp-hunters", resolution: "subdued", actorIds: ["hunter-melee-west", "hunter-melee-east", "hunter-ranged"] });
      await fresh.save("camp-resolved", "Resolved camp");
      repository.close();
      const restored = new CampaignDirector({ saves: repository, runId: "post-camp-title" });
      equal((await restored.load("camp-resolved")).lastSafeCheckpoint?.encounterReset, { policy: "restart-from-entry", encounterId: null, actorIds: [] }, "resolved encounter restarted on load");
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
      const director = new CampaignDirector({ saves: repository, runId: "future-recovery-current" });
      const current = director.snapshot();
      await rejected(director.load("future-stored"), "future-schema");
      await rejected(director.load("corrupt-stored"), "corrupt");
      equal(director.snapshot(), current, "corrupt/future load replaced live Director state");
      equal(await repository.exportRawSlot("future-stored"), rawFuture, "future raw export changed");
      equal(await repository.exportRawSlot("corrupt-stored"), rawCorrupt, "corrupt raw export changed");
      assert((await repository.recovery()).slots.some((slot) => slot.slotId === "stable"), "good recovery slot missing");
      equal(await rawRecords(), before, "recovery changed stored data");
    });

    await check("corrupt slot metadata rejects adoption without replacing live state or persisted records", async () => {
      const database = await rawDatabase();
      const transaction = database.transaction("slots", "readwrite");
      const completed = done(transaction);
      const store = transaction.objectStore("slots");
      const valid = await request(store.get("adopt-a"));
      const invalid = [
        { slotId: "metadata-chapter", chapter: 99 },
        { slotId: "metadata-region", regionId: "unknown-region" },
        { slotId: "metadata-progress", chapter: 3, regionId: "moonpine-ridge" },
        { slotId: "metadata-identity", runId: "another-journey" },
        { slotId: "metadata-no-run", runId: undefined },
      ];
      for (const metadata of invalid) store.put({ ...valid, ...metadata });
      await completed;
      database.close();
      const before = await rawRecords();
      const director = new CampaignDirector({ saves: repository, runId: "metadata-preserved-current" });
      const current = director.snapshot();
      for (const metadata of invalid) {
        const raw = await repository.exportRawSlot(metadata.slotId);
        await rejected(director.load(metadata.slotId), metadata.slotId === "metadata-identity" ? "run-mismatch" : "corrupt");
        equal(director.snapshot(), current, "corrupt metadata replaced live state");
        equal(await repository.exportRawSlot(metadata.slotId), raw, "corrupt metadata raw recovery changed");
      }
      const exported: GameSaveEnvelope = JSON.parse(await repository.exportSlot("adopt-a"));
      await rejected(repository.commitImported("adopt-a", "Mismatched location", exported, 3, "moonpine-ridge"), "corrupt");
      await rejected(repository.saveCheckpoint("adopt-a", "Invalid legacy chapter", checkpoint, initial, 99, "greenwake", []), "corrupt");
      const malformedCampaign = structuredClone(initial);
      Object.assign(malformedCampaign, { world: {} });
      await rejected(repository.saveCheckpoint("adopt-a", "Invalid campaign", checkpoint, malformedCampaign, 0, "greenwake", []), "corrupt");
      equal(await rawRecords(), before, "invalid slot write/load changed durable records");
    });

    await check("malformed durable ledger is preserved on slot load, save and append failure", async () => {
      const badRun = createNewRun("malformed-ledger-run");
      const badCheckpoint = createCheckpoint(badRun);
      await repository.saveCheckpoint("malformed-ledger-slot", "Preserve me", badCheckpoint, badRun, 0, "greenwake", []);
      const database = await rawDatabase();
      const transaction = database.transaction("runs", "readwrite");
      const completed = done(transaction);
      transaction.objectStore("runs").put({ runId: badRun.runId, kind: "campaign", dominionHistory: [null], eventKeys: [], updatedAt: 1 });
      await completed;
      database.close();
      const before = await rawRecords();
      const raw = await repository.exportRawSlot("malformed-ledger-slot");
      await rejected(repository.loadCampaign("malformed-ledger-slot", createNewRun("new-title")), "corrupt");
      await rejected(repository.saveCheckpoint("malformed-ledger-slot", "Must not replace", badCheckpoint, badRun, 0, "greenwake", []), "corrupt");
      await rejected(repository.appendRunLedger(badRun.runId, [], ["must-not-append"]), "corrupt");
      equal(await rawRecords(), before, "malformed ledger recovery changed stored data");
      equal(await repository.exportRawSlot("malformed-ledger-slot"), raw, "raw recovery changed old slot");
    });

    await check("synthetic QuotaExceededError after slot put aborts the real multi-store transaction", async () => {
      const director = new CampaignDirector({ saves: repository, runId: "quota-current" });
      await director.load("adopt-a");
      await director.processEvent({ type: "fragment", eventId: "quota-canopy", idempotencyKey: "quota:canopy", fragmentId: "heartroot-canopy", sourceId: "koro" });
      const before = await rawRecords();
      const current = director.snapshot();
      assert(!current.lastSafeCheckpoint?.worldCheckpoint.world.fragments.includes("heartroot-canopy"), "quota save probe did not advance beyond the recovery checkpoint");
      const exported = await repository.exportSlot("stable");
      // Synthetic error only: deliberately does not exhaust the physical browser quota.
      IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
        if (this.transaction.db.name === databaseName && this.name === "runs") {
          throw new DOMException("Q04 synthetic quota fault after slot write", "QuotaExceededError");
        }
        return quotaPut.apply(this, args);
      };
      try {
        await rejected(repository.saveCheckpoint("stable", "Must roll back", checkpoint, recordLeaderDominion(initial, "koro"), 0, "greenwake", ["quota-uncommitted"]), "quota");
        await rejected(director.importSave(exported, "stable", "Quota import must roll back"), "quota");
        await rejected(director.save("adopt-a", "Failed adopted-run save"), "quota");
        await rejected(director.saveNewSlot("Failed adopted-run new slot"), "quota");
      } finally { IDBObjectStore.prototype.put = quotaPut; }
      equal(await rawRecords(), before, "synthetic quota partially committed the slot or ledger");
      equal(director.snapshot(), current, "failed import replaced live Director state");
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

    await check("malformed historical choice fields reject native load/import/commit and preserve raw recovery", async () => {
      const valid: GameSaveEnvelope = JSON.parse(await repository.exportSlot("adopt-a"));
      const invalidSlots: { slotId: string; envelope: GameSaveEnvelope }[] = [];
      for (const field of ["eventId", "idempotencyKey", "choiceId", "optionId"] as const) {
        for (const [name, invalid] of [["missing", undefined], ["null", null], ["number", 7], ["array", []], ["empty", ""], ["whitespace", "  "]] as const) {
          const envelope = structuredClone(valid);
          const choice: Record<string, unknown> = { type: "choice", eventId: "historic-choice", idempotencyKey: "historic:choice", choiceId: "pack-leadership", optionId: "ruun", leaderId: "ruun", dominion: false };
          if (invalid === undefined) delete choice[field];
          else choice[field] = invalid;
          envelope.progress!.eventLog.push(choice);
          invalidSlots.push({ slotId: `invalid-choice-${field}-${name}`, envelope });
        }
      }
      for (const [field, invalidValues] of [
        ["leaderId", [null, 7, [], false]],
        ["dominion", [null, "true", [], 7]],
      ] as const) {
        for (const [index, invalid] of invalidValues.entries()) {
          const envelope = structuredClone(valid);
          const choice: Record<string, unknown> = { type: "choice", eventId: "historic-choice", idempotencyKey: "historic:choice", choiceId: "pack-leadership", optionId: "ruun", leaderId: "ruun", dominion: false };
          choice[field] = invalid;
          envelope.progress!.eventLog.push(choice);
          invalidSlots.push({ slotId: `invalid-choice-${field}-${index}`, envelope });
        }
      }
      const database = await rawDatabase();
      const transaction = database.transaction("slots", "readwrite");
      const completed = done(transaction);
      const store = transaction.objectStore("slots");
      const good = await request(store.get("adopt-a"));
      for (const invalid of invalidSlots) {
        store.put({ ...good, slotId: invalid.slotId, envelope: invalid.envelope });
      }
      await completed;
      database.close();
      const director = new CampaignDirector({ saves: repository, runId: "choice-recovery-current" });
      await director.processEvent({ type: "fragment", eventId: "choice-current-sky", idempotencyKey: "choice:current-sky", fragmentId: "heartroot-sky", sourceId: "vara" });
      const current = director.snapshot();
      const before = await rawRecords();
      const goodRaw = await repository.exportRawSlot("adopt-a");
      for (const invalid of invalidSlots) {
        const raw = await repository.exportRawSlot(invalid.slotId);
        await rejected(director.load(invalid.slotId), "corrupt");
        await rejected(director.importSave(JSON.stringify(invalid.envelope), "adopt-a", "Must preserve good slot"), "corrupt");
        await rejected(repository.commitImported("adopt-a", "Must preserve good slot", invalid.envelope, 0, "greenwake"), "corrupt");
        await rejected(repository.exportSlot(invalid.slotId), "corrupt");
        equal(director.snapshot(), current, `${invalid.slotId} changed live Director state`);
        equal(await repository.exportRawSlot(invalid.slotId), raw, `${invalid.slotId} raw recovery changed`);
      }
      equal(await rawRecords(), before, "rejected choice records changed good/bad slots or ledgers");
      equal(await repository.exportRawSlot("adopt-a"), goodRaw, "good recovery slot changed");
      const recovery = await repository.recovery();
      assert(recovery.exportAvailable && recovery.slots.some(slot => slot.slotId === "adopt-a"), "good slot/raw export recovery unavailable");
      const historic = structuredClone(valid);
      const historicChoice = { type: "choice", eventId: "historic-valid", idempotencyKey: "historic:valid", choiceId: "pack-leadership", optionId: "ruun", leaderId: "solkar", dominion: true };
      historic.progress!.eventLog.push(historicChoice);
      const accepted = await director.importSave(JSON.stringify(historic), "historic-metadata-choice", "Valid historical metadata");
      equal(accepted.campaign.dominionHistory, valid.campaign!.dominionHistory, "optional metadata granted campaign Dominion");
      equal((await repository.loadSlot("historic-metadata-choice")).progress!.eventLog.at(-1), historicChoice, "valid optional metadata was rewritten");
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
