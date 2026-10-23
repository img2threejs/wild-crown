import { PropertyBinding, Vector3, type Object3D } from 'three';
import type { CompanionId } from '../../game/contracts.js';

export type CompanionSocketName = 'mouth' | 'rightPaw' | 'leftPaw' | 'rightHand' | 'leftHand' | 'rightTalon' | 'leftTalon' | 'leftWing' | 'rightWing';

/**
 * One anatomical point of a species' native skeleton. `nodes` are the original glTF joint names (their positions are averaged); `offset` is a point
 * in the first-joint-local frame (glTF units, rotated and scaled with the joint) where the joint itself is not the anatomical point, and `forward` is the
 * joint-local direction the point faces (the mouth's bite direction). Both were measured against the native bind pose of the shipped runtime GLBs:
 * the nose / beak tip and the palm centre sit past the last joint, so a joint-local offset keeps them glued to the animated head or hand.
 */
interface SocketSpec {
  readonly nodes: readonly string[];
  readonly offset?: readonly [number, number, number];
  readonly forward?: readonly [number, number, number];
}
type SocketMap = Partial<Record<CompanionSocketName, SocketSpec>>;

// Every species faces +X except Sable (-Z); right is forward x up, so the "Right" limb chains sit at +Z (Sable: +X).
const SPECIES: Readonly<Record<CompanionId, SocketMap>> = {
  asha: {
    mouth: { nodes: ['tripo::Head_2'], offset: [-0.0899, 0.1152, 0.0014], forward: [-0.2572, 0.9659, 0.0281] },
    rightPaw: { nodes: ['tripo::0_Right_Limb_7'] },
    leftPaw: { nodes: ['bone_24'] },
  },
  sable: {
    mouth: { nodes: ['tripo::Head_3'], offset: [0.0303, 0.0946, -0.0019], forward: [0.5145, 0.8575, 0] },
    rightPaw: { nodes: ['tripo::0_Right_Limb_3'] },
    leftPaw: { nodes: ['tripo::0_Left_Limb_3'] },
  },
  nyra: {
    mouth: { nodes: ['tripo::Head_3'], offset: [0.021, 0.1247, -0.0052], forward: [0.3835, 0.9216, -0.0595] },
    rightPaw: { nodes: ['bone_22'] },
    leftPaw: { nodes: ['bone_17'] },
  },
  solkar: {
    mouth: { nodes: ['tripo::Head_3'], offset: [-0.0896, 0.0513, 0.0019], forward: [-0.6402, 0.7682, 0] },
    rightPaw: { nodes: ['tripo::0_Right_Limb_4'] },
    leftPaw: { nodes: ['tripo::0_Left_Limb_4'] },
  },
  koro: {
    mouth: { nodes: ['Head'], offset: [0.0037, 0.0131, -0.1437], forward: [0.0005, -0.0448, -0.999] },
    rightHand: { nodes: ['R_Hand'], offset: [0.0094, 0.0024, -0.0314] },
    leftHand: { nodes: ['L_Hand'], offset: [-0.0132, 0.0032, -0.017] },
  },
  vara: {
    mouth: { nodes: ['bone_40'], forward: [0.0767, 0.9855, 0.1512] },
    rightTalon: { nodes: ['tripo::0_Right_Limb_3', 'bone_15', 'bone_16'] },
    leftTalon: { nodes: ['tripo::0_Left_Limb_3', 'bone_7', 'bone_8'] },
    rightWing: { nodes: ['bone_27'] },
    leftWing: { nodes: ['bone_35'] },
  },
};

interface Resolved {
  readonly nodes: readonly Object3D[];
  readonly offset: Vector3 | undefined;
  readonly forward: Vector3 | undefined;
}
interface RootEntry {
  readonly names: Map<string, Object3D>;
  readonly sockets: Map<CompanionSocketName, Resolved | null>;
  companionId: CompanionId;
}

const scratch = new Vector3();

/**
 * World positions and facing of a companion's anatomical sockets on its drawn body. Joints are found once per root (original glTF name, or the name
 * three's loader sanitises it to) and cached; a socket the species does not have, or whose joint is absent from the loaded rig, answers `false`
 * so callers draw nothing rather than a disconnected effect. Reads walk only the joint's ancestor chain and allocate nothing.
 */
export class CompanionSockets {
  private readonly roots = new WeakMap<Object3D, RootEntry>();

  /** Writes the socket's world position into `out`; false when the species has no such socket or the rig lacks its joint. */
  position(root: Object3D, companionId: CompanionId, socket: CompanionSocketName, out: Vector3): boolean {
    const resolved = this.resolve(root, companionId, socket);
    if (!resolved) return false;
    const nodes = resolved.nodes, offset = resolved.offset;
    out.set(0, 0, 0);
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      node.updateWorldMatrix(true, false);
      if (offset && i === 0) scratch.copy(offset); else scratch.set(0, 0, 0);
      out.add(scratch.applyMatrix4(node.matrixWorld));
    }
    if (nodes.length > 1) out.multiplyScalar(1 / nodes.length);
    return true;
  }

  /** Writes the unit world direction the socket faces (the mouth's bite direction); false when the socket has none. */
  direction(root: Object3D, companionId: CompanionId, socket: CompanionSocketName, out: Vector3): boolean {
    const resolved = this.resolve(root, companionId, socket);
    if (!resolved?.forward) return false;
    const node = resolved.nodes[0]!;
    node.updateWorldMatrix(true, false);
    out.copy(resolved.forward).transformDirection(node.matrixWorld);
    return true;
  }

  private resolve(root: Object3D, companionId: CompanionId, socket: CompanionSocketName): Resolved | null {
    let entry = this.roots.get(root);
    if (!entry) {
      const names = new Map<string, Object3D>();
      root.traverse(node => {
        if (!node.name) return;
        if (!names.has(node.name)) names.set(node.name, node);
        const sanitized = PropertyBinding.sanitizeNodeName(node.name);
        if (!names.has(sanitized)) names.set(sanitized, node);
      });
      entry = { names, sockets: new Map(), companionId };
      this.roots.set(root, entry);
    } else if (entry.companionId !== companionId) {
      entry.sockets.clear();
      entry.companionId = companionId;
    }
    let resolved = entry.sockets.get(socket);
    if (resolved === undefined) {
      resolved = this.build(entry.names, SPECIES[companionId]?.[socket]);
      entry.sockets.set(socket, resolved);
    }
    return resolved;
  }

  private build(names: ReadonlyMap<string, Object3D>, spec: SocketSpec | undefined): Resolved | null {
    if (!spec) return null;
    const nodes: Object3D[] = [];
    for (const name of spec.nodes) {
      const node = names.get(name) ?? names.get(PropertyBinding.sanitizeNodeName(name));
      if (!node) return null;
      nodes.push(node);
    }
    return {
      nodes,
      offset: spec.offset ? new Vector3(spec.offset[0], spec.offset[1], spec.offset[2]) : undefined,
      forward: spec.forward ? new Vector3(spec.forward[0], spec.forward[1], spec.forward[2]).normalize() : undefined,
    };
  }
}
