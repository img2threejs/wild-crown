import type { HeroId } from '../heroes.js';
import type { AttackElement } from './content.js';
import { PLAYER_MAX_VITALITY, PLAYER_RUN_SPEED, PLAYER_WALK_SPEED } from './PlayerSkills.js';

/** Per-hero simulation profile: health pool, grounded locomotion speeds (m/s) and the element of the hero's attacks. */
export interface HeroCombatProfile {
  readonly maxVitality: number;
  readonly walkSpeed: number;
  readonly runSpeed: number;
  readonly element: AttackElement;
}

/**
 * Authoritative combat numbers per playable hero. Before a hero is chosen the engine runs on the plain
 * `PLAYER_*` defaults from PlayerSkills; `setPlayerHero` switches the player slot to its profile.
 */
export const HERO_COMBAT: Readonly<Record<HeroId, HeroCombatProfile>> = Object.freeze({
  aren: { maxVitality: 120, walkSpeed: PLAYER_WALK_SPEED, runSpeed: PLAYER_RUN_SPEED, element: 'arcane' },
  yara: { maxVitality: 85, walkSpeed: 4.1, runSpeed: 6, element: 'heartroot' },
  vesper: { maxVitality: 80, walkSpeed: 4.9, runSpeed: 7.5, element: 'umbral' },
  sakda: { maxVitality: 115, walkSpeed: 4.4, runSpeed: 6.6, element: 'ember' },
});

/** Engine defaults used while no hero has been chosen (a fresh engine, region loads in tests). */
export const DEFAULT_COMBAT_PROFILE: HeroCombatProfile = Object.freeze({
  maxVitality: PLAYER_MAX_VITALITY, walkSpeed: PLAYER_WALK_SPEED, runSpeed: PLAYER_RUN_SPEED, element: 'arcane',
});
