import { describe, expect, it } from 'bun:test';
import type { ActorId, Bounds3, GroundSurfaceDefinition, Vec3 } from '../../src/game/contracts.js';
import type { CombatActor, EngineState } from '../../src/game/combat/CombatEngine.js';
import { arenaFromRegion } from '../../src/game/combat/geometry.js';
import { commandCompanion, createCompanionState, stepCompanions } from '../../src/game/companions/CompanionSystem.js';

const bounds: Bounds3 = { min: { x: -12, y: -2, z: -12 }, max: { x: 12, y: 8, z: 12 } };
const floor: GroundSurfaceDefinition = {
  id: 'floor', profile: 'plane', points: [{ x: -12, y: 0, z: -12 }, { x: 12, y: 0, z: -12 }, { x: 12, y: 0, z: 12 }, { x: -12, y: 0, z: 12 }],
  elevation: 0, walkable: true, material: 'soil', colliderId: 'floor-collider',
};

function makeEngine(companion: 'koro' | 'vara', start: Vec3, player: Vec3): EngineState {
  const actor = (id: string, position: Vec3, allegiance: string, aerial = false) => ({
    id: id as ActorId, species: 'animal', allegiance, position, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: 1 },
    actionId: 'idle', phase: 'idle', normalizedTime: 0, vitality: 100, ferocity: 100, corruption: 100, targetId: undefined,
    visible: true, downed: false, possessedUntil: 0, radius: 0.3, collisionHeight: 1, maxVitality: 100, large: false, aerial,
    recoveringUntil: 0, invulnerableUntil: 0, staggerUntil: 0, actionStartedTick: 0, actionEndsTick: 0,
  } as unknown as CombatActor);
  const region = { bounds, ground: { y: 0, profile: 'flat', navGraphId: 'fixture', surfaces: [floor], colliders: [] }, traversalArcs: [], id: 'greenwake', navigation: { nodes: [] } };
  return {
    tick: 0, worldTick: 0, worldTimeScale: 1, runId: 'companion-locomotion', playerId: 'aren', player: {}, regionId: 'greenwake', encounter: null,
    worldFacts: {}, actors: [actor('aren', player, 'player'), actor(companion, start, 'ally', companion === 'vara')],
    arena: arenaFromRegion(region as never), movableObjects: [], companionState: createCompanionState(companion, 1), events: [], traversalGates: [],
    presentationCues: [], seenWorldKeys: [], worldEvents: [], hazards: [], telegraphs: [],
    chapter: { triggers: [], inside: [], intents: [], traps: [] },
  } as unknown as EngineState;
}

function step(engine: EngineState, ticks: number, each?: (tick: number) => void): void {
  for (let i = 0; i < ticks; i++) { engine.tick++; engine.worldTick++; stepCompanions(engine); each?.(i); }
}
const planar = (v: Vec3): number => Math.hypot(v.x, v.z);
const yawOf = (v: Vec3): number => Math.atan2(v.x, v.z);

describe('companion locomotion writes velocity and facing', () => {
  it('ramps a grounded companion up to its cruise speed in about a fifth of a second and points it along the travel direction', () => {
    const engine = makeEngine('koro', { x: -8, y: 0, z: 0 }, { x: 8, y: 0, z: 0 });
    const koro = engine.actors.find(actor => actor.id === 'koro')!;
    const speeds: number[] = [];
    let previousYaw = yawOf(koro.facing), peakTurn = 0;
    step(engine, 40, () => {
      speeds.push(planar(koro.velocity));
      const yaw = yawOf(koro.facing);
      peakTurn = Math.max(peakTurn, Math.abs(Math.atan2(Math.sin(yaw - previousYaw), Math.cos(yaw - previousYaw))));
      previousYaw = yaw;
    });
    // 0.0045 m per tick of ramp = 0.27 m/s; the cruise stride is 0.055 m per tick = 3.3 m/s.
    expect(speeds[0]!).toBeCloseTo(0.27, 6);
    for (let i = 1; i < speeds.length; i++) expect(speeds[i]! - speeds[i - 1]!).toBeLessThan(0.27 + 1e-6);
    expect(speeds[11]!).toBeCloseTo(3.24, 6);
    expect(speeds[12]!).toBeCloseTo(3.3, 6);
    expect(speeds[39]!).toBeCloseTo(3.3, 6);
    // The follow point is 1.3 m behind and 1.2 m beside the player, so the path leans a little toward +Z.
    expect(koro.velocity.x).toBeGreaterThan(3.2);
    expect(koro.velocity.z).toBeGreaterThan(0.1);
    // Facing started at +Z and turned about 85° toward the travel direction at no more than 0.17 rad per tick.
    expect(peakTurn).toBeLessThanOrEqual(0.17 + 1e-9);
    expect(peakTurn).toBeGreaterThan(0.1);
    expect(yawOf(koro.facing)).toBeCloseTo(yawOf(koro.velocity), 6);
    expect(yawOf(koro.facing)).toBeGreaterThan(1.3);
    expect(Math.hypot(koro.facing.x, koro.facing.z)).toBeCloseTo(1, 9);
  });

  it('reports world-time velocity under slowed time and coasts to a standstill after arriving, keeping its heading', () => {
    const engine = makeEngine('koro', { x: -4, y: 0, z: 0 }, { x: 2, y: 0, z: 0 });
    const koro = engine.actors.find(actor => actor.id === 'koro')!;
    engine.worldTimeScale = 0.5;
    step(engine, 30);
    expect(planar(koro.velocity)).toBeCloseTo(3.3, 6);
    engine.worldTimeScale = 1;
    let arrived = -1;
    let headingWhileMoving = 0;
    step(engine, 400, (tick) => {
      if (planar(koro.velocity) > 1) headingWhileMoving = yawOf(koro.facing);
      if (arrived < 0 && tick > 30 && planar(koro.velocity) < 0.5) arrived = tick;
    });
    expect(arrived).toBeGreaterThan(0);
    step(engine, 30);
    expect(koro.velocity).toEqual({ x: 0, y: 0, z: 0 });
    const resting = { ...koro.position };
    step(engine, 10);
    expect(koro.position).toEqual(resting);
    expect(yawOf(koro.facing)).toBeCloseTo(headingWhileMoving, 6);
  });

  it('decays rather than snaps the reported velocity when a companion is told to stay', () => {
    const engine = makeEngine('koro', { x: -8, y: 0, z: 0 }, { x: 8, y: 0, z: 0 });
    const koro = engine.actors.find(actor => actor.id === 'koro')!;
    step(engine, 30);
    const cruising = planar(koro.velocity);
    expect(cruising).toBeGreaterThan(3);
    expect(commandCompanion(engine, { companionId: 'koro', command: 'stay' })).toBe(true);
    step(engine, 1);
    expect(planar(koro.velocity)).toBeCloseTo(cruising * 0.55, 6);
    step(engine, 30);
    expect(koro.velocity).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('gives an aerial companion a 3D velocity toward its hover point and a horizontal heading', () => {
    const engine = makeEngine('vara', { x: -8, y: 0, z: 0 }, { x: 8, y: 0, z: 0 });
    const vara = engine.actors.find(actor => actor.id === 'vara')!;
    step(engine, 40);
    expect(vara.velocity.x).toBeGreaterThan(2);
    expect(vara.velocity.y).toBeGreaterThan(0.1);
    expect(Math.hypot(vara.velocity.x, vara.velocity.y, vara.velocity.z)).toBeCloseTo(3.3, 6);
    expect(vara.facing.y).toBe(0);
    expect(yawOf(vara.facing)).toBeCloseTo(Math.atan2(vara.velocity.x, vara.velocity.z), 6);
  });
});
