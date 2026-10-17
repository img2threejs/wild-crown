import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ASSET_PLAYTESTS } from '../../src/app/AssetPlaytests.js';
import { REGIONS } from '../../src/content/campaign.js';
import type { StoryCue } from '../../src/effects/story-cues.js';
import type { ActorId, Vec3 } from '../../src/game/contracts.js';
import { CombatEngine, createEngineState, makeActor, type CombatInput, type EngineState, type LiveHazard } from '../../src/game/combat/CombatEngine.js';
import { ATTACKS, type AttackDefinition } from '../../src/game/combat/content.js';
import { vec } from '../../src/game/combat/geometry.js';
import { createCombatTrialRegion } from '../../src/game/combat/TrialRegions.js';
import { PLAYER_SKILLS, SIGIL, THUNDER_CLEAVE } from '../../src/game/combat/PlayerSkills.js';
import { SAKDA, SAKDA_CLIPS } from '../../src/game/combat/SakdaSkills.js';
import { createSakdaKit } from '../../src/game/combat/kits/SakdaKit.js';
import { KIT_FACTORIES } from '../../src/game/combat/kits/registry.js';

const idle: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
const playtest = ASSET_PLAYTESTS.find(candidate => candidate.regionId === 'greenwake')!;
const MONSTER = playtest.trialSet.trials[0]!.monsterId;
const FROZEN = 1e9;

/** Test-only access to the engine-owned live state (the other combat tests read it the same way). */
function liveState(engine: CombatEngine): EngineState {
  return (engine as unknown as EngineInternals).state;
}

/** Engine internals the tests reach into: the live state and the monster attack starter. */
interface EngineInternals {
  state: EngineState;
  beginAttack(source: unknown, definition: AttackDefinition): LiveHazard | undefined;
  /** The active hero kit; the engine calls its `cancel()` whenever an in-flight skill is abandoned. */
  kit: { cancel(): void; startHeavy(charged: boolean): boolean; startRanged(charged: boolean): boolean } | undefined;
}

/** Everything a test drives: the engine, its live state, collected cues and stepping/measuring helpers. */
interface Rig {
  engine: CombatEngine;
  state: EngineState;
  cues: StoryCue[];
  step(patch?: Partial<CombatInput>, count?: number): void;
  live(): EngineState['actors'][number];
  me(): EngineState['actors'][number];
  gap(): number;
  untilDamage(patch?: Partial<CombatInput>, max?: number): { steps: number; damage: number };
  holdHeavy(): void;
  releaseHeavy(): void;
  holdRanged(): void;
  waitIdle(): void;
}

/** Sakda's centre stops this far from a Greenwake monster's centre: its collision body (1.05 m) plus his own. */
const COLLISION_GAP = 3.1;

interface RigOptions {
  /** Metres between Sakda and the monster (the monster stays put, Sakda faces it). */
  distance?: number;
  vitality?: number;
  maxVitality?: number;
  /** A frozen monster never moves or attacks, so every number is deterministic. Default true. */
  frozen?: boolean;
}

/** A real Greenwake combat-trial run as Sakda with a real trial monster in front of him. */
function rig(options: RigOptions = {}): Rig {
  const region = createCombatTrialRegion(REGIONS.find(candidate => candidate.id === playtest.regionId)!);
  const base = new CombatEngine();
  base.loadRegion({ regionId: playtest.regionId, regionDefinition: region, runId: 'sakda-kit', presentActorIds: playtest.trialSet.trials.map(trial => trial.monsterId) });
  base.setPlayerHero('sakda');
  base.startEncounter({ encounterId: playtest.trialSet.encounterId, regionId: playtest.regionId, runId: 'sakda-kit' });
  base.enableCombatTrials();
  const seed = base.snapshotState();
  const monster = seed.actors.find(actor => actor.id === MONSTER)!;
  const player = seed.actors.find(actor => actor.id === seed.playerId)!;
  monster.vitality = options.vitality ?? 1000;
  monster.maxVitality = options.maxVitality ?? 1000;
  monster.ferocity = 0;
  if (options.frozen !== false) monster.staggerUntil = FROZEN;
  player.position = vec(monster.position.x, monster.position.y, monster.position.z + (options.distance ?? 3));
  player.facing = vec(0, 0, -1);
  player.velocity = vec(0, 0, 0);
  seed.player.vitality = seed.player.maxVitality = 10_000;
  seed.player.mana = seed.player.maxMana;
  seed.targetId = MONSTER;
  const engine = new CombatEngine(seed);
  const state = liveState(engine);
  const cues: StoryCue[] = [];
  const step = (patch: Partial<CombatInput> = {}, count = 1): void => {
    for (let i = 0; i < count; i++) { engine.fixedStep({ ...idle, ...patch }); cues.push(...engine.drainPresentationCues()); }
  };
  const live = () => state.actors.find(actor => actor.id === MONSTER)!;
  const me = () => state.actors.find(actor => actor.id === state.playerId)!;
  const gap = () => Math.hypot(me().position.x - live().position.x, me().position.z - live().position.z);
  /** Steps until the monster loses health; returns the steps taken (the first step is the press) and the damage. */
  const untilDamage = (patch: Partial<CombatInput> = {}, max = 200): { steps: number; damage: number } => {
    const before = live().vitality!;
    for (let steps = 1; steps <= max; steps++) {
      step(steps === 1 ? patch : {});
      if (live().vitality! < before) return { steps, damage: before - live().vitality! };
    }
    return { steps: max, damage: 0 };
  };
  /** Presses and holds a heavy/ranged button for the charge threshold, then releases it (the release step is returned as the first step of the skill). */
  const holdHeavy = (): void => {
    step({ heavyPressed: true, heavyHeld: true });
    step({ heavyHeld: true }, THUNDER_CLEAVE.holdTicks);
  };
  const releaseHeavy = (): void => step({ heavyReleased: true, heavyHeldTicks: THUNDER_CLEAVE.holdTicks + 1 });
  const holdRanged = (): void => {
    step({ rangedPressed: true, rangedHeld: true });
    step({ rangedHeld: true }, SIGIL.barrageHoldTicks);
  };
  const waitIdle = (): void => { while (state.tick < state.actionRecoveryUntil) step(); };
  return { engine, state, cues, step, live, me, gap, untilDamage, holdHeavy, releaseHeavy, holdRanged, waitIdle };
}

/** The monster's real windup: the engine's own attack start, so a real telegraph and hazard exist. */
function startWindup(r: Rig, attack: AttackDefinition = ATTACKS['koro-fruit-burst']!): void {
  const internals = r.engine as unknown as EngineInternals;
  expect(internals.beginAttack(r.live(), attack)).toBeDefined();
  expect(r.state.telegraphs.some(telegraph => telegraph.sourceId === MONSTER)).toBe(true);
}
const interrupted = (r: Rig): boolean => r.engine.consumeEvents().some(event => event.kind === 'attack-interrupted');
/** Marks the test monster as echoed until the given world tick (kit state is plain JSON: an array of `{ id, until }`). */
const echo = (r: Rig, until: number): void => { r.state.kit.echo = [{ id: MONSTER, until }]; };
/** A solid box in the live arena; the engine reads `state.arena` on every sweep and strike check. */
function addBox(r: Rig, id: string, centre: Vec3, half: Vec3): void {
  r.state.arena.colliders.push({ id, kind: 'box', from: centre, halfExtents: half, blocksMovement: true, blocksCamera: false });
}

/** A damaging area on the player that goes live `delay` simulation ticks from now. */
function hazardOnPlayer(r: Rig, damage: number, delay: number, id: string): void {
  const attack = ATTACKS['koro-fruit-burst']!, at = r.me().position;
  const live = r.state.worldTick + delay;
  r.state.hazards.push({
    ...structuredClone(attack.hazard), id, attackId: attack.id, sourceId: 'koro' as ActorId, targetActorId: 'aren' as ActorId,
    startTick: r.state.worldTick, activeFrom: live, activeUntil: live + 4, windupUntil: r.state.worldTick, castUntil: live + 4, recoveryUntil: live + 4,
    target: { ...at }, origin: { ...at }, direction: vec(0, 0, 1), width: 8, depth: 8, damage, hitIds: [], threatTicks: [], cue: 'burst',
    bounds: { min: vec(at.x - 4, at.y - 1, at.z - 4), max: vec(at.x + 4, at.y + 3, at.z + 4) },
  });
}

describe('Sakda kit', () => {
  const original = { ...KIT_FACTORIES };
  beforeEach(() => { KIT_FACTORIES.sakda = createSakdaKit; });
  afterEach(() => { delete KIT_FACTORIES.sakda; Object.assign(KIT_FACTORIES, original); });

  it('shows the Sakda labels, clips, ember element and Guard Dash profile', () => {
    const r = rig();
    const skills = r.engine.snapshot().skills;
    expect(skills.find(skill => skill.id === 'light')!.label).toBe('Eight Limbs');
    expect(skills.find(skill => skill.id === 'heavy' || skill.id === 'charged_heavy')!.label).toBe('Tempest Stomp');
    expect(skills.find(skill => skill.id === 'sigil_bolt')!.label).toBe('Echo Wave');
    expect(skills.find(skill => skill.id === 'judgement')!.label).toBe("Tiger's Wrath");
    expect(skills.find(skill => skill.id === 'dive')!.label).toBe('Guard Dash');
    const kit = createSakdaKit({ heroId: 'sakda' } as never);
    expect(kit).toMatchObject({ heroId: 'sakda', element: 'ember', lightSteps: 4 });
    expect(kit.dodge).toEqual({ clip: 'sakda-guard-dash', distance: 5.5, durationTicks: 18, iframes: 8, recoveryTicks: 14, blinkCue: true, cancel: { fromTick: 18, into: ['heavy', 'ranged', 'dodge'] } });
    expect(kit.clip('light_3')).toBe('sakda-limb-3');
    expect(kit.clip('sigil_charge')).toBe('sakda-elbow-charge');
    expect(kit.clip('heavy_charge')).toBe('sakda-knee-charge');
    expect(kit.clip('cleanse')).toBe('sakda-cleanse');
    expect(kit.clip('nonsense')).toBeUndefined();
  });

  describe('Eight Limbs', () => {
    it('keeps the opening jab readable before contact and allows a longer recovery', () => {
      const r = rig({ distance: 1.6 });
      const before = r.live().vitality!;
      r.step({ lightPressed: true });
      const duration = r.me().actionEndsTick - r.me().actionStartedTick;
      expect(duration).toBeGreaterThanOrEqual(40);
      r.step({}, 11);
      expect(r.live().vitality).toBe(before);
      const hit = r.untilDamage({}, 7);
      expect(hit.damage).toBe(10);
      expect(Math.abs(r.me().normalizedTime - 11 / 30)).toBeLessThanOrEqual(1 / duration);
      expect(r.state.actionRecoveryUntil).toBeGreaterThan(r.state.tick);
    });

    it('chains four steps with their damage, clip length and strike tick', () => {
      const r = rig({ distance: 1.6 });
      const steps = SAKDA.limbs.steps;
      const damageOf = (index: number): number => steps[index]!.damage + (steps[index]!.ring?.damage ?? 0);
      for (const [index, spec] of steps.entries()) {
        if (index > 0) { while (r.state.tick < r.state.lightChainFrom!) r.step(); }
        const hit = r.untilDamage({ lightPressed: true });
        const player = r.me();
        expect(player.actionId).toBe(SAKDA_CLIPS[`light_${index + 1}`]);
        expect(player.actionEndsTick - player.actionStartedTick).toBe(spec.ticks);
        // Step 4 lands the kick and the separate ember ring on the same target in the same tick.
        expect(hit).toEqual({ steps: spec.activeAt + 1, damage: damageOf(index) });
        r.step({}, spec.ticks);
        expect(r.live().vitality).toBe(1000 - steps.slice(0, index + 1).reduce((sum, _step, i) => sum + damageOf(i), 0));
        if (index < steps.length - 1) { r.step({}, 0); }
        // Re-open the chain for the next step: it stays open for CHAIN_LATE after the clip, so press straight away.
        r.state.lightChainFrom = Math.min(r.state.lightChainFrom ?? 0, r.state.tick);
        r.state.lightChainUntil = r.state.tick + 40;
      }
      // Step 4 was the last: a further press restarts the chain at step 1.
      r.step({ lightPressed: true });
      expect(r.me().actionId).toBe(SAKDA_CLIPS.light_1);
    });

    it('step 3 steps 0.6 m forward and step 4 has a 200 degree arc plus a ring that hits once', () => {
      const r = rig({ distance: 6 });
      const start = { ...r.me().position };
      const travelled = (): number => Math.hypot(r.me().position.x - start.x, r.me().position.z - start.z);
      r.step({ lightPressed: true });
      r.waitIdle();
      expect(travelled()).toBeLessThan(0.01);
      r.step({ lightPressed: true }); r.waitIdle();
      expect(travelled()).toBeLessThan(0.01);
      r.step({ lightPressed: true }); r.waitIdle();
      expect(travelled()).toBeCloseTo(SAKDA.limbs.steps[2]!.stepMetres!, 2);

      // Step 4 at 2.9 m directly BEHIND Sakda is outside the 200 degree kick arc but inside the 3 m ember ring: the ring alone, 8.
      const behind = rig({ distance: 2.9 });
      behind.me().facing = vec(0, 0, 1);
      behind.state.targetId = undefined;
      behind.state.lightIndex = 3; behind.state.lightChainFrom = 0; behind.state.lightChainUntil = 1e6;
      const hit = behind.untilDamage({ lightPressed: true });
      expect(behind.me().actionId).toBe(SAKDA_CLIPS.light_4);
      expect(hit.damage).toBe(SAKDA.limbs.steps[3]!.ring!.damage);
      behind.step({}, 40);
      expect(behind.live().vitality).toBe(1000 - SAKDA.limbs.steps[3]!.ring!.damage);
      expect(SAKDA.limbs.steps[3]!.ring!.damage).toBe(8);
      const ring = behind.cues.find(cue => cue.kind === 'slash' && cue.shape === 'ring');
      expect(ring).toMatchObject({ element: 'ember', actionId: 'sakda-limb-4', durationTicks: SAKDA.limbs.steps[3]!.ring!.ticks });

      // A target in front inside both the kick cone and the ring takes the 18 kick AND the separate 8 ring: 26, each once.
      const front = rig({ distance: 2.0 });
      front.state.lightIndex = 3; front.state.lightChainFrom = 0; front.state.lightChainUntil = 1e6;
      front.step({ lightPressed: true }, 40);
      expect(SAKDA.limbs.steps[3]!.damage).toBe(18);
      expect(front.live().vitality).toBe(1000 - 26);

      // A foe outside the 3 m ring is not touched.
      const far = rig({ distance: 5 });
      far.state.lightIndex = 3; far.state.lightChainFrom = 0; far.state.lightChainUntil = 1e6;
      far.step({ lightPressed: true }, 40);
      expect(far.live().vitality).toBe(1000);
    });

    it('the slash cue is ember and carries its clip', () => {
      const r = rig({ distance: 1.6 });
      r.untilDamage({ lightPressed: true });
      expect(r.cues.find(cue => cue.kind === 'slash')).toMatchObject({ element: 'ember', actionId: 'sakda-limb-1', shape: 'arc' });
      expect(r.cues.find(cue => cue.kind === 'hit')).toMatchObject({ element: 'ember' });
    });
  });

  describe('Flurry', () => {
    it('a skill arms two charges; the next two J play 35 % faster and each spends a charge and restores 6 mana on contact', () => {
      const r = rig({ distance: 1.6 });
      expect(r.engine.snapshot().player.flurryCharges).toBeUndefined();
      r.step({ heavyPressed: true });
      expect(r.engine.snapshot().player.flurryCharges).toBe(2);
      r.waitIdle();
      r.state.player.mana = 50;
      const fast1 = Math.round(SAKDA.limbs.steps[0]!.ticks / (1 + SAKDA.flurry.speedBonus));
      const fastActive1 = Math.round(SAKDA.limbs.steps[0]!.activeAt / (1 + SAKDA.flurry.speedBonus));
      // Armed but not yet in contact: the charge is still there while the swing is in flight.
      r.step({ lightPressed: true });
      expect(r.engine.snapshot().player.flurryCharges).toBe(2);
      r.step({}, fastActive1 - 1);
      expect(r.engine.snapshot().player.flurryCharges).toBe(2);
      r.step();
      expect(r.me().actionEndsTick - r.me().actionStartedTick).toBe(fast1);
      expect(r.state.player.mana).toBe(50 + SAKDA.flurry.manaPerHit);
      expect(r.engine.snapshot().player.flurryCharges).toBe(1);
      r.waitIdle();
      const second = r.untilDamage({ lightPressed: true });
      expect(second.damage).toBeGreaterThan(0);
      expect(r.engine.snapshot().player.flurryCharges).toBeUndefined();
      expect(r.state.player.mana).toBe(50 + 2 * SAKDA.flurry.manaPerHit);
      expect(r.me().actionEndsTick - r.me().actionStartedTick).toBe(Math.round(SAKDA.limbs.steps[1]!.ticks / (1 + SAKDA.flurry.speedBonus)));
      r.step({}, 60);
      // The third J is back to normal speed and gives no mana.
      const mana = r.state.player.mana;
      r.state.lightChainFrom = 0; r.state.lightChainUntil = r.state.tick + 40; r.state.lightIndex = 2;
      r.step({ lightPressed: true });
      expect(r.me().actionEndsTick - r.me().actionStartedTick).toBe(SAKDA.limbs.steps[2]!.ticks);
      r.step({}, 40);
      expect(r.state.player.mana).toBe(mana);
    });

    it('a swing that misses keeps its charge and its mana refund for the next swing that connects', () => {
      const r = rig({ distance: 6 });
      r.step({ heavyPressed: true });
      r.waitIdle();
      r.state.player.mana = 50;
      const fast1 = Math.round(SAKDA.limbs.steps[0]!.ticks / (1 + SAKDA.flurry.speedBonus));
      r.step({ lightPressed: true });
      expect(r.me().actionEndsTick - r.me().actionStartedTick).toBe(fast1);
      r.step({}, fast1 + 10);
      expect(r.live().vitality).toBe(1000);
      expect(r.state.player.mana).toBe(50);
      expect(r.engine.snapshot().player.flurryCharges).toBe(SAKDA.flurry.charges);
      // Walk the foe into reach: the next swing is still fast and spends exactly one charge on contact.
      r.me().position = vec(r.live().position.x, r.me().position.y, r.live().position.z + 1.6);
      r.state.lightIndex = 0; r.state.lightChainUntil = 0;
      const hit = r.untilDamage({ lightPressed: true });
      expect(hit.damage).toBeGreaterThan(0);
      expect(r.me().actionEndsTick - r.me().actionStartedTick).toBe(fast1);
      expect(r.state.player.mana).toBe(50 + SAKDA.flurry.manaPerHit);
      expect(r.engine.snapshot().player.flurryCharges).toBe(SAKDA.flurry.charges - 1);
    });

    it('a swing cancelled before its strike spends no charge and refunds no mana', () => {
      const r = rig({ distance: 1.6 });
      r.step({ heavyPressed: true });
      r.waitIdle();
      r.state.player.mana = 50;
      const health = r.live().vitality;
      r.step({ lightPressed: true });
      r.step();
      expect(r.live().vitality).toBe(health);
      // The engine abandons the swing (as any cancel does) before its strike tick.
      (r.engine as unknown as EngineInternals).kit!.cancel();
      expect(r.state.kit.action).toBeNull();
      r.step({}, 60);
      expect(r.live().vitality).toBe(health);
      expect(r.state.player.mana).toBe(50);
      expect(r.engine.snapshot().player.flurryCharges).toBe(SAKDA.flurry.charges);
    });

    it('arms on shared Jump and Cleanse as well as on Sakda skills', () => {
      const jump = rig({ distance: 3 });
      expect(jump.engine.snapshot().player.flurryCharges).toBeUndefined();
      jump.step({ jumpPressed: true });
      expect(jump.engine.snapshot().player.flurryCharges).toBe(SAKDA.flurry.charges);

      const cleanse = rig({ distance: 3 });
      expect(cleanse.engine.snapshot().player.flurryCharges).toBeUndefined();
      cleanse.step({ cleansePressed: true });
      expect(cleanse.me().actionId).toBe(SAKDA_CLIPS.cleanse);
      expect(cleanse.engine.snapshot().player.flurryCharges).toBe(SAKDA.flurry.charges);
    });

    it('J never arms Flurry and the charges expire after the window', () => {
      const r = rig({ distance: 1.6 });
      r.step({ lightPressed: true });
      r.waitIdle();
      expect(r.engine.snapshot().player.flurryCharges).toBeUndefined();
      r.step({ heavyPressed: true });
      expect(r.engine.snapshot().player.flurryCharges).toBe(SAKDA.flurry.charges);
      r.step({}, SAKDA.tempestStomp.ticks + SAKDA.flurry.windowTicks + 30);
      expect(r.engine.snapshot().player.flurryCharges).toBeUndefined();
    });
  });

  describe('Echo Wave and Resonating Strike', () => {
    it('Echo Wave releases a projectile at tick 9 that deals 16 and marks the target', () => {
      const r = rig({ distance: 6 });
      r.step({ rangedPressed: true });
      expect(r.state.player.mana).toBe(r.state.player.maxMana - PLAYER_SKILLS.sigil_bolt.manaCost);
      expect(r.me().actionId).toBe('sakda-echo-wave');
      expect(r.engine.snapshot().playerProjectiles).toBeUndefined();
      r.step({}, SAKDA.echoWave.releaseAt - 1);
      expect(r.engine.snapshot().playerProjectiles).toBeUndefined();
      r.step();
      expect(r.engine.snapshot().playerProjectiles!.map(projectile => projectile.kind)).toEqual(['echo-wave']);
      const projectileCue = r.cues.find(cue => cue.kind === 'projectile')!;
      expect(projectileCue).toMatchObject({ element: 'ember', actionId: 'sakda-echo-wave' });
      for (let i = 0; i < 40 && r.live().vitality === 1000; i++) r.step();
      expect(r.live().vitality).toBe(1000 - SAKDA.echoWave.damage);
      const marks = r.engine.snapshot().actors.find(actor => actor.id === MONSTER)!.heroMarks!;
      expect(marks).toHaveLength(1);
      expect(marks[0]).toMatchObject({ kind: 'echo-mark' });
      expect(marks[0]!.remainingTicks).toBeLessThanOrEqual(SAKDA.echoWave.markTicks);
      expect(marks[0]!.remainingTicks).toBeGreaterThan(SAKDA.echoWave.markTicks - 20);
      r.step({}, SAKDA.echoWave.markTicks + 5);
      expect(r.engine.snapshot().actors.find(actor => actor.id === MONSTER)!.heroMarks).toBeUndefined();
    });

    it('recasting on an echoed target dashes onto it, adds the missing-health bonus and consumes the mark', () => {
      const r = rig({ distance: 8, vitality: 900, maxVitality: 1000 });
      r.step({ rangedPressed: true });
      for (let i = 0; i < 60 && r.engine.snapshot().actors.find(actor => actor.id === MONSTER)!.heroMarks === undefined; i++) r.step();
      expect(r.engine.snapshot().actors.find(actor => actor.id === MONSTER)!.heroMarks![0]!.kind).toBe('echo-mark');
      r.waitIdle();
      r.step({ rangedPressed: true });
      expect(r.me().actionId).not.toBe('sakda-resonating-strike');
      r.step({}, r.state.skillReadyAt.sigil_bolt! - r.state.tick - 1);
      const mana = r.state.player.mana, health = r.live().vitality!;
      const before = r.gap();
      r.step({ rangedPressed: true });
      expect(r.me().actionId).toBe('sakda-resonating-strike');
      expect(r.state.player.mana).toBe(mana);
      expect(r.engine.snapshot().playerProjectiles).toBeUndefined();
      let steps = 1;
      while (r.live().vitality === health && steps < 80) { r.step(); steps++; }
      const missing = 1000 - health, bonus = Math.min(SAKDA.resonatingStrike.missingHealthCap, Math.round(missing * SAKDA.resonatingStrike.missingHealthRatio));
      expect(health - r.live().vitality!).toBe(SAKDA.resonatingStrike.damage + bonus);
      expect(bonus).toBeGreaterThan(0);
      // 8 m of approach at the 24 m/s cap stretches the dash beyond the clip's 14 ticks, so impact is later than tick 18.
      expect(steps).toBeGreaterThan(SAKDA.resonatingStrike.impactAt);
      expect(before - r.gap()).toBeGreaterThan(5);
      expect(r.gap()).toBeLessThan(COLLISION_GAP);
      expect(r.engine.snapshot().actors.find(actor => actor.id === MONSTER)!.heroMarks).toBeUndefined();
      expect(r.cues.some(cue => cue.kind === 'blink' && cue.actionId === 'sakda-resonating-strike' && cue.element === 'ember')).toBe(true);
      // With the mark gone the next L tap is a fresh Echo Wave again.
      r.waitIdle();
      r.step({ rangedPressed: true });
      expect(r.me().actionId).toBe('sakda-echo-wave');
    });

    it('a near target uses exactly the authored 14-tick dash and strikes on tick 18', () => {
      const r = rig({ distance: 5 });
      echo(r, r.state.worldTick + 100);
      r.state.kit.action = null; r.state.kit.flurryCharges = 0; r.state.kit.flurryUntil = 0; r.state.kit.shield = 0; r.state.kit.shieldUntil = 0;
      const hit = r.untilDamage({ rangedPressed: true });
      expect(hit.steps).toBe(SAKDA.resonatingStrike.impactAt + 1);
      expect(r.me().actionEndsTick - r.me().actionStartedTick).toBe(SAKDA.resonatingStrike.ticks);
    });

    it('caps the missing-health bonus at +30', () => {
      const big = rig({ distance: 4, vitality: 100, maxVitality: 1000 });
      echo(big, big.state.worldTick + 100);
      const bigHit = big.untilDamage({ rangedPressed: true });
      expect(bigHit.damage).toBe(SAKDA.resonatingStrike.damage + SAKDA.resonatingStrike.missingHealthCap);
      const small = rig({ distance: 4, vitality: 60, maxVitality: 100 });
      echo(small, small.state.worldTick + 100);
      expect(small.untilDamage({ rangedPressed: true }).damage).toBe(SAKDA.resonatingStrike.damage + Math.round(40 * SAKDA.resonatingStrike.missingHealthRatio));
    });

    it('an echoed target out of dash range gets a fresh Echo Wave instead', () => {
      const r = rig({ distance: SAKDA.resonatingStrike.maxDashRange + 4 });
      echo(r, r.state.worldTick + 100);
      r.step({ rangedPressed: true });
      expect(r.me().actionId).toBe('sakda-echo-wave');
    });
  });

  describe('Hundred Elbows', () => {
    it('charges with the loop clip, locks on, dashes up to 3 m and lands six hits plus an uppercut', () => {
      const r = rig({ distance: 3.2 });
      r.state.player.mana = 100;
      r.holdRanged();
      expect(r.me().actionId).toBe('sakda-elbow-charge');
      const manaBefore = r.state.player.mana;
      r.step({ rangedReleased: true });
      expect(r.state.player.mana).toBe(manaBefore - PLAYER_SKILLS.sigil_barrage.manaCost);
      expect(r.me().actionId).toBe('sakda-hundred-elbows');
      expect(r.me().actionEndsTick - r.me().actionStartedTick).toBe(SAKDA.hundredElbows.ticks);
      const hits: number[] = [];
      let last = r.live().vitality!;
      for (let tick = 1; tick <= SAKDA.hundredElbows.ticks + 20; tick++) {
        r.step();
        const now = r.live().vitality!;
        if (now < last) hits.push(last - now);
        last = now;
      }
      const spec = SAKDA.hundredElbows;
      expect(hits).toEqual([...spec.hitAt.map(() => spec.hitDamage), spec.uppercutDamage]);
      expect(r.gap()).toBeLessThan(COLLISION_GAP);
      expect(r.gap()).toBeGreaterThan(0.5);
    });

    it('its first hit lands at tick 12 and the dash never exceeds 3 m', () => {
      const r = rig({ distance: 8 });
      r.holdRanged();
      const start = { ...r.me().position };
      r.step({ rangedReleased: true });
      const first = r.untilDamage();
      expect(first.damage).toBe(0); // nothing in reach at 8 m minus a 3 m dash
      expect(Math.hypot(r.me().position.x - start.x, r.me().position.z - start.z)).toBeLessThanOrEqual(SAKDA.hundredElbows.dashDistance + 0.01);
      const near = rig({ distance: 2.2 });
      near.holdRanged();
      near.step({ rangedReleased: true });
      let steps = 1;
      const health = near.live().vitality!;
      while (near.live().vitality === health && steps < 40) { near.step(); steps++; }
      expect(steps).toBe(SAKDA.hundredElbows.hitAt[0]! + 1);
    });
  });

  describe('Tempest Stomp', () => {
    it('deals 20 in a 4 m ring at tick 12, spends 12 mana and applies a cripple', () => {
      const r = rig({ distance: 3.4 });
      const hit = r.untilDamage({ heavyPressed: true });
      expect(hit).toEqual({ steps: SAKDA.tempestStomp.activeAt + 1, damage: SAKDA.tempestStomp.damage });
      expect(r.state.player.mana).toBe(r.state.player.maxMana - PLAYER_SKILLS.heavy.manaCost);
      expect(r.me().actionId).toBe('sakda-tempest');
      expect(r.me().actionEndsTick - r.me().actionStartedTick).toBe(SAKDA.tempestStomp.ticks);
      const marks = r.engine.snapshot().actors.find(actor => actor.id === MONSTER)!.heroMarks!;
      expect(marks.find(mark => mark.kind === 'cripple')!.remainingTicks).toBeGreaterThan(SAKDA.tempestStomp.crippleTicks - 5);
      expect(r.live()).toMatchObject({ crippleFactor: SAKDA.tempestStomp.crippleSpeedFactor });
      expect(r.cues.find(cue => cue.kind === 'slash' && cue.shape === 'ring')).toMatchObject({ element: 'ember', actionId: 'sakda-tempest' });
    });

    it('does not reach a foe outside 4 m', () => {
      const r = rig({ distance: 6 });
      r.step({ heavyPressed: true }, 40);
      expect(r.live().vitality).toBe(1000);
      expect(r.live().crippleUntil).toBeUndefined();
    });

    it('cripple really slows a moving trial monster', () => {
      const travel = (stomp: boolean): number => {
        const r = rig({ distance: 3.4, frozen: false });
        if (stomp) {
          r.state.hazards = []; r.state.telegraphs = [];
          r.step({ heavyPressed: true }, SAKDA.tempestStomp.activeAt + 1);
          expect(r.live().crippleUntil).toBeDefined();
        } else r.step({}, SAKDA.tempestStomp.activeAt + 1);
        // Move Sakda well away, free the monster and measure how far it chases in 40 ticks.
        const monster = r.live(), player = r.me();
        r.state.hazards = []; r.state.telegraphs = [];
        monster.staggerUntil = 0; monster.recoveringUntil = 0; monster.reactionState = undefined;
        // The monster is already engaged and past its roar, so only its walking speed is measured.
        Object.assign(monster.motion!, { engaged: true, roarTier: 99, roarUntil: 0, lunge: undefined, nextCastAt: FROZEN });
        player.position = vec(monster.position.x, monster.position.y, monster.position.z + 10);
        const from = { ...monster.position };
        const until = r.state.worldTick + 40;
        while (r.state.worldTick < until) r.step();
        return Math.hypot(r.live().position.x - from.x, r.live().position.z - from.z);
      };
      const free = travel(false), crippled = travel(true);
      expect(free).toBeGreaterThan(1);
      expect(crippled).toBeLessThan(free * 0.8);
    });
  });

  describe('Flying Knee', () => {
    it('charges with the loop clip, arcs through the air and lands its damage on impact', () => {
      const r = rig({ distance: 8 });
      r.holdHeavy();
      expect(r.me().actionId).toBe('sakda-knee-charge');
      const groundY = r.me().position.y;
      const mana = r.state.player.mana;
      r.releaseHeavy();
      expect(r.state.player.mana).toBe(mana - PLAYER_SKILLS.charged_heavy.manaCost);
      expect(r.me().actionId).toBe('sakda-flying-knee');
      expect(r.me().actionEndsTick - r.me().actionStartedTick).toBe(SAKDA.flyingKnee.ticks);
      let peak = groundY, steps = 1;
      const health = r.live().vitality!;
      while (r.live().vitality === health && steps < SAKDA.flyingKnee.ticks) { peak = Math.max(peak, r.me().position.y); r.step(); steps++; }
      expect(steps).toBe(SAKDA.flyingKnee.impactAt + 1);
      expect(peak - groundY).toBeGreaterThan(0.8);
      expect(health - r.live().vitality!).toBe(SAKDA.flyingKnee.damage);
      expect(r.me().position.y).toBeCloseTo(groundY, 3);
      expect(r.gap()).toBeLessThan(COLLISION_GAP);
      expect(r.cues.find(cue => cue.kind === 'blink' && cue.actionId === 'sakda-flying-knee')).toMatchObject({ element: 'ember' });
    });

    it('interrupts the target’s real windup', () => {
      const r = rig({ distance: 6 });
      r.holdHeavy();
      startWindup(r);
      r.releaseHeavy();
      r.step({}, SAKDA.flyingKnee.impactAt - 3);
      expect(r.state.telegraphs.some(telegraph => telegraph.sourceId === MONSTER)).toBe(true);
      r.step({}, 4);
      expect(r.live().vitality).toBe(1000 - SAKDA.flyingKnee.damage);
      expect(r.state.telegraphs.some(telegraph => telegraph.sourceId === MONSTER)).toBe(false);
      expect(interrupted(r)).toBe(true);
    });

    it('lands 12 in a 3 m ring on every other hostile and never leaves the floor', () => {
      const seed = createEngineState();
      seed.arena.bounds = { min: vec(-30, -2, -30), max: vec(30, 20, 30) };
      seed.actors[0]!.facing = vec(0, 0, 1);
      for (const [id, z] of [['target-0', 6], ['target-1', 7.5], ['target-2', 12]] as const) {
        const boar = makeActor(id as ActorId, 'boar', 'hostile', vec(0, 0, z), false, false, 1000);
        boar.ferocity = undefined;
        seed.actors.push(boar);
      }
      const engine = new CombatEngine(seed);
      engine.setPlayerHero('sakda');
      const state = liveState(engine);
      state.targetId = 'target-0' as ActorId;
      engine.fixedStep({ ...idle, heavyPressed: true, heavyHeld: true });
      for (let i = 0; i < THUNDER_CLEAVE.holdTicks; i++) engine.fixedStep({ ...idle, heavyHeld: true });
      engine.fixedStep({ ...idle, heavyReleased: true, heavyHeldTicks: THUNDER_CLEAVE.holdTicks + 1 });
      for (let i = 0; i < SAKDA.flyingKnee.ticks + 5; i++) engine.fixedStep(idle);
      const health = (index: number) => state.actors[index + 1]!.vitality!;
      expect(health(0)).toBe(1000 - SAKDA.flyingKnee.damage);
      expect(health(1)).toBe(1000 - SAKDA.flyingKnee.ringDamage);
      expect(health(2)).toBe(1000);
      expect(state.actors[0]!.position.y).toBeCloseTo(0, 3);
    });
  });

  describe('Iron Clinch', () => {
    it('dashes to a winding-up foe, interrupts it on tick 12 and deals 8', () => {
      const r = rig({ distance: 5 });
      startWindup(r);
      r.step({ tetherPressed: true });
      expect(r.me().actionId).toBe('sakda-iron-clinch');
      expect(r.state.player.mana).toBe(r.state.player.maxMana - PLAYER_SKILLS.root_tether.manaCost);
      expect(r.me().actionEndsTick - r.me().actionStartedTick).toBe(SAKDA.ironClinch.ticks);
      let steps = 1;
      while (r.live().vitality === 1000 && steps < 40) { r.step(); steps++; }
      expect(steps).toBe(SAKDA.ironClinch.strikeAt + 1);
      expect(1000 - r.live().vitality!).toBe(SAKDA.ironClinch.damage);
      expect(r.gap()).toBeLessThan(COLLISION_GAP);
      expect(r.state.telegraphs.some(telegraph => telegraph.sourceId === MONSTER)).toBe(false);
      expect(interrupted(r)).toBe(true);
    });

    it('refunds Q and does nothing when the foe is out of reach', () => {
      const r = rig({ distance: SAKDA.ironClinch.range + 6 });
      startWindup(r);
      const mana = r.state.player.mana;
      r.step({ tetherPressed: true });
      expect(r.state.player.mana).toBe(mana);
      expect(r.me().actionId).not.toBe('sakda-iron-clinch');
      expect(r.state.telegraphs.some(telegraph => telegraph.sourceId === MONSTER)).toBe(true);
    });
  });

  describe('Guard Dash', () => {
    it('travels 5.5 m over 18 ticks with 8 untouchable ticks and raises a 25 shield that decays after 120 ticks', () => {
      const r = rig({ distance: 8 });
      // Dash west across open forest floor: away from the monster and the root buttress.
      r.me().facing = vec(-1, 0, 0);
      const start = { ...r.me().position };
      r.step({ dodgePressed: true });
      // The player keeps the engine's shared dodge id (renderer vanish, afterimages); the hero clip rides on the blink cue.
      expect(r.me().actionId).toMatch(/^aren-.*(dive|roll|cartwheel|slide)/);
      expect(r.me().invulnerableUntil - r.state.tick).toBe(SAKDA.guardDash.iframes);
      expect(r.state.actionUntil - r.state.tick).toBe(SAKDA.guardDash.durationTicks);
      expect(r.state.actionRecoveryUntil - r.state.tick).toBe(SAKDA.guardDash.durationTicks + SAKDA.guardDash.recoveryTicks);
      expect(r.engine.snapshot().player.shield).toBe(SAKDA.guardDash.shield);
      expect(r.cues.find(cue => cue.kind === 'blink')).toMatchObject({ element: 'ember', actionId: 'sakda-guard-dash', durationTicks: SAKDA.guardDash.durationTicks });
      r.step({}, SAKDA.guardDash.durationTicks + 2);
      expect(Math.hypot(r.me().position.x - start.x, r.me().position.z - start.z)).toBeCloseTo(SAKDA.guardDash.distance, 1);
      r.step({}, SAKDA.guardDash.shieldTicks - SAKDA.guardDash.durationTicks - 6);
      expect(r.engine.snapshot().player.shield).toBe(SAKDA.guardDash.shield);
      r.step({}, 10);
      expect(r.engine.snapshot().player.shield).toBeUndefined();
    });

    it('absorbs damage before vitality, then lets the rest through, and expires', () => {
      const r = rig({ distance: 8 });
      r.state.player.vitality = 1000;
      r.step({ dodgePressed: true }, 1);
      r.step({}, 30);
      r.engine.consumeEvents();
      hazardOnPlayer(r, 10, 2, 'first');
      r.step({}, 6);
      expect(r.state.player.vitality).toBe(1000);
      expect(r.engine.snapshot().player.shield).toBe(SAKDA.guardDash.shield - 10);
      expect(r.cues.filter(cue => cue.kind === 'hit' && cue.targetId === 'aren')).toEqual([]);
      expect(r.engine.consumeEvents().filter(event => event.kind === 'damage')).toEqual([]);
      hazardOnPlayer(r, 20, 2, 'second');
      r.step({}, 6);
      expect(r.engine.snapshot().player.shield).toBeUndefined();
      expect(r.state.player.vitality).toBe(1000 - (20 - (SAKDA.guardDash.shield - 10)));
      const contact = r.cues.find(cue => cue.kind === 'hit' && cue.targetId === 'aren')!;
      expect(contact.confirmedDamage).toBe(1000 - r.state.player.vitality);
      const damage = r.engine.consumeEvents().find(event => event.damage?.targetId === 'aren')!;
      expect(contact.tick).toBe(damage.tick);
      expect(contact.confirmedDamage).toBe(damage.damage?.amount);
      // A fresh dash, then wait the shield out: the next hit lands in full.
      r.state.player.mana = r.state.player.maxMana;
      r.step({}, 20);
      r.step({ dodgePressed: true });
      r.step({}, SAKDA.guardDash.shieldTicks + 4);
      const before = r.state.player.vitality;
      hazardOnPlayer(r, 12, 2, 'third');
      r.step({}, 6);
      expect(r.state.player.vitality).toBe(before - 12);
    });

    it('the dash arms Flurry so J chains straight out of it', () => {
      const r = rig({ distance: 8 });
      r.step({ dodgePressed: true });
      expect(r.engine.snapshot().player.flurryCharges).toBe(SAKDA.flurry.charges);
    });
  });

  describe("Tiger's Wrath", () => {
    const wrath = (distance: number) => {
      const r = rig({ distance });
      r.state.player.instinct = 100;
      return r;
    };

    it('protects the windup, kicks on contact, staggers and finishes the finite knockback', () => {
      const r = wrath(3.2);
      const from = { ...r.live().position };
      r.step({ ultimatePressed: true });
      expect(r.state.player.instinct).toBe(0);
      expect(r.me().actionId).toBe('sakda-tigers-wrath');
      expect(r.me().actionEndsTick - r.me().actionStartedTick).toBe(SAKDA.tigersWrath.ticks);
      expect(r.engine.snapshot().player.untargetable).toBe(true);
      let steps = 1;
      while (r.live().vitality === 1000 && steps < 80) { r.step(); steps++; }
      expect(steps).toBe(SAKDA.tigersWrath.kickAt + 1);
      expect(1000 - r.live().vitality!).toBe(SAKDA.tigersWrath.damage);
      expect(r.live().staggerUntil - r.state.worldTick).toBeGreaterThan(SAKDA.tigersWrath.staggerTicks - 4);
      r.waitIdle();
      const moved = Math.hypot(r.live().position.x - from.x, r.live().position.z - from.z);
      expect(moved).toBeGreaterThan(SAKDA.tigersWrath.knockback - 0.2);
      expect(moved).toBeLessThanOrEqual(SAKDA.tigersWrath.knockback + 0.01);
      expect(r.cues.find(cue => cue.kind === 'beam')).toMatchObject({ element: 'ember', actionId: 'sakda-tigers-wrath' });
    });

    it('protects the committed kick window but allows damage after its iframe deadline', () => {
      const r = wrath(3.2);
      r.step({ ultimatePressed: true });
      r.step({}, SAKDA.tigersWrath.untargetableTo - 2);
      expect(r.engine.snapshot().player.untargetable).toBe(true);
      hazardOnPlayer(r, 15, 1, 'early');
      r.step({}, 4);
      expect(r.state.player.vitality).toBe(10_000);
      r.step({}, 6);
      expect(r.engine.snapshot().player.untargetable).toBeUndefined();
      hazardOnPlayer(r, 15, 1, 'late');
      r.step({}, 4);
      expect(r.state.player.vitality).toBe(10_000 - 15);
    });

    it('refuses (keeping Instinct) when nothing is within reach', () => {
      const r = wrath(12);
      r.step({ ultimatePressed: true });
      expect(r.state.player.instinct).toBe(100);
      expect(r.me().actionId).not.toBe('sakda-tigers-wrath');
    });

    it('slides the target through other hostiles for 40 each and stops at the arena edge', () => {
      const open = (targetZ: number) => {
        const seed = createEngineState();
        seed.arena.bounds = { min: vec(-30, -2, -30), max: vec(30, 20, 30) };
        seed.actors[0]!.facing = vec(0, 0, 1);
        for (const [id, z] of [['target-0', targetZ], ['target-1', targetZ + 3], ['target-2', targetZ + 12]] as const) {
          const boar = makeActor(id as ActorId, 'boar', 'hostile', vec(0, 0, z), false, false, 1000);
          boar.ferocity = undefined;
          seed.actors.push(boar);
        }
        const engine = new CombatEngine(seed);
        engine.setPlayerHero('sakda');
        const state = liveState(engine);
        state.targetId = 'target-0' as ActorId;
        state.player.instinct = 100;
        engine.fixedStep({ ...idle, ultimatePressed: true });
        for (let i = 0; i < SAKDA.tigersWrath.ticks + 4; i++) engine.fixedStep(idle);
        return state;
      };
      const state = open(2.5);
      const [a, b, c] = [state.actors[1]!, state.actors[2]!, state.actors[3]!];
      expect(a.vitality).toBe(1000 - SAKDA.tigersWrath.damage);
      expect(b.vitality).toBe(1000 - SAKDA.tigersWrath.slideDamage);
      expect(c.vitality).toBe(1000);
      expect(a.position.z).toBeGreaterThan(2.5 + SAKDA.tigersWrath.knockback - 0.3);

      // Against the arena edge the slide stops: nothing leaves the bounds and the knockback is shorter than 7 m.
      const wall = open(24);
      const pinned = wall.actors[1]!;
      expect(pinned.position.z).toBeLessThanOrEqual(30);
      expect(pinned.position.z - 24).toBeLessThan(SAKDA.tigersWrath.knockback - 0.5);
      expect(wall.actors[2]!.position.z).toBeLessThanOrEqual(30);
    });
  });

  describe('impacts are validated from the real position', () => {
    /** A thin wall across the line between Sakda and the monster: the strike has reach but no clear line. */
    const wallBetween = (r: Rig): void => {
      const a = r.me().position, b = r.live().position;
      addBox(r, 'test-wall', vec((a.x + b.x) / 2, 1.5, (a.z + b.z) / 2), vec(3, 1.5, 0.1));
    };

    it('Iron Clinch through a wall deals nothing and does not interrupt', () => {
      const open = rig({ distance: 1.8 });
      startWindup(open);
      open.step({ tetherPressed: true }, SAKDA.ironClinch.strikeAt + 4);
      expect(1000 - open.live().vitality!).toBe(SAKDA.ironClinch.damage);

      const r = rig({ distance: 1.8 });
      wallBetween(r);
      startWindup(r);
      r.step({ tetherPressed: true }, SAKDA.ironClinch.strikeAt + 4);
      expect(r.me().actionId).toBe('sakda-iron-clinch');
      expect(r.live().vitality).toBe(1000);
      expect(r.state.telegraphs.some(telegraph => telegraph.sourceId === MONSTER)).toBe(true);
      expect(interrupted(r)).toBe(false);
    });

    it('Resonating Strike through a wall deals nothing and keeps the Echo mark', () => {
      const r = rig({ distance: 1.8 });
      wallBetween(r);
      echo(r, r.state.worldTick + 300);
      r.step({ rangedPressed: true });
      expect(r.me().actionId).toBe('sakda-resonating-strike');
      r.step({}, SAKDA.resonatingStrike.ticks);
      expect(r.live().vitality).toBe(1000);
      expect(r.engine.snapshot().actors.find(actor => actor.id === MONSTER)!.heroMarks![0]!.kind).toBe('echo-mark');
    });

    it('Resonating Strike out of reach after the target moved away keeps the mark', () => {
      const r = rig({ distance: 5 });
      echo(r, r.state.worldTick + 300);
      r.step({ rangedPressed: true });
      r.step({}, 4);
      // The foe leaves the dash's reach before the strike lands.
      r.live().position = vec(r.live().position.x, r.live().position.y, r.live().position.z - 8);
      r.step({}, SAKDA.resonatingStrike.ticks);
      expect(r.live().vitality).toBe(1000);
      expect(r.engine.snapshot().actors.find(actor => actor.id === MONSTER)!.heroMarks![0]!.kind).toBe('echo-mark');
    });

    it('Flying Knee through a wall deals neither the hit nor the ring', () => {
      const r = rig({ distance: 2.6 });
      wallBetween(r);
      r.holdHeavy();
      startWindup(r);
      r.releaseHeavy();
      r.step({}, SAKDA.flyingKnee.ticks);
      expect(r.live().vitality).toBe(1000);
      expect(r.state.telegraphs.some(telegraph => telegraph.sourceId === MONSTER)).toBe(true);
      expect(interrupted(r)).toBe(false);
    });

    it("Tiger's Wrath through a wall deals no damage, stagger or knockback", () => {
      const r = rig({ distance: 1.8 });
      wallBetween(r);
      r.state.player.instinct = 100;
      const from = { ...r.live().position };
      r.step({ ultimatePressed: true }, SAKDA.tigersWrath.ticks);
      expect(r.live().vitality).toBe(1000);
      expect(r.live().position).toEqual(from);
      expect(r.live().staggerUntil).toBe(FROZEN);
    });

    it('Eight Limbs strikes do not pass through a wall either', () => {
      const r = rig({ distance: 1.8 });
      wallBetween(r);
      r.step({ lightPressed: true }, SAKDA.limbs.steps[0]!.ticks + 4);
      expect(r.live().vitality).toBe(1000);
    });
  });

  describe('Flying Knee aerial path', () => {
    it('is shortened by a low ceiling across the path, never passes through it and lands on the floor', () => {
      const r = rig({ distance: 8 });
      const start = { ...r.me().position };
      // A ceiling slab (underside 0.8 m) across the path 3 m from Sakda: the capsule cannot go beneath it.
      const slabZ = start.z - 3;
      addBox(r, 'test-ceiling', vec(start.x, 1.3, slabZ), vec(4, 0.5, 0.3));
      r.holdHeavy();
      const mana = r.state.player.mana;
      r.releaseHeavy();
      expect(r.state.player.mana).toBe(mana - PLAYER_SKILLS.charged_heavy.manaCost);
      expect(r.me().actionId).toBe('sakda-flying-knee');
      let intrusions = 0;
      for (let i = 0; i < SAKDA.flyingKnee.ticks + 2; i++) {
        r.step();
        // Sakda's footprint (0.35 m) must never overlap the slab's 0.6 m z span while his body is within its height band.
        const at = r.me().position;
        if (Math.abs(at.z - slabZ) < 0.3 + 0.35 - 1e-3 && at.y < 1.8) intrusions++;
      }
      expect(intrusions).toBe(0);
      const travelled = Math.hypot(r.me().position.x - start.x, r.me().position.z - start.z);
      expect(travelled).toBeGreaterThan(0.5);
      expect(travelled).toBeLessThan(3);
      expect(r.me().position.y).toBeCloseTo(start.y, 3);
      // Out of reach after the shortened leap: the target takes nothing.
      expect(r.live().vitality).toBe(1000);
    });

    it('is refused, spending no mana, when a ceiling leaves no room to leap', () => {
      const r = rig({ distance: 8 });
      const start = { ...r.me().position };
      addBox(r, 'test-ceiling', vec(start.x, 1.3, start.z - 0.9), vec(4, 0.5, 0.3));
      r.holdHeavy();
      const mana = r.state.player.mana;
      r.releaseHeavy();
      expect(r.state.player.mana).toBe(mana);
      expect(r.me().actionId).not.toBe('sakda-flying-knee');
      expect(r.state.kit.action).toBeNull();
    });

    it('an unobstructed leap still reaches the target and lands on the floor', () => {
      const r = rig({ distance: 8 });
      r.holdHeavy();
      r.releaseHeavy();
      r.step({}, SAKDA.flyingKnee.impactAt + 2);
      expect(r.live().vitality).toBeLessThan(1000);
      expect(r.me().position.y).toBeCloseTo(0, 3);
    });
  });

  describe('chaining through cancel windows', () => {
    /** Steps until `offset` ticks after the cancel window of the running action opens (hit-stop shifts the window, so ask the engine, not the clock). */
    const openWindow = (r: Rig, offset: number): void => {
      const window = r.state.kitCancel;
      if (!window) throw new Error('the running action has no cancel window');
      while (r.state.tick < window.fromTick + offset) r.step();
    };
    const kneeNow = (r: Rig): void => { r.holdHeavy(); r.releaseHeavy(); };
    const dashIdPattern = /^aren-.*(dive|roll|cartwheel|slide)/;

    it('cancels Flying Knee into other families after impact without bypassing the Heavy cooldown', () => {
      const into = (press: (r: Rig) => void, expectAction: (r: Rig) => void): void => {
        const r = rig({ distance: 7 });
        echo(r, r.state.worldTick + 600);
        kneeNow(r);
        // Before the window the ranged input is held back by the recovery.
        openWindow(r, -3);
        r.step({ rangedPressed: true });
        expect(r.me().actionId).toBe('sakda-flying-knee');
        openWindow(r, 1);
        expect(r.live().vitality).toBe(1000 - SAKDA.flyingKnee.damage);
        press(r);
        expectAction(r);
      };
      into(r => r.step({ dodgePressed: true }), r => {
        expect(r.me().actionId).toMatch(dashIdPattern);
        expect(r.cues.some(cue => cue.kind === 'blink' && cue.actionId === 'sakda-guard-dash')).toBe(true);
      });
      into(r => r.step({ rangedPressed: true }), r => expect(r.me().actionId).toBe('sakda-resonating-strike'));
      into(r => { r.state.player.mana = r.state.player.maxMana; r.step({ heavyPressed: true }); }, r => {
        expect(r.me().actionId).toBe('sakda-flying-knee');
        expect(r.state.player.mana).toBe(r.state.player.maxMana);
      });
    });

    it('Resonating Strike cancels into Flying Knee, Guard Dash and a second Resonating Strike', () => {
      const start = (): Rig => {
        const r = rig({ distance: 5 });
        echo(r, r.state.worldTick + 600);
        r.step({ rangedPressed: true });
        openWindow(r, 1);
        expect(r.live().vitality).toBeLessThan(1000);
        return r;
      };
      const toKnee = start();
      toKnee.state.player.mana = toKnee.state.player.maxMana;
      toKnee.live().position = vec(toKnee.me().position.x, toKnee.me().position.y, toKnee.me().position.z - 6);
      kneeNow(toKnee);
      expect(toKnee.me().actionId).toBe('sakda-flying-knee');

      const toDash = start();
      toDash.step({ dodgePressed: true });
      expect(toDash.me().actionId).toMatch(dashIdPattern);

      const toResonate = start();
      toResonate.state.player.mana = toResonate.state.player.maxMana;
      echo(toResonate, toResonate.state.worldTick + 600);
      toResonate.step({ rangedPressed: true });
      expect(toResonate.me().actionId).toBe('sakda-resonating-strike');
    });

    it('Guard Dash cancels into Flying Knee and Resonating Strike from the end of the dash, not before', () => {
      const early = rig({ distance: 8 });
      echo(early, early.state.worldTick + 600);
      early.me().facing = vec(-1, 0, 0);
      early.step({ dodgePressed: true });
      openWindow(early, -4);
      early.step({ rangedPressed: true });
      expect(early.me().actionId).toMatch(dashIdPattern);

      const toResonate = rig({ distance: 8 });
      echo(toResonate, toResonate.state.worldTick + 600);
      toResonate.me().facing = vec(-1, 0, 0);
      toResonate.step({ dodgePressed: true });
      openWindow(toResonate, 1);
      toResonate.step({ rangedPressed: true });
      expect(toResonate.me().actionId).toBe('sakda-resonating-strike');

      const toKnee = rig({ distance: 8 });
      toKnee.me().facing = vec(-1, 0, 0);
      toKnee.step({ dodgePressed: true });
      openWindow(toKnee, 1);
      toKnee.state.player.mana = toKnee.state.player.maxMana;
      kneeNow(toKnee);
      expect(toKnee.me().actionId).toBe('sakda-flying-knee');
    });

    it('a cancelled-away Resonating Strike leaves no pending impact behind', () => {
      const r = rig({ distance: 5 });
      echo(r, r.state.worldTick + 600);
      r.step({ rangedPressed: true });
      openWindow(r, 1);
      const health = r.live().vitality;
      r.step({ dodgePressed: true });
      r.step({}, SAKDA.resonatingStrike.ticks + 20);
      expect(r.live().vitality).toBe(health);
    });
  });

  describe('snapshot and serialization', () => {
    it('exposes marks, shield and flurry charges and keeps kit state plain JSON', () => {
      const r = rig({ distance: 6 });
      r.step({ dodgePressed: true });
      r.step({ rangedPressed: true }, 1);
      echo(r, r.state.worldTick + 50);
      const player = r.engine.snapshot().player;
      expect(player.shield).toBe(SAKDA.guardDash.shield);
      expect(player.flurryCharges).toBe(SAKDA.flurry.charges);
      expect(r.engine.snapshot().actors.find(actor => actor.id === MONSTER)!.heroMarks![0]).toMatchObject({ kind: 'echo-mark', remainingTicks: 50 });
      expect(JSON.parse(JSON.stringify(r.state.kit))).toEqual(r.state.kit);
    });

    it('survives a serialize/restore round trip mid-skill and finishes identically', () => {
      const run = (restore: boolean): { vitality: number; mana: number; shield: number | undefined; position: { x: number; z: number } } => {
        const r = rig({ distance: 8, vitality: 900, maxVitality: 1000 });
        r.step({ dodgePressed: true });
        r.step({}, 30);
        echo(r, r.state.worldTick + 120);
        r.waitIdle();
        r.step({ rangedPressed: true });
        r.step({}, 6);
        let engine = r.engine;
        if (restore) {
          const json = engine.serialize();
          engine = new CombatEngine();
          engine.restore(json);
        }
        const state = liveState(engine);
        for (let i = 0; i < 90; i++) engine.fixedStep(idle);
        const player = engine.snapshot().player;
        return { vitality: state.actors.find(actor => actor.id === MONSTER)!.vitality!, mana: state.player.mana, shield: player.shield, position: { x: state.actors[0]!.position.x, z: state.actors[0]!.position.z } };
      };
      const direct = run(false), restored = run(true);
      expect(restored).toEqual(direct);
      expect(direct.vitality).toBeLessThan(900);
    });

    it('cancelling mid-skill drops the action but keeps marks and the shield', () => {
      const r = rig({ distance: 3.4 });
      echo(r, r.state.worldTick + 100);
      r.step({ dodgePressed: true });
      r.step({ heavyPressed: true });
      r.step({ dodgePressed: true });
      expect(r.state.kit.action).toBeNull();
      expect(r.engine.snapshot().player.shield).toBe(SAKDA.guardDash.shield);
      expect(r.engine.snapshot().actors.find(actor => actor.id === MONSTER)!.heroMarks![0]!.kind).toBe('echo-mark');
    });
  });
});
