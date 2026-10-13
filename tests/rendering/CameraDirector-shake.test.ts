import { describe, expect, it } from 'bun:test';
import { Scene, Vector3 } from 'three';
import { CameraDirector } from '../../src/rendering/CameraDirector.js';
import type { ActorSnapshot, CombatSnapshot } from '../../src/game/contracts.js';

function snapshot(x: number, z: number): CombatSnapshot {
  const aren = {
    id: 'aren', archetypeId: 'aren', species: 'human', allegiance: 'player', position: { x, y: 0.4, z }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: -1 },
    actionId: 'aren-idle', phase: 'idle', normalizedTime: 0, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false,
  } as unknown as ActorSnapshot;
  return {
    actors: [aren], movableObjects: [], worldClock: { simulationTick: 0, worldTick: 0, worldTimeSeconds: 0, timeScale: 1, policy: 'normal' },
    player: { vitality: 100, maxVitality: 100, instinct: 0, mana: 100, maxMana: 100 }, skills: [], telegraphs: [], hazards: [], events: [],
  } as unknown as CombatSnapshot;
}

describe('camera impact shake', () => {
  it('offsets only the presented camera position, never the input basis or orientation, and decays to zero', () => {
    const director = new CameraDirector(new Scene());
    const forward = director.forward.clone(), right = director.right.clone();
    const combat = snapshot(2, -3);
    director.update(combat, undefined, 0);
    const rest = director.camera.position.clone(), orientation = director.camera.quaternion.clone();
    director.addShake(0.3, 0.5, 20);
    let peak = 0;
    for (let frame = 0; frame < 45; frame++) {
      director.update(combat, undefined, 1 / 60);
      peak = Math.max(peak, director.camera.position.distanceTo(rest));
      expect(director.forward.distanceTo(forward)).toBe(0);
      expect(director.right.distanceTo(right)).toBe(0);
      expect(director.camera.quaternion.angleTo(orientation)).toBeLessThan(1e-9);
      expect(director.camera.position.distanceTo(rest)).toBeLessThanOrEqual(0.6 + 1e-9);
    }
    expect(peak).toBeGreaterThan(0.02);
    expect(director.shakeMagnitude).toBe(0);
    expect(director.camera.position.distanceTo(rest)).toBeLessThan(1e-9);
  });

  it('keeps the shake in the camera plane so the follow target stays on the view axis offset only sideways/up', () => {
    const director = new CameraDirector(new Scene());
    const combat = snapshot(0, 0);
    director.update(combat, undefined, 0);
    const rest = director.camera.position.clone();
    const viewAxis = new Vector3(0, 0, -1).applyQuaternion(director.camera.quaternion);
    director.addShake(0.4, 1, 12);
    director.update(combat, undefined, 0.05);
    const offset = director.camera.position.clone().sub(rest);
    expect(offset.length()).toBeGreaterThan(0);
    expect(Math.abs(offset.dot(viewAxis))).toBeLessThan(1e-9);
  });

  it('is disabled by reduced motion, which also cancels a running shake', () => {
    const director = new CameraDirector(new Scene());
    const combat = snapshot(1, 1);
    director.update(combat, undefined, 0);
    const rest = director.camera.position.clone();
    director.addShake(0.3, 1, 18);
    director.update(combat, undefined, 1 / 60);
    director.setReducedMotion(true);
    director.update(combat, undefined, 1 / 60);
    expect(director.camera.position.distanceTo(rest)).toBeLessThan(1e-9);
    director.addShake(0.5, 1, 18);
    director.update(combat, undefined, 1 / 60);
    expect(director.camera.position.distanceTo(rest)).toBeLessThan(1e-9);
  });
});
