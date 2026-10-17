// Scheduler-level Web Audio fakes: they record what the mixer builds and schedules; they do not render or measure audible output.
// Audible output is covered by the live browser smoke (docs/features/audio.md).
import type { StoryCue } from '../../../src/effects/story-cues.js';
import type { MediaLike } from '../../../src/audio/StreamedLoop.js';

export class FakeParam {
  value = 0;
  curves: { values: Float32Array; at: number; duration: number }[] = [];
  setValueAtTime(value: number): this { this.value = value; return this; }
  setTargetAtTime(value: number): this { this.value = value; return this; }
  linearRampToValueAtTime(value: number): this { this.value = value; return this; }
  exponentialRampToValueAtTime(value: number): this { this.value = value; return this; }
  setValueCurveAtTime(values: Float32Array, at: number, duration: number): this { this.curves.push({ values, at, duration }); return this; }
  cancelScheduledValues(): this { return this; }
}

export class FakeNode {
  gain = new FakeParam(); frequency = new FakeParam(); Q = new FakeParam(); playbackRate = new FakeParam();
  positionX = new FakeParam(); positionY = new FakeParam(); positionZ = new FakeParam();
  type = ''; buffer: FakeBuffer | null = null; loop = false; onended: (() => void) | null = null;
  panningModel = ''; distanceModel = ''; refDistance = 0; maxDistance = 0; rolloffFactor = 0; fftSize = 0;
  connections: unknown[] = []; disconnected = false; startedAt: number | undefined; stoppedAt: number | undefined;
  connect(target: unknown): unknown { this.connections.push(target); return target; }
  disconnect(): void { this.disconnected = true; }
  start(when?: number): void { this.startedAt = when ?? 0; }
  stop(when?: number): void { this.stoppedAt = when ?? 0; }
  /** Simulates the buffer finishing: fires onended. */
  finish(): void { this.onended?.(); }
  getFloatTimeDomainData(samples: Float32Array): void { samples.fill(0); }
}

export interface FakeBuffer { readonly length: number; readonly numberOfChannels: number; readonly duration: number; readonly tag: string }

export class FakeContext {
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  currentTime = 1; sampleRate = 48000; destination = new FakeNode();
  listener = { positionX: new FakeParam(), positionY: new FakeParam(), positionZ: new FakeParam(), forwardX: new FakeParam(), forwardY: new FakeParam(), forwardZ: new FakeParam(), upX: new FakeParam(), upY: new FakeParam(), upZ: new FakeParam() };
  gains: FakeNode[] = []; panners: FakeNode[] = []; sources: FakeNode[] = []; oscillators: FakeNode[] = []; mediaSources: FakeNode[] = [];
  decodeCount = 0;
  createGain(): FakeNode { const n = new FakeNode(); this.gains.push(n); return n; }
  createAnalyser(): FakeNode { return new FakeNode(); }
  createPanner(): FakeNode { const n = new FakeNode(); this.panners.push(n); return n; }
  createOscillator(): FakeNode { const n = new FakeNode(); this.oscillators.push(n); return n; }
  createBiquadFilter(): FakeNode { return new FakeNode(); }
  createBufferSource(): FakeNode { const n = new FakeNode(); this.sources.push(n); return n; }
  createMediaElementSource(): FakeNode { const n = new FakeNode(); this.mediaSources.push(n); return n; }
  createBuffer(channels: number, length: number, sampleRate: number): unknown {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, getChannelData: (c: number) => data[c] };
  }
  async decodeAudioData(bytes: ArrayBuffer): Promise<FakeBuffer> {
    this.decodeCount++;
    return { length: bytes.byteLength * 10, numberOfChannels: 1, duration: 0.5, tag: `buf${this.decodeCount}` };
  }
  async resume(): Promise<void> { this.state = 'running'; }
  async close(): Promise<void> { this.state = 'closed'; }
}

export class FakeMedia implements MediaLike {
  static instances: FakeMedia[] = [];
  src = ''; preload = ''; currentTime = 0; duration = 100; paused = true; playCount = 0; pauseCount = 0; ended = false;
  constructor() { FakeMedia.instances.push(this); }
  play(): Promise<void> { this.paused = false; this.playCount++; return Promise.resolve(); }
  pause(): void { this.paused = true; this.pauseCount++; }
}

/** `globalThis` typed so the (browser-only) AudioContext constructor can be removed again; a test-only widening. */
const audioGlobals = globalThis as { AudioContext?: typeof AudioContext };

/** Runs `body` with `globalThis.AudioContext` replaced by the fake, restoring it afterwards. */
export async function withFakeAudio<T>(body: (context: FakeContext) => Promise<T> | T): Promise<T> {
  const previous = globalThis.AudioContext;
  globalThis.AudioContext = FakeContext as unknown as typeof AudioContext;
  FakeMedia.instances = [];
  try { return await body(new FakeContext()); } finally {
    if (previous === undefined) delete audioGlobals.AudioContext; else globalThis.AudioContext = previous;
  }
}

let sequence = 0;
export function cue(partial: Partial<StoryCue> & Pick<StoryCue, 'kind'>): StoryCue {
  return { instanceId: `audio-test:${++sequence}`, tick: 1, worldTick: 1, worldTimeSeconds: 1, phase: 'hit', priority: 'essential', position: { x: 2, y: 0, z: 1 }, ...partial } as StoryCue;
}

/** Waits for pending promise chains (fetch/decode of a pack) to settle. */
export async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  await promise;
}
