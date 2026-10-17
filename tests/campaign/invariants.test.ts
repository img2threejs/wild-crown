import assert from "node:assert/strict";
import test from "node:test";
import { CampaignDirector, CampaignChoiceRejectedError } from "../../src/game/campaign/CampaignDirector.js";
import { CombatEngine } from "../../src/game/combat/CombatEngine.js";
import { SAVE_DATABASE_NAME, SaveRepository, SaveRepositoryError, type GameSaveEnvelope, type SaveSlotSummary } from "../../src/game/storage/SaveRepository.js";
import { FakeIDBFactory } from "../storage/fakeIndexedDB.js";
import { CHAPTERS, RETURN_BEATS } from "../../src/content/story.js";
import { QUESTS, REGIONS } from "../../src/content/campaign.js";
import { FACTION_IDS, FRAGMENT_IDS, REGION_IDS, REGIONAL_OBLIGATION_IDS } from "../../packages/campaign/src/index.js";
import type { CampaignSafeCheckpoint, RegionId, WorldEvent } from "../../src/game/contracts.js";
import type { CampaignState, CheckpointSnapshot } from "../../packages/campaign/src/index.js";

// Observe the Director's durable event boundary (the atomic autosave seam) without requiring browser IndexedDB.
class RecordingLedger extends SaveRepository {
  writes: [runId: string, dominionHistory: readonly { sequence: number; leaderId: string }[], eventKeys: readonly string[]][] = [];
  fail = false;
  override async saveAutosave(_checkpoint: CheckpointSnapshot, campaign: CampaignState, chapter: number, regionId: RegionId, eventKeys: readonly string[]): Promise<SaveSlotSummary> {
    if (this.fail) throw new Error("ledger refused the transaction");
    this.writes.push(structuredClone([campaign.runId, campaign.dominionHistory, [...eventKeys]]));
    return { slotId: "autosave:" + campaign.runId, label: "Autosave", runId: campaign.runId, kind: "campaign", updatedAt: 1, chapter, regionId,
      scope: "production", heroId: "aren", segmentId: null, checkpointId: null, autosave: true };
  }
}

// Keep real Director adoption and import reducers; replace only the persisted slot seam.
class CampaignSlotLedger extends RecordingLedger {
  envelope: GameSaveEnvelope | null = null;
  imports = 0;
  private summary(slotId = "history-slot", label = "History"): SaveSlotSummary {
    return { slotId, label, runId: this.envelope!.runId, kind: "campaign", updatedAt: 123,
      chapter: this.envelope!.progress!.chapter, regionId: this.envelope!.progress!.regionId,
      scope: "production", heroId: "aren", segmentId: null, checkpointId: null, autosave: false };
  }
  override async loadCampaign(slotId: string) {
    const envelope = structuredClone(this.envelope!);
    const summary = this.summary(slotId);
    return {
      campaign: envelope.campaign!,
      checkpoint: envelope.checkpoint!,
      eventKeys: envelope.eventKeys,
      progress: envelope.progress ?? null,
      chapter: summary.chapter,
      regionId: summary.regionId,
    };
  }
  override async listSlots(): Promise<SaveSlotSummary[]> {
    return [this.summary()];
  }
  override async commitImported(slotId: string, label: string, envelope: GameSaveEnvelope): Promise<SaveSlotSummary> {
    this.imports++;
    this.envelope = structuredClone(envelope);
    return this.summary(slotId, label);
  }
}

/** A real SaveRepository over an in-memory IndexedDB holding one schema-1 slot, so legacy loads run the real migration. */
function seededLegacyRepository(slotId: string, envelope: { runId: string; progress: { chapter: number; regionId: string } }): SaveRepository {
  const factory = new FakeIDBFactory();
  factory.seed(SAVE_DATABASE_NAME, "slots", "slotId", [{
    slotId, label: "History", runId: envelope.runId, kind: "campaign", updatedAt: 1,
    chapter: envelope.progress.chapter, regionId: envelope.progress.regionId, envelope,
  }]);
  factory.seed(SAVE_DATABASE_NAME, "runs", "runId", []);
  return new SaveRepository(factory.asFactory());
}

async function atChapter(director: CampaignDirector, chapter: number, mutate?: (checkpoint: CampaignSafeCheckpoint) => void) {
  const checkpoint = await director.captureCheckpoint();
  checkpoint.progress.chapter = chapter;
  checkpoint.progress.worldFacts.chapter = chapter;
  mutate?.(checkpoint);
  assert.equal(await director.restoreCheckpoint(checkpoint), true);
}

async function cleanseOrun(director: CampaignDirector) {
  for (const phaseIndex of [1, 2]) {
    await director.processEvent({
      type: "encounter-phase", eventId: `orun-phase-${phaseIndex}`,
      idempotencyKey: `orun-phase:${phaseIndex}`, encounterId: "encounter-orun",
      actorId: "orun", phaseId: `orun-phase-${phaseIndex}`, phaseIndex,
      state: "cleared", simulationTick: phaseIndex,
    });
  }
  await director.processEvent({
    type: "encounter-resolved", eventId: "orun-cleansed-event", idempotencyKey: "orun-cleansed-event",
    encounterId: "encounter-orun", actorIds: ["orun"], resolution: "cleansed",
  });
}

// Leadership decisions require the corresponding guardian's accepted cleanse.
async function cleanseRuun(director: CampaignDirector) {
  await director.processEvent({
    type: "encounter-resolved", eventId: "ruun-cleansed-event", idempotencyKey: "ruun-cleansed-event",
    encounterId: "encounter-ruun", actorIds: ["ruun"], resolution: "cleansed",
  });
}

async function cleanseSolkar(director: CampaignDirector) {
  await director.processEvent({
    type: "encounter-resolved", eventId: "solkar-cleansed-event", idempotencyKey: "solkar-cleansed-event",
    encounterId: "encounter-solkar", actorIds: ["solkar"], resolution: "cleansed",
  });
}

function choiceEvent(choiceId: string, optionId: string, key: string): WorldEvent {
  return { type: "choice", eventId: key, idempotencyKey: key, choiceId, optionId };
}

for (const [choiceId, first, alternative, chapter] of [
  ["pack-leadership", "dominion-ruun", "luma", 3],
  ["marek-fate", "leave", "cleanse", 4],
  ["river-route", "repair", "break-dam", 4],
  ["sunmane-resolution", "exile", "bond", 5],
  ["crown-council", "decline", "willing", 5],
  ["chapter-six-response", "ask", "signal", 6],
  ["final-ending", "severance", "dominion", 8],
] as const) {
  test(`${choiceId} rejects a different resolution and replays the same option without a write`, async () => {
    const saves = new RecordingLedger(undefined);
    const director = new CampaignDirector({ runId: `immutable-${choiceId}`, saves });
    await atChapter(director, chapter, (checkpoint) => {
      if (choiceId === "chapter-six-response") {
        checkpoint.progress.worldFacts.refugeOpen = true;
        checkpoint.progress.worldFacts.wardenCall = false;
      }
    });
    if (choiceId === "pack-leadership") await cleanseRuun(director);
    if (choiceId === "sunmane-resolution") await cleanseSolkar(director);
    if (choiceId === "final-ending") await cleanseOrun(director);
    await director.choose(choiceId, first);
    const before = director.snapshot();
    const persisted = structuredClone(saves.writes);
    await assert.rejects(director.choose(choiceId, alternative), /committed resolution/);
    await assert.rejects(director.processEvent(choiceEvent(choiceId, alternative, "fresh-conflicting-key")), /committed resolution/);
    assert.deepEqual(director.snapshot(), before);
    assert.deepEqual(saves.writes, persisted);
    assert.deepEqual(await director.choose(choiceId, first), before);
    assert.deepEqual(await director.processEvent(choiceEvent(choiceId, first, "fresh-replay-key")), before);
    assert.deepEqual(saves.writes, persisted);
    assert.deepEqual((await director.captureCheckpoint()).progress.eventKeys, before.lastSafeCheckpoint?.progress.eventKeys);
    if (choiceId === "pack-leadership") {
      assert.deepEqual(director.snapshot().campaign.dominionHistory, [{ sequence: 1, leaderId: "ruun" }]);
      assert.equal(director.ending().available, false);
    }
  });
}

test("exile reaches visibility and council interaction consumers, clears stale party slots, and survives restore/recommit", async () => {
  const director = new CampaignDirector({ runId: "exile-consumers" });
  await atChapter(director, 5, (checkpoint) => {
    // Explicit imported stale party fixture, not an organic recruitment path.
    checkpoint.progress.party = { companionId: "solkar" };
    checkpoint.worldCheckpoint.world.fragments = ["heartroot-crown"];
  });
  // The Sunmane regional-leadership guardian must be cleansed before the exile path commits.
  await cleanseSolkar(director);
  await director.choose("sunmane-resolution", "exile");
  const exiled = director.snapshot();
  assert.equal(exiled.campaign.world.factions.crown.leaderStatus, "exiled");
  assert.equal(exiled.worldFacts.solkarPresent, false);
  assert.equal(exiled.worldFacts["solkar-exiled"], true);
  assert.deepEqual(exiled.party, {});
  const engine = new CombatEngine();
  const region = REGIONS.find((item) => item.id === "sunmane-expanse")!;
  const councilPosition = region.entities.find((entity) => entity.interactionId === "crown-council")!.position;
  const loadCouncil = (worldFacts = exiled.worldFacts, position = councilPosition) =>
    engine.loadRegion({ regionId: region.id, runId: exiled.runId, presentActorIds: ["solkar", "council-envoy"],
      playerPosition: position, worldFacts });
  loadCouncil({ ...exiled.worldFacts, "solkar-exiled": false });
  assert.equal(engine.resolveInteraction("crown-council", "crown-council", "willing"), false);
  assert.deepEqual(engine.consumeWorldEvents(), []);
  loadCouncil(exiled.worldFacts, { ...councilPosition, x: councilPosition.x + 6 });
  assert.equal(engine.resolveInteraction("crown-council", "crown-council", "willing"), false);
  assert.deepEqual(engine.consumeWorldEvents(), []);
  loadCouncil();
  assert.equal(engine.snapshot().actors.find((actor) => actor.id === "solkar")?.visible, false);
  assert.equal(engine.resolveInteraction("crown-council", "crown-council", "unapproved-option"), false);
  assert.equal(engine.resolveInteraction("crown-council", "wrong-target", "willing"), false);
  assert.deepEqual(engine.consumeWorldEvents(), []);
  assert.equal(engine.resolveInteraction("crown-council", "crown-council", "willing"), true);
  for (const event of engine.consumeWorldEvents()) await director.processEvent(event);
  const checkpoint = await director.captureCheckpoint();
  assert.equal(await director.restoreCheckpoint(checkpoint), true);
  await director.choose("faction-covenant", "crown");
  await atChapter(director, 7);
  await director.choose("chapter-seven-commitment", "crown");
  const renewed = director.snapshot();
  assert.equal(renewed.campaign.world.factions.crown.leaderStatus, "exiled");
  assert.deepEqual(renewed.campaign.world.factions.crown.representative,
    { id: "crown-council", source: "council", present: true, willing: true });
  assert.equal(renewed.worldFacts.solkarPresent, false);
  assert.equal(renewed.worldFacts["solkar-exiled"], true);
  assert.deepEqual(renewed.party, {});
  await assert.rejects(director.selectParty("solkar"));
  const restored = await director.captureCheckpoint();
  assert.equal(await director.restoreCheckpoint(restored), true);
  assert.equal(director.snapshot().worldFacts.solkarPresent, false);
  assert.deepEqual(director.snapshot().campaign.world.factions.crown.representative, renewed.campaign.world.factions.crown.representative);
});

test("a refused durable exile commit restores facts, domain, party and checkpoint", async () => {
  const saves = new RecordingLedger(undefined);
  const director = new CampaignDirector({ runId: "exile-rollback", saves });
  await atChapter(director, 5, (checkpoint) => {
    checkpoint.progress.party = { companionId: "solkar" };
  });
  // The Sunmane regional-leadership guardian must be cleansed before the exile path commits
  // — this isolates the durable-save rollback branch from the regional gate.
  await cleanseSolkar(director);
  const before = director.snapshot();
  const writesBefore = saves.writes.length;
  saves.fail = true;
  await assert.rejects(director.choose("sunmane-resolution", "exile"), (error: unknown) => {
    assert.ok(error instanceof SaveRepositoryError);
    assert.equal(error.code, "transaction");
    assert.equal(error instanceof CampaignChoiceRejectedError, false);
    return true;
  });
  assert.deepEqual(director.snapshot(), before);
  assert.equal(saves.writes.length, writesBefore);
});

test("unavailable faction choices are typed permanent rejections and leave the next valid event usable", async () => {
  const saves = new RecordingLedger(undefined);
  const director = new CampaignDirector({ runId: "unavailable-covenant-type", saves });
  await atChapter(director, 5);
  const before = director.snapshot();
  const writesBefore = saves.writes.length;
  await assert.rejects(director.processEvent(choiceEvent("faction-covenant", "crown", "unavailable-crown")), (error: unknown) => {
    assert.ok(error instanceof CampaignChoiceRejectedError);
    assert.equal(error.choiceId, "faction-covenant");
    assert.equal(error.optionId, "crown");
    assert.equal(error instanceof SaveRepositoryError, false);
    return true;
  });
  assert.deepEqual(director.snapshot(), before);
  assert.equal(saves.writes.length, writesBefore);
  // The negative assertion above must keep failing on the absent crown obligation;
  // a successful sunmane exile still requires the authored Solkar guardian cleanse.
  await cleanseSolkar(director);
  const writesBeforeExile = saves.writes.length;
  await director.choose("sunmane-resolution", "exile");
  assert.equal(director.snapshot().choices["sunmane-resolution"], "exile");
  assert.equal(saves.writes.length, writesBeforeExile + 1);
});

test("all faction covenants and recommitments remain independently repeatable, not interchangeable", async () => {
  const director = new CampaignDirector({ runId: "multifaction-resolutions" });
  await atChapter(director, 5, (checkpoint) => {
    checkpoint.worldCheckpoint.world.fragments = [...FRAGMENT_IDS];
    for (const id of REGIONAL_OBLIGATION_IDS) checkpoint.worldCheckpoint.world.regionalObligations[id] = true;
  });
  for (const faction of FACTION_IDS) await director.choose("faction-covenant", faction);
  for (const faction of FACTION_IDS) assert.equal(director.snapshot().factions[faction].bondTier, 3);
  const beforeReplay = director.snapshot();
  await director.choose("faction-covenant", "sky");
  assert.deepEqual(director.snapshot(), beforeReplay);
  await atChapter(director, 7);
  for (const faction of FACTION_IDS) await director.choose("chapter-seven-commitment", faction === "shadow" ? "decline-shadow" : faction);
  const settled = director.snapshot();
  for (const faction of FACTION_IDS) assert.equal(settled.campaign.world.renewedCommitments[faction], faction !== "shadow");
  await assert.rejects(director.choose("chapter-seven-commitment", "shadow"), /committed resolution/);
  await assert.rejects(director.choose("chapter-seven-commitment", "decline-sky"), /committed resolution/);
  await director.choose("chapter-seven-commitment", "sky");
  assert.deepEqual(director.snapshot(), settled);
});

test("only an actual Orun cleanse opens the existing final interaction without granting Living Pact", async () => {
  const saves = new RecordingLedger(undefined);
  const director = new CampaignDirector({ runId: "orun-final-consumer", saves });
  await atChapter(director, 8);
  const engine = new CombatEngine();
  const region = REGIONS.find((item) => item.id === "heartroot-hollow")!;
  const position = region.entities.find((entity) => entity.interactionId === "hollow-crown-choice")!.position;
  const loadGate = (worldFacts = director.snapshot().worldFacts) => engine.loadRegion({
    runId: director.snapshot().runId, regionId: region.id, presentActorIds: [], playerPosition: position, worldFacts,
  });
  // The old producer spelling alone is not a permitted fallback for this gate.
  loadGate({ ...director.snapshot().worldFacts, "encounter-orun-cleansed": true });
  assert.equal(engine.resolveInteraction("hollow-crown-choice", "hollow-crown-choice", "severance"), false);
  await assert.rejects(director.choose("final-ending", "severance"), /Orun must be resolved/);
  await director.processEvent({ type: "encounter-resolved", eventId: "other-cleanse", idempotencyKey: "other-cleanse",
    encounterId: "encounter-ghor", actorIds: ["ghor"], resolution: "cleansed" });
  loadGate();
  assert.equal(engine.resolveInteraction("hollow-crown-choice", "hollow-crown-choice", "severance"), false);
  await cleanseOrun(director);
  assert.equal(director.snapshot().worldFacts["orun-cleansed"], true);
  assert.equal(director.snapshot().worldFacts["encounter-orun-cleansed"], undefined);
  loadGate();
  assert.equal(engine.resolveInteraction("hollow-crown-choice", "hollow-crown-choice", "unapproved-option"), false);
  assert.deepEqual(engine.consumeWorldEvents(), []);
  const beforeEnding = director.snapshot();
  const writesBefore = saves.writes.length;
  assert.equal(engine.resolveInteraction("hollow-crown-choice", "hollow-crown-choice", "living_pact"), true);
  const rejected = engine.consumeWorldEvents()[0]!;
  assert.ok(rejected.type === "choice");
  await assert.rejects(director.processEvent(rejected), (error: unknown) => {
    assert.ok(error instanceof CampaignChoiceRejectedError);
    assert.equal(error.choiceId, "final-ending");
    assert.equal(error.optionId, "living_pact");
    assert.equal(error.message, "Living Pact requirements are not met for this run.");
    assert.equal(error instanceof SaveRepositoryError, false);
    return true;
  });
  assert.deepEqual(director.snapshot(), beforeEnding);
  assert.equal(saves.writes.length, writesBefore);
  assert.equal(director.isEventCommitted(rejected.idempotencyKey), false);
  engine.discardRejectedChoice(rejected, director.isEventCommitted(rejected.idempotencyKey));
  // The SAME simulation can now emit an eligible choice, without a region reload or dedup bypass.
  assert.equal(engine.resolveInteraction("hollow-crown-choice", "hollow-crown-choice", "severance"), true);
  const accepted = engine.consumeWorldEvents()[0]!;
  await director.processEvent(accepted);
  assert.equal(director.isEventCommitted(accepted.idempotencyKey), true);
  assert.equal(saves.writes.length, writesBefore + 1);
  assert.equal(engine.resolveInteraction("hollow-crown-choice", "hollow-crown-choice", "severance"), false);
  assert.equal(director.snapshot().ending, "severance");
  assert.equal(director.ending().available, false);
});

test("contextual choice support does not authorize a semantic choose action", () => {
  const engine = new CombatEngine();
  const region = REGIONS.find((item) => item.id === "the-grove")!;
  const position = region.entities.find((entity) => entity.interactionId === "grove-council")!.position;
  engine.loadRegion({ regionId: region.id, runId: "semantic-choice-mismatch",
    presentActorIds: [], playerPosition: position, worldFacts: {} });
  assert.equal(engine.resolveInteraction("grove-council", "grove-council", "willing"), false);
  assert.deepEqual(engine.consumeWorldEvents(), []);
});

test("the real Solkar offer records authoritative Dominion identity and retains the permanent veto", async () => {
  const saves = new RecordingLedger(undefined);
  const director = new CampaignDirector({ runId: "solkar-producer-dominion", saves });
  const region = REGIONS.find((item) => item.id === "sunmane-expanse")!;
  await atChapter(director, 5, (checkpoint) => {
    checkpoint.progress.regionId = region.id;
    checkpoint.safeSpawn = { regionId: region.id, position: region.navigation.nodes[0]!.position,
      routeId: region.navigation.nodes[0]!.id, cameraAnchorId: region.cameraAnchors[0]!.id };
  });
  // The `solkar-offer` interaction has a hard prerequisite on the authored
  // `encounter-solkar-cleansed` fact (see INTERACTIONS in src/content/world.ts).
  // The CombatEngine consults that fact in resolveInteraction, so we drive the
  // resolved-event through the Director first and then load the resulting worldFacts.
  await cleanseSolkar(director);
  const earlier = await director.captureCheckpoint();
  const engine = new CombatEngine();
  const position = region.entities.find((entity) => entity.id === "solkar")!.position;
  engine.loadRegion({ runId: director.snapshot().runId, regionId: region.id,
    presentActorIds: ["solkar"], playerPosition: position, worldFacts: director.snapshot().worldFacts });
  assert.equal(engine.resolveInteraction("solkar-offer", "solkar", "dominion"), true);
  const events = engine.consumeWorldEvents();
  assert.equal(events.length, 1);
  await director.processEvent(events[0]!);
  assert.deepEqual(director.snapshot().campaign.dominionHistory, [{ sequence: 1, leaderId: "solkar" }]);
  assert.equal(director.snapshot().worldFacts["dominion:solkar"], true);
  assert.deepEqual(saves.writes.at(-1)?.[1], [{ sequence: 1, leaderId: "solkar" }]);
  const writesAfterEvent = saves.writes.length;
  assert.equal(director.ending().unmet.some((item) => item.id === "no_dominion"), true);
  const committed = director.snapshot();
  assert.equal(engine.resolveInteraction("solkar-offer", "solkar", "dominion"), false);
  assert.deepEqual(engine.consumeWorldEvents(), []);
  await director.choose("sunmane-resolution", "dominion");
  assert.deepEqual(director.snapshot(), committed);
  assert.equal(saves.writes.length, writesAfterEvent);
  assert.equal(await director.restoreCheckpoint(earlier), true);
  assert.deepEqual(director.snapshot().campaign.dominionHistory, [{ sequence: 1, leaderId: "solkar" }]);
  assert.equal(director.ending().unmet.some((item) => item.id === "no_dominion"), true);
});

for (const response of ["accept", "decline", "mixed"] as const) {
  test(`the real Refuge council records all six ${response} responses across reload and persisted event keys`, async () => {
    const saves = new RecordingLedger(undefined);
    const director = new CampaignDirector({ runId: "council-producer-" + response, saves });
    const region = REGIONS.find((item) => item.id === "refuge")!;
    const position = region.entities.find((entity) => entity.interactionId === "refuge-council")!.position;
    await atChapter(director, 7, (checkpoint) => {
      checkpoint.progress.regionId = region.id;
      checkpoint.progress.activeQuestIds = ["wild-march"];
      checkpoint.safeSpawn = { regionId: region.id, position: region.navigation.nodes[0]!.position,
        routeId: region.navigation.nodes[0]!.id, cameraAnchorId: region.cameraAnchors[0]!.id };
    });
    const engine = new CombatEngine();
    for (const [index, faction] of FACTION_IDS.entries()) {
      const accepts = response === "accept" || response === "mixed" && index % 2 === 0;
      const option = accepts ? faction : "decline-" + faction;
      engine.loadRegion({ runId: director.snapshot().runId, regionId: region.id,
        presentActorIds: [], playerPosition: position, worldFacts: director.snapshot().worldFacts });
      assert.equal(engine.resolveInteraction("refuge-council", "refuge-council", option), true);
      const events = engine.consumeWorldEvents();
      assert.equal(events.length, 1);
      await director.processEvent(events[0]!);
      assert.equal(director.snapshot().campaign.world.renewedCommitments[faction], accepts);
      const checkpoint = await director.captureCheckpoint();
      assert.equal(await director.restoreCheckpoint(checkpoint), true);
      const committed = director.snapshot();
      assert.equal(engine.resolveInteraction("refuge-council", "refuge-council", option), false);
      assert.equal(engine.resolveInteraction("refuge-council", "refuge-council", accepts ? "decline-" + faction : faction), false);
      assert.deepEqual(engine.consumeWorldEvents(), []);
      assert.deepEqual(director.snapshot(), committed);
    }
    const settled = director.snapshot();
    assert.equal(settled.completedObjectiveIds.includes("wild-march:commitments"), true);
    const checkpoint = await director.captureCheckpoint();
    const councilKeys = checkpoint.progress.eventKeys.filter((key) => key.includes(":interaction:refuge-council:"));
    assert.equal(new Set(councilKeys).size, 6);
    const settledWrites = saves.writes.length;
    assert.equal(new Set(saves.writes.at(-1)![2].filter((key) => key.includes(":interaction:refuge-council:"))).size, 6);
    // A fresh simulation instance has no local key memory; the persisted Director boundary remains authoritative.
    const freshEngine = new CombatEngine();
    freshEngine.loadRegion({ runId: settled.runId, regionId: region.id,
      presentActorIds: [], playerPosition: position, worldFacts: settled.worldFacts });
    const skyAccepted = settled.campaign.world.renewedCommitments.sky;
    const skyOption = skyAccepted ? "sky" : "decline-sky";
    assert.equal(freshEngine.resolveInteraction("refuge-council", "refuge-council", skyOption), true);
    await director.processEvent(freshEngine.consumeWorldEvents()[0]!);
    assert.deepEqual(director.snapshot(), settled);
    assert.equal(saves.writes.length, settledWrites);
    const conflictingEngine = new CombatEngine();
    conflictingEngine.loadRegion({ runId: settled.runId, regionId: region.id,
      presentActorIds: [], playerPosition: position, worldFacts: settled.worldFacts });
    assert.equal(conflictingEngine.resolveInteraction("refuge-council", "refuge-council", skyAccepted ? "decline-sky" : "sky"), true);
    const rejected = conflictingEngine.consumeWorldEvents()[0]!;
    assert.ok(rejected.type === "choice");
    await assert.rejects(director.processEvent(rejected), (error: unknown) => {
      assert.ok(error instanceof CampaignChoiceRejectedError);
      assert.equal(error.choiceId, "chapter-seven-commitment");
      assert.equal(error.optionId, skyAccepted ? "decline-sky" : "sky");
      assert.equal(error.message, "This campaign choice already has a committed resolution.");
      assert.equal(error instanceof SaveRepositoryError, false);
      return true;
    });
    assert.deepEqual(director.snapshot(), settled);
    assert.equal(saves.writes.length, settledWrites);
    assert.equal(director.isEventCommitted(rejected.idempotencyKey), true);
    conflictingEngine.discardRejectedChoice(rejected, director.isEventCommitted(rejected.idempotencyKey));
    assert.equal(conflictingEngine.resolveInteraction("refuge-council", "refuge-council", skyOption), false);
    assert.equal(conflictingEngine.resolveInteraction("refuge-council", "refuge-council", skyAccepted ? "decline-sky" : "sky"), false);
    assert.deepEqual(conflictingEngine.consumeWorldEvents(), []);
  });
}

test("checkpoint restore rejects malformed historical choice fields before mutating current state or records", async () => {
  const saves = new RecordingLedger(undefined);
  const director = new CampaignDirector({ runId: "choice-history-input-guard", saves });
  await atChapter(director, 7);
  await director.choose("chapter-seven-commitment", "sky");
  const historical = await director.captureCheckpoint();
  await director.choose("chapter-seven-commitment", "canopy");
  const before = director.snapshot();
  const recordsBefore = structuredClone(saves.writes);
  for (const field of ["choiceId", "optionId", "eventId", "idempotencyKey"] as const) {
    for (const value of [undefined, null, [], 42, {}, "", "   "]) {
      const corrupted = structuredClone(historical);
      const event = corrupted.progress.eventLog.find((entry) => entry.type === "choice")!;
      const record = event as unknown as Record<string, unknown>;
      if (value === undefined) delete record[field];
      else record[field] = value;
      const rawBefore = JSON.stringify(corrupted);
      assert.equal(await director.restoreCheckpoint(corrupted), false, `${field}: ${JSON.stringify(value)}`);
      assert.deepEqual(director.snapshot(), before);
      assert.deepEqual(saves.writes, recordsBefore);
      assert.equal(JSON.stringify(corrupted), rawBefore);
    }
  }
  for (const [field, invalid] of [["leaderId", []], ["dominion", "true"]] as const) {
    const corrupted = structuredClone(historical);
    Object.assign(corrupted.progress.eventLog.find((entry) => entry.type === "choice")!, { [field]: invalid });
    assert.equal(await director.restoreCheckpoint(corrupted), false);
    assert.deepEqual(director.snapshot(), before);
    assert.deepEqual(saves.writes, recordsBefore);
  }
  // Valid historical choice records remain usable; no event is skipped or defaulted.
  assert.equal(await director.restoreCheckpoint(historical), true);
  const restored = director.snapshot();
  await director.choose("chapter-seven-commitment", "sky");
  assert.deepEqual(director.snapshot(), restored);
  await director.choose("chapter-seven-commitment", "fang");
  assert.equal(director.snapshot().campaign.world.renewedCommitments.fang, true);
  assert.equal(director.isEventCommitted("choice:chapter-seven-commitment:fang"), true);
});

test("Director load and import reject malformed persisted choices before adopting history or committing an import", async () => {
  const saves = new CampaignSlotLedger(undefined);
  const director = new CampaignDirector({ runId: "persisted-choice-history", saves });
  await atChapter(director, 7);
  await director.choose("chapter-seven-commitment", "sky");
  const historical = await director.captureCheckpoint();
  const envelope: GameSaveEnvelope = {
    format: "wild-crown-save", schemaVersion: 1, kind: "campaign", runId: historical.runId,
    campaign: director.snapshot().campaign, checkpoint: historical.worldCheckpoint,
    progress: { ...historical.progress, safeSpawn: historical.safeSpawn,
      activeQuestIds: [...historical.progress.activeQuestIds],
      completedQuestIds: [...historical.progress.completedQuestIds],
      completedObjectiveIds: [...historical.progress.completedObjectiveIds],
      eventLog: [...historical.progress.eventLog], eventKeys: [...historical.progress.eventKeys] },
    eventKeys: [...historical.progress.eventKeys], savedAt: 123,
  };
  await director.choose("chapter-seven-commitment", "canopy");
  const before = director.snapshot();
  const recordsBefore = structuredClone(saves.writes);
  for (const field of ["choiceId", "optionId", "eventId", "idempotencyKey"] as const) {
    for (const value of [undefined, null, [], 42, {}, "", "   "]) {
      const corrupted = structuredClone(envelope);
      const event = corrupted.progress!.eventLog.find((entry) =>
        (entry as WorldEvent).type === "choice") as Record<string, unknown>;
      if (value === undefined) delete event[field];
      else event[field] = value;
      saves.envelope = corrupted;
      const serialized = JSON.stringify(corrupted);
      const corrupt = (error: unknown) => error instanceof SaveRepositoryError && error.code === "corrupt";
      await assert.rejects(director.load("history-slot"), corrupt, `${field}: ${JSON.stringify(value)}`);
      assert.deepEqual(director.snapshot(), before);
      await assert.rejects(director.importSave(serialized, "history-slot", "History"), corrupt);
      assert.deepEqual(director.snapshot(), before);
      assert.deepEqual(saves.writes, recordsBefore);
      assert.equal(saves.imports, 0);
      assert.equal(JSON.stringify(saves.envelope), serialized);
    }
  }
  // Accepted history still reaches the same replay guard through each adoption path.
  saves.envelope = structuredClone(envelope);
  for (const adopt of [
    () => director.load("history-slot"),
    () => director.importSave(JSON.stringify(envelope), "history-slot", "History"),
  ]) {
    await adopt();
    const restored = director.snapshot();
    await director.choose("chapter-seven-commitment", "sky");
    assert.deepEqual(director.snapshot(), restored);
    await director.choose("chapter-seven-commitment", "fang");
    assert.equal(director.snapshot().campaign.world.renewedCommitments.fang, true);
  }
  assert.equal(saves.imports, 1);
});

test("return beat consumers resolve exactly the five authored Chapter 7 quests, not the fall or the Wild March", () => {
  assert.deepEqual(RETURN_BEATS, ["seeds-on-the-wind", "a-path-for-the-young", "one-howl-two-generations", "witness-in-the-reeds", "the-open-crossing"]);
  const chapter = CHAPTERS.find((item) => item.number === 7)!;
  assert.deepEqual([...RETURN_BEATS, "wild-march"], chapter.questIds);
});

test("all six fragments remain unique across fresh event keys and checkpoint restore", async () => {
  const director = new CampaignDirector({ runId: "fragment-identity" });
  for (const fragmentId of FRAGMENT_IDS) {
    for (const suffix of ["original", "fresh-key"]) {
      await director.processEvent({
        type: "fragment", eventId: `${fragmentId}:${suffix}`,
        idempotencyKey: `${fragmentId}:${suffix}`, fragmentId, sourceId: "authored-fragment-fixture",
      });
    }
  }
  assert.deepEqual(director.snapshot().fragments, FRAGMENT_IDS);
  const checkpoint = await director.captureCheckpoint();
  assert.equal(await director.restoreCheckpoint(checkpoint), true);
  for (const fragmentId of FRAGMENT_IDS) {
    await director.processEvent({
      type: "fragment", eventId: `${fragmentId}:after-restore`,
      idempotencyKey: `${fragmentId}:after-restore`, fragmentId, sourceId: "authored-fragment-fixture",
    });
  }
  assert.deepEqual(director.snapshot().fragments, FRAGMENT_IDS);
});

for (const faction of FACTION_IDS) {
  test(`a ${faction} covenant and recommitment never summon its absent representative`, async () => {
    const director = new CampaignDirector({ runId: "absent-representative-" + faction });
    await atChapter(director, 5, (checkpoint) => {
      checkpoint.worldCheckpoint.world.fragments = [...FRAGMENT_IDS];
      for (const id of REGIONAL_OBLIGATION_IDS) checkpoint.worldCheckpoint.world.regionalObligations[id] = true;
      const state = checkpoint.worldCheckpoint.world.factions[faction];
      if (state.representative.source === "leader") state.leaderStatus = "absent";
      state.representative.present = false;
      state.representative.willing = false;
    });
    const absent = director.snapshot().campaign.world.factions[faction];
    await director.choose("faction-covenant", faction);
    assert.equal(director.snapshot().factions[faction].bondTier, 3);
    assert.deepEqual(director.snapshot().factions[faction].representative, absent.representative);
    await atChapter(director, 7);
    await director.choose("chapter-seven-commitment", faction);
    assert.equal(director.snapshot().campaign.world.renewedCommitments[faction], true);
    assert.deepEqual(director.snapshot().factions[faction].representative, absent.representative);
    assert.equal(director.ending().unmet.some((item) => item.id === `${faction}_representative`), true);
    const settled = await director.captureCheckpoint();
    assert.equal(await director.restoreCheckpoint(settled), true);
    assert.deepEqual(director.snapshot().factions[faction].representative, absent.representative);
  });
}

for (const order of ["refuse-first", "covenant-first"] as const) {
  test(`Crown council refusal survives ${order} covenant order, renewal and restore`, async () => {
    const director = new CampaignDirector({ runId: "council-refusal-" + order });
    await atChapter(director, 5, (checkpoint) => {
      checkpoint.worldCheckpoint.world.fragments = ["heartroot-crown"];
    });
    // The Sunmane gate requires the authored Solkar guardian cleanse before
    // the decision (see validateChoice's regional-leadership guardian check).
    await cleanseSolkar(director);
    await director.choose("sunmane-resolution", "exile");
    if (order === "covenant-first") await director.choose("faction-covenant", "crown");
    await director.choose("crown-council", "decline");
    if (order === "refuse-first") await director.choose("faction-covenant", "crown");
    await atChapter(director, 7);
    await director.choose("chapter-seven-commitment", "crown");
    const settled = await director.captureCheckpoint();
    assert.equal(await director.restoreCheckpoint(settled), true);
    assert.equal(director.snapshot().choices["crown-council"], "decline");
    assert.deepEqual(director.snapshot().factions.crown.representative,
      { id: "crown-council", source: "council", present: true, willing: false });
    assert.equal(director.snapshot().worldFacts.solkarPresent, false);
    assert.equal(director.ending().unmet.some((item) => item.id === "crown_representative"), true);
  });
}

for (const [encounterId, actorId] of [
  ["encounter-ghor", "ghor"],
  ["encounter-orun", "orun"],
] as const) {
  test(`a cleared encounter-phase with ${encounterId}/${actorId} cannot authorize the final Crown choice`, async () => {
    const saves = new RecordingLedger(undefined);
    const director = new CampaignDirector({ runId: "final-phase-authority-" + actorId, saves });
    await atChapter(director, 8);
    await director.processEvent({
      type: "encounter-phase", eventId: "crafted-orun-phase", idempotencyKey: "crafted-orun-phase",
      encounterId, actorId, phaseId: "encounter-orun", phaseIndex: 2,
      state: "cleared", simulationTick: 1,
    });
    assert.equal(director.snapshot().worldFacts["orun-cleansed"], undefined);
    assert.equal(director.snapshot().campaign.world.hollowReady, false);
    const before = director.snapshot();
    const persisted = structuredClone(saves.writes);
    await assert.rejects(director.choose("final-ending", "severance"), /Orun must be resolved/);
    await assert.rejects(
      director.processEvent(choiceEvent("final-ending", "dominion", "phase-only-final-choice")),
      CampaignChoiceRejectedError,
    );
    assert.deepEqual(director.snapshot(), before);
    assert.deepEqual(saves.writes, persisted);
    assert.equal(director.isEventCommitted("phase-only-final-choice"), false);
    await director.processEvent({
      type: "encounter-resolved", eventId: "authored-orun-cleanse", idempotencyKey: "authored-orun-cleanse",
      encounterId: "encounter-orun", actorIds: ["orun"], resolution: "cleansed",
    });
    assert.equal(director.snapshot().worldFacts["orun-cleansed"], true);
    await director.choose("final-ending", "severance");
    assert.equal(director.snapshot().ending, "severance");
    assert.equal(director.isEventCommitted("choice:final-ending:severance"), true);
  });
}

test("possession and a mismatched Orun participant cannot authorize the final Crown choice", async () => {
  const director = new CampaignDirector({ runId: "final-possession-authority" });
  await atChapter(director, 8, (checkpoint) => {
    checkpoint.progress.activeQuestIds = ["orun-the-hollow-king"];
  });
  for (const state of ["telegraphed", "began", "broken", "escaped"] as const) {
    await director.processEvent({
      type: "possession", eventId: "possession-" + state, idempotencyKey: "possession-" + state,
      actorId: "orun", targetId: "aren", phaseId: "orun-final-possession", state, simulationTick: 1,
    });
    assert.equal(director.snapshot().worldFacts["orun-cleansed"], undefined);
    assert.equal(director.snapshot().campaign.world.hollowReady, false);
  }
  await director.processEvent({
    type: "encounter-resolved", eventId: "wrong-orun-participant", idempotencyKey: "wrong-orun-participant",
    encounterId: "encounter-orun", actorIds: ["ghor"], resolution: "cleansed",
  });
  assert.equal(director.snapshot().worldFacts["orun-cleansed"], undefined);
  assert.equal(director.snapshot().completedObjectiveIds.includes("orun-the-hollow-king:resolve-orun"), false);
  const before = director.snapshot();
  await assert.rejects(director.choose("final-ending", "severance"), /Orun must be resolved/);
  assert.deepEqual(director.snapshot(), before);
  await cleanseOrun(director);
  assert.equal(director.snapshot().completedObjectiveIds.includes("orun-the-hollow-king:resolve-orun"), true);
  await director.choose("final-ending", "severance");
  assert.equal(director.snapshot().completedQuestIds.includes("orun-the-hollow-king"), true);
});

test("five return quest reducers retain absence and branch facts without granting an ending", async () => {
  const director = new CampaignDirector({ runId: "return-quest-state" });
  await atChapter(director, 3);
  await cleanseRuun(director);
  await director.choose("pack-leadership", "luma");
  await atChapter(director, 4);
  await director.choose("marek-fate", "leave");
  await atChapter(director, 5);
  await cleanseSolkar(director);
  await director.choose("sunmane-resolution", "exile");
  await atChapter(director, 7, (checkpoint) => {
    checkpoint.progress.activeQuestIds = [RETURN_BEATS[0]!];
  });
  const partyBeforeReturns = director.snapshot().party;
  // Director-level semantic fixtures exercise graph reduction, not authored playable return mechanics.
  const actions: WorldEvent[] = [
    { type: "semantic-interaction", eventId: "seed-route", idempotencyKey: "seed-route",
      actorId: "aren", interactionId: "seed-route", kind: "coordinate", targetId: "seed-route", position: { x: 0, y: 0, z: 0 } },
    { type: "rescue", eventId: "nursery-return", idempotencyKey: "nursery-return",
      targetId: "tali", locationId: "nursery-return", safe: true },
    { type: "semantic-interaction", eventId: "two-generation-howl", idempotencyKey: "two-generation-howl",
      actorId: "aren", interactionId: "two-generation-howl", kind: "coordinate", targetId: "two-generation-howl", position: { x: 0, y: 0, z: 0 } },
    { type: "semantic-interaction", eventId: "reed-corridor", idempotencyKey: "reed-corridor",
      actorId: "aren", interactionId: "reed-corridor", kind: "repair", targetId: "reed-corridor", position: { x: 0, y: 0, z: 0 } },
    { type: "semantic-interaction", eventId: "open-crossing", idempotencyKey: "open-crossing",
      actorId: "aren", interactionId: "open-crossing", kind: "restore", targetId: "open-crossing", position: { x: 0, y: 0, z: 0 } },
  ];
  for (const [index, questId] of RETURN_BEATS.entries()) {
    const quest = QUESTS.find((item) => item.id === questId)!;
    assert.equal(director.snapshot().activeQuestIds.includes(questId), true);
    await director.processEvent({
      type: "semantic-interaction", eventId: questId + ":inspect", idempotencyKey: questId + ":inspect",
      actorId: "aren", interactionId: questId + ":inspect", kind: "inspect", targetId: questId, position: { x: 0, y: 0, z: 0 },
    });
    assert.equal(director.snapshot().completedQuestIds.includes(questId), false);
    await director.processEvent(actions[index]!);
    const completed = director.snapshot();
    assert.equal(completed.completedQuestIds.includes(questId), true);
    for (const objective of quest.objectives) assert.equal(completed.completedObjectiveIds.includes(objective.id), true);
    await director.processEvent(actions[index]!);
    assert.deepEqual(director.snapshot(), completed);
    const checkpoint = await director.captureCheckpoint();
    assert.equal(await director.restoreCheckpoint(checkpoint), true);
    assert.equal(director.snapshot().campaign.world.factions.pack.leaderId, "luma");
    assert.equal(director.snapshot().campaign.world.marekPresent, false);
    assert.equal(director.snapshot().worldFacts.solkarPresent, false);
    assert.equal(director.snapshot().campaign.world.factions.crown.leaderStatus, "exiled");
    assert.deepEqual(director.snapshot().party, partyBeforeReturns);
    assert.equal(director.snapshot().ending, null);
    assert.equal(director.ending().available, false);
  }
  assert.equal(director.snapshot().activeQuestIds.includes("wild-march"), true);
  assert.equal(director.snapshot().worldFacts.wildMarchFormed, undefined);
});

test("producer choice metadata cannot change the authored Dominion identity or create history", async () => {
  const director = new CampaignDirector({ runId: "choice-metadata-authority" });
  await atChapter(director, 3);
  await cleanseRuun(director);
  await director.processEvent({
    type: "choice", eventId: "metadata-pack", idempotencyKey: "metadata-pack",
    choiceId: "pack-leadership", optionId: "dominion-luma", leaderId: "solkar", dominion: false,
  });
  assert.equal(director.snapshot().factions.pack.leaderId, "luma");
  assert.deepEqual(director.snapshot().campaign.dominionHistory, [{ sequence: 1, leaderId: "luma" }]);
  await atChapter(director, 5);
  await cleanseSolkar(director);
  await director.processEvent({
    type: "choice", eventId: "metadata-crown", idempotencyKey: "metadata-crown",
    choiceId: "sunmane-resolution", optionId: "bond", leaderId: "solkar", dominion: true,
  });
  assert.deepEqual(director.snapshot().campaign.dominionHistory, [{ sequence: 1, leaderId: "luma" }]);
  const checkpoint = await director.captureCheckpoint();
  const rawBefore = structuredClone(checkpoint.progress.eventLog);
  assert.equal(await director.restoreCheckpoint(checkpoint), true);
  assert.deepEqual((await director.captureCheckpoint()).progress.eventLog, rawBefore);
  assert.deepEqual(director.snapshot().campaign.dominionHistory, [{ sequence: 1, leaderId: "luma" }]);
});

test("a fresh Director run starts with every canonical exposed alias false and every canonical state unvisited", async () => {
  // emptyWorldFacts must initialize the historical exposed aliases
  // (canopy_restored, bamboo_restored, moonpine_restored, mistveil_restored,
  // sunmane_restored) consistently with the canonical world. Constructors
  // and startNewRun/startShowcase assign it directly without normalization, so
  // an inconsistent emptyWorldFacts would leave the aliases undefined.
  const scenarios: Array<{ runId: string; reenter: (director: CampaignDirector) => void }> = [
    { runId: "alias-ctor", reenter: () => undefined },
    { runId: "alias-startNewRun", reenter: (director) => director.startNewRun("alias-newrun") },
    { runId: "alias-startShowcase", reenter: (director) => director.startShowcase("alias-showcase") },
  ];
  for (const { runId, reenter } of scenarios) {
    const director = new CampaignDirector({ runId });
    reenter(director);
    const facts = director.snapshot().worldFacts;
    for (const region of REGION_IDS) {
      assert.equal(facts[`restoration:${region}:state`], "unvisited",
        `${region} state starts unvisited (${runId})`);
      assert.equal(facts[`restoration:${region}:restored`], false,
        `${region} restored boolean starts false (${runId})`);
      assert.equal(facts[`restoration:${region}:partial`], false,
        `${region} partial boolean starts false (${runId})`);
    }
    assert.equal(facts.canopy_restored, false, `canopy_restored starts false (${runId})`);
    assert.equal(facts.bamboo_restored, false, `bamboo_restored starts false (${runId})`);
    assert.equal(facts.moonpine_restored, false, `moonpine_restored starts false (${runId})`);
    assert.equal(facts.mistveil_restored, false, `mistveil_restored starts false (${runId})`);
    assert.equal(facts.sunmane_restored, false, `sunmane_restored starts false (${runId})`);
  }
});

test("local restoration remains isolated and does not bypass interaction-gated travel", async () => {
  const director = new CampaignDirector({ runId: "restoration-facts" });
  const initial = director.snapshot();
  for (const region of REGIONS) {
    assert.equal(initial.worldFacts[`restoration:${region.id}:state`], "unvisited",
      `${region.id} starts unvisited`);
    assert.equal(initial.worldFacts[`restoration:${region.id}:partial`], false,
      `${region.id} partial fact starts false`);
    assert.equal(initial.worldFacts[`restoration:${region.id}:restored`], false,
      `${region.id} restored fact starts false`);
  }
  // Chapter progression and the Greenwake gate are independent travel requirements.
  await atChapter(director, 1);
  await assert.rejects(
    director.travel("whispering-canopy", "greenwake-canopy-in"),
    /not been discovered/,
    "Canopy entrance is locked before the greenwake gate interaction opens",
  );
  await director.processEvent({
    type: "restoration",
    eventId: "greenwake-restored",
    idempotencyKey: "restoration:greenwake:restored",
    regionId: "greenwake",
    state: "restored",
    causeId: "greenwake-bond",
  });
  const unlocked = director.snapshot();
  assert.equal(unlocked.worldFacts["restoration:greenwake:state"], "restored",
    "noncanonical local state committed");
  assert.equal(unlocked.worldFacts["restoration:greenwake:restored"], true,
    "noncanonical restored boolean committed");
  assert.equal(unlocked.worldFacts["restoration:greenwake:partial"], false,
    "noncanonical partial boolean cleared");
  assert.equal(unlocked.campaign.world.regions["greenwake"] as string | undefined, undefined,
    "noncanonical region did not pollute canonical regions");
  for (const region of REGIONS) {
    assert.equal(unlocked.worldFacts[`restoration:${region.id}:partial`], false,
      `${region.id} partial fact stays false after a greenwake-only restoration`);
    assert.equal(unlocked.worldFacts[`restoration:${region.id}:restored`], region.id === "greenwake",
      `${region.id} restored fact only commits for greenwake`);
  }
  // Restoration does not replace the gate interaction.
  await assert.rejects(
    director.travel("whispering-canopy", "greenwake-canopy-in"),
    /not been discovered/,
    "restoration does not grant travel through an interaction-gated gate",
  );
  await director.processEvent({
    type: "semantic-interaction",
    eventId: "open-greenwake-gate",
    idempotencyKey: "interaction:greenwake-gate:open",
    actorId: "aren",
    interactionId: "greenwake-gate",
    kind: "traverse",
    targetId: "greenwake-gate",
    position: { x: 10, y: 2, z: 17 },
  });
  assert.equal(director.snapshot().worldFacts["interaction:greenwake-gate"], true,
    "greenwake-gate interaction fact is committed as the gate key");
  const canopy = await director.travel("whispering-canopy", "greenwake-canopy-in");
  assert.equal(canopy.regionId, "whispering-canopy", "Canopy entrance unlocks after greenwake-gate interaction");
  // Arrival preserves the authored route's safe position and camera.
  const canopyRegion = REGIONS.find((region) => region.id === "whispering-canopy")!;
  const entrance = canopyRegion.entrances.find((entry) => entry.id === "greenwake-canopy-in");
  assert.ok(entrance, "Canopy entrance was reciprocally authored");
  assert.ok(canopy.lastSafeCheckpoint, "adopted safe checkpoint exists");
  const safeSpawn = canopy.lastSafeCheckpoint?.safeSpawn;
  assert.equal(safeSpawn?.routeId, "greenwake-canopy-in",
    "safe spawn route id matches authored entrance id");
  assert.equal(safeSpawn?.regionId, "whispering-canopy",
    "safe spawn belongs to whispering-canopy");
  assert.equal(safeSpawn?.position.x, entrance.from.x,
    "safe spawn x equals reciprocal entrance.from.x");
  assert.equal(safeSpawn?.position.y, entrance.from.y,
    "safe spawn y equals reciprocal entrance.from.y");
  assert.equal(safeSpawn?.position.z, entrance.from.z,
    "safe spawn z equals reciprocal entrance.from.z");
  const cameraAnchor = canopyRegion.cameraAnchors.find((anchor) => anchor.id === safeSpawn?.cameraAnchorId);
  assert.ok(cameraAnchor, "safe spawn uses an authored camera anchor id");
});

test("restoration events are monotonic across unvisited/corrupted/partial/restored", async () => {
  const director = new CampaignDirector({ runId: "restoration-monotonic" });
  await atChapter(director, 1);
  await director.processEvent({
    type: "restoration",
    eventId: "canopy-corruption",
    idempotencyKey: "restoration:whispering-canopy:corrupted",
    regionId: "whispering-canopy",
    state: "corrupted",
    causeId: "canopy-test",
  });
  await director.processEvent({
    type: "restoration",
    eventId: "canopy-partial",
    idempotencyKey: "restoration:whispering-canopy:partial",
    regionId: "whispering-canopy",
    state: "partial",
    causeId: "canopy-test",
  });
  await director.processEvent({
    type: "restoration",
    eventId: "canopy-restored",
    idempotencyKey: "restoration:whispering-canopy:restored",
    regionId: "whispering-canopy",
    state: "restored",
    causeId: "canopy-test",
  });
  const after = director.snapshot();
  assert.equal(after.campaign.world.regions["whispering-canopy"], "restored",
    "monotonic climb to restored commits canonical state");
  assert.equal(after.worldFacts["restoration:whispering-canopy:state"], "restored");
  assert.equal(after.worldFacts["restoration:whispering-canopy:restored"], true);
  assert.equal(after.worldFacts["restoration:whispering-canopy:partial"], false);
  assert.equal(after.worldFacts.canopy_restored, true,
    "monotonic restored events still set the historical exposed key");

  const before = director.snapshot();
  await director.processEvent({
    type: "restoration",
    eventId: "canopy-downgrade",
    idempotencyKey: "restoration:whispering-canopy:stale-partial",
    regionId: "whispering-canopy",
    state: "partial",
    causeId: "canopy-test",
  });
  assert.deepEqual(director.snapshot().worldFacts, before.worldFacts,
    "downgrade attempts on state=do not mutate any fact");
  assert.equal(director.snapshot().campaign.world.regions["whispering-canopy"], "restored",
    "downgrade attempts on state=do not regress canonical state");
});

test("local noncanonical state survives a fresh-key downgrade event after restoration", async () => {
  const director = new CampaignDirector({ runId: "noncanonical-monotonic" });
  await atChapter(director, 0);
  // Climb Greenwake to restored through the canonical four-state ladder.
  await director.processEvent({
    type: "restoration",
    eventId: "greenwake-corrupted",
    idempotencyKey: "restoration:greenwake:corrupted",
    regionId: "greenwake",
    state: "corrupted",
    causeId: "greenwake-bond",
  });
  await director.processEvent({
    type: "restoration",
    eventId: "greenwake-partial",
    idempotencyKey: "restoration:greenwake:partial",
    regionId: "greenwake",
    state: "partial",
    causeId: "greenwake-bond",
  });
  await director.processEvent({
    type: "restoration",
    eventId: "greenwake-restored",
    idempotencyKey: "restoration:greenwake:restored",
    regionId: "greenwake",
    state: "restored",
    causeId: "greenwake-bond",
  });
  const climbed = director.snapshot();
  assert.equal(climbed.worldFacts["restoration:greenwake:state"], "restored",
    "Greenwake reached restored through monotonic climb");
  assert.equal(climbed.worldFacts["restoration:greenwake:restored"], true);
  assert.equal(climbed.worldFacts["restoration:greenwake:partial"], false);
  // Fresh-key downgrade attempt must not mutate any local fact or boolean.
  const before = director.snapshot();
  await director.processEvent({
    type: "restoration",
    eventId: "greenwake-freshkey-partial",
    idempotencyKey: "restoration:greenwake:freshkey-partial",
    regionId: "greenwake",
    state: "partial",
    causeId: "greenwake-bond",
  });
  const after = director.snapshot();
  assert.equal(after.worldFacts["restoration:greenwake:state"], "restored",
    "local state stays restored after downgrade attempt");
  assert.equal(after.worldFacts["restoration:greenwake:restored"], true,
    "local restored boolean stays true after downgrade attempt");
  assert.equal(after.worldFacts["restoration:greenwake:partial"], false,
    "local partial boolean stays false after downgrade attempt");
  assert.deepEqual(after.worldFacts, before.worldFacts,
    "downgrade attempt leaves every Greenwake fact untouched");
});

test("mistveil canonical restored state survives a stale partial event and quest consequence", async () => {
  const director = new CampaignDirector({ runId: "mistveil-restoration" });
  await atChapter(director, 4);
  await director.processEvent({
    type: "restoration",
    eventId: "mistveil-restored",
    idempotencyKey: "restoration:mistveil-basin:restored",
    regionId: "mistveil-basin",
    state: "restored",
    causeId: "river-source",
  });
  await director.processEvent({
    type: "restoration",
    eventId: "mistveil-stale-partial",
    idempotencyKey: "restoration:mistveil-basin:stale-partial",
    regionId: "mistveil-basin",
    state: "partial",
    causeId: "river-source",
  });
  const afterStale = director.snapshot();
  assert.equal(afterStale.campaign.world.regions["mistveil-basin"], "restored",
    "stale partial cannot regress canonical restored state");
  assert.equal(afterStale.worldFacts["restoration:mistveil-basin:restored"], true,
    "stale partial cannot regress restored boolean");
  assert.equal(afterStale.worldFacts["restoration:mistveil-basin:partial"], false,
    "stale partial cannot resurrect partial boolean");
  assert.equal(afterStale.worldFacts["restoration:mistveil-basin:state"], "restored");
  assert.equal(afterStale.worldFacts.mistveil_restored, true,
    "historical exposed key remained true");
});

test("canonical facts and local region state survive checkpoint restore and load adoption", async () => {
  const sourceSaves = new CampaignSlotLedger(undefined);
  const director = new CampaignDirector({ runId: "restoration-checkpoint", saves: sourceSaves });
  await atChapter(director, 1);
  await director.processEvent({
    type: "restoration",
    eventId: "greenwake-restored",
    idempotencyKey: "restoration:greenwake:restored",
    regionId: "greenwake",
    state: "restored",
    causeId: "greenwake-bond",
  });
  await director.processEvent({
    type: "restoration",
    eventId: "the-grove-partial",
    idempotencyKey: "restoration:the-grove:partial",
    regionId: "the-grove",
    state: "partial",
    causeId: "grove-partial",
  });
  const expected = director.snapshot();
  const capturedCheckpoint = await director.captureCheckpoint();
  sourceSaves.envelope = {
    format: "wild-crown-save",
    schemaVersion: 1,
    kind: "campaign",
    runId: expected.runId,
    campaign: structuredClone(expected.campaign),
    checkpoint: structuredClone(capturedCheckpoint.worldCheckpoint),
    progress: structuredClone(capturedCheckpoint.progress),
    eventKeys: [...(capturedCheckpoint.progress.eventKeys ?? [])],
    savedAt: 0,
  };
  const freshSaves = new CampaignSlotLedger(undefined);
  freshSaves.envelope = sourceSaves.envelope;
  const fresh = new CampaignDirector({ runId: "restoration-checkpoint", saves: freshSaves });
  await fresh.load("restoration-slot");
  const loaded = fresh.snapshot();
  assert.equal(loaded.worldFacts["restoration:greenwake:state"], "restored",
    "noncanonical restored state survives load");
  assert.equal(loaded.worldFacts["restoration:greenwake:restored"], true);
  assert.equal(loaded.worldFacts["restoration:the-grove:state"], "partial",
    "noncanonical partial state survives load");
  assert.equal(loaded.worldFacts["restoration:the-grove:partial"], true);
  assert.equal(loaded.worldFacts["restoration:the-grove:restored"], false);
  for (const region of REGION_IDS) {
    assert.equal(loaded.worldFacts[`restoration:${region}:state`],
      loaded.campaign.world.regions[region],
      `${region} state fact derives from canonical world`);
  }
  const checkpoint = await director.captureCheckpoint();
  assert.equal(await director.restoreCheckpoint(checkpoint), true);
  const restored = director.snapshot();
  assert.equal(restored.worldFacts["restoration:greenwake:state"], expected.worldFacts["restoration:greenwake:state"],
    "checkpoint restore preserves noncanonical state");
  assert.equal(restored.worldFacts["restoration:the-grove:state"], expected.worldFacts["restoration:the-grove:state"],
    "checkpoint restore preserves noncanonical partial state");
  // Captured checkpoints preserve noncanonical local-region state so an older
  // checkpoint cannot regress a freshly-promoted canonical state.
  const worldCheckpoint = await director.captureCheckpoint();
  assert.equal(worldCheckpoint.progress.worldFacts["restoration:greenwake:state"], "restored",
    "checkpoint preserves noncanonical restored state");
  assert.equal(worldCheckpoint.progress.worldFacts["restoration:the-grove:state"], "partial",
    "checkpoint preserves noncanonical partial state");
});

test("restoreCheckpoint normalizes stale canonical facts against authoritative world and preserves local state", async () => {
  // Seed Greenwake/the-grove local state and a canonical Whispering Canopy
  // restoration, then capture the resulting pristine checkpoint.
  const director = new CampaignDirector({ runId: "stale-checkpoint" });
  await atChapter(director, 1);
  await director.processEvent({
    type: "restoration",
    eventId: "greenwake-restored",
    idempotencyKey: "restoration:greenwake:restored",
    regionId: "greenwake",
    state: "restored",
    causeId: "greenwake-bond",
  });
  await director.processEvent({
    type: "restoration",
    eventId: "the-grove-partial",
    idempotencyKey: "restoration:the-grove:partial",
    regionId: "the-grove",
    state: "partial",
    causeId: "grove-partial",
  });
  const pristine = await director.captureCheckpoint();
  const expectedNoncanonical = {
    greenwake: pristine.progress.worldFacts["restoration:greenwake:state"],
    grove: pristine.progress.worldFacts["restoration:the-grove:state"],
  };
  // Promote the canonical Whispering Canopy region to "restored" in the live
  // campaign state so the next checkpoint's authoritative world carries the
  // canonical truth (campaign.world.regions["whispering-canopy"] = "restored").
  // The progress worldFacts will then be intentionally desynced in this test
  // to prove normalizeRestorationFacts derives canonical facts from the world
  // rather than the stale progress payload.
  await director.processEvent({
    type: "restoration",
    eventId: "canopy-restored",
    idempotencyKey: "restoration:whispering-canopy:restored",
    regionId: "whispering-canopy",
    state: "restored",
    causeId: "canopy-test",
  });
  // Recapture after the promotion so the checkpoint is genuinely authoritative
  // for canonical regions; then mutate only the progress worldFacts to install
  // stale canonical facts that disagree with that world.
  const liveCheckpoint = await director.captureCheckpoint();
  assert.equal(liveCheckpoint.progress.worldFacts["restoration:whispering-canopy:state"], "restored",
    "live checkpoint reflects canonical restored state");
  liveCheckpoint.progress.worldFacts["restoration:whispering-canopy:restored"] = false;
  liveCheckpoint.progress.worldFacts["restoration:whispering-canopy:partial"] = false;
  liveCheckpoint.progress.worldFacts["restoration:whispering-canopy:state"] = "unvisited";
  liveCheckpoint.progress.worldFacts["canopy_restored"] = false;
  assert.equal(liveCheckpoint.progress.worldFacts["restoration:whispering-canopy:restored"], false,
    "checkpoint carries stale canonical restored boolean");
  assert.equal(await director.restoreCheckpoint(liveCheckpoint), true,
    "stale canonical facts do not block checkpoint restore");
  const restored = director.snapshot();
  assert.equal(restored.campaign.world.regions["whispering-canopy"], "restored",
    "authoritative world retains canonical restored state");
  assert.equal(restored.worldFacts["restoration:whispering-canopy:state"], "restored",
    "stale canonical state is normalized against authoritative world");
  assert.equal(restored.worldFacts["restoration:whispering-canopy:restored"], true,
    "stale canonical restored boolean is normalized");
  assert.equal(restored.worldFacts["restoration:whispering-canopy:partial"], false,
    "stale canonical partial boolean is cleared");
  assert.equal(restored.worldFacts.canopy_restored, true,
    "stale canonical exposed alias is normalized");
  // Local noncanonical state survives the upgrade intact.
  assert.equal(restored.worldFacts["restoration:greenwake:state"], expectedNoncanonical.greenwake,
    "noncanonical Greenwake state survives checkpoint upgrade");
  assert.equal(restored.worldFacts["restoration:greenwake:restored"], true,
    "noncanonical Greenwake restored boolean survives checkpoint upgrade");
  assert.equal(restored.worldFacts["restoration:the-grove:state"], expectedNoncanonical.grove,
    "noncanonical Grove state survives checkpoint upgrade");
  assert.equal(restored.worldFacts["restoration:the-grove:partial"], true,
    "noncanonical Grove partial boolean survives checkpoint upgrade");
});

test("importing a legacy envelope with only booleans normalizes against canonical state", async () => {
  const legacyCanonicalWorld = {
    fragments: [],
    factions: {
      sky: { leaderId: null, leaderStatus: "leaderless", bondTier: 0, representative: { id: "vara", source: "envoy", willing: false, present: true } },
      canopy: { leaderId: "koro", leaderStatus: "active", bondTier: 0, representative: { id: "koro", source: "leader", willing: false, present: true } },
      fang: { leaderId: "asha", leaderStatus: "active", bondTier: 0, representative: { id: "asha", source: "leader", willing: false, present: true } },
      pack: { leaderId: "ruun", leaderStatus: "active", bondTier: 0, representative: { id: "ruun", source: "leader", willing: false, present: true } },
      shadow: { leaderId: "nyra", leaderStatus: "active", bondTier: 0, representative: { id: "nyra", source: "leader", willing: false, present: true } },
      crown: { leaderId: "solkar", leaderStatus: "active", bondTier: 0, representative: { id: "solkar", source: "leader", willing: false, present: true } },
    },
    // Authoritative world state lives in BOTH campaign.world and checkpoint.world.
    regions: { "whispering-canopy": "restored", "blood-bamboo-valley": "partial", "moonpine-ridge": "unvisited", "mistveil-basin": "unvisited", "sunmane-expanse": "unvisited" },
    hollowReady: false,
    regionalObligations: { canopy_water_seed_accord: false, bamboo_tali_safe: false, bamboo_snare_source: false, mistveil_river_source: false, mistveil_nyra_truth: false, moonpine_settlement: false, sunmane_tribute_ended: false, sunmane_voluntary_governance: false } as never,
    renewedCommitments: { sky: false, canopy: false, fang: false, pack: false, shadow: false, crown: false },
    marekPresent: true,
  };
  const legacyEnvelope = {
    format: "wild-crown-save",
    schemaVersion: 1,
    kind: "campaign",
    runId: "legacy-restoration",
    campaign: { schemaVersion: 1, runId: "legacy-restoration", world: structuredClone(legacyCanonicalWorld), dominionHistory: [] },
    checkpoint: { kind: "campaign-checkpoint", schemaVersion: 1, runId: "legacy-restoration", world: structuredClone(legacyCanonicalWorld) },
    progress: {
      chapter: 1, regionId: "whispering-canopy", safeSpawn: undefined as never,
      activeQuestIds: [], completedQuestIds: [], completedObjectiveIds: [],
      trackedObjectiveId: null, party: { scout: "vara" }, choices: {}, worldFacts: {
        // Stale canonical boolean differs from authoritative world to prove
        // normalization derives facts from the campaign state, not from the legacy
        // boolean. Greenwake has no boolean at all: its absence must default
        // to unvisited (no local-state persistence yet).
        "restoration:whispering-canopy:restored": false,
        "restoration:blood-bamboo-valley:restored": false,
        "restoration:blood-bamboo-valley:partial": false,
        "restoration:moonpine-ridge:restored": false,
        "restoration:mistveil-basin:restored": false,
        "restoration:sunmane-expanse:restored": false,
        "canopy_restored": false,
        "bamboo_restored": false,
        "moonpine_restored": false,
        "mistveil_restored": false,
        "sunmane_restored": false,
        chapter: 1,
      } as never,
      eventLog: [], eventKeys: [], ending: null, revision: 0,
    },
    eventKeys: [],
    savedAt: 0,
  };
  const saves = seededLegacyRepository("history-slot", legacyEnvelope);
  const director = new CampaignDirector({ runId: "legacy-restoration", saves });
  await director.load("history-slot");
  const loaded = director.snapshot();
  assert.equal(loaded.worldFacts["restoration:whispering-canopy:state"], "restored",
    "legacy canonical boolean normalized to authoritative restored state");
  assert.equal(loaded.worldFacts["restoration:whispering-canopy:restored"], true);
  assert.equal(loaded.worldFacts["restoration:blood-bamboo-valley:state"], "partial",
    "legacy canonical state derives from authoritative world");
  assert.equal(loaded.worldFacts["restoration:blood-bamboo-valley:partial"], true);
  assert.equal(loaded.worldFacts["restoration:blood-bamboo-valley:restored"], false);
  assert.equal(loaded.worldFacts["restoration:greenwake:state"], "unvisited",
    "missing local state key defaults to unvisited for legacy envelopes");
  assert.equal(loaded.worldFacts.canopy_restored, true,
    "canonical exposed key restored from authoritative world");
  assert.equal(loaded.worldFacts.bamboo_restored, false,
    "canonical exposed key cleared when authoritative state is not restored");
});

test("legacy boolean-only noncanonical state migrates from existing partial/restored booleans", async () => {
  const canonicalWorld = {
    fragments: [],
    factions: {
      sky: { leaderId: null, leaderStatus: "leaderless", bondTier: 0, representative: { id: "vara", source: "envoy", willing: false, present: true } },
      canopy: { leaderId: "koro", leaderStatus: "active", bondTier: 0, representative: { id: "koro", source: "leader", willing: false, present: true } },
      fang: { leaderId: "asha", leaderStatus: "active", bondTier: 0, representative: { id: "asha", source: "leader", willing: false, present: true } },
      pack: { leaderId: "ruun", leaderStatus: "active", bondTier: 0, representative: { id: "ruun", source: "leader", willing: false, present: true } },
      shadow: { leaderId: "nyra", leaderStatus: "active", bondTier: 0, representative: { id: "nyra", source: "leader", willing: false, present: true } },
      crown: { leaderId: "solkar", leaderStatus: "active", bondTier: 0, representative: { id: "solkar", source: "leader", willing: false, present: true } },
    },
    regions: { "whispering-canopy": "unvisited", "blood-bamboo-valley": "unvisited", "moonpine-ridge": "unvisited", "mistveil-basin": "unvisited", "sunmane-expanse": "unvisited" },
    hollowReady: false,
    regionalObligations: { canopy_water_seed_accord: false, bamboo_tali_safe: false, bamboo_snare_source: false, mistveil_river_source: false, mistveil_nyra_truth: false, moonpine_settlement: false, sunmane_tribute_ended: false, sunmane_voluntary_governance: false } as never,
    renewedCommitments: { sky: false, canopy: false, fang: false, pack: false, shadow: false, crown: false },
    marekPresent: true,
  };
  const legacyEnvelope = {
    format: "wild-crown-save",
    schemaVersion: 1,
    kind: "campaign",
    runId: "legacy-boolean-migration",
    campaign: { schemaVersion: 1, runId: "legacy-boolean-migration", world: structuredClone(canonicalWorld), dominionHistory: [] },
    checkpoint: { kind: "campaign-checkpoint", schemaVersion: 1, runId: "legacy-boolean-migration", world: structuredClone(canonicalWorld) },
    progress: {
      chapter: 1, regionId: "greenwake", safeSpawn: undefined as never,
      activeQuestIds: [], completedQuestIds: [], completedObjectiveIds: [],
      trackedObjectiveId: null, party: { scout: "vara" }, choices: {}, worldFacts: {
        // Legacy envelope has only booleans for greenwake (restored) and
        // the-grove (partial). No state key. Migration should derive
        // local state from these existing true booleans rather than
        // resetting them to unvisited.
        "restoration:greenwake:restored": true,
        "restoration:the-grove:partial": true,
        chapter: 1,
      } as never,
      eventLog: [], eventKeys: [], ending: null, revision: 0,
    },
    eventKeys: [],
    savedAt: 0,
  };
  const saves = seededLegacyRepository("history-slot", legacyEnvelope);
  const director = new CampaignDirector({ runId: "legacy-boolean-migration", saves });
  await director.load("history-slot");
  const loaded = director.snapshot();
  assert.equal(loaded.worldFacts["restoration:greenwake:state"], "restored",
    "legacy restored boolean migrated to local state");
  assert.equal(loaded.worldFacts["restoration:greenwake:restored"], true);
  assert.equal(loaded.worldFacts["restoration:the-grove:state"], "partial",
    "legacy partial boolean migrated to local state");
  assert.equal(loaded.worldFacts["restoration:the-grove:partial"], true);
  assert.equal(loaded.worldFacts["restoration:the-grove:restored"], false);
  for (const region of REGION_IDS) {
    assert.equal(loaded.worldFacts[`restoration:${region}:state`],
      loaded.campaign.world.regions[region],
      `${region} state derives from canonical campaign`);
  }
});

test("quest consequence promotes canonical state when a non-restoration ecology event completes the quest", async () => {
  // The river-source interaction placement is the authoritative authored
  // source-node location in mistveil-basin. Resolve it from the region record
  // so the test stays coupled to authored source-of-truth.
  const mistveilRegion = REGIONS.find((region) => region.id === "mistveil-basin");
  assert.ok(mistveilRegion, "mistveil-basin region is authored");
  const riverSourceEntity = mistveilRegion.entities.find(
    (entity) => entity.id === "river-source" && entity.kind === "interaction",
  );
  assert.ok(riverSourceEntity, "river-source interaction placement is authored");
  assert.equal(riverSourceEntity.interactionId, "river-source",
    "river-source entity uses the canonical interaction id");
  const riverSourcePosition = riverSourceEntity.position;
  const riverSourceInteractionId = riverSourceEntity.interactionId;

  // Seed every objective except the final ecology:river-source as already
  // complete, including the restore-river follow-up, so the canonical state
  // and the `restoration:` facts must remain unvisited until the source event
  // triggers the quest consequence. This test completes via the authored
  // semantic ecology interaction, isolating the consequence path from any
  // direct restoration event that production interaction normally emits.
  const director = new CampaignDirector({ runId: "mire-maw-consequence" });
  await atChapter(director, 4, (checkpoint) => {
    checkpoint.progress.activeQuestIds = ["the-mire-maw"];
    checkpoint.progress.completedObjectiveIds = [
      "the-mire-maw:polluted-source",
      "the-mire-maw:ghor-encounter",
      "the-mire-maw:restore-river",
    ];
  });
  const beforeSnapshot = director.snapshot();
  assert.equal(beforeSnapshot.campaign.world.regions["mistveil-basin"], "unvisited",
    "canonical world.regions[mistveil-basin] is unvisited before the ecology event");
  assert.equal(beforeSnapshot.worldFacts["restoration:mistveil-basin:state"], "unvisited",
    "restoration:mistveil-basin:state derives from unvisited canonical world");
  assert.equal(beforeSnapshot.worldFacts["restoration:mistveil-basin:restored"], false,
    "restoration:mistveil-basin:restored is false before the consequence fires");
  assert.equal(beforeSnapshot.worldFacts.mistveil_restored, false,
    "canonical exposed key mistveil_restored is false before the consequence fires");

  // Authored semantic ecology event that matches the source objective. The
  // kind/target are validated by `eventMatches`; the actor/position/interactionId
  // come straight from the authored river-source entity placement.
  await director.processEvent({
    type: "semantic-interaction",
    eventId: "river-source-restored",
    idempotencyKey: "river-source:restored",
    actorId: "aren",
    interactionId: riverSourceInteractionId,
    kind: "restore",
    targetId: "river-source",
    position: { ...riverSourcePosition },
  });
  // The source ecology event satisfies the source objective; only the quest
  // consequence (not this ecology event itself) promotes canonical state.
  assert.ok(director.snapshot().completedObjectiveIds.includes("the-mire-maw:source"),
    "ecology event satisfied the mire-maw source objective");
  assert.ok(director.snapshot().completedQuestIds.includes("the-mire-maw"),
    "the-mire-maw main quest completed through quest consequence");
  const after = director.snapshot();
  assert.equal(after.campaign.world.regions["mistveil-basin"], "restored",
    "quest consequence promotes canonical world.regions to restored");
  assert.equal(after.worldFacts["restoration:mistveil-basin:state"], "restored",
    "quest consequence propagates canonical state to local facts");
  assert.equal(after.worldFacts["restoration:mistveil-basin:restored"], true,
    "quest consequence sets the restored boolean");
  assert.equal(after.worldFacts["restoration:mistveil-basin:partial"], false,
    "quest consequence clears the partial boolean");
  assert.equal(after.worldFacts.mistveil_restored, true,
    "quest consequence sets the canonical exposed alias");

  // Stale partial event still cannot regress the canonical restored state.
  const beforeStale = director.snapshot();
  await director.processEvent({
    type: "restoration",
    eventId: "stale-partial",
    idempotencyKey: "restoration:mistveil-basin:stale-partial",
    regionId: "mistveil-basin",
    state: "partial",
    causeId: "river-source",
  });
  const finalSnap = director.snapshot();
  assert.equal(finalSnap.campaign.world.regions["mistveil-basin"], "restored",
    "canonical state survives stale partial after consequence");
  assert.equal(finalSnap.worldFacts["restoration:mistveil-basin:restored"], true,
    "restored boolean survives stale partial after consequence");
  assert.equal(finalSnap.worldFacts["restoration:mistveil-basin:partial"], false,
    "partial boolean stays cleared after stale partial post-consequence");
  assert.deepEqual(finalSnap.worldFacts, beforeStale.worldFacts,
    "stale partial leaves every canonical fact untouched");
});
