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
import {
  NARRATIVE_CUES,
  isCueBeatAuthored,
  cueForObjective,
} from "../../src/content/narrative-cues.js";
import { ACT_I_REGION_AUTHORING_STATUS, ACT_I_REGIONS } from "../../src/content/levels/act-i.js";
import { LATER_ACT_REGION_AUTHORING_STATUS, LATER_ACT_REGIONS } from "../../src/content/levels/later-acts.js";
import { CampaignDirector, CampaignChoiceRejectedError } from "../../src/game/campaign/CampaignDirector.js";
import { CombatEngine, type CombatInput } from "../../src/game/combat/CombatEngine.js";
import type { WorldEvent } from "../../src/game/contracts.js";
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
    // Pack leadership only decides after the Ruun guardian has been cleansed; emit the canonical encounter-resolved
    // event the same way the live combat encounter handler would, so the test never bypasses the gate.
    await director.processEvent({
      type: "encounter-resolved",
      eventId: `ruun-resolved-${index}`,
      idempotencyKey: `ruun-resolved:${index}`,
      encounterId: "encounter-ruun",
      resolution: "cleansed",
      actorIds: ["ruun"],
    });
    const packOption = history.pack === "dominion" ? "dominion-ruun" : history.pack;
    await director.choose("pack-leadership", packOption);
    assert.equal(director.snapshot().choices["pack-leadership"], packOption);

    await setBranchChapter(director, 4);
    const marekOption = history.marek === "present" ? "cleanse" : "leave";
    await director.choose("marek-fate", marekOption);
    assert.equal(director.snapshot().campaign.world.marekPresent, history.marek === "present");

    await setBranchChapter(director, 5);
    // Sunmane resolution only decides after the Solkar guardian has been cleansed; emit the canonical event.
    await director.processEvent({
      type: "encounter-resolved",
      eventId: `solkar-resolved-${index}`,
      idempotencyKey: `solkar-resolved:${index}`,
      encounterId: "encounter-solkar",
      resolution: "cleansed",
      actorIds: ["solkar"],
    });
    await director.choose("sunmane-resolution", history.crown);
    assert.equal(director.snapshot().choices["sunmane-resolution"], history.crown);
    if (history.crown === "exile") {
      assert.equal(director.snapshot().campaign.world.factions.crown.leaderStatus, "exiled");
      await assert.rejects(director.selectParty("solkar"));
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

test("Chapter Six response only accepts after the Fall completes (refugeOpen && !wardenCall)", async () => {
  for (const response of ["ask", "signal"] as const) {
    const director = new CampaignDirector({ runId: "chapter-six-" + response });
    await setBranchChapter(director, 6);
    const checkpoint = await director.captureCheckpoint();
    // Pre-Fall: only the Call is on; chapter entry alone grants neither the Refuge nor the response choice. The
    // rejection is the canonical typed permanent rejection for this choice — not a string match on the message.
    assert.equal(
      await director.restoreCheckpoint({
        ...checkpoint,
        progress: {
          ...checkpoint.progress,
          activeQuestIds: ["fall-of-the-grove"] as never,
          worldFacts: {
            ...checkpoint.progress.worldFacts,
            wardenCall: true,
            refugeOpen: false,
          },
        },
      }),
      true,
    );
    await assert.rejects(
      director.choose("chapter-six-response", response),
      (error: unknown) =>
        error instanceof CampaignChoiceRejectedError &&
        error.choiceId === "chapter-six-response" &&
        error.optionId === response,
    );
    assert.equal(director.snapshot().choices["chapter-six-response"], undefined, "pre-Fall choice was not recorded");

    // After the earned grove-collapse-escape, the Refuge is open and the Call is severed; the player can decide.
    assert.equal(
      await director.restoreCheckpoint({
        ...checkpoint,
        progress: {
          ...checkpoint.progress,
          activeQuestIds: ["fall-of-the-grove"] as never,
          worldFacts: {
            ...checkpoint.progress.worldFacts,
            wardenCall: false,
            refugeOpen: true,
          },
        },
      }),
      true,
    );
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
  // Distinct placed hunters retain their canonical melee/ranged identities.
  assert.deepEqual(
    campActors.map((entity) => [entity.id, entity.actorId]),
    [
      ["hunter-melee-west", "poacher-hunter"],
      ["hunter-melee-east", "poacher-hunter"],
      ["hunter-ranged", "poacher-scout"],
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
  // Heartroot Hollow root-column prop carries the authored walk-surface and surface collider through the runtime
  // manifest; the carved physical polygons now include ramps and split caverns, so a point-in-polygon check would
  // assert against an authoring detail the runtime no longer requires. The consumer-visible contract remains: the
  // support surface exists, is walkable, and the column sits on it at its authored elevation; the paired collider
  // resolves to the same walk surface id. The runtime uses those references — never the polygon's exact point set.
  const hollow = REGIONS.find((region) => region.id === "heartroot-hollow");
  const hollowRoot = hollow?.props.find((prop) => prop.assetId === "prop-heartroot-root-column");
  const supportSurfaces = hollow?.ground.surfaces.filter((surface) =>
    hollowRoot !== undefined && surface.elevation === hollowRoot.position.y,
  );
  assert.ok(hollow && hollowRoot && supportSurfaces && supportSurfaces.length > 0);
  assert.equal(hollowRoot.placement, "underground");
  const supportCollider = hollow.ground.colliders.find(
    (collider) => supportSurfaces.some((surface) => surface.colliderId === collider.id),
  );
  assert.ok(supportCollider);
  assert.ok(
    supportSurfaces.some((surface) => surface.walkable && supportCollider.walkSurfaceId === surface.id),
    "root column support surface is walkable and paired with its authored collider",
  );
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
test("Fall of the Grove advances only from live Fall FSM output: rescue, pillar, escape open the Refuge", { timeout: 30_000 }, async () => {
  // Exercise the real producer → Director boundary, including the pre-Fall rejection and durable post-Fall choice.
  // The solo path must evade Orun, brace the pillar, escort Tali and reach the escape zone.
  const runId = "fall-of-the-grove-objectives";
  const director = new CampaignDirector({ runId });
  const directorCheckpoint = await director.captureCheckpoint();
  assert.equal(
    await director.restoreCheckpoint({
      ...directorCheckpoint,
      progress: {
        ...directorCheckpoint.progress,
        chapter: 6,
        regionId: "the-grove",
        activeQuestIds: ["fall-of-the-grove"] as never,
        worldFacts: {
          ...directorCheckpoint.progress.worldFacts,
          chapter: 6,
          "interaction:warden-call": true,
          wardenCall: true,
        },
      },
    }),
    true,
  );

  // Pre-Fall: the choice is a typed permanent rejection. The choice must not be recorded on the snapshot.
  await assert.rejects(
    director.choose("chapter-six-response", "ask"),
    (error: unknown) =>
      error instanceof CampaignChoiceRejectedError &&
      error.choiceId === "chapter-six-response" &&
      error.optionId === "ask",
  );
  assert.equal(director.snapshot().choices["chapter-six-response"], undefined, "pre-Fall choice was not recorded");

  // Build a fresh CombatEngine, drive the same solo Fall sequence the unit test exercises, and forward every drained
  // world event into the Director. The engine does the physical work; the Director consumes the producer's output.
  const grove = REGIONS.find((region) => region.id === "the-grove")!;
  const fallFacts: Record<string, boolean> = {
    "choice:asha-pact": true,
    taliInGrove: true,
    "interaction:warden-call": true,
    wardenCall: true,
    taliSafe: true,
    bamboo_tali_safe: true,
  };
  const present = grove.entities
    .filter((entity) => entity.actorId && (!entity.visibleWhen || fallFacts[entity.visibleWhen]))
    .map((entity) => entity.id);
  const engine = new CombatEngine();
  engine.loadRegion({
    regionId: "the-grove",
    regionDefinition: grove,
    runId,
    presentActorIds: present,
    chapter: 6,
    wardenCall: true,
    worldFacts: fallFacts,
    playerPosition: { x: 17, y: 0, z: 0 },
  });
  engine.startEncounter({ encounterId: "encounter-fall", regionId: "the-grove", runId, worldFacts: fallFacts });
  const drained: WorldEvent[] = [];
  const drain = (): void => { drained.push(...engine.consumeWorldEvents()); };
  drain();
  const step = (extra: Partial<CombatInput> = {}): void => {
    engine.step(
      {
        tick: engine.simulationTick + 1,
        move: { x: 0, y: 0, z: 0 },
        dodgePressed: false,
        lightPressed: false,
        heavyPressed: false,
        heavyHeld: false,
        heavyReleased: false,
        interactPressed: false,
        ...extra,
      },
      1 / 60,
    );
    drain();
  };
  const idle = (ticks: number, until: () => boolean = () => false): void => {
    for (let i = 0; i < ticks && !until(); i++) step();
  };
  const move = (dx: number, dz: number): void => {
    const d = Math.hypot(dx, dz) || 1;
    step({ move: { x: dx / d, y: 0, z: -dz / d } });
  };
  const arenPos = (): { x: number; y: number; z: number } => {
    const snapshot = engine.snapshotState();
    const player = snapshot.actors.find((candidate) => candidate.id === "aren")!;
    return player.position;
  };
  const walkTo = (x: number, z: number, radius = 0.8): void => {
    for (let i = 0; i < 1500; i++) {
      const p = arenPos();
      if (Math.hypot(x - p.x, z - p.z) <= radius) return;
      move(x - p.x, z - p.z);
    }
    assert.fail(`Aren never reached ${x},${z}`);
  };
  const interact = (interactionId: string, targetId: string): boolean => {
    const ok = engine.resolveInteraction(interactionId, targetId);
    drain();
    return ok;
  };
  const forwardDrained = async (): Promise<void> => {
    for (const event of drained.splice(0)) {
      await director.processEvent(event);
    }
  };

  // Let the first surge resolve, then evade the next.
  idle(10);
  const first = engine.snapshotState().hazards.find((hazard) => hazard.sourceId === "orun");
  assert.ok(first, "the live Fall schedules Orun's first root surge");
  idle(200, () => !engine.snapshotState().hazards.some((hazard) => hazard.id === first.id));
  await forwardDrained();

  // 2. Evade the next surge with outward movement so the protection phase clears without taking possession.
  idle(400, () =>
    engine
      .snapshotState()
      .hazards.some((hazard) => hazard.sourceId === "orun" && hazard.id !== first.id),
  );
  const orunActor = engine.snapshotState().actors.find((candidate) => candidate.id === "orun")!;
  const arenFromOrun = arenPos();
  for (let i = 0; i < 70; i++) move(arenFromOrun.x - orunActor.position.x, arenFromOrun.z - orunActor.position.z);
  idle(120, () =>
    drained.some(
      (event) =>
        event.type === "encounter-phase" &&
        event.encounterId === "encounter-fall" &&
        event.phaseIndex === 0 &&
        event.state === "cleared",
    ),
  );
  await forwardDrained();
  assert.equal(
    director.snapshot().worldFacts["encounterPhase:encounter-fall:0:cleared"],
    true,
    "protection phase cleared through real encounter FSM, not a fabricated phase event",
  );

  // 3. Brace the pillar at the authored placement.
  walkTo(14, -2);
  assert.equal(interact("grove-pillar", "grove-pillar"), true);
  await forwardDrained();
  assert.equal(director.snapshot().worldFacts["interaction:grove-pillar"], true);

  // 4. Send Tali to her lookout shelter; the FSM emits the rescue event when she physically arrives and is safe.
  const tali = engine.snapshotState().actors.find((candidate) => candidate.id === "tali")!;
  walkTo(tali.position.x, tali.position.z, 1.2);
  assert.equal(interact("grove-tali-rescue", "tali"), true);
  // The interact itself only marks Tali as moving; the canonical rescue event arrives after she reaches the shelter.
  idle(600, () => drained.some((event) => event.type === "rescue"));
  const shelterTali = engine.snapshotState().actors.find((candidate) => candidate.id === "tali")!;
  assert.ok(
    Math.hypot(shelterTali.position.x - 25, shelterTali.position.z - 11) <= 0.61,
    "Tali physically reached grove-tali-shelter",
  );
  const rescueRecorded = drained.some(
    (event) =>
      event.type === "rescue" &&
      event.targetId === "tali" &&
      event.locationId === "grove-tali-shelter" &&
      event.safe === true,
  );
  assert.ok(rescueRecorded, "live Fall FSM emitted the canonical safe rescue at grove-tali-shelter");
  await forwardDrained();

  // 5. Aren moves onto the lookout pad and the FSM emits the earned escape; only this flips the Director's bits.
  walkTo(15, 0);
  walkTo(26, 4);
  idle(20);
  walkTo(30, 10);
  walkTo(26, 4);
  idle(40);
  const escapeEmitted = drained.some(
    (event) => event.type === "semantic-interaction" && event.interactionId === "grove-collapse-escape",
  );
  assert.ok(escapeEmitted, "earned escape is emitted by the live FSM once protection, Tali and pillar all hold");
  await forwardDrained();

  const escaped = director.snapshot();
  assert.equal(escaped.worldFacts.refugeOpen, true, "earned escape opens the Refuge");
  assert.equal(escaped.worldFacts.wardenCall, false, "earned escape severs the Warden Call");

  // 6. Post-Fall, the choice records and marks the ask-signal objective; the bits survive a checkpoint round-trip.
  await director.choose("chapter-six-response", "ask");
  const completed = director.snapshot();
  assert.equal(completed.worldFacts.askSignal, true);
  assert.equal(completed.worldFacts.wardenResponse, "ask");
  assert.ok(
    completed.completedObjectiveIds.includes("fall-of-the-grove:ask-signal" as never),
    "the ask-signal objective advances on the chosen response",
  );

  const safe = await director.captureCheckpoint();
  assert.equal(safe.progress.worldFacts.refugeOpen, true);
  assert.equal(safe.progress.worldFacts.wardenCall, false);
  assert.equal(await director.restoreCheckpoint(safe), true);
  assert.equal(director.snapshot().worldFacts.refugeOpen, true);
  assert.equal(director.snapshot().worldFacts.wardenCall, false);
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
  // Reunion uses the authored Bamboo→Grove route and its canonical restoration gate.
  const reunion = await director.captureCheckpoint();
  assert.equal(
    await director.restoreCheckpoint({
      ...reunion,
      progress: {
        ...reunion.progress,
        chapter: 6,
        regionId: "blood-bamboo-valley",
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
  await director.processEvent({
    type: "restoration",
    eventId: "bamboo-restored",
    idempotencyKey: "restoration:blood-bamboo-valley:restored",
    regionId: "blood-bamboo-valley",
    state: "restored",
    causeId: "bamboo-bond",
  });
  assert.equal(
    director.snapshot().worldFacts["restoration:blood-bamboo-valley:restored"],
    true,
    "canonical restoration opens the bamboo→grove gate",
  );
  await director.travel("the-grove", "bamboo-grove-in");
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


test("each chapter 1-2 quest dialogue id has an explicit runtime cue", () => {
  const firstPactQuests = ALL_QUESTS.filter(quest => quest.chapter === 1 || quest.chapter === 2);
  for (const quest of firstPactQuests) {
    const cue = NARRATIVE_CUES[quest.id];
    assert.ok(cue, `cue entry exists for ${quest.id}`);
    assert.equal(cue.questId, quest.id, `cue entry owns ${quest.id}`);
    const cueBeats = [cue.onActivate, cue.onComplete].filter(Boolean) as string[];
    for (const cueBeat of cueBeats) {
      assert.ok(isCueBeatAuthored(cueBeat), `cue beat resolves in STORY_DIALOGUE: ${cueBeat}`);
    }
    for (const dialogueId of quest.dialogueIds) {
      const expectedCue = [cue.onActivate, cue.onComplete].includes(dialogueId)
        || Boolean(cue.onObjective?.some(cueEntry => cueEntry.beatId === dialogueId));
      assert.ok(expectedCue, `${quest.id} dialogue ${dialogueId} has an explicit runtime cue`);
    }
    if (cue.onObjective) {
      for (const cueEntry of cue.onObjective) {
        assert.ok(isCueBeatAuthored(cueEntry.beatId), `objective cue beat resolves: ${cueEntry.beatId}`);
        assert.equal(
          cueForObjective(quest.id, cueEntry.objectiveId),
          cueEntry.beatId,
          `cueForObjective resolves ${cueEntry.objectiveId}`,
        );
      }
    }
  }
});

test("narrative cues only target authored quests and reference STORY_DIALOGUE", () => {
  // Every cue target must resolve to an authored quest id. The chapter range now spans later acts (the-third-howl and
  // beyond), so a chapter window no longer constrains cue ownership — the runtime only requires the target to exist.
  const authoredCueQuestIds = new Set(Object.keys(NARRATIVE_CUES));
  const authoredQuestIds = new Set(ALL_QUESTS.map((quest) => quest.id));
  for (const cueQuestId of authoredCueQuestIds) {
    assert.ok(authoredQuestIds.has(cueQuestId), `cue target is an authored quest: ${cueQuestId}`);
  }
});
