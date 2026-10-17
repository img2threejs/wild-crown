import type { StoryCue } from '../effects/story-cues.js';
import { WARDEN_MAX_SECONDS, jitter, noise, tone, type SoundLayer } from './WardenSounds.js';

/**
 * Procedural timbres for the Grove's monsters (docs/features/grove-playtest.md). The practice partner is gentle: soft wooden knocks, leaf
 * rustle and small chimes, never harsh. The blighted rootling plays the same three recipes a fifth lower over a low sap drone. Hollowheart
 * is heavy but still woody: creaking groans, wood cracks, wet splats and a bright heart-light chime, built from sine, triangle and noise
 * only. Like the Warden and canopy recipes these are pure layer data (oscillator glides + filtered looped-noise bursts) that `StoryAudio`
 * voices through the same layered path, inside the same per-voice level / length / layer budgets and the same bounded wildlife voice pool,
 * so a barrage of Grove cues can never steal Warden voices.
 */
export const GROVE_ATTACK_IDS = ['sprig-seed-toss', 'sprig-ground-ripple', 'sprig-petal-sweep'] as const;
export const GROVE_BLIGHT_ATTACK_IDS = ['blighted-seed-lob', 'blighted-ground-pulse', 'blighted-lash-sweep'] as const;
export const GROVE_GUARDIAN_ATTACK_IDS = ['hollowheart-leap-smash', 'hollowheart-antler-sweep', 'hollowheart-ichor-hurl', 'hollowheart-heartlight-burst'] as const;
export type GroveAttackId = typeof GROVE_ATTACK_IDS[number] | typeof GROVE_BLIGHT_ATTACK_IDS[number] | typeof GROVE_GUARDIAN_ATTACK_IDS[number];
const GROVE_ATTACKS: Readonly<Record<string, true>> = Object.fromEntries([...GROVE_ATTACK_IDS, ...GROVE_BLIGHT_ATTACK_IDS, ...GROVE_GUARDIAN_ATTACK_IDS].map(id => [id, true]));
/** Actor instance id → voice of its roar (the engage / pressure-escalation roar-cone cue): a gentle chirr, a darker one, a deep groan. */
export const GROVE_ROARS: Readonly<Record<string, 'sprig' | 'blighted' | 'guardian'>> = { 'grove-sprig': 'sprig', 'grove-blighted': 'blighted', 'grove-hollowheart': 'guardian' };

/** True for the Grove attack phases and for the three Grove roars; every other cue keeps its existing audio path. */
export function isGroveCue(cue: StoryCue): boolean {
  if (cue.kind === 'roar-cone') return cue.actorId !== undefined && GROVE_ROARS[cue.actorId] !== undefined;
  if (cue.kind !== 'anticipation' && cue.kind !== 'commit' && cue.kind !== 'active' && cue.kind !== 'hit') return false;
  return cue.attackId !== undefined && GROVE_ATTACKS[cue.attackId] === true;
}

/** A fifth lower than the sprig, over a low sap drone: the blighted rootling's recipes. */
const BLIGHT_PITCH = 0.67;

/** Procedural layers for a Grove monster cue (attack phases and roars), or undefined for any other cue. */
export function groveLayers(cue: StoryCue): readonly SoundLayer[] | undefined {
  if (!isGroveCue(cue)) return undefined;
  const seconds = Math.min(WARDEN_MAX_SECONDS, Math.max(0.05, (cue.durationTicks ?? 12) / 60)), vary = 0.94 + 0.12 * jitter(cue.instanceId);
  if (cue.kind === 'roar-cone') {
    const intensity = Math.min(1.5, Math.max(0.4, cue.intensity ?? 1)), voice = GROVE_ROARS[cue.actorId!];
    return voice === 'guardian' ? groan(seconds, vary, intensity) : voice === 'blighted' ? [...chirr(seconds, vary * BLIGHT_PITCH, intensity), sapDrone(span(seconds, 0.5, 1.1))] : chirr(seconds, vary, intensity);
  }
  const phase = cue.kind as Phase;
  switch (cue.attackId as GroveAttackId) {
    case 'sprig-seed-toss': return seedToss(phase, seconds, vary);
    case 'sprig-ground-ripple': return groundRipple(phase, seconds, vary);
    case 'sprig-petal-sweep': return petalSweep(phase, seconds, vary);
    case 'blighted-seed-lob': return withDrone(seedToss(phase, seconds, vary * BLIGHT_PITCH), phase, seconds);
    case 'blighted-ground-pulse': return withDrone(groundRipple(phase, seconds, vary * BLIGHT_PITCH), phase, seconds);
    case 'blighted-lash-sweep': return withDrone(petalSweep(phase, seconds, vary * BLIGHT_PITCH), phase, seconds);
    case 'hollowheart-leap-smash': return leapSmash(phase, seconds, vary);
    case 'hollowheart-antler-sweep': return antlerSweep(phase, seconds, vary);
    case 'hollowheart-ichor-hurl': return ichorHurl(phase, seconds, vary);
    case 'hollowheart-heartlight-burst': return heartlightBurst(phase, seconds, vary);
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

/** The low sap drone that sits under every blighted cue: a sine that wavers slowly downwards. */
const sapDrone = (length: number): SoundLayer => tone(0, length, 0.016, length * 0.4, 'sine', 84, 66);

/** A blighted cue: the sprig's recipe with the sap drone added (no recipe has more than four layers, so the voice budget holds). */
const withDrone = (layers: readonly SoundLayer[], phase: Phase, seconds: number): readonly SoundLayer[] => [...layers, sapDrone(phase === 'anticipation' ? span(seconds, 0.4, 0.9) : phase === 'active' ? 0.45 : 0.25)];

/** Hollowheart's roar on the engage / escalation roar-cone: a deep wooden groan, creaking branches and a rumble of settling roots. */
function groan(seconds: number, vary: number, intensity: number): readonly SoundLayer[] {
  const length = span(seconds, 0.7, 1.3), level = 0.8 + 0.2 * intensity;
  return [
    tone(0, length, 0.06 * level, length * 0.3, 'triangle', 74 * vary, 52 * vary, 'lowpass', 420, 260),
    tone(0.05, length * 0.9, 0.034 * level, length * 0.3, 'sine', 118 * vary, 82 * vary),
    tone(0.1, length * 0.8, 0.02 * level, length * 0.4, 'triangle', 190 * vary, 150 * vary, 'bandpass', 600, 380),
    noise(0, length, 0.03 * level, length * 0.3, 'crackle', 'bandpass', 700, 300, 1.2),
    noise(0.1, length * 0.9, 0.02 * level, length * 0.4, 'wind', 'lowpass', 900, 320),
  ];
}

/** Wood crack and thud shared by the guardian's hits: a dry crack over a heavy dull thump. */
const heavyKnock = (vary: number, extra: readonly SoundLayer[] = []): readonly SoundLayer[] => [
  noise(0, 0.07, 0.05, 0.003, 'white', 'bandpass', 1800, 900, 1.2),
  tone(0, 0.26, 0.07, 0.004, 'sine', 120 * vary, 50),
  ...extra,
];

function leapSmash(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': { // The guardian crouches: straining wood and a gathering rumble.
      const length = span(seconds, 0.5, 1.2);
      return [
        tone(0, length, 0.04, length * 0.7, 'triangle', 90 * vary, 150 * vary, 'bandpass', 300, 700),
        noise(0, length, 0.03, length * 0.6, 'crackle', 'bandpass', 500, 900, 1.2),
        tone(0.05, length, 0.03, length * 0.6, 'sine', 60 * vary, 80 * vary),
      ];
    }
    case 'commit': // The leap: a heavy low whoosh falling away.
      return [noise(0, 0.4, 0.05, 0.08, 'wind', 'lowpass', 1400, 400, 0.9), tone(0, 0.36, 0.05, 0.06, 'sine', 140 * vary, 70)];
    case 'active': // The landing: a bone-deep thud, a wood crack and a spray of bark.
      return [
        tone(0, 0.5, 0.08, 0.004, 'sine', 100 * vary, 36),
        noise(0, 0.4, 0.06, 0.006, 'white', 'lowpass', 1800, 260),
        noise(0.02, 0.18, 0.04, 0.004, 'crackle', 'bandpass', 1400, 700, 1),
        tone(0.03, 0.6, 0.03, 0.01, 'triangle', 70 * vary, 48),
      ];
    default: return heavyKnock(vary);
  }
}

function antlerSweep(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': { // The swollen arm drags back: a long wooden creak and wet drips.
      const length = span(seconds, 0.5, 1.2);
      return [
        tone(0, length, 0.04, length * 0.7, 'triangle', 110 * vary, 170 * vary, 'bandpass', 400, 800),
        noise(0, length, 0.026, length * 0.6, 'crackle', 'bandpass', 700, 1100, 1.2),
        noise(0.1, length * 0.8, 0.012, length * 0.5, 'wind', 'highpass', 2200, 3000),
      ];
    }
    case 'commit': return [noise(0, 0.3, 0.05, 0.06, 'wind', 'bandpass', 700 * vary, 1700, 0.9), tone(0, 0.28, 0.04, 0.06, 'triangle', 160 * vary, 260)];
    case 'active': // The sweep: a wide heavy whoosh, a crack of wood and a low thump.
      return [
        noise(0, 0.5, 0.06, 0.05, 'wind', 'bandpass', 900 * vary, 1800, 0.8),
        noise(0.08, 0.14, 0.05, 0.004, 'crackle', 'bandpass', 1500, 800, 1),
        tone(0.05, 0.3, 0.06, 0.005, 'sine', 110 * vary, 58),
      ];
    default: return heavyKnock(vary, [noise(0, 0.12, 0.02, 0.01, 'wind', 'highpass', 2600, 1800)]);
  }
}

function ichorHurl(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': { // A clot of Black Sap swells: a wet bubbling and a low gurgle.
      const length = span(seconds, 0.5, 1.2);
      return [
        noise(0, length, 0.03, length * 0.6, 'crackle', 'bandpass', 500, 900, 2),
        tone(0, length, 0.03, length * 0.6, 'sine', 80 * vary, 140 * vary),
        tone(0.05, length, 0.014, length * 0.7, 'triangle', 220 * vary, 330 * vary, 'bandpass', 500, 900),
      ];
    }
    case 'commit': return [tone(0, 0.26, 0.04, 0.02, 'sine', 360 * vary, 150), noise(0, 0.3, 0.04, 0.05, 'wind', 'bandpass', 1100 * vary, 500, 0.9)];
    case 'active': // The splat: a wet slap and a falling gurgle.
      return [
        noise(0, 0.3, 0.06, 0.005, 'white', 'lowpass', 1400, 300),
        tone(0, 0.34, 0.06, 0.004, 'sine', 150 * vary, 55),
        noise(0.05, 0.4, 0.03, 0.02, 'crackle', 'bandpass', 600, 300, 2),
      ];
    default: return heavyKnock(vary * 0.9, [noise(0, 0.16, 0.02, 0.01, 'crackle', 'bandpass', 500, 300, 2)]);
  }
}

function heartlightBurst(phase: Phase, seconds: number, vary: number): readonly SoundLayer[] {
  switch (phase) {
    case 'anticipation': { // The heart-light swells: a rising hum with a glassy shimmer over it.
      const length = span(seconds, 0.6, 1.3);
      return [
        tone(0, length, 0.04, length * 0.8, 'triangle', 196 * vary, 392 * vary),
        tone(0.05, length, 0.026, length * 0.8, 'sine', 392 * vary, 784 * vary),
        tone(0.1, length * 0.9, 0.012, length * 0.8, 'sine', 1175 * vary, 1568 * vary),
        noise(0, length, 0.012, length * 0.7, 'wind', 'highpass', 2400, 3600),
      ];
    }
    case 'commit': return [tone(0, 0.3, 0.05, 0.1, 'sine', 392 * vary, 784), tone(0, 0.3, 0.03, 0.1, 'triangle', 588 * vary, 1175)];
    case 'active': // The burst: a bright bell-like chime over a deep boom.
      return [
        tone(0, 0.6, 0.07, 0.006, 'sine', 80 * vary, 40),
        tone(0, 0.9, 0.045, 0.006, 'triangle', 880 * vary, 860),
        tone(0.02, 0.8, 0.03, 0.006, 'sine', 1320 * vary, 1300),
        noise(0, 0.4, 0.04, 0.01, 'white', 'highpass', 3200, 1800),
      ];
    default: return heavyKnock(vary, [tone(0.02, 0.3, 0.02, 0.01, 'triangle', 880 * vary, 860)]);
  }
}
