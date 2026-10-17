import { describe, expect, it } from 'bun:test';
import { REGIONS } from '../../src/content/campaign.js';
import { ACTORS } from '../../src/content/world.js';
import { ATTACKS, WILDLIFE_ENCOUNTERS } from '../../src/game/combat/content.js';
import { CombatEngine, type CombatEvent, type CombatInput, type EngineState } from '../../src/game/combat/CombatEngine.js';
import { COMBAT_TRIAL_SETS, combatTrialSetFor } from '../../src/game/combat/CombatTrials.js';
import { GROVE_ACTORS, GROVE_ATTACKS, GROVE_COMBAT_TRIALS, GROVE_ENCOUNTERS, GROVE_MONSTER_PROFILES, GROVE_OWNER_GLOW, GROVE_SOLID_PROFILES, GROVE_TRIAL_SET } from '../../src/game/combat/GroveContent.js';
import { createCombatTrialRegion } from '../../src/game/combat/TrialRegions.js';
import { MONSTER_PROFILES, ROAR_TICKS } from '../../src/game/combat/WildlifePressure.js';
import { vec } from '../../src/game/combat/geometry.js';
import type { RegionDefinition, Vec3 } from '../../src/game/contracts.js';

const region: RegionDefinition = createCombatTrialRegion(REGIONS.find(candidate => candidate.id === 'the-grove')!);
const trial = GROVE_COMBAT_TRIALS[0]!;
const idle: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
const dist = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

describe('Grove practice set and encounter', () => {
  it('selects the set of the loaded region and registers the grove-defence wildlife encounter with the three defenders in trial order', () => {
    expect(combatTrialSetFor('the-grove')).toMatchObject({ regionId: 'the-grove', encounterId: 'grove-defence', clearedTitle: 'Sanctuary defended' });
    expect(combatTrialSetFor('the-grove')).toBe(GROVE_TRIAL_SET);
    expect(combatTrialSetFor('the-grove')!.trials).toBe(GROVE_COMBAT_TRIALS);
    expect(COMBAT_TRIAL_SETS).toContain(GROVE_TRIAL_SET);
    const encounter = WILDLIFE_ENCOUNTERS['grove-defence']!;
    expect(encounter).toBe(GROVE_ENCOUNTERS['grove-defence']!);
    expect(encounter).toMatchObject({ id: 'grove-defence', regionId: 'the-grove', bossId: 'grove-sprig', encounterFamily: 'wildlife', largeActors: ['grove-hollowheart'] });
    expect(encounter.actorIds).toEqual(['aren', 'grove-sprig', 'grove-blighted', 'grove-hollowheart']);
    expect(encounter.actorIds).not.toContain('grove-koro');
    expect(encounter.phases).toEqual([
      { id: 'evasion-practice', attackIds: ['sprig-seed-toss', 'sprig-ground-ripple', 'sprig-petal-sweep'] },
      { id: 'sap-incursion', attackIds: ['blighted-seed-lob', 'blighted-ground-pulse', 'blighted-lash-sweep'] },
      { id: 'memory-pool', attackIds: ['hollowheart-leap-smash', 'hollowheart-antler-sweep', 'hollowheart-ichor-hurl', 'hollowheart-heartlight-burst'] },
    ]);
    expect(encounter.playerOnlyCounters).toEqual(['player-dodge', 'player-tether', 'player-cleanse', 'player-light']);
    // The generic invariants every set holds.
    for (const set of COMBAT_TRIAL_SETS) {
      const wildlife = WILDLIFE_ENCOUNTERS[set.encounterId]!;
      expect(wildlife.regionId).toBe(set.regionId);
      expect(wildlife.actorIds.filter(id => id !== 'aren')).toEqual(set.trials.map(entry => entry.monsterId));
      expect(new Set(set.trials.map(entry => entry.gate.id)).size).toBe(set.trials.length);
      for (const entry of set.trials) {
        expect(MONSTER_PROFILES[entry.monsterId]).toBeDefined();
        for (const id of entry.attackIds) expect(ATTACKS[id]!.bossId).toBe(entry.monsterId);
      }
    }
  });


  it('defines grove-sprig (wild, hostile, rootling) and grove-koro (ally, noncombat macaque leader) in the world actors', () => {
    expect(ACTORS['grove-sprig']).toBe(GROVE_ACTORS['grove-sprig']!);
    expect(ACTORS['grove-koro']).toBe(GROVE_ACTORS['grove-koro']!);
    expect(ACTORS['grove-sprig']).toEqual({ id: 'grove-sprig', species: 'rootling', role: 'wild', allegiance: 'wild', combatRole: 'hostile', assetId: 'actor-grove-rootling' });
    expect(ACTORS['grove-koro']).toEqual({ id: 'grove-koro', species: 'macaque', role: 'leader', allegiance: 'ally', combatRole: 'noncombat', assetId: 'actor-koro' });
    // The blighted rootling and the guardian are wild hostiles on their own native assets.
    expect(ACTORS['grove-blighted']).toEqual({ id: 'grove-blighted', species: 'rootling', role: 'wild', allegiance: 'wild', combatRole: 'hostile', assetId: 'actor-grove-blighted-rootling' });
    expect(ACTORS['grove-hollowheart']).toEqual({ id: 'grove-hollowheart', species: 'rootling', role: 'wild', allegiance: 'wild', combatRole: 'hostile', assetId: 'actor-grove-hollowheart' });
    // The story companion keeps its own definition.
    expect(ACTORS.koro!.combatRole).toBe('companion');
    expect(GROVE_OWNER_GLOW).toEqual({ 'grove-sprig': 'sap', 'grove-blighted': 'poison', 'grove-hollowheart': 'sap' });
    expect(GROVE_SOLID_PROFILES).toEqual({ 'prop-refuge-shelter': 'solid', 'prop-water-basin': 'solid', 'prop-training-post': 'trunk', 'prop-grove-platform': 'platform' });
  });

  it('refuses to enable trials outside the playtest region encounter', () => {
    const engine = new CombatEngine();
    engine.loadRegion({ regionId: 'the-grove', regionDefinition: region, runId: 'no-encounter', presentActorIds: [] });
    expect(() => engine.enableCombatTrials()).toThrow();
  });
});

interface ExpectedAttack {
  readonly kind: string; readonly width: number; readonly depth: number; readonly radius: number; readonly height: number; readonly damage: number;
  readonly timing: readonly [number, number, number, number]; readonly lane?: boolean;
}
/** The three gentle practice attacks: id -> shape, timing and movement (docs/features/grove-playtest.md). */
const CONTRACT: Readonly<Record<string, ExpectedAttack>> = {
  'sprig-seed-toss': { kind: 'strike', width: 1.6, depth: 1.6, radius: 1.6, height: 0.2, damage: 4, timing: [66, 14, 10, 54] },
  'sprig-ground-ripple': { kind: 'wave', width: 5, depth: 1.2, radius: 0, height: 0.18, damage: 5, timing: [60, 14, 14, 56] },
  'sprig-petal-sweep': { kind: 'sweep', width: 2.4, depth: 6.5, radius: 0, height: 0.8, damage: 6, timing: [66, 14, 12, 54], lane: true },
};

describe('grove practice attack definitions', () => {
  it('registers exactly the three sprig attacks, gentle (4 to 6 damage), non-elemental, with no obstacle trap words', () => {
    expect(Object.keys(GROVE_ATTACKS).filter(id => id.startsWith('sprig-')).sort()).toEqual(Object.keys(CONTRACT).sort());
    for (const id of Object.keys(CONTRACT)) {
      expect(ATTACKS[id]).toBe(GROVE_ATTACKS[id]!);
      const attack = ATTACKS[id]!;
      expect(attack.damage ?? attack.hazard.damage).toBeGreaterThanOrEqual(4);
      expect(attack.hazard.damage).toBeLessThanOrEqual(6);
      // No elemental routing (ice pillars, the player-only heartroot look) and none of the CombatEngine obstacle words.
      expect(attack.element).toBeUndefined();
      expect(id).not.toMatch(/root|sap|stomp|march|seismic|trample|thorn|charge/);
      expect(id.startsWith('sprig-')).toBe(true);
      expect(attack.lunge).toBeUndefined();
      expect(attack.onHit).toBeUndefined();
      // Practice-flavoured cues in plain English with the counterplay stated.
      expect(attack.cue.length).toBeGreaterThan(40);
      expect(attack.cue).toMatch(/Aren|Sidestep|Step|Jump/);
    }
  });

  for (const [id, want] of Object.entries(CONTRACT)) {
    it(`${id} matches its contract shape and timing`, () => {
      const attack = ATTACKS[id]!;
      expect(attack.bossId).toBe('grove-sprig');
      expect(attack.hazard).toMatchObject({ kind: want.kind, width: want.width, depth: want.depth, radius: want.radius, heightAboveGround: want.height, damage: want.damage });
      expect([attack.windupTicks, attack.commitTicks, attack.activeTicks, attack.recoveryTicks]).toEqual([...want.timing]);
      expect(attack.laneFromSource ?? false).toBe(want.lane ?? false);
      // Long, readable windups: gentler than every canopy attack.
      expect(attack.windupTicks).toBeGreaterThanOrEqual(60);
    });
  }
});

/** The real Grove variant loaded the way the playtest loads it, with an effectively unkillable Aren and world-space movement. */
function groveEngine(options: { player?: Vec3; cursor?: number; mutate?: (seed: EngineState) => void } = {}): CombatEngine {
  const engine = new CombatEngine();
  engine.loadRegion({ regionId: 'the-grove', regionDefinition: region, runId: 'grove-practice', presentActorIds: region.entities.map(entity => entity.id) });
  engine.startEncounter({ encounterId: 'grove-defence', regionId: 'the-grove', runId: 'grove-practice' });
  engine.enableCombatTrials();
  const seed = engine.snapshotState();
  seed.player.vitality = seed.player.maxVitality = 1e6;
  seed.arena.cameraBasis = { forward: vec(0, 0, 1), right: vec(1, 0, 0) };
  const toCenter = { x: trial.arena.center.x - trial.monsterPosition.x, z: trial.arena.center.z - trial.monsterPosition.z }, length = Math.hypot(toCenter.x, toCenter.z);
  const player = seed.actors.find(actor => actor.id === 'aren')!;
  player.position = options.player ?? vec(trial.monsterPosition.x + toCenter.x / length * 5.5, 0, trial.monsterPosition.z + toCenter.z / length * 5.5);
  if (options.cursor !== undefined) seed.wildlifeCombat = { engagedTicks: 0, sourceCursor: 0, attackCursors: { [trial.monsterId]: options.cursor } };
  options.mutate?.(seed);
  return new CombatEngine(seed);
}
const monsterOf = (engine: CombatEngine) => engine.snapshot().actors.find(actor => actor.id === 'grove-sprig')!;
const playerOf = (engine: CombatEngine) => engine.snapshot().actors.find(actor => actor.id === 'aren')!;
const castCues = (events: readonly CombatEvent[], attackId: string) => events.filter(event => event.kind === 'cue' && event.attackId === attackId);

/** Steps until the monster begins `attackId`, as its first authored cast (the rotation cursor starts on it). */
function probeCast(attackId: string, player?: Vec3) {
  const engine = groveEngine({ player, cursor: trial.attackIds.indexOf(attackId) });
  for (let tick = 0; tick < 700; tick++) {
    engine.fixedStep(idle);
    if (castCues(engine.consumeEvents(), attackId).length) {
      const state = engine.snapshotState();
      return { engine, state, hazard: state.hazards.find(hazard => hazard.attackId === attackId)!, monster: state.actors.find(actor => actor.id === 'grove-sprig')! };
    }
  }
  throw new Error('no ' + attackId + ' cast');
}

describe('grove practice attacks at runtime', () => {
  for (const [id, want] of Object.entries(CONTRACT)) {
    it(`${id}: aims the live attack at the locked player position with readable phase boundaries`, () => {
      const { hazard, state } = probeCast(id);
      expect(hazard.windupUntil! - hazard.startTick).toBeGreaterThanOrEqual(36);
      expect(hazard.activeFrom - hazard.windupUntil!).toBeGreaterThanOrEqual(12);
      const player = state.actors.find(actor => actor.id === 'aren')!;
      if (want.lane) {
        // Lanes start at the caster and reach past the aimed position; they are centred half a lane ahead of the body.
        expect(hazard.depth).toBeGreaterThanOrEqual(want.depth);
        expect(hazard.depth).toBeLessThanOrEqual(want.depth + 2);
        expect(dist(hazard.origin, hazard.target)).toBeCloseTo(hazard.depth / 2, 6);
        expect(dist(hazard.origin, player.position)).toBeLessThanOrEqual(hazard.depth);
      } else {
        // Everything else is locked onto where Aren stood when the cast began.
        expect(hazard.target.x).toBeCloseTo(player.position.x, 6);
        expect(hazard.target.z).toBeCloseTo(player.position.z, 6);
      }
    });
  }

  it('the practice casts never lunge the sprig, never push Aren and never spawn combat obstacles', () => {
    for (const id of Object.keys(CONTRACT)) {
      const { engine, monster } = probeCast(id);
      expect(monster.motion?.lunge).toBeUndefined();
      for (let tick = 0; tick < 320; tick++) { engine.fixedStep(idle); engine.consumeEvents(); }
      expect(engine.snapshotState().combatObstacles).toEqual([]);
    }
  });

  it('a ground ripple that connects deals 5 damage', () => {
    const engine = groveEngine({ cursor: 1, mutate: seed => { seed.player.vitality = seed.player.maxVitality = 100; } });
    let hit: CombatEvent | undefined;
    for (let tick = 0; tick < 600 && !hit; tick++) {
      engine.fixedStep(idle);
      hit = engine.consumeEvents().find(event => event.kind === 'damage' && event.attackId === 'sprig-ground-ripple');
    }
    expect(hit?.damage?.amount).toBe(5);
  });

  it('non-elemental practice attacks use the generic attack-keyed presentation cues', () => {
    for (const id of Object.keys(CONTRACT)) {
      const engine = groveEngine({ cursor: trial.attackIds.indexOf(id) });
      const cues: { kind: string; attackId?: string; element?: string }[] = [];
      for (let tick = 0; tick < 500 && !cues.some(cue => cue.kind === 'active' && cue.attackId === id); tick++) {
        engine.fixedStep(idle); engine.consumeEvents();
        cues.push(...engine.drainPresentationCues());
      }
      const active = cues.find(cue => cue.kind === 'active' && cue.attackId === id)!;
      expect(active).toBeDefined();
      expect(active.element).toBeUndefined();
      expect(cues.some(cue => cue.kind === 'anticipation' && cue.attackId === id)).toBe(true);
    }
  });
});

describe('grove practice monster', () => {
  it('stays inside its arena and cycles its authored roster in order', () => {
    const engine = groveEngine();
    const casts: string[] = [];
    for (let tick = 0; tick < 3000; tick++) {
      engine.fixedStep(idle);
      for (const event of engine.consumeEvents()) if (event.kind === 'cue' && event.actorId === trial.monsterId && event.attackId) casts.push(event.attackId);
      engine.drainPresentationCues();
      const monster = monsterOf(engine);
      expect(dist(monster.position, trial.arena.center)).toBeLessThanOrEqual(trial.arena.radius);
      expect(monster.position.y).toBe(trial.arena.center.y);
    }
    expect(casts.length).toBeGreaterThanOrEqual(6);
    const roster = [...trial.attackIds];
    expect(casts.slice(0, 6)).toEqual([...roster, ...roster]);
    for (let at = 0; at < casts.length; at++) expect(casts[at]).toBe(roster[at % roster.length]!);
  });

  it('roars on engage from beyond its band and once more when pressure escalates', () => {
    const profile = MONSTER_PROFILES[trial.monsterId]!;
    const toCenter = { x: trial.arena.center.x - trial.monsterPosition.x, z: trial.arena.center.z - trial.monsterPosition.z }, length = Math.hypot(toCenter.x, toCenter.z);
    const far = (range: number) => vec(trial.monsterPosition.x + toCenter.x / length * range, 0, trial.monsterPosition.z + toCenter.z / length * range);
    const engage = groveEngine({ player: far(profile.bandMax + 2) });
    let roars = 0, damage = 0;
    for (let tick = 0; tick < ROAR_TICKS - 2; tick++) {
      engage.fixedStep(idle);
      damage += engage.consumeEvents().filter(event => event.kind === 'damage').length;
      roars += engage.drainPresentationCues().filter(cue => cue.kind === 'roar-cone' && cue.actorId === trial.monsterId).length;
    }
    expect(roars).toBe(1);
    expect(damage).toBe(0);
    expect(monsterOf(engage).attackPhase).toBeUndefined();

    const escalate = new CombatEngine(groveEngine({ mutate: seed => { seed.wildlifeCombat = { engagedTicks: 898, sourceCursor: 0, attackCursors: {} }; seed.actors.find(actor => actor.id === trial.monsterId)!.recoveringUntil = 1e6; } }).snapshotState());
    const escalations = [];
    for (let tick = 0; tick < 200; tick++) {
      escalate.fixedStep(idle);
      escalations.push(...escalate.drainPresentationCues().filter(cue => cue.kind === 'roar-cone' && cue.actorId === trial.monsterId));
    }
    expect(escalations).toHaveLength(1);
  });

  it('does not engage a player who stays on the required route: spawn and exit are out of its range', () => {
    for (const point of [region.navigation.nodes[0]!.position, region.exits[0]!.from]) {
      const engine = groveEngine({ player: vec(point.x, 0, point.z) });
      let casts = 0;
      for (let tick = 0; tick < 900; tick++) {
        engine.fixedStep(idle);
        casts += engine.consumeEvents().filter(event => event.kind === 'cue' && event.actorId === trial.monsterId).length;
        engine.drainPresentationCues();
      }
      expect(casts).toBe(0);
      expect(engine.snapshot().encounterStatus!.trial).toMatchObject({ status: 'approach', complete: false });
    }
  });
});

describe('grove practice route geometry', () => {
  it('walks through the opened first gate into the blighted hollow, which the closed gate refused', () => {
    // Closed: a run north from the ring stops at the gate.
    const closed = groveEngine({ player: vec(-24, 0, -32), mutate: seed => { seed.actors.find(actor => actor.id === 'grove-sprig')!.visible = false; } });
    for (let tick = 0; tick < 240; tick++) { closed.fixedStep({ ...idle, move: vec(0, 0, -1), sprintHeld: true }); closed.consumeEvents(); closed.drainPresentationCues(); }
    expect(playerOf(closed).position.z).toBeGreaterThan(-37.4);
    // Open: the practice is defeated (the gate collider is gone) and the same run reaches the hollow.
    const seed = closed.snapshotState();
    seed.combatTrial!.index = 1;
    seed.combatTrial!.status = 'open';
    seed.actors.find(actor => actor.id === 'grove-sprig')!.allegiance = 'neutral';
    const opened = new CombatEngine(seed);
    opened.fixedStep(idle);
    for (let tick = 0; tick < 300; tick++) { opened.fixedStep({ ...idle, move: vec(0, 0, -1), sprintHeld: true }); opened.consumeEvents(); opened.drainPresentationCues(); }
    expect(playerOf(opened).position.z).toBeLessThan(-46);
    expect(opened.snapshot().trialGates!.map(gate => gate.open)).toEqual([true, false, false]);
  });

  it('walks the camp road from the spawn to the practice ring without ever engaging the sprig, whose range ends 14 m from it', () => {
    const engine = groveEngine({ player: region.navigation.nodes[0]!.position });
    const route = region.navigation.ribbons.find(ribbon => ribbon.id === 'grove-trial-main-route')!.points;
    const goal = route[route.length - 2]!;
    let waypoint = 1, ticks = 0, casts = 0;
    for (; ticks < 4000; ticks++) {
      const player = playerOf(engine).position;
      if (dist(player, goal) < 1.5) break;
      const target = route[waypoint]!, dx = target.x - player.x, dz = target.z - player.z, distance = Math.hypot(dx, dz);
      if (distance < 0.6 && waypoint < route.length - 1) waypoint++;
      engine.fixedStep({ ...idle, move: vec(dx / (distance || 1), 0, dz / (distance || 1)), sprintHeld: true });
      casts += engine.consumeEvents().filter(event => event.kind === 'cue' && event.actorId === trial.monsterId).length;
      engine.drainPresentationCues();
    }
    expect(dist(playerOf(engine).position, goal)).toBeLessThan(1.5);
    expect(ticks).toBeLessThan(3000);
    expect(casts).toBe(0);
    expect(engine.snapshot().trialGates!.map(gate => gate.open)).toEqual([false, false, false]);
    expect(engine.snapshot().encounterStatus!.trial).toMatchObject({ stage: 1, totalStages: 3, complete: false });
    expect(engine.snapshot().player.vitality).toBe(engine.snapshot().player.maxVitality);
  }, 60000);
});
