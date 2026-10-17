import { COMPANION_IDS } from '../../../packages/campaign/src/index.js';
import type { CompanionId, CompanionParty } from '../contracts.js';
import type { HeroId } from '../heroes.js';
import { isRecord } from '../guards.js';

export function isCompanionId(value: unknown): value is CompanionId {
  return typeof value === 'string' && (COMPANION_IDS as readonly string[]).includes(value);
}

/** Preferences belong to hero selection, never to narrative recruitment or Bond. */
export const DEFAULT_HERO_COMPANIONS: Readonly<Record<HeroId, CompanionId>> = {
  aren: 'koro', yara: 'vara', vesper: 'nyra', sakda: 'asha',
};

export function validHeroCompanions(value: unknown): value is Record<HeroId, CompanionId> {
  return isRecord(value) && Object.keys(value).length === 4
    && Object.keys(DEFAULT_HERO_COMPANIONS).every(id => isCompanionId(value[id]));
}

export function isCompanionParty(value: unknown): value is CompanionParty {
  return isRecord(value) && Object.keys(value).every(key => key === 'companionId')
    && (value.companionId === undefined || isCompanionId(value.companionId));
}

/** Read-boundary migration only. Runtime and newly written saves contain one companionId, never role slots. */
export function migrateCompanionParty(value: unknown): CompanionParty | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.every(key => key === 'companionId')) {
    return value.companionId === undefined ? {} : isCompanionId(value.companionId) ? { companionId: value.companionId } : null;
  }
  if (!keys.every(key => key === 'combat' || key === 'utility' || key === 'scout') || value.scout !== 'vara') return null;
  for (const id of [value.combat, value.utility]) if (id !== undefined && (!isCompanionId(id) || id === 'vara')) return null;
  if (value.combat !== undefined && value.combat === value.utility) return null;
  // Preserve the old primary choice; a Utility or Scout remains selected when no Combat ally was equipped.
  return { companionId: (value.combat ?? value.utility ?? value.scout) as CompanionId };
}
