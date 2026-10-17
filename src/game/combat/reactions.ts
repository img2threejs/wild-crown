import type { CombatReactionKind, CombatReactionSnapshot } from '../contracts.js';
import type { AttackDefinition } from './content.js';

/**
 * Physical reaction model shared by the engine, the hero kits and the companions.
 *
 * Every blow carries a {@link HitSpec} (weight class, poise damage, knockback metres). Every victim has a mass class
 * (heroes: `HERO_COMBAT[hero].mass`; monsters: derived from body radius with a few overrides) that scales how far a blow
 * moves it and how much it takes to break its poise. The selection functions below are pure: the engine owns the clocks,
 * the swept displacement and the cues, this module owns the numbers.
 */

export type AttackWeight = 'light' | 'medium' | 'heavy' | 'finisher';
export type WeightClass = 'light' | 'medium' | 'heavy' | 'colossal';

export interface HitSpec {
  readonly weight: AttackWeight;
  /** Poise damage against a hostile's poise bar. */
  readonly poise: number;
  /** Nominal knockback in metres before the victim's mass factor. */
  readonly knockback: number;
  /** A finisher on a light monster throws it through the air before the knockdown. */
  readonly launch?: true;
  /** Breaks the poise of any non-boss victim outright (a control spell or an iai finisher); bosses take {@link BOSS_POISE.controlFraction} of their bar. */
  readonly stun?: true;
  /** Always knocks the victim down, whatever its mass; the caller owns any displacement (Tiger's Wrath slides the target itself). */
  readonly knockdown?: true;
  /** No reaction at all: damage-over-time pulses. */
  readonly inert?: true;
}

export const WEIGHT_RANK: Readonly<Record<AttackWeight, number>> = { light: 0, medium: 1, heavy: 2, finisher: 3 };
/** Base numbers of a weight class and the strength (0..1) its reactions start from. */
export const WEIGHT_DEFAULTS: Readonly<Record<AttackWeight, { readonly poise: number; readonly knockback: number; readonly strength: number }>> = {
  light: { poise: 6, knockback: 0, strength: 0.25 },
  medium: { poise: 12, knockback: 0.7, strength: 0.5 },
  heavy: { poise: 24, knockback: 2, strength: 0.75 },
  finisher: { poise: 40, knockback: 3.2, strength: 1 },
};
export const INERT_HIT: HitSpec = Object.freeze({ weight: 'light', poise: 0, knockback: 0, inert: true });

export function hit(weight: AttackWeight, poise: number = WEIGHT_DEFAULTS[weight].poise, knockback: number = WEIGHT_DEFAULTS[weight].knockback, flags?: { launch?: true; stun?: true; knockdown?: true }): HitSpec {
  return Object.freeze({ weight, poise, knockback, ...flags });
}
export function weightFromDamage(damage: number): AttackWeight {
  return damage <= 9 ? 'light' : damage <= 15 ? 'medium' : damage <= 24 ? 'heavy' : 'finisher';
}
/** The blow a strike without an authored spec deals: weight from its damage, the class defaults for the rest. */
export function defaultHit(damage: number): HitSpec {
  const weight = weightFromDamage(damage);
  return hit(weight);
}

// ---- mass, poise and stun by victim -------------------------------------------------------------------------------------

export interface MassProfile {
  /** Multiplies knockback distance: light bodies fly further. */
  readonly factor: number;
  readonly poise: number;
  readonly stunTicks: number;
}
export const MASS: Readonly<Record<WeightClass, MassProfile>> = {
  light: { factor: 1.3, poise: 30, stunTicks: 90 },
  medium: { factor: 1, poise: 50, stunTicks: 120 },
  heavy: { factor: 0.7, poise: 80, stunTicks: 180 },
  colossal: { factor: 0.4, poise: 120, stunTicks: 150 },
};
/** Bosses: a big poise bar that grows with every break (poise phases), short stuns and super-armour in committed attacks. */
export const BOSS_POISE = Object.freeze({ max: 140, stunTicks: 90, phaseGrowth: 0.35, maxPhases: 3, controlFraction: 0.45 });
/** Hostile poise: damage regenerates after this many world ticks without a hit, refilling the whole bar in `POISE_REGEN_TICKS`. */
export const POISE_REGEN_DELAY = 120;
export const POISE_REGEN_TICKS = 180;
/** Bonus damage multiplier against a stunned hostile. */
export const STUN_DAMAGE_MULTIPLIER = 1.5;
/** Poise damage a wall slam adds to the victim (can complete a poise break). */
export const WALL_IMPACT_POISE = 10;

/** Light monsters by archetype even when their body is wider than a rootling's. */
const MASS_OVERRIDES: Readonly<Record<string, WeightClass>> = {
  'greenwake-sap-stalker': 'light', 'canopy-howler': 'light', 'canopy-hornbill': 'light', 'moonpine-scout': 'light', 'mistveil-heron': 'light',
};
export function massOfActor(archetypeId: string, radius: number, boss: boolean): WeightClass {
  if (boss) return 'colossal';
  const override = MASS_OVERRIDES[archetypeId];
  if (override) return override;
  return radius <= 0.65 ? 'light' : radius <= 1 ? 'medium' : radius <= 1.3 ? 'heavy' : 'colossal';
}
export interface ActorBuild {
  readonly mass: WeightClass;
  readonly poiseMax: number;
  readonly stunTicks: number;
  readonly boss: boolean;
}
export function buildOf(archetypeId: string, radius: number, boss: boolean, poiseBreaks: number): ActorBuild {
  const mass = massOfActor(archetypeId, radius, boss);
  if (boss) return { mass, poiseMax: BOSS_POISE.max * (1 + BOSS_POISE.phaseGrowth * Math.min(poiseBreaks, BOSS_POISE.maxPhases)), stunTicks: BOSS_POISE.stunTicks, boss };
  return { mass, poiseMax: MASS[mass].poise, stunTicks: MASS[mass].stunTicks, boss };
}

/** Reaction tiers a hero absorbs from a blow: a medium hero shrugs off medium blows, a heavy hero one tier of anything above light. */
export function heroTierShield(mass: WeightClass, weight: AttackWeight): number {
  if (weight === 'light') return 0;
  if (mass === 'heavy' || mass === 'colossal') return 1;
  return mass === 'medium' && weight === 'medium' ? 1 : 0;
}

// ---- monster attacks -----------------------------------------------------------------------------------------------

/** Committed body-slam attacks: they bowl a victim over instead of merely knocking it back. */
const FINISHER_ATTACKS = /track-charge|hammering-charge|boar-charge|pride-rush|pack-rush|dive-bomb|spear-dive|bite-lunge|root-rammer-low-wave|chain-pounce|overhead-slam|crown-aspect/;
const attackHitCache = new Map<string, HitSpec>();
/** Weight, poise damage and knockback of one monster attack, derived from its damage and hazard shape; charges and slams are finishers. */
export function monsterAttackHit(def: AttackDefinition): HitSpec {
  const cached = attackHitCache.get(def.id);
  if (cached) return cached;
  let spec: HitSpec;
  if (def.hitIntervalTicks) spec = INERT_HIT;
  else {
    let weight = weightFromDamage(def.hazard.damage);
    if (FINISHER_ATTACKS.test(def.id)) weight = 'finisher';
    const push = def.onHit?.pushMeters;
    // An authored push (wind, shockwave) moves the victim exactly that far: it is a knockback, whatever the damage.
    if (push !== undefined && WEIGHT_RANK[weight] < WEIGHT_RANK.heavy) weight = 'heavy';
    const base = WEIGHT_DEFAULTS[weight];
    const knockback = push ?? (def.hazard.kind === 'wave' && weight !== 'finisher' ? base.knockback * 0.6 : base.knockback);
    spec = hit(weight, base.poise, knockback);
  }
  attackHitCache.set(def.id, spec);
  return spec;
}

// ---- reaction state -----------------------------------------------------------------------------------------------

export const REACTION_TICKS = Object.freeze({
  flinch: 12, stagger: 20, knockbackSettle: 8, knockdownLie: 44, getup: 30, getupIframes: 24, launch: 32,
  /** A knocked-down hero may cancel the lie with a dodge after this many ticks. */
  playerCancelFrom: 30,
});
export const REACTION_RANK: Readonly<Record<CombatReactionKind, number>> = { flinch: 1, stagger: 2, knockback: 3, stun: 4, knockdown: 5, launch: 5, getup: 6 };
/** Reactions a new hit never replaces: the victim is down, airborne, dazed or getting up. */
export function isCommitted(kind: CombatReactionKind): boolean { return kind === 'stun' || kind === 'knockdown' || kind === 'launch' || kind === 'getup'; }

export interface ReactionPlan {
  readonly kind: CombatReactionKind;
  readonly strength: number;
  /** Total metres the body travels along the push direction. */
  readonly travel: number;
  /** Ticks over which the travel is eased out. */
  readonly moveTicks: number;
  readonly durationTicks: number;
  /** Apex (metres) of a launch arc. */
  readonly lift: number;
  /** Cancels the victim's non-armoured attack in its windup/commit. */
  readonly cancelsAttack: boolean;
}
/** Serializable reaction of one actor. Times are on the actor's own clock: simulation ticks for the player, world ticks for everyone else. */
export interface ReactionState {
  kind: CombatReactionKind;
  serial: number;
  startedAt: number;
  durationTicks: number;
  strength: number;
  dirX: number; dirZ: number;
  side: CombatReactionSnapshot['side'];
  travel: number; moveTicks: number; moved: number;
  lift: number;
  /** The start cue (and the attack cancel) has not run yet. */
  pending: boolean;
  cancelsAttack: boolean;
}

/** The actor fields a reaction touches; `CombatActor` satisfies it. */
export interface ReactionActor {
  readonly id: string;
  facing: { x: number; y: number; z: number };
  reactionState?: ReactionState;
  reactionSerial?: number;
  staggerUntil: number;
  recoveringUntil: number;
  actionId: string;
  phase: string;
  normalizedTime: number;
  actionStartedTick: number;
  actionEndsTick: number;
}
/**
 * Starts `plan` on `actor` now (no priority check: callers decide). A monster that cannot act through the reaction has its
 * stagger/recovery timers and `<id>-stagger` action set to the reaction's end, so its AI idles exactly as it does for an interrupt;
 * the engine runs the start cue and the attack cancel on the next reaction update.
 */
export function beginReaction(actor: ReactionActor, plan: ReactionPlan, dirX: number, dirZ: number, now: number, isPlayer: boolean): ReactionState {
  const length = Math.hypot(dirX, dirZ);
  const ux = length > 1e-6 ? dirX / length : -actor.facing.x, uz = length > 1e-6 ? dirZ / length : -actor.facing.z;
  actor.reactionSerial = (actor.reactionSerial ?? 0) + 1;
  const state: ReactionState = {
    kind: plan.kind, serial: actor.reactionSerial, startedAt: now, durationTicks: plan.durationTicks, strength: plan.strength,
    dirX: ux, dirZ: uz, side: sideOf(actor.facing.x, actor.facing.z, ux, uz),
    travel: plan.travel, moveTicks: plan.moveTicks, moved: 0, lift: plan.lift, pending: true, cancelsAttack: plan.cancelsAttack,
  };
  actor.reactionState = state;
  if (!isPlayer && plan.kind !== 'flinch') {
    const until = now + plan.durationTicks;
    actor.staggerUntil = Math.max(actor.staggerUntil, until);
    actor.recoveringUntil = Math.max(actor.recoveringUntil, until);
    actor.actionId = `${actor.id}-stagger`;
    actor.phase = 'recovery';
    actor.normalizedTime = 0;
    actor.actionStartedTick = now;
    actor.actionEndsTick = until;
  }
  return state;
}

export function slideTicks(distance: number): number {
  return Math.round(Math.min(44, Math.max(14, 12 + distance * 8)));
}
export function easeOutCubic(t: number): number {
  const u = 1 - Math.min(1, Math.max(0, t));
  return 1 - u * u * u;
}
/** Launch arc height above the ground at progress `t` of an arc with the given apex. */
export function launchLift(apex: number, t: number): number {
  const u = Math.min(1, Math.max(0, t));
  return 4 * apex * u * (1 - u);
}
export function sideOf(facingX: number, facingZ: number, dirX: number, dirZ: number): CombatReactionSnapshot['side'] {
  // The blow came from the opposite of the push direction.
  const fromX = -dirX, fromZ = -dirZ;
  const forward = fromX * facingX + fromZ * facingZ;
  if (forward >= 0.5) return 'front';
  if (forward <= -0.5) return 'back';
  return fromX * -facingZ + fromZ * facingX >= 0 ? 'right' : 'left';
}

function plan(kind: CombatReactionKind, strength: number, travel: number, cancelsAttack: boolean): ReactionPlan {
  switch (kind) {
    case 'flinch': return { kind, strength, travel: 0, moveTicks: 0, durationTicks: REACTION_TICKS.flinch, lift: 0, cancelsAttack: false };
    case 'stagger': {
      const moveTicks = travel > 0 ? Math.min(14, slideTicks(travel)) : 0;
      return { kind, strength, travel, moveTicks, durationTicks: Math.max(REACTION_TICKS.stagger, moveTicks + 6), lift: 0, cancelsAttack };
    }
    case 'knockback': {
      const moveTicks = slideTicks(travel);
      return { kind, strength, travel, moveTicks, durationTicks: moveTicks + REACTION_TICKS.knockbackSettle, lift: 0, cancelsAttack };
    }
    case 'knockdown': {
      const moveTicks = travel > 0 ? slideTicks(travel) : 0;
      return { kind, strength, travel, moveTicks, durationTicks: moveTicks + REACTION_TICKS.knockdownLie, lift: 0, cancelsAttack };
    }
    case 'launch': return { kind, strength, travel, moveTicks: REACTION_TICKS.launch, durationTicks: REACTION_TICKS.launch, lift: 1.1 + strength * 0.9, cancelsAttack };
    case 'getup': return { kind, strength, travel: 0, moveTicks: 0, durationTicks: REACTION_TICKS.getup, lift: 0, cancelsAttack: false };
    case 'stun': return { kind, strength, travel: 0, moveTicks: 0, durationTicks: 0, lift: 0, cancelsAttack };
  }
}
export function stunPlan(strength: number, ticks: number): ReactionPlan {
  return { kind: 'stun', strength, travel: 0, moveTicks: 0, durationTicks: ticks, lift: 0, cancelsAttack: true };
}
export function getupPlan(strength: number): ReactionPlan { return plan('getup', strength, 0, false); }
export function knockdownLiePlan(strength: number): ReactionPlan { return plan('knockdown', strength, 0, false); }

/** Strength 0..1 of a reaction: the weight's base lifted by how much of the victim's poise bar the blow took. */
export function reactionStrength(weight: AttackWeight, poiseDamage: number, poiseMax: number): number {
  const base = WEIGHT_DEFAULTS[weight].strength;
  return Math.min(1, base + (1 - base) * Math.min(1, poiseDamage / Math.max(1, poiseMax)) * 0.5);
}

/**
 * What an unbroken hostile does when `spec` lands. A colossal body only flinches or staggers; heavy bodies are pushed back
 * but never bowled over; light and medium bodies are knocked down by finishers (light ones launched when the blow launches).
 */
export function planHostileReaction(spec: HitSpec, mass: WeightClass, strength: number, armoured: boolean): ReactionPlan | undefined {
  if (spec.inert) return undefined;
  if (armoured) return plan('flinch', strength, 0, false);
  const distance = spec.knockback * MASS[mass].factor;
  if (spec.knockdown) return mass === 'colossal' ? plan('stagger', strength, Math.min(distance, 0.5), true) : plan('knockdown', strength, distance, true);
  switch (spec.weight) {
    case 'light': return plan('flinch', strength, 0, false);
    case 'medium': return mass === 'colossal' ? plan('flinch', strength, 0, false) : plan('stagger', strength, Math.min(distance, 1), true);
    case 'heavy':
      if (mass === 'colossal') return plan('stagger', strength, Math.min(distance, 0.5), true);
      return distance >= 0.8 ? plan('knockback', strength, distance, true) : plan('stagger', strength, distance, true);
    case 'finisher':
      if (mass === 'colossal') return plan('stagger', strength, Math.min(distance, 0.6), true);
      if (mass === 'heavy') return plan('knockback', strength, distance, true);
      return spec.launch && mass === 'light' ? plan('launch', strength, Math.max(1.2, distance * 0.5), true) : plan('knockdown', strength, distance, true);
  }
}

/** What a hero does when a monster attack of `spec` lands: the weight picks the tier, a heavy hero absorbs one tier, the hero's mass scales the push. */
export function planPlayerReaction(spec: HitSpec, heroMass: WeightClass, airborne: boolean): ReactionPlan | undefined {
  if (spec.inert) return undefined;
  const strength = WEIGHT_DEFAULTS[spec.weight].strength;
  const tiers: readonly CombatReactionKind[] = ['flinch', 'stagger', 'knockback', 'knockdown'];
  let tier = WEIGHT_RANK[spec.weight] - heroTierShield(heroMass, spec.weight);
  if (airborne) tier = Math.min(tier, 2);
  tier = Math.max(0, tier);
  const kind = tiers[Math.min(3, tier)]!;
  const distance = spec.knockback * MASS[heroMass].factor;
  switch (kind) {
    case 'flinch': return plan('flinch', strength, 0, false);
    case 'stagger': return plan('stagger', strength, Math.min(distance, 0.8), true);
    case 'knockback': return plan('knockback', strength, Math.max(distance, 0.8), true);
    default: return plan('knockdown', strength, Math.max(distance, 1), true);
  }
}

// ---- authored player blows ----------------------------------------------------------------------------------------------

/** Aren's Warden Blade, heavies and Sigil; keyed by the engine's strike action id. */
export const AREN_HITS: Readonly<Record<string, HitSpec>> = Object.freeze({
  light_1: hit('light', 6, 0),
  light_2: hit('light', 7, 0),
  light_3: hit('medium', 14, 0.8),
  light_4: hit('finisher', 28, 2.6),
  crescent_wave: hit('light', 5, 0),
  heavy: hit('heavy', 24, 1.8),
  charged_heavy: hit('heavy', 32, 2.4),
  thunder_cleave: hit('finisher', 34, 2.2, { launch: true }),
  sigil_bolt: hit('light', 4, 0),
  ferocity: hit('heavy', 20, 1.6),
  corruption: hit('medium', 14, 0.8),
  judgement: hit('light', 10, 0),
  light: hit('light', 5, 0),
});
/** Yara's heartroot spells: her control skills break poise (the root eruption and the bloom pulse stun). */
export const YARA_HITS: Readonly<Record<string, HitSpec>> = Object.freeze({
  thorn_bolt: hit('light', 5, 0),
  storm_seed: hit('light', 6, 0),
  seed_burst: hit('medium', 10, 0.5),
  root_spike: hit('heavy', 40, 1.5),
  sap_lance: hit('medium', 18, 0.6),
  root_eruption: hit('heavy', 60, 1.4, { stun: true }),
  bloom_meteor: hit('light', 4, 0),
  bloom_pulse: hit('finisher', 60, 2.5, { stun: true }),
});
