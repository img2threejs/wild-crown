# The Grove playtest map

The Grove is the story hub of the local asset playtests (GAME-NARRATIVE section 6, "The Grove"): a sanctuary that records the
journey. In its early state it holds a young Heartroot tree, a pool and Yara's tent; Vara and Koro have arrived, birds nest and
monkeys build platforms, and evasion practice happens here. It is peaceful, warm, golden-green and safe.

It follows the Whispering Canopy playtest in architecture (`docs/features/combat.md`, "Whispering Canopy playtest"): the authored
`the-grove` region in `src/content/levels/act-i.ts` is never modified; `createGroveTrialRegion` builds a playtest variant that
replaces its ground, navigation, cameras, routes, entities and props and keeps its identity (id, name, environment recipe).

Unlike the canopy, the Grove has **one optional practice and no combat gate on the route**: completing the map never requires the
practice, and the player can walk from the spawn to the exit without ever coming near the practice gate.

## Files

| Area | File |
|---|---|
| Gameplay data (trial, attacks, encounter, monster profile, actors, glow, solid profiles) | `src/game/combat/GroveContent.ts` |
| Region variant (walk-mesh, navigation, cameras, exit, entities, props) | `src/game/combat/GroveTrialRegion.ts` |
| Boundary dressing | `src/world/GroveBoundary.ts` |
| Biome (terrain, splat layers, understory, water plan, atmosphere) | `src/world/GroveBiome.ts` |
| Pond geometry, carve and water plan | `src/world/GrovePond.ts` |
| Mound and far meadow relief | `src/world/GroveTerrain.ts` |
| Pollen, fireflies, petals, exit and Heartroot glow | `src/world/GroveAtmosphere.ts` |
| VFX kits | `src/effects/vfx/GroveKits.ts` |
| Procedural sounds | `src/audio/GroveSounds.ts` |
| Monster clip plans and locomotion | `src/rendering/GroveMonsterProfiles.ts` |
| Tests | `tests/combat/grove-practice.test.ts`, `tests/combat/grove-sealed-route.test.ts`, `tests/world/grove-world.test.ts`, `tests/effects/grove-kits.test.ts`, `tests/rendering/grove-monster-profiles.test.ts`, `tests/audio/grove-audio.test.ts` |

The shared registries (`CombatTrials`, `content`, `WildlifePressure`, world `ACTORS`, palette `OWNER_GLOW`, `solid-props`,
`TrialRegions`, `Biomes`, `ElementKits`, `ActorVfx`, `StoryAudio`, `MonsterAnimationProfiles`) spread these per-map exports. No texture
is added: the biome reuses the five CC0 Poly Haven sets under `asset-source/textures/canopy` (same texture memory as the canopy).

## Layout

Coordinates are metres; north is -z. Camera anchors keep the locked three-quarter offset (+10, +12, +14) from the point they frame;
tall things stand on the far (north-west) side of the route so the Warden is never hidden. All nine walk surfaces are flat `y = 0`
ground with ids prefixed `grove-trial-` (the prefix `biomeProfileFor` uses to give only the variant the Grove biome). The variant
overrides the region bounds (-50..46, -66..58) because the walk-mesh (x -34.5..34, z -54..48) exceeds the authored ones.

| Surface | Footprint | Role |
|---|---|---|
| `grove-trial-trailhead` | x 5..15, z 26..48 | south trailhead; spawn `nodes[0]` (10, 0, 44) |
| `grove-trial-glade` | irregular, x -13..24, z -5..29 | central glade; straight north edge at z -5 |
| `grove-trial-camp` | x -34..-12, z -4..16 | Yara's camp |
| `grove-trial-lookout-pad` | x 18..34, z -6..18 | monkey lookouts and Koro |
| `grove-trial-north-trail` | x 19..27, z -48..-4 | the way to the exit |
| `grove-trial-ring-path` | x -28..-20, z -13..-3 | camp to practice ring |
| `grove-trial-practice-ring` | 16-gon, r 10.5 around (-24, -22) | the practice arena clearing |
| `grove-trial-pool-spur` | x -27..-21, z -49..-31 | the gated spur (6 m wide) |
| `grove-trial-pool-overlook` | x -31..-17, z -54..-46 | Memory Pool overlook |

Props (all `ground` placements):

| Id | Asset | Position | Notes |
|---|---|---|---|
| `grove-trial-heartroot` | `prop-heartroot-trunk` (9 m) | (-2, -13) | young Heartroot on a 0.7 m mound (`GroveTerrain.ts`), beside the pond; solid kind `trunk` |
| `grove-trial-tent` | `prop-refuge-shelter` (4 m) | (-29, 7) | Yara's tent; solid kind `solid` |
| `grove-trial-lookout-a`, `-b` | `prop-grove-platform` (4 m) | (31, -3), (31, 13) | monkey lookouts on stilts; kind `platform`; **not walkable** (every walk surface is `y = 0`, nothing stands at deck height) |
| `grove-trial-post-0..3` | `prop-training-post` (2.5 m) | (-31, -28.5), (-17, -28.5), (-32.5, -18), (-15.5, -18) | frame the practice ring's rim (outside the radius-8 arena); kind `trunk` |
| `grove-trial-memory-basin` | `prop-water-basin` (4 m) | (-24, -51.5) | the Memory Pool spring at the overlook; kind `solid` |

The pond (`GrovePond.ts`) is a real biome water pool: an elliptical dish (water-edge radii 4.4 x 3, centre (11, -12)) carved
0.64 m deep, with water level -0.1, outside the walk-mesh (at least 2.5 m from every walkable) between the Heartroot's mound and
the north trail.

Entities: `grove-vara` (actor `vara`, `actor-vara`, placement `canopy`, about 3.6 m from the spawn, exactly like `canopy-vara`),
`grove-koro` (actor `grove-koro`, `actor-koro`, (28.5, 0, 5), idling between the two lookouts) and `grove-sprig` (the practice
monster, (-24, 0, -26)). Navigation: 15 nodes and 3 ribbons (`grove-trial-main-route` spawn to exit, `grove-trial-camp-route`,
`grove-trial-pool-route`); seven camera anchors.

### Required route and the exit

Spawn (10, 0, 44) -> trailhead -> glade -> east of the pond -> north trail -> exit. The exit is the authored route `grove-ridge-out`
copied with its `unlockFact` stripped, id `grove-trial-exit`, `from` = (23, 0, -44) (the 2.2 m goal ring lies completely on the
trail), `colliderIds: []`; the coordinator shows it as "Ridge Trail". The shortest spawn-to-exit walk stays at least 30 m from the
gate and more than 16 m from the practice monster (its disengage range), so the required route never triggers the practice.

## Evasion practice

One trial, hosted by the wildlife encounter `grove-practice` (`GROVE_ENCOUNTERS`, one phase, roster exactly `grove-sprig`; Koro is
scenery and never joins it).

| Trial | Monster | Asset | Spawn | Arena | Gate | Cleared title |
|---|---|---|---|---|---|---|
| `evasion-practice` "Heartroot Practice" | `grove-sprig` "Heartroot Sprig" | `actor-grove-rootling` | (-24, 0, -26) | centre (-24, 0, -22), r 8 | `trial-gate:evasion-practice` at (-24, -38), across x | "Practice complete" |

The gate (`trialGate`, 9 m wide, 1.2 m thick, from y -0.5 to 4.5) covers the spur's complete 6 m cross-section with at least 1 m of
void each side. Closed, it separates exactly the spur beyond z -37.4 and the Memory Pool overlook from the rest of the walk-mesh;
opening it (defeating the sprig) removes the collider and lets the player walk to the overlook. The monster then turns neutral and
the encounter title reads "Practice complete". The stage waystone also waits for this defeat. The practice never emits campaign
rewards or world facts.

`grove-sprig` is a gentle sparring partner: `MONSTER_PROFILES['grove-sprig']` = radius 0.6, band 5 to 8 m, advance 2.2, circle 1.5,
retreat 2 m/s, yaw rate 2.2, strafes 150 to 260 ticks. Its attacks (prefix `sprig-`, registered for HUD names; no id contains an
obstacle word, none is elemental, no lunge, no push):

| Attack | Kind | Size (m) | Timing w/c/a/r (ticks) | Damage | Counterplay cue |
|---|---|---|---|---|---|
| `sprig-seed-toss` | strike (disk) | radius 1.6 | 66 / 14 / 10 / 54 | 4 | "The sprig lobs a glowing seed toward where Aren stood. Step off the mark before it lands." |
| `sprig-ground-ripple` | wave | 5 x 1.2 | 60 / 14 / 14 / 56 | 5 | "A low ripple runs through the grass toward Aren. Jump over it or step across." |
| `sprig-petal-sweep` | sweep (lane from source) | 2.4 x 6.5 | 66 / 14 / 12 / 54 | 6 | "Petals fan out in a straight lane from the sprig. Sidestep the lane." |

`grove-sprig` is an `ACTORS` entry (species `rootling`, wild, hostile, `actor-grove-rootling`). `grove-koro` is a second entry
(species `macaque`, role `leader`, allegiance `ally`, combat role `noncombat`, `actor-koro`) separate from the story companion
`koro`. In the engine an ally with a non-`koro` id is never selected as a companion (slots resolve by archetype), never hostile
(only encounter participants become hostile), never a hazard target (hazards target the player or the selected companion) and
never targeted; it only idles.

## Presentation

- **Biome.** A meadow sanctuary in warm late-afternoon light: sun-bleached golden-green grass, a pale packed-earth trail, gentle
  relief (mounds at most 0.55 m, no summits, no cliffs), a smooth 0.7 m mound for the Heartroot and two soft swells of meadow far
  behind the route (west and north), the pond through the water plan, a low warm sun (`0xffc27a`, backlit from the north-west),
  golden-green fog that reads far (near 16, far 86). The flowering understory is the `broadleaf` recipe tinted rose, cream, gold
  and lavender, with rose and cream petal drifts (`leaf-pile`), meadow ferns and pebbles.
- **Atmosphere feature** (`GroveAtmosphere`, one `Points` draw call driven by the world clock): golden pollen, fireflies and loose
  petals around the player, a warm clearing glow at the exit and a soft gold-green glow at the Heartroot's foot. Reduced Motion /
  Reduced Effects keeps a third of the pollen, drops fireflies, petals and the Heartroot glow, and keeps the exit glow.
- **Boundary dressing** (`GroveBoundary`, ids `grove-boundary-<tree|rock|fern>-N`, decoration only, rocks `grove-boundary-rock-N`):
  `prop-erya-edge-tree` (trees only behind edges that face away from the camera), `prop-greenwake-boulder-cluster` and
  `prop-canopy-fern-cluster`, at least 0.8 m from every walkable, off the water, off the Heartroot's mound, clear of the gate, the
  arena, the authored props and the exit ring; ferns ring the pond's bank and the Heartroot's foot.
- **VFX kits** (`GroveKits`): attack id = kit id, gold-green (`sap`) seed lob with a sparkling trail and a soft bloom, amber (`earth`)
  ripple with a travelling head of blades and dust, green (`spirit`) petal sweep with a lane beam and rose/cream petals. Footprint-bound,
  tiny shake, no extra draw call, 35 % of the emissions under reduced effects. `GROVE_AURAS` maps `grove-sprig` to the existing
  `earth` aura; `OWNER_GLOW['grove-sprig']` is `sap` (never the player-only `heartroot` look).
- **Sounds** (`GroveSounds`): soft wooden knocks, leaf rustle and small chimes per attack phase, and a gentle rising chirr as the
  roar (five triangle chirps over a soft breath, no sawtooth or square). Voiced through the shared wildlife pool of `StoryAudio`.
- **Monster profiles** (`GroveMonsterProfiles`): seed toss uses the `monster-shoot` clip, ground ripple `monster-dive`, petal sweep
  `monster-slash`, with the strike pose landing on the active window like the canopy plans. `LOCOMOTION` entries for
  `actor-grove-rootling` and `actor-koro` (Koro only idles and walks; its run threshold is out of reach). No hover.

## Verification

```sh
npx tsc --noEmit -p .
bun test tests/combat/grove-practice.test.ts tests/combat/grove-sealed-route.test.ts tests/world/grove-world.test.ts \
  tests/effects/grove-kits.test.ts tests/rendering/grove-monster-profiles.test.ts tests/audio/grove-audio.test.ts
```

What the tests prove:

- `grove-sealed-route`: the variant is built by the shared dispatcher and leaves the authored region untouched; nine walkable
  surfaces, spawn, navigation, ribbons, cameras and the exit ring lie on walkable floor; flood fill with the real `moveCircle`
  capsule shows the closed gate cuts off exactly the spur beyond it and the overlook while the exit, the ring and the arena stay
  reachable; the shortest spawn-to-exit walk (gate open or closed) never goes near the gate or the practice; Run, Dive and Jump
  chains from the gate's faces and ends in 16 directions never breach it, and the same inputs pass the opened gate; the region loads in
  the engine, `grove-practice` starts, Koro is not a companion and stays idle and untouched through a whole practice.
- `grove-practice`: the set and encounter invariants, the contract trial and attacks (shape, timing, gentle damage, no obstacle trap),
  live hazard geometry, the monster cycling its roster inside the arena, the engage and escalation roars, the monster not engaging
  a player on the required route, the gate refusing and then admitting a run to the Memory Pool overlook, and a scripted walk from
  the spawn to the exit coordinate with the gate closed. Victory gating (only a defeated sprig opens the gate; time, movement and
  dodges never do) is covered for every map by `combat-trials.test.ts`.
- `grove-world`: biome only for the variant; terrain exact on every walkable; a smooth low mound clear of the walk-mesh; the real
  pond (carve, water level, water mesh off every walkable); atmosphere particles, reduced effects; boundary rules; mesh, mask and
  clutter budgets against Greenwake; mask painting; palette and light; the reused CC0 texture provenance; `RegionEnvironment`.
- `grove-kits`, `grove-audio`, `grove-monster-profiles`: kit routing and caps, reduced effects, cancellation, the seed arc, ground
  quads inside the footprint, auras; recipes per phase within budgets and soft by construction; clip plans, strike alignment and
  locomotion.

## Integration notes for the shared layer

- `AssetPlaytests`: region `the-grove`, `exitRouteId` `grove-trial-exit`, stage exit name "Ridge Trail", `trialSet` `GROVE_TRIAL_SET`.
  The practice is optional, so completion must not depend on the trial state.
- The manifest must contain exactly: the environment recipe, `actor-vara`, `actor-koro`, `actor-grove-rootling`,
  `prop-heartroot-trunk`, `prop-refuge-shelter`, `prop-grove-platform`, `prop-training-post`, `prop-water-basin`,
  `prop-erya-edge-tree`, `prop-greenwake-boulder-cluster`, `prop-canopy-fern-cluster` (the variant's `assetIds`), plus the shared
  entries (`actor-aren`, the trial gate, the hero weapon and variant assets).
- `LOCOMOTION['actor-koro']` makes every `actor-koro` instance use the monster clip slots; the Grove manifest must therefore map
  the ten monster slots for `actor-koro` (idle and walk are the ones Koro uses).
- `startShowcase` style direct start: the variant's spawn is `nodes[0]` = (10, 0, 44); the authored region's own start differs, so a
  campaign safe-spawn lookup must not override it.
