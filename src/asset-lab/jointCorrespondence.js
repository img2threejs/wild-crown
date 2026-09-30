function sameIndexList(expected, actual) {
  if (expected.length !== actual.length) return { exact: false, correspondenceCount: 0 };
  const correspondenceCount = expected.reduce((count, value, index) => count + (value === actual[index] ? 1 : 0), 0);
  return { exact: correspondenceCount === expected.length, correspondenceCount };
}
function uniqueNodeIndexByName(json, boneName) {
  const found = [];
  (json.nodes || []).forEach((node, index) => { if (node.name === boneName) found.push(index); });
  return found.length === 1 ? found[0] : null;
}
export function measureJointCorrespondence(gltf, root, kind) {
  const json = gltf.parser.json;
  const skins = json.skins || [];
  const skinnedMeshes = [];
  root.traverse(object => { if (object.isSkinnedMesh) skinnedMeshes.push(object); });
  if (!skins.length && !skinnedMeshes.length) return kind === "prop"
    ? { status: "not-applicable", reason: "static native prop has no skin or joints", jointCount: 0, correspondenceCount: 0, negativeControls: [] }
    : { status: "incomplete", reason: "character GLB has no native skin/joint graph", jointCount: 0, correspondenceCount: 0, negativeControls: [] };
  const results = [];
  const controls = [];
  for (const mesh of skinnedMeshes) {
    const associations = gltf.parser.associations;
    const meshNode = associations?.get(mesh)?.nodes;
    let skinIndex = Number.isInteger(meshNode) ? json.nodes?.[meshNode]?.skin : undefined;
    if (!Number.isInteger(skinIndex)) {
      skinIndex = skins.findIndex(skin => skin.joints?.length === mesh.skeleton.bones.length && skin.joints.every((nodeIndex,index) => json.nodes[nodeIndex]?.name === mesh.skeleton.bones[index]?.name));
    }
    const skin = Number.isInteger(skinIndex) && skinIndex >= 0 ? skins[skinIndex] : null;
    const meshNodeIndex = Number.isInteger(meshNode) ? meshNode : null;
    const meshNodeName = meshNodeIndex === null ? null : json.nodes?.[meshNodeIndex]?.name || null;
    if (!skin) {
      results.push({ mesh: mesh.name || "(unnamed)", meshNodeIndex, meshNodeName, skin: null, skinIndex: Number.isInteger(skinIndex) && skinIndex >= 0 ? skinIndex : null, status: "observed-fail", reason: "loaded SkinnedMesh does not correspond to a native glTF skin" });
      continue;
    }
    const expectedNodeIndices = [...(skin.joints || [])];
    const actualNodeIndices = mesh.skeleton.bones.map((bone,index) => {
      const fromAssociation = associations?.get(bone)?.nodes;
      if (Number.isInteger(fromAssociation)) return fromAssociation;
      const fallback = uniqueNodeIndexByName(json, bone.name);
      return fallback === null ? -(index + 1) : fallback;
    });
    const comparison = sameIndexList(expectedNodeIndices, actualNodeIndices);
    const accessor = Number.isInteger(skin.inverseBindMatrices) ? json.accessors?.[skin.inverseBindMatrices] : null;
    const inverseBindAccessorValid = !accessor || (accessor.type === "MAT4" && accessor.count === expectedNodeIndices.length);
    const runtimeInverseBindValid = mesh.skeleton.boneInverses.length === expectedNodeIndices.length;
    const brokenActual = [...actualNodeIndices].reverse();
    const brokenComparison = sameIndexList(expectedNodeIndices, brokenActual);
    const control = { id: "G12-reordered-native-joints:skin-" + skinIndex + ":node-" + (meshNodeIndex === null ? (mesh.name || "unnamed") : meshNodeIndex), expectedFailure: true, measurementBefore: { expectedNodeIndices, actualNodeIndices, correspondenceCount: comparison.correspondenceCount }, measurementAfter: { actualNodeIndices: brokenActual, correspondenceCount: brokenComparison.correspondenceCount }, detectedFailure: comparison.exact && !brokenComparison.exact, assetId: null, sourceHash: null };
    controls.push(control);
    results.push({ mesh: mesh.name || "(unnamed)", meshNodeIndex, meshNodeName, skin: skin.name || null, skinIndex, jointCount: expectedNodeIndices.length, expectedNodeIndices, actualNodeIndices, correspondenceCount: comparison.correspondenceCount, exactCorrespondence: comparison.exact, inverseBindAccessor: skin.inverseBindMatrices ?? null, inverseBindAccessorValid, runtimeInverseBindCount: mesh.skeleton.boneInverses.length, runtimeInverseBindValid, valid: comparison.exact && inverseBindAccessorValid && runtimeInverseBindValid, negativeControlId: control.id });
  }
  const complete = skins.length > 0 && results.length === skinnedMeshes.length && results.length > 0 && results.every(result => result.valid) && controls.length === results.length && controls.every(control => control.detectedFailure);
  return { status: complete ? "measurement-complete-review-required" : "incomplete", skinCount: skins.length, skinnedMeshCount: skinnedMeshes.length, jointCount: results.reduce((sum,item) => sum + (item.jointCount || 0),0), correspondenceCount: results.reduce((sum,item) => sum + (item.correspondenceCount || 0),0), uniqueJointNodeCount: new Set(results.flatMap(item => item.expectedNodeIndices || [])).size, uniqueCorrespondenceNodeCount: new Set(results.filter(item => item.exactCorrespondence).flatMap(item => item.actualNodeIndices || [])).size, skins: results, negativeControls: controls };
}
