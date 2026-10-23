import type { AssetPolicy, GameViewModel, SessionConfig } from '../game/contracts.js';
import { validateSessionConfig } from '../game/contracts.js';
import { ASSET_PLAYTESTS, GREENWAKE_PLAYTEST, assetPlaytestFromSearch, type AssetPlaytest } from './AssetPlaytests.js';

/** Persistent banner of every candidate-chapter screen (loading, story scenes, saves). */
export const CANDIDATE_CHAPTERS_BANNER = 'CANDIDATE CHAPTERS · GENERATED ASSETS · NOT RELEASE-VERIFIED';

/** Strict verified-asset policy for release validation, isolated from playable candidate saves. */
export const PRODUCTION_SESSION: SessionConfig = Object.freeze({ kind: 'chapters', assets: 'verified', saveScope: 'production' });
/** Playable campaign: native generated assets, with an honest evidence banner and isolated browser saves. */
export const CANDIDATE_CHAPTERS_SESSION: SessionConfig = Object.freeze({ kind: 'chapters', assets: 'candidate', saveScope: 'candidate-chapters' });

export function trialsSession(mapId: string): SessionConfig { return { kind: 'trials', assets: 'candidate', mapId }; }

/** Player practice inherits the campaign's asset policy and has no campaign save repository. */
export function trainingSession(mapId: string, assets: AssetPolicy): Extract<SessionConfig, { kind: 'training' }> {
    if (!ASSET_PLAYTESTS.some(map => map.id === mapId)) throw new Error('Unknown Training Grounds map.');
    return { kind: 'training', assets, mapId };
}

/** Page loads use the playable campaign in every build. Only DEV accepts the isolated Trials shortcut. */
export function initialSession(search: string, isDev: boolean): SessionConfig {
    const trial = isDev ? assetPlaytestFromSearch(search) : null;
    if (trial) return validateSessionConfig(trialsSession(trial.id), isDev);
    return CANDIDATE_CHAPTERS_SESSION;
}

/** DEV fixtures and player practice reuse the same authored combat stages, never their progression or asset policy. */
export function trialMapOf(session: SessionConfig): AssetPlaytest | null {
    if (session.kind === 'chapters') return null;
    const map = ASSET_PLAYTESTS.find(map => map.id === session.mapId);
    if (!map && session.kind === 'training') throw new Error('Unknown Training Grounds map.');
    return map ?? GREENWAKE_PLAYTEST;
}

export function sessionKindOf(session: SessionConfig): NonNullable<GameViewModel['session']>['kind'] {
    if (session.kind !== 'chapters') return session.kind;
    return session.saveScope === 'production' ? 'production' : 'chapters';
}

/** Candidate evidence notices cannot be hidden. Verified-session presentation is independently configurable. */
export function bannerOf(session: SessionConfig, showVerifiedBanner = false): string | null {
    if (session.kind === 'trials') return trialMapOf(session)!.banner;
    if (session.assets === 'candidate') return session.kind === 'training'
        ? 'TRAINING GROUNDS · GENERATED ASSETS · NOT RELEASE-VERIFIED'
        : CANDIDATE_CHAPTERS_BANNER;
    return showVerifiedBanner ? `${session.kind === 'training' ? 'TRAINING GROUNDS' : 'CAMPAIGN'} · VERIFIED ASSETS` : null;
}

/** True when the session reads candidate assets and may therefore relax renderer clip/geometry strictness. */
export function isCandidateSession(session: SessionConfig): boolean { return session.assets === 'candidate'; }
