import { describe, expect, it } from 'bun:test';
import { ATTACKS } from '../../src/game/combat/content.js';
import { CANOPY_COMBAT_TRIALS } from '../../src/game/combat/CombatTrials.js';
import {
  getWildlifePressure,
  scaleWildlifeAttack,
} from '../../src/game/combat/WildlifePressure.js';

describe('tier boundaries', () => {

  it('saturates at the final tier indefinitely', () => {
    expect(getWildlifePressure(3600).tier).toBe(3);
    expect(getWildlifePressure(99999).tier).toBe(3);
  });
});

describe('trial pacing per tier', () => {
  it('tightens the reposition window and starts chaining attacks only from tier 1', () => {
    const tiers = [0, 900, 1800, 3000].map(getWildlifePressure);
    expect(tiers.map(tier => tier.chainEvery > 0)).toEqual([false, true, true, true]);
    for (let index = 1; index < tiers.length; index++) {
      expect(tiers[index]!.repositionTicks).toBeLessThan(tiers[index - 1]!.repositionTicks);
      expect(tiers[index]!.maxConcurrent).toBeGreaterThanOrEqual(tiers[index - 1]!.maxConcurrent);
    }
  });
});

describe('scaleWildlifeAttack floors', () => {
  it('clamps a deliberately short authored warning to the reaction floors (windup 24, commit 8)', () => {
    const pressuring = getWildlifePressure(3600);
    const shortAttack = {
      ...ATTACKS['boar-charge']!,
      windupTicks: 12,
      commitTicks: 4,
      recoveryTicks: 8,
    };
    const scaled = scaleWildlifeAttack(shortAttack, pressuring);
    expect(scaled.windupTicks).toBe(24);
    expect(scaled.commitTicks).toBe(8);
    expect(scaled.recoveryTicks).toBeLessThan(shortAttack.recoveryTicks);
  });

  it('preserves a long committed reaction window at maximum pressure', () => {
    const attack = { ...ATTACKS['boar-charge']!, commitTicks: 30 };
    const scaled = scaleWildlifeAttack(attack, getWildlifePressure(3600));
    expect(scaled.commitTicks).toBe(30);
    expect(scaled.windupTicks).toBeLessThan(attack.windupTicks);
  });

  it('keeps every canopy attack readable at maximum pressure: windup never under 24 ticks, commit never under 8', () => {
    const maximum = getWildlifePressure(3600);
    for (const id of CANOPY_COMBAT_TRIALS.flatMap(trial => trial.attackIds)) {
      const authored = ATTACKS[id]!, scaled = scaleWildlifeAttack(authored, maximum);
      expect(scaled.windupTicks).toBeGreaterThanOrEqual(24);
      expect(scaled.commitTicks).toBeGreaterThanOrEqual(8);
      expect(scaled.windupTicks).toBeLessThanOrEqual(authored.windupTicks);
    }
  });
});
