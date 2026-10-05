import assert from "node:assert/strict";
import test from "node:test";
import { CampaignDirector, CampaignChoiceRejectedError } from "../../src/game/campaign/CampaignDirector.js";
import { CombatEngine } from "../../src/game/combat/CombatEngine.js";
import { SaveRepository, SaveRepositoryError } from "../../src/game/storage/SaveRepository.js";
import { CHAPTERS, RETURN_BEATS } from "../../src/content/story.js";
import { QUESTS, REGIONS } from "../../src/content/campaign.js";
import { FACTION_IDS, FRAGMENT_IDS, REGIONAL_OBLIGATION_IDS } from "../../packages/campaign/src/index.js";
import type { CampaignSafeCheckpoint, WorldEvent } from "../../src/game/contracts.js";

// Observe the Director's durable event boundary without requiring browser IndexedDB.
class RecordingLedger extends SaveRepository {
  writes: Parameters<SaveRepository["appendRunLedger"]>[] = [];
  fail = false;
  override async appendRunLedger(...args: Parameters<SaveRepository["appendRunLedger"]>): Promise<void> {
    if (this.fail) throw new Error("ledger refused the transaction");
    this.writes.push(structuredClone(args));
  }
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
      if (chapter === 6) checkpoint.progress.worldFacts.wardenCall = true;
    });
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
    checkpoint.progress.party = { scout: "vara", combat: "solkar", utility: "solkar" };
    checkpoint.worldCheckpoint.world.fragments = ["heartroot-crown"];
  });
  await director.choose("sunmane-resolution", "exile");
  const exiled = director.snapshot();
  assert.equal(exiled.campaign.world.factions.crown.leaderStatus, "exiled");
  assert.equal(exiled.worldFacts.solkarPresent, false);
  assert.equal(exiled.worldFacts["solkar-exiled"], true);
  assert.deepEqual(exiled.party, { scout: "vara" });
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
  assert.deepEqual(renewed.party, { scout: "vara" });
  assert.throws(() => director.selectParty("combat", "solkar"), /cannot return after exile/);
  const restored = await director.captureCheckpoint();
  assert.equal(await director.restoreCheckpoint(restored), true);
  assert.equal(director.snapshot().worldFacts.solkarPresent, false);
  assert.deepEqual(director.snapshot().campaign.world.factions.crown.representative, renewed.campaign.world.factions.crown.representative);
});

test("a refused durable exile commit restores facts, domain, party and checkpoint", async () => {
  const saves = new RecordingLedger(undefined);
  const director = new CampaignDirector({ runId: "exile-rollback", saves });
  await atChapter(director, 5, (checkpoint) => {
    checkpoint.progress.party = { scout: "vara", combat: "solkar" };
  });
  const before = director.snapshot();
  saves.fail = true;
  await assert.rejects(director.choose("sunmane-resolution", "exile"), (error: unknown) => {
    assert.ok(error instanceof SaveRepositoryError);
    assert.equal(error.code, "transaction");
    assert.equal(error instanceof CampaignChoiceRejectedError, false);
    return true;
  });
  assert.deepEqual(director.snapshot(), before);
  assert.deepEqual(saves.writes, []);
});

test("unavailable faction choices are typed permanent rejections and leave the next valid event usable", async () => {
  const saves = new RecordingLedger(undefined);
  const director = new CampaignDirector({ runId: "unavailable-covenant-type", saves });
  await atChapter(director, 5);
  const before = director.snapshot();
  await assert.rejects(director.processEvent(choiceEvent("faction-covenant", "crown", "unavailable-crown")), (error: unknown) => {
    assert.ok(error instanceof CampaignChoiceRejectedError);
    assert.equal(error.choiceId, "faction-covenant");
    assert.equal(error.optionId, "crown");
    assert.equal(error.message, "This faction covenant is not available until its story commitments are fulfilled.");
    assert.equal(error instanceof SaveRepositoryError, false);
    return true;
  });
  assert.deepEqual(director.snapshot(), before);
  assert.deepEqual(saves.writes, []);
  await director.choose("sunmane-resolution", "exile");
  assert.equal(director.snapshot().choices["sunmane-resolution"], "exile");
  assert.equal(saves.writes.length, 1);
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
  assert.deepEqual(saves.writes[0]?.[1], [{ sequence: 1, leaderId: "solkar" }]);
  assert.equal(director.ending().unmet.some((item) => item.id === "no_dominion"), true);
  const committed = director.snapshot();
  assert.equal(engine.resolveInteraction("solkar-offer", "solkar", "dominion"), false);
  assert.deepEqual(engine.consumeWorldEvents(), []);
  await director.choose("sunmane-resolution", "dominion");
  assert.deepEqual(director.snapshot(), committed);
  assert.equal(saves.writes.length, 1);
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
    assert.equal(saves.writes.length, 6);
    // A fresh simulation instance has no local key memory; the persisted Director boundary remains authoritative.
    const freshEngine = new CombatEngine();
    freshEngine.loadRegion({ runId: settled.runId, regionId: region.id,
      presentActorIds: [], playerPosition: position, worldFacts: settled.worldFacts });
    const skyAccepted = settled.campaign.world.renewedCommitments.sky;
    const skyOption = skyAccepted ? "sky" : "decline-sky";
    assert.equal(freshEngine.resolveInteraction("refuge-council", "refuge-council", skyOption), true);
    await director.processEvent(freshEngine.consumeWorldEvents()[0]!);
    assert.deepEqual(director.snapshot(), settled);
    assert.equal(saves.writes.length, 6);
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
    assert.equal(saves.writes.length, 6);
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
  await director.choose("pack-leadership", "luma");
  await atChapter(director, 4);
  await director.choose("marek-fate", "leave");
  await atChapter(director, 5);
  await director.choose("sunmane-resolution", "exile");
  await atChapter(director, 7, (checkpoint) => {
    checkpoint.progress.activeQuestIds = [RETURN_BEATS[0]!];
  });
  // Director-level semantic fixtures exercise graph reduction, not authored playable return mechanics.
  const actions: WorldEvent[] = [
    { type: "semantic-interaction", eventId: "seed-route", idempotencyKey: "seed-route",
      actorId: "aren", interactionId: "seed-route", kind: "coordinate", targetId: "seed-route", position: { x: 0, y: 0, z: 0 } },
    { type: "rescue", eventId: "nursery-return", idempotencyKey: "nursery-return",
      targetId: "nursery-return", locationId: "blood-bamboo-valley", safe: true },
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
    assert.deepEqual(director.snapshot().party, { scout: "vara" });
    assert.equal(director.snapshot().ending, null);
    assert.equal(director.ending().available, false);
  }
  assert.equal(director.snapshot().activeQuestIds.includes("wild-march"), true);
  assert.equal(director.snapshot().worldFacts.wildMarchFormed, undefined);
});

test("producer choice metadata cannot change the authored Dominion identity or create history", async () => {
  const director = new CampaignDirector({ runId: "choice-metadata-authority" });
  await atChapter(director, 3);
  await director.processEvent({
    type: "choice", eventId: "metadata-pack", idempotencyKey: "metadata-pack",
    choiceId: "pack-leadership", optionId: "dominion-luma", leaderId: "solkar", dominion: false,
  });
  assert.equal(director.snapshot().factions.pack.leaderId, "luma");
  assert.deepEqual(director.snapshot().campaign.dominionHistory, [{ sequence: 1, leaderId: "luma" }]);
  await atChapter(director, 5);
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
