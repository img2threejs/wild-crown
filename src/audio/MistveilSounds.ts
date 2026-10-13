import type { StoryCue } from '../effects/story-cues.js';
import { WARDEN_MAX_SECONDS, jitter, noise, tone, type SoundLayer } from './WardenSounds.js';

/**
 * Procedural timbres for the Mistveil Basin monsters (docs/features/mistveil-playtest.md): the Bog Lurker's croaks and wet
 * splats, the Lantern Heron's shrieks and cold gusts, and Ghor's water surges. Like the Canopy recipes these are pure layer data
 * (oscillator glides + filtered looped-noise bursts) that `StoryAudio` voices through the same layered path, inside the same
 * per-voice level / length / layer budgets and the shared bounded wildlife voice pool.
 */
export const MISTVEIL_ATTACK_IDS = [
  'bog-lurker-tongue-lash', 'bog-lurker-bubble-pool', 'bog-lurker-mud-hop',
  'lantern-heron-spear-dive', 'lantern-heron-mist-gust', 'lantern-heron-flare-burst',
  'mire-maw-tail-sweep', 'mire-maw-bite-lunge', 'mire-maw-black-river-wave',
] as const;
export type MistveilAttackId = typeof MISTVEIL_ATTACK_IDS[number];
const MISTVEIL_ATTACKS: Readonly<Record<string, true>> = {
  'bog-lurker-tongue-lash': true, 'bog-lurker-bubble-pool': true, 'bog-lurker-mud-hop': true,
  'lantern-heron-spear-dive': true, 'lantern-heron-mist-gust': true, 'lantern-heron-flare-burst': true,
  'mire-maw-tail-sweep': true, 'mire-maw-bite-lunge': true, 'mire-maw-black-river-wave': true,
};
/** Actor instance id -> voice of its roar (the engage / pressure-escalation roar-cone cue). */
export const MISTVEIL_ROARS: Readonly<Record<string, 'lurker' | 'heron' | 'ghor'>> = {
  'mistveil-lurker': 'lurker', 'mistveil-heron': 'heron', 'mistveil-ghor': 'ghor',
};

/** True for the nine Mistveil attack phases and for the Mistveil monsters' roars; every other cue keeps its existing audio path. */
export function isMistveilCue(cue: StoryCue): boolean {
  if (cue.kind === 'roar-cone') return cue.actorId !== undefined && MISTVEIL_ROARS[cue.actorId] !== undefined;
  if (cue.kind !== 'anticipation' && cue.kind !== 'commit' && cue.kind !== 'active' && cue.kind !== 'hit') return false;
  return cue.attackId !== undefined && MISTVEIL_ATTACKS[cue.attackId] === true;
}

/** Procedural layers for a Mistveil monster cue (attack phases and roars), or undefined for any other cue (or a silent phase). */
export function mistveilLayers(cue: StoryCue): readonly SoundLayer[] | undefined {
  if (!isMistveilCue(cue)) return undefined;
  const seconds = Math.min(WARDEN_MAX_SECONDS, Math.max(0.05, (cue.durationTicks ?? 12) / 60)), vary = 0.94 + 0.12 * jitter(cue.instanceId);
  if (cue.kind === 'roar-cone') return roar(MISTVEIL_ROARS[cue.actorId!]!, seconds, vary, Math.min(1.5, Math.max(0.4, cue.intensity ?? 1)));
  const phase = cue.kind as 'anticipation' | 'commit' | 'active' | 'hit';
  switch (cue.attackId as MistveilAttackId) {
    case 'bog-lurker-tongue-lash': return tongueLash(phase, seconds, vary);
    case 'bog-lurker-bubble-pool': return bubblePool(phase, seconds, vary);
    case 'bog-lurker-mud-hop': return mudHop(phase, seconds, vary);
    case 'lantern-heron-spear-dive': return spearDive(phase, seconds, vary);
    case 'lantern-heron-mist-gust': return mistGust(phase, seconds, vary);
    case 'lantern-heron-flare-burst': return flareBurst(phase, seconds, vary);
    case 'mire-maw-tail-sweep': return tailSweep(phase, seconds, vary);
    case 'mire-maw-bite-lunge': return biteLunge(phase, seconds, vary);
    case 'mire-maw-black-river-wave': return riverWave(phase, seconds, vary);
    default: return undefined;
  }
}

type Phase = 'anticipation' | 'commit' | 'active' | 'hit';
const span = (seconds: number, min: number, max: number): number => Math.min(max, Math.max(min, seconds));

/** Short wet body impact shared by every `hit` cue: noise click + low thump (+ the monster's character in `extra`). */
function thump(pitch: number, vary: number, extra: readonly SoundLayer[] = []): readonly SoundLayer[] {
  return [noise(0, 0.05, 0.05, 0.002, 'white', 'bandpass', 1500, 700, 1), tone(0, 0.2, 0.06, 0.003, 'sine', pitch * vary, pitch * 0.4), ...extra];
}

function tongueLash(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': { // Throat swells: a wet gurgle and a low croak building.
      const length = span(seconds, 0.4, 0.8);
      return [
        noise(0, length, 0.026, length * 0.6, 'crackle', 'bandpass', 480 * vary, 880, 1.3),
        tone(0, length, 0.03, length * 0.7, 'square', 96 * vary, 140 * vary, 'lowpass', 340, 620),
        tone(0.06, length * 0.8, 0.012, length * 0.5, 'sine', 200 * vary, 290 * vary),
      ];
    }
    case 'commit': // The tongue unrolls: a sticky "thwip" of air.
      return [noise(0, 0.2, 0.05, 0.03, 'wind', 'bandpass', 900 * vary, 2600, 1), tone(0, 0.16, 0.02, 0.03, 'sine', 300 * vary, 760)];
    case 'active': // Lash: a wet whip-crack along the lane and a slap at the tip.
      return [
        noise(0, 0.05, 0.07, 0.002, 'white', 'highpass', 2800 * vary, 1400),
        noise(0, 0.26, 0.04, 0.02, 'white', 'bandpass', 2200 * vary, 800, 1),
        tone(0.05, 0.16, 0.05, 0.004, 'sine', 150 * vary, 66),
        noise(0.05, 0.3, 0.022, 0.01, 'crackle', 'bandpass', 900, 500, 1.2),
      ];
    default: return thump(150, vary, [noise(0, 0.14, 0.024, 0.006, 'crackle', 'bandpass', 1400, 800, 1.1)]);
  }
}

function bubblePool(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': { // Murk bubbling behind the lips: a swelling blub and a thin wet hiss.
      const length = span(seconds, 0.5, 1);
      return [
        noise(0, length, 0.03, length * 0.6, 'crackle', 'bandpass', 380, 760 * vary, 1.4),
        tone(0.05, length, 0.016, length * 0.7, 'sine', 140 * vary, 250 * vary),
        noise(0, length, 0.016, length * 0.5, 'white', 'highpass', 4800, 6400),
      ];
    }
    case 'commit': // The spit: a fat wet "blorp" and a short slurp of air.
      return [
        tone(0, 0.18, 0.05, 0.004, 'sine', 330 * vary, 110),
        noise(0, 0.1, 0.05, 0.004, 'white', 'bandpass', 1500 * vary, 700, 1.2),
        noise(0.03, 0.22, 0.026, 0.03, 'wind', 'bandpass', 800 * vary, 450, 1),
      ];
    case 'active': { // Splash into a pool of Black Sap murk that goes on bubbling as long as the hazard lingers.
      const bubbling = span(seconds, 0.5, WARDEN_MAX_SECONDS - 0.2);
      return [
        noise(0, 0.3, 0.05, 0.004, 'white', 'bandpass', 1600 * vary, 500, 0.9),
        tone(0, 0.2, 0.045, 0.004, 'sine', 180 * vary, 70),
        noise(0.08, bubbling, 0.02, 0.15, 'crackle', 'bandpass', 420 * vary, 780, 1.3),
        tone(0.1, bubbling, 0.012, 0.2, 'sine', 120 * vary, 170),
        noise(0.1, bubbling, 0.008, 0.2, 'white', 'highpass', 5200, 4400),
      ];
    }
    default: return [noise(0, 0.2, 0.04, 0.01, 'crackle', 'bandpass', 1800 * vary, 900, 1), tone(0, 0.12, 0.035, 0.003, 'sine', 140 * vary, 62)];
  }
}

function mudHop(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': { // Crouch: a squelch of mud and a deep, gulping croak.
      const length = span(seconds, 0.5, 1);
      return [
        noise(0, length, 0.026, length * 0.6, 'crackle', 'lowpass', 520, 800, 1.1),
        tone(0, length, 0.04, length * 0.7, 'square', 74 * vary, 118 * vary, 'lowpass', 280, 640),
        noise(0.1, length * 0.8, 0.012, length * 0.5, 'white', 'lowpass', 600, 480),
      ];
    }
    case 'commit': // Launch: a wet pop off the mud and a rising boing.
      return [
        tone(0, 0.14, 0.06, 0.004, 'sine', 150 * vary, 66),
        noise(0.02, 0.3, 0.04, 0.05, 'wind', 'bandpass', 420 * vary, 1800, 0.9),
        tone(0.02, 0.26, 0.026, 0.05, 'sine', 170 * vary, 340),
      ];
    case 'active': // Landing splat: a heavy wet slap, spattering droplets and a low thump.
      return [
        tone(0, 0.42, 0.075, 0.004, 'sine', 96 * vary, 38),
        noise(0, 0.28, 0.06, 0.003, 'white', 'lowpass', 1500, 180),
        noise(0.02, 0.4, 0.024, 0.004, 'crackle', 'bandpass', 1100 * vary, 600, 1.1),
        noise(0.05, 0.34, 0.012, 0.004, 'shards', 'highpass', 3000 * vary, 2000),
      ];
    default: return thump(120, vary);
  }
}

function spearDive(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': { // The neck coils: a thin tightening rasp and a faint reed rustle.
      const length = span(seconds, 0.5, 1);
      return [
        noise(0, length, 0.03, length * 0.8, 'wind', 'highpass', 1800, 3400),
        tone(0, length, 0.012, length * 0.9, 'triangle', 700 * vary, 1200 * vary),
        noise(0.05, length, 0.012, length * 0.6, 'shards', 'highpass', 3600, 4400),
      ];
    }
    case 'commit': // The strike begins: a rising reedy shriek.
      return [
        tone(0, 0.28, 0.04, 0.05, 'sawtooth', 700 * vary, 2100, 'bandpass', 1600, 3000),
        noise(0, 0.26, 0.04, 0.05, 'wind', 'bandpass', 1400 * vary, 3200, 1),
      ];
    case 'active': // The dart down the lane: a hard rush that drops in pitch, water skimmed off the surface.
      return [
        noise(0, 0.5, 0.06, 0.04, 'wind', 'bandpass', 2600 * vary, 600, 0.9),
        tone(0, 0.45, 0.018, 0.05, 'sine', 1500 * vary, 640),
        noise(0.1, 0.4, 0.024, 0.02, 'crackle', 'bandpass', 1700, 900, 1.1),
        tone(0.12, 0.3, 0.04, 0.02, 'sine', 118 * vary, 60),
      ];
    default: return thump(170, vary, [noise(0, 0.14, 0.02, 0.004, 'shards', 'highpass', 3800, 2800)]);
  }
}

function mistGust(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': { // Wings cup the air: a slow cold swell with a pulse of low flutter.
      const length = span(seconds, 0.5, 1);
      return [
        noise(0, length, 0.04, length * 0.8, 'wind', 'lowpass', 700, 1800),
        tone(0, length, 0.026, length * 0.7, 'sine', 84 * vary, 124 * vary),
        noise(0.1, length * 0.8, 0.01, length * 0.5, 'shards', 'highpass', 3600, 4200),
      ];
    }
    case 'commit': // Downstroke: a soft whump and a snapping rush.
      return [tone(0, 0.2, 0.05, 0.01, 'sine', 110 * vary, 52), noise(0, 0.26, 0.045, 0.03, 'wind', 'bandpass', 560 * vary, 1500, 0.9)];
    case 'active': // The gust: a long cold breath tapering away over a soft low rotor.
      return [
        noise(0, 0.6, 0.06, 0.05, 'wind', 'bandpass', 800 * vary, 280, 0.8),
        noise(0, 0.5, 0.026, 0.04, 'wind', 'highpass', 2200, 900),
        tone(0, 0.5, 0.026, 0.05, 'sawtooth', 100 * vary, 64, 'lowpass', 300, 160),
      ];
    default: return thump(170, vary, [noise(0, 0.2, 0.026, 0.01, 'wind', 'bandpass', 900, 500)]);
  }
}

function flareBurst(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': { // The lantern swells: a glassy shimmer rising in pitch.
      const length = span(seconds, 0.5, 1);
      return [
        tone(0, length, 0.016, length * 0.8, 'triangle', 600 * vary, 1500 * vary),
        tone(0.02, length, 0.01, length * 0.8, 'sine', 900 * vary, 2250 * vary),
        noise(0, length, 0.014, length * 0.6, 'shards', 'highpass', 4000, 5600),
      ];
    }
    case 'commit': // The orb lifts: a warm tonal bloom swelling upward.
      return [
        tone(0, 0.3, 0.02, 0.12, 'sine', 440 * vary, 880 * vary),
        tone(0.01, 0.3, 0.014, 0.12, 'sine', 660 * vary, 1320 * vary),
        noise(0, 0.28, 0.016, 0.1, 'wind', 'bandpass', 1800, 3200, 1),
      ];
    case 'active': // Flare: a bright burst, a ringing chord decaying and a soft low thump under it.
      return [
        noise(0, 0.3, 0.05, 0.004, 'white', 'highpass', 3600 * vary, 1600),
        tone(0, 0.7, 0.03, 0.01, 'sine', 880 * vary, 880 * vary),
        tone(0.01, 0.6, 0.02, 0.01, 'sine', 1320 * vary, 1320 * vary),
        tone(0, 0.3, 0.06, 0.004, 'sine', 120 * vary, 54),
        noise(0.05, 0.4, 0.014, 0.004, 'shards', 'highpass', 4200, 3000),
      ];
    default: return [noise(0, 0.08, 0.04, 0.002, 'white', 'highpass', 3600, 2400), tone(0, 0.2, 0.03, 0.003, 'sine', 660 * vary, 330), tone(0, 0.14, 0.03, 0.003, 'sine', 140 * vary, 66)];
  }
}

function tailSweep(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': { // The great body coils: a heavy drag through mud and a low groan.
      const length = span(seconds, 0.5, 1);
      return [
        noise(0, length, 0.03, length * 0.7, 'crackle', 'lowpass', 440, 700, 1.1),
        tone(0, length, 0.04, length * 0.7, 'sawtooth', 52 * vary, 80 * vary, 'lowpass', 200, 360),
        noise(0.05, length, 0.014, length * 0.6, 'wind', 'bandpass', 700 * vary, 1200, 1),
      ];
    }
    case 'commit': return [noise(0, 0.24, 0.05, 0.05, 'wind', 'bandpass', 600 * vary, 2000, 1), tone(0, 0.22, 0.026, 0.05, 'sine', 90 * vary, 150)];
    case 'active': // Sweep: a heavy whoosh, a wet slap across the mud and a deep thud.
      return [
        noise(0, 0.36, 0.06, 0.03, 'wind', 'bandpass', 2000 * vary, 480, 0.9),
        noise(0.05, 0.3, 0.036, 0.01, 'crackle', 'bandpass', 1000, 600, 1.2),
        tone(0.06, 0.34, 0.07, 0.004, 'sine', 90 * vary, 36),
        noise(0.06, 0.26, 0.026, 0.004, 'white', 'lowpass', 1300, 220),
      ];
    default: return thump(100, vary, [noise(0, 0.16, 0.026, 0.006, 'crackle', 'bandpass', 1300, 800, 1.1)]);
  }
}

function biteLunge(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': { // Rears back: a low growl and the drip of black water from the jaws.
      const length = span(seconds, 0.4, 0.8);
      return [
        tone(0, length, 0.042, length * 0.7, 'sawtooth', 58 * vary, 88 * vary, 'lowpass', 240, 420),
        noise(0, length, 0.022, length * 0.6, 'crackle', 'bandpass', 800, 1300, 1.3),
        tone(0.05, length * 0.8, 0.01, length * 0.5, 'sine', 360 * vary, 520 * vary),
      ];
    }
    case 'commit': return [noise(0, 0.26, 0.05, 0.05, 'wind', 'bandpass', 500 * vary, 1700, 1), tone(0, 0.2, 0.03, 0.05, 'sine', 80 * vary, 140)];
    case 'active': // Bite: the lunge's surge of water, the snap of the jaws and a short low thump.
      return [
        noise(0, 0.22, 0.05, 0.004, 'white', 'bandpass', 1800 * vary, 500, 1),
        noise(0.04, 0.04, 0.07, 0.001, 'white', 'highpass', 3600, 2200),
        tone(0.04, 0.3, 0.07, 0.004, 'sine', 84 * vary, 38),
        noise(0.06, 0.34, 0.02, 0.01, 'crackle', 'bandpass', 900, 500, 1.2),
      ];
    default: return thump(90, vary, [noise(0, 0.14, 0.03, 0.004, 'crackle', 'bandpass', 1200, 700, 1.2)]);
  }
}

function riverWave(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': { // Rears up: black water wells under him - a rising rumble and a boiling of bubbles.
      const length = span(seconds, 0.6, 1.2);
      return [
        tone(0, length, 0.05, length * 0.8, 'sawtooth', 46 * vary, 76 * vary, 'lowpass', 180, 340),
        noise(0, length, 0.03, length * 0.7, 'crackle', 'bandpass', 360, 700 * vary, 1.3),
        noise(0.1, length * 0.8, 0.014, length * 0.6, 'wind', 'lowpass', 500, 1100),
      ];
    }
    case 'commit': return [tone(0, 0.3, 0.05, 0.1, 'sine', 70 * vary, 130), noise(0, 0.3, 0.05, 0.1, 'wind', 'bandpass', 400 * vary, 1500, 0.9)];
    case 'active': // The wave: a long heavy surge sliding away, foam hissing on top, a sub boom under it.
      return [
        noise(0, 0.7, 0.07, 0.05, 'wind', 'bandpass', 520 * vary, 240, 0.8),
        tone(0, 0.7, 0.08, 0.004, 'sine', 70 * vary, 30),
        noise(0.04, 0.5, 0.028, 0.03, 'white', 'highpass', 3200, 1500),
        noise(0.06, 0.6, 0.024, 0.02, 'crackle', 'bandpass', 700 * vary, 420, 1.2),
        tone(0.04, 0.8, 0.04, 0.05, 'sawtooth', 50, 34, 'lowpass', 200, 90),
      ];
    default: return thump(80, vary, [noise(0, 0.22, 0.03, 0.01, 'white', 'bandpass', 1200, 500, 0.9)]);
  }
}

/** The monsters' own roars on the engage / escalation roar-cone: wet bubbling croak, rasping heron squawk, deep water-throated bellow. */
function roar(voice: 'lurker' | 'heron' | 'ghor', seconds: number, vary: number, intensity: number): readonly SoundLayer[] {
  const length = span(seconds, 0.5, 1.1), level = 0.8 + 0.2 * intensity;
  switch (voice) {
    case 'lurker': // Two gulping croaks (a pulsed square wave through a lowpass) over wet bubbling.
      return [
        tone(0, 0.34, 0.055 * level, 0.03, 'square', 130 * vary, 82, 'lowpass', 700, 300),
        tone(0.4, Math.max(0.2, length - 0.4), 0.05 * level, 0.03, 'square', 118 * vary, 70, 'lowpass', 650, 260),
        noise(0, length, 0.026 * level, 0.1, 'crackle', 'bandpass', 420, 640, 1.3),
        tone(0, 0.3, 0.06 * level, 0.01, 'sine', 80, 44),
      ];
    case 'heron': // A rasping, flat squawk with a reedy upper partial and breath: nothing like the hornbill's rising screech.
      return [
        tone(0, length, 0.045 * level, 0.04, 'sawtooth', 420 * vary, 250, 'bandpass', 1100, 700),
        tone(0.02, length * 0.8, 0.02 * level, 0.04, 'square', 840 * vary, 520, 'bandpass', 1800, 1100),
        noise(0, length, 0.03 * level, 0.08, 'white', 'bandpass', 2400, 1600, 0.9),
        tone(0.1, length * 0.6, 0.016 * level, 0.04, 'triangle', 1700 * vary, 1100),
      ];
    case 'ghor': // A deep, long bellow: sub-bass sine, a growling sawtooth through a lowpass and a rolling wet rumble.
      return [
        tone(0, length, 0.07 * level, 0.1, 'sine', 56 * vary, 34),
        tone(0.02, length, 0.05 * level, 0.1, 'sawtooth', 84 * vary, 48, 'lowpass', 360, 150),
        noise(0, length, 0.04 * level, 0.15, 'wind', 'lowpass', 520, 220, 0.8),
        noise(0.1, length * 0.8, 0.02 * level, 0.1, 'crackle', 'bandpass', 380, 260, 1),
      ];
  }
}
