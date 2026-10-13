import { describe, expect, it } from 'bun:test';
import { CombatEngine, createEngineState, makeActor, type CombatInput, type EngineState, type LiveHazard } from '../../src/game/combat/CombatEngine.js';
import { vec } from '../../src/game/combat/geometry.js';
import { SIGIL } from '../../src/game/combat/PlayerSkills.js';
import { HEARTROOT } from '../../src/game/combat/HeartrootSkills.js';
import { HERO_COMBAT } from '../../src/game/combat/HeroProfiles.js';
import type { StoryCue } from '../../src/effects/story-cues.js';

import { ATTACKS } from '../../src/game/combat/content.js';
const idle: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
function bench(positions: readonly [number, number][] = []) {
  const seed = createEngineState();
  seed.arena.bounds = { min: vec(-30, -2, -30), max: vec(30, 20, 30) };
  seed.actors[0]!.facing = vec(0, 0, 1);
  for (const [index, [x, z]] of positions.entries()) {
    const actor = makeActor(('target-' + index) as never, 'boar', 'hostile', vec(x, 0, z), false, false, 1000);
    actor.ferocity = undefined;
    seed.actors.push(actor);
  }
  const engine = new CombatEngine(seed);
  engine.setPlayerHero('yara');
  // Test fixture access to the engine-owned live state, never an external payload.
  const internals = engine as unknown as { state: EngineState };
  const state = internals.state;
  const cues: StoryCue[] = [];
  const step = (patch: Partial<CombatInput> = {}, count = 1) => {
    for (let i = 0; i < count; i++) { engine.fixedStep({ ...idle, ...patch }); cues.push(...engine.drainPresentationCues()); }
  };
  return { engine, state, cues, step, health: (index: number) => state.actors[index + 1]!.vitality! };
}

describe('entry-only hero identity', () => {
  it('publishes Yara in the existing player slot and rejects changes in an encounter', () => {
    const engine = new CombatEngine();
    engine.loadRegion({ regionId: 'greenwake', runId: 'hero', presentActorIds: [] });
    engine.setPlayerHero('yara');
    expect(engine.snapshot().player.heroId).toBe('yara');
    expect(engine.snapshot().actors.find(actor => actor.id === 'aren')?.renderVariantId).toBe('actor-yara-hero');
    engine.startEncounter({ regionId: 'greenwake', runId: 'hero', encounterId: 'greenwake-boar' });
    expect(() => engine.setPlayerHero('aren')).toThrow('before starting an encounter');
    engine.resetToCheckpoint();
    expect(engine.snapshot().player.heroId).toBe('yara');
    expect(engine.snapshot().actors.find(actor => actor.id === 'aren')?.renderVariantId).toBe('actor-yara-hero');
    engine.startNewRun('fresh');
    expect(engine.snapshot().player.heroId).toBe('aren');
  });
});

describe('Heartroot spell behavior', () => {
  it('allows a targetless Root Spike while preserving mana and recovery restrictions', () => {
    const b = bench();
    expect(b.engine.snapshot().skills.find(skill => skill.id === 'heavy')?.available).toBe(true);
    b.step({ heavyPressed: true });
    expect(b.state.cast?.kind).toBe('root-spike');
    expect(b.engine.snapshot().skills.find(skill => skill.id === 'heavy')?.available).toBe(false);
    b.step({}, 100);
    b.state.player.mana = 0;
    expect(b.engine.snapshot().skills.find(skill => skill.id === 'heavy')?.available).toBe(false);
  });

  it('blocks incoming damage for the entire Bloom cast but not afterward', () => {
    const b = bench(), attack = ATTACKS['koro-fruit-burst']!;
    const hazard: LiveHazard = {
      ...structuredClone(attack.hazard), id: 'burst', attackId: attack.id,
      sourceId: 'koro', targetActorId: 'aren', startTick: 0, activeFrom: 3, activeUntil: 200,
      target: vec(0, 0, 0), origin: vec(0, 0, 0), direction: vec(0, 0, 1),
      width: 40, depth: 40, damage: 30, hitIds: [], threatTicks: [], cue: 'burst',
      bounds: { min: vec(-20, -1, -20), max: vec(20, 3, 20) },
    };
    b.state.hazards.push(hazard);
    b.state.player.instinct = 100;
    b.step({ ultimatePressed: true });
    b.step({}, HEARTROOT.bloomTicks - 2);
    expect(b.state.player.vitality).toBe(HERO_COMBAT.yara.maxVitality);
    b.step({}, 5);
    expect(b.state.player.vitality).toBe(HERO_COMBAT.yara.maxVitality - 30);
  });

  it('fires homing thorns at range without applying a melee swing', () => {
    const b = bench([[0, 7]]);
    b.step({ lightPressed: true });
    b.step({}, 9);
    expect(b.health(0)).toBe(1000);
    expect(b.state.playerProjectiles[0]?.kind).toBe('thorn-bolt');
    b.step({}, 70);
    expect(b.health(0)).toBe(1000 - HEARTROOT.thornDamage);
    expect(b.state.player.mana).toBe(100);
  });
  it('finishes its third Thornshot with an area burst and does not chain into Aren’s fourth slash', () => {
    const b = bench([[0, 5], [1.6, 5]]);
    b.state.lightIndex = 2; b.state.lightChainFrom = 0; b.state.lightChainUntil = 100;
    b.step({ lightPressed: true });
    expect(b.state.actors[0]!.actionId).toBe('yara-thornshot-3');
    b.step({}, 75);
    expect(b.health(0)).toBeLessThan(1000);
    expect(b.health(1)).toBeLessThan(1000);
    b.step({ lightPressed: true });
    expect(b.state.actors[0]!.actionId).toBe('yara-thornshot-1');
  });
  it('Sap Lance pierces aligned foes, misses off-lane foes and stops at walls', () => {
    const b = bench([[0, 4], [0, 7], [3, 6], [0, 12]]);
    b.state.arena.colliders.push({ id: 'wall', kind: 'box', from: vec(0, 1.5, 9), halfExtents: vec(4, 1.5, .3), blocksMovement: true, blocksCamera: true });
    b.step({ rangedPressed: true }); b.step({}, 40);
    expect(b.health(0)).toBe(1000 - HEARTROOT.lanceDamage);
    expect(b.health(1)).toBe(1000 - HEARTROOT.lanceDamage);
    expect(b.health(2)).toBe(1000);
    expect(b.health(3)).toBe(1000);
    expect(b.state.player.mana).toBe(100 - SIGIL.boltMana);
  });
  it('Seed Storm releases all six seeds for one charge cost', () => {
    const b = bench();
    b.step({ rangedPressed: true, rangedHeld: true });
    b.step({ rangedHeld: true }, SIGIL.barrageHoldTicks);
    b.step({ rangedReleased: true }); b.step({}, 65);
    expect(b.cues.filter(cue => cue.kind === 'projectile' && cue.actionId === 'storm-seed')).toHaveLength(6);
    expect(b.state.player.mana).toBe(100 - SIGIL.barrageMana);
  });
  it('dodge cancels a held Seed Storm and cannot release ghost seeds afterward', () => {
    const b = bench();
    b.step({ rangedPressed: true, rangedHeld: true });
    b.step({ rangedHeld: true }, 60);
    b.step({ dodgePressed: true });
    b.step({ rangedReleased: true }); b.step({}, 100);
    expect(b.cues.filter(cue => cue.kind === 'projectile')).toHaveLength(0);
    expect(b.state.player.mana).toBe(75);
  });
  it('Root Spike damages its forward lane, while a charged eruption targets a disk at range', () => {
    const lane = bench([[0, 6], [3, 6]]);
    lane.step({ heavyPressed: true }); lane.step({}, 75);
    expect(lane.health(0)).toBe(1000 - HEARTROOT.spikeDamage);
    expect(lane.health(1)).toBe(1000);
    const disk = bench([[0, 7], [2, 7], [5, 7]]);
    disk.step({ heavyPressed: true, heavyHeld: true }); disk.step({ heavyHeld: true }, 50);
    disk.step({ heavyReleased: true, heavyHeldTicks: 50 }); disk.step({}, 90);
    expect(disk.health(0)).toBe(1000 - HEARTROOT.eruptionDamage);
    expect(disk.health(1)).toBe(1000 - HEARTROOT.eruptionDamage);
    expect(disk.health(2)).toBe(1000);
  });
  it('Heartroot Bloom spends full Instinct, stays stationary and damages only its bounded area without cleansing', () => {
    const b = bench([[0, 5], [0, 14]]);
    b.state.player.instinct = 99;
    b.step({ ultimatePressed: true }); expect(b.state.cast).toBeUndefined();
    b.state.player.instinct = 100;
    b.state.actors[1]!.corruption = 80;
    const start = { ...b.state.actors[0]!.position };
    b.step({ ultimatePressed: true });
    expect(b.state.player.instinct).toBe(0);
    b.step({ move: vec(1, 0, 0), dodgePressed: true }, HEARTROOT.bloomTicks - 1);
    expect(b.state.actors[0]!.position).toEqual(start);
    expect(b.health(0)).toBeLessThan(1000);
    expect(b.health(1)).toBe(1000);
    expect(b.state.actors[1]!.corruption).toBe(80);
  });
  it('pause freezes a pending eruption instead of applying its damage', () => {
    const b = bench([[0, 6]]);
    b.step({ heavyPressed: true });
    b.engine.setTimePolicy('paused'); b.step({}, 100);
    expect(b.health(0)).toBe(1000);
    b.engine.setTimePolicy('normal'); b.step({}, 75);
    expect(b.health(0)).toBeLessThan(1000);
  });
});
