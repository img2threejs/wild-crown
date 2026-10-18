import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { CombatEngine, createEngineState, makeActor, type CombatInput } from '../../src/game/combat/CombatEngine.js';
import { vec } from '../../src/game/combat/geometry.js';
import { LIGHT_STEPS, THUNDER_CLEAVE } from '../../src/game/combat/PlayerSkills.js';
import { arenClipProgress } from '../../src/rendering/ArenAnimation.js';

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
    ['aren-charged-heavy', () => measure(new CombatEngine(engineState()), heavyAfter(THUNDER_CLEAVE.holdTicks))],
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
    it(`${action}: slowed playback retains the native contact pose at the simulated impact`, () => {
      const entry = clip(action);
      const { totalTicks, hitFraction } = run();
      // The engine resolves the impact on `activeAt`; allow the single tick between the resolve and the normalizedTime refresh.
      expect(Math.abs(entry.contact!.outputNormalizedTime - arenClipProgress(action, hitFraction))).toBeLessThanOrEqual(1.5 / totalTicks);
    });
  }

});

describe('Warden Arsenal native contact alignment', () => {
  LIGHT_STEPS.forEach((step, index) => {
    it(`aren-light-${index + 1} reaches the captured contact pose on its damage tick`, () => {
      const entry = clip(`aren-light-${index + 1}`);
      const nativeContact = entry.simulation!.activeTick! / entry.simulation!.totalTicks;
      expect(Math.abs(nativeContact - step.activeFrom / step.ticks)).toBeLessThanOrEqual(1 / step.ticks);
    });
  });
});

describe('Thunder Cleave native sampling invariants', () => {
  it('keeps simulation contact and delayed-lightning markers fixed while the surrounding poses are retimed', () => {
    const { totalTicks, hitFraction } = measure(new CombatEngine(engineState()), heavyAfter(THUNDER_CLEAVE.holdTicks));
    const action = 'aren-charged-heavy';
    expect(arenClipProgress(action, hitFraction)).toBe(hitFraction);
    const lightning = hitFraction + THUNDER_CLEAVE.delayTicks / totalTicks;
    expect(arenClipProgress(action, lightning)).toBeCloseTo(lightning, 12);
  });

  it('never reverses the native action or overshoots its recovery, and leaves other strikes unchanged', () => {
    let last = 0;
    for (let frame = -1; frame <= 1001; frame++) {
      const sampled = arenClipProgress('aren-charged-heavy', frame / 1000);
      expect(sampled).toBeGreaterThanOrEqual(last);
      expect(sampled).toBeLessThanOrEqual(1);
      last = sampled;
    }
    expect(arenClipProgress('aren-charged-heavy', 0)).toBe(0);
    expect(arenClipProgress('aren-charged-heavy', 1)).toBe(1);
    expect(arenClipProgress('aren-heavy', 0.37)).toBe(0.37);
    expect(arenClipProgress('aren-light-1', 0.68)).toBe(0.68);
  });
});
