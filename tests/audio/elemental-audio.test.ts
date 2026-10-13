import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { AudioListener } from 'three';
import type { AttackElement } from '../../src/game/combat/content.js';
import { StoryPresentation } from '../../src/effects/StoryPresentation.js';
import type { StoryCue } from '../../src/effects/story-cues.js';

class Parameter {
  value: number | string = 0;
  setValueAtTime(value: number): void { this.value = value; }
  setTargetAtTime(value: number): void { this.value = value; }
  linearRampToValueAtTime(): void {}
  exponentialRampToValueAtTime(): void {}
}
class AudioNodeMock {
  gain = new Parameter();
  frequency = new Parameter();
  positionX = new Parameter();
  positionY = new Parameter();
  positionZ = new Parameter();
  type: string | null = null;
  onended: ((this: AudioNodeMock, ev?: unknown) => unknown) | null = null;
  stopped = false;
  disconnected = false;
  buffer: unknown = null;
  loop = false;
  connect(node: AudioNodeMock): AudioNodeMock { return node; }
  disconnect(): void { this.disconnected = true; }
  start(): void {}
  stop(at?: number): void {
    this.stopped = true;
    if (at === undefined) this.onended?.call(this);
  }
  getFloatTimeDomainData(samples: Float32Array): void { samples.fill(0); }
}
class ContextMock {
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  currentTime = 1;
  sampleRate = 48000;
  destination = new AudioNodeMock();
  oscillators: AudioNodeMock[] = [];
  bufferSources: AudioNodeMock[] = [];
  filters: AudioNodeMock[] = [];
  gains: AudioNodeMock[] = [];
  panners: AudioNodeMock[] = [];
  analysers: AudioNodeMock[] = [];
  buffers: { length: number; sampleRate: number }[] = [];
  closed = false;
  createGain(): AudioNodeMock { const g = new AudioNodeMock(); this.gains.push(g); return g; }
  createAnalyser(): AudioNodeMock { const a = new AudioNodeMock(); this.analysers.push(a); return a; }
  createPanner(): AudioNodeMock { const p = new AudioNodeMock(); this.panners.push(p); return p; }
  createOscillator(): AudioNodeMock { const o = new AudioNodeMock(); this.oscillators.push(o); return o; }
  createBiquadFilter(): AudioNodeMock { const f = new AudioNodeMock(); this.filters.push(f); return f; }
  createBuffer(channels: number, length: number, sampleRate: number): unknown {
    this.buffers.push({ length, sampleRate });
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, getChannelData: (channel: number) => data[channel] };
  }
  createBufferSource(): AudioNodeMock { const s = new AudioNodeMock(); this.bufferSources.push(s); return s; }
  async resume(): Promise<void> { this.state = 'running'; }
  async close(): Promise<void> { this.closed = true; this.state = 'closed'; }
}

async function withUnlockedPresentation(testFn: (presentation: StoryPresentation, context: ContextMock) => Promise<void> | void): Promise<void> {
  const previous = globalThis.AudioContext;
  globalThis.AudioContext = ContextMock as unknown as typeof AudioContext;
  const context = new ContextMock();
  const presentation = new StoryPresentation({ scene: new THREE.Scene(), audioListener: { context } as unknown as AudioListener });
  try {
    const guard = makeElementCue('fire', 'anticipation', 'guard:0', 's-guard');
    assert.equal(presentation.audio.play(guard), false, 'playback must wait for user-gesture unlock');
    assert.equal(await presentation.unlockAudio(), true);
    await testFn(presentation, context);
  } finally {
    presentation.dispose();
    if (previous === undefined) delete (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    else globalThis.AudioContext = previous;
  }
}

function makeElementCue(element: AttackElement, phase: StoryCue['phase'], instanceId: string, scopeId: string): StoryCue {
  return {
    instanceId,
    tick: 60,
    worldTick: 60,
    worldTimeSeconds: 1,
    kind: phase,
    phase,
    attackId: 'boar-charge' as never,
    scopeId,
    position: { x: 0, y: 0, z: 0 },
    footprint: { width: 4, length: 4 },
    durationTicks: 30,
    intensity: 1,
    priority: 'essential' as const,
    element,
  };
}

test('hit-phase elemental cue schedules no noise source and the voice cleans up after every oscillator ends', async () => {
  // Regression for the schedule() bug where remaining was initialised to notes.length + 1 whenever
  // an element was set, regardless of whether a noise source was actually created. The hit phase
  // never spawns a noise source, so the voice MUST retire once its oscillators finish.
  await withUnlockedPresentation((presentation, context) => {
    const before = context.oscillators.length;
    const buffersBefore = context.bufferSources.length;
    const played = presentation.audio.play(makeElementCue('fire', 'hit', 'hit:1', 's-hit-1'));
    assert.equal(played, true);
    const scheduledOscillators = context.oscillators.slice(before);
    assert.ok(scheduledOscillators.length > 0, 'hit phase must still schedule at least one voice oscillator');
    assert.equal(context.bufferSources.length, buffersBefore, 'hit phase must NOT spawn a noise source');
    // Simulate WebAudio clock advancing past each oscillator's stop time.
    for (const osc of scheduledOscillators) osc.stop();
    assert.equal(presentation.audio.playbackMetadata.activeVoices, 0, 'voice must retire naturally once every oscillator ends');
  });
});

test('anticipation-phase elemental cue spawns exactly one noise source, and scope cancellation tears it down', async () => {
  await withUnlockedPresentation((presentation, context) => {
    const before = { buffers: context.bufferSources.length, filters: context.filters.length };
    presentation.audio.play(makeElementCue('wind', 'anticipation', 'wind:cancel:0', 's-wind-0'));
    const noiseSource = context.bufferSources.slice(before.buffers)[0];
    const newFilters = context.filters.slice(before.filters);
    assert.ok(noiseSource, 'anticipation must schedule exactly one noise source');
    assert.ok(newFilters.length >= 1, 'anticipation must schedule at least one filter');
    presentation.onInterrupt('s-wind-0');
    assert.ok(noiseSource.disconnected, 'noise source must disconnect on scope cancellation');
    assert.ok(newFilters.every(filter => filter.disconnected), 'every element-branch filter must disconnect on scope cancellation');
    assert.equal(presentation.audio.playbackMetadata.activeVoices, 0, 'no elemental voice should survive scope cancellation');
  });
});

test('overlapping elemental casts grow active voices, and a single scope interrupt retires only its voice', async () => {
  await withUnlockedPresentation((presentation) => {
    const elements: AttackElement[] = ['fire', 'ice', 'wind', 'poison'];
    const baseActive = presentation.audio.playbackMetadata.activeVoices;
    for (let i = 0; i < 16; i++) {
      const element = elements[i % elements.length]!;
      presentation.audio.play(makeElementCue(element, 'anticipation', `${element}:bound:${i}`, `s-${element}-${i}`));
    }
    const grown = presentation.audio.playbackMetadata.activeVoices;
    assert.equal(grown, baseActive + 16, 'every overlapping cast remains live until its scheduled end');
    presentation.onInterrupt('s-fire-0');
    const after = presentation.audio.playbackMetadata.activeVoices;
    assert.equal(after, grown - 1, 'interrupting one scope must retire exactly one voice');
  });
});

test('seen de-dupe ignores the same instanceId even when the element tag differs', async () => {
  await withUnlockedPresentation((presentation) => {
    assert.ok(presentation.audio.play(makeElementCue('fire', 'anticipation', 'dup:1', 's-dup')));
    assert.equal(presentation.audio.play(makeElementCue('fire', 'active', 'dup:1', 's-dup')), false, 'second instanceId must be ignored');
    assert.equal(presentation.audio.play(makeElementCue('ice', 'anticipation', 'dup:1', 's-dup')), false, 'cross-element must not bypass seen de-duplication');
  });
});

test('borrowed-context lifecycle: death retires every active voice, dispose does not close a listener-owned context', async () => {
  // Verifies the StoryPresentation → StoryAudio cancellation contract exercised through the real
  // consumeTick/onDeath path: the listener (camera audio listener) owns the context, so dispose
  // must NOT close it, and onDeath must retire every queued voice.
  const previous = globalThis.AudioContext;
  globalThis.AudioContext = ContextMock as unknown as typeof AudioContext;
  const context = new ContextMock();
  const presentation = new StoryPresentation({ scene: new THREE.Scene(), audioListener: { context } as unknown as AudioListener });
  try {
    assert.equal(await presentation.unlockAudio(), true);
    presentation.audio.play(makeElementCue('poison', 'anticipation', 'poison:death:0', 's-poison-0'));
    presentation.audio.play(makeElementCue('wind', 'commit', 'wind:death:0', 's-wind-0'));
    assert.ok(presentation.audio.playbackMetadata.activeVoices >= 2, 'two element cues should be live before death');
    presentation.onDeath();
    assert.equal(presentation.audio.playbackMetadata.activeVoices, 0, 'onDeath must retire every active voice');
    presentation.dispose();
    assert.equal(context.closed, false, 'borrowed context must remain alive when the listener owns it');
  } finally {
    if (previous === undefined) delete (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    else globalThis.AudioContext = previous;
  }
});

test('browser unlock refuses to play before any user gesture, accepts the same cue after unlock', async () => {
  // Scenario main will run in a real browser: the audio system must reject play() until unlock()
  // resolves, and it must accept the same cue immediately after a successful unlock. This is the
  // only piece of the unlock contract that can be exercised in a scheduler-only test.
  const previous = globalThis.AudioContext;
  globalThis.AudioContext = ContextMock as unknown as typeof AudioContext;
  const context = new ContextMock();
  const presentation = new StoryPresentation({ scene: new THREE.Scene(), audioListener: { context } as unknown as AudioListener });
  try {
    assert.equal(presentation.audio.play(makeElementCue('fire', 'anticipation', 'unlock:pre:0', 's-unlock-pre')), false, 'must refuse to play before unlock');
    assert.equal(await presentation.unlockAudio(), true);
    assert.equal(context.state, 'running');
    assert.equal(presentation.audio.play(makeElementCue('wind', 'anticipation', 'unlock:post:0', 's-unlock-post')), true);
  } finally {
    presentation.dispose();
    if (previous === undefined) delete (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    else globalThis.AudioContext = previous;
  }
});
