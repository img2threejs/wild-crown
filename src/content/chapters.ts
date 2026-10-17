import type {
  ChapterCheckpointDefinition, ChapterEncounterEntry, ChapterRuntimeDefinition, CompanionRelationshipRule, LayoutRevisionMigration, ObjectiveId, RegionId, Vec3,
} from "../game/contracts.js";
import { v } from "./levels/schema.js";

/**
 * Act I chapter runtime data (data only; the Director, the engine and the app read it). Positions here are never authoritative:
 * a checkpoint names a canonical nav node or entrance of its region, and an encounter entry names its trigger centre; the
 * region geometry in `levels/` owns every coordinate. `ChapterRuntimeDefinition.layoutRevision` is the revision of the
 * canonical layout the node ids belong to (revision 0 is the pre-chapter layout every v1 save was written against).
 */
export const ACT_I_LAYOUT_REVISION = 1;
/** Revision of every authored later-act region (Moonpine, Mistveil, Sunmane, Refuge, Hollow). Matches Act I; later migrations
 * remain revision 1 → 1, so legacy schema-1 saves default here too. */
export const LATER_ACT_LAYOUT_REVISION = 1;

const checkpoint = (
  id: string, regionId: RegionId, nodeId: string, cameraAnchorId: string, radius: number, requiresFacts: readonly string[] = [], encounterId: string | null = null,
): ChapterCheckpointDefinition => ({ id, regionId, nodeId, cameraAnchorId, radius, requiresFacts, encounterId });

const entry = (
  id: string, encounterId: string, regionId: RegionId, objectiveId: string, center: Vec3, radius: number, checkpointId: string, requiresFacts: readonly string[] = [],
): ChapterEncounterEntry => ({ id, encounterId, regionId, objectiveId: objectiveId as ObjectiveId, center, radius, checkpointId, requiresFacts });

const ACT_I_CHAPTER_RUNTIME: readonly ChapterRuntimeDefinition[] = [
  {
    segmentId: "prologue", chapter: 0, regionId: "greenwake", layoutRevision: ACT_I_LAYOUT_REVISION,
    checkpoints: [
      checkpoint("prologue-run-entry", "greenwake", "greenwake-forest-entry", "greenwake-entry-rail", 4),
      checkpoint("prologue-after-sky", "greenwake", "greenwake-tutorial-yard", "greenwake-tutorial-rail", 4, ["interaction:tend-vara"]),
    ],
    encounterEntries: [],
    exitRequirements: ["objective:prologue:receive-sky", "beat:prologue-vision"],
  },
  {
    segmentId: "greenwake", chapter: 0, regionId: "greenwake", layoutRevision: ACT_I_LAYOUT_REVISION,
    checkpoints: [
      checkpoint("greenwake-pre-boar", "greenwake", "greenwake-boar-approach", "greenwake-boar-arena", 5, ["interaction:warden-staff"], "greenwake-boar"),
      checkpoint("greenwake-post-cleanse", "greenwake", "greenwake-boar-clearing", "greenwake-boar-arena", 5, ["greenwake-boar-cleansed"]),
      checkpoint("greenwake-forest-exit", "greenwake", "greenwake-forest-corridor-6", "greenwake-exit-rail", 4, ["interaction:greenwake-gate"]),
    ],
    encounterEntries: [
      entry("greenwake-boar-entry", "greenwake-boar", "greenwake", "prologue:cleanse-boar", v(10, 0, -1), 6, "greenwake-pre-boar", ["interaction:warden-staff"]),
    ],
    exitRequirements: ["quest:prologue", "beat:greenwake-cleanse", "interaction:greenwake-gate"],
  },
  {
    segmentId: "canopy", chapter: 1, regionId: "whispering-canopy", layoutRevision: ACT_I_LAYOUT_REVISION,
    checkpoints: [
      checkpoint("canopy-arrival", "whispering-canopy", "canopy-trial-start", "canopy-trial-basin-rail", 4),
      checkpoint("canopy-roost-after-chase", "whispering-canopy", "canopy-trial-roost", "canopy-trial-roost-rail", 4, ["interaction:koro-trail"]),
      checkpoint("canopy-pre-koro", "whispering-canopy", "canopy-story-courtyard-west", "canopy-trial-courtyard-rail", 4,
        ["interaction:canopy-waterwheel", "interaction:monkey-rescue", "interaction:orchard-seeds"], "encounter-koro"),
      checkpoint("canopy-post-koro", "whispering-canopy", "canopy-trial-courtyard", "canopy-trial-courtyard-rail", 5, ["encounter-koro-cleansed"]),
    ],
    encounterEntries: [
      entry("koro-entry", "encounter-koro", "whispering-canopy", "empty-orchard:cleanse-koro", v(47, 0, -24), 6.5, "canopy-pre-koro",
        ["interaction:canopy-waterwheel", "interaction:monkey-rescue", "interaction:orchard-seeds"]),
    ],
    exitRequirements: [
      "quest:fallen-scout", "quest:thief-in-the-branches", "quest:empty-orchard", "choice:koro-pact", "beat:orchard-close", "restoration:whispering-canopy:restored",
    ],
  },
  {
    segmentId: "bamboo", chapter: 2, regionId: "blood-bamboo-valley", layoutRevision: ACT_I_LAYOUT_REVISION,
    checkpoints: [
      checkpoint("bamboo-west-entry", "blood-bamboo-valley", "bamboo-canopy-gateway", "bamboo-valley-entry-rail", 4),
      checkpoint("bamboo-camp-overlook", "blood-bamboo-valley", "bamboo-camp-overlook", "bamboo-hunter-camp-establishing", 4, ["interaction:camp-approach"], "camp-hunters"),
      checkpoint("bamboo-camp-liberated", "blood-bamboo-valley", "bamboo-camp-east-flank", "bamboo-tiger-tracking-rail", 4, ["bamboo_tali_safe"]),
      checkpoint("bamboo-shrine-pre-asha", "blood-bamboo-valley", "bamboo-den-terrace", "bamboo-asha-arena-rail", 4, ["bamboo_tali_safe", "interaction:camp-disable"], "encounter-asha"),
      checkpoint("bamboo-post-cleanse", "blood-bamboo-valley", "bamboo-asha-arena", "bamboo-shelter-rail", 5, ["encounter-asha-cleansed"]),
      checkpoint("bamboo-valley-exit", "blood-bamboo-valley", "bamboo-grove-route", "bamboo-exit-rail", 4, ["restoration:blood-bamboo-valley:restored"]),
    ],
    encounterEntries: [
      entry("camp-hunters-entry", "camp-hunters", "blood-bamboo-valley", "the-ash-hunters:subdue-hunters", v(-15, 0, -19), 10, "bamboo-camp-overlook", ["interaction:camp-approach"]),
      entry("asha-entry", "encounter-asha", "blood-bamboo-valley", "a-mothers-roar:cleanse-asha", v(34, 2, 36), 9, "bamboo-shrine-pre-asha", ["interaction:camp-disable", "bamboo_tali_safe"]),
    ],
    exitRequirements: [
      "quest:tracks-without-blood", "quest:the-ash-hunters", "quest:a-mothers-roar", "choice:asha-pact", "beat:asha-close", "restoration:blood-bamboo-valley:restored",
    ],
  },
  {
    segmentId: "grove", chapter: 2, regionId: "the-grove", layoutRevision: ACT_I_LAYOUT_REVISION,
    checkpoints: [
      checkpoint("grove-arrival", "the-grove", "grove-trial-start", "grove-trial-arrival-rail", 4),
      checkpoint("grove-heartroot-rest", "the-grove", "grove-trial-glade", "grove-story-court-rail", 4),
    ],
    encounterEntries: [],
    exitRequirements: [],
  },
];

/**
 * Old safe-spawn node/entrance ids → canonical ids of the revision-1 layouts (v1 saves are revision 0). Ids absent from a map
 * are kept only if they are still a safe authored node; otherwise the region's fallback node is used.
 */
const ACT_I_LAYOUT_MIGRATIONS: readonly LayoutRevisionMigration[] = [
  {
    regionId: "greenwake", fromRevision: 0, toRevision: ACT_I_LAYOUT_REVISION,
    nodeMap: { "greenwake-grove-gate": "greenwake-root-ramp" },
    fallbackNodeId: "greenwake-forest-entry",
  },
  {
    regionId: "whispering-canopy", fromRevision: 0, toRevision: ACT_I_LAYOUT_REVISION,
    nodeMap: {
      "canopy-entry": "canopy-trial-start", "canopy-watercourse": "canopy-trial-basin", "canopy-grove-gateway": "canopy-trial-start",
      "canopy-forest-crossing": "canopy-trial-stair-foot", "canopy-monkey-launch": "canopy-trial-stair-foot",
      "canopy-root-ramp": "canopy-trial-stair-top", "canopy-root-ramp-end": "canopy-trial-fig-ledge", "canopy-vine-junction": "canopy-trial-gorge-bridge",
      "canopy-bough-ramp-start": "canopy-trial-roost", "canopy-bough-ramp": "canopy-trial-roost", "canopy-bough-ramp-top": "canopy-trial-roost", "canopy-upper-bough": "canopy-trial-roost",
      "canopy-east-bough-ramp-start": "canopy-trial-chasm-bridge", "canopy-east-bough-ramp": "canopy-trial-chasm-bridge",
      "canopy-monkey-ground-alternative": "canopy-trial-courtyard", "canopy-shrine-approach": "canopy-trial-courtyard", "canopy-shrine-path": "canopy-trial-courtyard",
      "canopy-ground-east-trail": "canopy-trial-exit-approach", "canopy-east-bough-ramp-end": "canopy-trial-exit-landing", "canopy-bamboo-gateway": "canopy-trial-exit-landing",
      "grove-canopy-in": "canopy-trial-start",
    },
    fallbackNodeId: "canopy-trial-start",
  },
  {
    regionId: "blood-bamboo-valley", fromRevision: 0, toRevision: ACT_I_LAYOUT_REVISION,
    // Every revision-0 Bamboo node and entrance still exists; the camp's east flank now needs Tali's rescue.
    nodeMap: { "bamboo-camp-east-flank": "bamboo-camp-west-flank" },
    fallbackNodeId: "bamboo-canopy-gateway",
  },
  {
    regionId: "the-grove", fromRevision: 0, toRevision: ACT_I_LAYOUT_REVISION,
    nodeMap: {
      "grove-greenwake-gate": "grove-trial-start", "grove-heartroot-arrival": "grove-trial-start",
      "grove-west-court-connector": "grove-trial-glade-west", "grove-heartroot-court": "grove-trial-glade", "grove-first-pact": "grove-trial-glade",
      "grove-oath-ramp-start": "grove-trial-glade", "grove-oath-approach": "grove-trial-glade", "grove-oath-terrace-start": "grove-trial-glade",
      "grove-services": "grove-trial-camp", "grove-overlook-start": "grove-trial-camp", "grove-overlook-ramp": "grove-trial-camp", "grove-overlook-ramp-top": "grove-trial-camp", "grove-canopy-overlook": "grove-trial-camp",
      "grove-basin": "grove-trial-glade-east", "grove-east-connector": "grove-trial-glade-east", "grove-bamboo-gate": "grove-trial-lookouts",
      "grove-moonpine-gate": "grove-trial-lookouts", "grove-refuge-passage": "grove-trial-lookouts",
      "greenwake-grove-in": "bamboo-grove-in", "canopy-grove-in": "bamboo-grove-in", "grove-bamboo-in": "bamboo-grove-in",
    },
    fallbackNodeId: "grove-trial-start",
  },
];

/** Act I companion relationship awards, keyed by accepted authored event; each fires once per run. Pact Bond/Dominion levels come from the pact authority. */
const ACT_I_RELATIONSHIP_RULES: readonly CompanionRelationshipRule[] = [
  { id: "vara-recruited", companionId: "vara", requiredEvent: "tend:vara", recruit: true, bond: 10 },
  { id: "vara-basin-care", companionId: "vara", requiredEvent: "tend:canopy-vara", bond: 5 },
  { id: "vara-first-mark", companionId: "vara", requiredEvent: "semantic:bird-mark", bond: 5, storyFlag: "marked-first-threat" },
  { id: "koro-recruited", companionId: "koro", requiredEvent: "encounter:encounter-koro", recruit: true, bond: 10 },
  { id: "koro-water-restored", companionId: "koro", requiredEvent: "ecology:canopy-waterwheel", bond: 5 },
  { id: "koro-monkeys-freed", companionId: "koro", requiredEvent: "interaction:monkey-rescue", bond: 5 },
  { id: "koro-seeds-shared", companionId: "koro", requiredEvent: "interaction:orchard-seeds", bond: 5 },
  { id: "koro-bond-pact", companionId: "koro", requiredEvent: "choice:koro-pact:bond", bond: 15, storyFlag: "koro-pact-bond" },
  { id: "asha-recruited", companionId: "asha", requiredEvent: "encounter:encounter-asha", recruit: true, bond: 10 },
  { id: "asha-cub-freed", companionId: "asha", requiredEvent: "rescue:tali:tali-cage", bond: 10 },
  { id: "asha-cub-sheltered", companionId: "asha", requiredEvent: "rescue:tali:tali-shelter", bond: 5 },
  { id: "asha-bond-pact", companionId: "asha", requiredEvent: "choice:asha-pact:bond", bond: 15, storyFlag: "asha-pact-bond" },
];

/**
 * Authored chapter runtime data for Chapters 3–8 plus the Grove Fall (chapter 6) and Refuge (chapter 7) segments and
 * their return-journey counterparts. Each segment points at canonical nav nodes / camera anchors / encounter entries
 * already present in `levels/later-acts.ts`. The encounter entry's center sits on the placed actor instance; the
 * pre-fight checkpoint is the nearest safe authored nav node that triggers the entry, not an app-invented teleport.
 */
export const LATER_CHAPTER_RUNTIME: readonly ChapterRuntimeDefinition[] = [
  {
    segmentId: "moonpine", chapter: 3, regionId: "moonpine-ridge", layoutRevision: LATER_ACT_LAYOUT_REVISION,
    checkpoints: [
      checkpoint("moonpine-arrival", "moonpine-ridge", "entry", "ridge-trail-rail", 5),
      checkpoint("moonpine-shelter", "moonpine-ridge", "wolf-shelf", "ridge-trail-rail", 5, ["rescued:pack-pups"]),
      checkpoint("moonpine-chain", "moonpine-ridge", "chain-base", "ridge-trail-rail", 4, ["interaction:temple-restraints"]),
      checkpoint("moonpine-pre-ruun", "moonpine-ridge", "temple", "ruun-chain-arena", 6, ["interaction:temple-restraints"], "encounter-ruun"),
      checkpoint("moonpine-post-ruun", "moonpine-ridge", "temple-heart", "ruun-chain-arena", 6, ["encounter-ruun-cleansed"]),
    ],
    encounterEntries: [
      entry("ruun-entry", "encounter-ruun", "moonpine-ridge", "the-alpha-below:counter-howl", v(25, 13, 7), 9, "moonpine-pre-ruun", ["interaction:temple-restraints"]),
    ],
    exitRequirements: [
      "quest:the-third-howl", "quest:two-packs", "quest:the-alpha-below",
      "choice:pack-leadership",
    ],
  },
  {
    segmentId: "mistveil", chapter: 4, regionId: "mistveil-basin", layoutRevision: LATER_ACT_LAYOUT_REVISION,
    checkpoints: [
      checkpoint("mistveil-arrival", "mistveil-basin", "west-bank", "mist-reed-channel", 6),
      checkpoint("mistveil-tracks", "mistveil-basin", "reed-path", "mist-reed-channel", 6, ["interaction:mist-eyes"]),
      checkpoint("mistveil-river", "mistveil-basin", "river-step", "extraction-ledger", 5, ["traversed:river-upstream"]),
      checkpoint("mistveil-pre-ghor", "mistveil-basin", "cavern-lip", "ghor-river-arena", 6, ["traversed:polluted-source"], "encounter-ghor"),
      checkpoint("mistveil-post-ghor", "mistveil-basin", "ghor-arena", "ghor-river-arena", 7, ["encounter-ghor-cleansed"]),
    ],
    encounterEntries: [
      entry("ghor-entry", "encounter-ghor", "mistveil-basin", "the-mire-maw:ghor-encounter", v(62, -1, 10), 9, "mistveil-pre-ghor", ["traversed:polluted-source"]),
    ],
    exitRequirements: [
      "quest:eyes-in-the-mist", "quest:the-black-river", "quest:the-mire-maw",
      "choice:river-route", "restoration:mistveil-basin:restored",
    ],
  },
  {
    segmentId: "sunmane", chapter: 5, regionId: "sunmane-expanse", layoutRevision: LATER_ACT_LAYOUT_REVISION,
    checkpoints: [
      checkpoint("sunmane-arrival", "sunmane-expanse", "plains-entry", "migration-corridor", 6),
      checkpoint("sunmane-tribute", "sunmane-expanse", "migration-gate", "migration-corridor", 5, ["interaction:tribute-record"]),
      checkpoint("sunmane-council", "sunmane-expanse", "council-approach", "council-court", 5, ["traversed:herd-route"]),
      checkpoint("sunmane-pre-solkar", "sunmane-expanse", "council-approach", "council-court", 6, ["interaction:solkar-echo"], "encounter-solkar"),
      checkpoint("sunmane-post-solkar", "sunmane-expanse", "high-terrace", "council-court", 6, ["encounter-solkar-cleansed"]),
    ],
    encounterEntries: [
      entry("solkar-entry", "encounter-solkar", "sunmane-expanse", "the-lions-offer:counter-roar", v(49, 9, 4), 8, "sunmane-pre-solkar", ["interaction:solkar-echo"]),
    ],
    exitRequirements: [
      "quest:the-silent-plains", "quest:tribute-of-teeth", "quest:the-lions-offer",
      "choice:sunmane-resolution",
    ],
  },
  {
    segmentId: "grove-fall", chapter: 6, regionId: "the-grove", layoutRevision: ACT_I_LAYOUT_REVISION,
    checkpoints: [
      checkpoint("grove-fall-arrival", "the-grove", "grove-trial-glade", "grove-trial-arrival-rail", 5),
      checkpoint("grove-fall-possession", "the-grove", "grove-trial-glade-east", "grove-trial-glade-rail", 4, ["interaction:warden-call"], "encounter-fall"),
      checkpoint("grove-fall-services", "the-grove", "grove-trial-camp", "grove-trial-camp-rail", 5, ["interaction:grove-services"]),
      checkpoint("grove-fall-refuge", "the-grove", "grove-trial-lookouts", "grove-trial-lookout-rail", 4),
    ],
    encounterEntries: [
      // Encounter-fall: authored entry paired with the `protect-tali` objective (the active objective when the
      // player reaches the possession checkpoint). Pre-fight checkpoint `grove-fall-possession` requires the
      // `interaction:warden-call` interaction (which gameplay's possession engine drives). The encounter center sits
      // on the authored Heartroot glade-east position; gameplay starts the encounter with the present possessable
      // recruit list (`asha`, `koro`, `sable`, `nyra`, `solkar`) and never targets Tali. The entry's
      // `objectiveId` ensures `isObjectiveActive` gates the trigger on the live protect-tali beat; the entry's
      // `requiresFacts` holds only raw world-fact keys.
      entry("fall-entry", "encounter-fall", "the-grove", "fall-of-the-grove:protect-tali", v(17, 0, 0), 9, "grove-fall-possession",
        ["interaction:warden-call"]),
    ],
    exitRequirements: [
      "objective:fall-of-the-grove:protect-tali",
      "objective:fall-of-the-grove:brace-pillar",
      "objective:fall-of-the-grove:refuge-services",
      "choice:chapter-six-response",
    ],
  },
  {
    segmentId: "refuge", chapter: 7, regionId: "refuge", layoutRevision: LATER_ACT_LAYOUT_REVISION,
    checkpoints: [
      checkpoint("refuge-arrival", "refuge", "refuge-entry", "refuge-relocated-services", 5),
      checkpoint("refuge-services", "refuge", "service-court", "refuge-relocated-services", 5, ["interaction:refuge-services"]),
      checkpoint("refuge-council", "refuge", "council-landing", "refuge-council-landing", 5, ["interaction:refuge-council"]),
      checkpoint("refuge-formation", "refuge", "collapse-rim", "refuge-council-landing", 5, ["choice:wild-march-formation"]),
    ],
    encounterEntries: [],
    // Refuge ordinary exits are gated by the `refugeOpen` route unlockFact (earned by completing the Fall). The
    // Hollow exit is separately gated by the `hollow-opening` route unlockFact, which the Director derives from the
    // authorized formation choice. We do NOT pre-require the five return quests: the player leaves Refuge to perform
    // each return journey, so the segment's exit requirements must allow that exit. Individual accept/decline decisions
    // belong to the `chapter-seven-commitment` choice flow and are not prerequisites for leaving the Refuge.
    exitRequirements: [
      "interaction:refuge-services",
      "choice:chapter-six-response",
    ],
  },
  // Return regions are also transit corridors to earlier regions. Their sequential quest chain and formation choice
  // gate completion; requiring each local return quest before departure traps the player before reaching the first.
  {
    segmentId: "return-canopy", chapter: 7, regionId: "whispering-canopy", layoutRevision: ACT_I_LAYOUT_REVISION,
    checkpoints: [
      checkpoint("return-canopy-arrival", "whispering-canopy", "canopy-trial-start", "canopy-trial-basin-rail", 4),
      checkpoint("return-canopy-bridge", "whispering-canopy", "canopy-trial-roost", "canopy-trial-roost-rail", 5, ["interaction:seed-route"]),
    ],
    encounterEntries: [],
    exitRequirements: [],
  },
  {
    segmentId: "return-bamboo", chapter: 7, regionId: "blood-bamboo-valley", layoutRevision: ACT_I_LAYOUT_REVISION,
    checkpoints: [
      checkpoint("return-bamboo-arrival", "blood-bamboo-valley", "bamboo-canopy-gateway", "bamboo-valley-entry-rail", 4),
      checkpoint("return-bamboo-corridor", "blood-bamboo-valley", "bamboo-asha-arena", "bamboo-shelter-rail", 5, ["rescued:tali:nursery-return"]),
    ],
    encounterEntries: [],
    exitRequirements: [],
  },
  {
    segmentId: "return-moonpine", chapter: 7, regionId: "moonpine-ridge", layoutRevision: LATER_ACT_LAYOUT_REVISION,
    checkpoints: [
      checkpoint("return-moonpine-arrival", "moonpine-ridge", "entry", "ridge-trail-rail", 5),
      checkpoint("return-moonpine-summit", "moonpine-ridge", "summit", "ridge-trail-rail", 5, ["interaction:two-generation-howl"]),
    ],
    encounterEntries: [],
    exitRequirements: [],
  },
  {
    segmentId: "return-mistveil", chapter: 7, regionId: "mistveil-basin", layoutRevision: LATER_ACT_LAYOUT_REVISION,
    checkpoints: [
      checkpoint("return-mistveil-arrival", "mistveil-basin", "west-bank", "mist-reed-channel", 6),
      checkpoint("return-mistveil-corridor", "mistveil-basin", "cavern-lip", "mist-reed-channel", 6, ["interaction:reed-corridor"]),
    ],
    encounterEntries: [],
    exitRequirements: [],
  },
  {
    segmentId: "return-sunmane", chapter: 7, regionId: "sunmane-expanse", layoutRevision: LATER_ACT_LAYOUT_REVISION,
    checkpoints: [
      checkpoint("return-sunmane-arrival", "sunmane-expanse", "plains-entry", "migration-corridor", 6),
      checkpoint("return-sunmane-gate", "sunmane-expanse", "migration-gate", "migration-corridor", 5, ["interaction:open-crossing"]),
    ],
    encounterEntries: [],
    exitRequirements: [],
  },
  {
    segmentId: "hollow", chapter: 8, regionId: "heartroot-hollow", layoutRevision: LATER_ACT_LAYOUT_REVISION,
    checkpoints: [
      checkpoint("hollow-mouth", "heartroot-hollow", "hollow-mouth", "hollow-six-species-approach", 6),
      checkpoint("hollow-memory", "heartroot-hollow", "memory-floor", "hollow-memory-cavern", 5, ["interaction:hollow-memory-sky"]),
      checkpoint("hollow-bridge", "heartroot-hollow", "sixfold-bridge", "hollow-memory-cavern", 5, ["interaction:hollow-memory-canopy"]),
      checkpoint("hollow-cavern", "heartroot-hollow", "cavern-floor", "hollow-memory-cavern", 5, ["interaction:hollow-memory-pack"]),
      checkpoint("hollow-crown-landing", "heartroot-hollow", "crown-landing", "orun-crown-arena", 5, ["interaction:hollow-memory-shadow"]),
      checkpoint("hollow-pre-orun", "heartroot-hollow", "crown-landing", "orun-crown-arena", 6, ["interaction:hollow-memory-crown"], "encounter-orun"),
      checkpoint("hollow-post-orun", "heartroot-hollow", "orun-arena", "orun-crown-arena", 6, ["encounter-orun-cleansed"]),
    ],
    encounterEntries: [
      entry("orun-entry", "encounter-orun", "heartroot-hollow", "orun-the-hollow-king:resolve-orun", v(17, -7, -45), 10, "hollow-pre-orun", ["interaction:hollow-memory-crown"]),
    ],
    exitRequirements: [
      "quest:heartroot-hollow",
      "interaction:hollow-memory-sky", "interaction:hollow-memory-canopy", "interaction:hollow-memory-fang",
      "interaction:hollow-memory-pack", "interaction:hollow-memory-shadow", "interaction:hollow-memory-crown",
      "quest:orun-the-hollow-king",
      "choice:final-ending",
    ],
  },
];

/** Later-act layout migrations are revision-0 → revision-1; the geometry itself is the first authored version, so every node id stays valid. */
export const LATER_ACT_LAYOUT_MIGRATIONS: readonly LayoutRevisionMigration[] = [
  { regionId: "moonpine-ridge", fromRevision: 0, toRevision: LATER_ACT_LAYOUT_REVISION, nodeMap: {}, fallbackNodeId: "entry" },
  { regionId: "mistveil-basin", fromRevision: 0, toRevision: LATER_ACT_LAYOUT_REVISION, nodeMap: {}, fallbackNodeId: "west-bank" },
  { regionId: "sunmane-expanse", fromRevision: 0, toRevision: LATER_ACT_LAYOUT_REVISION, nodeMap: {}, fallbackNodeId: "plains-entry" },
  { regionId: "refuge", fromRevision: 0, toRevision: LATER_ACT_LAYOUT_REVISION, nodeMap: {}, fallbackNodeId: "refuge-entry" },
  { regionId: "heartroot-hollow", fromRevision: 0, toRevision: LATER_ACT_LAYOUT_REVISION, nodeMap: {}, fallbackNodeId: "hollow-mouth" },
];

/** Later-act companion relationship awards keyed to producible authored events (objective event grammar). */
export const LATER_ACT_RELATIONSHIP_RULES: readonly CompanionRelationshipRule[] = [
  { id: "nyra-truth-heard", companionId: "nyra", requiredEvent: "semantic:nyra-truth", bond: 10, storyFlag: "nyra-truth-heard" },
  { id: "solkar-voluntary-bond", companionId: "solkar", requiredEvent: "choice:sunmane-resolution:bond", bond: 15, storyFlag: "solkar-voluntary-bond" },
  { id: "solkar-exile-council", companionId: "solkar", requiredEvent: "choice:sunmane-resolution:exile", storyFlag: "solkar-exiled" },
];

/** Authored chapter runtime the Director is configured with. Combines Act I and later acts into one durable list. */
export const CHAPTER_RUNTIME: readonly ChapterRuntimeDefinition[] = [
  ...ACT_I_CHAPTER_RUNTIME,
  ...LATER_CHAPTER_RUNTIME,
];

/** Authored layout migrations the SaveRepository validates against. Combines Act I and later-act revisions. */
export const LAYOUT_MIGRATIONS: readonly LayoutRevisionMigration[] = [
  ...ACT_I_LAYOUT_MIGRATIONS,
  ...LATER_ACT_LAYOUT_MIGRATIONS,
];

/** Authored one-shot Bond/recruitment awards the Director applies. Combines Act I and later acts. */
export const RELATIONSHIP_RULES: readonly CompanionRelationshipRule[] = [
  ...ACT_I_RELATIONSHIP_RULES,
  ...LATER_ACT_RELATIONSHIP_RULES,
];
