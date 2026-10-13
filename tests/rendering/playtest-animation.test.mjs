import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { createServer } from 'vite';
import * as THREE from 'three';

const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: 'silent', server: { middlewareMode: true }, appType: 'custom' });
after(async () => vite.close());
const { createPlaytestAnimationSet, PlaytestAnimationError } = await vite.ssrLoadModule('/src/rendering/PlaytestAnimationFactory.ts');
const { AnimationController } = await vite.ssrLoadModule('/src/rendering/AnimationController.ts');
const { NativeAssetLoader } = await vite.ssrLoadModule('/src/rendering/NativeAssetLoader.ts');

const greenwakeManifest = JSON.parse(await readFile(new URL('../../asset-source/playtests/greenwake.json', import.meta.url), 'utf8'));


function rigWithBones(names) {
  const root = new THREE.Group();
  const rigRoot = new THREE.Bone();
  rigRoot.name = 'tripo::Root';
  root.add(rigRoot);
  const bones = new Map([[rigRoot.name, rigRoot]]);
  for (const name of names) {
    const bone = new THREE.Bone();
    bone.name = name;
    if (/Spine/.test(name)) bone.position.set(0, 1, 0);
    else if (/Head/.test(name)) bone.position.set(0, 1, 1);
    else if (/Right_Limb_0/.test(name)) bone.position.set(0, 0, -0.5);
    else if (/Left_Limb_0/.test(name)) bone.position.set(0, 0, 0.5);
    rigRoot.add(bone);
    bones.set(name, bone);
  }
  root.updateMatrixWorld(true);
  return { root, bones };
}

function candidateManifest(playtestAnimation, actionToClipMapping = {}) {
  return {
    id: 'test-character', sourceType: 'native-glb', kind: 'character', runtimeUrl: '/candidate.glb', outputHash: 'a'.repeat(64),
    lodIds: [], requiredActionIds: [], actionToClipMapping, sockets: [], provenance: 'candidate-only', evidenceStatus: 'blocked', playtestAnimation,
  };
}

describe('blocked candidate playtest animation', () => {
  it('binds explicit in-place player actions and visibly samples a real rig bone', () => {
    const profile = {
      rigFamily: 'biped', actionIds: ['aren-idle', 'aren-walk', 'aren-light-1'],
      torsoBoneNames: ['tripo::Spine_1'], headBoneName: 'tripo::Head_0',
      armRootNames: ['tripo::0_Right_Limb_0', 'tripo::1_Left_Limb_0'],
    };
    const { root, bones } = rigWithBones(['tripo::Spine_1', 'tripo::Head_0', 'tripo::0_Right_Limb_0', 'tripo::1_Left_Limb_0']);
    const manifest = candidateManifest(profile);
    const set = createPlaytestAnimationSet(root, manifest, []);
    assert.ok(set);
    const animationManifest = { ...manifest, actionToClipMapping: set.actionToClipMapping, rootMotion: set.rootMotion };
    const controller = new AnimationController(root, set.clips, animationManifest);
    const arm = bones.get('tripo::0_Right_Limb_0');
    const bindPose = arm.quaternion.clone();
    const rootPosition = root.position.clone();

    controller.play('aren-idle', 'idle', undefined, 0.5);
    controller.update(0.12);

    assert.equal(controller.activeActionId, 'aren-idle');
    assert.ok(arm.quaternion.angleTo(bindPose) > 0.001, 'sampled idle changes the native rig pose');
    assert.deepEqual(root.position.toArray(), rootPosition.toArray(), 'rotation-only clips do not move the actor root');
    assert.deepEqual(set.rootMotion['aren-idle'], { mode: 'in-place', evidenceStatus: 'verified' });
    assert.ok(set.clips.every(clip => clip.tracks.every(track => track.name.endsWith('.quaternion'))));
    controller.dispose();
  });

  it('animates the Aren Run and Jump clips through declared leg roots', () => {
    const profile = {
      rigFamily: 'biped', actionIds: ['aren-run', 'aren-jump'],
      torsoBoneNames: ['tripo::Spine_1'], headBoneName: 'tripo::Head_0',
      armRootNames: ['tripo::0_Right_Limb_0', 'tripo::1_Left_Limb_0'],
      legRootNames: ['bone_20', 'tripo::0_Left_Limb_2'],
    };
    const names = [...profile.torsoBoneNames, profile.headBoneName, ...profile.armRootNames, ...profile.legRootNames];
    const manifest = candidateManifest(profile);

    for (const [actionId, normalizedTime] of [['aren-run', 0.25], ['aren-jump', 0.5]]) {
      const { root, bones } = rigWithBones(names);
      const set = createPlaytestAnimationSet(root, manifest, []);
      assert.ok(set);
      const controller = new AnimationController(root, set.clips, { ...manifest, actionToClipMapping: set.actionToClipMapping, rootMotion: set.rootMotion });
      const leg = bones.get(profile.legRootNames[0]);
      const bindPose = leg.quaternion.clone();
      const rootPosition = root.position.clone();
      controller.play(actionId, 'active', normalizedTime);
      controller.update(0.12);
      assert.ok(leg.quaternion.angleTo(bindPose) > 0.001, `${actionId} changes a declared leg pose`);
      assert.deepEqual(root.position.toArray(), rootPosition.toArray(), `${actionId} remains in-place`);
      controller.dispose();
    }
  });

  it('preserves explicitly mapped native actions instead of replacing them', () => {
    const profile = {
      rigFamily: 'biped', actionIds: ['aren-idle'], torsoBoneNames: ['tripo::Spine_1'],
      armRootNames: ['tripo::0_Right_Limb_0', 'tripo::1_Left_Limb_0'],
    };
    const { root } = rigWithBones(['tripo::Spine_1', 'tripo::0_Right_Limb_0', 'tripo::1_Left_Limb_0']);
    const nativeClip = new THREE.AnimationClip('NativeIdle', 1, []);

    assert.equal(createPlaytestAnimationSet(root, candidateManifest(profile, { 'aren-idle': 'NativeIdle' }), [nativeClip]), undefined);
  });

  it('never generates procedural clips for a native monster manifest without a playtest profile', () => {
    const { root } = rigWithBones(['tripo::Spine_1', 'tripo::Head_0']);
    const monster = candidateManifest(undefined, { 'monster-idle': 'Idle', 'monster-run': 'Run' });
    assert.equal(createPlaytestAnimationSet(root, monster, []), undefined);
    assert.equal(createPlaytestAnimationSet(root, { ...monster, playtestAnimation: undefined }, [new THREE.AnimationClip('Idle', 1, [])]), undefined);
  });

  it('moves declared avian wings and quadruped limbs', () => {
    const birdProfile = {
      rigFamily: 'avian', actionIds: ['vara:idle'], torsoBoneNames: ['tripo::Spine_1'], headBoneName: 'tripo::Head_0',
      wingRootNames: ['bone_11', 'bone_16'], wingSecondaryBoneNames: ['bone_12', 'bone_17'],
    };
    const bird = rigWithBones(['tripo::Spine_1', 'tripo::Head_0', 'bone_11', 'bone_16', 'bone_12', 'bone_17']);
    const birdManifest = candidateManifest(birdProfile);
    const birdSet = createPlaytestAnimationSet(bird.root, birdManifest, []);
    assert.ok(birdSet);
    const birdController = new AnimationController(bird.root, birdSet.clips, { ...birdManifest, actionToClipMapping: birdSet.actionToClipMapping, rootMotion: birdSet.rootMotion });
    const wing = bird.bones.get('bone_11');
    const wingBindPose = wing.quaternion.clone();
    birdController.play('vara:idle', 'idle', undefined, 0.2);
    birdController.update(0.12);
    assert.ok(wing.quaternion.angleTo(wingBindPose) > 0.1, 'bird idle visibly flaps a declared wing bone');
    birdController.dispose();

    const boarProfile = {
      rigFamily: 'quadruped', actionIds: ['wild-crown:actor-idle'], torsoBoneNames: ['tripo::Spine_0'], headBoneName: 'tripo::Head_0',
      limbRootNames: ['tripo::0_Left_Limb_0', 'tripo::0_Right_Limb_0', 'tripo::1_Left_Limb_0', 'tripo::1_Right_Limb_0'],
    };
    const boar = rigWithBones(['tripo::Spine_0', 'tripo::Head_0', ...boarProfile.limbRootNames]);
    const boarManifest = candidateManifest(boarProfile);
    const boarSet = createPlaytestAnimationSet(boar.root, boarManifest, []);
    assert.ok(boarSet);
    const boarController = new AnimationController(boar.root, boarSet.clips, { ...boarManifest, actionToClipMapping: boarSet.actionToClipMapping, rootMotion: boarSet.rootMotion });
    const leg = boar.bones.get(boarProfile.limbRootNames[0]);
    const legBindPose = leg.quaternion.clone();
    boarController.play('wild-crown:actor-idle', 'idle', undefined, 0.5);
    boarController.update(0.12);
    assert.ok(leg.quaternion.angleTo(legBindPose) > 0.001, 'quadruped idle animates a declared limb bone');
    boarController.dispose();
  });

  it('fails closed when the declared profile does not match the pinned native rig', () => {
    const profile = { rigFamily: 'avian', actionIds: ['vara:idle'], wingRootNames: ['missing-left-wing', 'missing-right-wing'] };
    const { root } = rigWithBones([]);
    assert.throws(() => createPlaytestAnimationSet(root, candidateManifest(profile), []), PlaytestAnimationError);
  });

  it('exposes the real head bone as the cast socket on native Vara and Ember Boar instances', async () => {
    const previousFetch = globalThis.fetch;
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { baseURI: 'http://localhost/' } });
    const loader = new NativeAssetLoader({ allowMissingActionClips: true });
    // Keep source geometry/rig/clip bytes intact; only omit image decoding in Node.
    loader.loader.register(() => ({ name: 'socket-test-material', loadMaterial: () => Promise.resolve(new THREE.MeshBasicMaterial()) }));
    try {
      for (const id of ['actor-vara', 'actor-ember-boar']) {
        const manifest = greenwakeManifest.find(entry => entry.id === id);
        const bytes = await readFile(`${process.cwd()}${manifest.runtimeUrl}`);
        globalThis.fetch = async () => new Response(bytes);
        const first = await loader.load(manifest);
        const second = await loader.load(manifest);
        try {
          const headName = THREE.PropertyBinding.sanitizeNodeName(manifest.castSocketBone ?? manifest.playtestAnimation.headBoneName);
          assert.equal(first.sockets.cast, first.root.getObjectByName(headName));
          assert.ok(first.sockets.cast?.isBone, `${id} must expose a native head bone, not a fabricated emitter`);
          assert.notEqual(first.sockets.cast, second.sockets.cast, 'sockets must belong to each independently cloned rig');
          first.root.updateMatrixWorld(true);
          const start = first.sockets.cast.getWorldPosition(new THREE.Vector3());
          const actionId = manifest.playtestAnimation?.actionIds[0] ?? 'monster-idle';
          first.animation.play(actionId, 'idle', undefined, 0.2);
          first.animation.update(0.13);
          first.root.position.set(2, 0.4, -3);
          first.root.rotation.y = 0.7;
          first.root.updateMatrixWorld(true);
          const moved = first.sockets.cast.getWorldPosition(new THREE.Vector3());
          assert.ok(start.distanceTo(moved) > 1, 'cast must follow the posed, transformed native actor');
          assert.deepEqual(moved.toArray(), first.root.getObjectByName(headName).getWorldPosition(new THREE.Vector3()).toArray());
        } finally {
          first.dispose();
          second.dispose();
        }
      }
    } finally {
      loader.dispose();
      globalThis.fetch = previousFetch;
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
      else delete globalThis.document;
    }
  });

  it('preserves an explicit cast socket and never substitutes an unrelated bone', async () => {
    const head = new THREE.Bone();
    head.name = 'head';
    const explicit = new THREE.Object3D();
    explicit.name = 'cast';
    const root = new THREE.Group();
    root.add(head, explicit);
    const manifest = candidateManifest({ rigFamily: 'avian', headBoneName: 'head', actionIds: [] });
    manifest.sockets = ['cast'];
    const loader = new NativeAssetLoader();
    // Isolate socket selection from GLB transport with an already-acquired template.
    const template = { root, clips: [], manifest, leases: 0, lastUsed: 0, evictWhenFree: false };
    loader.acquireTemplate = async () => { template.leases++; return template; };
    const explicitInstance = await loader.load(manifest);
    const missingInstance = await loader.load({ ...manifest, sockets: [], playtestAnimation: { ...manifest.playtestAnimation, headBoneName: 'absent' } });
    const nonBoneInstance = await loader.load({ ...manifest, sockets: [], playtestAnimation: { ...manifest.playtestAnimation, headBoneName: 'cast' } });
    try {
      assert.equal(explicitInstance.sockets.cast, explicitInstance.root.getObjectByName('cast'));
      assert.notEqual(explicitInstance.sockets.cast, explicitInstance.root.getObjectByName('head'));
      assert.equal(missingInstance.sockets.cast, undefined);
      assert.equal(nonBoneInstance.sockets.cast, undefined);
    } finally {
      explicitInstance.dispose();
      missingInstance.dispose();
      nonBoneInstance.dispose();
      loader.dispose();
    }
  });
});
