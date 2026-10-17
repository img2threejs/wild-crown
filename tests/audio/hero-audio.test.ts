import { describe, expect, it } from 'bun:test';
import * as THREE from 'three';
import type { AudioListener } from 'three';
import { StoryPresentation } from '../../src/effects/StoryPresentation.js';
import type { StoryCue } from '../../src/effects/story-cues.js';
import { emberLayers } from '../../src/audio/EmberSounds.js';
import { umbralLayers } from '../../src/audio/UmbralSounds.js';
import { WARDEN_MAX_LAYERS, WARDEN_MAX_LEVEL, WARDEN_MAX_SECONDS, wardenLayers, type SoundLayer } from '../../src/audio/WardenSounds.js';
import { heartrootLayers } from '../../src/audio/HeartrootSounds.js';
import type { ActionId } from '../../src/game/contracts.js';

// Scheduler-only instrument (see warden-audio.test.ts): it records the nodes the synth builds; it does not measure audible output.
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
  return { instanceId: `hero-audio:${++sequence}`, tick: 60, worldTick: 60, worldTimeSeconds: 1, priority: 'essential', actorId: 'aren', ...partial };
}
async function session(test: (presentation: StoryPresentation, context: Context) => void): Promise<void> {
  const previous = globalThis.AudioContext;
  globalThis.AudioContext = Context as unknown as typeof AudioContext;
  const context = new Context(), presentation = new StoryPresentation({ scene: new THREE.Scene(), audioListener: { context } as unknown as AudioListener });
  try {
    expect(await presentation.unlockAudio()).toBe(true);
    test(presentation, context);
  } finally {
    presentation.dispose();
    if (previous === undefined) delete (globalThis as { AudioContext?: typeof AudioContext }).AudioContext; else globalThis.AudioContext = previous;
  }
}

type Element = 'umbral' | 'ember';
const recipe = (element: Element, partial: Partial<StoryCue> & Pick<StoryCue, 'kind' | 'phase'>): readonly SoundLayer[] | undefined => {
  const emitted = cue({ element, ...partial });
  return element === 'umbral' ? umbralLayers(emitted) : emberLayers(emitted);
};
const action = (value: string): ActionId => value as ActionId;

const VESPER_CUES: readonly (Partial<StoryCue> & Pick<StoryCue, 'kind' | 'phase'>)[] = [
  ...['vesper-iai-1', 'vesper-iai-2', 'vesper-iai-3', 'vesper-iai-4', 'vesper-thousand-cuts'].map(clip => ({ kind: 'slash' as const, phase: 'active' as const, actionId: action(clip), durationTicks: 6, intensity: 1 })),
  { kind: 'slash', phase: 'active', actionId: action('vesper-iai-3'), durationTicks: 9, intensity: 2 },
  ...['vesper-shadow-step', 'vesper-mist-blink', 'vesper-shade-swap', 'vesper-thousand-cuts', 'vesper-requiem', 'vesper-severing-shadow'].map(clip => ({ kind: 'blink' as const, phase: 'commit' as const, actionId: action(clip), durationTicks: 14 })),
  { kind: 'perfect-dodge', phase: 'commit', actionId: action('aren-perfect-dodge-left'), durationTicks: 14 },
  { kind: 'beam', phase: 'active', actionId: action('vesper-iai-4'), durationTicks: 12 },
  { kind: 'tether', phase: 'active', actionId: action('vesper-severing-shadow') },
  { kind: 'sigil', phase: 'sustain', actionId: action('vesper-cuts-charge'), durationTicks: 600 },
  { kind: 'sigil', phase: 'sustain', actionId: action('vesper-shade-charge'), durationTicks: 600 },
  { kind: 'projectile', phase: 'commit', actionId: action('vesper-kunai-fan') },
  { kind: 'projectile-impact', phase: 'hit', actionId: action('vesper-kunai-fan') },
  { kind: 'cleanse', phase: 'active', actionId: action('vesper-cleanse') },
  { kind: 'judgement', phase: 'anticipation', actionId: action('vesper-requiem') },
  { kind: 'judgement', phase: 'commit', actionId: action('vesper-requiem') },
  { kind: 'judgement', phase: 'resolve', actionId: action('vesper-requiem') },
  { kind: 'judgement-mark', phase: 'anticipation', actionId: action('vesper-requiem') },
  { kind: 'judgement-mark', phase: 'hit', actionId: action('vesper-requiem'), intensity: 1.6 },
  { kind: 'hit', phase: 'hit', actionId: action('vesper-iai-1'), intensity: 1.2 },
];
const SAKDA_CUES: readonly (Partial<StoryCue> & Pick<StoryCue, 'kind' | 'phase'>)[] = [
  ...['sakda-limb-1', 'sakda-limb-2', 'sakda-limb-3', 'sakda-limb-4', 'sakda-flying-knee', 'sakda-tempest', 'sakda-tigers-wrath', 'sakda-hundred-elbows'].map(clip => ({ kind: 'slash' as const, phase: 'active' as const, actionId: action(clip), durationTicks: 10, intensity: 1 })),
  ...['sakda-limb-1', 'sakda-limb-3', 'sakda-limb-4', 'sakda-flying-knee', 'sakda-tigers-wrath', 'sakda-resonating-strike'].map(clip => ({ kind: 'hit' as const, phase: 'hit' as const, actionId: action(clip), intensity: 1.2 })),
  ...['sakda-resonating-strike', 'sakda-guard-dash', 'sakda-flying-knee', 'sakda-tigers-wrath'].map(clip => ({ kind: 'blink' as const, phase: 'commit' as const, actionId: action(clip), durationTicks: 14 })),
  { kind: 'perfect-dodge', phase: 'commit', actionId: action('aren-perfect-dodge-right'), durationTicks: 14 },
  { kind: 'beam', phase: 'active', actionId: action('sakda-tigers-wrath'), durationTicks: 20 },
  { kind: 'tether', phase: 'active', actionId: action('sakda-iron-clinch') },
  { kind: 'sigil', phase: 'sustain', actionId: action('sakda-elbow-charge'), durationTicks: 600 },
  { kind: 'sigil', phase: 'sustain', actionId: action('sakda-knee-charge'), durationTicks: 600 },
  { kind: 'projectile', phase: 'commit', actionId: action('sakda-echo-wave') },
  { kind: 'projectile-impact', phase: 'hit', actionId: action('sakda-echo-wave') },
  { kind: 'cleanse', phase: 'active', actionId: action('sakda-cleanse') },
  { kind: 'bloom', phase: 'hit', actionId: action('sakda-tempest') },
];
const ALL: readonly (readonly [Element, Partial<StoryCue> & Pick<StoryCue, 'kind' | 'phase'>])[] = [...VESPER_CUES.map(c => ['umbral', c] as const), ...SAKDA_CUES.map(c => ['ember', c] as const)];

describe('Vesper and Sakda sound recipes', () => {
  it('every recipe stays inside the Warden voice budgets: ≤ 8 layers, level, length, positive finite frequencies', () => {
    for (const [element, partial] of ALL) {
      const layers = recipe(element, partial);
      const label = `${element}/${partial.kind}/${partial.phase}/${partial.actionId}`;
      expect(layers, label).toBeDefined();
      expect(layers!.length, label).toBeGreaterThan(0);
      expect(layers!.length, label).toBeLessThanOrEqual(WARDEN_MAX_LAYERS);
      for (const layer of layers!) {
        expect(layer.level, label).toBeGreaterThan(0);
        expect(layer.level, label).toBeLessThanOrEqual(WARDEN_MAX_LEVEL);
        expect(layer.delay + layer.length, label).toBeLessThanOrEqual(WARDEN_MAX_SECONDS);
        expect(layer.attack, label).toBeGreaterThan(0);
        for (const value of [layer.from, layer.to, layer.filterFrom, layer.filterTo]) if (value !== undefined) { expect(Number.isFinite(value)).toBe(true); expect(value).toBeGreaterThan(0); }
        if (layer.source === 'tone') { expect(layer.wave, label).toBeDefined(); expect(layer.from, label).toBeDefined(); } else expect(layer.noise, label).toBeDefined();
      }
    }
  });

  it('silent phases return nothing and an unknown kind falls through to the generic path', () => {
    expect(recipe('umbral', { kind: 'judgement', phase: 'sustain', actionId: action('vesper-requiem') })).toBeUndefined();
    expect(recipe('umbral', { kind: 'active', phase: 'active' })).toBeUndefined();
    expect(recipe('ember', { kind: 'active', phase: 'active' })).toBeUndefined();
    expect(recipe('ember', { kind: 'heartbeat', phase: 'active' })).toBeUndefined();
  });

  it('Vesper: whispered swish plus thin metallic partials on the blade, a hollow blink whoosh, a hard crimson detonation', () => {
    for (const clip of ['vesper-iai-1', 'vesper-iai-2', 'vesper-iai-3']) {
      const swish = recipe('umbral', { kind: 'slash', phase: 'active', actionId: action(clip), durationTicks: 6 })!;
      expect(swish.some(layer => layer.source === 'noise' && layer.noise === 'wind' && layer.filter === 'bandpass'), clip).toBe(true);
      expect(swish.filter(layer => layer.source === 'tone' && layer.from! > 2000 && layer.wave === 'sine').length, clip).toBeGreaterThanOrEqual(3);
      expect(swish.every(layer => layer.level < 0.05), clip).toBe(true);
    }
    const rift = recipe('umbral', { kind: 'slash', phase: 'active', actionId: action('vesper-iai-4'), durationTicks: 12 })!;
    expect(rift.some(layer => layer.source === 'tone' && layer.from! < 300 && layer.to! < layer.from!)).toBe(true);
    const step = recipe('umbral', { kind: 'blink', phase: 'commit', actionId: action('vesper-shadow-step'), durationTicks: 14 })!;
    expect(step.some(layer => layer.noise === 'wind' && layer.filterFrom! > layer.filterTo!)).toBe(true);
    expect(step.some(layer => layer.source === 'tone' && layer.to! < layer.from!)).toBe(true);
    const mist = recipe('umbral', { kind: 'blink', phase: 'commit', actionId: action('vesper-mist-blink'), durationTicks: 14 })!;
    expect(mist.some(layer => layer.noise === 'wind' && layer.filterTo! > layer.filterFrom!)).toBe(true);
    expect(JSON.stringify(mist)).not.toBe(JSON.stringify(step));
    const boom = recipe('umbral', { kind: 'judgement-mark', phase: 'hit', actionId: action('vesper-requiem'), intensity: 1.6 })!;
    expect(boom.some(layer => layer.source === 'tone' && layer.from! < 130 && layer.level >= 0.06)).toBe(true);
    expect(boom.some(layer => layer.noise === 'crackle')).toBe(true);
    const ping = recipe('umbral', { kind: 'judgement-mark', phase: 'anticipation', actionId: action('vesper-requiem') })!;
    expect(ping.every(layer => layer.source === 'tone' && layer.level <= 0.02)).toBe(true);
  });

  it('Sakda: meaty thuds for fists and elbows, a crack for kicks and knees, a fire roar for the roundhouse and Tiger\'s Wrath, a shield hum on Guard Dash', () => {
    const jab = recipe('ember', { kind: 'hit', phase: 'hit', actionId: action('sakda-limb-1'), intensity: 1.2 })!;
    expect(jab.some(layer => layer.source === 'tone' && layer.wave === 'sine' && layer.from! < 150 && layer.to! < layer.from!)).toBe(true);
    expect(jab.some(layer => layer.source === 'noise' && layer.length < 0.05)).toBe(true);
    const kick = recipe('ember', { kind: 'hit', phase: 'hit', actionId: action('sakda-limb-4'), intensity: 1.2 })!;
    expect(kick.some(layer => layer.noise === 'white' && layer.filter === 'highpass' && layer.length < 0.06)).toBe(true);
    expect(kick.length).toBeGreaterThan(jab.length);
    const knee = recipe('ember', { kind: 'hit', phase: 'hit', actionId: action('sakda-flying-knee'), intensity: 1.2 })!;
    expect(knee.some(layer => layer.source === 'tone' && layer.from! < 120 && layer.level >= 0.07)).toBe(true);
    for (const clip of ['sakda-limb-4', 'sakda-tigers-wrath']) {
      const roar = recipe('ember', { kind: 'slash', phase: 'active', actionId: action(clip), durationTicks: 10 })!;
      expect(roar.some(layer => layer.noise === 'wind'), clip).toBe(true);
      expect(roar.some(layer => layer.noise === 'crackle'), clip).toBe(true);
    }
    const guard = recipe('ember', { kind: 'blink', phase: 'commit', actionId: action('sakda-guard-dash'), durationTicks: 14 })!;
    const dash = recipe('ember', { kind: 'blink', phase: 'commit', actionId: action('sakda-resonating-strike'), durationTicks: 14 })!;
    expect(guard.filter(layer => layer.source === 'tone' && layer.from === layer.to && layer.length > 0.5).length).toBeGreaterThanOrEqual(2);
    expect(dash.some(layer => layer.source === 'tone' && layer.from === layer.to && layer.length > 0.5)).toBe(false);
  });

  it('the two families and the older heroes sound different for the same cue', () => {
    const base = { kind: 'hit' as const, phase: 'hit' as const, intensity: 1.2 };
    const signatures = [
      JSON.stringify(recipe('umbral', { ...base, actionId: action('vesper-iai-1') })),
      JSON.stringify(recipe('ember', { ...base, actionId: action('sakda-limb-1') })),
      JSON.stringify(wardenLayers(cue({ ...base, element: 'arcane' }))),
      JSON.stringify(heartrootLayers(cue({ ...base, element: 'heartroot' }))),
    ];
    expect(new Set(signatures).size).toBe(4);
  });
});

describe('Vesper and Sakda playback through StoryAudio', () => {
  it('plays on the effects bus, is one-shot, retires when its sources end and tears down on scope cancel', async () => {
    await session((presentation, context) => {
      const audio = presentation.audio;
      for (const [element, clip] of [['umbral', 'vesper-iai-1'], ['ember', 'sakda-limb-1']] as const) {
        const slash = cue({ kind: 'slash', phase: 'active', element, actionId: action(clip), durationTicks: 6, scopeId: `${clip}:1` });
        const oscillatorsBefore = context.oscillators.length, buffersBefore = context.bufferSources.length;
        expect(audio.play(slash)).toBe(true);
        expect(audio.play(slash)).toBe(false);
        expect(audio.playbackMetadata.lastPlayed?.bus).toBe('effects');
        const sources = [...context.oscillators.slice(oscillatorsBefore), ...context.bufferSources.slice(buffersBefore)];
        expect(sources.length).toBe((element === 'umbral' ? umbralLayers(slash) : emberLayers(slash))!.length);
        for (const source of sources) source.stop();
        expect(audio.playbackMetadata.activeVoices).toBe(0);
        expect(sources.every(source => source.disconnected)).toBe(true);
        const charge = cue({ kind: 'sigil', phase: 'sustain', element, actionId: action(element === 'umbral' ? 'vesper-cuts-charge' : 'sakda-knee-charge'), scopeId: `${clip}:charge`, durationTicks: 600 });
        const voices = context.oscillators.length;
        expect(audio.play(charge)).toBe(true);
        presentation.onInterrupt(`${clip}:charge`);
        expect(audio.playbackMetadata.activeVoices).toBe(0);
        expect(context.oscillators.slice(voices).every(node => node.stopped && node.disconnected)).toBe(true);
      }
    });
  });

  it('shares the ten-voice Warden pool: bursts of Vesper and Sakda cues never exceed it, the oldest is stolen, and death silences everything', async () => {
    await session((presentation, context) => {
      const audio = presentation.audio;
      for (let i = 0; i < 24; i++) {
        const element: Element = i % 2 ? 'ember' : 'umbral';
        expect(audio.play(cue({ kind: 'hit', phase: 'hit', element, actionId: action(element === 'umbral' ? 'vesper-iai-1' : 'sakda-limb-4'), scopeId: `hit:${i}`, intensity: 1.2 }))).toBe(true);
        expect(audio.playbackMetadata.activeVoices).toBeLessThanOrEqual(10);
      }
      expect(audio.playbackMetadata.activeVoices).toBeGreaterThan(0);
      presentation.onDeath();
      expect(audio.playbackMetadata.activeVoices).toBe(0);
      expect([...context.oscillators, ...context.bufferSources].every(node => node.stopped)).toBe(true);
    });
  });

  it('silent phases play nothing; hero-element cues without a recipe use the generic timbre of their element', async () => {
    await session((presentation, context) => {
      const audio = presentation.audio;
      expect(audio.play(cue({ kind: 'judgement', phase: 'sustain', element: 'umbral', actionId: action('vesper-requiem') }))).toBe(false);
      expect(audio.playbackMetadata.activeVoices).toBe(0);
      const before = context.oscillators.length;
      expect(audio.play(cue({ kind: 'active', phase: 'active', element: 'umbral', durationTicks: 20, intensity: 1 }))).toBe(true);
      const umbral = context.oscillators.slice(before);
      expect(umbral.length).toBe(3);
      expect(umbral.every(node => node.type === 'sawtooth')).toBe(true);
      expect(audio.play(cue({ kind: 'active', phase: 'active', element: 'ember', durationTicks: 20, intensity: 1 }))).toBe(true);
      expect(context.oscillators.slice(before + 3).every(node => node.type === 'sine')).toBe(true);
    });
  });

  it('does not change how Aren and Yara cues are voiced', async () => {
    await session((presentation, context) => {
      const audio = presentation.audio;
      const arenSlash = cue({ kind: 'slash', phase: 'active', element: 'arcane', durationTicks: 4, intensity: 1 }), yaraBurst = cue({ kind: 'bloom', phase: 'hit', element: 'heartroot', durationTicks: 20 });
      let before = context.oscillators.length + context.bufferSources.length;
      expect(audio.play(arenSlash)).toBe(true);
      expect(context.oscillators.length + context.bufferSources.length - before).toBe(wardenLayers(arenSlash)!.length);
      before = context.oscillators.length + context.bufferSources.length;
      expect(audio.play(yaraBurst)).toBe(true);
      expect(context.oscillators.length + context.bufferSources.length - before).toBe(heartrootLayers(yaraBurst).length);
    });
  });
});
