import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { createServer } from 'vite';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';

const root = new URL('../../', import.meta.url).pathname;
const vite = await createServer({ configFile: false, root, logLevel: 'silent', server: { middlewareMode: true }, appType: 'custom' });
after(() => vite.close());
const { fitUnarmedFists, releaseHandGeometry } = await vite.ssrLoadModule('/src/rendering/NativeHandGrip.ts');
const { GameRenderer } = await vite.ssrLoadModule('/src/rendering/GameRenderer.ts');
const { NativeAssetLoader } = await vite.ssrLoadModule('/src/rendering/NativeAssetLoader.ts');
const directory = new URL('../../asset-source/generated/actor-sakda-hero-01/', import.meta.url);
const bytes = await readFile(new URL('sakda-hero-animated.glb', directory));
const manifest = JSON.parse(await readFile(new URL('manifest-entry.json', directory), 'utf8'));
const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
// Only texture decoding is bypassed: geometry, skin weights, skeleton and all clips are the delivered GLB.
const materialsOnly = () => ({ name: 'native-fists-material', loadMaterial: () => Promise.resolve(new THREE.MeshStandardMaterial()) });
const gltf = await new GLTFLoader().register(materialsOnly).parseAsync(buffer, '');
const meshOf = actor => { let mesh; actor.traverse(node => { if (!mesh && node.isSkinnedMesh) mesh = node; }); return mesh; };
const hash = array => createHash('sha256').update(Buffer.from(array.buffer, array.byteOffset, array.byteLength)).digest('hex');
const positionHash = geometry => hash(geometry.getAttribute('position').array);
const quantile = (values, fraction) => values.sort((a, b) => a - b)[Math.floor((values.length - 1) * fraction)];
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;

function handSurface(mesh, original, edited, side) {
  const handIndex = mesh.skeleton.bones.indexOf(mesh.skeleton.getBoneByName(`mixamorig${side}Hand`));
  const frame = mesh.skeleton.boneInverses[handIndex].clone().multiply(mesh.bindMatrix);
  const skinIndex = original.getAttribute('skinIndex'), weights = original.getAttribute('skinWeight');
  const points = [];
  for (const vertex of new Set(original.getIndex().array)) {
    let weight = 0;
    for (let component = 0; component < 4; component++) if (skinIndex.getComponent(vertex, component) === handIndex) weight += weights.getComponent(vertex, component);
    if (weight < .6) continue;
    points.push({ vertex, before: new THREE.Vector3().fromBufferAttribute(original.getAttribute('position'), vertex).applyMatrix4(frame), after: new THREE.Vector3().fromBufferAttribute(edited.getAttribute('position'), vertex).applyMatrix4(frame) });
  }
  return points;
}

function assertClosed(mesh, original, edited) {
  for (const side of ['Left', 'Right']) {
    const points = handSurface(mesh, original, edited, side);
    assert.ok(points.length > 1000, `${side}: actual native hand surface`);
    const reach = quantile(points.map(point => point.before.y), .98);
    const fingertips = points.filter(point => point.before.y > reach * .8);
    // An open/claw hand retains the extended tips. A fist brings them back over the palm, independently of render pose.
    assert.ok(quantile(fingertips.map(point => point.after.y), .95) < reach * .65, `${side}: native fingertips still extended`);
    const sign = side === 'Right' ? 1 : -1;
    const edge = Math.max(...points.filter(point => point.before.y > reach * .65).map(point => sign * point.before.x));
    const thumb = points.filter(point => sign * point.before.x > edge + .003);
    const tipHeight = quantile(thumb.map(point => point.before.y), .8);
    const tip = thumb.filter(point => point.before.y > tipHeight);
    assert.ok(tip.length > 20, `${side}: actual thumb, not four-finger vertices`);
    assert.ok(mean(tip.map(point => sign * (point.before.x - point.after.x))) > .005, `${side}: thumb not opposed across fist`);
    assert.ok(mean(tip.map(point => point.after.z)) > 0, `${side}: thumb tucked inside palm`);
    assert.ok(mean(tip.map(point => point.after.y)) > reach * .3, `${side}: thumb folded toward wrist instead of fingers`);
  }
}

test('both real native hands close without touching shared source, wrists, arms, skin weights or captured motion', () => {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.outputHash);
  const actor = clone(gltf.scene), sibling = clone(gltf.scene), mesh = meshOf(actor), reference = meshOf(sibling);
  const source = mesh.geometry;
  const sourceHashes = Object.fromEntries(Object.entries(source.attributes).map(([name, attribute]) => [name, hash(attribute.array)]));
  const bonesBefore = mesh.skeleton.bones.map(bone => bone.quaternion.toArray());
  const edit = fitUnarmedFists(actor);
  try {
    assertClosed(mesh, source, edit.edited);
    assert.equal(reference.geometry, source, 'another loaded clone still renders the original');
    assert.equal(edit.edited.getAttribute('skinIndex'), source.getAttribute('skinIndex'));
    assert.equal(edit.edited.getAttribute('skinWeight'), source.getAttribute('skinWeight'));
    assert.equal(edit.edited.index, source.index);
    assert.deepEqual(mesh.skeleton.bones.map(bone => bone.quaternion.toArray()), bonesBefore, 'fitting must not pose any bone');
    for (const [name, attribute] of Object.entries(source.attributes)) assert.equal(hash(attribute.array), sourceHashes[name], `source ${name} mutated`);
    const handIndices = ['Left', 'Right'].map(side => mesh.skeleton.bones.indexOf(mesh.skeleton.getBoneByName(`mixamorig${side}Hand`)));
    const indices = source.getAttribute('skinIndex'), weights = source.getAttribute('skinWeight'), before = source.getAttribute('position'), positions = edit.edited.getAttribute('position');
    for (const vertex of new Set(source.index.array)) {
      const handWeights = handIndices.map(handIndex => { let weight = 0; for (let c = 0; c < 4; c++) if (indices.getComponent(vertex, c) === handIndex) weight += weights.getComponent(vertex, c); return weight; });
      if (handWeights.some(weight => weight >= .6)) continue;
      assert.deepEqual([positions.getX(vertex), positions.getY(vertex), positions.getZ(vertex)], [before.getX(vertex), before.getY(vertex), before.getZ(vertex)], `non-hand vertex ${vertex} changed`);
    }
    const fittedHash = positionHash(edit.edited), version = positions.version;
    const mixers = [actor, sibling].map(root => new THREE.AnimationMixer(root));
    const clip = gltf.animations.find(clip => clip.name === 'sakda-limb-1');
    assert.ok(clip, 'real delivered jab clip');
    mixers.forEach(mixer => mixer.clipAction(clip).play());
    for (const time of [0, .1, .2, clip.duration]) {
      mixers.forEach(mixer => mixer.setTime(time));
      assert.deepEqual(mesh.skeleton.bones.map(bone => bone.quaternion.toArray()), reference.skeleton.bones.map(bone => bone.quaternion.toArray()), `jab ${time}: captured arm/body motion changed`);
      assert.equal(positions.version, version, 'no per-frame vertex uploads');
      assert.equal(positionHash(edit.edited), fittedHash, 'fitted geometry remains constant during native animation');
    }
    mixers.forEach(mixer => { mixer.stopAllAction(); mixer.uncacheRoot(mixer.getRoot()); });
  } finally { releaseHandGeometry(edit); }
  assert.equal(mesh.geometry, source);
});

test('release restores geometry, retains borrowed GPU attributes, and re-equip never accumulates curl', () => {
  const actor = clone(gltf.scene), mesh = meshOf(actor), source = mesh.geometry, baseline = positionHash(source);
  const edit = fitUnarmedFists(actor), fitted = positionHash(edit.edited);
  let disposed = 0;
  edit.edited.addEventListener('dispose', () => {
    disposed++;
    assert.equal(mesh.geometry, source, 'restore before freeing owned buffers');
    assert.equal(edit.edited.index, null, 'shared index detached before GPU disposal');
    assert.equal(edit.edited.getAttribute('skinWeight'), undefined, 'shared skin buffer detached before GPU disposal');
  });
  releaseHandGeometry(edit);
  assert.equal(disposed, 1);
  assert.equal(positionHash(source), baseline);
  for (let equip = 0; equip < 3; equip++) {
    const again = fitUnarmedFists(actor);
    assert.equal(positionHash(again.edited), fitted, `equip ${equip}: cumulative curl`);
    releaseHandGeometry(again);
    assert.equal(mesh.geometry, source);
  }
  const broken = clone(gltf.scene), brokenMesh = meshOf(broken), original = brokenMesh.geometry;
  brokenMesh.skeleton.getBoneByName('mixamorigLeftHand').name = 'missing-hand';
  assert.throws(() => fitUnarmedFists(broken), /native skinned hands/);
  assert.equal(brokenMesh.geometry, original, 'one valid hand must not be retained after fitting the other fails');
});

test('real Sakda/Aren re-equip stages transactionally, frees ghosts first, and discards stale/failed loads', async () => {
  const regionAssets = JSON.parse(await readFile(new URL('../../asset-source/playtests/greenwake.json', import.meta.url), 'utf8'));
  const canonicalManifest = regionAssets.find(entry => entry.id === 'actor-aren');
  const glaiveManifest = regionAssets.find(entry => entry.id === 'prop-warden-glaive');
  const assets = [manifest, canonicalManifest, glaiveManifest];
  const fixtureBytes = new Map(await Promise.all(assets.map(async entry => [entry.runtimeUrl, await readFile(root + entry.runtimeUrl)])));
  const previousFetch = globalThis.fetch, previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.fetch = async input => {
    const data = fixtureBytes.get(new URL(typeof input === 'string' ? input : input.url, 'http://localhost/').pathname);
    assert.ok(data, 'only the requested real native fixtures are served');
    return new Response(data);
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { baseURI: 'http://localhost/' } });
  const loader = new NativeAssetLoader({ allowMissingActionClips: true });
  loader.loader.register(materialsOnly);
  // Exercise the production equip path without constructing WebGL or opening a browser.
  const renderer = Object.create(GameRenderer.prototype);
  Object.assign(renderer, {
    disposed: false, loadEpoch: 1, region: { id: 'native-fists-fixture' }, scene: new THREE.Scene(), world: new THREE.Group(),
    assetLoader: loader, assetCatalog: new Map(assets.map(entry => [entry.id, entry])), actorManifests: new Map([['aren', canonicalManifest]]), actorRoots: new Map(),
    actorVariants: new Map(), actorSnapshots: new Map(), afterimages: null, wardenWeapon: null, unarmedFists: null, dodgeVanish: null, playerWalkSpeed: 7,
  });
  renderer.world.add(new THREE.Group());
  let stale;
  try {
    const canonical = await loader.load(canonicalManifest);
    renderer.actorRoots.set('aren', canonical);
    renderer.world.children[0].add(canonical.root);
    await renderer.setPlayerHero('sakda');
    const first = renderer.actorVariants.get('aren').get(manifest.id), firstEdit = renderer.unarmedFists;
    const baseline = positionHash(firstEdit.original), fitted = positionHash(firstEdit.edited);
    assertClosed(firstEdit.mesh, firstEdit.original, firstEdit.edited);
    const firstGhosts = renderer.afterimages;
    let disposed = false;
    firstEdit.edited.addEventListener('dispose', () => { disposed = true; assert.equal(firstGhosts.group.parent, null, 'borrowed afterimages still live while freeing fitted geometry'); });
    await renderer.setPlayerHero('sakda');
    assert.ok(disposed);
    assert.equal(firstEdit.mesh.geometry, firstEdit.original);
    assert.equal(positionHash(firstEdit.original), baseline);
    assert.equal(positionHash(renderer.unarmedFists.edited), fitted);
    assert.notEqual(renderer.actorVariants.get('aren').get(manifest.id), first, 're-equip uses an isolated clone');
    const outgoing = renderer.unarmedFists, outgoingGhosts = renderer.afterimages;
    let restoredForAren = false;
    outgoing.edited.addEventListener('dispose', () => {
      restoredForAren = true;
      assert.equal(outgoingGhosts.group.parent, null, 'Sakda ghosts outlive restored fists');
    });
    const originalLoad = loader.load.bind(loader);
    loader.load = async entry => {
      stale = await originalLoad(entry);
      renderer.loadEpoch++;
      return stale;
    };
    await assert.rejects(renderer.setPlayerHero('aren'), /superseded/);
    assert.equal(renderer.unarmedFists, outgoing, 'failed canonical load retired Sakda fists');
    assert.equal(renderer.afterimages, outgoingGhosts, 'failed canonical load retired Sakda ghosts');
    assert.equal(restoredForAren, false);
    loader.load = originalLoad;
    await renderer.setPlayerHero('aren');
    assert.ok(restoredForAren);
    assert.equal(outgoing.mesh.geometry, outgoing.original);
    assert.equal(renderer.unarmedFists, null);
    const glaive = renderer.wardenWeapon, canonicalGhosts = renderer.afterimages;
    assert.ok(glaive, 'canonical switch must rebuild the actual native glaive');
    assert.equal(glaive.carrier, canonical.root);
    assert.equal(canonical.root.getObjectByName('wc:warden-weapon'), glaive.root);
    assert.ok(glaive.root.getObjectByProperty('isMesh', true).geometry.getAttribute('position').count > 100, 'actual loaded native glaive surface');
    await renderer.setPlayerHero('aren');
    assert.equal(renderer.wardenWeapon, glaive, 'already-canonical weapon is the fast path');
    assert.equal(renderer.afterimages, canonicalGhosts, 'fast path does not rebuild borrowed ghosts');
    const glaiveGeometry = glaive.root.getObjectByProperty('isMesh', true).geometry;
    let weaponDisposed = false;
    glaiveGeometry.addEventListener('dispose', () => {
      weaponDisposed = true;
      assert.equal(canonicalGhosts.group.parent, null, 'canonical ghosts still borrow disposed weapon geometry');
    });
    await renderer.setPlayerHero('sakda');
    assert.ok(weaponDisposed);
    assert.equal(renderer.wardenWeapon, null);
    assert.equal(glaive.root.parent, null, 'no dangling glaive remains on the outgoing canonical actor');
    assertClosed(renderer.unarmedFists.mesh, renderer.unarmedFists.original, renderer.unarmedFists.edited);
    assert.equal(positionHash(renderer.unarmedFists.edited), fitted, 'Sakda→Aren→Sakda accumulated curl');
    const live = renderer.actorVariants.get('aren').get(manifest.id), liveEdit = renderer.unarmedFists, liveGhosts = renderer.afterimages, liveSpeed = renderer.playerWalkSpeed;
    const load = loader.load.bind(loader);
    loader.load = async entry => {
      stale = await load(entry);
      renderer.loadEpoch++;
      return stale;
    };
    await assert.rejects(renderer.setPlayerHero('sakda'), /superseded/);
    assert.equal(renderer.actorVariants.get('aren').get(manifest.id), live);
    assert.equal(renderer.unarmedFists, liveEdit);
    assert.equal(renderer.afterimages, liveGhosts);
    assert.equal(renderer.playerWalkSpeed, liveSpeed);
    assert.equal(stale.root.parent, null);
    loader.load = async entry => {
      stale = await load(entry);
      meshOf(stale.root).skeleton.getBoneByName('mixamorigLeftHand').name = 'missing-hand';
      return stale;
    };
    await assert.rejects(renderer.setPlayerHero('sakda'), /native skinned hands/);
    assert.equal(renderer.actorVariants.get('aren').get(manifest.id), live);
    assert.equal(renderer.unarmedFists, liveEdit);
    assert.equal(renderer.afterimages, liveGhosts);
    assert.equal(renderer.playerWalkSpeed, liveSpeed);
    assert.equal(meshOf(stale.root).geometry, liveEdit.original, 'failed actor cannot retain a partial fit');
  } finally {
    renderer.afterimages?.dispose();
    renderer.wardenWeapon?.dispose();
    if (renderer.unarmedFists) releaseHandGeometry(renderer.unarmedFists);
    for (const variants of renderer.actorVariants.values()) for (const actor of variants.values()) actor.dispose();
    for (const actor of renderer.actorRoots.values()) actor.dispose();
    stale?.dispose();
    loader.dispose();
    globalThis.fetch = previousFetch;
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else delete globalThis.document;
  }
});
