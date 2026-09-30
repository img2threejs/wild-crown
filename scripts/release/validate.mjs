import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const MIME = new Map([
  ['.html', 'text/html'], ['.js', 'text/javascript'], ['.mjs', 'text/javascript'],
  ['.css', 'text/css'], ['.json', 'application/json'], ['.glb', 'model/gltf-binary'],
  ['.gltf', 'model/gltf+json'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.svg', 'image/svg+xml'],
  ['.mp3', 'audio/mpeg'], ['.ogg', 'audio/ogg'], ['.wav', 'audio/wav'],
]);
const SECRET_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|authorization|cookie|credential|password)/i;
const SIGNED_URL_KEY = /(?:^|[?&])(?:x-amz-[^=]*=|x-goog-[^=]*=|AWSAccessKeyId=|GoogleAccessId=|signature=|sig=|token=|expires=|se=|sp=|sv=)/i;
const HASH = /^[a-f0-9]{64}$/i;

function fail(errors, message) { errors.push(message); }
function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function parseGlbJson(bytes) {
  if (bytes.byteLength < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.byteLength) return null;
  const jsonLength = bytes.readUInt32LE(12);
  if (jsonLength < 2 || jsonLength % 4 !== 0 || 20 + jsonLength > bytes.byteLength || bytes.readUInt32LE(16) !== 0x4e4f534a) return null;
  const binOffset = 20 + jsonLength;
  const trailingBytes = bytes.byteLength - binOffset;
  if (trailingBytes !== 0 && (trailingBytes < 8 || bytes.readUInt32LE(binOffset + 4) !== 0x004e4942 || bytes.readUInt32LE(binOffset) + 8 !== trailingBytes)) return null;
  try {
    const json = JSON.parse(bytes.toString('utf8', 20, binOffset).replace(/[\u0000\u0020]+$/g, ''));
    if (json.asset?.version !== '2.0') return null;
    const buffers = json.buffers ?? [];
    if (!Array.isArray(buffers)) return null;
    const binaryChunkLength = trailingBytes ? bytes.readUInt32LE(binOffset) : 0;
    const embeddedLength = (uri) => {
      if (typeof uri !== 'string') return null;
      const match = /^data:[^,]*;base64,([A-Za-z0-9+/]*={0,2})$/i.exec(uri);
      return match ? Buffer.from(match[1], 'base64').byteLength : null;
    };
    if (buffers.some((buffer) => !buffer || !Number.isInteger(buffer.byteLength) || buffer.byteLength < 0 || (buffer.uri === undefined && (!trailingBytes || buffer.byteLength > binaryChunkLength)) || (buffer.uri !== undefined && embeddedLength(buffer.uri) !== buffer.byteLength))) return null;
    if (trailingBytes && (binaryChunkLength % 4 !== 0 || buffers.filter((buffer) => buffer.uri === undefined).length !== 1)) return null;
    if (!trailingBytes && buffers.some((buffer) => buffer.uri === undefined)) return null;
    const bufferViews = json.bufferViews ?? [];
    if (!Array.isArray(bufferViews) || bufferViews.some((view) => !view || !Number.isInteger(view.buffer) || !buffers[view.buffer] || !Number.isInteger(view.byteLength) || view.byteLength < 0 || !Number.isInteger(view.byteOffset ?? 0) || (view.byteOffset ?? 0) < 0 || (view.byteOffset ?? 0) + view.byteLength > buffers[view.buffer].byteLength)) return null;
    const accessors = json.accessors ?? [];
    const validComponentTypes = new Set([5120, 5121, 5122, 5123, 5125, 5126]);
    const validTypes = new Set(['SCALAR', 'VEC2', 'VEC3', 'VEC4', 'MAT2', 'MAT3', 'MAT4']);
    if (!Array.isArray(accessors) || accessors.some((accessor) => !accessor || !validComponentTypes.has(accessor.componentType) || !validTypes.has(accessor.type) || !Number.isInteger(accessor.count) || accessor.count < 0 || (accessor.bufferView !== undefined && !bufferViews[accessor.bufferView]) || (accessor.sparse && (!Number.isInteger(accessor.sparse.count) || accessor.sparse.count < 0 || accessor.sparse.count > accessor.count)))) return null;
    const componentBytes = new Map([[5120, 1], [5121, 1], [5122, 2], [5123, 2], [5125, 4], [5126, 4]]);
    const typeComponents = new Map([['SCALAR', 1], ['VEC2', 2], ['VEC3', 3], ['VEC4', 4], ['MAT2', 4], ['MAT3', 9], ['MAT4', 16]]);
    for (const accessor of accessors) {
      const width = componentBytes.get(accessor.componentType), componentCount = typeComponents.get(accessor.type);
      const matrixSide = accessor.type.startsWith('MAT') ? Number(accessor.type.slice(3)) : 0;
      const elementBytes = matrixSide ? matrixSide * Math.ceil(matrixSide * width / 4) * 4 : componentCount * width;
      if (accessor.bufferView !== undefined) {
        const view = bufferViews[accessor.bufferView], offset = accessor.byteOffset ?? 0, stride = view.byteStride ?? elementBytes;
        if (!Number.isInteger(offset) || offset < 0 || offset % width !== 0 || !Number.isInteger(stride) || stride < elementBytes || (view.byteStride !== undefined && (stride < 4 || stride > 252 || stride % 4 !== 0)) || (accessor.count > 0 && offset + (accessor.count - 1) * stride + elementBytes > view.byteLength)) return null;
      } else if (!accessor.sparse) return null;
      if (accessor.sparse) {
        const sparse = accessor.sparse, indexView = bufferViews[sparse.indices?.bufferView], valueView = bufferViews[sparse.values?.bufferView], indexWidth = componentBytes.get(sparse.indices?.componentType);
        if (!indexView || !valueView || ![5121, 5123, 5125].includes(sparse.indices.componentType) || !Number.isInteger(sparse.indices.byteOffset ?? 0) || !Number.isInteger(sparse.values.byteOffset ?? 0) || (sparse.indices.byteOffset ?? 0) + sparse.count * indexWidth > indexView.byteLength || (sparse.values.byteOffset ?? 0) + sparse.count * elementBytes > valueView.byteLength) return null;
      }
    }
    const nodes = json.nodes ?? [];
    const skins = json.skins ?? [];
    if (!Array.isArray(nodes) || !Array.isArray(skins) || nodes.some((node) => !node || (node.mesh !== undefined && !json.meshes?.[node.mesh]) || (node.skin !== undefined && !skins[node.skin])) || skins.some((skin) => !Array.isArray(skin.joints) || skin.joints.some((joint) => !Number.isInteger(joint) || !nodes[joint]) || (skin.inverseBindMatrices !== undefined && !accessors[skin.inverseBindMatrices]))) return null;
    const meshes = json.meshes ?? [];
    if (!Array.isArray(meshes) || !meshes.length || meshes.some((mesh) => !Array.isArray(mesh.primitives) || mesh.primitives.some((primitive) => {
      const position = accessors[primitive.attributes?.POSITION];
      return !primitive.attributes || Object.values(primitive.attributes).some((accessor) => !accessors[accessor]) || !position || position.type !== 'VEC3' || position.count < 1 || (primitive.indices !== undefined && (!accessors[primitive.indices] || accessors[primitive.indices].type !== 'SCALAR')) || (primitive.material !== undefined && !json.materials?.[primitive.material]);
    }))) return null;
    const scenes = json.scenes;
    const sceneIndex = json.scene ?? 0;
    const activeScene = Array.isArray(scenes) ? scenes[sceneIndex] : null;
    if (!Array.isArray(nodes) || !Array.isArray(skins) || !Array.isArray(scenes) || !activeScene || !Array.isArray(activeScene.nodes) || nodes.some((node) => !node || (node.mesh !== undefined && !meshes[node.mesh]) || (node.skin !== undefined && !skins[node.skin]) || (node.children && (!Array.isArray(node.children) || node.children.some((child) => !Number.isInteger(child) || !nodes[child])))) || skins.some((skin) => !Array.isArray(skin.joints) || skin.joints.some((joint) => !Number.isInteger(joint) || !nodes[joint]) || (skin.inverseBindMatrices !== undefined && !accessors[skin.inverseBindMatrices]))) return null;
    const sceneNodes = new Set();
    let hasRenderableMesh = false;
    const visitNode = (index) => {
      if (sceneNodes.has(index)) return false;
      sceneNodes.add(index);
      const node = nodes[index];
      if (node.mesh !== undefined) hasRenderableMesh = true;
      for (const child of node.children ?? []) if (!visitNode(child)) return false;
      return true;
    };
    if (activeScene.nodes.some((index) => !Number.isInteger(index) || !nodes[index] || !visitNode(index)) || !hasRenderableMesh) return null;
    const hasExternalUri = (value) => {
      if (Array.isArray(value)) return value.some(hasExternalUri);
      if (value && typeof value === 'object') return Object.entries(value).some(([key, child]) => key === 'uri' && typeof child === 'string' ? !child.startsWith('data:') : hasExternalUri(child));
      return false;
    };
    return hasExternalUri(json) ? null : json;
  } catch { return null; }
}
function multiply4(left, right) {
  const result = new Array(16);
  for (let column = 0; column < 4; column += 1) for (let row = 0; row < 4; row += 1) {
    result[column * 4 + row] = left[row] * right[column * 4] + left[4 + row] * right[column * 4 + 1] + left[8 + row] * right[column * 4 + 2] + left[12 + row] * right[column * 4 + 3];
  }
  return result;
}
function gltfNodeMatrix(node) {
  if (node.matrix) return node.matrix.length === 16 && node.matrix.every(Number.isFinite) ? node.matrix : null;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  if (![tx, ty, tz, x, y, z, w, sx, sy, sz].every(Number.isFinite)) return null;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [(1 - 2 * (yy + zz)) * sx, (2 * (xy + wz)) * sx, (2 * (xz - wy)) * sx, 0, (2 * (xy - wz)) * sy, (1 - 2 * (xx + zz)) * sy, (2 * (yz + wx)) * sy, 0, (2 * (xz + wy)) * sz, (2 * (yz - wx)) * sz, (1 - 2 * (xx + yy)) * sz, 0, tx, ty, tz, 1];
}
function staticWorldBounds(gltf) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], meshNodes = new Map();
  let hasVertices = false;
  const nodes = gltf.nodes ?? [], accessors = gltf.accessors ?? [], scene = gltf.scenes?.[gltf.scene ?? 0];
  const visit = (nodeIndex, parentMatrix) => {
    const node = nodes[nodeIndex], local = gltfNodeMatrix(node);
    if (!local) return false;
    const world = multiply4(parentMatrix, local);
    if (node.mesh !== undefined) {
      const nodeMin = [Infinity, Infinity, Infinity], nodeMax = [-Infinity, -Infinity, -Infinity];
      for (const primitive of gltf.meshes[node.mesh].primitives) {
        const bounds = accessors[primitive.attributes.POSITION];
        if (!Array.isArray(bounds.min) || !Array.isArray(bounds.max)) return false;
        for (let mask = 0; mask < 8; mask += 1) {
          const point = [0, 1, 2].map((axis) => (mask & (1 << axis)) ? bounds.max[axis] : bounds.min[axis]);
          const transformed = [world[0] * point[0] + world[4] * point[1] + world[8] * point[2] + world[12], world[1] * point[0] + world[5] * point[1] + world[9] * point[2] + world[13], world[2] * point[0] + world[6] * point[1] + world[10] * point[2] + world[14]];
          for (let axis = 0; axis < 3; axis += 1) {
            nodeMin[axis] = Math.min(nodeMin[axis], transformed[axis]); nodeMax[axis] = Math.max(nodeMax[axis], transformed[axis]);
            min[axis] = Math.min(min[axis], transformed[axis]); max[axis] = Math.max(max[axis], transformed[axis]);
          }
          hasVertices = true;
        }
      }
      meshNodes.set(nodeIndex, { min: nodeMin, max: nodeMax });
    }
    for (const child of node.children ?? []) if (!visit(child, world)) return false;
    return true;
  };
  if (!scene || scene.nodes.some((node) => !visit(node, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])) || !hasVertices) return null;
  return { min, max, meshNodes };
}
function sceneMeshNodes(gltf) {
  const nodes = gltf.nodes ?? [], scene = gltf.scenes?.[gltf.scene ?? 0], result = [];
  const visit = (index) => {
    const node = nodes[index];
    if (node.mesh !== undefined) result.push({ node, nodeIndex: index });
    for (const child of node.children ?? []) visit(child);
  };
  for (const index of scene?.nodes ?? []) visit(index);
  return result;
}
function safeRelative(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.startsWith('/') || relative.includes('\\')) return null;
  const resolved = path.resolve(root, relative);
  return resolved.startsWith(`${path.resolve(root)}${path.sep}`) ? resolved : null;
}
async function confinedFile(root, relative) {
  const candidate = safeRelative(root, relative);
  if (!candidate) return null;
  try {
    const rootReal = await fs.realpath(root);
    const fileReal = await fs.realpath(candidate);
    const fromRoot = path.relative(rootReal, fileReal);
    if (!fromRoot || fromRoot === '..' || fromRoot.startsWith('..' + path.sep) || path.isAbsolute(fromRoot) || !(await fs.stat(fileReal)).isFile()) return null;
    return fileReal;
  } catch { return null; }
}
function containsSensitive(value, trail = '') {
  if (typeof value === 'string') {
    if (/https?:\/\//i.test(value) && SIGNED_URL_KEY.test(value)) return `${trail}: signed provider URL`;
    if (/\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+\S+|AKIA[0-9A-Z]{16})\b/.test(value)) return `${trail}: credential-like value`;
    return null;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) { const found = containsSensitive(value[i], `${trail}[${i}]`); if (found) return found; }
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEY.test(key) && child !== null && child !== '' && child !== false) return `${trail}.${key}: secret-bearing field`;
      const found = containsSensitive(child, trail ? `${trail}.${key}` : key); if (found) return found;
    }
  }
  return null;
}
function validateStaticPropEvidence(gltf, evidence, assetId, controls) {
  const errors = [];
  const meshNodes = sceneMeshNodes(gltf);
  const accessors = gltf.accessors ?? [];
  const g6 = evidence.measurements?.G6;
  const inventory = g6?.meshInventory;
  const coverage = g6?.renderedCoverage;
  const visualViews = new Set((evidence.visualEvidence?.files ?? []).flatMap((file) => file.viewSet ?? []));
  const policy = gltf.asset?.extras?.wildCrownStaticVisibilityPolicy;
  const requiredRows = Array.isArray(policy?.requiredMeshNodes) ? policy.requiredMeshNodes : [];
  const excludedRows = Array.isArray(policy?.excludedMeshNodes) ? policy.excludedMeshNodes : [];
  const policyIds = [...requiredRows, ...excludedRows].map((row) => row?.nodeIndex);
  const policyComplete = policy?.version === 1 && policy.assetId === assetId && typeof policy.policyId === 'string' && policy.policyId.length > 0 && requiredRows.length > 0 && policyIds.every(Number.isInteger) && new Set(policyIds).size === policyIds.length && policyIds.length === meshNodes.length && meshNodes.every(({ nodeIndex }) => policyIds.includes(nodeIndex)) && requiredRows.every((row) => Number.isInteger(row.minimumVisiblePixels) && row.minimumVisiblePixels > 0 && Number.isInteger(row.minimumVisibleViews) && row.minimumVisibleViews > 0 && row.minimumVisibleViews <= 8) && excludedRows.every((row) => typeof row.reason === 'string' && row.reason.trim().length > 0);
  if (!policyComplete) fail(errors, 'Static prop ' + assetId + ' lacks an authored v1 static-visibility policy partitioning every mesh node.');
  if (!g6 || g6.policyId !== policy?.policyId || JSON.stringify(g6.requiredMeshNodes) !== JSON.stringify(requiredRows) || JSON.stringify(g6.excludedMeshNodes) !== JSON.stringify(excludedRows) || !['measurement-complete-review-required', 'passed'].includes(g6.status)) fail(errors, 'Static prop ' + assetId + ' G6 evidence does not bind its authored node policy and completed measurements.');
  const excludedMeasurements = g6?.excludedNodeMeasurements;
  if (!Array.isArray(excludedMeasurements) || excludedMeasurements.length !== excludedRows.length || excludedRows.some((row) => !excludedMeasurements.some((measurement) => measurement.nodeIndex === row.nodeIndex && measurement.reason === row.reason))) fail(errors, 'Static prop ' + assetId + ' lacks explicit G6 evidence for excluded mesh nodes.');
  if (!Array.isArray(inventory) || inventory.length !== meshNodes.length) fail(errors, 'Static prop ' + assetId + ' lacks one G6 inventory row per renderable mesh node.');
  if (!Array.isArray(coverage) || !coverage.length || coverage.some((view) => !view.viewId || !Number.isFinite(view.pixelCount) || view.pixelCount <= 0 || !visualViews.has(view.viewId))) fail(errors, 'Static prop ' + assetId + ' lacks current-output reviewed framebuffer coverage for every view.');
  const geometryMeasurement = evidence.measurements?.G10;
  if (!geometryMeasurement || !['measurement-complete-review-required', 'passed'].includes(geometryMeasurement.status)) fail(errors, 'Static prop ' + assetId + ' lacks complete G10 geometry measurements.');
  const geometry = geometryMeasurement?.staticGeometry;

  const geometryRows = geometry?.meshNodes;
  const world = staticWorldBounds(gltf);
  const finiteVector = (value) => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
  const boxMatches = (actual, min, max) => actual && finiteVector(actual.min) && finiteVector(actual.max) && actual.min.every((value, axis) => Math.abs(value - min[axis]) <= 1e-5) && actual.max.every((value, axis) => Math.abs(value - max[axis]) <= 1e-5);
  if (!Array.isArray(geometryRows) || geometryRows.length !== meshNodes.length || !Array.isArray(geometry?.externalResources) || geometry.externalResources.length !== 0 || !world) fail(errors, 'Static prop ' + assetId + ' lacks per-node G10 geometry and closed-resource inventory.');
  if (geometryRows?.length === meshNodes.length) for (let index = 0; index < meshNodes.length; index += 1) {
    const { node, nodeIndex } = meshNodes[index];
    const meshIndex = node.mesh, mesh = gltf.meshes[meshIndex], primitives = mesh?.primitives ?? [];
    const primitiveIndices = primitives.map((_, primitiveIndex) => primitiveIndex);
    const positionAccessors = primitives.map((primitive) => accessors[primitive.attributes?.POSITION]);
    const vertexCount = positionAccessors.reduce((sum, accessor) => sum + (accessor?.count ?? 0), 0);
    const indexCount = primitives.reduce((sum, primitive) => sum + (primitive.indices === undefined ? 0 : (accessors[primitive.indices]?.count ?? 0)), 0);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const accessor of positionAccessors) if (finiteVector(accessor?.min) && finiteVector(accessor?.max)) for (let axis = 0; axis < 3; axis += 1) { min[axis] = Math.min(min[axis], accessor.min[axis]); max[axis] = Math.max(max[axis], accessor.max[axis]); }
    const materialIndices = [...new Set(primitives.map((primitive) => primitive.material).filter(Number.isInteger))].sort((a, b) => a - b);
    const row = geometryRows[index], inventoryRow = inventory?.find((entry) => entry.nodeIndex === nodeIndex);
    const nodeName = node.name || '(unnamed)';
    const requiredPolicy = requiredRows.find((required) => required.nodeIndex === nodeIndex);
    const excludedPolicy = excludedRows.find((excluded) => excluded.nodeIndex === nodeIndex);
    if (!inventoryRow || inventoryRow.meshIndex !== meshIndex || inventoryRow.nodeName !== nodeName || typeof inventoryRow.visible !== 'boolean' || typeof inventoryRow.alphaVisible !== 'boolean' || inventoryRow.primitiveCount !== primitives.length || inventoryRow.vertexCount !== vertexCount || inventoryRow.indexCount !== indexCount || inventoryRow.materialCount !== materialIndices.length) fail(errors, 'Static prop ' + assetId + ' G6 inventory does not identify measured node ' + nodeIndex + '.');
    if (requiredPolicy && (!inventoryRow?.visible || !inventoryRow?.alphaVisible)) fail(errors, 'Static prop ' + assetId + ' G6 required mesh node ' + nodeIndex + ' is hidden or alpha-zero.');
    if (excludedPolicy && !excludedPolicy.reason.trim()) fail(errors, 'Static prop ' + assetId + ' excluded node ' + nodeIndex + ' lacks an authored policy reason.');
    if (requiredPolicy) {
      const control = controls.find((entry) => entry.id === 'G6-hidden-static-mesh:' + nodeIndex);
      const before = control?.measurementBefore, after = control?.measurementAfter;
      const viewCountsMatch = Array.isArray(before?.visiblePixelsByView) && Array.isArray(after?.visiblePixelsByView) && before.visiblePixelsByView.length > 0 && after.visiblePixelsByView.length === before.visiblePixelsByView.length && before.visiblePixelsByView.every(Number.isFinite);
      const visibleViews = before?.visiblePixelsByView?.filter((pixels) => pixels >= requiredPolicy.minimumVisiblePixels).length ?? 0;
      if (!control || before?.nodeIndex !== nodeIndex || after?.nodeIndex !== nodeIndex || before?.nodeName !== nodeName || after?.nodeName !== nodeName || before?.meshIndex !== meshIndex || after?.meshIndex !== meshIndex || before?.minimumVisiblePixels !== requiredPolicy.minimumVisiblePixels || after?.minimumVisiblePixels !== requiredPolicy.minimumVisiblePixels || before?.minimumVisibleViews !== requiredPolicy.minimumVisibleViews || after?.minimumVisibleViews !== requiredPolicy.minimumVisibleViews || !viewCountsMatch || visibleViews !== before.visibleViews || visibleViews < requiredPolicy.minimumVisibleViews || !after.visiblePixelsByView.every((pixels) => pixels === 0) || after.visibleViews !== 0) fail(errors, 'Static prop ' + assetId + ' lacks policy-matched rerendered G6 hide-mesh evidence for node ' + nodeIndex + '.');
    }
    const expectedWorld = world.meshNodes.get(nodeIndex);
    const exactBounds = (actual, expectedMin, expectedMax) => boxMatches(actual, expectedMin, expectedMax) && actual.min.every((value, axis) => Math.fround(value) === Math.fround(expectedMin[axis])) && actual.max.every((value, axis) => Math.fround(value) === Math.fround(expectedMax[axis]));
    const zeroDelta = (delta) => delta && Array.isArray(delta.min) && Array.isArray(delta.max) && delta.min.length === 3 && delta.max.length === 3 && delta.min.every((value) => value === 0) && delta.max.every((value) => value === 0) && delta.maxAbs === 0;
    const boundsComparison = (bounds, delta, matches, expectedMin, expectedMax) => bounds === null ? delta === null && matches === false : matches === true && zeroDelta(delta) && exactBounds(bounds, expectedMin, expectedMax);
    const g10ControlId = 'G10-static-bounds-corruption:' + nodeIndex, cullingControlId = 'G10-wrong-culling-bounds:' + nodeIndex;
    const rowBoundsAreValid = row && row.meshNodeName === nodeName && row.meshIndex === meshIndex && row.primitiveCount === primitives.length && JSON.stringify(row.primitiveIndices) === JSON.stringify(primitiveIndices) && row.vertexCount === vertexCount && row.finitePositionCount === vertexCount && row.nonFinitePositionCount === 0 && row.indexCount === indexCount && row.invalidIndexCount === 0 && row.materialCount === materialIndices.length && JSON.stringify(row.materialIndices) === JSON.stringify(materialIndices) && row.materialRefsValid === true && row.boundsCompareMode === 'float32-exact' && exactBounds(row.measuredLocalBounds, min, max) && boundsComparison(row.accessorDeclaredLocalBounds, row.accessorBoundsDelta, row.accessorBoundsMatch, min, max) && boundsComparison(row.cachedLocalBounds, row.cachedBoundsDelta, row.cachedBoundsMatch, min, max) && expectedWorld && exactBounds(row.measuredWorldBounds, expectedWorld.min, expectedWorld.max) && row.negativeControlIds?.includes(g10ControlId) && row.negativeControlIds?.includes(cullingControlId);
    if (!rowBoundsAreValid) fail(errors, 'Static prop ' + assetId + ' G10 mesh-node measurements do not match exact GLB geometry for node ' + nodeIndex + '.');
    const control = controls.find((entry) => entry.id === g10ControlId);
    const before = control?.measurementBefore, after = control?.measurementAfter;
    if (!control || before?.nodeIndex !== nodeIndex || before?.finitePositionCount !== vertexCount || !exactBounds(before?.bounds, min, max) || after?.nodeIndex !== nodeIndex || after?.accepted !== false || after?.injectedFault !== 'non-finite-position' || !Number.isInteger(after?.finitePositionCount) || after.finitePositionCount >= vertexCount) fail(errors, 'Static prop ' + assetId + ' lacks a detected non-finite-position G10 control for node ' + nodeIndex + '.');
    const cullingControl = controls.find((entry) => entry.id === cullingControlId);
    const cullingBefore = cullingControl?.measurementBefore, cullingAfter = cullingControl?.measurementAfter;
    const corruptionOffset = cullingAfter?.corruptionOffset;
    if (!cullingControl || cullingBefore?.nodeIndex !== nodeIndex || !exactBounds(cullingBefore?.measuredLocalBounds, min, max) || JSON.stringify(cullingBefore?.cachedLocalBounds ?? null) !== JSON.stringify(row.cachedLocalBounds ?? null) || JSON.stringify(cullingBefore?.accessorDeclaredLocalBounds ?? null) !== JSON.stringify(row.accessorDeclaredLocalBounds ?? null) || cullingAfter?.nodeIndex !== nodeIndex || !exactBounds(cullingAfter?.measuredLocalBounds, min, max) || !finiteVector(corruptionOffset) || !corruptionOffset.some((value) => value !== 0) || !cullingAfter?.corruptedCullBounds || boxMatches(cullingAfter.corruptedCullBounds, min, max) || cullingAfter.boundsMatch !== false) fail(errors, 'Static prop ' + assetId + ' lacks a detected wrong-culling-bounds G10 control for node ' + nodeIndex + '.');
  }
  if (geometry && world) {
    const sceneBounds = geometry.sceneBounds;
    if (!sceneBounds || !finiteVector(sceneBounds.min) || !finiteVector(sceneBounds.max) || !finiteVector(sceneBounds.size) || sceneBounds.min.some((value, axis) => Math.fround(value) !== Math.fround(world.min[axis])) || sceneBounds.max.some((value, axis) => Math.fround(value) !== Math.fround(world.max[axis])) || sceneBounds.size.some((value, axis) => Math.fround(value) !== Math.fround(world.max[axis] - world.min[axis]))) fail(errors, 'Static prop ' + assetId + ' scene bounds do not match native GLB transforms.');
  }
  return errors;
}
export async function inspectAssets({ dist, manifestPath, runtimeManifestPath, benchmarkPath, repoRoot = process.cwd() }) {
  const errors = [];
  const distRoot = path.resolve(dist);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const runtimePath = runtimeManifestPath ?? path.join(distRoot, 'assets/manifest.json');
  let emittedEntries = [];
  try {
    emittedEntries = JSON.parse(await fs.readFile(runtimePath, 'utf8'));
    if (!Array.isArray(emittedEntries)) throw new Error('expected normalized manifest array');
  } catch { fail(errors, 'Production dist is missing a valid normalized /assets/manifest.json.'); }
  if (containsSensitive(emittedEntries)) fail(errors, 'Production asset manifest contains credentials or signed provider URLs.');
  if (emittedEntries.some((entry) => !['native-glb', 'composed-recipe'].includes(entry.sourceType))) fail(errors, 'Production asset manifest contains an unsupported or unclassified entry.');
  const assets = emittedEntries.filter((entry) => entry.sourceType === 'native-glb');
  const recipes = emittedEntries.filter((entry) => entry.sourceType === 'composed-recipe');
  if (assets.length === 0) fail(errors, 'Production asset manifest declares no native GLB assets.');
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  if (assetById.size !== assets.length) fail(errors, 'Asset manifest contains duplicate native asset IDs.');
  const sourceEntries = [...(manifest.assets ?? []), ...(manifest.environmentRecipes ?? [])];
  const sourceById = new Map(sourceEntries.map((entry) => [entry.id, entry]));
  if (sourceById.size !== sourceEntries.length) fail(errors, 'Canonical source asset manifest contains duplicate IDs.');
  const emittedIds = new Set(emittedEntries.map((entry) => entry.id));
  if (emittedIds.size !== emittedEntries.length) fail(errors, 'Production asset manifest contains duplicate IDs.');
  if (sourceEntries.length !== emittedEntries.length || sourceEntries.some((entry) => !emittedIds.has(entry.id))) fail(errors, 'Production asset manifest does not match canonical source asset IDs.');
  for (const entry of emittedEntries) {
    const source = sourceById.get(entry.id);
    if (!source || source.sourceType !== entry.sourceType || source.kind !== entry.kind) fail(errors, 'Production asset ' + entry.id + ' changed canonical sourceType/kind.');
    if (source && entry.sourceType === 'native-glb') {
      for (const key of ['sourceHash', 'outputHash', 'sourceInputHash', 'nativeGlb', 'runtimeUrl', 'evidence', 'evidenceStatus', 'gates', 'requiredActionIds', 'actionToClipMapping']) if (JSON.stringify(source[key] ?? null) !== JSON.stringify(entry[key] ?? null)) fail(errors, 'Production asset ' + entry.id + ' changed canonical ' + key + '.');
    }
    if (source && entry.sourceType === 'composed-recipe') {
      for (const key of ['componentAssetIds', 'nativeGlb', 'runtimeUrl', 'evidence', 'evidenceStatus']) if (JSON.stringify(source[key] ?? null) !== JSON.stringify(entry[key] ?? null)) fail(errors, 'Production recipe ' + entry.id + ' changed canonical ' + key + '.');
    }
  }
  const inventory = [];

  const unsafeSourceMetadata = containsSensitive(manifest);
  if (unsafeSourceMetadata) fail(errors, `Source manifest metadata is not sanitized: ${unsafeSourceMetadata}.`);
  for (const asset of assets) {
    if (asset.sourceType !== 'native-glb') {
      fail(errors, `Asset ${asset.id} has unsupported non-native sourceType ${String(asset.sourceType)}.`);
      continue;
    }
    const fileRef = asset.nativeGlb;
    const runtime = asset.runtimeUrl;
    if (!fileRef || !runtime) { fail(errors, `Native asset ${asset.id} has no emitted GLB path/runtime URL.`); continue; }
    const runtimePath = runtime.replace(/^\//, '');
    if (runtime.includes('://') || runtime.includes('?') || runtime.includes('#') || !runtime.startsWith('/') || runtimePath !== fileRef) {
      fail(errors, `Native asset ${asset.id} runtimeUrl must be a local URL matching nativeGlb.`); continue;
    }
    if (!safeRelative(distRoot, runtimePath)) { fail(errors, 'Native asset ' + asset.id + ' points outside dist.'); continue; }
    const file = await confinedFile(distRoot, runtimePath);
    if (!file) { fail(errors, 'Native asset ' + asset.id + ' is missing from dist or escapes dist through a symlink: ' + runtimePath + '.'); continue; }
    const bytes = await fs.readFile(file);
    const gltf = parseGlbJson(bytes);
    if (!gltf) fail(errors, `Native asset ${asset.id} is malformed or has external GLB dependencies.`);
    const digest = sha256(bytes);
    if (typeof asset.outputHash !== 'string' || !HASH.test(asset.outputHash) || asset.outputHash.toLowerCase() !== digest) {
      fail(errors, `Native asset ${asset.id} outputHash does not match emitted bytes.`);
    }
    const contentAddress = `assets/${asset.id}/${digest}.glb`;
    if (fileRef !== contentAddress || runtime !== `/${contentAddress}`) fail(errors, `Native asset ${asset.id} path is not content-addressed by its emitted SHA-256.`);
    const sourceHash = asset.sourceHash;
    if (typeof sourceHash !== 'string' || !HASH.test(sourceHash) || sourceHash.toLowerCase() !== digest) fail(errors, 'Native asset ' + asset.id + ' sourceHash does not match the emitted source GLB bytes.');
    const sourceInputHash = asset.sourceInputHash;
    const approvedSourceInputHash = sourceById.get(asset.id)?.sourceReference?.sha256;
    if (typeof sourceInputHash !== 'string' || !HASH.test(sourceInputHash) || sourceInputHash.toLowerCase() !== String(approvedSourceInputHash ?? '').toLowerCase()) fail(errors, 'Native asset ' + asset.id + ' sourceInputHash does not match its approved source reference hash.');
    const hasRig = Boolean(gltf?.skins?.length || gltf?.animations?.length);
    const isCharacter = asset.kind === 'character';
    const isStaticProp = asset.kind === 'prop' && !hasRig;
    if (!isCharacter && asset.kind !== 'prop') fail(errors, 'Native asset ' + asset.id + ' has invalid canonical kind ' + String(asset.kind) + '.');
    const hasAssignedActionClips = Object.values(asset.actionToClipMapping ?? {}).some((clip) => clip != null);
    if (isStaticProp && (asset.rigFamily != null || hasAssignedActionClips)) fail(errors, 'Static prop ' + asset.id + ' must not carry fabricated rig/clip metadata.');
    const skinned = Boolean(gltf?.skins?.length);
    if (isCharacter && (!skinned || !gltf?.animations?.length)) fail(errors, 'Character ' + asset.id + ' must be a native skinned model with authored animations.');
    const expectedGates = isStaticProp
      ? { G1: 'not-applicable', G3: 'not-applicable', G6: 'passed', G10: 'passed', G11: 'passed', G12: 'not-applicable' }
      : isCharacter
        ? { G1: 'passed', G3: 'passed', G6: 'passed', G10: 'passed', G11: 'passed', G12: 'passed' }
        : { G1: 'passed', G3: 'passed', G6: 'passed', G10: 'passed', G11: 'passed', G12: skinned ? 'passed' : 'not-applicable' };
    const taskId = asset.providerTaskId ?? asset.provenance?.providerTaskId;
    if (typeof taskId !== 'string' || !taskId.trim()) fail(errors, 'Native asset ' + asset.id + ' lacks provider task provenance.');
    const unsafe = containsSensitive(asset, 'assets.' + asset.id);
    if (unsafe) fail(errors, 'Asset ' + asset.id + ' metadata is not sanitized: ' + unsafe + '.');
    if (asset.evidenceStatus !== 'verified' || !asset.evidence) {
      fail(errors, 'Native asset ' + asset.id + ' evidence status is not verified or has no evidence reference.');
    } else {
      const evidenceFile = await confinedFile(repoRoot, asset.evidence);
      if (!evidenceFile) fail(errors, 'Native asset ' + asset.id + ' evidence path escapes the repository.');
      else {
        try {
          const evidence = JSON.parse(await fs.readFile(evidenceFile, 'utf8'));
          if (evidence.schemaVersion !== 1 || evidence.assetId !== asset.id || evidence.sourceInputHash !== sourceInputHash || evidence.sourceHash !== digest || evidence.outputHash !== digest) fail(errors, 'Native asset ' + asset.id + ' evidence does not bind the approved input and exact measured GLB bytes.');
          for (const [gate, expected] of Object.entries(expectedGates)) {
            const actual = typeof evidence.gates?.[gate] === 'object' ? evidence.gates[gate]?.status : evidence.gates?.[gate];
            if (actual !== expected) fail(errors, 'Native asset ' + asset.id + ' gate ' + gate + ' is not ' + expected + ' for kind ' + asset.kind + '.');
            if (expected === 'not-applicable' && !(evidence.notApplicableReasons?.[gate] || evidence.gates?.[gate]?.reason || evidence.gateReasons?.[gate])) fail(errors, 'Native asset ' + asset.id + ' gate ' + gate + ' lacks an explicit non-applicability reason.');
          }
          const expectedPluginCheckIds = evidence.expectedPluginCheckIds;
          const pluginChecks = evidence.pluginChecks;
          if (!Array.isArray(expectedPluginCheckIds) || !expectedPluginCheckIds.length || expectedPluginCheckIds.some((id) => typeof id !== 'string' || !id.trim()) || (isCharacter && expectedPluginCheckIds.length < 12) || new Set(expectedPluginCheckIds).size !== expectedPluginCheckIds.length || !Array.isArray(pluginChecks) || pluginChecks.length !== expectedPluginCheckIds.length) fail(errors, 'Native asset ' + asset.id + ' lacks the complete applicable plugin check inventory.');
          else {
            const pluginById = new Map(pluginChecks.map((check) => [check?.id, check]));
            if (pluginById.size !== pluginChecks.length || expectedPluginCheckIds.some((id) => !pluginById.has(id))) fail(errors, 'Native asset ' + asset.id + ' expected plugin check IDs do not exactly match reported rows.');
            for (const check of pluginChecks) if (!check?.id || !Object.hasOwn(expectedGates, check.gate) || (check.applicable === false ? !check.reason : check.status !== 'passed')) fail(errors, 'Native asset ' + asset.id + ' has invalid plugin row ' + (check?.id ?? 'unknown') + '.');
            for (const gate of Object.keys(expectedGates).filter((name) => expectedGates[name] === 'passed')) if (!pluginChecks.some((check) => check.gate === gate && check.applicable !== false && check.status === 'passed')) fail(errors, 'Native asset ' + asset.id + ' has no passing plugin producer row for ' + gate + '.');
          }
          const controls = Array.isArray(evidence.negativeControls) ? evidence.negativeControls : [];
          const staticMeshNodes = isStaticProp ? sceneMeshNodes(gltf) : [];
          const requiredControls = isStaticProp
            ? staticMeshNodes.flatMap(({ nodeIndex }) => ['G6-hidden-static-mesh:' + nodeIndex, 'G10-static-bounds-corruption:' + nodeIndex, 'G10-wrong-culling-bounds:' + nodeIndex])
            : ['G1-disconnected-native-track', 'G3-unrestored-active-action', 'G6-hidden-required-body-part:', ...(skinned ? ['G10-corrupt-native-skin-weight'] : []), ...(gltf.animations?.length ? ['G10-missing-contact-window:'] : [])];
          for (const id of requiredControls) if (!controls.some((control) => id.endsWith(':') ? control.id?.startsWith(id) : control.id === id)) fail(errors, 'Native asset ' + asset.id + ' lacks negative control ' + id + '.');
          for (const control of controls) {
            const expectedGate = control.id?.startsWith('G1-') ? 'G1' : control.id?.startsWith('G3-') ? 'G3' : control.id?.startsWith('G6-') ? 'G6' : control.id?.startsWith('G10-') ? 'G10' : null;
            if (control.assetId !== asset.id || control.sourceHash !== digest || control.gate !== expectedGate || control.expectedFailure !== true || control.detectedFailure !== true || control.measurementBefore == null || control.measurementAfter == null || JSON.stringify(control.measurementBefore) === JSON.stringify(control.measurementAfter)) fail(errors, 'Native asset ' + asset.id + ' has incomplete/unassociated negative control ' + (control.id ?? 'unknown') + '.');
          }
          const g11 = evidence.measurements?.G11;
          const g11AfterHashes = JSON.stringify(g11?.negativeControl?.measurementAfter ?? null).match(/[a-f0-9]{64}/gi) ?? [];
          if (evidence.gates?.G11 !== 'passed' || !g11 || !['measurement-complete-review-required', 'passed'].includes(g11.status) || g11.derivativeHash !== digest || g11.frozenHash !== digest || g11.parity !== true || !g11.negativeControl?.id?.startsWith('G11-') || g11.negativeControl?.expectedFailure !== true || g11.negativeControl?.detectedFailure !== true || !JSON.stringify(g11.negativeControl?.measurementBefore).toLowerCase().includes(digest) || !g11AfterHashes.some((hash) => hash.toLowerCase() !== digest)) fail(errors, 'Native asset ' + asset.id + ' lacks exact G11 derivative freeze parity and byte-flip negative control for emitted bytes.');

          if (isCharacter) {
            const required = Array.isArray(asset.requiredActionIds) ? asset.requiredActionIds : [];
            const mapping = asset.actionToClipMapping && typeof asset.actionToClipMapping === 'object' && !Array.isArray(asset.actionToClipMapping) ? asset.actionToClipMapping : {};
            const coverage = evidence.actionCoverage;
            const requiredClipNames = required.map((actionId) => mapping[actionId]);
            const animationNames = new Set((gltf.animations ?? []).map((animation) => animation.name));
            if (!required.length || new Set(required).size !== required.length || required.some((actionId) => typeof mapping[actionId] !== 'string' || !animationNames.has(mapping[actionId])) || Object.values(mapping).some((clipName) => clipName !== null && (typeof clipName !== 'string' || !animationNames.has(clipName))) || !coverage || coverage.status !== 'passed' || JSON.stringify(coverage.requiredActionIds) !== JSON.stringify(required) || coverage.missingActionIds?.length || required.some((actionId) => !coverage.mappedClipIds?.some((item) => item.actionId === actionId && item.clipId === mapping[actionId]))) fail(errors, 'Character ' + asset.id + ' lacks complete required ActionId-to-native-animation coverage.');
            const measurements = evidence.measurements ?? {};
            const g1 = measurements.G1, g3 = measurements.G3, g6 = measurements.G6, g10 = measurements.G10;
            const complete = (row) => row && ['measurement-complete-review-required', 'passed'].includes(row.status);
            const g1ClipNames = new Set((g1?.clips ?? []).map((clip) => clip.clip));
            if (!complete(g1) || requiredClipNames.some((name) => !g1ClipNames.has(name)) || g1.clips.some((clip) => clip.sampleCount < 5 || clip.transitionBoundaryCount < 1 || !Array.isArray(clip.tracks) || !clip.tracks.length || clip.tracks.some((track) => !track.targetFound || track.sampleCount < 5 || !track.allSamplesMatch))) fail(errors, 'Character ' + asset.id + ' lacks G1 per-clip binding/sample and transition-boundary producer measurements.');
            const g3ClipNames = new Set((g3?.clipRestores ?? []).map((clip) => clip.clip));
            if (!complete(g3) || g3.boneCount < 1 || requiredClipNames.some((name) => !g3ClipNames.has(name)) || g3.clipRestores.some((clip) => !clip.stop?.localRestored || !clip.stop?.worldRestored || !clip.reset?.localRestored || !clip.reset?.worldRestored)) fail(errors, 'Character ' + asset.id + ' lacks G3 stop/reset pose-restore producer measurements.');
            const g6Measurement = g6;
            const species = evidence.speciesCoverage;
            const g6ControlsComplete = Boolean(g6 && Array.isArray(g6.negativeControls) && Array.isArray(g6.parts) && g6.parts.every((part) => {
              const control = g6.negativeControls.find((item) => item.id === part.negativeControlId);
              return control?.expectedFailure === true && control.detectedFailure === true && Array.isArray(control.measurementBefore) && control.measurementBefore.some((pixels) => pixels > 0) && Array.isArray(control.measurementAfter) && control.measurementAfter.every((pixels) => pixels === 0);
            }));
            if (!complete(g6) || !Array.isArray(g6.meshInventory) || !g6.meshInventory.length || !Array.isArray(g6.parts) || !g6.parts.length || !g6.parts.every((part) => part.visible === true && part.visibleViews >= part.minimumVisibleViews) || !g6.policyValid || !g6.annotationsComplete || !g6.visibleComplete || !g6ControlsComplete || !species || species.status !== g6.status || species.measurement?.species !== asset.species || JSON.stringify(species.measurement) !== JSON.stringify(g6Measurement)) fail(errors, 'Character ' + asset.id + ' lacks measured G6 visibility and species-specific applicability evidence.');
            if (!complete(g10) || !g10.measuredRootMotion || requiredClipNames.some((name) => !g10ClipNames.has(name)) || g10.clips.some((clip) => clip.sampleCount < 5 || !clip.deformedBoundsComplete || (clip.contactWindowCount > 0 && (!clip.contactCoverage || clip.coveredContactWindowCount !== clip.contactWindowCount)))) fail(errors, 'Character ' + asset.id + ' lacks G10 per-action deformed-bounds/root-motion/contact producer measurements.');
          }
          if (asset.kind === 'prop' && !isStaticProp) {
            const measurements = evidence.measurements ?? {};
            const g1 = measurements.G1, g3 = measurements.G3, g6 = measurements.G6, g10 = measurements.G10;
            const complete = (row) => row && ['measurement-complete-review-required', 'passed'].includes(row.status);
            const animationNames = new Set((gltf.animations ?? []).map((animation) => animation.name));
            const required = Array.isArray(asset.requiredActionIds) ? asset.requiredActionIds : [];
            const mapping = asset.actionToClipMapping && typeof asset.actionToClipMapping === 'object' && !Array.isArray(asset.actionToClipMapping) ? asset.actionToClipMapping : {};
            if (!complete(g1) || [...animationNames].some((name) => !g1.clips?.some((clip) => clip.clip === name && clip.sampleCount >= 5 && Array.isArray(clip.tracks) && clip.tracks.length > 0 && clip.tracks.every((track) => track.targetFound && track.sampleCount >= 5 && track.allSamplesMatch)))) fail(errors, 'Animated prop ' + asset.id + ' lacks G1 per-animation binding measurements.');
            if (!complete(g3) || [...animationNames].some((name) => !g3.clipRestores?.some((clip) => clip.clip === name && clip.stop?.localRestored && clip.stop?.worldRestored && clip.reset?.localRestored && clip.reset?.worldRestored))) fail(errors, 'Animated prop ' + asset.id + ' lacks G3 per-animation pose-restore measurements.');
            if (!complete(g6) || !Array.isArray(g6.meshInventory) || !g6.meshInventory.length) fail(errors, 'Animated prop ' + asset.id + ' lacks G6 mesh visibility measurements.');
            if (!complete(g10) || !g10.measuredRootMotion || [...animationNames].some((name) => !g10.clips?.some((clip) => clip.clip === name && clip.sampleCount >= 5 && clip.deformedBoundsComplete && (clip.contactWindowCount === 0 || clip.contactCoverage)))) fail(errors, 'Animated prop ' + asset.id + ' lacks G10 per-animation bounds/contact measurements.');
            if (required.length && (required.some((actionId) => typeof mapping[actionId] !== 'string' || !animationNames.has(mapping[actionId])) || evidence.actionCoverage?.status !== 'passed' || evidence.actionCoverage.missingActionIds?.length)) fail(errors, 'Animated prop ' + asset.id + ' lacks required ActionId coverage.');
          }
          if (skinned) {
            const g12 = evidence.measurements?.G12;
            const expectedSkins = gltf.skins ?? [];
            const skinnedNodes = (gltf.nodes ?? []).map((node, nodeIndex) => ({ node, nodeIndex })).filter(({ node }) => Number.isInteger(node.skin) && Number.isInteger(node.mesh));
            const skinRows = Array.isArray(g12?.skins) ? g12.skins : [];
            const skinRowsMatch = Boolean(g12) && skinnedNodes.length > 0 && skinRows.length === skinnedNodes.length && skinRows.every((row, index) => {
              const { node, nodeIndex } = skinnedNodes[index], skinIndex = node.skin, nativeSkin = expectedSkins[skinIndex], expectedIndices = nativeSkin?.joints, mesh = gltf.meshes[node.mesh];
              const expectedMeshName = mesh?.name || '(unnamed)', expectedNodeName = node.name ?? null, expectedSkinName = nativeSkin?.name ?? null;
              const control = g12?.negativeControls?.find((item) => item.id === row.negativeControlId);
              return Array.isArray(expectedIndices) && expectedIndices.length > 0 && row.mesh === expectedMeshName && row.skin === expectedSkinName && row.meshNodeIndex === nodeIndex && row.skinIndex === skinIndex && row.meshNodeName === expectedNodeName && row.skinName === expectedSkinName && Number.isInteger(nativeSkin.inverseBindMatrices) && row.inverseBindAccessor === nativeSkin.inverseBindMatrices && row.exactCorrespondence === true && row.valid === true && row.inverseBindAccessorValid === true && row.runtimeInverseBindValid === true && row.jointCount === expectedIndices.length && row.correspondenceCount === expectedIndices.length && row.runtimeInverseBindCount === expectedIndices.length && JSON.stringify(row.expectedNodeIndices) === JSON.stringify(expectedIndices) && JSON.stringify(row.actualNodeIndices) === JSON.stringify(expectedIndices) && control?.id?.startsWith('G12-reordered-native-joints:') && control.assetId === asset.id && control.sourceHash === digest && control.expectedFailure === true && control.detectedFailure === true && JSON.stringify(control.measurementBefore?.expectedNodeIndices) === JSON.stringify(expectedIndices) && JSON.stringify(control.measurementBefore?.actualNodeIndices) === JSON.stringify(expectedIndices) && JSON.stringify(control.measurementAfter?.actualNodeIndices) !== JSON.stringify(expectedIndices);
            });
            const expectedJointCount = skinRows.reduce((sum, row) => sum + (row.jointCount ?? 0), 0);
            if (!g12 || !['measurement-complete-review-required', 'passed'].includes(g12.status) || g12.skinCount !== expectedSkins.length || g12.skinnedMeshCount !== skinnedNodes.length || g12.jointCount !== expectedJointCount || g12.correspondenceCount !== g12.jointCount || !skinRowsMatch) fail(errors, 'Native asset ' + asset.id + ' lacks measured G12 native-to-runtime joint correspondence and per-mesh reordered-joint negative controls.');
          }
          if (isStaticProp) {
            if (gltf.skins?.length || gltf.animations?.length) fail(errors, 'Static prop ' + asset.id + ' unexpectedly contains skin/animation structures.');
            if (!evidence.notApplicableReasons?.G1 || !evidence.notApplicableReasons?.G3 || !evidence.notApplicableReasons?.G12) fail(errors, 'Static prop ' + asset.id + ' lacks explicit no-skin/no-animation G1/G3/G12 applicability reasons.');
            errors.push(...validateStaticPropEvidence(gltf, evidence, asset.id, controls));
          }
          if (containsSensitive(evidence)) fail(errors, 'Native asset ' + asset.id + ' evidence contains credentials or signed URLs.');
        } catch { fail(errors, 'Native asset ' + asset.id + ' evidence file is missing or invalid JSON.'); }
      }
    }
    for (const [gate, expected] of Object.entries(expectedGates)) {
      const actual = typeof asset.gates?.[gate] === 'object' ? asset.gates[gate]?.status : asset.gates?.[gate];
      if (actual !== expected) fail(errors, 'Native asset ' + asset.id + ' manifest gate ' + gate + ' is not ' + expected + '.');
    }
    inventory.push({ path: runtimePath, bytes: bytes.length, sha256: digest, kind: 'native-glb', assetId: asset.id });
  }
  for (const recipe of recipes) {
    if (recipe.kind !== 'environment' || recipe.sourceType !== 'composed-recipe') fail(errors, 'Environment recipe ' + recipe.id + ' must retain canonical environment/composed-recipe kind.');
    if (recipe.nativeGlb != null || recipe.runtimeUrl != null || ['sourceHash', 'outputHash', 'sourceInputHash'].some((key) => recipe[key] != null)) fail(errors, 'Environment recipe ' + recipe.id + ' must not claim GLB bytes, hashes or a runtime URL.');
    if (!Array.isArray(recipe.componentAssetIds) || recipe.componentAssetIds.length === 0 || new Set(recipe.componentAssetIds).size !== recipe.componentAssetIds.length) fail(errors, 'Environment recipe ' + recipe.id + ' must declare a non-empty unique component set.');
    const componentOutputHashes = {};
    for (const id of recipe.componentAssetIds ?? []) {
      const component = assetById.get(id);
      if (!component || component.sourceType !== 'native-glb') fail(errors, 'Environment recipe ' + recipe.id + ' references unresolved native component ' + id + '.');
      componentOutputHashes[id] = component?.outputHash ?? null;
      if (!HASH.test(componentOutputHashes[id] ?? '')) fail(errors, 'Environment recipe ' + recipe.id + ' has a component without verified native output bytes: ' + id + '.');
    }
    if (recipe.evidenceStatus === 'verified' && Object.values(componentOutputHashes).some((hash) => !HASH.test(hash ?? ''))) fail(errors, 'Environment recipe ' + recipe.id + ' cannot be verified without current component GLB hashes.');
    if (recipe.evidenceStatus !== 'verified' || typeof recipe.evidence !== 'string') fail(errors, 'Environment recipe ' + recipe.id + ' has no verified scene qualification evidence.');
    else {
      const evidenceFile = await confinedFile(repoRoot, recipe.evidence);
      if (!evidenceFile) fail(errors, 'Environment recipe ' + recipe.id + ' evidence path is missing or escapes the repository.');
      else try {
        const evidence = JSON.parse(await fs.readFile(evidenceFile, 'utf8'));
        if (evidence.schemaVersion !== 1 || evidence.recipeId !== recipe.id || evidence.status !== 'verified' || JSON.stringify([...(evidence.componentAssetIds ?? [])].sort()) !== JSON.stringify([...recipe.componentAssetIds].sort()) || !evidence.componentOutputHashes || typeof evidence.componentOutputHashes !== 'object' || Array.isArray(evidence.componentOutputHashes) || JSON.stringify(Object.keys(evidence.componentOutputHashes).sort()) !== JSON.stringify([...recipe.componentAssetIds].sort()) || recipe.componentAssetIds.some((id) => evidence.componentOutputHashes[id] !== componentOutputHashes[id])) fail(errors, 'Environment recipe ' + recipe.id + ' scene evidence does not bind its exact component set/output hashes/qualification.');
        if (!Array.isArray(evidence.sceneEvidence) || evidence.sceneEvidence.length === 0) fail(errors, 'Environment recipe ' + recipe.id + ' has no measured scene evidence.');
        for (const item of evidence.sceneEvidence ?? []) {
          const sceneFile = await confinedFile(repoRoot, item.path);
          if (!sceneFile || !HASH.test(item.sha256 ?? '') || sha256(await fs.readFile(sceneFile)) !== item.sha256) fail(errors, 'Environment recipe ' + recipe.id + ' has missing or mismatched scene evidence.');
        }
        if (containsSensitive(evidence)) fail(errors, 'Environment recipe ' + recipe.id + ' evidence contains secrets or signed URLs.');
      } catch { fail(errors, 'Environment recipe ' + recipe.id + ' evidence is missing or invalid JSON.'); }
    }
  }

  const files = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        const rel = path.relative(distRoot, full).split(path.sep).join('/');
        if (rel === 'release-manifest.json') continue;
        const bytes = await fs.readFile(full);
        files.push({ path: rel, bytes: bytes.length, sha256: sha256(bytes), mime: MIME.get(path.extname(rel).toLowerCase()) ?? 'application/octet-stream' });
      }
    }
  }
  await walk(distRoot);
  const html = files.find((file) => file.path === 'index.html');
  if (!html) fail(errors, 'Production dist is missing index.html.');
  const compatibilityPath = path.join(distRoot, 'release-compatibility.json');
  let compatibility = {};
  try { compatibility = JSON.parse(await fs.readFile(compatibilityPath, 'utf8')); }
  catch { fail(errors, 'Production build is missing authoritative dist/release-compatibility.json.'); }
  const manifestMeta = { schemaVersion: manifest.schemaVersion, manifestVersion: manifest.manifestVersion, buildSchema: compatibility.buildSchema ?? null, saveSchema: compatibility.saveSchema ?? null };
  if (!Number.isInteger(manifestMeta.buildSchema) || !Number.isInteger(manifestMeta.saveSchema) || !compatibility.authority) fail(errors, 'Release compatibility must identify authoritative integer build/save schema exports.');
  const emittedFiles = files.sort((a, b) => a.path.localeCompare(b.path));
  const buildIdentity = sha256(JSON.stringify(emittedFiles));
  const benchmarkFile = benchmarkPath ?? path.join(repoRoot, 'evidence/release/benchmarks.json');
  try {
    const benchmark = JSON.parse(await fs.readFile(benchmarkFile, 'utf8'));
    const reference = JSON.parse(await fs.readFile(path.join(repoRoot, 'docs/implementation/reference-profile.json'), 'utf8'));
    const routeDoc = await fs.readFile(path.join(repoRoot, 'docs/implementation/BENCHMARK-ROUTES.md'), 'utf8');
    const requiredRoutes = [...routeDoc.matchAll(/^\|\s*([a-z0-9-]+)\s*\|/gm)].map((match) => match[1]);
    const performance = reference.performanceTarget;
    if (benchmark.schemaVersion !== 1 || benchmark.buildIdentity !== buildIdentity || !Number.isFinite(Date.parse(benchmark.measuredAt))) fail(errors, 'Benchmark must identify the current emitted build and measurement time.');
    if (benchmark.hardwareProfile !== undefined || benchmark.limits !== undefined || benchmark.thresholds !== undefined) fail(errors, 'Benchmark must not supply self-selected hardware profiles or threshold limits.');
    for (const key of ['model', 'chip', 'memory', 'cpu']) if (benchmark.hardware?.[key] !== reference.hardware[key]) fail(errors, 'Benchmark hardware ' + key + ' differs from the locked reference profile.');
    for (const key of ['userAgent', 'platform', 'webgl2', 'version', 'renderer', 'vendor', 'devicePixelRatio']) if (benchmark.browser?.[key] !== reference.browser[key]) fail(errors, 'Benchmark browser ' + key + ' differs from the locked reference profile.');
    if (JSON.stringify(benchmark.browser?.viewport) !== JSON.stringify(reference.browser.viewport)) fail(errors, 'Benchmark browser viewport differs from the locked reference profile.');
    if (benchmark.viewport?.width !== performance.width || benchmark.viewport?.height !== performance.height || benchmark.viewport?.dpr !== performance.dpr) fail(errors, 'Benchmark viewport differs from the locked performance target.');
    for (const key of ['source', 'content', 'assets', 'settings']) if (typeof benchmark.revisions?.[key] !== 'string' || !benchmark.revisions[key]) fail(errors, 'Benchmark is missing pinned ' + key + ' revision.');
    if (!benchmark.seed || !benchmark.checkpointHistoryFixtureId) fail(errors, 'Benchmark is missing seed/checkpoint-history fixture identity.');
    const routes = Array.isArray(benchmark.routes) ? benchmark.routes : [];
    const routeMap = new Map(routes.map((route) => [route.id, route]));
    if (routes.length !== requiredRoutes.length || routeMap.size !== routes.length || requiredRoutes.some((id) => !routeMap.has(id))) fail(errors, 'Benchmark must include each authored route exactly once.');
    const timing = (measurement, name, unit) => {
      if (!measurement || !Number.isFinite(measurement.value) || measurement.value < 0 || measurement.unit !== unit) fail(errors, 'Benchmark route metric ' + name + ' requires a non-negative numeric ' + unit + ' value.');
      if (measurement && ['limit', 'threshold', 'operator', 'comparison'].some((key) => Object.hasOwn(measurement, key))) fail(errors, 'Benchmark route metric ' + name + ' must not override fixed reference limits.');
      return measurement?.value;
    };
    for (const route of routes) {
      const metrics = route.metrics ?? {};
      const allowedMetrics = new Set(['fps', 'p95FrameInterval', 'p99FrameInterval', 'cpuSimulationP95', 'cpuAnimationP95', 'cpuRenderP95', 'gpuTiming']);
      if (Object.keys(metrics).some((name) => !allowedMetrics.has(name))) fail(errors, 'Benchmark route ' + route.id + ' contains an unrecognized metric.');
      const fps = timing(metrics.fps, 'fps', 'fps');
      const p95 = timing(metrics.p95FrameInterval, 'p95FrameInterval', 'ms');
      const p99 = timing(metrics.p99FrameInterval, 'p99FrameInterval', 'ms');
      if (fps < performance.targetFps) fail(errors, 'Benchmark route ' + route.id + ' is below the fixed FPS target.');
      if (p95 > performance.p95FrameIntervalMs) fail(errors, 'Benchmark route ' + route.id + ' exceeds fixed p95 frame interval.');
      if (p99 > performance.p99FrameIntervalMs) fail(errors, 'Benchmark route ' + route.id + ' exceeds fixed p99 frame interval.');
      for (const name of ['cpuSimulationP95', 'cpuAnimationP95', 'cpuRenderP95']) timing(metrics[name], name, 'ms');
      const gpu = metrics.gpuTiming;
      if (!gpu || !['measured', 'unavailable'].includes(gpu.status)) fail(errors, 'Benchmark route ' + route.id + ' must record GPU timing as measured or unavailable.');
      else if (gpu.status === 'measured') timing(gpu.p95, 'gpuTiming.p95', 'ms');
      else if (typeof gpu.reason !== 'string' || !gpu.reason) fail(errors, 'Benchmark route ' + route.id + ' must explain unavailable GPU timing.');
      if (!route.seed || !route.checkpointHistoryFixtureId) fail(errors, 'Benchmark route ' + route.id + ' lacks reproducible seed/checkpoint identity.');
    }
    if (containsSensitive(benchmark)) fail(errors, 'Performance benchmark contains credentials or signed provider URLs.');
  } catch (error) { fail(errors, error.code === 'ENOENT' ? 'Measured release benchmark or reference benchmark contract is missing.' : 'Measured release benchmark is invalid JSON or schema.'); }
  return { errors, inventory: emittedFiles, nativeAssets: inventory, manifestMeta, buildIdentity };
}

export async function verifyPreview(dist, nativeAssets, port = 0, repoRoot = process.cwd(), configFile) {
  const errors = [];
  const { spawn } = await import('node:child_process');
  const { createServer } = await import('node:net');
  if (!port) {
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    port = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
  }
  const viteCli = path.join(repoRoot, 'node_modules/vite/bin/vite.js');
  const previewArgs = [viteCli, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--outDir', path.resolve(dist)];
  if (configFile) previewArgs.push('--config', configFile);
  const child = spawn(process.execPath, previewArgs, { cwd: repoRoot, stdio: ['ignore', 'ignore', 'pipe'] });
  let previewError = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { previewError = (previewError + chunk).slice(-2000); });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (child.exitCode !== null) break;
      try { const response = await fetch(`${base}/`); if (response.status === 200) { ready = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) fail(errors, 'Could not start the Vite production preview server: ' + (previewError.trim() || 'no preview response'));
    let rootHtml = null;
    for (const route of ['/', '/release-validation-deep-link']) {
      const response = await fetch(base + route);
      if (response.status !== 200) { fail(errors, 'Production preview route ' + route + ' returned HTTP ' + response.status + '.'); continue; }
      if (!(response.headers.get('content-type') ?? '').startsWith('text/html')) fail(errors, 'Production preview route ' + route + ' did not serve HTML MIME.');
      const htmlBytes = Buffer.from(await response.arrayBuffer());
      const html = htmlBytes.toString('utf8');
      if ((response.headers.get('cache-control') ?? '') !== 'no-cache') fail(errors, 'Application HTML cache policy is not no-cache for ' + route + '.');
      if (route === '/') {
        const indexFile = await confinedFile(dist, 'index.html');
        if (!indexFile || !htmlBytes.equals(await fs.readFile(indexFile))) fail(errors, 'Production preview root HTML bytes differ from emitted index.html.');
        rootHtml = html;
        const scripts = [...html.matchAll(/<script\b([^>]*)>/gi)].map((match) => match[1]);
        const moduleUrls = scripts.filter((attrs) => /\btype\s*=\s*(['"])module\1/i.test(attrs)).map((attrs) => attrs.match(/\bsrc\s*=\s*(['"])(.*?)\1/i)?.[2]).filter(Boolean);
        if (moduleUrls.length === 0) fail(errors, 'Production entry has no external module script.');
        for (const moduleUrl of moduleUrls) {
          try {
            const resolved = new URL(moduleUrl, base);
            const modulePath = decodeURIComponent(resolved.pathname.replace(/^\//, ''));
            if (resolved.origin !== new URL(base).origin || resolved.search || resolved.hash || !safeRelative(dist, modulePath)) { fail(errors, 'Production entry module does not resolve to an emitted local file: ' + moduleUrl + '.'); continue; }
            const moduleFile = await confinedFile(dist, modulePath);
            if (!moduleFile) { fail(errors, 'Production entry module does not resolve to an emitted local file: ' + moduleUrl + '.'); continue; }
            const moduleResponse = await fetch(resolved.href);
            if (moduleResponse.status !== 200) { fail(errors, 'Production entry module ' + moduleUrl + ' returned HTTP ' + moduleResponse.status + '.'); continue; }
            if (!(moduleResponse.headers.get('content-type') ?? '').startsWith('text/javascript')) fail(errors, 'Production entry module ' + moduleUrl + ' did not serve JavaScript MIME.');
            const served = Buffer.from(await moduleResponse.arrayBuffer());
            const emitted = await fs.readFile(moduleFile);
            if (!served.equals(emitted)) fail(errors, 'Production entry module ' + moduleUrl + ' bytes differ from emitted dist.');
            if (/(?:-|\.)[a-f0-9]{8,}(?:\.|$)/i.test(path.basename(moduleFile)) && !(moduleResponse.headers.get('cache-control') ?? '').includes('immutable')) fail(errors, 'Hashed entry module ' + moduleUrl + ' is missing immutable cache policy.');
          } catch { fail(errors, 'Production entry module URL is missing or invalid: ' + moduleUrl + '.'); }
        }
      } else {
        if (html !== rootHtml) fail(errors, 'Production deep link did not serve the application entry document.');
        if ((response.headers.get('cache-control') ?? '') !== 'no-cache') fail(errors, 'Deep-link HTML cache policy is not no-cache for ' + route + '.');
      }
    }
    for (const asset of nativeAssets) {
      const response = await fetch(base + '/' + asset.path);
      if (response.status !== 200) { fail(errors, 'Preview asset ' + asset.path + ' returned HTTP ' + response.status + '.'); continue; }
      if (!(response.headers.get('content-type') ?? '').startsWith('model/gltf-binary')) fail(errors, 'Preview asset ' + asset.path + ' has incorrect GLB MIME.');
      const cacheControl = response.headers.get('cache-control') ?? '';
      const contentAddressed = asset.path === 'assets/' + asset.assetId + '/' + asset.sha256 + '.glb';
      if (!cacheControl || !contentAddressed || !cacheControl.includes('immutable')) fail(errors, 'Preview asset ' + asset.path + ' must use a SHA-256 URL with immutable cache policy.');
      if (sha256(Buffer.from(await response.arrayBuffer())) !== asset.sha256) fail(errors, 'Preview asset ' + asset.path + ' bytes differ from dist inventory.');
    }
  } catch (error) { fail(errors, `Production preview probe failed: ${error.message}`); }
  finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
  }
  return errors;
}

async function main() {
  const args = process.argv.slice(2);
  const get = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
  const repoRoot = path.resolve(get('--repo', process.cwd()));
  const dist = path.resolve(get('--dist', path.join(repoRoot, 'dist')));
  const manifestPath = path.resolve(get('--manifest', path.join(repoRoot, 'asset-source/manifest.json')));
  const benchmarkPath = path.resolve(get('--benchmarks', path.join(repoRoot, 'evidence/release/benchmarks.json')));
  const runtimeManifestArg = get('--runtime-manifest', null);
  const runtimeManifestPath = runtimeManifestArg ? path.resolve(runtimeManifestArg) : undefined;
  const configArg = get('--config', null);
  const configFile = configArg ? path.resolve(configArg) : undefined;
  const viteRoot = path.resolve(get('--vite-root', repoRoot));
  const port = Number(get('--port', '4179'));
  const result = await inspectAssets({ dist, manifestPath, runtimeManifestPath, benchmarkPath, repoRoot });
  result.errors.push(...await verifyPreview(dist, result.nativeAssets, port, viteRoot, configFile));
  process.stdout.write(`${JSON.stringify({ accepted: result.errors.length === 0, manifest: result.manifestMeta, inventory: result.inventory, errors: result.errors }, null, 2)}\n`);
  if (result.errors.length) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(`Release validation failed: ${error.message}`); process.exitCode = 1; });
