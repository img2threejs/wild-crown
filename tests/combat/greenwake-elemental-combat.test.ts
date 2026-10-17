import { describe, expect, it } from 'bun:test';
import { CombatEngine, createEngineState, makeActor, type CombatInput } from '../../src/game/combat/CombatEngine.js';
import { ATTACKS } from '../../src/game/combat/content.js';
import { vec } from '../../src/game/combat/geometry.js';

const idle: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
const runRight: CombatInput = { ...idle, move: vec(1, 0, 0), sprintHeld: true };
const elementalIds = ['boar-ember-lance', 'boar-gale-scythe', 'sap-stalker-frost-bloom', 'sap-stalker-venom-mist', 'root-rammer-cinder-burst', 'root-rammer-gale-sweep'];

function encounter(options: { phase?: number; attackIds?: readonly string[]; pressure?: number; bounds?: number } = {}): CombatEngine {
  const engine = new CombatEngine();
  engine.startEncounter({
    encounterId: 'greenwake-boar', regionId: 'greenwake', runId: 'elemental-behavior',
    actors: [
      makeActor('aren', 'human', 'player', vec(0, 0, 0), false, false, 1000),
      makeActor('corrupted-boar', 'boar', 'hostile', vec(0, 0, -5), true, false, 100),
      makeActor('greenwake-sap-stalker', 'boar', 'hostile', vec(-5, 0, 0), true, false, 100, 'corrupted-boar'),
      makeActor('greenwake-root-rammer', 'boar', 'hostile', vec(5, 0, 0), true, false, 100, 'corrupted-boar'),
    ],
  });
  const state = engine.snapshotState();
  state.arena = createEngineState().arena;
  const bounds = options.bounds ?? 6;
  state.arena.bounds = { min: vec(-bounds, -1, -bounds), max: vec(bounds, 12, bounds) };
  state.player.vitality = state.player.maxVitality = 1000;
  state.phaseIndex = options.phase ?? 0;
  state.wildlifeCombat = { engagedTicks: options.pressure ?? 0, sourceCursor: 0, attackCursors: {} };
  if (options.attackIds) state.encounter!.phases = [{ id: 'elemental-probe', attackIds: options.attackIds }];
  state.events = []; state.presentationCues = [];
  return new CombatEngine(state);
}

function until(engine: CombatEngine, worldTick: number, input = idle): void {
  while (engine.snapshotState().worldTick < worldTick) engine.fixedStep(input);
}

function oneCast(attackId: string, pressure = 0): CombatEngine {
  const engine = encounter({ attackIds: [attackId], pressure, bounds: 40 });
  engine.fixedStep(idle);
  const state = engine.snapshotState();
  state.encounter = null;
  return new CombatEngine(state);
}

function player(engine: CombatEngine) { return engine.snapshotState().actors.find(actor => actor.id === 'aren')!; }

describe('Greenwake elemental pressure', () => {
  for (const phase of [0, 1, 2, 3]) {
    it(`actually casts every elemental skill during phase ${phase}, without another phase transition`, () => {
      const engine = encounter({ phase });
      const casts = new Set<string>();
      for (let tick = 0; tick < 900 && casts.size < elementalIds.length; tick++) {
        engine.fixedStep(idle);
        for (const event of engine.consumeEvents()) if (event.kind === 'cue' && event.attackId && ATTACKS[event.attackId]?.element) casts.add(event.attackId);
        engine.drainPresentationCues();
      }
      expect(casts).toEqual(new Set(elementalIds));
      expect(engine.snapshotState().phaseIndex).toBe(phase);
    });
  }

  it('increases casting pressure while keeping a bounded number of simultaneous skills and poison clouds', () => {
    const firstCasts: number[][] = [];
    for (const pressure of [0, 3600]) {
      const engine = encounter({ pressure });
      const starts: number[] = [];
      for (let tick = 0; tick < 600; tick++) {
        engine.fixedStep(idle);
        for (const event of engine.consumeEvents()) if (event.kind === 'cue' && event.attackId && ATTACKS[event.attackId]) starts.push(event.tick);
        engine.drainPresentationCues();
        const state = engine.snapshotState();
        expect(state.hazards.filter(hazard => state.worldTick < (hazard.castUntil ?? hazard.activeUntil)).length).toBeLessThanOrEqual(3);
        const live = state.hazards.filter(hazard => state.worldTick < hazard.activeUntil);
        expect(live.length).toBeLessThanOrEqual(4);
        expect(live.filter(hazard => ATTACKS[hazard.attackId]?.element === 'poison').length).toBeLessThanOrEqual(2);
      }
      firstCasts.push(starts.slice(0, 2));
    }
    expect(firstCasts[1]![1]! - firstCasts[1]![0]!).toBeLessThan(firstCasts[0]![1]! - firstCasts[0]![0]!);
  });

  it('counts only engaged world time and freezes pressure during pause', () => {
    const seed = encounter({ bounds: 40 }).snapshotState();
    seed.actors[0]!.position = vec(30, 0, 30);
    const distant = new CombatEngine(seed);
    for (let tick = 0; tick < 30; tick++) distant.fixedStep(idle);
    expect(distant.snapshotState().wildlifeCombat!.engagedTicks).toBe(0);
    expect(distant.snapshotState().hazards).toEqual([]);

    seed.actors[0]!.position = vec(0, 0, 0);
    seed.timePolicy = 'perfect-dodge-slow'; seed.slowMotionRemainingTicks = 12;
    const near = new CombatEngine(seed);
    for (let tick = 0; tick < 4; tick++) near.fixedStep(idle);
    expect(near.snapshotState().wildlifeCombat!.engagedTicks).toBe(1);
    near.setTimePolicy('paused');
    for (let tick = 0; tick < 60; tick++) near.fixedStep(idle);
    expect(near.snapshotState().wildlifeCombat!.engagedTicks).toBe(1);
  });

  it('does not shorten an existing warning when pressure advances to the next tier', () => {
    const engine = encounter({ pressure: 1198, attackIds: ['boar-ember-lance'] });
    engine.fixedStep(idle);
    const hazard = engine.snapshotState().hazards[0]!;
    until(engine, hazard.windupUntil! - 1);
    expect(engine.snapshot().telegraphs.find(telegraph => telegraph.id === hazard.id)?.phase).toBe('windup');
    engine.fixedStep(idle);
    expect(engine.snapshot().telegraphs.find(telegraph => telegraph.id === hazard.id)?.phase).toBe('commit');
    until(engine, hazard.activeFrom - 1);
    expect(engine.snapshot().player.vitality).toBe(1000);
    engine.fixedStep(idle);
    expect(engine.snapshot().player.vitality).toBe(990);
  });

  it('lets the poison caster recover while its cloud remains dangerous, without exceeding two clouds', () => {
    const engine = encounter({ pressure: 3600, attackIds: ['sap-stalker-venom-mist'] });
    engine.fixedStep(idle);
    const first = engine.snapshotState().hazards[0]!;
    until(engine, first.recoveryUntil! + 1);
    const state = engine.snapshotState();
    expect(state.worldTick).toBeLessThan(first.activeUntil);
    expect(state.telegraphs.some(telegraph => telegraph.id !== first.id && telegraph.sourceId === 'greenwake-sap-stalker')).toBe(true);
    for (let tick = 0; tick < 300; tick++) {
      engine.fixedStep(idle);
      const current = engine.snapshotState();
      expect(current.hazards.filter(hazard => current.worldTick < hazard.activeUntil).length).toBeLessThanOrEqual(2);
    }
  });
});

describe('Elemental counterplay and persistent status', () => {
  it('damages an occupied fire lane once but leaves a sidestepping runner unharmed', () => {
    const standing = oneCast('boar-ember-lance');
    const end = standing.snapshotState().hazards[0]!.activeUntil;
    until(standing, end);
    expect(standing.snapshot().player.vitality).toBe(990);
    const dodging = oneCast('boar-ember-lance');
    until(dodging, end, runRight);
    expect(dodging.snapshot().player.vitality).toBe(1000);
  });

  it('ticks poison every 36 world ticks at both pressure extremes, never every simulation step', () => {
    for (const pressure of [0, 3600]) {
      const engine = oneCast('sap-stalker-venom-mist', pressure);
      const hazard = engine.snapshotState().hazards[0]!;
      until(engine, hazard.activeFrom);
      expect(engine.snapshot().player.vitality).toBe(996);
      until(engine, hazard.activeFrom + 35);
      expect(engine.snapshot().player.vitality).toBe(996);
      engine.fixedStep(idle);
      expect(engine.snapshot().player.vitality).toBe(992);
      until(engine, hazard.activeUntil);
      expect(engine.snapshot().player.vitality).toBe(980);
    }
  });

  it('stops poison damage after actually running out of the cloud', () => {
    const engine = oneCast('sap-stalker-venom-mist');
    const hazard = engine.snapshotState().hazards[0]!;
    until(engine, hazard.activeFrom);
    for (let tick = 0; tick < 32; tick++) engine.fixedStep(runRight);
    expect(player(engine).position.x).toBeGreaterThan(2.42);
    until(engine, hazard.activeUntil);
    expect(engine.snapshot().player.vitality).toBe(996);
  });

  it('restores a poison tick deadline without granting an immediate duplicate hit', () => {
    const engine = oneCast('sap-stalker-venom-mist');
    const hazard = engine.snapshotState().hazards[0]!;
    until(engine, hazard.activeFrom + 10);
    const restored = new CombatEngine();
    restored.restore(engine.serialize());
    restored.setTimePolicy('paused');
    for (let tick = 0; tick < 60; tick++) restored.fixedStep(idle);
    expect(restored.snapshot().player.vitality).toBe(996);
    restored.setTimePolicy('normal');
    until(restored, hazard.activeFrom + 35);
    expect(restored.snapshot().player.vitality).toBe(996);
    restored.fixedStep(idle);
    expect(restored.snapshot().player.vitality).toBe(992);
  });

  it('slows actual running after frost, preserves the remaining duration on load/pause, and expires on world time', () => {
    const engine = oneCast('sap-stalker-frost-bloom');
    const activeFrom = engine.snapshotState().hazards[0]!.activeFrom;
    until(engine, activeFrom);
    for (let tick = 0; tick < 10; tick++) engine.fixedStep(runRight);
    expect(player(engine).velocity.x).toBeCloseTo(4.32, 5);
    const restored = new CombatEngine(); restored.restore(engine.serialize());
    restored.setTimePolicy('paused');
    for (let tick = 0; tick < 120; tick++) restored.fixedStep(runRight);
    expect(player(restored).position).toEqual(player(engine).position);
    restored.setTimePolicy('normal');
    until(restored, activeFrom + 100, runRight);
    expect(player(restored).velocity.x).toBeCloseTo(6, 5);
    expect(restored.snapshotState().playerSlow).toBeUndefined();
  });

  it('sweeps wind knockback against walls instead of moving a capsule through them', () => {
    const seed = oneCast('boar-gale-scythe').snapshotState();
    seed.arena.obstacles = [{ minX: -3, maxX: 3, minZ: 0.7, maxZ: 1.5 }];
    const engine = new CombatEngine(seed);
    until(engine, seed.hazards[0]!.activeFrom + 40);
    expect(engine.snapshot().player.vitality).toBe(991);
    expect(player(engine).position.z).toBeGreaterThan(0);
    expect(player(engine).position.z).toBeLessThanOrEqual(0.28 + 1e-6);
  });

  it('rebases a wind-pushed airborne jump so the next trajectory sample cannot snap backward', () => {
    const engine = oneCast('boar-gale-scythe');
    const activeFrom = engine.snapshotState().hazards[0]!.activeFrom;
    until(engine, activeFrom - 10);
    engine.fixedStep({ ...runRight, jumpPressed: true });
    until(engine, activeFrom + 4, runRight);
    expect(engine.snapshot().player.vitality).toBe(991);
    const pushedZ = player(engine).position.z;
    expect(pushedZ).toBeGreaterThan(0);
    for (let tick = 0; tick < 120 && engine.snapshotState().playerJump; tick++) {
      engine.fixedStep(runRight);
      expect(player(engine).position.z).toBeGreaterThanOrEqual(pushedZ - 1e-5);
    }
    expect(player(engine).position.y).toBeCloseTo(0, 5);
  });

  it('restores checkpoint pressure and clears cloud/slow state on retry', () => {
    const engine = encounter({ pressure: 3600, attackIds: ['sap-stalker-frost-bloom'] });
    engine.fixedStep(idle);
    until(engine, engine.snapshotState().hazards[0]!.activeFrom);
    expect(engine.snapshotState().playerSlow).toBeDefined();
    const worldTick = engine.snapshotState().worldTick;
    engine.resetToCheckpoint();
    const reset = engine.snapshotState();
    expect(reset.wildlifeCombat).toBeUndefined();
    expect(reset.playerSlow).toBeUndefined();
    expect(reset.hazards).toEqual([]);
    expect(reset.worldTick).toBe(worldTick);
  });
});
