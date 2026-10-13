import { Box3, Matrix4, Quaternion, Vector3, type InstancedMesh } from 'three';
import type { RegionColliderDefinition, RegionDefinition, WorldAssetPlacement } from '../game/contracts.js';
import { solidPropKind } from '../content/solid-props.js';
import type { NativeStaticBatch } from './NativeAssetLoader.js';

export interface NativeSolidCollider {
  readonly placementId: string;
  readonly collider: RegionColliderDefinition;
  readonly visibleWhen?: string;
}
const UP = new Vector3(0, 1, 0);

function clipPolygon(input: Vector3[], output: Vector3[], count: number, axis: 'x' | 'y' | 'z', boundary: number, greater: boolean): number {
  let result = 0;
  for (let i = 0; i < count; i++) {
    const previous = input[(i + count - 1) % count]!, current = input[i]!;
    const before = greater ? previous[axis] >= boundary : previous[axis] <= boundary;
    const inside = greater ? current[axis] >= boundary : current[axis] <= boundary;
    if (before !== inside) output[result++]!.copy(previous).lerp(current, (boundary - previous[axis]) / (current[axis] - previous[axis]));
    if (inside) output[result++]!.copy(current);
  }
  return result;
}

/** Native geometry is measured once. Simulation then sweeps the resulting world solids. */
export function buildStaticPropColliders(batch: NativeStaticBatch, placements: readonly WorldAssetPlacement[], region: RegionDefinition): NativeSolidCollider[] {
  if (!placements.length) return [];
  const kind = solidPropKind(placements[0]!);
  if (kind === 'decoration') return [];
  const meshes: { mesh: InstancedMesh; local: Matrix4 }[] = [];
  const position = new Vector3(), scale = new Vector3(), rotation = new Quaternion();
  const placementMatrix = (placement: WorldAssetPlacement) => new Matrix4().compose(
    position.set(placement.position.x, placement.position.y, placement.position.z),
    rotation.setFromAxisAngle(UP, placement.rotationY), scale.set(placement.scale.x, placement.scale.y, placement.scale.z));
  const inversePlacement = placementMatrix(placements[0]!).invert();
  const point = new Vector3(), complete = new Box3();
  batch.root.updateWorldMatrix(true, true);
  batch.root.traverse(node => {
    const mesh = node as InstancedMesh;
    if (!mesh.isInstancedMesh) return;
    const instance = new Matrix4(); mesh.getMatrixAt(0, instance);
    const local = new Matrix4().multiplyMatrices(inversePlacement, mesh.matrixWorld).multiply(instance);
    meshes.push({ mesh, local });
    const vertices = mesh.geometry.getAttribute('position');
    for (let i = 0; i < vertices.count; i++) complete.expandByPoint(point.fromBufferAttribute(vertices, i).applyMatrix4(local));
  });
  if (complete.isEmpty()) return [];
  const parts: Box3[] = [];
  const height = complete.max.y - complete.min.y;
  if (kind === 'trunk') {
    const wood = new Box3();
    const top = complete.min.y + height * 0.3;
    for (const { mesh, local } of meshes) {
      const vertices = mesh.geometry.getAttribute('position');
      for (let i = 0; i < vertices.count; i++) {
        point.fromBufferAttribute(vertices, i).applyMatrix4(local);
        if (point.y <= top) wood.expandByPoint(point);
      }
    }
    if (!wood.isEmpty()) { wood.max.y = complete.max.y; parts.push(wood); }
  } else if (kind === 'platform') {
    // Authored surfaces support the deck; only actual outer rail/post geometry blocks above it.
    const narrow = complete.max.x - complete.min.x <= complete.max.z - complete.min.z ? 'x' : 'z';
    const middle = (complete.min[narrow] + complete.max[narrow]) / 2;
    const halfWidth = (complete.max[narrow] - complete.min[narrow]) / 2;
    const left = new Box3(), right = new Box3();
    for (const { mesh, local } of meshes) {
      const vertices = mesh.geometry.getAttribute('position');
      for (let i = 0; i < vertices.count; i++) {
        point.fromBufferAttribute(vertices, i).applyMatrix4(local);
        if (point.y <= 0.12 || Math.abs(point[narrow] - middle) < halfWidth * 0.64) continue;
        (point[narrow] < middle ? left : right).expandByPoint(point);
      }
    }
    for (const part of [left, right]) if (!part.isEmpty()) { part.min.y = Math.min(part.min.y, 0.12); parts.push(part); }
  } else if (kind === 'arch' && height * Math.abs(placements[0]!.scale.y) > 2.2) {
    const axis = complete.max.x - complete.min.x >= complete.max.z - complete.min.z ? 'x' : 'z';
    const middle = (complete.min[axis] + complete.max[axis]) / 2;
    // Height bands preserve curved doorways instead of extending upper wood into the opening.
    const bands = Math.ceil(height * Math.abs(placements[0]!.scale.y) / 0.25);
    const bounds = Array.from({ length: bands }, () => [new Box3(), new Box3()]);
    const polygon = Array.from({ length: 8 }, () => new Vector3());
    const scratch = Array.from({ length: 8 }, () => new Vector3());
    const triangle = Array.from({ length: 3 }, () => new Vector3());
    for (const { mesh, local } of meshes) {
      const vertices = mesh.geometry.getAttribute('position'), indices = mesh.geometry.index;
      const count = indices?.count ?? vertices.count;
      for (let i = 0; i + 2 < count; i += 3) {
        for (let vertex = 0; vertex < 3; vertex++) triangle[vertex]!.fromBufferAttribute(vertices, indices ? indices.getX(i + vertex) : i + vertex).applyMatrix4(local);
        const low = Math.min(triangle[0]!.y, triangle[1]!.y, triangle[2]!.y);
        const high = Math.max(triangle[0]!.y, triangle[1]!.y, triangle[2]!.y);
        const first = Math.max(0, Math.floor((low - complete.min.y) / height * bands));
        const last = Math.min(bands - 1, Math.floor((high - complete.min.y) / height * bands));
        for (let band = first; band <= last; band++) {
          for (let vertex = 0; vertex < 3; vertex++) polygon[vertex]!.copy(triangle[vertex]!);
          let clipped = clipPolygon(polygon, scratch, 3, 'y', complete.min.y + band / bands * height, true);
          clipped = clipPolygon(scratch, polygon, clipped, 'y', complete.min.y + (band + 1) / bands * height, false);
          for (let side = 0; side < 2; side++) {
            const points = clipPolygon(polygon, scratch, clipped, axis, middle, side === 1);
            for (let vertex = 0; vertex < points; vertex++) bounds[band]![side]!.expandByPoint(scratch[vertex]!);
          }
        }
      }
    }
    for (const pair of bounds) for (const part of pair) if (!part.isEmpty()) parts.push(part);
  } else {
    // Separate native meshes remain separate solids (compound houses must not seal a courtyard).
    for (const { mesh, local } of meshes) {
      const bounds = new Box3(), vertices = mesh.geometry.getAttribute('position');
      for (let i = 0; i < vertices.count; i++) bounds.expandByPoint(point.fromBufferAttribute(vertices, i).applyMatrix4(local));
      if (!bounds.isEmpty()) parts.push(bounds);
    }
  }
  const output: NativeSolidCollider[] = [];
  const worldBox = new Box3(), center = new Vector3(), size = new Vector3();
  for (const placement of placements) {
    if (region.movableObjects.some(object => object.id === placement.id)) continue;
    const matrix = placementMatrix(placement);
    for (let i = 0; i < parts.length; i++) {
      worldBox.copy(parts[i]!).applyMatrix4(matrix);
      worldBox.getCenter(center); worldBox.getSize(size);
      if (size.x < 0.02 || size.z < 0.02 || size.y < 0.02) continue;
      output.push({ placementId: placement.id, visibleWhen: placement.visibleWhen,
        collider: { id: `native:${placement.id}:${i}`, kind: 'box',
          from: { x: center.x, y: center.y, z: center.z },
          halfExtents: { x: size.x / 2, y: size.y / 2, z: size.z / 2 },
          blocksMovement: true, blocksCamera: true } });
    }
  }
  return output;
}
