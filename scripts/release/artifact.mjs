import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const ignored = new Set(['release-manifest.json']);
const MIME = new Map([['.html', 'text/html'], ['.js', 'text/javascript'], ['.mjs', 'text/javascript'], ['.css', 'text/css'], ['.json', 'application/json'], ['.glb', 'model/gltf-binary'], ['.gltf', 'model/gltf+json'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.svg', 'image/svg+xml'], ['.mp3', 'audio/mpeg'], ['.ogg', 'audio/ogg'], ['.wav', 'audio/wav']]);
const mime = (name) => MIME.get(path.extname(name).toLowerCase()) ?? 'application/octet-stream';

export async function createArtifact({ dist, compatibilityFile, benchmarkFile, previousArtifact }) {
  const distRoot = path.resolve(dist);
  const expectedCompatibilityFile = path.join(distRoot, 'release-compatibility.json');
  if (path.resolve(compatibilityFile) !== expectedCompatibilityFile) throw new Error('Compatibility metadata must come from emitted dist/release-compatibility.json.');
  const compatibilityStat = await fs.lstat(expectedCompatibilityFile);
  if (!compatibilityStat.isFile() || compatibilityStat.isSymbolicLink()) throw new Error('Compatibility metadata must be a regular emitted dist file, not a symlink.');
  const compatibilityBytes = await fs.readFile(expectedCompatibilityFile);
  const compatibility = JSON.parse(compatibilityBytes.toString('utf8'));
  if (!Number.isInteger(compatibility.buildSchema) || !Number.isInteger(compatibility.saveSchema) || typeof compatibility.authority !== 'string' || !compatibility.authority.trim()) {
    throw new Error('release-compatibility.json must be derived from actual authoritative exports and contain integer buildSchema/saveSchema plus authority.');
  }
  const inventory = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const file = path.relative(distRoot, full).split(path.sep).join('/');
        if (ignored.has(file)) continue;
        const bytes = await fs.readFile(full);
        inventory.push({ path: file, bytes: bytes.length, sha256: sha256(bytes), mime: mime(file) });
      }
    }
  }
  await walk(distRoot);
  inventory.sort((a,b) => a.path.localeCompare(b.path));
  const compatibilityInventory = inventory.find((entry) => entry.path === 'release-compatibility.json');
  if (!compatibilityInventory || compatibilityInventory.bytes !== compatibilityBytes.byteLength || compatibilityInventory.sha256 !== sha256(compatibilityBytes)) throw new Error('Compatibility values are not bound to the emitted dist file inventory.');
  const identity = sha256(JSON.stringify(inventory));
  const benchmarkBytes = await fs.readFile(benchmarkFile);
  const benchmark = JSON.parse(benchmarkBytes.toString('utf8'));
  if (benchmark.schemaVersion !== 1 || benchmark.buildIdentity !== identity) throw new Error('Benchmark evidence does not identify this emitted build inventory.');
  const benchmarkEvidence = { path: path.relative(process.cwd(), benchmarkFile).split(path.sep).join('/'), bytes: benchmarkBytes.length, sha256: sha256(benchmarkBytes) };
  let rollback = null;
  if (previousArtifact) {
    const previous = JSON.parse(await fs.readFile(previousArtifact, 'utf8'));
    if (typeof previous.identity !== 'string' || !HASH.test(previous.identity)) throw new Error('Previous artifact has no valid artifact identity.');
    rollback = { artifactIdentity: previous.identity, buildSchema: previous.compatibility?.buildSchema ?? null, saveSchema: previous.compatibility?.saveSchema ?? null, exercised: false };
  }
  return { format: 'wild-crown-release-artifact', version: 1, identity, compatibility: { buildSchema: compatibility.buildSchema, saveSchema: compatibility.saveSchema, authority: compatibility.authority }, benchmarkEvidence, rollback, inventory };
}
const HASH = /^[a-f0-9]{64}$/i;

async function main() {
  const args = process.argv.slice(2);
  const get = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
  const dist = path.resolve(get('--dist', 'dist'));
  const compatibilityFile = path.resolve(get('--compatibility', path.join(dist, 'release-compatibility.json')));
  const output = path.resolve(get('--output', path.join(dist, 'release-manifest.json')));
  const previousArtifact = args.includes('--previous') ? path.resolve(get('--previous', '')) : null;
  const benchmarkFile = path.resolve(get('--benchmarks', 'evidence/release/benchmarks.json'));
  const manifest = await createArtifact({ dist, compatibilityFile, benchmarkFile, previousArtifact });
  await fs.writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'w' });
  process.stdout.write(`Release artifact ${manifest.identity} written to ${path.relative(process.cwd(), output)} (${manifest.inventory.length} files). Rollback exercised: no.\n`);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(`Artifact generation failed: ${error.message}`); process.exitCode = 1; });
