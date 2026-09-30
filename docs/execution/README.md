# Wave 01 — measured execution and delivery

## Delivered, unmerged PRs

| PR | Feature | Authoring / review |
|---|---|---|
| [#1](https://github.com/img2threejs/wild-crown/pull/1) | Approved production baseline, English content/concepts, workflow and this execution record | Astra coordination; imported user-approved artifacts |
| [#2](https://github.com/img2threejs/wild-crown/pull/2) | Campaign-state/content package, ending rules and checkpoint boundaries | Luna; Astra review; two repair rounds |
| [#3](https://github.com/img2threejs/wild-crown/pull/3) | Guided 3D locomotion/camera lab and production routing | Luna; Astra review; two repair rounds |

Repository visibility was verified PRIVATE. No PR was merged. The game/repository name remains Wild Crown; **Game Jungle** was requested only as the OMP session title.

## Measurement interval

- Start: **2026-09-30T08:22:52.934Z**, immediately before the implementation batch.
- Snapshot: **2026-09-30T09:24:27.249Z**.
- Observed wall elapsed: **3,694,315 ms = 61 min 34.315 sec**.

This interval includes concurrent authoring, repair rounds, Astra coordination/review, verification, waits, publishing and the session-name interruption. Earlier repository/configuration preparation is excluded. Operations and the final response after the snapshot are excluded. It is an observed interval, not a forecast for the remaining game.

## Provider-reported token counters

| Model and scope | Input | Output | Cache read | Provider total |
|---|---:|---:|---:|---:|
| Luna — both feature jobs, all three rounds each | 1,346,988 | 193,085 | 49,415,296 | 50,955,369 |
| Astra — parent coordination/review/verification in this interval | 294,555 | 58,389 | 41,619,840 | 41,972,784 |

These are matched persisted-session usage fields, not account-wide deltas. Cache read includes the same context read again on successive requests; it is **not unique new content**. Keep cache reads separate when comparing models. Provider totals are not billing estimates. Missing reasoning counters remain null and are not added again to output. Unreported consumption from the failed auxiliary headless rename attempt is unknown, not asserted to be zero.

## Luna round spans

Measured from each session/repair handoff timestamp to the last recorded assistant message of that round. They include tools and waiting inside the round, not just model generation. Idle gaps between review rounds are excluded from the sum.

| Feature | Initial implementation | Repair 1 | Repair 2 | Sum of observed round spans |
|---|---:|---:|---:|---:|
| Campaign state | 484,744 ms | 462,595 ms | 250,423 ms | 1,197,762 ms |
| Guided locomotion | 1,707,270 ms | 783,698 ms | 193,333 ms | 2,684,301 ms |

Do not add concurrent job spans and call the result elapsed wall time.

Detailed machine records:

- [Whole wave](wave-01.json)
- [Campaign, by round](campaign-usage.json)
- [Locomotion, by round](locomotion-usage.json)
- [Astra interval usage](astra-coordination-review-usage.json)

No raw session transcripts, credential data or account-wide usage history are committed.

## Verification and remaining scope

Campaign: typecheck/build, **11 tests**, compiled scenario and dependency audit passed. Astra reproduced and required fixes for wrong canon identities, omitted obligation facts, stale representation and replay-import boundaries before accepting it. It remains an in-memory domain package, not IndexedDB/full-save transport.

Locomotion: actual keyboard traversal, authored collision, two-position fixed arena camera, pause/reset, settled resize, repeated BFCache restoration and resumed movement were exercised. The actual production build also passed `/`, `/lab`, `/lab/`, refresh and committed browser navigation. Vite was patched to 6.4.3; audit reported zero known vulnerabilities. The Three.js bundle-size advisory remains disclosed.

No final Tripo models, rig/Environment/Jev acceptance, combat, companion AI, durable browser saves, physical-gamepad certification or full-game completion is claimed. Root-hosted deployment is the current contract; a GitHub Pages project subpath is not supported.

## OMP session title

Requested title: **Game Jungle**. The current tools did not apply the live-session rename; the attempted headless resume command timed out and left the title unchanged. The supported operator command is:

```text
/rename Game Jungle
```

Run it in the active OMP TUI. The raw active transcript was not hand-edited. This does not rename the game or GitHub repository.
