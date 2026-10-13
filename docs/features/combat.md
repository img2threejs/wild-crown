# Combat and companion simulation

`CombatEngine` is the deterministic authority for the fixed 60 Hz gameplay simulation. It accepts camera-relative input plus the current camera basis, resolves collision-safe movement, and exposes serializable state for rendering. Locomotion faces the movement direction rather than an automatically selected combat target. Renderers consume action IDs and snapshots; they never decide hit timing, actor damage, encounter rewards, or quest history.

## Evasion and combat

The engine maps all 17 approved Wild Flow actions to semantic action IDs. Dive spends 25 mana, not Instinct; the former two-charge/recharge system is removed. Profiles move in the chosen direction, obey arena bounds and obstacle collision, and carry explicit active/recovery timing. Perfect Dodge requires the actual [activeFrom, activeUntil) attack hit window to intersect the authored evasion i-frame interval, geometric overlap at the committed footprint, and an evasion that clears the hazard class; warning threatTicks alone never grant it. Attack hit groups are deduplicated. Low Slide never clears a ground wave. Staff Vault needs a visible authored affordance or space outside the footprint. I-frames do not make persistent area footprints safe.

Actual positive vitality subtraction also emits `CombatEvent.damage = { targetId, amount, position, worldTick }`. `targetId` always names the exact victim regardless of the event's legacy attacker/target field orientation; `position` is a copied impact point captured before wind push. `amount` is pre-hit minus clamped post-hit vitality, including weak-point amplification, periodic poison and lethal overkill capped at remaining vitality. Misses and zero loss carry no damage payload. This presentation metadata changes no hit geometry, damage, timing, interruption or encounter authority; the application consumes it for floating damage numbers.


## Movement-earned mana and skill readiness

Aren starts with 100 mana, capped at 100. Actual supported Walk/Run displacement with movement input earns 4 mana/metre, including supported recovery movement. Idle time, blocked movement, release deceleration, external pushes, Dive and airborne Jump do not earn mana. Costs are deducted once on accepted activation; an accepted attack that misses still costs mana, while rejected, locked or unfunded actions do not.

| Action | Mana |
| --- | ---: |
| Warden Blade (J, steps 1–3) | 0 |
| Crescent Wave (cast by step 4) | 10 |
| Jump | 8 |
| Heavy | 12 |
| Thunder Cleave (charged Heavy) | 20 |
| Sigil Bolt | 15 |
| Sigil Barrage | 35 |
| Warden’s Judgement | 100 Instinct (no mana) |
| Dive | 25 |
| Root Tether | 20 |
| Cleanse | 30 |
| Ferocity | 30 |
| Corruption | 25 |

Holding Heavy for 36 ticks (`THUNDER_CLEAVE.holdTicks`) selects Charged Heavy and its 20-mana requirement. An unfunded release returns to native Idle without charging mana or silently substituting Heavy. Q selects Root Tether during a valid windup or Cleanse on an exposed corrupted/possessed target. Snapshot readiness uses the same funds, target, recovery, counter, traversal and paused/downed predicates as activation; renderers cannot independently mark a skill usable.

Runtime hydration preserves vitality, Instinct and mana, defaults missing legacy mana/maxMana to 100, and discards obsolete player ferocity/corruption/dodge-charge fields. Boss ferocity and corruption remain separate actor resources. Fresh runs restore full mana; continuing a live encounter preserves its spent mana.

## Aren keyboard movement and animation controls

WASD walks at 4.1 m/s; holding Shift selects `aren-run` at 6 m/s, including while a boss target is active. Directions use the fixed screen-relative camera basis. Diagonal input is normalized, analog magnitude is preserved, accelerating from rest takes up to seven simulation ticks, and releasing movement stops a full-speed run within six ticks. Reported velocity comes from the actual swept displacement, so a wall does not keep the feet cycling at the requested speed.

**F** performs a Dive along the current movement direction, or the last facing direction when stationary. Its 4.8 m trajectory costs 25 mana, eases into and out of the 30-tick active movement, sweeps against obstacles, and does not invent a sideways escape when blocked. Repeated presses during the active movement do not restart or freeze it. Explicit authored evasion-direction commands retain their profile mappings. Non-conflicting custom Dodge bindings remain supported; legacy saves that map Dodge to Space migrate to F.

**Space** performs a collision-checked `aren-jump`: seven anticipation ticks, a 42-tick flight with a 1.25 m apex and ten landing ticks. A standing jump rises in place; held movement carries the arc at walk/run speed up to 4.2 m from the take-off point. Moving anticipation carries up to 0.8 m along supported ground, included in that total rather than added to it. Movement stays live in the air: a changed direction re-plans the remaining arc from the current pose. A second Space press while airborne (or one queued during anticipation) spends another 8 mana once per jump and starts a fresh 42-tick arc from the current height with a 2.1 m apex, reaching up to 6.5 m from the take-off point. Every plan checks support, landing height, headroom and the full capsule trajectory, shortening an unsafe landing or rejecting an obstructed arc. Jump grants no invulnerability. Pause and runtime serialization preserve the in-flight trajectory; contextual vault/climb/slide/swing routes remain separate.

`ActorSnapshot.jumpPhase`/`jumpPhaseProgress` drive the native jump clip in segments: take-off crouch, rising tuck, falling and landing. A boosted second jump (`jumpBoosted`) switches every hero to their in-place `aren-air-step` clip, sampled by phase:
- rising maps to 0–0.50 (two air steps, then the tucked somersault);
- falling maps to 0.50–0.82 (open out);
- landing maps to 0.82–1 (absorb), after which the clip blends into idle or gait.

`ActorVfx` fires two treading-the-wind discs per boosted jump in the hero's style: arcane wind for Aren, Heartroot petals for Yara, with umbral (a shadow step with a crimson crescent) and ember (a fire ring) variants for Vesper and Sakda (see story-effects.md). Landing dust scales with the fall height. Rising/falling frames feed `PoseAfterimages` for every hero.

Held movement resumes swept ground locomotion during Jump and Dive recovery, without a second displacement on the completion tick. Neutral recovery stays stationary. The renderer blends the native finite clip into the speed-matched walk/run gait over its final 30 % with a smoothstep, then promotes that already-visible gait without resetting its phase or dropping all animation weights. The finite action's identity, collision checks and combat windows remain authoritative.

The local Greenwake playtest selects `aren-playtest-animated.glb`, derived from the shoulder-repaired user-supplied Aren skin. Existing Walk, Run, Jump and Dive clips are preserved; actual Idle, Cheer and Defeat come from the supplied `anim.glb`, and Staff (`aren-light-1/2/3`), Heavy, Charged Heavy, Root Tether, Cleanse, hit, stagger and Back Handspring are Tripo preset clips retargeted world-space onto the 65-joint skin and trimmed so each strike frame lands on the simulation's hit window (see full-renderer.md). Hips X/Z travel is consumed while authored Y compression and bob are retained. Loop phase integrates authoritative clock deltas at the current locomotion rate. `AnimationController` owns blend weights: fades are 0.25 s loop↔loop, 0.09 s loop→finite, 0.22 s finite→loop and 0.08 s finite→finite; a fading-out loop keeps advancing from the actor clock instead of freezing, and a missing clip holds the current loop or idle rather than falling to the bind pose. Jump/Dive recovery blends back into Walk/Run from 70 % with a smoothstep, and a vitality drop plays a short presentation-only upper-body hit flinch that never blocks movement. The candidate remains local-playtest-only; canonical production manifests remain unchanged and blocked.

## Simulation and scaled world clock

`CombatSnapshot.worldClock` distinguishes integer `simulationTick` from fractional 60-Hz `worldTick` (`worldTimeSeconds = worldTick / 60`). Perfect Dodge applies a data-driven 0.25 world-time scale for 12 simulation ticks; all unique-hit extensions in one uninterrupted slow-motion episode share an 18-simulation-tick (0.30-second) total elapsed-plus-remaining budget. Pause, reset, region load, and expiry end the episode. It grants 20 Instinct once per attack-instance hit group, opens a 36-simulation-tick counter window, reduces Aren's actual recovery by 12 simulation ticks and the assigned companion's ability cooldown by 18 simulation ticks, and exposes the attacker for 36 world ticks with 1.5× damage.
The actual hit-window/i-frame intersection is evaluated in worldTick; input, counter, recovery, and reward windows remain simulation-tick based.

Enemy hazard/telegraph/AI recovery, stagger and possession, non-player actor animation progress, companion navigation, movable-object animation, and StoryCue lifetimes advance on the scaled world clock. Aren's movement and finite action sampling advance on simulation ticks; GameRenderer samples looping Aren clips from simulationTick and other actor loops from worldTimeSeconds. Input edges, evasion iframes, player hit/counter windows, costs, rewards, and idempotency identities remain simulation-tick based. RAF/camera time is not scaled. CombatEngine.setTimePolicy('paused') freezes both clocks; resume and encounter/region load restore normal policy without rewinding the region clock. Checkpoint reset keeps worldTick monotonic and rebases world-clock deadlines, non-player action timestamps (including non-player invulnerability), and lastAttackTick, while updating attackSelectionWorldOffset to preserve the virtual attack-choice clock across retries; it restores the simulation-clock counter window and player i-frames. Cues from the discarded attempt are cleared. Presentation cues keep their simulation tick/instance identity and receive engine-owned worldTimeSeconds at creation.
Runtime EngineState serialization uses schema version 3. Restoring schema-v1 data without a fractional world clock aligns worldTick to the legacy simulation tick so absolute hazard and actor deadlines remain valid. Legacy queued StoryCue timestamps derive from cue.tick / 60, and in-flight movableObjects.startedAtTick migrates to startedAtWorldTick. Version-2 fractional clock values, attackSelectionWorldOffset, and slow-motion episode elapsed ticks round-trip exactly; older v2 data defaults the offset to zero. Version-2 player action progress migrates to simulation-clock deadlines for both the live state and checkpoint state without changing its sampled normalized progress. This runtime migration does not change campaign IndexedDB saves.

Heavy, Thunder Cleave, Root Tether, Ferocity, Corruption, and Cleanse use the target, reach, facing, and simulation-time rules above; the Warden Blade combo, Sigil Bolt/Barrage and Judgement are area/projectile skills described in “Warden Arsenal”. Cleanse is interruptible and resolves only when Aren stays within range through the active window. Encounter resolution emits stable, idempotency-keyed `WorldEvent`s; restoration is a separate semantic event, not a rendering side effect. Safe checkpoint restoration restores pre-reward state and uses the same deterministic event keys, so campaign processing remains idempotent.

## Warden Arsenal

All timings are simulation ticks from the action's first tick; the data lives in `PlayerSkills.ts` (`LIGHT_STEPS`, `SIGIL`, `THUNDER_CLEAVE`, `JUDGEMENT`, `HIT_STOP_TICKS`). New controls: **L** Sigil (tap = bolt, hold ≥ 30 ticks then release = barrage), **U** Warden’s Judgement; both are remappable `ranged`/`ultimate` actions (default gamepad buttons 12 and 11).

- **Warden Blade (J)** needs no target. Step 1 (26 ticks, active 9–12, 2.3 m, 2.4 rad, 9 dmg), step 2 (28, 10–13, 2.4 m, 2.4 rad, 11), step 3 (34, 10–18, 2.8 m full circle, 13; Aren’s facing makes one full turn across ticks 8–20) and step 4 “Crescent Wave” (40, 15–18, 2.5 m, 14). A swing hits every hostile whose centre is inside the sector at reach + its body radius, once per swing; a locked target within 4.5 m turns the swing onto itself. The next step is accepted from 4 ticks before the clip ends through 18 ticks after it (a press in the last 8 ticks is buffered); otherwise the combo restarts at step 1. Aren is rooted until 6 ticks before the clip ends. Each light hit grants 8 Instinct. Step 4 spends 10 mana on tick 15 to launch a piercing crescent wave (20 m/s, 9 m, 2.8 m wide, 12 dmg, once per hostile, stopped by blocking colliders); without the mana the blade still swings.
- **Sigil Bolt** (15 mana, 30 ticks): Aren is rooted for 22 ticks, a sigil appears at her chest height 0.9 m ahead, and on tick 16 a bolt (28 m/s, radius 0.35, 60 ticks, 14 dmg, +4 Instinct) launches. It homes at up to 6 rad/s on the nearest visible hostile within 22 m inside a 70° cone of her facing (straight when none), ends on its first hostile, blocking collider (including closed trial gates) or its lifetime, and staggers only monsters that are not attacking — never a windup. **Barrage**: holding L roots Aren (she may turn) and shows a sustained sigil; releasing after 30 ticks with 35 mana fires three 12-damage bolts on ticks 8, 16, 24 at −12°, 0°, +12°. Short of 35 mana the release fires a normal bolt if 15 mana is available, otherwise nothing.
- **Thunder Cleave** is the Charged Heavy with unchanged timing and damage plus a lightning strike 8 ticks after its hit tick, at the struck point or 2.5 m ahead: 18 damage to every hostile within 3 m.
- **Warden’s Judgement** (U) needs and consumes 100 Instinct: 10 anticipation ticks, a 12-tick invulnerable dash of 8 m (or to 1.5 m past a locked target within 10 m, through other actors, stopped by solids), then a 30-tick kneel. Five marks are dropped evenly along the dash with alternating ±0.6 rad orientation and detonate one by one at dash end + 24 + 4·i ticks for 12 damage within 2.2 m (plus body radius).
- **Hit-stop**: every confirmed player hit with damage > 0 freezes the world clock and Aren’s simulation-clock timers (action, recovery, chain, charge, buffers, marks) for light 1–2 3 ticks, light 3–4 4, heavy-class 5, Thunder Cleave and its lightning 7, bolts and the wave 2, Judgement detonations 6. Overlapping freezes take the longest remainder. The freeze is serialized (`hitStop`), holds across pause and does not spend the Perfect Dodge slow-motion budget. Inputs during the freeze are buffered; Heavy/Sigil release edges are deferred so a charge can never get stuck. `CombatSnapshot.hitStop` reports `{remainingTicks, strength}` (7 ticks = 1).
- **Monster flinch**: a hostile damaged by the player gets `ActorSnapshot.hitReact` (0→1 over 12 world ticks) unless it is in an attack’s active phase; it never interrupts or retimes the attack. `resolveMonsterAnimation` plays a finite `monster-hurt` sample (`hitReact × 0.35`) when no attack phase is playing.
- **Snapshot and cues**: `CombatSnapshot.playerProjectiles` and `judgementMarks` list live projectiles (world-clock motion) and marks (simulation-tick fuses); StoryCue kinds `slash`, `sigil`, `projectile`, `projectile-impact`, `lightning`, `judgement`, `judgement-mark` carry `element` `arcane` or `lightning`, and player hits use kind `hit` with the contact point and direction. The new state is optional in saved EngineState (no schema bump); older saves load with it absent.

## Boss encounters

Authored boss data covers Koro, Asha (three phases and three configured corruption-core IDs), Ruun, Ghor, Solkar, and Orun (six Heartroot aspects). `CombatSnapshot.boss.corruptionCores` exposes Asha’s per-core cleansed state directly; only successful Cleanse impacts advance one core. Bosses without configured cores omit the array. Attacks retain windup, committed aim, active hit geometry, recovery, English counterplay and interruptibility; committed attacks never retarget. All authored attack presentation uses body-bound charging energy and natural impact effects rather than painted ground areas or borders. Backend geometry remains authoritative, not VFX pixels. Other regions enforce at most two large actors total and two grounded large actors; Greenwake supports three grounded large wildlife actors. Every region still caps at one aerial large actor and six hostiles.

## Greenwake route and pressure

Act I’s Greenwake region follows a continuous entrance-to-exit journey of about 134 m along its authored ribbons and obstacle bypasses. The original ford, sap pools, root ramp, raised rope approach, actors and checkpoints stay in place. Six connected forest-floor sections extend beyond the old gateway to `greenwake-grove-out` at `(72, 0, 38)`; the exit's campaign/restoration gate is unchanged. A low root can be jumped, while the tall cage and tree core require going around. Their side passages remain supported and capsule-walkable. The low-root and cage visuals are calibrated against the loaded native GLB bounds rather than guessed from placement scale alone. Ground movement selects the reachable upper support at overlapping ramps and can step across the matching raised-platform lip without allowing movement through unrelated boxes.

The local trial places three exact wildlife instances—`corrupted-boar`, `greenwake-sap-stalker`, and `greenwake-root-rammer`—that keep the canonical `corrupted-boar` archetype but render their own Tripo models (Ember Boar, Frost Sap-Stalker, Root Rammer) through the trial's `renderVariantId`, with distinct names, element palettes and skill rosters. Only the current stage attacks; cleared stages become neutral. Pressure counts only engaged, scaled world time and advances at 0/15/30/50 seconds: minimum inter-cast spacing is 48/40/33/27 world ticks, windup/recovery scales are 1/0.9/0.78/0.66, and concurrent casts are capped at 2/2/3/3. Windup never falls below 24 ticks; commit retains its eight-tick floor. Already-created attacks keep their captured deadlines.

The active stage cycles only its listed skills rather than selecting from global elapsed time. Its shared elemental footprints and counterplay are:

| Skill | Behavior and counterplay |
| --- | --- |
| Ember Lance | A committed 1.7 × 7 m fire lane; sidestep or Dive clear before ignition. |
| Gale Scythe | A 6 × 1.2 m low wind wave; clear the footprint or Jump, otherwise take a swept 0.9 m push. |
| Frost Bloom | A 3 × 3 m ice patch; leaving avoids damage and a 0.72 movement multiplier lasting 90 world ticks. |
| Venom Mist | A 4 × 4 m cloud lasting 180 world ticks; four damage every 36 ticks while occupied. Leaving stops further damage. |
| Cinder Burst | A low, 1.65 m-radius fire burst; move outside or time a Jump over it. |
| Gale Sweep | A 6.8 × 1.4 m low wind sweep with a swept 1.2 m push. |

At most three casts/strikes, four live hazards and two reserved/live poison clouds overlap. Poison's 12-tick cast and caster recovery are independent of its longer cloud lifetime. Wind displacement obeys the same capsule collision as movement, including native props and temporary combat obstacles; airborne pushes rebase Jump only if its remaining arc and landing stay safe. Ice expiry, pressure cursors, poison deadlines and captured attack timings survive serialization and pause. Reset/load/end clear or restore the appropriate scope.

All attacks emit authoritative anticipation and commit cues; active and real-hit cues retain committed position, footprint, orientation and remaining duration. `phaseStartedAtWorldTick` records the original phase start, while `durationTicks` is the remaining lifetime **from emission**. Presentation resumes serialized flight without replaying launch or moving impact deadlines. Boss snapshot animation progress follows actual windup → commit → cast → recovery deadlines, so the visible strike occurs during the hit window rather than late recovery. This changes no hit geometry or damage authority.

## Local combat trials

`CombatTrials` (`src/game/combat/CombatTrials.ts`) defines ordered, playtest-only stages as **per-region trial sets** (`CombatTrialSet`: region id, authored encounter id, cleared title, trials; `combatTrialSetFor(regionId)`): `greenwake` (`greenwake-boar`), `whispering-canopy` (`canopy-trials`), `the-grove` (`grove-practice`), `moonpine-ridge` (`moonpine-trials`) and `mistveil-basin` (`mistveil-trials`). The engine reads the set of the loaded region everywhere — gates, spawns, arenas, rosters, snapshots, encounter status — so every playtest shares one set of rules. A stage clears when the player defeats its monster (vitality 0):

| Stage | Named monster | Skill roster |
| --- | --- | --- |
| Ember Crossing | Ember Boar | Charge, Ember Lance, Gale Scythe |
| Frost Hollow | Frost Sap-Stalker | Frost Bloom, Venom Mist, Snap |
| Root Watch | Root Rammer | Low Wave, Cinder Burst, Gale Sweep |

Only the current stage monster can be targeted or damaged; later monsters ignore player hits until their predecessor clears. Status reads `approach` beyond 12 m and `fighting` within it, which also locks the target. Clearing a stage turns its monster neutral, cancels its hazards, telegraphs and combat obstacles, opens its gate and advances `combatTrial.index`. Dodging, damage taken, leaving range and pause neither qualify nor reset a stage; Perfect Dodge keeps only its own combat rewards. The stage destination stays sealed until the whole set is cleared.

### Sealed route and gates

Greenwake movement is limited to authored walkable surfaces, and the region-wide `greenwake-canopy-floor` surface is gone: the walk-mesh is one linear route (start basin → root ramp → rope landing → gateway ramp → forest corridor with the Frost Hollow and Root Watch arena pockets → Forest Exit at (70.1, 0, 39.7)). Off-route land is visual terrain only. Each closed gate is one solid `trial-gate:<id>` box at a true chokepoint that spans the whole walkable cross-section plus 1 m of void on each side, rises at least 4.5 m above the highest floor under it and is 1.2 m thick: gate 1 seals the root ramp at z = 11 (the start basin's only exit), gate 2 crosses corridor 3 at z = 34, gate 3 crosses corridor 5 at x = 57 ahead of the exit. Neither a single nor a boosted Jump crosses a closed gate. `tests/combat/greenwake-sealed-route.test.ts` proves it on the playtest data path: a 0.5 m flood fill with the real `moveCircle` splits the walk-mesh into exactly a before and an after component per closed gate, and more than 1000 real-engine Run, Dive-chain, Jump-chain (Space held, so every funded jump boosts) and mixed runs in 16 directions never cross a closed gate while the same inputs cross once it opens.

Trial arenas: Ember Crossing uses the start basin (centre (8, 0, −3), radius 8); Frost Hollow (39, 0, 24) and Root Watch (46.5, 0, 46) are octagonal pockets with inradius 8.5. Defeating the stage monster starts the gate's 1.2 s opening (seal flash and dissolve, the root wall sinks 3 m) and removes its collider in the same authoritative snapshot. Within 1.5 m of a closed gate the HUD reads "Sealed by <monster> — defeat the monster to open the gate". Opening trials emits no campaign reward, encounter-resolution or restoration event. Checkpoint/reset/load preserve or clear the correct local state.

The local region variant (`createGreenwakeTrialRegion`, reached through `createCombatTrialRegion`) appends deterministic boundary dressing (`src/world/GreenwakeBoundary.ts`: bramble walls and boulder clusters on the inner ring, edge trees on the outer ring, low props only on camera-facing edges) so the sealed edge reads as forest rather than an invisible wall, culls authored trees that would overhang the walk-mesh, and renders the three trial monsters with their own Tripo assets (`actor-ember-boar`, `actor-frost-sap-stalker`, `actor-root-rammer`). Boundary placements are decoration (no simulation colliders). Canonical production recipes and asset gates are unchanged.

### Trial monster behaviour

Trial monsters are deterministic simulation actors. The current monster engages at ≤ 14 m (drops out beyond 16 m), keeps a range band (Ember Boar 5–8 m, Frost Sap-Stalker 4–7 m circling/flanking, Root Rammer 6–9 m slow and heavy), circles, advances and retreats with a limited yaw rate, and never leaves its arena circle or the walk-mesh. It stands still through windup/commit/active except authored lunges: the Charge lane starts at the boar and the boar actually runs it (≈ 16 m/s, stopped by colliders, emitting a `landing` cue); Low Wave and Gale Sweep lunge up to 1.5/1.2 m. Monsters roar (`roar-cone`, 42-tick pause, no damage) when a stage engages and on each pressure-tier escalation. From tier 1 a second attack chains off the first's active window. Windup/commit floors (24/8 ticks), the 14 m casting limit, concurrency caps and trial counting are unchanged.

`resolveMonsterAnimation` (`src/rendering/MonsterAnimationProfiles.ts`) maps each snapshot to one of ten clip slots (`monster-idle/walk/run/slash/shoot/jump/hurt/turn/dive/roar`) with per-attack, per-phase clip windows so each skill has its own body animation (e.g. Ember Lance = shoot, Gale Scythe = slash, Charge = run then dive lunge, Frost Bloom = jump, Low Wave = jump slam, Gale Sweep = turn spin into slash). Tripo's quadruped rig only offers a walk preset, so the other nine clips are authored offline on the same skeleton by `scripts/assets/author-quadruped-clips.mjs` (body-frame poses, planar FABRIK foot pinning, walk-derived run) and verified by `tests/rendering/quadruped-clips.test.mjs`.

Pre-Sprint-1 native-scene proof (before the sealed route and Tripo monsters) used the real 166 source-measured prop solids, AI, hazards, support/collision and damage rules. Controlled starting poses between rooms and accelerated fixed steps completed the 20/25/30-second trials with 9/13/18 avoided casts, 100 vitality, matching visual/physical openings, zero WorldEvents and unchanged campaign JSON. This is not a claim of hand-playing the entire route continuously. Trusted keyboard movement then reached the real final exit and triggered donated Cheer/Stage Complete. Separate trusted input measured a 4.8 m Dive costing 25 mana, exhausted mana to zero, and restored readiness by running. Actual closed-gate Run, Dive, Jump and real Gale Scythe push stayed on the blocked side. Replay restored full vitality/mana and all three closed gates; actual pause froze clocks, position, resources and skill availability.

### Trial difficulty ramp

Only local trial playtests are ramped; canonical encounters, `getWildlifePressure` and its tier tables are untouched. `src/game/combat/TrialDifficulty.ts` is pure data: `trialDifficulty(regionId, stageIndex, stageCount)` and `trialRamp(regionId, stageCount)`. Maps rank `greenwake` 0, `whispering-canopy` 1, `moonpine-ridge` 2, `mistveil-basin` 3; each has three stages. For stage index *s*:

- `level = rank × 3 + s` (0–11); `boss` = the final stage of the map.
- `vitality = round(100 × (1 + 0.15 × level) × (boss ? 2.2 : 1))`.
- `damageScale = (1 + 0.05 × level) × (boss ? 1.35 : 1)`.
- `aggression = 1 + 0.03 × level + (boss ? 0.10 : 0)`.
- `speedScale = 1 + 0.02 × level + (boss ? 0.08 : 0)`.

|Map|Stage 1|Stage 2|Stage 3 (boss)|
|---|---:|---:|---:|
|Greenwake|100|115|286|
|Whispering Canopy|145|160|385|
|Moonpine Ridge|190|205|484|
|Mistveil Basin|235|250|583|

The Grove practice (`the-grove`, one stage) is exempt: level 0, not a boss, every scale 1, vitality 100. Application points: HP is seeded in `enableCombatTrials` and captured by the checkpoint, so retry restores it. The scale is stamped on each hazard when it is cast (`hazard.damageScale`; `hazard.damage` stays the authored value) and applied at hit time as `Math.round(hazard.damage × damageScale)`, including poison pulses and before any kit shield. Aggression divides the pressure tier's cast cadence and reposition ticks and, through `scaleTrialAttack`, windup and recovery after the tier scaling (windup floor 24 and commit floor 8 are kept). `speedScale` multiplies a trial monster's advance, circle and retreat speeds, on top of any `cripple`. `EncounterStatusSnapshot.trial` carries `boss` and `level`, and each `monsters[]` entry carries `boss`; the UI shows the Boss chip and a larger HP bar (reference-ui.md). `tests/combat/trial-difficulty.test.ts` covers the ramp.

## Whispering Canopy playtest

`?assetPlaytest=canopy` (DEV only) is a second playable map. `createCanopyTrialRegion(authored)` (`src/game/combat/CanopyTrialRegion.ts`, reached through `createCombatTrialRegion`) returns a variant of the authored `whispering-canopy` region; the canonical `act-i.ts` data is untouched. Ground, navigation, cameras, exit, entities and props are replaced; the region id, name and environment recipe are kept. Simulation owns walkability: the walk-mesh is one linear route of nine surfaces (heights in metres), each with a support collider (thin box flush with flat tops, non-blocking centre-line segment under ramps):

|Surface|Floor|Material|
|---|---|---|
|`canopy-trial-basin` (start, Arena 1)|y 0|`canopy-trail-earth`|
|`canopy-trial-root-stair`|ramp y 0→4 along +x|`canopy-trail-earth`|
|`canopy-trial-fig-ledge`|y 4|`canopy-trail-earth`|
|`canopy-trial-gorge-bridge`|y 4, 3 m wide|`canopy-bridge-deck`|
|`canopy-trial-roost` (Arena 2)|y 4|`canopy-trail-earth`|
|`canopy-trial-chasm-bridge`|y 4, 3 m wide|`canopy-bridge-deck`|
|`canopy-trial-temple-descent`|ramp y 4→0 along +x|`canopy-trail-earth`|
|`canopy-trial-courtyard` (Arena 3, octagon)|y 0|`canopy-trail-earth`|
|`canopy-trial-exit-path`|y 0|`canopy-trail-earth`|

Aren starts at (−58, 0, −20) (first navigation node); Vara (`canopy-vara`) stands at (−60, 0, −19); the exit route `canopy-trial-exit` starts at (47, 0, 7) and carries the stage goal ring. Props are two vine bridges (`canopy-trial-bridge-a/b`, `prop-vine-bridge`, rotationY π/2, scaled along local z from a 12 m model to the 11.2 m / 11.6 m spans), the shrine at (47, 0, −38) and six giant trees outside the walk-mesh. Boundary dressing (cliff rocks, ferns, more trees; decoration only) is composed in one place, `canopyBoundaryPlacements` in `CanopyTrialRegion.ts`, which becomes `buildCanopyBoundaryPlacements(region, { gates, arenas, obstacles })` from `src/world/CanopyBoundary.ts`.

|Trial|Monster (actor / asset)|Spawn|Arena|Gate (x, z)|Roster|
|---|---|---|---|---|---|
|Howler's Pool|`canopy-howler` / `actor-thornback-howler`|(−46, 0, −26)|(−49, 0, −28) r 8|(−33.5, −28) on the root stair, spans z|rock hurl, leap slam, branch sweep|
|Hornbill Roost|`canopy-hornbill` / `actor-storm-hornbill`|(7, 4, −24)|(5, 4, −26) r 8|(14.6, −23.5) on the chasm bridge, spans z|dive bomb, feather volley, gale flap|
|Viper Temple|`canopy-mire-viper` / `actor-mire-viper`|(49, 0, −20)|(47, 0, −22) r 8|(47, −9) on the exit path, spans x|venom spit, tail lash, strike lunge|

The monsters are proper archetypes (`ACTORS`: `howler-monkey`, `storm-hornbill`, `viper` species; the hornbill is a ground simulation body that presentation draws hovering). Profiles: Howler radius 0.75, band 4–7 m, advance 4.8, circle 4.0, retreat 4.2 m/s, yaw 5.0 rad/s (flanker, erratic); Hornbill 0.9, 6–10 m, 5.2/4.4/4.8, 4.0 (ranged, wide circles); Viper 1.0, 3.5–6 m, 2.6/1.9/2.2, 2.4 (controller, slow). Engagement, pressure tiers, roar on engage and escalation, serialization and turning neutral on defeat are identical to Greenwake.

|Attack|Hazard (kind, size, height, damage)|Windup / commit / active / recovery|Movement and extras|
|---|---|---|---|
|`howler-rock-hurl`|strike 1.5 × 1.5, r 1.4, 0.2, 12|48 / 12 / 10 / 40|lobbed at where Aren stood|
|`howler-leap-slam`|strike 2.2 × 2.2, r 2.0, 0.2, 15|54 / 12 / 9 / 48|step lunge 5 m during commit|
|`howler-branch-sweep`|wave 6 × 1.3, 0.18, 11|48 / 12 / 12 / 44||
|`hornbill-dive-bomb`|sweep 2 × 9 from the caster, 1.1, 15 (wind)|60 / 15 / 20 / 48|charge along the whole lane|
|`hornbill-feather-volley`|cone 6 × 7, 1.2, 10 (wind)|54 / 12 / 10 / 44||
|`hornbill-gale-flap`|wave 7 × 1.6, 0.2, 9 (wind)|54 / 15 / 14 / 48|1.2 m push on hit|
|`viper-venom-spit`|area 3.6 × 3.6, 1.2, 4 per pulse (poison)|48 / 12 / 180 / 54|pulses every 36 ticks, lingers 180 ticks, 12-tick cast|
|`viper-tail-lash`|wave 6.5 × 1.4, 0.18, 12|54 / 15 / 14 / 48||
|`viper-strike-lunge`|sweep 1.4 × 6 from the caster, 0.8, 16|36 / 12 / 8 / 48|step lunge 3.5 m|

Non-elemental canopy attacks use the generic attack-keyed `anticipation`/`commit`/`active`/`hit` cues (no Greenwake impact-cue kinds); elemental ones carry `element`. `tests/combat/canopy-sealed-route.test.ts` proves with the shared brute-force harness (`sealed-route-harness.ts`) that the three gates split the walk-mesh and hold against Run, Dive chains, Jump chains and their mixes from the box faces, ends and region edges in 16 directions, and that opened gates pass; `canopy-trials.test.ts` covers the contract table, attack geometry/lunges/push/pool timing, roster cycling, arena containment and trial progression with the real engine.

## Native solids and temporary combat obstacles

Loaded hard native props contribute source-measured solids to the engine arena alongside authored surfaces and movable-object colliders. Grounded Walk/Run/Dive, aerial Jump and wind pushes use this same arena. Trees preserve under-canopy space, bridge decks retain authored support and measured rails, compound meshes remain separate, and arches use triangle-clipped height bands to preserve real openings. Two corridor edge trees were moved away from the walking centerline; their visible models and colliders move together.

Committed frost creates solid ice; root/sap/charge-family attacks create solid roots. These appear only at the active transition, never during warning. Their snapshot-owned capsules have a 0.42 m radius and 1.4 m total height; ice lasts 240 world ticks, roots 180, with at most eight obstacles. Placement checks actual support, actors, route endpoints, existing solids and an escape clearance before adding either flank. Pause freezes lifetime; serialization preserves it. Expiry, source interruption, phase replacement, encounter completion, player defeat and checkpoint reset remove the corresponding obstacles without losing native map colliders. Visuals consume these snapshots and grant no physics authority.

## Companions

Vara, Koro, Asha, Sable, Nyra, and Solkar have authored utility/ability identities. Follow, Stay, Focus, Defend, Search, Distract, Special, Recall, Ask, and Signal change companion state; commands require a present, visible, available companion and respect two shared support tokens, cooldowns, navigation requirements, and the active slots. Navigation follows the region graph where possible and exposes a path-fallback flag rather than teleporting or bypassing a gate. After Chapter 6, Ask/Signal remains available for willing companions; there is no implicit return of an absent or exiled ally. Animal combat is nonlethal.

## Renderer integration and assets

`COMBAT_ACTION_CLIPS` is the complete semantic action-to-clip contract. Every currently unauthored final clip remains `pending` in `pendingAssets`; these IDs are not claims that a production rig or animation has been verified. Movement greybox behavior is simulation-only and must not be presented as a final character asset.

## Hunter encounter and authored outcomes

`camp-hunters` is a three-hostile encounter with distinct RegionEntity instances: `hunter-melee-west` and `hunter-melee-east` use the canonical `poacher-hunter` melee archetype; `hunter-ranged` uses the canonical `poacher-scout` ranged archetype. The two melee actors have independent spear attack instances, while the ranged scout uses a net telegraph. Subdual is nonlethal and emits the idempotent encounter result only after all three instance actors are downed; `encounter-resolved.actorIds` preserves the exact instance IDs.

Actor snapshots use `id` for the exact placed runtime instance and `archetypeId` for its shared authored actor definition. Region loading resolves placements by `RegionEntity.id`; campaign-facing instance results are never collapsed back to archetype IDs.

`resolveInteraction` validates the authored interaction, region, range, required actors/facts, and any authored mechanic action. Semantic signal outcomes attribute the event to the first present required actor and preserve the authored success target; they do not invoke a separate companion-command path. The Tali rescue requires `taliInBamboo`, the successful staff-heavy `camp-disable` interaction, all hostile hunters to be nonhostile or downed, and no active threat near Tali; the derived `taliSafe` fact is not a precondition. River-source restoration resolves from a successful authored Cleanse-pulse impact or its authoritative solved fact. Successful rescue/restoration events use deterministic interaction idempotency keys, so repeating the same interaction does not apply a second outcome.

## Authored movable objects

`camp-loose-snare` is a CombatEngine-owned object instance with fixed-step `resting`, `in-flight`, and `settled` samples in `CombatSnapshot.movableObjects`. Koro starts it through the utility `special` command against the exact resting object ID. When Koro occupies neither the combat nor utility party slot, Aren’s fallback requires the exact object target plus an actual Heavy/Charged Heavy hit-window whose staff range and current facing sector intersect the object’s authored radius. The action does not auto-face; direct interaction calls, missed, out-of-range, or wrong-facing impacts do not start movement.

The object sweeps its authored source-to-destination path on its support surface over 24 ticks. A collision or occupied path returns it to its authored source without a world event. A successful landing emits one stable `object-moved` WorldEvent; it does not deal damage, subdue hunters, complete a quest, or change a route/collider. Only a living `hunter-ranged` instance with a windup telegraph still open and within the authored effect radius is interrupted; that exact actor receives a 24-tick stagger/counter window.

Region loading places the object at its source unless the persisted `movedFactId` is true, in which case it loads settled at the authored destination. Campaign persistence owns the fact; presentation never advances movement or invents a second event.

## Contextual traversal (M04)

Only local arcs carrying explicit `RegionRouteDefinition.traversal` metadata are E affordances. Four local routes carry authored start, intermediate foot-pose anchors, supported landing, native action ID and world-tick duration:

| Route | Type / action ID | Duration |
| --- | --- | --- |
| `canopy-vine-bridge-arc` | Vault / `aren-staff-vault` | 240 ticks |
| `canopy-bridge-bough-ledge-arc` | Low ledge / `aren-low-ledge` | 72 ticks |
| `grove-oath-terrace-arc` | Slide / `aren-low-slide` | 54 ticks |
| `canopy-upper-bough-arc` | Swing / `aren-swing` | 90 ticks |

The engine owns one transient traversal and moves continuously from the current supported pose through the authored start and every anchor. It validates the approach, full-height start/landing capsule, route gate and complete swept path before starting; every fixed-step segment is checked again against the current capsule solver. Vault clears the authored canopy log; Slide uses a 0.65-meter capsule under the Grove overhead obstacle and must stand safely at its landing. Existing walkable surfaces are unchanged. The independent Space Jump follows its own collision-checked arc; it never bypasses route gates or creates a contextual traversal affordance. Untyped ordinary arcs remain ordinary world paths, not fabricated animation affordances.

The ledge is a bounded side climb from the existing Canopy bridge at (11.4,5,19) to the upper bough platform at (12.6,7,19), outside the bough-ramp approach. Its actual `canopy-upper-bough-collider` supplies the face/top: source-derived rise 2 meters, horizontal crossing 1.2 meters, authored crossing limit 1.5 meters and foot-pose clearance only 0.1 meter above the supported top. The engine validates rise, face/top, crossing bound and anchor height; ordinary grounded movement cannot reach that upper-floor pose. The Grove oath ramp remains its original walkable route, not a floating climb shortcut. These dimensions are this source geometry's contract, not a newly invented globally approved ledge-height standard; native hand/contact visual qualification remains blocked.

During traversal, movement, Dodge, attacks, ability actions and world interactions cannot move or replace Aren's path. ActorSnapshot exposes the exact authored action ID and authoritative normalizedTime from scaled world ticks, consumed by the existing GameRenderer animation controller. Pause freezes both pose and timing. Incoming damage, down/death, possession, gate loss or newly blocked geometry abort without success; rollback uses the last full-height supported pose and clears pending combat state. Reset also clears in-flight state, retaining that safe pose even when restoring an encounter checkpoint. Region replacement discards the old traversal and loads the requested authored supported spawn.

Runtime schema 2 retains the optional transient traversal only to record its safe rollback pose. Constructor/restore intentionally discard an in-flight path to that pose and clear its pending action, rather than resuming an airborne save; completed poses remain unchanged. Campaign IndexedDB format is untouched. Successful landing emits one transient CombatEvent with the exact local route ID. It emits no cross-region WorldEvent, campaign fact, quest reward, or region change. CampaignDirector.travel remains the only cross-region travel/loading authority.

Scoped traversal proof covers success, gated/wrong-height/remote starts, blocked landing/ceiling, mid-flight obstruction, damage/death, pause, restore, reset and region load. Actual-engine smoke completed all four authored routes at supported endpoints with one local completion and zero WorldEvents each. This does not qualify native traversal/contact assets: canonical producer/runtime Aren manifests remain blocked, with unavailable Vault/Slide/Low Ledge/Swing bindings. The separate Greenwake candidate has the real 65-joint skin, preserved movement clips and donated Idle/Cheer/Defeat. Its local native pose and browser evidence is documented in full-renderer.md and application.md; production rig/contact acceptance remains separate.

### R08 producer dependency

Attack anticipation/commit/active/hit cues share the actual collision predicate's geometry: target-centered radius-only disks for strike/projectile, target-centered oriented rectangles for sweep/wave, an axis-aligned area rectangle, and an origin-centered cone sector. Bounds metadata no longer centers lanes at their midpoint or pads them with unrelated radius. Anticipation lasts authored windup; commit/active/hit carry remaining authoritative world-tick deadlines. The engine emits one explicit active cue at the actual active interval even when the attack misses; it never fabricates a damage hit to preserve the warning. StoryCue carries exact fractional worldTick alongside worldTimeSeconds, allowing the R08 consumer to age durationTicks without floating-seconds boundary drift. Legacy hydration preserves existing exact ticks or derives missing cue starts from the old seconds/legacy tick domain.

Public restore discards queued stale effects and emits load cancellation. If an alive restored simulation is still inside a real hazard's active interval, its next fixed step emits a fresh active warning for only the remaining interval; prior hit IDs and damage remain intact, so no damage hit is replayed. Terminal restored states clear hazards before any such warning.

Terminal player down/death ends combat authority, not just presentation: future pending impacts, buffered actions, held Heavy charge, counters and live hazards/telegraphs are cleared. Player actions and enemy AI, including companion-targeted possession, are rejected while down; companion/object/phase progression stops. A genuine impact resolved before lethal damage remains recorded; no postmortem impact or encounter reward is produced. The genuine lethal hit is emitted before the global death cancellation, which is last in that fixed step. Scoped interruption and reset/restore cancellation use the existing stream. Producer and consumer regressions cover missed active windows and 100 subsequent dead-player ticks; native/browser acceptance is separate. This producer depends on R08's actual active/cancellation/clock contract and consumer; no effects/audio ownership moved to the engine.

## Playable heroes, profiles and the kit seam

Local map entry chooses one of four heroes — Aren, Yara, Vesper or Sakda — without changing the `aren` player actor identity. `CombatEngine.setPlayerHero` is allowed before an encounter; encounter changes are rejected and checkpoint retry retains the hero. WASD and arrow keys share normalized camera-relative movement, including remapped keyboard controls.

### Hero profiles

`HERO_COMBAT` in `src/game/combat/HeroProfiles.ts` is the authoritative per-hero profile; `DEFAULT_COMBAT_PROFILE` (Aren's `PLAYER_*` values) applies until a hero is chosen, and `PLAYER_MAX_VITALITY`/`PLAYER_WALK_SPEED`/`PLAYER_RUN_SPEED` remain Aren's defaults.

|Hero (`HeroId`)|Class|Element|Max vitality|Walk / run (m/s)|Visual style|
|---|---|---|---:|---|---|
|`aren`|Close-range striker|`arcane` (+ `lightning`)|120|4.1 / 6.0|`warden`|
|`yara`|Ranged spellcaster|`heartroot`|85|4.1 / 6.0|`heartroot`|
|`vesper`|Samurai assassin|`umbral`|80|4.9 / 7.5|`umbral`|
|`sakda`|Muay Thai brawler|`ember`|115|4.4 / 6.6|`ember`|

`setPlayerHero` writes the hero's vitality and maxVitality to the player resources and the `aren` actor, and re-captures the encounter checkpoint, so new runs and retries keep the hero's pool. Choosing a different pool starts it full; choosing the same hero again keeps the current health. Grounded motion and the take-off carry of Jump read the hero's walk and run speeds (a kit may also scale them through `moveSpeedScale`). Mana costs, hold thresholds (`THUNDER_CLEAVE.holdTicks` 36 for K, the Sigil barrage hold for L), Instinct (100 for U) and the seven HUD slots (`dive, jump, light, heavy|charged_heavy, sigil_bolt|sigil_barrage, root_tether|cleanse, judgement`) are shared; each hero re-labels and re-routes the slots (`HEARTROOT_LABELS`, `VESPER_LABELS`, `SAKDA_LABELS`). The HUD dodge label is `HeroDefinition.dodgeLabel`: DIVE, PETAL STEP, MIST BLINK, GUARD DASH.

### Kit seam (`src/game/combat/kits/`)

`CombatEngine` keeps the Aren and Yara code paths. Vesper and Sakda run through a `HeroKit` created by `createKit(heroId, host)` from `KIT_FACTORIES` in `registry.ts` (`vesper: createVesperKit`, `sakda: createSakdaKit`); a hero without a factory plays Aren's kit. The engine implements `KitHost`, and a kit changes the world only through it.

- **Routed inputs** (the engine has already checked downed/paused/traversal/recovery): J (`startLight(step, chain, counter)`), K tap/hold (`startHeavy(charged)`), L tap/hold (`startRanged(charged)`), Q after the engine's target and windup validation and mana spend (`startTether(target)`; a refusing kit refunds the mana), U (`startUltimate()`; Instinct is emptied only when it returns true) and F. F keeps the engine's Dive rules, Perfect Dodge and 25 mana; `HeroKit.dodge` replaces distance, duration, i-frames and recovery, and `onDodge` runs after Perfect Dodge evaluation. The player actor keeps the shared evasion-profile action id (`aren-…-dive-roll`, aliased by the hero manifest to its dash clip); the hero clip is only the `actionId` of the `blink` cue, which `blinkCue` emits for every accepted kit dodge.
- **Host capabilities:** tick/worldTick, player and resources, soft target and hostile queries, collision-safe `moveCircle`/path/support/wall checks plus aerial `moveAerial`/`isAerialPathClear`, `beginAction` (clip, total, input lock, cancelable window, light-chain bookkeeping and an optional `cancel {fromTick, into}` window that routes the listed inputs — light, heavy, ranged, dodge, tether, ultimate — to the kit during recovery), position/facing/velocity, `setUntargetableUntil`, `spendMana`/`restoreMana`, `strikeHostile`/`strikeDisk`/`strikeLane`/`strikeCone` through the engine's full hit path (cones, disks and lanes all skip targets behind walls or closed gates), `canStrike(target, from, reach)` (visible, alive, within reach + radius, wall-free to the chest; every targeted kit impact must pass it from the player's actual position), `spawnProjectile` (kinds `kunai`, `echo-wave`, `shade-clone`, optional homing, `callbackId`, pierce), `displaceMonster`, `crippleMonster`, `staggerMonster`, `interruptMonster`, cues, events and hit-stop. Interrupt-capable hits must use the action `heavy`, `charged_heavy` or `root_tether`.
- **Hooks:** per-tick `update` (never during hit-stop; `onHitStop` shifts stored absolute ticks), `modifyStrike`/`afterStrike` (on-hit passives), `absorbDamage` (applied to hazard damage before vitality), `isUntargetable`, `moveSpeedScale`, `playerExtras`, `heroMarks`, `onProjectileHit`/`onProjectileEnd`, `onSharedSkill` (shared Jump, Cleanse and Dodge accepted for a kit hero), `cancel` (Dodge, death, checkpoint reset; marks and passives survive) and `reset`. While `isUntargetable()` is true monsters do not acquire the player for new attacks (committed hazards stay, companion-targeted attacks are unaffected). `kitState` does not allocate per access.
- **Persistence:** kit state is the plain JSON object `EngineState.kit` (`host.kitState(create)`); it serializes with the engine and is emptied on region load, checkpoint reset and death.
- **Snapshot additions:** `PlayerProjectileSnapshot.kind` includes `kunai`, `echo-wave`, `shade-clone`; `ActorSnapshot.heroMarks` lists `death-stack`, `death-mark`, `echo-mark`, `requiem-mark` and the engine's own `cripple`; `CombatSnapshot.player` gains optional `shield`, `flurryCharges` and `untargetable`.
- **Cues:** new kits emit only existing kinds (`slash`, `hit`, `blink`, `beam`, `projectile`, `projectile-impact`, `sigil`, `judgement`, `judgement-mark`, `tether`) with `actorId` `aren`, `element` `umbral`/`ember` and `actionId` the skill clip; VFX resolves visuals by element, action and kind (see story-effects.md).

`tests/combat/hero-kit-seam.test.ts` registers a small test kit to exercise dispatch, shield, untargetable, the damage modifier, snapshot extras and the serialization round trip.

### Yara — Heartroot kit

Yara has 85 vitality and a raised damage table (about +30 %, timings unchanged): thorn 16, twin 12, Bloom Burst seed 32, Root Spike 37, Heartroot Eruption 55, Sap Lance 40, Seed Storm 13 per seed, Bloom meteor 13, Bloom final pulse 58 (`HEARTROOT` in `HeartrootSkills.ts`).

Yara reuses the arsenal's fixed-step clocks, mana, cancellation, target selection and swept collisions:

|Input|Heartroot behavior|
|---|---|
|J|Three-hit chain: homing thorn, twin thorns, Bloom Burst seed with a 2.4 m impact/expiry burst; no Aren melee strike or fourth slash.|
|K tap / hold|9 m Root Spike lane / targeted 3 m-radius Heartroot Eruption, with wall-aware hit checks.|
|L tap / hold|14 m piercing Sap Lance / six homing Seed Storm projectiles for one charge cost.|
|Q|Binding Vines interrupts an eligible winding-up foe; Cleanse uses the existing exposed-corruption rules.|
|F|Petal Step retains Dive's swept trajectory, mana and invulnerability window; native body briefly disappears within its petal trail.|
|Space|Shared jump physics with Yara's native jump clip.|
|U at 100 Instinct|Stationary, damage-invulnerable 156-tick Heartroot Bloom: 8 m sigil, nine meteor bursts, final pulse. Never cleanses or awards campaign progress.|

Pause freezes casts; dodge interrupts held seeds without a delayed release. Death, retry and world retirement use existing arsenal/presentation cancellation. `HeartrootCues` owns pooled roots (segmented, twisting, knotted bark cones with a restrained amber sap-light rim, replacing the shared glassy crystal cone that read as green ice), amber sigils, sap beams and pink/ivory petals; `HeartrootSounds` uses bounded procedural audio voices. Simulation projectiles and actual hit resolution remain authoritative. The HUD tints Yara's ready Heartroot Bloom card amber instead of Judgement's storm teal.

`tests/combat/heartroot-skills.test.ts` covers ranged hits, combo boundaries, piercing/occlusion, six-seed cost and cancellation, lane/disk separation, full-cast invulnerability, area limits, no cleansing and pause. Live candidate smoke exercised the native Yara model/staff, charged eruption, Sap Lance, six seeds, Bloom, Petal Step, real Howler windup interruption and exposed-target Cleanse (corruption 60→20), with no missing animation bindings.

## Vesper — Moonshade Blade kit (`umbral`)

Vesper is a samurai assassin: 80 vitality, walk 4.9 / run 7.5 m/s. Every number below is read from `VesperSkills.ts` and `kits/VesperKit.ts`; ticks are simulation ticks at 60 Hz counted from the skill's first tick. Mana costs, hold thresholds (K ≥ 36 ticks, L ≥ 30) and the 100-Instinct ultimate are the shared ones from `PlayerSkills`. Labels and clips come from `VESPER_LABELS`/`VESPER_CLIPS`; cue `actorId` stays `aren`, `element` is `umbral` and `actionId` is the skill's clip.

|Input|Skill (clip ids)|Behavior|
|---|---|---|
|J|Moonlit Iai (`vesper-iai-1..4`), free|Four steps of 18/18/22/30 ticks, cut at 6/6/8/10, 12/12/15/22 damage, reach 2.6/2.6/2.8/2.8 m in a 140° cone (assist target within the light assist range, all around). Aren's chain window applies: next J from 4 ticks before the clip ends through 18 after. Steps 1–3 root Vesper until one tick after the cut. Step 4 “Crescent Rift” dashes 4.5 m (ticks 6–14, smoothstep, collision-safe, untargetable through the dash) and strikes a 2 m-wide lane along the dash path at tick 10. Hit-stop 3 (Rift 5); Instinct 8 (Rift 12); every step interrupts a winding-up foe.|
|K tap|Shadow Step (`vesper-shadow-step`), 12 mana|Total 26, rooted through tick 8. Soft target within 9 m; at tick 4 Vesper blinks to a standable, path-clear spot directly behind it (alternating sides, then the front, when walled off; the farthest standable point on the line when none exists), or 6 m forward with no target. Tick 8 strikes for 26 (2.8 m, 140° cone, or the target directly when within 2.8 m + radius). Hit-stop 4, Instinct 10, interrupt.|
|K hold → release|Thousand Cuts (`vesper-cuts-charge` loop, `vesper-thousand-cuts`), 20 mana|Total 72, untargetable the whole clip. Strikes at 8/18/28/38/48/58 for 9 each (no stagger, no hit-stop, Instinct 3) and a finisher at 66 for 20 (interrupt, hit-stop 5, Instinct 10). Each strike blinks to a landing spot around the next hostile within 8 m (targets taken in turn, landing angle advancing by the golden angle); with no hostile in range nothing happens that tick.|
|L tap|Kunai Fan (`vesper-kunai-fan`), 15 mana|Total 24, release at 9: three `kunai` projectiles at −12°/0°/+12° from 0.5 m ahead at 1.1 m height, 22 m/s, 16 m range, radius 0.15, 9 damage each (no stagger, hit-stop 1, Instinct 3); aimed at the soft target within 16 m. Every kunai hit counts toward Death Mark.|
|L hold → release|Shade Swap (`vesper-shade-charge` loop, `vesper-shade-swap`), 35 mana|Total 40. At tick 8 a `shade-clone` lane projectile (24 m/s, 1.4 m wide, pierces) flies up to 8 m toward the soft target within 12 m (or the facing), shortened to the farthest standable, wall-free point; each hostile it sweeps takes 24 (idle-only stagger, hit-stop 3, Instinct 8). At tick 30 Vesper blinks to the clone's end point and is untargetable for 12 ticks.|
|Q|Severing Shadow (`vesper-severing-shadow`) / Cleanse (`vesper-cleanse`)|Severing Shadow needs a winding-up foe and 20 mana, and **refuses beyond 7 m with the mana refunded** (it does not dash further). Total 36: blink behind the foe at tick 4, strike at 12 for 10 with interrupt (hit-stop 5, Instinct 12). Cleanse keeps Aren's flow (lock 90, active 35) with Vesper's clip.|
|F|Mist Blink (`vesper-mist-blink`), 25 mana|The engine's dodge with Vesper's numbers: 6.5 m over 12 ticks, 14 untouchable ticks (also applied as untargetable, not only against authored hazards), 12 recovery ticks. The player keeps the shared dive action id (the manifest aliases it to `vesper-mist-blink`), which keeps the renderer's body-vanish, afterimages and dodge VFX recognition working; the hero clip id is the `actionId` of the `umbral` `blink` cue emitted for every accepted Mist Blink, from start to the predicted end. Perfect Dodge rules are unchanged. The swept travel stops at walls, so the blink may be shorter than 6.5 m near them.|
|U|Crimson Requiem (`vesper-requiem`)|100 Instinct, total 120, untargetable throughout. At tick 6 every hostile within 12 m gets a `requiem-mark` (108 ticks); seven blink-slashes at 12, 24 … 72 hit the marked foes in turn for 8 each (hit-stop 1, Instinct 2); at tick 110 every still-alive marked foe takes 45 (hit-stop 6). Casting with no hostile in range still spends the Instinct.|

**Passives.** *Death Mark:* each Vesper hit adds a stack to the target (stacks last 180 ticks); the third live stack becomes a `death-mark` for 240 ticks. The next hit on a marked target consumes it for +25 damage (“Shadow Execution”) and hit-stop of at least 6. A defeated target forgets its stacks and marks. *Backstab:* a hit from behind (dot(target facing, target→Vesper) < −0.3) deals ×1.5, rounded. Both are applied through the kit's `modifyStrike`/`afterStrike`, so every Vesper hit — kunai, clone, Requiem slashes — counts. Stack and mark timers tick down once per live simulation tick.

**Cancels.** Every Moonlit Iai step opens a cancel window one tick after its active frame (after the dash for Rift) into K and F, so Shadow Step or Mist Blink can follow immediately; Shadow Step and Kunai Fan cancel into J, K and F after their strike or release tick. Starting the next skill abandons the first cleanly. Thousand Cuts and Requiem are locked and untargetable for their whole length. Dodging mid-skill clears their untargetable window and Requiem marks.

**Impact checks.** Shadow Step, Severing Shadow, Thousand Cuts strikes, Requiem slashes and the Crescent Rift lane must pass `host.canStrike` from Vesper's actual post-blink position before damage, stacks, marks or interrupts; a blink that cannot reach a standable spot near the target does not hit through walls.

**Snapshot.** `heroMarks` shows `death-stack` (with `stacks`), `death-mark` and `requiem-mark`; projectile kinds `kunai` and `shade-clone`; `CombatSnapshot.player.untargetable` reports the untouchable windows.

`tests/combat/vesper-kit.test.ts` and `tests/combat/hero-kit-seam.test.ts` cover the kit and the seam.

## Sakda — Ember Fist kit (`ember`)

Sakda is an unarmed Muay Thai brawler: 115 vitality, walk 4.4 / run 6.6 m/s. Numbers come from `SakdaSkills.ts` and `kits/SakdaKit.ts`; cues use `actorId` `aren`, `element` `ember`. Skills that dash keep a contact gap of 0.9 m plus the target's radius, so a dash never ends inside a monster, and every dash is collision-safe and stays on supported ground.

**Passive Flurry.** Every non-J skill — Echo Wave, Resonating Strike, Hundred Elbows, Tempest Stomp, Flying Knee, Iron Clinch, Tiger's Wrath, Guard Dash and the shared Jump and Cleanse (through `onSharedSkill`) — arms two charges; the 180-tick window starts when that skill's recovery ends. The next two J swings in the window play 35 % faster (clip and cut tick divided by 1.35, rounded). A charge, and its 6-mana refund, is consumed only on a swing's first successful contact, so misses and cancelled swings keep it. `CombatSnapshot.player.flurryCharges` reports the live charges.

|Input|Skill (clip ids)|Behavior|
|---|---|---|
|J|Eight Limbs (`sakda-limb-1..4`), free|Jab-cross 20 ticks (cut 7, 10 dmg, 2.0 m), rising elbow 22 (8, 11, 2.0 m), clinch knee 26 (10, 14, 2.2 m, steps 0.6 m forward before the cut), roundhouse 32 (cut 13): an 18-damage kick in a 200° cone plus a **separate** 8-damage 3 m ember ring (8 ticks, its own hit tracking), so a target hit by both takes 26 and one caught only by the ring takes 8. Steps 1–3 hit a 120° cone. Cones are wall-checked. A soft target within reach + 1.2 m turns the swing. Hit-stop 3 (roundhouse 5), Instinct 8; the chain window is Aren's (4 ticks early, 18 late).|
|L tap|Echo Wave (`sakda-echo-wave`), 15 mana|Total 24, release 9: an `echo-wave` projectile (26 m/s, 14 m, 0.8 m wide, homes on the soft target) for 16 (idle-only stagger, hit-stop 2, Instinct 4). A hit leaves an `echo-mark` for 180 world ticks.|
|L tap, echoed foe|Resonating Strike (`sakda-resonating-strike`), **no mana**|Used instead of Echo Wave when a hostile with a live echo mark is within 14 m (+ radius; the locked one first, else the nearest). Dash from tick 4 at no more than 24 m/s; the 14-tick clip window covers 5.6 m, and **a farther target stretches the dash and the whole clip** (up to 14 m, 35 ticks) so the strike lands only after Sakda arrives. Impact: 18 + 8 % of the target's missing vitality (bonus capped at 30), idle-only stagger, hit-stop 6, Instinct 8; consumes the mark. Cancel window from the impact tick (K, L, F).|
|L hold → release|Hundred Elbows (`sakda-elbow-charge` loop, `sakda-hundred-elbows`), 35 mana|Total 60. Locks onto the soft target within 7 m (all around) and dashes up to 3 m over ticks 0–8. Six elbows at 12/18/24/30/36/42 (7 each, 2.4 m, 100° cone, hit-stop 2, Instinct 3) and an uppercut at 52 (14, 2.6 m, 120°, hit-stop 5, Instinct 8) that interrupts everything it hits.|
|K tap|Tempest Stomp (`sakda-tempest`), 12 mana|Total 28, stomp at tick 12: 4 m ring, 20 damage with interrupt (hit-stop 6, Instinct 8); every struck monster is crippled (`cripple` mark, movement ×0.6) for 120 world ticks.|
|K hold → release|Flying Knee (`sakda-knee-charge` loop, `sakda-flying-knee`), 20 mana|Total 40: leaps ticks 4–30 along a 1.4 m arc to the soft target within 10 m (5 m straight ahead with no target), swept with aerial collision for the whole trajectory (shortened or rejected when blocked) and landing on supported ground, then strikes at tick 30 for 38 (interrupt, hit-stop 7, Instinct 10) plus a 3 m ring of 12 (interrupt) around the landing. Its cancel window opens at the impact tick (K, L, F).|
|Q|Iron Clinch (`sakda-iron-clinch`) / Cleanse (`sakda-cleanse`)|Needs a winding-up foe and 20 mana, and **refuses beyond 6 m (+ the foe's radius and the 0.9 m gap) with the mana refunded**, showing “Iron Clinch needs the target within 6 m.” Total 36: dash ticks 0–12, strike at 12 for 8 with interrupt (hit-stop 5, Instinct 8). Cleanse keeps Aren's timing.|
|F|Guard Dash (`sakda-guard-dash`), 25 mana|Dodge with Sakda's numbers: 5.5 m over 18 ticks, 8 untouchable ticks, 14 recovery ticks. The player keeps the shared dive action id (the manifest aliases it to `sakda-guard-dash`); the hero clip id is the `actionId` of the `ember` `blink` cue emitted for every accepted Guard Dash. Grants a `shield` of 25 for 120 simulation ticks that absorbs hazard damage before vitality (`CombatSnapshot.player.shield`), and arms Flurry.|
|U|Tiger's Wrath (`sakda-tigers-wrath`)|100 Instinct; **needs a target within about 4.5 m** (dash range 2 m + 2.5 m); without one it shows “Tiger's Wrath needs a target within reach.” and spends nothing. Total 60, untargetable ticks 0–30, dashes up to 2 m ticks 14–24, kicks at 24 for 60 (hit-stop 7), interrupts the target's attack and staggers it for 90 world ticks, then slides it 7 m over 6 ticks in 0.5 m sub-steps (stopped by walls and the arena edge); every other hostile the slide passes through takes 40 once. A target defeated by the kick is not slid.|

Flying Knee, Resonating Strike and Guard Dash chain into each other: each opens a cancel window at its impact tick (Guard Dash: its dash end) that routes K, L and F to the kit even during recovery, and starting the next skill abandons the first cleanly. The other Sakda skills lock input for their whole clip. Flurry's window starts after a skill's recovery rather than at its first tick. Every targeted impact (Flying Knee, Resonating Strike, Iron Clinch, Tiger's Wrath) is checked with `host.canStrike` from Sakda's actual post-move position: out of reach or behind a wall means no damage, the echo mark is kept, and no interrupt, stagger or knockback.

`tests/combat/sakda-kit.test.ts` covers the kit.

