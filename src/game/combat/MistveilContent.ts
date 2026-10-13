import type { ActorDefinition } from '../contracts.js';
import type { SolidPropKind } from '../../content/solid-props.js';
import type { VfxElement } from '../../effects/vfx/palette.js';
import { strike, boss } from './attack-builders.js';
import type { AttackDefinition, BossEncounterDefinition } from './content.js';
import type { CombatTrialDefinition, CombatTrialSet } from './CombatTrials.js';
import { trialGate as gate } from './trialGate.js';
import type { MonsterProfile } from './WildlifePressure.js';

/**
 * Chapter 4 - Mistveil Basin: fog, wetlands, great root trees and Marek's Black Sap river (docs/features/mistveil-playtest.md).
 * Gameplay data of this local playtest map; the shared registries (CombatTrials, content, WildlifePressure, world ACTORS,
 * palette OWNER_GLOW, solid-props) spread these tables, so this module only runtime-imports the attack and gate builders.
 *
 * The three trial monsters are wildlife of the basin, not villains: the Bog Lurker and the Lantern Heron are driven from their
 * hunting grounds by the poisoned river, and Ghor, the Mire Maw is a crocodile transformed by the pollution upstream. Every
 * attack is a telegraphed, dodgeable hazard and the encounter is nonlethal.
 *
 * Attack ids avoid the obstacle words of `spawnCombatObstacles` (root, sap, stomp, march, seismic, trample, thorn, charge):
 * the trial arenas stay open ground.
 */
export const MISTVEIL_COMBAT_TRIALS: readonly CombatTrialDefinition[] = [
  // Gate 1 seals the 6 m ford between the arrival mud bank and the root causeway.
  { id: 'reed-shallows', title: 'Reed Shallows', monsterId: 'mistveil-lurker', monsterName: 'Bog Lurker', monsterAssetId: 'actor-bog-lurker',
    monsterPosition: { x: -40, y: 0, z: -17 }, arena: { center: { x: -44, y: 0, z: -16 }, radius: 8 },
    attackIds: ['bog-lurker-tongue-lash', 'bog-lurker-bubble-pool', 'bog-lurker-mud-hop'],
    gate: gate('reed-shallows', -27, -16, false, 0, 0) },
  // Gate 2 seals the 6 m reed way between the foggy glade and Marek's extraction site.
  { id: 'eyes-in-the-mist', title: 'Eyes in the Mist', monsterId: 'mistveil-heron', monsterName: 'Lantern Heron', monsterAssetId: 'actor-lantern-heron',
    monsterPosition: { x: 14, y: 0, z: -17 }, arena: { center: { x: 10, y: 0, z: -16 }, radius: 8 },
    attackIds: ['lantern-heron-spear-dive', 'lantern-heron-mist-gust', 'lantern-heron-flare-burst'],
    gate: gate('eyes-in-the-mist', 27, -16, false, 0, 0) },
  // Gate 3 seals the 6 m path from the polluted source to the root cavern.
  { id: 'black-river', title: 'The Black River', monsterId: 'mistveil-ghor', monsterName: 'Ghor, the Mire Maw', monsterAssetId: 'actor-ghor-mire-maw',
    monsterPosition: { x: 78, y: 0, z: -16 }, arena: { center: { x: 72, y: 0, z: -16 }, radius: 8 },
    attackIds: ['mire-maw-tail-sweep', 'mire-maw-bite-lunge', 'mire-maw-black-river-wave'],
    gate: gate('black-river', 89, -16, false, 0, 0) },
];
export const MISTVEIL_TRIAL_SET: CombatTrialSet = { regionId: 'mistveil-basin', encounterId: 'mistveil-trials', clearedTitle: 'Basin trials cleared', trials: MISTVEIL_COMBAT_TRIALS };

export const MISTVEIL_ATTACKS: Readonly<Record<string, AttackDefinition>> = {
  // Bog Lurker (toad): a squat hopper that waits in the reeds.
  'bog-lurker-tongue-lash': {
    ...strike('bog-lurker-tongue-lash', 'mistveil-lurker', 'The lurker flicks its tongue along a straight lane. Step out of the lane.', { kind: 'sweep', width: 1.2, depth: 7, radius: 0, heightAboveGround: 0.9, damage: 11, hitGroup: 'bog-lurker-tongue-lash' }, 42, 12, 8, 44),
    laneFromSource: true,
  },
  'bog-lurker-bubble-pool': {
    ...strike('bog-lurker-bubble-pool', 'mistveil-lurker', 'Poison bubbles rise where Aren stood and linger as a pool. Leave the pool to avoid each pulse; it does not chase you.', { kind: 'area', width: 3.4, depth: 3.4, radius: 0, heightAboveGround: 1.2, damage: 4, hitGroup: 'bog-lurker-bubble-pool' }, 48, 12, 180, 54),
    element: 'poison',
    hitIntervalTicks: 36,
    castTicks: 12,
  },
  'bog-lurker-mud-hop': {
    ...strike('bog-lurker-mud-hop', 'mistveil-lurker', 'The lurker crouches and hops toward where Aren stood. Dive away from the landing.', { kind: 'strike', width: 2.2, depth: 2.2, radius: 2, heightAboveGround: 0.2, damage: 14, hitGroup: 'bog-lurker-mud-hop' }, 48, 12, 9, 48),
    lunge: { kind: 'step', meters: 4.5 },
  },
  // Lantern Heron (heron): a ground-bound wader whose lantern lures travellers into the mist.
  'lantern-heron-spear-dive': {
    ...strike('lantern-heron-spear-dive', 'mistveil-heron', 'The heron coils its neck and darts along a straight lane. Sidestep the lane.', { kind: 'sweep', width: 1.8, depth: 9, radius: 0, heightAboveGround: 1.1, damage: 15, hitGroup: 'lantern-heron-spear-dive' }, 60, 15, 20, 48),
    laneFromSource: true,
    lunge: { kind: 'charge' },
  },
  'lantern-heron-mist-gust': {
    ...strike('lantern-heron-mist-gust', 'mistveil-heron', 'A wingbeat drives a cold gust in a cone ahead of the heron. Get behind or beside it.', { kind: 'cone', width: 6, depth: 7, radius: 0, heightAboveGround: 1.2, damage: 9, hitGroup: 'lantern-heron-mist-gust' }, 54, 12, 10, 44),
    element: 'wind',
    onHit: { pushMeters: 1.2 },
  },
  'lantern-heron-flare-burst': strike('lantern-heron-flare-burst', 'mistveil-heron', 'The heron raises its lantern and a flare bursts where Aren stood. Move off the glowing ground.', { kind: 'area', width: 5, depth: 5, radius: 0, heightAboveGround: 1, damage: 12, hitGroup: 'lantern-heron-flare-burst' }, 54, 12, 12, 48),
  // Ghor, the Mire Maw (crocodile): transformed by the Black Sap upstream; slow and heavy.
  'mire-maw-tail-sweep': strike('mire-maw-tail-sweep', 'mistveil-ghor', 'Ghor drags his tail low across the mud. Jump the sweep.', { kind: 'wave', width: 8, depth: 1.5, radius: 0, heightAboveGround: 0.18, damage: 14, hitGroup: 'mire-maw-tail-sweep' }, 54, 15, 14, 50),
  'mire-maw-bite-lunge': {
    ...strike('mire-maw-bite-lunge', 'mistveil-ghor', 'Ghor rears back and lunges along a straight lane. Step out of the lane.', { kind: 'sweep', width: 1.8, depth: 6.5, radius: 0, heightAboveGround: 0.9, damage: 18, hitGroup: 'mire-maw-bite-lunge' }, 42, 12, 8, 50),
    laneFromSource: true,
    lunge: { kind: 'step', meters: 4 },
  },
  'mire-maw-black-river-wave': {
    ...strike('mire-maw-black-river-wave', 'mistveil-ghor', 'Ghor slams the water and a wide black wave rolls out. Jump the wave.', { kind: 'wave', width: 12, depth: 2, radius: 0, heightAboveGround: 0.2, damage: 12, hitGroup: 'mire-maw-black-river-wave' }, 66, 18, 16, 56),
    element: 'poison',
  },
};

/** The wildlife encounter that hosts the trials: phases mirror the trial rosters; trial play drives the roster directly. */
export const MISTVEIL_ENCOUNTERS: Readonly<Record<string, BossEncounterDefinition>> = {
  'mistveil-trials': {
    ...boss('mistveil-lurker', 'mistveil-basin', MISTVEIL_COMBAT_TRIALS.map(trial => ({ id: trial.id, attackIds: trial.attackIds })), [], ['player-dodge', 'player-tether', 'player-cleanse', 'player-light']),
    id: 'mistveil-trials',
    actorIds: ['aren', ...MISTVEIL_COMBAT_TRIALS.map(trial => trial.monsterId)],
    encounterFamily: 'wildlife',
  },
};

export const MISTVEIL_MONSTER_PROFILES: Readonly<Record<string, MonsterProfile>> = {
  // Squat hopper: tight 4-7 m band, quick short hops between strafes.
  'mistveil-lurker': { radius: 0.8, bandMin: 4, bandMax: 7, advanceSpeed: 3.4, circleSpeed: 2.4, retreatSpeed: 2.8, yawRate: 3.5, strafeTicks: [70, 140] },
  // Ranged circler: holds 6-10 m and circles in wide arcs (a ground-bound wader).
  'mistveil-heron': { radius: 0.9, bandMin: 6, bandMax: 10, advanceSpeed: 4.4, circleSpeed: 3.8, retreatSpeed: 4.4, yawRate: 4.2, strafeTicks: [100, 190] },
  // Slow and heavy: wide 5-8 m band, long strafes, ponderous turns.
  'mistveil-ghor': { radius: 2, bandMin: 5, bandMax: 8, advanceSpeed: 2.2, circleSpeed: 1.4, retreatSpeed: 1.8, yawRate: 2, strafeTicks: [180, 300] },
};

const hostile = (id: string, species: ActorDefinition['species'], assetId: string): ActorDefinition => ({ id, species, role: 'wild', allegiance: 'wild', combatRole: 'hostile', assetId });
/** Wildlife of the basin, placed only by the Mistveil trial region variant. Ghor's species is large (see `isLargeSpecies`). */
export const MISTVEIL_ACTORS: Readonly<Record<string, ActorDefinition>> = {
  'mistveil-lurker': hostile('mistveil-lurker', 'toad', 'actor-bog-lurker'),
  'mistveil-heron': hostile('mistveil-heron', 'heron', 'actor-lantern-heron'),
  'mistveil-ghor': hostile('mistveil-ghor', 'crocodile', 'actor-ghor-mire-maw'),
};

/** Monster identity -> the element its cracks and rims glow with (never `heartroot`, which is Yara's). */
export const MISTVEIL_OWNER_GLOW: Readonly<Record<string, VfxElement>> = {
  'mistveil-lurker': 'earth', 'mistveil-heron': 'wind', 'mistveil-ghor': 'poison',
};

/** Solid kinds of the basin's props: the reed clusters are soft decoration, everything else is physical. */
export const MISTVEIL_SOLID_PROFILES: Readonly<Record<string, SolidPropKind>> = {
  'prop-mistveil-root-tree': 'trunk',
  'prop-mistveil-reed-cluster': 'decoration',
  'prop-mire-bank-rock': 'solid',
  'prop-hunter-extraction-rig': 'solid',
  'prop-black-sap-filter-drum': 'solid',
  'prop-root-cavern-mouth': 'arch',
};
/** Placement-id prefix of this map's deterministic boundary dressing (decoration only, no colliders). */
export const MISTVEIL_BOUNDARY_ID_PREFIX = 'mistveil-boundary-';
