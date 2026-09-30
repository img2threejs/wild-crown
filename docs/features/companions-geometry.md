# Companion simulation and shared geometry

`CompanionSystem.ts` owns deterministic support state and grounded navigation. `CombatEngine` owns actors, encounter state, world facts, and event processing. The companion module does not create actors: a selected companion must already be present, visible, alive, and unpossessed in the loaded region.

## Companion behavior

- `createCompanionState(slots, chapter)` creates only explicitly assigned combat, utility, and Vara scout slots. Warden’s Call defaults unavailable until campaign data explicitly supplies it; chapter numbers never infer its loss or grant.
- `configureCompanions(engine, config)` applies chapter, explicit Warden’s Call, Bond, Dominion history, and authored navigation nodes without resetting command resources.
- configureCompanionSlots(engine, slots) atomically reconciles live party roles. Duplicate roles, non-Vara scouts, and absent, hidden, downed, or possessed selected actors are refused without mutation. On success, selected existing slot state (including cooldown/token state) is preserved and unselected slot records are removed; actors are never summoned.
- Slot lookups prefer an exact runtime actor ID, then accept only one loaded actor with the canonical archetypeId. Ambiguous duplicate archetypes are refused. Companion state stays keyed by CompanionId; emitted actor IDs remain instance IDs.
- `companionCommand(engine, id, command, targetId?)` checks selected role, actor availability, possession, Bond/Warden’s Call gates, cooldown, and shared token budget. Follow/Recall and Stay are positioning commands; Focus/Defend/Special use a shared token, and Vara’s scout mark uses a cooldown without a combat token. Search and Distract require a live target and utility role. Koro’s utility Special may target only a registered resting movable object authored for Koro; it consumes the normal token/cooldown and leaves movement and WorldEvent authority to CombatEngine. Other Special commands require a live actor target, defaulting to the current target when available.
- `COMPANION_ROSTER` exposes each canonical ability ID plus `abilityLabel`/`abilityDescription` sourced from `COMPANION_COPY` in `PLAYER-COPY.en.json`; app UI should display that mapping, not humanize IDs.
- `stepCompanions(engine)` replenishes one shared token every 90 ticks, applies nonlethal companion support, and advances available companions at a bounded stride. An unreachable or unsupported destination leaves the actor in place and sets `pathFallback`; it never teleports or follows a direct line through a collider. Koro’s object-specific Stay holds position through object flight and resumes Follow after landing.

Navigation consumes authored `navigation.nodes` and explicit links. Node requirements open only when their corresponding world fact is `true` or an authored traversal gate is unlocked. Direct paths and graph edges use shared surface heights and the same grounded-capsule clearance test. Vara follows/scouts at elevated Y through the 3D capsule sweep; terrain does not snap her to the floor and colliders/world bounds constrain flight.

Support remains distinct and nonlethal: Asha Defend protects Aren for six ticks and her boss interrupt affects only an open anticipation; Koro distracts only an uncommitted hostile windup; Sable creates a nonlethal flank opening; Nyra ambushes only a vulnerable opening or the current Perfect Dodge counter without changing corruption; Vara marks/warns; Solkar rallies an open boss windup. Nyra’s optional rootway uses the authored nyra-reveal-hidden-route interaction. resolveInteraction('nyra-reveal-hidden-route','nyra') requires active/present/visible/unpossessed Nyra and Aren within its authored 2m radius; it is separate from generic Ask/Signal, so Warden’s Call/Bond is not required. CampaignDirector marks the optional route fact without completing a quest; the mandatory path remains independent.

After Warden’s Call is lost, Ask/Signal remains gated by Bond rather than a chapter-number guess. Presentation cues do not write campaign history.

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
