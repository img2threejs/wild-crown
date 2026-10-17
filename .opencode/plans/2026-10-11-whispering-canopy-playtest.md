# Whispering Canopy playtest — design contract (2026-10-11)

Second playable map after Greenwake, reached with `http://127.0.0.1:5173/?assetPlaytest=canopy` (DEV only, like
`?assetPlaytest=greenwake`). It is a playtest variant of the authored `whispering-canopy` region: the canonical
`src/content/levels/act-i.ts` canopy data stays untouched; `createCanopyTrialRegion(authored)` returns the variant.

Bible chapter 1 setting: layered rainforest, rope/vine bridges, waterfall, small temple, high paths and low ground,
Black Sap corruption of monkeys/birds/snakes. Same rules as Greenwake: simulation owns walkability, collisions,
hit windows and world state; presentation never grants rewards or changes walkability.

## 1. Walk-mesh (sim authority; ids, coordinates in metres, y up)

All polygons are listed in order; heights are per vertex.

| Surface id | Kind | Points / notes |
|---|---|---|
| `canopy-trial-basin` | flat y 0 (start + Arena 1) | (−54,0,−40) (−40,0,−40) (−36,0,−34) (−36,0,−22) (−42,0,−16) (−58,0,−16) (−64,0,−22) (−64,0,−31) (−56,0,−33). The waterfall pool (non-walkable water) lies south-west of the (−64,−31)–(−56,−33)–(−54,−40) edge. |
| `canopy-trial-root-stair` | ramp y 0→4 along +x | (−36,0,−31) (−24,4,−31) (−24,4,−25) (−36,0,−25) |
| `canopy-trial-fig-ledge` | flat y 4 (cliff top) | (−24,4,−34) (−14,4,−34) (−14,4,−22) (−24,4,−22) |
| `canopy-trial-gorge-bridge` | bridge deck y 4, material `canopy-bridge-deck` (not drawn; the bridge model is the visual) | (−14,4,−30) (−4,4,−30) (−4,4,−27) (−14,4,−27) |
| `canopy-trial-roost` | flat y 4 (cliff top, Arena 2) | (−4,4,−38) (12,4,−38) (14,4,−24) (12,4,−14) (−4,4,−14) |
| `canopy-trial-chasm-bridge` | bridge deck y 4, material `canopy-bridge-deck` | (13,4,−25) (24,4,−25) (24,4,−22) (13,4,−22) |
| `canopy-trial-temple-descent` | ramp y 4→0 along +x | (24,4,−27) (38,0,−27) (38,0,−18) (24,4,−18) |
| `canopy-trial-courtyard` | flat y 0 octagon (Arena 3) | (43.27,0,−31) (50.73,0,−31) (56,0,−25.73) (56,0,−18.27) (50.73,0,−13) (43.27,0,−13) (38,0,−18.27) (38,0,−25.73) |
| `canopy-trial-exit-path` | flat y 0 | (43.5,0,−14) (50.5,0,−14) (50.5,0,10) (43.5,0,10) |

Other materials: flat/ramp/cliff-top surfaces use earth trail materials (`canopy-trail-earth`); they are rendered by the
canopy terrain (terrain-backed), never as slabs. Each surface has a support collider like Greenwake (box under flat or
raised tops with `blocksMovement`, segment for ramps).

Spawn: Aren (−58, 0, −20) facing +x; Vara near (−60, 0, −19). Exit route `canopy-trial-exit` at (47, 0, 7); the stage
goal ring sits there.

## 2. Trials and gates

Same gate builder and rules as `DodgeTrials.ts` (solid box over the whole walkable cross-section + 1 m void each side,
≥ 4.5 m above the highest floor, 1.2 m thick; root-wall gate model `prop-greenwake-root-gate`).

| # | Trial id / title | Monster (actor id / asset id) | Spawn | Arena (centre, r) | Gate (x, z, acrossX, low, high floor) | Clean world seconds |
|---|---|---|---|---|---|---|
| 1 | `howler-pool` / Howler's Pool | `canopy-howler` / `actor-thornback-howler` | (−46,0,−26) | (−49,0,−28), 8 | (−33.5, −28, false, 0.63, 1.03) | 20 |
| 2 | `hornbill-roost` / Hornbill Roost | `canopy-hornbill` / `actor-storm-hornbill` | (7,4,−24) | (5,4,−26), 8 | (14.6, −23.5, false, 4, 4) | 25 |
| 3 | `viper-temple` / Viper Temple | `canopy-mire-viper` / `actor-mire-viper` | (49,0,−20) | (47,0,−22), 8 | (47, −9, true, 0, 0) | 30 |

`MIN_AVOIDED_CASTS` stays 3. Trial behaviour (engagement 14/16 m, pressure tiers, serialization, cleansing to neutral,
nonlethal get-up) is identical to Greenwake; the engine must read the trial set of the current region instead of the
Greenwake constant.

## 3. Monsters and attacks (attack ids are the cross-team contract)

AI profiles (`MonsterProfile`): Howler `{radius 0.75, band 4–7, advance 4.8, circle 4.0, retreat 4.2, yaw 5.0, strafe [60,130]}`
(flanker, erratic); Hornbill `{radius 0.9, band 6–10, advance 5.2, circle 4.4, retreat 4.8, yaw 4.0, strafe [90,180]}`
(ranged, wide circles; flies — see §5); Viper `{radius 1.0, band 3.5–6, advance 2.6, circle 1.9, retreat 2.2, yaw 2.4, strafe [150,260]}`
(controller, slow, heavy).

| Attack id | Monster | Element | Hazard (kind, width × depth, radius, height, damage) | Timing w/c/a/r | Movement | Counterplay cue |
|---|---|---|---|---|---|---|
| `howler-rock-hurl` | Howler | none (earth visuals) | strike 1.5 × 1.5, r 1.4, h 0.2, 12 | 48/12/10/40 | — | A sap-bound rock is lobbed at where Aren stood: move off the mark. |
| `howler-leap-slam` | Howler | none | strike 2.2 × 2.2, r 2.0, h 0.2, 15 | 54/12/9/48 | step lunge 5 m toward the committed point during commit | It crouches and leaps: dive away from the landing. |
| `howler-branch-sweep` | Howler | wind visuals | wave 6 × 1.3, h 0.18, 11 | 48/12/12/44 | — | A low branch sweep: jump over it or step across. |
| `hornbill-dive-bomb` | Hornbill | wind | sweep 2.0 × 9, laneFromSource, h 1.1, 15 | 60/15/20/48 | charge (flies the whole lane) | It folds its wings for a dive: sidestep the lane. |
| `hornbill-feather-volley` | Hornbill | wind | cone 6 × 7, h 1.2, 10 | 54/12/10/44 | — | Storm feathers fan out ahead: get behind or beside it. |
| `hornbill-gale-flap` | Hornbill | wind | wave 7 × 1.6, h 0.2, 9, onHit push 1.2 m | 54/15/14/48 | — | A wingbeat drives a low gale: jump it or move aside. |
| `viper-venom-spit` | Viper | poison | area 3.6 × 3.6, h 1.2, 4 per pulse, hitInterval 36, lingers 180 | 48/12/180/54 | — | Venom splashes where Aren stood: leave the pool. |
| `viper-tail-lash` | Viper | poison visuals | wave 6.5 × 1.4, h 0.18, 12 | 54/15/14/48 | — | The tail coils low: jump the lash. |
| `viper-strike-lunge` | Viper | none | sweep 1.4 × 6, laneFromSource, h 0.8, 16 | 36/12/8/48 | step lunge 3.5 m | It rears back: step out of the strike line. |

Trial rosters: Howler = [rock-hurl, leap-slam, branch-sweep]; Hornbill = [dive-bomb, feather-volley, gale-flap];
Viper = [venom-spit, tail-lash, strike-lunge]. Monsters are proper archetypes (not reused `corrupted-boar`), hostile until
cleansed, and keep the Greenwake roar on engage / pressure escalation.

## 4. Assets (Tripo, recorded like Greenwake in `asset-source/generated/**/result.json` and a jsonl log)

Playtest manifest `asset-source/playtests/canopy.json` (same schema/validation as `greenwake.json`, evidence `blocked`):
- `whispering-canopy-environment` (composed recipe; `componentAssetIds` = exactly the region prop asset set below).
- `actor-aren`, `actor-vara` (copied entries from greenwake.json, same files), `prop-greenwake-root-gate`, `prop-warden-glaive`.
- Monsters (native GLB with all 10 clip slots `monster-idle/walk/run/slash/shoot/jump/hurt/turn/dive/roar` mapped,
  `castSocketBone`, in-place `rootMotion` entries): `actor-thornback-howler` (Black-Sap corrupted howler monkey, biped rig),
  `actor-storm-hornbill` (giant storm-blue corrupted hornbill, avian rig), `actor-mire-viper` (7 m black-sap viper,
  serpentine rig).
- Region props (the complete prop asset set of the playtest region): `prop-vine-bridge` (level vine-and-plank suspension
  bridge, no sag, ~12 m long along local +z, ~3.4 m wide with rails, deck at local y 0; solid kind `platform`),
  `prop-ancient-canopy-shrine` (overgrown stone temple ruin, ~14 m wide), `prop-rainforest-canopy-tree` (giant buttress-root
  rainforest tree with lianas, ~22 m tall; solid kind `trunk`), `prop-canopy-cliff-rock` (tall mossy basalt outcrop for
  cliff faces; decoration), `prop-canopy-fern-cluster` (dense low fern/broadleaf clump; decoration).

Authored placements in the variant: vine bridge A centre (−9, 4, −28.5) rotationY π/2 (local +z → world +x) spanning
x −14.6 … −3.4; vine bridge B centre (18.5, 4, −23.5) rotationY π/2 spanning x 12.7 … 24.3 (scale z from the model length);
shrine (47, 0, −38) facing +z; giant trees outside the walk-mesh, e.g. (−20, 4, −38), (−30, 0, −12), (2, 4, −42),
(28, 0, −34), (58, 0, −12), (40, 0, 4). Boundary dressing (cliff rocks, ferns, more trees) comes from
`src/world/CanopyBoundary.ts` (world team) and is decoration only.

## 5. Presentation contract

- Clip plans (`MonsterAnimationProfiles`): rock-hurl = shoot, leap-slam = jump, branch-sweep = slash, dive-bomb = dive,
  feather-volley = shoot, gale-flap = slash, venom-spit = shoot, tail-lash = turn, strike-lunge = dive.
- The hornbill is drawn hovering ~2.4 m above its simulation position with a slow bob; during `hornbill-dive-bomb`
  commit/active it swoops down to ~0.6 m along the lane and climbs back in recovery. Sockets/labels follow the drawn body.
- VFX kits: lobbed sap-rock and venom globs fly from the cast socket to the committed point (arc) before the impact;
  feather darts fan; dive streaks; leap dust + slam; low branch/tail sweeps; venom pool reuses the venom-mist look.
- World: canopy terrain with cliff plateaus (the y 4 tops), the waterfall from the west cliff (~12 m) into the basin
  pool, a river from the pool running south of the basin, north through the gorge under bridge A, east north of the
  roost and south down the chasm under bridge B; flooded pools in the temple courtyard (outside the walk-mesh); humid
  green fog, light shafts, dappled light, falling leaves.

## 6. App

`?assetPlaytest=canopy` loads `canopy.json`, builds the canopy variant, starts directly in the canopy (no Greenwake
opening cinematic, New Game → canopy), starts the canopy trial encounter, shows the same HUD/roster/gate notices and
the stage goal at the exit. `?assetPlaytest=greenwake` keeps working unchanged.
