import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BufferGeometry, Float32BufferAttribute, Group, InstancedMesh, Matrix4, MeshBasicMaterial, Quaternion, Vector3 } from 'three';
import type { NativeStaticBatch } from '../../src/rendering/NativeAssetLoader.js';
import type { WorldAssetPlacement } from '../../src/game/contracts.js';

/**
 * A static batch of a REAL native prop GLB, built the way NativeAssetLoader builds one: the manifest's coordinateTransform
 * (scale, heading, origin offset) is the model matrix and the placement matrix composes on top. The GLB is parsed directly
 * (nodes, meshes, positions, indices) so the suite needs no image decoding or browser APIs.
 */
const ROOT = resolve(import.meta.dir, '../..');

interface GltfJson {
  scene?: number;
  scenes: { nodes: number[] }[];
  nodes: { mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }[];
  meshes: { primitives: { attributes: { POSITION: number }; indices?: number }[] }[];
  accessors: { bufferView: number; byteOffset?: number; count: number; componentType: number; type: string }[];
  bufferViews: { byteOffset?: number; byteStride?: number }[];
}
interface ManifestEntry { id?: string; runtimeUrl?: string; coordinateTransform?: { forward: { x: number; z: number }; scale: number; originOffset?: { y: number } } }

function accessor(json: GltfJson, bin: Buffer, index: number): number[] {
  const spec = json.accessors[index]!, view = json.bufferViews[spec.bufferView]!;
  const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[spec.type]!;
  const bytes = spec.componentType === 5126 || spec.componentType === 5125 ? 4 : spec.componentType === 5123 ? 2 : 1;
  const stride = view.byteStride ?? components * bytes;
  const base = (view.byteOffset ?? 0) + (spec.byteOffset ?? 0);
  const out: number[] = [];
  for (let i = 0; i < spec.count; i++) for (let c = 0; c < components; c++) {
    const at = base + i * stride + c * bytes;
    out.push(spec.componentType === 5126 ? bin.readFloatLE(at) : spec.componentType === 5125 ? bin.readUInt32LE(at) : spec.componentType === 5123 ? bin.readUInt16LE(at) : bin.readUInt8(at));
  }
  return out;
}

/** The manifest entry (runtime GLB path, coordinate transform) of a prop in a playtest manifest file. */
export function playtestPropEntry(playtest: string, assetId: string): Required<Pick<ManifestEntry, 'runtimeUrl' | 'coordinateTransform'>> {
  const entries = JSON.parse(readFileSync(resolve(ROOT, 'asset-source/playtests', playtest + '.json'), 'utf8')) as unknown;
  const found: ManifestEntry[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (value && typeof value === 'object') {
      const record = value as ManifestEntry & Record<string, unknown>;
      if (record.id === assetId && record.runtimeUrl) found.push(record);
      Object.values(record).forEach(visit);
    }
  };
  visit(entries);
  const entry = found[0];
  if (!entry?.runtimeUrl || !entry.coordinateTransform) throw new Error(`${playtest}: no runtime entry for ${assetId}`);
  return { runtimeUrl: entry.runtimeUrl, coordinateTransform: entry.coordinateTransform };
}

export function glbStaticBatch(playtest: string, placement: WorldAssetPlacement): NativeStaticBatch {
  const { runtimeUrl, coordinateTransform } = playtestPropEntry(playtest, placement.assetId);
  const file = readFileSync(resolve(ROOT, runtimeUrl.replace(/^\//, '')));
  const jsonLength = file.readUInt32LE(12);
  const json = JSON.parse(file.toString('utf8', 20, 20 + jsonLength)) as GltfJson;
  const bin = file.subarray(20 + jsonLength + 8);
  const positions: number[] = [];
  const visit = (nodeIndex: number, parent: Matrix4): void => {
    const node = json.nodes[nodeIndex]!;
    const local = node.matrix ? new Matrix4().fromArray(node.matrix)
      : new Matrix4().compose(new Vector3(...(node.translation ?? [0, 0, 0])), new Quaternion(...(node.rotation ?? [0, 0, 0, 1])), new Vector3(...(node.scale ?? [1, 1, 1])));
    const world = new Matrix4().multiplyMatrices(parent, local);
    if (node.mesh !== undefined) {
      for (const primitive of json.meshes[node.mesh]!.primitives) {
        const vertices = accessor(json, bin, primitive.attributes.POSITION);
        const indices = primitive.indices === undefined ? Array.from({ length: vertices.length / 3 }, (_, i) => i) : accessor(json, bin, primitive.indices);
        const point = new Vector3();
        for (const index of indices) positions.push(...point.set(vertices[index * 3]!, vertices[index * 3 + 1]!, vertices[index * 3 + 2]!).applyMatrix4(world).toArray());
      }
    }
    for (const child of node.children ?? []) visit(child, world);
  };
  for (const node of json.scenes[json.scene ?? 0]!.nodes) visit(node, new Matrix4());
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  const { scale, forward, originOffset } = coordinateTransform;
  const model = new Matrix4().compose(new Vector3(0, originOffset?.y ?? 0, 0), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.atan2(forward.x, forward.z)), new Vector3(scale, scale, scale));
  const placed = new Matrix4().compose(new Vector3(placement.position.x, placement.position.y, placement.position.z),
    new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), placement.rotationY), new Vector3(placement.scale.x, placement.scale.y, placement.scale.z));
  const mesh = new InstancedMesh(geometry, new MeshBasicMaterial(), 1);
  mesh.setMatrixAt(0, placed.multiply(model));
  const root = new Group();
  root.add(mesh);
  return { assetId: placement.assetId, root, instanceCount: 1, drawnInstanceCount: 1, lodIds: [], setPlacementVisible() {}, updateOcclusion() {}, dispose() { geometry.dispose(); } };
}
