import { describe, expect, it } from 'bun:test';
import { VoiceLimiter, type LimitedVoice } from '../../src/audio/VoiceLimiter.js';
import { SamplePlayer, MAX_SAMPLE_VOICES, SAMPLE_CULL_DISTANCE } from '../../src/audio/SamplePlayer.js';
import { SampleBank } from '../../src/audio/SampleBank.js';
import { SOUND_GROUPS } from '../../src/audio/SampleCatalog.js';
import { FakeContext, FakeNode, settle } from './support/fakes.js';

function voice(group: string, priority: number, log: string[] = [], name = `${group}#${priority}`): LimitedVoice {
  return { group, priority, order: 0, stop: () => { log.push(name); } };
}

describe('voice limiter', () => {
  it('steals the oldest voice of a full group when the newcomer is at least as important', () => {
    const limiter = new VoiceLimiter({ total: 10 });
    const stopped: string[] = [];
    const first = voice('hit', 3, stopped, 'first'), second = voice('hit', 3, stopped, 'second'), third = voice('hit', 3, stopped, 'third');
    expect(limiter.admit(first, 2)).toBe(true);
    expect(limiter.admit(second, 2)).toBe(true);
    expect(limiter.admit(third, 2)).toBe(true);
    expect(stopped).toEqual(['first']);
    expect(limiter.count).toBe(2);
    expect(limiter.stolen).toBe(1);
  });

  it('steals the lowest priority first, and refuses a newcomer that outranks nobody', () => {
    const limiter = new VoiceLimiter({ total: 10 });
    const stopped: string[] = [];
    expect(limiter.admit(voice('vocal', 5, stopped, 'roar'), 2)).toBe(true);
    expect(limiter.admit(voice('vocal', 3, stopped, 'hurt'), 2)).toBe(true);
    expect(limiter.admit(voice('vocal', 7, stopped, 'death'), 2)).toBe(true);
    expect(stopped).toEqual(['hurt']);
    expect(limiter.admit(voice('vocal', 1, stopped, 'chatter'), 2)).toBe(false);
    expect(stopped).toEqual(['hurt']);
    expect(limiter.rejected).toBe(1);
    expect(limiter.count).toBe(2);
  });

  it('enforces the global cap across groups', () => {
    const limiter = new VoiceLimiter({ total: 3 });
    const stopped: string[] = [];
    limiter.admit(voice('a', 1, stopped, 'a1'), 9);
    limiter.admit(voice('b', 2, stopped, 'b2'), 9);
    limiter.admit(voice('c', 3, stopped, 'c3'), 9);
    expect(limiter.admit(voice('d', 2, stopped, 'd2'), 9)).toBe(true);
    expect(stopped).toEqual(['a1']);
    expect(limiter.count).toBe(3);
    expect(limiter.admit(voice('e', 1, stopped, 'e1'), 9)).toBe(false);
    expect(limiter.count).toBe(3);
  });

  it('releases voices and stops everything on releaseAll', () => {
    const limiter = new VoiceLimiter({ total: 3 });
    const stopped: string[] = [];
    const a = voice('a', 1, stopped, 'a'), b = voice('b', 1, stopped, 'b');
    limiter.admit(a, 4); limiter.admit(b, 4);
    limiter.release(a);
    expect(limiter.count).toBe(1);
    expect(limiter.countGroup('b')).toBe(1);
    limiter.releaseAll();
    expect(stopped).toEqual(['b']);
    expect(limiter.count).toBe(0);
  });
});

describe('sample player voice budget', () => {
  async function player(listener = true) {
    const context = new FakeContext();
    context.state = 'running';
    const bank = new SampleBank({ fetchBytes: async () => new ArrayBuffer(8), decode: bytes => context.decodeAudioData(bytes) as unknown as Promise<AudioBuffer> });
    await bank.loadPack('core');
    const effects = new FakeNode();
    const samples = new SamplePlayer(context as unknown as AudioContext, bank, { effects: effects as unknown as AudioNode }, () => 0.5);
    if (listener) samples.setListener({ x: 0, y: 0, z: 0 });
    return { context, samples };
  }

  it('limits concurrent voices per group and reuses pooled node chains', async () => {
    const { context, samples } = await player();
    const group = SOUND_GROUPS['impact.flesh.light']!;
    for (let i = 0; i < group.maxVoices + 3; i++) expect(samples.play(group.id, 1, 1, 0, { x: 1, y: 0, z: 1 })).toBe(true);
    expect(samples.stats.active).toBe(group.maxVoices);
    expect(samples.stats.stolen).toBe(3);
    const chainsBefore = samples.stats.chains;
    for (const source of context.sources) source.finish();
    expect(samples.stats.active).toBe(0);
    for (let i = 0; i < group.maxVoices; i++) samples.play(group.id, 1, 1, 0, { x: 1, y: 0, z: 1 });
    expect(samples.stats.chains).toBe(chainsBefore);
  });

  it('never exceeds the total sample voice limit', async () => {
    const { samples } = await player();
    const ids = Object.keys(SOUND_GROUPS).filter(id => SOUND_GROUPS[id]!.pack === 'core');
    for (let round = 0; round < 3; round++) for (const id of ids) samples.play(id, 1, 1, 0, { x: 2, y: 0, z: 0 });
    expect(samples.stats.active).toBeLessThanOrEqual(MAX_SAMPLE_VOICES);
  });

  it('culls sounds beyond the audible distance without spending a voice, and attenuates the rest by distance', async () => {
    const { context, samples } = await player();
    expect(samples.play('impact.flesh.heavy', 1, 1, 0, { x: SAMPLE_CULL_DISTANCE + 5, y: 0, z: 0 })).toBe(false);
    expect(samples.stats.culled).toBe(1);
    expect(samples.stats.active).toBe(0);
    expect(samples.play('impact.flesh.heavy', 1, 1, 0, { x: 10, y: 0, z: 0 })).toBe(true);
    const panner = context.panners[0]!;
    expect(panner.distanceModel).toBe('inverse');
    expect(panner.refDistance).toBeGreaterThan(0);
    expect(panner.positionX.value).toBe(10);
  });

  it('reports a miss (and plays nothing) while a pack has not decoded yet', async () => {
    const context = new FakeContext();
    context.state = 'running';
    const bank = new SampleBank({ fetchBytes: async () => new ArrayBuffer(8), decode: bytes => context.decodeAudioData(bytes) as unknown as Promise<AudioBuffer> });
    const samples = new SamplePlayer(context as unknown as AudioContext, bank, { effects: new FakeNode() as unknown as AudioNode });
    expect(samples.play('impact.flesh.heavy', 1, 1, 0)).toBe(false);
    expect(samples.stats.missed).toBe(1);
    await settle();
  });

  it('starts, stops and fades a looping sample (the stun ring)', async () => {
    const { context, samples } = await player();
    const handle = samples.startLoop('react.stun-loop', 0.7, { x: 1, y: 0, z: 1 });
    expect(handle).toBeDefined();
    const source = context.sources[context.sources.length - 1]!;
    expect(source.loop).toBe(true);
    handle!.stop(0.2);
    expect(source.stoppedAt).toBeGreaterThan(context.currentTime);
    source.finish();
    expect(samples.stats.active).toBe(0);
  });
});
