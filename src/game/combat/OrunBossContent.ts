import type { ActorId } from '../contracts.js';
import type { AttackDefinition, BossEncounterDefinition } from './content.js';
import { boss, strike } from './attack-builders.js';
import { FALL_ROOT_ATTACK_ID } from './FallProtection.js';

/**
 * Chapter 8 — Heartroot Hollow (Bible ch. 8 "Final Boss"). Authored attacks and tuning of Orun's three-phase duel; the live
 * sequence that drives them is `OrunPhases.ts` (state in `state.chapter.orun`).
 *
 *  1. The Last Warden (human `actor-orun`): eight Warden move families — Root Tether, Staff Combo, Cartwheel Counter, Back
 *     Handspring, Dive Roll, Ground Root Wave, Perfect Dodge and Companion Suppression. Cleared by real pressure (counter
 *     strikes and interrupts) once every family has been shown.
 *  2. The Crowned Beast (`actor-orun-crowned-beast`): six aspect attacks — Sky, Canopy, Fang, Pack, Shadow, Crown — each answered
 *     by surviving it unharmed, interrupting it or the matching companion's support; then the beast core opens for a Cleanse.
 *  3. The Choice of the Crown: Orun seizes each present recruit in turn; Bond resists, Dominion turns the recruit on Aren, and every
 *     freed recruit drives Aren to the core. Without a party Orun's own attacks must be answered. Then the final Cleanse.
 */
export const ORUN_ENCOUNTER_ID = 'encounter-orun';

export const ORUN_WARDEN_MOVES = ['root-tether', 'staff-combo', 'cartwheel-counter', 'back-handspring', 'dive-roll', 'root-wave', 'perfect-dodge', 'suppression'] as const;
export type OrunWardenMove = (typeof ORUN_WARDEN_MOVES)[number];
export const ORUN_ASPECTS = ['sky', 'canopy', 'fang', 'pack', 'shadow', 'crown'] as const;
export type OrunAspect = (typeof ORUN_ASPECTS)[number];

/** The attack each Warden family starts (Perfect Dodge is a swept evasion, not an attack). */
export const ORUN_WARDEN_ATTACKS: Readonly<Record<Exclude<OrunWardenMove, 'perfect-dodge'>, string>> = {
  'root-tether': 'orun-root-tether',
  'staff-combo': 'orun-staff-combo',
  'cartwheel-counter': 'orun-cartwheel-counter',
  'back-handspring': 'orun-back-handspring',
  'dive-roll': 'orun-dive-roll',
  'root-wave': FALL_ROOT_ATTACK_ID,
  suppression: 'orun-companion-suppression',
};
/** Proactive Warden rotation; Back Handspring answers a crowding hero, Perfect Dodge and Cartwheel Counter answer his blows. */
export const ORUN_WARDEN_ROTATION: readonly Exclude<OrunWardenMove, 'perfect-dodge' | 'cartwheel-counter' | 'back-handspring'>[] = ['root-tether', 'staff-combo', 'root-wave', 'dive-roll', 'suppression'];

/** Heartroot shadow echoes of the Sky aspect: native storm-hornbill placements on the arena floor, hidden outside the aspect. */
export const ORUN_SKY_ECHO_IDS: readonly ActorId[] = ['hollow-sky-echo-1', 'hollow-sky-echo-2', 'hollow-sky-echo-3'];
/** Koro's Canopy vine: a transient swing route the engine adds to the traversal gates while it exists (existing traversal mechanics). */
export const ORUN_VINE_ROUTE = Object.freeze({ id: 'orun-canopy-vine', traversalEvent: 'orun-canopy-vine', kind: 'swing' as const });

const ORUN_CHARGE_INTERRUPTS = ['root_tether', 'heavy', 'charged_heavy', 'ferocity', 'corruption', 'guard'] as const;

/** Tuning (world ticks and metres). */
export const ORUN_TUNING = Object.freeze({
  /** Phase 1: answered pressure (counter strikes landed, Warden attacks interrupted) needed once every family was shown. */
  wardenPressure: 3,
  /** Pause after a recovery before Orun starts his next move. */
  moveGapTicks: 24,
  /** Crowding distance that triggers the Back Handspring, and its cooldown and flight. */
  crowdMetres: 2.4,
  handspringCooldownTicks: 300,
  handspringTravel: 3.4,
  handspringTicks: 24,
  /** Perfect Dodge: a swept sidestep that slips one incoming blow, then the Cartwheel Counter riposte. */
  dodgeCooldownTicks: 300,
  dodgeTravel: 2.2,
  dodgeTicks: 14,
  /** Melee reach bands of the proactive families. */
  staffComboRange: 4.6,
  tetherRange: 9.5,
  diveMaxRange: 10,
  diveSideOffset: 0.9,
  /** Companion Suppression and the Dominion Roar bind companions within this radius of Orun for this long. */
  suppressRadius: 14,
  suppressTicks: 240,
  /** Phase 2. */
  aspectGapTicks: 45,
  skyEchoDistance: 9,
  skyLaneSpacing: 2.6,
  skyStaggerTicks: 18,
  /** Vara's mark on Orun lengthens every dive's windup so the lanes read early. */
  varaWarningTicks: 30,
  canopyFlankOffset: 3.2,
  /** Koro's vine lifts Aren over a flank root to this lateral distance; the swing takes this long. */
  canopySwingOffset: 6.4,
  canopySwingTicks: 40,
  canopySwingStartRadius: 2.5,
  packBandSpacing: 2,
  /** Shadow: the true core opens for this long once the veil has erupted; Nyra's ambush reveals it for longer. */
  shadowCoreTicks: 75,
  nyraRevealTicks: 120,
  /** Per-companion Bond at which a recruit resists the Crown (the companion Bond bonus convention). */
  highBond: 25,
  /** An open core stays cleansable this long; a recruit's approach moment exposes it this long. */
  coreOpenTicks: 240,
  momentTicks: 90,
  /** Phase 3 without a party: answered Orun attacks that open the final core. */
  soloCounters: 2,
});

export const ORUN_ATTACKS: Readonly<Record<string, AttackDefinition>> = {
  // ---- Phase 1: the Last Warden ----
  'orun-root-tether': {
    ...strike('orun-root-tether', 'orun', 'The Last Warden casts a root tether along the ground toward you. Step out of the line or the roots will bind your legs.', { kind: 'sweep', width: 1.2, depth: 9, radius: 0, heightAboveGround: 1.2, damage: 8, hitGroup: 'orun-root-tether' }, 48, 12, 10, 44),
    laneFromSource: true,
    onHit: { slowFactor: 0.35, slowTicks: 150 },
  },
  'orun-staff-combo': {
    ...strike('orun-staff-combo', 'orun', 'The Last Warden steps in with his staff for a three-blow combo. Leave the arc in front of him before the blows chain.', { kind: 'cone', width: 6, depth: 3.2, radius: 0, heightAboveGround: 1.6, damage: 7, hitGroup: 'orun-staff-combo' }, 36, 10, 36, 40),
    hazard: { kind: 'cone', width: 6, depth: 3.2, radius: 0, heightAboveGround: 1.6, damage: 7, hitGroup: 'orun-staff-combo', angleDeg: 120, bounds: { min: { x: -3.2, y: -0.2, z: -3.2 }, max: { x: 3.2, y: 5, z: 3.2 } } },
    hitIntervalTicks: 12,
    lunge: { kind: 'step', meters: 1.5 },
  },
  'orun-cartwheel-counter': {
    ...strike('orun-cartwheel-counter', 'orun', 'Orun slips your blow and cartwheels into a staff counter. Dodge the sweep, then punish.', { kind: 'sweep', width: 2.6, depth: 3, radius: 0, heightAboveGround: 1.4, damage: 12, hitGroup: 'orun-cartwheel-counter' }, 30, 10, 8, 40),
    laneFromSource: true,
    lunge: { kind: 'step', meters: 2.5 },
  },
  'orun-back-handspring': {
    ...strike('orun-back-handspring', 'orun', 'The Last Warden plants his staff and kicks off into a back handspring. Do not crowd him.', { kind: 'strike', width: 1.6, depth: 1.6, radius: 1.6, heightAboveGround: 0.6, damage: 9, hitGroup: 'orun-back-handspring' }, 24, 8, 6, 30),
    reach: 1.2,
  },
  'orun-dive-roll': {
    ...strike('orun-dive-roll', 'orun', 'Orun drops into a low dive roll through your flank. Jump it or step off the lane.', { kind: 'sweep', width: 2, depth: 7, radius: 0, heightAboveGround: 0.6, damage: 13, hitGroup: 'orun-dive-roll' }, 42, 12, 18, 40),
    laneFromSource: true,
    lunge: { kind: 'charge' },
    interruptibleBy: ORUN_CHARGE_INTERRUPTS,
  },
  'orun-companion-suppression': {
    ...strike('orun-companion-suppression', 'orun', 'Orun slams his staff and roots bind the bonds around him. Interrupt him or your companions will be held.', { kind: 'area', width: 9, depth: 9, radius: 0, heightAboveGround: 1.2, damage: 6, hitGroup: 'orun-suppression' }, 60, 15, 10, 50),
    reach: 0.5,
  },
  // ---- Phase 2: the Crowned Beast ----
  'orun-sky-aspect': {
    ...strike('orun-sky-aspect', 'orun', 'The Crowned Beast screams for the sky. Shadow birds gather to dive along committed lanes; read the lanes and step between them.', { kind: 'area', width: 5, depth: 5, radius: 0, heightAboveGround: 2, damage: 10, hitGroup: 'orun-sky' }, 60, 15, 12, 48),
    reach: 0.5,
  },
  'orun-sky-dive': {
    ...strike('orun-sky-dive', 'orun', 'A shadow bird folds its wings and dives along a straight lane.', { kind: 'sweep', width: 1.8, depth: 12, radius: 0, heightAboveGround: 1.6, damage: 12, hitGroup: 'orun-sky-dive' }, 50, 15, 18, 30),
    element: 'wind',
    laneFromSource: true,
    lunge: { kind: 'charge' },
  },
  'orun-canopy-root': strike('orun-canopy-root', 'orun', 'Roots tear loose from the cavern roof beside you.', { kind: 'area', width: 2.6, depth: 2.6, radius: 0, heightAboveGround: 1.4, damage: 12, hitGroup: 'orun-canopy-root' }, 60, 15, 50, 30),
  'orun-canopy-aspect': strike('orun-canopy-aspect', 'orun', 'The canopy aspect drops a falling root onto you while the roots beside you hold. Escape along the axis, or swing out on Koro’s vine.', { kind: 'area', width: 4.4, depth: 4.4, radius: 0, heightAboveGround: 1.4, damage: 16, hitGroup: 'orun-canopy' }, 84, 15, 15, 48),
  'orun-fang-aspect': {
    ...strike('orun-fang-aspect', 'orun', 'The fang aspect coils into a tiger pounce down a straight lane. Cross the lane, or let Asha block the charge.', { kind: 'sweep', width: 2.6, depth: 10, radius: 0, heightAboveGround: 1.4, damage: 19, hitGroup: 'orun-fang' }, 54, 15, 14, 51),
    laneFromSource: true,
    lunge: { kind: 'charge' },
    interruptibleBy: ORUN_CHARGE_INTERRUPTS,
  },
  // The pack formation and the shadow veil gather slowly: long enough to read the rows or the veil alone, or for Sable and Nyra to reach the beast.
  'orun-pack-aspect': strike('orun-pack-aspect', 'orun', 'The pack aspect sends wolves in rows at several depths. One row is missing: find the gap.', { kind: 'wave', width: 10, depth: 1.8, radius: 0, heightAboveGround: 1, damage: 15, hitGroup: 'orun-pack' }, 120, 18, 15, 54),
  'orun-shadow-aspect': strike('orun-shadow-aspect', 'orun', 'Shadow pours from the beast and fogs the arena. Leave its forward reach, then strike the core when it pulses.', { kind: 'cone', width: 7.4, depth: 4.2, radius: 0, heightAboveGround: 2.5, damage: 16, hitGroup: 'orun-shadow' }, 110, 18, 15, 54),
  'orun-crown-aspect': {
    ...strike('orun-crown-aspect', 'orun', 'The Crowned Beast draws breath for a Dominion Roar. Leave the roar or interrupt it before it lands.', { kind: 'area', width: 11, depth: 11, radius: 0, heightAboveGround: 2.2, damage: 20, hitGroup: 'orun-crown' }, 78, 18, 18, 72),
    reach: 0.5,
  },
};
/** Orun's charges Asha's guard may intercept. */
export const ORUN_GUARDABLE_ATTACK_IDS: readonly string[] = ['orun-fang-aspect'];

export const ORUN_ENCOUNTER: BossEncounterDefinition = {
  ...boss('orun', 'heartroot-hollow', [
    { id: 'last-warden', aspect: 'The Last Warden', attackIds: ['orun-root-tether', 'orun-staff-combo', 'orun-cartwheel-counter', 'orun-back-handspring', 'orun-dive-roll', FALL_ROOT_ATTACK_ID, 'orun-companion-suppression'], requiredAction: 'counter' },
    { id: 'crowned-beast', aspect: 'Six Heartroot aspects', actorVariantId: 'actor-orun-crowned-beast', attackIds: ['orun-sky-aspect', 'orun-canopy-aspect', 'orun-fang-aspect', 'orun-pack-aspect', 'orun-shadow-aspect', 'orun-crown-aspect'], requiredAction: 'cleanse' },
    { id: 'crown-choice-possession', aspect: 'Crown choice and possession', actorVariantId: 'actor-orun-crowned-beast', attackIds: ['orun-crown-possession', 'orun-crown-aspect', 'orun-fang-aspect'], requiredAction: 'cleanse' },
  ], ['orun'], ['player-dodge', 'player-light', 'player-heavy', 'player-tether', 'player-cleanse']),
  corruptionCoreIds: ['orun-beast-core', 'orun-crown-core'],
  cleanseOnly: true,
  safeAbsenceResolution: 'cleansed',
};
