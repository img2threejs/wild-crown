import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { after, describe, it } from 'node:test';
import { createServer } from 'vite';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const root = process.cwd();
const vite = await createServer({ configFile: false, root, logLevel: 'silent', server: { middlewareMode: true }, appType: 'custom' });
after(async () => vite.close());
const { AnimationController, ANIMATION_FADE_SECONDS } = await vite.ssrLoadModule('/src/rendering/AnimationController.ts');
const { NativeAssetLoader } = await vite.ssrLoadModule('/src/rendering/NativeAssetLoader.ts');

function rootMotion() {
  return {
    mode: 'native-root-motion',
    rootNodeName: 'hips',
    curveSamples: [
      { time: 0, position: { x: 0, y: 1, z: 0 } },
      { time: 2, position: { x: 0, y: 1, z: 1 } },
    ],
    evidenceStatus: 'verified',
  };
}

function preserveVerticalRootMotion() {
  return {
    mode: 'native-root-motion',
    rootNodeName: 'hips',
    preserveVerticalMotion: true,
    curveSamples: [
      { time: 0, position: { x: 0, y: 1, z: 0 } },
      { time: 1, position: { x: 0, y: 0.2, z: 0 } },
      { time: 2, position: { x: 0, y: 1, z: 0 } },
    ],
    evidenceStatus: 'verified',
  };
}

function motionInPlace() {
  return { mode: 'in-place', evidenceStatus: 'verified' };
}

function frame(mix, delta) {
  return { mix, delta };
}

describe('user-supplied Aren native animation candidate', () => {
  it('binds only clips present in the exact blocked playtest GLB', async () => {
    const [originalBytes, playtestText, publicText, sourceText] = await Promise.all([
      readFile(`${root}/asset-source/generated/actor-aren-user-supplied-01/aren.glb`),
      readFile(`${root}/asset-source/playtests/greenwake.json`, 'utf8'),
      readFile(`${root}/public/assets/manifest.json`, 'utf8'),
      readFile(`${root}/asset-source/manifest.json`, 'utf8'),
    ]);
    const candidate = JSON.parse(playtestText).find((entry) => entry.id === 'actor-aren');
    const candidateBytes = await readFile(`${root}${candidate.runtimeUrl}`);
    assert.equal(createHash('sha256').update(originalBytes).digest('hex'), candidate.sourceHash);
    const publicAren = JSON.parse(publicText).find((entry) => entry.id === 'actor-aren');
    const sourceAren = JSON.parse(sourceText).assets.find((entry) => entry.id === 'actor-aren');
    assert.equal(createHash('sha256').update(candidateBytes).digest('hex'), candidate.outputHash);
    assert.equal(candidate.evidenceStatus, 'blocked');
    assert.equal(candidate.requiredActionIds.length, 0);
    assert.equal(publicAren.runtimeUrl, null);
    assert.equal(publicAren.outputHash, null);
    assert.equal(sourceAren.state, 'blocked-on-consent');
    assert.equal(sourceAren.runtimeUrl, null);

    assert.equal(candidateBytes.toString('ascii', 0, 4), 'glTF');
    const jsonLength = candidateBytes.readUInt32LE(12);
    const gltf = JSON.parse(candidateBytes.toString('utf8', 20, 20 + jsonLength).trim());
    const clipNames = new Set(gltf.animations.map((clip) => clip.name));
    for (const [actionId, clipName] of Object.entries(candidate.actionToClipMapping)) {
      assert.ok(clipNames.has(clipName), `${actionId} maps to absent native clip ${clipName}`);
      assert.equal(candidate.rootMotion[actionId]?.evidenceStatus, 'verified', `${actionId} needs a verified root-motion policy`);
      if (candidate.rootMotion[actionId].mode === 'in-place') continue;
      assert.equal(candidate.rootMotion[actionId].rootNodeName, 'mixamorigHips');
      assert.equal(candidate.rootMotion[actionId].preserveVerticalMotion, true);
    }
    for (const action of ['aren-light-1', 'aren-light-2', 'aren-light-3', 'aren-heavy', 'aren-charged-heavy', 'aren-root-tether', 'aren-cleanse', 'aren-hit', 'aren-stagger']) {
      assert.ok(candidate.actionToClipMapping[action], `${action} must be bound to a native clip`);
    }
    assert.deepEqual(Object.fromEntries(Object.entries(candidate.actionToClipMapping).filter(([action]) => ['aren-idle', 'aren-walk', 'aren-run', 'aren-jump', 'aren-forward-left-dive-roll'].includes(action))),
      { 'aren-idle': 'aren-idle', 'aren-walk': 'walk.001', 'aren-run': 'run.001', 'aren-jump': 'One long jump.001', 'aren-forward-left-dive-roll': 'dive.001' }, 'idle is the exact Mixamo take, the other locomotion mappings stay intact');
  });

  it('plays the donated standing, celebration and falling poses on the real Aren skin while preserving native movement', async () => {
    const manifest = JSON.parse(await readFile(`${root}/asset-source/playtests/greenwake.json`, 'utf8')).find(entry => entry.id === 'actor-aren');
    const parse = async path => {
      const bytes = await readFile(path);
      return new GLTFLoader().register(() => ({ name: 'pose-only-material', loadMaterial: () => Promise.resolve(new THREE.MeshBasicMaterial()) }))
        .parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    };
    const candidate = await parse(`${root}${manifest.runtimeUrl}`);
    const parent = await parse(`${root}/asset-source/generated/actor-aren-user-supplied-01/aren-seam-repaired.glb`);
    const controllers = [candidate, parent].map(gltf => new AnimationController(gltf.scene, gltf.animations, manifest, true));
    const hips = candidate.scene.getObjectByName('mixamorigHips');
    const hand = candidate.scene.getObjectByName('mixamorigLeftHand');
    const point = new THREE.Vector3();
    try {
      controllers[0].play('aren-idle', 'idle', undefined, 0);
      controllers[0].update(0.2); candidate.scene.updateMatrixWorld(true);
      const standingHeight = hips.getWorldPosition(point).y;
      const standingHand = hand.getWorldPosition(new THREE.Vector3()).clone();
      let celebrationDisplacement = 0;
      for (let frame = 0; frame <= 24; frame++) {
        controllers[0].play('aren-cheer', 'active', frame / 24); controllers[0].update(0.2);
        candidate.scene.updateMatrixWorld(true);
        celebrationDisplacement = Math.max(celebrationDisplacement, hand.getWorldPosition(point).distanceTo(standingHand));
      }
      assert.ok(celebrationDisplacement > 0.25, 'the donated celebration must visibly articulate the native hand');
      controllers[0].play('aren-defeat', 'active', 1); controllers[0].update(0.2); candidate.scene.updateMatrixWorld(true);
      assert.ok(hips.getWorldPosition(point).y < standingHeight * 0.4, 'the donated defeat must lower the native body to the ground');
      const finalPose = hips.matrixWorld.clone();
      controllers[0].play('aren-defeat', 'active', 1.5); controllers[0].update(0.2); candidate.scene.updateMatrixWorld(true);
      assert.ok(hips.matrixWorld.equals(finalPose), 'the fallen pose must clamp rather than restart');
      const meshes = [candidate, parent].map(gltf => { let mesh; gltf.scene.traverse(node => { if (node.isSkinnedMesh) mesh = node; }); return mesh; });
      const a = new THREE.Vector3(), b = new THREE.Vector3();
      for (const action of ['aren-walk', 'aren-run', 'aren-jump', 'aren-forward-left-dive-roll']) for (const time of [0, 0.25, 0.5, 0.75, 1]) {
        for (let index = 0; index < controllers.length; index++) { controllers[index].play(action, 'active', time); controllers[index].update(0.2); [candidate, parent][index].scene.updateMatrixWorld(true); }
        for (const vertex of [0, 600, 22749, 22751]) { meshes[0].getVertexPosition(vertex, a); meshes[1].getVertexPosition(vertex, b); assert.ok(a.distanceTo(b) < 1e-7, `${action}: movement changed the native posed surface`); }
      }
    } finally {
      for (const controller of controllers) controller.dispose();
      for (const gltf of [candidate, parent]) gltf.scene.traverse(node => { if (node.isMesh) { node.geometry.dispose(); node.material.dispose(); node.skeleton?.dispose(); } });
    }
  });

  it('integrates the production sequence: play(clock,rate) -> update(dt) -> play(nextClock,nextRate)', () => {
    const rootObj = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'hips';
    hips.position.set(0, 1, 0);
    rootObj.add(hips);
    const clip = new THREE.AnimationClip('walk.001', 2, [
      new THREE.VectorKeyframeTrack('hips.position', [0, 2], [0, 1, 0, 0, 1, 0]),
    ]);
    const manifest = {
      id: 'actor-aren-prod',
      requiredActionIds: ['walk'],
      actionToClipMapping: { walk: 'walk.001' },
      rootMotion: { walk: motionInPlace() },
      sockets: [],
    };
    const controller = new AnimationController(rootObj, [clip], manifest);
    try {
      // First absolute sample seeds phase = clock * rate.
      controller.play('walk', 'idle', undefined, 0.5, 1);
      assert.ok(Math.abs(controller.activeTime - 0.5) < 1e-6);

      // Render dt arrives, then the next authoritative clock + new rate.
      // The accumulator integrates only the clock delta, not dt.
      controller.update(0.9);
      assert.ok(Math.abs(controller.activeTime - 0.5) < 1e-6, 'update(dt) must not advance gameplay loop phase');

      controller.play('walk', 'idle', undefined, 1.0, 1.4);
      // delta = 0.5, *1.4 = 0.7 added to previous accumulator 0.5 -> 1.2
      assert.ok(Math.abs(controller.activeTime - 1.2) < 1e-6);

      // Another render frame, then another clock sample. The dt is still
      // free to vary (0.9, 0.016, 0.25) without affecting phase.
      controller.update(0.016);
      assert.ok(Math.abs(controller.activeTime - 1.2) < 1e-6);
      controller.play('walk', 'idle', undefined, 1.4, 1.4);
      // delta = 0.4, *1.4 = 0.56; accumulator 1.2 + 0.56 = 1.76
      assert.ok(Math.abs(controller.activeTime - 1.76) < 1e-6);

      controller.update(0.25);
      assert.ok(Math.abs(controller.activeTime - 1.76) < 1e-6);
      controller.play('walk', 'idle', undefined, 2.0, 1.4);
      // delta = 0.6, *1.4 = 0.84; accumulator 1.76 + 0.84 = 2.60 % 2 = 0.6
      assert.ok(Math.abs(controller.activeTime - 0.6) < 1e-6);
    } finally {
      controller.dispose();
    }
  });

  it('does not advance phase for duplicate clocks regardless of update dt', () => {
    const rootObj = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'hips';
    hips.position.set(0, 1, 0);
    rootObj.add(hips);
    const clip = new THREE.AnimationClip('walk.001', 2, [
      new THREE.VectorKeyframeTrack('hips.position', [0, 2], [0, 1, 0, 0, 1, 0]),
    ]);
    const manifest = {
      id: 'actor-aren-dup-clock',
      requiredActionIds: ['walk'],
      actionToClipMapping: { walk: 'walk.001' },
      rootMotion: { walk: motionInPlace() },
      sockets: [],
    };
    const controller = new AnimationController(rootObj, [clip], manifest);
    try {
      controller.play('walk', 'idle', undefined, 0.75, 1);
      const held = controller.activeTime;
      // Multiple render frames at varying dt must not advance phase when
      // the simulation has not produced a new authoritative clock.
      for (const dt of [0.9, 0.016, 0.25, 1.5, 0.001]) {
        controller.update(dt);
        assert.equal(controller.activeTime, held, `update(${dt}) must not advance phase on duplicate clock`);
        controller.play('walk', 'idle', undefined, 0.75, 1);
        controller.play('walk', 'idle', undefined, 0.75, 1.7);
        assert.equal(controller.activeTime, held, 'duplicate play(clock) must not advance phase');
      }
    } finally {
      controller.dispose();
    }
  });

  it('rewinds deterministically when the authoritative clock decreases', () => {
    const rootObj = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'hips';
    hips.position.set(0, 1, 0);
    rootObj.add(hips);
    const clip = new THREE.AnimationClip('walk.001', 2, [
      new THREE.VectorKeyframeTrack('hips.position', [0, 2], [0, 1, 0, 0, 1, 0]),
    ]);
    const manifest = {
      id: 'actor-aren-rewind',
      requiredActionIds: ['walk'],
      actionToClipMapping: { walk: 'walk.001' },
      rootMotion: { walk: motionInPlace() },
      sockets: [],
    };
    const controller = new AnimationController(rootObj, [clip], manifest);
    try {
      controller.play('walk', 'idle', undefined, 1.5, 1);
      assert.ok(Math.abs(controller.activeTime - 1.5) < 1e-6);

      // Load/rewind: clock decreased -> reseed phase = clock * rate.
      controller.play('walk', 'idle', undefined, 0.25, 1);
      assert.ok(Math.abs(controller.activeTime - 0.25) < 1e-6);
    } finally {
      controller.dispose();
    }
  });

  it('holds phase at zero playback rate under repeated play(clock)+update calls', () => {
    const rootObj = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'hips';
    hips.position.set(0, 1, 0);
    rootObj.add(hips);
    const clip = new THREE.AnimationClip('walk.001', 2, [
      new THREE.VectorKeyframeTrack('hips.position', [0, 2], [0, 1, 0, 0, 1, 0]),
    ]);
    const manifest = {
      id: 'actor-aren-zero-rate',
      requiredActionIds: ['walk'],
      actionToClipMapping: { walk: 'walk.001' },
      rootMotion: { walk: motionInPlace() },
      sockets: [],
    };
    const controller = new AnimationController(rootObj, [clip], manifest);
    try {
      controller.play('walk', 'idle', undefined, 0.8, 0);
      const held = controller.activeTime;
      assert.ok(typeof held === 'number');
      // Multiple production frames at zero rate: phase must hold.
      for (const dt of [0.5, 1.7, 0.016, 0.9]) {
        controller.update(dt);
        assert.equal(controller.activeTime, held);
      }
      // And repeated play(clock, 0) must also not advance.
      controller.play('walk', 'idle', undefined, 1.5, 0);
      assert.equal(controller.activeTime, held);
      controller.play('walk', 'idle', undefined, 3.2, 0);
      assert.equal(controller.activeTime, held);
    } finally {
      controller.dispose();
    }
  });

  it('transfers normalized gait phase across different-duration loop clips', () => {
    const rootObj = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'hips';
    hips.position.set(0, 1, 0);
    rootObj.add(hips);
    const walkClip = new THREE.AnimationClip('walk.001', 2, [
      new THREE.VectorKeyframeTrack('hips.position', [0, 2], [0, 1, 0, 0, 1, 0]),
    ]);
    const runClip = new THREE.AnimationClip('run.001', 1.4, [
      new THREE.VectorKeyframeTrack('hips.position', [0, 1.4], [0, 1, 0, 0, 1, 0]),
    ]);
    const manifest = {
      id: 'actor-aren-walk-run-phase',
      requiredActionIds: ['walk', 'run'],
      actionToClipMapping: { walk: 'walk.001', run: 'run.001' },
      rootMotion: { walk: motionInPlace(), run: motionInPlace() },
      sockets: [],
    };
    const controller = new AnimationController(rootObj, [walkClip, runClip], manifest);
    try {
      // Walk to a known phase: 1.0/2 = 0.5 normalized.
      controller.play('walk', 'idle', undefined, 1.0, 1);
      assert.ok(Math.abs(controller.activeTime - 1.0) < 1e-6);

      // Cross-fade to run at the next clock. The carried normalized phase
      // (0.5) is mapped to the new duration (1.4) = 0.7, then the clock
      // delta (0.2 s at rate 1) advances the new loop: 0.9.
      controller.play('run', 'idle', undefined, 1.2, 1);
      assert.ok(Math.abs(controller.activeTime - 0.9) < 1e-5,
        `run time should carry walk phase 0.5 -> 0.7 plus the 0.2 s delta, got ${controller.activeTime}`);

      // The new clock is the baseline; subsequent same-clock samples
      // and update deltas do not advance.
      controller.update(0.9);
      assert.ok(Math.abs(controller.activeTime - 0.9) < 1e-5);
      controller.play('run', 'idle', undefined, 1.2, 1);
      assert.ok(Math.abs(controller.activeTime - 0.9) < 1e-5);

      // Next clock advances: delta=0.4, *rate=1 -> 0.9 + 0.4 = 1.3.
      controller.play('run', 'idle', undefined, 1.6, 1);
      assert.ok(Math.abs(controller.activeTime - 1.3) < 1e-6);
      // A checkpoint rewind wins over gait transfer when the clip also changes.
      controller.play('walk', 'idle', undefined, 0.4, 1);
      controller.update(0.7);
      assert.ok(Math.abs(controller.activeTime - 0.4) < 1e-6);
    } finally {
      controller.dispose();
    }
  });

  it('crossfades walk into run at the supplied loop time', () => {
    const rootObj = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'hips';
    hips.position.set(0, 1, 0);
    rootObj.add(hips);
    const walkClip = new THREE.AnimationClip('walk.001', 2, [
      new THREE.VectorKeyframeTrack('hips.position', [0, 2], [0, 1.25, 0, 0, 1.25, 0]),
    ]);
    const runClip = new THREE.AnimationClip('run.001', 1.4, [
      new THREE.VectorKeyframeTrack('hips.position', [0, 1.4], [0, 1.75, 0, 0, 1.75, 0]),
    ]);
    const manifest = {
      id: 'actor-aren-walkrun',
      requiredActionIds: ['walk', 'run'],
      actionToClipMapping: { walk: 'walk.001', run: 'run.001' },
      rootMotion: { walk: motionInPlace(), run: motionInPlace() },
      sockets: [],
    };
    const controller = new AnimationController(rootObj, [walkClip, runClip], manifest);
    try {
      controller.play('walk', 'idle', undefined, 0.5, 1);
      assert.equal(controller.activeActionId, 'walk');
      controller.update(0.12);
      assert.ok(Math.abs(hips.position.y - 1.25) < 1e-6);

      controller.play('run', 'idle', undefined, 0.5, 1);
      assert.equal(controller.activeActionId, 'run');
      // Loop→loop fades over ANIMATION_FADE_SECONDS.loopToLoop (0.25 s): linear weights, half way at 0.125 s.
      assert.ok(Math.abs(hips.position.y - 1.25) < 1e-6, 'a fresh transition starts from the visible pose');
      controller.update(ANIMATION_FADE_SECONDS.loopToLoop / 2);
      assert.ok(Math.abs(hips.position.y - 1.5) < 1e-6);
      controller.update(ANIMATION_FADE_SECONDS.loopToLoop / 2);
      assert.ok(Math.abs(hips.position.y - 1.75) < 1e-6);
      assert.equal(rootObj.position.y, 0);
      assert.equal(controller.activeRootMotionMetadata?.mode, 'in-place');
    } finally {
      controller.dispose();
    }
  });

  it('keeps aliased action identity across the production sequence', () => {
    const rootObj = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'hips';
    hips.position.set(0, 1, 0);
    rootObj.add(hips);
    const clip = new THREE.AnimationClip('dive.001', 2, [
      new THREE.VectorKeyframeTrack('hips.position', [0, 1, 2], [0, 1, 0, 0, 2, 0, 0, 1, 0]),
    ]);
    const manifest = {
      id: 'actor-aren-test',
      requiredActionIds: [],
      actionToClipMapping: { 'dive-left': 'dive.001', 'dive-right': 'dive.001' },
      rootMotion: { 'dive-left': rootMotion(), 'dive-right': rootMotion() },
      sockets: [],
    };
    const controller = new AnimationController(rootObj, [clip], manifest);
    try {
      // Aliased actions share a clip but retain their own actionId.
      // Each play seeds phase = clock * rate (rate=1 here).
      controller.play('dive-left', 'idle', undefined, 0.5, 1);
      assert.equal(controller.activeActionId, 'dive-left');
      assert.equal(controller.activeTime, 0.5);
      assert.equal(hips.position.y, 1);

      controller.update(0.9);
      assert.equal(controller.activeTime, 0.5, 'update(dt) must not advance loop phase');

      controller.play('dive-right', 'idle', undefined, 1.5, 1);
      assert.equal(controller.activeActionId, 'dive-right');
      assert.equal(controller.activeRootMotionMetadata, manifest.rootMotion['dive-right']);
      // delta = 1.5 - 0.5 = 1.0; accumulator 0.5 + 1.0 = 1.5
      assert.equal(controller.activeTime, 1.5);
      assert.equal(hips.position.y, 1);
    } finally {
      controller.dispose();
    }
  });

  it('starts finite dive from a snapshot normalizedTime without disturbing loop continuity', () => {
    const rootObj = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'hips';
    hips.position.set(0, 1, 0);
    rootObj.add(hips);
    const diveClip = new THREE.AnimationClip('dive.001', 1, [
      new THREE.VectorKeyframeTrack('hips.position', [0, 0.5, 1], [0, 1, 0, 0, 2, 0, 0, 1, 0]),
    ]);
    const walkClip = new THREE.AnimationClip('walk.001', 2, [
      new THREE.VectorKeyframeTrack('hips.position', [0, 1, 2], [0, 1, 0, 0, 1.5, 0, 0, 1, 0]),
    ]);
    const nativeRoot = () => ({
      mode: 'native-root-motion',
      rootNodeName: 'hips',
      curveSamples: [
        { time: 0, position: { x: 0, y: 1, z: 0 } },
        { time: 1, position: { x: 0, y: 1, z: 0.8 } },
      ],
      evidenceStatus: 'verified',
    });
    const manifest = {
      id: 'actor-aren-dive',
      requiredActionIds: ['walk', 'dive'],
      actionToClipMapping: { walk: 'walk.001', dive: 'dive.001' },
      rootMotion: { walk: motionInPlace(), dive: nativeRoot() },
      sockets: [],
    };
    const controller = new AnimationController(rootObj, [walkClip, diveClip], manifest);
    try {
      controller.play('walk', 'idle', undefined, 0.4, 1);
      const walkTime = controller.activeTime;
      assert.ok(typeof walkTime === 'number');

      controller.play('dive', 'windup', 0.35);
      assert.equal(controller.activeActionId, 'dive');
      assert.equal(controller.activeTime, 0.35);
      assert.equal(controller.activeRootMotionMetadata?.mode, 'native-root-motion');
      assert.equal(hips.position.y, 1);
    } finally {
      controller.dispose();
    }
  });

  it('restarts a repeated finite action at normalizedTime=0 without stale completion', () => {
    const rootObj = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'hips';
    hips.position.set(0, 1, 0);
    rootObj.add(hips);
    const diveClip = new THREE.AnimationClip('dive.001', 1, [
      new THREE.VectorKeyframeTrack('hips.position', [0, 0.5, 1], [0, 1, 0, 0, 2, 0, 0, 1, 0]),
    ]);
    const nativeRoot = () => ({
      mode: 'native-root-motion',
      rootNodeName: 'hips',
      curveSamples: [
        { time: 0, position: { x: 0, y: 1, z: 0 } },
        { time: 1, position: { x: 0, y: 1, z: 0.8 } },
      ],
      evidenceStatus: 'verified',
    });
    const manifest = {
      id: 'actor-aren-repeat-finite',
      requiredActionIds: ['dive'],
      actionToClipMapping: { dive: 'dive.001' },
      rootMotion: { dive: nativeRoot() },
      sockets: [],
    };
    const controller = new AnimationController(rootObj, [diveClip], manifest);
    try {
      // Finite clips are paused; update(dt) advances fade weights only
      // and never advances finite action time.
      controller.play('dive', 'windup', 0);
      assert.equal(controller.activeTime, 0);
      controller.update(0.4);
      assert.equal(controller.activeTime, 0, 'update(dt) must not advance finite phase');

      controller.play('dive', 'recovery', 1);
      controller.update(0.4);
      assert.equal(controller.activeTime, 1);
      // Repeated same finite at normalizedTime=0 restarts the pose.
      controller.play('dive', 'windup', 0);
      assert.equal(controller.activeTime, 0);
      controller.play('dive', 'windup', 0.25);
      assert.equal(controller.activeTime, 0.25);
    } finally {
      controller.dispose();
    }
  });

  it('retains authored native crouch/bob Y while clamping horizontal travel to the bind', () => {
    const rootObj = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'hips';
    hips.position.set(0, 1, 0);
    rootObj.add(hips);
    const diveClip = new THREE.AnimationClip('dive.001', 2, [
      new THREE.VectorKeyframeTrack('hips.position', [0, 1, 2], [0, 0.2, 1.5, 0, 0.6, 0.8, 0, 1, 0]),
    ]);
    const manifest = {
      id: 'actor-aren-preserve-vertical',
      requiredActionIds: ['dive'],
      actionToClipMapping: { dive: 'dive.001' },
      rootMotion: { dive: preserveVerticalRootMotion() },
      sockets: [],
    };
    const controller = new AnimationController(rootObj, [diveClip], manifest);
    try {
      controller.play('dive', 'windup', 0.5);
      assert.equal(controller.activeActionId, 'dive');
      assert.equal(controller.activeTime, 1);
      assert.equal(hips.position.x, 0);
      assert.equal(hips.position.z, 0);
      assert.ok(Math.abs(hips.position.y - 0.6) < 1e-5);

      controller.update(0.1);
      assert.ok(Math.abs(hips.position.y - 0.6) < 1e-5);

      controller.update(0.1);
      assert.equal(hips.position.x, 0);
      assert.equal(hips.position.z, 0);
    } finally {
      controller.dispose();
    }
  });

  it('keeps the crouch along actor up and clamps horizontal travel when the armature is Z-up', () => {
    const rootObj = new THREE.Group();
    const armature = new THREE.Object3D();
    // Tripo/Mixamo exports: the armature turns parent-local +Z into actor up.
    armature.rotation.x = -Math.PI / 2;
    rootObj.add(armature);
    const hips = new THREE.Bone();
    hips.name = 'hips';
    hips.position.set(0, 0, 1);
    armature.add(hips);
    const kneelClip = new THREE.AnimationClip('kneel.001', 2, [
      new THREE.VectorKeyframeTrack('hips.position', [0, 1, 2], [0, 0, 1, 0.5, 0.3, 0.6, 0, 0, 1]),
    ]);
    const manifest = {
      id: 'actor-yara-z-up',
      requiredActionIds: ['kneel'],
      actionToClipMapping: { kneel: 'kneel.001' },
      rootMotion: { kneel: preserveVerticalRootMotion() },
      sockets: [],
    };
    const controller = new AnimationController(rootObj, [kneelClip], manifest);
    try {
      controller.play('kneel', 'windup', 0.5);
      assert.ok(Math.abs(hips.position.x) < 1e-9);
      assert.ok(Math.abs(hips.position.y) < 1e-9);
      assert.ok(Math.abs(hips.position.z - 0.6) < 1e-5);
      rootObj.updateMatrixWorld(true);
      const actorSpace = hips.getWorldPosition(new THREE.Vector3());
      assert.ok(Math.abs(actorSpace.y - 0.6) < 1e-5, 'the kneel lowers the body instead of floating at standing height');
      assert.ok(Math.hypot(actorSpace.x, actorSpace.z) < 1e-6, 'no horizontal drift survives');
    } finally {
      controller.dispose();
    }
  });

  it('keeps default full-root consumption for actions without preserveVerticalMotion', () => {
    const rootObj = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'hips';
    hips.position.set(0, 1, 0);
    rootObj.add(hips);
    const diveClip = new THREE.AnimationClip('dive.001', 2, [
      new THREE.VectorKeyframeTrack('hips.position', [0, 1, 2], [0, 0.2, 1.5, 0, 0.6, 0.8, 0, 1, 0]),
    ]);
    const manifest = {
      id: 'actor-aren-default-vertical',
      requiredActionIds: ['dive'],
      actionToClipMapping: { dive: 'dive.001' },
      rootMotion: { dive: rootMotion() },
      sockets: [],
    };
    const controller = new AnimationController(rootObj, [diveClip], manifest);
    try {
      controller.play('dive', 'windup', 0.5);
      assert.equal(controller.activeTime, 1);
      assert.equal(hips.position.x, 0);
      assert.equal(hips.position.y, 1);
      assert.equal(hips.position.z, 0);
    } finally {
      controller.dispose();
    }
  });

  it('captures the canonical bind before playback and never re-samples a posed node', () => {
    const rootObj = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'hips';
    hips.position.set(0, 1, 0);
    rootObj.add(hips);
    const diveClip = new THREE.AnimationClip('dive.001', 2, [
      new THREE.VectorKeyframeTrack('hips.position', [0, 1, 2], [0, 0.2, 0, 0, 0.6, 0, 0, 1, 0]),
    ]);
    const manifest = {
      id: 'actor-aren-aliased-bind',
      requiredActionIds: [],
      actionToClipMapping: { 'dive-left': 'dive.001', 'dive-right': 'dive.001' },
      rootMotion: {
        'dive-left': preserveVerticalRootMotion(),
        'dive-right': preserveVerticalRootMotion(),
      },
      sockets: [],
    };
    // Constructor captures the canonical bind (0, 1, 0) before playback.
    const controller = new AnimationController(rootObj, [diveClip], manifest);
    try {
      // Pre-fade hips to prove the bind was captured before this drift.
      hips.position.set(2, 3, 4);
      controller.play('dive-left', 'windup', 0.5);
      controller.update(0.2);
      assert.equal(hips.position.x, 0);
      assert.equal(hips.position.z, 0);
      assert.ok(Math.abs(hips.position.y - 0.6) < 1e-5);
    } finally {
      controller.dispose();
    }
  });

  for (const finite of ['jump', 'dive']) {
    it(`blends ${finite}'s sampled recovery into run without a bind-pose or zero-weight completion frame`, () => {
      const rootObj = new THREE.Group();
      const hips = new THREE.Bone();
      hips.name = 'hips';
      hips.position.set(0, 1, 0);
      rootObj.add(hips);
      const runClip = new THREE.AnimationClip('run', 2, [
        new THREE.VectorKeyframeTrack('hips.position', [0, 2], [0, 1.2, 0, 0, 1.2, 2]),
      ]);
      const finiteClip = new THREE.AnimationClip(finite, 3, [
        new THREE.VectorKeyframeTrack('hips.position', [0, 3], [0, 1.8, 0, 0, 1.8, 3]),
      ]);
      const manifest = {
        id: 'recovery-handoff',
        requiredActionIds: ['run', finite],
        actionToClipMapping: { run: 'run', [finite]: finite },
        rootMotion: { run: preserveVerticalRootMotion(), [finite]: preserveVerticalRootMotion() },
        sockets: [],
      };
      const controller = new AnimationController(rootObj, [runClip, finiteClip], manifest);
      try {
        controller.play('run', 'idle', 0, 0.4);
        controller.play(finite, 'active', 0.5, 0.5);
        controller.update(0.2);
        controller.play(finite, 'recovery', 0.9, 0.9, 1, 'run', 0.5);
        assert.equal(controller.activeActionId, finite, 'recovery must not replace finite simulation identity');
        assert.ok(Math.abs(controller.activeTime - 2.7) < 1e-6, 'finite clip still samples its full timeline');
        assert.ok(Math.abs(hips.position.y - 1.5) < 1e-6, 'the actual bone pose contains both clips');
        assert.equal(hips.position.x, 0);
        assert.equal(hips.position.z, 0, 'blending cannot reintroduce native horizontal root travel');
        const runAction = controller.mixer.existingAction(runClip);
        const heldTime = runAction.time;
        const heldY = hips.position.y;
        controller.update(0);
        controller.play(finite, 'recovery', 0.9, 0.9, 1, 'run', 0.5);
        assert.equal(runAction.time, heldTime);
        assert.equal(hips.position.y, heldY, 'duplicate paused snapshots preserve recovery pose');
        controller.play(finite, 'recovery', 1, 1, 1, 'run', 1);
        assert.ok(Math.abs(hips.position.y - 1.2) < 1e-6);
        const incomingTime = runAction.time;
        controller.play('run', 'idle', 0, 1 + 1 / 60);
        assert.ok(Math.abs(controller.activeTime - incomingTime - 1 / 60) < 1e-6);
        assert.ok(Math.abs(hips.position.y - 1.2) < 1e-6, 'promotion must not restart a fade from zero');
        controller.update(1 / 60);
        assert.ok(Math.abs(hips.position.y - 1.2) < 1e-6);
        controller.play(finite, 'recovery', 0.9, 2, 1, 'run', 0.5);
        controller.play(finite, 'anticipation', 0, 2 + 1 / 60);
        controller.update(0.2);
        assert.equal(controller.activeTime, 0, 'repeat must restart the finite timeline');
        assert.ok(Math.abs(hips.position.y - 1.8) < 1e-6, 'interrupted recovery must not leave a gait contributing');
        assert.equal(runAction.isScheduled(), false, 'the recovery loop is stopped on a finite restart');
      } finally {
        controller.dispose();
      }
    });
  }

  it('suspends gait cadence during a finite action rather than adding its whole duration on resume', () => {
    const rootObj = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'hips';
    rootObj.add(hips);
    const clips = ['run', 'jump'].map(name => new THREE.AnimationClip(name, 2, [
      new THREE.VectorKeyframeTrack('hips.position', [0, 2], [0, 1, 0, 0, 1, 0]),
    ]));
    const controller = new AnimationController(rootObj, clips, {
      id: 'finite-cadence', requiredActionIds: ['run', 'jump'],
      actionToClipMapping: { run: 'run', jump: 'jump' },
      rootMotion: { run: motionInPlace(), jump: motionInPlace() }, sockets: [],
    });
    try {
      controller.play('run', 'idle', 0, 0.4);
      controller.play('jump', 'active', 0, 0.5);
      controller.update(0.2);
      controller.play('jump', 'recovery', 1, 1.5);
      controller.play('run', 'idle', 0, 1.5 + 1 / 60);
      assert.ok(Math.abs(controller.activeTime - (0.4 + 1 / 60)) < 1e-6);
      controller.play('run', 'idle', 0, 0.1);
      assert.ok(Math.abs(controller.activeTime - 0.1) < 1e-6, 'rewind still deterministically reseeds cadence');
    } finally {
      controller.dispose();
    }
  });

  it('clears state on dispose and rejects further play/update calls', () => {
    const rootObj = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'hips';
    hips.position.set(0, 1, 0);
    rootObj.add(hips);
    const clip = new THREE.AnimationClip('walk.001', 2, [
      new THREE.VectorKeyframeTrack('hips.position', [0, 2], [0, 1, 0, 0, 1, 0]),
    ]);
    const manifest = {
      id: 'actor-aren-dispose',
      requiredActionIds: ['walk'],
      actionToClipMapping: { walk: 'walk.001' },
      rootMotion: { walk: motionInPlace() },
      sockets: [],
    };
    const controller = new AnimationController(rootObj, [clip], manifest);
    controller.play('walk', 'idle', undefined, 0.5, 1);
    controller.dispose();
    assert.equal(controller.activeActionId, undefined);
    assert.throws(() => controller.play('walk', 'idle', undefined, 0.5, 1), /disposed/);
    controller.update(1);
  });

  it('unpauses mixer local playback for playPreview without double-counting dt', () => {
    const rootObj = new THREE.Group();
    const hips = new THREE.Bone();
    hips.name = 'hips';
    hips.position.set(0, 1, 0);
    rootObj.add(hips);
    const clip = new THREE.AnimationClip('walk.001', 2, [
      new THREE.VectorKeyframeTrack('hips.position', [0, 2], [0, 1, 0, 0, 1, 0]),
    ]);
    const manifest = {
      id: 'actor-aren-preview',
      requiredActionIds: ['walk'],
      actionToClipMapping: { walk: 'walk.001' },
      rootMotion: { walk: motionInPlace() },
      sockets: [],
    };
    const controller = new AnimationController(rootObj, [clip], manifest);
    try {
      controller.playPreview('walk');
      const start = controller.activeTime;
      // Local preview runs the mixer; update() must not also add gameplay dt.
      controller.update(0.5);
      const after = controller.activeTime;
      // The mixer advanced by dt (because unpaused); gameplay loop
      // accumulator was untouched.
      assert.ok(after >= start, 'preview mixer should advance');
      // Loop accumulator (0) is unchanged; no second dt was added.
      controller.update(0.5);
      assert.equal(controller.activeTime, after + 0.5, 'preview mixer advances on each update');
    } finally {
      controller.dispose();
    }
  });
  it('preserves the actual native posed surface and joint lengths through loading and locomotion blends', async () => {
    const manifest = JSON.parse(await readFile(`${root}/asset-source/playtests/greenwake.json`, 'utf8')).find(entry => entry.id === 'actor-aren');
    const bytes = await readFile(`${root}${manifest.runtimeUrl}`);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const previousFetch = globalThis.fetch;
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
    globalThis.fetch = async () => new Response(buffer);
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { baseURI: 'http://localhost/' } });
    // Texture decoding is irrelevant to this CPU skinning measurement; geometry,
    // skin, native clips and loader hash verification use the exact source bytes.
    const materialsOnly = () => ({ name: 'surface-test-material', loadMaterial: () => Promise.resolve(new THREE.MeshBasicMaterial()) });
    const loader = new NativeAssetLoader({ allowMissingActionClips: true, simplifyBlockedCandidates: true });
    loader.loader.register(materialsOnly);
    let instance;
    let native;
    try {
      instance = await loader.load(manifest);
      native = await new GLTFLoader().register(materialsOnly).parseAsync(buffer, '');
      // The loader keeps the manifest scale on an inner node below the simulation root; the reference scene gets the same frame.
      const nativeFrame = new THREE.Group();
      nativeFrame.add(native.scene);
      native.scene.scale.setScalar(manifest.coordinateTransform.scale);
      let mesh;
      let source;
      instance.root.traverse(node => { if (node.isSkinnedMesh) mesh = node; });
      native.scene.traverse(node => { if (node.isSkinnedMesh) source = node; });
      assert.ok(mesh && source);
      assert.deepEqual(mesh.geometry.index.array, source.geometry.index.array);
      const positions = source.geometry.getAttribute('position');
      const seamPairs = [];
      const coincident = new Map();
      for (let vertex = 0; vertex < positions.count; vertex++) {
        const key = [positions.getX(vertex), positions.getY(vertex), positions.getZ(vertex)].join(',');
        const other = coincident.get(key);
        if (other === undefined) coincident.set(key, vertex);
        else seamPairs.push([other, vertex]);
      }
      assert.ok(seamPairs.length > 0, 'the native fixture must exercise split vertex seams');
      const jointLengths = new Map();
      instance.root.traverse(node => {
        if (node.isBone && node.parent?.isBone) jointLengths.set(node, node.position.length());
      });
      const sourceMixer = new THREE.AnimationMixer(native.scene);
      const sourceHips = native.scene.getObjectByName('mixamorigHips');
      const bind = sourceHips.position.clone();
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();
      const actions = ['aren-idle', 'aren-walk', 'aren-run', 'aren-jump', 'aren-forward-left-dive-roll'];
      for (const actionId of actions) {
        sourceMixer.stopAllAction();
        const clip = native.animations.find(candidate => candidate.name === manifest.actionToClipMapping[actionId]);
        const reference = sourceMixer.clipAction(clip).play();
        reference.paused = true;
        reference.setLoop(THREE.LoopOnce, 1);
        reference.clampWhenFinished = true;
        for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
          instance.animation.play(actionId, 'active', progress);
          instance.animation.update(0.13);
          reference.time = progress * clip.duration;
          sourceMixer.update(0);
          sourceHips.position.x = bind.x;
          sourceHips.position.z = bind.z;
          for (const scene of [instance.root, nativeFrame]) {
            scene.position.set(3 + progress, 0.2, -2);
            scene.rotation.y = 0.7 + progress;
            scene.updateMatrixWorld(true);
          }
          let maximumError = 0;
          for (let vertex = 0; vertex < positions.count; vertex++) {
            mesh.getVertexPosition(vertex, a).applyMatrix4(mesh.matrixWorld);
            source.getVertexPosition(vertex, b).applyMatrix4(source.matrixWorld);
            maximumError = Math.max(maximumError, a.distanceTo(b));
          }
          assert.ok(maximumError < 1e-6, `${actionId}@${progress}: loader/controller changed native skin by ${maximumError}`);
        }
      }
      // The dedicated repair regression below covers the formerly noncoincident
      // shoulder boundaries; runtime must also preserve all coincident seams.
      let tick = 0;
      for (const actionId of [...actions, 'aren-run', 'aren-walk']) {
        const loops = /idle|walk|run/.test(actionId);
        for (let frame = 0; frame < 16; frame++, tick++) {
          instance.animation.update(1 / 60);
          instance.animation.play(actionId, loops ? 'idle' : 'active', loops ? undefined : frame / 15, tick / 60, 1,
            !loops && frame > 10 ? 'aren-run' : undefined, !loops && frame > 10 ? (frame - 10) / 5 : 0);
          instance.root.updateMatrixWorld(true);
          let maximumSeam = 0;
          for (const [left, right] of seamPairs) {
            mesh.getVertexPosition(left, a);
            mesh.getVertexPosition(right, b);
            maximumSeam = Math.max(maximumSeam, a.distanceTo(b));
          }
          assert.ok(maximumSeam < 1e-7, `${actionId}: an originally coincident seam opened`);
          for (const [bone, length] of jointLengths) {
            if (length > 1e-6) assert.ok(Math.abs(bone.position.length() / length - 1) < 1e-4, `${actionId}: ${bone.name} changed length`);
          }
        }
      }
      sourceMixer.stopAllAction();
      sourceMixer.uncacheRoot(native.scene);
    } finally {
      instance?.dispose();
      loader.dispose();
      native?.scene.traverse(node => {
        if (node.isMesh) {
          node.geometry.dispose();
          for (const material of Array.isArray(node.material) ? node.material : [node.material]) material.dispose();
        }
      });
      globalThis.fetch = previousFetch;
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
      else delete globalThis.document;
    }
  });
  it('closes the native shoulder boundaries without replacing the rig, materials or surrounding surface', async () => {
    const manifest = JSON.parse(await readFile(`${root}/asset-source/playtests/greenwake.json`, 'utf8')).find(entry => entry.id === 'actor-aren');
    const originalBytes = await readFile(`${root}/asset-source/generated/actor-aren-user-supplied-01/aren.glb`);
    const candidateBytes = await readFile(`${root}${manifest.runtimeUrl}`);
    const jsonOf = bytes => JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12)).trim());
    const originalJson = jsonOf(originalBytes);
    const candidateJson = jsonOf(candidateBytes);
    const repair = candidateJson.asset.extras?.wildCrownSeamRepair;
    assert.ok(repair, 'the selected native candidate must include the shoulder repair provenance');
    assert.equal(repair.sourceSha256, createHash('sha256').update(originalBytes).digest('hex'));
    assert.equal(repair.seamPairs.length, 40, 'both twenty-point arm attachment boundaries must be covered');
    for (const field of ['nodes', 'skins', 'materials', 'textures', 'images', 'samplers']) {
      assert.deepEqual(candidateJson[field], originalJson[field], `${field} must retain the exact native definition`);
    }
    const viewBytes = (bytes, json, index) => {
      const view = json.bufferViews[index];
      const start = 28 + bytes.readUInt32LE(12) + (view.byteOffset ?? 0);
      return bytes.subarray(start, start + view.byteLength);
    };
    const primitive = originalJson.meshes[0].primitives[0];
    const geometryViews = new Set([...Object.values(primitive.attributes), primitive.indices].map(index => originalJson.accessors[index].bufferView));
    for (let index = 0; index < originalJson.bufferViews.length; index++) {
      if (!geometryViews.has(index)) assert.deepEqual(viewBytes(candidateBytes, candidateJson, index), viewBytes(originalBytes, originalJson, index), `native bufferView ${index} changed`);
    }
    for (const semantic of ['NORMAL', 'TEXCOORD_0']) {
      const view = originalJson.accessors[primitive.attributes[semantic]].bufferView;
      const original = viewBytes(originalBytes, originalJson, view);
      assert.deepEqual(viewBytes(candidateBytes, candidateJson, view).subarray(0, original.length), original, `original ${semantic} splits must be preserved`);
    }
    const parse = bytes => new GLTFLoader().register(() => ({
      name: 'seam-test-material', loadMaterial: () => Promise.resolve(new THREE.MeshBasicMaterial()),
    })).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
    const original = await parse(originalBytes);
    const candidate = await parse(candidateBytes);
    const meshes = [original, candidate].map(gltf => {
      let mesh;
      gltf.scene.traverse(node => { if (node.isSkinnedMesh) mesh = node; });
      assert.ok(mesh);
      return mesh;
    });
    const [sourceMesh, repairedMesh] = meshes;
    const sourcePosition = sourceMesh.geometry.getAttribute('position');
    const repairedPosition = repairedMesh.geometry.getAttribute('position');
    const changed = new Set(repair.changedOriginalRows);
    // GLTFLoader normalizes skin weights on import. Comparing the persisted rows
    // also catches accidental reserialization of those normalized Float32 values.
    const componentBytes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
    for (const semantic of ['POSITION', 'JOINTS_0', 'WEIGHTS_0']) {
      const before = originalJson.accessors[primitive.attributes[semantic]];
      const after = candidateJson.accessors[candidateJson.meshes[0].primitives[0].attributes[semantic]];
      assert.equal(after.type, before.type);
      assert.equal(after.componentType, before.componentType);
      assert.equal(after.normalized, before.normalized);
      const width = componentBytes[before.componentType] * (before.type === 'VEC3' ? 3 : 4);
      const beforeStride = originalJson.bufferViews[before.bufferView].byteStride ?? width;
      const afterStride = candidateJson.bufferViews[after.bufferView].byteStride ?? width;
      const beforeBytes = viewBytes(originalBytes, originalJson, before.bufferView);
      const afterBytes = viewBytes(candidateBytes, candidateJson, after.bufferView);
      for (let vertex = 0; vertex < before.count; vertex++) {
        if (changed.has(vertex)) continue;
        const beforeStart = (before.byteOffset ?? 0) + vertex * beforeStride;
        const afterStart = (after.byteOffset ?? 0) + vertex * afterStride;
        assert.deepEqual(afterBytes.subarray(afterStart, afterStart + width), beforeBytes.subarray(beforeStart, beforeStart + width),
          `raw ${semantic} row ${vertex} changed outside the local shoulder repair`);
      }
    }
    for (const name of ['position', 'skinIndex', 'skinWeight']) {
      const before = sourceMesh.geometry.getAttribute(name);
      const after = repairedMesh.geometry.getAttribute(name);
      for (let vertex = 0; vertex < before.count; vertex++) {
        if (changed.has(vertex)) continue;
        for (let component = 0; component < before.itemSize; component++) assert.equal(after.getComponent(vertex, component), before.getComponent(vertex, component), `${name} changed outside the local shoulder repair`);
      }
    }
    assert.equal(repairedPosition.count - sourcePosition.count, repair.addedVertices);
    assert.equal((repairedMesh.geometry.index.count - sourceMesh.geometry.index.count) / 3, repair.addedTriangles);
    const positionKey = (attribute, vertex) => [attribute.getX(vertex), attribute.getY(vertex), attribute.getZ(vertex)].join(',');
    const sourceTriangles = new Map();
    const sourceBoundaryTriangles = new Map();
    const sourceIndex = sourceMesh.geometry.index.array;
    for (let offset = 0; offset < sourceIndex.length; offset += 3) {
      const triangle = Array.from(sourceIndex.slice(offset, offset + 3));
      sourceTriangles.set(triangle.join(','), triangle);
      for (let edge = 0; edge < 3; edge++) {
        const key = [positionKey(sourcePosition, triangle[edge]), positionKey(sourcePosition, triangle[(edge + 1) % 3])].sort().join('|');
        sourceBoundaryTriangles.set(key, triangle);
      }
    }
    const inserted = new Map(repair.seamPairs.filter(pair => pair.torso >= sourcePosition.count).map(pair => [pair.torso, pair]));
    const normal = (position, triangle) => {
      const [a, b, c] = triangle.map(vertex => new THREE.Vector3().fromBufferAttribute(position, vertex));
      return b.sub(a).cross(c.sub(a));
    };
    const candidateIndex = repairedMesh.geometry.index.array;
    const edgeSets = [new Map(), new Map()];
    const collectEdges = (edges, position, triangle) => {
      for (let corner = 0; corner < 3; corner++) {
        const left = triangle[corner];
        const right = triangle[(corner + 1) % 3];
        const length = new THREE.Vector3().fromBufferAttribute(position, left).distanceTo(new THREE.Vector3().fromBufferAttribute(position, right));
        if (length > 1e-7) edges.set([Math.min(left, right), Math.max(left, right)].join(','), [left, right, length]);
      }
    };
    for (let offset = 0; offset < candidateIndex.length; offset += 3) {
      const triangle = Array.from(candidateIndex.slice(offset, offset + 3));
      if (!triangle.some(vertex => changed.has(vertex) || inserted.has(vertex))) continue;
      const split = triangle.map(vertex => inserted.get(vertex)).find(Boolean);
      const sourceTriangle = split
        ? sourceBoundaryTriangles.get(split.sourceEdge.map(vertex => positionKey(sourcePosition, vertex)).sort().join('|'))
        : sourceTriangles.get(triangle.join(','));
      assert.ok(sourceTriangle, 'every repaired triangle must retain a native parent surface');
      const before = normal(sourcePosition, sourceTriangle);
      const after = normal(repairedPosition, triangle);
      assert.ok(after.length() > 1e-12, 'the repair must not introduce a degenerate triangle');
      assert.ok(before.dot(after) > 0, 'the repair must not flip native triangle winding at bind');
      collectEdges(edgeSets[0], sourcePosition, sourceTriangle);
      collectEdges(edgeSets[1], repairedPosition, triangle);
    }
    const controllers = [original, candidate].map(gltf => new AnimationController(gltf.scene, gltf.animations, manifest, true));
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    let sourceOpening = 0;
    const maximumStretch = [0, 0];
    const measure = () => {
      for (const gltf of [original, candidate]) gltf.scene.updateMatrixWorld(true);
      for (const pair of repair.seamPairs) {
        repairedMesh.getVertexPosition(pair.arm, a);
        repairedMesh.getVertexPosition(pair.torso, b);
        assert.ok(a.distanceTo(b) < 1e-7, `shoulder boundary ${pair.arm}/${pair.torso} opened`);
      }
      sourceMesh.getVertexPosition(22749, a);
      sourceMesh.getVertexPosition(22751, b);
      sourceOpening = Math.max(sourceOpening, a.distanceTo(b));
      for (let index = 0; index < meshes.length; index++) {
        for (const [left, right, length] of edgeSets[index].values()) {
          meshes[index].getVertexPosition(left, a);
          meshes[index].getVertexPosition(right, b);
          maximumStretch[index] = Math.max(maximumStretch[index], a.distanceTo(b) / length);
        }
      }
    };
    try {
      const actions = ['aren-walk', 'aren-run', 'aren-jump', 'aren-forward-left-dive-roll'];
      for (const action of actions) for (let sample = 0; sample <= 24; sample++) {
        for (const controller of controllers) {
          controller.play(action, 'active', sample / 24);
          controller.update(0.13);
        }
        measure();
      }
      let tick = 0;
      for (const action of ['aren-walk', 'aren-walk', 'aren-run', 'aren-jump', 'aren-run', 'aren-forward-left-dive-roll', 'aren-run', 'aren-walk']) {
        const loops = /idle|walk|run/.test(action);
        for (let frame = 0; frame < 16; frame++, tick++) {
          for (const controller of controllers) {
            controller.update(1 / 60);
            controller.play(action, loops ? 'idle' : 'active', loops ? undefined : frame / 15, tick / 60, 1,
              !loops && frame > 10 ? 'aren-run' : undefined, !loops && frame > 10 ? (frame - 10) / 5 : 0);
          }
          measure();
        }
      }
      assert.ok(maximumStretch[1] < maximumStretch[0] * 1.5,
        `closing the seam must not replace a gap with extreme adjacent stretching (${maximumStretch.join(' -> ')})`);
      assert.ok(sourceOpening > 0.05, 'negative control: the unchanged source must reproduce the observed shoulder opening');
    } finally {
      for (const controller of controllers) controller.dispose();
      for (const mesh of meshes) {
        mesh.geometry.dispose();
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
      }
    }
  });
});

function transitionRig(clips, rootMotions = {}) {
  const rootObj = new THREE.Group();
  const hips = new THREE.Bone(); hips.name = 'hips'; hips.position.set(0, 1, 0);
  const arm = new THREE.Bone(); arm.name = 'arm'; arm.position.set(0.5, 0, 0);
  rootObj.add(hips, arm);
  const mapping = Object.fromEntries(clips.map((clip) => [clip.name, clip.name]));
  const manifest = {
    id: 'transition-rig', requiredActionIds: [], actionToClipMapping: mapping,
    rootMotion: Object.fromEntries(clips.map((clip) => [clip.name, rootMotions[clip.name] ?? motionInPlace()])), sockets: [],
  };
  return { rootObj, hips, arm, manifest };
}
/** Constant-pose clip: `hips.y` and `arm.x` identify it unambiguously in a blend. */
const poseClip = (name, hipsY, armX = 0.5, duration = 2) => new THREE.AnimationClip(name, duration, [
  new THREE.VectorKeyframeTrack('hips.position', [0, duration], [0, hipsY, 0, 0, hipsY, 0]),
  new THREE.VectorKeyframeTrack('arm.position', [0, duration], [armX, 0, 0, armX, 0, 0]),
]);
const totalWeight = (controller, clips) => clips.reduce((sum, clip) => { const action = controller.mixer.existingAction(clip); return sum + (action?.isScheduled() ? action.getEffectiveWeight() : 0); }, 0);
const near = (actual, expected, tolerance = 1e-6) => Math.abs(actual - expected) < tolerance;

describe('AnimationController transitions', () => {
  it('fades each transition kind over its own duration with linear weights', () => {
    assert.ok(ANIMATION_FADE_SECONDS.finiteToFinite <= ANIMATION_FADE_SECONDS.loopToFinite && ANIMATION_FADE_SECONDS.loopToFinite <= 0.1
      && ANIMATION_FADE_SECONDS.loopToFinite < ANIMATION_FADE_SECONDS.finiteToLoop && ANIMATION_FADE_SECONDS.finiteToLoop <= 0.25
      && ANIMATION_FADE_SECONDS.finiteToLoop < ANIMATION_FADE_SECONDS.loopToLoop, 'strikes enter fast, gaits settle softly');
    const kinds = [
      ['loopToLoop', 'loop-a', 'idle', 'loop-b', 'idle'],
      ['loopToFinite', 'loop-a', 'idle', 'finite-b', 'active'],
      ['finiteToLoop', 'finite-a', 'active', 'loop-b', 'idle'],
      ['finiteToFinite', 'finite-a', 'active', 'finite-b', 'active'],
    ];
    for (const [kind, fromId, fromPhase, toId, toPhase] of kinds) {
      const clips = [poseClip('loop-a', 1), poseClip('loop-b', 2), poseClip('finite-a', 1), poseClip('finite-b', 2)];
      const { rootObj, hips, manifest } = transitionRig(clips);
      const controller = new AnimationController(rootObj, clips, manifest);
      try {
        controller.play(fromId, fromPhase, 0.2, 0.2);
        controller.update(1);
        assert.ok(near(hips.position.y, 1), `${kind}: settled on the source pose`);
        controller.play(toId, toPhase, 0.2, 0.3);
        assert.ok(near(hips.position.y, 1), `${kind}: the fade starts at the visible pose`);
        const seconds = ANIMATION_FADE_SECONDS[kind];
        controller.update(seconds / 4);
        assert.ok(near(hips.position.y, 1.25), `${kind}: quarter way`);
        controller.update(seconds / 4);
        assert.ok(near(hips.position.y, 1.5), `${kind}: half way after ${seconds / 2}s`);
        assert.ok(near(totalWeight(controller, clips), 1), `${kind}: weights always sum to one`);
        controller.update(seconds / 2);
        assert.ok(near(hips.position.y, 2), `${kind}: complete after ${seconds}s`);
        controller.update(0.5);
        assert.ok(near(hips.position.y, 2));
        assert.equal(controller.mixer.existingAction(clips.find((clip) => clip.name === fromId)).isScheduled(), false, `${kind}: the faded-out clip is released`);
      } finally {
        controller.dispose();
      }
    }
  });

  it('holds every fade while the simulation is in hit-stop and resumes it afterwards', () => {
    const clips = [poseClip('finite-a', 1), poseClip('finite-b', 2)];
    const { rootObj, hips, manifest } = transitionRig(clips);
    const controller = new AnimationController(rootObj, clips, manifest);
    try {
      controller.play('finite-a', 'active', 0.2, 0.2);
      controller.update(1);
      controller.play('finite-b', 'active', 0.2, 0.3);
      controller.update(ANIMATION_FADE_SECONDS.finiteToFinite / 4);
      assert.ok(near(hips.position.y, 1.25), 'a quarter of the fade has run');
      for (let i = 0; i < 12; i += 1) {
        controller.play('finite-b', 'active', 0.2, 0.3);
        controller.update(1 / 60, true);
      }
      assert.ok(near(hips.position.y, 1.25), 'the blend is frozen for the whole hit-stop');
      controller.update(ANIMATION_FADE_SECONDS.finiteToFinite / 4);
      assert.ok(near(hips.position.y, 1.5), 'and continues from where it stopped');
    } finally {
      controller.dispose();
    }
  });

  it('runs the post-pose hook after every pose evaluation until it is removed or the controller is disposed', () => {
    const clips = [poseClip('idle', 1), poseClip('strike', 2)];
    const { rootObj, hips, manifest } = transitionRig(clips);
    const controller = new AnimationController(rootObj, clips, manifest);
    const seen = [];
    controller.setPostPose(() => { seen.push(hips.position.y); hips.position.x = 9; });
    controller.play('idle', 'idle', 0, 0);
    assert.deepEqual(seen, [1], 'play() poses the rig, then the hook overrides');
    controller.update(0.1);
    assert.equal(seen.length, 2);
    controller.update(0.1, true);
    assert.equal(seen.length, 2, 'a frozen update evaluates nothing');
    controller.setPostPose(undefined);
    controller.update(0.1);
    assert.equal(seen.length, 2);
    controller.setPostPose(() => seen.push(0));
    controller.dispose();
    assert.throws(() => controller.play('idle', 'idle', 0, 0));
    assert.equal(seen.length, 2, 'dispose drops the hook');
  });

  it('keeps a looping action advancing from the actor clock and its own rate while it fades out', () => {
    const walk = new THREE.AnimationClip('walk', 2, [new THREE.VectorKeyframeTrack('hips.position', [0, 2], [0, 0, 0, 0, 2, 0])]);
    const clips = [walk, poseClip('strike', 5), poseClip('run', 6, 0.5, 1.4)];
    const { rootObj, manifest } = transitionRig(clips);
    const controller = new AnimationController(rootObj, clips, manifest);
    try {
      controller.play('walk', 'idle', undefined, 1, 1.5);
      const walkAction = controller.mixer.existingAction(walk);
      controller.play('walk', 'idle', undefined, 1.1, 1.5);
      assert.ok(near(walkAction.time, 1.0 * 1.5 + 0.1 * 1.5), 'phase integrates clock delta x rate');
      controller.play('strike', 'active', 0, 1.2, 1);
      let previous = walkAction.time;
      assert.ok(near(previous, 1.5 + 0.3), 'the outgoing loop advances on the transition call itself');
      for (let frame = 1; frame <= 3; frame++) {
        controller.play('strike', 'active', frame / 40, 1.2 + frame / 60, 1);
        controller.update(1 / 60);
        assert.ok(near(walkAction.time - previous, 1.5 / 60, 1e-5), `fading-out loop must keep its own rate (frame ${frame})`);
        previous = walkAction.time;
      }
      assert.ok(walkAction.getEffectiveWeight() > 0 && walkAction.isScheduled(), 'still contributing while fading');
      controller.update(ANIMATION_FADE_SECONDS.loopToFinite);
      assert.equal(walkAction.isScheduled(), false, 'released once the fade completes');
      // walk -> run: the walk keeps its stride at its rate while run takes over.
      controller.play('walk', 'idle', undefined, 2, 1.5);
      controller.play('run', 'idle', undefined, 2.1, 1);
      const walkBefore = walkAction.time;
      controller.play('run', 'idle', undefined, 2.2, 1);
      assert.ok(near(walkAction.time - walkBefore, 0.1 * 1.5, 1e-5));
    } finally {
      controller.dispose();
    }
  });

  it('restarts an interrupted fade from the pose it reached and never leaves the unit weight sum', () => {
    const clips = [poseClip('idle', 1), poseClip('walk', 2), poseClip('run', 3), poseClip('strike', 4), poseClip('hit', 5)];
    const { rootObj, hips, manifest } = transitionRig(clips);
    const controller = new AnimationController(rootObj, clips, manifest);
    try {
      controller.play('idle', 'idle', undefined, 0);
      controller.play('walk', 'idle', undefined, 0.1);
      controller.update(ANIMATION_FADE_SECONDS.loopToLoop / 2);
      const reached = hips.position.y;
      assert.ok(near(reached, 1.5));
      controller.play('run', 'idle', undefined, 0.2);
      assert.ok(near(hips.position.y, reached), 'interrupting a fade must not pop');
      controller.update(0.05);
      controller.play('strike', 'active', 0.2, 0.3);
      const afterInterrupt = hips.position.y;
      controller.update(0.02);
      controller.play('hit', 'active', 0.1, 0.4);
      for (let step = 0; step < 40; step++) {
        controller.update(0.01);
        assert.ok(near(totalWeight(controller, clips), 1, 1e-9), `weights sum to one at step ${step}`);
        assert.ok(hips.position.y >= 1 - 1e-9 && hips.position.y <= 5 + 1e-9);
      }
      assert.ok(afterInterrupt > 1 && near(hips.position.y, 5));
    } finally {
      controller.dispose();
    }
  });

  it('holds the running loop or resumes idle for an unbound clip instead of fading to the bind pose', () => {
    const clips = [poseClip('idle', 1.5), poseClip('walk', 2), poseClip('strike', 4)];
    const { rootObj, hips, arm, manifest } = transitionRig(clips);
    const controller = new AnimationController(rootObj, clips, manifest, true);
    try {
      controller.play('walk', 'idle', undefined, 1);
      controller.play('unbound-slash', 'active', 0.5, 1.1);
      controller.update(0.5);
      assert.ok(controller.issues.some((issue) => issue.actionId === 'unbound-slash'), 'the missing clip is still reported');
      assert.equal(controller.activeActionId, 'walk', 'the running loop continues');
      assert.ok(near(hips.position.y, 2) && near(arm.position.x, 0.5), 'pose stays authored, not the bind pose');
      controller.play('strike', 'active', 0.5, 1.2);
      controller.update(1);
      assert.ok(near(hips.position.y, 4));
      controller.play('unbound-slash', 'active', 0.5, 1.3);
      controller.update(ANIMATION_FADE_SECONDS.finiteToLoop);
      assert.equal(controller.activeActionId, 'idle', 'a finished finite pose resumes the idle loop');
      assert.ok(near(hips.position.y, 1.5), 'idle, not bind (1.0)');
      assert.ok(near(totalWeight(controller, clips), 1));
    } finally {
      controller.dispose();
    }
    const strictRig = transitionRig(clips);
    const strict = new AnimationController(strictRig.rootObj, clips, strictRig.manifest);
    try {
      strict.play('walk', 'idle', undefined, 1);
      assert.throws(() => strict.play('unbound-slash', 'active', 0.5, 1.1), /unbound-slash/);
      assert.equal(strict.activeActionId, 'walk', 'a rejected action leaves playback untouched');
    } finally {
      strict.dispose();
    }
  });

  it('eases a finite action into the locomotion loop without a pose gap, even when the actor is slower than a run', () => {
    for (const finalWeight of [1, 0.5]) {
      const clips = [poseClip('run', 1.2), poseClip('dive', 1.8)];
      const { rootObj, hips, manifest } = transitionRig(clips);
      const controller = new AnimationController(rootObj, clips, manifest);
      try {
        controller.play('run', 'idle', undefined, 0);
        controller.play('dive', 'active', 0, 0.1);
        controller.update(1);
        let last = hips.position.y, largestStep = 0, clock = 0.1;
        for (let frame = 1; frame <= 20; frame++) {
          clock += 1 / 60;
          const t = frame / 20, weight = t * t * (3 - 2 * t) * finalWeight;
          controller.play('dive', 'recovery', 0.7 + 0.3 * t, clock, 1, 'run', weight);
          controller.update(1 / 60);
          largestStep = Math.max(largestStep, Math.abs(hips.position.y - last));
          last = hips.position.y;
        }
        clock += 1 / 60;
        controller.play('run', 'idle', undefined, clock, 1);
        largestStep = Math.max(largestStep, Math.abs(hips.position.y - last));
        controller.update(ANIMATION_FADE_SECONDS.finiteToLoop / 2);
        assert.ok(largestStep < 0.12, `weighted hand-off steps stay small (${largestStep})`);
        controller.update(ANIMATION_FADE_SECONDS.finiteToLoop);
        assert.ok(near(hips.position.y, 1.2), 'the loop owns the pose after the soft promotion');
      } finally {
        controller.dispose();
      }
    }
  });

  it('blends a partial-body overlay over the pose without touching other joints, the active action or loop phase', () => {
    const flinch = new THREE.AnimationClip('flinch', 1, [new THREE.VectorKeyframeTrack('arm.position', [0, 1], [2, 0, 0, 2, 0, 0])]);
    const clips = [poseClip('idle', 1, 0.5), flinch];
    const { rootObj, hips, arm, manifest } = transitionRig(clips);
    const controller = new AnimationController(rootObj, clips, manifest);
    try {
      controller.play('idle', 'idle', undefined, 0.5);
      const phase = controller.activeTime;
      controller.setOverlay('flinch', 0.4, 0.5);
      controller.play('idle', 'idle', undefined, 0.5);
      assert.ok(near(arm.position.x, 0.5 + (2 - 0.5) * 0.5), 'the overlay claims exactly its share of the joints it animates');
      assert.ok(near(hips.position.y, 1), 'untouched joints keep the authored pose (no pull toward the bind pose)');
      assert.equal(controller.activeActionId, 'idle');
      assert.equal(controller.activeTime, phase);
      controller.setOverlay('flinch', 0.5, 0.8);
      controller.update(0.1);
      assert.ok(near(arm.position.x, 0.5 + (2 - 0.5) * 0.8));
      controller.setOverlay(undefined);
      controller.update(0.1);
      assert.ok(near(arm.position.x, 0.5) && near(hips.position.y, 1));
      assert.equal(controller.mixer.existingAction(clips[1]).isScheduled(), false, 'removing the overlay releases its action');
      // The overlay never replaces a clip that is itself the active action.
      controller.play('flinch', 'active', 0.5, 0.6);
      controller.setOverlay('flinch', 0.5, 0.5);
      controller.update(0.5);
      assert.ok(near(arm.position.x, 2));
    } finally {
      controller.dispose();
    }
  });
});

describe('Tripo combat clips retargeted onto Aren', async () => {
  const { CLIP_SPECS, retargetAren, syncManifest } = await import('../../scripts/assets/retarget-aren-tripo-clips.mjs');
  const manifest = JSON.parse(await readFile(`${root}/asset-source/playtests/greenwake.json`, 'utf8')).find((entry) => entry.id === 'actor-aren');
  const report = JSON.parse(await readFile(`${root}/asset-source/generated/actor-aren-user-supplied-01/retarget-report.json`, 'utf8'));
  const bytes = await readFile(`${root}${manifest.runtimeUrl}`);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await new GLTFLoader().register(() => ({ name: 'pose-only-material', loadMaterial: () => Promise.resolve(new THREE.MeshBasicMaterial()) })).parseAsync(buffer, '');
  after(() => gltf.scene.traverse((node) => {
    if (!node.isMesh) return;
    node.geometry.dispose();
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) material.dispose();
  }));
  const FPS = 30, GROUNDED = report.clips.filter((clip) => !CLIP_SPECS.find((spec) => spec.clip === clip.action).airborne).map((clip) => clip.action);
  const bones = []; gltf.scene.traverse((node) => { if (node.isBone) bones.push(node); });
  const rest = new Map(bones.map((bone) => [bone, { position: bone.position.clone(), quaternion: bone.quaternion.clone(), scale: bone.scale.clone() }]));
  const mixer = new THREE.AnimationMixer(gltf.scene);
  const named = (name) => gltf.scene.getObjectByName(`mixamorig${name}`);
  const point = (name, out = new THREE.Vector3()) => named(name).getWorldPosition(out);
  const clipOf = (action) => gltf.animations.find((clip) => clip.name === manifest.actionToClipMapping[action]);
  /** Visits every 30 fps frame of the retargeted clip with all bones posed and world matrices current. */
  function eachFrame(action, visit) {
    const clip = clipOf(action);
    mixer.stopAllAction();
    for (const [bone, state] of rest) { bone.position.copy(state.position); bone.quaternion.copy(state.quaternion); bone.scale.copy(state.scale); }
    const running = mixer.clipAction(clip).play();
    running.paused = true;
    const frames = Math.round(clip.duration * FPS);
    for (let frame = 0; frame <= frames; frame++) {
      running.time = Math.min(clip.duration, frame / FPS);
      mixer.update(0);
      gltf.scene.updateMatrixWorld(true);
      visit(frame, frame / FPS);
    }
    mixer.stopAllAction();
  }
  const restLengths = new Map();
  gltf.scene.updateMatrixWorld(true);
  for (const bone of bones) if (bone.parent?.isBone) restLengths.set(bone, bone.getWorldPosition(new THREE.Vector3()).distanceTo(bone.parent.getWorldPosition(new THREE.Vector3())));
  const restFootY = Math.min(point('LeftFoot').y, point('RightFoot').y);

  it('loads in Node and keeps every earlier clip next to the retargeted ones, the second-jump clip included', () => {
    assert.ok(report.clips.some((clip) => clip.action === 'aren-air-step'));
    assert.equal(gltf.animations.length, 9 + report.clips.length);
    for (const original of ['idle.001', 'cheer.001', 'defeat_03.001', 'walk.001', 'run.001', 'One long jump.001', 'dive.001', 'warm_up.001', '1 High and long jump with a cross-kick..001']) assert.ok(gltf.animations.some((clip) => clip.name === original), original);
    for (const { action } of report.clips) assert.equal(manifest.actionToClipMapping[action], action);
    for (const clip of report.clips) {
      const tracks = clipOf(clip.action).tracks;
      assert.equal(tracks.length, clip.channels, `${clip.action} track count matches the report`);
      for (const track of tracks) assert.ok(track.values.every(Number.isFinite), `${clip.action}.${track.name} has non-finite samples`);
    }
  });

  it('keeps the skeleton rigid: no NaN, every parent-child bone length preserved in every frame', () => {
    for (const { action } of report.clips) {
      eachFrame(action, (frame) => {
        for (const bone of bones) {
          const matrix = bone.matrixWorld.elements;
          assert.ok(matrix.every(Number.isFinite), `${action}@${frame}: ${bone.name} has a non-finite matrix`);
          const rest = restLengths.get(bone);
          if (rest !== undefined) assert.ok(Math.abs(bone.getWorldPosition(new THREE.Vector3()).distanceTo(bone.parent.getWorldPosition(new THREE.Vector3())) - rest) < 1e-4, `${action}@${frame}: ${bone.name} changed length`);
        }
      });
    }
  });

  it('keeps the feet on the ground plane in grounded clips and the body above it', () => {
    for (const action of GROUNDED) {
      let lowest = Infinity;
      eachFrame(action, () => {
        lowest = Math.min(lowest, point('LeftFoot').y, point('RightFoot').y);
        assert.ok(point('Hips').y > 0.18 && point('Head').y > 0.2, `${action}: torso collapsed into the ground`);
      });
      if (action === 'aren-hit') continue;
      assert.ok(lowest > restFootY - 0.05 && lowest < restFootY + 0.03, `${action}: lowest foot ${lowest} should rest on the ground plane ${restFootY} (crouches may sink the ankles up to 5 cm)`);
    }
  });

  it('raises the right hand above the hips before the overhead chops strike and brings it down through the hit', () => {
    for (const action of ['aren-heavy']) {
      const entry = report.clips.find((clip) => clip.action === action);
      let windup = -Infinity, atContact = Infinity;
      eachFrame(action, (_, time) => {
        const relative = point('RightHand').y - point('Hips').y;
        if (time < entry.contact.outputSeconds - 0.02) windup = Math.max(windup, relative);
        if (Math.abs(time - entry.contact.outputSeconds) <= 0.5 / FPS) atContact = relative;
      });
      assert.ok(windup > 0.25, `${action}: right hand must rise above the hips in the wind-up (${windup})`);
      assert.ok(windup - atContact > 0.15, `${action}: the strike must bring the hand down through the hit (${windup} -> ${atContact})`);
    }
  });

  /** Hips-relative right-hand speed (rig units/s) and glaive direction at every 30 fps frame; ticks are 60 Hz simulation ticks. */
  const { computeHandGrip } = await vite.ssrLoadModule('/src/rendering/NativeHandGrip.ts');
  const { WARDEN_GRIP } = await vite.ssrLoadModule('/src/rendering/WardenWeapon.ts');
  const gripAxis = computeHandGrip(gltf.scene, false, WARDEN_GRIP.tiltRadians).axis;
  function trace(action) {
    const frames = [], hips = new THREE.Vector3(), quaternion = new THREE.Quaternion(), direction = new THREE.Vector3();
    let previous;
    eachFrame(action, (frame) => {
      const hand = point('RightHand').sub(point('Hips', hips)), d = direction.copy(gripAxis).applyQuaternion(named('RightHand').getWorldQuaternion(quaternion));
      frames.push({ tick: frame * 2, yaw: Math.atan2(d.x, d.z) * 180 / Math.PI, pitch: Math.asin(d.y) * 180 / Math.PI, hand: hand.clone(), speed: previous ? hand.distanceTo(previous) * FPS : 0 });
      previous = hand.clone();
    });
    return frames;
  }
  const strikeTick = (frames) => { const best = frames.reduce((a, b) => (b.speed > a.speed ? b : a)); return best.tick - 1; };
  /** Frame nearest to a 60 Hz tick (clips are sampled at 30 fps; half-ticks round up like the report does). */
  const at = (frames, tick) => frames[Math.min(frames.length - 1, Math.round(tick / 2))];

  it('lands the strike frame on the simulation hit tick for every timed action', () => {
    const timed = CLIP_SPECS.filter((spec) => spec.sim);
    const struck = timed.filter((spec) => spec.exact && spec.sim.activeTick !== undefined);
    assert.deepEqual(struck.map((spec) => spec.clip).sort(), ['aren-charged-heavy', 'aren-cleanse', 'aren-heavy', 'aren-light-1', 'aren-light-2', 'aren-light-3', 'aren-light-4', 'aren-root-tether', 'aren-sigil-bolt']);
    /** Tick of the fastest hips-relative right-hand motion up to three ticks past the hit tick. */
    const peakTick = (spec) => {
      let previous, best = { speed: -1, tick: 0 };
      const hips = new THREE.Vector3(), hand = new THREE.Vector3();
      eachFrame(spec.clip, (frame) => {
        point('Hips', hips);
        point('RightHand', hand).sub(hips);
        if (previous && (frame - 0.5) * 2 <= spec.sim.activeTick + 3) {
          const speed = hand.distanceTo(previous) * FPS;
          if (speed > best.speed) best = { speed, tick: (frame - 0.5) * 2 };
        }
        previous = hand.clone();
      });
      return best.tick;
    };
    for (const spec of timed) {
      const entry = report.clips.find((clip) => clip.action === spec.clip);
      const totalTicks = spec.sim.totalTicks ?? spec.sim.lockTicks + spec.sim.recoveryTicks;
      assert.ok(Math.abs(entry.outputDurationSeconds * 60 - totalTicks) <= 2, `${spec.clip}: the clip spans the simulated action (${entry.outputDurationSeconds}s)`);
      if (!spec.exact || spec.sim.activeTick === undefined) continue;
      const expected = spec.sim.activeTick / totalTicks;
      assert.ok(Math.abs(entry.contact.outputNormalizedTime - expected) < 1e-4, `${spec.clip}: contact at ${entry.contact.outputNormalizedTime}, hit window opens at ${expected}`);
      // Independent measurement on the shipped GLB: the fastest hand motion precedes the hit tick by at most `settle` and never trails it by more than a frame.
      const lead = (spec.sim.activeTick - peakTick(spec)) / 60;
      assert.ok(lead > -1.5 / 60 && lead < 0.2, `${spec.clip}: peak hand speed ${lead.toFixed(3)}s before the hit tick`);
      // Between 0.5× and 4.5× of the captured speed: the time warp never freezes or blurs the take.
      assert.ok(entry.playbackSpeedBeforeAfterContact.every((speed) => speed >= 0.5 && speed <= 4.5), `${spec.clip}: source speed-up stays natural (${entry.playbackSpeedBeforeAfterContact})`);
    }
  });

  it('puts the fastest right-hand motion of each Warden Blade swing within 1.5 ticks of the contract active start', () => {
    const activeStart = { 'aren-light-1': 9, 'aren-light-2': 10, 'aren-light-3': 10, 'aren-light-4': 15 };
    for (const [action, tick] of Object.entries(activeStart)) {
      const frames = trace(action), strike = strikeTick(frames);
      assert.ok(Math.abs(strike - tick) <= 1.5, `${action}: fastest right-hand motion at tick ${strike}, active window opens at ${tick}`);
      assert.equal(frames.at(-1).tick, { 'aren-light-1': 26, 'aren-light-2': 28, 'aren-light-3': 34, 'aren-light-4': 40 }[action], `${action}: the clip spans the contract action`);
    }
  });

  it('gives each Warden Blade step its own swing: the hand travels through the active window along four distinct paths', () => {
    const path = (action) => { const frames = trace(action), strike = strikeTick(frames); return [-4, -2, 0, 2, 4].map((offset) => at(frames, strike + offset).hand); };
    const names = ['aren-light-1', 'aren-light-2', 'aren-light-3', 'aren-light-4'], paths = names.map(path);
    for (const [index, points] of paths.entries()) {
      const travelled = points[0].distanceTo(points.at(-1));
      assert.ok(travelled > 0.25, `${names[index]} sweeps the hand through the hit (${travelled.toFixed(2)})`);
    }
    for (let a = 0; a < 4; a += 1) for (let b = a + 1; b < 4; b += 1) {
      const apart = paths[a].reduce((sum, point, i) => sum + point.distanceTo(paths[b][i]), 0) / 5;
      assert.ok(apart > 0.12, `${names[a]} and ${names[b]} follow distinct paths (${apart.toFixed(2)})`);
    }
  });

  it('plays every exact Mixamo take unchanged: each output key equals the raw FBX local at its warped source time (≤ 0.1°), the ledger matches the files, loops close, the hit key sits on the simulation tick', { timeout: 180_000 }, async () => {
    const { Rig, readClipFrames } = await import('../../scripts/assets/retarget-aren-tripo-clips.mjs');
    const { parseGlb } = await import('../../scripts/assets/import-aren-animation-set.mjs');
    const { createMixamoExact, AREN_EXACT } = await import('../../scripts/assets/mixamo-exact.mjs');
    const EXACT = ['aren-idle', 'aren-light-1', 'aren-light-2', 'aren-light-3', 'aren-light-4', 'aren-heavy', 'aren-charged-heavy-charge', 'aren-charged-heavy', 'aren-sigil-charge', 'aren-sigil-bolt', 'aren-sigil-barrage', 'aren-root-tether', 'aren-cleanse', 'aren-judgement'];
    const LOOPS = ['aren-idle', 'aren-charged-heavy-charge', 'aren-sigil-charge'];
    const DEG = 180 / Math.PI;
    const angle = (a, b) => { const r = a.clone().invert().multiply(b); return 2 * Math.atan2(Math.hypot(r.x, r.y, r.z), Math.abs(r.w)) * DEG; };
    /** Source seconds of output key `k` (30 Hz): piecewise linear through the report's [tick, seconds] keys (loops: their whole take at real time), clamped. */
    const sourceTime = (entry, k) => {
      const keys = entry.tickToSourceSeconds ?? [[0, entry.sourceWindowSeconds[0]], [(entry.sourceWindowSeconds[1] - entry.sourceWindowSeconds[0]) * 60, entry.sourceWindowSeconds[1]]], tick = k * 2;
      if (tick <= keys[0][0]) return keys[0][1];
      if (tick >= keys.at(-1)[0]) return keys.at(-1)[1];
      const i = keys.findIndex((key, j) => j < keys.length - 1 && tick <= keys[j + 1][0]);
      return keys[i][1] + (keys[i + 1][1] - keys[i][1]) * ((tick - keys[i][0]) / (keys[i + 1][0] - keys[i][0]));
    };
    const ledger = JSON.parse(await readFile(`${root}/asset-source/mixamo/aren-skills/provenance.json`, 'utf8'));
    assert.equal(ledger.files.length, EXACT.length);
    assert.deepEqual(report.clips.filter((clip) => clip.exact).map((clip) => clip.action).sort(), [...EXACT].sort());
    const rig = new Rig(parseGlb(bytes));
    const exact = await createMixamoExact({ root, rig, ...AREN_EXACT });
    assert.ok(exact.restCheck.maxDegrees <= exact.restCheck.toleranceDegrees, `the take skeleton matches the rig's joint frames within ${exact.restCheck.toleranceDegrees}° (${exact.restCheck.maxDegrees}°)`);
    const a = new THREE.Quaternion(), b = new THREE.Quaternion(), hips = rig.index.get('mixamorig:Hips');
    for (const name of EXACT) {
      const entry = report.clips.find((clip) => clip.action === name), file = ledger.files.find((item) => item.clip === name);
      assert.ok(file, `${name} is in the Mixamo ledger`);
      const path = `asset-source/mixamo/aren-skills/${file.file}`, raw = await readFile(`${root}/${path}`);
      assert.equal(createHash('sha256').update(raw).digest('hex'), file.sha256, `${name}: ledger sha256 of ${file.file}`);
      assert.equal(raw.length, file.bytes, `${name}: ledger bytes of ${file.file}`);
      assert.equal(entry.exact.file, path);
      assert.equal(entry.exact.sha256, file.sha256);
      assert.equal(entry.source.mixamoFile, path);
      assert.equal(entry.source.exact, true);
      assert.equal(manifest.actionToClipMapping[name], name, `${name} plays its own authored clip`);

      const take = await exact.load(path), { frames, count } = readClipFrames(rig, name);
      assert.equal(count, entry.outputFrames);
      assert.equal(entry.exact.exactness.keys, count);
      if (entry.simulation) assert.equal(count, Math.round(entry.simulation.totalTicks / 2) + 1, `${name}: one key per 30 Hz frame of the simulated action`);
      let worst = 0;
      for (let k = 0; k < count; k += 1) for (const node of rig.joints) worst = Math.max(worst, angle(a.fromArray(frames.rotations[node], k * 4).normalize(), take.localAt(node, sourceTime(entry, k), b)));
      assert.ok(worst <= 0.1, `${name}: ${worst.toFixed(4)}° from the Mixamo take`);
      assert.ok(entry.exact.exactness.maxDegrees <= 0.1, `${name}: reported exactness`);
      const track = frames.positions[hips];
      for (let k = 1; k < count; k += 1) assert.ok(Math.abs(track[k * 3] - track[0]) < 1e-9 && Math.abs(track[k * 3 + 2] - track[2]) < 1e-9, `${name}: Hips horizontal pinned (the simulation moves Aren)`);

      if (LOOPS.includes(name)) {
        assert.ok(entry.loop, `${name} is reported as a loop`);
        let seam = 0;
        for (const node of rig.joints) seam = Math.max(seam, angle(a.fromArray(frames.rotations[node], 0).normalize(), b.fromArray(frames.rotations[node], (count - 1) * 4).normalize()));
        assert.ok(seam <= 1, `${name}: loop seam ${seam.toFixed(3)}°`);
        assert.ok(entry.exact.loopSeamDegrees <= 1, `${name}: reported loop seam ${entry.exact.loopSeamDegrees}°`);
      }
      if (entry.simulation?.activeTick !== undefined) {
        const { activeTick, totalTicks } = entry.simulation, hit = entry.tickToSourceSeconds.find(([tick]) => tick === activeTick);
        assert.ok(hit, `${name}: the warp has a key on the hit tick ${activeTick}`);
        assert.ok(Math.abs(entry.contact.sourceSeconds - hit[1]) < 1e-9, `${name}: the contact is the take's pose at the hit key`);
        assert.ok(Math.abs(entry.contact.outputNormalizedTime - activeTick / totalTicks) < 1e-4, `${name}: contact at ${entry.contact.outputNormalizedTime}, hit window opens at ${activeTick / totalTicks}`);
      }
    }
  });

  it('plays Back Handspring as a backward somersault and the hit reaction on the upper body only', () => {
    let pitch = 0, previous, total = 0;
    eachFrame('aren-back-handspring', () => {
      const hips = point('Hips'), head = point('Head');
      const angle = Math.atan2(head.z - hips.z, head.y - hips.y);
      if (previous !== undefined) { let step = angle - previous; while (step > Math.PI) step -= 2 * Math.PI; while (step < -Math.PI) step += 2 * Math.PI; total += step; }
      previous = angle; pitch = angle;
    });
    assert.ok(total < -5 && total > -7.2, `the head must travel backwards through a full somersault (${total} rad)`);
    for (const track of clipOf('aren-hit').tracks) assert.ok(/mixamorig(Spine\d?|Neck|Head|(Left|Right)(Shoulder|Arm|ForeArm|Hand))\./.test(track.name), `${track.name} must not touch legs, hips or fingers`);
    assert.ok(Math.abs(report.clips.find((clip) => clip.action === 'aren-hit').outputDurationSeconds - 0.35) < 0.04, 'the hit clip fits the 0.35 s overlay envelope');
    void pitch;
  });

  it('is accepted by the controller and manifest for every new action, consuming hips travel but not vertical motion', () => {
    const controller = new AnimationController(gltf.scene, gltf.animations, manifest);
    const hips = named('Hips'), bind = rest.get(hips).position;
    try {
      for (const { action } of report.clips) {
        for (const progress of [0, 0.27, 0.5, 1]) {
          controller.play(action, 'active', progress, undefined, 1);
          controller.update(0.2);
          assert.equal(controller.activeActionId, action);
          assert.ok(near(controller.activeTime, clipOf(action).duration * progress, 1e-5));
          if (manifest.rootMotion[action].mode === 'in-place') continue;
          assert.equal(hips.position.x, bind.x, `${action}: horizontal hips travel is consumed`);
          assert.equal(hips.position.z, bind.z);
          assert.ok(Number.isFinite(hips.position.y));
        }
      }
      assert.equal(controller.issues.length, 0);
    } finally {
      controller.dispose();
    }
  });

  it('rebuilds byte-identically from the committed sources', async () => {
    const rebuilt = await retargetAren();
    assert.equal(createHash('sha256').update(rebuilt.bytes).digest('hex'), manifest.outputHash);
    assert.ok(Buffer.from(rebuilt.bytes).equals(bytes), 'aren-playtest-animated.glb must equal the script output');
  });

  it('maps every Sprint 1.5 action to a clip built for it', () => {
    for (const action of ['aren-light-1', 'aren-light-2', 'aren-light-3', 'aren-light-4', 'aren-sigil-bolt', 'aren-sigil-charge', 'aren-sigil-barrage', 'aren-judgement', 'aren-air-step']) {
      assert.equal(manifest.actionToClipMapping[action], action);
      assert.ok(report.clips.some((clip) => clip.action === action), action);
    }
  });
});

describe('ActorAnimationDriver', async () => {
  const { driveActorAnimation, HIT_OVERLAY_SECONDS } = await vite.ssrLoadModule('/src/rendering/ActorAnimationDriver.ts');
  const instance = (assetId = 'actor-aren', actions = ['aren-hit']) => {
    const calls = [];
    return { assetId, calls, animation: { hasAction: (id) => actions.includes(id), play: (...args) => calls.push(['play', ...args]), setOverlay: (...args) => calls.push(['overlay', ...args]), setBlendSeconds: () => {} } };
  };
  // Aren's ActorSnapshot never carries her damage: the renderer passes CombatSnapshot.player.vitality through the context.
  const actor = (patch) => ({ id: 'aren', allegiance: 'player', velocity: { x: 0, y: 0, z: 0 }, actionId: 'aren-idle', phase: 'idle', normalizedTime: 0, vitality: 100, downed: false, ...patch });
  const context = (clock, vitality = undefined, manifest = undefined) => ({ interpolate: false, alpha: 1, loopTimeSeconds: clock, manifest, vitality });

  it('keeps world-speed cadence on a rotated root instead of treating parent-local Y travel as vertical', () => {
    const rootObj = new THREE.Group(), armature = new THREE.Group(), hips = new THREE.Bone();
    armature.rotation.z = Math.PI / 2;
    armature.scale.setScalar(2);
    hips.name = 'hips';
    rootObj.add(armature); armature.add(hips);
    const clip = new THREE.AnimationClip('run', 1, [
      new THREE.VectorKeyframeTrack('hips.position', [0, 1], [0, 0, 0, 1, -2, 0]),
    ]);
    const manifest = {
      id: 'rotated-runner', requiredActionIds: [], actionToClipMapping: { 'aren-run': 'run' },
      coordinateTransform: { scale: 0.5 },
      rootMotion: { 'aren-run': {
        mode: 'native-root-motion', rootNodeName: 'hips', preserveVerticalMotion: true, evidenceStatus: 'verified',
        curveSamples: [{ time: 0, position: { x: 0, y: 0, z: 0 } }, { time: 1, position: { x: 1, y: -2, z: 0 } }],
      } },
      sockets: [],
    };
    const animation = new AnimationController(rootObj, [clip], manifest);
    const view = { assetId: manifest.id, animation };
    try {
      // Root-local -Y becomes forward; local X is only bob. Two authored metres/s
      // at four gameplay metres/s must advance half a cycle in a quarter second.
      for (const clock of [0, 0.25]) {
        driveActorAnimation(view, actor({ actionId: 'aren-run', velocity: { x: 4, y: 0, z: 0 } }), undefined, context(clock, undefined, manifest));
        animation.update(0);
      }
      assert.ok(Math.abs(animation.activeTime - 0.5) < 1e-6, `run phase ${animation.activeTime}`);
      assert.ok(Math.abs(hips.position.x - 0.5) < 1e-6, 'native vertical bob survives at the correctly sampled phase');
      assert.ok(Math.abs(hips.position.y) < 1e-6, 'simulation owns horizontal root travel');
    } finally { animation.dispose(); }
  });

  it('flinches for at most 0.35 s after Aren loses vitality and never gates the action being played', () => {
    const view = instance();
    let clock = 1;
    const frame = (vitality, patch) => { driveActorAnimation(view, actor(patch), undefined, context(clock, vitality)); clock += 1 / 60; };
    for (let i = 0; i < 10; i++) frame(100, { actionId: 'aren-light-1', phase: 'active', normalizedTime: i / 45 });
    assert.equal(view.calls.filter((call) => call[0] === 'overlay').length, 0, 'no damage, no overlay');
    const hitAt = clock;
    const shares = [], progress = [];
    for (let i = 0; i < 40; i++) {
      frame(90, { actionId: 'aren-light-1', phase: 'active', normalizedTime: (10 + i) / 45 });
      const call = view.calls.filter((entry) => entry[0] === 'overlay').at(-1);
      if (call[1] !== undefined) { shares.push(call[3]); progress.push(call[2]); }
    }
    assert.ok(shares.length > 8 && shares.length <= Math.ceil(HIT_OVERLAY_SECONDS * 60) + 1, `overlay lasted ${shares.length} frames`);
    assert.ok(Math.max(...shares) <= 0.6 + 1e-9 && Math.max(...shares) > 0.45, 'strong enough to read, never a full takeover');
    assert.ok(progress.every((value, index) => value >= 0 && value < 1 && (index === 0 || value > progress[index - 1])), 'sampled across the clip once');
    const peak = shares.indexOf(Math.max(...shares));
    assert.ok(shares.slice(peak).every((value, index, list) => index === 0 || value <= list[index - 1] + 1e-9), 'decays monotonically after the peak');
    assert.equal(view.calls.filter((entry) => entry[0] === 'overlay').at(-1)[1], undefined, 'the overlay is removed once the envelope ends');
    assert.equal(hitAt + HIT_OVERLAY_SECONDS <= clock, true);
    const plays = view.calls.filter((entry) => entry[0] === 'play');
    assert.equal(plays.length, 50, 'the action is driven every frame');
    assert.ok(plays.every((entry, index) => entry[1] === 'aren-light-1' && entry[2] === 'active'), 'locomotion and actions are never replaced or blocked');
    // A second hit re-arms it; healing or a missing clip never does.
    frame(80, {});
    assert.equal(view.calls.filter((entry) => entry[0] === 'overlay').at(-1)[1], 'aren-hit');
    const healed = instance();
    driveActorAnimation(healed, actor({}), undefined, context(5, 50));
    driveActorAnimation(healed, actor({}), undefined, context(5.02, 80));
    const bare = instance('actor-aren', []);
    driveActorAnimation(bare, actor({}), undefined, context(5, 50));
    driveActorAnimation(bare, actor({}), undefined, context(5.02, 10));
    assert.equal(healed.calls.filter((entry) => entry[0] === 'overlay').length + bare.calls.filter((entry) => entry[0] === 'overlay').length, 0);
  });

  it('plays the resolved monster clip for non-player actors and keeps snapshot actions otherwise', () => {
    const boar = instance('actor-ember-boar', []);
    driveActorAnimation(boar, actor({ id: 'corrupted-boar', allegiance: 'hostile', velocity: { x: 0, y: 0, z: 3 } }), undefined, context(4));
    assert.equal(boar.calls.length, 1);
    assert.deepEqual(boar.calls[0].slice(0, 3), ['play', 'monster-walk', 'idle']);
    assert.equal(boar.calls[0][4], 4, 'monster loops run on the supplied actor clock');
    assert.ok(boar.calls[0][5] > 0.5 && boar.calls[0][5] <= 2, 'loop rate follows ground speed');
    const staggered = instance('actor-ember-boar', []);
    driveActorAnimation(staggered, actor({ id: 'corrupted-boar', allegiance: 'hostile', actionId: 'corrupted-boar-stagger', phase: 'recovery', normalizedTime: 0.4 }), undefined, context(4));
    assert.deepEqual(staggered.calls[0].slice(0, 4), ['play', 'monster-hurt', 'active', 0.4]);
  });

  it('plays the held Sigil Charge as a loop whatever phase the simulation reports, and its release as a finite action', () => {
    const view = instance('actor-aren', []);
    driveActorAnimation(view, actor({ actionId: 'aren-sigil-charge', phase: 'sustain', normalizedTime: 0.3 }), undefined, context(2));
    assert.deepEqual(view.calls[0].slice(0, 3), ['play', 'aren-sigil-charge', 'idle']);
    driveActorAnimation(view, actor({ actionId: 'aren-sigil-barrage', phase: 'active', normalizedTime: 0.3 }), undefined, context(2.1));
    assert.deepEqual(view.calls[1].slice(0, 4), ['play', 'aren-sigil-barrage', 'active', 0.3]);
  });

  it('hands the jump and dive tail to the locomotion loop early, smoothly and without walk/run flicker', () => {
    for (const actionId of ['aren-jump', 'aren-forward-left-dive-roll']) {
      const view = instance('actor-aren', []);
      const weights = [];
      for (let i = 0; i <= 20; i++) {
        const progress = 0.5 + i / 40;
        driveActorAnimation(view, actor({ actionId, phase: 'recovery', normalizedTime: progress, velocity: { x: 0, y: 0, z: i % 2 ? 5 : 3.9 } }), undefined, context(i / 60));
        weights.push(view.calls.at(-1)[7]);
      }
      assert.equal(weights[0], 0);
      assert.ok(weights.every((value, index) => index === 0 || value >= weights[index - 1] - 1e-9), 'weight never dips while the tail runs out');
      assert.ok(weights[12] > 0.2 && weights[12] < 0.6, `the blend is already running before the last fifth (${weights[12]})`);
      assert.equal(weights.at(-1), 1);
      const recoveries = new Set(view.calls.filter((call) => call[7] > 0).map((call) => call[6]));
      assert.deepEqual([...recoveries], ['aren-run'], 'the gait chosen when the blend began is kept');
    }
    const still = instance('actor-aren', []);
    driveActorAnimation(still, actor({ actionId: 'aren-jump', phase: 'recovery', normalizedTime: 1 }), undefined, context(1));
    assert.deepEqual([still.calls[0][6], still.calls[0][7]], [undefined, 0], 'a standing actor settles into idle through the controller fade');
  });
});
