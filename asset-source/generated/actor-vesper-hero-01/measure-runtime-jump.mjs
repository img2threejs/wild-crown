// Authoring measurement, not a test: bundle with the existing esbuild (platform=node, format=esm, packages=external) into a directory that resolves
// node_modules, then run with Node from the repository root (or pass --root). Explicit --hero/--manifest/--sword/--output paths measure a snapshot
// without touching the delivered files; the defaults are the delivered files and asset-source/generated/actor-vesper-hero-01/runtime-jump-report.json.
// Executes the unchanged CombatEngine, ActorAnimationDriver and AnimationController with delivered skeleton/weapon geometry.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { CombatEngine } from '../../../src/game/combat/CombatEngine.ts';
import { AnimationController } from '../../../src/rendering/AnimationController.ts';
import { driveActorAnimation } from '../../../src/rendering/ActorAnimationDriver.ts';
import { referencedVertices } from '../../../src/rendering/NativeHandGrip.ts';
import { WardenWeapon } from '../../../src/rendering/WardenWeapon.ts';
const args = process.argv.slice(2), option = (name, fallback) => { const k = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`)); if (k < 0) return fallback; const inline = args[k].indexOf('='); return inline >= 0 ? args[k].slice(inline + 1) : args[k + 1]; };
const root = resolve(option('root', process.cwd())), output = 'asset-source/generated/actor-vesper-hero-01/';
const paths = { hero: resolve(root, option('hero', output + 'vesper-hero-animated.glb')), manifest: resolve(root, option('manifest', output + 'manifest-entry.json')),
  sword: resolve(root, option('sword', 'asset-source/generated/prop-vesper-katana-runtime-02/prop-vesper-katana.glb')), output: resolve(root, option('output', output + 'runtime-jump-report.json')) };
const manifestBytes = readFileSync(paths.manifest), manifest = JSON.parse(manifestBytes.toString('utf8'));
const buffers = [readFileSync(paths.hero), readFileSync(paths.sword)];
const [hero, sword] = await Promise.all(buffers.map(async (bytes, k) => new GLTFLoader()
  .register(() => ({ name: 'placeholder-material', loadMaterial: () => Promise.resolve(k ? new MeshStandardMaterial() : new MeshBasicMaterial()) }))
  .parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')));
// The driver plays aren-jump (plain) and aren-air-step (boosted); a snapshot GLB without them is reported, not pretended.
const clipNames = hero.animations.map((clip) => clip.name);
const missingClips = ['aren-jump', 'aren-air-step'].map((action) => ({ action, clip: manifest.actionToClipMapping[action] })).filter(({ clip }) => !clip || !clipNames.includes(clip));
const run = { tick: 0, move: { x: 0, y: 0, z: 1 }, sprintHeld: true, dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
const scenarios = [], point = new Vector3();
// Boosted (Air Step) flight at four boost timings, then the plain jump (no boost: the standard aren-jump mapping over takeoff/rising/falling/landing).
for (const boostAt of [1, 5, 15, 21, null]) {
  if (missingClips.some(({ action }) => action === 'aren-jump' || (boostAt !== null && action === 'aren-air-step'))) { scenarios.push({ boostAt, kind: boostAt === null ? 'plain' : 'boosted', skipped: 'clip missing from the hero GLB', missingClips }); continue; }
  const engine = new CombatEngine(); engine.setPlayerHero('vesper');
  const model = cloneSkinned(hero.scene), actorRoot = new Group(); actorRoot.add(model);
  model.scale.setScalar(manifest.coordinateTransform.scale);
  model.rotation.y = Math.atan2(manifest.coordinateTransform.forward.x, manifest.coordinateTransform.forward.z);
  const offset = manifest.coordinateTransform.originOffset;
  if (offset) model.position.set(offset.x, offset.y, offset.z);
  model.traverse((node) => { if ('isSkinnedMesh' in node && node.isSkinnedMesh) node.skeleton.boneInverses = node.skeleton.boneInverses.map((matrix) => matrix.clone()); });
  const animation = new AnimationController(model, hero.animations, manifest);
  const instance = { assetId: manifest.id, root: actorRoot, animation };
  const swordRoot = sword.scene.clone(), weapon = new WardenWeapon({ root: swordRoot, dispose: () => undefined }, instance, 'katana');
  const surfaces = [];
  swordRoot.traverse((node) => { if (node instanceof Mesh) surfaces.push({ node, positions: node.geometry.getAttribute('position'), vertices: referencedVertices(node.geometry) }); });
  const samples = []; let previous = engine.snapshot().actors.find((actor) => actor.id === 'aren');
  let minimum = Infinity, worst, landedAt = null, sawAirborne = false, boostObserved = false;
  const record = (step, actor) => {
    let floor = Infinity;
    for (const { node, positions, vertices } of surfaces) for (const vertex of vertices) floor = Math.min(floor, point.fromBufferAttribute(positions, vertex).applyMatrix4(node.matrixWorld).y);
    const sample = { step, phase: actor.jumpPhase ?? 'grounded', phaseProgress: actor.jumpPhaseProgress, rootHeight: actorRoot.position.y, weaponFloorMetres: floor };
    samples.push(sample);
    if (floor < minimum) { minimum = floor; worst = sample; }
  };
  actorRoot.position.set(previous.position.x, previous.position.y, previous.position.z);
  actorRoot.rotation.y = Math.atan2(previous.facing.x, previous.facing.z);
  driveActorAnimation(instance, previous, undefined, { interpolate: true, alpha: 1, loopTimeSeconds: 0, manifest });
  actorRoot.updateMatrixWorld(true);
  record(0, previous);
  for (let step = 0; step < 120; step += 1) {
    engine.fixedStep({ ...run, jumpPressed: step === 0 || (boostAt !== null && step === boostAt + 1) });
    const actor = engine.snapshot().actors.find((candidate) => candidate.id === 'aren');
    boostObserved ||= actor.jumpBoosted === true;
    for (let subdivision = 1; subdivision <= 4; subdivision += 1) {
      const alpha = subdivision / 4;
      actorRoot.position.set(previous.position.x, previous.position.y, previous.position.z).lerp(new Vector3(actor.position.x, actor.position.y, actor.position.z), alpha);
      actorRoot.rotation.y = Math.atan2(actor.facing.x, actor.facing.z);
      driveActorAnimation(instance, actor, previous, { interpolate: true, alpha, loopTimeSeconds: (step + alpha) / 60, manifest });
      animation.update(1 / 240); actorRoot.updateMatrixWorld(true);
      record(step + alpha, actor);
    }
    previous = actor;
    sawAirborne ||= actor.jumpPhase !== undefined;
    if (sawAirborne && !engine.snapshotState().playerJump && landedAt === null) landedAt = step + 1;
    // Include the grounded recovery blend, not just the last airborne frame.
    if (landedAt !== null && step + 1 >= landedAt + 15) break;
  }
  scenarios.push({ boostAt, inputBoostTick: boostAt === null ? null : boostAt + 2, boostObserved, kind: boostAt === null ? 'plain' : 'boosted', landedAt, recoveryTicks: landedAt === null ? 0 : samples.at(-1).step - landedAt, minimumWorldFloorMetres: minimum, worst, samples });
  weapon.dispose(); animation.dispose();
  model.traverse((node) => { if (node instanceof Mesh && node.geometry !== hero.scene.getObjectByName(node.name)?.geometry) node.geometry.dispose(); });
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const report = { schemaVersion: 1, outputHash: sha(buffers[0]), weaponHash: sha(buffers[1]), manifestHash: sha(manifestBytes), manifestMatchesHero: manifest.outputHash === sha(buffers[0]), missingClips,
  method: 'Unchanged engine jump, actual native controller/phase driver, real fitted Tripo katana; referenced weapon surface vertices at four rendered subdivisions per 60Hz simulation step (240Hz), including frame zero, takeoff and 15 grounded recovery ticks after landing. Image decoding alone is bypassed. Flat default arena; takeoff at simulation tick 1, four boost-input timings recorded in inputBoostTick and actual boost observation, plus the plain unboosted jump; no source/body offset invented.', scenarios };
mkdirSync(dirname(paths.output), { recursive: true });
writeFileSync(paths.output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ outputHash: report.outputHash, manifestMatchesHero: report.manifestMatchesHero, output: paths.output, scenarios: scenarios.map(({ samples, ...summary }) => summary) }, null, 2));
