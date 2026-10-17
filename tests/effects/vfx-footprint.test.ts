import { describe, expect, it } from 'bun:test';
import { Mesh, Object3D, Scene, Vector3, type ShaderMaterial } from 'three';
import { StoryEffects } from '../../src/effects/StoryEffects.js';
import type { StoryCue } from '../../src/effects/story-cues.js';
import { ATTACKS } from '../../src/game/combat/content.js';
import type { AttackId, WorldClockSnapshot } from '../../src/game/contracts.js';

const MARGIN = 0.5;
const GREENWAKE_ATTACKS = [
  'boar-ember-lance', 'root-rammer-cinder-burst', 'sap-stalker-frost-bloom', 'sap-stalker-venom-mist', 'boar-gale-scythe', 'root-rammer-gale-sweep',
  'root-rammer-low-wave', 'sap-vein-snap', 'boar-charge', 'boar-pounce', 'root-rammer-slam', 'boar-sap-thrash', 'sap-vein-thrash', 'asha-protective-roar',
] as const;
const CANOPY_ATTACKS = [
  'howler-rock-hurl', 'howler-leap-slam', 'howler-branch-sweep', 'hornbill-dive-bomb', 'hornbill-feather-volley', 'hornbill-gale-flap',
  'viper-venom-spit', 'viper-tail-lash', 'viper-strike-lunge',
] as const;
const clock = (worldTick: number): WorldClockSnapshot => ({ simulationTick: Math.floor(worldTick), worldTick, worldTimeSeconds: worldTick / 60, timeScale: 1, policy: 'normal' });

/** Mirrors the engine's hazardPresentation convention: cones are apex sectors, strikes disks, others rectangles. */
function hazardCue(attackId: string, phase: 'anticipation' | 'commit' | 'active', worldTick: number, yaw: number): StoryCue {
  const attack = ATTACKS[attackId]!, hazard = attack.hazard;
  const cone = hazard.kind === 'cone', disk = hazard.kind === 'strike' || hazard.kind === 'projectile';
  const origin = { x: 3, y: 0.4, z: -2 };
  const target = { x: origin.x + Math.sin(yaw) * 4, y: 0.4, z: origin.z + Math.cos(yaw) * 4 };
  const shape = cone ? 'sector' : hazard.kind === 'sweep' ? 'arc' : hazard.kind === 'wave' ? 'wave' : disk ? 'burst' : 'ring';
  const duration = phase === 'anticipation' ? attack.windupTicks : phase === 'commit' ? attack.commitTicks : attack.activeTicks;
  return {
    instanceId: `${attackId}:${phase}`, scopeId: attackId, tick: worldTick, worldTick, worldTimeSeconds: worldTick / 60, kind: phase, phase,
    attackId: attackId as AttackId, element: attack.element, actorId: 'monster', targetId: 'aren', priority: 'essential',
    position: cone ? origin : target, from: origin, to: target, shape, durationTicks: duration,
    footprint: {
      width: disk ? 2 * hazard.radius : hazard.width,
      length: cone ? 2 * hazard.depth : disk ? 2 * hazard.radius : hazard.depth,
      angleRadians: hazard.kind === 'area' ? 0 : yaw,
      ...(cone ? { sectorRadians: (70 * Math.PI) / 180 } : {}),
    },
  };
}

/** Independent local frame of the authored footprint (local +Z = (sin a, cos a)). */
interface LocalBounds { cx: number; cz: number; angle: number; minX: number; maxX: number; minZ: number; maxZ: number }
function localBounds(cue: StoryCue): LocalBounds {
  const fp = cue.footprint!, at = cue.position!, angle = fp.angleRadians ?? 0;
  if (cue.shape === 'sector') {
    const radius = fp.length / 2, half = fp.sectorRadians! / 2;
    const side = half >= Math.PI / 2 ? radius : radius * Math.sin(half);
    return { cx: at.x, cz: at.z, angle, minX: -side, maxX: side, minZ: Math.min(0, radius * Math.cos(half)), maxZ: radius };
  }
  return { cx: at.x, cz: at.z, angle, minX: -fp.width / 2, maxX: fp.width / 2, minZ: -fp.length / 2, maxZ: fp.length / 2 };
}

function expectInside(point: Vector3, bounds: LocalBounds, label: string): void {
  const dx = point.x - bounds.cx, dz = point.z - bounds.cz, c = Math.cos(bounds.angle), s = Math.sin(bounds.angle);
  const x = dx * c - dz * s, z = dx * s + dz * c;
  const inside = x >= bounds.minX - MARGIN && x <= bounds.maxX + MARGIN && z >= bounds.minZ - MARGIN && z <= bounds.maxZ + MARGIN;
  if (!inside) throw new Error(`${label}: ground VFX point (${x.toFixed(2)}, ${z.toFixed(2)}) leaves footprint [${bounds.minX.toFixed(2)}, ${bounds.maxX.toFixed(2)}] × [${bounds.minZ.toFixed(2)}, ${bounds.maxZ.toFixed(2)}]`);
}

function groundMeshes(root: Object3D): Mesh<never, ShaderMaterial>[] {
  const meshes: Mesh<never, ShaderMaterial>[] = [];
  root.traverse(node => { if (node instanceof Mesh && node.name.startsWith('vfx-ground') && node.visible) meshes.push(node as Mesh<never, ShaderMaterial>); });
  return meshes;
}

function checkGround(effects: StoryEffects, scene: Scene, bounds: LocalBounds, label: string): number {
  scene.updateMatrixWorld(true);
  const corner = new Vector3();
  const meshes = groundMeshes(effects.group);
  for (const mesh of meshes) for (const x of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) expectInside(corner.set(x, 0, z).applyMatrix4(mesh.matrixWorld), bounds, `${label} ${mesh.name}`);
  for (const spike of effects.vfx.spikes.livePositions(effects.vfx.time, [])) expectInside(spike, bounds, `${label} crystal spike`);
  return meshes.length;
}

describe('ground VFX stay inside the authored footprint', () => {
  for (const attackId of [...GREENWAKE_ATTACKS, ...CANOPY_ATTACKS]) it(`${attackId}: telegraph, detonation, decals and decay never leave the footprint (+${MARGIN} m)`, () => {
    for (const yaw of [0, 0.7, -2.2]) {
      const scene = new Scene(), socket = new Object3D(), root = new Object3D();
      socket.position.set(3, 1.6, -2); root.position.set(3, 0.4, -2); scene.add(socket, root);
      const effects = new StoryEffects({ scene, resolveSocket: (_actor, name) => name === 'cast' ? socket : name === 'root' ? root : undefined, capacity: 24 });
      try {
        const attack = ATTACKS[attackId]!;
        const anticipation = hazardCue(attackId, 'anticipation', 60, yaw);
        const bounds = localBounds(anticipation);
        let drawn = 0;
        effects.emit(anticipation);
        for (let tick = 60; tick < 60 + attack.windupTicks; tick += 7) { effects.update(clock(tick)); drawn += checkGround(effects, scene, bounds, `${attackId} anticipation`); }
        const commitAt = 60 + attack.windupTicks, activeAt = commitAt + attack.commitTicks;
        effects.emit(hazardCue(attackId, 'commit', commitAt, yaw));
        for (let tick = commitAt; tick < activeAt; tick += 5) { effects.update(clock(tick)); drawn += checkGround(effects, scene, bounds, `${attackId} commit`); }
        effects.emit(hazardCue(attackId, 'active', activeAt, yaw));
        // Active phase, natural expiry (decay/charge impact) and the lingering decals afterwards.
        for (let tick = activeAt; tick < activeAt + attack.activeTicks + 420; tick += 9) { effects.update(clock(tick)); drawn += checkGround(effects, scene, bounds, `${attackId} active/decay`); }
        expect(drawn).toBeGreaterThan(0);
      } finally { effects.dispose(); }
    }
  });

  it('landing impacts with an authored footprint keep their dust ring and crack inside it', () => {
    const scene = new Scene();
    const effects = new StoryEffects({ scene });
    try {
      const cue: StoryCue = { instanceId: 'land', tick: 10, worldTick: 10, worldTimeSeconds: 10 / 60, kind: 'landing', phase: 'landing', actorId: 'boar', position: { x: -4, y: 0.2, z: 6 }, footprint: { width: 2.4, length: 2.4 }, intensity: 1.2, durationTicks: 30 };
      effects.emit(cue);
      let drawn = 0;
      for (let tick = 10; tick < 360; tick += 11) { effects.update(clock(tick)); drawn += checkGround(effects, scene, localBounds({ ...cue, shape: 'burst' }), 'landing'); }
      expect(drawn).toBeGreaterThan(0);
    } finally { effects.dispose(); }
  });
});
