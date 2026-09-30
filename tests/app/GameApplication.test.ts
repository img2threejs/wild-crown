import { expect, it } from "bun:test";
import { ENVIRONMENT_RECIPES, REGIONS } from "../../src/content/campaign.js";
import { GameApplication } from "../../src/app/GameApplication.js";
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
  app.combat = { commandCompanionCalls: 0, stepCalls: 0 };
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
