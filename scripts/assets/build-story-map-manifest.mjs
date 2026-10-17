#!/usr/bin/env node
// Generates asset-source/playtests/{grove,moonpine,mistveil}.json (the canopy.json schema) for the three story-map playtests from the
// measured runtime GLBs and clips reports: sha256 hashes, coordinateTransform scale / originOffset from the real bounds so every
// asset's base sits on y = 0 at its stated size, castSocketBone, per-slot clip mappings and in-place rootMotion entries.
//
// The id set is not typed in here: scripts/assets/story-map-required-assets.ts (run with Bun) derives from the real playtest region
// variant exactly what the asset gate in src/app/GameApplication.ts requires, the builder checks its manifest against that set, and
// monster / NPC actor ids come from the region entities and the trial monsterIds. Entries for the shared kit (actor-aren, trial gate,
// glaive, Yara kit, staff) and the reused Greenwake / Canopy props are carried verbatim from greenwake.json / canopy.json.
//
// Usage: BUN=/path/to/bun node scripts/assets/build-story-map-manifest.mjs --map=grove|moonpine|mistveil [--out=<path>]
// (BUN defaults to `bun` on PATH). Fails with the list of missing runtime assets while a map's models are still being produced.
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, carriedFrom, environmentEntry, monsterEntry, propEntry, read } from './playtest-manifest-kit.mjs';

const Z = { x: 0, y: 0, z: 1 };
/** Native +x front: corrective heading (-1, 0, 0) turns it to +z before simulation yaw. */
const X_FRONT = { x: -1, y: 0, z: 0 };

/**
 * Stated sizes (metres) per new asset; `measure` is the model axis the size refers to (see playtest-manifest-kit.mjs transformFor):
 * y = height, x / z = length along that axis, horizontal = larger ground extent, axis = body length, shoulder = quadruped shoulder height.
 * `forward` is the rotation that turns the model's native front to +z ('head' derives it from the rig's head direction).
 * Prop fronts were read from the contact sheets (tent opening, lookout ladder, temple stair and arch face +z; the root cavern opens along x).
 * `monster: true` entries are characters; `slots` limits a non-combat actor to the clips the engine can request.
 */
const ASSETS = {
  // The Grove
  'prop-heartroot-trunk': { measure: 'y', size: 9, forward: Z },
  'prop-refuge-shelter': { measure: 'horizontal', size: 4, forward: Z },
  'prop-training-post': { measure: 'y', size: 2.5, forward: Z },
  'prop-water-basin': { measure: 'horizontal', size: 4, forward: Z },
  'prop-grove-platform': { measure: 'horizontal', size: 4, forward: Z },
  'actor-koro': { monster: true, rigFamily: 'biped', measure: 'y', size: 1.3, forward: X_FRONT, slots: ['monster-idle', 'monster-walk', 'koro-throw', 'koro-push', 'koro-distract', 'koro-search'] },
  'actor-grove-rootling': { monster: true, rigFamily: 'biped', measure: 'y', size: 1.6, forward: X_FRONT },
  // The blighted twin (scripts/assets/build-grove-blighted-variant.mjs): the rootling's runtime with a darker material, drawn a quarter larger (2.0 m) so the blight reads as a bigger, heavier threat than the 1.6 m sparring partner.
  'actor-grove-blighted-rootling': { monster: true, rigFamily: 'biped', measure: 'y', size: 2, forward: X_FRONT },
  // The Memory Pool guardian dominates the three-quarter camera at 3.5 m (the concept's stated 2.8 m read too small beside the arena's 11 m radius).
  'actor-grove-hollowheart': { monster: true, rigFamily: 'biped', measure: 'y', size: 3.5, forward: X_FRONT },
  // Moonpine Ridge
  'prop-moonpine-tree': { measure: 'y', size: 16, forward: Z },
  'prop-buried-wolf-temple': { measure: 'horizontal', size: 14, forward: Z },
  'prop-temple-chain-anchor': { measure: 'y', size: 2.5, forward: Z },
  'prop-snow-ridge-rock': { measure: 'horizontal', size: 5, forward: Z },
  // The log runs along the model's x axis; forward (+1, 0, 0) turns it onto z (the map code rotates and stretches it to the span).
  'prop-moonpine-log-bridge': { measure: 'x', size: 12, forward: { x: 1, y: 0, z: 0 }, deck: true, lengthAxis: 'x' },
  'actor-frostfang-tracker': { monster: true, rigFamily: 'quadruped', measure: 'shoulder', size: 1.1, forward: 'head' },
  'actor-howl-scout': { monster: true, rigFamily: 'quadruped', measure: 'shoulder', size: 0.9, forward: 'head' },
  'actor-ruun-chained-howl': { monster: true, rigFamily: 'quadruped', measure: 'shoulder', size: 1.6, forward: 'head' },
  // Mistveil Basin
  'prop-mistveil-root-tree': { measure: 'y', size: 14, forward: Z },
  'prop-mistveil-reed-cluster': { measure: 'y', size: 2.5, forward: Z },
  'prop-mire-bank-rock': { measure: 'horizontal', size: 4, forward: Z },
  'prop-hunter-extraction-rig': { measure: 'y', size: 6, forward: Z },
  'prop-black-sap-filter-drum': { measure: 'y', size: 2, forward: Z },
  'prop-root-cavern-mouth': { measure: 'horizontal', size: 8, forward: X_FRONT },
  'actor-bog-lurker': { monster: true, rigFamily: 'quadruped', measure: 'y', size: 1.4, forward: 'head' },
  // Height and wingspan are both stated (2.4 m, 3.6 m): the scale is the geometric mean of the two fits.
  'actor-lantern-heron': { monster: true, rigFamily: 'avian', sizes: [{ measure: 'y', size: 2.4 }, { measure: 'horizontal', size: 3.6 }], forward: X_FRONT },
  'actor-ghor-mire-maw': { monster: true, rigFamily: 'quadruped', measure: 'axis', size: 8, forward: 'head' },
};

/** Entry order per map: [ids built for this map] and [ids carried verbatim]; the environment recipe is first, the Yara kit last. */
const MAPS = {
  grove: {
    carriedFirst: ['actor-aren', 'actor-vara', 'prop-greenwake-root-gate', 'prop-warden-glaive', 'prop-warden-waystone'],
    built: ['actor-koro', 'actor-grove-rootling', 'actor-grove-blighted-rootling', 'actor-grove-hollowheart', 'prop-heartroot-trunk', 'prop-refuge-shelter', 'prop-training-post', 'prop-water-basin', 'prop-grove-platform'],
    carriedProps: ['prop-erya-edge-tree', 'prop-greenwake-boulder-cluster', 'prop-canopy-fern-cluster', 'prop-ancient-canopy-shrine', 'prop-canopy-cliff-rock', 'prop-mire-bank-rock', 'prop-root-cavern-mouth'],
  },
  moonpine: {
    carriedFirst: ['actor-aren', 'actor-vara', 'prop-greenwake-root-gate', 'prop-warden-glaive', 'prop-warden-waystone'],
    built: ['actor-frostfang-tracker', 'actor-howl-scout', 'actor-ruun-chained-howl', 'prop-moonpine-tree', 'prop-buried-wolf-temple', 'prop-temple-chain-anchor', 'prop-snow-ridge-rock', 'prop-moonpine-log-bridge'],
    carriedProps: ['prop-mire-bank-rock'],
  },
  mistveil: {
    carriedFirst: ['actor-aren', 'prop-greenwake-root-gate', 'prop-warden-glaive', 'prop-warden-waystone'],
    built: ['actor-bog-lurker', 'actor-lantern-heron', 'actor-ghor-mire-maw', 'prop-mistveil-root-tree', 'prop-mistveil-reed-cluster', 'prop-mire-bank-rock', 'prop-hunter-extraction-rig', 'prop-black-sap-filter-drum', 'prop-root-cavern-mouth'],
    carriedProps: [],
  },
};
const CARRIED_LAST = ['actor-yara-hero', 'prop-heartroot-focus-staff', 'actor-vesper-hero', 'prop-vesper-katana', 'actor-sakda-hero'];

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const map = option('map');
if (!MAPS[map]) { console.error('Usage: build-story-map-manifest.mjs --map=grove|moonpine|mistveil [--out=<path>]'); process.exit(2); }
const config = MAPS[map];
const revision = 1;

const missing = config.built.filter(id => !existsSync(resolve(ROOT, `asset-source/generated/${id}-runtime-${String(revision).padStart(2, '0')}`, ASSETS[id].monster ? `${id}-animated.glb` : `${id}.glb`)));
if (missing.length) { console.error(`${map}: runtime assets not built yet: ${missing.join(', ')}`); process.exit(1); }

const derived = JSON.parse(execFileSync(process.env.BUN ?? 'bun', [resolve(ROOT, 'scripts/assets/story-map-required-assets.ts'), map], { cwd: ROOT, encoding: 'utf8' }))[map];
const actorIdOf = assetId => {
  const entity = derived.entities.find(candidate => candidate.assetId === assetId);
  if (!entity) throw new Error(`${map}: no region entity uses ${assetId}`);
  const trial = derived.trialMonsters.find(candidate => candidate.assetId === assetId);
  if (trial && trial.monsterId !== entity.actorId) throw new Error(`${map}: trial monsterId ${trial.monsterId} differs from the entity actorId ${entity.actorId}`);
  return entity.actorId;
};

const carried = carriedFrom([read('asset-source/playtests/canopy.json'), read('asset-source/playtests/greenwake.json'), read('asset-source/playtests/mistveil.json')]);
const build = id => {
  const spec = { ...ASSETS[id], revision };
  return spec.monster ? monsterEntry(id, { ...spec, actorId: actorIdOf(id) }) : propEntry(id, spec);
};
const manifest = [
  environmentEntry(derived.environmentId, derived.componentAssetIds),
  ...config.carriedFirst.map(carried),
  ...config.built.filter(id => ASSETS[id].monster).map(build),
  ...config.built.filter(id => !ASSETS[id].monster).map(build),
  ...config.carriedProps.map(carried),
  ...CARRIED_LAST.map(carried),
];

const ids = manifest.map(entry => entry.id);
const expected = derived.required;
const extra = ids.filter(id => !expected.includes(id)), absent = expected.filter(id => !ids.includes(id));
if (extra.length || absent.length || new Set(ids).size !== ids.length) throw new Error(`${map}: manifest ids differ from the gate's required set (extra: ${extra.join(', ') || '-'}; missing: ${absent.join(', ') || '-'})`);

const out = option('out') ?? `asset-source/playtests/${map}.json`;
writeFileSync(resolve(ROOT, out), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest.filter(entry => ASSETS[entry.id]).map(entry => ({ id: entry.id, actorId: entry.actorId, ...entry.coordinateTransform })), null, 1));
