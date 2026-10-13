import { describe, expect, it } from 'bun:test';
import { BoxGeometry, Group, InstancedMesh, Matrix4, MeshBasicMaterial, Quaternion, Vector3, type BufferGeometry } from 'three';
import { buildStaticPropColliders } from '../../src/rendering/NativeSolidColliders.js';
import { createEngineState } from '../../src/game/combat/CombatEngine.js';
import { moveCircle, moveAerialCircle } from '../../src/game/combat/geometry.js';
import { REGIONS } from '../../src/content/campaign.js';
import type { NativeStaticBatch } from '../../src/rendering/NativeAssetLoader.js';
import type { WorldAssetPlacement } from '../../src/game/contracts.js';

function fixture(assetId: string, geometries: BufferGeometry[], options: Partial<WorldAssetPlacement> = {}, nativeLocal = new Matrix4()) {
  const placement: WorldAssetPlacement = { id: 'fixture', assetId, position: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: { x: 1, y: 1, z: 1 }, placement: 'ground', ...options };
  const root = new Group(), material = new MeshBasicMaterial();
  const world = new Matrix4().compose(new Vector3(placement.position.x, placement.position.y, placement.position.z), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), placement.rotationY), new Vector3(placement.scale.x, placement.scale.y, placement.scale.z)).multiply(nativeLocal);
  for (const geometry of geometries) { const mesh = new InstancedMesh(geometry, material, 1); mesh.setMatrixAt(0, world); root.add(mesh); }
  const batch: NativeStaticBatch = { assetId, root, instanceCount: 1, lodIds: [], setPlacementVisible() {}, updateOcclusion() {}, dispose() { for (const g of geometries) g.dispose(); material.dispose(); root.traverse(node => { if (node instanceof InstancedMesh) node.dispose(); }); } };
  const entries = buildStaticPropColliders(batch, [placement], { ...REGIONS[0]!, movableObjects: [] });
  const arena = { ...createEngineState().arena, bounds: { min: { x: -30, y: -5, z: -30 }, max: { x: 30, y: 20, z: 30 } }, colliders: entries.map(entry => entry.collider) };
  const sweep = (x: number, y = 0, aerial = false) => (aerial ? moveAerialCircle : moveCircle)(arena, { x, y, z: -4 }, { x: 0, y: 0, z: 8 }, 0.42, 1.6);
  return { sweep, entries, dispose: () => batch.dispose() };
}

const tree = () => [new BoxGeometry(0.4, 4, 0.4).translate(0, 2, 0), new BoxGeometry(5, 2, 5).translate(0, 4, 0)];

describe('native scene solids', () => {
  it('blocks a tree trunk during grounded and aerial motion but leaves the space below its canopy clear', () => {
    const f = fixture('prop-erya-edge-tree', tree());
    try { expect(f.sweep(0).z).toBeLessThan(-0.6); expect(f.sweep(0, 0.8, true).z).toBeLessThan(-0.6); expect(f.sweep(1.2).z).toBeCloseTo(4); } finally { f.dispose(); }
  });

  it('measures source orientation before slicing trunk geometry', () => {
    const orientation = new Matrix4().makeRotationZ(Math.PI / 2), inverse = orientation.clone().invert();
    const geometry = tree().map(g => g.applyMatrix4(inverse));
    const f = fixture('prop-erya-edge-tree', geometry, {}, orientation);
    try { expect(f.sweep(0).z).toBeLessThan(-0.6); expect(f.sweep(1.2).z).toBeCloseTo(4); } finally { f.dispose(); }
  });

  it('keeps measured door supports and lintel solid without sealing the actual doorway', () => {
    const f = fixture('prop-root-arch', [new BoxGeometry(1, 2, 0.6).translate(-1.5, 1, 0), new BoxGeometry(1, 2, 0.6).translate(1.5, 1, 0), new BoxGeometry(4, 2, 0.6).translate(0, 3, 0)]);
    try { expect(f.sweep(0).z).toBeCloseTo(4); expect(f.sweep(-1.5).z).toBeLessThan(-0.7); expect(f.sweep(0, 0.8, true).z).toBeLessThan(-0.7); } finally { f.dispose(); }
  });

  it('does not extend curved upper wood into a clear lower doorway', () => {
    const f = fixture('prop-root-arch', [
      new BoxGeometry(1, 1.8, 0.6).translate(-1.2, 0.9, 0),
      new BoxGeometry(1, 1.8, 0.6).translate(1.2, 0.9, 0),
      new BoxGeometry(1.8, 1.4, 0.6).translate(-1.2, 2.5, 0),
      new BoxGeometry(1.8, 1.4, 0.6).translate(1.2, 2.5, 0),
      new BoxGeometry(4.2, 0.4, 0.6).translate(0, 3.4, 0),
    ]);
    try { expect(f.sweep(0).z).toBeCloseTo(4); expect(f.sweep(0, 0.5, true).z).toBeLessThan(-0.3); } finally { f.dispose(); }
  });

  it('does not turn separate native houses into a courtyard-spanning invisible wall', () => {
    const f = fixture('prop-greenwake-houses', [new BoxGeometry(2, 3, 2).translate(-3, 1.5, 0), new BoxGeometry(2, 3, 2).translate(3, 1.5, 0)]);
    try { expect(f.sweep(0).z).toBeCloseTo(4); expect(f.sweep(3).z).toBeLessThan(-1.4); } finally { f.dispose(); }
  });

  it('blocks actual bridge rails while preserving its center deck corridor', () => {
    const f = fixture('prop-greenwake-rope-bridge', [new BoxGeometry(2, 0.1, 6), new BoxGeometry(0.1, 1, 6).translate(-1, 0.5, 0), new BoxGeometry(0.1, 1, 6).translate(1, 0.5, 0)]);
    try { expect(f.sweep(0).z).toBeCloseTo(4); expect(f.sweep(1).z).toBeLessThan(-3.4); } finally { f.dispose(); }
  });

  it('applies yaw and nonuniform scale to hard solids, including unclassified props', () => {
    const f = fixture('prop-unclassified-hard-object', [new BoxGeometry(2, 3, 4).translate(0, 1.5, 0)], { rotationY: Math.PI / 2, scale: { x: 1.5, y: 2, z: 1 } });
    try { expect(f.sweep(0).z).toBeLessThan(-1.9); expect(f.sweep(2.5).z).toBeCloseTo(4); expect(f.sweep(0, 0.8, true).z).toBeLessThan(-1.9); } finally { f.dispose(); }
  });
});
