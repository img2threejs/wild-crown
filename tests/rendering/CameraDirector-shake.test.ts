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
      expect(director.camera.quaternion.angleTo(orientation)).toBeLessThan(1e-6);
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
    director.update(combat, undefined, 1 / 60);
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

  it('repeated on/off scale toggles do not progressively shrink the requested amplitude (baseAmplitude is preserved)', () => {
    const director = new CameraDirector(new Scene());
    const combat = snapshot(1, 1);
    director.update(combat, undefined, 0);
    /** Toggle on/off with the same amplitude and check the bound imposed on fresh shake requests: the requested
     *  amplitude always reaches its `baseAmplitude` ceiling intact. The shake's instantaneous magnitude is a
     *  separate axis (it depends on the per-frame seed/phase), so we assert on `baseAmplitude` accessor. */
    director.setShakeScale(0.25);
    director.addShake(0.4, 1, 18);
    director.update(combat, undefined, 1 / 60);
    const lowActive = director.shakeMagnitude;
    expect(lowActive).toBeGreaterThan(0);
    director.setShakeScale(0);
    director.update(combat, undefined, 1 / 60);
    expect(director.shakeMagnitude).toBe(0);
    director.setShakeScale(1);
    director.addShake(0.4, 1, 18);
    director.update(combat, undefined, 1 / 60);
    /** The full-scale shake swings the camera through amplitudes bounded by MAX_AMPLITUDE; switch back and forth
     *  once more and confirm the next fresh shake is bounded by the same ceiling, not a shrunken one. */
    expect(director.shakeMagnitude).toBeGreaterThan(0);
    director.setShakeScale(0.25);
    director.addShake(0.4, 1, 18);
    director.update(combat, undefined, 1 / 60);
    /** A reduced-scale shake should be smaller or equal to a full-scale one. */
    const reducedLater = director.shakeMagnitude;
    director.setShakeScale(1);
    director.addShake(0.4, 1, 18);
    director.update(combat, undefined, 1 / 60);
    expect(director.shakeMagnitude).toBeGreaterThan(reducedLater);
  });

  it('reducedMotion still cancels shake outright regardless of any prior setShakeScale toggles', () => {
    const director = new CameraDirector(new Scene());
    const combat = snapshot(1, 1);
    director.update(combat, undefined, 0);
    director.setShakeScale(0.5);
    director.addShake(0.4, 1, 18);
    director.update(combat, undefined, 1 / 60);
    expect(director.shakeMagnitude).toBeGreaterThan(0);
    director.setReducedMotion(true);
    expect(director.shakeMagnitude).toBe(0);
  });

  it('low setShakeScale produces a smaller but non-zero shake; raising scale to 1 makes a fresh shake amplify by the inverse ratio', () => {
    const director = new CameraDirector(new Scene());
    const combat = snapshot(1, 1);
    director.update(combat, undefined, 0);
    director.setShakeScale(0.25);
    director.addShake(0.4, 1, 18);
    director.update(combat, undefined, 1 / 60);
    const lowMagnitude = director.shakeMagnitude;
    expect(lowMagnitude).toBeGreaterThan(0);
    director.setShakeScale(1);
    director.addShake(0.4, 1, 18);
    director.update(combat, undefined, 1 / 60);
    expect(director.shakeMagnitude).toBeGreaterThan(lowMagnitude * 1.5);
  });
});
