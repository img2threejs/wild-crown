// Read-only authoring measurement: bundle with the existing esbuild (platform=node, format=esm, packages=external) into a directory that resolves
// node_modules, then run with Node from the repository root (or pass --root); --hero/--sword/--anatomy measure snapshot copies instead of the delivered files.
// Parses delivered geometry/skeletons, bypassing only image decoding. Does not run tests or change assets.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Mesh, MeshBasicMaterial, MeshStandardMaterial, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { computeHandGrip } from '../../../src/rendering/NativeHandGrip.ts';
import { KATANA_GRIP, WardenWeapon } from '../../../src/rendering/WardenWeapon.ts';
const args = process.argv.slice(2), option = (name, fallback) => { const k = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`)); if (k < 0) return fallback; const inline = args[k].indexOf('='); return inline >= 0 ? args[k].slice(inline + 1) : args[k + 1]; };
const root = resolve(option('root', process.cwd())), output = 'asset-source/generated/actor-vesper-hero-01/';
const paths = { hero: resolve(root, option('hero', output + 'vesper-hero-animated.glb')), sword: resolve(root, option('sword', 'asset-source/generated/prop-vesper-katana-runtime-02/prop-vesper-katana.glb')),
  anatomy: resolve(root, option('anatomy', output + 'anatomy-report.json')) };
const hashes = {};
const [hero, sword] = await Promise.all(['hero', 'sword'].map(async (key, k) => {
  const bytes = readFileSync(paths[key]);
  hashes[key] = createHash('sha256').update(bytes).digest('hex');
  return new GLTFLoader().register(() => ({ name: 'placeholder-material', loadMaterial: () => Promise.resolve(k ? new MeshStandardMaterial() : new MeshBasicMaterial()) }))
    .parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
}));
hero.scene.scale.setScalar(1.7); hero.scene.updateMatrixWorld(true);
const grip = computeHandGrip(hero.scene, true, KATANA_GRIP.diagonalRadians, KATANA_GRIP.edgeRadians);
const anatomy = JSON.parse(readFileSync(paths.anatomy, 'utf8')), report = anatomy.grip;
let postPoseHookRequested = false;
const weapon = new WardenWeapon({ root: sword.scene, dispose: () => undefined },
  { root: hero.scene, animation: { setPostPose: (hook) => { postPoseHookRequested ||= hook !== undefined; } } }, 'katana');
hero.scene.updateMatrixWorld(true);
const toHand = grip.hand.matrixWorld.clone().invert();
const socket = weapon.sockets.weapon.getWorldPosition(new Vector3()).applyMatrix4(toHand);
const tip = weapon.sockets['weapon-tip'].getWorldPosition(new Vector3()).applyMatrix4(toHand);
console.log(JSON.stringify({ hashes, anatomyOutputHash: anatomy.outputHash, anatomyMatchesHero: anatomy.outputHash === hashes.hero, katanaGrip: KATANA_GRIP, axis: grip.axis.toArray(), edge: grip.curl.clone().negate().toArray(), palm: grip.palm.toArray(),
  axisErrorRig: grip.axis.distanceTo(new Vector3(...report.bladeAxisHand)), edgeErrorRig: grip.curl.clone().negate().distanceTo(new Vector3(...report.edgeAxisHand)),
  palmErrorRig: grip.palm.distanceTo(new Vector3(...report.palmHand)), radiusErrorRig: grip.shaftRadius / 1.7 - report.shaftRadiusRig,
  socketErrorRig: socket.distanceTo(grip.palm), tipAxisDot: tip.sub(socket).normalize().dot(grip.axis), fingerChains: grip.joints.length,
  rigidFist: Boolean(grip.rigid), postPoseHookRequested }, null, 2));
weapon.dispose();
for (const gltf of [hero, sword]) gltf.scene.traverse((node) => { if (node instanceof Mesh) node.geometry.dispose(); });
