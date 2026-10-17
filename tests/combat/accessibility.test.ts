import { describe, expect, it } from 'bun:test';
import { CombatEngine, createEngineState, makeActor } from '../../src/game/combat/CombatEngine.js';
import type { CombatInput, EngineState } from '../../src/game/combat/CombatEngine.js';
import type { ActorId, GameSettings, Vec3 } from '../../src/game/contracts.js';
import type { HeroId } from '../../src/game/heroes.js';
import { DEFAULT_GAME_SETTINGS } from '../../src/game/contracts.js';
import { EVASION_PROFILES } from '../../src/game/combat/evasion.js';
import type { EvasionProfileId } from '../../src/game/combat/evasion.js';
import { SIGIL } from '../../src/game/combat/PlayerSkills.js';
import { SAKDA } from '../../src/game/combat/SakdaSkills.js';
import { vec } from '../../src/game/combat/geometry.js';

const idle: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };
const press = { ...idle, lockOnPressed: true, lockOnHeld: true };

// Same live-state fixture seam used by the existing kit tests; snapshotState remains a detached copy.
function rig(settings: Partial<GameSettings> = {}, positions: readonly Vec3[] = [vec(12, 0, 0)], hero: HeroId = 'aren') {
  const seed = createEngineState();
  seed.arena.bounds = { min: vec(-100, 0, -100), max: vec(100, 12, 100) };
  seed.runId = 'accessibility-regression';
  positions.forEach((position, index) => {
    const actor = makeActor((index === 0 ? 'corrupted-boar' : 'greenwake-sap-stalker') as ActorId, 'boar', 'hostile', position, false, false, 1000, 'corrupted-boar');
    actor.staggerUntil = 1e9;
    seed.actors.push(actor);
  });
  const engine = new CombatEngine(seed);
  engine.setPlayerHero(hero);
  const preferences = { ...DEFAULT_GAME_SETTINGS, autoTargetAssist: 'off' as const, lockOnMode: 'toggle' as const, ...settings };
  engine.setAccessibilitySettings(preferences);
  const state = (engine as unknown as { state: EngineState }).state;
  return { engine, state, preferences, player: state.actors[0]!, foe: state.actors[1]! };
}

function bolt(engine: CombatEngine) {
  engine.fixedStep({ ...idle, rangedPressed: true });
  for (let i = 0; i <= SIGIL.boltLaunchTick; i++) {
    const projectile = engine.snapshotState().playerProjectiles[0];
    if (projectile) return projectile;
    engine.fixedStep(idle);
  }
  throw new Error('The actual Sigil cast did not emit its projectile');
}

describe('explicit lock lifecycle', () => {
  it('toggle retains the target on release and clears it on the next press', () => {
    const { engine } = rig();
    engine.fixedStep(press);
    expect(engine.snapshot()).toMatchObject({ targetId: 'corrupted-boar', lockStatus: 'explicit' });
    engine.fixedStep(idle);
    expect(engine.snapshot().lockStatus).toBe('explicit');
    engine.fixedStep(press);
    expect(engine.snapshot().targetId).toBeUndefined();
  });

  it('hold retains the target only while held; changing modes clears an existing lock', () => {
    const { engine, preferences } = rig({ lockOnMode: 'hold' });
    engine.fixedStep(press);
    engine.fixedStep({ ...idle, lockOnHeld: true });
    expect(engine.snapshot().lockStatus).toBe('explicit');
    engine.fixedStep(idle);
    expect(engine.snapshot().targetId).toBeUndefined();
    engine.fixedStep(press);
    engine.setAccessibilitySettings({ ...preferences, lockOnMode: 'toggle' });
    expect(engine.snapshot().lockStatus).toBeUndefined();
  });

  it.each(['downed', 'hidden', 'removed', 'out-of-range'] as const)('clears a previously acquired target when it becomes %s', condition => {
    const { engine, state, foe } = rig();
    engine.fixedStep(press);
    expect(engine.snapshot().lockStatus).toBe('explicit');
    if (condition === 'downed') foe.downed = true;
    else if (condition === 'hidden') foe.visible = false;
    else if (condition === 'removed') state.actors.splice(state.actors.indexOf(foe), 1);
    else foe.position = vec(SIGIL.homingRange + 10, 0, 0);
    engine.fixedStep(idle);
    expect(engine.snapshot().targetId).toBeUndefined();
    expect(engine.snapshot().lockStatus).toBeUndefined();
  });

  it.each(['restore', 'region', 'encounter', 'checkpoint'] as const)('does not carry a lock into a same-ID %s replacement', replacement => {
    const { engine } = rig();
    const saved = engine.snapshotState();
    engine.fixedStep(press);
    expect(engine.snapshot().lockStatus).toBe('explicit');
    if (replacement === 'restore') engine.restore(JSON.stringify(saved));
    else if (replacement === 'region') engine.loadRegion({ regionId: 'greenwake', runId: 'new-world', presentActorIds: ['corrupted-boar'] });
    else if (replacement === 'encounter') engine.startEncounter({ encounterId: 'greenwake-boar', regionId: 'greenwake', runId: 'new-world', actors: saved.actors, playerPosition: vec(0, 0, 0) });
    else engine.resetToCheckpoint();
    expect(engine.snapshot().lockStatus).not.toBe('explicit');
    expect(engine.snapshotState().actors.some(a => a.id === 'corrupted-boar')).toBe(true);
  });

  it('keeps an explicit ranged target when another hostile moves nearer', () => {
    const { engine, state } = rig({}, [vec(12, 0, 0), vec(20, 0, 0)]);
    engine.fixedStep(press);
    state.actors[2]!.position = vec(8, 0, 0);
    state.targetId = state.actors[2]!.id;
    const shot = bolt(engine);
    expect(shot.targetId).toBe('corrupted-boar');
    expect(engine.snapshot()).toMatchObject({ targetId: 'corrupted-boar', lockStatus: 'explicit' });
  });
});

describe('auto-target assistance at attack consumers', () => {
  it.each(['aren', 'sakda'] as const)('off prevents %s melee snapping to a stale implicit target', hero => {
    const { engine, state, player, foe } = rig({}, [vec(2.5, 0, 0)], hero);
    state.targetId = foe.id;
    const facing = { ...player.facing };
    engine.fixedStep({ ...idle, lightPressed: true });
    expect(player.facing.x).toBeCloseTo(facing.x);
    expect(player.facing.z).toBeCloseTo(facing.z);
    expect(player.phase).not.toBe('idle');
  });

  it.each(['off', 'subtle', 'strong'] as const)('%s applies its cone policy to an actual Sigil projectile', autoTargetAssist => {
    const { engine, state, foe } = rig({ autoTargetAssist });
    state.targetId = foe.id;
    const shot = bolt(engine);
    if (autoTargetAssist === 'strong') {
      expect(shot.targetId).toBe(foe.id);
      expect(shot.direction.x).toBeGreaterThan(0.9);
    } else {
      expect(shot.targetId).toBeUndefined();
      expect(shot.direction.z).toBeLessThan(-0.9);
    }
  });

  it('strong does not extend the authored homing range', () => {
    const { engine } = rig({ autoTargetAssist: 'strong' }, [vec(SIGIL.homingRange + 10, 0, 0)]);
    const shot = bolt(engine);
    expect(shot.targetId).toBeUndefined();
    expect(shot.direction.z).toBeLessThan(-0.9);
  });
});

describe('captured effective dodge timing', () => {
  it.each(['aren', 'sakda'] as const)('%s uses the same captured wide interval for phase and invulnerability', hero => {
    const standard = rig({ perfectDodgeWindow: 'standard' }, [], hero);
    const wide = rig({ perfectDodgeWindow: 'wide' }, [], hero);
    const dodge = { ...idle, dodgePressed: true, dodgeDirection: 'left' as const };
    standard.engine.fixedStep(dodge);
    wide.engine.fixedStep(dodge);
    const profile = hero === 'sakda' ? SAKDA.guardDash : EVASION_PROFILES[standard.state.actionId as EvasionProfileId];
    const standardSpan = standard.player.invulnerableUntil - standard.player.actionStartedTick;
    const wideSpan = wide.player.invulnerableUntil - wide.player.actionStartedTick;
    expect(standardSpan).toBe(profile.iframes);
    expect(wideSpan).toBe(Math.min(profile.iframes + 4, profile.durationTicks));
    const deadline = wide.player.invulnerableUntil;
    wide.engine.setAccessibilitySettings({ ...wide.preferences, perfectDodgeWindow: 'standard' });
    while (wide.engine.simulationTick < deadline - 1) wide.engine.fixedStep(idle);
    expect(wide.player.invulnerableUntil).toBe(deadline);
    expect(wide.player.phase).toBe('active');
    wide.engine.fixedStep(idle);
    expect(wide.player.phase).toBe('recovery');
  });
});
