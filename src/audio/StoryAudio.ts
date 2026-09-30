import type { AudioListener } from 'three';
import type { GameSettings, Vec3 } from '../game/contracts.js';
import type { CueCancellationReason, StoryCue } from '../effects/story-cues.js';

export type AudioBusName = 'master' | 'music' | 'effects' | 'ambience' | 'dialogue';
export interface StoryAudioOptions {
  readonly listener?: AudioListener;
  readonly onPlayback?: (metadata: StoryPlaybackMetadata & { readonly lastPlayed: NonNullable<StoryPlaybackMetadata['lastPlayed']> }) => void;
}
export interface StoryPlaybackMetadata {
  readonly contextState: AudioContextState | 'unavailable';
  readonly activeVoices: number;
  readonly lastPlayed?: { readonly instanceId: string; readonly kind: StoryCue['kind']; readonly at: number; readonly bus: AudioBusName };
  readonly outputRms: number;
}
export interface AudioListenerPose { readonly position: Vec3; readonly forward: Vec3; readonly up: Vec3 }
interface ActiveVoice { readonly id: string; readonly sources: readonly AudioScheduledSourceNode[]; readonly scopeId?: string; readonly cleanup: readonly AudioNode[] }

const SEMITONES: Readonly<Record<StoryCue['kind'], readonly number[]>> = {
  anticipation: [0, 7], commit: [-5, 0], hit: [-12], landing: [-7], 'perfect-dodge': [7, 12],
  heartroot: [0, 7, 12], tether: [0, 5, 12], cleanse: [0, 4, 7], bond: [0, 5, 9], dominion: [-12, -5, 2],
  restoration: [0, 4, 7, 11], possession: [-12, -9], phase: [-5, 0, 7], ending: [0, 4, 7, 12],
  'ending-living-pact': [0, 4, 7, 11], 'ending-dominion': [-12, -5, 2], 'ending-severance': [0, 6, 1, 8],
  'restoration-water': [0, 7, 12], 'restoration-roots': [0, 4, 7], 'restoration-seeds': [0, 5, 9], 'restoration-animals': [0, 5, 9, 12],
  'sap-vein': [-12], footprint: [-7], pounce: [-5, 0], 'roar-cone': [-12, -5], 'low-wave': [-12, -7],
  grovebreak: [-12, -5, 0], march: [-7, 0], reunion: [0, 5, 9], heartbeat: [0],
};
const KIND_BUS: Readonly<Record<StoryCue['kind'], AudioBusName>> = {
  anticipation: 'effects', commit: 'effects', hit: 'effects', landing: 'effects', 'perfect-dodge': 'effects',
  heartroot: 'music', tether: 'effects', cleanse: 'effects', bond: 'effects', dominion: 'effects', restoration: 'music',
  possession: 'effects', phase: 'music', ending: 'music', 'ending-living-pact': 'music', 'ending-dominion': 'music', 'ending-severance': 'music',
  'restoration-water': 'ambience', 'restoration-roots': 'effects', 'restoration-seeds': 'music', 'restoration-animals': 'ambience', 'sap-vein': 'effects', footprint: 'effects',
  pounce: 'effects', 'roar-cone': 'effects', 'low-wave': 'effects', grovebreak: 'music', march: 'effects',
  reunion: 'music', heartbeat: 'ambience',
};
const MIDI_C4 = 60;
const A4 = 440;

/** Browser-unlocked, procedurally authored score and SFX. No recorded voice assets are implied. */
export class StoryAudio {
  private context: AudioContext | undefined;
  private ownsContext = false;
  private master: GainNode | undefined;
  private analyser: AnalyserNode | undefined;
  private readonly meterSamples = new Float32Array(512);
  private readonly buses: Partial<Record<AudioBusName, GainNode>> = {};
  private readonly voices: ActiveVoice[] = [];
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  private readonly listener?: AudioListener;
  private readonly onPlayback?: StoryAudioOptions['onPlayback'];
  private ambience: ActiveVoice | undefined;
  private disposed = false;
  private settings: GameSettings | undefined;
  private restoration = 0;
  private bond = 0;
  private corruption = 0;
  private dominion = 0;
  private lastPlayed: StoryPlaybackMetadata['lastPlayed'];

  constructor(options: StoryAudioOptions = {}) {
    this.listener = options.listener;
    this.onPlayback = options.onPlayback;
  }

  /** Call only from an actual user gesture so browser autoplay policy can be satisfied. */
  async unlock(): Promise<boolean> {
    if (this.disposed) return false;
    const AudioContextClass = globalThis.AudioContext;
    if (!AudioContextClass) return false;
    if (!this.context) {
      const borrowedContext = this.listener?.context;
      this.ownsContext = borrowedContext === undefined;
      this.createGraph(borrowedContext ?? new AudioContextClass());
    }
    const context = this.context;
    if (!context || context.state === 'closed') return false;
    if (context.state !== 'running') await context.resume();
    return context.state === 'running';
  }

  setSettings(settings: GameSettings): void {
    this.settings = settings;
    if (!this.context) return;
    const now = this.context.currentTime;
    this.master!.gain.setTargetAtTime(this.clamp(settings.masterVolume), now, 0.035);
    const values: Readonly<Record<'music' | 'effects' | 'ambience' | 'dialogue', number>> = {
      music: settings.musicVolume, effects: settings.effectsVolume, ambience: settings.ambienceVolume, dialogue: settings.dialogueVolume,
    };
    for (const name of ['music', 'effects', 'ambience', 'dialogue'] as const) this.buses[name]!.gain.setTargetAtTime(this.clamp(values[name]), now, 0.035);
  }

  setListenerPose(pose: AudioListenerPose): void {
    if (!this.context) return;
    const listener = this.context.listener;
    const now = this.context.currentTime;
    listener.positionX.setTargetAtTime(pose.position.x, now, 0.02);
    listener.positionY.setTargetAtTime(pose.position.y, now, 0.02);
    listener.positionZ.setTargetAtTime(pose.position.z, now, 0.02);
    listener.forwardX.setTargetAtTime(pose.forward.x, now, 0.02);
    listener.forwardY.setTargetAtTime(pose.forward.y, now, 0.02);
    listener.forwardZ.setTargetAtTime(pose.forward.z, now, 0.02);
    listener.upX.setTargetAtTime(pose.up.x, now, 0.02);
    listener.upY.setTargetAtTime(pose.up.y, now, 0.02);
    listener.upZ.setTargetAtTime(pose.up.z, now, 0.02);
  }

  play(cue: StoryCue, sourcePosition?: Vec3): boolean {
    if (this.disposed || !this.context || this.context.state !== 'running' || this.seen.has(cue.instanceId)) return false;
    this.seen.add(cue.instanceId);
    this.seenOrder.push(cue.instanceId);
    if (this.seenOrder.length > 512) this.seen.delete(this.seenOrder.shift()!);
    if (cue.kind === 'restoration' || cue.kind === 'reunion') this.restoration = Math.min(1, this.restoration + 0.24);
    if (cue.kind === 'grovebreak') this.restoration = Math.max(0, this.restoration - 0.12);
    if (cue.kind === 'heartroot' || cue.kind === 'bond' || cue.kind === 'heartbeat') this.bond = Math.min(1, this.bond + 0.2);
    if (cue.kind === 'dominion' || cue.kind === 'ending-dominion') this.dominion = Math.min(1, this.dominion + 0.2);
    const notes = this.arrangement(cue.kind);
    const position = sourcePosition ?? cue.position ?? cue.from;
    const voice = this.schedule(cue, notes, KIND_BUS[cue.kind], position);
    this.voices.push(voice);
    return true;
  }

  playAll(cues: readonly StoryCue[]): number {
    let played = 0;
    for (const cue of cues) if (this.play(cue)) played++;
    return played;
  }

  /** Generated, region-tuned breath-and-leaf texture; it uses oscillators, not downloaded audio files. */
  startBiomeAmbience(regionId: string): boolean {
    if (!this.context || this.context.state !== 'running' || this.disposed) return false;
    this.stopAmbience();
    const sources: AudioScheduledSourceNode[] = [];
    const gains: GainNode[] = [];
    const root = this.buses.ambience!;
    const frequencies = this.regionTones(regionId);
    for (let i = 0; i < frequencies.length; i++) {
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      const filter = this.context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 520 + i * 180;
      oscillator.type = i === 0 ? 'sine' : 'triangle';
      oscillator.frequency.value = frequencies[i]!;
      gain.gain.value = 0.018 / (i + 1);
      oscillator.connect(filter).connect(gain).connect(root);
      oscillator.start();
      sources.push(oscillator);
      gains.push(gain);
    }
    const voice: ActiveVoice = { id: `ambience:${regionId}`, sources, cleanup: gains };
    this.ambience = voice;
    this.voices.push(voice);
    return true;
  }

  setStoryState(state: { corruption: number; restoration: number; bond: number; dominion: number }): void {
    this.corruption = this.clamp(state.corruption);
    this.restoration = this.clamp(state.restoration);
    this.bond = this.clamp(state.bond);
    this.dominion = this.clamp(state.dominion);
  }

  cancelScope(scopeId: string, _reason: CueCancellationReason): void {
    for (let i = this.voices.length - 1; i >= 0; i--) if (this.voices[i]!.scopeId === scopeId) this.stopVoiceAt(i);
  }

  cancelAll(reason: CueCancellationReason): void {
    for (let i = this.voices.length - 1; i >= 0; i--) this.stopVoiceAt(i);
    this.ambience = undefined;
    if (reason === 'death' || reason === 'load' || reason === 'unload') {
      this.seen.clear();
      this.seenOrder.length = 0;
    }
  }

  stopAmbience(): void {
    if (!this.ambience) return;
    const index = this.voices.indexOf(this.ambience);
    if (index >= 0) this.stopVoiceAt(index);
    this.ambience = undefined;
  }

  measureOutputRms(): number {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.meterSamples);
    let energy = 0;
    for (const sample of this.meterSamples) energy += sample * sample;
    return Math.sqrt(energy / this.meterSamples.length);
  }

  get playbackMetadata(): StoryPlaybackMetadata {
    return { contextState: this.context?.state ?? 'unavailable', activeVoices: this.voices.length, lastPlayed: this.lastPlayed, outputRms: this.measureOutputRms() };
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancelAll('unload');
    this.disposed = true;
    for (const gain of Object.values(this.buses)) gain?.disconnect();
    this.analyser?.disconnect();
    this.master?.disconnect();
    const context = this.context;
    if (this.ownsContext) void context?.close();
    this.context = undefined;
    this.ownsContext = false;
    this.buses.master = undefined;
    this.buses.music = undefined;
    this.buses.effects = undefined;
    this.buses.ambience = undefined;
    this.buses.dialogue = undefined;
    this.analyser = undefined;
    this.seen.clear();
    this.seenOrder.length = 0;
  }

  private createGraph(context: AudioContext): void {
    this.context = context;
    const master = context.createGain();
    const analyser = context.createAnalyser();
    analyser.fftSize = this.meterSamples.length;
    master.connect(analyser).connect(context.destination);
    this.master = master;
    this.analyser = analyser;
    for (const name of ['music', 'effects', 'ambience', 'dialogue'] as const) {
      const bus = context.createGain();
      bus.connect(master);
      this.buses[name] = bus;
    }
    this.buses.master = master;
    if (this.settings) this.setSettings(this.settings);
  }

  private schedule(cue: StoryCue, notes: readonly number[], busName: AudioBusName, position?: Vec3): ActiveVoice {
    const context = this.context!;
    const bus = this.buses[busName]!;
    const at = context.currentTime + 0.012;
    const sources: AudioScheduledSourceNode[] = [];
    const cleanup: AudioNode[] = [];
    let output: AudioNode = bus;
    if (position) {
      const panner = context.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 2;
      panner.maxDistance = 42;
      panner.rolloffFactor = 1;
      panner.positionX.setValueAtTime(position.x, at);
      panner.positionY.setValueAtTime(position.y, at);
      panner.positionZ.setValueAtTime(position.z, at);
      panner.connect(bus);
      cleanup.push(panner);
      output = panner;
    }
    let voice: ActiveVoice | undefined;
    let remaining = notes.length;
    for (let i = 0; i < notes.length; i++) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const frequency = this.frequency(notes[i]!, cue.kind);
      oscillator.type = this.waveform(cue.kind, i);
      oscillator.frequency.setValueAtTime(frequency, at);
      if (cue.kind === 'anticipation' || cue.kind === 'phase' || cue.kind === 'ending') {
        oscillator.frequency.exponentialRampToValueAtTime(Math.max(55, frequency * (cue.phase === 'anticipation' ? 0.82 : 1.04)), at + 0.24);
      }
      const length = this.duration(cue.kind, cue.durationTicks);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.linearRampToValueAtTime(this.level(cue.kind, i, cue.intensity ?? 1), at + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
      oscillator.connect(gain).connect(output);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
        remaining--;
        if (remaining === 0 && voice) this.finishVoice(voice);
      };
      oscillator.start(at);
      oscillator.stop(at + length + 0.03);
      sources.push(oscillator);
    }
    voice = { id: cue.instanceId, sources, scopeId: cue.scopeId, cleanup };
    this.lastPlayed = { instanceId: cue.instanceId, kind: cue.kind, at, bus: busName };
    if (this.onPlayback) this.onPlayback({ ...this.playbackMetadata, lastPlayed: this.lastPlayed });
    return voice;
  }

  private finishVoice(voice: ActiveVoice): void {
    const index = this.voices.indexOf(voice);
    if (index >= 0) this.voices.splice(index, 1);
    for (const node of voice.cleanup) node.disconnect();
    if (this.ambience === voice) this.ambience = undefined;
  }

  private arrangement(kind: StoryCue['kind']): readonly number[] {
    const dark = this.dominion * 4 + this.corruption * 3 - this.restoration * 2;
    const open = this.restoration * 3 + this.bond * 2;
    return SEMITONES[kind].map((step, i) => MIDI_C4 + step + Math.round((i % 2 === 0 ? open : -dark) * 0.42));
  }

  private frequency(midi: number, kind: StoryCue['kind']): number {
    const frequency = A4 * Math.pow(2, (midi - 69) / 12);
    return kind === 'roar-cone' || kind === 'low-wave' || kind === 'grovebreak' || kind === 'ending-dominion' ? frequency * 0.5 : frequency;
  }

  private duration(kind: StoryCue['kind'], ticks?: number): number {
    const authored = ticks ? ticks / 60 : 0.34;
    return Math.min(1.4, Math.max(0.12, authored, kind.startsWith('ending') || kind === 'restoration' ? 0.95 : 0));
  }

  private level(kind: StoryCue['kind'], index: number, intensity: number): number {
    const base = kind === 'hit' || kind === 'roar-cone' || kind === 'grovebreak' ? 0.055 : kind === 'heartbeat' ? 0.018 : 0.035;
    return Math.min(0.08, base * Math.max(0.2, Math.min(1.25, intensity)) / (index + 1));
  }

  private waveform(kind: StoryCue['kind'], index: number): OscillatorType {
    if (kind === 'hit' || kind === 'landing' || kind === 'low-wave') return 'triangle';
    if (kind === 'possession' || kind === 'dominion' || kind === 'grovebreak' || kind === 'ending-dominion') return index === 0 ? 'sawtooth' : 'triangle';
    return index === 0 ? 'sine' : 'triangle';
  }

  private regionTones(regionId: string): readonly number[] {
    if (regionId.includes('hollow') || regionId.includes('grove')) return [110, 164.81, 220];
    if (regionId.includes('canopy') || regionId.includes('forest')) return [98, 146.83, 196];
    if (regionId.includes('marsh') || regionId.includes('wetland')) return [82.41, 123.47, 164.81];
    return [92.5, 138.59, 185];
  }

  private stopVoiceAt(index: number): void {
    const [voice] = this.voices.splice(index, 1);
    if (!voice) return;
    for (const source of voice.sources) {
      try { source.stop(); } catch { /* source already ended */ }
      source.disconnect();
    }
    for (const node of voice.cleanup) node.disconnect();
    if (this.ambience === voice) this.ambience = undefined;
  }

  private clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
}
