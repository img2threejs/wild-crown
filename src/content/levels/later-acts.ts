import { v, type RegionDefinition } from "./schema.js";
import { dressLaterRegion } from "./later-region-dressing.js";
import { flat } from "./layout-kit.js";
import { buildLaterWalkways } from "./later-walkways.js";

export const LATER_ACT_REGION_AUTHORING_STATUS = "unaccepted" as const;
type RegionContentSeed = Pick<RegionDefinition, "id" | "authoringStatus" | "name" | "biome" | "bounds" | "environmentRecipeId" | "props" | "entities" | "encounterIds" | "encounterParticipants" | "restorationStates" | "assetIds">;
const BASE_LATER_ACT_REGIONS = [
  {
    "id": "moonpine-ridge",
    "authoringStatus": "unaccepted",
    "name": "Moonpine Ridge",
    "biome": "Snowy pine ridges and buried temple",
    "bounds": {
      "min": v(-85, -5, -65),
      "max": v(85, 44, 65)
    },
    "environmentRecipeId": "moonpine-ridge-environment",
    "props": [
      {
        "id": "moonpine-ridge-placement-0",
        "assetId": "prop-moonpine-tree",
        "position": v(-26, 0, 16),
        "rotationY": 0.3,
        "scale": v(1.7, 1.7, 1.7),
        "placement": "ground"
      },
      {
        "id": "moonpine-ridge-placement-1",
        "assetId": "prop-buried-wolf-temple",
        "position": v(18, 0, -15),
        "rotationY": 0,
        "scale": v(0.7, 0.7, 0.7),
        "placement": "ground"
      },
      {
        "id": "moonpine-ridge-placement-2",
        "assetId": "prop-temple-chain-anchor",
        "position": v(8, 0, -8),
        "rotationY": 0,
        "scale": v(0.8, 0.8, 0.8),
        "placement": "ground"
      },
      {
        "id": "moonpine-ridge-placement-3",
        "assetId": "prop-snow-ridge-rock",
        "position": v(-4, 2, 3),
        "rotationY": 0.4,
        "scale": v(1.3, 1.3, 1.3),
        "placement": "ground"
      },
      {
        "id": "moonpine-ridge-placement-4",
        "assetId": "prop-moonpine-log-bridge",
        "position": v(24, 3, 12),
        "rotationY": 0.1,
        "scale": v(1, 1, 1),
        "placement": "elevated"
      }
    ],
    "entities": [
      {
        "id": "ruun",
        "actorId": "ruun",
        "kind": "actor",
        "position": v(-8, 0, 2),
        "assetId": "actor-ruun",
        "placement": "ground",
        "visibleWhen": undefined
      },
      {
        "id": "luma",
        "actorId": "luma",
        "kind": "actor",
        "position": v(-4, 0, 4),
        "assetId": "actor-luma",
        "placement": "ground",
        "visibleWhen": undefined
      },
      {
        "id": "sable",
        "actorId": "sable",
        "kind": "actor",
        "position": v(0, 0, 6),
        "assetId": "actor-sable",
        "placement": "ground",
        "visibleWhen": undefined
      },
      {
        "id": "three-beat-howl",
        "kind": "interaction",
        "position": v(-6, 0, 1),
        "placement": "ground",
        "interactionId": "three-beat-howl"
      },
      {
        "id": "pack-pup-shelter",
        "kind": "interaction",
        "position": v(-3, 0, 1),
        "placement": "ground",
        "interactionId": "pack-pup-shelter"
      },
      {
        "id": "temple-restraints",
        "kind": "interaction",
        "position": v(0, 0, 1),
        "placement": "ground",
        "interactionId": "temple-restraints"
      },
      {
        "id": "pack-settlement",
        "kind": "interaction",
        "position": v(3, 0, 1),
        "placement": "ground",
        "interactionId": "pack-settlement"
      },
      {
        "id": "pack-fragment",
        "kind": "interaction",
        "position": v(6, 0, 1),
        "placement": "ground",
        "interactionId": "pack-fragment"
      },
      {
        "id": "howl-one-place",
        "kind": "interaction",
        "position": v(-70, 0, -42),
        "placement": "ground",
        "interactionId": "howl-one"
      },
      {
        "id": "howl-two-place",
        "kind": "interaction",
        "position": v(-50, 3, -28),
        "placement": "ground",
        "interactionId": "howl-two"
      },
      {
        "id": "howl-three-place",
        "kind": "interaction",
        "position": v(-25, 8, -8),
        "placement": "ground",
        "interactionId": "howl-three"
      },
      {
        "id": "pack-pups-place",
        "kind": "interaction",
        "position": v(-36, 3, -22),
        "placement": "ground",
        "interactionId": "pack-pups"
      },
      {
        "id": "winter-stores-place",
        "kind": "interaction",
        "position": v(-22, 8, 2),
        "placement": "ground",
        "interactionId": "winter-stores"
      },
      {
        "id": "pack-scouts-place",
        "kind": "interaction",
        "position": v(-10, 8, 6),
        "placement": "ground",
        "interactionId": "pack-scouts"
      },
      {
        "id": "temple-route-place",
        "kind": "interaction",
        "position": v(-5, 8, -2),
        "placement": "ground",
        "interactionId": "temple-route"
      },
      {
        "id": "two-generation-howl-place",
        "kind": "interaction",
        "position": v(15, 13, 6),
        "placement": "ground",
        "interactionId": "two-generation-howl"
      },
      {
        "id": "moonpine-restoration",
        "kind": "interaction",
        "position": v(-20, 8, -3),
        "placement": "elevated",
        "interactionId": "moonpine-restoration"
      },
      {
        "id": "one-howl-two-generations-place",
        "kind": "interaction",
        "position": v(10, 13, 3),
        "placement": "ground",
        "interactionId": "one-howl-two-generations"
      }
    ],
    "encounterIds": [
      "encounter-ruun"
    ],
    "encounterParticipants": {
      "encounter-ruun": [
        "ruun"
      ]
    },
    "restorationStates": [
      "unvisited",
      "corrupted",
      "partial",
      "restored"
    ],
    "assetIds": [
      "actor-ruun",
      "actor-luma",
      "actor-sable",
      "prop-moonpine-tree",
      "prop-buried-wolf-temple",
      "prop-temple-chain-anchor",
      "prop-snow-ridge-rock",
      "prop-moonpine-log-bridge"
    ]
  },
  {
    "id": "mistveil-basin",
    "authoringStatus": "unaccepted",
    "name": "Mistveil Basin",
    "biome": "Mist wetland, black river and half-submerged arena",
    "bounds": {
      "min": v(-90, -8, -75),
      "max": v(90, 20, 75)
    },
    "environmentRecipeId": "mistveil-basin-environment",
    "props": [
      {
        "id": "mistveil-basin-placement-0",
        "assetId": "prop-mistveil-reed-cluster",
        "position": v(-24, 0, 15),
        "rotationY": 0.3,
        "scale": v(1.4, 1.4, 1.4),
        "placement": "water-edge"
      },
      {
        "id": "mistveil-basin-placement-1",
        "assetId": "prop-hunter-extraction-rig",
        "position": v(16, 0, -12),
        "rotationY": 0.7,
        "scale": v(1, 1, 1),
        "placement": "ground"
      },
      {
        "id": "mistveil-basin-placement-2",
        "assetId": "prop-mire-bank-rock",
        "position": v(4, 0, 18),
        "rotationY": 0,
        "scale": v(1.2, 1.2, 1.2),
        "placement": "water-edge"
      },
      {
        "id": "mistveil-basin-placement-3",
        "assetId": "prop-root-cavern-mouth",
        "position": v(-10, 0, -20),
        "rotationY": 0.2,
        "scale": v(1.3, 1.3, 1.3),
        "placement": "ground"
      },
      {
        "id": "mistveil-basin-placement-4",
        "assetId": "prop-black-sap-filter-drum",
        "position": v(20, 0, -4),
        "rotationY": 0,
        "scale": v(0.9, 0.9, 0.9),
        "placement": "ground"
      }
    ],
    "entities": [
      {
        "id": "nyra",
        "actorId": "nyra",
        "kind": "actor",
        "position": v(-8, 0, 2),
        "assetId": "actor-nyra",
        "placement": "ground",
        "visibleWhen": undefined
      },
      {
        "id": "ghor",
        "actorId": "ghor",
        "kind": "actor",
        "position": v(-4, 0, 4),
        "assetId": "actor-ghor",
        "placement": "ground",
        "visibleWhen": undefined
      },
      {
        "id": "marek",
        "actorId": "marek",
        "kind": "actor",
        "position": v(0, 0, 6),
        "assetId": "actor-marek",
        "placement": "ground",
        "visibleWhen": "marekPresent"
      },
      {
        "id": "mist-tracks",
        "kind": "interaction",
        "position": v(-6, 0, 1),
        "placement": "ground",
        "interactionId": "mist-tracks"
      },
      {
        "id": "nyra-reveal-hidden-route",
        "kind": "interaction",
        "position": v(-8, 0, 2),
        "placement": "ground",
        "interactionId": "nyra-reveal-hidden-route"
      },
      {
        "id": "marek-choice",
        "kind": "interaction",
        "position": v(0, 0, 1),
        "placement": "ground",
        "interactionId": "marek-choice"
      },
      {
        "id": "river-source",
        "kind": "interaction",
        "position": v(3, 0, 1),
        "placement": "ground",
        "interactionId": "river-source"
      },
      {
        "id": "ghor-cleanse",
        "kind": "interaction",
        "position": v(6, 0, 1),
        "placement": "ground",
        "interactionId": "ghor-cleanse"
      },
      {
        "id": "shadow-fragment",
        "kind": "interaction",
        "position": v(9, 0, 1),
        "placement": "ground",
        "interactionId": "shadow-fragment"
      },
      {
        "id": "mistveil-hidden-route-marker",
        "kind": "landmark",
        "position": v(-42, 0, 32),
        "placement": "ground",
        "visibleWhen": "mistveil_nyra_hidden_route"
      },
      {
        "id": "mist-eyes-place",
        "kind": "interaction",
        "position": v(-58, 0, -22),
        "placement": "ground",
        "interactionId": "mist-eyes"
      },
      {
        "id": "reed-track-place",
        "kind": "interaction",
        "position": v(-44, 0, -16),
        "placement": "ground",
        "interactionId": "reed-track"
      },
      {
        "id": "infection-evidence-place",
        "kind": "interaction",
        "position": v(-36, 0, -8),
        "placement": "ground",
        "interactionId": "infection-evidence"
      },
      {
        "id": "nyra-truth-place",
        "kind": "interaction",
        "position": v(-52, 0, -20),
        "placement": "ground",
        "interactionId": "nyra-truth"
      },
      {
        "id": "river-upstream-place",
        "kind": "interaction",
        "position": v(-20, 1, -18),
        "placement": "water",
        "interactionId": "river-upstream"
      },
      {
        "id": "marek-rig-place",
        "kind": "interaction",
        "position": v(8, 0, -3),
        "placement": "ground",
        "interactionId": "marek-rig"
      },
      {
        "id": "field-ledger-place",
        "kind": "interaction",
        "position": v(11, 0, 1),
        "placement": "ground",
        "interactionId": "field-ledger"
      },
      {
        "id": "river-route-choice-place",
        "kind": "interaction",
        "position": v(20, 0, 4),
        "placement": "ground",
        "interactionId": "river-route-choice"
      },
      {
        "id": "polluted-source-place",
        "kind": "interaction",
        "position": v(28, 0, 8),
        "placement": "ground",
        "interactionId": "polluted-source"
      },
      {
        "id": "mistveil-restoration-place",
        "kind": "interaction",
        "position": v(28, 0, 8),
        "placement": "ground",
        "interactionId": "mistveil-restoration"
      },
      {
        "id": "reed-corridor-place",
        "kind": "interaction",
        "position": v(-30, 1, 0),
        "placement": "ground",
        "interactionId": "reed-corridor"
      },
      {
        "id": "witness-in-the-reeds-place",
        "kind": "interaction",
        "position": v(-58, 0, -18),
        "placement": "ground",
        "interactionId": "witness-in-the-reeds"
      }
    ],
    "encounterIds": [
      "encounter-ghor"
    ],
    "encounterParticipants": {
      "encounter-ghor": [
        "ghor"
      ]
    },
    "restorationStates": [
      "unvisited",
      "corrupted",
      "partial",
      "restored"
    ],
    "assetIds": [
      "actor-nyra",
      "actor-ghor",
      "actor-marek",
      "prop-mistveil-reed-cluster",
      "prop-hunter-extraction-rig",
      "prop-mire-bank-rock",
      "prop-root-cavern-mouth",
      "prop-black-sap-filter-drum"
    ]
  },
  {
    "id": "sunmane-expanse",
    "authoringStatus": "unaccepted",
    "name": "Sunmane Expanse",
    "biome": "Open grassland and lion terraces",
    "bounds": {
      "min": v(-100, -2, -80),
      "max": v(100, 28, 80)
    },
    "environmentRecipeId": "sunmane-expanse-environment",
    "props": [
      {
        "id": "sunmane-expanse-placement-0",
        "assetId": "prop-sunmane-stone-terrace",
        "position": v(16, 0, -8),
        "rotationY": 0,
        "scale": v(1.4, 1.4, 1.4),
        "placement": "elevated"
      },
      {
        "id": "sunmane-expanse-placement-1",
        "assetId": "prop-migration-gate",
        "position": v(-18, 0, 12),
        "rotationY": Math.PI / 2,
        "scale": v(1, 1, 1),
        "placement": "ground"
      },
      {
        "id": "sunmane-expanse-placement-2",
        "assetId": "prop-water-allotment-gate",
        "position": v(8, 0, 16),
        "rotationY": 0.2,
        "scale": v(1, 1, 1),
        "placement": "water-edge"
      },
      {
        "id": "sunmane-expanse-placement-3",
        "assetId": "prop-plains-stone-arch",
        "position": v(-2, 0, -22),
        "rotationY": 0.3,
        "scale": v(1.2, 1.2, 1.2),
        "placement": "ground"
      },
      {
        "id": "sunmane-expanse-placement-4",
        "assetId": "prop-savanna-acacia",
        "position": v(28, 0, 24),
        "rotationY": 0.5,
        "scale": v(1.4, 1.4, 1.4),
        "placement": "ground"
      }
    ],
    "entities": [
      {
        "id": "solkar",
        "actorId": "solkar",
        "kind": "actor",
        "position": v(-8, 0, 2),
        "assetId": "actor-solkar",
        "placement": "ground",
        "visibleWhen": "solkarPresent"
      },
      {
        "id": "council-envoy",
        "actorId": "council-envoy",
        "kind": "actor",
        "position": v(-4, 0, 4),
        "assetId": "actor-council-envoy",
        "placement": "ground",
        "visibleWhen": undefined
      },
      {
        "id": "silent-crossing",
        "kind": "interaction",
        "position": v(-6, 0, 1),
        "placement": "ground",
        "interactionId": "silent-crossing"
      },
      {
        "id": "tribute-record",
        "kind": "interaction",
        "position": v(-3, 0, 1),
        "placement": "ground",
        "interactionId": "tribute-record"
      },
      {
        "id": "solkar-offer",
        "kind": "interaction",
        "position": v(0, 0, 1),
        "placement": "ground",
        "interactionId": "solkar-offer"
      },
      {
        "id": "crown-council",
        "kind": "interaction",
        "position": v(3, 0, 1),
        "placement": "ground",
        "interactionId": "crown-council"
      },
      {
        "id": "crown-fragment",
        "kind": "interaction",
        "position": v(6, 0, 1),
        "placement": "ground",
        "interactionId": "crown-fragment"
      },
      {
        "id": "herd-route-place",
        "kind": "interaction",
        "position": v(-32, 2, -22),
        "placement": "ground",
        "interactionId": "herd-route"
      },
      {
        "id": "herd-testimony-place",
        "kind": "interaction",
        "position": v(-22, 5, -10),
        "placement": "ground",
        "interactionId": "herd-testimony"
      },
      {
        "id": "tribute-ledger-place",
        "kind": "interaction",
        "position": v(-12, 5, -9),
        "placement": "ground",
        "interactionId": "tribute-ledger"
      },
      {
        "id": "solkar-echo-place",
        "kind": "interaction",
        "position": v(49, 9, 4),
        "placement": "ground",
        "interactionId": "solkar-echo"
      },
      {
        "id": "open-crossing-place",
        "kind": "interaction",
        "position": v(-20, 2, -18),
        "placement": "ground",
        "interactionId": "open-crossing"
      },
      {
        "id": "sunmane-restoration",
        "kind": "interaction",
        "position": v(-8, 5, -9),
        "placement": "elevated",
        "interactionId": "sunmane-restoration"
      },
      {
        "id": "the-open-crossing-place",
        "kind": "interaction",
        "position": v(-12, 5, -9),
        "placement": "ground",
        "interactionId": "the-open-crossing"
      }
    ],
    "encounterIds": [
      "encounter-solkar"
    ],
    "encounterParticipants": {
      "encounter-solkar": [
        "solkar"
      ]
    },
    "restorationStates": [
      "unvisited",
      "corrupted",
      "partial",
      "restored"
    ],
    "assetIds": [
      "actor-solkar",
      "actor-council-envoy",
      "prop-sunmane-stone-terrace",
      "prop-migration-gate",
      "prop-water-allotment-gate",
      "prop-plains-stone-arch",
      "prop-savanna-acacia"
    ]
  },
  {
    "id": "refuge",
    "authoringStatus": "unaccepted",
    "name": "The Refuge",
    "biome": "Protected sanctuary preserving Grove services",
    "bounds": {
      "min": v(-32, -4, -28),
      "max": v(32, 20, 34)
    },
    "environmentRecipeId": "refuge-environment",
    "props": [
      {
        "id": "refuge-placement-0",
        "assetId": "prop-refuge-shelter",
        "position": v(-12, 0, -5),
        "rotationY": 0,
        "scale": v(1.1, 1.1, 1.1),
        "placement": "ground"
      },
      {
        "id": "refuge-placement-1",
        "assetId": "prop-map-table",
        "position": v(0, 0, 2),
        "rotationY": 0,
        "scale": v(0.8, 0.8, 0.8),
        "placement": "ground"
      },
      {
        "id": "refuge-placement-2",
        "assetId": "prop-training-post",
        "position": v(14, 0, 12),
        "rotationY": 0.1,
        "scale": v(0.9, 0.9, 0.9),
        "placement": "ground"
      },
      {
        "id": "refuge-placement-3",
        "assetId": "prop-heartroot-fragment-stone",
        "position": v(-5, 0, 18),
        "rotationY": 0,
        "scale": v(0.8, 0.8, 0.8),
        "placement": "ground"
      }
    ],
    "entities": [
      {
        "id": "yara",
        "actorId": "yara",
        "kind": "actor",
        "position": v(-8, 0, 2),
        "assetId": "actor-yara",
        "placement": "ground",
        "visibleWhen": undefined
      },
      {
        "id": "vara",
        "actorId": "vara",
        "kind": "actor",
        "position": v(-4, 0, 4),
        "assetId": "actor-vara",
        "placement": "ground",
        "visibleWhen": undefined
      },
      {
        "id": "tali",
        "actorId": "tali",
        "kind": "actor",
        "position": v(0, 0, 6),
        "assetId": "actor-tali",
        "placement": "ground",
        "visibleWhen": undefined
      },
      {
        "id": "sable",
        "actorId": "sable",
        "kind": "actor",
        "position": v(4, 0, 8),
        "assetId": "actor-sable",
        "placement": "ground",
        "visibleWhen": undefined
      },
      {
        "id": "refuge-services",
        "kind": "interaction",
        "position": v(-6, 0, 1),
        "placement": "ground",
        "interactionId": "refuge-services"
      },
      {
        "id": "refuge-training",
        "kind": "interaction",
        "position": v(-3, 0, 1),
        "placement": "ground",
        "interactionId": "refuge-training"
      },
      {
        "id": "refuge-council",
        "kind": "interaction",
        "position": v(0, 0, 1),
        "placement": "ground",
        "interactionId": "refuge-council"
      },
      {
        "id": "refuge-save",
        "kind": "interaction",
        "position": v(3, 0, 1),
        "placement": "ground",
        "interactionId": "refuge-save"
      },
      {
        "id": "refuge-covenant",
        "kind": "interaction",
        "position": v(-8, 0, 19),
        "placement": "ground",
        "interactionId": "refuge-covenant"
      },
      {
        "id": "wild-march-formation-place",
        "kind": "interaction",
        "position": v(15, 3, 6),
        "placement": "ground",
        "interactionId": "wild-march-formation"
      }
    ],
    "encounterIds": [],
    "encounterParticipants": {},
    "restorationStates": [
      "unvisited",
      "corrupted",
      "partial",
      "restored"
    ],
    "assetIds": [
      "actor-yara",
      "actor-vara",
      "actor-tali",
      "actor-sable",
      "prop-refuge-shelter",
      "prop-map-table",
      "prop-training-post",
      "prop-heartroot-fragment-stone"
    ]
  },
  {
    "id": "heartroot-hollow",
    "authoringStatus": "unaccepted",
    "name": "Heartroot Hollow",
    "biome": "Root caverns beneath Erya",
    "bounds": {
      "min": v(-100, -80, -90),
      "max": v(100, 4, 90)
    },
    "environmentRecipeId": "heartroot-hollow-environment",
    "props": [
      {
        "id": "heartroot-hollow-placement-0",
        "assetId": "prop-heartroot-root-column",
        "position": v(-24, -36, -15),
        "rotationY": 0.1,
        "scale": v(1.4, 1.4, 1.4),
        "placement": "underground"
      },
      {
        "id": "heartroot-hollow-placement-1",
        "assetId": "prop-six-fragment-shrine",
        "position": v(0, -34, 0),
        "rotationY": 0,
        "scale": v(1, 1, 1),
        "placement": "underground"
      },
      {
        "id": "heartroot-hollow-placement-2",
        "assetId": "prop-root-crown-altar",
        "position": v(20, -35, -12),
        "rotationY": 0,
        "scale": v(1.2, 1.2, 1.2),
        "placement": "underground"
      },
      {
        "id": "heartroot-hollow-placement-3",
        "assetId": "prop-hollow-cavern-rock",
        "position": v(14, -36, 20),
        "rotationY": 0.6,
        "scale": v(1.7, 1.7, 1.7),
        "placement": "underground"
      },
      {
        "id": "heartroot-hollow-placement-4",
        "assetId": "prop-root-tether-anchor",
        "position": v(-16, -34, 11),
        "rotationY": 0,
        "scale": v(0.9, 0.9, 0.9),
        "placement": "underground"
      }
    ],
    "entities": [
      {
        "id": "orun",
        "actorId": "orun",
        "kind": "actor",
        "position": v(-8, -36, 2),
        "assetId": "actor-orun",
        "placement": "underground",
        "visibleWhen": undefined
      },
      {
        "id": "hollow-memory-sky",
        "kind": "interaction",
        "position": v(-6, -36, 1),
        "placement": "underground",
        "interactionId": "hollow-memory-sky"
      },
      {
        "id": "hollow-memory-canopy",
        "kind": "interaction",
        "position": v(-3, -36, 1),
        "placement": "underground",
        "interactionId": "hollow-memory-canopy"
      },
      {
        "id": "hollow-memory-fang",
        "kind": "interaction",
        "position": v(0, -36, 1),
        "placement": "underground",
        "interactionId": "hollow-memory-fang"
      },
      {
        "id": "hollow-memory-pack",
        "kind": "interaction",
        "position": v(3, -36, 1),
        "placement": "underground",
        "interactionId": "hollow-memory-pack"
      },
      {
        "id": "hollow-memory-shadow",
        "kind": "interaction",
        "position": v(6, -36, 1),
        "placement": "underground",
        "interactionId": "hollow-memory-shadow"
      },
      {
        "id": "hollow-memory-crown",
        "kind": "interaction",
        "position": v(9, -36, 1),
        "placement": "underground",
        "interactionId": "hollow-memory-crown"
      },
      {
        "id": "hollow-crown-choice",
        "kind": "interaction",
        "position": v(12, -36, 1),
        "placement": "underground",
        "interactionId": "hollow-crown-choice"
      },
      // Heartroot shadow echoes of the Sky aspect: native storm hornbills roosting on the arena floor. The Orun duel alone shows
      // and drives them (hidden and neutral otherwise); they are never party members, rewards or wildlife.
      {
        "id": "hollow-sky-echo-1",
        "actorId": "canopy-hornbill",
        "kind": "actor",
        "position": v(2, -7, -50),
        "assetId": "actor-storm-hornbill",
        "placement": "underground"
      },
      {
        "id": "hollow-sky-echo-2",
        "actorId": "canopy-hornbill",
        "kind": "actor",
        "position": v(10, -7, -62),
        "assetId": "actor-storm-hornbill",
        "placement": "underground"
      },
      {
        "id": "hollow-sky-echo-3",
        "actorId": "canopy-hornbill",
        "kind": "actor",
        "position": v(38, -7, -50),
        "assetId": "actor-storm-hornbill",
        "placement": "underground"
      }
    ],
    "encounterIds": [
      "encounter-orun"
    ],
    "encounterParticipants": {
      "encounter-orun": [
        "orun"
      ]
    },
    "restorationStates": [
      "unvisited",
      "corrupted",
      "partial",
      "restored"
    ],
    "assetIds": [
      "actor-orun",
      "actor-storm-hornbill",
      "prop-heartroot-root-column",
      "prop-six-fragment-shrine",
      "prop-root-crown-altar",
      "prop-hollow-cavern-rock",
      "prop-root-tether-anchor"
    ]
  }
] as const as readonly RegionContentSeed[];

type LevelPoint = readonly [number, number, number];
type PlannedSurface = { id: string; profile: "plane" | "ramp" | "terrace" | "ridge" | "water" | "cavern"; y: number; polygon: readonly LevelPoint[] };
type PlannedRoute = { id: string; from: LevelPoint; to: LevelPoint; anchors: readonly LevelPoint[]; destination: RegionDefinition["id"]; kind: "path" | "bridge" | "canopy" | "water" | "cavern" | "gate"; event: string; unlockFact?: string; colliderIds?: readonly string[] };
type LaterLayout = {
  profile: RegionDefinition["ground"]["profile"];
  bounds: readonly [number, number, number, number];
  surfaces: readonly PlannedSurface[];
  nodes: readonly { id: string; at: LevelPoint; links: readonly string[]; requirement?: string }[];
  entrances: readonly PlannedRoute[]; exits: readonly PlannedRoute[]; traversal: readonly PlannedRoute[];
  props: Readonly<Record<string, LevelPoint>>; entities: Readonly<Record<string, LevelPoint>>;
  cameras: readonly { id: string; at: LevelPoint; look: LevelPoint; mode: "exploration" | "encounter" | "story" }[];
};
const layouts: Readonly<Record<string, LaterLayout>> = {
  "moonpine-ridge": {
    profile:"ridge", bounds:[-85,85,-65,65], surfaces:[
      {id:"moonpine-ridge-ground",profile:"ridge",y:0,polygon:[[-85,0,-65],[-61,0,-65],[-48,0,-43],[-58,0,-27],[-80,0,-31]]},
      {id:"moonpine-ridge-lower-shelf",profile:"ridge",y:3,polygon:[[-63,3,-36],[-38,3,-40],[-20,3,-23],[-28,3,-4],[-52,3,-10]]},
      {id:"moonpine-ridge-chain-ledge",profile:"ramp",y:8,polygon:[[-34,8,-12],[-10,8,-18],[8,8,0],[-2,8,18],[-27,8,13]]},
      {id:"moonpine-ridge-temple-shelf",profile:"terrace",y:13,polygon:[[2,13,-12],[33,13,-12],[43,13,9],[30,13,28],[7,13,18]]},
      {id:"moonpine-ridge-summit",profile:"ridge",y:17,polygon:[[37,17,23],[61,17,21],[80,17,40],[72,17,59],[48,17,52]]}],
    nodes:[{id:"entry",at:[-74,0,-49],links:["foot"]},{id:"foot",at:[-51,0,-42],links:["entry","wolf-shelf"]},{id:"wolf-shelf",at:[-39,3,-24],links:["foot","chain-base"]},{id:"chain-base",at:[-20,8,-3],links:["wolf-shelf","temple"]},{id:"temple",at:[8,13,0],links:["chain-base","temple-heart"]},{id:"temple-heart",at:[25,13,7],links:["temple","summit"]},{id:"summit",at:[57,17,39],links:["temple-heart"]}],
    entrances:[{id:"grove-ridge-in",from:[-74,0,-49],to:[25,0,17],anchors:[[-74,0,-49],[25,0,17]],destination:"the-grove",kind:"path",event:"grove-ridge",unlockFact:"restoration:the-grove:restored",colliderIds:["grove-trial-lookout-pad-collider"]},{id:"bamboo-ridge-in",from:[-74,0,-49],to:[38,0,-37],anchors:[[-74,0,-49],[38,0,-37]],destination:"blood-bamboo-valley",kind:"path",event:"bamboo-ridge",unlockFact:"restoration:blood-bamboo-valley:restored",colliderIds:["bamboo-moonpine-gateway-collider"]},{id:"mist-ridge-in",from:[57,17,39],to:[-78,0,-50],anchors:[[57,17,39],[12,8,-10],[-78,0,-50]],destination:"mistveil-basin",kind:"path",event:"ridge-mist"}],
    exits:[{id:"ridge-grove-out",from:[-74,0,-49],to:[25,0,17],anchors:[[-74,0,-49],[-29,0,-21],[25,0,17]],destination:"the-grove",kind:"path",event:"grove-ridge"},{id:"ridge-bamboo-out",from:[-74,0,-49],to:[38,0,-37],anchors:[[-74,0,-49],[-20,0,-48],[38,0,-37]],destination:"blood-bamboo-valley",kind:"path",event:"bamboo-ridge"},{id:"ridge-mist-out",from:[57,17,39],to:[-78,0,-50],anchors:[[57,17,39],[12,8,-10],[-78,0,-50]],destination:"mistveil-basin",kind:"path",event:"mist-ridge"}],
    traversal:[{id:"wolf-chain-ascent",from:[-39,3,-24],to:[-20,8,-3],anchors:[[-39,3,-24],[-29.5,5.5,-13.5],[-20,8,-3]],destination:"moonpine-ridge",kind:"bridge",event:"ridge-chain-ascent"},{id:"temple-summit-climb",from:[23,13,7],to:[52,17,37],anchors:[[23,13,7],[38,15,20],[52,17,37]],destination:"moonpine-ridge",kind:"path",event:"temple-summit-route"}],
    props:{"prop-moonpine-tree":[-70,0,-43],"prop-buried-wolf-temple":[30,13,-7],"prop-temple-chain-anchor":[-23,8,-5],"prop-snow-ridge-rock":[-48,3,-24],"prop-moonpine-log-bridge":[-16,8,7]},
    entities:{ruun:[25,13,7],luma:[21,13,11],sable:[27,13,13],"three-beat-howl":[-51,0,-42],"pack-pup-shelter":[-40,3,-24],"temple-restraints":[-23,8,-5],"pack-settlement":[25,13,7],"pack-fragment":[27,13,13],"howl-three-place":[-24,8,-7],"temple-route-place":[-20,8,-1]},
    cameras:[{id:"ridge-trail-rail",at:[-30,15,20],look:[-27,8,-4],mode:"exploration"},{id:"ruun-chain-arena",at:[4,22,35],look:[24,13,8],mode:"encounter"}],
  },
  "mistveil-basin": {
    profile:"basin",bounds:[-90,90,-75,75],surfaces:[
      {id:"mistveil-basin-ground",profile:"water",y:0,polygon:[[-90,0,-75],[-63,0,-75],[-52,0,-46],[-67,0,-30],[-88,0,-38]]},
      {id:"mistveil-basin-reed-bank",profile:"plane",y:0,polygon:[[-67,0,-31],[-35,0,-35],[-22,0,-15],[-39,0,3],[-67,0,-3]]},
      {id:"mistveil-basin-river-isle",profile:"water",y:1,polygon:[[-37,1,-28],[-8,1,-25],[4,1,-8],[-9,1,9],[-34,1,4]]},
      {id:"mistveil-basin-extraction-bank",profile:"plane",y:0,polygon:[[-7,0,-16],[23,0,-18],[36,0,2],[22,0,20],[-2,0,12]]},
      {id:"mistveil-basin-cavern-landing",profile:"cavern",y:-5,polygon:[[10,-5,12],[34,-5,12],[42,-5,32],[22,-5,39],[8,-5,28]]},
      {id:"mistveil-basin-arena",profile:"water",y:-1,polygon:[[39,-1,-12],[73,-1,-14],[84,-1,11],[69,-1,34],[43,-1,28]]}],
    nodes:[{id:"west-bank",at:[-78,0,-50],links:["reed-path"]},{id:"reed-path",at:[-52,0,-20],links:["west-bank","river-step","player-route-start"]},{id:"river-step",at:[-25,1,-10],links:["reed-path","extraction"]},{id:"extraction",at:[8,0,-3],links:["river-step","source-bank"]},{id:"source-bank",at:[25,0,7],links:["extraction","cavern-lip"]},{id:"cavern-lip",at:[20,-5,29],links:["source-bank","ghor-arena","rootway-end"]},{id:"ghor-arena",at:[62,-1,10],links:["cavern-lip"]},{id:"player-route-start",at:[-52,0,-20],links:["reed-path","hidden-bank-turn"],requirement:"mistveil_nyra_hidden_route"},{id:"hidden-bank-turn",at:[-52,0,6],links:["player-route-start","hidden-low-bank"],requirement:"mistveil_nyra_hidden_route"},{id:"hidden-low-bank",at:[-43,-5,24],links:["hidden-bank-turn","hidden-reed-corridor"],requirement:"mistveil_nyra_hidden_route"},{id:"hidden-reed-corridor",at:[-25,-5,28],links:["hidden-low-bank","rootway-end"],requirement:"mistveil_nyra_hidden_route"},{id:"rootway-end",at:[16,-5,28],links:["cavern-lip","hidden-reed-corridor"],requirement:"mistveil_nyra_hidden_route"}],
    entrances:[{id:"ridge-mist-in",from:[-78,0,-50],to:[57,17,39],anchors:[[-78,0,-50],[12,8,-10],[57,17,39]],destination:"moonpine-ridge",kind:"path",event:"ridge-mist"},{id:"sunmane-mist-in",from:[62,-1,10],to:[-82,0,-54],anchors:[[62,-1,10],[-5,0,-15],[-82,0,-54]],destination:"sunmane-expanse",kind:"path",event:"sunmane-mist"}],
    exits:[{id:"mist-ridge-out",from:[-78,0,-50],to:[57,17,39],anchors:[[-78,0,-50],[0,0,-5],[57,17,39]],destination:"moonpine-ridge",kind:"path",event:"ridge-mist"},{id:"mist-sunmane-out",from:[62,-1,10],to:[-82,0,-54],anchors:[[62,-1,10],[-5,0,-15],[-82,0,-54]],destination:"sunmane-expanse",kind:"path",event:"sunmane-mist"},{id:"mistveil-hidden-route-out",from:[-52,0,-20],to:[16,-5,28],anchors:[[-52,0,-20],[-52,0,6],[-43,-5,24],[-25,-5,28],[16,-5,28]],destination:"mistveil-basin",kind:"cavern",event:"mistveil-hidden-route",unlockFact:"mistveil_nyra_hidden_route"}],
    traversal:[{id:"reedbank-wading",from:[-52,0,-20],to:[-25,1,-10],anchors:[[-52,0,-20],[-38,0,-14],[-25,1,-10]],destination:"mistveil-basin",kind:"water",event:"mistveil-river-crossing"},{id:"extraction-cavern-drop",from:[25,0,7],to:[20,-5,29],anchors:[[25,0,7],[22.5,-2.5,18],[20,-5,29]],destination:"mistveil-basin",kind:"cavern",event:"mistveil-cavern-descent"},{id:"mistveil-hidden-rootway",from:[-52,0,-20],to:[16,-5,28],anchors:[[-52,0,-20],[-52,0,6],[-43,-5,24],[-25,-5,28],[16,-5,28]],destination:"mistveil-basin",kind:"cavern",event:"mistveil-hidden-route",unlockFact:"mistveil_nyra_hidden_route"}],
    props:{"prop-mistveil-reed-cluster":[-57,0,-20],"prop-hunter-extraction-rig":[14,0,-8],"prop-mire-bank-rock":[-29,1,-16],"prop-root-cavern-mouth":[28,-5,32],"prop-black-sap-filter-drum":[29,0,9]},
    entities:{nyra:[-52,0,-20],ghor:[62,-1,10],marek:[8,0,-3],"mist-tracks":[-52,0,-20],"nyra-reveal-hidden-route":[-52,0,-20],"marek-choice":[8,0,-3],"river-source":[29,0,9],"ghor-cleanse":[62,-1,10],"shadow-fragment":[66,-1,18],"mistveil-hidden-route-marker":[-52,0,-20],"reed-track-place":[-48,0,-18]},
    cameras:[{id:"mist-reed-channel",at:[-38,18,24],look:[-30,0,-5],mode:"exploration"},{id:"ghor-river-arena",at:[76,14,46],look:[62,-1,10],mode:"encounter"},{id:"extraction-ledger",at:[-1,8,-21],look:[8,0,-3],mode:"story"}],
  },
  "sunmane-expanse": {
    profile:"terraced",bounds:[-100,100,-80,80],surfaces:[
      {id:"sunmane-expanse-ground",profile:"plane",y:0,polygon:[[-100,0,-80],[-61,0,-80],[-48,0,-51],[-65,0,-31],[-100,0,-38]]},
      {id:"sunmane-expanse-migration-terrace",profile:"terrace",y:2,polygon:[[-66,2,-35],[-29,2,-43],[-14,2,-17],[-30,2,3],[-61,2,-3]]},
      {id:"sunmane-expanse-water-terrace",profile:"terrace",y:5,polygon:[[-27,5,-29],[8,5,-34],[24,5,-12],[10,5,13],[-19,5,8]]},
      {id:"sunmane-expanse-council-terrace",profile:"terrace",y:9,polygon:[[13,9,-24],[49,9,-26],[64,9,0],[49,9,25],[20,9,19]]},
      {id:"sunmane-expanse-high-crown",profile:"terrace",y:13,polygon:[[44,13,21],[74,13,20],[91,13,44],[70,13,61],[48,13,49]]}],
    nodes:[{id:"plains-entry",at:[-82,0,-54],links:["migration-gate"]},{id:"migration-gate",at:[-56,2,-17],links:["plains-entry","allotment"]},{id:"allotment",at:[-12,5,-9],links:["migration-gate","council-approach"]},{id:"council-approach",at:[23,9,-5],links:["allotment","crown-court"]},{id:"crown-court",at:[49,9,4],links:["council-approach","high-terrace"]},{id:"high-terrace",at:[65,13,38],links:["crown-court"]}],
    entrances:[{id:"mist-sunmane-in",from:[-82,0,-54],to:[62,-1,10],anchors:[[-82,0,-54],[-5,0,-15],[62,-1,10]],destination:"mistveil-basin",kind:"path",event:"mist-sunmane"},{id:"refuge-sunmane-in",from:[-27,0,-20],to:[-82,0,-54],anchors:[[-27,0,-20],[-55,0,-35],[-82,0,-54]],destination:"refuge",kind:"path",event:"refuge-sunmane",unlockFact:"refugeOpen"},{id:"hollow-sunmane-in",from:[91,-36,89],to:[65,13,38],anchors:[[91,-36,89],[80,-12,63],[65,13,38]],destination:"heartroot-hollow",kind:"cavern",event:"hollow-sunmane",unlockFact:"hollow-opening"}],
    exits:[{id:"sunmane-mist-out",from:[-82,0,-54],to:[62,-1,10],anchors:[[-82,0,-54],[-5,0,-15],[62,-1,10]],destination:"mistveil-basin",kind:"path",event:"mist-sunmane"},{id:"sunmane-refuge-out",from:[-82,0,-54],to:[-27,0,-20],anchors:[[-82,0,-54],[-55,0,-35],[-27,0,-20]],destination:"refuge",kind:"path",event:"refuge-sunmane",unlockFact:"refugeOpen"},{id:"sunmane-hollow-out",from:[65,13,38],to:[91,-36,89],anchors:[[65,13,38],[80,-12,63],[91,-36,89]],destination:"heartroot-hollow",kind:"cavern",event:"sunmane-hollow",unlockFact:"hollow-opening"}],
    traversal:[{id:"migration-gate-crossing",from:[-58,2,-18],to:[-29,2,-18],anchors:[[-58,2,-18],[-44,2,-18],[-29,2,-18]],destination:"sunmane-expanse",kind:"gate",event:"sunmane-migration-gate"},{id:"water-allotment-stair",from:[-56,2,-17],to:[-12,5,-9],anchors:[[-56,2,-17],[-34,3.5,-13],[-12,5,-9]],destination:"sunmane-expanse",kind:"water",event:"sunmane-water-allotment"},{id:"council-rise",from:[11,5,5],to:[23,9,-5],anchors:[[11,5,5],[17,7,0],[23,9,-5]],destination:"sunmane-expanse",kind:"path",event:"sunmane-council-terrace"}],
    props:{"prop-sunmane-stone-terrace":[42,9,15],"prop-migration-gate":[-51,2,-17],"prop-water-allotment-gate":[-12,5,-17],"prop-plains-stone-arch":[23,9,-17],"prop-savanna-acacia":[77,13,44]},
    entities:{solkar:[49,9,4],"council-envoy":[23,9,-5],"silent-crossing":[-82,0,-54],"tribute-record":[-51,2,-17],"solkar-offer":[49,9,4],"crown-council":[23,9,-5],"crown-fragment":[65,13,38],"herd-testimony-place":[-16,5,-8]},
    cameras:[{id:"migration-corridor",at:[-28,20,28],look:[-29,2,-17],mode:"exploration"},{id:"council-court",at:[67,24,48],look:[49,9,4],mode:"encounter"},{id:"water-allotment",at:[-5,14,24],look:[-12,5,-9],mode:"story"}],
  },
  refuge: {
    profile:"terraced",bounds:[-32,32,-28,34],surfaces:[
      {id:"refuge-ground",profile:"plane",y:0,polygon:[[-32,0,-28],[-17,0,-28],[-12,0,-18],[-22,0,-10],[-32,0,-12]]},
      {id:"refuge-service-terrace",profile:"terrace",y:1.5,polygon:[[-23,1.5,-15],[-4,1.5,-19],[7,1.5,-7],[-3,1.5,7],[-20,1.5,4]]},
      {id:"refuge-council-landing",profile:"terrace",y:3,polygon:[[3,3,-8],[22,3,-7],[28,3,8],[12,3,16],[1,3,8]]},
      {id:"refuge-collapse-rim",profile:"ramp",y:0,polygon:[[-15,0,8],[-2,0,10],[2,0,23],[-9,0,31],[-19,0,24]]},
      {id:"refuge-lift-landing",profile:"terrace",y:-2,polygon:[[5,-2,16],[18,-2,14],[25,-2,26],[12,-2,31],[3,-2,27]]}],
    nodes:[{id:"refuge-entry",at:[-27,0,-20],links:["service-court"]},{id:"service-court",at:[-13,1.5,-5],links:["refuge-entry","council-landing"]},{id:"council-landing",at:[13,3,5],links:["service-court","collapse-rim"]},{id:"collapse-rim",at:[-8,0,19],links:["council-landing","lift-landing"]},{id:"lift-landing",at:[13,-2,24],links:["collapse-rim"]}],
    entrances:[{id:"grove-refuge-in",from:[-27,0,-20],to:[26,0,-3],anchors:[[-27,0,-20],[26,0,-3]],destination:"the-grove",kind:"path",event:"grove-refuge",unlockFact:"refugeOpen",colliderIds:["grove-trial-lookout-pad-collider"]},{id:"sunmane-refuge-in",from:[-27,0,-20],to:[-82,0,-54],anchors:[[-27,0,-20],[-55,0,-35],[-82,0,-54]],destination:"sunmane-expanse",kind:"path",event:"refuge-sunmane",unlockFact:"refugeOpen"}],
    exits:[{id:"refuge-sunmane-out",from:[-27,0,-20],to:[-82,0,-54],anchors:[[-27,0,-20],[-55,0,-35],[-82,0,-54]],destination:"sunmane-expanse",kind:"path",event:"refuge-sunmane",unlockFact:"refugeOpen"},{id:"refuge-hollow-out",from:[13,-2,24],to:[91,-36,89],anchors:[[13,-2,24],[20,-12,38],[42,-24,58],[91,-36,89]],destination:"heartroot-hollow",kind:"cavern",event:"refuge-hollow",unlockFact:"hollow-opening"}],
    traversal:[{id:"refuge-collapse-detour",from:[-8,0,19],to:[13,-2,24],anchors:[[-8,0,19],[-3,-1,21],[13,-2,24]],destination:"refuge",kind:"cavern",event:"refuge-lift-descent"}],
    props:{"prop-refuge-shelter":[-12,1.5,-11],"prop-map-table":[13,3,8],"prop-training-post":[-10,1.5,1],"prop-heartroot-fragment-stone":[-12,0,20]},
    entities:{yara:[-13,1.5,-5],vara:[-8,1.5,-7],tali:[8,3,2],sable:[17,3,8],"refuge-services":[-13,1.5,-5],"refuge-training":[-13,1.5,1],"refuge-council":[13,3,5],"refuge-save":[-13,1.5,-5]},
    cameras:[{id:"refuge-relocated-services",at:[-10,14,20],look:[-13,1.5,-5],mode:"story"},{id:"refuge-council-landing",at:[28,13,23],look:[13,3,5],mode:"exploration"}],
  },
  "heartroot-hollow": {
    profile:"cavern",bounds:[-120,120,-90,115],surfaces:[
      {id:"heartroot-hollow-entrance-landing",profile:"cavern",y:-36,polygon:[[72,-36,73],[101,-36,73],[111,-36,94],[91,-36,108],[70,-36,96]]},
      {id:"heartroot-hollow-memory-floor",profile:"cavern",y:-32,polygon:[[34,-32,43],[63,-32,39],[75,-32,60],[60,-32,78],[35,-32,71]]},
      {id:"heartroot-hollow-sixfold-bridge",profile:"ramp",y:-27,polygon:[[2,-27,25],[31,-27,21],[43,-27,42],[28,-27,57],[4,-27,48]]},
      {id:"heartroot-hollow-cavern-floor",profile:"cavern",y:-22,polygon:[[-31,-22,1],[-2,-22,-5],[14,-22,13],[1,-22,32],[-25,-22,27]]},
      {id:"heartroot-hollow-crown-landing",profile:"terrace",y:-13,polygon:[[-29,-13,-37],[-2,-13,-43],[18,-13,-25],[4,-13,-5],[-22,-13,-9]]},
      {id:"heartroot-hollow-arena",profile:"cavern",y:-7,polygon:[[-6,-7,-66],[30,-7,-68],[48,-7,-43],[28,-7,-20],[-5,-7,-28]]}],
    nodes:[{id:"hollow-mouth",at:[91,-36,89],links:["memory-floor"]},{id:"memory-floor",at:[53,-32,58],links:["hollow-mouth","sixfold-bridge"]},{id:"sixfold-bridge",at:[23,-27,38],links:["memory-floor","cavern-floor"]},{id:"cavern-floor",at:[-8,-22,14],links:["sixfold-bridge","crown-landing"]},{id:"crown-landing",at:[-7,-13,-25],links:["cavern-floor","orun-arena"]},{id:"orun-arena",at:[17,-7,-45],links:["crown-landing"]}],
    entrances:[{id:"refuge-hollow-in",from:[91,-36,89],to:[13,-2,24],anchors:[[91,-36,89],[42,-24,58],[20,-12,38],[13,-2,24]],destination:"refuge",kind:"cavern",event:"refuge-hollow",unlockFact:"hollow-opening"},{id:"sunmane-hollow-in",from:[91,-36,89],to:[65,13,38],anchors:[[91,-36,89],[80,-12,63],[65,13,38]],destination:"sunmane-expanse",kind:"cavern",event:"sunmane-hollow",unlockFact:"hollow-opening"}],
    exits:[{id:"hollow-refuge-out",from:[91,-36,89],to:[13,-2,24],anchors:[[91,-36,89],[70,-27,73],[42,-15,49],[13,-2,24]],destination:"refuge",kind:"cavern",event:"refuge-hollow"},{id:"hollow-sunmane-out",from:[91,-36,89],to:[65,13,38],anchors:[[91,-36,89],[80,-12,63],[65,13,38]],destination:"sunmane-expanse",kind:"cavern",event:"hollow-sunmane"}],
    traversal:[{id:"hollow-memory-descent",from:[91,-36,89],to:[53,-32,58],anchors:[[91,-36,89],[72,-34,73],[53,-32,58]],destination:"heartroot-hollow",kind:"cavern",event:"hollow-memory-landing"},{id:"six-species-root-bridge",from:[53,-32,58],to:[23,-27,38],anchors:[[53,-32,58],[38,-30,47],[23,-27,38]],destination:"heartroot-hollow",kind:"bridge",event:"hollow-sixfold-crossing"},{id:"crown-climb",from:[-8,-22,14],to:[-7,-13,-25],anchors:[[-8,-22,14],[-12,-18,-4],[-7,-13,-25]],destination:"heartroot-hollow",kind:"cavern",event:"hollow-crown-ascent"},{id:"crown-arena-drop",from:[-7,-13,-25],to:[17,-7,-45],anchors:[[-7,-13,-25],[5,-10,-35],[17,-7,-45]],destination:"heartroot-hollow",kind:"cavern",event:"hollow-arena-entry"}],
    props:{"prop-heartroot-root-column":[-20,-22,3],"prop-six-fragment-shrine":[15,-27,42],"prop-root-crown-altar":[-7,-13,-31],"prop-hollow-cavern-rock":[78,-32,51],"prop-root-tether-anchor":[91,-36,89]},
    entities:{orun:[17,-7,-45],"hollow-memory-sky":[53,-32,58],"hollow-memory-canopy":[40,-32,61],"hollow-memory-fang":[29,-27,38],"hollow-memory-pack":[24,-27,47],"hollow-memory-shadow":[-8,-22,14],"hollow-memory-crown":[-8.5,-13,-25],"hollow-crown-choice":[-7,-13,-27.5]},
    cameras:[{id:"hollow-six-species-approach",at:[118,-17,119],look:[50,-32,58],mode:"exploration"},{id:"hollow-memory-cavern",at:[50,-7,67],look:[-8,-22,14],mode:"story"},{id:"orun-crown-arena",at:[36,8,-7],look:[17,-7,-45],mode:"encounter"}],
  },
};
const toVector = ([x,y,z]: LevelPoint) => v(x,y,z);
function plannedRoute(regionId: string, plan: PlannedRoute, colliderSourceRegionId = regionId) {
  const colliderIds = plan.colliderIds ?? layouts[colliderSourceRegionId]?.surfaces.map((surface)=>surface.id+"-collider") ?? [];
  if (!colliderIds.length) throw new Error("Route has no authored collider source: " + regionId + "/" + plan.id);
  return { id:plan.id, from:toVector(plan.from), to:toVector(plan.to), anchors:plan.anchors.map(toVector), destinationRegionId:plan.destination, kind:plan.kind, traversalActionId:(plan.kind === "cavern" ? "root-tether" : "contextual-traverse") as never, colliderIds, ...(plan.unlockFact ? {unlockFact:plan.unlockFact} : {}), traversalEvent:plan.event };
}
function authorLaterRegion(region: RegionContentSeed): RegionDefinition {
  const plan = layouts[region.id];
  if (!plan) throw new Error("Missing authored later-region plan: " + region.id);
  const [minX,maxX,minZ,maxZ] = plan.bounds;
  const nodes = plan.nodes.map(node => ({id:node.id,position:toVector(node.at),links:node.links,...(node.requirement ? {requirement:node.requirement} : {})}));
  const physical = buildLaterWalkways(region.id, plan.surfaces.map(surface =>
    flat(surface.id, surface.profile, surface.id + "-material", 0.8, surface.polygon.map(toVector))), nodes);
  const surfaces = physical.walks.map(walk => walk.surface);
  const colliders = physical.walks.map(walk => walk.collider);
  const props=region.props.map((prop) => plan.props[prop.assetId] ? {...prop,position:toVector(plan.props[prop.assetId]!)} : prop);
  const entities=region.entities.map((entity) => {
    const at=plan.entities[entity.id];
    if (!at) return entity;
    const position=toVector(at);
    return {...entity,position,placement:position.y < -5 ? "underground" as const : position.y > 3 ? "elevated" as const : "ground" as const};
  });
  if (region.id === "sunmane-expanse") entities.push({ id:"migration-gate", kind:"interaction", position:v(-51,2,-17), placement:"ground", interactionId:"migration-gate" });
  return dressLaterRegion({
    ...region,
    movableObjects:[],
    biome:region.id === "refuge" ? "Post-collapse sanctuary with relocated Grove services" : region.biome,
    bounds:{min:v(minX,region.bounds.min.y,minZ),max:v(maxX,region.bounds.max.y,maxZ)}, props,
    ground:{y:region.id === "heartroot-hollow" ? -36 : 0,profile:plan.profile,navGraphId:region.id+"-authored-nav",surfaces,colliders},
    navigation:{nodes,ribbons:physical.ribbons},
    cameraAnchors:plan.cameras.map((camera)=>({id:camera.id,position:toVector(camera.at),lookAt:toVector(camera.look),mode:camera.mode})),
    entrances:plan.entrances.map((entry)=>plannedRoute(region.id,entry,entry.destination)), exits:plan.exits.map((exit)=>plannedRoute(region.id,exit)), traversalArcs:plan.traversal.map((arc)=>plannedRoute(region.id,arc)), entities,
  });
}
export const LATER_ACT_REGIONS: readonly RegionDefinition[] = BASE_LATER_ACT_REGIONS.map(authorLaterRegion);
