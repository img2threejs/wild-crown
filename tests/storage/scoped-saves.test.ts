import assert from "node:assert/strict";
import test from "node:test";
import { createCheckpoint, createNewRun, type CampaignState } from "../../packages/campaign/src/index.js";
import { REGIONS } from "../../src/content/world.js";
import { CampaignDirector } from "../../src/game/campaign/CampaignDirector.js";
import { autosaveSlotId } from "../../src/game/campaign/session.js";
import type { ChapterRuntimeDefinition, LayoutRevisionMigration, WorldEvent } from "../../src/game/contracts.js";
import {
  CANDIDATE_SAVE_DATABASE_NAME, SAVE_DATABASE_NAME, SaveRepository, SaveRepositoryError, type GameSaveEnvelope,
} from "../../src/game/storage/SaveRepository.js";
import { FakeIDBFactory } from "./fakeIndexedDB.js";

const code = (expected: string) => (error: unknown) => error instanceof SaveRepositoryError && error.code === expected;
const sky: WorldEvent = { type: "fragment", eventId: "sky", idempotencyKey: "story:sky", fragmentId: "heartroot-sky", sourceId: "vara" };
const koroDominion: WorldEvent = { type: "encounter-resolved", eventId: "dom-koro", idempotencyKey: "story:dom-koro", encounterId: "encounter-koro", resolution: "dominated", actorIds: ["koro"] };
const production = (factory: FakeIDBFactory) => new SaveRepository(factory.asFactory());
const candidate = (factory: FakeIDBFactory) => new SaveRepository(factory.asFactory(), { scope: "candidate-chapters" });
const rows = (factory: FakeIDBFactory, database: string) => ({ slots: factory.rows(database, "slots"), runs: factory.rows(database, "runs") });

test("candidate and production scopes use distinct databases and isolate identical run ids", async () => {
  const factory = new FakeIDBFactory();
  const prod = new CampaignDirector({ saves: production(factory), runId: "shared-run" });
  const cand = new CampaignDirector({ saves: candidate(factory), runId: "shared-run" });
  await prod.processEvent(sky);
  await cand.processEvent(koroDominion);
  assert.deepEqual([...new Set(factory.opened)].sort(), [CANDIDATE_SAVE_DATABASE_NAME, SAVE_DATABASE_NAME].sort());
  assert.equal(CANDIDATE_SAVE_DATABASE_NAME, "wild-crown-candidate-chapter-saves");
  const productionRows = rows(factory, SAVE_DATABASE_NAME);
  const candidateRows = rows(factory, CANDIDATE_SAVE_DATABASE_NAME);
  assert.equal(productionRows.slots.length, 1);
  assert.equal(candidateRows.slots.length, 1);
  assert.deepEqual((productionRows.runs[0] as { dominionHistory: unknown[] }).dominionHistory, []);
  assert.deepEqual((candidateRows.runs[0] as { dominionHistory: { leaderId: string }[] }).dominionHistory.map((event) => event.leaderId), ["koro"]);
  assert.deepEqual((await production(factory).listSlots()).map((slot) => slot.scope), ["production"]);
  assert.deepEqual((await candidate(factory).listSlots()).map((slot) => slot.scope), ["candidate-chapters"]);
});

test("a payload from the other scope is rejected before any stored data changes", async () => {
  const factory = new FakeIDBFactory();
  const prod = new CampaignDirector({ saves: production(factory), runId: "prod-run" });
  await prod.processEvent(sky);
  const cand = new CampaignDirector({ saves: candidate(factory), runId: "cand-run" });
  await cand.processEvent(sky);
  const exported = await production(factory).exportSlot(autosaveSlotId("prod-run"));
  const before = rows(factory, CANDIDATE_SAVE_DATABASE_NAME);
  const repository = candidate(factory);
  await assert.rejects(repository.importSave(exported), code("scope-mismatch"));
  const envelope = JSON.parse(exported) as GameSaveEnvelope;
  await assert.rejects(repository.commitImported("stolen", "Stolen", envelope, 0, "greenwake"), code("scope-mismatch"));
  await assert.rejects(cand.importSave(exported, "stolen", "Stolen"), code("scope-mismatch"));
  assert.deepEqual(rows(factory, CANDIDATE_SAVE_DATABASE_NAME), before);
  // The reverse direction is isolated too.
  const candidateExport = await candidate(factory).exportSlot(autosaveSlotId("cand-run"));
  await assert.rejects(production(factory).importSave(candidateExport), code("scope-mismatch"));
  // A misplaced production-scope row inside the candidate database is neither listed nor loadable.
  factory.seed(CANDIDATE_SAVE_DATABASE_NAME, "slots", "slotId", [factory.rows(SAVE_DATABASE_NAME, "slots")[0]]);
  assert.equal((await candidate(factory).listSlots()).some((slot) => slot.runId === "prod-run"), false);
  await assert.rejects(candidate(factory).loadSlot(autosaveSlotId("prod-run")), code("scope-mismatch"));
});

for (const boundary of ["runs.get", "slots.put", "runs.put", "commit", "quota-on-slot-put"] as const) {
  test(`slot+ledger write is atomic at the ${boundary} boundary: nothing published, nothing stored, retry is idempotent`, async () => {
    const factory = new FakeIDBFactory();
    const saves = production(factory);
    const director = new CampaignDirector({ saves, runId: "atomic-run" });
    await director.processEvent(sky);
    const stored = rows(factory, SAVE_DATABASE_NAME);
    const published = director.snapshot();
    let notifications = 0;
    const unsubscribe = director.subscribe(() => { notifications += 1; });
    notifications = 0;
    const faulted = factory.transactionCount + 1;
    factory.fault = (context) => {
      if (context.transactionIndex !== faulted) return undefined;
      if (boundary === "commit") return context.operation === "commit" ? "abort" : undefined;
      if (boundary === "runs.get") return context.store === "runs" && context.operation === "get" ? "error" : undefined;
      if (boundary === "slots.put") return context.store === "slots" && context.operation === "put" ? "error" : undefined;
      if (boundary === "runs.put") return context.store === "runs" && context.operation === "put" ? "error" : undefined;
      return context.store === "slots" && context.operation === "put" ? "quota" : undefined;
    };
    await assert.rejects(director.processEvent(koroDominion), code(boundary === "quota-on-slot-put" ? "quota" : "transaction"));
    factory.fault = null;
    assert.deepEqual(rows(factory, SAVE_DATABASE_NAME), stored, "slot and ledger are unchanged");
    assert.deepEqual(director.snapshot(), published, "the Director published nothing and keeps the prior state");
    assert.equal(notifications, 0);
    assert.equal(director.isEventCommitted(koroDominion.idempotencyKey), false);
    // Lost-write retry: the same event commits exactly once.
    await director.processEvent(koroDominion);
    const afterRetry = rows(factory, SAVE_DATABASE_NAME);
    assert.notDeepEqual(afterRetry, stored);
    const writes = factory.transactionCount;
    await director.processEvent(koroDominion);
    assert.equal(factory.transactionCount, writes, "a duplicate of a committed event performs no write");
    assert.equal((afterRetry.runs[0] as { dominionHistory: unknown[] }).dominionHistory.length, 1);
    assert.equal(director.snapshot().campaign.dominionHistory.length, 1);
    unsubscribe();
  });
}

test("a full run history survives a browser restart through the per-run autosave slot", async () => {
  const factory = new FakeIDBFactory();
  const first = new CampaignDirector({ saves: production(factory), runId: "restart-run" });
  await first.processEvent(sky);
  await first.processEvent({ type: "rescue", eventId: "vara-tend", idempotencyKey: "story:vara", targetId: "vara", locationId: "canopy-waterfall", safe: true });
  await first.processEvent(koroDominion);
  const before = first.snapshot();
  const restarted = new CampaignDirector({ saves: production(factory), runId: "unrelated-title-run" });
  const slots = await production(factory).listSlots();
  assert.equal(slots.length, 1);
  assert.equal(slots[0]!.autosave, true);
  const loaded = await restarted.load(slots[0]!.slotId);
  assert.equal(loaded.runId, "restart-run");
  assert.deepEqual(loaded.worldFacts, before.worldFacts);
  assert.deepEqual(loaded.completedObjectiveIds, before.completedObjectiveIds);
  assert.deepEqual(loaded.campaign.world, before.campaign.world);
  assert.deepEqual(loaded.campaign.dominionHistory, before.campaign.dominionHistory);
  assert.deepEqual(loaded.session, before.session);
  assert.equal(loaded.revision, before.revision);
  assert.equal(loaded.companions.vara.recruited, true);
  assert.equal(loaded.companions.koro.dominionLevel, 25);
});

test("every committed event overwrites one stable autosave slot; manual slots stay separate snapshots", async () => {
  const factory = new FakeIDBFactory();
  const saves = production(factory);
  const director = new CampaignDirector({ saves, runId: "slot-run" });
  await director.processEvent(sky);
  const manual = await director.saveNewSlot("Manual before");
  await director.processEvent(koroDominion);
  const slots = await saves.listSlots();
  assert.deepEqual(slots.map((slot) => [slot.autosave, slot.label]).sort(), [[false, "Manual before"], [true, "Autosave"]]);
  const manualEnvelope = await saves.loadSlot(manual);
  assert.equal(manualEnvelope.progress!.eventKeys!.includes(koroDominion.idempotencyKey), false);
  const autosave = await saves.loadSlot(autosaveSlotId("slot-run"));
  assert.equal(autosave.progress!.eventKeys!.includes(koroDominion.idempotencyKey), true);
});

test("an old snapshot plus a newer ledger cannot erase Dominion; branch event keys stay local to the snapshot", async () => {
  const factory = new FakeIDBFactory();
  const saves = production(factory);
  const director = new CampaignDirector({ saves, runId: "ledger-run" });
  await director.processEvent(sky);
  const manual = await director.saveNewSlot("Before dominion");
  await director.processEvent(koroDominion);
  const reopened = new CampaignDirector({ saves: production(factory), runId: "title" });
  const loaded = await reopened.load(manual);
  assert.deepEqual(loaded.campaign.dominionHistory.map((event) => event.leaderId), ["koro"]);
  assert.equal(loaded.worldFacts["dominion:koro"], undefined, "objective/branch facts roll back with the old snapshot");
  assert.equal(loaded.companions.koro.dominionLevel, 25, "Dominion floor is reapplied from the run ledger");
  assert.equal(loaded.companions.koro.storyFlags["possession-risk"], undefined, "an unrecruited companion carries no possession flag");
  assert.equal(reopened.isEventCommitted(koroDominion.idempotencyKey), false);
});

// ---- schema 1 fixtures ------------------------------------------------------------------------------------------------

function legacyRows(options: { chapter?: number; regionId?: string; completed?: string[]; nodeId?: string; runId?: string } = {}) {
  const runId = options.runId ?? "legacy-run";
  const chapter = options.chapter ?? 1;
  const regionId = options.regionId ?? "whispering-canopy";
  const region = REGIONS.find((item) => item.id === regionId)!;
  const node = region.navigation.nodes.find((item) => item.id === (options.nodeId ?? region.navigation.nodes[0]!.id))!;
  const { companions: _drop, ...legacyWorld } = structuredClone(createNewRun(runId).world);
  void _drop;
  legacyWorld.fragments = ["heartroot-sky", "heartroot-canopy"];
  legacyWorld.factions.canopy.bondTier = 2;
  const world = legacyWorld;
  const envelope = {
    format: "wild-crown-save", schemaVersion: 1, kind: "campaign", runId,
    campaign: { schemaVersion: 1, runId, world, dominionHistory: [{ sequence: 1, leaderId: "koro" }] },
    checkpoint: { kind: "campaign-checkpoint", schemaVersion: 1, runId, world },
    progress: {
      chapter, regionId, activeQuestIds: ["fallen-scout"], completedQuestIds: options.completed ?? ["prologue"], completedObjectiveIds: [],
      trackedObjectiveId: null, party: { scout: "vara", utility: "koro" }, choices: {}, worldFacts: { chapter }, ending: null, eventLog: [],
      eventKeys: ["legacy:key"], revision: 3,
      safeSpawn: { regionId, position: { ...node.position }, routeId: node.id, cameraAnchorId: region.cameraAnchors[0]!.id },
    },
    eventKeys: ["legacy:key"], savedAt: 1,
  };
  return {
    slot: { slotId: "old-slot", label: "Old", runId, kind: "campaign", updatedAt: 5, chapter, regionId, envelope },
    ledger: { runId, kind: "campaign", dominionHistory: [{ sequence: 1, leaderId: "koro" }], eventKeys: ["legacy:key"], updatedAt: 5 },
  };
}
function seedLegacy(factory: FakeIDBFactory, options: Parameters<typeof legacyRows>[0] = {}, database = SAVE_DATABASE_NAME) {
  const fixture = legacyRows(options);
  factory.seed(database, "slots", "slotId", [fixture.slot]);
  factory.seed(database, "runs", "runId", [fixture.ledger]);
  factory.seed(database, "settings", "id", []);
  return fixture;
}

test("a stored schema-1 slot migrates on read, keeps its raw original, and is rewritten only by an explicit save", async () => {
  const factory = new FakeIDBFactory();
  const fixture = seedLegacy(factory);
  const raw = rows(factory, SAVE_DATABASE_NAME);
  const saves = production(factory);
  const [summary] = await saves.listSlots();
  assert.deepEqual(
    { scope: summary!.scope, heroId: summary!.heroId, segmentId: summary!.segmentId, autosave: summary!.autosave },
    { scope: "production", heroId: "aren", segmentId: "canopy", autosave: false },
  );
  const envelope = await saves.loadSlot("old-slot");
  assert.equal(envelope.schemaVersion, 3);
  assert.equal(envelope.scope, "production");
  assert.equal(envelope.progress!.session.heroId, "aren");
  assert.equal(envelope.progress!.session.resume.layoutRevision, 0);
  assert.equal(envelope.progress!.session.resume.segmentId, "canopy");
  assert.equal(envelope.campaign!.world.companions.koro.recruited, true);
  assert.equal(envelope.campaign!.world.companions.koro.bondLevel, 50, "tier 2 → documented personal Bond 50 for a recruited companion");
  assert.equal(envelope.campaign!.world.companions.asha.recruited, false);
  const adopted = await saves.loadCampaign("old-slot", createNewRun("title"));
  assert.equal(adopted.campaign.world.companions.koro.dominionLevel, 25);
  assert.deepEqual(rows(factory, SAVE_DATABASE_NAME), raw, "reads never rewrite stored records");
  assert.equal((JSON.parse(await saves.exportRawSlot("old-slot")) as { envelope: { schemaVersion: number } }).envelope.schemaVersion, 1);
  const director = new CampaignDirector({ saves, runId: "title" });
  await director.load("old-slot");
  await director.save("old-slot", "Rewritten");
  const rewritten = factory.rows(SAVE_DATABASE_NAME, "slots").find((row) => (row as { slotId: string }).slotId === "old-slot") as { envelope: GameSaveEnvelope };
  assert.equal(rewritten.envelope.schemaVersion, 3);
  assert.equal(rewritten.envelope.scope, "production");
  assert.equal(fixture.slot.envelope.schemaVersion, 1);
});

test("a schema-1 export imports as production only; it can never be recognized as a candidate chapter run", async () => {
  const fixture = legacyRows({ runId: "v1-export" });
  const exported = JSON.stringify(fixture.slot.envelope);
  const factory = new FakeIDBFactory();
  const imported = await production(factory).importSave(exported);
  assert.equal(imported.envelope.schemaVersion, 3);
  assert.equal(imported.envelope.scope, "production");
  assert.equal(imported.envelope.campaign!.world.companions.koro.recruited, true);
  await assert.rejects(candidate(factory).importSave(exported), code("scope-mismatch"));
  assert.deepEqual(factory.rows(CANDIDATE_SAVE_DATABASE_NAME, "slots"), []);
});

test("future, corrupt and malformed stored or imported data never mutate stored saves", async () => {
  const factory = new FakeIDBFactory();
  const fixture = seedLegacy(factory);
  const future = structuredClone(fixture.slot);
  future.slotId = "future-slot";
  (future.envelope as { schemaVersion: number }).schemaVersion = 9;
  const corrupt = structuredClone(fixture.slot);
  corrupt.slotId = "corrupt-slot";
  (corrupt.envelope.campaign as { world: unknown }).world = { broken: true };
  factory.seed(SAVE_DATABASE_NAME, "slots", "slotId", [future, corrupt]);
  const saves = production(factory);
  const stored = rows(factory, SAVE_DATABASE_NAME);
  await assert.rejects(saves.loadSlot("future-slot"), code("future-schema"));
  await assert.rejects(saves.loadSlot("corrupt-slot"), code("corrupt"));
  const invalidImport = structuredClone(fixture.slot.envelope);
  (invalidImport.campaign as { world: unknown }).world = {};
  await assert.rejects(saves.importSave(invalidImport), code("corrupt"));
  await assert.rejects(saves.importSave({ ...fixture.slot.envelope, schemaVersion: 9 }), code("future-schema"));
  assert.deepEqual(rows(factory, SAVE_DATABASE_NAME), stored);
});

// ---- layout revisions ---------------------------------------------------------------------------------------------------

const greenwake = REGIONS.find((item) => item.id === "greenwake")!;
const greenwakeDefinition = (layoutRevision: number): ChapterRuntimeDefinition => ({
  segmentId: "greenwake", chapter: 0, regionId: "greenwake", layoutRevision,
  checkpoints: [{ id: "greenwake-arrival", regionId: "greenwake", nodeId: "greenwake-village-edge", cameraAnchorId: greenwake.cameraAnchors[0]!.id, radius: 4, requiresFacts: [], encounterId: null }],
  encounterEntries: [], exitRequirements: [],
});
const step = (nodeMap: Record<string, string>, fallbackNodeId: string): LayoutRevisionMigration => ({ regionId: "greenwake", fromRevision: 0, toRevision: 1, nodeMap, fallbackNodeId });

test("layout revision mapping: old spawn ids map explicitly, survive only when still safe, otherwise use the authored fallback", async () => {
  const cases: [string, Record<string, string>, string][] = [
    ["greenwake-forest-entry", { "greenwake-forest-entry": "greenwake-village-edge" }, "greenwake-village-edge"],
    ["greenwake-sap-pools", {}, "greenwake-sap-pools"],
    ["greenwake-forest-entry", { "greenwake-forest-entry": "greenwake-grove-gate" }, "greenwake-tutorial-yard"],
  ];
  for (const [oldNode, nodeMap, expected] of cases) {
    const factory = new FakeIDBFactory();
    seedLegacy(factory, { chapter: 0, regionId: "greenwake", nodeId: oldNode, completed: ["prologue"] });
    const raw = rows(factory, SAVE_DATABASE_NAME);
    const saves = new SaveRepository(factory.asFactory(), { chapters: [greenwakeDefinition(1)], layoutMigrations: [step(nodeMap, "greenwake-tutorial-yard")] });
    const envelope = await saves.loadSlot("old-slot");
    assert.equal(envelope.progress!.safeSpawn!.routeId, expected);
    assert.equal(envelope.progress!.session.resume.layoutRevision, 1);
    assert.deepEqual(rows(factory, SAVE_DATABASE_NAME), raw);
  }
});

test("an unknown or future layout revision fails with recovery data instead of a guessed player position", async () => {
  const factory = new FakeIDBFactory();
  seedLegacy(factory, { chapter: 0, regionId: "greenwake", completed: ["prologue"] });
  const raw = rows(factory, SAVE_DATABASE_NAME);
  const withoutStep = new SaveRepository(factory.asFactory(), { chapters: [greenwakeDefinition(1)] });
  await assert.rejects(withoutStep.loadSlot("old-slot"), code("layout-revision"));
  await assert.rejects(withoutStep.importSave(JSON.stringify(legacyRows({ chapter: 0, regionId: "greenwake", completed: ["prologue"] }).slot.envelope)), code("layout-revision"));
  const older = new SaveRepository(factory.asFactory(), { chapters: [greenwakeDefinition(0)] });
  const envelope = await older.loadSlot("old-slot");
  assert.equal(envelope.progress!.session.resume.layoutRevision, 0);
  assert.deepEqual(rows(factory, SAVE_DATABASE_NAME), raw);
  assert.equal((JSON.parse(await withoutStep.exportRawSlot("old-slot")) as { envelope: { schemaVersion: number } }).envelope.schemaVersion, 1);
});

test("a saved checkpoint id must exist for its region and segment", async () => {
  const factory = new FakeIDBFactory();
  const saves = new SaveRepository(factory.asFactory(), { chapters: [greenwakeDefinition(1)] });
  const director = new CampaignDirector({ saves, runId: "checkpoint-run" });
  await director.processEvent(sky);
  const stored = await saves.loadSlot(autosaveSlotId("checkpoint-run"));
  assert.equal(stored.progress!.session.resume.layoutRevision, 0, "prologue segment has no definition in this fixture");
  const invalid = structuredClone(stored);
  invalid.progress!.session.resume.checkpointId = "unknown-checkpoint";
  invalid.progress!.session.resume.segmentId = "prologue";
  await assert.rejects(saves.importSave(invalid), code("corrupt"));
  const wrongRegion = structuredClone(stored);
  wrongRegion.progress!.completedQuestIds = ["prologue"];
  wrongRegion.progress!.session.resume = { ...wrongRegion.progress!.session.resume, segmentId: "greenwake", layoutRevision: 1, checkpointId: "not-defined" };
  await assert.rejects(saves.importSave(wrongRegion), code("corrupt"));
  const valid = structuredClone(wrongRegion);
  valid.progress!.session.resume.checkpointId = "greenwake-arrival";
  assert.equal((await saves.importSave(valid)).envelope.progress!.session.resume.checkpointId, "greenwake-arrival");
});

test("incompatible party roles and unknown companions are rejected at the persistence boundary", async () => {
  const factory = new FakeIDBFactory();
  const saves = production(factory);
  const director = new CampaignDirector({ saves, runId: "party-run" });
  await director.processEvent(sky);
  const stored = await saves.loadSlot(autosaveSlotId("party-run"));
  for (const party of [
    { scout: "vara", combat: "koro", utility: "koro" },
    { scout: "vara", combat: "vara" },
    { scout: "vara", utility: "ghor" },
    { scout: "asha" },
  ]) {
    const invalid = structuredClone(stored);
    (invalid.progress as { party: unknown }).party = party;
    await assert.rejects(saves.importSave(invalid), code("corrupt"));
  }
  const campaign: CampaignState = stored.campaign!;
  assert.equal(createCheckpoint(campaign).schemaVersion, 2);
});
