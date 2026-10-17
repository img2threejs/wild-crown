import { describe, expect, it } from 'bun:test';
import { Mesh, Object3D, Scene, ShaderMaterial, Vector3 } from 'three';
import { StoryEffects } from '../../src/effects/StoryEffects.js';
import { StoryPresentation } from '../../src/effects/StoryPresentation.js';
import type { StoryCue } from '../../src/effects/story-cues.js';
import { resolveKit } from '../../src/effects/vfx/ElementKits.js';
import { Footprint } from '../../src/effects/vfx/footprint.js';
import { GROVE_ATTACK_KITS, GROVE_AURAS, GROVE_KIT_IDS, isGroveKit } from '../../src/effects/vfx/GroveKits.js';
import { isCanopyKit } from '../../src/effects/vfx/CanopyKits.js';
import { OWNER_GLOW } from '../../src/effects/vfx/palette.js';
import { ATTACKS } from '../../src/game/combat/content.js';
import type { ActorSnapshot, AttackId, WorldClockSnapshot } from '../../src/game/contracts.js';

const clock = (worldTick: number): WorldClockSnapshot => ({ simulationTick: Math.floor(worldTick), worldTick, worldTimeSeconds: worldTick / 60, timeScale: 1, policy: 'normal' });
const ELEMENT_OF: Readonly<Record<string, string>> = {
  'sprig-seed-toss': 'sap', 'sprig-ground-ripple': 'earth', 'sprig-petal-sweep': 'spirit',
  'blighted-seed-lob': 'poison', 'blighted-ground-pulse': 'poison', 'blighted-lash-sweep': 'poison',
  'hollowheart-leap-smash': 'earth', 'hollowheart-antler-sweep': 'sap', 'hollowheart-ichor-hurl': 'poison', 'hollowheart-heartlight-burst': 'gold',
};

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
    attackId: attackId as AttackId, element: attack.element, actorId: 'grove-sprig', targetId: 'aren', priority: 'essential',
    position: target, from: origin, to: target, shape, durationTicks: duration,
    footprint: {
      width: disk ? 2 * hazard.radius : hazard.width,
      length: disk ? 2 * hazard.radius : hazard.depth,
      angleRadians: hazard.kind === 'area' ? 0 : yaw,
    },
  };
}

function rig(reducedEffects = false): { scene: Scene; effects: StoryEffects; cast: Object3D; root: Object3D } {
  const scene = new Scene(), cast = new Object3D(), root = new Object3D();
  cast.position.set(3, 1.7, -2); root.position.set(3, 0, -2); scene.add(cast, root);
  const effects = new StoryEffects({ scene, reducedEffects, resolveSocket: (_actor, name) => name === 'cast' ? cast : name === 'root' ? root : undefined, capacity: 24 });
  return { scene, effects, cast, root };
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

describe('grove VFX kits', () => {
  it('resolves every Grove attack id to its kit and element, in all three phases', () => {
    expect([...GROVE_KIT_IDS]).toEqual(['sprig-seed-toss', 'sprig-ground-ripple', 'sprig-petal-sweep', 'hollowheart-leap-smash', 'hollowheart-antler-sweep', 'hollowheart-ichor-hurl', 'hollowheart-heartlight-burst']);
    expect(Object.keys(GROVE_ATTACK_KITS).sort()).toEqual(Object.keys(ELEMENT_OF).sort());
    for (const [attackId, element] of Object.entries(ELEMENT_OF)) {
      expect(ATTACKS[attackId], attackId).toBeDefined();
      expect(isGroveKit(attackId) || GROVE_ATTACK_KITS[attackId] !== undefined).toBe(true);
      expect(isCanopyKit(attackId)).toBe(false);
      const [kit] = GROVE_ATTACK_KITS[attackId]!;
      expect(GROVE_ATTACK_KITS[attackId]).toEqual([kit, element]);
      expect(isGroveKit(kit)).toBe(true);
      for (const phase of ['anticipation', 'commit', 'active'] as const) {
        const resolved = resolveKit(hazardCue(attackId, phase, 60, 0));
        expect({ attackId, phase, kit: resolved.kit, attack: resolved.attack }).toEqual({ attackId, phase, kit, attack: true });
        expect(resolved.element).toBe(element);
      }
      // The contact flash of the hit phase stays on the shared contact kit, tinted by the same element; never the player-only heartroot look.
      const hit = { ...hazardCue(attackId, 'active', 60, 0), kind: 'hit' as const, phase: 'hit' as const };
      expect(resolveKit(hit)).toEqual({ kit: 'contact', element, attack: true });
      expect(element).not.toBe('heartroot');
    }
    // The blighted rootling plays the sprig's three kits in poison; the guardian has four kits of its own.
    expect(GROVE_ATTACK_KITS['blighted-seed-lob']).toEqual(['sprig-seed-toss', 'poison']);
    expect(GROVE_ATTACK_KITS['blighted-ground-pulse']).toEqual(['sprig-ground-ripple', 'poison']);
    expect(GROVE_ATTACK_KITS['blighted-lash-sweep']).toEqual(['sprig-petal-sweep', 'poison']);
    expect(isGroveKit('gale')).toBe(false);
    expect(isGroveKit('howler-rock-hurl')).toBe(false);
  });

  it('gives each Grove monster its own identity glow and aura: earth motes, toxic motes and the guardian\'s glowing heart', () => {
    expect(OWNER_GLOW['grove-sprig']).toBe('sap');
    expect(OWNER_GLOW['grove-blighted']).toBe('poison');
    expect(OWNER_GLOW['grove-hollowheart']).toBe('sap');
    expect(GROVE_AURAS).toEqual({ 'grove-sprig': 'earth', 'grove-blighted': 'toxic', 'grove-hollowheart': 'heartlight' });
  });

  it('draws the ground tell 1.5x for the sprig, 2.2x (1x for the gold heart-light burst) plus the contrast-aware tell for the blighted rootling and the guardian, so it reads on the dark blighted ground', () => {
    /** Ground fill intensity and tell at the given tick of the windup, and the base value the kit would drive at that progress without any gain. */
    const tell = (attackId: string): { intensity: number; base: number; tell: number } => {
      const { effects } = rig(), offset = Math.floor(ATTACKS[attackId]!.windupTicks * 0.75);
      try {
        effects.emit(hazardCue(attackId, 'anticipation', 60, 0.4));
        effects.update(clock(60 + offset));
        let peak = 0, contrast = -1;
        effects.vfx.ground.group.traverse(node => {
          if (!(node instanceof Mesh) || !node.visible || !(node.material instanceof ShaderMaterial)) return;
          if (node.material.uniforms.uMode!.value === 0) { peak = Math.max(peak, node.material.uniforms.uIntensity!.value); contrast = node.material.uniforms.uTell!.value; }
        });
        return { intensity: peak, base: 0.8 + 0.25 * (offset / ATTACKS[attackId]!.windupTicks) * 0.8, tell: contrast };
      } finally { effects.dispose(); }
    };
    const sprig = tell('sprig-seed-toss');
    expect(sprig.intensity).toBeCloseTo(sprig.base * 1.5, 2);
    expect(sprig.tell).toBe(0);
    for (const attackId of ['blighted-seed-lob', 'blighted-ground-pulse', 'blighted-lash-sweep', ...GROVE_KIT_IDS.filter(id => id.startsWith('hollowheart'))]) {
      const dark = tell(attackId);
      expect(dark.intensity, attackId).toBeCloseTo(dark.base * (attackId === 'hollowheart-heartlight-burst' ? 1 : 2.2), 2);
      expect(dark.tell, attackId).toBeCloseTo(0.8, 5);
    }
  });

  for (const attackId of GROVE_KIT_IDS) it(`${attackId}: spawns within every cap, shows all phases and ends cleanly`, () => {
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
      expect(effects.vfx.beams.activeCount).toBe(0);
    } finally { effects.dispose(); }
  });

  for (const attackId of GROVE_KIT_IDS) it(`${attackId}: reduced effects keep the cue readable with fewer particles`, () => {
    const normal = rig(false), reduced = rig(true);
    try {
      const full = playAttack(normal.effects, attackId), lean = playAttack(reduced.effects, attackId);
      expect(lean).toBeGreaterThan(0);
      expect(lean).toBeLessThan(full);
      expect(reduced.effects.vfx.reducedEffects).toBe(true);
    } finally { normal.effects.dispose(); reduced.effects.dispose(); }
  });

  for (const attackId of GROVE_KIT_IDS) it(`${attackId}: cancelling the scope removes everything the cue produced`, () => {
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

  it('cancelling an active petal sweep releases its lane beam and ground quads', () => {
    const { effects } = rig();
    try {
      const attack = ATTACKS['sprig-petal-sweep']!, activeAt = 60 + attack.windupTicks + attack.commitTicks;
      effects.emit(hazardCue('sprig-petal-sweep', 'active', activeAt, 0.8));
      effects.update(clock(activeAt + 1));
      expect(effects.vfx.beams.activeCount).toBe(1);
      effects.cancelScope('sprig-petal-sweep', 'interrupt');
      effects.update(clock(activeAt + 2));
      expect(effects.vfx.beams.activeCount).toBe(0);
      expect(effects.vfx.ground.activeCount()).toBe(0);
    } finally { effects.dispose(); }
  });

  it('the seed is lobbed in an arc from the cast socket to the committed point and the bloom arrives with the active phase', () => {
    const { effects } = rig();
    try {
      const attack = ATTACKS['sprig-seed-toss']!, yaw = 0.6, commitAt = 60 + attack.windupTicks, activeAt = commitAt + attack.commitTicks;
      const target = hazardCue('sprig-seed-toss', 'commit', commitAt, yaw).to!;
      const additive = effects.vfx.particles.additive, origin = additive.mesh.geometry.getAttribute('iOrigin');
      /** Mean position of the particles emitted since `from` (the lob head and its fresh sparkle all spawn at the head). */
      const centroid = (from: number): Vector3 => {
        const sum = new Vector3();
        const count = additive.nextSlot - from;
        for (let i = from; i < additive.nextSlot; i++) sum.add(new Vector3(origin.getX(i), origin.getY(i), origin.getZ(i)));
        return count > 0 ? sum.multiplyScalar(1 / count) : new Vector3(NaN, NaN, NaN);
      };
      effects.emit(hazardCue('sprig-seed-toss', 'anticipation', 60, yaw));
      effects.update(clock(60 + attack.windupTicks - 3));
      effects.emit(hazardCue('sprig-seed-toss', 'commit', commitAt, yaw));
      effects.update(clock(commitAt));
      const midFrom = additive.nextSlot;
      effects.update(clock(commitAt + attack.commitTicks / 2));
      const mid = centroid(midFrom);
      const endFrom = additive.nextSlot;
      effects.update(clock(activeAt - 0.5));
      const end = centroid(endFrom);
      // Mid-flight the seed is above the straight line between the cast socket (y ~2) and the mark (y ~0.2): an arc.
      expect(mid.y).toBeGreaterThan(1.1 + 0.25);
      expect(Math.hypot(end.x - target.x, end.z - target.z)).toBeLessThan(0.6);
      expect(end.y).toBeLessThan(0.9);
      effects.emit(hazardCue('sprig-seed-toss', 'active', activeAt, yaw));
      effects.update(clock(activeAt));
      expect(effects.vfx.ground.activeCount()).toBeGreaterThan(0);
    } finally { effects.dispose(); }
  });

  it('every ground quad stays inside the authored footprint: the ripple band and the petal lane never spill', () => {
    for (const attackId of ['sprig-ground-ripple', 'sprig-petal-sweep']) {
      const { effects } = rig();
      try {
        const yaw = -0.5, attack = ATTACKS[attackId]!, activeAt = 60 + attack.windupTicks + attack.commitTicks;
        const cue = hazardCue(attackId, 'active', activeAt, yaw), fp = new Footprint().setFromCue(cue, 1);
        const additive = effects.vfx.particles.additive, geometry = additive.mesh.geometry;
        const origin = geometry.getAttribute('iOrigin'), misc = geometry.getAttribute('iMisc');
        effects.emit(cue);
        effects.update(clock(activeAt));
        let streaks = 0;
        // Spark-frame streaks (ripple lines, lane glimmer) are only ever spawned from points inside the cue footprint.
        for (let i = 0; i < additive.nextSlot; i++) if (misc.getX(i) === 2) { streaks++; expect(fp.contains(origin.getX(i), origin.getZ(i), 0.4)).toBe(true); }
        expect(streaks).toBeGreaterThan(0);
      } finally { effects.dispose(); }
    }
  });

  it('the sprig has an idle aura that intensifies while the world runs', () => {
    const scene = new Scene(), root = new Object3D();
    scene.add(root);
    const presentation = new StoryPresentation({ scene, resolveSocket: (_actor, name) => name === 'root' ? root : undefined, resolveActorRoot: () => root });
    try {
      const actor = (id: string): ActorSnapshot => ({
        id, archetypeId: id, species: 'monster', allegiance: 'hostile', position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: 1 },
        actionId: 'monster-idle', phase: 'idle', normalizedTime: 0, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false,
      } as unknown as ActorSnapshot);
      const effects = presentation.effects;
      effects.update(clock(0));
      const before = effects.vfx.particles.additive.nextSlot + effects.vfx.particles.alpha.nextSlot;
      for (let step = 1; step <= 60; step++) { effects.update(clock(step * 2)); presentation.updateActors([actor('grove-sprig')]); }
      expect(effects.vfx.particles.additive.nextSlot + effects.vfx.particles.alpha.nextSlot - before).toBeGreaterThan(10);
    } finally { presentation.dispose(); }
  });
});
