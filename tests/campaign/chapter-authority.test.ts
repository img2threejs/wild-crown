import assert from "node:assert/strict";
import test from "node:test";
import { COMPANION_IDS, DOMINION_PACT_LEVEL, RECRUITMENT_BOND, RESPECTFUL_PACT_BOND } from "../../packages/campaign/src/index.js";
import { QUESTS, REGIONS } from "../../src/content/campaign.js";
import { STORY_DIALOGUE } from "../../src/content/story.js";
import { CampaignChoiceRejectedError, CampaignDirector } from "../../src/game/campaign/CampaignDirector.js";
import { autosaveSlotId, deriveSegmentId } from "../../src/game/campaign/session.js";
import type {
  CampaignSnapshot, ChapterRuntimeDefinition, RegionDefinition, SaveScope, WorldEvent,
} from "../../src/game/contracts.js";
import { SaveRepository, SaveRepositoryError } from "../../src/game/storage/SaveRepository.js";
import { FakeIDBFactory } from "../storage/fakeIndexedDB.js";

const region = (id: string): RegionDefinition => REGIONS.find((item) => item.id === id)!;
const canopy = region("whispering-canopy");
const bamboo = region("blood-bamboo-valley");
const grove = region("the-grove");
const camera = (item: RegionDefinition): string => item.cameraAnchors[0]!.id;
const code = (expected: string) => (error: unknown) => error instanceof SaveRepositoryError && error.code === expected;

/** Fixture definitions, not the authored Act I data: they exercise the Director's chapter mechanics against real regions. */
const DEFINITIONS: readonly ChapterRuntimeDefinition[] = [
  {
    segmentId: "canopy", chapter: 1, regionId: canopy.id, layoutRevision: 1,
    checkpoints: [
      { id: "canopy-arrival", regionId: canopy.id, nodeId: "canopy-trial-start", cameraAnchorId: camera(canopy), radius: 4, requiresFacts: [], encounterId: null },
      { id: "canopy-pre-koro", regionId: canopy.id, nodeId: "canopy-story-courtyard-west", cameraAnchorId: camera(canopy), radius: 6, requiresFacts: [], encounterId: "encounter-koro" },
      { id: "canopy-post-koro", regionId: canopy.id, nodeId: "canopy-trial-courtyard", cameraAnchorId: camera(canopy), radius: 6, requiresFacts: ["encounter-koro-cleansed"], encounterId: null },
    ],
    encounterEntries: [{
      id: "koro-entry", encounterId: "encounter-koro", regionId: canopy.id, objectiveId: "fallen-scout:tend-vara",
      center: canopy.navigation.nodes.find((node) => node.id === "canopy-story-courtyard-west")!.position, radius: 6, checkpointId: "canopy-pre-koro", requiresFacts: [],
    }],
    exitRequirements: ["choice:koro-pact"],
  },
  {
    segmentId: "bamboo", chapter: 2, regionId: bamboo.id, layoutRevision: 1,
    checkpoints: [{ id: "bamboo-arrival", regionId: bamboo.id, nodeId: "bamboo-canopy-gateway", cameraAnchorId: camera(bamboo), radius: 4, requiresFacts: [], encounterId: null }],
    encounterEntries: [], exitRequirements: [],
  },
  {
    segmentId: "grove", chapter: 2, regionId: grove.id, layoutRevision: 1,
    checkpoints: [{ id: "grove-arrival", regionId: grove.id, nodeId: "grove-trial-start", cameraAnchorId: camera(grove), radius: 4, requiresFacts: [], encounterId: null }],
    encounterEntries: [], exitRequirements: [],
  },
];

interface Harness { factory: FakeIDBFactory; saves: SaveRepository; director: CampaignDirector; runId: string }

async function startRun(options: { scope?: SaveScope; runId?: string; factory?: FakeIDBFactory } = {}): Promise<Harness> {
  const factory = options.factory ?? new FakeIDBFactory();
  const scope = options.scope ?? "production";
  const runId = options.runId ?? "chapter-run";
  const saves = new SaveRepository(factory.asFactory(), { scope, chapters: DEFINITIONS });
  const director = new CampaignDirector({ saves });
  director.startChapterRun({ runId, heroId: "yara", saveScope: scope });
  await director.autosave();
  return { factory, saves, director, runId };
}

/** Places the run at an authored location through the checkpoint restoration path (session fields kept consistent). */
async function restoreAt(
  director: CampaignDirector,
  where: { chapter: number; regionId: string; nodeId?: string; active: string[]; completed: string[]; facts?: Record<string, boolean | number | string> },
  mutate?: (checkpoint: Awaited<ReturnType<CampaignDirector["captureCheckpoint"]>>) => void,
): Promise<void> {
  const checkpoint = await director.captureCheckpoint();
  const target = region(where.regionId);
  const node = target.navigation.nodes.find((item) => item.id === (where.nodeId ?? target.navigation.nodes[0]!.id))!;
  const segmentId = deriveSegmentId(where.chapter, target.id, where.completed, checkpoint.progress.completedObjectiveIds, checkpoint.progress.session.resume.completedBeatIds);
  const definition = DEFINITIONS.find((item) => item.segmentId === segmentId);
  checkpoint.progress.chapter = where.chapter;
  checkpoint.progress.regionId = target.id;
  checkpoint.progress.activeQuestIds = where.active as never;
  checkpoint.progress.completedQuestIds = where.completed as never;
  checkpoint.progress.worldFacts = { ...checkpoint.progress.worldFacts, chapter: where.chapter, ...where.facts };
  checkpoint.safeSpawn = { regionId: target.id, position: { ...node.position }, routeId: node.id, cameraAnchorId: camera(target) };
  checkpoint.progress.session = {
    ...checkpoint.progress.session,
    resume: { ...checkpoint.progress.session.resume, segmentId, layoutRevision: definition?.layoutRevision ?? 0, checkpointId: definition?.checkpoints[0]?.id ?? null, activeEncounterId: null },
  };
  mutate?.(checkpoint);
  assert.equal(await director.restoreCheckpoint(checkpoint), true);
}
const atCanopy = (director: CampaignDirector, mutate?: Parameters<typeof restoreAt>[2]) =>
  restoreAt(director, { chapter: 1, regionId: canopy.id, nodeId: "canopy-trial-start", active: ["fallen-scout"], completed: ["prologue"] }, mutate);

const cleanseKoro: WorldEvent = { type: "encounter-resolved", eventId: "koro-cleanse", idempotencyKey: "story:koro-cleanse", encounterId: "encounter-koro", resolution: "cleansed", actorIds: ["koro"] };
const cleanseAsha: WorldEvent = { type: "encounter-resolved", eventId: "asha-cleanse", idempotencyKey: "story:asha-cleanse", encounterId: "encounter-asha", resolution: "cleansed", actorIds: ["asha"] };
const projection = (snapshot: CampaignSnapshot) => ({
  campaign: snapshot.campaign, worldFacts: snapshot.worldFacts, choices: snapshot.choices, active: snapshot.activeQuestIds,
  completed: snapshot.completedQuestIds, objectives: snapshot.completedObjectiveIds, companions: snapshot.companions, party: snapshot.party,
  chapter: snapshot.chapter, region: snapshot.regionId, revision: snapshot.revision,
  resume: { ...snapshot.session.resume },
});

test("startChapterRun creates an immutable-hero campaign run in the repository's scope and persists it durably", async () => {
  const { factory, director, runId } = await startRun({ scope: "candidate-chapters" });
  const snapshot = director.snapshot();
  assert.equal(snapshot.chapter, 0);
  assert.equal(snapshot.replay, false);
  assert.deepEqual({ ...snapshot.session, resume: undefined }, { saveScope: "candidate-chapters", assetPolicy: "candidate", heroId: "yara", resume: undefined });
  assert.equal(snapshot.segmentId, "prologue");
  assert.throws(() => director.startChapterRun({ runId: "x", heroId: "yara", saveScope: "production" }), /scope/);
  assert.throws(() => director.startChapterRun({ runId: "x", heroId: "nobody" as never, saveScope: "candidate-chapters" }), /hero/);
  assert.equal(director.snapshot().runId, runId, "a rejected start leaves the journey intact");
  const reopened = new CampaignDirector({ saves: new SaveRepository(factory.asFactory(), { scope: "candidate-chapters", chapters: DEFINITIONS }) });
  const loaded = await reopened.load(autosaveSlotId(runId));
  assert.equal(loaded.session.heroId, "yara");
  assert.equal(loaded.session.saveScope, "candidate-chapters");
  assert.throws(() => new CampaignDirector({ saves: new SaveRepository(factory.asFactory(), { scope: "candidate-chapters" }), saveScope: "production" }), /scope/);
  assert.throws(() => new CampaignDirector({ saves: new SaveRepository(factory.asFactory()), chapters: DEFINITIONS }), /SaveRepository/);
});

test("the same action sequence yields identical campaign state under production and candidate policy except metadata/scope", async () => {
  const run = async (scope: SaveScope) => {
    const { director } = await startRun({ scope, runId: "policy-run", factory: new FakeIDBFactory() });
    await atCanopy(director);
    await director.processEvent({ type: "rescue", eventId: "vara", idempotencyKey: "story:vara", targetId: "vara", locationId: "canopy-waterfall", safe: true });
    await director.processEvent(cleanseKoro);
    await director.choose("koro-pact", "bond");
    await director.selectParty("koro");
    return director.snapshot();
  };
  const production = await run("production");
  const candidate = await run("candidate-chapters");
  assert.deepEqual(projection(production), projection(candidate));
  assert.equal(production.session.saveScope, "production");
  assert.equal(candidate.session.saveScope, "candidate-chapters");
  assert.equal(candidate.session.assetPolicy, "candidate");
});

test("recruitment is an explicit committed outcome: a fragment alone never recruits Koro or Asha", async () => {
  const { director } = await startRun();
  await atCanopy(director);
  await director.processEvent({ type: "fragment", eventId: "f", idempotencyKey: "story:f", fragmentId: "heartroot-canopy", sourceId: "koro" });
  assert.equal(director.snapshot().companions.koro.recruited, false);
  await director.selectParty("koro");
  assert.equal(director.snapshot().companions.koro.recruited, false);
  await director.processEvent({ ...cleanseKoro, eventId: "koro-subdued", idempotencyKey: "story:koro-subdued", resolution: "subdued" });
  assert.equal(director.snapshot().companions.koro.recruited, false, "only a cleanse recruits");
  await director.processEvent(cleanseKoro);
  const koro = director.snapshot().companions.koro;
  assert.equal(koro.recruited, true);
  assert.equal(koro.bondLevel, RECRUITMENT_BOND);
  assert.deepEqual(director.snapshot().companions.asha.recruited, false);
  // Vara is recruited by tending her or by the Sky fragment; neither recruits anyone else.
  await director.processEvent({ type: "rescue", eventId: "v", idempotencyKey: "story:v", targetId: "vara", locationId: "canopy-waterfall", safe: true });
  assert.equal(director.snapshot().companions.vara.recruited, true);
  assert.deepEqual(COMPANION_IDS.filter((id) => director.snapshot().companions[id].recruited), ["vara", "koro"]);
});

test("duplicate events do not re-award recruitment, Bond or Dominion", async () => {
  const { director, factory } = await startRun();
  await atCanopy(director);
  await director.processEvent(cleanseKoro);
  await director.choose("koro-pact", "bond");
  const settled = director.snapshot();
  const writes = factory.transactionCount;
  await director.processEvent(cleanseKoro);
  await director.processEvent({ ...cleanseKoro, eventId: "again", idempotencyKey: "story:koro-cleanse" });
  await director.choose("koro-pact", "bond");
  assert.deepEqual(director.snapshot(), settled);
  assert.equal(factory.transactionCount, writes);
  assert.equal(settled.companions.koro.bondLevel, RECRUITMENT_BOND + RESPECTFUL_PACT_BOND);
});

for (const [choiceId, companionId, cleanse, chapter, regionId] of [
  ["koro-pact", "koro", cleanseKoro, 1, canopy.id],
  ["asha-pact", "asha", cleanseAsha, 2, bamboo.id],
] as const) {
  test(`${choiceId}: the Director derives leader history from the authored choice, never from producer tags`, async () => {
    const { director } = await startRun();
    await restoreAt(director, { chapter, regionId, active: [], completed: ["prologue"] });
    const dominionEvent = (tags: { leaderId?: string; dominion?: boolean }): WorldEvent =>
      ({ type: "choice", eventId: "pact-dominion", idempotencyKey: "story:pact-dominion", choiceId, optionId: "dominion", ...tags });
    // Prerequisites: the guardian must have been cleansed, and the pact belongs to its own chapter.
    await assert.rejects(director.processEvent(dominionEvent({})), CampaignChoiceRejectedError);
    await director.processEvent(cleanse);
    assert.equal(director.snapshot().session.resume.pendingChoiceId, choiceId, "the ceremony is required until chosen");
    await assert.rejects(director.choose(choiceId, "bargain"), CampaignChoiceRejectedError);
    // A lying producer cannot redirect or suppress the authored leader identity.
    await director.processEvent(dominionEvent({ leaderId: "ruun", dominion: false }));
    const after = director.snapshot();
    assert.deepEqual(after.campaign.dominionHistory.map((event) => event.leaderId), [companionId]);
    assert.equal(after.companions[companionId].dominionLevel, DOMINION_PACT_LEVEL);
    assert.equal(after.companions[companionId].bondLevel, RECRUITMENT_BOND, "Dominion adds no respectful-pact Bond");
    assert.equal(after.companions[companionId].storyFlags["possession-risk"], true);
    assert.equal(after.session.resume.pendingChoiceId, null);
    assert.equal(after.worldFacts["choice:" + choiceId], true);
    // The same choice is idempotent; the contradictory option is a permanent rejection, even with a fresh key.
    await director.choose(choiceId, "dominion");
    await assert.rejects(director.choose(choiceId, "bond"), (error: unknown) => error instanceof CampaignChoiceRejectedError && /already has a committed/.test(error.message));
    assert.deepEqual(director.snapshot().campaign.dominionHistory.length, 1);
    // Both pacts keep the companion in the story: Dominion changes the relationship, not membership.
    assert.equal(after.companions[companionId].recruited, true);
  });

  test(`${choiceId}: the respectful pact adds Bond only and leaves Dominion history empty`, async () => {
    const { director } = await startRun();
    await restoreAt(director, { chapter, regionId, active: [], completed: ["prologue"] });
    await director.processEvent(cleanse);
    await assert.rejects(director.processEvent({ type: "chapter-transition", eventId: "t", idempotencyKey: "t", fromChapter: chapter, toChapter: chapter + 1, triggerId: "t" }), /required story choice/);
    await director.choose(choiceId, "bond");
    const state = director.snapshot();
    assert.equal(state.companions[companionId].bondLevel, RECRUITMENT_BOND + RESPECTFUL_PACT_BOND);
    assert.equal(state.companions[companionId].dominionLevel, 0);
    assert.deepEqual(state.campaign.dominionHistory, []);
  });
}

test("restoring an older snapshot cannot erase Dominion history or its companion floor", async () => {
  const { director } = await startRun();
  await atCanopy(director);
  await director.processEvent(cleanseKoro);
  const beforeChoice = await director.captureCheckpoint();
  await director.choose("koro-pact", "dominion");
  assert.equal(await director.restoreCheckpoint(beforeChoice), true);
  const restored = director.snapshot();
  assert.deepEqual(restored.campaign.dominionHistory.map((event) => event.leaderId), ["koro"]);
  assert.equal(restored.companions.koro.dominionLevel, DOMINION_PACT_LEVEL);
  assert.equal(restored.choices["koro-pact"], undefined, "the displayed choice rolls back with the snapshot");
});

test("chapter checkpoints and encounter entry: authored, validated, durable, and never regressing", async () => {
  const { factory, director, runId } = await startRun();
  await atCanopy(director);
  const states = () => ({ resume: director.snapshot().session.resume, safe: director.snapshot().lastSafeCheckpoint! });
  assert.equal(states().resume.checkpointId, "canopy-arrival");
  await assert.rejects(director.reachCheckpoint("nonexistent"), /Unknown chapter checkpoint/);
  await assert.rejects(director.reachCheckpoint("canopy-post-koro"), /prerequisites/);
  const reached = await director.reachCheckpoint("canopy-pre-koro");
  assert.equal(reached.session.resume.checkpointId, "canopy-pre-koro");
  assert.equal(reached.lastSafeCheckpoint!.safeSpawn.routeId, "canopy-story-courtyard-west");
  assert.equal(reached.worldFacts["checkpoint:canopy-pre-koro"], true);
  const writes = factory.transactionCount;
  assert.equal((await director.reachCheckpoint("canopy-pre-koro")).revision, reached.revision, "re-reaching is idempotent");
  assert.equal(factory.transactionCount, writes);
  await assert.rejects(director.beginChapterEncounter("encounter-koro", "canopy-arrival"), /Unknown chapter encounter entry/);
  await assert.rejects(director.beginChapterEncounter("encounter-asha", "canopy-pre-koro"), /Unknown chapter encounter entry/);
  const begun = await director.beginChapterEncounter("encounter-koro", "canopy-pre-koro");
  assert.equal(begun.session.resume.activeEncounterId, "encounter-koro");
  assert.equal(begun.lastSafeCheckpoint!.encounterReset.encounterId, "encounter-koro");
  assert.equal(begun.lastSafeCheckpoint!.progress.session.resume.activeEncounterId, "encounter-koro");
  await assert.rejects(director.selectParty("vara"), /active encounter/);
  // Reopen: the unresolved encounter resumes at its named pre-fight checkpoint.
  const reopened = new CampaignDirector({ saves: new SaveRepository(factory.asFactory(), { chapters: DEFINITIONS }) });
  const loaded = await reopened.load(autosaveSlotId(runId));
  assert.equal(loaded.session.resume.activeEncounterId, "encounter-koro");
  assert.equal(loaded.session.resume.checkpointId, "canopy-pre-koro");
  assert.equal(loaded.lastSafeCheckpoint!.safeSpawn.routeId, "canopy-story-courtyard-west");
  // Death: restore the safe checkpoint; the encounter restarts, the fight's partial events do not survive.
  await director.processEvent({ type: "encounter-phase", eventId: "ph", idempotencyKey: "story:ph", encounterId: "encounter-koro", actorId: "koro", phaseId: "broken-branches", phaseIndex: 1, state: "cleared", simulationTick: 5 });
  const recovery = director.snapshot().lastSafeCheckpoint!;
  assert.equal(await director.restoreCheckpoint(recovery), true);
  assert.equal(director.snapshot().session.resume.activeEncounterId, "encounter-koro");
  assert.equal(director.isEventCommitted("story:ph"), false);
  const afterRestore = new CampaignDirector({ saves: new SaveRepository(factory.asFactory(), { chapters: DEFINITIONS }) });
  assert.equal((await afterRestore.load(autosaveSlotId(runId))).worldFacts["encounterPhase:encounter-koro:1:cleared"], undefined, "the stored autosave matches the restored boundary");
  // Resolution commits once and ends the active encounter; a resolved encounter cannot be begun again.
  await director.processEvent(cleanseKoro);
  assert.equal(director.snapshot().session.resume.activeEncounterId, null);
  await assert.rejects(director.beginChapterEncounter("encounter-koro", "canopy-pre-koro"), /already resolved/);
  assert.equal((await director.reachCheckpoint("canopy-post-koro")).session.resume.checkpointId, "canopy-post-koro");
  assert.equal((await director.reachCheckpoint("canopy-pre-koro")).session.resume.checkpointId, "canopy-post-koro", "backtracking never regresses the respawn point");
});

test("a failed checkpoint write publishes nothing and leaves no half-activated encounter", async () => {
  const { factory, director } = await startRun();
  await atCanopy(director);
  const before = director.snapshot();
  const faulted = factory.transactionCount + 1;
  factory.fault = (context) => (context.transactionIndex === faulted && context.operation === "commit" ? "abort" : undefined);
  await assert.rejects(director.beginChapterEncounter("encounter-koro", "canopy-pre-koro"), code("transaction"));
  factory.fault = null;
  assert.deepEqual(director.snapshot(), before);
  assert.equal(director.snapshot().session.resume.activeEncounterId, null);
  const retried = await director.beginChapterEncounter("encounter-koro", "canopy-pre-koro");
  assert.equal(retried.session.resume.activeEncounterId, "encounter-koro");
});

test("one chapter-transition operation: atomic, retry-idempotent per request, and a later return journey is a new request", async () => {
  const { factory, director } = await startRun();
  const exit = canopy.exits.find((route) => route.destinationRegionId === bamboo.id)!;
  const entrance = bamboo.entrances.find((route) => route.traversalEvent === exit.traversalEvent)!;
  const unlock = [exit.unlockFact, entrance.unlockFact].filter((fact): fact is string => Boolean(fact));
  const chapterOneQuests = QUESTS.filter((quest) => !quest.optional && quest.chapter === 1).map((quest) => quest.id);
  await atCanopy(director, (checkpoint) => {
    checkpoint.progress.activeQuestIds = [];
    checkpoint.progress.completedQuestIds = ["prologue", ...chapterOneQuests] as never;
    for (const fact of unlock) checkpoint.progress.worldFacts = { ...checkpoint.progress.worldFacts, [fact]: true };
  });
  await director.processEvent(cleanseKoro);
  await assert.rejects(director.advanceChapter({ exitId: exit.id, requestId: "req-1" }), /required story choice|exit requirements/);
  await director.choose("koro-pact", "bond");
  await director.processEvent({ type: "restoration", eventId: "canopy-restored", idempotencyKey: "story:canopy-restored", regionId: canopy.id, state: "restored", causeId: "canopy-test" });
  await assert.rejects(director.advanceChapter({ exitId: "not-an-exit", requestId: "req-x" }), /not authored/);
  await assert.rejects(director.advanceChapter({ exitId: exit.id, requestId: " " }), /request id/);

  const before = director.snapshot();
  const faulted = factory.transactionCount + 1;
  factory.fault = (context) => (context.transactionIndex === faulted && context.store === "slots" && context.operation === "put" ? "error" : undefined);
  await assert.rejects(director.advanceChapter({ exitId: exit.id, requestId: "req-1" }), code("transaction"));
  factory.fault = null;
  assert.deepEqual(director.snapshot(), before, "neither the chapter advance nor the travel was published");
  assert.equal(director.isEventCommitted("transition:req-1:chapter"), false);
  assert.equal(director.isEventCommitted("transition:req-1:travel"), false);

  const advanced = await director.advanceChapter({ exitId: exit.id, requestId: "req-1" });
  assert.equal(advanced.chapter, 2);
  assert.equal(advanced.regionId, bamboo.id);
  assert.equal(advanced.segmentId, "bamboo");
  assert.equal(advanced.session.resume.segmentId, "bamboo");
  assert.equal(advanced.session.resume.checkpointId, "bamboo-arrival");
  assert.equal(advanced.lastSafeCheckpoint!.safeSpawn.regionId, bamboo.id);
  assert.equal(director.isEventCommitted("transition:req-1:chapter"), true);
  const writes = factory.transactionCount;
  assert.deepEqual(director.snapshot(), (await director.advanceChapter({ exitId: exit.id, requestId: "req-1" })), "the retry of the same request is idempotent");
  assert.equal(factory.transactionCount, writes);

  // Later return journey: a new request id is never blocked by a consumed one-shot key.
  const back = bamboo.exits.find((route) => route.destinationRegionId === canopy.id)!;
  const returned = await director.advanceChapter({ exitId: back.id, requestId: "req-2" });
  assert.equal(returned.regionId, canopy.id);
  assert.equal(returned.chapter, 2, "revisiting an earlier region never moves the chapter backwards");
  const again = await director.advanceChapter({ exitId: exit.id, requestId: "req-3" });
  assert.equal(again.regionId, bamboo.id);
  assert.equal(again.chapter, 2);
});

test("a Grove visit preserves the current chapter; the legacy travel key is per request, not consumed forever", async () => {
  const { director } = await startRun();
  const toGrove = bamboo.exits.find((route) => route.destinationRegionId === grove.id)!;
  const groveEntrance = grove.entrances.find((route) => route.traversalEvent === toGrove.traversalEvent)!;
  const facts = Object.fromEntries([toGrove.unlockFact, groveEntrance.unlockFact].filter((fact): fact is string => Boolean(fact)).map((fact) => [fact, true]));
  await restoreAt(director, { chapter: 2, regionId: bamboo.id, nodeId: "bamboo-canopy-gateway", active: [], completed: ["prologue"], facts });
  await director.processEvent({ type: "restoration", eventId: "bamboo-restored", idempotencyKey: "story:bamboo-restored", regionId: bamboo.id, state: "restored", causeId: "bamboo-test" });
  const visited = await director.travel(grove.id, groveEntrance.id);
  assert.equal(visited.chapter, 2);
  assert.equal(visited.regionId, grove.id);
  assert.equal(visited.segmentId, "grove");
  assert.equal(visited.session.resume.checkpointId, "grove-arrival");
  const back = grove.exits.find((route) => route.destinationRegionId === bamboo.id)!;
  const bambooEntrance = bamboo.entrances.find((route) => route.traversalEvent === back.traversalEvent)!;
  await director.travel(bamboo.id, bambooEntrance.id);
  const secondVisit = await director.travel(grove.id, groveEntrance.id);
  assert.equal(secondVisit.regionId, grove.id, "returning to a visited region is a new journey");
  assert.equal(secondVisit.chapter, 2);
});

test("authored local arcs are accepted as intra-region traversal and never change region, chapter or spawn", async () => {
  const withArc = REGIONS.find((candidate) => candidate.traversalArcs.some((arc) => arc.destinationRegionId === candidate.id && !arc.unlockFact))!;
  assert.ok(withArc, "content defines at least one authored local arc");
  const arc = withArc.traversalArcs.find((item) => item.destinationRegionId === withArc.id && !item.unlockFact)!;
  const { director } = await startRun();
  await restoreAt(director, { chapter: Math.min(withArc.id === "greenwake" ? 0 : 3, 8), regionId: withArc.id, active: [], completed: ["prologue"] });
  const before = director.snapshot();
  const event: WorldEvent = { type: "traversal", eventId: "arc", idempotencyKey: "story:arc", routeId: arc.traversalEvent, fromRegion: withArc.id, toRegion: withArc.id, landmarkId: arc.id };
  const after = await director.processEvent(event);
  assert.equal(after.regionId, before.regionId);
  assert.equal(after.chapter, before.chapter);
  assert.deepEqual(after.lastSafeCheckpoint!.safeSpawn, before.lastSafeCheckpoint!.safeSpawn);
  assert.equal(after.worldFacts["traversed:" + arc.traversalEvent], true);
  await assert.rejects(director.processEvent({ ...event, idempotencyKey: "story:arc-bad", landmarkId: "not-an-arc" }), /authored region route/);
});

test("durable required dialogue: line progress, stale acknowledgements, skip, and reload never replay or lose a ceremony", async () => {
  const { factory, director, runId } = await startRun();
  await restoreAt(director, { chapter: 0, regionId: canopy.id, active: ["prologue"], completed: ["prologue"] }, checkpoint => {
    checkpoint.progress.session.resume.requiredBeatQueue = [];
    checkpoint.progress.session.resume.dialogue = null;
    checkpoint.progress.session.resume.completedBeatIds = ["prologue-opening", "prologue-vision", "greenwake-cleanse"];
  });
  const entered = await director.processEvent({ type: "chapter-transition", eventId: "to-1", idempotencyKey: "story:to-1", fromChapter: 0, toChapter: 1, triggerId: "test" });
  const beat = entered.session.resume.requiredBeatQueue[0]!;
  assert.equal(beat, "fallen-scout-open", "the committed quest activation entitles its authored opening beat");
  const lines = STORY_DIALOGUE[beat]!.lines.length;
  assert.ok(lines >= 2, "fixture beat has several lines");
  assert.equal(entered.session.resume.dialogue, null);
  await assert.rejects(director.advanceStory({ beatId: "orchard-open", lineIndex: 0, skip: false }), /not the required beat/);
  await assert.rejects(director.advanceStory({ beatId: beat, lineIndex: 1, skip: false }), /in order/);
  const first = await director.advanceStory({ beatId: beat, lineIndex: 0, skip: false });
  assert.deepEqual(first.session.resume.dialogue, { beatId: beat, lineIndex: 1 });
  assert.deepEqual((await director.advanceStory({ beatId: beat, lineIndex: 0, skip: false })).session.resume.dialogue, { beatId: beat, lineIndex: 1 }, "a stale acknowledgement is a no-op");
  // Reload mid-beat resumes at the saved line.
  const reopened = new CampaignDirector({ saves: new SaveRepository(factory.asFactory(), { chapters: DEFINITIONS }) });
  assert.deepEqual((await reopened.load(autosaveSlotId(runId))).session.resume.dialogue, { beatId: beat, lineIndex: 1 });
  let state = first;
  for (let line = 1; line < lines; line += 1) state = await director.advanceStory({ beatId: beat, lineIndex: line, skip: false });
  assert.equal(state.session.resume.dialogue, null);
  assert.deepEqual(state.session.resume.requiredBeatQueue.includes(beat), false);
  assert.ok(state.session.resume.completedBeatIds.includes(beat));
  const reloaded = await new CampaignDirector({ saves: new SaveRepository(factory.asFactory(), { chapters: DEFINITIONS }) }).load(autosaveSlotId(runId));
  assert.ok(reloaded.session.resume.completedBeatIds.includes(beat), "a completed beat does not replay after reload");
  assert.equal((await director.advanceStory({ beatId: beat, lineIndex: 0, skip: false })).revision, state.revision);
});

test("dialogue skip acknowledges the beat but can never skip a required ceremony choice", async () => {
  const { director } = await startRun();
  await atCanopy(director);
  const entered = await director.processEvent(cleanseKoro);
  assert.equal(entered.session.resume.pendingChoiceId, "koro-pact");
  const queued = entered.session.resume.requiredBeatQueue[0];
  if (queued) {
    const skipped = await director.advanceStory({ beatId: queued, lineIndex: 0, skip: true });
    assert.ok(skipped.session.resume.completedBeatIds.includes(queued));
  }
  assert.equal(director.snapshot().session.resume.pendingChoiceId, "koro-pact");
  assert.equal(director.snapshot().choices["koro-pact"], undefined, "skip never defaults the pact");
});

test("durable companion replacement persists and rolls back atomically on a failed write", async () => {
  const { factory, director, runId } = await startRun();
  await atCanopy(director);
  await director.processEvent({ type: "rescue", eventId: "v", idempotencyKey: "story:v", targetId: "vara", locationId: "canopy-waterfall", safe: true });
  await director.processEvent(cleanseKoro);
  await director.processEvent(cleanseAsha);
  const assigned = await director.selectParty("asha");
  assert.deepEqual(assigned.party, { companionId: "asha" });
  const before = director.snapshot();
  const faulted = factory.transactionCount + 1;
  factory.fault = (context) => (context.transactionIndex === faulted && context.operation === "commit" ? "abort" : undefined);
  await assert.rejects(director.selectParty("koro"), code("transaction"));
  factory.fault = null;
  assert.deepEqual(director.snapshot(), before, "a failed party write is rolled back and unpublished");
  const utility = await director.selectParty("koro");
  assert.deepEqual(utility.party, { companionId: "koro" });
  const reopened = await new CampaignDirector({ saves: new SaveRepository(factory.asFactory(), { chapters: DEFINITIONS }) }).load(autosaveSlotId(runId));
  assert.deepEqual(reopened.party, { companionId: "koro" });
  const replaced = await director.selectParty("vara");
  assert.deepEqual(replaced.party, { companionId: "vara" });
  assert.equal(replaced.lastSafeCheckpoint!.progress.party.companionId, "vara", "the recovery checkpoint carries the replacement");
});

test("Tali danger failure restores the safe checkpoint without a permanent death or a counterfeit rescue", async () => {
  const { factory, director, runId } = await startRun();
  await restoreAt(director, { chapter: 2, regionId: bamboo.id, nodeId: "bamboo-canopy-gateway", active: ["a-mothers-roar"], completed: ["prologue"] });
  const safe = director.snapshot();
  assert.equal(safe.worldFacts.taliSafe, false);
  const failed = await director.processEvent({ type: "rescue", eventId: "tali-fail", idempotencyKey: "story:tali-fail", targetId: "tali", locationId: "tali-shelter", safe: false });
  assert.equal(failed.recoveryRequest?.reason, "tali-safety");
  assert.equal(failed.worldFacts.taliSafe, false);
  assert.equal(failed.campaign.world.regionalObligations.bamboo_tali_safe, false);
  assert.equal(await director.restoreCheckpoint(failed.lastSafeCheckpoint), true);
  const restored = director.snapshot();
  assert.equal(restored.recoveryRequest, null);
  assert.equal(restored.worldFacts.taliSafe, false);
  assert.equal(restored.worldFacts["rescued:tali"], undefined);
  const reloaded = await new CampaignDirector({ saves: new SaveRepository(factory.asFactory(), { chapters: DEFINITIONS }) }).load(autosaveSlotId(runId));
  assert.equal(reloaded.worldFacts.taliSafe, false);
  // A later honest rescue still works.
  const saved = await director.processEvent({ type: "rescue", eventId: "tali-ok", idempotencyKey: "story:tali-ok", targetId: "tali", locationId: "tali-shelter", safe: true });
  assert.equal(saved.worldFacts.taliSafe, true);
});

test("a new run supersedes operations queued for the previous journey", async () => {
  const { director } = await startRun();
  await atCanopy(director);
  const pending = director.processEvent(cleanseKoro);
  director.startChapterRun({ runId: "second-run", heroId: "aren", saveScope: "production" });
  await assert.rejects(pending, /journey changed/);
  assert.equal(director.snapshot().runId, "second-run");
  assert.equal(director.snapshot().session.heroId, "aren");
  assert.equal(director.snapshot().companions.koro.recruited, false);
});
