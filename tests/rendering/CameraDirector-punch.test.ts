import { describe, expect, it } from 'bun:test';
import { Scene } from 'three';
import { CameraDirector } from '../../src/rendering/CameraDirector.js';
import type { ActorSnapshot, CombatSnapshot } from '../../src/game/contracts.js';

function snapshot(hitStop?: { remainingTicks: number; strength: number }): CombatSnapshot {
  const aren = {
    id: 'aren', archetypeId: 'aren', species: 'human', allegiance: 'player', position: { x: 2, y: 0.4, z: -3 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: -1 },
    actionId: 'aren-idle', phase: 'idle', normalizedTime: 0, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false,
  } as unknown as ActorSnapshot;
  return {
    actors: [aren], movableObjects: [], worldClock: { simulationTick: 0, worldTick: 0, worldTimeSeconds: 0, timeScale: 1, policy: 'normal' }, hitStop,
    player: { vitality: 100, maxVitality: 100, instinct: 0, mana: 100, maxMana: 100 }, skills: [], telegraphs: [], hazards: [], events: [],
  } as unknown as CombatSnapshot;
}

describe('camera hit-stop punch-in', () => {
  it('pushes toward Aren along the view axis while the world is stopped and eases back, never touching orientation or the input basis', () => {
    const director = new CameraDirector(new Scene()), calm = snapshot(), stopped = snapshot({ remainingTicks: 5, strength: 0.7 });
    director.update(calm, undefined, 0);
    const rest = director.camera.position.clone(), orientation = director.camera.quaternion.clone(), forward = director.forward.clone(), right = director.right.clone();
    const toTarget = director.camera.getWorldDirection(rest.clone());
    let peak = 0;
    for (let frame = 0; frame < 6; frame++) {
      director.update(stopped, undefined, 1 / 60);
      peak = Math.max(peak, director.punchMagnitude);
      expect(director.camera.quaternion.angleTo(orientation)).toBeLessThan(1e-6);
      expect(director.forward.distanceTo(forward)).toBe(0);
      expect(director.right.distanceTo(right)).toBe(0);
      const moved = director.camera.position.clone().sub(rest);
      expect(moved.length()).toBeCloseTo(director.punchMagnitude, 6);
      if (moved.length() > 1e-6) expect(moved.normalize().dot(toTarget)).toBeCloseTo(1, 6);
    }
    expect(peak).toBeGreaterThan(0.25);
    expect(peak).toBeLessThanOrEqual(0.9 + 1e-9);
    for (let frame = 0; frame < 90; frame++) director.update(calm, undefined, 1 / 60);
    expect(director.punchMagnitude).toBe(0);
    expect(director.camera.position.distanceTo(rest)).toBeLessThan(1e-9);
  });

  it('caps the punch, ignores a non-positive hit-stop and is disabled by reduced motion', () => {
    const director = new CameraDirector(new Scene());
    for (let frame = 0; frame < 60; frame++) director.update(snapshot({ remainingTicks: 7, strength: 9 }), undefined, 1 / 60);
    expect(director.punchMagnitude).toBeLessThanOrEqual(0.9 + 1e-9);
    for (let frame = 0; frame < 120; frame++) director.update(snapshot({ remainingTicks: 0, strength: 1 }), undefined, 1 / 60);
    expect(director.punchMagnitude).toBe(0);
    director.setReducedMotion(true);
    for (let frame = 0; frame < 10; frame++) director.update(snapshot({ remainingTicks: 7, strength: 1 }), undefined, 1 / 60);
    expect(director.punchMagnitude).toBe(0);
  });
});
