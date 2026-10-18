import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const sources = await readJson(join(root, 'asset-source/animation/enemy-attack-sources.json'));
const attacks = (await readJson(join(root, 'src/content/enemy-attack-presentation.json'))).attacks;
const maps = ['greenwake', 'canopy', 'grove', 'moonpine', 'mistveil', 'bamboo', 'later'];
const relative = path => path.replace(/^\//, '');

async function assertExecutableNativeAttacks(entry, artifactRoot) {
  const bytes = await readFile(join(artifactRoot, relative(entry.runtimeUrl)));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.outputHash, `${entry.id}: selected bytes must match the runtime hash`);
  const glb = JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)).trim());
  const clips = new Set(glb.animations.map(animation => animation.name));
  for (const [id, spec] of Object.entries(attacks)) {
    if (!spec.assets.includes(entry.id)) continue;
    const action = `wild-crown:${id}`;
    assert.ok(entry.requiredActionIds.includes(action), `${entry.id}: consumer must require ${action}`);
    assert.equal(entry.actionToClipMapping[action], action, `${entry.id}: ${action} must not resolve to an unrelated generic clip`);
    assert.ok(clips.has(action), `${entry.id}: selected model must execute ${action}`);
  }
}

async function copyInto(temporary, path) {
  const destination = join(temporary, relative(path));
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(join(root, relative(path)), destination);
}

describe('native attack catalog regeneration', () => {
  it('a regenerated Canopy catalog still loads each native attack, including the Sky Echo body', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'wild-crown-native-catalog-'));
    try {
      const out = join(temporary, 'canopy.json');
      execFileSync(process.execPath, ['scripts/assets/build-canopy-manifest.mjs', `--out=${out}`], { cwd: root, timeout: 120_000 });
      const entries = await readJson(out);
      for (const id of ['actor-thornback-howler', 'actor-storm-hornbill', 'actor-mire-viper']) {
        const entry = entries.find(item => item.id === id);
        assert.ok(entry, `${id}: regenerated catalog must retain the combat body`);
        await assertExecutableNativeAttacks(entry, root);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('native rebaking binds canonical Ruun/Ghor catalog IDs as well as physical assets', { timeout: 120_000 }, async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'wild-crown-native-aliases-'));
    const selected = new Set(Object.values(sources.runtimeAliases));
    try {
      await copyInto(temporary, 'scripts/assets/author-enemy-attacks.mjs');
      for (const name of ['creature-rig-kit.mjs', 'author-creature-clips.mjs', 'enemy-attack-poses.mjs', 'author-quadruped-clips.mjs', 'playtest-manifest-kit.mjs']) {
        await symlink(join(root, 'scripts/assets', name), join(temporary, 'scripts/assets', name));
      }
      await mkdir(join(temporary, 'src'), { recursive: true });
      for (const name of ['game', 'rendering']) await symlink(join(root, 'src', name), join(temporary, 'src', name));
      await symlink(join(root, 'node_modules'), join(temporary, 'node_modules'));
      for (const path of ['asset-source/animation/enemy-attack-sources.json', 'src/content/enemy-attack-presentation.json', 'src/content/enemy-native-anchors.json']) await copyInto(temporary, path);
      for (const id of selected) {
        const path = sources.nativeSources[id].runtimeUrl;
        await copyInto(temporary, path);
        await copyInto(temporary, join(dirname(path), 'clips-report.json'));
      }
      for (const map of maps) {
        const path = `asset-source/playtests/${map}.json`;
        const entries = await readJson(join(root, path));
        // Current chapter catalogs use physical IDs; exercise the advertised canonical IDs too.
        for (const [alias, sourceId] of Object.entries(sources.runtimeAliases)) {
          const physical = entries.find(entry => entry.id === sourceId);
          if (physical && !entries.some(entry => entry.id === alias)) entries.push({ ...structuredClone(physical), id: alias });
        }
        for (const entry of entries) {
          const id = sources.runtimeAliases[entry.id] ?? entry.id;
          if (!selected.has(id)) continue;
          // Start from a real, loadable upstream model, before native attack composition.
          const input = sources.nativeSources[id];
          entry.runtimeUrl = input.runtimeUrl;
          entry.outputHash = input.sha256;
          entry.requiredActionIds = entry.requiredActionIds.filter(action => !action.startsWith('wild-crown:'));
          for (const action of Object.keys(entry.actionToClipMapping)) if (action.startsWith('wild-crown:')) delete entry.actionToClipMapping[action];
        }
        await mkdir(dirname(join(temporary, path)), { recursive: true });
        await writeFile(join(temporary, path), JSON.stringify(entries));
      }
      execFileSync('bun', ['scripts/assets/author-enemy-attacks.mjs', ...selected], { cwd: temporary, timeout: 120_000 });
      const seenAliases = new Set();
      for (const map of maps) {
        for (const entry of await readJson(join(temporary, `asset-source/playtests/${map}.json`))) {
          if (!selected.has(sources.runtimeAliases[entry.id] ?? entry.id)) continue;
          await assertExecutableNativeAttacks(entry, temporary);
          if (sources.runtimeAliases[entry.id]) seenAliases.add(entry.id);
        }
      }
      assert.deepEqual([...seenAliases].sort(), Object.keys(sources.runtimeAliases).sort(), 'all registered runtime aliases must remain usable after rebaking');
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
