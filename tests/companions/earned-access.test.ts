import { describe, expect, it } from 'bun:test';
import type { ActorId, CompanionId, Vec3 } from '../../src/game/contracts.js';
import { CombatEngine, type CombatActor, type EngineState } from '../../src/game/combat/CombatEngine.js';
import { configureCompanion, configureCompanionProgress, createCompanionState } from '../../src/game/companions/CompanionSystem.js';
import { companionAccess } from '../../src/game/campaign/access.js';
import { CampaignDirector } from '../../src/game/campaign/CampaignDirector.js';
import type { CompanionProgress } from '../../src/game/contracts.js';

function actor(id: string, position: Vec3): CombatActor {
  return {
    id: id as ActorId, species: 'animal', allegiance: 'ally', position,
    visible: true, downed: false, possessedUntil: 0,
  } as unknown as CombatActor;
}

function engine(companionId: CompanionId): EngineState {
  return {
    tick: 12, worldTick: 12, worldTimeScale: 1,
    worldFacts: {},
    actors: [actor('aren', { x: 0, y: 0, z: 0 }), actor(companionId, { x: -2, y: 0, z: 1 })],
    companionState: createCompanionState(companionId),
  } as unknown as EngineState;
}

const recruited = (id: CompanionId): CompanionProgress => ({
  id, recruited: true, bondLevel: 10, dominionLevel: 0, unlockedAbilityIds: [], storyFlags: {},
});
const unrecruited = (id: CompanionId): CompanionProgress => ({
  id, recruited: false, bondLevel: 0, dominionLevel: 0, unlockedAbilityIds: [], storyFlags: {},
});

describe('earned companion access', () => {
  it('the simulation keeps a roster that carries no progress usable', () => {
    // A trial or a legacy fixture has no roster at all: the absence of a roster is not a refusal.
    const state = engine('koro');
    expect(state.companionState.progress).toBeUndefined();
    expect(configureCompanion(state, 'koro')).toBe(true);
  });

  it('the simulation refuses an unearned companion once a roster is supplied', () => {
    // The roster is authoritative: an unrecruited companion is never slotted and never commanded.
    const state = engine('koro');
    configureCompanionProgress(state, { koro: unrecruited('koro') });
    // The new roster revokes old equipment immediately; no fixed step or second enforcement call is needed.
    expect(state.companionState.companionId).toBeUndefined();
    expect(state.companionState.slots.koro).toBeUndefined();
    expect(configureCompanion(state, 'koro')).toBe(false);
    // The earned companion is slotted normally.
    configureCompanionProgress(state, { koro: recruited('koro') });
    expect(configureCompanion(state, 'koro')).toBe(true);
    expect(state.companionState.companionId).toBe('koro');
  });

  it('an exiled Solkar is not in the earned roster even when his recruitment survives', () => {
    const state = engine('solkar');
    configureCompanionProgress(state, {
      solkar: { ...recruited('solkar'), storyFlags: { 'solkar-exiled': true } },
    });
    expect(configureCompanion(state, 'solkar')).toBe(false);
    expect(state.companionState.companionId).toBeUndefined();
  });

  it('revokes an absent Solkar without hiding his narrative counterpart or erasing earned progress', () => {
    const state = engine('solkar');
    const traveling = { ...actor('solkar__party_companion', { x: -2, y: 0, z: 1 }), archetypeId: 'solkar' as ActorId };
    state.actors.push(traveling);
    const progress = { ...new CampaignDirector().snapshot().companions, solkar: recruited('solkar') };
    configureCompanionProgress(state, progress);
    state.companionState.ownerBoon = { sourceId: 'solkar', kind: 'power', untilWorldTick: 99 };
    state.worldFacts.solkarPresent = false;

    configureCompanionProgress(state, progress);

    expect(state.companionState.companionId).toBeUndefined();
    expect(state.companionState.ownerBoon).toBeUndefined();
    expect(traveling.visible).toBe(false);
    expect(state.actors.find(actor => actor.id === 'solkar')?.visible).toBe(true);
    expect(state.companionState.progress?.solkar).toEqual(progress.solkar);
    expect(configureCompanion(state, 'solkar')).toBe(false);
  });

  it('does not resurrect unearned equipment or refill command tokens when an old combat state is restored', () => {
    const combat = new CombatEngine();
    const saved = JSON.parse(combat.serialize()) as EngineState;
    saved.companionState = createCompanionState('koro');
    saved.companionState.progress = { koro: unrecruited('koro') };
    saved.companionState.tokens.available = 1;
    const tokens = { ...saved.companionState.tokens };

    combat.restore(JSON.stringify(saved));

    expect(combat.companions.companionId).toBeUndefined();
    expect(combat.companions.slots.koro).toBeUndefined();
    expect(combat.companions.progress?.koro).toEqual(saved.companionState.progress.koro);
    expect(combat.companions.tokens).toEqual(tokens);
  });

  it('removes an unearned Vara support mark without refunding command tokens', () => {
    const state = JSON.parse(new CombatEngine().serialize()) as EngineState;
    const template = state.actors.find(actor => actor.id === state.playerId)!;
    const vara = { ...structuredClone(template), id: 'vara' as ActorId, archetypeId: 'vara' as ActorId, species: 'animal' as const, allegiance: 'ally' as const };
    const target = {
      ...structuredClone(template), id: 'mark-target' as ActorId, species: 'animal' as const, allegiance: 'hostile' as const,
      markState: { sourceId: 'vara' as ActorId, untilWorldTick: 999, extended: false },
    };
    state.actors.push(vara, target);
    state.companionState = createCompanionState('vara');
    state.companionState.tokens.available = 1;
    const progress = { ...new CampaignDirector().snapshot().companions, vara: unrecruited('vara') };

    configureCompanionProgress(state, progress);

    expect(state.companionState.companionId).toBeUndefined();
    expect(target.markState).toBeUndefined();
    expect(state.companionState.tokens.available).toBe(1);
  });

  it('a DEV showcase fixture offers its whole roster without touching a normal run', async () => {
    const director = new CampaignDirector({ runId: 'showcase-roster' });
    const showcase = director.startShowcase('showcase-roster', 'greenwake', { heroId: 'aren', companionId: 'nyra' });
    expect(showcase.replay).toBe(true);
    expect(showcase.regionId).toBe('greenwake');
    // The fixture roster is available so the DEV map may switch companions freely.
    for (const id of ['vara', 'koro', 'asha', 'sable', 'nyra', 'solkar'] as const) {
      expect(companionAccess(showcase, id).available).toBe(true);
    }
    expect((await director.selectParty('sable')).party).toEqual({ companionId: 'sable' });
    // A normal run never receives that roster.
    const normal = director.startChapterRun({ runId: 'normal-run', heroId: 'aren', saveScope: 'production' });
    expect(normal.companions.sable.recruited).toBe(false);
    expect(companionAccess(normal, 'sable').available).toBe(false);
  });
});
