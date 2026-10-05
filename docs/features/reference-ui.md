# Reference UI implementation

This document describes the DOM-only `GameUI` surface in `src/ui/`. It is a presentation layer over the shared `GameViewModel`; it does not calculate quest, party, unlock, save, or ending progression. Runtime operations are emitted as typed `UIAction` values to the application owner.

## Lifecycle API

```ts
this.ui = mountGameUI(this.overlay, {
  onAction: action => { void this.dispatch(action); },
  onPreviewHost: (host, companionId) => this.preview(host, companionId),
});

this.ui.render(nextViewModel);
this.ui.updateGamepad(gamepad);
this.ui.destroy();
```

`GameUIOptions.onPreviewHost` is optional and returns an optional disposer. It is called only for a mounted Companions preview and receives the selected `CompanionId` (or `null` when no party member is selected). The application's synchronous adapter bridges that contract to renderer `mountCompanionPreview(host, companionId, assets, { idleActionId, loader? })`, which resolves a handle with `update(dt)`, read-only `actionTime`, and idempotent `dispose()`. The adapter owns late-resolution cancellation and updates the handle from the application's existing frame only while the preview screen is active; GameUI does not create another animation loop. The component-only empty state says “Waiting for character renderer”; it never paints a still image or primitive model as a 3D preview.

`render` uses a value signature of the `GameViewModel` to avoid unnecessary work. During a primary-button press on an action button or keyed input/select it defers view-model renders through pointer completion, preventing DOM replacement between pointerdown and click. A pending screen transition cancels the stale action. For same-screen pointer state, a click renders the latest pending view model before dispatching an action computed from the pre-update model; if no click occurs, the pending render flushes on the next frame. A focused keyed control is reconciled in place (including current input value and text selection) when its view remains, then refocused without scrolling. A screen transition focuses its first visible control when no keyed match exists. Pointer and keyboard listeners, deferred frame work and preview resources are released by `destroy`.

## View-model screens and action boundary

- **Title / loading / error:** New Game creates a new run ID; Continue uses the real continue slot; loading progress and recoverable errors come from the view model. Loading errors show Retry only when `error.recoverable` and an operation ID are present. All errors expose Load Game and a typed `UIAction.return-title`; Settings is omitted while a `durable-event` commit is pending. Save Game appears only when an active campaign exists and the error is not a pending durable event. Load Game preserves existing committed slots but hides Import while a durable event is pending.
- **World-panel navigation:** the required `canOpenWorldPanels` capability controls Map/Journal/Companions toolbar visibility and keyboard/gamepad world shortcuts. The application projects it from its initialized-world policy and remains the authority for rejecting stale/programmatic actions. Title/error Settings retains Settings and Back but does not expose empty world panels. A component/simulator fixture can explicitly enable its own navigation without claiming native asset readiness.
- **Exploration / boss HUD:** vitality, dodge charges, instinct, objective, traveling party, and boss corruption/ferocity come from the current view model. Interaction prompts use authored `inputHint`/`activation` with the active `GameViewModel.bindings`; `heavy`/`ability` hints render informational RuntimeInput prompts and never dispatch direct resolve actions. Any prompt with `requiresCompanionCommand` or `playerActionId` is always informational and never falls back to a generic E/interact button. Only a direct interact prompt emits `UIAction.interact`.
- **Map:** region markers use map unlock state and an unlocked authored entrance ID. Travel emits `{type: 'travel', regionId, entranceId}`. The configured keyboard movement bindings pan the image without changing campaign state. The world-map image is the English, concept-approved M01 asset. The side illustration is an unlabelled crop from the English U03 reference plate.
- **Journal:** tracked/completed objectives and quests are read from the view model; tracking emits a typed `track-objective` action.
- **Companions:** current party cards are derived from `GameViewModel.party`; relationship tier and ability label/reason/availability come from the view model. Ability rows filter the six canonical roster IDs. Nyra's authored hidden-route action remains a separate HUD interaction with its own input requirement and is never relabeled or dispatched as `shadow-ambush`. Selection emits `{type: 'select-companion', slot, companionId}`. Tali remains a cub/NPC and is not a `CompanionId` or party entry.
- **Settings:** audio, accessibility, subtitle, glyph, motion, target-assist and deadzone controls emit typed `update-settings` patches. Keyboard/Mouse and Gamepad bindings render from separate `InputBindingMaps`; remapping emits `{type: 'remap', device, actionId, binding}`. Gamepad binding fields are read-only and capture a physical button while focused. Conflict/error text is shown from `GameViewModel.error`, not synthesized by the UI.
- **Save/load:** slots, continue state, labels, timestamps and chapter/region metadata come from `GameViewModel.saves`. Save, load, slot creation, import and export emit their corresponding typed actions; the UI does not report mock persistence success.
- **Dialogue / choice / ending / credits:** dialogue lines, speaker IDs, choice options, ending title and summary come from the view model. Continue, skip, choose, credits and return-to-title emit typed actions.

Keyboard/Mouse and Gamepad settings show independent persisted maps. Keyboard shortcuts read from `.bindings.keyboard`; gamepad menu shortcuts read rising edges from `.bindings.gamepad`; the HUD control hints and context interaction key come from the active map. D-pad edges remain UI navigation, and gameplay actions are owned by RuntimeInput. There is no hidden single-map fallback.

## Approved image use

- `public/ui/world-map-game.webp` is a player-facing 1536×960 crop of the concept-approved M01 map; it preserves geography and region labels while excluding the editorial concept footer. The source approval is recorded in `ENGLISH-IMAGE-AUDIT.json` and `IMAGE-MEASUREMENTS.json`.
- `public/ui/map-journal-illustration.webp` is a 490×290 crop of the hunter-camp illustration in `docs/production/visual-review/plates/U03.png` at source box `[1160, 190, 1650, 480]`. It is a small approved still illustration in the map side panel, not a gameplay background.
- Party portraits are direct, label-free crops of the approved English character boards, encoded as 512×512 WebP: Asha/Koro/Vara from C02; Sable from C03; Nyra/Solkar from C04. HUD portraits use circular cover framing; U04 party cards show the complete crop in a rectangular frame. No atlas-offset fallback is used.

All visible component copy is English. Player-facing strings use the English player-copy data where available; fixed interface labels in `src/ui/` are also English.

## Evidence and limits

The final headless Brave component captures are `ui-component-u01.png` through `ui-component-u04.png` at 1672×941/DPR1. U01 shows the exploration HUD and party portraits; U02 shows boss meters and three explicitly synthetic core indicators; U03 shows the full map with all eight region labels; U04 shows face-centered party cards and an empty renderer-waiting preview host. The shared fixture uses a synthetic `GameViewModel`, flat neutral field, and visible “NON-PRODUCTION UI RENDER · SYNTHETIC VIEW MODEL · NO GAMEPLAY SCENE” disclaimer. Main reported no page errors. The pointer probe retained Inspect through a deferred vitality update, emitted the intended interaction once on release, and displayed vitality 25%; Enter and the settings range update also behaved as expected. These captures and probes check the component, not application wiring, campaign persistence, native Tripo loading, character motion, or visual parity with gameplay.

U04's native 3D preview and final character parity remain unverified until the consent-gated native character assets and integrated renderer are available. `CombatSnapshot.boss.corruptionCores` supplies the authored core IDs and cleanse state; the HUD renders one indicator per entry and never infers a count from scalar corruption. U02's three-core component fixture is synthetic, not proof of live encounter visuals or boss 3D. No readiness or full-game completion claim is made here.
