import { AnimationClip, AnimationMixer, LoopOnce, LoopRepeat, Matrix4, QuaternionKeyframeTrack, Vector3, VectorKeyframeTrack } from 'three';
import type { AnimationAction, Object3D } from 'three';
import type { ActionId, AssetManifestEntry } from '../game/contracts';

/**
 * Presentation-only pose correction layered over the evaluated clip pose (foot grounding). `restore` puts back the clip values the
 * previous `apply` overwrote and runs before every mixer evaluation, so the mixer's unchanged-value skip and root-motion compensation
 * never see a corrected pose; `apply` runs after the clip pose, root-motion compensation and `postPose`. `dt` is 0 for `play()`.
 */
export interface GroundingSlot { restore(): void; apply(dt: number): void }
export type AnimationIssue = { kind: 'missing-clip'; actionId: string; assetId: string };
type RootMotionMetadata = NonNullable<AssetManifestEntry['rootMotion']>[string];
/** `up`: the actor-space vertical expressed in the root node's parent space (rigs such as Z-up Mixamo exports rotate it off local Y). */
interface RootMotionBinding { node: Object3D; bindPosition: Vector3; up: Vector3 }
const rootMotionOffset = new Vector3();
export class AnimationBindingError extends Error {
  constructor(readonly assetId: string, readonly actionId: string) {
    super(`Asset ${assetId} has no exact manifest-bound clip for action '${actionId}'.`);
    this.name = 'AnimationBindingError';
  }
}
export class RootMotionBindingError extends Error {
  constructor(readonly assetId: string, readonly actionId: string, reason: string) {
    super(`Asset ${assetId} cannot consume root motion for action '${actionId}': ${reason}`);
    this.name = 'RootMotionBindingError';
  }
}

/**
 * Cross-fade seconds by transition kind. Loops are gait/idle cycles; finite clips are authoritative one-shots:
 * entering a strike must read fast, settling back into a gait must be soft, gait changes blend over a stride.
 */
export const ANIMATION_FADE_SECONDS = { loopToLoop: 0.25, loopToFinite: 0.09, finiteToLoop: 0.22, finiteToFinite: 0.08 } as const;
/** A finite sample whose normalized time falls by more than this between calls is a restart of the same clip. */
const RESTART_DROP = 0.2;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * One action's state in the blend. `phase`/`rate` drive loops (seconds into the clip; advanced from authoritative clock
 * deltas, also while the loop fades out). `value` is the fade weight before recovery/overlay scaling; `from`/`to` are the
 * endpoints of the running transition.
 */
interface Layer {
  readonly action: AnimationAction;
  readonly duration: number;
  loops: boolean;
  phase: number;
  rate: number;
  value: number;
  from: number;
  to: number;
}

/**
 * Samples exact manifest-bound clip time from authoritative snapshots; mixer time never drives gameplay.
 *
 * Blend weights are owned here, not by the mixer's fade interpolants: the weights of all fading layers always sum to 1
 * (three.js would otherwise mix the remainder with the bind pose), an interrupted fade restarts from the weights it
 * reached, and a looping layer that is fading out keeps advancing from the actor clock at its own playback rate.
 */
export class AnimationController {
  readonly mixer: AnimationMixer;
  readonly issues: AnimationIssue[] = [];
  private readonly reportedMissing = new Set<string>();
  private readonly actions = new Map<string, AnimationAction>();
  private readonly layers = new Map<AnimationAction, Layer>();
  /** Layers taking part in the running transition (current + fading out). */
  private readonly live: Layer[] = [];
  private current: Layer | undefined;
  private currentActionId: string | undefined;
  /** Locomotion loop blended into the tail of a finite action; its weight is supplied by the caller. */
  private recovery: Layer | undefined;
  private recoveryWeight = 0;
  /** Presentation overlay (partial-body clip) blended over the whole pose. */
  private overlay: Layer | undefined;
  private overlayShare = 0;
  private fadeElapsed = 0;
  private fadeDuration = 0;
  /** Normalized gait phase of the loop that was interrupted by a finite action; resumed when a loop returns. */
  private suspendedPhase: number | undefined;
  private previousClock: number | undefined;
  private clock = 0;
  private clockDelta = 0;
  private clockSeeded = false;
  private clockValid = false;
  private readonly fallbackActionId: string | undefined;
  private postPose: (() => void) | undefined;
  private grounding: GroundingSlot | undefined;
  /** Seconds used for finite→finite hand-offs and same-clip restarts; undefined keeps the default fades and never blends restarts. */
  private blendSeconds: number | undefined;
  /** Normalized time of the previous finite sample on the current layer (restart detection). */
  private lastFiniteTime: number | undefined;
  /** Same-clip restart crossfade running now: the share of the shown pose still owed to the captured pose. */
  private restarting = false;
  private restartElapsed = 0;
  private restartDuration = 0;
  /**
   * Built once, on the first restart: a two-key pose clip over every named bone plus its live action. A restart only overwrites the key
   * values in place and replays the same action, so repeated attacks allocate nothing and never touch the mixer's binding caches.
   */
  private restartPose: { action: AnimationAction; bones: Object3D[]; position: Float32Array[]; quaternion: Float32Array[] } | undefined;
  /**
   * Bind positions keyed by native rig root node name so shared aliases
   * (e.g. all aren dive actions pointing at mixamorigHips) reuse the same
   * canonical base, captured once in the constructor before any playback
   * so a faded mid-cycle pose never leaks into a fresh bind.
   */
  private readonly rootMotionBindings = new Map<string, RootMotionBinding>();
  private readonly planarSpeeds = new Map<string, number>();
  private readonly assetId: string;
  private readonly root: Object3D;
  private readonly manifest: AssetManifestEntry;
  private disposed = false;

  constructor(root: Object3D, clips: readonly AnimationClip[], manifest: AssetManifestEntry, private readonly allowMissingActionClips = false) {
    this.assetId = manifest.id;
    this.root = root;
    this.manifest = manifest;
    this.mixer = new AnimationMixer(root);
    for (const actionId of manifest.requiredActionIds) {
      const clipName = manifest.actionToClipMapping[String(actionId)];
      const clip = clipName ? clips.find((candidate) => candidate.name === clipName) : undefined;
      if (!clip) {
        this.recordMissing(String(actionId));
        continue;
      }
      const action = this.mixer.clipAction(clip);
      this.actions.set(String(actionId), action);
    }
    for (const [actionId, clipName] of Object.entries(manifest.actionToClipMapping)) {
      if (!clipName || this.actions.has(actionId)) continue;
      const clip = clips.find((candidate) => candidate.name === clipName);
      if (!clip) continue;
      const action = this.mixer.clipAction(clip);
      this.actions.set(actionId, action);
    }
    this.fallbackActionId = [...this.actions.keys()].find((actionId) => /idle$/i.test(actionId));
    this.captureRootMotionBindings();
  }

  /** True when the manifest binds `actionId` to a loaded clip. */
  hasAction(actionId: ActionId | string): boolean {
    return this.actions.has(String(actionId));
  }

  /** Authored metres/second in actor X/Z, including the native root parent's rotation and scale. */
  authoredPlanarSpeed(actionId: ActionId | string): number {
    return this.planarSpeeds.get(String(actionId)) ?? 0;
  }

  /**
   * Idle loops sample authoritative actor-clock seconds modulo loaded
   * duration; finite actions sample normalized snapshot progress.
   *
   * Looping cadence is integrated from authoritative actor-clock deltas
   * inside `play()`: on each call every running loop advances by
   * `(clock - previousClock) * playbackRate`. A duplicate clock (or no
   * clock sample) contributes zero and never advances phase. A rewind or
   * first sample deterministically seeds `phase = clock * rate`. A loop that
   * replaces another loop (or resumes after a finite action) inherits the
   * normalized gait phase, and the loop it replaces keeps advancing at its own
   * rate while it fades out. The X/Z horizontal component is reset to the
   * canonical bind for native-root-motion actions; opted policies with
   * `preserveVerticalMotion: true` retain the authored native Y so native
   * crouch, bob and dive tuck survive while the simulation drives the
   * physical jump flight.
   * Optional recovery locomotion blends the finite tail without changing its
   * authoritative time/identity. Promotion keeps the already-visible gait.
   * An action without a bound clip never fades to the bind pose: the running loop
   * continues (or the idle loop resumes after a finite action) and the issue is recorded.
   */
  play(actionId: ActionId | string, phase: string, normalizedTime?: number, loopTimeSeconds?: number, loopPlaybackRate = 1, recoveryActionId?: ActionId | string, recoveryWeight = 0): void {
    if (this.disposed) throw new Error(`Animation controller for ${this.assetId} has been disposed.`);
    const id = String(actionId);
    const action = this.actions.get(id);
    if (!action) {
      this.holdForMissing(id, loopTimeSeconds, loopPlaybackRate);
      return;
    }
    this.validateRootMotion(id);
    const loops = phase === 'idle';
    const rate = Number.isFinite(loopPlaybackRate) ? loopPlaybackRate : 1;
    let recoveryLayer: Layer | undefined;
    if (!loops && recoveryActionId !== undefined) {
      const recoveryId = String(recoveryActionId);
      const recoveryAction = this.actions.get(recoveryId);
      if (!recoveryAction) {
        this.recordMissing(recoveryId);
        if (!this.allowMissingActionClips) throw new AnimationBindingError(this.assetId, recoveryId);
      } else if (recoveryAction !== action && recoveryWeight > 0) {
        this.validateRootMotion(recoveryId);
        recoveryLayer = this.layerFor(recoveryAction);
      }
    }
    this.sampleClock(loopTimeSeconds, loops);
    const target = this.layerFor(action);
    if (this.overlay === target) this.overlay = undefined;
    const previous = this.current;
    // Normalized gait phase a loop that starts now inherits: the loop it replaces, else the one a finite action interrupted.
    const carry = previous && previous !== target ? (previous.loops ? previous.phase / previous.duration : this.suspendedPhase) : undefined;
    if (previous && previous !== target && previous.loops && !loops) this.suspendedPhase = carry;

    // A recovery loop that is no longer requested joins the fade set so it fades out (or is promoted) smoothly.
    let refade = false;
    if (this.recovery && this.recovery !== recoveryLayer) { this.foldRecovery(); refade = true; }
    if (recoveryLayer && this.recovery !== recoveryLayer) this.detachRecovery(recoveryLayer);

    const startsNow = !this.live.includes(target);
    if (startsNow) this.startLayer(target);
    target.loops = loops;
    target.action.setLoop(loops ? LoopRepeat : LoopOnce, loops ? Infinity : 1);
    target.action.clampWhenFinished = !loops;
    target.action.paused = true;
    if (target !== previous || refade) {
      this.beginTransition(target, previous, loops);
      if (loops) this.suspendedPhase = undefined;
    } else if (!loops && this.blendSeconds !== undefined && normalizedTime !== undefined && Number.isFinite(normalizedTime)
      && this.lastFiniteTime !== undefined && normalizedTime < this.lastFiniteTime - RESTART_DROP) this.beginRestartBlend();
    this.lastFiniteTime = !loops && normalizedTime !== undefined && Number.isFinite(normalizedTime) ? normalizedTime : undefined;
    this.current = target;
    this.currentActionId = id;

    for (let i = 0; i < this.live.length; i += 1) {
      const layer = this.live[i]!;
      if (layer !== target && layer.loops) this.advanceLoop(layer, layer.rate, undefined, undefined, false);
    }
    if (loops) this.advanceLoop(target, rate, carry, normalizedTime, startsNow);
    else if (normalizedTime !== undefined && Number.isFinite(normalizedTime) && target.duration > 0) {
      // Finite actions ignore the loop clock entirely; each call rebuilds from snapshot progress so repeated
      // identical actions never inherit a stale completion.
      target.action.time = target.duration * clamp01(normalizedTime);
    }

    if (!loops && recoveryLayer) {
      const started = this.recovery !== recoveryLayer && this.attachRecovery(recoveryLayer);
      this.recoveryWeight = clamp01(recoveryWeight);
      this.advanceLoop(recoveryLayer, rate, this.suspendedPhase, undefined, started);
      this.suspendedPhase = recoveryLayer.phase / recoveryLayer.duration;
    }
    this.applyWeights();
    this.grounding?.restore();
    this.mixer.update(0);
    this.compensateRootMotion();
    this.postPose?.();
    this.grounding?.apply(0);
  }

  /**
   * Presentation overlay: blends a (typically partial-body) clip sampled at `normalizedTime` over the main pose with the
   * given share (0 removes it). Never changes the active action, loop phase or root motion; applied by the next
   * `play()`/`update()`. Ignored while the clip is the active, fading or recovery action.
   */
  setOverlay(actionId: ActionId | string | undefined, normalizedTime = 0, share = 0): void {
    if (this.disposed) return;
    const action = actionId === undefined ? undefined : this.actions.get(String(actionId));
    const layer = action && share > 0 ? this.layerFor(action) : undefined;
    if (layer && (layer === this.current || layer === this.recovery || this.live.includes(layer))) return;
    if (this.overlay && this.overlay !== layer) { this.overlay.action.stop(); this.overlay = undefined; }
    if (!layer) { this.overlayShare = 0; return; }
    if (this.overlay !== layer) {
      layer.action.reset();
      layer.action.setLoop(LoopOnce, 1);
      layer.action.clampWhenFinished = true;
      layer.action.paused = true;
      layer.action.play();
      this.overlay = layer;
    }
    layer.action.time = layer.duration * clamp01(normalizedTime);
    this.overlayShare = Math.min(0.9, share);
    this.applyWeights();
  }

  playPreview(actionId: ActionId | string): void {
    this.play(actionId, 'idle', 0);
    if (this.current) this.current.action.paused = false;
  }
  /**
   * Advances the fade schedule and any unpaused preview/local playback. Gameplay loop cadence is owned entirely by
   * play(clock, rate) so duplicate clocks or re-render deltas cannot smuggle extra phase. `frozen` (simulation hit-stop)
   * stops the real-time fade so a transition never completes while the sampled pose is held.
   */
  update(dt: number, frozen = false): void {
    if (this.disposed || frozen || !Number.isFinite(dt) || dt <= 0) return;
    if (this.fadeElapsed < this.fadeDuration) this.fadeElapsed = Math.min(this.fadeDuration, this.fadeElapsed + dt);
    if (this.restarting) this.restartElapsed = Math.min(this.restartDuration, this.restartElapsed + dt);
    this.applyWeights();
    this.grounding?.restore();
    this.mixer.update(dt);
    this.compensateRootMotion();
    this.postPose?.();
    this.grounding?.apply(dt);
  }
  /**
   * Presentation-only pose override (e.g. a weapon grip) run right after every mixer evaluation, so it always wins over
   * clip-sampled joints without touching the root-motion or timing logic. One hook per controller; `undefined` removes it.
   */
  setPostPose(hook: (() => void) | undefined): void { this.postPose = hook; }
  /** Separate slot that always runs after `postPose`; installing or removing it restores the clip pose it had corrected. */
  setGrounding(slot: GroundingSlot | undefined): void {
    if (this.grounding !== slot) this.grounding?.restore();
    this.grounding = slot;
  }
  /**
   * Presentation blend for monsters: finite→finite hand-offs fade over `seconds`, and a finite clip that restarts on the same slot
   * (its normalized time jumps back) crossfades from the pose it was showing instead of popping. `undefined` restores the defaults.
   */
  setBlendSeconds(seconds: number | undefined): void {
    this.blendSeconds = seconds !== undefined && Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
    if (this.blendSeconds === undefined) this.endRestart();
  }
  get activeActionId(): string | undefined { return this.currentActionId; }
  get activeTime(): number | undefined { return this.current?.action.time; }
  get activeDuration(): number | undefined { return this.current?.duration; }
  get activeContactMarkers(): readonly NonNullable<AssetManifestEntry['contacts']>[number][] {
    const actionId = this.activeActionId;
    return actionId ? (this.manifest.contacts ?? []).filter((contact) => String(contact.actionId) === actionId) : [];
  }
  get activeRootMotionMetadata(): RootMotionMetadata | undefined {
    const actionId = this.activeActionId;
    return actionId ? this.manifest.rootMotion?.[actionId] : undefined;
  }
  get rootMotionStatus(): string {
    const motion = this.activeRootMotionMetadata;
    return motion ? `authored ${motion.mode} metadata (${motion.evidenceStatus})` : 'unavailable: no per-action root-motion record';
  }
  get contactEventStatus(): string {
    return this.manifest.contacts?.length ? 'authored per-action contact markers are available' : 'unavailable: no authored contact markers on this asset';
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot());
    this.actions.clear();
    this.layers.clear();
    this.live.length = 0;
    this.current = undefined;
    this.currentActionId = undefined;
    this.recovery = undefined;
    this.overlay = undefined;
    this.rootMotionBindings.clear();
    this.planarSpeeds.clear();
    this.endRestart();
    this.restartPose = undefined;
    this.lastFiniteTime = undefined;
    this.suspendedPhase = undefined;
    this.previousClock = undefined;
    this.postPose = undefined;
    this.grounding = undefined;
  }


  /** Captures the pose currently shown (including a fade still running) into the reusable pose clip and fades from it into the restarted clip. */
  private beginRestartBlend(): void {
    const pose = this.restartPose ??= this.createRestartPose();
    for (let i = 0; i < pose.bones.length; i += 1) {
      const node = pose.bones[i]!, position = pose.position[i]!, quaternion = pose.quaternion[i]!;
      node.position.toArray(position, 0); node.position.toArray(position, 3);
      node.quaternion.toArray(quaternion, 0); node.quaternion.toArray(quaternion, 4);
    }
    const action = pose.action;
    action.stop();
    action.reset();
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    action.paused = true;
    action.play();
    action.time = 0;
    this.restartElapsed = 0;
    this.restartDuration = this.blendSeconds!;
    this.restarting = true;
  }

  private createRestartPose(): NonNullable<AnimationController['restartPose']> {
    const bones: Object3D[] = [], tracks: (VectorKeyframeTrack | QuaternionKeyframeTrack)[] = [];
    const position: Float32Array[] = [], quaternion: Float32Array[] = [];
    this.root.traverse((node) => {
      if (!('isBone' in node) || node.isBone !== true || node.name === '') return;
      const positionTrack = new VectorKeyframeTrack(`${node.name}.position`, [0, 1], new Float32Array(6));
      const quaternionTrack = new QuaternionKeyframeTrack(`${node.name}.quaternion`, [0, 1], new Float32Array(8));
      bones.push(node); position.push(positionTrack.values); quaternion.push(quaternionTrack.values);
      tracks.push(positionTrack, quaternionTrack);
    });
    const action = this.mixer.clipAction(new AnimationClip('wc:restart-pose', 1, tracks));
    return { action, bones, position, quaternion };
  }

  private endRestart(): void {
    if (!this.restarting) return;
    this.restarting = false;
    this.restartPose?.action.stop();
  }

  private layerFor(action: AnimationAction): Layer {
    let layer = this.layers.get(action);
    if (!layer) {
      layer = { action, duration: action.getClip().duration, loops: false, phase: 0, rate: 1, value: 0, from: 0, to: 0 };
      this.layers.set(action, layer);
    }
    return layer;
  }

  private recordMissing(actionId: string): void {
    if (this.reportedMissing.has(actionId)) return;
    this.reportedMissing.add(actionId);
    this.issues.push({ kind: 'missing-clip', actionId, assetId: this.assetId });
  }

  /** Missing clip: record it, then keep the running loop (or resume idle) instead of fading to the bind pose. */
  private holdForMissing(actionId: string, clock: number | undefined, rate: number): void {
    this.recordMissing(actionId);
    if (!this.allowMissingActionClips) throw new AnimationBindingError(this.assetId, actionId);
    const held = this.current?.loops ? this.currentActionId : this.fallbackActionId;
    if (held !== undefined && held !== actionId) this.play(held, 'idle', undefined, clock, this.current?.loops ? this.current.rate : rate);
  }

  /**
   * Reads the authoritative clock once per call: `clockDelta` is the advance since the last sample; `clockSeeded` marks a
   * first sample or rewind, which reseeds every running loop to `clock * rate` and drops the suspended gait.
   */
  private sampleClock(clock: number | undefined, loops: boolean): void {
    this.clockDelta = 0;
    this.clockSeeded = false;
    this.clockValid = clock !== undefined && Number.isFinite(clock);
    if (clock !== undefined && this.clockValid) {
      if (this.previousClock === undefined) this.clockSeeded = true;
      else if (clock < this.previousClock) { this.clockSeeded = true; this.suspendedPhase = undefined; }
      else this.clockDelta = clock - this.previousClock;
      this.previousClock = clock;
      this.clock = clock;
    } else if (loops) this.previousClock = undefined;
  }

  /**
   * Advances one running loop for this call by `clockDelta * rate`. A loop that starts now (`fresh`) inherits the
   * normalized `carry` phase; without an actor clock the snapshot's `normalizedTime` is the phase.
   */
  private advanceLoop(layer: Layer, rate: number, carry: number | undefined, normalizedTime: number | undefined, fresh: boolean): void {
    if (layer.duration <= 0) return;
    layer.rate = rate;
    if (this.clockValid) {
      if (this.clockSeeded || (fresh && carry === undefined)) layer.phase = this.clock * rate;
      else layer.phase = (fresh ? carry! * layer.duration : layer.phase) + this.clockDelta * rate;
    } else if (normalizedTime !== undefined && Number.isFinite(normalizedTime)) layer.phase = layer.duration * clamp01(normalizedTime);
    else if (fresh) layer.phase = (carry ?? 0) * layer.duration;
    layer.phase = ((layer.phase % layer.duration) + layer.duration) % layer.duration;
    layer.action.time = layer.phase;
  }

  private startLayer(layer: Layer): void {
    layer.action.reset();
    layer.action.enabled = true;
    layer.action.play();
    layer.phase = 0;
    layer.value = 0;
    layer.from = 0;
    layer.to = 0;
  }

  /** Restarts the fade from the weights reached so far: `target` rises to 1, every other live layer falls to 0. */
  private beginTransition(target: Layer, previous: Layer | undefined, loops: boolean): void {
    for (let i = 0; i < this.live.length; i += 1) { const layer = this.live[i]!; layer.from = layer.value; layer.to = 0; }
    if (this.live.length === 0 && !this.recovery) {
      // Nothing visible yet: avoid a bind/T-pose flash by showing the new action at full weight immediately.
      target.value = target.from = target.to = 1;
      this.live.push(target);
      this.fadeElapsed = this.fadeDuration = 0;
      return;
    }
    if (!this.live.includes(target)) { target.value = 0; this.live.push(target); }
    target.from = target.value;
    target.to = 1;
    const wasLoop = previous?.loops ?? false;
    this.fadeDuration = wasLoop ? (loops ? ANIMATION_FADE_SECONDS.loopToLoop : ANIMATION_FADE_SECONDS.loopToFinite)
      : loops ? ANIMATION_FADE_SECONDS.finiteToLoop : (this.blendSeconds ?? ANIMATION_FADE_SECONDS.finiteToFinite);
    this.fadeElapsed = 0;
  }

  /** Moves the recovery loop into the fade set at its visible weight so a transition can promote or fade it. */
  private foldRecovery(): void {
    const recovery = this.recovery;
    if (!recovery) return;
    const keep = 1 - this.recoveryWeight;
    for (let i = 0; i < this.live.length; i += 1) this.live[i]!.value *= keep;
    recovery.value = this.recoveryWeight;
    this.live.push(recovery);
    this.recovery = undefined;
    this.recoveryWeight = 0;
  }

  /** Takes a layer that is fading out under the explicit recovery weight; the remaining fade weights are renormalized. */
  private detachRecovery(layer: Layer): void {
    const index = this.live.indexOf(layer);
    if (index < 0) return;
    this.live.splice(index, 1);
    let fromSum = 0, toSum = 0;
    for (let i = 0; i < this.live.length; i += 1) { fromSum += this.live[i]!.from; toSum += this.live[i]!.to; }
    for (let i = 0; i < this.live.length; i += 1) {
      const other = this.live[i]!;
      if (fromSum > 1e-6) other.from /= fromSum;
      if (toSum > 1e-6) other.to /= toSum;
    }
  }

  /** Returns true when the loop had to be started (it was not already running as a fading layer). */
  private attachRecovery(layer: Layer): boolean {
    const started = !layer.action.isScheduled();
    if (started) this.startLayer(layer);
    layer.loops = true;
    layer.action.enabled = true;
    layer.action.setLoop(LoopRepeat, Infinity);
    layer.action.clampWhenFinished = false;
    layer.action.paused = true;
    this.recovery = layer;
    return started;
  }

  /** Applies the fade schedule, recovery weight and overlay share to the mixer actions; finished fade-outs are released. */
  private applyWeights(): void {
    const progress = this.fadeDuration > 0 ? Math.min(1, this.fadeElapsed / this.fadeDuration) : 1;
    const recovery = this.recovery ? this.recoveryWeight : 0;
    // The restart pose owns the share of the final pose it has not yet faded out; every other layer scales into the remainder.
    let ghost = 0;
    if (this.restarting) {
      if (this.restartElapsed >= this.restartDuration) this.endRestart();
      else { ghost = 1 - this.restartElapsed / this.restartDuration; const action = this.restartPose!.action; action.enabled = true; action.setEffectiveWeight(ghost); }
    }
    const rest = 1 - ghost;
    for (let i = this.live.length - 1; i >= 0; i -= 1) {
      const layer = this.live[i]!;
      layer.value = layer.from + (layer.to - layer.from) * progress;
      if (progress >= 1 && layer.to === 0 && layer !== this.current) {
        layer.value = 0;
        layer.action.stop();
        this.live.splice(i, 1);
        continue;
      }
      this.setWeight(layer, layer.value * (1 - recovery) * rest);
    }
    if (this.recovery) this.setWeight(this.recovery, recovery * rest);
    // Overlay tracks cover only part of the rig: weighting it relative to the unit-sum main pose keeps the remaining joints untouched.
    if (this.overlay) this.setWeight(this.overlay, this.overlayShare / (1 - this.overlayShare));
  }

  private setWeight(layer: Layer, weight: number): void {
    layer.action.enabled = weight > 0;
    layer.action.setEffectiveWeight(weight);
  }

  private captureRootMotionBindings(): void {
    const motions = this.manifest.rootMotion;
    if (!motions) return;
    this.root.updateMatrixWorld(true);
    const rootInverse = new Matrix4().copy(this.root.matrixWorld).invert();
    const parentToRoot = new Matrix4();
    for (const motion of Object.values(motions)) {
      if (!motion || motion.mode === 'in-place') continue;
      if (!motion.rootNodeName) continue;
      if (this.rootMotionBindings.has(motion.rootNodeName)) continue;
      const node = this.root.getObjectByName(motion.rootNodeName);
      if (!node) continue;
      const up = new Vector3(0, 1, 0);
      if (node.parent && node.parent !== this.root) {
        up.transformDirection(parentToRoot.multiplyMatrices(rootInverse, node.parent.matrixWorld).invert());
        // Axis-aligned rigs keep exact components so the horizontal reset stays bit-identical to the bind.
        up.set(Math.abs(up.x) < 1e-6 ? 0 : up.x, Math.abs(up.y) < 1e-6 ? 0 : up.y, Math.abs(up.z) < 1e-6 ? 0 : up.z).normalize();
      }
      this.rootMotionBindings.set(motion.rootNodeName, { node, bindPosition: node.position.clone(), up });
    }
    const displacement = new Vector3();
    for (const [actionId, motion] of Object.entries(motions)) {
      if (!/walk|run|strafe/.test(actionId) || motion?.mode !== 'native-root-motion' || motion.evidenceStatus !== 'verified') continue;
      const samples = motion.curveSamples;
      const binding = this.rootMotionBindings.get(motion.rootNodeName ?? '');
      if (!binding || !samples || samples.length < 2) continue;
      const first = samples[0]!, last = samples[samples.length - 1]!;
      const duration = last.time - first.time;
      if (!(duration > 0)) continue;
      displacement.set(last.position.x - first.position.x, last.position.y - first.position.y, last.position.z - first.position.z);
      if (binding.node.parent && binding.node.parent !== this.root) {
        parentToRoot.multiplyMatrices(rootInverse, binding.node.parent.matrixWorld).setPosition(0, 0, 0);
        displacement.applyMatrix4(parentToRoot);
      }
      const speed = Math.hypot(displacement.x, displacement.z) * (this.manifest.coordinateTransform?.scale ?? 1) / duration;
      if (Number.isFinite(speed)) this.planarSpeeds.set(actionId, speed);
    }
  }

  private validateRootMotion(actionId: string): void {
    const motion = this.manifest.rootMotion?.[actionId];
    if (!motion) throw new RootMotionBindingError(this.assetId, actionId, 'manifest has no explicit root-motion policy');
    if (motion.evidenceStatus !== 'verified') throw new RootMotionBindingError(this.assetId, actionId, `evidence is ${motion.evidenceStatus}`);
    if (motion.mode === 'in-place') return;
    if (motion.mode === 'unverified') throw new RootMotionBindingError(this.assetId, actionId, 'manifest marks the curve unverified');
    if (!motion.rootNodeName) throw new RootMotionBindingError(this.assetId, actionId, 'rootNodeName is missing');
    if (!motion.curveSamples || motion.curveSamples.length < 2) throw new RootMotionBindingError(this.assetId, actionId, 'verified curve samples are missing');
    if (motion.curveSamples.some((sample) => !Number.isFinite(sample.time) || !Number.isFinite(sample.position.x) || !Number.isFinite(sample.position.y) || !Number.isFinite(sample.position.z))) throw new RootMotionBindingError(this.assetId, actionId, 'curve samples contain non-finite values');
    // Canonical bind is captured exactly once in the constructor before
    // any playback. validate only re-checks the rig still exposes the
    // declared native root node; it must never clone an already-posed
    // position into a fresh bind.
    if (!this.rootMotionBindings.has(motion.rootNodeName)) {
      const node = this.root.getObjectByName(motion.rootNodeName);
      if (!node) throw new RootMotionBindingError(this.assetId, actionId, `root node '${motion.rootNodeName}' does not exist in the native rig`);
      throw new RootMotionBindingError(this.assetId, actionId, `root node '${motion.rootNodeName}' has no canonical bind captured before playback`);
    }
  }

  private compensateRootMotion(): void {
    const actionId = this.currentActionId;
    if (!actionId) return;
    const motion = this.manifest.rootMotion?.[actionId];
    if (!motion || motion.mode === 'in-place') return;
    const binding = this.rootMotionBindings.get(motion.rootNodeName ?? '');
    if (!binding) return;
    if (motion.preserveVerticalMotion) {
      // Retain the authored native vertical (crouch, bob, dive tuck) so simulation
      // can own the airborne root rise; only snap horizontal travel back
      // to the canonical bind. Vertical is the rig's actor-space up, not parent-local Y.
      const vertical = rootMotionOffset.subVectors(binding.node.position, binding.bindPosition).dot(binding.up);
      binding.node.position.copy(binding.bindPosition).addScaledVector(binding.up, vertical);
    } else {
      binding.node.position.copy(binding.bindPosition);
    }
  }
}
