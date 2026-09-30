import { AnimationMixer, LoopOnce, LoopRepeat, Vector3 } from 'three';
import type { AnimationAction, AnimationClip, Object3D } from 'three';
import type { ActionId, AssetManifestEntry } from '../game/contracts';

export type AnimationIssue = { kind: 'missing-clip'; actionId: string; assetId: string };
type RootMotionMetadata = NonNullable<AssetManifestEntry['rootMotion']>[string];
interface RootMotionBinding { node: Object3D; bindPosition: Vector3 }
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

/** Samples exact manifest-bound clip time from authoritative snapshots; mixer time never drives gameplay. */
export class AnimationController {
  readonly mixer: AnimationMixer;
  readonly issues: AnimationIssue[] = [];
  private readonly actions = new Map<string, AnimationAction>();
  private readonly actionIds = new Map<AnimationAction, string>();
  private readonly rootMotionBindings = new Map<string, RootMotionBinding>();
  private active: AnimationAction | undefined;
  private readonly assetId: string;
  private readonly root: Object3D;
  private readonly manifest: AssetManifestEntry;
  private disposed = false;

  constructor(root: Object3D, clips: readonly AnimationClip[], manifest: AssetManifestEntry) {
    this.assetId = manifest.id;
    this.root = root;
    this.manifest = manifest;
    this.mixer = new AnimationMixer(root);
    for (const actionId of manifest.requiredActionIds) {
      const clipName = manifest.actionToClipMapping[String(actionId)];
      const clip = clipName ? clips.find((candidate) => candidate.name === clipName) : undefined;
      if (!clip) {
        this.issues.push({ kind: 'missing-clip', actionId: String(actionId), assetId: manifest.id });
        continue;
      }
      const action = this.mixer.clipAction(clip);
      this.actions.set(String(actionId), action);
      this.actionIds.set(action, String(actionId));
    }
    for (const [actionId, clipName] of Object.entries(manifest.actionToClipMapping)) {
      if (!clipName || this.actions.has(actionId)) continue;
      const clip = clips.find((candidate) => candidate.name === clipName);
      if (!clip) continue;
      const action = this.mixer.clipAction(clip);
      this.actions.set(actionId, action);
      this.actionIds.set(action, actionId);
    }
  }

  play(actionId: ActionId | string, phase: string, normalizedTime?: number): void {
    if (this.disposed) throw new Error(`Animation controller for ${this.assetId} has been disposed.`);
    const id = String(actionId);
    const next = this.actions.get(id);
    if (!next) {
      if (!this.issues.some((issue) => issue.actionId === id)) this.issues.push({ kind: 'missing-clip', actionId: id, assetId: this.assetId });
      this.active?.fadeOut(0.12);
      this.active = undefined;
      throw new AnimationBindingError(this.assetId, id);
    }
    this.validateRootMotion(id);
    if (this.active !== next) {
      next.reset();
      next.enabled = true;
      next.fadeIn(0.12).play();
      this.active?.fadeOut(0.12);
      this.active = next;
    }
    const loops = phase === 'idle';
    next.setLoop(loops ? LoopRepeat : LoopOnce, loops ? Infinity : 1);
    next.clampWhenFinished = !loops;
    next.paused = true;
    if (normalizedTime !== undefined && Number.isFinite(normalizedTime)) {
      const duration = next.getClip().duration;
      const progress = loops ? ((normalizedTime % 1) + 1) % 1 : Math.max(0, Math.min(1, normalizedTime));
      if (duration > 0) next.time = duration * progress;
    }
    this.mixer.update(0);
    this.compensateRootMotion();
  }

  playPreview(actionId: ActionId | string): void {
    this.play(actionId, 'idle', 0);
    this.active!.paused = false;
  }
  update(dt: number): void {
    if (this.disposed || !Number.isFinite(dt) || dt <= 0) return;
    this.mixer.update(dt);
    this.compensateRootMotion();
  }
  get activeActionId(): string | undefined { return this.active ? this.actionIds.get(this.active) : undefined; }
  get activeTime(): number | undefined { return this.active?.time; }
  get activeDuration(): number | undefined { return this.active?.getClip().duration; }
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
    this.actionIds.clear();
    this.rootMotionBindings.clear();
    this.active = undefined;
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
    let binding = this.rootMotionBindings.get(actionId);
    if (!binding) {
      const node = this.root.getObjectByName(motion.rootNodeName);
      if (!node) throw new RootMotionBindingError(this.assetId, actionId, `root node '${motion.rootNodeName}' does not exist in the native rig`);
      binding = { node, bindPosition: node.position.clone() };
      this.rootMotionBindings.set(actionId, binding);
    }
  }

  private compensateRootMotion(): void {
    const actionId = this.activeActionId;
    if (!actionId) return;
    const motion = this.manifest.rootMotion?.[actionId];
    if (!motion || motion.mode === 'in-place') return;
    const binding = this.rootMotionBindings.get(actionId);
    if (binding) binding.node.position.copy(binding.bindPosition);
  }
}
