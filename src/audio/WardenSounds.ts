import type { StoryCue } from '../effects/story-cues.js';

/** Noise colours the Warden recipes ask the synth for (buffers are built once and looped by `StoryAudio`). */
export type WardenNoise = 'white' | 'wind' | 'shards' | 'crackle';

/**
 * One procedural voice layer: an oscillator glide or a filtered noise burst with an attack/decay envelope.
 * Pure data, so recipes are testable without a WebAudio context and always stay inside the voice/level budget.
 */
export interface SoundLayer {
  readonly source: 'tone' | 'noise';
  /** Seconds after the cue starts, seconds the layer sounds, peak gain and seconds to reach it. */
  readonly delay: number;
  readonly length: number;
  readonly level: number;
  readonly attack: number;
  readonly wave?: OscillatorType;
  /** Oscillator frequency glide (Hz). */
  readonly from?: number;
  readonly to?: number;
  readonly noise?: WardenNoise;
  readonly filter?: BiquadFilterType;
  readonly filterFrom?: number;
  readonly filterTo?: number;
  readonly q?: number;
}

/** Hard budgets every recipe obeys. */
export const WARDEN_MAX_LAYERS = 8;
export const WARDEN_MAX_LEVEL = 0.08;
export const WARDEN_MAX_SECONDS = 1.4;

export const tone = (delay: number, length: number, level: number, attack: number, wave: OscillatorType, from: number, to = from, filter?: BiquadFilterType, filterFrom?: number, filterTo = filterFrom): SoundLayer =>
  ({ source: 'tone', delay, length, level: Math.min(WARDEN_MAX_LEVEL, level), attack, wave, from, to, filter, filterFrom, filterTo });
export const noise = (delay: number, length: number, level: number, attack: number, color: WardenNoise, filter: BiquadFilterType, filterFrom: number, filterTo = filterFrom, q = 1): SoundLayer =>
  ({ source: 'noise', delay, length, level: Math.min(WARDEN_MAX_LEVEL, level), attack, noise: color, filter, filterFrom, filterTo, q });

/** Stable 0..1 jitter from an id so repeated cues (five Judgement marks) never sound identical but stay deterministic. */
export function jitter(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return ((hash >>> 0) % 1000) / 1000;
}

/** True for the cues the Warden arsenal voices itself (everything else keeps the generic arrangement/element path). */
export function isWardenCue(cue: StoryCue): boolean {
  switch (cue.kind) {
    case 'slash': case 'sigil': case 'projectile': case 'projectile-impact': case 'lightning': case 'judgement': case 'judgement-mark': return true;
    case 'hit': return cue.actorId === 'aren' && (cue.element === 'arcane' || cue.element === 'lightning');
    default: return false;
  }
}

/**
 * Layers for a Warden cue, or undefined when the cue is not a Warden cue (or this phase is silent).
 * - slash: crisp filtered-noise swish whose pitch rises with intensity (plus weight for the heavy blows)
 * - hit: noise click + low thump + metallic inharmonic ring (arcane) or crack + zap (lightning)
 * - sigil: rising shimmering triangle chord with detuned partials
 * - projectile: airy whoosh with a high whistle; projectile-impact: glassy shatter + thump
 * - lightning: sharp crack, crackle tail and a low rumble
 * - judgement: rising swell / whoosh / sheath "shing"; judgement-mark: soft ping / sharp detonation
 */
export function wardenLayers(cue: StoryCue): readonly SoundLayer[] | undefined {
  if (!isWardenCue(cue)) return undefined;
  const intensity = Math.min(2, Math.max(0.3, cue.intensity ?? 1)), seconds = Math.min(WARDEN_MAX_SECONDS, Math.max(0.05, (cue.durationTicks ?? 12) / 60)), vary = 0.94 + 0.12 * jitter(cue.instanceId);
  switch (cue.kind) {
    case 'slash': {
      const pitch = (0.85 + 0.4 * (intensity - 1)) * vary, length = Math.min(0.34, Math.max(0.12, seconds * 1.3));
      const layers = [
        noise(0, length, 0.05, 0.012, 'white', 'bandpass', 1500 * pitch, 4600 * pitch, 1.3),
        noise(0, length * 0.7, 0.02, 0.01, 'wind', 'highpass', 3000 * pitch, 6000 * pitch),
        tone(0.005, length * 0.8, 0.012, 0.02, 'sine', 900 * pitch, 2600 * pitch),
      ];
      if (intensity >= 1.5) layers.push(tone(0, 0.24, 0.035, 0.01, 'sine', 150 * pitch, 62));
      return layers;
    }
    case 'hit': {
      const body = Math.min(1.3, intensity);
      if (cue.element === 'lightning') {
        return [
          noise(0, 0.05, 0.06, 0.002, 'white', 'highpass', 2200, 1200),
          noise(0.01, 0.26, 0.03 * body, 0.004, 'crackle', 'bandpass', 3400 * vary, 1400, 1.1),
          tone(0, 0.14, 0.06 * body, 0.003, 'sine', 160, 52),
          tone(0.005, 0.12, 0.02, 0.004, 'sawtooth', 2800 * vary, 500, 'lowpass', 3600, 900),
        ];
      }
      return [
        noise(0, 0.04, 0.06, 0.002, 'white', 'highpass', 1900, 1000),
        tone(0, 0.17, 0.07 * body, 0.003, 'sine', 150 * vary, 55),
        tone(0.008, 0.36, 0.011, 0.004, 'sine', 1320 * vary),
        tone(0.008, 0.3, 0.008, 0.004, 'sine', 1980 * vary),
        tone(0.008, 0.24, 0.006, 0.004, 'sine', 2870 * vary),
      ];
    }
    case 'sigil': {
      const sustained = cue.phase === 'sustain', length = sustained ? 1.3 : Math.min(0.6, Math.max(0.22, seconds)), peak = sustained ? 0.55 : 0.8, base = 220 * (cue.intensity && cue.intensity > 1.2 ? 1.12 : 1);
      const layers = [
        tone(0, length, 0.03, length * peak, 'triangle', base * 0.78, base),
        tone(0, length, 0.022, length * peak, 'triangle', base * 0.78 * 1.006, base * 1.006),
        tone(0.02, length, 0.02, length * peak, 'triangle', base * 1.498 * 0.8, base * 1.498),
        tone(0.04, length, 0.014, length * peak, 'sine', base * 2 * 0.8, base * 2),
        noise(0, length, 0.012, length * peak, 'shards', 'highpass', 3600, 5200),
      ];
      if ((cue.intensity ?? 1) > 1.2) layers.push(tone(0.06, length, 0.012, length * peak, 'sine', base * 2.519 * 0.8, base * 2.519));
      return layers;
    }
    case 'projectile': {
      const wave = cue.actionId === 'crescent-wave';
      return wave
        ? [
          noise(0, 0.5, 0.05, 0.03, 'wind', 'bandpass', 1300 * vary, 320, 0.9),
          tone(0, 0.42, 0.03, 0.04, 'sawtooth', 320, 120, 'lowpass', 900, 300),
          tone(0.02, 0.36, 0.012, 0.03, 'sine', 1900 * vary, 900),
        ]
        : [
          noise(0, 0.32, 0.04, 0.02, 'wind', 'bandpass', 2900 * vary, 700, 1),
          tone(0, 0.28, 0.014, 0.03, 'sine', 2700 * vary, 1500),
          tone(0.01, 0.2, 0.01, 0.02, 'triangle', 1350 * vary, 760),
        ];
    }
    case 'projectile-impact': {
      const wall = (cue.intensity ?? 1) < 0.8, wave = cue.actionId === 'crescent-wave', gain = wall ? 0.7 : 1;
      return [
        noise(0, wave ? 0.4 : 0.3, 0.05 * gain, 0.003, 'shards', 'highpass', 3500, 2400),
        noise(0, 0.12, 0.03 * gain, 0.002, 'white', 'highpass', 3000, 1800),
        tone(0, 0.2, 0.012 * gain, 0.003, 'sine', 2400 * vary),
        tone(0, 0.16, 0.009 * gain, 0.003, 'sine', 3100 * vary),
        tone(0, 0.12, 0.007 * gain, 0.003, 'sine', 4200 * vary),
        tone(0, wave ? 0.3 : 0.18, (wave ? 0.07 : 0.05) * gain, 0.004, 'sine', (wave ? 100 : 125) * vary, 46),
      ];
    }
    case 'lightning':
      return [
        noise(0, 0.08, 0.08, 0.001, 'white', 'highpass', 2000, 900),
        noise(0.02, 0.42, 0.03, 0.006, 'crackle', 'bandpass', 1600 * vary, 900, 0.9),
        tone(0, 0.12, 0.02, 0.002, 'sine', 3200, 300),
        tone(0.03, 1.1, 0.06, 0.05, 'sawtooth', 62 * vary, 36, 'lowpass', 260, 110),
        tone(0.03, 0.9, 0.04, 0.05, 'sine', 48 * vary, 32),
      ];
    case 'judgement':
      if (cue.phase === 'anticipation') {
        return [
          tone(0, 0.45, 0.04, 0.38, 'sawtooth', 110, 330, 'lowpass', 400, 2400),
          tone(0, 0.45, 0.03, 0.38, 'sine', 440, 880),
          noise(0, 0.45, 0.012, 0.38, 'shards', 'highpass', 3000, 5000),
        ];
      }
      if (cue.phase === 'commit') {
        return [
          noise(0, 0.32, 0.06, 0.05, 'white', 'bandpass', 600, 3800, 1.1),
          tone(0, 0.3, 0.04, 0.03, 'sine', 210, 90),
          tone(0.02, 0.24, 0.012, 0.05, 'sine', 1800, 3800),
        ];
      }
      if (cue.phase === 'resolve') {
        return [
          noise(0, 0.05, 0.04, 0.002, 'white', 'highpass', 5000, 3000),
          tone(0.01, 0.55, 0.016, 0.004, 'sine', 2400),
          tone(0.01, 0.5, 0.012, 0.004, 'sine', 3600),
          tone(0.01, 0.4, 0.008, 0.004, 'sine', 4800),
          tone(0, 0.2, 0.03, 0.004, 'sine', 120, 70),
        ];
      }
      return undefined;
    case 'judgement-mark':
      if (cue.phase === 'hit') {
        return [
          noise(0, 0.26, 0.07, 0.003, 'white', 'lowpass', 4000, 400),
          noise(0, 0.04, 0.05, 0.001, 'white', 'highpass', 2600, 1800),
          tone(0, 0.22, 0.07, 0.004, 'sine', 110 * vary, 45),
        ];
      }
      return [tone(0, 0.35, 0.02, 0.004, 'sine', 1568 * vary), tone(0, 0.28, 0.008, 0.004, 'sine', 2349 * vary)];
    default: return undefined;
  }
}
