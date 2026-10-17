/**
 * Gapless streamed looping of one long file (music cue or ambience bed) without decoding it to PCM.
 *
 * Two media elements alternate: shortly before the playing one ends, the idle one starts from 0 and the two crossfade equal-power over
 * `crossfadeSeconds` (shortened for very short files), so a loop has no seek gap and the file's tail dissolves into its head.
 * The class holds no Web Audio knowledge beyond the injected node factory, so tests drive it with fakes.
 */

export interface MediaLike {
  src: string;
  preload: string;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  play(): Promise<void>;
  pause(): void;
}

export interface LoopGainParam {
  setValueAtTime(value: number, time: number): unknown;
  setValueCurveAtTime(values: Float32Array, time: number, duration: number): unknown;
  cancelScheduledValues(time: number): unknown;
}
export interface LoopGainNode {
  readonly gain: LoopGainParam;
  connect(destination: unknown): unknown;
  disconnect(): void;
}
export interface StreamedLoopDeps {
  readonly now: () => number;
  readonly createMedia: () => MediaLike;
  /** Wraps a media element in a source node feeding `gain`, and `gain` in `output`. */
  readonly createChain: (media: MediaLike) => { readonly gain: LoopGainNode; readonly dispose: () => void };
}

const CURVE_POINTS = 48;
const FADE_IN = new Float32Array(CURVE_POINTS);
const FADE_OUT = new Float32Array(CURVE_POINTS);
for (let i = 0; i < CURVE_POINTS; i++) {
  const t = i / (CURVE_POINTS - 1);
  FADE_IN[i] = Math.sin(t * Math.PI / 2);
  FADE_OUT[i] = Math.cos(t * Math.PI / 2);
}

export type LoopState = 'idle' | 'playing' | 'paused' | 'disposed';

export class StreamedLoop {
  private readonly slots: { media: MediaLike; gain: LoopGainNode; dispose: () => void }[] = [];
  private active = 0;
  private fading = false;
  private fadeEndsAt = 0;
  state: LoopState = 'idle';
  /** Number of completed seamless wraps (diagnostics). */
  wraps = 0;
  lastError: unknown;

  constructor(private readonly deps: StreamedLoopDeps, readonly url: string, private readonly crossfadeSeconds = 2.5, preload = 'auto') {
    for (let i = 0; i < 2; i++) {
      const media = deps.createMedia();
      media.preload = preload;
      media.src = url;
      const chain = deps.createChain(media);
      chain.gain.gain.setValueAtTime(i === 0 ? 1 : 0, deps.now());
      this.slots.push({ media, gain: chain.gain, dispose: chain.dispose });
    }
  }

  /** Starts (or resumes) playback; autoplay rejection is recorded in `lastError`, never thrown. */
  play(): void {
    if (this.state === 'disposed' || this.state === 'playing') return;
    this.state = 'playing';
    for (let i = 0; i < this.slots.length; i++) {
      if (i !== this.active && !this.fading) continue;
      this.slots[i]!.media.play().catch((error: unknown) => { this.lastError = error; if (this.state === 'playing') this.state = 'paused'; });
    }
  }

  pause(): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    for (const slot of this.slots) if (!slot.media.paused) slot.media.pause();
  }

  /** Call every ~100-250 ms while playing; starts the crossfade into the idle element near the end of the active one. */
  tick(): void {
    if (this.state !== 'playing') return;
    const now = this.deps.now();
    if (this.fading) {
      if (now < this.fadeEndsAt) return;
      this.finishFade();
    }
    const current = this.slots[this.active]!.media;
    const duration = current.duration;
    if (!Number.isFinite(duration) || duration <= 0) return;
    const fade = Math.min(this.crossfadeSeconds, duration / 4);
    if (current.currentTime < duration - fade) return;
    const next = this.slots[1 - this.active]!;
    next.media.currentTime = 0;
    next.media.play().catch((error: unknown) => { this.lastError = error; });
    this.slots[this.active]!.gain.gain.setValueCurveAtTime(FADE_OUT, now, fade);
    next.gain.gain.setValueCurveAtTime(FADE_IN, now, fade);
    this.fading = true;
    this.fadeEndsAt = now + fade;
  }

  /** Seconds into the active element (diagnostics and tests). */
  get position(): number { return this.slots[this.active]!.media.currentTime; }

  dispose(): void {
    if (this.state === 'disposed') return;
    this.state = 'disposed';
    for (const slot of this.slots) {
      slot.media.pause();
      slot.media.src = '';
      slot.gain.disconnect();
      slot.dispose();
    }
    this.slots.length = 0;
  }

  private finishFade(): void {
    const previous = this.slots[this.active]!;
    previous.media.pause();
    previous.media.currentTime = 0;
    previous.gain.gain.cancelScheduledValues(0);
    previous.gain.gain.setValueAtTime(0, this.deps.now());
    this.active = 1 - this.active;
    this.slots[this.active]!.gain.gain.cancelScheduledValues(0);
    this.slots[this.active]!.gain.gain.setValueAtTime(1, this.deps.now());
    this.fading = false;
    this.wraps++;
  }
}
