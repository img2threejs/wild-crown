import { describe, expect, it } from 'bun:test';
import { CombatEngine, type CombatInput } from '../../src/game/combat/CombatEngine.js';
import { vec } from '../../src/game/combat/geometry.js';

const idle: CombatInput = {
  tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false,
  heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false,
};

describe('combat run initialization', () => {
  it('revives the player and accepts movement plus dodge when a new run replaces a defeated one', () => {
    const engine = new CombatEngine();
    engine.loadRegion({ regionId: 'greenwake', runId: 'defeated-run', presentActorIds: [] });
    const defeated = JSON.parse(engine.serialize());
    defeated.tick = 862;
    defeated.worldTick = 862;
    defeated.player.vitality = 0;
    defeated.player.mana = 0;
    const defeatedPlayer = defeated.actors.find((actor: { id: string }) => actor.id === 'aren');
    defeatedPlayer.vitality = 0;
    defeatedPlayer.downed = true;
    engine.restore(JSON.stringify(defeated));

    engine.startNewRun('new-run');
    engine.loadRegion({ regionId: 'greenwake', runId: 'new-run', presentActorIds: [] });
    engine.startEncounter({ encounterId: 'greenwake-boar', regionId: 'greenwake', runId: 'new-run', companionSlots: {} });

    const before = engine.snapshot();
    const playerBefore = before.actors.find((actor) => actor.id === 'aren')!;
    expect(before.worldClock.simulationTick).toBe(0);
    expect(before.player.vitality).toBe(before.player.maxVitality);
    expect(before.player.mana).toBe(before.player.maxMana);
    expect(playerBefore).toMatchObject({ downed: false, vitality: 100 });

    engine.fixedStep({ ...idle, move: vec(1, 0, 0), dodgePressed: true, dodgeDirection: 'right' });

    const after = engine.snapshot();
    const playerAfter = after.actors.find((actor) => actor.id === 'aren')!;
    expect(after.worldClock.simulationTick).toBe(1);
    expect(after.player.mana).toBeLessThan(before.player.mana);
    expect(playerAfter.downed).toBe(false);
    expect(playerAfter.position.x).toBeGreaterThan(playerBefore.position.x);
  });

  it('preserves player resources and simulation time when loading another region in the same run', () => {
    const engine = new CombatEngine();
    engine.loadRegion({ regionId: 'greenwake', runId: 'travel-run', presentActorIds: [] });
    const state = JSON.parse(engine.serialize());
    state.tick = 17;
    state.worldTick = 22;
    state.player.vitality = 64;
    state.player.mana = 37;
    engine.restore(JSON.stringify(state));

    engine.loadRegion({ regionId: 'whispering-canopy', runId: 'travel-run', presentActorIds: [] });

    expect(engine.snapshot().worldClock.simulationTick).toBe(17);
    expect(engine.snapshot().player).toMatchObject({ vitality: 64, mana: 37 });
  });
});
