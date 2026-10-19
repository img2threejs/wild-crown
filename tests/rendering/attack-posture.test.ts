import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { parseGlb } from '../../scripts/assets/import-aren-animation-set.mjs';
import { Rig, readClipFrames } from '../../scripts/assets/retarget-aren-tripo-clips.mjs';
import { interpolateFrame } from '../../scripts/assets/vesper-blade-clearance.mjs';
import { HEROES } from '../../scripts/assets/hero-assets.mjs';
import { analyse } from '../../scripts/assets/pose-harmony-metrics.mjs';
import { ThreeSkeleton } from '../../scripts/assets/hero-harmony-harness.mjs';
import { TARGET, derive, render } from '../../scripts/assets/derive-attack-postures.mjs';
import { applyPosture, postureEnvelope } from '../../src/rendering/AttackPosture.js';
import { ATTACK_POSTURES } from '../../src/rendering/AttackPostures.js';

const root = new URL('../../', import.meta.url).pathname;
const NAMES = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftShoulder', 'RightShoulder', 'LeftArm', 'RightArm', 'LeftForeArm', 'RightForeArm', 'LeftHand', 'RightHand', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot'];

describe('attack posture profiles', () => {
  it('are the deterministic function of the delivered hero clips (rerun scripts/assets/derive-attack-postures.mjs after re-authoring one)', () => {
    expect(readFileSync(`${root}src/rendering/AttackPostures.ts`, 'utf8')).toBe(render(derive().table));
  });

  it('bring each staged strike’s shoulder coil up to the reference game’s (measured on the posed rig, hand peak speed kept within 12%)', () => {
    const forward = new Vector3(0, 0, 1), factors = { coil: 0, lean: 0 };
    let checked = 0;
    for (const [hero, { glb, scale }] of Object.entries(HEROES)) {
      const source = parseGlb(readFileSync(root + glb)), rig = new Rig(source), skeleton = new ThreeSkeleton(rig);
      const spine = ['Spine', 'Spine1', 'Spine2'].map((name) => skeleton.byName(name));
      for (const animation of source.json.animations as { name: string }[]) {
        const profile = ATTACK_POSTURES[animation.name];
        if (!profile || Math.abs(profile.coil) < 3 * Math.PI / 180) continue;
        const { frames, count, times } = readClipFrames(rig, animation.name), scratch = interpolateFrame(frames, 0), duration = times[count - 1] - times[0];
        const measure = (staged: boolean) => {
          const sequence = [];
          for (let s = 0; s <= (count - 1) * 2; s += 1) {
            interpolateFrame(frames, s / 2, scratch); skeleton.setFrame(scratch, 0);
            if (staged) { postureEnvelope(profile.peak, s / ((count - 1) * 2), factors); applyPosture(spine, forward, profile.coil * factors.coil, profile.lean * factors.lean); skeleton.root.updateMatrixWorld(true); }
            const bones: Record<string, number[]> = {};
            for (const name of NAMES) { const e = skeleton.byName(name).matrixWorld.elements; bones[name] = [-e[12]! * scale, e[13]! * scale, e[14]! * scale]; }
            sequence.push({ t: s / 2 * (duration / (count - 1)), bones });
          }
          const fps = (sequence.length - 1) / duration;
          return ['RightHand', 'LeftHand'].map((end) => ({ end, ...analyse(sequence, { end, fps }) })).sort((a: { peakSpeed: number }, b: { peakSpeed: number }) => b.peakSpeed - a.peakSpeed)[0]!;
        };
        const before = measure(false), after = measure(true);
        expect(after.sepTravel, `${hero} ${animation.name}`).toBeGreaterThanOrEqual(Math.min(TARGET.sepTravel - 6, before.sepTravel + 0.45 * Math.abs(profile.coil) * 180 / Math.PI));
        expect(after.peakSpeed / before.peakSpeed, `${hero} ${animation.name} peak speed`).toBeGreaterThan(0.88);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(3);
  });
});
