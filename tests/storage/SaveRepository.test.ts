import assert from "node:assert/strict";
import test from "node:test";
import { createCheckpoint, createNewRun } from "../../packages/campaign/src/index.js";
import { SaveRepository, SaveRepositoryError, type GameSaveEnvelope } from "../../src/game/storage/SaveRepository.js";

function envelope(): GameSaveEnvelope {
  const campaign = createNewRun("storage-boundary-run");
  return { format: "wild-crown-save", schemaVersion: 1, kind: "campaign", runId: campaign.runId,
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
  await assert.rejects(repository.importSave({ ...envelope(), schemaVersion: 2 }), code("future-schema"));
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
  ["future envelope", (value: GameSaveEnvelope) => { Object.assign(value, { schemaVersion: 2 }); }, "future-schema"],
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
