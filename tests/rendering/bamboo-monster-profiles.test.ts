import { describe, expect, it } from 'bun:test';
import { isMonsterDefeated } from '../../src/rendering/MonsterAnimationProfiles';
import type { ActorSnapshot } from '../../src/game/contracts';


function actor(partial: Partial<ActorSnapshot> = {}): ActorSnapshot {
  return {
    id: 'asha', archetypeId: 'asha', species: 'tiger', allegiance: 'hostile', position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: 1 },
    actionId: 'monster-idle', phase: 'idle', normalizedTime: 0, vitality: 100, maxVitality: 100, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false, ...partial,
  } as unknown as ActorSnapshot;
}

describe('a story status is never a defeat', () => {
  it('keeps a cleansed, reunited, subdued or sheltered actor alive whatever its vitality', () => {
    for (const status of ['cleansed', 'reunion', 'subdued', 'kneeling', 'in-danger', 'sheltered'] as const) {
      expect(isMonsterDefeated(actor({ vitality: 0, chapterStatus: status })), status).toBe(false);
    }
    expect(isMonsterDefeated(actor({ vitality: 0 }))).toBe(true);
    expect(isMonsterDefeated(actor({ vitality: 0, chapterStatus: 'sealed' }))).toBe(true);
  });
});
