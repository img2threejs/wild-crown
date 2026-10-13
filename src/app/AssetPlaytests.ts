import type { GameViewModel, RegionId } from '../game/contracts.js';
import type { ShowcaseRegionId } from '../game/campaign/CampaignDirector.js';
import { CANOPY_TRIAL_SET, GREENWAKE_TRIAL_SET, type CombatTrialSet } from '../game/combat/CombatTrials.js';
import { GROVE_TRIAL_SET } from '../game/combat/GroveContent.js';
import { MISTVEIL_TRIAL_SET } from '../game/combat/MistveilContent.js';
import { MOONPINE_TRIAL_SET } from '../game/combat/MoonpineContent.js';

export type AssetPlaytestId = 'greenwake' | 'canopy' | 'grove' | 'moonpine' | 'mistveil';

/**
 * A DEV-only real-asset playtest (`?assetPlaytest=<id>`): one region variant, its candidate asset manifest and the
 * combat-trial set it hosts. Playtests never grant campaign rewards and never change production asset gating.
 */
export interface AssetPlaytest {
  readonly id: AssetPlaytestId;
  /** Display name used in gate errors. */
  readonly name: string;
  readonly regionId: RegionId;
  readonly manifestUrl: string;
  readonly manifestLabel: string;
  readonly banner: string;
  readonly trialSet: CombatTrialSet;
  /** Authored route whose start is the stage goal ring. */
  readonly exitRouteId: string;
  readonly loadingLabel: string;
  /**
   * Set when New Game enters the region directly through the campaign director's replay-isolated showcase start (no opening
   * cinematic); unset for the regular Greenwake run with its opening vision.
   */
  readonly showcaseRegionId?: ShowcaseRegionId;
  /** Map-select image: a capture of the actual playtest scene. */
  readonly thumbnailUrl: string;
  /** Wording for the HUD destination, the trial-complete hint and the stage-complete screen. */
  readonly stage: NonNullable<GameViewModel['playtestStage']>;
}

const banner = (name: string) => `LOCAL PLAYTEST · GENERATED GLB CANDIDATES · NOT RELEASE-VERIFIED · ${name.toUpperCase()} ONLY`;

export const GREENWAKE_PLAYTEST: AssetPlaytest = {
  id: 'greenwake', name: 'Greenwake', regionId: 'greenwake',
  manifestUrl: '/asset-source/playtests/greenwake.json', manifestLabel: 'Greenwake candidate asset playtest manifest',
  banner: banner('Greenwake'), thumbnailUrl: '/asset-source/ui/maps/greenwake.jpg',
  trialSet: GREENWAKE_TRIAL_SET, exitRouteId: 'greenwake-grove-out', loadingLabel: 'Beginning the Greenwake encounter',
  stage: { exitName: 'Forest Exit', completeKicker: 'THE FOREST OPENS', completeCopy: 'You reached the Greenwake forest exit.' },
};
export const CANOPY_PLAYTEST: AssetPlaytest = {
  id: 'canopy', name: 'Whispering Canopy', regionId: 'whispering-canopy',
  manifestUrl: '/asset-source/playtests/canopy.json', manifestLabel: 'Whispering Canopy candidate asset playtest manifest',
  banner: banner('Whispering Canopy'), thumbnailUrl: '/asset-source/ui/maps/whispering-canopy.jpg',
  trialSet: CANOPY_TRIAL_SET, exitRouteId: 'canopy-trial-exit', loadingLabel: 'Beginning the Whispering Canopy trials', showcaseRegionId: 'whispering-canopy',
  stage: { exitName: 'Temple Exit', completeKicker: 'THE CANOPY OPENS', completeCopy: 'You reached the Whispering Canopy temple exit.' },
};
export const GROVE_PLAYTEST: AssetPlaytest = {
  id: 'grove', name: 'The Grove', regionId: 'the-grove',
  manifestUrl: '/asset-source/playtests/grove.json', manifestLabel: 'The Grove candidate asset playtest manifest',
  banner: banner('The Grove'), thumbnailUrl: '/asset-source/ui/maps/the-grove.jpg',
  trialSet: GROVE_TRIAL_SET, exitRouteId: 'grove-trial-exit', loadingLabel: 'Returning to the Grove', showcaseRegionId: 'the-grove',
  stage: { exitName: 'Ridge Trail', completeKicker: 'THE SANCTUARY GROWS', completeCopy: 'You set out from the Grove toward Moonpine Ridge.' },
};
export const MOONPINE_PLAYTEST: AssetPlaytest = {
  id: 'moonpine', name: 'Moonpine Ridge', regionId: 'moonpine-ridge',
  manifestUrl: '/asset-source/playtests/moonpine.json', manifestLabel: 'Moonpine Ridge candidate asset playtest manifest',
  banner: banner('Moonpine Ridge'), thumbnailUrl: '/asset-source/ui/maps/moonpine-ridge.jpg',
  trialSet: MOONPINE_TRIAL_SET, exitRouteId: 'moonpine-trial-exit', loadingLabel: 'Climbing to Moonpine Ridge', showcaseRegionId: 'moonpine-ridge',
  stage: { exitName: 'Temple Descent', completeKicker: 'THE PACK IS FREE', completeCopy: "Ruun's chains are broken. The temple path descends toward Mistveil." },
};
export const MISTVEIL_PLAYTEST: AssetPlaytest = {
  id: 'mistveil', name: 'Mistveil Basin', regionId: 'mistveil-basin',
  manifestUrl: '/asset-source/playtests/mistveil.json', manifestLabel: 'Mistveil Basin candidate asset playtest manifest',
  banner: banner('Mistveil Basin'), thumbnailUrl: '/asset-source/ui/maps/mistveil-basin.jpg',
  trialSet: MISTVEIL_TRIAL_SET, exitRouteId: 'mistveil-trial-exit', loadingLabel: 'Wading into Mistveil Basin', showcaseRegionId: 'mistveil-basin',
  stage: { exitName: 'Root Cavern', completeKicker: 'THE RIVER RUNS CLEAR', completeCopy: 'Ghor is free of the Black Sap. The root cavern leads deeper.' },
};
/** Playable maps in unlock order; story chapters without a playable map are skipped (see StoryChapters). */
export const ASSET_PLAYTESTS: readonly AssetPlaytest[] = [GREENWAKE_PLAYTEST, CANOPY_PLAYTEST, GROVE_PLAYTEST, MOONPINE_PLAYTEST, MISTVEIL_PLAYTEST];

/** URL chooses a highlighted map, never grants an unlock. Any playtest parameter enters the local selector. */
export function assetPlaytestFromSearch(search: string): AssetPlaytest | null {
  const query = new URLSearchParams(search);
  if (!query.has('assetPlaytest')) return null;
  return ASSET_PLAYTESTS.find(playtest => playtest.id === query.get('assetPlaytest')) ?? GREENWAKE_PLAYTEST;
}
