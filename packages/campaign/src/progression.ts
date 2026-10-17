import { isRecord } from './guards.js';
import type { CampaignState, DominionEvent, FactionId, FragmentId, LeaderId, WorldState } from './index.js';

/** Companion identities the campaign can recruit. Species, party membership and health are derived elsewhere, never persisted here. */
export const COMPANION_IDS = ['vara', 'koro', 'asha', 'sable', 'nyra', 'solkar'] as const;
export type CampaignCompanionId = (typeof COMPANION_IDS)[number];

/** Inclusive bounds of both relationship levels. */
export const COMPANION_LEVEL_MIN = 0;
export const COMPANION_LEVEL_MAX = 100;
/** Act I tuning, explicit and data-only: a state-shape change is not required to rebalance these. */
export const RECRUITMENT_BOND = 10;
export const RESPECTFUL_PACT_BOND = 15;
export const DOMINION_PACT_LEVEL = 25;
/** Dominion level at which a stronger special unlocks together with its visible possession-risk flag. */
export const DOMINION_SPECIAL_THRESHOLD = 25;
export const DOMINION_SPECIAL_ABILITY_ID = 'dominion-special';
export const POSSESSION_RISK_FLAG = 'possession-risk';
export const LEGACY_MIGRATED_FLAG = 'legacy-migrated';
/** Documented initial personal Bond for a recruited companion whose faction had covenant tier 0/1/2/3 in a schema-1 save. */
export const LEGACY_TIER_BOND = [0, 25, 50, 75] as const;
/** Core story verbs unlock at recruitment so a low Bond never blocks mandatory progress. */
export const COMPANION_CORE_ABILITY_IDS: Readonly<Record<CampaignCompanionId, readonly string[]>> = {
  vara: ['mark'],
  koro: ['distract', 'move-object'],
  asha: ['guard-charge'],
  sable: [],
  nyra: [],
  solkar: [],
};
/** The faction whose political covenant tier seeded a migrated companion's personal Bond. Political tier stays separate state. */
const COMPANION_FACTION: Readonly<Record<CampaignCompanionId, FactionId>> = {
  vara: 'sky', koro: 'canopy', asha: 'fang', sable: 'pack', nyra: 'shadow', solkar: 'crown',
};
/** Heartroot fragment a schema-1 save held for each companion; used only to derive legacy recruitment. */
const LEGACY_FRAGMENT: Readonly<Record<CampaignCompanionId, FragmentId>> = {
  vara: 'heartroot-sky', koro: 'heartroot-canopy', asha: 'heartroot-fang',
  sable: 'heartroot-pack', nyra: 'heartroot-shadow', solkar: 'heartroot-crown',
};

export interface CompanionProgress {
  id: CampaignCompanionId;
  recruited: boolean;
  /** Validated integer in [0, 100]. */
  bondLevel: number;
  /** Validated integer in [0, 100]. Monotonic floor comes from the run's leader-Dominion history. */
  dominionLevel: number;
  unlockedAbilityIds: readonly string[];
  storyFlags: Readonly<Record<string, boolean>>;
}
export type CompanionRoster = Record<CampaignCompanionId, CompanionProgress>;

const isLevel = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= COMPANION_LEVEL_MIN && value <= COMPANION_LEVEL_MAX;
const clampLevel = (value: number): number => Math.max(COMPANION_LEVEL_MIN, Math.min(COMPANION_LEVEL_MAX, value));
export const isCompanionId = (value: unknown): value is CampaignCompanionId =>
  typeof value === 'string' && (COMPANION_IDS as readonly string[]).includes(value);

export function createCompanionProgress(id: CampaignCompanionId): CompanionProgress {
  return { id, recruited: false, bondLevel: 0, dominionLevel: 0, unlockedAbilityIds: [], storyFlags: {} };
}

export function createCompanionRoster(): CompanionRoster {
  return Object.fromEntries(COMPANION_IDS.map((id) => [id, createCompanionProgress(id)])) as CompanionRoster;
}

export function validCompanionRoster(value: unknown): value is CompanionRoster {
  if (!isRecord(value) || Object.keys(value).length !== COMPANION_IDS.length) return false;
  return COMPANION_IDS.every((id) => {
    const entry = value[id];
    if (!isRecord(entry) || Object.keys(entry).length !== 6) return false;
    const abilities = entry.unlockedAbilityIds;
    const flags = entry.storyFlags;
    return entry.id === id
      && typeof entry.recruited === 'boolean'
      && isLevel(entry.bondLevel) && isLevel(entry.dominionLevel)
      && Array.isArray(abilities) && abilities.every((ability) => typeof ability === 'string' && ability.length > 0)
      && new Set(abilities).size === abilities.length
      && isRecord(flags) && Object.values(flags).every((flag) => typeof flag === 'boolean')
      // Bond and unlocked verbs only exist for a recruited companion; Dominion may predate recruitment history.
      && (entry.recruited || (entry.bondLevel === 0 && abilities.length === 0));
  });
}

/** Re-derives the threshold-driven unlocks so a level change can never leave abilities and flags stale. */
function withDerivedUnlocks(progress: CompanionProgress): CompanionProgress {
  if (!progress.recruited) return progress;
  const abilities = new Set([...COMPANION_CORE_ABILITY_IDS[progress.id], ...progress.unlockedAbilityIds]);
  const flags = { ...progress.storyFlags };
  if (progress.dominionLevel >= DOMINION_SPECIAL_THRESHOLD) {
    abilities.add(DOMINION_SPECIAL_ABILITY_ID);
    flags[POSSESSION_RISK_FLAG] = true;
  }
  return { ...progress, unlockedAbilityIds: [...abilities], storyFlags: flags };
}

function updateCompanion(state: CampaignState, id: CampaignCompanionId, next: CompanionProgress): CampaignState {
  const current = state.world.companions[id];
  if (JSON.stringify(current) === JSON.stringify(next)) return state;
  return { ...state, world: { ...state.world, companions: { ...state.world.companions, [id]: next } } };
}

/** Idempotent. Starts at Bond 10 / Dominion unchanged and unlocks the core story verbs. */
export function recruitCompanion(state: CampaignState, id: CampaignCompanionId): CampaignState {
  if (!isCompanionId(id)) throw new Error(`Unknown companion: ${String(id)}`);
  const current = state.world.companions[id];
  if (current.recruited) return state;
  return updateCompanion(state, id, withDerivedUnlocks({
    ...current, recruited: true, bondLevel: Math.max(current.bondLevel, RECRUITMENT_BOND),
  }));
}

/** Adds personal Bond to a recruited companion. The caller keys the award to an accepted authored event. */
export function awardCompanionBond(state: CampaignState, id: CampaignCompanionId, amount: number): CampaignState {
  if (!isCompanionId(id)) throw new Error(`Unknown companion: ${String(id)}`);
  if (!Number.isInteger(amount) || amount <= 0) throw new Error('Bond award must be a positive integer.');
  const current = state.world.companions[id];
  if (!current.recruited) throw new Error(`Cannot award Bond to unrecruited companion: ${id}`);
  return updateCompanion(state, id, withDerivedUnlocks({ ...current, bondLevel: clampLevel(current.bondLevel + amount) }));
}

export function setCompanionStoryFlag(state: CampaignState, id: CampaignCompanionId, flag: string, value = true): CampaignState {
  if (!isCompanionId(id)) throw new Error(`Unknown companion: ${String(id)}`);
  if (!flag.trim()) throw new Error('Companion story flag must not be empty.');
  const current = state.world.companions[id];
  if (current.storyFlags[flag] === value) return state;
  return updateCompanion(state, id, { ...current, storyFlags: { ...current.storyFlags, [flag]: value } });
}

/** A leader Dominion event raises that companion's Dominion level by the pact increment (leaders without a companion identity are unaffected). */
export function raiseDominionForLeader(state: CampaignState, leaderId: LeaderId): CampaignState {
  if (!isCompanionId(leaderId)) return state;
  const current = state.world.companions[leaderId];
  const events = state.dominionHistory.filter((event) => event.leaderId === leaderId).length;
  const level = Math.max(clampLevel(current.dominionLevel + DOMINION_PACT_LEVEL), clampLevel(events * DOMINION_PACT_LEVEL));
  return updateCompanion(state, leaderId, withDerivedUnlocks({ ...current, dominionLevel: level }));
}

/**
 * Dominion history is monotonic. Reapplies the minimum level each historical leader event implies, so restoring an older
 * world snapshot never yields a low-risk companion beside a non-empty leader-Dominion ledger.
 */
export function applyDominionFloors(state: CampaignState): CampaignState {
  let next = state;
  for (const id of COMPANION_IDS) {
    const events = next.dominionHistory.filter((event) => event.leaderId === id).length;
    if (events === 0) continue;
    const current = next.world.companions[id];
    const floor = clampLevel(events * DOMINION_PACT_LEVEL);
    if (current.dominionLevel >= floor) continue;
    next = updateCompanion(next, id, withDerivedUnlocks({ ...current, dominionLevel: floor }));
  }
  return next;
}

export type LegacyWorldV1 = Omit<WorldState, 'companions'>;

/**
 * Pure schema 1 → 2 derivation. Recruitment is conservative: the companion's fragment must be held and the leader must not
 * be exiled; Solkar additionally requires the voluntary-alliance representative state (exile and Dominion never recruit).
 * A recruited companion starts at max(Bond 10, faction tier 0/1/2/3 → 0/25/50/75). Dominion is at least one pact increment
 * per historical leader event. Faction covenant tiers are not converted or created.
 */
export function deriveLegacyCompanions(world: LegacyWorldV1, dominionHistory: readonly DominionEvent[]): CompanionRoster {
  const roster = createCompanionRoster();
  for (const id of COMPANION_IDS) {
    const faction = world.factions[COMPANION_FACTION[id]];
    const holdsFragment = world.fragments.includes(LEGACY_FRAGMENT[id]);
    const leaderAbsent = faction.leaderStatus === 'exiled' || faction.leaderStatus === 'absent';
    const voluntary = id !== 'solkar' || (faction.representative.present && faction.representative.willing);
    const recruited = holdsFragment && !(leaderAbsent && id !== 'vara' && id !== 'sable') && voluntary;
    const events = dominionHistory.filter((event) => event.leaderId === id).length;
    const base: CompanionProgress = {
      id,
      recruited,
      bondLevel: recruited ? Math.max(RECRUITMENT_BOND, LEGACY_TIER_BOND[faction.bondTier]) : 0,
      dominionLevel: clampLevel(events * DOMINION_PACT_LEVEL),
      unlockedAbilityIds: [],
      storyFlags: recruited ? { [LEGACY_MIGRATED_FLAG]: true } : {},
    };
    roster[id] = withDerivedUnlocks(base);
  }
  return roster;
}
