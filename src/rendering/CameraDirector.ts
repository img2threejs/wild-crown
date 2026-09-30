import { PerspectiveCamera, Raycaster, Scene, Vector3, type Object3D } from 'three';
import type { CombatSnapshot, RegionDefinition } from '../game/contracts';

export interface CameraDebugState { mode: 'exploration' | 'encounter'; position: readonly [number, number, number]; target: readonly [number, number, number]; telegraphLocked: boolean; collisionDistance: number }

/** Three-quarter guided camera with authored anchors, telegraph framing lock, and authored collider ray tests. */
export class CameraDirector {
  readonly camera: PerspectiveCamera;
  private readonly desired = new Vector3();
  private readonly target = new Vector3();
  private readonly direction = new Vector3();
  private readonly offset = new Vector3();
  private readonly worldUp = new Vector3(0, 1, 0);
  private readonly flatForward = new Vector3();
  private readonly flatRight = new Vector3();
  private readonly raycaster = new Raycaster();
  private readonly occluders: Object3D[] = [];
  private mode: CameraDebugState['mode'] = 'exploration';
  private telegraphLocked = false;
  private collisionDistance = 0;
  private initialized = false;
  private region: RegionDefinition | undefined;

  constructor(private readonly scene: Scene, camera?: PerspectiveCamera) {
    this.camera = camera ?? new PerspectiveCamera(44, 1, 0.1, 180);
    this.camera.position.set(0, 5.6, 8.5);
    this.camera.lookAt(0, 1.15, 0);
    scene.add(this.camera);
  }

  setRegion(region: RegionDefinition): void {
    this.region = region;
    this.occluders.length = 0;
    this.scene.traverse((node) => { if (node.userData.cameraOccluder === true) this.occluders.push(node); });
  }

  update(combat: CombatSnapshot, dt: number): void {
    const player = combat.actors.find((actor) => actor.id === 'aren') ?? combat.actors.find((actor) => actor.allegiance === 'player');
    if (!player) return;
    this.mode = combat.encounterId || combat.boss ? 'encounter' : 'exploration';
    this.telegraphLocked = combat.telegraphs.some((telegraph) => telegraph.phase !== 'resolved' && telegraph.remainingTicks > 0);
    const anchorMode = this.mode === 'encounter' ? 'encounter' : 'exploration';
    const anchor = this.region?.cameraAnchors.find((candidate) => candidate.mode === anchorMode) ?? this.region?.cameraAnchors[0];
    if (anchor && !this.telegraphLocked) {
      this.target.set(anchor.lookAt.x, anchor.lookAt.y, anchor.lookAt.z);
      this.desired.set(anchor.position.x, anchor.position.y, anchor.position.z);
      this.offset.subVectors(this.desired, this.target);
      this.target.set(player.position.x, player.position.y + 1.15, player.position.z);
      this.desired.copy(this.target).add(this.offset);
    } else if (!this.telegraphLocked) {
      this.target.set(player.position.x, player.position.y + 1.2, player.position.z);
      this.desired.set(player.position.x + 5.2, player.position.y + 4.2, player.position.z + 7.6);
    }
    if (!this.initialized) {
      this.camera.position.copy(this.desired);
      this.camera.lookAt(this.target);
      this.initialized = true;
    }
    const delta = Math.max(0, Math.min(dt, 0.1));
    this.camera.position.lerp(this.desired, 1 - Math.exp(-delta * (this.telegraphLocked ? 18 : 4.5)));
    this.offset.subVectors(this.camera.position, this.target);
    this.collisionDistance = this.offset.length();
    this.direction.copy(this.offset).normalize();
    this.raycaster.set(this.target, this.direction);
    this.raycaster.far = this.collisionDistance;
    const hit = this.raycaster.intersectObjects(this.occluders, true)[0];
    if (hit && hit.distance < this.collisionDistance) {
      this.collisionDistance = hit.distance;
      this.camera.position.copy(this.target).addScaledVector(this.direction, Math.max(1.3, hit.distance - 0.35));
    }
    this.camera.lookAt(this.target);
    this.flatForward.copy(this.camera.getWorldDirection(this.direction)).setY(0).normalize();
    this.flatRight.crossVectors(this.flatForward, this.worldUp).normalize();
  }

  copyTarget(out: Vector3): void { out.copy(this.target); }
  get forward(): Vector3 { return this.flatForward; }
  get right(): Vector3 { return this.flatRight; }
  get cameraPosition(): readonly [number, number, number] { return [this.camera.position.x, this.camera.position.y, this.camera.position.z]; }
  get debugState(): CameraDebugState { return { mode: this.mode, position: this.cameraPosition, target: [this.target.x, this.target.y, this.target.z], telegraphLocked: this.telegraphLocked, collisionDistance: this.collisionDistance }; }
}
