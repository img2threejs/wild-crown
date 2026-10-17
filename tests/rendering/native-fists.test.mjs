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

test('both real native hands close without touching shared source, wrists, arms, skin weights or captured motion', { timeout: 120_000 }, () => {
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

/** Principal axis of `points` (power iteration on the covariance), its mean, the 2–98 % extent along it and the RMS distance from it. */
function principalSpread(points) {
  const mean = points.reduce((sum, point) => sum.add(point), new THREE.Vector3()).divideScalar(points.length);
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const point of points) { const x = point.x - mean.x, y = point.y - mean.y, z = point.z - mean.z; xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z; }
  const axis = new THREE.Vector3(1, .3, .2).normalize();
  for (let iteration = 0; iteration < 64; iteration++) axis.set(xx * axis.x + xy * axis.y + xz * axis.z, xy * axis.x + yy * axis.y + yz * axis.z, xz * axis.x + yz * axis.y + zz * axis.z).normalize();
  const along = points.map(point => point.clone().sub(mean).dot(axis));
  const rms = Math.sqrt(points.reduce((sum, point) => { const offset = point.clone().sub(mean); offset.addScaledVector(axis, -offset.dot(axis)); return sum + offset.lengthSq(); }, 0) / points.length);
  return { extent: quantile(along, .98) - quantile(along, .02), rms };
}

test('the folded thumbs are about 82 % as long and 87 % as thick as the native thumb, end over the index and middle fingers and never enter them', { timeout: 120_000 }, () => {
  const actor = clone(gltf.scene), mesh = meshOf(actor), source = mesh.geometry;
  const nativeThumb = fitUnarmedFists(actor, { length: 1, girth: 1 }), nativePositions = nativeThumb.edited.getAttribute('position').array.slice();
  releaseHandGeometry(nativeThumb);
  const nativeAttribute = new THREE.BufferAttribute(nativePositions, 3), nativeGeometry = { getAttribute: () => nativeAttribute };
  const edit = fitUnarmedFists(actor), normals = edit.edited.getAttribute('normal');
  try {
    for (const side of ['Left', 'Right']) {
      const sign = side === 'Right' ? 1 : -1;
      const handIndex = mesh.skeleton.bones.indexOf(mesh.skeleton.getBoneByName(`mixamorig${side}Hand`));
      const frame = mesh.skeleton.boneInverses[handIndex].clone().multiply(mesh.bindMatrix), normalMatrix = new THREE.Matrix3().setFromMatrix4(frame);
      const fitted = handSurface(mesh, source, edit.edited, side);
      const native = new Map(handSurface(mesh, source, nativeGeometry, side).map(point => [point.vertex, point.after]));
      // The thumb is exactly what the proportions move; its outer 70 % (by displacement) is the free thumb whose proportions are measured.
      const moved = fitted.filter(point => point.after.distanceTo(native.get(point.vertex)) > 1e-7);
      const reach = Math.max(...moved.map(point => point.after.distanceTo(native.get(point.vertex))));
      const free = moved.filter(point => point.after.distanceTo(native.get(point.vertex)) > .3 * reach);
      assert.ok(free.length > 800, `${side}: actual thumb flesh`);
      const scaled = principalSpread(free.map(point => point.after)), original = principalSpread(free.map(point => native.get(point.vertex)));
      const lengthRatio = scaled.extent / original.extent, girthRatio = scaled.rms / original.rms;
      assert.ok(lengthRatio > .78 && lengthRatio < .9, `${side}: thumb length ratio ${lengthRatio.toFixed(3)} outside 0.78–0.90`);
      assert.ok(girthRatio > .8 && girthRatio < .92, `${side}: thumb girth ratio ${girthRatio.toFixed(3)} outside 0.80–0.92`);
      // Graded base: a tenth of the moved flesh changes by less than a tenth of the tip's change, so the thenar melts into the native palm without a step.
      const base = moved.filter(point => point.after.distanceTo(native.get(point.vertex)) < .1 * reach);
      assert.ok(base.length > moved.length * .1, `${side}: smooth falloff exists at the thumb base`);
      // Tip: farthest free-thumb flesh from the base. It lies over the outer (index/middle) half of the four fingers, nearer the index side than the native tip, on the knuckle line.
      const baseCentre = base.reduce((sum, point) => sum.add(point.after), new THREE.Vector3()).divideScalar(base.length);
      const tipOf = positionOf => free.slice().sort((a, b) => positionOf(b).distanceTo(baseCentre) - positionOf(a).distanceTo(baseCentre)).slice(0, 20).reduce((sum, point) => sum.add(positionOf(point)), new THREE.Vector3()).divideScalar(20);
      const tip = tipOf(point => point.after), nativeTip = tipOf(point => native.get(point.vertex));
      const movedVertices = new Set(moved.map(point => point.vertex));
      const handReach = quantile(fitted.map(point => point.before.y), .98);
      const edge = Math.max(...fitted.filter(point => point.before.y > handReach * .65 && !movedVertices.has(point.vertex)).map(point => sign * point.before.x));
      const fingers = fitted.filter(point => point.before.y > handReach * .5 && sign * point.before.x <= edge + 1e-9 && !movedVertices.has(point.vertex));
      const lateral = fingers.map(point => sign * point.before.x), low = Math.min(...lateral), high = Math.max(...lateral);
      const share = position => (sign * position.x - low) / (high - low);
      assert.ok(share(tip) > .5, `${side}: thumb tip at ${share(tip).toFixed(2)} of the finger width, not over the index/middle fingers`);
      assert.ok(share(tip) > share(nativeTip), `${side}: the shorter thumb ends nearer the index finger`);
      assert.ok(Math.abs(tip.y - handReach * .43) < .012, `${side}: thumb tip on the knuckle row`);
      // No penetration: every free-thumb vertex lies outside the nearest finger surface point (normal side), and a finger never moves because of the thumb.
      let outside = Infinity;
      for (const thumbPoint of free.filter((_, index) => index % 2 === 0)) {
        let nearest = fingers[0], best = Infinity;
        for (const finger of fingers) { const distance = thumbPoint.after.distanceToSquared(finger.after); if (distance < best) { best = distance; nearest = finger; } }
        outside = Math.min(outside, thumbPoint.after.clone().sub(nearest.after).dot(new THREE.Vector3().fromBufferAttribute(normals, nearest.vertex).applyMatrix3(normalMatrix).normalize()));
      }
      assert.ok(outside > -.0005, `${side}: thumb flesh ${(-outside * 1000).toFixed(2)} mm inside the fingers`);
    }
  } finally { releaseHandGeometry(edit); }
});

test('the fitted fists, thumbs included, stay rigid in the hand through every delivered clip', { timeout: 120_000 }, () => {
  const actor = clone(gltf.scene), mesh = meshOf(actor), source = mesh.geometry;
  const edit = fitUnarmedFists(actor), mixer = new THREE.AnimationMixer(actor);
  try {
    const skinIndex = source.getAttribute('skinIndex'), skinWeight = source.getAttribute('skinWeight');
    const sides = ['Left', 'Right'].map(side => {
      const bone = mesh.skeleton.getBoneByName(`mixamorig${side}Hand`), handIndex = mesh.skeleton.bones.indexOf(bone), vertices = [];
      for (const vertex of new Set(source.getIndex().array)) {
        let weight = 0;
        for (let component = 0; component < 4; component++) if (skinIndex.getComponent(vertex, component) === handIndex) weight += skinWeight.getComponent(vertex, component);
        if (weight > .9999999) vertices.push(vertex);
      }
      return { bone, vertices: vertices.filter((_, index) => index % 7 === 0) };
    });
    assert.ok(sides.every(({ vertices }) => vertices.length > 300), 'fully hand-weighted fist flesh on both sides');
    const point = new THREE.Vector3(), inverse = new THREE.Matrix4();
    const sample = () => { actor.updateMatrixWorld(true); return sides.map(({ bone, vertices }) => { inverse.copy(bone.matrixWorld).invert(); return vertices.map(vertex => mesh.getVertexPosition(vertex, point.set(0, 0, 0)).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse).clone()); }); };
    mixer.stopAllAction();
    const rest = sample();
    let drift = 0, clipsMeasured = 0;
    for (const clip of gltf.animations) {
      const action = mixer.clipAction(clip).play();
      for (const fraction of [0, .25, .5, .75, 1]) {
        mixer.setTime(clip.duration * fraction);
        sample().forEach((points, side) => points.forEach((position, index) => { drift = Math.max(drift, position.distanceTo(rest[side][index])); }));
      }
      action.stop(); mixer.uncacheClip(clip); clipsMeasured++;
    }
    assert.ok(clipsMeasured >= 20, `${clipsMeasured} Sakda clips measured`);
    assert.ok(drift < 1e-5, `fist flesh drifted ${drift} in the hand frame`);
  } finally { mixer.stopAllAction(); mixer.uncacheRoot(actor); releaseHandGeometry(edit); }
});

test('real Sakda/Aren re-equip stages transactionally, frees ghosts first, and discards stale/failed loads', { timeout: 120_000 }, async () => {
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
  // Exercise native equip/disposal without a WebGL context; GPU warm-up is covered by the browser smoke.
  const renderer = Object.create(GameRenderer.prototype);
  Object.assign(renderer, {
    disposed: false, loadEpoch: 1, region: { id: 'native-fists-fixture' }, scene: new THREE.Scene(), world: new THREE.Group(),
    camera: new THREE.PerspectiveCamera(), postFx: { compile() {} }, renderer: { initTexture() {} },
    obstacleVisuals: { group: new THREE.Group(), debris: { mesh: new THREE.Group() } },
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
    assert.equal(first.root.visible, false, 'warm-up leaves the unsynced variant hidden');
    assert.ok(firstGhosts.group.children.length > 0 && firstGhosts.group.children.every(ghost => ghost.visible === false), 'warm-up leaves every ghost hidden');
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
