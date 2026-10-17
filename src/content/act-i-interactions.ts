import type { InteractionActivation, InteractionDefinition, InteractionInputHint, RegionId } from "../game/contracts.js";

/**
 * Act I interaction definitions. One authored placement each (validated in world.ts), one canonical event each.
 *
 * Contract (the exact event ids the quests read; no aliases):
 *  - A plain press-E interaction has no `actionId` (tend / collect / track / traverse / semantic rescue / fragment / pact choice).
 *  - Mechanical interactions name the engine action they need: `staff-heavy` (a heavy strike near the target), `cleanse-pulse`
 *    (a cleanse on the target). `inspect` and `choose` use the contextual press.
 *  - A semantic interaction's `success.kind` equals its `kind`; its `targetId` is the id the objective grammar matches.
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
  id: string, regionId: RegionId, targetId: string, kind: InteractionDefinition["kind"], promptLabel: string,
  result: InteractionDefinition["success"], options: InteractionOptions = {},
): InteractionDefinition {
  return {
    id, regionId, targetId, kind, promptLabel, radiusMeters: 2,
    ...(options.actionId ? { actionId: options.actionId as never } : {}),
    requiresFacts: options.requiresFacts ?? [],
    requiresActors: options.requiresActors ?? [],
    inputHint: options.inputHint ?? "interact",
    activation: options.activation ?? "press",
    success: result,
    repeatable: false,
  };
}
const semantic = (kind: InteractionDefinition["kind"], targetId: string) => success("semantic-interaction", { kind, targetId });
const heavy: InteractionOptions = { actionId: "staff-heavy", inputHint: "heavy", activation: "press-release" };
const cleansePulse: InteractionOptions = { actionId: "cleanse-pulse", inputHint: "ability", activation: "press-release" };
const KORO_CLEANSED = "encounter-koro-cleansed";
const ASHA_CLEANSED = "encounter-asha-cleansed";

/** The staff-heavy bundle release and Koro special for one authored movable object (validated against `region.movableObjects`). */
const moveObject = (id: string, regionId: RegionId, objectId: string, promptLabel: string, koro: boolean): InteractionDefinition => ({
  id, regionId, targetId: objectId, kind: "move-object", promptLabel, radiusMeters: 2.5,
  ...(koro ? { requiresCompanionCommand: { companionId: "koro", command: "special" } as const, playerActionId: undefined } : { playerActionId: "staff-heavy" as never }),
  requiresFacts: [], requiresActors: koro ? ["koro"] : [],
  inputHint: koro ? "ability" : "heavy", activation: koro ? "press" : "press-release",
  success: success("object-move", { objectId }), repeatable: false,
});

export const ACT_I_INTERACTIONS: readonly InteractionDefinition[] = [
  // Prologue and Greenwake.
  interaction("greenwake-roars", "greenwake", "greenwake-roars", "inspect", "Listen for the roars", semantic("inspect", "greenwake-roars")),
  interaction("tend-vara", "greenwake", "vara", "tend", "Tend to Vara", semantic("tend", "vara")),
  interaction("vara-fragment", "greenwake", "heartroot-sky", "collect", "Receive the Sky fragment",
    success("fragment", { fragmentId: "heartroot-sky", sourceId: "vara" }), { requiresFacts: ["interaction:tend-vara"] }),
  interaction("warden-staff", "greenwake", "warden-staff", "collect", "Take the Warden Staff", semantic("collect", "warden-staff"), { requiresFacts: ["interaction:tend-vara"] }),
  interaction("boar-sap", "greenwake", "corrupted-boar", "cleanse", "Cleanse the boar", semantic("cleanse", "corrupted-boar"), { ...cleansePulse, actionId: "cleanse-pulse" }),
  interaction("greenwake-gate", "greenwake", "greenwake-gate", "traverse", "Open the settlement gate with the Warden Staff", semantic("traverse", "greenwake-gate"),
    { requiresFacts: ["greenwake-boar-cleansed"] }),

  // Whispering Canopy.
  interaction("canopy-tend-vara", "whispering-canopy", "canopy-vara", "tend", "Tend to Vara", semantic("tend", "canopy-vara")),
  interaction("canopy-vine-route", "whispering-canopy", "canopy-vine-route", "traverse", "Follow Koro across the vine bridge", semantic("traverse", "canopy-vine-route")),
  interaction("canopy-vault", "whispering-canopy", "canopy-vault", "traverse", "Mark the vaulted boulder", semantic("traverse", "canopy-vault")),
  interaction("koro-trail", "whispering-canopy", "koro-trail", "track", "Read Koro's trail", semantic("track", "koro-trail")),
  interaction("canopy-waterwheel", "whispering-canopy", "canopy-waterwheel", "repair", "Clear the jam and repair the waterwheel", semantic("repair", "canopy-waterwheel"), heavy),
  interaction("monkey-rescue", "whispering-canopy", "monkey-rescue", "rescue", "Free the trapped monkeys", semantic("rescue", "monkey-rescue")),
  interaction("orchard-seeds", "whispering-canopy", "orchard-seeds", "collect", "Carry the shared seeds", semantic("collect", "orchard-seeds")),
  interaction("koro-thorn", "whispering-canopy", "koro-thorn", "inspect", "Inspect the thorn", semantic("inspect", "koro-thorn")),
  interaction("canopy-fragment", "whispering-canopy", "heartroot-canopy", "collect", "Receive the Canopy fragment",
    success("fragment", { fragmentId: "heartroot-canopy", sourceId: "koro" }), { requiresFacts: [KORO_CLEANSED] }),
  interaction("koro-pact", "whispering-canopy", "koro-pact", "choose", "Seal the pact with Koro",
    success("choice", { choiceId: "koro-pact", targetId: "koro-pact", optionIds: ["bond", "dominion"] }), { requiresFacts: [KORO_CLEANSED] }),
  interaction("canopy-restoration", "whispering-canopy", "canopy-restoration", "restore", "Wake the orchard with the shared seed",
    success("restoration", { regionId: "whispering-canopy", state: "restored", causeId: "canopy-water-seed-accord" }),
    { ...cleansePulse, requiresFacts: ["interaction:canopy-waterwheel", "interaction:monkey-rescue", "interaction:orchard-seeds", KORO_CLEANSED, "choice:koro-pact"] }),

  // Blood Bamboo Valley.
  interaction("bamboo-tracks", "blood-bamboo-valley", "bamboo-tracks", "inspect", "Examine the broken bamboo", semantic("inspect", "bamboo-tracks")),
  interaction("tali-trail", "blood-bamboo-valley", "tali-trail", "track", "Follow Tali's fur along the clear path", semantic("track", "tali-trail")),
  interaction("hunter-camp", "blood-bamboo-valley", "hunter-camp", "inspect", "Inspect the hunters' camp", semantic("inspect", "hunter-camp")),
  interaction("camp-approach", "blood-bamboo-valley", "camp-approach", "inspect", "Study the camp perimeter from cover", semantic("inspect", "camp-approach")),
  interaction("camp-disable", "blood-bamboo-valley", "hunter-camp", "break", "Disable traps and the signal rig", semantic("break", "hunter-camp"), heavy),
  moveObject("koro-drop-object", "blood-bamboo-valley", "camp-loose-snare", "Koro utility special: Drop the loose snare", true),
  moveObject("player-drop-object", "blood-bamboo-valley", "camp-loose-snare", "Aren staff-heavy fallback: Knock the loose snare toward the ranged hunter", false),
  interaction("tali-cage", "blood-bamboo-valley", "tali", "rescue", "Rescue Tali safely", success("rescue", { targetId: "tali", locationId: "tali-cage" }), { actionId: "contextual-interact" }),
  interaction("tali-refuge", "blood-bamboo-valley", "tali-refuge", "track", "Follow Tali to the den's edge", semantic("track", "tali-refuge"), { requiresFacts: ["bamboo_tali_safe"] }),
  moveObject("koro-bundle-drop", "blood-bamboo-valley", "asha-shrine-bundle", "Koro utility special: Drop the shrine bundle across the charge lane", true),
  moveObject("player-bundle-release", "blood-bamboo-valley", "asha-shrine-bundle", "Aren staff-heavy fallback: Cut the bundle free", false),
  interaction("asha-cleanse", "blood-bamboo-valley", "asha", "cleanse", "Cleanse Asha", semantic("cleanse", "asha"), cleansePulse),
  interaction("fang-fragment", "blood-bamboo-valley", "heartroot-fang", "collect", "Receive the Fang fragment",
    success("fragment", { fragmentId: "heartroot-fang", sourceId: "asha" }), { requiresFacts: [ASHA_CLEANSED] }),
  interaction("asha-pact", "blood-bamboo-valley", "asha-pact", "choose", "Seal the pact with Asha",
    success("choice", { choiceId: "asha-pact", targetId: "asha-pact", optionIds: ["bond", "dominion"] }), { requiresFacts: [ASHA_CLEANSED] }),
  interaction("snare-source", "blood-bamboo-valley", "snare-source", "restore", "Cleanse the Black Sap source that fed the snares",
    success("restoration", { regionId: "blood-bamboo-valley", state: "restored", causeId: "snare-source" }),
    { ...cleansePulse, requiresFacts: ["interaction:camp-disable", "bamboo_tali_safe", ASHA_CLEANSED, "choice:asha-pact"] }),

  // The Grove (peaceful Act I hub).
  interaction("grove-heartroot", "the-grove", "grove-heartroot", "inspect", "Listen to Heartroot", semantic("inspect", "grove-heartroot")),
  interaction("grove-heartroot-rest", "the-grove", "grove-heartroot-rest", "inspect", "Rest at the Heartroot and save", success("checkpoint", { checkpointId: "grove-heartroot-rest" })),
  interaction("grove-yara-tent", "the-grove", "grove-yara-tent", "inspect", "Visit Yara's tent", semantic("inspect", "grove-yara-tent")),
  interaction("grove-training", "the-grove", "grove-training", "inspect", "Use the training ring (no rewards)", semantic("inspect", "grove-training")),
];
