import type { InteractionActivation, InteractionDefinition, InteractionInputHint, RegionId } from "../game/contracts.js";

/**
 * Later-act interaction definitions (chapters 3–7). Mirrors the contract of `act-i-interactions.ts`:
 *  - one authored placement each (validated in world.ts);
 *  - one canonical event each (no event-string aliases);
 *  - mechanical kinds name the engine action they need; plain presses omit `actionId`;
 *  - semantic interaction `success.kind` equals `kind` and `success.targetId` is the id the objective grammar matches.
 *
 * Producers are paired with the event ids the canonical quest objectives demand. Producers that previously existed only
 * as `inspect` interactions are upgraded into the precise semantic the quest requires (for example `mist-tracks` no longer
 * stands in for `mist-eyes`).
 */
const success = (type: string, data: Record<string, unknown> = {}) => ({ type, ...data }) as never;

interface InteractionOptions {
  readonly requiresFacts?: readonly string[];
  /** Engine action the interaction needs; omit for a plain press. */
  readonly actionId?: string;
  readonly requiresActors?: InteractionDefinition["requiresActors"];
  readonly inputHint?: InteractionInputHint;
  readonly activation?: InteractionActivation;
}

function interaction(
  id: string,
  regionId: RegionId,
  targetId: string,
  kind: InteractionDefinition["kind"],
  promptLabel: string,
  result: InteractionDefinition["success"],
  options: InteractionOptions = {},
): InteractionDefinition {
  return {
    id,
    regionId,
    targetId,
    kind,
    promptLabel,
    radiusMeters: 2,
    ...(options.actionId !== undefined ? { actionId: options.actionId as never } : {}),
    ...(options.requiresFacts !== undefined ? { requiresFacts: options.requiresFacts } : { requiresFacts: [] }),
    ...(options.requiresActors !== undefined ? { requiresActors: options.requiresActors } : { requiresActors: [] }),
    ...(options.inputHint !== undefined ? { inputHint: options.inputHint } : {}),
    ...(options.activation !== undefined ? { activation: options.activation } : {}),
    success: result,
    repeatable: false,
  };
}

const semantic = (kind: InteractionDefinition["kind"], targetId: string) =>
  success("semantic-interaction", { kind, targetId });
const cleansePulse: InteractionOptions = { actionId: "cleanse-pulse", inputHint: "ability", activation: "press-release" };

/** Whether the previous Marek decision kept him around for the field-ledger fallback. */
const MAREK_PRESENT = "marekPresent";


export const LATER_ACT_INTERACTIONS: readonly InteractionDefinition[] = [
  // ---------- Moonpine Ridge (chapter 3) ----------
  // Three-beat howl evidence trail.
  interaction("howl-one", "moonpine-ridge", "howl-one", "inspect", "Listen at the first ridge marker", semantic("inspect", "howl-one")),
  interaction("howl-two", "moonpine-ridge", "howl-two", "inspect", "Match the second beat past the frozen stream", semantic("inspect", "howl-two")),
  interaction("howl-three", "moonpine-ridge", "howl-three", "inspect", "Trace the third beat beneath the buried temple", semantic("inspect", "howl-three")),
  // Pack welfare before leadership (two-packs).
  interaction("pack-pups", "moonpine-ridge", "pack-pups", "shelter", "Shelter the pack pups from the exposed pass", success("rescue", { targetId: "pack-pups", locationId: "pack-pup-shelter" })),
  interaction("winter-stores", "moonpine-ridge", "winter-stores", "coordinate", "Move supplies to a wind-sheltered cache", semantic("coordinate", "winter-stores")),
  interaction("pack-scouts", "moonpine-ridge", "pack-scouts", "rescue", "Reach both scout points without choosing a side first", success("rescue", { targetId: "pack-scouts", locationId: "pack-scout-corral" })),
  // Alpha below: real route and physical restraint breaking.
  interaction("temple-route", "moonpine-ridge", "temple-route", "traverse", "Climb the ridge-to-temple route",
    success("traversal", { routeId: "temple-route", fromRegion: "moonpine-ridge", toRegion: "moonpine-ridge", landmarkId: "temple-route" })),
  interaction("moonpine-restoration", "moonpine-ridge", "moonpine-restoration", "restore", "Cleanse the temple roots",
    success("restoration", { regionId: "moonpine-ridge", state: "restored", causeId: "moonpine-restoration" }),
    { ...cleansePulse, requiresFacts: ["encounter-ruun-cleansed", "choice:pack-leadership"] }),

  // ---------- Mistveil Basin (chapter 4) ----------
  // Evidence trail before Nyra reveal.
  interaction("mist-eyes", "mistveil-basin", "mist-eyes", "inspect", "Observe the eyes in the fog", semantic("inspect", "mist-eyes")),
  interaction("reed-track", "mistveil-basin", "reed-track", "traverse", "Follow the low-contamination reed corridor",
    success("traversal", { routeId: "reed-track", fromRegion: "mistveil-basin", toRegion: "mistveil-basin", landmarkId: "reed-track" })),
  interaction("infection-evidence", "mistveil-basin", "infection-evidence", "inspect", "Inspect the infection evidence", semantic("inspect", "infection-evidence")),
  // Nyra's short Echo memory must be acknowledged without changing the nonlethal mandate.
  interaction("nyra-truth", "mistveil-basin", "nyra", "signal", "Hear Nyra’s short Echo memory", semantic("signal", "nyra-truth"), { requiresActors: ["nyra"] }),
  // River route evidence: real upstream traversal + rig ledger if Marek is absent.
  interaction("river-upstream", "mistveil-basin", "river-upstream", "traverse", "Trace Black Sap upstream",
    success("traversal", { routeId: "river-upstream", fromRegion: "mistveil-basin", toRegion: "mistveil-basin", landmarkId: "river-upstream" })),
  interaction("marek-rig", "mistveil-basin", "marek-rig", "inspect", "Inspect Marek’s extraction rig or the field ledger", semantic("inspect", "marek-rig"),
    { requiresFacts: [MAREK_PRESENT] }),
  interaction("field-ledger", "mistveil-basin", "field-ledger", "inspect", "Read the field ledger left at the rig", semantic("inspect", "field-ledger")),
  interaction("river-route-choice", "mistveil-basin", "river-route", "choose", "Choose the waterway route",
    success("choice", { choiceId: "river-route", targetId: "river-route", optionIds: ["break-dam", "repair"] })),
  // Source of pollution before Ghor is cleansed.
  interaction("polluted-source", "mistveil-basin", "polluted-source", "traverse", "Reach the polluted source",
    success("traversal", { routeId: "polluted-source", fromRegion: "mistveil-basin", toRegion: "mistveil-basin", landmarkId: "polluted-source" })),
  // Restoration unlocks Shadow only after Ghor + source are settled.
  interaction("mistveil-restoration", "mistveil-basin", "mistveil-restoration", "restore", "Restore the river and receive Shadow",
    success("restoration", { regionId: "mistveil-basin", state: "restored", causeId: "river-source" }),
    { ...cleansePulse, requiresFacts: ["encounter-ghor-cleansed", "traversed:river-upstream", "traversed:polluted-source", "interaction:river-source"] }),

  // ---------- Sunmane Expanse (chapter 5) ----------
  // Plains evidence and the herd testimony. The existing `silent-crossing` and `tribute-record` interactions in
  // world.ts cover the evidence events; this file only adds the missing herd testimony and tribute ledger producers.
  interaction("herd-route", "sunmane-expanse", "herd-route", "traverse", "Follow the blocked herd route",
    success("traversal", { routeId: "herd-route", fromRegion: "sunmane-expanse", toRegion: "sunmane-expanse", landmarkId: "herd-route" })),
  interaction("herd-testimony", "sunmane-expanse", "herd", "signal", "Hear the herd’s account", semantic("signal", "herd-testimony"), { requiresActors: ["council-envoy"] }),
  interaction("tribute-ledger", "sunmane-expanse", "tribute-record", "inspect", "Document demanded tribute", semantic("inspect", "tribute-ledger")),
  // Solkar echo: the existing `solkar-offer` interaction in world.ts emits `choice:sunmane-resolution`; the existing
  // `crown-council` and `crown-fragment` interactions in world.ts emit `choice:crown-council` and `fragment:heartroot-crown`.
  interaction("solkar-echo", "sunmane-expanse", "solkar", "signal", "Hear Solkar’s Echo offer", semantic("signal", "solkar-offer"), { requiresActors: ["solkar"] }),
  interaction("sunmane-restoration", "sunmane-expanse", "sunmane-restoration", "restore", "Cleanse the shared water channel",
    success("restoration", { regionId: "sunmane-expanse", state: "restored", causeId: "sunmane-restoration" }),
    { ...cleansePulse, requiresFacts: ["encounter-solkar-cleansed", "choice:sunmane-resolution", "interaction:migration-gate"] }),

  // ---------- Fall of the Grove (chapter 6) ----------
  // Tali's shelter run is the real rescue: Aren sends her during the live Fall and the engine emits the safe
  // `rescue` at `grove-tali-shelter` only when she physically arrives there with no live threat at the shelter.
  // The pillar brace (`grove-pillar`), refuge-open (`refuge-lift`), and warden-call (`warden-call` → Ask/Signal
  // transition) are existing world.ts interactions. The chapter-six-response and wild-march-formation choose
  // interactions are the genuine player-selected choices that CAMPAIGN_CHOICES exposes for chapter six/seven.
  interaction("grove-tali-rescue", "the-grove", "tali", "rescue", "Send Tali to the lookout shelter", success("rescue", { targetId: "tali", locationId: "grove-tali-shelter" }), { actionId: "contextual-interact" }),
  // Chapter-six response choose is the genuine player-selected transition. The Director gates the choice on
  // `refugeOpen && !wardenCall` after the earned grove-collapse-escape event; no gameplay-internal fact is required.
  interaction("chapter-six-response", "the-grove", "yara", "choose", "Replace compulsion with Ask and Signal",
    success("choice", { choiceId: "chapter-six-response", targetId: "yara", optionIds: ["ask", "signal"] })),

  // ---------- Living Pact return beats (chapter 7) ----------
  interaction("refuge-covenant", "refuge", "refuge-covenant", "choose", "Invite a willing faction’s Covenant at the fragment stone",
    success("choice", { choiceId: "faction-covenant", targetId: "refuge-covenant", optionIds: ["sky", "canopy", "fang", "pack", "shadow", "crown"] }),
    { requiresFacts: ["refugeOpen"] }),
  // Return producers: each committed consequence mutates a fact the regional navigation/formation consumers see.
  // Evidence inspects are kept distinct from the action events so the quest's evidence step has a real producer.
  interaction("seeds-on-the-wind", "whispering-canopy", "seeds-on-the-wind", "inspect", "Survey the orchard bridge", semantic("inspect", "seeds-on-the-wind")),
  interaction("seed-route", "whispering-canopy", "seed-route", "coordinate", "Coordinate birds and monkeys carrying seeds past the blocked root path", semantic("coordinate", "seed-route")),
  interaction("a-path-for-the-young", "blood-bamboo-valley", "a-path-for-the-young", "inspect", "Inspect the cleared nursery path", semantic("inspect", "a-path-for-the-young")),
  interaction("nursery-return", "blood-bamboo-valley", "nursery-return", "rescue", "Escort Tali and the nursery through the remaining snare corridor", success("rescue", { targetId: "tali", locationId: "nursery-return" }), { actionId: "contextual-interact" }),
  interaction("one-howl-two-generations", "moonpine-ridge", "one-howl-two-generations", "inspect", "Listen at the signal points", semantic("inspect", "one-howl-two-generations")),
  interaction("two-generation-howl", "moonpine-ridge", "two-generation-howl", "coordinate", "Place two signal points and let the chosen leader’s formation carry the three-beat call", semantic("coordinate", "two-generation-howl")),
  interaction("witness-in-the-reeds", "mistveil-basin", "witness-in-the-reeds", "inspect", "Survey the reed corridor", semantic("inspect", "witness-in-the-reeds")),
  interaction("reed-corridor", "mistveil-basin", "reed-corridor", "coordinate", "Open a low-contamination corridor with Nyra’s marks", semantic("coordinate", "reed-corridor")),
  interaction("the-open-crossing", "sunmane-expanse", "the-open-crossing", "inspect", "Survey the migration crossing", semantic("inspect", "the-open-crossing")),
  interaction("open-crossing", "sunmane-expanse", "open-crossing", "coordinate", "Release the migration passage through Solkar’s limits or a council that divides decision rights", semantic("coordinate", "open-crossing")),

  // ---------- Wild March formation (chapter 7) ----------
  // Form the Wild March coalition route once every faction has answered; the player commits the choice.
  // The Director gates this choice on the six committed faction-commitment choices.
  interaction("wild-march-formation", "refuge", "wild-march-marker", "choose", "Form the Wild March with willing factions",
    success("choice", { choiceId: "wild-march-formation", targetId: "wild-march-marker", optionIds: ["form"] })),
];