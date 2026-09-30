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
