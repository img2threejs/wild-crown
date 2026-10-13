import type { StoryCue } from '../effects/story-cues.js';
import { jitter, noise, tone, type SoundLayer } from './WardenSounds.js';

/** Sakda's clips by sound family. */
const KICKS = /^sakda-(limb-3|limb-4|flying-knee|knee-charge|tigers-wrath|tempest)$/;
const HEAVY = /^sakda-(flying-knee|tigers-wrath|tempest)$/;

/**
 * Procedural recipes for Sakda's `ember` cues (the Warden voice pool and budgets: ≤ 8 layers, level ≤ 0.08, ≤ 1.4 s per layer end).
 * Meaty low thuds and a dry noise click for fists and elbows, a sharper crack for kicks and knees, a fire roar for the roundhouse, charges and
 * Tiger's Wrath, a rolling sonic thump for Echo Wave, a flame whoosh for dashes and a warm two-note hum for Guard Dash's shield. Pure data; never throws.
 */
export function emberLayers(cue: StoryCue): readonly SoundLayer[] | undefined {
  const action = cue.actionId ?? '', intensity = Math.min(2, Math.max(0.4, cue.intensity ?? 1)), vary = 0.94 + 0.12 * jitter(cue.instanceId);
  const kick = KICKS.test(action), heavy = HEAVY.test(action);
  switch (cue.kind) {
    case 'slash': {
      if (action === 'sakda-limb-4' || action === 'sakda-tigers-wrath') return [
        noise(0, 0.5, 0.05, 0.03, 'wind', 'bandpass', 500 * vary, 2600 * vary, 0.9),
        noise(0.02, 0.6, 0.035, 0.05, 'crackle', 'lowpass', 2400, 500),
        tone(0, 0.5, 0.06, 0.02, 'sawtooth', 130 * vary, 52, 'lowpass', 700, 180),
        tone(0.03, 0.4, 0.05, 0.01, 'sine', 90, 40),
      ];
      if (heavy) return [
        noise(0, 0.5, 0.05, 0.01, 'crackle', 'lowpass', 3000, 400),
        tone(0, 0.7, 0.08, 0.004, 'sine', 110 * vary, 34),
        tone(0.01, 0.5, 0.04, 0.01, 'sawtooth', 80, 38, 'lowpass', 500, 140),
      ];
      // Limb strikes: a short breathy whoosh of the swing.
      return [
        noise(0, 0.14, 0.035, 0.01, 'wind', 'bandpass', 700 * vary, 2000 * vary, 1),
        tone(0, 0.12, 0.02, 0.01, 'sine', 240 * vary, 130),
      ];
    }
    case 'hit': {
      const body = Math.min(1.3, intensity);
      if (heavy) return [
        noise(0, 0.05, 0.07, 0.002, 'white', 'highpass', 2400, 1000),
        noise(0.01, 0.55, 0.04, 0.01, 'crackle', 'lowpass', 3000, 380),
        tone(0, 0.6, 0.08, 0.004, 'sine', 100 * vary, 34),
        tone(0.01, 0.35, 0.03, 0.004, 'sawtooth', 70, 36, 'lowpass', 400, 120),
      ];
      if (kick) return [
        noise(0, 0.045, 0.07, 0.002, 'white', 'highpass', 2800, 1400),
        noise(0.005, 0.12, 0.04, 0.003, 'white', 'bandpass', 1400, 600, 1.2),
        tone(0, 0.2, 0.07 * body, 0.003, 'sine', 140 * vary, 50),
        tone(0.004, 0.16, 0.02, 0.003, 'triangle', 420 * vary, 180),
      ];
      return [
        noise(0, 0.035, 0.05, 0.002, 'white', 'lowpass', 2400, 700),
        tone(0, 0.16, 0.07 * body, 0.003, 'sine', 120 * vary, 46),
        tone(0.004, 0.1, 0.02, 0.003, 'triangle', 300 * vary, 150),
      ];
    }
    case 'blink': case 'perfect-dodge': {
      if (action === 'sakda-guard-dash') return [
        noise(0, 0.3, 0.04, 0.03, 'wind', 'bandpass', 500, 1800, 0.9),
        tone(0, 0.3, 0.03, 0.03, 'sawtooth', 90, 220, 'lowpass', 500, 1500),
        // Shield hum: a warm fifth that rings out.
        tone(0.04, 0.9, 0.02, 0.1, 'sine', 196, 196),
        tone(0.04, 0.9, 0.015, 0.1, 'triangle', 294, 294),
      ];
      return [
        noise(0, 0.3, 0.055, 0.02, 'wind', 'bandpass', 400 * vary, 2400 * vary, 0.9),
        noise(0.02, 0.3, 0.03, 0.03, 'crackle', 'lowpass', 2600, 700),
        tone(0, 0.3, 0.04, 0.02, 'sawtooth', 90 * vary, 260, 'lowpass', 600, 1700),
      ];
    }
    case 'beam': return [
      noise(0, 0.4, 0.05, 0.03, 'wind', 'bandpass', 400, 2200, 0.9),
      tone(0, 0.4, 0.04, 0.03, 'sawtooth', 100 * vary, 280, 'lowpass', 600, 1800),
      noise(0.02, 0.35, 0.025, 0.04, 'crackle', 'lowpass', 2800, 700),
    ];
    case 'tether': return [
      noise(0, 0.2, 0.045, 0.004, 'crackle', 'bandpass', 1800 * vary, 900, 1.1),
      tone(0, 0.25, 0.05, 0.006, 'square', 300 * vary, 150, 'lowpass', 1400, 400),
      tone(0.08, 0.2, 0.05, 0.004, 'sine', 120, 48),
    ];
    case 'sigil': {
      const sustained = cue.phase === 'sustain', span = sustained ? 1.3 : Math.min(0.8, Math.max(0.3, (cue.durationTicks ?? 24) / 60));
      return [
        noise(0, span, 0.035, span * 0.6, 'crackle', 'lowpass', 1400, 3200),
        noise(0, span, 0.02, span * 0.6, 'wind', 'bandpass', 300, 900, 0.7),
        tone(0, span, 0.04, span * 0.7, 'sawtooth', 80, 170, 'lowpass', 400, 1100),
        tone(0.02, span, 0.024, span * 0.7, 'sine', 160, 330),
      ];
    }
    case 'projectile': return [
      noise(0, 0.3, 0.05, 0.02, 'wind', 'bandpass', 600 * vary, 2400 * vary, 0.9),
      tone(0, 0.35, 0.05, 0.01, 'sine', 160, 70),
      tone(0.02, 0.4, 0.03, 0.02, 'triangle', 330 * vary, 990),
    ];
    case 'projectile-impact': return [
      noise(0, 0.05, 0.05, 0.002, 'white', 'highpass', 2600, 1400),
      tone(0, 0.22, 0.07, 0.003, 'sine', 120 * vary, 46),
      tone(0.004, 0.5, 0.014, 0.004, 'sine', 1320 * vary),
      tone(0.004, 0.4, 0.01, 0.004, 'sine', 1980 * vary),
    ];
    case 'cleanse': return [
      tone(0, 0.9, 0.024, 0.4, 'sine', 165, 247),
      tone(0.04, 0.9, 0.016, 0.4, 'triangle', 220, 330),
      noise(0, 0.8, 0.014, 0.4, 'crackle', 'lowpass', 1800, 900),
    ];
    case 'bloom': case 'root-eruption': return [
      noise(0, 0.5, 0.05, 0.01, 'crackle', 'lowpass', 3000, 400),
      tone(0, 0.6, 0.08, 0.004, 'sine', 100 * vary, 36),
      tone(0.02, 0.4, 0.03, 0.01, 'sawtooth', 70, 40, 'lowpass', 500, 140),
    ];
    default: return undefined;
  }
}
