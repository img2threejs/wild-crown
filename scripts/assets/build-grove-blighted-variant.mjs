#!/usr/bin/env node
// Builds the Black Sap-blighted look of the Grove's rootling (stage 2, "Black Sap Incursion") without a new Tripo job: the runtime GLB is the
// authored actor-grove-rootling-animated.glb with ONE change in its glTF JSON, the single material gets a darker, sickly baseColorFactor and a faint toxic
// emissiveFactor (the geometry, skeleton, textures, clips and every animation byte are untouched). The manifest needs a distinct asset id per
// actor (GameRenderer maps manifest.actorId to the region entity), so the variant is its own asset: actor-grove-blighted-rootling, actor grove-blighted.
//
// Usage: node scripts/assets/build-grove-blighted-variant.mjs
//   reads  asset-source/generated/actor-grove-rootling-runtime-01/{actor-grove-rootling-animated.glb,clips-report.json,provenance.json}
//   writes asset-source/generated/actor-grove-blighted-rootling-runtime-01/{actor-grove-blighted-rootling-animated.glb,clips-report.json,provenance.json}
// Deterministic and byte-stable: the same sources always give the same files. Re-run it (then sync-monster-manifest-entries.mjs) whenever the
// rootling's clips are re-authored; tests/rendering/quadruped-clips.test.mjs fails while the variant is stale.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { encodeGlb, parseGlb } from './creature-rig-kit.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const SOURCE = 'actor-grove-rootling', VARIANT = 'actor-grove-blighted-rootling';
/** A much darker, desaturated soot-grey skin under the original texture (a dark silhouette beside the pale practice sprig), and a faint toxic glow from the sap in the cracks. */
export const BASE_COLOR_FACTOR = [0.33, 0.35, 0.32, 1];
export const EMISSIVE_FACTOR = [0.03, 0.075, 0.012];

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const dir = id => resolve(ROOT, 'asset-source/generated', `${id}-runtime-01`);

/** The variant's GLB bytes, clips report and provenance, derived from the rootling's current files; written to disk unless `write` is false. */
export function buildVariant({ write = true } = {}) {
  const sourceDir = dir(SOURCE), targetDir = dir(VARIANT);
  const glb = parseGlb(readFileSync(resolve(sourceDir, `${SOURCE}-animated.glb`)));
  if (glb.json.materials?.length !== 1) throw new Error(`${SOURCE}: expected exactly one material, found ${glb.json.materials?.length ?? 0}`);
  const json = structuredClone(glb.json);
  json.materials[0].pbrMetallicRoughness.baseColorFactor = BASE_COLOR_FACTOR;
  json.materials[0].emissiveFactor = EMISSIVE_FACTOR;
  json.materials[0].name = 'grove_blighted_rootling_material';
  const bytes = encodeGlb(json, glb.bin);

  const report = JSON.parse(readFileSync(resolve(sourceDir, 'clips-report.json'), 'utf8'));
  const provenance = JSON.parse(readFileSync(resolve(sourceDir, 'provenance.json'), 'utf8'));
  const outputPath = `asset-source/generated/${VARIANT}-runtime-01/${VARIANT}-animated.glb`;
  const derivation = {
    from: `asset-source/generated/${SOURCE}-runtime-01/${SOURCE}-animated.glb`,
    fromSha256: report.output.sha256,
    change: 'glTF material baseColorFactor and emissiveFactor only; no new Tripo task, geometry, texture or animation byte differs',
    baseColorFactor: BASE_COLOR_FACTOR, emissiveFactor: EMISSIVE_FACTOR,
    generator: 'scripts/assets/build-grove-blighted-variant.mjs',
  };
  const output = { path: outputPath, sha256: sha256(bytes), bytes: bytes.length };
  const clipsReport = { ...report, assetId: VARIANT, derivedFrom: derivation, output };
  const variantProvenance = { ...provenance, assetId: VARIANT, derivedFrom: derivation, output: { ...provenance.output, ...output } };
  if (write) {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(resolve(ROOT, outputPath), bytes);
    writeFileSync(resolve(targetDir, 'clips-report.json'), JSON.stringify(clipsReport, null, 2) + '\n');
    writeFileSync(resolve(targetDir, 'provenance.json'), JSON.stringify(variantProvenance, null, 2) + '\n');
  }
  return { bytes, clipsReport, provenance: variantProvenance };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { clipsReport } = buildVariant();
  console.log(JSON.stringify({ asset: VARIANT, ...clipsReport.output }));
}
