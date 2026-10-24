import type {
    ActorId, ActorSnapshot, AreaMapPoint, AreaMapViewModel, CampaignSnapshot, ChapterRuntimeDefinition, ChapterSegmentId, GameViewModel, InteractionDefinition, MovableObjectSnapshot, ObjectiveDefinition, QuestDefinition, QuestLogEntry, QuestLogViewModel, RegionDefinition, RegionEntityDefinition, RegionId, RegionRouteDefinition, Vec3, WorldObjectiveCue,
} from '../game/contracts.js';
import { BOSS_ENCOUNTERS, WILDLIFE_ENCOUNTERS } from '../game/combat/content.js';
import {
  currentSegmentOf,
  destinationChapterFor,
  projectionOf,
  transitionGateOf,
} from '../game/campaign/access.js';
import { NURSERY_ESCORT } from '../content/side-quests.js';

export { checkpointLabel as checkpointName } from '../ui/markup.js';

type Basis = { readonly forward: { readonly x: number; readonly z: number }; readonly right: { readonly x: number; readonly z: number } };

const SEGMENT_LABEL: Record<ChapterSegmentId, string> = {
    prologue: 'Prologue',
    greenwake: 'Chapter 0 · Greenwake',
    canopy: 'Chapter 1 · Whispering Canopy',
    bamboo: 'Chapter 2 · Blood Bamboo Valley',
    grove: 'The Grove · Act I hub',
    moonpine: 'Chapter 3 · Moonpine Ridge',
    mistveil: 'Chapter 4 · Mistveil Basin',
    sunmane: 'Chapter 5 · Sunmane Expanse',
    'grove-fall': 'Chapter 6 · The Fall of the Grove',
    refuge: 'Chapter 7 · The Refuge',
    'return-canopy': 'Chapter 7 · Return — Canopy',
    'return-bamboo': 'Chapter 7 · Return — Blood Bamboo',
    'return-moonpine': 'Chapter 7 · Return — Moonpine',
    'return-mistveil': 'Chapter 7 · Return — Mistveil',
    'return-sunmane': 'Chapter 7 · Return — Sunmane',
    hollow: 'Chapter 8 · Heartroot Hollow',
};

export const chapterLabelOf = (snapshot: Pick<CampaignSnapshot, 'segmentId' | 'chapter'>): string =>
    snapshot.segmentId ? SEGMENT_LABEL[snapshot.segmentId] : 'Chapter ' + snapshot.chapter;

export function trackedActiveObjective(snapshot: CampaignSnapshot, quests: readonly QuestDefinition[]): { quest: QuestDefinition; objective: ObjectiveDefinition } | null {
    const active = new Set<string>(snapshot.activeObjectiveIds);
    const owner = (objectiveId: string) => quests.find(quest => snapshot.activeQuestIds.includes(quest.id) && quest.objectives.some(item => item.id === objectiveId));
    const tracked = snapshot.trackedObjectiveId;
    if (tracked && active.has(tracked)) {
        const quest = owner(tracked);
        const objective = quest?.objectives.find(item => item.id === tracked);
        if (quest && objective) return { quest, objective };
    }
    for (const questId of snapshot.activeQuestIds) {
        const quest = quests.find(item => item.id === questId);
        const objective = quest?.objectives.find(item => active.has(item.id) && !item.optional) ?? quest?.objectives.find(item => active.has(item.id));
        if (quest && objective) return { quest, objective };
    }
    return null;
}

type Facts = Readonly<Record<string, boolean | number | string>>;
type CueStatus = WorldObjectiveCue['status'];
type ObjectiveHud = NonNullable<GameViewModel['objectiveHud']>;

/** An authored placement hidden behind a visibility fact is absent until that fact holds (when facts are known). */
const entityPresent = (entity: RegionEntityDefinition, facts: Facts | undefined): boolean => !entity.visibleWhen || facts === undefined || facts[entity.visibleWhen] === true;

export function objectiveTargetPosition(
    objective: ObjectiveDefinition, region: RegionDefinition, actors: readonly ActorSnapshot[], interactions: readonly InteractionDefinition[], runtime: ChapterRuntimeDefinition | undefined,
    worldFacts?: Facts,
): Vec3 | null {
    const lookup = (id: string): Vec3 | null => {
        const actor = actors.find(item => item.id === id && item.visible) ?? actors.find(item => item.archetypeId === id && item.visible);
        if (actor) return actor.position;
        const entity = region.entities.find(item => (item.id === id || item.interactionId === id) && entityPresent(item, worldFacts));
        if (entity) return entity.position;
        const node = region.navigation.nodes.find(item => item.id === id);
        if (node) return node.position;
        const route = [...region.exits, ...region.entrances, ...region.traversalArcs].find(item => item.id === id);
        if (route) return route.from;
        const entry = runtime?.encounterEntries.find(item => item.id === id || item.encounterId === id);
        if (entry) return entry.center;
        const prop = region.props.find(item => item.id === id);
        return prop ? prop.position : null;
    };
    for (const targetId of objective.targetIds) {
        const direct = lookup(targetId);
        if (direct) return direct;
        // An objective names the semantic target of an interaction (heartroot-canopy), not its placed entity (canopy-fragment).
        for (const interaction of interactions) {
            if (interaction.regionId !== region.id || (interaction.id !== targetId && interaction.targetId !== targetId)) continue;
            const viaInteraction = lookup(interaction.id) ?? lookup(interaction.targetId);
            if (viaInteraction) return viaInteraction;
        }
    }
    return null;
}

export interface ObjectiveHudInput {
    readonly snapshot: CampaignSnapshot;
    readonly quests: readonly QuestDefinition[];
    readonly interactions: readonly InteractionDefinition[];
    readonly region: RegionDefinition | null;
    readonly actors: readonly ActorSnapshot[];
    readonly movableObjects: readonly MovableObjectSnapshot[];
    readonly nurseryEscortActive?: boolean;
    readonly player: Vec3 | null;
    readonly basis: Basis | null;
    readonly runtime: ChapterRuntimeDefinition | undefined;
    /** Authored chapter runtime; the exit authority needs it to read the current segment's exit requirements. */
    readonly chapters?: readonly ChapterRuntimeDefinition[];
    readonly regionName?: (id: RegionId) => string;
    /** The interaction the player is actually in range of right now (the engine's nearest prompt), or null. */
    readonly contextualInteractionId?: string | null;
    /** Simulation-owned rear-threat warning, never inferred from the quest's companion placement. */
    readonly scoutWarningTargetId?: ActorId;
}

/** Where the given objective currently sends the player in the loaded region (escort shelter, carried delivery, or its target), or null. */
function objectiveDestination(input: ObjectiveHudInput, quest: QuestDefinition, objective: ObjectiveDefinition): Vec3 | null {
    if (!input.region || input.region.id !== input.snapshot.regionId) return null;
    if (input.nurseryEscortActive === true && quest.id === 'the-last-cub') return NURSERY_ESCORT.to;
    const delivery = input.region.deliveries?.find(item => objective.requiredEvents.includes(item.movedFactId));
    if (delivery) return input.movableObjects.some(item => item.objectId === delivery.id && item.phase === 'in-flight') ? delivery.to : delivery.from;
    const interaction = objectiveInteraction(input, quest, objective);
    const placed = interaction ? interactionPosition(input, input.region, interaction) : null;
    return placed ?? objectiveTargetPosition(objective, input.region, input.actors, input.interactions, input.runtime, input.snapshot.worldFacts);
}

/** How strongly an interaction answers an objective: its own event, its id, its fragment/choice/restoration event, or its semantic target. */
function interactionRank(objective: ObjectiveDefinition, item: InteractionDefinition): number {
    if (objective.requiredEvents.includes('interaction:' + item.id)) return 4;
    if (objective.targetIds.includes(item.id)) return 3;
    const success = item.success;
    if (success.type === 'fragment' && objective.requiredEvents.includes('fragment:' + success.fragmentId)) return 2;
    if (success.type === 'choice' && objective.requiredEvents.includes('choice:' + success.choiceId)) return 2;
    if (success.type === 'restoration' && objective.requiredEvents.includes('restoration:' + success.regionId)) return 2;
    return objective.targetIds.includes(item.targetId) ? 1 : 0;
}

/** A non-repeatable interaction whose result is already recorded can no longer resolve, so it is neither a target nor a prompt. */
function interactionSpent(snapshot: CampaignSnapshot, item: InteractionDefinition): boolean {
    if (item.repeatable) return false;
    if (snapshot.worldFacts['interaction:' + item.id] === true) return true;
    const success = item.success;
    if (success.type === 'fragment') return snapshot.fragments.includes(success.fragmentId);
    if (success.type === 'choice') return snapshot.choices[success.choiceId] !== undefined;
    return false;
}

/** Where an interaction actually sits, resolved the way the engine resolves it: a visible actor first, then its authored placement. */
function interactionPosition(input: ObjectiveHudInput, region: RegionDefinition, interaction: InteractionDefinition): Vec3 | null {
    const facts = input.snapshot.worldFacts;
    const actor = input.actors.find(item => item.visible && (item.id === interaction.targetId || item.archetypeId === interaction.targetId));
    if (actor) return actor.position;
    const entity = region.entities.find(item => (item.interactionId === interaction.id || item.id === interaction.id) && entityPresent(item, facts))
        ?? region.entities.find(item => (item.actorId === interaction.targetId || item.id === interaction.targetId) && entityPresent(item, facts));
    if (entity) return entity.position;
    return input.movableObjects.find(item => item.objectId === interaction.targetId)?.position ?? null;
}

/** The interaction that completes the objective in the current phase (pick-up or delivery of a carried object), or null. */
function objectiveInteraction(input: ObjectiveHudInput, quest: QuestDefinition, objective: ObjectiveDefinition): InteractionDefinition | null {
    const regionId = input.snapshot.regionId;
    const delivery = input.region?.deliveries?.find(item => objective.requiredEvents.includes(item.movedFactId));
    if (delivery) {
        const carrying = input.movableObjects.some(item => item.objectId === delivery.id && item.phase === 'in-flight');
        const id = carrying ? delivery.deliveryInteractionId : delivery.pickupInteractionId;
        return input.interactions.find(item => item.regionId === regionId && item.id === id) ?? null;
    }
    const ranked = input.interactions
        .filter(item => item.regionId === regionId && (!item.questId || item.questId === quest.id) && !interactionSpent(input.snapshot, item))
        .map(item => ({ item, rank: interactionRank(objective, item) }))
        .filter(entry => entry.rank > 0)
        .sort((a, b) => b.rank - a.rank);
    const context = input.contextualInteractionId;
    return (context ? ranked.find(entry => entry.item.id === context) : undefined)?.item ?? ranked[0]?.item ?? null;
}

/** Authored facts an interaction still waits for, plus an ally that must be present. */
function missingFactsOf(input: ObjectiveHudInput, interaction: InteractionDefinition, deliveryFacts: readonly string[]): { facts: string[]; actors: string[] } {
    return {
        facts: [...deliveryFacts, ...interaction.requiresFacts].filter(fact => input.snapshot.worldFacts[fact] !== true),
        actors: interaction.requiresActors.filter(id => !input.actors.some(actor => (actor.id === id || actor.archetypeId === id) && actor.visible && !actor.downed && !actor.possessed)),
    };
}

/** The title of the unfinished objective whose completion sets a fact, or null when no authored objective claims it. */
function prerequisiteTitle(input: ObjectiveHudInput, fact: string): string | null {
    const done = new Set<string>(input.snapshot.completedObjectiveIds);
    const objectives = input.quests.flatMap(quest => quest.objectives).filter(objective => !done.has(objective.id));
    const interaction = fact.startsWith('interaction:') ? input.interactions.find(item => item.id === fact.slice('interaction:'.length)) : undefined;
    const encounter = 'encounter:' + fact.replace(/-[a-z]+$/, '');
    const match = objectives.find(objective => objective.requiredEvents.includes(fact))
        ?? (interaction ? objectives.find(objective => interactionRank(objective, interaction) > 0) : undefined)
        ?? objectives.find(objective => objective.requiredEvents.includes(encounter));
    return match?.title ?? null;
}

const INPUT_ACTION: Record<NonNullable<InteractionDefinition['inputHint']>, string> = {
    interact: 'Press Interact',
    heavy: 'Use a heavy strike',
    ability: 'Use your ability',
};
const actionPhrase = (interaction: InteractionDefinition): string => `${INPUT_ACTION[interaction.inputHint ?? 'interact']}: ${interaction.promptLabel}`;

interface ObjectiveGuidance {
    readonly quest: QuestDefinition;
    readonly objective: ObjectiveDefinition;
    readonly escorting: boolean;
    readonly action: string | null;
    readonly inputHint: ObjectiveHud['interactionInputHint'];
    readonly target: Vec3 | null;
    readonly cueId: string;
    readonly status: CueStatus;
    readonly guidance: string;
    readonly instruction: string;
}

/** One answer to "where and how": the HUD, the area map and the world cue all read it, so they can never disagree. */
function objectiveGuidanceOf(input: ObjectiveHudInput, quest: QuestDefinition, objective: ObjectiveDefinition): ObjectiveGuidance {
    const mark = objective.requiredEvents.includes('semantic:bird-mark');
    const warning = objective.requiredEvents.includes('semantic:warning-response');
    if (mark || warning) {
        if (input.snapshot.party.companionId !== 'vara') {
            return {
                quest, objective, escorting: false, cueId: objective.id, action: 'Equip Vara in Companions', inputHint: 'companions',
                target: null, status: 'blocked', instruction: 'Equip Vara before giving her a command.',
                guidance: `${objective.description} Open Companions and equip Vara first. Standing at a world marker cannot perform a companion command.`,
            };
        }
        const target = input.region?.id === input.snapshot.regionId ? input.actors.find(actor => actor.visible && !actor.downed && (actor.vitality === undefined || actor.vitality > 0)
            && (actor.allegiance === 'hostile' || actor.allegiance === 'wild')
            && (warning && input.scoutWarningTargetId ? actor.id === input.scoutWarningTargetId
                : objective.targetIds.includes(actor.id) || objective.targetIds.includes(actor.archetypeId))) : undefined;
        if (!target) {
            return { quest, objective, escorting: false, cueId: objective.id, action: null, inputHint: undefined, target: null, status: 'blocked',
                instruction: 'Find a living threat for Vara to observe.',
                guidance: `${objective.description} This lesson needs a present, living threat; there is no interaction to press here.` };
        }
        return {
            quest, objective, escorting: false, cueId: objective.id, action: mark ? 'Mark Weakness' : null, inputHint: mark ? 'commandWheel' : undefined,
            target: target.position, status: 'approach',
            instruction: mark ? 'Keep the threat in view. Hold the command wheel, choose Mark Weakness, then release.'
                : input.scoutWarningTargetId ? 'Turn your hero toward the indicated threat now.'
                    : 'Face away from the nearby threat; turn back when Vara warns.',
            guidance: `${objective.description} ${mark
                ? 'Follow the fireflies to the threat and keep it in view. Hold Command Wheel, choose Mark Weakness, then release. This is not an Interact action.'
                : input.scoutWarningTargetId
                    ? 'Turn your hero to face the indicated threat before the warning fades. No interaction key is required.'
                    : 'Keep the threat nearby. Face away until Vara warns, then turn back toward it. No interaction key is required.'}`,
        };
    }
    const escorting = input.nurseryEscortActive === true && quest.id === 'the-last-cub';
    const interaction = escorting ? null : objectiveInteraction(input, quest, objective);
    const delivery = input.region?.deliveries?.find(item => objective.requiredEvents.includes(item.movedFactId));
    let target = objectiveDestination(input, quest, objective);
    let cueId: string = objective.id;
    const missing = interaction ? missingFactsOf(input, interaction, delivery?.requiredFacts ?? []) : { facts: [], actors: [] };
    const blocked = missing.facts.length > 0 || missing.actors.length > 0;
    const names = [...new Set(missing.facts.map(fact => prerequisiteTitle(input, fact)).filter((title): title is string => title !== null))];
    let story = objective.description;
    let status: CueStatus = 'approach';
    let actionable: InteractionDefinition | null = interaction && !blocked ? interaction : null;
    let tail: string;
    if (blocked) {
        status = 'blocked';
        const needs = names.length ? names.map(name => `"${name}"`).join(' and ') : missing.actors.length ? 'the missing ally to be present' : 'the earlier steps of this story';
        tail = `Finish ${needs} first. Follow the fireflies to the site.`;
        // A required story choice waiting at its own site is the next honest step: guide there without reordering the quest.
        const pending = input.snapshot.session.resume.pendingChoiceId;
        const site = pending !== null && missing.facts.includes('choice:' + pending) && input.region
            ? input.interactions.find(item => item.regionId === input.snapshot.regionId && item.success.type === 'choice' && item.success.choiceId === pending && !interactionSpent(input.snapshot, item))
            : undefined;
        const sitePosition = site && input.region && missingFactsOf(input, site, []).facts.length === 0 ? interactionPosition(input, input.region, site) : null;
        if (site && sitePosition) {
            target = sitePosition;
            cueId = site.id;
            actionable = site;
            status = input.contextualInteractionId === site.id ? 'ready' : 'approach';
            tail = status === 'ready' ? actionPhrase(site) + '.' : `Follow the fireflies, then ${actionPhrase(site).replace(/^./, c => c.toLowerCase())}.`;
            story = `${objective.description} This waits on "${names[0] ?? site.promptLabel}".`;
        }
    } else if (interaction) {
        if (input.contextualInteractionId === interaction.id) {
            status = 'ready';
            tail = actionPhrase(interaction) + '.';
        } else {
            tail = `Follow the fireflies, then ${actionPhrase(interaction).replace(/^./, c => c.toLowerCase())}.`;
        }
    } else if (escorting) {
        tail = 'Stay close to the cub. Follow the fireflies to the shelter.';
    } else {
        tail = 'Follow the fireflies.';
    }
    return { quest, objective, escorting, action: actionable?.promptLabel ?? null, inputHint: actionable?.inputHint, target, cueId, status, instruction: tail, guidance: `${story} ${tail}` };
}

function bearingOf(input: ObjectiveHudInput, target: Vec3, label: string, hint: string | null): NonNullable<ObjectiveHud['destination']> | null {
    if (!input.player || !input.basis) return null;
    const dx = target.x - input.player.x, dz = target.z - input.player.z;
    const bearing = Math.atan2(dx * input.basis.right.x + dz * input.basis.right.z, dx * input.basis.forward.x + dz * input.basis.forward.z) * 180 / Math.PI;
    return { label, distanceMeters: hint === 'Search the marked area' ? null : Math.hypot(dx, dz), bearingDegrees: bearing, hint };
}

/** 1-based position of an objective among its quest's required objectives; optional objectives have no step. */
function objectiveStep(quest: QuestDefinition, objective: ObjectiveDefinition): { index: number; total: number } | null {
    if (objective.optional) return null;
    const required = quest.objectives.filter(item => !item.optional);
    const index = required.findIndex(item => item.id === objective.id);
    return index < 0 ? null : { index: index + 1, total: required.length };
}

interface ExitGuidance {
    readonly route: RegionRouteDefinition;
    readonly destination: string;
    /** The destination is a later chapter (the story advances) rather than a hub or earned revisit. */
    readonly forward: boolean;
}

/** True while a required quest of this region still has a required active objective: the main objective stays the guide. */
function requiredStoryRemains(input: ObjectiveHudInput): boolean {
    const active = new Set<string>(input.snapshot.activeObjectiveIds);
    return input.snapshot.activeQuestIds.some(questId => {
        const quest = input.quests.find(item => item.id === questId);
        return quest !== undefined && !quest.optional && quest.region === input.snapshot.regionId && quest.objectives.some(item => !item.optional && active.has(item.id));
    });
}

/** The authored route the transition authority (`chapterActOf` → `transitionGateOf`) actually opens, forward destinations first. */
function exitGuidanceOf(input: ObjectiveHudInput): ExitGuidance | null {
    const region = input.region;
    if (!region || region.id !== input.snapshot.regionId) return null;
    const regionName = input.regionName ?? ((id: RegionId) => id);
    const chapters = input.chapters ?? [];
    const act = chapterActOf(region, input.snapshot, regionName, input.quests, chapters);
    if (!act || requiredStoryRemains(input)) return null;
    const projection = projectionOf(input.snapshot);
    const open = region.exits
        .filter(route => act.exits.some(exit => exit.id === route.id && exit.available))
        .map(route => ({ route, destination: regionName(route.destinationRegionId), forward: destinationChapterFor(projection, route.destinationRegionId, chapters) > input.snapshot.chapter }));
    return open.find(item => item.forward) ?? open[0] ?? null;
}

/** Presentation-only beacon at an earned chapter exit; it never travels, completes or unlocks anything. */
export function chapterExitCueOf(input: ObjectiveHudInput): WorldObjectiveCue | null {
    const exit = exitGuidanceOf(input);
    if (!exit) return null;
    return { id: exit.route.id, position: exit.route.from, kind: 'exit', status: input.contextualInteractionId === exit.route.id ? 'ready' : 'approach' };
}

/** Whether the exit, not the tracked objective, is what the player is guided to: a forward earned exit, or any open route with nothing left to track. */
function exitLeads(input: ObjectiveHudInput, hasObjective: boolean): ExitGuidance | null {
    const exit = exitGuidanceOf(input);
    return exit && (exit.forward || !hasObjective) ? exit : null;
}

/** World beacon for the tracked objective, from the same target and context as `objectiveHudOf`; null when an earned exit leads instead. */
export function objectiveCueOf(input: ObjectiveHudInput): WorldObjectiveCue | null {
    const current = trackedActiveObjective(input.snapshot, input.quests);
    if (!current || exitLeads(input, true)) return null;
    const guidance = objectiveGuidanceOf(input, current.quest, current.objective);
    return guidance.target ? { id: guidance.cueId, position: guidance.target, kind: 'objective', status: guidance.status } : null;
}

export function objectiveHudOf(input: ObjectiveHudInput): ObjectiveHud | undefined {
    const current = trackedActiveObjective(input.snapshot, input.quests);
    const exit = exitLeads(input, current !== null);
    if (exit) {
        const ready = input.contextualInteractionId === exit.route.id;
        return {
            chapterLabel: chapterLabelOf(input.snapshot),
            questTitle: exit.forward ? 'Chapter complete' : 'Journey route',
            objectiveTitle: 'Path to ' + exit.destination,
            step: null,
            counter: null,
            interaction: 'Travel to ' + exit.destination,
            interactionInputHint: 'interact',
            guidance: exit.forward
                ? `This chapter is complete and the way to ${exit.destination} is open. ${ready ? 'Press Interact: Travel to ' + exit.destination + '.' : 'Follow the fireflies to the route, then press Interact to travel.'}`
                : `The route to ${exit.destination} is open. ${ready ? 'Press Interact: Travel to ' + exit.destination + '.' : 'Follow the fireflies to the route, then press Interact to travel.'}`,
            status: ready ? 'ready' : 'approach',
            instruction: ready ? 'Use Interact to travel to the next region.' : 'Follow the fireflies to the open exit.',
            destination: bearingOf(input, exit.route.from, 'Path to ' + exit.destination, null),
        };
    }
    if (!current) return undefined;
    const { quest, objective } = current;
    const guided = objectiveGuidanceOf(input, quest, objective);
    let destination: ObjectiveHud['destination'] = null;
    if (guided.target) {
        destination = bearingOf(input, guided.target, objective.title, objective.mechanic === 'investigate' ? 'Search the marked area' : null);
    } else if (input.snapshot.regionId !== input.region?.id) {
        destination = { label: objective.title, distanceMeters: null, bearingDegrees: null, hint: 'Follow the route to the next region' };
    }
    return {
        chapterLabel: chapterLabelOf(input.snapshot),
        questTitle: quest.title,
        objectiveTitle: guided.escorting ? 'Lead the cub to the nursery shelter; stay close' : objective.title,
        step: objectiveStep(quest, objective),
        counter: objective.count && objective.count > 1 ? '0 / ' + objective.count : null,
        interaction: guided.action,
        interactionInputHint: guided.inputHint,
        guidance: guided.guidance,
        instruction: guided.instruction,
        status: guided.status,
        destination,
    };
}

/**
 * The quest log every menu reads: only quests the campaign has started or finished (never future chapters), the current
 * quest first, then main story, then side quests; each objective is done, current (what the HUD tracks), active or upcoming.
 */
export function questLogOf(snapshot: CampaignSnapshot, quests: readonly QuestDefinition[]): QuestLogViewModel {
    const current = trackedActiveObjective(snapshot, quests);
    const active = new Set<string>(snapshot.activeObjectiveIds), done = new Set<string>(snapshot.completedObjectiveIds);
    const entry = (quest: QuestDefinition): QuestLogEntry => ({
        id: quest.id, title: quest.title, description: quest.description, optional: quest.optional,
        objectives: quest.objectives.map(objective => ({
            id: objective.id, title: objective.title, description: objective.description, optional: objective.optional === true,
            state: done.has(objective.id) ? 'done' : objective.id === current?.objective.id ? 'current' : active.has(objective.id) ? 'active' : 'upcoming',
        })),
    });
    const resolve = (ids: readonly string[]) => ids.map(id => quests.find(quest => quest.id === id)).filter((quest): quest is QuestDefinition => quest !== undefined);
    const rank = (quest: QuestDefinition) => quest.id === current?.quest.id ? 0 : quest.optional ? 2 : 1;
    return {
        currentQuestId: current?.quest.id ?? null,
        currentObjectiveId: current?.objective.id ?? null,
        active: resolve(snapshot.activeQuestIds).sort((a, b) => rank(a) - rank(b)).map(entry),
        completed: resolve(snapshot.completedQuestIds).map(entry),
    };
}

/** What opens a locked exit, named by the objective whose completion sets its unlock fact. */
export function exitRequirement(unlockFact: string, quests: readonly QuestDefinition[]): string {
    const objective = quests.flatMap(quest => quest.objectives).find(item => item.requiredEvents.includes(unlockFact));
    return objective ? `Requires: ${objective.title}` : 'Locked until its story requirements are met.';
}

/**
 * Exits of the current region with an honest availability.
 *
 * A route is offered only when it is actually earned: its authored unlock fact must hold, the current segment's own
 * exit requirements must be met and the destination must be within the reached chapters. The same transition authority
 * the Director uses answers the question, so the region survey can never offer a route the journey would refuse.
 */
export function chapterActOf(region: RegionDefinition | null, snapshot: CampaignSnapshot, regionName: (id: RegionId) => string, quests: readonly QuestDefinition[], chapters: readonly ChapterRuntimeDefinition[] = []): NonNullable<GameViewModel['chapterAct']> | undefined {
    if (!region || region.id !== snapshot.regionId) return undefined;
    const projection = projectionOf(snapshot);
    const segment = currentSegmentOf(projection, chapters);
    const exits = region.exits.map(route => {
        const unlocked = !route.unlockFact || snapshot.worldFacts[route.unlockFact] === true;
        if (!unlocked) {
            return { id: route.id, label: regionName(route.destinationRegionId), available: false, reason: exitRequirement(route.unlockFact!, quests) };
        }
        const destinationChapter = destinationChapterFor(projection, route.destinationRegionId, chapters);
        const gate = transitionGateOf({
            projection,
            destinationRegionId: route.destinationRegionId,
            destinationChapter,
            exitRequirements: segment?.exitRequirements ?? [],
            routeDiscovered: true,
        });
        return {
            id: route.id,
            label: regionName(route.destinationRegionId),
            available: gate.allowed,
            reason: gate.reason,
        };
    });
    return { exits, actTwoNotice: null };
}

const GRID_STEPS = [5, 10, 20, 25, 50, 100];
const MAP_PADDING_METERS = 6;

/**
 * Top-down survey map of the loaded region, projected so screen-up is the camera's forward direction (what "ahead" means
 * in play). Ground surfaces and trails come from the region's authored geometry; markers are the current objective, the
 * other active objectives that resolve here, and every exit with its requirement. Every point carries a survey grid code.
 */
export function areaMapOf(input: ObjectiveHudInput & { readonly regionName: (id: RegionId) => string; readonly playerFacing: Vec3 | null }): AreaMapViewModel | undefined {
    const region = input.region;
    if (!region || region.id !== input.snapshot.regionId) return undefined;
    const basis = input.basis ?? { forward: { x: 0, z: -1 }, right: { x: 1, z: 0 } };
    const project = (p: { x: number; z: number }): AreaMapPoint => ({ u: p.x * basis.right.x + p.z * basis.right.z, v: p.x * basis.forward.x + p.z * basis.forward.z });
    const surfaces = region.ground.surfaces.filter(surface => surface.points.length >= 3)
        .map(surface => ({ id: surface.id, water: surface.profile === 'water', points: surface.points.map(project) }));
    const nodes = new Map(region.navigation.nodes.map(node => [node.id, node] as const));
    const seen = new Set<string>();
    const paths: [AreaMapPoint, AreaMapPoint][] = [];
    for (const node of region.navigation.nodes) for (const link of node.links) {
        const other = nodes.get(link);
        const key = [node.id, link].sort().join('|');
        if (!other || seen.has(key)) continue;
        seen.add(key);
        paths.push([project(node.position), project(other.position)]);
    }
    const current = trackedActiveObjective(input.snapshot, input.quests);
    const placed: { id: string; kind: 'current' | 'objective' | 'exit'; label: string; available: boolean; detail: string | null; at: AreaMapPoint }[] = [];
    if (current) {
        const target = objectiveGuidanceOf(input, current.quest, current.objective).target;
        if (target) placed.push({ id: current.objective.id, kind: 'current', label: current.objective.title, available: true, detail: current.quest.title, at: project(target) });
    }
    const active = new Set<string>(input.snapshot.activeObjectiveIds);
    for (const questId of input.snapshot.activeQuestIds) {
        const quest = input.quests.find(item => item.id === questId);
        for (const objective of quest?.objectives ?? []) {
            if (!quest || !active.has(objective.id) || objective.id === current?.objective.id) continue;
            const target = objectiveDestination(input, quest, objective);
            if (target) placed.push({ id: objective.id, kind: 'objective', label: objective.title, available: true, detail: quest.title, at: project(target) });
        }
    }
    for (const route of region.exits) {
        const open = !route.unlockFact || input.snapshot.worldFacts[route.unlockFact] === true;
        placed.push({ id: route.id, kind: 'exit', label: 'To ' + input.regionName(route.destinationRegionId), available: open, detail: open || !route.unlockFact ? 'Open' : exitRequirement(route.unlockFact, input.quests), at: project(route.from) });
    }
    const playerAt = input.player ? project(input.player) : null;
    const all = [...surfaces.flatMap(surface => surface.points), ...paths.flat(), ...placed.map(marker => marker.at), ...(playerAt ? [playerAt] : [])];
    if (!all.length) return undefined;
    const rawMinU = Math.min(...all.map(p => p.u)) - MAP_PADDING_METERS, rawMaxU = Math.max(...all.map(p => p.u)) + MAP_PADDING_METERS;
    const rawMinV = Math.min(...all.map(p => p.v)) - MAP_PADDING_METERS, rawMaxV = Math.max(...all.map(p => p.v)) + MAP_PADDING_METERS;
    const gridStep = GRID_STEPS.find(step => Math.max(rawMaxU - rawMinU, rawMaxV - rawMinV) / step <= 10) ?? GRID_STEPS[GRID_STEPS.length - 1]!;
    // The sheet always ends on a grid line: widen each axis, centred, to a whole number of squares.
    const extraU = (Math.ceil((rawMaxU - rawMinU) / gridStep) * gridStep - (rawMaxU - rawMinU)) / 2;
    const extraV = (Math.ceil((rawMaxV - rawMinV) / gridStep) * gridStep - (rawMaxV - rawMinV)) / 2;
    const minU = rawMinU - extraU, maxU = rawMaxU + extraU, minV = rawMinV - extraV, maxV = rawMaxV + extraV;
    const grid = (p: AreaMapPoint) => String.fromCharCode(65 + Math.min(25, Math.floor((p.u - minU) / gridStep))) + String(1 + Math.floor((maxV - p.v) / gridStep));
    const facing = input.playerFacing;
    const headingDegrees = facing ? Math.atan2(facing.x * basis.right.x + facing.z * basis.right.z, facing.x * basis.forward.x + facing.z * basis.forward.z) * 180 / Math.PI : 0;
    return {
        regionName: region.name,
        bounds: { minU, maxU, minV, maxV },
        gridStep,
        surfaces,
        paths,
        player: playerAt ? { ...playerAt, headingDegrees, grid: grid(playerAt) } : null,
        markers: placed.map(marker => ({ ...marker, grid: grid(marker.at) })),
    };
}

/** Boss body variants an encounter's phases render (Koro Branchbreaker, Orun's crowned beast): loaded before the encounter starts. */
export function encounterVariantAssets(encounterId: string): readonly { readonly actorId: ActorId; readonly assetId: string }[] {
    const definition = BOSS_ENCOUNTERS[encounterId] ?? WILDLIFE_ENCOUNTERS[encounterId];
    if (!definition) return [];
    const assetIds = [...new Set(definition.phases.flatMap(phase => phase.actorVariantId ? [phase.actorVariantId] : []))];
    return assetIds.map(assetId => ({ actorId: definition.bossId, assetId }));
}