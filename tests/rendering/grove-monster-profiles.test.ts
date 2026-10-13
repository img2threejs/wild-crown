import { describe, expect, it } from 'bun:test';
import {
  MONSTER_HOVER, MONSTER_HURT_HOLD_TIME, ROAR_CLIP_WINDOW, monsterHoverHeight, resolveMonsterAnimation,
} from '../../src/rendering/MonsterAnimationProfiles.js';
import { GROVE_ATTACK_PLANS, GROVE_HOVER, GROVE_LOCOMOTION } from '../../src/rendering/GroveMonsterProfiles.js';
import type { MonsterAttackPlan } from '../../src/rendering/MonsterAnimationPlan.js';
import type { ActorSnapshot } from '../../src/game/contracts.js';

const PHASES = ['windup', 'commit', 'active', 'recovery'] as const;
const ROOTLING = 'actor-grove-rootling', KORO = 'actor-koro';

function monster(partial: Partial<ActorSnapshot> = {}): ActorSnapshot {
  return {
    id: 'grove-sprig', archetypeId: 'grove-sprig', species: 'rootling', allegiance: 'hostile', position: { x: -24, y: 0, z: -26 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: 1 },
    actionId: 'monster-idle', phase: 'idle', normalizedTime: 0, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false, ...partial,
  } as unknown as ActorSnapshot;
}
const attacking = (attackId: string, attackPhase: NonNullable<ActorSnapshot['attackPhase']>, progress: number): ActorSnapshot =>
  monster({ actionId: `wild-crown:${attackId}` as never, attackPhase, attackPhaseProgress: progress });

describe('grove monster clip plans', () => {
  it('runs every clip forward through contiguous phase windows that end at the clip end', () => {
    for (const attackId of Object.keys(GROVE_ATTACK_PLANS)) {
      const plan = GROVE_ATTACK_PLANS[attackId] as MonsterAttackPlan;
      let previousTo = -1;
      for (const phase of PHASES) {
        const step = plan[phase];
        if ('loopRate' in step) throw new Error(`${attackId}: the sprig plans are finite clip windows`);
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
    // shoot expels ~0.5 (the seed leaves in commit and lands as active opens); dive strikes ~0.4; slash strikes ~0.45.
    const strikeStart: Readonly<Record<string, number>> = { 'sprig-seed-toss': 0.68, 'sprig-ground-ripple': 0.38, 'sprig-petal-sweep': 0.45 };
    for (const [attackId, expected] of Object.entries(strikeStart)) {
      const active = resolveMonsterAnimation(attacking(attackId, 'active', 0), ROOTLING);
      expect(active, attackId).toBeDefined();
      expect(active!.phase).toBe('active');
      expect(active!.normalizedTime).toBeCloseTo(expected, 6);
    }
    // The shoot clip's expel (~0.5) is reached at the start of commit, so the visible throw precedes the hazard.
    expect(resolveMonsterAnimation(attacking('sprig-seed-toss', 'commit', 0), ROOTLING)!.normalizedTime).toBeCloseTo(0.5, 6);
  });

  it('plays every phase of every attack inside the clip range', () => {
    for (const attackId of Object.keys(GROVE_ATTACK_PLANS)) for (const phase of PHASES) for (const progress of [0, 0.25, 0.5, 1]) {
      const sample = resolveMonsterAnimation(attacking(attackId, phase, progress), ROOTLING)!;
      expect(sample.normalizedTime).toBeGreaterThanOrEqual(0);
      expect(sample.normalizedTime).toBeLessThanOrEqual(1);
      expect(sample.loopRate).toBeGreaterThan(0);
    }
  });
});

describe('grove locomotion', () => {
  it('has a locomotion entry for both Grove actors (without one a monster never animates)', () => {
    expect(Object.keys(GROVE_LOCOMOTION).sort()).toEqual([ROOTLING, KORO].sort());
    for (const asset of [ROOTLING, KORO]) {
      expect(resolveMonsterAnimation(monster({ archetypeId: asset }), asset)).toMatchObject({ actionId: 'monster-idle', phase: 'idle' });
      expect(GROVE_LOCOMOTION[asset]!.walkRef).toBeGreaterThan(0);
      expect(GROVE_LOCOMOTION[asset]!.runRef).toBeGreaterThan(GROVE_LOCOMOTION[asset]!.walkRef);
    }
  });

  it('uses the shared slot logic for the sprig: walk, run, turn, roar, hurt and idle', () => {
    expect(resolveMonsterAnimation(monster({ velocity: { x: 0.8, y: 0, z: 0 } }), ROOTLING)).toMatchObject({ actionId: 'monster-walk' });
    expect(resolveMonsterAnimation(monster({ velocity: { x: 2.3, y: 0, z: 0 } }), ROOTLING)).toMatchObject({ actionId: 'monster-run' });
    expect(resolveMonsterAnimation(monster({ yawRate: 1.5 }), ROOTLING)).toMatchObject({ actionId: 'monster-turn' });
    expect(resolveMonsterAnimation(monster({ roarProgress: 0.5 }), ROOTLING)).toMatchObject({ actionId: 'monster-roar', phase: 'active', normalizedTime: (ROAR_CLIP_WINDOW.from + ROAR_CLIP_WINDOW.to) / 2 });
    expect(resolveMonsterAnimation(monster({ hitReact: 0.4 }), ROOTLING)).toMatchObject({ actionId: 'monster-hurt' });
    expect(resolveMonsterAnimation(monster({ downed: true }), ROOTLING)).toMatchObject({ actionId: 'monster-hurt', phase: 'active', normalizedTime: MONSTER_HURT_HOLD_TIME });
    // The run threshold sits below the AI profile's advance speed (2.2 m/s) and above its circle speed (1.5 m/s).
    expect(GROVE_LOCOMOTION[ROOTLING]!.runThreshold).toBeLessThan(2.2);
    expect(GROVE_LOCOMOTION[ROOTLING]!.runThreshold).toBeGreaterThan(1.5);
    expect(resolveMonsterAnimation(monster({ velocity: { x: 1.5, y: 0, z: 0 } }), ROOTLING)!.actionId).toBe('monster-walk');
  });

  it('Koro only idles and walks: no walking pace ever selects the run clip', () => {
    for (const speed of [0, 0.2, 1, 1.4, 2, 3.5]) {
      const sample = resolveMonsterAnimation(monster({ id: 'grove-koro', archetypeId: 'grove-koro', species: 'macaque', allegiance: 'ally', velocity: { x: speed, y: 0, z: 0 } }), KORO)!;
      expect(sample.actionId).toBe(speed < 0.15 ? 'monster-idle' : 'monster-walk');
      expect(sample.loopRate).toBeGreaterThan(0);
    }
  });
});

describe('grove presentation has no flight', () => {
  it('registers no hover profile: both monsters draw on their simulation position', () => {
    expect(GROVE_HOVER).toEqual({});
    expect(MONSTER_HOVER[ROOTLING]).toBeUndefined();
    expect(MONSTER_HOVER[KORO]).toBeUndefined();
    expect(monsterHoverHeight(monster(), ROOTLING, 3)).toBe(0);
    expect(monsterHoverHeight(monster({ id: 'grove-koro' }), KORO, 3)).toBe(0);
    expect(monsterHoverHeight(attacking('sprig-seed-toss', 'commit', 0.5), ROOTLING, 3)).toBe(0);
  });
});
