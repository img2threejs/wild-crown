import { expect, it } from "bun:test";
import { Vector3 } from "three";
import { ENVIRONMENT_RECIPES, REGIONS } from "../../src/content/campaign.js";
import { GameApplication } from "../../src/app/GameApplication.js";
import { CampaignDirector } from "../../src/game/campaign/CampaignDirector.js";
import { CombatEngine } from "../../src/game/combat/CombatEngine.js";
import { SaveRepository } from "../../src/game/storage/SaveRepository.js";
import { FACTION_IDS, REGION_IDS, REGIONAL_OBLIGATION_IDS } from "../../packages/campaign/src/index.js";
import { NativeAssetError } from "../../src/rendering/NativeAssetLoader.js";
import type { AssetManifestEntry, CampaignSnapshot, UIAction, WorldEvent } from "../../src/game/contracts.js";

const movedFactId = "objectMoved:camp-loose-snare";
const event = {
  type: "object-moved",
  eventId: "run-app-test:object-moved:camp-loose-snare",
  idempotencyKey: "run-app-test:object-moved:camp-loose-snare",
  regionId: "blood-bamboo-valley",
  objectId: "camp-loose-snare",
  interactionId: "koro-drop-object",
  actorId: "bamboo-koro",
  from: { x: -2, y: 0, z: 9 },
  to: { x: -2, y: 0, z: 5 },
} satisfies WorldEvent;

function snapshot(moved: boolean): CampaignSnapshot {
  return {
    regionId: "blood-bamboo-valley",
    ending: null,
    worldFacts: { [movedFactId]: moved },
  } as unknown as CampaignSnapshot;
}

function headlessApp(): Record<string, any> {
  const app = Object.create(GameApplication.prototype) as Record<string, any>;
  app.disposed = false;
  app.lifecycleGeneration = 0;
  app.worldGeneration = 0;
  app.campaign = snapshot(false);
  app.campaignDirector = {};
  app.timePolicies = [] as string[];
  app.combat = { commandCompanionCalls: 0, stepCalls: 0, setTimePolicy: (policy: string) => { app.timePolicies.push(policy); } };
  app.pendingWorldEvents = [event];
  app.failedWorldEvent = null;
  app.durableEvents = Promise.resolve();
  app.sceneBlocked = false;
  app.screen = "game";
  app.loading = { active: false, label: "", progress: null };
  app.error = null;
  app.pendingInteraction = null;
  app.pendingAbility = null;
  app.render = () => {};
  app.input = { clear: () => {}, setEnabled: () => {} };
  app.isWorldGenerationCurrent = () => true;
  app.syncStoryState = () => {};
  app.syncWorldFacts = () => {};
  app.startOrunEncounterIfReady = async () => {};
  return app;
}

it("blocks gameplay and saves while a durable move is pending, then retries the same event and resumes", async () => {
  const app = headlessApp();
  app.worldFactSyncCalls = 0;
  app.syncWorldFacts = () => { app.worldFactSyncCalls++; };
  const committed = snapshot(true);
  const attempts: WorldEvent[] = [];
  let failOnce = true;
  let saveCalls = 0;
  app.campaignDirector = {
    snapshot: () => snapshot(false),
    processEvent: async (received: WorldEvent) => {
      attempts.push(received);
      if (failOnce) {
        failOnce = false;
        throw new Error("injected run-ledger rejection");
      }
      return committed;
    },
    save: async () => { saveCalls++; },
    saveNewSlot: async () => { saveCalls++; },
    exportSave: async () => { saveCalls++; return ""; },
  };

  const serializedEvent = JSON.stringify(event);
  await app.flushWorldEvents();

  expect(app.screen).toBe("loading");
  expect(app.loading.operationId).toBe("durable-event");
  expect(app.failedWorldEvent).toBe(event);
  expect(app.pendingWorldEvents).toEqual([event]);
  expect(app.campaign.worldFacts[movedFactId]).toBe(false);
  expect(app.worldFactSyncCalls).toBe(0);

  const blockedActions: UIAction[] = [
    { type: "pause" },
    { type: "open-map" },
    { type: "interact", interactionId: "player-drop-object", targetId: "camp-loose-snare" },
    { type: "save", slotId: "slot-1", label: "Unsafe save" },
    { type: "create-save-slot", label: "Unsafe save" },
    { type: "import", payload: "unsafe import" },
    { type: "choose", choiceId: "choice", optionId: "option" },
  ];
  for (const action of blockedActions) await app.dispatch(action);

  expect(app.screen).toBe("loading");
  expect(app.pendingWorldEvents).toEqual([event]);
  expect(saveCalls).toBe(0);
  expect(app.combat.commandCompanionCalls).toBe(0);
  expect(app.combat.stepCalls).toBe(0);

  await app.dispatch({ type: "retry-load", operationId: "durable-event" });

  expect(attempts).toHaveLength(2);
  expect(attempts[0]).toBe(event);
  expect(attempts[1]).toBe(event);
  expect(JSON.stringify(attempts[1])).toBe(serializedEvent);
  expect(app.pendingWorldEvents).toEqual([]);
  expect(app.failedWorldEvent).toBeNull();
  expect(app.campaign.worldFacts[movedFactId]).toBe(true);
  expect(app.worldFactSyncCalls).toBe(1);
  expect(app.screen).toBe("game");
  expect(app.loading.active).toBe(false);
  expect(saveCalls).toBe(0);
  expect(app.combat.commandCompanionCalls).toBe(0);
  expect(app.combat.stepCalls).toBe(0);
  expect(app.timePolicies).toEqual(["paused", "normal"]);
});

it("marks blocked asset evidence and invalid manifests terminal while keeping transient requests retryable", async () => {
  const app = headlessApp();
  const region = REGIONS.find(item => item.id === "greenwake")!;
  const recipe = ENVIRONMENT_RECIPES.find(item => item.id === region.environmentRecipeId)!;
  const components = [...new Set(region.props.map(prop => prop.assetId))];
  const blockedRecipe = {
    id: recipe.id,
    sourceType: "composed-recipe",
    kind: "environment",
    evidenceStatus: "blocked",
    componentAssetIds: components,
  } as unknown as AssetManifestEntry;
  let blockedError: unknown;
  try { app.assertAssets(region, [blockedRecipe]); }
  catch (error) { blockedError = error; }
  expect(blockedError).toBeInstanceOf(Error);
  app.showWorldError(blockedError, "region-load");
  expect(app.error).toMatchObject({ code: "asset-unavailable", recoverable: false });
  await app.dispatch({ type: "retry-load", operationId: "region-load" });
  expect(app.error).toMatchObject({ code: "asset-unavailable", recoverable: false });

  const transient = headlessApp();
  transient.showWorldError(new NativeAssetError("greenwake-environment", "GLB request failed with HTTP 503"), "region-load");
  expect(transient.error).toMatchObject({ recoverable: true });

  const missingAsset = headlessApp();
  missingAsset.showWorldError(new NativeAssetError("greenwake-environment", "GLB request failed with HTTP 404"), "region-load");
  expect(missingAsset.error).toMatchObject({ code: "asset-unavailable", recoverable: false });

  const aborted = headlessApp();
  aborted.showWorldError(new DOMException("aborted", "AbortError"), "region-load");
  expect(aborted.error).toMatchObject({ recoverable: true });

  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response("{\"invalid\":true}", { status: 200 })) as typeof fetch;
    let schemaError: unknown;
    try { await app.readManifest(); }
    catch (error) { schemaError = error; }
    app.showWorldError(schemaError, "region-load");
    expect(app.error).toMatchObject({ code: "asset-unavailable", recoverable: false });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const hashMismatch = headlessApp();
  hashMismatch.showWorldError(new NativeAssetError("actor-aren", "runtime GLB SHA-256 mismatch"), "region-load");
  expect(hashMismatch.error).toMatchObject({ code: "asset-unavailable", recoverable: false });


  const recovery = headlessApp();
  const validSlots = [{ slotId: "valid-save" }];
  recovery.slots = validSlots;
  recovery.region = REGIONS.find(item => item.id === "greenwake");
  recovery.activeRunId = "unsaved-run";
  recovery.pendingWorldEvents = [event];
  recovery.failedWorldEvent = event;
  recovery.showWorldError(blockedError, "region-load");
  await recovery.dispatch({ type: "return-title" });
  expect(recovery.screen).toBe("title");
  expect(recovery.campaign).toBeNull();
  expect(recovery.region).toBeNull();
  expect(recovery.activeRunId).toBeNull();
  expect(recovery.pendingWorldEvents).toEqual([]);
  expect(recovery.failedWorldEvent).toBeNull();
  expect(recovery.slots).toBe(validSlots);
  expect(recovery.error).toBeNull();
});

it("blocks a new game on real asset evidence and returns to valid title/load/settings recovery", async () => {
  const app = headlessApp();
  const region = REGIONS.find(item => item.id === "greenwake")!;
  const recipe = ENVIRONMENT_RECIPES.find(item => item.id === region.environmentRecipeId)!;
  const blockedRecipe = {
    id: recipe.id,
    sourceType: "composed-recipe",
    kind: "environment",
    evidenceStatus: "blocked",
    componentAssetIds: [...new Set(region.props.map(prop => prop.assetId))],
  } as unknown as AssetManifestEntry;
  const validSlots = [{ slotId: "valid-save" }];
  let current = { ...snapshot(false), regionId: "greenwake", runId: "failed-new-run" } as unknown as CampaignSnapshot;
  let loadCalls = 0;
  app.ready = true;
  app.slots = validSlots;
  app.renderer = null;
  app.combat.loadRegionCalls = 0;
  app.combat.loadRegion = () => { app.combat.loadRegionCalls++; };
  app.readManifest = async () => [blockedRecipe];
  app.campaignDirector = {
    startNewRun: (runId: string) => { current = { ...current, runId }; return current; },
    snapshot: () => current,
    load: async () => { loadCalls++; current = { ...snapshot(false), regionId: "greenwake", runId: "saved-run" } as unknown as CampaignSnapshot; return current; },
  };

  await app.dispatch({ type: "new-game", runId: "failed-new-run" });
  expect(app.screen).toBe("loading");
  expect(app.error).toMatchObject({ code: "asset-unavailable", recoverable: false });
  expect(app.loading.operationId).toBe("region-load");
  expect(app.renderer).toBeNull();
  expect(app.combat.loadRegionCalls).toBe(0);

  await app.dispatch({ type: "return-title" });
  expect(app.screen).toBe("title");
  expect(app.campaign).toBeNull();
  expect(app.slots).toBe(validSlots);
  await app.dispatch({ type: "open-settings" });
  expect(app.screen).toBe("settings");
  await app.dispatch({ type: "close-screen" });
  expect(app.screen).toBe("title");

  await app.dispatch({ type: "load", slotId: "valid-save" });
  expect(loadCalls).toBe(1);
  expect(app.screen).toBe("loading");
  expect(app.error).toMatchObject({ code: "asset-unavailable", recoverable: false });
  expect(app.renderer).toBeNull();
  expect(app.combat.loadRegionCalls).toBe(0);
});

it("pauses the combat world for every blocking screen and restores normal time only on gameplay", () => {
  const app = headlessApp();
  const policies: string[] = app.timePolicies;
  for (const screen of ["pause", "map", "journal", "companions", "settings", "dialogue", "choice", "loading", "title", "credits", "ending"]) {
    app.setScreen(screen);
  }
  expect(policies).toEqual(Array(11).fill("paused"));
  app.setScreen("game");
  expect(policies.at(-1)).toBe("normal");
});

async function finalChoiceApp(eligible: boolean, saves?: SaveRepository, orunResolved = true): Promise<Record<string, any>> {
  const app = headlessApp();
  const inputBasis = { forward: new Vector3(0, 0, -1), right: new Vector3(1, 0, 0) };
  app.renderer = { dispose: () => {}, getInputBasis: () => inputBasis };
  const director = new CampaignDirector({ runId: "app-final-choice", saves });
  const checkpoint = await director.captureCheckpoint();
  const region = REGIONS.find(item => item.id === "heartroot-hollow")!;
  const position = region.entities.find(entity => entity.interactionId === "hollow-crown-choice")!.position;
  checkpoint.progress.chapter = 8;
  checkpoint.progress.regionId = region.id;
  checkpoint.progress.worldFacts = { ...checkpoint.progress.worldFacts, chapter: 8 };
  checkpoint.safeSpawn = { regionId: region.id, position, routeId: region.navigation.nodes[0]!.id,
    cameraAnchorId: region.cameraAnchors[0]!.id };
  if (eligible) {
    const world = checkpoint.worldCheckpoint.world;
    for (const faction of FACTION_IDS) {
      world.factions[faction].bondTier = 3;
      world.factions[faction].representative.present = true;
      world.factions[faction].representative.willing = true;
      world.renewedCommitments[faction] = true;
    }
    for (const id of REGION_IDS) world.regions[id] = "restored";
    for (const id of REGIONAL_OBLIGATION_IDS) world.regionalObligations[id] = true;
    world.hollowReady = true;
  }
  expect(await director.restoreCheckpoint(checkpoint)).toBe(true);
  if (orunResolved) await director.processEvent({
    type: "encounter-resolved", eventId: "app-orun-cleansed", idempotencyKey: "app-orun-cleansed",
    encounterId: "encounter-orun", actorIds: ["orun"], resolution: "cleansed",
  });
  app.campaignDirector = director;
  app.campaign = director.snapshot();
  app.region = region;
  app.pendingWorldEvents = [];
  app.combat = new CombatEngine();
  app.combat.loadRegion({ regionId: region.id, runId: app.campaign.runId,
    presentActorIds: [], playerPosition: position, worldFacts: app.campaign.worldFacts });
  app.ready = true;
  app.activeCompanionSlots = {};
  app.wheel = { hidden: true };
  app.input.sample = () => ({
    moveX: 0, moveZ: 0, dodgePressed: false, lightPressed: false, heavyPressed: false,
    heavyHeld: false, heavyReleased: false, interactPressed: true, abilityPressed: false,
    commandWheelPressed: false, commandWheelHeld: false, mapPressed: false, journalPressed: false,
    companionsPressed: false, pausePressed: false, commandIndex: null,
  });
  return app;
}

it("keeps the Crown memory actionable before Orun is cleansed without opening the ending choice", async () => {
  const app = await finalChoiceApp(false, undefined, false);
  const memory = app.region.entities.find((entity: { interactionId?: string }) => entity.interactionId === "hollow-memory-crown")!;
  app.combat.loadRegion({ regionId: app.region.id, runId: app.campaign.runId,
    presentActorIds: [], playerPosition: memory.position, worldFacts: app.campaign.worldFacts });
  expect(app.campaign.worldFacts["orun-cleansed"]).not.toBe(true);
  expect(app.combat.resolveInteraction("hollow-crown-choice", "hollow-crown-choice", "severance")).toBe(false);
  expect(app.combat.consumeWorldEvents()).toEqual([]);

  app.simulateTick();
  await app.durableEvents;
  expect(app.screen).toBe("game");
  expect(app.choice).toBeUndefined();
  expect(app.interaction).toMatchObject({ interactionId: "hollow-memory-crown", targetId: "hollow-memory-crown" });
  expect(app.campaign.worldFacts["interaction:hollow-memory-crown"]).toBe(true);
  expect(app.campaign.lastEvent).toMatchObject({
    type: "semantic-interaction", interactionId: "hollow-memory-crown", kind: "inspect", targetId: "hollow-memory-crown",
  });
  expect(app.campaign.ending).toBeNull();
});

it("filters an ineligible Living Pact and consumes a stale rejection without wedging the actual app or engine", async () => {
  const app = await finalChoiceApp(false);
  const before = app.campaignDirector.snapshot();
  expect(app.campaign.worldFacts["orun-cleansed"]).toBe(true);
  app.simulateTick();
  expect(app.screen).toBe("choice");
  expect(app.interaction).toMatchObject({ interactionId: "hollow-crown-choice", targetId: "hollow-crown-choice" });
  expect(app.choice.options.map((option: { id: string }) => option.id)).toEqual(["dominion", "severance"]);

  // A stale/selectable payload still reaches the real contextual producer and consumer.
  await app.dispatch({ type: "choose", choiceId: "final-ending", optionId: "living_pact" });
  await app.durableEvents;
  expect(app.campaignDirector.snapshot()).toEqual(before);
  expect(app.campaign).toEqual(before);
  expect(app.failedWorldEvent).toBeNull();
  expect(app.pendingWorldEvents).toEqual([]);
  expect(app.error).toBeNull();
  expect(app.loading.active).toBe(false);
  expect(app.loading.operationId).not.toBe("durable-event");
  expect(app.screen).toBe("game");
  expect(app.combat.snapshot().worldClock.policy).toBe("normal");

  // The same engine's speculative key is released, not a region-reload escape hatch.
  app.simulateTick();
  await app.dispatch({ type: "choose", choiceId: "final-ending", optionId: "severance" });
  await app.durableEvents;
  expect(app.campaign.ending).toBe("severance");
  expect(app.screen).toBe("ending");
  expect(app.failedWorldEvent).toBeNull();
  const accepted = app.campaign.lastEvent as Extract<WorldEvent, { type: "choice" }>;
  expect(app.campaignDirector.isEventCommitted(accepted.idempotencyKey)).toBe(true);

  // A conflicting queued payload sharing a committed key must not release that key.
  app.pendingWorldEvents = [{ ...accepted, optionId: "living_pact" }];
  await app.flushWorldEvents();
  expect(app.pendingWorldEvents).toEqual([]);
  expect(app.failedWorldEvent).toBeNull();
  expect(app.campaign.ending).toBe("severance");
  expect(app.combat.resolveInteraction("hollow-crown-choice", "hollow-crown-choice", "dominion")).toBe(false);
});

it("advertises and commits eligible Living Pact through the actual choice UI and event consumer", async () => {
  const app = await finalChoiceApp(true);
  expect(app.campaignDirector.ending().available).toBe(true);
  expect(app.campaign.worldFacts["orun-cleansed"]).toBe(true);
  app.simulateTick();
  expect(app.screen).toBe("choice");
  expect(app.interaction).toMatchObject({ interactionId: "hollow-crown-choice", targetId: "hollow-crown-choice" });
  expect(app.choice.options.map((option: { id: string }) => option.id)).toEqual(["dominion", "severance", "living_pact"]);
  await app.dispatch({ type: "choose", choiceId: "final-ending", optionId: "living_pact" });
  await app.durableEvents;
  expect(app.campaign.ending).toBe("living_pact");
  expect(app.campaign.worldFacts.circleOfTheWild).toBe(true);
  expect(app.screen).toBe("ending");
  expect(app.ending.id).toBe("living_pact");
  expect(app.failedWorldEvent).toBeNull();
  expect(app.pendingWorldEvents).toEqual([]);
});

class RefusingChoiceLedger extends SaveRepository {
  fail = false;
  override async appendRunLedger(): Promise<void> {
    if (this.fail) throw new Error("injected choice persistence failure");
  }
}

it("retains a speculative choice key and the durable retry path for a persistence failure", async () => {
  const saves = new RefusingChoiceLedger(undefined);
  const app = await finalChoiceApp(false, saves);
  saves.fail = true;
  await app.dispatch({ type: "choose", choiceId: "final-ending", optionId: "severance" });
  await app.durableEvents;
  expect(app.failedWorldEvent?.type).toBe("choice");
  expect(app.loading.operationId).toBe("durable-event");
  expect(app.screen).toBe("loading");
  expect(app.combat.snapshot().worldClock.policy).toBe("paused");
  expect(app.campaignDirector.isEventCommitted(app.failedWorldEvent.idempotencyKey)).toBe(false);
  expect(app.combat.resolveInteraction("hollow-crown-choice", "hollow-crown-choice", "dominion")).toBe(false);
  saves.fail = false;
  await app.dispatch({ type: "retry-load", operationId: "durable-event" });
  expect(app.failedWorldEvent).toBeNull();
  expect(app.pendingWorldEvents).toEqual([]);
  expect(app.campaign.ending).toBe("severance");
  expect(app.screen).toBe("ending");
});
