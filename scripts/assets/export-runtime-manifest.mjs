#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function readConfined(root, relative) {
  if (typeof relative !== "string" || !relative || path.isAbsolute(relative) || relative.includes("\\")) throw new Error("Invalid confined file path");
  const rootReal = await realpath(root), fileReal = await realpath(path.resolve(root, relative));
  const fromRoot = path.relative(rootReal, fileReal);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(".." + path.sep) || path.isAbsolute(fromRoot) || !(await stat(fileReal)).isFile()) throw new Error("File escapes evidence root");
  return readFile(fileReal);
}
export async function exportRuntimeManifest({ projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), sourcePath = path.join(projectRoot, "asset-source/manifest.json"), outputPath = path.join(projectRoot, "public/assets/manifest.json"), checkOnly = false } = {}) {
const source = JSON.parse(await readFile(sourcePath, "utf8"));
if (source.schemaVersion !== 2 || !Array.isArray(source.assets) || !Array.isArray(source.environmentRecipes)) throw new Error("Unsupported asset-source manifest schema");
const ids = new Set(source.assets.map(entry => entry.id));
if (ids.size !== source.assets.length) throw new Error("Duplicate source asset IDs");
const evidenceStatuses = new Set(["not-started", "in-progress", "verified", "blocked"]);
const sha256 = value => createHash("sha256").update(value).digest("hex");
function parseGlbJson(bytes) {
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw new Error("Invalid native GLB framing");
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4); offset += 8;
    if (offset + length > bytes.length) throw new Error("Truncated GLB chunk");
    if (type === 0x4e4f534a) return JSON.parse(bytes.subarray(offset, offset + length).toString("utf8").replace(/\0+$/u, "").trim());
    offset += length;
  }
  throw new Error("GLB has no JSON chunk");
}
const validHash = value => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const publicEntries = [];
for (const sourceEntry of source.assets) {
  const actor = sourceEntry.id.startsWith("actor-");
  const prop = sourceEntry.id.startsWith("prop-");
  if (!actor && !prop) throw new Error("Asset ID must use actor- or prop- namespace: " + sourceEntry.id);
  if (sourceEntry.sourceType !== "native-glb") throw new Error("Native actor/prop must declare native-glb: " + sourceEntry.id);
  if (!evidenceStatuses.has(sourceEntry.evidenceStatus)) throw new Error("Unknown evidenceStatus for " + sourceEntry.id);
  const entry = {
    id: sourceEntry.id,
    sourceType: "native-glb",
    kind: actor ? "character" : "prop",
    nativeGlb: sourceEntry.nativeGlb ?? null,
    runtimeUrl: sourceEntry.runtimeUrl ?? null,
    sourceInputHash: sourceEntry.sourceInputHash ?? null,
    species: sourceEntry.species,
    sourceHash: sourceEntry.sourceHash ?? null,
    outputHash: sourceEntry.outputHash ?? null,
    lodIds: Array.isArray(sourceEntry.lodIds) ? sourceEntry.lodIds : [],
    rigFamily: sourceEntry.rigFamily ?? null,
    requiredActionIds: Array.isArray(sourceEntry.requiredActionIds) ? sourceEntry.requiredActionIds : [],
    actionToClipMapping: sourceEntry.actionToClipMapping && !Array.isArray(sourceEntry.actionToClipMapping) ? sourceEntry.actionToClipMapping : {},
    coordinateTransform: sourceEntry.coordinateTransform ?? null,
    sockets: Array.isArray(sourceEntry.sockets) ? sourceEntry.sockets : [],
    collisionProxyId: sourceEntry.collisionProxyId ?? null,
    provenance: "asset-source/manifest.json#" + sourceEntry.id,
    providerTaskId: sourceEntry.providerTaskId ?? null,
    gates: sourceEntry.gates ?? null,
    evidenceStatus: sourceEntry.evidenceStatus,
    evidence: sourceEntry.evidence ?? null,
    actorId: sourceEntry.actorId,
    variantOf: sourceEntry.variantOf,
    variantId: sourceEntry.variantId,
    phaseIndex: sourceEntry.phaseIndex,
    phaseNumber: sourceEntry.phaseNumber,
    continuedThroughPhaseIndex: sourceEntry.continuedThroughPhaseIndex,
    assetVariants: sourceEntry.assetVariants,
    rootMotion: sourceEntry.rootMotion,
    contacts: sourceEntry.contacts
  };
  if (entry.evidenceStatus === "verified") {
    if (!validHash(entry.outputHash) || entry.sourceHash !== entry.outputHash) throw new Error("Verified native asset requires matching sourceHash/outputHash: " + entry.id);
    const relativeGlb = "assets/" + entry.id + "/" + entry.outputHash + ".glb";
    const expectedUrl = "/" + relativeGlb;
    if (entry.nativeGlb !== relativeGlb || entry.runtimeUrl !== expectedUrl) throw new Error("Verified native asset must use immutable hash URL: " + entry.id);
    const fileBytes = await readConfined(path.join(projectRoot, "public"), relativeGlb);
    if (sha256(fileBytes) !== entry.outputHash) throw new Error("Native GLB SHA-256 mismatch: " + entry.id);
    const gltf = parseGlbJson(fileBytes);
    for (const resource of [...(gltf.buffers || []), ...(gltf.images || [])]) if (resource.uri && !resource.uri.startsWith("data:")) throw new Error("Native GLB has an external resource URI: " + entry.id);
    if (typeof entry.evidence !== "string" || !entry.evidence.startsWith("evidence/assets/") || entry.evidence.includes("..")) throw new Error("Verified asset requires evidence/assets/<id>.json: " + entry.id);
    const evidence = JSON.parse(await readConfined(projectRoot, entry.evidence));
    if (evidence.assetId !== entry.id || evidence.sourceHash !== entry.outputHash || evidence.outputHash !== entry.outputHash || evidence.schemaVersion !== 1) throw new Error("Evidence identity/hash mismatch: " + entry.id);
    if (!validHash(entry.sourceInputHash) || entry.sourceInputHash !== sourceEntry.sourceReference?.sha256 || evidence.sourceInputHash !== entry.sourceInputHash) throw new Error("Evidence sourceInputHash mismatch: " + entry.id);
    const hasRig = Boolean(gltf.skins?.length || gltf.animations?.length);
    const requiredGates = entry.kind === "character" ? ["G1", "G3", "G6", "G10", "G11", "G12"] : hasRig ? ["G1", "G3", "G6", "G10", "G11", ...(gltf.skins?.length ? ["G12"] : [])] : ["G6", "G10", "G11"];
    const gateStatus = gate => typeof evidence.gates?.[gate] === "object" ? evidence.gates[gate]?.status : evidence.gates?.[gate];
    for (const gate of requiredGates) if (gateStatus(gate) !== "passed") throw new Error("Verified asset has unpassed " + gate + ": " + entry.id);
    if (entry.kind === "prop" && !hasRig) for (const gate of ["G1", "G3", "G12"]) if (gateStatus(gate) !== "not-applicable" || !(evidence.notApplicableReasons?.[gate] || evidence.gates[gate]?.reason)) throw new Error("Static prop requires explicit " + gate + " non-applicability: " + entry.id);
    const taskId = entry.providerTaskId ?? entry.provenance?.providerTaskId;
    if (typeof taskId !== "string" || !taskId.trim() || ["G1", "G3", "G6", "G10", "G11", "G12"].some(gate => (typeof entry.gates?.[gate] === "object" ? entry.gates[gate]?.status : entry.gates?.[gate]) !== gateStatus(gate))) throw new Error("Verified asset lacks matching canonical gates/provider provenance: " + entry.id);
    if (!Array.isArray(evidence.pluginChecks) || !Array.isArray(evidence.expectedPluginCheckIds) || !evidence.expectedPluginCheckIds.length) throw new Error("Verified asset must report the complete applicable plugin check set: " + entry.id);
    const reportedChecks = new Set(evidence.pluginChecks.map(check => check.id));
    if (reportedChecks.size !== evidence.expectedPluginCheckIds.length || evidence.pluginChecks.length !== evidence.expectedPluginCheckIds.length || evidence.expectedPluginCheckIds.some(id => !reportedChecks.has(id)) || evidence.pluginChecks.some(check => check.applicable !== false && check.status !== "passed" || check.applicable === false && !check.reason)) throw new Error("Verified asset has missing/unpassed plugin rows: " + entry.id);
    if (!evidence.visualEvidence || evidence.visualEvidence.status !== "passed" || evidence.visualEvidence.outputHash !== entry.outputHash || !Array.isArray(evidence.visualEvidence.files) || !evidence.visualEvidence.files.length) throw new Error("Verified asset requires reviewed current-output visual evidence: " + entry.id);
    for (const image of evidence.visualEvidence.files) {
      if (image.status !== "passed" || image.outputHash !== entry.outputHash || typeof image.path !== "string" || !image.path.startsWith("evidence/assets/") || image.path.includes("..") || !validHash(image.sha256)) throw new Error("Invalid visual evidence record: " + entry.id);
      if (sha256(await readConfined(projectRoot, image.path)) !== image.sha256) throw new Error("Visual evidence hash mismatch: " + entry.id);
    }
    if (entry.kind === "character" && (!evidence.speciesCoverage || evidence.speciesCoverage.status !== "passed" || !evidence.actionCoverage || evidence.actionCoverage.status !== "passed" || evidence.actionCoverage.missingActionIds?.length)) throw new Error("Verified character requires species and full ActionId coverage: " + entry.id);
    if (entry.kind === "character") {
      const required = entry.requiredActionIds || []; const mapping = entry.actionToClipMapping || {};
      const nativeClipNames = new Set((gltf.animations || []).map(clip => clip.name).filter(name => typeof name === "string"));
      if (!required.length || required.some(actionId => typeof mapping[actionId] !== "string" || !nativeClipNames.has(mapping[actionId]))) throw new Error("Verified character has incomplete ActionId-to-native-clip mapping: " + entry.id);
    }
    const controlGates = requiredGates;
    if (!Array.isArray(evidence.negativeControls) || controlGates.some(gate => !evidence.negativeControls.some(control => control.gate === gate && control.expectedFailure === true && control.detectedFailure === true && control.assetId === entry.id && control.sourceHash === entry.outputHash && control.measurementBefore !== undefined && control.measurementAfter !== undefined))) throw new Error("Verified asset has missing/invalid gate negative controls: " + entry.id);
    if (evidence.sourceHash !== entry.outputHash || evidence.outputHash !== entry.outputHash) throw new Error("Evidence source/output hash does not bind exact runtime GLB bytes: " + entry.id);
  } else if (entry.runtimeUrl !== null || entry.nativeGlb !== null || entry.evidence !== null) {
    throw new Error("Unverified native asset must not expose a runtime URL or evidence path: " + entry.id);
  }
  publicEntries.push(entry);
}
for (const recipe of source.environmentRecipes) {
  if (recipe.sourceType !== "composed-recipe" || recipe.id !== recipe.proceduralRecipeId) throw new Error("Environment must be a composed recipe: " + recipe.id);
  if (!Array.isArray(recipe.componentAssetIds) || !recipe.componentAssetIds.length) throw new Error("Composed recipe has no prop assets: " + recipe.id);
  for (const id of recipe.componentAssetIds) if (!ids.has(id) || !id.startsWith("prop-")) throw new Error("Composed recipe references missing non-prop asset: " + id);
  if (recipe.runtimeUrl != null || recipe.nativeGlb != null) throw new Error("Composed recipe must not have a GLB URL: " + recipe.id);
  publicEntries.push({
    id: recipe.id,
    sourceType: "composed-recipe",
    kind: "environment",
    proceduralRecipeId: recipe.proceduralRecipeId,
    componentAssetIds: [...recipe.componentAssetIds],
    requiredActionIds: [],
    actionToClipMapping: {},
    lodIds: [],
    sockets: [],
    provenance: "asset-source/manifest.json#" + recipe.id,
    evidenceStatus: recipe.evidenceStatus,
    runtimeUrl: null,
    nativeGlb: null,
    evidence: recipe.evidence ?? null
  });
}
const runtimeIds = publicEntries.map(entry => entry.id);
if (new Set(runtimeIds).size !== runtimeIds.length) throw new Error("Duplicate normalized runtime asset IDs");
const output = JSON.stringify(publicEntries, null, 2) + "\n";
if (checkOnly) {
  const current = await readFile(outputPath, "utf8");
  if (current !== output) throw new Error("/assets/manifest.json is stale; rerun exporter after source changes");
  console.log("runtime asset manifest verified: " + publicEntries.length + " entries");
} else {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, output, { encoding: "utf8", mode: 0o644 });
  console.log("wrote /assets/manifest.json with " + publicEntries.length + " normalized entries");
}
return publicEntries;
}

if (process.argv[1] && await realpath(fileURLToPath(import.meta.url)) === await realpath(process.argv[1])) await exportRuntimeManifest({ checkOnly: process.argv.includes("--check") });
