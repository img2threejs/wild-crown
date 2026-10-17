#!/usr/bin/env node
// Generates asset-source/playtests/bamboo.json (the canopy.json schema) for Blood Bamboo Valley from the measured runtime GLBs and clips
// reports, with the shared entry builders of playtest-manifest-kit.mjs: sha256 hashes, coordinateTransform scale / originOffset from the real
// bounds (base on y = 0 at the stated size), castSocketBone, per-slot clip mappings and in-place rootMotion entries.
// Candidate Chapters and Trials consume this catalog; every asset entry stays evidence `blocked`.
//
// Built here: Koro, the Branchbreaker (boss), Asha, Tali, Marek, the two Ash Hunter camp actors (melee trapper, ranged netter), the bamboo grove, the Ash Hunters' camp, the ancient shrine and the Black Sap
// jaw trap. The remaining environment kit is carried verbatim from the earlier playtest manifests (the hunter cage, rope bridge, bramble wall,
// edge / canopy trees, boulders, ferns, cliff rock, Mistveil's extraction rig, filter drum and root cavern mouth = the tiger den, ...).
//
// Usage: node scripts/assets/build-bamboo-manifest.mjs [--out=<path>]
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, carriedFrom, environmentEntry, monsterEntry, propEntry, read } from './playtest-manifest-kit.mjs';

const Z = { x: 0, y: 0, z: 1 };
/** Native +x front: corrective heading (-1, 0, 0) turns it to +z before simulation yaw. */
const X_FRONT = { x: -1, y: 0, z: 0 };
const revision = 1;

/**
 * Stated sizes (metres); `measure` as in playtest-manifest-kit.mjs transformFor. `extras` are authored clips that are not monster slots: the action id
 * maps to the clip of the same name. Prop fronts were read from the contact sheets (the shrine stairs and the camp tent gables face native +x).
 */
export const ASSETS = {
  // Chapter 1 boss form: the ally `actor-koro` (Grove) stands 1.3 m; the thorn-driven boss is broader and drawn 1.5 m.
  'actor-koro-branchbreaker': { monster: true, rigFamily: 'biped', actorId: 'bamboo-koro-branchbreaker', measure: 'y', size: 1.5, forward: X_FRONT },
  // Asha: 1.1 m at the shoulder (the concept's stated size); phase attacks, cleanse and bond are extras on top of the 13 monster slots.
  'actor-asha': {
    monster: true, rigFamily: 'quadruped', actorId: 'bamboo-asha', measure: 'shoulder', size: 1.1, forward: 'head',
    extras: ['asha-stalk', 'asha-corrupted-idle', 'asha-stalk-pounce', 'asha-corrupt-slam', 'asha-bamboo-charge', 'asha-cleanse', 'asha-bond-idle'],
  },
  // Tali is a cub: half a metre at the shoulder, not a scaled-down adult (her own model and rig).
  'actor-tali': { monster: true, rigFamily: 'quadruped', actorId: 'bamboo-tali', measure: 'shoulder', size: 0.5, forward: 'head', extras: ['tali-play', 'tali-nuzzle'] },
  // Marek: 1.78 m; the conversation kit (idle, walk, run, jump, hurt, turn, dive, death, spawn) plus four talking idles.
  'actor-marek': {
    monster: true, rigFamily: 'biped', actorId: 'bamboo-marek', measure: 'y', size: 1.78, forward: X_FRONT,
    slots: ['monster-idle', 'monster-walk', 'monster-run', 'monster-jump', 'monster-hurt', 'monster-turn', 'monster-dive'],
    extras: ['npc-talk-relaxed', 'npc-talk-explain', 'npc-talk-point', 'npc-talk-guarded'],
  },
  // The Ash Hunters of the camp (Wave 2): the melee trapper is 1.85 m at the head (the pole tip makes the bounds 0.982 tall, so size 1.894), the ranged netter 1.72 m. Monster slots
  // idle / walk / run / hurt / turn plus the attack (slash | shoot), death = the knockdown, spawn = the get-up; extras are the non-lethal subdue + kneel idle (and the melee spear jab).
  'actor-camp-hunter-melee': {
    monster: true, rigFamily: 'biped', actorId: 'bamboo-camp-hunter-melee', measure: 'y', size: 1.894, forward: X_FRONT,
    slots: ['monster-idle', 'monster-walk', 'monster-run', 'monster-slash', 'monster-hurt', 'monster-turn'],
    extras: ['hunter-thrust', 'hunter-subdue', 'hunter-kneel-idle'],
  },
  'actor-camp-hunter-ranged': {
    monster: true, rigFamily: 'biped', actorId: 'bamboo-camp-hunter-ranged', measure: 'y', size: 1.72, forward: X_FRONT,
    slots: ['monster-idle', 'monster-walk', 'monster-run', 'monster-shoot', 'monster-hurt', 'monster-turn'],
    extras: ['hunter-subdue', 'hunter-kneel-idle'],
  },
  'prop-bamboo-grove-cluster': { measure: 'y', size: 9, forward: Z },
  'prop-hunter-camp': { measure: 'horizontal', size: 8, forward: X_FRONT },
  'prop-ancient-bamboo-shrine': { measure: 'horizontal', size: 7, forward: X_FRONT },
  'prop-black-sap-jaw-trap': { measure: 'horizontal', size: 1.2, forward: Z },
};

const BUILT = ['actor-koro-branchbreaker', 'actor-asha', 'actor-tali', 'actor-marek', 'actor-camp-hunter-melee', 'actor-camp-hunter-ranged', 'prop-bamboo-grove-cluster', 'prop-hunter-camp', 'prop-ancient-bamboo-shrine', 'prop-black-sap-jaw-trap'];
const CARRIED_FIRST = ['actor-aren', 'actor-vara', 'prop-greenwake-root-gate', 'prop-warden-glaive', 'prop-warden-waystone', 'actor-koro'];
const CARRIED_PROPS = [
  'prop-erya-edge-tree', 'prop-rainforest-canopy-tree', 'prop-greenwake-boulder-cluster', 'prop-canopy-cliff-rock', 'prop-mire-bank-rock', 'prop-canopy-fern-cluster',
  'prop-greenwake-rope-bridge', 'prop-hunter-cage', 'prop-greenwake-bramble-wall', 'prop-root-arch', 'prop-hunter-extraction-rig', 'prop-black-sap-filter-drum', 'prop-root-cavern-mouth',
];
const CARRIED_LAST = ['actor-yara-hero', 'prop-heartroot-focus-staff', 'actor-vesper-hero', 'prop-vesper-katana', 'actor-sakda-hero'];
const ENVIRONMENT_ID = 'blood-bamboo-valley-environment';

const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

const missing = BUILT.filter(id => !existsSync(resolve(ROOT, `asset-source/generated/${id}-runtime-${String(revision).padStart(2, '0')}`, ASSETS[id].monster ? `${id}-animated.glb` : `${id}.glb`)));
if (missing.length) { console.error(`bamboo: runtime assets not built yet: ${missing.join(', ')}`); process.exit(1); }

const carried = carriedFrom(['canopy', 'greenwake', 'grove', 'mistveil', 'moonpine'].map(name => read(`asset-source/playtests/${name}.json`)));
const build = id => {
  const spec = { ...ASSETS[id], revision };
  if (!spec.monster) return propEntry(id, spec);
  const entry = monsterEntry(id, spec);
  const dir = `asset-source/generated/${id}-runtime-${String(revision).padStart(2, '0')}`, report = read(`${dir}/clips-report.json`);
  for (const action of spec.extras ?? []) {
    const clip = report.slots?.[action]?.clip ?? (report.clips?.[action] ? action : undefined);
    if (!clip) throw new Error(`${id}: clips-report has no ${action}`);
    entry.actionToClipMapping[action] = clip;
    entry.rootMotion[action] = { mode: 'in-place', evidenceStatus: 'verified' };
  }
  return entry;
};

const props = [...BUILT.filter(id => !ASSETS[id].monster), ...CARRIED_PROPS];
const manifest = [
  environmentEntry(ENVIRONMENT_ID, [...props].sort()),
  ...CARRIED_FIRST.map(carried),
  ...BUILT.filter(id => ASSETS[id].monster).map(build),
  { ...build('actor-tali'), id: 'actor-nursery-cub', actorId: 'nursery-cub' },
  ...BUILT.filter(id => !ASSETS[id].monster).map(build),
  ...CARRIED_PROPS.map(carried),
  ...CARRIED_LAST.map(carried),
];

const ids = manifest.map(entry => entry.id);
if (new Set(ids).size !== ids.length) throw new Error(`bamboo: duplicate manifest ids ${ids.filter((id, i) => ids.indexOf(id) !== i).join(', ')}`);
for (const entry of manifest) if (entry.evidenceStatus !== 'blocked') throw new Error(`bamboo: ${entry.id} must stay evidence-blocked`);

const out = option('out') ?? 'asset-source/playtests/bamboo.json';
writeFileSync(resolve(ROOT, out), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest.filter(entry => ASSETS[entry.id]).map(entry => ({ id: entry.id, actorId: entry.actorId, ...entry.coordinateTransform })), null, 1));
