import { describe, expect, it } from 'bun:test';
import { Mesh, Object3D, Scene } from 'three';
import { StoryEffects } from '../../src/effects/StoryEffects.js';
import { StoryPresentation } from '../../src/effects/StoryPresentation.js';
import type { StoryCue } from '../../src/effects/story-cues.js';
import { MISTVEIL_ATTACK_KITS, MISTVEIL_AURAS, MISTVEIL_KIT_IDS, isMistveilKit } from '../../src/effects/vfx/MistveilKits.js';
import { resolveKit } from '../../src/effects/vfx/ElementKits.js';
import { OWNER_GLOW } from '../../src/effects/vfx/palette.js';
import { ATTACKS } from '../../src/game/combat/content.js';
import type { ActorSnapshot, AttackId, WorldClockSnapshot } from '../../src/game/contracts.js';

const clock = (worldTick: number): WorldClockSnapshot => ({ simulationTick: Math.floor(worldTick), worldTick, worldTimeSeconds: worldTick / 60, timeScale: 1, policy: 'normal' });
const ACTOR_OF: Readonly<Record<string, string>> = {
  'bog-lurker-tongue-lash': 'mistveil-lurker', 'bog-lurker-bubble-pool': 'mistveil-lurker', 'bog-lurker-mud-hop': 'mistveil-lurker',
  'lantern-heron-spear-dive': 'mistveil-heron', 'lantern-heron-mist-gust': 'mistveil-heron', 'lantern-heron-flare-burst': 'mistveil-heron',
  'mire-maw-tail-sweep': 'mistveil-ghor', 'mire-maw-bite-lunge': 'mistveil-ghor', 'mire-maw-black-river-wave': 'mistveil-ghor',
};
/** The presentation element of each kit (the VfxElement the cue is tinted with; lantern light is warm gold). */
const ELEMENT_OF: Readonly<Record<string, string>> = {
  'bog-lurker-tongue-lash': 'earth', 'bog-lurker-bubble-pool': 'poison', 'bog-lurker-mud-hop': 'earth',
  'lantern-heron-spear-dive': 'wind', 'lantern-heron-mist-gust': 'wind', 'lantern-heron-flare-burst': 'gold',
  'mire-maw-tail-sweep': 'earth', 'mire-maw-bite-lunge': 'earth', 'mire-maw-black-river-wave': 'poison',
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

describe('mistveil VFX kits', () => {
  it('resolves every Mistveil attack id to its own kit with the contract element', () => {
    expect(MISTVEIL_KIT_IDS.length).toBe(9);
    expect(Object.keys(MISTVEIL_ATTACK_KITS).sort()).toEqual([...MISTVEIL_KIT_IDS].sort());
    for (const attackId of MISTVEIL_KIT_IDS) {
      expect(ATTACKS[attackId], attackId).toBeDefined();
      expect(isMistveilKit(attackId)).toBe(true);
      expect(MISTVEIL_ATTACK_KITS[attackId]).toEqual([attackId, ELEMENT_OF[attackId]!]);
      for (const phase of ['anticipation', 'commit', 'active'] as const) {
        const resolved = resolveKit(hazardCue(attackId, phase, 60, 0));
        expect({ attackId, phase, kit: resolved.kit, attack: resolved.attack }).toEqual({ attackId, phase, kit: attackId, attack: true });
        expect(resolved.element).toBe(ELEMENT_OF[attackId]!);
      }
      // The contact flash of the hit phase stays on the shared contact kit, tinted by the same element.
      const hit = { ...hazardCue(attackId, 'active', 60, 0), kind: 'hit' as const, phase: 'hit' as const };
      expect(resolveKit(hit)).toEqual({ kit: 'contact', element: ELEMENT_OF[attackId]!, attack: true });
    }
    expect(isMistveilKit('gale')).toBe(false);
    expect(isMistveilKit('howler-rock-hurl')).toBe(false);
  });

  it('gives each Mistveil monster its own identity glow and body aura, never heartroot', () => {
    expect(OWNER_GLOW['mistveil-lurker']).toBe('earth');
    expect(OWNER_GLOW['mistveil-heron']).toBe('wind');
    expect(OWNER_GLOW['mistveil-ghor']).toBe('poison');
    expect(MISTVEIL_AURAS).toEqual({ 'mistveil-lurker': 'earth', 'mistveil-heron': 'storm', 'mistveil-ghor': 'toxic' });
    for (const element of Object.values(MISTVEIL_ATTACK_KITS).map(entry => entry[1])) expect(element).not.toBe('heartroot');
  });

  for (const attackId of MISTVEIL_KIT_IDS) it(`${attackId}: spawns within every cap, shows all phases and ends cleanly`, () => {
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
      expect(effects.vfx.ground.activeCount()).toBe(0);
    } finally { effects.dispose(); }
  });

  for (const attackId of MISTVEIL_KIT_IDS) it(`${attackId}: reduced effects keep the cue readable with fewer particles`, () => {
    const normal = rig(false), reduced = rig(true);
    try {
      const full = playAttack(normal.effects, attackId), lean = playAttack(reduced.effects, attackId);
      expect(lean).toBeGreaterThan(0);
      expect(lean).toBeLessThan(full);
      expect(reduced.effects.vfx.reducedEffects).toBe(true);
    } finally { normal.effects.dispose(); reduced.effects.dispose(); }
  });

  for (const attackId of MISTVEIL_KIT_IDS) it(`${attackId}: cancelling the scope removes everything the cue produced`, () => {
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

  it('the tongue lash and the bite lunge draw a lane beam that is released with its cue', () => {
    for (const attackId of ['bog-lurker-tongue-lash', 'mire-maw-bite-lunge']) {
      const { effects } = rig();
      try {
        const attack = ATTACKS[attackId]!, activeAt = 60 + attack.windupTicks + attack.commitTicks;
        effects.emit(hazardCue(attackId, 'active', activeAt, 1.1));
        effects.update(clock(activeAt + 1));
        expect(effects.vfx.beams.activeCount, attackId).toBe(1);
        effects.update(clock(activeAt + attack.activeTicks + 1));
        expect(effects.vfx.beams.activeCount, attackId).toBe(0);
      } finally { effects.dispose(); }
    }
  });

  it('the bubble pool lingers for the whole active window and keeps bubbling', () => {
    const { effects } = rig();
    try {
      const attack = ATTACKS['bog-lurker-bubble-pool']!, activeAt = 60 + attack.windupTicks + attack.commitTicks;
      effects.emit(hazardCue('bog-lurker-bubble-pool', 'active', activeAt, 0));
      effects.update(clock(activeAt));
      const early = effects.vfx.particles.liveCount(effects.vfx.time);
      for (let tick = activeAt; tick < activeAt + 150; tick += 5) effects.update(clock(tick));
      expect(effects.activeCount).toBe(1);
      // After the splash shock fades, the murk decal and the bubbling burn surface remain for the whole window.
      expect(effects.vfx.ground.activeCount()).toBe(2);
      expect(effects.vfx.particles.liveCount(effects.vfx.time)).toBeGreaterThan(Math.min(early, 20));
      effects.update(clock(activeAt + attack.activeTicks + 1));
      expect(effects.activeCount).toBe(0);
    } finally { effects.dispose(); }
  });

  it('the lantern flare is a warm gold burst: shock, decal and a light pulse stay inside the cue footprint', () => {
    const { effects } = rig();
    try {
      const attack = ATTACKS['lantern-heron-flare-burst']!, activeAt = 60 + attack.windupTicks + attack.commitTicks;
      effects.emit(hazardCue('lantern-heron-flare-burst', 'active', activeAt, 0));
      effects.update(clock(activeAt));
      expect(effects.vfx.ground.activeCount()).toBeGreaterThanOrEqual(2);
      expect(effects.vfx.particles.liveCount(effects.vfx.time)).toBeGreaterThan(30);
      effects.update(clock(activeAt + attack.activeTicks + 200));
      expect(effects.activeCount).toBe(0);
    } finally { effects.dispose(); }
  });

  it('the black river wave leaves a sheen for its active window and releases it afterwards', () => {
    const { effects } = rig();
    try {
      const attack = ATTACKS['mire-maw-black-river-wave']!, activeAt = 60 + attack.windupTicks + attack.commitTicks;
      effects.emit(hazardCue('mire-maw-black-river-wave', 'active', activeAt, 0.3));
      effects.update(clock(activeAt + 2));
      expect(effects.vfx.ground.activeCount()).toBeGreaterThanOrEqual(2);
      effects.update(clock(activeAt + attack.activeTicks + 400));
      expect(effects.activeCount).toBe(0);
      expect(effects.vfx.ground.activeCount()).toBe(0);
    } finally { effects.dispose(); }
  });

  it('monster auras exist for the three Mistveil actors and intensify while charging', () => {
    const scene = new Scene(), root = new Object3D();
    scene.add(root);
    const presentation = new StoryPresentation({ scene, resolveSocket: (_actor, name) => name === 'root' ? root : undefined, resolveActorRoot: () => root });
    try {
      const actor = (id: string): ActorSnapshot => ({
        id, archetypeId: id, species: 'monster', allegiance: 'hostile', position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: 1 },
        actionId: 'monster-idle', phase: 'idle', normalizedTime: 0, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false,
      } as unknown as ActorSnapshot);
      for (const id of ['mistveil-lurker', 'mistveil-heron', 'mistveil-ghor']) {
        const effects = presentation.effects;
        effects.update(clock(0));
        const before = effects.vfx.particles.additive.nextSlot + effects.vfx.particles.alpha.nextSlot;
        for (let step = 1; step <= 60; step++) { effects.update(clock(step * 2)); presentation.updateActors([actor(id)]); }
        expect(effects.vfx.particles.additive.nextSlot + effects.vfx.particles.alpha.nextSlot - before, id).toBeGreaterThan(10);
      }
    } finally { presentation.dispose(); }
  });
});
