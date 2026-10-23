import { AREN_HERO_ASSET_ID, YARA_HERO_ASSET_ID } from '../game/heroes';

/**
 * Clips that play a Mixamo take exactly as delivered (scripts/assets/author-yara-hero-clips.mjs and scripts/assets/retarget-aren-tripo-clips.mjs `exact`
 * specs): the runtime limb-clearance solver and the attack-posture staging leave them alone, so the game shows the same arms as the source. The lists must
 * match the `exact: true` clips of each asset's provenance.json / retarget report.
 */
const EXACT_TAKES: Readonly<Record<string, ReadonlySet<string>>> = {
  [YARA_HERO_ASSET_ID]: new Set([
    'aren-idle', 'aren-forward-left-dive-roll',
    'yara-thornshot-1', 'yara-thornshot-2', 'yara-thornshot-3',
    'yara-root-spike', 'yara-root-charge', 'yara-root-eruption',
    'yara-seed-charge', 'yara-sap-lance', 'yara-seed-storm',
    'yara-binding-vines', 'yara-cleanse', 'yara-heartroot-bloom',
  ]),
  [AREN_HERO_ASSET_ID]: new Set([
    'aren-idle',
    'aren-light-1', 'aren-light-2', 'aren-light-3', 'aren-light-4',
    'aren-heavy', 'aren-charged-heavy-charge', 'aren-charged-heavy',
    'aren-sigil-charge', 'aren-sigil-bolt', 'aren-sigil-barrage',
    'aren-root-tether', 'aren-cleanse', 'aren-judgement',
  ]),
};

export function playsExactTake(assetId: string, clipId: string | undefined): boolean {
  return clipId !== undefined && EXACT_TAKES[assetId]?.has(clipId) === true;
}

export function exactTakeClips(assetId: string): readonly string[] {
  return [...(EXACT_TAKES[assetId] ?? [])];
}
