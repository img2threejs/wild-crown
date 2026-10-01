import { describe, expect, it } from "bun:test";
import { COLLISION_BOUNDS, FIXED_STEP, createState, routeProgress, stepSimulation, syncRenderHistory } from "../../src/lab/simulation.js";

describe("R01 guided movement limits", () => {
  it("normalizes diagonal input to the same speed as cardinal input", () => {
    const straight = createState();
    const diagonal = createState();
    stepSimulation(straight, { x: 1, z: 0 }, FIXED_STEP);
    stepSimulation(diagonal, { x: 1, z: -1 }, FIXED_STEP);
    expect(Math.hypot(diagonal.velocity.x, diagonal.velocity.z)).toBeCloseTo(
      Math.hypot(straight.velocity.x, straight.velocity.z),
    );
  });

  it("stops at the authored divider after a bounded sweep", () => {
    const divider = COLLISION_BOUNDS[0]!;
    const state = createState();
    for (let tick = 0; tick < 480; tick++) stepSimulation(state, { x: 0, z: -1 }, FIXED_STEP);
    expect(state.position.z).toBeGreaterThan(divider.maxZ);
    expect(state.position.z).toBeLessThan(divider.maxZ + 0.5);
    expect(state.position.y).toBe(0);
  });

  it("slides along an authored obstacle without penetrating it or leaving the ground", () => {
    const obstacle = COLLISION_BOUNDS[3]!;
    const state = createState();
    const startZ = (obstacle.minZ + obstacle.maxZ) / 2;
    state.position.set(obstacle.minX - 1, 0, startZ);
    state.previous.copy(state.position);

    for (let tick = 0; tick < 12; tick++) stepSimulation(state, { x: 1, z: 1 }, FIXED_STEP);

    expect(state.position.x).toBeLessThan(obstacle.minX);
    expect(state.position.z).toBeGreaterThan(startZ);
    expect(state.position.y).toBe(0);
  });

  it("resets interpolation history before a resumed frame", () => {
    const state = createState();
    stepSimulation(state, { x: 0, z: -1 }, FIXED_STEP);
    const currentZ = state.position.z;
    const staleZ = state.previous.z + (currentZ - state.previous.z) * 0.25;

    expect(staleZ).toBeGreaterThan(currentZ);
    syncRenderHistory(state);
    const resumedZ = state.previous.z + (state.position.z - state.previous.z) * 0.25;
    expect(resumedZ).toBe(currentZ);
    expect(state.previousHeading).toBe(state.heading);
  });

  it("clamps route progress at the start and authored clearing endpoint", () => {
    const state = createState();
    expect(routeProgress(state)).toBe(0);
    state.position.z = -25;
    expect(routeProgress(state)).toBe(1);
    state.position.z = -100;
    expect(routeProgress(state)).toBe(1);
    state.position.z = 100;
    expect(routeProgress(state)).toBe(0);
  });
});
