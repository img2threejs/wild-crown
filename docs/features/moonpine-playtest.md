# Moonpine Ridge playtest (Chapter 3)

Local playtest map for GAME-NARRATIVE section 6, Chapter 3: pine forest, cold mountains, fog, a frozen lake, wolf caves and stone ruins. Ruun has vanished; his traditionalists and Luma's reformers are splitting the pack, and a three-beat howl rises from beneath a buried temple where Ruun is chained and his howl spreads Black Sap. The play is nonlethal: the three monsters are corrupted pack wolves, and each is cleansed (turns neutral) when its trial is cleared. It follows the Whispering Canopy playtest in every layer (see "Whispering Canopy playtest" in `combat.md`), so this page only records what is specific to Moonpine.

Per-map files (everything else is a shared registry that spreads these exports):

|Layer|File|
|---|---|
|Gameplay data: trials, attacks, encounter, monster profiles, actors, owner glow, solid profiles, chain anchors|`src/game/combat/MoonpineContent.ts`|
|Region variant (walk-mesh, route, cameras, exit, entities, props)|`src/game/combat/MoonpineTrialRegion.ts`|
|Boundary dressing (pines, snow rocks)|`src/world/MoonpineBoundary.ts`|
|Terrain geometry: temple massif, mountains, lake, gorge carve|`src/world/MoonpineTerrain.ts`|
|Biome (layers, understory, atmosphere), ice sheet, snowfall|`src/world/MoonpineBiome.ts`, `MoonpineIce.ts`, `MoonpineAtmosphere.ts`|
|VFX kits and auras|`src/effects/vfx/MoonpineKits.ts`|
|Procedural sounds|`src/audio/MoonpineSounds.ts`|
|Monster clip plans and locomotion|`src/rendering/MoonpineMonsterProfiles.ts`|
|CC0 ground textures|`asset-source/textures/moonpine/<layer>/`|
|Tests|`tests/combat/moonpine-trials.test.ts`, `moonpine-sealed-route.test.ts`, `tests/world/moonpine-world.test.ts`, `tests/effects/moonpine-kits.test.ts`, `tests/rendering/moonpine-monster-profiles.test.ts`, `tests/audio/moonpine-audio.test.ts`|

## Region variant

`createMoonpineTrialRegion(authored)` returns a variant of the authored `moonpine-ridge` region; the canonical region in `later-acts.ts` is untouched. All walk-surface ids start with `moonpine-trial-` (`MOONPINE_SURFACE_PREFIX`), which is how `biomeProfileFor` gives only the variant its biome. The route runs west to east along z = -22, then south. Aren starts at the first navigation node (-66, 0, -22) (arrival from the Grove); Vara (`moonpine-vara`) stands at (-69, 0, -21).

|Surface|Floor|Material|
|---|---|---|
|`moonpine-trial-trail` (spawn)|y 0|`moonpine-trail-snow`|
|`moonpine-trial-lake-shelf` (Arena 1, octagon, apothem 10)|y 0|`moonpine-frozen-lake`|
|`moonpine-trial-shore-path` (6.5 m wide)|y 0|`moonpine-trail-snow`|
|`moonpine-trial-log-bridge` (3.2 m wide, not terrain-backed)|y 0|`moonpine-bridge-deck`|
|`moonpine-trial-hollow` (Arena 2, octagon, apothem 10)|y 0|`moonpine-trail-snow`|
|`moonpine-trial-hollow-path`|y 0|`moonpine-trail-snow`|
|`moonpine-trial-temple-stair`|ramp y 0 to 4 along +x|`moonpine-trail-snow`|
|`moonpine-trial-temple-terrace` (Arena 3, octagon, apothem 11)|y 4|`moonpine-temple-flags`|
|`moonpine-trial-temple-path`|y 4|`moonpine-temple-flags`|
|`moonpine-trial-temple-descent`|ramp y 4 to 0 along +z|`moonpine-trail-snow`|
|`moonpine-trial-exit-landing`|y 0|`moonpine-trail-snow`|

The bridge deck is the one surface that is not terrain-backed: the log-bridge model (`prop-moonpine-log-bridge`, 12 m long, stretched to an 11.2 m span) is its only visual and the gorge is carved 7 m below it. Corridor edges lie on the terrain's 0.25 m grid so the ramp edges stay exact against the terrain mesh (2 cm, tested). Props: the log bridge (`moonpine-trial-bridge`), the buried temple (`prop-buried-wolf-temple`, (47, 4, -45)), four chain-anchor posts (`prop-temple-chain-anchor`, `MOONPINE_CHAIN_ANCHORS`, on the plateau behind the terrace rim, never in an arena), three snow rocks round the hollow, seven pines, and the deterministic boundary dressing (`moonpine-boundary-*`, 120 placements: 62 pines `prop-moonpine-tree`, 58 snow rocks `prop-snow-ridge-rock`).

The exit `moonpine-trial-exit` is a copy of the authored `ridge-mist-out` route (to Mistveil) without its `unlockFact` and with no colliders; it starts at (47, 0, 15), the stage goal ring, on the exit landing beyond the Temple Descent ramp. Six cameras use the fixed (+10, +12, +14) offset.

## Trials

|Trial|Monster (actor / asset)|Spawn|Arena|Gate (x, z)|Roster|
|---|---|---|---|---|---|
|Frozen Shore|`moonpine-frostfang` Frostfang Tracker / `actor-frostfang-tracker`|(-44, 0, -22)|(-46, 0, -22) r 8, on the lake shelf|(-29, -22), spans z, on the shore path|pack rush, ice bite, frost breath|
|Scout's Hollow|`moonpine-scout` Howl Scout / `actor-howl-scout`|(8, 0, -22)|(6, 0, -22) r 8, in the hollow|(20, -22), spans z, on the hollow path|flank pounce, claw rake, low howl|
|The Alpha Below|`moonpine-ruun` Ruun, the Chained Howl / `actor-ruun-chained-howl`|(49, 4, -24)|(49, 4, -22) r 8, on the terrace|(47, -5), spans x, on the temple path|chain pounce, howl shockwave, breaking ice|

Each gate is a 9 m box (1.25 m of void to each side of the 6.5 m corridor) that seals the only route forward; `tests/combat/moonpine-sealed-route.test.ts` runs the shared brute-force sealing harness (flood fill, Run/Dive/Jump chains in 16 directions) plus real-engine walks from the spawn to the exit with 0, 1, 2 and 3 gates open: the exit is reachable only after trial 3. Each gate opens when its monster is defeated, in order (`frozen-shore`, `scouts-hollow`, `alpha-below`); `tests/combat/combat-trials.test.ts` proves for every map that only a defeated current monster opens its own gate and that time, movement and dodges never do. No `encounter-resolved`, `restoration` or `fragment` event is emitted.

Monster profiles (`MOONPINE_MONSTER_PROFILES`): Frostfang radius 0.8, band 4.5-7.5 m, advance 4.6, circle 3.2, retreat 3.6 m/s (steady aggressive hunter); Scout radius 0.7, band 3.5-6, advance 5.6, circle 4.8, retreat 4.6 (fast flanker); Ruun radius 1.1, band 5-8, advance 2.8, circle 2.0, retreat 2.4 (heavy controller). All three are `species: 'wolf'` actors (hostile wild). Identity glows: ice, wind, sap.

## Attacks

None of the nine ids contains an obstacle word (`root|sap|stomp|march|seismic|trample|thorn|charge`), and none is `heartroot`. The pack rush uses a charge **lunge**, never a charge id. Only the two deliberate ice attacks raise ice pillars on the flanks of their landing mark.

|Attack|Hazard (kind, size, height, damage)|Windup / commit / active / recovery|Movement and extras|
|---|---|---|---|
|`frostfang-pack-rush`|sweep 1.8 x 8 from the caster, 0.9, 14|54 / 12 / 18 / 46|charge along the whole lane|
|`frostfang-ice-bite`|sweep 1.6 x 5.5 from the caster, 0.7, 13|40 / 12 / 8 / 46|step lunge 3 m|
|`frostfang-frost-breath`|cone 6 x 7, 1, 9 (ice)|54 / 12 / 14 / 50|slow 0.65 for 90 ticks; ice pillars|
|`howl-scout-flank-pounce`|strike 2.2 x 2.2, r 1.8, 0.3, 13|48 / 12 / 9 / 44|step lunge 5 m during commit|
|`howl-scout-claw-rake`|sweep 2.8 x 4.4 from the caster, 0.8, 11|38 / 12 / 8 / 42|step lunge 2 m|
|`howl-scout-low-howl`|wave 6.5 x 1.4, 0.18, 9|54 / 15 / 14 / 48|1 m push on hit; jump it|
|`chained-ruun-chain-pounce`|strike 3.4 x 3.4, r 2.6, 0.3, 18|66 / 15 / 10 / 56|step lunge 4 m|
|`chained-ruun-howl-shockwave`|area 6.6 x 6.6, 1.2, 12|60 / 15 / 14 / 54|1.5 m push on hit|
|`chained-ruun-breaking-ice`|wave 8 x 1.6, 0.2, 12 (ice)|60 / 15 / 14 / 52|slow 0.7 for 80 ticks; ice pillars; jump it|

Counterplay cues are plain English like the canopy cues. Wolves keep to their archetypes: the tracker punishes standing still with a lane and a bite, the scout pressures with short strikes and one low wave to jump, Ruun asks for space (large disk, marked ground, wave).

## Presentation

* **VFX** (`MoonpineKits.ts`): nine kits, attack id = kit id, three phases then decay, footprint-bound (ground quads, crystal spikes, clouds and rings are only ever placed inside the cue footprint, tested at every phase). Frost/ice for the tracker and the breaking ice (crystal spikes, shards, frost fog), wind for the scout (claw crescents, howl rings, powder snow), earth and black-sap for Ruun (chains drawn as beams from his body to the four anchor posts through the pounce and the howl, the three-beat howl as three rising rings, shock rings and a sap flash). Reduced effects keeps every kit readable with fewer particles. `MOONPINE_AURAS`: tracker `frost`, scout `earth`, Ruun `howler`.
* **Audio** (`MoonpineSounds.ts`): procedural layers for every phase of the nine attacks and one roar per wolf (guttural snarl-bark, yipping high howl, deep chained howl), inside the shared wildlife voice pool (cap 6) and the Warden level/length/layer budgets.
* **Animation** (`MoonpineMonsterProfiles.ts`): a clip plan per attack (the howls play the `monster-roar` slot; the rush revs the run cycle before the dive lunge) and a `LOCOMOTION` entry per wolf asset; no wolf hovers.

## World

`MOONPINE_BIOME` gives the variant. **Ground:** off-trail ground is snow. The shared splat shader draws layer 0 (litter) and layer 1 (the "moss" slot, weighted by route proximity and moisture) over all open ground, so both are snow sets (`snow_cover` = `snow_02`, `ice_bed` = `snow_03`), graded bright and blue-white by their layer tints (measured mean texture x tint = about `0xd9dce8` and `0xc9ccd0` before lighting). `pine_needles` (`forest_ground_04`) carries the worn trail core and `rocky_trail` its shoulder, so the trail stays a warm brown band on the snow. The brown Poly Haven `cold_rock` (`rock_face_03`) is layer 4 and only serves cliffs, open steep slopes (thresholds raised to slope 1.0 to 1.9 so gentle ground stays snow), the gorge bed and frozen banks; its rock/bed/mud grades (tints 0.5/0.8/2.0 and similar) turn it blue-grey (about `0x5f5f6e`). All five sets are Poly Haven CC0 1k with `provenance.json` in the canopy schema, 13 MB in total.

**Clutter** cannot be made to look right in snow with the shared green recipes (fern, log and root colours are baked dark green and moss in `GroundClutter.ts`, and the per-recipe tint can only darken them), so the ridge uses none of them. Its recipes are `pebble` (the mesh is white, so the final colour is exactly the tint: dark frost-shattered stones `0x59606a 0x4a515b 0x6b727c` and pale snow-capped boulders `0xe6eef7 0xd5e0ee 0xc4d2e3 0xb8c6d8`, the latter scattered as 0.14-0.44 m boulders over the open ground), `twig` (white mesh: grey-brown bark `0x3a2e24 0x46382b 0x4a4038 0x5b5047` for twigs, 1.1-2 m fallen branches and half-buried roots) and `leaf-pile` (pine-needle drifts: the brown vertex colours graded by cool tints to dull dark brown `0x30 22 12` to `0x64 42 1c`), plus the grass blades, now pale blue-grey tipped white (`0x7d8a88` to `0xe4ecee`) and sparse (30 % clump probability). A test asserts that no fern, broadleaf, log, root or mushroom instance exists.

**Lake:** the terrain raises the temple plateau and the stair hillside (summits) and a mountain wall north and west behind the route, carves a deep gorge with a frozen creek under the log bridge (at least 6 m below the deck), and a dish under the lake. The lake is one ice sheet (`MoonpineIce`, polygon offset against the terrain, clear-coated physical material for a glossy sheen). Its 512 x 512 tiling procedural texture has no cell lattice: three crack networks (long dark blue fractures, mid white cracks, faint hairlines) follow the wandering contours of domain-warped periodic noise, over large darker deep-water patches, frost drifts and trapped bubbles (a test checks the crack detail has no autocorrelation peak at any shift from 1/12 to 1/3 of the tile). Vertex colours darken the lake towards its centre (five concentric rings, deep blue at the middle to frosted white at the shoreline), and the walkable shelf sheet is a lighter frosted blue-white so it reads apart from the lake. The shoreline and shelf are unchanged. No ribbon crosses the shelf, so no trail is worn into ice and no trail dressing lies on it. `MoonpineAtmosphere` is one Points draw call driven by the world clock: falling snow, spindrift, ice glints and lake mist; reduced effects keeps 35 % of the snow and drops the rest. Fog is cold blue (`0x9db3c7`, 12-62 m) under a low pale sun.

## Integration still to be wired (shared files, owned by the coordinator)

Biome, dispatcher, registries and attack-name prefixes (`frostfang-`, `howl-scout-`, `chained-ruun-`) are already in the shared scaffold. Still outside this page: the AssetPlaytests entry (`exitRouteId: 'moonpine-trial-exit'`, exit name "Temple Descent"), the manifest for the nine asset ids (`actor-frostfang-tracker` 1.1 m, `actor-howl-scout` 0.9 m, `actor-ruun-chained-howl` 1.6 m, `prop-moonpine-tree` 16 m, `prop-buried-wolf-temple` 14 m wide, `prop-temple-chain-anchor` 2.5 m, `prop-snow-ridge-rock` 5 m wide, `prop-moonpine-log-bridge` 12 m long, plus `actor-vara` and the shared gate), the native GLBs, and the map thumbnail.

## Verification

```
npx tsc --noEmit -p .
bun test tests/combat/moonpine-trials.test.ts tests/combat/moonpine-sealed-route.test.ts tests/world/moonpine-world.test.ts tests/effects/moonpine-kits.test.ts tests/rendering/moonpine-monster-profiles.test.ts tests/audio/moonpine-audio.test.ts
```
