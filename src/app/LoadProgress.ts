/** One step of world preparation, weighted by how much of the wait it represents. */
export interface LoadPhaseSpec {
  readonly id: string;
  readonly label: string;
  readonly weight: number;
}

interface PhaseSlot { readonly label: string; readonly start: number; readonly share: number }

/**
 * One monotonic 0..1 progress value over an ordered list of weighted phases. Phases report the fraction they have
 * completed; the overall ratio is the sum of finished phase shares plus the current phase's partial share, and never
 * decreases. There is no timer: the value only moves when real work reports.
 */
export class LoadProgress {
  private readonly slots = new Map<string, PhaseSlot>();
  private current = 0;

  constructor(phases: readonly LoadPhaseSpec[]) {
    const total = phases.reduce((sum, phase) => sum + Math.max(0, phase.weight), 0);
    if (!(total > 0)) throw new Error('LoadProgress needs at least one phase with a positive weight.');
    let offset = 0;
    for (const phase of phases) {
      if (this.slots.has(phase.id)) throw new Error(`Duplicate load phase ${phase.id}.`);
      const share = Math.max(0, phase.weight) / total;
      this.slots.set(phase.id, { label: phase.label, start: offset, share });
      offset += share;
    }
  }

  /** Overall progress so far, 0..1. */
  get ratio(): number { return this.current; }

  has(phaseId: string): boolean { return this.slots.has(phaseId); }

  labelOf(phaseId: string): string { return this.slot(phaseId).label; }

  /** Records that `phaseId` is `within` (0..1) complete and returns the overall ratio. */
  report(phaseId: string, within: number): number {
    const { start, share } = this.slot(phaseId);
    const fraction = Number.isFinite(within) ? Math.min(1, Math.max(0, within)) : 0;
    this.current = Math.max(this.current, Math.min(1, start + fraction * share));
    return this.current;
  }

  /** Marks a phase fully done. */
  complete(phaseId: string): number { return this.report(phaseId, 1); }

  private slot(phaseId: string): PhaseSlot {
    const slot = this.slots.get(phaseId);
    if (!slot) throw new Error(`Unknown load phase ${phaseId}.`);
    return slot;
  }
}
