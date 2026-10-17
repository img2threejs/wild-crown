import assert from "node:assert/strict";
import test from "node:test";
import { CHAPTER_RUNTIME, LAYOUT_MIGRATIONS, RELATIONSHIP_RULES } from "../../src/content/chapters.js";
import { createResumeState, deriveSegmentId } from "../../src/game/campaign/session.js";
import { CampaignDirector } from "../../src/game/campaign/CampaignDirector.js";
import { ACT_I_INTERACTIONS } from "../../src/content/act-i-interactions.js";
import { SaveRepository } from "../../src/game/storage/SaveRepository.js";
import { FakeIDBFactory } from "../storage/fakeIndexedDB.js";
import { autosaveSlotId } from "../../src/game/campaign/session.js";
import type { WorldEvent } from "../../src/game/contracts.js";

test("the Sky objective and acknowledged memory unlock the boar before the prologue quest is complete", () => {
  const base = { chapter: 0, regionId: "greenwake" as const, completedQuestIds: [], chapters: CHAPTER_RUNTIME, facts: {} };
  for (const [objectives, beats] of [
    [[], []],
    [["prologue:receive-sky"], []],
    [[], ["prologue-vision"]],
  ]) {
    assert.equal(createResumeState({ ...base, completedObjectiveIds: objectives!, carry: { completedBeatIds: beats! } }).segmentId, "prologue");
  }
  const resume = createResumeState({
    ...base,
    completedObjectiveIds: ["prologue:receive-sky"],
    carry: { completedBeatIds: ["prologue-vision"] },
  });
  assert.equal(resume.segmentId, "greenwake");
  assert.deepEqual(CHAPTER_RUNTIME.find(segment => segment.segmentId === resume.segmentId)!.encounterEntries.map(entry => entry.encounterId), ["greenwake-boar"]);
});

test("completed legacy prologues remain in Greenwake without new dialogue metadata", () => {
  assert.equal(deriveSegmentId(0, "greenwake", ["prologue"], [], []), "greenwake");
  assert.equal(deriveSegmentId(2, "the-grove", ["prologue"], [], []), "grove");
  // Chapter 3 is the Moonpine Ridge segment now that the full chapter runtime is in place.
  assert.equal(deriveSegmentId(3, "moonpine-ridge", ["prologue"], [], []), "moonpine");
  assert.equal(deriveSegmentId(4, "mistveil-basin", ["prologue"], [], []), "mistveil");
  assert.equal(deriveSegmentId(5, "sunmane-expanse", ["prologue"], [], []), "sunmane");
  assert.equal(deriveSegmentId(6, "the-grove", ["prologue"], [], []), "grove-fall");
  assert.equal(deriveSegmentId(7, "refuge", ["prologue"], [], []), "refuge");
  assert.equal(deriveSegmentId(7, "whispering-canopy", ["prologue"], [], []), "return-canopy");
  assert.equal(deriveSegmentId(7, "moonpine-ridge", ["prologue"], [], []), "return-moonpine");
  assert.equal(deriveSegmentId(8, "heartroot-hollow", ["prologue"], [], []), "hollow");
});

test("acknowledging the Sky memory persists the new segment and its checkpoint before reload", async () => {
  const factory = new FakeIDBFactory();
  const saves = new SaveRepository(factory.asFactory(), {
    scope: "candidate-chapters", chapters: CHAPTER_RUNTIME, layoutMigrations: LAYOUT_MIGRATIONS,
  });
  const options = { saves, chapters: CHAPTER_RUNTIME, layoutMigrations: LAYOUT_MIGRATIONS, relationshipRules: RELATIONSHIP_RULES };
  const director = new CampaignDirector(options);
  director.startChapterRun({ runId: "sky-memory-save", heroId: "aren", saveScope: "candidate-chapters" });
  await director.advanceStory({ beatId: "prologue-opening", lineIndex: 0, skip: true });
  for (const id of ["greenwake-roars", "tend-vara", "vara-fragment"]) {
    const interaction = ACT_I_INTERACTIONS.find(item => item.id === id)!;
    await director.processEvent({ ...interaction.success, eventId: id, idempotencyKey: "story:" + id, interactionId: id } as WorldEvent);
  }
  assert.equal(director.snapshot().segmentId, "prologue");
  await director.advanceStory({ beatId: "prologue-vision", lineIndex: 0, skip: true });
  const reopened = new CampaignDirector(options);
  const loaded = await reopened.load(autosaveSlotId("sky-memory-save"));
  assert.equal(loaded.segmentId, "greenwake");
  assert.equal(loaded.completedQuestIds.includes("prologue"), false);
  assert.equal(loaded.session.resume.checkpointId, null, "the prologue checkpoint is cleared; no Greenwake checkpoint is eligible before taking the staff");
  assert.deepEqual(reopened.chapterDefinition()!.encounterEntries.map(entry => entry.encounterId), ["greenwake-boar"]);
});

test("exploration recorded before a quest activates reconciles the next quest in the same durable commit", async () => {
  const factory = new FakeIDBFactory();
  const saves = new SaveRepository(factory.asFactory(), {
    scope: "candidate-chapters", chapters: CHAPTER_RUNTIME, layoutMigrations: LAYOUT_MIGRATIONS,
  });
  const options = { saves, chapters: CHAPTER_RUNTIME, layoutMigrations: LAYOUT_MIGRATIONS, relationshipRules: RELATIONSHIP_RULES };
  const director = new CampaignDirector(options);
  director.startChapterRun({ runId: "early-canopy-exploration", heroId: "aren", saveScope: "candidate-chapters" });
  const acknowledge = async () => {
    while (director.snapshot().session.resume.requiredBeatQueue.length) {
      const resume = director.snapshot().session.resume;
      await director.advanceStory({ beatId: resume.requiredBeatQueue[0]!, lineIndex: resume.dialogue?.lineIndex ?? 0, skip: true });
    }
  };
  const interact = async (id: string) => {
    const interaction = ACT_I_INTERACTIONS.find(item => item.id === id)!;
    await director.processEvent({ ...interaction.success, eventId: id, idempotencyKey: "early:" + id, interactionId: id } as WorldEvent);
    await acknowledge();
  };
  await acknowledge();
  for (const id of ["greenwake-roars", "tend-vara", "vara-fragment", "warden-staff"]) await interact(id);
  await director.beginChapterEncounter("greenwake-boar", "greenwake-pre-boar");
  await director.processEvent({ type: "encounter-resolved", eventId: "boar", idempotencyKey: "early:boar", encounterId: "greenwake-boar", resolution: "cleansed", actorIds: ["corrupted-boar"] });
  await acknowledge();
  await interact("greenwake-gate");
  await director.advanceChapter({ exitId: "greenwake-canopy-out", requestId: "early-canopy" });
  await acknowledge();
  for (const id of ["canopy-vine-route", "canopy-vault", "koro-trail", "canopy-waterwheel", "monkey-rescue", "orchard-seeds"]) await interact(id);
  assert.equal(director.snapshot().completedQuestIds.includes("thief-in-the-branches"), false);
  await interact("canopy-tend-vara");
  for (const id of ["bird-mark", "warning-response"]) {
    await director.processEvent({ type: "semantic-interaction", eventId: id, idempotencyKey: "early:" + id, interactionId: id, actorId: "vara", kind: "signal", targetId: id, position: { x: 0, y: 0, z: 0 } });
  }
  assert.equal(director.snapshot().completedQuestIds.includes("fallen-scout"), true);
  assert.equal(director.snapshot().completedQuestIds.includes("thief-in-the-branches"), true);
  assert.equal(director.snapshot().activeQuestIds.includes("empty-orchard"), true);
  assert.equal(director.snapshot().completedObjectiveIds.includes("empty-orchard:water-flow"), true);
  const reopened = new CampaignDirector(options);
  await reopened.load(autosaveSlotId("early-canopy-exploration"));
  assert.deepEqual(reopened.snapshot().completedObjectiveIds, director.snapshot().completedObjectiveIds);
  await acknowledge();
  await director.beginChapterEncounter("encounter-koro", "canopy-pre-koro");
  assert.equal(director.snapshot().session.resume.activeEncounterId, "encounter-koro");
});
