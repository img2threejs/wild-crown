import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAPTER_RUNTIME,
  LAYOUT_MIGRATIONS,
  RELATIONSHIP_RULES,
  LATER_CHAPTER_RUNTIME,
} from "../../src/content/chapters.js";
import { resolveSafeNode } from "../../src/game/campaign/safeSpawn.js";
import { projectPartyIntoRegion } from "../../src/app/ChapterParty.js";
import { createNewRun, recruitCompanion } from "../../packages/campaign/src/index.js";
import { arenaFromRegion, isSupportedCapsulePose } from "../../src/game/combat/geometry.js";
import { actorCollisionBody } from "../../src/game/combat/ActorBody.js";
import { ACTORS, INTERACTIONS, REGIONS as regionsList } from "../../src/content/world.js";
import { QUESTS } from "../../src/content/quests.js";
import { autosaveSlotId } from "../../src/game/campaign/session.js";
import { CampaignDirector, CampaignChoiceRejectedError } from "../../src/game/campaign/CampaignDirector.js";
import { SaveRepository } from "../../src/game/storage/SaveRepository.js";
import { FakeIDBFactory } from "../storage/fakeIndexedDB.js";
import type {
  RegionDefinition,
  WorldEvent,
} from "../../src/game/contracts.js";

const region = (id: string): RegionDefinition => regionsList.find((candidate) => candidate.id === id)!;

interface Harness { factory: FakeIDBFactory; saves: SaveRepository; director: CampaignDirector; runId: string }

async function startRun(options: { scope?: "production" | "candidate-chapters"; runId?: string; factory?: FakeIDBFactory } = {}): Promise<Harness> {
  const factory = options.factory ?? new FakeIDBFactory();
  const scope = options.scope ?? "candidate-chapters";
  const runId = options.runId ?? "later-chapter-run";
  const saves = new SaveRepository(factory.asFactory(), {
    scope,
    chapters: CHAPTER_RUNTIME,
    layoutMigrations: LAYOUT_MIGRATIONS,
  });
  const director = new CampaignDirector({
    saves,
    chapters: CHAPTER_RUNTIME,
    layoutMigrations: LAYOUT_MIGRATIONS,
    relationshipRules: RELATIONSHIP_RULES,
  });
  director.startChapterRun({ runId, heroId: "aren", saveScope: scope });
  return { factory, saves, director, runId };
}

/**
 * Map a chapter+region to the actually authored runtime segment that owns that region. Returns null when the region has
 * no authored segment (later-act regions without a chapter runtime definition). The test harness uses this to derive a
 * valid `segmentId`+`checkpointId` pair for `restoreCheckpoint`, never guessing.
 */
function authoredSegmentFor(chapter: number, regionId: string): { segmentId: string; checkpointId: string; cameraAnchorId: string; nodeId: string } | null {
  const definition = CHAPTER_RUNTIME.find((segment) => segment.regionId === regionId && segment.chapter === chapter);
  if (!definition) return null;
  const arrival = definition.checkpoints[0]!;
  return { segmentId: definition.segmentId, checkpointId: arrival.id, cameraAnchorId: arrival.cameraAnchorId, nodeId: arrival.nodeId };
}

/** Place the Director at a fresh authored location via the durable restore path (same harness the chapter-authority test uses). */
async function restoreDirectorAt(
  director: CampaignDirector,
  where: { chapter: number; regionId: string; active: string[]; completed: string[]; facts?: Record<string, boolean | number | string>; choices?: Record<string, string> },
): Promise<void> {
  const checkpoint = await director.captureCheckpoint();
  const target = region(where.regionId);
  const segment = authoredSegmentFor(where.chapter, where.regionId);
  const node = segment
    ? target.navigation.nodes.find((entry) => entry.id === segment.nodeId) ?? target.navigation.nodes[0]!
    : target.navigation.nodes[0]!;
  const checkpointId = segment ? segment.checkpointId : null;
  const cameraAnchorId = segment ? segment.cameraAnchorId : (target.cameraAnchors[0]?.id ?? "");
  const facts = { ...(where.facts ?? {}) };
  const choices: Record<string, string> = { ...checkpoint.progress.choices, ...where.choices };
  // The post-Fall state carries `refugeOpen=true, wardenCall=false` together with the earned downstream facts the
  // Director reads on the Refuge segment's exit requirements (interaction:refuge-services, choice:chapter-six-response).
  // Tests that restore into the post-Fall state use these placeholders; the explicit `facts` map can still override.
  if (where.chapter >= 7 && facts.refugeOpen === true && facts.wardenCall === false) {
    if (facts["interaction:refuge-services"] === undefined) facts["interaction:refuge-services"] = true;
    if (choices["chapter-six-response"] === undefined) choices["chapter-six-response"] = "ask";
  }
  checkpoint.progress.chapter = where.chapter;
  checkpoint.progress.regionId = target.id;
  checkpoint.progress.activeQuestIds = where.active as never;
  checkpoint.progress.completedQuestIds = where.completed as never;
  checkpoint.progress.worldFacts = { ...checkpoint.progress.worldFacts, chapter: where.chapter, ...facts };
  checkpoint.progress.choices = choices;
  checkpoint.safeSpawn = { regionId: target.id, position: { ...node.position }, routeId: node.id, cameraAnchorId };
  checkpoint.progress.session = {
    ...checkpoint.progress.session,
    resume: {
      ...checkpoint.progress.session.resume,
      segmentId: (segment?.segmentId ?? null) as never,
      layoutRevision: 1,
      checkpointId: checkpointId as never,
      activeEncounterId: null,
    },
  };
  assert.equal(await director.restoreCheckpoint(checkpoint), true);
}


test("later-act encounter entries match canonical placed actor positions and pair with a real pre-fight checkpoint", () => {
  for (const segment of LATER_CHAPTER_RUNTIME) {
    if (segment.encounterEntries.length === 0) continue;
    const layout = region(segment.regionId);
    for (const entry of segment.encounterEntries) {
      assert.ok(layout.encounterIds.includes(entry.encounterId), `${entry.id} encounter ${entry.encounterId} is registered in ${segment.regionId}`);
      assert.equal(entry.regionId, segment.regionId);
      const checkpoint = segment.checkpoints.find((point) => point.id === entry.checkpointId);
      assert.ok(checkpoint, `${entry.id} pre-fight checkpoint ${entry.checkpointId} is in the segment`);
      assert.equal(checkpoint!.encounterId, entry.encounterId);
      // Encounter trigger sits near the encounter participant entity.
      const participants = layout.encounterParticipants[entry.encounterId] ?? [];
      assert.ok(participants.length > 0, `${entry.id} has at least one participant`);
      const encounterEntity = layout.entities.find((entity) => participants.includes(entity.id));
      assert.ok(encounterEntity, `${entry.id} participant entity is placed in ${segment.regionId}`);
      assert.ok(
        Math.hypot(encounterEntity!.position.x - entry.center.x, encounterEntity!.position.z - entry.center.z) <= entry.radius + 6,
        `${entry.id} trigger radius covers the encounter participant`,
      );
    }
  }
});

test("every checkpoint names a safe authored nav node, real camera anchor and consistent encounterId", () => {
  for (const segment of CHAPTER_RUNTIME) {
    const layout = region(segment.regionId);
    for (const point of segment.checkpoints) {
      assert.equal(point.regionId, segment.regionId);
      assert.ok(layout.cameraAnchors.some((anchor) => anchor.id === point.cameraAnchorId), `${point.id} camera ${point.cameraAnchorId}`);
      const facts: Record<string, boolean | number | string> = {};
      for (const fact of point.requiresFacts) facts[fact] = true;
      for (const node of layout.navigation.nodes) if (node.requirement) facts[node.requirement] = true;
      assert.equal(resolveSafeNode(layout, point.nodeId, facts, point.cameraAnchorId)?.routeId, point.nodeId, `${point.id} must not silently fall back to another spawn`);
    }
  }
});


function recruitedCompanions() {
  let campaign = createNewRun("party-placement");
  for (const id of ["vara", "koro", "asha", "sable", "nyra", "solkar"] as const) campaign = recruitCompanion(campaign, id);
  return campaign.world.companions;
}

test("the traveling party arrives supported, separated and within sight of the player", () => {
  const moonpine = region("moonpine-ridge");
  const spawnPosition = moonpine.entrances[0]!.from;
  const projection = projectPartyIntoRegion({
    region: moonpine, party: { companionId: "asha" },
    companions: recruitedCompanions(), worldFacts: {}, spawnPosition,
  });
  assert.deepEqual(projection.entities.map(entity => entity.actorId), ["asha"]);
  const arena = arenaFromRegion(moonpine);
  for (const entity of projection.entities) {
    const { radius, height } = actorCollisionBody(ACTORS[entity.actorId!]!.species);
    const distance = Math.hypot(entity.position.x - spawnPosition.x, entity.position.z - spawnPosition.z);
    assert.ok(distance > radius + .5 && distance <= 6.01, `${entity.actorId} arrives beside, not on or far from, the player`);
    assert.ok(isSupportedCapsulePose(arena, entity.position, radius, height), `${entity.actorId} has real grounded clearance`);
  }
});

test("traveling instances never replace the authored story counterparts", () => {
  const moonpine = region("moonpine-ridge");
  const projection = projectPartyIntoRegion({
    region: moonpine, party: { companionId: "sable" },
    companions: recruitedCompanions(), worldFacts: {}, spawnPosition: null,
  });
  assert.equal(projection.entities.filter(entity => entity.actorId === "sable").length, 1);
  assert.ok(projection.entities.every(entity => moonpine.entities.every(authored => authored.id !== entity.id)));
});

test("an exiled Solkar is not resurrected even if an invalid party still selects him", () => {
  assert.throws(() => projectPartyIntoRegion({
    region: region("moonpine-ridge"), party: { companionId: "solkar" },
    companions: recruitedCompanions(), worldFacts: { "solkar-exiled": true }, spawnPosition: null,
  }));
});

test("missing safe formation space rejects the load rather than silently dropping a companion", () => {
  const moonpine = region("moonpine-ridge");
  assert.throws(() => projectPartyIntoRegion({
    region: { ...moonpine, ground: { ...moonpine.ground, surfaces: moonpine.ground.surfaces.map(surface => ({ ...surface, walkable: false })) } },
    party: { companionId: "asha" }, companions: recruitedCompanions(), worldFacts: {}, spawnPosition: null,
  }), /Cannot place selected companion asha safely/);
});

test("a large companion can stand beside a ledge-side player spawn without occupying it", () => {
  const hollow = region("heartroot-hollow");
  const spawnPosition = hollow.navigation.nodes.find(node => node.id === "hollow-mouth")!.position;
  const arena = arenaFromRegion(hollow);
  const body = actorCollisionBody(ACTORS.asha!.species);
  const projection = projectPartyIntoRegion({
    region: hollow, party: { companionId: "asha" }, companions: recruitedCompanions(), worldFacts: {}, spawnPosition,
  });
  const asha = projection.entities.find(entity => entity.actorId === "asha")!;
  assert.ok(isSupportedCapsulePose(arena, asha.position, body.radius, body.height));
  assert.ok(Math.hypot(asha.position.x - spawnPosition.x, asha.position.z - spawnPosition.z) <= 6.01);
});

test("authored local traversal markers advance objectives without changing region; unknown markers are rejected", async () => {
  const { director } = await startRun();
  await restoreDirectorAt(director, { chapter: 4, regionId: "mistveil-basin", active: ["the-mire-maw"], completed: ["prologue"] });
  const marker = INTERACTIONS.find(definition => definition.id === "polluted-source")!;
  await director.processEvent({ ...marker.success, eventId: "local-marker", idempotencyKey: "local-marker" } as never);
  const snapshot = director.snapshot();
  assert.equal(snapshot.regionId, "mistveil-basin");
  assert.equal(snapshot.chapter, 4);
  assert.equal(snapshot.worldFacts["traversed:polluted-source"], true);
  assert.ok(snapshot.completedObjectiveIds.includes("the-mire-maw:polluted-source" as never));
  await assert.rejects(director.processEvent({
    ...marker.success, routeId: "unregistered-shortcut", eventId: "unknown-marker", idempotencyKey: "unknown-marker",
  } as never), /does not match an authored region route/);
  assert.equal(director.snapshot().worldFacts["traversed:unregistered-shortcut"], undefined);
});

test("regional leadership cannot be chosen before the guardian is cleansed", async () => {
  for (const [chapter, regionId, choice, option] of [
    [3, "moonpine-ridge", "pack-leadership", "luma"],
    [5, "sunmane-expanse", "sunmane-resolution", "bond"],
  ] as const) {
    const { director } = await startRun({ runId: `leadership-before-${chapter}` });
    await restoreDirectorAt(director, { chapter, regionId, active: [], completed: ["prologue"] });
    await assert.rejects(director.choose(choice, option), error =>
      error instanceof CampaignChoiceRejectedError && error.choiceId === choice && error.optionId === option);
    assert.equal(director.snapshot().choices[choice], undefined);
  }
});

test("pack welfare opens the Ruun encounter before the guarded leadership decision", async () => {
  const { director } = await startRun({ runId: "moonpine-quest-order" });
  await restoreDirectorAt(director, {
    chapter: 3, regionId: "moonpine-ridge",
    active: ["two-packs"], completed: [...QUESTS.filter(quest => !quest.optional && quest.chapter < 3).map(quest => quest.id), "the-third-howl"],
  });
  const interact = async (id: string) => {
    const authored = INTERACTIONS.find(interaction => interaction.id === id)!;
    await director.processEvent({
      ...authored.success, eventId: id, idempotencyKey: id,
      actorId: "aren", interactionId: id, safe: true,
    } as WorldEvent);
  };
  for (const id of ["pack-pups", "winter-stores", "pack-scouts"]) await interact(id);
  assert.ok(director.snapshot().completedQuestIds.includes("two-packs"));
  assert.ok(director.isObjectiveActive("the-alpha-below:counter-howl"));
  await assert.rejects(director.choose("pack-leadership", "luma"), error =>
    error instanceof CampaignChoiceRejectedError && error.choiceId === "pack-leadership");
  await interact("temple-route");
  await interact("temple-restraints");
  await director.processEvent({
    type: "encounter-resolved", eventId: "ruun-cleansed", idempotencyKey: "ruun-cleansed",
    encounterId: "encounter-ruun", actorIds: ["ruun"], resolution: "cleansed",
  });
  await director.choose("pack-leadership", "luma");
  await director.processEvent({
    type: "fragment", eventId: "pack-fragment", idempotencyKey: "pack-fragment",
    fragmentId: "heartroot-pack", sourceId: "ruun",
  });
  assert.ok(director.snapshot().completedQuestIds.includes("the-alpha-below"));
  await director.advanceChapter({ exitId: "ridge-mist-out", requestId: "moonpine-complete" });
  assert.equal(director.snapshot().regionId, "mistveil-basin");
  assert.equal(director.snapshot().chapter, 4);
});

test("return journeys can cross unfinished regions to reach the first quest without unlocking the Hollow", async () => {
  const { director } = await startRun({ runId: "return-transit" });
  await restoreDirectorAt(director, {
    chapter: 7, regionId: "refuge", active: ["seeds-on-the-wind"], completed: ["prologue"],
    facts: { refugeOpen: true, wardenCall: false },
  });
  for (const exitId of ["refuge-sunmane-out", "sunmane-mist-out", "mist-ridge-out", "ridge-bamboo-out", "bamboo-canopy-out"]) {
    await director.advanceChapter({ exitId, requestId: "return-transit:" + exitId });
    assert.equal(director.snapshot().chapter, 7);
  }
  const snapshot = director.snapshot();
  assert.equal(snapshot.regionId, "whispering-canopy");
  assert.ok(snapshot.activeQuestIds.includes("seeds-on-the-wind"));
  assert.notEqual(snapshot.worldFacts["hollow-opening"], true);
  await assert.rejects(director.choose("wild-march-formation", "form"), error =>
    error instanceof CampaignChoiceRejectedError && error.choiceId === "wild-march-formation");
});

test("forming the march enters the Hollow through one atomic chapter-and-route transition", async () => {
  const { director, saves, runId } = await startRun({ runId: "formed-hollow-entry" });
  await restoreDirectorAt(director, {
    chapter: 7, regionId: "refuge", active: ["wild-march"],
    completed: QUESTS.filter(quest => !quest.optional && quest.chapter < 8 && quest.id !== "wild-march").map(quest => quest.id),
    facts: { refugeOpen: true, wardenCall: false },
  });
  for (const faction of ["sky", "canopy", "fang", "pack", "shadow", "crown"]) {
    await director.choose("chapter-seven-commitment", "decline-" + faction);
  }
  await director.choose("wild-march-formation", "form");
  const arrived = await director.advanceChapter({ exitId: "refuge-hollow-out", requestId: "formed-hollow-entry" });
  assert.equal(arrived.chapter, 8);
  assert.equal(arrived.regionId, "heartroot-hollow");
  assert.equal(arrived.segmentId, "hollow");
  assert.equal(arrived.lastSafeCheckpoint?.safeSpawn?.regionId, "heartroot-hollow");
  const saved = await saves.loadCampaign(autosaveSlotId(runId), arrived.campaign);
  assert.equal(saved?.chapter, 8);
  assert.equal(saved?.regionId, "heartroot-hollow");
  assert.deepEqual(await director.advanceChapter({ exitId: "refuge-hollow-out", requestId: "formed-hollow-entry" }), arrived);
});


test("entering chapter 6 (grove-fall) does NOT auto-open the Refuge nor sever the Warden Call", async () => {
  // Real Director transition: enter chapter 6 via chapter-transition (advanceChapter). The post-transition snapshot
  // has chapter===6 and the world bits are unchanged. This is the durability check the seam requires.
  const { factory, director } = await startRun({ scope: "candidate-chapters", runId: "grove-fall-entry", factory: new FakeIDBFactory() });
  // Skip Prologue and Acts I — use captureCheckpoint + restoreCheckpoint to fast-forward to a chapter-6 arrival.
  // The minimal path: chapter-transition to chapter 6 with all required quest facts already committed by gameplay
  // and the grove chapter entry. We must NOT set refugeOpen or wardenCall from chapter entry alone.
  // Use the same restore-at approach chapter-authority.test.ts uses to insert a fresh chapter-6 state.
  await restoreDirectorAt(director, { chapter: 6, regionId: "the-grove", active: ["fall-of-the-grove"], completed: ["prologue"] });
  const snap = director.snapshot();
  assert.equal(snap.chapter, 6, "Director is at chapter 6 after the restore");
  assert.equal(snap.worldFacts.wardenCall, false, "Warden Call is not severed on chapter 6 entry");
  assert.equal(snap.worldFacts.refugeOpen, false, "Refuge is not opened on chapter 6 entry");
  assert.equal(snap.worldFacts.askSignal, false, "Ask/Signal is not unlocked on chapter 6 entry");
  factory.transactionCount >= 1;
});

test("ask/signal (chapter-six-response) refuses a pre-Fall response: required Fall completion, not just `wardenCall===true`", async () => {
  const { director } = await startRun({ scope: "candidate-chapters", runId: "ask-signal-pre-fall", factory: new FakeIDBFactory() });
  await restoreDirectorAt(director, {
    chapter: 6,
    regionId: "the-grove",
    active: ["fall-of-the-grove"],
    completed: ["prologue"],
    facts: { wardenCall: true },
  });
  await assert.rejects(
    director.choose("chapter-six-response", "ask"),
    /Warden Call must be severed|Chapter 6/,
    "Pre-Fall Ask/Signal is rejected — Call is still on, Refuge not open, no completion event",
  );
  const snap = director.snapshot();
  assert.equal(snap.choices["chapter-six-response"], undefined, "Pre-Fall Ask/Signal was not recorded");
});

test("ask/signal (chapter-six-response) accepts only the post-Fall state (refugeOpen=true, wardenCall=false)", async () => {
  const { director } = await startRun({ scope: "candidate-chapters", runId: "ask-signal-post-fall", factory: new FakeIDBFactory() });
  await restoreDirectorAt(director, {
    chapter: 6,
    regionId: "the-grove",
    active: ["fall-of-the-grove"],
    completed: ["prologue"],
    facts: { refugeOpen: true, wardenCall: false },
  });
  const snap = await director.choose("chapter-six-response", "ask");
  assert.equal(snap.choices["chapter-six-response"], "ask", "Post-Fall Ask is recorded");
});

test("successful grove-collapse-escape is the only thing that flips wardenCall=false and refugeOpen=true", async () => {
  const { director } = await startRun({ scope: "candidate-chapters", runId: "grove-collapse-escape-success", factory: new FakeIDBFactory() });
  await restoreDirectorAt(director, {
    chapter: 6,
    regionId: "the-grove",
    active: ["fall-of-the-grove"],
    completed: ["prologue"],
    facts: { "interaction:grove-pillar": true },
  });
  // Per FallRuntimeRepair's event contract: the protection branch completion is signalled by an encounter-phase
  // event with phaseId="possession-pulse" and state="cleared". The existing encounter-phase reducer writes the
  // canonical `encounterPhase:encounter-fall:0:cleared` fact, which the grove-collapse-escape guard consumes.
  const runId = "grove-collapse-escape-success";
  await director.processEvent({
    type: "rescue",
    eventId: `${runId}:interaction:grove-tali-rescue`,
    idempotencyKey: `${runId}:interaction:grove-tali-rescue`,
    targetId: "tali",
    locationId: "grove-tali-shelter",
    safe: true,
  });
  await director.processEvent({
    type: "encounter-phase",
    eventId: `${runId}:encounter-fall:phase:0:cleared`,
    idempotencyKey: `${runId}:encounter-fall:phase:0:cleared`,
    encounterId: "encounter-fall",
    actorId: "orun",
    phaseId: "possession-pulse",
    phaseIndex: 0,
    state: "cleared",
    simulationTick: 1,
  });
  await director.processEvent({
    type: "semantic-interaction",
    eventId: `${runId}:encounter-fall:collapse-escape`,
    idempotencyKey: `${runId}:encounter-fall:collapse-escape`,
    actorId: "aren" as never,
    interactionId: "grove-collapse-escape",
    kind: "coordinate",
    targetId: "grove-collapse-escape",
    position: { x: 17, y: 0, z: 0 },
  });
  const snap = director.snapshot();
  assert.equal(snap.worldFacts.refugeOpen, true, "Earned escape opens the Refuge");
  assert.equal(snap.worldFacts.wardenCall, false, "Earned escape severs the Warden Call");
});

test("grove-collapse-escape refuses when prerequisite facts are absent (no full Tali safety, no pillar, no protection-phase)", async () => {
  const { director } = await startRun({ scope: "candidate-chapters", runId: "grove-collapse-escape-missing", factory: new FakeIDBFactory() });
  await restoreDirectorAt(director, {
    chapter: 6,
    regionId: "the-grove",
    active: ["fall-of-the-grove"],
    completed: ["prologue"],
  });
  await assert.rejects(
    director.processEvent({
      type: "semantic-interaction",
      eventId: "grove-collapse-escape-bad",
      idempotencyKey: "grove-collapse-escape-bad",
      actorId: "aren" as never,
      interactionId: "grove-collapse-escape",
      kind: "coordinate",
      targetId: "grove-collapse-escape",
      position: { x: 17, y: 0, z: 0 },
    }),
    /requires current-Fall Tali safe at grove-tali-shelter|pillar bracing|encounterPhase:encounter-fall:0:cleared/,
    "Empty Fall cannot complete the escape",
  );
});

test("reload preserves refugeOpen from the checkpoint, never reopens based on chapter number", async () => {
  const factory = new FakeIDBFactory();
  const saves = new SaveRepository(factory.asFactory(), {
    scope: "candidate-chapters",
    chapters: CHAPTER_RUNTIME,
    layoutMigrations: LAYOUT_MIGRATIONS,
    relationshipRules: RELATIONSHIP_RULES,
  });
  const director = new CampaignDirector({ saves, chapters: CHAPTER_RUNTIME, layoutMigrations: LAYOUT_MIGRATIONS, relationshipRules: RELATIONSHIP_RULES });
  director.startChapterRun({ runId: "reload-refuge", heroId: "aren", saveScope: "candidate-chapters" });
  await restoreDirectorAt(director, {
    chapter: 6,
    regionId: "the-grove",
    active: ["fall-of-the-grove"],
    completed: ["prologue"],
    facts: { "interaction:grove-pillar": true, bamboo_tali_safe: true, refugeeOpen: false },
  });
  // The loaded snapshot retains the earned false refugeOpen (no overwrite from chapter >= 6).
  await director.autosave();
  const reloaded = new CampaignDirector({
    saves: new SaveRepository(factory.asFactory(), {
      scope: "candidate-chapters",
      chapters: CHAPTER_RUNTIME,
      layoutMigrations: LAYOUT_MIGRATIONS,
      relationshipRules: RELATIONSHIP_RULES,
    }),
    chapters: CHAPTER_RUNTIME,
    layoutMigrations: LAYOUT_MIGRATIONS,
    relationshipRules: RELATIONSHIP_RULES,
  });
  const loaded = await reloaded.load(autosaveSlotId("reload-refuge"));
  assert.equal(loaded.worldFacts.refugeOpen, false, "Refuge stays closed across reload even at chapter 6");
  assert.equal(loaded.chapter, 6, "Chapter 6 is preserved");
});

test("player denies Hollow BEFORE the formation choice (hollow-opening is not earned from chapter entry)", async () => {
  const { director } = await startRun({ scope: "candidate-chapters", runId: "deny-hollow-pre-formation", factory: new FakeIDBFactory() });
  // Player is at the Refuge post-Fall but has NOT yet chosen formation. Hollow exit gate (`hollow-opening`) is still
  // false, so the player cannot enter the Hollow.
  await restoreDirectorAt(director, {
    chapter: 7,
    regionId: "refuge",
    active: ["wild-march"],
    completed: ["prologue"],
    facts: { refugeOpen: true, wardenCall: false, "hollow-opening": false },
  });
  const hollowExit = region("refuge").exits.find((route) => route.destinationRegionId === "heartroot-hollow");
  assert.ok(hollowExit, "Authored Refuge → Hollow exit exists");
  await assert.rejects(
    director.advanceChapter({ exitId: hollowExit.id, requestId: "deny-hollow-pre-formation:1" }),
    /discovered|unlock/,
    "Hollow stays locked until formation flips hollow-opening",
  );
  const snap = director.snapshot();
  assert.equal(snap.regionId, "refuge", "Player is still in the Refuge");
  assert.equal(snap.worldFacts["hollow-opening"], false, "Hollow remains locked");
});

test("optional acceptance is durable, idempotent and rolls back its discovery cue on failed commit", async () => {
  const { director, factory, runId } = await startRun({ runId: "optional-acceptance" });
  await restoreDirectorAt(director, {
    chapter: 7, regionId: "refuge", active: ["wild-march"], completed: ["prologue"],
    facts: { refugeOpen: true, wardenCall: false, "visited:whispering-canopy": true },
  });
  await assert.rejects(director.acceptQuest("a-mothers-roar"), /optional/);
  await assert.rejects(director.acceptQuest("winter-stores"), /Travel/);
  const before = director.snapshot();
  factory.fault = context => context.operation === "commit" ? "abort" : undefined;
  await assert.rejects(director.acceptQuest("the-empty-nest"));
  factory.fault = null;
  assert.deepEqual(director.snapshot().activeQuestIds, before.activeQuestIds);
  assert.deepEqual(director.snapshot().session.resume, before.session.resume);
  assert.equal(director.snapshot().worldFacts["quest:the-empty-nest:accepted"], undefined);
  const accepted = await director.acceptQuest("the-empty-nest");
  assert.equal(accepted.worldFacts["quest:the-empty-nest:accepted"], true);
  assert.ok(accepted.activeQuestIds.includes("the-empty-nest"));
  assert.deepEqual(await director.acceptQuest("the-empty-nest"), accepted);
  const reloaded = await startRun({ factory, runId });
  const restored = await reloaded.director.load(autosaveSlotId(runId));
  assert.ok(restored.activeQuestIds.includes("the-empty-nest"));
  assert.equal(restored.worldFacts["quest:the-empty-nest:accepted"], true);
});

test("hub upgrades require earned milestones and survive reload without duplicate grants", async () => {
  const { director, factory, runId } = await startRun({ runId: "earned-hub-upgrade" });
  await restoreDirectorAt(director, {
    chapter: 7, regionId: "refuge", active: ["wild-march"],
    completed: ["prologue", "a-mothers-roar", "winter-stores"],
    facts: { refugeOpen: true, wardenCall: false },
  });
  await assert.rejects(director.learnUpgrade("trail-reserves"), /winter|cache/i);
  factory.fault = context => context.operation === "commit" ? "abort" : undefined;
  await assert.rejects(director.learnUpgrade("root-resilience"));
  factory.fault = null;
  assert.equal(director.snapshot().worldFacts["upgrade:root-resilience"], undefined);
  const learned = await director.learnUpgrade("root-resilience");
  assert.equal(learned.worldFacts["upgrade:root-resilience"], true);
  assert.deepEqual(await director.learnUpgrade("root-resilience"), learned);
  const reloaded = await startRun({ factory, runId });
  assert.equal((await reloaded.director.load(autosaveSlotId(runId))).worldFacts["upgrade:root-resilience"], true);
});

test("Refuge rebuilding is accepted and completed after the Grove is no longer reachable", async () => {
  const { director } = await startRun({ runId: "refuge-side-garden" });
  await restoreDirectorAt(director, {
    chapter: 7, regionId: "refuge", active: ["wild-march"], completed: ["prologue"],
    facts: { refugeOpen: true, wardenCall: false },
  });
  await director.acceptQuest("roots-we-share");
  for (const id of ["roots-we-share-evidence", "roots-we-share-action"]) {
    const authored = INTERACTIONS.find(interaction => interaction.id === id)!;
    await director.processEvent({ ...authored.success, actorId: "aren", interactionId: id, eventId: id, idempotencyKey: id } as WorldEvent);
  }
  assert.ok(director.snapshot().completedQuestIds.includes("roots-we-share"));
  assert.equal(director.snapshot().worldFacts["hub:refuge-garden"], true);
  assert.equal(director.snapshot().regionId, "refuge");
});

test("the protected corridor unlocks the existing hidden rootway without requiring Nyra's presence", async () => {
  const { director } = await startRun({ runId: "optional-hidden-rootway" });
  await restoreDirectorAt(director, { chapter: 4, regionId: "mistveil-basin", active: [], completed: ["prologue"] });
  await director.acceptQuest("the-silent-hunter");
  for (const id of ["the-silent-hunter-evidence", "the-silent-hunter-action"]) {
    const authored = INTERACTIONS.find(interaction => interaction.id === id)!;
    await director.processEvent({ ...authored.success, actorId: "aren", interactionId: id, eventId: id, idempotencyKey: id } as WorldEvent);
  }
  const snapshot = director.snapshot();
  assert.ok(snapshot.completedQuestIds.includes("the-silent-hunter"));
  const route = region("mistveil-basin").traversalArcs.find(item => item.id === "mistveil-hidden-rootway")!;
  assert.equal(snapshot.worldFacts[route.unlockFact!], true);
  assert.equal(snapshot.worldFacts["side:protected-corridor"], true);
});

test("tributary repair honors both irreversible river branches and never downgrades restoration", async () => {
  for (const choice of ["repair", "break-dam"]) {
    const { director, runId } = await startRun({ runId: "tributary-" + choice });
    await restoreDirectorAt(director, {
      chapter: 4, regionId: "mistveil-basin", active: [], completed: ["prologue"],
      choices: { "river-route": choice }, facts: { "choice:river-route": true },
    });
    const checkpoint = await director.captureCheckpoint();
    checkpoint.worldCheckpoint.world.regions["mistveil-basin"] = "restored";
    checkpoint.progress.eventLog.push({ type: "choice", choiceId: "river-route", optionId: choice, eventId: "settled-river-choice", idempotencyKey: "settled-river-choice" });
    checkpoint.progress.eventKeys.push("settled-river-choice");
    await director.restoreCheckpoint(checkpoint);
    await director.acceptQuest("river-of-black-sap");
    for (const id of ["river-of-black-sap-evidence", "river-of-black-sap-action"]) {
      const authored = INTERACTIONS.find(interaction => interaction.id === id)!;
      await director.processEvent({ ...authored.success, actorId: "aren", interactionId: id, eventId: id, idempotencyKey: id } as WorldEvent);
    }
    const snapshot = director.snapshot();
    assert.ok(snapshot.completedQuestIds.includes("river-of-black-sap"));
    assert.equal(snapshot.choices["river-route"], choice);
    assert.equal(snapshot.worldFacts["side:river-cleared"], true);
    assert.equal(snapshot.worldFacts["side:river-flood-detour"], choice === "break-dam");
    assert.equal(snapshot.worldFacts["side:river-bank-open"], choice === "repair");
    assert.equal(snapshot.campaign.world.regions["mistveil-basin"], "restored");
    const loaded = await director.load(autosaveSlotId(runId));
    assert.equal(loaded.choices["river-route"], choice);
    assert.equal(loaded.campaign.world.regions["mistveil-basin"], "restored");
  }
});

test("absent and exiled Solkar cannot listen; council mediation never restores his presence", async () => {
  for (const status of ["absent", "exiled"] as const) {
    const { director } = await startRun({ runId: "refusal-" + status });
    await restoreDirectorAt(director, {
      chapter: 5, regionId: "sunmane-expanse", active: [], completed: ["prologue"],
      choices: { "sunmane-resolution": status === "exiled" ? "exile" : "council" },
      facts: { solkarPresent: false, "choice:sunmane-resolution": true },
    });
    const checkpoint = await director.captureCheckpoint();
    checkpoint.worldCheckpoint.world.factions.crown.leaderStatus = status;
    checkpoint.worldCheckpoint.world.factions.crown.representative.present = false;
    await director.restoreCheckpoint(checkpoint);
    await director.acceptQuest("a-king-without-subjects");
    const evidence = INTERACTIONS.find(interaction => interaction.id === "a-king-without-subjects-evidence")!;
    await director.processEvent({ ...evidence.success, actorId: "aren", interactionId: evidence.id, eventId: "refusal-evidence", idempotencyKey: "refusal-evidence" } as WorldEvent);
    await assert.rejects(director.choose("solkar-listens", "listen"), /absent|exiled/i);
    await director.choose("solkar-listens", "council-mediation");
    const snapshot = director.snapshot();
    assert.ok(snapshot.completedQuestIds.includes("a-king-without-subjects"));
    assert.equal(snapshot.campaign.world.factions.crown.leaderStatus, status);
    assert.equal(snapshot.worldFacts.solkarPresent, false);
  }
});
