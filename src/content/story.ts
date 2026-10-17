import type {
  DialogueBeat,
  ObjectiveDefinition,
  RegionId,
} from "../game/contracts.js";
import { DIALOGUE, QUESTS } from "./campaign.js";

export interface ChapterDefinition {
  id: string;
  number: number;
  title: string;
  regionId: RegionId;
  synopsis: string;
  questIds: readonly string[];
  requiredBeats: readonly string[];
  objectives?: readonly ObjectiveDefinition[];
  choices: readonly string[];
  absenceVariants: readonly { when: string; route: string }[];
  returnFromRegion?: RegionId;
}
const objective = (
  id: string,
  title: string,
  description: string,
  events: string[],
  mechanic: ObjectiveDefinition["mechanic"],
  targets: string[],
): ObjectiveDefinition => ({
  id: id as never,
  title,
  description,
  requiredEvents: events,
  targetIds: targets,
  mechanic,
});
export const CHAPTERS: readonly ChapterDefinition[] = [
  {
    id: "prologue",
    number: 0,
    title: "The Night of a Thousand Roars",
    regionId: "greenwake",
    synopsis:
      "Aren receives Sky from the fallen Vara, takes up the Warden Staff, and learns that the animals flee something below Erya.",
    questIds: ["prologue"],
    requiredBeats: ["prologue-opening", "prologue-vision", "greenwake-cleanse"],
    choices: [],
    absenceVariants: [
      {
        when: "vara-absent",
        route:
          "The Sky fragment remains in the nest where Vara fell; interact with the visible feather-marked nest and heal her before the fragment can be received.",
      },
    ],
    objectives: [
      objective(
        "prologue:hear-roars",
        "Hear the night of a thousand roars",
        "Observe fleeing animals and locate the sound beneath Greenwake.",
        ["semantic:greenwake-roars"],
        "investigate",
        ["greenwake-roars"],
      ),
      objective(
        "prologue:tend-vara",
        "Tend to Vara",
        "Reach the fallen harpy eagle and tend the wing that brought Sky.",
        ["tend:vara"],
        "rescue",
        ["vara"],
      ),
      objective(
        "prologue:receive-sky",
        "Receive Sky and witness its memory",
        "Touch the fragment and hear the plea it carries: BRING THEM HOME.",
        ["fragment:heartroot-sky"],
        "collect",
        ["vara-fragment"],
      ),
      objective(
        "prologue:take-staff",
        "Receive Yara’s Warden Staff",
        "Accept the staff and learn its first interaction.",
        ["interaction:warden-staff"],
        "interact",
        ["warden-staff"],
      ),
      objective(
        "prologue:cleanse-boar",
        "Cleanse the corrupted boar",
        "Read its charge, tether the exposed boar and cleanse it without killing it.",
        ["encounter:greenwake-boar"],
        "encounter",
        ["corrupted-boar"],
      ),
      objective(
        "prologue:open-gate",
        "Open the settlement gate",
        "With the boar cleansed, use the Warden Staff on the ridge gate to open the way to the forest exit.",
        ["interaction:greenwake-gate"],
        "interact",
        ["greenwake-gate"],
      ),
    ],
  },
  {
    id: "chapter-1",
    number: 1,
    title: "Whispering Canopy",
    regionId: "whispering-canopy",
    synopsis:
      "Birds and monkeys contest seeds and poisoned water. Aren learns that a clean wound cannot replace the resources the orchard needs.",
    questIds: ["fallen-scout", "thief-in-the-branches", "empty-orchard"],
    requiredBeats: ["fallen-scout-open", "fallen-scout-close", "branches-open", "branches-close", "orchard-open", "koro-thorn-reveal", "koro-cleanse", "koro-pact-close", "orchard-close"],
    choices: ["koro-pact"],
    absenceVariants: [
      {
        when: "koro-absent",
        route:
          "The orchard waterwheel jam is cleared with a heavy staff strike; no route requires Koro to be recruited first.",
      },
      {
        when: "vara-absent",
        route:
          "Bird Mark lesson is delivered through ground tracks and a visible landing marker; Vara remains an injured NPC until tended.",
      },
    ],
  },
  {
    id: "chapter-2",
    number: 2,
    title: "Blood Bamboo Valley",
    regionId: "blood-bamboo-valley",
    synopsis:
      "A trail of broken bamboo leads to the Ash Hunters. Aren rescues Tali and cleanses Asha without treating the mother’s fear as malice.",
    questIds: ["tracks-without-blood", "the-ash-hunters", "a-mothers-roar"],
    requiredBeats: [
      "tracks-open",
      "hunters-open",
      "marek-escape",
      "tali-rescue",
      "asha-echo",
      "tali-shelter-warning",
      "asha-phase-three",
      "asha-close",
      "asha-pact-close",
      "bamboo-source-cleansed",
    ],
    choices: ["asha-pact"],
    absenceVariants: [
      {
        when: "koro-absent",
        route:
          "The bamboo bundle at Asha’s arena is cut free by a staff heavy strike when Koro is not assigned; Koro’s special is optional.",
      },
      {
        when: "asha-absent",
        route:
          "The tiger boss remains an encounter; Asha is not required as an ally for the cleansing route.",
      },
      {
        when: "tali-rescue-failed",
        route:
          "Reset to the safe checkpoint before the camp encounter. Tali has no permanent-death state.",
      },
    ],
  },
  {
    id: "chapter-3",
    number: 3,
    title: "Moonpine Ridge",
    regionId: "moonpine-ridge",
    synopsis:
      "Ruun’s three-beat howl splits an old pack from Luma’s reformers. Aren protects both groups before the pack decides its leadership.",
    questIds: ["the-third-howl", "two-packs", "the-alpha-below"],
    requiredBeats: ["howl-open", "two-packs-open", "ruun-open", "ruun-close"],
    choices: ["ruun", "luma", "dominion-ruun", "dominion-luma"],
    absenceVariants: [
      {
        when: "ruun-absent",
        route:
          "The buried temple echo remains interactive; the Pack council resolves leadership without loading Ruun as a companion.",
      },
      {
        when: "luma-absent",
        route:
          "Ruun’s existing followers can still vote for a steward; the player-only restraint and howl counters remain.",
      },
    ],
  },
  {
    id: "chapter-4",
    number: 4,
    title: "Mistveil Basin",
    regionId: "mistveil-basin",
    synopsis:
      "Mist and accusation conceal Nyra’s effort to contain infection. The Black River’s source is a choice, not a monster’s fault.",
    questIds: ["eyes-in-the-mist", "the-black-river", "the-mire-maw"],
    requiredBeats: [
      "mist-eyes-open",
      "river-open",
      "marek-variant",
      "ghor-open",
      "ghor-close",
    ],
    choices: [
      "marek-cleanse",
      "marek-leave",
      "river-break-dam",
      "river-repair",
    ],
    absenceVariants: [
      {
        when: "marek-absent",
        route:
          "An abandoned field ledger and visible sampling rig identify the source; neither Marek nor his quest is required for Hollow information.",
      },
      {
        when: "nyra-absent",
        route:
          "The trail evidence and Echo imprint provide the same protected corridor; Nyra’s optional counter assist is omitted.",
      },
      {
        when: "vara-absent",
        route:
          "Ground bubbles, reeds and Ghor audio cues remain sufficient to read land-water attack transitions.",
      },
    ],
  },
  {
    id: "chapter-5",
    number: 5,
    title: "Sunmane Expanse",
    regionId: "sunmane-expanse",
    synopsis:
      "Solkar’s peaceful plains are held by compulsory tribute and closed migration. Aren confronts his offer through Echo Sense and chooses a voluntary settlement, exile with council, or Dominion.",
    questIds: ["the-silent-plains", "tribute-of-teeth", "the-lions-offer"],
    requiredBeats: [
      "plains-open",
      "tribute-open",
      "solkar-echo",
      "solkar-choice",
    ],
    choices: ["bond", "exile", "dominion"],
    absenceVariants: [
      {
        when: "solkar-exiled",
        route:
          "Crown representation is fulfilled by a voluntary council; no lion companion or Solkar actor is spawned.",
      },
      {
        when: "solkar-absent",
        route:
          "The council and physical tribute records carry the story and Crown fragment; player-only counters remain available.",
      },
    ],
  },
  {
    id: "chapter-6",
    number: 6,
    title: "The Fall of the Grove",
    regionId: "the-grove",
    synopsis:
      "Orun turns the call against its wielder. Yara severs the coercive channel, Tali is protected, and Grove services relocate intact to the Refuge.",
    questIds: ["fall-of-the-grove"],
    requiredBeats: ["chapter-six", "grove-possession", "refuge-opening"],
    objectives: [
      objective(
        "chapter-6:protect-tali",
        "Protect Tali and the refuge pillars",
        "Keep Tali safe and set the refuge pillars after the possession.",
        ["rescue:tali-safe", "interaction:refuge-services"],
        "rescue",
        ["tali", "refuge-services"],
      ),
    ],
    choices: ["ask", "signal"],
    absenceVariants: [
      {
        when: "tali-unsafe",
        route:
          "The game restores the pre-rescue checkpoint and repeats the encounter with the threat clearly signaled.",
      },
      {
        when: "companion-absent",
        route:
          "Every shelter and pillar has a hand-operated intervention; chosen assistants shorten windows but do not gate progress.",
      },
    ],
  },
  {
    id: "chapter-7",
    number: 7,
    title: "The Living Pact",
    regionId: "refuge",
    synopsis:
      "Five return journeys turn earlier obligations into changed routes. Each faction may renew its commitment; the Wild March forms only from those who choose to join.",
    questIds: [
      "seeds-on-the-wind",
      "a-path-for-the-young",
      "one-howl-two-generations",
      "witness-in-the-reeds",
      "the-open-crossing",
      "wild-march",
    ],
    requiredBeats: ["chapter-seven"],
    objectives: [
      objective(
        "chapter-7:form-march",
        "Form the Wild March by voluntary commitments",
        "Ask each faction in turn whether it will march; every answer is its own.",
        ["choice:wild-march-formation"],
        "choice",
        ["wild-march"],
      ),
    ],
    choices: [
      "recommit-sky",
      "recommit-canopy",
      "recommit-fang",
      "recommit-pack",
      "recommit-shadow",
      "recommit-crown",
    ],
    absenceVariants: [
      {
        when: "marek-absent",
        route:
          "Witness in the Reeds uses the marked hand-operated release bypass.",
      },
      {
        when: "solkar-exiled",
        route:
          "The Crown council chooses representation and may independently renew its commitment.",
      },
      {
        when: "dominion-history-present",
        route:
          "Dominated factions can join the march under explicit history, but that history still locks the Living Pact ending.",
      },
    ],
  },
  {
    id: "chapter-8",
    number: 8,
    title: "Heartroot Hollow",
    regionId: "heartroot-hollow",
    synopsis:
      "Aren traverses six playable memories, confronts Orun’s mirrored aspects, and chooses what the Crown may mean.",
    questIds: ["heartroot-hollow", "orun-the-hollow-king"],
    requiredBeats: [
      "hollow-opening",
      "hollow-aspect-sky",
      "hollow-aspect-canopy",
      "hollow-aspect-fang",
      "hollow-aspect-pack",
      "hollow-aspect-shadow",
      "hollow-aspect-crown",
      "ending-choice",
    ],
    objectives: [
      objective(
        "chapter-8:resolve-aspects",
        "Resolve all six Heartroot aspects",
        "Answer each aspect with your own hand; companions can ease the way but are never the key.",
        ["encounter:encounter-orun"],
        "encounter",
        ["orun"],
      ),
      objective(
        "chapter-8:choose-ending",
        "Choose an ending after the final encounter",
        "Dominion and Severance stand open to you; the Living Pact answers only to what you have earned.",
        ["choice:final-ending"],
        "choice",
        ["hollow-crown-choice"],
      ),
    ],
    choices: ["dominion", "severance", "living_pact"],
    absenceVariants: [
      {
        when: "any-companion-absent",
        route:
          "Each aspect exposes a direct player-only counter window; companion actions reveal or shorten it but are optional.",
      },
      {
        when: "solkar-exiled",
        route:
          "The Crown memory is represented by a council echo, not by a returned Solkar.",
      },
      {
        when: "marek-absent",
        route:
          "Yara’s root-map and the cleared river current lead to Hollow without Marek.",
      },
    ],
  },
];
export const RETURN_BEATS =
  CHAPTERS.find((chapter) => chapter.number === 7)!.questIds.filter(
    (questId) => questId !== "wild-march",
  );
const additional = (id: string, lead: string, reply: string): DialogueBeat => ({
  id,
  lines: [
    { id: id + "-lead", speaker: "aren", text: lead, delivery: "spoken" },
    { id: id + "-reply", speaker: "yara", text: reply, delivery: "spoken" },
  ],
});
const ADDITIONAL_DIALOGUE: Readonly<Record<string, DialogueBeat>> = {
  "the-empty-nest-opening": additional(
    "the-empty-nest-opening",
    "The broken branch still holds a feather. I can rebuild the nest without closing the path to the others.",
    "Restore the branch first, then let the birds choose whether to use it.",
  ),
  "the-empty-nest-resolution": additional(
    "the-empty-nest-resolution",
    "The roost is secure, but the new perch is an invitation—not a command.",
    "That distinction is what makes a safe place worth returning to.",
  ),
  "the-last-cub-opening": additional(
    "the-last-cub-opening",
    "This is not Tali’s rescue again. The nursery needs a safe route for every cub.",
    "Follow the traps to their source; clearing only what you can see leaves the next group at risk.",
  ),
  "the-last-cub-resolution": additional(
    "the-last-cub-resolution",
    "The last cub crossed without a snare in reach. Asha can choose where she is needed now.",
    "Safety is a promise kept by the route, not a reward spoken over it.",
  ),
  "a-pack-divided-opening": additional(
    "a-pack-divided-opening",
    "They can share one hunt without agreeing on every rule. I should ask what each group can contribute.",
    "Coordinate the route so neither generation carries the whole risk.",
  ),
  "a-pack-divided-resolution": additional(
    "a-pack-divided-resolution",
    "Both patrols returned with food and scouts. No one had to win the argument first.",
    "A shared task can make room for a harder conversation later.",
  ),
  "the-silent-hunter-opening": additional(
    "the-silent-hunter-opening",
    "These marks turn away from the injured animals. The trail looks more like a boundary than a trophy path.",
    "Follow the sign before deciding who is responsible.",
  ),
  "the-silent-hunter-resolution": additional(
    "the-silent-hunter-resolution",
    "The corridor is marked for passage, not ownership.",
    "Now the hidden route protects the ones who use it.",
  ),
  "a-king-without-subjects-opening": additional(
    "a-king-without-subjects-opening",
    "A refusal is the one answer Solkar’s system cannot make room for.",
    "Ask him to listen without changing the answer he hears.",
  ),
  "a-king-without-subjects-resolution": additional(
    "a-king-without-subjects-resolution",
    "He heard a no and did not make it disappear. That is a beginning, not forgiveness.",
    "Trust grows only when a refusal can remain a refusal.",
  ),
  "river-of-black-sap-opening": additional(
    "river-of-black-sap-opening",
    "A fast release will flood the lower path. A repair will take longer but keep the crossing usable.",
    "Choose after reading the banks and the people who rely on each route.",
  ),
  "river-of-black-sap-resolution": additional(
    "river-of-black-sap-resolution",
    "The river now follows the path we chose, and the floodplain has changed with it.",
    "The source is quiet; the water still needs time to settle.",
  ),
  "the-hunters-remorse-opening": additional(
    "the-hunters-remorse-opening",
    "If Marek is gone, the trap ledger still marks every supply line. We can dismantle them ourselves.",
    "His help would be welcome. His absence will not stop us.",
  ),
  "the-hunters-remorse-resolution": additional(
    "the-hunters-remorse-resolution",
    "The trap line is disabled. No one needed to trust its maker to make the path safer.",
    "That is enough to protect the next journey.",
  ),
  "seeds-between-branches-opening": additional(
    "seeds-between-branches-opening",
    "The birds need seed for the winter; the monkeys need enough to restart the orchard.",
    "Carry the baskets across in turn so neither store is emptied.",
  ),
  "seeds-between-branches-resolution": additional(
    "seeds-between-branches-resolution",
    "Both nurseries have seed left to grow.",
    "Sharing did not mean giving everything away.",
  ),
  "the-broken-snare-trail-opening": additional(
    "the-broken-snare-trail-opening",
    "These traps all point back to one supply line. I will follow it before clearing the last visible loop.",
    "A safe shortcut is not safe if the source keeps replacing it.",
  ),
  "the-broken-snare-trail-resolution": additional(
    "the-broken-snare-trail-resolution",
    "The source is disabled. The path is now clear for the young to travel.",
    "A route can carry the proof that a promise was kept.",
  ),
  "winter-stores-opening": additional(
    "winter-stores-opening",
    "The exposed cache will not last through the ridge wind. Move it before setting the patrol route.",
    "Shelter first, then ask both groups to share responsibility.",
  ),
  "winter-stores-resolution": additional(
    "winter-stores-resolution",
    "The stores are sheltered and both patrols know where they can find them.",
    "Preparation is a kind of care the pack can see.",
  ),
  "the-last-crossing-opening": additional(
    "the-last-crossing-opening",
    "The herd can cross only if the lion hunting ground is not the passage.",
    "Read the migration marks and open the safe gate before calling them forward.",
  ),
  "the-last-crossing-resolution": additional(
    "the-last-crossing-resolution",
    "The crossing is open and the herd chose to use it.",
    "A path does not become a promise until someone can choose it.",
  ),
  "roots-we-share-opening": additional(
    "roots-we-share-opening",
    "The water map and training markers can move with us. The Grove’s services do not have to be lost.",
    "Set each station at the Refuge before the next attack begins.",
  ),
  "roots-we-share-resolution": additional(
    "roots-we-share-resolution",
    "The Refuge is ready to welcome people without pretending the Grove survived untouched.",
    "Continuity is not the same as denying loss.",
  ),
  "seeds-on-the-wind-opening": additional(
    "seeds-on-the-wind-opening",
    "The restored orchard has a living bridge, but the blocked root path still needs a water repair first.",
    "Let the birds and monkeys carry seed together, and read the route before sending them.",
  ),
  "seeds-on-the-wind-resolution": additional(
    "seeds-on-the-wind-resolution",
    "The baskets crossed the root path. The orchard changed the route instead of just the view.",
    "Every return should show what earlier work made possible.",
  ),
  "a-path-for-the-young-opening": additional(
    "a-path-for-the-young-opening",
    "Tali knows the nursery trail. We will follow her pace and clear the snares ahead.",
    "Asha will guard the young or lead the march, depending on the promise she made.",
  ),
  "a-path-for-the-young-resolution": additional(
    "a-path-for-the-young-resolution",
    "The young crossed safely; no one was asked to risk them as a test.",
    "The route belongs to those who must use it.",
  ),
  "one-howl-two-generations-opening": additional(
    "one-howl-two-generations-opening",
    "Set the two signal points far enough apart that both generations can answer.",
    "The chosen leader changes the patrol formation; the signal itself belongs to the pack.",
  ),
  "one-howl-two-generations-resolution": additional(
    "one-howl-two-generations-resolution",
    "The same call came back from both ridges.",
    "They have not become identical. They have agreed on a way to hear one another.",
  ),
  "witness-in-the-reeds-opening": additional(
    "witness-in-the-reeds-opening",
    "Nyra marked the low-contamination corridor. If Marek is gone, the hand release is still here.",
    "Use the bypass; this crossing does not have to wait for anyone.",
  ),
  "witness-in-the-reeds-resolution": additional(
    "witness-in-the-reeds-resolution",
    "The reeds open a passage around the old source.",
    "What happened here remains visible, but it no longer dictates every step.",
  ),
  "the-open-crossing-opening": additional(
    "the-open-crossing-opening",
    "Solkar can limit his authority, or the council can divide the decision.",
    "The herd chooses when to move; neither settlement should choose for them.",
  ),
  "the-open-crossing-resolution": additional(
    "the-open-crossing-resolution",
    "The migration passage is open. Solkar is not summoned back if the council now represents Crown.",
    "Representation is a choice made by those who live with its consequences.",
  ),
  "fall-of-the-grove-opening": additional(
    "fall-of-the-grove-opening",
    "The pillar is failing. Keep Tali in cover, then brace the root before the next pulse.",
    "Use the ground lever if no companion is beside you; the shelter holds either way.",
  ),
  "fall-of-the-grove-resolution": additional(
    "fall-of-the-grove-resolution",
    "The Grove has fallen, but its services reached the Refuge.",
    "A loss can be real without closing the road ahead.",
  ),
  "wild-march-opening": additional(
    "wild-march-opening",
    "Ask each group separately. A refusal changes who joins, not whether the campaign can continue.",
    "The march is a coalition, not a promise; the Living Pact still has to be earned.",
  ),
  "wild-march-resolution": additional(
    "wild-march-resolution",
    "Those who chose to join have marked their route. Others remain free to decide later.",
    "No one is counted as willing because they were present.",
  ),
  "heartroot-hollow-opening": additional(
    "heartroot-hollow-opening",
    "Six memories lie ahead. Each one can be answered by your own hand.",
    "Companions can clear the way or shorten it, but they are not the key to the Crown.",
  ),
  "heartroot-hollow-resolution": additional(
    "heartroot-hollow-resolution",
    "Each fragment answers with its own memory.",
    "Carry the differences into the final choice.",
  ),
  "orun-the-hollow-king-opening": additional(
    "orun-the-hollow-king-opening",
    "He mirrors a Warden’s whole stance, not a single strike. Watch for his warning, then choose your answer.",
    "The final choice belongs after the encounter, not as its automatic reward.",
  ),
  "orun-the-hollow-king-resolution": additional(
    "orun-the-hollow-king-resolution",
    "Orun is subdued and the Crown can no longer take a will without answer.",
    "Now the forest can choose what it wants to become.",
  ),
};
export const STORY_DIALOGUE: Readonly<Record<string, DialogueBeat>> = {
  ...DIALOGUE,
  ...ADDITIONAL_DIALOGUE,
};
export const ALL_QUESTS = QUESTS;
export const ENDINGS = {
  dominion: {
    id: "dominion",
    title: "Dominion: The Wild King",
    summary:
      "Aren takes the Root Crown. Conflict ends beneath a single command. The animals bow, and the forest grows silent.",
    grove:
      "The Grove stands in ordered silence. Even the birds wait for permission to fly.",
  },
  severance: {
    id: "severance",
    title: "Severance: The Free Wild",
    summary:
      "Aren breaks the Root Crown. Six fragments return to their regions. Erya remains imperfect, but no one holds the power to command every living creature.",
    grove: "Companions remain by choice. The Grove belongs to no throne.",
  },
  living_pact: {
    id: "living_pact",
    title: "The Living Pact",
    summary:
      "Aren shares the Root Crown among six willing factions. Orun relinquishes power, Yara returns to life, and the Circle of the Wild forms without a throne.",
    grove:
      "Six paths lead out from the Grove. Every people may choose to join the pact or leave it.",
    lines: [
      "So, what will they call you now?",
      "They do not need to call me anything.",
    ],
  },
} as const;
export interface BranchHistory {
  pack: "ruun" | "luma" | "dominion";
  marek: "present" | "absent";
  crown: "bond" | "exile" | "dominion";
}
export const ABSENCE_HISTORY_VARIANTS: readonly string[] = [
  "koro-absent",
  "asha-absent",
  "ruun-absent",
  "luma-absent",
  "nyra-absent",
  "solkar-exiled",
  "marek-absent",
  "vara-absent",
  "multiple-companions-absent",
];
export const BRANCH_HISTORIES: readonly BranchHistory[] = Object.freeze(
  (["ruun", "luma", "dominion"] as const).flatMap((pack) =>
    (["present", "absent"] as const).flatMap((marek) =>
      (["bond", "exile", "dominion"] as const).map((crown) => ({
        pack,
        marek,
        crown,
      })),
    ),
  ),
);
