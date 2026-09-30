# Full-game implementation contract

## Acceptance authority

The user explicitly rejected the first three PRs as insufficient prototypes. They remain reusable parts, not release acceptance. Implement the entire P0–P13 plan. The English approved plates U01–U04 are the visual authority for HUD/map/journal/companions. A new unrelated demo UI, pasted gameplay screenshot, primitive substitute for a final character, no-op interaction, shortened campaign or unverified rig is not an acceptable replacement.

Luna authors implementation. Astra reviews actual code and runtime. Work continues through dependencies and corrections; no readiness claim until full criteria pass. The latest user instruction authorizes the coordinator to merge each verified increment into main and push immediately, without creating new PRs. The local feat/full-game-integration worktree combines feature work for integration; only reviewed, scoped increments are committed and published.

## Workspace and ownership

Canonical runtime/asset workspace: `/Users/nhonh/Documents/personal/wild-crown-worktrees/full-game`.

Parallel workers own disjoint paths, never commit/push or edit another worker's files. Shared contracts are established by the campaign/runtime owner first, following this document; that owner announces the exact exports to other workers. Contract changes must be communicated before consumers are changed. No worker rewrites the current main.ts/package.json until the later integration assignment.

- Campaign/state owner: `src/game/contracts.ts`, `src/game/campaign/**`, `src/game/storage/**`, `src/content/**`, corresponding tests, `docs/features/full-campaign.md`.
- UI owner: `src/ui/**`, `public/ui/**`, `docs/features/reference-ui.md`, UI evidence. No simulation or persistence ownership.
- Combat owner: `src/game/combat/**`, `src/game/companions/**`, corresponding tests, `docs/features/combat.md`.
- Asset/toolchain owner: `scripts/assets/**`, `public/assets/**`, `asset-source/**`, `toolchain/**`, asset manifests/evidence and `docs/features/asset-pipeline.md`. No private credentials in repository files.
- Environment/render owner (subsequent wave): `src/rendering/**`, `src/world/**`, environment evidence. No substitute characters or UI screenshots as 3D scene.
- Integrator (subsequent Luna assignment): `src/main.ts`, root package/build/config, input/application lifecycle, wiring of the modules above, deployment/CI.

Existing `packages/campaign` is the ending/history domain authority. Reuse it; if a missing capability genuinely requires an exported change, find callers first and migrate them cleanly. Do not introduce a second ending predicate.

## Coordinate, clocks and data

- World is right-handed, meters, Y up. Character asset forward is recorded per manifest and normalized once at the presentation root, not by rewriting native skin binds.
- Fixed simulation 60 Hz. Input intent, collisions, hit windows, costs, AI, quests and choices use simulation time. UI and loading may use unscaled time. Pause/tab hide cannot accrue catch-up damage.
- Positions in cross-module contracts are serializable `{x,y,z}` values; presentation may use reusable Three.js vectors internally. Source rig/animation timings never dictate world rewards.
- Stable IDs for actor, faction, region, quest, objective, attack, action, clip and event instance. Do not infer semantics from a provider clip name or mesh display name.

## Shared interfaces to declare in contracts.ts

Use explicit discriminated unions rather than generic arbitrary command payloads. Contracts must cover:

1. `RegionId`, `ActorId`, `CompanionId`, `QuestId`, `ObjectiveId`, `AttackId`, `ActionId`, `Vec3`, `GameSettings`, `InputFrame`.
2. `RegionDefinition`: bounds/ground/navigation/ribbons/camera anchors; authored entrances/exits; entities/interactions; encounter definitions; restoration states; asset IDs. All five regions plus Greenwake, Grove, refuge and Hollow have real definitions.
3. `QuestDefinition`: title, description, prerequisite predicates, ordered/branching objective graph, world-event requirements, optional/required status, consequences and callbacks. Distinct objective mechanics, not every quest auto-completing by touching a marker.
4. `CampaignSnapshot`: run/schema/chapter/region, active/completed objectives, fragments, factions, party, world facts, last safe checkpoint, choices and historical Dominion. Reuse the existing domain package's state types where applicable.
5. `ActorSnapshot`: stable ID/species/allegiance, position/velocity/facing, action ID/phase/normalized time, vitality or Ferocity/Corruption, target, sockets/semantic interaction requirements, visible/downed/possessed states.
6. `CombatSnapshot`: actors, player resources, dodge charges/Instinct, active encounter/boss phase, telegraphs/hazards, target, combat events. Physics authority is independent of a Three.js object.
7. `GameViewModel`: current screen, loading/errors, HUD, campaign/journal/map state, party/abilities/relationship, settings/bindings, dialogue/choice/ending. UI derives its display from real state; it does not fabricate combat numbers.
8. `UIAction`: new game/continue/pause/resume/open map/open journal/open companions/open settings/close; save/load/import/export; mark objective/select companion/issue command/use ability; choose/travel/update settings/remap/skip cinematic. Define required fields for each case.
9. `WorldEvent`: semantic interaction, enemy encounter resolution, rescue, restoration obligation, fragment, choice, traversal and chapter transition. Every durable effect has an idempotency key. Render/VFX events cannot write history.
10. `AssetManifestEntry`: id/kind, Tripo source task and hashes, runtime URL, material/LOD/rig family, clips/action mapping, coordinate transform, sockets/collision proxy references, provenance and current evidence status.

## Module public surfaces

Campaign/state owner declares concrete APIs and announces them early:

- `CampaignDirector`: new campaign/showcase, snapshot/subscribe, semantic event processing, choices, party selection, travel/unlocks, checkpoint capture/restore and ending query.
- `SaveRepository`: IndexedDB initialization; transactional checkpoint+run-ledger storage; slots; settings; import/export; schema validation/migration; quota/corruption/future-schema errors with recovery. No browser storage promise backed only by an in-memory map.
- Store flags and graph accessors must be consumable by renderer, combat and UI without exposing IndexedDB or mutable DOM state.

Combat owner:

- `CombatEngine`: load authored encounter/actors; input/command; fixed-step update; read-only snapshot; consume events; reset/restore safe encounter state.
- Cover movement/combat strafe, targeting, all 17 evasion entries, staff/tether/cleanse, token scheduling, companions and all six bosses. Full authored phase data and interruption policies are required.
- Encounter behavior consumes shared region/content definitions. No duplicate quest/ending implementation.

UI owner:

- `GameUI` mount/render/destroy and explicit `UIAction` callback. A preview host element allows an actual 3D companion preview renderer to attach.
- UI actions must be wired by the integrator to functioning runtime operations before acceptance. Isolated visual inspection is not full-game completion.

Renderer owner:

- `GameRenderer` lifecycle/loadRegion/sync/input-camera basis/capture/companion-preview surfaces.
- Native GLTFLoader scene, preserved skin joints/inverse binds, per-instance skeleton isolation, motion/action synchronization, material/LOD/instancing, terrain/water/vegetation, camera rails and occlusion, story VFX and sound anchors.
- Do not silently use a primitive character or static screenshot when a required model/clip fails. Show an honest loading/error state and preserve the previous valid scene until required assets are ready.

## Campaign/content obligations

Author the complete supplied campaign: prologue, eight chapters, 15 named main quests, five distinct return beats, 12 side quests, all six bosses and all three endings. Preserve full-game 8–12h as a playtest acceptance target; do not inflate timers, repeat enemies or hardcode a duration to pretend it has been measured.

- Canon: Sky from prologue, three fragments after Asha; six unique aspects.
- Koro provisional help in showcase is not full recruitment.
- Wolves have Ruun/Luma leadership and Sable envoy; Ghor is not Nyra and not a recruitable faction leader.
- Exile Solkar uses council representation; every mandatory mechanic has an absence-safe route.
- Chapter 6 retains services at refuge and converts coercion to Ask/Signal.
- Chapter 7 forms coalition, not an automatic ending award.
- Historical leader Dominion is monotonic within the run across normal loads/imports. Replay/showcase never imports rewards into campaign.
- Named regional obligations from the existing package must be fulfilled by real quest/interaction events, not a generic `allComplete=true` cheat.
- No player lethal combat/gore. Tali is noncombat and mandatory rescue failure resets safely.

## Visual parity contract

Use `docs/production/visual-review/plates/U01.png` through U04.png (English versions) and M01/M02 as design references. Measure relative panel bounds and safe margins at the same viewport. Preserve forest-charcoal/ivory/brass, serif display hierarchy, clear sans body, two dodge charges, separate Instinct, boss Ferocity/Corruption, correct hornbill/monkey/tiger portraits and three party roles.

Do not retain the large Movement Lab title/control dock as production UI. No sci-fi neon, loot-rarity panels or unrelated menu categories. HUD state changes with exploration/combat; map/journal and companions match the approved two-column compositions. Raster cartographic artwork is allowed for the map; raster gameplay screenshots are not a substitute for the playable 3D scene. Avatar/companion rendering must use the actual approved asset or a clearly marked not-ready state until available, never a falsely labeled substitute.

All displayed strings, subtitles, choices, menus and errors are English. Add missing finished English dialogue/content with source/design context rather than empty strings or placeholder promises. Existing exact dialogue lines remain unchanged unless a canon correction requires it.

## Asset and consent boundaries

Tripo availability/user permission is established. Discover and use the existing `tripo` CLI and its safe credential storage; never print keys. Read `tripo docs` and deterministic command help before requests. Preserve generation task IDs/output metadata/hashes and source GLB immutability. Final assets must not depend on temporary provider URLs.

Before any workspace-reference host image-processing in the Environment workflow, require the workspace-specific image consent; Jev disclosure consent is separate. Do not grant either on behalf of the user, bypass qualification, route an unqualified forest as a room, or report unknown gates as pass. Report an actionable missing consent early while continuing independent local/non-image work.

Build subject-specific source/reference/rig evidence. Four missing character measurement producers must be implemented against actual loaded GLB, not fabricated data. Species-specific applicability/equivalent checks are explicit. Production geometry cleanup/LOD precedes the frozen rig-only stage. Any authored missing animation must visibly deform the real rig and satisfy contact/transition checks.

## Verification before readiness

Every package is integrated on the real game route before marking its feature accepted. Full game requires normal-input end-to-end playthroughs, branch/absence/save recovery tests, visual reference comparisons, actual asset/rig/env evidence, accessibility and performance on recorded hardware, and production-build paths. A build pass, screenshot, CLI scenario or successful provider task alone is insufficient.
