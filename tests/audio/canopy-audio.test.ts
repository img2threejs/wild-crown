import { describe, expect, it } from 'bun:test';
import * as THREE from 'three';
import type { AudioListener } from 'three';
import { CANOPY_ATTACK_IDS, CANOPY_MAX_VOICES, CANOPY_ROARS, canopyLayers, isCanopyCue } from '../../src/audio/CanopySounds.js';
import { WARDEN_MAX_LAYERS, WARDEN_MAX_LEVEL, WARDEN_MAX_SECONDS, isWardenCue, type SoundLayer } from '../../src/audio/WardenSounds.js';
import { StoryPresentation } from '../../src/effects/StoryPresentation.js';
import type { StoryCue } from '../../src/effects/story-cues.js';
import { ATTACKS } from '../../src/game/combat/content.js';
import type { AttackId } from '../../src/game/contracts.js';

// Scheduler-only instrument (as in warden-audio.test.ts): it records the nodes the synth builds; it does not measure audible output.
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
const ACTOR: Readonly<Record<string, string>> = { howler: 'canopy-howler', hornbill: 'canopy-hornbill', viper: 'canopy-mire-viper' };
function attackCue(attackId: string, phase: 'anticipation' | 'commit' | 'active' | 'hit', partial: Partial<StoryCue> = {}): StoryCue {
  const species = attackId.split('-')[0]!;
  return {
    instanceId: `canopy-audio:${++sequence}`, tick: 60, worldTick: 60, worldTimeSeconds: 1, kind: phase, phase, attackId: attackId as AttackId, actorId: ACTOR[species],
    priority: 'essential', durationTicks: ATTACKS[attackId]?.activeTicks ?? 12, element: ATTACKS[attackId]?.element, position: { x: 4, y: 0, z: -3 }, ...partial,
  } as StoryCue;
}
const roarCue = (actorId: string, partial: Partial<StoryCue> = {}): StoryCue => ({
  instanceId: `canopy-roar:${++sequence}`, tick: 60, worldTick: 60, worldTimeSeconds: 1, kind: 'roar-cone', phase: 'anticipation', actorId, priority: 'essential', durationTicks: 54, intensity: 1,
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

describe('canopy sound recipes', () => {
  it('registers a timbre for every canopy attack and phase, inside the voice, level and length budgets', () => {
    expect([...CANOPY_ATTACK_IDS].sort()).toEqual(['hornbill-dive-bomb', 'hornbill-feather-volley', 'hornbill-gale-flap', 'howler-branch-sweep', 'howler-leap-slam', 'howler-rock-hurl', 'viper-strike-lunge', 'viper-tail-lash', 'viper-venom-spit']);
    for (const attackId of CANOPY_ATTACK_IDS) {
      expect(ATTACKS[attackId], attackId).toBeDefined();
      for (const phase of PHASES) {
        const cue = attackCue(attackId, phase);
        expect(isCanopyCue(cue), `${attackId}/${phase}`).toBe(true);
        expect(isWardenCue(cue)).toBe(false);
        expectBudget(canopyLayers(cue)!, `${attackId}/${phase}`);
      }
    }
    for (const [species, actorId] of Object.entries(ACTOR)) {
      expect(CANOPY_ROARS[actorId]).toBe(species);
      for (const intensity of [0.4, 1, 1.5]) expectBudget(canopyLayers(roarCue(actorId, { intensity }))!, `${species} roar`);
    }
  });

  it('leaves every non-canopy cue on its existing audio path', () => {
    expect(isCanopyCue(attackCue('boar-charge', 'active', { actorId: 'corrupted-boar' }))).toBe(false);
    expect(isCanopyCue(roarCue('asha'))).toBe(false);
    expect(isCanopyCue(roarCue('corrupted-boar'))).toBe(false);
    expect(isCanopyCue({ ...attackCue('howler-rock-hurl', 'active'), kind: 'landing', phase: 'landing' } as StoryCue)).toBe(false);
    expect(canopyLayers(attackCue('sap-vein-snap', 'commit'))).toBeUndefined();
    expect(CANOPY_MAX_VOICES).toBeLessThanOrEqual(8);
  });

  it('shapes each monster: rock whoosh + thud, wing whoosh and screech, hiss and spit, gale', () => {
    const rockCommit = canopyLayers(attackCue('howler-rock-hurl', 'commit'))!, rockActive = canopyLayers(attackCue('howler-rock-hurl', 'active'))!;
    expect(noises(rockCommit).some(layer => layer.noise === 'wind' && layer.filter === 'bandpass')).toBe(true); // whoosh
    expect(tones(rockCommit).some(layer => layer.from! > layer.to!)).toBe(true); // pitch falls as it passes
    expect(tones(rockActive).some(layer => layer.from! <= 110 && layer.to! <= 40 && layer.length > 0.3)).toBe(true); // deep thud
    expect(noises(rockActive).some(layer => layer.filter === 'lowpass' && layer.filterTo! < layer.filterFrom!)).toBe(true); // stone crack closing down

    const dive = canopyLayers(attackCue('hornbill-dive-bomb', 'active'))!;
    expect(noises(dive).some(layer => layer.noise === 'wind' && layer.filterTo! < layer.filterFrom! && layer.length >= 0.5)).toBe(true); // fly-by rush
    const diveCommit = canopyLayers(attackCue('hornbill-dive-bomb', 'commit'))!;
    expect(tones(diveCommit).some(layer => layer.wave === 'sawtooth' && layer.to! > 2000)).toBe(true); // rising screech

    const gale = canopyLayers(attackCue('hornbill-gale-flap', 'active'))!;
    expect(noises(gale).filter(layer => layer.noise === 'wind').length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...noises(gale).map(layer => layer.length))).toBeGreaterThan(0.5);

    const hiss = canopyLayers(attackCue('viper-venom-spit', 'anticipation'))!, spit = canopyLayers(attackCue('viper-venom-spit', 'commit'))!;
    expect(noises(hiss).some(layer => layer.noise === 'white' && layer.filter === 'highpass' && layer.filterFrom! >= 4000)).toBe(true);
    expect(noises(spit).some(layer => layer.length < 0.1 && layer.filter === 'bandpass')).toBe(true); // the sharp "pt"
    const pool = canopyLayers(attackCue('viper-venom-spit', 'active', { durationTicks: 180 }))!;
    expect(noises(pool).some(layer => layer.noise === 'crackle' && layer.length >= 1)).toBe(true); // bubbling lingers with the pool

    const volley = canopyLayers(attackCue('hornbill-feather-volley', 'active'))!;
    expect(tones(volley).filter(layer => layer.from! > 2500).length).toBeGreaterThanOrEqual(3); // staggered dart zips
    expect(new Set(tones(volley).filter(layer => layer.from! > 2500).map(layer => layer.delay)).size).toBeGreaterThanOrEqual(3);
  });

  it('gives each canopy monster its own roar: guttural bark, piercing screech, long rasping hiss', () => {
    const howler = canopyLayers(roarCue('canopy-howler'))!, hornbill = canopyLayers(roarCue('canopy-hornbill'))!, viper = canopyLayers(roarCue('canopy-mire-viper'))!;
    expect(tones(howler).every(layer => layer.from! < 220)).toBe(true);
    expect(tones(howler).some(layer => layer.to! < layer.from! && layer.wave === 'sawtooth')).toBe(true);
    expect(tones(hornbill).some(layer => layer.from! >= 1400 && layer.to! > layer.from!)).toBe(true); // screech climbs
    expect(noises(viper).some(layer => layer.noise === 'white' && layer.filterFrom! >= 4000 && layer.length >= 0.5)).toBe(true);
    expect(tones(viper).every(layer => layer.from! < 100)).toBe(true);
    // Louder roar escalation, never beyond the level budget.
    const soft = canopyLayers(roarCue('canopy-howler', { intensity: 0.4 }))!, loud = canopyLayers(roarCue('canopy-howler', { intensity: 1.5 }))!;
    expect(Math.max(...loud.map(layer => layer.level))).toBeGreaterThan(Math.max(...soft.map(layer => layer.level)));
    // Deterministic per cue id: the same cue always sounds the same.
    const fixed = attackCue('howler-rock-hurl', 'active');
    expect(canopyLayers(fixed)).toEqual(canopyLayers(fixed));
  });
});

describe('canopy cues through StoryAudio', () => {
  it('voices canopy cues from procedural layers on the effects bus and releases them with their scope', async () => {
    await session((presentation, context) => {
      const audio = presentation.audio, cue = attackCue('hornbill-dive-bomb', 'active', { scopeId: 'dive-1' });
      expect(audio.play(cue)).toBe(true);
      expect(audio.playbackMetadata.activeVoices).toBe(1);
      expect(audio.playbackMetadata.lastPlayed).toMatchObject({ instanceId: cue.instanceId, kind: 'active', bus: 'effects' });
      expect(context.oscillators.length).toBeGreaterThan(0);
      expect(context.bufferSources.length).toBeGreaterThan(0);
      expect(audio.play(cue)).toBe(false); // de-duplicated by instance id like every other cue
      audio.cancelScope('dive-1', 'interrupt');
      expect(audio.playbackMetadata.activeVoices).toBe(0);
      expect(context.oscillators.every(node => node.stopped)).toBe(true);
      expect(audio.play(roarCue('canopy-hornbill'))).toBe(true);
      expect(audio.playbackMetadata.activeVoices).toBe(1);
    });
  });

  it('keeps its own voice budget: a barrage never exceeds the canopy cap and never steals Warden voices', async () => {
    await session((presentation) => {
      const audio = presentation.audio;
      for (let i = 0; i < 4; i++) audio.play({ instanceId: `slash:${i}`, tick: 1, worldTick: 1, worldTimeSeconds: 0, kind: 'slash', phase: 'active', actorId: 'aren', durationTicks: 6, element: 'arcane', priority: 'essential' } as StoryCue);
      const warden = audio.playbackMetadata.activeVoices;
      expect(warden).toBe(4);
      for (let i = 0; i < 20; i++) audio.play(attackCue(CANOPY_ATTACK_IDS[i % CANOPY_ATTACK_IDS.length]!, PHASES[i % PHASES.length]!, { scopeId: `barrage:${i}` }));
      expect(audio.playbackMetadata.activeVoices).toBe(warden + CANOPY_MAX_VOICES);
      audio.cancelAll('unload');
      expect(audio.playbackMetadata.activeVoices).toBe(0);
    });
  });

  it('leaves non-canopy attacks on the generic elemental arrangement', async () => {
    await session((presentation, context) => {
      const audio = presentation.audio;
      expect(audio.play({ instanceId: 'boar-ember', tick: 1, worldTick: 1, worldTimeSeconds: 0, kind: 'anticipation', phase: 'anticipation', attackId: 'boar-ember-lance' as AttackId, actorId: 'corrupted-boar', element: 'fire', priority: 'essential', durationTicks: 40 } as StoryCue)).toBe(true);
      // Generic path: triad of oscillators + one elemental noise bed (3 + 1 voices), not a canopy layer recipe.
      expect(context.oscillators.length).toBe(3);
      expect(context.bufferSources.length).toBe(1);
    });
  });
});
