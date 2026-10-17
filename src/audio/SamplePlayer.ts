import type { Vec3 } from '../game/contracts.js';
import type { SampleBank } from './SampleBank.js';
import { SOUND_GROUPS, type SampleBus } from './SampleCatalog.js';
import { VoiceLimiter, type LimitedVoice } from './VoiceLimiter.js';

/** Sounds farther than this from the listener are not started at all (they would be inaudible and still cost a voice). */
export const SAMPLE_CULL_DISTANCE = 48;
/** Total simultaneous sampled voices. */
export const MAX_SAMPLE_VOICES = 24;

interface Chain {
  readonly gain: GainNode;
  readonly panner: PannerNode | undefined;
  readonly bus: SampleBus;
  busy: boolean;
}

interface ActiveSample extends LimitedVoice {
  source: AudioBufferSourceNode | undefined;
  chain: Chain | undefined;
}

export interface SamplePlayerStats {
  played: number;
  culled: number;
  missed: number;
  stolen: number;
  rejected: number;
  active: number;
  chains: number;
}

export interface LastSample { readonly group: string; readonly path: string; readonly at: number; readonly spatial: boolean }

/**
 * Plays decoded one-shots. Gain/panner chains are pooled (an AudioBufferSourceNode is single-use by design, but the nodes behind it are
 * reused), voices are bounded by `VoiceLimiter`, positional sounds use inverse-distance attenuation and far-away ones are culled.
 */
export class SamplePlayer {
  private readonly limiter = new VoiceLimiter({ total: MAX_SAMPLE_VOICES });
  private readonly chains: Chain[] = [];
  private listener: Vec3 | undefined;
  private lastPlayed: LastSample | undefined;
  readonly counters = { played: 0, culled: 0, missed: 0 };

  constructor(
    private readonly context: AudioContext,
    private readonly bank: SampleBank,
    private readonly buses: Readonly<Partial<Record<SampleBus, AudioNode>>>,
    private readonly random: () => number = Math.random,
  ) {}

  setListener(position: Vec3): void { this.listener = position; }

  /**
   * Starts one variant of `groupId`. Returns false when nothing was started (pack still loading, culled by distance, or refused by
   * the voice limiter). `delay` is seconds from now.
   */
  play(groupId: string, gain: number, rate: number, delay: number, position?: Vec3): boolean {
    const group = SOUND_GROUPS[groupId];
    if (!group) return false;
    if (position && this.listener) {
      const dx = position.x - this.listener.x, dy = position.y - this.listener.y, dz = position.z - this.listener.z;
      if (dx * dx + dy * dy + dz * dz > SAMPLE_CULL_DISTANCE * SAMPLE_CULL_DISTANCE) { this.counters.culled++; return false; }
    }
    const buffer = this.bank.pick(groupId, this.random());
    if (!buffer) { this.counters.missed++; return false; }
    const path = this.bank.lastPickedPath;
    const voice: ActiveSample = { group: groupId, priority: group.priority, order: 0, source: undefined, chain: undefined, stop: () => this.stopVoice(voice) };
    if (!this.limiter.admit(voice, group.maxVoices)) return false;
    const bus = this.buses[group.bus];
    if (!bus) { this.limiter.release(voice); return false; }
    const chain = this.acquire(group.bus, bus, position !== undefined);
    voice.chain = chain;
    const now = this.context.currentTime;
    chain.gain.gain.setValueAtTime(group.gain * gain * (0.92 + 0.08 * this.random()), now);
    if (chain.panner && position) {
      chain.panner.positionX.setValueAtTime(position.x, now);
      chain.panner.positionY.setValueAtTime(position.y, now);
      chain.panner.positionZ.setValueAtTime(position.z, now);
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate * (1 + (this.random() * 2 - 1) * group.rateJitter);
    source.connect(chain.gain);
    source.onended = () => { this.finish(voice); };
    voice.source = source;
    source.start(now + Math.max(0, delay));
    this.counters.played++;
    this.lastPlayed = { group: groupId, path, at: now, spatial: position !== undefined };
    return true;
  }

  stopAll(): void { this.limiter.releaseAll(); }

  get stats(): SamplePlayerStats {
    return { ...this.counters, stolen: this.limiter.stolen, rejected: this.limiter.rejected, active: this.limiter.count, chains: this.chains.length };
  }

  /**
   * Starts a looping sample (the stun ring) and returns a handle whose `stop` fades it out; undefined when nothing started. The loop holds
   * a limiter slot like any voice, so it can be stolen by a higher-priority sound (its handle then becomes inert).
   */
  startLoop(groupId: string, gain: number, position?: Vec3): { readonly stop: (fadeSeconds?: number) => void } | undefined {
    const group = SOUND_GROUPS[groupId];
    const buffer = group ? this.bank.pick(groupId, this.random()) : undefined;
    const bus = group ? this.buses[group.bus] : undefined;
    if (!group || !buffer || !bus) { this.counters.missed++; return undefined; }
    const path = this.bank.lastPickedPath;
    const voice: ActiveSample = { group: groupId, priority: group.priority, order: 0, source: undefined, chain: undefined, stop: () => this.stopVoice(voice) };
    if (!this.limiter.admit(voice, group.maxVoices)) return undefined;
    const chain = this.acquire(group.bus, bus, position !== undefined);
    voice.chain = chain;
    const now = this.context.currentTime;
    chain.gain.gain.setValueAtTime(0.0001, now);
    chain.gain.gain.linearRampToValueAtTime(group.gain * gain, now + 0.12);
    if (chain.panner && position) {
      chain.panner.positionX.setValueAtTime(position.x, now);
      chain.panner.positionY.setValueAtTime(position.y, now);
      chain.panner.positionZ.setValueAtTime(position.z, now);
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(chain.gain);
    voice.source = source;
    source.start(now);
    this.counters.played++;
    this.lastPlayed = { group: groupId, path, at: now, spatial: position !== undefined };
    return {
      stop: (fadeSeconds = 0.15) => {
        if (!voice.source) return;
        const at = this.context.currentTime;
        chain.gain.gain.cancelScheduledValues(at);
        chain.gain.gain.setValueAtTime(chain.gain.gain.value, at);
        chain.gain.gain.linearRampToValueAtTime(0.0001, at + fadeSeconds);
        const ending = voice.source;
        ending.onended = () => { this.finish(voice); };
        ending.stop(at + fadeSeconds + 0.02);
      },
    };
  }
  get last(): LastSample | undefined { return this.lastPlayed; }

  dispose(): void {
    this.stopAll();
    for (const chain of this.chains) { chain.gain.disconnect(); chain.panner?.disconnect(); }
    this.chains.length = 0;
  }

  private acquire(busName: SampleBus, bus: AudioNode, spatial: boolean): Chain {
    for (const chain of this.chains) if (!chain.busy && chain.bus === busName && (chain.panner !== undefined) === spatial) { chain.busy = true; return chain; }
    const gain = this.context.createGain();
    let panner: PannerNode | undefined;
    if (spatial) {
      panner = this.context.createPanner();
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = 3;
      panner.maxDistance = SAMPLE_CULL_DISTANCE;
      panner.rolloffFactor = 1.15;
      gain.connect(panner).connect(bus);
    } else gain.connect(bus);
    const chain: Chain = { gain, panner, bus: busName, busy: true };
    this.chains.push(chain);
    return chain;
  }

  private finish(voice: ActiveSample): void {
    this.limiter.release(voice);
    this.releaseNodes(voice);
  }

  private stopVoice(voice: ActiveSample): void {
    const source = voice.source;
    if (source) { try { source.stop(); } catch { /* already ended */ } }
    this.releaseNodes(voice);
  }

  private releaseNodes(voice: ActiveSample): void {
    const source = voice.source;
    if (source) { source.onended = null; source.disconnect(); voice.source = undefined; }
    if (voice.chain) { voice.chain.busy = false; voice.chain = undefined; }
  }
}
