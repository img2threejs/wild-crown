import { BufferAttribute, BufferGeometry, InterleavedBuffer, InterleavedBufferAttribute, type Mesh, type Object3D, type SkinnedMesh } from 'three';
import type { MeshoptSimplifier as MeshoptSimplifierAPI } from 'meshoptimizer/simplifier';

type Simplifier = typeof MeshoptSimplifierAPI;
type Attribute = BufferAttribute | InterleavedBufferAttribute;
type AttributeArray = BufferAttribute['array'];
const MIN_TRIANGLES = 50_000;
const STATIC_TARGET_TRIANGLES = 8_000;
const DEFORMING_RATIO = 0.05;
const MAX_ERROR = 0.01;
const processed = new WeakSet<BufferGeometry>();
let simplifierPromise: Promise<Simplifier> | undefined;

export interface SimplificationReport {
  meshes: number;
  trianglesBefore: number;
  trianglesAfter: number;
  verticesBefore: number;
  verticesAfter: number;
  attributeBytesBefore: number;
  attributeBytesAfter: number;
}

/** Development-only derivatives: source bytes, selected vertex values and rig bindings never change. */
export async function simplifyCandidateGeometry(root: Object3D): Promise<SimplificationReport> {
  const geometries = new Map<BufferGeometry, boolean>();
  root.traverse(node => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry;
    const deforming = (mesh as SkinnedMesh).isSkinnedMesh === true
      || geometry.hasAttribute('skinWeight')
      || Object.values(geometry.morphAttributes).some(attributes => attributes && attributes.length > 0);
    geometries.set(geometry, deforming || geometries.get(geometry) === true);
  });
  const report: SimplificationReport = { meshes: 0, trianglesBefore: 0, trianglesAfter: 0, verticesBefore: 0, verticesAfter: 0, attributeBytesBefore: 0, attributeBytesAfter: 0 };
  for (const [geometry, deforming] of geometries) {
    const index = geometry.index;
    const position = geometry.getAttribute('position');
    if (processed.has(geometry) || !index || !position || position.itemSize !== 3 || index.count / 3 <= MIN_TRIANGLES) continue;
    if (geometry.drawRange.start !== 0 || geometry.drawRange.count < index.count) continue;
    simplifierPromise ??= import('meshoptimizer').then(async ({ MeshoptSimplifier }) => {
      await MeshoptSimplifier.ready;
      if (!MeshoptSimplifier.supported) throw new Error('WebAssembly mesh simplification is unavailable.');
      return MeshoptSimplifier;
    });
    const simplifier = await simplifierPromise;
    const indices = index.array instanceof Uint32Array ? index.array : new Uint32Array(index.array);
    const positions = packedPositions(position);
    const groups = geometry.groups.length ? geometry.groups : [{ start: 0, count: index.count, materialIndex: 0 }];
    const ratio = deforming ? DEFORMING_RATIO : Math.min(DEFORMING_RATIO, STATIC_TARGET_TRIANGLES * 3 / index.count);
    const reductions: Uint32Array[] = [];
    let count = 0;
    for (const group of groups) {
      const source = indices.subarray(group.start, group.start + group.count);
      const target = Math.max(3, Math.floor(source.length * ratio / 3) * 3);
      const [reduced, error] = source.length > 3
        ? simplifier.simplify(source, positions, 3, target, MAX_ERROR, ['LockBorder', 'Prune'])
        : [source, 0] as const;
      if (!Number.isFinite(error) || reduced.length % 3 !== 0) throw new Error('Candidate simplification produced invalid geometry.');
      reductions.push(reduced);
      count += reduced.length;
    }
    // Never partition a globally simplified buffer by proportions: triangles retain their original material.
    const reduced = new Uint32Array(count);
    let offset = 0;
    const nextGroups = groups.map((group, index) => {
      const part = reductions[index]!;
      reduced.set(part, offset);
      const next = { start: offset, count: part.length, materialIndex: group.materialIndex ?? 0 };
      offset += part.length;
      return next;
    });
    report.trianglesBefore += index.count / 3;
    report.verticesBefore += position.count;
    report.attributeBytesBefore += geometryBytes(geometry);
    if (!deforming) {
      // compactMesh rewrites indices in place and returns source→destination, plus the exact unique count.
      const [remap, vertexCount] = simplifier.compactMesh(reduced);
      compactAttributes(geometry, remap, vertexCount);
    }
    geometry.setIndex(new BufferAttribute(reduced, 1));
    if (geometry.groups.length) {
      geometry.clearGroups();
      for (const group of nextGroups) geometry.addGroup(group.start, group.count, group.materialIndex);
    }
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    processed.add(geometry);
    report.meshes++;
    report.trianglesAfter += count / 3;
    report.verticesAfter += geometry.getAttribute('position').count;
    report.attributeBytesAfter += geometryBytes(geometry);
  }
  return report;
}

function packedPositions(position: Attribute): Float32Array {
  if (position instanceof BufferAttribute && position.array instanceof Float32Array && !position.normalized) return position.array;
  const packed = new Float32Array(position.count * 3);
  for (let index = 0; index < position.count; index++) {
    packed[index * 3] = position.getX(index);
    packed[index * 3 + 1] = position.getY(index);
    packed[index * 3 + 2] = position.getZ(index);
  }
  return packed;
}

function compactArray(source: AttributeArray, stride: number, remap: Uint32Array, vertexCount: number): AttributeArray {
  const ArrayType = source.constructor as new (length: number) => AttributeArray;
  const packed = new ArrayType(vertexCount * stride);
  for (let original = 0; original < remap.length; original++) {
    const destination = remap[original]!;
    if (destination === 0xffffffff) continue;
    for (let component = 0; component < stride; component++) packed[destination * stride + component] = source[original * stride + component]!;
  }
  return packed;
}

function compactAttributes(geometry: BufferGeometry, remap: Uint32Array, vertexCount: number): void {
  const interleaved = new Map<InterleavedBuffer, InterleavedBuffer>();
  for (const [name, attribute] of Object.entries(geometry.attributes)) {
    if ('isInstancedBufferAttribute' in attribute && attribute.isInstancedBufferAttribute) continue;
    if (attribute instanceof InterleavedBufferAttribute) {
      let packed = interleaved.get(attribute.data);
      if (!packed) {
        packed = new InterleavedBuffer(compactArray(attribute.data.array, attribute.data.stride, remap, vertexCount), attribute.data.stride);
        packed.setUsage(attribute.data.usage);
        interleaved.set(attribute.data, packed);
      }
      const next = new InterleavedBufferAttribute(packed, attribute.itemSize, attribute.offset, attribute.normalized);
      next.name = attribute.name;
      geometry.setAttribute(name, next);
    } else {
      const next = new BufferAttribute(compactArray(attribute.array, attribute.itemSize, remap, vertexCount), attribute.itemSize, attribute.normalized);
      next.name = attribute.name;
      next.gpuType = attribute.gpuType;
      next.setUsage(attribute.usage);
      geometry.setAttribute(name, next);
    }
  }
}

function geometryBytes(geometry: BufferGeometry): number {
  const buffers = new Set<BufferAttribute | InterleavedBuffer>();
  let bytes = geometry.index?.array.byteLength ?? 0;
  for (const attribute of Object.values(geometry.attributes)) {
    const buffer = attribute instanceof InterleavedBufferAttribute ? attribute.data : attribute;
    if (!buffers.has(buffer)) { buffers.add(buffer); bytes += buffer.array.byteLength; }
  }
  return bytes;
}
