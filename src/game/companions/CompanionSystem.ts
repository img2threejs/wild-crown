import type { ActorId, CompanionId, Vec3 } from '../contracts.js';
import type { CombatActor, EngineState } from '../combat/CombatEngine.js';
import { COMPANION_COPY } from '../../content/campaign.js';
import { distance2, groundHeightAt, isCirclePathClear, moveAerialCircle, moveCircle } from '../combat/geometry.js';

export type CompanionCommand = 'follow' | 'stay' | 'focus' | 'defend' | 'search' | 'distract' | 'special' | 'recall' | 'ask' | 'signal';
export interface CompanionDefinition { id: CompanionId; species: string; faction: 'sky' | 'canopy' | 'fang' | 'pack' | 'shadow' | 'crown'; utilities: readonly string[]; ability: string; abilityLabel: string; abilityDescription: string; large: boolean; aerial: boolean; }
export interface CompanionSlotState { companionId: CompanionId; mode: 'follow' | 'stay' | 'focus' | 'defend' | 'search' | 'distract'; targetId?: ActorId; readyAt: number; token: number; position: Vec3; pathFallback: boolean; possessed: boolean; }
export interface CompanionRosterState { chapter: number; wardenCall: boolean; bond: number; dominionUsed: boolean; combat?: CompanionId; utility?: CompanionId; scout?: 'vara'; slots: Partial<Record<CompanionId, CompanionSlotState>>; navNodes: readonly NavNode[]; tokens: { available: number; maximum: number; nextAt: number }; }
export interface NavNode { id: string; position: Vec3; links: readonly string[]; requirement?: string; }
export interface CompanionLimits { activeSupportSlots: number; maxActiveTokens: number; maxHostiles: number; maxLargeActors: number; }

export const COMPANION_ROSTER: readonly CompanionDefinition[] = [
  { id: 'vara', species: 'hornbill', faction: 'sky', utilities: ['observe', 'mark', 'scout', 'warn'], ability: 'sky-mark', abilityLabel: COMPANION_COPY.vara.mark_weakness.label, abilityDescription: COMPANION_COPY.vara.mark_weakness.description, large: false, aerial: true },
  { id: 'koro', species: 'macaque', faction: 'canopy', utilities: ['move-object', 'open-route', 'distract', 'harvest'], ability: 'canopy-route', abilityLabel: COMPANION_COPY.koro.throw.label, abilityDescription: COMPANION_COPY.koro.throw.description, large: false, aerial: false },
  { id: 'asha', species: 'tiger', faction: 'fang', utilities: ['defend', 'protect', 'pin'], ability: 'fang-guard', abilityLabel: COMPANION_COPY.asha.charge_block.label, abilityDescription: COMPANION_COPY.asha.charge_block.description, large: true, aerial: false },
  { id: 'sable', species: 'wolf', faction: 'pack', utilities: ['track', 'coordinate', 'flank'], ability: 'pack-flank', abilityLabel: COMPANION_COPY.sable.flank.label, abilityDescription: COMPANION_COPY.sable.flank.description, large: false, aerial: false },
  { id: 'nyra', species: 'panther', faction: 'shadow', utilities: ['reveal', 'ambush', 'mark'], ability: 'shadow-ambush', abilityLabel: COMPANION_COPY.nyra.ambush.label, abilityDescription: COMPANION_COPY.nyra.ambush.description, large: false, aerial: false },
  { id: 'solkar', species: 'lion', faction: 'crown', utilities: ['rally', 'interrupt', 'calm-wildlife'], ability: 'crown-rally', abilityLabel: COMPANION_COPY.solkar.group_buff.label, abilityDescription: COMPANION_COPY.solkar.group_buff.description, large: true, aerial: false },
];
export const COMPANION_LIMITS: CompanionLimits = { activeSupportSlots: 2, maxActiveTokens: 2, maxHostiles: 6, maxLargeActors: 2 };
const RESOURCE_TICK = 90;
const COMMAND_COOLDOWN = 75;
const ABILITY_COST = 1;
const COMPANION_RADIUS = 0.32;
const FOLLOW_DISTANCE = 1.65;

export function createCompanionState(slots: { combat?: CompanionId; utility?: CompanionId; scout?: 'vara' } = {}, chapter = 1): CompanionRosterState {
  const state: CompanionRosterState = {
      chapter, wardenCall: false, bond: 0, dominionUsed: false, combat: slots.combat, utility: slots.utility, scout: slots.scout,
      slots: {}, navNodes: [], tokens: { available: COMPANION_LIMITS.maxActiveTokens, maximum: COMPANION_LIMITS.maxActiveTokens, nextAt: 0 },
    };
  const unique = new Set<CompanionId>();
  for (const id of [slots.combat, slots.utility, slots.scout]) {
    if (!id || unique.has(id)) continue;
    unique.add(id);
    state.slots[id] = { companionId: id, mode: 'follow', readyAt: 0, token: 0, position: { x: 0, y: 0, z: 0 }, pathFallback: false, possessed: false };
  }
  return state;
}

export function configureCompanions(state: EngineState, config: { chapter?: number; wardenCall?: boolean; bond?: number; dominionUsed?: boolean; navNodes?: readonly NavNode[] }): void {
  const companions = state.companionState;
  if (config.chapter !== undefined) companions.chapter = config.chapter;
  if (config.wardenCall !== undefined) companions.wardenCall = config.wardenCall;
  if (config.bond !== undefined) companions.bond = Math.max(0, Math.min(100, config.bond));
  if (config.dominionUsed !== undefined) companions.dominionUsed = config.dominionUsed;
  if (config.navNodes) companions.navNodes = structuredClone(config.navNodes);
}

export function companionCommand(engine: EngineState, id: CompanionId, command: CompanionCommand, targetId?: ActorId): boolean {
  const state = engine.companionState;
  const definition = COMPANION_ROSTER.find(companion => companion.id === id);
  const slot = state.slots[id];
  const actor = findActorByReference(engine, id);
  if (!definition || !slot || !actor || !actor.visible || actor.downed || isPossessed(engine, slot, actor)) return false;
  if (id === 'solkar' && state.dominionUsed && state.bond < 40) return false;
  const role = roleOf(state, id);
  if (role === null) return false;
  if ((command === 'ask' || command === 'signal') && !state.wardenCall && state.bond < 10) return false;
  if (command === 'follow' || command === 'recall') { slot.mode = 'follow'; slot.targetId = undefined; return true; }
  if (command === 'stay') { slot.mode = 'stay'; slot.targetId = undefined; slot.position = { ...actor.position }; return true; }
  if (command === 'ask' || command === 'signal') return issueReady(engine, id, 'focus', targetId, role);
  if (command === 'defend') {
    if (role !== 'combat') return false;
    return issueReady(engine, id, 'defend', targetId ?? 'aren' as ActorId, role);
  }
  if (command === 'focus') {
    if (role === 'scout' && id !== 'vara') return false;
    return issueReady(engine, id, 'focus', targetId, role);
  }
  if (command === 'search' || command === 'distract') {
    const target = targetId ? findAvailableActorByReference(engine, targetId) : undefined;
    if (role !== 'utility' || !target) return false;
    slot.mode = command; slot.targetId = target.id; slot.readyAt = engine.tick + COMMAND_COOLDOWN;
    actor.targetId = target.id; actor.actionId = id + '-' + command as never; actor.phase = 'anticipation';
    return true;
  }
  if (command === 'special') {
    if (role !== 'combat' && role !== 'utility') return false;
    const object = targetId ? engine.movableObjects.find(candidate => candidate.objectId === targetId) : undefined;
    if (id === 'koro' && targetId && object) {
      if (role !== 'utility' || object.phase !== 'resting' || object.authored.requiredCompanionId !== 'koro' || engine.tick < slot.readyAt || state.tokens.available < ABILITY_COST) return false;
      state.tokens.available -= ABILITY_COST;
      state.tokens.nextAt = state.tokens.available === state.tokens.maximum ? 0 : engine.tick + RESOURCE_TICK;
      slot.token++;
      slot.mode = 'stay';
      slot.targetId = targetId;
      slot.position = { ...actor.position };
      slot.readyAt = engine.tick + COMMAND_COOLDOWN;
      actor.targetId = targetId;
      actor.actionId = id + '-' + definition.ability as never;
      actor.phase = 'anticipation';
      actor.actionStartedTick = engine.tick;
      return true;
    }
    const target = targetId ?? engine.targetId ?? (id === 'asha' || id === 'solkar' ? engine.encounter?.bossId as ActorId | undefined : undefined);
    if (!target) return false;
    return issueReady(engine, id, 'focus', target, role, true);
  }
  return false;
}

function issueReady(engine: EngineState, id: CompanionId, mode: CompanionSlotState['mode'], targetId: ActorId | undefined, role: 'combat' | 'utility' | 'scout', special = false): boolean {
  const state = engine.companionState;
  const slot = state.slots[id];
  const actor = findActorByReference(engine, id);
  if (!slot || !actor || !actor.visible || actor.downed || isPossessed(engine, slot, actor) || engine.tick < slot.readyAt) return false;
  const resolvedTarget = targetId ? findAvailableActorByReference(engine, targetId) : undefined;
  if (targetId && !resolvedTarget) return false;
  const resolvedTargetId = resolvedTarget?.id;
  if (id === 'vara' && role === 'scout') {
    slot.mode = 'focus'; slot.targetId = resolvedTargetId; slot.readyAt = engine.tick + COMMAND_COOLDOWN;
    actor.targetId = resolvedTargetId; actor.actionId = 'vara-sky-mark' as never; actor.phase = 'anticipation';
    return true;
  }
  if (state.tokens.available < ABILITY_COST) return false;
  state.tokens.available -= ABILITY_COST;
  state.tokens.nextAt = state.tokens.available === state.tokens.maximum ? 0 : engine.tick + RESOURCE_TICK;
  slot.token++; slot.mode = mode; slot.targetId = resolvedTargetId; slot.readyAt = engine.tick + COMMAND_COOLDOWN;
  actor.targetId = resolvedTargetId;
  const ability = COMPANION_ROSTER.find(companion => companion.id === id)!.ability;
  actor.actionId = special ? `${id}-${ability}` as never : `${id}-${mode}` as never;
  actor.phase = 'anticipation'; actor.actionStartedTick = engine.tick;
  return true;
}

export function stepCompanions(engine: EngineState): void {
  const state = engine.companionState;
  const player = engine.actors.find(actor => actor.id === engine.playerId);
  if (!player) return;
  if (state.tokens.available < state.tokens.maximum && engine.tick >= state.tokens.nextAt) {
    state.tokens.available++;
    state.tokens.nextAt = state.tokens.available < state.tokens.maximum ? engine.tick + RESOURCE_TICK : 0;
  }
  for (const id of activeCompanions(state)) {
    const slot = state.slots[id];
    const actor = findActorByReference(engine, id);
    if (!slot || !actor || !actor.visible || actor.downed || isPossessed(engine, slot, actor)) continue;
    if (slot.mode === 'stay') {
      const heldObject = id === 'koro' && slot.targetId ? engine.movableObjects.find(object => object.objectId === slot.targetId) : undefined;
      if (!heldObject || heldObject.phase !== 'settled') continue;
      slot.mode = 'follow';
      slot.targetId = undefined;
      slot.pathFallback = false;
    }
    applyCompanionSupport(engine, actor, slot);
    moveWithNavigation(engine, actor, slot, player.position);
  }
}

function activeCompanions(state: CompanionRosterState): CompanionId[] {
  const ids: CompanionId[] = [];
  for (const id of [state.combat, state.utility, state.scout]) {
    if (id && !ids.includes(id) && ids.length < COMPANION_LIMITS.activeSupportSlots + 1) ids.push(id);
  }
  return ids;
}

function applyCompanionSupport(engine: EngineState, actor: CombatActor, slot: CompanionSlotState): void {
  if (slot.mode !== 'focus' && slot.mode !== 'defend' && slot.mode !== 'distract' && slot.mode !== 'search') return;
  const target = slot.targetId ? findAvailableActorByReference(engine, slot.targetId) : undefined;
  if (!target || distance2(actor.position, target.position) > 2.3 || actor.recoveringUntil > engine.tick) return;
    if (actor.id === 'koro' && slot.mode !== 'search' && target.allegiance === 'hostile' && target.phase !== 'anticipation') return;
  if (actor.id === 'asha' && slot.mode === 'defend' && target.id === engine.playerId) {
    target.invulnerableUntil = Math.max(target.invulnerableUntil, engine.tick + 6);
    engine.events.push({ id: `${engine.runId}:companion-asha-defend:${engine.tick}`, tick: engine.tick, kind: 'companion', actorId: actor.id, targetId: target.id, message: 'Charge Block' });
    actor.recoveringUntil = engine.tick + 45;
    actor.phase = 'recovery';
    return;
  }
  if (slot.mode === 'search') {
    engine.events.push({ id: `${engine.runId}:companion-search:${engine.tick}:${actor.id}`, tick: engine.tick, kind: 'companion', actorId: actor.id, targetId: target.id, message: 'Track' });
  } else if (actor.id === 'vara') {
    engine.events.push({ id: `${engine.runId}:companion-mark:${engine.tick}:${target.id}`, tick: engine.tick, kind: 'companion', actorId: actor.id, targetId: target.id, message: 'Mark Weakness' });
  } else if (actor.id === 'koro' && target.allegiance === 'hostile' && target.phase === 'anticipation' && target.staggerUntil < engine.tick) {
    target.staggerUntil = engine.tick + 6;
    engine.events.push({ id: `${engine.runId}:companion-koro:${engine.tick}:${target.id}`, tick: engine.tick, kind: 'companion', actorId: actor.id, targetId: target.id, message: 'Throw' });
  } else if (actor.id === 'asha' && target.id === engine.encounter?.bossId && target.phase === 'anticipation' && target.staggerUntil < engine.tick) {
    target.staggerUntil = engine.tick + 12;
    engine.events.push({ id: `${engine.runId}:companion-asha:${engine.tick}`, tick: engine.tick, kind: 'companion', actorId: actor.id, targetId: target.id, message: 'Charge Block' });
  } else if (actor.id === 'sable' && target.allegiance === 'hostile') {
    target.ferocity = Math.max(0, (target.ferocity ?? 100) - 3);
    engine.events.push({ id: `${engine.runId}:companion-sable:${engine.tick}:${target.id}`, tick: engine.tick, kind: 'companion', actorId: actor.id, targetId: target.id, message: 'Flank' });
  } else if (actor.id === 'nyra' && target.allegiance === 'hostile') {
    const counterOpen = engine.counterUntil > engine.tick && (engine.targetId === target.id || engine.lastResolvedTargetId === target.id);
    if (counterOpen) {
      target.staggerUntil = Math.max(target.staggerUntil, engine.tick + 12);
    } else if (target.phase === 'recovery' || target.staggerUntil > engine.tick) {
      target.staggerUntil = Math.max(target.staggerUntil, engine.tick + 6);
    } else {
      return;
    }
    engine.events.push({
      id: engine.runId + (counterOpen ? ':companion-nyra-counter:' : ':companion-nyra-ambush:') + engine.tick + ':' + target.id,
      tick: engine.tick, kind: 'companion', actorId: actor.id, targetId: target.id,
      message: counterOpen ? 'Ambush Counter' : 'Ambush',
    });
  } else if (actor.id === 'solkar' && target.id === engine.encounter?.bossId && target.phase === 'anticipation') {
    target.staggerUntil = Math.max(target.staggerUntil, engine.tick + 6);
    engine.events.push({ id: `${engine.runId}:companion-solkar:${engine.tick}`, tick: engine.tick, kind: 'companion', actorId: actor.id, targetId: target.id, message: 'Rally' });
  }
  actor.recoveringUntil = engine.tick + 45;
  actor.phase = 'recovery';
}

function moveWithNavigation(engine: EngineState, actor: CombatActor, slot: CompanionSlotState, follow: Vec3): void {
  const isTargeting = slot.mode === 'focus' || slot.mode === 'defend' || slot.mode === 'search' || slot.mode === 'distract';
  const targetActor = isTargeting && slot.targetId ? findActorByReference(engine, slot.targetId) : undefined;
  const target = targetActor?.position ?? follow;
  const offset = slot.mode === 'follow' ? { x: -1.3, y: 0, z: 1.2 } : { x: 0, y: 0, z: 0 };
  const goal = {
      x: Math.max(engine.arena.bounds.min.x + COMPANION_RADIUS, Math.min(engine.arena.bounds.max.x - COMPANION_RADIUS, target.x + offset.x)),
      y: target.y + offset.y + (actor.aerial ? 1.8 : 0),
      z: Math.max(engine.arena.bounds.min.z + COMPANION_RADIUS, Math.min(engine.arena.bounds.max.z - COMPANION_RADIUS, target.z + offset.z)),
    };
    if (actor.aerial) {
      const dx = goal.x - actor.position.x, dy = goal.y - actor.position.y, dz = goal.z - actor.position.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance < FOLLOW_DISTANCE) { slot.pathFallback = false; return; }
      const stride = Math.min(0.055, distance);
      const next = moveAerialCircle(engine.arena, actor.position, { x: dx / distance * stride, y: dy / distance * stride, z: dz / distance * stride }, COMPANION_RADIUS, actor.collisionHeight);
      slot.pathFallback = distance2(actor.position, next) < 1e-6 && Math.abs(actor.position.y - next.y) < 1e-6;
      if (!slot.pathFallback) actor.position = next;
      return;
    }
  if (distance2(actor.position, goal) < (slot.mode === 'follow' ? FOLLOW_DISTANCE : 0.75)) { slot.pathFallback = false; return; }
  const route = navWaypoint(engine, actor.position, goal, actor.collisionHeight);

  slot.pathFallback = route === null;
  if (!route) return;
  const dx = route.x - actor.position.x, dz = route.z - actor.position.z, distance = Math.hypot(dx, dz);
  if (distance < 0.08) return;
  const stride = Math.min(0.055, distance);
  const next = moveCircle(engine.arena, actor.position, { x: dx / distance * stride, y: 0, z: dz / distance * stride }, COMPANION_RADIUS, actor.collisionHeight);
  if (distance2(actor.position, next) > 1e-6) actor.position = next;
  else slot.pathFallback = true;
}

function navWaypoint(engine: EngineState, from: Vec3, to: Vec3, height: number): Vec3 | null {
  const arena = engine.arena;
  const destinationGround = groundHeightAt(arena, to.x, to.z, to.y);
  if (destinationGround === null) return null;
  const destination = { x: to.x, y: destinationGround, z: to.z };
  if (lineWalkable(engine, from, destination, height)) return destination;
  const nodes = engine.companionState.navNodes.filter(node => isNodeAvailable(engine, node));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const open = new Set(nodes.map(node => node.id));
  const costs = new Map<string, number>(), previous = new Map<string, string>();
  for (const node of nodes) {
    const point = groundNode(arena, node.position);
    if (point && lineWalkable(engine, from, point, height)) costs.set(node.id, distance2(from, point));
  }
  while (open.size) {
    let currentId: string | undefined, currentCost = Infinity;
    for (const id of open) { const cost = costs.get(id) ?? Infinity; if (cost < currentCost) { currentId = id; currentCost = cost; } }
    if (currentId === undefined || currentCost === Infinity) break;
    open.delete(currentId);
    const current = byId.get(currentId)!;
    const currentPosition = groundNode(arena, current.position);
    if (!currentPosition) continue;
    if (lineWalkable(engine, currentPosition, destination, height)) {
      const path = [currentId];
      while (previous.has(path[0]!)) path.unshift(previous.get(path[0]!)!);
      const firstPosition = groundNode(arena, byId.get(path[0]!)!.position);
      const firstStep = firstPosition && distance2(from, firstPosition) < 0.2 ? path[1] : path[0];
      return firstStep ? groundNode(arena, byId.get(firstStep)!.position) : destination;
    }
    for (const neighborId of current.links) {
      if (!open.has(neighborId)) continue;
      const neighbor = byId.get(neighborId), neighborPosition = neighbor && groundNode(arena, neighbor.position);
      if (!neighbor || !neighborPosition || !lineWalkable(engine, currentPosition, neighborPosition, height)) continue;
      const candidateCost = currentCost + distance2(currentPosition, neighborPosition);
      if (candidateCost < (costs.get(neighborId) ?? Infinity)) { costs.set(neighborId, candidateCost); previous.set(neighborId, currentId); }
    }
  }
  return null;
}

function lineWalkable(engine: EngineState, from: Vec3, to: Vec3, height: number): boolean {
  return isCirclePathClear(engine.arena, from, to, COMPANION_RADIUS, height);
}
function groundNode(arena: EngineState['arena'], point: Vec3): Vec3 | null {
  const y = groundHeightAt(arena, point.x, point.z, point.y);
  return y === null ? null : { x: point.x, y, z: point.z };
}
function isNodeAvailable(engine: EngineState, node: NavNode): boolean {
  if (!node.requirement) return true;
  if (engine.worldFacts[node.requirement] === true) return true;
  return engine.traversalGates.some(gate => (gate.id === node.requirement || gate.unlockFact === node.requirement) && gate.unlocked);
}
function roleOf(state: CompanionRosterState, id: CompanionId): 'combat' | 'utility' | 'scout' | null {
  if (state.combat === id) return 'combat';
  if (state.utility === id) return 'utility';
  if (state.scout === id) return 'scout';
  return null;
}
function isPossessed(engine: EngineState, slot: CompanionSlotState, actor: CombatActor): boolean {
  return slot.possessed || actor.possessed || actor.possessedUntil > engine.tick;
}
function findActorByReference(engine: EngineState, id: ActorId): CombatActor | undefined {
  const exact = engine.actors.find(actor => actor.id === id);
  if (exact) return exact;
  let match: CombatActor | undefined;
  for (const actor of engine.actors) {
    if (actor.archetypeId !== id) continue;
    if (match) return undefined;
    match = actor;
  }
  return match;
}
function findAvailableActorByReference(engine: EngineState, id: ActorId): CombatActor | undefined {
  const actor = findActorByReference(engine, id);
  return actor && actor.visible && !actor.downed ? actor : undefined;
}

export function configureCompanionSlots(engine: EngineState, slots: { combat?: CompanionId; utility?: CompanionId; scout?: 'vara' }): boolean {
  const selected = [slots.combat, slots.utility, slots.scout].filter((id): id is CompanionId => id !== undefined);
  if (new Set(selected).size !== selected.length || slots.scout !== undefined && slots.scout !== 'vara') return false;
  for (const id of selected) {
    if (!COMPANION_ROSTER.some(companion => companion.id === id)) return false;
    const actor = findActorByReference(engine, id);
    if (!actor || !actor.visible || actor.downed || actor.possessed || actor.possessedUntil > engine.tick || engine.companionState.slots[id]?.possessed) return false;
  }
  const state = engine.companionState;
  const next: Partial<Record<CompanionId, CompanionSlotState>> = {};
  for (const id of selected) {
    const existing = state.slots[id];
    if (existing) next[id] = existing;
    else {
      const actor = findActorByReference(engine, id)!;
      next[id] = { companionId: id, mode: 'follow', readyAt: 0, token: 0, position: { ...actor.position }, pathFallback: false, possessed: false };
    }
  }
  state.combat = slots.combat; state.utility = slots.utility; state.scout = slots.scout; state.slots = next;
  engine.companionSlots = { ...slots };
  return true;
}
