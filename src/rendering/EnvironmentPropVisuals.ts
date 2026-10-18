import { Color, type Scene } from 'three';
import type { EnvironmentPropSnapshot, WorldClockSnapshot } from '../game/contracts.js';
import { DebrisFx } from '../effects/vfx/InstancedFx.js';
import type { NativeStaticBatch } from './NativeAssetLoader.js';

const COLORS = { wood: new Color(0x8b7451), structure: new Color(0x8b7451), 'loose-wood': new Color(0x8b7451), foliage: new Color(0x5f743f), stone: new Color(0x797b76), 'loose-stone': new Color(0x797b76) };

/** Snapshot projection only: native instance transforms/scars plus a bounded, non-colliding chip pool. */
export class EnvironmentPropVisuals {
  readonly debris = new DebrisFx(64);
  readonly collapsedPropIds = new Set<string>();
  private readonly serials = new Map<string, number>();
  private readonly applied = new Set<string>();
  private readonly seen = new Set<string>();
  private lastWorldTick: number | undefined;
  private lastSimulationTick: number | undefined;
  private reducedMotion = false;

  constructor(scene: Scene, private readonly batches: ReadonlyMap<string, readonly NativeStaticBatch[]>) {
    this.debris.mesh.name = 'environment-impact-chips';
    scene.add(this.debris.mesh);
  }

  /** Returns whether camera/native-solid visibility needs rebuilding after a local prop collapses or restores. */
  update(props: readonly EnvironmentPropSnapshot[], clock: WorldClockSnapshot, reducedMotion: boolean): boolean {
    const rewind = this.lastWorldTick !== undefined && (clock.worldTick < this.lastWorldTick || clock.simulationTick < this.lastSimulationTick!);
    const baseline = this.lastWorldTick === undefined || rewind;
    if (rewind || reducedMotion && !this.reducedMotion) this.debris.clear();
    this.reducedMotion = reducedMotion;
    this.seen.clear();
    let solidsChanged = false;
    for (const prop of props) {
      this.seen.add(prop.id);
      const collapsed = prop.broken && (prop.material === 'foliage' || prop.material === 'loose-wood');
      if (collapsed !== this.collapsedPropIds.has(prop.id)) {
        solidsChanged = true;
        if (collapsed) this.collapsedPropIds.add(prop.id); else this.collapsedPropIds.delete(prop.id);
      }
      const batches = this.batches.get(prop.id);
      if (batches) for (const batch of batches) batch.setPlacementResponse(prop.id, prop, reducedMotion);
      const previous = this.serials.get(prop.id) ?? 0;
      const age = clock.worldTick - prop.impactWorldTick;
      if (!baseline && !reducedMotion && clock.policy !== 'paused' && prop.impactSerial > previous && prop.impactWorldTick >= 0 && age >= 0 && age <= 3) {
        // Seeded directions, independent of render cadence; damage/motion remain even when this secondary pool is disabled.
        const count = prop.broken ? 5 : 3;
        for (let i = 0; i < count; i++) {
          const angle = i * 2.399963 + prop.impactSerial * 1.7;
          const speed = .6 + i * .17;
          this.debris.spawn(prop.position.x, prop.position.y + .04, prop.position.z, Math.cos(angle) * speed, .8 + i * .2, Math.sin(angle) * speed, prop.material === 'foliage' ? .055 : .075, 1.5, clock.worldTimeSeconds - age / 60, 0, COLORS[prop.material], i + prop.impactSerial * .31);
        }
      }
      this.serials.set(prop.id, prop.impactSerial);
      this.applied.add(prop.id);
    }
    for (const id of this.applied) {
      if (this.seen.has(id)) continue;
      const batches = this.batches.get(id);
      if (batches) for (const batch of batches) batch.setPlacementResponse(id, undefined, reducedMotion);
      this.applied.delete(id); this.serials.delete(id);
      if (this.collapsedPropIds.delete(id)) solidsChanged = true;
    }
    this.debris.update(clock.worldTimeSeconds);
    this.lastWorldTick = clock.worldTick; this.lastSimulationTick = clock.simulationTick;
    return solidsChanged;
  }

  clear(): void {
    for (const id of this.applied) {
      const batches = this.batches.get(id);
      if (batches) for (const batch of batches) batch.setPlacementResponse(id, undefined, false);
    }
    this.applied.clear(); this.seen.clear(); this.serials.clear(); this.collapsedPropIds.clear();
    this.lastWorldTick = this.lastSimulationTick = undefined;
    this.debris.clear();
  }

  dispose(): void { this.clear(); this.debris.dispose(); }
}
