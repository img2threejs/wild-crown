import type { StoryCue } from '../effects/story-cues.js';
import { noise, tone, type SoundLayer } from './WardenSounds.js';

/** Soft wood, breath and rising major thirds; no Warden metallic/lightning timbre. */
export function heartrootLayers(cue: StoryCue): readonly SoundLayer[] {
  const gather = cue.phase === 'anticipation' || cue.phase === 'sustain';
  const root = cue.kind === 'root-eruption';
  const bloom = cue.kind === 'bloom';
  const length = Math.min(1.2, Math.max(.18, (cue.durationTicks ?? 24) / 60));
  if (gather) return [
    tone(0, length, .025, .12, 'sine', 220, 330),
    tone(.04, length, .018, .14, 'triangle', 277, 440),
    noise(0, length, .018, .1, 'wind', 'bandpass', 800, 2200),
  ];
  if (root || bloom) return [
    tone(0, .35, .055, .015, 'sine', root ? 125 : 180, 65),
    noise(0, .3, .035, .012, 'wind', 'lowpass', 1800, 300),
    tone(.04, .6, .025, .025, 'triangle', 440, 554),
    tone(.12, .75, .02, .04, 'sine', 660, 880),
  ];
  return [
    noise(0, Math.min(.4, length), .024, .02, 'wind', 'bandpass', 1800, 4000),
    tone(.01, .28, .024, .02, 'sine', cue.kind === 'blink' ? 440 : 660, 990),
    tone(.04, .35, .012, .04, 'triangle', 830, 1100),
  ];
}
