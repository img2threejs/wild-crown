import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { parseGlb } from '../../scripts/assets/import-aren-animation-set.mjs';
import { COMBAT_LIMITS, Rig, jointExcursions, readClipFrames } from '../../scripts/assets/retarget-aren-tripo-clips.mjs';
import { interpolateFrame } from '../../scripts/assets/vesper-blade-clearance.mjs';
import { HEROES } from '../../scripts/assets/hero-assets.mjs';
import { openHero, penetrations } from '../../scripts/assets/audit-hero-mesh-intersection.mjs';
import { ThreeSkeleton } from '../../scripts/assets/hero-harmony-harness.mjs';

/**
 * The limb-clearance solver on the four heroes' delivered clips: it leaves ordinary locomotion alone, never snaps, keeps the arms inside the
 * combat joint limits, and removes the arm-through-body overlap that the mesh-level audit (scripts/assets/audit-hero-mesh-intersection.mjs)
 * finds in the skill poses.
 */
const root = new URL('../../', import.meta.url).pathname;
const LOCOMOTION = ['aren-idle', 'aren-walk', 'aren-run'];

function open(hero: keyof typeof HEROES) {
  const source = parseGlb(readFileSync(root + HEROES[hero].glb)), rig = new Rig(source);
  return { source, rig, skeleton: new ThreeSkeleton(rig), scale: HEROES[hero].scale };
}

describe('limb clearance on the delivered hero clips', () => {
  /** Yara's idle holds a hand inside her thigh (166 buried mesh vertices before the solver), so it is the one gait that is corrected visibly. */
  const MEAN_DEGREES = { yara: 12, vesper: 1, sakda: 1 };
  for (const hero of ['yara', 'vesper', 'sakda'] as const) {
    it(`${hero}: idle, walk and run are touched only where an arm really lies in the body (mean correction ≤ ${MEAN_DEGREES[hero]}°)`, () => {
      const { source, rig, skeleton } = open(hero);
      for (const clip of LOCOMOTION.filter((name) => source.json.animations.some((a: { name: string }) => a.name === name))) {
        const { frames, count } = readClipFrames(rig, clip), scratch = interpolateFrame(frames, 0);
        let sum = 0, samples = 0;
        for (let s = 0; s <= (count - 1) * 2; s += 1) {
          interpolateFrame(frames, s / 2, scratch); skeleton.setFrame(scratch, 0); skeleton.clearance.apply();
          sum += skeleton.clearance.lastCorrection; samples += 1;
        }
        expect(sum / samples * 180 / Math.PI, `${hero} ${clip}`).toBeLessThan(MEAN_DEGREES[hero]);
      }
    });
  }

  it('never snaps an arm: at 60 Hz the solved elbow and hand stay within 35 cm of the clip’s own displacement, and 99.9% within 8 cm', () => {
    const deviations: number[] = [];
    for (const hero of ['yara', 'vesper', 'sakda'] as const) {
      const { source, rig, skeleton, scale } = open(hero);
      const joints = ['LeftForeArm', 'LeftHand', 'RightForeArm', 'RightHand'].map((name) => skeleton.byName(name));
      for (const animation of source.json.animations as { name: string }[]) {
        const { frames, count } = readClipFrames(rig, animation.name), scratch = interpolateFrame(frames, 0);
        let rawPrevious: Vector3[] | undefined, solvedPrevious: Vector3[] | undefined;
        skeleton.clearance.reset();
        for (let s = 0; s <= (count - 1) * 2; s += 1) {
          interpolateFrame(frames, s / 2, scratch); skeleton.setFrame(scratch, 0);
          const raw = joints.map((j) => new Vector3().setFromMatrixPosition(j.matrixWorld));
          skeleton.clearance.apply(1 / 60);
          const solved = joints.map((j) => new Vector3().setFromMatrixPosition(j.matrixWorld));
          if (rawPrevious && solvedPrevious) for (let i = 0; i < 4; i += 1) deviations.push(solved[i]!.clone().sub(solvedPrevious[i]!).sub(raw[i]!.clone().sub(rawPrevious[i]!)).length() * scale);
          rawPrevious = raw; solvedPrevious = solved;
        }
      }
    }
    deviations.sort((a, b) => a - b);
    expect(deviations.at(-1)!).toBeLessThan(0.35);
    expect(deviations[Math.floor(deviations.length * 0.999)]!).toBeLessThan(0.08);
  });

  it('keeps every arm inside the combat joint limits to within 8° of what the clip itself reaches', () => {
    for (const hero of ['yara', 'vesper', 'sakda'] as const) {
      const { source, rig, skeleton } = open(hero);
      for (const animation of source.json.animations as { name: string }[]) {
        const { frames, count } = readClipFrames(rig, animation.name);
        const solved = { rotations: frames.rotations.map((t: Float32Array | undefined) => t && Float32Array.from(t)), positions: frames.positions };
        skeleton.clearance.reset();
        for (let k = 0; k < count; k += 1) {
          skeleton.setFrame(frames, k); skeleton.clearance.apply(1 / 30);
          skeleton.nodes.forEach((node, i) => { if (solved.rotations[i]) node.quaternion.toArray(solved.rotations[i], k * 4); });
        }
        const before = jointExcursions(rig, frames, count, COMBAT_LIMITS), after = jointExcursions(rig, solved, count, COMBAT_LIMITS);
        for (const joint of Object.keys(after)) {
          const added = Math.max(0, after[joint].swing - COMBAT_LIMITS[joint].swing) - Math.max(0, before[joint].swing - COMBAT_LIMITS[joint].swing);
          expect(added, `${hero} ${animation.name} ${joint}`).toBeLessThan(8);
        }
      }
    }
  }, 120_000);

  it('keeps Yara’s Root Spike out of her own body: the authored clip and the solved pose bury at most a handful of mesh vertices (committed clip buried 194)', async () => {
    const context = await openHero('yara'), { rig } = context, skeleton = new ThreeSkeleton(rig);
    const { frames, count } = readClipFrames(rig, 'yara-root-spike'), scratch = interpolateFrame(frames, 0);
    let authored = 0, solved = 0;
    for (let frame = 0; frame <= count - 1; frame += 2) {
      interpolateFrame(frames, frame, scratch);
      authored = Math.max(authored, penetrations(context, rig.poseFrame(scratch, 0)).reduce((n: number, e: { verts: number }) => n + e.verts, 0));
      skeleton.setFrame(scratch, 0);
      solved = Math.max(solved, penetrations(context, skeleton.solve()).reduce((n: number, e: { verts: number }) => n + e.verts, 0));
    }
    expect(authored).toBeLessThan(20);
    expect(solved).toBeLessThan(20);
  }, 240_000);
});
