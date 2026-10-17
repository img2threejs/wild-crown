import { CommandWheel } from '../../src/input/CommandWheel.js';
import { PRODUCTION_SESSION } from '../../src/app/SessionConfig.js';
import { createFakeAppAudio } from './fakeAppAudio.js';
import { PlaytestProgress } from '../../src/app/PlaytestProgress.js';
import { DEFAULT_GAME_SETTINGS } from '../../src/game/contracts.js';

/**
 * Instance fields of GameApplication that `Object.create(GameApplication.prototype)` fixtures skip (field initializers
 * do not run): the production session, the command wheel state, transaction/story flags and a recording audio facade.
 */
export function appDefaults(): Record<string, unknown> {
  return {
    settings: structuredClone(DEFAULT_GAME_SETTINGS), selectedHero: 'aren', activeCompanionId: undefined,
    appAudio: createFakeAppAudio(), session: PRODUCTION_SESSION, wheel: new CommandWheel(), wheelOpenedBy: null, wheelCache: null,
    playtestProgress: new PlaytestProgress(null),
    combatReadability: { clear() {}, update() {}, setSettings() {}, dispose() {} },
    bossIntro: { show() {}, dispose() {} }, revealedBosses: new Set<string>(),
    worldBusy: 0, storyBusy: false, chapterIntents: [], intentRunning: false, presentingStory: false, choiceFromResume: false, choiceNotice: null,
  };
}
