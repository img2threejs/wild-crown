import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectAssets, verifyPreview, positionResourceBudget, nativePositions } from '../../scripts/release/validate.mjs';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { measureStaticGeometry, measureG1, measureG3, measureG10 } from '../../src/asset-lab/measurements.js';
import { buildEvidence } from '../../src/asset-lab/evidence.js';
import { exportRuntimeManifest } from '../../scripts/assets/export-runtime-manifest.mjs';
import * as THREE from 'three';

function assertOnlyUnmeasuredParity(errors) {
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.match(errors[0], /G11 runtime geometry\/UV\/material\/frozen-live-scene parity/);
}

const digest = (data) => createHash('sha256').update(data).digest('hex');
const staticViewIds = ['front', 'back', 'right', 'left', 'front-right', 'front-left', 'back-right', 'back-left'];
function minimalTriangleGlb({ coordinates = [[0, 0, 0], [1, 0, 0], [0, 1, 0]], min = [0, 0, 0], max = [1, 1, 0], twoPrimitives = false, sharedView = true, secondMin = min, secondMax = max } = {}) {
  const positions = Buffer.alloc(coordinates.length * 12);
  coordinates.flat().forEach((value, index) => positions.writeFloatLE(value, index * 4));
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0', extras: { wildCrownStaticVisibilityPolicy: { version: 1, policyId: 'prop-fixture-policy', assetId: 'prop-fixture', requiredMeshNodes: [{ nodeIndex: 0, minimumVisiblePixels: 1, minimumVisibleViews: 1 }], excludedMeshNodes: [] } } },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ name: 'triangle', primitives: Array.from({ length: twoPrimitives ? 2 : 1 }, (_, index) => ({ attributes: { POSITION: index }, material: 0 })) }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.3, 0.4, 0.2, 1] } }], buffers: [{ byteLength: positions.length }],
    bufferViews: Array.from({ length: twoPrimitives && !sharedView ? 2 : 1 }, () => ({ buffer: 0, byteOffset: 0, byteLength: positions.length, target: 34962 })),
    accessors: Array.from({ length: twoPrimitives ? 2 : 1 }, (_, index) => ({ bufferView: index === 1 && !sharedView ? 1 : 0, componentType: 5126, count: coordinates.length, type: 'VEC3', min: index === 1 ? secondMin : min, max: index === 1 ? secondMax : max })),
  }));
  const jsonChunk = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const binChunk = Buffer.concat([positions, Buffer.alloc((4 - positions.length % 4) % 4)]);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8);
  const jsonHeader = Buffer.alloc(8); jsonHeader.writeUInt32LE(jsonChunk.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(binChunk.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
}
function overlappingTriangleGlb({ interleaved = false, separateViews = false, sparse = false } = {}) {
  const seed = minimalTriangleGlb(), jsonLength = seed.readUInt32LE(12);
  const json = JSON.parse(seed.toString('utf8', 20, 20 + jsonLength));
  const vertices = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]];
  const stride = interleaved ? 16 : 12, positionBytes = stride * vertices.length;
  const binary = Buffer.alloc(positionBytes + (sparse ? 16 : 0));
  vertices.forEach((vertex, index) => vertex.forEach((value, axis) => binary.writeFloatLE(value, index * stride + axis * 4)));
  json.buffers = [{ byteLength: binary.length }];
  json.bufferViews = Array.from({ length: separateViews ? 2 : 1 }, () => ({ buffer: 0, byteLength: positionBytes, byteStride: interleaved ? stride : undefined }));
  json.accessors = [
    { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
    { bufferView: separateViews ? 1 : 0, byteOffset: stride, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
  ];
  if (sparse) {
    const indexView = json.bufferViews.length;
    binary[positionBytes] = 2;
    vertices[3].forEach((value, axis) => binary.writeFloatLE(value, positionBytes + 4 + axis * 4));
    json.bufferViews.push({ buffer: 0, byteOffset: positionBytes, byteLength: 1 }, { buffer: 0, byteOffset: positionBytes + 4, byteLength: 12 });
    json.accessors[1].sparse = { count: 1, indices: { bufferView: indexView, componentType: 5121 }, values: { bufferView: indexView + 1 } };
  }
  json.meshes[0].primitives.push({ attributes: { POSITION: 1 }, material: 0 });
  const raw = Buffer.from(JSON.stringify(json)), chunk = Buffer.concat([raw, Buffer.alloc((4 - raw.length % 4) % 4, 32)]);
  const header = Buffer.from(seed.subarray(0, 20)); header.writeUInt32LE(28 + chunk.length + binary.length, 8); header.writeUInt32LE(chunk.length, 12);
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(binary.length); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, chunk, binHeader, binary]);
}

function withExternalImageUri(glb) {
  const oldJsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.toString('utf8', 20, 20 + oldJsonLength).replace(/[\u0000\u0020]+$/g, ''));
  json.images = [{ uri: 'https://provider.invalid/unchecked-image.png' }];
  const jsonBytes = Buffer.from(JSON.stringify(json));
  const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc((4 - jsonBytes.length % 4) % 4, 0x20)]);
  const binaryChunks = glb.subarray(20 + oldJsonLength);
  const totalLength = 12 + 8 + jsonChunk.length + binaryChunks.length;
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(totalLength, 8);
  const jsonHeader = Buffer.alloc(8); jsonHeader.writeUInt32LE(jsonChunk.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  return Buffer.concat([header, jsonHeader, jsonChunk, binaryChunks]);
}
async function fixture(glb = minimalTriangleGlb()) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wild-crown-release-test-'));
  const dist = path.join(root, 'dist');
  const evidenceRoot = path.join(root, 'evidence');
  await mkdir(path.join(dist, 'assets'), { recursive: true });
  await mkdir(path.join(evidenceRoot, 'assets'), { recursive: true });
  await mkdir(path.join(root, 'docs/implementation'), { recursive: true });
  for (const name of ['reference-profile.json', 'BENCHMARK-ROUTES.md']) await writeFile(path.join(root, 'docs/implementation', name), await readFile(path.resolve(process.cwd(), 'docs/implementation', name)));
  await mkdir(path.join(evidenceRoot, 'release'), { recursive: true });
  await writeFile(path.join(dist, 'index.html'), '<!doctype html><script type="module" src="/entry.js"></script>');
  await writeFile(path.join(dist, 'entry.js'), 'console.log("release validator fixture");');
  await writeFile(path.join(dist, 'release-compatibility.json'), JSON.stringify({ buildSchema: 1, saveSchema: 1, authority: 'isolated test fixture only' }));
  const assetPath = 'assets/prop-fixture/' + digest(glb) + '.glb';
  await mkdir(path.dirname(path.join(dist, assetPath)), { recursive: true });
  await writeFile(path.join(dist, assetPath), glb);
  const sourceHash = digest(glb);
  const sourceInputHash = digest(Buffer.from('approved source reference'));
  const visualPath = 'evidence/assets/prop-fixture-front.png';
  const visualBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/bS8AAAAASUVORK5CYII=', 'base64');
  await writeFile(path.join(root, visualPath), visualBytes);
  const evidenceFile = 'evidence/assets/prop-fixture.json';
  const environmentEvidenceFile = 'evidence/environment-fixture.json';
  await writeFile(path.join(root, environmentEvidenceFile), JSON.stringify({ schemaVersion: 1, recipeId: 'environment-fixture', status: 'verified', componentAssetIds: ['prop-fixture'], componentOutputHashes: { 'prop-fixture': sourceHash }, sceneEvidence: [{ path: visualPath, sha256: digest(visualBytes) }] }));
  const staticPolicy = nativePolicy(glb);
  const gates = { G1: 'not-applicable', G3: 'not-applicable', G6: 'passed', G10: 'passed', G11: 'passed', G12: 'not-applicable' };
  const native = await new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength), '');
  const staticMeasurement = measureStaticGeometry(native, native.scene, 'prop-fixture', sourceHash);
  const negativeControls = [
    ...staticPolicy.requiredMeshNodes.map(staticPolicyRow => {
      const row = staticMeasurement.staticGeometry.meshNodes.find(row => row.nodeIndex === staticPolicyRow.nodeIndex);
      const identity = { nodeIndex: row.nodeIndex, nodeName: row.meshNodeName, meshIndex: row.meshIndex, ...staticPolicyRow };
      return { id: 'G6-hidden-static-mesh:' + row.nodeIndex, gate: 'G6', assetId: 'prop-fixture', sourceHash, expectedFailure: true, detectedFailure: true, measurementBefore: { ...identity, visiblePixelsByView: [1, 0, 0, 0, 0, 0, 0, 0], visibleViews: 1 }, measurementAfter: { ...identity, visiblePixelsByView: Array(8).fill(0), visibleViews: 0 } };
    }),
    ...staticMeasurement.negativeControls,
  ];
  const propEvidence = {
    schemaVersion: 1, assetId: 'prop-fixture', sourceInputHash, sourceHash, outputHash: sourceHash, gates,
    notApplicableReasons: { G1: 'static prop has no authored clip/skin', G3: 'static prop has no authored clip/skin', G12: 'static prop has no skin' },
    expectedPluginCheckIds: ['G6-visibility', 'G10-geometry', 'G11-freeze'],
    pluginChecks: [{ id: 'G6-visibility', gate: 'G6', status: 'passed' }, { id: 'G10-geometry', gate: 'G10', status: 'passed' }, { id: 'G11-freeze', gate: 'G11', status: 'passed' }],
    negativeControls,
    measurements: {
      G6: { status: 'measurement-complete-review-required', policyId: staticPolicy.policyId, requiredMeshNodes: staticPolicy.requiredMeshNodes, excludedMeshNodes: staticPolicy.excludedMeshNodes, excludedNodeMeasurements: staticPolicy.excludedMeshNodes.map(row => ({ ...row })), meshInventory: staticMeasurement.staticGeometry.meshNodes.map(row => ({ nodeIndex: row.nodeIndex, nodeName: row.meshNodeName, meshIndex: row.meshIndex, visible: true, alphaVisible: true, primitiveCount: row.primitiveCount, vertexCount: row.vertexCount, indexCount: row.indexCount, materialCount: row.materialCount })), renderedCoverage: staticViewIds.map((viewId, index) => ({ viewId, pixelCount: index === 0 ? 1 : 0 })) },
      G10: staticMeasurement,
      // Deliberately insufficient legacy claim: proves byte-copy cannot accept release.
      G11: { status: 'measurement-complete-review-required', derivativeHash: sourceHash, frozenHash: sourceHash, parity: true, negativeControl: { id: 'G11-byte-flip', expectedFailure: true, detectedFailure: true, measurementBefore: { hash: sourceHash }, measurementAfter: { hash: digest(Buffer.from('byte-flipped copy')) } } },
    },
    visualEvidence: { status: 'passed', outputHash: sourceHash, files: [{ status: 'passed', path: visualPath, sha256: digest(visualBytes), outputHash: sourceHash, viewSet: staticViewIds }] },
  };
  await writeFile(path.join(root, evidenceFile), JSON.stringify(propEvidence));
  const asset = { id: 'prop-fixture', kind: 'prop', sourceType: 'native-glb', nativeGlb: assetPath, runtimeUrl: '/' + assetPath, sourceInputHash, sourceReference: { sha256: sourceInputHash }, outputHash: sourceHash, sourceHash, providerTaskId: 'fixture-task-1', provenance: { status: 'fixture-only', providerTaskId: 'fixture-task-1' }, evidenceStatus: 'verified', evidence: evidenceFile, gates, requiredActionIds: [], actionToClipMapping: {} };
  const recipe = { id: 'environment-fixture', proceduralRecipeId: 'environment-fixture', kind: 'environment', sourceType: 'composed-recipe', nativeGlb: null, runtimeUrl: null, componentAssetIds: ['prop-fixture'], evidenceStatus: 'verified', evidence: environmentEvidenceFile };
  const manifest = { schemaVersion: 2, manifestVersion: 'test-fixture', assets: [asset], environmentRecipes: [recipe], sourceWorkItems: [{ workId: 'prop-fixture', runtimeAssetId: 'prop-fixture', state: 'complete' }] };
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(path.join(dist, 'assets/manifest.json'), JSON.stringify([asset, recipe]));
  const entries = [];
  for (const [file, contentType] of [[assetPath, 'model/gltf-binary'], ['assets/manifest.json', 'application/json'], ['entry.js', 'text/javascript'], ['index.html', 'text/html'], ['release-compatibility.json', 'application/json']]) {
    const bytes = await readFile(path.join(dist, file));
    entries.push({ path: file, bytes: bytes.length, sha256: digest(bytes), mime: contentType });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const reference = JSON.parse(await readFile(path.resolve(process.cwd(), 'docs/implementation/reference-profile.json'), 'utf8'));
  const routesDoc = await readFile(path.resolve(process.cwd(), 'docs/implementation/BENCHMARK-ROUTES.md'), 'utf8');
  const routeIds = [...routesDoc.matchAll(/^\|\s*([a-z0-9-]+)\s*\|/gm)].map((match) => match[1]);
  const routes = routeIds.map((id) => ({ id, seed: 'fixture-seed', checkpointHistoryFixtureId: 'fixture-only', metrics: { fps: { value: 60, unit: 'fps' }, p95FrameInterval: { value: 17.5, unit: 'ms' }, p99FrameInterval: { value: 25, unit: 'ms' }, cpuSimulationP95: { value: 1, unit: 'ms' }, cpuAnimationP95: { value: 1, unit: 'ms' }, cpuRenderP95: { value: 1, unit: 'ms' }, gpuTiming: { status: 'unavailable', reason: 'validator fixture only' } } }));
  const benchmark = { schemaVersion: 1, buildIdentity: digest(JSON.stringify(entries)), measuredAt: '2026-01-01T00:00:00Z', hardware: reference.hardware, browser: Object.fromEntries(['userAgent', 'platform', 'webgl2', 'version', 'renderer', 'vendor', 'devicePixelRatio'].map((key) => [key, reference.browser[key]]).concat([['viewport', reference.browser.viewport]])), viewport: { width: reference.performanceTarget.width, height: reference.performanceTarget.height, dpr: reference.performanceTarget.dpr }, revisions: { source: 'fixture', content: 'fixture', assets: 'fixture', settings: 'fixture' }, seed: 'fixture-seed', checkpointHistoryFixtureId: 'fixture-only', routes };
  const benchmarkPath = path.join(root, 'evidence/release/benchmarks.json');
  await writeFile(benchmarkPath, JSON.stringify(benchmark));
  const configFile = path.join(root, 'vite.preview.config.mjs');
  await writeFile(configFile, "export default { plugins: [{ name: 'release-fixture-cache', configurePreviewServer(server) { server.middlewares.use((req, res, next) => { if ((req.url ?? '').startsWith('/assets/prop-fixture/') && (req.url ?? '').endsWith('.glb')) res.setHeader('cache-control', 'public, max-age=31536000, immutable'); next(); }); } }] };\n");
  return { root, dist, evidenceRoot, manifestPath, manifest, configFile, assetPath, benchmarkPath };
}
async function rebindNativeFixture(f, bytes) {
  const asset = f.manifest.assets[0], hash = digest(bytes), previousPath = f.assetPath;
  f.assetPath = 'assets/' + asset.id + '/' + hash + '.glb';
  asset.nativeGlb = f.assetPath; asset.runtimeUrl = '/' + f.assetPath; asset.sourceHash = hash; asset.outputHash = hash;
  await writeFile(path.join(f.dist, f.assetPath), bytes);
  if (previousPath !== f.assetPath) await rm(path.join(f.dist, previousPath));
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  await writeFile(path.join(f.dist, 'assets/manifest.json'), JSON.stringify([...f.manifest.assets, ...f.manifest.environmentRecipes]));
  const evidencePath = path.join(f.root, asset.evidence), evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  evidence.sourceHash = hash; evidence.outputHash = hash; evidence.visualEvidence.outputHash = hash;
  for (const file of evidence.visualEvidence.files) file.outputHash = hash;
  for (const control of [...evidence.negativeControls, ...evidence.measurements.G10.negativeControls]) control.sourceHash = hash;
  evidence.measurements.G11.derivativeHash = hash; evidence.measurements.G11.frozenHash = hash; evidence.measurements.G11.negativeControl.measurementBefore.hash = hash;
  await writeFile(evidencePath, JSON.stringify(evidence));
  for (const recipe of f.manifest.environmentRecipes) {
    const recipePath = path.join(f.root, recipe.evidence), sceneEvidence = JSON.parse(await readFile(recipePath, 'utf8'));
    sceneEvidence.componentOutputHashes[asset.id] = hash;
    await writeFile(recipePath, JSON.stringify(sceneEvidence));
  }
  const entries = [];
  for (const [file, mime] of [[f.assetPath, 'model/gltf-binary'], ['assets/manifest.json', 'application/json'], ['entry.js', 'text/javascript'], ['index.html', 'text/html'], ['release-compatibility.json', 'application/json']]) {
    const content = await readFile(path.join(f.dist, file));
    entries.push({ path: file, bytes: content.length, sha256: digest(content), mime });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const benchmark = JSON.parse(await readFile(f.benchmarkPath, 'utf8')); benchmark.buildIdentity = digest(JSON.stringify(entries));
  await writeFile(f.benchmarkPath, JSON.stringify(benchmark));
}


test('rejects byte-copy-only fixture while retaining actual Vite preview and CLI fail-closed output', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assertOnlyUnmeasuredParity(result.errors);
  const probe = await (await import('node:http')).createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  assert.deepEqual(await verifyPreview(f.dist, result.nativeAssets, port, process.cwd(), f.configFile), []);
  const cli = spawnSync(process.execPath, ['scripts/release/validate.mjs', '--repo', f.root, '--vite-root', process.cwd(), '--dist', f.dist, '--manifest', f.manifestPath, '--benchmarks', f.benchmarkPath, '--config', f.configFile, '--port', String(port)], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(cli.status, 1, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).accepted, false);
});

test('rejects missing native GLB instead of accepting manifest declaration', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await rm(path.join(f.dist, f.assetPath));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert(result.errors.some((error) => error.includes('missing from dist')));
});

test('rejects emitted GLB bytes that do not match declared output hash', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(path.join(f.dist, f.assetPath), 'different bytes');
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert(result.errors.some((error) => error.includes('outputHash does not match')));
  assert(result.errors.some((error) => error.includes('malformed or has external GLB dependencies')));
});

test('rejects recipe component IDs that do not resolve to native assets', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  f.manifest.environmentRecipes[0].componentAssetIds = ['missing-prop'];
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  const runtimeManifestPath = path.join(f.dist, 'assets/manifest.json');
  const runtimeManifest = JSON.parse(await readFile(runtimeManifestPath, 'utf8'));
  runtimeManifest.find((entry) => entry.sourceType === 'composed-recipe').componentAssetIds = ['missing-prop'];
  await writeFile(runtimeManifestPath, JSON.stringify(runtimeManifest));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert(result.errors.some((error) => error.includes('unresolved native component missing-prop')));
});

test('rejects an absent measured benchmark rather than inferring performance readiness', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await rm(path.join(f.root, 'evidence/release/benchmarks.json'));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert(result.errors.some((error) => error.includes('Measured release benchmark')));
});

test('rejects measured performance values beyond their recorded limits', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const benchmarkPath = path.join(f.root, 'evidence/release/benchmarks.json');
  const benchmark = JSON.parse(await readFile(benchmarkPath, 'utf8'));
  benchmark.routes[0].metrics.p95FrameInterval.value = 30;
  await writeFile(benchmarkPath, JSON.stringify(benchmark));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert(result.errors.some((error) => error.includes('exceeds fixed p95 frame interval')));
});

test('rejects signed provider URLs and secret-bearing source-task metadata', async (t) => {
  for (const unsafeField of [{ providerUrl: 'https://provider.invalid/task?X-Amz-Signature=secret' }, { apiKey: 'redacted-test-secret' }]) {
    const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
    Object.assign(f.manifest.sourceWorkItems[0], unsafeField);
    await writeFile(f.manifestPath, JSON.stringify(f.manifest));
    const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
    assert(result.errors.some((error) => error.includes('Source manifest metadata is not sanitized')));
  }
});

test('rejects stale source-input evidence even when runtime GLB hashes match', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const evidencePath = path.join(f.root, f.manifest.assets[0].evidence);
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  evidence.sourceInputHash = digest(Buffer.from('different approved input'));
  await writeFile(evidencePath, JSON.stringify(evidence));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert(result.errors.some((error) => error.includes('approved input and exact measured GLB bytes')));
});

test('rejects kind relabeling that bypasses character process and action gates', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  f.manifest.assets[0].kind = 'character';
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  const runtimePath = path.join(f.dist, 'assets/manifest.json');
  const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
  runtime[0].kind = 'character';
  await writeFile(runtimePath, JSON.stringify(runtime));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert(result.errors.some((error) => error.includes('gate G1 is not passed')));
  assert(result.errors.some((error) => error.includes('complete applicable plugin check inventory')));
  assert(result.errors.some((error) => error.includes('complete required ActionId-to-native-animation coverage')));
});

test('rejects character gate strings without actual G1/G3/G6/G10 producers and review evidence', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const asset = f.manifest.assets[0];
  const gates = { G1: 'passed', G3: 'passed', G6: 'passed', G10: 'passed', G11: 'passed', G12: 'passed' };
  asset.kind = 'character'; asset.species = 'human'; asset.requiredActionIds = ['character-idle']; asset.actionToClipMapping = { 'character-idle': null }; asset.gates = gates;
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  const runtimePath = path.join(f.dist, 'assets/manifest.json');
  const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
  Object.assign(runtime[0], { kind: 'character', species: 'human', requiredActionIds: ['character-idle'], actionToClipMapping: { 'character-idle': null }, gates });
  await writeFile(runtimePath, JSON.stringify(runtime));
  const evidencePath = path.join(f.root, asset.evidence);
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  evidence.gates = gates;
  const gateIds = ['G1', 'G1', 'G3', 'G3', 'G6', 'G6', 'G10', 'G10', 'G11', 'G11', 'G12', 'G12'];
  evidence.expectedPluginCheckIds = gateIds.map((gate, index) => gate + '-fixture-' + index);
  evidence.pluginChecks = evidence.expectedPluginCheckIds.map((id, index) => ({ id, gate: gateIds[index], status: 'passed' }));
  evidence.negativeControls = [
    ['G1-disconnected-native-track', 'G1'], ['G3-unrestored-active-action', 'G3'], ['G6-hidden-required-body-part:core', 'G6'],
    ['G10-corrupt-native-skin-weight', 'G10'], ['G10-missing-contact-window:character-idle', 'G10'],
  ].map(([id, gate]) => ({ id, gate, assetId: asset.id, sourceHash: asset.sourceHash, expectedFailure: true, detectedFailure: true, measurementBefore: { state: 'baseline' }, measurementAfter: { state: 'control-detected' } }));
  evidence.measurements = { G1: { status: 'incomplete', clips: [] }, G3: { status: 'incomplete' }, G6: { status: 'incomplete' }, G10: { status: 'incomplete', clips: [] }, G11: { status: 'incomplete' } };
  evidence.actionCoverage = { status: 'incomplete', requiredActionIds: ['character-idle'], mappedClipIds: [], missingActionIds: ['character-idle'] };
  evidence.speciesCoverage = { status: 'incomplete', measurement: { species: 'human' } };
  await writeFile(evidencePath, JSON.stringify(evidence));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert(result.errors.some((error) => error.includes('must be a native skinned model with authored animations')));
  assert(result.errors.some((error) => error.includes('G1 per-clip binding/sample')));
  assert(result.errors.some((error) => error.includes('G3 stop/reset pose-restore')));
  assert(result.errors.some((error) => error.includes('G6 visibility and species-specific applicability')));
  assert(result.errors.some((error) => error.includes('G10 per-action deformed-bounds')));
  assert(result.errors.some((error) => error.includes('ActionId-to-native-animation coverage')));
});

test('rejects benchmark self-selected profiles and unrelated high-value metrics', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const benchmarkPath = path.join(f.root, 'evidence/release/benchmarks.json');
  const benchmark = JSON.parse(await readFile(benchmarkPath, 'utf8'));
  benchmark.hardwareProfile = { model: 'unobserved-device' };
  benchmark.routes[0].metrics.p95FrameInterval.limit = 99999;
  benchmark.routes[0].metrics.unrelated = { value: 9999, limit: 99999 };
  await writeFile(benchmarkPath, JSON.stringify(benchmark));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert(result.errors.some((error) => error.includes('self-selected hardware profiles')));
  assert(result.errors.some((error) => error.includes('override fixed reference limits')));
  assert(result.errors.some((error) => error.includes('unrecognized metric')));
});

test('rejects benchmarks missing a required authored route', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const benchmarkPath = path.join(f.root, 'evidence/release/benchmarks.json');
  const benchmark = JSON.parse(await readFile(benchmarkPath, 'utf8'));
  benchmark.routes.pop();
  await writeFile(benchmarkPath, JSON.stringify(benchmark));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert(result.errors.some((error) => error.includes('each authored route exactly once')));
});

test('rejects missing module scripts in the actual production preview', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await writeFile(path.join(f.dist, 'index.html'), '<!doctype html><script type="module" src="/missing-entry.js"></script>');
  const probe = await (await import('node:http')).createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const result = await verifyPreview(f.dist, [], port, process.cwd(), f.configFile);
  assert(result.some((error) => error.includes('does not resolve to an emitted local file')));
});

test('rejects an external image URI in a GLB even when declared metadata still points at a native asset', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const currentPath = path.join(f.dist, f.assetPath);
  const glb = await readFile(currentPath);
  await writeFile(currentPath, withExternalImageUri(glb));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert(result.errors.some((error) => error.includes('malformed or has external GLB dependencies')));
});

test('rejects scene evidence captured against stale component output hashes', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const evidencePath = path.join(f.root, f.manifest.environmentRecipes[0].evidence);
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  evidence.componentOutputHashes['prop-fixture'] = digest(Buffer.from('previous prop output'));
  await writeFile(evidencePath, JSON.stringify(evidence));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert(result.errors.some((error) => error.includes('exact component set/output hashes')));
});

test('rejects stale evidence outputHash when emitted and canonical GLB hashes are unchanged', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const evidencePath = path.join(f.root, f.manifest.assets[0].evidence);
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  evidence.outputHash = digest(Buffer.from('different previous GLB'));
  await writeFile(evidencePath, JSON.stringify(evidence));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert(result.errors.some((error) => error.includes('approved input and exact measured GLB bytes')));
});

test('does not promote review-required G6 measurements when the explicit release gate is incomplete', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  f.manifest.assets[0].gates.G6 = 'incomplete';
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  const runtimePath = path.join(f.dist, 'assets/manifest.json');
  const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
  runtime[0].gates.G6 = 'incomplete';
  await writeFile(runtimePath, JSON.stringify(runtime));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert(result.errors.some((error) => error.includes('manifest gate G6 is not passed')));
});

test('rejects static evidence that omits the per-node wrong-culling negative control', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const evidencePath = path.join(f.root, f.manifest.assets[0].evidence);
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  evidence.negativeControls = evidence.negativeControls.filter((control) => control.id !== 'G10-wrong-culling-bounds:0');
  evidence.measurements.G10.staticGeometry.meshNodes[0].negativeControlIds = evidence.measurements.G10.staticGeometry.meshNodes[0].negativeControlIds.filter((id) => id !== 'G10-wrong-culling-bounds:0');
  await writeFile(evidencePath, JSON.stringify(evidence));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert(result.errors.some((error) => error.includes('lacks negative control G10-wrong-culling-bounds:0')));
});

for (const [name, controlId, mutate, errorText] of [
  ['no-op POSITION counts', 'G10-static-bounds-corruption:0', control => { control.measurementAfter.finitePositionCount = 3; control.measurementAfter.nonFinitePositionCount = 0; }, 'non-finite-position G10 control'],
  ['cross-node POSITION evidence', 'G10-static-bounds-corruption:0', control => { control.measurementAfter.nodeIndex = 1; }, 'non-finite-position G10 control'],
  ['no-op real frustum visibility', 'G10-wrong-culling-bounds:0', control => { control.measurementAfter.frustumVisible = true; control.measurementAfter.primitives[0].frustumVisible = true; }, 'wrong-culling-bounds G10 control'],
  ['cross-node culling primitive', 'G10-wrong-culling-bounds:0', control => { control.measurementAfter.primitives[0].nodeIndex = 1; }, 'wrong-culling-bounds G10 control'],
  ['detached culling sphere', 'G10-wrong-culling-bounds:0', control => { control.measurementAfter.primitives[0].boundingSphere = control.measurementBefore.primitives[0].boundingSphere; }, 'wrong-culling-bounds G10 control'],
  ['malformed frustum camera', 'G10-wrong-culling-bounds:0', control => { control.measurementBefore.primitives[0].cameraProjection = [1]; }, 'wrong-culling-bounds G10 control'],
  ['missing primitive measurement', 'G10-wrong-culling-bounds:0', control => { control.measurementAfter.primitives = []; }, 'wrong-culling-bounds G10 control'],
  ['array-like culling primitive receipts', 'G10-wrong-culling-bounds:0', control => { for (const section of ['measurementBefore', 'measurementAfter']) control[section].primitives = { ...control[section].primitives, length: control[section].primitives.length }; }, 'wrong-culling-bounds G10 control'],
  ['unrestored native cache', 'G10-wrong-culling-bounds:0', control => { control.restoredAfterTest = false; }, 'wrong-culling-bounds G10 control'],
]) test('rejects producer evidence with ' + name, async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const evidencePath = path.join(f.root, f.manifest.assets[0].evidence);
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  mutate(evidence.negativeControls.find(control => control.id === controlId));
  mutate(evidence.measurements.G10.negativeControls.find(control => control.id === controlId));
  await writeFile(evidencePath, JSON.stringify(evidence));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert.ok(result.errors.some(error => error.includes(errorText)), JSON.stringify(result.errors));
});

for (const mode of ['missing nested controls', 'stale nested hash', 'duplicate per-node control', 'cross-node row', 'missing nested control IDs']) test('rejects ' + mode, async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const evidencePath = path.join(f.root, f.manifest.assets[0].evidence);
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  if (mode === 'missing nested controls') delete evidence.measurements.G10.negativeControls;
  if (mode === 'stale nested hash') evidence.measurements.G10.negativeControls[0].sourceHash = digest('stale native bytes');
  if (mode === 'duplicate per-node control') evidence.negativeControls.push(evidence.negativeControls.find(control => control.id === 'G10-static-bounds-corruption:0'));
  if (mode === 'cross-node row') evidence.measurements.G10.staticGeometry.meshNodes[0].nodeIndex = 1;
  if (mode === 'missing nested control IDs') delete evidence.measurements.G10.staticGeometry.meshNodes[0].negativeControlIds;
  await writeFile(evidencePath, JSON.stringify(evidence));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert.ok(result.errors.some(error => error.includes(mode === 'cross-node row' || mode === 'missing nested control IDs' ? 'G10 mesh-node measurements' : 'G10 per-node controls')), JSON.stringify(result.errors));
});

for (const [name, mutate, errorText] of [
  ['missing coverage view', evidence => { evidence.measurements.G6.renderedCoverage.pop(); }, 'framebuffer coverage for every view'],
  ['invented coverage view', evidence => { evidence.measurements.G6.renderedCoverage[1].viewId = 'unmeasured-view'; evidence.visualEvidence.files[0].viewSet.push('unmeasured-view'); }, 'framebuffer coverage for every view'],
  ['truncated hide control', evidence => { const control = evidence.negativeControls.find(row => row.gate === 'G6'); control.measurementBefore.visiblePixelsByView = [1]; control.measurementAfter.visiblePixelsByView = [0]; }, 'rerendered G6 hide-mesh evidence'],
  ['fractional framebuffer pixels', evidence => { const control = evidence.negativeControls.find(row => row.gate === 'G6'); control.measurementBefore.visiblePixelsByView[0] = 1.5; }, 'rerendered G6 hide-mesh evidence'],
]) test('complete static G10 cannot bypass G6 with ' + name, async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const evidencePath = path.join(f.root, f.manifest.assets[0].evidence), evidence = JSON.parse(await readFile(evidencePath));
  mutate(evidence);
  await writeFile(evidencePath, JSON.stringify(evidence));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert.ok(result.errors.some(error => error.includes(errorText)), result.errors.join('\n'));
  assert.ok(!result.errors.some(error => /could not be inspected/.test(error)), result.errors.join('\n'));
});

for (const value of [NaN, 7]) test('rejects independently changed native POSITION bytes even with current source/output hashes: ' + value, async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const bytes = await readFile(path.join(f.dist, f.assetPath));
  bytes.writeFloatLE(value, 28 + bytes.readUInt32LE(12));
  await rebindNativeFixture(f, bytes);
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert.ok(result.errors.some(error => /native POSITION measurement failed/.test(error)), JSON.stringify(result.errors));
});


for (const x of [0.1, 100000.1]) test('accepts float32-equivalent decimal POSITION declarations without an absolute epsilon: ' + x, async (t) => {
  const f = await fixture(minimalTriangleGlb({ coordinates: [[x, 0, 0], [x + 1, 0, 0], [x, 1, 0]], min: [x, 0, 0], max: [x + 1, 1, 0] }));
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const evidence = JSON.parse(await readFile(path.join(f.root, f.manifest.assets[0].evidence), 'utf8'));
  const row = evidence.measurements.G10.staticGeometry.meshNodes[0];
  assert.notEqual(row.measuredLocalBounds.min[0], row.accessorDeclaredLocalBounds.min[0]);
  assert.equal(Math.fround(row.measuredLocalBounds.min[0]), Math.fround(row.accessorDeclaredLocalBounds.min[0]));
  assert.equal(row.accessorBoundsDelta.maxAbs, 0); assert.equal(row.cachedBoundsDelta.maxAbs, 0);
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assertOnlyUnmeasuredParity(result.errors);
});

for (const [name, bounds] of [
  ['wrong native accessor max', { max: [9, 9, 9] }],
  ['one-float32-step native max', { max: [1.0000001192092896, 1, 0] }],
  ['missing native accessor min', { min: undefined }],
  ['reversed native accessor bounds', { min: [2, 0, 0] }],
]) test('rejects retained good evidence after changing ' + name, async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const options = { min: [0, 0, 0], max: [1, 1, 0], ...bounds };
  // Null is malformed JSON-native metadata, while all actual POSITION bytes stay valid.
  if (options.min === undefined) options.min = null;
  await rebindNativeFixture(f, minimalTriangleGlb(options));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert.ok(result.errors.some(error => /native POSITION measurement failed: Native POSITION accessor 0 declared bounds do not match decoded native values in float32 space/.test(error)), JSON.stringify(result.errors));
});


test('rejects stale declared-bounds evidence even when changed native metadata is float32-equivalent', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await rebindNativeFixture(f, minimalTriangleGlb({ max: [1 + 1e-10, 1, 0] }));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert.ok(result.errors.some(error => error.includes('G10 declared bounds evidence does not identify native accessor metadata')), JSON.stringify(result.errors));
});

for (const sharedView of [true, false]) test('accepts independently evidenced native primitive accessors with ' + (sharedView ? 'aliased' : 'separate') + ' loaded buffers', async (t) => {
  const f = await fixture(minimalTriangleGlb({ twoPrimitives: true, sharedView })); t.after(() => rm(f.root, { recursive: true, force: true }));
  const evidence = JSON.parse(await readFile(path.join(f.root, f.manifest.assets[0].evidence), 'utf8'));
  assert.deepEqual(evidence.measurements.G10.staticGeometry.meshNodes[0].primitiveDeclarations.map(declaration => declaration.positionAccessorIndex), [0, 1]);
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assertOnlyUnmeasuredParity(result.errors);
});

test('rejects stale float32-equivalent interior primitive metadata while accepting fresh evidence for it', async (t) => {
  const f = await fixture(minimalTriangleGlb({ twoPrimitives: true, sharedView: false })); t.after(() => rm(f.root, { recursive: true, force: true }));
  const changed = minimalTriangleGlb({ twoPrimitives: true, sharedView: false, secondMin: [1e-50, 0, 0] });
  await rebindNativeFixture(f, changed);
  const rejected = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert.ok(rejected.errors.some(error => /G10 primitive declaration evidence does not identify native accessor metadata/.test(error)), JSON.stringify(rejected.errors));
  const fresh = await fixture(changed); t.after(() => rm(fresh.root, { recursive: true, force: true }));
  const accepted = await inspectAssets({ dist: fresh.dist, manifestPath: fresh.manifestPath, repoRoot: fresh.root });
  assertOnlyUnmeasuredParity(accepted.errors);
});

for (const [name, mutate] of [
  ['missing primitive declarations', row => { delete row.primitiveDeclarations; }],
  ['missing second declaration', row => { row.primitiveDeclarations.pop(); }],
  ['cross-accessor declaration', row => { row.primitiveDeclarations[1].positionAccessorIndex = 0; }],
  ['cross-node declaration', row => { row.primitiveDeclarations[1].nodeIndex = 1; }],
]) test('rejects ' + name + ' even with unchanged node union bounds', async (t) => {
  const f = await fixture(minimalTriangleGlb({ twoPrimitives: true, sharedView: false })); t.after(() => rm(f.root, { recursive: true, force: true }));
  const evidencePath = path.join(f.root, f.manifest.assets[0].evidence), evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  mutate(evidence.measurements.G10.staticGeometry.meshNodes[0]);
  await writeFile(evidencePath, JSON.stringify(evidence));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert.ok(result.errors.some(error => /G10 primitive declaration evidence does not identify native accessor metadata/.test(error)), JSON.stringify(result.errors));
});

for (const [name, options, finiteCount, nonFiniteCount, min] of [
  ['shared contiguous view', {}, 3, 3, [0, 1, 0]],
  ['shared interleaved view', { interleaved: true }, 3, 3, [0, 1, 0]],
  ['distinct views of overlapping file bytes', { separateViews: true }, 4, 2, [0, 0, 0]],
  ['sparse accessor-private copy', { sparse: true }, 4, 2, [0, 0, 0]],
]) test('validates actual physical POSITION fault footprint for ' + name, async (t) => {
  const f = await fixture(overlappingTriangleGlb(options)); t.after(() => rm(f.root, { recursive: true, force: true }));
  const evidence = JSON.parse(await readFile(path.join(f.root, f.manifest.assets[0].evidence), 'utf8'));
  assert.equal(evidence.measurements.G10.status, 'measurement-complete-review-required');
  const control = evidence.negativeControls.find(control => control.id === 'G10-static-bounds-corruption:0');
  assert.equal(control.detectedFailure, true); assert.equal(control.restoredAfterTest, true);
  assert.equal(control.measurementAfter.finitePositionCount, finiteCount);
  assert.equal(control.measurementAfter.nonFinitePositionCount, nonFiniteCount);
  assert.deepEqual(control.measurementAfter.bounds, { min, max: [1, 1, 0] });
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assertOnlyUnmeasuredParity(result.errors);
});

for (const [name, mutate] of [
  ['invented disjoint counts', after => { after.finitePositionCount = 4; after.nonFinitePositionCount = 2; }],
  ['bounds including a physically corrupted later vertex', after => { after.bounds.min = [0, 0, 0]; }],
]) test('rejects overlapping-accessor evidence with ' + name, async (t) => {
  const f = await fixture(overlappingTriangleGlb()); t.after(() => rm(f.root, { recursive: true, force: true }));
  const evidencePath = path.join(f.root, f.manifest.assets[0].evidence), evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  for (const controls of [evidence.negativeControls, evidence.measurements.G10.negativeControls]) mutate(controls.find(control => control.id === 'G10-static-bounds-corruption:0').measurementAfter);
  await writeFile(evidencePath, JSON.stringify(evidence));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert.ok(result.errors.some(error => /lacks a detected non-finite-position G10 control/.test(error)), JSON.stringify(result.errors));
});


function nativePolicy(bytes) {
  return JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12))).asset.extras.wildCrownStaticVisibilityPolicy;
}

function encodeNative(json, binary) {
  const raw = Buffer.from(JSON.stringify(json)), chunk = Buffer.concat([raw, Buffer.alloc((4 - raw.length % 4) % 4, 32)]);
  const padded = Buffer.concat([binary, Buffer.alloc((4 - binary.length % 4) % 4)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + chunk.length + padded.length, 8);
  header.writeUInt32LE(chunk.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(padded.length); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, chunk, binHeader, padded]);
}

function resourceDeclaration(count, { componentType = 5121, viewBytes = count * 3, sparse = false, mode = 4 } = {}) {
  return {
    buffers: [{ byteLength: viewBytes }], bufferViews: [{ buffer: 0, byteLength: viewBytes }],
    accessors: [{ count, componentType, type: 'VEC3', ...(sparse ? { sparse: { count: 1 } } : { bufferView: 0 }) }],
    meshes: [{ primitives: [{ mode, attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
  };
}

for (const delta of [-1, 0, 1]) test('decoded POSITION storage boundary ' + delta + ' byte at 256MiB', () => {
  const gltf = resourceDeclaration(1, { viewBytes: 256 * 1024 * 1024 - 24 + delta });
  if (delta > 0) assert.throws(() => positionResourceBudget(gltf), /resource refusal: decoded storage/);
  else assert.deepEqual(positionResourceBudget(gltf), { decodedStorageBytes: 256 * 1024 * 1024 + delta, positionVertexOccurrences: 1 });
});

for (const delta of [-1, 0, 1]) test('POSITION vertex-occurrence boundary ' + delta + ' at 8M', () => {
  const gltf = resourceDeclaration(8_000_000 + delta);
  if (delta > 0) assert.throws(() => positionResourceBudget(gltf), /resource refusal: vertex occurrences/);
  else assert.deepEqual(positionResourceBudget(gltf), { decodedStorageBytes: (8_000_000 + delta) * 27, positionVertexOccurrences: 8_000_000 + delta });
});

test('sparse tiny source refuses before touching framing or allocating count-sized storage', () => {
  const sparse = resourceDeclaration(8_000_000, { componentType: 5126, viewBytes: 16, sparse: true });
  assert.throws(() => nativePositions(sparse, Buffer.alloc(0)), /resource refusal: decoded storage/);
  sparse.accessors[0].count++;
  assert.throws(() => nativePositions(sparse, Buffer.alloc(0)), /resource refusal: vertex occurrences/);
});

test('budget charges unique accessors/views, embedded storage, converted private clones, active instances and inactive declarations', () => {
  const shared = resourceDeclaration(3, { componentType: 5126, viewBytes: 48 });
  shared.bufferViews[0].byteStride = 16;
  shared.meshes[0].primitives.push({ mode: 4, attributes: { POSITION: 0 } });
  assert.deepEqual(positionResourceBudget(shared), { decodedStorageBytes: 120, positionVertexOccurrences: 6 });
  shared.accessors.push({ ...shared.accessors[0] }); shared.meshes[0].primitives[1].attributes.POSITION = 1;
  assert.equal(positionResourceBudget(shared).decodedStorageBytes, 192);
  shared.bufferViews.push({ ...shared.bufferViews[0] }); shared.accessors[1].bufferView = 1;
  assert.equal(positionResourceBudget(shared).decodedStorageBytes, 240);
  shared.meshes[0].primitives[0].mode = 5; shared.meshes[0].primitives[1].mode = 6;
  assert.equal(positionResourceBudget(shared).decodedStorageBytes, 336);
  shared.buffers.push({ byteLength: 4, uri: 'data:application/octet-stream;base64,AAAAAA==' });
  assert.equal(positionResourceBudget(shared).decodedStorageBytes, 340);
  shared.nodes.push({ mesh: 0 }); shared.scenes[0].nodes.push(1);
  assert.equal(positionResourceBudget(shared).positionVertexOccurrences, 12);
  shared.meshes.push({ primitives: [{ attributes: { POSITION: 0 } }] });
  assert.equal(positionResourceBudget(shared).positionVertexOccurrences, 15);
  assert.equal(positionResourceBudget(shared).decodedStorageBytes, 340);
});

function modeGlb(mode, indexed, ownership) {
  const sharedCoordinates = [[0,0,0], [1,0,0], [0,1,0], ...(mode === 4 ? [] : [[1,1,0]])];
  const seed = ownership === 'shared' ? minimalTriangleGlb({ twoPrimitives: true, coordinates: sharedCoordinates }) : overlappingTriangleGlb({ interleaved: ownership === 'interleaved', separateViews: ownership === 'distinct', sparse: ownership === 'sparse' });
  const jsonLength = seed.readUInt32LE(12), json = JSON.parse(seed.toString('utf8', 20, 20 + jsonLength));
  let binary = Buffer.from(seed.subarray(28 + jsonLength));
  if (ownership === 'same-accessor') json.meshes[0].primitives[1].attributes.POSITION = 0;
  json.meshes[0].primitives.forEach((primitive, index) => { primitive.mode = ownership === 'mixed' && index === 0 ? 4 : mode; });
  if (indexed) {
    const view = json.bufferViews.length, accessor = json.accessors.length, offset = binary.length;
    const count = json.accessors[0].count, indices = Buffer.alloc(8);
    for (let index = 0; index < count; index++) indices.writeUInt16LE(index, index * 2);
    binary = Buffer.concat([binary, indices]);
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: count * 2 });
    json.accessors.push({ bufferView: view, componentType: 5123, type: 'SCALAR', count });
    json.meshes[0].primitives.forEach(primitive => { primitive.indices = accessor; });
  }
  json.buffers[0].byteLength = binary.length;
  json.nodes.push({ mesh: 0, name: 'repeated-native-node', translation: [3, -1, 2] }); json.scenes[0].nodes.push(1);
  json.asset.extras.wildCrownStaticVisibilityPolicy.requiredMeshNodes.push({ nodeIndex: 1, minimumVisiblePixels: 1, minimumVisibleViews: 1 });
  return encodeNative(json, binary);
}

for (const mode of [4, 5, 6]) for (const indexed of [false, true]) for (const ownership of ['same-accessor', 'shared', 'distinct', 'interleaved', 'sparse', 'mixed']) {
  test('actual GLTFLoader → G10 validator mode ' + mode + ' ' + (indexed ? 'indexed ' : 'nonindexed ') + ownership + ' with repeated nodes', async t => {
    const bytes = modeGlb(mode, indexed, ownership);
    const native = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    const snapshots = [];
    native.scene.traverse(mesh => {
      if (!mesh.isMesh) return;
      const geometry = mesh.geometry, position = geometry.getAttribute('position'), array = position.array || position.data.array;
      geometry.computeBoundingSphere();
      snapshots.push({ geometry, position, array, bytes: Uint8Array.from(new Uint8Array(array.buffer)), version: position.data?.version ?? position.version, box: geometry.boundingBox, boxValue: geometry.boundingBox.clone(), sphere: geometry.boundingSphere, sphereValue: geometry.boundingSphere.clone(), index: geometry.index, indexVersion: geometry.index?.version, indexValues: geometry.index ? Array.from(geometry.index.array) : null });
    });
    const measured = measureStaticGeometry(native, native.scene, 'prop-fixture', digest(bytes));
    assert.equal(measured.status, 'measurement-complete-review-required');
    assert.equal(measured.negativeControls.length, 4);
    assert.ok(measured.negativeControls.every(row => row.detectedFailure && row.restoredAfterTest));
    for (const snapshot of snapshots) {
      assert.equal(snapshot.geometry.getAttribute('position'), snapshot.position);
      assert.deepEqual(new Uint8Array(snapshot.array.buffer), snapshot.bytes);
      assert.equal(snapshot.position.data?.version ?? snapshot.position.version, snapshot.version);
      assert.equal(snapshot.geometry.boundingBox, snapshot.box); assert.ok(snapshot.box.equals(snapshot.boxValue));
      assert.equal(snapshot.geometry.boundingSphere, snapshot.sphere); assert.ok(snapshot.sphere.equals(snapshot.sphereValue));
      assert.equal(snapshot.geometry.index, snapshot.index);
      assert.equal(snapshot.geometry.index?.version, snapshot.indexVersion);
      assert.deepEqual(snapshot.geometry.index ? Array.from(snapshot.geometry.index.array) : null, snapshot.indexValues);
    }
    const f = await fixture(bytes); t.after(() => rm(f.root, { recursive: true, force: true }));
    const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
    assertOnlyUnmeasuredParity(result.errors);
  });
}

for (const [name, mutate] of [
  ['missing files', evidence => { evidence.visualEvidence.files = []; }],
  ['unreviewed aggregate', evidence => { evidence.visualEvidence.status = 'not-run'; }],
  ['stale aggregate', evidence => { evidence.visualEvidence.outputHash = '0'.repeat(64); }],
  ['unreviewed file', evidence => { delete evidence.visualEvidence.files[0].status; }],
  ['stale file', evidence => { evidence.visualEvidence.files[0].outputHash = '0'.repeat(64); }],
  ['tampered hash', evidence => { evidence.visualEvidence.files[0].sha256 = '0'.repeat(64); }],
  ['missing image', evidence => { evidence.visualEvidence.files[0].path = 'evidence/assets/absent.png'; }],
  ['path escape', evidence => { evidence.visualEvidence.files[0].path = '../outside.png'; }],
]) test('native visual evidence rejects ' + name + ' independently of retained view names', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const file = path.join(f.root, f.manifest.assets[0].evidence), evidence = JSON.parse(await readFile(file));
  mutate(evidence); await writeFile(file, JSON.stringify(evidence));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert.ok(result.errors.some(error => /visual evidence/.test(error)), result.errors.join('\n'));
});

test('real exporter preserves canonical native gates/provenance and recipe evidence; emitted validator still rejects unmeasured G11', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  await mkdir(path.join(f.root, 'public', path.dirname(f.assetPath)), { recursive: true });
  await writeFile(path.join(f.root, 'public', f.assetPath), await readFile(path.join(f.dist, f.assetPath)));
  const evidenceFile = path.join(f.root, f.manifest.assets[0].evidence), evidence = JSON.parse(await readFile(evidenceFile));
  const control = { ...evidence.measurements.G11.negativeControl, gate: 'G11', assetId: 'prop-fixture', sourceHash: evidence.sourceHash };
  evidence.negativeControls.push(control); await writeFile(evidenceFile, JSON.stringify(evidence));
  const emitted = await exportRuntimeManifest({ projectRoot: f.root, sourcePath: f.manifestPath, outputPath: path.join(f.dist, 'assets/manifest.json') });
  const native = emitted.find(entry => entry.sourceType === 'native-glb');
  for (const key of ['gates', 'providerTaskId', 'sourceHash', 'outputHash', 'sourceInputHash', 'evidence']) assert.deepEqual(native[key], f.manifest.assets[0][key]);
  assert.equal(native.provenance, 'asset-source/manifest.json#' + native.id);
  assert.equal(emitted.find(entry => entry.sourceType === 'composed-recipe').evidence, f.manifest.environmentRecipes[0].evidence);
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert.ok(result.errors.some(error => /byte-copy parity is insufficient/.test(error)));
  assert.ok(!result.errors.some(error => /canonical|provenance|sourceInputHash|recipe.*evidence/.test(error)), result.errors.join('\n'));
  f.manifest.assets[0].sourceInputHash = '0'.repeat(64); await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  await assert.rejects(exportRuntimeManifest({ projectRoot: f.root, sourcePath: f.manifestPath }), /sourceInputHash mismatch/);
});

test('actual full lab report keeps incomplete gates rejected and routes G11 controls without aliases', async t => {
  const bytes = modeGlb(5, false, 'shared');
  const native = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const f = await fixture(bytes); t.after(() => rm(f.root, { recursive: true, force: true }));
  const scene = new THREE.Scene(); scene.add(native.scene);
  // A zero-framebuffer instrument tests schema/restoration only; not visual proof.
  const renderer = { getRenderTarget: () => null, getClearColor: color => color.set(0), getClearAlpha: () => 1, setRenderTarget() {}, setClearColor() {}, clear() {}, render() {}, readRenderTargetPixels(target, x, y, width, height, pixels) { pixels.fill(0); } };
  const report = await buildEvidence(native, { name: 'isolated-native.glb', size: bytes.length }, digest(bytes), 'prop-fixture', { catalogEntry: f.manifest.assets[0], sourceBytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), renderer, scene, camera: new THREE.PerspectiveCamera() });
  assert.equal(report.gates.G11, 'incomplete');
  assert.equal(report.measurements.G11.runtimeParity, null);
  assert.equal(report.productionAcceptance, 'not-established');
  assert.deepEqual(report.measurements.G6.meshInventory.map(row => [row.nodeIndex, row.primitiveCount, row.vertexCount, row.indexCount]), [[0, 2, 8, 12], [1, 2, 8, 12]]);
  assert.equal(report.measurements.G6.renderedCoverage.length, 8);
  for (const control of report.measurements.G6.negativeControls) {
    assert.equal(control.measurementBefore.meshIndex, 0);
    assert.equal(control.measurementBefore.nodeName, control.measurementAfter.nodeName);
  }
  assert.ok(report.negativeControls.every(control => !['G1', 'G3', 'G12'].includes(control.gate)));
  await writeFile(path.join(f.root, f.manifest.assets[0].evidence), JSON.stringify(report));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert.ok(result.errors.some(error => /G11/.test(error)));
  assert.ok(result.errors.some(error => /plugin/.test(error)));
  assert.ok(result.errors.some(error => /visual evidence/.test(error)));
  assert.ok(!result.errors.some(error => /negative control G11/.test(error)), result.errors.join('\n'));
  assert.ok(!result.errors.some(error => /G6 inventory|G10 .*node|invalid JSON|could not be inspected/.test(error)), result.errors.join('\n'));
});

test('excluded native nodes do not require inapplicable G6 hide controls but retain both G10 controls', async t => {
  const bytes = modeGlb(4, true, 'distinct'), jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength)), policy = json.asset.extras.wildCrownStaticVisibilityPolicy;
  policy.requiredMeshNodes = policy.requiredMeshNodes.slice(0, 1);
  policy.excludedMeshNodes = [{ nodeIndex: 1, reason: 'authored nonessential duplicate fixture' }];
  const f = await fixture(encodeNative(json, bytes.subarray(28 + jsonLength))); t.after(() => rm(f.root, { recursive: true, force: true }));
  const evidencePath = path.join(f.root, f.manifest.assets[0].evidence), evidence = JSON.parse(await readFile(evidencePath));
  evidence.negativeControls.push({ id: 'G1-disconnected-native-track', gate: 'G1', assetId: 'prop-fixture', sourceHash: evidence.sourceHash, expectedFailure: true, detectedFailure: false, measurementBefore: null, measurementAfter: null });
  await writeFile(evidencePath, JSON.stringify(evidence));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assertOnlyUnmeasuredParity(result.errors);
});

function characterNativeGlb() {
  const seed = minimalTriangleGlb(), length = seed.readUInt32LE(12);
  const json = JSON.parse(seed.toString('utf8', 20, 20 + length));
  let binary = Buffer.from(seed.subarray(28 + length));
  const add = (values, componentType, type, count) => {
    const ArrayType = componentType === 5121 ? Uint8Array : Float32Array;
    const array = new ArrayType(values), raw = Buffer.from(array.buffer), view = json.bufferViews.length, accessor = json.accessors.length;
    json.bufferViews.push({ buffer: 0, byteOffset: binary.length, byteLength: raw.length });
    json.accessors.push({ bufferView: view, componentType, type, count });
    binary = Buffer.concat([binary, raw, Buffer.alloc((4 - raw.length % 4) % 4)]);
    return accessor;
  };
  json.meshes[0].primitives[0].attributes.JOINTS_0 = add(Array(12).fill(0), 5121, 'VEC4', 3);
  json.meshes[0].primitives[0].attributes.WEIGHTS_0 = add([1,0,0,0,1,0,0,0,1,0,0,0], 5126, 'VEC4', 3);
  const inverse = add(new THREE.Matrix4().toArray(), 5126, 'MAT4', 1);
  const input = add([0, 1], 5126, 'SCALAR', 2);
  const output = add([0,0,0,1,0,0], 5126, 'VEC3', 2);
  json.nodes[0].skin = 0; json.nodes[0].children = [1];
  json.nodes.push({ name: 'native-root-bone' });
  json.skins = [{ joints: [1], inverseBindMatrices: inverse }];
  json.animations = [{ name: 'idle', samplers: [{ input, output, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }] }];
  json.buffers[0].byteLength = binary.length;
  return encodeNative(json, binary);
}

for (const boundary of ['valid-inventory', 'missing-clip', 'stale-clip']) test('character G10 native measured clip inventory: ' + boundary, async t => {
  const bytes = characterNativeGlb(), native = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const f = await fixture(bytes); t.after(() => rm(f.root, { recursive: true, force: true }));
  const asset = f.manifest.assets[0], gates = Object.fromEntries(['G1', 'G3', 'G6', 'G10', 'G11', 'G12'].map(gate => [gate, 'passed']));
  Object.assign(asset, { kind: 'character', gates, requiredActionIds: ['idle-action'], actionToClipMapping: { 'idle-action': 'idle' } });
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  await writeFile(path.join(f.dist, 'assets/manifest.json'), JSON.stringify([...f.manifest.assets, ...f.manifest.environmentRecipes]));
  const file = path.join(f.root, asset.evidence), evidence = JSON.parse(await readFile(file));
  evidence.gates = gates;
  evidence.actionCoverage = { status: 'passed', requiredActionIds: ['idle-action'], missingActionIds: [], mappedClipIds: [{ actionId: 'idle-action', clipId: 'idle' }] };
  const g1 = measureG1(native.scene, native.animations), g3 = measureG3(native.scene, native.animations);
  const boundsReader = root => {
    const bounds = new THREE.Box3(), point = new THREE.Vector3(); let vertices = 0;
    root.updateMatrixWorld(true);
    root.traverse(mesh => {
      if (!mesh.isMesh) return;
      for (let vertex = 0; vertex < mesh.geometry.getAttribute('position').count; vertex++) { mesh.getVertexPosition(vertex, point); bounds.expandByPoint(point.applyMatrix4(mesh.matrixWorld)); vertices++; }
    });
    return { min: bounds.min.toArray(), max: bounds.max.toArray(), vertices };
  };
  const g10 = measureG10(native.scene, native.animations, g1, boundsReader);
  // Exercise only inventory validation with real sampled clip data. Semantic
  // controls and G11 remain incomplete; this is not character acceptance.
  g10.status = 'measurement-complete-review-required';
  if (boundary === 'missing-clip') g10.clips = [];
  if (boundary === 'stale-clip') g10.clips[0].clip = 'absent-native-animation';
  evidence.measurements.G1 = g1; evidence.measurements.G3 = g3; evidence.measurements.G10 = g10;
  await writeFile(file, JSON.stringify(evidence));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert.ok(!result.errors.some(error => /could not be inspected|invalid JSON|g10ClipNames/.test(error)), result.errors.join('\n'));
  const clipErrors = result.errors.filter(error => /G10 per-action/.test(error));
  assert.equal(clipErrors.length, boundary === 'valid-inventory' ? 0 : 1, result.errors.join('\n'));
});

test('valid framed sparse GLB with tiny source is specifically resource-refused by the real inspector', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const seed = minimalTriangleGlb(), length = seed.readUInt32LE(12), json = JSON.parse(seed.toString('utf8', 20, 20 + length));
  const binary = Buffer.alloc(16); binary.writeFloatLE(1, 4);
  json.buffers = [{ byteLength: 16 }];
  json.bufferViews = [{ buffer: 0, byteLength: 1 }, { buffer: 0, byteOffset: 4, byteLength: 12 }];
  json.accessors = [{ componentType: 5126, type: 'VEC3', count: 8_000_000, min: [0,0,0], max: [1,0,0], sparse: { count: 1, indices: { bufferView: 0, componentType: 5121 }, values: { bufferView: 1 } } }];
  await rebindNativeFixture(f, encodeNative(json, binary));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert.ok(result.errors.some(error => /POSITION validation resource refusal: decoded storage/.test(error)), result.errors.join('\n'));
  assert.ok(!result.errors.some(error => /malformed|invalid JSON|could not be inspected/.test(error)), result.errors.join('\n'));
});

test('native visual evidence rejects symlink escapes even with valid bytes and hash', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const external = await mkdtemp(path.join(os.tmpdir(), 'wild-crown-external-visual-')); t.after(() => rm(external, { recursive: true, force: true }));
  const file = path.join(f.root, f.manifest.assets[0].evidence), evidence = JSON.parse(await readFile(file)), image = evidence.visualEvidence.files[0];
  await writeFile(path.join(external, 'image.png'), await readFile(path.join(f.root, image.path)));
  image.path = 'evidence/assets/escaped.png';
  await symlink(path.join(external, 'image.png'), path.join(f.root, image.path));
  await writeFile(file, JSON.stringify(evidence));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert.ok(result.errors.some(error => /visual evidence file/.test(error)), result.errors.join('\n'));
});

for (const missing of ['G11', 'G12']) test(missing + ' controls retain gate identity and apply detection only when native-applicable', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const file = path.join(f.root, f.manifest.assets[0].evidence), evidence = JSON.parse(await readFile(file));
  const control = { id: missing + '-native-boundary', gate: missing, assetId: 'prop-fixture', sourceHash: evidence.sourceHash, expectedFailure: true, detectedFailure: false, measurementBefore: { matches: true }, measurementAfter: { matches: false } };
  evidence.negativeControls.push(control);
  await writeFile(file, JSON.stringify(evidence));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert.equal(result.errors.some(error => error.includes('negative control ' + control.id)), missing === 'G11');
});

for (const variant of ['empty-claim', 'partial-measurement', 'missing-controls', 'nondetecting-controls']) test('G11 rejects adversarial runtime-parity claim: ' + variant, async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const file = path.join(f.root, f.manifest.assets[0].evidence), evidence = JSON.parse(await readFile(file)), g11 = evidence.measurements.G11;
  g11.missingAcceptanceControls = [];
  g11.runtimeParity = { schemaVersion: 1, outputHash: evidence.outputHash, measurements: {}, negativeControls: [] };
  if (variant !== 'empty-claim') for (const kind of ['geometry', 'uv', 'material', 'frozenLiveScene']) {
    g11.runtimeParity.measurements[kind] = { status: 'measured', matches: true, liveHash: evidence.outputHash, frozenHash: evidence.outputHash };
    if (variant === 'nondetecting-controls') {
      const control = { id: 'G11-' + kind + '-mismatch', gate: 'G11', assetId: evidence.assetId, sourceHash: evidence.sourceHash, expectedFailure: true, detectedFailure: false, measurementBefore: { matches: true, liveHash: evidence.outputHash, frozenHash: evidence.outputHash }, measurementAfter: { matches: true, liveHash: evidence.outputHash, frozenHash: evidence.outputHash } };
      g11.runtimeParity.negativeControls.push(control); evidence.negativeControls.push(control);
    }
  }
  if (variant === 'partial-measurement') delete g11.runtimeParity.measurements.uv;
  await writeFile(file, JSON.stringify(evidence));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert.ok(result.errors.some(error => /byte-copy parity is insufficient/.test(error)), result.errors.join('\n'));
});

function seedAdversarialParityReceipts(evidence) {
  // Receipt-shape adversary only: these claims are not genuine scene measurements,
  // are never promoted, and each persisted test record is deliberately invalid.
  const g11 = evidence.measurements.G11;
  g11.missingAcceptanceControls = [];
  g11.runtimeParity = { schemaVersion: 1, outputHash: evidence.outputHash, measurements: {}, negativeControls: [] };
  for (const kind of ['geometry', 'uv', 'material', 'frozenLiveScene']) {
    const baseline = digest(Buffer.from('isolated receipt baseline:' + kind));
    const changed = digest(Buffer.from('isolated receipt mutation:' + kind));
    g11.runtimeParity.measurements[kind] = { status: 'measured', matches: true, liveHash: baseline, frozenHash: baseline };
    const control = { id: 'G11-' + kind + '-mismatch', gate: 'G11', assetId: evidence.assetId, sourceHash: evidence.sourceHash, expectedFailure: true, detectedFailure: true, measurementBefore: { matches: true, liveHash: baseline, frozenHash: baseline }, measurementAfter: { matches: false, liveHash: changed, frozenHash: baseline } };
    g11.runtimeParity.negativeControls.push(control); evidence.negativeControls.push(control);
  }
}

for (const kind of ['geometry', 'uv', 'material', 'frozenLiveScene']) {
  for (const section of ['row', 'measurementBefore', 'measurementAfter']) {
    for (const field of ['liveHash', 'frozenHash']) {
      for (const variant of ['missing', 'null', 'invalid']) {
        test('G11 ' + kind + ' rejects ' + variant + ' ' + section + '.' + field + ' receipt hash', async t => {
          const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
          const file = path.join(f.root, f.manifest.assets[0].evidence), evidence = JSON.parse(await readFile(file));
          seedAdversarialParityReceipts(evidence);
          const parity = evidence.measurements.G11.runtimeParity;
          const control = parity.negativeControls.find(row => row.id === 'G11-' + kind + '-mismatch');
          const target = section === 'row' ? parity.measurements[kind] : control[section];
          if (variant === 'missing') delete target[field];
          else target[field] = variant === 'null' ? null : 'not-a-sha256';
          await writeFile(file, JSON.stringify(evidence));
          const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
          assert.ok(result.errors.some(error => /byte-copy parity is insufficient/.test(error)), result.errors.join('\n'));
          assert.ok(!result.errors.some(error => /could not be inspected/.test(error)), result.errors.join('\n'));
        });
      }
    }
  }
}

for (const kind of ['geometry', 'uv', 'material', 'frozenLiveScene']) test('G11 ' + kind + ' rejects a coercible nonstring after hash', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const file = path.join(f.root, f.manifest.assets[0].evidence), evidence = JSON.parse(await readFile(file));
  seedAdversarialParityReceipts(evidence);
  const control = evidence.measurements.G11.runtimeParity.negativeControls.find(row => row.id === 'G11-' + kind + '-mismatch');
  control.measurementAfter.liveHash = [control.measurementAfter.liveHash];
  await writeFile(file, JSON.stringify(evidence));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert.ok(result.errors.some(error => /byte-copy parity is insufficient/.test(error)), result.errors.join('\n'));
});

for (const kind of ['geometry', 'uv', 'material', 'frozenLiveScene']) {
  for (const variant of ['case-only-after-mismatch', 'uppercase-bound-row-and-before', 'uppercase-unbound-before']) {
    test('G11 ' + kind + ' rejects ' + variant + ' SHA-256 receipt spelling', async t => {
      const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
      const file = path.join(f.root, f.manifest.assets[0].evidence), evidence = JSON.parse(await readFile(file));
      seedAdversarialParityReceipts(evidence);
      const parity = evidence.measurements.G11.runtimeParity, row = parity.measurements[kind];
      const control = parity.negativeControls.find(item => item.id === 'G11-' + kind + '-mismatch');
      const baseline = row.liveHash, uppercase = baseline.toUpperCase();
      assert.notEqual(uppercase, baseline);
      if (variant === 'case-only-after-mismatch') {
        control.measurementAfter.liveHash = uppercase;
        control.measurementAfter.frozenHash = baseline;
      } else if (variant === 'uppercase-bound-row-and-before') {
        row.liveHash = uppercase; row.frozenHash = uppercase;
        control.measurementBefore.liveHash = uppercase; control.measurementBefore.frozenHash = uppercase;
        control.measurementAfter.liveHash = baseline; control.measurementAfter.frozenHash = uppercase;
      } else {
        control.measurementBefore.liveHash = uppercase;
      }
      await writeFile(file, JSON.stringify(evidence));
      const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
      assert.ok(result.errors.some(error => /byte-copy parity is insufficient/.test(error)), result.errors.join('\n'));
      assert.ok(!result.errors.some(error => /could not be inspected/.test(error)), result.errors.join('\n'));
    });
  }
}

for (const kind of ['geometry', 'uv', 'material', 'frozenLiveScene']) {
  for (const [label, terminator] of [['LF', '\n'], ['CR', '\r'], ['CRLF', '\r\n'], ['line-separator', '\u2028'], ['paragraph-separator', '\u2029']]) {
    test('G11 ' + kind + ' rejects trailing ' + label + ' digest spelling mismatch', async t => {
      const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
      const file = path.join(f.root, f.manifest.assets[0].evidence), evidence = JSON.parse(await readFile(file));
      seedAdversarialParityReceipts(evidence);
      const control = evidence.measurements.G11.runtimeParity.negativeControls.find(item => item.id === 'G11-' + kind + '-mismatch');
      control.measurementAfter.liveHash = control.measurementBefore.liveHash + terminator;
      control.measurementAfter.frozenHash = control.measurementBefore.frozenHash;
      await writeFile(file, JSON.stringify(evidence));
      const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
      assert.ok(result.errors.some(error => /byte-copy parity is insufficient/.test(error)), result.errors.join('\n'));
      assert.ok(!result.errors.some(error => /could not be inspected/.test(error)), result.errors.join('\n'));
    });
  }
}
