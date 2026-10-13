import type { StoryCue } from '../story-cues.js';
import type { VfxElement } from './palette.js';

/**
 * Hero presentation identity tables shared by the cue router (`resolveKit`), the Warden kits and the tests.
 * Aren (Storm Warden) cues are `arcane`/`lightning`; Yara (Heartroot Mage) cues carry `element: 'heartroot'` and resolve to one kit per skill.
 */

// ---- Yara: one kit per skill ----

export type HeartrootKitId =
  | 'heartroot-thorn' | 'heartroot-seed' | 'heartroot-storm' | 'heartroot-sigil' | 'heartroot-lance' | 'heartroot-meteor'
  | 'heartroot-spike' | 'heartroot-eruption' | 'heartroot-bloom' | 'heartroot-petal-step' | 'heartroot-vines' | 'heartroot-cleanse';

const HEARTROOT_KITS: Readonly<Record<HeartrootKitId, true>> = {
  'heartroot-thorn': true, 'heartroot-seed': true, 'heartroot-storm': true, 'heartroot-sigil': true, 'heartroot-lance': true, 'heartroot-meteor': true,
  'heartroot-spike': true, 'heartroot-eruption': true, 'heartroot-bloom': true, 'heartroot-petal-step': true, 'heartroot-vines': true, 'heartroot-cleanse': true,
};
export function isHeartrootKit(kit: string): kit is HeartrootKitId { return Object.hasOwn(HEARTROOT_KITS, kit); }

const PROJECTILE_KITS: Readonly<Record<string, HeartrootKitId>> = { 'thorn-bolt': 'heartroot-thorn', 'bloom-seed': 'heartroot-seed', 'storm-seed': 'heartroot-storm' };
/** Player clip → kit, for hit cues (the clip id travels on `cue.actionId`). */
const CLIP_KITS: Readonly<Record<string, HeartrootKitId>> = {
  'yara-thornshot-1': 'heartroot-thorn', 'yara-thornshot-2': 'heartroot-thorn', 'yara-thornshot-3': 'heartroot-seed',
  'yara-root-spike': 'heartroot-spike', 'yara-root-eruption': 'heartroot-eruption', 'yara-sap-lance': 'heartroot-lance', 'yara-seed-storm': 'heartroot-storm',
  'yara-heartroot-bloom': 'heartroot-bloom', 'yara-bloom-meteor': 'heartroot-meteor', 'yara-binding-vines': 'heartroot-vines', 'yara-cleanse': 'heartroot-cleanse',
};
/** Radius (m) above which a Heartroot `bloom` hit is the final pulse rather than a meteor impact. */
export const BLOOM_PULSE_MIN_RADIUS = 4;

export function resolveHeartrootKit(cue: StoryCue): HeartrootKitId {
  const action = cue.actionId ?? '';
  switch (cue.kind) {
    case 'projectile': case 'projectile-impact': return PROJECTILE_KITS[action] ?? 'heartroot-thorn';
    case 'sigil': return 'heartroot-sigil';
    case 'beam': return action === 'yara-bloom-meteor' ? 'heartroot-meteor' : 'heartroot-lance';
    case 'root-eruption': return cue.from && cue.to ? 'heartroot-spike' : 'heartroot-eruption';
    case 'bloom':
      if (cue.phase !== 'hit') return 'heartroot-bloom';
      if (action === 'yara-root-eruption') return 'heartroot-eruption';
      if (action === 'yara-thornshot-3') return 'heartroot-seed';
      return (cue.footprint?.width ?? 0) / 2 >= BLOOM_PULSE_MIN_RADIUS ? 'heartroot-bloom' : 'heartroot-meteor';
    case 'blink': return 'heartroot-petal-step';
    case 'tether': return 'heartroot-vines';
    case 'cleanse': return 'heartroot-cleanse';
    default: return CLIP_KITS[action] ?? 'heartroot-thorn';
  }
}

/** Presentation weight of each Yara skill's contact: camera shake, target rim flash, light pulse and screen impulse scale together, modestly. */
export interface SkillImpact { readonly shake: number; readonly rim: number; readonly light: number; readonly impulse: number }
export const HEARTROOT_IMPACT: Readonly<Record<HeartrootKitId, SkillImpact>> = {
  'heartroot-thorn': { shake: 0.02, rim: 1.1, light: 0, impulse: 0 },
  'heartroot-seed': { shake: 0.05, rim: 1.2, light: 2.5, impulse: 0.15 },
  'heartroot-storm': { shake: 0.012, rim: 0.9, light: 0, impulse: 0 },
  'heartroot-sigil': { shake: 0, rim: 0, light: 2.2, impulse: 0 },
  'heartroot-lance': { shake: 0.05, rim: 1.3, light: 3, impulse: 0.2 },
  'heartroot-meteor': { shake: 0.03, rim: 1, light: 2, impulse: 0 },
  'heartroot-spike': { shake: 0.06, rim: 1.3, light: 2.8, impulse: 0.1 },
  'heartroot-eruption': { shake: 0.16, rim: 1.4, light: 5, impulse: 0.35 },
  'heartroot-bloom': { shake: 0.22, rim: 1.4, light: 7, impulse: 0.55 },
  'heartroot-petal-step': { shake: 0, rim: 0, light: 0, impulse: 0 },
  'heartroot-vines': { shake: 0.02, rim: 1, light: 0, impulse: 0 },
  'heartroot-cleanse': { shake: 0, rim: 0.8, light: 2.2, impulse: 0 },
};

/** Staff-head sap trail per skill (trail strip intensity, visible seconds, width scale). */
export const HEARTROOT_TRAIL: Readonly<Partial<Record<HeartrootKitId, { readonly intensity: number; readonly life: number; readonly width: number }>>> = {
  'heartroot-thorn': { intensity: 0.8, life: 0.14, width: 0.8 },
  'heartroot-seed': { intensity: 0.95, life: 0.18, width: 1.1 },
  'heartroot-storm': { intensity: 0.8, life: 0.2, width: 0.9 },
  'heartroot-spike': { intensity: 1.1, life: 0.2, width: 1.2 },
  'heartroot-eruption': { intensity: 1.3, life: 0.26, width: 1.4 },
  'heartroot-lance': { intensity: 0.95, life: 0.18, width: 0.9 },
  'heartroot-bloom': { intensity: 1, life: 0.3, width: 1.3 },
  'heartroot-vines': { intensity: 0.9, life: 0.2, width: 1 },
};

// ---- Aren: light steps ----

export interface LightStep {
  /** Blade-trail element, brightness, visible seconds and strip width scale. */
  readonly trail: VfxElement;
  readonly intensity: number;
  readonly life: number;
  readonly width: number;
  /** Wind-blade crescents spawned with the swing: height at the start/end of travel (m), chord (m), travel length (m), count, spread (rad) between blades. */
  readonly blade?: { readonly y0: number; readonly y1: number; readonly chord: number; readonly reach: number; readonly count: number; readonly spread: number };
  /** Rune motes launched along the swing, and whether they orbit the caster (spin) or rise/fall along the arc. */
  readonly motes: number;
  readonly motePath: 'sweep' | 'rise' | 'orbit' | 'fall';
}

/** Each Aren combo step has its own trail look, blade shape and rune-mote path (keys are the player clip ids). */
export const LIGHT_STEPS: Readonly<Record<string, LightStep>> = {
  'aren-light-1': { trail: 'arcane', intensity: 1, life: 0.14, width: 1.5, blade: { y0: 0.9, y1: 0.9, chord: 2.6, reach: 3.2, count: 1, spread: 0 }, motes: 5, motePath: 'sweep' },
  'aren-light-2': { trail: 'lightning', intensity: 1.15, life: 0.18, width: 0.8, blade: { y0: 0.5, y1: 1.9, chord: 1.7, reach: 3, count: 1, spread: 0 }, motes: 8, motePath: 'rise' },
  'aren-light-3': { trail: 'arcane', intensity: 1.3, life: 0.26, width: 1.1, blade: { y0: 1, y1: 1, chord: 1.9, reach: 2.4, count: 2, spread: Math.PI }, motes: 10, motePath: 'orbit' },
  'aren-light-4': { trail: 'lightning', intensity: 1.45, life: 0.2, width: 1.9, blade: { y0: 2.3, y1: 0.25, chord: 1.5, reach: 1.9, count: 1, spread: 0 }, motes: 8, motePath: 'fall' },
};

/** Aren cue kinds whose actions are the cleanse / root-tether skills (the router keeps story tethers on the generic beam). */
export const AREN_CLEANSE_ACTION = 'aren-cleanse';
export const AREN_TETHER_ACTION = 'aren-root-tether';

// ---- Vesper (umbral) and Sakda (ember): one kit per skill, resolved from (kind, actionId) ----

export type UmbralKitId =
  | 'umbral-iai' | 'umbral-rift' | 'umbral-step' | 'umbral-cuts' | 'umbral-kunai' | 'umbral-shade'
  | 'umbral-mist' | 'umbral-requiem' | 'umbral-sever' | 'umbral-cleanse';
export type EmberKitId =
  | 'ember-limbs' | 'ember-roundhouse' | 'ember-echo' | 'ember-resonate' | 'ember-elbows' | 'ember-tempest'
  | 'ember-knee' | 'ember-guard' | 'ember-wrath' | 'ember-clinch' | 'ember-cleanse';

const UMBRAL_KITS: Readonly<Record<UmbralKitId, true>> = {
  'umbral-iai': true, 'umbral-rift': true, 'umbral-step': true, 'umbral-cuts': true, 'umbral-kunai': true, 'umbral-shade': true,
  'umbral-mist': true, 'umbral-requiem': true, 'umbral-sever': true, 'umbral-cleanse': true,
};
const EMBER_KITS: Readonly<Record<EmberKitId, true>> = {
  'ember-limbs': true, 'ember-roundhouse': true, 'ember-echo': true, 'ember-resonate': true, 'ember-elbows': true, 'ember-tempest': true,
  'ember-knee': true, 'ember-guard': true, 'ember-wrath': true, 'ember-clinch': true, 'ember-cleanse': true,
};
export function isUmbralKit(kit: string): kit is UmbralKitId { return Object.hasOwn(UMBRAL_KITS, kit); }
export function isEmberKit(kit: string): kit is EmberKitId { return Object.hasOwn(EMBER_KITS, kit); }

/** Vesper clip id → the kit that owns its look (every id in the contract; charge clips belong to the skill they charge). */
const UMBRAL_CLIP_KITS: Readonly<Record<string, UmbralKitId>> = {
  'vesper-iai-1': 'umbral-iai', 'vesper-iai-2': 'umbral-iai', 'vesper-iai-3': 'umbral-iai', 'vesper-iai-4': 'umbral-rift',
  'vesper-shadow-step': 'umbral-step', 'vesper-cuts-charge': 'umbral-cuts', 'vesper-thousand-cuts': 'umbral-cuts',
  'vesper-kunai-fan': 'umbral-kunai', 'vesper-shade-charge': 'umbral-shade', 'vesper-shade-swap': 'umbral-shade',
  'vesper-severing-shadow': 'umbral-sever', 'vesper-cleanse': 'umbral-cleanse', 'vesper-mist-blink': 'umbral-mist', 'vesper-requiem': 'umbral-requiem',
};
const EMBER_CLIP_KITS: Readonly<Record<string, EmberKitId>> = {
  'sakda-limb-1': 'ember-limbs', 'sakda-limb-2': 'ember-limbs', 'sakda-limb-3': 'ember-limbs', 'sakda-limb-4': 'ember-roundhouse',
  'sakda-echo-wave': 'ember-echo', 'sakda-resonating-strike': 'ember-resonate', 'sakda-elbow-charge': 'ember-elbows', 'sakda-hundred-elbows': 'ember-elbows',
  'sakda-tempest': 'ember-tempest', 'sakda-knee-charge': 'ember-knee', 'sakda-flying-knee': 'ember-knee', 'sakda-iron-clinch': 'ember-clinch',
  'sakda-cleanse': 'ember-cleanse', 'sakda-guard-dash': 'ember-guard', 'sakda-tigers-wrath': 'ember-wrath',
};
export const UMBRAL_CLIPS: readonly string[] = Object.keys(UMBRAL_CLIP_KITS);
export const EMBER_CLIPS: readonly string[] = Object.keys(EMBER_CLIP_KITS);

/** Kit of a Vesper cue. The clip id decides the skill; the cue kind only breaks ties for ids that carry no skill (the shared dodge ids → Mist Blink). */
export function resolveUmbralKit(cue: StoryCue): UmbralKitId {
  const clip = UMBRAL_CLIP_KITS[cue.actionId ?? ''];
  if (clip) return clip;
  switch (cue.kind) {
    case 'blink': case 'perfect-dodge': return 'umbral-mist';
    case 'tether': return 'umbral-sever';
    case 'cleanse': return 'umbral-cleanse';
    case 'projectile': case 'projectile-impact': return 'umbral-kunai';
    case 'judgement': case 'judgement-mark': return 'umbral-requiem';
    case 'beam': return 'umbral-rift';
    default: return 'umbral-iai';
  }
}

/** Kit of a Sakda cue (see `resolveUmbralKit`; the shared dodge ids → Guard Dash). */
export function resolveEmberKit(cue: StoryCue): EmberKitId {
  const clip = EMBER_CLIP_KITS[cue.actionId ?? ''];
  if (clip) return clip;
  switch (cue.kind) {
    case 'blink': case 'perfect-dodge': return 'ember-guard';
    case 'tether': return 'ember-clinch';
    case 'cleanse': return 'ember-cleanse';
    case 'projectile': case 'projectile-impact': return 'ember-echo';
    default: return 'ember-limbs';
  }
}

/** Contact weight of every Vesper / Sakda kit (same scale as `HEARTROOT_IMPACT`). */
export const UMBRAL_IMPACT: Readonly<Record<UmbralKitId, SkillImpact>> = {
  'umbral-iai': { shake: 0.025, rim: 1.1, light: 1.6, impulse: 0.05 },
  'umbral-rift': { shake: 0.08, rim: 1.4, light: 3, impulse: 0.25 },
  'umbral-step': { shake: 0.05, rim: 1.3, light: 2.4, impulse: 0.15 },
  'umbral-cuts': { shake: 0.02, rim: 1, light: 1.4, impulse: 0 },
  'umbral-kunai': { shake: 0.012, rim: 0.9, light: 0, impulse: 0 },
  'umbral-shade': { shake: 0.06, rim: 1.3, light: 2.6, impulse: 0.2 },
  'umbral-mist': { shake: 0, rim: 0, light: 1.2, impulse: 0 },
  'umbral-requiem': { shake: 0.2, rim: 1.5, light: 6, impulse: 0.6 },
  'umbral-sever': { shake: 0.05, rim: 1.3, light: 2.2, impulse: 0.15 },
  'umbral-cleanse': { shake: 0, rim: 0.8, light: 2, impulse: 0 },
};
export const EMBER_IMPACT: Readonly<Record<EmberKitId, SkillImpact>> = {
  'ember-limbs': { shake: 0.03, rim: 1.1, light: 1.8, impulse: 0.05 },
  'ember-roundhouse': { shake: 0.13, rim: 1.4, light: 4.5, impulse: 0.35 },
  'ember-echo': { shake: 0.04, rim: 1.1, light: 2.4, impulse: 0.12 },
  'ember-resonate': { shake: 0.14, rim: 1.4, light: 4.5, impulse: 0.4 },
  'ember-elbows': { shake: 0.025, rim: 1.1, light: 1.6, impulse: 0.04 },
  'ember-tempest': { shake: 0.16, rim: 1.4, light: 5, impulse: 0.35 },
  'ember-knee': { shake: 0.2, rim: 1.5, light: 6, impulse: 0.5 },
  'ember-guard': { shake: 0, rim: 0, light: 1.8, impulse: 0 },
  'ember-wrath': { shake: 0.26, rim: 1.5, light: 7, impulse: 0.7 },
  'ember-clinch': { shake: 0.05, rim: 1.3, light: 2.4, impulse: 0.15 },
  'ember-cleanse': { shake: 0, rim: 0.8, light: 2.2, impulse: 0 },
};

/** Katana trail per Vesper kit (trail strip intensity, visible seconds, width scale) while the blade is live. */
export const UMBRAL_TRAIL: Readonly<Partial<Record<UmbralKitId, { readonly intensity: number; readonly life: number; readonly width: number }>>> = {
  'umbral-iai': { intensity: 1.15, life: 0.12, width: 0.55 },
  'umbral-rift': { intensity: 1.5, life: 0.22, width: 0.9 },
  'umbral-step': { intensity: 1.3, life: 0.16, width: 0.7 },
  'umbral-cuts': { intensity: 1.2, life: 0.1, width: 0.55 },
  'umbral-requiem': { intensity: 1.4, life: 0.14, width: 0.7 },
  'umbral-sever': { intensity: 1.2, life: 0.16, width: 0.7 },
};

/** Vesper clips during which the katana edge leaves a blade trail (snapshot-driven, for strikes the engine sends no slash cue for). */
export const VESPER_BLADE_CLIPS: Readonly<Record<string, true>> = {
  'vesper-iai-1': true, 'vesper-iai-2': true, 'vesper-iai-3': true, 'vesper-iai-4': true, 'vesper-shadow-step': true,
  'vesper-thousand-cuts': true, 'vesper-severing-shadow': true, 'vesper-requiem': true,
};

/** Limb sockets of the unarmed hero, in `HeroStateFx` order: fist-left, fist-right, foot-left, foot-right. */
export const SAKDA_LIMBS = ['fist-left', 'fist-right', 'foot-left', 'foot-right'] as const;
/** Bit mask of the limbs that strike during each Sakda clip (1 = left fist, 2 = right fist, 4 = left foot, 8 = right foot). */
export const SAKDA_LIMB_MASKS: Readonly<Record<string, number>> = {
  'sakda-limb-1': 3, 'sakda-limb-2': 2, 'sakda-limb-3': 8, 'sakda-limb-4': 4,
  'sakda-echo-wave': 3, 'sakda-resonating-strike': 10, 'sakda-hundred-elbows': 3, 'sakda-tempest': 8,
  'sakda-flying-knee': 8, 'sakda-iron-clinch': 3, 'sakda-tigers-wrath': 12, 'sakda-guard-dash': 3,
};
