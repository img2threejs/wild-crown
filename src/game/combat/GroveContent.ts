import type { ActorDefinition } from '../contracts.js';
import type { SolidPropKind } from '../../content/solid-props.js';
import type { VfxElement } from '../../effects/vfx/palette.js';
import { boss, strike } from './attack-builders.js';
import type { AttackDefinition, BossEncounterDefinition } from './content.js';
import type { CombatTrialDefinition, CombatTrialSet } from './CombatTrials.js';
import { trialGate } from './trialGate.js';
import type { MonsterProfile } from './WildlifePressure.js';

/**
 * The Grove sanctuary hub: Heartroot sapling, Yara's camp, the spring and the nonlethal practice ring.
 * Gameplay data of this local playtest map; the shared registries (CombatTrials, content, WildlifePressure, world ACTORS,
 * palette OWNER_GLOW, solid-props) spread these tables, so this module only imports the attack and gate builders at runtime.
 *
 * Sparring opens the Memory Pool spur and qualifies the local stage; it changes no campaign history.
 */
export const GROVE_COMBAT_TRIALS: readonly CombatTrialDefinition[] = [
  // The practice ring lies north-west of the glade; its gate crosses the 6 m spur that leads on to the Memory Pool overlook.
  { id: 'evasion-practice', title: 'Heartroot Practice', monsterId: 'grove-sprig', monsterName: 'Heartroot Sprig', monsterAssetId: 'actor-grove-rootling',
    monsterPosition: { x: -24, y: 0, z: -26 }, arena: { center: { x: -24, y: 0, z: -22 }, radius: 8 },
    attackIds: ['sprig-seed-toss', 'sprig-ground-ripple', 'sprig-petal-sweep'],
    gate: trialGate('evasion-practice', -24, -38, true, 0, 0) },
];
export const GROVE_TRIAL_SET: CombatTrialSet = { regionId: 'the-grove', encounterId: 'grove-practice', clearedTitle: 'Practice complete', trials: GROVE_COMBAT_TRIALS };

/**
 * Gentle sparring attacks (4 to 6 damage, long windups). None of the ids contains an obstacle word
 * (root|sap|stomp|march|seismic|trample|thorn|charge) and none is elemental, so no pillars spawn; the amber/green look comes from GROVE_ATTACK_KITS.
 */
export const GROVE_ATTACKS: Readonly<Record<string, AttackDefinition>> = {
  'sprig-seed-toss': strike('sprig-seed-toss', 'grove-sprig', 'The sprig lobs a glowing seed toward where Aren stood. Step off the mark before it lands.',
    { kind: 'strike', width: 1.6, depth: 1.6, radius: 1.6, heightAboveGround: 0.2, damage: 4, hitGroup: 'sprig-seed-toss' }, 66, 14, 10, 54),
  'sprig-ground-ripple': strike('sprig-ground-ripple', 'grove-sprig', 'A low ripple runs through the grass toward Aren. Jump over it or step across.',
    { kind: 'wave', width: 5, depth: 1.2, radius: 0, heightAboveGround: 0.18, damage: 5, hitGroup: 'sprig-ground-ripple' }, 60, 14, 14, 56),
  'sprig-petal-sweep': {
    ...strike('sprig-petal-sweep', 'grove-sprig', 'Petals fan out in a straight lane from the sprig. Sidestep the lane.',
      { kind: 'sweep', width: 2.4, depth: 6.5, radius: 0, heightAboveGround: 0.8, damage: 6, hitGroup: 'sprig-petal-sweep' }, 66, 14, 12, 54),
    laneFromSource: true,
  },
};

/** The one wildlife encounter of the map; its roster is exactly the practice monster (Koro is scenery and never joins it). */
export const GROVE_ENCOUNTERS: Readonly<Record<string, BossEncounterDefinition>> = {
  'grove-practice': {
    ...boss('grove-sprig', 'the-grove', [
      { id: 'evasion-practice', attackIds: ['sprig-seed-toss', 'sprig-ground-ripple', 'sprig-petal-sweep'] },
    ], [], ['player-dodge', 'player-tether', 'player-cleanse', 'player-light']),
    id: 'grove-practice',
    actorIds: ['aren', 'grove-sprig'],
    encounterFamily: 'wildlife',
  },
};

/** Gentle sparring band: holds 5 to 8 m, slow advance and wide, unhurried circling. */
export const GROVE_MONSTER_PROFILES: Readonly<Record<string, MonsterProfile>> = {
  'grove-sprig': { radius: 0.6, bandMin: 5, bandMax: 8, advanceSpeed: 2.2, circleSpeed: 1.5, retreatSpeed: 2, yawRate: 2.2, strafeTicks: [150, 260] },
};

export const GROVE_ACTORS: Readonly<Record<string, ActorDefinition>> = {
  // Wild, hostile sparring spirit (the practice partner); placed only by the Grove playtest variant.
  'grove-sprig': { id: 'grove-sprig', species: 'rootling', role: 'wild', allegiance: 'wild', combatRole: 'hostile', assetId: 'actor-grove-rootling' },
  // Koro idles beneath the monkey lookouts: an ally that never fights, is never a party companion and is never targeted.
  'grove-koro': { id: 'grove-koro', species: 'macaque', role: 'leader', allegiance: 'ally', combatRole: 'noncombat', assetId: 'actor-koro' },
};

/** Identity glow (cracks, rims, decal embers) of the practice partner: warm gold-green, never the player's `heartroot` look. */
export const GROVE_OWNER_GLOW: Readonly<Record<string, VfxElement>> = { 'grove-sprig': 'sap' };

/** Tent, spring basin and practice posts collide as native solids; the lookout deck is not walkable (no walk surface stands at its height). */
export const GROVE_SOLID_PROFILES: Readonly<Record<string, SolidPropKind>> = {
  'prop-refuge-shelter': 'solid',
  'prop-water-basin': 'solid',
  'prop-training-post': 'trunk',
  'prop-grove-platform': 'platform',
};

/** Placement-id prefix of this map's deterministic boundary dressing (decoration only, no colliders). */
export const GROVE_BOUNDARY_ID_PREFIX = 'grove-boundary-';
