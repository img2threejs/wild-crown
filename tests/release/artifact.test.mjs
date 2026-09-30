import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createArtifact } from '../../scripts/release/artifact.mjs';

const digest = (data) => createHash('sha256').update(data).digest('hex');

test('builds artifact identity from emitted bytes and preserves rollback compatibility without claiming exercise', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wild-crown-artifact-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = path.join(root, 'dist');
  await mkdir(dist);
  const bytes = Buffer.from('built-output-fixture-only');
  await writeFile(path.join(dist, 'index.html'), bytes);
  const compatibilityFile = path.join(dist, 'release-compatibility.json');
  const compatibilityBytes = Buffer.from(JSON.stringify({ buildSchema: 3, saveSchema: 7, authority: 'test export constants' }));
  await writeFile(compatibilityFile, compatibilityBytes);
  const inventory = [
    { path: 'index.html', bytes: bytes.length, sha256: digest(bytes), mime: 'text/html' },
    { path: 'release-compatibility.json', bytes: compatibilityBytes.length, sha256: digest(compatibilityBytes), mime: 'application/json' },
  ].sort((a, b) => a.path.localeCompare(b.path));
  const benchmarkFile = path.join(root, 'benchmarks.json');
  const benchmarkBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, buildIdentity: digest(JSON.stringify(inventory)) }));
  await writeFile(benchmarkFile, benchmarkBytes);
  const previous = path.join(root, 'previous.json');
  await writeFile(previous, JSON.stringify({ identity: digest('prior actual inventory'), compatibility: { buildSchema: 2, saveSchema: 6 } }));
  const artifact = await createArtifact({ dist, compatibilityFile, benchmarkFile, previousArtifact: previous });
  assert.equal(artifact.benchmarkEvidence.bytes, benchmarkBytes.length);
  assert.equal(artifact.benchmarkEvidence.sha256, digest(benchmarkBytes));
  assert.equal(artifact.inventory.find((entry) => entry.path === 'index.html').sha256, digest(bytes));
  assert.equal(artifact.compatibility.buildSchema, 3);
  assert.equal(artifact.compatibility.saveSchema, 7);
  assert.equal(artifact.rollback.artifactIdentity, digest('prior actual inventory'));
  assert.deepEqual(artifact.rollback, { artifactIdentity: digest('prior actual inventory'), buildSchema: 2, saveSchema: 6, exercised: false });
  assert.equal(artifact.identity, digest(JSON.stringify(inventory)));
});

test('refuses compatibility values without authoritative exports', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wild-crown-artifact-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = path.join(root, 'dist');
  await mkdir(dist);
  const compatibilityFile = path.join(dist, 'release-compatibility.json');
  await writeFile(compatibilityFile, JSON.stringify({ buildSchema: 1, saveSchema: 1 }));
  await assert.rejects(createArtifact({ dist, compatibilityFile }), /actual authoritative exports/);
});

test('refuses compatibility claims sourced outside the emitted build directory', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wild-crown-artifact-compatibility-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = path.join(root, 'dist');
  await mkdir(dist);
  const compatibilityFile = path.join(root, 'external-compatibility.json');
  await writeFile(compatibilityFile, JSON.stringify({ buildSchema: 1, saveSchema: 1, authority: 'not in dist' }));
  await assert.rejects(createArtifact({ dist, compatibilityFile, benchmarkFile: path.join(root, 'benchmarks.json') }), /must come from emitted dist/);
});
