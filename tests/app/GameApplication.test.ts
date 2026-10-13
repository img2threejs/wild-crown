import { expect, it } from "bun:test";
import { Vector3 } from "three";
import { ENVIRONMENT_RECIPES, REGIONS } from "../../src/content/campaign.js";
import { GameApplication } from "../../src/app/GameApplication.js";
import { CampaignDirector } from "../../src/game/campaign/CampaignDirector.js";
import { CombatEngine } from "../../src/game/combat/CombatEngine.js";
import { DIALOGUE } from "../../src/content/dialogue.js";
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
  app.screenHistory = [];
  app.worldReady = true;
  app.renderer = { dispose: () => {} };
  app.presentation = null;
  app.companionPreviews = new Map();
  app.damageNumbers = { consume: () => {}, update: () => {}, clear: () => {}, dispose: () => {}, element: { hidden: true } };
  app.monsterLabels = { clear: () => {}, dispose: () => {}, element: { hidden: true } };
  app.region = REGIONS.find(item => item.id === "blood-bamboo-valley");
  app.campaign = snapshot(false);
  app.campaignDirector = {};
  app.timePolicies = [] as string[];
  app.combat = {
    commandCompanionCalls: 0, stepCalls: 0, startNewRunCalls: [] as string[],
    startNewRun: (runId: string) => { app.combat.startNewRunCalls.push(runId); },
    setTimePolicy: (policy: string) => { app.timePolicies.push(policy); },
  };
  app.pendingWorldEvents = [event];
  app.failedWorldEvent = null;
  app.durableEvents = Promise.resolve();
  app.sceneBlocked = false;
  app.pendingNarrativeCues = [];
  app.lastCueSnapshot = null;
  app.loadingFromSave = false;
  app.dialogue = null;
  app.dialogueLineIndex = 0;
  app.screen = "game";
  app.loading = { active: false, label: "", progress: null };
  app.error = null;
  app.pendingInteraction = null;
  app.pendingAbility = null;
  app.render = () => {};
  app.input = { clear: () => {}, setEnabled: () => {} };
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
  try { app.assertAssets(region, [blockedRecipe], recipe); }
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
  expect(app.combat.startNewRunCalls).toEqual(["failed-new-run"]);
  expect(app.error).toMatchObject({ code: "asset-unavailable", recoverable: false });
  expect(app.loading.operationId).toBe("region-load");
  expect(app.renderer).toBeNull();
  expect(app.combat.loadRegionCalls).toBe(0);

  for (const action of [{ type: "close-screen" }, { type: "open-settings" }, { type: "close-screen" }, { type: "close-screen" }] satisfies UIAction[]) {
    await app.dispatch(action);
    expect(app.screen).not.toBe("game");
    expect(app.error).toMatchObject({ code: "asset-unavailable", recoverable: false });
  }
  expect(app.screen).toBe("loading");
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
  app.worldReady = true;
  app.error = null;
  app.screenHistory.length = 0;
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
it("keeps root title and error screens stable while closing nested menus to their exact opening screen", async () => {
  const app = headlessApp();
  app.screen = "title";
  app.campaign = null;
  app.region = null;
  app.renderer = null;
  app.worldReady = false;
  await app.dispatch({ type: "close-screen" });
  expect(app.screen).toBe("title");
  await app.dispatch({ type: "open-settings" });
  for (const action of [{ type: "open-map" }, { type: "open-journal" }, { type: "open-companions" }, { type: "pause" }] satisfies UIAction[]) {
    await app.dispatch(action);
    expect(app.screen).toBe("settings");
    expect(app.screenHistory).toEqual(["title"]);
  }
  for (const screen of ["dialogue", "choice", "ending"]) {
    app.setScreen(screen);
    expect(app.screen).toBe("settings");
    expect(app.screenHistory).toEqual(["title"]);
  }
  await app.dispatch({ type: "close-screen" });
  expect(app.screen).toBe("title");
  await app.dispatch({ type: "resume" });
  expect(app.screen).toBe("title");

  app.showWorldError(new NativeAssetError("greenwake-environment", "GLB request failed with HTTP 404"), "region-load");
  const error = app.error;
  await app.dispatch({ type: "close-screen" });
  expect(app.screen).toBe("loading");
  await app.dispatch({ type: "open-settings" });
  for (const action of [{ type: "open-map" }, { type: "open-journal" }, { type: "open-companions" }, { type: "pause" }] satisfies UIAction[]) {
    await app.dispatch(action);
    expect(app.screen).toBe("settings");
    expect(app.screenHistory).toEqual(["loading"]);
    expect(app.error).toBe(error);
  }
  await app.dispatch({ type: "close-screen" });
  expect(app.screen).toBe("loading");
  expect(app.error).toBe(error);
  await app.dispatch({ type: "resume" });
  expect(app.screen).toBe("loading");
  expect(app.error).toBe(error);
});

it("keeps world navigation available from Settings only while its initialized world remains usable", async () => {
  const app = headlessApp();
  await app.dispatch({ type: "open-settings" });
  for (const [type, screen] of [["open-map", "map"], ["open-journal", "journal"], ["open-companions", "companions"]] as const) {
    await app.dispatch({ type });
    expect(app.screen).toBe(screen);
    await app.dispatch({ type: "close-screen" });
    expect(app.screen).toBe("settings");
    expect(app.screenHistory).toEqual(["game"]);
  }
  app.error = { code: "asset-unavailable", message: "Required world asset is unavailable", recoverable: false };
  await app.dispatch({ type: "open-map" });
  expect(app.screen).toBe("settings");
  expect(app.screenHistory).toEqual(["game"]);
});

it("returns Settings to Pause and only resumes a ready world, with no stale menu path after title recovery", async () => {
  const app = headlessApp();
  app.ready = true;
  await app.dispatch({ type: "pause" });
  await app.dispatch({ type: "open-settings" });
  await app.dispatch({ type: "close-screen" });
  expect(app.screen).toBe("pause");
  await app.dispatch({ type: "resume" });
  expect(app.screen).toBe("game");
  await app.dispatch({ type: "return-title" });
  expect(app.worldReady).toBe(false);
  expect(app.renderer).toBeNull();
  expect(app.region).toBeNull();
  await app.dispatch({ type: "close-screen" });
  expect(app.screen).toBe("title");
});

it("keeps resumed or asynchronously prepared gameplay paused until a suspended page is restored", async () => {
  const app = headlessApp();
  app.ready = true;
  app.suspended = true;
  app.screen = "pause";
  await app.dispatch({ type: "resume" });
  expect(app.screen).toBe("pause");
  expect(app.timePolicies.at(-1)).toBe("paused");

  const enabled: boolean[] = [];
  app.input.setEnabled = (value: boolean) => enabled.push(value);
  app.ui = { render: () => {} };
  app.model = () => ({});
  app.render = (GameApplication.prototype as unknown as Record<string, any>).render;
  // Successful asynchronous world preparation writes the gameplay screen
  // directly before rendering; suspension must still own the final policy.
  app.screen = "game";
  app.combat.setTimePolicy("normal");
  app.render();
  expect(app.screen).toBe("pause");
  expect(app.timePolicies.at(-1)).toBe("paused");
  expect(enabled.at(-1)).toBe(false);
  app.suspended = false;
  app.render();
  expect(app.screen).toBe("pause");
  expect(enabled.at(-1)).toBe(false);
  await app.dispatch({ type: "resume" });
  expect(app.screen).toBe("game");
  expect(app.timePolicies.at(-1)).toBe("normal");
  expect(enabled.at(-1)).toBe(true);
});

it("releases each initialized world owner once and disables gameplay readiness on repeated retirement", () => {
  const app = headlessApp();
  const disposed: string[] = [];
  app.renderer = { dispose: () => disposed.push("renderer") };
  app.presentation = { dispose: () => disposed.push("presentation") };
  app.companionPreviews.set({ dispose: () => disposed.push("preview") }, {});
  expect(app.canPlayWorld()).toBe(true);
  app.releaseWorld();
  app.releaseWorld();
  expect(disposed).toEqual(["preview", "presentation", "renderer"]);
  expect(app.worldReady).toBe(false);
  expect(app.canPlayWorld()).toBe(false);
  expect(app.companionPreviews.size).toBe(0);
  expect(app.renderer).toBeNull();
  expect(app.presentation).toBeNull();
  expect(app.region).toBeNull();
});

it("does not commit an awaited manifest continuation into a replaced or disposed world", async () => {
  for (const boundary of ["replacement", "disposal"]) {
    const app = headlessApp();
    let resolveManifest!: (assets: AssetManifestEntry[]) => void;
    app.readManifest = () => new Promise<AssetManifestEntry[]>(resolve => { resolveManifest = resolve; });
    const preparing = app.prepareWorld(app.campaign);
    expect(app.screen).toBe("loading");
    if (boundary === "replacement") app.beginWorldGeneration();
    else { app.disposed = true; app.lifecycleGeneration++; }
    resolveManifest([]);
    await preparing;
    expect(app.renderer).toBeNull();
    expect(app.region).toBeNull();
    expect(app.worldReady).toBe(false);
    expect(app.error).toBeNull();
  }
});

it("re-enables gameplay input after a successful blocked-scene retry even when no durable events remain", async () => {
  for (const operationId of ["region-load", "travel"]) {
    const app = headlessApp();
    app.ready = true;
    app.screen = "loading";
    app.sceneBlocked = true;
    app.error = { code: "application", message: "Scene load failed", recoverable: true };
    app.pendingWorldEvents = [];
    app.pendingTravel = operationId === "travel" ? { regionId: app.campaign.regionId, entranceId: "entry" } : null;
    const enabled: boolean[] = [];
    app.input.setEnabled = (value: boolean) => enabled.push(value);
    app.ui = { render: () => {} };
    app.model = () => ({});
    // Exercise production rendering/input policy, not a duplicate of its condition.
    const appPrototype = GameApplication.prototype as unknown as Record<string, any>;
    app.render = appPrototype.render;
    app.prepareWorld = async () => {
      app.screen = "game";
      app.loading = { active: false, label: "", progress: null };
      app.worldReady = true;
      app.render();
    };
    await app.dispatch({ type: "retry-load", operationId });
    expect(enabled[0]).toBe(false);
    expect(app.sceneBlocked).toBe(false);
    expect(app.canPlayWorld()).toBe(true);
    expect(enabled.at(-1)).toBe(true);
  }
});

it("walks every authored line of a multi-line beat in order before advancing the beat", async () => {
  const beat = DIALOGUE["prologue-vision"];
  const chainedBeat = DIALOGUE["prologue-vision"].next ? DIALOGUE[DIALOGUE["prologue-vision"].next!] : undefined;
  expect(beat).toBeDefined();
  expect(beat.lines.length).toBeGreaterThan(1);
  const app = headlessApp();
  app.combat = new CombatEngine();
  app.slots = [];
  app.activeCompanionSlots = {};
  app.campaign = null;
  app.region = null;
  app.renderer = null;
  const appPrototype = GameApplication.prototype as unknown as Record<string, any>;
  app.ui = { render: () => {} };
  app.model = appPrototype.model;
  app.render = () => {};
  let prologueEncounterCalls = 0;
  app.startWildlifeEncounterIfReady = async (): Promise<void> => { prologueEncounterCalls += 1; };
  app.screen = "dialogue";
  app.dialogue = beat;
  app.dialogueLineIndex = 0;
  const viewOf = () => {
    const view = app.model();
    return { id: view.dialogue?.id ?? null, index: view.dialogueLineIndex, linesLength: view.dialogue?.lines.length ?? 0 };
  };
  const expectedLineIds = beat.lines.map(line => line.id);
  const initial = viewOf();
  expect(initial.id).toBe(beat.id);
  expect(initial.linesLength).toBe(beat.lines.length);
  expect(initial.index).toBe(0);
  expect(prologueEncounterCalls).toBe(0);
  const observedIndices: number[] = [initial.index];
  for (let i = 1; i < expectedLineIds.length; i++) {
    await app.dispatch({ type: "advance-dialogue", beatId: beat.id });
    const next = viewOf();
    expect(next.id).toBe(beat.id);
    expect(next.linesLength).toBe(beat.lines.length);
    expect(next.index).toBe(i);
    observedIndices.push(next.index);
    expect(prologueEncounterCalls).toBe(0);
  }
  expect(observedIndices).toEqual(expectedLineIds.map((_, i) => i));
  expect(observedIndices.length).toBe(beat.lines.length);
  expect(observedIndices.length).toBeGreaterThan(1);
  await app.dispatch({ type: "advance-dialogue", beatId: beat.id });
  const afterFinal = viewOf();
  if (chainedBeat) {
    expect(afterFinal.id).toBe(chainedBeat.id);
    expect(afterFinal.index).toBe(0);
    expect(prologueEncounterCalls).toBe(0);
    for (let i = 1; i < chainedBeat.lines.length; i++) {
      await app.dispatch({ type: "advance-dialogue", beatId: chainedBeat.id });
      const next = viewOf();
      expect(next.id).toBe(chainedBeat.id);
      expect(next.index).toBe(i);
      expect(prologueEncounterCalls).toBe(0);
    }
    await app.dispatch({ type: "advance-dialogue", beatId: chainedBeat.id });
    const afterChain = viewOf();
    expect(afterChain.id).toBeNull();
    expect(afterChain.index).toBe(0);
    expect(prologueEncounterCalls).toBe(1);
  } else {
    expect(afterFinal.id).toBeNull();
    expect(afterFinal.index).toBe(0);
    expect(prologueEncounterCalls).toBe(1);
  }

  const transientBeat = { id: "test-transient-prelude", lines: beat.lines, next: beat.id };
  app.dialogue = transientBeat;
  app.dialogueLineIndex = 0;
  const transientInitial = viewOf();
  expect(transientInitial.id).toBe(transientBeat.id);
  expect(transientInitial.linesLength).toBe(transientBeat.lines.length);
  expect(transientInitial.index).toBe(0);
  expect(prologueEncounterCalls).toBe(1);
  for (let i = 1; i < transientBeat.lines.length; i++) {
    await app.dispatch({ type: "advance-dialogue", beatId: transientBeat.id });
    const next = viewOf();
    expect(next.id).toBe(transientBeat.id);
    expect(next.index).toBe(i);
    expect(prologueEncounterCalls).toBe(1);
  }
  await app.dispatch({ type: "advance-dialogue", beatId: transientBeat.id });
  const afterTransient = viewOf();
  expect(afterTransient.id).toBe(beat.id);
  expect(afterTransient.linesLength).toBe(beat.lines.length);
  expect(afterTransient.index).toBe(0);
  expect(prologueEncounterCalls).toBe(1);
});

function cueApp(seedQuestIds: string[] = [], seedCompletedQuestIds: string[] = [], seedCompletedObjectiveIds: string[] = []): Record<string, any> {
  const app = headlessApp();
  app.combat = new CombatEngine();
  app.campaign = {
    regionId: "whispering-canopy",
    chapter: 1,
    runId: "cue-run",
    activeQuestIds: [...seedQuestIds],
    completedQuestIds: [...seedCompletedQuestIds],
    activeObjectiveIds: [],
    completedObjectiveIds: [...seedCompletedObjectiveIds],
    worldFacts: {},
  } as unknown as CampaignSnapshot;
  app.region = REGIONS.find(item => item.id === "whispering-canopy")!;
  app.choice = null;
  app.startWildlifeEncounterIfReady = async (): Promise<void> => { /* noop */ };
  app.setScreen = (screen: string) => { app.screen = screen; };
  app.input = { clear: () => {}, setEnabled: () => {} };
  app.render = () => { app.presentQueuedNarrativeCue(); };
  return app;
}


it("queues the activation cue when a First Pact quest enters the active set", () => {
  const app = cueApp([], [], []);
  const baseline = app.campaign;
  const next = {
    ...baseline,
    activeQuestIds: ["fallen-scout"],
    completedQuestIds: [],
    completedObjectiveIds: [],
  } as CampaignSnapshot;
  app.lastCueSnapshot = baseline;
  app.primeNarrativeCuesFromTransition(baseline, next);
  app.render();
  expect(app.pendingNarrativeCues).toEqual([]);
  expect(app.dialogue?.id).toBe("fallen-scout-open");
  expect(app.dialogueLineIndex).toBe(0);
  expect(app.screen).toBe("dialogue");
});

it("queues the completion cue when an active First Pact quest completes", () => {
  const app = cueApp(["fallen-scout"], [], []);
  const baseline = app.campaign;
  const next = {
    ...baseline,
    activeQuestIds: ["thief-in-the-branches"],
    completedQuestIds: ["fallen-scout"],
    completedObjectiveIds: [],
  } as CampaignSnapshot;
  app.lastCueSnapshot = baseline;
  app.primeNarrativeCuesFromTransition(baseline, next);
  app.render();
  expect(app.dialogue?.id).toBe("fallen-scout-close");
  expect(app.pendingNarrativeCues).toEqual(["branches-open"]);
});

it("queues only the objective cue when a non-terminal objective completes inside an unchanged quest set", () => {
  const app = cueApp(["the-ash-hunters"], [], []);
  const baseline = app.campaign;
  const next = {
    ...baseline,
    activeQuestIds: ["the-ash-hunters"],
    completedQuestIds: [],
    completedObjectiveIds: ["the-ash-hunters:rescue-tali"],
  } as CampaignSnapshot;
  app.lastCueSnapshot = baseline;
  app.primeNarrativeCuesFromTransition(baseline, next);
  app.render();
  expect(app.dialogue?.id).toBe("tali-rescue");
  expect(app.pendingNarrativeCues).toEqual([]);
});

it("orders objective, completion, and activation cues in a single snapshot transition", () => {
  const app = cueApp(["fallen-scout", "the-ash-hunters"], [], []);
  const baseline = app.campaign;
  const next = {
    ...baseline,
    activeQuestIds: ["thief-in-the-branches", "the-ash-hunters"],
    completedQuestIds: ["fallen-scout"],
    completedObjectiveIds: ["the-ash-hunters:rescue-tali"],
  } as CampaignSnapshot;
  app.lastCueSnapshot = baseline;
  app.primeNarrativeCuesFromTransition(baseline, next);
  app.render();
  expect(app.dialogue?.id).toBe("tali-rescue");
  expect(app.pendingNarrativeCues).toEqual(["fallen-scout-close", "branches-open"]);
  expect(app.pendingNarrativeCues.indexOf("fallen-scout-close")).toBeLessThan(app.pendingNarrativeCues.indexOf("branches-open"));
});

it("does not replay cues when an idempotent snapshot carries the same quest/objective state", () => {
  const app = cueApp(["fallen-scout"], [], []);
  const baseline = app.campaign;
  const same = { ...baseline } as CampaignSnapshot;
  app.lastCueSnapshot = baseline;
  app.primeNarrativeCuesFromTransition(baseline, same);
  expect(app.pendingNarrativeCues).toEqual([]);
  expect(app.dialogue).toBeNull();
});

it("does not cue on load/import of already-existing progress", () => {
  const app = cueApp(
    ["fallen-scout", "thief-in-the-branches", "empty-orchard"],
    [],
    [],
  );
  const baseline = app.campaign;
  const loaded = {
    ...baseline,
    activeQuestIds: ["fallen-scout", "thief-in-the-branches"],
    completedQuestIds: ["empty-orchard"],
    completedObjectiveIds: [],
  } as CampaignSnapshot;
  app.lastCueSnapshot = baseline;
  app.loadingFromSave = true;
  app.primeNarrativeCuesFromTransition(baseline, loaded);
  expect(app.pendingNarrativeCues).toEqual([]);
  expect(app.dialogue).toBeNull();
  app.loadingFromSave = false;
});
it("discards queued cues from the replaced journey after successful load or import", async () => {
  for (const action of ["load", "import"] as const) {
    const app = cueApp(["fallen-scout"], [], []);
    const previous = app.campaign;
    const loaded = {
      ...previous,
      runId: action === "load" ? previous.runId : "imported-run",
      activeQuestIds: ["fallen-scout", "thief-in-the-branches"],
      completedQuestIds: [],
      completedObjectiveIds: [],
    } as CampaignSnapshot;
    app.pendingNarrativeCues = ["branches-open"];
    app.pendingWorldEvents = [];
    app.pendingTravel = null;
    app.pendingImportPayload = null;
    app.pendingLoadSlotId = null;
    app.slots = [];
    app.initializeIfNeeded = async () => {};
    app.beginWorldGeneration = () => ++app.worldGeneration;
    app.isWorldGenerationCurrent = () => true;
    app.campaignDirector = {
      load: async () => { app.primeNarrativeCuesFromTransition(previous, loaded); },
      importSave: async () => { app.primeNarrativeCuesFromTransition(previous, loaded); },
      snapshot: () => loaded,
    };
    app.refreshSlots = async () => {};
    app.prepareWorld = async (snapshot: CampaignSnapshot) => {
      app.campaign = snapshot;
      app.region = REGIONS.find(region => region.id === snapshot.regionId)!;
      app.worldReady = true;
      app.loading = { active: false, label: "", progress: null };
      app.screen = "game";
      app.render();
    };

    await app.dispatch(action === "load"
      ? { type: "load", slotId: "loaded-slot" }
      : { type: "import", payload: "imported-save" });

    expect(app.pendingNarrativeCues).toEqual([]);
    expect(app.dialogue).toBeNull();
    expect(app.screen).toBe("game");
  }
});


it("never interrupts a currently displayed beat when a new cue is queued", () => {
  const app = cueApp([], [], []);
  app.dialogue = DIALOGUE["prologue-vision"] ?? null;
  app.dialogueLineIndex = 1;
  const baseline = app.campaign;
  const next = {
    ...baseline,
    activeQuestIds: ["fallen-scout"],
    completedQuestIds: [],
    completedObjectiveIds: [],
  } as CampaignSnapshot;
  app.lastCueSnapshot = baseline;
  app.primeNarrativeCuesFromTransition(baseline, next);
  app.render();
  expect(app.pendingNarrativeCues).toEqual(["fallen-scout-open"]);
  expect(app.dialogue?.id).toBe("prologue-vision");
  expect(app.dialogueLineIndex).toBe(1);
});

it("skip-cinematic drains the pending queue and preserves the existing safe continuation", async () => {
  const app = cueApp([], [], []);
  const baseline = app.campaign;
  const next = {
    ...baseline,
    activeQuestIds: ["fallen-scout", "thief-in-the-branches"],
    completedQuestIds: [],
    completedObjectiveIds: [],
  } as CampaignSnapshot;
  app.lastCueSnapshot = baseline;
  app.primeNarrativeCuesFromTransition(baseline, next);
  app.render();
  expect(app.dialogue?.id).toBe("fallen-scout-open");
  expect(app.pendingNarrativeCues).toEqual(["branches-open"]);
  await app.dispatch({ type: "skip-cinematic", cinematicId: "any" });
  expect(app.dialogue).toBeNull();
  expect(app.dialogueLineIndex).toBe(0);
  expect(app.pendingNarrativeCues).toEqual([]);
  expect(app.screen).toBe("game");
});

it("skip-cinematic routes to the choice screen when a choice is pending instead of resuming game", async () => {
  const app = cueApp([], [], []);
  let encounterCalls = 0;
  app.startWildlifeEncounterIfReady = async (): Promise<void> => { encounterCalls += 1; };
  const baseline = app.campaign;
  const next = {
    ...baseline,
    activeQuestIds: ["fallen-scout"],
    completedQuestIds: [],
    completedObjectiveIds: [],
  } as CampaignSnapshot;
  app.lastCueSnapshot = baseline;
  app.primeNarrativeCuesFromTransition(baseline, next);
  app.render();
  expect(app.dialogue?.id).toBe("fallen-scout-open");
  app.choice = { id: "canopy-water-seed-accord", title: "Choose", options: [] };
  await app.dispatch({ type: "skip-cinematic", cinematicId: "any" });
  expect(app.choice).toEqual({ id: "canopy-water-seed-accord", title: "Choose", options: [] });
  expect(app.dialogue).toBeNull();
  expect(app.dialogueLineIndex).toBe(0);
  expect(app.screen).toBe("choice");
  expect(encounterCalls).toBe(0);
});

it("queues an optional empty-nest cue from STORY_DIALOGUE", () => {
  const app = cueApp([], [], []);
  const baseline = app.campaign;
  const next = {
    ...baseline,
    activeQuestIds: ["the-empty-nest"],
    completedQuestIds: [],
    completedObjectiveIds: [],
  } as CampaignSnapshot;
  app.lastCueSnapshot = baseline;
  app.primeNarrativeCuesFromTransition(baseline, next);
  app.render();
  expect(app.dialogue?.id).toBe("the-empty-nest-opening");
  expect(app.pendingNarrativeCues).toEqual([]);
});

it("defers cue presentation until the world, region, and active screen are ready", () => {
  const app = cueApp([], [], []);
  const baseline = app.campaign;
  const next = {
    ...baseline,
    activeQuestIds: ["fallen-scout"],
    completedQuestIds: [],
    completedObjectiveIds: [],
  } as CampaignSnapshot;
  app.lastCueSnapshot = baseline;
  app.primeNarrativeCuesFromTransition(baseline, next);
  // World not yet ready: presentation must not consume the queue.
  app.worldReady = false;
  app.render();
  expect(app.pendingNarrativeCues).toEqual(["fallen-scout-open"]);
  expect(app.dialogue).toBeNull();
  // Region mismatch: still defer.
  app.worldReady = true;
  app.region = REGIONS.find(item => item.id === "blood-bamboo-valley")!;
  app.render();
  expect(app.pendingNarrativeCues).toEqual(["fallen-scout-open"]);
  expect(app.dialogue).toBeNull();
  // Region matches campaign: present.
  app.region = REGIONS.find(item => item.id === "whispering-canopy")!;
  // An authored choice remains in front of newly queued dialogue.
  app.screen = "choice";
  app.render();
  expect(app.pendingNarrativeCues).toEqual(["fallen-scout-open"]);
  expect(app.dialogue).toBeNull();
  app.screen = "game";
  app.render();
  expect(app.pendingNarrativeCues).toEqual([]);
  expect(app.dialogue?.id).toBe("fallen-scout-open");
});

it("return-title clears the cue schedule baseline and the pending queue", async () => {
  const app = cueApp(["fallen-scout"], [], []);
  app.lastCueSnapshot = app.campaign;
  app.primeNarrativeCuesFromTransition(app.campaign, app.campaign);
  app.pendingNarrativeCues.push("fallen-scout-open");
  expect(app.pendingNarrativeCues).toEqual(["fallen-scout-open"]);
  await app.dispatch({ type: "return-title" });
  expect(app.pendingNarrativeCues).toEqual([]);
  expect(app.lastCueSnapshot).toBeNull();
});

it("ignores unknown authored cue beat ids so the scheduler fails closed", () => {
  const app = cueApp([], [], []);
  app.enqueueNarrativeCue("nonexistent-cue-beat");
  expect(app.pendingNarrativeCues).toEqual([]);
  const baseline = app.campaign;
  const next = { ...baseline, activeQuestIds: ["fall-of-the-grove"] } as CampaignSnapshot;
  app.lastCueSnapshot = baseline;
  app.primeNarrativeCuesFromTransition(baseline, next);
  expect(app.pendingNarrativeCues).toEqual([]);
});

it("queues the next queued cue after the current beat's final line advances", async () => {
  const app = cueApp([], [], []);
  app.dialogue = DIALOGUE["fallen-scout-open"] ?? null;
  app.dialogueLineIndex = (DIALOGUE["fallen-scout-open"]?.lines.length ?? 1) - 1;
  app.screen = "dialogue";
  app.pendingNarrativeCues.push("branches-open");
  await app.dispatch({ type: "advance-dialogue", beatId: "fallen-scout-open" });
  expect(app.dialogue?.id).toBe("branches-open");
  expect(app.pendingNarrativeCues).toEqual([]);
});

it("does not mutate the cue scheduler when a different runId snapshot arrives", () => {
  const app = cueApp(["fallen-scout"], [], []);
  const baseline = app.campaign;
  const otherRun = {
    ...baseline,
    runId: "different-run",
    activeQuestIds: ["thief-in-the-branches"],
    completedQuestIds: [],
    completedObjectiveIds: [],
  } as CampaignSnapshot;
  app.lastCueSnapshot = baseline;
  app.primeNarrativeCuesFromTransition(baseline, otherRun);
  expect(app.pendingNarrativeCues).toEqual([]);
  expect(app.lastCueSnapshot?.runId).toBe("different-run");
});
