#!/usr/bin/env node
// Packages the later-chapter native candidates. Sizes are art-direction targets; the shared builder measures each real
// GLB/rig to derive scale, base offset, hashes and clip mappings. Missing artifacts fail closed. Nothing becomes verified.
//
// prop-migration-gate: the only later-chapter prop with a real opening interaction. The shared propEntry reads the
// original single-mesh native GLB; we instead point this entry at the partitioned articulated GLB that
// author-migration-gate.mjs produced (frame + panel primitives, migration_gate_panel node with
// closedTranslation / openTranslation extras). The original coordinateTransform (forward / scale /
// originOffset) is preserved verbatim — main applies the open/closed pose atomically with its collider
// update. evidenceStatus remains 'blocked'; physical passage and user acceptance are not inferred
// from the panel's selected bounds.
//
// Usage: node scripts/assets/build-later-chapter-manifest.mjs [--out=<path>]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, environmentEntry, monsterEntry, propEntry, read, sha256 } from './playtest-manifest-kit.mjs';

const Z = { x: 0, y: 0, z: 1 };
// Native multiview inspection: these asymmetric props face +X; the loader needs a -90° yaw to face +Z.
const FROM_X = { x: -1, y: 0, z: 0 };
const revision = 1;
export const ASSETS = {
  'actor-luma': { monster: true, rigFamily: 'quadruped', actorId: 'luma', measure: 'shoulder', size: 0.95, forward: 'head' },
  'actor-sable': { monster: true, rigFamily: 'quadruped', actorId: 'sable', measure: 'shoulder', size: 1.05, forward: 'head' },
  'actor-nyra': { monster: true, rigFamily: 'quadruped', actorId: 'nyra', measure: 'shoulder', size: 0.95, forward: 'head' },
  'actor-solkar': { monster: true, rigFamily: 'quadruped', actorId: 'solkar', measure: 'shoulder', size: 1.35, forward: 'head' },
  'actor-orun': { monster: true, rigFamily: 'biped', actorId: 'orun', measure: 'y', size: 2.1, forward: 'head', extras: ['orun-root-tether', 'orun-back-handspring', 'orun-cartwheel-counter'] },
  'actor-orun-crowned-beast': { monster: true, rigFamily: 'quadruped', actorId: 'orun', measure: 'shoulder', size: 3.2, forward: 'head' },
  'actor-council-envoy': { monster: true, rigFamily: 'quadruped', actorId: 'council-envoy', measure: 'shoulder', size: 1.05, forward: 'head' },
  'prop-sunmane-stone-terrace': { measure: 'horizontal', size: 12, forward: Z },
  'prop-migration-gate': { measure: 'horizontal', size: 8, forward: FROM_X },
  'prop-water-allotment-gate': { measure: 'horizontal', size: 5, forward: FROM_X },
  'prop-plains-stone-arch': { measure: 'y', size: 8, forward: FROM_X },
  'prop-savanna-acacia': { measure: 'y', size: 9, forward: Z },
  'prop-map-table': { measure: 'horizontal', size: 2.4, forward: Z },
  'prop-heartroot-fragment-stone': { measure: 'y', size: 2.2, forward: FROM_X },
  'prop-heartroot-root-column': { measure: 'y', size: 10, forward: Z },
  'prop-six-fragment-shrine': { measure: 'horizontal', size: 6, forward: Z },
  'prop-root-crown-altar': { measure: 'horizontal', size: 4, forward: Z },
  'prop-hollow-cavern-rock': { measure: 'horizontal', size: 7, forward: FROM_X },
  'prop-root-tether-anchor': { measure: 'y', size: 2.8, forward: FROM_X },
  'prop-bird-nest': { measure: 'horizontal', size: 1.2, forward: Z },
  'prop-seed-supply-basket': { measure: 'horizontal', size: 0.65, forward: Z },
};

const ENVIRONMENTS = {
  'sunmane-expanse-environment': ['prop-sunmane-stone-terrace', 'prop-migration-gate', 'prop-water-allotment-gate', 'prop-plains-stone-arch', 'prop-savanna-acacia'],
  'refuge-environment': ['prop-refuge-shelter', 'prop-map-table', 'prop-training-post', 'prop-heartroot-fragment-stone', 'prop-canopy-fern-cluster', 'prop-water-basin'],
  'heartroot-hollow-environment': ['prop-heartroot-root-column', 'prop-six-fragment-shrine', 'prop-root-crown-altar', 'prop-hollow-cavern-rock', 'prop-root-tether-anchor'],
};
const missing = Object.entries(ASSETS).filter(([id, spec]) => {
  if (id === 'prop-migration-gate') {
    // Native source GLB is still required (the author partitions it); the runtime entry points at the derived GLB.
    return !existsSync(resolve(ROOT, `asset-source/generated/${id}-runtime-01/${id}.glb`))
      || !existsSync(resolve(ROOT, `asset-source/generated/${id}-runtime-01/${id}-articulated.glb`));
  }
  return !existsSync(resolve(ROOT, `asset-source/generated/${id}-runtime-01/${id}${spec.monster ? '-animated' : ''}.glb`));
}).map(([id]) => id);
if (missing.length) throw new Error(`Later-chapter runtime assets not built: ${missing.join(', ')}`);
// prop-migration-gate is built as an articulated GLB; the propEntry helper still drives every other prop.
const MIGRATION_ARTICULATED = 'asset-source/generated/prop-migration-gate-runtime-01/prop-migration-gate-articulated.glb';
const MIGRATION_PROVENANCE = 'asset-source/generated/prop-migration-gate-runtime-01/provenance-articulated.json';
const migrationRuntimeHash = sha256(MIGRATION_ARTICULATED);
const migrationProvenance = JSON.parse(readFileSync(resolve(ROOT, MIGRATION_PROVENANCE), 'utf8'));
const manifest = [
  ...Object.entries(ENVIRONMENTS).map(([id, components]) => environmentEntry(id, [...components].sort())),
  ...Object.entries(ASSETS).map(([id, spec]) => {
    if (id === 'prop-migration-gate') {
      // Use the standard propEntry so scale / forward / originOffset are derived from the same provenanced bounds,
      // then redirect runtimeUrl / outputHash / provenance / tripoSourceTask to the articulated artifact and its
      // provenance. The native material, every triangle/UV and the asset transform are unchanged.
      const entry = propEntry(id, { ...spec, revision });
      entry.runtimeUrl = `/${MIGRATION_ARTICULATED}`;
      entry.outputHash = migrationRuntimeHash;
      entry.provenance = MIGRATION_PROVENANCE;
      entry.tripoSourceTask = migrationProvenance.tasks.model;
      entry.evidenceStatus = 'blocked'; // never verified; blocker documented in MIGRATION_PROVENANCE
      return entry;
    }
    if (!spec.monster) return propEntry(id, { ...spec, revision });
    const entry = monsterEntry(id, { ...spec, revision });
    if (spec.extras) {
      const report = read(`asset-source/generated/${id}-runtime-01/clips-report.json`);
      for (const action of spec.extras) {
        const native = report.slots[action]?.clip;
        if (!native) throw new Error(`${id}: missing authored ${action} clip`);
        entry.actionToClipMapping[action] = native;
        entry.rootMotion[action] = { mode: 'in-place', evidenceStatus: 'verified' };
      }
    }
    return entry;
  }),
];
// Unnamed wildlife reuse native meshes, never the canonical companion identities or presence.
for (const [id, sourceId] of [["ridge-elder-scout", "actor-sable"], ["ridge-young-scout", "actor-luma"]]) {
  const source = manifest.find(entry => entry.id === sourceId);
  if (!source) throw new Error(`Missing native scout source: ${sourceId}`);
  manifest.push({ ...source, id: `actor-${id}`, actorId: id });
}
// Pinned to the OLD hornbill model + generated idle (Vara's production harpy-eagle native rig in
// actor-vara-harpy-runtime-01 replaces the canonical actor-vara entry; the roost-hornbill keeps the
// pre-harpy rig and the original procedural idle profile so the roost NPCs in the Moonpine ridge
// and late-act camps still look like the avian the art direction shipped for those scenes).
const ROOST_HORNBILL = {
  id: 'actor-roost-hornbill',
  actorId: 'roost-hornbill',
  sourceType: 'native-glb',
  kind: 'character',
  tripoSourceTask: 'a60d75d8-a3e1-4c60-8d23-476157a25dc9',
  runtimeUrl: '/asset-source/generated/actor-vara-rig-01/tripo-out/actor-vara-rig-01-a60d75d8/model.glb',
  outputHash: '82abb2b3c61f33b12e1db7760807e538881be9fd575836b147db3e3e7ca278f4',
  lodIds: [],
  coordinateTransform: { forward: { x: 0, y: 0, z: 1 }, scale: 0.68 },
  requiredActionIds: [],
  actionToClipMapping: {},
  playtestAnimation: {
    rigFamily: 'avian',
    actionIds: ['wild-crown:actor-idle'],
    torsoBoneNames: ['tripo::Spine_1'],
    headBoneName: 'tripo::Head_0',
    wingRootNames: ['bone_11', 'bone_16'],
    wingSecondaryBoneNames: ['bone_12', 'bone_17'],
  },
  sockets: [],
  provenance: 'asset-source/generated/actor-vara-rig-01/tripo-out/actor-vara-rig-01-a60d75d8/provenance.json',
  evidenceStatus: 'blocked',
};
manifest.push(ROOST_HORNBILL);
for (const entry of manifest) if (entry.evidenceStatus !== 'blocked') throw new Error(`${entry.id}: candidate evidence must remain blocked`);
const out = process.argv.find(arg => arg.startsWith('--out='))?.slice(6) ?? 'asset-source/playtests/later.json';
writeFileSync(resolve(ROOT, out), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest.filter(entry => ASSETS[entry.id]).map(entry => ({ id: entry.id, actorId: entry.actorId, ...entry.coordinateTransform })), null, 2));
