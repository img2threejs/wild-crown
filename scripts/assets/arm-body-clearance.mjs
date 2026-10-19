import { Vector3 } from 'three';
import { BODY_RADII, BODY_REFERENCE_CHAIN, BODY_TOLERANCE } from '../../src/rendering/BodyVolumes.mjs';

/**
 * Offline arm-versus-body penetration for clip authoring (rig units, 1.7 m = 1.0): the same capsules and arm samples as the runtime solver
 * (src/rendering/LimbClearance.ts), so an authored arm that clears here is left alone there. `capsules(...)` reads the trunk, head and legs of a posed
 * rig; `armDepth(...)` totals how deep the shoulder-elbow-wrist chain sinks into them.
 */
const RIG_METRES = 1.7;
const at = (rig, world, name, out) => out.setFromMatrixPosition(world[rig.index.get(`mixamorig:${name}`)]);

export function capsules(rig, world) {
  const hips = at(rig, world, 'Hips', new Vector3()), neck = at(rig, world, 'Neck', new Vector3());
  // Metres-to-rig-units scale of the volumes: the measured hips-to-neck chain against the reference chain (0.86 of it is the straight distance).
  const unit = hips.distanceTo(neck) * RIG_METRES / (BODY_REFERENCE_CHAIN * 0.86) / RIG_METRES;
  const list = [];
  const add = (a, b, radius, extend = 0) => {
    const pa = at(rig, world, a, new Vector3()), pb = at(rig, world, b, new Vector3());
    if (extend) pb.add(pb.clone().sub(pa).normalize().multiplyScalar(extend * unit));
    list.push({ a: pa, b: pb, radius: radius * unit });
  };
  add('Hips', 'Spine1', BODY_RADII.pelvis); add('Spine1', 'Neck', BODY_RADII.chest); add('Neck', 'Head', BODY_RADII.head, 0.1);
  for (const side of ['Left', 'Right']) { add(`${side}UpLeg`, `${side}Leg`, BODY_RADII.thigh); add(`${side}Leg`, `${side}Foot`, BODY_RADII.shin); }
  return { list, unit };
}

const AB = new Vector3(), AP = new Vector3(), NEAR = new Vector3();
function distance(capsule, p) {
  AB.subVectors(capsule.b, capsule.a); AP.subVectors(p, capsule.a);
  const length2 = AB.lengthSq(), t = length2 < 1e-12 ? 0 : Math.max(0, Math.min(1, AP.dot(AB) / length2));
  return NEAR.copy(capsule.a).addScaledVector(AB, t).distanceTo(p);
}

const sample = new Vector3();
/** Total penetration depth (rig units) of an arm (`shoulder`, `elbow`, `wrist` points) into the body capsules, beyond the soft-tissue tolerance. */
export function armDepth({ list, unit }, shoulder, elbow, wrist) {
  let total = 0;
  const probe = (p, radius) => {
    const r = (radius - BODY_TOLERANCE) * unit;
    for (const body of list) total += Math.max(0, r + body.radius - distance(body, p));
  };
  for (let s = 0; s < 3; s += 1) probe(sample.lerpVectors(shoulder, elbow, 0.5 + 0.25 * s), BODY_RADII.upperArm);
  const tip = wrist.clone().sub(elbow).multiplyScalar(1.12).add(elbow);
  for (let s = 0; s < 5; s += 1) probe(sample.lerpVectors(elbow, tip, s / 4), BODY_RADII.foreArm * (1 + 0.35 * s / 4));
  return total;
}

/* ------------------------------------------------------------------ offline pass: keep the authored arms out of the body */
import { Quaternion } from 'three';

const DAMPING = 0.012 / (RIG_METRES * RIG_METRES);
/** Total rotation (radians) the pass may add to a bone relative to the authored pose. */
const BUDGET = { arm: 1.0, fore: 1.3 };
const BONES = { arm: 'Arm', fore: 'ForeArm' };

const up = new Vector3(0, 1, 0);
function closest(capsule, p, out) {
  AB.subVectors(capsule.b, capsule.a); AP.subVectors(p, capsule.a);
  const length2 = AB.lengthSq(), t = length2 < 1e-12 ? 0 : Math.max(0, Math.min(1, AP.dot(AB) / length2));
  out.copy(capsule.a).addScaledVector(AB, t);
  return out.distanceTo(p);
}

/**
 * One damped least-squares rotation of `joint` (world position) that carries every penetrating sample of the arm out of the body: minimises
 * Σ (depthᵢ − (ω × leverᵢ)·nᵢ)² + λ|ω|². Samples are `{ p, radius }` (rig units). Returns the world rotation vector ω, or undefined when nothing penetrates.
 */
function leastSquares(body, samples, joint, side) {
  let a00 = DAMPING, a01 = 0, a02 = 0, a11 = DAMPING, a12 = 0, a22 = DAMPING, b0 = 0, b1 = 0, b2 = 0, any = false;
  const near = new Vector3(), push = new Vector3(), lever = new Vector3(), torque = new Vector3();
  for (const sampleItem of samples) {
    let deepest = 0;
    body.list.forEach((capsule, index) => {
      const d = closest(capsule, sampleItem.p, near), depth = (sampleItem.radius - BODY_TOLERANCE) * body.unit + capsule.radius - d;
      if (depth <= deepest) return;
      deepest = depth;
      push.subVectors(sampleItem.p, near);
      if (d < 1e-5) push.copy(side); else {
        push.divideScalar(d);
        if (index <= 2) push.addScaledVector(side, 1.5 * Math.max(0, 1 - push.dot(side))).normalize();
      }
    });
    if (deepest < 1e-4 / RIG_METRES) continue;
    lever.subVectors(sampleItem.p, joint);
    torque.crossVectors(lever, push);
    const w = Math.min(1, deepest * RIG_METRES / 0.01);
    a00 += w * torque.x * torque.x; a01 += w * torque.x * torque.y; a02 += w * torque.x * torque.z;
    a11 += w * torque.y * torque.y; a12 += w * torque.y * torque.z; a22 += w * torque.z * torque.z;
    b0 += deepest * torque.x; b1 += deepest * torque.y; b2 += deepest * torque.z;
    any = true;
  }
  if (!any) return undefined;
  const c00 = a11 * a22 - a12 * a12, c01 = a02 * a12 - a01 * a22, c02 = a01 * a12 - a02 * a11, det = a00 * c00 + a01 * c01 + a02 * c02;
  if (Math.abs(det) < 1e-24) return undefined;
  return new Vector3((b0 * c00 + b1 * c01 + b2 * c02) / det, (b0 * c01 + b1 * (a00 * a22 - a02 * a02) + b2 * (a01 * a02 - a00 * a12)) / det, (b0 * c02 + b1 * (a01 * a02 - a00 * a12) + b2 * (a00 * a11 - a01 * a01)) / det);
}

/**
 * Authoring pass: for every frame, the elbow and then the shoulder of each arm are rotated (damped least squares, bounded per bone) until the arm
 * is out of the trunk, head and legs, then the corrections are smoothed along time in both directions (no lag offline), so the clip itself carries
 * a body-clear arm. Returns `{ frames: corrected frame count, peakDegrees }`.
 */
export function clearArms(rig, frames, count, { passes = 3, smooth = 0.5 } = {}) {
  const ids = {};
  for (const side of ['Left', 'Right']) for (const [key, name] of Object.entries(BONES)) ids[`${side}${key}`] = rig.index.get(`mixamorig:${side}${name}`);
  const authored = Object.fromEntries(Object.entries(ids).map(([key, node]) => [key, Float32Array.from(frames.rotations[node])]));
  const q = new Quaternion(), parent = new Quaternion(), turn = new Quaternion(), local = new Quaternion(), start = new Quaternion(), target = new Quaternion();
  const worldQuaternion = (world, node) => parent.setFromRotationMatrix(world[node]);
  let changedFrames = 0, peak = 0;
  for (let k = 0; k < count; k += 1) {
    let touched = false;
    for (let pass = 0; pass < passes; pass += 1) {
      const world = rig.poseFrame(frames, k), body = capsules(rig, world);
      let moved = false;
      for (const side of ['Left', 'Right']) {
        const lateral = new Vector3().subVectors(at(rig, world, 'LeftArm', new Vector3()), at(rig, world, 'RightArm', new Vector3())).normalize().multiplyScalar(side === 'Left' ? 1 : -1);
        for (const key of ['fore', 'arm']) {
          const shoulder = at(rig, world, `${side}Arm`, new Vector3()), elbow = at(rig, world, `${side}ForeArm`, new Vector3()), wrist = at(rig, world, `${side}Hand`, new Vector3());
          const tip = wrist.clone().sub(elbow).multiplyScalar(1.12).add(elbow), samples = [];
          if (key === 'arm') for (let s = 0; s < 3; s += 1) samples.push({ p: new Vector3().lerpVectors(shoulder, elbow, 0.5 + 0.25 * s), radius: BODY_RADII.upperArm });
          for (let s = 0; s < 5; s += 1) samples.push({ p: new Vector3().lerpVectors(elbow, tip, s / 4), radius: BODY_RADII.foreArm * (1 + 0.35 * s / 4) });
          const omega = leastSquares(body, samples, key === 'arm' ? shoulder : elbow, lateral);
          const angle = omega?.length() ?? 0;
          if (angle < 1e-4) continue;
          const node = ids[`${side}${key}`], track = frames.rotations[node], limit = BUDGET[key];
          local.fromArray(track, k * 4);
          worldQuaternion(world, rig.parent[node]);
          turn.setFromAxisAngle(omega.clone().divideScalar(angle), Math.min(angle, limit));
          // local' = parent⁻¹ · turn · parent · local
          q.copy(parent).invert().multiply(turn).multiply(parent).multiply(local).normalize();
          start.fromArray(authored[`${side}${key}`], k * 4);
          const total = q.angleTo(start);
          if (total > limit) q.copy(start).slerp(q, limit / total);
          q.toArray(track, k * 4);
          peak = Math.max(peak, Math.min(total, limit));
          moved = true;
        }
      }
      if (!moved) break;
      touched = true;
    }
    if (touched) changedFrames += 1;
  }
  if (smooth > 0 && changedFrames > 0) {
    // Smooth the correction (authored⁻¹ · corrected) with a forward-backward exponential filter: continuous, no net lag.
    for (const [key, node] of Object.entries(ids)) {
      const track = frames.rotations[node], base = authored[key], delta = Array.from({ length: count }, (_, k) => new Quaternion().fromArray(base, k * 4).invert().multiply(new Quaternion().fromArray(track, k * 4)));
      for (let k = 1; k < count; k += 1) { if (delta[k].dot(delta[k - 1]) < 0) { delta[k].x *= -1; delta[k].y *= -1; delta[k].z *= -1; delta[k].w *= -1; } }
      const pass = (order) => { let previous; for (const k of order) { if (previous) delta[k].slerp(previous, smooth); previous = delta[k].clone(); } };
      pass([...Array(count).keys()]); pass([...Array(count).keys()].reverse());
      for (let k = 0; k < count; k += 1) new Quaternion().fromArray(base, k * 4).multiply(delta[k].normalize()).toArray(track, k * 4);
    }
  }
  return { frames: changedFrames, peakDegrees: Math.round(peak * 180 / Math.PI * 10) / 10 };
}
