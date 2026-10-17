/** A playing one-shot as the limiter sees it; `stop` must release the node chain (idempotent). */
export interface LimitedVoice {
  readonly group: string;
  readonly priority: number;
  /** Monotonic start order assigned by the limiter. */
  order: number;
  stop(): void;
}

export interface VoiceLimits {
  readonly total: number;
}

/**
 * Bounded voice allocation. `admit` either grants the slot (stealing the quietest-priority, oldest voice when a limit is hit) or refuses
 * when every candidate outranks the newcomer. Voices are kept in start order in a preallocated array, so admission never allocates.
 */
export class VoiceLimiter {
  private readonly voices: LimitedVoice[] = [];
  private nextOrder = 1;
  stolen = 0;
  rejected = 0;

  constructor(private readonly limits: VoiceLimits) {}

  get count(): number { return this.voices.length; }

  countGroup(group: string): number {
    let n = 0;
    for (const voice of this.voices) if (voice.group === group) n++;
    return n;
  }

  /** Returns true when `voice` may start (and registers it). `groupMax` is the per-group cap. */
  admit(voice: LimitedVoice, groupMax: number): boolean {
    if (this.countGroup(voice.group) >= groupMax && !this.stealFor(voice, voice.group)) return false;
    if (this.voices.length >= this.limits.total && !this.stealFor(voice, undefined)) return false;
    voice.order = this.nextOrder++;
    this.voices.push(voice);
    return true;
  }

  release(voice: LimitedVoice): void {
    const index = this.voices.indexOf(voice);
    if (index >= 0) this.voices.splice(index, 1);
  }

  releaseAll(): void {
    for (let i = this.voices.length - 1; i >= 0; i--) this.voices[i]!.stop();
    this.voices.length = 0;
  }

  private stealFor(incoming: LimitedVoice, group: string | undefined): boolean {
    let victim = -1;
    for (let i = 0; i < this.voices.length; i++) {
      const candidate = this.voices[i]!;
      if (group !== undefined && candidate.group !== group) continue;
      if (candidate.priority > incoming.priority) continue;
      // lowest priority first, then oldest (voices are in start order, so the first of a priority is the oldest)
      if (victim < 0 || candidate.priority < this.voices[victim]!.priority) victim = i;
    }
    if (victim < 0) { this.rejected++; return false; }
    const [stolen] = this.voices.splice(victim, 1);
    stolen!.stop();
    this.stolen++;
    return true;
  }
}
