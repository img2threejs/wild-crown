import {
  createCheckpoint, createNewRun, createShowcaseReplay, collectFragment, evaluateEnding,
  FACTION_IDS, FRAGMENT_IDS, importCheckpoint, recordLeaderDominion, REGIONAL_OBLIGATION_IDS,
  REGION_IDS, setCrownCouncilRepresentation, setPackLeader, type CampaignState,
} from './index.js';

function eligible(runId: string): CampaignState {
  const initial = createNewRun(runId);
  return {
    ...initial,
    world: {
      ...initial.world,
      factions: Object.fromEntries(FACTION_IDS.map((id) => [id, {
        ...initial.world.factions[id], bondTier: 3,
        representative: { ...initial.world.factions[id].representative, present: true, willing: true },
      }])) as CampaignState['world']['factions'],
      regions: Object.fromEntries(REGION_IDS.map((id) => [id, 'restored'])) as CampaignState['world']['regions'],
      hollowReady: true,
      regionalObligations: Object.fromEntries(REGIONAL_OBLIGATION_IDS.map((id) => [id, true])) as CampaignState['world']['regionalObligations'],
      renewedCommitments: Object.fromEntries(FACTION_IDS.map((id) => [id, true])) as CampaignState['world']['renewedCommitments'],
    },
  };
}

const report: Record<string, unknown> = {};
let first = createNewRun('scenario-one');
report.newRun = { runId: first.runId, history: first.dominionHistory.length, fragments: first.world.fragments.length };
report.canon = {
  skyLeader: first.world.factions.sky.leaderId,
  skyRepresentative: first.world.factions.sky.representative.id,
  canopyLeader: first.world.factions.canopy.leaderId,
  canopyRepresentative: first.world.factions.canopy.representative.id,
  fangLeader: first.world.factions.fang.leaderId,
  packLeader: first.world.factions.pack.leaderId,
  packRepresentative: first.world.factions.pack.representative.id,
  shadowLeader: first.world.factions.shadow.leaderId,
  crownLeader: first.world.factions.crown.leaderId,
};
const lumaOutcome = recordLeaderDominion(setPackLeader(first, 'luma'), 'luma');
report.lumaDominion = { activeLeader: lumaOutcome.world.factions.pack.leaderId, leaderId: lumaOutcome.dominionHistory[0]?.leaderId };
first = collectFragment(first, FRAGMENT_IDS[0]);
first = collectFragment(first, FRAGMENT_IDS[0]);
report.fragmentIdempotency = { fragmentCountAfterDuplicate: first.world.fragments.length };
const complete = eligible('scenario-eligible');
const completeResult = evaluateEnding(complete);
report.fullyEligible = { available: completeResult.available, unmetCount: completeResult.unmet.length, choices: completeResult.choices };
const oneMissingResult = evaluateEnding({ ...complete, world: { ...complete.world, hollowReady: false } });
report.exactlyOneMissing = { available: oneMissingResult.available, unmetIds: oneMissingResult.unmet.map(({ id }) => id) };
report.regionalObligationBoundaries = Object.fromEntries(REGIONAL_OBLIGATION_IDS.map((id) => {
  const state = { ...complete, world: { ...complete.world, regionalObligations: { ...complete.world.regionalObligations, [id]: false } } };
  return [id, evaluateEnding(state).unmet.map(({ id: unmetId }) => unmetId)];
}));
const checkpoint = createCheckpoint(complete);
const withDominion = recordLeaderDominion(recordLeaderDominion(complete, 'solkar'), 'koro');
const restored = importCheckpoint(withDominion, checkpoint);
report.dominionThenOlderCheckpoint = restored.accepted
  ? { sequences: restored.state.dominionHistory.map((event) => event.sequence), livingPactAvailable: evaluateEnding(restored.state).available }
  : restored;
const isolated = createNewRun('scenario-two');
report.newRunIsolation = { emptyHistory: isolated.dominionHistory.length === 0, oldCheckpoint: importCheckpoint(isolated, checkpoint) };
let exile = eligible('scenario-exile');
exile = { ...exile, world: { ...exile.world, marekPresent: false, factions: { ...exile.world.factions, crown: {
  ...exile.world.factions.crown,
  leaderStatus: 'exiled',
  representative: { id: 'solkar', source: 'leader', present: false, willing: false },
} } } };
const absenceLoad = importCheckpoint(createNewRun(exile.runId), createCheckpoint(exile));
if (!absenceLoad.accepted) throw new Error('Expected an absent Solkar checkpoint to load.');
const staleExile = evaluateEnding(absenceLoad.state);
const representedExile = setCrownCouncilRepresentation(absenceLoad.state, true);
report.exileCouncilWithoutMarek = { absenceCheckpointAccepted: absenceLoad.accepted, staleSolkarUnmet: staleExile.unmet.map(({ id }) => id), endingAvailableWithCouncil: evaluateEnding(representedExile).available, marekPresent: representedExile.world.marekPresent };
report.invalidImports = [
  importCheckpoint(complete, { ...checkpoint, schemaVersion: 99 }),
  importCheckpoint(complete, { ...checkpoint, runId: 'different' }),
  importCheckpoint(complete, { ...checkpoint, world: null }),
  importCheckpoint(complete, { ...checkpoint, ...createShowcaseReplay() }),
];
console.log(JSON.stringify(report, null, 2));
