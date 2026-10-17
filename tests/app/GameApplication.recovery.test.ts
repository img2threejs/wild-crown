import { expect, it } from "bun:test";
import { REGIONS } from "../../src/content/campaign.js";
import { GameApplication } from "../../src/app/GameApplication.js";
import { appDefaults } from "./fakeApp.js";
import { CampaignDirector } from "../../src/game/campaign/CampaignDirector.js";
import { CombatEngine } from "../../src/game/combat/CombatEngine.js";
import { SaveRepository } from "../../src/game/storage/SaveRepository.js";
import { DEFAULT_GAME_SETTINGS, DEFAULT_INPUT_BINDINGS, type GameViewModel } from "../../src/game/contracts.js";
import { saveMarkup } from "../../src/ui/save.js";
import { FakeIDBFactory } from "../storage/fakeIndexedDB.js";


async function recoveryApp(screen: GameViewModel["screen"], worldReady: boolean) {
  const saves = new SaveRepository(new FakeIDBFactory().asFactory());
  const director = new CampaignDirector({ saves, runId: "recovery-refresh" });
  await director.advanceStory({ beatId: "prologue-opening", lineIndex: 0, skip: true });
  for (const slot of await saves.listSlots()) await saves.removeSlot(slot.slotId);
  const campaign = director.snapshot();
  const rendered: GameViewModel[] = [];
  const markup: string[] = [];
  const enabled: boolean[] = [];
  const error: GameViewModel["error"] = worldReady ? null : {
    code: "asset-unavailable", message: "Required native assets are unavailable.", recoverable: false,
  };
  const inputBasis = { forward: { x: 0, y: 0, z: -1 }, right: { x: 1, y: 0, z: 0 } };
  const app = Object.assign(Object.create(GameApplication.prototype), {
    disposed: false, suspended: false, lifecycleGeneration: 0, worldGeneration: 0,
    ...appDefaults(),
    ready: true, worldReady, screen, screenHistory: screen === "settings" ? ["loading"] : [],
    saves, slots: [], campaignDirector: director, campaign,
    combat: new CombatEngine(),
    renderer: worldReady
      ? { dispose: () => {}, getInputBasis: () => inputBasis, getNativeSolidColliders: () => [], getNativeSupportFields: () => [] }
      : null,
    region: REGIONS.find(region => region.id === campaign.regionId),
    sceneBlocked: false, failedWorldEvent: null, error,
    loading: { active: false, label: "", progress: null, operationId: "region-load" },
    settings: { ...DEFAULT_GAME_SETTINGS }, bindings: DEFAULT_INPUT_BINDINGS,
    companionPreviews: new Map(),
    damageNumbers: { consume: () => {}, update: () => {}, clear: () => {}, dispose: () => {}, element: { hidden: true } },
    monsterLabels: { clear: () => {}, element: { hidden: true } },
    dialogue: null,
    dialogueLineIndex: 0,
    choice: null,
    ending: null,
    pendingNarrativeCues: [],
    lastCueSnapshot: null,
    loadingFromSave: false,
    choiceFeedback: { hidden: true },
    input: { clear: () => {}, setEnabled: (value: boolean) => enabled.push(value) },
    ui: { notify: () => {}, render: (model: GameViewModel) => { rendered.push(model); markup.push(saveMarkup(model, false)); } },
  }) as Record<string, any>;
  app.combat.setTimePolicy(screen === "game" && worldReady ? "normal" : "paused");
  return { app, saves, rendered, markup, enabled, error };
}

for (const [screen, worldReady, nextScreen] of [
  ["loading", false, "loading"],
  ["settings", false, "settings"],
  ["game", true, "pause"],
  ["pause", true, "pause"],
] as const) {
  it(`refreshes created save rows and Export from ${screen} with world readiness ${worldReady}`, async () => {
    const { app, saves, rendered, markup, enabled, error } = await recoveryApp(screen, worldReady);
    const history = [...app.screenHistory];
    app.render();
    expect(rendered[0]!.saves.slots).toEqual([]);
    expect(markup[0]).toMatch(/data-ui-action="export" disabled/);
    rendered.length = 0;
    markup.length = 0;

    await app.dispatch({ type: "create-save-slot", label: "Recovered Journey" });

    const slots = await saves.listSlots();
    expect(slots).toHaveLength(1);
    const model = rendered.at(-1)!;
    const slot = slots[0]!;
    expect(model.screen).toBe(nextScreen);
    expect(model.saves.slots).toEqual([{ ...slot, exists: true }]);
    expect(model.saves.continueSlotId).toBe(slot.slotId);
    expect(markup[0]).toContain("<strong>Recovered Journey</strong>");
    expect(markup[0]).toContain(`data-ui-action="export" data-slot="${slot.slotId}"`);
    expect(markup[0]).not.toMatch(/data-ui-action="export" disabled/);
    expect(model.canOpenWorldPanels).toBe(worldReady);
    expect(app.error).toBe(error);
    expect(enabled.at(-1)).toBe(false);
    expect(app.combat.snapshot().worldClock.policy).toBe("paused");
    expect(app.screenHistory).toEqual(screen === "game" ? ["game"] : history);

    if (!worldReady) {
      await app.dispatch({ type: "open-map" });
      expect(app.screen).toBe(nextScreen);
      expect(app.screenHistory).toEqual(history);
      expect(rendered.at(-1)!.canOpenWorldPanels).toBe(false);
      expect(rendered.at(-1)!.saves.slots).toEqual([{ ...slot, exists: true }]);
      expect(enabled.at(-1)).toBe(false);
    }
  });
}

it("renders rejected navigation during suspension without recursively requesting an unavailable Pause", async () => {
  const { app, rendered, enabled, error } = await recoveryApp("game", false);
  app.suspended = true;
  await app.dispatch({ type: "create-save-slot", label: "Suspended Recovery" });
  expect(rendered.at(-1)!.screen).toBe("loading");
  expect(rendered.at(-1)!.canOpenWorldPanels).toBe(false);
  expect(rendered.at(-1)!.saves.slots[0]!.label).toBe("Suspended Recovery");
  expect(app.error).toBe(error);
  expect(enabled.at(-1)).toBe(false);
});
