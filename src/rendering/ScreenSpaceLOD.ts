import { Group, Vector3, type Camera, type PerspectiveCamera } from 'three';
import type { NativeStaticBatch } from './NativeAssetLoader';

export interface ScreenSpaceLODPolicy { transitionPixels: readonly number[]; hysteresisRatio: number }
export interface ScreenSpaceLODDebugState { assetIds: readonly string[]; selectedLevel: number; projectedHeightPixels: number; measured: false }
export const DEFAULT_SCREEN_SPACE_LOD_POLICY: ScreenSpaceLODPolicy = { transitionPixels: [160, 64, 24], hysteresisRatio: 0.12 };

/** Screen-size LOD selector. Defaults are unprofiled engineering proposals pending P11 locked-hardware measurements. */
export class ScreenSpaceLOD {
  readonly root = new Group();
  private readonly anchors: readonly Vector3[];
  private selectedLevel = 0;
  private projectedHeightPixels = 0;
  private disposed = false;

  constructor(
    private readonly levels: readonly NativeStaticBatch[],
    placements: readonly { position: { x: number; y: number; z: number } }[],
    private readonly screenSpaceHeight: number,
    private readonly policy: ScreenSpaceLODPolicy = DEFAULT_SCREEN_SPACE_LOD_POLICY,
  ) {
    if (levels.length === 0) throw new Error('ScreenSpaceLOD requires a verified base asset level.');
    if (policy.transitionPixels.some((pixels, index) => !Number.isFinite(pixels) || pixels <= 0 || (index > 0 && pixels >= policy.transitionPixels[index - 1]!))) {
      throw new Error('LOD transition pixels must be positive and strictly descending from higher to lower detail.');
    }
    if (policy.hysteresisRatio < 0 || policy.hysteresisRatio >= 0.5) throw new Error('LOD hysteresis ratio must be in [0, 0.5).');
    this.anchors = placements.map((placement) => new Vector3(placement.position.x, placement.position.y, placement.position.z));
    for (const level of levels) this.root.add(level.root);
    this.select(0);
  }

  update(camera: Camera, cameraTarget: Vector3, viewportHeight: number, dt: number = 0): void {
    if (this.disposed || viewportHeight <= 0) return;
    const perspective = camera as PerspectiveCamera;
    let nearestDistance = Infinity;
    for (const point of this.anchors) {
      const distance = camera.position.distanceTo(point);
      if (distance < nearestDistance) nearestDistance = distance;
    }
    const fovRadians = perspective.fov * Math.PI / 180;
    this.projectedHeightPixels = this.screenSpaceHeight / (2 * Math.max(0.01, nearestDistance) * Math.tan(fovRadians / 2)) * viewportHeight;
    while (this.selectedLevel < this.levels.length - 1) {
      const threshold = this.policy.transitionPixels[this.selectedLevel] ?? this.policy.transitionPixels[this.policy.transitionPixels.length - 1] ?? 24;
      if (this.projectedHeightPixels >= threshold * (1 - this.policy.hysteresisRatio)) break;
      this.select(this.selectedLevel + 1);
    }
    while (this.selectedLevel > 0) {
      const threshold = this.policy.transitionPixels[this.selectedLevel - 1] ?? this.policy.transitionPixels[this.policy.transitionPixels.length - 1] ?? 24;
      if (this.projectedHeightPixels <= threshold * (1 + this.policy.hysteresisRatio)) break;
      this.select(this.selectedLevel - 1);
    }
    for (const level of this.levels) {
      level.updateOcclusion(camera, cameraTarget, dt);
      level.advanceFade();
    }
  }

  get debugState(): ScreenSpaceLODDebugState {
    return { assetIds: this.levels.map((level) => level.assetId), selectedLevel: this.selectedLevel, projectedHeightPixels: this.projectedHeightPixels, measured: false };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    for (const level of this.levels) level.dispose();
    this.root.clear();
  }

  private select(index: number): void {
    this.selectedLevel = index;
    for (let levelIndex = 0; levelIndex < this.levels.length; levelIndex++) this.levels[levelIndex]!.root.visible = levelIndex === index;
  }
}
