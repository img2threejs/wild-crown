import { describe, expect, it } from 'bun:test';
import { MusicDirector, STEM_SLEW } from '../../src/audio/MusicDirector.js';
import {
  COMBAT_TUNING, CombatIntensity, LAYER_COMBAT_KEEP, LAYER_PEAK, STEM_IDS, STEM_PAUSE_AFTER_SECONDS, STEM_SILENCE, emptyStemGains, smoothGain, targetStemGains,
  type MusicMixState,
} from '../../src/audio/MusicMix.js';
import { StreamedLoop } from '../../src/audio/StreamedLoop.js';
import { FakeContext, FakeMedia, FakeNode } from './support/fakes.js';

const state = (over: Partial<MusicMixState> = {}): MusicMixState => ({ menu: false, combat: 0, boss: false, restoration: 0, corruption: 0, ...over });
const power = (gains: ReturnType<typeof emptyStemGains>): number => gains.explore ** 2 + gains.combat ** 2 + gains.boss ** 2;

describe('music mix rules', () => {
  it('plays only the title cue on menu screens', () => {
    const gains = targetStemGains(state({ menu: true, combat: 1, boss: true, restoration: 1 }), emptyStemGains());
    expect(gains.title).toBe(1);
    for (const id of STEM_IDS) if (id !== 'title') expect(gains[id]).toBe(0);
  });

  it('crossfades exploration into combat equal-power: loudness never dips or bulges mid-fade', () => {
    for (let combat = 0; combat <= 1.0001; combat += 0.1) {
      const gains = targetStemGains(state({ combat }), emptyStemGains());
      expect(power(gains)).toBeCloseTo(1, 6);
      expect(gains.boss).toBe(0);
    }
    expect(targetStemGains(state({ combat: 0 }), emptyStemGains()).explore).toBe(1);
    expect(targetStemGains(state({ combat: 1 }), emptyStemGains()).combat).toBe(1);
  });

  it('hands the foreground to the boss cue regardless of combat intensity', () => {
    for (const combat of [0, 0.5, 1]) {
      const gains = targetStemGains(state({ combat, boss: true }), emptyStemGains());
      expect(gains.boss).toBe(1);
      expect(gains.explore).toBe(0);
      expect(gains.combat).toBe(0);
    }
  });

  it('rides the restored and corrupted layers on story state and recedes them in the foreground', () => {
    const calm = targetStemGains(state({ restoration: 1, corruption: 0 }), emptyStemGains());
    expect(calm.restored).toBeCloseTo(LAYER_PEAK, 6);
    expect(calm.corrupted).toBe(0);
    const sick = targetStemGains(state({ restoration: 0, corruption: 1 }), emptyStemGains());
    expect(sick.corrupted).toBeCloseTo(LAYER_PEAK, 6);
    expect(sick.restored).toBe(0);
    const fighting = targetStemGains(state({ restoration: 1, combat: 1 }), emptyStemGains());
    expect(fighting.restored).toBeCloseTo(LAYER_PEAK * LAYER_COMBAT_KEEP, 6);
    const half = targetStemGains(state({ restoration: 0.5, corruption: 0.5 }), emptyStemGains());
    expect(half.restored).toBeCloseTo(half.corrupted, 6);
    expect(half.restored + half.corrupted).toBeCloseTo(LAYER_PEAK, 6);
    const clamped = targetStemGains(state({ restoration: 7, corruption: -3, combat: 9 }), emptyStemGains());
    for (const id of STEM_IDS) { expect(clamped[id]).toBeGreaterThanOrEqual(0); expect(clamped[id]).toBeLessThanOrEqual(1); }
  });

  it('slews gains exponentially toward the target with separate rise and fall times, never overshooting', () => {
    let gain = 0;
    const seen: number[] = [];
    for (let i = 0; i < 40; i++) { gain = smoothGain(gain, 1, 0.1, 2, 1); seen.push(gain); }
    expect(seen.every((value, i) => i === 0 || value >= seen[i - 1]!)).toBe(true);
    expect(Math.max(...seen)).toBeLessThanOrEqual(1);
    expect(smoothGain(0, 1, 2, 2, 1)).toBeCloseTo(1 - Math.exp(-1), 6);
    expect(smoothGain(1, 0, 1, 2, 1)).toBeCloseTo(Math.exp(-1), 6);
    expect(smoothGain(0.3, 1, 0, 2, 1)).toBe(0.3);
    expect(smoothGain(0.3, 1, 0.5, 0, 1)).toBe(1);
  });

  it('raises combat intensity quickly, holds it through a lull, then fades it slowly', () => {
    const intensity = new CombatIntensity();
    intensity.setPresence(0.8);
    for (let t = 0; t < 1; t += 0.1) intensity.update(0.1);
    expect(intensity.level).toBeCloseTo(0.8, 5);
    intensity.setPresence(0);
    for (let t = 0; t < COMBAT_TUNING.hold - 0.5; t += 0.1) intensity.update(0.1);
    expect(intensity.level).toBeCloseTo(0.8, 1);
    for (let t = 0; t < 1.5; t += 0.1) intensity.update(0.1);
    expect(intensity.level).toBeLessThan(0.8);
    expect(intensity.level).toBeGreaterThan(0);
    for (let t = 0; t < 30; t += 0.1) intensity.update(0.1);
    expect(intensity.level).toBe(0);
  });

  it('turns discrete hit pulses into a short-lived combat state', () => {
    const intensity = new CombatIntensity();
    intensity.pulse(0.75);
    intensity.update(0.5);
    expect(intensity.level).toBeGreaterThan(0.5);
    for (let t = 0; t < 60; t += 0.25) intensity.update(0.25);
    expect(intensity.level).toBe(0);
    intensity.pulse(1);
    intensity.reset();
    expect(intensity.level).toBe(0);
  });
});

function director() {
  const context = new FakeContext();
  context.state = 'running';
  FakeMedia.instances = [];
  const output = new FakeNode();
  const music = new MusicDirector({ context: context as never, output, createMedia: () => new FakeMedia(), resolveUrl: path => `/${path}` });
  music.setTracks({ explore: 'audio/music/a.ogg', combat: 'audio/music/b.ogg', boss: 'audio/music/c.ogg', restored: 'audio/music/r.ogg', corrupted: 'audio/music/k.ogg' }, ['combat']);
  return { context, music, output };
}
function run(music: MusicDirector, seconds: number, step = 0.1): void { for (let t = 0; t < seconds; t += step) music.update(step); }

describe('music director crossfades', () => {
  it('opens only what is audible: combat buffers paused, boss and layers stay unloaded until wanted', () => {
    const { music } = director();
    music.setState(state());
    music.update(0.1);
    const stems = music.snapshot();
    expect(stems.explore!.state).toBe('playing');
    expect(stems.combat!.state).toBe('idle');
    expect(stems.boss!.state).toBe('unloaded');
    expect(stems.restored!.state).toBe('unloaded');
    expect(stems.corrupted!.state).toBe('unloaded');
  });

  it('crossfades exploration to combat and back by the slew constants, keeping total power level', () => {
    const { music } = director();
    music.setState(state());
    run(music, 16);
    expect(music.snapshot().explore!.gain).toBeCloseTo(1, 1);
    music.setState(state({ combat: 1 }));
    let worstPower = Infinity, bestPower = 0;
    for (let t = 0; t < 8; t += 0.1) {
      music.update(0.1);
      const s = music.snapshot();
      const p = s.explore!.gain ** 2 + s.combat!.gain ** 2;
      if (t > 0.5) { worstPower = Math.min(worstPower, p); bestPower = Math.max(bestPower, p); }
    }
    const done = music.snapshot();
    expect(done.combat!.state).toBe('playing');
    expect(done.combat!.gain).toBeCloseTo(1, 1);
    expect(done.explore!.gain).toBeLessThan(0.05);
    expect(bestPower).toBeLessThanOrEqual(1.6);
    expect(worstPower).toBeGreaterThan(0.4);
    music.setState(state({ combat: 0 }));
    run(music, 12);
    expect(music.snapshot().explore!.gain).toBeCloseTo(1, 1);
  });

  it('pauses a faded-out stem after the quiet period and resumes it where it left off', () => {
    const { music } = director();
    music.setState(state());
    run(music, 3);
    music.setState(state({ combat: 1 }));
    run(music, 3);
    const exploreMedia = FakeMedia.instances.find(media => media.src.endsWith('/a.ogg'))!;
    exploreMedia.currentTime = 42;
    run(music, 20);
    expect(music.snapshot().explore!.gain).toBeLessThan(STEM_SILENCE);
    expect(music.snapshot().explore!.state).toBe('paused');
    expect(exploreMedia.paused).toBe(true);
    music.setState(state());
    run(music, 1);
    expect(exploreMedia.paused).toBe(false);
    expect(exploreMedia.currentTime).toBe(42);
  });

  it('fades the layers by story state and the boss stem in on a boss', () => {
    const { music } = director();
    music.setState(state({ restoration: 1, corruption: 0 }));
    run(music, 14);
    expect(music.snapshot().restored!.state).toBe('playing');
    expect(music.snapshot().restored!.gain).toBeCloseTo(LAYER_PEAK, 1);
    expect(music.snapshot().corrupted!.state).toBe('unloaded');
    music.setState(state({ restoration: 1, boss: true }));
    run(music, 10);
    const s = music.snapshot();
    expect(s.boss!.state).toBe('playing');
    expect(s.boss!.gain).toBeCloseTo(1, 1);
    expect(s.explore!.gain).toBeLessThan(0.05);
  });

  it('silences everything on request, then disposes streams and nodes', () => {
    const { music, output } = director();
    music.setState(state());
    run(music, 4);
    music.silence();
    run(music, 20);
    expect(music.isSilent).toBe(true);
    music.dispose();
    expect(Object.keys(music.snapshot())).toHaveLength(0);
    expect(FakeMedia.instances.every(media => media.paused)).toBe(true);
    expect(output).toBeDefined();
  });

  it('uses a fast rise for combat and a slow return for exploration', () => {
    expect(STEM_SLEW.combat[0]).toBeLessThan(STEM_SLEW.explore[0]);
    expect(STEM_PAUSE_AFTER_SECONDS).toBeGreaterThan(0);
  });
});

describe('streamed loop wrap', () => {
  function loop(duration = 60, crossfade = 2.5) {
    let now = 10;
    const created: { media: FakeMedia; gain: FakeNode }[] = [];
    const streamed = new StreamedLoop({
      now: () => now,
      createMedia: () => { const media = new FakeMedia(); media.duration = duration; return media; },
      createChain: media => { const gain = new FakeNode(); created.push({ media: media as FakeMedia, gain }); return { gain: gain as never, dispose: () => undefined }; },
    }, '/audio/music/x.ogg', crossfade);
    return { streamed, created, advance: (s: number) => { now += s; } };
  }

  it('starts the idle element and crossfades equal-power just before the end, then swaps without a gap', () => {
    const { streamed, created, advance } = loop();
    streamed.play();
    const [a, b] = created;
    expect(a!.media.paused).toBe(false);
    expect(b!.media.paused).toBe(true);
    a!.media.currentTime = 30;
    streamed.tick();
    expect(b!.media.paused).toBe(true);
    a!.media.currentTime = 58;
    streamed.tick();
    expect(b!.media.paused).toBe(false);
    expect(b!.media.currentTime).toBe(0);
    const out = a!.gain.gain.curves[0]!, incoming = b!.gain.gain.curves[0]!;
    expect(out.duration).toBe(2.5);
    for (let i = 0; i < out.values.length; i++) expect(out.values[i]! ** 2 + incoming.values[i]! ** 2).toBeCloseTo(1, 4);
    expect(out.values[0]).toBeCloseTo(1, 6);
    expect(out.values[out.values.length - 1]).toBeCloseTo(0, 6);
    advance(3);
    streamed.tick();
    expect(streamed.wraps).toBe(1);
    expect(a!.media.paused).toBe(true);
    expect(streamed.position).toBe(0);
  });

  it('shortens the crossfade for very short beds and never wraps before the file has a duration', () => {
    const short = loop(4, 2.5);
    short.streamed.play();
    short.created[0]!.media.currentTime = 3.2;
    short.streamed.tick();
    expect(short.created[0]!.gain.gain.curves[0]!.duration).toBeCloseTo(1, 6);
    const unknown = loop(NaN);
    unknown.streamed.play();
    unknown.created[0]!.media.currentTime = 999;
    unknown.streamed.tick();
    expect(unknown.created[1]!.media.paused).toBe(true);
  });

  it('pauses both elements and resumes the right one, and releases everything on dispose', () => {
    const { streamed, created } = loop();
    streamed.play();
    created[0]!.media.currentTime = 58;
    streamed.tick();
    streamed.pause();
    expect(created.every(chain => chain.media.paused)).toBe(true);
    streamed.play();
    expect(created.every(chain => !chain.media.paused)).toBe(true);
    streamed.dispose();
    expect(streamed.state).toBe('disposed');
    expect(created.every(chain => chain.gain.disconnected && chain.media.src === '')).toBe(true);
  });
});
