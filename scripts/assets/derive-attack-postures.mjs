#!/usr/bin/env bun
/**
 * Derives `src/rendering/AttackPostures.ts`: for every hero skill clip whose striking hand whips (peak speed, sudden rise) the chest coil and
 * forward lean that bring the clip's staging up to the reference game's measured strikes (see pose-harmony-metrics.mjs). Deterministic:
 * a pure function of the delivered hero GLBs, rerun it after re-authoring a clip (tests/rendering/attack-posture.test.mjs checks freshness).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseGlb } from './import-aren-animation-set.mjs';
import { Rig, readClipFrames } from './retarget-aren-tripo-clips.mjs';
import { interpolateFrame } from './vesper-blade-clearance.mjs';
import { analyse } from './pose-harmony-metrics.mjs';
import { HEROES } from './hero-assets.mjs';

const root = new URL('../../', import.meta.url).pathname;
/** Reference strikes (Walden light chain, REA capture): shoulders travel ≈ 30° against the hips and the chest leans ≈ 20° at contact. */
export const TARGET = Object.freeze({ sepTravel: 28, lean: 14 });
export const MAX_COIL_DEGREES = 22, MAX_LEAN_DEGREES = 8;
const SKILL = /^(aren-(light|heavy|charged-heavy$|sigil-bolt|sigil-barrage|judgement|root-tether)|vesper-(iai|shadow-step|thousand|severing|requiem|kunai)|yara-(thornshot|root-spike|root-eruption|sap-lance|seed-storm|binding)|sakda-(limb|echo|resonating|tempest|iron|tigers|hundred|flying))/;
const NAMES = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftShoulder', 'RightShoulder', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftHand', 'RightHand', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot'];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Metrics of one clip in the body frame (x = right, y = up, z = forward), sampled at twice the key rate like the engine's 60 Hz slerp. */
export function clipMetrics(rig, scale, name, { subdivisions = 2 } = {}) {
  const { frames, count, times } = readClipFrames(rig, name), scratch = interpolateFrame(frames, 0), duration = times[count - 1] - times[0], seq = [];
  for (let s = 0; s <= (count - 1) * subdivisions; s += 1) {
    interpolateFrame(frames, s / subdivisions, scratch);
    const world = rig.poseFrame(scratch, 0), bones = {};
    for (const n of NAMES) { const e = world[rig.index.get(`mixamorig:${n}`)].elements; bones[n] = [-e[12] * scale, e[13] * scale, e[14] * scale]; }
    seq.push({ t: s / subdivisions * (duration / (count - 1)), bones });
  }
  const fps = (seq.length - 1) / duration;
  const hands = ['RightHand', 'LeftHand'].map((end) => ({ end, ...analyse(seq, { end, fps }) })).sort((a, b) => b.peakSpeed - a.peakSpeed);
  const hand = hands[0].end, peakIndex = hands[0].peakFrame;
  // Forward reach of the striking hand from its position at the start of the clip to contact (metres): a lean only helps a blow thrown forward.
  const handForward = seq[peakIndex].bones[hand][2] - seq[0].bones[hand][2];
  return { duration, seq, ...hands[0], samples: seq.length, handForward };
}

/** The staging a clip needs, or undefined when it is not a hand strike or already coils enough. */
/** Clips the chest cannot stage: Yara's thornshot-2 is a straight staff thrust placed by the arm layer; the measured coil does not move the shoulders on the posed rig. */
const UNSTAGED = new Set(['yara-thornshot-2']);
export function profileFor(m, name) {
  if (UNSTAGED.has(name)) return undefined;
  // One whip per clip: multi-strike chains (Thousand Cuts, Hundred Elbows), charge holds and slams do not follow a single coil-and-release envelope.
  const peak = m.peakFrame / (m.samples - 1);
  const strike = m.peakSpeed >= 8 && m.peakToWindup >= 1.4 && m.riseFrames <= 10 && peak >= 0.12 && peak <= 0.7 && m.duration <= 0.9 && m.handForward >= 0.1;
  if (!strike) return undefined;
  const coil = clamp(TARGET.sepTravel - m.sepTravel, 0, MAX_COIL_DEGREES), lean = clamp(TARGET.lean - m.leanAtPeak, 0, MAX_LEAN_DEGREES) * Math.min(1, m.handForward / 0.4);
  if (coil < 3 && lean < 2) return undefined;
  // Extend the coil the clip already has; a clip with none coils away from the striking hand (right hand: negative, clockwise from above).
  const sign = m.sepSign !== 0 ? m.sepSign : m.end === 'RightHand' ? -1 : 1;
  return { coilDegrees: Math.round(sign * coil * 2) / 2, leanDegrees: Math.round(lean * 2) / 2, peak: Math.round(m.peakFrame / (m.samples - 1) * 100) / 100 };
}

export function derive() {
  const table = {}, report = {};
  for (const [hero, { glb, scale }] of Object.entries(HEROES)) {
    const source = parseGlb(readFileSync(root + glb)), rig = new Rig(source);
    for (const animation of source.json.animations) {
      if (!SKILL.test(animation.name)) continue;
      const m = clipMetrics(rig, scale, animation.name), profile = profileFor(m, animation.name);
      report[`${hero}/${animation.name}`] = { end: m.end, peakSpeed: m.peakSpeed, sepTravel: m.sepTravel, leanAtPeak: m.leanAtPeak, profile: profile ?? null };
      if (profile) table[animation.name] = profile;
    }
  }
  return { table, report };
}

export function render(table) {
  const rows = Object.entries(table).sort(([a], [b]) => a.localeCompare(b)).map(([id, p]) => `  '${id}': { coil: ${(p.coilDegrees * Math.PI / 180).toFixed(4)}, lean: ${(p.leanDegrees * Math.PI / 180).toFixed(4)}, peak: ${p.peak} },`);
  return `import type { PostureProfile } from './AttackPosture';

/** Generated by scripts/assets/derive-attack-postures.mjs from the delivered hero clips. Do not edit by hand. */
export const ATTACK_POSTURES: Readonly<Record<string, PostureProfile>> = {
${rows.join('\n')}
};
`;
}

if (process.argv[1]?.endsWith('derive-attack-postures.mjs')) {
  const { table, report } = derive();
  writeFileSync(`${root}src/rendering/AttackPostures.ts`, render(table));
  console.log(Object.entries(report).map(([k, v]) => `${k.padEnd(40)} ${v.end.padEnd(10)} spd ${String(v.peakSpeed).padStart(5)} sep ${String(v.sepTravel).padStart(6)} lean ${String(v.leanAtPeak).padStart(6)} -> ${v.profile ? JSON.stringify(v.profile) : '-'}`).join('\n'));
  console.log(Object.keys(table).length, 'profiles');
}
