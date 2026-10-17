import type { ActorId, Vec3 } from '../contracts.js';
import type { AttackDefinition, BossEncounterDefinition } from './content.js';
import { boss, strike } from './attack-builders.js';

/**
 * Act I boss content: Koro Branchbreaker (Whispering Canopy) and Asha (Blood Bamboo Valley).
 *
 * Attack windows are absolute 60-Hz boundary ticks: anticipation end, active start, active end, recovery end. The authored
 * animation seconds were converted once with `Math.ceil(seconds * 60)` and durations are derived from adjacent boundaries
 * (never rounded separately). Asha's pounce / corrupted slam / bamboo charge boundaries are the coordinator-approved table;
 * every other window is authored here and reviewed visually by the presentation owner. The renderer imports these same
 * constants; it never changes damage or timing.
 */
export function ticksFromSeconds(seconds: number): number { return Math.ceil(seconds * 60); }

export interface AttackWindow {
  /** Absolute tick the windup ends (the commit starts). */
  readonly anticipationEnd: number;
  /** Absolute tick the hit window opens. */
  readonly activeStart: number;
  /** Absolute tick the hit window closes (the cast ends). */
  readonly activeEnd: number;
  /** Absolute tick the recovery ends. */
  readonly recoveryEnd: number;
  readonly windupTicks: number;
  readonly commitTicks: number;
  readonly activeTicks: number;
  readonly recoveryTicks: number;
}
export function windowFromBoundaries(anticipationEnd: number, activeStart: number, activeEnd: number, recoveryEnd: number): AttackWindow {
  return Object.freeze({
    anticipationEnd, activeStart, activeEnd, recoveryEnd,
    windupTicks: anticipationEnd, commitTicks: activeStart - anticipationEnd, activeTicks: activeEnd - activeStart, recoveryTicks: recoveryEnd - activeEnd,
  });
}

export const ASHA_ATTACK_WINDOWS = Object.freeze({
  /** Tiger Pounce / `asha-stalk-pounce` (.42 / .66 / .99 / 1.35 s). */
  'asha-guarding-pounce': windowFromBoundaries(ticksFromSeconds(0.42), ticksFromSeconds(0.66), ticksFromSeconds(0.99), ticksFromSeconds(1.35)),
  /** Corrupted Pounce / `asha-corrupt-slam` (.72 / .9 / 1.152 / 1.656 s). */
  'asha-corrupted-pounce': windowFromBoundaries(ticksFromSeconds(0.72), ticksFromSeconds(0.9), ticksFromSeconds(1.152), ticksFromSeconds(1.656)),
  /** Bamboo Charge / `asha-bamboo-charge` (.48 / .608 / 1.312 / 1.536 s); the clip is in place, the engine sweeps the displacement. */
  'asha-bamboo-charge': windowFromBoundaries(ticksFromSeconds(0.48), ticksFromSeconds(0.608), ticksFromSeconds(1.312), ticksFromSeconds(1.536)),
  /** Authored: two claw arcs in sequence. */
  'asha-claw-combination': windowFromBoundaries(30, 42, 50, 72),
  /** Authored: a sideways rush that sweeps the engine-owned lane. */
  'asha-side-charge': windowFromBoundaries(34, 44, 68, 90),
  /** Authored: the Roar Cone. */
  'asha-protective-roar': windowFromBoundaries(42, 54, 72, 96),
  /** Authored: lane strike; the lingering sap pool outlives `activeEnd` (see SAP_POOL_TICKS). */
  'asha-black-sap-trail': windowFromBoundaries(36, 48, 64, 92),
  /** Authored: the Ground Corruption Wave. */
  'asha-ground-wave': windowFromBoundaries(42, 56, 72, 108),
});
export const KORO_ATTACK_WINDOWS = Object.freeze({
  /** Authored: the `pitch_baseball` rock throw (a landing disk at the committed aim). */
  'koro-rock-throw': windowFromBoundaries(30, 42, 50, 72),
  /** Authored: the falling branch is an environment hazard (no clip). */
  'koro-falling-branch': windowFromBoundaries(48, 60, 76, 108),
  /** Authored: the platform charge (`dive` clip, engine-swept displacement). */
  'koro-platform-charge': windowFromBoundaries(36, 46, 74, 96),
  /** Authored: the background-to-foreground leap (`jump` clip). */
  'koro-vine-vault': windowFromBoundaries(40, 52, 62, 92),
  /** Authored: the horizontal log sweep (`slash` clip). */
  'koro-branch-swing': windowFromBoundaries(32, 44, 54, 84),
});
export const ACT_ONE_ATTACK_WINDOWS: Readonly<Record<string, AttackWindow>> = Object.freeze({ ...ASHA_ATTACK_WINDOWS, ...KORO_ATTACK_WINDOWS });

/** Linger time of the Black Sap pool after the trail strike (hit-interval pulses). */
export const SAP_POOL_TICKS = 150;

/** Attack ids whose bodies can be intercepted by Asha's guard (an incoming interruptible charge). */
export const GUARDABLE_ATTACK_IDS: readonly string[] = ['asha-bamboo-charge', 'asha-side-charge', 'koro-platform-charge', 'boar-charge'];

const CHARGE_INTERRUPTS = ['root_tether', 'heavy', 'charged_heavy', 'ferocity', 'corruption', 'guard'] as const;

function windowed(id: string, bossId: ActorId, cue: string, shape: Parameters<typeof strike>[3], extras: Partial<AttackDefinition> = {}): AttackDefinition {
  const window = ACT_ONE_ATTACK_WINDOWS[id]!;
  const base = strike(id, bossId, cue, shape, window.windupTicks, window.commitTicks, window.activeTicks, window.recoveryTicks);
  return { ...base, ...extras };
}

export const KORO_ATTACKS: Readonly<Record<string, AttackDefinition>> = {
  'koro-rock-throw': windowed('koro-rock-throw', 'koro', 'Koro hefts a stone and winds up like a pitcher. Leave the marked ground before it lands.', { kind: 'projectile', width: 1.6, depth: 1.6, radius: 1.05, heightAboveGround: 1.2, damage: 12, hitGroup: 'koro-rock' }),
  'koro-falling-branch': windowed('koro-falling-branch', 'koro', 'Koro shakes the canopy; a heavy branch will drop on the shadowed ground. Step clear of the shadow.', { kind: 'area', width: 4.4, depth: 4.4, radius: 0, heightAboveGround: 4, damage: 14, hitGroup: 'koro-falling-branch' }, { environment: true }),
  'koro-platform-charge': windowed('koro-platform-charge', 'koro', 'Koro drops low and charges along the platform. Cross the lane, do not run ahead of it.', { kind: 'sweep', width: 2.4, depth: 9, radius: 0, heightAboveGround: 1.3, damage: 16, hitGroup: 'koro-charge' }, { laneFromSource: true, lunge: { kind: 'charge' }, interruptibleBy: CHARGE_INTERRUPTS }),
  'koro-vine-vault': windowed('koro-vine-vault', 'koro', 'Koro gathers himself along the vine before leaping at the foreground. Move away from where you stood.', { kind: 'strike', width: 1.8, depth: 2, radius: 1.35, heightAboveGround: .2, damage: 15, hitGroup: 'koro-pounce' }, { lunge: { kind: 'step', meters: 5 } }),
  'koro-branch-swing': windowed('koro-branch-swing', 'koro', 'Koro coils his shoulders before sweeping a log across his near side. Step beyond its reach.', { kind: 'sweep', width: 5, depth: 2.3, radius: 0, heightAboveGround: 1.3, damage: 12, hitGroup: 'koro-sweep' }),
};
export const ASHA_ATTACKS: Readonly<Record<string, AttackDefinition>> = {
  'asha-guarding-pounce': windowed('asha-guarding-pounce', 'asha', 'Asha flattens into a stalking crouch before a tiger pounce. Clear the place she is facing.', { kind: 'strike', width: 2.5, depth: 2.5, radius: 1.5, heightAboveGround: .4, damage: 18, hitGroup: 'asha-pounce' }, { lunge: { kind: 'step', meters: 4.5 } }),
  'asha-corrupted-pounce': windowed('asha-corrupted-pounce', 'asha', 'Black sap boils along Asha’s back; a corrupted slam will land where you stood. Move before it falls.', { kind: 'strike', width: 3.2, depth: 3.2, radius: 2, heightAboveGround: .4, damage: 22, hitGroup: 'asha-corrupt-slam' }, { lunge: { kind: 'step', meters: 5 } }),
  'asha-bamboo-charge': windowed('asha-bamboo-charge', 'asha', 'Asha lowers her head and charges down a straight lane. Leave the lane or break the charge.', { kind: 'sweep', width: 2.6, depth: 12, radius: 0, heightAboveGround: 1.4, damage: 20, hitGroup: 'asha-bamboo-charge' }, { laneFromSource: true, lunge: { kind: 'charge' }, interruptibleBy: CHARGE_INTERRUPTS }),
  'asha-claw-combination': windowed('asha-claw-combination', 'asha', 'Asha raises her paw; two claw arcs will follow in sequence.', { kind: 'sweep', width: 4.6, depth: 2.2, radius: 0, heightAboveGround: 1.4, damage: 11, hitGroup: 'asha-claw-a' }),
  'asha-side-charge': windowed('asha-side-charge', 'asha', 'Asha shifts her weight and rushes sideways along the ground. Step out of the lane.', { kind: 'sweep', width: 2.4, depth: 7, radius: 0, heightAboveGround: 1.2, damage: 14, hitGroup: 'asha-side-charge' }, { laneFromSource: true, lunge: { kind: 'charge' }, interruptibleBy: CHARGE_INTERRUPTS }),
  'asha-protective-roar': windowed('asha-protective-roar', 'asha', 'Asha draws breath. Move out of the space in front of her before the roar cone.', { kind: 'cone', width: 7, depth: 4, radius: 0, heightAboveGround: 2.4, damage: 12, hitGroup: 'asha-roar' }),
  'asha-black-sap-trail': windowed('asha-black-sap-trail', 'asha', 'Asha drags black sap along the ground. Leave the lane and keep clear of the lingering pool.', { kind: 'sweep', width: 1.8, depth: 8, radius: 0, heightAboveGround: .2, damage: 4, hitGroup: 'asha-sap-trail' }, { activeTicks: SAP_POOL_TICKS, castTicks: ASHA_ATTACK_WINDOWS['asha-black-sap-trail']!.activeTicks, hitIntervalTicks: 36, laneFromSource: true }),
  'asha-ground-wave': windowed('asha-ground-wave', 'asha', 'Asha lifts her forelegs before striking the earth. Jump the low corruption wave or use the Staff Vault opening.', { kind: 'wave', width: 7, depth: 1.4, radius: 0, heightAboveGround: .15, damage: 16, hitGroup: 'asha-wave' }),
};
export const ACT_ONE_ATTACKS: Readonly<Record<string, AttackDefinition>> = { ...KORO_ATTACKS, ...ASHA_ATTACKS };

/** Tuning of the cleanse sequences and the Tali danger (world ticks unless stated). */
export const KORO_SEQUENCE = Object.freeze({
  /** Ferocity at or below which the shoulder thorn is exposed. */
  thornExposeFerocity: 25,
  /** How long a tethered Koro stays cleansable. */
  tetherWindowTicks: 360,
});
export const ASHA_SEQUENCE = Object.freeze({
  /** Authored pause after the Cub phase begins, the danger announcement, before Asha's first committed charge. */
  announceTicks: 120,
  /** Total unpaused danger time before Tali is lost. */
  dangerTicks: 2400,
  /** Bamboo Charges aimed at the shelter lane that may complete before Tali is lost. */
  maxLandedCharges: 2,
  /** The shelter circle (metres) around the authored shelter point. */
  shelterRadius: 2.2,
  /** A released bundle leaves Asha stunned and exposed this long. */
  exposureTicks: 420,
  /** A tethered Asha stays cleansable this long. */
  tetherWindowTicks: 360,
  /** The bundle returns to rest this long after a release that did not finish the sequence. */
  bundleResetTicks: 300,
  /** Authored nav-node ids the sequence reads from the canonical region. */
  arenaNodeId: 'bamboo-asha-arena',
  shelterNodeId: 'bamboo-tali-shelter',
  bundleObjectId: 'asha-shrine-bundle',
  /** Per-phase rotation while the danger is live: the shelter-lane charge, then pressure on the hero, repeated. */
  cubRotation: ['asha-bamboo-charge', 'asha-claw-combination', 'asha-side-charge'] as readonly string[],
});
/** Movable objects that reset on every encounter start/retry and whose `movedFactId` is never permanent. */
export const ENCOUNTER_RESETTABLE_OBJECT_IDS: readonly string[] = [ASHA_SEQUENCE.bundleObjectId];

/** The main hunter camp's trap group shares one authored disarm fact. */
export const TRAP_DISARM_FACT = 'interaction:camp-disable';
export const TRAP = Object.freeze({ radius: 0.9, damage: 12, revealRadius: 7 });

export const KORO_ENCOUNTER: BossEncounterDefinition = {
  ...boss('koro', 'whispering-canopy', [
    { id: 'broken-branches', attackIds: ['koro-rock-throw', 'koro-branch-swing', 'koro-falling-branch'], actorVariantId: 'actor-koro-branchbreaker' },
    { id: 'canopy-escape', attackIds: ['koro-platform-charge', 'koro-vine-vault', 'koro-falling-branch', 'koro-rock-throw'], requiredAction: 'tether', actorVariantId: 'actor-koro-branchbreaker' },
  ], ['koro']),
  corruptionCoreIds: ['koro-shoulder-thorn'],
  cleanseOnly: true,
  sequence: 'koro-thorn',
};
export const ASHA_ENCOUNTER: BossEncounterDefinition = {
  ...boss('asha', 'blood-bamboo-valley', [
    { id: 'protective-instinct', aspect: 'Stalking', attackIds: ['asha-guarding-pounce', 'asha-claw-combination', 'asha-side-charge'] },
    { id: 'mother-roar', aspect: 'Corruption Rage', attackIds: ['asha-ground-wave', 'asha-protective-roar', 'asha-corrupted-pounce', 'asha-black-sap-trail'] },
    { id: 'reunion-opening', aspect: 'The Cub', attackIds: ['asha-bamboo-charge', 'asha-claw-combination', 'asha-side-charge'], requiredAction: 'cleanse' },
  ], ['asha'], ['player-dodge', 'staff-vault', 'player-cleanse', 'player-light']),
  supportActorIds: ['tali'],
  corruptionCoreIds: ['asha-corruption-core-1', 'asha-corruption-core-2', 'asha-corruption-core-3'],
  cleanseOnly: true,
  sequence: 'asha-cub',
};

export function offsetPoint(from: Vec3, dirX: number, dirZ: number, metres: number): Vec3 {
  return { x: from.x + dirX * metres, y: from.y, z: from.z + dirZ * metres };
}
