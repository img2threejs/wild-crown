import { Box3, Mesh, type Object3D } from 'three';

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

/** Finds Aren's right hand/forearm bones once per rendered root (sanitized Mixamo names). */
export class HandRig {
  hand: Object3D | undefined;
  forearm: Object3D | undefined;
  private root: Object3D | undefined;

  resolve(root: Object3D | undefined): void {
    if (root === this.root) return;
    this.root = root; this.hand = undefined; this.forearm = undefined;
    root?.traverse(node => {
      if (!this.hand && HAND_NAME.test(node.name)) this.hand = node;
      if (!this.forearm && FOREARM_NAME.test(node.name)) this.forearm = node;
    });
  }

  clear(): void { this.root = undefined; this.hand = undefined; this.forearm = undefined; }
}
