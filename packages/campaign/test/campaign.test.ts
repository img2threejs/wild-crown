import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCheckpoint, createNewRun, createShowcaseReplay, collectFragment, evaluateEnding,
  FACTION_IDS, importCheckpoint, recordLeaderDominion, REGIONAL_OBLIGATION_IDS, REGION_IDS,
  setCrownCouncilRepresentation, setPackLeader, type CampaignState,
} from '../src/index.js';

function eligible(runId = 'eligible-run'): CampaignState {
  const state = createNewRun(runId);
  return {
    ...state,
    world: {
      ...state.world,
      factions: Object.fromEntries(FACTION_IDS.map((id) => [id, {
        ...state.world.factions[id], bondTier: 3,
        representative: { ...state.world.factions[id].representative, present: true, willing: true },
      }])) as CampaignState['world']['factions'],
      regions: Object.fromEntries(REGION_IDS.map((id) => [id, 'restored'])) as CampaignState['world']['regions'],
      hollowReady: true,
      regionalObligations: Object.fromEntries(REGIONAL_OBLIGATION_IDS.map((id) => [id, true])) as CampaignState['world']['regionalObligations'],
      renewedCommitments: Object.fromEntries(FACTION_IDS.map((id) => [id, true])) as CampaignState['world']['renewedCommitments'],
    },
  };
}

test('new run encodes canon leaders, leaderless Sky, and Vara envoy', () => {
  const state = createNewRun('canon-run');
  assert.equal(state.schemaVersion, 2);
  assert.deepEqual(Object.keys(state.world.companions), ['vara', 'koro', 'asha', 'sable', 'nyra', 'solkar']);
  assert.ok(Object.values(state.world.companions).every((companion) => !companion.recruited && companion.bondLevel === 0 && companion.dominionLevel === 0));
  assert.equal(Object.keys(state.world.factions).length, 6);
  assert.equal(Object.keys(state.world.regions).length, 5);
  assert.equal(state.world.factions.sky.leaderId, null);
  assert.equal(state.world.factions.sky.leaderStatus, 'leaderless');
  assert.deepEqual(state.world.factions.sky.representative, { id: 'vara', source: 'envoy', present: true, willing: false });
  assert.equal(state.world.factions.canopy.leaderId, 'koro');
  assert.deepEqual(state.world.factions.canopy.representative, { id: 'koro', source: 'leader', present: true, willing: false });
  assert.equal(state.world.factions.fang.leaderId, 'asha');
  assert.equal(state.world.factions.pack.leaderId, 'ruun');
  assert.deepEqual(state.world.factions.pack.representative, { id: 'sable', source: 'envoy', present: true, willing: false });
  assert.equal(state.world.factions.shadow.leaderId, 'nyra');
  assert.equal(state.world.factions.crown.leaderId, 'solkar');
});

test('Pack leadership transition allows Luma Dominion and leaves Sable as the valid envoy', () => {
  const initial = createNewRun('leadership');
  const lumaLeads = setPackLeader(initial, 'luma');
  assert.equal(lumaLeads.world.factions.pack.leaderId, 'luma');
  assert.deepEqual(lumaLeads.world.factions.pack.representative, { id: 'sable', source: 'envoy', present: true, willing: false });
  const lumaDominion = recordLeaderDominion(lumaLeads, 'luma');
  assert.deepEqual(lumaDominion.dominionHistory, [{ sequence: 1, leaderId: 'luma' }]);
  const savedLuma = importCheckpoint(createNewRun('leadership'), createCheckpoint(lumaLeads));
  assert.equal(savedLuma.accepted, true);
  const ruunLeads = setPackLeader(lumaLeads, 'ruun');
  assert.equal(ruunLeads.world.factions.pack.leaderId, 'ruun');
  assert.equal(recordLeaderDominion(initial, 'koro').dominionHistory[0]?.leaderId, 'koro');
  assert.throws(() => recordLeaderDominion(initial, 'ghor' as never));
  assert.throws(() => recordLeaderDominion(initial, 'orun' as never));
});

test('fragment collection is idempotent by stable ID', () => {
  const once = collectFragment(createNewRun('fragments'), 'heartroot-sky');
  const twice = collectFragment(once, 'heartroot-sky');
  assert.deepEqual(once.world.fragments, ['heartroot-sky']);
  assert.deepEqual(twice.world.fragments, ['heartroot-sky']);
  assert.equal(twice, once);
});

test('fully eligible run offers all endings and one missing Hollow fact identifies only that condition', () => {
  const state = eligible();
  assert.deepEqual(evaluateEnding(state), { available: true, unmet: [], choices: ['dominion', 'severance', 'living_pact'] });
  const missing = { ...state, world: { ...state.world, hollowReady: false } };
  const result = evaluateEnding(missing);
  assert.equal(result.available, false);
  assert.deepEqual(result.unmet.map(({ id }) => id), ['hollow_resolution']);
  assert.deepEqual(result.choices, ['dominion', 'severance']);
});

test('each of eight region-specific obligations independently blocks Living Pact', () => {
  const state = eligible('obligations');
  for (const obligation of REGIONAL_OBLIGATION_IDS) {
    const missing = { ...state, world: { ...state.world, regionalObligations: { ...state.world.regionalObligations, [obligation]: false } } };
    const result = evaluateEnding(missing);
    assert.equal(result.available, false, obligation);
    assert.deepEqual(result.unmet.map(({ id }) => id), [obligation]);
  }
});

test('Dominion history survives loading an older same-run checkpoint and remains sequence ordered', () => {
  const before = eligible('history-run');
  const checkpoint = createCheckpoint(before);
  const later = recordLeaderDominion(recordLeaderDominion(before, 'solkar'), 'koro');
  const loaded = importCheckpoint(later, checkpoint);
  assert.equal(loaded.accepted, true);
  if (!loaded.accepted) return;
  assert.deepEqual(loaded.state.dominionHistory, [{ sequence: 1, leaderId: 'solkar' }, { sequence: 2, leaderId: 'koro' }]);
  assert.equal(evaluateEnding(loaded.state).unmet[0]?.id, 'no_dominion');
  assert.deepEqual(evaluateEnding(loaded.state).choices, ['dominion', 'severance']);
});

test('new run starts isolated history and rejects a checkpoint from the prior run', () => {
  const previous = recordLeaderDominion(createNewRun('old'), 'koro');
  const oldCheckpoint = createCheckpoint(previous);
  const next = createNewRun('new');
  assert.deepEqual(next.dominionHistory, []);
  assert.deepEqual(importCheckpoint(next, oldCheckpoint), { accepted: false, reason: 'run_mismatch' });
  assert.deepEqual(next.dominionHistory, []);
});

test('legitimate absent Solkar checkpoints load but only a council can satisfy Crown', () => {
  const complete = eligible('exile-run');
  const absentWorld = {
    ...complete.world,
    marekPresent: false,
    factions: { ...complete.world.factions, crown: {
      ...complete.world.factions.crown,
      leaderStatus: 'exiled' as const,
      representative: { id: 'solkar', source: 'leader' as const, present: false, willing: false },
    } },
  };
  const absent = { ...complete, world: absentWorld };
  const loaded = importCheckpoint(createNewRun('exile-run'), createCheckpoint(absent));
  assert.equal(loaded.accepted, true);
  if (!loaded.accepted) return;
  assert.equal(loaded.state.world.factions.crown.representative.present, false);
  assert.deepEqual(evaluateEnding(loaded.state).unmet.map(({ id }) => id), ['crown_representative']);
  const represented = setCrownCouncilRepresentation(loaded.state, true);
  assert.equal(represented.world.factions.crown.leaderStatus, 'exiled');
  assert.equal(evaluateEnding(represented).available, true);
});

test('checkpoint imports reject malformed, future, prior-schema, mismatched, and cross-faction representatives', () => {
  const current = eligible('safe-run');
  const checkpoint = createCheckpoint(current);
  const malformed = { ...checkpoint, world: { ...checkpoint.world, regionalObligations: { canopy_water_seed_accord: true } } };
  const crossFactionRepresentative = { ...checkpoint, world: { ...checkpoint.world, factions: { ...checkpoint.world.factions, canopy: { ...checkpoint.world.factions.canopy, representative: { id: 'ghor', source: 'envoy', present: true, willing: true } } } } };
  assert.deepEqual(importCheckpoint(current, { ...checkpoint, schemaVersion: 3 }), { accepted: false, reason: 'future_schema' });
  assert.deepEqual(importCheckpoint(current, { ...checkpoint, schemaVersion: 0 }), { accepted: false, reason: 'schema_mismatch' });
  // A schema-1 label on a schema-2 world is not silently accepted: schema 1 is strictly the pre-companion shape.
  assert.deepEqual(importCheckpoint(current, { ...checkpoint, schemaVersion: 1 }), { accepted: false, reason: 'invalid_snapshot' });
  assert.deepEqual(importCheckpoint(current, { ...checkpoint, runId: 'another-run' }), { accepted: false, reason: 'run_mismatch' });
  assert.deepEqual(importCheckpoint(current, malformed), { accepted: false, reason: 'invalid_snapshot' });
  assert.deepEqual(importCheckpoint(current, crossFactionRepresentative), { accepted: false, reason: 'invalid_snapshot' });
  assert.equal(current.world.hollowReady, true);
});

test('the shared checkpoint import boundary rejects replay envelopes and does not merge replay rewards', () => {
  const current = recordLeaderDominion(eligible('replay-boundary'), 'koro');
  const replay = createShowcaseReplay();
  const replayPayload = { ...replay, world: eligible('attacker').world, dominionHistory: [{ sequence: 1, leaderId: 'solkar' }] };
  const disguisedCheckpoint = { ...createCheckpoint(current), ...replayPayload };
  assert.deepEqual(importCheckpoint(current, replayPayload), { accepted: false, reason: 'replay_isolated' });
  assert.deepEqual(importCheckpoint(current, disguisedCheckpoint), { accepted: false, reason: 'replay_isolated' });
  assert.deepEqual(current.dominionHistory, [{ sequence: 1, leaderId: 'koro' }]);
  assert.deepEqual(current.world.fragments, []);
});

test('all catalogued conditions are independently represented without duplicate requirement IDs', () => {
  const state = recordLeaderDominion(createNewRun('all-unmet'), 'koro');
  const unmet = evaluateEnding(state).unmet;
  assert.equal(unmet.length, 33);
  assert.equal(new Set(unmet.map(({ id }) => id)).size, unmet.length);
});
