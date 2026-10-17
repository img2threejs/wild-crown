import type { AppAudio } from '../../src/audio/AppAudio.js';

/** Recording stand-in for the application's AppAudio facade: every call is appended to `calls` as [method, ...args]. */
export interface FakeAppAudio {
  readonly calls: Array<[string, ...unknown[]]>;
  setSettings(settings: unknown): void;
  unlock(): Promise<boolean>;
  syncScreen(screen: string): void;
  attachRegion(region: unknown): void;
  action(type: string): void;
  playStinger(id: string): boolean;
  dispose(): void;
}

export function createFakeAppAudio(): FakeAppAudio & AppAudio {
  const calls: Array<[string, ...unknown[]]> = [];
  const fake: FakeAppAudio = {
    calls,
    setSettings: settings => { calls.push(['setSettings', settings]); },
    unlock: async () => { calls.push(['unlock']); return true; },
    syncScreen: screen => { calls.push(['syncScreen', screen]); },
    attachRegion: region => { calls.push(['attachRegion', region]); },
    action: type => { calls.push(['action', type]); },
    playStinger: id => { calls.push(['playStinger', id]); return true; },
    dispose: () => { calls.push(['dispose']); },
  };
  return fake as FakeAppAudio & AppAudio;
}
