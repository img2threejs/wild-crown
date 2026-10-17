import type { StoryCue } from '../effects/story-cues.js';
import { WARDEN_MAX_SECONDS, jitter, noise, tone, type SoundLayer } from './WardenSounds.js';

/**
 * Procedural timbres for the Moonpine Ridge wolves (docs/features/moonpine-playtest.md): snarls, barks and howls, snow crunch,
 * ice cracks and chain rattles for the phases of the nine attacks and one roar per wolf. Like the Canopy recipes these are pure
 * layer data (oscillator glides + filtered looped-noise bursts) that `StoryAudio` voices through the shared wildlife voice pool,
 * inside the same per-voice level / length / layer budgets, so a barrage of wolf cues can never steal Warden voices.
 */
export const MOONPINE_ATTACK_IDS = [
  'frostfang-pack-rush', 'frostfang-ice-bite', 'frostfang-frost-breath',
  'howl-scout-flank-pounce', 'howl-scout-claw-rake', 'howl-scout-low-howl',
  'chained-ruun-chain-pounce', 'chained-ruun-howl-shockwave', 'chained-ruun-breaking-ice',
] as const;
export type MoonpineAttackId = typeof MOONPINE_ATTACK_IDS[number];
const MOONPINE_ATTACKS: Readonly<Record<string, true>> = {
  'frostfang-pack-rush': true, 'frostfang-ice-bite': true, 'frostfang-frost-breath': true,
  'howl-scout-flank-pounce': true, 'howl-scout-claw-rake': true, 'howl-scout-low-howl': true,
  'chained-ruun-chain-pounce': true, 'chained-ruun-howl-shockwave': true, 'chained-ruun-breaking-ice': true,
};
/** Actor instance id -> voice of its roar (the engage / pressure-escalation roar-cone cue). */
export const MOONPINE_ROARS: Readonly<Record<string, 'frostfang' | 'scout' | 'ruun'>> = {
  'moonpine-frostfang': 'frostfang', 'moonpine-scout': 'scout', 'moonpine-ruun': 'ruun',
};

/** True for the nine Moonpine attack phases and for the Moonpine wolves' roars; every other cue keeps its existing audio path. */
export function isMoonpineCue(cue: StoryCue): boolean {
  if (cue.kind === 'roar-cone') return cue.actorId !== undefined && MOONPINE_ROARS[cue.actorId] !== undefined;
  if (cue.kind !== 'anticipation' && cue.kind !== 'commit' && cue.kind !== 'active' && cue.kind !== 'hit') return false;
  return cue.attackId !== undefined && MOONPINE_ATTACKS[cue.attackId] === true;
}

/** Procedural layers for a Moonpine monster cue (attack phases and roars), or undefined for any other cue (or a silent phase). */
export function moonpineLayers(cue: StoryCue): readonly SoundLayer[] | undefined {
  if (!isMoonpineCue(cue)) return undefined;
  const seconds = Math.min(WARDEN_MAX_SECONDS, Math.max(0.05, (cue.durationTicks ?? 12) / 60)), vary = 0.94 + 0.12 * jitter(cue.instanceId);
  if (cue.kind === 'roar-cone') return roar(MOONPINE_ROARS[cue.actorId!]!, seconds, vary, Math.min(1.5, Math.max(0.4, cue.intensity ?? 1)));
  const phase = cue.kind as Phase;
  switch (cue.attackId as MoonpineAttackId) {
    case 'frostfang-pack-rush': return packRush(phase, seconds, vary);
    case 'frostfang-ice-bite': return iceBite(phase, seconds, vary);
    case 'frostfang-frost-breath': return frostBreath(phase, seconds, vary);
    case 'howl-scout-flank-pounce': return flankPounce(phase, seconds, vary);
    case 'howl-scout-claw-rake': return clawRake(phase, seconds, vary);
    case 'howl-scout-low-howl': return lowHowl(phase, seconds, vary);
    case 'chained-ruun-chain-pounce': return chainPounce(phase, seconds, vary);
    case 'chained-ruun-howl-shockwave': return howlShockwave(phase, seconds, vary);
    case 'chained-ruun-breaking-ice': return breakingIce(phase, seconds, vary);
    default: return undefined;
  }
}

type Phase = 'anticipation' | 'commit' | 'active' | 'hit';
const span = (seconds: number, min: number, max: number): number => Math.min(max, Math.max(min, seconds));

/** Short body impact shared by every `hit` cue: noise click + low thump (+ the wolf's character in `extra`). */
function thump(pitch: number, vary: number, extra: readonly SoundLayer[] = []): readonly SoundLayer[] {
  return [noise(0, 0.045, 0.05, 0.002, 'white', 'highpass', 1800, 900), tone(0, 0.18, 0.06, 0.003, 'sine', pitch * vary, pitch * 0.4), ...extra];
}

/** A rattle of chain links: three short inharmonic metallic partials a few milliseconds apart, plus a dull clank. */
function chainRattle(delay: number, vary: number, level: number): readonly SoundLayer[] {
  return [
    tone(delay, 0.16, level, 0.002, 'triangle', 1850 * vary, 1500),
    tone(delay + 0.025, 0.14, level * 0.8, 0.002, 'triangle', 2790 * vary, 2300),
    tone(delay + 0.06, 0.12, level * 0.6, 0.002, 'triangle', 3380 * vary, 2800),
    noise(delay, 0.08, level * 0.7, 0.002, 'crackle', 'bandpass', 3200 * vary, 2000, 1.6),
  ];
}

function packRush(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': {
      // Low growl, panting breath and a paw scraping the crust of the snow.
      const length = span(seconds, 0.5, 1);
      return [
        tone(0, length, 0.04, length * 0.6, 'sawtooth', 78 * vary, 118 * vary, 'lowpass', 340, 700),
        noise(0, length, 0.022, length * 0.5, 'wind', 'bandpass', 900 * vary, 1400, 1),
        noise(0.05, length, 0.018, length * 0.4, 'crackle', 'bandpass', 2400 * vary, 1800, 1.2),
      ];
    }
    case 'commit': // Burst off the mark: a sharp breath, snow kicked up and a rising snarl.
      return [
        noise(0, 0.28, 0.05, 0.04, 'wind', 'bandpass', 700 * vary, 2200, 0.9),
        tone(0, 0.26, 0.04, 0.05, 'sawtooth', 130 * vary, 210, 'lowpass', 700, 1400),
        noise(0.02, 0.2, 0.026, 0.02, 'crackle', 'bandpass', 2800 * vary, 1600, 1.2),
      ];
    case 'active': // The rush: paws drumming on frozen ground, a rushing pass-by and a snarl falling away.
      return [
        tone(0, 0.2, 0.06, 0.004, 'sine', 100 * vary, 48),
        tone(0.12, 0.2, 0.055, 0.004, 'sine', 104 * vary, 50),
        tone(0.24, 0.2, 0.05, 0.004, 'sine', 108 * vary, 52),
        noise(0, 0.56, 0.055, 0.05, 'wind', 'bandpass', 2600 * vary, 500, 0.9),
        tone(0.02, 0.5, 0.04, 0.05, 'sawtooth', 240 * vary, 120, 'lowpass', 1100, 360),
        noise(0.04, 0.46, 0.022, 0.03, 'crackle', 'bandpass', 3000 * vary, 1500, 1.2),
      ];
    default: return thump(120, vary, [tone(0, 0.2, 0.03, 0.01, 'sawtooth', 200 * vary, 110, 'lowpass', 900, 400)]);
  }
}

function iceBite(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': {
      // Frost-rimed jaws: a cold hiss, the chatter of teeth and a low warning growl.
      const length = span(seconds, 0.4, 0.8);
      return [
        noise(0, length, 0.026, length * 0.6, 'white', 'highpass', 4600 * vary, 6200, 1),
        tone(0.04, 0.05, 0.03, 0.002, 'triangle', 520 * vary, 420),
        tone(0.16, 0.05, 0.03, 0.002, 'triangle', 540 * vary, 430),
        tone(0.28, 0.05, 0.03, 0.002, 'triangle', 500 * vary, 400),
        tone(0, length, 0.03, length * 0.7, 'sawtooth', 70 * vary, 98 * vary, 'lowpass', 280, 520),
      ];
    }
    case 'commit': return [noise(0, 0.22, 0.045, 0.04, 'white', 'bandpass', 2600 * vary, 5200, 1.1), tone(0, 0.18, 0.016, 0.04, 'sine', 300 * vary, 760)];
    case 'active': // Bite: the click of the jaws, a crack of rime ice and a short low thump.
      return [
        noise(0, 0.04, 0.06, 0.001, 'white', 'highpass', 3600, 2200),
        noise(0.01, 0.26, 0.05, 0.003, 'crackle', 'bandpass', 4500 * vary, 2200, 1.3),
        noise(0.02, 0.2, 0.024, 0.004, 'shards', 'highpass', 5200, 3600),
        tone(0.02, 0.16, 0.055, 0.003, 'sine', 130 * vary, 58),
      ];
    default: return thump(135, vary, [noise(0, 0.12, 0.03, 0.004, 'crackle', 'bandpass', 3800, 2200, 1.3)]);
  }
}

function frostBreath(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': {
      // A long cold inhale, a faint crystalline ring and a growl in the chest.
      const length = span(seconds, 0.5, 1);
      return [
        noise(0, length, 0.04, length * 0.8, 'wind', 'bandpass', 500 * vary, 1900, 0.9),
        tone(0, length, 0.01, length * 0.9, 'triangle', 1800 * vary, 2500 * vary),
        tone(0.05, length, 0.03, length * 0.7, 'sawtooth', 66 * vary, 96 * vary, 'lowpass', 260, 480),
      ];
    }
    case 'commit': return [noise(0, 0.26, 0.045, 0.1, 'wind', 'bandpass', 900 * vary, 2300, 1), tone(0, 0.24, 0.03, 0.08, 'sine', 200 * vary, 420)];
    case 'active': // The breath: a long freezing hiss, wind falling away, ice crystals forming in glassy glints.
      return [
        noise(0, 0.9, 0.055, 0.05, 'white', 'highpass', 5600 * vary, 3000, 1),
        noise(0, 0.8, 0.04, 0.05, 'wind', 'bandpass', 1300 * vary, 450, 0.8),
        noise(0.1, 0.5, 0.022, 0.05, 'shards', 'highpass', 5200, 3600),
        tone(0.1, 0.6, 0.012, 0.1, 'triangle', 2600 * vary, 3300),
        tone(0.28, 0.5, 0.01, 0.1, 'triangle', 3100 * vary, 3900),
        tone(0, 0.5, 0.03, 0.05, 'sawtooth', 120 * vary, 70, 'lowpass', 420, 220),
      ];
    default: return thump(150, vary, [tone(0, 0.2, 0.012, 0.004, 'triangle', 2800 * vary, 2000), noise(0, 0.16, 0.026, 0.004, 'shards', 'highpass', 4800, 3400)]);
  }
}

function flankPounce(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': {
      // Sharp excited yips while the scout circles, and quick light paws on the snow.
      const length = span(seconds, 0.4, 0.9);
      return [
        tone(0, 0.12, 0.034, 0.01, 'triangle', 640 * vary, 980),
        tone(0.2, 0.12, 0.034, 0.01, 'triangle', 700 * vary, 1050),
        tone(0.4, 0.12, 0.034, 0.01, 'triangle', 760 * vary, 1120),
        noise(0, length, 0.02, length * 0.5, 'crackle', 'bandpass', 2600 * vary, 2000, 1.2),
      ];
    }
    case 'commit': // Launch: a scrabble off the crust and a rising whoosh.
      return [
        noise(0, 0.12, 0.05, 0.004, 'crackle', 'bandpass', 2800 * vary, 1800, 1.3),
        noise(0.02, 0.3, 0.05, 0.05, 'wind', 'bandpass', 500 * vary, 2400, 0.9),
        tone(0.02, 0.26, 0.026, 0.06, 'sine', 180 * vary, 360),
      ];
    case 'active': // Landing: a thud, a puff of snow, a snarl.
      return [
        tone(0, 0.4, 0.07, 0.004, 'sine', 108 * vary, 40),
        noise(0, 0.3, 0.055, 0.003, 'white', 'lowpass', 1800, 220),
        noise(0.02, 0.36, 0.024, 0.01, 'wind', 'highpass', 2800, 1800),
        tone(0.03, 0.34, 0.036, 0.03, 'sawtooth', 210 * vary, 130, 'lowpass', 950, 400),
      ];
    default: return thump(140, vary, [tone(0, 0.14, 0.03, 0.006, 'triangle', 760 * vary, 520)]);
  }
}

function clawRake(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': { // Claws combing the snow: dry scraping, a low growl.
      const length = span(seconds, 0.4, 0.8);
      return [
        noise(0, length, 0.026, length * 0.6, 'shards', 'highpass', 2800 * vary, 3600),
        noise(0.05, length, 0.018, length * 0.5, 'crackle', 'bandpass', 1500, 2200, 1.3),
        tone(0, length, 0.03, length * 0.7, 'sawtooth', 74 * vary, 104 * vary, 'lowpass', 300, 560),
      ];
    }
    case 'commit': return [noise(0, 0.22, 0.05, 0.04, 'wind', 'bandpass', 900 * vary, 2400, 1), tone(0, 0.2, 0.024, 0.05, 'sine', 170 * vary, 260)];
    case 'active': // Two quick swipes through the air and a scrape of crust.
      return [
        noise(0, 0.2, 0.06, 0.01, 'white', 'bandpass', 3200 * vary, 1200, 1),
        noise(0.09, 0.22, 0.056, 0.01, 'white', 'bandpass', 3000 * vary, 1100, 1),
        noise(0.05, 0.3, 0.026, 0.01, 'shards', 'highpass', 3600, 2400),
        tone(0.04, 0.16, 0.045, 0.004, 'sine', 126 * vary, 62),
      ];
    default: return thump(150, vary, [noise(0, 0.16, 0.03, 0.006, 'shards', 'highpass', 3400, 2200)]);
  }
}

function lowHowl(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': { // The howl climbs: a detuned pair gliding up with breath under it.
      const length = span(seconds, 0.5, 1);
      return [
        tone(0, length, 0.04, length * 0.6, 'triangle', 330 * vary, 560 * vary),
        tone(0.02, length, 0.03, length * 0.6, 'triangle', 340 * vary, 575 * vary),
        noise(0, length, 0.016, length * 0.7, 'wind', 'bandpass', 700, 1100, 0.9),
      ];
    }
    case 'commit': // The held note at its peak.
      return [
        tone(0, 0.3, 0.045, 0.05, 'triangle', 560 * vary, 520),
        tone(0.01, 0.3, 0.03, 0.05, 'triangle', 575 * vary, 534),
        noise(0, 0.28, 0.026, 0.06, 'wind', 'bandpass', 1100 * vary, 1700, 0.9),
      ];
    case 'active': // The shockwave rolls out: a low swell, wind raking the snow and the note falling away.
      return [
        tone(0, 0.8, 0.065, 0.06, 'sine', 96 * vary, 42),
        noise(0, 0.7, 0.055, 0.08, 'wind', 'bandpass', 600 * vary, 220, 0.8),
        tone(0.02, 0.7, 0.032, 0.05, 'triangle', 480 * vary, 300),
        noise(0.04, 0.4, 0.02, 0.04, 'white', 'highpass', 3600, 2200),
      ];
    default: return thump(120, vary, [noise(0, 0.2, 0.03, 0.01, 'wind', 'bandpass', 800, 450)]);
  }
}

function chainPounce(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': {
      // Links grinding as he strains against the chains, a deep growl.
      const length = span(seconds, 0.6, 1);
      return [
        tone(0, length, 0.045, length * 0.7, 'sawtooth', 52 * vary, 86 * vary, 'lowpass', 240, 520),
        noise(0, length, 0.02, length * 0.6, 'crackle', 'bandpass', 700, 1200, 1.2),
        ...chainRattle(0.3, vary, 0.018),
        tone(0.3, length - 0.3, 0.012, 0.1, 'sine', 40 * vary, 34),
      ];
    }
    case 'commit': // The chains snap taut: a metallic crack and a heavy launch.
      return [
        ...chainRattle(0, vary, 0.03),
        tone(0.02, 0.26, 0.05, 0.01, 'sine', 160 * vary, 70),
        noise(0.02, 0.26, 0.04, 0.05, 'wind', 'bandpass', 500 * vary, 1800, 0.9),
      ];
    case 'active': // The landing: a huge boom, frozen ground cracking, and the chains falling slack.
      return [
        tone(0, 0.6, 0.08, 0.004, 'sine', 74 * vary, 26),
        noise(0, 0.4, 0.065, 0.003, 'white', 'lowpass', 1500, 130),
        noise(0.03, 0.5, 0.024, 0.004, 'shards', 'highpass', 2200 * vary, 1400),
        tone(0.04, 1, 0.04, 0.06, 'sawtooth', 48, 34, 'lowpass', 200, 90),
        ...chainRattle(0.14, vary, 0.02),
      ];
    default: return thump(90, vary, chainRattle(0, vary, 0.016));
  }
}

function howlShockwave(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': {
      // The three-beat howl gathers: three rising notes, each longer than the last, over a deep drone.
      const length = span(seconds, 0.7, 1.1);
      return [
        tone(0, 0.24, 0.045, 0.04, 'triangle', 150 * vary, 190),
        tone(0.3, 0.3, 0.05, 0.04, 'triangle', 180 * vary, 230),
        tone(0.64, 0.42, 0.055, 0.05, 'triangle', 215 * vary, 290),
        tone(0, length, 0.03, length * 0.7, 'sine', 56 * vary, 78),
        noise(0, length, 0.016, length * 0.7, 'wind', 'bandpass', 400, 800, 0.9),
      ];
    }
    case 'commit': // The full note: a raw sawtooth howl with a chest sub and a ring of chain.
      return [
        tone(0, 0.32, 0.055, 0.05, 'sawtooth', 300 * vary, 270, 'lowpass', 1400, 900),
        tone(0.01, 0.32, 0.05, 0.05, 'sine', 150 * vary, 135),
        noise(0, 0.3, 0.03, 0.06, 'wind', 'bandpass', 600 * vary, 1100, 0.9),
        ...chainRattle(0.04, vary, 0.014),
      ];
    case 'active': // The burst: a deep boom, a roaring blast of air, shards of frozen ground.
      return [
        tone(0, 0.9, 0.08, 0.01, 'sine', 70 * vary, 28),
        noise(0, 0.6, 0.065, 0.02, 'white', 'lowpass', 1700, 160),
        noise(0, 0.8, 0.05, 0.05, 'wind', 'bandpass', 800 * vary, 260, 0.8),
        tone(0.02, 0.8, 0.036, 0.04, 'sawtooth', 220 * vary, 110, 'lowpass', 900, 260),
        noise(0.06, 0.5, 0.022, 0.02, 'shards', 'highpass', 3200, 1800),
      ];
    default: return thump(105, vary, [noise(0, 0.22, 0.032, 0.01, 'wind', 'bandpass', 900, 400)]);
  }
}

function breakingIce(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': {
      // The frozen lake groans under the stamp: creaking tones and brittle ticks.
      const length = span(seconds, 0.5, 1);
      return [
        tone(0, length, 0.026, length * 0.8, 'triangle', 900 * vary, 1500 * vary),
        tone(0.1, length, 0.02, length * 0.8, 'sine', 360 * vary, 560),
        noise(0, length, 0.026, length * 0.6, 'crackle', 'bandpass', 2800 * vary, 4200, 1.4),
        tone(0, length, 0.03, length * 0.7, 'sawtooth', 54 * vary, 80 * vary, 'lowpass', 220, 420),
      ];
    }
    case 'commit': // The stamp: a thud and a first sharp crack running out.
      return [
        tone(0, 0.22, 0.065, 0.004, 'sine', 100 * vary, 48),
        noise(0.02, 0.2, 0.05, 0.003, 'crackle', 'bandpass', 4600 * vary, 2400, 1.3),
        noise(0.02, 0.2, 0.024, 0.01, 'shards', 'highpass', 4800, 3000),
      ];
    case 'active': // The ice splits along the wave: a long running crack, glassy shards and a deep boom underneath.
      return [
        noise(0, 0.7, 0.06, 0.02, 'crackle', 'bandpass', 3600 * vary, 900, 1.2),
        noise(0, 0.5, 0.03, 0.01, 'shards', 'highpass', 5000, 2600),
        tone(0, 0.6, 0.075, 0.006, 'sine', 66 * vary, 28),
        tone(0.05, 0.6, 0.014, 0.02, 'triangle', 2300 * vary, 800),
        noise(0.05, 0.6, 0.035, 0.05, 'wind', 'bandpass', 1500 * vary, 500, 0.9),
      ];
    default: return thump(100, vary, [noise(0, 0.2, 0.03, 0.004, 'crackle', 'bandpass', 4000, 2200, 1.3), tone(0, 0.2, 0.012, 0.004, 'triangle', 2600 * vary, 1700)]);
  }
}

/** The wolves' own roars on the engage / escalation roar-cone: guttural snarl-bark, yipping high howl, deep chained howl. */
function roar(voice: 'frostfang' | 'scout' | 'ruun', seconds: number, vary: number, intensity: number): readonly SoundLayer[] {
  const length = span(seconds, 0.5, 1.1), level = 0.8 + 0.2 * intensity;
  switch (voice) {
    case 'frostfang': // Two pitch-dropping barks through a lowpass over a rasping snarl and cold breath.
      return [
        tone(0, 0.4, 0.055 * level, 0.03, 'sawtooth', 220 * vary, 96, 'lowpass', 1000, 340),
        tone(0.5, 0.4, 0.05 * level, 0.03, 'sawtooth', 210 * vary, 92, 'lowpass', 1000, 340),
        tone(0, length, 0.03 * level, 0.1, 'sawtooth', 72 * vary, 60, 'lowpass', 260, 180),
        noise(0, length, 0.03 * level, 0.1, 'crackle', 'bandpass', 700, 500, 1),
        noise(0.05, length, 0.018 * level, 0.1, 'wind', 'highpass', 3500, 2400),
      ];
    case 'scout': // An excited, climbing howl broken by two yelps, high and thin.
      return [
        tone(0, length, 0.04 * level, 0.15, 'triangle', 660 * vary, 1180),
        tone(0.02, length, 0.026 * level, 0.15, 'triangle', 680 * vary, 1210),
        tone(0.1, 0.14, 0.04 * level, 0.01, 'sawtooth', 900 * vary, 700, 'bandpass', 1400, 1000),
        tone(0.36, 0.14, 0.04 * level, 0.01, 'sawtooth', 960 * vary, 740, 'bandpass', 1500, 1100),
        noise(0, length, 0.016 * level, 0.1, 'wind', 'highpass', 3800, 5200),
      ];
    case 'ruun': // A deep, long howl that rises and wavers, a sub-bass chest, breath, and chains rattling with it.
      return [
        tone(0, length, 0.055 * level, 0.2, 'sawtooth', 120 * vary, 215, 'lowpass', 900, 500),
        tone(0.02, length, 0.04 * level, 0.2, 'triangle', 124 * vary, 220),
        tone(0, length, 0.04 * level, 0.1, 'sine', 56, 44),
        noise(0, length, 0.026 * level, 0.15, 'wind', 'bandpass', 500, 380, 0.8),
        ...chainRattle(0.3, vary, 0.014 * level),
      ];
  }
}
