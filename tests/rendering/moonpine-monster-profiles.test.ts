import { describe, expect, it } from 'bun:test';
import { MONSTER_HOVER, MONSTER_HURT_HOLD_TIME, ROAR_CLIP_WINDOW, monsterHoverHeight, resolveMonsterAnimation, resolveMonsterHitOverlay } from '../../src/rendering/MonsterAnimationProfiles.js';
import { MOONPINE_HOVER, MOONPINE_LOCOMOTION } from '../../src/rendering/MoonpineMonsterProfiles.js';
import { flinchAt } from './reaction-fixtures.js';
import type { ActorSnapshot } from '../../src/game/contracts.js';

const ASSET = { frostfang: 'actor-frostfang-tracker', scout: 'actor-howl-scout', ruun: 'actor-ruun-chained-howl' } as const;
const ACTOR_OF: Readonly<Record<string, { id: string; asset: string }>> = {
  frostfang: { id: 'moonpine-frostfang', asset: ASSET.frostfang }, 'howl-scout': { id: 'moonpine-scout', asset: ASSET.scout }, 'chained-ruun': { id: 'moonpine-ruun', asset: ASSET.ruun },
};
const ownerOf = (attackId: string) => ACTOR_OF[attackId.startsWith('howl-scout') ? 'howl-scout' : attackId.startsWith('chained-ruun') ? 'chained-ruun' : 'frostfang']!;


function monster(partial: Partial<ActorSnapshot> = {}): ActorSnapshot {
  return {
    id: 'moonpine-frostfang', archetypeId: 'actor-frostfang-tracker', species: 'wolf', allegiance: 'hostile', position: { x: -44, y: 0, z: -22 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: 1 },
    actionId: 'monster-idle', phase: 'idle', normalizedTime: 0, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false, ...partial,
  } as unknown as ActorSnapshot;
}
const attacking = (attackId: string, attackPhase: NonNullable<ActorSnapshot['attackPhase']>, progress: number): ActorSnapshot =>
  monster({ id: ownerOf(attackId).id, actionId: `wild-crown:${attackId}` as never, attackPhase, attackPhaseProgress: progress });

describe('moonpine monster clip plans', () => {
  it('animates every wolf asset: locomotion thresholds follow the AI speeds, with turning, hurt, roar and idle', () => {
    expect(Object.keys(MOONPINE_LOCOMOTION).sort()).toEqual(Object.values(ASSET).sort());
    for (const asset of Object.values(ASSET)) {
      const id = Object.values(ACTOR_OF).find(entry => entry.asset === asset)!.id;
      expect(resolveMonsterAnimation(monster({ id }), asset)).toMatchObject({ actionId: 'monster-idle', phase: 'idle' });
      expect(resolveMonsterAnimation(monster({ id, velocity: { x: 0.8, y: 0, z: 0 } }), asset)).toMatchObject({ actionId: 'monster-walk' });
      expect(resolveMonsterAnimation(monster({ id, velocity: { x: 6, y: 0, z: 0 } }), asset)).toMatchObject({ actionId: 'monster-run' });
      expect(resolveMonsterAnimation(monster({ id, yawRate: 1.5 }), asset)).toMatchObject({ actionId: 'monster-turn' });
      expect(resolveMonsterAnimation(monster({ id, roarProgress: 0.5 }), asset)).toMatchObject({ actionId: 'monster-roar', phase: 'active', normalizedTime: (ROAR_CLIP_WINDOW.from + ROAR_CLIP_WINDOW.to) / 2 });
      // A hit reaction is a native hurt overlay; the base clip keeps playing.
      expect(resolveMonsterAnimation(monster({ id, reaction: flinchAt(0.4) }), asset)).toMatchObject({ actionId: 'monster-idle' });
      expect(resolveMonsterHitOverlay(monster({ id, reaction: flinchAt(0.4) }), asset)).toMatchObject({ actionId: 'monster-hurt' });
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
