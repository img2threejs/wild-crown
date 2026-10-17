import { STEM_IDS, STEM_PAUSE_AFTER_SECONDS, STEM_SILENCE, emptyStemGains, smoothGain, targetStemGains, type MusicMixState, type StemGains, type StemId } from './MusicMix.js';
import { StreamedLoop, type LoopGainNode, type MediaLike } from './StreamedLoop.js';

/** The Web Audio surface the director needs; the real `AudioContext` satisfies it, tests pass fakes. */
export interface MusicContext {
  readonly currentTime: number;
  createGain(): MusicGainNode;
  createMediaElementSource(media: never): { connect(destination: unknown): unknown; disconnect(): void };
}
export interface MusicGainNode extends LoopGainNode {
  readonly gain: LoopGainNode['gain'] & { setTargetAtTime(value: number, time: number, timeConstant: number): unknown };
}

export interface MusicDirectorDeps {
  readonly context: MusicContext;
  /** Destination node (the music bus). */
  readonly output: unknown;
  readonly createMedia: () => MediaLike;
  /** Resolves a catalogue path (`audio/music/x.ogg`) to a fetchable URL. */
  readonly resolveUrl: (path: string) => string;
  readonly crossfadeSeconds?: number;
}

/** [rise, fall] seconds of the exponential gain slew per stem. Combat comes in fast; exploration returns slowly after a fight. */
export const STEM_SLEW: Readonly<Record<StemId, readonly [number, number]>> = {
  explore: [3, 1.4],
  combat: [0.9, 2.4],
  boss: [0.8, 3],
  restored: [4, 3],
  corrupted: [4, 3],
  title: [1.5, 1.2],
};

interface Stem {
  readonly id: StemId;
  readonly path: string;
  readonly node: MusicGainNode;
  loop: StreamedLoop | undefined;
  current: number;
  silentFor: number;
}

export interface StemSnapshot {
  readonly path: string;
  readonly gain: number;
  readonly target: number;
  readonly state: StreamedLoop['state'] | 'unloaded';
  readonly wraps: number;
}

/**
 * Owns the music/ambience stems of the current scene and crossfades them from a `MusicMixState`. Streams start only when their gain is
 * wanted, pause after a quiet spell and keep their position, so an exploration cue resumes where it left off after a fight.
 */
export class MusicDirector {
  private readonly stems = new Map<StemId, Stem>();
  private readonly target: StemGains = emptyStemGains();
  private state: MusicMixState = { menu: false, combat: 0, boss: false, restoration: 0, corruption: 0 };
  private silenced = true;
  private readonly prefetch = new Set<StemId>();

  constructor(private readonly deps: MusicDirectorDeps) {}

  /** Replaces the stem set. Stems whose path is unchanged keep playing; `prefetch` stems begin buffering paused. */
  setTracks(tracks: Partial<Record<StemId, string>>, prefetch: readonly StemId[] = []): void {
    for (const id of STEM_IDS) {
      const path = tracks[id];
      const existing = this.stems.get(id);
      if (existing && existing.path === path) continue;
      if (existing) this.disposeStem(existing);
      if (!path) continue;
      const node = this.deps.context.createGain();
      node.gain.setValueAtTime(0, this.deps.context.currentTime);
      node.connect(this.deps.output);
      this.stems.set(id, { id, path, node, loop: undefined, current: 0, silentFor: 0 });
    }
    this.prefetch.clear();
    for (const id of prefetch) this.prefetch.add(id);
    for (const id of this.prefetch) {
      const stem = this.stems.get(id);
      if (stem && !stem.loop) stem.loop = this.openLoop(stem);
    }
  }

  setState(state: MusicMixState): void {
    this.state = state;
    this.silenced = false;
    targetStemGains(state, this.target);
  }

  /** Fades every stem out (title -> game hand-off, region unload). */
  silence(): void {
    this.silenced = true;
    for (const id of STEM_IDS) this.target[id] = 0;
  }

  get isSilent(): boolean {
    for (const stem of this.stems.values()) if (stem.current > STEM_SILENCE) return false;
    return true;
  }

  /** Advance gains and stream state by `dtSeconds` of real time. */
  update(dtSeconds: number): void {
    const now = this.deps.context.currentTime;
    for (const stem of this.stems.values()) {
      const [rise, fall] = STEM_SLEW[stem.id];
      const target = this.target[stem.id];
      stem.current = smoothGain(stem.current, target, dtSeconds, rise, fall);
      if (Math.abs(stem.current - target) < 0.0005) stem.current = target;
      stem.node.gain.setTargetAtTime(stem.current, now, 0.06);
      const wanted = target > STEM_SILENCE || stem.current > STEM_SILENCE;
      if (wanted) {
        stem.silentFor = 0;
        if (!stem.loop) stem.loop = this.openLoop(stem);
        stem.loop.play();
        stem.loop.tick();
      } else if (stem.loop) {
        stem.silentFor += dtSeconds;
        if (stem.silentFor >= STEM_PAUSE_AFTER_SECONDS) stem.loop.pause();
        else stem.loop.tick();
      }
    }
  }

  snapshot(): Readonly<Partial<Record<StemId, StemSnapshot>>> {
    const out: Partial<Record<StemId, StemSnapshot>> = {};
    for (const stem of this.stems.values()) {
      out[stem.id] = { path: stem.path, gain: stem.current, target: this.target[stem.id], state: stem.loop?.state ?? 'unloaded', wraps: stem.loop?.wraps ?? 0 };
    }
    return out;
  }

  get mixState(): MusicMixState { return this.state; }
  get isSilenced(): boolean { return this.silenced; }

  dispose(): void {
    for (const stem of [...this.stems.values()]) this.disposeStem(stem);
    this.stems.clear();
  }

  private openLoop(stem: Stem): StreamedLoop {
    const context = this.deps.context;
    return new StreamedLoop({
      now: () => context.currentTime,
      createMedia: this.deps.createMedia,
      createChain: media => {
        const source = context.createMediaElementSource(media as never);
        const gain = context.createGain();
        source.connect(gain);
        gain.connect(stem.node);
        return { gain, dispose: () => source.disconnect() };
      },
    }, this.deps.resolveUrl(stem.path), this.deps.crossfadeSeconds);
  }

  private disposeStem(stem: Stem): void {
    stem.loop?.dispose();
    stem.node.disconnect();
    this.stems.delete(stem.id);
  }
}
