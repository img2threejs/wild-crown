import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTORS,
  ALL_QUESTS,
  BRANCH_HISTORIES,
  CHAPTERS,
  ENVIRONMENT_RECIPES,
  REGIONS,
  CAMPAIGN_CHOICES,
  INTERACTIONS,
  STORY_DIALOGUE,
} from "../../src/game/campaign/index.js";
import { ACT_I_REGION_AUTHORING_STATUS, ACT_I_REGIONS } from "../../src/content/levels/act-i.js";
import { LATER_ACT_REGION_AUTHORING_STATUS, LATER_ACT_REGIONS } from "../../src/content/levels/later-acts.js";
import { CampaignDirector } from "../../src/game/campaign/CampaignDirector.js";
import { CombatEngine } from "../../src/game/combat/CombatEngine.js";
import {
  createCheckpoint,
  createNewRun,
  evaluateEnding,
  recordLeaderDominion,
  setPackLeader,
  FRAGMENT_IDS,
  FACTION_IDS,
  REGION_IDS,
  REGIONAL_OBLIGATION_IDS,
  setCrownCouncilRepresentation,
  type CampaignState,
} from "../../packages/campaign/src/index.js";

test("act modules expose full region records while the baseline stays unaccepted", () => {
  assert.equal(ACT_I_REGION_AUTHORING_STATUS, "unaccepted");
  assert.equal(LATER_ACT_REGION_AUTHORING_STATUS, "unaccepted");
  const regions = [...ACT_I_REGIONS, ...LATER_ACT_REGIONS];
  assert.deepEqual(
    regions.map((region) => region.id).sort(),
    [
      "blood-bamboo-valley",
      "greenwake",
      "heartroot-hollow",
      "mistveil-basin",
      "moonpine-ridge",
      "refuge",
      "sunmane-expanse",
      "the-grove",
      "whispering-canopy",
    ],
  );

  for (const region of regions) {
    assert.equal(region.authoringStatus, "unaccepted", region.id);
    assert.ok(region.ground.surfaces.length > 0, region.id + " has explicit surfaces");
    assert.ok(region.ground.colliders.length > 0, region.id + " has explicit colliders");
    assert.ok(region.navigation.nodes.length > 0, region.id + " has explicit nav nodes");
    assert.ok(region.navigation.ribbons.length > 0, region.id + " has explicit nav ribbons");
    assert.ok(region.cameraAnchors.length > 0, region.id + " has explicit camera anchors");
    assert.ok(region.entities.length > 0, region.id + " has explicit entities");
    assert.ok(region.props.length > 0, region.id + " has explicit props");
    assert.ok(region.restorationStates.includes("unvisited"), region.id + " has restoration states");
    const entityIds = region.entities.map((entity) => entity.id);
    assert.equal(new Set(entityIds).size, entityIds.length, region.id + " has unique entity instances");
  }
});
test("authored branch options map to executable Director choices", () => {
  for (const history of BRANCH_HISTORIES) {
    const packOption = history.pack === "dominion" ? "dominion-ruun" : history.pack;
    const marekOption = history.marek === "present" ? "cleanse" : "leave";
    assert.ok(CAMPAIGN_CHOICES["pack-leadership"].some((option) => option.id === packOption));
    assert.ok(CAMPAIGN_CHOICES["marek-fate"].some((option) => option.id === marekOption));
    assert.ok(CAMPAIGN_CHOICES["sunmane-resolution"].some((option) => option.id === history.crown));
  }
  assert.ok(CHAPTERS.every((chapter) => chapter.absenceVariants.length > 0));
  for (const quest of ALL_QUESTS) {
    for (const dialogueId of quest.dialogueIds) {
      assert.ok(STORY_DIALOGUE[dialogueId], "dialogue exists for " + quest.id + ": " + dialogueId);
    }
  }
});

async function setBranchChapter(director: CampaignDirector, chapter: number) {
  const checkpoint = await director.captureCheckpoint();
  assert.equal(
    await director.restoreCheckpoint({
      ...checkpoint,
      progress: {
        ...checkpoint.progress,
        chapter,
        worldFacts: { ...checkpoint.progress.worldFacts, chapter },
      },
    }),
    true,
  );
}

test("Director executes every leadership × Marek × Crown branch through an ending", async () => {
  for (const [index, history] of BRANCH_HISTORIES.entries()) {
    const director = new CampaignDirector({ runId: "branch-history-" + index });
    await setBranchChapter(director, 3);
    const packOption = history.pack === "dominion" ? "dominion-ruun" : history.pack;
    await director.choose("pack-leadership", packOption);
    assert.equal(director.snapshot().choices["pack-leadership"], packOption);

    await setBranchChapter(director, 4);
    const marekOption = history.marek === "present" ? "cleanse" : "leave";
    await director.choose("marek-fate", marekOption);
    assert.equal(director.snapshot().campaign.world.marekPresent, history.marek === "present");

    await setBranchChapter(director, 5);
    await director.choose("sunmane-resolution", history.crown);
    assert.equal(director.snapshot().choices["sunmane-resolution"], history.crown);
    if (history.crown === "exile") {
      assert.equal(director.snapshot().campaign.world.factions.crown.leaderStatus, "exiled");
      assert.throws(() => director.selectParty("combat", "solkar"));
      await director.choose("crown-council", "willing");
      assert.equal(director.snapshot().campaign.world.factions.crown.representative.present, true);
    }

    await setBranchChapter(director, 7);
    await director.choose("chapter-seven-commitment", "crown");
    assert.equal(director.snapshot().campaign.world.renewedCommitments.crown, true);
    for (const phaseIndex of [1, 2]) {
      await director.processEvent({
        type: "encounter-phase",
        eventId: `orun-phase-${phaseIndex}-${index}`,
        idempotencyKey: `orun-phase:${phaseIndex}:${index}`,
        encounterId: "encounter-orun",
        actorId: "orun",
        phaseId: `orun-phase-${phaseIndex}`,
        phaseIndex,
        state: "cleared",
        simulationTick: phaseIndex,
      });
    }
    await director.processEvent({
      type: "encounter-resolved",
      eventId: "orun-resolved-" + index,
      idempotencyKey: "orun-resolved:" + index,
      encounterId: "encounter-orun",
      resolution: "cleansed",
      actorIds: ["orun"],
    });
    await director.choose("final-ending", "severance");
    assert.equal(director.snapshot().ending, "severance");
    const eventKeys = director.snapshot().lastSafeCheckpoint?.progress.eventKeys ?? [];
    assert.ok(eventKeys.includes("orun-resolved:" + index));
    assert.ok(eventKeys.includes("choice:final-ending:severance"));
  }
});

test("Nyra reveals an optional Mistveil route without blocking the main route", async () => {
  const mistveil = REGIONS.find((region) => region.id === "mistveil-basin");
  const route = mistveil?.exits.find((exit) => exit.id === "mistveil-hidden-route-out");
  assert.equal(route?.unlockFact, "mistveil_nyra_hidden_route");
  const discovery = INTERACTIONS.find((item) => item.id === "nyra-reveal-hidden-route");
  assert.deepEqual(discovery?.requiresActors, ["nyra"]);
  assert.deepEqual(discovery?.success, {
    type: "semantic-interaction",
    kind: "signal",
    targetId: "mistveil-hidden-route",
  });

  const director = new CampaignDirector({ runId: "nyra-hidden-route" });
  const checkpoint = await director.captureCheckpoint();
  assert.equal(
    await director.restoreCheckpoint({
      ...checkpoint,
      progress: {
        ...checkpoint.progress,
        chapter: 4,
        regionId: "mistveil-basin",
        worldFacts: {
          ...checkpoint.progress.worldFacts,
          chapter: 4,
          mistveil_nyra_hidden_route: false,
        },
      },
    }),
    true,
  );
  await assert.rejects(
    director.travel("mistveil-basin", "mistveil-hidden-route-in"),
    /not been discovered/,
  );
  await director.processEvent({
    type: "semantic-interaction",
    eventId: "nyra-reveals-route",
    idempotencyKey: "nyra:reveals-hidden-route",
    actorId: "nyra",
    interactionId: "nyra-reveal-hidden-route",
    kind: "signal",
    targetId: "mistveil-hidden-route",
    position: { x: -42, y: 0, z: 32 },
  });
  assert.equal(director.snapshot().worldFacts.mistveil_nyra_hidden_route, true);
  await director.travel("mistveil-basin", "mistveil-hidden-route-in");
  assert.equal(
    director.snapshot().lastSafeCheckpoint?.safeSpawn.routeId,
    "mistveil-hidden-route-in",
  );
});

test("Chapter Six requires an authored Call before the Ask or Signal choice", async () => {
  for (const response of ["ask", "signal"] as const) {
    const director = new CampaignDirector({ runId: "chapter-six-" + response });
    await setBranchChapter(director, 6);
    const checkpoint = await director.captureCheckpoint();
    assert.equal(
      await director.restoreCheckpoint({
        ...checkpoint,
        progress: {
          ...checkpoint.progress,
          activeQuestIds: ["fall-of-the-grove"] as never,
        },
      }),
      true,
    );
    await assert.rejects(
      director.choose("chapter-six-response", response),
      /Warden Call must happen/,
    );
    await director.processEvent({
      type: "semantic-interaction",
      eventId: "warden-call-" + response,
      idempotencyKey: "warden-call:" + response,
      actorId: "aren",
      interactionId: "warden-call",
      kind: "signal",
      targetId: "warden-call",
      position: { x: 0, y: 0, z: 0 },
    });
    assert.equal(director.snapshot().worldFacts.wardenCall, true);
    await director.choose("chapter-six-response", response);
    assert.equal(director.snapshot().worldFacts.askSignal, true);
    assert.equal(director.snapshot().worldFacts.wardenResponse, response);
    assert.ok(
      director.snapshot().completedObjectiveIds.includes(
        "fall-of-the-grove:ask-signal" as never,
      ),
    );
  }
});

test("Blood Bamboo accepts its authored nonlethal Hunter Camp encounter event", async () => {
  const bamboo = REGIONS.find((region) => region.id === "blood-bamboo-valley");
  assert.ok(bamboo?.encounterIds.includes("camp-hunters"));
  assert.ok(bamboo);
  const participants = bamboo.encounterParticipants["camp-hunters"];
  assert.deepEqual(participants, ["hunter-melee-west", "hunter-melee-east", "hunter-ranged"]);
  const campActors = bamboo.entities.filter((entity) =>
    participants.includes(entity.id as never),
  );
  assert.deepEqual(
    campActors.map((entity) => [entity.id, entity.actorId, entity.assetId]),
    [
      ["hunter-melee-west", "poacher-hunter", "actor-poacher-hunter"],
      ["hunter-melee-east", "poacher-hunter", "actor-poacher-hunter"],
      ["hunter-ranged", "poacher-scout", "actor-poacher-scout"],
    ],
  );
  const disableCamp = INTERACTIONS.find((item) => item.id === "camp-disable");
  assert.deepEqual(
    { actionId: disableCamp?.actionId, inputHint: disableCamp?.inputHint, activation: disableCamp?.activation },
    { actionId: "staff-heavy", inputHint: "heavy", activation: "press-release" },
  );
  const director = new CampaignDirector({ runId: "camp-hunter-event" });
  const checkpoint = await director.captureCheckpoint();
  assert.equal(
    await director.restoreCheckpoint({
      ...checkpoint,
      progress: {
        ...checkpoint.progress,
        chapter: 2,
        activeQuestIds: ["the-ash-hunters"] as never,
      },
    }),
    true,
  );
  await director.processEvent({
    type: "encounter-resolved",
    eventId: "camp-hunters-missing-east",
    idempotencyKey: "camp-hunters:missing-east",
    encounterId: "camp-hunters",
    resolution: "subdued",
    actorIds: ["hunter-melee-west", "hunter-ranged"],
  });
  assert.equal(
    director.snapshot().completedObjectiveIds.includes(
      "the-ash-hunters:subdue-hunters" as never,
    ),
    false,
  );

  await director.processEvent({
    type: "encounter-resolved",
    eventId: "camp-hunters-subdued",
    idempotencyKey: "camp-hunters:subdued",
    encounterId: "camp-hunters",
    resolution: "subdued",
    actorIds: ["hunter-melee-west", "hunter-melee-east", "hunter-ranged"],
  });
  assert.ok(
    director.snapshot().completedObjectiveIds.includes(
      "the-ash-hunters:subdue-hunters" as never,
    ),
  );
});

test("regions share elevations, traversal colliders, recipes and static-asset placements", () => {
  assert.equal(REGIONS.length, 9);
  assert.equal(ENVIRONMENT_RECIPES.length, REGIONS.length);
  for (const region of REGIONS) {
    const recipe = ENVIRONMENT_RECIPES.find(
      (candidate) => candidate.id === region.environmentRecipeId,
    );
    assert.ok(recipe, "recipe exists for " + region.id);
    assert.deepEqual(
      recipe?.groundSurfaceIds,
      region.ground.surfaces.map((surface) => surface.id),
    );
    for (const surface of region.ground.surfaces) {
      assert.ok(
        region.ground.colliders.some(
          (collider) =>
            collider.id === surface.colliderId &&
            collider.walkSurfaceId === surface.id,
        ),
        "surface collider is paired: " + region.id + "/" + surface.id,
      );
    }
    for (const placement of region.props) {
      assert.ok(
        region.assetIds.includes(placement.assetId),
        "placed asset is in region manifest: " + placement.assetId,
      );
    }
    for (const route of region.exits) {
      const destination = REGIONS.find(
        (candidate) => candidate.id === route.destinationRegionId,
      );
      assert.ok(destination, "route destination exists");
      assert.ok(
        destination?.entrances.some(
          (entrance) => entrance.traversalEvent === route.traversalEvent,
        ),
        "route has a reciprocal authored entrance: " + route.traversalEvent,
      );
    }
  }
  const hollow = REGIONS.find((region) => region.id === "heartroot-hollow");
  const hollowRoot = hollow?.props.find((prop) => prop.assetId === "prop-heartroot-root-column");
  const cavernFloor = hollow?.ground.surfaces.find(
    (surface) => surface.id === "heartroot-hollow-cavern-floor",
  );
  assert.ok(hollow && hollowRoot && cavernFloor?.walkable);
  assert.equal(hollowRoot.placement, "underground");
  assert.equal(hollowRoot.position.y, cavernFloor.elevation);
  let insideFloor = false;
  const point = hollowRoot.position;
  for (let index = 0, previous = cavernFloor.points.length - 1; index < cavernFloor.points.length; previous = index++) {
    const a = cavernFloor.points[previous]!;
    const b = cavernFloor.points[index]!;
    if ((a.z > point.z) !== (b.z > point.z) &&
      point.x < ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x) {
      insideFloor = !insideFloor;
    }
  }
  assert.equal(insideFloor, true, "root column placement is on its authored cavern floor polygon");
  const supportCollider = hollow.ground.colliders.find(
    (collider) => collider.id === cavernFloor.colliderId,
  );
  assert.equal(supportCollider?.walkSurfaceId, cavernFloor.id);
  const blockedByOtherCollider = hollow.ground.colliders.some((collider) => {
    if (collider.id === supportCollider?.id || (!collider.blocksMovement && !collider.blocksCamera)) return false;
    if (collider.kind === "box" && collider.halfExtents) {
      return Math.abs(point.x - collider.from.x) < collider.halfExtents.x &&
        Math.abs(point.y - collider.from.y) < collider.halfExtents.y &&
        Math.abs(point.z - collider.from.z) < collider.halfExtents.z;
    }
    if (collider.radius !== undefined) {
      const end = collider.to ?? collider.from;
      const delta = { x: end.x - collider.from.x, y: end.y - collider.from.y, z: end.z - collider.from.z };
      const lengthSquared = delta.x * delta.x + delta.y * delta.y + delta.z * delta.z;
      const along = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, (
        (point.x - collider.from.x) * delta.x +
        (point.y - collider.from.y) * delta.y +
        (point.z - collider.from.z) * delta.z
      ) / lengthSquared));
      const x = collider.from.x + along * delta.x - point.x;
      const y = collider.from.y + along * delta.y - point.y;
      const z = collider.from.z + along * delta.z - point.z;
      return x * x + y * y + z * z < collider.radius * collider.radius;
    }
    return false;
  });
  assert.equal(blockedByOtherCollider, false, "root column origin has authored collider clearance");
  assert.equal(ACTORS["council-envoy"]?.species, "antelope");
  assert.equal(ACTORS["council-envoy"]?.combatRole, "political-only");
  assert.equal(
    ACTORS.orun?.assetVariants?.["crowned-beast"],
    "actor-orun-crowned-beast",
  );
});

test("migration gate interact emits its quest event and advances the real objective", async () => {
  const region = REGIONS.find((candidate) => candidate.id === "sunmane-expanse");
  assert.ok(region);
  const gate = region.entities.find((entity) => entity.interactionId === "migration-gate");
  assert.ok(gate);

  const runId = "migration-gate-objective";
  const engine = new CombatEngine();
  engine.loadRegion({
    regionId: "sunmane-expanse",
    runId,
    presentActorIds: ["aren"],
    playerPosition: gate.position,
    chapter: 5,
  });
  assert.equal(engine.resolveInteraction("migration-gate", "migration-gate"), true);
  const event = engine.snapshotState().worldEvents.find(
    (candidate) => candidate.type === "semantic-interaction" && candidate.interactionId === "migration-gate",
  );
  if (!event || event.type !== "semantic-interaction") {
    throw new Error("Migration gate did not emit its authored interaction event.");
  }
  assert.equal(event.kind, "traverse");
  assert.equal(event.targetId, "migration-gate");

  const director = new CampaignDirector({ runId });
  const checkpoint = await director.captureCheckpoint();
  assert.equal(
    await director.restoreCheckpoint({
      ...checkpoint,
      progress: {
        ...checkpoint.progress,
        chapter: 5,
        regionId: "sunmane-expanse",
        activeQuestIds: ["tribute-of-teeth"] as never,
        completedObjectiveIds: [
          ...checkpoint.progress.completedObjectiveIds,
          "tribute-of-teeth:testimony",
          "tribute-of-teeth:record",
        ] as never,
      },
    }),
    true,
  );
  const snapshot = await director.processEvent(event);
  assert.ok(snapshot.completedObjectiveIds.includes("tribute-of-teeth:gate" as never));
});
test("Chapter Six transition opens and checkpoints the Refuge route", async () => {
  const director = new CampaignDirector({ runId: "refuge-open-route" });
  const checkpoint = await director.captureCheckpoint();
  const priorRequiredQuests = ALL_QUESTS
    .filter((quest) => !quest.optional && quest.chapter > 0 && quest.chapter < 6)
    .map((quest) => quest.id);
  assert.equal(
    await director.restoreCheckpoint({
      ...checkpoint,
      progress: {
        ...checkpoint.progress,
        chapter: 5,
        regionId: "the-grove",
        activeQuestIds: [],
        completedQuestIds: priorRequiredQuests as never,
        worldFacts: {
          ...checkpoint.progress.worldFacts,
          chapter: 5,
          refugeOpen: false,
        },
      },
    }),
    true,
  );
  assert.equal(director.snapshot().worldFacts.refugeOpen, false);
  await assert.rejects(
    director.travel("refuge", "grove-refuge-in"),
    /does not open before the Fall of the Grove/,
  );

  const chapterSix = await director.processEvent({
    type: "chapter-transition",
    eventId: "refuge-open-chapter-six",
    idempotencyKey: "refuge-open:chapter-six",
    fromChapter: 5,
    toChapter: 6,
    triggerId: "fall-of-the-grove",
  });
  assert.equal(chapterSix.chapter, 6);
  assert.equal(chapterSix.worldFacts.refugeOpen, true);
  assert.ok(chapterSix.activeQuestIds.includes("fall-of-the-grove" as never));

  const safe = await director.captureCheckpoint();
  assert.equal(await director.restoreCheckpoint(safe), true);
  assert.equal(director.snapshot().worldFacts.refugeOpen, true);
  const entered = await director.travel("refuge", "grove-refuge-in");
  assert.equal(entered.regionId, "refuge");
});

test("Fall of the Grove advances only from safe rescue, authored interactions, and Ask/Signal", async () => {
  const runId = "fall-of-the-grove-objectives";
  const director = new CampaignDirector({ runId });
  const checkpoint = await director.captureCheckpoint();
  assert.equal(
    await director.restoreCheckpoint({
      ...checkpoint,
      progress: {
        ...checkpoint.progress,
        chapter: 6,
        regionId: "the-grove",
        activeQuestIds: ["fall-of-the-grove"] as never,
        worldFacts: {
          ...checkpoint.progress.worldFacts,
          chapter: 6,
          wardenCall: true,
          refugeOpen: true,
        },
      },
    }),
    true,
  );
  await director.processEvent({
    type: "rescue",
    eventId: "fall-tali-safe",
    idempotencyKey: "fall:tali-safe",
    targetId: "tali",
    locationId: "the-grove",
    safe: true,
  });

  const grove = REGIONS.find((region) => region.id === "the-grove");
  assert.ok(grove);
  const triggerGroveInteraction = (interactionId: string, targetId: string) => {
    const entity = grove.entities.find((candidate) => candidate.interactionId === interactionId);
    assert.ok(entity, "Grove placement exists for " + interactionId);
    const engine = new CombatEngine();
    engine.loadRegion({
      regionId: "the-grove",
      runId,
      presentActorIds: ["aren"],
      playerPosition: entity.position,
      chapter: 6,
    });
    assert.equal(engine.resolveInteraction(interactionId, targetId), true);
    const event = engine.snapshotState().worldEvents.find(
      (candidate) => candidate.type === "semantic-interaction" && candidate.interactionId === interactionId,
    );
    if (!event || event.type !== "semantic-interaction") {
      throw new Error("Grove interaction did not emit its authored semantic event: " + interactionId);
    }
    return event;
  };
  await director.processEvent(triggerGroveInteraction("grove-pillar", "grove-pillar"));
  await director.processEvent(triggerGroveInteraction("grove-services", "grove-services"));
  await director.choose("chapter-six-response", "ask");

  const completed = director.snapshot();
  assert.ok(completed.completedQuestIds.includes("fall-of-the-grove" as never));
  assert.equal(completed.worldFacts.refugeOpen, true);
  const safe = await director.captureCheckpoint();
  assert.ok(safe.progress.completedQuestIds.includes("fall-of-the-grove"));
  assert.equal(await director.restoreCheckpoint(safe), true);
  assert.ok(director.snapshot().completedQuestIds.includes("fall-of-the-grove" as never));
});
test("Director deduplicates semantic events and keeps Dominion history across a full rewind", async () => {
  const director = new CampaignDirector({ runId: "same-run-rewind" });
  const safe = await director.captureCheckpoint();
  const fragmentEvent = {
    type: "fragment" as const,
    eventId: "sky-fragment-once",
    idempotencyKey: "fragment:sky:once",
    fragmentId: FRAGMENT_IDS[0],
    sourceId: "vara",
  };
  await director.processEvent(fragmentEvent);
  await director.processEvent(fragmentEvent);
  assert.deepEqual(director.snapshot().fragments, ["heartroot-sky"]);
  await director.processEvent({
    type: "encounter-resolved",
    eventId: "dominion-koro-once",
    idempotencyKey: "dominion:koro:once",
    encounterId: "encounter-koro",
    resolution: "dominated",
    actorIds: ["koro"],
  });
  assert.equal(director.snapshot().campaign.dominionHistory.length, 1);
  assert.equal(await director.restoreCheckpoint(safe), true);
  assert.deepEqual(
    director.snapshot().campaign.dominionHistory.map((event) => event.leaderId),
    ["koro"],
  );
  assert.equal(evaluateEnding(director.snapshot().campaign).available, false);
  assert.deepEqual(director.snapshot().fragments, []);
  await director.processEvent(fragmentEvent);
  assert.deepEqual(director.snapshot().fragments, ["heartroot-sky"]);
});

test("unsafe Tali rescue requests a full checkpoint rewind, restoring prior branch progress", async () => {
  const director = new CampaignDirector({ runId: "tali-retry" });
  await director.processEvent({
    type: "fragment",
    eventId: "sky-before-rescue",
    idempotencyKey: "tali:sky:1",
    fragmentId: "heartroot-sky",
    sourceId: "vara",
  });
  await director.processEvent({
    type: "rescue",
    eventId: "tali-safe",
    idempotencyKey: "tali:safe:1",
    targetId: "tali",
    locationId: "safe-route",
    safe: true,
  });
  const safe = director.snapshot().lastSafeCheckpoint;
  assert.ok(safe);
  assert.equal(safe.progress.worldFacts.taliSafe, true);
  assert.equal(safe.progress.worldFacts.taliInBamboo, true);
  assert.equal(safe.progress.worldFacts.taliInGrove, false);
  assert.ok(safe.progress.eventKeys.includes("tali:safe:1"));
  assert.ok(
    safe.progress.eventLog.some((event) => event.idempotencyKey === "tali:safe:1"),
  );
  assert.equal(safe.safeSpawn.regionId, safe.progress.regionId);
  assert.equal("lastSafeCheckpoint" in safe.progress, false);
  await director.processEvent({
    type: "semantic-interaction",
    eventId: "later-scene",
    idempotencyKey: "later:scene:1",
    actorId: "aren",
    interactionId: "later-scene",
    kind: "inspect",
    targetId: "later-scene",
    position: { x: 0, y: 0, z: 0 },
  });
  await director.processEvent({
    type: "rescue",
    eventId: "tali-failed",
    idempotencyKey: "tali:unsafe:1",
    targetId: "tali",
    locationId: "hunter-camp",
    safe: false,
  });
  assert.equal(director.snapshot().worldFacts.taliSafe, true);
  assert.deepEqual(director.snapshot().recoveryRequest, {
    kind: "restart-checkpoint",
    reason: "tali-safety",
    checkpointId: safe?.checkpointId,
  });
  assert.equal(await director.restoreCheckpoint(safe), true);
  assert.equal(director.snapshot().worldFacts.taliSafe, true);
  assert.equal(
    director.snapshot().worldFacts["interaction:later-scene"],
    undefined,
  );
  assert.deepEqual(director.snapshot().fragments, ["heartroot-sky"]);
  assert.equal(director.snapshot().recoveryRequest, null);
  assert.equal(director.snapshot().worldFacts.taliInBamboo, true);
  const reunion = await director.captureCheckpoint();
  assert.equal(
    await director.restoreCheckpoint({
      ...reunion,
      progress: {
        ...reunion.progress,
        chapter: 6,
        regionId: "whispering-canopy",
        activeQuestIds: [],
        completedQuestIds: ["a-mothers-roar"] as never,
        worldFacts: {
          ...reunion.progress.worldFacts,
          chapter: 6,
          taliSafe: true,
          taliInBamboo: true,
          taliInGrove: false,
        },
      },
    }),
    true,
  );
  await director.travel("the-grove", "canopy-grove-in");
  assert.equal(director.snapshot().worldFacts.taliInBamboo, false);
  assert.equal(director.snapshot().worldFacts.taliInGrove, true);
});

function eligibleRun(runId: string): CampaignState {
  const fresh = createNewRun(runId);
  return {
    ...fresh,
    world: {
      ...fresh.world,
      factions: Object.fromEntries(
        FACTION_IDS.map((id) => [
          id,
          {
            ...fresh.world.factions[id],
            bondTier: 3,
            representative: {
              ...fresh.world.factions[id].representative,
              present: true,
              willing: true,
            },
          },
        ]),
      ) as CampaignState["world"]["factions"],
      regions: Object.fromEntries(
        REGION_IDS.map((id) => [id, "restored"]),
      ) as CampaignState["world"]["regions"],
      hollowReady: true,
      regionalObligations: Object.fromEntries(
        REGIONAL_OBLIGATION_IDS.map((id) => [id, true]),
      ) as CampaignState["world"]["regionalObligations"],
      renewedCommitments: Object.fromEntries(
        FACTION_IDS.map((id) => [id, true]),
      ) as CampaignState["world"]["renewedCommitments"],
    },
  };
}

test("package ending authority enforces historic Dominion and exile council representation", () => {
  const ready = eligibleRun("ending-ready");
  assert.equal(
    (evaluateEnding(ready).choices as readonly string[]).includes(
      "living_pact",
    ),
    true,
  );
  const dominated = recordLeaderDominion(ready, "solkar");
  assert.equal(
    (evaluateEnding(dominated).choices as readonly string[]).includes(
      "living_pact",
    ),
    false,
  );
  const exile = eligibleRun("ending-exile");
  const crown = exile.world.factions.crown;
  const absentSolkar = {
    ...exile,
    world: {
      ...exile.world,
      factions: {
        ...exile.world.factions,
        crown: {
          ...crown,
          leaderStatus: "exiled" as const,
          representative: {
            id: "solkar",
            source: "leader" as const,
            present: false,
            willing: false,
          },
        },
      },
    },
  };
  assert.equal(
    evaluateEnding(setCrownCouncilRepresentation(absentSolkar, true)).available,
    true,
  );
});

test("ending availability follows every authored branch history and its absent-leader alternative", () => {
  for (const [index, history] of BRANCH_HISTORIES.entries()) {
    let state = eligibleRun("ending-history-" + index);
    state = { ...state, world: { ...state.world, marekPresent: history.marek === "present" } };
    if (history.pack === "dominion") state = recordLeaderDominion(state, "ruun");
    else state = setPackLeader(state, history.pack);
    if (history.crown === "dominion") state = recordLeaderDominion(state, "solkar");
    if (history.crown === "exile") {
      const crown = state.world.factions.crown;
      state = {
        ...state,
        world: {
          ...state.world,
          factions: {
            ...state.world.factions,
            crown: {
              ...crown,
              leaderStatus: "exiled",
              representative: { id: "solkar", source: "leader", present: false, willing: false },
            },
          },
        },
      };
      assert.equal(
        (evaluateEnding(state).choices as readonly string[]).includes("living_pact"),
        false,
        "exile without a council locks Living Pact: " + JSON.stringify(history),
      );
      state = setCrownCouncilRepresentation(state, true);
      assert.equal(state.world.factions.crown.representative.id, "crown-council");
      assert.equal(state.world.factions.crown.representative.present, true);
    }

    const expectedAvailable = history.pack !== "dominion" && history.crown !== "dominion";
    const evaluation = evaluateEnding(state);
    assert.equal(evaluation.available, expectedAvailable, JSON.stringify(history));
    assert.equal(
      (evaluation.choices as readonly string[]).includes("living_pact"),
      expectedAvailable,
      JSON.stringify(history),
    );
  }

  const eligible = evaluateEnding(eligibleRun("ending-all-options"));
  assert.equal(eligible.available, true);
  assert.deepEqual(eligible.choices, ["dominion", "severance", "living_pact"]);

  const missingObligation = eligibleRun("ending-missing-obligation");
  const missingPrerequisite: CampaignState = {
    ...missingObligation,
    world: {
      ...missingObligation.world,
      regionalObligations: { ...missingObligation.world.regionalObligations, moonpine_settlement: false },
    },
  };
  const locked = evaluateEnding(missingPrerequisite);
  assert.equal(locked.available, false);
  assert.ok(locked.unmet.some(({ id }) => id === "moonpine_settlement"));
  assert.equal((locked.choices as readonly string[]).includes("living_pact"), false);
});

test("Director accepts legitimate final endings and rejects invalid or locked choices without mutation", async () => {
  for (const ending of ["dominion", "severance"] as const) {
    const director = new CampaignDirector({ runId: "director-ending-" + ending });
    await director.processEvent({
      type: "encounter-resolved",
      eventId: "orun-resolved-" + ending,
      idempotencyKey: "orun-resolved:" + ending,
      encounterId: "encounter-orun",
      resolution: "cleansed",
      actorIds: ["orun"],
    });
    await director.choose("final-ending", ending);
    assert.equal(director.snapshot().ending, ending);
  }

  const director = new CampaignDirector({ runId: "director-ending-locked" });
  await director.processEvent({
    type: "encounter-resolved",
    eventId: "orun-resolved-locked",
    idempotencyKey: "orun-resolved:locked",
    encounterId: "encounter-orun",
    resolution: "cleansed",
    actorIds: ["orun"],
  });
  const before = director.snapshot();
  await assert.rejects(director.choose("final-ending", "unknown-ending"));
  assert.deepEqual(director.snapshot(), before);
  await assert.rejects(director.choose("final-ending", "living_pact"), /Living Pact requirements/);
  assert.deepEqual(director.snapshot(), before);
});

test("Director accepts Living Pact through checkpoint restore and the final choice", async () => {
  const runId = "director-ending-living-pact";
  const director = new CampaignDirector({ runId });
  const checkpoint = await director.captureCheckpoint();
  assert.equal(
    await director.restoreCheckpoint({
      ...checkpoint,
      worldCheckpoint: createCheckpoint(eligibleRun(runId)),
    }),
    true,
  );
  await director.processEvent({
    type: "encounter-resolved",
    eventId: "orun-resolved-living-pact",
    idempotencyKey: "orun-resolved:living-pact",
    encounterId: "encounter-orun",
    resolution: "cleansed",
    actorIds: ["orun"],
  });
  const snapshot = await director.choose("final-ending", "living_pact");
  assert.equal(snapshot.ending, "living_pact");
  assert.equal(snapshot.worldFacts.circleOfTheWild, true);
  assert.equal(snapshot.lastEvent?.type, "choice");
});
