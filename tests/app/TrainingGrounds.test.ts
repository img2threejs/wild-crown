import { describe, expect, it } from 'bun:test';
import {
  createTrainingDirector,
  regionStoryCleared,
  trainingEntryReason,
  trainingMapsOf,
} from '../../src/app/TrainingGrounds.js';
import { CampaignDirector } from '../../src/game/campaign/CampaignDirector.js';
import { REGIONS } from '../../src/content/campaign.js';
import { QUESTS } from '../../src/content/quests.js';
import { ACT_I_INTERACTIONS } from '../../src/content/act-i-interactions.js';
import { CHAPTER_RUNTIME, LAYOUT_MIGRATIONS, RELATIONSHIP_RULES } from '../../src/content/chapters.js';
import type { CampaignSnapshot, CombatSnapshot, InteractionDefinition, WorldEvent } from '../../src/game/contracts.js';

/** A combat snapshot of a hero standing at a world position: no encounter, no story, no hazard. */
function combatAt(position: { x: number; y: number; z: number }, over: Partial<CombatSnapshot> = {}): CombatSnapshot {
  return {
    actors: [{
      id: 'aren', archetypeId: 'aren', species: 'human', allegiance: 'player', position, velocity: { x: 0, y: 0, z: 0 },
      facing: { x: 0, y: 0, z: 1 }, actionId: 'aren-idle', phase: 'idle', normalizedTime: 0, sockets: {},
      interactionRequirements: [], visible: true, downed: false, possessed: false,
    }],
    movableObjects: [],
    worldClock: { simulationTick: 0, worldTick: 0, worldTimeSeconds: 0, timeScale: 1, policy: 'normal' },
    skills: [],
    player: { heroId: 'aren', vitality: 100, maxVitality: 100, instinct: 0, mana: 100, maxMana: 100 },
    telegraphs: [],
    hazards: [],
    events: [],
    ...over,
  } as unknown as CombatSnapshot;
}

/**
 * A campaign journey driven by the authored event grammar, exactly as the campaign's own tests do: every fact is
 * earned by a real accepted event, never by writing a snapshot field.
 */
class Journey {
  readonly director: CampaignDirector;
  private beatCursor = 0;

  constructor(runId: string, scope: 'production' | 'candidate-chapters' = 'production') {
    this.director = new CampaignDirector({
      runId,
      saveScope: scope,
      chapters: CHAPTER_RUNTIME,
      layoutMigrations: LAYOUT_MIGRATIONS,
      relationshipRules: RELATIONSHIP_RULES,
    });
    this.director.startChapterRun({ runId, heroId: 'aren', saveScope: scope });
  }

  get snapshot(): CampaignSnapshot { return this.director.snapshot(); }

  /** Acknowledges every queued authored story beat, so the journey is never blocked by dialogue. */
  private async acknowledgeBeats(): Promise<void> {
    while (this.snapshot.session.resume.requiredBeatQueue.length) {
      const resume = this.snapshot.session.resume;
      await this.director.advanceStory({ beatId: resume.requiredBeatQueue[0]!, lineIndex: resume.dialogue?.lineIndex ?? 0, skip: true });
    }
  }

  /** Commits one authored interaction's own success event, then clears any beat it scheduled. */
  private async interact(id: string): Promise<void> {
    const interaction = ACT_I_INTERACTIONS.find((item) => item.id === id)! as InteractionDefinition;
    await this.director.processEvent({
      ...interaction.success,
      eventId: `story:${id}:${this.beatCursor}`,
      idempotencyKey: `story:${id}:${this.beatCursor}`,
      interactionId: id,
    } as unknown as WorldEvent);
    await this.acknowledgeBeats();
  }

  /** Commits an authored encounter's resolution, as the live engine does when the guardian is cleansed. */
  private async cleanse(encounterId: string, actorIds: readonly string[]): Promise<void> {
    await this.director.processEvent({
      type: 'encounter-resolved', eventId: `story:${encounterId}`, idempotencyKey: `story:${encounterId}`,
      encounterId, resolution: 'cleansed', actorIds: [...actorIds],
    } as WorldEvent);
    await this.acknowledgeBeats();
  }

  /** Commits an authored choice, as the live engine does when the player settles a ceremony. */
  private async choose(choiceId: string, optionId: string): Promise<void> {
    await this.director.choose(choiceId, optionId);
    await this.acknowledgeBeats();
  }
}

/** The Greenwake prologue and the corrupted boar, cleared with the authored events. */
async function clearGreenwake(journey: Journey): Promise<void> {
  await journey.acknowledgeBeats();
  for (const id of ['greenwake-roars', 'tend-vara', 'vara-fragment', 'warden-staff']) await journey.interact(id);
  await journey.director.beginChapterEncounter('greenwake-boar', 'greenwake-pre-boar');
  await journey.cleanse('greenwake-boar', ['corrupted-boar']);
  await journey.interact('greenwake-gate');
}

/** The Canopy chapter, cleared with the authored events. */
async function clearCanopy(journey: Journey): Promise<void> {
  await journey.director.advanceChapter({ exitId: 'greenwake-canopy-out', requestId: 'to-canopy' });
  await journey.acknowledgeBeats();
  for (const id of ['canopy-vine-route', 'canopy-vault', 'koro-trail', 'canopy-tend-vara']) await journey.interact(id);
  for (const id of ['bird-mark', 'warning-response']) {
    await journey.director.processEvent({
      type: 'semantic-interaction', eventId: `story:${id}`, idempotencyKey: `story:${id}`,
      actorId: 'vara', interactionId: id, kind: 'signal', targetId: id, position: { x: 0, y: 0, z: 0 },
    } as WorldEvent);
  }
  await journey.acknowledgeBeats();
  for (const id of ['canopy-waterwheel', 'monkey-rescue', 'orchard-seeds', 'koro-thorn']) await journey.interact(id);
  await journey.director.beginChapterEncounter('encounter-koro', 'canopy-pre-koro');
  await journey.cleanse('encounter-koro', ['koro']);
  await journey.interact('canopy-fragment');
  await journey.choose('koro-pact', 'bond');
  await journey.interact('canopy-restoration');
}

describe('Training Grounds map access', () => {
  it('refuses every map for a fresh journey and names the story that opens each one', () => {
    const journey = new Journey('maps-fresh');
    const maps = trainingMapsOf(journey.snapshot);
    expect(maps.map((map) => map.id)).toEqual(['greenwake', 'canopy', 'grove', 'moonpine', 'mistveil']);
    expect(maps.every((map) => map.unlocked === false)).toBe(true);
    expect(maps.every((map) => typeof map.reason === 'string' && map.reason.length > 0)).toBe(true);
  });

  it('keeps an early current-map player locked: standing in the Canopy is not a cleared Canopy', async () => {
    const journey = new Journey('maps-early');
    await clearGreenwake(journey);
    await journey.director.advanceChapter({ exitId: 'greenwake-canopy-out', requestId: 'to-canopy' });
    const snapshot = journey.snapshot;
    expect(snapshot.regionId).toBe('whispering-canopy');
    expect(snapshot.worldFacts['visited:whispering-canopy']).toBe(true);
    expect(regionStoryCleared(snapshot, 'whispering-canopy')).toBe(false);
    expect(trainingMapsOf(snapshot).find((map) => map.id === 'canopy')!.unlocked).toBe(false);
  });

  it('unlocks the Greenwake map only after its authored boar and gate are cleared', async () => {
    const journey = new Journey('maps-cleared');
    await clearGreenwake(journey);
    const cleared = journey.snapshot;
    expect(cleared.completedQuestIds).toContain('prologue');
    expect(regionStoryCleared(cleared, 'greenwake')).toBe(true);
    expect(trainingMapsOf(cleared).find((map) => map.id === 'greenwake')!.unlocked).toBe(true);
    // A later chapter never relocks genuinely earned practice.
    await clearCanopy(journey);
    const later = journey.snapshot;
    expect(later.chapter).toBe(1);
    expect(trainingMapsOf(later).find((map) => map.id === 'greenwake')!.unlocked).toBe(true);
    expect(trainingMapsOf(later).find((map) => map.id === 'canopy')!.unlocked).toBe(true);
  });

  it('never makes an optional quest a requirement for a map', async () => {
    const journey = new Journey('maps-optional');
    await clearGreenwake(journey);
    await clearCanopy(journey);
    const snapshot = journey.snapshot;
    const optional = QUESTS.filter((quest) => quest.optional && quest.region === 'whispering-canopy');
    expect(optional.length).toBeGreaterThan(0);
    expect(snapshot.completedQuestIds).not.toContain(optional[0]!.id);
    expect(regionStoryCleared(snapshot, 'whispering-canopy')).toBe(true);
    expect(trainingMapsOf(snapshot).find((map) => map.id === 'canopy')!.unlocked).toBe(true);
  });
});

describe('Training Grounds entry', () => {
  it('refuses a fresh journey that has cleared no supported content', () => {
    const journey = new Journey('entry-fresh');
    expect(trainingEntryReason(journey.snapshot, combatAt({ x: 0, y: 0, z: 0 }))).toBeTruthy();
  });

  it('refuses an active encounter and an airborne hero', async () => {
    const journey = new Journey('entry-busy');
    await clearGreenwake(journey);
    const snapshot = journey.snapshot;
    expect(trainingEntryReason(snapshot, combatAt({ x: 0, y: 0, z: 0 }, { encounterId: 'greenwake-boar' }))).toContain('encounter');
    const airborne = combatAt({ x: 0, y: 0, z: 0 });
    airborne.actors[0] = { ...airborne.actors[0]!, jumpPhase: 'rising' };
    expect(trainingEntryReason(snapshot, airborne)).toContain('Land');
  });

  it('allows an authored safe checkpoint only outside side activities', async () => {
    const journey = new Journey('entry-unsafe');
    await clearGreenwake(journey);
    const snapshot = journey.snapshot;
    const region = REGIONS.find((item) => item.id === snapshot.regionId)!;
    const spawn = region.navigation.nodes.find((node) => node.id === 'greenwake-forest-entry')!;
    // The authored safe checkpoint itself is a safe place.
    expect(trainingEntryReason(snapshot, combatAt(spawn.position))).toBeNull();
    expect(trainingEntryReason(snapshot, combatAt(spawn.position, { nurseryEscortActive: true }))).not.toBeNull();
    expect(trainingEntryReason(snapshot, combatAt(spawn.position, {
      dodgePractice: { active: true, attempts: 0, dodged: 0, phase: 'warning' },
    }))).not.toBeNull();
    // A distant floor in the same region is not.
    expect(trainingEntryReason(snapshot, combatAt({ x: spawn.position.x + 40, y: spawn.position.y, z: spawn.position.z + 40 })))
      .toContain('safe checkpoint');
  });

  it('refuses a required story beat that has not been acknowledged', () => {
    const journey = new Journey('entry-beat');
    expect(journey.snapshot.session.resume.requiredBeatQueue.length).toBeGreaterThan(0);
    expect(trainingEntryReason(journey.snapshot, combatAt({ x: 0, y: 0, z: 0 }))).toContain('story beat');
  });
});

describe('Training Grounds practice session', () => {
  it('refuses an unknown map, a locked map and an asset policy that does not match the journey', () => {
    const journey = new Journey('practice-refused');
    const fresh = journey.snapshot;
    expect(() => createTrainingDirector(fresh, 'not-a-map', 'verified')).toThrow();
    expect(() => createTrainingDirector(fresh, 'greenwake', 'verified')).toThrow();
    expect(() => createTrainingDirector(fresh, 'greenwake', 'candidate')).toThrow();
  });

  it('refuses an asset policy that does not match the journey own save scope', async () => {
    const journey = new Journey('practice-scope');
    await clearGreenwake(journey);
    const source = journey.snapshot;
    // An inconsistent journey: candidate assets under a production scope. The practice session may not widen it.
    const inconsistent: CampaignSnapshot = { ...source, session: { ...source.session, saveScope: 'production' } };
    expect(() => createTrainingDirector(inconsistent, 'greenwake', 'candidate')).toThrow();
    expect(() => createTrainingDirector(source, 'greenwake', 'verified')).not.toThrow();
  });

  it('starts an isolated practice run that cannot change the source journey', async () => {
    const journey = new Journey('practice-isolated');
    await clearGreenwake(journey);
    const source = journey.snapshot;
    const before = JSON.stringify({
      companions: source.companions,
      dominion: source.campaign.dominionHistory,
      party: source.party,
      quests: source.completedQuestIds,
      runId: source.runId,
    });
    const practice = createTrainingDirector(source, 'greenwake', source.session.assetPolicy);
    expect(practice.session).toEqual({ kind: 'training', assets: source.session.assetPolicy, mapId: 'greenwake' });
    expect(practice.snapshot.runId).not.toBe(source.runId);
    expect(practice.snapshot.replay).toBe(true);
    expect(practice.snapshot.regionId).toBe('greenwake');
    expect(practice.snapshot.session.heroId).toBe(source.session.heroId);
    // The practice run advances no story, invents no history and grants no recruitment.
    expect(practice.snapshot.completedQuestIds).toEqual([]);
    expect(practice.snapshot.activeQuestIds).toEqual([]);
    expect(practice.snapshot.campaign.dominionHistory).toEqual(source.campaign.dominionHistory);
    expect(practice.snapshot.companions.vara.recruited).toBe(source.companions.vara.recruited);
    // The source journey is untouched by everything the practice run did.
    const after = journey.snapshot;
    expect(JSON.stringify({
      companions: after.companions,
      dominion: after.campaign.dominionHistory,
      party: after.party,
      quests: after.completedQuestIds,
      runId: after.runId,
    })).toBe(before);
  });

  it('keeps the practice run earned data isolated from the source by value', async () => {
    const journey = new Journey('practice-by-value');
    await clearGreenwake(journey);
    const source = journey.snapshot;
    const practice = createTrainingDirector(source, 'greenwake', source.session.assetPolicy);
    // Mutating the practice snapshot nested campaign data must not reach the source.
    practice.snapshot.campaign.world.fragments.push('heartroot-canopy' as never);
    practice.snapshot.companions.vara.bondLevel = 99;
    expect(journey.snapshot.campaign.world.fragments).not.toContain('heartroot-canopy');
    expect(journey.snapshot.companions.vara.bondLevel).not.toBe(99);
  });

  it('never grants a companion the source journey has not recruited', async () => {
    const journey = new Journey('practice-party');
    await clearGreenwake(journey);
    const source = journey.snapshot;
    const practice = createTrainingDirector(source, 'greenwake', source.session.assetPolicy);
    // A fresh journey has recruited nobody; the practice run therefore carries no traveling companion.
    expect(source.party.companionId).toBeUndefined();
    expect(practice.snapshot.party.companionId).toBeUndefined();
  });
});
