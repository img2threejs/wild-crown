import { describe, expect, it } from 'bun:test';
import * as THREE from 'three';
import type { AudioListener } from 'three';
import { CANOPY_MAX_VOICES, isCanopyCue } from '../../src/audio/CanopySounds.js';
import { MOONPINE_ATTACK_IDS, MOONPINE_ROARS, isMoonpineCue, moonpineLayers } from '../../src/audio/MoonpineSounds.js';
import { WARDEN_MAX_LAYERS, WARDEN_MAX_LEVEL, WARDEN_MAX_SECONDS, isWardenCue, type SoundLayer } from '../../src/audio/WardenSounds.js';
import { StoryPresentation } from '../../src/effects/StoryPresentation.js';
import type { StoryCue } from '../../src/effects/story-cues.js';
import { ATTACKS } from '../../src/game/combat/content.js';
import type { AttackId } from '../../src/game/contracts.js';

// Scheduler-only instrument (as in canopy-audio.test.ts): it records the nodes the synth builds; it does not measure audible output.
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
const ACTOR_OF: Readonly<Record<string, string>> = { frostfang: 'moonpine-frostfang', 'howl-scout': 'moonpine-scout', 'chained-ruun': 'moonpine-ruun' };
const ownerOf = (attackId: string): string => ACTOR_OF[attackId.startsWith('howl-scout') ? 'howl-scout' : attackId.startsWith('chained-ruun') ? 'chained-ruun' : 'frostfang']!;
function attackCue(attackId: string, phase: 'anticipation' | 'commit' | 'active' | 'hit', partial: Partial<StoryCue> = {}): StoryCue {
  return {
    instanceId: `moonpine-audio:${++sequence}`, tick: 60, worldTick: 60, worldTimeSeconds: 1, kind: phase, phase, attackId: attackId as AttackId, actorId: ownerOf(attackId),
    priority: 'essential', durationTicks: ATTACKS[attackId]?.activeTicks ?? 12, element: ATTACKS[attackId]?.element, position: { x: 4, y: 0, z: -3 }, ...partial,
  } as StoryCue;
}
const roarCue = (actorId: string, partial: Partial<StoryCue> = {}): StoryCue => ({
  instanceId: `moonpine-roar:${++sequence}`, tick: 60, worldTick: 60, worldTimeSeconds: 1, kind: 'roar-cone', phase: 'anticipation', actorId, priority: 'essential', durationTicks: 54, intensity: 1,
  shape: 'sector', position: { x: 4, y: 0, z: -3 }, footprint: { width: 8, length: 6, angleRadians: 0, sectorRadians: 1.4 }, ...partial,
}) as StoryCue;

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

const PHASES = ['anticipation', 'commit', 'active', 'hit'] as const;
function expectBudget(layers: readonly SoundLayer[], label: string): void {
  expect(layers.length, label).toBeGreaterThan(0);
  expect(layers.length, label).toBeLessThanOrEqual(WARDEN_MAX_LAYERS);
  for (const layer of layers) {
    expect(layer.level, label).toBeGreaterThan(0);
    expect(layer.level, label).toBeLessThanOrEqual(WARDEN_MAX_LEVEL);
    expect(layer.delay + layer.length, label).toBeLessThanOrEqual(WARDEN_MAX_SECONDS);
    expect(layer.attack, label).toBeGreaterThan(0);
    for (const value of [layer.from, layer.to, layer.filterFrom, layer.filterTo, layer.q]) if (value !== undefined) { expect(Number.isFinite(value), label).toBe(true); expect(value, label).toBeGreaterThan(0); }
    if (layer.source === 'tone') { expect(layer.wave, label).toBeDefined(); expect(layer.from, label).toBeDefined(); } else expect(layer.noise, label).toBeDefined();
  }
}
const tones = (layers: readonly SoundLayer[]): SoundLayer[] => layers.filter(layer => layer.source === 'tone');
const noises = (layers: readonly SoundLayer[]): SoundLayer[] => layers.filter(layer => layer.source === 'noise');
const layersOf = (attackId: string, phase: typeof PHASES[number], partial: Partial<StoryCue> = {}): readonly SoundLayer[] => moonpineLayers(attackCue(attackId, phase, partial))!;

describe('moonpine sound recipes', () => {
  it('registers a timbre for every Moonpine attack and phase, inside the voice, level and length budgets', () => {
    expect([...MOONPINE_ATTACK_IDS].sort()).toEqual([
      'chained-ruun-breaking-ice', 'chained-ruun-chain-pounce', 'chained-ruun-howl-shockwave', 'frostfang-frost-breath', 'frostfang-ice-bite', 'frostfang-pack-rush',
      'howl-scout-claw-rake', 'howl-scout-flank-pounce', 'howl-scout-low-howl',
    ]);
    for (const attackId of MOONPINE_ATTACK_IDS) {
      expect(ATTACKS[attackId], attackId).toBeDefined();
      for (const phase of PHASES) {
        const cue = attackCue(attackId, phase);
        expect(isMoonpineCue(cue), `${attackId}/${phase}`).toBe(true);
        expect(isWardenCue(cue)).toBe(false);
        expect(isCanopyCue(cue)).toBe(false);
        expectBudget(moonpineLayers(cue)!, `${attackId}/${phase}`);
      }
    }
    for (const [actorId, voice] of Object.entries(MOONPINE_ROARS)) {
      expect(MOONPINE_ROARS[actorId]).toBe(voice);
      for (const intensity of [0.4, 1, 1.5]) expectBudget(moonpineLayers(roarCue(actorId, { intensity }))!, `${voice} roar`);
    }
  });

  it('leaves every non-Moonpine cue on its existing audio path', () => {
    expect(isMoonpineCue(attackCue('boar-charge', 'active', { actorId: 'corrupted-boar' }))).toBe(false);
    expect(isMoonpineCue(attackCue('howler-rock-hurl', 'active', { actorId: 'canopy-howler' }))).toBe(false);
    expect(isMoonpineCue(roarCue('asha'))).toBe(false);
    expect(isMoonpineCue(roarCue('canopy-howler'))).toBe(false);
    expect(isMoonpineCue(roarCue('corrupted-boar'))).toBe(false);
    expect(isMoonpineCue({ ...attackCue('frostfang-pack-rush', 'active'), kind: 'landing', phase: 'landing' } as StoryCue)).toBe(false);
    expect(moonpineLayers(attackCue('sap-vein-snap', 'commit'))).toBeUndefined();
    expect(moonpineLayers(attackCue('howler-rock-hurl', 'active'))).toBeUndefined();
  });

  it('shapes the frost wolves: snarls and paws, a long freezing breath, ice cracks', () => {
    const rushActive = layersOf('frostfang-pack-rush', 'active');
    expect(tones(rushActive).filter(layer => layer.wave === 'sine' && layer.from! <= 120 && layer.to! < layer.from!).length).toBeGreaterThanOrEqual(3); // paws drumming
    expect(new Set(tones(rushActive).filter(layer => layer.wave === 'sine').map(layer => layer.delay)).size).toBeGreaterThanOrEqual(3);
    expect(noises(rushActive).some(layer => layer.noise === 'wind' && layer.filterTo! < layer.filterFrom! && layer.length >= 0.5)).toBe(true); // pass-by
    const biteActive = layersOf('frostfang-ice-bite', 'active');
    expect(noises(biteActive).some(layer => layer.noise === 'crackle' && layer.filter === 'bandpass' && layer.filterFrom! >= 4200)).toBe(true); // rime cracks
    expect(noises(biteActive).some(layer => layer.length < 0.05 && layer.filter === 'highpass')).toBe(true); // the click of the jaws
    const chatter = tones(layersOf('frostfang-ice-bite', 'anticipation')).filter(layer => layer.length < 0.1);
    expect(chatter.length).toBeGreaterThanOrEqual(3); // teeth chattering
    const breath = layersOf('frostfang-frost-breath', 'active');
    expect(noises(breath).some(layer => layer.noise === 'white' && layer.filter === 'highpass' && layer.filterFrom! >= 5200 && layer.length >= 0.8)).toBe(true);
    expect(tones(breath).filter(layer => layer.from! > 2500).length).toBeGreaterThanOrEqual(2); // glassy glints
    const inhale = layersOf('frostfang-frost-breath', 'anticipation');
    expect(noises(inhale).some(layer => layer.noise === 'wind' && layer.filterTo! > layer.filterFrom!)).toBe(true); // the inhale rises
  });

  it('shapes the scout: yips and scrabbling, claws, a rising low howl with a rolling shockwave', () => {
    const yips = tones(layersOf('howl-scout-flank-pounce', 'anticipation')).filter(layer => layer.length < 0.2);
    expect(yips.length).toBeGreaterThanOrEqual(3);
    expect(new Set(yips.map(layer => layer.delay)).size).toBe(yips.length);
    expect(yips.every(layer => layer.to! > layer.from!)).toBe(true); // each yip climbs
    const landing = layersOf('howl-scout-flank-pounce', 'active');
    expect(tones(landing).some(layer => layer.from! <= 120 && layer.to! <= 40 && layer.length > 0.3)).toBe(true);
    const rake = layersOf('howl-scout-claw-rake', 'active');
    expect(noises(rake).filter(layer => layer.noise === 'white' && layer.filter === 'bandpass').length).toBeGreaterThanOrEqual(2); // two swipes
    const climb = tones(layersOf('howl-scout-low-howl', 'anticipation'));
    expect(climb.length).toBeGreaterThanOrEqual(2);
    expect(climb.every(layer => layer.to! > layer.from!)).toBe(true);
    const shockwave = layersOf('howl-scout-low-howl', 'active');
    expect(tones(shockwave).some(layer => layer.from! <= 110 && layer.to! < 50 && layer.length >= 0.7)).toBe(true); // low swell
    expect(noises(shockwave).some(layer => layer.noise === 'wind' && layer.filterTo! < layer.filterFrom! && layer.length >= 0.6)).toBe(true);
  });

  it("shapes Ruun: chains rattling, the three-beat howl, a deep boom and cracking ice", () => {
    const rattle = (layers: readonly SoundLayer[]) => tones(layers).filter(layer => layer.wave === 'triangle' && layer.from! >= 1700);
    expect(rattle(layersOf('chained-ruun-chain-pounce', 'anticipation')).length).toBeGreaterThanOrEqual(3);
    expect(rattle(layersOf('chained-ruun-chain-pounce', 'commit')).length).toBeGreaterThanOrEqual(3);
    expect(rattle(layersOf('chained-ruun-chain-pounce', 'active')).length).toBeGreaterThanOrEqual(3);
    const boom = layersOf('chained-ruun-chain-pounce', 'active');
    expect(tones(boom).some(layer => layer.from! <= 80 && layer.to! <= 30 && layer.length >= 0.5)).toBe(true);
    // Three-beat howl: three rising notes, each starting later and lasting longer than the last.
    const beats = tones(layersOf('chained-ruun-howl-shockwave', 'anticipation')).filter(layer => layer.wave === 'triangle');
    expect(beats).toHaveLength(3);
    for (let index = 1; index < beats.length; index++) {
      expect(beats[index]!.delay).toBeGreaterThan(beats[index - 1]!.delay);
      expect(beats[index]!.from!).toBeGreaterThan(beats[index - 1]!.from!);
      expect(beats[index]!.length).toBeGreaterThan(beats[index - 1]!.length);
    }
    const burst = layersOf('chained-ruun-howl-shockwave', 'active');
    expect(tones(burst).some(layer => layer.from! <= 80 && layer.to! <= 30 && layer.length >= 0.8)).toBe(true);
    expect(noises(burst).some(layer => layer.noise === 'wind' && layer.length >= 0.7)).toBe(true);
    const split = layersOf('chained-ruun-breaking-ice', 'active');
    expect(noises(split).some(layer => layer.noise === 'crackle' && layer.filterTo! < layer.filterFrom! && layer.length >= 0.6)).toBe(true); // the long running crack
    expect(tones(split).some(layer => layer.from! <= 70 && layer.to! <= 30)).toBe(true);
    expect(noises(layersOf('chained-ruun-breaking-ice', 'commit')).some(layer => layer.filter === 'bandpass' && layer.filterFrom! >= 4300)).toBe(true);
  });

  it('gives each wolf its own roar: guttural snarl-bark, yipping high howl, deep chained howl', () => {
    const frostfang = moonpineLayers(roarCue('moonpine-frostfang'))!, scout = moonpineLayers(roarCue('moonpine-scout'))!, ruun = moonpineLayers(roarCue('moonpine-ruun'))!;
    expect(tones(frostfang).every(layer => layer.from! < 260)).toBe(true);
    expect(tones(frostfang).filter(layer => layer.wave === 'sawtooth' && layer.to! < layer.from! && layer.length < 0.5).length).toBe(2); // two barks
    expect(tones(scout).some(layer => layer.from! >= 600 && layer.to! > layer.from!)).toBe(true); // the howl climbs
    expect(tones(scout).filter(layer => layer.length < 0.2 && layer.wave === 'sawtooth')).toHaveLength(2); // yelps
    expect(Math.min(...tones(scout).map(layer => layer.from!))).toBeGreaterThanOrEqual(600);
    expect(tones(ruun).some(layer => layer.from! < 70 && layer.length >= 0.5)).toBe(true); // sub-bass chest
    expect(tones(ruun).some(layer => layer.wave === 'sawtooth' && layer.to! > layer.from! && layer.length >= 0.5)).toBe(true); // the long rising howl
    expect(tones(ruun).filter(layer => layer.from! >= 1700).length).toBeGreaterThanOrEqual(3); // chains
    // Three distinct voices.
    const pitchOf = (layers: readonly SoundLayer[]): number => Math.max(...tones(layers).map(layer => layer.from!));
    expect(new Set([pitchOf(frostfang), pitchOf(scout), pitchOf(ruun)]).size).toBe(3);
    expect(pitchOf(scout)).toBeGreaterThan(pitchOf(frostfang));
    // Louder roar escalation, never beyond the level budget.
    const soft = moonpineLayers(roarCue('moonpine-ruun', { intensity: 0.4 }))!, loud = moonpineLayers(roarCue('moonpine-ruun', { intensity: 1.5 }))!;
    expect(Math.max(...loud.map(layer => layer.level))).toBeGreaterThan(Math.max(...soft.map(layer => layer.level)));
    // Deterministic per cue id: the same cue always sounds the same.
    const fixed = attackCue('frostfang-pack-rush', 'active');
    expect(moonpineLayers(fixed)).toEqual(moonpineLayers(fixed));
    // Another cue id varies the pitch a little (+-6 %), never the structure.
    const other = moonpineLayers(attackCue('frostfang-pack-rush', 'active', { instanceId: 'moonpine-audio:other-voice' }))!;
    expect(other.length).toBe(moonpineLayers(fixed)!.length);
    for (const [index, layer] of other.entries()) expect(Math.abs((layer.from ?? 1) / (moonpineLayers(fixed)![index]!.from ?? 1) - 1)).toBeLessThan(0.13);
  });
});

describe('moonpine cues through StoryAudio', () => {
  it('voices Moonpine cues from procedural layers on the effects bus and releases them with their scope', async () => {
    await session((presentation, context) => {
      const audio = presentation.audio, cue = attackCue('chained-ruun-howl-shockwave', 'active', { scopeId: 'howl-1' });
      expect(audio.play(cue)).toBe(true);
      expect(audio.playbackMetadata.activeVoices).toBe(1);
      expect(audio.playbackMetadata.lastPlayed).toMatchObject({ instanceId: cue.instanceId, kind: 'active', bus: 'effects' });
      expect(context.oscillators.length).toBeGreaterThan(0);
      expect(context.bufferSources.length).toBeGreaterThan(0);
      expect(audio.play(cue)).toBe(false); // de-duplicated by instance id like every other cue
      audio.cancelScope('howl-1', 'interrupt');
      expect(audio.playbackMetadata.activeVoices).toBe(0);
      expect(context.oscillators.every(node => node.stopped)).toBe(true);
      expect(audio.play(roarCue('moonpine-scout'))).toBe(true);
      expect(audio.playbackMetadata.activeVoices).toBe(1);
    });
  });

  it('shares the bounded wildlife voice pool: a barrage never exceeds the cap and never steals Warden voices', async () => {
    await session((presentation) => {
      const audio = presentation.audio;
      for (let i = 0; i < 4; i++) audio.play({ instanceId: `slash:${i}`, tick: 1, worldTick: 1, worldTimeSeconds: 0, kind: 'slash', phase: 'active', actorId: 'aren', durationTicks: 6, element: 'arcane', priority: 'essential' } as StoryCue);
      const warden = audio.playbackMetadata.activeVoices;
      expect(warden).toBe(4);
      for (let i = 0; i < 20; i++) audio.play(attackCue(MOONPINE_ATTACK_IDS[i % MOONPINE_ATTACK_IDS.length]!, PHASES[i % PHASES.length]!, { scopeId: `barrage:${i}` }));
      expect(audio.playbackMetadata.activeVoices).toBe(warden + CANOPY_MAX_VOICES);
      audio.cancelAll('unload');
      expect(audio.playbackMetadata.activeVoices).toBe(0);
    });
  });

  it('leaves non-Moonpine attacks on the generic elemental arrangement', async () => {
    await session((presentation, context) => {
      const audio = presentation.audio;
      expect(audio.play({ instanceId: 'boar-ember', tick: 1, worldTick: 1, worldTimeSeconds: 0, kind: 'anticipation', phase: 'anticipation', attackId: 'boar-ember-lance' as AttackId, actorId: 'corrupted-boar', element: 'fire', priority: 'essential', durationTicks: 40 } as StoryCue)).toBe(true);
      // Generic path: triad of oscillators + one elemental noise bed (3 + 1 voices), not a Moonpine layer recipe.
      expect(context.oscillators.length).toBe(3);
      expect(context.bufferSources.length).toBe(1);
    });
  });
});
