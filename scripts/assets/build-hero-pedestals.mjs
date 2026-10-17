// Preview-only Tripo floors. Preserve native GLB bytes; derive scale, centre and standing plane from actual triangles.
// Reads each runtime directory's recorded generation.json; never calls a paid generation service.
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Box3, Matrix4, Quaternion, Vector3 } from 'three';
import { parseGlb, readAccessorAny } from './creature-rig-kit.mjs';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);
const HEROES = ['aren', 'yara', 'vesper', 'sakda'];
const WIDTH_METERS = 2.25;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));
const save = (path, value) => writeFileSync(resolve(ROOT, path), JSON.stringify(value, null, 2) + '\n');
const round = value => Number(value.toFixed(7));
const vector = value => ({ x: round(value.x), y: round(value.y), z: round(value.z) });

function measure(bytes) {
  const { json, bin } = parseGlb(bytes);
  const bounds = new Box3();
  const triangles = [];
  const visit = (index, parent) => {
    const node = json.nodes[index];
    const local = node.matrix ? new Matrix4().fromArray(node.matrix) : new Matrix4().compose(
      new Vector3(...(node.translation ?? [0, 0, 0])),
      new Quaternion(...(node.rotation ?? [0, 0, 0, 1])),
      new Vector3(...(node.scale ?? [1, 1, 1])),
    );
    const world = parent.clone().multiply(local);
    if (node.mesh !== undefined) for (const primitive of json.meshes[node.mesh].primitives) {
      if ((primitive.mode ?? 4) !== 4) throw new Error('Pedestal must contain triangle meshes.');
      const positions = readAccessorAny(json, bin, primitive.attributes.POSITION);
      const vertices = Array.from({ length: positions.length / 3 }, (_, i) => new Vector3(...positions.subarray(i * 3, i * 3 + 3)).applyMatrix4(world));
      for (const point of vertices) bounds.expandByPoint(point);
      const indices = primitive.indices === undefined ? vertices.map((_, i) => i) : readAccessorAny(json, bin, primitive.indices);
      for (let i = 0; i < indices.length; i += 3) triangles.push([vertices[indices[i]], vertices[indices[i + 1]], vertices[indices[i + 2]]]);
    }
    for (const child of node.children ?? []) visit(child, world);
  };
  for (const index of json.scenes[json.scene ?? 0].nodes) visit(index, new Matrix4());
  if (bounds.isEmpty() || !triangles.length) throw new Error('Native pedestal contains no measurable triangles.');
  const centre = bounds.getCenter(new Vector3());
  const size = bounds.getSize(new Vector3());
  const scale = WIDTH_METERS / Math.max(size.x, size.z);
  const samples = [];
  for (const x of [-0.22, -0.11, 0, 0.11, 0.22]) for (const z of [-0.22, -0.11, 0, 0.11, 0.22]) {
    const px = centre.x + x / scale, pz = centre.z + z / scale;
    let height = -Infinity;
    for (const [a, b, c] of triangles) {
      const d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
      if (Math.abs(d) < 1e-12) continue;
      const u = ((b.z - c.z) * (px - c.x) + (c.x - b.x) * (pz - c.z)) / d;
      const v = ((c.z - a.z) * (px - c.x) + (a.x - c.x) * (pz - c.z)) / d;
      const w = 1 - u - v;
      if (Math.min(u, v, w) >= -1e-8) height = Math.max(height, u * a.y + v * b.y + w * c.y);
    }
    if (!Number.isFinite(height)) throw new Error(`Missing standing surface at ${x}, ${z}.`);
    samples.push(height);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const standingY = sorted[Math.floor(sorted.length / 2)];
  const spread = (sorted.at(-1) - sorted[0]) * scale;
  if (spread > 0.04) throw new Error(`Central standing patch varies by ${spread.toFixed(4)} m; inspect before integrating.`);
  return {
    triangleCount: triangles.length,
    boundsMin: bounds.min.toArray(), boundsMax: bounds.max.toArray(),
    coordinateTransform: { forward: { x: 0, y: 0, z: 1 }, scale: round(scale), originOffset: vector(new Vector3(-centre.x, -standingY, -centre.z).multiplyScalar(scale)) },
    standingPatch: { widthMeters: 0.44, sampleCount: samples.length, sourceHeights: samples, sourceMedianY: standingY, runtimeHeightSpreadMeters: spread },
    runtimeWidthMeters: WIDTH_METERS,
    runtimeBoundsMin: bounds.min.clone().sub(new Vector3(centre.x, standingY, centre.z)).multiplyScalar(scale).toArray(),
    runtimeBoundsMax: bounds.max.clone().sub(new Vector3(centre.x, standingY, centre.z)).multiplyScalar(scale).toArray(),
    materialCount: json.materials?.length ?? 0, embeddedImageCount: json.images?.length ?? 0,
  };
}

const manifest = HEROES.map(hero => {
  const id = `hero-pedestal-${hero}`, dir = `asset-source/generated/${id}-runtime-01`;
  const generation = read(`${dir}/generation.json`);
  const reference = read(`${dir}/reference-result.json`);
  const bytes = readFileSync(resolve(ROOT, generation.modelFile));
  const output = measure(bytes);
  const glb = `${dir}/${id}.glb`;
  copyFileSync(resolve(ROOT, generation.modelFile), resolve(ROOT, glb));
  const outputHash = hash(bytes);
  save(`${dir}/provenance.json`, {
    schemaVersion: 1, generator: 'Tripo', sourceType: 'native-glb',
    tasks: { concept: generation.conceptTaskId, reference: reference.taskId, model: generation.taskId },
    model: generation.model, creditsConsumed: { concept: 5, reference: reference.creditsConsumed, model: generation.creditsConsumed },
    source: generation.modelFile, sourceHash: outputHash, sourceInputHash: reference.sha256,
    output: { file: glb, sha256: outputHash, ...output },
    evidenceStatus: 'blocked',
    notes: 'Preview-only candidate. Native geometry and embedded PBR textures preserved; manifest transform centres its measured standing patch at y=0. Not production-release evidence.',
  });
  console.log(`${hero}: ${output.triangleCount} triangles, standing spread ${(output.standingPatch.runtimeHeightSpreadMeters * 1000).toFixed(2)} mm, ${(bytes.length / 1048576).toFixed(2)} MiB`);
  return {
    id, sourceType: 'native-glb', kind: 'prop', tripoSourceTask: generation.taskId,
    sourceHash: outputHash, sourceInputHash: reference.sha256, outputHash, runtimeUrl: `/${glb}`,
    lodIds: [], coordinateTransform: output.coordinateTransform,
    requiredActionIds: [], actionToClipMapping: {}, sockets: [],
    provenance: `${dir}/provenance.json`, evidenceStatus: 'blocked',
  };
});
save('asset-source/playtests/hero-pedestals.json', manifest);
