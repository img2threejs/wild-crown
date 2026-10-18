import { describe, expect, it } from 'bun:test';
import { MONSTER_HOVER, MONSTER_HURT_HOLD_TIME, ROAR_CLIP_WINDOW, monsterHoverHeight, resolveMonsterAnimation, resolveMonsterHitOverlay } from '../../src/rendering/MonsterAnimationProfiles.js';
import { MISTVEIL_HOVER, MISTVEIL_LOCOMOTION } from '../../src/rendering/MistveilMonsterProfiles.js';
import { flinchAt } from './reaction-fixtures.js';
import type { ActorSnapshot } from '../../src/game/contracts.js';

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

describe('mistveil monster clip plans', () => {
  it('uses the shared slot logic for locomotion, turning, hurt, roar and idle on the new assets', () => {
    for (const asset of Object.values(ASSET)) {
      const id = Object.entries(ACTOR_ASSET).find(([, value]) => value === asset)![0];
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
