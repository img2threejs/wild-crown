import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ACT_ONE_ATTACK_WINDOWS, ASHA_ATTACK_WINDOWS, ticksFromSeconds, type AttackWindow } from '../../src/game/combat/ActOneBossContent.js';
import {
  ASHA_CLIP_SEGMENTS, ASHA_STALK_REF_SPEED, BAMBOO_ATTACK_PLANS, BAMBOO_CLIP_ACTIONS, BAMBOO_CLIP_SECONDS, BAMBOO_LOCOMOTION, BAMBOO_STORY_ASSETS, segmentPlan,
} from '../../src/rendering/BambooMonsterProfiles.js';
import { MONSTER_LOCOMOTION, isMonsterDefeated, resolveMonsterAnimation } from '../../src/rendering/MonsterAnimationProfiles.js';
import type { MonsterAttackPlan } from '../../src/rendering/MonsterAnimationPlan.js';
import type { ActorSnapshot } from '../../src/game/contracts.js';

const PHASES = ['windup', 'commit', 'active', 'recovery'] as const;
const ASHA = 'actor-asha', KORO_BB = 'actor-koro-branchbreaker';
const root = process.cwd();

interface ManifestEntry { readonly id: string; readonly actionToClipMapping: Readonly<Record<string, string>> }
const manifest = JSON.parse(readFileSync(`${root}/asset-source/playtests/bamboo.json`, 'utf8')) as ManifestEntry[];
const entry = (id: string): ManifestEntry => manifest.find(candidate => candidate.id === id)!;
interface ClipReport { readonly durationSeconds: number; readonly attackWindow?: { readonly seconds: readonly number[] } }
interface ClipsReportFile { readonly clips?: Readonly<Record<string, ClipReport>>; readonly slots?: Readonly<Record<string, ClipReport>> }
/** Clip table of a runtime asset's clips report (the quadruped authoring writes `clips`, the biped authoring `slots`). */
const clipsOf = (dir: string): Readonly<Record<string, ClipReport>> => {
  const file: ClipsReportFile = JSON.parse(readFileSync(`${root}/asset-source/generated/${dir}/clips-report.json`, 'utf8'));
  return file.clips ?? file.slots ?? {};
};

function actor(partial: Partial<ActorSnapshot> = {}): ActorSnapshot {
  return {
    id: 'asha', archetypeId: 'asha', species: 'tiger', allegiance: 'hostile', position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: 1 },
    actionId: 'monster-idle', phase: 'idle', normalizedTime: 0, vitality: 100, maxVitality: 100, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false, ...partial,
  } as unknown as ActorSnapshot;
}
const attacking = (attackId: string, attackPhase: NonNullable<ActorSnapshot['attackPhase']>, progress: number): ActorSnapshot =>
  actor({ actionId: `wild-crown:${attackId}` as never, attackPhase, attackPhaseProgress: progress });

/** The attack phase and progress the simulation reports at the start of absolute tick `tick` of a window. */
function phaseAt(window: AttackWindow, tick: number): { phase: typeof PHASES[number]; progress: number } {
  const bounds = [0, window.anticipationEnd, window.activeStart, window.activeEnd, window.recoveryEnd];
  for (let index = 0; index < 4; index++) if (tick < bounds[index + 1]!) return { phase: PHASES[index]!, progress: (tick - bounds[index]!) / (bounds[index + 1]! - bounds[index]!) };
  return { phase: 'recovery', progress: 1 };
}

describe('bamboo attack plans follow the combat windows', () => {
  it('has a clip plan for every Act I attack id the combat owner publishes', () => {
    for (const attackId of Object.keys(ACT_ONE_ATTACK_WINDOWS)) expect(BAMBOO_ATTACK_PLANS[attackId], attackId).toBeDefined();
  });

  it('runs every finite plan forward through contiguous windows inside the clip', () => {
    for (const [attackId, plan] of Object.entries(BAMBOO_ATTACK_PLANS)) {
      let previousTo = -1, previousAction = '';
      for (const phase of PHASES) {
        const step = (plan as MonsterAttackPlan)[phase];
        if ('loopRate' in step) { expect(step.loopRate, attackId).toBeGreaterThan(0); continue; }
        expect(step.from, attackId).toBeGreaterThanOrEqual(0);
        expect(step.to, attackId).toBeLessThanOrEqual(1);
        expect(step.to, attackId).toBeGreaterThan(step.from);
        if (previousTo >= 0 && previousAction === step.action) expect(step.from, attackId).toBeCloseTo(previousTo, 9);
        previousTo = step.to; previousAction = step.action;
      }
    }
  });

  it('keeps the animation markers of the three custom clips on the approved 60 Hz boundaries (pounce 26/40/60/81, slam 44/54/70/100, charge 29/37/79/93)', () => {
    const expected: Readonly<Record<string, readonly number[]>> = {
      'asha-guarding-pounce': [26, 40, 60, 81], 'asha-corrupted-pounce': [44, 54, 70, 100], 'asha-bamboo-charge': [29, 37, 79, 93],
    };
    for (const [attackId, boundaries] of Object.entries(expected)) {
      const window = ASHA_ATTACK_WINDOWS[attackId as keyof typeof ASHA_ATTACK_WINDOWS];
      expect([window.anticipationEnd, window.activeStart, window.activeEnd, window.recoveryEnd], attackId).toEqual([...boundaries]);
      // The renderer's markers, converted once with the same Math.ceil(seconds * 60), are exactly the combat boundaries.
      expect(ASHA_CLIP_SEGMENTS[attackId]!.markers.map(ticksFromSeconds), attackId).toEqual([...boundaries]);
    }
  });

  it('takes its markers and clip lengths from the shipped clips report', () => {
    const report = clipsOf('actor-asha-runtime-01');
    for (const segments of Object.values(ASHA_CLIP_SEGMENTS)) {
      expect(report[segments.action]!.durationSeconds).toBe(BAMBOO_CLIP_SECONDS[segments.action]);
      expect(report[segments.action]!.attackWindow!.seconds).toEqual([...segments.markers]);
    }
    for (const action of BAMBOO_CLIP_ACTIONS) {
      const dir = action.startsWith('asha') ? 'actor-asha-runtime-01' : action.startsWith('tali') ? 'actor-tali-runtime-01' : action.startsWith('hunter') ? 'actor-camp-hunter-melee-runtime-01' : 'actor-marek-runtime-01';
      expect(clipsOf(dir)[action]!.durationSeconds, action).toBe(BAMBOO_CLIP_SECONDS[action]);
    }
  });

  it('samples the clip at the marker pose on every phase boundary (continuity across windup, commit, active, recovery)', () => {
    for (const [attackId, segments] of Object.entries(ASHA_CLIP_SEGMENTS)) {
      const length = BAMBOO_CLIP_SECONDS[segments.action];
      const at = (phase: typeof PHASES[number], progress: number) => resolveMonsterAnimation(attacking(attackId, phase, progress), ASHA)!;
      expect(at('windup', 0).normalizedTime, attackId).toBeCloseTo(0, 9);
      expect(at('windup', 1).normalizedTime * length, attackId).toBeCloseTo(segments.markers[0], 9);
      expect(at('commit', 0).normalizedTime * length, attackId).toBeCloseTo(segments.markers[0], 9);
      // The active window opens exactly on the active-start marker (the strike pose) and closes on the active-end marker.
      expect(at('active', 0).normalizedTime * length, attackId).toBeCloseTo(segments.markers[1], 9);
      expect(at('active', 1).normalizedTime * length, attackId).toBeCloseTo(segments.markers[2], 9);
      expect(at('recovery', 1).normalizedTime * length, attackId).toBeCloseTo(segments.markers[3], 9);
      expect(at('windup', 0).actionId).toBe(segments.action);
    }
  });

  it('stays within one 60 Hz tick of the authored clip time on every simulation tick of the three custom attacks', () => {
    for (const [attackId, segments] of Object.entries(ASHA_CLIP_SEGMENTS)) {
      const window = ASHA_ATTACK_WINDOWS[attackId as keyof typeof ASHA_ATTACK_WINDOWS];
      const length = BAMBOO_CLIP_SECONDS[segments.action];
      for (let tick = 0; tick <= window.recoveryEnd; tick++) {
        const { phase, progress } = phaseAt(window, tick);
        const sample = resolveMonsterAnimation(attacking(attackId, phase, progress), ASHA)!;
        expect(Math.abs(sample.normalizedTime * length - tick / 60), `${attackId} tick ${tick}`).toBeLessThanOrEqual(1 / 60 + 1e-9);
      }
    }
  });

  it('plays the ground-corruption wave on the slam clip and holds its whole tail through the longer recovery', () => {
    const wave = ACT_ONE_ATTACK_WINDOWS['asha-ground-wave']!;
    const last = resolveMonsterAnimation(attacking('asha-ground-wave', 'recovery', 1), ASHA)!;
    expect(last.actionId).toBe('asha-corrupt-slam');
    expect(last.normalizedTime).toBeCloseTo(1, 9);
    expect(resolveMonsterAnimation(attacking('asha-ground-wave', 'active', 0), ASHA)!.normalizedTime * 1.8).toBeCloseTo(0.9, 9);
    expect(wave.recoveryTicks).toBeGreaterThan(ASHA_ATTACK_WINDOWS['asha-corrupted-pounce'].recoveryTicks);
  });

  it('segmentPlan maps arbitrary markers linearly', () => {
    const plan = segmentPlan('asha-stalk-pounce', [0.3, 0.6, 0.9, 1.5]);
    for (const phase of PHASES) { const step = plan[phase]; expect('from' in step && step.ease).toBe('linear'); }
  });

  it('opens the visible strike on the clip pose that the move owns for the generic-slot attacks', () => {
    // slash strikes ~0.45, shoot expels ~0.5, jump lands 0.7, roar holds from 0.25 (clips report semantic key times).
    const strike: Readonly<Record<string, number>> = {
      'asha-claw-combination': 0.45, 'koro-branch-swing': 0.45, 'koro-rock-throw': 0.68, 'koro-vine-vault': 0.7, 'asha-black-sap-trail': 0.5, 'asha-protective-roar': 0.4,
    };
    for (const [attackId, time] of Object.entries(strike)) {
      const asset = attackId.startsWith('koro') ? KORO_BB : ASHA;
      expect(resolveMonsterAnimation(attacking(attackId, 'active', 0), asset)!.normalizedTime, attackId).toBeCloseTo(time, 6);
    }
  });
});

describe('bamboo clip inventory', () => {
  const slotsOf = (plan: MonsterAttackPlan): string[] => PHASES.map(phase => plan[phase].action);

  it('binds every clip a plan or story state can play on the asset that plays it', () => {
    const asha = entry(ASHA).actionToClipMapping;
    for (const attackId of Object.keys(ASHA_ATTACK_WINDOWS)) for (const action of slotsOf(BAMBOO_ATTACK_PLANS[attackId]!)) expect(asha[action], `${attackId} ${action}`).toBeTruthy();
    const koro = entry(KORO_BB).actionToClipMapping;
    for (const attackId of Object.keys(BAMBOO_ATTACK_PLANS).filter(id => id.startsWith('koro'))) for (const action of slotsOf(BAMBOO_ATTACK_PLANS[attackId]!)) expect(koro[action], `${attackId} ${action}`).toBeTruthy();
    for (const action of ['asha-stalk', 'asha-corrupted-idle', 'asha-cleanse', 'asha-bond-idle']) expect(asha[action], action).toBeTruthy();
    for (const action of ['tali-play', 'tali-nuzzle', 'monster-hurt', 'monster-idle']) expect(entry('actor-tali').actionToClipMapping[action], action).toBeTruthy();
    for (const action of ['npc-talk-relaxed', 'npc-talk-explain', 'npc-talk-point', 'npc-talk-guarded']) expect(entry('actor-marek').actionToClipMapping[action], action).toBeTruthy();
    expect(entry('actor-koro').actionToClipMapping['monster-spawn']).toBeTruthy();
  });

  it('lists every custom clip once and in the manifest of its owner', () => {
    expect(new Set(BAMBOO_CLIP_ACTIONS).size).toBe(BAMBOO_CLIP_ACTIONS.length);
    for (const action of BAMBOO_CLIP_ACTIONS) {
      const owner = action.startsWith('asha') ? ASHA : action.startsWith('tali') ? 'actor-tali' : action.startsWith('hunter') ? 'actor-camp-hunter-melee' : 'actor-marek';
      expect(entry(owner).actionToClipMapping[action], action).toBe(action);
    }
  });

  it('has a locomotion profile for every bamboo story asset that walks (without one a monster never animates)', () => {
    for (const asset of Object.keys(BAMBOO_STORY_ASSETS)) expect(MONSTER_LOCOMOTION[asset], asset).toBeDefined();
    for (const [asset, profile] of Object.entries(BAMBOO_LOCOMOTION)) {
      expect(profile.walkRef, asset).toBeGreaterThan(0);
      expect(profile.runRef, asset).toBeGreaterThan(profile.walkRef);
      expect(profile.runThreshold, asset).toBeGreaterThan(profile.walkRef);
    }
    expect(ASHA_STALK_REF_SPEED).toBeCloseTo(BAMBOO_LOCOMOTION[ASHA]!.walkRef * 0.75, 9);
  });

  it('derives the quadruped walk references from the measured planted-foot speed', () => {
    // planted speed (units/s) x manifest scale, rounded to 0.05 m/s: Asha 0.5507 x 2.217, Tali 1.05 x 1.356.
    expect(BAMBOO_LOCOMOTION[ASHA]!.walkRef).toBeCloseTo(Math.round(0.5507 * 2.217 / 0.05) * 0.05, 9);
    expect(BAMBOO_LOCOMOTION['actor-tali']!.walkRef).toBeCloseTo(Math.round(1.05 * 1.356 / 0.05) * 0.05, 9);
  });
});

describe('a story status is never a defeat', () => {
  it('keeps a cleansed, reunited, subdued or sheltered actor alive whatever its vitality', () => {
    for (const status of ['cleansed', 'reunion', 'subdued', 'kneeling', 'in-danger', 'sheltered'] as const) {
      expect(isMonsterDefeated(actor({ vitality: 0, chapterStatus: status })), status).toBe(false);
    }
    expect(isMonsterDefeated(actor({ vitality: 0 }))).toBe(true);
    expect(isMonsterDefeated(actor({ vitality: 0, chapterStatus: 'sealed' }))).toBe(true);
  });
});
