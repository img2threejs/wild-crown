import { describe, expect, it } from 'bun:test';
import { Matrix4, Mesh, Object3D, Scene, Vector3, type InstancedMesh } from 'three';
import { StoryEffects } from '../../src/effects/StoryEffects.js';
import { StoryPresentation } from '../../src/effects/StoryPresentation.js';
import type { StoryCue } from '../../src/effects/story-cues.js';
import { CANOPY_KIT_IDS, isCanopyKit } from '../../src/effects/vfx/CanopyKits.js';
import { resolveKit } from '../../src/effects/vfx/ElementKits.js';
import { Footprint } from '../../src/effects/vfx/footprint.js';
import { OWNER_GLOW } from '../../src/effects/vfx/palette.js';
import { ATTACKS } from '../../src/game/combat/content.js';
import type { ActorSnapshot, AttackId, WorldClockSnapshot } from '../../src/game/contracts.js';

const clock = (worldTick: number): WorldClockSnapshot => ({ simulationTick: Math.floor(worldTick), worldTick, worldTimeSeconds: worldTick / 60, timeScale: 1, policy: 'normal' });
const ACTOR_OF: Readonly<Record<string, string>> = {
  'howler-rock-hurl': 'canopy-howler', 'howler-leap-slam': 'canopy-howler', 'howler-branch-sweep': 'canopy-howler',
  'hornbill-dive-bomb': 'canopy-hornbill', 'hornbill-feather-volley': 'canopy-hornbill', 'hornbill-gale-flap': 'canopy-hornbill',
  'viper-venom-spit': 'canopy-mire-viper', 'viper-tail-lash': 'canopy-mire-viper', 'viper-strike-lunge': 'canopy-mire-viper',
};
const ELEMENT_OF: Readonly<Record<string, string>> = {
  'howler-rock-hurl': 'earth', 'howler-leap-slam': 'earth', 'howler-branch-sweep': 'wind',
  'hornbill-dive-bomb': 'wind', 'hornbill-feather-volley': 'wind', 'hornbill-gale-flap': 'wind',
  'viper-venom-spit': 'poison', 'viper-tail-lash': 'poison', 'viper-strike-lunge': 'poison',
};

type Phase = 'anticipation' | 'commit' | 'active';
/** Mirrors the engine's hazardPresentation convention: cones are apex sectors, strikes disks, others rectangles; `from` is the source. */
function hazardCue(attackId: string, phase: Phase, worldTick: number, yaw: number, scope = attackId): StoryCue {
  const attack = ATTACKS[attackId]!, hazard = attack.hazard;
  const cone = hazard.kind === 'cone', disk = hazard.kind === 'strike' || hazard.kind === 'projectile';
  const origin = { x: 3, y: 0, z: -2 };
  const reach = hazard.kind === 'sweep' ? hazard.depth / 2 : 5;
  const target = { x: origin.x + Math.sin(yaw) * reach, y: 0, z: origin.z + Math.cos(yaw) * reach };
  const shape = cone ? 'sector' : hazard.kind === 'sweep' ? 'arc' : hazard.kind === 'wave' ? 'wave' : disk ? 'burst' : 'ring';
  const duration = phase === 'anticipation' ? attack.windupTicks : phase === 'commit' ? attack.commitTicks : attack.activeTicks;
  return {
    instanceId: `${scope}:${phase}:${worldTick}`, scopeId: scope, tick: worldTick, worldTick, worldTimeSeconds: worldTick / 60, kind: phase, phase,
    attackId: attackId as AttackId, element: attack.element, actorId: ACTOR_OF[attackId], targetId: 'aren', priority: 'essential',
    position: cone ? origin : target, from: origin, to: target, shape, durationTicks: duration,
    footprint: {
      width: disk ? 2 * hazard.radius : hazard.width,
      length: cone ? 2 * hazard.depth : disk ? 2 * hazard.radius : hazard.depth,
      angleRadians: hazard.kind === 'area' ? 0 : yaw,
      ...(cone ? { sectorRadians: (70 * Math.PI) / 180 } : {}),
    },
  };
}

function rig(reducedEffects = false): { scene: Scene; effects: StoryEffects; cast: Object3D; root: Object3D } {
  const scene = new Scene(), cast = new Object3D(), root = new Object3D();
  cast.position.set(3, 1.7, -2); root.position.set(3, 0, -2); scene.add(cast, root);
  const effects = new StoryEffects({ scene, reducedEffects, resolveSocket: (_actor, name) => name === 'cast' ? cast : name === 'root' ? root : undefined, capacity: 24 });
  return { scene, effects, cast, root };
}

/** Plays the whole three-phase timeline of one attack and returns how many particles it spawned (rings stay below capacity here). */
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

describe('canopy VFX kits', () => {
  it('resolves every canopy attack id to its own kit with the contract element', () => {
    expect(CANOPY_KIT_IDS.length).toBe(9);
    for (const attackId of CANOPY_KIT_IDS) {
      expect(ATTACKS[attackId], attackId).toBeDefined();
      expect(isCanopyKit(attackId)).toBe(true);
      for (const phase of ['anticipation', 'commit', 'active'] as const) {
        const resolved = resolveKit(hazardCue(attackId, phase, 60, 0));
        expect({ attackId, phase, kit: resolved.kit, attack: resolved.attack }).toEqual({ attackId, phase, kit: attackId, attack: true });
        expect(resolved.element).toBe(ELEMENT_OF[attackId]!);
      }
      // The contact flash of the hit phase stays on the shared contact kit, tinted by the same element.
      const hit = { ...hazardCue(attackId, 'active', 60, 0), kind: 'hit' as const, phase: 'hit' as const };
      expect(resolveKit(hit)).toEqual({ kit: 'contact', element: ELEMENT_OF[attackId]!, attack: true });
    }
    expect(isCanopyKit('gale')).toBe(false);
  });

  it('gives each canopy monster its own identity glow', () => {
    expect(OWNER_GLOW['canopy-howler']).toBe('sap');
    expect(OWNER_GLOW['canopy-hornbill']).toBe('lightning');
    expect(OWNER_GLOW['canopy-mire-viper']).toBe('poison');
  });

  for (const attackId of CANOPY_KIT_IDS) it(`${attackId}: spawns within every cap, shows all phases and ends cleanly`, () => {
    const { effects } = rig();
    try {
      const { particles, ground, debris } = effects.vfx;
      let drawn = 0, peakGround = 0;
      const spawned = playAttack(effects, attackId, 0.4, () => {
        expect(particles.additive.drawCount).toBeLessThanOrEqual(particles.additive.capacity);
        expect(particles.alpha.drawCount).toBeLessThanOrEqual(particles.alpha.capacity);
        expect(debris.liveCount).toBeLessThanOrEqual(debris.capacity);
        peakGround = Math.max(peakGround, ground.activeCount());
        drawn += particles.liveCount(effects.vfx.time);
      });
      expect(spawned).toBeGreaterThan(40);
      expect(spawned).toBeLessThan(1800);
      expect(drawn).toBeGreaterThan(0);
      expect(peakGround).toBeGreaterThan(0);
      // Only the shared pools draw particles (no extra draw calls); the manual telegraph fills are released with their cues.
      let particleDrawCalls = 0;
      effects.group.traverse(node => { if (node instanceof Mesh && node.name.startsWith('vfx-particles')) particleDrawCalls++; });
      expect(particleDrawCalls).toBe(2);
      effects.update(clock(60 + 4000));
      expect(effects.activeCount).toBe(0);
    } finally { effects.dispose(); }
  });

  for (const attackId of CANOPY_KIT_IDS) it(`${attackId}: reduced effects keep the cue readable with fewer particles`, () => {
    const normal = rig(false), reduced = rig(true);
    try {
      const full = playAttack(normal.effects, attackId), lean = playAttack(reduced.effects, attackId);
      expect(lean).toBeGreaterThan(0);
      expect(lean).toBeLessThan(full);
      expect(reduced.effects.vfx.reducedEffects).toBe(true);
    } finally { normal.effects.dispose(); reduced.effects.dispose(); }
  });

  for (const attackId of CANOPY_KIT_IDS) it(`${attackId}: cancelling the scope removes everything the cue produced`, () => {
    const { effects } = rig();
    try {
      const attack = ATTACKS[attackId]!;
      effects.emit(hazardCue(attackId, 'anticipation', 60, 0));
      for (let tick = 60; tick < 60 + attack.windupTicks / 2; tick += 3) effects.update(clock(tick));
      const time = effects.vfx.time;
      expect(effects.vfx.particles.liveCount(time)).toBeGreaterThan(0);
      effects.cancelScope(attackId, 'interrupt');
      expect(effects.activeCount).toBe(0);
      expect(effects.vfx.ground.activeCount(1)).toBe(0);
      expect(effects.vfx.particles.liveCount(time + 0.001, 1)).toBe(0);
    } finally { effects.dispose(); }
  });

  it('the howler rock is held in the hand, lobbed in an arc from the cast socket to the committed point, and removed on cancel', () => {
    const { effects, scene } = rig();
    try {
      const attack = ATTACKS['howler-rock-hurl']!, yaw = 0.6;
      const mesh = (): InstancedMesh => { let found: InstancedMesh | undefined; effects.group.traverse(node => { if (node.name === 'vfx-lobbed-rocks') found = node as InstancedMesh; }); return found!; };
      /** Position of the one visible rock (hidden instances have a zero-scale matrix). */
      const position = (): Vector3 => {
        const m = new Matrix4();
        for (let i = 0; i < mesh().instanceMatrix.count; i++) { mesh().getMatrixAt(i, m); if (Math.abs(m.determinant()) > 1e-9) return new Vector3().setFromMatrixPosition(m); }
        return new Vector3(NaN, NaN, NaN);
      };
      const commitAt = 60 + attack.windupTicks, activeAt = commitAt + attack.commitTicks, target = hazardCue('howler-rock-hurl', 'commit', commitAt, yaw).to!;
      effects.emit(hazardCue('howler-rock-hurl', 'anticipation', 60, yaw));
      effects.update(clock(60 + attack.windupTicks - 3));
      expect(mesh().count).toBeGreaterThan(0);
      expect(position().y).toBeGreaterThan(1.7); // held just above the cast socket
      expect(position().distanceTo(new Vector3(3, 2, -2))).toBeLessThan(0.7);
      effects.emit(hazardCue('howler-rock-hurl', 'commit', commitAt, yaw));
      effects.update(clock(commitAt));
      const start = position();
      effects.update(clock(commitAt + attack.commitTicks / 2));
      const mid = position();
      effects.update(clock(activeAt - 0.5));
      const end = position();
      scene.updateMatrixWorld(true);
      expect(Math.hypot(start.x - 3, start.z + 2)).toBeLessThan(0.5);
      // Mid-flight the rock is above the straight line between the two end points (an arc), and it finishes on the mark.
      expect(mid.y).toBeGreaterThan((start.y + end.y) / 2 + 0.1);
      expect(Math.hypot(end.x - target.x, end.z - target.z)).toBeLessThan(0.4);
      expect(end.y).toBeLessThan(0.7);
      // The slam arrives with the active phase: the rock is gone and the impact decal/shock exist.
      effects.emit(hazardCue('howler-rock-hurl', 'active', activeAt, yaw));
      effects.update(clock(activeAt));
      expect(mesh().count).toBe(0);
      expect(effects.vfx.ground.activeCount()).toBeGreaterThan(0);
      // Cancelling mid-flight removes the rock.
      effects.cancelAll('unload');
      effects.emit(hazardCue('howler-rock-hurl', 'commit', commitAt + 500, yaw, 'again'));
      effects.update(clock(commitAt + 500));
      expect(mesh().count).toBeGreaterThan(0);
      effects.cancelScope('again', 'interrupt');
      effects.update(clock(commitAt + 502));
      expect(mesh().count).toBe(0);
    } finally { effects.dispose(); }
  });

  it('the feather volley fires a fan of darts that all land inside the cone, each impact scheduled for its arrival', () => {
    for (const reduced of [false, true]) {
      const { effects } = rig(reduced);
      try {
        const yaw = -0.8, attack = ATTACKS['hornbill-feather-volley']!, activeAt = 60 + attack.windupTicks + attack.commitTicks;
        const cue = hazardCue('hornbill-feather-volley', 'active', activeAt, yaw);
        const fp = new Footprint().setFromCue(cue, 1);
        const additive = effects.vfx.particles.additive, geometry = additive.mesh.geometry;
        const origin = geometry.getAttribute('iOrigin'), velocity = geometry.getAttribute('iVelocity'), timing = geometry.getAttribute('iTiming'), misc = geometry.getAttribute('iMisc');
        effects.emit(cue);
        effects.update(clock(activeAt));
        const darts: number[] = [];
        for (let i = 0; i < additive.nextSlot; i++) if (misc.getX(i) === 9 && timing.getY(i) > 0) darts.push(i);
        expect(darts.length).toBe(reduced ? 3 : 9);
        const landings = new Set<string>();
        for (const i of darts) {
          const life = timing.getY(i);
          const x = origin.getX(i) + velocity.getX(i) * life, y = origin.getY(i) + velocity.getY(i) * life, z = origin.getZ(i) + velocity.getZ(i) * life;
          expect(fp.contains(x, z, 0.3)).toBe(true);
          expect(y).toBeLessThan(0.4);
          expect(life).toBeGreaterThan(0.09);
          expect(life).toBeLessThan(0.5);
          landings.add(`${x.toFixed(2)},${z.toFixed(2)}`);
        }
        expect(landings.size).toBe(darts.length);
        // Impact flares are scheduled in the future (particle delay), never emitted late.
        let delayed = 0;
        for (let i = 0; i < additive.nextSlot; i++) if (misc.getX(i) === 6 && timing.getX(i) > effects.vfx.time + 0.05) delayed++;
        expect(delayed).toBe(darts.length);
      } finally { effects.dispose(); }
    }
  });

  it('the venom pool lingers for the whole active window and keeps bubbling', () => {
    const { effects } = rig();
    try {
      const attack = ATTACKS['viper-venom-spit']!, activeAt = 60 + attack.windupTicks + attack.commitTicks;
      effects.emit(hazardCue('viper-venom-spit', 'active', activeAt, 0));
      effects.update(clock(activeAt));
      const early = effects.vfx.particles.liveCount(effects.vfx.time);
      for (let tick = activeAt; tick < activeAt + 150; tick += 5) effects.update(clock(tick));
      expect(effects.activeCount).toBe(1);
      // After the splash shock fades, the venom decal and the bubbling burn surface remain for the whole window.
      expect(effects.vfx.ground.activeCount()).toBe(2);
      expect(effects.vfx.particles.liveCount(effects.vfx.time)).toBeGreaterThan(Math.min(early, 20));
      effects.update(clock(activeAt + attack.activeTicks + 1));
      expect(effects.activeCount).toBe(0);
    } finally { effects.dispose(); }
  });

  it('the strike lunge draws a lane streak beam that is released with its cue', () => {
    const { effects } = rig();
    try {
      const attack = ATTACKS['viper-strike-lunge']!, activeAt = 60 + attack.windupTicks + attack.commitTicks;
      effects.emit(hazardCue('viper-strike-lunge', 'active', activeAt, 1.1));
      effects.update(clock(activeAt + 1));
      expect(effects.vfx.beams.activeCount).toBe(1);
      effects.update(clock(activeAt + attack.activeTicks + 1));
      expect(effects.vfx.beams.activeCount).toBe(0);
    } finally { effects.dispose(); }
  });

  it('monster auras exist for the three canopy actors and intensify while charging', () => {
    const scene = new Scene(), root = new Object3D();
    scene.add(root);
    const presentation = new StoryPresentation({ scene, resolveSocket: (_actor, name) => name === 'root' ? root : undefined, resolveActorRoot: () => root });
    try {
      const actor = (id: string, y = 0): ActorSnapshot => ({
        id, archetypeId: id, species: 'monster', allegiance: 'hostile', position: { x: 0, y, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: 1 },
        actionId: 'monster-idle', phase: 'idle', normalizedTime: 0, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false,
      } as unknown as ActorSnapshot);
      for (const id of ['canopy-howler', 'canopy-hornbill', 'canopy-mire-viper']) {
        const effects = presentation.effects;
        effects.update(clock(0));
        const before = effects.vfx.particles.additive.nextSlot + effects.vfx.particles.alpha.nextSlot;
        for (let step = 1; step <= 60; step++) { effects.update(clock(step * 2)); presentation.updateActors([actor(id, id === 'canopy-hornbill' ? 2.4 : 0)]); }
        expect(effects.vfx.particles.additive.nextSlot + effects.vfx.particles.alpha.nextSlot - before, id).toBeGreaterThan(10);
      }
    } finally { presentation.dispose(); }
  });
});
