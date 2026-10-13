import type { StoryCue } from '../effects/story-cues.js';
import { WARDEN_MAX_SECONDS, jitter, noise, tone, type SoundLayer } from './WardenSounds.js';

/**
 * Procedural timbres for the Grove's practice partner (docs/features/grove-playtest.md): soft wooden knocks, leaf rustle and small
 * chimes, never harsh. Like the Warden and canopy recipes these are pure layer data (oscillator glides + filtered looped-noise
 * bursts) that `StoryAudio` voices through the same layered path, inside the same per-voice level / length / layer budgets and the
 * same bounded wildlife voice pool, so a barrage of Grove cues can never steal Warden voices.
 */
export const GROVE_ATTACK_IDS = ['sprig-seed-toss', 'sprig-ground-ripple', 'sprig-petal-sweep'] as const;
export type GroveAttackId = typeof GROVE_ATTACK_IDS[number];
const GROVE_ATTACKS: Readonly<Record<string, true>> = { 'sprig-seed-toss': true, 'sprig-ground-ripple': true, 'sprig-petal-sweep': true };
/** Actor instance id → voice of its roar (the engage / pressure-escalation roar-cone cue): a gentle chirr. */
export const GROVE_ROARS: Readonly<Record<string, 'sprig'>> = { 'grove-sprig': 'sprig' };

/** True for the three practice attack phases and for the sprig's chirr; every other cue keeps its existing audio path. */
export function isGroveCue(cue: StoryCue): boolean {
  if (cue.kind === 'roar-cone') return cue.actorId !== undefined && GROVE_ROARS[cue.actorId] !== undefined;
  if (cue.kind !== 'anticipation' && cue.kind !== 'commit' && cue.kind !== 'active' && cue.kind !== 'hit') return false;
  return cue.attackId !== undefined && GROVE_ATTACKS[cue.attackId] === true;
}

/** Procedural layers for a Grove monster cue (attack phases and roars), or undefined for any other cue. */
export function groveLayers(cue: StoryCue): readonly SoundLayer[] | undefined {
  if (!isGroveCue(cue)) return undefined;
  const seconds = Math.min(WARDEN_MAX_SECONDS, Math.max(0.05, (cue.durationTicks ?? 12) / 60)), vary = 0.94 + 0.12 * jitter(cue.instanceId);
  if (cue.kind === 'roar-cone') return chirr(seconds, vary, Math.min(1.5, Math.max(0.4, cue.intensity ?? 1)));
  const phase = cue.kind as Phase;
  switch (cue.attackId as GroveAttackId) {
    case 'sprig-seed-toss': return seedToss(phase, seconds, vary);
    case 'sprig-ground-ripple': return groundRipple(phase, seconds, vary);
    case 'sprig-petal-sweep': return petalSweep(phase, seconds, vary);
    default: return undefined;
  }
}

type Phase = 'anticipation' | 'commit' | 'active' | 'hit';
const span = (seconds: number, min: number, max: number): number => Math.min(max, Math.max(min, seconds));

/** Soft wooden knock shared by every `hit` cue: a dull tok and a puff of leaf noise (+ the attack's character in `extra`). */
function knock(pitch: number, vary: number, extra: readonly SoundLayer[] = []): readonly SoundLayer[] {
  return [noise(0, 0.05, 0.03, 0.003, 'white', 'lowpass', 1600, 700), tone(0, 0.16, 0.04, 0.004, 'sine', pitch * vary, pitch * 0.5), ...extra];
}

function seedToss(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': { // A seed ripens: a soft rising shimmer over a leaf rustle.
      const length = span(seconds, 0.4, 0.9);
      return [
        tone(0, length, 0.016, length * 0.7, 'triangle', 520 * vary, 780 * vary),
        tone(0.04, length, 0.01, length * 0.7, 'sine', 780 * vary, 1170 * vary),
        noise(0, length, 0.012, length * 0.6, 'wind', 'highpass', 2400, 3200),
      ];
    }
    case 'commit': // The lob: a soft airy "pwip" falling away.
      return [
        tone(0, 0.2, 0.03, 0.012, 'sine', 720 * vary, 400),
        noise(0, 0.24, 0.022, 0.05, 'wind', 'bandpass', 1400 * vary, 700, 0.9),
      ];
    case 'active': // Landing: a wooden tok, a leafy puff and a small chime.
      return [
        tone(0, 0.22, 0.05, 0.004, 'sine', 190 * vary, 88),
        noise(0, 0.26, 0.03, 0.01, 'white', 'lowpass', 1500, 380),
        tone(0.03, 0.5, 0.014, 0.01, 'triangle', 880 * vary, 860),
        noise(0.05, 0.3, 0.012, 0.03, 'wind', 'highpass', 2800, 2000),
      ];
    default: return knock(160, vary);
  }
}

function groundRipple(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': { // The grass trembles: a low wooden creak and a dry rustle.
      const length = span(seconds, 0.4, 0.9);
      return [
        tone(0, length, 0.018, length * 0.7, 'triangle', 130 * vary, 190 * vary, 'bandpass', 500, 900),
        noise(0, length, 0.016, length * 0.6, 'wind', 'highpass', 2200, 3000),
        noise(0.05, length * 0.8, 0.01, length * 0.5, 'crackle', 'bandpass', 900, 1300, 1),
      ];
    }
    case 'commit': return [noise(0, 0.22, 0.026, 0.05, 'wind', 'bandpass', 500 * vary, 1300, 0.9), tone(0, 0.2, 0.014, 0.05, 'sine', 120 * vary, 170)];
    case 'active': // The ripple: a long soft rustle sweeping past and a low wooden knock underneath.
      return [
        noise(0, 0.5, 0.034, 0.06, 'wind', 'bandpass', 600 * vary, 1500, 0.8),
        noise(0.05, 0.4, 0.016, 0.05, 'crackle', 'bandpass', 1400, 900, 1),
        tone(0.04, 0.26, 0.04, 0.005, 'sine', 125 * vary, 70),
      ];
    default: return knock(140, vary, [noise(0, 0.12, 0.012, 0.01, 'wind', 'highpass', 2600, 1800)]);
  }
}

function petalSweep(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': { // Petals flutter together: airy flutter and two quiet chimes.
      const length = span(seconds, 0.4, 0.9);
      return [
        noise(0, length, 0.014, length * 0.6, 'wind', 'highpass', 2600, 3600),
        tone(0.02, length, 0.01, length * 0.7, 'triangle', 988 * vary, 1318 * vary),
        tone(0.1, length * 0.8, 0.008, length * 0.6, 'sine', 1480 * vary, 1760 * vary),
      ];
    }
    case 'commit': return [noise(0, 0.26, 0.026, 0.06, 'wind', 'bandpass', 1500 * vary, 2400, 0.9), tone(0, 0.22, 0.012, 0.06, 'sine', 700 * vary, 1100)];
    case 'active': // The sweep: a gentle breath along the lane with two soft chimes.
      return [
        noise(0, 0.45, 0.032, 0.05, 'wind', 'bandpass', 1900 * vary, 900, 0.9),
        noise(0, 0.36, 0.014, 0.03, 'white', 'highpass', 4200, 3000),
        tone(0.03, 0.5, 0.014, 0.01, 'triangle', 784 * vary, 770),
        tone(0.09, 0.45, 0.01, 0.01, 'triangle', 1175 * vary, 1160),
      ];
    default: return knock(170, vary, [noise(0, 0.14, 0.012, 0.01, 'wind', 'highpass', 3200, 2400)]);
  }
}

/** The sprig's own roar on the engage / escalation roar-cone: a gentle chirr of five rising chirps over a soft breath. */
function chirr(seconds: number, vary: number, intensity: number): readonly SoundLayer[] {
  const length = span(seconds, 0.5, 1.1), level = 0.8 + 0.2 * intensity;
  return [
    ...[0, 1, 2, 3, 4].map(step => tone(step * 0.1, 0.12, 0.022 * level, 0.01, 'triangle', (760 + step * 70) * vary, (960 + step * 90) * vary)),
    noise(0, length, 0.014 * level, 0.1, 'wind', 'bandpass', 1600, 1100, 0.9),
    tone(0, length * 0.8, 0.012 * level, 0.08, 'sine', 210 * vary, 250 * vary),
  ];
}
