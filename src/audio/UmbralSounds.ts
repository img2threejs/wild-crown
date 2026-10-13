import type { StoryCue } from '../effects/story-cues.js';
import { jitter, noise, tone, type SoundLayer } from './WardenSounds.js';

/** Vesper's clips by sound family (the clip id decides the skill, like `resolveUmbralKit`). */
const RIFT = 'vesper-iai-4';
const CUTS = /^vesper-(thousand-cuts|cuts-charge)$/;
const SHADE = /^vesper-shade-(swap|charge)$/;

/**
 * Procedural recipes for Vesper's `umbral` cues (the Warden voice pool and budgets: ≤ 8 layers, level ≤ 0.08, ≤ 1.4 s per layer end).
 * Whispered swishes and thin metallic "shing" partials for the blade, a hollow blink whoosh with a crisp tick for Shadow Step, breathy ink-smoke hush
 * for Mist Blink, a reversed swell and pop for Shade Swap, and a deep crimson detonation for the Requiem. Pure data; never throws.
 */
export function umbralLayers(cue: StoryCue): readonly SoundLayer[] | undefined {
  const action = cue.actionId ?? '', intensity = Math.min(2, Math.max(0.4, cue.intensity ?? 1)), vary = 0.94 + 0.12 * jitter(cue.instanceId);
  const length = Math.min(0.5, Math.max(0.12, (cue.durationTicks ?? 12) / 60 * 1.3));
  switch (cue.kind) {
    case 'slash': {
      if (action === RIFT) return [
        noise(0, 0.4, 0.05, 0.02, 'wind', 'bandpass', 700 * vary, 3600 * vary, 1.1),
        noise(0, 0.3, 0.025, 0.01, 'white', 'highpass', 3600, 6200),
        tone(0, 0.45, 0.05, 0.02, 'sawtooth', 260 * vary, 70, 'lowpass', 900, 220),
        tone(0.04, 0.6, 0.012, 0.01, 'sine', 3100 * vary),
        tone(0.04, 0.5, 0.008, 0.01, 'sine', 4650 * vary),
      ];
      if (CUTS.test(action)) return [
        noise(0, 0.1, 0.035, 0.008, 'white', 'highpass', 3200 * vary, 6500, 1.2),
        tone(0.004, 0.16, 0.012, 0.004, 'sine', 3500 * vary, 2800),
        tone(0.004, 0.12, 0.007, 0.004, 'sine', 5200 * vary),
      ];
      // Iai steps: a whispered swish, then the thin metallic shing of the blade (pitch climbs with the step's intensity).
      const pitch = (0.9 + 0.2 * (intensity - 1)) * vary;
      return [
        noise(0, length, 0.04, 0.012, 'wind', 'bandpass', 1800 * pitch, 5200 * pitch, 1.4),
        noise(0, length * 0.7, 0.014, 0.01, 'white', 'highpass', 4200, 7000),
        tone(0.01, length, 0.012, 0.012, 'sine', 2600 * pitch, 3900 * pitch),
        tone(0.012, length * 0.9, 0.008, 0.012, 'sine', 3900 * pitch, 5200 * pitch),
        tone(0.012, length * 0.8, 0.006, 0.012, 'sine', 5400 * pitch, 6200 * pitch),
      ];
    }
    case 'blink': case 'perfect-dodge': {
      const seconds = Math.min(0.6, Math.max(0.2, (cue.durationTicks ?? 12) / 60 + 0.12));
      if (SHADE.test(action)) return [
        noise(0, 0.3, 0.04, 0.2, 'wind', 'lowpass', 400, 3200, 0.8),
        tone(0, 0.3, 0.04, 0.22, 'sine', 140, 560),
        noise(0.3, 0.2, 0.05, 0.004, 'white', 'highpass', 2400, 1400),
        tone(0.3, 0.3, 0.05, 0.004, 'sine', 360 * vary, 90),
        tone(0.3, 0.5, 0.01, 0.004, 'sine', 2900 * vary),
      ];
      if (action === 'vesper-shadow-step' || action === 'vesper-severing-shadow') return [
        noise(0, 0.28, 0.055, 0.015, 'wind', 'bandpass', 3400, 320, 1),
        tone(0, 0.25, 0.04, 0.01, 'sine', 900 * vary, 160),
        tone(0.02, 0.06, 0.03, 0.002, 'square', 1800, 900, 'highpass', 1200),
        tone(0.2, 0.4, 0.012, 0.005, 'sine', 3300 * vary),
      ];
      if (/^vesper-(requiem|thousand-cuts)$/.test(action)) return [
        noise(0, 0.12, 0.04, 0.006, 'wind', 'bandpass', 2600, 700, 1.1),
        tone(0, 0.1, 0.025, 0.005, 'sine', 700 * vary, 220),
        tone(0.06, 0.22, 0.01, 0.004, 'sine', 3200 * vary),
      ];
      // Mist Blink: a breathy ink hush rising out of nothing, a hollow low note and a faint tick as the body re-forms.
      return [
        noise(0, seconds, 0.045, seconds * 0.4, 'wind', 'bandpass', 600, 2200, 0.7),
        noise(seconds * 0.5, seconds * 0.5, 0.02, 0.08, 'shards', 'highpass', 3600, 5400),
        tone(0, seconds, 0.03, seconds * 0.45, 'triangle', 180 * vary, 110),
        tone(seconds * 0.8, 0.2, 0.012, 0.004, 'sine', 2400 * vary),
      ];
    }
    case 'beam': return [
      noise(0, 0.4, 0.04, 0.03, 'wind', 'bandpass', 1400, 4200, 1),
      tone(0, 0.45, 0.03, 0.03, 'sawtooth', 220 * vary, 90, 'lowpass', 900, 260),
      tone(0.03, 0.5, 0.009, 0.01, 'sine', 3200 * vary),
    ];
    case 'tether': return [
      noise(0, 0.22, 0.04, 0.006, 'crackle', 'bandpass', 2400 * vary, 1200, 1.2),
      tone(0, 0.3, 0.04, 0.01, 'square', 420 * vary, 210, 'lowpass', 1800, 500),
      tone(0.1, 0.35, 0.011, 0.005, 'sine', 3000 * vary),
    ];
    case 'sigil': {
      const sustained = cue.phase === 'sustain', span = sustained ? 1.3 : Math.min(0.8, Math.max(0.3, (cue.durationTicks ?? 24) / 60));
      const base = SHADE.test(action) ? 98 : 110;
      return [
        tone(0, span, 0.032, span * 0.7, 'sawtooth', base, base * 1.5, 'lowpass', 500, 1400),
        tone(0, span, 0.02, span * 0.7, 'triangle', base * 2 * 1.004, base * 3),
        tone(0.02, span, 0.012, span * 0.7, 'sine', base * 8, base * 12),
        noise(0, span, 0.014, span * 0.7, 'shards', 'highpass', 3800, 6200),
      ];
    }
    case 'projectile': return [
      noise(0, 0.22, 0.035, 0.01, 'wind', 'bandpass', 3800 * vary, 1500, 1.3),
      tone(0, 0.2, 0.02, 0.01, 'sine', 3400 * vary, 2200),
      tone(0.01, 0.12, 0.012, 0.008, 'triangle', 1700 * vary, 900),
    ];
    case 'projectile-impact': return [
      noise(0, 0.05, 0.04, 0.002, 'white', 'highpass', 3600, 2200),
      tone(0, 0.28, 0.014, 0.003, 'sine', 3300 * vary),
      tone(0, 0.2, 0.009, 0.003, 'sine', 4900 * vary),
      tone(0, 0.12, 0.045, 0.003, 'sine', 170 * vary, 70),
    ];
    case 'cleanse': return [
      tone(0, 0.9, 0.022, 0.4, 'sine', 196, 294),
      tone(0.04, 0.9, 0.016, 0.4, 'triangle', 247, 370),
      noise(0, 0.8, 0.012, 0.4, 'wind', 'bandpass', 800, 2400),
    ];
    case 'judgement': case 'judgement-mark': return requiem(cue, vary);
    case 'hit': {
      const body = Math.min(1.3, intensity);
      return [
        noise(0, 0.04, 0.055, 0.002, 'white', 'highpass', 2600, 1400),
        tone(0, 0.14, 0.05 * body, 0.003, 'sine', 160 * vary, 60),
        tone(0.006, 0.34, 0.012, 0.004, 'sine', 2300 * vary),
        tone(0.006, 0.26, 0.008, 0.004, 'sine', 3350 * vary),
        tone(0.006, 0.2, 0.006, 0.004, 'sine', 4700 * vary),
      ];
    }
    default: return undefined;
  }
}

/** Crimson Requiem: a low swelling drone with a whisper for the cast, a hush on the blink, a hard crimson detonation on the finale, a thin ping for each mark. */
function requiem(cue: StoryCue, vary: number): readonly SoundLayer[] | undefined {
  if (cue.kind === 'judgement-mark' && cue.phase !== 'hit') return [tone(0, 0.35, 0.02, 0.004, 'sine', 1397 * vary), tone(0, 0.28, 0.008, 0.004, 'sine', 2093 * vary)];
  if (cue.phase === 'anticipation') return [
    tone(0, 0.6, 0.04, 0.5, 'sawtooth', 70, 210, 'lowpass', 300, 1800),
    tone(0, 0.6, 0.025, 0.5, 'sine', 330, 660),
    noise(0, 0.6, 0.02, 0.5, 'shards', 'highpass', 3000, 5600),
  ];
  if (cue.phase === 'commit') return [
    noise(0, 0.3, 0.05, 0.04, 'white', 'bandpass', 500, 3600, 1.1),
    tone(0, 0.3, 0.04, 0.03, 'sine', 240, 80),
    tone(0.02, 0.25, 0.012, 0.04, 'sine', 2000, 3900),
  ];
  if (cue.phase === 'resolve' || cue.phase === 'hit') return [
    noise(0, 0.06, 0.06, 0.002, 'white', 'highpass', 4200, 2200),
    noise(0.01, 0.6, 0.04, 0.01, 'crackle', 'lowpass', 3200, 380),
    tone(0, 0.7, 0.08, 0.004, 'sine', 120 * vary, 38),
    tone(0.01, 0.9, 0.03, 0.01, 'sawtooth', 74, 40, 'lowpass', 400, 120),
    tone(0.012, 0.6, 0.014, 0.004, 'sine', 1890 * vary),
    tone(0.012, 0.5, 0.01, 0.004, 'sine', 2830 * vary),
  ];
  return undefined;
}
