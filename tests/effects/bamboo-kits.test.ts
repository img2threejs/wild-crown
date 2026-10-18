import { describe, expect, it } from 'bun:test';
import { Mesh, Object3D, Scene, ShaderMaterial } from 'three';
import { StoryEffects } from '../../src/effects/StoryEffects.js';
import type { StoryCue } from '../../src/effects/story-cues.js';
import { BAMBOO_ATTACK_KITS, BAMBOO_AURAS, isBambooKit } from '../../src/effects/vfx/BambooKits.js';
import { OWNER_GLOW } from '../../src/effects/vfx/palette.js';
import { ATTACKS } from '../../src/game/combat/content.js';
import { ACT_ONE_ATTACK_WINDOWS } from '../../src/game/combat/ActOneBossContent.js';
import type { AttackId, WorldClockSnapshot } from '../../src/game/contracts.js';

const clock = (worldTick: number): WorldClockSnapshot => ({ simulationTick: Math.floor(worldTick), worldTick, worldTimeSeconds: worldTick / 60, timeScale: 1, policy: 'normal' });
const OWN_KIT_ATTACKS = Object.keys(BAMBOO_ATTACK_KITS).filter(attackId => isBambooKit(BAMBOO_ATTACK_KITS[attackId]![0]));

type Phase = 'anticipation' | 'commit' | 'active';
/** Mirrors the engine's hazardPresentation convention: strikes are disks, sweeps arcs, waves bands; `from` is the source. */
function hazardCue(attackId: string, phase: Phase, worldTick: number, yaw: number, scope = attackId): StoryCue {
  const attack = ATTACKS[attackId]!, hazard = attack.hazard;
  const disk = hazard.kind === 'strike' || hazard.kind === 'projectile';
  const origin = { x: 3, y: 0, z: -2 };
  const reach = hazard.kind === 'sweep' ? hazard.depth / 2 : 5;
  const target = { x: origin.x + Math.sin(yaw) * reach, y: 0, z: origin.z + Math.cos(yaw) * reach };
  const shape = hazard.kind === 'sweep' ? 'arc' : hazard.kind === 'wave' ? 'wave' : disk ? 'burst' : 'ring';
  const duration = phase === 'anticipation' ? attack.windupTicks : phase === 'commit' ? attack.commitTicks : attack.activeTicks;
  return {
    instanceId: `${scope}:${phase}:${worldTick}`, scopeId: scope, tick: worldTick, worldTick, worldTimeSeconds: worldTick / 60, kind: phase, phase,
    attackId: attackId as AttackId, element: attack.element, actorId: 'asha', targetId: 'aren', priority: 'essential',
    position: target, from: origin, to: target, shape, durationTicks: duration,
    footprint: {
      width: disk ? 2 * hazard.radius : hazard.width,
      length: disk ? 2 * hazard.radius : hazard.depth,
      angleRadians: hazard.kind === 'area' ? 0 : yaw,
    },
  };
}

function rig(reducedEffects = false): { scene: Scene; effects: StoryEffects } {
  const scene = new Scene(), cast = new Object3D(), root = new Object3D();
  cast.position.set(3, 1.7, -2); root.position.set(3, 0, -2); scene.add(cast, root);
  const effects = new StoryEffects({ scene, reducedEffects, resolveSocket: (_actor, name) => name === 'cast' ? cast : name === 'root' ? root : undefined, capacity: 24 });
  return { scene, effects };
}

/** Plays the whole three-phase timeline of one attack and returns how many particles it spawned. */
function playAttack(effects: StoryEffects, attackId: string, yaw = 0.4, onTick?: (tick: number) => void): number {
  const attack = ATTACKS[attackId]!, start = 60, commitAt = start + attack.windupTicks, activeAt = commitAt + attack.commitTicks;
  const particles = effects.vfx.particles;
  const before = particles.additive.nextSlot + particles.alpha.nextSlot;
  effects.emit(hazardCue(attackId, 'anticipation', start, yaw));
  for (let tick = start; tick < commitAt; tick += 3) { effects.update(clock(tick)); onTick?.(tick); }
  effects.emit(hazardCue(attackId, 'commit', commitAt, yaw));
  for (let tick = commitAt; tick < activeAt; tick += 2) { effects.update(clock(tick)); onTick?.(tick); }
  effects.emit(hazardCue(attackId, 'active', activeAt, yaw));
  for (let tick = activeAt; tick < activeAt + Math.min(attack.activeTicks, 200) + 120; tick += 4) { effects.update(clock(tick)); onTick?.(tick); }
  return particles.additive.nextSlot + particles.alpha.nextSlot - before;
}

describe('bamboo VFX kits', () => {

  it('covers every attack the combat owner authored for the two bosses', () => {
    for (const attackId of Object.keys(ACT_ONE_ATTACK_WINDOWS)) {
      if (attackId === 'asha-protective-roar') continue;
      expect(BAMBOO_ATTACK_KITS[attackId], attackId).toBeDefined();
    }
  });

  it('gives Koro and Asha their sap identity glow and an aura that the cleanse removes', () => {
    expect(OWNER_GLOW.koro).toBe('sap');
    expect(OWNER_GLOW.asha).toBe('sap');
    expect(BAMBOO_AURAS).toEqual({ koro: 'howler', asha: 'toxic' });
  });

  for (const attackId of OWN_KIT_ATTACKS) it(`${attackId}: spawns within every cap, shows all phases and ends cleanly`, () => {
    const { effects } = rig();
    try {
      const { particles, ground, debris } = effects.vfx;
      let peakGround = 0;
      const spawned = playAttack(effects, attackId, 0.4, () => {
        expect(particles.additive.drawCount).toBeLessThanOrEqual(particles.additive.capacity);
        expect(particles.alpha.drawCount).toBeLessThanOrEqual(particles.alpha.capacity);
        expect(debris.liveCount).toBeLessThanOrEqual(debris.capacity);
        peakGround = Math.max(peakGround, ground.activeCount());
      });
      expect(spawned).toBeGreaterThan(40);
      expect(spawned).toBeLessThan(4200);
      expect(peakGround).toBeGreaterThan(0);
      let particleDrawCalls = 0;
      effects.group.traverse(node => { if (node instanceof Mesh && node.name.startsWith('vfx-particles')) particleDrawCalls++; });
      expect(particleDrawCalls).toBe(2);
      effects.update(clock(60 + 4000));
      expect(effects.activeCount).toBe(0);
      expect(effects.vfx.beams.activeCount).toBe(0);
      expect(effects.vfx.ground.activeCount()).toBe(0);
    } finally { effects.dispose(); }
  });

  for (const attackId of OWN_KIT_ATTACKS) it(`${attackId}: reduced effects keep the cue readable with fewer particles`, () => {
    const normal = rig(false), reduced = rig(true);
    try {
      const full = playAttack(normal.effects, attackId), lean = playAttack(reduced.effects, attackId);
      expect(lean).toBeGreaterThan(0);
      expect(lean).toBeLessThan(full);
    } finally { normal.effects.dispose(); reduced.effects.dispose(); }
  });

  for (const attackId of OWN_KIT_ATTACKS) it(`${attackId}: cancelling the scope (phase change, interruption, retry) removes everything the cue produced`, () => {
    const { effects } = rig();
    try {
      const attack = ATTACKS[attackId]!, activeAt = 60 + attack.windupTicks + attack.commitTicks;
      effects.emit(hazardCue(attackId, 'anticipation', 60, 0));
      effects.update(clock(60 + attack.windupTicks / 2));
      effects.emit(hazardCue(attackId, 'commit', 60 + attack.windupTicks, 0));
      effects.update(clock(60 + attack.windupTicks + 1));
      effects.emit(hazardCue(attackId, 'active', activeAt, 0));
      effects.update(clock(activeAt + 2));
      expect(effects.activeCount).toBeGreaterThan(0);
      effects.cancelScope(attackId, 'interrupt');
      effects.update(clock(activeAt + 3));
      expect(effects.activeCount).toBe(0);
      expect(effects.vfx.beams.activeCount).toBe(0);
      expect(effects.vfx.ground.activeCount()).toBe(0);
    } finally { effects.dispose(); }
  });

  it('keeps the Black Sap pool drawn for the whole engine hazard and releases it with the cue', () => {
    const { effects } = rig();
    try {
      const attack = ATTACKS['asha-black-sap-trail']!, activeAt = 60 + attack.windupTicks + attack.commitTicks;
      expect(attack.activeTicks).toBeGreaterThanOrEqual(100);
      effects.emit(hazardCue('asha-black-sap-trail', 'active', activeAt, 0.4));
      const burns = (): number => {
        let count = 0;
        effects.vfx.ground.group.traverse(node => { if (node instanceof Mesh && node.visible && node.material instanceof ShaderMaterial && node.material.uniforms.uMode!.value === 3) count++; });
        return count;
      };
      effects.update(clock(activeAt + 2));
      expect(burns()).toBe(1);
      effects.update(clock(activeAt + Math.floor(attack.activeTicks * 0.6)));
      expect(burns()).toBe(1);
      effects.update(clock(activeAt + attack.activeTicks + 2));
      expect(burns()).toBe(0);
      expect(effects.activeCount).toBe(0);
    } finally { effects.dispose(); }
  });

  it('draws every telegraph quad inside the engine footprint of the hazard', () => {
    for (const attackId of OWN_KIT_ATTACKS) {
      const { effects } = rig();
      try {
        const cue = hazardCue(attackId, 'anticipation', 60, 0.7);
        effects.emit(cue);
        effects.update(clock(70));
        const footprint = cue.footprint!;
        // A quad's scale is its footprint extent: disks and lanes are `width x length`, never larger.
        effects.vfx.ground.group.traverse(node => {
          if (!(node instanceof Mesh) || !node.visible) return;
          expect(node.scale.x, attackId).toBeLessThanOrEqual(Math.max(footprint.width, footprint.length) + 1e-6);
          expect(node.scale.z, attackId).toBeLessThanOrEqual(Math.max(footprint.width, footprint.length) + 1e-6);
        });
      } finally { effects.dispose(); }
    }
  });
});
