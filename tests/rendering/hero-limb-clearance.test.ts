import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Vector3 } from 'three';
import { parseGlb } from '../../scripts/assets/import-aren-animation-set.mjs';
import { COMBAT_LIMITS, Rig, jointExcursions, readClipFrames } from '../../scripts/assets/retarget-aren-tripo-clips.mjs';
import { interpolateFrame } from '../../scripts/assets/vesper-blade-clearance.mjs';
import { HEROES } from '../../scripts/assets/hero-assets.mjs';
import { ThreeSkeleton } from '../../scripts/assets/hero-harmony-harness.mjs';
import { exactTakeClips, playsExactTake } from '../../src/rendering/ExactTakes';
import { AREN_HERO_ASSET_ID, SAKDA_HERO_ASSET_ID, VESPER_HERO_ASSET_ID, YARA_HERO_ASSET_ID } from '../../src/game/heroes';

/**
 * The limb-clearance solver on the heroes' delivered clips: it leaves ordinary locomotion alone, never snaps and keeps the arms inside the combat
 * joint limits; Yara's and Aren's exact Mixamo takes are not solved at runtime at all (src/rendering/ExactTakes.ts).
 */
const root = new URL('../../', import.meta.url).pathname;
const LOCOMOTION = ['aren-idle', 'aren-walk', 'aren-run'];

function open(hero: keyof typeof HEROES) {
  const source = parseGlb(readFileSync(root + HEROES[hero].glb)), rig = new Rig(source);
  return { source, rig, skeleton: new ThreeSkeleton(rig), scale: HEROES[hero].scale };
}

describe('limb clearance on the delivered hero clips', () => {
  /** Yara's idle is an exact Mixamo take the runtime solver skips (src/rendering/ExactTakes.ts); her walk and run are retargeted and solved. */
  const MEAN_DEGREES = { yara: 1, vesper: 1, sakda: 1 };
  const ASSET = { yara: YARA_HERO_ASSET_ID, vesper: VESPER_HERO_ASSET_ID, sakda: SAKDA_HERO_ASSET_ID };
  for (const hero of ['yara', 'vesper', 'sakda'] as const) {
    it(`${hero}: idle, walk and run are touched only where an arm really lies in the body (mean correction ≤ ${MEAN_DEGREES[hero]}°)`, () => {
      const { source, rig, skeleton } = open(hero);
      for (const clip of LOCOMOTION.filter((name) => !playsExactTake(ASSET[hero], name) && source.json.animations.some((a: { name: string }) => a.name === name))) {
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

  it('leaves exactly Yara’s exact Mixamo takes to play as captured: the runtime skip list is the provenance’s `exact` clips', () => {
    const provenance = JSON.parse(readFileSync(root + 'asset-source/generated/actor-yara-hero-01/provenance.json', 'utf8')) as { clips: { clip: string; exact?: boolean }[] };
    const exact = provenance.clips.filter((spec) => spec.exact).map((spec) => spec.clip).sort();
    expect(exact.length).toBeGreaterThan(0);
    expect(exactTakeClips(YARA_HERO_ASSET_ID).slice().sort()).toEqual(exact);
  });

  it('lists exactly the contract’s 14 Aren ids as exact takes, and the runtime solver skips each of them', () => {
    const contract = ['aren-idle', 'aren-light-1', 'aren-light-2', 'aren-light-3', 'aren-light-4', 'aren-heavy', 'aren-charged-heavy-charge', 'aren-charged-heavy', 'aren-sigil-charge', 'aren-sigil-bolt', 'aren-sigil-barrage', 'aren-root-tether', 'aren-cleanse', 'aren-judgement'];
    expect(exactTakeClips(AREN_HERO_ASSET_ID).slice().sort()).toEqual(contract.slice().sort());
    for (const clip of contract) expect(playsExactTake(AREN_HERO_ASSET_ID, clip), clip).toBe(true);
    expect(playsExactTake(AREN_HERO_ASSET_ID, 'aren-walk')).toBe(false);
    expect(playsExactTake(AREN_HERO_ASSET_ID, 'dive.001')).toBe(false);
  });
});
