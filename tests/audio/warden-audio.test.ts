import { describe, expect, it } from 'bun:test';
import * as THREE from 'three';
import type { AudioListener } from 'three';
import { StoryPresentation } from '../../src/effects/StoryPresentation.js';
import type { StoryCue } from '../../src/effects/story-cues.js';
import { WARDEN_MAX_LAYERS, WARDEN_MAX_LEVEL, WARDEN_MAX_SECONDS, isWardenCue, wardenLayers, type SoundLayer } from '../../src/audio/WardenSounds.js';

// Scheduler-only instrument: it records the nodes the synth builds; it does not measure audible output.
class Param {
  value = 0;
  setValueAtTime(value: number): void { this.value = value; }
  setTargetAtTime(value: number): void { this.value = value; }
  linearRampToValueAtTime(): void {}
  exponentialRampToValueAtTime(): void {}
}
class Node {
  gain = new Param(); frequency = new Param(); Q = new Param(); positionX = new Param(); positionY = new Param(); positionZ = new Param();
  type = ''; buffer: unknown = null; loop = false; onended: (() => void) | null = null; stopped = false; disconnected = false;
  connect(node: Node): Node { return node; }
  disconnect(): void { this.disconnected = true; }
  start(): void {}
  stop(at?: number): void { this.stopped = true; if (at === undefined) this.onended?.(); }
  getFloatTimeDomainData(samples: Float32Array): void { samples.fill(0); }
}
class Context {
  state: 'suspended' | 'running' | 'closed' = 'suspended'; currentTime = 1; sampleRate = 48000; destination = new Node(); closed = false;
  oscillators: Node[] = []; bufferSources: Node[] = []; filters: Node[] = [];
  createGain(): Node { return new Node(); }
  createAnalyser(): Node { return new Node(); }
  createPanner(): Node { return new Node(); }
  createOscillator(): Node { const n = new Node(); this.oscillators.push(n); return n; }
  createBiquadFilter(): Node { const n = new Node(); this.filters.push(n); return n; }
  createBufferSource(): Node { const n = new Node(); this.bufferSources.push(n); return n; }
  createBuffer(channels: number, length: number, sampleRate: number): unknown {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, getChannelData: (c: number) => data[c] };
  }
  async resume(): Promise<void> { this.state = 'running'; }
  async close(): Promise<void> { this.closed = true; this.state = 'closed'; }
}

let sequence = 0;
function cue(partial: Partial<StoryCue> & Pick<StoryCue, 'kind' | 'phase'>): StoryCue {
  return { instanceId: `audio:${++sequence}`, tick: 60, worldTick: 60, worldTimeSeconds: 1, priority: 'essential', ...partial };
}
async function session(test: (presentation: StoryPresentation, context: Context) => void): Promise<void> {
  const previous = globalThis.AudioContext;
  globalThis.AudioContext = Context as unknown as typeof AudioContext;
  const context = new Context(), presentation = new StoryPresentation({ scene: new THREE.Scene(), audioListener: { context } as unknown as AudioListener });
  try {
    expect(presentation.audio.play(cue({ kind: 'slash', phase: 'active', actorId: 'aren' }))).toBe(false);
    expect(await presentation.unlockAudio()).toBe(true);
    test(presentation, context);
  } finally {
    presentation.dispose();
    if (previous === undefined) delete (globalThis as { AudioContext?: typeof AudioContext }).AudioContext; else globalThis.AudioContext = previous;
  }
}

const SAMPLE_CUES: readonly StoryCue[] = [
  cue({ kind: 'slash', phase: 'active', actorId: 'aren', durationTicks: 4, intensity: 1, element: 'arcane' }),
  cue({ kind: 'slash', phase: 'active', actorId: 'aren', durationTicks: 9, intensity: 2, element: 'arcane' }),
  cue({ kind: 'hit', phase: 'hit', actorId: 'aren', intensity: 1.2, element: 'arcane' }),
  cue({ kind: 'hit', phase: 'hit', actorId: 'aren', intensity: 1.5, element: 'lightning' }),
  cue({ kind: 'sigil', phase: 'anticipation', actorId: 'aren', durationTicks: 16, intensity: 1, element: 'arcane' }),
  cue({ kind: 'sigil', phase: 'sustain', actorId: 'aren', durationTicks: 600, intensity: 1.6, element: 'arcane' }),
  cue({ kind: 'projectile', phase: 'commit', actionId: 'sigil-bolt' as never, element: 'arcane' }),
  cue({ kind: 'projectile', phase: 'commit', actionId: 'crescent-wave' as never, element: 'arcane' }),
  cue({ kind: 'projectile-impact', phase: 'hit', actionId: 'sigil-bolt' as never, intensity: 1, element: 'arcane' }),
  cue({ kind: 'projectile-impact', phase: 'hit', actionId: 'crescent-wave' as never, intensity: 0.6, element: 'arcane' }),
  cue({ kind: 'lightning', phase: 'active', intensity: 2, element: 'lightning', durationTicks: 18 }),
  cue({ kind: 'judgement', phase: 'anticipation', actorId: 'aren' }),
  cue({ kind: 'judgement', phase: 'commit', actorId: 'aren' }),
  cue({ kind: 'judgement', phase: 'resolve', actorId: 'aren' }),
  cue({ kind: 'judgement-mark', phase: 'anticipation' }),
  cue({ kind: 'judgement-mark', phase: 'hit', intensity: 1.2 }),
];

describe('Warden sound recipes', () => {
  it('every Warden cue has layers inside the voice, level and length budgets', () => {
    for (const sample of SAMPLE_CUES) {
      const layers = wardenLayers(sample);
      expect(layers, `${sample.kind}/${sample.phase}`).toBeDefined();
      expect(layers!.length).toBeGreaterThan(0);
      expect(layers!.length).toBeLessThanOrEqual(WARDEN_MAX_LAYERS);
      for (const layer of layers!) {
        expect(layer.level).toBeGreaterThan(0);
        expect(layer.level).toBeLessThanOrEqual(WARDEN_MAX_LEVEL);
        expect(layer.delay + layer.length).toBeLessThanOrEqual(WARDEN_MAX_SECONDS);
        expect(layer.attack).toBeGreaterThan(0);
        for (const value of [layer.from, layer.to, layer.filterFrom, layer.filterTo]) if (value !== undefined) { expect(Number.isFinite(value)).toBe(true); expect(value).toBeGreaterThan(0); }
        if (layer.source === 'tone') { expect(layer.wave).toBeDefined(); expect(layer.from).toBeDefined(); } else expect(layer.noise).toBeDefined();
      }
    }
  });

  it('classifies only the Warden skill cues (Aren arcane/lightning hits included) and leaves every other cue on the generic path', () => {
    for (const sample of SAMPLE_CUES) expect(isWardenCue(sample)).toBe(true);
    expect(isWardenCue(cue({ kind: 'hit', phase: 'hit', actorId: 'boar', element: 'arcane' }))).toBe(false);
    expect(isWardenCue(cue({ kind: 'hit', phase: 'hit', actorId: 'aren' }))).toBe(false);
    expect(isWardenCue(cue({ kind: 'anticipation', phase: 'anticipation', element: 'fire' }))).toBe(false);
    expect(wardenLayers(cue({ kind: 'judgement', phase: 'sustain' }))).toBeUndefined();
  });

  it('slash is a short filtered-noise swish whose pitch rises with intensity', () => {
    const base = { instanceId: 'same', kind: 'slash' as const, phase: 'active' as const, tick: 0, worldTick: 0, worldTimeSeconds: 0, actorId: 'aren', durationTicks: 6 };
    const swish = (intensity: number): SoundLayer => wardenLayers({ ...base, intensity })!.find(layer => layer.source === 'noise')!;
    const soft = swish(1), hard = swish(1.8);
    expect(soft.filter).toBe('bandpass');
    expect(soft.length).toBeLessThan(0.4);
    expect(hard.filterFrom!).toBeGreaterThan(soft.filterFrom!);
    expect(hard.filterTo!).toBeGreaterThan(soft.filterTo!);
    expect(wardenLayers({ ...base, intensity: 2 })!.some(layer => layer.source === 'tone' && layer.from! < 200)).toBe(true);
  });

  it('shapes each skill: layered arcane hit, rising sigil chord, crack + rumble lightning, glassy impact, sheath shing', () => {
    const hit = wardenLayers(SAMPLE_CUES[2]!)!;
    expect(hit.some(layer => layer.source === 'noise' && layer.length < 0.08)).toBe(true);
    expect(hit.some(layer => layer.source === 'tone' && layer.from! < 200 && layer.to! < layer.from!)).toBe(true);
    expect(hit.filter(layer => layer.source === 'tone' && layer.from! > 1000).length).toBeGreaterThanOrEqual(3);
    const sigil = wardenLayers(SAMPLE_CUES[4]!)!;
    expect(sigil.filter(layer => layer.wave === 'triangle').length).toBeGreaterThanOrEqual(3);
    expect(sigil.filter(layer => layer.source === 'tone').every(layer => layer.to! > layer.from!)).toBe(true);
    const zap = wardenLayers(SAMPLE_CUES[10]!)!;
    expect(zap.some(layer => layer.noise === 'white' && layer.length < 0.1)).toBe(true);
    expect(zap.some(layer => layer.noise === 'crackle')).toBe(true);
    expect(zap.some(layer => layer.source === 'tone' && layer.from! < 80 && layer.length > 0.8)).toBe(true);
    const shatter = wardenLayers(SAMPLE_CUES[8]!)!;
    expect(shatter.some(layer => layer.noise === 'shards')).toBe(true);
    expect(shatter.some(layer => layer.source === 'tone' && layer.from! < 150)).toBe(true);
    const sheath = wardenLayers(SAMPLE_CUES[13]!)!;
    expect(sheath.filter(layer => layer.source === 'tone' && layer.from! > 2000).length).toBeGreaterThanOrEqual(3);
    const ping = wardenLayers(SAMPLE_CUES[14]!)!, boom = wardenLayers(SAMPLE_CUES[15]!)!;
    expect(ping.every(layer => layer.source === 'tone' && layer.level <= 0.02)).toBe(true);
    expect(boom.some(layer => layer.level >= 0.06)).toBe(true);
  });
});

describe('Warden playback through StoryAudio', () => {
  it('plays on the effects bus after unlock, is one-shot, retires when its sources end and tears down on scope cancel', async () => {
    await session((presentation, context) => {
      const audio = presentation.audio, slash = cue({ kind: 'slash', phase: 'active', actorId: 'aren', durationTicks: 4, intensity: 1, element: 'arcane', scopeId: 'slash:1' });
      expect(audio.play(slash)).toBe(true);
      expect(audio.play(slash)).toBe(false);
      expect(audio.playbackMetadata.lastPlayed?.bus).toBe('effects');
      expect(audio.playbackMetadata.activeVoices).toBe(1);
      const sources = [...context.oscillators, ...context.bufferSources];
      expect(sources.length).toBe(wardenLayers(slash)!.length);
      for (const source of sources) source.stop();
      expect(audio.playbackMetadata.activeVoices).toBe(0);
      expect(sources.every(source => source.disconnected)).toBe(true);
      const sigil = cue({ kind: 'sigil', phase: 'sustain', actorId: 'aren', scopeId: 'sigil:9', durationTicks: 600, intensity: 1.6, element: 'arcane' });
      const before = context.oscillators.length;
      expect(audio.play(sigil)).toBe(true);
      const voices = context.oscillators.slice(before);
      expect(voices.length).toBeGreaterThanOrEqual(4);
      presentation.onInterrupt('sigil:9');
      expect(audio.playbackMetadata.activeVoices).toBe(0);
      expect(voices.every(node => node.stopped && node.disconnected)).toBe(true);
    });
  });

  it('keeps at most ten Warden voices alive by stealing the oldest, and never replays a consumed cue', async () => {
    await session((presentation, context) => {
      const audio = presentation.audio;
      for (let i = 0; i < 16; i++) expect(audio.play(cue({ kind: 'judgement-mark', phase: 'hit', scopeId: `mark:${i}`, intensity: 1.2 }))).toBe(true);
      expect(audio.playbackMetadata.activeVoices).toBeLessThanOrEqual(10);
      expect(audio.playbackMetadata.activeVoices).toBeGreaterThan(0);
      presentation.onDeath();
      expect(audio.playbackMetadata.activeVoices).toBe(0);
      expect([...context.oscillators, ...context.bufferSources].every(node => node.stopped)).toBe(true);
    });
  });

  it('a silent phase plays nothing, and non-Warden element cues still use the generic path with the new arcane/lightning timbres', async () => {
    await session((presentation, context) => {
      const audio = presentation.audio;
      expect(audio.play(cue({ kind: 'judgement', phase: 'sustain', actorId: 'aren' }))).toBe(false);
      expect(audio.playbackMetadata.activeVoices).toBe(0);
      const before = context.oscillators.length;
      expect(audio.play(cue({ kind: 'active', phase: 'active', element: 'lightning', durationTicks: 20, intensity: 1 }))).toBe(true);
      const generic = context.oscillators.slice(before);
      expect(generic.length).toBe(3);
      expect(generic.every(node => node.type === 'sawtooth')).toBe(true);
      expect(audio.play(cue({ kind: 'active', phase: 'active', element: 'arcane', durationTicks: 20, intensity: 1 }))).toBe(true);
      expect(context.oscillators.slice(before + 3).every(node => node.type === 'triangle')).toBe(true);
    });
  });
});
