# Wild Crown — full feedback remediation (2026-10-14)

Source feedback: concept-gap audit (Bible vs implementation) + kinematics audit, 2026-10-14. User priority: **realistic combat with physical reactions (knockback, stun)**.

## User decisions (2026-10-14)
- Design deviations: keep current design (4 heroes, free jump, mana dodge, current monsters); add the Bible's bosses on top; update the Bible/docs to match the game.
- Tripo: user increased the whole Act I–IV ceiling from ~3,000 to **5,000 credits** before Wave 3. Preserve distinct required actors/props; inspect concept and model before each next paid step and log every task. The ceiling is not a spending target.
- Budget reconciliation before Wave 3: Bamboo ledger totals 1,585 credits. Conservatively reserve the same-day 230-credit Hollowheart chain against this ceiling as well: 1,815 used/reserved, at most **3,185 remaining before new Wave 3 tasks**. Ruun already has a rigged/animated candidate and must not be regenerated. Current catalog costs must be checked before any new paid operation; account balance is not budget authorization.
- Wave 3 candidate generation initially used 2,060 additional credits. The native hub bird nest and shared seed/winter supply basket add 115 actual credits each: conservative total **4,105 / 5,000**, 895 remaining. Seven new native actors, twelve initial native props, the nest and the supply basket are packaged; Ruun/Ghor are reused. Asset acceptance remains blocked pending gates and user approval.
- Audio: CC0 / CC-BY libraries with per-file source, license, author and SHA-256 provenance.
- Asset acceptance: coordinator runs every automated gate + visual evidence, then sends the user a list to approve before any `evidenceStatus` becomes `verified`.
- Structure: real chapters (exploration, quests, dialogue, checkpoints, story boss, cleanse → companion, Bond/Dominion choice, mid-chapter saves); Trials stay as a separate replay mode.

## Phase 1 — Combat reactions and kinematics (priority)
- [x] 1A Simulation reactions (CombatEngine): authoritative `reaction` state for every combatant: flinch, stagger, knockback (eased impulse, swept with moveCircle, wall impact), knockdown + get-up, stun (with stun meter / poise break for monsters and boss poise phases), launch for heavy finishers; player reactions from monster hits scaled by attack weight with i-frames on get-up; attack lunge/magnetism for player light/heavy/finishers; monster–monster/player separation; deterministic + serialized; replaces one-tick hazard push and `hitReact`.
- [x] 1B Reaction presentation and animation kinematics (rendering): directional hit reactions (front/back/left/right), knockback slide/tumble, knockdown → get-up (monsters: death clip head + spawn clip as rise, heroes: native hit/defeat/get-up clips or authored), stun loop with stars/daze VFX, camera shake/hit-stop scaled by reaction; head/spine look-at IK; stance foot-lock for heroes; spring-bone secondary motion (tails, coats, hair, staff charms); monster foot IK/body pitch on slopes; companion gait speed matching; animation LOD.
- [x] 1C Start/stop/pivot/strafe locomotion for heroes (procedural lean/settle + authored clips where donors exist).

## Phase 2 — Act I as real chapters
- [x] 2A Act I assets via Tripo: Koro boss form, Asha (3-phase boss), Tali, Marek, Blood Bamboo Valley props.
- [x] 2B Chapter runtime: campaign flow Prologue → Greenwake → Canopy (Koro boss) → Blood Bamboo (Asha 3 phases, Tali, hunter camp) → Grove hub; quests, dialogue, checkpoints, mid-chapter save/continue, cleanse → companion, Bond/Dominion ceremony. Director smoke completed all seven main quests and reloaded the Grove checkpoint; native checks covered Prologue, saves, Boar entry and the imported Grove scene. This does not claim a full physical-combat playthrough or asset acceptance.
- [x] 2C Companion verbs in the field: Vara mark, Koro interactions, Asha block, command wheel, slot manager, per-companion Bond/Dominion levels. Native Vara warning/mark, party assignment/reload and all three Act I companion previews exercised; simulation regressions cover Koro/Asha behavior.

## Phase 3 — Acts II–IV
- [x] 3A Candidate assets: Ruun/Luma, Sable, Nyra, Solkar, Orun human/Crowned Beast, Council Envoy, Sunmane / Fall of the Grove / Hollow props. Native rig previews, weapon attachment and renderer variant swaps exercised; exact hashes/evidence are in `asset-source/generated/later-native-evidence.json`. This completes candidate production, not scene composition, full boss behavior or asset acceptance (5C).
- [x] 3B Chapters: Moonpine, Mistveil, Sunmane, Fall of the Grove, Living Pact return beats, Heartroot Hollow + Orun, 3 endings, credits. Native bounded encounter/movement/interaction checks and all three ending-to-Credits UI paths passed; authored-event progression traversed the full campaign. Post-repair gate: TypeScript, 1,125 Bun tests, 673 Node tests and build. This is not an uninterrupted physical playthrough or asset acceptance.
- [x] 3C Hub growth stages, all 12 side quests and durable world consequences, upgrades. Native-collider engine scenarios completed and reloaded all twelve quests; browser keyboard/mouse runs verified ordered deliveries, nursery escort, Marek assistance, growth scenes, patrol/play animations and Hub practice controls. Integrated gate: TypeScript, 1,163 Bun tests, 673 Node tests and build; final HUD repairs: TypeScript + 151 focused tests and native smoke. Evidence remains bounded candidate validation, not asset approval or an uninterrupted playthrough.

## Phase 4 — Audio
- [x] 4A Licensed music stems per region + restoration layers, SFX samples (combat impacts by material/weight, reactions, footsteps by surface, UI), provenance + tests; replaces procedural placeholders where samples exist.

## Phase 5 — Release readiness
- [x] 5A Bible/docs/README updated to the current design.
- [ ] 5B Benchmarks on reference hardware (`evidence/release/benchmarks.json`), gamepad pass, accessibility wiring check. All eight missing accessibility consumers are wired and exercised in native scenes; keyboard/controller remapping, held-input lifecycle and persistence have bounded logical coverage. Local M1 measurements are recorded separately in `asset-source/generated/accessibility-local-performance.json`, not promoted to reference benchmarks. Still blocked on the committed M4 Pro / Chrome 150 profile and a physical gamepad.
- [ ] 5C Asset acceptance list → user approval → `verified` flips; release validator green. The review list is ready at `docs/features/asset-acceptance.md`: 99 bindings, 90 native hash checks matched across 86 files, nine composed recipes, all blocked. Native acceptance gates (including missing G11 runtime parity), canonical export, reference evidence and explicit hash-bound user approval still prevent promotion.

## Ownership rules
One writer per file at a time; coordinator integrates, reviews diffs and runs the full gate (tsc, Bun, Node, build, live Metal smoke) after each wave.
