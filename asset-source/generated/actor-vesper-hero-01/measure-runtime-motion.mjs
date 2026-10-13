// Authoring measurement, not a test: grounded clips and engine locomotion of the delivered Vesper hero with the real katana.
// Bundle with the existing esbuild, then run with Node from the repository root (the bundle directory must resolve node_modules; a symlink is enough):
//   npx esbuild asset-source/generated/actor-vesper-hero-01/measure-runtime-motion.mjs --bundle --platform=node --format=esm --packages=external --outfile=/tmp/wc-runtime-geometry/motion.mjs
//   node /tmp/wc-runtime-geometry/motion.mjs [--root .] [--hero <glb>] [--manifest <json>] [--sword <glb>] [--output <json>] [--clips a,b] [--include-unmapped] [--no-body] [--no-engine]
// Executes the unchanged AnimationController, ActorAnimationDriver, WardenWeapon and (for locomotion) CombatEngine with delivered skeleton/skin/weapon
// geometry; only image decoding is bypassed. Measures, per 240 Hz rendered sample: the lowest referenced katana vertex above the world floor, the actual
// skinned sole vertices of both feet (height, planted-foot slide) and, where the blade comes near, exact katana-triangle / skinned-body-triangle contact.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { Group, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, SkinnedMesh, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { CombatEngine } from '../../../src/game/combat/CombatEngine.ts';
import { HERO_COMBAT } from '../../../src/game/combat/HeroProfiles.ts';
import { AnimationController } from '../../../src/rendering/AnimationController.ts';
import { driveActorAnimation } from '../../../src/rendering/ActorAnimationDriver.ts';
import { referencedVertices } from '../../../src/rendering/NativeHandGrip.ts';
import { WardenWeapon } from '../../../src/rendering/WardenWeapon.ts';

const args = process.argv.slice(2), option = (name, fallback) => { const k = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`)); if (k < 0) return fallback; const inline = args[k].indexOf('='); return inline >= 0 ? args[k].slice(inline + 1) : args[k + 1]; };
const flag = (name) => args.includes(`--${name}`);
const root = resolve(option('root', process.cwd())), actorDir = 'asset-source/generated/actor-vesper-hero-01/';
const paths = {
  hero: resolve(root, option('hero', actorDir + 'vesper-hero-animated.glb')),
  manifest: resolve(root, option('manifest', actorDir + 'manifest-entry.json')),
  sword: resolve(root, option('sword', 'asset-source/generated/prop-vesper-katana-runtime-02/prop-vesper-katana.glb')),
  output: resolve(root, option('output', actorDir + 'runtime-motion-report.json')),
};
const SUBDIVISIONS = Number(option('subdivisions', 4)), HZ = 60 * SUBDIVISIONS;
/** Body-contact search radius (m): clearances beyond it are reported as `>= margin`; also the broadphase slack over the fitted bone capsules. */
const MARGIN = Number(option('margin', 0.05));
/** Sole vertices: those within this band above each foot's lowest rest vertex. */
const SOLE_BAND = 0.01, PLANTED_HEIGHT = 0.02;
/** Every Nth 60 Hz step the exact narrowphase runs on every region regardless of the broadphase (audit of the capsule broadphase). */
const AUDIT_EVERY = Number(option('audit-every', 30));
const onlyClips = option('clips', '')?.split(',').filter(Boolean) ?? [];
const measureBody = !flag('no-body'), measureEngine = !flag('no-engine'), includeUnmapped = flag('include-unmapped');

const bytes = { hero: readFileSync(paths.hero), manifest: readFileSync(paths.manifest), sword: readFileSync(paths.sword) };
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
const hashes = { hero: sha(bytes.hero), manifest: sha(bytes.manifest), sword: sha(bytes.sword) };
const manifest = JSON.parse(bytes.manifest.toString('utf8'));
const parse = (buffer, standard) => new GLTFLoader()
  .register(() => ({ name: 'placeholder-material', loadMaterial: () => Promise.resolve(standard ? new MeshStandardMaterial() : new MeshBasicMaterial()) }))
  .parseAsync(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), '');
const started = Date.now(), stamp = (label) => console.error(`${label} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
const [hero, sword] = await Promise.all([parse(bytes.hero, false), parse(bytes.sword, true)]);
stamp(`parsed hero (${hero.animations.length} clips) and katana`);

// Clip set versus manifest: measure what the runtime would play (manifest actions whose clip exists); report the rest instead of pretending.
const clipNames = hero.animations.map((clip) => clip.name);
const mapped = Object.entries(manifest.actionToClipMapping);
const missingClips = mapped.filter(([, clip]) => !clipNames.includes(clip)).map(([action, clip]) => ({ action, clip }));
const unmappedClips = clipNames.filter((name) => !mapped.some(([, clip]) => clip === name));
const JUMP_ACTIONS = new Set(['aren-jump', 'aren-air-step']);
/** Engine-reported idle-phase loops plus the driver's held charge loops. */
const LOOP_ACTIONS = /^(aren-idle|aren-walk|aren-run|aren-strafe|vesper-cuts-charge|vesper-shade-charge)$/;
const probeManifest = includeUnmapped ? { ...manifest, actionToClipMapping: { ...manifest.actionToClipMapping }, rootMotion: { ...manifest.rootMotion } } : manifest;
const measuredClips = [];
for (const clip of hero.animations) {
  const actions = mapped.filter(([, name]) => name === clip.name).map(([action]) => action);
  let action = actions.find((candidate) => candidate === clip.name) ?? actions[0], mapping = 'manifest';
  if (!action) {
    if (!includeUnmapped) continue;
    action = clip.name; mapping = 'synthetic-in-place (clip is not in the manifest; measured as a finite in-place action for diagnosis only)';
    probeManifest.actionToClipMapping[action] = clip.name; probeManifest.rootMotion[action] = { mode: 'in-place', evidenceStatus: 'verified' };
  }
  if (onlyClips.length ? !onlyClips.includes(clip.name) && !onlyClips.includes(action) : JUMP_ACTIONS.has(action)) continue;
  measuredClips.push({ clip: clip.name, action, aliases: actions.filter((other) => other !== action), mapping, duration: clip.duration, loops: LOOP_ACTIONS.test(action) || (mapping !== 'manifest' && /run|walk|idle/.test(action)) });
}

const BONE_REGIONS = { head: /^(Neck|Head)$/, torso: /^(Hips|Spine|Spine1|Spine2|LeftShoulder|RightShoulder)$/, leftArm: /^(LeftArm|LeftForeArm|LeftHand)$/,
  rightArm: /^(RightArm|RightForeArm)$/, leftLeg: /^(LeftUpLeg|LeftLeg|LeftFoot|LeftToeBase)$/, rightLeg: /^(RightUpLeg|RightLeg|RightFoot|RightToeBase)$/ };
const FEET = { left: /^(LeftFoot|LeftToeBase)$/, right: /^(RightFoot|RightToeBase)$/ };
const shortName = (name) => name.replace(/^mixamorig:?/, '');
const transform = manifest.coordinateTransform;

/** One posed hero + fitted katana. The hand fit (WardenWeapon) is expensive on 975k vertices, so the instance is built once and `attachController` restores the rest pose for every probe. */
function createInstance() {
  const model = cloneSkinned(hero.scene), actorRoot = new Group(); actorRoot.add(model);
  model.scale.setScalar(transform.scale);
  model.rotation.y = Math.atan2(transform.forward.x, transform.forward.z);
  if (transform.originOffset) model.position.set(transform.originOffset.x, transform.originOffset.y, transform.originOffset.z);
  model.traverse((node) => { if (node instanceof SkinnedMesh) node.skeleton.boneInverses = node.skeleton.boneInverses.map((matrix) => matrix.clone()); });
  const rest = []; model.traverse((node) => { rest.push({ node, position: node.position.clone(), quaternion: node.quaternion.clone(), scale: node.scale.clone() }); });
  const shell = { model, actorRoot, rest };
  attachController(shell);
  const swordRoot = sword.scene.clone(), weapon = new WardenWeapon({ root: swordRoot, dispose: () => undefined }, shell.instance, 'katana');
  let swordMesh; swordRoot.traverse((node) => { if (node instanceof Mesh) swordMesh = node; });
  let skinned; model.traverse((node) => { if (node instanceof SkinnedMesh && (!skinned || node.geometry.getAttribute('position').count > skinned.geometry.getAttribute('position').count)) skinned = node; });
  actorRoot.updateMatrixWorld(true);
  const katana = { mesh: swordMesh, vertices: Uint32Array.from(referencedVertices(swordMesh.geometry)), positions: swordMesh.geometry.getAttribute('position') };
  katana.index = swordMesh.geometry.getIndex()?.array ?? Uint32Array.from({ length: katana.positions.count }, (_, k) => k);
  // Metres along the weapon frame (+Z pommel → kissaki, origin at the fitted palm) of every katana vertex and the socket ends.
  const alongMetres = new Float32Array(katana.vertices.length), radialMetres = new Float32Array(katana.vertices.length), local = new Vector3();
  katana.vertices.forEach((vertex, k) => { local.fromBufferAttribute(katana.positions, vertex).applyMatrix4(swordRoot.matrix); alongMetres[k] = local.z; radialMetres[k] = Math.hypot(local.x, local.y); });
  katana.alongMetres = alongMetres; katana.radialExtent = Math.max(...radialMetres);
  katana.world = new Float32Array(katana.vertices.length * 3); katana.worldOf = new Int32Array(katana.positions.count).fill(-1); katana.vertices.forEach((vertex, k) => { katana.worldOf[vertex] = k; });
  // Envelope: maximum radial extent per 1 cm along-bin, each katana triangle marking every bin its along range covers (narrowphase lower bound).
  const start = Math.min(...alongMetres), size = 0.01, radial = new Float32Array(Math.ceil((Math.max(...alongMetres) - start) / size) + 1).fill(-1);
  for (let t = 0; t < katana.index.length; t += 3) {
    const a = katana.worldOf[katana.index[t]], b = katana.worldOf[katana.index[t + 1]], c = katana.worldOf[katana.index[t + 2]];
    if (a < 0 || b < 0 || c < 0) continue;
    const r = Math.max(radialMetres[a], radialMetres[b], radialMetres[c]), lo = Math.floor((Math.min(alongMetres[a], alongMetres[b], alongMetres[c]) - start) / size), hi = Math.floor((Math.max(alongMetres[a], alongMetres[b], alongMetres[c]) - start) / size);
    for (let bin = lo; bin <= hi; bin++) if (r > radial[bin]) radial[bin] = r;
  }
  katana.bins = { start, size, radial };
  Object.assign(shell, { weapon, katana, skinned, sockets: weapon.sockets, pommelAlongMetres: weapon.sockets['weapon-pommel'].position.z, tipAlongMetres: weapon.sockets['weapon-tip'].position.z });
  return shell;
}
/** Fresh AnimationController on the rest pose (its root-motion bind is captured from the current node positions), with the weapon's post-pose grip hook. */
function attachController(shell) {
  if (shell.animation) {
    shell.animation.dispose();
    for (const { node, position, quaternion, scale } of shell.rest) { node.position.copy(position); node.quaternion.copy(quaternion); node.scale.copy(scale); }
    shell.actorRoot.position.set(0, 0, 0); shell.actorRoot.rotation.set(0, 0, 0); shell.actorRoot.updateMatrixWorld(true);
  }
  shell.animation = new AnimationController(shell.model, hero.animations, probeManifest);
  shell.instance = { assetId: manifest.id, root: shell.actorRoot, animation: shell.animation };
  if (shell.weapon) shell.animation.setPostPose(() => shell.weapon.applyGrip());
}

/** Compact skinning data for a vertex subset of the actual rendered skinned mesh (its geometry after the weapon's rigid-hand edit). */
function subset(skinned, vertexIds) {
  const geometry = skinned.geometry, position = geometry.getAttribute('position'), joints = geometry.getAttribute('skinIndex'), weights = geometry.getAttribute('skinWeight');
  const n = vertexIds.length, base = new Float32Array(n * 3), joint = new Uint16Array(n * 4), weight = new Float32Array(n * 4), point = new Vector3();
  for (let k = 0; k < n; k++) {
    const v = vertexIds[k];
    point.fromBufferAttribute(position, v).applyMatrix4(skinned.bindMatrix);
    base[k * 3] = point.x; base[k * 3 + 1] = point.y; base[k * 3 + 2] = point.z;
    for (let c = 0; c < 4; c++) { joint[k * 4 + c] = joints.getComponent(v, c); weight[k * 4 + c] = weights.getComponent(v, c); }
  }
  return { ids: vertexIds, base, joint, weight, world: new Float32Array(n * 3) };
}
const boneTransforms = new Float32Array(16 * 256), skinMatrix = new Matrix4(), scratch = new Matrix4();
/** World positions of a subset (all vertices, or only `ids` into the subset): world = mesh.matrixWorld · bindMatrixInverse · Σ w_i · boneMatrix_i · bindMatrix · p (three's applyBoneTransform, batched). */
function skinSubset(skinned, data, ids) {
  const bones = skinned.skeleton.bones.length, matrices = skinned.skeleton.boneMatrices;
  skinMatrix.multiplyMatrices(skinned.matrixWorld, skinned.bindMatrixInverse);
  for (let b = 0; b < bones; b++) scratch.fromArray(matrices, b * 16).premultiply(skinMatrix).toArray(boneTransforms, b * 16);
  const { base, joint, weight, world } = data, n = ids ? ids.length : base.length / 3;
  for (let i = 0; i < n; i++) {
    const k = ids ? ids[i] : i, x = base[k * 3], y = base[k * 3 + 1], z = base[k * 3 + 2]; let wx = 0, wy = 0, wz = 0;
    for (let c = 0; c < 4; c++) {
      const w = weight[k * 4 + c]; if (w === 0) continue;
      const m = joint[k * 4 + c] * 16;
      wx += w * (boneTransforms[m] * x + boneTransforms[m + 4] * y + boneTransforms[m + 8] * z + boneTransforms[m + 12]);
      wy += w * (boneTransforms[m + 1] * x + boneTransforms[m + 5] * y + boneTransforms[m + 9] * z + boneTransforms[m + 13]);
      wz += w * (boneTransforms[m + 2] * x + boneTransforms[m + 6] * y + boneTransforms[m + 10] * z + boneTransforms[m + 14]);
    }
    world[k * 3] = wx; world[k * 3 + 1] = wy; world[k * 3 + 2] = wz;
  }
  return world;
}
/** Slab length (m) along each bone axis for the broadphase capsules (a chain per bone: tight around hair, ponytail and foot extents). */
const SLAB = 0.05;

/** Regions (triangle sets of the actual skinned body), per-bone slab capsules fitted to the rest pose, and the sole vertex sets of both feet. */
function buildBody(instance) {
  const { skinned } = instance, geometry = skinned.geometry, count = geometry.getAttribute('position').count, index = geometry.getIndex().array;
  const joints = geometry.getAttribute('skinIndex'), weights = geometry.getAttribute('skinWeight'), bones = skinned.skeleton.bones;
  const boneRegion = bones.map((bone) => Object.keys(BONE_REGIONS).find((region) => BONE_REGIONS[region].test(shortName(bone.name))) ?? null);
  const boneFoot = bones.map((bone) => Object.keys(FEET).find((foot) => FEET[foot].test(shortName(bone.name))) ?? null);
  const dominant = new Int16Array(count);
  for (let v = 0; v < count; v++) { let best = -1, bestWeight = -1; for (let c = 0; c < 4; c++) { const w = weights.getComponent(v, c); if (w > bestWeight) { bestWeight = w; best = joints.getComponent(v, c); } } dominant[v] = best; }
  const regions = {};
  for (const name of Object.keys(BONE_REGIONS)) regions[name] = { name, triangles: [], vertexSet: new Set() };
  for (let t = 0; t < index.length; t += 3) {
    const seen = new Set();
    for (let c = 0; c < 3; c++) { const region = boneRegion[dominant[index[t + c]]]; if (region && !seen.has(region)) { seen.add(region); const r = regions[region]; r.triangles.push(index[t], index[t + 1], index[t + 2]); for (let d = 0; d < 3; d++) r.vertexSet.add(index[t + d]); } }
  }
  instance.actorRoot.updateMatrixWorld(true); skinned.skeleton.update();
  // Rest-pose bone axes: bone → first child bone, or parent → bone for leaves (Head, hands, toes).
  const axes = bones.map((bone) => {
    const origin = bone.getWorldPosition(new Vector3()), child = bone.children.find((node) => node.isBone && bones.includes(node));
    const direction = child ? child.getWorldPosition(new Vector3()).sub(origin) : origin.clone().sub(bone.parent.getWorldPosition(new Vector3()));
    return { origin, direction: direction.normalize(), toLocal: bone.matrixWorld.clone().invert() };
  });
  const summary = {};
  for (const region of Object.values(regions)) {
    region.ids = Uint32Array.from(region.vertexSet); region.vertexSet = undefined;
    const local = new Int32Array(count).fill(-1); region.ids.forEach((v, k) => { local[v] = k; });
    region.tris = Uint32Array.from(region.triangles, (v) => local[v]); region.triangles = undefined;
    region.skin = subset(skinned, region.ids);
    const rest = skinSubset(skinned, region.skin);
    // Slab capsules: each region bone's dominated vertices are binned along its axis; every slab is a capsule whose endpoints ride the bone (bone-local) with the slab's maximum radial distance.
    region.slabs = []; const slabOf = new Int32Array(region.ids.length).fill(-1);
    bones.forEach((bone, b) => {
      if (boneRegion[b] !== region.name) return;
      const { origin, direction, toLocal } = axes[b], along = new Float32Array(region.ids.length), radial = new Float32Array(region.ids.length), p = new Vector3();
      let tMin = Infinity, tMax = -Infinity;
      region.ids.forEach((v, k) => {
        if (dominant[v] !== b) return;
        p.set(rest[k * 3], rest[k * 3 + 1], rest[k * 3 + 2]).sub(origin);
        const t = p.dot(direction); along[k] = t; radial[k] = p.addScaledVector(direction, -t).length();
        if (t < tMin) tMin = t; if (t > tMax) tMax = t;
      });
      if (tMin === Infinity) return;
      const first = region.slabs.length, slabs = Math.max(1, Math.ceil((tMax - tMin) / SLAB));
      for (let s = 0; s < slabs; s++) {
        const t0 = tMin + s * SLAB, t1 = Math.min(tMax, t0 + SLAB);
        region.slabs.push({ bone, name: shortName(bone.name), radius: 0, a: origin.clone().addScaledVector(direction, t0).applyMatrix4(toLocal), b: origin.clone().addScaledVector(direction, t1).applyMatrix4(toLocal), triangles: [], vertices: [] });
      }
      region.ids.forEach((v, k) => {
        if (dominant[v] !== b) return;
        const s = first + Math.max(0, Math.min(slabs - 1, Math.floor((along[k] - tMin) / SLAB))); slabOf[k] = s;
        if (radial[k] > region.slabs[s].radius) region.slabs[s].radius = radial[k];
      });
    });
    // Triangles belong to the slab of their first in-region vertex; a slab's vertex list covers all vertices of its triangles.
    const stamp = new Int32Array(region.ids.length).fill(-1);
    for (let t = 0; t < region.tris.length; t += 3) {
      let s = -1; for (let c = 0; c < 3 && s < 0; c++) s = slabOf[region.tris[t + c]];
      if (s < 0) continue;
      const slab = region.slabs[s]; slab.triangles.push(t);
      for (let c = 0; c < 3; c++) { const k = region.tris[t + c]; if (stamp[k] !== s) { stamp[k] = s; slab.vertices.push(k); } }
    }
    for (const slab of region.slabs) { slab.triangles = Uint32Array.from(slab.triangles); slab.vertices = Uint32Array.from(slab.vertices); }
    summary[region.name] = { vertices: region.ids.length, triangles: region.tris.length / 3, slabs: region.slabs.length, capsules: Object.fromEntries([...region.slabs.reduce((m, s) => m.set(s.name, Math.max(m.get(s.name) ?? 0, s.radius)), new Map()).entries()].map(([bone, radius]) => [bone, round(radius)])) };
  }
  const feet = {};
  for (const foot of Object.keys(FEET)) {
    const ids = []; for (let v = 0; v < count; v++) if (boneFoot[dominant[v]] === foot) ids.push(v);
    const all = subset(skinned, Uint32Array.from(ids)), rest = skinSubset(skinned, all);
    let low = Infinity; for (let k = 0; k < ids.length; k++) low = Math.min(low, rest[k * 3 + 1]);
    const sole = ids.filter((_, k) => rest[k * 3 + 1] <= low + SOLE_BAND);
    feet[foot] = { skin: subset(skinned, Uint32Array.from(sole)), restLowestMetres: low, soleVertices: sole.length, footVertices: ids.length };
  }
  return { regions, feet, skinnedVertexCount: count, summary, boneNames: bones.map((bone) => shortName(bone.name)), feetSummary: Object.fromEntries(Object.entries(feet).map(([foot, f]) => [foot, { restLowestMetres: round(f.restLowestMetres), soleVertices: f.soleVertices, footVertices: f.footVertices }])) };
}

function pointSegmentDistanceSq(px, py, pz, ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az, l2 = dx * dx + dy * dy + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / l2)) : 0;
  const qx = ax + dx * t - px, qy = ay + dy * t - py, qz = az + dz * t - pz; return qx * qx + qy * qy + qz * qz;
}
/** Exact distance between two finite segments. */
function segmentSegmentDistance(p0, p1, q0, q1) {
  const u = p1.clone().sub(p0), v = q1.clone().sub(q0), w = p0.clone().sub(q0);
  const a = u.dot(u), b = u.dot(v), c = v.dot(v), d = u.dot(w), e = v.dot(w), D = a * c - b * b;
  let sN, sD = D, tN, tD = D;
  if (D < 1e-12) { sN = 0; sD = 1; tN = e; tD = c; } else { sN = b * e - c * d; tN = a * e - b * d; if (sN < 0) { sN = 0; tN = e; tD = c; } else if (sN > sD) { sN = sD; tN = e + b; tD = c; } }
  if (tN < 0) { tN = 0; if (-d < 0) sN = 0; else if (-d > a) sN = sD; else { sN = -d; sD = a; } } else if (tN > tD) { tN = tD; if (-d + b < 0) sN = 0; else if (-d + b > a) sN = sD; else { sN = -d + b; sD = a; } }
  const s = Math.abs(sN) < 1e-12 ? 0 : sN / sD, t = Math.abs(tN) < 1e-12 ? 0 : tN / tD;
  return w.addScaledVector(u, s).addScaledVector(v, -t).length();
}
function pointTriangleDistanceSq(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az, apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = px - bx, bpy = py - by, bpz = pz - bz, d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const s = d1 / (d1 - d3), qx = apx - abx * s, qy = apy - aby * s, qz = apz - abz * s; return qx * qx + qy * qy + qz * qz; }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz, d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const s = d2 / (d2 - d6), qx = apx - acx * s, qy = apy - acy * s, qz = apz - acz * s; return qx * qx + qy * qy + qz * qz; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const s = (d4 - d3) / ((d4 - d3) + (d5 - d6)), qx = bpx - (cx - bx) * s, qy = bpy - (cy - by) * s, qz = bpz - (cz - bz) * s; return qx * qx + qy * qy + qz * qz; }
  const denominator = 1 / (va + vb + vc), s = vb * denominator, t = vc * denominator, qx = apx - abx * s - acx * t, qy = apy - aby * s - acy * t, qz = apz - abz * s - acz * t;
  return qx * qx + qy * qy + qz * qz;
}
/** Möller–Trumbore: parametric hit of the segment o → o + d on the triangle, or -1. */
function segmentTriangle(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x, det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-14) return -1;
  const inv = 1 / det, sx = ox - ax, sy = oy - ay, sz = oz - az, u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x, v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t < 0 || t > 1 ? -1 : t;
}
const round = (value) => Math.round(value * 1e4) / 1e4;

/** Narrowphase grid cell (m); MARGIN / FINE rings bound the nearest-triangle search. */
const FINE = 0.01;
/** Exact katana-mesh / skinned-region contact over `triangles` (region-local triangle starts; `world` holds the skinned positions those triangles reference):
 * nearest body vertex to the katana surface (capped at MARGIN; the body mesh is ~1.5 mm dense, so this bounds the true surface distance to about a millimetre)
 * and katana-triangle / body-triangle intersections. The sparse katana triangles are gridded; the dense body vertices/triangles query the grid. */
let stampCounter = 0;
function narrowphase(region, world, katana, triangles) {
  const tris = region.tris, cell = MARGIN;
  let rx0 = Infinity, ry0 = Infinity, rz0 = Infinity, rx1 = -Infinity, ry1 = -Infinity, rz1 = -Infinity;
  for (let i = 0; i < triangles.length; i++) for (let c = 0; c < 3; c++) { const k = tris[triangles[i] + c] * 3, x = world[k], y = world[k + 1], z = world[k + 2]; if (x < rx0) rx0 = x; if (x > rx1) rx1 = x; if (y < ry0) ry0 = y; if (y > ry1) ry1 = y; if (z < rz0) rz0 = z; if (z > rz1) rz1 = z; }
  const kw = katana.world; let kx0 = Infinity, ky0 = Infinity, kz0 = Infinity, kx1 = -Infinity, ky1 = -Infinity, kz1 = -Infinity;
  for (let k = 0; k < kw.length; k += 3) { const x = kw[k], y = kw[k + 1], z = kw[k + 2]; if (x < kx0) kx0 = x; if (x > kx1) kx1 = x; if (y < ky0) ky0 = y; if (y > ky1) ky1 = y; if (z < kz0) kz0 = z; if (z > kz1) kz1 = z; }
  const x0 = Math.max(rx0, kx0) - cell, y0 = Math.max(ry0, ky0) - cell, z0 = Math.max(rz0, kz0) - cell, x1 = Math.min(rx1, kx1) + cell, y1 = Math.min(ry1, ky1) + cell, z1 = Math.min(rz1, kz1) + cell;
  const result = { clearance: MARGIN, vertex: -1, triangle: -1, intersections: 0, alongMin: Infinity, alongMax: -Infinity, point: undefined, candidateTriangles: 0, katanaTriangles: 0 };
  if (x0 > x1 || y0 > y1 || z0 > z1) return result;
  // Katana triangles inside the zone on a dense FINE grid (counting sort) plus a coarse MARGIN occupancy for early rejection of far body vertices.
  const nx = Math.ceil((x1 - x0) / FINE) + 1, ny = Math.ceil((y1 - y0) / FINE) + 1, nz = Math.ceil((z1 - z0) / FINE) + 1, cells = nx * ny * nz;
  const index = katana.index, worldOf = katana.worldOf, kTris = [], kBounds = [];
  for (let t = 0; t < index.length; t += 3) {
    const a = worldOf[index[t]] * 3, b = worldOf[index[t + 1]] * 3, c = worldOf[index[t + 2]] * 3;
    if (a < 0 || b < 0 || c < 0) continue;
    const tx0 = Math.min(kw[a], kw[b], kw[c]), tx1 = Math.max(kw[a], kw[b], kw[c]); if (tx1 < x0 || tx0 > x1) continue;
    const ty0 = Math.min(kw[a + 1], kw[b + 1], kw[c + 1]), ty1 = Math.max(kw[a + 1], kw[b + 1], kw[c + 1]); if (ty1 < y0 || ty0 > y1) continue;
    const tz0 = Math.min(kw[a + 2], kw[b + 2], kw[c + 2]), tz1 = Math.max(kw[a + 2], kw[b + 2], kw[c + 2]); if (tz1 < z0 || tz0 > z1) continue;
    kTris.push(t); kBounds.push(tx0, ty0, tz0, tx1, ty1, tz1);
  }
  result.katanaTriangles = kTris.length;
  if (!kTris.length) return result;
  const box = new Float32Array(kBounds), cellStart = new Int32Array(cells + 1), cellRange = new Int32Array(kTris.length * 6);
  const clampCell = (value, origin, n) => Math.max(0, Math.min(n - 1, Math.floor((value - origin) / FINE)));
  const rings = Math.ceil(MARGIN / FINE), field = new Uint8Array(cells).fill(255); let frontier = [];
  for (let i = 0; i < kTris.length; i++) {
    const o = i * 6;
    cellRange[o] = clampCell(box[o], x0, nx); cellRange[o + 3] = clampCell(box[o + 3], x0, nx);
    cellRange[o + 1] = clampCell(box[o + 1], y0, ny); cellRange[o + 4] = clampCell(box[o + 4], y0, ny);
    cellRange[o + 2] = clampCell(box[o + 2], z0, nz); cellRange[o + 5] = clampCell(box[o + 5], z0, nz);
    for (let ix = cellRange[o]; ix <= cellRange[o + 3]; ix++) for (let iy = cellRange[o + 1]; iy <= cellRange[o + 4]; iy++) for (let iz = cellRange[o + 2]; iz <= cellRange[o + 5]; iz++) { const c = (ix * ny + iy) * nz + iz; cellStart[c + 1]++; if (field[c] === 255) { field[c] = 0; frontier.push(c); } }
  }
  for (let c = 0; c < cells; c++) cellStart[c + 1] += cellStart[c];
  const items = new Int32Array(cellStart[cells]), cursor = cellStart.slice(0, cells);
  for (let i = 0; i < kTris.length; i++) {
    const o = i * 6;
    for (let ix = cellRange[o]; ix <= cellRange[o + 3]; ix++) for (let iy = cellRange[o + 1]; iy <= cellRange[o + 4]; iy++) for (let iz = cellRange[o + 2]; iz <= cellRange[o + 5]; iz++) { const c = (ix * ny + iy) * nz + iz; items[cursor[c]++] = i; }
  }
  // Chebyshev cell distance to the nearest occupied cell (multi-source BFS, 26-neighbourhood) up to `rings`: a body vertex in a cell at distance d is at least (d - 1) · FINE from the katana.
  for (let d = 1; d <= rings && frontier.length; d++) {
    const next = [];
    for (let f = 0; f < frontier.length; f++) {
      const c = frontier[f], iz = c % nz, iy = ((c - iz) / nz) % ny, ix = (c - iz - iy * nz) / (ny * nz);
      for (let jx = Math.max(0, ix - 1); jx <= Math.min(nx - 1, ix + 1); jx++) for (let jy = Math.max(0, iy - 1); jy <= Math.min(ny - 1, iy + 1); jy++) for (let jz = Math.max(0, iz - 1); jz <= Math.min(nz - 1, iz + 1); jz++) {
        const n = (jx * ny + jy) * nz + jz; if (field[n] === 255) { field[n] = d; next.push(n); }
      }
    }
    frontier = next;
  }
  // Body triangles inside the zone and their vertices (each once).
  const stamp = region.narrowStamp ??= new Int32Array(region.ids.length).fill(-1), stampId = ++stampCounter, bodyVertices = [], bodyTriangles = [];
  for (let i = 0; i < triangles.length; i++) {
    const t = triangles[i], a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
    if (Math.max(world[a], world[b], world[c]) < x0 || Math.min(world[a], world[b], world[c]) > x1 || Math.max(world[a + 1], world[b + 1], world[c + 1]) < y0 || Math.min(world[a + 1], world[b + 1], world[c + 1]) > y1 || Math.max(world[a + 2], world[b + 2], world[c + 2]) < z0 || Math.min(world[a + 2], world[b + 2], world[c + 2]) > z1) continue;
    bodyTriangles.push(t);
    for (let cc = 0; cc < 3; cc++) { const k = tris[t + cc]; if (stamp[k] !== stampId) { stamp[k] = stampId; bodyVertices.push(k); } }
  }
  result.candidateTriangles = bodyTriangles.length;
  // Envelope lower bound per body vertex: distance to the blade axis at each along-bin minus that bin's maximum radial extent (rigorous: the radial distance is convex over
  // every katana triangle, and bins cover the triangles' along ranges). Vertices are searched best-first and the loop stops once the bound reaches the running minimum.
  const { frameOrigin: fo, frameDirection: fd, bins } = katana, half = bins.size / 2, bound = new Float32Array(bodyVertices.length), reach = MARGIN + katana.radialExtent;
  for (let i = 0; i < bodyVertices.length; i++) {
    const k = bodyVertices[i] * 3, px = world[k] - fo.x, py = world[k + 1] - fo.y, pz = world[k + 2] - fo.z;
    const along = px * fd.x + py * fd.y + pz * fd.z, perpSq = Math.max(0, px * px + py * py + pz * pz - along * along);
    // Only bins within MARGIN + radial extent along the axis can bound below MARGIN; anything else is "beyond search".
    let lower = MARGIN;
    if (Math.sqrt(perpSq) - katana.radialExtent < MARGIN) {
      const from = Math.max(0, Math.floor((along - reach - bins.start) / bins.size)), to = Math.min(bins.radial.length - 1, Math.floor((along + reach - bins.start) / bins.size));
      for (let b = from; b <= to; b++) {
        const radial = bins.radial[b]; if (radial < 0) continue;
        const gap = Math.max(0, Math.abs(along - (bins.start + (b + 0.5) * bins.size)) - half), value = Math.sqrt(perpSq + gap * gap) - radial;
        if (value < lower) lower = value;
      }
    }
    bound[i] = Math.max(0, lower);
  }
  const order = Uint32Array.from(bodyVertices, (_, i) => i).sort((p, q) => bound[p] - bound[q]);
  let best = MARGIN * MARGIN;
  for (let n = 0; n < order.length; n++) {
    const i = order[n]; if (bound[i] * bound[i] >= best) break;
    const k = bodyVertices[i] * 3, x = world[k], y = world[k + 1], z = world[k + 2];
    if (x < x0 || x > x1 || y < y0 || y > y1 || z < z0 || z > z1) continue;
    const ix = Math.floor((x - x0) / FINE), iy = Math.floor((y - y0) / FINE), iz = Math.floor((z - z0) / FINE), start = field[(ix * ny + iy) * nz + iz];
    if (start === 255) continue;
    let local = best;
    for (let ring = start; ring <= rings; ring++) {
      if (ring > 0 && ((ring - 1) * FINE) ** 2 >= local) break;
      for (let jx = Math.max(0, ix - ring); jx <= Math.min(nx - 1, ix + ring); jx++) for (let jy = Math.max(0, iy - ring); jy <= Math.min(ny - 1, iy + ring); jy++) {
        const face = Math.abs(jx - ix) === ring || Math.abs(jy - iy) === ring;
        const zFrom = face ? Math.max(0, iz - ring) : iz - ring, zTo = face ? Math.min(nz - 1, iz + ring) : iz + ring, zStep = face ? 1 : 2 * ring;
        for (let jz = zFrom; jz <= zTo; jz += zStep) {
          if (jz < 0 || jz >= nz) continue;
          const c = (jx * ny + jy) * nz + jz;
          for (let e = cellStart[c]; e < cellStart[c + 1]; e++) {
            const j = items[e], o = j * 6;
            const ex = Math.max(box[o] - x, 0, x - box[o + 3]), ey = Math.max(box[o + 1] - y, 0, y - box[o + 4]), ez = Math.max(box[o + 2] - z, 0, z - box[o + 5]);
            if (ex * ex + ey * ey + ez * ez >= local) continue;
            const t = kTris[j], a = worldOf[index[t]] * 3, b = worldOf[index[t + 1]] * 3, cc = worldOf[index[t + 2]] * 3;
            const d = pointTriangleDistanceSq(x, y, z, kw[a], kw[a + 1], kw[a + 2], kw[b], kw[b + 1], kw[b + 2], kw[cc], kw[cc + 1], kw[cc + 2]);
            if (d < local) { local = d; result.vertex = bodyVertices[i]; result.triangle = t / 3; }
          }
        }
      }
    }
    best = local;
  }
  result.clearance = Math.sqrt(best);
  // Triangle-triangle intersection: every body edge against the katana triangles sharing its cells and every katana edge against the body triangle.
  const visited = new Int32Array(kTris.length).fill(-1);
  for (let i = 0; i < bodyTriangles.length; i++) {
    const t = bodyTriangles[i], p = tris[t] * 3, q = tris[t + 1] * 3, r = tris[t + 2] * 3;
    const tx0 = Math.min(world[p], world[q], world[r]), tx1 = Math.max(world[p], world[q], world[r]), ty0 = Math.min(world[p + 1], world[q + 1], world[r + 1]), ty1 = Math.max(world[p + 1], world[q + 1], world[r + 1]), tz0 = Math.min(world[p + 2], world[q + 2], world[r + 2]), tz1 = Math.max(world[p + 2], world[q + 2], world[r + 2]);
    const ix0 = clampCell(tx0, x0, nx), ix1 = clampCell(tx1, x0, nx), iy0 = clampCell(ty0, y0, ny), iy1 = clampCell(ty1, y0, ny), iz0 = clampCell(tz0, z0, nz), iz1 = clampCell(tz1, z0, nz);
    for (let ix = ix0; ix <= ix1; ix++) for (let iy = iy0; iy <= iy1; iy++) for (let iz = iz0; iz <= iz1; iz++) {
      const cell = (ix * ny + iy) * nz + iz;
      for (let e = cellStart[cell]; e < cellStart[cell + 1]; e++) {
        const j = items[e]; if (visited[j] === t) continue; visited[j] = t;
        const o = j * 6;
        if (box[o] > tx1 || box[o + 3] < tx0 || box[o + 1] > ty1 || box[o + 4] < ty0 || box[o + 2] > tz1 || box[o + 5] < tz0) continue;
        const kt = kTris[j], a = worldOf[index[kt]] * 3, b = worldOf[index[kt + 1]] * 3, c = worldOf[index[kt + 2]] * 3;
        let hit = -1, hx = 0, hy = 0, hz = 0;
        for (let edge = 0; edge < 3 && hit < 0; edge++) {
          const s = edge === 0 ? p : edge === 1 ? q : r, d = edge === 0 ? q : edge === 1 ? r : p;
          hit = segmentTriangle(world[s], world[s + 1], world[s + 2], world[d] - world[s], world[d + 1] - world[s + 1], world[d + 2] - world[s + 2], kw[a], kw[a + 1], kw[a + 2], kw[b], kw[b + 1], kw[b + 2], kw[c], kw[c + 1], kw[c + 2]);
          if (hit >= 0) { hx = world[s] + (world[d] - world[s]) * hit; hy = world[s + 1] + (world[d + 1] - world[s + 1]) * hit; hz = world[s + 2] + (world[d + 2] - world[s + 2]) * hit; }
        }
        for (let edge = 0; edge < 3 && hit < 0; edge++) {
          const s = edge === 0 ? a : edge === 1 ? b : c, d = edge === 0 ? b : edge === 1 ? c : a;
          hit = segmentTriangle(kw[s], kw[s + 1], kw[s + 2], kw[d] - kw[s], kw[d + 1] - kw[s + 1], kw[d + 2] - kw[s + 2], world[p], world[p + 1], world[p + 2], world[q], world[q + 1], world[q + 2], world[r], world[r + 1], world[r + 2]);
          if (hit >= 0) { hx = kw[s] + (kw[d] - kw[s]) * hit; hy = kw[s + 1] + (kw[d + 1] - kw[s + 1]) * hit; hz = kw[s + 2] + (kw[d + 2] - kw[s + 2]) * hit; }
        }
        if (hit < 0) continue;
        result.intersections++;
        const along = (katana.alongMetres[a / 3] + katana.alongMetres[b / 3] + katana.alongMetres[c / 3]) / 3;
        if (along < result.alongMin) result.alongMin = along; if (along > result.alongMax) result.alongMax = along;
        if (!result.point) result.point = [round(hx), round(hy), round(hz)];
      }
    }
  }
  if (result.intersections) result.clearance = 0;
  return result;
}

/** One rendered 240 Hz sample of a posed instance: katana floor, feet and (optional) body contact. `floorY` is the world floor under the actor. */
function sample(instance, body, state, time, floorY, audit) {
  const { katana, skinned, sockets } = instance;
  instance.actorRoot.updateMatrixWorld(true); skinned.skeleton.update();
  const m = katana.mesh.matrixWorld.elements, kw = katana.world, positions = katana.positions; let floor = Infinity, lowest = -1;
  for (let k = 0; k < katana.vertices.length; k++) {
    const v = katana.vertices[k], x = positions.getX(v), y = positions.getY(v), z = positions.getZ(v);
    const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
    kw[k * 3] = m[0] * x + m[4] * y + m[8] * z + m[12]; kw[k * 3 + 1] = wy; kw[k * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
    if (wy < floor) { floor = wy; lowest = k; }
  }
  const out = { t: round(time), katanaFloorMetres: round(floor - floorY), katanaLowestAlongMetres: round(katana.alongMetres[lowest]), feet: {} };
  for (const [foot, data] of Object.entries(body.feet)) {
    const world = skinSubset(skinned, data.skin); let low = Infinity, cx = 0, cz = 0; const n = world.length / 3;
    for (let k = 0; k < n; k++) { low = Math.min(low, world[k * 3 + 1]); cx += world[k * 3]; cz += world[k * 3 + 2]; }
    cx /= n; cz /= n;
    // Slide: horizontal velocity of the sole centroid (m/s); `forward` is its component along the actor's facing (+ = the planted foot travels forward with the body, as in a moonwalk; − = it pushes back faster than the body moves).
    const previous = state.feet[foot], yaw = instance.actorRoot.rotation.y, fx = Math.sin(yaw), fz = Math.cos(yaw);
    const slide = previous ? Math.hypot(cx - previous.x, cz - previous.z) * HZ : 0, forward = previous ? ((cx - previous.x) * fx + (cz - previous.z) * fz) * HZ : 0;
    state.feet[foot] = { x: cx, z: cz };
    out.feet[foot] = { heightMetres: round(low - floorY), slideMetresPerSecond: round(slide), forwardMetresPerSecond: round(forward), planted: low - floorY <= PLANTED_HEIGHT };
  }
  if (measureBody) {
    const pommel = sockets['weapon-pommel'].getWorldPosition(new Vector3()), tip = sockets['weapon-tip'].getWorldPosition(new Vector3());
    katana.frameOrigin = new Vector3().setFromMatrixPosition(sockets.weapon.matrixWorld); katana.frameDirection = new Vector3().setFromMatrixColumn(sockets.weapon.matrixWorld, 2).normalize();
    out.body = {};
    for (const region of Object.values(body.regions)) {
      // Broadphase: blade axis segment against every slab capsule riding its bone; slabs within MARGIN (plus the katana's radial extent) go to the narrowphase.
      let near = Infinity; const nearSlabs = [];
      for (const slab of region.slabs) {
        const a = slab.a.clone().applyMatrix4(slab.bone.matrixWorld), b = slab.b.clone().applyMatrix4(slab.bone.matrixWorld);
        const distance = segmentSegmentDistance(pommel, tip, a, b) - slab.radius - katana.radialExtent;
        if (distance < near) near = distance;
        if (distance < MARGIN) nearSlabs.push(slab);
      }
      const triggered = nearSlabs.length > 0;
      if (!triggered && !audit) { out.body[region.name] = { broadphaseMetres: round(near) }; continue; }
      const selected = audit ? region.slabs : nearSlabs, stamp = region.stamp ??= new Int32Array(region.ids.length).fill(-1), stampId = ++stampCounter;
      const vertexIds = [], triangles = [];
      for (const slab of selected) { for (let i = 0; i < slab.vertices.length; i++) { const k = slab.vertices[i]; if (stamp[k] !== stampId) { stamp[k] = stampId; vertexIds.push(k); } } for (let i = 0; i < slab.triangles.length; i++) triangles.push(slab.triangles[i]); }
      const world = skinSubset(skinned, region.skin, vertexIds);
      const exact = narrowphase(region, world, katana, triangles);
      out.body[region.name] = { broadphaseMetres: round(near), exactClearanceMetres: round(exact.clearance), beyondSearch: exact.clearance >= MARGIN, intersections: exact.intersections, slabs: selected.length, candidateTriangles: exact.candidateTriangles,
        ...(exact.intersections ? { alongMetres: [round(exact.alongMin), round(exact.alongMax)], point: exact.point } : {}), ...(audit ? { audit: true } : {}) };
      if (audit && exact.clearance < MARGIN) {
        // The audit ran every slab: the broadphase missed if the slabs it would have selected do not contain the nearest triangle (or any intersection).
        const nearTriangles = []; for (const slab of nearSlabs) for (let i = 0; i < slab.triangles.length; i++) nearTriangles.push(slab.triangles[i]);
        const selectedOnly = nearTriangles.length ? narrowphase(region, world, katana, nearTriangles) : { clearance: MARGIN, intersections: 0 };
        if (selectedOnly.clearance > exact.clearance + 1e-6 || selectedOnly.intersections < exact.intersections) state.broadphaseMisses.push({ t: round(time), region: region.name, broadphaseMetres: round(near), exactClearanceMetres: round(exact.clearance), selectedSlabsClearanceMetres: round(selectedOnly.clearance), intersections: exact.intersections, selectedSlabsIntersections: selectedOnly.intersections });
      }
    }
  }
  return out;
}

function summarize(samples, extra = {}) {
  const katana = samples.reduce((worst, s) => (s.katanaFloorMetres < worst.katanaFloorMetres ? s : worst));
  const feet = {};
  for (const foot of Object.keys(FEET)) {
    const series = samples.map((s) => s.feet[foot]), planted = series.filter((f) => f.planted);
    const lowest = series.reduce((worst, f) => (f.heightMetres < worst.heightMetres ? f : worst)), highest = series.reduce((best, f) => (f.heightMetres > best.heightMetres ? f : best));
    const slides = planted.slice(1).map((f) => f.slideMetresPerSecond), forwards = planted.slice(1).map((f) => f.forwardMetresPerSecond);
    // Planted episodes: consecutive planted samples; travel = integrated horizontal slide of the sole centroid while planted.
    const episodes = []; let current;
    series.forEach((f, k) => { if (f.planted) { if (!current) current = { from: samples[k].t, to: samples[k].t, travelMetres: 0, samples: 0 }; else { current.travelMetres += f.slideMetresPerSecond / HZ; } current.to = samples[k].t; current.samples++; } else if (current) { episodes.push(current); current = undefined; } });
    if (current) episodes.push(current);
    feet[foot] = { lowestMetres: lowest.heightMetres, lowestAt: samples[series.indexOf(lowest)].t, highestMetres: highest.heightMetres, plantedShare: round(planted.length / series.length),
      plantedSlideMeanMetresPerSecond: slides.length ? round(slides.reduce((a, b) => a + b, 0) / slides.length) : null, plantedSlideMaxMetresPerSecond: slides.length ? round(Math.max(...slides)) : null,
      plantedForwardMeanMetresPerSecond: forwards.length ? round(forwards.reduce((a, b) => a + b, 0) / forwards.length) : null,
      plantedEpisodes: episodes.map((e) => ({ ...e, travelMetres: round(e.travelMetres) })) };
  }
  const body = {};
  if (measureBody) for (const region of Object.keys(BONE_REGIONS)) {
    const exact = samples.map((s) => [s.t, s.body[region]]).filter(([, b]) => b.exactClearanceMetres !== undefined);
    const broad = Math.min(...samples.map((s) => s.body[region].broadphaseMetres));
    const intersecting = exact.filter(([, b]) => b.intersections > 0);
    const closest = exact.length ? exact.reduce((worst, e) => (e[1].exactClearanceMetres < worst[1].exactClearanceMetres ? e : worst)) : undefined;
    body[region] = { broadphaseMinMetres: round(broad), narrowphaseSamples: exact.length, exactMinClearanceMetres: closest ? closest[1].exactClearanceMetres : null, exactMinAt: closest ? closest[0] : null,
      beyondSearchEverywhere: !exact.length || exact.every(([, b]) => b.beyondSearch), intersectingSamples: intersecting.length, maxIntersections: intersecting.length ? Math.max(...intersecting.map(([, b]) => b.intersections)) : 0,
      intersectingWindow: intersecting.length ? [intersecting[0][0], intersecting[intersecting.length - 1][0]] : null,
      intersectingAlongMetres: intersecting.length ? [round(Math.min(...intersecting.map(([, b]) => b.alongMetres[0]))), round(Math.max(...intersecting.map(([, b]) => b.alongMetres[1])))] : null };
  }
  return { katanaFloorMinMetres: katana.katanaFloorMetres, katanaFloorMinAt: katana.t, katanaFloorMinAlongMetres: katana.katanaLowestAlongMetres, feet, body, samples: samples.length, ...extra };
}
/** Column-oriented per-sample series (one array per measurement) so a full clip set stays a few hundred kilobytes. */
function columns(samples) {
  const column = (pick) => samples.map(pick);
  const out = { t: column((s) => s.t), katanaFloorMetres: column((s) => s.katanaFloorMetres), katanaLowestAlongMetres: column((s) => s.katanaLowestAlongMetres),
    feet: Object.fromEntries(Object.keys(FEET).map((foot) => [foot, { heightMetres: column((s) => s.feet[foot].heightMetres), slideMetresPerSecond: column((s) => s.feet[foot].slideMetresPerSecond), forwardMetresPerSecond: column((s) => s.feet[foot].forwardMetresPerSecond) }])) };
  if (samples[0].engineSpeed !== undefined) { out.engineSpeed = column((s) => s.engineSpeed); out.rootY = column((s) => s.rootY); out.actionId = column((s) => s.actionId); }
  if (measureBody) out.body = Object.fromEntries(Object.keys(BONE_REGIONS).map((region) => [region, { broadphaseMetres: column((s) => s.body[region].broadphaseMetres), exactClearanceMetres: column((s) => s.body[region].exactClearanceMetres ?? null), intersections: column((s) => s.body[region].intersections ?? null) }]));
  return out;
}

const actorBase = { id: 'aren', archetypeId: 'aren', species: 'human', allegiance: 'player', position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: 1 },
  sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false, vitality: HERO_COMBAT.vesper.maxVitality };
const vesper = HERO_COMBAT.vesper, context = (alpha, loopTimeSeconds) => ({ interpolate: true, alpha, loopTimeSeconds, manifest: probeManifest, walkSpeed: vesper.walkSpeed });
const report = { schemaVersion: 1, hashes, paths: Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, p.startsWith(root) ? p.slice(root.length + 1) : p])),
  manifestMatchesHero: manifest.outputHash === hashes.hero, manifestOutputHash: manifest.outputHash, clipsInHero: clipNames, manifestActionsWithoutClip: missingClips, heroClipsNotInManifest: unmappedClips,
  sampleHz: HZ, bodyContactSearchMetres: MARGIN, plantedHeightMetres: PLANTED_HEIGHT, heroProfile: { walkSpeed: vesper.walkSpeed, runSpeed: vesper.runSpeed }, body: undefined, clips: {}, locomotion: {} };
const instance = createInstance(); stamp('instance ready (hand fitted, katana attached)');
const body = buildBody(instance); stamp('body regions and soles built');
report.body = { ...body.summary, feet: body.feetSummary, skinnedVertices: body.skinnedVertexCount, bones: body.boneNames, katana: { referencedVertices: instance.katana.vertices.length, radialExtentMetres: round(instance.katana.radialExtent), pommelAlongMetres: round(instance.pommelAlongMetres), tipAlongMetres: round(instance.tipAlongMetres) } };

for (const spec of measuredClips) {
  attachController(instance);
  const state = { feet: {}, broadphaseMisses: [] }, samples = [];
  const seconds = spec.loops ? Math.max(2 * spec.duration, 2) : spec.duration, steps = Math.ceil(seconds * 60);
  // Clock 0: the action's first snapshot (normalized 0) is driven and sampled before any step so frame 0 and the first subframes are covered; later steps interpolate from it.
  let previous = { ...actorBase, actionId: spec.action, phase: spec.loops ? 'idle' : 'active', normalizedTime: 0 };
  driveActorAnimation(instance.instance, previous, undefined, context(1, 0));
  samples.push(sample(instance, body, state, 0, 0, false));
  for (let step = 0; step < steps; step++) {
    const now = { ...actorBase, actionId: spec.action, phase: spec.loops ? 'idle' : 'active', normalizedTime: spec.loops ? 0 : Math.min(1, (step + 1) / 60 / spec.duration) };
    for (let s = 1; s <= SUBDIVISIONS; s++) {
      const alpha = s / SUBDIVISIONS, time = (step + alpha) / 60;
      driveActorAnimation(instance.instance, now, previous, context(alpha, time));
      instance.animation.update(1 / HZ);
      samples.push(sample(instance, body, state, time, 0, AUDIT_EVERY > 0 && step % AUDIT_EVERY === 0 && s === SUBDIVISIONS));
    }
    previous = now;
  }
  report.clips[spec.clip] = { action: spec.action, aliases: spec.aliases, mapping: spec.mapping, durationSeconds: round(spec.duration), loops: spec.loops, ...summarize(samples, { broadphaseMisses: state.broadphaseMisses }), series: columns(samples) };
  console.error(`${spec.clip}: katana floor ${report.clips[spec.clip].katanaFloorMinMetres} m, feet L ${report.clips[spec.clip].feet.left.lowestMetres} R ${report.clips[spec.clip].feet.right.lowestMetres} m${measureBody ? ', body ' + Object.entries(report.clips[spec.clip].body).filter(([, b]) => b.exactMinClearanceMetres !== null).map(([r, b]) => `${r} ${b.exactMinClearanceMetres}${b.intersectingSamples ? ' x' + b.intersectingSamples : ''}`).join(' ') : ''} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
}

// Engine locomotion: the unchanged CombatEngine (default ±12 m flat arena, Vesper profile) crosses the arena at walk/run speed while the real driver animates the clip.
if (measureEngine) for (const [mode, sprintHeld] of [['walk', false], ['run', true]]) {
  const action = sprintHeld ? 'aren-run' : 'aren-walk';
  if (!clipNames.includes(manifest.actionToClipMapping[action])) { report.locomotion[mode] = { action, skipped: `clip ${manifest.actionToClipMapping[action]} is not in the hero GLB` }; continue; }
  if (onlyClips.length && !onlyClips.includes(action) && !onlyClips.includes(manifest.actionToClipMapping[action])) continue;
  const engine = new CombatEngine(); engine.setPlayerHero('vesper');
  const base = { tick: 0, move: { x: 0, y: 0, z: 0 }, sprintHeld: false, dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
  const actor = () => engine.snapshot().actors.find((candidate) => candidate.id === 'aren');
  // Back off to the far wall first (camera-basis +z input travels world -z), then settle so the measured crossing starts from idle at rest.
  for (let k = 0; k < 150; k++) engine.fixedStep({ ...base, move: { x: 0, y: 0, z: -1 }, sprintHeld: true });
  for (let k = 0; k < 120; k++) engine.fixedStep(base);
  attachController(instance);
  const state = { feet: {}, broadphaseMisses: [] }, samples = [], speeds = [];
  let previous = actor(), startZ = previous.position.z;
  // Clock 0: the actual resting idle snapshot is driven and sampled first, so the measured crossing includes the real idle → walk/run crossfade rather than starting the gait at full weight.
  instance.actorRoot.position.set(previous.position.x, previous.position.y, previous.position.z); instance.actorRoot.rotation.y = Math.atan2(previous.facing.x, previous.facing.z);
  driveActorAnimation(instance.instance, previous, undefined, context(1, 0));
  { const s0 = sample(instance, body, state, 0, 0, false); s0.engineSpeed = round(Math.hypot(previous.velocity.x, previous.velocity.z)); s0.actionId = previous.actionId; s0.rootY = round(instance.actorRoot.position.y); samples.push(s0); }
  for (let step = 0; step < 600; step++) {
    engine.fixedStep({ ...base, move: { x: 0, y: 0, z: 1 }, sprintHeld });
    const now = actor(), speed = Math.hypot(now.velocity.x, now.velocity.z);
    speeds.push(round(speed));
    for (let s = 1; s <= SUBDIVISIONS; s++) {
      const alpha = s / SUBDIVISIONS, time = (step + alpha) / 60;
      instance.actorRoot.position.set(previous.position.x, previous.position.y, previous.position.z).lerp(new Vector3(now.position.x, now.position.y, now.position.z), alpha);
      instance.actorRoot.rotation.y = Math.atan2(now.facing.x, now.facing.z);
      driveActorAnimation(instance.instance, now, previous, context(alpha, time));
      instance.animation.update(1 / HZ);
      const s0 = sample(instance, body, state, time, 0, AUDIT_EVERY > 0 && step % AUDIT_EVERY === 0 && s === SUBDIVISIONS);
      s0.engineSpeed = round(speed); s0.actionId = now.actionId; s0.rootY = round(instance.actorRoot.position.y);
      samples.push(s0);
    }
    previous = now;
    if (Math.abs(now.position.z) > 10.5 && Math.sign(now.position.z) !== Math.sign(startZ)) break;
  }
  const target = sprintHeld ? vesper.runSpeed : vesper.walkSpeed, steady = samples.filter((s) => s.engineSpeed >= target * 0.98);
  const steadyFeet = steady.length ? summarize(steady).feet : null;
  report.locomotion[mode] = { action, clip: manifest.actionToClipMapping[action], profileSpeed: target, engineSpeedMax: Math.max(...speeds), steadyShare: round(steady.length / samples.length), travelMetres: round(Math.abs(previous.position.z - startZ)),
    actionIdsSeen: [...new Set(samples.map((s) => s.actionId))], ...summarize(samples, { broadphaseMisses: state.broadphaseMisses }), steadyStateFeet: steadyFeet, series: columns(samples) };
  console.error(`engine ${mode}: speed ${report.locomotion[mode].engineSpeedMax} (profile ${target}), katana floor ${report.locomotion[mode].katanaFloorMinMetres} m, planted slide mean L ${steadyFeet?.left.plantedSlideMeanMetresPerSecond} R ${steadyFeet?.right.plantedSlideMeanMetresPerSecond} m/s (forward L ${steadyFeet?.left.plantedForwardMeanMetresPerSecond} R ${steadyFeet?.right.plantedForwardMeanMetresPerSecond}) (${((Date.now() - started) / 1000).toFixed(0)} s)`);
}
instance.weapon.dispose(); instance.animation.dispose();

report.bodyMeasured = measureBody;
report.method = `Unchanged AnimationController/ActorAnimationDriver/WardenWeapon (and CombatEngine for walk/run) on the delivered hero and real fitted katana; ${SUBDIVISIONS} rendered subdivisions per 60 Hz step plus a clock-0 sample of the first snapshot (clips: normalized 0; locomotion: the actual resting idle, so the idle → gait crossfade is measured). `
  + 'Katana floor: lowest referenced katana vertex (world y) above the flat world floor at y 0. Feet: actual skinned sole vertices of each foot (rest-pose lowest band), height above the floor and horizontal slide of the sole centroid while planted (height <= plantedHeightMetres). '
  + (measureBody
    ? 'Body contact (supporting diagnostic, no proxy acceptance, not an all-geometry proof): broadphase = blade axis segment versus rest-fitted slab capsules riding each region bone plus the katana radial extent; slabs within bodyContactSearchMetres go to the exact skinned-triangle narrowphase: nearest BODY vertex to the katana triangle surface within bodyContactSearchMetres (body mesh ~1.5 mm dense, so about 1 mm resolution of the true surface distance) and katana-triangle/body-triangle intersections. The right hand is excluded (it holds the tsuka); rightArm is RightArm+RightForeArm only. Clearances >= bodyContactSearchMetres are not resolved further. Every audit-every step the narrowphase also runs on all slabs to check the broadphase selection (broadphaseMisses). '
    : 'Body contact NOT measured in this run (--no-body): no body clearance or intersection claim is made. ')
  + 'Clip probe: root at rest, synthetic player snapshot; locomotion: engine-driven root at HeroProfiles speed. Image decoding alone is bypassed.';
report.elapsedSeconds = round((Date.now() - started) / 1000);
mkdirSync(dirname(paths.output), { recursive: true });
writeFileSync(paths.output, JSON.stringify(report, null, 1) + '\n');
const brief = (entry) => ({ katanaFloorMinMetres: entry.katanaFloorMinMetres, feet: Object.fromEntries(Object.entries(entry.feet).map(([f, v]) => [f, { lowest: v.lowestMetres, plantedShare: v.plantedShare, slideMean: v.plantedSlideMeanMetresPerSecond, forwardMean: v.plantedForwardMeanMetresPerSecond }])),
  body: entry.body ? Object.fromEntries(Object.entries(entry.body).filter(([, b]) => b.narrowphaseSamples).map(([r, b]) => [r, { exactMin: b.exactMinClearanceMetres, intersectingSamples: b.intersectingSamples, along: b.intersectingAlongMetres }])) : undefined,
  broadphaseMisses: entry.broadphaseMisses?.length, ...(entry.engineSpeedMax !== undefined ? { engineSpeedMax: entry.engineSpeedMax, profileSpeed: entry.profileSpeed, steadyPlanted: entry.steadyStateFeet && Object.fromEntries(Object.entries(entry.steadyStateFeet).map(([f, v]) => [f, { slideMean: v.plantedSlideMeanMetresPerSecond, forwardMean: v.plantedForwardMeanMetresPerSecond }])) } : {}) });
console.log(JSON.stringify({ hashes, manifestMatchesHero: report.manifestMatchesHero, manifestActionsWithoutClip: missingClips.length, heroClipsNotInManifest: unmappedClips, output: paths.output,
  clips: Object.fromEntries(Object.entries(report.clips).map(([name, entry]) => [name, brief(entry)])), locomotion: Object.fromEntries(Object.entries(report.locomotion).map(([mode, entry]) => [mode, entry.skipped ? entry : brief(entry)])) }, null, 2));
