import assert from "node:assert/strict";
import test from "node:test";
import { createCheckpoint, createNewRun, recordLeaderDominion } from "../../packages/campaign/src/index.js";
import { REGIONS } from "../../src/content/world.js";
import { SAVE_FORMAT_SCHEMA_VERSION, SaveRepository, SaveRepositoryError, type GameSaveEnvelope } from "../../src/game/storage/SaveRepository.js";
import { createResumeState, createSessionMetadata } from "../../src/game/campaign/session.js";
import type { RegionId } from "../../src/game/contracts.js";

const session = (chapter: number, regionId: RegionId) =>
  createSessionMetadata("production", "aren", createResumeState({ chapter, regionId, completedQuestIds: [], completedObjectiveIds: [], chapters: [], facts: {} }));

function envelope(): GameSaveEnvelope {
  const campaign = createNewRun("storage-boundary-run");
  return { format: "wild-crown-save", schemaVersion: SAVE_FORMAT_SCHEMA_VERSION, scope: "production", kind: "campaign", runId: campaign.runId,
    checkpoint: createCheckpoint(campaign), campaign, progress: null, eventKeys: ["arrival"], savedAt: 123 };
}
const unavailable = () => new SaveRepository(undefined);
const code = (expected: string) => (error: unknown) => error instanceof SaveRepositoryError && error.code === expected;

test("valid exported checkpoints import independent world state", async () => {
  const input = envelope();
  const result = await unavailable().importSave(JSON.stringify(input));
  assert.deepEqual(result.envelope, input);
  assert.equal(result.result?.accepted, true);
  result.envelope.campaign!.world.marekPresent = false;
  assert.equal(input.campaign!.world.marekPresent, true);
});

test("malformed JSON, future format and incompatible checkpoint exports are rejected", async () => {
  const repository = unavailable();
  await assert.rejects(repository.importSave("{"), code("corrupt"));
  await assert.rejects(repository.importSave({ ...envelope(), schemaVersion: SAVE_FORMAT_SCHEMA_VERSION + 1 }), code("future-schema"));
  const mismatch = envelope();
  mismatch.checkpoint!.runId = "another-run";
  await assert.rejects(repository.importSave(mismatch), code("run-mismatch"));
});

test("a null Dominion event is rejected as corrupt rather than escaping as a TypeError", async () => {
  const input = envelope();
  (input.campaign!.dominionHistory as unknown[]) = [null];
  await assert.rejects(unavailable().importSave(input), code("corrupt"));
});

for (const [name, mutate, expected] of [
  ["future envelope", (value: GameSaveEnvelope) => { Object.assign(value, { schemaVersion: SAVE_FORMAT_SCHEMA_VERSION + 1 }); }, "future-schema"],
  ["malformed world", (value: GameSaveEnvelope) => { Object.assign(value.campaign!, { world: {} }); }, "corrupt"],
  ["mismatched checkpoint", (value: GameSaveEnvelope) => { value.checkpoint!.runId = "another-run"; }, "run-mismatch"],
] as const) {
  test(`direct commit rejects ${name} before writing storage`, async () => {
    const input = envelope();
    mutate(input);
    await assert.rejects(unavailable().commitImported("existing", "Existing", input, 0, "greenwake"), code(expected));
  });
}

test("missing IndexedDB is explicit and repeated opens remain recoverable errors", async () => {
  const repository = unavailable();
  await assert.rejects(repository.init(), code("unavailable"));
  await assert.rejects(repository.init(), code("unavailable"));
  assert.deepEqual(await repository.recovery(), { slots: [], exportAvailable: false });
});

test("same-run older import preserves current Dominion while restoring the selected world", async () => {
  const input = envelope();
  const current = recordLeaderDominion(input.campaign!, "koro");
  current.world.fragments.push("heartroot-sky");
  const before = structuredClone(input);
  const imported = await unavailable().importSave(input, current);
  assert.deepEqual(imported.envelope.campaign!.dominionHistory.map(event => event.leaderId), ["koro"]);
  assert.deepEqual(imported.envelope.campaign!.world.fragments, []);
  assert.deepEqual(current.world.fragments, ["heartroot-sky"]);
  // Validation must not mutate caller-owned export data.
  assert.deepEqual(input, before);
});

test("cross-run import adopts incoming identity/history without unrelated current Dominion", async () => {
  const input = envelope();
  input.campaign = recordLeaderDominion(input.campaign!, "koro");
  const unrelated = recordLeaderDominion(createNewRun("unrelated-journey"), "asha");
  const imported = await unavailable().importSave(input, unrelated);
  assert.equal(imported.envelope.runId, input.runId);
  assert.deepEqual(imported.envelope.campaign!.dominionHistory.map(event => event.leaderId), ["koro"]);
  assert.deepEqual(unrelated.dominionHistory.map(event => event.leaderId), ["asha"]);
});

test("replay exports are rejected without replacing campaign state", async () => {
  const input = envelope();
  Object.assign(input, { kind: "showcase-replay" });
  const current = recordLeaderDominion(createNewRun(input.runId), "koro");
  const before = structuredClone(current);
  await assert.rejects(unavailable().importSave(input, current), code("replay-isolated"));
  assert.deepEqual(current, before);
});

test("safe spawn must match the saved region, authored entry/node and camera", async () => {
  const input = envelope();
  const region = REGIONS.find(item => item.id === "greenwake")!;
  const node = region.navigation.nodes[0]!;
  input.progress = {
    chapter: 0, regionId: "greenwake", activeQuestIds: ["prologue"],
    completedQuestIds: [], completedObjectiveIds: [], trackedObjectiveId: null,
    party: { companionId: "vara" }, choices: {}, worldFacts: {}, ending: null, eventLog: [], session: session(0, "greenwake"),
    safeSpawn: { regionId: "greenwake", position: { ...node.position }, routeId: node.id, cameraAnchorId: region.cameraAnchors[0]!.id },
  };
  const repository = unavailable();
  assert.deepEqual((await repository.importSave(input)).envelope.progress!.safeSpawn, input.progress.safeSpawn);
  for (const mutate of [
    (value: GameSaveEnvelope) => { value.progress!.safeSpawn!.regionId = "heartroot-hollow"; },
    (value: GameSaveEnvelope) => { value.progress!.safeSpawn!.routeId = "unwritten-route"; },
    (value: GameSaveEnvelope) => { value.progress!.safeSpawn!.cameraAnchorId = "unwritten-camera"; },
    (value: GameSaveEnvelope) => { value.progress!.safeSpawn!.position.x += 1; },
  ]) {
    const invalid = structuredClone(input);
    mutate(invalid);
    await assert.rejects(repository.importSave(invalid), code("corrupt"));
  }
});

function choiceEnvelope(): GameSaveEnvelope {
  const input = envelope();
  input.progress = {
    chapter: 3, regionId: "moonpine-ridge", activeQuestIds: ["the-alpha-below"],
    completedQuestIds: [], completedObjectiveIds: [], trackedObjectiveId: null,
    party: { companionId: "vara" }, choices: { "pack-leadership": "ruun" },
    worldFacts: { chapter: 3 }, ending: null, session: session(3, "moonpine-ridge"),
    eventLog: [{ type: "choice", eventId: "historic-choice", idempotencyKey: "historic:choice", choiceId: "pack-leadership", optionId: "ruun", leaderId: "ruun", dominion: false }],
  };
  return input;
}

for (const field of ["eventId", "idempotencyKey", "choiceId", "optionId"] as const) {
  for (const [name, invalid] of [["missing", undefined], ["null", null], ["number", 7], ["array", []], ["empty", ""], ["whitespace", "  "]] as const) {
    test(`persisted choice ${field} ${name} rejects import and direct commit before touching storage`, async () => {
      const input = choiceEnvelope();
      const event = input.progress!.eventLog[0] as Record<string, unknown>;
      if (invalid === undefined) delete event[field];
      else event[field] = invalid;
      const before = structuredClone(input);
      const repository = unavailable();
      await assert.rejects(repository.importSave(input), code("corrupt"));
      await assert.rejects(repository.commitImported("existing-good-slot", "Must preserve", input, 3, "moonpine-ridge"), code("corrupt"));
      assert.deepEqual(input, before);
    });
  }
}

test("valid historical choice retains optional metadata without granting history from it", async () => {
  const input = choiceEnvelope();
  const event = input.progress!.eventLog[0] as Record<string, unknown>;
  event.leaderId = "solkar";
  event.dominion = true;
  const imported = await unavailable().importSave(input);
  assert.deepEqual(imported.envelope.progress!.eventLog, input.progress!.eventLog);
  assert.deepEqual(imported.envelope.campaign!.dominionHistory, []);
  assert.deepEqual(imported.envelope.campaign!.world, input.campaign!.world);
  delete event.leaderId;
  delete event.dominion;
  assert.deepEqual((await unavailable().importSave(input)).envelope.progress!.eventLog, input.progress!.eventLog);
});

for (const [field, invalidValues] of [
  ["leaderId", [null, 7, [], false]],
  ["dominion", [null, "true", [], 7]],
] as const) {
  test(`provided historical ${field} metadata must retain its actual contract type`, async () => {
    for (const invalid of invalidValues) {
      const input = choiceEnvelope();
      (input.progress!.eventLog[0] as Record<string, unknown>)[field] = invalid;
      await assert.rejects(unavailable().importSave(input), code("corrupt"));
      await assert.rejects(unavailable().commitImported("existing-good-slot", "Must preserve", input, 3, "moonpine-ridge"), code("corrupt"));
    }
  });
}

test("checkpoint save rejects corrupt campaign state before opening storage", async () => {
  const input = envelope();
  Object.assign(input.campaign!, { world: {} });
  await assert.rejects(unavailable().saveCheckpoint("existing", "Must preserve", input.checkpoint!, input.campaign!, 0, "greenwake", []), code("corrupt"));
});

test("slot writes reject invalid legacy or mismatched progress location before opening storage", async () => {
  const input = envelope();
  await assert.rejects(unavailable().saveCheckpoint("existing", "Must preserve", input.checkpoint!, input.campaign!, 99, "greenwake", []), code("corrupt"));
  await assert.rejects(unavailable().commitImported("existing", "Must preserve", input, -1, "greenwake"), code("corrupt"));
  const withProgress = choiceEnvelope();
  await assert.rejects(unavailable().commitImported("existing", "Must preserve", withProgress, 0, "greenwake"), code("corrupt"));
  await assert.rejects(unavailable().saveCheckpoint("existing", "Must preserve", withProgress.checkpoint!, withProgress.campaign!, 0, "greenwake", [], "campaign", withProgress.progress), code("corrupt"));
});

test("version-2 three-companion imports select one primary ally without changing story progress", async () => {
  const input = choiceEnvelope();
  Object.assign(input, { schemaVersion: 2 });
  Object.assign(input.progress!, { party: { combat: "asha", utility: "koro", scout: "vara" } });
  const before = structuredClone(input);
  const imported = await unavailable().importSave(input);
  assert.equal(imported.envelope.schemaVersion, 3);
  assert.deepEqual(imported.envelope.progress!.party, { companionId: "asha" });
  assert.deepEqual(imported.envelope.campaign!.world, input.campaign!.world);
  assert.deepEqual(imported.envelope.progress!.eventLog, input.progress!.eventLog);
  assert.deepEqual(input, before);
});

test("current exports reject legacy or mixed role fields rather than equipping extra companions", async () => {
  const repository = unavailable();
  for (const party of [
    { combat: "asha", utility: "koro", scout: "vara" },
    { companionId: "nyra", combat: "asha" },
  ]) {
    const input = choiceEnvelope();
    Object.assign(input.progress!, { party });
    await assert.rejects(repository.importSave(input), code("corrupt"));
  }
});
