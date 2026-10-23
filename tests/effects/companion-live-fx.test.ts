import { describe, expect, it } from 'bun:test';
import { Mesh, Object3D, Scene, Vector3 } from 'three';
import { StoryEffects } from '../../src/effects/StoryEffects.js';
import type { StoryCue } from '../../src/effects/story-cues.js';
import { CompanionSockets } from '../../src/effects/vfx/CompanionSockets.js';
import type { ImpactSink } from '../../src/effects/vfx/ElementKits.js';
import type { ActorSnapshot, WorldClockSnapshot } from '../../src/game/contracts.js';

const clock = (worldTick: number): WorldClockSnapshot => ({ simulationTick: Math.floor(worldTick), worldTick, worldTimeSeconds: worldTick / 60, timeScale: 1, policy: 'normal' });

const joint = (parent: Object3D, name: string, x: number, y: number, z: number): Object3D => {
  const node = new Object3D();
  node.name = name; node.position.set(x, y, z);
  parent.add(node);
  return node;
};
const rootWith = (joints: Record<string, [number, number, number]>): { root: Object3D; nodes: Record<string, Object3D> } => {
  const root = new Object3D(), nodes: Record<string, Object3D> = {};
  for (const [name, at] of Object.entries(joints)) nodes[name] = joint(root, name, at[0], at[1], at[2]);
  return { root, nodes };
};

function stage() {
  const roots = new Map<string, Object3D>(), shakes: number[] = [];
  const impact: ImpactSink = { shake: amplitude => { shakes.push(amplitude); }, flashActor: () => undefined };
  const effects = new StoryEffects({ scene: new Scene(), reducedEffects: false, impact, resolveActorRoot: id => roots.get(id) });
  return { effects, roots, shakes };
}
let serial = 0;
const cue = (patch: Partial<StoryCue>): StoryCue => ({
  instanceId: `live:${serial++}`, tick: 1, worldTick: 100, worldTimeSeconds: 100 / 60, kind: 'command', phase: 'anticipation', priority: 'essential', ...patch,
} as StoryCue);
const quads = (effects: StoryEffects): number => {
  let n = 0;
  effects.vfx.ground.group.traverse(node => { if (node instanceof Mesh && node.visible) n++; });
  return n;
};
const seedMesh = (effects: StoryEffects): Object3D | undefined => {
  let found: Object3D | undefined;
  effects.vfx.group.traverse(node => { if (node.name === 'companion-seed' && node.visible) found = node; });
  return found;
};

describe('CompanionSockets', () => {
  it('follows the animated joint, matches loader-sanitised names, and refuses sockets the rig or species lacks', () => {
    const sockets = new CompanionSockets(), out = new Vector3();
    const { root, nodes } = rootWith({ tripo0_Right_Limb_7: [0.2, 0.05, 0.1] });
    expect(sockets.position(root, 'asha', 'rightPaw', out)).toBe(true);
    expect(out.toArray()).toEqual([0.2, 0.05, 0.1]);
    nodes.tripo0_Right_Limb_7!.position.set(0.6, 0.3, 0.1);
    expect(sockets.position(root, 'asha', 'rightPaw', out)).toBe(true);
    expect(out.x).toBeCloseTo(0.6, 6);
    expect(sockets.position(root, 'asha', 'leftPaw', out)).toBe(false); // joint absent from the loaded rig
    expect(sockets.position(root, 'asha', 'rightWing', out)).toBe(false); // the species has no such socket
  });

  it('places the mouth past the head joint in the joint frame so it turns with the head', () => {
    const sockets = new CompanionSockets(), out = new Vector3(), dir = new Vector3();
    const { root, nodes } = rootWith({ 'tripo::Head_3': [1, 2, 3] });
    expect(sockets.position(root, 'solkar', 'mouth', out)).toBe(true);
    const initial = out.clone().sub(nodes['tripo::Head_3']!.position);
    nodes['tripo::Head_3']!.rotation.z = Math.PI / 2;
    expect(sockets.position(root, 'solkar', 'mouth', out)).toBe(true);
    expect(out.x).toBeCloseTo(1 - initial.y, 4);
    expect(out.y).toBeCloseTo(2 + initial.x, 4);
    expect(sockets.direction(root, 'solkar', 'mouth', dir)).toBe(true);
    expect(dir.length()).toBeCloseTo(1, 5);
  });
});

describe('Koro Mending Seed', () => {
  const seedCues = (scopeId: string) => ({
    start: cue({ actorId: 'koro', targetId: 'boar', actionId: 'koro-canopy-route' as never, scopeId, position: { x: 6, y: 0, z: 0 }, from: { x: 0, y: 0, z: 0 }, worldTick: 100, durationTicks: 72 }),
    commit: cue({ actorId: 'koro', targetId: 'boar', actionId: 'koro-canopy-route' as never, scopeId, phase: 'commit', position: { x: 6, y: 0, z: 0 }, from: { x: 0, y: 0, z: 0 }, worldTick: 132, durationTicks: 17 }),
    hit: cue({ actorId: 'koro', targetId: 'boar', actionId: 'koro-canopy-route' as never, scopeId, phase: 'hit', position: { x: 6, y: 0, z: 0 }, from: { x: 0, y: 0, z: 0 }, worldTick: 149, durationTicks: 20 }),
  });
  const koro = () => {
    const s = stage(), { root, nodes } = rootWith({ R_Hand: [0, 1, 0.4] });
    s.roots.set('koro', root);
    return { ...s, hand: nodes.R_Hand! };
  };

  it('is held in the right hand, detaches once, flies without a static target tether and never blossoms without a hit', () => {
    const { effects, hand } = koro(), cues = seedCues('seed:a');
    try {
      effects.companions.update([
        { id: 'koro', archetypeId: 'koro', allegiance: 'ally', position: { x: 0, y: 0, z: 0 }, visible: true, downed: false, job: { command: 'special', targetId: 'boar', remainingTicks: 72 } },
        { id: 'boar', archetypeId: 'boar', allegiance: 'hostile', position: { x: 6, y: 0, z: 0 }, visible: true, downed: false },
      ] as unknown as ActorSnapshot[]);
      effects.emit(cues.start);
      effects.update(clock(110));
      expect(effects.companions.visibleSeedCount).toBe(1);
      expect(effects.vfx.beams.activeCount).toBe(0);
      const held = seedMesh(effects)!.position.clone();
      hand.position.set(0.3, 1.2, 0.4);
      effects.update(clock(120));
      const moved = seedMesh(effects)!.position;
      expect(moved.x - held.x).toBeCloseTo(0.3, 4);
      expect(moved.y - held.y).toBeCloseTo(0.2, 4);
      expect(moved.z).toBeCloseTo(held.z, 4);
      effects.emit(cues.commit);
      hand.position.set(-2, 1, 0.4); // the hand moving on after release must not drag the seed
      effects.update(clock(140));
      const mid = seedMesh(effects)!.position.clone();
      expect(effects.vfx.beams.activeCount).toBe(0);
      expect(mid.x).toBeGreaterThan(0.3);
      expect(mid.x).toBeLessThan(6);
      effects.emit({ ...cues.commit, instanceId: 'live:dup-commit' });
      effects.update(clock(141));
      expect(seedMesh(effects)!.position.x).toBeGreaterThan(mid.x);
      const before = quads(effects);
      effects.update(clock(150)); // arrival without a confirmed hit: the seed is gone and nothing blossoms
      expect(effects.companions.visibleSeedCount).toBe(0);
      expect(quads(effects)).toBe(before);
      effects.update(clock(300));
      expect(effects.companions.liveJobCount).toBe(0);
    } finally { effects.dispose(); }
  });


  it('releases the seed and the job when its scope is cancelled mid-flight, and everything on a global cancel', () => {
    const { effects } = koro(), cues = seedCues('seed:c');
    try {
      effects.emit(cues.start); effects.update(clock(110)); effects.emit(cues.commit); effects.update(clock(140));
      expect(effects.companions.visibleSeedCount).toBe(1);
      effects.cancelScope('seed:c', 'interrupt');
      expect(effects.companions.visibleSeedCount).toBe(0);
      expect(effects.companions.liveJobCount).toBe(0);
      effects.emit(seedCues('seed:d').start);
      effects.update(clock(110));
      expect(effects.companions.visibleSeedCount).toBe(1);
      effects.cancelAll('load');
      expect(effects.companions.liveJobCount).toBe(0);
      expect(effects.companions.visibleSeedCount).toBe(0);
    } finally { effects.dispose(); }
  });
});

describe('Nyra pounce trails', () => {
  const nyra = () => {
    const s = stage(), { root, nodes } = rootWith({ bone_22: [0.2, 0.03, 0.05], bone_17: [0.2, 0.03, -0.05] });
    s.roots.set('nyra', root);
    return { ...s, nodes };
  };
  const ambush = (phase: StoryCue['phase'], worldTick: number): StoryCue =>
    cue({ actorId: 'nyra', targetId: 'boar', actionId: 'nyra-shadow-ambush' as never, scopeId: 'pounce:1', phase, position: { x: 4, y: 0, z: 0 }, from: { x: 0, y: 0, z: 0 }, worldTick, durationTicks: 60 });

  it('draws lightning ribbons from the moving paws only inside the pounce window and frees the pooled beams afterwards', () => {
    const { effects, nodes } = nyra();
    try {
      effects.emit(ambush('anticipation', 100));
      effects.update(clock(105));
      expect(effects.vfx.beams.activeCount).toBe(0);
      effects.update(clock(116));
      nodes.bone_22!.position.set(1, 0.03, 0.05);
      effects.update(clock(118));
      expect(effects.vfx.beams.activeCount).toBe(2);
      effects.update(clock(140));
      expect(effects.vfx.beams.activeCount).toBe(0);
    } finally { effects.dispose(); }
  });

  it('releases the ribbons when the pounce is cancelled in the middle of its window', () => {
    const { effects } = nyra();
    try {
      effects.emit(ambush('anticipation', 100));
      effects.update(clock(116));
      expect(effects.vfx.beams.activeCount).toBe(2);
      effects.cancelScope('pounce:1', 'interrupt');
      expect(effects.vfx.beams.activeCount).toBe(0);
      expect(effects.companions.liveJobCount).toBe(0);
    } finally { effects.dispose(); }
  });
});
