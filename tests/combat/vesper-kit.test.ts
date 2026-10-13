import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ASSET_PLAYTESTS } from '../../src/app/AssetPlaytests.js';
import { REGIONS } from '../../src/content/campaign.js';
import type { ActorId } from '../../src/game/contracts.js';
import type { StoryCue } from '../../src/effects/story-cues.js';
import { createCombatTrialRegion } from '../../src/game/combat/TrialRegions.js';
import { CombatEngine, type CombatActor, type CombatInput, type EngineState, type LiveHazard } from '../../src/game/combat/CombatEngine.js';
import { ATTACKS } from '../../src/game/combat/content.js';
import { distance2, groundHeightAt, isCirclePathClear, isSupportedCapsulePose, moveCircle, vec } from '../../src/game/combat/geometry.js';
import { HERO_COMBAT } from '../../src/game/combat/HeroProfiles.js';
import { createVesperKit } from '../../src/game/combat/kits/VesperKit.js';
import { KIT_FACTORIES } from '../../src/game/combat/kits/registry.js';
import { PLAYER_SKILLS, SIGIL, THUNDER_CLEAVE } from '../../src/game/combat/PlayerSkills.js';
import { VESPER, VESPER_CLIPS, VESPER_LABELS } from '../../src/game/combat/VesperSkills.js';

const idle: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
const PLAYER_RADIUS = 0.42;

function liveState(engine: CombatEngine): EngineState {
  return (engine as unknown as { state: EngineState }).state;
}

interface BenchOptions {
  /** Metres between the player and the monster along z (the player faces -z, toward it). */
  distance?: number;
  /** The monster's facing: `toward` the player (no backstabs), `away` from it, or `none` (a zero vector: backstab never applies). */
  facing?: 'toward' | 'away' | 'none' | { x: number; y: number; z: number };
  /** Leave the monster's AI running (it casts real attacks) instead of holding it in recovery. */
  live?: boolean;
}

/** A real greenwake trial run as Vesper: real monster, real arena and gates, the monster frozen unless `live`. */
function bench(options: BenchOptions = {}): Bench {
  const { distance = 2, facing = 'none', live = false } = options;
  const playtest = ASSET_PLAYTESTS.find(candidate => candidate.id === 'greenwake')!;
  const region = createCombatTrialRegion(REGIONS.find(candidate => candidate.id === playtest.regionId)!);
  const engine = new CombatEngine();
  engine.loadRegion({ regionId: playtest.regionId, regionDefinition: region, runId: 'vesper-kit', presentActorIds: playtest.trialSet.trials.map(trial => trial.monsterId) });
  engine.setPlayerHero('vesper');
  engine.startEncounter({ encounterId: playtest.trialSet.encounterId, regionId: playtest.regionId, runId: 'vesper-kit' });
  engine.enableCombatTrials();
  const seed = engine.snapshotState();
  const trial = playtest.trialSet.trials[seed.combatTrial!.index]!;
  const monster0 = seed.actors.find(actor => actor.id === trial.monsterId)!;
  const player0 = seed.actors.find(actor => actor.id === seed.playerId)!;
  monster0.vitality = monster0.maxVitality = 100_000;
  monster0.ferocity = 0;
  if (!live) monster0.staggerUntil = 100_000;
  player0.position = vec(monster0.position.x, monster0.position.y, monster0.position.z + distance);
  player0.facing = vec(0, 0, -1);
  player0.velocity = vec(0, 0, 0);
  seed.targetId = monster0.id;
  const subject = new CombatEngine(seed);
  const state = liveState(subject);
  state.player.vitality = state.player.maxVitality = 10_000;
  state.player.mana = state.player.maxMana = 100_000;
  state.player.instinct = 0;
  const player = state.actors.find(actor => actor.id === state.playerId)!;
  player.vitality = player.maxVitality = 10_000;
  const monster = state.actors.find(actor => actor.id === trial.monsterId)!;
  const cues: StoryCue[] = [];
  let tick = 0;
  const pin = () => {
    const away = Math.hypot(player.position.x - monster.position.x, player.position.z - monster.position.z) || 1;
    const toward = vec((player.position.x - monster.position.x) / away, 0, (player.position.z - monster.position.z) / away);
    if (typeof facing === 'object') monster.facing = vec(facing.x, facing.y, facing.z);
    else if (facing === 'none') monster.facing = vec(0, 0, 0);
    else monster.facing = facing === 'toward' ? toward : vec(-toward.x, 0, -toward.z);
  };
  const step = (patch: Partial<CombatInput> = {}, count = 1) => {
    for (let i = 0; i < count; i++) {
      if (!live) pin();
      subject.fixedStep({ ...idle, tick: ++tick, ...patch });
      cues.push(...subject.drainPresentationCues());
    }
  };
  const runLive = (liveTicks: number, each?: (age: number) => void) => {
    const start = state.worldTick;
    let age = 0;
    for (let guard = 0; guard < liveTicks * 4 + 20 && age < liveTicks; guard++) {
      step();
      if (state.worldTick - start > age) { age = Math.round(state.worldTick - start); each?.(age); }
    }
  };
  return { engine: subject, state, player, monster, cues, step, runLive, health: () => monster.vitality!, pin };
}

interface Bench {
  engine: CombatEngine;
  state: EngineState;
  player: CombatActor;
  monster: CombatActor;
  cues: StoryCue[];
  step(patch?: Partial<CombatInput>, count?: number): void;
  /** Steps until `liveTicks` unfrozen world ticks have passed (hit-stop freezes do not count), calling `each(age)` after every live tick. */
  runLive(liveTicks: number, each?: (age: number) => void): void;
  health(): number;
  pin(): void;
}

const standing = (b: Bench) => isSupportedCapsulePose(b.state.arena, b.player.position, PLAYER_RADIUS, b.player.collisionHeight);
/** Centre of the player is on an authored walkable surface. */
const walkable = (b: Bench) => groundHeightAt(b.state.arena, b.player.position.x, b.player.position.z, b.player.position.y) !== null;
/** The z where walkable ground ends going toward -z from the monster's z. */
function floorEdgeZ(b: Bench): number {
  let z = b.monster.position.z;
  while (groundHeightAt(b.state.arena, b.monster.position.x, z, b.monster.position.y) !== null) z -= 0.05;
  return z + 0.05;
}
const insideBounds = (b: Bench) => {
  const { min, max } = b.state.arena.bounds, { x, z } = b.player.position;
  return x >= min.x + PLAYER_RADIUS - 1e-6 && x <= max.x - PLAYER_RADIUS + 1e-6 && z >= min.z + PLAYER_RADIUS - 1e-6 && z <= max.z - PLAYER_RADIUS + 1e-6;
};
const damageEvents = (b: Bench, actionId: string) => b.engine.consumeEvents().filter(event => event.kind === 'damage' && event.actionId === actionId);

/** An unblockable hazard covering the whole arena, live from `activeFrom` for 300 world ticks (the seam tests use the same shape). */
function floorHazard(b: Bench, damage: number, activeFrom: number): LiveHazard {
  const attack = ATTACKS['koro-fruit-burst']!;
  return {
    ...structuredClone(attack.hazard), id: 'floor-burst', attackId: attack.id,
    sourceId: b.monster.id as ActorId, targetActorId: b.state.playerId, startTick: b.state.worldTick, activeFrom: b.state.worldTick + activeFrom, activeUntil: b.state.worldTick + activeFrom + 300,
    target: vec(0, 0, 0), origin: vec(0, 0, 0), direction: vec(0, 0, 1), width: 400, depth: 400, damage, hitIds: [], threatTicks: [], cue: 'burst',
    bounds: { min: vec(-200, -50, -200), max: vec(200, 50, 200) },
  };
}

/** Mashes J until the Crescent Rift step begins (the current tick is its first). */
function reachRift(b: Bench): void {
  for (let tick = 0; tick < 200 && b.player.actionId !== VESPER_CLIPS.light_4!; tick++) b.step({ lightPressed: true });
  expect(b.player.actionId).toBe(VESPER_CLIPS.light_4!);
}

/** Mashes J until Moonlit Iai step `step` begins (the current tick is its first). */
function reachStep(b: Bench, step: number): void {
  for (let tick = 0; tick < 200 && b.player.actionId !== VESPER_CLIPS[`light_${step}`]!; tick++) b.step({ lightPressed: true });
  expect(b.player.actionId).toBe(VESPER_CLIPS[`light_${step}`]!);
}

const registered = { ...KIT_FACTORIES };
beforeAll(() => { KIT_FACTORIES.vesper = createVesperKit; });
afterAll(() => { delete KIT_FACTORIES.vesper; Object.assign(KIT_FACTORIES, registered); });

describe('Vesper kit definition', () => {
  it('declares the Moonlit Iai chain, labels, clips and Mist Blink profile from the data file', () => {
    const b = bench();
    const skills = b.engine.snapshot().skills;
    expect(skills.find(skill => skill.id === 'light')!.label).toBe(VESPER_LABELS.light!);
    expect(skills.find(skill => skill.id === 'dive')!.label).toBe(VESPER_LABELS.dive!);
    expect(skills.find(skill => skill.id === 'judgement')!.label).toBe(VESPER_LABELS.judgement!);
    expect(HERO_COMBAT.vesper.element).toBe('umbral');
    expect(VESPER.iai.steps.map(step => step.damage)).toEqual([12, 12, 15, 22]);
    expect(VESPER.iai.steps.map(step => step.ticks)).toEqual([18, 18, 22, 30]);
  });
});

describe('Moonlit Iai', () => {
  it('lands each step on its active tick with its damage, chaining inside the early/late window', () => {
    const b = bench({ facing: 'none' });
    const starts: number[] = [];
    let previous = '';
    const damageTicks: number[] = [];
    let health = b.health();
    const damages: number[] = [];
    // Mash J: early presses are rejected, the window opens 4 ticks before each clip ends.
    for (let tick = 0; tick < 130 && damages.length < 4; tick++) {
      b.step({ lightPressed: true });
      if (b.player.actionId !== previous && b.player.actionId.startsWith('vesper-iai')) starts.push(tick);
      previous = b.player.actionId;
      if (b.health() < health) { damages.push(health - b.health()); damageTicks.push(tick); health = b.health(); }
    }
    expect(b.cues.filter(cue => cue.kind === 'slash').length).toBeGreaterThanOrEqual(3);
    // Step 3 → the 4th step's strike is the Crescent Rift lane; every hit carries the kit's clip.
    expect(starts.length).toBe(4);
    for (let index = 0; index < 4; index++) {
      const spec = VESPER.iai.steps[index]!;
      // The first hit of every step comes exactly `activeAt` ticks after the step began (the hit-stop of earlier hits only delays whole steps);
      // Crescent Rift strikes the tick the dash's swept segment first reaches the foe, which for a foe this close is the first dash tick.
      expect(damageTicks[index]! - starts[index]!).toBe(index === 3 ? VESPER.iai.riftDashFrom : spec.activeAt);
      if (index > 0) {
        const gap = starts[index]! - starts[index - 1]!;
        const previousSpec = VESPER.iai.steps[index - 1]!;
        expect(gap).toBeGreaterThanOrEqual(previousSpec.ticks - VESPER.iai.chainEarlyTicks);
        expect(gap).toBeLessThanOrEqual(previousSpec.ticks + VESPER.iai.chainLateTicks + 4);
      }
    }
    // 12, 12, 15 build the three Death Mark stacks; the fourth hit is Crescent Rift's 22 plus the +25 Shadow Execution.
    expect(damages).toEqual([12, 12, 15, 22 + VESPER.deathMark.executionDamage]);
  });

  it('a press after the late window restarts the chain at step 1', () => {
    const b = bench();
    b.step({ lightPressed: true });
    b.step({}, 18 + VESPER.iai.chainLateTicks + 10);
    b.step({ lightPressed: true });
    expect(b.player.actionId).toBe(VESPER_CLIPS.light_1!);
  });

  it('Crescent Rift passes through the target, stays collision-safe and is untouchable while dashing', () => {
    const b = bench({ distance: 1.6 });
    reachRift(b);
    const from = { ...b.player.position };
    const vitalityBefore = b.state.player.vitality;
    // The hazard goes live one tick into the dash and stays live: only the untouchable window protects Vesper.
    b.state.hazards.push(floorHazard(b, 40, VESPER.iai.riftDashFrom + 1));
    b.runLive(VESPER.iai.riftDashTo, age => {
      expect(standing(b)).toBe(true);
      expect(insideBounds(b)).toBe(true);
      if (age >= VESPER.iai.riftDashFrom) expect(b.engine.snapshot().player.untargetable).toBe(true);
    });
    expect(b.state.player.vitality).toBe(vitalityBefore);
    // 4.5 m through the target: it ends on the far side.
    const travelled = distance2(from, b.player.position);
    expect(travelled).toBeGreaterThan(VESPER.iai.riftDashDistance - 0.6);
    expect(travelled).toBeLessThanOrEqual(VESPER.iai.riftDashDistance + 1e-6);
    expect(from.z).toBeGreaterThan(b.monster.position.z);
    expect(b.player.position.z).toBeLessThan(b.monster.position.z);
    // The hazard bites once the untouchable window is over.
    b.runLive(6);
    expect(b.state.player.vitality).toBeLessThan(vitalityBefore);
  });

  it('Crescent Rift never leaves walkable ground: a dash toward the floor edge stops at it', () => {
    const b = bench({ distance: 1.6 });
    const edge = floorEdgeZ(b);
    b.monster.position = vec(b.monster.position.x, b.monster.position.y, edge + 2.5);
    b.player.position = vec(b.monster.position.x, b.player.position.y, edge + 4.1);
    b.player.facing = vec(0, 0, -1);
    reachRift(b);
    b.runLive(20, () => { expect(walkable(b)).toBe(true); });
    expect(b.player.position.z).toBeGreaterThan(edge - 0.2);
    expect(b.player.position.z).toBeLessThan(b.monster.position.z);
    expect(4.1 - (b.player.position.z - edge)).toBeLessThan(VESPER.iai.riftDashDistance);
  });

  it('Crescent Rift strikes only what the dash has actually swept: a foe near the lane end is untouched until Vesper reaches it', () => {
    const b = bench({ distance: 4 });
    reachRift(b);
    const radius = b.monster.radius;
    const lateral = 1 + radius;
    let struck = false;
    b.runLive(VESPER.iai.riftDashTo + 2, () => {
      const hurt = b.health() < 100_000;
      if (!hurt) { expect(distance2(b.player.position, b.monster.position)).toBeGreaterThan(0); return; }
      if (!struck) {
        struck = true;
        // The first hit lands only once the swept segment has come within the lane half-width of the foe.
        expect(distance2(b.player.position, b.monster.position)).toBeLessThanOrEqual(lateral + 1e-6);
      }
    });
    expect(struck).toBe(true);
    expect(100_000 - b.health()).toBe(VESPER.iai.steps[3]!.damage);
  });

  it('Crescent Rift does not strike a foe near the lane end on the ticks before Vesper arrives', () => {
    const b = bench({ distance: 4.4 });
    reachRift(b);
    const before = b.health();
    b.runLive(VESPER.iai.riftDashFrom + 2);
    expect(b.health()).toBe(before);
    expect(damageEvents(b, 'light_4')).toHaveLength(0);
  });

  it('Crescent Rift strikes a foe that steps into the lane mid-dash, once', () => {
    const b = bench({ distance: 7 });
    const { x } = b.monster.position;
    b.monster.position = vec(x + 6, b.monster.position.y, b.monster.position.z);
    reachRift(b);
    b.runLive(VESPER.iai.riftDashFrom + 2);
    b.engine.consumeEvents();
    expect(b.health()).toBe(100_000);
    b.monster.position = vec(b.player.position.x, b.monster.position.y, b.player.position.z - 1.5);
    b.runLive(VESPER.iai.riftDashTo);
    expect(damageEvents(b, 'light_4')).toHaveLength(1);
    expect(b.health()).toBe(100_000 - VESPER.iai.steps[3]!.damage);
  });

  it('Crescent Rift is still blocked by a wall between the lane and the foe', () => {
    const b = bench({ distance: 1.6 });
    const { x, y, z } = b.monster.position;
    b.state.arena.colliders.push({ id: 'rift-wall', kind: 'box', from: vec(x, y + 1.5, z + 0.8), halfExtents: vec(80, 1.5, 0.3), blocksMovement: true, blocksCamera: true });
    reachRift(b);
    b.runLive(VESPER.iai.steps[3]!.ticks);
    expect(b.health()).toBe(100_000);
    expect(b.engine.consumeEvents().some(event => event.kind === 'damage' && event.damage?.targetId === b.monster.id)).toBe(false);
  });
});

describe('Death Mark and backstab', () => {
  it('a hit from behind deals ×1.5 and a hit from the front does not', () => {
    const front = bench({ facing: 'toward' });
    front.step({ lightPressed: true }, 8);
    expect(100_000 - front.health()).toBe(VESPER.iai.steps[0]!.damage);
    const behind = bench({ facing: 'away' });
    behind.step({ lightPressed: true }, 8);
    expect(100_000 - behind.health()).toBe(Math.round(VESPER.iai.steps[0]!.damage * VESPER.backstab.multiplier));
  });

  it('three hits within the window mark the target, the next hit executes it for +25 with a hit-stop, and the mark is consumed', () => {
    const c = bench();
    const hit = () => { const before = c.health(); c.step({ lightPressed: true }); c.step({}, 7); const dealt = before - c.health(); c.step({}, 40); return dealt; };
    const cMarks = () => c.engine.snapshot().actors.find(actor => actor.id === c.monster.id)!.heroMarks;
    expect(hit()).toBe(12);
    expect(cMarks()).toEqual([{ kind: 'death-stack', stacks: 1, remainingTicks: expect.any(Number) }]);
    expect(hit()).toBe(12);
    expect(cMarks()?.[0]).toMatchObject({ kind: 'death-stack', stacks: 2 });
    expect(hit()).toBe(12);
    expect(cMarks()).toEqual([{ kind: 'death-mark', remainingTicks: expect.any(Number) }]);
    expect(cMarks()![0]!.remainingTicks).toBeLessThanOrEqual(VESPER.deathMark.markTicks);
    // The mark is consumed by the next hit, which carries the execution bonus and a 6-tick freeze.
    const before = c.health();
    c.step({ lightPressed: true });
    c.step({}, 6);
    expect(c.engine.snapshot().hitStop?.remainingTicks ?? 0).toBeGreaterThanOrEqual(1);
    expect(before - c.health()).toBe(12 + VESPER.deathMark.executionDamage);
    expect(cMarks()).toEqual([{ kind: 'death-stack', stacks: 1, remainingTicks: expect.any(Number) }]);
  });

  it('the execution removes the mark in the same tick and emits an accented umbral hit cue', () => {
    const b = bench();
    const marks = () => b.engine.snapshot().actors.find(actor => actor.id === b.monster.id)!.heroMarks?.map(mark => mark.kind);
    for (let index = 0; index < 3; index++) { b.step({ lightPressed: true }); b.step({}, 38); }
    expect(marks()).toEqual(['death-mark']);
    b.cues.length = 0;
    b.step({ lightPressed: true });
    let guard = 0;
    while (marks()?.includes('death-mark') && guard++ < 20) b.step();
    expect(marks()?.includes('death-mark')).toBe(false);
    const accent = b.cues.find(cue => cue.kind === 'hit' && (cue.intensity ?? 0) >= 1.5);
    expect(accent).toMatchObject({ element: 'umbral', actionId: VESPER_CLIPS.light_4, targetId: b.monster.id });
    // The mark vanished with most of its 240 ticks left: it was consumed, not expired.
    expect(guard).toBeLessThan(20);
  });

  it('stacks expire after 180 ticks and a Death Mark after 240', () => {
    const b = bench();
    const marksOf = () => b.engine.snapshot().actors.find(actor => actor.id === b.monster.id)!.heroMarks;
    b.step({ lightPressed: true });
    b.step({}, 7);
    expect(marksOf()?.[0]).toMatchObject({ kind: 'death-stack', stacks: 1 });
    b.step({}, VESPER.deathMark.stackWindowTicks + 2);
    expect(marksOf()).toBeUndefined();
    // Build a mark, then let it lapse unconsumed.
    for (let index = 0; index < 3; index++) { b.step({ lightPressed: true }); b.step({}, 38); }
    expect(marksOf()?.[0]).toMatchObject({ kind: 'death-mark' });
    b.step({}, VESPER.deathMark.markTicks + 2);
    expect(marksOf()).toBeUndefined();
  });
});

describe('Shadow Step', () => {
  it('blinks behind the soft target on tick 4 and lands the 26-damage backstab on tick 8', () => {
    // The monster faces +z, toward where the player starts, so landing behind it is a backstab.
    const b = bench({ distance: 6, facing: vec(0, 0, 1) });
    const start = { ...b.player.position };
    b.step({ heavyPressed: true });
    expect(b.player.actionId).toBe(VESPER_CLIPS.heavy!);
    expect(b.state.player.mana).toBe(100_000 - PLAYER_SKILLS.heavy.manaCost);
    b.runLive(VESPER.shadowStep.blinkAt - 1);
    expect(distance2(b.player.position, start)).toBe(0);
    b.runLive(1);
    expect(distance2(b.player.position, start)).toBeGreaterThan(5);
    expect(b.player.position.z).toBeLessThan(b.monster.position.z);
    const gap = distance2(b.player.position, b.monster.position);
    expect(gap).toBeGreaterThan(b.monster.radius);
    expect(gap).toBeLessThan(b.monster.radius + 1.5);
    expect(b.player.facing.z).toBeGreaterThan(0.9);
    expect(standing(b)).toBe(true);
    const blink = b.cues.find(cue => cue.kind === 'blink' && cue.actionId === VESPER_CLIPS.heavy);
    expect(blink).toMatchObject({ element: 'umbral', actorId: 'aren' });
    expect(distance2(blink!.from!, blink!.to!)).toBeGreaterThan(5);
    const before = b.health();
    b.runLive(VESPER.shadowStep.strikeAt - VESPER.shadowStep.blinkAt - 1);
    expect(b.health()).toBe(before);
    b.runLive(1);
    expect(before - b.health()).toBe(Math.round(VESPER.shadowStep.damage * VESPER.backstab.multiplier));
  });

  it('a target in front deals the plain 26', () => {
    const b = bench({ distance: 6, facing: 'none' });
    b.step({ heavyPressed: true });
    b.runLive(VESPER.shadowStep.strikeAt);
    expect(100_000 - b.health()).toBe(VESPER.shadowStep.damage);
  });

  it('with no target in range it blinks 6 m forward onto standable ground', () => {
    const b = bench({ distance: 3 });
    b.monster.position = vec(b.monster.position.x + 40, b.monster.position.y, b.monster.position.z);
    const start = { ...b.player.position };
    b.player.facing = vec(0, 0, -1);
    // The farthest 0.25 m step from 6 m inward that is standable and reachable without crossing a wall.
    let expected = 0;
    for (let d = VESPER.shadowStep.fallbackDistance; d > 0.2 && expected === 0; d -= 0.25) {
      const y = groundHeightAt(b.state.arena, start.x, start.z - d, start.y);
      const point = vec(start.x, y ?? start.y, start.z - d);
      if (y !== null && isSupportedCapsulePose(b.state.arena, point, PLAYER_RADIUS, b.player.collisionHeight) && isCirclePathClear(b.state.arena, start, point, PLAYER_RADIUS, b.player.collisionHeight)) expected = d;
    }
    expect(expected).toBeGreaterThan(0);
    b.step({ heavyPressed: true });
    b.runLive(VESPER.shadowStep.blinkAt);
    expect(distance2(b.player.position, start)).toBeCloseTo(expected, 6);
    expect(distance2(b.player.position, start)).toBeLessThanOrEqual(VESPER.shadowStep.fallbackDistance);
    expect(standing(b)).toBe(true);
  });

  it('every step cancels into Shadow Step after its active frame, but not before', () => {
    for (const step of [1, 2, 3, 4]) {
      const active = VESPER.iai.steps[step - 1]!.activeAt;
      const early = bench();
      reachStep(early, step);
      early.runLive(active - 1);
      early.step({ heavyPressed: true });
      expect(early.player.actionId).toBe(VESPER_CLIPS[`light_${step}`]!);
      const late = bench();
      reachStep(late, step);
      late.runLive(active + 1);
      late.step({ heavyPressed: true });
      expect(late.player.actionId).toBe(VESPER_CLIPS.heavy!);
      expect(late.state.player.mana).toBe(100_000 - PLAYER_SKILLS.heavy.manaCost);
      // Short on mana it stays in the step.
      const poor = bench();
      poor.state.player.mana = 0;
      reachStep(poor, step);
      poor.runLive(active + 1);
      poor.step({ heavyPressed: true });
      expect(poor.player.actionId).toBe(VESPER_CLIPS[`light_${step}`]!);
    }
  });

  it('every step cancels into Mist Blink once its active frame has passed, but not before', () => {
    for (const step of [1, 2, 3, 4]) {
      const active = VESPER.iai.steps[step - 1]!.activeAt;
      const b = bench();
      reachStep(b, step);
      b.runLive(active + 1);
      b.step({ dodgePressed: true });
      expect(b.cues.some(cue => cue.kind === 'blink' && cue.actionId === VESPER_CLIPS.dodge)).toBe(true);
      const early = bench();
      reachStep(early, step);
      early.runLive(active - 1);
      early.step({ dodgePressed: true });
      expect(early.player.actionId).toBe(VESPER_CLIPS[`light_${step}`]!);
      expect(early.cues.some(cue => cue.kind === 'blink')).toBe(false);
    }
  });

  it('Crescent Rift cancels from its active tick + 1 (not the dash end) and the replacement cleanly ends the live dash', () => {
    const open = VESPER.iai.steps[3]!.activeAt + 1;
    expect(open).toBeLessThan(VESPER.iai.riftDashTo);
    for (const age of [open - 1, open, open + 1, VESPER.iai.riftDashTo - 1]) {
      for (const into of ['heavy', 'dodge'] as const) {
        const b = bench({ distance: 7 });
        reachRift(b);
        b.runLive(age);
        expect(b.engine.snapshot().player.untargetable).toBe(true);
        const rifted = damageEvents(b, 'light_4').length;
        b.engine.consumeEvents();
        b.step(into === 'heavy' ? { heavyPressed: true } : { dodgePressed: true });
        if (into === 'heavy') {
          expect(b.player.actionId).toBe(VESPER_CLIPS.heavy!);
          // The dash is over: no leftover velocity and no untouchable window.
          expect(Math.hypot(b.player.velocity.x, b.player.velocity.z)).toBe(0);
          expect(b.engine.snapshot().player.untargetable).not.toBe(true);
        } else expect(b.cues.some(cue => cue.kind === 'blink' && cue.actionId === VESPER_CLIPS.dodge)).toBe(true);
        b.runLive(VESPER.iai.steps[3]!.ticks);
        expect(rifted).toBe(0);
        expect(damageEvents(b, 'light_4')).toHaveLength(0);
      }
    }
    // Before the window opens the dash carries on.
    const early = bench({ distance: 7 });
    reachRift(early);
    early.runLive(open - 2);
    early.step({ heavyPressed: true });
    expect(early.player.actionId).toBe(VESPER_CLIPS.light_4!);
  });

  it('Shadow Step cancels into Moonlit Iai, a second Shadow Step or Mist Blink after its strike, but not before', () => {
    const press = (patch: Partial<CombatInput>, liveTicks: number) => {
      const b = bench();
      b.step({ heavyPressed: true });
      b.runLive(liveTicks);
      b.step(patch);
      return b;
    };
    const open = VESPER.shadowStep.strikeAt + 1;
    expect(press({ lightPressed: true }, open - 3).player.actionId).toBe(VESPER_CLIPS.heavy!);
    expect(press({ heavyPressed: true }, open - 3).state.player.mana).toBe(100_000 - PLAYER_SKILLS.heavy.manaCost);
    expect(press({ dodgePressed: true }, open - 3).cues.some(cue => cue.kind === 'blink' && cue.actionId === VESPER_CLIPS.dodge)).toBe(false);
    expect(press({ lightPressed: true }, open).player.actionId).toBe(VESPER_CLIPS.light_1!);
    expect(press({ heavyPressed: true }, open).state.player.mana).toBe(100_000 - 2 * PLAYER_SKILLS.heavy.manaCost);
    expect(press({ dodgePressed: true }, open).cues.some(cue => cue.kind === 'blink' && cue.actionId === VESPER_CLIPS.dodge)).toBe(true);
  });

  it('an iai cancelled into Shadow Step leaves no second iai strike behind', () => {
    const b = bench({ distance: 2 });
    b.step({ lightPressed: true });
    b.runLive(VESPER.iai.steps[0]!.activeAt + 1);
    b.step({ heavyPressed: true });
    expect(b.player.actionId).toBe(VESPER_CLIPS.heavy!);
    b.runLive(VESPER.shadowStep.ticks);
    const events = b.engine.consumeEvents().filter(event => event.kind === 'damage');
    expect(events.filter(event => event.actionId === 'light_1')).toHaveLength(1);
    expect(events.filter(event => event.actionId === 'heavy')).toHaveLength(1);
  });

  it('an obstructed Shadow Step neither damages nor marks the target through a wall', () => {
    const b = bench({ distance: 6, facing: vec(0, 0, 1) });
    const { x, y, z } = b.monster.position;
    // A wall spanning the whole arena between the player and the monster: no landing spot exists on the monster's side.
    b.state.arena.colliders.push({ id: 'shade-wall', kind: 'box', from: vec(x, y + 1.5, z + 3), halfExtents: vec(80, 1.5, 0.3), blocksMovement: true, blocksCamera: true });
    const before = b.health();
    b.step({ heavyPressed: true });
    b.runLive(VESPER.shadowStep.ticks);
    expect(b.state.player.mana).toBe(100_000 - PLAYER_SKILLS.heavy.manaCost);
    expect(b.player.position.z).toBeGreaterThan(z + 3);
    expect(b.health()).toBe(before);
    expect(b.engine.snapshot().actors.find(actor => actor.id === b.monster.id)!.heroMarks).toBeUndefined();
    expect(b.engine.consumeEvents().some(event => event.kind === 'damage')).toBe(false);
  });
});

describe('Thousand Cuts', () => {
  const release = (b: Bench) => {
    b.step({ heavyPressed: true, heavyHeld: true });
    expect(b.player.actionId).toBe(VESPER_CLIPS.heavy_charge!);
    b.step({ heavyHeld: true }, THUNDER_CLEAVE.holdTicks);
    b.step({ heavyReleased: true, heavyHeldTicks: THUNDER_CLEAVE.holdTicks + 1 });
    expect(b.player.actionId).toBe(VESPER_CLIPS.charged_heavy!);
  };

  it('charges in a loop, then is untargetable for 72 ticks with six 9-damage cuts and a 20-damage finisher', () => {
    const b = bench({ distance: 3 });
    release(b);
    expect(b.state.player.mana).toBe(100_000 - PLAYER_SKILLS.charged_heavy.manaCost);
    const dealt: { age: number; damage: number }[] = [];
    let health = b.health();
    b.runLive(VESPER.thousandCuts.ticks - 1, age => {
      expect(b.engine.snapshot().player.untargetable).toBe(true);
      expect(standing(b)).toBe(true);
      if (b.health() < health) { dealt.push({ age, damage: health - b.health() }); health = b.health(); }
    });
    // Six cuts at 8/18/28/38/48/58 and the finisher at 66.
    expect(dealt.map(hit => hit.age)).toEqual([...VESPER.thousandCuts.strikeAt, VESPER.thousandCuts.finisherAt]);
    // The 4th cut consumes the Death Mark the first three built.
    expect(dealt.slice(0, 3).map(hit => hit.damage)).toEqual([9, 9, 9]);
    expect(dealt[3]!.damage).toBe(9 + VESPER.deathMark.executionDamage);
    // Cuts 5 and 6 build a second mark, which the finisher executes.
    expect(dealt[6]!.damage).toBe(VESPER.thousandCuts.finisherDamage + VESPER.deathMark.executionDamage);
    b.runLive(3);
    expect(b.engine.snapshot().player.untargetable).toBeUndefined();
    expect(b.cues.filter(cue => cue.kind === 'blink' && cue.actionId === VESPER_CLIPS.charged_heavy).length).toBe(7);
  });

  it('blocks a floor hazard for the whole skill', () => {
    const b = bench({ distance: 3 });
    release(b);
    b.state.hazards.push(floorHazard(b, 40, 1));
    const before = b.state.player.vitality;
    b.runLive(VESPER.thousandCuts.ticks - 1);
    expect(b.state.player.vitality).toBe(before);
    b.runLive(10);
    expect(b.state.player.vitality).toBeLessThan(before);
  });
});

describe('Kunai Fan', () => {
  it('releases three straight kunai at ±12° on tick 9', () => {
    const b = bench({ distance: 12 });
    b.step({ rangedPressed: true });
    expect(b.player.actionId).toBe(VESPER_CLIPS.sigil_bolt!);
    expect(b.state.player.mana).toBe(100_000 - PLAYER_SKILLS.sigil_bolt.manaCost);
    b.step({}, VESPER.kunaiFan.releaseAt - 1);
    expect(b.engine.snapshot().playerProjectiles).toBeUndefined();
    b.step();
    const projectiles = b.engine.snapshot().playerProjectiles!;
    expect(projectiles.map(projectile => projectile.kind)).toEqual(['kunai', 'kunai', 'kunai']);
    expect(projectiles.every(projectile => projectile.targetId === undefined && projectile.speed === VESPER.kunaiFan.speed)).toBe(true);
    const angles = projectiles.map(projectile => Math.atan2(projectile.direction.x, -projectile.direction.z) * 180 / Math.PI).sort((a, c) => a - c);
    expect(angles[0]!).toBeCloseTo(-VESPER.kunaiFan.spreadDegrees, 3);
    expect(angles[1]!).toBeCloseTo(0, 3);
    expect(angles[2]!).toBeCloseTo(VESPER.kunaiFan.spreadDegrees, 3);
    expect(b.cues.filter(cue => cue.kind === 'projectile' && cue.actionId === VESPER_CLIPS.sigil_bolt).length).toBe(3);
  });

  it('each kunai that lands deals 9 and adds a Death Mark stack, so three kunai mark the target', () => {
    const b = bench({ distance: 2.2 });
    b.step({ rangedPressed: true });
    b.step({}, VESPER.kunaiFan.releaseAt + 20);
    expect(100_000 - b.health()).toBe(3 * VESPER.kunaiFan.damage);
    const marks = b.engine.snapshot().actors.find(actor => actor.id === b.monster.id)!.heroMarks!;
    expect(marks).toEqual([{ kind: 'death-mark', remainingTicks: expect.any(Number) }]);
    expect(b.engine.snapshot().playerProjectiles).toBeUndefined();
  });

  it('cancels into Shadow Step, Moonlit Iai or Mist Blink once the kunai have left, but not before', () => {
    const press = (patch: Partial<CombatInput>, wait: number) => {
      const b = bench({ distance: 12 });
      b.step({ rangedPressed: true });
      b.step({}, wait);
      b.step(patch);
      return b;
    };
    const open = VESPER.kunaiFan.releaseAt + 1;
    expect(press({ heavyPressed: true }, open - 3).player.actionId).toBe(VESPER_CLIPS.sigil_bolt!);
    expect(press({ lightPressed: true }, open - 3).player.actionId).toBe(VESPER_CLIPS.sigil_bolt!);
    expect(press({ dodgePressed: true }, open - 3).cues.some(cue => cue.kind === 'blink')).toBe(false);
    const heavy = press({ heavyPressed: true }, open - 1);
    expect(heavy.player.actionId).toBe(VESPER_CLIPS.heavy!);
    expect(press({ lightPressed: true }, open - 1).player.actionId).toBe(VESPER_CLIPS.light_1!);
    expect(press({ dodgePressed: true }, open - 1).cues.some(cue => cue.kind === 'blink' && cue.actionId === VESPER_CLIPS.dodge)).toBe(true);
    // The three kunai were already released: the cancel leaves no second volley behind.
    heavy.step({}, 40);
    expect(heavy.cues.filter(cue => cue.kind === 'projectile' && cue.actionId === VESPER_CLIPS.sigil_bolt)).toHaveLength(3);
  });
});

describe('Shade Swap', () => {
  const release = (b: Bench) => {
    b.step({ rangedPressed: true, rangedHeld: true });
    expect(b.player.actionId).toBe(VESPER_CLIPS.sigil_charge!);
    b.step({ rangedHeld: true }, SIGIL.barrageHoldTicks);
    b.step({ rangedReleased: true });
    expect(b.player.actionId).toBe(VESPER_CLIPS.sigil_barrage!);
  };

  it('launches the clone on tick 8, strikes the lane once for 24, then swaps with 12 untouchable ticks', () => {
    const b = bench({ distance: 4 });
    const start = { ...b.player.position };
    release(b);
    expect(b.state.player.mana).toBe(100_000 - PLAYER_SKILLS.sigil_barrage.manaCost);
    b.runLive(VESPER.shadeSwap.cloneLaunchAt - 1);
    expect(b.engine.snapshot().playerProjectiles).toBeUndefined();
    b.runLive(1);
    const clone = b.engine.snapshot().playerProjectiles!.find(projectile => projectile.kind === 'shade-clone')!;
    expect(clone.radius).toBeCloseTo(VESPER.shadeSwap.laneWidth / 2, 6);
    expect(b.cues.some(cue => cue.kind === 'beam' && cue.actionId === VESPER_CLIPS.sigil_barrage)).toBe(true);
    // The lane strike lands once while the clone sweeps through the monster; Vesper has not moved yet.
    b.runLive(VESPER.shadeSwap.swapAt - 1 - VESPER.shadeSwap.cloneLaunchAt);
    expect(100_000 - b.health()).toBe(VESPER.shadeSwap.damage);
    expect(distance2(b.player.position, start)).toBe(0);
    // Tick 30: Vesper takes the clone's place, and the floor hazard (live from tick 31) cannot touch Vesper for 12 ticks.
    const before = b.state.player.vitality;
    b.state.hazards.push(floorHazard(b, 60, 2));
    b.runLive(1);
    const swapped = distance2(b.player.position, start);
    expect(swapped).toBeGreaterThan(3);
    expect(swapped).toBeLessThanOrEqual(VESPER.shadeSwap.dashDistance + 1e-6);
    expect(b.player.position.z).toBeLessThan(b.monster.position.z);
    expect(standing(b)).toBe(true);
    expect(insideBounds(b)).toBe(true);
    expect(b.cues.some(cue => cue.kind === 'blink' && cue.actionId === VESPER_CLIPS.sigil_barrage)).toBe(true);
    b.runLive(VESPER.shadeSwap.untouchableTicks - 1, () => { expect(b.engine.snapshot().player.untargetable).toBe(true); });
    expect(b.state.player.vitality).toBe(before);
    b.runLive(1);
    expect(b.engine.snapshot().player.untargetable).toBeUndefined();
    b.runLive(6);
    expect(b.state.player.vitality).toBeLessThan(before);
  });

  it('a clone launched at the floor edge swaps Vesper only onto walkable ground', () => {
    const b = bench({ distance: 3 });
    const edge = floorEdgeZ(b);
    b.monster.position = vec(b.monster.position.x + 40, b.monster.position.y, b.monster.position.z);
    b.player.position = vec(b.player.position.x, b.player.position.y, edge + 2);
    b.player.facing = vec(0, 0, -1);
    release(b);
    b.runLive(VESPER.shadeSwap.ticks, () => { expect(walkable(b)).toBe(true); });
    expect(b.player.position.z).toBeGreaterThan(edge);
    expect(standing(b)).toBe(true);
  });
});

describe('Severing Shadow', () => {
  /** Runs the live monster AI until it telegraphs an attack, with the player within Severing Shadow's range. */
  function windupBench() {
    for (const distance of [3, 4.5, 2.4]) {
      const b = bench({ distance, live: true });
      b.state.targetId = b.monster.id as ActorId;
      for (let tick = 0; tick < 900; tick++) {
        b.step();
        if (b.state.telegraphs.some(telegraph => telegraph.sourceId === b.monster.id && telegraph.phase === 'windup')) return b;
      }
    }
    throw new Error('the trial monster never telegraphed an attack');
  }

  it('blinks to a winding-up foe, interrupts the real windup and deals 10', () => {
    const b = windupBench();
    expect(distance2(b.player.position, b.monster.position)).toBeLessThanOrEqual(VESPER.severingShadow.range);
    const telegraphed = b.state.telegraphs.find(telegraph => telegraph.sourceId === b.monster.id)!;
    b.state.targetId = b.monster.id as ActorId;
    b.monster.facing = vec(0, 0, 0);
    const before = b.health(), mana = b.state.player.mana;
    b.step({ tetherPressed: true });
    expect(b.player.actionId).toBe(VESPER_CLIPS.root_tether!);
    expect(b.state.player.mana).toBe(mana - PLAYER_SKILLS.root_tether.manaCost);
    let interrupted = false;
    for (let age = 1; age <= VESPER.severingShadow.strikeAt + 2; age++) {
      b.step();
      if (b.engine.consumeEvents().some(event => event.kind === 'attack-interrupted' && event.attackId === telegraphed.attackId)) interrupted = true;
    }
    expect(interrupted).toBe(true);
    expect(b.state.telegraphs.some(telegraph => telegraph.sourceId === b.monster.id && telegraph.id === telegraphed.id)).toBe(false);
    expect(before - b.health()).toBeGreaterThanOrEqual(VESPER.severingShadow.damage);
    expect(distance2(b.player.position, b.monster.position)).toBeLessThan(b.monster.radius + 1.6);
    expect(standing(b)).toBe(true);
  });

  it('refunds the mana and does nothing when the foe is beyond 7 m', () => {
    const b = windupBench();
    b.monster.position = vec(b.monster.position.x, b.monster.position.y, b.monster.position.z - 9);
    const mana = b.state.player.mana;
    b.step({ tetherPressed: true });
    expect(b.state.player.mana).toBeGreaterThanOrEqual(mana);
    expect(b.player.actionId).not.toBe(VESPER_CLIPS.root_tether!);
  });
});

describe('Mist Blink', () => {
  it('blinks 6.5 m over 12 ticks with 14 untouchable ticks and a 12-tick recovery', () => {
    const b = bench({ distance: 3 });
    b.monster.position = vec(b.monster.position.x + 40, b.monster.position.y, b.monster.position.z);
    const start = { ...b.player.position };
    b.player.facing = vec(0, 0, -1);
    const reach = distance2(start, moveCircle(b.state.arena, start, vec(0, 0, -VESPER.mistBlink.distance), PLAYER_RADIUS, b.player.collisionHeight));
    b.state.hazards.push(floorHazard(b, 30, 3));
    const before = b.state.player.vitality;
    b.step({ dodgePressed: true });
    expect(b.player.actionEndsTick - b.player.actionStartedTick).toBe(VESPER.mistBlink.durationTicks + VESPER.mistBlink.recoveryTicks);
    expect(b.state.player.mana).toBe(100_000 - PLAYER_SKILLS.dive.manaCost);
    let untargetable = b.engine.snapshot().player.untargetable === true ? 1 : 0;
    for (let tick = 1; tick < VESPER.mistBlink.iframes + 6; tick++) {
      b.step();
      if (b.engine.snapshot().player.untargetable === true) untargetable++;
      expect(groundHeightAt(b.state.arena, b.player.position.x, b.player.position.z, b.player.position.y)).not.toBeNull();
      expect(insideBounds(b)).toBe(true);
      // Untouchable through the whole iframe window.
      if (tick < VESPER.mistBlink.iframes) expect(b.state.player.vitality).toBe(before);
    }
    expect(untargetable).toBe(VESPER.mistBlink.iframes);
    expect(distance2(start, b.player.position)).toBeCloseTo(reach, 1);
    expect(reach).toBeGreaterThan(VESPER.mistBlink.distance - 0.7);
    expect(reach).toBeLessThanOrEqual(VESPER.mistBlink.distance + 1e-6);
    expect(b.cues.find(cue => cue.kind === 'blink' && cue.actionId === VESPER_CLIPS.dodge)).toMatchObject({ element: 'umbral' });
    // Once the iframes are over the live hazard lands.
    b.step({}, 30);
    expect(b.state.player.vitality).toBeLessThan(before);
  });

  it('moves at the hero profile walk and run speeds (Vesper 4.9 / 7.5)', () => {
    expect(HERO_COMBAT.vesper).toMatchObject({ walkSpeed: 4.9, runSpeed: 7.5, maxVitality: 80 });
  });
});

describe('Crimson Requiem', () => {
  const cast = (b: Bench) => {
    b.state.player.instinct = 100;
    b.step({ ultimatePressed: true });
  };

  it('is untargetable for its 120 ticks, marks every foe within 12 m, slashes seven times and detonates for 45', () => {
    const b = bench({ distance: 4 });
    cast(b);
    expect(b.player.actionId).toBe(VESPER_CLIPS.judgement!);
    expect(b.state.player.instinct).toBe(0);
    b.state.hazards.push(floorHazard(b, 50, 1));
    const before = b.state.player.vitality;
    const marked = () => b.engine.snapshot().actors.find(actor => actor.id === b.monster.id)!.heroMarks?.some(mark => mark.kind === 'requiem-mark') === true;
    let slashes = 0, markedAt: number | undefined, health = b.health();
    const hits: { age: number; damage: number }[] = [];
    b.runLive(VESPER.requiem.ticks - 1, age => {
      for (const event of b.engine.consumeEvents()) if (event.kind === 'damage' && event.actionId === 'requiem_slash') slashes++;
      expect(b.engine.snapshot().player.untargetable).toBe(true);
      if (marked() && markedAt === undefined) markedAt = age;
      if (b.health() < health) { hits.push({ age, damage: health - b.health() }); health = b.health(); }
      expect(standing(b)).toBe(true);
      expect(insideBounds(b)).toBe(true);
    });
    expect(b.state.player.vitality).toBe(before);
    expect(markedAt).toBe(VESPER.requiem.markAt);
    expect(slashes).toBe(VESPER.requiem.slashCount);
    // Seven slashes every 12 ticks from tick 12, then the detonation at 110; the marks are gone afterwards.
    const slashAges = Array.from({ length: VESPER.requiem.slashCount }, (_, index) => VESPER.requiem.slashFrom + index * VESPER.requiem.slashInterval);
    expect(hits.map(hit => hit.age)).toEqual([...slashAges, VESPER.requiem.detonationAt]);
    expect(hits.at(-1)!.damage).toBe(VESPER.requiem.detonationDamage);
    expect(hits.slice(0, 3).map(hit => hit.damage)).toEqual([8, 8, 8]);
    // Slashes 1-3 build the Death Mark, slash 4 executes it.
    expect(hits[3]!.damage).toBe(8 + VESPER.deathMark.executionDamage);
    expect(marked()).toBe(false);
    expect(b.cues.filter(cue => cue.kind === 'judgement-mark' && cue.phase === 'commit').length).toBe(1);
    expect(b.cues.filter(cue => cue.kind === 'judgement-mark' && cue.phase === 'hit').length).toBe(1);
    expect(b.cues.filter(cue => cue.kind === 'blink' && cue.actionId === VESPER_CLIPS.judgement).length).toBe(VESPER.requiem.slashCount);
    b.runLive(2);
    expect(b.engine.snapshot().player.untargetable).toBeUndefined();
  });

  it('marks nothing outside 12 m and still ends cleanly', () => {
    const b = bench({ distance: 14 });
    cast(b);
    b.runLive(VESPER.requiem.ticks);
    expect(b.health()).toBe(100_000);
    expect(b.engine.snapshot().actors.find(actor => actor.id === b.monster.id)!.heroMarks).toBeUndefined();
    expect(b.engine.snapshot().player.untargetable).toBeUndefined();
  });

  it('needs full Instinct', () => {
    const b = bench();
    b.state.player.instinct = 99;
    b.step({ ultimatePressed: true });
    expect(b.player.actionId).not.toBe(VESPER_CLIPS.judgement!);
  });
});

describe('serialization', () => {
  it('kit state is plain JSON and an engine restored from a mid-skill save plays out identically', () => {
    const b = bench({ distance: 2 });
    for (let index = 0; index < 2; index++) { b.step({ lightPressed: true }); b.step({}, 38); }
    b.step({ lightPressed: true });
    b.runLive(3);
    const kit = b.state.kit;
    expect(JSON.parse(JSON.stringify(kit))).toEqual(kit);
    expect(Object.keys(kit).sort()).toEqual(['action', 'marks', 'requiem', 'stacks']);
    const saved = b.engine.serialize();
    const twin = new CombatEngine();
    twin.restore(saved);
    expect(liveState(twin).heroId).toBe('vesper');
    expect(JSON.parse(JSON.stringify(liveState(twin).kit))).toEqual(kit);
    let tick = 1000;
    const monsterId = b.monster.id;
    for (let index = 0; index < 60; index++) {
      const input = { ...idle, tick: ++tick, lightPressed: index === 20 };
      b.pin();
      const twinMonster = liveState(twin).actors.find(actor => actor.id === monsterId)!;
      twinMonster.facing = vec(0, 0, 0);
      b.engine.fixedStep(input);
      twin.fixedStep(input);
    }
    expect(liveState(twin).actors.find(actor => actor.id === monsterId)!.vitality).toBe(b.health());
    expect(liveState(twin).kit).toEqual(b.state.kit);
    const a = liveState(twin).actors.find(actor => actor.id === 'aren') as CombatActor;
    expect(distance2(a.position, b.player.position)).toBeLessThan(1e-9);
  });
});
