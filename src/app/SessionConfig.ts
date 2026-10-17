import type { GameViewModel, SessionConfig } from '../game/contracts.js';
import { validateSessionConfig } from '../game/contracts.js';
import { ASSET_PLAYTESTS, GREENWAKE_PLAYTEST, assetPlaytestFromSearch, type AssetPlaytest } from './AssetPlaytests.js';

/** Persistent banner of every candidate-chapter screen (loading, story scenes, saves). */
export const CANDIDATE_CHAPTERS_BANNER = 'CANDIDATE CHAPTERS · GENERATED ASSETS · NOT RELEASE-VERIFIED';

/** Strict verified-asset policy for release validation, isolated from playable candidate saves. */
export const PRODUCTION_SESSION: SessionConfig = Object.freeze({ kind: 'chapters', assets: 'verified', saveScope: 'production' });
/** Playable campaign: native generated assets, with an honest evidence banner and isolated browser saves. */
export const CANDIDATE_CHAPTERS_SESSION: SessionConfig = Object.freeze({ kind: 'chapters', assets: 'candidate', saveScope: 'candidate-chapters' });

export function trialsSession(mapId: string): SessionConfig { return { kind: 'trials', assets: 'candidate', mapId }; }

/** Page loads use the playable campaign in every build. Only DEV accepts the isolated Trials shortcut. */
export function initialSession(search: string, isDev: boolean): SessionConfig {
    const trial = isDev ? assetPlaytestFromSearch(search) : null;
    if (trial) return validateSessionConfig(trialsSession(trial.id), isDev);
    return CANDIDATE_CHAPTERS_SESSION;
}

/** The Trials map a Trials session names; falls back to the first map for an unknown id. */
export function trialMapOf(session: SessionConfig): AssetPlaytest | null {
    if (session.kind !== 'trials') return null;
    return ASSET_PLAYTESTS.find(map => map.id === session.mapId) ?? GREENWAKE_PLAYTEST;
}

export function sessionKindOf(session: SessionConfig): NonNullable<GameViewModel['session']>['kind'] {
    if (session.kind === 'trials') return 'trials';
    return session.saveScope === 'production' ? 'production' : 'chapters';
}

/** Banner text for the session; null in production. Trials keep their per-map banner. */
export function bannerOf(session: SessionConfig): string | null {
    if (session.kind === 'trials') return trialMapOf(session)!.banner;
    return session.assets === 'candidate' ? CANDIDATE_CHAPTERS_BANNER : null;
}

/** True when the session reads candidate assets and may therefore relax renderer clip/geometry strictness. */
export function isCandidateSession(session: SessionConfig): boolean { return session.assets === 'candidate'; }
