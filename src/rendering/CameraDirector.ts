import { MathUtils, Matrix4, PerspectiveCamera, Quaternion, Scene, Vector3 } from 'three';
import type { CombatSnapshot, Vec3 } from '../game/contracts';
import { GAMEPLAY_FOV, GAMEPLAY_OFFSET, GAMEPLAY_AZIMUTH, SHOT_FOV_DELTA, easeInOutCubic, shotPose, type EstablishingFraming, type ShotPose } from './EstablishingShot';

export interface CameraDebugState {
  mode: 'exploration' | 'encounter'; position: readonly [number, number, number]; target: readonly [number, number, number]; shake: number;
  /** Vertical lag (m) of the followed target behind the rendered root, look-ahead length (m), field of view (deg) and whether the establishing shot is running. */
  lagY: number; lookAhead: number; fov: number; establishing: boolean;
}

export type { EstablishingFraming } from './EstablishingShot';
export interface EstablishingShotOptions extends EstablishingFraming { readonly seconds: number; readonly reducedMotion: boolean }

const MAX_SHAKES = 6;
const MAX_AMPLITUDE = 0.6;
/** Hit-stop punch-in: metres toward the target per unit of hit-stop strength, capped; attack/release rates in 1/s. */
const PUNCH_PER_STRENGTH = 0.9;
const MAX_PUNCH = 0.9;
const PUNCH_ATTACK = 38;
const PUNCH_RELEASE = 9;
/** Combat framing: distance multiplier the camera ease out to when 2+ hostiles are within 10 m or a boss is active.
 * 1.0 is the resting gameplay distance, 1.35 is the widest it eases out for; reduced motion collapses this to 1.0
 * (same target framing as a clear arena, no overshoot) but the director still reads `setCombatThreat`. */
const COMBAT_THREAT_MIN = 1.0;
const COMBAT_THREAT_MAX = 1.35;
/** Critically damped distance-factor settling. Natural frequency (rad/s): a 0.7 s settle to within 1% is omega ≈ 6.5. */
const COMBAT_THREAT_OMEGA = 6.5;
/** Distance from the player at which a hostile counts as "engaged" for the combat-framing threat input. */
const COMBAT_THREAT_RANGE = 10;
/** Boss reveal: a slow push-in/orbit on a single target for the configured duration, then ease back to the gameplay pose. */
const REVEAL_RADIUS = 6;
const REVEAL_HEIGHT = 2.0;
/** Critically damped vertical follow: natural frequency (rad/s). The steady lag behind a constant climb is 2/ω ≈ 0.13 s of travel. */
const FOLLOW_Y_OMEGA = 15;
/** The followed height never trails the rendered root by more than this (m); a larger gap (respawn, teleport) snaps. */
const MAX_Y_LAG = 0.9;
const SNAP_Y = 3;
const SNAP_XZ = 6;
/** Look-ahead along the planar velocity: seconds of travel, hard cap (m), and the critically damped frequency (rad/s) it settles with. */
const LOOK_AHEAD_SECONDS = 0.085;
const MAX_LOOK_AHEAD = 0.55;
const LOOK_OMEGA = 5.5;
/** Sprint FOV kick: up to this many degrees between these planar speeds (m/s); dodge kick peaks mid-roll; both together never exceed the total cap. */
const SPRINT_KICK_DEGREES = 3;
const SPRINT_KICK_FROM = 4.8;
const SPRINT_KICK_TO = 5.8;
const DODGE_KICK_DEGREES = 2.5;
const MAX_KICK_DEGREES = 4;
const FOV_ATTACK = 7;
const FOV_RELEASE = 4.5;
const DODGE_ACTION = /dive-roll|dodge/;

interface Shake { amplitude: number; /** Bounded original amplitude at the time of insertion; survives `setShakeScale` toggles. */ baseAmplitude: number; duration: number; frequency: number; elapsed: number; seed: number }

const smoothstep = (edge0: number, edge1: number, x: number): number => { const t = MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1); return t * t * (3 - 2 * t); };

/**
 * Fixed three-quarter gameplay view. The camera orientation, `forward` and `right` never change, so the screen-relative input
 * basis stays camera-fixed. Presentation adds a critically damped follow on height (a step or ledge pop does not bob the frame),
 * a short look-ahead along the velocity and a small sprint/dodge FOV kick; all of them are static under reduced motion and a
 * zero `dt` (no time elapsed) frames the rendered pose exactly.
 */
export class CameraDirector {
  readonly camera: PerspectiveCamera;
  private readonly target = new Vector3();
  private readonly offset = new Vector3(GAMEPLAY_OFFSET.x, GAMEPLAY_OFFSET.y, GAMEPLAY_OFFSET.z);
  /** View direction (from camera to target) is the negated offset normalised, so hit-stop punch-in (a translation along
   *  view direction) always moves the camera exactly toward the target without changing orientation. */
  private readonly viewDirection = new Vector3().copy(this.offset).multiplyScalar(-1).normalize();
  /** Screen-relative forward (the planar projection of `-offset` flattened to the XZ plane) and right (90° clockwise around Y).
   *  The screen-relative input basis is camera-fixed (see `forward` / `right` getters): Aren always moves toward `forward` on
   *  the screen no matter which way the camera is angled around the target. */
  private readonly flatForward = new Vector3(-GAMEPLAY_OFFSET.x, 0, -GAMEPLAY_OFFSET.z).normalize();
  private readonly flatRight = new Vector3(GAMEPLAY_OFFSET.z, 0, -GAMEPLAY_OFFSET.x).normalize();
  /** Precomputed orientation of the gameplay pose: a camera at `offset` looking back at the origin. Cached so the
   *  gameplay framing is bitwise-stable frame to frame (calling `lookAt` every frame drifts by ~4.2e-8 rad in single-precision
   *  float, which the test contract rejects). The establishing shot and boss reveal still call `lookAt` because their
   *  look point sweeps; the gameplay pose is the only one that is constant. */
  // Built once with an up-constrained look-at (world +Y up): a shortest-arc rotation from −Z would add roll.
  private readonly gameplayQuaternion: Quaternion = new Quaternion().setFromRotationMatrix(
    new Matrix4().lookAt(new Vector3(GAMEPLAY_OFFSET.x, GAMEPLAY_OFFSET.y, GAMEPLAY_OFFSET.z), new Vector3(0, 0, 0), new Vector3(0, 1, 0))).normalize();
  private readonly shakes: Shake[] = [];
  private readonly shakeOffset = new Vector3();
  private readonly axisX = new Vector3();
  private readonly axisY = new Vector3();
  private readonly look = new Vector3();
  private readonly lookVelocity = new Vector3();
  private readonly shotPoseScratch: ShotPose = { px: 0, py: 0, pz: 0, lx: 0, ly: 0, lz: 0 };
  private shotFraming: EstablishingFraming = { center: { x: 0, y: 0, z: 0 }, radius: 1, height: 1, sweep: 0 };
  private readonly baseFov: number;
  private mode: CameraDebugState['mode'] = 'exploration';
  private reducedMotion = false;
  private punch = 0;
  private seed = 1;
  private followY = 0;
  private followVelocity = 0;
  private rootY = 0;
  private hasFrame = false;
  private lastX = 0;
  private lastZ = 0;
  private fovKick = 0;
  private shotActive = false;
  private shotElapsed = 0;
  private shotSeconds = 0;
  /** Lens offset (deg) of the running establishing shot; 0 outside it. */
  private shotFov = 0;
  /** Multiplier applied to every new shake amplitude and swept over the live shakes (1 = default, 0.25 = reduced-camera-shake). */
  private shakeScaleField = 1;
  /** Combat-threat goal (1 = clear, 1.35 = full threat). Set by `setCombatThreat`; eased toward in `followTarget`. */
  private threatGoal = 1;
  private threatFactor = 1;
  /** Boss reveal state: target position, total seconds, elapsed seconds; ORBITS the boss and eases back to gameplay pose. */
  private revealRunning = false;
  private revealElapsed = 0;
  private revealSeconds = 0;
  private readonly revealTarget = new Vector3();

  constructor(scene: Scene, camera?: PerspectiveCamera) {
    this.camera = camera ?? new PerspectiveCamera(GAMEPLAY_FOV, 1, 0.1, 180);
    this.baseFov = this.camera.fov;
    this.camera.position.copy(this.offset);
    this.camera.quaternion.copy(this.gameplayQuaternion);
    scene.add(this.camera);
    for (let i = 0; i < MAX_SHAKES; i++) this.shakes.push({ amplitude: 0, baseAmplitude: 0, duration: 0, frequency: 0, elapsed: 0, seed: 0 });
  }

  /**
   * `dt` is real render seconds. With `dt` > 0 the framing follows the rendered root rigidly on the ground plane and with a critically
   * damped lag on height, leads the velocity slightly and eases the FOV; with `dt` = 0 (load, teleport, paused frame) it frames the
   * rendered pose exactly. While the snapshot reports hit-stop the camera pushes along the view axis toward Aren and eases back:
   * the offset is collinear with the view direction, so orientation, `forward` and `right` never change. The combat-threat distance
   * multiplier is critically damped toward the input goal: eased out to ~1.35 with a boss or 2+ hostiles in range, eased back to 1
   * when clear, identical target framing in reduced motion (no overshoot).
   */
  update(combat: CombatSnapshot, renderedPosition?: Readonly<Vec3>, dt = 0): void {
    const player = combat.actors.find((actor) => actor.id === 'aren') ?? combat.actors.find((actor) => actor.allegiance === 'player');
    if (!player) return;
    this.mode = combat.encounterId || combat.boss ? 'encounter' : 'exploration';
    const position = renderedPosition ?? player.position;
    this.followTarget(player, position, combat, dt);
    this.samplePunch(combat, dt);
    this.sampleShake(dt);
    if (this.shotActive) this.poseShot();
    else if (this.revealRunning) this.poseReveal(dt);
    else this.poseGameplay();
  }

  /**
   * Starts the establishing shot: from a high wide orbit of the region down to exactly the gameplay framing. The sweep runs on real
   * render time through `advanceEstablishingShot`. Returns false (and does nothing) under reduced motion or for a non-positive duration.
   */
  beginEstablishingShot(options: EstablishingShotOptions): boolean {
    if (options.reducedMotion || this.reducedMotion || !(options.seconds > 0) || !(options.radius > 0) || !(options.height > 0)) return false;
    this.shotFraming = { center: { x: options.center.x, y: options.center.y, z: options.center.z }, radius: options.radius, height: options.height, sweep: options.sweep };
    this.shotSeconds = options.seconds;
    this.shotElapsed = 0;
    this.shotActive = true;
    this.clearShake();
    this.punch = 0;
    this.poseShot();
    return true;
  }

  /** Real seconds of the sweep; poses the camera and ends exactly on the gameplay framing when the duration has elapsed. */
  advanceEstablishingShot(dt: number): void {
    if (!this.shotActive) return;
    this.shotElapsed += Math.max(0, dt);
    if (this.reducedMotion || this.shotElapsed >= this.shotSeconds) { this.endEstablishingShot(); return; }
    this.poseShot();
  }

  /** Jumps to the gameplay framing immediately. */
  skipEstablishingShot(): void { if (this.shotActive) this.endEstablishingShot(); }

  /**
   * Presentation-only boss reveal: the camera orbits a single target for `durationSeconds` (slow push-in on the boss,
   * then eases back to the gameplay pose). Reduced motion hard-cuts to a static boss framing for the same duration
   * and cuts back when it elapses. The director never auto-resumes the simulation — the caller pauses it (the chapter
   * encounter path already holds the time policy at `paused` while the intro runs) and clears the input.
   * Returns false (no-op) for a non-positive duration or a non-finite target. A second `beginReveal` while one is
   * running restarts from a fresh target and the full duration.
   */
  beginReveal(targetPosition: Readonly<Vec3>, durationSeconds: number): boolean {
    if (!Number.isFinite(targetPosition.x) || !Number.isFinite(targetPosition.y) || !Number.isFinite(targetPosition.z)) return false;
    if (!(durationSeconds > 0)) return false;
    this.revealTarget.set(targetPosition.x, targetPosition.y, targetPosition.z);
    this.revealSeconds = durationSeconds;
    this.revealElapsed = 0;
    this.revealRunning = true;
    this.clearShake();
    this.punch = 0;
    this.threatFactor = 1;
    this.poseReveal(0);
    return true;
  }

  /** Real seconds of the boss reveal; poses the camera each frame and ends on the gameplay framing when the duration has elapsed. */
  advanceReveal(dt: number): void {
    if (!this.revealRunning) return;
    this.revealElapsed += Math.max(0, dt);
    if (this.revealElapsed >= this.revealSeconds) { this.endReveal(); return; }
    this.poseReveal(dt);
  }

  /** Cuts the reveal short and snaps the camera to the gameplay pose. Idempotent. */
  skipReveal(): void { if (this.revealRunning) this.endReveal(); }

  /**
   * Pose the reveal frame: under reduced motion it stays static at the boss framing; otherwise it pushes in along
   * an arc around the target for the first half then eases back to the gameplay pose on the second half. The gameplay
   * framing at the end is exact (no pop), so the caller can resume input at the same instant.
   */
  private poseReveal(dt: number): void {
    if (this.reducedMotion) {
      // Static boss framing: hold the closest point of the push-in for the whole duration, then the gameplay pose.
      const closest = 0.45;
      const orbit = this.revealEase(closest);
      this.placeRevealCamera(orbit);
      return;
    }
    // Slow push-in (0→0.5 eased), then ease back to the gameplay pose (0.5→1). End is exact because revealEase(1) = 1.
    const raw = MathUtils.clamp(this.revealElapsed / this.revealSeconds, 0, 1);
    const ease = this.revealEase(raw);
    this.placeRevealCamera(ease);
    // Suppress an unused warning for dt: real-time pacing is governed by the caller, not consumed here.
    void dt;
  }

  /** Eased progress used by both the reduced-motion hold and the dynamic push-in / return. 0 = orbit start, 1 = gameplay pose. */
  private revealEase(progress: number): number {
    return progress < 0.5 ? easeInOutCubic(progress / 0.5) : 1 - easeInOutCubic((progress - 0.5) / 0.5);
  }

  /** Place the camera at a reveal eased progress (0..1) where 0 is the orbit start and 1 is the gameplay framing.
   *  The gameplay framing here uses the full GAMEPLAY_OFFSET so the end pose is exactly the gameplay pose; reduced
   *  motion ignores the ease and is held at `closest`. */
  private placeRevealCamera(ease: number): void {
    // Slow push-in around the boss: target = boss position, camera = orbit target + offset scaled by ease (1 → gameplay).
    const tx = this.revealTarget.x, ty = this.revealTarget.y + 0.85, tz = this.revealTarget.z;
    const radius = REVEAL_RADIUS, height = REVEAL_HEIGHT;
    const azimuth = GAMEPLAY_AZIMUTH + (1 - ease) * Math.PI * 0.35;
    this.camera.position.set(
      tx + Math.sin(azimuth) * radius * ease + this.offset.x * (1 - ease),
      ty + height * (1 - ease) + this.offset.y * (1 - ease),
      tz + Math.cos(azimuth) * radius * ease + this.offset.z * (1 - ease),
    );
    this.camera.lookAt(tx, ty, tz);
    this.shotFov = 0;
    this.applyFov();
    this.camera.updateMatrixWorld();
  }

  private endReveal(): void {
    this.revealRunning = false;
    this.revealElapsed = 0;
    this.poseGameplay();
  }

  /**
   * Presentation-only impact shake. Amplitude in metres (clamped), decays quadratically to zero
   * over `durationSeconds`; ignored in reduced-motion mode. The running `shakeScale` (set via
   * `setShakeScale`) multiplies the requested amplitude — 0.25 keeps the playback camera readable
   * for the reduced-camera-shake accessibility setting without flattening the gameplay camera.
   */
  addShake(amplitude: number, durationSeconds: number, frequency = 18): void {
    if (this.reducedMotion || !(amplitude > 0) || !(durationSeconds > 0)) return;
    const bounded = Math.min(MAX_AMPLITUDE, amplitude);
    if (!(bounded > 0)) return;
    let slot = this.shakes[0]!;
    for (const shake of this.shakes) {
      if (shake.elapsed >= shake.duration) { slot = shake; break; }
      if (this.remaining(shake, shake.baseAmplitude * this.shakeScaleField) < this.remaining(slot, slot.baseAmplitude * this.shakeScaleField)) slot = shake;
    }
    slot.baseAmplitude = bounded;
    slot.amplitude = bounded * this.shakeScaleField;
    slot.duration = durationSeconds;
    slot.frequency = Math.max(1, frequency);
    slot.elapsed = 0;
    slot.seed = (this.seed = (this.seed * 16807) % 2147483647) / 2147483647 * 100;
  }

  /**
   * Scales every future shake amplitude (and the live envelopes for the rest of their natural lives). The scale is
   * applied at sampling time via `baseAmplitude * shakeScale`, so restoring scale to 1 always returns the original
   * playback amplitude; repeated on/off/on toggles do not progressively attenuate. Reduced motion still cancels
   * shake outright via `setReducedMotion`.
   */
  setShakeScale(scale: number): void {
    const clamped = !Number.isFinite(scale) ? 1 : Math.max(0, Math.min(1, scale));
    if (clamped === this.shakeScaleField) return;
    this.shakeScaleField = clamped;
    for (const shake of this.shakes) {
      if (shake.elapsed >= shake.duration) continue;
      const next = shake.baseAmplitude * clamped;
      if (next < 1e-4) { shake.amplitude = 0; shake.elapsed = shake.duration; }
      else shake.amplitude = Math.min(MAX_AMPLITUDE, next);
    }
  }

  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
    if (!reduced) return;
    this.clearShake();
    this.punch = 0;
    this.look.set(0, 0, 0);
    this.lookVelocity.set(0, 0, 0);
    this.followVelocity = 0;
    this.followY = this.rootY;
    this.fovKick = 0;
    this.threatFactor = 1;
    this.threatGoal = 1;
    this.applyFov();
    if (this.shotActive) this.endEstablishingShot();
    if (this.revealRunning) this.endReveal();
  }

  clearShake(): void { for (const shake of this.shakes) shake.elapsed = shake.duration = 0; this.shakeOffset.set(0, 0, 0); }

  copyTarget(out: Vector3): void { out.copy(this.target); }
  get forward(): Vector3 { return this.flatForward; }
  get right(): Vector3 { return this.flatRight; }
  /** True while the establishing sweep is running. */
  get establishingShotActive(): boolean { return this.shotActive; }
  /** The sweep's eased progress (0 at the start, 1 at the gameplay framing and whenever no sweep runs): what the pose and the renderer's fog easing follow. */
  get establishingShotEase(): number { return this.shotActive ? easeInOutCubic(MathUtils.clamp(this.shotElapsed / this.shotSeconds, 0, 1)) : 1; }
  /** Progress 0..1 of the running sweep (0 when none is running). */
  get establishingShotProgress(): number { return this.shotActive ? Math.min(1, this.shotElapsed / this.shotSeconds) : 0; }
  /** Current combined shake magnitude in metres (0 when settled). */
  get shakeMagnitude(): number { return this.shakeOffset.length(); }
  /** Current hit-stop punch-in in metres along the view axis (0 when settled). */
  get punchMagnitude(): number { return this.punch; }
  /** How far (m) the followed height currently trails the rendered root; negative while it trails above. */
  get verticalLag(): number { return this.rootY - this.followY; }
  /** Current look-ahead length in metres (0 when settled). */
  get lookAheadMagnitude(): number { return Math.hypot(this.look.x, this.look.z); }
  /** Current sprint/dodge FOV kick in degrees (0 when settled). */
  get fovKickDegrees(): number { return this.fovKick; }
  /** Current camera-shake amplitude multiplier (1 = full, reduced-camera-shake sets 0.25). */
  get shakeScale(): number { return this.shakeScaleField; }
  /** Current combat-threat distance factor (1 = clear, ≤1.35 = full threat). Eased, never overshoots. */
  get combatThreatFactor(): number { return this.threatFactor; }
  /** True while the boss reveal sequence runs. */
  get revealActive(): boolean { return this.revealRunning; }
  /** Progress 0..1 of the running reveal (0 when none is running). */
  get revealProgress(): number { return this.revealRunning ? Math.min(1, this.revealElapsed / this.revealSeconds) : 0; }
  get cameraPosition(): readonly [number, number, number] { return [this.camera.position.x, this.camera.position.y, this.camera.position.z]; }
  get debugState(): CameraDebugState {
    return {
      mode: this.mode, position: this.cameraPosition, target: [this.target.x, this.target.y, this.target.z], shake: this.shakeMagnitude,
      lagY: this.verticalLag, lookAhead: this.lookAheadMagnitude, fov: this.camera.fov, establishing: this.shotActive,
    };
  }

  private remaining(shake: Shake, amplitude = shake.amplitude): number {
    return shake.elapsed >= shake.duration ? 0 : amplitude * (1 - shake.elapsed / shake.duration) ** 2;
  }

  /** Aims `target` at the rendered root plus the smoothed look-ahead, with the height damped, and eases the FOV kick.
   * `combat` supplies the hostiles list and boss state for the combat-framing distance multiplier. */
  private followTarget(player: CombatSnapshot['actors'][number], position: Readonly<Vec3>, combat: CombatSnapshot, dt: number): void {
    const jumped = this.hasFrame && (Math.abs(position.y - this.rootY) > SNAP_Y || Math.hypot(position.x - this.lastX, position.z - this.lastZ) > SNAP_XZ);
    const smooth = dt > 0 && this.hasFrame && !jumped && !this.reducedMotion;
    this.rootY = position.y;
    this.lastX = position.x; this.lastZ = position.z;
    if (smooth) {
      const step = Math.min(dt, 0.05);
      const omega = FOLLOW_Y_OMEGA, decay = Math.exp(-omega * step), delta = this.followY - position.y, carry = (this.followVelocity + omega * delta) * step;
      this.followVelocity = (this.followVelocity - omega * carry) * decay;
      this.followY = position.y + (delta + carry) * decay;
      const lag = MathUtils.clamp(this.rootY - this.followY, -MAX_Y_LAG, MAX_Y_LAG);
      this.followY = this.rootY - lag;
      this.dampLookAhead(player, step);
      this.dampThreatFactor(step, combat);
    } else {
      this.followY = position.y; this.followVelocity = 0;
      this.look.set(0, 0, 0); this.lookVelocity.set(0, 0, 0);
      // Snap the threat factor (zero-time frame, reduced motion, or teleport): no overshoot, identical target framing.
      this.threatFactor = this.reducedMotion ? 1 : this.threatGoal;
    }
    this.hasFrame = true;
    this.target.set(position.x + this.look.x, this.followY + 0.85, position.z + this.look.z);
    this.sampleFov(player, smooth ? Math.min(dt, 0.05) : 0);
  }

  /** Critically damped distance factor (1..1.35) driven by `threatGoal` (see `setCombatThreat`). Always monotonic,
   *  never overshoots its goal, settles inside 0.7 s under the natural frequency, and collapses to 1 under reduced motion. */
  private dampThreatFactor(dt: number, combat: CombatSnapshot): void {
    this.computeThreatGoal(combat);
    const goal = this.threatGoal, current = this.threatFactor, step = Math.min(dt, 0.05);
    const omega = COMBAT_THREAT_OMEGA, decay = Math.exp(-omega * step), delta = current - goal;
    const carry = (-omega * delta) * step; // critically damped, no velocity term required for a first-order lag.
    this.threatFactor = goal + (delta + carry) * decay;
    if (Math.abs(this.threatFactor - goal) < 1e-4) this.threatFactor = goal;
  }

  /** Boss present OR 2+ hostiles within `COMBAT_THREAT_RANGE` ⇒ 1.35 (full threat); otherwise 1. Reduced motion forces 1. */
  private computeThreatGoal(combat: CombatSnapshot): void {
    if (this.reducedMotion || this.shotActive || this.revealRunning) { this.threatGoal = 1; return; }
    if (combat.boss) { this.threatGoal = COMBAT_THREAT_MAX; return; }
    const player = combat.actors.find((actor) => actor.id === 'aren') ?? combat.actors.find((actor) => actor.allegiance === 'player');
    if (!player) { this.threatGoal = COMBAT_THREAT_MIN; return; }
    let count = 0;
    for (const actor of combat.actors) {
      if (actor.id === player.id) continue;
      if (actor.allegiance !== 'hostile') continue;
      const dx = actor.position.x - player.position.x, dz = actor.position.z - player.position.z;
      if (dx * dx + dz * dz <= COMBAT_THREAT_RANGE * COMBAT_THREAT_RANGE) count++;
    }
    this.threatGoal = count >= 2 ? COMBAT_THREAT_MAX : COMBAT_THREAT_MIN;
  }

  private dampLookAhead(player: CombatSnapshot['actors'][number], dt: number): void {
    const speed = player.downed ? 0 : Math.hypot(player.velocity.x, player.velocity.z);
    const reach = speed > 1e-6 ? Math.min(MAX_LOOK_AHEAD, speed * LOOK_AHEAD_SECONDS) / speed : 0;
    const goalX = player.velocity.x * reach, goalZ = player.velocity.z * reach;
    const decay = Math.exp(-LOOK_OMEGA * dt);
    const deltaX = this.look.x - goalX, deltaZ = this.look.z - goalZ;
    const carryX = (this.lookVelocity.x + LOOK_OMEGA * deltaX) * dt, carryZ = (this.lookVelocity.z + LOOK_OMEGA * deltaZ) * dt;
    this.lookVelocity.x = (this.lookVelocity.x - LOOK_OMEGA * carryX) * decay;
    this.lookVelocity.z = (this.lookVelocity.z - LOOK_OMEGA * carryZ) * decay;
    this.look.x = goalX + (deltaX + carryX) * decay;
    this.look.z = goalZ + (deltaZ + carryZ) * decay;
  }

  private sampleFov(player: CombatSnapshot['actors'][number], dt: number): void {
    let goal = 0;
    if (!this.reducedMotion && !player.downed) {
      goal = SPRINT_KICK_DEGREES * smoothstep(SPRINT_KICK_FROM, SPRINT_KICK_TO, Math.hypot(player.velocity.x, player.velocity.z));
      if (DODGE_ACTION.test(String(player.actionId))) goal += DODGE_KICK_DEGREES * Math.sin(Math.PI * MathUtils.clamp(player.normalizedTime, 0, 1));
      goal = Math.min(MAX_KICK_DEGREES, goal);
    }
    if (dt > 0) this.fovKick += (goal - this.fovKick) * (1 - Math.exp(-(goal > this.fovKick ? FOV_ATTACK : FOV_RELEASE) * dt));
    else this.fovKick = goal;
    if (goal === 0 && this.fovKick < 1e-3) this.fovKick = 0;
    this.applyFov();
  }

  private applyFov(): void {
    const fov = this.baseFov + this.fovKick + this.shotFov;
    if (this.camera.fov === fov) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  /** The gameplay pose: target plus the fixed offset (scaled by the combat-threat distance factor),
   *  hit-stop punch-in along the view axis and the camera-space shake. The orientation is the precomputed
   *  `gameplayQuaternion` (camera at `offset` looking at the origin) so the framing is bitwise-stable frame
   *  to frame; calling `lookAt` every frame drifts by ~4.2e-8 rad in single-precision float. */
  private poseGameplay(): void {
    this.camera.position.copy(this.target);
    const factor = this.threatFactor;
    this.camera.position.x += this.offset.x * factor;
    this.camera.position.y += this.offset.y * factor;
    this.camera.position.z += this.offset.z * factor;
    if (this.punch > 0) this.camera.position.addScaledVector(this.viewDirection, this.punch);
    this.camera.quaternion.copy(this.gameplayQuaternion);
    // Shake is a camera-space translation applied after the orientation is set: orientation, `forward` and
    // `right` (the movement basis) are untouched.
    if (this.shakeOffset.lengthSq() > 0) {
      this.axisX.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
      this.axisY.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
      this.camera.position.addScaledVector(this.axisX, this.shakeOffset.x).addScaledVector(this.axisY, this.shakeOffset.y);
    }
    this.camera.updateMatrixWorld();
  }

  /**
   * One frame of the establishing sweep (see `shotPose`). The ease has zero slope at both ends and the last frame is the gameplay
   * pose, so there is nothing to pop to.
   */
  private poseShot(): void {
    const eased = this.establishingShotEase;
    const pose = shotPose(this.shotFraming, this.target, eased, this.shotPoseScratch);
    this.camera.position.set(pose.px, pose.py, pose.pz);
    this.camera.lookAt(pose.lx, pose.ly, pose.lz);
    this.shotFov = SHOT_FOV_DELTA * (1 - eased);
    this.applyFov();
    this.camera.updateMatrixWorld();
  }

  private endEstablishingShot(): void {
    this.shotActive = false;
    this.shotElapsed = 0;
    this.shotFov = 0;
    this.applyFov();
    this.poseGameplay();
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
