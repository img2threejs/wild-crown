import { describe, expect, it } from 'bun:test';
import {
  MONSTER_HOVER, MONSTER_HURT_HOLD_TIME, ROAR_CLIP_WINDOW, monsterHoverHeight, resolveMonsterAnimation, resolveMonsterHitOverlay,
} from '../../src/rendering/MonsterAnimationProfiles.js';
import { GROVE_HOVER, GROVE_LOCOMOTION } from '../../src/rendering/GroveMonsterProfiles.js';
import { MONSTER_PROFILES } from '../../src/game/combat/WildlifePressure.js';
import { flinchAt } from './reaction-fixtures.js';
import type { ActorSnapshot } from '../../src/game/contracts.js';

const ROOTLING = 'actor-grove-rootling', BLIGHTED = 'actor-grove-blighted-rootling', GUARDIAN = 'actor-grove-hollowheart', KORO = 'actor-koro';

function monster(partial: Partial<ActorSnapshot> = {}): ActorSnapshot {
  return {
    id: 'grove-sprig', archetypeId: 'grove-sprig', species: 'rootling', allegiance: 'hostile', position: { x: -24, y: 0, z: -26 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: 1 },
    actionId: 'monster-idle', phase: 'idle', normalizedTime: 0, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false, ...partial,
  } as unknown as ActorSnapshot;
}
const attacking = (attackId: string, attackPhase: NonNullable<ActorSnapshot['attackPhase']>, progress: number): ActorSnapshot =>
  monster({ actionId: `wild-crown:${attackId}` as never, attackPhase, attackPhaseProgress: progress });

describe('grove locomotion', () => {
  it('has a locomotion entry for every Grove actor asset (without one a monster never animates)', () => {
    expect(Object.keys(GROVE_LOCOMOTION).sort()).toEqual([ROOTLING, BLIGHTED, GUARDIAN, KORO].sort());
    for (const asset of [ROOTLING, BLIGHTED, GUARDIAN, KORO]) {
      expect(resolveMonsterAnimation(monster({ archetypeId: asset }), asset)).toMatchObject({ actionId: 'monster-idle', phase: 'idle' });
      expect(GROVE_LOCOMOTION[asset]!.walkRef).toBeGreaterThan(0);
      expect(GROVE_LOCOMOTION[asset]!.runRef).toBeGreaterThan(GROVE_LOCOMOTION[asset]!.walkRef);
    }
  });

  it('puts each run threshold between its AI profile\'s circle and advance speeds: the twin runs whenever it circles, the guardian only when it advances', () => {
    const speeds = (id: string) => [MONSTER_PROFILES[id]!.circleSpeed, MONSTER_PROFILES[id]!.advanceSpeed] as const;
    const [twinCircle, twinAdvance] = speeds('grove-blighted'), [guardCircle, guardAdvance] = speeds('grove-hollowheart');
    expect(GROVE_LOCOMOTION[BLIGHTED]!.runThreshold).toBeLessThan(twinCircle);
    expect(GROVE_LOCOMOTION[BLIGHTED]!.runRef).toBe(twinAdvance);
    expect(GROVE_LOCOMOTION[GUARDIAN]!.runThreshold).toBeGreaterThan(guardCircle);
    expect(GROVE_LOCOMOTION[GUARDIAN]!.runThreshold).toBeLessThan(guardAdvance);
    expect(resolveMonsterAnimation(monster({ velocity: { x: twinCircle, y: 0, z: 0 } }), BLIGHTED)!.actionId).toBe('monster-run');
    expect(resolveMonsterAnimation(monster({ velocity: { x: guardCircle, y: 0, z: 0 } }), GUARDIAN)!.actionId).toBe('monster-walk');
    expect(resolveMonsterAnimation(monster({ velocity: { x: guardAdvance, y: 0, z: 0 } }), GUARDIAN)!.actionId).toBe('monster-run');
  });

  it('uses the shared slot logic for the sprig: walk, run, turn, roar, hurt and idle', () => {
    expect(resolveMonsterAnimation(monster({ velocity: { x: 0.8, y: 0, z: 0 } }), ROOTLING)).toMatchObject({ actionId: 'monster-walk' });
    expect(resolveMonsterAnimation(monster({ velocity: { x: 2.3, y: 0, z: 0 } }), ROOTLING)).toMatchObject({ actionId: 'monster-run' });
    expect(resolveMonsterAnimation(monster({ yawRate: 1.5 }), ROOTLING)).toMatchObject({ actionId: 'monster-turn' });
    expect(resolveMonsterAnimation(monster({ roarProgress: 0.5 }), ROOTLING)).toMatchObject({ actionId: 'monster-roar', phase: 'active', normalizedTime: (ROAR_CLIP_WINDOW.from + ROAR_CLIP_WINDOW.to) / 2 });
    // A hit reaction is a native hurt overlay; the base clip keeps playing.
    expect(resolveMonsterAnimation(monster({ reaction: flinchAt(0.4) }), ROOTLING)).toMatchObject({ actionId: 'monster-idle' });
    expect(resolveMonsterHitOverlay(monster({ reaction: flinchAt(0.4) }), ROOTLING)).toMatchObject({ actionId: 'monster-hurt' });
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
