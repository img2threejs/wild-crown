import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { Quaternion, Texture, TextureLoader, Vector3 } from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { Rig } from './retarget-aren-tripo-clips.mjs';
import { parseGlb } from './import-aren-animation-set.mjs';

/**
 * Mixamo FBX donors for the hero clip authors.
 *
 * `loadMixamoDonor(file)` parses an animation FBX (Mixamo "Without Skin" 30 fps, or a Tripo `--out-format fbx` retarget) or a Mixamo-rig GLB (Viggle `mixamo-glb`) with three's FBXLoader and
 * re-expresses its skeleton and take as an in-memory glTF source, so the result is a stock `Rig` with `decodeAnimation(name)` — exactly the shape the
 * Tripo donors have in `retarget-aren-tripo-clips.mjs` (`rigs[key]`, `{ source: { donor: key, animation } }`). `buildClip`, `retargetFrames` and the
 * world-space rest-pose retarget then treat it like any other donor; nothing else is special-cased.
 *
 *   - Bone names are normalised to `mixamorig:<Joint>` (FBXLoader strips the colon: `mixamorigHips`; Mixamo's `mixamorig1:` variants are folded too).
 *   - Units: centimetre files are scaled to metres (detected from the rest hips height: a hips above 10 units is centimetres). Retarget scaling of the
 *     hips travel uses the rest hip-height ratio, so unit differences would cancel anyway; normalising keeps `restWorldPosition` readable.
 *   - Rest pose: the bind pose when the file carries a skin (`SkinnedMesh.skeleton.boneInverses`, Tripo FBX: the node defaults there are frame 0 of the take),
 *     else the default node transforms (Mixamo "Without Skin" files store their T-pose there).
 *   - `inPlace` pins the Hips' horizontal travel to the first key (the vertical bob is kept); use it where the Mixamo "In Place" option was not downloaded.
 *
 * Spec usage in an author script:
 *   `{ clip, source: { donor: 'mixamo', file: 'asset-source/mixamo/sakda/Roundhouse Kick.fbx' }, … }` (also inside `parts`), then
 *   `await resolveMixamoSources(specs, rigs, root)` once before `buildClip`; it loads each file once and rewrites the source to `{ donor: <key>, animation }`.
 */

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** FBXLoader tries to decode embedded textures through the DOM; neither an animation donor nor a rig rebuild uses them. */
export function parseFbx(bytes) {
  const original = TextureLoader.prototype.load, warn = console.warn, hadWindow = 'window' in globalThis;
  TextureLoader.prototype.load = () => new Texture();
  // A rigged-character FBX embeds its texture; FBXLoader turns it into a blob URL through `window.URL`, which Node lacks.
  if (!hadWindow) globalThis.window = { URL: { createObjectURL: () => '' } };
  console.warn = (...values) => { if (!String(values[0]).startsWith('FBXLoader: Image type')) warn(...values); };
  try {
    return new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  } finally {
    TextureLoader.prototype.load = original;
    if (!hadWindow) delete globalThis.window;
    console.warn = warn;
  }
}

/**
 * A Mixamo-rig motion delivered as binary glTF (Viggle/PINOC `mixamo-glb`: X Bot mesh, 65 `mixamorig:` joints under a Y-up root, metres). The glTF is the
 * source as is; the rest pose is its skin's bind pose (the node defaults).
 */
function glbSource(bytes, label) {
  const source = parseGlb(bytes);
  if (!source.json.animations?.length) throw new Error(`${label}: GLB has no animation`);
  const hipsNode = source.json.nodes.findIndex((node) => node.name === 'mixamorig:Hips');
  if (hipsNode < 0) throw new Error(`${label}: GLB has no mixamorig:Hips`);
  return { source, hipsNode, unitScale: 1, bindPose: true };
}

/** `mixamorigHips` / `mixamorig1:Hips` / `mixamorig:Hips` → `mixamorig:Hips`; every other name is left alone. */
export function normalizeBoneName(name) {
  const match = /^mixamorig\d*:?(.+)$/.exec(name);
  return match ? `mixamorig:${match[1]}` : name;
}

/** The synthetic glTF source (`{ json, bin }`) of a parsed FBX scene: ancestors + bones as nodes, the take as glTF animations. */
function buildSource(scene) {
  const bones = [];
  scene.traverse((object) => { if (object.isBone) bones.push(object); });
  if (!bones.length) throw new Error('FBX contains no skeleton bones');
  const included = new Set();
  for (const bone of bones) for (let node = bone; node; node = node.parent) included.add(node);
  const ordered = [];
  scene.traverse((object) => { if (included.has(object)) ordered.push(object); });
  const indexOf = new Map(ordered.map((object, i) => [object, i]));
  const hips = ordered.find((object) => object.isBone && normalizeBoneName(object.name) === 'mixamorig:Hips');
  if (!hips) throw new Error('FBX has no Hips bone (expected Mixamo/Tripo mixamorig:* naming)');

  // Bind pose from the skin when the file carries one (Tripo FBX): bone world = inverse(boneInverse); local = parentWorld⁻¹ · world, where a parent
  // outside the skeleton (the Armature group, which is never animated) contributes its default world matrix.
  const bindLocal = new Map();
  const skinned = [];
  scene.updateMatrixWorld(true);
  scene.traverse((object) => { if (object.isSkinnedMesh) skinned.push(object); });
  if (skinned.length) {
    const { bones: skeletonBones, boneInverses } = skinned[0].skeleton, worlds = new Map();
    skeletonBones.forEach((bone, i) => worlds.set(bone, boneInverses[i].clone().invert()));
    for (const [bone, world] of worlds) {
      const local = (worlds.get(bone.parent) ?? bone.parent.matrixWorld).clone().invert().multiply(world);
      const position = new Vector3(), quaternion = new Quaternion(), scale = new Vector3();
      local.decompose(position, quaternion, scale);
      bindLocal.set(bone, { position, quaternion, scale });
    }
  }

  const nodes = ordered.map((object) => {
    const bind = bindLocal.get(object), position = bind?.position ?? object.position, quaternion = bind?.quaternion ?? object.quaternion, scale = bind?.scale ?? object.scale;
    const node = { name: object.isBone ? normalizeBoneName(object.name) : `__${object.name || 'group'}${indexOf.get(object)}`, translation: position.toArray(), rotation: quaternion.toArray(), scale: scale.toArray() };
    const children = object.children.filter((child) => included.has(child)).map((child) => indexOf.get(child));
    if (children.length) node.children = children;
    return node;
  });

  // Unit scale: centimetre files are converted to metres by scaling every translation (node rests and animated position keys).
  const world = new Rig({ json: { nodes: structuredClone(nodes), skins: [{ joints: [] }] }, bin: Buffer.alloc(0) });
  const hipsHeight = world.restWorldPosition[indexOf.get(hips)].y;
  const unitScale = hipsHeight > 10 ? 0.01 : 1;
  if (unitScale !== 1) for (const node of nodes) node.translation = node.translation.map((value) => value * unitScale);

  const chunks = [], accessors = [], bufferViews = [{ buffer: 0, byteOffset: 0, byteLength: 0 }];
  let byteLength = 0;
  const addAccessor = (array, type) => {
    const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    chunks.push(bytes);
    accessors.push({ bufferView: 0, byteOffset: byteLength, componentType: 5126, count: array.length / { SCALAR: 1, VEC3: 3, VEC4: 4 }[type], type });
    byteLength += bytes.length;
    return accessors.length - 1;
  };
  const byName = new Map(ordered.map((object, i) => [object.name, i]));
  const animations = scene.animations.map((clip, clipIndex) => {
    const channels = [], samplers = [];
    for (const track of clip.tracks) {
      const dot = track.name.lastIndexOf('.'), node = byName.get(track.name.slice(0, dot)), property = track.name.slice(dot + 1);
      const path = { position: 'translation', quaternion: 'rotation', scale: 'scale' }[property];
      if (node === undefined || !path) continue;
      let values = Float32Array.from(track.values);
      if (path === 'translation' && unitScale !== 1) values = values.map((value) => value * unitScale);
      samplers.push({ input: addAccessor(Float32Array.from(track.times), 'SCALAR'), output: addAccessor(values, path === 'rotation' ? 'VEC4' : 'VEC3'), interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node, path } });
    }
    return { name: clip.name || `take-${clipIndex}`, channels, samplers };
  });
  bufferViews[0].byteLength = byteLength;
  const json = { nodes, skins: [{ joints: bones.map((bone) => indexOf.get(bone)) }], accessors, bufferViews, animations };
  return { source: { json, bin: Buffer.concat(chunks) }, hipsNode: indexOf.get(hips), unitScale, bindPose: bindLocal.size > 0 };
}

/** Horizontal heading (radians about +Y; 0 = +X, + turns toward -Z) of a rig's rest pose: the mean foot → toe-base direction. Mixamo's Y Bot faces +Z, Tripo's mixamo-spec rigs +X. */
export function restForwardYaw(rig) {
  const sum = new Vector3(), toe = new Vector3(), foot = new Vector3();
  for (const side of ['Left', 'Right']) {
    toe.copy(rig.restWorldPosition[rig.index.get(`mixamorig:${side}ToeBase`)]);
    foot.copy(rig.restWorldPosition[rig.index.get(`mixamorig:${side}Foot`)]);
    sum.add(toe.sub(foot));
  }
  return Math.atan2(-sum.z, sum.x);
}

/** Rest bone direction = joint → this child joint. Bones without a child entry (Head, hands, toes) inherit the alignment of their parent bone. */
const BONE_CHILD = { Hips: 'Spine', Spine: 'Spine1', Spine1: 'Spine2', Spine2: 'Neck', Neck: 'Head',
  LeftShoulder: 'LeftArm', LeftArm: 'LeftForeArm', LeftForeArm: 'LeftHand', RightShoulder: 'RightArm', RightArm: 'RightForeArm', RightForeArm: 'RightHand',
  LeftUpLeg: 'LeftLeg', LeftLeg: 'LeftFoot', RightUpLeg: 'RightLeg', RightLeg: 'RightFoot' };
// Feet inherit the shin's alignment (Y Bot's ankle sits above its toe joint, the hero's is level: aligning Foot→ToeBase would pitch a flat foot toe-down). Order matters: ToeBase reads Foot.
const END_PARENT = { Head: 'Neck', LeftHand: 'LeftForeArm', RightHand: 'RightForeArm', LeftFoot: 'LeftLeg', RightFoot: 'RightLeg', LeftToeBase: 'LeftFoot', RightToeBase: 'RightFoot' };

/**
 * Rest-pose alignment of a donor to the hero. Mixamo's Y Bot rests in a T-pose, the Tripo hero rigs in an A-pose, so the plain world-space retarget
 * (target world = Δ · R_target, Δ = W_donor · R_donor⁻¹) would stack the donor's arm rotation on the hero's already-lowered arms. Per bone, A is the
 * minimal-arc world rotation taking the hero's rest bone direction onto the donor's (already facing-aligned) one; the donor's effective rest becomes
 * R' = A⁻¹ · R_donor, so retargetFrames yields Δ · A · R_target: every bone points exactly where the donor's bone points. Only the donor Rig's
 * `restWorldQuaternion` is replaced (retargetFrames reads nothing else of it). Returns the largest alignment angle per bone in degrees.
 */
export function alignRestPose(donor, target) {
  const alignment = new Map(), report = {}, direction = (rig, parent, child, out) => out.copy(rig.restWorldPosition[rig.index.get(`mixamorig:${child}`)]).sub(rig.restWorldPosition[rig.index.get(`mixamorig:${parent}`)]).normalize();
  const dTarget = new Vector3(), dDonor = new Vector3();
  const have = (name) => donor.index.has(`mixamorig:${name}`) && target.index.has(`mixamorig:${name}`);
  for (const [bone, child] of Object.entries(BONE_CHILD)) {
    if (!have(bone) || !have(child)) continue;
    alignment.set(bone, new Quaternion().setFromUnitVectors(direction(target, bone, child, dTarget), direction(donor, bone, child, dDonor)));
  }
  for (const [bone, parent] of Object.entries(END_PARENT)) if (have(bone) && alignment.has(parent)) alignment.set(bone, alignment.get(parent));
  for (const [bone, a] of alignment) {
    const index = donor.index.get(`mixamorig:${bone}`);
    donor.restWorldQuaternion[index] = a.clone().invert().multiply(donor.restWorldQuaternion[index]);
    report[bone] = Math.round(2 * Math.acos(Math.min(1, Math.abs(a.w))) * 180 / Math.PI * 10) / 10;
  }
  return report;
}

/** Pins the Hips' horizontal travel (world x/z of its parent frame) to the first key; the vertical component is kept. Mutates the source in place. */
export function pinHipsHorizontal(source, rig, hipsNode) {
  const parent = rig.parent[hipsNode], parentRotation = parent >= 0 ? rig.restWorldQuaternion[parent] : new Quaternion();
  const inverse = parentRotation.clone().invert(), delta = new Vector3();
  for (const animation of source.json.animations) {
    const channel = animation.channels.find((item) => item.target.node === hipsNode && item.target.path === 'translation');
    if (!channel) continue;
    const accessor = source.json.accessors[animation.samplers[channel.sampler].output];
    const values = new Float32Array(source.bin.buffer, source.bin.byteOffset + accessor.byteOffset, accessor.count * 3);
    const base = new Vector3().fromArray(values, 0);
    for (let k = 0; k < accessor.count; k += 1) {
      delta.fromArray(values, k * 3).sub(base).applyQuaternion(parentRotation);
      delta.x = 0; delta.z = 0;
      delta.applyQuaternion(inverse).add(base).toArray(values, k * 3);
    }
  }
}

/**
 * Loads one animation FBX.
 * @param {string} file path (absolute, or relative to `root`)
 * @param {{ root?: string, inPlace?: boolean, target?: Rig }} [options] `target`: the hero rig the clip will be retargeted onto; the donor is turned about +Y to the target's rest heading (Mixamo +Z → hero +X) and its rest is aligned bone by bone (`alignRestPose`)
 * @returns {Promise<{ rig: Rig, animation: string, animations: string[], duration: number, file: string, sha256: string, unitScale: number, frames: number, bindPose: boolean, facingDegrees: number, alignment?: object }>}
 *   `rig` is a `Rig` over the FBX skeleton (use as `rigs[key]`); `animation` is the first take's name (`rig.decodeAnimation(animation)`).
 */
export async function loadMixamoDonor(file, { root = process.cwd(), inPlace = false, target } = {}) {
  const path = isAbsolute(file) ? file : resolve(root, file);
  const base = await parseFile(path, file);
  // Every caller gets its own copy (the in-place pin edits the key data); the FBX itself is parsed once per process.
  const source = { json: structuredClone(base.source.json), bin: Buffer.from(base.source.bin) };
  let rig = new Rig(source);
  if (inPlace) pinHipsHorizontal(source, rig, base.hipsNode);
  let facingDegrees = 0, alignment;
  if (target) {
    // An extra root node above the scene turns the whole donor; the world-space retarget (Δ = W·R⁻¹, hips travel) then sees a donor that faces like the hero.
    const yaw = restForwardYaw(target) - restForwardYaw(rig);
    facingDegrees = Math.round(yaw * 180 / Math.PI * 100) / 100;
    const top = source.json.nodes.findIndex((_, i) => !source.json.nodes.some((node) => node.children?.includes(i)));
    source.json.nodes.push({ name: '__facing', rotation: new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), yaw).toArray(), children: [top] });
    rig = new Rig(source);
    alignment = alignRestPose(rig, target);
  }
  const animations = source.json.animations.map((item) => item.name);
  const decoded = rig.decodeAnimation(animations[0]);
  return { rig, animation: animations[0], animations, duration: decoded.duration, file, sha256: base.sha256, unitScale: base.unitScale, frames: Math.round(decoded.duration * 30) + 1, bindPose: base.bindPose, facingDegrees, alignment };
}

const parsedFiles = new Map();
function parseFile(path, label) {
  if (!parsedFiles.has(path)) {
    parsedFiles.set(path, (async () => {
      const bytes = await readFile(path);
      if (/\.glb$/i.test(path)) return { ...glbSource(bytes, label), sha256: sha256(bytes) };
      const scene = parseFbx(bytes);
      if (!scene.animations.length) throw new Error(`${label}: FBX has no animation take`);
      return { ...buildSource(scene), sha256: sha256(bytes) };
    })());
  }
  return parsedFiles.get(path);
}

/**
 * Resolves every `source: { donor: 'mixamo', file, inPlace? }` of the specs (and of their `parts`) in place: loads each file once into `rigs['mixamo:<file>']`
 * and rewrites the source to `{ donor: 'mixamo:<file>', animation, file }`. Returns the loaded donors keyed by file (provenance: sha256, duration, units).
 */
export async function resolveMixamoSources(specs, rigs, root = process.cwd()) {
  const loaded = new Map();
  for (const spec of specs) for (const holder of spec.parts ?? [spec]) {
    const source = holder.source;
    if (source?.donor !== 'mixamo') continue;
    const key = `mixamo:${source.file}${source.inPlace ? ':in-place' : ''}`;
    if (!loaded.has(key)) {
      const donor = await loadMixamoDonor(source.file, { root, inPlace: source.inPlace, target: rigs.target });
      rigs[key] = donor.rig;
      loaded.set(key, donor);
    }
    const donor = loaded.get(key);
    holder.source = { donor: key, animation: source.animation ?? donor.animation, file: source.file };
  }
  return Object.fromEntries([...loaded.values()].map((donor) => [donor.file, { sha256: donor.sha256, duration: donor.duration, animation: donor.animation, unitScale: donor.unitScale, frames: donor.frames, bindPose: donor.bindPose, facingDegrees: donor.facingDegrees, alignment: donor.alignment }]));
}
