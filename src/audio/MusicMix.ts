/** Pure music-mix rules: which stem is audible for a story/encounter state, and how fast gains slew. No Web Audio here. */

export type StemId = 'explore' | 'combat' | 'boss' | 'restored' | 'corrupted' | 'title';
export const STEM_IDS: readonly StemId[] = ['explore', 'combat', 'boss', 'restored', 'corrupted', 'title'];
export type StemGains = Record<StemId, number>;

export interface MusicMixState {
  /** Title / menu screens: only the title cue plays. */
  readonly menu: boolean;
  /** 0..1 combat intensity (see `CombatIntensity`). */
  readonly combat: number;
  /** A boss is engaged: the boss cue replaces both exploration and combat music. */
  readonly boss: boolean;
  /** 0..1 restoration progress: fades in the restored layer. */
  readonly restoration: number;
  /** 0..1 corruption pressure: fades in the corrupted layer. */
  readonly corruption: number;
}

/** Peak gain of a restoration layer; it sits under the main cue rather than on top of it. */
export const LAYER_PEAK = 0.6;
/** Layers keep this fraction of their level while combat or a boss owns the foreground. */
export const LAYER_COMBAT_KEEP = 0.3;

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * Fills `out` with the target gain of every stem. Exploration, combat and boss cues crossfade equal-power (the squared gains of the
 * three always sum to 1, so loudness stays level through a crossfade); the corrupted and restored layers ride on top and recede
 * while combat or a boss is in the foreground. Allocation-free.
 */
export function targetStemGains(state: MusicMixState, out: StemGains): StemGains {
  if (state.menu) {
    out.explore = 0; out.combat = 0; out.boss = 0; out.restored = 0; out.corrupted = 0; out.title = 1;
    return out;
  }
  const combat = clamp01(state.combat);
  const boss = state.boss ? 1 : 0;
  const foreground = Math.max(combat, boss);
  out.explore = Math.sqrt((1 - boss) * (1 - combat));
  out.combat = Math.sqrt((1 - boss) * combat);
  out.boss = Math.sqrt(boss);
  const layerScale = LAYER_PEAK * (1 - (1 - LAYER_COMBAT_KEEP) * foreground);
  out.restored = clamp01(state.restoration) * layerScale;
  out.corrupted = clamp01(state.corruption) * layerScale;
  out.title = 0;
  return out;
}

export function emptyStemGains(): StemGains {
  return { explore: 0, combat: 0, boss: 0, restored: 0, corrupted: 0, title: 0 };
}

/** One step of exponential slew toward `target` (time constants differ for rising and falling gain). */
export function smoothGain(current: number, target: number, dtSeconds: number, riseSeconds: number, fallSeconds: number): number {
  const tau = target > current ? riseSeconds : fallSeconds;
  if (tau <= 0 || dtSeconds <= 0) return tau <= 0 ? target : current;
  return target + (current - target) * Math.exp(-dtSeconds / tau);
}

/** Gains below this are inaudible: the stem is paused instead of streaming silence. */
export const STEM_SILENCE = 0.003;
/** How long a stem stays silent before its stream is paused (a re-entry inside this window resumes without a restart). */
export const STEM_PAUSE_AFTER_SECONDS = 1.5;

export interface CombatIntensityTuning {
  /** Intensity rises at most this fast (per second). */
  readonly rise: number;
  /** After the last hostile contact the level holds this long (seconds) before it starts to fall. */
  readonly hold: number;
  /** Falling rate once the hold has expired (per second). */
  readonly fall: number;
}
export const COMBAT_TUNING: CombatIntensityTuning = { rise: 1.2, hold: 5, fall: 0.22 };

/**
 * Combat intensity driven by two inputs: `presence` (hostiles actively engaged right now, from snapshots) and discrete `pulse`s
 * (attack and hit cues). The output rises quickly, holds through short gaps between exchanges, then fades slowly so the score
 * does not flip-flop between explore and combat on every lull.
 */
export class CombatIntensity {
  level = 0;
  private presence = 0;
  /** The level the last contact asked for; held for `hold` seconds after contact ends, then decays. */
  private held = 0;
  private holdLeft = 0;

  constructor(private readonly tuning: CombatIntensityTuning = COMBAT_TUNING) {}

  setPresence(value: number): void {
    this.presence = clamp01(value);
    if (this.presence > 0) {
      this.held = this.presence;
      this.holdLeft = this.tuning.hold;
    }
  }

  pulse(amount: number): void {
    this.held = Math.max(this.held, clamp01(amount));
    this.holdLeft = this.tuning.hold;
  }

  update(dtSeconds: number): number {
    if (this.presence === 0) {
      if (this.holdLeft > 0) this.holdLeft = Math.max(0, this.holdLeft - dtSeconds);
      else this.held = Math.max(0, this.held - this.tuning.fall * dtSeconds);
    }
    const target = Math.max(this.presence, this.held);
    if (target > this.level) this.level = Math.min(target, this.level + this.tuning.rise * dtSeconds);
    else this.level = Math.max(target, this.level - this.tuning.fall * dtSeconds);
    return this.level;
  }

  reset(): void {
    this.level = 0; this.presence = 0; this.held = 0; this.holdLeft = 0;
  }
}
