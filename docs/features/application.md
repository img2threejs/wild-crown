# Full-game application runtime

`src/main.ts` mounts one `GameApplication`; this remains the existing composition root for the campaign director and IndexedDB repository, fixed-step `CombatEngine`, native-asset `GameRenderer`, DOM UI, `RuntimeInput`, and `StoryPresentation`. `GameApplication` owns the single recurring requestAnimationFrame scheduler. Mounting again on the same HTMLElement synchronously disposes the previous application before attaching the replacement, including callers of the native constructor. Disposal is idempotent and removes only that application's world/overlay nodes; a retired handle cannot erase a replacement mount.

Combat advances at 60 Hz with a maximum of five catch-up steps. The frame loop rechecks the current screen after every simulation tick and stops the batch immediately when a tick opens pause, map, journal, companion, choice, or another blocking screen. It does not continue combat catch-up behind a modal. Persisted `pagehide` clears input, pauses an active game, and cancels the scheduler once; only a persisted `pageshow` following that suspension resets frame timing and schedules one frame. Repeated or unpaired transition events cannot add recurring loops. Non-persisted `pagehide` disposes listeners, UI, previews, renderer, presentation, input, and the save connection. An IndexedDB open completing after retirement is closed rather than retained. World-operation and lifecycle generations prevent stale asynchronous loads, durable events, or previews from committing into a replaced run or disposed application.
Combat world time is explicit: overlays, title/loading/error/ending screens, and lifecycle suspension pause the `CombatSnapshot.worldClock`; normal time resumes only when gameplay resumes. RAF accumulation and discrete input edges stay unscaled, while effects and presentation consume the snapshot clock.

The same RAF renders even when no fixed simulation step was due. It retains adjacent before/after snapshots and passes the accumulator fraction to `GameRenderer.sync`, keeping actor animation and the centered camera on the same interpolated pose. Per RAF the application drives the renderer + presentation in fixed order: `GameRenderer.sync(...)` first samples the actors, environment, camera, screen-space LODs and any movable prop transforms for the current snapshot without issuing draw calls; `StoryPresentation.update(snapshot.worldClock, { position, forward, up })` then consumes the renderer's camera basis against the same authoritative world clock so socket-bound cues see the sampled pose; `GameRenderer.render()` finally issues the actual `WebGLRenderer.render(scene, camera)`. `sync` is therefore not a draw call and the previous "renders every RAF" claim refers to this sample-then-update-then-draw chain, not to `sync` drawing on its own. Simulation still advances only in fixed steps. Blocking screens, suspension, world release and explicit redraws reset render history instead of blending stale poses into resumed gameplay.

Suspension also owns transitions that finish asynchronously: an in-flight world load or event retry completing during persisted page suspension lands on Pause with gameplay input disabled and combat time paused. A programmatic Resume cannot override suspension; restoring the page restarts the scheduler but still requires explicit player Resume. Final disposal pauses combat before releasing its owned resources. The new deterministic suspension regression is implementation coverage only and remains unexecuted until coordinator verification.

New Game, Continue, explicit slot Load, Import, Export, save creation, and Travel route through the current campaign/storage APIs. Continue/Load retries retain the selected slot; import and travel retries retain their payload/route. On durable-event commit failure, the exact event and idempotency key remain queued while the app blocks menus, gameplay, save/import/export, checkpoints, and ending choices behind a full-screen error. Retry reprocesses that same event, syncs committed facts once, then resumes gameplay. Replacing the world waits for the serialized old-run event drain and reconstructs from committed facts without allowing stale loads to replace the run.

Menu history records exact opening screens, including Title→Settings→Title, Error→Settings→the same Error, and Pause→Settings→Pause. Escape and Backspace use the existing `UIAction` close/resume routing: closing the root Title or root loading/error surface preserves it instead of assuming a gameplay origin. Closing a UI-local Load/Save panel redraws its current application surface. Gameplay requires a successfully prepared renderer/region matching the current campaign, with no loading/error/blocked scene; creating a campaign or initializing storage alone does not authorize the HUD or gameplay input. Preparing another world retires the previous scene resources, and Return to Title releases the renderer/presentation as well as resetting world readiness and menu history.

Map, Journal, Companions, Hub and Settings share one tab bar, so moving between them swaps the page without adding history: Escape/Back leaves the menu for the screen that opened it (Game→Map→Journal→Settings→Back returns to Game; Pause→Settings→Journal→Back returns to Pause).

The application also rejects Pause, Map, Journal, Companions, dialogue, choice and ending panel transitions without a usable initialized world, before changing the current screen or menu history. Its required `GameViewModel.canOpenWorldPanels` projects that same readiness policy: Settings remains reachable from Title/error, but its world-only toolbar controls are absent, and keyboard/gamepad world shortcuts require the capability. Stale/programmatic controls cannot bypass the controller guard. A ready world's Settings retains normal world-panel navigation. Component fixtures set this UI capability explicitly; enabling simulator/component navigation does not certify native assets or initialized production gameplay.

Rejected world-panel navigation still renders the current surface, so successful recovery-slot creation refreshes its save rows and Export availability without granting world access or changing menu history. Accepted and unchanged transitions render once as before. Rendering a suspended, unusable gameplay surface redirects through the existing Title/error fallback rather than recursively requesting a guarded Pause.

Input bindings use explicit independent keyboard and gamepad maps (`InputBindingMaps`); browser key values and one-based `Gamepad Button N` values are not mixed, and neither device has a hidden fallback after remapping. New settings start from `DEFAULT_INPUT_BINDINGS`. Stored maps are authoritative, including deliberately empty entries; the one-time storage migration preserves legacy effective controls. `RuntimeInput` buffers discrete keyboard edges between fixed samples, preserves Heavy press/held/release semantics, uses the mapped directional actions for command-wheel selection, and prevents browser defaults for mapped keyboard inputs. Its scoped Chromium QA record is [evidence/application/input-behavior-2026-09-30.json](../../evidence/application/input-behavior-2026-09-30.json). That record covers keyboard-driven input and a synthetic gamepad only; it does not claim hardware gamepad, real blur/hide, or BFCache exercise.

Native companion abilities are projected from the engine roster and dispatched through the assigned companion's engine command; absence, cooldown, token, target, and Dominion/Bond gates remain engine-owned. Action-gated world interactions are not resolved by marker clicks: authored actor identities must resolve uniquely, and prompts carry exact placement IDs. The movable `camp-loose-snare` uses its `CombatSnapshot.movableObjects` pose for prompt location; its Koro utility-special path dispatches through `commandCompanion`, while the authored staff-heavy fallback uses the engine's Heavy-impact interaction path. App forwards the resulting `object-moved` event through the durable CampaignDirector queue and passes committed facts to the engine; the existing RAF forwards the complete CombatSnapshot to the renderer. App does not invent movement facts or run a local object tween. Marked actions display mapped controls and never use generic E. Companion previews require the exact manifest asset and `${companionId}:idle` action; the existing application RAF advances their handles only while the companion screen is active, and host removal/screen exit/disposal releases them.

Verified-policy runtime assets are read from `/assets/manifest.json`, the normalized producer manifest. That policy requires verified evidence for every required recipe, prop, actor and Orun variant. The playable candidate campaign instead projects the declared regional catalogs without changing their blocked evidence. Both policies require explicit native URLs and immutable output hashes; missing files, hash mismatches and invalid manifests fail visibly rather than substituting fake geometry. Transient transport errors remain retryable. Asset evidence remains authoritative in the producer manifest and release validator.

Build output includes `dist/release-compatibility.json` from the exported build, save, and campaign schema constants. `campaignRuntimeAssets` in `vite.config.ts` also copies the declared chapter/pedestal catalogs, their referenced native GLBs, hero portraits, scene art and biome-layer JPGs into `dist/asset-source`. Raw provider downloads, provenance reports and private evidence directories are not copied.

## Player entry and browser saves

Opening `/` in development or the built static site shows Title with the playable candidate campaign selected. **New Game → hero and companion → Begin** creates the run only on confirmation, then loads the native Greenwake scene behind its intro. Back from hero selection returns to Title without changing the existing run. Continue and Load Game read the same `wild-crown-candidate-chapter-saves` IndexedDB database; earlier candidate journeys remain available. Trials shortcuts remain DEV-only and replay-isolated.

Committed objectives, story acknowledgements and safe checkpoints autosave through the existing transactional repository. Reload the same site in the same browser profile and choose **Continue**; **Load Game** selects a particular journey. Resume uses its safe spawn/checkpoint, not the exact movement position or an unfinished combat frame. Save/Export provide explicit checkpoints/backups. Saves are local to the browser profile and site origin (including port); clearing site data, private browsing or browser eviction can remove them. There is no cloud/account synchronization.

Previously the default New Game entered `PRODUCTION_SESSION`, stopped at the evidence-blocked `greenwake-environment` gate and used a different save database from playable candidate journeys. The player route now explicitly selects candidate assets in both builds, retaining the persistent **NOT RELEASE-VERIFIED** banner. The verified manifest, verified-policy asset gate, hashes and release validator are unchanged; playable does not mean release-qualified.

Native built-site verification reached Greenwake through the ordinary Title controls, moved around actual tree collision, completed `prologue:hear-roars` with trusted E input and autosaved it. Full reload → Title Continue restored the same run, Aren/Koro, completed opening beat and objective, and displayed **Step 2: Tend to Vara** at the safe spawn. Captures: `asset-source/playtests/evidence/combat-polish/new-game-built-{objective,continued}.png`. This is default-entry and persistence evidence, not a complete campaign playthrough or asset certification.

Affected integration gate: **523 Bun tests** across app/UI/storage/campaign/content/package suites and **236 Node release/artifact tests**, all passing. TypeScript and the 325-module Vite build pass, retaining the existing large-chunk warning. The explicit verified-policy browser fixture passes all seven lifecycle checks, including zero owned frames/listeners/database handles after disposal. The full packaged runtime measures approximately **1.3 GB**; deploy the complete `dist` tree, not only its JS/CSS. Structured evidence: `asset-source/playtests/evidence/combat-polish/new-game-browser-persistence.json`.

## Strict verified-policy lifecycle fixture

The coordinator-only `/tests/app/browser-smoke.html` explicitly selects `PRODUCTION_SESSION` through its existing private observer seam, independently of the playable default. It retains real DOM, RAF, event listeners, verified manifest fetch and native IndexedDB, with a unique isolated database and cleanup. `window.__applicationLifecycleSmoke` and `#test-status` expose checks, pending application-frame counts, registered listeners and native database handles. Its genuine verified-asset errors are intentional; synthetic persisted transitions are deterministic lifecycle checks, not evidence of actual BFCache restoration.

Lifecycle checks require one pending recurring application RAF and stable listeners through recovery/replacement, zero retired-application RAFs, and zero owned frames/listeners/database handles after disposal. Physical gamepad hardware, real BFCache restoration and full authored campaign traversal remain separate acceptance criteria; candidate gameplay does not close release-qualified M01 acceptance.

## Local contextual traversal prompts

The existing E/interact binding and prompt button choose the nearest available typed in-region traversal start or ordinary interaction, using the engine's full 3D start, support/collision and worldFacts gate checks. Prompt labels are Vault, Climb low ledge, Slide and Swing; dispatch preserves the precise authored route ID. A route button is routed to CombatInput.traversalId, not resolveInteraction or a fabricated campaign event. Prompts and pending world interactions are suppressed while the engine owns an active path.

Cross-region exits are not local traversal affordances, even when remote coordinates numerically overlap the current floor. Explicit Travel still uses the existing CampaignDirector.travel/loading flow. The four authored local path scenarios have actual-engine deterministic proof; native rig/clip evidence and parent-only browser visual acceptance remain blocked separately, as detailed in combat.md. No simulation result qualifies the final visuals for release.

## Forest preparation progress

`GameApplication.prepareWorld` reports truthful world-loading progress to the UI through `GameViewModel.loading` (`progress`, `detail.stage`, `detail.phaseLabel`, `detail.message`) as one monotonic 0..1 value (`src/app/LoadProgress.ts`) over ordered, weighted phases, so 100% means the world is ready rather than "the GLB count finished". There is no timer: the value only moves when a phase reports real work. After the manifest is read and the region, recipe and assets are checked (`progress: 0`, stage `manifest`), the weights are: `manifest` 3, `assets` 58 (`GameRenderer.loadRegion`'s per-invocation callback, so a reused renderer cannot retain a callback closed over an old generation), `hero` 7, `world` 4 (actors, colliders, story state, audio), `waystone` 4 (playtests only), `effects` 10 (effect and trial-monster shader prewarm), `gpu` 8 (`warmGpu` and the first render) and `encounter` 6 (encounter start and trial gates). Each of the hero, world, waystone, effects and GPU phases is reported and given a paint opportunity (next frame, or 50 ms in a hidden tab) before its synchronous work starts, so the label on screen names the work actually running. Loading stays active until the encounter is prepared and the world is revealed; an encounter started outside a world preparation (for example Orun) shows an indeterminate loading state.

`GameRenderer.loadRegion` pre-counts the exact native-asset load operations its current plan performs: one count per static base batch (placements grouped by asset ID and 16 m X/Z cell), one count per *verified-and-available* LOD attempt (skipped LODs do not count toward the total), one count per movable prop, one count per authored actor instance, and one count for the fallback `actor-aren` player load when no region entity covers `aren`. The callback receives `{ completed, total, ratio }` starting at `0/total`, increments strictly as each operation completes, and reports an exact integer percentage scaled to 100 once every counted operation finishes. A recovered LOD attempt counts even when its batch is unavailable, and a required-asset failure throws before reaching 100% so the UI never reports successful completion without verified assets.

The loading screen renders the selected map's scene (`loadingSceneMarkup`): the phase label and a visible integer percentage (for example `0%` then `38%` while scene assets load), the detail line (`Loaded 3 of 8 scene assets`), and a `role="progressbar"` element with `aria-valuemin="0"`, `aria-valuemax="100"`, `aria-valuenow`, `aria-valuetext` and `aria-label="Loading progress"`. The lore line is chosen from progress (`floor(progress × loreCount)`), so it rotates deterministically without timers. When `progress` is `null` the bar is indeterminate and carries no `aria-valuenow`, so the UI never displays fabricated progress. Progress updates patch the scene in place rather than rebuilding it, so its animations do not restart. Region scenes are keyed by `GameViewModel.scene.regionId`: the selected playtest map, or for the production campaign the current region (Greenwake, Whispering Canopy, The Grove, Moonpine Ridge and Mistveil Basin have scenes; other regions use the Greenwake scene). The English in-game copy stays intact.

## Map intro and establishing shot

In a local playtest, choosing a hero no longer goes straight to a loading card: `select-hero` sets `mapIntroHold`, shows the `map-intro` screen and starts `prepareWorld` immediately, so loading runs behind the intro. While the hold is on, `loadingScreen()` keeps `screen` at `map-intro` and `setScreen` refuses other screens. When preparation finishes, `enterGame()` records `entryWaiting` and leaves the intro on screen. `leave-map-intro` (Continue, Skip, Enter, Space, Esc) either reveals the world at once (`entryWaiting`) or switches to the `loading` screen, and the reveal follows when the world is ready. A failed load clears the hold and shows the loading error. Play Again, Try Again, retries and the production campaign (which keeps its prologue dialogue) never show the intro or the shot.

`revealWorld()` calls `renderer.beginEstablishingShot({ seconds: 4, reducedMotion })` (`reducedMotion` is the setting or the OS preference) and, if `establishingShotActive`, sets `entryShot`: the simulation time policy stays `paused`, `RuntimeInput` stays disabled, `canOpenWorldPanels` is false, and each frame runs only `renderer.sync` on the first snapshot, `updateWaystone` and `render` (`stepEntryShot`). The shot ends when the renderer reports it finished (HUD fades in, time policy `normal`), on `skip-establishing-shot`, or at gameplay framing when a pause or blur ends it. A new run, map, retry or return to title cancels it. The sweep itself belongs to the renderer and camera director (see [full-renderer.md](full-renderer.md)).

The new code is implementation coverage only. Coordinator production-browser verification, real browser progress smoke tests, and full M01 acceptance / issue #37 (initialized native gameplay entry with verified readiness, repeated enter/exit, and asset-dependent pending-load disposal) remain centralized after sibling handoffs and are not claimed here.

## Local Greenwake movement playtest

Run the Vite development server and open `http://127.0.0.1:5173/?assetPlaytest=greenwake`, then choose **New Game → Greenwake →** one of the four heroes (Aren, Yara, Vesper or Sakda). WASD and arrow keys both move, Shift runs, F performs the hero's dodge (Dive, Petal Step, Mist Blink or Guard Dash), Space jumps and Escape pauses. The fixed 2.5D camera follows the selected hero; route, native motion and collision rules are described in [combat.md](combat.md) and [full-renderer.md](full-renderer.md).

This local scene includes the worn forest trail, dense native tree dressing, physical hard props and continuous Run/Jump/Dive recovery. Three named, tinted monsters have distinct fire/wind, frost/poison and root/fire/wind rosters. Only the current stage casts and only it takes damage. A native wood barrier opens when its stage monster is defeated; its HP shows in the encounter panel and on the label above it. Watch the native caster's body charge and natural spell flight; there are no attack borders or painted range surfaces. Committed ice and roots remain real temporary obstacles with checked escape clearance. The local arena clearings remove corresponding tree visuals and solids together; no canonical production placement changes.

Vite explicitly prebundles the lazy mesh simplifier and native-fixture GLTF exporter so their first use does not rediscover dependencies in an already running scene. This URL is development-only and uses explicitly blocked candidate assets. Local map progression does not unlock campaign regions or certify the production asset manifest.

## Local story-map playtests (Greenwake, Whispering Canopy, The Grove, Moonpine Ridge, Mistveil Basin)

Any `assetPlaytest` query opens the local map-selector flow. `greenwake`, `canopy`, `grove`, `moonpine` and `mistveil` select a preferred map; unknown/empty values default to Greenwake. A direct URL never bypasses a lock. `src/app/AssetPlaytests.ts` owns each map's candidate manifest, banner, trial set, exit, thumbnail and stage wording, in unlock order Greenwake → Whispering Canopy → The Grove → Moonpine Ridge → Mistveil Basin. The per-region asset gate requires exactly the authored environment, props, actors, trial gate, Warden glaive, Heartroot staff and Yara player variant; native assets remain explicitly unverified. The renderer recipe override carries the variant's ground-surface ids.

The selector (**Choose your path**) lists the story chapters of `docs/production/content/GAME-NARRATIVE.en.md` §6 in order from `src/app/StoryChapters.ts`: playable chapters show their map capture, cleared/locked state and monsters; chapters without a playable map (Chapter 2 Blood Bamboo Valley, Chapter 5 Sunmane Expanse, Chapter 6 The Fall of the Grove, Chapter 7 The Living Pact, Chapter 8 Heartroot Hollow) are **Coming Soon** cards cropped from the illustrated world map, carry no action and never take part in unlocking.

After unlocking and selecting a map other than Greenwake and choosing a hero, the application uses the campaign director's replay-isolated showcase start for that region (`startShowcase(runId, regionId)` with the chapter, quests and party the region expects; no campaign save slots or opening cinematic), builds the variant through `createCombatTrialRegion` (`createCanopyTrialRegion`, `createGroveTrialRegion`, `createMoonpineTrialRegion`, `createMistveilTrialRegion`), starts the map's wildlife encounter and enables its combat trials (`enableCombatTrials`) after preparing the gate model. HUD roster, gate notices, monster labels and destination use that trial set. Exits: `canopy-trial-exit` **Temple Exit**, `grove-trial-exit` **Ridge Trail**, `moonpine-trial-exit` **Temple Descent**, `mistveil-trial-exit` **Root Cavern**. Every map, including the Grove sanctuary's single Heartroot Practice, requires all of its trial monsters defeated before its exit counts. Arrival emits no campaign event or reward. Regular production gameplay remains unchanged. Map layouts, trials and presentation: [grove-playtest.md](grove-playtest.md), [moonpine-playtest.md](moonpine-playtest.md), [mistveil-playtest.md](mistveil-playtest.md).

### Map progress and entry-only heroes

Only Greenwake is initially available. Completing a map (all its trials, except the Grove's optional practice, **and** reaching `StageGoal` alive) records its clear and unlocks the next playable map in `ASSET_PLAYTESTS` order. `PlaytestProgress` persists the contiguous cleared-map prefix under `wild-crown.playtest-progress.v1`, independently of campaign saves. Invalid data cannot unlock later maps; denied storage leaves session-only unlocks with an explicit warning.

Hero selection happens only at map entry, from four heroes (Aren, Yara, Vesper, Sakda; stats and kits in [combat.md](combat.md)). Every hero uses the existing `aren` player slot; `player.heroId` chooses the kit (Vesper and Sakda run through the kit seam), and each non-Aren hero's `HeroDefinition.variantAssetId` is its native render variant (`actor-yara-hero`, `actor-vesper-hero`, `actor-sakda-hero`). Yara's NPC is removed while she is played. Mid-run/stale selection actions are rejected. **Play Again/Try Again** keeps the current hero; **Map Select/Next Map** returns through hero selection. Completion offers Next Map only when a subsequent map exists and is unlocked, and names the newly opened path and the hero who cleared it.

The selector is a single-screen character select: a four-hero roster (Aren, Yara, Vesper, Sakda: portrait crest, title, role), a live native 3D stage and a dossier. The stage (`mountHeroPreview`) loads every hero's exact native GLB with that hero's weapon on demand — Aren's glaive, Yara's staff, Vesper's katana; Sakda is unarmed and has no weapon — keeps them resident for instant switching, plays a short reveal flourish (skipped under Reduced Motion), and turns on drag. The dossier tabs are **Role & Power** (role, power, reach, difficulty, playstyle, strengths and cautions), **Stats** (relative 1–5 playstyle ratings plus live combat values), **Skills** (binding, cost, description and numbers; choosing one plays its native clips on the stage) and **Story** (canon biography and quote). Every number is derived from `HERO_COMBAT`, `PlayerSkills`, `HeartrootSkills`, `VesperSkills`, `SakdaSkills` and `evasion` constants, so the dossier cannot drift from the simulation; ratings are labelled “Ratings compare all heroes”. Browsing is UI-local; only the final **Begin … as …** dispatches `select-hero`. Aren's canon text stays pronoun-neutral, as the narrative uses they/them.

In asset-playtest mode the candidate-manifest gate treats every hero as a required dependency: each `HeroDefinition.variantAssetId` must be a native character GLB, and each hero's `weaponAssetId` (when present) a native prop GLB. A hero without a weapon asset (Sakda) adds no weapon dependency, and the manifest must contain exactly the authored dependency set. The gate still requires candidate assets to be unverified and does not grant production acceptance.


## Floating damage and local stage completion

`DamageNumbers` consumes the engine's actual vitality-loss payloads, not authored attack damage or VFX hit cues. Numbers appear above Aren or the struck actor: coral for Aren, ivory for other victims. Distinct poison pulses remain separate; lethal overkill shows only the remaining vitality lost. A bounded, preallocated DOM overlay survives HUD subtree replacement, clips off-screen/behind-camera anchors, and expires on scaled world time. Pause hides it without ageing its labels; reduced motion removes the upward drift. World replacement, return to title and application disposal clear it.

Every local playtest uses a native Warden waystone (`prop-warden-waystone`) beside its exit's landing circle. The destination HUD guides the hero to the current monster, then the named exit. Defeating every trial monster of the map — including the Grove's single practice sprig — opens the crystal halo, rune circle, light column and pooled motes; until then, standing in the exit circle does nothing. Entering the exit's 2.2 m circle alive and within 0.75 m vertically after that starts a teleport arrival: gameplay input and combat clocks stop, the selected hero celebrates and dissolves from view, and **Stage Complete** appears after 1.2 presentation seconds. Escape/Resume cannot reopen the run. **Play Again** creates a fresh run with the same hero; **Map Select/Next Map** returns through hero selection; **Return to Title** releases the scene. Reduced Motion freezes rune animation and removes motes and the arrival shockwave. The outcome card leaves the native scene visible.

This is local stage completion only: it emits no campaign completion/reward event, changes no restoration facts, and does not travel through or unlock the gated Grove exit. Normal production gameplay retains its existing asset and campaign gates.

Real lethal vitality loss opens **Defeat** and plays the selected hero's native defeat animation; the final actual damage number remains visible for 0.8 presentation seconds, then clears despite paused combat time. **Try Again** starts a fresh run with the same hero. Native outcome time is separate from simulation time and stops during document hiding/persisted page suspension; resume rebases frame timing rather than skipping the animation. World retirement clears outcome state, ghosts, combat-obstacle visuals, damage numbers and the destination.

Coordinator verification passed 745 Bun tests, 28 separate native-animation Node checks, TypeScript project compilation and the Vite build. Actual native AI/collision trials completed 20/25/30 world seconds with 9/13/18 avoided casts and no damage; the controlled fixture relocates starting poses between rooms and accelerates fixed steps, not a claimed continuous hand-played route. Trusted Run after qualification reached `(69.83482064084757, 0, 38.385399278816784)` and triggered Cheer/Stage Complete at frozen world tick 5144 with unchanged campaign JSON. Trusted Dive measured 4.8 m/25 mana; actual exhaustion and movement refill changed the highlighted skill states at 1024×768 and 1440×819. Play Again restored 100 vitality/mana and all closed gates, detached/emptied the retired gate group, and disposed all six owned gate materials exactly once; the native context remained live with GL error zero. Actual pause froze both clocks, position and resources and marked every skill Paused; Return to Title released the renderer and cleared labels. Earlier donated Defeat/damage-number, final-pose and synthetic persisted pagehide/pageshow evidence remains scoped to local candidates, not claimed real BFCache restoration or production asset qualification.

After removing the inspection fixture, the ordinary playable URL was opened in a fresh native browser session with no `window.trialApp` global. New Game/Skip loaded one real canvas and the three named stage rosters. Trusted F changed mana 100→75, supported Run refilled it to 100, and Space changed it to 92. Ready/unavailable cards rendered in the native scene, Escape opened Pause, and browser errors were empty.



## Hero/map integration verification

- Final full Bun gate: 1,196 passing tests, zero failures. Separate native-rendering Node suite: 125 passing tests, including the Z-up root-motion regression (fails on the old compensation). TypeScript/Vite production build passes; Vite retains its large-chunk warning.
- Native browser smoke loaded Aren and Yara in both Greenwake and Whispering Canopy with no asset/animation-binding errors. Real Howler windup was interrupted by Yara's Binding Vines; exposed-target Cleanse changed corruption from 60 to 20. Retry retained each hero, and a mid-run hero-selection action was rejected.
- A controlled completed-trial fixture plus trusted arrow-key movement exercised the real `StageGoal` completion path. Arrival before trial completion and completed trials before arrival did not unlock Canopy. Actual arrival persisted `{"cleared":["greenwake"]}`, opened Stage Complete and left campaign JSON unchanged. Reload restored the unlock. A fresh profile with a direct Canopy URL and forged selection remained locked. This is not a claim of hand-playing all trials again.
- Live arrows moved the actual capsule; keyboard hero navigation, native portraits and selector layouts were inspected at desktop and 390 px width. The narrow banner now ends above the heading, with no horizontal overflow.
- UI detection reports one pre-existing danger-panel left-border warning (`game-ui.css`); unrelated styling was retained rather than redesigned.

### Story-presentation review pass

- Fixed: the damage vignette started at full opacity, tinting the Title and menus red until the first in-game frame; it now starts transparent.
- Fixed: Pause hid the world behind an opaque gradient; it now dims the frozen scene and names the map and hero.
- Added: the HUD vitals panel carries the hero's crest and title; Stage Complete names the clearing hero and the newly opened path.
- Replaced the two static hero cards, whose choose buttons sat below the fold at 1365×768, with the live character select above. Browser checks covered both heroes, every tab, skill showcases, scroll retention, keyboard browsing and four enter/leave cycles. Those cycles left no stale preview canvas and produced no console warnings. Layouts were checked at 1365×768, 1024×700 and 390×844 with no horizontal overflow.
- Not a defect: a white glare seen once at Stage Complete came from all three trial gates' opening light. A test fixture had opened them less than a second before arrival, and the outcome freezes world time. Ordinary play opens them one stage at a time, well before the exit.
- Remaining recommendations (not changed): the skill bar is text-only (a drawn icon set would need authored art), and a monster label can overlap the hero at point-blank range.


### Warden waystone and story-map evidence

- Waystone arrival was exercised on all five maps with controlled qualified-stage fixtures: native pillar loaded, sealed/open visuals changed, arrival reached Stage Complete, combat time froze, the hero disappeared and campaign JSON remained unchanged. These are actual browser observations, not a claim of hand-playing every encounter.
- The Grove's three attacks and all nine attacks in each of Moonpine and Mistveil ran through their real AI rotations in the browser. Seven monster captures show active presentation effects; every capture reported WebGL error zero.
- Actual scene thumbnails are saved under `asset-source/ui/maps`; waystone and attack captures are under `asset-source/playtests/evidence/waystone`. The thumbnails use curated cameras and hide HUD/actors for capture only.
- This checkpoint passed 1,597 Bun tests and the production build. After manifest regeneration, the native Canopy/story-map asset suite passed 107 Node tests. Vite retains its large-chunk warning. Candidate manifests remain evidence-blocked; these checks do not grant production asset acceptance.

### Immersive combat evidence

- Compact HUD: panels measured at 1440×900, 960×700 and 390×844 with zero pairwise overlap and zero document overflow. Below 760 px the skill status text is visually hidden (still in the accessible name), the destination and party cards sit above the skill bar, and the controls hint shrinks to stay inside the viewport.
- Monster victory: on all five maps, standing inside the exit circle before the last stage clears left the stage open. A trusted J press took the current monster from 100 to 91 HP, and both the encounter-panel bar and the world label read 91/100. The fixture then lowered the current monster's HP and a trusted J finished it. Each defeat opened exactly its own gate, in order; arrival after the final defeat reached Stage Complete. The fixture places Aren beside each monster and lowers HP before the finishing strike; it is not a hand-played clear.
- Jump (trusted Space in the Grove): a single jump spent 8 mana and peaked at 1.25 m. A second press 260 ms later spent another 8 and peaked at 2.46–2.50 m; a press queued during anticipation peaked at 2.10 m. Holding a direction for 560 ms after take-off moved the hero 3.4 m (Aren) and 2.3 m (Yara), while a standing jump with no input lands in place. Up to five native pose ghosts were visible in flight for both heroes. Zoomed captures are under `asset-source/playtests/evidence/immersion`.
- Gate: 1,583 Bun tests, 451 Node rendering/release/asset-lab tests and `tsc --noEmit` pass.

### Combat-polish evidence (hero motion, VFX and monster attacks)

All captures are under `asset-source/playtests/evidence/combat-polish`. Skills were triggered through trusted keys or the engine's own action entry points, and each played its own native clip with live particles. No shader program failed and the console logged no errors.

**Aren in Greenwake** (`aren-combat-contact.png`)
- Light 2–4, Heavy, held Thunder Cleave, Sigil Bolt (tap L), Barrage (hold L), Judgement and Dive each played their own clip.
- Root Tether during a real boar-charge windup was accepted and spent 20 mana.
- Q Cleanse on an exposed boar lowered corruption from 80 to 40.
- Space ×2 played `aren-air-step` through rising, falling and landing. It fired two air steps, scaled the landing dust to 1.60 and blended to idle.
- The hero-select Root Tether and Cleanse captures show no mesh tearing.
- Since the combo rework (#134, `hero-skill-clips/aren-combo-ingame.webp`), J ×4 pressed inside the chain window played `aren-light-1` → 2 → 3 → 4 with each step continuing from the pose the previous one ended on.

**Yara in Greenwake** (`yara-grip-contact.png`, `yara-combat-contact.png`)
- Through idle, walk and run, the staff stays upright in her fixed fist.
- Thornshot 1–3, Root Spike, Heartroot Eruption, Sap Lance, Seed Storm, Heartroot Bloom, Binding Vines, Cleanse and Petal Step each played her own clip, with amber/petal effects distinct from Aren's cyan.
- Binding Vines staggered a winding-up boar.
- Cleanse lowered corruption from 60 to 40.
- Her boosted jump played her own `aren-air-step` with petal air steps.
- Since the sorceress rework (#134) her hand casts (Thornshot 1–3, Binding Vines, Cleanse) are cast by her left hand, and the effects follow it (`isYaraHandCast` / `leftPalm` in `ActorBounds.ts`): the launch flare, the sap trail and the drawn thorn or seed start at her palm, and the thorn eases onto its simulated path within 0.15 s (presentation only; the simulation spawn point is unchanged). Seed Storm's seeds leave the raised staff head; Sap Lance, the charges, Root Spike, Eruption and Bloom keep their staff-head and ground effects.
- Since the combo rework (#134, `hero-skill-clips/yara-combo-ingame.webp`), J ×3 inside the chain window played Thornshot 1 → 2 → 3 as one continuous casting sequence; held K played `yara-root-charge` → `yara-root-eruption` and held L `yara-seed-charge` → `yara-seed-storm`, each release opening on its charge pose.

**Monsters on all five maps** (`monster-attacks-contact.png`, `monster-greenwake-attacks-contact.png`)
- In the live AI, all 13 trial monsters went windup → commit → active on their planned clip slot, for example:
  - boar-charge: run → run → dive
  - hornbill-dive-bomb: dive
  - mire-maw-tail-sweep: tail
  - flank-pounce: jump
- At active start the rendered yaw pointed at the player (0° error).
- Moving facing matched velocity (0°).
- An offline engine smoke of the same 13 monsters found:
  - every resolved clip mapped and present in its GLB;
  - moving-facing p95 of 0°;
  - commit facing of 0°;
  - at most 3.14° at active start.
- The only outliers were two ticks of an arena-clamped boar slide (75.7°).

**Gate:** 1,652 Bun tests, 469 Node rendering/release/asset-lab tests, `tsc --noEmit` and the production build pass. The build keeps Vite's large-chunk warning. The native GLB sha256 audit matches every manifest entry: Greenwake 18, Canopy 15, Grove 17, Moonpine 15, Mistveil 15.

**Limits.**
- This is local candidate evidence, not a hand-played clear or a production asset acceptance.
- The setup is controlled: invulnerable hero, high monster HP, a closer camera.
- Smooth monster crossfade was checked from clip transitions, not from frame-by-frame video.

### Hero expansion evidence (four heroes and trial difficulty)

Browser observations were made by the main session on Greenwake (`?assetPlaytest=greenwake`); every capture reported zero shader-program failures and an empty console. Captures are under `asset-source/playtests/evidence/combat-polish`.

**Hero select**
- The roster lists Aren, Yara, Vesper (Moonshade Blade, Samurai assassin) and Sakda (Ember Fist, Muay Thai brawler).
- Vesper's and Sakda's native GLBs load in the live preview (Vesper with the katana) beside their dossiers. Vesper's pronouns were corrected to he/him.

**Vesper in game** (`actor-vesper-hero`, katana; `vesper-combat-contact.png`, `vesper-*-live.png`)
- Shadow Step blinked behind the boar and dealt 39 (26 × 1.5 backstab), leaving a death-stack.
- The Moonlit Iai chain played `vesper-iai-1..3` and reached 2 stacks.
- Thousand Cuts played charge → `vesper-thousand-cuts`, stayed untargetable, and turned the stacks into a death-mark.
- Kunai Fan and Shade Swap played their own clips; Shade Swap added a stack.
- Mist Blink kept the shared dodge action id `aren-forward-right-dive-roll`, was untargetable and left 4 violet ghosts.
- Crimson Requiem was untargetable, showed a requiem-mark and dealt 65 damage by tick 60.

**Sakda in game** (`actor-sakda-hero`, unarmed; `sakda-combat-contact.png`, `sakda-*-live.png`)
- Eight Limbs played `sakda-limb-1..2` with a held timing test.
- Tempest Stomp applied cripple (120 ticks) and armed Flurry (2 charges).
- Flying Knee was airborne (y 0.93 m mid-leap) with 8 ember ghosts.
- Echo Wave → Resonating Strike consumed the chain (echo-mark shown).
- Hundred Elbows played its clip.
- Guard Dash kept the shared dodge id with shield 25.
- Tiger's Wrath dealt 60 and was untargetable.

**Live visual tuning from these captures**
- The umbral dash ghost read pink/magenta (HDR `[1.9, 0.18, 0.85]`, opacity 0.62); it is now deep violet (`[0.85, 0.1, 1.8]`, 0.48).
- The ember dash ghost washed the hero white during Flying Knee and Tiger's Wrath (`[3.2, 1.2, 0.18]`, 0.6); it is now flame orange (`[1.5, 0.5, 0.08]`, 0.42).
- Dossier titles are 'Moonshade Blade' and 'Ember Fist'.

**Trial boss, live:** Greenwake stage 3 Root Rammer shows 286/286 HP with a BOSS chip in the encounter panel. The snapshot trial reads `{stage 3, boss true, level 2}`; earlier stages are 100 and 115.

**Offline engine smokes** (real `CombatEngine`, all 5 maps, run by worker agents)
- KitSmoke:
  - Player HP: Aren 120, Yara 85, Vesper 80, Sakda 115.
  - Every trial monster's HP, boss flag and level match the ramp: Greenwake 100/115/286, Canopy 145/160/385, Moonpine 190/205/484, Mistveil 235/250/583; the Grove is exempt at 100.
  - Player damage equals `round(authored × damageScale)` for every attack (0 mismatches).
  - Strongest boss hits are 19/27/34/38 (Greenwake/Canopy/Moonpine/Mistveil).
  - Every Vesper and Sakda skill accepted 27/27 placements, with no stuck action and no NaN.
  - Rough bot time-to-kill vs bosses (s), Aren/Yara/Vesper/Sakda: Greenwake 11.2/5.3/3.3/7.8; Mistveil 21.6/11.4/7.1/16.1. Vesper is the burst assassin and Aren the durable baseline.
- SmokeRecheck after the review fixes:
  - 1550 kit dodges across all stages, placements and directions ended on supported capsule poses (522 shortened at edges).
  - 22 targeted/cone skills dealt 0 damage and 0 interrupts through a wall or a closed trial gate.
  - Sakda Echo Wave → Flying Knee → Resonating Strike → Guard Dash → Flying Knee chained on all 5 maps; Vesper Iai → Shadow Step / Mist Blink chained after the active frame.
  - 0 monster attack starts while the hero was untargetable across 1343 casts.
  - Roundhouse is an 18 kick plus a separate 8 ring; Flurry was spent only on contact.

**Gate:**
- 1,877 Bun tests pass with 0 failures, across 117 files.
- 489 Node rendering/release/asset-lab tests pass, including the Vesper and Sakda anatomy tests.
- `tsc --noEmit` reports no errors, and the production build passes.
- Aren starts at 120/120 and Yara at 85/85 in a live Greenwake run.

Two earlier full runs showed slow tests exceeding Bun's 5 s default while asset jobs were loading the CPU. Those tests now carry explicit timeouts in their files' existing style. The dodge-clip VFX test now builds one presentation per hero rather than ten.

**Limits.**
- This is local candidate evidence, not a hand-played clear or a production asset acceptance.
- The setup is controlled: high-HP target, close camera, injected Instinct/mana.
- Balance numbers come from a scripted bot.
