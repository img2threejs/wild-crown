import { describe, expect, it } from 'bun:test';
import { BoxGeometry, Group, InstancedMesh, Matrix4, MeshBasicMaterial, Quaternion, Vector3, type BufferGeometry } from 'three';
import { buildStaticPropColliders } from '../../src/rendering/NativeSolidColliders.js';
import { createEngineState } from '../../src/game/combat/CombatEngine.js';
import { groundHeightAt, landingHeightAt, moveAerialCircle, moveCircle, SUPPORT_EMPTY_TOP, type CombatArena } from '../../src/game/combat/geometry.js';
import { REGIONS } from '../../src/content/campaign.js';
import type { NativeStaticBatch } from '../../src/rendering/NativeAssetLoader.js';
import type { WorldAssetPlacement } from '../../src/game/contracts.js';

function fixture(assetId: string, geometries: BufferGeometry[], options: Partial<WorldAssetPlacement> = {}, nativeLocal = new Matrix4()) {
  const placement: WorldAssetPlacement = { id: 'fixture', assetId, position: { x: 0, y: 0, z: 0 }, rotationY: 0, scale: { x: 1, y: 1, z: 1 }, placement: 'ground', ...options };
  const root = new Group(), material = new MeshBasicMaterial();
  const world = new Matrix4().compose(new Vector3(placement.position.x, placement.position.y, placement.position.z), new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), placement.rotationY), new Vector3(placement.scale.x, placement.scale.y, placement.scale.z)).multiply(nativeLocal);
  for (const geometry of geometries) { const mesh = new InstancedMesh(geometry, material, 1); mesh.setMatrixAt(0, world); root.add(mesh); }
  const batch: NativeStaticBatch = { assetId, root, instanceCount: 1, drawnInstanceCount: 1, lodIds: [], setPlacementVisible() {}, setPlacementResponse() {}, updateOcclusion() {}, dispose() { for (const g of geometries) g.dispose(); material.dispose(); root.traverse(node => { if (node instanceof InstancedMesh) node.dispose(); }); } };
  const entries = buildStaticPropColliders(batch, [placement], { ...REGIONS[0]!, movableObjects: [] });
  const arena = { ...createEngineState().arena, bounds: { min: { x: -30, y: -5, z: -30 }, max: { x: 30, y: 20, z: 30 } }, colliders: entries.map(entry => entry.collider), supports: entries.flatMap(entry => entry.support ? [entry.support] : []) };
  const sweep = (x: number, y = 0, aerial = false) => (aerial ? moveAerialCircle : moveCircle)(arena, { x, y, z: -4 }, { x: 0, y: 0, z: 8 }, 0.42, 1.6);
  return { sweep, entries, arena, dispose: () => batch.dispose() };
}

const tree = () => [new BoxGeometry(0.4, 4, 0.4).translate(0, 2, 0), new BoxGeometry(5, 2, 5).translate(0, 4, 0)];

describe('native scene solids', () => {
  it('measures loose rubble without adding a stationary movement blocker, camera obstacle or standable top', () => {
    const f = fixture('prop-mire-bank-rock', [new BoxGeometry(3, 2, 3).translate(0, 1, 0)], { id: 'environment-loose-test', scale: { x: .12, y: .12, z: .12 } });
    try {
      expect(f.sweep(0).z).toBeCloseTo(4);
      expect(f.entries[0]!.collider.halfExtents!.x).toBeCloseTo(.18);
      expect(f.entries.every(entry => !entry.collider.blocksMovement && !entry.collider.blocksCamera && !entry.support)).toBe(true);
      expect(groundHeightAt(f.arena, 0, 0, 1)).toBe(0);
    } finally { f.dispose(); }
  });

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

describe('native support fields', () => {
  /** A deep ground plane: where no measured support is under a point, groundHeightAt falls to it. */
  const FAR_FLOOR = { id: 'far-floor', profile: 'plane' as const, points: [{ x: -30, y: -10, z: -30 }, { x: 30, y: -10, z: -30 }, { x: 30, y: -10, z: 30 }, { x: -30, y: -10, z: 30 }], elevation: -10, walkable: true, material: 'earth', colliderId: 'far-floor' };
  const standHeight = (arena: CombatArena, x: number, z: number, near: number) => groundHeightAt({ ...arena, surfaces: [FAR_FLOOR] }, x, z, near);

  it('measures a yawed, non-uniformly scaled rock top in world space and blocks through the field, not the proxy box', () => {
    const f = fixture('prop-mire-bank-rock', [new BoxGeometry(2, 1, 2).translate(0, 0.5, 0)], { rotationY: Math.PI / 4, scale: { x: 1.5, y: 2, z: 1 } });
    try {
      expect(standHeight(f.arena, 0, 0, 2)).toBeCloseTo(2, 2);
      expect(standHeight(f.arena, 1, 0, 2)).toBeCloseTo(2, 2);
      expect(standHeight(f.arena, 1.7, 1.7, 2)).toBeCloseTo(-10, 6);
      expect(f.entries.every(entry => entry.collider.blocksMovement === false && entry.collider.blocksCamera === true)).toBe(true);
      expect(f.sweep(0).z).toBeLessThan(-1.6);
      expect(f.sweep(2.4).z).toBeCloseTo(4);
      expect(landingHeightAt(f.arena, 0, 0, { fromY: 0, maxRise: 2.5, maxDrop: 3, radius: 0.42, height: 1.6 })).toBeCloseTo(2, 2);
    } finally { f.dispose(); }
  });

  it('keeps the space under an overhanging prop open: the underside is measured, not a column to the ground', () => {
    const f = fixture('prop-mire-bank-rock', [new BoxGeometry(2, 0.2, 2).translate(0, 2.1, 0)]);
    try {
      expect(standHeight(f.arena, 0, 0, 2.2)).toBeCloseTo(2.2, 2);
      expect(f.sweep(0).z).toBeCloseTo(4);
      expect(moveAerialCircle(f.arena, { x: 0, y: 0, z: -4 }, { x: 0, y: 0, z: 8 }, 0.42, 1.6).z).toBeCloseTo(4);
      expect(moveAerialCircle(f.arena, { x: 0, y: 0, z: 0 }, { x: 0, y: 3, z: 0 }, 0.42, 1.6).y).toBeCloseTo(2 - 1.6, 2);
    } finally { f.dispose(); }
  });

  it('takes only the deck of a bridge as its support: rails, posts and the span beside the deck are not standable', () => {
    const f = fixture('prop-vine-bridge', [new BoxGeometry(3.4, 0.1, 12).translate(0, -0.05, 0), new BoxGeometry(0.1, 1, 12).translate(-1.65, 0.5, 0), new BoxGeometry(0.1, 1, 12).translate(1.65, 0.5, 0), new BoxGeometry(0.2, 1.8, 0.2).translate(1.65, 0.9, 5.5)],
      { rotationY: Math.PI / 2, scale: { x: 1, y: 1, z: 0.9 } });
    try {
      expect(standHeight(f.arena, 0, 0, 0)).toBeCloseTo(0, 2);
      expect(standHeight(f.arena, 4, 0.5, 0)).toBeCloseTo(0, 2);
      expect(standHeight(f.arena, 0, 1.65, 0)).toBeCloseTo(-10, 6);
      expect(standHeight(f.arena, 0, 2.5, 0)).toBeCloseTo(-10, 6);
      expect(f.entries.some(entry => entry.collider.blocksMovement)).toBe(true);
      expect(f.entries.filter(entry => entry.support)).toHaveLength(1);
      expect(moveCircle(f.arena, { x: -5, y: 0, z: 0 }, { x: 10.2, y: 0, z: 0 }, 0.42, 1.6).x).toBeGreaterThan(5);
      expect(moveCircle(f.arena, { x: -5, y: 0, z: 1.3 }, { x: 10.2, y: 0, z: 0 }, 0.42, 1.6).x).toBeLessThan(-4);
    } finally { f.dispose(); }
  });

  it('gives an arch, a tree or a house no support: no single box top stands in the air above them', () => {
    for (const assetId of ['prop-root-arch', 'prop-erya-edge-tree', 'prop-greenwake-houses']) {
      const f = fixture(assetId, [new BoxGeometry(1, 2, 0.6).translate(-1.5, 1, 0), new BoxGeometry(1, 2, 0.6).translate(1.5, 1, 0), new BoxGeometry(4, 2, 0.6).translate(0, 3, 0)]);
      try { expect(f.entries.filter(entry => entry.support)).toHaveLength(0); } finally { f.dispose(); }
    }
  });

  it('serialises with finite values only', () => {
    const f = fixture('prop-mire-bank-rock', [new BoxGeometry(2, 1, 2).translate(0, 0.5, 0)]);
    try {
      const field = f.entries.find(entry => entry.support)!.support!;
      expect(JSON.parse(JSON.stringify(field))).toEqual(field);
      expect([...field.top, ...field.bottom, ...field.stand].every(Number.isFinite)).toBe(true);
      expect(field.top.every(value => value === SUPPORT_EMPTY_TOP || value <= 1 + 1e-6)).toBe(true);
    } finally { f.dispose(); }
  });
});
