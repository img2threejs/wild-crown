# Combat and companion simulation

`CombatEngine` is the deterministic authority for the fixed 60 Hz gameplay simulation. It accepts camera-relative input plus the current camera basis, resolves collision-safe movement and target-facing strafe, and exposes serializable state for rendering. Renderers consume action IDs and snapshots; they never decide hit timing, actor damage, encounter rewards, or quest history.

## Evasion and combat

The engine maps all 17 approved Wild Flow actions to semantic action IDs. Dodge has two independent charges and a 105-tick (1.75 second) recharge; it does not spend Instinct. Profiles move in the chosen direction, obey arena bounds and obstacle collision, and carry explicit active/recovery timing. Perfect Dodge requires a live attack instance, a future threat tick within the 12-tick close window, a real overlap at the committed footprint, and an evasion that clears that hazard class; attack hit groups are deduplicated. Low Slide never clears a ground wave. Staff Vault needs a visible authored affordance or space outside the footprint. I-frames do not make persistent area footprints safe.

Light 1–3, Heavy, Charged Heavy, Root Tether, Ferocity, Corruption, and Cleanse use the same target, reach, facing, and simulation-time rules. Cleanse is interruptible and resolves only when Aren stays within range through the active window. Encounter resolution emits stable, idempotency-keyed `WorldEvent`s; restoration is a separate semantic event, not a rendering side effect. Safe checkpoint restoration restores pre-reward state and uses the same deterministic event keys, so campaign processing remains idempotent.

## Boss encounters

Authored data covers Koro, Asha (three phases and three configured corruption-core IDs), Ruun, Ghor, Solkar, and Orun (six Heartroot aspects). `CombatSnapshot.boss.corruptionCores` exposes Asha’s per-core cleansed state directly; only successful Cleanse impacts advance one core, while misses and phase transitions do not. Bosses without configured cores omit that array rather than inheriting a fabricated count. Every authored attack has windup, committed aim, active footprint, recovery, an English cue, and interruptibility. Committed attacks never retarget. Every attack footprint is observable and has either movement/height counterplay, a marked traversal affordance, or a player-only counter. The simulation enforces at most two large actors total, two grounded large actors, one aerial large actor, and six hostile actors.

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
