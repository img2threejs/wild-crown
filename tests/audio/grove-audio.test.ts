import { describe, expect, it } from 'bun:test';
import * as THREE from 'three';
import type { AudioListener } from 'three';
import { CANOPY_ATTACK_IDS, isCanopyCue } from '../../src/audio/CanopySounds.js';
import { GROVE_ATTACK_IDS, GROVE_BLIGHT_ATTACK_IDS, GROVE_GUARDIAN_ATTACK_IDS, GROVE_ROARS, groveLayers, isGroveCue } from '../../src/audio/GroveSounds.js';
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
function attackCue(attackId: string, phase: 'anticipation' | 'commit' | 'active' | 'hit', partial: Partial<StoryCue> = {}): StoryCue {
  return {
    instanceId: `grove-audio:${++sequence}`, tick: 60, worldTick: 60, worldTimeSeconds: 1, kind: phase, phase, attackId: attackId as AttackId, actorId: 'grove-sprig',
    priority: 'essential', durationTicks: ATTACKS[attackId]?.activeTicks ?? 12, element: ATTACKS[attackId]?.element, position: { x: 4, y: 0, z: -3 }, ...partial,
  } as StoryCue;
}
const roarCue = (actorId: string, partial: Partial<StoryCue> = {}): StoryCue => ({
  instanceId: `grove-roar:${++sequence}`, tick: 60, worldTick: 60, worldTimeSeconds: 1, kind: 'roar-cone', phase: 'anticipation', actorId, priority: 'essential', durationTicks: 54, intensity: 1,
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
/** Soft by construction: Grove cues sit well below the Warden level budget. */
const SOFT_LEVEL = WARDEN_MAX_LEVEL * 0.75;

describe('grove sound recipes', () => {
  it('registers a timbre for every sprig attack and phase, inside the voice, level and length budgets', () => {
    expect([...GROVE_ATTACK_IDS].sort()).toEqual(['sprig-ground-ripple', 'sprig-petal-sweep', 'sprig-seed-toss']);
    for (const attackId of GROVE_ATTACK_IDS) {
      expect(ATTACKS[attackId], attackId).toBeDefined();
      for (const phase of PHASES) {
        const cue = attackCue(attackId, phase);
        expect(isGroveCue(cue), `${attackId}/${phase}`).toBe(true);
        expect(isWardenCue(cue)).toBe(false);
        expect(isCanopyCue(cue)).toBe(false);
        const layers = groveLayers(cue)!;
        expectBudget(layers, `${attackId}/${phase}`);
        for (const layer of layers) expect(layer.level, `${attackId}/${phase}`).toBeLessThanOrEqual(SOFT_LEVEL);
      }
    }
    expect(GROVE_ROARS).toEqual({ 'grove-sprig': 'sprig', 'grove-blighted': 'blighted', 'grove-hollowheart': 'guardian' });
    for (const intensity of [0.4, 1, 1.5]) expectBudget(groveLayers(roarCue('grove-sprig', { intensity }))!, 'sprig chirr');
  });

  it('leaves every non-grove cue on its existing audio path, and the canopy attack ids stay canopy', () => {
    expect(isGroveCue(attackCue('boar-charge', 'active', { actorId: 'corrupted-boar' }))).toBe(false);
    expect(isGroveCue(roarCue('asha'))).toBe(false);
    expect(isGroveCue(roarCue('canopy-howler'))).toBe(false);
    expect(isGroveCue({ ...attackCue('sprig-seed-toss', 'active'), kind: 'landing', phase: 'landing' } as StoryCue)).toBe(false);
    expect(groveLayers(attackCue('sap-vein-snap', 'commit'))).toBeUndefined();
    expect(groveLayers(attackCue('howler-rock-hurl', 'active', { actorId: 'canopy-howler' }))).toBeUndefined();
    for (const attackId of CANOPY_ATTACK_IDS) expect(isGroveCue(attackCue(attackId, 'active'))).toBe(false);
  });

  it('shapes the sparring partner: soft wooden knocks, leafy rustle, small chimes and a gentle rising chirr', () => {
    const tossActive = groveLayers(attackCue('sprig-seed-toss', 'active'))!, tossCommit = groveLayers(attackCue('sprig-seed-toss', 'commit'))!;
    expect(tones(tossCommit).some(layer => layer.from! > layer.to!)).toBe(true); // the lob falls away
    expect(tones(tossActive).some(layer => layer.wave === 'sine' && layer.from! <= 200 && layer.to! <= 100)).toBe(true); // wooden tok
    expect(tones(tossActive).some(layer => layer.wave === 'triangle' && layer.from! >= 800 && layer.length >= 0.4)).toBe(true); // small chime
    expect(noises(tossActive).some(layer => layer.filter === 'lowpass' && layer.filterTo! < layer.filterFrom!)).toBe(true); // leafy puff closing down

    const rippleActive = groveLayers(attackCue('sprig-ground-ripple', 'active'))!;
    expect(noises(rippleActive).some(layer => layer.noise === 'wind' && layer.filterTo! > layer.filterFrom! && layer.length >= 0.4)).toBe(true); // rustle sweeping past
    expect(tones(rippleActive).some(layer => layer.from! <= 130 && layer.to! < layer.from!)).toBe(true); // low wooden knock
    const rippleWarn = groveLayers(attackCue('sprig-ground-ripple', 'anticipation'))!;
    expect(tones(rippleWarn).some(layer => layer.wave === 'triangle' && layer.to! > layer.from!)).toBe(true); // creak rising

    const sweepActive = groveLayers(attackCue('sprig-petal-sweep', 'active'))!;
    expect(noises(sweepActive).some(layer => layer.noise === 'wind' && layer.filterTo! < layer.filterFrom! && layer.length >= 0.4)).toBe(true); // breath along the lane
    expect(tones(sweepActive).filter(layer => layer.wave === 'triangle').length).toBeGreaterThanOrEqual(2); // two soft chimes
    expect(new Set(tones(sweepActive).map(layer => layer.delay)).size).toBeGreaterThanOrEqual(2);

    const chirr = groveLayers(roarCue('grove-sprig'))!;
    const chirps = tones(chirr).filter(layer => layer.wave === 'triangle');
    expect(chirps.length).toBe(5);
    expect(new Set(chirps.map(layer => layer.delay)).size).toBe(5); // staggered chirps
    for (let step = 1; step < chirps.length; step++) expect(chirps[step]!.from!).toBeGreaterThan(chirps[step - 1]!.from!); // rising
    expect(tones(chirr).every(layer => layer.wave !== 'sawtooth' && layer.wave !== 'square')).toBe(true); // never harsh
    expect(noises(chirr).every(layer => layer.noise !== 'shards' && layer.noise !== 'crackle')).toBe(true);
    // Louder roar escalation, never beyond the level budget.
    const soft = groveLayers(roarCue('grove-sprig', { intensity: 0.4 }))!, loud = groveLayers(roarCue('grove-sprig', { intensity: 1.5 }))!;
    expect(Math.max(...loud.map(layer => layer.level))).toBeGreaterThan(Math.max(...soft.map(layer => layer.level)));
    // Deterministic per cue id: the same cue always sounds the same.
    const fixed = attackCue('sprig-seed-toss', 'active');
    expect(groveLayers(fixed)).toEqual(groveLayers(fixed));
  });

  it('registers a timbre for every blighted and guardian attack phase and every roar, inside the same budgets', () => {
    expect([...GROVE_BLIGHT_ATTACK_IDS]).toEqual(['blighted-seed-lob', 'blighted-ground-pulse', 'blighted-lash-sweep']);
    expect([...GROVE_GUARDIAN_ATTACK_IDS]).toEqual(['hollowheart-leap-smash', 'hollowheart-antler-sweep', 'hollowheart-ichor-hurl', 'hollowheart-heartlight-burst']);
    for (const [attackId, actorId] of [...GROVE_BLIGHT_ATTACK_IDS.map(id => [id, 'grove-blighted'] as const), ...GROVE_GUARDIAN_ATTACK_IDS.map(id => [id, 'grove-hollowheart'] as const)]) {
      expect(ATTACKS[attackId], attackId).toBeDefined();
      for (const phase of PHASES) {
        const cue = attackCue(attackId, phase, { actorId });
        expect(isGroveCue(cue), `${attackId}/${phase}`).toBe(true);
        expect(isWardenCue(cue)).toBe(false);
        expect(isCanopyCue(cue)).toBe(false);
        const layers = groveLayers(cue)!;
        expectBudget(layers, `${attackId}/${phase}`);
        for (const layer of layers) expect(layer.wave === 'sawtooth' || layer.wave === 'square', `${attackId}/${phase} stays woody`).toBe(false);
      }
    }
    for (const actorId of ['grove-sprig', 'grove-blighted', 'grove-hollowheart']) for (const intensity of [0.4, 1, 1.5]) expectBudget(groveLayers(roarCue(actorId, { intensity }))!, `${actorId} roar`);
  });

  it('plays the blighted rootling a fifth lower over a sap drone and gives the guardian a heavier voice than the sprig', () => {
    const twin = (attackId: string, blighted: string, phase: 'anticipation' | 'commit' | 'active' | 'hit') => {
      const shared = { instanceId: `grove-twin:${attackId}:${phase}` };
      return [groveLayers(attackCue(attackId, phase, shared))!, groveLayers(attackCue(blighted, phase, { ...shared, actorId: 'grove-blighted' }))!] as const;
    };
    for (const [sprig, blighted] of [['sprig-seed-toss', 'blighted-seed-lob'], ['sprig-ground-ripple', 'blighted-ground-pulse'], ['sprig-petal-sweep', 'blighted-lash-sweep']] as const) {
      for (const phase of PHASES) {
        const [gentle, dark] = twin(sprig, blighted, phase);
        expect(dark.length, `${blighted}/${phase}`).toBe(gentle.length + 1);
        const drone = dark[dark.length - 1]!;
        expect(drone.wave).toBe('sine');
        expect(drone.from! < 100 && drone.to! < drone.from!, 'a low falling sine drone').toBe(true);
        const lowest = (layers: readonly SoundLayer[]) => Math.min(...tones(layers).slice(0, gentle.filter(layer => layer.source === 'tone').length).map(layer => layer.from!));
        expect(lowest(dark), `${blighted}/${phase} sits below its sprig twin`).toBeLessThan(lowest(gentle));
      }
    }
    // The guardian's loudest layer is well above the sprig's, and its groan is lower and longer than the sprig's chirr.
    const peak = (layers: readonly SoundLayer[]) => Math.max(...layers.map(layer => layer.level));
    const heavy = GROVE_GUARDIAN_ATTACK_IDS.map(id => peak(groveLayers(attackCue(id, 'active', { actorId: 'grove-hollowheart' }))!));
    const gentle = GROVE_ATTACK_IDS.map(id => peak(groveLayers(attackCue(id, 'active'))!));
    expect(Math.max(...heavy)).toBeGreaterThan(Math.max(...gentle));
    const groan = groveLayers(roarCue('grove-hollowheart'))!, chirr = groveLayers(roarCue('grove-sprig'))!;
    expect(Math.min(...tones(groan).map(layer => layer.from!))).toBeLessThan(Math.min(...tones(chirr).map(layer => layer.from!)));
    expect(Math.max(...groan.map(layer => layer.delay + layer.length))).toBeGreaterThan(Math.max(...chirr.map(layer => layer.delay + layer.length)));
    // Each guardian attack has its own timbre per phase.
    for (const phase of PHASES) expect(new Set(GROVE_GUARDIAN_ATTACK_IDS.map(id => JSON.stringify(groveLayers(attackCue(id, phase, { actorId: 'grove-hollowheart', instanceId: `grove-distinct:${phase}` }))))).size).toBe(4);
  });
});

describe('grove cues through StoryAudio', () => {
  it('voices grove cues from procedural layers on the effects bus and releases them with their scope', async () => {
    await session((presentation, context) => {
      const audio = presentation.audio, cue = attackCue('sprig-petal-sweep', 'active', { scopeId: 'sweep-1' });
      expect(audio.play(cue)).toBe(true);
      expect(audio.playbackMetadata.activeVoices).toBe(1);
      expect(audio.playbackMetadata.lastPlayed).toMatchObject({ instanceId: cue.instanceId, kind: 'active', bus: 'effects' });
      expect(context.oscillators.length).toBeGreaterThan(0);
      expect(context.bufferSources.length).toBeGreaterThan(0);
      expect(audio.play(cue)).toBe(false); // de-duplicated by instance id like every other cue
      audio.cancelScope('sweep-1', 'interrupt');
      expect(audio.playbackMetadata.activeVoices).toBe(0);
      expect(context.oscillators.every(node => node.stopped)).toBe(true);
      expect(audio.play(roarCue('grove-sprig'))).toBe(true);
      expect(audio.playbackMetadata.activeVoices).toBe(1);
    });
  });

  it('shares the bounded wildlife voice pool: a barrage never exceeds it and never steals Warden voices', async () => {
    await session((presentation) => {
      const audio = presentation.audio;
      for (let i = 0; i < 4; i++) audio.play({ instanceId: `slash:${i}`, tick: 1, worldTick: 1, worldTimeSeconds: 0, kind: 'slash', phase: 'active', actorId: 'aren', durationTicks: 6, element: 'arcane', priority: 'essential' } as StoryCue);
      const warden = audio.playbackMetadata.activeVoices;
      expect(warden).toBe(4);
      for (let i = 0; i < 20; i++) audio.play(attackCue(GROVE_ATTACK_IDS[i % GROVE_ATTACK_IDS.length]!, PHASES[i % PHASES.length]!, { scopeId: `barrage:${i}` }));
      const voices = audio.playbackMetadata.activeVoices - warden;
      expect(voices).toBeGreaterThan(0);
      expect(voices).toBeLessThanOrEqual(8);
      audio.cancelAll('unload');
      expect(audio.playbackMetadata.activeVoices).toBe(0);
    });
  });

  it('leaves non-grove attacks on the generic elemental arrangement', async () => {
    await session((presentation, context) => {
      const audio = presentation.audio;
      expect(audio.play({ instanceId: 'boar-ember', tick: 1, worldTick: 1, worldTimeSeconds: 0, kind: 'anticipation', phase: 'anticipation', attackId: 'boar-ember-lance' as AttackId, actorId: 'corrupted-boar', element: 'fire', priority: 'essential', durationTicks: 40 } as StoryCue)).toBe(true);
      // Generic path: triad of oscillators + one elemental noise bed (3 + 1 voices), not a grove layer recipe.
      expect(context.oscillators.length).toBe(3);
      expect(context.bufferSources.length).toBe(1);
    });
  });
});
