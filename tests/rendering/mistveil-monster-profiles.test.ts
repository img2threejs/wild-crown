import { describe, expect, it } from 'bun:test';
import { MONSTER_HOVER, MONSTER_HURT_HOLD_TIME, ROAR_CLIP_WINDOW, monsterHoverHeight, resolveMonsterAnimation } from '../../src/rendering/MonsterAnimationProfiles.js';
import { MISTVEIL_ATTACK_PLANS, MISTVEIL_HOVER, MISTVEIL_LOCOMOTION } from '../../src/rendering/MistveilMonsterProfiles.js';
import type { MonsterAttackPlan } from '../../src/rendering/MonsterAnimationPlan.js';
import type { ActorSnapshot } from '../../src/game/contracts.js';

const PHASES = ['windup', 'commit', 'active', 'recovery'] as const;
const ASSET = { lurker: 'actor-bog-lurker', heron: 'actor-lantern-heron', ghor: 'actor-ghor-mire-maw' } as const;
const ACTOR_ASSET: Readonly<Record<string, string>> = { 'mistveil-lurker': ASSET.lurker, 'mistveil-heron': ASSET.heron, 'mistveil-ghor': ASSET.ghor };
const ACTOR_OF = (attackId: string): string => attackId.startsWith('bog-lurker') ? 'mistveil-lurker' : attackId.startsWith('lantern-heron') ? 'mistveil-heron' : 'mistveil-ghor';

function monster(partial: Partial<ActorSnapshot> & { id?: string } = {}): ActorSnapshot {
  return {
    id: 'mistveil-heron', archetypeId: 'actor-lantern-heron', species: 'heron', allegiance: 'hostile', position: { x: 14, y: 0, z: -17 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: 1 },
    actionId: 'monster-idle', phase: 'idle', normalizedTime: 0, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false, ...partial,
  } as unknown as ActorSnapshot;
}
const attacking = (attackId: string, attackPhase: NonNullable<ActorSnapshot['attackPhase']>, progress: number): ActorSnapshot =>
  monster({ id: ACTOR_OF(attackId), actionId: `wild-crown:${attackId}` as never, attackPhase, attackPhaseProgress: progress });
const sampleOf = (attackId: string, phase: typeof PHASES[number], progress: number) => resolveMonsterAnimation(attacking(attackId, phase, progress), ACTOR_ASSET[ACTOR_OF(attackId)]!)!;

describe('mistveil monster clip plans', () => {
  it('finite plans run the clip forward through contiguous phase windows that end at the clip end', () => {
    for (const attackId of Object.keys(MISTVEIL_ATTACK_PLANS)) {
      const plan = MISTVEIL_ATTACK_PLANS[attackId] as MonsterAttackPlan;
      const steps = PHASES.map(phase => plan[phase]);
      if (steps.some(step => 'loopRate' in step)) throw new Error(`${attackId}: Mistveil attacks play finite clip windows`);
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
      // shoot expels ~0.5 (the tongue / bubbles leave in commit and land as active opens)
      'bog-lurker-tongue-lash': 0.58, 'bog-lurker-bubble-pool': 0.62,
      // slash strike pose ~0.45, dive strike ~0.4, jump lands 0.7-0.85, the roar's head tops out ~0.4
      'lantern-heron-mist-gust': 0.45, 'lantern-heron-spear-dive': 0.36, 'mire-maw-bite-lunge': 0.38, 'bog-lurker-mud-hop': 0.7, 'mire-maw-black-river-wave': 0.68, 'lantern-heron-flare-burst': 0.4,
    };
    for (const [attackId, expected] of Object.entries(strikeStart)) {
      const active = sampleOf(attackId, 'active', 0);
      expect(active.phase).toBe('active');
      expect(active.normalizedTime).toBeCloseTo(expected, 6);
    }
    // The shoot clip's expel (~0.5) is reached within the commit window, so the visible tongue / spit precedes the hazard.
    for (const attackId of ['bog-lurker-tongue-lash', 'bog-lurker-bubble-pool']) {
      const start = sampleOf(attackId, 'commit', 0).normalizedTime, end = sampleOf(attackId, 'commit', 1).normalizedTime;
      expect(start).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(end).toBeGreaterThanOrEqual(0.5);
    }
  });

  it('plays every phase of every Mistveil attack inside the clip range', () => {
    for (const attackId of Object.keys(MISTVEIL_ATTACK_PLANS)) for (const phase of PHASES) for (const progress of [0, 0.25, 0.5, 1]) {
      const sample = sampleOf(attackId, phase, progress);
      expect(sample.normalizedTime).toBeGreaterThanOrEqual(0);
      expect(sample.normalizedTime).toBeLessThanOrEqual(1);
      expect(sample.loopRate).toBeGreaterThan(0);
    }
  });

  it('uses the shared slot logic for locomotion, turning, hurt, roar and idle on the new assets', () => {
    for (const asset of Object.values(ASSET)) {
      const id = Object.entries(ACTOR_ASSET).find(([, value]) => value === asset)![0];
      expect(resolveMonsterAnimation(monster({ id }), asset)).toMatchObject({ actionId: 'monster-idle', phase: 'idle' });
      expect(resolveMonsterAnimation(monster({ id, velocity: { x: 0.8, y: 0, z: 0 } }), asset)).toMatchObject({ actionId: 'monster-walk' });
      expect(resolveMonsterAnimation(monster({ id, velocity: { x: 6, y: 0, z: 0 } }), asset)).toMatchObject({ actionId: 'monster-run' });
      expect(resolveMonsterAnimation(monster({ id, yawRate: 1.5 }), asset)).toMatchObject({ actionId: 'monster-turn' });
      expect(resolveMonsterAnimation(monster({ id, roarProgress: 0.5 }), asset)).toMatchObject({ actionId: 'monster-roar', phase: 'active', normalizedTime: (ROAR_CLIP_WINDOW.from + ROAR_CLIP_WINDOW.to) / 2 });
      expect(resolveMonsterAnimation(monster({ id, hitReact: 0.4 }), asset)).toMatchObject({ actionId: 'monster-hurt' });
      expect(resolveMonsterAnimation(monster({ id, downed: true }), asset)).toMatchObject({ actionId: 'monster-hurt', phase: 'active', normalizedTime: MONSTER_HURT_HOLD_TIME });
      expect(resolveMonsterAnimation(monster({ id, weakPointExposed: true }), asset)).toMatchObject({ actionId: 'monster-hurt', phase: 'active', normalizedTime: MONSTER_HURT_HOLD_TIME });
    }
    // Every monster asset has a locomotion entry (without it the monster never animates).
    expect(Object.keys(MISTVEIL_LOCOMOTION).sort()).toEqual(Object.values(ASSET).sort());
    // Run thresholds follow each AI profile's advance speed (lurker 3.4, heron 4.4, Ghor 2.2 m/s).
    expect(resolveMonsterAnimation(monster({ velocity: { x: 3, y: 0, z: 0 } }), ASSET.lurker)!.actionId).toBe('monster-run');
    expect(resolveMonsterAnimation(monster({ velocity: { x: 2.4, y: 0, z: 0 } }), ASSET.lurker)!.actionId).toBe('monster-walk');
    expect(resolveMonsterAnimation(monster({ velocity: { x: 3, y: 0, z: 0 } }), ASSET.heron)!.actionId).toBe('monster-walk');
    expect(resolveMonsterAnimation(monster({ velocity: { x: 3.6, y: 0, z: 0 } }), ASSET.heron)!.actionId).toBe('monster-run');
    expect(resolveMonsterAnimation(monster({ velocity: { x: 1.2, y: 0, z: 0 } }), ASSET.ghor)!.actionId).toBe('monster-walk');
    expect(resolveMonsterAnimation(monster({ velocity: { x: 2, y: 0, z: 0 } }), ASSET.ghor)!.actionId).toBe('monster-run');
    // A slow heavy crocodile never plays its walk loop faster than a quick hopper.
    expect(MISTVEIL_LOCOMOTION[ASSET.ghor]!.runRef).toBeLessThan(MISTVEIL_LOCOMOTION[ASSET.lurker]!.runRef);
  });

  it('no Mistveil monster hovers: the Lantern Heron is a ground-bound wader drawn on its simulation position', () => {
    expect(MISTVEIL_HOVER).toEqual({});
    for (const asset of Object.values(ASSET)) {
      expect(MONSTER_HOVER[asset]).toBeUndefined();
      expect(monsterHoverHeight(monster({ id: Object.entries(ACTOR_ASSET).find(([, value]) => value === asset)![0] }), asset, 3.7)).toBe(0);
    }
    expect(monsterHoverHeight(attacking('lantern-heron-spear-dive', 'commit', 0.5), ASSET.heron, 3.7)).toBe(0);
  });
});
