# Story effects and audio runtime

The presentation runtime is a consumer of the combat owner's transient `presentationCues` stream. Cues are not `WorldEvent`s: they carry no quest, reward, combat, or campaign authority. `src/effects/story-cues.ts` is the concrete presentation contract; `src/effects/index.ts` exports the stable entry points.

## Integration

```ts
const presentation = new StoryPresentation({
  scene: renderer.scene,
  resolveSocket: (actorId, socketName) => renderer.resolveSocket(actorId, socketName),
  resolveActorRoot: actorId => renderer.resolveActorRoot(actorId),
  audioListener: rendererAudioListener,
  reducedEffects: settings.reducedMotion,
});

// Fixed steps queue facts; they do not sample a potentially stale skeleton.
presentation.queueTick(cues);

// Every rendered frame: pose first, then consume/update/upload, then draw.
renderer.sync(snapshot.actors, snapshot, deltaSeconds, previousSnapshot, renderAlpha);
presentation.presentFrame(snapshot, renderAlpha, {
  position: listenerPosition,
  forward: cameraForward,
  up: cameraUp,
});
renderer.render();

// Call from a real pointer or keyboard user activation. Gamepad polling alone
// is not assumed to satisfy every browser's transient-activation policy.
await presentation.unlockAudio();
```

`queueTick` is separate from durable-world-event processing. `presentFrame` consumes the ordered queue only after the current native pose is evaluated, preserves original cue birth ticks, restores the current world clock for pose-following emitters, then uploads effects last. Simulation tick owns cue identity/order; every cue carries engine-stamped worldTick (including exact quarter ticks) and worldTimeSeconds. VFX age and expire entirely in the authoritative 60-Hz world-tick domain: current worldTick >= cue.worldTick + durationTicks. Seconds remain informational, not an expiry comparator. No epsilon, RAF delta, or arbitrary clock rounding is used. Slow motion erodes at the authored rate and zero-scale pause freezes effects. Sound cues remain one-shot on consumption; ambience/menu audio are not replayed or rate-scaled per frame. Cancellation clears pending scoped facts and live native emitters as well as pooled cue effects/audio. The lower-level immediate cue/actor/clock methods remain available to the isolated cue-only audio/VFX fixtures; native gameplay uses the queued frame path.

StoryCue retains its simulation tick/instanceId identity and carries required engine worldTick and worldTimeSeconds, semantic kind, explicit phase, optional actor/target/attack/action/scope IDs, world position/endpoints, authored footprint in meters and 60-Hz world-tick duration/priority/shape. Never derive a cue or timing from animation names, actor health, resource bars or VFX output. Active is a real hazard-phase transition emitted whether the attack hits or misses; hit remains an actual impact only. Engine hydration migrates legacy cue timestamps; consumers do not infer a missing worldTick.

Cancellation is part of the same authoritative stream: kind 'cancel', phase 'resolve', and cancellationReason route to the existing scope/all cancellation APIs without creating geometry or sound. Hazard scopes are individual attack instances, not the whole encounter, so interrupting one source preserves another source's telegraph. Region unload and renderer destruction already cancel/dispose the consumer; skip uses the cinematic scope. The engine owner supplies death and restore/checkpoint cancellation at their actual state transitions.

## VFX runtime (Sprint 1)

Rendering runs through `src/rendering/PostFX.ts`: a half-float HDR `RenderPass` (MSAA ×2), `UnrealBloomPass` (threshold 1.0, so only emissive/additive overdrive blooms) and an `OutputPass` with ACES Filmic tone mapping and sRGB output. The bloom input and the output pass sanitize every pixel (NaN → 0, Inf/overflow → 64), so one bad shader value can never black out the frame. Pixel ratio is capped at 1 by default: on the dense Greenwake scene ×4 MSAA cost about 10 fps at 1440×900 on an M1.

`StoryEffects` keeps cue deduplication, priority/capacity eviction, validation and world-tick ageing, but every visible form now comes from one `VfxSystem` (`src/effects/vfx/`) aged on the authoritative world clock:

| Module | Responsibility |
| --- | --- |
| `GpuParticles` | Stateless instanced billboards; the vertex shader integrates velocity, gravity, drag, size/colour/alpha curves, spin and velocity stretch. Round (non-stretched) billboards are pulled toward the camera by half their width and shrunk by the same ratio: the screen footprint is unchanged, but a large halo, ring or puff near the floor no longer cuts off along a hard line where it would sink into the terrain. Two ring-buffer pools (additive 5000, alpha 3000) = two draw calls; spawns with non-finite values are rejected; particles die per owner scope. |
| `VfxAtlas` | Procedural 4×2 atlas built once: glow, smoke, spark, ember, shard, leaf, ring, flame. |
| `GroundFx` | Footprint-sized ground quads with an organic shader mask: area hazards draw the inscribed ellipse, lanes/bands rounded superellipses, noise-eroded edges with a 40 % feather and low base opacity, element textures (bubbling venom, crystalline frost, travelling wave dust). Also shockwave bands and decals (scorch, frost, crack, venom, sap, scuff) fading over 4–6 s, tinted by owner. |
| `InstancedFx`, `IceMaterial` | Debris chunks on ballistic arcs and fresnel ice crystal spikes. |
| `RibbonFx` | Crescent wind blades and camera-facing beams (vines, tethers). |
| `FlashLights` | Four pulse point lights plus one dedicated tracked light for the Sigil Bolt (intensity 0 when idle, capped at 8) so flashes never recompile shaders. |
| `ElementKits` | Cue → kit mapping with three phases: anticipation (energy gathers at the monster's `cast` socket, tinted body rim, footprint fill plus in-footprint particles), active (detonation: thin hot core, element halo, shockwave, debris, light pulse, decal) and decay (smoke, embers, mist). Signature kits exist for every Greenwake attack plus `roar-cone`, `landing`, staff hits and contact hits. |
| `ActorVfx` | Heavy/charged-heavy slam, root-tether vine anchored to sockets, dive dust and speed streaks, jump landing dust, per-monster auras that intensify while that monster charges. |
| `HitFlash`, `ScreenVignette` | Fresnel rim flashes from per-actor material clones that are restored afterwards (charge ≤ 1.5 HDR rim only; hit ≤ 2.0 for ~0.2 s), and the red screen-edge pulse when Aren takes damage. |

Colour rule: every effect keeps its hue after ACES. The dominant channel of any particle colour is capped at 4.0 and near-neutral colours at 1.5; flames use normal blending so overlaps cannot stack to white; only a thin core (≤ 0.6 m) may run white-hot. Palettes are per owner: Ember Boar fire, Frost Sap-Stalker ice/venom, Root Rammer sap/earth, Aren Warden arcane cyan (heavy gold, Thunder Cleave lightning, Judgement cyan-violet).

Attack borders, sector outlines and coloured range planes remain removed: danger reads from particles, decals and the softly eroded fill, never from a hard-edged zone. The simulation still owns exact hit geometry; VFX coverage is not a hit promise.

Impact feedback is presentation only. `CameraDirector.addShake(amplitude, seconds, frequency)` applies a decaying offset after `lookAt` and never changes the `forward`/`right` input basis; it fires on player damage (scaled), detonations within 6 m of Aren, roars, landings, heavy staff hits and trial-gate openings. Reduced motion disables shake and flashes and softens bloom while keeping element identity.

`CombatObstacleVisuals` renders ice obstacles as translucent fresnel crystal (opaque inner body, blooming rim, shards) and root obstacles as a twisted root spike cluster with pulsing sap cracks; both throw a debris burst on eruption and keep collider-exact bounds.

The trial monsters additionally emit `roar-cone` (scope `<actorId>:roar`, sector footprint, interrupt-cancelled when the roar ends early) and `landing` cues from the simulation; both are consumed by the same kits.

### Warden Arsenal (Sprint 1.5)

`StoryPresentation.presentFrame(snapshot, alpha)` drives the Warden Arsenal (`src/effects/vfx/Warden*.ts`) alongside current-pose enemy emitters before the final GPU upload. The cue kinds `slash`, `sigil`, `projectile`, `projectile-impact`, `lightning`, `judgement`, `judgement-mark` and Aren's `hit` cues with element `arcane`/`lightning` are routed to `WardenCues`. Everything ages on the authoritative world clock, so hit-stop (world scale 0) freezes sparks, flashes, trail and projectiles together and releases them afterwards; presentation never writes simulation state.

| Piece | Behaviour |
| --- | --- |
| `BladeTrailFx` | Samples the `weapon-base`/`weapon-tip` sockets every frame inside the slash window (active ± 2 frames), expands them with centripetal Catmull-Rom sub-samples (no cusps or self-intersections) into one strip with three layers: a razor HDR edge line, a soft body that fades toward the blade root and with age (~0.16 s), and a faint afterglow. Light/Wave steps are cyan-white, heavy/charged gold-white with lightning flecks, Judgement cyan-violet. Falls back to the right-hand bone before the glaive rig exists. The weapon-edge materials (`userData.wcWeaponEdge`) glow 0.6 idle → 3–4 on a swing and decay. |
| Hit impact | Oriented spark fan, star flash, a bright cut line aligned to the real swing plane, black-sap/energy droplets (never blood), debris, rim flash, camera micro-shake and a screen impulse for strong hits, plus electric arcs crawling over the target's capsule for 0.35 s (`LineBatch`, regenerated every 2–3 frames). |
| `SigilFx` | Procedural rune texture (rings, 36-glyph band, ticks, hexagram, crescent) with three counter-rotating layers in one quad per sigil; spawn pop with overshoot, brightens until launch, pulses and fades. Barrage charge adds a ground circle; tracked sigils follow Aren's facing and never sit edge-on to the camera. Strokes keep their hue: the shader caps the dominant HDR channel at 1.8 (still above the bloom threshold) and dims a disc seen toward edge-on; the launch flare brightens strokes, not the disc centre, and the three per-launch Barrage sigils are small (0.5 m) and dim, so stacked launches read as a glyph burst rather than a white ball over Aren. |
| Projectiles | `sigil-bolt` and `crescent-wave` are drawn from `playerProjectiles` snapshots interpolated by `alpha`: bolt = HDR core, stretched glow, flare, two spiral rune ribbons, spark/mist trail and the dedicated tracked point light; wave = instanced crescent (`CrescentFx`), dust and a scorch scar. Impacts shatter a rune ring with glyph shards, flash and shockwave. |
| Thunder Cleave | Hold: lightning gathers into the blade tip, the weapon edge brightens with the hold, electric arcs crawl over Aren after a third of `THUNDER_CLEAVE.holdTicks`, and at the threshold (the tick a release becomes a Thunder Cleave) a tip flash, spark burst, dust ring, light pulse, lightning rim flash and micro-shake mark readiness. Progress is read from the simulation clock, so pause freezes it. Strike: midpoint-displaced trunk (9 m) with branches and radial ground arcs re-rolled every 2–3 frames for 0.3 s, strike flash, light, scorch decal, shake and screen impulse. |
| Judgement | Cyan additive pose afterimages (`PoseAfterimages`), speed streaks, X-shaped crescent marks over a ground rune that persist until the detonation cue (or the snapshot drops them), sheath flash on resolve. |
| `CleanseDissolveFx` | When a trial monster flips hostile → not hostile, a second slightly inflated black-sap shell (same geometry and skeleton) burns away through a stretched 3D-noise threshold with an HDR ember rim for 1.6 s with rising embers and ash; the animal underneath is untouched and only the shell is created/disposed. `prewarm(roots, compile)` compiles its skinned program ahead of time. |
| Ambient | Sparse dust motes and leaf flecks near Aren from the shared particle pools. |
| Screen/camera | `PostFX.addImpulse(strength, seconds)`: one pass (radial blur toward the centre, subtle chromatic split, brief exposure lift) enabled only while an impulse is live, strength ≤ 1, ≤ 0.6 s, disabled by reduced motion. `CameraDirector` pushes in along the view axis while `snapshot.hitStop` is active and eases back; orientation and the input basis never change. |

Idle cost: every Warden mesh is hidden until used, so the arsenal adds no draw calls at rest; a swinging, casting Aren adds at most the trail, line, sprite, crescent and (per visible sigil) quad draws. `ImpactSink.impulse?(strength, seconds)` is the optional hook for the screen impulse.

### Vesper and Sakda (hero kits)

Cues with `element: 'umbral'` (Vesper, the Moonshade Blade) and `element: 'ember'` (Sakda, the Ember Fist) always carry `actorId: 'aren'` and the skill's clip id in `actionId`; `resolveKit` sends them to `UmbralCues` / `EmberCues` (`src/effects/vfx`) and `resolveUmbralKit` / `resolveEmberKit` (`HeroKits.ts`) pick one kit per skill from `(kind, actionId)` (a clip with no skill, i.e. the shared dodge ids, falls back to Mist Blink / Guard Dash). Both families draw only from pooled resources tagged with the cue scope (particles, ground quads, sigils, crescents, beams, lights and their own `CrystalSpikesFx` module), so cancellation removes everything; reduced effects shrink particle counts but never silence a kit; a recent-contact ledger keys a kunai or Echo Wave impact to the engine's same-tick `hit` cue so one contact draws one burst.

| Hero | Kit (cue kinds) | Look |
| --- | --- | --- |
| Vesper | `umbral-iai` (`slash`, `hit`) | razor violet crescent with a crimson rim and black smoke wisps; step 3 crosses a mirrored blade; hit = razor slit, violet sparks, crimson glint |
| | `umbral-rift` (`beam`/`blink`, `hit`) | Crescent Rift: thin violet slit lane (beam + cracked ground decal) that lingers, long through-cut crescent, crimson exit burst |
| | `umbral-step` (`blink`) | Shadow Step: shadow implodes at the start, explodes at the end with a crossed pair of crescents |
| | `umbral-cuts` (`slash`, `sigil`, `blink`) | Thousand Cuts: cage of six vertical crescents around the target, per-cut crescent + cut sprite, charge ring with orbiting crescents |
| | `umbral-kunai` (`projectile`, `projectile-impact`) | violet spray on launch, crimson-glinted blade streak in flight (snapshot), spark bite on impact |
| | `umbral-shade` (`sigil`, `beam`, `blink`) | Shade Swap: ink-forming charge ring, wide black clone lane, swap flash + crimson ring; the clone is a dark silhouette in flight (snapshot) |
| | `umbral-mist` (`blink`) | Mist Blink: ink-smoke burst at both ends, fading silhouette at the start |
| | `umbral-requiem` (`judgement`, `judgement-mark`, `blink`) | Crimson Requiem: wide umbral sigil, crimson X marks, blink slashes, final crimson detonation with shadow blades |
| | `umbral-sever`, `umbral-cleanse` | Severing Shadow chain + crossed cut + shard burst; rising violet ring with crimson embers |
| Sakda | `ember-limbs` (`slash`, `hit`) | jab/cross gold flare, rising elbow throws sparks up, clinch knee flares with dust; limb trails (snapshot) |
| | `ember-roundhouse` (`slash`, `hit`) | fire crescent + ember ring, flames round the footprint |
| | `ember-echo` (`projectile`, `projectile-impact`) | fire-gold sonic rings on launch; gold echo-ring marking the target on impact |
| | `ember-resonate` (`blink`, `hit`) | dash comet (beam + gold sparks + flames); hit consumes the echo mark in an inward gold collapse and ring burst |
| | `ember-elbows` (`sigil`, `hit`) | rapid small flares; the closing uppercut (count of hits, or intensity ≥ 1.3) raises a flame pillar |
| | `ember-tempest` (`slash`) | ground fire ring with fracture cracks, flame spires and a cripple-chain decal of link sprites |
| | `ember-knee` (`sigil`, `blink`, `slash`) | charge ring, arc trail through the leap, meteor-like impact (fireball, flame column, shock rings, rubble) |
| | `ember-guard` (`blink`) | flame dash; the flame shield bubble is snapshot-driven (`player.shield`) |
| | `ember-wrath` (`slash`, `beam`, `hit`) | roundhouse + a tiger-shaped fire flash (head disc, ears, slit eyes, fangs, stripes), knockback streak, heavy impact |
| | `ember-clinch`, `ember-cleanse` | flaming chain + interrupt burst; rising ember ring |

`HeroStateFx` (called from `WardenCombat.update`) is the snapshot-driven half: `ActorSnapshot.heroMarks` on hostiles (a Death Mark pip ring that fills with stacks and a full crimson mark, a Shadow Execution burst when a Death Mark vanishes with more than 4 ticks left, echo rings, a crimson requiem X, cripple chain links), `player.shield` (flame/ink bubble that bursts when spent), `player.flurryCharges` (fist glow through the `fist-*` sockets), `player.untargetable` (ink wisps / embers), Sakda's limb trails (`SAKDA_LIMB_MASKS`, `fist-left|right`, `foot-left|right` sockets), Vesper's katana trail window for strike clips (`VESPER_BLADE_CLIPS`) and the `kunai`, `echo-wave` and `shade-clone` projectiles. `ActorVfx` covers air steps (umbral shadow step with a crimson crescent, ember fire ring), the dodge vanish (ink burst / shield flare), takeoff/landing dust and speed streaks for all four heroes, and `PoseAfterimages` has four styles (`warden`, `heartroot`, `umbral`, `ember`; umbral is denser and longer-lived and treats every dodge as a blink) plus the dash skills (`AFTERIMAGE_DASH_ACTIONS`), which keep their ghosts even when the engine teleports the body. `SigilFx` and `GroundFx` have umbral (blade/crescent glyphs, razor slits over ink) and ember (flame/fist glyphs, flame tongues over fracture lines) looks.

### Canopy monsters (Whispering Canopy playtest)

Presentation for the nine Whispering Canopy attacks (`?assetPlaytest=canopy`; ids, hazard shapes and timings are the cross-team contract in `.opencode/plans/2026-10-11-whispering-canopy-playtest.md`). All of it is presentation only: the simulation owns positions, hit windows and hazards; nothing here grants rewards or changes walkability.

**Clip plans** (`MONSTER_ATTACK_PLANS` in `src/rendering/MonsterAnimationProfiles.ts`; locomotion, turn, hurt, roar and idle use the Greenwake slot logic with per-asset run/walk references for `actor-thornback-howler`, `actor-storm-hornbill`, `actor-mire-viper`). The strike pose of each clip lands on the window that carries the visible hit:

| Attack | Clip slot | Windows (windup / commit / active / recovery) |
| --- | --- | --- |
| `howler-rock-hurl` | `monster-shoot` | 0–0.5 rear back / 0.5–0.68 throw (the rock flies) / 0.68–0.85 impact / 0.85–1 |
| `howler-leap-slam` | `monster-jump` | 0–0.3 crouch / 0.3–0.7 airborne leap / 0.7–0.85 landing slam / 0.85–1 |
| `howler-branch-sweep` | `monster-slash` | 0–0.3 / 0.3–0.45 / 0.45–0.74 strike pose opens active / 0.74–1 |
| `hornbill-dive-bomb` | `monster-dive` | 0–0.2 wings fold / 0.2–0.36 drop into the lane / 0.36–0.62 low lunge / 0.62–1 |
| `hornbill-feather-volley` | `monster-shoot` | 0.04–0.5 / 0.5–0.66 darts leave / 0.66–0.8 impacts / 0.8–1 |
| `hornbill-gale-flap` | `monster-slash` | 0.04–0.32 / 0.32–0.45 / 0.45–0.72 gale / 0.72–1 |
| `viper-venom-spit` | `monster-shoot` | 0.05–0.5 / 0.5–0.62 glob leaves / 0.62–0.72 (held through the 180-tick pool) / 0.72–1 |
| `viper-tail-lash` | `monster-turn` (loopable pivot) | loop rate 0.5→1.5 coil / 1.8→2.8 whip up / 2.8→2.4 lash / 2.2→0.5 settle |
| `viper-strike-lunge` | `monster-dive` | 0–0.18 rear back / 0.18–0.38 / 0.38–0.6 strike / 0.6–1 |

**Hornbill flight** (`MONSTER_HOVER`, `monsterHoverHeight(actor, assetId, worldTimeSeconds)`, `settleMonsterHover`). The simulated hornbill stays on its floor; the renderer draws the root `monsterHoverHeight` metres higher, so the `cast` and `root` sockets, the auras, the attack kits and any label anchored to the drawn body follow. Idle: 2.4 m with a slow, bounded bob (±0.14 m, 3.4 s period, phase from the actor id). `hornbill-dive-bomb`: the windup rears up 0.2 m, the commit drops (accelerating) to 0.6 m with the bob faded out, active holds 0.6 m along the simulated lane, recovery climbs back and the bob fades in, continuous at every phase boundary. A downed (cleansed) hornbill settles to 0.05 m. The function is stateless (snapshot + authoritative world clock), so a frozen clock holds the pose, a restored snapshot reproduces it and slow motion scales the bob; `settleMonsterHover` is an optional exponential easing (5 /s of world time) for the rare discontinuities (downed, get-up, load).

`GameRenderer` passes `settleMonsterHover` the rendered world-clock delta, not the frame delta. Settling therefore holds through hit-stop and pause and slows with Perfect Dodge slow motion. A world-clock rewind drops the cached heights. In the browser, a downed canopy hornbill held its drawn height for 10 hit-stop frames, then resumed settling with world time.

**VFX kits** (`src/effects/vfx/CanopyKits.ts`, kit id = attack id, dispatched from `ElementKits`; phases anticipation → commit → active → decay with the usual footprint-bound ground fills, decals and shocks; every ground quad is the cue footprint or a shape inscribed in it, so no hard-edged zone leaves the authored hazard):

| Kit | Anticipation / commit | Active / decay |
| --- | --- | --- |
| `howler-rock-hurl` | A sap-bound rock (`LobbedRocksFx`, one instanced draw call for every rock) grows in the raised hand while sap gathers and weeps; on the throw it is lobbed in a parabola from the `cast` socket to the committed point, trailing sap glow, sparks, bubbles and dust, and lands exactly as the hazard opens. | Rock shatters: flash, shock, scorch/crack decal glowing sap, clods landing inside the footprint, dust ring, sap splatter, light pulse, shake. |
| `howler-leap-slam` | Crouch dust and grit pulled under the feet, leaves stirred; take-off dust ring and clods; the airborne body trails earth/sap streaks, dust and torn leaves. | Landing slam: wide shock, deep crack decal, heavy clods, thick dust ring, leaves, light, heavier shake. |
| `howler-branch-sweep` | Leaves and bark gather at the raised branch; the band fills with stirred litter and wind streaks stream sideways. | A sweep head crosses the band shedding leaves, bark and dust; scuff decal, leaf/bark burst, drifting leaves on decay. |
| `hornbill-dive-bomb` | Wings fold: wind is drawn into the body, slate feathers shake loose, the lane starts to hiss; the commit pours streaks down the lane and kicks dust ahead. | Two wind crescents flank the dive, the drawn body trails streaks and feathers while dust skates along the lane under it; impact gust (shock, decal, dust ring, leaves, feathers, shake) at the lane end on decay. |
| `hornbill-feather-volley` | Feathers lift and a fan of glowing dart heads brightens in front of the bird. | Up to nine glowing storm-feather darts (stretched `cut` streaks with halo and trail) fly from the socket to landing points inside the cone; each impact (glow, ring, sparks, dust, feather) is pre-scheduled with a particle delay equal to the flight time, so pausing freezes darts mid-air. |
| `hornbill-gale-flap` | Wings raise: the air under the body churns, wind streaks rake the band; downstroke ring of dust and leaves. | Three wind crescents roll across the band with leaves, dust and streaks. |
| `viper-venom-spit` | Venom gathers and drips at the mouth; the commit flies a glob with two trailing sub-globs in an arc to the committed point. | Splash (flash, droplets, ring), a venom decal plus a bubbling `burn` surface that last the whole 180-tick pool, with rising venom smoke, bubbles and popping droplets. |
| `viper-tail-lash` | The body coils: dust circles the base, slick glints crawl along the band, droplets are flicked along it. | A slick head crosses the band throwing droplets and haze, a venom crescent sweeps through; slick decal and sheen. |
| `viper-strike-lunge` | Rears back: venom beads and fang glints at the mouth, lane streaks tighten. | A bright poison streak (`BeamsFx`) along the whole lane, fang flash and star at its tip, venom droplets flicked forward. |

Per-monster auras (`ActorVfx`) keep intensifying while the monster charges: howler = grit, sap drips and bubbles, earth glints; hornbill = circling wind streaks, storm-blue glints and sparks, loose slate feathers (emitted around the drawn, hovering root); viper = low venom fume, poison drips and bubbles. Identity glow (`OWNER_GLOW`): howler sap, hornbill storm-blue (`lightning`), viper poison.

Budgets and reduced effects: kits only use the shared particle pools (two draw calls), ground quads, debris, blades and beams, plus the single instanced rock mesh; `due()` emission rates and `count()` bursts shrink to 35 %, chunks to 50 %, darts to three, and flashes, lights and shake stay off under reduced effects. Every resource is owner-scoped, so cancelling the cue scope removes the rock, fills, beams and particles. Hue rule is unchanged (palette colours, dominant channel ≤ 4, neutral ≤ 1.5); alpha-blended tints (slate feathers, moss dust, black-sap slick) are never HDR.


### Scoped qualification

Producer/consumer regressions retain actual authored geometry, phase timing, missed-active events, interruption, cancellation, pause and serialization. The current native browser proof is Greenwake only; it does not establish live native visual acceptance for Asha, Koro, other regions or Orun variants. Earlier R08 border/floor screenshots and coverage measurements are superseded by the natural-effects cutover.

Scheduler-only audio regressions measure oscillator schedules, one-shot behavior, cancellation and borrowed-context ownership, not subjective listening quality. Earlier source-to-ground browser audio reached nonzero effects output after a genuine gesture; this combat-polish run makes no new audio-quality or recorded-sound claim.

### Parent-only WebGL/WebAudio surface

Serve `/tests/effects/danger-presentation.smoke.html` for focused producer/consumer inspection in the main session's tab; workers never open a browser. Its controls advance the real engine and exercise hit, active/miss, time policy, cancellation and restore without fabricated attack cues. Consumer-only unload/skip controls and user-gesture audio measurements remain separate from gameplay proof. Inspect natural forms and console errors; prepared HTML is not evidence that a new WebGL/WebAudio scenario ran.

Active/miss controls require a real active cue with no fabricated damage hit. Death requires real global cancellation, zero vitality and no live effects. The main application's local native smoke additionally exercises donated Defeat, its frozen world clock and replay/resource retirement.

## Audio

`StoryAudio` creates a browser `AudioContext` graph only after an explicit user gesture, with master, music, effects, ambience, and dialogue gains bound to `GameSettings`. Sounds are authored procedurally from WebAudio oscillators/envelopes and low-pass-filtered biome tonal beds; they are **procedural sounds, not recorded field recordings or voice**. Existing English dialogue remains subtitles owned by UI. Positional cue tones use `PannerNode` with the renderer's listener position/orientation, and their source position uses explicit event coordinates or the actor root socket. `playbackMetadata` reports context state, active voices, last scheduled cue, and analyser RMS so actual browser output can be verified. Nonlethal impacts use soft, short tonal/percussive envelopes; no gore/blood audio is authored here.

Adaptive cue arrangements shift with supplied corruption/restoration/Bond/Dominion values. The caller owns those actual world/campaign values and must provide them; the mixer does not infer or mutate them. Dialogue voice recordings are not claimed. All buses are independently volume-controlled; there are no uncontrolled flash or loudness effects.

Warden skills have dedicated procedural voices (`src/audio/WardenSounds.ts`, data-only recipes of oscillator glides and filtered noise bursts): `slash` is a filtered-noise swish whose pitch rises with intensity, Aren's arcane `hit` layers a noise click, low thump and an inharmonic metallic ring (lightning: crack + zap), `sigil` a rising detuned triangle chord, `projectile` an airy whoosh with a whistle, `projectile-impact` a glassy shatter plus thump, `lightning` a sharp crack, crackle tail and low rumble, `judgement` a swell / whoosh / sheath "shing", and `judgement-mark` a soft ping then a sharp detonation. At most ten Warden voices live at once (the oldest is stolen); layer levels stay ≤ 0.08 on the effects bus and cancellation, one-shot and pause contracts are unchanged. These are synthesized sounds, not recorded assets.

Whispering Canopy monsters have their own recipes (`src/audio/CanopySounds.ts`, same `SoundLayer` data and the same level ≤ 0.08 / ≤ 8 layers / ≤ 1.4 s budgets, voiced through the same layered path as the Warden sounds but in a separate pool of at most six voices, so a canopy barrage can never steal Warden voices). Howler: strained grunt and gravel while the rock forms, a heavy air whoosh whose pitch falls as the rock passes, a deep stone thud with crack and debris skitter (rock hurl); a crouch growl, take-off whump and sub-bass slam (leap); creaking wood, a long falling whoosh with leaf shear (branch sweep). Hornbill: folding rush and rising whistle, a rising screech on commit and a pitch-dropping fly-by whoosh with a low air whump (dive bomb); feather ruffle, a shimmer chord and three staggered dart zips with landing ticks (volley); a slow air swell, downstroke whump and a roaring tapering gale (flap). Viper: hiss and gurgle, a sharp wet "pt" and a bubbling splash that lasts as long as the pool (spit); dry scale scrape, a whip crack and wet slap (lash); a tightening hiss and a fast hiss-snap with a bite click (lunge). The `roar-cone` of `canopy-howler` / `canopy-hornbill` / `canopy-mire-viper` is voiced per monster (guttural bark, piercing screech, long rasping hiss); every other roar keeps the generic arrangement.

Vesper and Sakda have their own recipes (`src/audio/UmbralSounds.ts`, `src/audio/EmberSounds.ts`) in the Warden voice pool and budgets (≤ 8 layers, level ≤ 0.08, ≤ 1.4 s, at most ten shared voices): Vesper is a whispered noise swish with thin metallic "shing" partials, a hollow blink whoosh with a crisp tick (Shadow Step), a breathy ink hush (Mist Blink), a reversed swell and pop (Shade Swap) and a deep crimson detonation; Sakda is meaty low thuds with a dry click for fists and elbows, a sharper crack for kicks and knees, a fire roar for the roundhouse, charges and Tiger's Wrath, a rolling sonic thump for Echo Wave, a flame whoosh for dashes and a warm two-note hum for Guard Dash. Cues of those elements without a recipe use the generic element timbre (`ELEMENT_TIMBRE`).

## Evidence and checks

- `tests/effects/story-effects.test.ts` covers event deduplication/load reset, scope cancellation, pool priority and exact world-clock pause/expiry.
- `tests/effects/danger-presentation.test.ts` covers real active lifetime, fractional expiry and scoped/global cancellation; removed border geometry is not repinned.
- tests/effects/danger-audio.test.ts covers distinct real-family oscillator schedules, phase pitch, one-shot deduplication, cancellation and borrowed context lifetime with an explicitly synthetic scheduling instrument.
- `tests/effects/danger-qualification.json` is historical cross-worktree producer evidence, not current border/floor visual acceptance or release qualification.
 - `tests/effects/story-effects.smoke.html` injects presentation-only cues into a real Three.js renderer and has a user-gesture audio control. Its cues are visual/audio fixtures only and never imply a successful gameplay event.
 - The browser harness exercises independent audio consumers sharing the renderer's `AudioListener`; disposing one consumer must not close the listener-owned context.
 - `evidence/effects/browser-smoke.json` records the actual browser capture and audio output metadata. The screenshot is a runtime harness, not a gameplay scene or a readiness claim.
- `tests/effects/canopy-kits.test.ts`, `tests/effects/vfx-footprint.test.ts` (canopy ids included), `tests/audio/canopy-audio.test.ts` and `tests/rendering/canopy-monster-profiles.test.ts` cover the canopy kits (kit mapping, spawn caps, reduced effects, scope cancellation, rock arc, dart fan, ground quads inside the footprint), the canopy sound recipes and voice budget, the nine clip plans and the hornbill hover function.
- `tests/effects/hero-kits.test.ts` (kit resolution for every Vesper/Sakda clip id, the (element, kind, actionId) table drawing and being cancelled with its scope, reduced effects, contact ledger, elbow barrage, saturation budget, snapshot-driven marks/projectiles/shield/flurry/limb and katana trails, per-hero air steps and dodges), `tests/audio/hero-audio.test.ts` (recipe budgets and shapes, playback, shared voice pool) and `tests/rendering/PoseAfterimages.test.ts` (four styles, colours, density and life, dash-skill eligibility) cover the Vesper and Sakda presentation.

## Blood Bamboo Valley effects (Wave 2 slice D)

- **Boss kits** (`BambooKits.ts`, a map-kit family like Grove's; the attack id selects the kit through `BAMBOO_ATTACK_KITS`): `asha-pounce`, `asha-corrupt-slam`, `asha-charge` (Bamboo Charge and Side Charge), `asha-claw`, `asha-sap-trail`, `asha-ground-wave`, `koro-falling-branch`, `koro-platform-charge`. Koro's rock throw, foreground leap and log sweep play the Howler's Canopy kits; the Roar Cone is the shared roar kit. Every ground quad is spawned from the cue's hazard footprint, so the Black Sap trail (a driven `burn` surface held for the engine's whole 150-tick hazard, then a decal) and the wave band follow the simulation geometry; nothing is damaged or timed by the renderer. A cancelled scope (phase change, interruption, retry, unload) releases quads and beams; tested for every kit.
- **Companion feedback** (`CompanionFx.ts`, new cue kinds `mark`, `guard`, `command`, `shelter`): persistent markers follow the snapshot: Vara's mark ring, head chevron and committed-landing hint with its line follow `ActorSnapshot.mark`, Asha's guard ring and line follow `guard` (brighter while blocking, dim in recovery), a finite job's line follows `job`; they are released when the field disappears (expiry, recall, target change) and by `cancelAll` (death, load, unload). Caps: 2 marks, 1 guard, 2 jobs, 1 shelter (manual ground slots of the shared 18-slot pool). Cues add the moment: mark landing ring, block flash + short shake, a per-command ring, Tali's shelter ring held for the cue duration. Reduced effects draw the markers steady (no pulse or blink). Audio: the four kinds are voiced procedurally on the effects bus (`CueSoundMap`, `StoryAudio`); no sample or audio source was added.
- Koro's and Asha's idle aura (`BAMBOO_AURAS`) is drawn only while the body is hostile and not cleansed.
- Tests: `tests/effects/bamboo-kits.test.ts`, `tests/effects/companion-fx.test.ts`, `tests/rendering/bamboo-monster-profiles.test.ts`, `story-actor-animation.test.ts`, `story-driver.test.ts`, `actor-binding.test.ts`, `instance-visibility.test.ts`.
