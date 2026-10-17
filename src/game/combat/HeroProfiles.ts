import type { HeroId } from '../heroes.js';
import type { AttackElement } from './content.js';
import { PLAYER_MAX_VITALITY, PLAYER_RUN_SPEED, PLAYER_WALK_SPEED } from './PlayerSkills.js';
import type { WeightClass } from './reactions.js';

/** Per-hero simulation profile: health pool, grounded locomotion speeds (m/s) and the element of the hero's attacks. */
export interface HeroCombatProfile {
  readonly maxVitality: number;
  readonly walkSpeed: number;
  readonly runSpeed: number;
  /** Offensive cadence shared by simulation phase timings and native hero-select playback. */
  readonly attackPlaybackRate: number;
  readonly element: AttackElement;
  /** Weight class: scales how far monster blows push the hero and whether a heavy hero absorbs a reaction tier. */
  readonly mass: WeightClass;
}

/**
 * Authoritative combat numbers per playable hero. Before a hero is chosen the engine runs on the plain
 * `PLAYER_*` defaults from PlayerSkills; `setPlayerHero` switches the player slot to its profile.
 */
export const HERO_COMBAT: Readonly<Record<HeroId, HeroCombatProfile>> = Object.freeze({
  aren: { maxVitality: 120, walkSpeed: PLAYER_WALK_SPEED, runSpeed: PLAYER_RUN_SPEED, attackPlaybackRate: 1, element: 'arcane', mass: 'medium' },
  yara: { maxVitality: 85, walkSpeed: 4.1, runSpeed: 6, attackPlaybackRate: 1, element: 'heartroot', mass: 'light' },
  vesper: { maxVitality: 80, walkSpeed: 4.9, runSpeed: 7.5, attackPlaybackRate: 1.35, element: 'umbral', mass: 'light' },
  sakda: { maxVitality: 115, walkSpeed: 4.4, runSpeed: 6.6, attackPlaybackRate: 0.7, element: 'ember', mass: 'heavy' },
});

/** Engine defaults used while no hero has been chosen (a fresh engine, region loads in tests). */
export const DEFAULT_COMBAT_PROFILE: HeroCombatProfile = Object.freeze({
  maxVitality: PLAYER_MAX_VITALITY, walkSpeed: PLAYER_WALK_SPEED, runSpeed: PLAYER_RUN_SPEED, attackPlaybackRate: 1, element: 'arcane', mass: 'medium',
});
