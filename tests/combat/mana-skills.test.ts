import { describe, expect, it } from 'bun:test';
import { CombatEngine, createEngineState, makeActor, type CombatInput } from '../../src/game/combat/CombatEngine.js';
import { distance2, vec } from '../../src/game/combat/geometry.js';
import { MANA_PER_METRE, PLAYER_SKILLS } from '../../src/game/combat/PlayerSkills.js';
const idle: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
function engineWithMana(mana: number): CombatEngine { const seed = createEngineState(); seed.player.mana = mana; return new CombatEngine(seed); }
const position = (engine: CombatEngine) => engine.snapshot().actors.find(actor => actor.id === 'aren')!.position;
const mana = (engine: CombatEngine) => engine.snapshot().player.mana;
const ready = (engine: CombatEngine, id: string) => engine.snapshot().skills.find(skill => skill.id === id)!;

describe('movement-earned mana and authoritative skill readiness', () => {
  it('earns mana from actual Walk and Run distance, not idle time or pushing into walls', () => {
    for (const sprintHeld of [false, true]) {
      const engine = engineWithMana(0), start = position(engine);
      for (let tick = 0; tick < 60; tick++) engine.fixedStep({ ...idle, move: vec(1, 0, 0), sprintHeld });
      expect(mana(engine)).toBeCloseTo(distance2(start, position(engine)) * MANA_PER_METRE, 8);
      for (let tick = 0; tick < 60; tick++) engine.fixedStep({ ...idle, move: vec(1, 0, 0), sprintHeld });
      engine.setSceneColliders([{ id: 'wall', kind: 'box', from: vec(position(engine).x + 0.62, 2, 0), halfExtents: vec(0.2, 2, 8), blocksMovement: true, blocksCamera: true }]);
      for (let tick = 0; tick < 30; tick++) engine.fixedStep({ ...idle, move: vec(1, 0, 0), sprintHeld });
      const blocked = mana(engine);
      for (let tick = 0; tick < 300; tick++) engine.fixedStep({ ...idle, move: vec(1, 0, 0), sprintHeld });
      expect(mana(engine)).toBe(blocked);
      for (let tick = 0; tick < 300; tick++) engine.fixedStep(idle);
      expect(mana(engine)).toBe(blocked);
    }
  });
  it('crosses the exact affordability threshold through movement and charges a Dive once', () => {
    const engine = engineWithMana(PLAYER_SKILLS.dive.manaCost - 0.01);
    expect(ready(engine, 'dive').available).toBe(false);
    engine.fixedStep({ ...idle, dodgePressed: true });
    expect(mana(engine)).toBe(PLAYER_SKILLS.dive.manaCost - 0.01);
    expect(engine.snapshot().actors[0]!.actionId).toBe('aren-idle');
    engine.fixedStep({ ...idle, move: vec(1, 0, 0) });
    expect(ready(engine, 'dive').available).toBe(true);
    const funded = mana(engine), start = position(engine);
    engine.fixedStep({ ...idle, move: vec(1, 0, 0), dodgePressed: true });
    expect(mana(engine)).toBeCloseTo(funded - PLAYER_SKILLS.dive.manaCost, 8);
    for (let tick = 1; tick < 30; tick++) engine.fixedStep({ ...idle, dodgePressed: true });
    expect(distance2(start, position(engine))).toBeCloseTo(4.8, 8);
    expect(mana(engine)).toBeCloseTo(funded - PLAYER_SKILLS.dive.manaCost, 8);
  });
  it('never repays an evasion or Jump and cannot tunnel through a solid with the longer Dive', () => {
    const engine = engineWithMana(60);
    engine.setSceneColliders([{ id: 'tree', kind: 'box', from: vec(2, 3, 0), halfExtents: vec(0.5, 3, 2), blocksMovement: true, blocksCamera: true }]);
    engine.fixedStep({ ...idle, move: vec(1, 0, 0), dodgePressed: true });
    for (let tick = 1; tick < 56; tick++) engine.fixedStep(idle);
    expect(position(engine).x).toBeLessThanOrEqual(2 - 0.5 - 0.42);
    expect(position(engine).x).toBeGreaterThan(1);
    expect(mana(engine)).toBe(60 - PLAYER_SKILLS.dive.manaCost);
    const jumper = engineWithMana(PLAYER_SKILLS.jump.manaCost);
    jumper.fixedStep({ ...idle, jumpPressed: true });
    for (let tick = 0; tick < 70; tick++) jumper.fixedStep(idle);
    expect(mana(jumper)).toBe(0);
    expect(position(jumper).y).toBe(0);
    expect(ready(jumper, 'jump').available).toBe(false);
  });
  it('does not charge invalid targets and pays Cleanse on activation even if the pulse misses', () => {
    const seed = createEngineState();
    const target = makeActor('corrupted-boar', 'boar', 'hostile', vec(0, 0, -8), true, false, 100);
    target.corruption = 80; target.staggerUntil = 200;
    seed.actors.push(target); seed.targetId = target.id; seed.player.instinct = 0;
    const engine = new CombatEngine(seed);
    expect(engine.useAbility('root-tether', target.id)).toBe(false);
    expect(mana(engine)).toBe(seed.player.mana);
    expect(ready(engine, 'cleanse').available).toBe(true);
    expect(engine.useAbility('cleanse', target.id)).toBe(true);
    expect(mana(engine)).toBe(seed.player.mana - PLAYER_SKILLS.cleanse.manaCost);
    for (let tick = 0; tick < 36; tick++) engine.fixedStep(idle);
    expect(engine.snapshot().actors.find(actor => actor.id === target.id)!.corruption).toBe(80);
    expect(mana(engine)).toBe(seed.player.mana - PLAYER_SKILLS.cleanse.manaCost);
  });
  it('shows the held Heavy cost and safely cancels an unaffordable charged release', () => {
    for(const availableMana of [12,20]){
      const seed=createEngineState();seed.player.mana=availableMana;
      const target=makeActor('corrupted-boar','boar','hostile',vec(0,0,-1.5),true,false,100);
      seed.actors.push(target);seed.targetId=target.id;
      const engine=new CombatEngine(seed);
      engine.fixedStep({...idle,heavyPressed:true,heavyHeld:true});
      for(let tick=0;tick<40;tick++)engine.fixedStep({...idle,heavyHeld:true});
      expect(ready(engine,'charged_heavy').manaCost).toBe(20);
      expect(ready(engine,'charged_heavy').available).toBe(availableMana>=20);
      engine.fixedStep({...idle,heavyReleased:true,heavyHeldTicks:40});
      expect(mana(engine)).toBe(availableMana>=20?availableMana-20:availableMana);
      if(availableMana<20){
        expect(engine.snapshot().actors[0]!.actionId).toBe('aren-idle');
        const start=position(engine);
        for(let tick=0;tick<20;tick++)engine.fixedStep({...idle,move:vec(1,0,0)});
        expect(position(engine).x).toBeGreaterThan(start.x);
      }
    }
  });
  it('caps movement earnings, freezes during pause and preserves mana on restore', () => {
    const engine = engineWithMana(99);
    for (let tick = 0; tick < 60; tick++) engine.fixedStep({ ...idle, move: vec(1, 0, 0) });
    expect(mana(engine)).toBe(engine.snapshot().player.maxMana);
    engine.fixedStep({ ...idle, dodgePressed: true });
    engine.setTimePolicy('paused'); const before = engine.snapshot();
    const restored = new CombatEngine(); restored.restore(engine.serialize());
    for (let tick = 0; tick < 200; tick++) restored.fixedStep({ ...idle, move: vec(1, 0, 0), dodgePressed: true });
    expect(restored.snapshot().player).toEqual(before.player);
    expect(restored.snapshot().worldClock).toEqual(before.worldClock);
  });
});
