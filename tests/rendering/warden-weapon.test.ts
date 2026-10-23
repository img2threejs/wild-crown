import { afterAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { AnimationMixer, BoxGeometry, ConeGeometry, CylinderGeometry, Group, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, Quaternion, SkinnedMesh, Triangle, Vector3, type Bone, type Material } from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLAIVE_BLEND_SECONDS, HEARTROOT_GRIP, KATANA_EDGE_COLOR, KATANA_EDGE_TIP_COLOR, KATANA_GRIP, STAFF_BLEND_SECONDS, WARDEN_BLADE_FRACTION, WARDEN_EDGE_COLOR, WARDEN_EDGE_IDLE_INTENSITY, WARDEN_GRIP, WARDEN_GRIP_FRACTION, WARDEN_WEAPON_LENGTH, WardenWeapon, analyzeGlaive, glaiveProfileFor, splitBladeGeometry, staffProfileFor, weaponKindForGrip } from '../../src/rendering/WardenWeapon.js';
import { computeHandGrip, referencedVertices } from '../../src/rendering/NativeHandGrip.js';
import { STAFF_THROW } from '../../src/rendering/ThrownStaff.js';
import { Scene } from 'three';

const root = new URL('../../', import.meta.url).pathname;
const manifest = JSON.parse(readFileSync(`${root}asset-source/playtests/greenwake.json`, 'utf8')) as Array<{ id: string; runtimeUrl: string; actionToClipMapping: Record<string, string> }>;
const entry = (id: string) => manifest.find((candidate) => candidate.id === id)!;

/** Pose-only parse: materials are placeholders (no image decoding), geometry, skeleton and clips are the real file's. */
async function load(path: string, material: () => Material): Promise<GLTF> {
  const bytes = readFileSync(`${root}${path.replace(/^\//, '')}`);
  return new GLTFLoader().register(() => ({ name: 'placeholder-material', loadMaterial: () => Promise.resolve(material()) })).parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
}

const aren = await load(entry('actor-aren').runtimeUrl, () => new MeshBasicMaterial());
const tripoGlaive = await load(entry('prop-warden-glaive').runtimeUrl, () => new MeshStandardMaterial());
afterAll(() => { for (const gltf of [aren, tripoGlaive]) gltf.scene.traverse((node) => { if (node instanceof Mesh) node.geometry.dispose(); }); });

const named = (scene: Object3D, name: string): Bone => scene.getObjectByName(`mixamorig${name}`) as Bone;
const fingerRest: Array<[Bone, Quaternion]> = [];
aren.scene.traverse((node) => { if ('isBone' in node && /mixamorigRightHand(Index|Middle|Ring|Pinky|Thumb)\d/.test(node.name)) fingerRest.push([node as Bone, node.quaternion.clone()]); });
/** The clips of the playtest GLB leave the fingers at their open bind rotations. */
const openHand = (): void => { for (const [bone, rest] of fingerRest) bone.quaternion.copy(rest); aren.scene.updateMatrixWorld(true); };

/** A glaive built in an arbitrary pose: shaft, spike pommel, wide blade with a tip that bends toward its local +y. */
function syntheticGlaive(bladeAtPositive: boolean): { root: Group; length: number } {
  const shaft = new CylinderGeometry(0.03, 0.03, 0.7, 12, 14).rotateX(Math.PI / 2);
  const pommel = new ConeGeometry(0.02, 0.1, 8).rotateX(-Math.PI / 2).translate(0, 0, -0.4);
  const blade = new BoxGeometry(0.02, 0.18, 0.28).translate(0, -0.02, 0.48);
  const tip = new BoxGeometry(0.02, 0.1, 0.06).translate(0, 0.08, 0.64);
  const geometry = mergeGeometries([shaft, pommel, blade, tip].map((part) => part.toNonIndexed()))!;
  if (!bladeAtPositive) geometry.rotateY(Math.PI);
  geometry.applyMatrix4(new Matrix4().compose(new Vector3(0.4, -1.3, 2.1), new Quaternion().setFromAxisAngle(new Vector3(0.3, 0.8, -0.5).normalize(), 1.1), new Vector3(1, 1, 1)));
  const group = new Group();
  group.add(new Mesh(geometry, new MeshStandardMaterial({ color: 0x888888 })));
  return { root: group, length: 1.12 };
}

interface Rig { owner: { root: Object3D; animation: { setPostPose(hook: (() => void) | undefined): void } }; hook: () => void; hookCleared: number; glaiveDisposed: number; weapon: WardenWeapon; glaiveRoot: Object3D }

function equip(glaiveRoot: Object3D): Rig {
  const rig = { hook: () => undefined, hookCleared: 0, glaiveDisposed: 0 } as unknown as Rig;
  rig.owner = { root: aren.scene, animation: { setPostPose: (hook) => { if (hook) rig.hook = hook; else rig.hookCleared += 1; } } };
  aren.scene.scale.setScalar(1.7);
  aren.scene.updateMatrixWorld(true);
  rig.glaiveRoot = glaiveRoot;
  rig.weapon = new WardenWeapon({ root: glaiveRoot, dispose: () => { rig.glaiveDisposed += 1; } }, rig.owner);
  return rig;
}

/** Bind rotations of every bone: each pose starts from them, so manual arm turns of one test never leak into the next. */
const bindQuaternions: Array<[Bone, Quaternion]> = [];
aren.scene.traverse((node) => { if ('isBone' in node) bindQuaternions.push([node as Bone, node.quaternion.clone()]); });
/** Poses the clip with a throwaway mixer (never stopped, so nothing is restored behind the measurement). */
function pose(clipName: string, time: number): void {
  for (const [bone, rest] of bindQuaternions) bone.quaternion.copy(rest);
  const action = new AnimationMixer(aren.scene).clipAction(aren.animations.find((clip) => clip.name === clipName)!).play();
  action.paused = true;
  action.time = time;
  action.getMixer().update(0);
  aren.scene.updateMatrixWorld(true);
}


const variants = [
  { name: 'synthetic glaive (blade at +axis)', make: () => syntheticGlaive(true).root },
  { name: 'synthetic glaive (blade at −axis)', make: () => syntheticGlaive(false).root },
  { name: 'Tripo prop-warden-glaive', make: () => tripoGlaive.scene.clone() },
];

describe('glaive analysis', () => {
  for (const flipped of [false, true]) {
    it(`finds the axis, blade end and blade bend of a synthetic glaive built ${flipped ? 'blade-first' : 'pommel-first'} in an arbitrary pose`, () => {
      const { root: group, length } = syntheticGlaive(!flipped);
      const mesh = group.children[0] as Mesh, position = mesh.geometry.getAttribute('position');
      const frame = analyzeGlaive(position.array as Float32Array);
      expect(frame.length).toBeCloseTo(length, 2);
      expect(frame.tip.distanceTo(frame.origin)).toBeGreaterThan(frame.pommel.distanceTo(frame.origin));
      expect(frame.axis.dot(frame.tip.clone().sub(frame.pommel).normalize())).toBeGreaterThan(0.99);
      expect(Math.abs(frame.curl.dot(frame.axis))).toBeLessThan(1e-6);
      // The tip box sits 0.08 above the shaft in the glaive's own +y: the curl points the same way in mesh space.
      const own = new Vector3(0, 1, 0).applyQuaternion(new Quaternion().setFromAxisAngle(new Vector3(0.3, 0.8, -0.5).normalize(), 1.1));
      expect(frame.curl.dot(own)).toBeGreaterThan(0.9);
    });
  }

  it('reads the real Tripo glaive: pommel at +Z, crescent blade at −Z bending toward +Y, about 0.98 units long', () => {
    const position = (tripoGlaive.scene.getObjectByProperty('isMesh', true) as Mesh).geometry.getAttribute('position');
    const frame = analyzeGlaive(position.array as Float32Array);
    expect(frame.axis.z).toBeLessThan(-0.95);
    expect(frame.length).toBeGreaterThan(0.96);
    expect(frame.length).toBeLessThan(1);
    expect(frame.tip.z).toBeLessThan(-0.48);
    expect(frame.curl.y).toBeGreaterThan(0.8);
  });

  it('cuts the blade into its own draw group by the long axis without losing a triangle', () => {
    const source = (tripoGlaive.scene.getObjectByProperty('isMesh', true) as Mesh).geometry;
    const frame = analyzeGlaive(source.getAttribute('position').array as Float32Array);
    const split = splitBladeGeometry(source, frame);
    expect(split.groups).toHaveLength(2);
    expect(split.groups[0]!.count + split.groups[1]!.count).toBe(source.index!.count);
    expect(split.groups[1]!.count / source.index!.count).toBeGreaterThan(0.04);
    expect(split.groups[1]!.count / source.index!.count).toBeLessThan(0.45);
    const position = split.getAttribute('position'), index = split.index!, centroid = new Vector3(), vertex = new Vector3();
    for (const [group, onBlade] of [[split.groups[0]!, false], [split.groups[1]!, true]] as const) {
      for (let i = group.start; i < group.start + group.count; i += 3) {
        centroid.set(0, 0, 0);
        for (let c = 0; c < 3; c += 1) centroid.add(vertex.fromBufferAttribute(position, index.getX(i + c)));
        const t = centroid.divideScalar(3).sub(frame.origin).dot(frame.axis) / frame.length;
        expect(t >= 1 - WARDEN_BLADE_FRACTION - 1e-6).toBe(onBlade);
      }
    }
    split.dispose();
  });
});

describe('Warden weapon on the real Aren skeleton', () => {

  for (const variant of variants) {
    describe(variant.name, () => {
      it('fits the shaft outside the native palm and fingers while preserving full blade-to-pommel length', () => {
        const rig = equip(variant.make());
        try {
          pose('idle.001', 0);
          rig.hook();
          aren.scene.updateMatrixWorld(true);
          const inverse = rig.weapon.root.matrixWorld.clone().invert(), point = new Vector3();
          const mesh = rig.glaiveRoot.getObjectByProperty('isMesh', true) as Mesh;
          const positions = mesh.geometry.getAttribute('position');
          let shaftRadius = 0;
          for (const vertex of referencedVertices(mesh.geometry)) {
            point.fromBufferAttribute(positions, vertex).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse);
            if (Math.abs(point.z) < .075) shaftRadius = Math.max(shaftRadius, Math.hypot(point.x, point.y));
          }
          const skin = aren.scene.getObjectByProperty('isSkinnedMesh', true) as SkinnedMesh;
          const indices = skin.geometry.getAttribute('skinIndex'), weights = skin.geometry.getAttribute('skinWeight');
          let skinRadius = Infinity;
          for (const vertex of referencedVertices(skin.geometry)) {
            let handWeight = 0;
            for (let component = 0; component < 4; component++) if (skin.skeleton.bones[indices.getComponent(vertex, component)]?.name.includes('RightHand')) handWeight += weights.getComponent(vertex, component);
            if (handWeight < .6) continue;
            skin.getVertexPosition(vertex, point).applyMatrix4(skin.matrixWorld).applyMatrix4(inverse);
            if (Math.abs(point.z) < .075) skinRadius = Math.min(skinRadius, Math.hypot(point.x, point.y));
          }
          expect(shaftRadius).toBeGreaterThan(.005);
          expect(skinRadius).toBeGreaterThan(shaftRadius);
          // A close grasp, not a hand floating beside a disconnected weapon.
          expect(skinRadius - shaftRadius).toBeLessThan(.008);
          const tip = rig.weapon.sockets['weapon-tip'].getWorldPosition(new Vector3());
          const pommel = rig.weapon.sockets['weapon-pommel'].getWorldPosition(new Vector3());
          expect(tip.distanceTo(pommel) / WARDEN_WEAPON_LENGTH).toBeGreaterThan(.93);
          expect(tip.distanceTo(pommel) / WARDEN_WEAPON_LENGTH).toBeLessThan(1.05);
        } finally { rig.weapon.dispose(); }
      });

      it('carries the blade forward-up in the idle pose and keeps the sockets rigid in the hand when the arm turns', () => {
        const rig = equip(variant.make());
        try {
          pose('idle.001', 0);
          aren.scene.updateMatrixWorld(true);
          const hand = named(aren.scene, 'RightHand'), toward = (name: 'weapon-tip' | 'weapon-pommel') => rig.weapon.sockets[name].getWorldPosition(new Vector3());
          // The shaft axis (weapon socket +Z) carries forward-up: yaw ≈ 20°, pitch ≈ 30° with the shared grip tilt.
          const blade = new Vector3(0, 0, 1).applyQuaternion(rig.weapon.sockets.weapon.getWorldQuaternion(new Quaternion()));
          expect(blade.z).toBeGreaterThan(0.6);
          expect(blade.y).toBeGreaterThan(0.3);
          expect(blade.y).toBeLessThan(0.7);
          const local = rig.weapon.sockets['weapon-tip'].getWorldPosition(new Vector3()).applyMatrix4(hand.matrixWorld.clone().invert());
          const before = toward('weapon-tip');
          named(aren.scene, 'RightArm').rotation.z += 0.9;
          named(aren.scene, 'RightForeArm').rotation.x -= 0.6;
          aren.scene.updateMatrixWorld(true);
          expect(toward('weapon-tip').distanceTo(before)).toBeGreaterThan(0.2);
          expect(toward('weapon-tip').applyMatrix4(hand.matrixWorld.clone().invert()).distanceTo(local)).toBeLessThan(1e-5);
          expect(rig.weapon.sockets.weapon.getWorldPosition(new Vector3()).distanceTo(hand.getWorldPosition(new Vector3()))).toBeGreaterThan(0.02);
        } finally { pose('idle.001', 0); rig.weapon.dispose(); }
      });

      it('closes the right-hand fingers onto the shaft after every pose without changing a bone length', () => {
        const rig = equip(variant.make());
        try {
          pose('idle.001', 0);
          openHand();
          const bones: Bone[] = [];
          aren.scene.traverse((node) => { if ('isBone' in node && /mixamorigRightHand(Index|Middle|Ring|Pinky|Thumb)\d/.test(node.name)) bones.push(node as Bone); });
          expect(bones).toHaveLength(20);
          const spans = () => bones.map((bone) => bone.getWorldPosition(new Vector3()).distanceTo((bone.parent as Bone).getWorldPosition(new Vector3())));
          const openTips = ['Index', 'Middle', 'Ring', 'Pinky'].map((finger) => named(aren.scene, `RightHand${finger}4`).getWorldPosition(new Vector3()));
          const lengths = spans();
          rig.hook();
          aren.scene.updateMatrixWorld(true);
          spans().forEach((span, i) => expect(Math.abs(span - lengths[i]!)).toBeLessThan(1e-6));
          const shaftPoint = rig.weapon.sockets.weapon.getWorldPosition(new Vector3());
          const shaftAxis = new Vector3(0, 0, 1).applyQuaternion(rig.weapon.sockets.weapon.getWorldQuaternion(new Quaternion()));
          const distanceToShaft = (point: Vector3) => point.clone().sub(shaftPoint).cross(shaftAxis).length();
          ['Index', 'Middle', 'Ring', 'Pinky'].forEach((finger, i) => {
            const tip = named(aren.scene, `RightHand${finger}4`).getWorldPosition(new Vector3());
            expect(distanceToShaft(tip)).toBeLessThan(distanceToShaft(openTips[i]!) * 0.8);
          });
        } finally { rig.weapon.dispose(); }
      });

      it('gives the blade its own emissive cyan material and releases everything on dispose', () => {
        const rig = equip(variant.make());
        const mesh = rig.glaiveRoot.getObjectByProperty('isMesh', true) as Mesh, geometry = mesh.geometry;
        let geometryDisposed = 0;
        geometry.addEventListener('dispose', () => { geometryDisposed += 1; });
        const materials = mesh.material as MeshStandardMaterial[];
        expect(materials).toHaveLength(2);
        expect(materials.filter((material) => material.userData.wcWeaponEdge === true)).toEqual(rig.weapon.edgeMaterials as MeshStandardMaterial[]);
        const edge = rig.weapon.edgeMaterials[0]!;
        expect(edge.emissive.getHex()).toBe(new MeshStandardMaterial({ emissive: WARDEN_EDGE_COLOR }).emissive.getHex());
        expect(edge.emissiveIntensity).toBe(WARDEN_EDGE_IDLE_INTENSITY);
        rig.weapon.setEdgeIntensity(3);
        expect(edge.emissiveIntensity).toBe(3);
        expect(materials[0]!.userData.wcWeaponEdge).toBeUndefined();
        rig.weapon.dispose();
        rig.weapon.dispose();
        expect(rig.weapon.root.parent).toBeNull();
        expect(rig.hookCleared).toBe(1);
        expect(rig.glaiveDisposed).toBe(1);
        expect(geometryDisposed).toBe(1);
      });
    });
  }
});

describe('Warden glaive per-clip profile on the real Aren skeleton', () => {
  const degrees = (angle: number) => angle * 180 / Math.PI;
  const tipZ = (weapon: WardenWeapon): number => { aren.scene.updateMatrixWorld(true); return weapon.root.worldToLocal(weapon.sockets['weapon-tip'].getWorldPosition(new Vector3())).z; };
  const worldAxis = (weapon: WardenWeapon): Vector3 => new Vector3(0, 0, 1).applyQuaternion(weapon.root.getWorldQuaternion(new Quaternion()));

  it('default profile is the former fixed placement: turn −WARDEN_GRIP.tiltRadians (≈ −28.648°) and the pommel share WARDEN_GRIP_FRACTION', () => {
    const fallback = glaiveProfileFor('a-clip-the-table-does-not-list');
    expect(fallback.turn).toBeCloseTo(-WARDEN_GRIP.tiltRadians, 12);
    expect(fallback.grip).toBe(WARDEN_GRIP_FRACTION);
    expect(degrees(fallback.turn)).toBeCloseTo(-28.64788975654116, 9);
  });

  it('places the glaive and closes the fingers exactly as the pre-profile fixed tilt did (≤ 1e-6)', () => {
    aren.scene.scale.setScalar(1.7);
    aren.scene.updateMatrixWorld(true);
    openHand();
    // Pre-change construction: the fist tilted WARDEN_GRIP.tiltRadians at build, the weapon frame from that axis and curl, grip point at the origin.
    const old = computeHandGrip(aren.scene, false, WARDEN_GRIP.tiltRadians);
    const y = old.curl.clone().addScaledVector(old.axis, -old.curl.dot(old.axis)).normalize();
    const expected = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(new Vector3().crossVectors(y, old.axis), y, old.axis));
    const oldFingers = old.joints.map((joint) => [joint.bone, joint.grip.clone()] as const);

    const rig = equip(tripoGlaive.scene.clone());
    try {
      const tipBefore = rig.weapon.sockets['weapon-tip'].position.clone(), baseBefore = rig.weapon.sockets['weapon-base'].position.clone();
      const glaiveBefore = rig.glaiveRoot.position.clone();
      rig.weapon.setClip('aren-walk', 0); // a clip the profile table does not list: the default placement
      expect(rig.weapon.root.position.distanceTo(old.palm)).toBeLessThan(1e-6);
      expect(rig.weapon.root.quaternion.angleTo(expected)).toBeLessThan(1e-6);
      expect(rig.weapon.sockets['weapon-tip'].position.distanceTo(tipBefore)).toBeLessThan(1e-6);
      expect(rig.weapon.sockets['weapon-base'].position.distanceTo(baseBefore)).toBeLessThan(1e-6);
      expect(rig.glaiveRoot.position.distanceTo(glaiveBefore)).toBeLessThan(1e-6);
      // The turned axis of the weapon frame is the old tilted axis.
      expect(new Vector3(0, 0, 1).applyQuaternion(rig.weapon.root.quaternion).distanceTo(old.axis)).toBeLessThan(1e-6);
      rig.hook();
      for (const [bone, grip] of oldFingers) expect(bone.quaternion.angleTo(grip), bone.name).toBeLessThan(1e-6);
    } finally { rig.weapon.dispose(); openHand(); }
  });

  it('moves the glaive, its tip socket and the fingers to a clip entry of the table, eased over the blend time', () => {
    const entry = { turnDegrees: 20, gripFraction: 0.2 };
    const profiles = { default: { turnDegrees: degrees(-WARDEN_GRIP.tiltRadians), gripFraction: WARDEN_GRIP_FRACTION }, blendSeconds: GLAIVE_BLEND_SECONDS, clips: { 'aren-test-clip': entry } };
    aren.scene.scale.setScalar(1.7);
    aren.scene.updateMatrixWorld(true);
    openHand();
    const rig = { hook: () => undefined as void, hookCleared: 0 } as { hook: () => void; hookCleared: number };
    const weapon = new WardenWeapon({ root: tripoGlaive.scene.clone(), dispose: () => undefined }, { root: aren.scene, animation: { setPostPose: (hook) => { if (hook) rig.hook = hook; } } }, 'warden', false, profiles);
    try {
      weapon.setClip('aren-idle', 0);
      const idleTip = tipZ(weapon), idleAxis = worldAxis(weapon);
      rig.hook();
      const fingerOf = () => named(aren.scene, 'RightHandIndex2').quaternion.clone();
      const idleFinger = fingerOf();
      weapon.setClip('aren-test-clip', GLAIVE_BLEND_SECONDS / 2);
      const slide = (WARDEN_GRIP_FRACTION - entry.gripFraction) * WARDEN_WEAPON_LENGTH;
      expect(tipZ(weapon)).toBeGreaterThan(idleTip + slide * 0.2);
      expect(tipZ(weapon)).toBeLessThan(idleTip + slide * 0.8);
      weapon.setClip('aren-test-clip', GLAIVE_BLEND_SECONDS);
      expect(tipZ(weapon)).toBeCloseTo(idleTip + slide, 4);
      expect(degrees(worldAxis(weapon).angleTo(idleAxis))).toBeCloseTo(entry.turnDegrees - profiles.default.turnDegrees, 2);
      rig.hook();
      expect(fingerOf().angleTo(idleFinger)).toBeGreaterThan(1e-3);
      // Back to a clip the table does not list: the default placement returns.
      weapon.setClip('aren-idle', 1);
      expect(tipZ(weapon)).toBeCloseTo(idleTip, 4);
    } finally { weapon.dispose(); openHand(); }
  });
});


/**
 * Yara's staff fist. Her Mixamo rig has finger chains, so the staff is gripped like the glaive: the shaft lies along the knuckle line and the fingers close
 * onto it after every pose (a post-pose hook), the wrist itself is never twisted.
 */
const yara = await load(entry('actor-yara-hero').runtimeUrl, () => new MeshBasicMaterial());
const heartrootStaff = await load(entry('prop-heartroot-focus-staff').runtimeUrl, () => new MeshStandardMaterial());
afterAll(() => { for (const gltf of [yara, heartrootStaff]) gltf.scene.traverse((node) => { if (node instanceof Mesh) node.geometry.dispose(); }); });

const yaraBind: Array<[Bone, Quaternion]> = [];
yara.scene.traverse((node) => { if ('isBone' in node) yaraBind.push([node as Bone, node.quaternion.clone()]); });
function poseYara(clipName: string, time: number): void {
  for (const [bone, rest] of yaraBind) bone.quaternion.copy(rest);
  const action = new AnimationMixer(yara.scene).clipAction(yara.animations.find((clip) => clip.name === clipName)!).play();
  action.paused = true;
  action.time = time;
  action.getMixer().update(0);
  yara.scene.updateMatrixWorld(true);
}
const yaraSkin = yara.scene.getObjectByProperty('isSkinnedMesh', true) as SkinnedMesh;
const yaraHand = yara.scene.getObjectByName('mixamorigRightHand') as Bone;
yara.scene.scale.setScalar(1.7);
yara.scene.updateMatrixWorld(true);
const originalHandGeometry = yaraSkin.geometry;
// WardenWeapon's heartroot profile is the finger-chain fist (rigidFist false).
const bindGrip = computeHandGrip(yara.scene, false, HEARTROOT_GRIP.diagonalRadians);
const WORLD_UP = new Vector3(0, 1, 0);

interface YaraRig { weapon: WardenWeapon; hook: () => void; cleared: number }
function equipYara(): YaraRig {
  const rig = { hook: () => undefined, cleared: 0 } as YaraRig;
  rig.weapon = new WardenWeapon({ root: heartrootStaff.scene.clone(), dispose: () => undefined }, { root: yara.scene, animation: { setPostPose: (hook) => { if (hook) rig.hook = hook; else rig.cleared += 1; } } }, 'heartroot');
  return rig;
}
const radians = (angle: number) => angle * 180 / Math.PI;
const staffTilt = (rig: YaraRig) => radians(new Vector3(0, 0, 1).applyQuaternion(rig.weapon.sockets.weapon.getWorldQuaternion(new Quaternion())).angleTo(WORLD_UP));
const yaraNamed = (name: string) => yara.scene.getObjectByName(`mixamorig${name}`) as Bone;

describe('Heartroot staff in Yara\'s fist', () => {
  it('lays the shaft along the knuckle line, thumb end toward the staff head', () => {
    const local = (name: string) => yaraNamed(name).getWorldPosition(new Vector3()).applyMatrix4(yaraHand.matrixWorld.clone().invert());
    poseYara('aren-idle', 0);
    const knuckles = local('RightHandIndex1').sub(local('RightHandPinky1')).normalize();
    expect(radians(bindGrip.axis.angleTo(knuckles))).toBeLessThan(1);
    expect(bindGrip.joints.length).toBeGreaterThan(0);
  });

  it('closes the fingers onto the shaft after every pose without moving the wrist or changing a bone length, and releases the hook on dispose', () => {
    const rig = equipYara();
    try {
      poseYara('yara-sap-lance', .2);
      const native = yaraHand.quaternion.clone();
      const bones: Bone[] = [];
      yara.scene.traverse((node) => { if ('isBone' in node && /mixamorigRightHand(Index|Middle|Ring|Pinky|Thumb)\d/.test(node.name)) bones.push(node as Bone); });
      // Open the hand (the take's fingers already curl) so the closure is measured from a flat hand.
      for (const bone of bones) bone.quaternion.copy(yaraBind.find(([candidate]) => candidate === bone)![1]);
      yara.scene.updateMatrixWorld(true);
      const spans = () => bones.map((bone) => bone.getWorldPosition(new Vector3()).distanceTo((bone.parent as Bone).getWorldPosition(new Vector3())));
      const openTips = ['Index', 'Middle', 'Ring', 'Pinky'].map((finger) => yaraNamed(`RightHand${finger}4`).getWorldPosition(new Vector3()));
      const lengths = spans();
      rig.hook();
      yara.scene.updateMatrixWorld(true);
      expect(yaraHand.quaternion.toArray()).toEqual(native.toArray());
      spans().forEach((span, i) => expect(Math.abs(span - lengths[i]!)).toBeLessThan(1e-5));
      const shaftPoint = rig.weapon.sockets.weapon.getWorldPosition(new Vector3());
      const shaftAxis = new Vector3(0, 0, 1).applyQuaternion(rig.weapon.sockets.weapon.getWorldQuaternion(new Quaternion()));
      const distanceToShaft = (point: Vector3) => point.clone().sub(shaftPoint).cross(shaftAxis).length();
      ['Index', 'Middle', 'Ring', 'Pinky'].forEach((finger, i) => {
        expect(distanceToShaft(yaraNamed(`RightHand${finger}4`).getWorldPosition(new Vector3()))).toBeLessThan(distanceToShaft(openTips[i]!) * 0.8);
      });
    } finally { rig.weapon.dispose(); }
    expect(rig.cleared).toBe(1);
  }, 30_000);

  it('keeps the palm outside the shaft and grasps it closely in every sampled pose', () => {
    const rig = equipYara();
    try {
      const mesh = rig.weapon.root.getObjectByProperty('isMesh', true) as Mesh;
      const staffPositions = mesh.geometry.getAttribute('position');
      const inverse = new Matrix4(), point = new Vector3();
      const indices = yaraSkin.geometry.getAttribute('skinIndex'), weights = yaraSkin.geometry.getAttribute('skinWeight');
      const handIndex = yaraSkin.skeleton.bones.indexOf(yaraHand);
      const sampled: Array<[string, number]> = [['aren-idle', 0], ['aren-walk', .3], ['aren-run', .2], ['yara-thornshot-2', .2], ['yara-root-spike', .4], ['yara-sap-lance', .3]];
      for (const [clip, time] of sampled) {
        poseYara(clip, time);
        rig.hook();
        yara.scene.updateMatrixWorld(true);
        inverse.copy(rig.weapon.root.matrixWorld).invert();
        let shaftRadius = 0;
        for (const vertex of referencedVertices(mesh.geometry)) {
          point.fromBufferAttribute(staffPositions, vertex).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse);
          if (Math.abs(point.z) < .075) shaftRadius = Math.max(shaftRadius, Math.hypot(point.x, point.y));
        }
        let palmRadius = Infinity;
        for (const vertex of referencedVertices(yaraSkin.geometry)) {
          let palmWeight = 0;
          for (let component = 0; component < 4; component++) if (indices.getComponent(vertex, component) === handIndex) palmWeight += weights.getComponent(vertex, component);
          if (palmWeight < .6) continue;
          yaraSkin.getVertexPosition(vertex, point).applyMatrix4(yaraSkin.matrixWorld).applyMatrix4(inverse);
          if (Math.abs(point.z) < .075) palmRadius = Math.min(palmRadius, Math.hypot(point.x, point.y));
        }
        expect(shaftRadius).toBeGreaterThan(.005);
        expect(palmRadius, clip).toBeGreaterThan(shaftRadius);
        expect(palmRadius - shaftRadius, clip).toBeLessThan(.012);
      }
    } finally { rig.weapon.dispose(); }
  }, 60_000);

  it('thins the whole shaft evenly, pommel to head: no waist where the fist rests', () => {
    const rig = equipYara();
    try {
      const native = (heartrootStaff.scene.getObjectByProperty('isMesh', true) as Mesh).geometry.getAttribute('position');
      const fitted = (rig.weapon.root.getObjectByProperty('isMesh', true) as Mesh).geometry.getAttribute('position');
      expect(fitted.count).toBe(native.count);
      const frame = analyzeGlaive(native.array as Float32Array);
      const a = new Vector3(), b = new Vector3();
      const radial = (attribute: typeof native, vertex: number, out: Vector3) => {
        out.fromBufferAttribute(attribute, vertex).sub(frame.origin);
        return out.addScaledVector(frame.axis, -out.dot(frame.axis)).length();
      };
      let low = Infinity, high = 0;
      for (let vertex = 0; vertex < native.count; vertex++) {
        const along = a.fromBufferAttribute(native, vertex).sub(frame.origin).dot(frame.axis) / frame.length;
        if (along < .06 || along > .68) continue;
        const before = radial(native, vertex, a);
        if (before < 1e-4) continue;
        const ratio = radial(fitted, vertex, b) / before;
        low = Math.min(low, ratio); high = Math.max(high, ratio);
      }
      // One factor everywhere the fist can sit and between there and the head; the old fit carved a waist (ratio ~0.5 at the grip, 1 elsewhere).
      expect(high).toBeLessThan(1);
      expect(high / low).toBeLessThan(1.02);
    } finally { rig.weapon.dispose(); }
  }, 30_000);

  it('carries the staff near vertical through the walk and run cycles', () => {
    const rig = equipYara();
    try {
      for (const clip of ['aren-walk', 'aren-run']) {
        const duration = yara.animations.find((item) => item.name === clip)!.duration;
        let peak = 0;
        for (let step = 0; step <= 24; step++) { poseYara(clip, duration * step / 24); peak = Math.max(peak, staffTilt(rig)); }
        expect(peak, clip).toBeLessThan(15);
      }
    } finally { rig.weapon.dispose(); }
  }, 30_000);

  it('matches the grip the clip author used', () => {
    const report = JSON.parse(readFileSync(`${root}asset-source/generated/actor-yara-hero-01/anatomy-report.json`, 'utf8')).grip as { staffAxisHand: number[]; palmHand: number[] };
    expect(radians(bindGrip.axis.angleTo(new Vector3(...report.staffAxisHand)))).toBeLessThan(.5);
    expect(bindGrip.palm.distanceTo(new Vector3(...report.palmHand))).toBeLessThan(1e-4);
  });
});

describe('Heartroot staff profiles and Sap Lance throw', () => {
  const L = WARDEN_WEAPON_LENGTH;
  const tipZ = (rig: YaraRig): number => { yara.scene.updateMatrixWorld(true); return rig.weapon.root.worldToLocal(rig.weapon.sockets['weapon-tip'].getWorldPosition(new Vector3())).z; };
  const worldAxis = (object: Object3D): Vector3 => new Vector3(0, 0, 1).applyQuaternion(object.getWorldQuaternion(new Quaternion()));
  const fingers: Bone[] = [];
  yara.scene.traverse((node) => { if ('isBone' in node && /mixamorigRightHand(Index|Middle|Ring|Pinky|Thumb)\d/.test(node.name)) fingers.push(node as Bone); });
  const fingerPose = (): Quaternion[] => fingers.map((bone) => bone.quaternion.clone());
  const fingerDelta = (a: Quaternion[], b: Quaternion[]): number => Math.max(...a.map((q, i) => q.angleTo(b[i]!)));

  it('uses the default profile for clips the table does not list and the table\'s own for the rest', () => {
    expect(staffProfileFor('aren-walk')).toEqual({ turn: 0, grip: 0.42 });
    expect(radians(staffProfileFor('yara-thornshot-2').turn)).toBeCloseTo(-45, 6);
    expect(staffProfileFor('yara-root-spike').grip).toBe(0.12);
  });

  it('eases into the next clip\'s profile over the blend time, moving the staff head and the fingers with it', () => {
    const rig = equipYara();
    try {
      poseYara('aren-idle', 0);
      rig.weapon.setClip('aren-idle', 0);
      const idle = staffProfileFor('aren-idle'), next = staffProfileFor('yara-thornshot-2');
      const idleTip = tipZ(rig), idleAxis = worldAxis(rig.weapon.root);
      rig.hook();
      const idleFingers = fingerPose();
      // Halfway through the blend the staff has slid half of the way along the shaft.
      rig.weapon.setClip('yara-thornshot-2', STAFF_BLEND_SECONDS / 2);
      const slide = (idle.grip - next.grip) * L;
      expect(tipZ(rig)).toBeCloseTo(idleTip + slide / 2, 4);
      // After the blend time it has reached the profile exactly.
      rig.weapon.setClip('yara-thornshot-2', STAFF_BLEND_SECONDS);
      expect(tipZ(rig)).toBeCloseTo(idleTip + slide, 4);
      expect(radians(worldAxis(rig.weapon.root).angleTo(idleAxis))).toBeCloseTo(Math.abs(radians(next.turn - idle.turn)), 2);
      rig.hook();
      expect(fingerDelta(fingerPose(), idleFingers)).toBeGreaterThan(0.01);
      // Staying on the clip leaves it there.
      rig.weapon.setClip('yara-thornshot-2', 1);
      expect(tipZ(rig)).toBeCloseTo(idleTip + slide, 4);
    } finally { rig.weapon.dispose(); }
  }, 30_000);

  it('throws the staff: the held staff hides, the flying one spins flat, and it is back within 0.6 s plus the blend', () => {
    const stage = new Scene();
    stage.add(yara.scene);
    const rig = equipYara();
    try {
      poseYara('yara-sap-lance', 0.3);
      rig.weapon.setClip('yara-sap-lance', 0);
      const held = rig.weapon.root.getObjectByProperty('isMesh', true) as Mesh;
      const shown = (): boolean => { for (let node: Object3D | null = held; node; node = node === rig.weapon.root ? null : node.parent) if (!node.visible) return false; return true; };
      const fist = rig.weapon.sockets.weapon.getWorldPosition(new Vector3());
      const target = { x: fist.x + 5, y: fist.y, z: fist.z };
      expect(shown()).toBe(true);
      expect(rig.weapon.throwStaff(target)).toBe(true);
      expect(rig.weapon.throwStaff(target)).toBe(false);
      expect(rig.weapon.throwing).toBe(true);
      expect(shown()).toBe(false);
      const flight = rig.weapon.flight!;
      expect(flight.visible).toBe(true);
      expect(flight.parent).toBe(stage);
      const frame = 1 / 60;
      let elapsed = 0;
      const step = (): void => { rig.weapon.setClip('yara-sap-lance', frame); elapsed += frame; };
      while (elapsed < 0.18) step();
      // Flat (the shaft never leaves the horizontal plane) and spinning: 3 frames at 2.5 rev/s turn it 45°.
      expect(Math.abs(worldAxis(flight).y)).toBeLessThan(1e-6);
      const before = worldAxis(flight);
      for (let i = 0; i < 3; i++) step();
      expect(radians(worldAxis(flight).angleTo(before))).toBeGreaterThan(30);
      // The outward leg ends at the lane end, then she calls the staff back.
      while (elapsed < STAFF_THROW.outSeconds - 1e-9) step();
      expect(flight.getWorldPosition(new Vector3()).distanceTo(new Vector3(target.x, target.y, target.z))).toBeLessThan(0.2);
      while (rig.weapon.throwing && elapsed < 2) step();
      expect(elapsed).toBeLessThanOrEqual(STAFF_THROW.outSeconds + STAFF_THROW.backSeconds + STAFF_BLEND_SECONDS);
      expect(elapsed).toBeGreaterThan(STAFF_THROW.outSeconds + STAFF_THROW.backSeconds - 2 * frame);
      expect(shown()).toBe(true);
      expect(flight.visible).toBe(false);
      // A hit, knockdown or defeat snaps a flying staff straight back into the fist.
      expect(rig.weapon.throwStaff(target)).toBe(true);
      for (let i = 0; i < 5; i++) step();
      rig.weapon.cancelThrow();
      expect(rig.weapon.throwing).toBe(false);
      expect(shown()).toBe(true);
      expect(flight.visible).toBe(false);
      // Disposing mid-flight takes the flying staff out of the scene.
      expect(rig.weapon.throwStaff(target)).toBe(true);
    } finally {
      const flight = rig.weapon.flight;
      rig.weapon.dispose();
      expect(flight?.parent ?? null).toBeNull();
      stage.remove(yara.scene);
    }
  }, 30_000);

  it('keeps the fingers on the take while the staff is away', () => {
    const stage = new Scene();
    stage.add(yara.scene);
    const rig = equipYara();
    try {
      poseYara('yara-sap-lance', 0.3);
      rig.weapon.setClip('yara-sap-lance', 0);
      const take = fingerPose();
      rig.hook();
      expect(fingerDelta(fingerPose(), take)).toBeGreaterThan(0.05);
      poseYara('yara-sap-lance', 0.3);
      rig.weapon.throwStaff({ x: 3, y: 1, z: 0 });
      rig.hook();
      expect(fingerDelta(fingerPose(), take)).toBeLessThan(1e-3);
    } finally { rig.weapon.dispose(); stage.remove(yara.scene); }
  }, 30_000);
});

/** Vesper's rigid-fist katana: synthetic fixtures cover orientation invariance;
 * the real revision-2 Tripo sword and rebuilt Vesper rig cover delivered geometry and grip agreement.
 */
function syntheticKatana(bladeAtPositive: boolean): Group {
  // The guard's back face sits 0.334 of the way up the 1.01-long model, so at the 1.25 m scale it stands where the real tsuba does (KATANA_GRIP.tsubaBackFromPommel).
  const handle = new CylinderGeometry(0.02, 0.02, 0.335, 12, 6).rotateX(Math.PI / 2).translate(0, 0, 0.1675);
  const guard = new BoxGeometry(0.1, 0.1, 0.012).translate(0, 0, 0.34);
  const blade = new BoxGeometry(0.008, 0.034, 0.52, 1, 1, 8).translate(0, 0, 0.61);
  const tipPart = new BoxGeometry(0.008, 0.03, 0.18, 1, 1, 4).translate(0, 0.02, 0.92);
  const geometry = mergeGeometries([handle, guard, blade, tipPart].map((part) => part.toNonIndexed()))!;
  if (!bladeAtPositive) geometry.rotateY(Math.PI);
  geometry.applyMatrix4(new Matrix4().compose(new Vector3(-0.7, 0.4, 1.9), new Quaternion().setFromAxisAngle(new Vector3(-0.4, 0.6, 0.7).normalize(), 0.8), new Vector3(1, 1, 1)));
  const group = new Group();
  group.add(new Mesh(geometry, new MeshStandardMaterial({ color: 0xbbbbbb })));
  return group;
}

function equipKatana(group: Group): WardenWeapon {
  return new WardenWeapon({ root: group, dispose: () => undefined }, { root: yara.scene, animation: { setPostPose: () => undefined } }, 'katana');
}

const katanaPath = 'asset-source/generated/prop-vesper-katana-runtime-02/prop-vesper-katana.glb';
const tripoKatana = await load(katanaPath, () => new MeshStandardMaterial());
const vesper = await load('asset-source/generated/actor-vesper-hero-01/vesper-hero-animated.glb', () => new MeshBasicMaterial());
const vesperAnatomy = JSON.parse(readFileSync(`${root}asset-source/generated/actor-vesper-hero-01/anatomy-report.json`, 'utf8')) as {
  grip: { katanaGrip: typeof KATANA_GRIP; bladeAxisHand: number[]; edgeAxisHand: number[]; palmHand: number[]; shaftRadiusRig: number };
};
afterAll(() => { vesper.scene.traverse((node) => { if (node instanceof Mesh) node.geometry.dispose(); }); });

describe('Vesper katana in the rigid fist', () => {
  it('seats the authored blade in the palm and closes the native hand around the hilt throughout its clips', () => {
    vesper.scene.scale.setScalar(1.7);
    vesper.scene.updateMatrixWorld(true);
    const grip = computeHandGrip(vesper.scene, true, KATANA_GRIP.diagonalRadians, KATANA_GRIP.edgeRadians);
    const vector = (values: number[]) => new Vector3().fromArray(values);
    expect(grip.axis.distanceTo(vector(vesperAnatomy.grip.bladeAxisHand))).toBeLessThan(2e-6);
    expect(grip.curl.clone().negate().distanceTo(vector(vesperAnatomy.grip.edgeAxisHand))).toBeLessThan(2e-6);
    // The clips are authored around this exact seat.
    expect(grip.palm.distanceTo(vector(vesperAnatomy.grip.palmHand))).toBeLessThan(2e-6);
    // Vesper's native palm faces his hand bone's +X; the armoured back plate faces -X. The hilt sits in front of the palm, never on the back plate.
    expect(grip.rigid!.normal.x).toBeGreaterThan(.9);
    const handCentre = new Vector3();
    let handCount = 0;
    const bindPositions = grip.rigid!.mesh.geometry.getAttribute('position'), bindIndices = grip.rigid!.mesh.geometry.getAttribute('skinIndex'), bindWeights = grip.rigid!.mesh.geometry.getAttribute('skinWeight');
    for (const vertex of referencedVertices(grip.rigid!.mesh.geometry)) {
      let handWeight = 0;
      for (let component = 0; component < 4; component++) if (grip.rigid!.mesh.skeleton.bones[bindIndices.getComponent(vertex, component)] === grip.hand) handWeight += bindWeights.getComponent(vertex, component);
      if (handWeight < .6) continue;
      handCentre.add(new Vector3().fromBufferAttribute(bindPositions, vertex).applyMatrix4(grip.rigid!.toHand));
      handCount++;
    }
    expect(grip.palm.x - handCentre.divideScalar(handCount).x).toBeGreaterThan(.01);
    const weapon = new WardenWeapon({ root: tripoKatana.scene.clone(), dispose: () => undefined },
      { root: vesper.scene, animation: { setPostPose: (hook) => { expect(hook).toBeUndefined(); } } }, 'katana');
    try {
      vesper.scene.updateMatrixWorld(true);
      const toHand = grip.hand.matrixWorld.clone().invert();
      const socket = weapon.sockets.weapon.getWorldPosition(new Vector3()).applyMatrix4(toHand);
      const tip = weapon.sockets['weapon-tip'].getWorldPosition(new Vector3()).applyMatrix4(toHand);
      expect(socket.distanceTo(grip.palm)).toBeLessThan(1e-5);
      expect(tip.sub(socket).normalize().dot(grip.axis)).toBeGreaterThan(0.99);
      const skin = grip.rigid!.mesh;
      const positions = skin.geometry.getAttribute('position');
      const indices = skin.geometry.getAttribute('skinIndex'), weights = skin.geometry.getAttribute('skinWeight');
      const inverse = weapon.root.matrixWorld.clone().invert(), point = new Vector3();
      const contacts: Array<{ vertex: number; point: Vector3 }> = [];
      const angles: number[] = [];
      const nearHilt: Vector3[] = [];
      let deepest = Infinity, fistFront = -Infinity;
      for (const vertex of referencedVertices(skin.geometry)) {
        let handWeight = 0;
        for (let component = 0; component < 4; component++) {
          if (skin.skeleton.bones[indices.getComponent(vertex, component)] === grip.hand) handWeight += weights.getComponent(vertex, component);
        }
        if (handWeight < .9999999) continue;
        skin.getVertexPosition(vertex, point).applyMatrix4(skin.matrixWorld).applyMatrix4(inverse);
        if (Math.hypot(point.x, point.y) < .05) fistFront = Math.max(fistFront, point.z);
        if (Math.hypot(point.x, point.y) < .06 && Math.abs(point.z) < .2) nearHilt.push(point.clone());
        if (Math.abs(point.z) > .04) continue;
        const clearance = Math.hypot(point.x, point.y) - grip.shaftRadius;
        deepest = Math.min(deepest, clearance);
        if (Math.abs(clearance) < .003) {
          contacts.push({ vertex, point: point.clone() });
          angles.push(Math.atan2(point.y, point.x));
        }
      }
      // No skin enters the tsuka: everything rigidly carried by the hand stays at least a millimetre outside it.
      expect(deepest).toBeGreaterThan(.001);
      // The fist sits right behind the guard like a real one-handed grip: its index side ends 0–5 mm behind the back face of the tsuba.
      const steel = weapon.root.getObjectByProperty('isMesh', true) as Mesh, steelPositions = steel.geometry.getAttribute('position'), steelIndex = steel.geometry.getIndex()!;
      const toWeapon = inverse.clone().multiply(steel.matrixWorld);
      const steelVertices: Vector3[] = [];
      let tsubaBack = Infinity;
      for (let vertex = 0; vertex < steelPositions.count; vertex++) {
        steelVertices.push(point.fromBufferAttribute(steelPositions, vertex).applyMatrix4(toWeapon).clone());
        if (point.z > 0 && Math.hypot(point.x, point.y) > .045) tsubaBack = Math.min(tsubaBack, point.z);
      }
      expect(Math.abs(tsubaBack + KATANA_GRIP.gripFromPommel - KATANA_GRIP.tsubaBackFromPommel)).toBeLessThan(.0005);
      const gap = tsubaBack - fistFront;
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThan(.005);
      // The tsuka runs to a thin fuchi right behind the tsuba: no collar longer than 1 cm, the slender tsuka before it.
      const radiusAt = (from: number, to: number): number => Math.max(...steelVertices.filter((v) => v.z >= from && v.z < to).map((v) => Math.hypot(v.x, v.y)));
      expect(radiusAt(-.1, tsubaBack - KATANA_GRIP.fuchi.length - .004)).toBeLessThan(grip.shaftRadius * 1.03);
      expect(radiusAt(tsubaBack - KATANA_GRIP.fuchi.length + .001, tsubaBack)).toBeGreaterThan(grip.shaftRadius * 1.15);
      expect(radiusAt(tsubaBack - KATANA_GRIP.fuchi.length + .001, tsubaBack)).toBeLessThan(grip.shaftRadius * KATANA_GRIP.fuchi.scale * 1.12);
      // Skin clearance against the real fitted hilt (tsuka, fuchi and tsuba triangles), 1.5 mm at least (bucketed by 2 cm of hilt length).
      const buckets = new Map<number, Triangle[]>();
      for (let item = 0; item < steelIndex.count; item += 3) {
        const a = steelVertices[steelIndex.getX(item)]!, b = steelVertices[steelIndex.getX(item + 1)]!, c = steelVertices[steelIndex.getX(item + 2)]!;
        if (Math.max(a.z, b.z, c.z) < -.22 || Math.min(a.z, b.z, c.z) > tsubaBack + .03) continue;
        const triangle = new Triangle(a, b, c);
        for (let bucket = Math.floor(Math.min(a.z, b.z, c.z) / .02); bucket <= Math.floor(Math.max(a.z, b.z, c.z) / .02); bucket++) (buckets.get(bucket) ?? buckets.set(bucket, []).get(bucket)!).push(triangle);
      }
      const closest = new Vector3();
      let clearance = Infinity;
      for (const skinPoint of nearHilt) {
        if (skinPoint.z > tsubaBack + .01) continue;
        for (const bucket of [Math.floor(skinPoint.z / .02) - 1, Math.floor(skinPoint.z / .02), Math.floor(skinPoint.z / .02) + 1]) for (const triangle of buckets.get(bucket) ?? []) { triangle.closestPointToPoint(skinPoint, closest); clearance = Math.min(clearance, closest.distanceTo(skinPoint)); }
      }
      expect(clearance).toBeGreaterThan(.0015);
      angles.sort((a, b) => a - b);
      let largestGap = angles[0]! + Math.PI * 2 - angles.at(-1)!;
      for (let i = 1; i < angles.length; i++) largestGap = Math.max(largestGap, angles[i]! - angles[i - 1]!);
      expect(Math.PI * 2 - largestGap).toBeGreaterThan(240 * Math.PI / 180);
      const sampled = contacts.filter((_, index) => index % Math.max(1, Math.floor(contacts.length / 40)) === 0);
      const mixer = new AnimationMixer(vesper.scene);
      let maximumDrift = 0;
      try {
        for (const clip of vesper.animations) {
          const action = mixer.clipAction(clip).play();
          action.paused = true;
          const frames = Math.ceil(clip.duration * 60);
          for (let frame = 0; frame <= frames; frame++) {
            action.time = clip.duration * frame / frames;
            mixer.update(0);
            vesper.scene.updateMatrixWorld(true);
            inverse.copy(weapon.root.matrixWorld).invert();
            for (const contact of sampled) {
              point.fromBufferAttribute(positions, contact.vertex);
              skin.applyBoneTransform(contact.vertex, point);
              point.applyMatrix4(skin.matrixWorld).applyMatrix4(inverse);
              maximumDrift = Math.max(maximumDrift, point.distanceTo(contact.point));
            }
          }
          action.stop();
        }
      } finally { mixer.stopAllAction(); mixer.uncacheRoot(vesper.scene); }
      expect(maximumDrift).toBeLessThan(.0001);
    } finally { weapon.dispose(); }
  }, 30_000);

  it('maps hero weapon grips onto weapon kinds', () => {
    expect(weaponKindForGrip('katana')).toBe('katana');
    expect(weaponKindForGrip('staff')).toBe('heartroot');
    expect(weaponKindForGrip('glaive')).toBe('warden');
    expect(weaponKindForGrip(undefined)).toBe('warden');
  });

  for (const flipped of [false, true]) {
    it(`finds the blade by the long side of the guard when the sword is built ${flipped ? 'blade-first' : 'hilt-first'}`, () => {
      const group = syntheticKatana(!flipped);
      const frame = analyzeGlaive((group.children[0] as Mesh).geometry.getAttribute('position').array as Float32Array, 'guard');
      expect(frame.length).toBeCloseTo(1.0, 1);
      expect(frame.tip.distanceTo(frame.origin)).toBeGreaterThan(frame.pommel.distanceTo(frame.origin));
      expect(frame.axis.dot(frame.tip.clone().sub(frame.pommel).normalize())).toBeGreaterThan(0.99);
      expect(Math.abs(frame.curl.dot(frame.axis))).toBeLessThan(1e-6);
    });
  }

  it('seats the 1.25 m katana with its grip KATANA_GRIP.gripFromPommel from the pommel and its blade the last 0.76 m', () => {
    expect(KATANA_GRIP.length).toBe(1.25);
    expect(KATANA_GRIP.bladeLength).toBe(0.76);
    for (const flipped of [false, true]) {
      const weapon = equipKatana(syntheticKatana(!flipped));
      try {
        yara.scene.updateMatrixWorld(true);
        const at = (name: 'weapon' | 'weapon-base' | 'weapon-tip' | 'weapon-pommel') => weapon.sockets[name].getWorldPosition(new Vector3());
        const pommel = at('weapon-pommel'), tip = at('weapon-tip');
        expect(pommel.distanceTo(tip)).toBeGreaterThan(KATANA_GRIP.length * 0.95);
        expect(pommel.distanceTo(tip)).toBeLessThan(KATANA_GRIP.length * 1.05);
        expect(at('weapon').distanceTo(pommel)).toBeGreaterThan(KATANA_GRIP.gripFromPommel * 0.9);
        expect(at('weapon').distanceTo(pommel)).toBeLessThan(KATANA_GRIP.gripFromPommel * 1.1);
        expect(at('weapon-base').distanceTo(tip)).toBeGreaterThan(KATANA_GRIP.bladeLength * 0.95);
        expect(at('weapon-base').distanceTo(tip)).toBeLessThan(KATANA_GRIP.bladeLength * 1.05);
      } finally { weapon.dispose(); }
    }
  }, 30_000);

  it('holds it in a rigid fist: no per-frame hook, grip tipped KATANA_GRIP.diagonalRadians toward the fingertips, everything restored on dispose', () => {
    let hooks = 0;
    const group = syntheticKatana(true);
    const weapon = new WardenWeapon({ root: group, dispose: () => undefined }, { root: yara.scene, animation: { setPostPose: (hook) => { if (hook) hooks += 1; } } }, 'katana');
    try {
      expect(hooks).toBe(0);
      expect(yaraSkin.geometry).not.toBe(originalHandGeometry);
      const staff = computeHandGrip(yara.scene, true, HEARTROOT_GRIP.diagonalRadians), katana = computeHandGrip(yara.scene, true, KATANA_GRIP.diagonalRadians);
      expect(radians(staff.axis.angleTo(katana.axis))).toBeCloseTo(radians(KATANA_GRIP.diagonalRadians), 0);
    } finally { weapon.dispose(); }
    expect(yaraSkin.geometry).toBe(originalHandGeometry);
    expect(weapon.root.parent).toBeNull();
  }, 30_000);

  it('closes the fist on the handle without flesh penetration in sampled poses', () => {
    const weapon = equipKatana(syntheticKatana(true));
    try {
      const mesh = weapon.root.getObjectByProperty('isMesh', true) as Mesh, positions = mesh.geometry.getAttribute('position');
      const indices = yaraSkin.geometry.getAttribute('skinIndex'), weights = yaraSkin.geometry.getAttribute('skinWeight');
      const inverse = new Matrix4(), point = new Vector3();
      for (const [clip, time] of [['aren-idle', 0], ['aren-walk', .3], ['aren-run', .2]] as const) {
        poseYara(clip, time);
        inverse.copy(weapon.root.matrixWorld).invert();
        let handleRadius = 0, skinRadius = Infinity;
        for (const vertex of referencedVertices(mesh.geometry)) {
          point.fromBufferAttribute(positions, vertex).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse);
          if (Math.abs(point.z) < .045) handleRadius = Math.max(handleRadius, Math.hypot(point.x, point.y));
        }
        for (const vertex of referencedVertices(yaraSkin.geometry)) {
          let handWeight = 0;
          for (let component = 0; component < 4; component++) if (yaraSkin.skeleton.bones[indices.getComponent(vertex, component)]?.name.includes('RightHand')) handWeight += weights.getComponent(vertex, component);
          if (handWeight < .6) continue;
          yaraSkin.getVertexPosition(vertex, point).applyMatrix4(yaraSkin.matrixWorld).applyMatrix4(inverse);
          if (point.z > -.5 && point.z < .6) skinRadius = Math.min(skinRadius, Math.hypot(point.x, point.y));
        }
        expect(handleRadius).toBeGreaterThan(.005);
        expect(skinRadius - handleRadius).toBeGreaterThan(-2e-4);
      }
    } finally { weapon.dispose(); }
  }, 30_000);

  it('gives the blade a violet-to-crimson emissive edge that scales with the edge intensity', () => {
    const group = syntheticKatana(true), weapon = equipKatana(group);
    try {
      const edge = weapon.edgeMaterials[0]!, mesh = group.getObjectByProperty('isMesh', true) as Mesh;
      expect(edge.userData.wcWeaponEdge).toBe(true);
      expect(edge.emissive.getHex()).toBe(new MeshStandardMaterial({ emissive: KATANA_EDGE_COLOR }).emissive.getHex());
      expect(edge.emissive.getHex()).not.toBe(new MeshStandardMaterial({ emissive: WARDEN_EDGE_COLOR }).emissive.getHex());
      const gradient = mesh.geometry.getAttribute('wcEdgeT');
      let low = Infinity, high = -Infinity;
      for (let vertex = 0; vertex < gradient.count; vertex++) { low = Math.min(low, gradient.getX(vertex)); high = Math.max(high, gradient.getX(vertex)); }
      expect(low).toBe(0);
      expect(high).toBe(1);
      const shader = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '#include <common>\n#include <emissivemap_fragment>' };
      edge.onBeforeCompile(shader as never, undefined as never);
      expect(shader.vertexShader).toContain('attribute float wcEdgeT');
      expect(shader.fragmentShader).toContain('totalEmissiveRadiance *=');
      const tint = shader.uniforms.wcEdgeTint!.value as Vector3;
      const violet = new MeshStandardMaterial({ emissive: KATANA_EDGE_COLOR }).emissive, crimson = new MeshStandardMaterial({ emissive: KATANA_EDGE_TIP_COLOR }).emissive;
      // violet × tint = crimson per channel: the tip end of the blade reaches the crimson emissive exactly.
      expect(violet.r * tint.x).toBeCloseTo(crimson.r, 5);
      expect(violet.g * tint.y).toBeCloseTo(crimson.g, 5);
      expect(violet.b * tint.z).toBeCloseTo(crimson.b, 5);
      weapon.setEdgeIntensity(2.5);
      expect(edge.emissiveIntensity).toBe(2.5);
    } finally { weapon.dispose(); }
  }, 30_000);

  describe('the Tripo revision-2 katana (prop-vesper-katana-runtime-02)', () => {
    const equipReal = (): WardenWeapon => new WardenWeapon({ root: tripoKatana.scene.clone(), dispose: () => undefined }, { root: yara.scene, animation: { setPostPose: () => undefined } }, 'katana');
    /** World metres of the weapon's own frame: +Z pommel→tip, +Y spine side, +X across the flat of the blade. */
    function bladeFrame(weapon: WardenWeapon) {
      yara.scene.updateMatrixWorld(true);
      const quaternion = weapon.root.getWorldQuaternion(new Quaternion());
      const mesh = weapon.root.getObjectByProperty('isMesh', true) as Mesh;
      return { mesh, x: new Vector3(1, 0, 0).applyQuaternion(quaternion), y: new Vector3(0, 1, 0).applyQuaternion(quaternion), z: new Vector3(0, 0, 1).applyQuaternion(quaternion), origin: weapon.sockets.weapon.getWorldPosition(new Vector3()) };
    }

    it('is a single mesh at the origin and seats at the full 1.25 m with its authored grip and 0.76 m blade', () => {
      const weapon = equipReal();
      try {
        yara.scene.updateMatrixWorld(true);
        const at = (name: 'weapon' | 'weapon-base' | 'weapon-tip' | 'weapon-pommel') => weapon.sockets[name].getWorldPosition(new Vector3());
        const pommel = at('weapon-pommel'), tip = at('weapon-tip');
        expect(pommel.distanceTo(tip)).toBeGreaterThan(KATANA_GRIP.length * 0.98);
        expect(pommel.distanceTo(tip)).toBeLessThan(KATANA_GRIP.length * 1.02);
        expect(at('weapon').distanceTo(pommel)).toBeGreaterThan(KATANA_GRIP.gripFromPommel * 0.95);
        expect(at('weapon').distanceTo(pommel)).toBeLessThan(KATANA_GRIP.gripFromPommel * 1.05);
        expect(at('weapon-base').distanceTo(tip)).toBeGreaterThan(KATANA_GRIP.bladeLength * 0.98);
        expect(at('weapon-base').distanceTo(tip)).toBeLessThan(KATANA_GRIP.bladeLength * 1.02);
      } finally { weapon.dispose(); }
    }, 30_000);

    it('puts the spine on +Y and the cutting edge on -Y, and turns the edge about the blade by KATANA_GRIP.edgeRadians from the back of the hand', () => {
      // Measured on the unedited bind hand: equipping fits the rigid fist into the hand mesh, which would move the recomputed principal axes.
      const grip = computeHandGrip(yara.scene, true, KATANA_GRIP.diagonalRadians, KATANA_GRIP.edgeRadians);
      const staff = computeHandGrip(yara.scene, true, HEARTROOT_GRIP.diagonalRadians);
      const weapon = equipReal();
      try {
        const { mesh, y, z, origin } = bladeFrame(weapon);
        const positions = mesh.geometry.getAttribute('position'), side = mesh.geometry.getAttribute('wcEdgeSide');
        const point = new Vector3();
        let edgeSum = 0, edgeCount = 0, spineSum = 0, spineCount = 0, tipHeight = -Infinity, tipAlong = -Infinity;
        const slice: number[] = [];
        for (const vertex of referencedVertices(mesh.geometry)) {
          point.fromBufferAttribute(positions, vertex).applyMatrix4(mesh.matrixWorld).sub(origin);
          const along = point.dot(z), height = point.dot(y);
          if (along > 0.4 && along < 0.9) {
            if (side.getX(vertex) < 0.05) { edgeSum += height; edgeCount++; }
            if (side.getX(vertex) > 0.95) { spineSum += height; spineCount++; }
            slice.push(height);
          }
          if (along > tipAlong) { tipAlong = along; tipHeight = height; }
        }
        expect(edgeCount).toBeGreaterThan(20);
        expect(spineCount).toBeGreaterThan(20);
        // The edge (side 0) lies toward -Y, the spine (side 1) toward +Y, by most of the blade width.
        expect(spineSum / spineCount - edgeSum / edgeCount).toBeGreaterThan(0.025);
        // The tip bends toward the spine: it sits above the mean blade centre line.
        expect(tipHeight).toBeGreaterThan(slice.reduce((sum, value) => sum + value, 0) / slice.length);
        const hand = yara.scene.getObjectByName('mixamorigRightHand') as Bone;
        const edgeWorld = grip.curl.clone().negate().transformDirection(hand.matrixWorld);
        expect(y.clone().negate().dot(edgeWorld)).toBeGreaterThan(0.99);
        // The staff keeps its own convention: the palm normal, perpendicular to the metacarpal direction.
        expect(Math.abs(staff.curl.dot(staff.rigid!.direction))).toBeLessThan(0.05);
      } finally { weapon.dispose(); }
    }, 30_000);

    it('is a thin, slender, razor blade: at most 12 mm at the spine, 4 mm at the edge, 48 mm wide, edge thinner than spine', () => {
      const weapon = equipReal();
      try {
        const { mesh, x, y, z, origin } = bladeFrame(weapon);
        const positions = mesh.geometry.getAttribute('position'), side = mesh.geometry.getAttribute('wcEdgeSide');
        // The blade's broad part: from 0.45 m up to 1 cm short of the kissaki, measured from the seat.
        const point = new Vector3(), bins = 12, to = KATANA_GRIP.length - KATANA_GRIP.gripFromPommel - 0.01, from = to - 0.45;
        const low = new Float64Array(bins).fill(Infinity), high = new Float64Array(bins).fill(-Infinity), wLow = new Float64Array(bins).fill(Infinity), wHigh = new Float64Array(bins).fill(-Infinity);
        const edgeLow = new Float64Array(bins).fill(Infinity), edgeHigh = new Float64Array(bins).fill(-Infinity), spineLow = new Float64Array(bins).fill(Infinity), spineHigh = new Float64Array(bins).fill(-Infinity);
        for (const vertex of referencedVertices(mesh.geometry)) {
          point.fromBufferAttribute(positions, vertex).applyMatrix4(mesh.matrixWorld).sub(origin);
          const along = point.dot(z);
          if (along < from || along >= to) continue;
          const bin = Math.floor((along - from) / (to - from) * bins), flat = point.dot(x), width = point.dot(y);
          low[bin] = Math.min(low[bin]!, flat); high[bin] = Math.max(high[bin]!, flat);
          wLow[bin] = Math.min(wLow[bin]!, width); wHigh[bin] = Math.max(wHigh[bin]!, width);
          if (side.getX(vertex) < 0.05) { edgeLow[bin] = Math.min(edgeLow[bin]!, flat); edgeHigh[bin] = Math.max(edgeHigh[bin]!, flat); }
          if (side.getX(vertex) > 0.95) { spineLow[bin] = Math.min(spineLow[bin]!, flat); spineHigh[bin] = Math.max(spineHigh[bin]!, flat); }
        }
        for (let bin = 0; bin < bins; bin++) {
          expect(high[bin]! - low[bin]!).toBeLessThan(0.012);
          expect(wHigh[bin]! - wLow[bin]!).toBeLessThan(0.048);
          expect(wHigh[bin]! - wLow[bin]!).toBeGreaterThan(0.02);
          if (edgeHigh[bin]! > edgeLow[bin]! && spineHigh[bin]! > spineLow[bin]!) {
            expect(edgeHigh[bin]! - edgeLow[bin]!).toBeLessThan(0.004);
            expect(edgeHigh[bin]! - edgeLow[bin]!).toBeLessThan(spineHigh[bin]! - spineLow[bin]!);
          }
        }
      } finally { weapon.dispose(); }
    }, 30_000);

    it('emits only a thin line along the cutting edge, not the whole blade', () => {
      const weapon = equipReal();
      try {
        const { mesh } = bladeFrame(weapon);
        const edge = weapon.edgeMaterials[0]!;
        expect(edge.emissiveMap).toBeNull();
        const side = mesh.geometry.getAttribute('wcEdgeSide'), tip = mesh.geometry.getAttribute('wcEdgeT');
        let lit = 0, blade = 0;
        for (const vertex of referencedVertices(mesh.geometry)) {
          if (tip.getX(vertex) <= 0) continue;
          blade++;
          if (side.getX(vertex) < 0.16) lit++;
        }
        expect(blade).toBeGreaterThan(1000);
        expect(lit / blade).toBeLessThan(0.3);
        expect(lit).toBeGreaterThan(50);
        const shader = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '#include <common>\n#include <emissivemap_fragment>' };
        edge.onBeforeCompile(shader as never, undefined as never);
        expect(shader.vertexShader).toContain('attribute float wcEdgeSide');
        expect(shader.fragmentShader).toContain('smoothstep(0.03, 0.16, vWcEdgeSide)');
      } finally { weapon.dispose(); }
    }, 30_000);
  });
});
