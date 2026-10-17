# Audio

Presentation-only audio for Wild Crown. Nothing in `src/audio/**` reads or mutates simulation state: it consumes `StoryCue` events, `ActorSnapshot`s and the settings/story state the application already publishes. Sound content is a **licensed sample library** (CC0, with provenance) plus the streamed region score; the old procedural synthesiser remains only where no sample fits (listed below).

Status: asset acceptance stays blocked until the user approves the list (see `docs/features/asset-pipeline.md`); this library has **not been auditioned by ear** — sounds were chosen by source category and file name, normalised by measurement, and verified by tests and a live browser smoke, not by listening. Treat the choices as candidates for a listening review.

## Library

`public/audio/**` (served at `/audio/...`, copied to `dist/audio` by Vite). 169 Opus-in-Ogg files, **11,340,585 bytes (10.8 MiB)** in total.

| Group | Files | Bytes | Use |
| --- | ---: | ---: | --- |
| `ui/` | 15 | 22,342 | click, hover, confirm, back, error, open, close, toggle, scroll, transition |
| `impact/` | 35 | 126,873 | 4 materials (flesh, wood, bark, stone) × 4 weights (light, medium, heavy, finisher) + finisher sub-layer |
| `react/` | 13 | 58,962 | knockback, knockdown, stagger, get-up, poise-break, wall-impact, stun-loop (seamless loop) |
| `weapon/` | 14 | 30,189 | whooshes: glaive, katana, staff, fist, monster swipe |
| `foot/` | 26 | 63,988 | footsteps by surface: grass, dirt, stone, wood, snow, mud, water + landing |
| `vocal/` | 46 | 253,404 | roar / hurt / death for 8 families: beast, canine, primate, avian, reptile, rootling, humanoid, giant |
| `music/` | 16 | 10,100,298 | 7 region exploration cues, 3 combat cues, boss, title, restored and corrupted layers, victory and defeat stingers |
| `ambience/` | 4 | 684,529 | forest, wind, swamp, water beds |

Provenance: `public/audio/provenance.json` lists **every** file with source page and download URL, author, licence id and licence URL, download date, original filename (and archive member), SHA-256 of the shipped file and of the source file, measured loudness/true peak, and the exact edits (trim, pitch, filter, fades, compression, normalisation, encode settings). All 31 source packs are **CC0-1.0** (Kenney Impact/RPG/Interface Sounds, OpenGameArt packs by rubberduck, artisticdude, remaxim/qubodup, AntumDeluge, trazzz123, cynicmusic, CleytonKauffman, nene, Emma_MA, RandomMind, Wolfgang_, isaiah658, HaelDB, Spring Spring, extenz, yd, TinyWorlds, Écrivain, beardalaxy). The licence was read on each pack's own page (or its `License.txt`) on 2026-10-14; one piece (“Lost in the meadows”, HaelDB) is dual-licensed OGA-BY 3.0 / CC0 and is used under CC0. Nothing NC/ND/unclear was admitted. `allowedLicenses` in the manifest is `CC0-1.0`, `CC-BY-3.0`, `CC-BY-4.0`; no CC-BY file is shipped, so no attribution obligation exists today.

Rebuild: `node scripts/audio/build-audio.mjs [--cache <dir>]` (needs ffmpeg with libopus, ffprobe, curl, unzip; downloads missing source packs into the cache, rebuilds every file, rewrites the manifest). Source packs and the output item table are `scripts/audio/sources.mjs` and `scripts/audio/items.mjs`.

### Mastering (measured, from the manifest)

- Music, stingers: **−16 LUFS** integrated target; measured −15.9 to −16.0 (ambience beds target −20, measured −19.9 to −21.9).
- One-shots: targets −14 to −18 LUFS by weight (light −18, medium −17, heavy −16, finisher −14, foley −18), measured on the clip tiled to ≥3 s (a 100 ms click padded with silence reads ~15 LU too quiet under BS.1770 gating). Very peaky clips (footsteps, clicks, light wood/bark/stone hits) hit the −1.5 dBFS limiter before their target and sit lower: measured range −27.9 to −13.2 LUFS; `tests/audio/audio-library.test.ts` accepts a clip below target only when its decoded true peak is at the ceiling.
- True peak of every file ≤ −1.0 dBFS after the Opus encode (the build re-encodes with a lower limiter ceiling when Opus overshoots).
- Encode: Opus 48 kHz, one-shots mono 48 kbps, music stereo 64 kbps, ambience stereo 48 kbps.

### Payload and loading

- **Initial load** (first unlock): the `core` pack — 94 files, **277,160 bytes** encoded, 7,692,372 bytes of decoded PCM — plus the title stream (346 KB, streamed). Measured in the live smoke.
- **Per region** (streamed, not decoded): exploration + combat + ambience(s): Greenwake 1.97 MB, Canopy 1.54 MB, Grove 1.72 MB, Moonpine 2.11 MB, Mistveil 1.11 MB, Refuge 1.58 MB, Heartroot Hollow 2.11 MB. The boss cue (977 KB), restored/corrupted layers (264/581 KB) and stingers (88/109 KB) are fetched only when first wanted.
- Vocal packs and non-core footstep surfaces (`snow`, `mud`, `water`) are fetched per region plan or on the first actor of that family: Greenwake region start measured 111 decoded files, 346,647 encoded bytes, 9,601,188 bytes of PCM (core + beast/humanoid/canine vocals).
- Music and ambience are **never decoded to PCM** (a 2-minute stereo track would be ~46 MB): they stream through media elements into the Web Audio graph. One-shots are decoded once by `SampleBank` (`decodeAudioData`, off the main thread) and cached.

## Runtime

```
src/audio/
  SampleCatalog.ts   groups, packs, region plans, tracks (the single runtime name table)
  SampleBank.ts      lazy per-pack fetch + decode-once cache; failures recorded, never swallowed
  SamplePlayer.ts    pooled gain/panner chains, bounded voices, inverse-distance panners, distance cull, loops
  VoiceLimiter.ts    per-group + global voice stealing by priority then age
  CueSoundMap.ts     StoryCue -> sampled sounds (weight, material, weapon, reaction, vocal family); CUE_SOUND_MODE
  ActorAudio.ts      snapshot pass: footsteps, death/roar vocals, stun loop, combat presence, boss
  MusicMix.ts        pure mix rules: equal-power stems, layer rules, slew, CombatIntensity
  MusicDirector.ts   stems (explore, combat, boss, restored, corrupted, title) with lazy open and pause
  StreamedLoop.ts    gapless streamed loop (two elements, equal-power crossfade at the wrap)
  StoryAudio.ts      the mixer (five buses, settings, ducking, cue play, region/title/stinger, mixerState)
  AppAudio.ts        shell facade: title score, UI sounds, region mixer forwarding
```

Buses (unchanged): `master`, `music`, `effects`, `ambience`, `dialogue`. `setSettings` applies the five settings volumes on every bus (time constant 35 ms).

### Wiring (existing hooks only)

- `GameApplication`: `AppAudio` shares three's `AudioContext`; `onUserGesture` unlocks it (title score starts on the first pointer/key event); `render()` calls `syncScreen(screen)` (title/map-select/hero-select carry the title cue; loading/map-intro/game/dialogue/... hand over to the region mixer; overlay panels leave the music alone; dialogue/choice duck the region mixer); `dispatch(action)` calls `action(type)` for UI sounds (slider ticks throttled to 90 ms); `presentPlayerOutcome` plays the victory/defeat stinger; `syncStoryState` passes the region's restoration state; the new region mixer is attached after `StoryPresentation` is created and unlocked immediately (the shared context is already running after the first gesture).
- `StoryPresentation.updateActors` calls `audio.consumeActors(actors)` once per presented frame.
- `StoryAudio.startBiomeAmbience(regionId)` (existing call) now starts the region score and ambience; a call made before the context is running is remembered and started by `unlock()`.

### Music

Per region: exploration, combat and ambience; shared boss; title; restoration layers; stingers.

| Region id | Exploration | Combat | Ambience | Footsteps |
| --- | --- | --- | --- | --- |
| `greenwake` | Lost in the meadows | Battle Theme A | forest | grass |
| `whispering-canopy` | Forest Whisper Theme | Battle Theme B | forest | dirt |
| `the-grove` | Beautiful Forest [Orchestra] | Determined Pursuit | forest | grass |
| `moonpine-ridge` | Fantasy: Rising Moon | Battle Theme A | wind | snow |
| `mistveil-basin` | Echoes of the Past | Battle Theme B | swamp + water | mud |
| `refuge` | At Home – Orchestral | Battle Theme B | forest | stone |
| `heartroot-hollow` | Exploration Theme | Determined Pursuit | forest | dirt |
| `blood-bamboo-valley`, `sunmane-expanse` | reuse Canopy / Hollow cues | – | – | no dedicated piece yet; zero extra payload |

Boss: Boss Battle Theme (any actor in `BOSS_ENCOUNTERS` as boss or large actor within 40 m). Title: Adventure Intro Title. Stingers: Just a random fanfare (victory, 9 s), Medieval Defeat Theme (defeat, 14 s). Restoration layers: Emotional piano loop (restored), Dungeon Ambience (corrupted).

Mix (`MusicMix.ts`, tested in `tests/audio/music-mix.test.ts`): exploration/combat/boss crossfade **equal-power** (squared gains sum to 1 at every blend); the boss cue replaces both; the restored/corrupted layers ride at up to 0.6 and recede to 30 % in combat or boss. Gains slew exponentially per stem (combat rises with τ 0.9 s, exploration returns with τ 3 s). Combat intensity rises at 1.2/s from hostile presence (a hostile within 22 m targeting the player, attacking or reacting) and cue pulses (hits 0.75, attack phases 0.55, reactions 0.7), holds 5 s after the last contact, then falls at 0.22/s. A stem is opened only when wanted (combat is prefetched paused), paused after 1.5 s of silence and resumed where it stopped. Loops wrap on a gapless two-element equal-power crossfade (2.5 s, shortened to a quarter of very short files). Layer levels come from the region's restoration state (`restored` → restored layer; `corrupted` → corrupted layer; `partial` → both at half; `unvisited` → corrupted 0.35) and live actor corruption (corrupted layer up to 0.6).

Dialogue ducking: while `dialogue`/`choice` is on screen the music bus is ×0.35, ambience ×0.5, effects ×0.75 (dialogue bus untouched; attack 120 ms, release 500 ms). A stinger ducks music ×0.2 and ambience ×0.5 while it plays.

### Sound effects

`CUE_SOUND_MODE` (exhaustive over `StoryCueKind`, enforced by the type checker and `tests/audio/audio-mapping.test.ts`):

- **sample**: `landing`, `reaction-start`, `wall-impact`, `poise-break`, `getup`.
- **layered** (sample body, plus the synth layer where it adds character): `hit` (impact by weight from confirmed damage — light < 8, medium < 14, heavy < 22, finisher ≥ 22 or intensity ≥ 2.2 — and material from the victim: rootlings bark, bodies flesh, environment contacts by surface; finishers add a sub-layer), `slash` (weapon whoosh by hero: glaive Aren, staff Yara, katana Vesper, fists Sakda), `active`/`pounce` (monster swipe on physical strikes/sweeps), `roar-cone` (family roar, giant set for bosses), `projectile-impact`, `grovebreak`. When a sample actually started, the synthesised body of a **physical** `hit`/`slash` is skipped; elemental hits (fire, ice, wind, poison, lightning) keep their synth accent; a sample culled for distance skips its synth too.
- **Reactions**: knockback (whoosh), knockdown (delayed thud), launch (knockback + delayed knockdown), stagger, wall impact, poise break, get-up; hostile victims grunt (family hurt vocal, ≥ 0.45 s apart per victim) from stagger upward; the player only when knocked down/launched. The stun ring is a loop that lives exactly as long as the snapshot shows `reaction.kind === 'stun'`.
- **Snapshots** (`ActorAudio`): footsteps by the region surface (stride 1.1 m + 0.18 s·speed, +1 m for bosses, ≤ 3 per pass, none airborne or during a reaction), monster death vocals on the alive → down edge, roar vocals on `roarProgress` (deduplicated 1.2 s against the cue roar).
- **UI**: every `UIAction` maps to confirm / open / back / toggle / click or to silence (`interact`, `use-ability`, `issue-command` are voiced by their own cues).

Voice budget: 24 sampled voices in total, per-group caps (impacts 4, vocals 3–4, UI 3, footsteps 4, stun loop 2), stealing lowest priority then oldest (finisher/death/poise-break outrank light hits and footsteps); sounds beyond 48 m are not started; positional voices use pooled equal-power panners with inverse distance (ref 3 m, roll-off 1.15). Gain/panner chains are reused; only the single-use `AudioBufferSourceNode` is created per play.

### Still procedural (no sample fits)

Telegraph tones (`anticipation`, `commit`, and the `active` phase tone: gameplay readability), spell and elemental timbres (sigil, projectile, beam, lightning, judgement, bloom, root eruption, blink, perfect-dodge, low-wave and the Warden/Canopy/Grove/Moonpine/Mistveil/hero layered recipes), story chord stingers (heartroot, tether, cleanse, bond, dominion, restoration, possession, phase, endings, march, reunion, heartbeat, sap-vein, footprint). The old oscillator ambience drones were removed (replaced by the sampled beds).

## Diagnostics

`StoryAudio.mixerState` returns live values: context state, bus gains, region, mix state, combat level, every stem (`state`, `gain`, `target`, `wraps`), ambience beds, ducking/stinger flags, bank statistics (loaded files, encoded/decoded bytes, loaded packs, **failed files**), voice statistics (played, culled, missed, stolen, rejected, active, chains) and the last sample played. Failed loads also `console.warn('[audio] failed to load …')`.

## Verification

- Provenance, mapping, limiting, crossfade and mixer tests: `/tmp/wc-bin/bun test tests/audio` (123 tests; the five older audio test files are unchanged and pass).
- Live smoke (Chromium on Metal against the dev server, real gestures, `page.evaluate` of `mixerState`): the title score started on the first gesture (`title` stem playing, master RMS 0.011) and a UI click played; the Greenwake region mixer streamed the exploration cue, the prefetched combat cue, the corrupted layer and the forest bed (master RMS 0.047); running produced 8 footsteps on `foot.grass`; synthetic hit/reaction/slash cues through the real cue path played the matching variants (`flesh-light` … `glaive-3`; 21 sample starts in total on that mixer) and crossfaded to the combat cue (combat stem 0.83, exploration 0.57); a synthetic boss engagement brought the boss cue to gain 1.00 with exploration 0.00; the stun loop started and stopped with the snapshot; dialogue ducking moved the music bus 0.80 → 0.28 → 0.80 and the stinger ducked it to 0.16. No page errors or console warnings; the only failed requests were Chromium's own `net::ERR_ABORTED` cancellations of media range requests. Boss and stun states were fed as synthetic snapshots (no Bible boss exists in the playtest maps); real engine hits and reactions were not exercised in the live run.
- Not measured: audible quality (not listened to), memory of streamed elements, long-session behaviour, Safari/Firefox playback of Ogg Opus.

## Known limits

- Footsteps use the region's default surface; no per-material ground query exists, so bridges and water crossings inside a region do not switch surface.
- `blood-bamboo-valley` and `sunmane-expanse` reuse existing cues until pieces are licensed for them; a Bible boss or region added later needs a catalogue entry (the test fails for an unmapped region).
- Browsers start audio only after a user gesture: title music begins on the first click or key press, never before.
