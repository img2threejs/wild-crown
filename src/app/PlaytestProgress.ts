import { ASSET_PLAYTESTS } from './AssetPlaytests.js';

export const PLAYTEST_PROGRESS_KEY = 'wild-crown.playtest-progress.v1';
/** Local playtest clears are independent of campaign saves and replay rewards. */
export class PlaytestProgress {
    private readonly cleared = new Set<string>();
    warning: string | undefined;

    constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null) {
        if (!storage) { this.warning = 'Progress storage is unavailable. Map unlocks last only for this visit.'; return; }
        try {
            const saved: unknown = JSON.parse(storage.getItem(PLAYTEST_PROGRESS_KEY) ?? 'null');
            if (!saved || typeof saved !== 'object' || !('cleared' in saved) || !Array.isArray(saved.cleared)) return;
            // Only a contiguous sequence counts: a later map cannot unlock its predecessor.
            for (const map of ASSET_PLAYTESTS) {
                if (!saved.cleared.includes(map.id)) break;
                this.cleared.add(map.id);
            }
        } catch { this.warning = 'Saved map progress could not be read. Begin with Greenwake.'; }
    }

    isCleared(id: string): boolean { return this.cleared.has(id); }
    isUnlocked(id: string): boolean {
        const index = ASSET_PLAYTESTS.findIndex(map => map.id === id);
        return index === 0 || index > 0 && this.cleared.has(ASSET_PLAYTESTS[index - 1]!.id);
    }
    complete(id: string): void {
        if (!this.isUnlocked(id)) return;
        this.cleared.add(id);
        if (!this.storage) return;
        try {
            this.storage.setItem(PLAYTEST_PROGRESS_KEY, JSON.stringify({ cleared: [...this.cleared] }));
            this.warning = undefined;
        } catch { this.warning = 'Map cleared, but progress could not be saved. Unlocks last only for this visit.'; }
    }
}

export function browserPlaytestProgress(): PlaytestProgress {
    try { return new PlaytestProgress(window.localStorage); }
    catch { return new PlaytestProgress(null); }
}
