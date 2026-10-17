import { expect, it } from 'bun:test';
import { REGIONS } from '../../src/content/world.js';
import { MAREK_ASSISTANCE, NURSERY_ESCORT, PACK_PATROL_ACTOR_IDS, SHARED_HUNT_ROUTE, SIDE_QUEST_DELIVERIES, SIDE_QUEST_ROUTES } from '../../src/content/side-quests.js';
import { CombatEngine } from '../../src/game/combat/CombatEngine.js';
import type { CombatInput } from '../../src/game/combat/CombatEngine.js';
import type { Vec3 } from '../../src/game/contracts.js';

const idle: CombatInput = { tick: 0, move: { x: 0, y: 0, z: 0 }, dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
const ticks = (engine: CombatEngine, count: number) => { for (let i = 0; i < count; i++) engine.fixedStep(idle); };
const distance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

it('walk routes remain gated, advance physically over their terrain, pause, and reward only arrival', () => {
  for (const [regionId, routes] of Object.entries(SIDE_QUEST_ROUTES)) for (const route of routes) {
    const engine = new CombatEngine();
    engine.loadRegion({ regionId, runId: route.id, presentActorIds: ['aren'], playerPosition: route.from });
    engine.fixedStep({ ...idle, interactPressed: true, traversalId: route.id });
    expect(engine.isTraversing).toBe(false);
    engine.syncWorldFacts({ [route.unlockFact!]: true });
    engine.fixedStep({ ...idle, interactPressed: true, traversalId: route.id });
    expect(engine.isTraversing).toBe(true);
    ticks(engine, 20);
    const moving = engine.snapshot().actors.find(actor => actor.id === 'aren')!.position;
    expect(distance(moving, route.from)).toBeGreaterThan(.1);
    expect(distance(moving, route.to)).toBeGreaterThan(5);
    expect(engine.consumeWorldEvents().some(event => event.type === 'traversal')).toBe(false);
    engine.setTimePolicy('paused');
    ticks(engine, 60);
    expect(engine.snapshot().actors.find(actor => actor.id === 'aren')!.position).toEqual(moving);
    engine.setTimePolicy('normal');
    ticks(engine, route.traversal!.durationTicks + 2);
    expect(engine.isTraversing).toBe(false);
    expect(engine.snapshot().actors.find(actor => actor.id === 'aren')!.position).toEqual(route.to);
    expect(engine.consumeWorldEvents().filter(event => event.type === 'traversal').map(event => event.routeId)).toEqual([route.traversalEvent]);
  }
});

it('the nursery cub must physically follow to shelter; Tali is never substituted or rescued by this quest', () => {
  const engine = new CombatEngine();
  const facts = { 'quest:the-last-cub:accepted': true, 'interaction:the-last-cub-evidence': true };
  engine.loadRegion({ regionId: NURSERY_ESCORT.regionId, runId: 'nursery-escort', presentActorIds: ['aren', 'nursery-cub', 'tali'], playerPosition: { x: -58, y: 0, z: 5 }, worldFacts: facts });
  engine.setCameraBasis({ forward: { x: 0, y: 0, z: 1 }, right: { x: 1, y: 0, z: 0 } });
  const taliBefore = engine.snapshot().actors.find(actor => actor.id === 'tali')!.position;
  expect(engine.resolveInteraction(NURSERY_ESCORT.interactionId, NURSERY_ESCORT.actorId)).toBe(true);
  expect(engine.consumeWorldEvents().some(event => event.type === 'rescue')).toBe(false);
  const path = [{ x: -57, y: 0, z: 2 }, { x: -53, y: 0, z: -4 }, { x: -49, y: 0, z: -11 }, NURSERY_ESCORT.to];
  for (const target of path) {
    let arrived = false;
    for (let i = 0; i < 900; i++) {
      const actors = engine.snapshot().actors;
      const player = actors.find(actor => actor.id === 'aren')!.position;
      const cub = actors.find(actor => actor.id === NURSERY_ESCORT.actorId)!.position;
      const length = distance(player, target);
      if (length < .3) { arrived = true; break; }
      const move = distance(player, cub) > 3 ? idle.move : { x: (target.x - player.x) / length, y: 0, z: (target.z - player.z) / length };
      engine.fixedStep({ ...idle, move });
    }
    expect(arrived).toBe(true);
  }
  ticks(engine, 120);
  const rescues = engine.consumeWorldEvents().filter(event => event.type === 'rescue');
  expect(rescues.map(event => [event.targetId, event.safe])).toEqual([['nursery-cub', true]]);
  expect(distance(engine.snapshot().actors.find(actor => actor.id === 'nursery-cub')!.position, NURSERY_ESCORT.to)).toBeLessThanOrEqual(NURSERY_ESCORT.arrivalRadiusMeters);
  expect(engine.snapshot().actors.find(actor => actor.id === 'tali')!.position).toEqual(taliBefore);
  engine.loadRegion({ regionId: NURSERY_ESCORT.regionId, runId: 'nursery-escort', presentActorIds: ['aren', 'nursery-cub'], playerPosition: NURSERY_ESCORT.from, worldFacts: { ...facts, 'side:nursery-safe': true } });
  expect(engine.snapshot().actors.find(actor => actor.id === 'nursery-cub')!.position).toEqual(NURSERY_ESCORT.to);
});

it('clearing the main camp and the optional snare supply disarms only their own real damage sources', () => {
  const region = REGIONS.find(item => item.id === 'blood-bamboo-valley')!;
  const optional = region.fieldTraps!.find(trap => trap.disarmFact === 'side:snare-supply-cleared')!;
  const main = region.fieldTraps!.find(trap => trap.disarmFact !== optional.disarmFact)!;
  for (const [cleared, stillArmed] of [[main, optional], [optional, main]]) {
    const engine = new CombatEngine();
    const worldFacts = { [cleared.disarmFact]: true };
    engine.loadRegion({ regionId: region.id, runId: cleared.id, presentActorIds: ['aren'], playerPosition: cleared.position, worldFacts });
    const before = engine.snapshot().player.vitality;
    ticks(engine, 1);
    expect(engine.snapshot().player.vitality).toBe(before);
    engine.loadRegion({ regionId: region.id, runId: cleared.id, presentActorIds: ['aren'], playerPosition: stillArmed.position, worldFacts });
    ticks(engine, 1);
    expect(engine.snapshot().player.vitality).toBeLessThan(before);
    expect(engine.snapshot().traps!.find(trap => trap.id === stillArmed.id)!.sprung).toBe(true);
  }
});

function walkTo(engine: CombatEngine, target: Vec3): void {
  engine.setCameraBasis({ forward: { x: 0, y: 0, z: 1 }, right: { x: 1, y: 0, z: 0 } });
  for (let tick = 0; tick < 900; tick++) {
    const player = engine.snapshot().actors.find(actor => actor.id === 'aren')!.position;
    const remaining = distance(player, target);
    if (remaining < .25) return;
    engine.fixedStep({ ...idle, move: { x: (target.x - player.x) / remaining, y: 0, z: (target.z - player.z) / remaining } });
  }
  throw new Error('Player could not reach the authored delivery station');
}

it('seed baskets travel with the player in order; interrupted carries reset without awarding a delivery', () => {
  const [first, second] = SIDE_QUEST_DELIVERIES['whispering-canopy']!;
  const engine = new CombatEngine();
  const facts: Record<string, boolean> = { 'quest:seeds-between-branches:accepted': true, 'interaction:seeds-between-branches-evidence': true };
  engine.loadRegion({ regionId: 'whispering-canopy', runId: 'ordered-seeds', presentActorIds: ['aren'], playerPosition: second!.from, worldFacts: facts });
  expect(engine.resolveInteraction(second!.pickupInteractionId, second!.id)).toBe(false);
  walkTo(engine, first!.from);
  expect(engine.resolveInteraction(first!.pickupInteractionId, first!.id)).toBe(true);
  expect(engine.resolveInteraction(first!.deliveryInteractionId, first!.id)).toBe(false);
  expect(engine.consumeWorldEvents()).toEqual([]);
  walkTo(engine, { x: 14, y: 4, z: -41 });
  const player = engine.snapshot().actors.find(actor => actor.id === 'aren')!.position;
  const carried = engine.snapshot().movableObjects.find(object => object.objectId === first!.id)!;
  expect(carried.phase).toBe('in-flight');
  expect(distance(carried.position, player)).toBeCloseTo(.55);
  expect(carried.position.y - player.y).toBeCloseTo(.65);
  engine.restore(engine.serialize());
  expect(engine.snapshot().movableObjects.find(object => object.objectId === first!.id)!.position).toEqual(first!.from);
  expect(engine.consumeWorldEvents()).toEqual([]);
  for (const delivery of [first!, second!]) {
    walkTo(engine, delivery.from);
    expect(engine.resolveInteraction(delivery.pickupInteractionId, delivery.id)).toBe(true);
    walkTo(engine, delivery.to);
    expect(engine.resolveInteraction(delivery.deliveryInteractionId, delivery.id)).toBe(true);
    expect(engine.resolveInteraction(delivery.deliveryInteractionId, delivery.id)).toBe(false);
    const events = engine.consumeWorldEvents();
    expect(events.map(event => event.type === 'semantic-interaction' ? event.interactionId : event.type)).toEqual([delivery.deliveryInteractionId]);
    facts[delivery.movedFactId] = true;
    engine.syncWorldFacts(facts);
  }
  engine.loadRegion({ regionId: 'whispering-canopy', runId: 'ordered-seeds', presentActorIds: ['aren'], playerPosition: first!.from, worldFacts: facts });
  for (const delivery of [first!, second!]) {
    const object = engine.snapshot().movableObjects.find(item => item.objectId === delivery.id)!;
    expect(object.phase).toBe('settled');
    expect(object.position).toEqual(delivery.to);
    expect(engine.resolveInteraction(delivery.pickupInteractionId, delivery.id)).toBe(false);
  }
});

it('winter-cache coordination requires both delivered supplies and the shared pack agreement', () => {
  const delivery = SIDE_QUEST_DELIVERIES['moonpine-ridge']![0]!;
  const engine = new CombatEngine();
  const facts: Record<string, boolean> = { 'quest:winter-stores:accepted': true, 'interaction:winter-stores-evidence': true };
  const action = { x: -24, y: 8, z: 8 };
  engine.loadRegion({ regionId: 'moonpine-ridge', runId: 'winter-delivery', presentActorIds: ['aren'], playerPosition: action, worldFacts: facts });
  expect(engine.resolveInteraction('winter-stores-action', 'winter-cache')).toBe(false);
  walkTo(engine, delivery.from);
  expect(engine.resolveInteraction(delivery.pickupInteractionId, delivery.id)).toBe(true);
  walkTo(engine, delivery.to);
  expect(engine.resolveInteraction(delivery.deliveryInteractionId, delivery.id)).toBe(true);
  facts[delivery.movedFactId] = true;
  engine.syncWorldFacts(facts);
  walkTo(engine, action);
  expect(engine.resolveInteraction('winter-stores-action', 'winter-cache')).toBe(false);
  facts['side:shared-hunt'] = true;
  engine.syncWorldFacts(facts);
  expect(engine.resolveInteraction('winter-stores-action', 'winter-cache')).toBe(true);
});

it('the two unnamed pack scouts patrol only after agreement and never substitute absent leaders', () => {
  const engine = new CombatEngine();
  engine.loadRegion({ regionId: 'moonpine-ridge', runId: 'shared-patrol', presentActorIds: ['aren'], playerPosition: SHARED_HUNT_ROUTE.from });
  expect(engine.snapshot().actors.some(actor => PACK_PATROL_ACTOR_IDS.some(id => id === actor.id))).toBe(false);
  engine.syncWorldFacts({ 'side:shared-hunt': true });
  const before = PACK_PATROL_ACTOR_IDS.map(id => engine.snapshot().actors.find(actor => actor.id === id)!.position);
  ticks(engine, 180);
  const moving = PACK_PATROL_ACTOR_IDS.map(id => engine.snapshot().actors.find(actor => actor.id === id)!.position);
  moving.forEach((position, index) => expect(distance(position, before[index]!)).toBeGreaterThan(3));
  expect(engine.snapshot().actors.some(actor => actor.id === 'sable' || actor.id === 'luma')).toBe(false);
  engine.setTimePolicy('paused');
  ticks(engine, 120);
  expect(PACK_PATROL_ACTOR_IDS.map(id => engine.snapshot().actors.find(actor => actor.id === id)!.position)).toEqual(moving);
  engine.setTimePolicy('normal');
  engine.restore(engine.serialize());
  ticks(engine, 120);
  expect(distance(engine.snapshot().actors.find(actor => actor.id === PACK_PATROL_ACTOR_IDS[0])!.position, moving[0]!)).toBeGreaterThan(1);
});

it('Marek assistance requires his real presence and awards dismantling only after his physical arrival', () => {
  const engine = new CombatEngine();
  const facts = { 'quest:the-hunters-remorse:accepted': true, 'interaction:the-hunters-remorse-evidence': true, 'choice:marek-fate': true, marekPresent: true };
  engine.loadRegion({ regionId: 'mistveil-basin', runId: 'marek-assistance', presentActorIds: ['aren'], playerPosition: MAREK_ASSISTANCE.path[0], worldFacts: facts });
  expect(engine.resolveInteraction(MAREK_ASSISTANCE.interactionId, 'marek')).toBe(false);
  engine.loadRegion({ regionId: 'mistveil-basin', runId: 'marek-assistance', presentActorIds: ['aren', 'marek'], playerPosition: MAREK_ASSISTANCE.path[0], worldFacts: facts });
  expect(engine.resolveInteraction(MAREK_ASSISTANCE.interactionId, 'marek')).toBe(true);
  ticks(engine, 120);
  expect(engine.consumeWorldEvents()).toEqual([]);
  expect(distance(engine.snapshot().actors.find(actor => actor.id === 'marek')!.position, MAREK_ASSISTANCE.path[0])).toBeGreaterThan(2);
  engine.setTimePolicy('paused');
  const paused = engine.snapshot().actors.find(actor => actor.id === 'marek')!.position;
  ticks(engine, 180);
  expect(engine.snapshot().actors.find(actor => actor.id === 'marek')!.position).toEqual(paused);
  engine.setTimePolicy('normal');
  ticks(engine, 800);
  expect(engine.consumeWorldEvents().filter(event => event.type === 'semantic-interaction').map(event => [event.actorId, event.kind, event.targetId])).toEqual([['marek', 'break', 'trap-line-neutralized']]);
  expect(distance(engine.snapshot().actors.find(actor => actor.id === 'marek')!.position, MAREK_ASSISTANCE.path.at(-1)!)).toBeLessThan(.2);
  engine.syncWorldFacts({ ...facts, marekPresent: false });
  expect(engine.resolveInteraction(MAREK_ASSISTANCE.interactionId, 'marek')).toBe(false);
  expect(engine.snapshot().actors.find(actor => actor.id === 'marek')!.visible).toBe(false);
});
