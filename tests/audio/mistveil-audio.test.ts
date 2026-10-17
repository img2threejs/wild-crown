import { describe, expect, it } from 'bun:test';
import * as THREE from 'three';
import type { AudioListener } from 'three';
import { CANOPY_ATTACK_IDS, CANOPY_MAX_VOICES, canopyLayers, isCanopyCue } from '../../src/audio/CanopySounds.js';
import { MISTVEIL_ATTACK_IDS, MISTVEIL_ROARS, isMistveilCue, mistveilLayers } from '../../src/audio/MistveilSounds.js';
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
const ACTOR: Readonly<Record<string, string>> = { lurker: 'mistveil-lurker', heron: 'mistveil-heron', ghor: 'mistveil-ghor' };
const actorOf = (attackId: string): string => attackId.startsWith('bog-lurker') ? ACTOR.lurker! : attackId.startsWith('lantern-heron') ? ACTOR.heron! : ACTOR.ghor!;
function attackCue(attackId: string, phase: 'anticipation' | 'commit' | 'active' | 'hit', partial: Partial<StoryCue> = {}): StoryCue {
  return {
    instanceId: `mistveil-audio:${++sequence}`, tick: 60, worldTick: 60, worldTimeSeconds: 1, kind: phase, phase, attackId: attackId as AttackId, actorId: actorOf(attackId),
    priority: 'essential', durationTicks: ATTACKS[attackId]?.activeTicks ?? 12, element: ATTACKS[attackId]?.element, position: { x: 4, y: 0, z: -3 }, ...partial,
  } as StoryCue;
}
const roarCue = (actorId: string, partial: Partial<StoryCue> = {}): StoryCue => ({
  instanceId: `mistveil-roar:${++sequence}`, tick: 60, worldTick: 60, worldTimeSeconds: 1, kind: 'roar-cone', phase: 'anticipation', actorId, priority: 'essential', durationTicks: 54, intensity: 1,
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

describe('mistveil sound recipes', () => {
  it('registers a timbre for every Mistveil attack and phase, inside the voice, level and length budgets', () => {
    expect([...MISTVEIL_ATTACK_IDS].sort()).toEqual([
      'bog-lurker-bubble-pool', 'bog-lurker-mud-hop', 'bog-lurker-tongue-lash', 'lantern-heron-flare-burst', 'lantern-heron-mist-gust', 'lantern-heron-spear-dive',
      'mire-maw-bite-lunge', 'mire-maw-black-river-wave', 'mire-maw-tail-sweep',
    ]);
    for (const attackId of MISTVEIL_ATTACK_IDS) {
      expect(ATTACKS[attackId], attackId).toBeDefined();
      for (const phase of PHASES) {
        const cue = attackCue(attackId, phase);
        expect(isMistveilCue(cue), `${attackId}/${phase}`).toBe(true);
        expect(isWardenCue(cue)).toBe(false);
        expect(isCanopyCue(cue)).toBe(false);
        expectBudget(mistveilLayers(cue)!, `${attackId}/${phase}`);
      }
      // A long lingering pool keeps every layer inside the budget even at the longest active window.
      expectBudget(mistveilLayers(attackCue(attackId, 'active', { durationTicks: 180 }))!, `${attackId}/long`);
    }
    for (const [voice, actorId] of Object.entries(ACTOR)) {
      expect(MISTVEIL_ROARS[actorId]).toBe(voice);
      for (const intensity of [0.4, 1, 1.5]) expectBudget(mistveilLayers(roarCue(actorId, { intensity }))!, `${voice} roar`);
    }
  });

  it('leaves every non-Mistveil cue on its existing audio path', () => {
    expect(isMistveilCue(attackCue('boar-charge', 'active', { actorId: 'corrupted-boar' }))).toBe(false);
    expect(isMistveilCue(attackCue('howler-rock-hurl', 'active', { actorId: 'canopy-howler' }))).toBe(false);
    expect(isMistveilCue(roarCue('asha'))).toBe(false);
    expect(isMistveilCue(roarCue('canopy-howler'))).toBe(false);
    expect(isMistveilCue({ ...attackCue('bog-lurker-mud-hop', 'active'), kind: 'landing', phase: 'landing' } as StoryCue)).toBe(false);
    expect(mistveilLayers(attackCue('sap-vein-snap', 'commit'))).toBeUndefined();
    expect(mistveilLayers(attackCue('howler-rock-hurl', 'active', { actorId: 'canopy-howler' }))).toBeUndefined();
    // The canopy recipes never claim a Mistveil cue either.
    for (const attackId of MISTVEIL_ATTACK_IDS) expect(canopyLayers(attackCue(attackId, 'active'))).toBeUndefined();
    expect(MISTVEIL_ATTACK_IDS.filter(id => (CANOPY_ATTACK_IDS as readonly string[]).includes(id))).toEqual([]);
  });

  it('shapes each monster: croaks and wet splats, heron shrieks, water surges', () => {
    const gurgle = mistveilLayers(attackCue('bog-lurker-tongue-lash', 'anticipation'))!, lash = mistveilLayers(attackCue('bog-lurker-tongue-lash', 'active'))!;
    expect(tones(gurgle).some(layer => layer.wave === 'square' && layer.from! < 150)).toBe(true); // a low croak builds
    expect(noises(gurgle).some(layer => layer.noise === 'crackle')).toBe(true); // wet gurgle
    expect(noises(lash).some(layer => layer.filter === 'highpass' && layer.length < 0.1)).toBe(true); // whip-crack
    expect(tones(lash).some(layer => layer.to! < layer.from! && layer.to! < 80)).toBe(true); // slap

    const bubbling = mistveilLayers(attackCue('bog-lurker-bubble-pool', 'active', { durationTicks: 180 }))!;
    expect(noises(bubbling).some(layer => layer.noise === 'crackle' && layer.length >= 1)).toBe(true); // bubbling lingers with the pool
    const blorp = mistveilLayers(attackCue('bog-lurker-bubble-pool', 'commit'))!;
    expect(tones(blorp).some(layer => layer.from! > layer.to! && layer.length < 0.25)).toBe(true); // the wet "blorp"

    const splat = mistveilLayers(attackCue('bog-lurker-mud-hop', 'active'))!;
    expect(tones(splat).some(layer => layer.from! <= 100 && layer.to! <= 40 && layer.length > 0.3)).toBe(true); // heavy thump
    expect(noises(splat).some(layer => layer.filter === 'lowpass' && layer.filterTo! < layer.filterFrom!)).toBe(true); // wet slap closing down

    const shriek = mistveilLayers(attackCue('lantern-heron-spear-dive', 'commit'))!, skim = mistveilLayers(attackCue('lantern-heron-spear-dive', 'active'))!;
    expect(tones(shriek).some(layer => layer.wave === 'sawtooth' && layer.to! > layer.from!)).toBe(true); // rising shriek
    expect(noises(skim).some(layer => layer.noise === 'wind' && layer.filterTo! < layer.filterFrom! && layer.length >= 0.5)).toBe(true); // fly-by rush

    const gust = mistveilLayers(attackCue('lantern-heron-mist-gust', 'active'))!;
    expect(noises(gust).filter(layer => layer.noise === 'wind').length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...noises(gust).map(layer => layer.length))).toBeGreaterThan(0.5);

    const flare = mistveilLayers(attackCue('lantern-heron-flare-burst', 'active'))!, swell = mistveilLayers(attackCue('lantern-heron-flare-burst', 'anticipation'))!;
    expect(tones(flare).filter(layer => layer.from! >= 800 && layer.length >= 0.5).length).toBeGreaterThanOrEqual(2); // ringing chord
    expect(tones(swell).some(layer => layer.to! > layer.from!)).toBe(true); // shimmer rises

    const sweep = mistveilLayers(attackCue('mire-maw-tail-sweep', 'active'))!;
    expect(tones(sweep).some(layer => layer.from! <= 100 && layer.to! <= 40)).toBe(true); // deep thud
    expect(noises(sweep).some(layer => layer.noise === 'wind' && layer.filterTo! < layer.filterFrom!)).toBe(true); // heavy whoosh

    const bite = mistveilLayers(attackCue('mire-maw-bite-lunge', 'active'))!;
    expect(noises(bite).some(layer => layer.filter === 'highpass' && layer.length < 0.1)).toBe(true); // jaw snap
    expect(tones(bite).some(layer => layer.to! <= 40)).toBe(true);

    const wave = mistveilLayers(attackCue('mire-maw-black-river-wave', 'active'))!;
    expect(noises(wave).some(layer => layer.noise === 'wind' && layer.filterTo! < layer.filterFrom! && layer.length >= 0.7)).toBe(true); // long surge
    expect(tones(wave).some(layer => layer.from! <= 70 && layer.to! <= 30)).toBe(true); // sub boom
    expect(noises(wave).some(layer => layer.noise === 'crackle')).toBe(true); // foam
  });

  it('gives each Mistveil monster its own roar: wet croaks, rasping squawk, deep bellow', () => {
    const lurker = mistveilLayers(roarCue('mistveil-lurker'))!, heron = mistveilLayers(roarCue('mistveil-heron'))!, ghor = mistveilLayers(roarCue('mistveil-ghor'))!;
    expect(tones(lurker).filter(layer => layer.wave === 'square' && layer.from! < 150).length).toBe(2); // two croaks
    expect(new Set(tones(lurker).filter(layer => layer.wave === 'square').map(layer => layer.delay)).size).toBe(2);
    expect(tones(heron).some(layer => layer.wave === 'sawtooth' && layer.from! > 250 && layer.to! < layer.from!)).toBe(true); // squawk falls
    expect(tones(heron).every(layer => layer.from! >= 250)).toBe(true);
    expect(tones(ghor).every(layer => layer.from! < 100)).toBe(true);
    expect(tones(ghor).some(layer => layer.length >= 0.5 && layer.to! < layer.from!)).toBe(true);
    // The three voices differ from each other and from the canopy hornbill's screech.
    const signature = (layers: readonly SoundLayer[]) => JSON.stringify(tones(layers).map(layer => [layer.wave, layer.from]));
    expect(new Set([signature(lurker), signature(heron), signature(ghor)]).size).toBe(3);
    // Louder roar escalation, never beyond the level budget.
    const soft = mistveilLayers(roarCue('mistveil-ghor', { intensity: 0.4 }))!, loud = mistveilLayers(roarCue('mistveil-ghor', { intensity: 1.5 }))!;
    expect(Math.max(...loud.map(layer => layer.level))).toBeGreaterThan(Math.max(...soft.map(layer => layer.level)));
    // Deterministic per cue id: the same cue always sounds the same.
    const fixed = attackCue('bog-lurker-mud-hop', 'active');
    expect(mistveilLayers(fixed)).toEqual(mistveilLayers(fixed));
    // The nine attacks are all different in the active phase.
    expect(new Set(MISTVEIL_ATTACK_IDS.map(id => JSON.stringify(mistveilLayers(attackCue(id, 'active', { instanceId: 'same' })))))).toHaveProperty('size', 9);
  });
});

describe('mistveil cues through StoryAudio', () => {
  it('voices Mistveil cues from procedural layers on the effects bus and releases them with their scope', async () => {
    await session((presentation, context) => {
      const audio = presentation.audio, cue = attackCue('lantern-heron-spear-dive', 'active', { scopeId: 'dive-1' });
      expect(audio.play(cue)).toBe(true);
      expect(audio.playbackMetadata.activeVoices).toBe(1);
      expect(audio.playbackMetadata.lastPlayed).toMatchObject({ instanceId: cue.instanceId, kind: 'active', bus: 'effects' });
      expect(context.oscillators.length).toBeGreaterThan(0);
      expect(context.bufferSources.length).toBeGreaterThan(0);
      expect(audio.play(cue)).toBe(false); // de-duplicated by instance id like every other cue
      audio.cancelScope('dive-1', 'interrupt');
      expect(audio.playbackMetadata.activeVoices).toBe(0);
      expect(context.oscillators.every(node => node.stopped)).toBe(true);
      expect(audio.play(roarCue('mistveil-ghor'))).toBe(true);
      expect(audio.playbackMetadata.activeVoices).toBe(1);
    });
  });

  it('shares the bounded wildlife voice pool: a barrage never exceeds the cap and never steals Warden voices', async () => {
    await session((presentation) => {
      const audio = presentation.audio;
      for (let i = 0; i < 4; i++) audio.play({ instanceId: `slash:${i}`, tick: 1, worldTick: 1, worldTimeSeconds: 0, kind: 'slash', phase: 'active', actorId: 'aren', durationTicks: 6, element: 'arcane', priority: 'essential' } as StoryCue);
      const warden = audio.playbackMetadata.activeVoices;
      expect(warden).toBe(4);
      for (let i = 0; i < 20; i++) audio.play(attackCue(MISTVEIL_ATTACK_IDS[i % MISTVEIL_ATTACK_IDS.length]!, PHASES[i % PHASES.length]!, { scopeId: `barrage:${i}` }));
      expect(audio.playbackMetadata.activeVoices).toBe(warden + CANOPY_MAX_VOICES);
      audio.cancelAll('unload');
      expect(audio.playbackMetadata.activeVoices).toBe(0);
    });
  });

  it('leaves non-Mistveil attacks on the generic elemental arrangement', async () => {
    await session((presentation, context) => {
      const audio = presentation.audio;
      expect(audio.play({ instanceId: 'boar-ember', tick: 1, worldTick: 1, worldTimeSeconds: 0, kind: 'anticipation', phase: 'anticipation', attackId: 'boar-ember-lance' as AttackId, actorId: 'corrupted-boar', element: 'fire', priority: 'essential', durationTicks: 40 } as StoryCue)).toBe(true);
      // Generic path: triad of oscillators + one elemental noise bed (3 + 1 voices), not a Mistveil layer recipe.
      expect(context.oscillators.length).toBe(3);
      expect(context.bufferSources.length).toBe(1);
    });
  });
});
