import { measureG1, measureG3, measureG6Visibility, measureG10, inspectSkinIntegrity, measureStaticPropVisibility, measureStaticGeometry } from './measurements.js';
import { measureJointCorrespondence } from './jointCorrespondence.js';

function hash(bytes) {
  return crypto.subtle.digest('SHA-256', bytes).then(value => [...new Uint8Array(value)].map(x => x.toString(16).padStart(2, '0')).join(''));
}
function inventory(root) {
  const meshes = [], bones = [];
  root.traverse(object => {
    if (object.isBone) bones.push({ name: object.name, parent: object.parent?.name || null });
    if (object.isMesh) {
      let attachedToBone = false;
      for (let parent = object.parent; parent; parent = parent.parent) if (parent.isBone) attachedToBone = true;
      meshes.push({ name: object.name || "(unnamed)", type: object.isSkinnedMesh ? "deforming-skinned" : attachedToBone ? "rigid-bone-attached" : "static-scene", bodyPart: object.userData?.gltfExtras?.wildCrownBodyPart || object.userData?.wildCrownBodyPart || null, vertexCount: object.geometry.getAttribute("position")?.count || 0, materialCount: Array.isArray(object.material) ? object.material.length : object.material ? 1 : 0 });
    }
  });
  return { meshes, bones };
}
export async function buildEvidence(gltf, file, digest, assetId, { catalogEntry = null, sourceBytes, renderer, scene, camera, animatedBounds }) {
  const root = gltf.scene;
  const rig = inventory(root);
  const skinIntegrity = inspectSkinIntegrity(root);
  const nativeAnimations = gltf.parser.json.animations || [];
  gltf.animations.forEach((clip, index) => { clip.userData ||= {}; const markers = nativeAnimations[index]?.extras?.markers; if (Array.isArray(markers)) clip.userData.markers = markers; });
  const coveragePolicy = gltf.parser.json.asset?.extras?.wildCrownCoveragePolicy || root.userData?.gltfExtras?.wildCrownCoveragePolicy || null;
  const g1 = measureG1(root, gltf.animations);
  const g3 = measureG3(root, gltf.animations);
  const staticVisibilityPolicy = gltf.parser.json.asset?.extras?.wildCrownStaticVisibilityPolicy || null;
  const staticProp = (catalogEntry?.kind === "prop" || Boolean(staticVisibilityPolicy)) && gltf.animations.length === 0 && skinIntegrity.skinnedMeshCount === 0;
  const g6 = staticProp ? measureStaticPropVisibility(gltf, root, renderer, scene, camera, assetId) : measureG6Visibility(root, coveragePolicy, renderer, scene, camera);
  const g10 = staticProp ? measureStaticGeometry(gltf, root, assetId, digest) : measureG10(root, gltf.animations, g1, animatedBounds);
  const g12 = measureJointCorrespondence(gltf, root, catalogEntry?.kind || null);
  const g12MeasurementStatus = g12.status; g12.status = "incomplete"; g12.measurementStatus = g12MeasurementStatus; g12.missingAcceptanceControls = ["wrong-lod-bind", "full-rig-profile-correspondence-review"];
  const frozenHash = await hash(sourceBytes.slice(0));
  const alteredBytes = sourceBytes.slice(0);
  new Uint8Array(alteredBytes)[0] ^= 1;
  const alteredHash = await hash(alteredBytes);
  const g11 = { status: "incomplete", measurementStatus: frozenHash === digest && alteredHash !== digest ? "byte-copy-parity-measured" : "observed-fail", missingAcceptanceControls: ["runtime-geometry-parity", "uv-parity", "material-identity-parity", "frozen-live-scene-comparison"], runtimeParity: null, derivativeHash: digest, frozenHash, parity: frozenHash === digest, negativeControl: { id: "G11-one-byte-derivative-mismatch", expectedFailure: true, measurementBefore: digest, measurementAfter: alteredHash, detectedFailure: alteredHash !== digest } };
  const gates = { G1: staticProp ? "not-applicable" : g1.status, G3: staticProp ? "not-applicable" : g3.status, G6: g6.status, G10: g10.status, G11: g11.status, G12: staticProp ? "not-applicable" : g12.status };
  const notApplicableReasons = staticProp ? { G1: "static native prop has no animations", G3: "static native prop has no rig or skin", G12: "static native prop has no skeleton joints" } : {};
  const requiredActionIds = catalogEntry?.requiredActionIds || [];
  const actionMap = catalogEntry?.actionToClipMapping || {};
  const loadedClipNames = new Set(gltf.animations.map(clip => clip.name));
  const missingActionIds = requiredActionIds.filter(actionId => { const clipName = actionMap[actionId]; return typeof clipName !== "string" || !loadedClipNames.has(clipName); });
  const actionCoverage = { status: !catalogEntry ? "unassigned" : catalogEntry.kind === "prop" && requiredActionIds.length === 0 ? "not-applicable" : missingActionIds.length ? "incomplete" : "measurement-complete-review-required", requiredActionIds, mappedClipIds: requiredActionIds.filter(id => typeof actionMap[id] === "string").map(id => ({ actionId: id, clipId: actionMap[id] })), missingActionIds };
  const controls = [
    ...(!staticProp ? [{ gate: "G1", ...g1.negativeControl }, { gate: "G3", ...g3.negativeControl }] : []),
    ...g6.negativeControls.map(control => ({ gate: "G6", ...control })),
    ...g10.negativeControls.map(control => ({ gate: "G10", ...control })),
    { gate: "G11", ...g11.negativeControl },
    ...(!staticProp ? g12.negativeControls.map(control => ({ gate: "G12", ...control })) : [])
  ].map(control => ({ ...control, assetId, sourceHash: digest }));
  const applicableGatesMeasured = Object.entries(gates).every(([gate, status]) => status === "measurement-complete-review-required" || (status === "not-applicable" && typeof notApplicableReasons[gate] === "string"));
  return {
    schemaVersion: 1, createdAt: new Date().toISOString(), assetId: assetId || null,
    evidence: assetId ? "evidence/assets/" + assetId + ".json" : null,
    sourceInputHash: catalogEntry?.sourceInputHash ?? null,
    sourceHash: digest, outputHash: frozenHash,
    source: { fileName: file.name, bytes: file.size, sha256: digest },
    loadedScene: { rootName: root.name || null, sceneNodeCount: countNodes(root), ...rig },
    inverseBindAccessors: (gltf.parser.json.skins || []).map(skin => ({ skin: skin.name || null, jointCount: (skin.joints || []).length, inverseBindMatrices: skin.inverseBindMatrices ?? null })),
    skinIntegrity, gates, notApplicableReasons,
    measurements: { G1: g1, G3: g3, G6: g6, G10: g10, G11: g11, G12: g12 },
    negativeControls: controls,
    actionCoverage,
    speciesCoverage: { status: g6.status, measurement: g6 },
    pluginChecks: [], expectedPluginCheckIds: [], pluginAggregate: "not-run",
    visualEvidence: { status: "not-run", outputHash: frozenHash, files: [] },
    evidenceStatus: applicableGatesMeasured ? "measurement-complete-review-required" : "incomplete",
    productionAcceptance: "not-established"
  };
}
function countNodes(root) { let count = 0; root.traverse(() => count++); return count; }
