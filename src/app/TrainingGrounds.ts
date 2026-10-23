import type {
  AssetPolicy,
  CampaignSnapshot,
  CombatSnapshot,
  GameViewModel,
  RegionId,
  SessionConfig,
  Vec3,
} from '../game/contracts.js';
import { assetPolicyForScope } from '../game/contracts.js';
import { CampaignDirector } from '../game/campaign/CampaignDirector.js';
import { projectionOf, requirementMetOf, type AccessProjection } from '../game/campaign/access.js';
import { CHAPTER_RUNTIME } from '../content/chapters.js';
import { REGIONS } from '../content/campaign.js';
import { ASSET_PLAYTESTS, type AssetPlaytest } from './AssetPlaytests.js';
import { trainingSession } from './SessionConfig.js';

/**
 * Training Grounds: the player's earned practice access and its isolated practice Director.
 *
 * Every decision here reads the authored campaign authority — the authored chapter runtime's exit requirements, the
 * committed quest, objective, beat and choice history, the authored region restoration state and the authored safe
 * checkpoints — and nothing else. There is no second unlock ledger: a map becomes practiceable exactly when the
 * story has cleared that region's authored main requirements, and it stays practiceable across later chapters, hub
 * visits and return journeys.
 *
 * The practice Director is replay-isolated: it owns no save repository, it copies the source journey's earned data by
 * value, it invents no recruitment, Bond, Dominion or history, and it never writes back to the source.
 */

/** One Training Grounds map as the player sees it: the authored playtest's own name, thumbnail and region. */
export type TrainingMapChoice = NonNullable<GameViewModel['training']>['maps'][number];

/** The player-facing result of starting a practice session. */
export interface TrainingPractice {
    readonly director: CampaignDirector;
    readonly snapshot: CampaignSnapshot;
    readonly session: Extract<SessionConfig, { kind: 'training' }>;
}

/** The five authored practice maps, in authored order, each with the region its content lives in. */
const TRAINING_MAPS: readonly AssetPlaytest[] = ASSET_PLAYTESTS;

/**
 * The authored chapter runtime segments of every region, grouped once at module load.
 *
 * The grouping holds the authored definitions themselves, so a decision reads the same segment data the Director
 * reads when it gates a chapter transition: a hub visit or a return corridor carries no exit requirements and
 * therefore clears nothing, while a region's story segment carries exactly the main requirements the story earned.
 */
const SEGMENTS_OF_REGION: Readonly<Partial<Record<RegionId, readonly (typeof CHAPTER_RUNTIME)[number][]>>> = (() => {
    const grouped: Partial<Record<RegionId, (typeof CHAPTER_RUNTIME)[number][]>> = {};
    for (const definition of CHAPTER_RUNTIME) {
        const existing = grouped[definition.regionId];
        if (existing) existing.push(definition);
        else grouped[definition.regionId] = [definition];
    }
    return grouped;
})();

/**
 * Whether the journey has cleared the authored story of a region.
 *
 * A region is cleared when every authored segment that carries exit requirements has all of them met. Those
 * requirements are the region's own authored main-story gate — the main quests, the choices, the story beats and the
 * restoration the segment itself demands before the journey may leave it — so a cleared region means the region's
 * encounters and main requirements were committed, not merely visited.
 *
 * A segment without exit requirements (the sanctuary's ordinary visit, the chapter-7 return corridors) clears
 * nothing on its own, so a visited hub never unlocks a map and a later return journey never relocks an earned one.
 */
function regionStoryClearedOf(projection: AccessProjection, regionId: RegionId): boolean {
    const segments = SEGMENTS_OF_REGION[regionId];
    if (!segments) return false;
    let gated = false;
    for (const segment of segments) {
        const requirements = segment.exitRequirements;
        if (!requirements.length) continue;
        gated = true;
        for (const requirement of requirements) {
            if (!requirementMetOf(projection, requirement)) return false;
        }
    }
    return gated;
}

/**
 * Whether the journey has cleared the authored story of a region, read from a published snapshot.
 *
 * The Greenwake map, for instance, stays closed until the corrupted boar is actually cleansed and the settlement
 * gate is opened, and the Canopy map stays closed until Koro is cleansed and the Canopy is restored — a player who
 * merely stands in either region has cleared neither.
 */
export function regionStoryCleared(snapshot: CampaignSnapshot, regionId: RegionId): boolean {
    return regionStoryClearedOf(projectionOf(snapshot), regionId);
}

/**
 * The reason a map stays closed. The player can act on it: it names the region's story, not a generic sentence.
 */
function lockReasonOf(map: AssetPlaytest): string {
    const region = REGIONS.find((item) => item.id === map.regionId);
    return `Finish the ${region?.name ?? map.name} story to unlock ${map.name} practice.`;
}

/**
 * Whether the player stands at one of the region's authored safe points.
 *
 * A safe point is an authored checkpoint of the current region whose own prerequisites the journey has met. The
 * checkpoint's authored radius is the reach the story itself commits it with, so the player must stand inside it: a
 * distant floor or a far ledge is not a practice spot, and no extra tolerance is invented on top of the authored
 * radius. A boss arena's pre-fight spawn is excluded, so practice never begins inside an encounter.
 */
function atSafePoint(snapshot: CampaignSnapshot, player: Vec3): boolean {
    const region = REGIONS.find((item) => item.id === snapshot.regionId);
    if (!region) return false;
    const segments = SEGMENTS_OF_REGION[snapshot.regionId];
    if (!segments) return false;
    for (const segment of segments) {
        for (const checkpoint of segment.checkpoints) {
            if (checkpoint.encounterId !== null) continue;
            let unmet = false;
            for (const fact of checkpoint.requiresFacts) {
                if (snapshot.worldFacts[fact] !== true) { unmet = true; break; }
            }
            if (unmet) continue;
            for (const node of region.navigation.nodes) {
                if (node.id !== checkpoint.nodeId) continue;
                const distance = Math.hypot(
                    player.x - node.position.x,
                    player.y - node.position.y,
                    player.z - node.position.z,
                );
                if (distance <= checkpoint.radius) return true;
                break;
            }
        }
    }
    return false;
}

/**
 * Whether the journey has earned at least one practice map.
 *
 * The loop walks the authored maps and stops at the first cleared region; it allocates no map list, so a render that
 * asks for the entry reason pays nothing for the map model it does not need.
 */
function anyRegionCleared(projection: AccessProjection): boolean {
    for (const map of TRAINING_MAPS) {
        if (regionStoryClearedOf(projection, map.regionId)) return true;
    }
    return false;
}

/**
 * Why the player may not enter Training Grounds right now, or `null` when the entry is allowed.
 *
 * The app guards the busy queues, the dialogue, the tutorial and the screen; this answers the part only the campaign
 * and the live world know: whether the journey stands at a safe, authored point of a real chapter, outside every
 * encounter and required story beat, and has already earned at least one map to practise.
 */
export function trainingEntryReason(snapshot: CampaignSnapshot, combat: CombatSnapshot): string | null {
    if (snapshot.replay) return 'Training Grounds need your campaign journey, not a replay or another practice session.';
    if (snapshot.session.resume.activeEncounterId !== null) return 'Finish the encounter before practicing.';
    if (combat.encounterId !== undefined) return 'Finish the encounter before practicing.';
    if (combat.encounterStatus !== undefined) return 'Finish the encounter before practicing.';
    if (combat.nurseryEscortActive === true || combat.dodgePractice?.active === true) return 'Finish the current activity before practicing.';
    const player = combat.actors.find((actor) => actor.id === 'aren');
    if (!player || !player.visible || player.downed) return 'Return to your hero before practicing.';
    if (player.jumpPhase !== undefined) return 'Land before entering Training Grounds.';
    if (snapshot.session.resume.requiredBeatQueue.length > 0) return 'Finish the current story beat before practicing.';
    if (snapshot.session.resume.dialogue !== null) return 'Finish the current dialogue before practicing.';
    if (snapshot.session.resume.pendingChoiceId !== null) return 'Resolve the pending choice before practicing.';
    const projection = projectionOf(snapshot);
    if (!anyRegionCleared(projection)) return 'Clear a region story to earn Training Grounds practice.';
    if (!atSafePoint(snapshot, player.position)) {
        return 'Pause at a safe checkpoint or visit a sanctuary to enter Training Grounds.';
    }
    return null;
}

/**
 * The maps this journey may practice, in authored order.
 *
 * A map is unlocked when the journey has cleared that region's authored story: its main requirements are committed,
 * not merely visited. A locked map carries the reason the player can act on.
 */
export function trainingMapsOf(snapshot: CampaignSnapshot): TrainingMapChoice[] {
    const projection = projectionOf(snapshot);
    return TRAINING_MAPS.map((map) => {
        const unlocked = regionStoryClearedOf(projection, map.regionId);
        return {
            id: map.id,
            name: map.name,
            regionId: map.regionId,
            unlocked,
            reason: unlocked ? null : lockReasonOf(map),
            thumbnailUrl: map.thumbnailUrl,
        };
    });
}

/**
 * Creates the isolated practice Director for one earned map.
 *
 * The practice Director owns no save repository, so it can never write a campaign save; it starts from the source
 * journey's earned data by value and never mutates the source. The session keeps the journey's own asset policy and
 * save scope: a practice session may never widen or narrow the assets the journey plays with, and an asset policy
 * that does not match the journey's scope is refused independently of the journey's own policy.
 */
export function createTrainingDirector(
    source: CampaignSnapshot,
    mapId: string,
    assets: AssetPolicy,
): TrainingPractice {
    const map = TRAINING_MAPS.find((item) => item.id === mapId);
    if (!map) throw new Error('Unknown Training Grounds map.');
    if (source.replay) throw new Error('Training Grounds need a campaign journey, not a replay.');
    if (assets !== source.session.assetPolicy) {
        throw new Error('Training Grounds practice keeps the journey\'s own asset policy.');
    }
    if (assets !== assetPolicyForScope(source.session.saveScope)) {
        throw new Error('Training Grounds practice keeps the journey\'s own save scope.');
    }
    if (!regionStoryCleared(source, map.regionId)) {
        throw new Error(lockReasonOf(map));
    }
    const director = new CampaignDirector({ saveScope: source.session.saveScope, chapters: CHAPTER_RUNTIME });
    const runId = `training-${map.id}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
    const snapshot = director.startPracticeRun({ runId, source, regionId: map.regionId });
    return { director, snapshot, session: trainingSession(map.id, assets) };
}
