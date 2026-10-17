import { describe, expect, it } from 'bun:test';
import { validateSessionConfig } from '../../src/game/contracts.js';
import {
  CANDIDATE_CHAPTERS_BANNER, CANDIDATE_CHAPTERS_SESSION, PRODUCTION_SESSION, bannerOf, initialSession, isCandidateSession, sessionKindOf, trialMapOf, trialsSession,
} from '../../src/app/SessionConfig.js';

describe('initialSession', () => {
  it('keeps DEV Trials isolated from the playable browser campaign', () => {
    expect(initialSession('?assetPlaytest=canopy', true)).toEqual(trialsSession('canopy'));
    expect(initialSession('?assetPlaytest=unknown', true)).toEqual(trialsSession('greenwake'));
    expect(initialSession('?chapters=candidate', true)).toEqual(CANDIDATE_CHAPTERS_SESSION);
    expect(initialSession('?chapters=candidate&assetPlaytest=grove', true)).toEqual(trialsSession('grove'));
    for (const search of ['', '?', '?chapters=other', '?chapters=']) expect(initialSession(search, true)).toBe(CANDIDATE_CHAPTERS_SESSION);
  });

  it('uses the same playable save scope in static builds without enabling Trials', () => {
    for (const search of ['', '?chapters=candidate', '?assetPlaytest=canopy', '?assetPlaytest=greenwake&chapters=candidate'])
      expect(initialSession(search, false)).toBe(CANDIDATE_CHAPTERS_SESSION);
  });
});

describe('session policy and banners', () => {
  it('keeps verified and candidate save scopes separate while Trials remain DEV-only', () => {
    expect(validateSessionConfig(PRODUCTION_SESSION, false)).toBe(PRODUCTION_SESSION);
    expect(validateSessionConfig(CANDIDATE_CHAPTERS_SESSION, false)).toBe(CANDIDATE_CHAPTERS_SESSION);
    expect(() => validateSessionConfig(trialsSession('canopy'), false)).toThrow('DEV');
    expect(() => validateSessionConfig({ kind: 'chapters', assets: 'candidate', saveScope: 'production' }, true)).toThrow('must match');
    expect(() => validateSessionConfig({ kind: 'chapters', assets: 'verified', saveScope: 'candidate-chapters' }, true)).toThrow('must match');
  });

  it('names the session kind and the persistent banner', () => {
    expect(sessionKindOf(PRODUCTION_SESSION)).toBe('production');
    expect(sessionKindOf(CANDIDATE_CHAPTERS_SESSION)).toBe('chapters');
    expect(sessionKindOf(trialsSession('canopy'))).toBe('trials');
    expect(bannerOf(PRODUCTION_SESSION)).toBeNull();
    expect(bannerOf(CANDIDATE_CHAPTERS_SESSION)).toBe(CANDIDATE_CHAPTERS_BANNER);
  });

  it('only candidate sessions relax renderer strictness, and only Trials name a map', () => {
    expect(isCandidateSession(PRODUCTION_SESSION)).toBe(false);
    expect(isCandidateSession(CANDIDATE_CHAPTERS_SESSION)).toBe(true);
    expect(isCandidateSession(trialsSession('grove'))).toBe(true);
    expect(trialMapOf(PRODUCTION_SESSION)).toBeNull();
    expect(trialMapOf(CANDIDATE_CHAPTERS_SESSION)).toBeNull();
    expect(trialMapOf(trialsSession('grove'))?.id).toBe('grove');
  });
});
