import { describe, expect, it } from 'bun:test';
import { Bone, BufferAttribute, BufferGeometry, Group, InterleavedBuffer, InterleavedBufferAttribute, Mesh, Skeleton, SkinnedMesh, Vector3 } from 'three';
import { simplifyCandidateGeometry } from '../../src/rendering/CandidateGeometrySimplifier.js';

function grid(segments = 180): BufferGeometry {
  const side = segments + 1;
  const positions = new Float32Array(side * side * 3);
  const normals = new Float32Array(side * side * 3);
  const uvs = new Float32Array(side * side * 2);
  const colors = new Uint8Array(side * side * 3);
  const sourceVertices = new Uint32Array(side * side);
  const indices = new Uint32Array(segments * segments * 6);
  for (let z = 0; z <= segments; z++) for (let x = 0; x <= segments; x++) {
    const vertex = z * side + x;
    positions[vertex * 3] = x / segments * 2 - 1;
    positions[vertex * 3 + 2] = z / segments * 2 - 1;
    normals[vertex * 3 + 1] = 1;
    uvs[vertex * 2] = x / segments;
    uvs[vertex * 2 + 1] = z / segments;
    colors.set([vertex % 256, (vertex * 7) % 256, (vertex * 13) % 256], vertex * 3);
    sourceVertices[vertex] = vertex;
  }
  let cursor = 0;
  for (let z = 0; z < segments; z++) for (let x = 0; x < segments; x++) {
    const a = z * side + x;
    indices.set([a, a + 1, a + side + 1, a, a + side + 1, a + side], cursor);
    cursor += 6;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2));
  geometry.setAttribute('color', new BufferAttribute(colors, 3, true));
  geometry.setAttribute('sourceVertex', new BufferAttribute(sourceVertices, 1));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeBoundingBox();
  return geometry;
}

async function simplify(geometry: BufferGeometry): Promise<void> {
  const root = new Group();
  root.add(new Mesh(geometry));
  await simplifyCandidateGeometry(root);
}

describe('blocked native candidate geometry', () => {
  it('packs surviving vertex rows without corrupting UVs, normals or normalized integer colors', async () => {
    const geometry = grid();
    const originals = { ...geometry.attributes };
    const bounds = geometry.boundingBox!.clone();
    const originalCount = geometry.index!.count;
    await simplify(geometry);
    const position = geometry.getAttribute('position');
    const sourceVertex = geometry.getAttribute('sourceVertex');
    expect(geometry.index!.count).toBeLessThan(originalCount / 2);
    expect(new Set(geometry.index!.array).size).toBe(position.count);
    for (const [name, original] of Object.entries(originals)) {
      const packed = geometry.getAttribute(name);
      expect(packed.count).toBe(position.count);
      expect(packed.array.constructor).toBe(original.array.constructor);
      expect(packed.normalized).toBe(original.normalized);
      for (let vertex = 0; vertex < packed.count; vertex++) {
        const source = sourceVertex.getX(vertex);
        for (let component = 0; component < packed.itemSize; component++) {
          expect(packed.array[vertex * packed.itemSize + component]).toBe(original.array[source * packed.itemSize + component]);
        }
      }
    }
    expect(geometry.boundingBox!.equals(bounds)).toBe(true);
    const sphere = geometry.boundingSphere!;
    const point = new Vector3();
    for (let vertex = 0; vertex < position.count; vertex++) {
      point.fromBufferAttribute(position, vertex);
      expect(point.distanceTo(sphere.center)).toBeLessThanOrEqual(sphere.radius + 1e-9);
    }
  });

  it('keeps triangles on the correct side of a shared material boundary', async () => {
    const geometry = grid();
    const half = geometry.index!.count / 2;
    geometry.addGroup(0, half, 7);
    geometry.addGroup(half, half, 3);
    await simplify(geometry);
    const position = geometry.getAttribute('position');
    const index = geometry.index!;
    expect(geometry.groups.map(group => group.materialIndex)).toEqual([7, 3]);
    expect(geometry.groups[0]!.count).toBe(geometry.groups[1]!.start);
    expect(geometry.groups[1]!.start + geometry.groups[1]!.count).toBe(index.count);
    for (const group of geometry.groups) for (let corner = group.start; corner < group.start + group.count; corner++) {
      const z = position.getZ(index.getX(corner));
      if (group.materialIndex === 7) expect(z).toBeLessThanOrEqual(0);
      else expect(z).toBeGreaterThanOrEqual(0);
    }
  });

  it('compacts interleaved rows once without mutating buffers shared with another geometry', async () => {
    const geometry = grid();
    const count = geometry.getAttribute('position').count;
    const data = new Float32Array(count * 8);
    for (let vertex = 0; vertex < count; vertex++) {
      data.set(geometry.getAttribute('position').array.slice(vertex * 3, vertex * 3 + 3), vertex * 8);
      data.set(geometry.getAttribute('normal').array.slice(vertex * 3, vertex * 3 + 3), vertex * 8 + 3);
      data.set(geometry.getAttribute('uv').array.slice(vertex * 2, vertex * 2 + 2), vertex * 8 + 6);
    }
    const buffer = new InterleavedBuffer(data, 8);
    geometry.setAttribute('position', new InterleavedBufferAttribute(buffer, 3, 0));
    geometry.setAttribute('normal', new InterleavedBufferAttribute(buffer, 3, 3));
    geometry.setAttribute('uv', new InterleavedBufferAttribute(buffer, 2, 6));
    await simplify(geometry);
    const position = geometry.getAttribute('position') as InterleavedBufferAttribute;
    const normal = geometry.getAttribute('normal') as InterleavedBufferAttribute;
    const uv = geometry.getAttribute('uv') as InterleavedBufferAttribute;
    expect(position.data).toBe(normal.data);
    expect(position.data).toBe(uv.data);
    expect(position.data).not.toBe(buffer);
    expect(buffer.count).toBe(count);
    expect(buffer.array).toBe(data);
    expect(position.count).toBe(new Set(geometry.index!.array).size);
    for (let vertex = 0; vertex < position.count; vertex++) {
      const original = geometry.getAttribute('sourceVertex').getX(vertex);
      expect(position.data.array.slice(vertex * 8, vertex * 8 + 8)).toEqual(data.slice(original * 8, original * 8 + 8));
    }
  });

  it.each(['skin', 'morph'] as const)('reduces %s triangles while preserving original deformation rows', async kind => {
    const geometry = grid();
    const position = geometry.getAttribute('position');
    const originalIndices = geometry.index!.count;
    let mesh: Mesh;
    if (kind === 'skin') {
      geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(position.count * 4), 4));
      const weights = new Float32Array(position.count * 4);
      for (let vertex = 0; vertex < position.count; vertex++) weights[vertex * 4] = 1;
      geometry.setAttribute('skinWeight', new BufferAttribute(weights, 4));
      const skinned = new SkinnedMesh(geometry);
      const bone = new Bone();
      skinned.add(bone);
      skinned.bind(new Skeleton([bone]));
      bone.position.y = 2;
      mesh = skinned;
    } else {
      const deltas = new Float32Array(position.count * 3);
      for (let vertex = 0; vertex < position.count; vertex++) deltas[vertex * 3 + 1] = 2;
      geometry.morphAttributes.position = [new BufferAttribute(deltas, 3)];
      geometry.morphTargetsRelative = true;
      mesh = new Mesh(geometry);
      mesh.morphTargetInfluences![0] = 1;
    }
    const attributes = { ...geometry.attributes };
    const morph = geometry.morphAttributes.position;
    const root = new Group();
    root.add(mesh);
    await simplifyCandidateGeometry(root);
    expect(geometry.index!.count).toBeLessThan(originalIndices / 2);
    for (const [name, attribute] of Object.entries(attributes)) expect(geometry.getAttribute(name)).toBe(attribute);
    expect(geometry.morphAttributes.position).toBe(morph);
    mesh.updateMatrixWorld(true);
    const vertex = geometry.index!.getX(0);
    const deformed = mesh.getVertexPosition(vertex, new Vector3());
    expect(deformed.y).toBeCloseTo(2, 6);
    expect(deformed.x).toBe(position.getX(vertex));
    const reduced = geometry.index;
    await simplifyCandidateGeometry(root);
    expect(geometry.index).toBe(reduced);
  });
});
