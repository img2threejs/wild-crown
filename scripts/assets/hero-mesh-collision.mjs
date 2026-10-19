import { BufferAttribute, BufferGeometry, Group, Matrix4, MeshBasicMaterial, SkinnedMesh, Vector3 } from 'three';
import { simplifyCandidateGeometry } from '../../src/rendering/CandidateGeometrySimplifier.ts';
import { readAccessorAny } from './creature-rig-kit.mjs';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * Mesh-level body-part intersection for the playable heroes, measured on the geometry the game renders (the runtime candidate simplification
 * of the delivered skinned GLB, then a coarser collision decimation). Vertices and triangles are grouped into body regions by their dominant
 * joint; `Occupancy` voxelises a posed mesh, floods the exterior and measures how deep inside the body every vertex has been buried. The
 * bind pose's burial is the per-vertex baseline (coat layers, shoulders and hips), so only what a pose adds is reported (see
 * audit-hero-mesh-intersection.mjs).
 */
const CACHE_VERSION = 3;
export const REGIONS = ['head', 'torso', 'uarmL', 'farmL', 'handL', 'uarmR', 'farmR', 'handR', 'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR'];
const REGION_OF_BONE = (name) => {
  const n = name.replace('mixamorig:', '');
  if (/^(Head|HeadTop_End|Neck)/.test(n)) return 'head';
  if (/^(Hips|Spine|Spine1|Spine2|LeftShoulder|RightShoulder|Root)$/.test(n)) return 'torso';
  for (const [side, tag] of [['Left', 'L'], ['Right', 'R']]) {
    if (n === `${side}Arm`) return `uarm${tag}`;
    if (n === `${side}ForeArm`) return `farm${tag}`;
    if (n.startsWith(`${side}Hand`)) return `hand${tag}`;
    if (n === `${side}UpLeg`) return `thigh${tag}`;
    if (n === `${side}Leg`) return `shin${tag}`;
    if (n === `${side}Foot` || n.startsWith(`${side}Toe`)) return `foot${tag}`;
  }
  return undefined;
};
const REGION_ORDER = Object.fromEntries(REGIONS.map((r, i) => [r, i]));

/** The simplified runtime mesh of a hero GLB (`{ json, bin }`), compacted to the vertices its triangles use. */
const CACHED = ['tris', 'pos', 'joint', 'weight', 'region', 'triRegion'];
/** Keyed by the mesh's own bytes (positions, skin, indices), so adding or re-authoring clips never invalidates the decimated mesh. */
function cachePath(json, bin) {
  const hash = createHash('sha1').update(`${CACHE_VERSION}`), primitive = json.meshes[0].primitives[0];
  for (const id of [...Object.values(primitive.attributes), primitive.indices]) {
    const accessor = json.accessors[id], view = json.bufferViews[accessor.bufferView], start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    hash.update(bin.subarray(start, start + view.byteLength - (accessor.byteOffset ?? 0)));
  }
  return `${tmpdir()}/wc-runtime-mesh-${hash.digest('hex').slice(0, 14)}.bin`;
}
function loadCached(file, json, rig) {
  const buffer = readFileSync(file), headerLength = buffer.readUInt32LE(0), header = JSON.parse(buffer.subarray(4, 4 + headerLength).toString('utf8'));
  const mesh = { count: header.count };
  let offset = 4 + headerLength;
  const Types = { tris: Uint32Array, pos: Float32Array, joint: Uint16Array, weight: Float32Array, region: Uint8Array, triRegion: Uint8Array };
  for (const name of CACHED) { const bytes = header.bytes[name]; mesh[name] = new Types[name](buffer.buffer.slice(buffer.byteOffset + offset, buffer.byteOffset + offset + bytes)); offset += bytes; }
  return finishMesh(mesh, json, rig);
}
function finishMesh(mesh, json, rig) {
  const jointNodes = json.skins[0].joints;
  const jointBone = new Map(jointNodes.map((node, i) => [rig.names[node].replace('mixamorig:', ''), i]));
  return { ...mesh, jointNodes, jointBone, inverseBind: mesh.inverseBind };
}
export async function runtimeMesh(glb, rig) {
  const { json, bin } = glb, primitive = json.meshes[0].primitives[0];
  const file = cachePath(json, bin);
  if (existsSync(file)) { const cached = loadCached(file, json, rig); cached.inverseBind = readAccessorAny(json, bin, json.skins[0].inverseBindMatrices); return cached; }
  const geometry = new BufferGeometry();
  const widths = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const arrays = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
  const names = { POSITION: 'position', NORMAL: 'normal', TEXCOORD_0: 'uv', JOINTS_0: 'skinIndex', WEIGHTS_0: 'skinWeight' };
  for (const [semantic, id] of Object.entries(primitive.attributes)) {
    if (!names[semantic]) continue;
    const accessor = json.accessors[id], Type = arrays[accessor.componentType];
    geometry.setAttribute(names[semantic], new BufferAttribute(Type.from(readAccessorAny({ ...json, accessors: json.accessors.map((a) => ({ ...a, normalized: false })) }, bin, id)), widths[accessor.type]));
  }
  geometry.setIndex(new BufferAttribute(Uint32Array.from(readAccessorAny(json, bin, primitive.indices)), 1));
  const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
  const root = new Group(); root.add(mesh);
  await simplifyCandidateGeometry(root);
  // Collision triangles: a second, coarser decimation of the runtime mesh (edges ~1.5 cm) keeps the queries fast without moving any vertex.
  const { MeshoptSimplifier } = await import('meshoptimizer');
  await MeshoptSimplifier.ready;
  const runtimeIndex = geometry.index.array instanceof Uint32Array ? geometry.index.array : new Uint32Array(geometry.index.array);
  const [coarse] = MeshoptSimplifier.simplify(runtimeIndex, geometry.getAttribute('position').array, 3, Math.floor(runtimeIndex.length / 3 * 0.22) * 3, 0.02, ['LockBorder', 'Prune']);
  geometry.setIndex(new BufferAttribute(coarse, 1));
  const index = geometry.index.array, position = geometry.getAttribute('position').array, ids = geometry.getAttribute('skinIndex').array, weights = geometry.getAttribute('skinWeight').array;
  const remap = new Int32Array(position.length / 3).fill(-1);
  const used = [];
  const tris = new Uint32Array(index.length);
  for (let i = 0; i < index.length; i += 1) {
    const v = index[i];
    if (remap[v] < 0) { remap[v] = used.length; used.push(v); }
    tris[i] = remap[v];
  }
  const count = used.length, pos = new Float32Array(count * 3), joint = new Uint16Array(count * 4), weight = new Float32Array(count * 4);
  used.forEach((v, n) => {
    pos.set(position.subarray(v * 3, v * 3 + 3), n * 3);
    let total = 0;
    for (let c = 0; c < 4; c += 1) { joint[n * 4 + c] = ids[v * 4 + c]; total += weights[v * 4 + c]; }
    for (let c = 0; c < 4; c += 1) weight[n * 4 + c] = total > 0 ? weights[v * 4 + c] / total : (c === 0 ? 1 : 0);
  });
  const jointNodes = json.skins[0].joints, inverseBind = readAccessorAny(json, bin, json.skins[0].inverseBindMatrices);
  const jointRegion = jointNodes.map((node) => {
    for (let n = node; n >= 0; n = rig.parent[n]) { const r = REGION_OF_BONE(rig.names[n]); if (r) return r; }
    return 'torso';
  });
  const region = new Uint8Array(count);
  for (let v = 0; v < count; v += 1) {
    let best = 0, bw = -1;
    for (let c = 0; c < 4; c += 1) if (weight[v * 4 + c] > bw) { bw = weight[v * 4 + c]; best = joint[v * 4 + c]; }
    region[v] = REGION_ORDER[jointRegion[best]];
  }
  const triRegion = new Uint8Array(tris.length / 3);
  for (let t = 0; t < triRegion.length; t += 1) {
    const a = region[tris[t * 3]], b = region[tris[t * 3 + 1]], c = region[tris[t * 3 + 2]];
    triRegion[t] = b === c ? b : a;
  }
  const jointBone = new Map(jointNodes.map((node, i) => [rig.names[node].replace('mixamorig:', ''), i]));
  const result = { count, tris, pos, joint, weight, region, triRegion, jointNodes, inverseBind, jointBone };
  const header = { count, bytes: Object.fromEntries(CACHED.map((name) => [name, result[name].byteLength])) }, head = Buffer.from(JSON.stringify(header)), lengthBytes = Buffer.alloc(4);
  lengthBytes.writeUInt32LE(head.length, 0);
  writeFileSync(file, Buffer.concat([lengthBytes, head, ...CACHED.map((name) => Buffer.from(result[name].buffer, result[name].byteOffset, result[name].byteLength))]));
  return result;
}

const m = new Matrix4(), tmp = new Float32Array(16);
/** Posed vertex positions (rig world space) for the world matrices of the rig. */
export function skin(mesh, world, out) {
  const { jointNodes, inverseBind } = mesh;
  const joints = new Float32Array(jointNodes.length * 16);
  for (let j = 0; j < jointNodes.length; j += 1) {
    m.multiplyMatrices(world[jointNodes[j]], tmp.length ? new Matrix4().fromArray(inverseBind, j * 16) : m);
    m.toArray(joints, j * 16);
  }
  const { pos, joint, weight, count } = mesh;
  for (let v = 0; v < count; v += 1) {
    const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
    let ox = 0, oy = 0, oz = 0;
    for (let c = 0; c < 4; c += 1) {
      const w = weight[v * 4 + c];
      if (w === 0) continue;
      const o = joint[v * 4 + c] * 16;
      ox += w * (joints[o] * x + joints[o + 4] * y + joints[o + 8] * z + joints[o + 12]);
      oy += w * (joints[o + 1] * x + joints[o + 5] * y + joints[o + 9] * z + joints[o + 13]);
      oz += w * (joints[o + 2] * x + joints[o + 6] * y + joints[o + 10] * z + joints[o + 14]);
    }
    out[v * 3] = ox; out[v * 3 + 1] = oy; out[v * 3 + 2] = oz;
  }
  return out;
}

const VOXEL = 0.012; // rig units (~2 cm)
const BURY_OFFSET = 1.5 * VOXEL;

/** Per-vertex outward normals (area weighted) of the posed collision mesh. */
function vertexNormals(mesh, posed, out) {
  out.fill(0);
  const { tris } = mesh;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
    const ux = posed[b] - posed[a], uy = posed[b + 1] - posed[a + 1], uz = posed[b + 2] - posed[a + 2], wx = posed[c] - posed[a], wy = posed[c + 1] - posed[a + 1], wz = posed[c + 2] - posed[a + 2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    for (const i of [a, b, c]) { out[i] += nx; out[i + 1] += ny; out[i + 2] += nz; }
  }
  for (let v = 0; v < out.length; v += 3) {
    const l = Math.hypot(out[v], out[v + 1], out[v + 2]) || 1;
    out[v] /= l; out[v + 1] /= l; out[v + 2] /= l;
  }
  return out;
}

/**
 * Whole-character occupancy of a posed mesh: the surface is rasterised into a voxel grid, the exterior is flood-filled from outside, and a
 * chamfer distance transform measures how far every voxel is from the exterior. A vertex nudged along its outward normal that lands in a
 * voxel the exterior cannot reach is buried inside another part of the body (or inside a fold of itself); its depth is that distance.
 */
export class Occupancy {
  constructor() { this.cells = 0; }
  build(mesh, posed) {
    const { tris, triRegion } = mesh;
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let v = 0; v < mesh.count; v += 1) {
      minX = Math.min(minX, posed[v * 3]); maxX = Math.max(maxX, posed[v * 3]); minY = Math.min(minY, posed[v * 3 + 1]); maxY = Math.max(maxY, posed[v * 3 + 1]); minZ = Math.min(minZ, posed[v * 3 + 2]); maxZ = Math.max(maxZ, posed[v * 3 + 2]);
    }
    const pad = 4 * VOXEL;
    this.minX = minX - pad; this.minY = minY - pad; this.minZ = minZ - pad;
    this.nx = Math.ceil((maxX - minX + 2 * pad) / VOXEL) + 1; this.ny = Math.ceil((maxY - minY + 2 * pad) / VOXEL) + 1; this.nz = Math.ceil((maxZ - minZ + 2 * pad) / VOXEL) + 1;
    const cells = this.nx * this.ny * this.nz;
    if (cells !== this.cells) { this.cells = cells; this.surface = new Int8Array(cells); this.reached = new Uint8Array(cells); this.dist = new Float32Array(cells); this.queue = new Int32Array(cells); }
    this.surface.fill(-1); this.reached.fill(0);
    const { nx, ny, surface } = this, inv = 1 / VOXEL;
    for (let t = 0; t < tris.length / 3; t += 1) {
      const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3, region = triRegion[t];
      const e = Math.max(Math.hypot(posed[b] - posed[a], posed[b + 1] - posed[a + 1], posed[b + 2] - posed[a + 2]), Math.hypot(posed[c] - posed[a], posed[c + 1] - posed[a + 1], posed[c + 2] - posed[a + 2]), Math.hypot(posed[c] - posed[b], posed[c + 1] - posed[b + 1], posed[c + 2] - posed[b + 2]));
      const n = Math.max(1, Math.ceil(e * inv * 2));
      for (let i = 0; i <= n; i += 1) for (let j = 0; j <= n - i; j += 1) {
        const u = i / n, v = j / n, w = 1 - u - v;
        const x = Math.floor((w * posed[a] + u * posed[b] + v * posed[c] - this.minX) * inv), y = Math.floor((w * posed[a + 1] + u * posed[b + 1] + v * posed[c + 1] - this.minY) * inv), z = Math.floor((w * posed[a + 2] + u * posed[b + 2] + v * posed[c + 2] - this.minZ) * inv);
        surface[(z * ny + y) * nx + x] = region;
      }
    }
    // Exterior flood fill (6-connected) from the grid corner, never crossing a surface voxel.
    const { queue, reached, dist } = this;
    let head = 0, tail = 0;
    queue[tail++] = 0; reached[0] = 1;
    const stepX = 1, stepY = nx, stepZ = nx * ny;
    while (head < tail) {
      const i = queue[head++], x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / stepZ);
      const tryCell = (j) => { if (!reached[j] && surface[j] < 0) { reached[j] = 1; queue[tail++] = j; } };
      if (x > 0) tryCell(i - stepX); if (x < nx - 1) tryCell(i + stepX);
      if (y > 0) tryCell(i - stepY); if (y < ny - 1) tryCell(i + stepY);
      if (z > 0) tryCell(i - stepZ); if (z < this.nz - 1) tryCell(i + stepZ);
    }
    // Chamfer distance (voxels) from the exterior, over every non-exterior voxel.
    for (let i = 0; i < cells; i += 1) dist[i] = reached[i] ? 0 : 1e9;
    const offsets = [];
    for (let dz = -1; dz <= 1; dz += 1) for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) if (dx || dy || dz) offsets.push([dx, dy, dz, Math.hypot(dx, dy, dz)]);
    const forward = offsets.filter(([dx, dy, dz]) => dz < 0 || (dz === 0 && (dy < 0 || (dy === 0 && dx < 0)))), backward = offsets.filter((o) => !forward.includes(o));
    const sweep = (list, reverse) => {
      for (let zi = 0; zi < this.nz; zi += 1) { const z = reverse ? this.nz - 1 - zi : zi;
        for (let yi = 0; yi < ny; yi += 1) { const y = reverse ? ny - 1 - yi : yi;
          for (let xi = 0; xi < nx; xi += 1) { const x = reverse ? nx - 1 - xi : xi, i = (z * ny + y) * nx + x;
            if (dist[i] === 0) continue;
            let best = dist[i];
            for (const [dx, dy, dz, d] of list) {
              const X = x + dx, Y = y + dy, Z = z + dz;
              if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= this.nz) continue;
              const cand = dist[(Z * ny + Y) * nx + X] + d;
              if (cand < best) best = cand;
            }
            dist[i] = best;
          }
        }
      }
    };
    sweep(forward, false); sweep(backward, true);
    return this;
  }
  index(x, y, z) {
    const ix = Math.floor((x - this.minX) / VOXEL), iy = Math.floor((y - this.minY) / VOXEL), iz = Math.floor((z - this.minZ) / VOXEL);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= this.nx || iy >= this.ny || iz >= this.nz) return -1;
    return (iz * this.ny + iy) * this.nx + ix;
  }
  /** Burial depth (rig units; 0 = not buried) of a vertex at p with outward normal n. */
  depth(px, py, pz, nx, ny, nz) {
    const i = this.index(px + nx * BURY_OFFSET, py + ny * BURY_OFFSET, pz + nz * BURY_OFFSET);
    if (i < 0 || this.reached[i] || this.surface[i] >= 0) return 0;
    return this.dist[i] * VOXEL + BURY_OFFSET;
  }
  /** Region of the nearest surface voxel around p that is not `own` (the part the vertex is buried in), or -1. */
  hostRegion(px, py, pz, nx, ny, nz, own) {
    const cx = Math.floor((px + nx * BURY_OFFSET - this.minX) / VOXEL), cy = Math.floor((py + ny * BURY_OFFSET - this.minY) / VOXEL), cz = Math.floor((pz + nz * BURY_OFFSET - this.minZ) / VOXEL);
    for (let r = 0; r <= 5; r += 1) {
      let found = -1;
      for (let z = cz - r; z <= cz + r; z += 1) for (let y = cy - r; y <= cy + r; y += 1) for (let x = cx - r; x <= cx + r; x += 1) {
        if (x < 0 || y < 0 || z < 0 || x >= this.nx || y >= this.ny || z >= this.nz) continue;
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy), Math.abs(z - cz)) !== r) continue;
        const region = this.surface[(z * this.ny + y) * this.nx + x];
        if (region >= 0 && region !== own) { found = region; break; }
      }
      if (found >= 0) return found;
    }
    return -1;
  }
}

export { vertexNormals };
