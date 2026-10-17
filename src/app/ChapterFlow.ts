import type {
    ActorId, ActorSnapshot, AreaMapPoint, AreaMapViewModel, CampaignSnapshot, ChapterRuntimeDefinition, ChapterSegmentId, GameViewModel, InteractionDefinition, MovableObjectSnapshot, ObjectiveDefinition, QuestDefinition, QuestLogEntry, QuestLogViewModel, RegionDefinition, RegionId, Vec3,
} from '../game/contracts.js';
import { BOSS_ENCOUNTERS, WILDLIFE_ENCOUNTERS } from '../game/combat/content.js';
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

export function objectiveTargetPosition(
    objective: ObjectiveDefinition, region: RegionDefinition, actors: readonly ActorSnapshot[], interactions: readonly InteractionDefinition[], runtime: ChapterRuntimeDefinition | undefined,
): Vec3 | null {
    const lookup = (id: string): Vec3 | null => {
        const actor = actors.find(item => item.id === id && item.visible) ?? actors.find(item => item.archetypeId === id && item.visible);
        if (actor) return actor.position;
        const entity = region.entities.find(item => item.id === id || item.interactionId === id);
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
        const interaction = interactions.find(item => item.id === targetId && item.regionId === region.id);
        const viaInteraction = interaction ? lookup(interaction.targetId) : null;
        if (viaInteraction) return viaInteraction;
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
}

/** Where the given objective currently sends the player in the loaded region (escort shelter, carried delivery, or its target), or null. */
function objectiveDestination(input: ObjectiveHudInput, quest: QuestDefinition, objective: ObjectiveDefinition): Vec3 | null {
    if (!input.region || input.region.id !== input.snapshot.regionId) return null;
    if (input.nurseryEscortActive === true && quest.id === 'the-last-cub') return NURSERY_ESCORT.to;
    const delivery = input.region.deliveries?.find(item => objective.requiredEvents.includes(item.movedFactId));
    if (delivery) return input.movableObjects.some(item => item.objectId === delivery.id && item.phase === 'in-flight') ? delivery.to : delivery.from;
    return objectiveTargetPosition(objective, input.region, input.actors, input.interactions, input.runtime);
}

/** 1-based position of an objective among its quest's required objectives; optional objectives have no step. */
function objectiveStep(quest: QuestDefinition, objective: ObjectiveDefinition): { index: number; total: number } | null {
    if (objective.optional) return null;
    const required = quest.objectives.filter(item => !item.optional);
    const index = required.findIndex(item => item.id === objective.id);
    return index < 0 ? null : { index: index + 1, total: required.length };
}

export function objectiveHudOf(input: ObjectiveHudInput): NonNullable<GameViewModel['objectiveHud']> | undefined {
    const current = trackedActiveObjective(input.snapshot, input.quests);
    if (!current) return undefined;
    const { quest, objective } = current;
    const escorting = input.nurseryEscortActive === true && quest.id === 'the-last-cub';
    const delivery = input.region?.deliveries?.find(item => objective.requiredEvents.includes(item.movedFactId));
    const carrying = delivery && input.movableObjects.some(item => item.objectId === delivery.id && item.phase === 'in-flight');
    const interaction = input.interactions.find(item => item.regionId === input.snapshot.regionId && (delivery
        ? item.id === (carrying ? delivery.deliveryInteractionId : delivery.pickupInteractionId)
        : objective.requiredEvents.includes('interaction:' + item.id) || objective.targetIds.includes(item.id)));
    let destination: NonNullable<GameViewModel['objectiveHud']>['destination'] = null;
    const target = objectiveDestination(input, quest, objective);
    if (target && input.player && input.basis) {
        const dx = target.x - input.player.x, dz = target.z - input.player.z;
        const bearing = Math.atan2(dx * input.basis.right.x + dz * input.basis.right.z, dx * input.basis.forward.x + dz * input.basis.forward.z) * 180 / Math.PI;
        destination = objective.mechanic === 'investigate'
            ? { label: objective.title, distanceMeters: null, bearingDegrees: bearing, hint: 'Search the marked area' }
            : { label: objective.title, distanceMeters: Math.hypot(dx, dz), bearingDegrees: bearing, hint: null };
    } else if (!target && input.snapshot.regionId !== input.region?.id) {
        destination = { label: objective.title, distanceMeters: null, bearingDegrees: null, hint: 'Follow the route to the next region' };
    }
    return {
        chapterLabel: chapterLabelOf(input.snapshot),
        questTitle: quest.title,
        objectiveTitle: escorting ? 'Lead the cub to the nursery shelter; stay close' : objective.title,
        step: objectiveStep(quest, objective),
        counter: objective.count && objective.count > 1 ? '0 / ' + objective.count : null,
        interaction: escorting ? null : interaction?.promptLabel ?? null,
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

/** Exits of the current region with an honest availability: gated only by authored unlock facts. */
export function chapterActOf(region: RegionDefinition | null, snapshot: CampaignSnapshot, regionName: (id: RegionId) => string, quests: readonly QuestDefinition[]): NonNullable<GameViewModel['chapterAct']> | undefined {
    if (!region || region.id !== snapshot.regionId) return undefined;
    const exits = region.exits.map(route => {
        const unlocked = !route.unlockFact || snapshot.worldFacts[route.unlockFact] === true;
        return { id: route.id, label: regionName(route.destinationRegionId), available: unlocked, reason: unlocked || !route.unlockFact ? null : exitRequirement(route.unlockFact, quests) };
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
        const target = objectiveDestination(input, current.quest, current.objective);
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