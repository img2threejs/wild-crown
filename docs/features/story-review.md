# Story review: the five playable maps

Scope: the story as the local playable build tells it, in the unlock order of `src/app/AssetPlaytests.ts`: Greenwake → Whispering Canopy → The Grove → Moonpine Ridge → Mistveil Basin. Sources read: `src/content/story.ts`, `dialogue.ts`, `narrative-cues.ts`, `src/app/StoryChapters.ts`, `src/app/AssetPlaytests.ts`, `docs/production/content/GAME-NARRATIVE.en.md` §3–§6 and the four `docs/features/*-playtest.md` files. Nothing here changes ids, conditions, quest structure or saved data; the fixes below are player-facing copy only.

## Arc, map by map

| # | Map (chapter label) | What the player is told | What the player does | Closing beat |
|---|---|---|---|---|
| 1 | **Greenwake** (Prologue, “The Night of a Thousand Roars”) | Every creature roars at once; Vara falls with the Sky fragment; Yara recalls the Wild Pact (`prologue-vision`: “BRING THEM HOME”). Aren hears something beneath the roots: the animals flee *it*, not each other. | Reach and tend Vara, take the fragment and the Warden Staff, cleanse a corrupted boar without killing it. Trial monsters: Ember Boar, Frost Sap-Stalker, Root Rammer. | “The forest opens”: the way out of Greenwake. |
| 2 | **Whispering Canopy** (Chapter 1) | Birds and monkeys fight over the last seeds; the orchard is dying from poisoned water; neither side is wholly wrong. Koro steals the fragment to test Aren (`branches-open/close`: help “for this moment, not a promise”). | Tend Vara, chase Koro, restore water and seed (`orchard-open/close`). Trial monsters: Thornback Howler, Storm Hornbill, Mire Viper. | The accord is an obligation, not a prize; the route to the Grove opens. |
| 3 | **The Grove** (Sanctuary, three-stage defence) | A young Heartroot, a pool and Yara’s tent; the sanctuary records the journey. Vara and Koro have arrived, birds nest and monkeys build. Nothing in the Grove hunts, but Black Sap is seeping into the Memory Pool, where the Grove keeps its record of every promise, and has reached the guardian that tends the water (`regionPresentation.ts` intro beats and threat line). | Defend the Grove in three gated stages (`grove-playtest.md`): spar with the Heartroot Sprig (`evasion-practice`), hold the blighted hollow against a Blighted Rootling (`sap-incursion`) and free Hollowheart, the Sapbound Guardian, at the Memory Pool (`memory-pool`). Each gate opens only on its stage's defeat; the last one opens the Ridge Trail. Side-quest beats are authored in `story.ts` (`the-empty-nest`, `seeds-between-branches`, …). | “The sanctuary holds”: Hollowheart is free of the Black Sap and the Memory Pool runs clear; Aren sets out toward Moonpine Ridge (stage copy in `AssetPlaytests.ts`). |
| 4 | **Moonpine Ridge** (Chapter 3) | A three-pulse howl: the third rises from beneath the temple (`howl-open`). Two packs, Luma’s reformers and Ruun’s followers, are splitting (`two-packs-open`). | Break Ruun’s chains and cleanse the howl that carries Black Sap into the roots (`ruun-open/close`). Trial monsters: Frostfang, Howl Scout; boss Ruun, the Chained Howl. | “The pack is free”: the temple path descends toward Mistveil. |
| 5 | **Mistveil Basin** (Chapter 4) | Claw marks circle a Black Sap wound instead of a body: Nyra contained the infection rather than causing it (`mist-eyes-open`). Marek’s rig feeds the river (`river-open`). The route to Hollow must not depend on Marek (`marek-variant`). | Follow the evidence, cleanse the river’s source, calm Ghor (`ghor-open/close`). Trial monsters: Bog Lurker, Lantern Heron, boss Ghor, the Mire Maw. | “The river runs clear”: the root cavern leads deeper. |

The through-line that holds across all five maps and is worth protecting in every future edit: **cleansing is not conquest** (Aren never kills, `GAME-NARRATIVE` §1 item 7), **help is offered, never commanded** (Koro, the packs, Marek, Solkar’s offer), and **the cause is upstream of the monster** (a hunter’s trap, poisoned water, a chained leader). Those three ideas each reappear in the new loading lore and intro beats (`src/content/regionPresentation.ts`).

### The Grove, stage by stage

The Grove stopped being the "safe" map of the arc: it is the first place where the Black Sap threatens somewhere that was already healed, and it is told through three defenders in the order the sap travelled (`GroveContent.ts`, `regionPresentation.ts`, `AssetPlaytests.ts`):

| Stage | Defender | What it says | Mechanical shape |
|---|---|---|---|
| 1 `evasion-practice` | Heartroot Sprig (160 vitality, 1.6 m) | The sanctuary teaches the Warden by sparring: gentle seeds, a ripple, a petal lane. Nothing here is hostile by nature. | Long windups, 4 to 6 damage, meadow-gold light. |
| 2 `sap-incursion` | Blighted Rootling (184 vitality, 2.0 m) | The same spirit after the Black Sap seeped into the hollow before the pool: the body is the Sprig's, the colour and the speed are not. The cause is upstream of the monster. | Same three shapes, harder (7 to 9 damage), sap-black and poison-green light, the blight field starts at its gate. |
| 3 `memory-pool` | Hollowheart, the Sapbound Guardian (510 vitality, 3.5 m) | A Heartroot Warden spirit whose heart-light is cracked, not dark: "free it of the sap and it remembers who it was". It tends the Memory Pool, which the sap has reached. | Four telegraphed counters (leap smash, antler sweep, ichor hurl, heart-light burst), a phase roar once its vitality first falls below half. |

Cleansing is not conquest holds mechanically: a defeated defender is `downed` and turns `neutral` (it is never removed from the world), the stage-complete screen only appears when the player reaches the Ridge Trail exit with all three stages cleared (`GameApplication.checkStageArrival`; the boss dying alone does not complete the stage). The closing copy ("Hollowheart is free of the Black Sap and the Memory Pool runs clear") is the one place the map says the guardian was freed rather than beaten.

Open copy question (not changed here): the three stage titles ("Heartroot Practice", "Black Sap Incursion", "The Memory Pool") are the only player-facing names of the stages; the HUD attack line lists attack ids ("hollowheart leap smash · hollowheart antler sweep …"), which read as implementation names rather than story. Left for the HUD owner.

## Contradictions and gaps found

1. **Blood Bamboo Valley is skipped between the Grove and Moonpine Ridge.** `StoryChapters.ts` lists it as Chapter 2 (“Coming Soon”), but `ASSET_PLAYTESTS` goes Grove → Moonpine and the Grove stage copy says “You set out from the Grove toward Moonpine Ridge.” Consequences in the story as played: Tali, Asha and the Fang fragment never happen, yet the Grove’s authored progression (“After Asha: Asha has a den”) and Moonpine’s boss notes (“Asha can disrupt formations”) assume them; Orun’s “Three have returned. Three remain.” cannot be said truthfully with two fragments in hand; and Marek is first *met* in Mistveil even though the narrative introduces him as the hunter who escaped the bamboo camp (`hunters-open`). *Not fixable in copy.* Mitigation applied in the new scenes: the Mistveil intro and lore introduce Marek by role (“the hunter Marek”) at first mention instead of assuming the player knows him. Structural fix (unchanged, needs a design decision): either playable Blood Bamboo, or a one-line Grove beat that reports what happened there.
2. **Narrative cues cover only chapters 0–2 and four side quests.** `NARRATIVE_CUES` is keyed to `prologue`, the three Canopy quests, the three Bamboo quests and four side quests. The authored Moonpine and Mistveil beats (`howl-open`, `two-packs-open`, `ruun-open/close`, `mist-eyes-open`, `river-open`, `marek-variant`, `ghor-open/close`) exist in `DIALOGUE` but nothing schedules them, so the two latest playable maps are narratively silent while their copy is ready. *Structure; left for the owner of the cue scheduler.* Likewise Nyra, the emotional centre of Mistveil, never appears (`mistveil-playtest.md`: “no panther appears”); the story reaches the player only through the new intro/lore lines and these unscheduled beats.
3. **Conditional Marek lines.** `marek-variant` shows `marek-present` when `marekPresent` is true and `marek-absent` otherwise. In the local showcase start `marekPresent` is never set, so the player always saw “Marek is gone” about a man they have not met.
4. **Chapter ordering in the map select vs unlock order.** The select lists Blood Bamboo as Chapter 2 between the Grove and Chapter 3, but unlocking skips it silently (`AssetPlaytests.ts`: “story chapters without a playable map are skipped”). Not a copy fault; flagged so the select can say so.
5. **Player-facing copy that read like implementation notes** (all in `story.ts` / `dialogue.ts`, spoken by Aren/Yara/narrator or shown as journal objective text):
   - `fall-of-the-grove-opening`: “…the shelter is never loadout-gated.”
   - `fall-of-the-grove-resolution`: “…without making the next day unplayable.”
   - `wild-march-opening`: “The march is a coalition route, not a promise that the Living Pact ending is already earned.”
   - `the-hunters-remorse-opening`: “His presence may help. His absence cannot be a gate.”
   - `witness-in-the-reeds-opening`: “…rather than waiting for someone who is not part of this route.”
   - `orun-the-hollow-king-opening`: “Wait for the announced cue, then choose your response.”
   - `heartroot-hollow-opening` and `hollow-opening`: “direct counter that you can perform alone”, “no companion is required here.”
   - `river-open` (Aren): “The route to Hollow must not depend on Marek’s answer.”
   - `chapter-six` narrator (`tali-failure`): “…return safely to the checkpoint and try again.”
   - Chapter 6/7/8 objective descriptions in `story.ts` (“do not award an ending automatically”, “never gate the path”, “offered only by the package predicate”).
6. **Quest copy outside this slice.** `src/content/quests.ts` and `campaign.ts` were not edited (not part of the RegionScenes ownership). Their text was not audited line by line; any implementation-note phrasing there remains open.

## Fixes applied (copy only)

| Where | Before | After |
|---|---|---|
| `story.ts` `fall-of-the-grove-opening` | “Use the ground lever if no companion is present; the shelter is never loadout-gated.” | “Use the ground lever if no companion is beside you; the shelter holds either way.” |
| `story.ts` `fall-of-the-grove-resolution` | “A loss can be real without making the next day unplayable.” | “A loss can be real without closing the road ahead.” |
| `story.ts` `wild-march-opening` | “The march is a coalition route, not a promise that the Living Pact ending is already earned.” | “The march is a coalition, not a promise; the Living Pact still has to be earned.” |
| `story.ts` `the-hunters-remorse-opening` | “His presence may help. His absence cannot be a gate.” | “His help would be welcome. His absence will not stop us.” |
| `story.ts` `witness-in-the-reeds-opening` | “Use the bypass rather than waiting for someone who is not part of this route.” | “Use the bypass; this crossing does not have to wait for anyone.” |
| `story.ts` `a-path-for-the-young-opening` | “…the obligation she accepted determines the formation.” | “Asha will guard the young or lead the march, depending on the promise she made.” |
| `story.ts` `seeds-between-branches-opening` | “Carry each basket in the requested order so neither store is emptied.” | “Carry the baskets across in turn so neither store is emptied.” |
| `story.ts` `river-of-black-sap-resolution` | “The source is neutralized; the water must still be allowed to settle.” | “The source is quiet; the water still needs time to settle.” |
| `story.ts` `heartroot-hollow-opening` | “Each one has a direct counter that you can perform alone.” / “…they are not the key to the Crown.” | “Each one can be answered by your own hand.” / “Companions can clear the way or shorten it, but they are not the key to the Crown.” |
| `story.ts` `orun-the-hollow-king-opening` | “He mirrors a Warden’s actions, not a single attack. Wait for the announced cue, then choose your response.” | “He mirrors a Warden’s whole stance, not a single strike. Watch for his warning, then choose your answer.” |
| `story.ts` objectives (`prologue:receive-sky`, `chapter-6:protect-tali`, `chapter-7:form-march`, `chapter-8:resolve-aspects`, `chapter-8:choose-ending`) | notes about “existing phrase”, “do not award an ending automatically”, “player-only counter… never gate the path”, “package predicate” | in-world descriptions of the same objectives (ids, events, mechanics and targets unchanged) |
| `dialogue.ts` `river-open` (Aren) | “The route to Hollow must not depend on Marek’s answer.” | “Whatever Marek answers, the way to Hollow stays open.” |
| `dialogue.ts` `marek-variant` (`marek-absent`, narrator) | “Marek is gone. A stamped ledger and the empty rig identify the upstream source.” | “No sign of Marek remains. A stamped ledger and the empty rig point to the source upstream.” |
| `dialogue.ts` `chapter-six` (`tali-failure`) | “If Tali is endangered, return safely to the checkpoint and try again.” | “Tali is not lost. The roots draw you back to the last safe moment; try again.” |
| `dialogue.ts` `hollow-opening` (Aren) | “…but no companion is required here.” | “…but this answer is mine to give.” |

Ids, speakers, delivery, conditions, quest/beat structure and the `NARRATIVE_CUES` table are untouched. `narrative-cues.ts` contains no player-facing copy and was not changed.

## Region scenes (presentation layer added in this round)

New files: `src/content/regionPresentation.ts` (copy, palette, atmosphere and art URL for the five maps; `artUrl` is the single place to swap in higher-resolution art), `src/ui/regionScenes.ts` (pure string builders) and `src/ui/region-scenes.css`.

- `loadingSceneMarkup(model)`: full-bleed layered backdrop (art with a 38 s Ken-Burns drift, palette grade, bloom, shade, vignette), a CSS-only particle layer, chapter label, per-letter title reveal, tagline, one rotating lore line (`loreIndex` is wrapped modulo the lore list), and a thin rune progress bar with a glow head, percent, phase label and detail. `role="progressbar"` carries `aria-valuenow` only when progress is known; unknown progress is an indeterminate bar with `aria-valuetext="Preparing"`. The caller appends errors and recovery buttons inside `[data-scene-actions]`.
- `loadingSceneProgressMarkup(model)`: the progress block alone (`[data-scene-progress]`). A caller that re-renders on every progress tick should patch this block in place; a full `innerHTML` replacement restarts the title reveal.
- `mapIntroMarkup(model)`: letterbox bars slide in, then chapter label → title → tagline → story beats → threat line → “`<hero>` enters `<map>`” appear on strictly increasing CSS delays; Continue (`data-ui-action="intro-continue"`, `data-focus-key="intro-continue"`, primary) and Skip (`intro-skip`) are visible from 1.1 s so the sequence is never a gate.
- Exit: add `.is-leaving` to the `.wc-scene` root. Content lifts and fades, the letterbox bars slide back out and the scene fades over 0.6 s (0.2 s plain fade in reduced motion).
- Reduced motion: `reducedMotion: true` (settings) emits `wc-scene--static`, no particle layer, no drift class, no per-letter spans; `@media (prefers-reduced-motion: reduce)` resolves the same static frame for markup that was built with motion. The static frame keeps the art, grade, bloom, vignette, letterbox bars and all text.
- No timers, listeners or `Math.random` in the module (asserted by the tests). Markup is deterministic: particle positions come from an integer hash of the particle index.

Measured facts (from the committed source):

| Item | Value |
|---|---|
| Particle elements | fireflies 18, leaves 14, pollen 24, snow 24, mist 12 (8 banks + 4 lantern motes); cap 24 |
| Keyframes | 20 `@keyframes` rules; the test asserts every one animates `transform` and `opacity` only |
| CSS size | 21 677 bytes (4 986 gzipped) |
| Markup size per scene | loading 3.6–4.5 KB (58–70 elements); intro 4.1–5.0 KB (57–69 elements) |
| Backdrop art | the existing map-select captures `/asset-source/ui/maps/*.jpg` (960×540 for Greenwake and Canopy, 1200×675 for the others) |

Tests: `tests/ui/regionScenes.test.ts` (completeness and sync with `ASSET_PLAYTESTS`, escaping, aria values, intro action keys, delay ordering, reduced-motion markup, particle cap, unknown-region errors, no timers, transform/opacity-only keyframes).
