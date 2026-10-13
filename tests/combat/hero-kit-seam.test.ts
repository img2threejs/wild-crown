import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ActionId, ActorId } from '../../src/game/contracts.js';
import type { StoryCue } from '../../src/effects/story-cues.js';
import { CombatEngine, createEngineState, makeActor, type CombatInput, type EngineState, type LiveHazard } from '../../src/game/combat/CombatEngine.js';
import { HEARTROOT } from '../../src/game/combat/HeartrootSkills.js';
import { HERO_COMBAT } from '../../src/game/combat/HeroProfiles.js';
import { groundHeightAt, isSupportedCapsulePose, vec } from '../../src/game/combat/geometry.js';
import { ATTACKS } from '../../src/game/combat/content.js';
import { PLAYER_MAX_VITALITY, PLAYER_SKILLS, SIGIL, THUNDER_CLEAVE } from '../../src/game/combat/PlayerSkills.js';
import { SAKDA } from '../../src/game/combat/SakdaSkills.js';
import { VESPER } from '../../src/game/combat/VesperSkills.js';
import { KIT_FACTORIES } from '../../src/game/combat/kits/registry.js';
import type { HeroKit, KitHost } from '../../src/game/combat/kits/KitHost.js';
import { HEROES, type HeroId } from '../../src/game/heroes.js';
import { ASSET_PLAYTESTS } from '../../src/app/AssetPlaytests.js';
import { REGIONS } from '../../src/content/campaign.js';
import { createCombatTrialRegion } from '../../src/game/combat/TrialRegions.js';

const idle: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
const HEROES_UNDER_TEST: readonly HeroId[] = ['aren', 'yara', 'vesper', 'sakda'];

/** Test-only access to the engine-owned live state (the other combat tests read it the same way). */
function liveState(engine: CombatEngine): EngineState {
  const internals = engine as unknown as { state: EngineState };
  return internals.state;
}

function bench(hero: HeroId | undefined, positions: readonly [number, number][] = []) {
  const seed = createEngineState();
  seed.arena.bounds = { min: vec(-30, -2, -30), max: vec(30, 20, 30) };
  seed.actors[0]!.facing = vec(0, 0, 1);
  for (const [index, [x, z]] of positions.entries()) {
    const actor = makeActor(('target-' + index) as ActorId, 'boar', 'hostile', vec(x, 0, z), false, false, 1000);
    actor.ferocity = undefined;
    seed.actors.push(actor);
  }
  const engine = new CombatEngine(seed);
  if (hero) engine.setPlayerHero(hero);
  const state = liveState(engine);
  const cues: StoryCue[] = [];
  const step = (patch: Partial<CombatInput> = {}, count = 1) => {
    for (let i = 0; i < count; i++) { engine.fixedStep({ ...idle, ...patch }); cues.push(...engine.drainPresentationCues()); }
  };
  return { engine, state, cues, step, health: (index: number) => state.actors[index + 1]!.vitality! };
}

function hazardOn(damage: number, activeFrom: number): LiveHazard {
  const attack = ATTACKS['koro-fruit-burst']!;
  return {
    ...structuredClone(attack.hazard), id: 'burst', attackId: attack.id,
    sourceId: 'koro' as ActorId, targetActorId: 'aren' as ActorId, startTick: 0, activeFrom, activeUntil: 400,
    target: vec(0, 0, 0), origin: vec(0, 0, 0), direction: vec(0, 0, 1),
    width: 40, depth: 40, damage, hitIds: [], threatTicks: [], cue: 'burst',
    bounds: { min: vec(-20, -1, -20), max: vec(20, 3, 20) },
  };
}

describe('per-hero health and speed', () => {
  for (const id of HEROES_UNDER_TEST) {
    it(`${id}: setPlayerHero applies the profile to the player, the aren actor and the checkpoint`, () => {
      const engine = new CombatEngine();
      engine.loadRegion({ regionId: 'greenwake', runId: 'profile', presentActorIds: [] });
      engine.setPlayerHero(id);
      const state = liveState(engine), profile = HERO_COMBAT[id];
      expect(state.player).toMatchObject({ vitality: profile.maxVitality, maxVitality: profile.maxVitality });
      expect(state.actors.find(actor => actor.id === 'aren')).toMatchObject({ vitality: profile.maxVitality, maxVitality: profile.maxVitality });
      expect(state.checkpoint!.player).toMatchObject({ vitality: profile.maxVitality, maxVitality: profile.maxVitality });
      expect(engine.snapshot().player).toMatchObject({ vitality: profile.maxVitality, maxVitality: profile.maxVitality });
      expect(HEROES.find(hero => hero.id === id)!.maxVitality).toBe(profile.maxVitality);
    });

    it(`${id}: a retry restores the hero's health and a region reload keeps its health pool`, () => {
      const engine = new CombatEngine();
      engine.loadRegion({ regionId: 'greenwake', runId: 'retry', presentActorIds: [] });
      engine.setPlayerHero(id);
      engine.startEncounter({ regionId: 'greenwake', runId: 'retry', encounterId: 'greenwake-boar' });
      const state = liveState(engine), profile = HERO_COMBAT[id];
      state.player.vitality = 1;
      engine.resetToCheckpoint();
      expect(state.player).toMatchObject({ vitality: profile.maxVitality, maxVitality: profile.maxVitality });
      expect(state.actors.find(actor => actor.id === 'aren')!.maxVitality).toBe(profile.maxVitality);
      const fresh = new CombatEngine();
      fresh.loadRegion({ regionId: 'greenwake', runId: 'a', presentActorIds: [] });
      fresh.setPlayerHero(id);
      const freshState = liveState(fresh);
      freshState.player.vitality = 7;
      fresh.loadRegion({ regionId: 'greenwake', runId: 'a', presentActorIds: [] });
      fresh.setPlayerHero(id);
      expect(freshState.player).toMatchObject({ vitality: 7, maxVitality: profile.maxVitality });
      expect(freshState.actors.find(actor => actor.id === 'aren')).toMatchObject({ vitality: 7, maxVitality: profile.maxVitality });
      fresh.startNewRun('next');
      expect(liveState(fresh).player.maxVitality).toBe(PLAYER_MAX_VITALITY);
    });

    it(`${id}: walks and runs at its own speeds`, () => {
      const speedOf = (sprintHeld: boolean): number => {
        const b = bench(id);
        b.step({ move: vec(1, 0, 0), sprintHeld }, 40);
        return Math.hypot(b.state.actors[0]!.velocity.x, b.state.actors[0]!.velocity.z);
      };
      expect(speedOf(false)).toBeCloseTo(HERO_COMBAT[id].walkSpeed, 3);
      expect(speedOf(true)).toBeCloseTo(HERO_COMBAT[id].runSpeed, 3);
    });
  }

  it('matches the design table for every hero', () => {
    expect(Object.fromEntries(HEROES_UNDER_TEST.map(id => [id, [HERO_COMBAT[id].maxVitality, HERO_COMBAT[id].walkSpeed, HERO_COMBAT[id].runSpeed, HERO_COMBAT[id].element]]))).toEqual({
      aren: [120, 4.1, 6, 'arcane'], yara: [85, 4.1, 6, 'heartroot'], vesper: [80, 4.9, 7.5, 'umbral'], sakda: [115, 4.4, 6.6, 'ember'],
    });
  });

  it('the hero definitions mirror the profile', () => {
    expect(HEROES.map(hero => hero.id)).toEqual(HEROES_UNDER_TEST);
    for (const hero of HEROES) {
      expect(hero.maxVitality).toBe(HERO_COMBAT[hero.id].maxVitality);
      expect(hero.skills.map(skill => skill.action)).toEqual(['light', 'heavy', 'ranged', 'ability', 'dodge', 'ultimate']);
    }
  });
});

describe('Yara damage', () => {
  it('uses the raised constants, timings unchanged', () => {
    expect(HEARTROOT).toMatchObject({
      thornDamage: 16, twinDamage: 12, seedDamage: 32, spikeDamage: 37, eruptionDamage: 55, lanceDamage: 40,
      stormDamage: 13, meteorDamage: 13, bloomPulseDamage: 58, spikeAt: 20, spikeTicks: 63, eruptionAt: 36, eruptionTicks: 76, bloomTicks: 156,
    });
  });
  it('lands a Thornshot for exactly the constant', () => {
    const b = bench('yara', [[0, 7]]);
    b.step({ lightPressed: true });
    b.step({}, 70);
    expect(b.health(0)).toBe(1000 - HEARTROOT.thornDamage);
  });
});

describe('Vesper and Sakda skill data', () => {
  it('carries the contract timings', () => {
    expect(VESPER.iai.steps.map(step => [step.ticks, step.activeAt, step.damage])).toEqual([[18, 6, 12], [18, 6, 12], [22, 8, 15], [30, 10, 22]]);
    expect(VESPER.thousandCuts.strikeAt).toEqual([8, 18, 28, 38, 48, 58]);
    expect(VESPER.mistBlink).toMatchObject({ distance: 6.5, durationTicks: 12, iframes: 14, recoveryTicks: 12 });
    expect(SAKDA.limbs.steps.map(step => [step.ticks, step.activeAt, step.damage])).toEqual([[20, 7, 10], [22, 8, 11], [26, 10, 14], [32, 13, 18]]);
    expect(SAKDA.hundredElbows.hitAt).toEqual([12, 18, 24, 30, 36, 42]);
    expect(SAKDA.guardDash).toMatchObject({ distance: 5.5, durationTicks: 18, iframes: 8, shield: 25, shieldTicks: 120 });
  });
});

interface TestKitState { updates: number; hitStops: number; shield: number; dealt: number; marked: string[]; log: string[] }

/** A minimal kit exercising every routed input and hook of the seam. */
function testKit(host: KitHost, options: { refuseUltimate?: boolean } = {}): HeroKit {
  const state = () => host.kitState<TestKitState>(() => ({ updates: 0, hitStops: 0, shield: 10, dealt: 0, marked: [], log: [] }));
  const strike = (damage: number) => ({ action: 'light_1', clip: 'test-strike' as ActionId, damage, element: 'umbral' as const, stagger: 'none' as const, stopTicks: 0, instinct: 0 });
  return {
    heroId: 'vesper',
    element: 'umbral',
    labels: { light: 'Test Cut', heavy: 'Test Stomp', charged_heavy: 'Test Storm', dive: 'Test Blink' },
    lightSteps: 2,
    dodge: { clip: 'test-dodge' as ActionId, distance: 3, durationTicks: 10, iframes: 6, recoveryTicks: 5, blinkCue: true },
    clip: action => ({ light_1: 'test-light-1', heavy_charge: 'test-heavy-charge', sigil_charge: 'test-sigil-charge' } as Record<string, string>)[action] as ActionId | undefined,
    startLight(step, chain) {
      state().log.push(`light:${step}:${chain}`);
      host.beginAction({ id: `test-light-${step}`, clip: 'test-light' as ActionId, totalTicks: 10, light: { step, chainEarlyTicks: 4, chainLateTicks: 18 } });
      host.strikeCone(host.player.position, host.player.facing, 3, 360, { ...strike(10), stopTicks: 3 });
      return true;
    },
    startHeavy(charged) {
      if (!host.spendMana(charged ? 'charged_heavy' : 'heavy')) return false;
      state().log.push(`heavy:${charged}`);
      host.beginAction({ id: 'test-heavy', clip: 'test-heavy' as ActionId, totalTicks: 20 });
      const target = host.softTarget(12);
      if (target) host.crippleMonster(target, 0.5, 100);
      if (charged) host.setUntargetableUntil(host.tick + 50);
      return true;
    },
    startRanged(charged) {
      if (!host.spendMana(charged ? 'sigil_barrage' : 'sigil_bolt')) return false;
      state().log.push(`ranged:${charged}`);
      host.beginAction({ id: 'test-ranged', clip: 'test-ranged' as ActionId, totalTicks: 24 });
      host.spawnProjectile({ kind: 'kunai', actionId: 'test-kunai', origin: vec(host.player.position.x, 1, host.player.position.z + 0.5), direction: vec(0, 0, 1), speed: 22, range: 16, radius: 0.15, damage: 9, callbackId: 'test-kunai' });
      return true;
    },
    startTether(target) {
      state().log.push(`tether:${target.id}`);
      host.beginAction({ id: 'test-tether', clip: 'test-tether' as ActionId, totalTicks: 36 });
      return host.interruptMonster(target, 'root_tether');
    },
    startUltimate() {
      if (options.refuseUltimate) return false;
      state().log.push('ultimate');
      host.beginAction({ id: 'test-ultimate', clip: 'test-ultimate' as ActionId, totalTicks: 30 });
      return true;
    },
    update() { state().updates++; },
    onHitStop() { state().hitStops++; },
    cancel() { state().log.push('cancel'); },
    reset() { state().log.push('reset'); },
    onDodge(info) { state().log.push(`dodge:${info.durationTicks}`); },
    modifyStrike: (_target, incoming) => ({ ...incoming, damage: incoming.damage + 5 }),
    afterStrike(target, _strike, dealt) { const s = state(); s.dealt += dealt; if (!s.marked.includes(target.id)) s.marked.push(target.id); },
    absorbDamage(amount) { const s = state(), taken = Math.min(s.shield, amount); s.shield -= taken; return amount - taken; },
    moveSpeedScale: () => 0.5,
    playerExtras: () => ({ shield: state().shield, flurryCharges: 2 }),
    heroMarks: actorId => state().marked.includes(actorId) ? [{ kind: 'death-mark' as const, stacks: 3, remainingTicks: 100 }] : undefined,
    onProjectileHit(projectile, target, point) {
      state().log.push(`hit:${target.id}`);
      host.strikeHostile(target, { ...strike(projectile.damage), clip: 'test-kunai' as ActionId });
      expect(point.z).toBeGreaterThan(0);
    },
    onProjectileEnd() { state().log.push('end'); },
  };
}

const kitState = (engine: CombatEngine): TestKitState => liveState(engine).kit as unknown as TestKitState;
/** The kit's skill-routing log without its lifecycle entries. */
const actions = (engine: CombatEngine): string[] => kitState(engine).log.filter(entry => entry !== 'reset' && entry !== 'cancel');

describe('hero kit seam', () => {
  const original = { ...KIT_FACTORIES };
  beforeEach(() => { delete KIT_FACTORIES.vesper; delete KIT_FACTORIES.sakda; });
  afterEach(() => { delete KIT_FACTORIES.vesper; delete KIT_FACTORIES.sakda; Object.assign(KIT_FACTORIES, original); });

  it('Vesper and Sakda play Aren’s kit until a factory is registered', () => {
    for (const id of ['vesper', 'sakda'] as const) {
      const b = bench(id, [[0, 2]]);
      b.step({ lightPressed: true });
      expect(b.state.actors[0]!.actionId).toBe('aren-light-1');
      expect(b.engine.snapshot().skills.find(skill => skill.id === 'light')!.label).toBe('Warden Blade');
      expect(b.engine.snapshot().player).not.toHaveProperty('shield');
      b.step({}, 12);
      expect(b.cues.some(cue => cue.element === 'arcane')).toBe(true);
    }
  });

  it('routes J through the kit, caps the chain at its step count and applies the damage modifier', () => {
    KIT_FACTORIES.vesper = host => testKit(host);
    const b = bench('vesper', [[0, 2]]);
    b.step({ lightPressed: true });
    expect(actions(b.engine)).toEqual(['light:1:false']);
    expect(b.state.actors[0]!.actionId).toBe('test-light');
    expect(b.health(0)).toBe(1000 - 15);
    // The first strike froze the world for 3 ticks, which also pushed the chain window back by 3.
    b.step({}, 8);
    b.step({ lightPressed: true });
    expect(actions(b.engine)).toEqual(['light:1:false', 'light:2:true']);
    // Step 2 was the last: the next press after its window restarts the chain.
    b.step({}, 40);
    b.step({ lightPressed: true });
    expect(kitState(b.engine).log.at(-1)).toBe('light:1:false');
    expect(kitState(b.engine).dealt).toBe(b.state.actors[1]!.maxVitality - b.health(0));
  });

  it('shows the kit labels and replaces Aren’s skill clips', () => {
    KIT_FACTORIES.vesper = host => testKit(host);
    const b = bench('vesper');
    const skills = b.engine.snapshot().skills;
    expect(skills.find(skill => skill.id === 'light')!.label).toBe('Test Cut');
    expect(skills.find(skill => skill.id === 'heavy')!.label).toBe('Test Stomp');
    // A kit's K needs no target.
    expect(skills.find(skill => skill.id === 'heavy')!.available).toBe(true);
  });

  it('routes K tap and the K hold release, charging with the kit clip', () => {
    KIT_FACTORIES.vesper = host => testKit(host);
    const b = bench('vesper', [[0, 6]]);
    b.step({ heavyPressed: true });
    expect(actions(b.engine)).toEqual(['heavy:false']);
    expect(b.state.player.mana).toBe(100 - PLAYER_SKILLS.heavy.manaCost);
    b.step({}, 40);
    b.step({ heavyPressed: true, heavyHeld: true });
    expect(b.state.actors[0]!.actionId).toBe('test-heavy-charge');
    b.step({ heavyHeld: true }, THUNDER_CLEAVE.holdTicks);
    b.step({ heavyReleased: true, heavyHeldTicks: THUNDER_CLEAVE.holdTicks + 1 });
    expect(kitState(b.engine).log.at(-1)).toBe('heavy:true');
  });

  it('routes L tap and L hold release, spawns a kit projectile and resolves its hit and end through callbacks', () => {
    KIT_FACTORIES.vesper = host => testKit(host);
    const b = bench('vesper', [[0, 6]]);
    b.step({ rangedPressed: true });
    expect(actions(b.engine)).toEqual(['ranged:false']);
    expect(b.engine.snapshot().playerProjectiles?.map(projectile => projectile.kind)).toEqual(['kunai']);
    b.step({}, 25);
    expect(actions(b.engine)).toEqual(['ranged:false', 'hit:target-0', 'end']);
    expect(b.health(0)).toBe(1000 - (9 + 5));
    expect(b.engine.snapshot().playerProjectiles).toBeUndefined();
    const projectileCues = b.cues.filter(cue => cue.kind === 'projectile' || cue.kind === 'projectile-impact');
    expect(projectileCues.map(cue => [cue.kind, cue.element, cue.actionId])).toEqual([['projectile', 'umbral', 'test-kunai'], ['projectile-impact', 'umbral', 'test-kunai']]);
    const held = bench('vesper');
    held.step({ rangedPressed: true, rangedHeld: true });
    expect(held.state.sigilCharge).toBeDefined();
    expect(held.state.actors[0]!.actionId).toBe('test-sigil-charge');
    held.step({ rangedHeld: true }, SIGIL.barrageHoldTicks);
    held.step({ rangedReleased: true });
    expect(actions(held.engine)).toEqual(['ranged:true']);
    expect(held.state.player.mana).toBe(100 - PLAYER_SKILLS.sigil_barrage.manaCost);
  });

  it('routes Q to the kit once the engine has validated a winding-up target', () => {
    KIT_FACTORIES.vesper = host => testKit(host);
    const b = bench('vesper', [[0, 4]]);
    const windup = hazardOn(5, 400);
    Object.assign(windup, { sourceId: 'target-0', startTick: 0, windupUntil: 200, activeUntil: 500, bounds: { min: vec(80, 0, 80), max: vec(81, 1, 81) } });
    b.state.hazards.push(windup);
    b.state.telegraphs.push({ id: windup.id, attackId: windup.attackId, sourceId: 'target-0' as ActorId, targetPosition: vec(0, 0, 4), phase: 'windup', remainingTicks: 200, cue: '' });
    b.state.targetId = 'target-0' as ActorId;
    b.step({ tetherPressed: true });
    expect(actions(b.engine)).toEqual(['tether:target-0']);
    expect(b.state.player.mana).toBe(100 - PLAYER_SKILLS.root_tether.manaCost);
    expect(b.state.hazards.find(hazard => hazard.id === 'burst')!.activeUntil).toBeLessThanOrEqual(b.state.worldTick);
    // Without a winding-up foe the engine rejects Q before the kit is asked.
    const quiet = bench('vesper', [[0, 4]]);
    quiet.state.targetId = 'target-0' as ActorId;
    quiet.step({ tetherPressed: true });
    expect(actions(quiet.engine)).toEqual([]);
  });

  it('routes U, spends Instinct only when the kit accepts', () => {
    KIT_FACTORIES.vesper = host => testKit(host, { refuseUltimate: true });
    const refused = bench('vesper');
    refused.state.player.instinct = 100;
    refused.step({ ultimatePressed: true });
    expect(refused.state.player.instinct).toBe(100);
    KIT_FACTORIES.vesper = host => testKit(host);
    const b = bench('vesper');
    b.state.player.instinct = 100;
    b.step({ ultimatePressed: true });
    expect(actions(b.engine)).toEqual(['ultimate']);
    expect(b.state.player.instinct).toBe(0);
  });

  it('overrides the Dodge with the kit profile, clip, blink cue and hook', () => {
    KIT_FACTORIES.vesper = host => testKit(host);
    const b = bench('vesper');
    const start = { ...b.state.actors[0]!.position };
    b.step({ dodgePressed: true });
    // The player actor keeps the shared engine dodge id (the manifest aliases it to the hero clip); the hero clip only rides on the blink cue.
    expect(b.state.actors[0]!.actionId).not.toBe('test-dodge');
    expect(b.state.actors[0]!.actionId).toMatch(/^aren-.*(dive|roll)/);
    expect(kitState(b.engine).log).toContain('dodge:10');
    expect(b.state.player.mana).toBe(100 - PLAYER_SKILLS.dive.manaCost);
    expect(b.state.actionUntil - b.state.tick).toBeLessThanOrEqual(10);
    b.step({}, 12);
    expect(Math.hypot(b.state.actors[0]!.position.x - start.x, b.state.actors[0]!.position.z - start.z)).toBeCloseTo(3, 1);
    const blink = b.cues.find(cue => cue.kind === 'blink')!;
    expect(blink).toMatchObject({ element: 'umbral', actionId: 'test-dodge', durationTicks: 10 });
    expect(b.state.player.mana).toBeLessThan(100);
  });

  it('absorbs damage with the kit shield before vitality and reports it in the snapshot', () => {
    KIT_FACTORIES.vesper = host => testKit(host);
    const b = bench('vesper');
    b.state.hazards.push(hazardOn(30, 3));
    expect(b.engine.snapshot().player.shield).toBe(10);
    b.step({}, 6);
    expect(b.state.player.vitality).toBe(HERO_COMBAT.vesper.maxVitality - 20);
    expect(b.engine.snapshot().player.shield).toBe(0);
    expect(b.engine.snapshot().player.flurryCharges).toBe(2);
  });

  it('makes the player untargetable until the kit’s deadline and says so in the snapshot', () => {
    KIT_FACTORIES.vesper = host => testKit(host);
    const b = bench('vesper');
    b.state.player.mana = 100;
    b.state.hazards.push(hazardOn(30, 70));
    b.step({ heavyPressed: true, heavyHeld: true });
    b.step({ heavyHeld: true }, THUNDER_CLEAVE.holdTicks);
    b.step({ heavyReleased: true, heavyHeldTicks: THUNDER_CLEAVE.holdTicks + 1 });
    expect(actions(b.engine)).toContain('heavy:true');
    expect(b.engine.snapshot().player.untargetable).toBe(true);
    b.step({}, 40);
    // The hazard is live but the player cannot be targeted until the deadline.
    expect(b.state.worldTick).toBeGreaterThan(70);
    expect(b.state.player.vitality).toBe(HERO_COMBAT.vesper.maxVitality);
    b.step({}, 20);
    expect(b.engine.snapshot().player.untargetable).toBeUndefined();
    expect(b.state.player.vitality).toBe(HERO_COMBAT.vesper.maxVitality - 20);
  });

  it('scales walk speed through the kit hook', () => {
    KIT_FACTORIES.vesper = host => testKit(host);
    const b = bench('vesper');
    b.step({ move: vec(1, 0, 0) }, 40);
    expect(Math.hypot(b.state.actors[0]!.velocity.x, b.state.actors[0]!.velocity.z)).toBeCloseTo(HERO_COMBAT.vesper.walkSpeed * 0.5, 3);
  });

  it('puts kit marks and the engine cripple in the actor snapshot', () => {
    KIT_FACTORIES.vesper = host => testKit(host);
    const b = bench('vesper', [[0, 2], [4, 4]]);
    b.step({ lightPressed: true });
    const marks = (index: number) => b.engine.snapshot().actors[index]!.heroMarks;
    expect(marks(1)).toEqual([{ kind: 'death-mark', stacks: 3, remainingTicks: 100 }]);
    expect(marks(2)).toBeUndefined();
    b.step({}, 30);
    b.state.targetId = 'target-0' as ActorId;
    b.step({ heavyPressed: true });
    expect(marks(1)!.find(mark => mark.kind === 'cripple')!.remainingTicks).toBeGreaterThan(90);
  });

  it('freezes the kit during hit-stop and tells it once per frozen tick', () => {
    KIT_FACTORIES.vesper = host => testKit(host);
    const b = bench('vesper', [[0, 2]]);
    b.step({ lightPressed: true });
    const before = kitState(b.engine).updates;
    b.step({}, 3);
    expect(kitState(b.engine)).toMatchObject({ updates: before, hitStops: 3 });
    b.step({});
    expect(kitState(b.engine).updates).toBe(before + 1);
  });

  it('keeps kit state as plain JSON through serialize and restore, and rebuilds the kit', () => {
    KIT_FACTORIES.vesper = host => testKit(host);
    const b = bench('vesper', [[0, 2]]);
    b.step({ lightPressed: true });
    b.step({}, 5);
    const json = b.engine.serialize();
    const parsed = JSON.parse(json) as { kit: TestKitState };
    expect(parsed.kit.marked).toEqual(['target-0']);
    expect(parsed.kit.shield).toBe(10);
    const restored = new CombatEngine();
    restored.restore(json);
    expect(kitState(restored)).toEqual(kitState(b.engine));
    const snapshot = restored.snapshot();
    expect(snapshot.player).toMatchObject({ heroId: 'vesper', shield: 10, flurryCharges: 2 });
    expect(snapshot.actors.find(actor => actor.id === 'target-0')!.heroMarks).toEqual([{ kind: 'death-mark', stacks: 3, remainingTicks: 100 }]);
    // The rebuilt kit is live: it keeps ticking and routes input.
    restored.fixedStep({ ...idle, lightPressed: true });
    expect(kitState(restored).log.at(-1)).toMatch(/^light:/);
  });

  it('drops kit state on a region reload and cancels the in-flight action on dodge', () => {
    KIT_FACTORIES.vesper = host => testKit(host);
    const b = bench('vesper', [[0, 2]]);
    b.step({ lightPressed: true });
    b.step({}, 14);
    b.step({ dodgePressed: true });
    expect(kitState(b.engine).log).toContain('cancel');
    b.engine.loadRegion({ regionId: 'greenwake', runId: 'reload', presentActorIds: [] });
    expect(kitState(b.engine).log).toEqual(['reset']);
  });
});

/** The test kit with a cancel window on J and a recording `onSharedSkill`. */
function windowKit(host: KitHost): HeroKit {
  const base = testKit(host);
  const log = () => host.kitState<TestKitState>(() => ({ updates: 0, hitStops: 0, shield: 10, dealt: 0, marked: [], log: [] })).log;
  return {
    ...base,
    startLight(step) {
      log().push(`light:${step}`);
      host.beginAction({ id: 'window-light', clip: 'test-light' as ActionId, totalTicks: 30, cancel: { fromTick: 4, into: ['heavy', 'ranged', 'dodge'] } });
      return true;
    },
    onSharedSkill(skill) { log().push(`shared:${skill}`); },
  };
}

describe('hero kit host fixes', () => {
  const original = { ...KIT_FACTORIES };
  beforeEach(() => { delete KIT_FACTORIES.vesper; delete KIT_FACTORIES.sakda; });
  afterEach(() => { delete KIT_FACTORIES.vesper; delete KIT_FACTORIES.sakda; Object.assign(KIT_FACTORIES, original); });
  const wall = (z: number) => ({ id: 'native:wall', kind: 'box' as const, from: vec(0, 1, z), halfExtents: vec(3, 2, 0.1), blocksMovement: true, blocksCamera: true });

  it('a cone strike hits an open target but not one behind a wall', () => {
    KIT_FACTORIES.vesper = host => testKit(host);
    const open = bench('vesper', [[0, 2]]);
    open.step({ lightPressed: true });
    expect(open.health(0)).toBeLessThan(1000);
    const walled = bench('vesper', [[0, 2]]);
    walled.engine.setSceneColliders([wall(1)]);
    walled.step({ lightPressed: true });
    expect(walled.health(0)).toBe(1000);
  });

  it('canStrike needs reach, a visible standing target and a clear line', () => {
    let host!: KitHost;
    KIT_FACTORIES.vesper = h => { host = h; return testKit(h); };
    const b = bench('vesper', [[0, 2]]);
    const target = b.state.actors[1]!, from = b.state.actors[0]!.position;
    expect(host.canStrike(target, from, 3)).toBe(true);
    expect(host.canStrike(target, from, 0.1)).toBe(false);
    target.downed = true;
    expect(host.canStrike(target, from, 3)).toBe(false);
    target.downed = false; target.visible = false;
    expect(host.canStrike(target, from, 3)).toBe(false);
    target.visible = true;
    b.engine.setSceneColliders([wall(1)]);
    expect(host.canStrike(target, from, 3)).toBe(false);
    expect(host.canStrike(target, vec(0, 0, 1.6), 3)).toBe(true);
  });

  it('an aerial sweep stops short under a low ceiling and the path check agrees', () => {
    let host!: KitHost;
    KIT_FACTORIES.vesper = h => { host = h; return testKit(h); };
    const b = bench('vesper');
    const from = vec(0, 0.4, 0), to = vec(0, 1.6, 3);
    expect(host.isAerialPathClear(from, to)).toBe(true);
    const free = host.moveAerial(from, vec(to.x - from.x, to.y - from.y, to.z - from.z));
    expect(free.z).toBeCloseTo(3, 1);
    b.engine.setSceneColliders([{ id: 'native:ceiling', kind: 'box', from: vec(0, 2.4, 2), halfExtents: vec(3, 0.3, 3), blocksMovement: true, blocksCamera: true }]);
    expect(host.isAerialPathClear(from, to)).toBe(false);
    const blocked = host.moveAerial(from, vec(to.x - from.x, to.y - from.y, to.z - from.z));
    expect(Math.hypot(blocked.y - free.y, blocked.z - free.z)).toBeGreaterThan(0.1);
  });

  it('the aerial path check accepts a plain ground-level leap and arc, and rejects only a path that dips into the floor', () => {
    let host!: KitHost;
    KIT_FACTORIES.vesper = h => { host = h; return testKit(h); };
    bench('vesper');
    const ground = host.player.position;
    expect(host.isAerialPathClear(ground, vec(ground.x, ground.y, ground.z + 4))).toBe(true);
    const arc = (t: number) => vec(ground.x, ground.y + Math.sin(Math.PI * t) * 1.2, ground.z + 4 * t);
    let previous = ground;
    for (let i = 1; i <= 20; i++) { expect(host.isAerialPathClear(previous, arc(i / 20))).toBe(true); previous = arc(i / 20); }
    expect(host.isAerialPathClear(ground, vec(ground.x, ground.y - 0.2, ground.z + 4))).toBe(false);
  });

  it('routes K, L and F inside the cancel window during recovery, but not before it or for unlisted inputs', () => {
    KIT_FACTORIES.vesper = host => windowKit(host);
    const press = (patch: Partial<CombatInput>, idleTicks: number) => {
      const b = bench('vesper');
      b.step({ lightPressed: true });
      b.step({}, idleTicks);
      b.step(patch);
      return b;
    };
    expect(actions(press({ heavyPressed: true }, 1).engine)).toEqual(['light:1']);
    expect(actions(press({ heavyPressed: true }, 6).engine)).toEqual(['light:1', 'heavy:false']);
    expect(actions(press({ rangedPressed: true }, 6).engine)).toEqual(['light:1', 'ranged:false']);
    expect(actions(press({ lightPressed: true }, 6).engine)).toEqual(['light:1']);
    const dodged = press({ dodgePressed: true }, 6);
    expect(actions(dodged.engine)).toEqual(['light:1', 'dodge:10', 'shared:dodge']);
    expect(kitState(dodged.engine).log).toContain('cancel');
    expect(dodged.state.actors[0]!.actionId).not.toBe('test-light');
    expect(dodged.state.actionId).not.toBe('window-light');
  });

  it('a Guard-Dash-style dodge window lets a K tap start the heavy over the dodge clip, but not before the window opens', () => {
    KIT_FACTORIES.vesper = host => {
      const base = windowKit(host);
      return { ...base, dodge: { ...base.dodge!, durationTicks: 10, recoveryTicks: 15, cancel: { fromTick: 10, into: ['heavy', 'ranged', 'dodge'] } } };
    };
    const press = (idleTicks: number, patch: Partial<CombatInput>) => {
      const b = bench('vesper');
      b.state.player.mana = 100;
      b.step({ dodgePressed: true });
      b.step({}, idleTicks);
      b.step(patch);
      return b;
    };
    expect(actions(press(3, { heavyPressed: true }).engine)).toEqual(['dodge:10', 'shared:dodge']);
    const open = press(10, { heavyPressed: true });
    expect(actions(open.engine)).toEqual(['dodge:10', 'shared:dodge', 'heavy:false']);
    expect(open.state.actionId).toBe('test-heavy');
    expect(open.state.actors[0]!.actionId).toBe('test-heavy');
  });

  it('dispatches only the listed inputs when an unlisted button is pressed alongside a routed one', () => {
    KIT_FACTORIES.vesper = host => windowKit(host);
    const press = (patch: Partial<CombatInput>) => {
      const b = bench('vesper');
      b.state.player.mana = 100;
      b.state.player.instinct = 100;
      b.step({ lightPressed: true });
      b.step({}, 6);
      b.step(patch);
      return b;
    };
    const withUltimate = press({ heavyPressed: true, ultimatePressed: true });
    expect(actions(withUltimate.engine)).toEqual(['light:1', 'heavy:false']);
    expect(withUltimate.state.player.instinct).toBe(100);
    const withJump = press({ heavyPressed: true, jumpPressed: true });
    expect(actions(withJump.engine)).toEqual(['light:1', 'heavy:false']);
    expect(withJump.state.playerJump).toBeUndefined();
    const withTether = press({ dodgePressed: true, tetherPressed: true, ferocityPressed: true });
    expect(actions(withTether.engine)).toEqual(['light:1', 'dodge:10', 'shared:dodge']);
    // An unlisted-only press never opens the window.
    expect(actions(press({ ultimatePressed: true }).engine)).toEqual(['light:1']);
    expect(actions(press({ jumpPressed: true }).engine)).toEqual(['light:1']);
  });

  it('a cancel-window input that starts nothing leaves the action running', () => {
    KIT_FACTORIES.vesper = host => windowKit(host);
    const b = bench('vesper');
    b.state.player.mana = 0;
    b.step({ lightPressed: true });
    b.step({}, 6);
    const until = b.state.actionRecoveryUntil, clip = b.state.actors[0]!.actionId;
    b.step({ heavyPressed: true });
    expect(actions(b.engine)).toEqual(['light:1']);
    expect(b.state.actionRecoveryUntil).toBe(until);
    expect(b.state.actors[0]!.actionId).toBe(clip);
    expect(b.state.kitCancel).toBeDefined();
  });

  it('a kit dodge keeps the shared dodge id and emits the hero clip on its blink cue', () => {
    KIT_FACTORIES.vesper = host => testKit(host);
    const b = bench('vesper');
    b.step({ dodgePressed: true });
    expect(b.state.actors[0]!.actionId).not.toBe('test-dodge');
    expect(b.cues.filter(cue => cue.kind === 'blink')).toHaveLength(1);
    expect(b.cues.find(cue => cue.kind === 'blink')).toMatchObject({ element: 'umbral', actionId: 'test-dodge', durationTicks: 10 });
    expect(b.cues.find(cue => cue.kind === 'blink')!.from).toBeDefined();
    expect(b.cues.find(cue => cue.kind === 'blink')!.to).toBeDefined();
  });

  it('tells the kit when Jump, Cleanse and Dodge are accepted', () => {
    KIT_FACTORIES.vesper = host => windowKit(host);
    const jumped = bench('vesper');
    jumped.step({ jumpPressed: true });
    expect(kitState(jumped.engine).log).toContain('shared:jump');
    const cleansed = bench('vesper', [[0, 2]]);
    cleansed.state.actors[1]!.corruption = 5;
    cleansed.state.targetId = 'target-0' as ActorId;
    cleansed.step({ cleansePressed: true });
    expect(kitState(cleansed.engine).log).toContain('shared:cleanse');
    const dodged = bench('vesper');
    dodged.step({ dodgePressed: true });
    expect(kitState(dodged.engine).log).toContain('shared:dodge');
  });

  it('a long kit dodge never ends or passes through an unsupported capsule pose on real trial regions', () => {
    KIT_FACTORIES.vesper = host => ({ ...testKit(host), dodge: { clip: 'test-dodge' as ActionId, distance: 6.5, durationTicks: 12, iframes: 14, recoveryTicks: 12, blinkCue: true } });
    const directions = ['forward', 'back', 'left', 'right', 'back-left'] as const;
    let tried = 0, shortened = 0;
    for (const regionId of ['greenwake', 'canopy']) {
      const definition = REGIONS.find(candidate => candidate.id === regionId);
      if (!definition) continue;
      const region = createCombatTrialRegion(definition);
      const base = new CombatEngine();
      base.loadRegion({ regionId, regionDefinition: region, runId: 'dodge-' + regionId, presentActorIds: [] });
      const seed = base.snapshotState();
      const { min, max } = seed.arena.bounds;
      const probe = new CombatEngine(structuredClone(seed));
      for (let x = min.x + 0.5; x < max.x; x += 4) for (let z = min.z + 0.5; z < max.z; z += 4) {
        const origin = probe.snapshotState().actors.find(actor => actor.id === seed.playerId)!;
        const y = groundHeightAt(seed.arena, x, z, origin.position.y);
        if (y === null || !isSupportedCapsulePose(seed.arena, vec(x, y, z), 0.42, origin.collisionHeight)) continue;
        for (const dodgeDirection of directions) {
          const state = structuredClone(seed);
          const player = state.actors.find(actor => actor.id === state.playerId)!;
          player.position = vec(x, y, z);
          const engine = new CombatEngine(state);
          engine.setPlayerHero('vesper');
          liveState(engine).player.mana = 100;
          tried++;
          engine.fixedStep({ ...idle, dodgePressed: true, dodgeDirection });
          for (let tick = 0; tick < 12; tick++) {
            const live = liveState(engine).actors.find(actor => actor.id === state.playerId)!;
            expect(isSupportedCapsulePose(liveState(engine).arena, live.position, 0.42, live.collisionHeight)).toBe(true);
            engine.fixedStep(idle);
          }
          const end = liveState(engine).actors.find(actor => actor.id === state.playerId)!;
          if (Math.hypot(end.position.x - x, end.position.z - z) < 6.4) shortened++;
        }
      }
    }
    expect(tried).toBeGreaterThan(20);
    expect(shortened).toBeGreaterThan(0);
  });

  it('an untargetable player is not acquired by the live trial AI', () => {
    const playtest = ASSET_PLAYTESTS.find(candidate => candidate.regionId === 'greenwake')!;
    const run = (untargetable: boolean) => {
      const region = createCombatTrialRegion(REGIONS.find(candidate => candidate.id === playtest.regionId)!);
      const engine = new CombatEngine();
      engine.loadRegion({ regionId: playtest.regionId, regionDefinition: region, runId: 'untargetable', presentActorIds: playtest.trialSet.trials.map(trial => trial.monsterId) });
      engine.startEncounter({ encounterId: playtest.trialSet.encounterId, regionId: playtest.regionId, runId: 'untargetable' });
      engine.enableCombatTrials();
      const seed = engine.snapshotState();
      const source = seed.actors.find(actor => actor.id === playtest.trialSet.trials[0]!.monsterId)!;
      const player = seed.actors.find(actor => actor.id === seed.playerId)!;
      player.position = vec(source.position.x, source.position.y, source.position.z + 3);
      seed.player.vitality = seed.player.maxVitality = 10_000;
      if (untargetable) seed.untargetableUntil = 1_000_000;
      const live = new CombatEngine(seed);
      let attacks = 0;
      for (let tick = 0; tick < 900; tick++) { live.fixedStep(idle); attacks = Math.max(attacks, live.snapshotState().hazards.length + live.snapshotState().telegraphs.length); }
      return attacks;
    };
    expect(run(false)).toBeGreaterThan(0);
    expect(run(true)).toBe(0);
  });
});

describe('hero definitions', () => {
  it('declare presentation fields for the kit and renderer', () => {
    expect(Object.fromEntries(HEROES.map(hero => [hero.id, [hero.style, hero.weaponGrip, hero.dodgeVanish, hero.dodgeLabel]]))).toEqual({
      aren: ['warden', 'glaive', false, 'DIVE'],
      yara: ['heartroot', 'staff', true, 'PETAL STEP'],
      vesper: ['umbral', 'katana', true, 'MIST BLINK'],
      sakda: ['ember', undefined, false, 'GUARD DASH'],
    });
    expect(HEROES.find(hero => hero.id === 'sakda')!.weaponAssetId).toBeUndefined();
    for (const hero of HEROES) {
      expect(hero.ratings.length).toBe(5);
      expect(hero.biography).toHaveLength(2);
      expect(hero.skills.every(skill => skill.previewActionIds.length > 0)).toBe(true);
    }
  });
});
