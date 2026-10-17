# Wild Crown: The Broken Pact

A standalone desktop-web cinematic action adventure built with **TypeScript, Three.js and Vite**. The current **beta** opens candidate story chapters by default, with four heroes and browser-local campaign saves. Separate native-asset Trials remain available in development. Generated assets are **not release-verified**, and this is not a completed or release-ready game.

## Current beta status — 2026-10-17

- **Implemented locally:** Aren, Yara, Vesper and Sakda, their distinct combat kits and native candidate models; camera-relative movement, jump/double jump/air-step, mana dodge, sealed monster trials and waystone stage completion. See [combat](docs/features/combat.md) and [application](docs/features/application.md).
- **Default beta entry:** Title → New Game → hero/companion selection → Begin → native candidate chapter. Continue and Load Game restore browser-local progress at safe checkpoints; saves are isolated from strict production saves. See [application](docs/features/application.md) and the [beta handoff](docs/execution/beta-handoff-2026-10-17.md).
- **Separate development Trials:** map select → hero select → map intro/loading → establishing shot → gameplay. Trials clears do not prove end-to-end story acceptance and do not award campaign rewards or restoration facts.
- **Acceptance limits:** campaign integration, physical reactions, companion support and sampled audio have local implementation and evidence, but the recorded New Game/save scenario does not establish every chapter, ending or hero/companion combination. The [full remediation plan](.opencode/plans/2026-10-14-full-remediation.md) and feature documentation retain sequencing and outstanding acceptance.
- **Release blocked:** generated GLBs are candidates, not verified assets. The user must approve the asset acceptance list before any `evidenceStatus` becomes `verified`; reference-hardware benchmarks and production gates remain required. A passing build or local playtest is not [release acceptance](docs/features/release-validation.md).

The 2026-10-14 design keeps the four heroes, free-form jump, mana dodge and current monsters, and adds the Bible's story bosses **alongside** them. The [Game Design Bible](docs/WILD-CROWN-GAME-DESIGN-BIBLE-CODEX-CLI.md) distinguishes implemented local behavior from planned campaign scope.

The [character VFX proposal](docs/features/character-vfx-proposal.md) is retained for approval only; its proposed upgrade has not been implemented. Publication scope, evidence and remaining limits are recorded in the [beta handoff](docs/execution/beta-handoff-2026-10-17.md).

## Run locally

From the repository root:

```sh
bun install
bun run dev
```

Vite serves `http://127.0.0.1:5173/` with a strict port. If it is already running, use that server rather than starting another. For installation pinned to the existing npm lockfile, use `npm ci` instead of `bun install`; the same package scripts also work with `npm run`.

| URL | Purpose |
|---|---|
| `http://127.0.0.1:5173/` | Beta Title/New Game/Continue/Load Game; candidate story chapters with isolated browser saves and a not-release-verified banner. |
| `http://127.0.0.1:5173/?assetPlaytest=greenwake` | Local candidate Trials selector, Greenwake highlighted. |
| `http://127.0.0.1:5173/?assetPlaytest=canopy` | Whispering Canopy highlighted. |
| `http://127.0.0.1:5173/?assetPlaytest=grove` | The Grove highlighted. |
| `http://127.0.0.1:5173/?assetPlaytest=moonpine` | Moonpine Ridge highlighted. |
| `http://127.0.0.1:5173/?assetPlaytest=mistveil` | Mistveil Basin highlighted. |
| `http://127.0.0.1:5173/lab/` | Separate **Development Greybox** movement/camera lab, not the current combat game. |

`assetPlaytest` is **development-only** and selects separate Trials, not the default candidate-chapter campaign. In Trials, select **New Game**, an unlocked map, then a hero. Only Greenwake starts unlocked; clearing every trial and reaching the exit waystone alive unlocks the next map in Greenwake → Canopy → Grove → Moonpine → Mistveil order. Direct URLs highlight a map but never bypass its lock. Trials retain the **LOCAL PLAYTEST · GENERATED GLB CANDIDATES · NOT RELEASE-VERIFIED** banner and cannot write campaign save slots. The default chapter path retains its own candidate banner and `candidate-chapters` save scope. Source: [SessionConfig.ts](src/app/SessionConfig.ts), [AssetPlaytests.ts](src/app/AssetPlaytests.ts), [application docs](docs/features/application.md#local-story-map-playtests-greenwake-whispering-canopy-the-grove-moonpine-ridge-mistveil-basin).

Blood Bamboo Valley, Sunmane Expanse, The Fall of the Grove, The Living Pact and Heartroot Hollow are **Coming Soon in the separate Trials selector** ([StoryChapters.ts](src/app/StoryChapters.ts)); that selector is not the candidate campaign's acceptance status.

## Heroes, controls and monsters

Default keyboard bindings are configurable except **Space, reserved for Jump**; F is reserved for the default Dodge shortcut, and non-conflicting custom Dodge bindings are retained. Keyboard/gamepad maps are separate. Choose a hero at map entry; retry keeps that hero. Source: [binding policy](src/game/contracts.ts).

| Input | Action |
|---|---|
| WASD / arrow keys | Camera-relative walk |
| Shift + movement | Run (remappable Sprint action) |
| Space | Free-form jump; press again airborne for double jump/air-step |
| F + movement (or last facing) | Dodge: Aren **Dive**, Yara **Petal Step**, Vesper **Mist Blink**, Sakda **Guard Dash** |
| J | Hero's light combo |
| K tap / hold-release | Heavy / charged skill |
| L tap / hold-release | Ranged / charged ranged skill |
| Q | Hero's interrupt ability on eligible windup, or Cleanse on an exposed corrupted target |
| U | Hero's ultimate |
| E | Available authored interaction / contextual traversal |
| T | Explicit lock-on; hold or toggle according to Settings |
| Escape | Pause / resume or close the current panel |

**“Free jump” means no contextual anchor, not zero cost:** Jump costs **8 mana**, and the second jump costs another **8**. Dodge costs **25 mana** for every hero, not dodge charges. Mana is capped at **100**; actual supported Walk/Run movement with input restores **4 mana/metre** (not idle, blocked motion, Dive or airborne Jump). K costs 12/20 mana, L normally 15/35, Q interrupt/Cleanse 20/30, and U consumes 100 Instinct subject to the kit's activation rules. Light chains are free, except Aren's spawned Crescent Wave costs 10 mana; Sakda's echo-mark Resonating Strike recast is free. Funds, cooldowns and recovery still gate activation. Source: [PlayerSkills.ts](src/game/combat/PlayerSkills.ts), [combat/kit rules](docs/features/combat.md).

The default gamepad bindings use **one-based button labels**: Jump = Button 13, Sprint = Button 14, Lock On = Button 16 (standard-layout D-pad Up, Down, Right). Keyboard and gamepad bindings can be changed separately in Settings; an omitted binding remains visibly Unbound. Held controller buttons must be released before they re-arm after blur, hiding the page or disabling gameplay.

Accessibility settings have live consumers: Motion Blur controls impact blur and dodge afterimages; Reduced Camera Shake uses 25% amplitude; Reduced Motion overrides both. Telegraph Intensity, Off-Screen Warning Strength and High-Contrast Target Ring change combat readability without changing hazard geometry. Auto-Target Assist Off disables implicit acquisition; Strong widens acquisition without extending attack range. Explicit lock-on remains available with assist Off. Wide Perfect Dodge adds four invulnerable simulation ticks, capped by the current dodge duration and captured when that dodge starts. See [observed accessibility checks and release limits](docs/features/release-validation.md#accessibility-and-logical-input-verification).

| Hero | Kit identity |
|---|---|
| Aren | Warden glaive, Crescent Wave, storm-lit Sigils, Thunder Cleave and Warden's Judgement |
| Yara | Heartroot staff, homing thorns, roots, Sap Lance/Seed Storm, Binding Vines and Heartroot Bloom |
| Vesper | Moonshade katana, blink/backstab, Death Mark, Thousand Cuts and Crimson Requiem |
| Sakda | Unarmed Muay Thai, Eight Limbs/Flurry, Echo Wave→Resonating Strike, Flying Knee, shielded Guard Dash and Tiger's Wrath |

Source: [hero catalogue](src/game/heroes.ts), [hero profiles and kits](docs/features/combat.md#playable-heroes-profiles-and-the-kit-seam).

| Trials map | Current stage roster |
|---|---|
| Greenwake | Ember Boar, Frost Sap-Stalker, Root Rammer |
| Whispering Canopy | Thornback Howler, Storm Hornbill, Mire Viper |
| The Grove | Heartroot Sprig, Blighted Rootling, Hollowheart |
| Moonpine Ridge | Frostfang Tracker, Howl Scout, Ruun |
| Mistveil Basin | Bog Lurker, Lantern Heron, Ghor |

Roster sources: [CombatTrials.ts](src/game/combat/CombatTrials.ts), [GroveContent.ts](src/game/combat/GroveContent.ts), [MoonpineContent.ts](src/game/combat/MoonpineContent.ts), [MistveilContent.ts](src/game/combat/MistveilContent.ts). Koro, Asha, Ruun, Ghor, Solkar and Orun remain the story bosses. Local Ruun/Ghor Trials do not establish full story-chapter acceptance; the other boss integrations are planned, not substitutions for current monsters.

## Checks and build

These are runnable commands, **not a claim this documentation update executed or passed them**:

```sh
bun run typecheck
bun test $(git ls-files 'tests/**/*.test.ts' 'packages/campaign/test/*.test.ts')
node --test tests/rendering/*.test.mjs tests/release/*.test.mjs tests/asset-lab/*.test.mjs
bun run build
bun run preview
```

Bun runs the TypeScript `bun:test` suite; Node runs the separate native-GLB/rendering/release/asset-lab `.test.mjs` suites. A focused example is `bun test tests/combat/hero-kit-seam.test.ts tests/combat/vesper-kit.test.ts tests/combat/sakda-kit.test.ts`. Preview serves the built app at `http://127.0.0.1:4173/` (build first). Package scripts are defined in [package.json](package.json); routing/ports/build entries in [vite.config.ts](vite.config.ts).

Use explicit TypeScript test paths with Bun: passing the entire `tests/` directory also selects the Node `.test.mjs` suites. The [beta handoff](docs/execution/beta-handoff-2026-10-17.md#publication-checks) records the actual publication results, including the known native-animation assertion failure; these commands are not a claim that every suite is green.

After required evidence and assets exist, `bun run release:validate` checks `dist` strictly, and `bun run release:artifact` packages a validated artifact. These gates are expected to remain blocked while evidence is missing; never promote candidates to make them pass. See [release-validation.md](docs/features/release-validation.md).

Production routing is root-hosted: `/`, `/lab`, `/lab/`; GitHub Pages project-subpath hosting is not supported by the current `base: '/'` build.

## Project structure

| Path | Responsibility |
|---|---|
| `src/main.ts`, `src/app/` | Application composition, lifecycle, local map/hero flow, progress and stage completion |
| `src/content/`, `src/game/heroes.ts` | Authored regions/chapters/quests/dialogue/scene copy and hero catalogue |
| `src/game/combat/`, `src/game/companions/` | Deterministic fixed-step combat, movement/collision, hero kits, Trials and companion authority |
| `src/game/campaign/`, `packages/campaign/`, `src/game/storage/` | Campaign progression/events and persistence |
| `src/rendering/`, `src/effects/`, `src/audio/` | Native asset rendering/camera/animation and presentation-only effects/audio |
| `src/ui/`, `src/input/` | DOM screens, settings, region scenes and mapped keyboard/gamepad input |
| `src/lab/`, `lab/` | Isolated movement greybox |
| `asset-source/`, `public/assets/`, `scripts/assets/` | Source/provenance/candidate manifests, runtime assets and offline asset tooling |
| `tests/`, `scripts/release/`, `evidence/` | Bun/Node coverage, strict release gates and measured evidence |
| `docs/features/`, `docs/production/`, `.opencode/plans/` | Checked feature notes, production planning and current remediation plan |

Simulation owns positions, hit timing, damage and progression; rendering/UI/audio consume it rather than mutating it. Start with the [repository workflow](docs/REPOSITORY-WORKFLOW.md) and [AGENTS.md](AGENTS.md) before contributing. The old lab's ground-only/camera evaluation limits remain documented in [guided-locomotion.md](docs/features/guided-locomotion.md); they are not limits of the current Trials game.
