import * as THREE from "three";

const EPSILON = 1e-4;
function rounded(value) { return Math.round(value * 1e6) / 1e6; }
function finiteArray(values) { return values.every(Number.isFinite); }
function sameQuaternion(a, b) {
  if (a.length !== 4 || b.length !== 4) return false;
  const dot = Math.abs(a.reduce((sum, value, index) => sum + value * b[index], 0));
  return 1 - Math.min(1, dot) <= EPSILON;
}
function readTrackBinding(track, binding) {
  const size = track.getValueSize();
  const values = new Float32Array(size);
  binding.getValue(values, 0);
  return [...values];
}
function expectedTrackValue(track, time) {
  const interpolant = track.createInterpolant();
  const values = interpolant.evaluate(Math.min(Math.max(0, time), track.times[track.times.length - 1]));
  return Array.from(values.slice(0, track.getValueSize()));
}
function valueMatches(track, actual, expected) {
  if (actual.length !== expected.length || !finiteArray(actual) || !finiteArray(expected)) return false;
  if (track.name.endsWith(".quaternion")) return sameQuaternion(actual, expected);
  return actual.every((value, index) => Math.abs(value - expected[index]) <= 2e-3);
}
function markerTimes(clip) {
  const markers = clip.userData?.markers || [];
  const times = markers.flatMap(marker => {
    if (typeof marker === "number") return [marker];
    if (!marker || typeof marker !== "object") return [];
    const result = [];
    if (Number.isFinite(marker.time)) result.push(marker.time);
    if (marker.type === "contact-window" || marker.kind === "contact-window") {
      if (Number.isFinite(marker.startTime)) result.push(marker.startTime);
      if (Number.isFinite(marker.endTime)) result.push(marker.endTime);
      if (Number.isFinite(marker.startTime) && Number.isFinite(marker.endTime)) result.push((marker.startTime + marker.endTime) / 2);
    }
    return result;
  });
  return [...new Set(times.filter(time => time >= 0 && time <= clip.duration))].sort((a, b) => a - b);
}
export function sampleClipBindings(root, mixer, clip) {
  const authoredMarkers = clip.userData?.markers || [];
  const transitions = authoredMarkers.filter(marker => marker && typeof marker === "object" && (marker.type === "transition-boundary" || marker.kind === "transition-boundary"));
  const contacts = authoredMarkers.filter(marker => marker && typeof marker === "object" && (marker.type === "contact-window" || marker.kind === "contact-window"));
  const times = [...new Set([0, clip.duration * 0.25, clip.duration * 0.5, clip.duration * 0.75, clip.duration, ...markerTimes(clip)])].sort((a, b) => a - b);
  const bindings = clip.tracks.map(track => {
    const binding = new THREE.PropertyBinding(root, track.name);
    binding.bind();
    return { track, binding, targetFound: binding.node !== null && binding.node !== undefined, targetName: binding.node?.name || null };
  });
  mixer.stopAllAction();
  const action = mixer.clipAction(clip);
  action.reset();
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const samples = [];
  for (const time of times) {
    mixer.setTime(time);
    root.updateMatrixWorld(true);
    const trackSamples = bindings.map(({ track, binding, targetFound, targetName }) => {
      if (!targetFound) return { track: track.name, targetFound, targetName, actual: null, expected: expectedTrackValue(track, time), matched: false };
      try {
        const actual = readTrackBinding(track, binding);
        const expected = expectedTrackValue(track, time);
        return { track: track.name, targetFound, targetName, actual: actual.map(rounded), expected: expected.map(rounded), matched: valueMatches(track, actual, expected) };
      } catch (error) {
        return { track: track.name, targetFound, targetName, actual: null, expected: null, matched: false, readError: error?.message || String(error) };
      }
    });
    samples.push({ time: rounded(time), trackSamples });
  }
  const trackResults = bindings.map(({ track, targetFound, targetName }, index) => {
    const rows = samples.map(sample => sample.trackSamples[index]);
    return { track: track.name, targetFound, targetName, sampleCount: rows.length, allSamplesMatch: rows.length >= 5 && rows.every(row => row.matched), sampledValues: rows.map(row => row.actual) };
  });
  const valid = bindings.length > 0 && trackResults.every(result => result.targetFound && result.allSamplesMatch);
  mixer.stopAllAction();
  mixer.update(0);
  root.updateMatrixWorld(true);
  return {
    clip: clip.name,
    durationSeconds: clip.duration,
    sampleTimes: times.map(rounded),
    sampleCount: samples.length,
    authoredMarkerCount: authoredMarkers.length,
    transitionBoundaryCount: transitions.length,
    contactWindowCount: contacts.length,
    tracks: trackResults,
    samples,
    evaluatedBoundProperties: valid,
    status: valid ? "measured" : "observed-fail-or-incomplete"
  };
}
export function measureG1(root, clips) {
  const mixer = new THREE.AnimationMixer(root);
  const clipMeasurements = clips.map(clip => sampleClipBindings(root, mixer, clip));
  const brokenTrack = new THREE.VectorKeyframeTrack("__wild_crown_disconnected_negative_control__.position", [0, 1], [0, 0, 0, 1, 0, 0]);  const brokenClip = new THREE.AnimationClip("G1-disconnected-track-control", 1, [brokenTrack]);  const broken = sampleClipBindings(root, mixer, brokenClip);  const negativeControl = {    id: "G1-disconnected-native-track", expectedFailure: true,    measurementBefore: clipMeasurements.map(measurement => ({ clip: measurement.clip, sampleCount: measurement.sampleCount, evaluatedBoundProperties: measurement.evaluatedBoundProperties })),    measurementAfter: { clip: broken.clip, sampleCount: broken.sampleCount, tracks: broken.tracks, evaluatedBoundProperties: broken.evaluatedBoundProperties },    attemptedSamples: broken.sampleCount, targetMissing: broken.tracks.some(track => !track.targetFound),    boundPropertySamplesMatched: broken.evaluatedBoundProperties,    detectedFailure: !broken.evaluatedBoundProperties && broken.tracks.some(track => !track.targetFound),    expected: "same sampler rejects a disconnected animation track"  };  const measurementsComplete = clips.length > 0 && clipMeasurements.every(measurement => measurement.status === "measured" && measurement.sampleCount >= 5 && measurement.transitionBoundaryCount > 0) && negativeControl.detectedFailure;  return { status: measurementsComplete ? "measurement-complete-review-required" : "incomplete", clips: clipMeasurements, negativeControl, rule: "No game acceptance until authored markers, transitions, and release review are complete." };}export function inspectSkinIntegrity(root) {
  const meshes = [];
  root.traverse(object => {
    if (!object.isSkinnedMesh) return;
    const bones = object.skeleton?.bones || [];
    const inverseBinds = object.skeleton?.boneInverses || [];
    const indices = object.geometry.getAttribute("skinIndex");
    const weights = object.geometry.getAttribute("skinWeight");
    let invalidJointIndices = 0, invalidWeights = 0, nonNormalizedWeights = 0;
    let minWeightSum = Infinity, maxWeightSum = -Infinity;
    if (!indices || !weights || indices.count !== weights.count) invalidWeights++;
    if (indices && weights && indices.count === weights.count) {
      for (let vertex = 0; vertex < indices.count; vertex++) {
        let sum = 0;
        for (let component = 0; component < weights.itemSize; component++) {
          const joint = attributeComponent(indices, vertex, component);
          const weight = attributeComponent(weights, vertex, component);
          if (!Number.isInteger(joint) || joint < 0 || joint >= bones.length) invalidJointIndices++;
          if (!Number.isFinite(weight) || weight < 0) invalidWeights++;
          sum += weight;
        }
        minWeightSum = Math.min(minWeightSum, sum);
        maxWeightSum = Math.max(maxWeightSum, sum);
        if (Math.abs(sum - 1) > 0.02) nonNormalizedWeights++;
      }
    }
    const inverseBindCountMatches = inverseBinds.length === bones.length && bones.length > 0;
    meshes.push({ name: object.name || "(unnamed)", vertexCount: indices?.count || 0, jointCount: bones.length, inverseBindCount: inverseBinds.length, inverseBindCountMatches, invalidJointIndices, invalidWeights, nonNormalizedWeights, minWeightSum: Number.isFinite(minWeightSum) ? rounded(minWeightSum) : null, maxWeightSum: Number.isFinite(maxWeightSum) ? rounded(maxWeightSum) : null, valid: inverseBindCountMatches && invalidJointIndices === 0 && invalidWeights === 0 && nonNormalizedWeights === 0 });
  });
  return { status: meshes.length > 0 && meshes.every(mesh => mesh.valid) ? "valid" : meshes.length ? "observed-fail" : "not-evaluated", skinnedMeshCount: meshes.length, meshes };
}
function snapshotBones(bones) {
  return bones.map(node => ({ node, position: node.position.clone(), quaternion: node.quaternion.clone(), scale: node.scale.clone(), worldPosition: node.getWorldPosition(new THREE.Vector3()), worldQuaternion: node.getWorldQuaternion(new THREE.Quaternion()), worldScale: node.getWorldScale(new THREE.Vector3()) }));
}
function restoreCheck(snapshot) {
  if (!snapshot.length) return { localRestored: false, worldRestored: false };
  let localRestored = true, worldRestored = true;
  for (const saved of snapshot) {
    const node = saved.node;
    localRestored &&= node.position.distanceTo(saved.position) <= EPSILON && node.scale.distanceTo(saved.scale) <= EPSILON && 1 - Math.abs(node.quaternion.dot(saved.quaternion)) <= EPSILON;
    node.updateWorldMatrix(true, false);
    const worldPosition = node.getWorldPosition(new THREE.Vector3()), worldQuaternion = node.getWorldQuaternion(new THREE.Quaternion()), worldScale = node.getWorldScale(new THREE.Vector3());
    worldRestored &&= worldPosition.distanceTo(saved.worldPosition) <= EPSILON && worldScale.distanceTo(saved.worldScale) <= EPSILON && 1 - Math.abs(worldQuaternion.dot(saved.worldQuaternion)) <= EPSILON;
  }
  return { localRestored, worldRestored };
}
export function measureG3(root, clips) {
  const bones = [];
  root.traverse(object => { if (object.isBone) bones.push(object); });
  const skin = inspectSkinIntegrity(root);
  const mixer = new THREE.AnimationMixer(root);
  const baseline = snapshotBones(bones);
  const clipRestores = [];
  for (const clip of clips) {
    mixer.stopAllAction(); mixer.update(0);
    const action = mixer.clipAction(clip).reset(); action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play();
    mixer.setTime(Math.max(0.001, clip.duration * 0.5));
    mixer.stopAllAction(); mixer.update(0); root.updateMatrixWorld(true);
    const stopped = restoreCheck(baseline);
    const resetAction = mixer.clipAction(clip).reset(); resetAction.play(); mixer.setTime(Math.max(0.001, clip.duration * 0.5));
    resetAction.stop(); resetAction.reset(); mixer.update(0); root.updateMatrixWorld(true);
    const reset = restoreCheck(baseline);
    clipRestores.push({ clip: clip.name, stop: stopped, reset: reset });
  }
  const switches = [];
  for (let index = 0; index + 1 < clips.length; index++) {
    mixer.stopAllAction(); mixer.update(0); root.updateMatrixWorld(true);
    const fromClip = clips[index], toClip = clips[index + 1];
    const from = mixer.clipAction(fromClip).reset(); from.setLoop(THREE.LoopOnce, 1); from.clampWhenFinished = true; from.play(); mixer.setTime(Math.max(0.001, fromClip.duration * 0.5));
    const to = mixer.clipAction(toClip).reset(); to.setLoop(THREE.LoopOnce, 1); to.clampWhenFinished = true; to.play();
    from.crossFadeTo(to, 0.15, false); mixer.update(0.075); mixer.update(0.1); root.updateMatrixWorld(true);
    mixer.stopAllAction(); mixer.update(0); root.updateMatrixWorld(true);
    switches.push({ from: fromClip.name, to: toClip.name, localAndWorld: restoreCheck(baseline) });
  }
  mixer.stopAllAction(); mixer.update(0); root.updateMatrixWorld(true);
  let brokenControl = { detectedFailure: false, poseChangedWhileActionLeftActive: false };
  if (clips.length && bones.length) {
    const control = mixer.clipAction(clips[0]).reset(); control.setLoop(THREE.LoopOnce, 1); control.clampWhenFinished = true; control.play(); mixer.setTime(Math.max(0.001, clips[0].duration * 0.5)); root.updateMatrixWorld(true);
    const beforePose = baseline.map(saved => ({ bone: saved.node.name, localPosition: saved.position.toArray().map(rounded), localQuaternion: saved.quaternion.toArray().map(rounded), worldPosition: saved.worldPosition.toArray().map(rounded), worldQuaternion: saved.worldQuaternion.toArray().map(rounded) }));
    const afterPose = bones.map(node => ({ bone: node.name, localPosition: node.position.toArray().map(rounded), localQuaternion: node.quaternion.toArray().map(rounded), worldPosition: node.getWorldPosition(new THREE.Vector3()).toArray().map(rounded), worldQuaternion: node.getWorldQuaternion(new THREE.Quaternion()).toArray().map(rounded) }));
    const comparison = restoreCheck(baseline); const changed = !comparison.localRestored || !comparison.worldRestored;
    brokenControl = { id: "G3-unrestored-active-action", expectedFailure: true, measurementBefore: beforePose, measurementAfter: afterPose, restoreComparison: comparison, detectedFailure: changed, poseChangedWhileActionLeftActive: changed, expected: "active mid-clip pose must fail restore comparison" };
    mixer.stopAllAction(); mixer.update(0); root.updateMatrixWorld(true);
  }
  const switchesValid = switches.length > 0 && switches.every(entry => entry.localAndWorld.localRestored && entry.localAndWorld.worldRestored);
  const clipsValid = clipRestores.length >= 2 && clipRestores.every(entry => entry.stop.localRestored && entry.stop.worldRestored && entry.reset.localRestored && entry.reset.worldRestored);  const status = skin.status === "valid" && bones.length > 0 && clipsValid && switchesValid && brokenControl.detectedFailure ? "measurement-complete-review-required" : "incomplete";
  return { status, boneCount: bones.length, skinIntegrity: skin, clipRestores, switchTransitions: switches, negativeControl: brokenControl, rule: "Empty skeletons, missing native skin/inverse binds, or a non-detecting pose perturbation never pass." };}
export function measureStaticPropVisibility(gltf, root, renderer, scene, camera, assetId) {  const json = gltf.parser.json;
  const meshes = [], nodeIndices = staticNodeIndices(gltf, root);
  root.traverse(mesh => {
    if (!mesh.isMesh) return;
    const nodeIndex = nodeIndices.get(mesh);
    meshes.push({ mesh, nodeIndex, nodeName: json.nodes?.[nodeIndex]?.name || '(unnamed)', meshIndex: json.nodes?.[nodeIndex]?.mesh, visible: effectivelyVisible(mesh, root), alphaVisible: hasVisibleSourceMaterial(mesh) });
  });
  const geometryRows = measureStaticGeometryCore(gltf, root, assetId, nodeIndices).staticGeometry.meshNodes;
  const meshInventory = geometryRows.map(row => {
    const parts = meshes.filter(part => part.nodeIndex === row.nodeIndex);
    return { nodeIndex: row.nodeIndex, nodeName: row.meshNodeName, meshIndex: row.meshIndex, visible: parts.every(part => part.visible), alphaVisible: parts.every(part => part.alphaVisible), primitiveCount: row.primitiveCount, vertexCount: row.vertexCount, indexCount: row.indexCount, materialCount: row.materialCount };
  });
  const policy = json.asset?.extras?.wildCrownStaticVisibilityPolicy || null;  if (!policy || policy.version !== 1 || policy.assetId !== assetId || !Array.isArray(policy.requiredMeshNodes) || !Array.isArray(policy.excludedMeshNodes)) return { status: "incomplete", policyStatus: "missing-or-mismatched", policyAssetId: policy?.assetId || null, meshInventory, renderedCoverage: [], parts: [], negativeControls: [], reason: "Requires GLTF asset.extras.wildCrownStaticVisibilityPolicy v1 scoped to this exact prop ID." };
  const required = policy.requiredMeshNodes;  const excluded = policy.excludedMeshNodes;
  const requiredIds = required.map(row => row.nodeIndex);  const excludedIds = excluded.map(row => row.nodeIndex);
  const allPolicyIds = [...requiredIds, ...excludedIds];  const renderableIds = meshInventory.map(row => row.nodeIndex);
  const exactInventory = renderableIds.every(Number.isInteger) && new Set(allPolicyIds).size === allPolicyIds.length && renderableIds.length === allPolicyIds.length && renderableIds.every(id => allPolicyIds.includes(id));  const thresholdsValid = required.every(row => Number.isInteger(row.nodeIndex) && Number.isInteger(row.minimumVisiblePixels) && row.minimumVisiblePixels > 0 && Number.isInteger(row.minimumVisibleViews) && row.minimumVisibleViews > 0 && row.minimumVisibleViews <= 8) && excluded.every(row => Number.isInteger(row.nodeIndex) && typeof row.reason === "string" && row.reason.trim().length > 0);
  const originalMaterials = new Map(meshes.map(row => [row.mesh, row.mesh.material]));  const originalVisibility = new Map(meshes.map(row => [row.mesh, row.mesh.visible]));
  const savedCamera = { position: camera.position.clone(), quaternion: camera.quaternion.clone(), up: camera.up.clone(), near: camera.near, far: camera.far, aspect: camera.aspect };  const oldRenderTarget = renderer.getRenderTarget(), oldClearColor = renderer.getClearColor(new THREE.Color()).clone(), oldClearAlpha = renderer.getClearAlpha(), oldBackground = scene.background;
  const siblingVisibility = scene.children.filter(child => child !== root && !child.isLight).map(child => [child, child.visible]);  let target = null, currentMaskMaterials = [];
  const controls = [], measurements = [], setupFailures = [];
  try {
    for (const [node, visible] of siblingVisibility) node.visible = false;
    scene.background = new THREE.Color(0x000000);
    target = new THREE.WebGLRenderTarget(256, 256, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: true, stencilBuffer: false });
    const pixels = new Uint8Array(256 * 256 * 4);
    const bounds = new THREE.Box3().setFromObject(root), center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3()), radius = Math.max(size.length() * 1.8, 1);
    const views = [new THREE.Vector3(0,0,1),new THREE.Vector3(0,0,-1),new THREE.Vector3(1,0,0),new THREE.Vector3(-1,0,0),new THREE.Vector3(1,0,1).normalize(),new THREE.Vector3(-1,0,1).normalize(),new THREE.Vector3(1,0,-1).normalize(),new THREE.Vector3(-1,0,-1).normalize()];
    camera.aspect=1;
    const renderNode = (targetNodeIndex, colorName) => {
      for(const material of currentMaskMaterials)material.dispose();currentMaskMaterials=[];
      for(const row of meshes){
        const isTarget=row.nodeIndex===targetNodeIndex;const color=colorName==="red"&&isTarget?0xff0000:colorName==="green"&&isTarget?0x00ff00:0x000000;
        const mapMaterial=sourceMaterial=>{const output=visibilityMaterial(sourceMaterial,color,sourceMaterial?.depthWrite??true);currentMaskMaterials.push(output);return output;};
        row.mesh.material=Array.isArray(originalMaterials.get(row.mesh))?originalMaterials.get(row.mesh).map(mapMaterial):mapMaterial(originalMaterials.get(row.mesh));
      }
      const byView=[];
      for(const direction of views){
        camera.position.copy(center).addScaledVector(direction,radius);camera.up.set(0,1,0);camera.near=Math.max(radius/500,0.001);camera.far=radius*4;camera.lookAt(center);camera.updateProjectionMatrix();camera.updateMatrixWorld(true);root.updateMatrixWorld(true);
        renderer.setRenderTarget(target);renderer.setClearColor(0x000000,1);renderer.clear(true,true,true);renderer.render(scene,camera);renderer.readRenderTargetPixels(target,0,0,256,256,pixels);byView.push(countColorPixels(pixels,colorName));
      }
      return byView;
    };
    for(const spec of required){
      const nodeRows=meshes.filter(row=>row.nodeIndex===spec.nodeIndex);
      const identity = { nodeIndex: spec.nodeIndex, nodeName: json.nodes?.[spec.nodeIndex]?.name || '(unnamed)', meshIndex: json.nodes?.[spec.nodeIndex]?.mesh };
      const before=renderNode(spec.nodeIndex,"red");
      for(const row of nodeRows)row.mesh.visible=false;
      const after=renderNode(spec.nodeIndex,"green");
      for(const row of nodeRows)row.mesh.visible=originalVisibility.get(row.mesh);
      const visibleViews=before.filter(value=>value>=spec.minimumVisiblePixels).length;
      const detectedFailure=before.some(value=>value>0)&&after.every(value=>value===0);
      controls.push({id:"G6-hidden-static-mesh:"+spec.nodeIndex,gate:"G6",expectedFailure:true,measurementBefore:{...identity,minimumVisiblePixels:spec.minimumVisiblePixels,minimumVisibleViews:spec.minimumVisibleViews,visibleViews:before.filter(value=>value>=spec.minimumVisiblePixels).length,visiblePixelsByView:before},measurementAfter:{...identity,minimumVisiblePixels:spec.minimumVisiblePixels,minimumVisibleViews:spec.minimumVisibleViews,visibleViews:after.filter(value=>value>=spec.minimumVisiblePixels).length,visiblePixelsByView:after},detectedFailure,assetId,sourceHash:null});
      measurements.push({nodeIndex:spec.nodeIndex,minimumVisiblePixels:spec.minimumVisiblePixels,minimumVisibleViews:spec.minimumVisibleViews,visiblePixelsByView:before,visibleViews,visible:nodeRows.length>0&&visibleViews>=spec.minimumVisibleViews,sourceMeshCount:nodeRows.length});
      if(!nodeRows.length)setupFailures.push({nodeIndex:spec.nodeIndex,reason:"required node has no loaded mesh"});
    }
    const excludedRows=excluded.map(spec=>{const rows=meshes.filter(row=>row.nodeIndex===spec.nodeIndex);return{nodeIndex:spec.nodeIndex,reason:spec.reason,sourceMeshCount:rows.length,visible:rows.some(row=>row.visible&&row.alphaVisible)}});
    const controlsValid=controls.length===required.length&&controls.every(control=>control.detectedFailure);
    const policyComplete=exactInventory&&thresholdsValid&&setupFailures.length===0;
    const visibleComplete=measurements.every(row=>row.visible);
    const status=policyComplete&&visibleComplete&&controlsValid?"measurement-complete-review-required":"incomplete";
    const viewIds = ['front', 'back', 'right', 'left', 'front-right', 'front-left', 'back-right', 'back-left'];
    const renderedCoverage = viewIds.map((viewId, index) => ({ viewId, pixelCount: measurements.reduce((sum, row) => sum + row.visiblePixelsByView[index], 0) }));
    return{status,policyStatus:policyComplete?"complete":"incomplete",policyId:policy.policyId||null,policyVersion:policy.version,policyAssetId:policy.assetId,assetId,views:views.length,resolution:[256,256],requiredMeshNodes:structuredClone(policy.requiredMeshNodes),excludedMeshNodes:structuredClone(policy.excludedMeshNodes),excludedNodeMeasurements:excludedRows,meshInventory,renderedCoverage,parts:measurements,negativeControls:controls,setupFailures,stalePolicyIds:allPolicyIds.filter(id=>!renderableIds.includes(id))};
  }catch(error){return{status:"incomplete",policyStatus:"error",assetId,error:error?.message||String(error),meshInventory,renderedCoverage:[],parts:measurements,negativeControls:controls,setupFailures};}
  finally{
    for(const [mesh,material] of originalMaterials)mesh.material=material;
    for(const [mesh,visible] of originalVisibility)mesh.visible=visible;
    for(const material of currentMaskMaterials)material.dispose();if(target)target.dispose();renderer.setRenderTarget(oldRenderTarget);renderer.setClearColor(oldClearColor,oldClearAlpha);scene.background=oldBackground;
    for(const [node,visible] of siblingVisibility)node.visible=visible;camera.position.copy(savedCamera.position);camera.quaternion.copy(savedCamera.quaternion);camera.up.copy(savedCamera.up);camera.near=savedCamera.near;camera.far=savedCamera.far;camera.aspect=savedCamera.aspect;camera.updateProjectionMatrix();camera.updateMatrixWorld(true);
  }
}
export function measureG10Skin(root) { return inspectSkinIntegrity(root); }

function attributeComponent(attribute, index, component) {
  const method = ["getX", "getY", "getZ", "getW"][component];
  if (!method || typeof attribute[method] !== "function") return NaN;
  return attribute[method](index);
}
function sourceMaterials(mesh) { return Array.isArray(mesh.material) ? mesh.material : [mesh.material]; }
function hasVisibleSourceMaterial(mesh) { return sourceMaterials(mesh).some(material => material && material.visible !== false && material.opacity > 0); }
function visibilityMaterial(sourceMaterial, color, depthWrite = true) {
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff, map: sourceMaterial?.map || null, alphaMap: sourceMaterial?.alphaMap || null, alphaTest: sourceMaterial?.alphaTest || 0, opacity: sourceMaterial?.opacity ?? 1, transparent: Boolean(sourceMaterial?.transparent), side: sourceMaterial?.side ?? THREE.FrontSide, depthTest: sourceMaterial?.depthTest ?? true, depthWrite: sourceMaterial?.depthWrite ?? depthWrite, colorWrite: sourceMaterial?.colorWrite ?? true, visible: sourceMaterial?.visible !== false, blending: sourceMaterial?.blending ?? THREE.NormalBlending, toneMapped: false });
  setCoverageShader(material, color, depthWrite);
  return material;
}
function setCoverageShader(material, color, depthWrite = true) {
  material.onBeforeCompile = shader => {
    shader.uniforms.wildCrownCoverageColor = { value: new THREE.Color(color) };
    shader.fragmentShader = shader.fragmentShader.replace("void main() {", "uniform vec3 wildCrownCoverageColor;\nvoid main() {");
    shader.fragmentShader = shader.fragmentShader.replace("#include <opaque_fragment>", "#include <opaque_fragment>\ngl_FragColor.rgb = wildCrownCoverageColor;");
  };
  material.customProgramCacheKey = () => "wild-crown-coverage-mask-v1-" + color + "-" + depthWrite;
  material.depthWrite = depthWrite;
  material.needsUpdate = true;
}function meshProbe(source, geometry, partId, selectedPartId, geometryOwned = false, depthWrite = true) {
  const clone = source.clone(false);
  clone.geometry = geometry;  clone.material = Array.isArray(source.material)
    ? source.material.map(material => visibilityMaterial(material, partId === selectedPartId ? 0xff0000 : 0x000000, depthWrite))
    : visibilityMaterial(source.material, partId === selectedPartId ? 0xff0000 : 0x000000, depthWrite);  if (source.isSkinnedMesh) {
    clone.skeleton = source.skeleton;
    clone.bindMatrix.copy(source.bindMatrix);    clone.bindMatrixInverse.copy(source.bindMatrixInverse);
  }
  clone.name = "__wc_visibility_probe__";  clone.renderOrder = depthWrite ? 0 : -1;
  clone.userData.wildCrownProbePart = partId;
  clone.userData.wildCrownProbeSource = source;  clone.userData.wildCrownProbeGeometryOwned = geometryOwned;
  return clone;
}function regionGeometry(source, part) {
  const geometry = source.geometry;
  const index = geometry.getAttribute("skinIndex"), weight = geometry.getAttribute("skinWeight");  if (!index || !weight || !Array.isArray(part.boneNames) || !Number.isFinite(part.minimumSkinWeight)) return { geometry: null, owned: false, coveredVertices: 0, totalVertices: index?.count || 0 };
  const selectedBones = new Set();
  source.skeleton.bones.forEach((bone, boneIndex) => { if (part.boneNames.includes(bone.name)) selectedBones.add(boneIndex); });  const roleWeight = vertex => {
    let sum = 0;
    for (let component = 0; component < index.itemSize; component++) if (selectedBones.has(attributeComponent(index, vertex, component))) sum += attributeComponent(weight, vertex, component);    return sum;
  };
  let coveredVertices = 0;  for (let vertex = 0; vertex < index.count; vertex++) if (roleWeight(vertex) >= part.minimumSkinWeight) coveredVertices++;
  const indices = geometry.index ? geometry.index.array : Array.from({ length: index.count }, (_, i) => i);
  const selectedIndices = [];  for (let offset = 0; offset + 2 < indices.length; offset += 3) {
    const a = indices[offset], b = indices[offset + 1], c = indices[offset + 2];
    if (Math.max(roleWeight(a), roleWeight(b), roleWeight(c)) >= part.minimumSkinWeight) selectedIndices.push(a, b, c);  }
  if (!selectedIndices.length) return { geometry: null, owned: false, coveredVertices, totalVertices: index.count };
  const subset = geometry.clone();  subset.setIndex(selectedIndices);
  return { geometry: subset, owned: true, coveredVertices, totalVertices: index.count };
}
function effectivelyVisible(object, root) {
  for (let current = object; current; current = current.parent) {
    if (!current.visible) return false;
    if (current === root) return true;
  }
  return false;
}
function countColorPixels(pixels, color) {
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    const isRed = pixels[i] > 128 && pixels[i + 1] < 40 && pixels[i + 2] < 40;
    const isGreen = pixels[i + 1] > 128 && pixels[i] < 40 && pixels[i + 2] < 40;
    if (color === "red" ? isRed : color === "green" ? isGreen : pixels[i] < 8 && pixels[i + 1] < 8 && pixels[i + 2] < 8) count++;
  }
  return count;
}
export function measureG6Visibility(root, policy, renderer, scene, camera) {
  const sources = [];
  root.traverse(object => { if (object.isMesh) sources.push(object); });
  const inventory = sources.map(mesh => ({ name: mesh.name || "(unnamed)", kind: mesh.isSkinnedMesh ? "deforming-skinned" : mesh.parent?.isBone ? "rigid-bone-attached" : "static-scene", visible: effectivelyVisible(mesh, root), alphaVisible: hasVisibleSourceMaterial(mesh), vertexCount: mesh.geometry.getAttribute("position")?.count || 0 }));
  if (!policy || !policy.species || !Number.isInteger(policy.version) || !Array.isArray(policy.requiredBodyParts) || !policy.requiredBodyParts.length) return { status: "not-evaluated", species: policy?.species || null, meshInventory: inventory, requiredBodyParts: [], parts: [], negativeControls: [], reason: "Missing species-aware, authored GLB asset.extras.wildCrownCoveragePolicy." };
  const parts = policy.requiredBodyParts;
  const ids = parts.map(part => typeof part === "object" ? part.id : null);
  const policyValid = ids.every(Boolean) && new Set(ids).size === ids.length && parts.every(part => typeof part === "object" && Number.isFinite(part.minimumVisiblePixels) && part.minimumVisiblePixels > 0 && Number.isInteger(part.minimumVisibleViews) && part.minimumVisibleViews > 0 && part.minimumVisibleViews <= 8 && ((!part.boneNames && !part.meshNames) || (Array.isArray(part.boneNames) || Array.isArray(part.meshNames))));
  const initialVisibility = new Map(sources.map(mesh => [mesh, mesh.visible]));
  const probes = [], regionsByPart = new Map(ids.map(id => [id, []])), regionMeasurements = [], setupFailures = [];
  let target = null, priorRenderTarget = null, priorClearColor = null, priorClearAlpha = 1, priorBackground = null, priorSceneVisibility = [], priorCamera = null;
  try {
    for (const source of sources) {
      const annotatedPart = source.userData?.gltfExtras?.wildCrownBodyPart || source.userData?.wildCrownBodyPart || null;
      if (!effectivelyVisible(source, root) || !hasVisibleSourceMaterial(source)) { source.visible = false; if (annotatedPart && regionsByPart.has(annotatedPart)) setupFailures.push({ mesh: source.name, partId: annotatedPart, reason: "source mesh is invisible or alpha-zero" }); continue; }      if (annotatedPart && regionsByPart.has(annotatedPart)) {
        const clone = meshProbe(source, source.geometry, annotatedPart, null, false, true);
        source.parent?.add(clone); probes.push(clone); regionsByPart.get(annotatedPart).push(clone); source.visible = false; continue;
      }
      const applicable = source.isSkinnedMesh ? parts.filter(part => part.boneNames?.length) : [];
      if (applicable.length) {
        const occluder = meshProbe(source, source.geometry, null, null, false, false);
        source.parent?.add(occluder); probes.push(occluder);
        for (const part of applicable) {
          const region = regionGeometry(source, part);
          regionMeasurements.push({ mesh: source.name || "(unnamed)", partId: part.id, boneNames: part.boneNames, coveredVertices: region.coveredVertices, totalVertices: region.totalVertices, selectedGeometryTriangles: region.geometry?.index?.count ? region.geometry.index.count / 3 : 0 });
          if (!region.geometry) { setupFailures.push({ mesh: source.name, partId: part.id, reason: "bone-associated region has no renderable triangles" }); continue; }
          const clone = meshProbe(source, region.geometry, part.id, null, true, true);
          source.parent?.add(clone); probes.push(clone); regionsByPart.get(part.id)?.push(clone);
        }
        source.visible = false; continue;
      }
      const occluder = meshProbe(source, source.geometry, null, null, false, true);
      source.parent?.add(occluder); probes.push(occluder); source.visible = false;
    }
    priorCamera = { position: camera.position.clone(), quaternion: camera.quaternion.clone(), up: camera.up.clone(), near: camera.near, far: camera.far, aspect: camera.aspect };
    priorRenderTarget = renderer.getRenderTarget(); priorClearColor = renderer.getClearColor(new THREE.Color()).clone(); priorClearAlpha = renderer.getClearAlpha(); priorBackground = scene.background;
    priorSceneVisibility = scene.children.filter(child => child !== root && !child.isLight).map(child => [child, child.visible]);
    for (const [object] of priorSceneVisibility) object.visible = false;
    scene.background = new THREE.Color(0x000000);
    target = new THREE.WebGLRenderTarget(256, 256, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: true, stencilBuffer: false });
    const pixels = new Uint8Array(256 * 256 * 4);
    const bounds = new THREE.Box3().setFromObject(root), center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());    const radius = Math.max(size.length() * 1.8, 1);
    const views = [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 1).normalize(), new THREE.Vector3(-1, 0, 1).normalize(), new THREE.Vector3(1, 0, -1).normalize(), new THREE.Vector3(-1, 0, -1).normalize()];
    camera.aspect = 1;
    const render = targetColor => {      const values = [];
      for (const direction of views) {
        camera.position.copy(center).addScaledVector(direction, radius); camera.up.set(0, 1, 0); camera.near = Math.max(radius / 500, 0.001); camera.far = radius * 4; camera.lookAt(center); camera.updateProjectionMatrix(); camera.updateMatrixWorld(true); root.updateMatrixWorld(true);
        for (const probe of probes) for (const material of Array.isArray(probe.material) ? probe.material : [probe.material]) setCoverageShader(material, probe.userData.wildCrownProbePart === targetColor.partId ? targetColor.hex : 0x000000, material.depthWrite);        renderer.setRenderTarget(target); renderer.setClearColor(0x000000, 1); renderer.clear(true, true, true); renderer.render(scene, camera); renderer.readRenderTargetPixels(target, 0, 0, 256, 256, pixels);
        values.push(countColorPixels(pixels, targetColor.name));
      }
      return values;    };
    const measurements = [], controls = [];
    for (const part of parts) {
      const before = render({ partId: part.id, hex: 0xff0000, name: "red" });      const regions = regionsByPart.get(part.id) || [];
      for (const probe of regions) probe.visible = false;
      const after = render({ partId: part.id, hex: 0x00ff00, name: "green" });
      for (const probe of regions) probe.visible = true;      const visibleViews = before.filter(count => count >= part.minimumVisiblePixels).length;
      const control = { id: "G6-hidden-required-body-part:" + part.id, expectedFailure: true, measurementBefore: before, measurementAfter: after, detectedFailure: before.some(count => count > 0) && after.every(count => count === 0), sourceRegionCount: regions.length };
      controls.push(control);
      measurements.push({ id: part.id, minimumVisiblePixels: part.minimumVisiblePixels, minimumVisibleViews: part.minimumVisibleViews, pixelsByView: before, visibleViews, regionCount: regions.length, visible: regions.length > 0 && visibleViews >= part.minimumVisibleViews, negativeControlId: control.id });    }
    const annotationsComplete = measurements.length === parts.length && measurements.every(part => part.regionCount > 0) && setupFailures.length === 0;
    const controlsDetected = controls.length === parts.length && controls.every(control => control.detectedFailure);
    const visibleComplete = measurements.every(part => part.visible);    const status = policyValid && annotationsComplete && controlsDetected && visibleComplete ? "measurement-complete-review-required" : "incomplete";
    return { status, species: policy.species, policyVersion: policy.version, views: views.length, resolution: [256, 256], policyValid, annotationsComplete, visibleComplete, setupFailures, boneRegionMeasurements: regionMeasurements, meshInventory: inventory, parts: measurements, negativeControls: controls, note: "Framebuffer pixels are measured on the loaded native scene; producer evidence is not game acceptance until reviewed." };
  } catch (error) {
    return { status: "incomplete", species: policy.species, policyVersion: policy.version, views: 8, policyValid, meshInventory: inventory, setupFailures: [...setupFailures, { reason: error?.message || String(error) }], parts: [], negativeControls: [] };  } finally {
    if (target) target.dispose();
    renderer.setRenderTarget(priorRenderTarget);
    if (priorClearColor) renderer.setClearColor(priorClearColor, priorClearAlpha);    scene.background = priorBackground;
    for (const [object, visible] of priorSceneVisibility) object.visible = visible;
    if (priorCamera) { camera.position.copy(priorCamera.position); camera.quaternion.copy(priorCamera.quaternion); camera.up.copy(priorCamera.up); camera.near = priorCamera.near; camera.far = priorCamera.far; camera.aspect = priorCamera.aspect; camera.updateProjectionMatrix(); camera.updateMatrixWorld(true); }
    for (const probe of probes) {      probe.parent?.remove(probe);
      if (probe.userData.wildCrownProbeGeometryOwned) probe.geometry?.dispose();
      for (const material of Array.isArray(probe.material) ? probe.material : [probe.material]) material?.dispose();
    }    for (const [mesh, visible] of initialVisibility) mesh.visible = visible;
  }
}
function contactCoverage(markers, sampleTimes) {
  const windows = markers.filter(marker => marker && typeof marker === "object" && (marker.type === "contact-window" || marker.kind === "contact-window"));
  const covered = windows.filter(window => Number.isFinite(window.startTime) && Number.isFinite(window.endTime) && sampleTimes.some(time => Math.abs(time - window.startTime) < EPSILON) && sampleTimes.some(time => Math.abs(time - window.endTime) < EPSILON));
  return { windows, covered, complete: windows.length > 0 && covered.length === windows.length };}
function staticNodeIndices(gltf, root) {
  const json = gltf.parser.json, indices = new Map();
  const scene = json.scenes?.[json.scene ?? 0];
  if (scene) {
    // GLTFLoader shares association objects for instanced meshes. Native scene/child
    // order identifies node objects without rewriting those shared mappings.
    const visit = (object, nodeIndex) => {
      if (!object) return;
      object.traverse(child => { if (child.isMesh) indices.set(child, nodeIndex); });
      const children = json.nodes[nodeIndex].children || [];
      const offset = object.children.length - children.length;
      children.forEach((childIndex, index) => visit(object.children[offset + index], childIndex));
    };
    scene.nodes.forEach((nodeIndex, index) => visit(root.children[index], nodeIndex));
  } else {
    root.traverse(mesh => {
      if (!mesh.isMesh) return;
      let object = mesh;
      while (object && !Number.isInteger(gltf.parser.associations?.get(object)?.nodes)) object = object.parent;
      indices.set(mesh, gltf.parser.associations?.get(object)?.nodes ?? null);
    });
  }
  return indices;
}

function measureStaticGeometryCore(gltf, root, assetId, nodeIndices = staticNodeIndices(gltf, root)) {
  const json = gltf.parser.json;
  const parts = [];
  root.updateMatrixWorld(true);
  const asBox = value => {
    if (!value?.min || !value?.max) return null;
    const vector = item => Array.isArray(item) ? new THREE.Vector3(item[0], item[1], item[2]) : new THREE.Vector3(item.x, item.y, item.z);
    const box = new THREE.Box3(vector(value.min), vector(value.max));
    return box.isEmpty() ? null : box;
  };
  const recordBox = box => box && !box.isEmpty() ? { min: box.min.toArray(), max: box.max.toArray() } : null;
  const delta = (actual, declared) => {
    if (!actual || !declared) return null;
    const min = actual.min.toArray().map((value, index) => Math.fround(value) - Math.fround(declared.min.getComponent(index)));
    const max = actual.max.toArray().map((value, index) => Math.fround(value) - Math.fround(declared.max.getComponent(index)));
    return { min, max, maxAbs: Math.max(...min.map(Math.abs), ...max.map(Math.abs)) };
  };
  const exactFloat32Match = (actual, declared) => {
    if (!actual || !declared) return null;
    return actual.min.toArray().every((value, index) => Math.fround(value) === Math.fround(declared.min.getComponent(index))) &&
      actual.max.toArray().every((value, index) => Math.fround(value) === Math.fround(declared.max.getComponent(index)));
  };
  root.traverse(mesh => {
    if (!mesh.isMesh) return;
    mesh.updateWorldMatrix(true, false);
    const association = gltf.parser.associations?.get(mesh) || {};
    const nodeIndex = nodeIndices.get(mesh) ?? null;
    const nodeName = nodeIndex === null ? null : json.nodes?.[nodeIndex]?.name || null;
    const meshIndex = Number.isInteger(association.meshes) ? association.meshes : null;
    const primitiveIndex = Number.isInteger(association.primitives) ? association.primitives : null;
    const position = mesh.geometry.getAttribute('position');
    const index = mesh.geometry.index;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    let finitePositionCount = 0;
    let nonFinitePositionCount = 0;
    let invalidIndexCount = 0;
    const actualLocal = new THREE.Box3();
    const actualWorld = new THREE.Box3();
    const point = new THREE.Vector3();
    const worldPoint = new THREE.Vector3();
    if (position) {
      for (let vertex = 0; vertex < position.count; vertex++) {
        point.fromBufferAttribute(position, vertex);
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.z)) {
          nonFinitePositionCount++;
          continue;
        }
        finitePositionCount++;
        actualLocal.expandByPoint(point);
        actualWorld.expandByPoint(worldPoint.copy(point).applyMatrix4(mesh.matrixWorld));
      }
    }
    if (index && position) {
      for (const value of index.array) {
        if (!Number.isInteger(value) || value < 0 || value >= position.count) invalidIndexCount++;
      }
    }
    const materialIndices = [...new Set((mesh.geometry.groups || []).map(group => group.materialIndex ?? 0))].sort((a, b) => a - b);
    if (!materialIndices.length && materials.length) materialIndices.push(0);
    const materialRefsValid = materials.length > 0 && materialIndices.every(materialIndex => materialIndex >= 0 && materialIndex < materials.length);
    const cachedLocal = asBox(mesh.geometry.boundingBox);
    const meshPrimitives = json.meshes?.[meshIndex]?.primitives || [];
    const primitiveRows = primitiveIndex === null ? meshPrimitives : meshPrimitives[primitiveIndex] ? [meshPrimitives[primitiveIndex]] : [];
    const declaredLocal = new THREE.Box3();
    let hasAccessorBounds = false;
    for (const primitive of primitiveRows) {
      const accessor = json.accessors?.[primitive.attributes?.POSITION];
      const accessorBox = accessor?.min && accessor?.max ? asBox({ min: accessor.min, max: accessor.max }) : null;
      if (accessorBox) {
        declaredLocal.union(accessorBox);
        hasAccessorBounds = true;
      }
    }
    const declaredBox = hasAccessorBounds ? declaredLocal : null;
    const cachedMatch = exactFloat32Match(actualLocal, cachedLocal);
    const accessorMatch = exactFloat32Match(actualLocal, declaredBox);
    parts.push({
      mesh, nodeIndex, nodeName, meshIndex, primitiveIndex,
      primitiveCount: primitiveRows.length || mesh.geometry.groups.length || 1,
      vertexCount: position?.count || 0, finitePositionCount, nonFinitePositionCount,
      indexCount: index?.count || 0, invalidIndexCount,
      materialCount: materials.length, materialIndices: primitiveRows.map(primitive => primitive.material).filter(Number.isInteger), materialRefsValid,
      measuredLocalBounds: recordBox(actualLocal), measuredWorldBounds: recordBox(actualWorld),
      cachedLocalBounds: recordBox(cachedLocal), accessorDeclaredLocalBounds: recordBox(declaredBox),
      primitiveDeclarations: primitiveRows.map((primitive, index) => ({ nodeIndex, meshIndex, primitiveIndex: primitiveIndex ?? index, positionAccessorIndex: primitive.attributes?.POSITION ?? null, accessorDeclaredLocalBounds: recordBox(asBox(json.accessors?.[primitive.attributes?.POSITION])) })),
      cachedBoundsDelta: delta(actualLocal, cachedLocal), accessorBoundsDelta: delta(actualLocal, declaredBox),
      cachedBoundsMatch: cachedMatch, accessorBoundsMatch: accessorMatch,
    });
  });

  const grouped = new Map();
  for (const part of parts) {
    const key = part.nodeIndex === null ? 'missing-node:' + (part.meshIndex ?? 'unknown') : 'node:' + part.nodeIndex;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(part);
  }
  const union = records => {
    const box = new THREE.Box3();
    for (const record of records) {
      const current = asBox(record);
      if (current) box.union(current);
    }
    return box.isEmpty() ? null : recordBox(box);
  };
  const meshNodes = [];
  for (const nodeParts of grouped.values()) {
    const first = nodeParts[0];
    const primitiveIndices = nodeParts.map(part => part.primitiveIndex).filter(Number.isInteger).sort((a, b) => a - b);
    const materialIndices = [...new Set(nodeParts.flatMap(part => part.materialIndices))].sort((a, b) => a - b);
    const vertexCount = nodeParts.reduce((sum, part) => sum + part.vertexCount, 0);
    const finitePositionCount = nodeParts.reduce((sum, part) => sum + part.finitePositionCount, 0);
    const nonFinitePositionCount = nodeParts.reduce((sum, part) => sum + part.nonFinitePositionCount, 0);
    const indexCount = nodeParts.reduce((sum, part) => sum + part.indexCount, 0);
    const invalidIndexCount = nodeParts.reduce((sum, part) => sum + part.invalidIndexCount, 0);
    const measuredLocalBounds = union(nodeParts.map(part => part.measuredLocalBounds));
    const measuredWorldBounds = union(nodeParts.map(part => part.measuredWorldBounds));
    const cachedLocalBounds = nodeParts.every(part => part.cachedLocalBounds) ? union(nodeParts.map(part => part.cachedLocalBounds)) : null;
    const accessorDeclaredLocalBounds = nodeParts.every(part => part.accessorDeclaredLocalBounds) ? union(nodeParts.map(part => part.accessorDeclaredLocalBounds)) : null;
    const cachedBoundsMatch = nodeParts.every(part => part.cachedBoundsMatch !== false) ? (nodeParts.some(part => part.cachedBoundsMatch === null) ? null : true) : false;
    const accessorBoundsMatch = nodeParts.every(part => part.accessorBoundsMatch !== false) ? (nodeParts.some(part => part.accessorBoundsMatch === null) ? null : true) : false;
    meshNodes.push({
      nodeIndex: first.nodeIndex, meshNodeName: first.nodeName || '(unnamed)', meshIndex: first.meshIndex,
      primitiveCount: nodeParts.reduce((sum, part) => sum + part.primitiveCount, 0), primitiveIndices,
      vertexCount, finitePositionCount, nonFinitePositionCount, indexCount, invalidIndexCount,
      materialCount: materialIndices.length, materialIndices,
      materialRefsValid: nodeParts.every(part => part.materialRefsValid),
      measuredLocalBounds, measuredWorldBounds, cachedLocalBounds, accessorDeclaredLocalBounds,
      primitiveDeclarations: nodeParts.flatMap(part => part.primitiveDeclarations).sort((left, right) => left.primitiveIndex - right.primitiveIndex),
      cachedBoundsDelta: cachedBoundsMatch === null ? null : delta(asBox(measuredLocalBounds), asBox(cachedLocalBounds)),
      accessorBoundsDelta: accessorBoundsMatch === null ? null : delta(asBox(measuredLocalBounds), asBox(accessorDeclaredLocalBounds)),
      cachedBoundsMatch, accessorBoundsMatch, boundsCompareMode: 'float32-exact',
    });
  }
  const externalResources = [...(json.buffers || []), ...(json.images || [])]
    .filter(resource => resource.uri && !resource.uri.startsWith('data:'))
    .map(resource => resource.uri);
  const sceneBox = new THREE.Box3();
  for (const row of meshNodes) {
    const box = asBox(row.measuredWorldBounds);
    if (box) sceneBox.union(box);
  }
  const sceneSize = sceneBox.isEmpty() ? null : sceneBox.getSize(new THREE.Vector3()).toArray();
  const sceneBounds = sceneBox.isEmpty() ? null : { min: sceneBox.min.toArray(), max: sceneBox.max.toArray(), size: sceneSize };
  const valid = meshNodes.length > 0 && meshNodes.every(row => row.vertexCount > 0 && row.finitePositionCount === row.vertexCount && row.nonFinitePositionCount === 0 && row.invalidIndexCount === 0 && row.materialRefsValid && row.cachedBoundsMatch !== false && row.accessorBoundsMatch !== false) && externalResources.length === 0;
  return {
    status: valid ? 'measurement-complete-review-required' : 'incomplete',
    staticGeometry: { meshNodes, sceneBounds, externalResources, boundsDerivedFrom: 'native POSITION attributes transformed by matrixWorld', cachedAndAccessorBoundsCompared: true, boundsCompareMode: 'float32-exact' },
    rule: 'Static geometry bounds derive from actual POSITION values; cache/accessor metadata is compared and never trusted as measured geometry.',
  };
}

export function measureStaticGeometry(gltf, root, assetId, sourceHash = null) {
  const nodeIndices = staticNodeIndices(gltf, root);
  const baseline = measureStaticGeometryCore(gltf, root, assetId, nodeIndices);
  const meshes = [];
  root.traverse(mesh => { if (mesh.isMesh) meshes.push(mesh); });
  const controls = [];
  for (const row of baseline.staticGeometry.meshNodes) {
    const nodeMeshes = meshes.filter(mesh => nodeIndices.get(mesh) === row.nodeIndex);
    const identity = { nodeIndex: row.nodeIndex, nodeName: row.meshNodeName, meshIndex: row.meshIndex };
    const snapshot = measurement => ({ ...identity, status: measurement.status, finitePositionCount: measurement.finitePositionCount, nonFinitePositionCount: measurement.nonFinitePositionCount, bounds: measurement.measuredLocalBounds });
    const control = { id: 'G10-static-bounds-corruption:' + row.nodeIndex, gate: 'G10', assetId, sourceHash, expectedFailure: true, detectedFailure: false };
    const savedPositionBytes = new Map();
    const positionTargets = [];
    try {
      // Capture all original byte addresses before mutating any aliased typed-array view.
      for (const mesh of nodeMeshes) {
        const position = mesh.geometry.getAttribute('position');
        const array = position?.array || position?.data?.array;
        if (!array?.length) throw new Error('Native POSITION data is missing.');
        const index = position.offset || 0;
        const byteOffset = array.byteOffset + index * array.BYTES_PER_ELEMENT;
        let saved = savedPositionBytes.get(array.buffer);
        if (!saved) {
          saved = { bytes: new Uint8Array(array.buffer), originals: new Map() };
          savedPositionBytes.set(array.buffer, saved);
        }
        for (let byte = byteOffset; byte < byteOffset + array.BYTES_PER_ELEMENT; byte++) if (!saved.originals.has(byte)) saved.originals.set(byte, saved.bytes[byte]);
        positionTargets.push({ array, index });
      }
      for (const target of positionTargets) target.array[target.index] = Number.NaN;
      const after = measureStaticGeometryCore(gltf, root, assetId, nodeIndices);
      const afterRow = after.staticGeometry.meshNodes.find(item => item.nodeIndex === row.nodeIndex);
      control.measurementBefore = snapshot({ ...row, status: baseline.status });
      control.measurementAfter = { ...snapshot({ ...afterRow, status: after.status }), accepted: after.status === 'measurement-complete-review-required', injectedFault: 'non-finite-position' };
      control.detectedFailure = baseline.status === 'measurement-complete-review-required' && after.status === 'incomplete' && afterRow.nonFinitePositionCount > row.nonFinitePositionCount && afterRow.finitePositionCount < row.finitePositionCount;
    } catch (error) {
      control.reason = error?.message || String(error);
    } finally {
      for (const saved of savedPositionBytes.values()) for (const [byte, value] of saved.originals) saved.bytes[byte] = value;
    }
    control.restoredAfterTest = true;
    if (!control.detectedFailure && !control.reason) control.reason = 'The native geometry predicate did not reject the POSITION mutation.';
    controls.push(control);

    const culling = { id: 'G10-wrong-culling-bounds:' + row.nodeIndex, gate: 'G10', assetId, sourceHash, expectedFailure: true, detectedFailure: false };
    const savedCaches = [];
    const probes = [];
    const sphereRecord = sphere => ({ center: sphere.center.toArray(), radius: sphere.radius });
    const boxRecord = box => ({ min: box.min.toArray(), max: box.max.toArray() });
    try {
      for (const mesh of nodeMeshes) {
        const geometry = mesh.geometry;
        if (!savedCaches.some(saved => saved.geometry === geometry)) savedCaches.push({ geometry, box: geometry.boundingBox, boxValues: geometry.boundingBox?.clone(), sphere: geometry.boundingSphere, sphereValues: geometry.boundingSphere?.clone() });
        // Recompute from restored native POSITION, never accessor min/max or a detached probe mesh.
        const position = geometry.getAttribute('position');
        for (let vertex = 0; vertex < position.count; vertex++) if (!finiteArray([position.getX(vertex), position.getY(vertex), position.getZ(vertex)])) throw new Error('Native POSITION is non-finite before the culling probe.');
        geometry.boundingBox = new THREE.Box3().setFromBufferAttribute(geometry.getAttribute('position'));
        geometry.boundingSphere = null;
        geometry.computeBoundingSphere();
        const sphere = geometry.boundingSphere;
        const worldSphere = sphere.clone().applyMatrix4(mesh.matrixWorld);
        if (!Number.isFinite(worldSphere.radius) || !finiteArray(worldSphere.center.toArray())) throw new Error('Non-finite native culling sphere.');
        const radius = Math.max(worldSphere.radius, 0.5);
        const camera = new THREE.PerspectiveCamera(60, 1, 0.01, Math.max(100, radius * 20 + 10));
        camera.position.copy(worldSphere.center).add(new THREE.Vector3(0, 0, radius * 4 + 1));
        camera.lookAt(worldSphere.center); camera.updateMatrixWorld(true);
        const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
        const inverse = mesh.matrixWorld.clone().invert();
        const offset = worldSphere.center.clone().add(new THREE.Vector3(Math.max(10000, radius * 1000), 0, 0)).applyMatrix4(inverse).sub(worldSphere.center.clone().applyMatrix4(inverse));
        const before = { ...identity, primitiveIndex: gltf.parser.associations?.get(mesh)?.primitives ?? null, frustumVisible: frustum.intersectsObject(mesh), boundingSphere: sphereRecord(sphere), cullBounds: boxRecord(geometry.boundingBox), matrixWorld: mesh.matrixWorld.toArray(), cameraProjection: camera.projectionMatrix.toArray(), cameraWorldInverse: camera.matrixWorldInverse.toArray() };
        geometry.boundingSphere = sphere.clone(); geometry.boundingSphere.center.add(offset);
        geometry.boundingBox = geometry.boundingBox.clone().translate(offset);
        const after = { ...identity, primitiveIndex: before.primitiveIndex, frustumVisible: frustum.intersectsObject(mesh), boundingSphere: sphereRecord(geometry.boundingSphere), corruptedCullBounds: boxRecord(geometry.boundingBox), corruptionOffset: offset.toArray() };
        probes.push({ measurementBefore: before, measurementAfter: after });
      }
      const after = measureStaticGeometryCore(gltf, root, assetId, nodeIndices).staticGeometry.meshNodes.find(item => item.nodeIndex === row.nodeIndex);
      culling.measurementBefore = { ...identity, measuredLocalBounds: row.measuredLocalBounds, cachedLocalBounds: row.cachedLocalBounds, accessorDeclaredLocalBounds: row.accessorDeclaredLocalBounds, frustumVisible: probes.length > 0 && probes.every(probe => probe.measurementBefore.frustumVisible), primitives: probes.map(probe => probe.measurementBefore) };
      culling.measurementAfter = { ...identity, measuredLocalBounds: after.measuredLocalBounds, boundsMatch: after.cachedBoundsMatch, frustumVisible: probes.some(probe => probe.measurementAfter.frustumVisible), primitives: probes.map(probe => probe.measurementAfter) };
      culling.detectedFailure = baseline.status === 'measurement-complete-review-required' && culling.measurementBefore.frustumVisible && !culling.measurementAfter.frustumVisible && after.cachedBoundsMatch === false;
    } catch (error) {
      culling.reason = error?.message || String(error);
    } finally {
      for (const saved of savedCaches) {
        if (saved.box && saved.boxValues) saved.box.copy(saved.boxValues);
        if (saved.sphere && saved.sphereValues) saved.sphere.copy(saved.sphereValues);
        saved.geometry.boundingBox = saved.box; saved.geometry.boundingSphere = saved.sphere;
      }
    }
    culling.restoredAfterTest = true;
    if (!culling.detectedFailure && !culling.reason) culling.reason = 'The loaded mesh frustum predicate did not reject corrupted culling caches.';
    controls.push(culling);
    row.negativeControlIds = [control.id, culling.id];
  }
  const status = baseline.status === 'measurement-complete-review-required' && controls.length > 0 && controls.every(item => item.detectedFailure) ? 'measurement-complete-review-required' : 'incomplete';
  return { ...baseline, status, negativeControls: controls };
}
export function measureG10(root, clips, g1Measurements, boundsReader) {
  const skinBefore = inspectSkinIntegrity(root);
  const mixer = new THREE.AnimationMixer(root);
  const clipMeasurements = [];
  for (const [index, clip] of clips.entries()) {
    const times = g1Measurements.clips[index]?.sampleTimes || [];
    const action = mixer.clipAction(clip).reset();
    action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play();
    const samples = [];
    for (const time of times) {
      mixer.setTime(time); root.updateMatrixWorld(true);
      const rootPosition = root.getWorldPosition(new THREE.Vector3()).toArray().map(rounded);
      let bounds;
      try { bounds = boundsReader(root); } catch (error) { bounds = { error: error?.message || String(error), vertices: 0 }; }
      samples.push({ time, rootPosition, bounds });
    }
    const markers = clip.userData?.markers || [];
    const contacts = contactCoverage(markers, times);
    const completeDeformedBounds = samples.length >= 5 && samples.every(sample => sample.bounds?.vertices > 0 && !sample.bounds.error && Array.isArray(sample.bounds.min) && Array.isArray(sample.bounds.max) && sample.bounds.min.every(Number.isFinite) && sample.bounds.max.every(Number.isFinite));
    clipMeasurements.push({ clip: clip.name, sampleTimes: times, sampleCount: samples.length, samples, rootMotion: samples.map(sample => ({ time: sample.time, position: sample.rootPosition })), contactWindowCount: contacts.windows.length, coveredContactWindowCount: contacts.covered.length, contactCoverage: contacts.complete, deformedBoundsComplete: completeDeformedBounds });
    mixer.stopAllAction(); mixer.update(0); root.updateMatrixWorld(true);
  }
  const skinMeshes = [];
  root.traverse(object => { if (object.isSkinnedMesh) skinMeshes.push(object); });
  const semanticControls = [
    { id: 'G10-broken-planted-contact', expectedFailure: true, evaluationStatus: 'not-evaluated', detectedFailure: false, reason: 'No authored planted-effector target and position-error tolerance are available.' },
    { id: 'G10-mirrored-wrist', expectedFailure: true, evaluationStatus: 'not-evaluated', detectedFailure: false, reason: 'No authored wrist handedness or pose invariant is available.' },
    { id: 'G10-torn-skin-with-normalized-weights', expectedFailure: true, evaluationStatus: 'not-evaluated', detectedFailure: false, reason: 'No authored per-vertex skin-index/topology reference is available to detect a valid-index reassignment.' },
    { id: 'G10-wrong-lod-bind', expectedFailure: true, evaluationStatus: 'not-evaluated', detectedFailure: false, reason: 'No authored LOD bind-matrix correspondence profile is available.' },
  ];
  const controls = [...semanticControls];
  let wrongCulling = { id: 'G10-wrong-culling-bounds', expectedFailure: true, detectedFailure: false, reason: 'No native skinned mesh is available to perturb.' };
  const probeMesh = skinMeshes[0];
  if (probeMesh) {
    const previousSphere = probeMesh.boundingSphere;
    const previousSphereValues = previousSphere?.clone() ?? null;
    try {
      probeMesh.computeBoundingSphere();
      const measuredSphere = probeMesh.boundingSphere;
      if (!measuredSphere) throw new Error('No native mesh bounding sphere is available.');
      const worldSphere = measuredSphere.clone().applyMatrix4(probeMesh.matrixWorld);
      const radius = Math.max(worldSphere.radius, 0.5);
      const camera = new THREE.PerspectiveCamera(60, 1, 0.01, Math.max(100, radius * 20 + 10));
      camera.position.copy(worldSphere.center).add(new THREE.Vector3(0, 0, radius * 4 + 1));
      camera.lookAt(worldSphere.center);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld(true);
      const frustum = new THREE.Frustum();
      frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      const visibleBefore = frustum.intersectsObject(probeMesh);
      const corruptedSphere = measuredSphere.clone();
      corruptedSphere.center.x += Math.max(10000, radius * 1000);
      probeMesh.boundingSphere = corruptedSphere;
      const visibleAfter = frustum.intersectsObject(probeMesh);
      wrongCulling = {
        id: 'G10-wrong-culling-bounds', expectedFailure: true,
        measurementBefore: { frustumVisible: visibleBefore, boundingSphere: { center: measuredSphere.center.toArray(), radius: measuredSphere.radius } },
        measurementAfter: { frustumVisible: visibleAfter, boundingSphere: { center: corruptedSphere.center.toArray(), radius: corruptedSphere.radius } },
        detectedFailure: visibleBefore && !visibleAfter, restoredAfterTest: true,
      };
    } catch (error) {
      wrongCulling = { id: 'G10-wrong-culling-bounds', expectedFailure: true, detectedFailure: false, reason: error?.message || String(error) };
    } finally {
      if (previousSphere && previousSphereValues) previousSphere.copy(previousSphereValues);
      probeMesh.boundingSphere = previousSphere;
      root.updateMatrixWorld(true);
    }
  }
  let corruptWeights = { id: 'G10-corrupt-native-skin-weight', expectedFailure: true, detectedFailure: false, reason: 'No native skinned mesh is available to perturb.' };
  if (probeMesh) {
    const weights = probeMesh.geometry.getAttribute('skinWeight');
    if (weights?.array?.length) {
      const original = weights.array[0];
      try {
        weights.array[0] = -1;
        weights.needsUpdate = true;
        const broken = inspectSkinIntegrity(root);
        corruptWeights = {
          id: 'G10-corrupt-native-skin-weight', expectedFailure: true,
          measurementBefore: skinBefore.status, measurementAfter: broken.status,
          detectedFailure: broken.status === 'observed-fail' && broken.meshes.some(mesh => mesh.invalidWeights > 0),
          mesh: probeMesh.name || '(unnamed)', restoredAfterTest: true,
        };
      } catch (error) {
        corruptWeights = { id: 'G10-corrupt-native-skin-weight', expectedFailure: true, detectedFailure: false, reason: error?.message || String(error) };
      } finally {
        weights.array[0] = original;
        weights.needsUpdate = true;
      }
    }
  }
  controls.push(wrongCulling, corruptWeights);
  const missingContactControls = clipMeasurements.map(clip => {
    const removed = contactCoverage([], clip.sampleTimes);
    return {
      id: 'G10-missing-contact-window:' + clip.clip, expectedFailure: true,
      measurementBefore: clip.contactCoverage ? 'complete' : 'incomplete',
      measurementAfter: removed.complete ? 'complete' : 'incomplete',
      detectedFailure: !removed.complete, sourceClip: clip.clip,
    };
  });
  controls.push(...missingContactControls);
  const controlsValid = controls.length > 0 && controls.every(control => control.expectedFailure === true && control.detectedFailure);
  const skinValid = skinBefore.status === 'valid' && semanticControls.some(control => control.id === 'G10-torn-skin-with-normalized-weights' && control.detectedFailure);
  const motionComplete = clipMeasurements.length > 0 && clipMeasurements.every(clip => clip.deformedBoundsComplete && clip.contactCoverage);
  const status = skinValid && motionComplete && controlsValid ? 'measurement-complete-review-required' : 'incomplete';
  return {
    status, skinIntegrity: skinBefore, clips: clipMeasurements, negativeControls: controls,
    unresolvedSemanticControls: semanticControls.map(({ id, reason }) => ({ id, reason })),
    measuredRootMotion: true, contactWindowsRequired: true,
    reviewThresholds: 'not-authored; P11 locked-hardware profiling/review required',
    rule: 'Only native geometry, clips, skin and bind data are measured. Semantic corruption controls remain not-evaluated until authored targets/policies let the normal producer reject them; no bounds delta alone establishes a detected failure.',
  };
}
