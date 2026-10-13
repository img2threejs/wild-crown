import { describe, expect, it } from 'bun:test';
import {
  MONSTER_ATTACK_PLANS, MONSTER_HOVER, MONSTER_HURT_HOLD_TIME, ROAR_CLIP_WINDOW, monsterHoverHeight, resolveMonsterAnimation, settleMonsterHover,
} from '../../src/rendering/MonsterAnimationProfiles.js';
import type { MonsterAttackPlan } from '../../src/rendering/MonsterAnimationPlan.js';

/** Every canopy attack id the plans have to sample cleanly. */
const ATTACK_IDS = [
  'howler-rock-hurl', 'howler-leap-slam', 'howler-branch-sweep', 'hornbill-dive-bomb', 'hornbill-feather-volley', 'hornbill-gale-flap',
  'viper-venom-spit', 'viper-tail-lash', 'viper-strike-lunge',
] as const;
const PHASES = ['windup', 'commit', 'active', 'recovery'] as const;
const ASSET = { howler: 'actor-thornback-howler', hornbill: 'actor-storm-hornbill', viper: 'actor-mire-viper' } as const;
const ACTOR_ASSET: Readonly<Record<string, string>> = { 'canopy-howler': ASSET.howler, 'canopy-hornbill': ASSET.hornbill, 'canopy-mire-viper': ASSET.viper };

function monster(partial: Partial<ActorSnapshot> & { id?: string } = {}): ActorSnapshot {
  return {
    id: 'canopy-hornbill', archetypeId: 'actor-storm-hornbill', species: 'hornbill', allegiance: 'hostile', position: { x: 7, y: 4, z: -24 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: 1 },
    actionId: 'monster-idle', phase: 'idle', normalizedTime: 0, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false, ...partial,
  } as unknown as ActorSnapshot;
}
const attacking = (attackId: string, attackPhase: NonNullable<ActorSnapshot['attackPhase']>, progress: number, id = 'canopy-hornbill'): ActorSnapshot =>
  monster({ id, actionId: `wild-crown:${attackId}` as never, attackPhase, attackPhaseProgress: progress });

describe('canopy monster clip plans', () => {
  it('finite plans run the clip forward through contiguous phase windows that end at the clip end', () => {
    for (const attackId of ATTACK_IDS) {
      const plan = MONSTER_ATTACK_PLANS[attackId] as MonsterAttackPlan;
      const steps = PHASES.map(phase => plan[phase]);
      if (steps.some(step => 'loopRate' in step)) throw new Error(`${attackId}: canopy attacks play finite clip windows`);
      let previousTo = -1;
      for (const step of steps) {
        if ('loopRate' in step) throw new Error(`${attackId}: mixed loop/clip plan`);
        expect(step.from).toBeGreaterThanOrEqual(0);
        expect(step.to).toBeLessThanOrEqual(1);
        expect(step.to).toBeGreaterThan(step.from);
        if (previousTo >= 0) expect(step.from).toBeCloseTo(previousTo, 9);
        previousTo = step.to;
      }
      expect(previousTo).toBe(1);
    }
  });

  it('lands the visible strike on the active window: the clip pose at the active start is the strike pose', () => {
    const strikeStart: Readonly<Record<string, number>> = {
      // shoot expels ~0.5 (the throw/spit/darts leave in commit and land as active opens)
      'howler-rock-hurl': 0.68, 'hornbill-feather-volley': 0.66, 'viper-venom-spit': 0.62,
      // slash strike pose ~0.45, dive strike ~0.4, jump lands 0.7-0.85
      'howler-branch-sweep': 0.45, 'hornbill-gale-flap': 0.45, 'hornbill-dive-bomb': 0.36, 'viper-strike-lunge': 0.38, 'howler-leap-slam': 0.7,
    };
    for (const [attackId, expected] of Object.entries(strikeStart)) {
      const active = resolveMonsterAnimation(attacking(attackId, 'active', 0, ACTOR_OF(attackId)), ACTOR_ASSET[ACTOR_OF(attackId)]!);
      expect(active, attackId).toBeDefined();
      expect(active!.phase).toBe('active');
      expect(active!.normalizedTime).toBeCloseTo(expected, 6);
    }
    // The shoot clip's expel (~0.5) is reached at the start of commit, so the visible throw precedes the hazard.
    for (const attackId of ['howler-rock-hurl', 'hornbill-feather-volley', 'viper-venom-spit']) {
      const commit = resolveMonsterAnimation(attacking(attackId, 'commit', 0, ACTOR_OF(attackId)), ACTOR_ASSET[ACTOR_OF(attackId)]!)!;
      expect(commit.normalizedTime).toBeCloseTo(0.5, 6);
    }
  });

  it('plays every phase of every canopy attack inside the clip range', () => {
    for (const attackId of ATTACK_IDS) for (const phase of PHASES) for (const progress of [0, 0.25, 0.5, 1]) {
      const sample = resolveMonsterAnimation(attacking(attackId, phase, progress, ACTOR_OF(attackId)), ACTOR_ASSET[ACTOR_OF(attackId)]!)!;
      expect(sample.normalizedTime).toBeGreaterThanOrEqual(0);
      expect(sample.normalizedTime).toBeLessThanOrEqual(1);
      expect(sample.loopRate).toBeGreaterThan(0);
    }
  });

  it('uses the Greenwake slot logic for locomotion, turning, hurt, roar and idle on the new assets', () => {
    for (const asset of Object.values(ASSET)) {
      const id = asset === ASSET.howler ? 'canopy-howler' : asset === ASSET.hornbill ? 'canopy-hornbill' : 'canopy-mire-viper';
      expect(resolveMonsterAnimation(monster({ id }), asset)).toMatchObject({ actionId: 'monster-idle', phase: 'idle' });
      expect(resolveMonsterAnimation(monster({ id, velocity: { x: 0.8, y: 0, z: 0 } }), asset)).toMatchObject({ actionId: 'monster-walk' });
      expect(resolveMonsterAnimation(monster({ id, velocity: { x: 6, y: 0, z: 0 } }), asset)).toMatchObject({ actionId: 'monster-run' });
      expect(resolveMonsterAnimation(monster({ id, yawRate: 1.5 }), asset)).toMatchObject({ actionId: 'monster-turn' });
      expect(resolveMonsterAnimation(monster({ id, roarProgress: 0.5 }), asset)).toMatchObject({ actionId: 'monster-roar', phase: 'active', normalizedTime: (ROAR_CLIP_WINDOW.from + ROAR_CLIP_WINDOW.to) / 2 });
      expect(resolveMonsterAnimation(monster({ id, hitReact: 0.4 }), asset)).toMatchObject({ actionId: 'monster-hurt' });
      // Downed and exposed monsters hold the dazed pose of the finite hurt clip instead of looping the flinch.
      expect(resolveMonsterAnimation(monster({ id, downed: true }), asset)).toMatchObject({ actionId: 'monster-hurt', phase: 'active', normalizedTime: MONSTER_HURT_HOLD_TIME });
      expect(resolveMonsterAnimation(monster({ id, weakPointExposed: true }), asset)).toMatchObject({ actionId: 'monster-hurt', phase: 'active', normalizedTime: MONSTER_HURT_HOLD_TIME });
    }
    // Run threshold scales with each AI profile's advance speed (howler 4.8, hornbill 5.2, viper 2.6 m/s).
    expect(resolveMonsterAnimation(monster({ velocity: { x: 3, y: 0, z: 0 } }), ASSET.howler)!.actionId).toBe('monster-walk');
    expect(resolveMonsterAnimation(monster({ velocity: { x: 2.4, y: 0, z: 0 } }), ASSET.viper)!.actionId).toBe('monster-run');
    expect(resolveMonsterAnimation(monster({ velocity: { x: 2.4, y: 0, z: 0 } }), ASSET.hornbill)!.actionId).toBe('monster-walk');
  });
});

function ACTOR_OF(attackId: string): string { return attackId.startsWith('howler') ? 'canopy-howler' : attackId.startsWith('hornbill') ? 'canopy-hornbill' : 'canopy-mire-viper'; }

describe('hornbill flight presentation (monsterHoverHeight)', () => {
  const profile = MONSTER_HOVER[ASSET.hornbill]!;
  const DIVE = 'hornbill-dive-bomb';
  const hover = (actor: ActorSnapshot, time = 12.3): number => monsterHoverHeight(actor, ASSET.hornbill, time);

  it('only the hornbill hovers; every other monster and unknown asset draws on its simulation position', () => {
    expect(Object.keys(MONSTER_HOVER)).toEqual([ASSET.hornbill]);
    expect(profile.height).toBeCloseTo(2.4, 9);
    expect(monsterHoverHeight(monster({ id: 'canopy-howler' }), ASSET.howler, 3)).toBe(0);
    expect(monsterHoverHeight(monster({ id: 'canopy-mire-viper' }), ASSET.viper, 3)).toBe(0);
    expect(monsterHoverHeight(monster(), 'actor-ember-boar', 3)).toBe(0);
  });

  it('idles ~2.4 m above the simulation position with a slow bounded bob', () => {
    let min = Infinity, max = -Infinity, sum = 0;
    const samples = 2000;
    for (let i = 0; i < samples; i++) { const h = hover(monster(), i * 0.037); min = Math.min(min, h); max = Math.max(max, h); sum += h; }
    expect(sum / samples).toBeGreaterThan(2.3);
    expect(sum / samples).toBeLessThan(2.5);
    expect(min).toBeGreaterThanOrEqual(2.4 - profile.bobAmplitude - 1e-9);
    expect(max).toBeLessThanOrEqual(2.4 + profile.bobAmplitude + 1e-9);
    expect(max - min).toBeGreaterThan(profile.bobAmplitude); // it really moves
    // Slow: the height never changes faster than 0.35 m/s.
    let steepest = 0;
    for (let i = 0; i < samples; i++) steepest = Math.max(steepest, Math.abs(hover(monster(), (i + 1) * 0.01) - hover(monster(), i * 0.01)) / 0.01);
    expect(steepest).toBeLessThan(0.35);
  });

  it('is pause-safe and deterministic: a frozen world clock holds the pose, and serialization changes nothing', () => {
    const actor = attacking(DIVE, 'commit', 0.4);
    const held = hover(actor, 7.25);
    for (let frame = 0; frame < 30; frame++) expect(hover(actor, 7.25)).toBe(held);
    expect(hover(JSON.parse(JSON.stringify(actor)) as ActorSnapshot, 7.25)).toBe(held);
    const idle = hover(monster(), 7.25);
    expect(hover(JSON.parse(JSON.stringify(monster())) as ActorSnapshot, 7.25)).toBe(idle);
    // Order independence (no hidden state): evaluating other actors/times in between changes nothing.
    hover(monster({ id: 'canopy-hornbill-b' }), 99); hover(attacking(DIVE, 'active', 0.5), 3);
    expect(hover(monster(), 7.25)).toBe(idle);
    // A different flier bobs out of step.
    expect(hover(monster({ id: 'canopy-hornbill-b' }), 7.25)).not.toBe(idle);
  });

  it('swoops to ~0.6 m during the dive-bomb commit/active and climbs back in recovery, continuous at every boundary', () => {
    const t = 20;
    const windupStart = hover(attacking(DIVE, 'windup', 0), t), windupEnd = hover(attacking(DIVE, 'windup', 1), t);
    const commitStart = hover(attacking(DIVE, 'commit', 0), t), commitMid = hover(attacking(DIVE, 'commit', 0.5), t), commitEnd = hover(attacking(DIVE, 'commit', 1), t);
    const activeStart = hover(attacking(DIVE, 'active', 0), t), activeEnd = hover(attacking(DIVE, 'active', 1), t);
    const recoveryStart = hover(attacking(DIVE, 'recovery', 0), t), recoveryMid = hover(attacking(DIVE, 'recovery', 0.5), t), recoveryEnd = hover(attacking(DIVE, 'recovery', 1), t);
    const idleAfter = hover(monster(), t);
    // Wing-fold anticipation rears up slightly, from the idle hover.
    expect(windupStart).toBeCloseTo(hover(monster(), t), 9);
    expect(windupEnd).toBeGreaterThan(windupStart + 0.1);
    // Commit drops (accelerating) to the lane height; active stays there; recovery climbs back to the hover.
    expect(commitStart).toBeCloseTo(windupEnd, 9);
    expect(commitMid).toBeGreaterThan(commitEnd);
    expect(commitMid).toBeLessThan(commitStart);
    expect(commitEnd).toBeCloseTo(0.6, 9);
    expect(activeStart).toBeCloseTo(0.6, 9);
    expect(activeEnd).toBeCloseTo(0.6, 9);
    expect(recoveryStart).toBeCloseTo(0.6, 9);
    expect(recoveryMid).toBeGreaterThan(0.6);
    expect(recoveryMid).toBeLessThan(idleAfter);
    expect(recoveryEnd).toBeCloseTo(idleAfter, 9);
    for (let i = 0; i <= 100; i++) {
      const progress = i / 100;
      expect(hover(attacking(DIVE, 'commit', progress), t)).toBeGreaterThanOrEqual(0.6 - 1e-9);
      expect(hover(attacking(DIVE, 'active', progress), t)).toBeCloseTo(0.6, 9);
    }
  });

  it('other hornbill attacks keep the hover, and non-attack actions never use the swoop curve', () => {
    for (const attackId of ['hornbill-feather-volley', 'hornbill-gale-flap']) for (const phase of PHASES) {
      expect(hover(attacking(attackId, phase, 0.5), 5)).toBeCloseTo(hover(monster(), 5), 9);
    }
    expect(hover(monster({ actionId: `wild-crown:${DIVE}` as never }), 5)).toBeCloseTo(hover(monster(), 5), 9); // no attack phase: no swoop
  });

  it('a downed (cleansed) hornbill settles to the ground and the optional easing never moves a frozen clock', () => {
    const downed = monster({ downed: true });
    expect(hover(downed)).toBe(profile.groundedHeight);
    expect(profile.groundedHeight).toBeLessThan(0.2);
    // settleMonsterHover: attacks follow the curve exactly, everything else eases; zero world dt holds the value.
    expect(settleMonsterHover(undefined, 2.4, monster(), 0.016)).toBe(2.4);
    expect(settleMonsterHover(0.6, 2.4, attacking(DIVE, 'recovery', 0.2), 0.016)).toBe(2.4);
    expect(settleMonsterHover(2.4, 0.05, downed, 0)).toBe(2.4);
    let height = 2.4;
    for (let frame = 0; frame < 120; frame++) height = settleMonsterHover(height, hover(downed), downed, 1 / 60);
    expect(height).toBeLessThan(0.1);
    const step = settleMonsterHover(2.4, 0.05, downed, 1 / 60);
    expect(step).toBeLessThan(2.4);
    expect(step).toBeGreaterThan(0.05);
  });
});
