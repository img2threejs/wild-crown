import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CombatEngine, createEngineState, makeActor, type CombatInput } from '../../src/game/combat/CombatEngine.js';
import { vec } from '../../src/game/combat/geometry.js';
import { EVASION_PROFILES } from '../../src/game/combat/evasion.js';
import { JUDGEMENT, LIGHT_STEPS, SIGIL } from '../../src/game/combat/PlayerSkills.js';

interface ClipReport {
  readonly action: string;
  readonly outputDurationSeconds: number;
  readonly simulation?: { readonly totalTicks: number; readonly activeTick?: number };
  readonly contact?: { readonly outputNormalizedTime: number };
  readonly parts?: ReadonlyArray<{ readonly ticks: readonly [number, number] }>;
  readonly tickToSourceSeconds?: ReadonlyArray<readonly [number, number]>;
  readonly loop?: { readonly periodSeconds: number };
}
const report = JSON.parse(readFileSync(new URL('../../asset-source/generated/actor-aren-user-supplied-01/retarget-report.json', import.meta.url), 'utf8')) as { clips: ClipReport[] };
const clip = (action: string): ClipReport => report.clips.find((entry) => entry.action === action)!;

const idle: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };

function engineState() {
  const state = createEngineState();
  state.arena.bounds = { min: vec(-20, -2, -20), max: vec(20, 20, 20) };
  state.actors = [state.actors[0]!, makeActor('corrupted-boar', 'boar', 'hostile', vec(0, 0, -1.6), true, false, 1000)];
  state.player.vitality = state.player.maxVitality = 1000;
  state.player.mana = state.player.maxMana;
  state.targetId = 'corrupted-boar';
  return state;
}

/** Steps the engine until the player's pending impact resolves; returns the action length and the normalized time of the hit tick. */
function measure(engine: CombatEngine, input: (tick: number) => CombatInput = () => idle): { totalTicks: number; hitFraction: number } {
  for (let tick = 0; tick < 200; tick += 1) {
    engine.fixedStep(input(tick));
    const state = engine.snapshotState();
    const player = state.actors.find((actor) => actor.id === 'aren')!;
    if (state.pendingImpact?.resolved) {
      const totalTicks = player.actionEndsTick - player.actionStartedTick;
      return { totalTicks, hitFraction: (state.tick - player.actionStartedTick) / totalTicks };
    }
  }
  throw new Error('the action never resolved its impact');
}

const heavyAfter = (heldTicks: number) => (tick: number): CombatInput => (tick === 0 ? { ...idle, heavyPressed: true, heavyHeld: true } : tick === 1 ? { ...idle, heavyReleased: true, heavyHeldTicks: heldTicks } : idle);

describe('Aren combat clips meet the simulation hit tick', () => {
  const cases: Array<[string, () => { totalTicks: number; hitFraction: number }]> = [
    ['aren-heavy', () => measure(new CombatEngine(engineState()), heavyAfter(10))],
    ['aren-charged-heavy', () => measure(new CombatEngine(engineState()), heavyAfter(40))],
    ['aren-root-tether', () => {
      const state = engineState();
      state.telegraphs.push({ id: 'timing-telegraph', attackId: 'boar-ember-lance', sourceId: 'corrupted-boar', targetPosition: vec(0, 0, 0), phase: 'windup', remainingTicks: 600, cue: 'test' } as never);
      const engine = new CombatEngine(state);
      expect(engine.useAbility('root-tether', 'corrupted-boar')).toBe(true);
      return measure(engine);
    }],
    ['aren-cleanse', () => {
      const state = engineState();
      state.actors.find((actor) => actor.id === 'corrupted-boar')!.corruption = 60;
      const engine = new CombatEngine(state);
      expect(engine.useAbility('cleanse', 'corrupted-boar')).toBe(true);
      return measure(engine);
    }],
  ];

  for (const [action, run] of cases) {
    it(`${action}: clip length and strike frame match the simulated action`, () => {
      const entry = clip(action);
      const { totalTicks, hitFraction } = run();
      expect(entry.simulation!.totalTicks).toBe(totalTicks);
      expect(Math.abs(entry.outputDurationSeconds * 60 - totalTicks)).toBeLessThanOrEqual(2);
      // The engine resolves the impact on `activeAt`; allow the single tick between the resolve and the normalizedTime refresh.
      expect(Math.abs(entry.contact!.outputNormalizedTime - hitFraction)).toBeLessThanOrEqual(1.5 / totalTicks);
      expect(entry.simulation!.activeTick! / totalTicks).toBeCloseTo(entry.contact!.outputNormalizedTime, 4);
    });
  }

  it('aren-back-handspring spans the evasion profile (flight + recovery)', () => {
    const profile = EVASION_PROFILES.back_handspring;
    expect(clip('aren-back-handspring').simulation!.totalTicks).toBe(profile.durationTicks + profile.recoveryTicks);
    expect(Math.abs(clip('aren-back-handspring').outputDurationSeconds * 60 - (profile.durationTicks + profile.recoveryTicks))).toBeLessThanOrEqual(2);
  });
});

describe('Warden Arsenal clips follow the simulation skill table', () => {
  LIGHT_STEPS.forEach((step, index) => {
    it(`aren-light-${index + 1} spans ${step.ticks} ticks and strikes on tick ${step.activeFrom}`, () => {
      const entry = clip(`aren-light-${index + 1}`);
      expect(entry.simulation!.totalTicks).toBe(step.ticks);
      expect(entry.simulation!.activeTick).toBe(step.activeFrom);
      expect(Math.abs(entry.outputDurationSeconds * 60 - step.ticks)).toBeLessThanOrEqual(2);
    });
  });

  it('aren-sigil-bolt releases on the launch tick and aren-sigil-barrage thrusts on every launch tick', () => {
    expect(clip('aren-sigil-bolt').simulation).toEqual({ totalTicks: SIGIL.boltTicks, activeTick: SIGIL.boltLaunchTick });
    expect(Math.abs(clip('aren-sigil-bolt').outputDurationSeconds * 60 - SIGIL.boltTicks)).toBeLessThanOrEqual(2);
    expect(clip('aren-sigil-barrage').simulation!.totalTicks).toBe(SIGIL.barrageTicks);
    const keyTicks = clip('aren-sigil-barrage').tickToSourceSeconds!.map(([tick]) => tick);
    for (const launch of SIGIL.barrageLaunchTicks) expect(keyTicks).toContain(launch);
    expect(Math.abs(clip('aren-sigil-barrage').outputDurationSeconds * 60 - SIGIL.barrageTicks)).toBeLessThanOrEqual(2);
  });

  it('aren-sigil-charge is a seamless loop (it has no simulated length)', () => {
    expect(clip('aren-sigil-charge').simulation).toBeUndefined();
    expect(clip('aren-sigil-charge').loop!.periodSeconds).toBeCloseTo(clip('aren-sigil-charge').outputDurationSeconds, 5);
  });

  it('aren-judgement spans the action and changes pose exactly at the dash and recovery ticks', () => {
    const entry = clip('aren-judgement');
    expect(entry.simulation!.totalTicks).toBe(JUDGEMENT.ticks);
    expect(Math.abs(entry.outputDurationSeconds * 60 - JUDGEMENT.ticks)).toBeLessThanOrEqual(2);
    const boundaries = entry.parts!.map((part) => part.ticks[0]);
    expect(boundaries).toContain(JUDGEMENT.dashFrom);
    expect(boundaries).toContain(JUDGEMENT.recoveryFrom);
    expect(entry.parts!.at(-1)!.ticks[1]).toBe(JUDGEMENT.ticks);
  });
});
