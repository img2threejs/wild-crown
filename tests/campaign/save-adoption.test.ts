import assert from "node:assert/strict";
import test from "node:test";
import { createCheckpoint, createNewRun, recordLeaderDominion } from "../../packages/campaign/src/index.js";
import { REGIONS } from "../../src/content/campaign.js";
import { CampaignDirector } from "../../src/game/campaign/CampaignDirector.js";
import type { CampaignState } from "../../packages/campaign/src/index.js";
import type { CampaignSafeCheckpoint, RegionId, WorldEvent } from "../../src/game/contracts.js";
import { SaveRepository, SaveRepositoryError, type GameSaveEnvelope, type RunLedgerRecord, type SaveSlotRecord, type SaveSlotSummary } from "../../src/game/storage/SaveRepository.js";

// Deterministic consumer/domain boundary fixture, not an IndexedDB substitute.
// Native persistence/ledger transactions are exercised by storage/browser-smoke.html.
class SelectedSlotRepository extends SaveRepository {
  readonly writes: { runId: string; eventKeys: readonly string[] }[] = [];
  constructor(readonly selected: GameSaveEnvelope, readonly chapter = 0, readonly regionId: RegionId = "greenwake") { super(undefined); }
  protected override async loadRecord(slotId: string, currentRunId?: string): Promise<SaveSlotRecord> {
    if (currentRunId && currentRunId !== this.selected.runId) throw new SaveRepositoryError("run-mismatch", "Wrong journey.");
    const envelope = (await this.importSave(structuredClone(this.selected))).envelope;
    return { slotId, label: "Selected", runId: envelope.runId, kind: "campaign", updatedAt: 1, chapter: this.chapter, regionId: this.regionId, envelope };
  }
  override async listSlots(): Promise<SaveSlotSummary[]> {
    return [{ slotId: "selected", label: "Selected", runId: this.selected.runId, kind: "campaign", updatedAt: 1, chapter: this.chapter, regionId: this.regionId }];
  }
  override async appendRunLedger(runId: string, _events: readonly RunLedgerRecord["dominionHistory"][number][], eventKeys: readonly string[]): Promise<void> {
    this.writes.push({ runId, eventKeys: [...eventKeys] });
  }
  override async commitImported(slotId: string, label: string, envelope: GameSaveEnvelope, chapter: number, regionId: RegionId): Promise<SaveSlotSummary> {
    const validated = await this.importSave(envelope);
    Object.assign(this.selected, validated.envelope);
    return { slotId, label, runId: this.selected.runId, kind: "campaign", updatedAt: 1, chapter, regionId };
  }
}

class DeferredCheckpointRepository extends SelectedSlotRepository {
  readonly pendingCheckpoints: { progress: Parameters<SaveRepository["saveCheckpoint"]>[8]; complete: () => void }[] = [];
  override async saveCheckpoint(...args: Parameters<SaveRepository["saveCheckpoint"]>): Promise<SaveSlotSummary> {
    const [slotId, label, , campaign, chapter, regionId, , , progress] = args;
    await new Promise<void>(complete => { this.pendingCheckpoints.push({ progress, complete }); });
    return { slotId, label, runId: campaign.runId, kind: "campaign", updatedAt: 1, chapter, regionId };
  }
}
const sky: WorldEvent = { type: "fragment", eventId: "sky", idempotencyKey: "branch:sky", fragmentId: "heartroot-sky", sourceId: "vara" };
const dominate = (leaderId: "koro" | "asha"): WorldEvent => ({ type: "encounter-resolved", eventId: `dominion:${leaderId}`, idempotencyKey: `dominion:${leaderId}`, encounterId: `encounter-${leaderId}`, resolution: "dominated", actorIds: [leaderId] });
function saved(campaign: CampaignState, checkpoint?: CampaignSafeCheckpoint): GameSaveEnvelope {
  return { format: "wild-crown-save", schemaVersion: 1, kind: "campaign", runId: campaign.runId, campaign: structuredClone(campaign), checkpoint: createCheckpoint(campaign),
    progress: checkpoint ? { ...structuredClone(checkpoint.progress),
      activeQuestIds: [...checkpoint.progress.activeQuestIds],
      completedQuestIds: [...checkpoint.progress.completedQuestIds],
      completedObjectiveIds: [...checkpoint.progress.completedObjectiveIds],
      eventLog: structuredClone([...checkpoint.progress.eventLog]),
      eventKeys: [...checkpoint.progress.eventKeys],
      safeSpawn: structuredClone(checkpoint.safeSpawn) } : null,
    eventKeys: checkpoint ? [...checkpoint.progress.eventKeys] : [], savedAt: 1 };
}
const code = (expected: string) => (error: unknown) => error instanceof SaveRepositoryError && error.code === expected;

test("fresh title Director adopts selected run, branch progress, spawn and future event ownership", async () => {
  const source = new CampaignDirector({ runId: "saved-journey" });
  await source.processEvent(sky);
  const checkpoint = await source.captureCheckpoint();
  const repository = new SelectedSlotRepository(saved(source.snapshot().campaign, checkpoint));
  const director = new CampaignDirector({ saves: repository, runId: "fresh-title" });
  const loaded = await director.load("selected");
  assert.equal(loaded.runId, "saved-journey");
  assert.equal(loaded.campaign.runId, loaded.runId);
  assert.equal(loaded.lastSafeCheckpoint?.runId, loaded.runId);
  assert.deepEqual(loaded.lastSafeCheckpoint?.safeSpawn, checkpoint.safeSpawn);
  assert.deepEqual(loaded.fragments, ["heartroot-sky"]);
  assert.deepEqual(loaded.completedObjectiveIds, source.snapshot().completedObjectiveIds);
  await director.processEvent({ ...sky, fragmentId: "heartroot-canopy", eventId: "later", idempotencyKey: "later:canopy", sourceId: "koro" });
  assert.equal(repository.writes.at(-1)?.runId, "saved-journey");
  assert.ok(director.snapshot().fragments.includes("heartroot-canopy"));
});

test("cross-run adoption never carries the current journey's Dominion or branch events", async () => {
  const repository = new SelectedSlotRepository(saved(recordLeaderDominion(createNewRun("selected-run"), "koro")));
  const director = new CampaignDirector({ saves: repository, runId: "unrelated-current" });
  await director.processEvent(dominate("asha"));
  await director.processEvent(sky);
  const loaded = await director.load("selected");
  assert.deepEqual(loaded.campaign.dominionHistory.map(event => event.leaderId), ["koro"]);
  assert.deepEqual(loaded.fragments, []);
  assert.deepEqual(loaded.lastSafeCheckpoint?.progress.eventKeys, []);
  await director.processEvent(sky);
  assert.deepEqual(director.snapshot().fragments, ["heartroot-sky"]);
  assert.equal(repository.writes.at(-1)?.runId, "selected-run");
  const independent = director.startNewRun("explicit-new-game");
  assert.deepEqual(independent.campaign.dominionHistory, []);
  assert.deepEqual(independent.fragments, []);
  assert.equal(independent.lastSafeCheckpoint?.runId, "explicit-new-game");
});

test("same-run older slot retains current Dominion but rewinds objective and event branch", async () => {
  const original = new CampaignDirector({ runId: "same-run" });
  const checkpoint = await original.captureCheckpoint();
  const repository = new SelectedSlotRepository(saved(original.snapshot().campaign, checkpoint));
  const director = new CampaignDirector({ saves: repository, runId: "same-run" });
  await director.processEvent(sky);
  await director.processEvent(dominate("koro"));
  const loaded = await director.load("selected");
  assert.deepEqual(loaded.campaign.dominionHistory.map(event => event.leaderId), ["koro"]);
  assert.deepEqual(loaded.fragments, []);
  assert.deepEqual(loaded.completedObjectiveIds, checkpoint.progress.completedObjectiveIds);
  assert.equal(loaded.lastSafeCheckpoint?.progress.eventKeys.includes(sky.idempotencyKey), false);
  await director.processEvent(sky);
  assert.deepEqual(director.snapshot().fragments, ["heartroot-sky"]);
});

test("old progress without a revision does not inherit the unrelated current revision", async () => {
  const source = new CampaignDirector({ runId: "old-revision-run" });
  const envelope = saved(source.snapshot().campaign, await source.captureCheckpoint());
  delete envelope.progress!.revision;
  const director = new CampaignDirector({ saves: new SelectedSlotRepository(envelope), runId: "current-revision-run" });
  await director.processEvent(sky);
  assert.ok(director.snapshot().revision > 0);
  assert.equal((await director.load("selected")).revision, 0);
});

test("malformed/future/replay loads reject without publishing or replacing live state", async () => {
  for (const [mutate, expected] of [
    [(envelope: GameSaveEnvelope) => { Object.assign(envelope, { schemaVersion: 99 }); }, "future-schema"],
    [(envelope: GameSaveEnvelope) => { envelope.checkpoint!.runId = "wrong"; }, "run-mismatch"],
    [(envelope: GameSaveEnvelope) => { Object.assign(envelope, { kind: "showcase-replay" }); }, "replay-isolated"],
    [(envelope: GameSaveEnvelope) => { Object.assign(envelope.campaign!, { world: {} }); }, "corrupt"],
  ] as const) {
    const envelope = saved(createNewRun("bad-selected"));
    mutate(envelope);
    const director = new CampaignDirector({ saves: new SelectedSlotRepository(envelope), runId: "preserved-current" });
    await director.processEvent(sky);
    const before = director.snapshot();
    let notifications = 0;
    const unsubscribe = director.subscribe(() => notifications++);
    await assert.rejects(director.load("selected"), code(expected));
    assert.deepEqual(director.snapshot(), before);
    assert.equal(notifications, 1);
    unsubscribe();
  }
});

test("invalid legacy location rejects before run/branch mutation", async () => {
  const director = new CampaignDirector({ saves: new SelectedSlotRepository(saved(createNewRun("legacy")), 99), runId: "preserved" });
  await director.processEvent(sky);
  const before = director.snapshot();
  await assert.rejects(director.load("selected"), code("corrupt"));
  assert.deepEqual(director.snapshot(), before);
});

test("run adoption does not loosen same-run checkpoint or replay restoration guards", async () => {
  const source = new CampaignDirector({ runId: "source" });
  const director = new CampaignDirector({ saves: new SelectedSlotRepository(saved(source.snapshot().campaign)), runId: "title" });
  const titleCheckpoint = await director.captureCheckpoint();
  await director.load("selected");
  const before = director.snapshot();
  assert.equal(await director.restoreCheckpoint(titleCheckpoint), false);
  assert.deepEqual(director.snapshot(), before);
  director.startShowcase("replay");
  const replay = director.snapshot();
  assert.equal(await director.restoreCheckpoint(await source.captureCheckpoint()), false);
  assert.deepEqual(director.snapshot(), replay);
});

test("slot selection replaces current leadership choice and quest branch with the saved branch", async () => {
  const source = await atQuest("moonpine-ridge", 3, "the-alpha-below");
  await source.choose("pack-leadership", "luma");
  const checkpoint = await source.captureCheckpoint();
  const repository = new SelectedSlotRepository(saved(source.snapshot().campaign, checkpoint), 3, "moonpine-ridge");
  const director = new CampaignDirector({ saves: repository, runId: "other-pack-journey" });
  const current = await director.captureCheckpoint();
  assert.equal(await director.restoreCheckpoint({ ...current, progress: { ...current.progress, chapter: 3 } }), true);
  await director.choose("pack-leadership", "ruun");
  const loaded = await director.load("selected");
  assert.deepEqual(loaded.choices, source.snapshot().choices);
  assert.equal(loaded.choices["pack-leadership"], "luma");
  assert.deepEqual(loaded.activeQuestIds, checkpoint.progress.activeQuestIds);
  assert.deepEqual(loaded.completedObjectiveIds, checkpoint.progress.completedObjectiveIds);
  assert.deepEqual(loaded.lastSafeCheckpoint?.progress.eventKeys, checkpoint.progress.eventKeys);
  assert.deepEqual(loaded.lastSafeCheckpoint?.progress.eventLog, checkpoint.progress.eventLog);
});

test("explicit load/import cannot promote showcase Dominion even when run IDs collide", async () => {
  for (const operation of ["load", "import"] as const) {
    const envelope = saved(createNewRun("colliding-run"));
    const repository = new SelectedSlotRepository(envelope);
    const director = new CampaignDirector({ saves: repository, runId: "title" });
    director.startShowcase("colliding-run");
    await director.processEvent(dominate("koro"));
    assert.deepEqual(director.snapshot().campaign.dominionHistory.map(event => event.leaderId), ["koro"]);
    const selected = operation === "load"
      ? await director.load("selected")
      : await director.importSave(JSON.stringify(envelope), "selected", "Campaign");
    assert.equal(selected.replay, false);
    assert.equal(selected.runId, "colliding-run");
    assert.deepEqual(selected.campaign.dominionHistory, []);
    assert.deepEqual(repository.selected.campaign!.dominionHistory, []);
  }
});

async function atQuest(regionId: RegionId, chapter: number, questId: string): Promise<CampaignDirector> {
  const director = new CampaignDirector({ runId: `checkpoint-${questId}` });
  const checkpoint = await director.captureCheckpoint();
  const region = REGIONS.find(item => item.id === regionId)!;
  assert.equal(await director.restoreCheckpoint({ ...checkpoint,
    safeSpawn: { regionId, position: region.navigation.nodes[0]!.position, routeId: region.navigation.nodes[0]!.id, cameraAnchorId: region.cameraAnchors[0]!.id },
    progress: { ...checkpoint.progress, chapter, regionId, activeQuestIds: [questId], completedObjectiveIds: [], worldFacts: { ...checkpoint.progress.worldFacts, chapter } },
  }), true);
  return director;
}

for (const [regionId, chapter, questId, encounterId, actorIds] of [
  ["blood-bamboo-valley", 2, "the-ash-hunters", "camp-hunters", ["hunter-melee-west", "hunter-melee-east", "hunter-ranged"]],
  ["blood-bamboo-valley", 2, "a-mothers-roar", "encounter-asha", ["asha"]],
  ["moonpine-ridge", 3, "the-alpha-below", "encounter-ruun", ["ruun"]],
  ["sunmane-expanse", 5, "the-lions-offer", "encounter-solkar", ["solkar"]],
] as const) {
  test(`checkpoint for ${questId} resets actual authored encounter/instances, not phase tokens`, async () => {
    const director = await atQuest(regionId, chapter, questId);
    const checkpoint = await director.captureCheckpoint();
    assert.equal(checkpoint.encounterReset.encounterId, encounterId);
    assert.deepEqual(checkpoint.encounterReset.actorIds, actorIds);
    await director.processEvent({ type: "encounter-resolved", eventId: `resolve:${encounterId}`, idempotencyKey: `resolve:${encounterId}`, encounterId, resolution: encounterId === "camp-hunters" ? "subdued" : "cleansed", actorIds });
    assert.deepEqual((await director.captureCheckpoint()).encounterReset, { policy: "restart-from-entry", encounterId: null, actorIds: [] });
    const repository = new SelectedSlotRepository(saved(director.snapshot().campaign, await director.captureCheckpoint()), chapter, regionId);
    const fresh = new CampaignDirector({ saves: repository, runId: "fresh-after-resolution" });
    assert.equal((await fresh.load("selected")).lastSafeCheckpoint?.encounterReset.encounterId, null);
  });
}

test("Greenwake wildlife checkpoint resolves authoritative combat content despite empty regional encounter index", async () => {
  const director = new CampaignDirector({ runId: "greenwake-checkpoint" });
  const checkpoint = await director.captureCheckpoint();
  assert.equal(checkpoint.encounterReset.encounterId, "greenwake-boar");
  assert.deepEqual(checkpoint.encounterReset.actorIds, ["corrupted-boar", "greenwake-sap-stalker", "greenwake-root-rammer"]);
  await director.processEvent({ type: "encounter-resolved", eventId: "boar", idempotencyKey: "boar", encounterId: "greenwake-boar", resolution: "cleansed", actorIds: ["corrupted-boar", "greenwake-sap-stalker", "greenwake-root-rammer"] });
  assert.equal((await director.captureCheckpoint()).encounterReset.encounterId, null);
});

for (const field of ["eventId", "idempotencyKey", "choiceId", "optionId"] as const) {
  for (const [name, invalid] of [["missing", undefined], ["null", null], ["number", 7], ["array", []], ["empty", ""], ["whitespace", "  "]] as const) {
    test(`malformed saved choice ${field} ${name} leaves Director state intact on load/import`, async () => {
      const source = new CampaignDirector({ runId: "malformed-choice-source" });
      const input = saved(source.snapshot().campaign, await source.captureCheckpoint());
      const event: Record<string, unknown> = { type: "choice", eventId: "historic", idempotencyKey: "historic:choice", choiceId: "pack-leadership", optionId: "ruun" };
      if (invalid === undefined) delete event[field];
      else event[field] = invalid;
      input.progress!.eventLog = [event];
      const repository = new SelectedSlotRepository(input);
      const director = new CampaignDirector({ saves: repository, runId: "preserved-live-journey" });
      await director.processEvent(sky);
      const before = director.snapshot();
      const writesBefore = repository.writes.length;
      const original = structuredClone(repository.selected);
      let notifications = 0;
      const unsubscribe = director.subscribe(() => notifications++);
      await assert.rejects(director.load("selected"), code("corrupt"));
      await assert.rejects(director.importSave(JSON.stringify(input), "selected", "Must preserve"), code("corrupt"));
      assert.deepEqual(director.snapshot(), before);
      assert.deepEqual(repository.selected, original);
      assert.equal(repository.writes.length, writesBefore);
      assert.equal(notifications, 1);
      unsubscribe();
    });
  }
}

test("legacy adoption reads location and journey from one slot record, not a later slot listing", async () => {
  class ChangedListingRepository extends SelectedSlotRepository {
    override async listSlots(): Promise<SaveSlotSummary[]> {
      throw new Error("A second slot listing cannot be part of adopting a record.");
    }
  }
  const repository = new ChangedListingRepository(saved(createNewRun("legacy-selected")), 3, "moonpine-ridge");
  const director = new CampaignDirector({ saves: repository, runId: "title" });
  const loaded = await director.load("selected");
  assert.equal(loaded.runId, "legacy-selected");
  assert.equal(loaded.chapter, 3);
  assert.equal(loaded.regionId, "moonpine-ridge");
});

test("failed adopted-run save preserves recovery checkpoint; successful retry saves that journey", async () => {
  class CheckpointRepository extends SelectedSlotRepository {
    fail = true;
    readonly checkpoints: GameSaveEnvelope[] = [];
    override async saveCheckpoint(...args: Parameters<SaveRepository["saveCheckpoint"]>): Promise<SaveSlotSummary> {
      if (this.fail) throw new SaveRepositoryError("quota", "Synthetic boundary failure, not IndexedDB evidence.");
      const [slotId, label, checkpoint, campaign, chapter, regionId, eventKeys, kind = "campaign", progress = null] = args;
      const envelope: GameSaveEnvelope = { format: "wild-crown-save", schemaVersion: 1, kind, runId: campaign.runId,
        checkpoint: structuredClone(checkpoint), campaign: structuredClone(campaign), progress: structuredClone(progress), eventKeys: [...eventKeys], savedAt: 1 };
      this.checkpoints.push(envelope);
      return { slotId, label, runId: campaign.runId, kind, updatedAt: 1, chapter, regionId };
    }
  }
  const source = new CampaignDirector({ runId: "adopted-save-run" });
  const repository = new CheckpointRepository(saved(source.snapshot().campaign, await source.captureCheckpoint()));
  const director = new CampaignDirector({ saves: repository, runId: "unrelated-title" });
  await director.load("selected");
  await director.processEvent(sky);
  const before = director.snapshot();
  assert.deepEqual(before.lastSafeCheckpoint?.worldCheckpoint.world.fragments, []);
  await assert.rejects(director.save("selected", "Failed save"), code("quota"));
  await assert.rejects(director.saveNewSlot("Failed new slot"), code("quota"));
  assert.deepEqual(director.snapshot(), before);
  assert.deepEqual(repository.checkpoints, []);
  repository.fail = false;
  await director.save("selected", "Retry");
  const persisted = repository.checkpoints.at(-1)!;
  assert.equal(persisted.runId, "adopted-save-run");
  assert.equal(persisted.checkpoint?.runId, persisted.runId);
  assert.deepEqual(persisted.campaign?.world.fragments, ["heartroot-sky"]);
  assert.deepEqual(persisted.progress?.eventKeys, [sky.idempotencyKey]);
  assert.deepEqual(director.snapshot().lastSafeCheckpoint?.worldCheckpoint, persisted.checkpoint);
  director.startShowcase("adopted-save-run");
  await assert.rejects(director.save("selected", "Replay"), code("replay-isolated"));
  assert.equal(repository.checkpoints.length, 1);
});

test("a completed save cannot replace a newer journey's recovery checkpoint", async () => {
  let complete!: () => void;
  const pending = new Promise<void>(resolve => { complete = resolve; });
  class PendingRepository extends SelectedSlotRepository {
    override async saveCheckpoint(...args: Parameters<SaveRepository["saveCheckpoint"]>): Promise<SaveSlotSummary> {
      const [slotId, label, , campaign, chapter, regionId] = args;
      await pending;
      return { slotId, label, runId: campaign.runId, kind: "campaign", updatedAt: 1, chapter, regionId };
    }
  }
  const repository = new PendingRepository(saved(createNewRun("reused-run-id")));
  const director = new CampaignDirector({ saves: repository, runId: "reused-run-id" });
  await director.processEvent(sky);
  const writing = director.save("selected", "Earlier state");
  // Even an explicitly reused ID/revision cannot authorize the old completion.
  director.startNewRun("reused-run-id");
  await director.processEvent({ ...sky, eventId: "new-canopy", idempotencyKey: "new:canopy", fragmentId: "heartroot-canopy", sourceId: "koro" });
  const before = director.snapshot();
  complete();
  await writing;
  assert.deepEqual(director.snapshot(), before);
  assert.deepEqual(director.snapshot().fragments, ["heartroot-canopy"]);
});

for (const operation of ["save", "saveNewSlot"] as const) {
  test(`pending ${operation} cannot replace a checkpoint captured after party selection at the same revision`, async () => {
    const repository = new DeferredCheckpointRepository(saved(createNewRun(`pending-party-${operation}`)));
    const director = new CampaignDirector({ saves: repository, runId: repository.selected.runId });
    await director.processEvent({ ...sky, eventId: "unlock-koro", idempotencyKey: "unlock:koro", fragmentId: "heartroot-canopy", sourceId: "koro" });
    await director.processEvent({ ...sky, eventId: "unlock-asha", idempotencyKey: "unlock:asha", fragmentId: "heartroot-fang", sourceId: "asha" });
    director.selectParty("combat", "koro");
    const checkpointA = await director.captureCheckpoint();
    const campaignBefore = director.snapshot().campaign;
    const writing = operation === "save"
      ? director.save("selected", "Party A")
      : director.saveNewSlot("Party A");
    assert.equal(repository.pendingCheckpoints.length, 1);
    assert.equal(repository.pendingCheckpoints[0]!.progress?.party.combat, "koro");
    director.selectParty("combat", "asha");
    const checkpointB = await director.captureCheckpoint();
    assert.equal(checkpointB.progress.revision, checkpointA.progress.revision);
    assert.equal(checkpointB.checkpointId, checkpointA.checkpointId);
    assert.deepEqual(director.snapshot().campaign, campaignBefore);
    assert.equal(checkpointB.progress.party.combat, "asha");
    const beforeCompletion = director.snapshot();
    repository.pendingCheckpoints[0]!.complete();
    await writing;
    assert.deepEqual(director.snapshot(), beforeCompletion);
    assert.deepEqual(director.snapshot().lastSafeCheckpoint, checkpointB);
  });
}

for (const completionOrder of ["older-first", "newer-first"] as const) {
  test(`newer party save retains recovery when writes complete ${completionOrder}`, async () => {
    const repository = new DeferredCheckpointRepository(saved(createNewRun(`party-save-${completionOrder}`)));
    const director = new CampaignDirector({ saves: repository, runId: repository.selected.runId });
    await director.processEvent({ ...sky, eventId: "unlock-koro", idempotencyKey: "unlock:koro", fragmentId: "heartroot-canopy", sourceId: "koro" });
    await director.processEvent({ ...sky, eventId: "unlock-asha", idempotencyKey: "unlock:asha", fragmentId: "heartroot-fang", sourceId: "asha" });
    director.selectParty("combat", "koro");
    await director.captureCheckpoint();
    const older = director.save("selected", "Party A");
    director.selectParty("combat", "asha");
    const newer = director.save("selected", "Party B");
    assert.equal(repository.pendingCheckpoints.length, 2);
    assert.equal(repository.pendingCheckpoints[0]!.progress?.party.combat, "koro");
    assert.equal(repository.pendingCheckpoints[1]!.progress?.party.combat, "asha");
    assert.equal(repository.pendingCheckpoints[0]!.progress?.revision, repository.pendingCheckpoints[1]!.progress?.revision);
    const first = completionOrder === "older-first" ? 0 : 1;
    repository.pendingCheckpoints[first]!.complete();
    await (first === 0 ? older : newer);
    const afterFirst = director.snapshot();
    repository.pendingCheckpoints[1 - first]!.complete();
    await (first === 0 ? newer : older);
    assert.equal(director.snapshot().lastSafeCheckpoint?.progress.party.combat, "asha");
    if (completionOrder === "newer-first") assert.deepEqual(director.snapshot(), afterFirst);
  });
}
