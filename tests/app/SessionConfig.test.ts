import { describe, expect, it } from 'bun:test';
import { validateSessionConfig } from '../../src/game/contracts.js';
import {
  CANDIDATE_CHAPTERS_BANNER, CANDIDATE_CHAPTERS_SESSION, PRODUCTION_SESSION, bannerOf, initialSession, isCandidateSession, sessionKindOf, trialMapOf, trialsSession, trainingSession,
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

  it('allows isolated player training in either asset policy without enabling DEV fixtures', () => {
    for (const assets of ['candidate', 'verified'] as const) {
      const session = trainingSession('canopy', assets);
      expect(validateSessionConfig(session, false)).toBe(session);
      expect(sessionKindOf(session)).toBe('training');
      expect(trialMapOf(session)?.regionId).toBe('whispering-canopy');
      expect(isCandidateSession(session)).toBe(assets === 'candidate');
    }
    expect(() => trainingSession('not-a-map', 'verified')).toThrow();
    expect(() => validateSessionConfig({ kind: 'training', assets: 'verified', mapId: '' }, false)).toThrow();
    expect(() => trialMapOf({ kind: 'training', assets: 'verified', mapId: 'not-a-map' })).toThrow();
    expect(() => validateSessionConfig(trialsSession('canopy'), false)).toThrow();
  });

  it('never hides candidate evidence while allowing verified-release banner presentation to change', () => {
    expect(bannerOf(CANDIDATE_CHAPTERS_SESSION, false)).toBe(CANDIDATE_CHAPTERS_BANNER);
    const candidatePractice = trainingSession('canopy', 'candidate');
    expect(bannerOf(candidatePractice, false)).toBe(bannerOf(candidatePractice, true));
    expect(bannerOf(candidatePractice, false)).not.toBe(bannerOf(trainingSession('canopy', 'verified'), true));
    expect(bannerOf(PRODUCTION_SESSION, false)).toBeNull();
    expect(bannerOf(PRODUCTION_SESSION, true)).not.toBeNull();
    expect(bannerOf(trainingSession('canopy', 'verified'), false)).toBeNull();
    expect(bannerOf(trainingSession('canopy', 'verified'), true)).not.toBeNull();
  });

  it('names the session kind and the persistent banner', () => {
    expect(sessionKindOf(PRODUCTION_SESSION)).toBe('production');
    expect(sessionKindOf(CANDIDATE_CHAPTERS_SESSION)).toBe('chapters');
    expect(sessionKindOf(trialsSession('canopy'))).toBe('trials');
    expect(bannerOf(PRODUCTION_SESSION)).toBeNull();
    expect(bannerOf(CANDIDATE_CHAPTERS_SESSION)).toBe(CANDIDATE_CHAPTERS_BANNER);
  });

  it('only candidate sessions relax renderer strictness, and only isolated combat sessions resolve a stage map', () => {
    expect(isCandidateSession(PRODUCTION_SESSION)).toBe(false);
    expect(isCandidateSession(CANDIDATE_CHAPTERS_SESSION)).toBe(true);
    expect(isCandidateSession(trialsSession('grove'))).toBe(true);
    expect(trialMapOf(PRODUCTION_SESSION)).toBeNull();
    expect(trialMapOf(CANDIDATE_CHAPTERS_SESSION)).toBeNull();
    expect(trialMapOf(trialsSession('grove'))?.id).toBe('grove');
  });
});
