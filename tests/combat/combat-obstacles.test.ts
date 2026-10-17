import { describe, expect, it } from 'bun:test';
import { CombatEngine, createEngineState, makeActor, type CombatInput } from '../../src/game/combat/CombatEngine.js';
import { WILDLIFE_ENCOUNTERS } from '../../src/game/combat/content.js';
import { moveCircle, moveAerialCircle, vec } from '../../src/game/combat/geometry.js';

const idle: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
function cast(attackId = 'sap-stalker-frost-bloom') {
  const engine = new CombatEngine();
  engine.startEncounter({ encounterId: 'greenwake-boar', regionId: 'greenwake', runId: 'solid-skills', actors: [makeActor('aren', 'human', 'player', vec(0, 0, 0), false, false, 1000), makeActor('corrupted-boar', 'boar', 'hostile', vec(0, 0, -5), true, false, 100), makeActor('greenwake-sap-stalker', 'boar', 'hostile', vec(-5, 0, 0), true, false, 100, 'corrupted-boar'), makeActor('greenwake-root-rammer', 'boar', 'hostile', vec(5, 0, 0), true, false, 100, 'corrupted-boar')] });
  const state = engine.snapshotState(); state.arena = createEngineState().arena; state.arena.bounds = { min: vec(-30, -1, -30), max: vec(30, 12, 30) }; state.player.vitality = state.player.maxVitality = 1000; state.encounter!.phases = [{ id: 'physical-skills', attackIds: [attackId] }];
  const caster = new CombatEngine(state); caster.fixedStep(idle);
  const committed = caster.snapshotState(); committed.encounter = null;
  return new CombatEngine(committed);
}
function until(engine: CombatEngine, tick: number) { while (engine.snapshotState().worldTick < tick) engine.fixedStep(idle); }
function recast(engine: CombatEngine, attackId: string): CombatEngine {
  const state = engine.snapshotState(); state.encounter = structuredClone(WILDLIFE_ENCOUNTERS['greenwake-boar']!); state.encounter.phases = [{ id: 'next-cast', attackIds: [attackId] }]; state.phaseIndex = 0; state.lastAttackTick = 0; state.greenwakeCombat = { engagedTicks: 0, sourceCursor: 0, attackCursors: {} }; return new CombatEngine(state);
}

describe('committed combat solids', () => {
  it('creates no warning collider, then actual ice blocks grounded/aerial crossing while leaving a central escape path', () => {
    const engine = cast(), activeAt = engine.snapshotState().hazards[0]!.activeFrom;
    until(engine, activeAt - 1); expect(engine.snapshot().combatObstacles).toEqual([]);
    engine.fixedStep(idle); const state = engine.snapshotState();
    const barrier = moveCircle(state.arena, vec(0, 0, -4), vec(0, 0, 8), 0.42, 1.6);
    expect(barrier.z).toBeLessThan(-1.9);
    expect(moveAerialCircle(state.arena, vec(0, 0.8, -4), vec(0, 0, 8), 0.42, 1.6).z).toBeLessThan(-1.9);
    expect(moveCircle(state.arena, vec(-3, 0, 0), vec(6, 0, 0), 0.42, 1.6).x).toBeCloseTo(3);
    const solid = state.combatObstacles[0]!; expect(solid.kind).toBe('ice'); expect(solid.spawnedAtWorldTick).toBe(activeAt);
  });

  it('a later perpendicular root skill cannot complete a cage around the player', () => {
    const engine = cast(); until(engine, engine.snapshotState().hazards[0]!.activeFrom);
    const next = recast(engine, 'boar-charge'); next.fixedStep(idle);
    const root = next.snapshotState().hazards.find(hazard => hazard.attackId === 'boar-charge')!;
    until(next, root.activeFrom);
    expect(moveCircle(next.snapshotState().arena, vec(0, 0, 0), vec(3, 0, 0), 0.42, 1.6).x).toBeCloseTo(3);
  });

  it('wind push uses the same obstacle collision sweep rather than displacing Aren through the pillar', () => {
    const engine = cast(); until(engine, engine.snapshotState().hazards[0]!.activeFrom);
    const seeded = engine.snapshotState(); seeded.actors.find(actor => actor.id === 'aren')!.position = vec(0, 0, -3);
    const next = recast(new CombatEngine(seeded), 'boar-gale-scythe'); next.fixedStep(idle);
    const wind = next.snapshotState().hazards.find(hazard => hazard.attackId === 'boar-gale-scythe')!;
    until(next, wind.activeFrom + 40);
    const position = next.snapshot().actors.find(actor => actor.id === 'aren')!.position;
    expect(position.z).toBeGreaterThan(-3); expect(position.z).toBeLessThan(-1.95);
  });

  it('preserves physical lifetime through pause/save/restore and removes the collider exactly at expiry', () => {
    const engine = cast(); until(engine, engine.snapshotState().hazards[0]!.activeFrom);
    const expires = engine.snapshotState().combatObstacles[0]!.expiresAtWorldTick;
    engine.setTimePolicy('paused'); const before = engine.serialize(); for (let i = 0; i < 120; i++) engine.fixedStep(idle); expect(engine.serialize()).toBe(before);
    const restored = new CombatEngine(); restored.restore(engine.serialize()); restored.setTimePolicy('normal');
    until(restored, expires - 1); expect(moveCircle(restored.snapshotState().arena, vec(0, 0, -4), vec(0, 0, 8), 0.42, 1.6).z).toBeLessThan(-1.9);
    restored.fixedStep(idle); expect(moveCircle(restored.snapshotState().arena, vec(0, 0, -4), vec(0, 0, 8), 0.42, 1.6).z).toBeCloseTo(4);
  });

  it('checkpoint and local completion clear temporary mass but retain actual scene walls', () => {
    for (const terminal of ['checkpoint', 'stage'] as const) {
      const engine = cast(); engine.setSceneColliders([{ id: 'native:wall', kind: 'box', from: vec(3, 2, 0), halfExtents: vec(0.1, 2, 4), blocksMovement: true, blocksCamera: true }]);
      until(engine, engine.snapshotState().hazards[0]!.activeFrom);
      if (terminal === 'checkpoint') engine.resetToCheckpoint(); else engine.finishLocalStage();
      const state = engine.snapshotState(); expect(state.combatObstacles).toEqual([]);
      expect(moveCircle(state.arena, vec(0, 0, 0), vec(6, 0, 0), 0.42, 1.6).x).toBeLessThan(2.5);
    }
  });
});
