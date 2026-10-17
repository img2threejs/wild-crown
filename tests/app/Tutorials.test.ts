import { describe, expect, it } from 'bun:test';
import { dueTutorial } from '../../src/app/Tutorials.js';
import { CombatEngine, type CombatInput, type EngineState } from '../../src/game/combat/CombatEngine.js';
import { vec } from '../../src/game/combat/geometry.js';

const idle: CombatInput = {
  tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false,
  heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false,
};
const live = (engine: CombatEngine) => (engine as unknown as { state: EngineState }).state;

describe('how-to-play card scheduling', () => {
  it('explains controls on the first gameplay frame and nothing more while exploring', () => {
    const engine = new CombatEngine();
    engine.loadRegion({ regionId: 'greenwake', runId: 'tutorials', presentActorIds: ['corrupted-boar'] });
    expect(dueTutorial(engine.snapshot(), [])).toBe('controls');
    expect(dueTutorial(engine.snapshot(), ['controls'])).toBeNull();
  });

  it('walks the Greenwake boar: cleanse explainer at the start, then each required action when its phase asks for it', () => {
    const engine = new CombatEngine();
    engine.loadRegion({ regionId: 'greenwake', runId: 'tutorials', presentActorIds: ['corrupted-boar'] });
    engine.startEncounter({encounterId: 'greenwake-boar', regionId: 'greenwake', runId: 'tutorials'});
    const boar = live(engine).actors.find(actor => actor.id === 'corrupted-boar')!;
    // Unseen cards queue in order: controls before the boss explainer.
    expect(dueTutorial(engine.snapshot(), [])).toBe('controls');
    expect(dueTutorial(engine.snapshot(), ['controls'])).toBe('cleanse-boss');
    const seen = ['controls', 'cleanse-boss'] as const;
    expect(dueTutorial(engine.snapshot(), seen)).toBeNull();

    boar.ferocity = 70; engine.fixedStep(idle);
    expect(dueTutorial(engine.snapshot(), seen)).toBe('tether');
    live(engine).phaseActionFlags.push('tether');
    expect(dueTutorial(engine.snapshot(), seen)).toBeNull();

    boar.ferocity = 40; engine.fixedStep(idle);
    boar.ferocity = 20; engine.fixedStep(idle);
    expect(dueTutorial(engine.snapshot(), [...seen, 'tether'])).toBe('cleanse');
    expect(dueTutorial(engine.snapshot(), [...seen, 'tether', 'cleanse'])).toBeNull();
  });

  it('never calls uncorrupted human enemies something to cleanse', () => {
    const engine = new CombatEngine();
    engine.startEncounter({encounterId: 'camp-hunters', regionId: 'blood-bamboo-valley', runId: 'tutorials'});
    expect(engine.snapshot().encounterStatus?.step).toBeDefined();
    expect(dueTutorial(engine.snapshot(), ['controls'])).toBeNull();
  });
});
