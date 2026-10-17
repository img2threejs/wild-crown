# The Grove playtest map

The Grove is the story hub of the local asset playtests (GAME-NARRATIVE section 6, "The Grove"): a sanctuary that records the
journey. It holds a young Heartroot tree, a pond, Yara's tent and the monkey lookouts; Vara and Koro have arrived. Nothing in the
Grove hunts, but the Black Sap has seeped into the hollow north of the camp and reached the Memory Pool, and the map is a
**three-stage defence** of the sanctuary: a sparring partner (Heartroot Sprig), a Black Sap-blighted rootling and the corrupted
guardian Hollowheart. Clearing a stage opens its gate; the last gate opens the Ridge Trail exit. The run qualifies the local stage and
changes no campaign history. Warm and golden-green in the south, darker and violet-black towards the pool.

It follows the Whispering Canopy playtest in architecture (`docs/features/combat.md`, "Whispering Canopy playtest"): the authored
`the-grove` region in `src/content/levels/act-i.ts` is never modified; `createGroveTrialRegion` builds a playtest variant that
replaces its ground, navigation, cameras, routes, entities and props and keeps its identity (id, name, environment recipe).

Unlike the first version of this map (one optional practice, no combat gate on the route), **every stage is on the route**: the
three gates are solid boxes across the only way north and east, so the exit is reachable only after all three defenders are down.

## Files

| Area | File |
|---|---|
| Gameplay data (three trials, ten attacks, encounter, monster profiles, actors, glow, solid profiles) | `src/game/combat/GroveContent.ts` |
| Region variant (12 walk surfaces, navigation, cameras, exit, entities, props) | `src/game/combat/GroveTrialRegion.ts` |
| Black Sap field, ring stones, roots, veins, puddles (pure plan, no three.js) | `src/world/GroveBlight.ts` |
| Merged blight meshes, sap decals, ground wash and the corrupted Memory Pool surface | `src/world/GroveBlightDressing.ts` |
| Boundary dressing | `src/world/GroveBoundary.ts` |
| Biome (terrain, splat layers, understory, dead wood, water plan, atmosphere) | `src/world/GroveBiome.ts` |
| Pond and Memory Pool geometry, carve and water plan | `src/world/GrovePond.ts` |
| Mound and far meadow relief | `src/world/GroveTerrain.ts` |
| Pollen, fireflies, petals, Black Sap spores, exit and Heartroot glow | `src/world/GroveAtmosphere.ts` |
| VFX kits and auras | `src/effects/vfx/GroveKits.ts`, `ActorVfx.ts` (`heartlight` aura), `GroundFx.ts` (contrast-aware tell) |
| Procedural sounds | `src/audio/GroveSounds.ts` |
| Monster clip plans and locomotion | `src/rendering/GroveMonsterProfiles.ts` |
| Native assets (blighted rootling variant, Hollowheart) | `scripts/assets/build-grove-blighted-variant.mjs`, `scripts/assets/author-creature-clips.mjs`, `docs/features/asset-pipeline.md` |
| Tests | `tests/combat/grove-practice.test.ts`, `grove-defence.test.ts`, `grove-sealed-route.test.ts`, `tests/world/grove-world.test.ts`, `tests/effects/grove-kits.test.ts`, `tests/rendering/grove-monster-profiles.test.ts`, `tests/audio/grove-audio.test.ts`, `tests/rendering/quadruped-clips.test.mjs`, `story-map-assets.test.mjs` |

The shared registries (`CombatTrials`, `content`, `WildlifePressure`, world `ACTORS`, palette `OWNER_GLOW`, `solid-props`,
`TrialRegions`, `Biomes`, `ElementKits`, `ActorVfx`, `StoryAudio`, `MonsterAnimationProfiles`) spread these per-map exports. No texture
is added: the biome reuses the five CC0 Poly Haven sets under `asset-source/textures/canopy` (same texture memory as the canopy).

## Layout

Coordinates are metres; north is -z. Camera anchors keep the locked three-quarter offset (+10, +12, +14) from the point they frame,
so on screen "up" is north-west: tall things stand on the far (north-west) side of the route so the Warden is never hidden, and the
Memory Pool, which lies due north of the arena, appears up and to the right of the guardian. All twelve walk surfaces are flat
`y = 0` ground with ids prefixed `grove-trial-` (the prefix `biomeProfileFor` uses to give only the variant the Grove biome). The
variant's bounds are (-64, 0, -150) to (46, 18, 58): the walk-mesh (x -37.5..34, z -109.5..48) and its set dressing (the pool, its
cavern and the ruin) exceed the authored ones.

| Surface | Footprint | Role |
|---|---|---|
| `grove-trial-trailhead` | x 5..15, z 26..48 | south trailhead; spawn `nodes[0]` (10, 0, 44) |
| `grove-trial-glade` | irregular, x -13..24, z -5..29 | central glade; straight north edge at z -5 |
| `grove-trial-camp` | x -34..-12, z -4..16 | Yara's camp |
| `grove-trial-lookout-pad` | x 18..34, z -6..18 | monkey lookouts and Koro |
| `grove-trial-ring-path` | x -28..-20, z -13..-3 | camp to practice ring |
| `grove-trial-practice-ring` | 16-gon, r 10.5 around (-24, -22) | stage 1 clearing (arena r 8) |
| `grove-trial-pool-spur` | x -27..-21, z -47..-31 | gated spur 1 (6 m wide) |
| `grove-trial-blight-hollow` | 16-gon, r 10.5 around (-24, -56) | stage 2 clearing (arena r 8) |
| `grove-trial-pool-approach` | x -27..-21, z -88..-65 | gated spur 2 (6 m wide) |
| `grove-trial-memory-pool` | 20-gon, r 13.5 around (-24, -96), on the pale `grove-pool-stone` | stage 3 clearing (arena r 11) |
| `grove-trial-ridge-trail` | x -12..24, z -99..-93 | the Ridge Trail east from the arena (6 m wide) |
| `grove-trial-ridge-landing` | x 18..32, z -103..-89 | exit landing |

Props (all `ground` placements, ids `grove-trial-*`):

| Id | Asset | Position | Notes |
|---|---|---|---|
| `heartroot` | `prop-heartroot-trunk` (9 m) | (-2, -13) | young Heartroot on a 0.7 m mound (`GroveTerrain.ts`), beside the pond; solid kind `trunk` |
| `tent` | `prop-refuge-shelter` (4 m) | (-29, 7) | Yara's tent; solid kind `solid` |
| `lookout-a`, `-b` | `prop-grove-platform` (4 m) | (31, -3), (31, 13) | monkey lookouts on stilts; kind `platform`; **not walkable** (every walk surface is `y = 0`) |
| `post-0..3` | `prop-training-post` (2.5 m) | (-31, -28.5), (-17, -28.5), (-32.5, -18), (-15.5, -18) | frame the practice ring's rim; kind `trunk` |
| `practice-basin` | `prop-water-basin` (4 m) | (-30, -23) | beside the practice ring; kind `solid` |
| `ward-0..5` | `prop-training-post` | (-36.2, -50), (-11.8, -50), (-36.2, -63), (-41.2, -88), (-41.9, -102.5), (-6.1, -102.5) | warding posts round the hollow and the arena |
| `gate-rock-0..5` | `prop-canopy-cliff-rock` (scale 0.7) | pairs at z -38, -72 (x -31.5 / -16.5) and (-1, -104.5), (-1, -87.5) | tall mossy rock pairs frame each gate across its spur |
| `hollow-rock-a`, `-b` | `prop-mire-bank-rock` (scale 0.9, 0.8) | (-14, -63), (-36, -57) | sap-soaked slabs of the hollow |
| `pool-ruin` | `prop-ancient-canopy-shrine` (scale 0.85, 14 m wide) | (-52, -96) | old Warden ruin west of the arena |
| `pool-heartroot-a`, `-b` | `prop-heartroot-trunk` (scale 0.9) | (-40, -121), (-8, -121) | two young Heartroots on the pool's far banks |
| `pool-cavern` | `prop-root-cavern-mouth` (8 m) | (-24, -129) | the cavern mouth whose spring feeds the pool, opening south |

Unlisted props (ruin, cavern mouth and rocks) stay physical by default. The boundary builder (`GroveBoundary`) adds deterministic
trees, boulders and ferns (`grove-boundary-<tree|rock|fern>-N`, decoration only) at least 0.8 m from every walkable, off the water, off the
Heartroot's mound, clear of the gates, the arenas, the authored footprints and the ring stones, and withholds ferns (blight > 0.15) and
trees (blight > 0.25) inside the Black Sap field.

Water (`GrovePond.ts`): the pond is a real biome water pool, an elliptical dish (water-edge radii 4.4 x 3, centre (11, -12)) carved 0.64 m
deep with water level -0.1, between the Heartroot's mound and the north trail. The **Memory Pool** is a second, larger carve (radii
10 x 5, centre (-24, -116), water level -0.1, rim height 1.3) just north of the arena, outside the walk-mesh (at least 0.8 m from every
walkable, asserted along its whole edge). It lies within 8 m of the arena rim and 14 m behind the guardian's post, so the gameplay camera
frames the guardian in front of it.

Entities: `grove-vara` (actor `vara`, `actor-vara`, placement `canopy`, at (8, 0, 41)), `grove-koro` (actor `grove-koro`, `actor-koro`,
(28.5, 0, 5), idling between the two lookouts) and the three defenders (below). Navigation: 17 nodes and 4 ribbons
(`grove-trial-main-route`, `-pool-route`, `-ridge-route`, `-lookout-route`); nine camera anchors (`arrival`, `glade`, `camp`,
`lookout`, `practice`, `hollow`, `pool`, `ridge`, `exit`).

### Gates, the route and the exit

| Gate | Position | Across | Opens when |
|---|---|---|---|
| `trial-gate:evasion-practice` | (-24, -38) | x | the Heartroot Sprig is defeated |
| `trial-gate:sap-incursion` | (-24, -72) | x | the Blighted Rootling is defeated |
| `trial-gate:memory-pool` | (-1, -96) | z | Hollowheart is defeated |

Each gate (`trialGate`) is a 9 m wide, 1.2 m thick box from y -0.5 to 4.5 that covers its 6 m spur completely with at least 1 m of void
at each end. The exit is the authored route `grove-ridge-out` copied with its `unlockFact` stripped, id `grove-trial-exit`, `from`
(26, 0, -96) (inside the landing), `colliderIds: []`; the coordinator shows it as "Ridge Trail". The one way from spawn to exit is the
ring, spur 1, the hollow, spur 2, the Memory Pool arena and the Ridge Trail, in that order; with all gates open the flood fill reaches
every surface, with one gate closed it reaches exactly the stages before it.

**Stage completion.** The stage-complete screen is not raised by the boss's death. `GameApplication.checkStageArrival` completes the
stage when the trial set is complete **and** the player stands inside the exit's goal ring; the boss dying opens the last gate and the
HUD reads "Sanctuary Defended - Reach the Ridge Trail waystone". (A harness that kills the guardian and waits sees the screen stay on
`game`: that is the intended flow, not a defect; teleporting or walking to (26, -96) raises `stage-complete`.)

## The three stages

One wildlife encounter `grove-defence` (`GROVE_ENCOUNTERS`, three phases, roster `grove-sprig`, `grove-blighted`, `grove-hollowheart`;
Koro is scenery and never joins it) hosts three trials, in order, cleared title "Sanctuary defended". Defeated monsters turn neutral
(`downed`), never disappear. Vitality is ramped by stage (`trial-difficulty`): 160, 184 and 510; only the last stage is flagged `boss`.

| Stage | Trial | Monster / asset | Post | Arena | Gate |
|---|---|---|---|---|---|
| 1 | `evasion-practice` "Heartroot Practice" | `grove-sprig` "Heartroot Sprig", `actor-grove-rootling` (1.6 m) | (-24, 0, -26) | (-24, -22), r 8 | (-24, -38) |
| 2 | `sap-incursion` "Black Sap Incursion" | `grove-blighted` "Blighted Rootling", `actor-grove-blighted-rootling` (2.0 m, same body, darkened material) | (-24, 0, -60) | (-24, -56), r 8 | (-24, -72) |
| 3 | `memory-pool` "The Memory Pool" | `grove-hollowheart` "Hollowheart, the Sapbound Guardian", `actor-grove-hollowheart` (3.5 m) | (-24, 0, -102) | (-24, -96), r 11 | (-1, -96) |

Monster profiles (`MONSTER_PROFILES`): sprig radius 0.6, band 5 to 8 m, advance 2.2, circle 1.5, retreat 2 m/s, strafes 150 to 260 ticks;
blighted radius 0.6, band 4.5 to 7.5 m, advance 3, circle 2.2, retreat 2.6, strafes 110 to 200; guardian radius 1.1, band 5 to 9 m inside
its 11 m arena, advance 2.6, circle 1.8, retreat 2.2, slow turns (2.4 rad/s), strafes 150 to 260. No attack id contains an obstacle word
(root|sap|stomp|march|seismic|trample|thorn|charge) and none is elemental, so no pillars spawn.

| Attack | Kind | Size (m) | Timing w/c/a/r (ticks) | Damage | Counterplay |
|---|---|---|---|---|---|
| `sprig-seed-toss` | strike (disk) | radius 1.6 | 66 / 14 / 10 / 54 | 4 | step off the mark before the seed lands |
| `sprig-ground-ripple` | wave | 5 x 1.2 | 60 / 14 / 14 / 56 | 5 | jump over the ripple or step across |
| `sprig-petal-sweep` | sweep (lane from source) | 2.4 x 6.5 | 66 / 14 / 12 / 54 | 6 | sidestep the lane |
| `blighted-seed-lob` | strike (disk) | radius 1.9 | 58 / 14 / 10 / 50 | 7 | step off the mark before the clot bursts |
| `blighted-ground-pulse` | wave | 5.6 x 1.3 | 56 / 14 / 14 / 52 | 8 | jump over the pulse or step across |
| `blighted-lash-sweep` | sweep (lane from source) | 2.6 x 7 | 58 / 14 / 12 / 50 | 9 | sidestep the lane |
| `hollowheart-leap-smash` | strike (disk, 4 m lunge) | 3.4 x 3.4, radius 3 | 72 / 16 / 10 / 62 | 14 | dive clear of the landing |
| `hollowheart-antler-sweep` | sweep (lane from source, 2 m step) | 2.8 x 7.5 | 64 / 14 / 12 / 54 | 11 | sidestep the lane, behind its shoulder |
| `hollowheart-ichor-hurl` | strike (disk, slows to 0.7 for 80 ticks) | 2.4 x 2.4, radius 2.2 | 68 / 14 / 10 / 56 | 9 | step off the mark; the sap clings |
| `hollowheart-heartlight-burst` | area (push 1.5 m) | 7.4 x 7.4 | 70 / 15 / 14 / 58 | 10 | leave the marked ground |

Roars. A monster roars (`ROAR_TICKS` = 42 ticks, `roar-cone` cue, `monster-roar` clip) when it first engages a player that arrives
beyond its attack band (inside 14 m, the disengage range is 16 m) and again each time wildlife pressure escalates a tier while it is
idle. The guardian also plays a **phase roar**: the renderer's native `monster-roar` overlay (clip 0..0.8, 1.6 s world time, 0.9 peak
share) starts once when a boss's vitality ratio first falls below 0.5 across frames (`ActorAnimationDriver`,
`resolveBossRoarOverlay`); a boss loaded below half or killed outright does not roar.

## The Black Sap

`blightAt(x, z)` (`GroveBlight.ts`) is one 0..1 field that drives every layer, so the three stages read as one spreading infection:
zero south of the first gate (z -38), dense in the stage-2 hollow (full inside 9 m of (-24, -56), gone beyond 22 m), 0.7 along the
gated spur between the hollow and the arena, round the arena (full inside 15 m of (-24, -96), gone beyond 34 m) and total round the
Memory Pool, where it comes from; ragged edges come from two value-noise octaves. It drives:

- **Ground.** `sapMudAt` paints the soaked, dark mud splat layer (ragged patches inside the blight), the carve's wetness takes the
  maximum with it, a vertex-graded wash multiplies the ground ochre round the hollow and bruised violet towards the pool (fading to
  neutral with fog so distance never turns it into a smear), the grass wilts and goes black (`blight` grass tint), lush clutter, boundary
  ferns and Erya trees are withheld, and dead twigs, sap-crusted surface roots and colonies of sickly ochre and violet fungus are strewn where the sap is dense.
- **Set dressing** (`GroveBlightDressing`, planned by `planBlight`, deterministic): 21 ancient standing stones in a ring of radius 16.4
  m round the arena (tall behind it, knee-high towards the camera, open to the south entrance, the east trail and the water; some
  broken, with fallen slabs between them), 20 sap-crusted roots arching over the hollow's and the arena's rims, 8 dead trees (only
  behind camera-averted walkable edges) and 174 dead shrubs where the sap is, 20 black sap veins (three strands climbing the spur to the
  arena, a tendril back towards gate 1, seven radials round the hollow, nine out of the pool's south bank) and 12 sap puddles (six in the
  hollow, six on the arena floor south of the pool). Ground the fights and the routes use is reserved (no dressing within 9.4 m of the
  hollow centre, 12.2 m of the arena centre, or on the spurs and the Ridge Trail).
- **Sap puddles.** Glossy black with a faint violet sheen, a few amber glints and a bruised-green rim. The shader values are linear
  (the colour-space step lifts them), so the sheen peaks near (0.011, 0.008, 0.026): a dark pool, never a grey or white patch.
- **The Memory Pool surface** (`poolSurface`, one draw call): ink-dark, slowly churned water with faint violet streaks and the cracked
  heart-light welling up from its centre as a small amber core (peak linear colour (0.42, 0.13, 0.016) before the pulse, saturated amber,
  well below the HUD's white text), a thin broken ring and a few faint ripples; drawn over the carved water, 3 polygon-offset units above
  it. Reduced Motion / Reduced Effects freezes the swirl and ripples and keeps the glow.
- **Meshes.** Four merged draw calls: `grove-blight-solids` (stones, roots, dead trees and shrubs: vertex-coloured flat-shaded Lambert,
  cast and receive shadows, 44,819 triangles, 27,781 vertices), `grove-sap-decals` (puddles, veins and the arena's rune floor, 762
  triangles, transparent, no depth write), `grove-blight-wash` and `grove-memory-pool-surface`.
- **The arena floor decal** has two rings of broken Warden runes whose amber heart-light pulses through the soaked sap-mud.
- **Atmosphere** (`GroveAtmosphere`, still one `Points` draw call): dark Black Sap spores rise over the hollow (radius 12) and the arena
  (radius 17 around (-24, -100)).

## Presentation

- **Biome.** South of the hollow, a meadow sanctuary in warm late-afternoon light: sun-bleached golden-green grass, a pale packed-earth
  trail, gentle relief (mounds at most 0.55 m, no summits, no cliffs), a smooth 0.7 m mound for the Heartroot, a low warm sun
  (`0xffc27a`, backlit from the north-west), golden-green fog that reads far (near 16, far 86), the flowering understory (rose, cream,
  gold, lavender) and petal drifts. North of gate 1 the same field darkens it as described above.
- **VFX kits** (`GroveKits`): attack id = kit id. Sprig: gold-green (`sap`) seed lob, amber (`earth`) ripple with a travelling head of
  blades and dust, green (`spirit`) petal sweep with a lane beam and rose/cream petals. The blighted rootling plays the same three
  shapes in `poison` (sap-black petals, black dust, toxic glints). Hollowheart: leap smash (bark dust, torn leaves, earth sparks), antler
  sweep (black sap and splinters off the swollen arm, an amber-glimmering lane), ichor hurl (black sap smoke, sickly glints) and
  heart-light burst (a gold flare up the chest, gold glints inside the marked square). Footprint-bound, tiny shakes, no extra draw call,
  35% of the emissions under reduced effects. `OWNER_GLOW` is `sap` for the sprig and the guardian and `poison` for the blighted rootling
  (never the player-only `heartroot` look).
- **Telegraphs on dark ground.** The shared ground fill is additive with a soft alpha, which on the sap-mud ground all but vanishes at
  1x. The sprig keeps a gentle 1.5x; the blighted rootling and the guardian's marks glow 2.2x (the gold heart-light burst 1x so it
  stays amber) and set the fill's `uTell` (0.8): an even, denser body fill plus a broken rim just inside the hazard's edge (never outside
  the footprint). In the gameplay camera the mark is clearly visible half-way through every windup (screenshots taken when the telegraph
  reported 32 to 34 ticks remaining, about half of a 56 to 72 tick windup) and reads as amber or green, not white, in the last third.
- **Auras** (`GROVE_AURAS`): `earth` for the sprig, `toxic` for the blighted rootling and `heartlight` for the guardian: the Howler's grit
  and weeping sap, the cracked heart-light in the chest (a warm amber glow that breathes, flares while it charges and sheds embers) and a
  wide, very faint amber backlight round the body (alpha 0.028 per particle, two emissions a second, amber `fire`) that lifts the 3.5 m
  silhouette off the dark floor without veiling it.
- **Sounds** (`GroveSounds`): soft wooden knocks, leaf rustle and small chimes for the sprig, the same recipes a fifth lower over a low
  sap drone for the blighted rootling, creaking groans, wood cracks, wet splats and a bright heart-light chime for the guardian (sine,
  triangle and noise only), and three roar voices (a gentle chirr, a darker chirr over a drone, a deep groan) through the shared
  wildlife pool of `StoryAudio`.
- **Monster profiles** (`GroveMonsterProfiles`): the sprig and blighted rootling use `monster-shoot` (seed), `monster-dive` (ripple)
  and `monster-slash` (sweep); Hollowheart uses `monster-jump` (leap smash), `monster-slash` (antler sweep), `monster-shoot` (ichor
  hurl) and `monster-roar` (heart-light burst), strike poses aligned to the active window. `LOCOMOTION` entries for
  `actor-grove-rootling`, `actor-koro` and `actor-grove-hollowheart` (run threshold 2.2, walk 2.2, run 3.8). No hover.

## Measured (Metal Chromium, 1440 x 900, uncapped: `--disable-gpu-vsync --disable-frame-rate-limit`)

Four seconds of `requestAnimationFrame` per row after the player has stood 2.2 s at the spot (Aren teleported, nothing fighting), draw
calls and triangles from `WebGLRenderer.info` averaged per frame. Greenwake's spawn is the comparison.

| Spot | Mean frame | p50 / p95 | fps | Draw calls | Triangles |
|---|---|---|---|---|---|
| Greenwake spawn (comparison) | 12.08 ms | 11.7 / 15.7 ms | 82.8 | 100 | 1,470,864 |
| Grove spawn (10, 44) | 9.52 ms | 9.3 / 13.3 ms | 105.0 | 140 | 1,491,671 |
| Stage 1 ring (-24, -16) | 12.37 ms | 11.5 / 17.3 ms | 80.9 | 169 | 1,629,240 |
| Stage 2 hollow (-24, -48) | 11.49 ms | 11.3 / 14.9 ms | 87.1 | 147 | 1,385,526 |
| Stage 3 arena entry (-24, -88) | 9.34 ms | 9.3 / 10.8 ms | 107.1 | 118 | 1,083,614 |
| Stage 3 arena middle (-24, -104) | 10.67 ms | 10.3 / 17.0 ms | 93.7 | 106 | 1,003,833 |

An earlier run of the same script (before the last two visual tweaks) gave 11.1 ms for Greenwake and 11.4 / 11.5 / 9.2 / 9.4 ms for the Grove
stages, so run-to-run noise is about 1 ms. The stage 1 row contains one long frame (532 ms in the first run, 565.7 ms in this one) at the first arrival there; every
other row's slowest frame is at most 34 ms. Its cause was not investigated (first use of the stage-1 ground after the teleport is the likely
suspect). During the actual fights (vsync-capped, 60 Hz, so frame time is not informative) the renderer reported 170 / 146 / 122 draw
calls and 1.70 / 1.52 / 1.26 million triangles for stages 1 / 2 / 3. Against Greenwake's spawn the Grove's spots draw 1.06x to 1.69x the calls and 0.68x to 1.11x the triangles.

## Verification

```sh
node node_modules/typescript/bin/tsc --noEmit
bun test tests/combat tests/rendering tests/ui tests/app tests/world tests/effects tests/audio
node --test tests/rendering/quadruped-clips.test.mjs tests/rendering/story-map-assets.test.mjs
```

What the tests prove:

- `grove-sealed-route`: the variant is built by the shared dispatcher and leaves the authored region untouched; twelve walkable
  surfaces with flush support slabs; spawn, navigation, ribbons, cameras and the exit ring lie on walkable floor; each arena lies inside its
  clearing on the near side of its gate; every gate is a tall thick box over its cross-section with at least 1 m of void to each end;
  per-gate flood fills with the real `moveCircle` capsule show each opened gate adds exactly the next stage; the one route runs through
  all three stages in order; no jump-reach pair joins the two sides of a closed gate; Run, Dive and Jump chains from each gate's faces
  never breach it in the real engine and the same inputs pass the opened gate; Koro is not a companion and stays idle through the whole run.
- `grove-defence`: the three-stage trial set and ramped difficulty (only the last stage is the boss), arenas inside clearings with
  profiles whose band fits, exactly the ten attacks, no obstacle word or element, escalating damage, live hazards at runtime (the leap
  lunges, the hurl and burst never do), each defeat opens its gate and turns the monster neutral, and a light attack on a one-hit
  guardian completes the run.
- `grove-practice`: the stage-1 invariants carried over (set and encounter, contract attacks, live hazard geometry, roars, the gate refusing
  then admitting a run).
- `grove-world`: biome only for the variant; terrain exact on every walkable (twelve flat surfaces); the mound clear of the walk-mesh; both
  pools carved off every walkable with the water mesh clear of them; particles and water in one draw call; boundary rules; mesh, mask and
  clutter budgets against Greenwake; the Black Sap field (none south of gate 1, dense in the hollow, total round the pool); the dead
  dressing (no stone, tree or shrub on a route or arena); the four merged blight meshes (finite, bounded, reduced effects still the
  sap, dispose frees them); the framing test (from the gameplay camera the pool and the ring stand behind the guardian).
- `grove-kits`, `grove-audio`, `grove-monster-profiles`: kit routing and caps, reduced effects, cancellation, ground quads inside
  the footprint, auras; recipes per phase within budgets; clip plans, strike alignment and locomotion.
- `quadruped-clips`, `story-map-assets`: see `asset-pipeline.md` ("Hollowheart, the Sapbound Guardian, and the blighted rootling").

## Integration notes for the shared layer

- `AssetPlaytests`: region `the-grove`, `exitRouteId` `grove-trial-exit`, stage exit name "Ridge Trail", `trialSet` `GROVE_TRIAL_SET`.
  Completion now requires all three trials (the exit sits behind the last gate).
- The manifest `asset-source/playtests/grove.json` carries: the environment recipe `the-grove-environment` with twelve components
  (`prop-ancient-canopy-shrine`, `prop-canopy-cliff-rock`, `prop-canopy-fern-cluster`, `prop-erya-edge-tree`,
  `prop-greenwake-boulder-cluster`, `prop-grove-platform`, `prop-heartroot-trunk`, `prop-mire-bank-rock`, `prop-refuge-shelter`,
  `prop-root-cavern-mouth`, `prop-training-post`, `prop-water-basin`), `actor-vara`, `actor-koro`, `actor-grove-rootling`,
  `actor-grove-blighted-rootling` and `actor-grove-hollowheart`, plus the shared entries (`actor-aren`, the trial gate, the hero weapon
  and variant assets). Every entry stays evidence `blocked`; the "LOCAL PLAYTEST - GENERATED GLB CANDIDATES - NOT RELEASE-VERIFIED"
  banner stays.
- `LOCOMOTION['actor-koro']` makes every `actor-koro` instance use the monster clip slots; the Grove manifest must therefore map the
  ten monster slots for `actor-koro` (idle and walk are the ones Koro uses).
- `startShowcase` style direct start: the variant's spawn is `nodes[0]` = (10, 0, 44); the authored region's own start differs, so a
  campaign safe-spawn lookup must not override it.
