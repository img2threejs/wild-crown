import playerCopy from '../content/PLAYER-COPY.en.json' with { type: 'json' };
import { hasExactKeys, isRecord } from './guards.js';
import {
  applyDominionFloors, createCompanionRoster, deriveLegacyCompanions, raiseDominionForLeader, validCompanionRoster,
  type CompanionRoster, type LegacyWorldV1,
} from './progression.js';

export {
  awardCompanionBond, applyDominionFloors, COMPANION_CORE_ABILITY_IDS, COMPANION_IDS, COMPANION_LEVEL_MAX, COMPANION_LEVEL_MIN,
  createCompanionProgress, createCompanionRoster, deriveLegacyCompanions, DOMINION_PACT_LEVEL, DOMINION_SPECIAL_ABILITY_ID,
  DOMINION_SPECIAL_THRESHOLD, isCompanionId, LEGACY_MIGRATED_FLAG, LEGACY_TIER_BOND, POSSESSION_RISK_FLAG, raiseDominionForLeader,
  recruitCompanion, RECRUITMENT_BOND, RESPECTFUL_PACT_BOND, setCompanionStoryFlag, validCompanionRoster,
} from './progression.js';
export type { CampaignCompanionId, CompanionProgress, CompanionRoster, LegacyWorldV1 } from './progression.js';

/** Current package schema: per-companion progression lives in `WorldState.companions`. */
export const SCHEMA_VERSION = 2 as const;
/** Last schema without per-companion progression; accepted on import through explicit pure migration. */
export const LEGACY_SCHEMA_VERSION = 1 as const;
export const FACTION_IDS = ['sky', 'canopy', 'fang', 'pack', 'shadow', 'crown'] as const;
export type FactionId = (typeof FACTION_IDS)[number];
export const FRAGMENT_IDS = [
  'heartroot-sky', 'heartroot-canopy', 'heartroot-fang',
  'heartroot-pack', 'heartroot-shadow', 'heartroot-crown',
] as const;
export type FragmentId = (typeof FRAGMENT_IDS)[number];
export const REGION_IDS = ['whispering-canopy', 'blood-bamboo-valley', 'moonpine-ridge', 'mistveil-basin', 'sunmane-expanse'] as const;
export type RegionId = (typeof REGION_IDS)[number];
export type RestorationState = 'unvisited' | 'corrupted' | 'partial' | 'restored';
export type LeaderId = 'koro' | 'asha' | 'ruun' | 'luma' | 'nyra' | 'solkar';
export type PackLeaderId = 'ruun' | 'luma';
export const REGIONAL_OBLIGATION_IDS = [
  'canopy_water_seed_accord', 'bamboo_tali_safe', 'bamboo_snare_source', 'moonpine_settlement',
  'mistveil_river_source', 'mistveil_nyra_truth', 'sunmane_tribute_ended', 'sunmane_voluntary_governance',
] as const;
export type RegionalObligationId = (typeof REGIONAL_OBLIGATION_IDS)[number];

export interface RepresentativeState {
  id: string;
  present: boolean;
  willing: boolean;
  source: 'leader' | 'envoy' | 'council';
}
export interface FactionState {
  leaderId: LeaderId | null;
  leaderStatus: 'active' | 'exiled' | 'absent' | 'leaderless';
  bondTier: 0 | 1 | 2 | 3;
  representative: RepresentativeState;
}
export interface WorldState {
  fragments: FragmentId[];
  factions: Record<FactionId, FactionState>;
  regions: Record<RegionId, RestorationState>;
  hollowReady: boolean;
  regionalObligations: Record<RegionalObligationId, boolean>;
  renewedCommitments: Record<FactionId, boolean>;
  marekPresent: boolean;
  /** Personal relationship progression; faction `bondTier` stays separate political covenant state. */
  companions: CompanionRoster;
}
export interface DominionEvent {
  sequence: number;
  leaderId: LeaderId;
}
export interface CampaignState {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: string;
  world: WorldState;
  /** Run-lifetime history. Checkpoints deliberately do not contain this ledger. */
  dominionHistory: DominionEvent[];
}
export interface CheckpointSnapshot {
  kind: 'campaign-checkpoint';
  schemaVersion: number;
  runId: string;
  world: WorldState;
}
export interface ReplayState {
  kind: 'showcase-replay';
  world: WorldState;
}
export type ImportResult =
  | { accepted: true; state: CampaignState }
  | { accepted: false; reason: 'invalid_snapshot' | 'future_schema' | 'schema_mismatch' | 'run_mismatch' | 'replay_isolated' };

const factionCopy = playerCopy.relationships.factions;
const requirementCopy = playerCopy.living_pact.requirements;

const leaders: Record<FactionId, LeaderId | null> = {
  sky: null, canopy: 'koro', fang: 'asha', pack: 'ruun', shadow: 'nyra', crown: 'solkar',
};
const leaderOptions: Record<FactionId, readonly (LeaderId | null)[]> = {
  sky: [null], canopy: ['koro'], fang: ['asha'], pack: ['ruun', 'luma'], shadow: ['nyra'], crown: ['solkar'],
};
const validLeaderIds = ['koro', 'asha', 'ruun', 'luma', 'nyra', 'solkar'] as const;
const representativeFor: Record<FactionId, RepresentativeState> = {
  sky: { id: 'vara', source: 'envoy', present: true, willing: false },
  canopy: { id: 'koro', source: 'leader', present: true, willing: false },
  fang: { id: 'asha', source: 'leader', present: true, willing: false },
  pack: { id: 'sable', source: 'envoy', present: true, willing: false },
  shadow: { id: 'nyra', source: 'leader', present: true, willing: false },
  crown: { id: 'solkar', source: 'leader', present: true, willing: false },
};

function freshWorld(): WorldState {
  return {
    fragments: [],
    factions: Object.fromEntries(FACTION_IDS.map((id) => {
      const leaderId = leaders[id];
      return [id, {
        leaderId,
        leaderStatus: leaderId === null ? 'leaderless' as const : 'active' as const,
        bondTier: 0 as const,
        representative: { ...representativeFor[id] },
      }];
    })) as Record<FactionId, FactionState>,
    regions: Object.fromEntries(REGION_IDS.map((id) => [id, 'unvisited'])) as Record<RegionId, RestorationState>,
    hollowReady: false,
    regionalObligations: Object.fromEntries(REGIONAL_OBLIGATION_IDS.map((id) => [id, false])) as Record<RegionalObligationId, boolean>,
    renewedCommitments: Object.fromEntries(FACTION_IDS.map((id) => [id, false])) as Record<FactionId, boolean>,
    marekPresent: true,
    companions: createCompanionRoster(),
  };
}

export function createNewRun(runId: string): CampaignState {
  if (!runId.trim()) throw new Error('runId must not be empty');
  return { schemaVersion: SCHEMA_VERSION, runId, world: freshWorld(), dominionHistory: [] };
}

export function collectFragment(state: CampaignState, fragmentId: FragmentId): CampaignState {
  if (!FRAGMENT_IDS.includes(fragmentId)) throw new Error(`Unknown fragment: ${fragmentId}`);
  if (state.world.fragments.includes(fragmentId)) return state;
  return { ...state, world: { ...state.world, fragments: [...state.world.fragments, fragmentId] } };
}

export function recordLeaderDominion(state: CampaignState, leaderId: LeaderId): CampaignState {
  if (!(validLeaderIds as readonly string[]).includes(leaderId)) throw new Error('Unknown leader Dominion target');
  const sequence = (state.dominionHistory.at(-1)?.sequence ?? 0) + 1;
  return raiseDominionForLeader({ ...state, dominionHistory: [...state.dominionHistory, { sequence, leaderId }] }, leaderId);
}

export function setPackLeader(state: CampaignState, leaderId: PackLeaderId): CampaignState {
  const pack = state.world.factions.pack;
  const representative = pack.representative.source === 'leader'
    ? { ...pack.representative, id: leaderId, willing: false }
    : pack.representative;
  return {
    ...state,
    world: { ...state.world, factions: { ...state.world.factions, pack: { ...pack, leaderId, leaderStatus: 'active', representative } } },
  };
}

export function createCheckpoint(state: CampaignState): CheckpointSnapshot {
  return { kind: 'campaign-checkpoint', schemaVersion: SCHEMA_VERSION, runId: state.runId, world: structuredClone(state.world) };
}

function validFaction(id: FactionId, value: unknown): value is FactionState {
  if (!isRecord(value) || !isRecord(value.representative)) return false;
  const leaderId = value.leaderId;
  const leaderStatus = value.leaderStatus;
  const representative = value.representative;
  const statusMatchesCanon = id === 'sky' ? leaderStatus === 'leaderless' : ['active', 'exiled', 'absent'].includes(leaderStatus as string);
  if (!leaderOptions[id].includes(leaderId as LeaderId | null) || !statusMatchesCanon || ![0, 1, 2, 3].includes(value.bondTier as number)) return false;
  if (typeof representative.id !== 'string' || typeof representative.present !== 'boolean' || typeof representative.willing !== 'boolean') return false;
  const isActiveLeader = representative.source === 'leader' && leaderId !== null && representative.id === leaderId && leaderStatus === 'active';
  const isAbsentLeader = representative.source === 'leader' && leaderId !== null && representative.id === leaderId && leaderStatus !== 'active' && representative.present === false && representative.willing === false;
  const isFactionEnvoy = representative.source === 'envoy' && ((id === 'sky' && representative.id === 'vara') || (id === 'pack' && representative.id === 'sable'));
  const isCrownCouncil = id === 'crown' && representative.source === 'council' && representative.id === 'crown-council';
  return isActiveLeader || isAbsentLeader || isFactionEnvoy || isCrownCouncil;
}

function validWorldCore(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const fragments = value.fragments;
  const rawFactions = value.factions;
  const rawRegions = value.regions;
  const rawObligations = value.regionalObligations;
  const rawCommitments = value.renewedCommitments;
  if (!Array.isArray(fragments) || !fragments.every((id) => FRAGMENT_IDS.includes(id as FragmentId)) || new Set(fragments).size !== fragments.length) return false;
  if (!isRecord(rawFactions) || !hasExactKeys(rawFactions, FACTION_IDS) || !isRecord(rawRegions) || !hasExactKeys(rawRegions, REGION_IDS)) return false;
  if (!isRecord(rawObligations) || !hasExactKeys(rawObligations, REGIONAL_OBLIGATION_IDS) || !isRecord(rawCommitments) || !hasExactKeys(rawCommitments, FACTION_IDS)) return false;
  const factions = rawFactions as Record<FactionId, unknown>;
  const regions = rawRegions as Record<RegionId, unknown>;
  const obligations = rawObligations as Record<RegionalObligationId, unknown>;
  const commitments = rawCommitments as Record<FactionId, unknown>;
  if (!REGIONAL_OBLIGATION_IDS.every((id) => typeof obligations[id] === 'boolean') || !FACTION_IDS.every((id) => typeof commitments[id] === 'boolean')) return false;
  if (!REGION_IDS.every((id) => ['unvisited', 'corrupted', 'partial', 'restored'].includes(regions[id] as string))) return false;
  if (typeof value.hollowReady !== 'boolean' || typeof value.marekPresent !== 'boolean') return false;
  return FACTION_IDS.every((id) => validFaction(id, factions[id]));
}

/** Strict schema-2 world: the schema-1 shape plus a validated per-companion roster. */
function validWorld(value: unknown): value is WorldState {
  return validWorldCore(value) && Object.keys(value).length === 8 && validCompanionRoster(value.companions);
}

/** Strict schema-1 world: exactly the pre-companion shape; any extra key is rejected rather than guessed. */
function validLegacyWorld(value: unknown): value is LegacyWorldV1 {
  return validWorldCore(value) && Object.keys(value).length === 7 && !('companions' in value);
}

/** Validates a schema-2 world's roster-independent invariants for repository callers. */
export function isValidWorld(value: unknown): value is WorldState {
  return validWorld(value);
}

/** Pure schema-1 → 2 world migration; the run's Dominion ledger seeds the monotonic Dominion floors. */
export function migrateWorldV1(world: unknown, dominionHistory: readonly DominionEvent[]): WorldState | null {
  if (!validLegacyWorld(world)) return null;
  const legacy = structuredClone(world);
  return { ...legacy, companions: deriveLegacyCompanions(legacy, dominionHistory) };
}

/** Pure schema-1 → 2 campaign-state migration. Returns null when the input is not a strictly valid schema-1 state. */
export function migrateCampaignStateV1(input: unknown): CampaignState | null {
  if (!isRecord(input) || input.schemaVersion !== LEGACY_SCHEMA_VERSION || typeof input.runId !== 'string' || !Array.isArray(input.dominionHistory)) return null;
  const history = input.dominionHistory as DominionEvent[];
  const world = migrateWorldV1(input.world, history);
  if (!world) return null;
  return { schemaVersion: SCHEMA_VERSION, runId: input.runId, world, dominionHistory: structuredClone(history) };
}

/** Imports a campaign checkpoint, never replay data. Run-lifetime history remains the current run's ledger. */
export function importCheckpoint(current: CampaignState, input: unknown): ImportResult {
  if (!isRecord(input)) return { accepted: false, reason: 'invalid_snapshot' };
  if (input.kind === 'showcase-replay') return { accepted: false, reason: 'replay_isolated' };
  if (input.kind !== 'campaign-checkpoint' || typeof input.runId !== 'string' || typeof input.schemaVersion !== 'number' || !Number.isInteger(input.schemaVersion)) return { accepted: false, reason: 'invalid_snapshot' };
  if (input.schemaVersion > SCHEMA_VERSION) return { accepted: false, reason: 'future_schema' };
  if (input.schemaVersion !== SCHEMA_VERSION && input.schemaVersion !== LEGACY_SCHEMA_VERSION) return { accepted: false, reason: 'schema_mismatch' };
  if (input.runId !== current.runId) return { accepted: false, reason: 'run_mismatch' };
  const world = input.schemaVersion === LEGACY_SCHEMA_VERSION
    ? migrateWorldV1(input.world, current.dominionHistory)
    : validWorld(input.world) ? structuredClone(input.world) : null;
  if (!world) return { accepted: false, reason: 'invalid_snapshot' };
  return { accepted: true, state: applyDominionFloors({ ...current, world }) };
}

export function createShowcaseReplay(): ReplayState {
  return { kind: 'showcase-replay', world: freshWorld() };
}

export type EndingRequirementId = 'no_dominion'
  | `${FactionId}_covenant` | `${FactionId}_representative`
  | `${RegionId}_restored` | 'hollow_resolution'
  | RegionalObligationId | `${FactionId}_recommitment`;
export interface UnmetRequirement {
  id: EndingRequirementId;
  label: string;
  message: string;
}
export interface EndingEvaluation {
  available: boolean;
  unmet: UnmetRequirement[];
  choices: readonly ['dominion', 'severance'] | readonly ['dominion', 'severance', 'living_pact'];
}

export function evaluateEnding(state: CampaignState): EndingEvaluation {
  const unmet: UnmetRequirement[] = [];
  const add = (id: EndingRequirementId, requirementKey: keyof typeof requirementCopy, met: boolean): void => {
    if (!met) {
      const copy = requirementCopy[requirementKey];
      unmet.push({ id, label: copy.label, message: copy.unmet });
    }
  };
  add('no_dominion', 'no_dominion', state.dominionHistory.length === 0);
  for (const faction of FACTION_IDS) {
    const relationship = state.world.factions[faction];
    add(`${faction}_covenant`, `${faction}_covenant`, relationship.bondTier === 3);
    const representative = relationship.representative;
    const validRepresentative = validFaction(faction, relationship) && representative.present && representative.willing;
    add(`${faction}_representative`, `${faction}_representative`, validRepresentative);
  }
  const restoredKeys: Record<RegionId, keyof typeof requirementCopy> = {
    'whispering-canopy': 'canopy_restored', 'blood-bamboo-valley': 'bamboo_restored',
    'moonpine-ridge': 'moonpine_restored', 'mistveil-basin': 'mistveil_restored', 'sunmane-expanse': 'sunmane_restored',
  };
  for (const region of REGION_IDS) add(`${region}_restored`, restoredKeys[region], state.world.regions[region] === 'restored');
  add('hollow_resolution', 'hollow_resolution', state.world.hollowReady);
  for (const obligation of REGIONAL_OBLIGATION_IDS) add(obligation, obligation, state.world.regionalObligations[obligation]);
  for (const faction of FACTION_IDS) add(`${faction}_recommitment`, `${faction}_recommitment`, state.world.renewedCommitments[faction]);
  const available = unmet.length === 0;
  return { available, unmet, choices: available ? ['dominion', 'severance', 'living_pact'] : ['dominion', 'severance'] };
}

/** A Crown council may represent Crown after Solkar's exile; this does not restore Solkar or require Marek. */
export function setCrownCouncilRepresentation(state: CampaignState, willing: boolean): CampaignState {
  const crown = state.world.factions.crown;
  return {
    ...state,
    world: { ...state.world, factions: { ...state.world.factions, crown: {
      ...crown,
      representative: { id: 'crown-council', source: 'council', present: true, willing },
    } } },
  };
}

export function getFactionName(id: FactionId): string { return factionCopy[id]; }
