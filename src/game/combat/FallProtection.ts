import type { CompanionId } from "../contracts.js";

/**
 * Chapter 6 — The Fall of the Grove (Bible ch. 6, "Gameplay sequence"). Authored constants of the engine's single Fall
 * state machine (`CombatEngine`, state in `state.chapter.fall`):
 *
 *  1. Protection (phase 0). With an eligible recruit present Orun's `orun-crown-possession` seizes it; the held ally then
 *     attacks Aren with its own authored move until a timed Cleanse, a Perfect Dodge or its Bond-timed escape breaks the
 *     hold. With no eligible recruit present Orun turns `orun-root-surge` on Aren, answered by evading or countering it.
 *  2. Phase 1, in either order: Tali walks to her authored shelter after Aren sends her (the safe rescue is emitted on
 *     arrival), and Aren braces the damaged pillar by hand.
 *  3. Once all three hold, Aren reaching the authored escape surface completes the Fall exactly once.
 *
 * Tali is the protected cub, never a possession target and never a CompanionId.
 */
export const FALL_ENCOUNTER_ID = "encounter-fall";

/** Recruits Orun can seize, each with the authored move it turns on Aren (Bible: Asha Pounce, Wolf Pack Charge, Solkar Roar, Koro's environmental attack; Nyra's Shadow Ambush). */
export const FALL_POSSESSED_ATTACKS: Readonly<Partial<Record<CompanionId, string>>> = {
  asha: "asha-guarding-pounce",
  sable: "ruun-track-charge",
  solkar: "solkar-commanding-roar",
  koro: "koro-falling-branch",
  nyra: "nyra-shadow-ambush",
};

/** Orun's possession grasp (companion-class) and his root attack on Aren when no eligible recruit is present. */
export const FALL_POSSESSION_ATTACK_ID = "orun-crown-possession";
export const FALL_ROOT_ATTACK_ID = "orun-root-surge";

/** Orun is not cleansed in the Fall (that is the Hollow's duel); his encounter resolves only through the escape. */
export const FALL_ORUN_SEALED = "Orun is beyond your Cleanse here: protect the Grove and escape.";

/** Possession break on the world clock. A recruit at the companion Bond bonus level (CompanionSystem `BOND_BONUS`) resists twice as fast. */
export const POSSESSION_BASE_BREAK_TICKS = 240;
export const POSSESSION_HIGH_BOND_BREAK_TICKS = 120;
export const POSSESSION_HIGH_BOND_THRESHOLD = 25;
export function resolvePossessionBreakTicks(bond: number): number {
  return bond >= POSSESSION_HIGH_BOND_THRESHOLD ? POSSESSION_HIGH_BOND_BREAK_TICKS : POSSESSION_BASE_BREAK_TICKS;
}

/** Authored Grove sources the sequence reads. */
export const FALL_TALI_RESCUE_INTERACTION_ID = "grove-tali-rescue";
export const FALL_TALI_SHELTER_NODE_ID = "grove-tali-shelter";
export const FALL_PILLAR_INTERACTION_ID = "grove-pillar";
/** The lookout pad carries the authored Refuge route (`grove-refuge`, collider `grove-trial-lookout-pad-collider`). */
export const FALL_ESCAPE_SURFACE_ID = "grove-trial-lookout-pad";
export const FALL_ESCAPE_INTERACTION_ID = "grove-collapse-escape";

/** Tali's walk to the shelter: cub stride in metres per world tick (the companion stride) and the arrival radius. */
export const FALL_TALI_STRIDE = 0.055;
export const FALL_TALI_ARRIVAL_RADIUS = 0.6;
