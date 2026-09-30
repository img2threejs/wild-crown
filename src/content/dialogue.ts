import type { DialogueBeat, DialogueLine } from "../game/contracts.js";

const line = (
  id: string,
  speaker: DialogueLine["speaker"],
  text: string,
  delivery: DialogueLine["delivery"] = "spoken",
  condition?: string,
): DialogueLine => ({
  id,
  speaker,
  text,
  delivery,
  ...(condition ? { condition } : {}),
});

export const DIALOGUE: Readonly<Record<string, DialogueBeat>> = {
  "prologue-vision": {
    id: "prologue-vision",
    lines: [
      line(
        "yara-intro",
        "yara",
        "Before the Crown, the Wild Pact joined many voices without binding them to one.",
      ),
      line("vara-fragment", "echo", "BRING THEM HOME", "echo"),
      line(
        "aren-reply",
        "aren",
        "I heard something beneath the roots. The animals are fleeing it, not one another.",
      ),
    ],
  },
  "fallen-scout-open": {
    id: "fallen-scout-open",
    lines: [
      line(
        "vara-open",
        "aren",
        "You brought the fragment here. Let me help you breathe before I ask you to guide me.",
      ),
      line(
        "vara-reply",
        "echo",
        "A flash of sheltering wings, then a sharp warning beyond the trees.",
        "echo",
      ),
    ],
  },
  "fallen-scout-close": {
    id: "fallen-scout-close",
    lines: [
      line(
        "vara-close",
        "aren",
        "I saw the mark. You do not have to carry the whole forest alone.",
      ),
      line(
        "vara-sign",
        "echo",
        "One bright call answers from the canopy.",
        "echo",
      ),
    ],
  },
  "branches-open": {
    id: "branches-open",
    lines: [
      line(
        "koro-challenge",
        "echo",
        "A quick silhouette above; a branch drops across the path.",
        "echo",
      ),
      line(
        "aren-branch",
        "aren",
        "You want me to follow, not catch you. Fine. I will watch the path you leave behind.",
      ),
    ],
  },
  "branches-close": {
    id: "branches-close",
    lines: [
      line(
        "koro-provisional",
        "echo",
        "A hand steadies the vine, then withdraws before trust is earned.",
        "echo",
      ),
      line(
        "aren-provisional",
        "aren",
        "Thank you for the path. It is help for this moment, not a promise you owe me.",
      ),
    ],
  },
  "orchard-open": {
    id: "orchard-open",
    lines: [
      line(
        "yara-water",
        "yara",
        "The thorn is not the drought. Clear the water, share the seed, then ask what Koro can choose.",
      ),
      line(
        "aren-water",
        "aren",
        "The orchard must be more than clean. The birds and monkeys both need a place in it.",
      ),
    ],
  },
  "orchard-close": {
    id: "orchard-close",
    lines: [
      line(
        "orchard-recovered",
        "aren",
        "The water moves again, the trapped monkeys are free, and the birds shared seed on their terms.",
      ),
      line(
        "orchard-accord",
        "echo",
        "A branch creaks under new growth; the birds answer from above.",
        "echo",
      ),
    ],
  },
  "tracks-open": {
    id: "tracks-open",
    lines: [
      line(
        "yara-tracks",
        "yara",
        "A broken trap can be evidence of escape, not proof of a hunt.",
      ),
      line(
        "aren-tracks",
        "aren",
        "Small prints turn back toward the bamboo. Whoever made these marks is searching for someone.",
      ),
    ],
  },
  "hunters-open": {
    id: "hunters-open",
    lines: [
      line(
        "aren-camp",
        "aren",
        "No one here needs to die. Take away the traps and make room for the cub to leave.",
      ),
      line(
        "marek-taunt",
        "marek",
        "You call it rescue. I call it losing a sample I already paid for.",
      ),
    ],
  },
  "tali-rescue": {
    id: "tali-rescue",
    lines: [
      line(
        "tali-memory",
        "echo",
        "A small paw against iron. Then the scent of ash and a mother calling.",
        "echo",
      ),
      line(
        "aren-rescue",
        "aren",
        "You are safe now. We will let your mother find you at your pace.",
      ),
    ],
  },
  "asha-echo": {
    id: "asha-echo",
    lines: [
      line(
        "asha-existing-phrase",
        "echo",
        "CHILD — TAKEN — BURNING SCENT",
        "echo",
      ),
      line(
        "aren-asha",
        "aren",
        "She hears danger where there is only my approach. I must protect Tali first, then reach the thorn.",
      ),
    ],
  },
  "asha-close": {
    id: "asha-close",
    lines: [
      line(
        "asha-reunion",
        "echo",
        "The cub’s scent meets the mother’s breath; the roar breaks into a low answer.",
        "echo",
      ),
      line(
        "aren-reunion",
        "aren",
        "You found each other. I will not turn your protection into a command.",
      ),
    ],
  },
  "howl-open": {
    id: "howl-open",
    lines: [
      line(
        "sable-howls",
        "echo",
        "Three pulses travel through the ridge: one above, one beside, one below.",
        "echo",
      ),
      line(
        "aren-howls",
        "aren",
        "The third does not fade. It comes from beneath the temple.",
      ),
    ],
  },
  "two-packs-open": {
    id: "two-packs-open",
    lines: [
      line(
        "luma-need",
        "echo",
        "A young voice calls for scouts and room to change course.",
        "echo",
      ),
      line(
        "ruun-need",
        "echo",
        "An older voice answers with shelter, stores, and a boundary held.",
        "echo",
      ),
      line(
        "aren-both",
        "aren",
        "I will hear both fears before I ask either pack to follow.",
      ),
    ],
  },
  "ruun-open": {
    id: "ruun-open",
    lines: [
      line(
        "ruun-howl",
        "echo",
        "Iron chain, sap in the throat, a howl pressed into the roots.",
        "echo",
      ),
      line(
        "aren-ruun",
        "aren",
        "I will break what binds you. The choice of who leads belongs to the pack.",
      ),
    ],
  },
  "ruun-close": {
    id: "ruun-close",
    lines: [
      line("sable-pack", "echo", "Two answers meet in one quiet call.", "echo"),
      line(
        "aren-pack",
        "aren",
        "A leader can carry tradition without making every path return to the same place.",
      ),
    ],
  },
  "mist-eyes-open": {
    id: "mist-eyes-open",
    lines: [
      line(
        "nyra-sign",
        "echo",
        "Eyes withdraw; claw marks circle a Black Sap wound instead of a body.",
        "echo",
      ),
      line(
        "aren-nyra",
        "aren",
        "The evidence points to what she contained, not what she caused. I need to hear her memory.",
      ),
    ],
  },
  "river-open": {
    id: "river-open",
    lines: [
      line(
        "yara-river",
        "yara",
        "Marek’s rig is upstream. The river will not heal while its source keeps feeding the sap.",
      ),
      line(
        "aren-river",
        "aren",
        "The route to Hollow must not depend on Marek’s answer.",
      ),
    ],
  },
  "marek-variant": {
    id: "marek-variant",
    lines: [
      line(
        "marek-present",
        "marek",
        "You can cut the rig and leave me here, or risk cleansing the thing I made.",
        "spoken",
        "marekPresent",
      ),
      line(
        "marek-absent",
        "narrator",
        "Marek is gone. A stamped ledger and the empty rig identify the upstream source.",
        "spoken",
        "!marekPresent",
      ),
    ],
  },
  "ghor-open": {
    id: "ghor-open",
    lines: [
      line(
        "aren-ghor",
        "aren",
        "The river is forcing this creature to defend poisoned water. I will clear the source, not punish the animal.",
      ),
    ],
  },
  "ghor-close": {
    id: "ghor-close",
    lines: [
      line(
        "ghor-calm",
        "echo",
        "The black pulse drains from the water; a heavy shape slips below the clear surface.",
        "echo",
      ),
    ],
  },
  "plains-open": {
    id: "plains-open",
    lines: [
      line(
        "aren-plains",
        "aren",
        "No conflict does not mean no fear. Let us see who is allowed to move.",
      ),
      line(
        "yara-plains",
        "yara",
        "Count the closed crossings and the water withheld, not only the lions standing guard.",
      ),
    ],
  },
  "tribute-open": {
    id: "tribute-open",
    lines: [
      line(
        "herd-testimony",
        "echo",
        "A herd remembers the young taken at the crossing and the water measured by another’s claw.",
        "echo",
      ),
      line(
        "aren-tribute",
        "aren",
        "A quiet field can still be ruled by fear. The passage must open by consent.",
      ),
    ],
  },
  "solkar-echo": {
    id: "solkar-echo",
    lines: [
      line(
        "solkar-existing-philosophy",
        "echo",
        "I made the roads safe. No one starved while I held the water. Why should freedom be worth the fear it brings?",
        "echo",
      ),
      line(
        "aren-solkar",
        "aren",
        "Because safety that cannot be refused is only another name for obedience.",
      ),
    ],
  },
  "solkar-choice": {
    id: "solkar-choice",
    lines: [
      line(
        "solkar-final",
        "echo",
        "Six fragments. One hand. You say you will not rule them—yet you gather power as I did.",
        "echo",
      ),
      line(
        "aren-choice",
        "aren",
        "Then this choice must remain theirs too. I will not decide the ending before the forest can answer.",
      ),
    ],
  },
  "chapter-six": {
    id: "chapter-six",
    lines: [
      line(
        "yara-fall",
        "yara",
        "Orun has taken the Warden’s Call. You cannot command them now.",
      ),
      line(
        "aren-ask-signal",
        "aren",
        "Then I will ask, and I will signal those who choose to answer.",
      ),
      line(
        "tali-failure",
        "narrator",
        "If Tali is endangered, return safely to the checkpoint and try again.",
        "spoken",
        "taliRescueFailed",
      ),
    ],
  },
  "chapter-seven": {
    id: "chapter-seven",
    lines: [
      line(
        "yara-coalition",
        "yara",
        "The Wild March can walk together without becoming one people.",
      ),
      line(
        "aren-coalition",
        "aren",
        "Every group can join, stay behind or change its mind.",
      ),
    ],
  },
  "hollow-opening": {
    id: "hollow-opening",
    lines: [
      line(
        "orun-call",
        "echo",
        "A memory of six voices collapses into one. The roots answer with silence.",
        "echo",
      ),
      line(
        "aren-hollow",
        "aren",
        "I will answer each aspect myself. Help can clear the way, but no companion is required here.",
      ),
    ],
  },
  "ending-living-pact": {
    id: "ending-living-pact",
    lines: [
      line(
        "yara-return",
        "narrator",
        "Six willing factions share the Crown’s power. Yara returns to life.",
        "vision",
      ),
      line("yara-last", "yara", "So, what will they call you now?"),
      line("aren-last", "aren", "They do not need to call me anything."),
    ],
  },
};
