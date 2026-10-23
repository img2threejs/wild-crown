import assert from "node:assert/strict";
import test from "node:test";
import { COMPANION_IDS } from "../../packages/campaign/src/index.js";
import { QUESTS, REGIONS } from "../../src/content/campaign.js";
import { CHAPTER_RUNTIME, LAYOUT_MIGRATIONS, RELATIONSHIP_RULES } from "../../src/content/chapters.js";
import { CampaignDirector } from "../../src/game/campaign/CampaignDirector.js";
import {
  companionAccess,
  destinationChapterFor,
  mapRegionAccessOf,
  projectionOf,
  REGION_NOT_UNLOCKED,
  ROUTE_NOT_DISCOVERED,
} from "../../src/game/campaign/access.js";
import { partyPanelOf } from "../../src/app/PartyModel.js";
import { projectPartyIntoRegion } from "../../src/app/ChapterParty.js";
import { autosaveSlotId } from "../../src/game/campaign/session.js";
import { SaveRepository } from "../../src/game/storage/SaveRepository.js";
import { FakeIDBFactory } from "../storage/fakeIndexedDB.js";
import type { CampaignSnapshot, RegionDefinition, SaveScope, WorldEvent } from "../../src/game/contracts.js";

const region = (id: string): RegionDefinition => REGIONS.find((item) => item.id === id)!;
const canopy = region("whispering-canopy");
const greenwake = region("greenwake");

const cleanseKoro: WorldEvent = {
  type: "encounter-resolved", eventId: "koro-cleanse", idempotencyKey: "story:koro-cleanse",
  encounterId: "encounter-koro", resolution: "cleansed", actorIds: ["koro"],
};
const rescueVara: WorldEvent = {
  type: "rescue", eventId: "vara-rescue", idempotencyKey: "story:vara-rescue",
  targetId: "vara", locationId: "canopy-waterfall", safe: true,
};

/** A fresh campaign run with no SaveRepository: the plain story authority, isolated from persistence. */
function freshRun(runId: string): CampaignDirector {
  const director = new CampaignDirector({ runId });
  director.startChapterRun({ runId, heroId: "aren", saveScope: "production" });
  return director;
}

/**
 * Places the run in a later chapter through the durable restore path, the way the campaign's own tests do: the
 * journey's own progress is rewritten, never a fabricated event.
 */
async function atChapter(director: CampaignDirector, chapter: number, regionId: string): Promise<void> {
  const target = region(regionId);
  const checkpoint = await director.captureCheckpoint();
  const node = target.navigation.nodes[0]!;
  checkpoint.progress.chapter = chapter;
  checkpoint.progress.regionId = target.id;
  checkpoint.progress.worldFacts = { ...checkpoint.progress.worldFacts, chapter };
  checkpoint.safeSpawn = {
    regionId: target.id,
    position: { ...node.position },
    routeId: node.id,
    cameraAnchorId: target.cameraAnchors[0]!.id,
  };
  checkpoint.progress.session = {
    ...checkpoint.progress.session,
    resume: { ...checkpoint.progress.session.resume, segmentId: null, layoutRevision: 1, checkpointId: null, activeEncounterId: null },
  };
  assert.equal(await director.restoreCheckpoint(checkpoint), true);
}

test("a fresh New Game starts with no traveling companion and refuses a passed one", () => {
  const director = new CampaignDirector({ runId: "fresh-run" });
  const snapshot = director.startChapterRun({ runId: "fresh-run", heroId: "aren", saveScope: "production" });
  assert.deepEqual(snapshot.party, {}, "a new journey starts without a companion");
  assert.equal(snapshot.companions.koro.recruited, false);
  // A free companion selection is refused outright: a fresh run has recruited nobody.
  assert.throws(
    () => director.startChapterRun({ runId: "second", heroId: "aren", companionId: "koro", saveScope: "production" }),
    /earned in the story/,
  );
  assert.equal(director.snapshot().runId, "fresh-run", "a refused start leaves the journey intact");
  assert.throws(
    () => director.startNewRun("third", "aren", "vara"),
    /earned in the story/,
  );
});

test("companion access follows earned recruitment, never settings, map visits or the new ledger", async () => {
  const director = freshRun("access-authority");
  const before = director.snapshot();
  for (const id of COMPANION_IDS) {
    assert.equal(companionAccess(before, id).available, false, `${id} is unavailable before recruitment`);
    assert.ok(companionAccess(before, id).reason, `${id} states why it is unavailable`);
  }
  // Walking through the Canopy does not recruit anybody. The journey stays in chapter 0, so the Canopy — the next
  // chapter — is still closed: a region the campaign has not reached opens nothing.
  await director.processEvent({
    type: "semantic-interaction", eventId: "gate", idempotencyKey: "interaction:greenwake-gate",
    actorId: "aren", interactionId: "greenwake-gate", kind: "traverse", targetId: "greenwake-gate",
    position: { x: 10, y: 2, z: 17 },
  });
  await assert.rejects(
    director.travel("whispering-canopy", "greenwake-canopy-in"),
    /not been unlocked by campaign progression/,
  );
  const visited = director.snapshot();
  assert.equal(visited.worldFacts["interaction:greenwake-gate"], true, "the gate fact is earned");
  for (const id of COMPANION_IDS) {
    assert.equal(companionAccess(visited, id).available, false, `${id} stays unavailable after a visit`);
  }
  // The committed cleanse recruits Koro; the rescue recruits Vara.
  await director.processEvent(cleanseKoro);
  await director.processEvent(rescueVara);
  const earned = director.snapshot();
  assert.equal(companionAccess(earned, "koro").available, true);
  assert.equal(companionAccess(earned, "vara").available, true);
  assert.equal(companionAccess(earned, "asha").available, false);
  assert.equal(companionAccess(earned, "solkar").available, false);
});

test("an earned companion can be equipped and an unearned one is refused with its reason", async () => {
  const director = freshRun("equip-authority");
  await assert.rejects(director.selectParty("koro"), /has not joined your journey/);
  await director.processEvent(cleanseKoro);
  const equipped = await director.selectParty("koro");
  assert.deepEqual(equipped.party, { companionId: "koro" });
  await assert.rejects(director.selectParty("asha"), /has not joined your journey/);
  assert.deepEqual(director.snapshot().party, { companionId: "koro" }, "a refused equip leaves the party intact");
});

test("an exiled Solkar cannot be equipped and the party panel refuses him", async () => {
  const director = freshRun("solkar-exile");
  // The exile is decided in Chapter 5, after Solkar's guardian is cleansed.
  await atChapter(director, 5, "sunmane-expanse");
  await director.processEvent({
    type: "encounter-resolved", eventId: "solkar-cleanse", idempotencyKey: "story:solkar-cleanse",
    encounterId: "encounter-solkar", resolution: "cleansed", actorIds: ["solkar"],
  });
  await director.processEvent({
    type: "choice", eventId: "exile", idempotencyKey: "choice:sunmane-resolution:exile",
    choiceId: "sunmane-resolution", optionId: "exile",
  });
  const exiled = director.snapshot();
  assert.equal(exiled.campaign.world.factions.crown.leaderStatus, "exiled");
  // The exile alone does not recruit Solkar: an unrecruited companion reports that first.
  assert.equal(exiled.companions.solkar.recruited, false);
  assert.equal(companionAccess(exiled, "solkar").available, false);
  assert.match(companionAccess(exiled, "solkar").reason ?? "", /has not joined/);
});

test("a recruited Solkar who is later exiled loses his access", async () => {
  const director = freshRun("solkar-recruited-exile");
  // A legacy save can carry a recruited Solkar: the Crown fragment was held and the alliance was voluntary.
  const checkpoint = await director.captureCheckpoint();
  checkpoint.worldCheckpoint.world.companions.solkar = {
    id: "solkar", recruited: true, bondLevel: 10, dominionLevel: 0, unlockedAbilityIds: [], storyFlags: {},
  };
  checkpoint.worldCheckpoint.world.factions.crown = {
    ...checkpoint.worldCheckpoint.world.factions.crown,
    leaderStatus: "exiled",
    representative: { id: "crown-council", source: "council", present: true, willing: true },
  };
  checkpoint.progress.worldFacts = { ...checkpoint.progress.worldFacts, "solkar-exiled": true, solkarPresent: false };
  assert.equal(await director.restoreCheckpoint(checkpoint), true);

  const exiled = director.snapshot();
  assert.equal(exiled.companions.solkar.recruited, true, "the earned recruitment survives the load");
  assert.equal(companionAccess(exiled, "solkar").available, false);
  assert.match(companionAccess(exiled, "solkar").reason ?? "", /exile/i);
  await assert.rejects(director.selectParty("solkar"), /exile/i);
  const panel = partyPanelOf(exiled, false);
  const solkar = panel.options.find((option) => option.companionId === "solkar")!;
  assert.equal(solkar.available, false);
  assert.match(solkar.reason ?? "", /exile/i);
  // An adopted save that names the exiled Solkar loses the equipment, never the earned progress.
  assert.deepEqual(exiled.party, {});
  assert.equal(exiled.companions.solkar.recruited, true);
});

test("the party panel lists only earned companions as available", async () => {
  const director = freshRun("panel-authority");
  await director.processEvent(cleanseKoro);
  const panel = partyPanelOf(director.snapshot(), false);
  assert.equal(panel.options.find((option) => option.companionId === "koro")!.available, true);
  for (const option of panel.options) {
    if (option.companionId === "koro") continue;
    assert.equal(option.available, false, `${option.companionId} is not offered`);
    assert.ok(option.reason, `${option.companionId} states why`);
  }
});

test("an active encounter still blocks a replacement even for an earned companion", async () => {
  const director = freshRun("encounter-block");
  await director.processEvent(cleanseKoro);
  await director.selectParty("koro");
  const panel = partyPanelOf(director.snapshot(), true);
  assert.equal(panel.options.find((option) => option.companionId === "koro")!.available, false);
  assert.match(panel.options.find((option) => option.companionId === "koro")!.reason ?? "", /active encounter/);
});

test("the party projection refuses to spawn an unearned companion", () => {
  const director = freshRun("projection-authority");
  const snapshot = director.snapshot();
  assert.throws(
    () => projectPartyIntoRegion({
      region: greenwake,
      party: { companionId: "koro" },
      companions: snapshot.companions,
      worldFacts: snapshot.worldFacts,
      campaign: snapshot.campaign,
      spawnPosition: null,
    }),
    /has not joined your journey/,
  );
  // The projection of an earned companion succeeds.
  const earned = { ...snapshot, companions: { ...snapshot.companions, koro: { ...snapshot.companions.koro, recruited: true } } };
  const projection = projectPartyIntoRegion({
    region: greenwake,
    party: { companionId: "koro" },
    companions: earned.companions,
    worldFacts: earned.worldFacts,
    campaign: { ...earned.campaign, world: { ...earned.campaign.world, companions: earned.companions } },
    spawnPosition: null,
  });
  assert.equal(projection.entities.length, 1);
  assert.equal(projection.entities[0]!.actorId, "koro");
});

test("an old save carrying an unearned companion is adopted without the equipment and without losing earned progress", async () => {
  const factory = new FakeIDBFactory();
  const saves = new SaveRepository(factory.asFactory(), { scope: "production" });
  const director = new CampaignDirector({ saves });
  director.startChapterRun({ runId: "adoption-run", heroId: "aren", saveScope: "production" });
  await director.processEvent(cleanseKoro);
  await director.selectParty("koro");
  await director.autosave();

  // The saved progress keeps an unearned companion, as an old free-selection save would.
  const slot = (await saves.loadCampaign(autosaveSlotId("adoption-run"), director.snapshot().campaign))!;
  assert.ok(slot);
  const reopened = new CampaignDirector({ saves });
  await reopened.load(autosaveSlotId("adoption-run"));
  assert.deepEqual(reopened.snapshot().party, { companionId: "koro" }, "an earned companion survives the reload");

  // A checkpoint that names an unearned companion loses only the equipment.
  const checkpoint = await reopened.captureCheckpoint();
  checkpoint.progress.party = { companionId: "asha" };
  assert.equal(await reopened.restoreCheckpoint(checkpoint), true);
  const adopted = reopened.snapshot();
  assert.deepEqual(adopted.party, {}, "the unearned companion is dropped");
  assert.equal(adopted.companions.koro.recruited, true, "the earned recruitment survives");
  assert.equal(adopted.companions.koro.bondLevel, 10, "the earned Bond survives");
  assert.equal(adopted.companions.asha.recruited, false, "no recruitment is invented");
});

test("a new journey resets the earned roster completely", async () => {
  const director = freshRun("reset-run");
  await director.processEvent(cleanseKoro);
  await director.processEvent(rescueVara);
  await director.selectParty("koro");
  const earned = director.snapshot();
  assert.equal(earned.companions.koro.recruited, true);
  assert.deepEqual(earned.party, { companionId: "koro" });

  const reset = director.startChapterRun({ runId: "reset-run-2", heroId: "aren", saveScope: "production" });
  assert.equal(reset.companions.koro.recruited, false, "a new run recruits nobody");
  assert.equal(reset.companions.vara.recruited, false);
  assert.deepEqual(reset.party, {}, "a new run starts without a companion");
  assert.equal(companionAccess(reset, "koro").available, false);
});

test("a visited region alone never opens a map region", () => {
  const director = freshRun("visited-only");
  const snapshot = director.snapshot();
  // The Canopy is the next chapter and no route from Greenwake has been earned yet.
  const locked = mapRegionAccessOf(snapshot, "whispering-canopy", REGIONS, CHAPTER_RUNTIME);
  assert.equal(locked.region.unlocked, false);
  assert.equal(locked.region.reason, REGION_NOT_UNLOCKED);
  // A walked-through region is not an earned route: the access rule never reads `visited:`.
  assert.equal(snapshot.worldFacts["visited:whispering-canopy"], undefined);
  const visited = { ...snapshot, worldFacts: { ...snapshot.worldFacts, "visited:whispering-canopy": true } };
  const stillLocked = mapRegionAccessOf(visited, "whispering-canopy", REGIONS, CHAPTER_RUNTIME);
  assert.equal(stillLocked.region.unlocked, false, "visited: alone cannot grant access");
  assert.equal(stillLocked.region.reason, REGION_NOT_UNLOCKED);
});

test("a map region opens only through an earned route into a reached chapter", async () => {
  const director = new CampaignDirector({
    runId: "map-route",
    chapters: CHAPTER_RUNTIME,
    layoutMigrations: LAYOUT_MIGRATIONS,
    relationshipRules: RELATIONSHIP_RULES,
  });
  director.startChapterRun({ runId: "map-route", heroId: "aren", saveScope: "production" });
  await director.processEvent({
    type: "semantic-interaction", eventId: "gate", idempotencyKey: "interaction:greenwake-gate",
    actorId: "aren", interactionId: "greenwake-gate", kind: "traverse", targetId: "greenwake-gate",
    position: { x: 10, y: 2, z: 17 },
  });
  // The gate is open but the Canopy is chapter 1 and the journey is still in chapter 0.
  const gated = director.mapRegionAccess(director.snapshot(), "whispering-canopy");
  assert.equal(gated.region.unlocked, false, "an unreached chapter stays closed");
  assert.equal(gated.entrances.length, 1, "the authored entrance is preserved");
  assert.equal(gated.entrances[0]?.unlocked, false);
  assert.ok(gated.entrances[0]?.reason, "the closed entrance states why");
  // A plain traversal never advances the chapter, so a destination ahead of the current one stays closed.
  assert.equal(gated.region.reason, REGION_NOT_UNLOCKED);
});

test("the current region and an earned route are open on the map", async () => {
  const director = freshRun("map-open");
  const here = director.mapRegionAccess(director.snapshot(), "greenwake");
  assert.equal(here.region.unlocked, true, "the region the player stands in is open");
  assert.equal(here.region.reason, null);
  // A region the campaign has not reached stays closed, with the reason the journey would give.
  const elsewhere = director.mapRegionAccess(director.snapshot(), "sunmane-expanse");
  assert.equal(elsewhere.region.unlocked, false);
  assert.equal(elsewhere.region.reason, REGION_NOT_UNLOCKED);
  assert.equal(elsewhere.entrances.length, 0, "no authored entrance from Greenwake reaches Sunmane");
});

test("an earned route into a reached chapter is open and a future one is not", async () => {
  // The Bamboo chapter is reached by the Canopy's own exit requirements; the Ridge beyond it is not.
  const director = new CampaignDirector({
    runId: "map-reached",
    chapters: CHAPTER_RUNTIME,
    layoutMigrations: LAYOUT_MIGRATIONS,
    relationshipRules: RELATIONSHIP_RULES,
  });
  director.startChapterRun({ runId: "map-reached", heroId: "aren", saveScope: "production" });
  const snapshot = director.snapshot();
  const bamboo = mapRegionAccessOf(snapshot, "blood-bamboo-valley", REGIONS, CHAPTER_RUNTIME);
  assert.equal(bamboo.region.unlocked, false, "the Canopy's own exit requirements are unmet");
  const ridge = mapRegionAccessOf(snapshot, "moonpine-ridge", REGIONS, CHAPTER_RUNTIME);
  assert.equal(ridge.region.unlocked, false, "a future chapter is never open");
  assert.equal(ridge.entrances.length, 0, "no authored entrance from Greenwake reaches Moonpine");
});

test("the destination chapter of a region comes from the authored runtime, not the chapter number alone", () => {
  const director = freshRun("destination-chapter");
  const projection = projectionOf(director.snapshot());
  // The Grove is the hub: it preserves the current chapter.
  assert.equal(destinationChapterFor(projection, "the-grove", []), projection.chapter);
  // Without an authored runtime the canonical mapping answers.
  assert.equal(destinationChapterFor(projection, "whispering-canopy", []), 1);
  assert.equal(destinationChapterFor(projection, "blood-bamboo-valley", []), 2);
});

test("a chapter transition into an unreached region is refused", async () => {
  // The Director needs the authored chapter runtime to know where a transition may go.
  const director = new CampaignDirector({
    runId: "transition-gate",
    chapters: CHAPTER_RUNTIME,
    layoutMigrations: LAYOUT_MIGRATIONS,
    relationshipRules: RELATIONSHIP_RULES,
  });
  director.startChapterRun({ runId: "transition-gate", heroId: "aren", saveScope: "production" });
  // The Greenwake segment's own exit requirements are unmet, so the transition is refused before it can reach the
  // Canopy — an unreached chapter never opens through a transition.
  await assert.rejects(
    director.advanceChapter({ exitId: "greenwake-canopy-out", requestId: "unreached" }),
    /exit requirements are not met|not been unlocked by campaign progression|not been discovered/,
  );
  assert.equal(director.snapshot().regionId, "greenwake", "the journey stays where it was");
});

test("an optional quest never gates a route", () => {
  // An optional quest is not a chapter exit requirement: the authored exit requirements never name an optional quest.
  for (const segment of CHAPTER_RUNTIME) {
    for (const requirement of segment.exitRequirements) {
      if (!requirement.startsWith("quest:")) continue;
      const quest = QUESTS.find((item) => item.id === requirement.slice("quest:".length));
      assert.ok(quest, requirement);
      assert.equal(quest.optional, false, `${requirement} must not be an optional quest`);
    }
  }
});

test("a practice run is isolated, keeps the earned roster and never invents recruitment", async () => {
  const source = freshRun("practice-source");
  await source.processEvent(cleanseKoro);
  await source.processEvent(rescueVara);
  await source.selectParty("koro");
  const sourceSnapshot = source.snapshot();

  const practice = new CampaignDirector({ saveScope: "production" });
  const run = practice.startPracticeRun({ runId: "practice-run", source: sourceSnapshot, regionId: "whispering-canopy" });
  assert.equal(run.runId, "practice-run");
  assert.equal(run.replay, true, "a practice run is replay-isolated");
  assert.equal(run.regionId, "whispering-canopy");
  assert.equal(run.session.heroId, sourceSnapshot.session.heroId);
  assert.deepEqual(run.party, { companionId: "koro" }, "the earned companion travels with the practice run");
  assert.equal(run.companions.koro.recruited, true);
  assert.equal(run.companions.asha.recruited, false, "no recruitment is invented");
  assert.equal(run.campaign.dominionHistory.length, sourceSnapshot.campaign.dominionHistory.length);

  // Reusing and modifying a source snapshot must not change the running practice world's earned values.
  const bond = run.companions.koro.bondLevel;
  const tier = run.campaign.world.factions.canopy.bondTier;
  sourceSnapshot.campaign.world.companions.koro.bondLevel = 99;
  sourceSnapshot.campaign.world.factions.canopy.bondTier = 3;
  assert.equal(practice.snapshot().companions.koro.bondLevel, bond);
  assert.equal(practice.snapshot().campaign.world.factions.canopy.bondTier, tier);
  await practice.selectParty("vara");
  assert.deepEqual(source.snapshot().party, { companionId: "koro" }, "a practice party change never replaces the journey's party");
});

test("a practice run refuses a Director that owns a save repository", async () => {
  const saves = new SaveRepository(new FakeIDBFactory().asFactory(), { scope: "production" });
  const director = new CampaignDirector({ saves });
  const source = freshRun("practice-source-2");
  assert.throws(
    () => director.startPracticeRun({ runId: "practice-run-2", source: source.snapshot(), regionId: "greenwake" }),
    /cannot be started on a Director that owns a save repository/,
  );
});

test("a practice run drops an unearned equipped companion instead of granting it", async () => {
  const source = freshRun("practice-unearned");
  const sourceSnapshot = source.snapshot();
  sourceSnapshot.party = { companionId: "koro" }; // Explicit stale-equipment fixture from before earned access.
  const practice = new CampaignDirector({ saveScope: "production" });
  const run = practice.startPracticeRun({ runId: "practice-run-3", source: sourceSnapshot, regionId: "greenwake" });
  assert.deepEqual(run.party, {}, "an unearned companion is not carried into practice");
  assert.equal(run.companions.koro.recruited, false);
});

test("a practice run rejects an unknown region", () => {
  const source = freshRun("practice-region");
  const practice = new CampaignDirector({ saveScope: "production" });
  assert.throws(
    () => practice.startPracticeRun({ runId: "practice-run-4", source: source.snapshot(), regionId: "nowhere" as never }),
    /Unknown practice region/,
  );
});

