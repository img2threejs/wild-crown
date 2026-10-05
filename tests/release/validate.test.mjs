import test from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectAssets, verifyPreview } from '../../scripts/release/validate.mjs';

const digest = (data) => createHash('sha256').update(data).digest('hex');
function minimalTriangleGlb() {
  const positions = Buffer.alloc(36);
  [[0, 0, 0], [1, 0, 0], [0, 1, 0]].flat().forEach((value, index) => positions.writeFloatLE(value, index * 4));
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0', extras: { wildCrownStaticVisibilityPolicy: { version: 1, policyId: 'prop-fixture-policy', assetId: 'prop-fixture', requiredMeshNodes: [{ nodeIndex: 0, minimumVisiblePixels: 1, minimumVisibleViews: 1 }], excludedMeshNodes: [] } } }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ name: 'triangle', primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }], materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.3, 0.4, 0.2, 1] } }], buffers: [{ byteLength: positions.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.length, target: 34962 }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }] }));
  const jsonPadding = Buffer.alloc((4 - json.length % 4) % 4, 0x20);
  const jsonChunk = Buffer.concat([json, jsonPadding]);
  const binPadding = Buffer.alloc((4 - positions.length % 4) % 4);
  const binChunk = Buffer.concat([positions, binPadding]);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const header = Buffer.alloc(12); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(total, 8);
  const jsonHeader = Buffer.alloc(8); jsonHeader.writeUInt32LE(jsonChunk.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(binChunk.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
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
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wild-crown-release-test-'));
  const dist = path.join(root, 'dist');
  const evidenceRoot = path.join(root, 'evidence');
  await mkdir(path.join(dist, 'assets'), { recursive: true });
  await mkdir(path.join(evidenceRoot, 'assets'), { recursive: true });
  await mkdir(path.join(root, 'docs/implementation'), { recursive: true });
  for (const name of ['reference-profile.json', 'BENCHMARK-ROUTES.md']) await writeFile(path.join(root, 'docs/implementation', name), await readFile(path.resolve(process.cwd(), 'docs/implementation', name)));
  await mkdir(path.join(evidenceRoot, 'release'), { recursive: true });
  const glb = minimalTriangleGlb();
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
  const staticPolicyRow = { nodeIndex: 0, minimumVisiblePixels: 1, minimumVisibleViews: 1 };
  const gates = { G1: 'not-applicable', G3: 'not-applicable', G6: 'passed', G10: 'passed', G11: 'passed', G12: 'not-applicable' };
  const negativeControls = [
    { id: 'G6-hidden-static-mesh:0', gate: 'G6', assetId: 'prop-fixture', sourceHash, expectedFailure: true, detectedFailure: true, measurementBefore: { nodeIndex: 0, nodeName: '(unnamed)', meshIndex: 0, minimumVisiblePixels: 1, minimumVisibleViews: 1, visiblePixelsByView: [1], visibleViews: 1, vertexCount: 3 }, measurementAfter: { nodeIndex: 0, nodeName: '(unnamed)', meshIndex: 0, minimumVisiblePixels: 1, minimumVisibleViews: 1, visiblePixelsByView: [0], visibleViews: 0, vertexCount: 3 } },
    { id: 'G10-static-bounds-corruption:0', gate: 'G10', assetId: 'prop-fixture', sourceHash, expectedFailure: true, detectedFailure: true, measurementBefore: { nodeIndex: 0, finitePositionCount: 3, bounds: { min: [0, 0, 0], max: [1, 1, 0] } }, measurementAfter: { nodeIndex: 0, finitePositionCount: 0, accepted: false, injectedFault: 'non-finite-position' } },
    { id: 'G10-wrong-culling-bounds:0', gate: 'G10', assetId: 'prop-fixture', sourceHash, expectedFailure: true, detectedFailure: true, measurementBefore: { nodeIndex: 0, measuredLocalBounds: { min: [0, 0, 0], max: [1, 1, 0] }, cachedLocalBounds: { min: [0, 0, 0], max: [1, 1, 0] }, accessorDeclaredLocalBounds: { min: [0, 0, 0], max: [1, 1, 0] } }, measurementAfter: { nodeIndex: 0, measuredLocalBounds: { min: [0, 0, 0], max: [1, 1, 0] }, corruptedCullBounds: { min: [2, 0, 0], max: [3, 1, 0] }, corruptionOffset: [2, 0, 0], boundsMatch: false } },
  ];
  const propEvidence = {
    schemaVersion: 1, assetId: 'prop-fixture', sourceInputHash, sourceHash, outputHash: sourceHash, gates,
    notApplicableReasons: { G1: 'static prop has no authored clip/skin', G3: 'static prop has no authored clip/skin', G12: 'static prop has no skin' },
    expectedPluginCheckIds: ['G6-visibility', 'G10-geometry', 'G11-freeze'],
    pluginChecks: [{ id: 'G6-visibility', gate: 'G6', status: 'passed' }, { id: 'G10-geometry', gate: 'G10', status: 'passed' }, { id: 'G11-freeze', gate: 'G11', status: 'passed' }],
    negativeControls,
    measurements: {
      G6: { status: 'measurement-complete-review-required', policyId: 'prop-fixture-policy', requiredMeshNodes: [staticPolicyRow], excludedMeshNodes: [], excludedNodeMeasurements: [], meshInventory: [{ nodeIndex: 0, nodeName: '(unnamed)', meshIndex: 0, visible: true, alphaVisible: true, primitiveCount: 1, vertexCount: 3, indexCount: 0, materialCount: 1 }], renderedCoverage: [{ viewId: 'front', pixelCount: 1 }] },
      G10: { status: 'measurement-complete-review-required', staticGeometry: { meshNodes: [{ nodeIndex: 0, meshNodeName: '(unnamed)', meshIndex: 0, primitiveCount: 1, primitiveIndices: [0], vertexCount: 3, finitePositionCount: 3, nonFinitePositionCount: 0, indexCount: 0, invalidIndexCount: 0, materialCount: 1, materialIndices: [0], materialRefsValid: true, measuredLocalBounds: { min: [0, 0, 0], max: [1, 1, 0] }, accessorDeclaredLocalBounds: { min: [0, 0, 0], max: [1, 1, 0] }, cachedLocalBounds: { min: [0, 0, 0], max: [1, 1, 0] }, cachedBoundsDelta: { min: [0, 0, 0], max: [0, 0, 0], maxAbs: 0 }, accessorBoundsDelta: { min: [0, 0, 0], max: [0, 0, 0], maxAbs: 0 }, cachedBoundsMatch: true, accessorBoundsMatch: true, boundsCompareMode: 'float32-exact', measuredWorldBounds: { min: [0, 0, 0], max: [1, 1, 0] }, negativeControlIds: ['G10-static-bounds-corruption:0', 'G10-wrong-culling-bounds:0'] }], sceneBounds: { min: [0, 0, 0], max: [1, 1, 0], size: [1, 1, 0] }, externalResources: [] } },
      G11: { status: 'measurement-complete-review-required', derivativeHash: sourceHash, frozenHash: sourceHash, parity: true, negativeControl: { id: 'G11-byte-flip', expectedFailure: true, detectedFailure: true, measurementBefore: { hash: sourceHash }, measurementAfter: { hash: digest(Buffer.from('byte-flipped copy')) } } },
    },
    visualEvidence: { status: 'passed', outputHash: sourceHash, files: [{ path: visualPath, sha256: digest(visualBytes), outputHash: sourceHash, viewSet: ['front'] }] },
  };
  await writeFile(path.join(root, evidenceFile), JSON.stringify(propEvidence));
  const asset = { id: 'prop-fixture', kind: 'prop', sourceType: 'native-glb', nativeGlb: assetPath, runtimeUrl: '/' + assetPath, sourceInputHash, sourceReference: { sha256: sourceInputHash }, outputHash: sourceHash, sourceHash, providerTaskId: 'fixture-task-1', provenance: { status: 'fixture-only', providerTaskId: 'fixture-task-1' }, evidenceStatus: 'verified', evidence: evidenceFile, gates };
  const recipe = { id: 'environment-fixture', sourceType: 'composed-recipe', proceduralRecipeId: 'environment-fixture', nativeGlb: null, runtimeUrl: null, componentAssetIds: ['prop-fixture'], evidenceStatus: 'verified', evidence: environmentEvidenceFile };
  const manifest = { schemaVersion: 2, manifestVersion: 'test-fixture', assets: [asset], environmentRecipes: [recipe], sourceWorkItems: [{ workId: 'prop-fixture', runtimeAssetId: 'prop-fixture', state: 'complete' }] };
  const manifestPath = path.join(root, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(path.join(dist, 'assets/manifest.json'), JSON.stringify([asset, { ...recipe, kind: 'environment' }]));
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

test('accepts complete isolated fixture and validates actual Vite preview and CLI output', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, repoRoot: f.root });
  assert.deepEqual(result.errors, []);
  const probe = await (await import('node:http')).createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  assert.deepEqual(await verifyPreview(f.dist, result.nativeAssets, port, process.cwd(), f.configFile), []);
  const cli = spawnSync(process.execPath, ['scripts/release/validate.mjs', '--repo', f.root, '--vite-root', process.cwd(), '--dist', f.dist, '--manifest', f.manifestPath, '--benchmarks', f.benchmarkPath, '--config', f.configFile, '--port', String(port)], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).accepted, true);
});

test('validates exporter-derived environment kind without a canonical recipe kind and rejects runtime tampering', async (t) => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }));
  f.manifest.assets = [{ id: 'prop-fixture', kind: 'prop', sourceType: 'native-glb', nativeGlb: null, runtimeUrl: null, evidenceStatus: 'blocked', evidence: null, requiredActionIds: [], actionToClipMapping: {} }];
  Object.assign(f.manifest.environmentRecipes[0], { evidenceStatus: 'blocked', evidence: null });
  assert.equal(Object.hasOwn(f.manifest.environmentRecipes[0], 'kind'), false);
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  const sourcePath = path.join(f.root, 'asset-source/manifest.json');
  const exporterPath = path.join(f.root, 'scripts/assets/export-runtime-manifest.mjs');
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await mkdir(path.dirname(exporterPath), { recursive: true });
  await copyFile(f.manifestPath, sourcePath);
  await copyFile(path.resolve(process.cwd(), 'scripts/assets/export-runtime-manifest.mjs'), exporterPath);
  const exported = spawnSync(process.execPath, [exporterPath], { cwd: f.root, encoding: 'utf8' });
  assert.equal(exported.status, 0, exported.stderr);
  const runtimeManifestPath = path.join(f.root, 'public/assets/manifest.json');
  const runtime = JSON.parse(await readFile(runtimeManifestPath, 'utf8'));
  const recipe = runtime.find((entry) => entry.id === 'environment-fixture');
  assert.equal(recipe.sourceType, 'composed-recipe');
  assert.equal(recipe.kind, 'environment');
  const result = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, runtimeManifestPath, repoRoot: f.root });
  assert.equal(result.errors.some((error) => error.includes('changed canonical sourceType/kind')), false, result.errors.join('\n'));
  assert.equal(result.errors.includes('Environment recipe environment-fixture must retain canonical environment/composed-recipe kind.'), false);
  assert(result.errors.includes('Native asset prop-fixture has no emitted GLB path/runtime URL.'));
  assert(result.errors.includes('Environment recipe environment-fixture has no verified scene qualification evidence.'));

  recipe.kind = 'prop';
  await writeFile(runtimeManifestPath, JSON.stringify(runtime));
  const tampered = await inspectAssets({ dist: f.dist, manifestPath: f.manifestPath, runtimeManifestPath, repoRoot: f.root });
  assert(tampered.errors.includes('Production asset environment-fixture changed canonical sourceType/kind.'));
  assert(tampered.errors.includes('Environment recipe environment-fixture must retain canonical environment/composed-recipe kind.'));
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
