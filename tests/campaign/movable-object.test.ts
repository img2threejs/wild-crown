import { describe, expect, it } from "bun:test";
import { REGIONS } from "../../src/content/campaign.js";
import { CampaignDirector } from "../../src/game/campaign/CampaignDirector.js";
import { CombatEngine, type CombatInput, type EngineState } from "../../src/game/combat/CombatEngine.js";
import { vec } from "../../src/game/combat/geometry.js";
import { SaveRepository, SaveRepositoryError, type SaveSlotSummary } from "../../src/game/storage/SaveRepository.js";
import type { CampaignState, CheckpointSnapshot } from "../../packages/campaign/src/index.js";
import type { ActorId, RegionId, WorldEvent } from "../../src/game/contracts.js";
import { TARGETED_STRIKES, THUNDER_CLEAVE } from "../../src/game/combat/PlayerSkills.js";

const REGION_ID = "blood-bamboo-valley" as const;
const region = REGIONS.find((item) => item.id === REGION_ID)!;
const movable = region.movableObjects.find((item) => item.id === "camp-loose-snare")!;
const movedFactId = "objectMoved:camp-loose-snare";
const koroMove = { companionId: "koro", command: "special", target: { kind: "interaction", interactionId: movable.koroInteractionId, targetId: movable.id } } as const;
const idle: CombatInput = {
  tick: 0,
  move: vec(0, 0, 0),
  dodgePressed: false,
  lightPressed: false,
  heavyPressed: false,
  heavyHeld: false,
  heavyReleased: false,
  interactPressed: false,
};

type MoveActor = "bamboo-koro" | "aren";

function moveEvent(runId: string, actorId: MoveActor, interactionId: string): Extract<WorldEvent, { type: "object-moved" }> {
  return {
    type: "object-moved",
    eventId: runId + ":object-moved:" + movable.id,
    idempotencyKey: runId + ":object-moved:" + movable.id,
    regionId: REGION_ID,
    objectId: movable.id,
    interactionId,
    actorId,
    from: movable.from,
    to: movable.to,
  };
}

async function directorAtCamp(runId: string, utility?: "koro", saves?: SaveRepository): Promise<CampaignDirector> {
  const director = new CampaignDirector({ runId, saves });
  const checkpoint = await director.captureCheckpoint();
  const restored = await director.restoreCheckpoint({
    ...checkpoint,
    safeSpawn: {
      ...checkpoint.safeSpawn,
      regionId: REGION_ID,
      position: region.navigation.nodes[0]!.position,
      routeId: region.navigation.nodes[0]!.id,
      cameraAnchorId: region.cameraAnchors[0]!.id,
    },
    progress: {
      ...checkpoint.progress,
      chapter: 2,
      regionId: REGION_ID,
      activeQuestIds: [],
      completedQuestIds: [],
      completedObjectiveIds: [],
      party: utility ? { companionId: utility } : {},
      worldFacts: { ...checkpoint.progress.worldFacts, chapter: 2 },
    },
    // A traveling companion is earned: Koro's committed cleanse recruited him in Chapter 1, so the camp fixture
    // carries that earned recruitment rather than a free selection.
    worldCheckpoint: {
      ...checkpoint.worldCheckpoint,
      world: {
        ...checkpoint.worldCheckpoint.world,
        companions: {
          ...checkpoint.worldCheckpoint.world.companions,
          koro: { ...checkpoint.worldCheckpoint.world.companions.koro, recruited: true },
        },
      },
    },
  });
  expect(restored).toBe(true);
  return director;
}

function campEngine(
  runId: string,
  worldFacts: Readonly<Record<string, boolean | number | string>>,
  withKoro: boolean,
  startEncounter = true,
  suspendRanged = false,
  unassignedKoro = false,
  playerOffsetZ = 1,
): CombatEngine {
  const companionId = withKoro ? "koro" as const : undefined;
  const facts = { ...worldFacts, ...(withKoro || unassignedKoro ? { "encounter-koro-cleansed": true } : {}) };
  const presentActorIds = [
    "hunter-melee-west",
    "hunter-melee-east",
    "hunter-ranged",
    ...(withKoro || unassignedKoro ? ["bamboo-koro"] : []),
  ];
  const playerStart = vec(movable.from.x, movable.from.y, movable.from.z + playerOffsetZ);
  const engine = new CombatEngine();
  engine.loadRegion({
    regionId: REGION_ID,
    runId,
    presentActorIds,
    playerPosition: playerStart,
    companionId,
    worldFacts: facts,
  });
  if (startEncounter) {
    engine.startEncounter({
      encounterId: "camp-hunters",
      regionId: REGION_ID,
      runId,
      playerPosition: playerStart,
      companionId,
      actors: engine.snapshotState().actors,
      worldFacts: facts,
    });
    const state = JSON.parse(engine.serialize()) as EngineState;
    for (const actor of state.actors) {
      if (actor.id === "hunter-melee-west" || actor.id === "hunter-melee-east" || (suspendRanged && actor.id === "hunter-ranged")) {
        actor.recoveringUntil = Number.MAX_SAFE_INTEGER;
      }
    }
    engine.restore(JSON.stringify(state));
  }
  if (withKoro) engine.commandCompanion({ companionId: "koro", command: "stay" });
  return engine;
}

/** Keep this test's interruptible window open through Koro's gesture and the snare's separate flight. */
function holdRangedWindup(engine: CombatEngine): void {
  const state = engine.snapshotState();
  const hazard = state.hazards.find(candidate => candidate.sourceId === "hunter-ranged")!;
  hazard.windupUntil! += 120; hazard.activeFrom += 120; hazard.activeUntil += 120;
  hazard.castUntil! += 120; hazard.recoveryUntil! += 120;
  hazard.threatTicks = hazard.threatTicks.map(tick => tick + 120);
  engine.restore(JSON.stringify(state));
}

function advanceObjectFlight(engine: CombatEngine): number {
  let flightStartTick: number | undefined;
  for (let elapsed = 0; elapsed < 120; elapsed += 1) {
    const pose = engine.snapshot().movableObjects.find((item) => item.objectId === movable.id);
    if (!pose) throw new Error("Camp snare is missing from the combat snapshot.");
    if (pose.phase === "in-flight" && flightStartTick === undefined) {
      flightStartTick = engine.snapshotState().tick;
    }
    if (pose.phase === "settled") {
      if (flightStartTick === undefined) throw new Error("Object settled without a fixed-step flight.");
      return engine.snapshotState().tick - flightStartTick;
    }
    expect(engine.snapshotState().worldEvents.some((event) => event.type === "object-moved")).toBe(false);
    engine.fixedStep(idle);
  }
  throw new Error("Authored object flight did not settle within its finite tick bound.");
}

describe("camp-loose-snare movable-object contract", () => {

  it("commits equipped traveling Koro contact but rejects forged party-instance origins", async () => {
    const runId = "movable-traveling-koro";
    const director = await directorAtCamp(runId, "koro");
    const engine = campEngine(runId, director.snapshot().worldFacts, true, false);
    const state = engine.snapshotState();
    state.actors.find(actor => actor.id === "bamboo-koro")!.id = "koro__party_companion" as ActorId;
    engine.restore(JSON.stringify(state));
    expect(engine.commandCompanion(koroMove)).toBe(true);
    expect(advanceObjectFlight(engine)).toBe(movable.animationTicks);
    const event = engine.consumeWorldEvents().find(event => event.type === "object-moved")!;
    expect(event.actorId).toBe("koro__party_companion");
    for (const actorId of ["koro__party_combat", "koro__party_companion_extra"]) {
      await expect(director.processEvent({ ...event, actorId: actorId as ActorId })).rejects.toBeInstanceOf(Error);
      expect(director.snapshot().worldFacts[movedFactId]).toBe(false);
    }
    expect((await director.processEvent(event)).worldFacts[movedFactId]).toBe(true);
  });

  it("moves through Koro utility special in finite fixed steps, interrupts only the live ranged windup, and reloads settled state", async () => {
    const runId = "movable-koro-special";
    const director = await directorAtCamp(runId, "koro");
    const directorBefore = director.snapshot();
    expect(directorBefore.worldFacts[movedFactId]).toBe(false);
    const engine = campEngine(runId, director.snapshot().worldFacts, true);
    const before = engine.snapshot();
    const rangedBefore = before.actors.find((actor) => actor.id === "hunter-ranged")!;
    expect(rangedBefore.downed).toBe(false);
    expect(before.movableObjects).toContainEqual({ objectId: movable.id, position: movable.from, phase: "resting" });

    engine.fixedStep(idle);
    holdRangedWindup(engine);
    expect(engine.snapshot().telegraphs.some((item) => item.sourceId === "hunter-ranged" && item.phase === "windup")).toBe(true);
    expect(engine.commandCompanion(koroMove)).toBe(true);
    expect(advanceObjectFlight(engine)).toBe(movable.animationTicks);

    const landed = engine.snapshot();
    const pose = landed.movableObjects.find((item) => item.objectId === movable.id);
    expect(pose).toMatchObject({ objectId: movable.id, position: movable.to, phase: "settled" });
    expect(engine.snapshotState().counterUntil - engine.snapshotState().tick).toBe(movable.effect.interruptRangedWindupTicks);
    expect(engine.snapshotState().worldEvents.some((event) => event.type === "encounter-resolved")).toBe(false);
    expect(landed.telegraphs.some((item) => item.sourceId === "hunter-ranged")).toBe(false);
    expect(engine.snapshotState().hazards.some((hazard) => hazard.sourceId === "hunter-ranged" && engine.simulationTick < hazard.activeUntil)).toBe(false);
    expect(engine.snapshotState().events.filter((item) => item.kind === "attack-interrupted").map((item) => item.targetId)).toEqual(["hunter-ranged"]);
    expect(landed.player.vitality).toBe(before.player.vitality);
    expect(landed.actors.map((actor) => [actor.id, actor.vitality, actor.downed])).toEqual(
      before.actors.map((actor) => [actor.id, actor.vitality, actor.downed]),
    );
    expect(landed.encounterId).toBe(before.encounterId);
    const events = engine.consumeWorldEvents().filter((event) => event.type === "object-moved");
    expect(events).toHaveLength(1);
    const movedEvent = events[0]!;
    expect(movedEvent).toMatchObject({ objectId: movable.id, regionId: REGION_ID, interactionId: movable.koroInteractionId, actorId: "bamboo-koro", from: movable.from, to: movable.to });
    const committed = await director.processEvent(movedEvent);
    expect(committed.worldFacts[movedFactId]).toBe(true);
    expect(committed.completedQuestIds).toEqual(directorBefore.completedQuestIds);
    expect(committed.completedObjectiveIds).toEqual(directorBefore.completedObjectiveIds);
    expect(committed.lastSafeCheckpoint?.progress.eventLog.filter((event) => event.type === "object-moved")).toHaveLength(1);
    const simulationSave = engine.serialize();
    const resumedEngine = new CombatEngine();
    resumedEngine.restore(simulationSave);
    expect(resumedEngine.snapshot().movableObjects).toContainEqual({ objectId: movable.id, position: movable.to, phase: "settled" });
    for (let tick = 0; tick < movable.animationTicks; tick += 1) resumedEngine.fixedStep(idle);
    expect(resumedEngine.snapshot().movableObjects).toContainEqual({ objectId: movable.id, position: movable.to, phase: "settled" });
    expect(resumedEngine.consumeWorldEvents().filter((event) => event.type === "object-moved")).toHaveLength(0);

    const savedCheckpoint = JSON.parse(JSON.stringify(await director.captureCheckpoint()));
    const reloadedDirector = new CampaignDirector({ runId });
    expect(await reloadedDirector.restoreCheckpoint(savedCheckpoint)).toBe(true);
    expect(reloadedDirector.snapshot().worldFacts[movedFactId]).toBe(true);
    const reloadedEngine = campEngine(runId, reloadedDirector.snapshot().worldFacts, true);
    expect(reloadedEngine.snapshot().movableObjects).toContainEqual({ objectId: movable.id, position: movable.to, phase: "settled" });
    expect(reloadedEngine.consumeWorldEvents().filter((event) => event.type === "object-moved")).toHaveLength(0);
    const replayed = await reloadedDirector.processEvent(movedEvent);
    expect(replayed.lastSafeCheckpoint?.progress.eventLog.filter((event) => event.type === "object-moved")).toHaveLength(1);
  });

  it("restores an in-flight legacy Koro object from its world-time start and emits movement once", () => {
    const runId = "movable-koro-v1-flight";
    const source = campEngine(runId, { [movedFactId]: false }, true);
    source.fixedStep(idle);
    expect(source.commandCompanion(koroMove)).toBe(true);
    for (let tick = 0; tick < 120 && source.snapshot().movableObjects.find(item => item.objectId === movable.id)?.phase === "resting"; tick++) source.fixedStep(idle);
    const legacy = JSON.parse(source.serialize()) as Record<string, unknown>;
    legacy.schemaVersion = 1;
    delete legacy.worldTick;
    delete legacy.worldTimeScale;
    delete legacy.timePolicy;
    delete legacy.slowMotionRemainingTicks;
    delete legacy.slowMotionElapsedTicks;
    const objects = legacy.movableObjects as Array<Record<string, unknown>>;
    const inFlight = objects.find((object) => object.objectId === movable.id)!;
    expect(inFlight.phase).toBe("in-flight");
    inFlight.startedAtTick = inFlight.startedAtWorldTick as number;
    delete inFlight.startedAtWorldTick;

    const restored = new CombatEngine();
    restored.restore(JSON.stringify(legacy));
    const migrated = JSON.parse(restored.serialize()) as { movableObjects: Array<Record<string, unknown>> };
    expect(migrated.movableObjects.find((object) => object.objectId === movable.id)).toMatchObject({ phase: "in-flight", startedAtWorldTick: source.snapshotState().worldTick });
    expect(advanceObjectFlight(restored)).toBe(movable.animationTicks);
    expect(restored.snapshot().movableObjects.find((object) => object.objectId === movable.id)).toMatchObject({ phase: "settled", position: movable.to });
    expect(restored.consumeWorldEvents().filter((event) => event.type === "object-moved")).toHaveLength(1);
    expect(restored.consumeWorldEvents().filter((event) => event.type === "object-moved")).toHaveLength(0);
  });

  it("uses Aren staff-heavy when Koro is absent and rejects a missed target without emitting movement", async () => {
    const runId = "movable-player-heavy";
    const director = await directorAtCamp(runId);
    const missedEngine = campEngine(runId, director.snapshot().worldFacts, false);
    expect(missedEngine.snapshot().actors.some((actor) => actor.id === "bamboo-koro")).toBe(false);
    expect(missedEngine.commandCompanion(koroMove)).toBe(false);
    expect(missedEngine.snapshot().movableObjects.find((item) => item.objectId === movable.id)).toMatchObject({ position: movable.from, phase: "resting" });
    expect(missedEngine.consumeWorldEvents().filter((event) => event.type === "object-moved")).toHaveLength(0);
    missedEngine.fixedStep({ ...idle, heavyPressed: true, heavyHeld: true, interactionId: movable.playerInteractionId, interactionTargetId: "wrong-object", interactTargetId: "wrong-object" as ActorId });
    missedEngine.fixedStep({ ...idle, heavyReleased: true, interactionId: movable.playerInteractionId, interactionTargetId: "wrong-object", interactTargetId: "wrong-object" as ActorId });
    expect(missedEngine.consumeWorldEvents().filter((event) => event.type === "object-moved")).toHaveLength(0);
    expect(missedEngine.snapshot().movableObjects.find((item) => item.objectId === movable.id)).toMatchObject({ position: movable.from, phase: "resting" });

    const pressReleaseHeavy = (source: CombatEngine, targetId: string) => {
      source.fixedStep({ ...idle, heavyPressed: true, heavyHeld: true, interactionId: movable.playerInteractionId, interactionTargetId: targetId, interactTargetId: targetId as ActorId });
      source.fixedStep({ ...idle, heavyReleased: true, interactionId: movable.playerInteractionId, interactionTargetId: targetId, interactTargetId: targetId as ActorId });
    };
    const noHitEngine = campEngine(runId + ":outside-heavy-range", director.snapshot().worldFacts, false, true, true);
    const farState = JSON.parse(noHitEngine.serialize()) as EngineState;
    farState.actors.find((actor) => actor.id === "aren")!.position = vec(movable.from.x - 7, movable.from.y, movable.from.z);
    noHitEngine.restore(JSON.stringify(farState));
    pressReleaseHeavy(noHitEngine, movable.id);
    for (let tick = 0; tick < 60; tick += 1) noHitEngine.fixedStep(idle);
    expect(noHitEngine.snapshot().movableObjects.find((item) => item.objectId === movable.id)).toMatchObject({ position: movable.from, phase: "resting" });
    expect(noHitEngine.consumeWorldEvents().filter((event) => event.type === "object-moved")).toHaveLength(0);

    const wrongFacingEngine = campEngine(runId + ":wrong-facing-heavy", director.snapshot().worldFacts, false, true, true);
    const wrongFacingState = JSON.parse(wrongFacingEngine.serialize()) as EngineState;
    wrongFacingState.actors.find((actor) => actor.id === "aren")!.facing = vec(0, 0, 1);
    wrongFacingEngine.restore(JSON.stringify(wrongFacingState));
    pressReleaseHeavy(wrongFacingEngine, movable.id);
    for (let tick = 0; tick < 60; tick += 1) wrongFacingEngine.fixedStep(idle);
    expect(wrongFacingEngine.snapshot().movableObjects.find((item) => item.objectId === movable.id)).toMatchObject({ position: movable.from, phase: "resting" });
    expect(wrongFacingEngine.consumeWorldEvents().filter((event) => event.type === "object-moved")).toHaveLength(0);
    const engine = campEngine(runId, director.snapshot().worldFacts, false, true, true, true, 2);
    expect(engine.snapshot().actors.some((actor) => actor.id === "bamboo-koro")).toBe(true);
    expect(engine.snapshotState().companionState.companionId).not.toBe("koro");
    const beforeMove = engine.snapshot();
    pressReleaseHeavy(engine, movable.id);
    expect(advanceObjectFlight(engine)).toBe(movable.animationTicks);
    const landed = engine.snapshot();
    expect(landed.movableObjects.find((item) => item.objectId === movable.id)).toMatchObject({ position: movable.to, phase: "settled" });
    expect(landed.player.vitality).toBe(beforeMove.player.vitality);
    expect(landed.actors.map((actor) => [actor.id, actor.vitality, actor.downed])).toEqual(
      beforeMove.actors.map((actor) => [actor.id, actor.vitality, actor.downed]),
    );
    const events = engine.consumeWorldEvents().filter((event) => event.type === "object-moved");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ objectId: movable.id, regionId: REGION_ID, interactionId: movable.playerInteractionId, actorId: "aren", from: movable.from, to: movable.to });
    expect(events[0]!.idempotencyKey.startsWith(runId + ":")).toBe(true);
    expect((await director.processEvent(events[0]!)).worldFacts[movedFactId]).toBe(true);
  });

  it("requires and resolves Aren's charged Heavy hit window on the authored object", () => {
    const runId = "movable-charged-heavy";
    const engine = campEngine(runId, { [movedFactId]: false }, false, true, true, false, 2);
    expect(engine.snapshot().actors.some((actor) => actor.id === "bamboo-koro")).toBe(false);
    const heavyInput = {
      ...idle,
      interactionId: movable.playerInteractionId,
      interactionTargetId: movable.id,
      interactTargetId: movable.id as ActorId,
    };
    engine.fixedStep({ ...heavyInput, heavyPressed: true, heavyHeld: true });
    for (let tick = 1; tick < THUNDER_CLEAVE.holdTicks; tick += 1) engine.fixedStep({ ...idle, heavyHeld: true });
    engine.fixedStep({ ...heavyInput, heavyReleased: true, heavyHeldTicks: THUNDER_CLEAVE.holdTicks });
    for (let tick = 1; tick < TARGETED_STRIKES.charged_heavy.activeAt; tick += 1) engine.fixedStep(idle);
    expect(engine.snapshot().movableObjects.find((item) => item.objectId === movable.id)).toMatchObject({ position: movable.from, phase: "resting" });
    expect(engine.consumeWorldEvents().filter((event) => event.type === "object-moved")).toHaveLength(0);
    engine.fixedStep(idle);
    expect(engine.snapshot().movableObjects.find((item) => item.objectId === movable.id)?.phase).toBe("in-flight");
    expect(advanceObjectFlight(engine)).toBe(movable.animationTicks);
    const events = engine.consumeWorldEvents().filter((event) => event.type === "object-moved");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ objectId: movable.id, actorId: "aren", interactionId: movable.playerInteractionId, from: movable.from, to: movable.to });
  });

  it("rejects swept object movement through a dynamic collision obstacle without mutating the object or event ledger", () => {
    const runId = "movable-collision-blocked";
    const engine = campEngine(runId, { [movedFactId]: false }, true, false);
    const state = JSON.parse(engine.serialize()) as EngineState;
    state.arena = {
      ...state.arena,
      obstacles: [...state.arena.obstacles, { minX: -22, maxX: -19, minZ: -26, maxZ: -23 }],
    };
    engine.restore(JSON.stringify(state));
    const resting = engine.snapshot().movableObjects.find((item) => item.objectId === movable.id)!;
    expect(resting).toMatchObject({ position: movable.from, phase: "resting" });
    engine.commandCompanion(koroMove);
    for (let tick = 0; tick < movable.animationTicks + 8; tick += 1) engine.fixedStep(idle);
    expect(engine.snapshot().movableObjects.find((item) => item.objectId === movable.id)).toEqual(resting);
    expect(engine.consumeWorldEvents().filter((event) => event.type === "object-moved")).toHaveLength(0);
    const occupiedEngine = campEngine(runId + ":occupied-actor", { [movedFactId]: false }, true, false);
    const occupiedState = JSON.parse(occupiedEngine.serialize()) as EngineState;
    const blocker = occupiedState.actors.find((actor) => actor.id === "hunter-melee-west")!;
    blocker.position = vec(-21, 0, -24.5);
    occupiedEngine.restore(JSON.stringify(occupiedState));
    const occupiedResting = occupiedEngine.snapshot().movableObjects.find((item) => item.objectId === movable.id)!;
    expect(occupiedEngine.commandCompanion(koroMove)).toBe(false);
    for (let tick = 0; tick < movable.animationTicks + 8; tick += 1) occupiedEngine.fixedStep(idle);
    expect(occupiedEngine.snapshot().movableObjects.find((item) => item.objectId === movable.id)).toEqual(occupiedResting);
    expect(occupiedEngine.consumeWorldEvents().filter((event) => event.type === "object-moved")).toHaveLength(0);
  });

  it("refuses an occupied sweep and does not interrupt a committed ranged telegraph", () => {
    const occupied = campEngine("movable-occupied-path", { [movedFactId]: false }, true, false);
    const occupiedState = JSON.parse(occupied.serialize()) as EngineState;
    const blocker = occupiedState.actors.find((actor) => actor.id === "hunter-melee-east")!;
    blocker.position = { x: -21, y: 0, z: -24.5 };
    const tokensBefore = occupiedState.companionState.tokens.available;
    occupied.restore(JSON.stringify(occupiedState));
    expect(occupied.commandCompanion(koroMove)).toBe(false);
    expect(occupied.snapshot().movableObjects).toContainEqual({ objectId: movable.id, position: movable.from, phase: "resting" });
    expect(occupied.snapshotState().companionState.tokens.available).toBe(tokensBefore);
    expect(occupied.consumeWorldEvents().filter((event) => event.type === "object-moved")).toHaveLength(0);

    const committed = campEngine("movable-committed-telegraph", { [movedFactId]: false }, true, false);
    const committedState = JSON.parse(committed.serialize()) as EngineState;
    const ranged = committedState.actors.find((actor) => actor.id === "hunter-ranged")!;
    committedState.telegraphs = [{ id: "hunter-ranged:poacher-scout-net:commit", attackId: "poacher-scout-net", sourceId: "hunter-ranged", targetPosition: { ...ranged.position }, phase: "commit", remainingTicks: 0, cue: "Net released." }];
    committed.restore(JSON.stringify(committedState));
    expect(committed.commandCompanion(koroMove)).toBe(true);
    expect(advanceObjectFlight(committed)).toBe(movable.animationTicks);
    const landed = committed.snapshotState();
    expect(committed.snapshot().movableObjects).toContainEqual({ objectId: movable.id, position: movable.to, phase: "settled" });
    expect(landed.counterUntil).toBe(0);
    expect(landed.actors.find((actor) => actor.id === "hunter-ranged")?.staggerUntil).toBe(0);
    expect(landed.events.some((event) => event.kind === "attack-interrupted")).toBe(false);
    expect(landed.worldEvents.filter((event) => event.type === "object-moved")).toHaveLength(1);
  });


  it("settles without opening a counter when hunter-ranged is already committed", () => {
    const runId = "movable-committed-attack";
    const engine = campEngine(runId, { [movedFactId]: false }, true);
    engine.fixedStep(idle);
    const state = JSON.parse(engine.serialize()) as EngineState;
    const telegraph = state.telegraphs.find((item) => item.sourceId === "hunter-ranged")!;
    const hazard = state.hazards.find((item) => item.id === telegraph.id)!;
    telegraph.phase = "commit";
    const recoveryTicks = hazard.recoveryUntil! - hazard.castUntil!;
    hazard.startTick = state.tick - 100;
    hazard.activeFrom = state.tick + 100;
    hazard.activeUntil = state.tick + 110;
    hazard.windupUntil = state.worldTick - 1;
    hazard.castUntil = hazard.activeUntil;
    hazard.recoveryUntil = hazard.castUntil + recoveryTicks;
    engine.restore(JSON.stringify(state));
    const before = engine.snapshotState();
    expect(engine.commandCompanion(koroMove)).toBe(true);
    expect(advanceObjectFlight(engine)).toBe(movable.animationTicks);
    const after = engine.snapshotState();
    expect(engine.snapshot().movableObjects.find((item) => item.objectId === movable.id)).toMatchObject({ position: movable.to, phase: "settled" });
    expect(after.counterUntil).toBe(before.counterUntil);
    expect(after.actors.find((actor) => actor.id === "hunter-ranged")!.staggerUntil).toBe(before.actors.find((actor) => actor.id === "hunter-ranged")!.staggerUntil);
    expect(after.telegraphs.some((item) => item.sourceId === "hunter-ranged" && item.phase === "commit")).toBe(true);
    expect(after.events.filter((item) => item.kind === "attack-interrupted" && item.targetId === "hunter-ranged")).toHaveLength(0);
    expect(engine.consumeWorldEvents().filter((event) => event.type === "object-moved")).toHaveLength(1);
  });

  it("rejects forged moves and rolls back failed commits while retaining one staged event for exact retry", async () => {
    const runId = "movable-director-guards";
    const director = await directorAtCamp(runId, "koro");
    const valid = moveEvent(runId, "bamboo-koro", movable.koroInteractionId);
    for (const invalid of [
      { ...valid, eventId: runId + ":wrong-actor", idempotencyKey: runId + ":wrong-actor", actorId: "hunter-ranged" },
      { ...valid, eventId: runId + ":wrong-from", idempotencyKey: runId + ":wrong-from", from: { ...movable.from, x: movable.from.x + 0.1 } },
      { ...valid, eventId: runId + ":wrong-to", idempotencyKey: runId + ":wrong-to", to: { ...movable.to, y: movable.to.y + 1 } },
      { ...valid, eventId: runId + ":wrong-interaction", idempotencyKey: runId + ":wrong-interaction", interactionId: "camp-disable" },
    ]) {
      const prior = director.snapshot();
      await expect(director.processEvent(invalid)).rejects.toThrow();
      expect(director.snapshot()).toEqual(prior);
    }
    expect(director.snapshot().worldFacts[movedFactId]).toBe(false);

    const committed = await director.processEvent(valid);
    expect(committed.worldFacts[movedFactId]).toBe(true);
    expect(await director.processEvent(valid)).toEqual(committed);
    const duplicate = { ...valid, eventId: runId + ":second-move", idempotencyKey: runId + ":second-move" };
    const beforeDuplicate = director.snapshot();
    await expect(director.processEvent(duplicate)).rejects.toThrow();
    expect(director.snapshot()).toEqual(beforeDuplicate);

    const noKoroRunId = "movable-director-no-koro";
    const noKoroDirector = await directorAtCamp(noKoroRunId);
    const noKoroBefore = noKoroDirector.snapshot();
    await expect(noKoroDirector.processEvent(moveEvent(noKoroRunId, "bamboo-koro", movable.koroInteractionId))).rejects.toThrow();
    expect(noKoroDirector.snapshot()).toEqual(noKoroBefore);
    const playerRunId = "movable-director-player-fallback";
    const playerDirector = await directorAtCamp(playerRunId);
    expect((await playerDirector.processEvent(moveEvent(playerRunId, "aren", movable.playerInteractionId))).worldFacts[movedFactId]).toBe(true);

    const failedRunId = "movable-director-rollback";
    class FailingOnceRepository extends SaveRepository {
      armed = false;
      private failedOnce = false;
      override async saveAutosave(_checkpoint: CheckpointSnapshot, campaign: CampaignState, chapter: number, regionId: RegionId): Promise<SaveSlotSummary> {
        if (this.armed && !this.failedOnce) {
          this.failedOnce = true;
          throw new SaveRepositoryError("transaction", "Injected autosave transaction failure.");
        }
        return { slotId: "autosave:" + campaign.runId, label: "Autosave", runId: campaign.runId, kind: "campaign", updatedAt: 1, chapter, regionId,
          scope: "production", heroId: "aren", segmentId: null, checkpointId: null, autosave: true };
      }
    }
    const failingRepository = new FailingOnceRepository();
    const failingDirector = await directorAtCamp(failedRunId, "koro", failingRepository);
    failingRepository.armed = true;
    const lastCommittedCheckpoint = await failingDirector.captureCheckpoint();
    const beforeFailure = failingDirector.snapshot();
    const pendingEngine = campEngine(failedRunId, beforeFailure.worldFacts, true);
    pendingEngine.fixedStep(idle);
    holdRangedWindup(pendingEngine);
    expect(pendingEngine.snapshot().telegraphs.some((item) => item.sourceId === "hunter-ranged" && item.phase === "windup")).toBe(true);
    expect(pendingEngine.commandCompanion(koroMove)).toBe(true);
    expect(advanceObjectFlight(pendingEngine)).toBe(movable.animationTicks);
    expect(pendingEngine.snapshot().movableObjects.find((item) => item.objectId === movable.id)).toMatchObject({ position: movable.to, phase: "settled" });
    const pendingEvents = pendingEngine.consumeWorldEvents().filter((event) => event.type === "object-moved");
    expect(pendingEvents).toHaveLength(1);
    const pendingEvent = pendingEvents[0]!;
    const pendingBytes = JSON.stringify(pendingEvent);
    const stagedEngineTick = pendingEngine.simulationTick;
    const stagedCounterUntil = pendingEngine.snapshotState().counterUntil;
    const stagedStaggerUntil = pendingEngine.snapshotState().actors.find((actor) => actor.id === "hunter-ranged")!.staggerUntil;
    await expect(failingDirector.processEvent(pendingEvent)).rejects.toBeInstanceOf(SaveRepositoryError);
    expect(failingDirector.snapshot()).toEqual(beforeFailure);
    expect(failingDirector.snapshot().worldFacts[movedFactId]).toBe(false);
    expect(pendingEngine.simulationTick).toBe(stagedEngineTick);
    expect(pendingEngine.snapshotState().movableObjects.find((item) => item.objectId === movable.id)).toMatchObject({ position: movable.to, phase: "settled" });
    expect(pendingEngine.snapshotState().counterUntil).toBe(stagedCounterUntil);
    expect(pendingEngine.snapshotState().actors.find((actor) => actor.id === "hunter-ranged")!.staggerUntil).toBe(stagedStaggerUntil);

    const reloadBeforeCommit = new CampaignDirector({ runId: failedRunId });
    expect(await reloadBeforeCommit.restoreCheckpoint(lastCommittedCheckpoint)).toBe(true);
    expect(reloadBeforeCommit.snapshot().worldFacts[movedFactId]).toBe(false);
    const reloadEngine = campEngine(failedRunId, reloadBeforeCommit.snapshot().worldFacts, true);
    expect(reloadEngine.snapshot().movableObjects.find((item) => item.objectId === movable.id)).toMatchObject({ position: movable.from, phase: "resting" });
    expect(reloadEngine.consumeWorldEvents().filter((event) => event.type === "object-moved")).toHaveLength(0);

    const retryEvent = JSON.parse(pendingBytes) as typeof pendingEvent;
    expect(JSON.stringify(retryEvent)).toBe(pendingBytes);
    const firstImpactEvents = pendingEngine.consumeEvents().filter((event) => event.kind === "attack-interrupted");
    expect(firstImpactEvents.map((event) => event.targetId)).toEqual(["hunter-ranged"]);
    const retried = await failingDirector.processEvent(retryEvent);
    expect(retried.worldFacts[movedFactId]).toBe(true);
    expect(retried.lastSafeCheckpoint?.progress.eventLog.filter((event) => event.type === "object-moved")).toHaveLength(1);
    expect(await failingDirector.processEvent(retryEvent)).toEqual(retried);
    expect(pendingEngine.simulationTick).toBe(stagedEngineTick);
    expect(pendingEngine.snapshotState().counterUntil).toBe(stagedCounterUntil);
    expect(pendingEngine.snapshotState().actors.find((actor) => actor.id === "hunter-ranged")!.staggerUntil).toBe(stagedStaggerUntil);
    expect(pendingEngine.snapshotState().telegraphs.some((item) => item.sourceId === "hunter-ranged")).toBe(false);
    expect(pendingEngine.snapshotState().hazards.some((item) => item.sourceId === "hunter-ranged" && pendingEngine.simulationTick < item.activeUntil)).toBe(false);
    expect(pendingEngine.snapshotState().rewardEmitted).toBe(false);
    expect(pendingEngine.commandCompanion(koroMove)).toBe(false);
    expect(pendingEngine.consumeEvents().filter((event) => event.kind === "attack-interrupted")).toHaveLength(0);
    expect(pendingEngine.consumeWorldEvents().filter((event) => event.type === "object-moved")).toHaveLength(0);
  });

  it("defaults the moved fact to false when reloading a pre-feature checkpoint", async () => {
    const runId = "movable-legacy-checkpoint";
    const original = new CampaignDirector({ runId });
    const saved = await original.captureCheckpoint();
    const progress = { ...saved.progress, worldFacts: { ...saved.progress.worldFacts } };
    delete progress.worldFacts[movedFactId];
    const reloaded = new CampaignDirector({ runId });
    expect(await reloaded.restoreCheckpoint({ ...saved, progress })).toBe(true);
    expect(reloaded.snapshot().worldFacts[movedFactId]).toBe(false);
    const engine = campEngine(runId, reloaded.snapshot().worldFacts, false);
    expect(engine.snapshot().movableObjects).toContainEqual({ objectId: movable.id, position: movable.from, phase: "resting" });
  });
});
