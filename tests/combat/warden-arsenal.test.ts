import { describe, expect, it } from 'bun:test';
import { CombatEngine, createEngineState, makeActor, type CombatActor, type CombatEvent, type CombatInput, type EngineState, type LiveHazard } from '../../src/game/combat/CombatEngine.js';
import { ATTACKS } from '../../src/game/combat/content.js';
import { GREENWAKE_COMBAT_TRIALS } from '../../src/game/combat/CombatTrials.js';
import { vec } from '../../src/game/combat/geometry.js';
import { CHAIN_EARLY_TICKS, CHAIN_LATE_TICKS, JUDGEMENT, LIGHT_LOCK_MARGIN_TICKS, LIGHT_STEPS, SIGIL, THUNDER_CLEAVE } from '../../src/game/combat/PlayerSkills.js';
import type { StoryCue } from '../../src/effects/story-cues.js';

const idle: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
const press = (patch: Partial<CombatInput>): CombatInput => ({ ...idle, ...patch });
const live = (engine: CombatEngine): EngineState => (engine as unknown as { state: EngineState }).state;
const DEGREES = Math.PI / 180;
const angleBetween = (a: number, b: number): number => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const yawOf = (v: { x: number; z: number }): number => Math.atan2(v.x, v.z);

/** A passive hostile with no Ferocity bar, so stacked damage never downs it mid-test. */
function foe(id: string, x: number, z: number, large = false): CombatActor {
  const actor = makeActor(id as CombatActor['id'], 'boar', 'hostile', vec(x, 0, z), large, false, 1000);
  actor.ferocity = undefined;
  return actor;
}

class Bench {
  readonly cues: StoryCue[] = [];
  readonly events: CombatEvent[] = [];
  constructor(readonly engine: CombatEngine) {}
  get state(): EngineState { return live(this.engine); }
  get aren(): CombatActor { return this.state.actors[0]!; }
  get tick(): number { return this.state.tick; }
  step(input: CombatInput = idle, count = 1): void {
    for (let index = 0; index < count; index++) {
      this.engine.fixedStep(input);
      this.cues.push(...this.engine.drainPresentationCues());
      this.events.push(...this.engine.consumeEvents());
    }
  }
  /** Idle until `state.tick === tick`, so the next step is tick + 1. */
  stepTo(tick: number, input: CombatInput = idle): void {
    expect(this.tick).toBeLessThanOrEqual(tick);
    while (this.tick < tick) this.step(input);
  }
  stepUntil(done: () => boolean, input: CombatInput = idle, limit = 600): void {
    for (let index = 0; index < limit && !done(); index++) this.step(input);
    expect(done()).toBe(true);
  }
  actor(id: string): CombatActor { return this.state.actors.find(actor => actor.id === id)!; }
  health(id: string): number { return this.actor(id).vitality ?? 0; }
  cuesOf(kind: StoryCue['kind'], phase?: StoryCue['phase']): StoryCue[] { return this.cues.filter(cue => cue.kind === kind && (phase === undefined || cue.phase === phase)); }
}

function bench(actors: CombatActor[] = [], tweak?: (state: EngineState) => void): Bench {
  const state = createEngineState();
  state.arena.bounds = { min: vec(-30, -2, -30), max: vec(30, 20, 30) };
  state.actors = [state.actors[0]!, ...actors];
  state.player.vitality = state.player.maxVitality = 1000;
  tweak?.(state);
  return new Bench(new CombatEngine(state));
}
/** Seeds the combo so the next J press is `step` (1-based). */
const chainedTo = (step: number) => (state: EngineState): void => { state.lightIndex = step - 1; state.lightChainFrom = 0; state.lightChainUntil = 100_000; };
const wall = (z: number) => (state: EngineState): void => {
  state.arena.colliders = [...state.arena.colliders, { id: 'test-wall', kind: 'box', from: vec(0, 1.5, z), halfExtents: vec(4, 1.5, 0.3), blocksMovement: true, blocksCamera: true }];
};

describe('Warden Blade combo', () => {
  it('chains at each opening and buffers a fresh chain until the finisher ends', () => {
    const b = bench();
    b.step(press({ lightPressed: true }));
    b.step(press({ lightPressed: true }));
    expect(b.state.bufferedAction).toBeUndefined();
    for (let step = 1; step < LIGHT_STEPS.length; step++) {
      b.stepTo(b.aren.actionEndsTick - CHAIN_EARLY_TICKS - 1);
      expect(b.state.actionId).toBe(`light_${step}`);
      b.step(press({ lightPressed: true }));
      expect(b.state.actionId).toBe(`light_${step + 1}`);
    }
    const end = b.aren.actionEndsTick;
    b.stepTo(end - CHAIN_EARLY_TICKS - 1);
    b.step(press({ lightPressed: true }));
    expect(b.state.actionId).toBe('light_4');
    b.stepTo(end - 1);
    expect(b.state.actionId).toBe('light_4');
    b.step();
    expect(b.state).toMatchObject({ actionId: 'light_1', lightIndex: 1 });
    expect(b.aren.actionStartedTick).toBe(end);
  });

  it('accepts the next step at the grace deadline and restarts one tick later', () => {
    for (const [offset, expected] of [[0, 'light_2'], [1, 'light_1']] as const) {
      const b = bench();
      b.step(press({ lightPressed: true }));
      b.stepTo(b.aren.actionEndsTick + CHAIN_LATE_TICKS + offset - 1);
      b.step(press({ lightPressed: true }));
      expect(b.state.actionId).toBe(expected);
    }
  });

  it('buffers a late press and starts it exactly when the chain window opens', () => {
    const b = bench();
    b.step(press({ lightPressed: true }));
    const opening = b.aren.actionEndsTick - CHAIN_EARLY_TICKS;
    b.stepTo(b.aren.actionEndsTick - 9);
    b.step(press({ lightPressed: true }));
    expect(b.state.bufferedAction?.action).toBe('light_2');
    b.stepTo(opening - 1);
    expect(b.state.actionId).toBe('light_1');
    b.step();
    expect(b.state.actionId).toBe('light_2');
    expect(b.aren.actionStartedTick).toBe(opening);
  });

  it('swings without a target and releases grounded movement only after the lock', () => {
    const b = bench();
    b.step(press({ lightPressed: true }));
    b.stepTo(b.aren.actionEndsTick - LIGHT_LOCK_MARGIN_TICKS - 1, press({ move: vec(1, 0, 0) }));
    expect(b.aren.position.x).toBe(0);
    expect(b.state.player.mana).toBe(100);
    b.step(press({ move: vec(1, 0, 0) }), 2);
    expect(b.aren.position.x).toBeGreaterThan(0);
  });

  it('hits only hostiles inside the sector (arc 2.4 rad, reach 2.3 m + body radius), each once per swing', () => {
    const b = bench([foe('front', 0, -2), foe('diagonal', 1.4, -1.4), foe('flank', 2, 0), foe('behind', 0, 2), foe('far', 0, -3)]);
    b.step(press({ lightPressed: true }));
    b.step(idle, 30);
    expect(b.health('front')).toBe(991);
    expect(b.health('diagonal')).toBe(991);
    for (const id of ['flank', 'behind', 'far']) expect(b.health(id)).toBe(1000);
    expect(b.state.player.instinct).toBe(16);
    expect(b.events.filter(event => event.kind === 'damage' && event.targetId === 'front')).toHaveLength(1);
  });

  it('deals each step\'s contract damage and begins its active window on the contract tick', () => {
    LIGHT_STEPS.forEach(({ damage, activeFrom }, index) => {
      const b = bench([foe('dummy', 0, -1.6)], chainedTo(index + 1));
      b.step(press({ lightPressed: true }));
      const start = b.tick;
      b.stepUntil(() => b.health('dummy') < 1000);
      expect(1000 - b.health('dummy')).toBe(damage);
      expect(b.tick - start).toBe(activeFrom);
    });
  });

  it('spins light_3 through one full turn and hits every in-range hostile exactly once', () => {
    const b = bench([foe('north', 0, -2), foe('south', 0, 2), foe('east', 2, 0), foe('west', -2, 0), foe('far', 0, 3.6)], chainedTo(3));
    b.step(press({ lightPressed: true }));
    const start = b.tick;
    let previous = yawOf(b.aren.facing), turned = 0, firstTurnTick = -1;
    for (let tick = 0; tick < LIGHT_STEPS[2]!.ticks + LIGHT_STEPS[2]!.hitStopTicks; tick++) {
      b.step();
      const yaw = yawOf(b.aren.facing);
      const delta = angleBetween(yaw, previous);
      if (delta !== 0 && firstTurnTick < 0) firstTurnTick = b.tick - start;
      turned += delta;
      previous = yaw;
    }
    expect(firstTurnTick).toBe(LIGHT_STEPS[2]!.spin!.from + 1);
    expect(turned).toBeCloseTo(2 * Math.PI, 6);
    for (const id of ['north', 'south', 'east', 'west']) expect(b.health(id)).toBe(987);
    expect(b.health('far')).toBe(1000);
    expect(b.cuesOf('slash')[0]?.footprint).toMatchObject({ width: 2.8, length: 2.8, sectorRadians: 2 * Math.PI });
  });
});

describe('Crescent Wave', () => {
  const finisher = (actors: CombatActor[], tweak?: (state: EngineState) => void): Bench => bench(actors, state => { chainedTo(4)(state); tweak?.(state); });

  it('launches at the finisher contact, spends mana once, pierces hostiles once and expires at range', () => {
    const b = finisher([foe('near', 0, -5), foe('mid', 0, -8), foe('past', 0, -12), foe('aside', 5, -5)]);
    b.step(press({ lightPressed: true }));
    const start = b.tick;
    b.stepUntil(() => (b.engine.snapshot().playerProjectiles?.length ?? 0) > 0);
    expect(b.tick - start).toBe(LIGHT_STEPS[3]!.waveAt);
    expect(b.state.player.mana).toBe(90);
    expect(b.engine.snapshot().playerProjectiles![0]).toMatchObject({ kind: 'crescent-wave', ownerId: 'aren', speed: 20, radius: 1.4, ageTicks: 0, lifeTicks: 27 });
    const launch = b.cuesOf('projectile')[0]!;
    expect(launch).toMatchObject({ phase: 'commit', actionId: 'crescent-wave', durationTicks: 27, element: 'arcane' });
    expect(launch.to!.z - launch.from!.z).toBeCloseTo(-9, 6);
    let pierced = false;
    for (let tick = 0; tick < 60 && (b.engine.snapshot().playerProjectiles?.length ?? 0) > 0; tick++) {
      b.step();
      if (b.health('near') < 1000 && b.health('mid') === 1000) pierced = (b.engine.snapshot().playerProjectiles?.length ?? 0) > 0;
    }
    expect(pierced).toBe(true);
    expect(b.engine.snapshot().playerProjectiles).toBeUndefined();
    expect(b.health('near')).toBe(988);
    expect(b.health('mid')).toBe(988);
    expect(b.health('past')).toBe(1000);
    expect(b.health('aside')).toBe(1000);
    const impacts = b.cuesOf('projectile-impact');
    expect(impacts.map(cue => cue.targetId)).toEqual(['near', 'mid']);
    expect(impacts[0]).toMatchObject({ phase: 'hit', scopeId: launch.scopeId, actionId: 'crescent-wave', intensity: 1, element: 'arcane' });
  });

  it('needs 10 mana: with less the blade still swings but no wave is cast and no mana is spent', () => {
    const poor = finisher([foe('near', 0, -5)], state => { state.player.mana = 9; });
    poor.step(press({ lightPressed: true }));
    poor.step(idle, 45);
    expect(poor.state.player.mana).toBe(9);
    expect(poor.cuesOf('projectile')).toHaveLength(0);
    expect(poor.health('near')).toBe(1000);
    const exact = finisher([foe('near', 0, -5)], state => { state.player.mana = 10; });
    exact.step(press({ lightPressed: true }));
    exact.step(idle, 45);
    expect(exact.state.player.mana).toBe(0);
    expect(exact.cuesOf('projectile')).toHaveLength(1);
  });

  it('is stopped by a blocking collider before it reaches what stands behind it', () => {
    const b = finisher([foe('behind', 0, -6)], wall(-3));
    b.step(press({ lightPressed: true }));
    b.step(idle, 60);
    expect(b.health('behind')).toBe(1000);
    const impact = b.cuesOf('projectile-impact')[0]!;
    expect(impact).toMatchObject({ phase: 'hit', intensity: 0.6 });
    expect(impact.targetId).toBeUndefined();
    expect(impact.position!.z).toBeGreaterThan(-2.8);
  });

  it('also lands the finisher\'s own melee sector (reach 2.5 m) for 14', () => {
    const b = finisher([foe('close', 0, -2)]);
    b.step(press({ lightPressed: true }));
    b.stepUntil(() => b.health('close') < 1000);
    expect(b.health('close')).toBe(986);
    expect(b.cuesOf('slash')[0]?.footprint).toMatchObject({ sectorRadians: 2.4, width: 2.5, length: 2.5 });
  });
});

describe('Sigil Bolt', () => {
  it('spends mana at acceptance and roots the cast until its movement lock expires', () => {
    const b = bench();
    b.step(press({ rangedPressed: true }));
    expect(b.state.player.mana).toBe(85);
    const sigil = b.cuesOf('sigil')[0]!;
    expect(sigil.scopeId).toMatch(/^sigil:\d+$/);
    expect(sigil.position).toEqual(vec(0, 1.25, -0.9));
    expect(sigil.to).toEqual(vec(0, 1.25, -10.9));
    b.stepTo(1 + SIGIL.boltLockTicks - 1, press({ move: vec(1, 0, 0) }));
    expect(b.aren.position.x).toBe(0);
    b.step(press({ move: vec(1, 0, 0) }), 2);
    expect(b.aren.position.x).toBeGreaterThan(0);
  });

  it('launches after anticipation and flies straight when no target lies in its cone', () => {
    const b = bench([foe('outside', -8, -3)]);
    b.step(press({ rangedPressed: true }));
    b.stepTo(SIGIL.boltLaunchTick);
    expect(b.engine.snapshot().playerProjectiles).toBeUndefined();
    b.step();
    const bolt = b.engine.snapshot().playerProjectiles![0]!;
    expect(bolt).toMatchObject({ kind: 'sigil-bolt', ownerId: 'aren', speed: 28, radius: 0.35, ageTicks: 0, lifeTicks: 60, position: vec(0, 1.25, -0.9), direction: vec(0, 0, -1) });
    expect(bolt.targetId).toBeUndefined();
    const cue = b.cuesOf('projectile')[0]!;
    expect(cue).toMatchObject({ phase: 'commit', actorId: 'aren', scopeId: bolt.id, actionId: 'sigil-bolt', durationTicks: 60, element: 'arcane' });
    expect(cue.from).toEqual(vec(0, 1.25, -0.9));
    expect(cue.to!.z).toBeCloseTo(-0.9 - 28, 6);
    b.step(idle, 10);
    expect(b.engine.snapshot().playerProjectiles![0]!.position.z).toBeCloseTo(-0.9 - 28 / 60 * 10, 6);
    b.step(idle, 60);
    expect(b.engine.snapshot().playerProjectiles).toBeUndefined();
    expect(b.health('outside')).toBe(1000);
  });

  it('hits for 14, grants 4 Instinct, staggers an idle monster and reports the impact', () => {
    const b = bench([foe('mark', 0, -6)]);
    b.step(press({ rangedPressed: true }));
    b.stepUntil(() => b.health('mark') < 1000);
    expect(b.health('mark')).toBe(986);
    expect(b.state.player.instinct).toBe(4);
    expect(b.actor('mark').staggerUntil).toBe(b.state.worldTick + SIGIL.staggerTicks);
    expect(b.engine.snapshot().playerProjectiles).toBeUndefined();
    const impact = b.cuesOf('projectile-impact')[0]!;
    expect(impact).toMatchObject({ phase: 'hit', targetId: 'mark', actionId: 'sigil-bolt', intensity: 1, element: 'arcane' });
    expect(b.cuesOf('hit').at(-1)).toMatchObject({ actorId: 'aren', targetId: 'mark', element: 'arcane' });
    expect(b.engine.snapshot().hitStop).toMatchObject({ remainingTicks: 2 });
  });

  it('homes onto a strafing target inside the 70° cone, turning no faster than 6 rad/s', () => {
    const b = bench([foe('runner', 4, -8)]);
    b.step(press({ rangedPressed: true }));
    b.stepTo(SIGIL.boltLaunchTick);
    b.step();
    const bolt = b.engine.snapshot().playerProjectiles![0]!;
    expect(bolt.targetId).toBe('runner');
    let hit = false, widest = 0, previous = bolt.direction;
    for (let tick = 0; tick < 80 && !hit; tick++) {
      b.actor('runner').position = vec(b.actor('runner').position.x + 0.12, 0, -8);
      b.step();
      const current = b.engine.snapshot().playerProjectiles?.[0];
      if (current) {
        widest = Math.max(widest, Math.acos(Math.min(1, current.direction.x * previous.x + current.direction.y * previous.y + current.direction.z * previous.z)));
        previous = current.direction;
      }
      hit = b.health('runner') < 1000;
    }
    expect(hit).toBe(true);
    expect(widest).toBeGreaterThan(0);
    expect(widest).toBeLessThanOrEqual(6 / 60 + 1e-9);
  });

  it('never interrupts a monster\'s windup', () => {
    const b = bench([foe('caster', 0, -6)]);
    const attack = ATTACKS['boar-ember-lance']!;
    const hazard: LiveHazard = { ...structuredClone(attack.hazard), id: 'caster-lance', attackId: attack.id as LiveHazard['attackId'], sourceId: 'caster' as LiveHazard['sourceId'], startTick: 0, windupUntil: 400, activeFrom: 420, activeUntil: 430, castUntil: 430, recoveryUntil: 470, target: vec(40, 0, 40), origin: vec(40, 0, 40), direction: vec(0, 0, 1), hitIds: [], threatTicks: [], cue: 'wind', damage: 0, bounds: { min: vec(39, 0, 39), max: vec(41, 3, 41) } };
    b.state.hazards = [hazard];
    b.state.telegraphs = [{ id: hazard.id, attackId: hazard.attackId, sourceId: hazard.sourceId, targetPosition: vec(40, 0, 40), phase: 'windup', remainingTicks: 400, cue: 'wind' }];
    b.step(press({ rangedPressed: true }));
    b.stepUntil(() => b.health('caster') < 1000);
    expect(b.health('caster')).toBe(986);
    expect(b.state.hazards.map(item => item.id)).toEqual(['caster-lance']);
    expect(b.state.telegraphs).toHaveLength(1);
    expect(b.actor('caster').staggerUntil).toBe(0);
    expect(b.engine.snapshot().actors.find(actor => actor.id === 'caster')!.reaction).toMatchObject({ kind: 'flinch' });
  });
});

describe('Sigil Bolt against a sealed Greenwake trial gate', () => {
  function trialRig(): Bench {
    const engine = new CombatEngine();
    engine.startEncounter({ encounterId: 'greenwake-boar', regionId: 'greenwake', runId: 'sigil-gate' });
    engine.enableCombatTrials();
    const seed = engine.snapshotState();
    seed.arena = createEngineState().arena;
    seed.arena.bounds = { min: vec(-100, -1, -100), max: vec(100, 12, 100) };
    return new Bench(new CombatEngine(seed));
  }

  it('stops at the closed gate even though a hostile stands in plain sight behind it', () => {
    const b = trialRig();
    const gate = GREENWAKE_COMBAT_TRIALS[0]!.gate;
    expect(b.engine.snapshot().trialGates![0]).toMatchObject({ open: false });
    b.aren.position = vec(gate.from.x, 0, gate.from.z - 2);
    b.aren.facing = vec(0, 0, 1);
    b.state.actors.push(foe('behind-gate', gate.from.x, gate.from.z + 2));
    b.step(press({ rangedPressed: true }));
    b.step(idle, 70);
    expect(b.health('behind-gate')).toBe(1000);
    const impact = b.cuesOf('projectile-impact')[0]!;
    expect(impact).toMatchObject({ intensity: 0.6 });
    expect(impact.position!.z).toBeGreaterThan(gate.from.z - 2);
    expect(impact.position!.z).toBeLessThan(gate.from.z - gate.halfExtents!.z + 1e-6);
  });
});

describe('Sigil Barrage', () => {
  it('charges without spending, then releases three angled bolts for one charge cost', () => {
    const b = bench();
    b.step(press({ rangedPressed: true, rangedHeld: true }));
    expect(b.state.sigilCharge).toBeDefined();
    expect(b.aren.actionId).toBe('aren-sigil-charge');
    const sustain = b.cuesOf('sigil', 'sustain')[0]!;
    b.step(press({ rangedHeld: true }), SIGIL.barrageHoldTicks - 1);
    expect(b.state.player.mana).toBe(100);
    b.step(press({ rangedReleased: true }));
    const release = b.tick;
    expect(b.state.player.mana).toBe(65);
    expect(b.cuesOf('cancel').find(cue => cue.scopeId === sustain.scopeId)).toBeDefined();
    b.step(idle, SIGIL.barrageTicks);
    const launches = b.cuesOf('projectile');
    expect(launches.map(cue => cue.tick - release)).toEqual(SIGIL.barrageLaunchTicks);
    const facingYaw = yawOf(vec(0, 0, -1));
    const offsets = launches.map(cue => angleBetween(yawOf({ x: cue.to!.x - cue.from!.x, z: cue.to!.z - cue.from!.z }), facingYaw) / DEGREES);
    expect(offsets[0]).toBeCloseTo(-12, 6);
    expect(offsets[1]).toBeCloseTo(0, 6);
    expect(offsets[2]).toBeCloseTo(12, 6);
    const sigils = b.cuesOf('sigil', 'anticipation').filter(cue => cue.tick >= release);
    for (let index = 0; index < launches.length; index++) expect(sigils[index]!.tick + sigils[index]!.durationTicks!).toBe(launches[index]!.tick);
  });

  it('each barrage bolt deals 12', () => {
    const b = bench([foe('mark', 0, -7)]);
    b.step(press({ rangedPressed: true, rangedHeld: true }));
    b.step(press({ rangedHeld: true }), SIGIL.barrageHoldTicks);
    b.step(press({ rangedReleased: true }));
    b.step(idle, 90);
    expect(b.health('mark')).toBe(1000 - 36);
    expect(b.state.player.instinct).toBe(12);
  });

  it('falls back to a normal bolt when 35 mana is not there at release, and to nothing under 15', () => {
    const bolt = bench([], state => { state.player.mana = 40; });
    bolt.step(press({ rangedPressed: true, rangedHeld: true }));
    bolt.step(press({ rangedHeld: true }), SIGIL.barrageHoldTicks);
    bolt.state.player.mana = 20;
    bolt.step(press({ rangedReleased: true }));
    expect(bolt.aren.actionId).toBe('aren-sigil-bolt');
    expect(bolt.state.player.mana).toBe(5);
    const none = bench();
    none.step(press({ rangedPressed: true, rangedHeld: true }));
    none.step(press({ rangedHeld: true }), SIGIL.barrageHoldTicks);
    none.state.player.mana = 10;
    none.step(press({ rangedReleased: true }));
    expect(none.state.cast).toBeUndefined();
    expect(none.state.actionId).toBe('idle');
    expect(none.aren.actionId).toBe('aren-idle');
    expect(none.state.player.mana).toBe(10);
    none.step(idle, 40);
    expect(none.engine.snapshot().playerProjectiles).toBeUndefined();
  });

  it('a short hold is a normal bolt, may be turned while held, and a Dive cancels the charge', () => {
    const b = bench();
    b.step(press({ rangedPressed: true, rangedHeld: true }));
    b.step(press({ rangedHeld: true, move: vec(1, 0, 0) }), 4);
    expect(b.aren.position.x).toBe(0);
    expect(b.aren.facing.x).toBeGreaterThan(0.99);
    b.step(press({ rangedReleased: true }));
    expect(b.aren.actionId).toBe('aren-sigil-bolt');
    expect(b.state.player.mana).toBe(85);
    const cancelled = bench();
    cancelled.step(press({ rangedPressed: true, rangedHeld: true }));
    cancelled.step(press({ rangedHeld: true }), 3);
    cancelled.step(press({ rangedHeld: true, dodgePressed: true, move: vec(1, 0, 0) }));
    expect(cancelled.state.sigilCharge).toBeUndefined();
    expect(cancelled.aren.actionId).toContain('dive');
    expect(cancelled.cuesOf('cancel').some(cue => cue.scopeId === cancelled.cuesOf('sigil', 'sustain')[0]!.scopeId)).toBe(true);
  });

  it('refuses to start without 15 mana', () => {
    const b = bench([], state => { state.player.mana = 14; });
    b.step(press({ rangedPressed: true, rangedHeld: true }));
    expect(b.state.sigilCharge).toBeUndefined();
    expect(b.engine.snapshot().skills.find(skill => skill.id === 'sigil_bolt')).toMatchObject({ available: false, reason: 'Need 15 mana' });
  });
});

describe('Thunder Cleave', () => {
  function charged(actors: CombatActor[], target: string): Bench {
    const b = bench(actors, state => { state.targetId = target as EngineState['targetId']; });
    b.step(press({ heavyPressed: true, heavyHeld: true }));
    b.step(press({ heavyHeld: true }), THUNDER_CLEAVE.holdTicks);
    b.step(press({ heavyReleased: true, heavyHeldTicks: THUNDER_CLEAVE.holdTicks }));
    return b;
  }

  it('strikes after the melee contact for splash damage inside the lightning radius', () => {
    const b = charged([foe('boar', 0, -1.6, true), foe('beside', 2.5, -1.6), foe('distant', 5.8, -1.6)], 'boar');
    expect(b.state.pendingImpact).toMatchObject({ action: 'charged_heavy', damage: 36 });
    b.stepUntil(() => b.cuesOf('lightning').length > 0);
    const hit = b.cuesOf('hit').find(cue => cue.targetId === 'boar')!;
    const strike = b.cuesOf('lightning')[0]!;
    expect(strike.worldTick - hit.worldTick).toBe(THUNDER_CLEAVE.delayTicks);
    expect(strike.position).toEqual(vec(0, 0, -1.6));
    b.step(idle, 20);
    expect(b.health('boar')).toBe(1000 - 36 - 18);
    expect(b.health('beside')).toBe(1000 - 18);
    expect(b.health('distant')).toBe(1000);
    const lightningHits = b.cuesOf('hit').filter(cue => cue.element === 'lightning');
    expect(lightningHits.map(cue => cue.targetId).sort()).toEqual(['beside', 'boar']);
    expect(b.cuesOf('hit').find(cue => cue.targetId === 'boar' && cue.element === 'arcane')).toMatchObject({ actionId: 'aren-charged-heavy', intensity: 3 });
  });

  it('lands 2.5 m ahead of Aren when the blow itself is out of reach', () => {
    const b = charged([foe('boar', 0, -9), foe('ahead', 0.5, -2.5)], 'boar');
    b.stepUntil(() => b.cuesOf('lightning').length > 0);
    expect(b.cuesOf('lightning')[0]!.position).toEqual(vec(0, 0, -2.5));
    b.step(idle, 5);
    expect(b.health('boar')).toBe(1000);
    expect(b.health('ahead')).toBe(1000 - 18);
  });

});

describe("Warden's Judgement", () => {
  const full = (state: EngineState): void => { state.player.instinct = 100; };
  const target = (id: string) => (state: EngineState): void => { full(state); state.targetId = id as EngineState['targetId']; };

  it('needs full Instinct and consumes all of it', () => {
    const short = bench([], state => { state.player.instinct = 99; });
    expect(short.engine.snapshot().skills.find(skill => skill.id === 'judgement')).toMatchObject({ label: 'Judgement', binding: 'ultimate', available: false, reason: 'Need full Instinct' });
    short.step(press({ ultimatePressed: true }));
    expect(short.state.cast).toBeUndefined();
    expect(short.state.player.instinct).toBe(99);
    const ready = bench([], full);
    expect(ready.engine.snapshot().skills.find(skill => skill.id === 'judgement')).toMatchObject({ available: true, reason: 'Ready' });
    ready.step(press({ ultimatePressed: true }));
    expect(ready.state.player.instinct).toBe(0);
  });

  it('dashes 8 m along the facing, or 1.5 m past a target within 10 m, through other actors', () => {
    const open = bench([], full);
    open.step(press({ ultimatePressed: true }));
    open.step(idle, 60);
    expect(open.aren.position.z).toBeCloseTo(-8, 6);
    const hunted = bench([foe('blocker', 0, -3), foe('quarry', 0, -6)], target('quarry'));
    hunted.step(press({ ultimatePressed: true }));
    hunted.step(idle, 60);
    expect(hunted.aren.position.z).toBeCloseTo(-7.5, 6);
    const distant = bench([foe('quarry', 0, -12)], target('quarry'));
    distant.step(press({ ultimatePressed: true }));
    distant.step(idle, 60);
    expect(distant.aren.position.z).toBeCloseTo(-8, 6);
  });

  it('is stopped by blocking colliders like any capsule sweep and still drops its five marks', () => {
    const b = bench([], state => { full(state); wall(-3)(state); });
    b.step(press({ ultimatePressed: true }));
    b.step(idle, JUDGEMENT.dashTo);
    expect(b.aren.position.z).toBeGreaterThan(-2.3);
    expect(b.aren.position.z).toBeLessThan(-2);
    expect(b.state.judgementMarks).toHaveLength(5);
    for (const mark of b.state.judgementMarks) expect(mark.position.z).toBeGreaterThan(-2.3);
  });

  it('protects the dash but leaves anticipation exposed', () => {
    const attack = ATTACKS['koro-fruit-burst']!;
    const hazard = (): LiveHazard => ({ ...structuredClone(attack.hazard), id: 'burst', attackId: attack.id as LiveHazard['attackId'], sourceId: 'koro' as LiveHazard['sourceId'], startTick: 0, activeFrom: 1 + JUDGEMENT.dashFrom, activeUntil: 2 + JUDGEMENT.dashTo, target: vec(0, 0, -3), origin: vec(0, 0, -3), direction: vec(0, 0, 1), width: 40, depth: 40, damage: 30, hitIds: [], threatTicks: [], cue: 'burst', targetActorId: 'aren' as LiveHazard['targetActorId'], bounds: { min: vec(-20, -1, -20), max: vec(20, 3, 20) } });
    const exposed = bench([], state => { state.hazards = [hazard()]; });
    exposed.step(idle, JUDGEMENT.dashTo + 1);
    expect(exposed.engine.snapshot().player.vitality).toBe(970);
    const dashing = bench([], state => { full(state); state.hazards = [hazard()]; });
    dashing.step(press({ ultimatePressed: true }));
    dashing.step(idle, JUDGEMENT.dashTo);
    expect(dashing.engine.snapshot().player.vitality).toBe(1000);
    const anticipation = bench([], state => { full(state); const early = hazard(); early.activeFrom = 3; early.activeUntil = 6; state.hazards = [early]; });
    anticipation.step(press({ ultimatePressed: true }));
    anticipation.step(idle, 12);
    expect(anticipation.engine.snapshot().player.vitality).toBe(970);
  });

  it('places five alternating-angle marks evenly along the path and detonates them sequentially', () => {
    const b = bench([], full);
    b.step(press({ ultimatePressed: true }));
    const start = b.tick;
    b.step(idle, JUDGEMENT.dashTo);
    const marks = b.engine.snapshot().judgementMarks!;
    expect(marks).toHaveLength(5);
    marks.forEach((mark, index) => {
      expect(mark.position.z).toBeCloseTo(-1.6 * (index + 1), 6);
      expect(mark.position.x).toBeCloseTo(0, 6);
      expect(mark.angleRadians).toBeCloseTo(Math.PI + (index % 2 === 0 ? 0.6 : -0.6), 6);
      expect(mark.detonateAtTick).toBe(start + JUDGEMENT.recoveryFrom + JUDGEMENT.detonationDelay + JUDGEMENT.detonationSpacing * index);
      expect(mark.createdAtTick).toBeGreaterThanOrEqual(start + JUDGEMENT.dashFrom);
      expect(mark.createdAtTick).toBeLessThanOrEqual(start + JUDGEMENT.dashTo);
    });
    const remaining: number[] = [];
    b.stepTo(marks[0]!.detonateAtTick - 1);
    remaining.push(b.state.judgementMarks.length);
    for (let index = 0; index < 5; index++) {
      b.stepTo(marks[index]!.detonateAtTick);
      remaining.push(b.state.judgementMarks.length);
    }
    expect(remaining).toEqual([5, 4, 3, 2, 1, 0]);
    const placed = b.cuesOf('judgement-mark', 'anticipation');
    const detonated = b.cuesOf('judgement-mark', 'hit');
    expect(placed).toHaveLength(5);
    expect(detonated.map(cue => cue.scopeId)).toEqual(placed.map(cue => cue.scopeId));
    expect(placed[0]).toMatchObject({ footprint: { width: 2.2, length: 2.2 }, element: 'arcane' });
    expect(detonated[0]).toMatchObject({ intensity: 1.2 });
    expect(b.cuesOf('judgement').map(cue => [cue.phase, cue.tick - start])).toEqual([['anticipation', 0], ['commit', JUDGEMENT.dashFrom], ['resolve', JUDGEMENT.recoveryFrom]]);
    expect(b.cuesOf('judgement', 'commit')[0]).toMatchObject({ from: vec(0, 0, 0), to: vec(0, 0, -8) });
  });

  it('each detonation deals 12 to hostiles within 2.2 m and freezes the world for 6 ticks', () => {
    const b = bench([foe('quarry', 0, -6), foe('bystander', 6, -3)], target('quarry'));
    b.step(press({ ultimatePressed: true }));
    b.step(idle, JUDGEMENT.dashTo);
    let stopped = 0;
    for (let tick = 0; tick < 200 && b.state.judgementMarks.length > 0; tick++) {
      b.step();
      stopped = Math.max(stopped, b.engine.snapshot().hitStop?.remainingTicks ?? 0);
    }
    expect(b.state.judgementMarks).toHaveLength(0);
    // Marks sit at z = -1.5, -3, -4.5, -6, -7.5: the quarry at -6 is inside the last three (2.2 m + its 0.42 m body).
    expect(b.health('quarry')).toBe(1000 - 3 * 12);
    expect(b.health('bystander')).toBe(1000);
    expect(stopped).toBe(6);
  });
});

describe('hit-stop', () => {
  it('freezes the world clock and the player clock for exactly the table ticks, then resumes', () => {
    const b = bench([foe('dummy', 0, -1.6)]);
    b.step(press({ lightPressed: true }));
    b.stepUntil(() => b.health('dummy') < 1000);
    const hitTick = b.tick, hitWorld = b.state.worldTick, recovery = b.state.actionRecoveryUntil;
    expect(b.engine.snapshot().hitStop).toEqual({ remainingTicks: 3, strength: 3 / 7 });
    expect(b.engine.snapshot().worldClock.timeScale).toBe(0);
    const normalized = b.aren.normalizedTime;
    const remaining: Array<number | undefined> = [];
    for (let frozen = 1; frozen <= 3; frozen++) {
      b.step();
      remaining.push(b.engine.snapshot().hitStop?.remainingTicks);
      expect(b.state.worldTick).toBe(hitWorld);
      expect(b.tick).toBe(hitTick + frozen);
      expect(b.aren.normalizedTime).toBe(normalized);
      expect(b.aren.actionStartedTick).toBe(1 + frozen);
      expect(b.state.actionRecoveryUntil).toBe(recovery + frozen);
    }
    expect(remaining).toEqual([2, 1, undefined]);
    expect(b.engine.snapshot().worldClock.timeScale).toBe(1);
    b.step();
    expect(b.state.worldTick).toBe(hitWorld + 1);
    expect(b.aren.normalizedTime).toBeCloseTo((LIGHT_STEPS[0]!.activeFrom + 1) / LIGHT_STEPS[0]!.ticks, 9);
  });

  it('uses the table: light 3/3/4/6, heavy 7, charged heavy and lightning 9, bolt 2, judgement detonation 6', () => {
    const stops: number[] = [];
    for (const step of [1, 2, 3, 4]) {
      const b = bench([foe('dummy', 0, -1.6)], chainedTo(step));
      b.step(press({ lightPressed: true }));
      b.stepUntil(() => b.state.hitStop !== undefined);
      stops.push(b.state.hitStop!.remainingTicks);
    }
    const heavy = bench([foe('dummy', 0, -1.6)], state => { state.targetId = 'dummy' as EngineState['targetId']; });
    heavy.step(press({ heavyPressed: true }));
    heavy.stepUntil(() => heavy.state.hitStop !== undefined);
    stops.push(heavy.state.hitStop!.remainingTicks);
    const charged = bench([foe('dummy', 0, -1.6)], state => { state.targetId = 'dummy' as EngineState['targetId']; });
    charged.step(press({ heavyPressed: true, heavyHeld: true }));
    charged.step(press({ heavyHeld: true }), THUNDER_CLEAVE.holdTicks);
    charged.step(press({ heavyReleased: true, heavyHeldTicks: THUNDER_CLEAVE.holdTicks }));
    charged.stepUntil(() => charged.state.hitStop !== undefined);
    stops.push(charged.state.hitStop!.remainingTicks);
    charged.stepUntil(() => charged.state.hitStop === undefined);
    charged.stepUntil(() => charged.state.hitStop !== undefined);
    stops.push(charged.state.hitStop!.remainingTicks);
    expect(stops).toEqual([3, 3, 4, 6, 7, 9, 9]);
    // Both charged-class hits exceed HIT_STOP_FULL_TICKS (7): strength clamps to 1, so the strength field stays the same.
    expect(charged.state.hitStop!.strength).toBe(1);
  });

  it('takes the longest remaining freeze for simultaneous hits and never stacks', () => {
    const b = bench([foe('a', 0, -2), foe('b', 2, 0), foe('c', -2, 0)], chainedTo(3));
    b.step(press({ lightPressed: true }));
    b.stepUntil(() => b.state.hitStop !== undefined);
    expect(b.health('a')).toBe(987);
    expect(b.health('b')).toBe(987);
    expect(b.health('c')).toBe(987);
    expect(b.state.hitStop).toEqual({ remainingTicks: 4, strength: 4 / 7 });
    const engine = b.engine as unknown as { startHitStop(ticks: number): void };
    engine.startHitStop(2);
    expect(b.state.hitStop!.remainingTicks).toBe(4);
    engine.startHitStop(7);
    expect(b.state.hitStop).toEqual({ remainingTicks: 7, strength: 1 });
    engine.startHitStop(5);
    expect(b.state.hitStop).toEqual({ remainingTicks: 7, strength: 1 });
  });

  it('survives serialize/restore mid-freeze and plays out identically', () => {
    const b = bench([foe('dummy', 0, -1.6)]);
    b.step(press({ lightPressed: true }));
    b.stepUntil(() => b.health('dummy') < 1000);
    b.step();
    expect(b.engine.snapshot().hitStop?.remainingTicks).toBe(2);
    const restored = new Bench(new CombatEngine());
    restored.engine.restore(b.engine.serialize());
    expect(restored.engine.snapshot().hitStop).toEqual(b.engine.snapshot().hitStop);
    expect(restored.engine.snapshot().worldClock).toEqual(b.engine.snapshot().worldClock);
    for (let tick = 0; tick < 30; tick++) {
      b.step();
      restored.step();
      expect(restored.engine.snapshot()).toEqual(b.engine.snapshot());
    }
    expect(b.health('dummy')).toBe(991);
  });

  it('holds its remaining ticks through pause and resumes without losing any', () => {
    const b = bench([foe('dummy', 0, -1.6)]);
    b.step(press({ lightPressed: true }));
    b.stepUntil(() => b.health('dummy') < 1000);
    b.engine.setTimePolicy('paused');
    b.step(idle, 10);
    expect(b.engine.snapshot().hitStop?.remainingTicks).toBe(3);
    b.engine.setTimePolicy('normal');
    expect(b.engine.snapshot().worldClock.timeScale).toBe(0);
    b.step();
    expect(b.engine.snapshot().hitStop?.remainingTicks).toBe(2);
  });

  it('does not spend the Perfect Dodge slow-motion budget', () => {
    const b = bench([foe('dummy', 0, -1.6)], state => { state.timePolicy = 'perfect-dodge-slow'; state.worldTimeScale = 0.25; state.slowMotionRemainingTicks = LIGHT_STEPS[0]!.activeFrom + 12; state.slowMotionElapsedTicks = 3; });
    b.step(press({ lightPressed: true }));
    b.stepUntil(() => b.state.hitStop !== undefined);
    const budget = { remaining: b.state.slowMotionRemainingTicks, elapsed: b.state.slowMotionElapsedTicks };
    expect(budget.remaining).toBeGreaterThan(0);
    b.step(idle, 3);
    expect(b.state.hitStop).toBeUndefined();
    expect({ remaining: b.state.slowMotionRemainingTicks, elapsed: b.state.slowMotionElapsedTicks }).toEqual(budget);
    expect(b.state.timePolicy).toBe('perfect-dodge-slow');
    b.step();
    expect(b.state.slowMotionRemainingTicks).toBe(budget.remaining - 1);
  });


  it('buffers an attack press made during the freeze and starts it when the window opens', () => {
    const b = bench();
    b.step(press({ lightPressed: true }));
    b.stepTo(b.aren.actionEndsTick - 8);
    b.state.hitStop = { remainingTicks: 2, strength: 2 / 7 };
    b.step(press({ lightPressed: true }));
    expect(b.state.bufferedAction?.action).toBe('light_2');
    b.step();
    b.stepUntil(() => b.state.actionId === 'light_2');
    expect(b.aren.actionId).toBe('aren-light-2');
  });

  it('defers a Heavy or Sigil release that lands during the freeze instead of losing it', () => {
    const heavy = bench([foe('dummy', 0, -1.6)], state => { state.targetId = 'dummy' as EngineState['targetId']; });
    heavy.step(press({ heavyPressed: true, heavyHeld: true }));
    heavy.step(press({ heavyHeld: true }), 5);
    const startedAt = heavy.state.heavyChargeStartTick;
    heavy.state.hitStop = { remainingTicks: 2, strength: 2 / 7 };
    heavy.step(press({ heavyReleased: true }));
    expect(heavy.state.heavyChargeStartTick).toBe(startedAt! + 1);
    expect(heavy.state.deferredRelease).toEqual({ heavy: true });
    heavy.step();
    heavy.step();
    expect(heavy.state.pendingImpact?.action).toBe('heavy');
    expect(heavy.state.heavyChargeStartTick).toBeNull();
    const sigil = bench();
    sigil.step(press({ rangedPressed: true, rangedHeld: true }));
    sigil.step(press({ rangedHeld: true }), 3);
    sigil.state.hitStop = { remainingTicks: 2, strength: 2 / 7 };
    sigil.step(press({ rangedReleased: true }));
    expect(sigil.state.sigilCharge).toBeDefined();
    sigil.step(idle, 2);
    expect(sigil.state.sigilCharge).toBeUndefined();
    expect(sigil.aren.actionId).toBe('aren-sigil-bolt');
  });
});

describe('monster flinch reaction', () => {
  it('starts at progress 0 on a light player hit, advances over 12 world ticks without interrupting, then clears', () => {
    const b = bench([foe('dummy', 0, -1.6)]);
    b.step(press({ lightPressed: true }));
    b.stepUntil(() => b.health('dummy') < 1000);
    const hitWorld = b.state.worldTick;
    const react = () => b.engine.snapshot().actors.find(actor => actor.id === 'dummy')!.reaction;
    expect(react()).toMatchObject({ kind: 'flinch', progress: 0, durationTicks: 12, serial: 1 });
    b.step(idle, 3);
    expect(react()!.progress).toBe(0);
    b.step(idle, 6);
    expect(b.state.worldTick - hitWorld).toBe(6);
    expect(react()!.progress).toBeCloseTo(0.5, 9);
    b.step(idle, 6);
    expect(b.state.worldTick - hitWorld).toBe(12);
    expect(react()).toBeUndefined();
    expect(b.engine.snapshot().actors[0]!.reaction).toBeUndefined();
  });

  it('only flinches during an active attack without cancelling that attack or its damage window', () => {
    const b = bench([foe('brute', 0, -1.6)]);
    const attack = ATTACKS['boar-ember-lance']!;
    const hazard: LiveHazard = { ...structuredClone(attack.hazard), id: 'brute-lance', attackId: attack.id as LiveHazard['attackId'], sourceId: 'brute' as LiveHazard['sourceId'], startTick: 0, windupUntil: 0, activeFrom: 0, activeUntil: 400, castUntil: 400, recoveryUntil: 440, target: vec(40, 0, 40), origin: vec(40, 0, 40), direction: vec(0, 0, 1), hitIds: [], threatTicks: [], cue: 'active', damage: 0, bounds: { min: vec(39, 0, 39), max: vec(41, 3, 41) } };
    b.state.hazards = [hazard];
    b.step(press({ lightPressed: true }));
    b.stepUntil(() => b.health('brute') < 1000);
    expect(b.engine.snapshot().actors.find(actor => actor.id === 'brute')).toMatchObject({ attackPhase: 'active', reaction: { kind: 'flinch', progress: 0 } });
    expect(b.state.hazards).toHaveLength(1);
  });

});

describe('presentation cues and snapshot contract', () => {
  it('reports actual overkill loss on the same tick as damage and never hits a downed target again', () => {
    const b = bench([foe('dummy', 0, -1.6)]);
    b.actor('dummy').vitality = 3;
    b.step(press({ lightPressed: true }));
    b.stepUntil(() => b.health('dummy') === 0);
    const damage = b.events.find(event => event.damage?.targetId === 'dummy')!;
    const hit = b.cuesOf('hit')[0]!;
    expect(damage.damage?.amount).toBe(3);
    expect(hit.confirmedDamage).toBe(damage.damage?.amount);
    expect(hit.tick).toBe(damage.tick);
    expect(hit.worldTick).toBe(damage.damage?.worldTick);
    expect(b.actor('dummy').downed).toBe(true);
    b.step(idle, 120);
    b.step(press({ lightPressed: true }));
    b.step(idle, 60);
    expect(b.cuesOf('hit')).toEqual([hit]);
    expect(b.events.filter(event => event.damage?.targetId === 'dummy')).toEqual([damage]);
  });

  it('reports player hits with the contact point, hit direction, damage intensity and element', () => {
    const b = bench([foe('dummy', 0, -2)]);
    b.step(press({ lightPressed: true }));
    b.stepUntil(() => b.health('dummy') < 1000);
    const hit = b.cuesOf('hit')[0]!;
    expect(hit).toMatchObject({ phase: 'hit', actorId: 'aren', targetId: 'dummy', actionId: 'aren-light-1', confirmedDamage: 9, intensity: 9 / 12, element: 'arcane' });
    const target = b.actor('dummy');
    expect(Math.hypot(hit.position!.x - target.position.x, hit.position!.z - target.position.z)).toBeCloseTo(target.radius, 9);
    expect(hit.position!.y).toBeGreaterThan(target.position.y);
    expect(hit.position!.y).toBeLessThan(target.position.y + target.collisionHeight);
    expect(hit.position!.z).toBeGreaterThan(target.position.z);
    expect(hit.to).toEqual({ x: hit.position!.x, y: hit.position!.y, z: hit.position!.z - 1 });
    const slash = b.cuesOf('slash')[0]!;
    expect(slash).toMatchObject({ phase: 'active', actorId: 'aren', position: vec(0, 0, 0), element: 'arcane' });
    expect(slash.footprint).toEqual({ width: 2.3, length: 2.3, angleRadians: Math.PI, sectorRadians: 2.4 });
    expect(slash.tick).toBe(hit.tick);
  });

  it('slashes for Heavy and Charged Heavy with the contract intensities', () => {
    const heavy = bench([foe('dummy', 0, -1.6)], state => { state.targetId = 'dummy' as EngineState['targetId']; });
    heavy.step(press({ heavyPressed: true }));
    heavy.stepUntil(() => heavy.cuesOf('slash').length > 0);
    expect(heavy.cuesOf('slash')[0]).toMatchObject({ actionId: 'aren-heavy', intensity: 1.6, durationTicks: 6, element: 'arcane' });
    const charged = bench([foe('dummy', 0, -1.6)], state => { state.targetId = 'dummy' as EngineState['targetId']; });
    charged.step(press({ heavyPressed: true, heavyHeld: true }));
    charged.step(press({ heavyHeld: true }), THUNDER_CLEAVE.holdTicks);
    charged.step(press({ heavyReleased: true, heavyHeldTicks: THUNDER_CLEAVE.holdTicks }));
    charged.stepUntil(() => charged.cuesOf('slash').length > 0);
    expect(charged.cuesOf('slash')[0]).toMatchObject({ actionId: 'aren-charged-heavy', intensity: 2 });
  });

  it('exposes projectiles, marks and hit-stop only while they exist and restores them from a save', () => {
    const b = bench([foe('dummy', 0, -9)]);
    expect(b.engine.snapshot().playerProjectiles).toBeUndefined();
    expect(b.engine.snapshot().judgementMarks).toBeUndefined();
    expect(b.engine.snapshot().hitStop).toBeUndefined();
    b.step(press({ rangedPressed: true }));
    b.stepUntil(() => b.state.playerProjectiles.length === 1);
    const restored = new Bench(new CombatEngine());
    restored.engine.restore(b.engine.serialize());
    expect(restored.engine.snapshot().playerProjectiles).toEqual(b.engine.snapshot().playerProjectiles);
    expect(restored.engine.snapshot().playerProjectiles).toHaveLength(1);
    b.stepUntil(() => b.health('dummy') < 1000);
    restored.stepUntil(() => restored.health('dummy') < 1000);
    expect(restored.state.tick).toBe(b.state.tick);
  });

  it('loads a save written before the Arsenal existed', () => {
    const legacy = JSON.parse(new CombatEngine(createEngineState()).serialize()) as Record<string, unknown>;
    for (const key of ['playerProjectiles', 'judgementMarks', 'arsenalSequence', 'hitStop', 'swing', 'cast', 'lightChainFrom', 'lightChainUntil', 'sigilCharge']) delete legacy[key];
    const engine = new CombatEngine();
    engine.restore(JSON.stringify(legacy));
    expect(engine.snapshot().skills.map(skill => skill.id)).toEqual(['dive', 'jump', 'light', 'heavy', 'sigil_bolt', 'root_tether', 'judgement']);
    engine.fixedStep(press({ lightPressed: true }));
    expect(engine.snapshotState().actionId).toBe('light_1');
  });

});

describe('determinism under mixed Arsenal input', () => {
  /** Seeded button-mashing in 100-tick phases (blade, sigil, held Heavy, Judgement) with consistent press/hold/release edges. */
  function mash(seed: number): (tick: number) => CombatInput {
    let state = seed >>> 0, heavyHeld = false, rangedHeld = false;
    const next = (): number => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    return tick => {
      const phase = Math.floor(tick / 100) % 4;
      const heavyNow = heavyHeld ? next() > (phase === 2 ? 0.015 : 0.3) : next() < (phase === 2 ? 0.05 : 0.002);
      const rangedNow = rangedHeld ? next() > (phase === 1 ? 0.03 : 0.3) : next() < (phase === 1 ? 0.06 : 0.002);
      const frame = press({
        move: next() < 0.7 ? vec(0, 0, 0) : vec(Math.round(next() * 2 - 1), 0, Math.round(next() * 2 - 1)),
        lightPressed: next() < (phase === 0 || phase === 3 ? 0.15 : 0.01), dodgePressed: next() < 0.004, ultimatePressed: phase === 3 && tick % 100 === 5,
        heavyPressed: !heavyHeld && heavyNow, heavyHeld: heavyNow, heavyReleased: heavyHeld && !heavyNow,
        rangedPressed: !rangedHeld && rangedNow, rangedHeld: rangedNow, rangedReleased: rangedHeld && !rangedNow,
      });
      heavyHeld = heavyNow; rangedHeld = rangedNow;
      return frame;
    };
  }

  it('keeps every Arsenal invariant and replays identically from a mid-fight save', () => {
    const rig = () => bench([foe('a', 0, -3), foe('b', 4, -6), foe('c', -5, -2, true)], state => { state.targetId = 'a' as EngineState['targetId']; wall(-9)(state); });
    const run = rig(), frames = mash(2025);
    const script: CombatInput[] = Array.from({ length: 1400 }, (_, tick) => frames(tick));
    const topUp = (b: Bench, tick: number): void => { if (tick % 100 === 0) { b.state.player.mana = 100; b.state.player.instinct = 100; } };
    for (let tick = 0; tick < 700; tick++) {
      topUp(run, tick);
      run.step(script[tick]!);
      const snapshot = run.engine.snapshot();
      expect(snapshot.hitStop === undefined || (snapshot.hitStop.remainingTicks >= 1 && snapshot.hitStop.remainingTicks <= 7)).toBe(true);
      expect(snapshot.player.mana).toBeGreaterThanOrEqual(0);
      expect(snapshot.player.mana).toBeLessThanOrEqual(100);
      expect(snapshot.player.instinct).toBeGreaterThanOrEqual(0);
      expect(snapshot.player.instinct).toBeLessThanOrEqual(100);
      expect((snapshot.playerProjectiles ?? []).length).toBeLessThanOrEqual(12);
      expect((snapshot.judgementMarks ?? []).length).toBeLessThanOrEqual(10);
    }
    const restored = new Bench(new CombatEngine());
    restored.engine.restore(run.engine.serialize());
    const replayEventsStart = run.events.length;
    for (let tick = 700; tick < 1400; tick++) {
      topUp(run, tick);
      topUp(restored, tick);
      run.step(script[tick]!);
      restored.step(script[tick]!);
      expect(restored.engine.snapshot()).toEqual(run.engine.snapshot());
    }
    expect(run.state.tick).toBe(1400);
    const outcome = (event: CombatEvent) => [event.tick, event.kind, event.actorId, event.targetId, event.actionId, event.damage];
    expect(restored.events.map(outcome)).toEqual(run.events.slice(replayEventsStart).map(outcome));
    expect(Math.min(...['a', 'b', 'c'].map(id => run.health(id)))).toBeLessThan(1000);
  });
});
