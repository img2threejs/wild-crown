# Mistveil Basin playtest (Chapter 4)

The local Mistveil Basin playtest map is the fourth map of the asset playtest. It follows the Whispering Canopy playtest
(`docs/features/combat.md`, "Whispering Canopy playtest") exactly in architecture: a variant of the authored `mistveil-basin`
region with a one-way, gate-sealed walk-mesh, three timed dodge trials, a biome, VFX kits, procedural sounds and clip plans. The
canonical region in `src/content/levels/later-acts.ts` is not modified.

Story (GAME-NARRATIVE section 6, Chapter 4): a fog-bound wetland of drowned ruins, great root trees and luminous animals, with a
river carrying the Black Sap that Marek's extraction rig poisons. The three trial monsters are wildlife of the basin, driven
off their hunting grounds by the pollution; the last, Ghor, the Mire Maw, is a crocodile transformed by what comes downstream:
a consequence, not an evil. Nyra is not an enemy and no panther appears. Every attack is a telegraphed, dodgeable hazard and
the trials are nonlethal; clearing a trial turns the monster neutral and awards nothing.

## Files

| Area | File |
|---|---|
| Gameplay data (trials, attacks, encounter, profiles, actors, glow, solid kinds) | `src/game/combat/MistveilContent.ts` |
| Region variant `createMistveilTrialRegion` (surfaces prefixed `mistveil-trial-`) | `src/game/combat/MistveilTrialRegion.ts` |
| Boundary dressing (ids prefixed `mistveil-boundary-`) | `src/world/MistveilBoundary.ts` |
| Water geometry: Black Sap river, source seep and murky pools; carve, water plan, `waterMargin` | `src/world/MistveilWater.ts` |
| Biome (layers, clutter, understory, atmosphere) | `src/world/MistveilBiome.ts` |
| Atmosphere feature (fireflies, drifting mist, sap vapour, exit glow) | `src/world/MistveilAtmosphere.ts` |
| VFX kits and auras | `src/effects/vfx/MistveilKits.ts` |
| Procedural sounds | `src/audio/MistveilSounds.ts` |
| Clip plans and locomotion | `src/rendering/MistveilMonsterProfiles.ts` |
| Ground textures | `asset-source/textures/mistveil/<layer>/` |

## Route

All coordinates are metres in world space; the camera keeps the fixed (+10, +12, +14) offset. The walk-mesh has twelve
surfaces. Everything off it is wetland: the river and pools never lie under a walkable (the route never wades) and are kept at
least 1.2 m from any walkable edge.

| Segment | Surface id (`mistveil-trial-...`) | Extent / floor |
|---|---|---|
| Arrival mud bank, Trial 1 arena | `bank` | x -72..-30, z -26..-6, y 0 (spawn (-70, 0, -16): 30 m from the Bog Lurker and 18 m from its arena edge, so the player walks into Trial 1) |
| Ford, sealed by gate 1 | `ford` | x -30..-24, z -19..-13 |
| Root causeway: rise, level span, fall | `causeway-rise`, `causeway`, `causeway-fall` | x -24..-4, y 0 -> 1.2 -> 0, between the root trees |
| Foggy glade, Trial 2 arena | `glade` | x -4..24, z -28..-4 |
| Reed way, sealed by gate 2 | `reedway` | x 24..30 |
| Marek's extraction site | `pad` | x 30..52, z -26..-6 (rig and filter drum north of it, beside the river) |
| Neck to the source | `neck` | x 52..58 |
| Polluted source, Trial 3 arena | `source` | x 58..86, z -28..-4 |
| Cavern path, sealed by gate 3 | `pass` | x 86..92 |
| Landing before the root cavern | `landing` | x 92..102, z -21..-11 |

Exit: `mistveil-trial-exit`, a copy of the authored `mistveil-hidden-route-out` (cavern route to `to` (16, -5, 28), `unlockFact`
stripped, `colliderIds: []`) whose `from` is the goal ring at (99, 0, -16). The coordinator names the exit "Root Cavern". The
`prop-root-cavern-mouth` stands at (107, 0, -16), opening west onto the landing.

Arrival rule: the spawn is at least 18 m from every trial monster and arena edge, and the later arenas are only reachable through their predecessor gates (proved by the sealed-route harness). Region bounds are overridden to (-88, -8, -66) .. (122, 14, 22). The authored props (all ids `mistveil-trial-*`) are the root
trees flanking the causeway (two on each side) and framing the glade, reed clumps and bank rocks round the arrival bank, Marek's
`prop-hunter-extraction-rig` (41, 0, -32) and `prop-black-sap-filter-drum` (49, 0, -31), and the cavern mouth.

## Trials

Each gate is a `trialGate` box that seals the whole 6 m cross-section of its corridor with at least 1 m of void to each end; each
arena has radius 8, is flat walkable floor and lies fully clear of its gate. The roster order is the cast order.

| Trial | Monster (id / asset / species) | Spawn | Arena centre | Gate (x, z) |
|---|---|---|---|---|
| Reed Shallows | Bog Lurker (`mistveil-lurker` / `actor-bog-lurker` / toad) | (-40, 0, -17) | (-44, 0, -16) | `trial-gate:reed-shallows` (-27, -16) |
| Eyes in the Mist | Lantern Heron (`mistveil-heron` / `actor-lantern-heron` / heron, ground-bound) | (14, 0, -17) | (10, 0, -16) | `trial-gate:eyes-in-the-mist` (27, -16) |
| The Black River | Ghor, the Mire Maw (`mistveil-ghor` / `actor-ghor-mire-maw` / crocodile, large) | (78, 0, -16) | (72, 0, -16) | `trial-gate:black-river` (89, -16) |

Each gate opens when its monster is defeated. The wildlife encounter is `mistveil-trials` (`MISTVEIL_ENCOUNTERS`), `clearedTitle`
"Basin trials cleared". The playtest monsters are separate from the canonical `ghor` boss and its `ghor-*` attacks.

Monster AI profiles (`MISTVEIL_MONSTER_PROFILES`, m/s and rad/s): the lurker is a squat hopper (radius 0.8, band 4-7 m, advance
3.4, circle 2.4), the heron a ranged circler (radius 0.9, band 6-10 m, advance 4.4, circle 3.8), Ghor slow and heavy (radius 2,
band 5-8 m, advance 2.2, circle 1.4, yaw 2). `crocodile` is a large species, so Ghor counts against the three-large-monster cap.

## Attacks

Timings are windup / commit / active / recovery in ticks. Attack ids carry the HUD prefixes `bog-lurker-`, `lantern-heron-` and
`mire-maw-`, and avoid the obstacle words of `spawnCombatObstacles` (`root`, `sap`, `stomp`, `march`, `seismic`, `trample`,
`thorn`, `charge`) so the arenas stay open ground; none uses `element: 'ice'` or `'heartroot'`.

| Attack id | Kind | Size | Timing | Damage | Element | Movement |
|---|---|---|---|---|---|---|
| `bog-lurker-tongue-lash` | sweep (lane) | 1.2 x 7 | 42 / 12 / 8 / 44 | 11 | - | `laneFromSource` |
| `bog-lurker-bubble-pool` | area, lingering | 3.4 x 3.4 | 48 / 12 / 180 / 54 | 4 per pulse | poison | pulses every 36 ticks, `castTicks` 12 |
| `bog-lurker-mud-hop` | strike | r 2 (2.2 x 2.2) | 48 / 12 / 9 / 48 | 14 | - | step lunge 4.5 m |
| `lantern-heron-spear-dive` | sweep (lane) | 1.8 x 9 | 60 / 15 / 20 / 48 | 15 | - | `laneFromSource`, charge lunge |
| `lantern-heron-mist-gust` | cone (70 deg) | 6 x 7 | 54 / 12 / 10 / 44 | 9 | wind | push 1.2 m |
| `lantern-heron-flare-burst` | area burst | 5 x 5 | 54 / 12 / 12 / 48 | 12 | - | - |
| `mire-maw-tail-sweep` | wave (jump it) | 8 x 1.5 | 54 / 15 / 14 / 50 | 14 | - | - |
| `mire-maw-bite-lunge` | sweep (lane) | 1.8 x 6.5 | 42 / 12 / 8 / 50 | 18 | - | `laneFromSource`, step lunge 4 m |
| `mire-maw-black-river-wave` | wave (jump it) | 12 x 2 | 66 / 18 / 16 / 56 | 12 | poison | - |

The cues are plain-English counterplay ("Step out of the lane", "Jump the sweep"). Waves are evaded only by jumping or vaulting;
lanes, cones and disks by moving; the bubble pool by leaving it (it does not chase).

## World

- **Terrain.** Low open wetland: gentle relief (mound 0.7 m, dip 0.4 m), no summits or cliffs, a soft berm round every walkable.
  The causeway is a raised flat (y 1.2) between two short ramps; every walkable is terrain-backed (no bridge decks) and the
  terrain reproduces each within 2 cm. The fine-mesh band (`refine.flatOutside` 1.4) and the extent
  (x -76..108, z -58..14) keep the terrain inside the Greenwake vertex and triangle budget.
- **Water.** The Black Sap river rises at the polluted source seep (86, -38), runs west behind the extraction site and the glade
  (z about -43..-48), and ends in the south-west behind the arrival bank at z -42; its rim is at least 6 m from any walkable. Nineteen shallow,
  murky pools lie off the route besides the source seep. One palette serves all water: murky green-grey in the shallows deepening to purple-black
  (`0x0b0612`) in the river and seep.
- **Textures.** Five 1k CC0 Poly Haven layers under `asset-source/textures/mistveil/<layer>/{diffuse,normal,arm}.jpg` with
  `provenance.json` (canopy schema): `mud_forest`, `mossy_rock`, `roots` and `gray_rocks` (the same sets as the canopy map,
  copied) and `brown_mud_leaves_01` (new: 953 367 + 1 206 953 + 1 486 072 bytes, Rob Tuytel). Texture memory stays at the canopy
  budget of five layers.
- **Understory.** Marsh ferns, big-leaved wetland plants, drowned logs, surface roots and luminous fungi (glowing stems and caps
  along the trail ribbons, plus dense clusters across the glade floor).
- **Atmosphere.** Low teal fog (near 22 m, far 80 m, `0x6f9193`: about 19 % at the 33 m camera distance of a monster at the edge of its trial radius, so Aren and every trial monster stay readable; the Mistveil mood comes from the drifting mist sheets (112 puffs over a 50 m volume) and the darker, bluer fog colour rather than global density), cool teal light, and a `GroundFeature`
  (`MistveilAtmosphere`, one `Points` draw call driven by the world clock): fireflies, slowly drifting ground mist, dark Black Sap
  vapour over the source seep and a cool glow on the ground at the exit. Reduced effects drops the fireflies and thins the mist
  and vapour; the exit glow (a readability aid) stays on.
- **Boundary dressing.** Deterministic root trees (behind the camera-far edges), reed clumps and bank rocks; never on camera-facing
  edges except small reeds at least 4 m out; at least 0.8 m from every walkable, off the water, clear of gates, arenas, the goal
  ring and the authored props. Decoration only (no colliders).

## Presentation

- **VFX** (`MISTVEIL_KIT_IDS`, attack id = kit id; mapped by `MISTVEIL_ATTACK_KITS` to `earth` mud for the lurker's lash and hop and
  Ghor's sweep and bite, `poison` for the bubble pool and the wave, `wind` for the heron's dive and gust and warm `gold` for the
  lantern flare). Mud, pond spray, mist and the purple-black Black Sap are alpha-blended tints; ground quads come only from the cue
  footprint. `MISTVEIL_AURAS`: lurker `earth`, heron `storm`, Ghor `toxic`. Owner glows: `earth`, `wind`, `poison`.
- **Audio.** `mistveilLayers(cue)` returns procedural layers for the nine attacks (four phases each) and three distinct roars
  (wet croaks, rasping squawk, deep bellow); the cues share the bounded wildlife voice pool.
- **Animation.** `MISTVEIL_ATTACK_PLANS` maps tongue lash and bubble pool to the shoot clip, mud hop and the wave to jump, spear
  dive and bite lunge to dive, mist gust to slash, flare burst to roar and the tail sweep to the loopable turn clip.
  `MISTVEIL_LOCOMOTION` carries the three assets; `MISTVEIL_HOVER` is empty (the heron is a ground-bound wader).

## Assets

Native GLBs are generated by the coordinator. Stated sizes: `prop-mistveil-root-tree` 14 m tall, `prop-mistveil-reed-cluster`
2.5 m tall (decoration), `prop-mire-bank-rock` 4 m wide, `prop-hunter-extraction-rig` 6 m tall, `prop-black-sap-filter-drum`
2 m tall, `prop-root-cavern-mouth` 8 m wide; `actor-bog-lurker` (toad, 1.4 m tall), `actor-lantern-heron` (2.4 m tall, 3.6 m
wingspan), `actor-ghor-mire-maw` (crocodile, 8 m long). Solid kinds: root tree `trunk`, reeds `decoration`, cavern mouth `arch`,
everything else `solid`. Every monster GLB exposes the ten generic monster clip slots.

## Verification

`tests/combat/mistveil-trials.test.ts` (trial table, attack contract, runtime hazards, lunges, push, pool pulses, no obstacles,
roster cycling, roars, full progression in order without rewards), `tests/combat/mistveil-sealed-route.test.ts` (the shared sealed
route harness plus the variant layout and real-engine walks that stop at each closed gate and reach the exit only after trial 3),
`tests/world/mistveil-world.test.ts`, `tests/effects/mistveil-kits.test.ts`, `tests/rendering/mistveil-monster-profiles.test.ts`
and `tests/audio/mistveil-audio.test.ts`.
