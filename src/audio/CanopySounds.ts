import type { StoryCue } from '../effects/story-cues.js';
import { WARDEN_MAX_SECONDS, jitter, noise, tone, type SoundLayer } from './WardenSounds.js';

/**
 * Procedural timbres for the Whispering Canopy monsters (docs/features/story-effects.md, "Canopy monsters"). Like the Warden
 * recipes these are pure layer data (oscillator glides + filtered looped-noise bursts) that `StoryAudio` voices through the same
 * layered path, inside the same per-voice level / length / layer budgets, with their own bounded voice pool so a barrage of
 * canopy cues can never steal Warden voices.
 */
export const CANOPY_ATTACK_IDS = [
  'howler-rock-hurl', 'howler-leap-slam', 'howler-branch-sweep',
  'hornbill-dive-bomb', 'hornbill-feather-volley', 'hornbill-gale-flap',
  'viper-venom-spit', 'viper-tail-lash', 'viper-strike-lunge',
] as const;
export type CanopyAttackId = typeof CANOPY_ATTACK_IDS[number];
const CANOPY_ATTACKS: Readonly<Record<string, true>> = {
  'howler-rock-hurl': true, 'howler-leap-slam': true, 'howler-branch-sweep': true,
  'hornbill-dive-bomb': true, 'hornbill-feather-volley': true, 'hornbill-gale-flap': true,
  'viper-venom-spit': true, 'viper-tail-lash': true, 'viper-strike-lunge': true,
};
/** Actor instance id → voice of its roar (the engage / pressure-escalation roar-cone cue). */
export const CANOPY_ROARS: Readonly<Record<string, 'howler' | 'hornbill' | 'viper'>> = {
  'canopy-howler': 'howler', 'canopy-hornbill': 'hornbill', 'canopy-mire-viper': 'viper',
};
/** Canopy voices alive at once; a new cue steals the oldest beyond this. */
export const CANOPY_MAX_VOICES = 6;

/** True for the nine canopy attack phases and for the canopy monsters' roars; every other cue keeps its existing audio path. */
export function isCanopyCue(cue: StoryCue): boolean {
  if (cue.kind === 'roar-cone') return cue.actorId !== undefined && CANOPY_ROARS[cue.actorId] !== undefined;
  if (cue.kind !== 'anticipation' && cue.kind !== 'commit' && cue.kind !== 'active' && cue.kind !== 'hit') return false;
  return cue.attackId !== undefined && CANOPY_ATTACKS[cue.attackId] === true;
}

/** Layers for a canopy cue, or undefined when the cue is not one (or this phase is silent). */
export function canopyLayers(cue: StoryCue): readonly SoundLayer[] | undefined {
  if (!isCanopyCue(cue)) return undefined;
  const seconds = Math.min(WARDEN_MAX_SECONDS, Math.max(0.05, (cue.durationTicks ?? 12) / 60)), vary = 0.94 + 0.12 * jitter(cue.instanceId);
  if (cue.kind === 'roar-cone') return roar(CANOPY_ROARS[cue.actorId!]!, seconds, vary, Math.min(1.5, Math.max(0.4, cue.intensity ?? 1)));
  const phase = cue.kind as 'anticipation' | 'commit' | 'active' | 'hit';
  switch (cue.attackId as CanopyAttackId) {
    case 'howler-rock-hurl': return rockHurl(phase, seconds, vary);
    case 'howler-leap-slam': return leapSlam(phase, seconds, vary);
    case 'howler-branch-sweep': return branchSweep(phase, seconds, vary);
    case 'hornbill-dive-bomb': return diveBomb(phase, seconds, vary);
    case 'hornbill-feather-volley': return featherVolley(phase, seconds, vary);
    case 'hornbill-gale-flap': return galeFlap(phase, seconds, vary);
    case 'viper-venom-spit': return venomSpit(phase, seconds, vary);
    case 'viper-tail-lash': return tailLash(phase, seconds, vary);
    case 'viper-strike-lunge': return strikeLunge(phase, seconds, vary);
    default: return undefined;
  }
}

type Phase = 'anticipation' | 'commit' | 'active' | 'hit';
const span = (seconds: number, min: number, max: number): number => Math.min(max, Math.max(min, seconds));

/** Short wet/dull body impact shared by every `hit` cue: noise click + low thump (+ the monster's character in `extra`). */
function thump(pitch: number, vary: number, extra: readonly SoundLayer[] = []): readonly SoundLayer[] {
  return [noise(0, 0.045, 0.05, 0.002, 'white', 'highpass', 1800, 900), tone(0, 0.18, 0.06, 0.003, 'sine', pitch * vary, pitch * 0.4), ...extra];
}

function rockHurl(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': {
      // Strained grunt, grinding gravel and sap pops while the rock is bound together.
      const length = span(seconds, 0.4, 0.9);
      return [
        tone(0, length, 0.04, length * 0.6, 'sawtooth', 88 * vary, 140 * vary, 'lowpass', 380, 900),
        noise(0, length, 0.024, length * 0.5, 'white', 'lowpass', 520, 780),
        noise(0.05, length, 0.018, length * 0.4, 'crackle', 'bandpass', 600 * vary, 900, 1.2),
      ];
    }
    case 'commit': // Rock whoosh: a heavy body cutting the air, pitch falling as it passes.
      return [
        noise(0, 0.3, 0.055, 0.04, 'wind', 'bandpass', 700 * vary, 1900, 0.9),
        tone(0, 0.28, 0.035, 0.05, 'sine', 240 * vary, 105),
        tone(0.02, 0.22, 0.012, 0.04, 'triangle', 1100 * vary, 520),
      ];
    case 'active': // Thud: dull earth impact, crack of stone, debris skitter, low rumble.
      return [
        tone(0, 0.42, 0.075, 0.004, 'sine', 100 * vary, 38),
        noise(0, 0.24, 0.06, 0.003, 'white', 'lowpass', 1900, 220),
        noise(0.02, 0.34, 0.022, 0.004, 'shards', 'highpass', 2400 * vary, 1600),
        tone(0.03, 0.7, 0.035, 0.05, 'sawtooth', 58, 40, 'lowpass', 240, 110),
      ];
    default: return thump(130, vary);
  }
}

function leapSlam(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': {
      // Crouch: a low rising growl and gritty dust scrape.
      const length = span(seconds, 0.5, 1);
      return [
        tone(0, length, 0.04, length * 0.7, 'sawtooth', 70 * vary, 118 * vary, 'lowpass', 300, 800),
        noise(0, length, 0.022, length * 0.6, 'white', 'lowpass', 420, 620),
        noise(0.1, length * 0.8, 0.014, length * 0.5, 'shards', 'highpass', 2600, 3200),
      ];
    }
    case 'commit': // Launch: a thump off the ground then a rising whoosh.
      return [
        tone(0, 0.16, 0.06, 0.004, 'sine', 140 * vary, 60),
        noise(0.02, 0.34, 0.055, 0.05, 'wind', 'bandpass', 420 * vary, 2400, 0.9),
        tone(0.02, 0.28, 0.025, 0.06, 'sine', 180 * vary, 330),
      ];
    case 'active': // Heavy slam: deep boom, crack, shower of debris and a long sub rumble.
      return [
        tone(0, 0.55, 0.08, 0.004, 'sine', 84 * vary, 30),
        noise(0, 0.36, 0.065, 0.003, 'white', 'lowpass', 1600, 150),
        noise(0.02, 0.5, 0.025, 0.004, 'shards', 'highpass', 2200 * vary, 1400),
        tone(0.04, 1, 0.04, 0.06, 'sawtooth', 52, 36, 'lowpass', 220, 90),
        tone(0.04, 0.8, 0.03, 0.05, 'sine', 44, 30),
      ];
    default: return thump(100, vary);
  }
}

function branchSweep(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': { // Creaking wood hauled back, leaf rustle.
      const length = span(seconds, 0.4, 0.9);
      return [
        tone(0, length, 0.026, length * 0.7, 'triangle', 140 * vary, 210 * vary, 'bandpass', 600, 1100),
        noise(0, length, 0.022, length * 0.6, 'wind', 'highpass', 2200, 3000),
        tone(0.04, length * 0.8, 0.02, length * 0.5, 'sawtooth', 62, 84, 'lowpass', 260, 360),
      ];
    }
    case 'commit': return [noise(0, 0.24, 0.05, 0.05, 'wind', 'bandpass', 800 * vary, 2200, 1), tone(0, 0.2, 0.02, 0.05, 'sine', 160 * vary, 220)];
    case 'active': // The sweep: a long whoosh falling away, leaf shear on top, a dull wooden whack underneath.
      return [
        noise(0, 0.42, 0.06, 0.03, 'wind', 'bandpass', 2400 * vary, 600, 0.9),
        noise(0, 0.34, 0.028, 0.02, 'white', 'highpass', 4200, 2600),
        tone(0.04, 0.22, 0.05, 0.004, 'sine', 132 * vary, 70),
        noise(0.05, 0.4, 0.018, 0.02, 'shards', 'highpass', 3200, 2200),
      ];
    default: return thump(150, vary, [noise(0, 0.12, 0.02, 0.004, 'wind', 'highpass', 3600, 2400)]);
  }
}

function diveBomb(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': { // Wings fold: a tightening rush, a rising whistle, feather rustle.
      const length = span(seconds, 0.5, 1);
      return [
        noise(0, length, 0.036, length * 0.8, 'wind', 'highpass', 1500, 3200),
        tone(0, length, 0.012, length * 0.9, 'sine', 900 * vary, 1500 * vary),
        noise(0.05, length, 0.014, length * 0.6, 'shards', 'highpass', 3800, 4600),
      ];
    }
    case 'commit': // The dive begins: rising screech and pressure whistle.
      return [
        tone(0, 0.3, 0.04, 0.05, 'sawtooth', 900 * vary, 2600, 'lowpass', 1800, 4200),
        noise(0, 0.3, 0.05, 0.05, 'wind', 'bandpass', 1200 * vary, 3500, 1),
        tone(0.02, 0.26, 0.012, 0.05, 'sine', 1800 * vary, 3600),
      ];
    case 'active': // Fly-by: a hard rush that drops in pitch as it passes, a thin tonal whine, a low whump of displaced air.
      return [
        noise(0, 0.55, 0.065, 0.05, 'wind', 'bandpass', 2800 * vary, 500, 0.9),
        tone(0, 0.5, 0.022, 0.06, 'sine', 1800 * vary, 700),
        tone(0.12, 0.34, 0.05, 0.02, 'sine', 112 * vary, 58),
        noise(0.08, 0.4, 0.02, 0.04, 'white', 'highpass', 3600, 2200),
      ];
    default: return thump(170, vary, [noise(0, 0.14, 0.02, 0.004, 'shards', 'highpass', 4200, 3000)]);
  }
}

function featherVolley(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': { // Feathers lift and ruffle with a faint ringing shimmer.
      const length = span(seconds, 0.4, 0.9);
      return [
        noise(0, length, 0.026, length * 0.6, 'shards', 'highpass', 3500, 4600),
        tone(0, length, 0.012, length * 0.8, 'triangle', 1200 * vary, 1700 * vary),
        noise(0.05, length, 0.014, length * 0.5, 'wind', 'highpass', 2600, 3400),
      ];
    }
    case 'commit': // Darts nock: a bright rising shimmer chord.
      return [
        tone(0, 0.3, 0.014, 0.12, 'triangle', 2200 * vary, 3100 * vary),
        tone(0.01, 0.3, 0.01, 0.12, 'triangle', 2200 * 1.498 * vary, 3100 * 1.498 * vary),
        noise(0, 0.28, 0.02, 0.1, 'shards', 'highpass', 4200, 5600),
      ];
    case 'active': // The volley: a hiss of darts, three staggered zips and the ticks of them landing.
      return [
        noise(0, 0.32, 0.045, 0.02, 'white', 'highpass', 4600 * vary, 2600),
        tone(0, 0.24, 0.016, 0.02, 'sine', 3300 * vary, 1500),
        tone(0.022, 0.22, 0.012, 0.02, 'sine', 3000 * vary, 1400),
        tone(0.044, 0.2, 0.01, 0.02, 'sine', 3600 * vary, 1700),
        noise(0.12, 0.3, 0.026, 0.004, 'crackle', 'bandpass', 3000 * vary, 1800, 1.1),
        tone(0.12, 0.12, 0.03, 0.004, 'sine', 180 * vary, 80),
      ];
    default: return [noise(0, 0.05, 0.045, 0.002, 'white', 'highpass', 3600, 2200), tone(0, 0.1, 0.03, 0.003, 'sine', 210 * vary, 90), tone(0, 0.18, 0.008, 0.003, 'sine', 2600 * vary)];
  }
}

function galeFlap(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': { // Wings raised: a slow air swell with a pulse of low flutter.
      const length = span(seconds, 0.5, 1);
      return [
        noise(0, length, 0.04, length * 0.8, 'wind', 'lowpass', 900, 2100),
        tone(0, length, 0.03, length * 0.7, 'sine', 90 * vary, 135 * vary),
        noise(0.1, length * 0.8, 0.012, length * 0.5, 'shards', 'highpass', 3600, 4200),
      ];
    }
    case 'commit': // Downstroke: a punchy whump with a snapping rush.
      return [tone(0, 0.2, 0.06, 0.01, 'sine', 120 * vary, 55), noise(0, 0.26, 0.05, 0.03, 'wind', 'bandpass', 600 * vary, 1700, 0.9)];
    case 'active': // Gale: a long roaring rush tapering away, a bright upper layer, a low rotor-like growl.
      return [
        noise(0, 0.62, 0.065, 0.05, 'wind', 'bandpass', 700 * vary, 300, 0.8),
        noise(0, 0.5, 0.03, 0.04, 'wind', 'highpass', 2500, 1000),
        tone(0, 0.52, 0.03, 0.05, 'sawtooth', 112 * vary, 70, 'lowpass', 320, 180),
        noise(0.1, 0.4, 0.016, 0.05, 'shards', 'highpass', 3400, 2400),
      ];
    default: return thump(180, vary, [noise(0, 0.2, 0.028, 0.01, 'wind', 'bandpass', 900, 500)]);
  }
}

function venomSpit(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': { // Hiss and gurgle as venom gathers.
      const length = span(seconds, 0.5, 1);
      return [
        noise(0, length, 0.03, length * 0.6, 'white', 'highpass', 5000 * vary, 7500, 1),
        noise(0, length, 0.022, length * 0.5, 'crackle', 'bandpass', 400, 720, 1.4),
        tone(0.05, length, 0.014, length * 0.7, 'sine', 180 * vary, 250 * vary),
      ];
    }
    case 'commit': // The spit: a sharp wet "pt" and a thin wet whoosh.
      return [
        noise(0, 0.07, 0.06, 0.004, 'white', 'bandpass', 2600 * vary, 1800, 1.4),
        tone(0, 0.12, 0.03, 0.004, 'sine', 1500 * vary, 620),
        noise(0.03, 0.22, 0.03, 0.03, 'wind', 'bandpass', 1300 * vary, 600, 1),
      ];
    case 'active': { // Splash into a pool that goes on bubbling for as long as the hazard lingers.
      const bubbling = span(seconds, 0.5, WARDEN_MAX_SECONDS - 0.2);
      return [
        noise(0, 0.32, 0.05, 0.004, 'white', 'bandpass', 1900 * vary, 600, 0.9),
        tone(0, 0.2, 0.045, 0.004, 'sine', 210 * vary, 80),
        noise(0.08, bubbling, 0.02, 0.15, 'crackle', 'bandpass', 500 * vary, 900, 1.3),
        tone(0.1, bubbling, 0.012, 0.2, 'sine', 140 * vary, 190),
        noise(0.1, bubbling, 0.01, 0.2, 'white', 'highpass', 6000, 5000),
      ];
    }
    default: return [noise(0, 0.22, 0.04, 0.01, 'crackle', 'bandpass', 2200 * vary, 1200, 1), tone(0, 0.12, 0.035, 0.003, 'sine', 150 * vary, 65)];
  }
}

function tailLash(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': { // Coiling: dry scales scraping, a low hiss.
      const length = span(seconds, 0.5, 1);
      return [
        noise(0, length, 0.024, length * 0.7, 'wind', 'bandpass', 900 * vary, 1500, 1.2),
        noise(0, length, 0.018, length * 0.6, 'white', 'highpass', 5200, 6400),
        tone(0.05, length, 0.014, length * 0.7, 'sawtooth', 70 * vary, 96 * vary, 'lowpass', 240, 420),
      ];
    }
    case 'commit': return [noise(0, 0.22, 0.05, 0.05, 'wind', 'highpass', 2000 * vary, 4500), tone(0, 0.2, 0.014, 0.05, 'sine', 700 * vary, 1500)];
    case 'active': // Lash: whip-crack, a hard whoosh and a wet slap on the ground.
      return [
        noise(0, 0.06, 0.07, 0.002, 'white', 'highpass', 3000 * vary, 1500),
        noise(0, 0.32, 0.05, 0.02, 'white', 'bandpass', 2400 * vary, 700, 1),
        tone(0.06, 0.16, 0.05, 0.004, 'sine', 140 * vary, 60),
        noise(0.06, 0.3, 0.02, 0.01, 'crackle', 'bandpass', 1400, 800, 1.2),
      ];
    default: return thump(140, vary, [noise(0, 0.16, 0.026, 0.006, 'crackle', 'bandpass', 1800, 1000, 1.1)]);
  }
}

function strikeLunge(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': { // Rears back: a coiled hiss that tightens.
      const length = span(seconds, 0.4, 0.8);
      return [
        noise(0, length, 0.034, length * 0.7, 'white', 'highpass', 5500 * vary, 6800, 1),
        tone(0, length, 0.012, length * 0.8, 'sine', 380 * vary, 560 * vary),
        noise(0.05, length * 0.8, 0.014, length * 0.5, 'crackle', 'bandpass', 2400, 3000, 1.3),
      ];
    }
    case 'commit': return [noise(0, 0.26, 0.045, 0.05, 'white', 'bandpass', 3000 * vary, 6000, 1.1), tone(0, 0.2, 0.012, 0.05, 'sine', 600 * vary, 1300)];
    case 'active': // Strike: a fast hiss-snap, the click of the bite and a short low thump.
      return [
        noise(0, 0.18, 0.065, 0.004, 'white', 'bandpass', 3500 * vary, 900, 1),
        noise(0, 0.035, 0.05, 0.001, 'white', 'highpass', 4000, 2600),
        tone(0.02, 0.16, 0.055, 0.003, 'sine', 120 * vary, 55),
      ];
    default: return thump(130, vary, [noise(0, 0.14, 0.03, 0.004, 'crackle', 'bandpass', 2600, 1400, 1.2)]);
  }
}

/** The monsters' own roars on the engage / escalation roar-cone: guttural bark, piercing screech, long rasping hiss. */
function roar(voice: 'howler' | 'hornbill' | 'viper', seconds: number, vary: number, intensity: number): readonly SoundLayer[] {
  const length = span(seconds, 0.5, 1.1), level = 0.8 + 0.2 * intensity;
  switch (voice) {
    case 'howler': // Pitch-dropping bark through a lowpass, doubled for gravel, with a chest thump and breath.
      return [
        tone(0, length, 0.055 * level, 0.06, 'sawtooth', 190 * vary, 88, 'lowpass', 900, 320),
        tone(0.01, length, 0.04 * level, 0.06, 'sawtooth', 197 * vary, 92, 'lowpass', 900, 320),
        tone(0, 0.3, 0.07 * level, 0.01, 'sine', 90, 45),
        noise(0.02, length, 0.026, 0.1, 'wind', 'bandpass', 520, 360, 0.8),
        noise(0.05, length * 0.7, 0.016, 0.05, 'crackle', 'bandpass', 800, 600, 1),
      ];
    case 'hornbill': // Rising-then-falling screech, a harsh square partial, breath and a lower caw.
      return [
        tone(0, length, 0.04 * level, 0.08, 'sawtooth', 1500 * vary, 3000, 'highpass', 900, 1400),
        tone(0.02, length * 0.85, 0.014 * level, 0.08, 'square', 2300 * vary, 3600),
        noise(0, length, 0.03 * level, 0.1, 'white', 'highpass', 3500, 5600),
        tone(0.15, length * 0.5, 0.03 * level, 0.04, 'sawtooth', 720 * vary, 340, 'lowpass', 1600, 600),
      ];
    case 'viper': // Long rasping hiss: bright noise swell, crackly rasp and a faint sub-growl.
      return [
        noise(0, length, 0.06 * level, 0.15, 'white', 'highpass', 4500 * vary, 7000, 1),
        noise(0, length, 0.026 * level, 0.12, 'crackle', 'bandpass', 2500, 3200, 1.2),
        tone(0.05, length, 0.022 * level, 0.15, 'sawtooth', 70 * vary, 58, 'lowpass', 220, 140),
      ];
  }
}
