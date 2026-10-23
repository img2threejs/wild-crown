# Candidate asset acceptance review

**Decision: blocked; no user approval recorded and no evidence status promoted.**

This review covers the seven chapter candidate manifests (Greenwake, Canopy, Bamboo, Grove, Moonpine, Mistveil and Later), including their reused dependencies and hero bindings. It is not a production release certificate. The [exact inventory](../../asset-source/generated/asset-acceptance-inventory.json) records every source manifest, runtime URL, declared and observed hash, provenance pointer and status.

## Identity check

The coordinator remeasured **89 distinct native files / 91 native bindings** against the current seven manifests. All 91 output-hash comparisons matched. Another nine bindings are composed environment recipes, not standalone GLBs. All **100 unique bindings remain blocked**. Matching bytes establishes identity only; it does not establish animation, skinning, visibility, runtime parity, performance or visual acceptance.

## Review groups

- Act I: Koro and Branchbreaker, Asha, Tali, Marek, melee/ranged hunters; Bamboo grove, camp, shrine, trap, cage, extraction rig and filter drum.
- Acts II–IV: Luma, Sable, Nyra, Solkar, Orun human, Crowned Beast and Council Envoy; fourteen later props including the articulated migration gate, bird nest and shared seed/winter supply basket. Ruun and Ghor reuse existing candidates.
- Explicit reuse: unnamed elder/young scouts reuse Sable/Luma; the nursery cub reuses Tali; returning roost hornbills reuse the existing `actor-roost-hornbill` hornbill model (not Vara's harpy). These are not additional paid generations or approvals of new canonical characters. The roost hornbill's in-memory avian animation does not establish native GLTF animation acceptance.
- Existing chapter dependencies and heroes remain listed below so approval cannot accidentally omit shared assets.

## Available visual/runtime evidence

[Later native evidence](../../asset-source/generated/later-native-evidence.json) binds later assets to exact hashes and distinguishes preview, geometry and earned runtime scenarios. [Side-quest evidence](../../asset-source/generated/later-native-sidequests.json) records twelve completed/reloaded optional quests.

- Actors: [native run review](../../asset-source/generated/later-native-run-review.webp), [additional native run review](../../asset-source/generated/later-native-run-review-next.webp).
- Props: [sheet 1](../../asset-source/generated/later-prop-review-1.png), [sheet 2](../../asset-source/generated/later-prop-review-2.png), [sheet 3](../../asset-source/generated/later-prop-review-3.png).
- Actual scenes: [Grove nest/growth](../../asset-source/generated/later-native-grove-growth.png), [seed carry](../../asset-source/generated/later-native-seed-carry.png), [delivery](../../asset-source/generated/later-native-seed-delivered.png), [winter cache](../../asset-source/generated/later-native-winter-cache.png), [pack patrol](../../asset-source/generated/later-native-pack-patrol.png), [Marek assistance](../../asset-source/generated/later-native-marek-assistance.png), [nursery escort](../../asset-source/generated/later-native-nursery-escort.png), [nursery safety](../../asset-source/generated/later-native-nursery-safe.png), [Tali play](../../asset-source/generated/later-native-tali-play.png).

These are bounded candidate observations, not an uninterrupted campaign playthrough, slip-free animation certification or permission to mark assets verified. Historical screenshots must be rebound/reviewed if their underlying GLB changes.

## Acceptance conditions

The [strict release contract](release-validation.md) requires applicable measured G1/G3/G6/G10/G11/G12 gates and detecting negative controls, current-output reviewed visual evidence, native ActionId coverage, composed-recipe component identity, canonical production export and the locked reference benchmark. The existing G11 producer does not yet establish the required derivative-freeze runtime parity. Current candidate manifests and the canonical production manifest are intentionally not promoted by this inventory.

User visual approval is a separate required decision, bound to asset IDs and the exact hashes below. Approval alone cannot waive a failed automated gate, missing native animation or absent reference-hardware evidence. Only assets satisfying both technical gates and explicit user approval may become verified.

Generation accounting remains **4,105 / 5,000 credits**, including the conservative prior reservation and 115 each for the nest and basket; 895 remaining is not authorization for further generation.

## Exact review list

Hashes below are 12-character display prefixes; the linked JSON contains the full observed SHA-256. Each row remains **blocked / not approved**. Native links point to the measured file, not a concept image.

| Asset | Candidate manifests | Observed SHA-256 prefix |
|---|---|---|
| [actor-aren](../../asset-source/generated/actor-aren-user-supplied-01/aren-playtest-animated.glb) | greenwake, canopy, bamboo, grove, moonpine, mistveil | `5e0c3b5f843e` |
| [actor-asha](../../asset-source/generated/actor-asha-runtime-01/actor-asha-companion.glb) | bamboo | `6d6abe449158` |
| [actor-bog-lurker](../../asset-source/generated/actor-bog-lurker-runtime-01/actor-bog-lurker-combat.glb) | mistveil | `23d50ccb7040` |
| [actor-camp-hunter-melee](../../asset-source/generated/actor-camp-hunter-melee-runtime-01/actor-camp-hunter-melee-combat.glb) | bamboo | `0280b9fac471` |
| [actor-camp-hunter-ranged](../../asset-source/generated/actor-camp-hunter-ranged-runtime-01/actor-camp-hunter-ranged-combat.glb) | bamboo | `652fb2bd389c` |
| [actor-council-envoy](../../asset-source/generated/actor-council-envoy-runtime-01/actor-council-envoy-animated.glb) | later | `21b797cf6b26` |
| [actor-ember-boar](../../asset-source/generated/actor-ember-boar-runtime-01/actor-ember-boar-combat.glb) | greenwake | `44694ec9e198` |
| [actor-frost-sap-stalker](../../asset-source/generated/actor-frost-sap-stalker-runtime-01/actor-frost-sap-stalker-combat.glb) | greenwake | `a8754840ce9d` |
| [actor-frostfang-tracker](../../asset-source/generated/actor-frostfang-tracker-runtime-01/actor-frostfang-tracker-animated.glb) | moonpine | `807af505c747` |
| [actor-ghor-mire-maw](../../asset-source/generated/actor-ghor-mire-maw-runtime-01/actor-ghor-mire-maw-combat.glb) | mistveil | `d950191ec41f` |
| [actor-grove-blighted-rootling](../../asset-source/generated/actor-grove-blighted-rootling-runtime-01/actor-grove-blighted-rootling-combat.glb) | grove | `952cab27ed53` |
| [actor-grove-hollowheart](../../asset-source/generated/actor-grove-hollowheart-runtime-01/actor-grove-hollowheart-combat.glb) | grove | `33c647f92f0c` |
| [actor-grove-rootling](../../asset-source/generated/actor-grove-rootling-runtime-01/actor-grove-rootling-combat.glb) | grove | `1b31d6fb84bd` |
| [actor-howl-scout](../../asset-source/generated/actor-howl-scout-runtime-01/actor-howl-scout-combat.glb) | moonpine | `ca155e520e95` |
| [actor-koro](../../asset-source/generated/actor-koro-runtime-01/actor-koro-companion.glb) | bamboo, grove | `ecabfa4dee27` |
| [actor-koro-branchbreaker](../../asset-source/generated/actor-koro-branchbreaker-runtime-01/actor-koro-branchbreaker-combat.glb) | bamboo | `551ed622df5a` |
| [actor-lantern-heron](../../asset-source/generated/actor-lantern-heron-runtime-01/actor-lantern-heron-combat.glb) | mistveil | `2834895a954d` |
| [actor-luma](../../asset-source/generated/actor-luma-runtime-01/actor-luma-animated.glb) | later | `c07563e5a027` |
| [actor-marek](../../asset-source/generated/actor-marek-runtime-01/actor-marek-animated.glb) | bamboo | `0f0dbd0f500f` |
| [actor-mire-viper](../../asset-source/generated/actor-mire-viper-runtime-01/actor-mire-viper-combat.glb) | canopy | `33c412ced3c9` |
| [actor-nursery-cub](../../asset-source/generated/actor-tali-runtime-01/actor-tali-animated.glb) | bamboo | `ebab423d6f23` |
| [actor-nyra](../../asset-source/generated/actor-nyra-runtime-01/actor-nyra-companion.glb) | later | `b8bd183a145e` |
| [actor-orun](../../asset-source/generated/actor-orun-runtime-01/actor-orun-combat.glb) | later | `57692ab870be` |
| [actor-orun-crowned-beast](../../asset-source/generated/actor-orun-crowned-beast-runtime-01/actor-orun-crowned-beast-combat.glb) | later | `e0c491bc32f2` |
| [actor-ridge-elder-scout](../../asset-source/generated/actor-sable-runtime-01/actor-sable-animated.glb) | later | `b5e9cdc82a99` |
| [actor-ridge-young-scout](../../asset-source/generated/actor-luma-runtime-01/actor-luma-animated.glb) | later | `c07563e5a027` |
| [actor-roost-hornbill](../../asset-source/generated/actor-vara-rig-01/tripo-out/actor-vara-rig-01-a60d75d8/model.glb) | later | `82abb2b3c61f` |
| [actor-root-rammer](../../asset-source/generated/actor-root-rammer-runtime-01/actor-root-rammer-combat.glb) | greenwake | `610ea44f952d` |
| [actor-ruun-chained-howl](../../asset-source/generated/actor-ruun-chained-howl-runtime-01/actor-ruun-chained-howl-combat.glb) | moonpine | `c3638ece7b1e` |
| [actor-sable](../../asset-source/generated/actor-sable-runtime-01/actor-sable-companion.glb) | later | `cae7c51ecd62` |
| [actor-sakda-hero](../../asset-source/generated/actor-sakda-hero-01/sakda-hero-animated.glb) | greenwake, canopy, bamboo, grove, moonpine, mistveil | `b9f57e6fa6d6` |
| [actor-solkar](../../asset-source/generated/actor-solkar-runtime-01/actor-solkar-companion.glb) | later | `eec7b5cd8f37` |
| [actor-storm-hornbill](../../asset-source/generated/actor-storm-hornbill-runtime-01/actor-storm-hornbill-combat.glb) | canopy | `f855207319ab` |
| [actor-tali](../../asset-source/generated/actor-tali-runtime-01/actor-tali-animated.glb) | bamboo | `ebab423d6f23` |
| [actor-thornback-howler](../../asset-source/generated/actor-thornback-howler-runtime-01/actor-thornback-howler-combat.glb) | canopy | `903522689dd4` |
| [actor-vara](../../asset-source/generated/actor-vara-harpy-runtime-01/actor-vara-harpy-companion.glb) | greenwake, canopy, bamboo, grove, moonpine | `036b3c562277` |
| [actor-vesper-hero](../../asset-source/generated/actor-vesper-hero-01/vesper-hero-animated.glb) | greenwake, canopy, bamboo, grove, moonpine, mistveil | `60f43cba4932` |
| [actor-yara](../../asset-source/generated/actor-yara-runtime-01/actor-yara.glb) | greenwake | `bd8c0ae132f3` |
| [actor-yara-hero](../../asset-source/generated/actor-yara-hero-01/yara-hero-animated.glb) | greenwake, canopy, bamboo, grove, moonpine, mistveil | `69f57ecda919` |
| `blood-bamboo-valley-environment` | bamboo | Composed recipe |
| `greenwake-environment` | greenwake | Composed recipe |
| `heartroot-hollow-environment` | later | Composed recipe |
| `mistveil-basin-environment` | mistveil | Composed recipe |
| `moonpine-ridge-environment` | moonpine | Composed recipe |
| [prop-ancient-bamboo-shrine](../../asset-source/generated/prop-ancient-bamboo-shrine-runtime-01/prop-ancient-bamboo-shrine.glb) | bamboo | `e0e878844674` |
| [prop-ancient-canopy-shrine](../../asset-source/generated/prop-ancient-canopy-shrine-runtime-01/prop-ancient-canopy-shrine.glb) | canopy, grove | `af21b7f71879` |
| [prop-bamboo-grove-cluster](../../asset-source/generated/prop-bamboo-grove-cluster-runtime-01/prop-bamboo-grove-cluster.glb) | bamboo | `a6d9d3beeeb8` |
| [prop-bird-nest](../../asset-source/generated/prop-bird-nest-runtime-01/prop-bird-nest.glb) | later | `737efa48e650` |
| [prop-black-sap-filter-drum](../../asset-source/generated/prop-black-sap-filter-drum-runtime-01/prop-black-sap-filter-drum.glb) | bamboo, mistveil | `88b46c9f4a9d` |
| [prop-black-sap-jaw-trap](../../asset-source/generated/prop-black-sap-jaw-trap-runtime-01/prop-black-sap-jaw-trap.glb) | bamboo | `3fe666616a29` |
| [prop-buried-wolf-temple](../../asset-source/generated/prop-buried-wolf-temple-runtime-01/prop-buried-wolf-temple.glb) | moonpine | `da4eee96e452` |
| [prop-canopy-cliff-rock](../../asset-source/generated/prop-canopy-cliff-rock-runtime-01/prop-canopy-cliff-rock.glb) | canopy, bamboo, grove | `947c088b727c` |
| [prop-canopy-fern-cluster](../../asset-source/generated/prop-canopy-fern-cluster-runtime-01/prop-canopy-fern-cluster.glb) | canopy, bamboo, grove | `e3296cb5527a` |
| [prop-erya-edge-tree](../../asset-source/generated/prop-erya-edge-tree-runtime-01/prop-erya-edge-tree.glb) | greenwake, bamboo, grove | `b853dbbd3ddb` |
| [prop-greenwake-boulder-cluster](../../asset-source/generated/prop-greenwake-boulder-cluster-runtime-01/prop-greenwake-boulder-cluster.glb) | greenwake, bamboo, grove | `ba9a07310cd7` |
| [prop-greenwake-bramble-wall](../../asset-source/generated/prop-greenwake-bramble-wall-runtime-01/prop-greenwake-bramble-wall.glb) | greenwake, bamboo | `078858fc2aee` |
| [prop-greenwake-houses](../../asset-source/generated/prop-greenwake-houses-runtime-01/prop-greenwake-houses.glb) | greenwake | `8fa4ef9ac707` |
| [prop-greenwake-root-gate](../../asset-source/generated/prop-greenwake-root-gate-runtime-01/prop-greenwake-root-gate.glb) | greenwake, canopy, bamboo, grove, moonpine, mistveil | `c6574067dd00` |
| [prop-greenwake-rope-bridge](../../asset-source/generated/prop-greenwake-rope-bridge-decimate-01/tripo-out/prop-greenwake-rope-bridge-decim-600bf410/model.glb) | greenwake, bamboo | `1a2b2d973050` |
| [prop-grove-platform](../../asset-source/generated/prop-grove-platform-runtime-01/prop-grove-platform.glb) | grove | `b969c577f56c` |
| [prop-heartroot-focus-staff](../../asset-source/generated/prop-yara-c-staff-01/model.glb) | greenwake, canopy, bamboo, grove, moonpine, mistveil | `b0b8c9e289af` |
| [prop-heartroot-fragment-stone](../../asset-source/generated/prop-heartroot-fragment-stone-runtime-01/prop-heartroot-fragment-stone.glb) | later | `1d8ff4a75c58` |
| [prop-heartroot-root-column](../../asset-source/generated/prop-heartroot-root-column-runtime-01/prop-heartroot-root-column.glb) | later | `99de3cbd5798` |
| [prop-heartroot-trunk](../../asset-source/generated/prop-heartroot-trunk-runtime-01/prop-heartroot-trunk.glb) | grove | `6c9361728819` |
| [prop-hollow-cavern-rock](../../asset-source/generated/prop-hollow-cavern-rock-runtime-01/prop-hollow-cavern-rock.glb) | later | `a75f5a0d3fe7` |
| [prop-hunter-cage](../../asset-source/generated/prop-hunter-cage-runtime-01/prop-hunter-cage.glb) | greenwake, bamboo | `9ce908d106e1` |
| [prop-hunter-camp](../../asset-source/generated/prop-hunter-camp-runtime-01/prop-hunter-camp.glb) | bamboo | `43592898cc2a` |
| [prop-hunter-extraction-rig](../../asset-source/generated/prop-hunter-extraction-rig-runtime-01/prop-hunter-extraction-rig.glb) | bamboo, mistveil | `3e7edc383ad9` |
| [prop-map-table](../../asset-source/generated/prop-map-table-runtime-01/prop-map-table.glb) | later | `924e1281730d` |
| [prop-migration-gate](../../asset-source/generated/prop-migration-gate-runtime-01/prop-migration-gate-articulated.glb) | later | `77f37b77b7b6` |
| [prop-mire-bank-rock](../../asset-source/generated/prop-mire-bank-rock-runtime-01/prop-mire-bank-rock.glb) | greenwake, canopy, bamboo, grove, moonpine, mistveil | `da90e23c3f4f` |
| [prop-mistveil-reed-cluster](../../asset-source/generated/prop-mistveil-reed-cluster-runtime-01/prop-mistveil-reed-cluster.glb) | mistveil | `94240be12432` |
| [prop-mistveil-root-tree](../../asset-source/generated/prop-mistveil-root-tree-runtime-01/prop-mistveil-root-tree.glb) | mistveil | `9571b6523579` |
| [prop-moonpine-log-bridge](../../asset-source/generated/prop-moonpine-log-bridge-runtime-01/prop-moonpine-log-bridge.glb) | moonpine | `317acf6610f4` |
| [prop-moonpine-tree](../../asset-source/generated/prop-moonpine-tree-runtime-01/prop-moonpine-tree.glb) | moonpine | `ca44a540c63f` |
| [prop-plains-stone-arch](../../asset-source/generated/prop-plains-stone-arch-runtime-01/prop-plains-stone-arch.glb) | later | `a36819ac2d46` |
| [prop-rainforest-canopy-tree](../../asset-source/generated/prop-rainforest-canopy-tree-runtime-01/prop-rainforest-canopy-tree.glb) | canopy, bamboo | `db9347f79497` |
| [prop-refuge-shelter](../../asset-source/generated/prop-refuge-shelter-runtime-01/prop-refuge-shelter.glb) | grove | `2758244c4cbe` |
| [prop-root-arch](../../asset-source/generated/prop-root-arch-runtime-01/prop-root-arch.glb) | greenwake, bamboo | `e12209f48c7d` |
| [prop-root-cavern-mouth](../../asset-source/generated/prop-root-cavern-mouth-runtime-01/prop-root-cavern-mouth.glb) | bamboo, grove, mistveil | `57fd3a6f8ded` |
| [prop-root-crown-altar](../../asset-source/generated/prop-root-crown-altar-runtime-01/prop-root-crown-altar.glb) | later | `bbabd257d859` |
| [prop-root-tether-anchor](../../asset-source/generated/prop-root-tether-anchor-runtime-01/prop-root-tether-anchor.glb) | later | `74aee811ab2e` |
| [prop-savanna-acacia](../../asset-source/generated/prop-savanna-acacia-runtime-01/prop-savanna-acacia.glb) | later | `a31bf1c7c663` |
| [prop-seed-supply-basket](../../asset-source/generated/prop-seed-supply-basket-runtime-01/prop-seed-supply-basket.glb) | later | `93ce0dbcc351` |
| [prop-six-fragment-shrine](../../asset-source/generated/prop-six-fragment-shrine-runtime-01/prop-six-fragment-shrine.glb) | later | `30fde41fd063` |
| [prop-snow-ridge-rock](../../asset-source/generated/prop-snow-ridge-rock-runtime-01/prop-snow-ridge-rock.glb) | moonpine | `95db97be2a4d` |
| [prop-sunmane-stone-terrace](../../asset-source/generated/prop-sunmane-stone-terrace-runtime-01/prop-sunmane-stone-terrace.glb) | later | `fc1108a8201e` |
| [prop-temple-chain-anchor](../../asset-source/generated/prop-temple-chain-anchor-runtime-01/prop-temple-chain-anchor.glb) | moonpine | `9136661aa7b2` |
| [prop-training-post](../../asset-source/generated/prop-training-post-runtime-01/prop-training-post.glb) | grove | `4861706514b3` |
| [prop-vesper-katana](../../asset-source/generated/prop-vesper-katana-runtime-02/prop-vesper-katana.glb) | greenwake, canopy, bamboo, grove, moonpine, mistveil | `23e9653aacd5` |
| [prop-vine-bridge](../../asset-source/generated/prop-vine-bridge-runtime-02/prop-vine-bridge.glb) | canopy | `a5b2438381e3` |
| [prop-warden-glaive](../../asset-source/generated/prop-warden-glaive-runtime-01/prop-warden-glaive.glb) | greenwake, canopy, bamboo, grove, moonpine, mistveil | `47ec712cadbc` |
| [prop-warden-waystone](../../asset-source/generated/prop-warden-waystone-runtime-01/prop-warden-waystone.glb) | greenwake, canopy, bamboo, grove, moonpine, mistveil | `831be2fcdf64` |
| [prop-water-allotment-gate](../../asset-source/generated/prop-water-allotment-gate-runtime-01/prop-water-allotment-gate.glb) | later | `95438d07e9f1` |
| [prop-water-basin](../../asset-source/generated/prop-water-basin-runtime-01/prop-water-basin.glb) | grove | `b8fa40523474` |
| [prop-wooden-crate-stack](../../asset-source/generated/prop-wooden-crate-stack-runtime-01/prop-wooden-crate-stack.glb) | greenwake | `adff6b71619d` |
| `refuge-environment` | later | Composed recipe |
| `sunmane-expanse-environment` | later | Composed recipe |
| `the-grove-environment` | grove | Composed recipe |
| `whispering-canopy-environment` | canopy | Composed recipe |
