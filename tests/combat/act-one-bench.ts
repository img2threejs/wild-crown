import { INTERACTIONS, REGIONS } from '../../src/content/campaign.js';
import { CombatEngine, createEngineState, makeActor, type CombatActor, type CombatInput, type EngineState, type LiveHazard } from '../../src/game/combat/CombatEngine.js';
import { ATTACKS } from '../../src/game/combat/content.js';
import { arenaFromRegion, vec } from '../../src/game/combat/geometry.js';
import type { ActorId, Bounds3, CompanionId, GroundSurfaceDefinition, RegionColliderDefinition, RegionDefinition, Vec3, WorldEvent } from '../../src/game/contracts.js';

export const idle: CombatInput = {
  tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false,
  heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false,
};

/** The engine keeps its state private by design; Act I tests open authored gates and read exact deadlines through it. */
export function liveState(engine: CombatEngine): EngineState {
  return (engine as unknown as { state: EngineState }).state;
}
interface AttackStarter { beginAttack(source: CombatActor, def: (typeof ATTACKS)[string], aim?: Vec3): LiveHazard | undefined }
/** Starts one authored attack through the engine's own attack path, so telegraph, hazard, lunge and cues are the real ones. */
export function startAttack(engine: CombatEngine, sourceId: string, attackId: string, aim?: Vec3): LiveHazard {
  const source = liveState(engine).actors.find(actor => actor.id === sourceId)!;
  // beginAttack is private; the attack path (not a copy of it) is exactly what these tests exercise.
  const hazard = (engine as unknown as AttackStarter).beginAttack(source, ATTACKS[attackId]!, aim);
  if (!hazard) throw new Error(`attack ${attackId} did not start`);
  return hazard;
}
export function run(engine: CombatEngine, ticks: number, input: CombatInput = idle): void {
  for (let tick = 0; tick < ticks; tick++) engine.fixedStep(input);
}
export function actorOf(engine: CombatEngine, id: string) {
  const actor = engine.snapshot().actors.find(candidate => candidate.id === id);
  if (!actor) throw new Error(`no actor ${id}`);
  return actor;
}
export function worldEvents(engine: CombatEngine, type?: WorldEvent['type']): WorldEvent[] {
  const events = liveState(engine).worldEvents;
  return type ? events.filter(event => event.type === type) : events.slice();
}
export function region(id: string): RegionDefinition { return REGIONS.find(candidate => candidate.id === id)!; }
export function node(regionId: string, nodeId: string): Vec3 { return region(regionId).navigation.nodes.find(candidate => candidate.id === nodeId)!.position; }
/**
 * Authored position of an entity, prop placement or movable object. Content places encounter-resettable bundle/movable
 * objects as prop placements rather than as component entities; the bench treats both as the same authored point.
 */
export function entity(regionId: string, entityId: string): Vec3 {
  const regionDef = region(regionId);
  const point = regionDef.entities.find(candidate => candidate.id === entityId)?.position
    ?? regionDef.props.find(candidate => candidate.id === entityId)?.position
    ?? regionDef.movableObjects.find(candidate => candidate.id === entityId)?.from;
  if (!point) throw new Error(`Unknown authored entity/prop/movable ${entityId} in ${regionId}`);
  return point;
}
export function interaction(id: string) { return INTERACTIONS.find(candidate => candidate.id === id)!; }

export interface BambooOptions {
  runId: string;
  /** Instance ids present besides the hero; Asha and Tali are always present. */
  present?: readonly string[];
  companionId?: CompanionId;
  worldFacts?: Record<string, boolean | number | string>;
  playerAt?: Vec3;
}
/** The canonical Blood Bamboo Valley loaded for the Asha encounter (party companions are explicit region instances). */
export function bambooAshaBench(options: BambooOptions): CombatEngine {
  const engine = new CombatEngine();
  const playerAt = options.playerAt ?? node('blood-bamboo-valley', 'bamboo-den-terrace');
  const regionDefinition = REGIONS.find(candidate => candidate.id === 'blood-bamboo-valley');
  engine.loadRegion({
    regionId: 'blood-bamboo-valley', runId: options.runId, presentActorIds: ['asha', 'tali', ...(options.present ?? [])],
    playerPosition: playerAt, companionId: options.companionId, worldFacts: options.worldFacts, regionDefinition,
  });
  engine.startEncounter({ encounterId: 'encounter-asha', regionId: 'blood-bamboo-valley', runId: options.runId, playerPosition: playerAt, companionId: options.companionId, worldFacts: options.worldFacts, regionDefinition });
  return engine;
}

/** A flat synthetic arena with optional colliders; the hero stands at the origin. `setup` edits the seed before the engine is built (the engine clones its seed). */
export function flatBench(options: { colliders?: readonly RegionColliderDefinition[]; half?: number; setup?: (state: EngineState) => void } = {}): CombatEngine {
  const half = options.half ?? 30;
  const bounds: Bounds3 = { min: vec(-half, -2, -half), max: vec(half, 12, half) };
  const floor: GroundSurfaceDefinition = {
    id: 'floor', profile: 'plane', points: [vec(-half, 0, -half), vec(half, 0, -half), vec(half, 0, half), vec(-half, 0, half)],
    elevation: 0, walkable: true, material: 'soil', colliderId: 'floor-collider',
  };
  const fixture = { bounds, ground: { y: 0, profile: 'flat', navGraphId: 'fixture', surfaces: [floor], colliders: options.colliders ?? [] }, traversalArcs: [], id: 'blood-bamboo-valley', navigation: { nodes: [] } };
  const state = createEngineState();
  state.arena = arenaFromRegion(fixture as never);
  state.regionId = 'blood-bamboo-valley';
  state.runId = 'flat-bench';
  state.player.vitality = state.player.maxVitality = 10_000;
  options.setup?.(state);
  return new CombatEngine(state);
}
export function actor(id: string, archetype: string, species: string, allegiance: CombatActor['allegiance'], at: Vec3, large = false): CombatActor {
  return makeActor(id as ActorId, species, allegiance, at, large, false, 100, archetype as ActorId);
}
