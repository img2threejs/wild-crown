import { Box3, Mesh, type Object3D, type Vector3 } from 'three';

export interface Body { readonly height: number; readonly radius: number }
export const DEFAULT_BODY: Body = { height: 1.2, radius: 0.8 };

/** Bind-pose body extents from loader-provided geometry bounds; never re-skins million-vertex meshes. */
export class ActorBodies {
  private readonly bodies = new WeakMap<Object3D, Body>();
  private readonly box = new Box3();
  private readonly part = new Box3();

  get(root: Object3D): Body {
    let body = this.bodies.get(root);
    if (!body) {
      root.updateWorldMatrix(true, true);
      this.box.makeEmpty();
      root.traverse(node => {
        if (!(node instanceof Mesh) || !node.geometry.boundingBox || node.name.startsWith('vfx-')) return;
        this.part.copy(node.geometry.boundingBox).applyMatrix4(node.matrixWorld);
        this.box.union(this.part);
      });
      const height = this.box.isEmpty() ? DEFAULT_BODY.height : Math.max(0.4, Math.min(4, this.box.max.y - this.box.min.y));
      const radius = this.box.isEmpty() ? DEFAULT_BODY.radius : Math.max(0.3, Math.min(2.5, Math.max(this.box.max.x - this.box.min.x, this.box.max.z - this.box.min.z) / 2));
      body = { height, radius };
      this.bodies.set(root, body);
    }
    return body;
  }
}

const HAND_NAME = /RightHand$/;
const FOREARM_NAME = /RightForeArm$/;
const LEFT_HAND_NAME = /LeftHand$/;
const LEFT_FOREARM_NAME = /LeftForeArm$/;

/** Finds the player's hand/forearm bones (right: the weapon arm; left: Yara's casting hand) once per rendered root (sanitized Mixamo names). */
export class HandRig {
  hand: Object3D | undefined;
  forearm: Object3D | undefined;
  leftHand: Object3D | undefined;
  leftForearm: Object3D | undefined;
  private root: Object3D | undefined;

  resolve(root: Object3D | undefined): void {
    if (root === this.root) return;
    this.root = root; this.hand = undefined; this.forearm = undefined; this.leftHand = undefined; this.leftForearm = undefined;
    root?.traverse(node => {
      if (!this.hand && HAND_NAME.test(node.name)) this.hand = node;
      if (!this.forearm && FOREARM_NAME.test(node.name)) this.forearm = node;
      if (!this.leftHand && LEFT_HAND_NAME.test(node.name)) this.leftHand = node;
      if (!this.leftForearm && LEFT_FOREARM_NAME.test(node.name)) this.leftForearm = node;
    });
  }

  clear(): void { this.root = undefined; this.hand = undefined; this.forearm = undefined; this.leftHand = undefined; this.leftForearm = undefined; }
}

/** Yara's skills cast by her free left hand (the captured spell takes); the others work through the staff (raised, levelled or planted). */
const YARA_HAND_CASTS: Readonly<Record<string, true>> = {
  'yara-thornshot-1': true, 'yara-thornshot-2': true, 'yara-thornshot-3': true, 'yara-binding-vines': true, 'yara-cleanse': true,
};
export function isYaraHandCast(actionId: string): boolean { return YARA_HAND_CASTS[actionId] === true; }

/** Metres beyond the wrist bone where the palm's centre sits (along forearm → hand). */
const PALM_OFFSET = 0.09;

/**
 * World position of the left palm and the forearm → hand direction (unit) for the current pose; false when the rig has no left arm.
 * `rig` must already be resolved against the rendered root. Allocation-free.
 */
export function leftPalm(rig: HandRig, palm: Vector3, direction: Vector3): boolean {
  const hand = rig.leftHand, forearm = rig.leftForearm;
  if (!hand || !forearm) return false;
  hand.updateWorldMatrix(true, false);
  hand.getWorldPosition(palm);
  forearm.getWorldPosition(direction);
  direction.subVectors(palm, direction);
  const length = direction.length();
  if (length < 1e-6) return false;
  direction.multiplyScalar(1 / length);
  palm.addScaledVector(direction, PALM_OFFSET);
  return true;
}
