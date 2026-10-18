import { Quaternion } from 'three';
import { bipedPose, viperPose } from './author-creature-clips.mjs';
import { PoseBuilder, curve, smoothstep } from './creature-rig-kit.mjs';

const clamp = t => Math.max(0, Math.min(1, t));
const c = (u, keys) => curve(keys, u);

export function airborneAttack(spec, u) {
  if (/^(cartwheel-counter|back-handspring|dive-roll)$/.test(spec.motion)) return u > .08 && u < .86;
  return /pounce|leap|vault|smash|mud-hop|dive|corrupted-slam/.test(spec.motion) && u >= .35 && u < .5;
}

export function elapsedAttackSeconds(attack, ends, u) {
  const durations = [attack.windupTicks, attack.commitTicks, attack.activeTicks, attack.recoveryTicks];
  const starts = [0, durations[0], durations[0] + durations[1], durations[0] + durations[1] + durations[2]];
  let phase = ends.findIndex(end => u < end);
  if (phase < 0) phase = 3;
  const from = phase ? ends[phase - 1] : 0;
  return (starts[phase] + durations[phase] * clamp((u - from) / (ends[phase] - from))) / 60;
}

/** Anatomical IK keeps the base species' planted feet and fixed-length chains; only the commanded effectors differ. */
export function quadAttackPose(a, spec, u, solve) {
  const H = a.H, motion = spec.motion;
  const load = c(u, [[0, 0], [.27, 1], [.35, .8], [.5, 0, 'in'], [.75, 0], [1, 0]]);
  const hit = c(u, [[0, 0], [.35, 0], [.5, 1, 'in'], [.63, .5], [.82, 0], [1, 0]]);
  const ctl = { bodyUp: -H * (.035 * load + .02 * hit), torso: [-3 * load, 0, 0], neck: [3 * load, 0, 0], head: [0, 0, 0], legs: {} };
  if (/charge|rush/.test(motion) && !/pounce/.test(motion)) {
    const seconds = Math.max(0, a.elapsed(Math.min(u, .75)) - a.elapsed(.5)), period = /armored|bamboo/.test(motion) ? .58 : .46;
    const phase = seconds / period + .31, gain = c(u, [[0, 0], [.35, 0], [.5, 1], [.75, 1], [.9, 0], [1, 0]]);
    for (const [key, offset] of [['FL', 0], ['HR', 0], ['FR', .5], ['HL', .5]]) {
      const p = (phase + offset) % 1, stance = .62;
      ctl.legs[key] = p < stance ? { fwd: H * .25 * gain * (.5 - p / stance), up: 0 }
        : { fwd: H * .25 * gain * (-.5 + smoothstep((p - stance) / (1 - stance))), up: H * .09 * gain * Math.sin(Math.PI * (p - stance) / (1 - stance)) };
    }
    ctl.bodyUp = -H * (.035 + .015 * Math.sin(phase * Math.PI * 4) ** 2) * smoothstep(u / .12) * smoothstep((1 - u) / .12);
    ctl.torso = [-7 * load - 5 * hit, 0, motion === 'side-charge' ? 6 * load : 0];
    ctl.neck = [-5 * hit, 0, 0]; ctl.head = [-4 * hit, 0, 0];
  } else if (/pounce|leap|smash|mud-hop|corrupted-slam/.test(motion)) {
    const airborne = u >= .35 && u < .5, arc = airborne ? Math.sin(Math.PI * (u - .35) / .15) : 0;
    const heavy = /corrupted|guardian|chain/.test(motion), height = heavy ? .18 : .29;
    ctl.rootUp = H * height * arc; ctl.bodyUp = -H * (.075 * load + .045 * hit);
    ctl.hip = [6 * load - 5 * hit, 0, 0]; ctl.torso = [-8 * load + 7 * arc - 9 * hit, 0, 0];
    ctl.neck = [3 * arc - 5 * hit, 0, 0]; ctl.head = [5 * load - 4 * hit, 0, 0];
    ctl.flightWeight = arc;
    if (airborne) { ctl.plant = false; ctl.rigidLegs = true; }
    for (const key of ['FL', 'FR', 'HL', 'HR']) ctl.legs[key] = { up: H * (key[0] === 'F' ? .12 : .08) * arc,
      fwd: H * (key[0] === 'F' ? .08 : -.06) * arc };
  } else if (/tail/.test(motion)) {
    const whip = c(u, [[0, 0], [.28, 25], [.35, 32], [.5, -48, 'in'], [.65, -25], [.84, 5], [1, 0]]);
    const tail = a.quad.restP[a.quad.tailTip].clone().sub(a.quad.restP[a.quad.tail[0]]);
    const down = Math.abs(tail.y) / tail.length();
    ctl.torso = [0, .15 * whip, 0]; ctl.neck = [0, -.15 * whip, 0];
    ctl.tail = [4 * load, whip * Math.sqrt(1 - down * down), whip * down];
  } else if (/claw|paw-slam/.test(motion)) {
    const keys = motion === 'double-claw' ? ['FR', 'FL'] : [spec.socket === 'paw-left' ? 'FL' : 'FR'];
    keys.forEach((key, i) => {
      const strike = .5 + i * .125;
      ctl.legs[key] = { up: H * c(u, [[0, 0], [strike - .18, .12], [strike - .08, .22], [strike, .025, 'in'], [strike + .14, 0], [1, 0]]),
        fwd: H * c(u, [[0, 0], [strike - .12, -.08], [strike, .24, 'in'], [strike + .14, .08], [1, 0]]), left: H * .035 * (key === 'FL' ? 1 : -1) * hit };
    });
    ctl.torso = [4 * load - 8 * hit, 5 * load - 9 * hit, 0]; ctl.head = [-4 * hit, 0, 0];
  } else if (/stamp|slam|bloom|burst|wave|surge|thrash|shake/.test(motion)) {
    const lift = c(u, [[0, 0], [.25, .13], [.35, .18], [.5, 0, 'in'], [.65, 0], [1, 0]]);
    ctl.legs = { FL: { up: H * lift, fwd: H * .055 * load }, FR: { up: H * lift * .9, fwd: H * .06 * load } };
    ctl.torso = [7 * load - 12 * hit, 0, motion === 'stone-shake' ? Math.sin(u * Math.PI * 10) * load * 4 : 0];
    ctl.neck = [-7 * hit, 0, 0]; ctl.head = [4 * load - 8 * hit, 0, 0];
  } else if (/sweep|scythe|snap|bite|lunge/.test(motion)) {
    ctl.torso = [0, 9 * load - 13 * hit, 0]; ctl.neck = [5 * load - 6 * hit, 12 * load - 18 * hit, 0];
    ctl.head = [6 * load - 8 * hit, 5 * load - 10 * hit, 0];
    if (/bite|maw|lunge/.test(motion)) { ctl.torso[1] *= .25; ctl.neck[1] *= .25; ctl.jaw = [12 * hit, 0, 0]; }
  } else if (/breath|exhale|spit|tongue/.test(motion)) {
    const release = c(u, [[0, 0], [.25, 0], [.35, 1, 'in'], [.65, .65], [.85, .25], [1, 0]]);
    ctl.torso = [3 * load - 4 * release, 0, 0]; ctl.neck = [13 * load - 8 * release, 0, 0];
    ctl.head = [7 * load - 9 * release, 0, 0]; ctl.jaw = [14 * release, 0, 0];
  } else if (/roar|howl|call/.test(motion)) {
    const voice = c(u, [[0, 0], [.25, .4], [.35, 1], [.65, .9], [.82, .4], [1, 0]]);
    const low = /low-howl/.test(motion);
    ctl.torso = [(low ? -4 : 5) * voice, 0, 0]; ctl.neck = [(low ? 3 : 15) * voice, 0, 0];
    ctl.head = [(low ? 4 : 12) * voice, motion === 'pack-call' ? 7 * voice : 0, 0]; ctl.jaw = [12 * voice, 0, 0];
    if (motion === 'protective-roar') ctl.legs.FL = { fwd: H * .075 * voice, left: H * .04 * voice };
  } else throw new Error(`No anatomical quadruped attack controls for ${motion}`);
  return solve(a, ctl);
}

/** Body-space IK avoids the floor-penetrating and flipping arms in the generic Tripo Howler strikes. */
export function bipedAttackPose(a, spec, u) {
  if (!a.ctx?.arm || a.rig.nodes[a.ctx.head].name.startsWith('mixamorig:')) return undefined;
  if (spec.motion === 'canopy-shake') return undefined;
  const H = a.H, ctx = a.ctx, motion = spec.motion;
  const load = c(u, [[0, 0], [.27, 1], [.35, .7], [.5, 0], [.8, 0], [1, 0]]);
  const hit = c(u, [[0, 0], [.35, 0], [.5, 1, 'in'], [.7, .35], [1, 0]]);
  const ctl = { up: -H * .035 * load, hip: [-3 * load, 0, 0], torso: [0, 0, 0], neck: [0, 0, 0], head: [0, 0, 0], arms: {} };
  for (const side of ['L', 'R']) ctl.arms[side] = { from: ctx.arm[side][0], at: [H * .16, -H * .24, H * .08 * (side === 'L' ? 1 : -1)] };
  const side = spec.socket === 'hand-left' ? 'L' : 'R', sign = side === 'L' ? 1 : -1;
  if (/hurl|toss|lob|throw|scatter/.test(motion)) {
    const release = c(u, [[0, 0], [.35, 0], [.5, 1, 'in'], [.65, .8], [.82, .2], [1, 0]]);
    ctl.torso = [6 * load - 10 * release, -16 * load + 19 * release, -3 * load];
    ctl.arms[side].at = [H * (.16 - .36 * load + .32 * release), H * (-.24 + .35 * load + .2 * release), sign * H * .12];
    ctl.arms[side === 'L' ? 'R' : 'L'].at[0] += H * .12 * load;
  } else if (/sweep|lash/.test(motion)) {
    ctl.torso = [0, sign * (-19 * load + 24 * hit), 0]; ctl.hip = [0, sign * (-5 * load + 8 * hit), 0];
    ctl.arms[side].at = [H * (.16 + .22 * hit), -H * (.24 - .15 * load), sign * H * (.08 + .2 * load - .2 * hit)];
    if (motion === 'antler-sweep') {
      ctl.neck = [0, -12 * load + 17 * hit, 0]; ctl.head = [0, -16 * load + 22 * hit, 0];
      for (const s of ['L', 'R']) ctl.arms[s].at = [H * .16, -H * .24, H * .08 * (s === 'L' ? 1 : -1)];
    }
  } else if (/leap|smash|vault/.test(motion)) {
    const flight = u >= .35 && u < .5 ? Math.sin(Math.PI * (u - .35) / .15) : 0;
    ctl.up = H * (-.065 * load + .25 * flight - .055 * hit); ctl.feetCarried = flight;
    ctl.hip = [-4 * load + 5 * flight - 6 * hit, 0, 0]; ctl.torso = [-8 * load + 7 * flight - 18 * hit, 0, 0];
    for (const s of ['L', 'R']) ctl.arms[s].at = [H * (.16 + .12 * hit), H * (-.24 + .38 * load + .16 * flight - .035 * hit), H * .12 * (s === 'L' ? 1 : -1)];
  } else if (/ripple|tap|stamp|pulse|burst|heartlight/.test(motion)) {
    const release = c(u, [[0, 0], [.35, 0], [.5, 1, 'in'], [.7, .4], [1, 0]]);
    ctl.up = -H * (.04 * load + .07 * release); ctl.torso = [5 * load - 16 * release, 0, 0];
    for (const s of ['L', 'R']) ctl.arms[s].at = [H * (.16 + .12 * release), H * (-.24 + .2 * load - .05 * release), H * .1 * (s === 'L' ? 1 : -1)];
    if (motion === 'heartlight-release') {
      ctl.up = -H * .025 * load; ctl.torso = [8 * release, 0, 0];
      for (const s of ['L', 'R']) ctl.arms[s].at = [H * .2, H * (-.24 + .28 * release), H * (.08 + .22 * release) * (s === 'L' ? 1 : -1)];
    }
  } else if (/charge/.test(motion)) {
    ctl.torso = [-12 * load - 9 * hit, 0, 0];
    for (const s of ['L', 'R']) ctl.arms[s].at = [H * (.18 + .15 * hit), -H * .27, H * .1 * (s === 'L' ? 1 : -1)];
  } else throw new Error(`No anatomical biped attack controls for ${motion}`);
  // Author within this rig's actual reach, not an assumed fraction of overall creature height.
  // Fully straight elbows have no stable bend plane and snap when an over-reaching hand crosses it.
  for (const s of ['L', 'R']) {
    const [upper, lower, hand] = ctx.arm[s], at = ctl.arms[s].at;
    const reach = .9 * (ctx.restP[upper].distanceTo(ctx.restP[lower]) + ctx.restP[lower].distanceTo(ctx.restP[hand]));
    const length = Math.hypot(...at);
    if (length > reach) for (let axis = 0; axis < 3; axis++) at[axis] *= reach / length;
    ctl.arms[s].hint = a.body.U.clone().negate();
  }
  return bipedPose(ctx, ctl).pb.solve();
}

/** A planted coil and moving neck: Root's original pivot compensation must not be mistaken for gameplay travel. */
export function serpentAttackPose(a, spec, u) {
  if (a.family !== 'serpentine') return undefined;
  const load = c(u, [[0, 0], [.27, 1], [.35, .8], [.5, 0], [.8, 0], [1, 0]]);
  const hit = c(u, [[0, 0], [.35, 0], [.5, 1, 'in'], [.7, .4], [1, 0]]);
  const release = c(u, [[0, 0], [.27, 0], [.35, 1, 'in'], [.65, .6], [1, 0]]);
  const ctl = { rear: [12 * load - 4 * hit, 0, 0], head: [6 * load - 3 * hit, 0, 0], wave: { t: u, cycles: 1, amp: 2 * (load + hit), k: .08, taper: 1.5 } };
  if (spec.motion === 'tail-lash') {
    ctl.rear = [2 * load, -6 * load + 7 * hit, 0]; ctl.head = [0, -5 * load + 8 * hit, 0];
    ctl.lash = i => (9 * load - 16 * hit) * (.2 + .8 * (i / 9) ** 1.4);
  } else if (spec.motion === 'venom-spit') { ctl.rear = [15 * load - 2 * release, 0, 0]; ctl.head = [8 * load - 4 * release, 0, 0]; }
  else if (spec.motion !== 'bite-lunge') throw new Error(`No anatomical serpent attack controls for ${spec.motion}`);
  return viperPose(a.ctx, ctl).pb.solve();
}

/** Spherical arm elevation cannot flip when Orun's native downward arm axis passes the linear blend's zero vector. */
export function cartwheelAttackPose(a, spec, u) {
  if (spec.motion !== 'cartwheel-counter') return undefined;
  const t = curve([[0, 0], [.35, .3], [.5, .45, 'in'], [.75, .7, 'lin'], [1, 1, 'out']], u);
  const gate = smoothstep(t / .15) * smoothstep((1 - t) / .15);
  const roll = new Quaternion().setFromAxisAngle(a.body.F, Math.PI * 2 * smoothstep((t - .1) / .8));
  const inverse = roll.clone().invert(), pb = new PoseBuilder(a.rig).rotate(a.hip, roll);
  for (const [side, sign] of [['L', 1], ['R', -1]]) {
    const [upper, lower] = a.ctx.arm[side], [thigh] = a.ctx.leg[side];
    const native = a.rig.restP[lower].clone().sub(a.rig.restP[upper]).normalize();
    const elevation = new Quaternion().slerp(new Quaternion().setFromUnitVectors(native, a.body.U), gate);
    pb.rotate(upper, roll.clone().multiply(elevation).multiply(inverse));
    const split = new Quaternion().setFromAxisAngle(a.body.F, sign * .6 * Math.sin(Math.PI * t));
    pb.rotate(thigh, roll.clone().multiply(split).multiply(inverse));
  }
  return pb.solve();
}
