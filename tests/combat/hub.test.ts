import { describe, expect, it } from 'bun:test';
import { REGIONS } from '../../src/content/world.js';
import { CombatEngine } from '../../src/game/combat/CombatEngine.js';
import type { CombatInput } from '../../src/game/combat/CombatEngine.js';

const idle: CombatInput = { tick: 0, move: { x: 0, y: 0, z: 0 }, dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
const grove = REGIONS.find(region => region.id === 'the-grove')!;
const post = grove.entities.find(entity => entity.interactionId === 'grove-training')!.position;

function practiceEngine(): CombatEngine {
  const engine = new CombatEngine();
  engine.loadRegion({ regionId: grove.id, runId: 'hub-practice', presentActorIds: ['aren'], playerPosition: post });
  engine.setPlayerHero('aren');
  return engine;
}

function ticks(engine: CombatEngine, count: number): void {
  for (let tick = 0; tick < count; tick++) engine.fixedStep(idle);
}

describe('sanctuary dodge practice', () => {
  it('scores actual dodge invulnerability, never damages or grants quest rewards, and pauses with the world', () => {
    const engine = practiceEngine();
    const vitality = engine.snapshot().player.vitality;
    engine.startDodgePractice();
    ticks(engine, 60);
    expect(engine.snapshot().dodgePractice).toEqual({ active: true, attempts: 1, dodged: 0, phase: 'strike' });
    engine.setTimePolicy('paused');
    ticks(engine, 80);
    expect(engine.snapshot().dodgePractice?.attempts).toBe(1);
    engine.setTimePolicy('normal');
    ticks(engine, 126);
    engine.fixedStep({ ...idle, dodgePressed: true, move: { x: 0, y: 0, z: 1 } });
    ticks(engine, 5);
    expect(engine.snapshot().dodgePractice?.attempts).toBe(2);
    expect(engine.snapshot().dodgePractice?.dodged).toBe(1);
    expect(engine.snapshot().player.vitality).toBe(vitality);
    expect(engine.consumeWorldEvents()).toEqual([]);
    engine.stopDodgePractice();
    ticks(engine, 200);
    expect(engine.snapshot().dodgePractice).toEqual({ active: false, attempts: 2, dodged: 1, phase: 'idle' });
  });

  it('cannot start remotely and never survives a region load', () => {
    const engine = practiceEngine();
    engine.startDodgePractice();
    engine.loadRegion({ regionId: grove.id, runId: 'hub-practice', presentActorIds: ['aren'], playerPosition: { x: 7, y: 0, z: 8 } });
    expect(engine.snapshot().dodgePractice).toBeUndefined();
    expect(() => engine.startDodgePractice()).toThrow('Walk to the training post');
  });
});

describe('milestone resource upgrades', () => {
  it('changes real resource limits once without healing, stacks or persistence loss', () => {
    const engine = practiceEngine();
    const before = engine.snapshot().player;
    const facts = { 'upgrade:root-resilience': true, 'upgrade:trail-reserves': true };
    engine.syncWorldFacts(facts);
    const learned = engine.snapshot().player;
    expect(learned.maxVitality).toBe(before.maxVitality + 20);
    expect(learned.vitality).toBe(before.vitality);
    expect(learned.maxMana).toBe(before.maxMana + 20);
    expect(learned.mana).toBe(before.mana);
    engine.syncWorldFacts(facts);
    expect(engine.snapshot().player).toEqual(learned);
    const reloaded = new CombatEngine();
    reloaded.loadRegion({ regionId: grove.id, runId: 'hub-upgraded', presentActorIds: ['aren'], playerPosition: post, worldFacts: facts });
    reloaded.setPlayerHero('aren');
    expect(reloaded.snapshot().player.maxVitality).toBe(learned.maxVitality);
    expect(reloaded.snapshot().player.maxMana).toBe(learned.maxMana);
  });
});
