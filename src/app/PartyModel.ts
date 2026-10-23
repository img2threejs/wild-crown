import type { CampaignSnapshot, CompanionId, GameViewModel } from '../game/contracts.js';
import { companionAccess } from '../game/campaign/access.js';

const NAMES: Readonly<Record<CompanionId, string>> = { vara: 'Vara', koro: 'Koro', asha: 'Asha', sable: 'Sable', nyra: 'Nyra', solkar: 'Solkar' };

export const companionDisplayName = (id: CompanionId): string => NAMES[id];

/**
 * One traveling companion, independent of narrative Bond.
 *
 * Only an earned companion may be equipped: the shared access authority reads the committed recruitment state and the
 * narrative constraints that remove a companion from the journey, so an unrecruited or exiled companion is listed as
 * unavailable with its reason instead of being offered as a choice. An active encounter still blocks a replacement.
 */
export function partyPanelOf(snapshot: CampaignSnapshot, encounterActive: boolean): NonNullable<GameViewModel['partyPanel']> {
    const { party } = snapshot;
    return {
        companionId: party.companionId ?? null,
        name: 'Traveling companion',
        options: (Object.keys(NAMES) as CompanionId[]).map(id => {
            const access = companionAccess(snapshot, id);
            const reason = encounterActive
                ? 'The companion cannot change during an active encounter.'
                : access.reason;
            return { companionId: id, name: NAMES[id], available: reason === null, reason };
        }),
    };
}

/** Individual Bond/Dominion (0–100) and recruitment of every companion; faction covenants stay in the relationships section. */
export function companionProgressOf(snapshot: CampaignSnapshot): NonNullable<GameViewModel['companionProgress']> {
    const entries = (Object.keys(NAMES) as CompanionId[]).map(id => {
        const progress = snapshot.companions[id];
        return [id, { name: NAMES[id], recruited: progress?.recruited ?? false, bond: progress?.bondLevel ?? 0, dominion: progress?.dominionLevel ?? 0 }] as const;
    });
    return Object.fromEntries(entries) as NonNullable<GameViewModel['companionProgress']>;
}
