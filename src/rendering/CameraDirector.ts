import { PerspectiveCamera, Scene, Vector3 } from 'three';
import type { CombatSnapshot, Vec3 } from '../game/contracts';

export interface CameraDebugState { mode: 'exploration' | 'encounter'; position: readonly [number, number, number]; target: readonly [number, number, number]; shake: number }

const MAX_SHAKES = 6;
const MAX_AMPLITUDE = 0.6;
/** Hit-stop punch-in: metres toward the target per unit of hit-stop strength, capped; attack/release rates in 1/s. */
const PUNCH_PER_STRENGTH = 0.9;
const MAX_PUNCH = 0.9;
const PUNCH_ATTACK = 38;
const PUNCH_RELEASE = 9;

interface Shake { amplitude: number; duration: number; frequency: number; elapsed: number; seed: number }

/** Fixed three-quarter gameplay view. Camera and Aren share the same rendered pose. */
export class CameraDirector {
  readonly camera: PerspectiveCamera;
  private readonly target = new Vector3();
  private readonly offset = new Vector3(10, 12, 14);
  private readonly viewDirection = new Vector3(-10, -12, -14).normalize();
  private readonly flatForward = new Vector3(-10, 0, -14).normalize();
  private readonly flatRight = new Vector3(14, 0, -10).normalize();
  private readonly shakes: Shake[] = [];
  private readonly shakeOffset = new Vector3();
  private readonly axisX = new Vector3();
  private readonly axisY = new Vector3();
  private mode: CameraDebugState['mode'] = 'exploration';
  private reducedMotion = false;
  private punch = 0;
  private seed = 1;

  constructor(scene: Scene, camera?: PerspectiveCamera) {
    this.camera = camera ?? new PerspectiveCamera(48, 1, 0.1, 180);
    this.camera.position.copy(this.offset);
    this.camera.lookAt(this.target);
    scene.add(this.camera);
    for (let i = 0; i < MAX_SHAKES; i++) this.shakes.push({ amplitude: 0, duration: 0, frequency: 0, elapsed: 0, seed: 0 });
  }

  /**
   * `dt` is real render seconds and only ages presentation shake and the hit-stop punch-in; framing never lags. While the
   * snapshot reports hit-stop the camera pushes along the view axis toward Aren and eases back afterwards: the offset is
   * collinear with the view direction, so orientation, `forward` and `right` never change.
   */
  update(combat: CombatSnapshot, renderedPosition?: Readonly<Vec3>, dt = 0): void {
    const player = combat.actors.find((actor) => actor.id === 'aren') ?? combat.actors.find((actor) => actor.allegiance === 'player');
    if (!player) return;
    this.mode = combat.encounterId || combat.boss ? 'encounter' : 'exploration';
    const position = renderedPosition ?? player.position;
    this.target.set(position.x, position.y + 0.85, position.z);
    // No chase lag, encounter reframing, or obstacle zoom: these change input direction
    // and let Aren drift. Native prop occlusion fading keeps the fixed view readable.
    this.camera.position.copy(this.target).add(this.offset);
    this.samplePunch(combat, dt);
    if (this.punch > 0) this.camera.position.addScaledVector(this.viewDirection, this.punch);
    this.camera.lookAt(this.target);
    // Shake is a camera-space translation applied after lookAt: orientation, `forward` and
    // `right` (the movement basis) are untouched.
    this.sampleShake(dt);
    if (this.shakeOffset.lengthSq() > 0) {
      this.axisX.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
      this.axisY.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
      this.camera.position.addScaledVector(this.axisX, this.shakeOffset.x).addScaledVector(this.axisY, this.shakeOffset.y);
    }
    this.camera.updateMatrixWorld();
  }

  /**
   * Presentation-only impact shake. Amplitude in metres (clamped), decays quadratically to zero
   * over `durationSeconds`; ignored in reduced-motion mode.
   */
  addShake(amplitude: number, durationSeconds: number, frequency = 18): void {
    if (this.reducedMotion || !(amplitude > 0) || !(durationSeconds > 0)) return;
    let slot = this.shakes[0]!;
    for (const shake of this.shakes) {
      if (shake.elapsed >= shake.duration) { slot = shake; break; }
      if (this.remaining(shake) < this.remaining(slot)) slot = shake;
    }
    slot.amplitude = Math.min(MAX_AMPLITUDE, amplitude); slot.duration = durationSeconds; slot.frequency = Math.max(1, frequency);
    slot.elapsed = 0; slot.seed = (this.seed = (this.seed * 16807) % 2147483647) / 2147483647 * 100;
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    if (reduced) { this.clearShake(); this.punch = 0; }
  }

  clearShake(): void { for (const shake of this.shakes) shake.elapsed = shake.duration = 0; this.shakeOffset.set(0, 0, 0); }

  copyTarget(out: Vector3): void { out.copy(this.target); }
  get forward(): Vector3 { return this.flatForward; }
  get right(): Vector3 { return this.flatRight; }
  /** Current combined shake magnitude in metres (0 when settled). */
  get shakeMagnitude(): number { return this.shakeOffset.length(); }
  /** Current hit-stop punch-in in metres along the view axis (0 when settled). */
  get punchMagnitude(): number { return this.punch; }
  get cameraPosition(): readonly [number, number, number] { return [this.camera.position.x, this.camera.position.y, this.camera.position.z]; }
  get debugState(): CameraDebugState { return { mode: this.mode, position: this.cameraPosition, target: [this.target.x, this.target.y, this.target.z], shake: this.shakeMagnitude }; }

  private remaining(shake: Shake): number {
    return shake.elapsed >= shake.duration ? 0 : shake.amplitude * (1 - shake.elapsed / shake.duration) ** 2;
  }

  private samplePunch(combat: CombatSnapshot, dt: number): void {
    const stop = combat.hitStop, strength = stop && stop.remainingTicks > 0 ? Math.min(1, Math.max(0, stop.strength)) : 0;
    const goal = this.reducedMotion ? 0 : Math.min(MAX_PUNCH, PUNCH_PER_STRENGTH * strength);
    this.punch += (goal - this.punch) * (1 - Math.exp(-(goal > this.punch ? PUNCH_ATTACK : PUNCH_RELEASE) * Math.max(0, dt)));
    if (goal === 0 && this.punch < 1e-4) this.punch = 0;
  }

  private sampleShake(dt: number): void {
    let x = 0, y = 0;
    for (const shake of this.shakes) {
      if (shake.elapsed >= shake.duration) continue;
      shake.elapsed = Math.min(shake.duration, shake.elapsed + Math.max(0, dt));
      const envelope = (1 - shake.elapsed / shake.duration) ** 2;
      if (envelope <= 0) continue;
      const phase = shake.elapsed * shake.frequency * Math.PI * 2 + shake.seed;
      x += shake.amplitude * envelope * (Math.sin(phase) * 0.7 + Math.sin(phase * 2.31 + 1.7) * 0.3);
      y += shake.amplitude * envelope * (Math.cos(phase * 1.13 + 0.4) * 0.6 + Math.sin(phase * 2.71) * 0.25);
    }
    const length = Math.hypot(x, y);
    if (length > MAX_AMPLITUDE) { x *= MAX_AMPLITUDE / length; y *= MAX_AMPLITUDE / length; }
    this.shakeOffset.set(x, y, 0);
  }
}
