import { describe, expect, it } from 'bun:test';
import { Scene, Vector3 } from 'three';
import { CameraDirector, type EstablishingFraming } from '../../src/rendering/CameraDirector.js';
import type { ActorSnapshot, CombatSnapshot } from '../../src/game/contracts.js';

const FRAME = 1 / 60;

interface Pose { x: number; y: number; z: number; vx?: number; vz?: number; actionId?: string; normalizedTime?: number }

function snapshot(pose: Pose): CombatSnapshot {
  const aren = {
    id: 'aren', archetypeId: 'aren', species: 'human', allegiance: 'player', position: { x: pose.x, y: pose.y, z: pose.z }, velocity: { x: pose.vx ?? 0, y: 0, z: pose.vz ?? 0 }, facing: { x: 0, y: 0, z: -1 },
    actionId: pose.actionId ?? 'aren-idle', phase: 'idle', normalizedTime: pose.normalizedTime ?? 0, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false,
  } as unknown as ActorSnapshot;
  return {
    actors: [aren], movableObjects: [], worldClock: { simulationTick: 0, worldTick: 0, worldTimeSeconds: 0, timeScale: 1, policy: 'normal' },
    player: { vitality: 100, maxVitality: 100, instinct: 0, mana: 100, maxMana: 100 }, skills: [], telegraphs: [], hazards: [], events: [],
  } as unknown as CombatSnapshot;
}

function run(director: CameraDirector, seconds: number, pose: (time: number) => Pose, from = 0): void {
  const frames = Math.round(seconds / FRAME);
  for (let i = 1; i <= frames; i++) { const at = from + i * FRAME, p = pose(at); director.update(snapshot(p), undefined, FRAME); }
}

const settled = (pose: Pose): CameraDirector => {
  const director = new CameraDirector(new Scene());
  director.update(snapshot(pose), undefined, 0);
  run(director, 1, () => pose);
  return director;
};

describe('critically damped height follow', () => {
  it('absorbs a 0.4 m step as a bounded lag that decays monotonically without overshoot and settles inside 0.6 s', () => {
    const director = settled({ x: 0, y: 0, z: 0 });
    const lags: number[] = [];
    for (let i = 0; i < 60; i++) { director.update(snapshot({ x: 0, y: 0.4, z: 0 }), undefined, FRAME); lags.push(director.verticalLag); }
    expect(lags[0]!).toBeLessThanOrEqual(0.4);
    expect(lags[0]!).toBeGreaterThan(0.3);
    for (let i = 1; i < lags.length; i++) {
      expect(lags[i]!).toBeLessThanOrEqual(lags[i - 1]! + 1e-9);
      expect(lags[i]!).toBeGreaterThanOrEqual(-1e-9);
    }
    expect(lags[Math.round(0.35 / FRAME)]!).toBeLessThan(0.04);
    expect(lags[lags.length - 1]!).toBeLessThan(0.004);
    // The ground plane is never lagged: the camera is exactly over the root horizontally.
    const target = new Vector3();
    director.copyTarget(target);
    expect(target.x).toBe(0);
    expect(target.z).toBe(0);
  });

  it('trails a steady 2 m/s climb by 2/ω ≈ 0.133 s of travel and never by more than 0.9 m', () => {
    const director = settled({ x: 0, y: 0, z: 0 });
    run(director, 2.5, (time) => ({ x: 0, y: 2 * time, z: 0 }));
    expect(director.verticalLag).toBeGreaterThan(0.24);
    expect(director.verticalLag).toBeLessThan(0.29);
    const fast = settled({ x: 0, y: 0, z: 0 });
    run(fast, 1, (time) => ({ x: 0, y: 2.9 * time, z: 0 }));
    // A 2.9 m rise inside one second (still below the 3 m teleport snap per frame) is clamped.
    expect(fast.verticalLag).toBeLessThanOrEqual(0.9 + 1e-9);
  });

  it('snaps through a teleport or respawn instead of sweeping the camera across the map', () => {
    const director = settled({ x: 0, y: 0, z: 0 });
    director.update(snapshot({ x: 30, y: 0, z: 0 }), undefined, FRAME);
    const target = new Vector3();
    director.copyTarget(target);
    expect(target.x).toBe(30);
    director.update(snapshot({ x: 30, y: 6, z: 0 }), undefined, FRAME);
    expect(director.verticalLag).toBe(0);
  });

  it('keeps orientation and the screen-relative input basis fixed through all of it', () => {
    const director = settled({ x: 0, y: 0, z: 0 });
    const orientation = director.camera.quaternion.clone(), forward = director.forward.clone(), right = director.right.clone();
    run(director, 2, (time) => ({ x: 6 * time, y: 0.3 * Math.sin(time * 9), z: -3 * time, vx: 6, vz: -3, actionId: 'aren-run' }));
    expect(director.camera.quaternion.angleTo(orientation)).toBeLessThan(1e-9);
    expect(director.forward.distanceTo(forward)).toBe(0);
    expect(director.right.distanceTo(right)).toBe(0);
  });
});

describe('look-ahead', () => {
  it('leads a runner by about 0.5 m along the velocity, never more than 0.55 m, and releases to zero at a standstill', () => {
    const director = settled({ x: 0, y: 0, z: 0 });
    run(director, 2, (time) => ({ x: 6 * time, y: 0, z: 0, vx: 6 }));
    expect(director.lookAheadMagnitude).toBeGreaterThan(0.45);
    expect(director.lookAheadMagnitude).toBeLessThanOrEqual(0.55 + 1e-9);
    const target = new Vector3();
    director.copyTarget(target);
    expect(target.x - 12).toBeCloseTo(director.lookAheadMagnitude, 6);
    expect(target.z).toBeCloseTo(0, 9);
    run(director, 2.5, () => ({ x: 12, y: 0, z: 0 }), 2);
    expect(director.lookAheadMagnitude).toBeLessThan(0.005);
  });

  it('builds up smoothly: no frame changes the look-ahead by more than a few centimetres', () => {
    const director = settled({ x: 0, y: 0, z: 0 });
    let previous = 0, worst = 0;
    for (let i = 1; i <= 120; i++) {
      director.update(snapshot({ x: 6 * i * FRAME, y: 0, z: 0, vx: 6 }), undefined, FRAME);
      worst = Math.max(worst, Math.abs(director.lookAheadMagnitude - previous));
      previous = director.lookAheadMagnitude;
    }
    expect(worst).toBeLessThan(0.02);
  });
});

describe('sprint and dodge FOV kick', () => {
  it('opens the lens by at most 3° while sprinting and returns to the base FOV when the sprint ends', () => {
    const director = settled({ x: 0, y: 0, z: 0 });
    const base = director.camera.fov;
    let peak = 0;
    for (let i = 1; i <= 120; i++) { director.update(snapshot({ x: 6 * i * FRAME, y: 0, z: 0, vx: 6, actionId: 'aren-run' }), undefined, FRAME); peak = Math.max(peak, director.camera.fov - base); }
    expect(peak).toBeGreaterThan(2.9);
    expect(peak).toBeLessThanOrEqual(3 + 1e-9);
    run(director, 2, () => ({ x: 12, y: 0, z: 0 }), 2);
    expect(director.camera.fov).toBe(base);
    expect(director.fovKickDegrees).toBe(0);
  });

  it('leaves a walking pace alone and gives a dodge a brief kick that never exceeds 4° with a sprint', () => {
    const walker = settled({ x: 0, y: 0, z: 0 });
    const base = walker.camera.fov;
    run(walker, 1, (time) => ({ x: 4.1 * time, y: 0, z: 0, vx: 4.1, actionId: 'aren-walk' }));
    expect(walker.camera.fov - base).toBeLessThan(0.01);
    const roller = settled({ x: 0, y: 0, z: 0 });
    let peak = 0;
    for (let i = 1; i <= 24; i++) { roller.update(snapshot({ x: 0, y: 0, z: 0, actionId: 'aren-forward-left-dive-roll', normalizedTime: i / 24 }), undefined, FRAME * 2); peak = Math.max(peak, roller.camera.fov - base); }
    expect(peak).toBeGreaterThan(0.5);
    expect(peak).toBeLessThanOrEqual(2.5 + 1e-9);
    const both = settled({ x: 0, y: 0, z: 0 });
    let total = 0;
    for (let i = 1; i <= 120; i++) { both.update(snapshot({ x: 6 * i * FRAME, y: 0, z: 0, vx: 6, actionId: 'aren-forward-left-dive-roll', normalizedTime: 0.5 }), undefined, FRAME); total = Math.max(total, both.camera.fov - base); }
    expect(total).toBeLessThanOrEqual(4 + 1e-9);
  });
});

describe('reduced motion', () => {
  it('is static: rigid height, no look-ahead, no FOV kick', () => {
    const director = new CameraDirector(new Scene());
    director.setReducedMotion(true);
    const base = director.camera.fov;
    director.update(snapshot({ x: 0, y: 0, z: 0 }), undefined, 0);
    for (let i = 1; i <= 120; i++) {
      director.update(snapshot({ x: 6 * i * FRAME, y: i % 40 === 0 ? 0.4 : 0, z: 0, vx: 6, actionId: 'aren-run' }), undefined, FRAME);
      expect(director.lookAheadMagnitude).toBe(0);
      expect(director.verticalLag).toBe(0);
      expect(director.camera.fov).toBe(base);
    }
    const target = new Vector3();
    director.copyTarget(target);
    expect(target.x).toBeCloseTo(6 * 120 * FRAME, 9);
  });

  it('turns the effects off the moment reduced motion is enabled', () => {
    const director = settled({ x: 0, y: 0, z: 0 });
    run(director, 1, (time) => ({ x: 6 * time, y: 0, z: 0, vx: 6, actionId: 'aren-run' }));
    expect(director.lookAheadMagnitude).toBeGreaterThan(0.3);
    director.setReducedMotion(true);
    expect(director.lookAheadMagnitude).toBe(0);
    expect(director.fovKickDegrees).toBe(0);
  });
});

describe('establishing shot', () => {
  const framing: EstablishingFraming = { center: { x: 20, y: 0, z: -10 }, radius: 52, height: 47, sweep: 1.9 };
  const start = (director: CameraDirector, seconds = 4, reducedMotion = false): boolean => director.beginEstablishingShot({ ...framing, seconds, reducedMotion });

  it('opens on a high wide orbit, descends monotonically and ends exactly on the gameplay pose with no pop', () => {
    const director = settled({ x: 3, y: 0, z: 2 });
    const gameplayPosition = director.camera.position.clone(), gameplayOrientation = director.camera.quaternion.clone(), baseFov = director.camera.fov;
    expect(start(director)).toBe(true);
    expect(director.establishingShotActive).toBe(true);
    expect(director.camera.position.distanceTo(gameplayPosition)).toBeGreaterThan(60);
    expect(director.camera.position.y).toBeGreaterThan(40);
    let previous = director.camera.position.distanceTo(gameplayPosition), worstStep = 0, previousPosition = director.camera.position.clone(), frames = 0;
    while (director.establishingShotActive && frames < 600) {
      director.advanceEstablishingShot(FRAME);
      frames++;
      const distance = director.camera.position.distanceTo(gameplayPosition);
      expect(distance).toBeLessThanOrEqual(previous + 1e-9);
      worstStep = Math.max(worstStep, director.camera.position.distanceTo(previousPosition));
      previous = distance; previousPosition = director.camera.position.clone();
    }
    // 4 s at 60 fps (the accumulated float sum lands on frame 240 or 241).
    expect(frames).toBeGreaterThanOrEqual(240);
    expect(frames).toBeLessThanOrEqual(241);
    expect(director.establishingShotActive).toBe(false);
    expect(director.camera.position.distanceTo(gameplayPosition)).toBeLessThan(1e-9);
    expect(director.camera.quaternion.angleTo(gameplayOrientation)).toBeLessThan(1e-9);
    expect(director.camera.fov).toBe(baseFov);
    // The ease has zero slope at the end: the last frames move the camera by far less than the fastest frame.
    expect(director.camera.position.distanceTo(previousPosition)).toBeLessThan(worstStep * 0.01);
    // After the shot a normal update frames the player exactly as before.
    director.update(snapshot({ x: 3, y: 0, z: 2 }), undefined, FRAME);
    expect(director.camera.position.distanceTo(gameplayPosition)).toBeLessThan(1e-9);
  });

  it('exposes the eased progress the renderer eases the fog with: 0 at the start, 0.5 halfway, 1 at the end and whenever no shot runs', () => {
    const director = settled({ x: 0, y: 0, z: 0 });
    expect(director.establishingShotEase).toBe(1);
    start(director, 4);
    expect(director.establishingShotEase).toBe(0);
    director.advanceEstablishingShot(2);
    expect(director.establishingShotEase).toBeCloseTo(0.5, 12);
    director.advanceEstablishingShot(1);
    expect(director.establishingShotEase).toBeCloseTo(1 - (-2 * 0.75 + 2) ** 3 / 2, 12);
    director.advanceEstablishingShot(1);
    expect(director.establishingShotActive).toBe(false);
    expect(director.establishingShotEase).toBe(1);
  });

  it('skip jumps straight to the gameplay framing', () => {
    const director = settled({ x: -5, y: 1, z: 4 });
    const gameplayPosition = director.camera.position.clone(), gameplayOrientation = director.camera.quaternion.clone();
    start(director);
    director.advanceEstablishingShot(1);
    expect(director.camera.position.distanceTo(gameplayPosition)).toBeGreaterThan(20);
    director.skipEstablishingShot();
    expect(director.establishingShotActive).toBe(false);
    expect(director.camera.position.distanceTo(gameplayPosition)).toBeLessThan(1e-9);
    expect(director.camera.quaternion.angleTo(gameplayOrientation)).toBeLessThan(1e-9);
    director.skipEstablishingShot();
    expect(director.establishingShotActive).toBe(false);
  });

  it('is a no-op under reduced motion (option or setting) and for a non-positive duration', () => {
    const director = settled({ x: 0, y: 0, z: 0 });
    const gameplayPosition = director.camera.position.clone();
    expect(start(director, 4, true)).toBe(false);
    expect(start(director, 0)).toBe(false);
    expect(start(director, -1)).toBe(false);
    expect(director.establishingShotActive).toBe(false);
    expect(director.camera.position.distanceTo(gameplayPosition)).toBe(0);
    director.setReducedMotion(true);
    expect(start(director)).toBe(false);
    expect(director.establishingShotActive).toBe(false);
  });

  it('ends if reduced motion is switched on mid-shot, and keeps the input basis fixed throughout', () => {
    const director = settled({ x: 0, y: 0, z: 0 });
    const forward = director.forward.clone(), right = director.right.clone();
    start(director);
    director.advanceEstablishingShot(1.5);
    expect(director.forward.distanceTo(forward)).toBe(0);
    expect(director.right.distanceTo(right)).toBe(0);
    director.setReducedMotion(true);
    expect(director.establishingShotActive).toBe(false);
  });

  it('keeps tracking the player while a snapshot update arrives mid-shot and still lands on the gameplay pose', () => {
    const director = settled({ x: 0, y: 0, z: 0 });
    start(director, 2);
    for (let i = 0; i < 60; i++) { director.update(snapshot({ x: 0, y: 0, z: 0 }), undefined, FRAME); director.advanceEstablishingShot(FRAME); }
    expect(director.establishingShotProgress).toBeCloseTo(0.5, 6);
    for (let i = 0; i < 70; i++) { director.update(snapshot({ x: 0, y: 0, z: 0 }), undefined, FRAME); director.advanceEstablishingShot(FRAME); }
    expect(director.establishingShotActive).toBe(false);
    const rest = settled({ x: 0, y: 0, z: 0 });
    expect(director.camera.position.distanceTo(rest.camera.position)).toBeLessThan(1e-9);
  });
});
