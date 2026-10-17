import type { CampaignSnapshot, CompanionId, GameViewModel } from '../game/contracts.js';

const NAMES: Readonly<Record<CompanionId, string>> = { vara: 'Vara', koro: 'Koro', asha: 'Asha', sable: 'Sable', nyra: 'Nyra', solkar: 'Solkar' };

export const companionDisplayName = (id: CompanionId): string => NAMES[id];

/**
 * One traveling companion, independent of narrative Bond. Explicit exile and active encounters still constrain replacement.
 */
export function partyPanelOf(snapshot: CampaignSnapshot, encounterActive: boolean): NonNullable<GameViewModel['partyPanel']> {
    const { party } = snapshot;
    const crown = snapshot.campaign.world.factions.crown;
    return {
        companionId: party.companionId ?? null,
        name: 'Traveling companion',
        options: (Object.keys(NAMES) as CompanionId[]).map(id => {
            const reason = encounterActive ? 'The companion cannot change during an active encounter.'
                : id === 'solkar' && crown.leaderStatus === 'exiled' ? 'Solkar left after your exile decision.' : null;
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
