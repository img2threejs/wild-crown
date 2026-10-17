# Beta handoff — 2026-10-17

## Delivery intent

The user requested that the character VFX proposal be retained, a handoff be recorded first, and the current playable beta then be pushed to the repository. This is a beta snapshot, not release acceptance or a claim that the complete game is finished. No VFX implementation is authorized by that request.

- Repository: `img2threejs/wild-crown` (private; authenticated repository access checked).
- Existing working branch: `task/62-dialogue-lines-20261005-a`.
- Base observed before publication: `f35fd6a7bf7f24fc28ce9a4402fed21fd7498247`; branch and its configured upstream were aligned.
- Commit author resolved from the existing workspace configuration: `hoainho <nhoxtvt@gmail.com>`. Do not rewrite identity or global configuration.
- Publication status at handoff creation: **not committed or pushed yet**. Do not treat this document as evidence that publication succeeded; the final Git push result and remote branch SHA are authoritative.

## Preserve the VFX proposal

[Character VFX proposal](../features/character-vfx-proposal.md) remains **proposal only**, with no new VFX runtime, assets or dependencies implemented from it and no visual/performance acceptance.

Scope: Aren, Yara, Vesper, Sakda and Koro, Vara, Asha, Sable, Nyra, Solkar. Direction: **Dark, Living, Forceful**, with distinct elemental materials, readable native animation, actual simulation contact timing and no gore. Keep current gameplay, save formats, models/rigs and CameraDirector authority.

The proposed first approval gate is Vesper's Moonlit Iai/Mist Blink, Aren's Thunder Cleave and Koro's Mending Seed. These are proposed visual proofs before the full four-hero/six-companion implementation, not an approved reduction of scope. Do not automatically begin that work after publication.

## Current playable entry and persistence

- `src/app/SessionConfig.ts` selects candidate chapters for the default root entry in development and production builds. `PRODUCTION_SESSION` retains strict verified-asset policy; candidate saves are isolated in `candidate-chapters` scope.
- New Game chooses the hero before constructing the new run. The observed default path was Title → New Game → Aren & Koro → Begin → native Greenwake.
- Continue and manual Load Game use the existing browser database and resume a safe campaign checkpoint, not an exact saved coordinate.
- Saves are local to the browser profile and origin. Clearing browser storage, changing profile/host/port or using another device does not carry that save automatically. This is not cloud synchronization.
- `vite.config.ts` packages the candidate catalogs and their native runtime assets, hero portraits, region artwork and biome textures into the build. Deploy the complete distribution, not only its JavaScript or `public/` directory.
- The `assetPlaytest` shortcut is development-only and selects the separate Trials path. Trials progress is not campaign history.
- The visible candidate banner remains required: `CANDIDATE CHAPTERS · GENERATED ASSETS · NOT RELEASE-VERIFIED`.

## Existing runtime evidence (previous implementation round)

Evidence: [`new-game-browser-persistence.json`](../../asset-source/playtests/evidence/combat-polish/new-game-browser-persistence.json), with adjacent `new-game-built-objective.png` and `new-game-built-continued.png`.

Observed on the standalone built application at `http://127.0.0.1:5185/` in coordinator-owned headless Brave, 1440×900 DPR1:

1. New Game entered native Greenwake with Aren and Koro.
2. Trusted WASD exercised native tree collision; trusted E completed `prologue:hear-roars`.
3. Reload → Continue retained the same run, hero, party and objective, then resumed at Step 2, Tend to Vara.
4. Manual Save → full reload → Load Game restored that run and checkpoint.
5. Candidate disclosure remained visible.

That round recorded 523 passing Bun tests, 236 passing Node release tests, a successful TypeScript/Vite build and seven passing strict native lifecycle scenarios. These are historical observations, not a fresh claim that every campaign chapter, hero/companion combination or release gate was exercised. The local port and browser database are not portable deployment or save artifacts.

## Publication checks

- **Build:** `bun run build` with Node 22.22.3 passed (`tsc -b` and Vite 6.4.3, 325 modules). The existing >500 kB chunk warning remains.
- **Node native/rendering/release/asset-lab suites:** `node --test tests/rendering/*.test.mjs tests/release/*.test.mjs tests/asset-lab/*.test.mjs` completed in 214.62 seconds: **823 passed, 1 failed, 824 tests**. The failure is `tests/rendering/aren-native-animation.test.mjs:1679`, within “plays the resolved monster clip for non-player actors and keeps snapshot actions otherwise”: the assertion expected `['play', 'vara-idle', 'idle']`, while the observed call was `['play', 'vara-idle', 'active']`. This publication does not change the assertion or claim the complete suite is green.
- **Initial broad Bun invocation:** `bun test ./tests ./packages/campaign/test` also selected Node `.test.mjs` files and timed out at 300 seconds without a suite verdict. The explicit TypeScript-only invocation below completed; the timeout is not counted as a pass.
- **Isolated Bun TypeScript suites:** explicit `./.../*.test.ts` file paths under `tests/` and `packages/campaign/test/` (172 files) completed in 286.70 seconds: **2,306 passed, 0 failed**, 728,133 expectations. Keep Node `.test.mjs` files on the separate Node runner.
- **Fresh built-browser smoke:** on the rebuilt standalone distribution at `http://127.0.0.1:5185/`, Title → Continue restored native Greenwake with Aren/Koro, Step 2 “Tend to Vara”, full vitality/mana and the candidate banner. Escape opened Pause; Return to Title → New Game opened the four-hero/six-companion selection with “Begin with Aren & Koro”. Back returned without starting another run. Page errors and error-level console entries were empty. Screenshot: [`beta-continue-2026-10-17.png`](../../asset-source/playtests/evidence/combat-polish/beta-continue-2026-10-17.png).
- The fresh screenshot's observed rendered layout was 800×519; the browser helper reported a different viewport and did not honor the requested 1440×900. This smoke is not a responsive-layout acceptance claim. The managed Brave tab was closed afterward.

These are beta observations, not production/release acceptance. Keep the failed test and unmeasured limits visible.

## Asset and repository boundaries

The working tree contains a large set of earlier campaign/combat/companion/audio/native-asset changes, not only the New Game fix and this proposal. The inventory measured approximately 10.01 GB of changed/untracked files under `asset-source/generated`; that includes raw provider intermediates, not just required runtime models. A beta publication must deliberately choose its asset scope rather than stage the entire directory blindly.

The user selected **Beta + runtime assets**, not the full raw-source archive. Before this handoff/screenshot were added, the proposed included changed files measured 883,978,786 bytes across 1,088 paths; excluded changes measured 9,199,140,490 bytes across 1,327 paths. The built distribution contained 165 packaged `asset-source` paths; all are required to exist in the published checkout, whether unchanged or newly committed. No packaged runtime path was inside `tripo-out`.

Approved inclusion: changed code/tests/packages, intentional font dependencies and lockfile, public audio/portraits/manifests, authored source tooling, candidate runtime assets with reports/provenance/visual evidence, feature/production docs, referenced plans/postmortems, product context, this handoff and the VFX proposal. Exclude raw `tripo-out` downloads, generated `result.json` files and provider `*tripo-log.jsonl`, `.impeccable` local tool metadata and `scripts/_wmap.mjs` scratch. Preserve excluded files locally. This is not a complete offline archive of every provider input required to regenerate all authored assets.

Both generic GitHub SSH and the configured personal SSH alias rejected public-key authentication. The existing HTTPS origin successfully returned the branch SHA, and authenticated GitHub repository inspection reported private visibility and ADMIN permission. The approved publication uses that existing HTTPS route without embedding a token in the remote URL or changing credentials. No remote/global configuration changes are required.

- Include the code, runtime dependencies, required native candidate assets, provenance, authored feature documentation, this handoff and the retained proposal in the approved publication scope.
- Keep dependencies, `dist`, caches, credentials, raw unrelated session transcripts and signed provider URLs out of Git.
- Do not mistake intermediate provider `task.json`, duplicate animation/model downloads or rejected candidates for required deployed assets. Preserve any excluded local files; do not delete them to obtain a clean status.
- Existing Git LFS rules cover most source model/image/video assets. Ensure required LFS objects are uploaded; a pushed pointer alone is insufficient.
- Do not change evidence status to `verified`, regenerate assets, rerig models, force-push or merge to `main` as a side effect of this snapshot.

## Known limits and next owner actions

1. Generated GLBs remain candidates; user asset approval, applicable production/environment gates and reference-hardware performance evidence are still required.
2. Full campaign/endings acceptance, physical-gamepad certification and cross-device saves are not established by the recorded New Game scenario.
3. Existing Three.js bundle-size warnings are not proof of runtime failure or of acceptable performance.
4. Root-hosted deployment is supported; the current `base: '/'` build does not establish GitHub Pages project-subpath support.
5. After publication, retain the VFX proposal without implementing it. Resume only the user's next approved task; use this handoff, feature docs and actual evidence instead of machine-local sessions.

No workers were dispatched for this handoff/publication task. Request/token counters are unavailable and are not asserted to be zero.
