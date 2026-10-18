import { describe, expect, it } from 'bun:test';
import { REGIONS } from '../../src/content/campaign.js';
import { solidPropKind, supportKind } from '../../src/content/solid-props.js';
import { CombatEngine, createEngineState, makeActor, type CombatInput, type EngineState, type LiveHazard } from '../../src/game/combat/CombatEngine.js';
import { ATTACKS } from '../../src/game/combat/content.js';
import { createEnvironment, environmentDisk, impactEnvironment, stepEnvironment } from '../../src/game/combat/EnvironmentProps.js';
import { SIGIL, THUNDER_CLEAVE } from '../../src/game/combat/PlayerSkills.js';
import type { HeroId } from '../../src/game/heroes.js';
import type { RegionDefinition, WorldAssetPlacement } from '../../src/game/contracts.js';

const idle: CombatInput = { tick: 0, move: { x: 0, y: 0, z: 0 }, dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
const stone: WorldAssetPlacement = { id: 'environment-loose-test', assetId: 'prop-mire-bank-rock', position: { x: 0, y: 0, z: -1.5 }, rotationY: 0, scale: { x: .12, y: .12, z: .12 }, placement: 'ground' };
const tree: WorldAssetPlacement = { ...stone, id: 'test-tree', assetId: 'prop-erya-edge-tree', scale: { x: 1, y: 1, z: 1 } };
const fern: WorldAssetPlacement = { ...tree, id: 'test-fern', assetId: 'prop-canopy-fern-cluster' };
const house: WorldAssetPlacement = { ...tree, id: 'test-house', assetId: 'prop-greenwake-houses' };
const crate: WorldAssetPlacement = { ...tree, id: 'environment-loose-crate-test', assetId: 'prop-wooden-crate-stack' };
function regionWith(props: readonly WorldAssetPlacement[]): RegionDefinition { return { ...REGIONS[0]!, props, movableObjects: [], deliveries: [] }; }
function fixture(props: readonly WorldAssetPlacement[] = [stone], hero: HeroId = 'aren', target = false) {
  const seed = createEngineState();
  seed.environment = createEnvironment(regionWith(props), new Set());
  if (target) {
    const enemy = makeActor('corrupted-boar', 'boar', 'hostile', { x: 0, y: 0, z: -1.8 }, false, false, 1000);
    enemy.ferocity = undefined;
    seed.actors.push(enemy); seed.targetId = enemy.id;
  }
  const engine = new CombatEngine(seed);
  engine.setPlayerHero(hero);
  const state = (engine as unknown as { state: EngineState }).state;
  const cues: string[] = [];
  function step(input: Partial<CombatInput> = {}, count = 1) {
    for (let i = 0; i < count; i++) { engine.fixedStep({ ...idle, ...input }); cues.push(...engine.drainPresentationCues().map(cue => cue.kind)); }
  }
  function charge() {
    step({ heavyPressed: true, heavyHeld: true }); step({ heavyHeld: true }, THUNDER_CLEAVE.holdTicks);
    step({ heavyReleased: true, heavyHeldTicks: THUNDER_CLEAVE.holdTicks });
  }
  return { engine, state, step, charge, cues };
}

describe('skill-owned environmental force', () => {
  it('melee moves a loose native body and damages it only once across a sustained active window', () => {
    const f = fixture();
    f.step({ lightPressed: true }); f.step({}, 5);
    expect(f.engine.snapshot().environmentProps).toEqual([]);
    f.step({}, 90);
    const prop = f.state.environment.props[0]!;
    expect(prop.damage).toBeGreaterThan(0);
    expect(prop.position.z).toBeLessThan(stone.position.z - .1);
    expect(prop.position.y).toBe(0);
    expect(prop.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(prop.impactSerial).toBe(1);
    expect(f.engine.snapshot().events).toEqual([]);
  });

  it('real melee scuffs a house without moving or collapsing its solid, even under repeated overwhelming force', () => {
    const f = fixture([house]), prop = f.state.environment.props[0]!;
    f.engine.setSceneColliders([{ id: 'native:test-house:0', kind: 'box', from: { x: 0, y: 1, z: -1.5 }, halfExtents: { x: .35, y: 1, z: .35 }, blocksMovement: true, blocksCamera: true }]);
    const solids = structuredClone(f.state.arena.colliders);
    f.step({ lightPressed: true }); f.step({}, 90);
    expect(prop.damage).toBeGreaterThan(0);
    for (let index = 0; index < 30; index++) {
      expect(impactEnvironment(f.state.environment, f.state.arena, f.state.worldTick, `house-stress-${index}`, 1e6, { x: 0, y: 0, z: 0 }, () => true)).toBe(false);
      stepEnvironment(f.state.environment, f.state.arena, f.state.worldTick + index + 1, 1);
      expect(Math.abs(prop.tiltX) + Math.abs(prop.tiltZ)).toBeLessThan(.02);
    }
    expect(prop.damage).toBeLessThan(1);
    expect(prop.broken).toBe(false);
    expect(prop.position).toEqual(house.position);
    expect(f.state.arena.colliders).toEqual(solids);
    expect(f.engine.snapshot().events).toEqual([]);
  });

  it('melee pushes an upright native crate against a wall; pause freezes it, gravity settles it and a broken crate cannot be hit again', () => {
    const f = fixture([crate]), prop = f.state.environment.props[0]!;
    f.state.arena.colliders.push({ id: 'crate-wall', kind: 'box', from: { x: 0, y: 1, z: -2.7 }, halfExtents: { x: 3, y: 1, z: .005 }, blocksMovement: true, blocksCamera: true });
    f.step({ lightPressed: true });
    for (let tick = 0; tick < 80 && !prop.impactSerial; tick++) f.step();
    expect(prop.damage).toBeGreaterThan(0);
    expect(prop.position.z).toBeLessThan(crate.position.z);
    const airborne = structuredClone(prop.position);
    f.engine.setTimePolicy('paused'); f.step({}, 30);
    expect(prop.position).toEqual(airborne);
    f.engine.setTimePolicy('normal'); f.step({}, 180);
    expect(prop.position.y).toBe(0);
    expect(prop.position.z).toBeGreaterThan(-2.7 + .3);
    expect(prop.sleeping).toBe(true);
    expect([prop.tiltX, prop.tiltZ]).toEqual([0, 0]);
    expect(impactEnvironment(f.state.environment, f.state.arena, f.state.worldTick, 'crate-break', 1e6, prop.position, () => true)).toBe(true);
    expect(prop.broken).toBe(true);
    expect(prop.sleeping).toBe(true);
    expect(prop.velocity).toEqual({ x: 0, y: 0, z: 0 });
    const serial = prop.impactSerial;
    impactEnvironment(f.state.environment, f.state.arena, f.state.worldTick + 1, 'no-ghost-crate', 1e6, prop.position, () => true);
    expect(prop.impactSerial).toBe(serial);
    expect(f.engine.snapshot().events).toEqual([]);
  });

  it('Thunder Cleave keeps actor damage unchanged while props receive melee and delayed lightning separately', () => {
    const f = fixture([stone], 'aren', true), control = fixture([], 'aren', true);
    f.charge(); control.charge();
    expect(f.state.environment.props[0]!.impactSerial).toBe(0);
    for (let tick = 0; tick < 180 && !f.cues.includes('slash'); tick++) { f.step(); control.step(); }
    expect(f.state.environment.props[0]!.impactSerial).toBe(1);
    expect(f.state.actors[1]!.vitality).toBe(964);
    for (let tick = 0; tick < 100 && !f.cues.includes('lightning'); tick++) { f.step(); control.step(); }
    expect(f.state.environment.props[0]!.impactSerial).toBe(2);
    // Existing poise/stun multipliers still apply; adding prop damage must not change character resolution.
    expect(f.state.actors[1]!.vitality).toBe(control.state.actors[1]!.vitality);
    expect(f.state.actors[1]!.vitality).toBeLessThan(964);
    expect(f.state.environment.props[0]!.broken).toBe(true);
    expect(f.state.player.mana).toBe(80);
  });

  it('can intentionally strike a nearby object without a hostile, but still rejects an empty-air heavy', () => {
    const f = fixture();
    f.charge(); f.step({}, 160);
    expect(f.state.environment.props[0]!.damage).toBeGreaterThan(0);
    expect(f.state.player.mana).toBe(80);
    const empty = fixture([]);
    empty.charge(); empty.step({}, 160);
    expect(empty.state.player.mana).toBe(100);
    expect(empty.cues.includes('slash')).toBe(false);
  });

  for (const hero of ['yara', 'vesper', 'sakda'] as const) {
    it(`${hero}'s real offensive path reaches native vegetation without relying on presentation cues`, () => {
      const f = fixture([tree], hero);
      f.step({ lightPressed: true }); f.step({}, 120);
      expect(f.state.environment.props[0]!.damage).toBeGreaterThan(0);
      expect(f.state.environment.props[0]!.position).toEqual(tree.position);
    });
  }

  it('Sakda sustained limb/ring windows deduplicate independently while Hundred Elbows keeps its real pulses', () => {
    const ring = fixture([tree], 'sakda');
    ring.state.lightIndex = 3; ring.state.lightChainFrom = 0; ring.state.lightChainUntil = 100;
    ring.step({ lightPressed: true }); ring.step({}, 120);
    expect(ring.state.environment.props[0]!.impactSerial).toBe(2);
    const elbows = fixture([tree], 'sakda', true);
    elbows.step({ rangedPressed: true, rangedHeld: true });
    elbows.step({ rangedHeld: true }, SIGIL.barrageHoldTicks);
    elbows.step({ rangedReleased: true }); elbows.step({}, 240);
    expect(elbows.state.environment.props[0]!.impactSerial).toBe(7);
  });

  it('a confirmed companion strike affects nearby props but a rejected downed-target strike does not', () => {
    const accepted = fixture([stone], 'aren', true), rejected = fixture([stone], 'aren', true);
    rejected.state.actors[1]!.downed = true;
    for (const f of [accepted, rejected]) {
      f.state.pendingCompanionStrikes.push({ sourceId: 'vara', targetId: 'corrupted-boar', damage: 18, poise: 5, knockback: .4, dirX: 0, dirZ: -1, attackId: 'vara-storm-talon' });
      f.step();
    }
    expect(accepted.state.environment.props[0]!.damage).toBeGreaterThan(0);
    expect(rejected.state.environment.props[0]!.damage).toBe(0);
  });

  it('cosmetic cues and paused/replaced anticipation never damage props', () => {
    const f = fixture();
    f.engine.queuePresentationCue({ kind: 'lightning', phase: 'active', position: stone.position, intensity: 9 });
    f.step({ heavyPressed: true, heavyHeld: true }); f.step({ heavyHeld: true }, 10);
    f.engine.setTimePolicy('paused'); f.step({}, 120);
    expect(f.state.environment.props[0]!.impactSerial).toBe(0);
    f.engine.startNewRun('replacement'); f.step({}, 120);
    expect(f.engine.snapshot().environmentProps).toEqual([]);
  });

  it('freezes displaced bodies through real hit-stop and pause, then resumes them on the world clock', () => {
    const f = fixture([stone], 'aren', true);
    f.step({ lightPressed: true });
    for (let tick = 0; tick < 60 && !f.state.hitStop; tick++) f.step();
    expect(f.state.hitStop!.remainingTicks).toBeGreaterThan(0);
    const frozen = structuredClone(f.state.environment), worldTick = f.state.worldTick;
    f.step({}, f.state.hitStop!.remainingTicks);
    expect(f.state.environment).toEqual(frozen);
    expect(f.state.worldTick).toBe(worldTick);
    f.engine.setTimePolicy('paused'); f.step({}, 30);
    expect(f.state.environment).toEqual(frozen);
    f.engine.setTimePolicy('normal'); f.step();
    expect(f.state.environment.props[0]!.position.z).toBeLessThan(frozen.props[0]!.position.z);
    f.step({}, 40);
    expect(f.state.environment.props[0]!.impactSerial).toBe(1);
  });

  it('keeps exact physical damage/momentum through serialization without replaying a restored impact', () => {
    const f = fixture(); f.step({ lightPressed: true }); f.step({}, 18);
    const saved = f.engine.serialize(), restored = new CombatEngine(); restored.restore(saved);
    expect(restored.snapshot().environmentProps![0]!.impactWorldTick).toBe(-1);
    expect(restored.snapshotState().environment).toEqual(f.state.environment);
    for (let i = 0; i < 40; i++) { f.step(); restored.fixedStep(idle); }
    expect(restored.snapshotState().environment).toEqual(f.state.environment);
  });

  it('retry and region replacement restore local props without inventing durable world facts', () => {
    const f = fixture();
    f.engine.loadRegion({ regionId: 'greenwake', runId: 'environment', regionDefinition: regionWith([stone]), playerPosition: { x: 0, y: 0, z: 0 }, presentActorIds: [] });
    f.step({ lightPressed: true }); f.step({}, 60);
    expect(f.engine.snapshot().environmentProps!.some(prop => prop.damage > 0)).toBe(true);
    f.engine.resetToCheckpoint();
    expect(f.engine.snapshot().environmentProps).toEqual([]);
    expect(f.engine.snapshot().events).toEqual([]);
    f.engine.loadRegion({ regionId: 'greenwake', runId: 'environment', regionDefinition: regionWith([]), playerPosition: { x: 0, y: 0, z: 0 }, presentActorIds: [] });
    expect(f.engine.snapshotState().environment.props).toEqual([]);
  });

  it('only a genuinely active hostile hazard damages an object, once per hazard', () => {
    const f = fixture([tree]);
    const attack = ATTACKS['koro-fruit-burst']!;
    const hazard: LiveHazard = { ...structuredClone(attack.hazard), id: 'environment-hazard', attackId: attack.id, sourceId: 'koro', startTick: 0, activeFrom: 5, activeUntil: 40, target: tree.position, origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 }, hitIds: [], threatTicks: [], cue: 'Fruit burst', damage: 30 };
    f.state.hazards.push(hazard);
    f.step({}, 4); expect(f.state.environment.props[0]!.impactSerial).toBe(0);
    f.step({}, 20); expect(f.state.environment.props[0]!.impactSerial).toBe(1);
    expect(f.state.environment.props[0]!.damage).toBeGreaterThan(0);
  });

  it('a bolt hits the measured prop surface but expiry does not manufacture distant damage', () => {
    const f = fixture([tree]);
    f.engine.setSceneColliders([{ id: 'native:test-tree:0', kind: 'box', from: { x: 0, y: 1, z: -1.5 }, halfExtents: { x: .3, y: 1, z: .3 }, blocksMovement: true, blocksCamera: true }]);
    f.state.playerProjectiles.push({ id: 'real-bolt', kind: 'sigil-bolt', ownerId: 'aren', position: { x: 0, y: 1, z: 0 }, direction: { x: 0, y: 0, z: -1 }, speed: 12, radius: .12, ageTicks: 0, lifeTicks: 60, damage: 20, hitIds: [] });
    f.step({}, 30);
    expect(f.state.environment.props[0]!.impactSerial).toBe(1);
    expect(f.state.playerProjectiles).toEqual([]);
    const expired = fixture([{ ...tree, position: { x: 0, y: 0, z: -7 } }]);
    expired.state.playerProjectiles.push({ id: 'expiring-bolt', kind: 'sigil-bolt', ownerId: 'aren', position: { x: 0, y: 1, z: 0 }, direction: { x: 0, y: 0, z: -1 }, speed: 12, radius: .12, ageTicks: 0, lifeTicks: 1, damage: 20, hitIds: [] });
    expired.step({}, 60);
    expect(expired.state.environment.props[0]!.damage).toBe(0);
  });
});

describe('material, collision and traversal boundaries', () => {
  it('does not transfer area damage through a wall or between stacked floors', () => {
    const f = fixture([stone, { ...stone, id: 'environment-loose-high', position: { x: .3, y: 5, z: -.5 } }]);
    f.state.arena.colliders.push({ id: 'thin-wall', kind: 'box', from: { x: 0, y: 1, z: -.731 }, halfExtents: { x: 3, y: 1, z: .005 }, blocksMovement: true, blocksCamera: true });
    impactEnvironment(f.state.environment, f.state.arena, 1, 'disk', 40, { x: 0, y: 0, z: 0 }, prop => environmentDisk(prop, { x: 0, y: 0, z: 0 }, 3));
    expect(f.state.environment.props.map(prop => prop.damage)).toEqual([0, 0]);
  });

  it('never sleeps in mid-air at an exact apex and reaches a stable physical rest', () => {
    const f = fixture(), prop = f.state.environment.props[0]!;
    impactEnvironment(f.state.environment, f.state.arena, 1, 'apex', 12, prop.position, () => true);
    prop.position.y = .5;
    prop.velocity = { x: 0, y: 9.8 / 60, z: 0 };
    stepEnvironment(f.state.environment, f.state.arena, 2, 1);
    expect(prop.sleeping).toBe(false);
    stepEnvironment(f.state.environment, f.state.arena, 3, 1);
    expect(prop.position.y).toBeLessThan(.5);
    for (let tick = 4; tick < 484; tick++) stepEnvironment(f.state.environment, f.state.arena, tick, 1);
    expect(prop.position.y).toBe(0);
    expect(prop.sleeping).toBe(true);
    expect(prop.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(prop.angularVelocity).toEqual({ x: 0, z: 0 });
    const resting = structuredClone(prop);
    for (let tick = 484; tick < 514; tick++) stepEnvironment(f.state.environment, f.state.arena, tick, 1);
    expect(prop).toEqual(resting);
  });

  for (const placement of [stone, crate]) {
    it(`wakes the surviving ${placement.assetId} body when its measured support is removed`, () => {
      const f = fixture([{ ...placement, position: { ...placement.position, y: 1 } }]), prop = f.state.environment.props[0]!;
      f.engine.setSceneColliders([], [{ id: 'support', ownerId: 'native-rock', kind: 'top', minX: -2, minZ: -3.5, cell: 4, cols: 1, rows: 1, minY: 0, maxY: 1, top: [1], bottom: [0], stand: [1] }]);
      impactEnvironment(f.state.environment, f.state.arena, 1, 'supported', 36, prop.position, () => true);
      expect(prop.broken).toBe(placement === stone); // Fractured stones persist; a surviving crate must wake too.
      prop.velocity = { x: 0, y: 0, z: 0 };
      f.step({}, 10);
      expect(prop.position.y).toBe(1);
      expect(prop.sleeping).toBe(true);
      f.engine.setSceneColliders([], []);
      expect(prop.sleeping).toBe(false);
      f.step({}, 120);
      expect(prop.position.y).toBe(0);
      expect(prop.sleeping).toBe(true);
    });
  }

  it('distinguishes rooted wood, crushed foliage and mobile rubble, protecting quest/support structures', () => {
    const bridge = { ...tree, id: 'bridge', assetId: 'prop-greenwake-rope-bridge' };
    const protectedTree = { ...tree, id: 'story-tree' };
    const routeTree = { ...tree, id: 'greenwake-corridor-tree-cluster-visual' };
    const region = regionWith([tree, fern, stone, bridge, protectedTree, routeTree]);
    const environment = createEnvironment(region, new Set(['story-tree']));
    expect(environment.props.map(prop => prop.id)).toEqual([tree.id, fern.id, stone.id]);
    const arena = createEngineState().arena;
    impactEnvironment(environment, arena, 1, 'slam', 60, { x: 0, y: 0, z: 0 }, () => true, { x: 1, y: 0, z: 0 });
    for (let tick = 0; tick < 120; tick++) stepEnvironment(environment, arena, tick + 2, 1);
    expect(environment.props[0]!.position).toEqual(tree.position);
    expect(environment.props[1]!.broken).toBe(true);
    expect(environment.props[2]!.position.x).toBeGreaterThan(stone.position.x + .2);
    expect(solidPropKind(stone)).toBe('decoration'); expect(supportKind(stone)).toBe('none');
    expect(supportKind(bridge)).toBe('deck');
  });

  it('slows physical response with world time and bounds thrown rubble to reachable supported space', () => {
    const f = fixture(), slow = structuredClone(f.state.environment);
    for (const env of [f.state.environment, slow]) impactEnvironment(env, f.state.arena, 1, 'force', 60, { x: 0, y: 0, z: 0 }, () => true);
    for (let tick = 0; tick < 20; tick++) {
      stepEnvironment(f.state.environment, f.state.arena, tick + 2, 1);
      stepEnvironment(slow, f.state.arena, 1 + (tick + 1) * .25, .25);
    }
    expect(Math.abs(slow.props[0]!.position.z - stone.position.z)).toBeLessThan(Math.abs(f.state.environment.props[0]!.position.z - stone.position.z));
    for (let tick = 0; tick < 600; tick++) stepEnvironment(f.state.environment, f.state.arena, tick + 22, 1);
    const prop = f.state.environment.props[0]!;
    expect(Math.hypot(prop.position.x - stone.position.x, prop.position.z - stone.position.z)).toBeLessThanOrEqual(4);
    expect(prop.position.y).toBe(0);
    expect(f.state.environment.contacts).toEqual([]);
  });
});
