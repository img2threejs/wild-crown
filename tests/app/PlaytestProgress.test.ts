import { describe, expect, it } from 'bun:test';
import { PlaytestProgress, PLAYTEST_PROGRESS_KEY } from '../../src/app/PlaytestProgress.js';
import { assetPlaytestFromSearch } from '../../src/app/AssetPlaytests.js';

function storage(initial: string | null = null) {
  const data = new Map<string, string>();
  if (initial !== null) data.set(PLAYTEST_PROGRESS_KEY, initial);
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}

describe('local sequential map progression', () => {
  it('keeps Canopy locked until Greenwake clears and restores the unlock on reload', () => {
    const saved = storage(), progress = new PlaytestProgress(saved);
    expect(progress.isUnlocked('greenwake')).toBe(true);
    expect(progress.isUnlocked('canopy')).toBe(false);
    progress.complete('canopy');
    expect(progress.isCleared('canopy')).toBe(false);
    progress.complete('greenwake');
    expect(new PlaytestProgress(saved).isUnlocked('canopy')).toBe(true);
    progress.complete('canopy');
    const reloaded = new PlaytestProgress(saved);
    expect(reloaded.isCleared('greenwake')).toBe(true);
    expect(reloaded.isCleared('canopy')).toBe(true);
    expect(reloaded.isUnlocked('unknown')).toBe(false);
  });
  it('does not accept out-of-order clears or corrupted storage', () => {
    for (const value of ['{', '{"cleared":["canopy"]}', '{"cleared":["unknown"]}', '{"cleared":null}', 'null']) {
      const progress = new PlaytestProgress(storage(value));
      expect(progress.isUnlocked('greenwake')).toBe(true);
      expect(progress.isUnlocked('canopy')).toBe(false);
    }
  });
  it('retains in-memory unlocks and warns when persistent storage is unavailable', () => {
    const unavailable = new PlaytestProgress(null);
    unavailable.complete('greenwake');
    expect(unavailable.isUnlocked('canopy')).toBe(true);
    expect(unavailable.warning).toContain('unavailable');
    const denied = new PlaytestProgress({ getItem: () => null, setItem: () => { throw new Error('denied'); } });
    denied.complete('greenwake');
    expect(denied.isUnlocked('canopy')).toBe(true);
    expect(denied.warning).toContain('could not be saved');
  });
  it('treats a direct Canopy URL as a preference, not progression authority', () => {
    expect(assetPlaytestFromSearch('?assetPlaytest=canopy')?.id).toBe('canopy');
    expect(assetPlaytestFromSearch('?assetPlaytest=unknown')?.id).toBe('greenwake');
    expect(new PlaytestProgress(storage()).isUnlocked('canopy')).toBe(false);
    expect(assetPlaytestFromSearch('?other=value')).toBeNull();
  });
});
