import assert from 'node:assert/strict';
import test from 'node:test';
import { INTERACTIONS, QUESTS, REGIONS, CampaignDirector } from '../../src/game/campaign/index.js';
import { CHAPTER_RUNTIME } from '../../src/content/chapters.js';
import { chapterExitCueOf, objectiveCueOf, objectiveHudOf, type ObjectiveHudInput } from '../../src/app/ChapterFlow.js';
import { CombatEngine } from '../../src/game/combat/CombatEngine.js';
import type { CampaignSnapshot, RegionId } from '../../src/game/contracts.js';

const canopy = REGIONS.find(region => region.id === 'whispering-canopy')!;
const regionName = (id: RegionId) => REGIONS.find(region => region.id === id)?.name ?? id;
const placed = (id: string) => canopy.entities.find(entity => entity.id === id)!.position;

const base = new CampaignDirector({ runId: 'guidance' }).startChapterRun({ runId: 'guidance', heroId: 'aren', saveScope: 'production' });

interface Scene {
    quests?: string[]; objectives?: string[]; tracked?: string; completedQuests?: string[]; completedObjectives?: string[];
    facts?: Record<string, boolean>; fragments?: string[]; choices?: Record<string, string>; beats?: string[]; pending?: string | null;
    contextual?: string | null;
}

const KORO_CLEANSED = 'encounter-koro-cleansed';
const SITE_FACTS = ['interaction:canopy-waterwheel', 'interaction:monkey-rescue', 'interaction:orchard-seeds'];

/** A real Director snapshot placed in the Canopy, with only the story progress under test rewritten. */
function input(scene: Scene): ObjectiveHudInput {
    const snapshot = {
        ...base,
        chapter: 1,
        regionId: canopy.id,
        activeQuestIds: scene.quests ?? [],
        activeObjectiveIds: scene.objectives ?? [],
        trackedObjectiveId: scene.tracked ?? null,
        completedQuestIds: scene.completedQuests ?? [],
        completedObjectiveIds: scene.completedObjectives ?? [],
        fragments: scene.fragments ?? [],
        choices: scene.choices ?? {},
        worldFacts: { ...base.worldFacts, ...scene.facts },
        session: { ...base.session, resume: { ...base.session.resume, pendingChoiceId: scene.pending ?? null, completedBeatIds: scene.beats ?? [] } },
    } as unknown as CampaignSnapshot;
    return {
        snapshot, quests: QUESTS, interactions: INTERACTIONS, region: canopy, actors: [], movableObjects: [],
        player: { x: 40, y: 0, z: -10 }, basis: { forward: { x: 0, z: -1 }, right: { x: 1, z: 0 } }, runtime: undefined,
        chapters: CHAPTER_RUNTIME, regionName, contextualInteractionId: scene.contextual ?? null,
    };
}

const fragmentScene = (extra: Scene = {}): Scene => ({
    quests: ['empty-orchard'], objectives: ['empty-orchard:canopy-fragment'], tracked: 'empty-orchard:canopy-fragment', ...extra,
});

test('an objective naming a semantic target resolves to the placed interaction entity', () => {
    const scene = input(fragmentScene({ facts: { [KORO_CLEANSED]: true } }));
    const cue = objectiveCueOf(scene);
    assert.deepEqual(cue?.position, placed('canopy-fragment'));
    assert.equal(cue?.kind, 'objective');
    assert.equal(cue?.status, 'approach');
    assert.notEqual(objectiveHudOf(scene)?.destination?.bearingDegrees, null);
});

test('ready needs the engine\'s actual nearest interaction, not proximity', () => {
    const eligible = { [KORO_CLEANSED]: true };
    const near = input(fragmentScene({ facts: eligible, contextual: 'canopy-fragment' }));
    assert.equal(objectiveCueOf(near)?.status, 'ready');
    assert.equal(objectiveHudOf(near)?.status, 'ready');
    // Standing beside the site with a different prompt in range is still approach.
    const other = input(fragmentScene({ facts: eligible, contextual: 'koro-pact' }));
    assert.equal(objectiveCueOf({ ...other, player: { x: 46.5, y: 0, z: -29 } })?.status, 'approach');
});

test('an unmet prerequisite is blocked, names its objective, and offers no action even in range', () => {
    const scene = input(fragmentScene({ contextual: 'canopy-fragment' }));
    const hud = objectiveHudOf(scene)!;
    const koro = QUESTS.flatMap(quest => quest.objectives).find(objective => objective.requiredEvents.includes('encounter:encounter-koro'))!;
    assert.equal(objectiveCueOf(scene)?.status, 'blocked');
    assert.equal(hud.status, 'blocked');
    assert.equal(hud.interaction, null);
    assert.equal(hud.interactionInputHint, undefined);
    assert.ok(hud.guidance?.includes(koro.title), 'names the actual prerequisite objective');
    assert.deepEqual(objectiveCueOf(scene)?.position, placed('canopy-fragment'));
});

test('an elevated target keeps its authored height', () => {
    const scene = input({ quests: ['thief-in-the-branches'], objectives: ['thief-in-the-branches:vault-branch'], tracked: 'thief-in-the-branches:vault-branch' });
    assert.equal(objectiveCueOf(scene)?.position.y, placed('canopy-vault').y);
    assert.ok(placed('canopy-vault').y > 0);
});

test('the prompt hint matches the authored action and encounters claim no interaction', () => {
    const heavy = input({ quests: ['empty-orchard'], objectives: ['empty-orchard:water-flow'], tracked: 'empty-orchard:water-flow' });
    assert.equal(objectiveHudOf(heavy)?.interactionInputHint, 'heavy');
    const restore = input({
        quests: ['empty-orchard'], objectives: ['empty-orchard:restore-canopy'], tracked: 'empty-orchard:restore-canopy',
        facts: { [KORO_CLEANSED]: true, 'choice:koro-pact': true, ...Object.fromEntries(SITE_FACTS.map(fact => [fact, true])) },
    });
    assert.equal(objectiveHudOf(restore)?.interactionInputHint, 'ability');
    const encounter = input({ quests: ['empty-orchard'], objectives: ['empty-orchard:cleanse-koro'], tracked: 'empty-orchard:cleanse-koro', facts: Object.fromEntries(SITE_FACTS.map(fact => [fact, true])) });
    const hud = objectiveHudOf(encounter)!;
    assert.equal(hud.interaction, null);
    assert.equal(hud.interactionInputHint, undefined);
    assert.equal(objectiveCueOf(encounter)?.status, 'approach');
});

function scoutScene(objective: 'mark-threat' | 'answer-warning', equipped: boolean): ObjectiveHudInput {
    const scene = input({ quests: ['fallen-scout'], objectives: ['fallen-scout:' + objective], tracked: 'fallen-scout:' + objective, contextual: 'canopy-tend-vara' });
    const engine = new CombatEngine();
    engine.loadRegion({ regionId: canopy.id, runId: 'scout-guidance', presentActorIds: ['canopy-howler', 'canopy-hornbill'] });
    return {
        ...scene, actors: engine.snapshot().actors,
        snapshot: { ...scene.snapshot, party: equipped ? { companionId: 'vara' } : {},
            companions: { ...scene.snapshot.companions, vara: { ...scene.snapshot.companions.vara, recruited: true } } },
    };
}

test('the scout lesson first asks for party selection, then a command, never an interaction at the marker', () => {
    const unequipped = scoutScene('mark-threat', false);
    const equipHud = objectiveHudOf(unequipped)!;
    assert.equal(equipHud.interactionInputHint, 'companions');
    assert.equal(equipHud.status, 'blocked');
    assert.equal(equipHud.destination, null);
    assert.equal(objectiveCueOf(unequipped), null);
    const equipped = scoutScene('mark-threat', true);
    const markHud = objectiveHudOf(equipped)!;
    assert.equal(markHud.interactionInputHint, 'commandWheel');
    assert.equal(markHud.status, 'approach');
    assert.deepEqual(objectiveCueOf(equipped)?.position, equipped.actors.find(actor => actor.id === 'canopy-howler')!.position);
    assert.notEqual(markHud.destination, null);
});

test('scout guidance never invents a threat from its authored placement when that actor is unavailable', () => {
    const scene = scoutScene('mark-threat', true);
    assert.equal(objectiveCueOf({ ...scene, region: null }), null);
    assert.equal(objectiveCueOf({ ...scene, region: REGIONS.find(region => region.id === 'greenwake')! }), null);
    for (const unavailable of ['absent', 'hidden', 'downed', 'dead', 'ally'] as const) {
        const actors = unavailable === 'absent' ? scene.actors.filter(actor => actor.id !== 'canopy-howler') : scene.actors.map(actor =>
            actor.id !== 'canopy-howler' ? actor : { ...actor, visible: unavailable !== 'hidden', downed: unavailable === 'downed',
                vitality: unavailable === 'dead' ? 0 : actor.vitality, allegiance: unavailable === 'ally' ? 'ally' as const : actor.allegiance });
        const missing = { ...scene, actors };
        assert.equal(objectiveCueOf(missing), null);
        assert.equal(objectiveHudOf(missing)?.status, 'blocked');
        assert.equal(objectiveHudOf(missing)?.interaction, null);
    }
});

test('the warning step points to the actual warned threat, not Vara, and has no interaction key', () => {
    const scene = scoutScene('answer-warning', true);
    assert.deepEqual(objectiveCueOf(scene)?.position, scene.actors.find(actor => actor.id === 'canopy-howler')!.position);
    const warning = { ...scene, scoutWarningTargetId: 'canopy-hornbill' };
    assert.deepEqual(objectiveCueOf(warning)?.position, scene.actors.find(actor => actor.id === 'canopy-hornbill')!.position);
    assert.equal(objectiveHudOf(warning)?.interaction, null);
    assert.equal(objectiveHudOf(warning)?.interactionInputHint, undefined);
    assert.equal(objectiveCueOf({ ...scene, scoutWarningTargetId: 'vanished-threat' }), null);
});

test('a spent interaction stops prompting and guidance advances to the next objective', () => {
    const spent = input(fragmentScene({ facts: { [KORO_CLEANSED]: true }, fragments: ['heartroot-canopy'], contextual: 'canopy-fragment' }));
    assert.equal(objectiveHudOf(spent)?.interaction, null);
    assert.notEqual(objectiveCueOf(spent)?.status, 'ready');
    const advanced = input({
        quests: ['empty-orchard'], objectives: ['empty-orchard:koro-pact'], tracked: 'empty-orchard:koro-pact',
        completedObjectives: ['empty-orchard:canopy-fragment'], facts: { [KORO_CLEANSED]: true },
    });
    assert.deepEqual(objectiveCueOf(advanced)?.position, placed('koro-pact'));
    assert.equal(objectiveCueOf(advanced)?.id, 'empty-orchard:koro-pact');
});

test('a pending spatial choice guides to its site while the tracked quest stays authoritative', () => {
    const scene = input({
        quests: ['empty-orchard'], objectives: ['empty-orchard:restore-canopy'], tracked: 'empty-orchard:restore-canopy',
        facts: { [KORO_CLEANSED]: true, ...Object.fromEntries(SITE_FACTS.map(fact => [fact, true])) }, pending: 'koro-pact', contextual: 'koro-pact',
    });
    const cue = objectiveCueOf(scene);
    assert.deepEqual(cue?.position, placed('koro-pact'));
    assert.equal(cue?.status, 'ready');
    assert.equal(objectiveHudOf(scene)?.objectiveTitle, QUESTS.flatMap(quest => quest.objectives).find(objective => objective.id === 'empty-orchard:restore-canopy')!.title);
});

const earned = (extra: Scene = {}): Scene => ({
    completedQuests: ['fallen-scout', 'thief-in-the-branches', 'empty-orchard'],
    choices: { 'koro-pact': 'bond' }, beats: ['orchard-close'],
    facts: { 'restoration:whispering-canopy:restored': true }, ...extra,
});

test('an earned forward exit leads even while an optional quest remains', () => {
    const optional = QUESTS.find(quest => quest.optional && quest.objectives.length)!;
    const scene = input(earned({ quests: [optional.id], objectives: [optional.objectives[0]!.id], tracked: optional.objectives[0]!.id, contextual: 'canopy-bamboo-out' }));
    const exit = chapterExitCueOf(scene);
    const route = canopy.exits.find(item => item.id === 'canopy-bamboo-out')!;
    assert.deepEqual(exit, { id: route.id, position: route.from, kind: 'exit', status: 'ready' });
    const hud = objectiveHudOf(scene)!;
    assert.equal(hud.objectiveTitle, 'Path to ' + regionName(route.destinationRegionId));
    assert.equal(hud.interactionInputHint, 'interact');
    assert.equal(hud.status, 'ready');
    assert.equal(objectiveCueOf(scene), null);
    assert.equal(chapterExitCueOf({ ...scene, contextualInteractionId: null })?.status, 'approach');
});

test('a locked exit offers no beacon and the objective keeps guiding', () => {
    const scene = input(earned({
        facts: {}, quests: ['empty-orchard'], objectives: ['empty-orchard:restore-canopy'], tracked: 'empty-orchard:restore-canopy', completedQuests: [],
    }));
    assert.equal(chapterExitCueOf(scene), null);
    assert.equal(objectiveHudOf(scene)?.questTitle, 'The Empty Orchard');
    assert.ok(objectiveCueOf(scene));
});

test('a pending required choice keeps the exit beacon closed', () => {
    const scene = input(earned({ pending: 'koro-pact' }));
    assert.equal(chapterExitCueOf(scene), null);
    assert.equal(objectiveHudOf(scene), undefined);
});

test('a required objective still active in this region keeps the exit closed', () => {
    const scene = input(earned({ quests: ['empty-orchard'], objectives: ['empty-orchard:restore-canopy'], tracked: 'empty-orchard:restore-canopy' }));
    assert.equal(chapterExitCueOf(scene), null);
});
