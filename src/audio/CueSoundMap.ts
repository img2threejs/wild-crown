import { ATTACKS, BOSS_ENCOUNTERS } from '../game/combat/content.js';
import type { CombatReactionKind } from '../game/contracts.js';
import type { StoryCue, StoryCueKind } from '../effects/story-cues.js';
import {
  FINISHER_LAYER_GROUP, LAND_GROUP, impactGroupId, reactionGroupId, vocalGroupId, weaponGroupId,
  type ImpactMaterial, type ImpactWeight, type VocalFamily, type WeaponKind,
} from './SampleCatalog.js';

/**
 * How a presentation cue is voiced:
 *  - `sample`: sampled sound only (any generic procedural fallback is suppressed);
 *  - `layered`: sampled body plus the existing procedural recipe (telegraph pitch, spell/elemental timbre or hero accent) on top;
 *  - `procedural`: no sample fits (telegraph tones, spell timbres, story chord stingers), the synthesiser voices it alone;
 *  - `silent`: never sounds.
 * Exhaustive over `StoryCueKind`: adding a cue kind without deciding fails the type check (and tests/audio/audio-mapping.test.ts).
 */
export type CueSoundMode = 'sample' | 'layered' | 'procedural' | 'silent';

export const CUE_SOUND_MODE: Readonly<Record<StoryCueKind, CueSoundMode>> = {
  cancel: 'silent',
  anticipation: 'procedural', commit: 'procedural', active: 'layered', hit: 'layered', landing: 'sample', 'perfect-dodge': 'procedural',
  heartroot: 'procedural', tether: 'procedural', cleanse: 'procedural', bond: 'procedural', dominion: 'procedural', restoration: 'procedural',
  'restoration-water': 'procedural', 'restoration-roots': 'procedural', 'restoration-seeds': 'procedural', 'restoration-animals': 'procedural',
  possession: 'procedural', phase: 'procedural', ending: 'procedural', 'ending-living-pact': 'procedural', 'ending-dominion': 'procedural', 'ending-severance': 'procedural',
  'sap-vein': 'procedural', footprint: 'procedural', pounce: 'layered', 'roar-cone': 'layered', 'low-wave': 'procedural',
  grovebreak: 'layered', march: 'procedural', reunion: 'procedural', heartbeat: 'procedural',
  sigil: 'procedural', projectile: 'procedural', 'projectile-impact': 'layered', slash: 'layered', lightning: 'procedural', judgement: 'procedural', 'judgement-mark': 'procedural',
  'root-eruption': 'procedural', beam: 'procedural', bloom: 'procedural', blink: 'procedural',
  'reaction-start': 'sample', 'wall-impact': 'sample', 'poise-break': 'sample', getup: 'sample',
  // Companion field verbs: short synthesised chimes (no sample fits; no new audio source).
  mark: 'procedural', guard: 'procedural', command: 'procedural', shelter: 'procedural',
  // Vara's Storm Talon: synthesised storm wind + avian screech on hit; the strike moment triggers layered sampled wing beat.
  'storm-talon': 'layered',
};

/** One sampled sound to start: a catalogue group, a linear gain multiplier, a playback-rate multiplier and a start delay. */
export interface SampleRequest {
  group: string;
  gain: number;
  rate: number;
  delay: number;
}
/** Scratch requests written by `samplesForCue`; valid until the next call. */
export const SAMPLE_REQUESTS: readonly SampleRequest[] = [0, 1, 2, 3].map(() => ({ group: '', gain: 1, rate: 1, delay: 0 }));
let requestCount = 0;
function request(group: string, gain: number, rate = 1, delay = 0): void {
  const slot = SAMPLE_REQUESTS[requestCount++]!;
  slot.group = group; slot.gain = gain; slot.rate = rate; slot.delay = delay;
}
const clamp = (value: number, lo: number, hi: number): number => (value < lo ? lo : value > hi ? hi : value);

const FAMILY_PATTERNS: readonly (readonly [VocalFamily, RegExp])[] = [
  ['rootling', /rootling|hollowheart|grove|blight|sprig|treant|root/],
  ['canine', /wolf|howl-?scout|frostfang|ruun|sable|hound|fang/],
  ['primate', /macaque|koro|monkey|howler|primate|ape/],
  ['avian', /hornbill|bird|raptor|vara|crow|hawk|harpy-eagle|eagle/],
  ['reptile', /viper|snake|croc|lurker|bog|ghor|reptile|lizard/],
  ['humanoid', /poacher|hunter|human|marek|council|envoy|scout-|aren|yara|vesper|sakda/],
];
const BOSS_IDS = new Set<string>(Object.values(BOSS_ENCOUNTERS).flatMap(encounter => [encounter.bossId, ...encounter.largeActors]));

/** Boss actors (every `BOSS_ENCOUNTERS` boss and large actor); they roar with the giant set. */
export function isBossActor(actorId: string | undefined): boolean {
  return actorId !== undefined && BOSS_IDS.has(actorId);
}

/** Vocal family of an actor from its species and/or id (species wins). Unknown actors use the generic beast set. */
export function vocalFamilyOf(actorId: string | undefined, species?: string): VocalFamily {
  const text = `${species ?? ''} ${actorId ?? ''}`.toLowerCase();
  for (const [family, pattern] of FAMILY_PATTERNS) if (pattern.test(text)) return family;
  return 'beast';
}

/** Material a hit lands on: from the victim's body, or from the struck surface for environment contacts. */
export function impactMaterialOf(cue: StoryCue): ImpactMaterial {
  const surface = (cue.contact?.surfaceId ?? '').toLowerCase();
  if (cue.contact?.kind === 'solid' || cue.contact?.kind === 'ground' || cue.kind === 'projectile-impact') {
    if (/bark|tree|trunk|root/.test(surface)) return 'bark';
    if (/wood|plank|bridge|log|bamboo/.test(surface)) return 'wood';
    return 'stone';
  }
  const family = vocalFamilyOf(cue.targetId);
  if (family === 'rootling') return 'bark';
  return 'flesh';
}

/** Weight class from the engine-confirmed loss (monster attacks use their authored hazard damage when no loss is attached). */
export function impactWeightOf(cue: StoryCue): ImpactWeight {
  const authored = cue.attackId ? ATTACKS[cue.attackId]?.hazard.damage : undefined;
  const damage = cue.confirmedDamage ?? authored ?? (cue.intensity ?? 1) * 10;
  const intensity = cue.intensity ?? 1;
  if (damage >= 22 || intensity >= 2.2) return 'finisher';
  if (damage >= 14) return 'heavy';
  if (damage >= 8) return 'medium';
  return 'light';
}

/** The weapon a hero's melee cue swings, from the cue's element or the clip prefix. */
export function weaponOfCue(cue: StoryCue): WeaponKind {
  const action = String(cue.actionId ?? '');
  if (action.startsWith('vesper')) return 'katana';
  if (action.startsWith('sakda')) return 'fist';
  if (action.startsWith('yara')) return 'staff';
  if (action.startsWith('aren')) return 'glaive';
  if (cue.element === 'umbral') return 'katana';
  if (cue.element === 'ember') return 'fist';
  if (cue.element === 'heartroot') return 'staff';
  return cue.actorId === 'aren' || cue.actorId === undefined ? 'glaive' : 'monster';
}

/**
 * Cues whose physical sound is fully carried by a sample once one has actually started: impacts and blade/fist swings. The old synthesised
 * body of these cues is then skipped; elemental flavour (fire, ice, wind, poison, lightning, ...) and every other kind keep their synth layer.
 */
export function sampleReplacesSynth(cue: StoryCue): boolean {
  if (cue.kind !== 'hit' && cue.kind !== 'slash') return false;
  return cue.element === undefined || cue.element === 'arcane' || cue.element === 'heartroot' || cue.element === 'umbral' || cue.element === 'ember';
}

/** A monster attack with a physical (non-elemental) swing: whoosh on its active window. */
const PHYSICAL_FAMILIES: Readonly<Record<string, true>> = { strike: true, sweep: true };

function reactionRequests(kind: CombatReactionKind | undefined, strength: number): void {
  const s = clamp(strength, 0.2, 1);
  switch (kind) {
    case 'stagger': request(reactionGroupId('stagger'), 0.6 + 0.4 * s); break;
    case 'knockback': request(reactionGroupId('knockback'), 0.65 + 0.35 * s, 1.1 - 0.2 * s); break;
    case 'knockdown': request(reactionGroupId('knockdown'), 0.7 + 0.3 * s, 1, 0.22); break;
    case 'launch': request(reactionGroupId('knockback'), 1, 1.15); request(reactionGroupId('knockdown'), 0.9, 0.95, 0.6); break;
    case 'getup': request(reactionGroupId('getup'), 0.7); break;
    // flinch is carried by the hit sample itself; stun is a snapshot-driven loop plus the poise-break one-shot.
    default: break;
  }
}

/**
 * The sampled sounds a cue triggers, written into a shared scratch array (valid until the next call; callers must not retain it).
 * Returns how many entries are valid. Allocation-free.
 */
export function samplesForCue(cue: StoryCue): number {
  requestCount = 0;
  switch (cue.kind) {
    case 'hit': case 'projectile-impact': {
      if (cue.phase !== 'hit') break;
      if (cue.kind === 'hit' && cue.confirmedDamage !== undefined && cue.confirmedDamage <= 0) break;
      const weight = cue.kind === 'projectile-impact' ? (cue.intensity !== undefined && cue.intensity > 1.2 ? 'heavy' : 'medium') : impactWeightOf(cue);
      request(impactGroupId(impactMaterialOf(cue), weight), clamp(0.7 + 0.3 * (cue.intensity ?? 1), 0.7, 1.15));
      if (weight === 'finisher') request(FINISHER_LAYER_GROUP, 0.9, 1, 0.01);
      break;
    }
    case 'grovebreak':
      request(impactGroupId('bark', 'finisher'), 1);
      request(FINISHER_LAYER_GROUP, 0.9, 0.9, 0.02);
      break;
    case 'landing':
      request(LAND_GROUP, clamp(0.5 + 0.4 * (cue.intensity ?? 1), 0.5, 1));
      break;
    case 'slash':
      if (cue.phase === 'active') {
        const weapon = weaponOfCue(cue);
        const intensity = cue.intensity ?? 1;
        request(weaponGroupId(weapon), clamp(0.6 + 0.25 * intensity, 0.6, 1.1), clamp(1.08 - 0.07 * intensity, 0.85, 1.08));
      }
      break;
    case 'active': case 'pounce': {
      if (cue.kind === 'active' && cue.phase !== 'active') break;
      const family = cue.attackId ? ATTACKS[cue.attackId]?.hazard.kind : undefined;
      const physical = cue.kind === 'pounce' || (family !== undefined && PHYSICAL_FAMILIES[family] === true && cue.element === undefined);
      if (physical) request(weaponGroupId('monster'), 0.75, 1 - 0.05 * clamp(cue.intensity ?? 1, 0, 2));
      break;
    }
    case 'roar-cone':
      if (cue.phase === 'anticipation' || cue.phase === 'commit') request(vocalGroupId(isBossActor(cue.actorId) ? 'giant' : vocalFamilyOf(cue.actorId), 'roar'), 1);
      break;
    case 'reaction-start': reactionRequests(cue.reactionKind, cue.intensity ?? 0.5); break;
    case 'wall-impact': request(reactionGroupId('wall-impact'), clamp(0.6 + 0.4 * (cue.intensity ?? 0.6), 0.6, 1)); break;
    case 'poise-break': request(reactionGroupId('poise-break'), 1); break;
    case 'getup': reactionRequests('getup', cue.intensity ?? 0.5); break;
    case 'storm-talon': {
      // Avian screech on dive start, whoosh during dive, heavy impact + wing beat on strike.
      if (cue.phase === 'anticipation' || cue.phase === 'commit') {
        request(vocalGroupId('avian', 'roar'), clamp(0.7 + 0.3 * (cue.intensity ?? 1), 0.7, 1.05), 0.95);
      } else if (cue.phase === 'active') {
        request(weaponGroupId('monster'), 0.6, 1.1, 0.04);
      } else if (cue.phase === 'hit') {
        request(impactGroupId(impactMaterialOf(cue), 'heavy'), clamp(0.8 + 0.2 * (cue.intensity ?? 1), 0.8, 1.1));
        request(weaponGroupId('monster'), 0.55, 0.7, 0.08);
      }
      break;
    }
    default: break;
  }
  return requestCount;
}

/** Victim hurt vocal for a reaction cue: hostiles grunt on stagger or worse; the player only on a knockdown or launch. */
export function hurtVocalFor(cue: StoryCue): VocalFamily | undefined {
  if (cue.kind !== 'reaction-start' && cue.kind !== 'poise-break') return undefined;
  const victim = cue.targetId ?? cue.actorId;
  const kind = cue.reactionKind;
  if (victim === 'aren') return kind === 'knockdown' || kind === 'launch' ? 'humanoid' : undefined;
  return kind === 'flinch' ? undefined : vocalFamilyOf(victim);
}
