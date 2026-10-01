# Story effects and audio runtime

The presentation runtime is a consumer of the combat owner's transient `presentationCues` stream. Cues are not `WorldEvent`s: they carry no quest, reward, combat, or campaign authority. `src/effects/story-cues.ts` is the concrete presentation contract; `src/effects/index.ts` exports the stable entry points.

## Integration

```ts
const presentation = new StoryPresentation({
  scene: renderer.scene,
  resolveSocket: (actorId, socketName) => renderer.resolveSocket(actorId, socketName),
  audioListener: rendererAudioListener,
  reducedEffects: settings.reducedMotion,
});

// Call after draining CombatEngine.drainPresentationCues() for this fixed-step tick.
presentation.consumeTick(cues);

// Pass the complete engine-owned clock; never derive effect time from RAF delta.
presentation.update(snapshot.worldClock, {
  position: listenerPosition,
  forward: cameraForward,
  up: cameraUp,
});

// Call from a real pointer or keyboard user activation. Gamepad polling alone
// is not assumed to satisfy every browser's transient-activation policy.
await presentation.unlockAudio();
```

`consumeTick` is separate from durable-world-event processing. Simulation tick owns cue identity/order; each cue also carries engine-provided `worldTimeSeconds`. VFX age by scaled world-time elapsed (60-Hz `worldTick / 60`): slow motion erodes at the authored rate, and zero-scale pause freezes effects. Never derive it from RAF delta. Sound cues remain one-shot on event consumption; ambience and menu audio are not replayed or rate-scaled per update. The caller cancels scopes on interrupt, death, cinematic skip, region unload, and campaign load, then disposes the presentation module on renderer destruction.

`StoryCue` retains its simulation `tick`/`instanceId` identity and carries engine `worldTimeSeconds`, a semantic `kind`, explicit `phase`, optional actor/target/attack/action/scope IDs, world position/endpoints, authored footprint in meters, optional 60-Hz world-tick duration/priority/shape. Never derive a cue or its timing from animation clip names, resource bars, or VFX output. The combat owner emits the cue only when the authoritative phase/hit/success happens. The audio/VFX consumers never grant gameplay success.

Cancellation is part of the same authoritative stream: kind 'cancel', phase 'resolve', and cancellationReason route to the existing scope/all cancellation APIs without creating geometry or sound. Hazard scopes are individual attack instances, not the whole encounter, so interrupting one source preserves another source's telegraph. Region unload and renderer destruction already cancel/dispose the consumer; skip uses the cinematic scope. The engine owner supplies death and restore/checkpoint cancellation at their actual state transitions.

## Pooled VFX

`StoryEffects` creates reusable Torus, arc, beam, sphere, and planar geometry meshes at initialization; it updates pooled mesh transforms/materials rather than building per-frame particle geometry. Its pool caps at 96 entries (default 48, minimum 8), reserves one quarter for essential cues, and evicts cosmetics before story cues/telegraphs. It keeps exact authored world position, footprint dimensions, orientation, and tick duration in reduced-motion mode while lowering opacity. Cone sectors use their authored aperture and uniform radial range on the ground plane; ring/telegraph bounds remain stable across ticks. Cue IDs are deduplicated in a bounded 512-ID window; death, unload, and campaign-load cancellation reset that local window so restored runs can reuse event IDs. Scope/all cancellation releases visible meshes immediately.

The authored vocabulary follows the production art bible:

| Cue family | Presentation form |
| --- | --- |
| Heartroot / Bond | `heartroot` uses an amber, endpoint-anchored pulse; `bond` uses a separate reciprocal strand/open release. Actor identities remain visible; no collar motif. |
| Dominion | Restrained convergent/radial cue and distinct ending motif, without relying on color alone. |
| Black Sap | Low-opacity near-black/brown surface vein/trail with restrained warm contrast, anchored to the authored footprint. |
| Anticipation / commit / hit | Thin footprints/lines and explicit phase changes; only combat-authored times and dimensions. |
| Tether | Geometric strand between the two cue endpoints; scope cancellation removes it. |
| Perfect Dodge | Brief thin spatial trail/counter cue emitted only from the successful combat event. No screen wash. |
| Cleanse / reunion | A peel/release path and separate reunion cue; no explosion or whiteout. |
| Restoration | The accepted campaign state change emits explicit `restoration-water` → `restoration-roots` → `restoration-seeds` → `restoration-animals` cues: low channel ring, root vein, seed pulse, then open animal return arc. No green-only color grade or collision/nav mutation. |
| Grovebreak / March / ending | Explicit story cue families; final ending cues are `ending-living-pact`, `ending-dominion`, and `ending-severance`. |

The live Tripo character assets and measured animation/socket markers are not prerequisites for geometric effects, but asset-dependent alignment remains unverified until measured clips and actual sockets are supplied. No guessed clip marker is treated as measured.

## R08 canonical danger mapping

Family identity comes from the authored ATTACKS[cue.attackId].hazard.kind; cone stays a sector-shaped **area**, not a sixth canonical snapshot family. The consumer does not reconstruct hit times, radii, aim positions, or cancellation from animation names, actor health, RAF, or VFX. It requires the producer's positive footprint dimensions, position and remaining phase duration (fractional world ticks are preserved).

| Canonical family | Accurate ground footprint and color-independent glyph | Authored procedural audio identity |
| --- | --- | --- |
| strike | Landing-radius disk outline with short cross; no rising burst sphere | Single triangle tone |
| sweep | Complete oriented rectangular boundary with an interior half-arc | Three-note sawtooth scrape motif |
| wave | Complete oriented rectangular boundary with two transverse wave bands | Low two-note sine motif |
| area | Axis-aligned rectangular boundary with interior ring; cone variant outlines both radial edges and outer arc at the source | Four-note triangle chord |
| projectile | Actual radius-only landing disk with directional chevron; the authored engine is not a travelling-projectile simulator | High two-note square motif |

These outlines use pooled planar buffers and never fill the entire danger zone or add a screen wash. Thin anticipation, heavier commit, and impact strokes distinguish the producer-emitted phases without color. The outer boundary never grows/shrinks. Reduced effects keeps identical dimensions, anchors, yaw, phase strokes and glyphs with the existing essential-opacity floor. Audio phases retain each family's notes/timbre with distinct lower commit/impact pitch; audio is one-shot, not a second world/hit clock. Spatial warnings use the cue's source endpoint; impacts use the emitted impact footprint position. Body animation, contacts, foliage/environment motion, and recorded roar/claw assets are not supplied or qualified by this ground-outline/audio increment.

### Scoped qualification

The real-producer scenario selects existing authored encounter phases and attack selectors, then runs CombatEngine.fixedStep → drainPresentationCues → StoryPresentation.consumeTick/update. It does not fabricate presentation cues. It exercises Asha pounce, claw combination, ground wave, Koro fruit burst, poacher scout net, and Asha protective-roar area variant in normal/reduced mode, including each actual anticipation/commit/hit event. The R08 branch depends on the separate M04 engine-owner producer correction; the branch's unchanged c7aaac9 engine alone does not have the corrected dimensions/scopes/durations. Cross-worktree runtime measurements are not an integrated-main or full-game pass.

The scheduler-only audio regression instruments scheduled oscillator frequencies, waveforms, one-shot behavior, cancellation and borrowed-context ownership; it is **not** WebAudio output or listening evidence. Native body/rig proof, browser readability, actual output RMS and audio quality remain unmeasured until the parent runs the browser surface.

### Parent-only WebGL/WebAudio surface

Serve /tests/effects/danger-presentation.smoke.html after integrating M04 and R08 in the parent worktree. Reuse the parent's single headless tab; workers never open a browser. Select each attack, capture normal/reduced anticipation and commit, and inspect window.__dangerSmoke. The hit control advances the actual engine to its emitted hit; slow uses an explicitly selected engine time-policy seed, and pause uses the actual authoritative paused clock, never RAF time. Actual root-tether and lethal-hazard controls exercise producer cancellation. Load invokes engine.restore and consumes its authoritative cancellation stream; unload/skip buttons exercise the consumer lifecycle APIs only. After a genuine click on #unlock-audio, the page measures RMS for all five real-family one-shots, verifies no same-instance replay, and verifies a second consumer survives disposal of one consumer sharing a Three.js AudioListener context. Capture screenshots and console errors separately; HTML preparation is not proof that WebGL/WebAudio ran.

## Audio

`StoryAudio` creates a browser `AudioContext` graph only after an explicit user gesture, with master, music, effects, ambience, and dialogue gains bound to `GameSettings`. Sounds are authored procedurally from WebAudio oscillators/envelopes and low-pass-filtered biome tonal beds; they are **procedural sounds, not recorded field recordings or voice**. Existing English dialogue remains subtitles owned by UI. Positional cue tones use `PannerNode` with the renderer's listener position/orientation, and their source position uses explicit event coordinates or the actor root socket. `playbackMetadata` reports context state, active voices, last scheduled cue, and analyser RMS so actual browser output can be verified. Nonlethal impacts use soft, short tonal/percussive envelopes; no gore/blood audio is authored here.

Adaptive cue arrangements shift with supplied corruption/restoration/Bond/Dominion values. The caller owns those actual world/campaign values and must provide them; the mixer does not infer or mutate them. Dialogue voice recordings are not claimed. All buses are independently volume-controlled; there are no uncontrolled flash or loudness effects.

## Evidence and checks

- `tests/effects/story-effects.test.ts` covers event-instance deduplication/load reset, scope cancellation, pool priority, exact geometry/cache bounds, reduced-mode warning floor, and scaled world-clock aging: 12 ticks at 0.25, zero-rate freeze, and expiry by world duration.
- tests/effects/danger-presentation.test.ts covers canonical collision-boundary geometry (including rectangular corners and sector radial edges), zero-height footprints, stable reduced-mode shapes, ordered attack-scoped/global cancellation, and fractional commit expiry.
- tests/effects/danger-audio.test.ts covers distinct real-family oscillator schedules, phase pitch, one-shot deduplication, cancellation and borrowed context lifetime with an explicitly synthetic scheduling instrument.
- tests/effects/danger-qualification.json records the actual cross-worktree producer/consumer run: six authored attacks × normal/reduced × three emitted phases, exact dimensions/timestamps/scopes, 12 slow simulation steps advancing three world ticks, pause freeze, actual interrupt/death/restore cancellation and no stale queued-hit replay. Browser/rig measurements are explicitly null. The final scoped compile passed and the three effects/audio regression files reported 23 pass, 0 fail.
 - `tests/effects/story-effects.smoke.html` injects presentation-only cues into a real Three.js renderer and has a user-gesture audio control. Its cues are visual/audio fixtures only and never imply a successful gameplay event.
 - The browser harness exercises independent audio consumers sharing the renderer's `AudioListener`; disposing one consumer must not close the listener-owned context.
 - `evidence/effects/browser-smoke.json` records the actual browser capture and audio output metadata. The screenshot is a runtime harness, not a gameplay scene or a readiness claim.
