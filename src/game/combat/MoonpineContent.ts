import type { ActorDefinition, Vec3 } from '../contracts.js';
import type { SolidPropKind } from '../../content/solid-props.js';
import type { VfxElement } from '../../effects/vfx/palette.js';
import { boss, strike } from './attack-builders.js';
import type { AttackDefinition, BossEncounterDefinition } from './content.js';
import type { CombatTrialDefinition, CombatTrialSet } from './CombatTrials.js';
import { trialGate } from './trialGate.js';
import type { MonsterProfile } from './WildlifePressure.js';

/**
 * Chapter 3, Moonpine Ridge: pine forest, frozen lake and the buried wolf temple; Ruun's split pack (GAME-NARRATIVE section 6).
 * Gameplay data of this local playtest map; the shared registries (CombatTrials, content, WildlifePressure, world ACTORS,
 * palette OWNER_GLOW, solid-props) spread these tables, so this module only imports the attack and gate builders at runtime.
 *
 * Nonlethal by design: the monsters are corrupted pack wolves; each is cleansed (turns neutral) when its trial is cleared.
 * The route runs west to east along z = -22: Frozen Shore (lake shelf), the log bridge over the gorge, Scout's Hollow,
 * the stair up to the temple terrace and The Alpha Below before the buried temple, then the descent to the exit.
 */
export const MOONPINE_COMBAT_TRIALS: readonly CombatTrialDefinition[] = [
  // Gate 1 crosses the 6.5 m shore path between the lake shelf and the gorge rim.
  { id: 'frozen-shore', title: 'Frozen Shore', monsterId: 'moonpine-frostfang', monsterName: 'Frostfang Tracker', monsterAssetId: 'actor-frostfang-tracker',
    monsterPosition: { x: -44, y: 0, z: -22 }, arena: { center: { x: -46, y: 0, z: -22 }, radius: 8 },
    attackIds: ['frostfang-pack-rush', 'frostfang-ice-bite', 'frostfang-frost-breath'],
    gate: trialGate('frozen-shore', -29, -22, false, 0, 0) },
  // Gate 2 crosses the 6.5 m path between the hollow and the foot of the temple stair.
  { id: 'scouts-hollow', title: "Scout's Hollow", monsterId: 'moonpine-scout', monsterName: 'Howl Scout', monsterAssetId: 'actor-howl-scout',
    monsterPosition: { x: 8, y: 0, z: -22 }, arena: { center: { x: 6, y: 0, z: -22 }, radius: 8 },
    attackIds: ['howl-scout-flank-pounce', 'howl-scout-claw-rake', 'howl-scout-low-howl'],
    gate: trialGate('scouts-hollow', 20, -22, false, 0, 0) },
  // Gate 3 crosses the 6.5 m temple path that leads down from the terrace to the Temple Descent.
  { id: 'alpha-below', title: 'The Alpha Below', monsterId: 'moonpine-ruun', monsterName: 'Ruun, the Chained Howl', monsterAssetId: 'actor-ruun-chained-howl',
    monsterPosition: { x: 49, y: 4, z: -24 }, arena: { center: { x: 49, y: 4, z: -22 }, radius: 8 },
    attackIds: ['chained-ruun-chain-pounce', 'chained-ruun-howl-shockwave', 'chained-ruun-breaking-ice'],
    gate: trialGate('alpha-below', 47, -5, true, 4, 4) },
];
export const MOONPINE_TRIAL_SET: CombatTrialSet = { regionId: 'moonpine-ridge', encounterId: 'moonpine-trials', clearedTitle: 'Ridge trials cleared', trials: MOONPINE_COMBAT_TRIALS };

/**
 * The four posts the wolf chains are anchored to: on the plateau just behind the temple terrace's rim (outside the walk-mesh and
 * the arena of The Alpha Below). The trial region places `prop-temple-chain-anchor` here and the Ruun kits draw the chains to them.
 */
export const MOONPINE_CHAIN_ANCHORS: readonly Readonly<Vec3>[] = [{ x: 38.8, y: 4, z: -32.4 }, { x: 45, y: 4, z: -35.2 }, { x: 53, y: 4, z: -35.2 }, { x: 55.2, y: 4, z: -32.4 }];

/**
 * The nine Moonpine attacks. Obstacle-word trap (CombatEngine.spawnCombatObstacles): none of the ids contains
 * root|sap|stomp|march|seismic|trample|thorn|charge, so only the two deliberate ice attacks (frost breath, breaking ice) raise
 * ice pillars on the flanks of their landing mark. The pack rush uses a charge lunge, never a charge id. Nothing is `heartroot`.
 */
export const MOONPINE_ATTACKS: Readonly<Record<string, AttackDefinition>> = {
  // Frostfang Tracker: a steady, aggressive pack hunter.
  'frostfang-pack-rush': {
    ...strike('frostfang-pack-rush', 'moonpine-frostfang', 'The tracker drops low and rushes down a straight lane. Sidestep the lane.',
      { kind: 'sweep', width: 1.8, depth: 8, radius: 0, heightAboveGround: 0.9, damage: 14, hitGroup: 'frostfang-pack-rush' }, 54, 12, 18, 46),
    laneFromSource: true,
    lunge: { kind: 'charge' },
  },
  'frostfang-ice-bite': {
    ...strike('frostfang-ice-bite', 'moonpine-frostfang', 'The tracker rears back, jaws rimed with frost, then lunges. Step out of the bite line.',
      { kind: 'sweep', width: 1.6, depth: 5.5, radius: 0, heightAboveGround: 0.7, damage: 13, hitGroup: 'frostfang-ice-bite' }, 40, 12, 8, 46),
    laneFromSource: true,
    lunge: { kind: 'step', meters: 3 },
  },
  'frostfang-frost-breath': {
    ...strike('frostfang-frost-breath', 'moonpine-frostfang', 'Frost gathers in the tracker\'s chest. Get behind or beside it; the freezing breath chills and ice rises where it lands.',
      { kind: 'cone', width: 6, depth: 7, radius: 0, heightAboveGround: 1, damage: 9, hitGroup: 'frostfang-frost-breath' }, 54, 12, 14, 50),
    element: 'ice',
    onHit: { slowFactor: 0.65, slowTicks: 90 },
  },
  // Howl Scout: a fast flanker with short, sharp strikes.
  'howl-scout-flank-pounce': {
    ...strike('howl-scout-flank-pounce', 'moonpine-scout', 'The scout circles wide, crouches and pounces toward where Aren stood. Dive away from the landing.',
      { kind: 'strike', width: 2.2, depth: 2.2, radius: 1.8, heightAboveGround: 0.3, damage: 13, hitGroup: 'howl-scout-flank-pounce' }, 48, 12, 9, 44),
    lunge: { kind: 'step', meters: 5 },
  },
  'howl-scout-claw-rake': {
    ...strike('howl-scout-claw-rake', 'moonpine-scout', 'The scout dashes in and rakes the ground ahead of it with both claws. Step beside the rake or back out of its reach.',
      { kind: 'sweep', width: 2.8, depth: 4.4, radius: 0, heightAboveGround: 0.8, damage: 11, hitGroup: 'howl-scout-claw-rake' }, 38, 12, 8, 42),
    laneFromSource: true,
    lunge: { kind: 'step', meters: 2 },
  },
  'howl-scout-low-howl': {
    ...strike('howl-scout-low-howl', 'moonpine-scout', 'A low howl rolls across the snow as a shockwave. Jump over it or step across.',
      { kind: 'wave', width: 6.5, depth: 1.4, radius: 0, heightAboveGround: 0.18, damage: 9, hitGroup: 'howl-scout-low-howl' }, 54, 15, 14, 48),
    onHit: { pushMeters: 1 },
  },
  // Ruun, the Chained Howl: a heavy controller bound to the temple, whose howl spreads Black Sap.
  'chained-ruun-chain-pounce': {
    ...strike('chained-ruun-chain-pounce', 'moonpine-ruun', 'Ruun heaves against his chains and pounces toward where Aren stood. Move well clear of the landing.',
      { kind: 'strike', width: 3.4, depth: 3.4, radius: 2.6, heightAboveGround: 0.3, damage: 18, hitGroup: 'chained-ruun-chain-pounce' }, 66, 15, 10, 56),
    lunge: { kind: 'step', meters: 4 },
  },
  'chained-ruun-howl-shockwave': {
    ...strike('chained-ruun-howl-shockwave', 'moonpine-ruun', 'Ruun throws back his head for the three-beat howl. Leave the marked ground before the shockwave bursts out of it.',
      { kind: 'area', width: 6.6, depth: 6.6, radius: 0, heightAboveGround: 1.2, damage: 12, hitGroup: 'chained-ruun-howl-shockwave' }, 60, 15, 14, 54),
    onHit: { pushMeters: 1.5 },
  },
  'chained-ruun-breaking-ice': {
    ...strike('chained-ruun-breaking-ice', 'moonpine-ruun', 'Ruun stamps and the ice splits toward Aren in a low wave. Jump it or step across; ice rises where it lands.',
      { kind: 'wave', width: 8, depth: 1.6, radius: 0, heightAboveGround: 0.2, damage: 12, hitGroup: 'chained-ruun-breaking-ice' }, 60, 15, 14, 52),
    element: 'ice',
    onHit: { slowFactor: 0.7, slowTicks: 80 },
  },
};

/** The one wildlife encounter of the map: the three corrupted wolves in trial order. */
export const MOONPINE_ENCOUNTERS: Readonly<Record<string, BossEncounterDefinition>> = {
  'moonpine-trials': {
    ...boss('moonpine-frostfang', 'moonpine-ridge', [
      { id: 'frozen-shore', attackIds: ['frostfang-pack-rush', 'frostfang-ice-bite', 'frostfang-frost-breath'] },
      { id: 'scouts-hollow', attackIds: ['howl-scout-flank-pounce', 'howl-scout-claw-rake', 'howl-scout-low-howl'] },
      { id: 'alpha-below', attackIds: ['chained-ruun-chain-pounce', 'chained-ruun-howl-shockwave', 'chained-ruun-breaking-ice'] },
    ], [], ['player-dodge', 'player-tether', 'player-cleanse', 'player-light']),
    id: 'moonpine-trials',
    actorIds: ['aren', 'moonpine-frostfang', 'moonpine-scout', 'moonpine-ruun'],
    encounterFamily: 'wildlife',
  },
};

export const MOONPINE_MONSTER_PROFILES: Readonly<Record<string, MonsterProfile>> = {
  // Steady aggressive hunter: holds 4.5-7.5 m, long strafes, quick to close.
  'moonpine-frostfang': { radius: 0.8, bandMin: 4.5, bandMax: 7.5, advanceSpeed: 4.6, circleSpeed: 3.2, retreatSpeed: 3.6, yawRate: 4.2, strafeTicks: [90, 170] },
  // Fast flanker: tight 3.5-6 m band, very quick and erratic circling.
  'moonpine-scout': { radius: 0.7, bandMin: 3.5, bandMax: 6, advanceSpeed: 5.6, circleSpeed: 4.8, retreatSpeed: 4.6, yawRate: 5.6, strafeTicks: [50, 110] },
  // Heavy controller: wide 5-8 m band, slow ponderous turns, long strafes.
  'moonpine-ruun': { radius: 1.1, bandMin: 5, bandMax: 8, advanceSpeed: 2.8, circleSpeed: 2, retreatSpeed: 2.4, yawRate: 2.6, strafeTicks: [160, 280] },
};

const wolf = (id: string, assetId: string): ActorDefinition => ({ id, species: 'wolf', role: 'wild', allegiance: 'wild', combatRole: 'hostile', assetId });
export const MOONPINE_ACTORS: Readonly<Record<string, ActorDefinition>> = {
  'moonpine-frostfang': wolf('moonpine-frostfang', 'actor-frostfang-tracker'),
  'moonpine-scout': wolf('moonpine-scout', 'actor-howl-scout'),
  'moonpine-ruun': wolf('moonpine-ruun', 'actor-ruun-chained-howl'),
};

/** Identity glow of cracks, rims and decal embers: frost-blue tracker, wind-pale scout, black-sap Ruun. */
export const MOONPINE_OWNER_GLOW: Readonly<Record<string, VfxElement>> = {
  'moonpine-frostfang': 'ice', 'moonpine-scout': 'wind', 'moonpine-ruun': 'sap',
};

/** The temple, the chain anchors and the snow rocks are physical; the tree trunk and log bridge profiles already live in solid-props. */
export const MOONPINE_SOLID_PROFILES: Readonly<Record<string, SolidPropKind>> = {
  'prop-buried-wolf-temple': 'solid', 'prop-temple-chain-anchor': 'solid', 'prop-snow-ridge-rock': 'solid',
};

/** Placement-id prefix of this map's deterministic boundary dressing (decoration only, no colliders). */
export const MOONPINE_BOUNDARY_ID_PREFIX = 'moonpine-boundary-';
