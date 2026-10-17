#!/usr/bin/env node
// Generates asset-source/playtests/canopy.json (same schema as greenwake.json) from the measured runtime GLBs:
// sha256 hashes, coordinateTransform scale / originOffset from the real bounds so every asset's base sits on y = 0 at
// its stated size, castSocketBone, per-slot clip mappings and in-place rootMotion entries from the clips reports.
// The entry builders are shared with build-story-map-manifest.mjs (scripts/assets/playtest-manifest-kit.mjs).
// Usage: node scripts/assets/build-canopy-manifest.mjs [--out=<path>]   (default: asset-source/playtests/canopy.json)
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, carriedFrom, environmentEntry, monsterEntry, propEntry, read } from './playtest-manifest-kit.mjs';

const carried = carriedFrom([read('asset-source/playtests/greenwake.json')]);

/**
 * Stated sizes (metres) and the runtime build revision of each new asset. `measure` is the model axis the size refers to:
 * y = height, horizontal = the larger of the two ground axes (wingspan, length, footprint), z = length along +z.
 * `forward` encodes the corrective heading applied on the loader's inner node; the outer actor root owns simulation yaw.
 */
const ASSETS = {
  'actor-thornback-howler': { revision: 1, measure: 'y', size: 1.7, forward: { x: -1, y: 0, z: 0 }, actorId: 'canopy-howler', rigFamily: 'biped' },
  'actor-storm-hornbill': { revision: 1, measure: 'horizontal', size: 3.2, forward: { x: -1, y: 0, z: 0 }, actorId: 'canopy-hornbill', rigFamily: 'avian' },
  'actor-mire-viper': { revision: 1, measure: 'horizontal', size: 7, forward: { x: 0, y: 0, z: -1 }, actorId: 'canopy-mire-viper', rigFamily: 'serpentine' },
  'prop-vine-bridge': { revision: 2, measure: 'z', size: 12, forward: { x: 0, y: 0, z: 1 }, deck: true },
  'prop-ancient-canopy-shrine': { revision: 1, measure: 'horizontal', size: 14, forward: { x: -1, y: 0, z: 0 } },
  'prop-rainforest-canopy-tree': { revision: 1, measure: 'y', size: 22, forward: { x: 0, y: 0, z: 1 } },
  'prop-canopy-cliff-rock': { revision: 1, measure: 'y', size: 6, forward: { x: 0, y: 0, z: 1 } },
  'prop-canopy-fern-cluster': { revision: 1, measure: 'horizontal', size: 2.45, forward: { x: 0, y: 0, z: 1 } },
  'prop-mire-bank-rock': { revision: 1, measure: 'horizontal', size: 4, forward: { x: 0, y: 0, z: 1 } },
};

const regionProps = ['prop-vine-bridge', 'prop-ancient-canopy-shrine', 'prop-rainforest-canopy-tree', 'prop-canopy-cliff-rock', 'prop-canopy-fern-cluster', 'prop-mire-bank-rock'];
const manifest = [
  environmentEntry('whispering-canopy-environment', regionProps),
  carried('actor-aren'), carried('actor-vara'), carried('prop-greenwake-root-gate'), carried('prop-warden-glaive'),
  carried('prop-warden-waystone'),
  ...['actor-thornback-howler', 'actor-storm-hornbill', 'actor-mire-viper'].map(id => monsterEntry(id, ASSETS[id])),
  ...regionProps.map(id => propEntry(id, ASSETS[id])),
  carried('actor-yara-hero'), carried('prop-heartroot-focus-staff'),
  carried('actor-vesper-hero'), carried('prop-vesper-katana'), carried('actor-sakda-hero'),
];
const out = process.argv.find(arg => arg.startsWith('--out='))?.slice(6) ?? 'asset-source/playtests/canopy.json';
writeFileSync(resolve(ROOT, out), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest.filter(entry => entry.coordinateTransform && ASSETS[entry.id]).map(entry => ({ id: entry.id, ...entry.coordinateTransform })), null, 1));
