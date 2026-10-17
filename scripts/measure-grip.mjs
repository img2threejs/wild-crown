// Focused measurement of native hand vs weapon geometry to capture the actual current state.
// Bypasses only image decoding.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { BufferAttribute, Group, Mesh, MeshStandardMaterial, PropertyBinding, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const k = args.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (k < 0) return fallback;
  const inline = args[k].indexOf('=');
  return inline >= 0 ? args[k].slice(inline + 1) : args[k + 1];
};

const root = resolve(opt('root', process.cwd()));
const heroId = opt('hero', 'vesper');
const vite = await createServer({ configFile: false, root, logLevel: 'silent', server: { middlewareMode: true }, appType: 'custom' });
const { computeHandGrip, fitRigidNativeHand } = await vite.ssrLoadModule('/src/rendering/NativeHandGrip.ts');
const { KATANA_GRIP, WardenWeapon, analyzeGlaive } = await vite.ssrLoadModule('/src/rendering/WardenWeapon.ts');

const config = {
  vesper: {
    hero: 'asset-source/generated/actor-vesper-hero-01/vesper-hero-animated.glb',
    weapon: 'asset-source/generated/prop-vesper-katana-runtime-02/prop-vesper-katana.glb',
    kind: 'katana',
    tilt: KATANA_GRIP.diagonalRadians,
    edge: KATANA_GRIP.edgeRadians,
    gripFraction: KATANA_GRIP.gripFromPommel / KATANA_GRIP.length,
  },
  yara: {
    hero: 'asset-source/generated/actor-yara-hero-01/yara-hero-animated.glb',
    weapon: 'asset-source/generated/prop-heartroot-focus-staff-01/model.glb',
    kind: 'heartroot',
    tilt: 0,
    edge: undefined,
    gripFraction: 0.42,
  },
}[heroId];

if (!config) {
  console.error('Unknown --hero ' + heroId);
  process.exit(2);
}

const heroPath = resolve(root, config.hero);
const weaponPath = resolve(root, config.weapon);
const heroBytes = await readFile(heroPath);
const weaponBytes = await readFile(weaponPath);
const heroHash = createHash('sha256').update(heroBytes).digest('hex');
const weaponHash = createHash('sha256').update(weaponBytes).digest('hex');

const materialStub = () => ({ name: 'measure-material', loadMaterial: () => Promise.resolve(new MeshStandardMaterial()) });
const parseGlb = async bytes => new GLTFLoader().register(materialStub).parseAsync(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');

const hero = await parseGlb(heroBytes);
const weapon = await parseGlb(weaponBytes);

hero.scene.scale.setScalar(1.7);
hero.scene.updateMatrixWorld(true);

const grip = computeHandGrip(hero.scene, config.kind === 'katana' || config.kind === 'heartroot', config.tilt, config.edge);

let handEdit = fitRigidNativeHand(grip);
const fittedMesh = handEdit ? handEdit.mesh : null;

const wOwner = { root: hero.scene, animation: { setPostPose: () => undefined } };
const wSrc = { root: weapon.scene, dispose: () => undefined };
const ww = new WardenWeapon(wSrc, wOwner, config.kind);
hero.scene.updateMatrixWorld(true);

const weaponMesh = (() => { let m; weapon.scene.traverse(n => { if (!m && n.isMesh) m = n; }); return m; })();
const weaponPos = weaponMesh.geometry.getAttribute('position');
const weaponArr = new Float32Array(weaponPos.count * 3);
for (let i = 0; i < weaponPos.count; i++) {
  weaponArr[i*3] = weaponPos.getX(i);
  weaponArr[i*3+1] = weaponPos.getY(i);
  weaponArr[i*3+2] = weaponPos.getZ(i);
}
const frame = analyzeGlaive(weaponArr, config.kind === 'katana' ? 'guard' : 'crescent');

const handMesh = (() => { let m; hero.scene.traverse(n => { if (!m && n.isSkinnedMesh) m = n; }); return m; })();
const handBone = handMesh.skeleton.getBoneByName(PropertyBinding.sanitizeNodeName('mixamorig:RightHand'));
const handInverse = handMesh.skeleton.boneInverses[handMesh.skeleton.bones.indexOf(handBone)].clone().multiply(handMesh.bindMatrix);
const handToWorld = handInverse.clone().invert().multiply(handMesh.matrixWorld);

const weaponWorld = ww.root.matrixWorld;
const weaponAxisWorld = frame.axis.clone().transformDirection(weaponWorld).normalize();
const gripWorld = ww.sockets.weapon.getWorldPosition(new Vector3());

const finalGeom = handEdit ? handEdit.edited : handMesh.geometry;
const originalGeom = handEdit ? handEdit.original : handMesh.geometry;
const origPos = originalGeom.getAttribute('position');
const finalPos = finalGeom.getAttribute('position');
const index = finalGeom.getIndex();

const handBoneIdx = handMesh.skeleton.bones.indexOf(handBone);
const skinIdx = finalGeom.getAttribute('skinIndex');
const skinWgt = finalGeom.getAttribute('skinWeight');

const stats = {
  handSamples: 0,
  preMinAtShaft: Infinity,
  postMinAtShaft: Infinity,
  preMaxShaftRadial: -Infinity,
  postMaxShaftRadial: -Infinity,
  preCountNearShaft: 0,
  postCountNearShaft: 0,
  preCountFarFromShaft: 0,
  postCountFarFromShaft: 0,
  preDistances: [],
  postDistances: [],
  threshold: grip.shaftRadius * 1.2,
};

const tmp = new Vector3();
const seenVerts = new Set();
for (let t = 0; t < index.count; t++) {
  const v = index.getX(t);
  if (seenVerts.has(v)) continue;
  seenVerts.add(v);
  let weight = 0;
  for (let c = 0; c < 4; c++) if (skinIdx.getComponent(v, c) === handBoneIdx) weight += skinWgt.getComponent(v, c);
  if (weight < .6) continue;
  stats.handSamples++;
  const beforeW = tmp.set(origPos.getX(v), origPos.getY(v), origPos.getZ(v)).applyMatrix4(handToWorld);
  const afterW = new Vector3(finalPos.getX(v), finalPos.getY(v), finalPos.getZ(v)).applyMatrix4(handToWorld);
  const relBefore = beforeW.clone().sub(gripWorld);
  const alongBefore = relBefore.dot(weaponAxisWorld);
  const perpBefore = relBefore.clone().addScaledVector(weaponAxisWorld, -alongBefore);
  const distBefore = perpBefore.length();
  const relAfter = afterW.clone().sub(gripWorld);
  const alongAfter = relAfter.dot(weaponAxisWorld);
  const perpAfter = relAfter.clone().addScaledVector(weaponAxisWorld, -alongAfter);
  const distAfter = perpAfter.length();
  stats.preDistances.push(distBefore);
  stats.postDistances.push(distAfter);
  if (distBefore < stats.preMinAtShaft) stats.preMinAtShaft = distBefore;
  if (distAfter < stats.postMinAtShaft) stats.postMinAtShaft = distAfter;
  if (Math.abs(alongBefore) < .15) stats.preMaxShaftRadial = Math.max(stats.preMaxShaftRadial, distBefore);
  if (Math.abs(alongAfter) < .15) stats.postMaxShaftRadial = Math.max(stats.postMaxShaftRadial, distAfter);
  if (distBefore < stats.threshold) stats.preCountNearShaft++;
  if (distAfter < stats.threshold) stats.postCountNearShaft++;
  if (distBefore > stats.threshold * 2) stats.preCountFarFromShaft++;
  if (distAfter > stats.threshold * 2) stats.postCountFarFromShaft++;
}

const sum = (a) => a.reduce((s, v) => s + v, 0);
const sortedBefore = [...stats.preDistances].sort((a, b) => a - b);
const sortedAfter = [...stats.postDistances].sort((a, b) => a - b);
const quantile = (sorted, q) => sorted.length ? sorted[Math.floor((sorted.length - 1) * q)] : null;

const summary = {
  vertexCount: stats.handSamples,
  preMean: stats.preDistances.length ? sum(stats.preDistances) / stats.preDistances.length : null,
  postMean: stats.postDistances.length ? sum(stats.postDistances) / stats.postDistances.length : null,
  preMin: sortedBefore[0],
  postMin: sortedAfter[0],
  preP05: quantile(sortedBefore, .05),
  preP50: quantile(sortedBefore, .5),
  preP95: quantile(sortedBefore, .95),
  postP05: quantile(sortedAfter, .05),
  postP50: quantile(sortedAfter, .5),
  postP95: quantile(sortedAfter, .95),
  preNearShaft: stats.preCountNearShaft,
  postNearShaft: stats.postCountNearShaft,
  preFarFromShaft: stats.preCountFarFromShaft,
  postFarFromShaft: stats.postCountFarFromShaft,
  thresholdMetres: stats.threshold,
  preMaxShaftRadialWithin15cm: stats.preMaxShaftRadial,
  postMaxShaftRadialWithin15cm: stats.postMaxShaftRadial,
};

const result = {
  hero: heroId,
  heroHash,
  weaponHash,
  weaponKind: config.kind,
  shaftRadius: grip.shaftRadius,
  thresholdMetres: stats.threshold,
  rigidFist: Boolean(grip.rigid),
  grip: {
    axis: grip.axis.toArray(),
    curl: grip.curl.toArray(),
    palm: grip.palm.toArray(),
    shaftRadius: grip.shaftRadius,
    rigid: grip.rigid ? {
      direction: grip.rigid.direction.toArray(),
      axis: grip.rigid.axis.toArray(),
      normal: grip.rigid.normal.toArray(),
      hinge: grip.rigid.hinge,
      radius: grip.rigid.radius,
      plane: grip.rigid.plane,
    } : null,
  },
  summary,
};
console.log(JSON.stringify(result, null, 2));

if (handEdit) handEdit.edited.dispose();
ww.dispose();
hero.scene.traverse(n => { if (n.isMesh || n.isSkinnedMesh) n.geometry?.dispose?.(); });
weapon.scene.traverse(n => { if (n.isMesh || n.isSkinnedMesh) n.geometry?.dispose?.(); });
await vite.close();
