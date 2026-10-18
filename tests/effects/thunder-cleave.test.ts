import { describe, expect, it } from 'bun:test';
import { Object3D, Scene } from 'three';
import { StoryEffects } from '../../src/effects/StoryEffects.js';
import { ActorVfx } from '../../src/effects/vfx/ActorVfx.js';
import { CombatEngine, createEngineState, makeActor, type CombatInput } from '../../src/game/combat/CombatEngine.js';
import { vec } from '../../src/game/combat/geometry.js';
import { THUNDER_CLEAVE } from '../../src/game/combat/PlayerSkills.js';

const idle: CombatInput = { tick: 0, move: vec(0, 0, 0), dodgePressed: false, lightPressed: false, heavyPressed: false, heavyHeld: false, heavyReleased: false, interactPressed: false };

function fixture(distance = 1.6) {
  const state = createEngineState();
  state.actors = [state.actors[0]!, makeActor('corrupted-boar', 'boar', 'hostile', vec(0, 0, -distance), true, false, 1000)];
  state.player.vitality = state.player.maxVitality = 1000;
  state.targetId = 'corrupted-boar';
  const engine = new CombatEngine(state);
  const tip = new Object3D(), base = new Object3D();
  tip.position.set(0, 2, -1); base.position.set(0, 1, -0.5);
  const effects = new StoryEffects({ scene: new Scene(), resolveSocket: (_id, socket) => socket === 'weapon-tip' ? tip : socket === 'weapon-base' ? base : undefined });
  const actors = new ActorVfx(effects.vfx, undefined, undefined, () => false);
  function render() {
    const snapshot = engine.snapshot();
    effects.update(snapshot.worldClock);
    actors.update(snapshot.actors);
    effects.warden.updateCombat(snapshot, 1);
  }
  function step(input: Partial<CombatInput> = {}) {
    engine.fixedStep({ ...idle, ...input });
    const cues = engine.drainPresentationCues();
    effects.emitAll(cues);
    render();
    return cues;
  }
  function release() {
    step({ heavyPressed: true, heavyHeld: true });
    for (let tick = 0; tick < THUNDER_CLEAVE.holdTicks; tick++) step({ heavyHeld: true });
    step({ heavyReleased: true, heavyHeldTicks: THUNDER_CLEAVE.holdTicks });
  }
  return { engine, effects, actors, render, step, release, dispose: () => { actors.dispose(); effects.dispose(); } };
}

describe('Thunder Cleave presentation follows contact, not action phase', () => {
  it('a melee whiff has no ground-impact burst until the genuine delayed lightning cue', () => {
    const f = fixture(9);
    try {
      f.release();
      let slash = false, lightning = false;
      for (let tick = 0; tick < 180 && !lightning; tick++) {
        const cues = f.step();
        expect(cues.some(cue => cue.kind === 'hit')).toBe(false);
        slash ||= cues.some(cue => cue.kind === 'slash');
        lightning = cues.some(cue => cue.kind === 'lightning');
        if (!lightning) expect(f.effects.vfx.ground.activeCount()).toBe(0);
      }
      expect(slash).toBe(true);
      expect(lightning).toBe(true);
      expect(f.effects.warden.bolts.some(bolt => bolt.active)).toBe(true);
      expect(f.effects.vfx.ground.activeCount()).toBeGreaterThan(0);
    } finally { f.dispose(); }
  });

  it('repeated renders of a frozen charge do not manufacture particles', () => {
    const f = fixture();
    try {
      f.step({ heavyPressed: true, heavyHeld: true });
      for (let tick = 0; tick < 30; tick++) f.step({ heavyHeld: true });
      const before = f.effects.vfx.particles.liveCount(f.effects.vfx.time);
      f.engine.setTimePolicy('paused');
      for (let frame = 0; frame < 60; frame++) f.render();
      expect(f.effects.vfx.particles.liveCount(f.effects.vfx.time)).toBe(before);
    } finally { f.dispose(); }
  });

  it('lightning ground filaments remain inside the authoritative elliptical footprint', () => {
    const f = fixture();
    try {
      f.effects.emit({ instanceId: 'small-thunder', tick: 0, worldTick: 0, worldTimeSeconds: 0, kind: 'lightning', phase: 'active', actorId: 'aren', position: vec(2, 0, 3), footprint: { width: 2, length: 4 }, durationTicks: 18, element: 'lightning' });
      const bolt = f.effects.warden.bolts.find(candidate => candidate.active)!;
      for (const path of bolt.radial) for (let i = 0; i < path.length; i += 3) {
        const x = path[i]! - 2, z = (path[i + 2]! - 3) / 2;
        expect(x * x + z * z).toBeLessThanOrEqual(1.00001);
      }
    } finally { f.dispose(); }
  });
});

describe('Thunder Cleave contact lifecycle', () => {
  it('get-up immunity rejects melee feedback even though the swing reaches its active tick', () => {
    const f = fixture();
    try {
      f.release();
      const impactAt = f.engine.snapshotState().pendingImpact!.activeAt;
      for (let tick = 0; tick < 180 && f.engine.simulationTick < impactAt - 1; tick++) f.step();
      expect(f.engine.simulationTick).toBe(impactAt - 1);
      // A real get-up i-frame at the contact boundary, not a synthetic zero-damage VFX cue.
      const state = f.engine.snapshotState();
      const target = state.actors[1]!;
      target.reactionState = { kind: 'getup', serial: 1, startedAt: state.worldTick, durationTicks: 60, strength: 1, dirX: 0, dirZ: -1, side: 'front', travel: 0, moveTicks: 0, moved: 0, lift: 0, pending: false, cancelsAttack: false };
      f.engine.restore(JSON.stringify(state));
      f.engine.drainPresentationCues();
      f.effects.cancelAll('load'); f.actors.clear();
      const cues = f.step();
      expect(cues.some(cue => cue.kind === 'slash')).toBe(true);
      expect(cues.some(cue => cue.kind === 'hit')).toBe(false);
      expect(f.engine.snapshot().actors[1]!.vitality).toBe(1000);
      expect(f.effects.vfx.ground.activeCount()).toBe(0);
    } finally { f.dispose(); }
  });

  it('hit-stop freezes lightning geometry, brightness and emission until the world advances', () => {
    const f = fixture();
    try {
      f.release();
      let struck = false;
      for (let tick = 0; tick < 180 && !struck; tick++) struck = f.step().some(cue => cue.kind === 'lightning');
      expect(struck).toBe(true);
      const bolt = f.effects.warden.bolts.find(candidate => candidate.active)!;
      const trunk = bolt.trunk.slice(), radial = bolt.radial.map(path => path.slice()), flicker = bolt.flicker;
      const particles = f.effects.vfx.particles.liveCount(f.effects.vfx.time);
      f.engine.setTimePolicy('paused');
      for (let frame = 0; frame < 60; frame++) f.render();
      expect(bolt.trunk).toEqual(trunk);
      expect(bolt.radial).toEqual(radial);
      expect(bolt.flicker).toBe(flicker);
      expect(f.effects.vfx.particles.liveCount(f.effects.vfx.time)).toBe(particles);
      f.engine.setTimePolicy('normal');
      for (let tick = 0; tick < 50; tick++) f.step();
      expect(f.effects.warden.bolts.some(candidate => candidate.active)).toBe(false);
    } finally { f.dispose(); }
  });

  it('a cancelled hold never releases damage, and world replacement clears a live discharge', () => {
    const f = fixture();
    try {
      f.step({ heavyPressed: true, heavyHeld: true });
      for (let tick = 0; tick < 20; tick++) f.step({ heavyHeld: true });
      f.step({ dodgePressed: true });
      for (let tick = 0; tick < 120; tick++) expect(f.step().some(cue => cue.kind === 'hit' || cue.kind === 'lightning')).toBe(false);
      expect(f.engine.snapshot().actors[1]!.vitality).toBe(1000);
      f.release();
      let struck = false;
      for (let tick = 0; tick < 180 && !struck; tick++) struck = f.step().some(cue => cue.kind === 'lightning');
      expect(struck).toBe(true);
      f.effects.cancelAll('load'); f.actors.clear();
      expect(f.effects.warden.bolts.some(candidate => candidate.active)).toBe(false);
      expect(f.effects.warden.arcs.some(candidate => candidate.active)).toBe(false);
      expect(f.effects.vfx.ground.activeCount()).toBe(0);
      expect(f.effects.vfx.particles.liveCount(f.effects.vfx.time)).toBe(0);
    } finally { f.dispose(); }
  });

  it('reduced effects retain a readable strike without optional crawling arcs', () => {
    const f = fixture();
    try {
      f.effects.setReducedEffects(true);
      f.release();
      let struck = false;
      for (let tick = 0; tick < 180 && !struck; tick++) struck = f.step().some(cue => cue.kind === 'lightning');
      expect(struck).toBe(true);
      expect(f.engine.snapshot().actors[1]!.vitality).toBe(1000 - 36 - 18);
      expect(f.effects.warden.arcs.some(candidate => candidate.active)).toBe(false);
      expect(f.effects.warden.bolts.some(candidate => candidate.active)).toBe(true);
    } finally { f.dispose(); }
  });
});
