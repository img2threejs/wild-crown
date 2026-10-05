# Campaign state package

`packages/campaign` is a standalone, deterministic TypeScript package for bounded campaign-state and ending-predicate behavior (D01/D04). It is a package contract, not a complete game save system or P0 completion claim.

## Runtime contract

- `createNewRun(runId)` creates a schema-version-1 journey with six factions, six Heartroot fragments, five regions, eight independently stored regional obligation facts across those regions, six Chapter 7 commitments, Hollow readiness, Marek presence and an empty Dominion ledger.
- Canon leaders are Canopy–Koro, Fang–Asha, Pack–Ruun or Luma, Shadow–Nyra and Crown–Solkar; Sky has no invented sovereign. Canon representatives are Sky–Vara envoy, Canopy–Koro leader, Fang–Asha leader, Pack–Sable envoy, Shadow–Nyra leader and Crown–Solkar leader or council. Leader and representative are separate state fields even when the same character fills both roles.
- `setPackLeader` transitions between Ruun and Luma without carrying the previous leader's willingness over. `collectFragment` is idempotent by stable fragment ID.
- `recordLeaderDominion` appends a 1-based monotonic sequence in run state. `createCheckpoint` stores only a `campaign-checkpoint` envelope with schema, run ID and cloned world facts; it excludes history.
- `importCheckpoint(current, input)` accepts only the campaign-checkpoint envelope. It validates schema, run, world and representative consistency; same-run checkpoint loads restore world facts while retaining current Dominion history. Replay envelopes, malformed data, mismatched runs and unsupported schema versions are rejected at this actual import boundary.
- `createShowcaseReplay` creates detached replay data. It has no campaign import path.
- `evaluateEnding` returns unmet condition IDs and their approved English labels/messages. Living Pact requires no historical Dominion, all six tier-3 covenants, all six present and willing valid representatives, all five restored regions, Hollow readiness, all eight independent regional obligations and all six renewed commitments. Dominion and Severance remain choices; Living Pact joins them only when every predicate is met.
- A matching exiled/absent leader representative with both present=false and willing=false is a valid checkpoint fact but never fulfills ending eligibility. Other representative names and sources must match their faction allowlist. A willing Crown council can represent Crown after Solkar's exile; Marek presence is irrelevant.

## Integrated Director choice and interaction invariants

The game-facing `src/game/campaign/CampaignDirector.ts` is separate from the standalone package. Its committed choice reducers use the current checkpoint's choice records and event log: a settlement, leadership, fate, route, council response or final ending cannot be replaced with another option. Repeating the same option is a no-op even with a fresh event key; conflicting attempts do not change the snapshot, revision, event log, checkpoint or durable run-ledger writes. `faction-covenant` and `chapter-seven-commitment` are deliberately scoped per faction, so all six factions can respond independently; accepting and declining the same recommitment are not interchangeable.

An exile resolution sets the existing `solkarPresent` visibility fact to false and the exact `solkar-exiled` council interaction fact to true, removes Solkar from either selected party slot, and keeps Crown represented by the council rather than a revived leader. Those facts and party changes participate in the same Director event rollback as the domain state. A checkpoint captured after exile retains the absence through restore, the Crown covenant and Chapter 7 recommitment. Dominion history continues to use the existing monotonic run ledger; no choice or fact is an alternative ending-predicate authority.

The final interaction requires `orun-cleansed`. The actual `encounter-orun` cleansed event produces that exact fact only when its participants match the authored encounter, not the obsolete `encounter-orun-cleansed` spelling. Another encounter's cleanse, a mismatched participant, or possession state alone cannot open the gate. The Director uses the same encounter requirement matcher for the objective and final-choice authorization; only the package's `evaluateEnding` can make Living Pact eligible. This does not implement or accept the full final-possession encounter.

The runtime's contextual action mechanic now recognizes only the matching `choose` interaction kind with a `choice` success payload. Previously the mechanic accepted inspect/rescue/signal but rejected every contextual authored choice, so even correctly synchronized exile and cleanse facts could not reach the application’s `choose` action. Existing fact, actor visibility, target identity, distance and authored-option gates remain in place; a semantic `choose` payload is not authorized by this branch. Consumer tests include locked, invalid-option, wrong-target and out-of-range refusals with no emitted world event.

The choice reducer resolves Dominion leader identity from the authored choice and current faction state, not a producer's option label or optional leader metadata. Thus the application's real Solkar offer records Solkar in the permanent run ledger just as a direct Director choice does. Contextual multi-faction events use an interaction key scoped to the faction; renewal and refusal share that scope, while ordinary single-site interactions keep their original deduplication. Fresh simulation instances and checkpoint-restored Director event keys cannot replace a faction's recorded response or add duplicate ledger writes. Engine-to-Director tests cover Solkar's Dominion veto and all six accepted, declined and mixed Refuge council responses across reload/checkpoint boundaries.

`CampaignChoiceRejectedError`, exported from the Director module, distinguishes a permanently invalid authored choice from a retryable durable-write failure. It carries the exact `choiceId`, `optionId` and existing English rejection message. Conflicting resolutions, unavailable faction commitments and unmet final-choice predicates reject before ledger writes or live state mutation. The actual `GameApplication` event consumer removes these permanent choice rejections from its pending queue without entering the paused durable-retry state; unrelated transient and persistence failures keep the existing retry path.

For that typed choice-rejection path only, `CampaignDirector.isEventCommitted(key)` queries the current accepted event-key set directly. `GameApplication` passes that authoritative result to `CombatEngine.discardRejectedChoice(choiceEvent, committed)`, releasing only an uncommitted speculative simulation key and preserving a key already owned by the Director. This lets a stale ineligible Living Pact response be rejected and then a valid Severance response be emitted by the same simulation, without weakening ordinary interaction deduplication or previously recorded faction responses. Durable-write failures retain their speculative key and follow the separate persistence retry path. The final choice UI filters Living Pact from actionable options when the package's ending evaluation is unavailable; Dominion and Severance retain their authored options.

Historical events share a Director-owned validation rule at the safe-checkpoint restore and persisted load/import adoption boundaries. Each choice requires nonempty string `eventId`, `idempotencyKey`, `choiceId` and `optionId`, with optional string `leaderId` and boolean `dominion` metadata. Missing, null, array or otherwise malformed required choice fields reject before live state is installed or replay reads the history; import also rejects before committing the imported slot. History is not skipped, defaulted or rewritten to make adoption succeed. Valid historical choices retain their faction-scoped replay semantics. No storage adapter or separate save-adoption worktree utility is changed by this repair.

`RETURN_BEATS` derives the five return quest IDs from the chapter with `number === 7`, excluding `wild-march`: Seeds on the Wind, A Path for the Young, One Howl, Two Generations, Witness in the Reeds and The Open Crossing. This corrects the previous incidental array-index lookup, which selected Chapter 6's Fall of the Grove. It does not implement or accept the five return mechanics, the complete quest graph, native scenes or production assets.

A faction covenant raises its relationship tier without changing an absent representative's presence. Chapter 7 renewal likewise does not summon an absent companion or leader. Crown council refusal explicitly leaves the council unwilling and is not overwritten by a subsequent covenant, including when covenant and refusal occur in the opposite order. Exile visibility and the absent Solkar party remain intact through these choices and checkpoint restoration.

The five return-quest regression fixtures submit evidence and each existing semantic requirement in Chapter 7 order, checking objective/quest completion, duplicate-event no-ops and checkpoint continuity with Luma, absent Marek and exiled Solkar. They do not add navigation changes, patrol/coalition formations, bypass mechanics or new authored consequence facts; the existing callback descriptions are not executed gameplay. Six-fragment coverage checks unique stable IDs even when repeat awards arrive with fresh event keys. Choice metadata coverage verifies that optional producer leader/Dominion fields neither substitute a different leader nor fabricate historical Dominion.

Focused behavior coverage is authored in `tests/campaign/invariants.test.ts`, including actual CombatEngine visibility/interaction consumers, fresh-key idempotency, conflicting resolutions, ledger-failure rollback, checkpoint restoration, persisted load/import history rejection, independent faction responses, absent representatives, council refusal, return-quest reducers, fragment uniqueness and final-possession/participant boundaries. `tests/app/GameApplication.test.ts` additionally exercises the production choice UI, contextual producer and event consumer together for eligible and ineligible final choices, committed-key preservation and persistence retry. The original eighteen branch-history regressions remain unchanged. These checks have not been executed by this implementation worker; the coordinator owns deterministic and browser verification. This is a bounded WIP code checkpoint for #51/#77/#80/#83, not completion of their authored content or production acceptance.

## Approved content and persistence boundary

`content/PLAYER-COPY.en.json` is copied byte-for-byte from the approved English player-copy source. The package reads its Living Pact requirement labels/messages; it does not author substitute player-facing strings.

The package has no browser storage adapter. State is caller-owned in-memory state. A checkpoint contains rewindable world state only; run history remains outside it while the caller retains the run. This is not a full-save import/export contract, and **IndexedDB persistence, durable history storage and game-shell save-slot wiring are not implemented**. No SQL storage or browser persistence is exercised by these tests. A future host must define full-save history handling separately and scope durable history by `runId`.

## Commands (Node 22.22.3)

From `packages/campaign`:

```sh
npm install
npm run typecheck
npm test
npm run scenario
```

`npm run build` emits `dist/`. Tests are deterministic Node test-runner tests. The scenario command runs representative user-visible transitions and prints their JSON results.

## Public exports

`src/index.ts` exports `SCHEMA_VERSION`, `FACTION_IDS`, `FRAGMENT_IDS`, `REGION_IDS`, `REGIONAL_OBLIGATION_IDS`, state types, `createNewRun`, `collectFragment`, `recordLeaderDominion`, `setPackLeader`, `createCheckpoint`, `importCheckpoint`, `createShowcaseReplay`, `evaluateEnding`, `setCrownCouncilRepresentation`, and `getFactionName`.
