import { describe, expect, it } from 'bun:test';
import { REGIONS } from '../../src/content/campaign.js';
import { projectPartyIntoRegion } from '../../src/app/ChapterParty.js';
import { CampaignDirector } from '../../src/game/campaign/CampaignDirector.js';
import { CombatEngine } from '../../src/game/combat/CombatEngine.js';
import { BOSS_ENCOUNTERS } from '../../src/game/combat/content.js';
import { companionActor } from '../../src/game/companions/CompanionSystem.js';

describe('traveling party replacement', () => {
  it('keeps the hostile story boss distinct from a selected ally of the same species', () => {
    const authored = REGIONS.find(region => region.id === 'blood-bamboo-valley')!;
    const campaign = new CampaignDirector().startNewRun('party-boss-separation');
    const slots = { companionId: 'asha' } as const;
    const projection = projectPartyIntoRegion({ region: authored, party: slots, companions: campaign.companions, worldFacts: campaign.worldFacts, spawnPosition: null });
    const region = { ...authored, entities: [...authored.entities, ...projection.entities] };
    const engine = new CombatEngine();
    engine.loadRegion({ regionId: region.id, regionDefinition: region, runId: campaign.runId, presentActorIds: region.entities.filter(entity => entity.kind === 'actor').map(entity => entity.id), companionId: slots.companionId });
    const encounter = Object.values(BOSS_ENCOUNTERS).find(item => item.regionId === region.id && item.bossId === 'asha')!;
    engine.startEncounter({ regionId: region.id, encounterId: encounter.id, runId: campaign.runId, companionId: slots.companionId });
    const state = engine.snapshotState();
    const ally = companionActor(state, 'asha')!;
    expect(ally.id).not.toBe(state.encounter!.bossId);
    expect(ally.allegiance).toBe('ally');
    expect(state.actors.find(actor => actor.id === state.encounter!.bossId)?.allegiance).toBe('hostile');
  });

  it('stages without mutation and preserves live hero, encounter and cooldowns when a different ally joins', () => {
    const authored = REGIONS.find(region => region.id === 'greenwake')!;
    const campaign = new CampaignDirector().startNewRun('party-live-swap');
    const initial = { companionId: 'koro' } as const;
    const first = projectPartyIntoRegion({ region: authored, party: initial, companions: campaign.companions, worldFacts: campaign.worldFacts, spawnPosition: null });
    const engine = new CombatEngine();
    engine.loadRegion({ regionId: authored.id, regionDefinition: { ...authored, entities: [...authored.entities, ...first.entities] }, runId: campaign.runId, presentActorIds: [...authored.entities, ...first.entities].filter(entity => entity.kind === 'actor').map(entity => entity.id), companionId: initial.companionId });
    const state = engine.snapshotState();
    state.player.vitality = 43; state.player.mana = 27; state.worldTick = 123;
    state.encounter = { id: 'live-preservation', bossId: 'greenwake-boar', phases: [] } as never;
    state.companionState.supportReadyAt.koro = 500;
    engine.restore(JSON.stringify(state));
    const next = { companionId: 'sable' } as const;
    const projection = projectPartyIntoRegion({ region: authored, party: next, companions: campaign.companions, worldFacts: campaign.worldFacts, spawnPosition: state.actors.find(actor => actor.id === 'aren')!.position });
    const commit = engine.prepareCompanionParty({ ...authored, entities: [...authored.entities, ...projection.entities] }, next.companionId);
    expect(engine.snapshotState().companionState.companionId).toBe(initial.companionId);
    expect(companionActor(state, 'sable')).toBeUndefined();
    commit();
    const after = engine.snapshotState();
    expect(after.player.vitality).toBe(43); expect(after.player.mana).toBe(27);
    expect(after.worldTick).toBe(123); expect(after.encounter?.id).toBe('live-preservation');
    expect(after.companionState.supportReadyAt.koro).toBe(500);
    expect(companionActor(after, 'sable')?.allegiance).toBe('ally');
    expect(after.actors.some(actor => actor.id === 'koro__party_companion')).toBe(false);
    expect(campaign.companions.sable.recruited).toBe(false);
  });
});
