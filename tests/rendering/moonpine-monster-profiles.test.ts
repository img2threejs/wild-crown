import { describe, expect, it } from 'bun:test';
import { MONSTER_HOVER, MONSTER_HURT_HOLD_TIME, ROAR_CLIP_WINDOW, monsterHoverHeight, resolveMonsterAnimation } from '../../src/rendering/MonsterAnimationProfiles.js';
import { MOONPINE_ATTACK_PLANS, MOONPINE_HOVER, MOONPINE_LOCOMOTION } from '../../src/rendering/MoonpineMonsterProfiles.js';
import type { MonsterAttackPlan } from '../../src/rendering/MonsterAnimationPlan.js';
import { MOONPINE_COMBAT_TRIALS } from '../../src/game/combat/MoonpineContent.js';
import type { ActorSnapshot } from '../../src/game/contracts.js';

const PHASES = ['windup', 'commit', 'active', 'recovery'] as const;
const ASSET = { frostfang: 'actor-frostfang-tracker', scout: 'actor-howl-scout', ruun: 'actor-ruun-chained-howl' } as const;
const ACTOR_OF: Readonly<Record<string, { id: string; asset: string }>> = {
  frostfang: { id: 'moonpine-frostfang', asset: ASSET.frostfang }, 'howl-scout': { id: 'moonpine-scout', asset: ASSET.scout }, 'chained-ruun': { id: 'moonpine-ruun', asset: ASSET.ruun },
};
const ownerOf = (attackId: string) => ACTOR_OF[attackId.startsWith('howl-scout') ? 'howl-scout' : attackId.startsWith('chained-ruun') ? 'chained-ruun' : 'frostfang']!;

const ATTACK_IDS = MOONPINE_COMBAT_TRIALS.flatMap(trial => trial.attackIds);

function monster(partial: Partial<ActorSnapshot> = {}): ActorSnapshot {
  return {
    id: 'moonpine-frostfang', archetypeId: 'actor-frostfang-tracker', species: 'wolf', allegiance: 'hostile', position: { x: -44, y: 0, z: -22 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: 1 },
    actionId: 'monster-idle', phase: 'idle', normalizedTime: 0, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false, ...partial,
  } as unknown as ActorSnapshot;
}
const attacking = (attackId: string, attackPhase: NonNullable<ActorSnapshot['attackPhase']>, progress: number): ActorSnapshot =>
  monster({ id: ownerOf(attackId).id, actionId: `wild-crown:${attackId}` as never, attackPhase, attackPhaseProgress: progress });

describe('moonpine monster clip plans', () => {
  it('finite plans run the clip forward through contiguous phase windows that end at the clip end', () => {
    for (const attackId of ATTACK_IDS.filter(id => id !== 'frostfang-pack-rush')) {
      const plan = MOONPINE_ATTACK_PLANS[attackId] as MonsterAttackPlan;
      let previousTo = -1;
      for (const phase of PHASES) {
        const step = plan[phase];
        if ('loopRate' in step) throw new Error(`${attackId}: unexpected loop`);
        expect(step.from).toBeGreaterThanOrEqual(0);
        expect(step.to).toBeLessThanOrEqual(1);
        expect(step.to).toBeGreaterThan(step.from);
        if (previousTo >= 0) expect(step.from).toBeCloseTo(previousTo, 9);
        previousTo = step.to;
      }
      expect(previousTo).toBe(1);
    }
    const rush = MOONPINE_ATTACK_PLANS['frostfang-pack-rush']!;
    const active = rush.active, recovery = rush.recovery;
    if ('loopRate' in active || 'loopRate' in recovery) throw new Error('rush active and recovery play the dive clip');
    expect(recovery.from).toBeCloseTo(active.to, 9);
    expect(recovery.to).toBe(1);
  });

  it('lands the visible strike on the active window: the clip pose at the active start is the strike pose', () => {
    const strikeStart: Readonly<Record<string, number>> = {
      // dive strike ~0.4 (the rush opens its dive at 0.3 as the lane starts, the stamp at 0.38), slash strike pose ~0.45, jump lands 0.7-0.85,
      // shoot expels ~0.5 (the breath leaves in commit and lands as active opens), the roar's held note sits 0.4-0.8.
      'frostfang-pack-rush': 0.3, 'frostfang-ice-bite': 0.45, 'frostfang-frost-breath': 0.66,
      'howl-scout-flank-pounce': 0.7, 'howl-scout-claw-rake': 0.45, 'howl-scout-low-howl': 0.4,
      'chained-ruun-chain-pounce': 0.68, 'chained-ruun-howl-shockwave': 0.45, 'chained-ruun-breaking-ice': 0.38,
    };
    for (const [attackId, expected] of Object.entries(strikeStart)) {
      const owner = ownerOf(attackId);
      const active = resolveMonsterAnimation(attacking(attackId, 'active', 0), owner.asset)!;
      expect(active, attackId).toBeDefined();
      expect(active.phase).toBe('active');
      expect(active.normalizedTime).toBeCloseTo(expected, 6);
    }
    // The shoot clip's expel (~0.5) is reached at the start of commit, so the visible breath precedes the hazard.
    expect(resolveMonsterAnimation(attacking('frostfang-frost-breath', 'commit', 0), ASSET.frostfang)!.normalizedTime).toBeCloseTo(0.5, 6);
    // The roar clip holds the note through the active window, then eases out in recovery.
    for (const attackId of ['howl-scout-low-howl', 'chained-ruun-howl-shockwave']) {
      const owner = ownerOf(attackId);
      expect(resolveMonsterAnimation(attacking(attackId, 'active', 1), owner.asset)!.normalizedTime).toBeCloseTo(0.8, 6);
      expect(resolveMonsterAnimation(attacking(attackId, 'recovery', 1), owner.asset)!.normalizedTime).toBe(1);
    }
    // The rush revs the run cycle on the actor clock before the lunge.
    const rev = resolveMonsterAnimation(attacking('frostfang-pack-rush', 'commit', 0.5), ASSET.frostfang)!;
    expect(rev).toMatchObject({ actionId: 'monster-run', phase: 'idle' });
    expect(rev.loopRate).toBeGreaterThan(1);
  });

  it('plays every phase of every attack inside the clip range', () => {
    for (const attackId of ATTACK_IDS) for (const phase of PHASES) for (const progress of [0, 0.25, 0.5, 1]) {
      const sample = resolveMonsterAnimation(attacking(attackId, phase, progress), ownerOf(attackId).asset)!;
      expect(sample.normalizedTime).toBeGreaterThanOrEqual(0);
      expect(sample.normalizedTime).toBeLessThanOrEqual(1);
      expect(sample.loopRate).toBeGreaterThan(0);
    }
  });

  it('animates every wolf asset: locomotion thresholds follow the AI speeds, with turning, hurt, roar and idle', () => {
    expect(Object.keys(MOONPINE_LOCOMOTION).sort()).toEqual(Object.values(ASSET).sort());
    for (const asset of Object.values(ASSET)) {
      const id = Object.values(ACTOR_OF).find(entry => entry.asset === asset)!.id;
      expect(resolveMonsterAnimation(monster({ id }), asset)).toMatchObject({ actionId: 'monster-idle', phase: 'idle' });
      expect(resolveMonsterAnimation(monster({ id, velocity: { x: 0.8, y: 0, z: 0 } }), asset)).toMatchObject({ actionId: 'monster-walk' });
      expect(resolveMonsterAnimation(monster({ id, velocity: { x: 6, y: 0, z: 0 } }), asset)).toMatchObject({ actionId: 'monster-run' });
      expect(resolveMonsterAnimation(monster({ id, yawRate: 1.5 }), asset)).toMatchObject({ actionId: 'monster-turn' });
      expect(resolveMonsterAnimation(monster({ id, roarProgress: 0.5 }), asset)).toMatchObject({ actionId: 'monster-roar', phase: 'active', normalizedTime: (ROAR_CLIP_WINDOW.from + ROAR_CLIP_WINDOW.to) / 2 });
      expect(resolveMonsterAnimation(monster({ id, hitReact: 0.4 }), asset)).toMatchObject({ actionId: 'monster-hurt' });
      expect(resolveMonsterAnimation(monster({ id, downed: true }), asset)).toMatchObject({ actionId: 'monster-hurt', phase: 'active', normalizedTime: MONSTER_HURT_HOLD_TIME });
      expect(resolveMonsterAnimation(monster({ id, weakPointExposed: true }), asset)).toMatchObject({ actionId: 'monster-hurt', phase: 'active', normalizedTime: MONSTER_HURT_HOLD_TIME });
    }
    // Run threshold scales with each AI profile's advance speed (tracker 4.6, scout 5.6, Ruun 2.8 m/s).
    expect(resolveMonsterAnimation(monster({ velocity: { x: 3, y: 0, z: 0 } }), ASSET.frostfang)!.actionId).toBe('monster-walk');
    expect(resolveMonsterAnimation(monster({ velocity: { x: 3.6, y: 0, z: 0 } }), ASSET.scout)!.actionId).toBe('monster-walk');
    expect(resolveMonsterAnimation(monster({ velocity: { x: 2.4, y: 0, z: 0 } }), ASSET.ruun)!.actionId).toBe('monster-run');
    // Walk and run cycles scale with speed and stay within the loop-rate clamp.
    const slow = resolveMonsterAnimation(monster({ velocity: { x: 1, y: 0, z: 0 } }), ASSET.frostfang)!, quick = resolveMonsterAnimation(monster({ velocity: { x: 2.3, y: 0, z: 0 } }), ASSET.frostfang)!;
    expect(quick.loopRate).toBeGreaterThan(slow.loopRate);
  });
});

describe('moonpine monsters stay on the ground', () => {
  it('no wolf hovers: the hover table has no Moonpine asset and every wolf draws on its simulation position', () => {
    expect(MOONPINE_HOVER).toEqual({});
    for (const asset of Object.values(ASSET)) {
      expect(MONSTER_HOVER[asset]).toBeUndefined();
      expect(monsterHoverHeight(monster(), asset, 12.3)).toBe(0);
      expect(monsterHoverHeight(attacking('frostfang-pack-rush', 'active', 0.5), asset, 12.3)).toBe(0);
    }
  });
});
