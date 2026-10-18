import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Quaternion, Vector3 } from 'three';
import { solveHingedTwoBone } from '../../scripts/assets/creature-rig-kit.mjs';

const v = (x, y, z = 0) => new Vector3(x, y, z);
const identity = new Quaternion();
function forward(S, E, H, solved, upper = identity, lower = identity) {
  const elbow = E.clone().sub(S).applyQuaternion(solved.upper.clone().multiply(upper.clone().invert())).add(S);
  const end = H.clone().sub(E).applyQuaternion(solved.lower.clone().multiply(lower.clone().invert())).add(elbow);
  assert.ok(Math.abs(elbow.distanceTo(S) - E.distanceTo(S)) < 1e-7, 'upper bone must retain its native length');
  assert.ok(Math.abs(end.distanceTo(elbow) - H.distanceTo(E)) < 1e-7, 'lower bone must retain its native length');
  assert.ok(end.distanceTo(solved.end) < 1e-7, 'native forward kinematics must reach the solved effector');
  return end;
}

it('reaches a physical target without stretching, in an arbitrarily rotated native bone frame', () => {
  const frame = new Quaternion().setFromAxisAngle(v(1, 2, 3).normalize(), 1.2);
  const S = v(2, 3, -1), E = v(.3, -.8).applyQuaternion(frame).add(S), H = v(0, -1.6).applyQuaternion(frame).add(S);
  const target = v(.1, -1.2, .3).applyQuaternion(frame).add(S), hint = v(0, 0, 1).applyQuaternion(frame);
  const solved = solveHingedTwoBone(S, E, H, target, hint, frame, frame);
  assert.ok(forward(S, E, H, solved, frame, frame).distanceTo(target) < 1e-7);
});

it('keeps a continuous signed limb frame through a full target orbit, not a shortest-arc half-turn', () => {
  const S = v(0, 0), E = v(.3, -.8), H = v(0, -1.6), hint = v(0, 0, 1);
  let previous;
  for (let step = 0; step <= 720; step++) {
    const angle = step / 720 * Math.PI * 2, target = v(Math.sin(angle) * 1.2, -Math.cos(angle) * 1.2, .2);
    const solved = solveHingedTwoBone(S, E, H, target, hint, identity, identity);
    assert.ok(forward(S, E, H, solved).distanceTo(target) < 1e-7);
    if (previous) {
      assert.ok(previous.upper.angleTo(solved.upper) < .1, 'upper limb must not roll discontinuously');
      assert.ok(previous.lower.angleTo(solved.lower) < .1, 'lower limb must not roll discontinuously');
    }
    previous = solved;
  }
});

it('preserves physical reach with a straight native limb, a collinear pole and unreachable or fully folded targets', () => {
  for (const upperLength of [1, .005]) {
    const S = v(0, 0), E = v(0, -upperLength), H = v(0, -upperLength - 1), hint = v(0, -1);
    for (const target of [v(0, -1.5), v(0, 0), v(0, 0, -1.5), v(0, -5)]) {
      const solved = solveHingedTwoBone(S, E, H, target, hint, identity, identity), end = forward(S, E, H, solved);
      const distance = end.distanceTo(S);
      assert.ok(distance < upperLength + 1, 'a straight elbow must retain a finite bend rather than overextend');
      assert.ok(distance > Math.abs(upperLength - 1), 'a folded limb must not collapse past its shorter segment');
      if (target.lengthSq()) assert.ok(end.clone().normalize().dot(target.clone().normalize()) > .999999);
    }
  }
});
