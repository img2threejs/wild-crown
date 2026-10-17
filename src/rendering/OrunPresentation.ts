import { Fog, Group, Mesh, MeshBasicMaterial, RingGeometry, type Camera, type Scene, type Vector3 } from 'three';
import type { CombatSnapshot } from '../game/contracts';

/** Tactical overlays only; Orun and his echoes remain their native animated assets. */
export class OrunPresentation {
  private readonly group = new Group();
  private readonly geometry = new RingGeometry(.62, .76, 40);
  private readonly coreMaterial = new MeshBasicMaterial({ color: 0xffdc82, transparent: true, opacity: .9, depthWrite: false, fog: false });
  private readonly gapMaterial = new MeshBasicMaterial({ color: 0x74e4ff, transparent: true, opacity: .85, depthWrite: false, fog: false });
  private readonly suppressionMaterial = new MeshBasicMaterial({ color: 0xd58aff, transparent: true, opacity: .8, depthWrite: false, fog: false });
  private readonly core = this.marker(this.coreMaterial);
  private readonly gap = this.marker(this.gapMaterial);
  private readonly suppressed = Array.from({ length: 6 }, () => this.marker(this.suppressionMaterial));
  private fogActive = false;
  private savedFog: { fog: Fog; near: number; far: number } | undefined;

  constructor(scene: Scene) {
    this.group.name = 'orun-tactical-presentation';
    this.group.visible = false;
    scene.add(this.group);
  }

  private marker(material: MeshBasicMaterial): Mesh {
    const mesh = new Mesh(this.geometry, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = 12;
    mesh.visible = false;
    this.group.add(mesh);
    return mesh;
  }

  sync(combat: CombatSnapshot, reducedMotion: boolean): void {
    const state = combat.orun;
    this.group.visible = state !== undefined;
    this.fogActive = state?.fog === true;
    if (!state) return;
    const orun = combat.actors.find(actor => actor.archetypeId === 'orun' || actor.id === 'orun');
    this.core.visible = state.coreExposed && orun?.visible === true;
    if (orun) this.core.position.set(orun.position.x, orun.position.y + .1, orun.position.z);
    const pulse = reducedMotion ? 1 : 1 + Math.sin(combat.worldClock.worldTimeSeconds * 3) * .06;
    this.core.scale.setScalar(1.6 * pulse);
    this.gap.visible = state.safeGap !== undefined;
    if (state.safeGap) this.gap.position.set(state.safeGap.x, state.safeGap.y + .09, state.safeGap.z);
    this.gap.scale.setScalar(1.5);
    let count = 0;
    for (const id of state.suppressedCompanionIds) {
      const actor = combat.actors.find(candidate => candidate.archetypeId === id || candidate.id === id);
      const marker = this.suppressed[count];
      if (!actor?.visible || !marker) continue;
      marker.visible = true;
      marker.position.set(actor.position.x, actor.position.y + .1, actor.position.z);
      marker.scale.setScalar(1.4);
      count++;
    }
    for (; count < this.suppressed.length; count++) this.suppressed[count]!.visible = false;
  }

  /** Applied after establishing-shot fog, relative to camera focus rather than world Y. */
  applyFog(scene: Scene, camera: Camera, focus: Vector3): void {
    if (!this.fogActive || !(scene.fog instanceof Fog)) {
      this.restoreFog();
      return;
    }
    if (this.savedFog?.fog !== scene.fog) {
      this.restoreFog();
      this.savedFog = { fog: scene.fog, near: scene.fog.near, far: scene.fog.far };
    }
    const distance = camera.position.distanceTo(focus);
    scene.fog.near = Math.min(this.savedFog.near, Math.max(1, distance - 6));
    scene.fog.far = Math.min(this.savedFog.far, Math.max(scene.fog.near + 12, distance + 16));
  }

  private restoreFog(): void {
    if (!this.savedFog) return;
    this.savedFog.fog.near = this.savedFog.near;
    this.savedFog.fog.far = this.savedFog.far;
    this.savedFog = undefined;
  }

  clear(): void {
    this.group.visible = false;
    this.fogActive = false;
    this.restoreFog();
  }

  dispose(): void {
    this.clear();
    this.group.removeFromParent();
    this.geometry.dispose();
    this.coreMaterial.dispose();
    this.gapMaterial.dispose();
    this.suppressionMaterial.dispose();
  }
}
