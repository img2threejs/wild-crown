import { Group, Mesh, Vector3, type Object3D } from 'three';
import type { AssetManifestEntry, RegionDefinition, WorldAssetPlacement } from '../game/contracts.js';
import { NativeAssetError, type NativeAssetInstance, type NativeAssetLoader } from './NativeAssetLoader.js';
import { buildNativePropColliders, type NativeSolidCollider } from './NativeSolidColliders.js';

export const MIGRATION_GATE_ASSET_ID = 'prop-migration-gate';

function nativePose(value: unknown, assetId: string): Vector3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(component => typeof component === 'number' && Number.isFinite(component))) {
    throw new NativeAssetError(assetId, 'migration panel requires authored closed/open translations');
  }
  return new Vector3(value[0], value[1], value[2]);
}

/** The saved opening moves only the native lattice. Both poses retain measured stone-frame collision. */
export class NativeMigrationGate {
  readonly root = new Group();
  readonly assetId: string;
  private readonly panel: Object3D;
  private readonly closedPose: Vector3;
  private readonly openPose: Vector3;
  private readonly closedSolids: readonly NativeSolidCollider[];
  private readonly openSolids: readonly NativeSolidCollider[];
  private opened = false;

  static async load(loader: NativeAssetLoader, manifest: AssetManifestEntry, placement: WorldAssetPlacement, region: RegionDefinition): Promise<NativeMigrationGate> {
    const instance = await loader.load(manifest);
    try { return new NativeMigrationGate(instance, placement, region); }
    catch (error) { instance.dispose(); throw error; }
  }

  private constructor(private readonly instance: NativeAssetInstance, placement: WorldAssetPlacement, region: RegionDefinition) {
    this.assetId = instance.assetId;
    const panel = instance.root.getObjectByName('migration_gate_panel');
    if (!panel) throw new NativeAssetError(instance.assetId, 'native migration_gate_panel is missing');
    const frame = instance.root.getObjectByName('migration_gate_frame');
    if (!frame) throw new NativeAssetError(instance.assetId, 'native migration_gate_frame is missing');
    this.panel = panel;
    this.closedPose = nativePose(panel.userData.closedTranslation, instance.assetId);
    this.openPose = nativePose(panel.userData.openTranslation, instance.assetId);
    this.root.name = placement.id;
    this.root.position.set(placement.position.x, placement.position.y, placement.position.z);
    this.root.rotation.y = placement.rotationY;
    this.root.scale.set(placement.scale.x, placement.scale.y, placement.scale.z);
    this.root.add(instance.root);
    this.root.traverse(node => { if (node instanceof Mesh) { node.castShadow = true; node.receiveShadow = true; } });
    const frameSolids = buildNativePropColliders(frame, { ...placement, id: placement.id + ':frame' }, region);
    const panelPlacement = { ...placement, id: placement.id + ':panel' };
    panel.position.copy(this.closedPose);
    this.closedSolids = [...frameSolids, ...buildNativePropColliders(panel, panelPlacement, region)];
    panel.position.copy(this.openPose);
    this.openSolids = [...frameSolids, ...buildNativePropColliders(panel, panelPlacement, region)];
    panel.position.copy(this.closedPose);
    this.root.updateWorldMatrix(true, true);
  }

  get solids(): readonly NativeSolidCollider[] { return this.opened ? this.openSolids : this.closedSolids; }

  syncWorldFacts(facts: Readonly<Record<string, boolean>>): void {
    const opened = facts['interaction:migration-gate'] === true || facts['interaction:open-crossing'] === true;
    if (opened === this.opened) return;
    this.panel.position.copy(opened ? this.openPose : this.closedPose);
    this.root.updateWorldMatrix(true, true);
    this.opened = opened;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.instance.dispose();
    this.root.clear();
  }
}
