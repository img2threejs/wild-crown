import { describe, expect, it } from 'bun:test';
import type { ActorId } from '../../src/game/contracts.js';
import { CombatEngine } from '../../src/game/combat/CombatEngine.js';
import { ATTACKS } from '../../src/game/combat/content.js';
import { vec } from '../../src/game/combat/geometry.js';
import { HERO_COMBAT } from '../../src/game/combat/HeroProfiles.js';
import { LIGHT_ASSIST_RANGE, LIGHT_STEPS } from '../../src/game/combat/PlayerSkills.js';
import {
  AREN_HITS, BOSS_POISE, MASS, POISE_REGEN_DELAY, POISE_REGEN_TICKS, REACTION_TICKS, STUN_DAMAGE_MULTIPLIER, WALL_IMPACT_POISE, YARA_HITS, buildOf, easeOutCubic, hit, massOfActor,
  monsterAttackHit, planHostileReaction, planPlayerReaction, slideTicks, sideOf, weightFromDamage, type AttackWeight, type HitSpec, type WeightClass,
} from '../../src/game/combat/reactions.js';
import { SAKDA_HITS } from '../../src/game/combat/SakdaSkills.js';
import { VESPER_HITS } from '../../src/game/combat/VesperSkills.js';
import { reactionRig, type ReactionRig } from './reaction-rig.js';

const horizontal = (from: { x: number; z: number }, to: { x: number; z: number }): number => Math.hypot(to.x - from.x, to.z - from.z);
/** Steps until the monster's reaction has finished (or a safety bound), returning the ticks stepped. */
function settle(rig: ReactionRig, max = 400): number {
  let ticks = 0;
  while (rig.monster().reactionState && ticks < max) { rig.step(); ticks++; }
  return ticks;
}
/** A live hazard on the hero for `delay` ticks from now: the engine's own beginAttack path with the attack's real shape. */
function charge(rig: ReactionRig, attackId: string): void {
  expect(rig.internals.beginAttack(rig.monster(), ATTACKS[attackId]!)).toBeDefined();
}

describe('weights, mass and plans', () => {
  it('derives a weight, poise damage and knockback for every authored monster attack', () => {
    const weights: readonly AttackWeight[] = ['light', 'medium', 'heavy', 'finisher'];
    for (const [id, definition] of Object.entries(ATTACKS)) {
      const spec = monsterAttackHit(definition);
      expect(weights).toContain(spec.weight);
      expect(spec.poise).toBeGreaterThanOrEqual(0);
      expect(spec.knockback).toBeGreaterThanOrEqual(0);
      if (definition.hitIntervalTicks) expect(spec.inert).toBe(true);
      else if (definition.onHit?.pushMeters !== undefined) {
        // An authored push is a knockback of exactly that distance.
        expect(spec.knockback).toBe(definition.onHit.pushMeters);
        expect(['heavy', 'finisher']).toContain(spec.weight);
      } else expect(spec.weight === 'light' ? definition.hazard.damage <= 9 : true).toBe(true);
      expect(id).toBe(definition.id);
    }
    expect(monsterAttackHit(ATTACKS['boar-charge']!).weight).toBe('finisher');
    expect(monsterAttackHit(ATTACKS['root-rammer-low-wave']!).weight).toBe('finisher');
    expect(monsterAttackHit(ATTACKS['koro-fruit-burst']!).weight).toBe('medium');
    expect(monsterAttackHit(ATTACKS['viper-venom-spit']!).inert).toBe(true);
    expect(weightFromDamage(9)).toBe('light');
    expect(weightFromDamage(16)).toBe('heavy');
    expect(weightFromDamage(30)).toBe('finisher');
  });

  it('classifies mass by archetype and body, bosses as colossal with a poise bar that grows with every break', () => {
    expect(massOfActor('corrupted-boar', 1.05, false)).toBe('heavy');
    expect(massOfActor('greenwake-root-rammer', 1.2, false)).toBe('heavy');
    expect(massOfActor('greenwake-sap-stalker', 0.9, false)).toBe('light');
    expect(massOfActor('grove-sprig', 0.6, false)).toBe('light');
    expect(massOfActor('canopy-mire-viper', 1, false)).toBe('medium');
    expect(massOfActor('mistveil-ghor', 2, false)).toBe('colossal');
    expect(massOfActor('anything', 1, true)).toBe('colossal');
    const bars = [0, 1, 2, 3, 4].map(breaks => buildOf('koro', 1, true, breaks).poiseMax);
    expect(bars[0]).toBe(BOSS_POISE.max);
    expect(bars[1]).toBeCloseTo(BOSS_POISE.max * 1.35, 9);
    expect(bars[3]).toBe(bars[4]);
    expect(buildOf('koro', 1, true, 0).stunTicks).toBe(BOSS_POISE.stunTicks);
    for (const mass of ['light', 'medium', 'heavy'] as const) expect(buildOf('x', mass === 'light' ? 0.5 : mass === 'medium' ? 0.9 : 1.2, false, 0).stunTicks).toBe(MASS[mass].stunTicks);
    expect(MASS.light.stunTicks).toBe(90);
    expect(MASS.heavy.stunTicks).toBe(180);
    expect(HERO_COMBAT.aren.mass).toBe('medium');
    expect(HERO_COMBAT.sakda.mass).toBe('heavy');
    expect(HERO_COMBAT.vesper.mass).toBe('light');
    expect(HERO_COMBAT.yara.mass).toBe('light');
  });

  it('picks the hostile reaction from weight and mass: flinch, stagger, knockback, knockdown, launch; armour leaves a flinch', () => {
    const kind = (spec: HitSpec, mass: WeightClass, armoured = false) => planHostileReaction(spec, mass, 0.5, armoured)?.kind;
    expect(kind(hit('light'), 'light')).toBe('flinch');
    expect(kind(hit('medium'), 'medium')).toBe('stagger');
    expect(kind(hit('medium'), 'colossal')).toBe('flinch');
    expect(kind(hit('heavy'), 'light')).toBe('knockback');
    expect(kind(hit('heavy'), 'heavy')).toBe('knockback');
    expect(kind(hit('heavy', 24, 1), 'heavy')).toBe('stagger');
    expect(kind(hit('heavy'), 'colossal')).toBe('stagger');
    expect(kind(hit('finisher'), 'light')).toBe('knockdown');
    expect(kind(hit('finisher'), 'medium')).toBe('knockdown');
    expect(kind(hit('finisher'), 'heavy')).toBe('knockback');
    expect(kind(hit('finisher'), 'colossal')).toBe('stagger');
    expect(kind(hit('finisher', 40, 3, { launch: true }), 'light')).toBe('launch');
    expect(kind(hit('finisher', 40, 3, { launch: true }), 'medium')).toBe('knockdown');
    expect(kind(hit('light', 6, 0, { knockdown: true }), 'heavy')).toBe('knockdown');
    expect(kind(hit('finisher'), 'light', true)).toBe('flinch');
    expect(planHostileReaction({ weight: 'light', poise: 0, knockback: 0, inert: true }, 'light', 0.5, false)).toBeUndefined();
    // Light bodies fly further than heavy ones for the same blow, between 0.8 and 4 m for a knockback.
    const far = planHostileReaction(hit('heavy'), 'light', 0.5, false)!.travel, near = planHostileReaction(hit('heavy'), 'heavy', 0.5, false)!.travel;
    expect(far).toBeGreaterThan(near);
    expect(planHostileReaction(hit('finisher'), 'light', 1, false)!.travel).toBeLessThanOrEqual(4.2);
    expect(near).toBeGreaterThanOrEqual(0.8);
  });

  it('scales a monster blow by the hero weight class: light heroes fall, medium heroes shrug off medium blows, heavy heroes absorb a tier', () => {
    const kind = (spec: HitSpec, hero: WeightClass, airborne = false) => planPlayerReaction(spec, hero, airborne)?.kind;
    expect(['light', 'medium', 'heavy'].map(mass => kind(hit('light'), mass as WeightClass))).toEqual(['flinch', 'flinch', 'flinch']);
    expect(['light', 'medium', 'heavy'].map(mass => kind(hit('medium'), mass as WeightClass))).toEqual(['stagger', 'flinch', 'flinch']);
    expect(['light', 'medium', 'heavy'].map(mass => kind(hit('heavy'), mass as WeightClass))).toEqual(['knockback', 'knockback', 'stagger']);
    expect(['light', 'medium', 'heavy'].map(mass => kind(hit('finisher'), mass as WeightClass))).toEqual(['knockdown', 'knockdown', 'knockback']);
    expect(kind(hit('finisher'), 'light', true)).toBe('knockback');
    expect(planPlayerReaction({ weight: 'heavy', poise: 0, knockback: 2, inert: true }, 'light', false)).toBeUndefined();
    // The same push carries a light hero further than a medium one.
    expect(planPlayerReaction(hit('heavy'), 'light', false)!.travel).toBeGreaterThan(planPlayerReaction(hit('heavy'), 'medium', false)!.travel);
  });

  it('eases out, slides longer for longer pushes, and reports the hit side relative to the victim facing', () => {
    let last = 0;
    for (let tick = 1; tick <= 20; tick++) {
      const value = easeOutCubic(tick / 20);
      expect(value - last).toBeLessThan(0.3);
      if (tick > 1) expect(value - last).toBeLessThanOrEqual(last - easeOutCubic((tick - 2) / 20) + 1e-12);
      last = value;
    }
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(slideTicks(0.8)).toBeLessThan(slideTicks(3));
    expect(slideTicks(100)).toBe(44);
    // Facing -z (0,-1): pushed towards +z means the blow came from the front.
    expect(sideOf(0, -1, 0, 1)).toBe('front');
    expect(sideOf(0, -1, 0, -1)).toBe('back');
    expect(sideOf(0, -1, -1, 0)).toBe('right');
    expect(sideOf(0, -1, 1, 0)).toBe('left');
  });

  it('authors every hero blow: Aren finishes with a knockback, Sakda and Vesper climb through flinch, stagger, knockdown and stun, Yara breaks poise', () => {
    expect(AREN_HITS.light_1!.weight).toBe('light');
    expect(AREN_HITS.light_4!.weight).toBe('finisher');
    expect(AREN_HITS.thunder_cleave!.launch).toBe(true);
    expect(SAKDA_HITS.limbs.map(spec => spec.weight)).toEqual(['light', 'medium', 'heavy', 'finisher']);
    expect(SAKDA_HITS.wrath.knockdown).toBe(true);
    expect(SAKDA_HITS.uppercut.weight).toBe('finisher');
    expect(VESPER_HITS.iai.map(spec => spec.weight)).toEqual(['light', 'light', 'medium', 'finisher']);
    expect(VESPER_HITS.iai[3]!.stun).toBe(true);
    expect(YARA_HITS.root_eruption!.stun).toBe(true);
    expect(YARA_HITS.bloom_pulse!.stun).toBe(true);
    // The light steps of the engine's own combo lunge no further than 1.2 m and the finisher lunges furthest.
    expect(LIGHT_STEPS).toHaveLength(4);
  });
});

describe('monster reactions in the engine', () => {
  it('flinches on a light hit without moving, then clears after 12 world ticks', () => {
    const rig = reactionRig();
    const from = { ...rig.monster().position };
    rig.strike(AREN_HITS.light_1!);
    expect(rig.snapshotMonster().reaction).toMatchObject({ kind: 'flinch', durationTicks: 12, progress: 0, serial: 1 });
    expect(rig.snapshotMonster().reaction!.direction).toMatchObject({ y: 0 });
    expect(Math.hypot(rig.snapshotMonster().reaction!.direction.x, rig.snapshotMonster().reaction!.direction.z)).toBeCloseTo(1, 9);
    // The boar faces away from the hero (-z), so the blow lands on its back.
    expect(rig.snapshotMonster().reaction!.side).toBe('back');
    rig.step({}, 12);
    expect(rig.snapshotMonster().reaction).toBeUndefined();
    expect(horizontal(from, rig.monster().position)).toBe(0);
    expect(rig.cuesOf('reaction-start')[0]).toMatchObject({ reactionKind: 'flinch', actorId: rig.monsterId, targetId: rig.monsterId });
  });

  it('staggers on a medium hit with a short slide scaled by mass and locks the monster for the reaction', () => {
    const rig = reactionRig({ stage: 0 });
    const from = { ...rig.monster().position };
    rig.monster().staggerUntil = 0;
    rig.strike(hit('medium', 12, 0.7));
    const reaction = rig.snapshotMonster().reaction!;
    expect(reaction.kind).toBe('stagger');
    expect(rig.monster().staggerUntil).toBeGreaterThanOrEqual(rig.state.worldTick + reaction.durationTicks);
    expect(rig.monster().recoveringUntil).toBeGreaterThanOrEqual(rig.state.worldTick + reaction.durationTicks);
    settle(rig);
    // Boar is heavy: 0.7 m x 0.7.
    expect(horizontal(from, rig.monster().position)).toBeCloseTo(0.7 * MASS.heavy.factor, 2);
  });

  it('knocks back with an eased, decelerating slide away from the attacker that ends where the plan says', () => {
    const rig = reactionRig({ stage: 0 });
    const start = { ...rig.monster().position };
    rig.strike(hit('heavy', 24, 2));
    const reaction = rig.monster().reactionState!;
    expect(reaction.kind).toBe('knockback');
    expect(reaction.travel).toBeCloseTo(2 * MASS.heavy.factor, 9);
    expect(reaction.durationTicks).toBe(slideTicks(reaction.travel) + REACTION_TICKS.knockbackSettle);
    const steps: number[] = [];
    let previous = rig.monster().position.z;
    for (let tick = 0; tick < reaction.durationTicks; tick++) {
      rig.step();
      steps.push(previous - rig.monster().position.z);
      previous = rig.monster().position.z;
    }
    // The player stands on +z, so the boar slides towards -z: every step moves away, no step grows (ease-out), none moves sideways.
    for (let i = 1; i < steps.length; i++) expect(steps[i]!).toBeLessThanOrEqual(steps[i - 1]! + 1e-9);
    expect(steps[0]!).toBeGreaterThan(steps[1]!);
    expect(steps.slice(1, 6).every(step => step > 0)).toBe(true);
    expect(rig.monster().position.x).toBeCloseTo(start.x, 9);
    expect(start.z - rig.monster().position.z).toBeCloseTo(reaction.travel, 3);
    expect(rig.monster().reactionState).toBeUndefined();
    expect(rig.monster().velocity).toEqual(vec(0, 0, 0));
  });

  it('stops a knockback at a wall: swept, shortened, with a wall-impact cue and poise damage', () => {
    // Boar body radius 1.05, wall face 2.4 m behind its start: it can slide 1.35 m of the 2.8 m planned.
    const rig = reactionRig({ stage: 0, walls: [{ offset: vec(0, 1, -3.4), half: vec(3, 1, 1) }] });
    const start = { ...rig.monster().position };
    rig.strike(hit('heavy', 24, 4));
    const planned = rig.monster().reactionState!.durationTicks;
    expect(rig.monster().reactionState!.travel).toBeCloseTo(2.8, 9);
    const poiseBefore = rig.monster().poiseMeter!;
    settle(rig);
    const travelled = start.z - rig.monster().position.z;
    expect(travelled).toBeGreaterThan(1.2);
    expect(travelled).toBeLessThanOrEqual(1.35 + 1e-6);
    const impacts = rig.cuesOf('wall-impact');
    expect(impacts).toHaveLength(1);
    expect(impacts[0]).toMatchObject({ reactionKind: 'knockback', actorId: rig.monsterId });
    expect(impacts[0]!.contact?.kind).toBe('solid');
    expect(rig.monster().poiseMeter!).toBeGreaterThanOrEqual(poiseBefore + WALL_IMPACT_POISE - POISE_REGEN_TICKS);
    // Ended early: the slide's ease would have taken `planned` ticks.
    expect(rig.state.worldTick).toBeLessThan(planned + 60);
    // Nothing is left of the plan.
    expect(rig.monster().reactionState).toBeUndefined();
  });

  it('knocks a light monster down, lets it lie 44+ ticks, and gives the get-up brief i-frames', () => {
    const rig = reactionRig({ stage: 1 });
    rig.strike(hit('finisher', 40, 3));
    const down = rig.monster().reactionState!;
    expect(down.kind).toBe('knockdown');
    expect(down.durationTicks).toBe(slideTicks(down.travel) + REACTION_TICKS.knockdownLie);
    expect(REACTION_TICKS.knockdownLie).toBeGreaterThanOrEqual(40);
    // Lying monsters are still hurt, but a second blow does not replace the reaction.
    rig.step({}, 4);
    const lying = rig.strike(hit('light', 6, 0), 5);
    expect(lying).toBe(5);
    expect(rig.monster().reactionState!.serial).toBe(down.serial);
    rig.step({}, down.durationTicks);
    const rise = rig.monster().reactionState!;
    expect(rise.kind).toBe('getup');
    expect(rise.serial).toBe(down.serial + 1);
    expect(rise.durationTicks).toBe(REACTION_TICKS.getup);
    expect(rig.cuesOf('getup')).toHaveLength(1);
    const before = rig.monster().vitality!;
    expect(rig.strike(hit('light', 6, 0), 7)).toBe(0);
    expect(rig.monster().vitality).toBe(before);
    rig.step({}, REACTION_TICKS.getupIframes);
    expect(rig.strike(hit('light', 6, 0), 7)).toBe(7);
    expect(rig.monster().reactionState?.kind).toBe('getup');
    rig.step({}, REACTION_TICKS.getup);
    expect(rig.monster().reactionState).toBeUndefined();
  });

  it('launches a light monster on a heavy finisher: a vertical arc above the unmoved ground position, then the knockdown', () => {
    const rig = reactionRig({ stage: 1 });
    const groundY = rig.monster().position.y;
    rig.strike(AREN_HITS.thunder_cleave!);
    expect(rig.monster().reactionState!.kind).toBe('launch');
    let peak = 0;
    for (let tick = 0; tick < REACTION_TICKS.launch; tick++) {
      rig.step();
      const reaction = rig.snapshotMonster().reaction;
      if (reaction?.kind === 'launch') {
        expect(reaction.lift).toBeGreaterThanOrEqual(0);
        peak = Math.max(peak, reaction.lift!);
        expect(rig.monster().position.y).toBe(groundY);
      }
    }
    expect(peak).toBeGreaterThan(1);
    expect(rig.monster().reactionState?.kind).toBe('knockdown');
    expect(rig.snapshotMonster().reaction!.lift).toBeUndefined();
    rig.step({}, rig.monster().reactionState!.durationTicks);
    expect(rig.monster().reactionState?.kind).toBe('getup');
  });

  it('staggers a winding-up monster: its attack is cancelled cleanly (hazard closed, telegraph gone, cue and event out)', () => {
    const rig = reactionRig({ stage: 1, frozen: false });
    rig.monster().staggerUntil = 0;
    rig.monster().recoveringUntil = 0;
    const hazard = rig.internals.beginAttack(rig.monster(), ATTACKS['sap-vein-snap']!)!;
    rig.step({}, 3);
    expect(rig.snapshotMonster().attackPhase).toBe('windup');
    rig.strike(hit('medium', 12, 0.7));
    expect(rig.monster().reactionState!.kind).toBe('stagger');
    expect(rig.state.telegraphs.some(telegraph => telegraph.sourceId === rig.monsterId)).toBe(false);
    expect(hazard.activeUntil).toBeLessThanOrEqual(rig.state.worldTick);
    expect(hazard.recoveryUntil).toBeLessThanOrEqual(rig.state.worldTick);
    rig.step();
    expect(rig.state.hazards.some(live => live.id === hazard.id)).toBe(false);
    expect(rig.events.some(event => event.kind === 'attack-interrupted' && event.targetId === rig.monsterId)).toBe(true);
    expect(rig.cues.some(cue => cue.kind === 'cancel' && cue.scopeId === hazard.id && cue.cancellationReason === 'interrupt')).toBe(true);
    // The staggered monster cannot start another cast until the reaction is over.
    expect(rig.monster().recoveringUntil).toBeGreaterThan(rig.state.worldTick);
  });

  it('does not stagger a monster mid-swing: an active attack only flinches and survives', () => {
    const rig = reactionRig({ stage: 1, frozen: false });
    rig.monster().staggerUntil = 0;
    rig.monster().recoveringUntil = 0;
    const hazard = rig.internals.beginAttack(rig.monster(), ATTACKS['sap-vein-snap']!)!;
    while (rig.state.worldTick < hazard.activeFrom) rig.step();
    expect(rig.snapshotMonster().attackPhase).toBe('active');
    rig.strike(hit('finisher', 40, 3));
    expect(rig.monster().reactionState!.kind).toBe('flinch');
    expect(rig.state.hazards.some(live => live.id === hazard.id)).toBe(true);
  });

  it('breaks poise into a stun: 120-180 ticks by size, +50% damage taken, poise reads full then drains, and the bar resets after the stun', () => {
    const rig = reactionRig({ stage: 0 });
    // Boar: heavy mass, 80 poise.
    expect(rig.strike(hit('light', 40, 0))).toBe(1);
    expect(rig.snapshotMonster().poise).toBeCloseTo(0.5, 9);
    expect(rig.monster().reactionState!.kind).toBe('flinch');
    rig.strike(hit('light', 40, 0));
    const stun = rig.monster().reactionState!;
    expect(stun.kind).toBe('stun');
    expect(stun.durationTicks).toBe(MASS.heavy.stunTicks);
    expect(rig.cuesOf('poise-break')).toHaveLength(1);
    expect(rig.cuesOf('poise-break')[0]).toMatchObject({ reactionKind: 'stun', actorId: rig.monsterId });
    expect(rig.snapshotMonster().poise).toBe(1);
    // A stunned monster takes the bonus, never a second reaction, and cannot act.
    const before = rig.monster().vitality!;
    rig.strike(hit('heavy', 24, 2), 10);
    expect(before - rig.monster().vitality!).toBe(Math.ceil(10 * STUN_DAMAGE_MULTIPLIER));
    expect(rig.monster().reactionState!.serial).toBe(stun.serial);
    rig.step({}, 90);
    expect(rig.snapshotMonster().poise!).toBeCloseTo(0.5, 1);
    expect(rig.monster().reactionState!.kind).toBe('stun');
    rig.step({}, stun.durationTicks - 90);
    expect(rig.monster().reactionState).toBeUndefined();
    expect(rig.monster().poiseMeter).toBe(0);
    expect(rig.snapshotMonster().poise).toBe(0);
    expect(rig.monster().poiseBreaks).toBe(1);
  });

  it('breaks poise outright for a stun hit and lets a chipped bar regenerate after the delay', () => {
    const rig = reactionRig({ stage: 1 });
    rig.strike(YARA_HITS.root_eruption!);
    expect(rig.monster().reactionState!.kind).toBe('stun');
    expect(rig.monster().reactionState!.durationTicks).toBe(MASS.light.stunTicks);
    const chip = reactionRig({ stage: 0 });
    chip.strike(hit('light', 40, 0));
    expect(chip.monster().poiseMeter).toBe(40);
    chip.step({}, POISE_REGEN_DELAY - 2);
    expect(chip.monster().poiseMeter).toBe(40);
    chip.step({}, 2 + POISE_REGEN_TICKS);
    expect(chip.monster().poiseMeter).toBe(0);
  });

  it('gives bosses super-armour through a committed attack (flinch only), defers the poise break to the end of the armour, and stuns them shortly', () => {
    const rig = reactionRig({ stage: 2 });
    const bar = buildOf('greenwake-root-rammer', 1.2, true, 0).poiseMax;
    expect(bar).toBe(BOSS_POISE.max);
    const hazard = rig.internals.beginAttack(rig.monster(), ATTACKS['root-rammer-slam']!)!;
    // Heavy blows in the windup stagger the boss (colossal) but never cancel its attack.
    rig.step({}, 3);
    rig.strike(hit('heavy', 10, 2));
    expect(rig.monster().reactionState!.kind).toBe('stagger');
    expect(rig.state.telegraphs.some(telegraph => telegraph.sourceId === rig.monsterId)).toBe(true);
    while (rig.state.worldTick < hazard.windupUntil! + 1) rig.step();
    expect(rig.snapshotMonster().attackPhase).toBe('commit');
    for (let blow = 0; blow < 8; blow++) rig.strike(hit('heavy', 40, 2));
    expect(rig.monster().reactionState!.kind).toBe('flinch');
    expect(rig.monster().poiseMeter).toBe(bar);
    expect(rig.state.hazards.some(live => live.id === hazard.id)).toBe(true);
    expect(rig.cuesOf('poise-break')).toHaveLength(0);
    // The armour drops with the committed phases; the full bar then breaks on its own.
    let guard = 0;
    while (rig.monster().reactionState?.kind !== 'stun' && guard++ < 200) rig.step();
    expect(rig.monster().reactionState!.kind).toBe('stun');
    expect(rig.monster().reactionState!.durationTicks).toBe(BOSS_POISE.stunTicks);
    expect(rig.cuesOf('poise-break')).toHaveLength(1);
    rig.step({}, BOSS_POISE.stunTicks);
    expect(rig.monster().reactionState).toBeUndefined();
    expect(rig.monster().poiseBreaks).toBe(1);
    // Poise phase 2: the bar is 35% bigger, so the same chip no longer breaks it.
    rig.monster().staggerUntil = 1e9;
    rig.strike(hit('light', bar, 0));
    expect(rig.monster().reactionState?.kind).not.toBe('stun');
    expect(rig.snapshotMonster().poise!).toBeCloseTo(1 / 1.35, 6);
  });

  it('never reacts, pushes or builds poise on an anchored set-piece', () => {
    const rig = reactionRig({ stage: 0 });
    rig.monster().anchored = true;
    const from = { ...rig.monster().position };
    rig.strike(hit('finisher', 100, 4, { stun: true }));
    rig.step({}, 60);
    expect(rig.monster().reactionState).toBeUndefined();
    expect(rig.monster().poiseMeter).toBeUndefined();
    expect(rig.snapshotMonster().poise).toBeUndefined();
    expect(horizontal(from, rig.monster().position)).toBe(0);
  });
});

describe('hero kit blows in the engine', () => {
  it("Sakda's Tiger's Wrath knocks the target down, and a wall stops the kit's own slide with a wall-impact", () => {
    const rig = reactionRig({ hero: 'sakda', stage: 0, distance: 2.6, walls: [{ offset: vec(0, 1, -4.4), half: vec(4, 1, 1) }] });
    rig.monster().recoveringUntil = 1e9;
    rig.state.player.instinct = 100;
    const start = rig.monster().position.z;
    rig.step({ ultimatePressed: true });
    let guard = 0;
    while (rig.cuesOf('wall-impact').length === 0 && guard++ < 200) rig.step();
    expect(rig.cues.find(cue => cue.kind === 'reaction-start' && cue.actorId === rig.monsterId)).toMatchObject({ reactionKind: 'knockdown' });
    expect(rig.cuesOf('wall-impact')).toHaveLength(1);
    // The wall face is 3.4 m behind the boar's start; its 1.05 m body stops 2.35 m along the slide.
    expect(start - rig.monster().position.z).toBeGreaterThan(2);
    expect(start - rig.monster().position.z).toBeLessThanOrEqual(2.35 + 1e-6);
  });

  it("Vesper's Crescent Rift finisher stuns a light monster instead of knocking it down, and her stagger cut holds it in place", () => {
    const rig = reactionRig({ hero: 'vesper', stage: 1, distance: 2 });
    rig.monster().recoveringUntil = 1e9;
    const from = { ...rig.monster().position };
    rig.strike(VESPER_HITS.iai[2]!);
    expect(rig.monster().reactionState!.kind).toBe('stagger');
    settle(rig);
    expect(horizontal(from, rig.monster().position)).toBe(0);
    rig.strike(VESPER_HITS.iai[3]!);
    expect(rig.monster().reactionState!.kind).toBe('stun');
    expect(rig.monster().reactionState!.durationTicks).toBe(MASS.light.stunTicks);
  });
});

describe('hero reactions in the engine', () => {
  it('knocks the hero down with a Root Rammer charge, locks his input, and lets a dodge cancel the lie only after a short delay', () => {
    const rig = reactionRig({ stage: 2, distance: 4 });
    const start = { ...rig.me().position };
    charge(rig, 'root-rammer-low-wave');
    let guard = 0;
    while (!rig.me().reactionState && guard++ < 400) rig.step();
    const reaction = rig.me().reactionState!;
    expect(reaction.kind).toBe('knockdown');
    expect(rig.state.actionId).toBe('reaction');
    expect(rig.cuesOf('reaction-start').find(cue => cue.actorId === rig.state.playerId)).toMatchObject({ reactionKind: 'knockdown', targetId: rig.state.playerId });
    // Inputs are ignored while down; a dodge before the cancel delay is refused too.
    rig.step({ lightPressed: true });
    expect(rig.state.actionId).toBe('reaction');
    expect(rig.state.swing).toBeUndefined();
    rig.step({ dodgePressed: true });
    expect(rig.me().reactionState!.serial).toBe(reaction.serial);
    expect(rig.state.actionId).toBe('reaction');
    // Eased slide away from the rammer (it stands on -z), 3.2 m for a finisher on a medium hero.
    rig.step({}, REACTION_TICKS.playerCancelFrom);
    expect(rig.me().position.z - start.z).toBeCloseTo(3.2, 1);
    const mana = rig.state.player.mana;
    rig.step({ dodgePressed: true });
    expect(rig.me().reactionState).toBeUndefined();
    expect(rig.state.player.mana).toBeLessThan(mana);
    expect(rig.state.actionId).not.toBe('reaction');
  });

  it('gets up with i-frames: no live hazard can touch the hero for the first ticks, then it can', () => {
    const rig = reactionRig({ stage: 2, distance: 4 });
    charge(rig, 'root-rammer-low-wave');
    let guard = 0;
    while (rig.me().reactionState?.kind !== 'getup' && guard++ < 600) rig.step();
    expect(rig.me().reactionState!.kind).toBe('getup');
    const vitality = rig.state.player.vitality;
    const hazard = structuredClone(rig.state.hazards[0] ?? rig.internals.beginAttack(rig.monster(), ATTACKS['koro-fruit-burst']!)!);
    expect(hazard).toBeDefined();
    // A fresh area hazard exactly on the hero that is live now.
    rig.state.hazards = [{
      ...structuredClone(ATTACKS['koro-fruit-burst']!.hazard), id: 'getup-probe', attackId: 'koro-fruit-burst' as never, sourceId: rig.monsterId as ActorId, targetActorId: rig.state.playerId,
      startTick: rig.state.worldTick, windupUntil: rig.state.worldTick, activeFrom: rig.state.worldTick, activeUntil: rig.state.worldTick + 8, castUntil: rig.state.worldTick + 8, recoveryUntil: rig.state.worldTick + 8,
      target: { ...rig.me().position }, origin: { ...rig.me().position }, direction: vec(0, 0, -1), width: 8, depth: 8, hitIds: [], threatTicks: [], cue: 'probe',
      bounds: { min: vec(rig.me().position.x - 4, rig.me().position.y - 1, rig.me().position.z - 4), max: vec(rig.me().position.x + 4, rig.me().position.y + 3, rig.me().position.z + 4) },
    }];
    rig.step({}, 4);
    expect(rig.state.player.vitality).toBe(vitality);
    rig.state.hazards = [];
    rig.step({}, REACTION_TICKS.getupIframes);
    rig.state.hazards = [{ ...structuredClone(ATTACKS['koro-fruit-burst']!.hazard), id: 'late-probe', attackId: 'koro-fruit-burst' as never, sourceId: rig.monsterId as ActorId, targetActorId: rig.state.playerId,
      startTick: rig.state.worldTick, windupUntil: rig.state.worldTick, activeFrom: rig.state.worldTick, activeUntil: rig.state.worldTick + 8, castUntil: rig.state.worldTick + 8, recoveryUntil: rig.state.worldTick + 8,
      target: { ...rig.me().position }, origin: { ...rig.me().position }, direction: vec(0, 0, -1), width: 8, depth: 8, hitIds: [], threatTicks: [], cue: 'probe',
      bounds: { min: vec(rig.me().position.x - 4, rig.me().position.y - 1, rig.me().position.z - 4), max: vec(rig.me().position.x + 4, rig.me().position.y + 3, rig.me().position.z + 4) } }];
    rig.step();
    expect(rig.state.player.vitality).toBeLessThan(vitality);
  });

  it('absorbs a tier for the heavy hero: Sakda is only knocked back by the same charge, Vesper still falls', () => {
    const run = (hero: 'sakda' | 'vesper'): string | undefined => {
      const rig = reactionRig({ stage: 2, distance: 4, hero });
      charge(rig, 'root-rammer-low-wave');
      let guard = 0;
      while (!rig.me().reactionState && guard++ < 400) rig.step();
      return rig.me().reactionState?.kind;
    };
    expect(run('sakda')).toBe('knockback');
    expect(run('vesper')).toBe('knockdown');
  });

  it('flinches a medium hero on a medium blow without locking him, but staggers a light hero and cancels what he was doing', () => {
    const medium = reactionRig({ stage: 0, distance: 4, hero: 'aren' });
    charge(medium, 'koro-fruit-burst');
    let guard = 0;
    while (!medium.me().reactionState && guard++ < 400) medium.step();
    expect(medium.me().reactionState!.kind).toBe('flinch');
    expect(medium.state.actionId).not.toBe('reaction');
    const light = reactionRig({ stage: 0, distance: 4, hero: 'vesper' });
    light.step({ lightPressed: true });
    expect(light.state.actionId).not.toBe('idle');
    charge(light, 'koro-fruit-burst');
    guard = 0;
    while (light.me().reactionState?.kind !== 'stagger' && guard++ < 400) light.step();
    expect(light.me().reactionState!.kind).toBe('stagger');
    expect(light.state.actionId).toBe('reaction');
  });

  it('freezes a hero reaction with the hit-stop clock like every other player timer', () => {
    const rig = reactionRig({ stage: 2, distance: 4 });
    charge(rig, 'root-rammer-low-wave');
    let guard = 0;
    while (!rig.me().reactionState && guard++ < 400) rig.step();
    rig.step({}, 5);
    const progress = rig.engine.snapshot().actors.find(actor => actor.id === rig.state.playerId)!.reaction!.progress;
    rig.state.hitStop = { remainingTicks: 3, strength: 0.4 };
    rig.step({}, 3);
    expect(rig.engine.snapshot().actors.find(actor => actor.id === rig.state.playerId)!.reaction!.progress).toBeCloseTo(progress, 9);
  });

  it('never reports poise for the hero and keeps the contract fields on every reaction snapshot', () => {
    const rig = reactionRig({ stage: 0 });
    rig.strike(hit('heavy', 24, 2));
    const snapshot = rig.engine.snapshot();
    expect(snapshot.actors.find(actor => actor.id === rig.state.playerId)!.poise).toBeUndefined();
    expect(snapshot.actors.find(actor => actor.id === rig.monsterId)!.poise).toBeGreaterThan(0);
    const reaction = snapshot.actors.find(actor => actor.id === rig.monsterId)!.reaction!;
    expect(Object.keys(reaction).sort()).toEqual(['direction', 'durationTicks', 'kind', 'progress', 'serial', 'side', 'strength']);
    expect(reaction.strength).toBeGreaterThan(0.7);
    expect(reaction.strength).toBeLessThanOrEqual(1);
    expect(['front', 'back', 'left', 'right']).toContain(reaction.side);
    expect('hitReact' in (snapshot.actors[0] as object)).toBe(false);
  });
});

describe('player lunge and body separation', () => {
  it('steps Aren towards the assisted target over the light windup and stops at contact, swept against walls', () => {
    const open = reactionRig({ stage: 0, distance: 3.4 });
    const start = { ...open.me().position };
    open.step({ lightPressed: true });
    const spec = LIGHT_STEPS[0]!;
    const track: number[] = [];
    for (let tick = 0; tick < spec.activeFrom; tick++) { open.step(); track.push(horizontal(start, open.me().position)); }
    for (let i = 1; i < track.length; i++) expect(track[i]!).toBeGreaterThanOrEqual(track[i - 1]! - 1e-9);
    expect(track[track.length - 1]!).toBeCloseTo(0.5, 2);
    expect(open.me().position.z).toBeLessThan(start.z);
    // A target already at contact range is not walked into.
    const close = reactionRig({ stage: 0, distance: 1.9 });
    const gapBefore = horizontal(close.me().position, close.monster().position);
    close.step({ lightPressed: true });
    close.step({}, spec.activeFrom);
    const gapAfter = horizontal(close.me().position, close.monster().position);
    expect(gapAfter).toBeGreaterThanOrEqual(close.monster().radius + 0.42 + 0.35 - 1e-6);
    expect(gapBefore - gapAfter).toBeLessThan(0.2);
    // A pillar between hero and target stops the swept step.
    const walled = reactionRig({ stage: 0, distance: 3.4, walls: [{ offset: vec(0, 1, 2.8), half: vec(2, 1, 0.1) }] });
    const walledStart = { ...walled.me().position };
    walled.step({ lightPressed: true });
    walled.step({}, spec.activeFrom);
    expect(horizontal(walledStart, walled.me().position)).toBeLessThan(0.3);
    // No target in assist range, no lunge.
    const far = reactionRig({ stage: 0, distance: LIGHT_ASSIST_RANGE + 2 });
    const farStart = { ...far.me().position };
    far.step({ lightPressed: true });
    far.step({}, spec.activeFrom);
    expect(horizontal(farStart, far.me().position)).toBe(0);
  });

  it('lunges furthest on the finisher and steps forward for the heavy', () => {
    const lungeOf = (press: Partial<Parameters<ReactionRig['step']>[0]>, ticks: number, distance = 3.4): number => {
      const rig = reactionRig({ stage: 0, distance });
      const start = { ...rig.me().position };
      rig.step(press);
      rig.step({}, ticks);
      return horizontal(start, rig.me().position);
    };
    expect(lungeOf({ lightPressed: true }, LIGHT_STEPS[0]!.activeFrom)).toBeCloseTo(0.5, 2);
    expect(lungeOf({ heavyPressed: true }, 30)).toBeCloseTo(0.9, 2);
    // The fourth light step (the finisher) is reached through the chain.
    const rig = reactionRig({ stage: 0, distance: 4.4 });
    for (let step = 0; step < 4; step++) {
      while (step > 0 && rig.state.tick < rig.state.lightChainFrom!) rig.step();
      const before = { ...rig.me().position };
      rig.step({ lightPressed: true });
      rig.step({}, LIGHT_STEPS[step]!.activeFrom);
      if (step === 3) expect(horizontal(before, rig.me().position)).toBeGreaterThan(1.1);
    }
  });

  it('pushes overlapping bodies apart softly and deterministically, capped per tick, lighter bodies yielding more', () => {
    const run = (): { hero: number; boar: number; maxStep: number; positions: string } => {
      const rig = reactionRig({ stage: 0, distance: 0.6, frozen: false });
      rig.monster().staggerUntil = 1e9;
      rig.monster().recoveringUntil = 1e9;
      const hero0 = { ...rig.me().position }, boar0 = { ...rig.monster().position };
      let maxStep = 0, previous = { ...rig.me().position };
      const log: string[] = [];
      for (let tick = 0; tick < 60; tick++) {
        rig.step();
        maxStep = Math.max(maxStep, horizontal(previous, rig.me().position), 0);
        previous = { ...rig.me().position };
        log.push(`${rig.me().position.x.toFixed(6)},${rig.me().position.z.toFixed(6)}|${rig.monster().position.x.toFixed(6)},${rig.monster().position.z.toFixed(6)}`);
      }
      return { hero: horizontal(hero0, rig.me().position), boar: horizontal(boar0, rig.monster().position), maxStep, positions: log.join(';') };
    };
    const first = run(), second = run();
    expect(second).toEqual(first);
    expect(first.hero).toBeGreaterThan(0);
    expect(first.boar).toBeGreaterThan(0);
    expect(first.hero).toBeGreaterThan(first.boar);
    expect(first.maxStep).toBeLessThanOrEqual(0.04 + 1e-9);
  });

  it('separates two overlapping hostiles but leaves an anchored one and a hero in mid-action alone', () => {
    const rig = reactionRig({ stage: 0, distance: 6 });
    rig.monster().staggerUntil = 1e9;
    const other = rig.state.actors.find(actor => actor.id === 'greenwake-sap-stalker')!;
    expect(other).toBeDefined();
    other.visible = true; other.allegiance = 'hostile'; other.downed = false;
    other.position = vec(rig.monster().position.x + 0.3, rig.monster().position.y, rig.monster().position.z);
    const gap0 = horizontal(rig.monster().position, other.position);
    rig.step({}, 80);
    // Both ease apart, the lighter stalker further, and neither is driven beyond the soft cap per tick.
    const gap1 = horizontal(rig.monster().position, other.position);
    expect(gap1).toBeGreaterThan(gap0 + 0.3);
    expect(gap1).toBeGreaterThanOrEqual((rig.monster().radius + other.radius) * 0.9 - 1e-6);
    const busy = reactionRig({ stage: 0, distance: 0.6 });
    busy.step({ lightPressed: true });
    const heroBefore = { ...busy.me().position };
    busy.step();
    expect(horizontal(heroBefore, busy.me().position)).toBeLessThan(0.04);
  });
});

describe('determinism and persistence', () => {
  const script = (rig: ReactionRig, tick: number): void => {
    if (tick === 5) rig.strike(hit('heavy', 24, 2));
    if (tick === 60) rig.strike(hit('finisher', 40, 3));
    if (tick === 200) rig.strike(hit('light', 50, 0, { stun: true }));
    rig.step(tick % 40 === 0 ? { lightPressed: true } : {});
  };
  const trace = (rig: ReactionRig): string => {
    const monster = rig.snapshotMonster(), hero = rig.engine.snapshot().actors.find(actor => actor.id === rig.state.playerId)!;
    return JSON.stringify([monster.position, monster.reaction, monster.poise, hero.position, hero.reaction, rig.state.worldTick]);
  };

  it('replays identically: the same inputs give the same reaction snapshots tick for tick', () => {
    const runs = [0, 1].map(() => {
      const rig = reactionRig({ stage: 1, frozen: false });
      rig.monster().staggerUntil = 1e9;
      rig.monster().recoveringUntil = 1e9;
      const frames: string[] = [];
      for (let tick = 0; tick < 400; tick++) { script(rig, tick); frames.push(trace(rig)); }
      return frames;
    });
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[0].some(frame => frame.includes('"stun"'))).toBe(true);
    expect(runs[0].some(frame => frame.includes('"getup"'))).toBe(true);
  });

  it('saves and restores mid-reaction: the restored engine finishes the reaction exactly like the original', () => {
    const rig = reactionRig({ stage: 0 });
    rig.monster().recoveringUntil = 1e9;
    rig.strike(hit('heavy', 24, 2));
    rig.step({}, 10);
    const saved = rig.engine.serialize();
    const restored = new CombatEngine();
    restored.restore(saved);
    const live = restored.snapshot().actors.find(actor => actor.id === rig.monsterId)!;
    expect(live.reaction).toMatchObject({ kind: 'knockback' });
    expect(live.poise).toBeGreaterThan(0);
    for (let tick = 0; tick < 120; tick++) {
      rig.step();
      restored.fixedStep({ tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false });
      restored.drainPresentationCues();
      const a = rig.snapshotMonster(), b = restored.snapshot().actors.find(actor => actor.id === rig.monsterId)!;
      expect(b.position).toEqual(a.position);
      expect(b.reaction).toEqual(a.reaction);
      expect(b.poise).toEqual(a.poise);
    }
  });

  it('clears every reaction and poise bar when the encounter resets to its checkpoint', () => {
    const rig = reactionRig({ stage: 0 });
    rig.strike(hit('finisher', 100, 3, { stun: true }));
    expect(rig.monster().reactionState).toBeDefined();
    rig.engine.resetToCheckpoint();
    expect(rig.monster().reactionState).toBeUndefined();
    expect(rig.monster().poiseMeter).toBeUndefined();
    expect(rig.engine.snapshot().actors.every(actor => actor.reaction === undefined)).toBe(true);
  });
});
