# Companion simulation and shared geometry

`CompanionSystem.ts` owns deterministic support state and grounded navigation. `CombatEngine` owns actors, encounter state, world facts, and event processing. The companion module does not create actors: a selected companion must already be present, visible, alive, and unpossessed in the loaded region.

## Companion behavior

- `createCompanionState(companionId, chapter)` creates at most one explicitly equipped companion. Warden’s Call defaults unavailable until campaign data explicitly supplies it; chapter numbers never infer its loss or grant.
- `configureCompanions(engine, config)` applies chapter, explicit Warden’s Call, Bond, Dominion history, and authored navigation nodes without resetting command resources.
- `configureCompanion(engine, companionId)` atomically reconciles an already loaded actor. Absent, hidden, downed or possessed selections are refused without mutation. The application stages the selected native body with `prepareCompanionParty` before committing the durable selection and live engine/renderer replacement. Per-companion support deadlines survive replacement; the outgoing owner boon and slow do not.
- Actor lookup prefers the explicit `<id>__party_companion` instance, then a canonical actor ID, then one unambiguous archetype. Story/boss counterparts are not converted into traveling allies. `CompanionParty` contains only `companionId`; runtime `slots` contains at most that one entry. Cues/events carry the actual instance ID.
- `commandCompanion(engine, request)` accepts typed actor, interaction or hazard targets. Equipped identity, presence, possession, cooldown, resources and target-specific conditions are checked before spending; story recruitment does not gate ordinary support. `commandAvailability` and `commandTargets` share that path. Follow/Recall/Stay, Vara's Mark, Search and Distract are free; Storm Talon and other accepted support abilities cost one token. Koro's object Special requires a registered resting object and revalidates its unobstructed sweep at contact. CombatEngine owns object flight and its WorldEvent.
- `ALL_COMPANION_SKILLS` in `CompanionSkills.ts` is the UI/native-action contract for all 20 skills, including a required single element, target, proactive behavior, finite duration, release and contact. Unknown native bindings fail rather than silently showing idle.
- `stepCompanions(engine)` replenishes tokens and advances bounded navigation, finite gestures and proactive support on world time. It never teleports through a collider or initiates ambient aggro. The equipped follower assists an actually engaged story or ambient enemy, retaining one token for a manual order. Search, movable objects and story interactions never run automatically. Stay/Recall cancel a pending gesture/contact; completion releases the native pose back to idle/follow.

Navigation consumes authored `navigation.nodes` and explicit links. Node requirements open only when their corresponding world fact is `true` or an authored traversal gate is unlocked. Direct paths and graph edges use shared surface heights and the same grounded-capsule clearance test. Vara follows/scouts at elevated Y through the 3D capsule sweep; terrain does not snap her to the floor and colliders/world bounds constrain flight.

Support has one primary benefit per companion: **Asha** pins unarmoured enemies for 1 second (bosses 0.25 seconds, committed attacks preserved), with 10-second control immunity; reachable Charge Block shares her 12-second cooldown. **Sable** slows movement 35% for 4 seconds (bosses 15% for 3 seconds), on a 10-second cooldown. **Koro** heals the nearby owner by 8% maximum Vitality, clamped to full, on a 14-second cooldown. **Vara** grants +12% movement speed for 4 seconds on actual dive contact, on a 10-second cooldown. **Nyra** cuts remaining hero skill cooldowns by 20%, capped at 90 simulation ticks per skill, on a 12-second cooldown. **Solkar** grants the owner +12% strike damage for 5 seconds, on a 12-second cooldown; no Instinct or ally-cooldown bundle. Owner benefits require a living owner within 12 m of the helper. Boons never stack and are invalidated by replacement, death, suppression or possession. Hero and companion slows use the stronger factor without extending one another. Generic Defend is interposition, not invulnerability. Nyra's optional rootway remains a separate authored semantic interaction requiring equipped, visible, unpossessed Nyra and the hero within 2 m; it does not invent a route/reward or require Warden's Call/Bond.

After Warden’s Call is lost, Ask/Signal remains gated by Bond rather than a chapter-number guess. Presentation cues do not write campaign history.

## Native gestures and VFX

| Companion | Skills and native gestures | Distinct presentation |
|---|---|---|
| Vara | Storm Talon: takeoff → dive → strike → fly; Mark: `vara-sky-mark`; Sky Survey: `vara-sky-survey` | Wind spiral/streaks and owner tailwind; Lightning marker; Wind search fan |
| Koro | Mending Seed: `koro-throw`; Move Object: `koro-push`; Distract: `koro-distract`; Canopy Search: `koro-search` | Wood seed/leaves and owner healing flourish; Earth hand strands/dust; Wood attention glyph and leaf traces |
| Asha | Charge Block: `asha-guard`; Searing Pin: `asha-pin`; Fang Search: `asha-search`; Distract: `asha-distract` | Forepaw guard arch; moving-paw fire cuts; small Earth scraping accents; braced head/jaw challenge |
| Sable | Undertow Flank: `sable-flank`; Track: `sable-search`; Distract: `sable-distract` | Paw-driven Water wake and jaw contact splash; nose-down tracking; Ice mouth accents |
| Nyra | Static Ambush: `nyra-ambush`; Reveal Traces: `nyra-search`; Distract: `nyra-distract` | Lightning paw trails during the physical pounce; owner tempo flourish only on contact; Shadow tracking accents |
| Solkar | Ember Rally: `solkar-rally`; Pride Survey: `solkar-search`; Distract: `solkar-distract` | Fire roar rings/cone from the animated mouth; owner-only power aura on successful rally; Light survey/challenge |

Each ground species uses its own native GLB/skeleton, not the enemy idle resolver. Simulation cues own anticipation, release, actual contact and resolution; reactions retain priority. Clip samples, gameplay contact, VFX lifetime, cancellation and pause all follow the same authoritative world clock. Preview runs the same native actions/VFX on a separate clock and never changes tokens, quests or Bond.

## Approved Blender animation rebuild

The six companions use 26 Blender-keyframed clips, covering all 20 skills plus Vara's flight poses. `scripts/assets/blender_companion_common.py` samples the imported pose/rest world delta and reconstructs each original glTF joint's local transform. The merger appends those tracks to native GLBs without re-exporting their surfaces, materials or textures. Existing locomotion, enemy actions and hind-leg repairs remain available.

Sable and Solkar lacked a separate lower-jaw joint. `prepare-companion-jaws.mjs` adds `repair::Jaw` and lower-jaw weights without changing surface positions, UVs, normals, indices or original joints. The repair reports retain the source hash and measured neutral skin error (below \(3\times10^{-7}\) model units). Asha and Nyra retain their existing jaw/lip joints. The authoring source is explicitly Blender Python, not AI-generated animation.

Editable actions and baked original-joint samples live in `asset-source/animation/companions-blender/*.blend` and `*.json`. Source paths are repository-relative; source hashes prevent baking against a different native rig. Release/contact marker samples are included exactly alongside the 30 Hz keys, with continuous quaternion signs and strictly increasing Float32 times. Existing runtime catalogs select `*-companion.glb` and `companion-clips-report.json`; candidate/blocked evidence is not promoted.

Rebuild with Blender 4.5 LTS (`BLENDER` is its executable path):

```sh
node scripts/assets/prepare-companion-jaws.mjs
"$BLENDER" --background --factory-startup --python scripts/assets/blender_companion_quadrupeds.py -- all
"$BLENDER" --background --factory-startup --python scripts/assets/blender_companion_creatures.py -- all
node scripts/assets/build-companion-blender-assets.mjs
node scripts/assets/build-companion-blender-assets.mjs --check
```
Base native-attack and catalog authoring remains an input stage. After regenerating those inputs, rerun this final Blender pipeline before using the companion bindings; `--check` rejects stale outputs or catalog selections.


`CompanionSkillMotion.ts` supplies the physical approach/pounce path shared by simulation and preview. The simulation sweeps both grounded and airborne capsules, commits only safe ground positions, rechecks live target reach at contact, and grounds a cancelled pounce at its last safe point. A moving target cannot overlap the committed approach: the swept path stops on the actor's current side of the live combined-radius clearance, without homing the endpoint. Already-close gestures retain that collision ownership even when their planned travel is zero. Koro commits the seed's aim at release; a dodged endpoint cannot grant healing. Existing token costs, cooldowns and benefit magnitudes remain unchanged.

`CompanionSockets.ts` resolves the drawn mesh's actual paw, hand, mouth, wing and talon joints. Seed release, claw/water/lightning trails and roar cones follow those animated sockets; confirmed-contact cues own target impacts and owner benefits. Finite jobs retain their target status ring, not the obsolete stationary actor-centre-to-target wire that masked the actual projectile in mounted combat. Repeated Earth accents use small, short-lived dust rather than the metre-wide impact cloud that obscured limb poses. Scoped cancellation, actor hiding/downing and world pause govern live effects.

The finite preview player must call `AnimationController.update(step)` after sampling its normalized clip time: sampling alone does not advance idle-to-skill blend weights. The old missing update could show idle while the reported clip time advanced. Gameplay already advances the mixer, and now disables procedural grounding/lean layers while a native companion skill owns the pose.

The rebuilt preview capture covers all 20 skills at 960×720, 30 fps: 1,132 frames / 37.733333 seconds, with release/contact snapshots and per-skill-frame socket samples. All frames were manually inspected in 39 contact sheets, with full-size primary poses checked separately. This is controlled preview-clock evidence, not a damage, real-time performance or played-through campaign claim. Older accelerated capture records below are historical and do not validate this rebuild.

The mounted `GameApplication`/`CombatEngine`/`GameRenderer` capture now covers all 20 skills at 1280×832, 30 fps: 918 frames / 30.6 seconds, manually inspected across 41 contact sheets. Player-camera and inspection-camera shots are labeled; the Bamboo object shot uses one fixed camera covering its full flight. Clipped/unstable inspection shots were rejected and recaptured. These are controlled fixtures with WebGL-only capture, not a played-through campaign, normal HUD capture or real-time performance measurement. Retained engine samples include guard A/B damage prevention, hit-only seed healing and a dodged seed, live target separation, native object movement, marked Storm Talon, grounded survey takeoff, and Asha Recall/pause behavior. `asset-source/playtests/evidence/combat-polish/companion-blender-rebuild.json` binds the six native clip reports, delivery hashes, exact source ranges, reviewed sheets and verification limits; generated asset release statuses are unchanged.

The rebuild's final focused gate passed 349 tests across 22 files (862 assertions): companion behavior, companion effects, actor binding, story animation/driver contracts and native asset inputs/bindings. The seed trajectory regression also runs with a live special-job snapshot, so a stationary job wire cannot silently return alongside the socket-driven seed; the obsolete line-rendering test was deleted. `tsc -b && vite build` passed with 341 modules; Vite retained its large-chunk warning. All six generated outputs and catalog bindings passed the reproducibility check. No full-repository pass is claimed: the earlier full attempt exceeded 900 seconds with timeouts in other suite scopes.



## Vara harpy flight and Storm Talon

Vara's runtime body is a `HARPY` capsule (radius 0.55 m, height 1.3 m, `isAerialSpecies`) bound to `asset-source/generated/actor-vara-harpy-runtime-01/actor-vara-harpy-companion.glb` (23,716 tris, 50 joints; evidence status `blocked`). The original `actor-vara-harpy-animated.glb` remains the immutable input. Blender replaces nine poses: `vara:idle` 3.0 s loop, `vara:takeoff` 0.6 s, `vara:fly` 0.7 s loop, `vara:hover` 0.9 s loop, `vara:land` 0.7 s, `vara:dive` 0.4 s, `vara:strike` approximately 0.567 s, `vara-sky-mark` 0.8 s and `vara-sky-survey` 1.0 s. Native walk and hurt clips are retained. The returning `actor-roost-hornbill` retains its separate original hornbill asset.

The flight state machine in `src/game/companions/CompanionSystem.ts` runs grounded / takeoff / flying / hovering / landing. Vara perches after `VARA_PERCH_IDLE_TICKS` 240 idle ticks (≥4 s) within `VARA_PERCH_REACH` 1.7 m of Aren at flight altitude `VARA_FLY_ALTITUDE` 2.4 m. She takes off when Aren has travelled `VARA_TAKEOFF_TRAVEL` 3 m or when a live hostile is within `VARA_THREAT_RADIUS` 14 m; takeoff locks the perch so altitude rises monotonically while Aren keeps moving. A fresh slot overlapping the hero snaps to a perch clearing hero radius + Vara radius + 0.25 m. Navigation consumes the same authored `navigation.nodes` and `moveAerialCircle` sweeps as the rest of the system; colliders and world bounds constrain flight.

An approaching survey job owns Vara's flight destination instead of following the hero. It interrupts landing, triggers takeoff even without a nearby hostile, and uses a 1.2 m arrival threshold so it can reach the 1.4 m interaction radius. Survey begins only after takeoff, not while the wings remain grounded.

Storm Talon costs one token: climb 24 ticks to 4 m above the target, then dive 21 ticks toward its current body mid-height, with at most 12 pursuit ticks. Actual 3D contact delivers only 4 damage/2 poise/0.15 m knockback once; a marked target takes 6 damage/3 poise and consumes the mark. It grants the owner tailwind rather than heavy crowd control. The strike clip continues for 18 ticks before 36 ticks of flying recovery; a genuine miss recovers for 18 ticks and refunds once. Every finite phase samples advancing normalized clip time; recovery follows a captured origin rather than repeatedly lerping an already moved position.

Damage is delivered through `pendingCompanionStrikes` → `CombatEngine.drainCompanionStrikes()` → `applyHostileDamage`, with a light reaction that does not cancel committed attacks. Trial gates, cleanse sparing, encounter resolution and damage events remain authoritative. Other primary support abilities deal no vitality damage. Presentation consumes `storm-talon` and command cues through `CompanionFx`; effects never apply support, damage or story outcomes.

## Roster access, assignment and use

All six companions are selectable immediately in Chapters, Trials and existing journeys, but only one is equipped. Hero select remembers a separate choice for Aren, Yara, Vesper and Sakda; defaults are Koro, Vara, Nyra and Asha respectively. A continued run retains its saved companion instead of taking a newer hero preference. Legacy three-role parties migrate deterministically using Combat, then Utility, then Scout; no additional helper is summoned. Active story/trial encounters, engaged ambient combat and explicit Solkar exile refuse replacement. Native bodies are staged transactionally; swapping does not reset the hero, encounter, environment or per-companion support deadlines.

Recruitment remains an honest story outcome (`RECRUITMENT_RULES`): Vara by tending/Sky fragment, Koro/Asha by their cleansed encounters, Sable/Nyra by fragments, Solkar by voluntary alliance. Selecting an available companion does not grant recruitment, Bond, fragments, quests or narrative flags. Tali remains a noncombat cub, not a party member. Ask/Signal retain their separate narrative/Bond requirements.

Choose one helper in hero select, or open Companions with the configured binding (default **C**) and equip a reserve outside combat. Every skill displays its element, effect, proactive/manual policy, actual token cost, cooldown and refusal reason. **Preview animation + VFX** works for reserves without gameplay effects; **Use now · return to game** issues the real accepted command and resumes the world. Hold the configured Command Wheel binding (default **R**) for an order to the one equipped helper; there are no role tabs or shoulder/Q/E cycling.

Stay holds an ally and prevents new automatic support; Follow resumes it. Finishing a manual skill returns that ally to Follow. For a planned interception, hold Asha near the committed charge lane rather than sending her away on Pin; guard availability accounts for actual reach and remaining windup. Orun's manual integration policies use these real orders and an explicit starting formation, not disabled automation or altered boss state.

## Historical single-companion acceptance (before Blender rebuild)

[The pre-rebuild evidence record](../../asset-source/playtests/evidence/combat-polish/companion-single-support-native.json) recorded all 20 skills on the native models, across nine elements, using a controlled accelerated preview clock. It does not validate the rebuilt assets or the corrected finite-preview blend path. Its reduced-effects and cancellation observations are historical, not new acceptance results.

The final integrated gameplay gate passed **1,897 tests across 136 files** (648,601 assertions, 166.16 seconds). Scope: combat, companions, app/UI, campaign/content, effects/input/storage, audio/world/lab and the campaign package. `tsc -b && vite build` passed with 325 modules; Vite retained its >500 kB chunk warning. An earlier full-repository attempt exceeded 600 seconds while including native asset/release rebuild suites, so no full-repository gate is claimed. Koro, Vara and the unrelated Vesper GLBs retain their measured SHA-256 hashes.

The actual browser retained four independent hero choices through reload. A saved Sakda/Solkar journey loaded exactly `solkar__party_companion` even after Sakda's new preference was changed to Asha. In controlled native Greenwake, a real Use-now order and subsequent automatic Ember Rally granted only owner power: the arranged target stayed at 10,000 Vitality and Instinct stayed 0. Placement, target durability/aggro and AI recovery were controlled for observation; this is not a played-through story encounter.

A separate real-engine input smoke measured player strike damage 9 → 10.08 and steady movement 2.05 → 2.296 m over the same input interval, with haste expiry. All four heroes completed the authored player-heavy object route without Koro. The full 24 hero/companion combinations projected exactly one helper without granting recruitment or Bond.

Historical captures: [hero select desktop](../../asset-source/playtests/evidence/combat-polish/companion-single-hero-desktop.png), [390×844 mobile](../../asset-source/playtests/evidence/combat-polish/companion-single-hero-mobile.png), [Water](../../asset-source/playtests/evidence/combat-polish/companion-single-water.png), [Lightning](../../asset-source/playtests/evidence/combat-polish/companion-single-lightning.png), and [Fire](../../asset-source/playtests/evidence/combat-polish/companion-single-fire.png). Mobile had one selected helper and no horizontal document overflow. Native assets remain candidate/blocked; these older captures do not certify the rebuild, production assets or audio.



## Historical native support evidence (three-companion baseline)

The captures and damage figures below predate the single-companion rebalance; they document the unchanged native rigs, not current party composition or balance.

[The acceptance matrix](../../asset-source/playtests/evidence/combat-polish/companion-support-native.json) records all 20 native skills, actual bone-pose changes, advancing clip times, contact-phase cues and allocated VFX. [The completed video](../../asset-source/playtests/evidence/combat-polish/companion-skills-native.webm) is an accelerated preview fixture: the public preview handle additionally advances by 0.04 seconds per rendered frame. It verifies the native animation/effects path, not production-rate timing or gameplay damage. [Desktop](../../asset-source/playtests/evidence/combat-polish/companion-roster-desktop.png), [mobile](../../asset-source/playtests/evidence/combat-polish/companion-roster-mobile.png) and [skill controls](../../asset-source/playtests/evidence/combat-polish/companion-skills-controls.png) capture the actual roster/assignment/use surface.

Separate controlled live Greenwake/Grove native runs exercised real Use-now commands and proactive support. Vara's unmarked Storm Talon took the Grove target from 160 to 136; a subsequent marked hit took it to 100. Koro's native Search finished and returned to advancing idle/follow rather than holding its last pose. Chapters/Trials swaps preserved hero/world state and did not fabricate story recruitment; fighting Trials refused both selection and Clear.

The final affected-suites gate passed 863 tests across 65 files (289,026 assertions), followed by TypeScript checking and the 324-module production build. Separate observed geometry and native-harpy gates passed 140 and 14 tests respectively. This is not a full-repository test claim. The build retains its large-chunk warning. Assets remain candidate/blocked, not release-verified; these silent captures do not certify audio. The JSON retains the corrected earlier Storm footprint failure and the distinct probe-only evaluator diagnostic rather than hiding them.

## Geometry APIs

- `arenaFromRegion(region, cameraBasis?)` retains absolute-Y ground surfaces, colliders, and traversal arcs, and derives vault/slide affordance bounds from authored route anchors.
- `groundHeightAt(arena, x, z, nearY)` returns the nearest authored walkable plane/ramp/terrace/canopy/water/cavern height at X/Z, or `null` for unsupported space. `groundY` is used only for legacy arenas without surface definitions.
- `moveCircle(arena, start, delta, radius, height?)` uses bounded grounded-capsule sweeps, terrain step limits, world bounds, and box/capsule/segment collider shapes. `height` defaults to 1.7 m for legacy callers; CombatEngine supplies actor `collisionHeight` and action-specific height (Low Slide: 0.75 m). A linked walkable collider remains solid below/along its surface; vertical overlap permits exact top contact while blocking movement beneath the underside. Diagonal movement is checked before axis sliding.
- `moveAerialCircle(arena, start, delta, radius, height?)` sweeps in 3D without ground snapping, using body height for collider overlap and upper Y bounds.
- `isCirclePathClear(arena, start, end, radius, height?)` verifies a straight grounded path without treating collision sliding as a valid detour; navigation passes the actor’s collision height.
- `traversalRouteAt(arena, point, radius?)` returns the nearest authored 3D route segment/anchor. It reports context only; it does not bypass colliders, unlock gates, or emit a traversal event.

Surface interpolation and rendering share the authored polygon fan `[points[0], points[i], points[i+1]]` over absolute-Y points. Boxes use `from` as center plus `halfExtents`; capsule/segment proxies use `from`/`to` centerline endpoints and `radius`. Walk-surface links do not disable collision: vertical contact determines whether a capsule stands above, is blocked below, or passes at slide/flight height.

## Deterministic verification

Fixtures: tests/combat/geometry.test.ts, geometry-aerial.test.ts, geometry-routes.test.ts, geometry-support-collider.test.ts; tests/companions/CompanionSystem.test.ts, commands.test.ts, slots.test.ts, instances.test.ts, movableObjects.test.ts, support.test.ts, vara.test.ts, and nyra.test.ts. They cover ramps, thin obstacles, platform clearance/step boundaries, gated navigation, safe no-path behavior, unique/ambiguous archetype resolution, companion availability/roles/tokens/cooldowns, registered Koro movable-object commands and landing release, nonlethal supports, and Nyra route-event commit.

```sh
bun test tests/combat/geometry.test.ts tests/combat/geometry-aerial.test.ts tests/combat/geometry-routes.test.ts tests/combat/geometry-support-collider.test.ts tests/companions/CompanionSystem.test.ts tests/companions/commands.test.ts tests/companions/slots.test.ts tests/companions/instances.test.ts tests/companions/movableObjects.test.ts tests/companions/support.test.ts tests/companions/vara.test.ts tests/companions/nyra.test.ts
```

The focused run covers all four geometry fixtures plus the companion command, slot, instance, movable-object, support, Vara, and Nyra fixtures: 30 tests passed with 165 assertions across 12 files. Nyra’s route fixture derives her instance and position from the current mistveil-basin registry and keeps Warden’s Call/Bond disabled.

A current-CombatEngine smoke started greenwake-boar and ran 80 fixed steps (one hazard and one telegraph observed). A whispering-canopy smoke confirmed Koro Stay holds position, Ask is refused after explicit Warden’s Call loss at Bond 5, Follow moves the present Koro without path fallback, and koro-thorn emits the authored semantic inspect WorldEvent. A mistveil-basin Nyra signal smoke at her authored position emitted the exact actor-origin route WorldEvent; CampaignDirector.processEvent sets mistveil_nyra_hidden_route and accepts an identical idempotent replay.

Fixtures and live simulation smokes verify simulation only; they are not evidence of final companion mesh, rig, animation, or environment asset quality. Runtime asset manifests govern those gates.

The charge/mark and campaign movable-object regressions passed together: 17 tests, 397 assertions. They cover real engine charge damage, guard rejection without resource loss, Vara's mark/stagger effect, occupied object sweeps, finite approach/flight, save migration, and event retries. A standalone live-engine smoke measured the same charge at 80 vitality/2 tokens without interception versus 100 vitality/1 token with Asha in guard recovery. This is simulation evidence, not native companion asset acceptance.

Native candidate-chapter smoke: the command wheel displayed Vara and disabled unsupported roles/targets with reasons. Stay preserved both tokens and restored normal world time; Focus marked the live Corrupted Boar without spending a token. The companion panel displayed the real Vara GLB and animated its exact declared idle. Candidate preview actions require explicit session opt-in and a loaded matching clip; production still requires its manifest-required idle mapping. Missing clips reject visibly rather than displaying a static substitute. The browser renderer regression covers opt-in, actual playback, and missing-clip cleanup. These checks do not promote blocked assets to release-verified.

Vara also warns about a live hostile within 16 m behind the hero. The serialized warning names that exact target and expires after 300 world ticks; facing the threat emits `warning-response` once per run. An absent, downed, hidden or possessed scout cannot satisfy it, nor can a dead/hidden/out-of-range threat or an expired warning. Warnings have a 600-world-tick cooldown and spend no tokens. Story recruitment is not an ordinary Scout availability gate.

The imported completed Act I fixture loaded Grove's real native scene. Its slot manager assigned Asha to Combat and Koro to Utility; both assignments survived a browser restart. Their previews use the same calibrated `monster-idle` profile as their in-world native drivers, rather than the simulation's `asha:idle`/`koro:idle` identifiers. Both actual meshes animated without preview errors; production mapping checks remain unchanged.
