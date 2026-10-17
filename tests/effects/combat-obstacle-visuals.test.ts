import { describe, expect, it } from 'bun:test';
import { Box3, Mesh, Raycaster, Scene, Vector3, type Object3D } from 'three';
import { CombatObstacleVisuals } from '../../src/effects/CombatObstacleVisuals.js';
import type { CombatObstacleSnapshot, WorldClockSnapshot } from '../../src/game/contracts.js';

const clock = (worldTick: number, policy: WorldClockSnapshot['policy'] = 'normal'): WorldClockSnapshot => ({ simulationTick: worldTick, worldTick, worldTimeSeconds: worldTick / 60, timeScale: policy === 'paused' ? 0 : 1, policy });
const obstacle = (kind: CombatObstacleSnapshot['kind']): CombatObstacleSnapshot => ({ id: 'committed-pillar', sourceId: 'greenwake-sap-stalker', attackId: 'sap-stalker-frost-bloom', kind, spawnedAtWorldTick: 60, expiresAtWorldTick: 120, collider: { id: 'solid', kind: 'capsule', from: { x: 4, y: 0.42, z: -3 }, to: { x: 4, y: 0.98, z: -3 }, radius: 0.42, blocksMovement: true, blocksCamera: true } });
function visibleMeshes(root: Object3D): Mesh[] {
  const meshes: Mesh[] = [];
  root.traverse(node => { if (!(node instanceof Mesh)) return; for (let parent: Object3D | null = node; parent; parent = parent.parent) if (!parent.visible) return; meshes.push(node); });
  return meshes;
}
const ray = () => new Raycaster(new Vector3(4, 0.7, -7), new Vector3(0, 0, 1));

describe('physical obstacle presentation', () => {
  for (const kind of ['ice', 'roots'] as const) it(`shows collider-sized ${kind} mass from the first solid tick through the final tick`, () => {
    const scene = new Scene(), visuals = new CombatObstacleVisuals(scene), snapshot = obstacle(kind);
    try {
      for (const tick of [60, 80, 119]) {
        visuals.update([snapshot], clock(tick), false); scene.updateMatrixWorld(true);
        const meshes = visibleMeshes(visuals.group), hit = ray().intersectObjects(meshes)[0];
        expect(hit!.distance).toBeGreaterThan(3.5); expect(hit!.distance).toBeLessThan(3.7);
        const bounds = new Box3(); for (const mesh of meshes) bounds.union(new Box3().setFromObject(mesh));
        expect(bounds.min.y).toBeCloseTo(0, 5); expect(bounds.max.y).toBeCloseTo(1.4, 5);
      }
      visuals.update([snapshot], clock(120), false);
      expect(ray().intersectObjects(visibleMeshes(visuals.group))[0]).toBeUndefined();
    } finally { visuals.dispose(); }
  });

  it('freezes world geometry during pause and removes mass when the engine removes an obstacle', () => {
    const scene = new Scene(), visuals = new CombatObstacleVisuals(scene), snapshot = obstacle('ice');
    try {
      visuals.update([snapshot], clock(80), false); scene.updateMatrixWorld(true);
      const mesh = visibleMeshes(visuals.group)[0]!, before = mesh.matrixWorld.clone();
      visuals.update([snapshot], clock(80, 'paused'), false); scene.updateMatrixWorld(true);
      expect(mesh.matrixWorld.equals(before)).toBe(true);
      visuals.update([], clock(80), false); expect(ray().intersectObjects(visibleMeshes(visuals.group))[0]).toBeUndefined();
    } finally { visuals.dispose(); }
  });

  it('keeps physical mass readable in reduced motion and never resurrects it after disposal', () => {
    const scene = new Scene(), visuals = new CombatObstacleVisuals(scene), snapshot = obstacle('roots');
    visuals.update([snapshot], clock(60), true); scene.updateMatrixWorld(true);
    expect(ray().intersectObjects(visibleMeshes(visuals.group))[0]!.distance).toBeLessThan(3.7);
    visuals.dispose(); visuals.update([snapshot], clock(80), true);
    expect(visuals.group.parent).toBeNull(); expect(ray().intersectObjects(visibleMeshes(visuals.group))[0]).toBeUndefined();
  });

  it('erupting roots throw soil debris once, outside the collider-sized mass, and late joins stay quiet', () => {
    const scene = new Scene(), visuals = new CombatObstacleVisuals(scene), snapshot = obstacle('roots');
    try {
      visuals.update([snapshot], clock(60), false);
      expect(visuals.debris.liveCount).toBeGreaterThan(0);
      expect(visuals.debris.mesh.parent).toBe(scene);
      let inside = false;
      visuals.group.traverse(node => { if (node === visuals.debris.mesh) inside = true; });
      expect(inside).toBe(false);
      visuals.update([], clock(61), false); visuals.update([], clock(400), false);
      expect(visuals.debris.liveCount).toBe(0);
      const late = new CombatObstacleVisuals(new Scene());
      late.update([snapshot], clock(90), false);
      expect(late.debris.liveCount).toBe(0);
      late.dispose();
    } finally { visuals.dispose(); }
  });
});
