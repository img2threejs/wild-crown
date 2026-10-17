import { Quaternion, Vector3, type Object3D } from 'three';
import type { GroundingSlot } from './AnimationController';
import { BIPED_LOOK_AT, CREATURE_LOOK_AT, LookAtIK } from './LookAtIK';
import type { ReactionPose } from './ReactionPresenter';
import { rotateBoneWorld, type RigBones } from './RigBones';
import { SpringChain, type SpringSpec } from './SpringBones';

/** How much of the procedural layer runs for an actor: far / off-screen actors skip it (animation LOD). */
export type ProceduralDetail = 'off' | 'reaction' | 'full';

/** Spring tuning for creature tails; heroes carry no hair / coat / charm joints, so there is nothing to spring on them (see docs). */
export const TAIL_SPRING: SpringSpec = { stiffness: 13, drag: 7, gravity: 0.6, limit: 0.55 };

/** Shares of a torso / head bend each bone carries, base first. */
const BIPED_SPINE_SHARES = [0.2, 0.35, 0.45];
const BIPED_HEAD_SHARES = [0.4, 0.6];

/** Per-frame inputs the renderer fills before the pose is built (a reused record: the frame allocates nothing). */
export interface ProceduralInputs {
  detail: ProceduralDetail;
  /** Combat reaction pose to apply; undefined or resting leaves the clip alone. */
  reaction: ReactionPose | undefined;
  /** Gaze: true while the actor may look at `target*` (idle / walking, no reaction). */
  lookEnabled: boolean;
  hasTarget: boolean;
  targetX: number;
  targetY: number;
  targetZ: number;
}

export function createProceduralInputs(): ProceduralInputs {
  return { detail: 'full', reaction: undefined, lookEnabled: false, hasTarget: false, targetX: 0, targetY: 0, targetZ: 0 };
}

const tiltAxis = new Vector3(), forward = new Vector3(), upV = new Vector3(0, 1, 0);

/**
 * Procedural bone layer over the evaluated clip: combat-reaction bends and dazed sway on the torso and head, head / spine look-at toward a
 * target and spring tails, then the wrapped foot grounding (legs only, independent of the torso). Installed as the animation controller's
 * grounding slot: `restore()` puts the clip rotations back before every mixer evaluation, `apply()` runs after the clip pose, so the mixer's
 * unchanged-value skip and root-motion compensation never see a corrected pose. Presentation only.
 */
export class ActorProcedural implements GroundingSlot {
  readonly inputs: ProceduralInputs = createProceduralInputs();
  private readonly bones: Object3D[] = [];
  private readonly saved: Quaternion[] = [];
  private hasSaved = false;
  private readonly look: LookAtIK | undefined;
  private readonly springs: SpringChain[] = [];
  private springsLive = false;

  constructor(private readonly root: Object3D, private readonly rig: RigBones, private readonly inner: GroundingSlot | null) {
    for (const bone of [...rig.spine, ...rig.head]) { this.bones.push(bone); this.saved.push(new Quaternion()); }
    if (rig.head.length > 0) this.look = new LookAtIK(rig.head.length >= 2 && rig.kind === 'biped' ? [...rig.spine, ...rig.head] : rig.head, rig.kind === 'biped' ? BIPED_LOOK_AT : CREATURE_LOOK_AT);
    for (const tail of rig.tails) this.springs.push(new SpringChain(tail, TAIL_SPRING));
  }

  /** The look-at rig (strength / angles for tests and tuning); undefined for rigs without a head chain. */
  get lookAt(): LookAtIK | undefined { return this.look; }
  get springChains(): readonly SpringChain[] { return this.springs; }

  restore(): void {
    if (this.hasSaved) {
      for (let i = 0; i < this.bones.length; i += 1) this.bones[i]!.quaternion.copy(this.saved[i]!);
      this.hasSaved = false;
    }
    for (const chain of this.springs) chain.restore();
    this.inner?.restore();
  }

  apply(dt: number): void {
    const inputs = this.inputs, pose = inputs.reaction;
    if (inputs.detail === 'off') {
      if (this.springsLive) { for (const chain of this.springs) chain.reset(); this.springsLive = false; }
      this.look?.reset();
      this.inner?.apply(dt);
      return;
    }
    const root = this.root;
    root.updateWorldMatrix(true, false);
    const e = root.matrixWorld.elements;
    forward.set(e[8]!, 0, e[10]!);
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, 1); else forward.normalize();
    const reacting = pose !== undefined && (pose.kind !== undefined || pose.spine !== 0 || pose.head !== 0 || pose.sway !== 0);
    if (reacting || (this.look && (inputs.lookEnabled || this.look.strength > 0))) {
      for (let i = 0; i < this.bones.length; i += 1) this.saved[i]!.copy(this.bones[i]!.quaternion);
      this.hasSaved = true;
      if (reacting) this.bend(pose!);
      if (this.look && !reacting) this.look.apply(dt, inputs.lookEnabled, inputs.hasTarget, forward.x, forward.z, inputs.targetX, inputs.targetY, inputs.targetZ);
      else this.look?.reset();
    }
    if (inputs.detail === 'full' && this.springs.length > 0) {
      for (const chain of this.springs) chain.apply(dt, e[12]!, e[13]!, e[14]!);
      this.springsLive = true;
    } else if (this.springsLive) { for (const chain of this.springs) chain.reset(); this.springsLive = false; }
    this.inner?.apply(dt);
  }

  /** Torso and head bend toward the push, dazed sway about the facing axis. */
  private bend(pose: ReactionPose): void {
    const rig = this.rig, biped = rig.kind === 'biped';
    tiltAxis.set(pose.dirZ, 0, -pose.dirX);
    const spine = rig.spine, head = rig.head;
    if (spine.length > 0) {
      spine[0]!.parent?.updateWorldMatrix(true, false);
      for (let i = 0; i < spine.length; i += 1) {
        const share = biped ? BIPED_SPINE_SHARES[i]! : 1 / spine.length;
        rotateBoneWorld(spine[i]!, tiltAxis, pose.spine * share);
        rotateBoneWorld(spine[i]!, forward, pose.sway * share);
      }
    }
    if (head.length > 0) {
      for (let i = 0; i < head.length; i += 1) {
        if (i === 0) head[0]!.parent?.updateWorldMatrix(true, false);
        const share = biped ? BIPED_HEAD_SHARES[i]! : 1 / head.length;
        rotateBoneWorld(head[i]!, tiltAxis, pose.head * share);
        rotateBoneWorld(head[i]!, forward, pose.sway * 0.6 * share);
        rotateBoneWorld(head[i]!, upV, pose.sway * 0.8 * share);
      }
    }
  }
}
