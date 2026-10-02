import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { measureG1, measureG3, measureG6Visibility, measureG10, inspectSkinIntegrity } from "./measurements.js";
import { measureJointCorrespondence } from "./jointCorrespondence.js";
import { measureStaticPropVisibility, measureStaticGeometry } from "./measurements.js";

const $ = selector => document.querySelector(selector);
const input = $("#model-file"), assetSelect = $("#asset-id"), status = $("#status"), clipSelect = $("#clip-select");
const canvas = $("#viewport"), output = $("#summary"), play = $("#play-clip");
const downloadModel = $("#download-model"), downloadReport = $("#download-report");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x121712, 1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xe8f0dc, 0x333b33, 2.1));
const key = new THREE.DirectionalLight(0xfff1d8, 3.2); key.position.set(4, 7, 5); scene.add(key);
const camera = new THREE.PerspectiveCamera(36, 1, 0.01, 500);
camera.position.set(2.3, 1.7, 3.2);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
const ground = new THREE.GridHelper(10, 20, 0x59614f, 0x363c32); ground.position.y = -0.005; scene.add(ground);
let gltfRoot = null, mixer = null, loaded = null, sourceBytes = null, sourceName = "", report = null, selectedAction = null, skeletonHelper = null, catalogEntries = [];
const loader = new GLTFLoader();
const resize = () => {
  const box = canvas.getBoundingClientRect();
  if (!box.width || !box.height) return;
  renderer.setSize(box.width, box.height, false);
  camera.aspect = box.width / box.height;
  camera.updateProjectionMatrix();
};
new ResizeObserver(resize).observe(canvas);
window.addEventListener("resize", resize);
function hash(bytes) {
  return crypto.subtle.digest("SHA-256", bytes).then(value => [...new Uint8Array(value)].map(x => x.toString(16).padStart(2, "0")).join(""));
}
function setStatus(text, error = false) {
  status.textContent = text;
  status.dataset.kind = error ? "error" : "info";
}
function disposeObject(object) {
  object.traverse(item => {
    if (item.geometry) item.geometry.dispose();
    if (item.material) for (const material of Array.isArray(item.material) ? item.material : [item.material]) material.dispose();
  });
}
function focusModel(root) {
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 0.1);
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(maxDim * 1.7, maxDim * 1.1, maxDim * 2.1));
  camera.near = Math.max(maxDim / 1000, 0.001);
  camera.far = maxDim * 100;
  camera.updateProjectionMatrix();
  controls.update();
}
function round(value) { return Math.round(value * 1e6) / 1e6; }
function animatedBounds(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  const point = new THREE.Vector3();
  let vertices = 0;
  root.traverse(object => {
    if (object.isSkinnedMesh) {
      const pos = object.geometry.getAttribute("position");
      for (let i = 0; i < pos.count; i++) {
        object.getVertexPosition(i, point);
        object.localToWorld(point);
        box.expandByPoint(point);
      }
      vertices += pos.count;
    } else if (object.isMesh) {
      const pos = object.geometry.getAttribute("position");
      for (let i = 0; i < pos.count; i++) {
        point.fromBufferAttribute(pos, i);
        object.localToWorld(point);        box.expandByPoint(point);      }      vertices += pos.count;    }
  });
  return box.isEmpty() ? { min: null, max: null, vertices } : { min: box.min.toArray().map(round), max: box.max.toArray().map(round), vertices };
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
async function buildEvidence(gltf, file, digest, assetId) {
  const root = gltf.scene;
  const catalogEntry = assetId ? catalogEntries.find(entry => entry.id === assetId) || null : null;
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
  const g11 = { status: "incomplete", measurementStatus: frozenHash === digest && alteredHash !== digest ? "byte-copy-parity-measured" : "observed-fail", missingAcceptanceControls: ["runtime-geometry-parity", "uv-parity", "material-identity-parity", "frozen-live-scene-comparison"], derivativeHash: digest, frozenHash, parity: frozenHash === digest, negativeControl: { id: "G11-one-byte-derivative-mismatch", expectedFailure: true, measurementBefore: digest, measurementAfter: alteredHash, detectedFailure: alteredHash !== digest } };
  const gates = { G1: staticProp ? "not-applicable" : g1.status, G3: staticProp ? "not-applicable" : g3.status, G6: g6.status, G10: g10.status, G11: g11.status, G12: staticProp ? "not-applicable" : g12.status };
  const notApplicableReasons = staticProp ? { G1: "static native prop has no animations", G3: "static native prop has no rig or skin", G12: "static native prop has no skeleton joints" } : {};
  const requiredActionIds = catalogEntry?.requiredActionIds || [];
  const actionMap = catalogEntry?.actionToClipMapping || {};
  const loadedClipNames = new Set(gltf.animations.map(clip => clip.name));
  const missingActionIds = requiredActionIds.filter(actionId => { const clipName = actionMap[actionId]; return typeof clipName !== "string" || !loadedClipNames.has(clipName); });
  const actionCoverage = { status: !catalogEntry ? "unassigned" : catalogEntry.kind === "prop" && requiredActionIds.length === 0 ? "not-applicable" : missingActionIds.length ? "incomplete" : "measurement-complete-review-required", requiredActionIds, mappedClipIds: requiredActionIds.filter(id => typeof actionMap[id] === "string").map(id => ({ actionId: id, clipId: actionMap[id] })), missingActionIds };
  const controls = [
    { gate: "G1", ...g1.negativeControl },
    { gate: "G3", ...g3.negativeControl },
    ...g6.negativeControls.map(control => ({ gate: "G6", ...control })),
    ...g10.negativeControls.map(control => ({ gate: "G10", ...control })),
    { gate: "G11", ...g11.negativeControl },
    ...g12.negativeControls.map(control => ({ gate: "G12", ...control }))
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
function download(blob, name) {
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = name; document.body.append(link);
  try { link.click(); } finally { link.remove(); }
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}function updateActions() {  const hasModel = loaded !== null;  downloadModel.disabled = !hasModel;
  downloadReport.disabled = !hasModel;  clipSelect.disabled = !hasModel || loaded.animations.length === 0;
  play.disabled = !hasModel || loaded.animations.length === 0;
  $("#stop-clip").disabled = !hasModel || loaded.animations.length === 0;
}
function renderSummary(evidence) {
  const meshCount = evidence.loadedScene.meshes.length;
  const skinCount = evidence.inverseBindAccessors.length;
  const unresolvedG10Controls = (evidence.measurements.G10.negativeControls || []).filter(control => !control.detectedFailure);
  const lines = [
    'Catalog asset: ' + (evidence.assetId || 'unassigned scratch file'),
    'Loaded native GLB: ' + evidence.source.fileName,
    'SHA-256: ' + evidence.source.sha256,
    'Scene nodes: ' + evidence.loadedScene.sceneNodeCount + ' | bones: ' + evidence.loadedScene.bones.length + ' | meshes: ' + meshCount + ' | skins: ' + skinCount,
    'Animation clips: ' + evidence.measurements.G1.clips.length,
    'Required semantic actions missing: ' + (evidence.actionCoverage?.missingActionIds?.length || 0),
    'G1: ' + evidence.gates.G1,
    'G3: ' + evidence.gates.G3,
    'G6: ' + evidence.gates.G6,
    'G10: ' + evidence.gates.G10,
    ...(unresolvedG10Controls.length ? ['G10 unresolved controls: ' + unresolvedG10Controls.map(control => control.id + (control.reason ? ': ' + control.reason : '')).join('; ')] : []),
    'G11: ' + evidence.gates.G11,
    'G12: ' + evidence.gates.G12,
    'Evidence status: ' + evidence.evidenceStatus,
    'Production acceptance: NOT ESTABLISHED. This lab report is not a full character acceptance.',
  ];
  output.textContent = lines.join('\n');
  const list = $('#mesh-list'); list.replaceChildren();
  for (const mesh of evidence.loadedScene.meshes) {
    const row = document.createElement('li');
    row.textContent = mesh.name + ' — ' + mesh.type + ' — ' + mesh.vertexCount + ' vertices';
    list.append(row);
  }
}
fetch("/assets/manifest.json").then(response => { if (!response.ok) throw new Error("HTTP " + response.status); return response.json(); }).then(entries => {
  if (!Array.isArray(entries)) throw new Error("expected normalized AssetManifestEntry array");
  catalogEntries = entries.filter(entry => entry.sourceType === "native-glb");
  assetSelect.replaceChildren(new Option("Unassigned file", ""));
  for (const entry of catalogEntries) assetSelect.add(new Option(entry.id + " — " + (entry.readiness || entry.evidenceStatus || "unknown"), entry.id));
}).catch(error => setStatus("Asset catalog unavailable; GLB inspection remains local-only. " + error.message));
assetSelect.addEventListener("change", () => {
  if (!report) return;
  report.assetId = assetSelect.value || null;
  renderSummary(report);
});
input.addEventListener("change", async () => {
  const file = input.files?.[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".glb")) { setStatus("Select a binary GLB file.", true); return; }
  setStatus("Reading and validating native GLB…");
  try {
    const buffer = await file.arrayBuffer();
    sourceBytes = buffer.slice(0);
    sourceName = file.name;
    const digest = await hash(buffer);
    const next = await new Promise((resolve, reject) => loader.parse(buffer, "", resolve, reject));
    if (gltfRoot) { scene.remove(gltfRoot); disposeObject(gltfRoot); }
    if (skeletonHelper) { scene.remove(skeletonHelper); skeletonHelper = null; }
    loaded = next; gltfRoot = loaded.scene; scene.add(gltfRoot); mixer = new THREE.AnimationMixer(gltfRoot);
    focusModel(gltfRoot);
    skeletonHelper = new THREE.SkeletonHelper(gltfRoot); skeletonHelper.visible = false; skeletonHelper.material.color.set(0x9fce77); scene.add(skeletonHelper);
    $("#show-skeleton").checked = false;
    $("#show-skeleton").onchange = () => { if (skeletonHelper) skeletonHelper.visible = $("#show-skeleton").checked; };
    clipSelect.replaceChildren();
    for (const [index, clip] of loaded.animations.entries()) {
      const option = document.createElement("option"); option.value = String(index); option.textContent = clip.name || "Clip " + (index + 1); clipSelect.append(option);
    }
    report = await buildEvidence(loaded, file, digest, $("#asset-id").value || null);
    renderSummary(report);
    updateActions();
    setStatus("Loaded and measured actual runtime scene. Export is byte-preserving; acceptance remains incomplete.");
  } catch (error) {
    report = null; loaded = null; updateActions();
    setStatus("Unable to load GLB: " + (error?.message || String(error)), true);
  }
});
play.addEventListener("click", () => {
  if (!loaded || !mixer || !loaded.animations.length) return;
  mixer.stopAllAction();
  selectedAction = mixer.clipAction(loaded.animations[Number(clipSelect.value)]);
  selectedAction.reset().play();  play.textContent = "Playing";});clipSelect.addEventListener("change", () => {
  if (mixer) mixer.stopAllAction();
  selectedAction = null; play.textContent = "Play clip";});
$("#stop-clip").addEventListener("click", () => {
  if (mixer) { mixer.stopAllAction(); mixer.update(0); }
  selectedAction = null; play.textContent = "Play clip";
});
downloadModel.addEventListener("click", () => {
  if (!sourceBytes || !sourceName) return;
  download(new Blob([sourceBytes], { type: "model/gltf-binary" }), sourceName.replace(/\.glb$/iu, "") + ".native.glb");
});
downloadReport.addEventListener("click", () => {
  if (!report) return;
  download(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }), report.assetId ? report.assetId + ".json" : sourceName.replace(/\.glb$/iu, "") + ".asset-evidence.json");
});
function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.05);
  if (mixer && selectedAction) mixer.update(delta);
  controls.update(); renderer.render(scene, camera);
}
const clock = new THREE.Clock();
resize(); animate();
updateActions();
