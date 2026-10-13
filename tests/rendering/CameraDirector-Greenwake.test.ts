import assert from "node:assert/strict";
import test from "node:test";
import { Scene, Vector3 } from "three";
import { CameraDirector } from "../../src/rendering/CameraDirector.js";
import type { CombatSnapshot, ActorSnapshot } from "../../src/game/contracts.js";

const epsilon = 1e-4;

function makeSnapshot(playerPosition: { x: number; y: number; z: number }): CombatSnapshot {
  const aren: ActorSnapshot = {
    id: "aren" as never,
    archetypeId: "aren" as never,
    species: "human",
    allegiance: "player",
    position: playerPosition,
    velocity: { x: 0, y: 0, z: 0 },
    facing: { x: 0, y: 0, z: -1 },
    actionId: "aren-idle" as never,
    phase: "idle",
    normalizedTime: 0,
    sockets: {},
    interactionRequirements: [],
    visible: true,
    downed: false,
    possessed: false,
  };
  return {
    actors: [aren],
    movableObjects: [],
    worldClock: { simulationTick: 0, worldTick: 0, worldTimeSeconds: 0, timeScale: 1, policy: 'normal' },
    player: { vitality: 100, maxVitality: 100, instinct: 0, mana: 100, maxMana: 100 }, skills: [],
    telegraphs: [],
    hazards: [],
    events: [],
  };
}

test("Aren stays centered through movement, elevation, encounters and telegraphs without reframing", () => {
  const director = new CameraDirector(new Scene());
  const focus = new Vector3();
  const originalRotation = director.camera.quaternion.clone();
  let priorPosition: Vector3 | undefined;
  let priorCamera: Vector3 | undefined;
  for (const position of [
    { x: -18, y: 0, z: -9 },
    { x: -17.93, y: 0, z: -8.93 },
    { x: 10, y: 2.8, z: 17 },
    { x: 72, y: 0, z: 38 },
  ]) {
    const snapshot = makeSnapshot(position);
    snapshot.encounterId = 'greenwake-boar';
    snapshot.telegraphs = [{ id: 'warning', attackId: 'strike' as never, sourceId: 'boar', targetPosition: position, phase: 'anticipation', remainingTicks: 20 }];
    director.update(snapshot);
    director.copyTarget(focus);
    const projected = focus.clone().project(director.camera);
    assert.ok(Math.abs(projected.x) < epsilon && Math.abs(projected.y) < epsilon, 'torso focus projects to the viewport center');
    assert.ok(director.camera.quaternion.angleTo(originalRotation) < epsilon, 'camera orientation never changes with movement or warnings');
    if (priorPosition && priorCamera) {
      const movement = new Vector3(position.x, position.y, position.z).sub(priorPosition);
      assert.ok(director.camera.position.clone().sub(priorCamera).distanceTo(movement) < epsilon, 'camera follows exactly, without positional chase lag');
    }
    priorPosition = new Vector3(position.x, position.y, position.z);
    priorCamera = director.camera.position.clone();
  }
});

test("camera centers the rendered pose rather than the next authoritative simulation tick", () => {
  const director = new CameraDirector(new Scene());
  const rendered = { x: 0.03, y: 0.4, z: -0.04 };
  director.update(makeSnapshot({ x: 0.1, y: 0.5, z: -0.1 }), rendered);
  const onScreen = new Vector3(rendered.x, rendered.y + 0.85, rendered.z).project(director.camera);
  assert.ok(Math.abs(onScreen.x) < epsilon && Math.abs(onScreen.y) < epsilon);
});

test("screen-relative movement basis maps forward to screen-up and right to screen-right", () => {
  const director = new CameraDirector(new Scene());
  director.update(makeSnapshot({ x: 5, y: 2, z: 6 }));
  const target = new Vector3();
  director.copyTarget(target);
  const forward = target.clone().add(director.forward).project(director.camera);
  const right = target.clone().add(director.right).project(director.camera);
  assert.ok(Math.abs(forward.x) < epsilon && forward.y > 0);
  assert.ok(right.x > 0 && Math.abs(right.y) < epsilon);
  assert.ok(Math.abs(director.forward.dot(director.right)) < epsilon);
});