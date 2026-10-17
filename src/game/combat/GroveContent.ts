import type { ActorDefinition } from '../contracts.js';
import type { SolidPropKind } from '../../content/solid-props.js';
import type { VfxElement } from '../../effects/vfx/palette.js';
import { boss, strike } from './attack-builders.js';
import type { AttackDefinition, BossEncounterDefinition } from './content.js';
import type { CombatTrialDefinition, CombatTrialSet } from './CombatTrials.js';
import { trialGate } from './trialGate.js';
import type { MonsterProfile } from './WildlifePressure.js';

/**
 * The Grove sanctuary: Heartroot sapling, Yara's camp, the spring and the road north to the Memory Pool, which the Black Sap has reached.
 * Gameplay data of this local playtest map; the shared registries (CombatTrials, content, WildlifePressure, world ACTORS,
 * palette OWNER_GLOW, solid-props) spread these tables, so this module only imports the attack and gate builders at runtime.
 *
 * Nothing in the Grove hunts; the three stages defend it. Heartroot Practice is the nonlethal sparring ring, the Black Sap Incursion
 * is a blighted rootling where the sap has seeped into the hollow before the pool, and the Memory Pool holds Hollowheart, the Heartroot
 * guardian whose heart-light the sap has cracked. Clearing a stage opens its gate; the last gate opens the Ridge Trail exit. The run
 * qualifies the local stage and changes no campaign history.
 */
export const GROVE_COMBAT_TRIALS: readonly CombatTrialDefinition[] = [
  // Stage 1. The practice ring lies north-west of the glade; its gate crosses the 6 m spur that leads north into the blighted hollow.
  { id: 'evasion-practice', title: 'Heartroot Practice', monsterId: 'grove-sprig', monsterName: 'Heartroot Sprig', monsterAssetId: 'actor-grove-rootling',
    monsterPosition: { x: -24, y: 0, z: -26 }, arena: { center: { x: -24, y: 0, z: -22 }, radius: 8 },
    attackIds: ['sprig-seed-toss', 'sprig-ground-ripple', 'sprig-petal-sweep'],
    gate: trialGate('evasion-practice', -24, -38, true, 0, 0) },
  // Stage 2. Black Sap has seeped into the hollow before the pool and blighted a rootling; its gate crosses the 6 m spur to the Memory Pool.
  { id: 'sap-incursion', title: 'Black Sap Incursion', monsterId: 'grove-blighted', monsterName: 'Blighted Rootling', monsterAssetId: 'actor-grove-blighted-rootling',
    monsterPosition: { x: -24, y: 0, z: -60 }, arena: { center: { x: -24, y: 0, z: -56 }, radius: 8 },
    attackIds: ['blighted-seed-lob', 'blighted-ground-pulse', 'blighted-lash-sweep'],
    gate: trialGate('sap-incursion', -24, -72, true, 0, 0) },
  // Stage 3. The Memory Pool arena (a wide clearing, radius 11 for the guardian's reach); its gate crosses the 6 m Ridge Trail to the exit.
  { id: 'memory-pool', title: 'The Memory Pool', monsterId: 'grove-hollowheart', monsterName: 'Hollowheart, the Sapbound Guardian', monsterAssetId: 'actor-grove-hollowheart',
    monsterPosition: { x: -24, y: 0, z: -102 }, arena: { center: { x: -24, y: 0, z: -96 }, radius: 11 },
    attackIds: ['hollowheart-leap-smash', 'hollowheart-antler-sweep', 'hollowheart-ichor-hurl', 'hollowheart-heartlight-burst'],
    gate: trialGate('memory-pool', -1, -96, false, 0, 0) },
];
export const GROVE_TRIAL_SET: CombatTrialSet = { regionId: 'the-grove', encounterId: 'grove-defence', clearedTitle: 'Sanctuary defended', trials: GROVE_COMBAT_TRIALS };

/**
 * Grove attacks. None of the ids contains an obstacle word (root|sap|stomp|march|seismic|trample|thorn|charge) and none is elemental,
 * so no pillars spawn; the amber/green (practice) and sickly green/black (blight, guardian) look comes from GROVE_ATTACK_KITS.
 * Sprig: gentle sparring (4 to 6 damage, long windups). Blighted Rootling: the same three shapes, harder and darker. Hollowheart: four
 * telegraphed boss attacks, each one a distinct counter (leap away, sidestep the lane, leave the mark, jump out of the ring).
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
  // Blighted Rootling: sap-black seeds, a sickly pulse through the grass and a lashing sweep; quicker and heavier than the sprig.
  'blighted-seed-lob': strike('blighted-seed-lob', 'grove-blighted', 'The blighted rootling spits a clot of dark sap at where Aren stood. Step off the mark before it bursts.',
    { kind: 'strike', width: 1.9, depth: 1.9, radius: 1.9, heightAboveGround: 0.2, damage: 7, hitGroup: 'blighted-seed-lob' }, 58, 14, 10, 50),
  'blighted-ground-pulse': strike('blighted-ground-pulse', 'grove-blighted', 'Sap-black veins crawl through the grass toward Aren. Jump over the pulse or step across.',
    { kind: 'wave', width: 5.6, depth: 1.3, radius: 0, heightAboveGround: 0.18, damage: 8, hitGroup: 'blighted-ground-pulse' }, 56, 14, 14, 52),
  'blighted-lash-sweep': {
    ...strike('blighted-lash-sweep', 'grove-blighted', 'The blighted rootling lashes a straight lane of sap-black petals. Sidestep the lane.',
      { kind: 'sweep', width: 2.6, depth: 7, radius: 0, heightAboveGround: 0.8, damage: 9, hitGroup: 'blighted-lash-sweep' }, 58, 14, 12, 50),
    laneFromSource: true,
  },
  // Hollowheart, the Sapbound Guardian: a heavy leap, a wide antler sweep, a hurled clot of sap and the cracked heart-light bursting from the ground.
  'hollowheart-leap-smash': {
    ...strike('hollowheart-leap-smash', 'grove-hollowheart', 'Hollowheart crouches, then leaps and smashes down where Aren stood. Dive clear of the landing.',
      { kind: 'strike', width: 3.4, depth: 3.4, radius: 3, heightAboveGround: 0.3, damage: 14, hitGroup: 'hollowheart-leap-smash' }, 72, 16, 10, 62),
    lunge: { kind: 'step', meters: 4 },
  },
  'hollowheart-antler-sweep': {
    ...strike('hollowheart-antler-sweep', 'grove-hollowheart', 'The guardian drags its swollen arm back and sweeps a long lane. Sidestep the lane, behind its shoulder.',
      { kind: 'sweep', width: 2.8, depth: 7.5, radius: 0, heightAboveGround: 0.9, damage: 11, hitGroup: 'hollowheart-antler-sweep' }, 64, 14, 12, 54),
    laneFromSource: true,
    lunge: { kind: 'step', meters: 2 },
  },
  'hollowheart-ichor-hurl': {
    ...strike('hollowheart-ichor-hurl', 'grove-hollowheart', 'Hollowheart hurls a clot of Black Sap toward where Aren stood. Step off the mark; the sap clings and slows.',
      { kind: 'strike', width: 2.4, depth: 2.4, radius: 2.2, heightAboveGround: 0.25, damage: 9, hitGroup: 'hollowheart-ichor-hurl' }, 68, 14, 10, 56),
    onHit: { slowFactor: 0.7, slowTicks: 80 },
  },
  'hollowheart-heartlight-burst': {
    ...strike('hollowheart-heartlight-burst', 'grove-hollowheart', 'The cracked heart-light flares. Leave the marked ground before the light bursts out of it.',
      { kind: 'area', width: 7.4, depth: 7.4, radius: 0, heightAboveGround: 1.2, damage: 10, hitGroup: 'hollowheart-heartlight-burst' }, 70, 15, 14, 58),
    onHit: { pushMeters: 1.5 },
  },
};

/** The one wildlife encounter of the map: the three defenders in trial order (Koro is scenery and never joins it). */
export const GROVE_ENCOUNTERS: Readonly<Record<string, BossEncounterDefinition>> = {
  'grove-defence': {
    ...boss('grove-sprig', 'the-grove', [
      { id: 'evasion-practice', attackIds: ['sprig-seed-toss', 'sprig-ground-ripple', 'sprig-petal-sweep'] },
      { id: 'sap-incursion', attackIds: ['blighted-seed-lob', 'blighted-ground-pulse', 'blighted-lash-sweep'] },
      { id: 'memory-pool', attackIds: ['hollowheart-leap-smash', 'hollowheart-antler-sweep', 'hollowheart-ichor-hurl', 'hollowheart-heartlight-burst'] },
    ], ['grove-hollowheart'], ['player-dodge', 'player-tether', 'player-cleanse', 'player-light']),
    id: 'grove-defence',
    actorIds: ['aren', 'grove-sprig', 'grove-blighted', 'grove-hollowheart'],
    encounterFamily: 'wildlife',
  },
};

export const GROVE_MONSTER_PROFILES: Readonly<Record<string, MonsterProfile>> = {
  // Gentle sparring band: holds 5 to 8 m, slow advance and wide, unhurried circling.
  'grove-sprig': { radius: 0.6, bandMin: 5, bandMax: 8, advanceSpeed: 2.2, circleSpeed: 1.5, retreatSpeed: 2, yawRate: 2.2, strafeTicks: [150, 260] },
  // Blighted: the same body, quicker and twitchier; holds 4.5 to 7.5 m and circles faster.
  'grove-blighted': { radius: 0.6, bandMin: 4.5, bandMax: 7.5, advanceSpeed: 3, circleSpeed: 2.2, retreatSpeed: 2.6, yawRate: 3, strafeTicks: [110, 200] },
  // Guardian: a heavy controller; holds 5 to 9 m inside its 11 m arena, slow ponderous turns and long strafes.
  'grove-hollowheart': { radius: 1.1, bandMin: 5, bandMax: 9, advanceSpeed: 2.6, circleSpeed: 1.8, retreatSpeed: 2.2, yawRate: 2.4, strafeTicks: [150, 260] },
};

export const GROVE_ACTORS: Readonly<Record<string, ActorDefinition>> = {
  // Wild, hostile sparring spirit (the practice partner); placed only by the Grove playtest variant.
  'grove-sprig': { id: 'grove-sprig', species: 'rootling', role: 'wild', allegiance: 'wild', combatRole: 'hostile', assetId: 'actor-grove-rootling' },
  // The same rootling body, blighted by Black Sap: a second actor on its own darkened variant of the native asset (a manifest entry maps one actor).
  'grove-blighted': { id: 'grove-blighted', species: 'rootling', role: 'wild', allegiance: 'wild', combatRole: 'hostile', assetId: 'actor-grove-blighted-rootling' },
  // The Memory Pool guardian (a Heartroot Warden spirit corrupted by Black Sap).
  'grove-hollowheart': { id: 'grove-hollowheart', species: 'rootling', role: 'wild', allegiance: 'wild', combatRole: 'hostile', assetId: 'actor-grove-hollowheart' },
  // Koro idles beneath the monkey lookouts: an ally that never fights, is never a party companion and is never targeted.
  'grove-koro': { id: 'grove-koro', species: 'macaque', role: 'leader', allegiance: 'ally', combatRole: 'noncombat', assetId: 'actor-koro' },
};

/**
 * Identity glow (cracks, rims, decal embers): warm gold-green for the practice partner, sickly poison green for the blighted rootling and
 * Black Sap for the guardian, never the player's `heartroot` look.
 */
export const GROVE_OWNER_GLOW: Readonly<Record<string, VfxElement>> = { 'grove-sprig': 'sap', 'grove-blighted': 'poison', 'grove-hollowheart': 'sap' };

/**
 * Tent, spring basin and practice posts collide as native solids; the lookout deck is not walkable (no walk surface stands at its height).
 * The ruin, cavern mouth and rocks of the Memory Pool are unlisted props and stay physical by default.
 */
export const GROVE_SOLID_PROFILES: Readonly<Record<string, SolidPropKind>> = {
  'prop-refuge-shelter': 'solid',
  'prop-water-basin': 'solid',
  'prop-training-post': 'trunk',
  'prop-grove-platform': 'platform',
};

/** Placement-id prefix of this map's deterministic boundary dressing (decoration only, no colliders). */
export const GROVE_BOUNDARY_ID_PREFIX = 'grove-boundary-';
