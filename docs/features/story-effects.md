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

## Audio

`StoryAudio` creates a browser `AudioContext` graph only after an explicit user gesture, with master, music, effects, ambience, and dialogue gains bound to `GameSettings`. Sounds are authored procedurally from WebAudio oscillators/envelopes and low-pass-filtered biome tonal beds; they are **procedural sounds, not recorded field recordings or voice**. Existing English dialogue remains subtitles owned by UI. Positional cue tones use `PannerNode` with the renderer's listener position/orientation, and their source position uses explicit event coordinates or the actor root socket. `playbackMetadata` reports context state, active voices, last scheduled cue, and analyser RMS so actual browser output can be verified. Nonlethal impacts use soft, short tonal/percussive envelopes; no gore/blood audio is authored here.

Adaptive cue arrangements shift with supplied corruption/restoration/Bond/Dominion values. The caller owns those actual world/campaign values and must provide them; the mixer does not infer or mutate them. Dialogue voice recordings are not claimed. All buses are independently volume-controlled; there are no uncontrolled flash or loudness effects.

## Evidence and checks

- `tests/effects/story-effects.test.ts` covers event-instance deduplication/load reset, scope cancellation, pool priority, exact geometry/cache bounds, reduced-mode warning floor, and scaled world-clock aging: 12 ticks at 0.25, zero-rate freeze, and expiry by world duration.
 - `tests/effects/story-effects.smoke.html` injects presentation-only cues into a real Three.js renderer and has a user-gesture audio control. Its cues are visual/audio fixtures only and never imply a successful gameplay event.
 - The browser harness exercises independent audio consumers sharing the renderer's `AudioListener`; disposing one consumer must not close the listener-owned context.
 - `evidence/effects/browser-smoke.json` records the actual browser capture and audio output metadata. The screenshot is a runtime harness, not a gameplay scene or a readiness claim.
