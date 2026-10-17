import type { AudioListener } from 'three';
import type { GameSettings, Vec3 } from '../game/contracts.js';
import type { AttackElement } from '../game/combat/content.js';
import { dangerFamily, type CueCancellationReason, type CuePhase, type StoryCue } from '../effects/story-cues.js';
import { CANOPY_MAX_VOICES, canopyLayers } from './CanopySounds.js';
import { groveLayers } from './GroveSounds.js';
import { mistveilLayers } from './MistveilSounds.js';
import { moonpineLayers } from './MoonpineSounds.js';
import { WARDEN_MAX_LAYERS, isWardenCue, wardenLayers, type SoundLayer, type WardenNoise } from './WardenSounds.js';
import { heartrootLayers } from './HeartrootSounds.js';
import { umbralLayers } from './UmbralSounds.js';
import { emberLayers } from './EmberSounds.js';
import type { RestorationState } from '../../packages/campaign/src/index.js';
import type { ActorSnapshot } from '../game/contracts.js';
import { ActorAudio, type ActorAudioHooks } from './ActorAudio.js';
import { CUE_SOUND_MODE, SAMPLE_REQUESTS, hurtVocalFor, sampleReplacesSynth, samplesForCue } from './CueSoundMap.js';
import { MusicDirector, type MusicContext, type StemSnapshot } from './MusicDirector.js';
import { CombatIntensity, type MusicMixState, type StemId } from './MusicMix.js';
import { SampleBank, type SampleBankDeps, type SampleBankStats } from './SampleBank.js';
import {
  AMBIENCE_TRACKS, MUSIC_TRACKS, STINGERS, footGroupId, reactionGroupId, regionPlanOf, surfacePackId, uiGroupId, vocalGroupId, vocalPackId,
  type FootSurface, type RegionAudioPlan, type StingerId, type UiSound, type VocalFamily, type VocalKind,
} from './SampleCatalog.js';
import { SamplePlayer, type LastSample, type SamplePlayerStats } from './SamplePlayer.js';
import { StreamedLoop, type LoopState, type MediaLike } from './StreamedLoop.js';

export type AudioBusName = 'master' | 'music' | 'effects' | 'ambience' | 'dialogue';
export interface StoryAudioOptions {
  readonly listener?: AudioListener;
  /**
   * Supplies a shared context at unlock time (the app-level title/UI mixer borrows the renderer's context so there is one clock and
   * one device); without it the listener's context is borrowed, else the mixer owns and closes its own.
   */
  readonly acquireContext?: () => AudioContext;
  readonly onPlayback?: (metadata: StoryPlaybackMetadata & { readonly lastPlayed: NonNullable<StoryPlaybackMetadata['lastPlayed']> }) => void;
  /** Overrides how encoded samples are fetched and decoded; `false` disables the sample library (procedural cues only). */
  readonly samples?: SampleBankDeps | false;
  /** Overrides the streamed-media factory; `false` disables streamed music and ambience. Defaults to `new Audio()` when available. */
  readonly createMedia?: (() => MediaLike) | false;
  /** Site-relative prefix of `audio/...` paths (default `/`). */
  readonly baseUrl?: string;
  /** Randomness source for variant and jitter choice (tests inject a deterministic one). */
  readonly random?: () => number;
}
export interface StoryPlaybackMetadata {
  readonly contextState: AudioContextState | 'unavailable';
  readonly activeVoices: number;
  readonly lastPlayed?: { readonly instanceId: string; readonly kind: StoryCue['kind']; readonly at: number; readonly bus: AudioBusName };
  readonly outputRms: number;
}
export interface AudioListenerPose { readonly position: Vec3; readonly forward: Vec3; readonly up: Vec3 }
interface ActiveVoice { readonly id: string; readonly sources: readonly AudioScheduledSourceNode[]; readonly scopeId?: string; readonly cleanup: readonly AudioNode[]; readonly warden?: true; readonly canopy?: true }
/** Warden voices alive at once; a new cast steals the oldest beyond this so five-mark detonations and combos never pile up. */
const MAX_WARDEN_VOICES = 10;
/** Bus multipliers while a dialogue line is on screen (dialogue itself is never ducked) and while a stinger plays. */
export const DIALOGUE_DUCK = { music: 0.35, ambience: 0.5, effects: 0.75 } as const;
export const STINGER_DUCK = { music: 0.2, ambience: 0.5 } as const;
/** Resting level of an ambience bed on the ambience bus; beds recede by up to 45% at full combat intensity. */
export const AMBIENCE_LEVEL = 0.9;
/** Stream clock period (combat intensity, stem crossfades, loop wraps). */
export const STREAM_TICK_MS = 200;
/** Minimum seconds between hurt vocals of the same victim, and between roars of the same actor. */
export const HURT_VOCAL_GAP_SECONDS = 0.45;
export const ROAR_GAP_SECONDS = 1.2;

/** Live mixer diagnostics (smoke tests, debug overlays). */
export interface StoryMixerState {
  readonly contextState: AudioContextState | 'unavailable';
  readonly sampleRate: number;
  readonly busGains: Readonly<Partial<Record<AudioBusName, number>>>;
  readonly region: string | undefined;
  readonly mix: MusicMixState;
  readonly combatLevel: number;
  readonly stems: Readonly<Partial<Record<StemId, StemSnapshot>>>;
  readonly ambience: readonly { readonly url: string; readonly state: LoopState; readonly gain: number; readonly wraps: number }[];
  readonly dialogueDucked: boolean;
  readonly stingerActive: boolean;
  readonly samples: (SampleBankStats & { readonly player: SamplePlayerStats | undefined; readonly last: LastSample | undefined }) | undefined;
  readonly streamingAvailable: boolean;
}

const SEMITONES: Readonly<Record<StoryCue['kind'], readonly number[]>> = {
  cancel: [],
  active: [-7, 0],
  anticipation: [0, 7], commit: [-5, 0], hit: [-12], landing: [-7], 'perfect-dodge': [7, 12],
  heartroot: [0, 7, 12], tether: [0, 5, 12], cleanse: [0, 4, 7], bond: [0, 5, 9], dominion: [-12, -5, 2],
  restoration: [0, 4, 7, 11], possession: [-12, -9], phase: [-5, 0, 7], ending: [0, 4, 7, 12],
  'ending-living-pact': [0, 4, 7, 11], 'ending-dominion': [-12, -5, 2], 'ending-severance': [0, 6, 1, 8],
  'restoration-water': [0, 7, 12], 'restoration-roots': [0, 4, 7], 'restoration-seeds': [0, 5, 9], 'restoration-animals': [0, 5, 9, 12],
  'sap-vein': [-12], footprint: [-7], pounce: [-5, 0], 'roar-cone': [-12, -5], 'low-wave': [-12, -7],
  grovebreak: [-12, -5, 0], march: [-7, 0], reunion: [0, 5, 9], heartbeat: [0],
  sigil: [], projectile: [], 'projectile-impact': [], slash: [], lightning: [], judgement: [], 'judgement-mark': [],
  'root-eruption': [-12, 0, 7], beam: [0, 7, 12], bloom: [0, 4, 7, 12], blink: [7, 12],
  // Reaction cues are sample-only; the empty arrangements are never voiced.
  'reaction-start': [], 'wall-impact': [], 'poise-break': [], getup: [],
  // Companion chimes: Vara's mark rings high, Asha's guard is a low fifth, a command a clean fifth, Tali's shelter a soft major triad.
  mark: [7, 12], guard: [-12, -5], command: [0, 7], shelter: [0, 4, 7],
  // Vara's Storm Talon: wind descent, dive tail, talons on contact, settle on landing.
  'storm-talon': [0, -5, -7, -12],
};
const KIND_BUS: Readonly<Record<StoryCue['kind'], AudioBusName>> = {
  cancel: 'effects',
  active: 'effects',
  anticipation: 'effects', commit: 'effects', hit: 'effects', landing: 'effects', 'perfect-dodge': 'effects',
  heartroot: 'music', tether: 'effects', cleanse: 'effects', bond: 'effects', dominion: 'effects', restoration: 'music',
  possession: 'effects', phase: 'music', ending: 'music', 'ending-living-pact': 'music', 'ending-dominion': 'music', 'ending-severance': 'music',
  'restoration-water': 'ambience', 'restoration-roots': 'effects', 'restoration-seeds': 'music', 'restoration-animals': 'ambience', 'sap-vein': 'effects', footprint: 'effects',
  pounce: 'effects', 'roar-cone': 'effects', 'low-wave': 'effects', grovebreak: 'music', march: 'effects',
  reunion: 'music', heartbeat: 'ambience',
  sigil: 'effects', projectile: 'effects', 'projectile-impact': 'effects', slash: 'effects', lightning: 'effects', judgement: 'effects', 'judgement-mark': 'effects',
  'root-eruption': 'effects', beam: 'effects', bloom: 'effects', blink: 'effects',
  'reaction-start': 'effects', 'wall-impact': 'effects', 'poise-break': 'effects', getup: 'effects',
  mark: 'effects', guard: 'effects', command: 'effects', shelter: 'effects', 'storm-talon': 'effects',
};
const MIDI_C4 = 60;
const A4 = 440;
const DANGER_NOTES = { strike: [0], sweep: [0, 3, 7], wave: [-12, -7], area: [0, 4, 7, 12], projectile: [12, 19] } as const;
const DANGER_WAVEFORMS = { strike: 'triangle', sweep: 'sawtooth', wave: 'sine', area: 'triangle', projectile: 'square' } as const;
/**
 * Recognisable procedural timbres for each elemental attack. Each element keeps its own rooted triad so the
 * four families are distinguishable in overlapping combat while reusing the same waveform/voice budget.
 * Phase modulations stay bounded so the existing pause/cancel/unlock contracts do not change.
 */
interface ElementTimbre {
  readonly root: readonly number[]; // semitones from MIDI_C4 for anticipation / commit / active / hit
  readonly waveform: OscillatorType;
  readonly noiseColor: 'wind' | 'embers' | 'shards' | 'fog' | 'crackle';
  readonly levelScale: number;
}
const ELEMENT_TIMBRE: Readonly<Record<AttackElement, ElementTimbre>> = {
  fire:  { root: [-5, -7, -10, -15], waveform: 'sine',     noiseColor: 'embers', levelScale: 0.95 },
  ice:   { root: [12, 7, 4, 0],    waveform: 'triangle', noiseColor: 'shards',  levelScale: 0.9 },
  wind:  { root: [-12, -7, -5, -2], waveform: 'sawtooth', noiseColor: 'wind',    levelScale: 0.88 },
  poison: { root: [-8, -5, -3, 0],  waveform: 'square',   noiseColor: 'fog',     levelScale: 0.78 },
  arcane: { root: [0, 4, 7, 12],    waveform: 'triangle', noiseColor: 'shards',  levelScale: 0.92 },
  lightning: { root: [-12, -5, 0, 7], waveform: 'sawtooth', noiseColor: 'crackle', levelScale: 0.95 },
  heartroot: { root: [0, 4, 7, 12], waveform: 'sine', noiseColor: 'shards', levelScale: 0.8 },
  umbral: { root: [-7, -12, -5, -14], waveform: 'sawtooth', noiseColor: 'fog', levelScale: 0.85 },
  ember: { root: [-10, -7, -12, -17], waveform: 'sine', noiseColor: 'embers', levelScale: 0.95 },
};
type NoiseColor = ElementTimbre['noiseColor'] | WardenNoise;
function fillNoiseBuffer(buffer: AudioBuffer, color: NoiseColor): void {
  const channels = buffer.numberOfChannels;
  for (let channel = 0; channel < channels; channel++) {
    const data = buffer.getChannelData(channel);
    let prev = 0;
    for (let i = 0; i < data.length; i++) {
      let sample = Math.random() * 2 - 1;
      if (color === 'wind') sample = (Math.random() * 2 - 1) * 0.6 + prev * 0.4;
      else if (color === 'shards') sample = (Math.random() < 0.985 ? 0 : (Math.random() * 2 - 1)) * 0.85;
      else if (color === 'fog') sample = (Math.random() * 2 - 1) * 0.45 + prev * 0.55;
      else if (color === 'crackle') sample = Math.random() < 0.3 ? Math.random() * 2 - 1 : prev * 0.2;
      data[i] = sample;
      prev = sample;
    }
  }
}

/**
 * Region and title mixer: licensed sample library (impacts, whooshes, reactions, footsteps, vocals, UI), streamed music/ambience and the
 * remaining procedural cues (telegraphs, spell timbres, story chords). Browser-unlocked; the five buses and settings volumes are shared.
 */
export class StoryAudio {
  private actorClock = 0;
  private context: AudioContext | undefined;
  private ownsContext = false;
  private master: GainNode | undefined;
  private analyser: AnalyserNode | undefined;
  private readonly meterSamples = new Float32Array(512);
  private readonly buses: Partial<Record<AudioBusName, GainNode>> = {};
  private readonly voices: ActiveVoice[] = [];
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];
  /** Lazily-built shared loop buffers keyed by elemental noise color so elemental cues never allocate per fire. */
  private readonly noiseBuffers: Partial<Record<NoiseColor, AudioBuffer>> = {};
  private readonly listener?: AudioListener;
  private readonly onPlayback?: StoryAudioOptions['onPlayback'];
  private disposed = false;
  private settings: GameSettings | undefined;
  private restoration = 0;
  private bond = 0;
  private corruption = 0;
  private dominion = 0;
  private lastPlayed: StoryPlaybackMetadata['lastPlayed'];
  private bank: SampleBank | undefined;
  private samplePlayer: SamplePlayer | undefined;
  private music: MusicDirector | undefined;
  private actorAudio: ActorAudio | undefined;
  private mediaFactory: (() => MediaLike) | undefined;
  private streamTimer: unknown;
  private musicOff = false;
  /** A region requested before the context was running; started by `unlock` once it is. */
  private pendingRegion: string | undefined;
  private streamClock = 0;
  private readonly combat = new CombatIntensity();
  private readonly mix: { -readonly [K in keyof MusicMixState]: MusicMixState[K] } = { menu: false, combat: 0, boss: false, restoration: 0, corruption: 0 };
  private region: { id: string; plan: RegionAudioPlan } | undefined;
  private bossEngaged = false;
  private regionRestoration = 0;
  private regionCorruption = 0;
  private liveCorruption = 0;
  private ambienceLoops: { loop: StreamedLoop; node: GainNode }[] = [];
  private stinger: { media: MediaLike & { readonly ended?: boolean }; node: GainNode; source: MediaElementAudioSourceNode } | undefined;
  private dialogueActive = false;
  private readonly stunLoops = new Map<string, { readonly stop: (fadeSeconds?: number) => void }>();
  private readonly hurtAt = new Map<string, number>();
  private readonly roarAt = new Map<string, number>();
  private readonly random: () => number;
  private readonly baseUrl: string;
  private readonly options: StoryAudioOptions;

  constructor(options: StoryAudioOptions = {}) {
    this.listener = options.listener;
    this.onPlayback = options.onPlayback;
    this.options = options;
    this.random = options.random ?? Math.random;
    this.baseUrl = options.baseUrl ?? '/';
  }

  /** Call only from an actual user gesture so browser autoplay policy can be satisfied. */
  async unlock(): Promise<boolean> {
    if (this.disposed) return false;
    const AudioContextClass = globalThis.AudioContext;
    if (!AudioContextClass) return false;
    if (!this.context) {
      const borrowedContext = this.options.acquireContext?.() ?? this.listener?.context;
      this.ownsContext = borrowedContext === undefined;
      this.createGraph(borrowedContext ?? new AudioContextClass());
    }
    const context = this.context;
    if (!context || context.state === 'closed') return false;
    if (context.state !== 'running') await context.resume();
    const running = context.state === 'running';
    if (running && this.pendingRegion !== undefined && !this.disposed) {
      const regionId = this.pendingRegion;
      this.pendingRegion = undefined;
      this.startBiomeAmbience(regionId);
    }
    return running;
  }

  setSettings(settings: GameSettings): void {
    this.settings = settings;
    this.applyBusGains(0.035);
  }

  setListenerPose(pose: AudioListenerPose): void {
    if (!this.context) return;
    this.samplePlayer?.setListener(pose.position);
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
    if (this.disposed || cue.kind === 'cancel' || !this.context || this.context.state !== 'running' || this.seen.has(cue.instanceId)) return false;
    this.seen.add(cue.instanceId);
    this.seenOrder.push(cue.instanceId);
    if (this.seenOrder.length > 512) this.seen.delete(this.seenOrder.shift()!);
    if (cue.kind === 'restoration' || cue.kind === 'reunion') this.restoration = Math.min(1, this.restoration + 0.24);
    if (cue.kind === 'grovebreak') this.restoration = Math.max(0, this.restoration - 0.12);
    if (cue.kind === 'heartroot' || cue.kind === 'bond' || cue.kind === 'heartbeat') this.bond = Math.min(1, this.bond + 0.2);
    if (cue.kind === 'dominion' || cue.kind === 'ending-dominion') this.dominion = Math.min(1, this.dominion + 0.2);
    const position = sourcePosition ?? cue.position ?? cue.from;
    const culledBefore = this.samplePlayer?.counters.culled ?? 0;
    const voiced = this.voiceCue(cue, position);
    // A sample culled for distance is inaudible by definition: its synth body would be too, so it is skipped as well.
    const culled = (this.samplePlayer?.counters.culled ?? 0) > culledBefore;
    if (CUE_SOUND_MODE[cue.kind] === 'sample' || ((voiced || culled) && sampleReplacesSynth(cue))) return voiced;
    const heroLayers = cue.element === 'heartroot' ? heartrootLayers : cue.element === 'umbral' ? umbralLayers : cue.element === 'ember' ? emberLayers : undefined;
    // Vesper/Sakda cues without a recipe (a generic `active` cue of the element) keep the generic element timbre; a silent Warden-style phase stays silent.
    const layers = heroLayers ? heroLayers(cue) : isWardenCue(cue) ? wardenLayers(cue) : undefined;
    if (layers) {
      const warden = this.playLayered(cue, layers, position, 'warden');
      if (warden) this.voices.push(warden);
      return true;
    }
    if (isWardenCue(cue)) return false;
    // Trial-map monsters (Canopy and the story maps after it) share the bounded wildlife voice pool.
    const canopyLayered = canopyLayers(cue) ?? groveLayers(cue) ?? moonpineLayers(cue) ?? mistveilLayers(cue);
    if (canopyLayered) {
      const canopy = this.playLayered(cue, canopyLayered, position, 'canopy');
      if (canopy) this.voices.push(canopy);
      return true;
    }
    const element = cue.element;
    const family = dangerFamily(cue);
    const phasePitch = cue.phase === 'commit' ? -5 : cue.phase === 'active' ? -7 : cue.phase === 'hit' ? -12 : 0;
    const notes = element
      ? this.elementNotes(element, cue.phase, phasePitch)
      : family ? DANGER_NOTES[family].map(step => MIDI_C4 + step + phasePitch) : this.arrangement(cue.kind);
    const voice = this.schedule(cue, notes, KIND_BUS[cue.kind], position, element);
    this.voices.push(voice);
    return true;
  }

  playAll(cues: readonly StoryCue[]): number {
    let played = 0;
    for (const cue of cues) if (this.play(cue)) played++;
    return played;
  }

  /**
   * Starts a region's sampled score and ambience: streams the exploration cue and the (paused, prefetched) combat cue, lazily adds the
   * boss cue and the corrupted/restored layers, loops the region's ambience beds and loads its footstep surface and vocal packs.
   * Returns false when the context is not running or streaming is unavailable.
   */
  startBiomeAmbience(regionId: string): boolean {
    if (this.disposed) return false;
    if (!this.context || this.context.state !== 'running') {
      this.pendingRegion = regionId;
      return false;
    }
    this.pendingRegion = undefined;
    this.stopAmbience();
    const plan = regionPlanOf(regionId);
    this.region = { id: regionId, plan };
    this.actorAudio?.setSurface(plan.surface);
    if (this.bank) {
      void this.bank.loadPack('core');
      void this.bank.loadPack(surfacePackId(plan.surface));
      for (const family of plan.families) void this.bank.loadPack(vocalPackId(family));
    }
    const director = this.ensureStreams();
    if (!director) return false;
    director.setTracks({
      explore: MUSIC_TRACKS[plan.explore], combat: MUSIC_TRACKS[plan.combat], boss: MUSIC_TRACKS.boss,
      restored: MUSIC_TRACKS['layer-restored'], corrupted: MUSIC_TRACKS['layer-corrupted'],
    }, ['combat']);
    this.mix.menu = false;
    this.musicOff = false;
    this.combat.reset();
    this.bossEngaged = false;
    for (const id of plan.ambience) this.openAmbience(id);
    this.refreshMix(0);
    director.update(0);
    return true;
  }

  /** Region music and ambience for the title/menu screens (own mixer instance, shares the context). */
  startTitleMusic(): boolean {
    if (this.disposed || !this.context) return false;
    const director = this.ensureStreams();
    if (!director) return false;
    director.setTracks({ title: MUSIC_TRACKS.title });
    this.mix.menu = true;
    this.musicOff = false;
    this.refreshMix(0);
    return true;
  }

  /** Fades the title cue out (handing over to the region score, or leaving the menu). */
  stopTitleMusic(): void {
    this.mix.menu = false;
    this.musicOff = true;
    this.music?.silence();
  }

  /** Plays a UI sound (click, hover, confirm, back, ...) on the effects bus; no-op until the core pack has decoded. */
  playUi(sound: UiSound): boolean {
    if (this.disposed || !this.samplePlayer || this.context?.state !== 'running') return false;
    return this.samplePlayer.play(uiGroupId(sound), 1, 1, 0);
  }

  /**
   * Plays the victory or defeat stinger over the score: the stems and ambience duck while it plays and recover after it ends.
   * The stinger is streamed (one short element), never decoded.
   */
  playStinger(id: StingerId): boolean {
    const context = this.context;
    if (this.disposed || !context || context.state !== 'running' || !this.mediaFactory || !this.master) return false;
    this.stopStinger();
    const media = this.mediaFactory() as MediaLike & { readonly ended?: boolean };
    media.src = this.baseUrl + STINGERS[id];
    media.preload = 'auto';
    const source = context.createMediaElementSource(media as unknown as HTMLMediaElement);
    const node = context.createGain();
    source.connect(node).connect(this.master);
    this.stinger = { media, node, source };
    this.applyBusGains(0.1);
    media.play().catch((error: unknown) => { console.warn('[audio] stinger failed to start', error); this.stopStinger(); });
    return true;
  }

  /** Dialogue ducking: music, ambience and effects sit lower while a line is on screen. */
  setDialogueActive(active: boolean): void {
    if (this.dialogueActive === active) return;
    this.dialogueActive = active;
    this.applyBusGains(active ? 0.12 : 0.5);
  }

  setStoryState(state: { corruption: number; restoration: number; bond: number; dominion: number }): void {
    this.corruption = this.clamp(state.corruption);
    this.restoration = this.clamp(state.restoration);
    this.bond = this.clamp(state.bond);
    this.dominion = this.clamp(state.dominion);
    this.liveCorruption = this.corruption;
  }

  /** The current region's restoration state decides which music layer is audible: corrupted ground sounds sick, restored ground sounds open. */
  setRegionRestorationState(state: RestorationState | undefined): void {
    const levels = state === 'restored' ? [1, 0] : state === 'partial' ? [0.5, 0.5] : state === 'corrupted' ? [0, 1] : [0, 0.35];
    this.regionRestoration = levels[0]!;
    this.regionCorruption = levels[1]!;
  }

  /**
   * Snapshot-driven audio: footsteps by surface, monster death and roar vocals, the stun ring loop and the encounter state behind the
   * combat and boss music. Call once per presentation frame; `dtSeconds` defaults to the wall time since the previous call (capped at 0.1 s).
   */
  consumeActors(actors: readonly ActorSnapshot[], dtSeconds?: number): void {
    if (this.disposed || this.context?.state !== 'running') return;
    const now = typeof performance === 'object' ? performance.now() : 0;
    const dt = dtSeconds ?? Math.min(0.1, Math.max(0, (now - this.actorClock) / 1000));
    this.actorClock = now;
    this.actorAudio?.update(actors, dt);
  }

  /** Lets tests and diagnostics advance the stream clock deterministically; the interval timer calls this with real frame time. */
  updateStreams(dtSeconds: number): void {
    const dt = Math.min(0.5, Math.max(0, dtSeconds));
    const level = this.combat.update(dt);
    this.refreshMix(level);
    this.music?.update(dt);
    const now = this.context?.currentTime ?? 0;
    for (const bed of this.ambienceLoops) {
      bed.loop.play();
      bed.loop.tick();
      bed.node.gain.setTargetAtTime(AMBIENCE_LEVEL * (1 - 0.45 * level), now, 0.5);
    }
    const stinger = this.stinger;
    if (stinger && stinger.media.ended) this.stopStinger();
  }

  /** Everything a smoke test or HUD needs to see about the mixer (live values, not cached). */
  get mixerState(): StoryMixerState {
    const bank = this.bank?.stats;
    const gains: Partial<Record<AudioBusName, number>> = {};
    for (const [name, node] of Object.entries(this.buses) as [AudioBusName, GainNode | undefined][]) if (node) gains[name] = node.gain.value;
    return {
      contextState: this.context?.state ?? 'unavailable',
      sampleRate: this.context?.sampleRate ?? 0,
      busGains: gains,
      region: this.region?.id,
      mix: { ...this.mix },
      combatLevel: this.combat.level,
      stems: this.music?.snapshot() ?? {},
      ambience: this.ambienceLoops.map(bed => ({ url: bed.loop.url, state: bed.loop.state, gain: bed.node.gain.value, wraps: bed.loop.wraps })),
      dialogueDucked: this.dialogueActive,
      stingerActive: this.stinger !== undefined,
      samples: bank ? { ...bank, player: this.samplePlayer?.stats, last: this.samplePlayer?.last } : undefined,
      streamingAvailable: this.mediaFactory !== undefined,
    };
  }



  cancelScope(scopeId: string, _reason: CueCancellationReason): void {
    for (let i = this.voices.length - 1; i >= 0; i--) if (this.voices[i]!.scopeId === scopeId) this.stopVoiceAt(i);
  }

  cancelAll(reason: CueCancellationReason): void {
    for (let i = this.voices.length - 1; i >= 0; i--) this.stopVoiceAt(i);
    this.samplePlayer?.stopAll();
    this.stopStunLoops();
    if (reason === 'death' || reason === 'load' || reason === 'unload') {
      this.seen.clear();
      this.seenOrder.length = 0;
      this.hurtAt.clear();
      this.roarAt.clear();
      this.actorAudio?.reset();
      this.combat.reset();
      this.bossEngaged = false;
    }
    if (reason === 'load' || reason === 'unload') this.stopAmbience();
  }

  /** Stops the region's ambience beds and fades its score out. */
  stopAmbience(): void {
    for (const bed of this.ambienceLoops) { bed.loop.dispose(); bed.node.disconnect(); }
    this.ambienceLoops = [];
    this.region = undefined;
    this.pendingRegion = undefined;
    this.musicOff = true;
    this.music?.silence();
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
    this.stopStinger();
    if (this.streamTimer !== undefined) clearInterval(this.streamTimer as number);
    this.streamTimer = undefined;
    this.music?.dispose();
    this.music = undefined;
    this.samplePlayer?.dispose();
    this.samplePlayer = undefined;
    this.bank?.clear();
    this.bank = undefined;
    this.actorAudio = undefined;
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
    for (const color of ['wind', 'embers', 'shards', 'fog', 'crackle', 'white'] as const) this.noiseBuffers[color] = undefined;
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
    this.initSamples(context);
    if (this.settings) this.setSettings(this.settings);
  }

  private applyBusGains(timeConstant: number): void {
    const context = this.context, settings = this.settings;
    if (!context || !settings || !this.master) return;
    const now = context.currentTime;
    this.master.gain.setTargetAtTime(this.clamp(settings.masterVolume), now, 0.035);
    const ducked = this.dialogueActive, stinger = this.stinger !== undefined;
    const music = settings.musicVolume * (stinger ? STINGER_DUCK.music : 1) * (ducked ? DIALOGUE_DUCK.music : 1);
    const ambience = settings.ambienceVolume * (stinger ? STINGER_DUCK.ambience : 1) * (ducked ? DIALOGUE_DUCK.ambience : 1);
    const effects = settings.effectsVolume * (ducked ? DIALOGUE_DUCK.effects : 1);
    this.buses.music!.gain.setTargetAtTime(this.clamp(music), now, timeConstant);
    this.buses.ambience!.gain.setTargetAtTime(this.clamp(ambience), now, timeConstant);
    this.buses.effects!.gain.setTargetAtTime(this.clamp(effects), now, timeConstant);
    this.buses.dialogue!.gain.setTargetAtTime(this.clamp(settings.dialogueVolume), now, 0.035);
    if (this.stinger) this.stinger.node.gain.setTargetAtTime(this.clamp(settings.musicVolume), now, 0.035);
  }

  /** Builds the sample library, voice player and snapshot pass once the graph exists; inert when fetch/decode/media are unavailable. */
  private initSamples(context: AudioContext): void {
    const samples = this.options.samples;
    const deps: SampleBankDeps | undefined = samples === false ? undefined : samples ?? this.defaultSampleDeps(context);
    if (deps) {
      const bank = new SampleBank(deps, (path, error) => { console.warn('[audio] failed to load', path, error); });
      this.bank = bank;
      this.samplePlayer = new SamplePlayer(context, bank, { effects: this.buses.effects, music: this.buses.music, ambience: this.buses.ambience, dialogue: this.buses.dialogue }, this.random);
      this.actorAudio = new ActorAudio(this.actorHooks());
      void bank.loadPack('core');
    }
    const media = this.options.createMedia;
    this.mediaFactory = media === false ? undefined : media ?? (typeof Audio === 'function' && typeof context.createMediaElementSource === 'function' ? () => new Audio() : undefined);
  }

  private defaultSampleDeps(context: AudioContext): SampleBankDeps | undefined {
    if (typeof fetch !== 'function' || typeof context.decodeAudioData !== 'function') return undefined;
    const base = this.baseUrl;
    return {
      fetchBytes: async path => {
        const response = await fetch(base + path);
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
        return response.arrayBuffer();
      },
      decode: bytes => context.decodeAudioData(bytes),
    };
  }

  /** Creates the stream director and its 5 Hz clock on first use. */
  private ensureStreams(): MusicDirector | undefined {
    if (this.music) return this.music;
    const context = this.context, factory = this.mediaFactory, bus = this.buses.music;
    if (!context || !factory || !bus) return undefined;
    this.music = new MusicDirector({
      context: context as unknown as MusicContext,
      output: bus,
      createMedia: factory,
      resolveUrl: path => this.baseUrl + path,
    });
    this.streamClock = typeof performance === 'object' ? performance.now() : 0;
    this.streamTimer = setInterval(() => {
      const now = typeof performance === 'object' ? performance.now() : this.streamClock + STREAM_TICK_MS;
      const dt = (now - this.streamClock) / 1000;
      this.streamClock = now;
      this.updateStreams(dt);
    }, STREAM_TICK_MS);
    return this.music;
  }

  private openAmbience(id: keyof typeof AMBIENCE_TRACKS): void {
    const context = this.context, factory = this.mediaFactory, bus = this.buses.ambience;
    if (!context || !factory || !bus) return;
    const node = context.createGain();
    node.gain.value = AMBIENCE_LEVEL;
    node.connect(bus);
    const loop = new StreamedLoop({
      now: () => context.currentTime,
      createMedia: factory,
      createChain: media => {
        const source = context.createMediaElementSource(media as unknown as HTMLMediaElement);
        const gain = context.createGain();
        source.connect(gain);
        gain.connect(node);
        return { gain, dispose: () => source.disconnect() };
      },
    }, this.baseUrl + AMBIENCE_TRACKS[id], 2.5);
    loop.play();
    this.ambienceLoops.push({ loop, node });
  }

  private refreshMix(combatLevel: number): void {
    if (this.musicOff || !this.music) return;
    this.mix.combat = combatLevel;
    this.mix.boss = this.bossEngaged;
    this.mix.restoration = this.regionRestoration;
    this.mix.corruption = Math.max(this.regionCorruption, this.liveCorruption * 0.6);
    this.music.setState(this.mix);
  }

  /** Voices a cue's sampled part (impact, whoosh, landing, reaction, roar, hurt) and feeds the combat intensity. Returns whether a sample started. */
  private voiceCue(cue: StoryCue, position: Vec3 | undefined): boolean {
    this.notePulse(cue);
    const player = this.samplePlayer;
    if (!player) return false;
    let started = false;
    const count = samplesForCue(cue);
    for (let i = 0; i < count; i++) {
      const request = SAMPLE_REQUESTS[i]!;
      if (player.play(request.group, request.gain, request.rate, request.delay, position)) started = true;
    }
    if (cue.kind === 'roar-cone' && (cue.phase === 'anticipation' || cue.phase === 'commit')) this.markRoar(cue.actorId);
    const hurt = hurtVocalFor(cue);
    if (hurt) {
      const victim = cue.targetId ?? cue.actorId ?? '';
      const now = this.context!.currentTime;
      if (now - (this.hurtAt.get(victim) ?? -10) >= HURT_VOCAL_GAP_SECONDS) {
        this.hurtAt.set(victim, now);
        if (this.playVocal(hurt, 'hurt', position, 0.9)) started = true;
      }
    }
    return started;
  }

  private notePulse(cue: StoryCue): void {
    const kind = cue.kind;
    if (kind === 'hit' && cue.phase === 'hit' && (cue.confirmedDamage === undefined || cue.confirmedDamage > 0)) this.combat.pulse(0.75);
    else if (kind === 'reaction-start' || kind === 'poise-break') this.combat.pulse(0.7);
    else if (cue.attackId !== undefined && (cue.phase === 'anticipation' || cue.phase === 'commit' || cue.phase === 'active')) this.combat.pulse(0.55);
  }

  private markRoar(actorId: string | undefined): void {
    this.roarAt.set(actorId ?? '', this.context?.currentTime ?? 0);
  }

  /** Plays a family vocal; loads the family pack on first need (the first call then plays nothing). */
  private playVocal(family: VocalFamily, kind: VocalKind, position: Vec3 | undefined, gain: number): boolean {
    const player = this.samplePlayer;
    if (!player) return false;
    void this.bank?.loadPack(vocalPackId(family));
    return player.play(vocalGroupId(family, kind), gain, 1, 0, position);
  }

  private actorHooks(): ActorAudioHooks {
    return {
      step: (surface: FootSurface, position, gain, rate) => {
        void this.bank?.loadPack(surfacePackId(surface));
        this.samplePlayer?.play(footGroupId(surface), gain, rate, 0, position);
      },
      death: (family, position) => { this.playVocal(family, 'death', position, 1); },
      roar: (actorId, family, position) => {
        const now = this.context?.currentTime ?? 0;
        if (now - (this.roarAt.get(actorId) ?? -10) < ROAR_GAP_SECONDS) return;
        this.roarAt.set(actorId, now);
        this.playVocal(family, 'roar', position, 1);
      },
      stun: (actorId, active, position) => {
        const existing = this.stunLoops.get(actorId);
        if (!active) { existing?.stop(); this.stunLoops.delete(actorId); return; }
        if (existing) return;
        const handle = this.samplePlayer?.startLoop(reactionGroupId('stun-loop'), 0.7, position);
        if (handle) this.stunLoops.set(actorId, handle);
      },
      encounter: (presence, boss) => {
        this.combat.setPresence(presence);
        this.bossEngaged = boss;
      },
      family: family => { void this.bank?.loadPack(vocalPackId(family)); },
    };
  }

  private stopStunLoops(): void {
    for (const handle of this.stunLoops.values()) handle.stop();
    this.stunLoops.clear();
  }

  private stopStinger(): void {
    const stinger = this.stinger;
    if (!stinger) return;
    this.stinger = undefined;
    stinger.media.pause();
    stinger.media.src = '';
    stinger.source.disconnect();
    stinger.node.disconnect();
    this.applyBusGains(0.5);
  }

  private schedule(cue: StoryCue, notes: readonly number[], busName: AudioBusName, position: Vec3 | undefined, element?: AttackElement): ActiveVoice {
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
    const family = dangerFamily(cue);
    const timbre = element ? ELEMENT_TIMBRE[element] : undefined;
    let noiseSource: AudioBufferSourceNode | undefined;
    let noiseGain: GainNode | undefined;
    let noiseFilter: BiquadFilterNode | undefined;
    if (timbre && (cue.phase === 'anticipation' || cue.phase === 'active' || cue.phase === 'commit')) {
      const buffer = this.getNoiseBuffer(timbre.noiseColor);
      if (buffer) {
        noiseSource = context.createBufferSource();
        noiseSource.buffer = buffer;
        noiseSource.loop = true;
        const filter = context.createBiquadFilter();
        filter.type = timbre.noiseColor === 'fog' || timbre.noiseColor === 'wind' ? 'lowpass' : 'highpass';
        filter.frequency.value = timbre.noiseColor === 'shards' ? 2800 : timbre.noiseColor === 'fog' ? 480 : 720;
        const gain = context.createGain();
        const length = this.duration(cue.kind, cue.durationTicks);
        const noiseLevel = Math.min(0.025, this.level(cue.kind, 0, cue.intensity ?? 1) * 0.45 * timbre.levelScale);
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.linearRampToValueAtTime(noiseLevel, at + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
        noiseSource.connect(filter).connect(gain).connect(output);
        noiseSource.start(at);
        noiseSource.stop(at + length + 0.05);
        cleanup.push(filter, gain);
        sources.push(noiseSource);
        noiseGain = gain;
        noiseFilter = filter;
      }
    }
    let remaining = notes.length + (noiseSource ? 1 : 0);
    for (let i = 0; i < notes.length; i++) {
      const oscillator = context.createOscillator();
      const gain = this.context!.createGain();
      const frequency = this.frequency(notes[i]!, cue.kind);
      oscillator.type = timbre ? timbre.waveform : family ? DANGER_WAVEFORMS[family] : this.waveform(cue.kind, i);
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
    if (noiseSource) {
      noiseSource.onended = () => {
        noiseSource.disconnect();
        noiseGain?.disconnect();
        noiseFilter?.disconnect();
        remaining--;
        if (remaining === 0 && voice) this.finishVoice(voice);
      };
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
  }

  /**
   * Voices a Warden or Whispering Canopy cue from its procedural layers: oscillator glides and filtered looped-noise bursts with
   * attack/decay envelopes. At most MAX_WARDEN_VOICES / CANOPY_MAX_VOICES stay alive per pool (the oldest is stolen); every node
   * is released when its source ends or the scope is cancelled, exactly like the generic voices.
   */
  private playLayered(cue: StoryCue, layers: readonly SoundLayer[], position: Vec3 | undefined, pool: 'warden' | 'canopy'): ActiveVoice | undefined {
    const context = this.context!, busName = KIND_BUS[cue.kind], bus = this.buses[busName]!, at = context.currentTime + 0.012;
    const sources: AudioScheduledSourceNode[] = [], cleanup: AudioNode[] = [];
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
    for (;;) {
      let alive = 0, oldest = -1;
      for (let i = 0; i < this.voices.length; i++) if (pool === 'warden' ? this.voices[i]!.warden : this.voices[i]!.canopy) { alive++; if (oldest < 0) oldest = i; }
      if (alive < (pool === 'warden' ? MAX_WARDEN_VOICES : CANOPY_MAX_VOICES) || oldest < 0) break;
      this.stopVoiceAt(oldest);
    }
    let remaining = 0;
    let voice: ActiveVoice | undefined;
    for (const layer of layers.slice(0, WARDEN_MAX_LAYERS)) {
      const start = at + layer.delay, end = start + layer.length;
      const gain = context.createGain();
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(layer.level, start + Math.max(0.001, Math.min(layer.attack, layer.length * 0.9)));
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      let source: AudioScheduledSourceNode;
      if (layer.source === 'tone') {
        const oscillator = context.createOscillator();
        oscillator.type = layer.wave ?? 'sine';
        oscillator.frequency.setValueAtTime(layer.from ?? 440, start);
        if (layer.to !== undefined && layer.to !== layer.from) oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, layer.to), end);
        oscillator.start(start);
        source = oscillator;
      } else {
        const buffer = this.getNoiseBuffer(layer.noise ?? 'white');
        if (!buffer) { gain.disconnect(); continue; }
        const noise = context.createBufferSource();
        noise.buffer = buffer;
        noise.loop = true;
        noise.start(start, Math.random() * 0.2);
        source = noise;
      }
      let filter: BiquadFilterNode | undefined;
      if (layer.filter && layer.filterFrom) {
        filter = context.createBiquadFilter();
        filter.type = layer.filter;
        filter.frequency.setValueAtTime(layer.filterFrom, start);
        if (layer.filterTo !== undefined && layer.filterTo !== layer.filterFrom) filter.frequency.exponentialRampToValueAtTime(Math.max(20, layer.filterTo), end);
        if (layer.q) filter.Q.value = layer.q;
        source.connect(filter).connect(gain);
        cleanup.push(filter);
      } else source.connect(gain);
      gain.connect(output);
      cleanup.push(gain);
      source.stop(end + 0.03);
      const owned = filter;
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
        owned?.disconnect();
        remaining--;
        if (remaining === 0 && voice) this.finishVoice(voice);
      };
      sources.push(source);
      remaining++;
    }
    if (sources.length === 0) { for (const node of cleanup) node.disconnect(); return undefined; }
    voice = pool === 'warden'
      ? { id: cue.instanceId, sources, scopeId: cue.scopeId, cleanup, warden: true }
      : { id: cue.instanceId, sources, scopeId: cue.scopeId, cleanup, canopy: true };
    this.lastPlayed = { instanceId: cue.instanceId, kind: cue.kind, at, bus: busName };
    if (this.onPlayback) this.onPlayback({ ...this.playbackMetadata, lastPlayed: this.lastPlayed });
    return voice;
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

  /**
   * Build a recognisable voiced root/chord for an elemental cue. Phase picks which root pitch to anchor; sustained
   * phases retread the same interval so cancel/pause paths stay tonally stable.
   */
  private elementNotes(element: AttackElement, phase: CuePhase, phasePitch: number): readonly number[] {
    const root = ELEMENT_TIMBRE[element].root;
    const phaseIndex = phase === 'anticipation' ? 0 : phase === 'commit' ? 1 : phase === 'active' ? 2 : phase === 'hit' ? 3 : 0;
    const anchor = root[phaseIndex]! + MIDI_C4;
    const triadOffset = element === 'ice' ? [0, 7, 12] : element === 'poison' ? [0, -2, 3] : element === 'wind' ? [0, -5, 4] : element === 'arcane' ? [0, 5, 12] : element === 'lightning' ? [0, -1, 6] : [0, 3, 7];
    return triadOffset.map(step => anchor + step + phasePitch);
  }

  /** Lazily build (and memoize) a procedural noise buffer tuned for an elemental color. */
  private getNoiseBuffer(color: NoiseColor): AudioBuffer | undefined {
    if (!this.context) return undefined;
    const cached = this.noiseBuffers[color];
    if (cached) return cached;
    const buffer = this.context.createBuffer(1, Math.floor(0.5 * this.context.sampleRate), this.context.sampleRate);
    fillNoiseBuffer(buffer, color);
    this.noiseBuffers[color] = buffer;
    return buffer;
  }

  private stopVoiceAt(index: number): void {
    const [voice] = this.voices.splice(index, 1);
    if (!voice) return;
    for (const source of voice.sources) {
      try { source.stop(); } catch { /* source already ended */ }
      source.disconnect();
    }
    for (const node of voice.cleanup) node.disconnect();
  }

  private clamp(value: number): number { return Math.max(0, Math.min(1, value)); }
}
