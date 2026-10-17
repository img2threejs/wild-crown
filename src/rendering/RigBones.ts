import { PropertyBinding, Quaternion, Vector3, type Object3D } from 'three';

/**
 * Bones a rig exposes to procedural motion (reaction bends, look-at, spring tails), found once per instance by name:
 * Mixamo biped (heroes, humanoid companions: `mixamorig:Spine…Head`) and Tripo creature rigs (`tripo::Spine_n`, `Head_n`, `Tail_n`,
 * `<side>_Limb_n`). Chains are ordered from the base outward and each bone is a descendant of the one before it.
 */
export interface RigBones {
  readonly kind: 'biped' | 'creature';
  /** Torso bones, base first (biped: Spine, Spine1, Spine2; creature: Spine_n without the pelvis root). */
  readonly spine: readonly Object3D[];
  /** Neck / head bones, base first; the last one is the head. */
  readonly head: readonly Object3D[];
  /** Tail chains (creatures); each base first. */
  readonly tails: readonly (readonly Object3D[])[];
  /** Legs of a creature (one chain per limb, base first); empty for bipeds (FootGrounding owns their legs). */
  readonly limbs: readonly (readonly Object3D[])[];
}

const BIPED_SPINE = ['mixamorig:Spine', 'mixamorig:Spine1', 'mixamorig:Spine2'] as const;
const BIPED_HEAD = ['mixamorig:Neck', 'mixamorig:Head'] as const;
const CREATURE_PART = /(Spine|Head|Tail)_(\d+)$/;
const CREATURE_LIMB = /(\d+_(?:Left|Right))_Limb_(\d+)$/;

function isAncestor(ancestor: Object3D, node: Object3D): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) if (parent === ancestor) return true;
  return false;
}

/** Longest prefix of `bones` (sorted by index) in which every bone descends from the previous one. */
function chainOf(bones: readonly Object3D[]): Object3D[] {
  const chain: Object3D[] = [];
  for (const bone of bones) {
    if (chain.length > 0 && !isAncestor(chain[chain.length - 1]!, bone)) break;
    chain.push(bone);
  }
  return chain;
}

/** Null when the rig has neither a complete biped spine/head nor any creature chain. */
export function findRigBones(root: Object3D): RigBones | null {
  const find = (name: string): Object3D | undefined => root.getObjectByName(PropertyBinding.sanitizeNodeName(name)) ?? root.getObjectByName(name);
  const spine = BIPED_SPINE.map(find), head = BIPED_HEAD.map(find);
  if (spine.every(Boolean) && head.every(Boolean)) {
    return { kind: 'biped', spine: spine as Object3D[], head: head as Object3D[], tails: [], limbs: [] };
  }
  const parts: Record<string, { index: number; bone: Object3D }[]> = { Spine: [], Head: [], Tail: [] };
  const limbs = new Map<string, { index: number; bone: Object3D }[]>();
  root.traverse((node) => {
    if (!('isBone' in node) || node.isBone !== true) return;
    const part = CREATURE_PART.exec(node.name);
    if (part) parts[part[1]!]!.push({ index: Number(part[2]), bone: node });
    const limb = CREATURE_LIMB.exec(node.name);
    if (limb) {
      const list = limbs.get(limb[1]!) ?? [];
      list.push({ index: Number(limb[2]), bone: node });
      limbs.set(limb[1]!, list);
    }
  });
  const ordered = (list: { index: number; bone: Object3D }[]): Object3D[] => chainOf(list.sort((a, b) => a.index - b.index).map(entry => entry.bone));
  const spineChain = ordered(parts.Spine!), headChain = ordered(parts.Head!), tail = ordered(parts.Tail!);
  if (spineChain.length === 0 && headChain.length === 0 && tail.length === 0) return null;
  return {
    kind: 'creature',
    // The first spine bone is the pelvis root of the rig: bending it would swing the legs with it.
    spine: spineChain.length >= 3 ? spineChain.slice(1) : spineChain,
    head: headChain,
    tails: tail.length >= 2 ? [tail] : [],
    limbs: [...limbs.values()].map(ordered).filter(chain => chain.length >= 3),
  };
}

const parentQ = new Quaternion(), parentInverse = new Quaternion(), worldQ = new Quaternion();
const scaleScratch = new Vector3(), positionScratch = new Vector3();

/**
 * Rotates `bone` by `angle` about the world axis `axis` (unit), keeping the rest of the chain attached. The parent's world matrix must be
 * current; the bone's own world matrix is refreshed on return so its children can be processed next.
 */
export function rotateBoneWorld(bone: Object3D, axis: Vector3, angle: number): void {
  const parent = bone.parent;
  if (!parent || angle === 0) return;
  parent.matrixWorld.decompose(positionScratch, parentQ, scaleScratch);
  parentInverse.copy(parentQ).invert();
  worldQ.setFromAxisAngle(axis, angle);
  bone.quaternion.premultiply(parentQ).premultiply(worldQ).premultiply(parentInverse).normalize();
  bone.updateWorldMatrix(false, false);
}
