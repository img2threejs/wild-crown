import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDominionFloors, awardCompanionBond, COMPANION_CORE_ABILITY_IDS, COMPANION_IDS, createCheckpoint, createNewRun,
  DOMINION_PACT_LEVEL, DOMINION_SPECIAL_ABILITY_ID, importCheckpoint, isValidWorld, LEGACY_MIGRATED_FLAG, LEGACY_SCHEMA_VERSION,
  LEGACY_TIER_BOND, migrateCampaignStateV1, migrateWorldV1, POSSESSION_RISK_FLAG, recordLeaderDominion, recruitCompanion,
  RECRUITMENT_BOND, RESPECTFUL_PACT_BOND, SCHEMA_VERSION, setCompanionStoryFlag, validCompanionRoster,
  type CampaignCompanionId, type CampaignState, type FactionId, type FragmentId, type LegacyWorldV1,
} from '../src/index.js';

const FACTION_OF: Record<CampaignCompanionId, FactionId> = { vara: 'sky', koro: 'canopy', asha: 'fang', sable: 'pack', nyra: 'shadow', solkar: 'crown' };
const FRAGMENT_OF: Record<CampaignCompanionId, FragmentId> = {
  vara: 'heartroot-sky', koro: 'heartroot-canopy', asha: 'heartroot-fang', sable: 'heartroot-pack', nyra: 'heartroot-shadow', solkar: 'heartroot-crown',
};

function legacyWorld(mutate: (world: LegacyWorldV1) => void = () => undefined): LegacyWorldV1 {
  const { companions: _drop, ...world } = structuredClone(createNewRun('legacy').world);
  void _drop;
  mutate(world);
  return world;
}
const legacyState = (mutate: (world: LegacyWorldV1) => void = () => undefined, history: CampaignState['dominionHistory'] = []): unknown =>
  ({ schemaVersion: LEGACY_SCHEMA_VERSION, runId: 'legacy', world: legacyWorld(mutate), dominionHistory: history });

test('schema constants: package schema 2, legacy schema 1', () => {
  assert.equal(SCHEMA_VERSION, 2);
  assert.equal(LEGACY_SCHEMA_VERSION, 1);
  assert.equal(createCheckpoint(createNewRun('x')).schemaVersion, 2);
});

for (const id of COMPANION_IDS) {
  for (const tier of [0, 1, 2, 3] as const) {
    test(`v1→v2 matrix: ${id} with fragment and faction tier ${tier} starts at documented personal Bond`, () => {
      const world = migrateWorldV1(legacyWorld((value) => {
        value.fragments = [FRAGMENT_OF[id]];
        value.factions[FACTION_OF[id]].bondTier = tier;
        if (id === 'solkar') value.factions.crown.representative = { ...value.factions.crown.representative, willing: true };
      }), [])!;
      assert.ok(world, 'a strictly valid schema-1 world migrates');
      assert.equal(isValidWorld(world), true);
      const companion = world.companions[id];
      assert.equal(companion.recruited, true);
      assert.equal(companion.bondLevel, Math.max(RECRUITMENT_BOND, LEGACY_TIER_BOND[tier]));
      assert.deepEqual([...COMPANION_CORE_ABILITY_IDS[id]].filter((ability) => !companion.unlockedAbilityIds.includes(ability)), []);
      assert.equal(companion.storyFlags[LEGACY_MIGRATED_FLAG], true);
      // Faction covenant tiers are political state: they are neither converted nor created.
      assert.equal(world.factions[FACTION_OF[id]].bondTier, tier);
      for (const other of COMPANION_IDS.filter((candidate) => candidate !== id)) assert.equal(world.companions[other].recruited, false);
    });
  }
  test(`v1→v2 matrix: ${id} without its fragment is never recruited even at covenant tier 3`, () => {
    const world = migrateWorldV1(legacyWorld((value) => { value.factions[FACTION_OF[id]].bondTier = 3; }), [])!;
    assert.deepEqual(world.companions[id], { id, recruited: false, bondLevel: 0, dominionLevel: 0, unlockedAbilityIds: [], storyFlags: {} });
  });
}

test('v1→v2: exiled or merely dominated Solkar is not recruited; only the voluntary alliance recruits him', () => {
  const exiled = migrateWorldV1(legacyWorld((world) => {
    world.fragments = ['heartroot-crown'];
    world.factions.crown = { ...world.factions.crown, leaderStatus: 'exiled', representative: { id: 'solkar', source: 'leader', present: false, willing: false } };
  }), [])!;
  assert.equal(exiled.companions.solkar.recruited, false);
  const dominated = migrateWorldV1(legacyWorld((world) => { world.fragments = ['heartroot-crown']; }), [{ sequence: 1, leaderId: 'solkar' }])!;
  assert.equal(dominated.companions.solkar.recruited, false);
  assert.equal(dominated.companions.solkar.dominionLevel, DOMINION_PACT_LEVEL);
  const voluntary = migrateWorldV1(legacyWorld((world) => {
    world.fragments = ['heartroot-crown'];
    world.factions.crown.representative = { ...world.factions.crown.representative, willing: true };
  }), [])!;
  assert.equal(voluntary.companions.solkar.recruited, true);
});

test('v1→v2: derived Dominion is at least one pact increment per historical leader event, with the possession-risk flag when recruited', () => {
  const history = [{ sequence: 1, leaderId: 'koro' as const }, { sequence: 2, leaderId: 'koro' as const }, { sequence: 3, leaderId: 'ruun' as const }];
  const world = migrateWorldV1(legacyWorld((value) => { value.fragments = ['heartroot-canopy']; }), history)!;
  assert.equal(world.companions.koro.dominionLevel, 2 * DOMINION_PACT_LEVEL);
  assert.equal(world.companions.koro.storyFlags[POSSESSION_RISK_FLAG], true);
  assert.ok(world.companions.koro.unlockedAbilityIds.includes(DOMINION_SPECIAL_ABILITY_ID));
  // Ruun has no companion identity: the leader event cannot invent one.
  assert.deepEqual(COMPANION_IDS.filter((id) => world.companions[id].dominionLevel > 0), ['koro']);
});

test('migration is strict: unknown extras, v2-shaped worlds and malformed worlds are rejected, never guessed', () => {
  assert.equal(migrateWorldV1({ ...legacyWorld(), extra: true }, []), null);
  assert.equal(migrateWorldV1(createNewRun('v2').world, []), null);
  assert.equal(migrateWorldV1({}, []), null);
  assert.equal(migrateWorldV1(null, []), null);
  assert.equal(migrateWorldV1({ ...legacyWorld(), fragments: ['not-a-fragment'] }, []), null);
});

test('migrateCampaignStateV1 upgrades only strict schema-1 states and keeps the Dominion ledger', () => {
  const history = [{ sequence: 1, leaderId: 'asha' as const }];
  const upgraded = migrateCampaignStateV1(legacyState(undefined, history))!;
  assert.equal(upgraded.schemaVersion, 2);
  assert.deepEqual(upgraded.dominionHistory, history);
  assert.equal(upgraded.world.companions.asha.dominionLevel, DOMINION_PACT_LEVEL);
  assert.equal(migrateCampaignStateV1({ ...(legacyState() as object), schemaVersion: 2 }), null);
  assert.equal(migrateCampaignStateV1({ ...(legacyState() as object), world: {} }), null);
  assert.equal(migrateCampaignStateV1(undefined), null);
});

test('importCheckpoint migrates a schema-1 checkpoint using the current run ledger for Dominion floors', () => {
  const current: CampaignState = { ...createNewRun('legacy'), dominionHistory: [{ sequence: 1, leaderId: 'koro' }] };
  const legacy = { kind: 'campaign-checkpoint', schemaVersion: 1, runId: 'legacy', world: legacyWorld((world) => { world.fragments = ['heartroot-canopy']; }) };
  const result = importCheckpoint(current, legacy);
  assert.equal(result.accepted, true);
  if (!result.accepted) return;
  assert.equal(result.state.world.companions.koro.recruited, true);
  assert.equal(result.state.world.companions.koro.dominionLevel, DOMINION_PACT_LEVEL);
  assert.deepEqual(result.state.dominionHistory, current.dominionHistory);
  assert.equal(importCheckpoint(current, { ...legacy, schemaVersion: 3 }).accepted, false);
  assert.deepEqual(importCheckpoint(current, { ...legacy, schemaVersion: 3 }), { accepted: false, reason: 'future_schema' });
  assert.deepEqual(importCheckpoint(current, { ...legacy, world: { ...legacy.world, companions: createNewRun('x').world.companions } }), { accepted: false, reason: 'invalid_snapshot' });
});

test('an older schema-2 world cannot erase Dominion history: floors are reapplied on import', () => {
  const older = createNewRun('run');
  const checkpoint = createCheckpoint(recruitCompanion(older, 'asha'));
  const current = recordLeaderDominion(recordLeaderDominion(recruitCompanion(older, 'asha'), 'asha'), 'asha');
  assert.equal(current.world.companions.asha.dominionLevel, 2 * DOMINION_PACT_LEVEL);
  const imported = importCheckpoint(current, checkpoint);
  assert.equal(imported.accepted, true);
  if (!imported.accepted) return;
  assert.equal(imported.state.world.companions.asha.dominionLevel, 2 * DOMINION_PACT_LEVEL);
  assert.equal(imported.state.world.companions.asha.storyFlags[POSSESSION_RISK_FLAG], true);
  // Ordinary Bond rolls back with the world; Dominion does not.
  assert.equal(imported.state.world.companions.asha.bondLevel, RECRUITMENT_BOND);
  assert.equal(applyDominionFloors(current), current);
});

test('roster validation rejects NaN, fractional, out-of-range, duplicate, unknown, mismatched and inconsistent entries', () => {
  const base = recruitCompanion(createNewRun('validate'), 'koro').world.companions;
  assert.equal(validCompanionRoster(base), true);
  const mutate = (change: (roster: Record<string, Record<string, unknown>>) => void): unknown => {
    const roster = structuredClone(base) as unknown as Record<string, Record<string, unknown>>;
    change(roster);
    return roster;
  };
  const rejected: [string, unknown][] = [
    ['NaN bond', mutate((roster) => { roster.koro!.bondLevel = Number.NaN; })],
    ['fractional bond', mutate((roster) => { roster.koro!.bondLevel = 10.5; })],
    ['bond above 100', mutate((roster) => { roster.koro!.bondLevel = 101; })],
    ['negative dominion', mutate((roster) => { roster.koro!.dominionLevel = -1; })],
    ['infinite dominion', mutate((roster) => { roster.koro!.dominionLevel = Number.POSITIVE_INFINITY; })],
    ['duplicate ability', mutate((roster) => { roster.koro!.unlockedAbilityIds = ['distract', 'distract']; })],
    ['non-string ability', mutate((roster) => { roster.koro!.unlockedAbilityIds = [3]; })],
    ['non-boolean flag', mutate((roster) => { roster.koro!.storyFlags = { x: 1 }; })],
    ['id mismatch', mutate((roster) => { roster.koro!.id = 'asha'; })],
    ['unknown companion', mutate((roster) => { roster.ghor = { ...roster.koro! }; })],
    ['missing companion', mutate((roster) => { delete roster.solkar; })],
    ['extra field', mutate((roster) => { roster.koro!.mood = 'calm'; })],
    ['bond without recruitment', mutate((roster) => { roster.sable!.bondLevel = 5; })],
    ['abilities without recruitment', mutate((roster) => { roster.sable!.unlockedAbilityIds = ['x']; })],
    ['array roster', []],
    ['null roster', null],
  ];
  for (const [name, value] of rejected) assert.equal(validCompanionRoster(value), false, name);
  assert.equal(isValidWorld({ ...createNewRun('v').world, companions: rejected[0]![1] }), false);
});

test('recruitment and Bond awards are pure, idempotent and bounded', () => {
  const initial = createNewRun('progression');
  const recruited = recruitCompanion(initial, 'asha');
  assert.equal(initial.world.companions.asha.recruited, false, 'input is not mutated');
  assert.equal(recruited.world.companions.asha.bondLevel, RECRUITMENT_BOND);
  assert.deepEqual(recruited.world.companions.asha.unlockedAbilityIds, [...COMPANION_CORE_ABILITY_IDS.asha]);
  assert.equal(recruitCompanion(recruited, 'asha'), recruited, 'repeat recruitment is a no-op');
  const bonded = awardCompanionBond(recruited, 'asha', RESPECTFUL_PACT_BOND);
  assert.equal(bonded.world.companions.asha.bondLevel, RECRUITMENT_BOND + RESPECTFUL_PACT_BOND);
  assert.equal(awardCompanionBond(bonded, 'asha', 500).world.companions.asha.bondLevel, 100);
  assert.throws(() => awardCompanionBond(initial, 'koro', 5), /unrecruited/);
  for (const amount of [0, -3, 1.5, Number.NaN]) assert.throws(() => awardCompanionBond(recruited, 'asha', amount));
  assert.throws(() => recruitCompanion(initial, 'ghor' as CampaignCompanionId));
  assert.equal(setCompanionStoryFlag(recruited, 'asha', 'seen-cub').world.companions.asha.storyFlags['seen-cub'], true);
  assert.equal(validCompanionRoster(awardCompanionBond(bonded, 'asha', 1).world.companions), true);
});

test('a leader Dominion event raises that companion by one pact increment and records monotonic history', () => {
  const state = recruitCompanion(createNewRun('dominion'), 'koro');
  const once = recordLeaderDominion(state, 'koro');
  assert.equal(once.world.companions.koro.dominionLevel, DOMINION_PACT_LEVEL);
  assert.equal(once.world.companions.koro.storyFlags[POSSESSION_RISK_FLAG], true);
  assert.deepEqual(once.dominionHistory, [{ sequence: 1, leaderId: 'koro' }]);
  const unaffected = recordLeaderDominion(state, 'ruun');
  assert.deepEqual(unaffected.world.companions, state.world.companions);
  let level = once;
  for (let index = 0; index < 6; index += 1) level = recordLeaderDominion(level, 'koro');
  assert.equal(level.world.companions.koro.dominionLevel, 100);
  assert.equal(validCompanionRoster(level.world.companions), true);
});
