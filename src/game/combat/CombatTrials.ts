import type { ActorId, RegionColliderDefinition, RegionId, Vec3 } from '../contracts.js';
import { GROVE_TRIAL_SET } from './GroveContent.js';
import { MISTVEIL_TRIAL_SET } from './MistveilContent.js';
import { MOONPINE_TRIAL_SET } from './MoonpineContent.js';
import { trialGate as gate } from './trialGate.js';

export interface CombatTrialDefinition {
  readonly id: string;
  readonly title: string;
  readonly monsterId: ActorId;
  readonly monsterName: string;
  /** Playtest-only native character asset rendered for this trial's monster entity. */
  readonly monsterAssetId: string;
  readonly monsterPosition: Vec3;
  /** Walkable combat arena the trial monster may reposition within; it never leaves this circle. */
  readonly arena: { readonly center: Vec3; readonly radius: number };
  readonly attackIds: readonly string[];
  readonly gate: RegionColliderDefinition;
}
/** The ordered trials of one playtest region, and the authored encounter that hosts them. */
export interface CombatTrialSet {
  readonly regionId: RegionId;
  readonly encounterId: string;
  /** Encounter title once every gate is open. */
  readonly clearedTitle: string;
  readonly trials: readonly CombatTrialDefinition[];
}
/** Native root-wall model fitted to every trial gate box (loaded standalone, not as a region placement). */
export const TRIAL_GATE_ASSET_ID = 'prop-greenwake-root-gate';
export const GREENWAKE_COMBAT_TRIALS: readonly CombatTrialDefinition[] = [
  // Gate 1 seals the root ramp (6..13 m wide, rising 0.2 m per metre) that is the start basin's only exit.
  { id: 'ember-crossing', title: 'Ember Crossing', monsterId: 'corrupted-boar', monsterName: 'Ember Boar', monsterAssetId: 'actor-ember-boar',
    monsterPosition: { x: 6, y: 0, z: -3 }, arena: { center: { x: 8, y: 0, z: -3 }, radius: 8 },
    attackIds: ['boar-charge', 'boar-ember-lance', 'boar-gale-scythe'],
    gate: gate('ember-crossing', 9.5, 11, true, 1.28, 1.52) },
  // Gate 2 crosses the 7 m north-south corridor below the Frost Hollow pocket.
  { id: 'frost-hollow', title: 'Frost Hollow', monsterId: 'greenwake-sap-stalker', monsterName: 'Frost Sap-Stalker', monsterAssetId: 'actor-frost-sap-stalker',
    monsterPosition: { x: 40, y: 0, z: 24 }, arena: { center: { x: 39, y: 0, z: 24 }, radius: 8 },
    attackIds: ['sap-stalker-frost-bloom', 'sap-stalker-venom-mist', 'sap-vein-snap'],
    gate: gate('frost-hollow', 40, 34, true, 0, 0) },
  // Gate 3 crosses the 7 m east-west corridor below the Root Watch pocket, ahead of the diagonal run to the Forest Exit.
  { id: 'root-watch', title: 'Root Watch', monsterId: 'greenwake-root-rammer', monsterName: 'Root Rammer', monsterAssetId: 'actor-root-rammer',
    monsterPosition: { x: 47, y: 0, z: 46 }, arena: { center: { x: 46.5, y: 0, z: 46 }, radius: 8 },
    attackIds: ['root-rammer-low-wave', 'root-rammer-cinder-burst', 'root-rammer-gale-sweep'],
    gate: gate('root-watch', 57, 46, false, 0, 0) },
];
export const CANOPY_COMBAT_TRIALS: readonly CombatTrialDefinition[] = [
  // Gate 1 seals the root stair (6 m wide, rising 4 m over 12 m) that is the waterfall basin's only exit.
  { id: 'howler-pool', title: "Howler's Pool", monsterId: 'canopy-howler', monsterName: 'Thornback Howler', monsterAssetId: 'actor-thornback-howler',
    monsterPosition: { x: -46, y: 0, z: -26 }, arena: { center: { x: -49, y: 0, z: -28 }, radius: 8 },
    attackIds: ['howler-rock-hurl', 'howler-leap-slam', 'howler-branch-sweep'],
    gate: gate('howler-pool', -33.5, -28, false, 0.63, 1.03) },
  // Gate 2 stands on the 3 m chasm bridge east of the hornbill roost.
  { id: 'hornbill-roost', title: 'Hornbill Roost', monsterId: 'canopy-hornbill', monsterName: 'Storm Hornbill', monsterAssetId: 'actor-storm-hornbill',
    monsterPosition: { x: 7, y: 4, z: -24 }, arena: { center: { x: 5, y: 4, z: -26 }, radius: 8 },
    attackIds: ['hornbill-dive-bomb', 'hornbill-feather-volley', 'hornbill-gale-flap'],
    gate: gate('hornbill-roost', 14.6, -23.5, false, 4, 4) },
  // Gate 3 crosses the 7 m exit path below the temple courtyard.
  { id: 'viper-temple', title: 'Viper Temple', monsterId: 'canopy-mire-viper', monsterName: 'Mire Viper', monsterAssetId: 'actor-mire-viper',
    monsterPosition: { x: 49, y: 0, z: -20 }, arena: { center: { x: 47, y: 0, z: -22 }, radius: 8 },
    attackIds: ['viper-venom-spit', 'viper-tail-lash', 'viper-strike-lunge'],
    gate: gate('viper-temple', 47, -9, true, 0, 0) },
];
export const GREENWAKE_TRIAL_SET: CombatTrialSet = { regionId: 'greenwake', encounterId: 'greenwake-boar', clearedTitle: 'Forest trials cleared', trials: GREENWAKE_COMBAT_TRIALS };
export const CANOPY_TRIAL_SET: CombatTrialSet = { regionId: 'whispering-canopy', encounterId: 'canopy-trials', clearedTitle: 'Canopy trials cleared', trials: CANOPY_COMBAT_TRIALS };
export const COMBAT_TRIAL_SETS: readonly CombatTrialSet[] = [GREENWAKE_TRIAL_SET, CANOPY_TRIAL_SET, GROVE_TRIAL_SET, MOONPINE_TRIAL_SET, MISTVEIL_TRIAL_SET];
/** The trial set a region hosts, or undefined for regions without playtest trials. */
export function combatTrialSetFor(regionId: RegionId): CombatTrialSet | undefined {
  return COMBAT_TRIAL_SETS.find(set => set.regionId === regionId);
}
export interface CombatTrialState {
  index: number;
  status: 'approach' | 'fighting' | 'open' | 'complete';
}
export function createCombatTrialState(): CombatTrialState {
  return { index: 0, status: 'approach' };
}
