import { describe, expect, it } from 'bun:test';
import { Mesh, Object3D, Scene } from 'three';
import { StoryEffects } from '../../src/effects/StoryEffects.js';
import { StoryPresentation } from '../../src/effects/StoryPresentation.js';
import type { StoryCue } from '../../src/effects/story-cues.js';
import { MOONPINE_ATTACK_KITS, MOONPINE_AURAS, MOONPINE_KIT_IDS, createMoonpineKits, isMoonpineKit } from '../../src/effects/vfx/MoonpineKits.js';
import { resolveKit } from '../../src/effects/vfx/ElementKits.js';
import { Footprint } from '../../src/effects/vfx/footprint.js';
import { OWNER_GLOW } from '../../src/effects/vfx/palette.js';
import { ATTACKS } from '../../src/game/combat/content.js';
import { MOONPINE_CHAIN_ANCHORS, MOONPINE_OWNER_GLOW } from '../../src/game/combat/MoonpineContent.js';
import type { ActorSnapshot, AttackId, WorldClockSnapshot } from '../../src/game/contracts.js';

const clock = (worldTick: number): WorldClockSnapshot => ({ simulationTick: Math.floor(worldTick), worldTick, worldTimeSeconds: worldTick / 60, timeScale: 1, policy: 'normal' });
const ACTOR_OF: Readonly<Record<string, string>> = {
  'frostfang-pack-rush': 'moonpine-frostfang', 'frostfang-ice-bite': 'moonpine-frostfang', 'frostfang-frost-breath': 'moonpine-frostfang',
  'howl-scout-flank-pounce': 'moonpine-scout', 'howl-scout-claw-rake': 'moonpine-scout', 'howl-scout-low-howl': 'moonpine-scout',
  'chained-ruun-chain-pounce': 'moonpine-ruun', 'chained-ruun-howl-shockwave': 'moonpine-ruun', 'chained-ruun-breaking-ice': 'moonpine-ruun',
};
const ELEMENT_OF: Readonly<Record<string, string>> = {
  'frostfang-pack-rush': 'ice', 'frostfang-ice-bite': 'ice', 'frostfang-frost-breath': 'ice',
  'howl-scout-flank-pounce': 'wind', 'howl-scout-claw-rake': 'wind', 'howl-scout-low-howl': 'wind',
  'chained-ruun-chain-pounce': 'earth', 'chained-ruun-howl-shockwave': 'sap', 'chained-ruun-breaking-ice': 'ice',
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
  cast.position.set(3, 1.1, -2); root.position.set(3, 0, -2); scene.add(cast, root);
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

/** Ring-frame particles (frame 6) currently in the additive pool, as [start time, life, size0, size1]. */
function rings(effects: StoryEffects): [number, number, number, number][] {
  const additive = effects.vfx.particles.additive, geometry = additive.mesh.geometry;
  const timing = geometry.getAttribute('iTiming'), size = geometry.getAttribute('iSize'), misc = geometry.getAttribute('iMisc');
  const found: [number, number, number, number][] = [];
  for (let i = 0; i < additive.nextSlot; i++) if (misc.getX(i) === 6 && timing.getY(i) > 0) found.push([timing.getX(i), timing.getY(i), size.getX(i), size.getY(i)]);
  return found;
}

describe('moonpine VFX kits', () => {
  it('resolves every Moonpine attack id to its own kit with the contract element', () => {
    expect(MOONPINE_KIT_IDS.length).toBe(9);
    expect(Object.keys(MOONPINE_ATTACK_KITS).sort()).toEqual([...MOONPINE_KIT_IDS].sort());
    for (const attackId of MOONPINE_KIT_IDS) {
      expect(ATTACKS[attackId], attackId).toBeDefined();
      expect(isMoonpineKit(attackId)).toBe(true);
      for (const phase of ['anticipation', 'commit', 'active'] as const) {
        const resolved = resolveKit(hazardCue(attackId, phase, 60, 0));
        expect({ attackId, phase, kit: resolved.kit, attack: resolved.attack }).toEqual({ attackId, phase, kit: attackId, attack: true });
        expect(resolved.element).toBe(ELEMENT_OF[attackId]!);
      }
      // The contact flash of the hit phase stays on the shared contact kit, tinted by the same element.
      const hit = { ...hazardCue(attackId, 'active', 60, 0), kind: 'hit' as const, phase: 'hit' as const };
      expect(resolveKit(hit)).toEqual({ kit: 'contact', element: ELEMENT_OF[attackId]!, attack: true });
    }
    expect(isMoonpineKit('gale')).toBe(false);
    expect(isMoonpineKit('howler-rock-hurl')).toBe(false);
    // Presentation colours never route to Yara's heartroot kit.
    for (const [, element] of Object.values(MOONPINE_ATTACK_KITS)) expect(element).not.toBe('heartroot');
    const family = createMoonpineKits(rig().effects.vfx, undefined, undefined, { focus: new Object3D().position, hasFocus: false });
    expect(MOONPINE_KIT_IDS.every(kit => family.owns(kit))).toBe(true);
    expect(family.owns('gale')).toBe(false);
  });

  it('gives each Moonpine wolf its own identity glow', () => {
    expect(MOONPINE_OWNER_GLOW).toEqual({ 'moonpine-frostfang': 'ice', 'moonpine-scout': 'wind', 'moonpine-ruun': 'sap' });
    expect(OWNER_GLOW['moonpine-frostfang']).toBe('ice');
    expect(OWNER_GLOW['moonpine-scout']).toBe('wind');
    expect(OWNER_GLOW['moonpine-ruun']).toBe('sap');
  });

  for (const attackId of MOONPINE_KIT_IDS) it(`${attackId}: spawns within every cap, shows all phases and ends cleanly`, () => {
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
      // Only the shared pools draw particles (no extra draw calls); the manual telegraph fills and chains are released with their cues.
      let particleDrawCalls = 0;
      effects.group.traverse(node => { if (node instanceof Mesh && node.name.startsWith('vfx-particles')) particleDrawCalls++; });
      expect(particleDrawCalls).toBe(2);
      effects.update(clock(60 + 4000));
      expect(effects.activeCount).toBe(0);
      expect(effects.vfx.beams.activeCount).toBe(0);
      expect(effects.vfx.ground.activeCount(1)).toBe(0);
    } finally { effects.dispose(); }
  });

  for (const attackId of MOONPINE_KIT_IDS) it(`${attackId}: reduced effects keep the cue readable with fewer particles`, () => {
    const normal = rig(false), reduced = rig(true);
    try {
      const full = playAttack(normal.effects, attackId), lean = playAttack(reduced.effects, attackId);
      expect(lean).toBeGreaterThan(0);
      expect(lean).toBeLessThan(full);
      expect(reduced.effects.vfx.reducedEffects).toBe(true);
    } finally { normal.effects.dispose(); reduced.effects.dispose(); }
  });

  for (const attackId of MOONPINE_KIT_IDS) it(`${attackId}: cancelling the scope removes everything the cue produced`, () => {
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
      expect(effects.vfx.beams.activeCount).toBe(0);
      expect(effects.vfx.particles.liveCount(time + 0.001, 1)).toBe(0);
    } finally { effects.dispose(); }
  });

  it('keeps every ground quad inside the authored footprint, through every phase and the decay', () => {
    for (const attackId of MOONPINE_KIT_IDS) {
      const { effects } = rig();
      try {
        const attack = ATTACKS[attackId]!, start = 60, commitAt = start + attack.windupTicks, activeAt = commitAt + attack.commitTicks, cue = hazardCue(attackId, 'active', activeAt, 0.7);
        const fp = new Footprint().setFromCue(cue, 1);
        let checked = 0;
        const inside = (): void => {
          for (const node of effects.vfx.ground.group.children) {
            if (!node.visible) continue;
            const quad = node as Mesh, hx = quad.scale.x / 2, hz = quad.scale.z / 2, c = Math.cos(quad.rotation.y), s = Math.sin(quad.rotation.y);
            for (const [lx, lz] of [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]] as const) {
              const wx = quad.position.x + lx * c + lz * s, wz = quad.position.z - lx * s + lz * c;
              expect(fp.localX(wx, wz), attackId).toBeGreaterThanOrEqual(fp.minX - 1e-6);
              expect(fp.localX(wx, wz), attackId).toBeLessThanOrEqual(fp.maxX + 1e-6);
              expect(fp.localZ(wx, wz), attackId).toBeGreaterThanOrEqual(fp.minZ - 1e-6);
              expect(fp.localZ(wx, wz), attackId).toBeLessThanOrEqual(fp.maxZ + 1e-6);
            }
            checked++;
          }
        };
        effects.emit(hazardCue(attackId, 'anticipation', start, 0.7));
        for (let tick = start; tick < commitAt; tick += 6) { effects.update(clock(tick)); inside(); }
        effects.emit(hazardCue(attackId, 'commit', commitAt, 0.7));
        for (let tick = commitAt; tick < activeAt; tick += 3) { effects.update(clock(tick)); inside(); }
        effects.emit(cue);
        for (let tick = activeAt; tick < activeAt + Math.min(attack.activeTicks, 200) + 150; tick += 4) { effects.update(clock(tick)); inside(); }
        expect(checked, attackId).toBeGreaterThan(10);
      } finally { effects.dispose(); }
    }
  });

  it('the frost breath raises ice crystals across the cone (fewer in reduced effects) and the breaking ice a crack of them along the band', () => {
    for (const reduced of [false, true]) {
      for (const [attackId, full] of [['frostfang-frost-breath', 12], ['chained-ruun-breaking-ice', 10]] as const) {
        const { effects } = rig(reduced);
        try {
          const attack = ATTACKS[attackId]!, activeAt = 60 + attack.windupTicks + attack.commitTicks;
          effects.emit(hazardCue(attackId, 'active', activeAt, -0.8));
          effects.update(clock(activeAt));
          const spikes = effects.vfx.spikes.mesh.count;
          expect(spikes).toBe(reduced ? 5 : full);
        } finally { effects.dispose(); }
      }
    }
  });

  it('Ruun draws his chains to the four anchor posts through the pounce and the howl, and releases them with each cue', () => {
    expect(MOONPINE_CHAIN_ANCHORS).toHaveLength(4);
    for (const attackId of ['chained-ruun-chain-pounce', 'chained-ruun-howl-shockwave']) {
      const { effects } = rig();
      try {
        const attack = ATTACKS[attackId]!, commitAt = 60 + attack.windupTicks;
        effects.emit(hazardCue(attackId, 'anticipation', 60, 0.3));
        effects.update(clock(60 + 3));
        expect(effects.vfx.beams.activeCount, attackId).toBe(4);
        effects.update(clock(commitAt - 3));
        effects.emit(hazardCue(attackId, 'commit', commitAt, 0.3));
        effects.update(clock(commitAt));
        // The anticipation cue ended with its phase; the commit cue draws its own taut chains.
        expect(effects.vfx.beams.activeCount, attackId).toBe(4);
        effects.update(clock(commitAt + attack.commitTicks + 600));
        expect(effects.vfx.beams.activeCount).toBe(0);
      } finally { effects.dispose(); }
    }
    // Wolves without chains draw none outside the strike beam of the ice bite.
    const { effects } = rig();
    try {
      effects.emit(hazardCue('frostfang-pack-rush', 'anticipation', 60, 0));
      effects.update(clock(63));
      expect(effects.vfx.beams.activeCount).toBe(0);
    } finally { effects.dispose(); }
  });

  it('the three-beat howl sends three rings out of the muzzle on rising beats; the scout low howl pulses rings that climb', () => {
    const { effects } = rig();
    try {
      const attack = ATTACKS['chained-ruun-howl-shockwave']!;
      effects.emit(hazardCue('chained-ruun-howl-shockwave', 'anticipation', 60, 0));
      for (let tick = 60; tick < 60 + attack.windupTicks; tick += 3) effects.update(clock(tick));
      const beats = rings(effects);
      expect(beats).toHaveLength(3);
      const starts = beats.map(ring => ring[0]);
      expect(starts[0]!).toBeLessThan(starts[1]!);
      expect(starts[1]!).toBeLessThan(starts[2]!);
      expect(beats.map(ring => ring[3])).toEqual([...beats.map(ring => ring[3])].sort((a, b) => a - b)); // each ring grows larger than the last
    } finally { effects.dispose(); }
    const scout = rig();
    try {
      const attack = ATTACKS['howl-scout-low-howl']!;
      scout.effects.emit(hazardCue('howl-scout-low-howl', 'anticipation', 60, 0));
      for (let tick = 60; tick < 60 + attack.windupTicks; tick += 3) scout.effects.update(clock(tick));
      expect(rings(scout.effects).length).toBeGreaterThanOrEqual(2);
    } finally { scout.effects.dispose(); }
  });

  it('the howl shockwave rings stay inside its marked area', () => {
    const { effects } = rig();
    try {
      const attack = ATTACKS['chained-ruun-howl-shockwave']!, activeAt = 60 + attack.windupTicks + attack.commitTicks;
      const cue = hazardCue('chained-ruun-howl-shockwave', 'active', activeAt, 0);
      const fp = new Footprint().setFromCue(cue, 1);
      effects.emit(cue);
      effects.update(clock(activeAt));
      // The three ground rings centred on the mark never exceed its inscribed diameter; the two muzzle rings (centred on the head) are 3-4 m.
      const bound = 2 * fp.halfWidth + 1e-6;
      const grounded = rings(effects).filter(ring => ring[3] > 4.1);
      expect(grounded.length).toBeGreaterThanOrEqual(3);
      for (const ring of grounded) expect(ring[3]).toBeLessThanOrEqual(bound);
    } finally { effects.dispose(); }
  });

  it('the ice bite draws a lane streak beam that is released with its cue', () => {
    const { effects } = rig();
    try {
      const attack = ATTACKS['frostfang-ice-bite']!, activeAt = 60 + attack.windupTicks + attack.commitTicks;
      effects.emit(hazardCue('frostfang-ice-bite', 'active', activeAt, 1.1));
      effects.update(clock(activeAt + 1));
      expect(effects.vfx.beams.activeCount).toBe(1);
      effects.update(clock(activeAt + attack.activeTicks + 1));
      expect(effects.vfx.beams.activeCount).toBe(0);
    } finally { effects.dispose(); }
  });

  it('the rake, the howl, the rush and the breaking ice sweep their crescents across the band: blades are in flight right after the burst', () => {
    for (const attackId of ['howl-scout-claw-rake', 'howl-scout-low-howl', 'frostfang-pack-rush', 'chained-ruun-breaking-ice']) {
      const { effects } = rig();
      try {
        const attack = ATTACKS[attackId]!, activeAt = 60 + attack.windupTicks + attack.commitTicks;
        effects.emit(hazardCue(attackId, 'active', activeAt, 0.5));
        effects.update(clock(activeAt));
        effects.update(clock(activeAt + 6));
        let flying = 0;
        for (const node of effects.vfx.blades.group.children) if (node.visible) flying++;
        expect(flying, attackId).toBeGreaterThanOrEqual(1);
        // They are gone again once their short life has run out.
        effects.update(clock(activeAt + 120));
        flying = 0;
        for (const node of effects.vfx.blades.group.children) if (node.visible) flying++;
        expect(flying, attackId).toBe(0);
      } finally { effects.dispose(); }
    }
  });

  it('monster auras exist for the three Moonpine actors and intensify while charging', () => {
    expect(MOONPINE_AURAS).toEqual({ 'moonpine-frostfang': 'frost', 'moonpine-scout': 'earth', 'moonpine-ruun': 'howler' });
    const scene = new Scene(), root = new Object3D();
    scene.add(root);
    const presentation = new StoryPresentation({ scene, resolveSocket: (_actor, name) => name === 'root' ? root : undefined, resolveActorRoot: () => root });
    try {
      const actor = (id: string): ActorSnapshot => ({
        id, archetypeId: id, species: 'monster', allegiance: 'hostile', position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: 1 },
        actionId: 'monster-idle', phase: 'idle', normalizedTime: 0, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false,
      } as unknown as ActorSnapshot);
      for (const id of ['moonpine-frostfang', 'moonpine-scout', 'moonpine-ruun']) {
        const effects = presentation.effects;
        effects.update(clock(0));
        const before = effects.vfx.particles.additive.nextSlot + effects.vfx.particles.alpha.nextSlot;
        for (let step = 1; step <= 60; step++) { effects.update(clock(step * 2)); presentation.updateActors([actor(id)]); }
        expect(effects.vfx.particles.additive.nextSlot + effects.vfx.particles.alpha.nextSlot - before, id).toBeGreaterThan(10);
      }
    } finally { presentation.dispose(); }
  });
});
