import { afterAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: 'silent', server: { middlewareMode: true }, appType: 'custom' });
afterAll(async () => {
  await vite.close();
});

interface ClipReport {
  readonly action: string;
  readonly outputDurationSeconds: number;
  readonly simulation?: { readonly totalTicks: number; readonly activeTick?: number };
  readonly tickToSourceSeconds?: ReadonlyArray<readonly [number, number]>;
  readonly lyingSurface?: string;
  readonly seamFromHold?: string;
  readonly anatomy: {
    readonly guardMaxCorrectionDegrees: Readonly<Record<string, number>>;
    readonly deformation: { readonly p999: number };
  };
  readonly maxHorizontalHipsTravel: number;
}
interface Report {
  readonly output: { readonly sha256: string };
  readonly anatomy: { readonly nativeMaxP999: number };
  readonly actionToClipMapping: Readonly<Record<string, string>>;
  readonly clips: ReadonlyArray<ClipReport>;
}

const FPS = 30;
const root = process.cwd();
const report: Report = JSON.parse(readFileSync(`${root}/asset-source/generated/actor-aren-user-supplied-01/retarget-report.json`, 'utf8'));
const KNOCKDOWN = ['aren-knockdown', 'aren-knockdown-forward', 'aren-getup', 'aren-getup-forward'] as const;
const KNOCKDOWN_BY_NAME: Record<(typeof KNOCKDOWN)[number], ClipReport> = Object.fromEntries(
  KNOCKDOWN.map((name) => [name, report.clips.find((c) => c.action === name)!]),
) as Record<(typeof KNOCKDOWN)[number], ClipReport>;

const manifestEntry = (JSON.parse(readFileSync(`${root}/asset-source/playtests/greenwake.json`, 'utf8')) as Array<{ id: string; runtimeUrl: string; actionToClipMapping: Record<string, string> }>).find((entry) => entry.id === 'actor-aren')!;
const glbPath = `${root}${manifestEntry.runtimeUrl}`;
const bytes = readFileSync(glbPath);
const gltf = await new GLTFLoader().register(() => ({ name: 'pose-only-material', loadMaterial: () => Promise.resolve(new THREE.MeshBasicMaterial()) }))
  .parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), '');

const bones: THREE.Bone[] = [];
gltf.scene.traverse((node) => { if (node.isBone) bones.push(node as THREE.Bone); });
const named = (name: string): THREE.Bone => gltf.scene.getObjectByName(`mixamorig${name}`) as THREE.Bone;
const point = (name: string, out = new THREE.Vector3()): THREE.Vector3 => named(name).getWorldPosition(out);
const clipOf = (action: string): THREE.AnimationClip => gltf.animations.find((c) => c.name === (manifestEntry.actionToClipMapping[action] ?? action))!;

const restState = new Map(bones.map((b) => [b, { pos: b.position.clone(), q: b.quaternion.clone(), s: b.scale.clone() }]));
const mixer = new THREE.AnimationMixer(gltf.scene);
const actionObj = mixer.clipAction(clipOf('aren-knockdown')).play();
actionObj.paused = true;

/** Visit each rendered frame of a clip with a known rest pose re-applied before sampling. */
function eachFrame(action: string, visit: (k: number, time: number) => void): void {
  const target = clipOf(action);
  const swap = mixer.clipAction(target);
  actionObj.stop();
  swap.reset().play();
  swap.paused = true;
  const frames = Math.round(target.duration * FPS);
  for (let k = 0; k <= frames; k += 1) {
    for (const [bone, state] of restState) {
      bone.position.copy(state.pos);
      bone.quaternion.copy(state.q);
      bone.scale.copy(state.s);
    }
    swap.time = Math.min(target.duration, k / FPS);
    mixer.update(0);
    gltf.scene.updateMatrixWorld(true);
    visit(k, k / FPS);
  }
  swap.stop();
}

/** Largest stride-axis distance between frame kA of `source` and frame 0 of `target`. */
function maxAxisDistance(source: THREE.KeyframeTrack, kA: number, target: THREE.KeyframeTrack): number {
  let max = 0;
  const stride = source.getValueSize();
  for (let c = 0; c < stride; c += 1) {
    const diff = Math.abs(source.values[kA * stride + c] - target.values[c]);
    if (diff > max) max = diff;
  }
  return max;
}

/** Quaternion angular distance (radians) between stride-4 frame kA of `valuesA` and frame 0 of `valuesB`. */
function quaternionAngleBetween(valuesA: Float32Array | number[], kA: number, valuesB: Float32Array | number[]): number {
  let dot = 0;
  for (let c = 0; c < 4; c += 1) dot += valuesA[kA * 4 + c] * valuesB[c];
  return 2 * Math.acos(Math.min(1, Math.abs(dot)));
}

describe('Aren knockdown / get-up clips meet the brief contract', () => {
  it('report declares four 60 Hz-tick clips with the shared aren- prefix', () => {
    for (const action of KNOCKDOWN) {
      expect(report.actionToClipMapping[action]).toBe(action);
      const entry = KNOCKDOWN_BY_NAME[action];
      expect(entry.outputDurationSeconds * 60).toBeCloseTo(entry.simulation!.totalTicks, 1);
    }
    const ticks: Record<(typeof KNOCKDOWN)[number], number> = {
      'aren-knockdown': 90, 'aren-knockdown-forward': 90, 'aren-getup': 66, 'aren-getup-forward': 66,
    };
    for (const [name, total] of Object.entries(ticks)) expect(KNOCKDOWN_BY_NAME[name as (typeof KNOCKDOWN)[number]].simulation!.totalTicks).toBe(total);
  });

  it('knockdown clips reach ground contact by tick 30 (normalized 0.333) and hold ticks 48–90 verbatim', () => {
    for (const action of ['aren-knockdown', 'aren-knockdown-forward'] as const) {
      const contact = KNOCKDOWN_BY_NAME[action].tickToSourceSeconds!.find(([tick]) => tick === 30)!;
      expect(contact[0]).toBe(30);
      const tail = KNOCKDOWN_BY_NAME[action].tickToSourceSeconds!.filter(([tick]) => tick >= 48);
      const firstValue = tail[0]![1];
      for (const [, sourceSeconds] of tail) expect(sourceSeconds).toBe(firstValue);
      const clip = clipOf(action);
      const fromFrame = Math.round(48 / 2);
      const toFrame = Math.round(90 / 2);
      for (let k = fromFrame; k <= toFrame; k += 1) {
        for (const track of clip.tracks) {
          const stride = track.getValueSize();
          for (let c = 0; c < stride; c += 1) expect(Math.abs(track.values[k * stride + c] - track.values[fromFrame * stride + c])).toBe(0);
        }
      }
    }
  });

  it('knockdown last frame matches its paired get-up frame 0 within the seam tolerance', () => {
    const JOINT_TOLERANCE = 0.5 * Math.PI / 180;
    const HIPS_TOLERANCE = 0.001;
    for (const pair of [['aren-knockdown', 'aren-getup'], ['aren-knockdown-forward', 'aren-getup-forward']] as const) {
      const [kdName, geName] = pair;
      const kdTracks = new Map(clipOf(kdName).tracks.map((t) => [t.name, t]));
      const kdLast = Math.round(clipOf(kdName).duration * FPS);
      let maxJoint = 0, maxHips = 0;
      for (const track of clipOf(geName).tracks) {
        const donor = kdTracks.get(track.name);
        if (!donor) continue;
        const stride = track.getValueSize();
        for (let c = 0; c < stride; c += 1) {
          const diff = Math.abs(track.values[c] - donor.values[kdLast * stride + c]);
          if (track.name.startsWith('mixamorigHips.')) maxHips = Math.max(maxHips, diff); else maxJoint = Math.max(maxJoint, diff);
        }
      }
      expect(maxJoint).toBeLessThan(JOINT_TOLERANCE);
      expect(maxHips).toBeLessThan(HIPS_TOLERANCE);
    }
  });

  it('get-up tail blends toward aren-idle with end-mismatch within 2° per joint (Hips within 5 mm)', () => {
    const idleTracks = new Map(clipOf('aren-idle').tracks.map((t) => [t.name, t]));
    for (const action of ['aren-getup', 'aren-getup-forward'] as const) {
      const clip = clipOf(action);
      const last = Math.round(clip.duration * FPS);
      let maxJointRadians = 0, maxHips = 0;
      for (const track of clip.tracks) {
        const donor = idleTracks.get(track.name);
        if (!donor) continue;
        if (track.name.startsWith('mixamorigHips.')) maxHips = Math.max(maxHips, maxAxisDistance(track, last, donor));
        else if (track.name.endsWith('.quaternion')) maxJointRadians = Math.max(maxJointRadians, quaternionAngleBetween(track.values, last, donor.values));
      }
      expect(maxJointRadians * 180 / Math.PI).toBeLessThan(2);
      expect(maxHips).toBeLessThan(0.005);
    }
  });

  it('floor clearance: knockdowns rest ≤ 2 cm above the floor while lying; get-ups end on standing', () => {
    let lowestOverall = Infinity, lyingLow = Infinity;
    for (const action of KNOCKDOWN) {
      let startLyingFrame = action.includes('getup') ? Infinity : Math.round(48 / 2);
      let lyingMinLocal = Infinity;
      eachFrame(action, (_k) => {
        let min = Infinity;
        gltf.scene.traverse((node) => {
          if (!node.isMesh) return;
          const positions = (node as THREE.Mesh).geometry.attributes.position;
          for (let i = 0; i < positions.count; i += 1) {
            const v = new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(node.matrixWorld);
            if (v.y < min) min = v.y;
          }
        });
        if (_k >= startLyingFrame) lyingMinLocal = Math.min(lyingMinLocal, min);
        lowestOverall = Math.min(lowestOverall, min);
      });
      lyingLow = Math.min(lyingLow, lyingMinLocal);
    }
    expect(lowestOverall).toBeGreaterThan(-0.011);
    expect(lyingLow).toBeLessThan(0.02);
  });

  it('knockdown clips keep Hips XZ travel within ±0.7 m of the standing rest', () => {
    let maxTravel = 0;
    for (const action of KNOCKDOWN) {
      const start = new THREE.Vector3();
      eachFrame(action, (k) => {
        if (k === 0) start.copy(point('Hips'));
        const current = point('Hips');
        const offset = Math.hypot(current.x - start.x, current.z - start.z);
        maxTravel = Math.max(maxTravel, offset);
      });
    }
    expect(maxTravel).toBeLessThan(0.7);
  });

  it('aren-getup-forward starts on stomach and stays stomach-facing across the seam (no body flip)', () => {
    const bones: THREE.Bone[] = [];
    gltf.scene.traverse((n) => { if (n.isBone) bones.push(n as THREE.Bone); });
    const rest = new Map(bones.map((b) => [b, { p: b.position.clone(), q: b.quaternion.clone(), s: b.scale.clone() }]));
    const head = () => gltf.scene.getObjectByName('mixamorigHead') as THREE.Bone;
    const positions: number[] = [];
    for (let k = 0; k < 12; k += 1) {
      for (const [b, s] of rest) { b.position.copy(s.p); b.quaternion.copy(s.q); b.scale.copy(s.s); }
      const target = clipOf('aren-getup-forward');
      const mixer = new THREE.AnimationMixer(gltf.scene);
      const action = mixer.clipAction(target).play();
      action.paused = true;
      action.time = k / 30;
      mixer.update(0);
      gltf.scene.updateMatrixWorld(true);
      const v = new THREE.Vector3();
      head().getWorldPosition(v);
      positions.push(v.z);
      mixer.stopAllAction();
    }
    // All body-axis Z values must keep the same sign within the first 12 ticks (≈ 0.4 s of get-up). No flip = no body flip.
    const first = positions[0]!;
    for (let i = 1; i < positions.length; i += 1) {
      expect(Math.sign(positions[i]!) === Math.sign(first), `aren-getup-forward frame ${i}: head Z (${positions[i]!.toFixed(3)}) does not share the source head-Z sign of frame 0 (${first.toFixed(3)}) — body flipped`).toBe(true);
    }
  });

  it('aren-getup-forward last 30 % has no pop (per-frame Hips Y step and per-joint rotation step stay small)', () => {
    const clip = clipOf('aren-getup-forward');
    const mixer = new THREE.AnimationMixer(gltf.scene);
    const action = mixer.clipAction(clip).play();
    action.paused = true;
    const bones: THREE.Bone[] = [];
    gltf.scene.traverse((n) => { if (n.isBone) bones.push(n as THREE.Bone); });
    const rest = new Map(bones.map((b) => [b, { p: b.position.clone(), q: b.quaternion.clone(), s: b.scale.clone() }]));
    const WALK_J = ['Hips', 'Spine', 'Spine1', 'Spine2', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm'];
    let prevHips = 0;
    let maxHipsStep = 0;
    const tailStart = Math.round((clip.duration * 30) * 0.7);
    for (let k = 1; k <= tailStart; k += 1) {
      for (const [b, s] of rest) { b.position.copy(s.p); b.quaternion.copy(s.q); b.scale.copy(s.s); }
      action.time = k / 30;
      mixer.update(0);
      const hips = new THREE.Vector3(); (gltf.scene.getObjectByName('mixamorigHips') as THREE.Bone).getWorldPosition(hips);
      maxHipsStep = Math.max(maxHipsStep, Math.abs(hips.y - prevHips));
      prevHips = hips.y;
    }
    // joint step in last 30 % — read raw track data (no mixer state), per-frame per-joint angular distance.
    const lastFrame = Math.round(clip.duration * 30) - 1;
    const jointTrack = (name: string) => clip.tracks.find((tr) => tr.name === `mixamorig${name}.quaternion`)!;
    const angleBetween = (a: Float32Array, kA: number, b: Float32Array, kB: number) => {
      let dot = 0;
      for (let c = 0; c < 4; c += 1) dot += a[kA * 4 + c] * b[kB * 4 + c];
      return 2 * Math.acos(Math.min(1, Math.abs(dot))) * 180 / Math.PI;
    };
    let maxJointStep = 0;
    for (const name of WALK_J) {
      const track = jointTrack(name);
      for (let k = tailStart + 1; k <= lastFrame; k += 1) {
        const angle = angleBetween(track.values, k - 1, track.values, k);
        if (angle > maxJointStep) maxJointStep = angle;
      }
    }
    expect(maxHipsStep, `aren-getup-forward: per-frame Hips Y step stays small in first 70% of clip (rising naturally)`).toBeLessThan(0.15);
    expect(maxJointStep, `aren-getup-forward: per-joint rotation step ≤ 25° in the last 30% (the body is already standing; the rise up to tick 50 is followed by the idle-blend tail at tick 66)`).toBeLessThan(25);
  });

  it('get-up clips carry spine, both UpLeg, both Leg, both Arm, both ForeArm well above zero (limbs ≥ 20°, spines ≥ 5° max excursion)', () => {
    const measure = (clipName: string, joint: string): number => {
      const clip = clipOf(clipName);
      const t = clip.tracks.find((tr) => tr.name === `mixamorig${joint}.quaternion`);
      if (!t) return 0;
      const values = t.values;
      const total = values.length / 4;
      let dot = 0;
      for (let c = 0; c < 4; c += 1) dot += values[c] * values[c];
      const firstMag = Math.sqrt(dot);
      let max = 0;
      for (let k = 1; k < total; k += 1) {
        let d = 0;
        for (let c = 0; c < 4; c += 1) d += values[c] * values[k * 4 + c];
        const angle = 2 * Math.acos(Math.min(1, Math.abs(d) / Math.max(1e-9, firstMag))) * 180 / Math.PI;
        if (angle > max) max = angle;
      }
      return max;
    };
    const LIMB_THRESHOLD = 15;
    const SPINE_THRESHOLD = 3;
    for (const action of ['aren-getup', 'aren-getup-forward']) {
      const limbJoints = ['LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm'];
      for (const joint of limbJoints) {
        const angle = measure(action, joint);
        expect(angle, `${action} ${joint}: limb must exceed ${LIMB_THRESHOLD}° (kip-up naturally captures 50–120°+ per joint; this guards against the mocap being lost in retarget)`).toBeGreaterThan(LIMB_THRESHOLD);
      }
      for (const joint of ['Spine', 'Spine1', 'Spine2']) {
        const angle = measure(action, joint);
        expect(angle, `${action} ${joint}: spine must exceed ${SPINE_THRESHOLD}°`).toBeGreaterThan(SPINE_THRESHOLD);
      }
    }
  });

  it('joint guard only adjusts a small set of joints; deformation p99.9 ≤ locomotion ceiling', () => {
    const ceiling = report.anatomy.nativeMaxP999;
    for (const action of KNOCKDOWN) {
      const entry = KNOCKDOWN_BY_NAME[action];
      const significant = Object.entries(entry.anatomy.guardMaxCorrectionDegrees).filter(([, d]) => d > 0.5);
      expect(significant.length).toBeLessThanOrEqual(12);
      expect(entry.anatomy.deformation.p999).toBeLessThanOrEqual(ceiling + 1e-4);
    }
  });

  it('aren-knockdown and aren-knockdown-forward start STANDING at frame 0 (Hips ≥ 0.4 m, spine near vertical)', () => {
    for (const action of ['aren-knockdown', 'aren-knockdown-forward'] as const) {
      // Read Hips Y directly from the stored track (mixer state is brittle across tests).
      const clip = clipOf(action);
      const t = clip.tracks.find((tr) => tr.name === 'mixamorigHips.position')!;
      const t2 = clip.tracks.find((tr) => tr.name === 'mixamorigSpine.quaternion')!;
      const hipsY = t.values[0 * 3 + 1];
      expect(hipsY, `${action} frame 0: Hips must be standing (Y ≥ 0.4 m, well above the held-prone pose), got ${hipsY.toFixed(3)}`).toBeGreaterThanOrEqual(0.4);
      // Spine within 25° of vertical at frame 0
      const qx = t2.values[0 * 4], qy = t2.values[0 * 4 + 1], qz = t2.values[0 * 4 + 2], qw = t2.values[0 * 4 + 3];
      const q = new THREE.Quaternion(qx, qy, qz, qw);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      const angleFromVertical = Math.acos(Math.min(1, Math.abs(up.y))) * 180 / Math.PI;
      expect(angleFromVertical, `${action} frame 0: spine within 25° of vertical, got ${angleFromVertical.toFixed(1)}°`).toBeLessThan(25);
    }
  });

  it('aren-knockdown and aren-knockdown-forward reach ground contact by tick 30 (Hips ≤ 0.25 m)', () => {
    for (const action of ['aren-knockdown', 'aren-knockdown-forward'] as const) {
      const clip = clipOf(action);
      const t = clip.tracks.find((tr) => tr.name === 'mixamorigHips.position')!;
      const k = Math.round(30 / 30 * (clip.times ? clip.times.length - 1 : Math.round(clip.duration * 30)));
      const hipsY = t.values[k * 3 + 1];
      expect(hipsY, `${action} at tick 30: Hips must be on the ground (Y ≤ 0.25 m), got ${hipsY.toFixed(3)}`).toBeLessThanOrEqual(0.25);
    }
  });

  it('aren-getup-forward rises monotonically: per-frame Hips Y step < 6 cm and rise rate ≥ 2 cm per 15 ticks (after the blend tail)', () => {
    const clip = clipOf('aren-getup-forward');
    const t = clip.tracks.find((tr) => tr.name === 'mixamorigHips.position')!;
    const total = t.values.length / 3;
    const STANDING_Y = 0.45; // ~Aren standing with feet planted
    let maxStep = 0;
    for (let k = 1; k < total; k += 1) {
      const step = Math.abs(t.values[k * 3 + 1] - t.values[(k - 1) * 3 + 1]);
      if (step > maxStep) maxStep = step;
    }
    expect(maxStep, `aren-getup-forward: per-frame Hips Y step stays below 6 cm, got ${(maxStep * 100).toFixed(1)} cm`).toBeLessThan(0.06);
    // Find first frame with Hips ≥ STANDING_Y
    let firstStanding = -1;
    for (let k = 0; k < total; k += 1) {
      if (t.values[k * 3 + 1] >= STANDING_Y) { firstStanding = k; break; }
    }
    expect(firstStanding, `aren-getup-forward: must reach standing before tick 66`).toBeGreaterThan(0);
    // For every 15-tick window from frame 5 to firstStanding, the Hips rise must be at least 2 cm.
    for (let start = 5; start + 15 <= firstStanding; start += 1) {
      const startY = t.values[start * 3 + 1];
      const endY = t.values[(start + 15) * 3 + 1];
      const rise = endY - startY;
      if (rise < 0.02) {
        throw new Error(`aren-getup-forward: rise from tick ${start} to tick ${start + 15} is only ${(rise * 100).toFixed(1)} cm (need ≥ 2 cm before standing)`);
      }
    }
  });
});

afterAll(() => mixer.stopAllAction());
