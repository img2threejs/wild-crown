import { describe, expect, it } from 'bun:test';
import { Bone, BufferAttribute, BufferGeometry, Color, Group, Mesh, MeshStandardMaterial, Object3D, Scene, ShaderMaterial, Skeleton, SkinnedMesh } from 'three';
import { StoryEffects } from '../../src/effects/StoryEffects.js';
import type { ImpactSink } from '../../src/effects/vfx/ElementKits.js';
import { DISSOLVE_SECONDS } from '../../src/effects/vfx/CleanseDissolveFx.js';
import { WARDEN_OWNER } from '../../src/effects/vfx/WardenFx.js';
import type { StoryCue } from '../../src/effects/story-cues.js';
import type { ActorSnapshot, CombatSnapshot, JudgementMarkSnapshot, PlayerProjectileSnapshot } from '../../src/game/contracts.js';

let sequence = 0;
function cue(partial: Partial<StoryCue> & Pick<StoryCue, 'kind' | 'phase'>, tick = 0): StoryCue {
  return { instanceId: `warden:${++sequence}`, tick, worldTick: tick, worldTimeSeconds: tick / 60, priority: 'essential', ...partial };
}
function clock(effects: StoryEffects, tick: number): void { effects.update({ simulationTick: tick, worldTick: tick, worldTimeSeconds: tick / 60, timeScale: 1, policy: 'normal' }); }
function actor(partial: Partial<ActorSnapshot> & { id: string }): ActorSnapshot {
  return {
    archetypeId: partial.id, species: 'x', allegiance: 'hostile', position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, facing: { x: 0, y: 0, z: 1 }, actionId: 'idle', phase: 'idle',
    normalizedTime: 0, sockets: {}, interactionRequirements: [], visible: true, downed: false, possessed: false, ...partial,
  } as ActorSnapshot;
}
function snapshot(tick: number, extra: { actors?: ActorSnapshot[]; playerProjectiles?: PlayerProjectileSnapshot[]; judgementMarks?: JudgementMarkSnapshot[] } = {}): CombatSnapshot {
  return {
    actors: extra.actors ?? [actor({ id: 'aren', allegiance: 'player' })], playerProjectiles: extra.playerProjectiles, judgementMarks: extra.judgementMarks,
    worldClock: { simulationTick: tick, worldTick: tick, worldTimeSeconds: tick / 60, timeScale: 1, policy: 'normal' },
  } as unknown as CombatSnapshot;
}
const bolt = (x: number, age: number): PlayerProjectileSnapshot => ({ id: 'bolt:1', kind: 'sigil-bolt', ownerId: 'aren', position: { x, y: 1.25, z: 0 }, direction: { x: 1, y: 0, z: 0 }, speed: 28, radius: 0.35, ageTicks: age, lifeTicks: 60 });
const wave = (x: number, age: number): PlayerProjectileSnapshot => ({ id: 'wave:1', kind: 'crescent-wave', ownerId: 'aren', position: { x, y: 0.5, z: 0 }, direction: { x: 1, y: 0, z: 0 }, speed: 20, radius: 1.4, ageTicks: age, lifeTicks: 27 });
function sink(): ImpactSink & { shakes: number; impulses: number[]; flashes: string[] } {
  const record = { shakes: 0, impulses: [] as number[], flashes: [] as string[] };
  return Object.assign(record, {
    shake: () => { record.shakes++; }, flashActor: (id: string) => { record.flashes.push(id); }, impulse: (strength: number) => { record.impulses.push(strength); },
  });
}

describe('rune sigils', () => {
  it('appear on the cue, and are released on scope cancellation and on natural expiry', () => {
    const effects = new StoryEffects({ scene: new Scene() });
    try {
      const w = effects.warden;
      effects.emit(cue({ kind: 'sigil', phase: 'anticipation', actorId: 'aren', scopeId: 'sigil:1', position: { x: 0, y: 1.25, z: 0.9 }, to: { x: 0, y: 1.25, z: 8 }, durationTicks: 16, intensity: 1, element: 'arcane' }));
      clock(effects, 1);
      expect(w.sigils.activeCount).toBe(1);
      effects.cancelScope('sigil:1', 'interrupt');
      expect(w.sigils.activeCount).toBe(0);
      effects.emit(cue({ kind: 'sigil', phase: 'anticipation', actorId: 'aren', scopeId: 'sigil:2', position: { x: 0, y: 1.25, z: 0.9 }, to: { x: 0, y: 1.25, z: 8 }, durationTicks: 16, intensity: 1, element: 'arcane' }, 10));
      clock(effects, 11);
      expect(w.sigils.activeCount).toBe(1);
      clock(effects, 27);
      expect(w.sigils.activeCount).toBe(1);
      clock(effects, 27 + 40);
      expect(w.sigils.activeCount).toBe(0);
    } finally { effects.dispose(); }
  });

  it('a barrage charge keeps a vertical and a ground circle until the cancel cue, then releases both', () => {
    const effects = new StoryEffects({ scene: new Scene() });
    try {
      effects.emit(cue({ kind: 'sigil', phase: 'sustain', actorId: 'aren', scopeId: 'sigil:3', position: { x: 0, y: 1.25, z: 0.9 }, to: { x: 0, y: 1.25, z: 8 }, durationTicks: 600, intensity: 1.6, element: 'arcane' }));
      clock(effects, 120);
      expect(effects.warden.sigils.activeCount).toBe(2);
      effects.cancelScope('sigil:3', 'interrupt');
      expect(effects.warden.sigils.activeCount).toBe(0);
    } finally { effects.dispose(); }
  });
});

describe('projectiles from snapshots', () => {
  it('draw interpolated bolts with a tracked light and release them when the snapshot drops them or an impact cue lands', () => {
    const effects = new StoryEffects({ scene: new Scene() });
    try {
      const w = effects.warden;
      clock(effects, 1);
      w.updateCombat(snapshot(1, { playerProjectiles: [bolt(1, 0)] }), 0);
      expect(w.projectiles).toHaveLength(1);
      expect(w.sprites.used).toBe(3);
      expect(w.lines.usedPoints).toBeGreaterThan(0);
      expect(effects.vfx.lights.tracked.intensity).toBeGreaterThan(0);
      clock(effects, 2);
      w.updateCombat(snapshot(2, { playerProjectiles: [bolt(1.5, 1)] }), 0.5);
      expect(w.projectiles[0]!.display.x).toBeCloseTo(1.25, 6);
      clock(effects, 3);
      w.updateCombat(snapshot(3), 0);
      expect(w.projectiles).toHaveLength(0);
      expect(effects.vfx.lights.tracked.intensity).toBe(0);
      expect(w.sprites.used).toBe(0);
      // An impact cue ends the visual even before the snapshot catches up.
      w.updateCombat(snapshot(4, { playerProjectiles: [bolt(3, 0)] }), 0);
      expect(w.projectiles).toHaveLength(1);
      effects.emit(cue({ kind: 'projectile-impact', phase: 'hit', scopeId: 'bolt:1', position: { x: 3.5, y: 1.25, z: 0 }, actionId: 'sigil-bolt' as never, element: 'arcane', intensity: 1 }, 4));
      expect(w.projectiles).toHaveLength(0);
      expect(effects.vfx.particles.liveCount(effects.vfx.time)).toBeGreaterThan(10);
      expect(w.sigils.activeCount).toBe(1);
    } finally { effects.dispose(); }
  });

  it('crescent waves hold one instanced crescent while alive and free it on expiry', () => {
    const effects = new StoryEffects({ scene: new Scene() });
    try {
      const w = effects.warden;
      clock(effects, 1);
      w.updateCombat(snapshot(1, { playerProjectiles: [wave(1, 0)] }), 0);
      expect(w.crescents.activeCount(effects.vfx.time)).toBe(1);
      clock(effects, 20);
      w.updateCombat(snapshot(20, { playerProjectiles: [wave(5, 19)] }), 1);
      expect(w.crescents.activeCount(effects.vfx.time)).toBe(1);
      expect(effects.vfx.ground.activeCount()).toBeGreaterThan(0);
      clock(effects, 21);
      w.updateCombat(snapshot(21), 1);
      expect(w.crescents.activeCount(effects.vfx.time)).toBe(0);
      expect(w.projectiles).toHaveLength(0);
    } finally { effects.dispose(); }
  });
});

describe('Judgement marks, Thunder Cleave and hit arcs', () => {
  const mark = (): JudgementMarkSnapshot => ({ id: 'mark:1', position: { x: 2, y: 0, z: 1 }, angleRadians: 0.6, createdAtTick: 10, detonateAtTick: 40 });

  it('marks hang as an X until detonation, sequentially releasing crescents and ground rune', () => {
    const effects = new StoryEffects({ scene: new Scene() });
    try {
      const w = effects.warden;
      clock(effects, 10);
      w.updateCombat(snapshot(10, { judgementMarks: [mark()] }), 0);
      expect(w.marks).toHaveLength(1);
      expect(w.crescents.activeCount(effects.vfx.time)).toBe(2);
      expect(w.sigils.activeCount).toBe(1);
      effects.emit(cue({ kind: 'judgement-mark', phase: 'hit', scopeId: 'mark:1', position: { x: 2, y: 0, z: 1 }, intensity: 1.2 }, 40));
      expect(w.marks).toHaveLength(0);
      expect(w.crescents.activeCount(effects.vfx.time)).toBe(0);
      expect(w.sigils.activeCount).toBe(0);
      // A mark that vanishes from the snapshot without a cue is also released after the grace period.
      clock(effects, 50);
      w.updateCombat(snapshot(50, { judgementMarks: [mark()] }), 0);
      expect(w.marks).toHaveLength(1);
      clock(effects, 80);
      w.updateCombat(snapshot(80, { judgementMarks: [] }), 0);
      expect(w.marks).toHaveLength(0);
      expect(w.crescents.activeCount(effects.vfx.time)).toBe(0);
    } finally { effects.dispose(); }
  });

  it('lightning draws a flickering trunk, branches and ground arcs, then ends after 0.3 s', () => {
    const impact = sink(), effects = new StoryEffects({ scene: new Scene(), impact });
    try {
      const w = effects.warden;
      effects.emit(cue({ kind: 'lightning', phase: 'active', position: { x: 3, y: 0, z: 2 }, footprint: { width: 6, length: 6 }, durationTicks: 18, intensity: 2, element: 'lightning' }, 0));
      clock(effects, 1);
      w.updateCombat(snapshot(1), 0);
      expect(w.bolts.some(bolt => bolt.active)).toBe(true);
      expect(w.lines.usedPoints).toBeGreaterThanOrEqual(33 + 4 * 9);
      expect(impact.shakes).toBeGreaterThan(0);
      const top = w.bolts.find(bolt => bolt.active)!.trunk[1]!;
      expect(top).toBeCloseTo(9, 4);
      clock(effects, 30);
      w.updateCombat(snapshot(30), 0);
      expect(w.bolts.some(bolt => bolt.active)).toBe(false);
      expect(w.lines.usedPoints).toBe(0);
    } finally { effects.dispose(); }
  });

  it('player hits spray sparks, flash and shake the target, and crawl electric arcs over it for 0.35 s', () => {
    const impact = sink(), effects = new StoryEffects({ scene: new Scene(), impact });
    try {
      const w = effects.warden, boar = actor({ id: 'boar', position: { x: 2, y: 0, z: 0 } });
      effects.emit(cue({ kind: 'hit', phase: 'hit', actorId: 'aren', targetId: 'boar', position: { x: 1.6, y: 0.9, z: 0 }, to: { x: 2.6, y: 0.9, z: 0 }, actionId: 'aren-light-1' as never, intensity: 1.5, element: 'arcane' }, 0));
      expect(effects.vfx.particles.liveCount(0)).toBeGreaterThan(25);
      expect(impact.flashes).toEqual(['boar']);
      expect(impact.shakes).toBe(1);
      expect(impact.impulses.length).toBe(1);
      clock(effects, 1);
      w.updateCombat(snapshot(1, { actors: [actor({ id: 'aren', allegiance: 'player' }), boar] }), 0);
      expect(w.arcs.filter(arc => arc.active)).toHaveLength(3);
      expect(w.lines.usedPoints).toBe(3 * 9);
      clock(effects, 30);
      w.updateCombat(snapshot(30, { actors: [actor({ id: 'aren', allegiance: 'player' }), boar] }), 0);
      expect(w.arcs.some(arc => arc.active)).toBe(false);
      expect(w.lines.usedPoints).toBe(0);
    } finally { effects.dispose(); }
  });

  it('reduced effects skip the arcs and flashes entirely', () => {
    const effects = new StoryEffects({ scene: new Scene(), reducedEffects: true });
    try {
      effects.emit(cue({ kind: 'hit', phase: 'hit', actorId: 'aren', targetId: 'boar', position: { x: 1.6, y: 0.9, z: 0 }, to: { x: 2.6, y: 0.9, z: 0 }, actionId: 'aren-light-1' as never, intensity: 1, element: 'arcane' }, 0));
      expect(effects.warden.arcs.some(arc => arc.active)).toBe(false);
    } finally { effects.dispose(); }
  });
});

describe('blade trail, weapon edge and hit-stop', () => {
  function rig() {
    const scene = new Scene(), root = new Object3D(), base = new Object3D(), tip = new Object3D(), weapon = new Group();
    const edge = new MeshStandardMaterial({ emissive: new Color(0.1, 0.8, 1), emissiveIntensity: 0.6 });
    edge.userData.wcWeaponEdge = true;
    const mesh = new Mesh(new BufferGeometry(), edge);
    weapon.add(mesh);
    scene.add(root, base, tip, weapon);
    const sockets: Record<string, Object3D> = { root, 'weapon-base': base, 'weapon-tip': tip, weapon };
    const effects = new StoryEffects({ scene, resolveSocket: (_id, name) => sockets[name] });
    return { effects, base, tip, edge, mesh, dispose: () => { effects.dispose(); mesh.geometry.dispose(); edge.dispose(); } };
  }

  it('samples the weapon sockets only inside the slash window, ignores frozen frames, glows the edge and dies with its life', () => {
    const r = rig();
    try {
      const w = r.effects.warden;
      for (let t = 1; t <= 4; t++) { clock(r.effects, t); w.updateCombat(snapshot(t), 0); }
      expect(w.trail.sampler.size).toBe(0);
      expect(r.edge.emissiveIntensity).toBeCloseTo(0.6, 3);
      r.effects.emit(cue({ kind: 'slash', phase: 'active', actorId: 'aren', actionId: 'aren-light-1' as never, position: { x: 0, y: 0, z: 0 }, footprint: { width: 2.3, length: 2.3, angleRadians: 0, sectorRadians: 2.4 }, durationTicks: 4, intensity: 1, element: 'arcane' }, 5));
      for (let t = 5; t <= 9; t++) {
        const a = (t - 5) * 0.4;
        r.base.position.set(Math.cos(a) * 0.4, 1, Math.sin(a) * 0.4); r.tip.position.set(Math.cos(a) * 1.6, 1, Math.sin(a) * 1.6);
        clock(r.effects, t); w.updateCombat(snapshot(t), 0);
      }
      expect(w.trail.sampler.size).toBe(5);
      expect(w.trail.mesh.visible).toBe(true);
      expect(r.edge.emissiveIntensity).toBeGreaterThan(2);
      // Hit-stop: the world clock does not advance, so a repeated frame adds no sample.
      w.updateCombat(snapshot(9), 0);
      expect(w.trail.sampler.size).toBe(5);
      // The window is active ± 2 frames: ticks 10 and 11 are still inside it, later frames are not.
      for (let t = 10; t <= 14; t++) { clock(r.effects, t); w.updateCombat(snapshot(t), 0); }
      expect(w.trail.sampler.size).toBe(7);
      for (let t = 15; t <= 130; t++) { clock(r.effects, t); w.updateCombat(snapshot(t), 0); }
      expect(w.trail.sampler.size).toBe(7);
      expect(w.trail.mesh.visible).toBe(false);
      expect(r.edge.emissiveIntensity).toBeCloseTo(0.6, 1);
    } finally { r.dispose(); }
  });
});

describe('cleansed finish', () => {
  function skinnedMonster() {
    const root = new Group(), hips = new Bone(), arm = new Bone();
    hips.add(arm);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
    geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(12), 4));
    geometry.setAttribute('skinWeight', new BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 4));
    geometry.computeBoundingBox();
    const material = new MeshStandardMaterial(), mesh = new SkinnedMesh(geometry, material);
    mesh.name = 'body'; mesh.add(hips); root.add(mesh); mesh.bind(new Skeleton([hips, arm]));
    return { root, mesh, geometry, material };
  }

  it('wraps the monster in a burning shell sharing its geometry and skeleton, and removes it afterwards without touching the animal', () => {
    const m = skinnedMonster(), scene = new Scene();
    scene.add(m.root);
    const effects = new StoryEffects({ scene, resolveActorRoot: id => id === 'corrupted-boar' ? m.root : undefined });
    let geometryDisposed = 0, materialDisposed = 0;
    m.geometry.addEventListener('dispose', () => geometryDisposed++);
    m.material.addEventListener('dispose', () => materialDisposed++);
    const aren = actor({ id: 'aren', allegiance: 'player' });
    try {
      const w = effects.warden;
      clock(effects, 1);
      w.updateCombat(snapshot(1, { actors: [aren, actor({ id: 'corrupted-boar', allegiance: 'hostile' })] }), 0);
      expect(w.dissolve.activeCount).toBe(0);
      clock(effects, 2);
      w.updateCombat(snapshot(2, { actors: [aren, actor({ id: 'corrupted-boar', allegiance: 'neutral' })] }), 0);
      expect(w.dissolve.activeCount).toBe(1);
      const shell = m.root.children.find(node => node.name === 'vfx-cleanse-shell') as SkinnedMesh;
      expect(shell).toBeDefined();
      expect(shell.geometry).toBe(m.geometry);
      expect(shell.skeleton).toBe(m.mesh.skeleton);
      expect(shell.material).toBeInstanceOf(ShaderMaterial);
      expect(m.mesh.material).toBe(m.material);
      expect(w.bodies.get(m.root).height).toBeGreaterThan(0.4);
      const progress = (): number => (shell.material as ShaderMaterial).uniforms.uProgress!.value as number;
      clock(effects, 2 + 48);
      w.updateCombat(snapshot(50, { actors: [aren, actor({ id: 'corrupted-boar', allegiance: 'neutral' })] }), 0);
      const half = progress();
      expect(half).toBeGreaterThan(0.3);
      expect(half).toBeLessThan(1);
      expect(effects.vfx.particles.liveCount(effects.vfx.time, WARDEN_OWNER + 1)).toBeGreaterThan(5);
      // Never re-triggers for a monster that is already neutral.
      expect(w.dissolve.activeCount).toBe(1);
      clock(effects, 2 + Math.ceil(DISSOLVE_SECONDS * 60) + 2);
      w.updateCombat(snapshot(100, { actors: [aren, actor({ id: 'corrupted-boar', allegiance: 'neutral' })] }), 0);
      expect(w.dissolve.activeCount).toBe(0);
      expect(m.root.children.some(node => node.name === 'vfx-cleanse-shell')).toBe(false);
      expect(geometryDisposed).toBe(0);
      expect(materialDisposed).toBe(0);
    } finally { effects.dispose(); m.geometry.dispose(); m.material.dispose(); }
  });

  it('cancelling mid-burn and disposing remove the shell and dispose only the shell materials', () => {
    const m = skinnedMonster(), scene = new Scene();
    scene.add(m.root);
    const effects = new StoryEffects({ scene, resolveActorRoot: () => m.root });
    const aren = actor({ id: 'aren', allegiance: 'player' });
    clock(effects, 1);
    effects.warden.updateCombat(snapshot(1, { actors: [aren, actor({ id: 'greenwake-root-rammer', allegiance: 'hostile' })] }), 0);
    clock(effects, 2);
    effects.warden.updateCombat(snapshot(2, { actors: [aren, actor({ id: 'greenwake-root-rammer', allegiance: 'neutral' })] }), 0);
    expect(effects.warden.dissolve.activeCount).toBe(1);
    const shellMaterial = (m.root.children.find(node => node.name === 'vfx-cleanse-shell') as SkinnedMesh).material as ShaderMaterial;
    let disposed = 0, originalDisposed = 0;
    shellMaterial.addEventListener('dispose', () => disposed++);
    m.material.addEventListener('dispose', () => originalDisposed++);
    effects.cancelAll('load');
    expect(effects.warden.dissolve.activeCount).toBe(0);
    expect(m.root.children.some(node => node.name === 'vfx-cleanse-shell')).toBe(false);
    effects.dispose();
    expect(disposed).toBe(1);
    expect(originalDisposed).toBe(0);
    m.geometry.dispose(); m.material.dispose();
  });
});

describe('ambient motes and disposal', () => {
  it('drifts sparse motes near Aren on the world clock and none while the world is frozen', () => {
    const effects = new StoryEffects({ scene: new Scene() });
    try {
      const w = effects.warden;
      clock(effects, 0);
      w.updateCombat(snapshot(0), 0);
      for (let t = 1; t <= 120; t++) { clock(effects, t); w.updateCombat(snapshot(t), 0); }
      const live = effects.vfx.particles.liveCount(effects.vfx.time, WARDEN_OWNER);
      expect(live).toBeGreaterThan(4);
      expect(live).toBeLessThan(40);
      for (let i = 0; i < 30; i++) w.updateCombat(snapshot(120), 0);
      expect(effects.vfx.particles.liveCount(effects.vfx.time, WARDEN_OWNER)).toBe(live);
    } finally { effects.dispose(); }
  });

  it('disposes every pooled GPU resource it created', () => {
    const effects = new StoryEffects({ scene: new Scene() }), w = effects.warden;
    const targets = [w.lines.mesh, w.sprites.mesh, w.crescents.mesh, w.trail.mesh];
    let events = 0;
    for (const target of targets) { target.geometry.addEventListener('dispose', () => events++); target.material.addEventListener('dispose', () => events++); }
    w.sigils.texture.addEventListener('dispose', () => events++);
    effects.dispose();
    expect(events).toBe(targets.length * 2 + 1);
    expect(effects.group.parent).toBeNull();
  });
});
