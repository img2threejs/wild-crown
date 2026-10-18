import { describe, expect, it } from 'bun:test';
import {
  MONSTER_HOVER, MONSTER_HURT_HOLD_TIME, ROAR_CLIP_WINDOW, monsterHoverHeight, resolveMonsterAnimation, resolveMonsterHitOverlay, settleMonsterHover,
} from '../../src/rendering/MonsterAnimationProfiles.js';
import { flinchAt } from './reaction-fixtures.js';
import type { ActorSnapshot } from '../../src/game/contracts';

const PHASES = ['windup', 'commit', 'active', 'recovery'] as const;
const ASSET = { howler: 'actor-thornback-howler', hornbill: 'actor-storm-hornbill', viper: 'actor-mire-viper' } as const;

function monster(partial: Partial<ActorSnapshot> & { id?: string } = {}): ActorSnapshot {
  return {
    id: 'canopy-hornbill', archetypeId: 'actor-storm-hornbill', species: 'hornbill', allegiance: 'hostile', position: { x: 7, y: 4, z: -24 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: 1 },
    actionId: 'monster-idle', phase: 'idle', normalizedTime: 0, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false, ...partial,
  } as unknown as ActorSnapshot;
}
const attacking = (attackId: string, attackPhase: NonNullable<ActorSnapshot['attackPhase']>, progress: number, id = 'canopy-hornbill'): ActorSnapshot =>
  monster({ id, actionId: `wild-crown:${attackId}` as never, attackPhase, attackPhaseProgress: progress });

describe('canopy monster clip plans', () => {
  it('uses the Greenwake slot logic for locomotion, turning, hurt, roar and idle on the new assets', () => {
    for (const asset of Object.values(ASSET)) {
      const id = asset === ASSET.howler ? 'canopy-howler' : asset === ASSET.hornbill ? 'canopy-hornbill' : 'canopy-mire-viper';
      expect(resolveMonsterAnimation(monster({ id }), asset)).toMatchObject({ actionId: 'monster-idle', phase: 'idle' });
      expect(resolveMonsterAnimation(monster({ id, velocity: { x: 0.8, y: 0, z: 0 } }), asset)).toMatchObject({ actionId: 'monster-walk' });
      expect(resolveMonsterAnimation(monster({ id, velocity: { x: 6, y: 0, z: 0 } }), asset)).toMatchObject({ actionId: 'monster-run' });
      expect(resolveMonsterAnimation(monster({ id, yawRate: 1.5 }), asset)).toMatchObject({ actionId: 'monster-turn' });
      expect(resolveMonsterAnimation(monster({ id, roarProgress: 0.5 }), asset)).toMatchObject({ actionId: 'monster-roar', phase: 'active', normalizedTime: (ROAR_CLIP_WINDOW.from + ROAR_CLIP_WINDOW.to) / 2 });
      // A hit reaction is a native hurt overlay; the base clip keeps playing.
      expect(resolveMonsterAnimation(monster({ id, reaction: flinchAt(0.4) }), asset)).toMatchObject({ actionId: 'monster-idle' });
      expect(resolveMonsterHitOverlay(monster({ id, reaction: flinchAt(0.4) }), asset)).toMatchObject({ actionId: 'monster-hurt' });
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
  it('brings Orun Sky Echo into the damaging lane rather than leaving its native hornbill at idle flight height', () => {
    const dive = (phase: NonNullable<ActorSnapshot['attackPhase']>, progress: number) =>
      attacking('orun-sky-dive', phase, progress, 'hollow-sky-echo-1');
    for (const progress of [0, .25, .5, 1]) expect(hover(dive('active', progress), 0)).toBeCloseTo(profile.dive!.lowHeight, 9);
    for (const [left, right] of [['windup', 'commit'], ['commit', 'active'], ['active', 'recovery']] as const) {
      expect(hover(dive(left, 1), 0)).toBeCloseTo(hover(dive(right, 0), 0), 9);
    }
    const midway = hover(dive('commit', .5), 5);
    for (let frame = 0; frame < 30; frame++) expect(hover(dive('commit', .5), 5)).toBe(midway);
    expect(hover(dive('recovery', 1), 5)).toBeCloseTo(hover(monster({ id: 'hollow-sky-echo-1' }), 5), 9);
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
