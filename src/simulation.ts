import * as THREE from 'three';

export const FIXED_STEP = 1 / 60;
export const MAX_CATCH_UP_STEPS = 5;
const WALK_SPEED = 4.15;
const TURN_RATE = 11;
const PLAYER_RADIUS = 0.42;
const ARENA_Z = -25;

export interface InputFrame { x: number; z: number }
export interface Bounds { minX: number; maxX: number; minZ: number; maxZ: number }
export interface SimState { position: THREE.Vector3; previous: THREE.Vector3; velocity: THREE.Vector3; heading: number; previousHeading: number; distance: number }

export const COLLISION_BOUNDS: readonly Bounds[] = [
  { minX: -5.8, maxX: 5.8, minZ: -14.8, maxZ: -14.25 },
  { minX: -5.8, maxX: -5.25, minZ: -14.8, maxZ: -10.2 },
  { minX: 5.25, maxX: 5.8, minZ: -14.8, maxZ: -10.2 },
  { minX: -2.7, maxX: -1.55, minZ: -5.6, maxZ: -4.35 },
  { minX: 1.35, maxX: 2.5, minZ: -10.4, maxZ: -9.1 },
  { minX: -7.8, maxX: -0.7, minZ: 6.2, maxZ: 6.65 },
  { minX: 0.7, maxX: 7.8, minZ: 6.2, maxZ: 6.65 },
];

export function createState(): SimState {
  return { position: new THREE.Vector3(0, 0, 12), previous: new THREE.Vector3(0, 0, 12), velocity: new THREE.Vector3(), heading: Math.PI, previousHeading: Math.PI, distance: 0 };
}
function clamp(value: number, low: number, high: number): number { return Math.max(low, Math.min(high, value)); }
function blocked(x: number, z: number): boolean {
  if (x < -8 + PLAYER_RADIUS || x > 8 - PLAYER_RADIUS || z < -30.5 + PLAYER_RADIUS || z > 13.5 - PLAYER_RADIUS) return true;
  return COLLISION_BOUNDS.some(bound => {
    const closestX = clamp(x, bound.minX, bound.maxX);
    const closestZ = clamp(z, bound.minZ, bound.maxZ);
    const dx = x - closestX;
    const dz = z - closestZ;
    return dx * dx + dz * dz < PLAYER_RADIUS * PLAYER_RADIUS;
  });
}

/** Grounded horizontal capsule proxy. Axis-separated steps slide on one axis; no jump, steps, or slopes. */
export function stepSimulation(state: SimState, input: InputFrame, dt = FIXED_STEP): void {
  state.previous.copy(state.position); state.previousHeading = state.heading;
  const length = Math.hypot(input.x, input.z); const scale = length > 1 ? 1 / length : 1;
  const dx = input.x * scale * WALK_SPEED * dt; const dz = input.z * scale * WALK_SPEED * dt;
  const oldX = state.position.x; const oldZ = state.position.z;
  if (!blocked(oldX + dx, oldZ)) state.position.x = oldX + dx;
  if (!blocked(state.position.x, oldZ + dz)) state.position.z = oldZ + dz;
  state.position.y = 0;
  state.velocity.set((state.position.x - oldX) / dt, 0, (state.position.z - oldZ) / dt);
  if (length > 0.08 && state.velocity.lengthSq() > 0.01) {
    const desired = Math.atan2(state.velocity.x, state.velocity.z);
    const delta = THREE.MathUtils.euclideanModulo(desired - state.heading + Math.PI, Math.PI * 2) - Math.PI;
    state.heading += clamp(delta, -TURN_RATE * dt, TURN_RATE * dt);
  }
  state.distance = Math.max(state.distance, Math.max(0, 12 - state.position.z));
}
export function routeProgress(state: SimState): number { return clamp((12 - state.position.z) / (12 - ARENA_Z), 0, 1); }
export interface InputSource { sample(cameraYaw: number): InputFrame; dispose(): void }

export class InputController implements InputSource {
  private readonly keys = new Set<string>();
  private enabled = false;
  private readonly onDown = (event: KeyboardEvent): void => {
    if (!this.enabled || event.repeat) return;
    const key = event.key.toLowerCase();
    if (['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright'].includes(key)) event.preventDefault();
    this.keys.add(key);
  };
  private readonly onUp = (event: KeyboardEvent): void => { this.keys.delete(event.key.toLowerCase()); };
  private readonly onBlur = (): void => { this.clear(); };
  private readonly onVisibility = (): void => { if (document.hidden) this.clear(); };
  private readonly onFocusTarget = (): void => { this.enabled = true; };
  private readonly onBlurTarget = (): void => { this.enabled = false; this.clear(); };
  constructor(private readonly target: HTMLElement) {
    window.addEventListener('keydown', this.onDown); window.addEventListener('keyup', this.onUp); window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibility); target.addEventListener('focus', this.onFocusTarget); target.addEventListener('blur', this.onBlurTarget);
  }
  focus(): void { this.target.focus({ preventScroll: true }); }
  clear(): void { this.keys.clear(); }
  sample(cameraYaw: number): InputFrame {
    if (!this.enabled) return { x: 0, z: 0 };
    let x = Number(this.keys.has('d') || this.keys.has('arrowright')) - Number(this.keys.has('a') || this.keys.has('arrowleft'));
    let forward = Number(this.keys.has('w') || this.keys.has('arrowup')) - Number(this.keys.has('s') || this.keys.has('arrowdown'));
    for (const pad of navigator.getGamepads?.() ?? []) {
      if (!pad) continue;
      const sx = pad.axes[0] ?? 0; const sy = pad.axes[1] ?? 0;
      if (Math.hypot(sx, sy) > 0.18) { x += sx; forward -= sy; }
    }
    const magnitude = Math.hypot(x, forward);
    if (magnitude > 1) { x /= magnitude; forward /= magnitude; }
    const forwardX = -Math.sin(cameraYaw); const forwardZ = -Math.cos(cameraYaw);
    const rightX = Math.cos(cameraYaw); const rightZ = -Math.sin(cameraYaw);
    return { x: rightX * x + forwardX * forward, z: rightZ * x + forwardZ * forward };
  }
  dispose(): void {
    this.clear(); window.removeEventListener('keydown', this.onDown); window.removeEventListener('keyup', this.onUp); window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibility); this.target.removeEventListener('focus', this.onFocusTarget); this.target.removeEventListener('blur', this.onBlurTarget);
  }
}
